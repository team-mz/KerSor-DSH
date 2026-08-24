/**
 * Root-directory discovery of KerSor autonomous runs and bounded source observations.
 * @module @deepseek-ai/dsh-kersor-viewer
 */

import { access, readFile, readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createIssue, errorCode, issueFromError, mergeIssue } from './diagnostics.ts'
import type { KersorDiagnosticIssue } from './diagnostics.ts'
import type { KersorWorkflowResultView } from './fold.ts'
import { readWorkflowResult } from './result.ts'

/** Default roots scanned in addition to configured ones. */
export const DEFAULT_KERSOR_ROOTS = [
  path.join(homedir(), '.local', 'share', 'kersor'),
  path.join(homedir(), 'Agent4Kernel', 'KerSor', '.kersor'),
]

/** Lifecycle classification of one discovered run directory. */
export type KersorRunDiscovery = 'active' | 'completed' | 'failed'

/** Storage family of one executable Workflow run. */
export type KersorRunKind = 'autonomous' | 'classic-round'

/** One discovered run: identity paths plus classification. */
export interface KersorRunRef {
  readonly runId: string
  readonly runDir: string
  readonly sessionDir: string
  readonly root: string
  readonly kind: KersorRunKind
  readonly round?: number
  readonly result?: KersorWorkflowResultView
  readonly discovery: KersorRunDiscovery
}

/** How a root entered the scanner. */
export type KersorRootOrigin = 'configured' | 'default' | 'checkout' | 'workspace'

/** Result of inspecting one root during the latest completed scan. */
export interface KersorRootObservation {
  readonly root: string
  readonly origin: KersorRootOrigin
  readonly state: 'absent' | 'healthy' | 'degraded' | 'failed'
  readonly sessionsExamined: number
  readonly sessionsAccepted: number
  readonly runsFound: number
  readonly lastIssue?: KersorDiagnosticIssue
}

/** Latest scanner lifecycle and per-root observations. */
export interface KersorScanObservation {
  readonly state: 'never' | 'running' | 'healthy' | 'degraded' | 'failed'
  readonly startedAt?: string
  readonly completedAt?: string
  readonly lastSuccessfulAt?: string
  readonly roots: readonly KersorRootObservation[]
  readonly lastIssue?: KersorDiagnosticIssue
}

/** A scanner issue scoped to one discovered run. */
export interface KersorScannedRunIssue {
  readonly runDir: string
  readonly issue: KersorDiagnosticIssue
}

/** Complete result committed by the viewer service after one scan. */
export interface KersorScanResult {
  readonly runs: readonly KersorRunRef[]
  readonly runIssues: readonly KersorScannedRunIssue[]
  readonly observation: KersorScanObservation
}

interface RootCandidate {
  readonly root: string
  readonly origin: KersorRootOrigin
}

interface MutableRootObservation {
  root: string
  origin: KersorRootOrigin
  state: KersorRootObservation['state']
  sessionsExamined: number
  sessionsAccepted: number
  runsFound: number
  lastIssue?: KersorDiagnosticIssue
}

function expandHome(value: string): string {
  if (value === '~') return homedir()
  return value.startsWith('~/') ? path.join(homedir(), value.slice(2)) : value
}

async function configuredCheckout(): Promise<{ root?: string; issue?: KersorDiagnosticIssue }> {
  const fromEnvironment = process.env.KERSOR_ROOT?.trim()
  if (fromEnvironment) return { root: path.resolve(expandHome(fromEnvironment)) }
  const dshHome = process.env.DSH_HOME?.trim()
  const pointer = path.join(
    dshHome ? expandHome(dshHome) : path.join(homedir(), '.dsh'),
    '.agent-presets', 'kersor', '.local', 'kersor-root',
  )
  try {
    const recorded = (await readFile(pointer, 'utf8')).trim()
    return recorded ? { root: path.resolve(expandHome(recorded)) } : {}
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {}
    return { issue: issueFromError('checkout_pointer', error, 'warning') }
  }
}

function addCandidate(into: Map<string, RootCandidate>, root: string, origin: KersorRootOrigin): void {
  const expanded = path.resolve(expandHome(root))
  if (!into.has(expanded)) into.set(expanded, { root: expanded, origin })
}

function recordRootIssue(observation: MutableRootObservation, issue: KersorDiagnosticIssue): void {
  observation.lastIssue = mergeIssue(observation.lastIssue, issue)
  observation.state = observation.state === 'failed' ? 'failed' : 'degraded'
}

async function isSessionV2(dir: string): Promise<{ accepted: boolean; issue?: KersorDiagnosticIssue }> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return {
      accepted: entries.some(entry => entry.isFile() && entry.name === 'session-config.json')
        && entries.some(entry => entry.isFile() && entry.name === 'state.json'),
    }
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return { accepted: false }
    return { accepted: false, issue: issueFromError('session_inspect', error, 'warning') }
  }
}

async function readSummary(file: string): Promise<{ value?: Record<string, unknown>; issue?: KersorDiagnosticIssue }> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return {}
    return { issue: issueFromError('summary_read', error, 'warning') }
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(text)
  } catch (error) {
    return { issue: issueFromError('summary_read', error, 'warning') }
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    return { issue: createIssue('summary_read', 'invalid_payload', 'warning') }
  }
  return { value: decoded as Record<string, unknown> }
}

