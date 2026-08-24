/**
 * KerSor viewer Host service: commits one inventory/diagnostics snapshot and
 * folds each run's event stream for browser consumers.
 * @module @deepseek-ai/dsh-kersor-viewer
 */

import path from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import { readClassicSessionDetail, readClassicSessions } from './classic.ts'
import type { KersorClassicSessionDetail, KersorClassicSnapshot } from './classic.ts'
import { createIssue, issueFromError, mergeIssue } from './diagnostics.ts'
import type { KersorDiagnosticIssue } from './diagnostics.ts'
import { readCallDetail } from './detail.ts'
import type { KersorCallDetailView } from './detail.ts'
import { applyWorkflowResult, createRunView, foldEvent } from './fold.ts'
import type { KersorEvent, KersorRunView } from './fold.ts'
import { readWorkflowResult } from './result.ts'
import type { KersorWorkflowResultView } from './fold.ts'
import { scanRoots } from './scanner.ts'
import type { KersorRunRef, KersorScanObservation } from './scanner.ts'
import { EventsTailer } from './tailer.ts'
import type { KersorRunObservation, KersorViewerFrame, KersorViewerSnapshot } from './types.ts'

export type { KersorEvent, KersorRunView } from './fold.ts'
export type { KersorRunRef } from './scanner.ts'
export type { KersorCallDetailView } from './detail.ts'
export type {
  KersorBaselineAction, KersorClassicGate, KersorClassicHealth,
  KersorClassicLifecycle, KersorClassicSession,
  KersorClassicSessionDetail, KersorClassicSnapshot, KersorClassicStatus,
} from './classic.ts'
export type { KersorRunObservation, KersorViewerFrame, KersorViewerSnapshot } from './types.ts'
export { EventsTailer } from './tailer.ts'
export { DEFAULT_KERSOR_ROOTS, scanRoots } from './scanner.ts'
export { createRunView, foldEvent } from './fold.ts'
export { installedBridge, readClassicSessionDetail, readClassicSessions } from './classic.ts'

/** Viewer configuration (cordis.patch.yml row config). */
export interface Config {
  /** Extra KerSor session roots scanned in addition to the defaults. */
  roots?: string[]
  /** Disable built-in and preset-checkout roots. */
  noDefaultRoots?: boolean
  /** Discovery rescan interval in milliseconds. */
  scanIntervalMs?: number
  /** Number of recent classic optimization Sessions shown; zero disables it. */
  classicSessionLimit?: number
  /** Seconds without artifact activity before an unfinished Session is stale. */
  classicStaleAfterSeconds?: number
}

interface TrackedRun {
  ref: KersorRunRef
  view: KersorRunView
  tailer: EventsTailer | undefined
  observation: KersorRunObservation
}

interface WorkspaceRootDiscovery {
  readonly roots: readonly string[]
  readonly issue?: KersorDiagnosticIssue
}

/** Host service owning the viewer's single snapshot and folded run views. */
export class KersorViewerService extends TypertRemoteService {
  static inject = ['workspaceRegistry', 'sessionPersistence']

  static Config: z<Config> = z.object({
    roots: z.array(z.string()).default([]),
    noDefaultRoots: z.boolean().default(false),
    scanIntervalMs: z.number().min(500).default(5000),
    classicSessionLimit: z.number().step(1).min(0).max(100).default(20),
    classicStaleAfterSeconds: z.number().step(1).min(1).max(86_400).default(1800),
  })

  private readonly rootCtx: Context
  private readonly configuredRoots: string[]
  private readonly includeDefaults: boolean
  private readonly scanIntervalMs: number
  private readonly classicSessionLimit: number
  private readonly classicStaleAfterSeconds: number
  private readonly tracked = new Map<string, TrackedRun>()
  private group: Fiber | undefined
  private scanTimer: NodeJS.Timeout | undefined
  private scanInFlight: Promise<void> | undefined
  private persistedWorkspaceRoots: readonly string[] = []
  private scanObservation: KersorScanObservation = { state: 'never', roots: [] }
  private classicSnapshot: KersorClassicSnapshot = {
    sessions: [],
    source: { state: 'not_installed' },
  }
  private lastPublishedSnapshotFingerprint: string | undefined

