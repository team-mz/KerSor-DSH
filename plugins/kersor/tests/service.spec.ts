import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { KersorService } from '../src/service.ts'
import type { KersorActiveFrame, KersorTaskId } from '../src/types.ts'

class TestCredentials extends CredentialProvider {
  constructor(ctx: Context, private readonly values: Record<string, string>) {
    super(ctx)
  }

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values[ref]
    return Promise.resolve(value === undefined ? undefined : { value, source: 'test' })
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: this.values[ref] !== undefined, writable: false })
  }

  set(): Promise<void> {
    return Promise.reject(new Error('read only'))
  }

  unset(): Promise<void> {
    return Promise.reject(new Error('read only'))
  }
}

class TestHandle implements SubprocessHandle {
  readonly pid = 4242
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly collected = {}
  private readonly outcome = Promise.withResolvers<SubprocessOutcome>()
  readonly done = this.outcome.promise
  readonly terminate = vi.fn(() => { this.outcome.resolve({ exitCode: null, signal: 'SIGTERM' }) })

  finish(exitCode = 0): void {
    this.outcome.resolve({ exitCode, signal: null })
  }

  async waitForExit(): Promise<boolean> {
    await this.done
    return true
  }
}

class TestSubprocess extends SubprocessRuntime {
  readonly specs: SubprocessSpawnSpec[] = []
  readonly handles: TestHandle[] = []

  resolveExecutable(command: string): Promise<string> {
    return Promise.resolve(command === 'python-test' ? '/resolved/python-test' : command)
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    const handle = new TestHandle()
    this.handles.push(handle)
    return handle
  }

  spawnTerminal(): Promise<never> {
    return Promise.reject(new Error('not used'))
  }
}

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  root: string
  mission: string
  runtimeConfig: string
  session: string
  workspace: string
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-kersor-'))
  roots.push(root)
  const workspace = path.join(root, 'workspace')
  const session = path.join(root, 'session')
  await mkdir(path.join(root, 'scripts'), { recursive: true })
  await mkdir(workspace)
  await mkdir(session)
  await writeFile(path.join(root, 'scripts', 'run-autonomous-workflow.py'), '# fixture\n')
  const runtimeConfig = path.join(root, 'runtime.json')
  await writeFile(runtimeConfig, '{}\n')
  const mission = path.join(root, 'mission.json')
  await writeFile(mission, JSON.stringify({
    contract_version: 'kersor-mission-v1',
    workspace: './workspace',
    session: './session',
    runtime: 'codex',
  }))
  return { root, mission, runtimeConfig, session, workspace }
}

async function boot(values: Record<string, string> = { INFINI_API_KEY: 'secret' }): Promise<{
  ctx: Context
  service: KersorService
  subprocess: TestSubprocess
  dispose(): Promise<void>
}> {
  const files = await fixture()
  const ctx = new Context()
  await ctx.plugin(TestCredentials, values)
  await ctx.plugin(TestSubprocess)
  const fiber = ctx.plugin(KersorService, {
    root: files.root,
    python: 'python-test',
    tasks: [{ id: 'memo', label: 'Memo', mission: files.mission, runtimeConfig: files.runtimeConfig }],
    credentialRefs: ['INFINI_API_KEY'],
    env: { NO_PROXY: '127.0.0.1,localhost' },
    stopGraceMs: 17,
    maxOutputBytes: 1234,
  })
  await fiber
  return {
    ctx,
    service: ctx.kersor,
    subprocess: ctx.subprocess as TestSubprocess,
    dispose: () => fiber.dispose(),
  }
}

