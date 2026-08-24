/**
 * KerSor launcher service. Config registers the only Mission files a remote
 * caller may start; KerSor remains the owner of Mission validation, run files,
 * workflow state, resume semantics, and results.
 * @module @deepseek-ai/dsh-kersor
 */

import { randomUUID } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  KersorActiveFrame,
  KersorActiveLaunch,
  KersorRunId,
  KersorTaskId,
  KersorTaskRef,
} from './types.ts'

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024
const DEFAULT_STOP_GRACE_MS = 3_000
const RUNNER_RELATIVE_PATH = 'scripts/run-autonomous-workflow.py'

/** One configured, browser-launchable autonomous Mission. */
export interface KersorTaskConfig {
  /** Stable id sent over the remote API. */
  id: string
  /** Human-readable browser label. */
  label: string
  /** Absolute `kersor-mission-v1` JSON path. */
  mission: string
  /** Optional absolute KerSor runtime-config JSON frozen into each run. */
  runtimeConfig?: string
}

/** KerSor launcher configuration. */
export interface Config {
  /** Absolute path to the KerSor checkout containing the Session-binding runner. */
  root: string
  /** Python executable in the subprocess provider's execution world. */
  python?: string
  /** Browser-launchable Missions; arbitrary paths are never accepted remotely. */
  tasks: KersorTaskConfig[]
  /** Credential references resolved per launch and forwarded under the same environment names. */
  credentialRefs?: string[]
  /** Explicit non-secret child environment entries. */
  env?: Record<string, string>
  /** In-memory cap for each launcher output stream. */
  maxOutputBytes?: number
  /** TERM-to-KILL grace for launcher process trees. */
  stopGraceMs?: number
}

interface ResolvedTask {
  ref: KersorTaskRef
  mission: string
  runtimeConfig?: string
}

interface OwnedLaunch {
  ref: KersorActiveLaunch
  handle: SubprocessHandle
  settled: Promise<void>
}

interface MissionRouting {
  workspace: string
  session: string
  runtime: 'codex' | 'pi' | 'kernelowl'
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    kersor: KersorService
  }
}

/** Host-side launcher over registered KerSor autonomous Missions. */
export class KersorService extends TypertRemoteService {
  static inject = ['credentials', 'subprocess']

  static Config: z<Config> = z.object({
    root: z.string().required(),
    python: z.string().default('python3'),
    tasks: z.array(z.object({
      id: z.string().required(),
      label: z.string().required(),
      mission: z.string().required(),
      runtimeConfig: z.string(),
    })).min(1).required(),
    credentialRefs: z.array(z.string()).default([]),
    env: z.dict(z.string()).default({}),
    maxOutputBytes: z.number().step(1).min(1).default(DEFAULT_MAX_OUTPUT_BYTES),
    stopGraceMs: z.number().step(1).min(1).default(DEFAULT_STOP_GRACE_MS),
  })

  private readonly root: string
  private readonly runner: string
  private readonly python: string
  private readonly tasks: Map<string, ResolvedTask>
  private readonly credentialRefs: CredentialRef[]
  private readonly env: Record<string, string>
  private readonly maxOutputBytes: number
  private readonly stopGraceMs: number
  private readonly active = new Map<string, OwnedLaunch>()
  private stopping = false

  /** Resolve config once; asynchronous executable and file checks run during init. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'kersor')
    this.root = absolute(config.root, 'root')
    this.runner = path.join(this.root, RUNNER_RELATIVE_PATH)
    this.python = config.python ?? 'python3'
    this.credentialRefs = (config.credentialRefs ?? []).map(credentialRef)
    this.env = { ...(config.env ?? {}) }
    this.maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.stopGraceMs = config.stopGraceMs ?? DEFAULT_STOP_GRACE_MS
    this.tasks = new Map()
    for (const task of config.tasks) {
      if (this.tasks.has(task.id)) throw new Error(`kersor: duplicate task id ${JSON.stringify(task.id)}`)
      const id = task.id as KersorTaskId
      this.tasks.set(task.id, {
        ref: { id, label: task.label },
        mission: absolute(task.mission, `mission for task ${JSON.stringify(task.id)}`),
        ...task.runtimeConfig === undefined
          ? {}
          : { runtimeConfig: absolute(task.runtimeConfig, `runtimeConfig for task ${JSON.stringify(task.id)}`) },
      })
    }
  }

  /** Validate self-contained configuration and quiesce every owned launch on disposal. */
  async* [Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    await this.ctx.subprocess.resolveExecutable(this.python, this.env)
    await access(this.runner)
    await Promise.all([...this.tasks.values()].flatMap(task => [
      access(task.mission),
      ...task.runtimeConfig === undefined ? [] : [access(task.runtimeConfig)],
    ]))
    yield async () => {
      this.stopping = true
      const launches = [...this.active.values()]
      for (const launch of launches) launch.handle.terminate()
      await Promise.allSettled(launches.map(launch => launch.settled))
      await Promise.allSettled(launches.map(launch => launch.handle.waitForExit()))
      this.active.clear()
    }
  }

  /**
   * Return the configured Mission registry without exposing host paths.
   * @returns tasks in configuration order.
   */
  @Remote('listTasks')
  listTasks(): KersorTaskRef[] {
    return [...this.tasks.values()].map(task => task.ref)
  }