  /** Create the service under the Host composition. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'kersorViewer')
    this.rootCtx = ctx
    this.configuredRoots = config.roots ?? []
    this.includeDefaults = !(config.noDefaultRoots ?? false)
    this.scanIntervalMs = config.scanIntervalMs ?? 5000
    this.classicSessionLimit = config.classicSessionLimit ?? 20
    this.classicStaleAfterSeconds = config.classicStaleAfterSeconds ?? 1800
  }

  /** Start discovery and tailing under the plugin's fiber once ready. */
  *[Service.init](): Generator<() => void, void, void> {
    yield () => {
      for (const tracked of this.tracked.values()) tracked.tailer?.stop()
      this.tracked.clear()
      if (this.scanTimer !== undefined) clearInterval(this.scanTimer)
      this.scanTimer = undefined
      void this.group?.dispose()
      this.group = undefined
    }
    const group = this.requireGroup()
    group.effect(() => {
      void this.rescan()
      this.scanTimer = setInterval(() => { void this.rescan() }, this.scanIntervalMs)
      this.scanTimer.unref()
      return () => {
        if (this.scanTimer !== undefined) clearInterval(this.scanTimer)
        this.scanTimer = undefined
      }
    })
  }

  private requireGroup(): Fiber {
    this.group ??= this.rootCtx.plugin({ name: 'kersor-viewer-group', apply: () => {} })
    return this.group
  }

  /**
   * Read the complete inventory and source-health snapshot for refresh or reconnect.
   * @returns Current atomic Host projection with a fresh observation timestamp.
   */
  @Remote('snapshot')
  snapshot(): KersorViewerSnapshot {
    return {
      asOf: new Date().toISOString(),
      runs: [...this.tracked.values()].map(tracked => tracked.ref)
        .sort((left, right) => rank(right) - rank(left) || right.runId.localeCompare(left.runId)),
      classic: this.classicSnapshot,
      diagnostics: {
        scan: this.scanObservation,
        runs: [...this.tracked.values()].map(tracked => tracked.observation)
          .sort((left, right) => left.runDir.localeCompare(right.runDir)),
      },
    }
  }

  /**
   * Read the full folded view of one discovered run.
   * @param runDir - Exact run directory from the current inventory.
   * @returns Folded backlog with bounded result, or `undefined` for an unknown run.
   */
  @Remote('runBacklog')
  async runBacklog(runDir: string): Promise<KersorRunView | undefined> {
    const tracked = this.tracked.get(runDir)
    if (tracked === undefined) return undefined
    const result = tracked.view.result ?? await readWorkflowResult(runDir)
    if (result !== undefined) applyWorkflowResult(tracked.view, result)
    return tracked.view
  }

  /**
   * Read the bounded candidate-selection result for one discovered run.
   * @param runDir - Exact run directory from the current inventory.
   * @returns Candidate and Host verification projection, or `undefined` when absent.
   */
  @Remote('runResult')
  async runResult(runDir: string): Promise<KersorWorkflowResultView | undefined> {
    if (!this.tracked.has(runDir)) return undefined
    return readWorkflowResult(runDir)
  }

  /**
   * Read bounded worker messages and activity names for one folded call.
   * @param runDir - Exact discovered run directory.
   * @param callId - Exact call identity present in that run's folded event stream.
   * @returns Bounded detail, or `undefined` when the run, call, or artifacts are absent.
   */
  @Remote('runCallDetail')
  async runCallDetail(runDir: string, callId: string): Promise<KersorCallDetailView | undefined> {
    const tracked = this.tracked.get(runDir)
    if (tracked === undefined) return undefined
    const call = tracked.view.phases.flatMap(phase => phase.calls)
      .find(candidate => candidate.callId === callId)
    return call === undefined ? undefined : readCallDetail(runDir, call)
  }

  /**
   * Read sealed, bounded detail for one classic Session present in the snapshot.
   * @param sessionDir - Exact discovered Session directory.
   * @returns Inspector detail, or `undefined` for an unknown or unreadable Session.
   */
  @Remote('classicSessionDetail')
  async classicSessionDetail(sessionDir: string): Promise<KersorClassicSessionDetail | undefined> {
    if (!this.classicSnapshot.sessions.some(session => session.session_dir === sessionDir)) return undefined
    return readClassicSessionDetail(sessionDir)
  }