describe('registered Mission launch', () => {
  it('resolves routing and credentials, owns the process, then removes it on exit', async () => {
    const harness = await boot()
    const frames: KersorActiveFrame[] = []
    harness.ctx.on('kersor/active', frame => void frames.push(frame))

    expect(harness.service.listTasks()).toEqual([{ id: 'memo', label: 'Memo' }])
    const launch = await harness.service.start('memo' as KersorTaskId)
    expect(launch).toMatchObject({ taskId: 'memo', pid: 4242 })
    expect(launch.runDir).toContain('/session/autonomous-runs/')
    expect(harness.service.listActive()).toEqual([launch])

    const [spec] = harness.subprocess.specs
    expect(typeof spec?.cwd).toBe('string')
    expect(spec).toMatchObject({
      env: { INFINI_API_KEY: 'secret', NO_PROXY: '127.0.0.1,localhost' },
      graceMs: 17,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 1234 },
        stderr: { maxBytes: 1234 },
      },
    })
    expect(spec!.argv).toEqual([
      '/resolved/python-test',
      path.join(spec!.cwd, 'scripts', 'run-autonomous-workflow.py'),
      '--session', path.join(spec!.cwd, 'session'),
      '--mission', path.join(spec!.cwd, 'mission.json'),
      '--run-id', launch.runId,
      '--runtime', 'codex',
      '--project-root', path.join(spec!.cwd, 'workspace'),
      '--runtime-config', path.join(spec!.cwd, 'runtime.json'),
    ])
    expect(frames.map(frame => frame.launches.length)).toEqual([1])

    harness.subprocess.handles[0]!.finish()
    await harness.subprocess.handles[0]!.done
    await vi.waitFor(() => { expect(harness.service.listActive()).toEqual([]) })
    expect(frames.map(frame => frame.launches.length)).toEqual([1, 0])
    await harness.dispose()
  })

  it('terminates and joins an owned process', async () => {
    const harness = await boot()
    const launch = await harness.service.start('memo' as KersorTaskId)
    await expect(harness.service.stop(launch.runDir)).resolves.toBe(true)
    expect(harness.subprocess.handles[0]!.terminate).toHaveBeenCalledOnce()
    await expect(harness.service.stop(launch.runDir)).resolves.toBe(false)
    await harness.dispose()
  })

  it('fails before spawning when a configured credential is absent', async () => {
    const harness = await boot({})
    await expect(harness.service.start('memo' as KersorTaskId)).rejects.toThrow(/credential.*not configured/)
    expect(harness.subprocess.specs).toEqual([])
    await harness.dispose()
  })

  it('rejects task ids outside the configured registry', async () => {
    const harness = await boot()
    await expect(harness.service.start('arbitrary-path' as KersorTaskId)).rejects.toThrow(/unknown configured task/)
    await harness.dispose()
  })
})

describe('configuration', () => {
  it('rejects relative roots and duplicate task ids synchronously', async () => {
    expect(() => new KersorService(new Context(), { root: '.', tasks: [] })).toThrow(/root must be an absolute path/)
    const files = await fixture()
    expect(() => new KersorService(new Context(), {
      root: files.root,
      tasks: [
        { id: 'same', label: 'One', mission: files.mission },
        { id: 'same', label: 'Two', mission: files.mission },
      ],
    })).toThrow(/duplicate task id/)
  })

  it('rejects non-Mission-v1 routing before spawning', async () => {
    const harness = await boot()
    const task = harness.service as unknown as { tasks: Map<string, { mission: string }> }
    const mission = task.tasks.get('memo')!.mission
    await writeFile(mission, JSON.stringify({ contract_version: 'kersor-task-v1' }))
    await expect(harness.service.start('memo' as KersorTaskId)).rejects.toThrow(/only kersor-mission-v1/)
    expect(harness.subprocess.specs).toEqual([])
    await harness.dispose()
  })

  it('brands configured credential references through the canonical validator', async () => {
    const files = await fixture()
    const ctx = new Context()
    expect(() => new KersorService(ctx, {
      root: files.root,
      tasks: [{ id: 'memo', label: 'Memo', mission: files.mission }],
      credentialRefs: ['NOT-A-REF'],
    })).toThrow(TypeError)
    expect(credentialRef('INFINI_API_KEY')).toBe('INFINI_API_KEY')
  })
})