  /**
   * Return launcher processes dsh still owns.
   * @returns active launch receipts in start order.
   */
  @Remote('listActive')
  listActive(): KersorActiveLaunch[] {
    return [...this.active.values()].map(launch => launch.ref)
  }

  /**
   * Start one configured Mission and return after the process tree is owned.
   * Workflow completion is observed through `dsh-kersor-viewer`, not this receipt.
   * @param taskId - configured task identity from {@link listTasks}.
   * @returns active launcher receipt, including the deterministic run directory.
   * @throws when config, credentials, Mission routing, or process spawn is invalid.
   */
  @Remote('start')
  async start(taskId: KersorTaskId): Promise<KersorActiveLaunch> {
    if (this.stopping) throw new Error('kersor: launcher is stopping')
    const task = this.tasks.get(taskId)
    if (task === undefined) throw new Error(`kersor: unknown configured task ${JSON.stringify(taskId)}`)
    const routing = await readMissionRouting(task.mission)
    const runId = createRunId(taskId)
    const runDir = path.join(routing.session, 'autonomous-runs', runId)
    const explicitEnv = await this.resolveEnvironment()
    const python = await this.ctx.subprocess.resolveExecutable(this.python, explicitEnv)
    const argv = [
      python,
      this.runner,
      '--session', routing.session,
      '--mission', task.mission,
      '--run-id', runId,
      '--runtime', routing.runtime,
      '--project-root', routing.workspace,
      ...task.runtimeConfig === undefined ? [] : ['--runtime-config', task.runtimeConfig],
    ]
    const handle = this.ctx.subprocess.spawn({
      argv,
      cwd: this.root,
      env: explicitEnv,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.maxOutputBytes },
        stderr: { maxBytes: this.maxOutputBytes },
      },
      graceMs: this.stopGraceMs,
    })
    const ref: KersorActiveLaunch = {
      taskId,
      runId,
      runDir,
      startedTs: new Date().toISOString(),
      pid: handle.pid,
    }
    const owned: OwnedLaunch = { ref, handle, settled: Promise.resolve() }
    owned.settled = handle.done.then(
      (outcome) => { this.finish(owned, outcome.exitCode === 0 ? undefined : `exit ${String(outcome.exitCode)}`) },
      (error: unknown) => { this.finish(owned, error instanceof Error ? error.message : String(error)) },
    )
    this.active.set(runDir, owned)
    this.emitActive()
    return ref
  }

  /**
   * Terminate one process tree and wait for quiescence.
   * @param runDir - exact run directory returned by {@link start}.
   * @returns false when this service does not own that run.
   */
  @Remote('stop')
  async stop(runDir: string): Promise<boolean> {
    const launch = this.active.get(runDir)
    if (launch === undefined) return false
    launch.handle.terminate()
    await launch.settled
    await launch.handle.waitForExit()
    return true
  }

  private async resolveEnvironment(): Promise<Record<string, string>> {
    const env = { ...this.env }
    for (const ref of this.credentialRefs) {
      const resolved = await this.ctx.credentials.resolve(ref)
      if (resolved === undefined) throw new Error(`kersor: credential ${JSON.stringify(ref)} is not configured`)
      env[ref] = resolved.value
    }
    return env
  }

  private finish(launch: OwnedLaunch, failure: string | undefined): void {
    if (this.active.get(launch.ref.runDir) !== launch) return
    this.active.delete(launch.ref.runDir)
    if (failure !== undefined) this.ctx.logger.warn('kersor: launcher for %s ended with %s', launch.ref.runId, failure)
    if (!this.stopping) this.emitActive()
  }

  private emitActive(): void {
    this.ctx.emit('kersor/active', {
      kind: 'active',
      launches: this.listActive(),
    } satisfies KersorActiveFrame)
  }
}

function absolute(value: string, field: string): string {
  if (!path.isAbsolute(value)) throw new Error(`kersor: ${field} must be an absolute path`)
  return path.resolve(value)
}

async function readMissionRouting(mission: string): Promise<MissionRouting> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(mission, 'utf8'))
  } catch (error) {
    throw new Error(`kersor: cannot read Mission routing from ${mission}`, { cause: error })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`kersor: Mission must be a JSON object: ${mission}`)
  }
  const record = value as Record<string, unknown>
  if (record.contract_version !== 'kersor-mission-v1') {
    throw new Error(`kersor: only kersor-mission-v1 is launchable: ${mission}`)
  }
  const base = path.dirname(mission)
  const workspace = contractPath(record.workspace, 'workspace', base, mission)
  const session = contractPath(record.session, 'session', base, mission)
  const runtime = record.runtime ?? 'codex'
  if (runtime !== 'codex' && runtime !== 'pi' && runtime !== 'kernelowl') {
    throw new Error(`kersor: unsupported Mission runtime in ${mission}`)
  }
  return { workspace, session, runtime }
}

function contractPath(value: unknown, field: string, base: string, mission: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`kersor: Mission ${field} must be a non-empty string: ${mission}`)
  }
  return path.resolve(base, value)
}

function createRunId(taskId: KersorTaskId): KersorRunId {
  const timestamp = new Date().toISOString().replaceAll(/[-:.]/g, '')
  const slug = String(taskId).replaceAll(/[^A-Za-z0-9._-]/g, '-').slice(0, 48) || 'mission'
  return `${timestamp}-${slug}-${randomUUID().slice(0, 8)}` as KersorRunId
}

/** Cordis class-plugin entry. */
export default KersorService