  /** Rescan roots once; concurrent callers share the in-flight scan. */
  async rescan(): Promise<void> {
    if (this.scanInFlight !== undefined) return this.scanInFlight
    this.scanObservation = {
      ...this.scanObservation,
      state: 'running',
      startedAt: new Date().toISOString(),
    }
    const current = this.performRescan().catch((error: unknown) => {
      const now = new Date().toISOString()
      this.scanObservation = {
        ...this.scanObservation,
        state: 'failed',
        completedAt: now,
        lastIssue: issueFromError('root_scan', error),
      }
      this.publishSnapshot()
    })
    this.scanInFlight = current
    try {
      await current
    } finally {
      if (this.scanInFlight === current) this.scanInFlight = undefined
    }
  }

  private async performRescan(): Promise<void> {
    const workspaceDiscovery = await this.discoverWorkspaceRoots()
    const workspaceRoots = workspaceDiscovery.roots
    const [scanned, classic] = await Promise.all([
      scanRoots(this.configuredRoots, this.includeDefaults, workspaceRoots),
      this.classicSessionLimit === 0
        ? Promise.resolve({ sessions: [], source: { state: 'disabled' } } satisfies KersorClassicSnapshot)
        : readClassicSessions(this.classicSessionLimit, this.classicStaleAfterSeconds, {
          includeCheckoutRoot: this.includeDefaults,
          sessionRoots: this.configuredRoots,
          workspaceRoots,
        }),
    ])
    const previousSuccess = this.scanObservation.lastSuccessfulAt
    const observation = workspaceDiscovery.issue === undefined
      ? scanned.observation
      : {
        ...scanned.observation,
        state: scanned.observation.state === 'failed' ? 'failed' as const : 'degraded' as const,
        lastIssue: mergeIssue(this.scanObservation.lastIssue, workspaceDiscovery.issue),
      }
    this.scanObservation = observation.state === 'failed' && previousSuccess !== undefined
      ? { ...observation, lastSuccessfulAt: previousSuccess }
      : observation
    this.classicSnapshot = classic
    const byRunDir = new Map(scanned.runs.map(ref => [ref.runDir, ref]))
    const scanIssues = new Map(scanned.runIssues.map(entry => [entry.runDir, entry.issue]))

    for (const [runDir, tracked] of this.tracked) {
      if (byRunDir.has(runDir)) continue
      tracked.tailer?.stop()
      this.tracked.delete(runDir)
    }
    for (const ref of scanned.runs) {
      const issue = scanIssues.get(ref.runDir)
      const existing = this.tracked.get(ref.runDir)
      if (existing !== undefined) {
        if (issue !== undefined) this.recordRunIssue(existing, issue)
        if (existing.ref.discovery !== ref.discovery) {
          if (existing.ref.discovery !== 'active' && ref.discovery === 'active') continue
          existing.ref = ref
          if (ref.discovery !== 'active') {
            existing.tailer?.stop()
            existing.tailer = undefined
            existing.view.status = terminalStatus(ref)
            existing.observation = {
              ...existing.observation,
              state: existing.observation.lastIssue === undefined ? 'complete' : 'degraded',
            }
            this.publishRun(existing.view)
            void this.loadRunResult(existing)
          } else {
            this.attachTailer(existing)
          }
        }
        if (existing.view.result === undefined && ref.discovery !== 'active') void this.loadRunResult(existing)
        continue
      }
      const tracked: TrackedRun = {
        ref,
        view: createRunView(ref.runId, ref.runDir, ref.sessionDir),
        tailer: undefined,
        observation: {
          runDir: ref.runDir,
          mode: ref.discovery === 'active' ? 'tail' : 'backfill',
          state: issue === undefined ? 'waiting' : 'degraded',
          byteOffset: 0,
          linesRead: 0,
          linesRejected: 0,
          ...(issue === undefined ? {} : { lastIssue: issue }),
        },
      }
      this.tracked.set(ref.runDir, tracked)
      if (ref.discovery === 'active') this.attachTailer(tracked)
      else void this.backfillTerminated(tracked)
    }
    this.publishSnapshot()
  }

  /** Merge managed Workspaces with durable Session cwd values, retaining the last good durable list on failure. */
  private async discoverWorkspaceRoots(): Promise<WorkspaceRootDiscovery> {
    const roots = new Set<string>()
    for (const workspace of this.rootCtx.workspaceRegistry.list()) {
      const normalized = normalizeAbsoluteCwd(workspace.path)
      if (normalized !== undefined) roots.add(normalized)
    }
    let issue: KersorDiagnosticIssue | undefined
    try {
      const persisted = new Set<string>()
      for (const header of await this.rootCtx.sessionPersistence.list()) {
        const normalized = normalizeAbsoluteCwd(header.cwd)
        if (normalized !== undefined) persisted.add(normalized)
      }
      this.persistedWorkspaceRoots = [...persisted].sort((left, right) => left.localeCompare(right))
    } catch (error) {
      issue = issueFromError('root_scan', error, 'warning')
    }
    for (const persisted of this.persistedWorkspaceRoots) roots.add(persisted)
    return { roots: [...roots], ...(issue === undefined ? {} : { issue }) }
  }