async function scanSession(
  sessionDir: string,
  root: string,
): Promise<{ runs: KersorRunRef[]; issues: KersorScannedRunIssue[]; issue?: KersorDiagnosticIssue }> {
  const autonomousDir = path.join(sessionDir, 'autonomous-runs')
  let autonomousChildren: Dirent[] = []
  try {
    autonomousChildren = await readdir(autonomousDir, { withFileTypes: true })
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      return { runs: [], issues: [], issue: issueFromError('runs_scan', error, 'warning') }
    }
  }
  const runs: KersorRunRef[] = []
  const issues: KersorScannedRunIssue[] = []
  const appendRun = async (
    runId: string,
    runDir: string,
    kind: KersorRunKind,
    round?: number,
  ): Promise<void> => {
    if (kind === 'classic-round') {
      try {
        await access(path.join(runDir, '.runtime', 'events.jsonl'))
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return
        issues.push({ runDir, issue: issueFromError('runs_scan', error, 'warning') })
        return
      }
    }
    const summary = await readSummary(path.join(runDir, '.runtime', 'summary.json'))
    let discovery: KersorRunDiscovery = 'active'
    if (summary.value !== undefined) {
      const status = summary.value.workflow_status ?? summary.value.status
      if (status === 'completed' || status === 'waiting') discovery = 'completed'
      else if (status === 'error' || status === 'failed') discovery = 'failed'
      else if (status !== undefined) {
        issues.push({ runDir, issue: createIssue('summary_read', 'invalid_payload', 'warning') })
      }
    }
    if (summary.issue !== undefined) issues.push({ runDir, issue: summary.issue })
    const result = await readWorkflowResult(runDir)
    runs.push({
      runId, runDir, sessionDir, root, kind,
      ...(round === undefined ? {} : { round }),
      ...(result === undefined ? {} : { result }),
      discovery,
    })
  }
  for (const child of autonomousChildren) {
    if (!child.isDirectory() && !child.isSymbolicLink()) continue
    const runId = child.name
    await appendRun(runId, path.join(autonomousDir, runId), 'autonomous')
  }
  let sessionChildren: Dirent[]
  try {
    sessionChildren = await readdir(sessionDir, { withFileTypes: true })
  } catch (error) {
    return { runs, issues, issue: issueFromError('runs_scan', error, 'warning') }
  }
  for (const child of sessionChildren) {
    if (!child.isDirectory() && !child.isSymbolicLink()) continue
    const match = /^run-([1-9][0-9]*)$/.exec(child.name)
    if (match === null) continue
    await appendRun(child.name, path.join(sessionDir, child.name), 'classic-round', Number(match[1]))
  }
  return { runs, issues }
}

/**
 * Scan all roots and return discovered runs plus bounded observations.
 * @param roots - Explicit KerSor Session roots.
 * @param includeDefaults - Whether built-in and installed-checkout roots participate.
 * @param workspaceRoots - Registered and persisted DSH Workspace roots.
 * @returns Complete committed inventory, run issues, and source observation.
 */
export async function scanRoots(
  roots: readonly string[],
  includeDefaults: boolean,
  workspaceRoots: readonly string[] = [],
): Promise<KersorScanResult> {
  const startedAt = new Date().toISOString()
  const checkout = includeDefaults ? await configuredCheckout() : {}
  const candidates = new Map<string, RootCandidate>()
  for (const root of roots) addCandidate(candidates, root, 'configured')
  if (includeDefaults) {
    for (const root of DEFAULT_KERSOR_ROOTS) addCandidate(candidates, root, 'default')
    if (checkout.root !== undefined) addCandidate(candidates, path.join(checkout.root, '.kersor'), 'checkout')
  }
  for (const workspace of workspaceRoots) addCandidate(candidates, path.join(workspace, '.kersor'), 'workspace')

  const runs: KersorRunRef[] = []
  const runIssues: KersorScannedRunIssue[] = []
  const observations: KersorRootObservation[] = []
  for (const candidate of candidates.values()) {
    const observation: MutableRootObservation = {
      ...candidate,
      state: 'healthy',
      sessionsExamined: 0,
      sessionsAccepted: 0,
      runsFound: 0,
    }
    let sessions
    try {
      sessions = await readdir(candidate.root, { withFileTypes: true })
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        observation.state = 'absent'
        if (candidate.origin === 'configured') observation.lastIssue = issueFromError('root_scan', error, 'warning')
      } else {
        observation.state = 'failed'
        observation.lastIssue = issueFromError('root_scan', error)
      }
      observations.push(observation)
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory() && !session.isSymbolicLink()) continue
      observation.sessionsExamined += 1
      const sessionDir = path.join(candidate.root, session.name)
      const inspected = await isSessionV2(sessionDir)
      if (inspected.issue !== undefined) recordRootIssue(observation, inspected.issue)
      if (!inspected.accepted) continue
      observation.sessionsAccepted += 1
      const scanned = await scanSession(sessionDir, candidate.root)
      if (scanned.issue !== undefined) recordRootIssue(observation, scanned.issue)
      runs.push(...scanned.runs)
      runIssues.push(...scanned.issues)
      observation.runsFound += scanned.runs.length
      for (const scoped of scanned.issues) recordRootIssue(observation, scoped.issue)
    }
    observations.push(observation)
  }

  const hasReadable = observations.some(root => root.state === 'healthy' || root.state === 'degraded')
  const hasProblem = checkout.issue !== undefined || observations.some(root =>
    root.state === 'failed' || root.state === 'degraded'
      || (root.state === 'absent' && root.origin === 'configured'))
  const state: KersorScanObservation['state'] = hasProblem
    ? (hasReadable ? 'degraded' : 'failed')
    : 'healthy'
  const completedAt = new Date().toISOString()
  const lastIssue = checkout.issue ?? [...observations].reverse().find(root => root.lastIssue !== undefined)?.lastIssue
  return {
    runs,
    runIssues,
    observation: {
      state,
      startedAt,
      completedAt,
      ...(state === 'failed' ? {} : { lastSuccessfulAt: completedAt }),
      roots: observations,
      ...(lastIssue === undefined ? {} : { lastIssue }),
    },
  }
}