  private async backfillTerminated(tracked: TrackedRun): Promise<void> {
    const { ref, view } = tracked
    let text: string
    try {
      text = await (await import('node:fs/promises')).readFile(`${ref.runDir}/.runtime/events.jsonl`, 'utf8')
    } catch (error) {
      view.status = terminalStatus(ref)
      this.recordRunIssue(tracked, issueFromError('backfill_read', error))
      tracked.observation = { ...tracked.observation, state: 'failed' }
      if (this.tracked.get(ref.runDir) === tracked) {
        this.publishRun(view)
        this.publishSnapshot()
      }
      return
    }
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      tracked.observation = {
        ...tracked.observation,
        linesRead: tracked.observation.linesRead + 1,
        lastReadAt: new Date().toISOString(),
      }
      this.foldLine(tracked, line)
    }
    if (view.status !== 'completed' && view.status !== 'failed') view.status = terminalStatus(ref)
    const result = await readWorkflowResult(ref.runDir)
    if (result !== undefined) applyWorkflowResult(view, result)
    tracked.observation = {
      ...tracked.observation,
      state: tracked.observation.lastIssue === undefined ? 'complete' : 'degraded',
      byteOffset: Buffer.byteLength(text),
    }
    if (this.tracked.get(ref.runDir) !== tracked) return
    this.publishRun(view)
    this.publishSnapshot()
  }

  private attachTailer(tracked: TrackedRun): void {
    if (tracked.tailer !== undefined) return
    const { ref, view } = tracked
    const tailer = new EventsTailer(
      `${ref.runDir}/.runtime/events.jsonl`,
      (lines) => {
        for (const line of lines) this.foldLine(tracked, line)
        tracked.observation = {
          ...tracked.observation,
          state: tracked.observation.lastIssue === undefined ? 'healthy' : 'degraded',
          byteOffset: tailer.byteOffset,
          linesRead: tracked.observation.linesRead + lines.length,
          lastReadAt: new Date().toISOString(),
        }
        this.publishRun(view)
        if (view.status === 'completed' || view.status === 'failed') {
          tracked.ref = { ...tracked.ref, discovery: view.status }
          tracked.observation = {
            ...tracked.observation,
            state: tracked.observation.lastIssue === undefined ? 'complete' : 'degraded',
          }
          tailer.stop()
          void this.loadRunResult(tracked)
        }
      },
      () => {
        if (tracked.tailer === tailer) tracked.tailer = undefined
      },
      {
        onObservation: (observation) => {
          const previousFingerprint = observationFingerprint(tracked.observation)
          const currentIssue = tracked.observation.lastIssue
          const tailerIssue = observation.lastIssue
          const lastIssue = tailerIssue !== undefined
            && (currentIssue === undefined || tailerIssue.lastSeenAt >= currentIssue.lastSeenAt)
            ? tailerIssue
            : currentIssue
          const terminal = tracked.view.status === 'completed' || tracked.view.status === 'failed'
          tracked.observation = {
            ...tracked.observation,
            state: terminal
              ? (lastIssue === undefined ? 'complete' : 'degraded')
              : observation.state === 'healthy' && lastIssue !== undefined
                ? 'degraded'
                : observation.state,
            byteOffset: observation.byteOffset,
            linesRead: observation.linesRead,
            ...(observation.lastReadAt === undefined ? {} : { lastReadAt: observation.lastReadAt }),
            ...(lastIssue === undefined ? {} : { lastIssue }),
          }
          if (observationFingerprint(tracked.observation) !== previousFingerprint) this.publishSnapshot()
        },
      },
    )
    tracked.tailer = tailer
    try {
      tailer.start()
    } catch (error) {
      tracked.tailer = undefined
      this.recordRunIssue(tracked, issueFromError('tailer_watch', error))
      tracked.observation = { ...tracked.observation, state: 'failed' }
      this.publishSnapshot()
    }
  }

  private async loadRunResult(tracked: TrackedRun): Promise<void> {
    const result = await readWorkflowResult(tracked.ref.runDir)
    if (result === undefined || this.tracked.get(tracked.ref.runDir) !== tracked) return
    applyWorkflowResult(tracked.view, result)
    this.publishRun(tracked.view)
  }

  private foldLine(tracked: TrackedRun, line: string): void {
    let decoded: unknown
    try {
      decoded = JSON.parse(line)
    } catch (error) {
      this.rejectLine(tracked, issueFromError('event_parse', error, 'warning'))
      return
    }
    if (decoded === null || typeof decoded !== 'object'
      || typeof (decoded as { type?: unknown }).type !== 'string') {
      this.rejectLine(tracked, createIssue('event_parse', 'invalid_payload', 'warning'))
      return
    }
    try {
      foldEvent(tracked.view, decoded as KersorEvent)
    } catch (error) {
      this.rejectLine(tracked, issueFromError('event_fold', error, 'warning'))
    }
  }

  private rejectLine(tracked: TrackedRun, issue: ReturnType<typeof createIssue>): void {
    this.recordRunIssue(tracked, issue)
    tracked.observation = {
      ...tracked.observation,
      state: 'degraded',
      linesRejected: tracked.observation.linesRejected + 1,
    }
  }

  private recordRunIssue(tracked: TrackedRun, issue: ReturnType<typeof createIssue>): void {
    tracked.observation = {
      ...tracked.observation,
      lastIssue: mergeIssue(tracked.observation.lastIssue, issue),
    }
  }

  private publishSnapshot(): void {
    const snapshot = this.snapshot()
    const fingerprint = snapshotFingerprint(snapshot)
    if (fingerprint === this.lastPublishedSnapshotFingerprint) return
    this.lastPublishedSnapshotFingerprint = fingerprint
    this.rootCtx.emit('kersor/event', { kind: 'snapshot', snapshot } satisfies KersorViewerFrame)
  }

  private publishRun(run: KersorRunView): void {
    this.rootCtx.emit('kersor/event', { kind: 'run', run } satisfies KersorViewerFrame)
  }
}

function normalizeAbsoluteCwd(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !path.isAbsolute(value)) {
    return undefined
  }
  return path.normalize(value)
}

function rank(ref: KersorRunRef): number {
  if (ref.discovery === 'active') return 2
  if (ref.discovery === 'failed') return 1
  return 0
}

function terminalStatus(ref: KersorRunRef): 'completed' | 'failed' {
  return ref.discovery === 'failed' ? 'failed' : 'completed'
}

function observationFingerprint(observation: KersorRunObservation): string {
  const issue = observation.lastIssue
  return `${observation.state}:${observation.byteOffset}:${observation.linesRead}:${issue?.stage ?? ''}:${issue?.code ?? ''}:${issue?.occurrences ?? 0}`
}

function issueFingerprint(issue: KersorDiagnosticIssue | undefined): readonly string[] | undefined {
  return issue === undefined ? undefined : [issue.stage, issue.code, issue.severity]
}

/** Ignore scan clocks and repeated identical diagnostics when deciding whether browser state changed. */
function snapshotFingerprint(snapshot: KersorViewerSnapshot): string {
  return JSON.stringify({
    runs: snapshot.runs,
    classic: {
      sessions: snapshot.classic.sessions,
      source: {
        state: snapshot.classic.source.state,
        issue: issueFingerprint(snapshot.classic.source.lastIssue),
      },
    },
    scan: {
      state: snapshot.diagnostics.scan.state,
      roots: snapshot.diagnostics.scan.roots.map(root => ({
        root: root.root,
        origin: root.origin,
        state: root.state,
        sessionsExamined: root.sessionsExamined,
        sessionsAccepted: root.sessionsAccepted,
        runsFound: root.runsFound,
        issue: issueFingerprint(root.lastIssue),
      })),
      issue: issueFingerprint(snapshot.diagnostics.scan.lastIssue),
    },
    readers: snapshot.diagnostics.runs.map(run => ({
      runDir: run.runDir,
      mode: run.mode,
      state: run.state,
      byteOffset: run.byteOffset,
      linesRead: run.linesRead,
      linesRejected: run.linesRejected,
      issue: issueFingerprint(run.lastIssue),
    })),
  })
}

/** Cordis plugin entry: the service class itself. */
export default KersorViewerService
