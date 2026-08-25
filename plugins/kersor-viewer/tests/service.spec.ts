import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { KersorViewerService } from '../src/service.ts'

const dirs: string[] = []

async function fixture(events: string | undefined): Promise<{ workspace: string; runDir: string }> {
  const workspace = await mkdtemp(path.join(tmpdir(), 'kersor-viewer-service-'))
  dirs.push(workspace)
  const session = path.join(workspace, '.kersor', 'session')
  const runDir = path.join(session, 'autonomous-runs', 'run-1')
  await mkdir(path.join(runDir, '.runtime'), { recursive: true })
  await writeFile(path.join(session, 'session-config.json'), '{}')
  await writeFile(path.join(session, 'state.json'), '{}')
  await writeFile(path.join(runDir, '.runtime', 'summary.json'), '{"workflow_status":"completed"}')
  if (events !== undefined) await writeFile(path.join(runDir, '.runtime', 'events.jsonl'), events)
  return { workspace, runDir }
}

async function settleBackfill(service: KersorViewerService, runDir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const observation = service.snapshot().diagnostics.runs.find(run => run.runDir === runDir)
    if (observation?.state !== 'waiting') return
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
  throw new Error('backfill did not settle')
}

async function settleResult(service: KersorViewerService, runDir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await service.runBacklog(runDir))?.result !== undefined) return
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
  throw new Error('workflow result did not settle')
}

async function settleBacklog(
  service: KersorViewerService,
  runDir: string,
  predicate: (view: NonNullable<Awaited<ReturnType<KersorViewerService['runBacklog']>>>) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const view = await service.runBacklog(runDir)
    if (view !== undefined && predicate(view)) return
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
  throw new Error('backlog did not settle')
}

function sourceContext(
  workspaceRoots: readonly string[] = [],
  persistenceList: () => Promise<unknown[]> = () => Promise.resolve([]),
): Context {
  const ctx = new Context()
  ctx.provide('workspaceRegistry', {
    list: () => workspaceRoots.map(workspace => ({ path: workspace })),
  } as never)
  ctx.provide('sessionPersistence', { list: persistenceList } as never)
  return ctx
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('Host snapshot', () => {
  it('tails a direct general Task run discovered from the current Workspace', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'kersor-viewer-general-task-'))
    dirs.push(workspace)
    const runDir = path.join(workspace, '.kersor', '20260825T044946Z-general-evolve')
    await mkdir(path.join(runDir, '.runtime'), { recursive: true })
    await writeFile(path.join(runDir, 'task.json'), '{"contract_version":"kersor-task-v1"}')
    await writeFile(path.join(runDir, '.runtime', 'events.jsonl'), [
      '{"type":"workflow.started","script":"/workflows/general/self-evolve.js"}',
      '{"type":"phase.changed","phase":"Evolve 1"}',
      '{"type":"agent.started","seq":1,"call_id":"Evolve-1/evolve-1/1","phase":"Evolve 1","label":"evolve-1"}',
      '',
    ].join('\n'))
    const service = new KersorViewerService(sourceContext([workspace]), {
      noDefaultRoots: true, classicSessionLimit: 0,
    })

    await service.rescan()
    await settleBacklog(service, runDir, view => view.currentPhase === 'Evolve 1')

    expect(service.snapshot()).toMatchObject({
      runs: [{
        runId: path.basename(runDir), runDir, sessionDir: runDir,
        root: path.join(workspace, '.kersor'), kind: 'general-task', discovery: 'active',
      }],
      diagnostics: {
        scan: { state: 'healthy', roots: [{ origin: 'workspace', runsFound: 1 }] },
      },
    })
    expect(await service.runBacklog(runDir)).toMatchObject({
      runId: path.basename(runDir), runDir, sessionDir: runDir,
      status: 'running', currentPhase: 'Evolve 1',
      totals: { calls: 1, completed: 0, failed: 0 },
    })

    await appendFile(path.join(runDir, '.runtime', 'events.jsonl'), '{"type":"workflow.failed"}\n')
    await service.rescan()

    expect(service.snapshot().runs).toContainEqual(expect.objectContaining({
      runDir, kind: 'general-task', discovery: 'failed',
    }))
    expect(await service.runBacklog(runDir)).toMatchObject({ status: 'failed' })
  })

  it('refuses detail reads outside the discovered classic Session inventory', async () => {
    const ctx = sourceContext()
    const service = new KersorViewerService(ctx, {
      noDefaultRoots: true, classicSessionLimit: 0,
    })

    await expect(service.classicSessionDetail('/sessions/not-discovered')).resolves.toBeUndefined()
    await expect(service.runCallDetail('/runs/not-discovered', 'Author/candidate/1')).resolves.toBeUndefined()
  })

  it('discovers persistence-only Session cwd roots while ignoring invalid and duplicate values', async () => {
    const { workspace, runDir } = await fixture([
      '{"type":"workflow.started"}',
      '{"type":"workflow.completed"}',
      '',
    ].join('\n'))
    const ctx = sourceContext([], () => Promise.resolve([
      { cwd: workspace },
      { cwd: `${workspace}${path.sep}` },
      { cwd: 'relative/workspace' },
      {},
    ]))
    const service = new KersorViewerService(ctx, {
      noDefaultRoots: true, classicSessionLimit: 0,
    })

    await service.rescan()
    await settleBackfill(service, runDir)
    const snapshot = service.snapshot()
    expect(snapshot.runs).toContainEqual(expect.objectContaining({ runDir }))
    expect(snapshot.diagnostics.scan.roots).toEqual([
      expect.objectContaining({
        root: path.join(workspace, '.kersor'), origin: 'workspace', runsFound: 1,
      }),
    ])
  })

  it('does not republish a snapshot when only scan clocks changed', async () => {
    const { workspace, runDir } = await fixture([
      '{"type":"workflow.started"}',
      '{"type":"workflow.completed"}',
      '',
    ].join('\n'))
    const ctx = sourceContext([workspace])
    const snapshots: string[] = []
    ctx.on('kersor/event', (frame) => {
      if (frame.kind === 'snapshot') snapshots.push(frame.snapshot.asOf)
    })
    const service = new KersorViewerService(ctx, {
      noDefaultRoots: true, classicSessionLimit: 0,
    })

    await service.rescan()
    await settleBackfill(service, runDir)
    const afterFirstScan = snapshots.length
    await service.rescan()

    expect(snapshots).toHaveLength(afterFirstScan)
  })

  it('degrades a persistence listing failure without losing registry roots or publishing running state', async () => {
    const { workspace, runDir } = await fixture([
      '{"type":"workflow.started"}',
      '{"type":"workflow.completed"}',
      '',
    ].join('\n'))
    const failure = Object.assign(new Error('persistence unavailable'), { code: 'EIO' })
    const ctx = sourceContext([workspace], () => Promise.reject(failure))
    const published: string[] = []
    ctx.on('kersor/event', (frame) => {
      if (frame.kind === 'snapshot') published.push(frame.snapshot.diagnostics.scan.state)
    })
    const service = new KersorViewerService(ctx, {
      noDefaultRoots: true, classicSessionLimit: 0,
    })

    await service.rescan()
    await settleBackfill(service, runDir)
    expect(service.snapshot()).toMatchObject({
      runs: [{ runDir }],
      diagnostics: {
        scan: {
          state: 'degraded',
          roots: [{ root: path.join(workspace, '.kersor'), runsFound: 1 }],
          lastIssue: { stage: 'root_scan', code: 'io_error', severity: 'warning' },
        },
      },
    })
    expect(published).not.toContain('running')
  })

  it('retains the last successful persistence roots across a later listing failure', async () => {
    const registered = await fixture([
      '{"type":"workflow.started"}',
      '{"type":"workflow.completed"}',
      '',
    ].join('\n'))
    const persisted = await fixture([
      '{"type":"workflow.started"}',
      '{"type":"workflow.completed"}',
      '',
    ].join('\n'))
    let fail = false
    const failure = Object.assign(new Error('persistence unavailable'), { code: 'EIO' })
    const ctx = sourceContext([registered.workspace], () => fail
      ? Promise.reject(failure)
      : Promise.resolve([{ cwd: persisted.workspace }]))
    const service = new KersorViewerService(ctx, {
      noDefaultRoots: true, classicSessionLimit: 0,
    })

    await service.rescan()
    await Promise.all([
      settleBackfill(service, registered.runDir),
      settleBackfill(service, persisted.runDir),
    ])
    fail = true
    const published: string[] = []
    ctx.on('kersor/event', (frame) => {
      if (frame.kind === 'snapshot') published.push(frame.snapshot.diagnostics.scan.state)
    })
    await service.rescan()

    const snapshot = service.snapshot()
    expect(snapshot.runs.map(run => run.runDir).sort()).toEqual([
      registered.runDir, persisted.runDir,
    ].sort())
    expect(snapshot.diagnostics.scan.roots.map(root => root.root).sort()).toEqual([
      path.join(registered.workspace, '.kersor'),
      path.join(persisted.workspace, '.kersor'),
    ].sort())
    expect(snapshot.diagnostics.scan).toMatchObject({
      state: 'degraded', lastIssue: { stage: 'root_scan', code: 'io_error' },
    })
    expect(published).not.toContain('running')
  })

  it('keeps terminal lifecycle while exposing a missing backfill as structured failure', async () => {
    const { workspace, runDir } = await fixture(undefined)
    const ctx = sourceContext([workspace])
    const service = new KersorViewerService(ctx, {
      noDefaultRoots: true, classicSessionLimit: 0,
    })

    await service.rescan()
    await settleBackfill(service, runDir)

    expect((await service.runBacklog(runDir))?.status).toBe('completed')
    expect(service.snapshot()).toMatchObject({
      runs: [{ runDir, discovery: 'completed' }],
      classic: { sessions: [], source: { state: 'disabled' } },
      diagnostics: {
        scan: { state: 'healthy', roots: [{ origin: 'workspace', runsFound: 1 }] },
        runs: [{
          runDir, mode: 'backfill', state: 'failed',
          lastIssue: { stage: 'backfill_read', code: 'not_found' },
        }],
      },
    })
  })

  it('keeps a failed Mission failed when the Host event stream ends completed', async () => {
    const { workspace, runDir } = await fixture([
      '{"type":"workflow.started"}',
      '{"type":"workflow.completed"}',
      '',
    ].join('\n'))
    await writeFile(
      path.join(runDir, '.runtime', 'summary.json'),
      JSON.stringify({ status: 'completed', workflow_status: 'failed' }),
    )
    const service = new KersorViewerService(sourceContext([workspace]), {
      noDefaultRoots: true, classicSessionLimit: 0,
    })

    await service.rescan()
    await settleBackfill(service, runDir)

    expect(service.snapshot().runs).toContainEqual(expect.objectContaining({
      runDir, discovery: 'failed',
    }))
    expect((await service.runBacklog(runDir))?.status).toBe('failed')
  })

  it('projects a blocked Mission as unsuccessful after Host completion', async () => {
    const { workspace, runDir } = await fixture([
      '{"type":"workflow.started"}',
      '{"type":"workflow.completed"}',
      '',
    ].join('\n'))
    await writeFile(
      path.join(runDir, '.runtime', 'summary.json'),
      JSON.stringify({ status: 'completed', workflow_status: 'blocked' }),
    )
    const service = new KersorViewerService(sourceContext([workspace]), {
      noDefaultRoots: true, classicSessionLimit: 0,
    })

    await service.rescan()
    await settleBackfill(service, runDir)

    expect(service.snapshot().runs).toContainEqual(expect.objectContaining({
      runDir, discovery: 'failed',
    }))
    expect((await service.runBacklog(runDir))?.status).toBe('failed')
  })

  it('projects a stagnated task-v1 Workflow as unsuccessful after Host completion', async () => {
    const { workspace, runDir } = await fixture([
      '{"type":"workflow.started"}',
      '{"type":"workflow.completed"}',
      '',
    ].join('\n'))
    await writeFile(
      path.join(runDir, '.runtime', 'summary.json'),
      JSON.stringify({ status: 'completed', workflow_status: 'stagnated' }),
    )
    const service = new KersorViewerService(sourceContext([workspace]), {
      noDefaultRoots: true, classicSessionLimit: 0,
    })

    await service.rescan()
    await settleBackfill(service, runDir)

    expect(service.snapshot().runs).toContainEqual(expect.objectContaining({
      runDir, discovery: 'failed',
    }))
    expect((await service.runBacklog(runDir))?.status).toBe('failed')
  })

  it('keeps a waiting Mission resumable when the Host event stream ends completed', async () => {
    const { workspace, runDir } = await fixture([
      '{"type":"workflow.started"}',
      '{"type":"workflow.completed"}',
      '',
    ].join('\n'))
    await writeFile(
      path.join(runDir, '.runtime', 'summary.json'),
      JSON.stringify({ status: 'completed', workflow_status: 'waiting', calls: 1 }),
    )
    const service = new KersorViewerService(sourceContext([workspace]), {
      noDefaultRoots: true, classicSessionLimit: 0,
    })

    await service.rescan()
    await settleBackfill(service, runDir)

    expect(service.snapshot().runs).toContainEqual(expect.objectContaining({
      runDir, discovery: 'waiting',
    }))
    expect((await service.runBacklog(runDir))?.status).toBe('waiting')
  })

  it('rebuilds a waiting run from the full ledger after resume completes', async () => {
    const first = [
      '{"type":"workflow.started"}',
      '{"type":"phase.changed","phase":"First"}',
      '{"type":"agent.queued","phase":"First","seq":0,"call_id":"first"}',
      '{"type":"agent.completed","phase":"First","seq":0,"call_id":"first","usage":{"total_tokens":3}}',
      '{"type":"workflow.completed","usage":{"total_tokens":3}}',
      '',
    ].join('\n')
    const second = [
      '{"type":"workflow.started"}',
      '{"type":"phase.changed","phase":"Resumed"}',
      '{"type":"agent.queued","phase":"Resumed","seq":1,"call_id":"second"}',
      '{"type":"agent.completed","phase":"Resumed","seq":1,"call_id":"second","usage":{"total_tokens":5}}',
      '{"type":"workflow.completed","usage":{"total_tokens":8}}',
      '',
    ].join('\n')
    const { workspace, runDir } = await fixture(first)
    await writeFile(
      path.join(runDir, '.runtime', 'summary.json'),
      JSON.stringify({ status: 'completed', workflow_status: 'waiting', calls: 1 }),
    )
    const service = new KersorViewerService(sourceContext([workspace]), {
      noDefaultRoots: true, classicSessionLimit: 0,
    })
    await service.rescan()
    await settleBackfill(service, runDir)

    await appendFile(path.join(runDir, '.runtime', 'events.jsonl'), second)
    await writeFile(
      path.join(runDir, '.runtime', 'summary.json'),
      JSON.stringify({ status: 'completed', workflow_status: 'completed' }),
    )
    await service.rescan()
    await settleBacklog(service, runDir, view => view.phases.length === 2)

    const view = await service.runBacklog(runDir)
    expect(view).toMatchObject({
      status: 'completed',
      phases: [{ title: 'First' }, { title: 'Resumed' }],
      totals: { calls: 2, completed: 2, failed: 0, tokens: 8 },
    })
    expect(service.snapshot().diagnostics.runs).toContainEqual(expect.objectContaining({
      runDir,
      byteOffset: Buffer.byteLength(first + second),
      linesRead: 10,
    }))
  })

  it('refreshes events and bounded output when a resumed run waits again', async () => {
    const first = [
      '{"type":"workflow.started"}',
      '{"type":"phase.changed","phase":"First"}',
      '{"type":"workflow.completed"}',
      '',
    ].join('\n')
    const second = [
      '{"type":"workflow.started"}',
      '{"type":"phase.changed","phase":"Resumed"}',
      '{"type":"workflow.completed"}',
      '',
    ].join('\n')
    const { workspace, runDir } = await fixture(first)
    await writeFile(
      path.join(runDir, '.runtime', 'summary.json'),
      JSON.stringify({ status: 'completed', workflow_status: 'waiting', calls: 1 }),
    )
    await writeFile(path.join(runDir, 'output.json'), JSON.stringify({ arch_stage: 'first_wait' }))
    const service = new KersorViewerService(sourceContext([workspace]), {
      noDefaultRoots: true, classicSessionLimit: 0,
    })
    await service.rescan()
    await settleBackfill(service, runDir)
    await settleResult(service, runDir)

    await appendFile(path.join(runDir, '.runtime', 'events.jsonl'), second)
    await writeFile(path.join(runDir, 'output.json'), JSON.stringify({ arch_stage: 'second_wait' }))
    await service.rescan()
    expect(await service.runBacklog(runDir)).toMatchObject({
      status: 'waiting',
      phases: [{ title: 'First' }],
      result: { stage: 'first_wait' },
    })
    expect(service.snapshot().diagnostics.runs).toContainEqual(expect.objectContaining({
      runDir,
      byteOffset: Buffer.byteLength(first),
      linesRead: 3,
    }))

    await writeFile(
      path.join(runDir, '.runtime', 'summary.json'),
      JSON.stringify({ status: 'completed', workflow_status: 'waiting', calls: 2 }),
    )
    await service.rescan()
    await settleBacklog(service, runDir, view => view.phases.length === 2)

    const view = await service.runBacklog(runDir)
    expect(view).toMatchObject({
      status: 'waiting',
      phases: [{ title: 'First' }, { title: 'Resumed' }],
      result: { stage: 'second_wait' },
    })
    const run = service.snapshot().runs.find(candidate => candidate.runDir === runDir)
    expect(run).toMatchObject({ runDir, discovery: 'waiting' })
    expect(run?.result).toMatchObject({ stage: 'second_wait' })
    expect(service.snapshot().diagnostics.runs).toContainEqual(expect.objectContaining({
      runDir,
      byteOffset: Buffer.byteLength(first + second),
      linesRead: 6,
    }))
  })

  it('rejects an invalid event without losing later valid events or exposing content', async () => {
    const secret = 'SECRET-EVENT-CONTENT'
    const { workspace, runDir } = await fixture([
      '{"type":"workflow.started"}',
      `{"secret":"${secret}"}`,
      '{"type":"workflow.completed"}',
      '',
    ].join('\n'))
    const ctx = sourceContext([workspace])
    const service = new KersorViewerService(ctx, {
      noDefaultRoots: true, classicSessionLimit: 0,
    })

    await service.rescan()
    await settleBackfill(service, runDir)
    const snapshot = service.snapshot()

    expect((await service.runBacklog(runDir))?.status).toBe('completed')
    expect(snapshot.diagnostics.runs[0]).toMatchObject({
      state: 'degraded', linesRead: 3, linesRejected: 1,
      lastIssue: { stage: 'event_parse', code: 'invalid_payload' },
    })
    expect(JSON.stringify(snapshot)).not.toContain(secret)
  })

  it('projects bounded candidate selection from the canonical workflow output', async () => {
    const { workspace, runDir } = await fixture([
      '{"type":"workflow.started","script":"/workflows/vliw-pack/workflow.js","script_hash":"sha256:abc"}',
      '{"type":"phase.changed","phase":"Author"}',
      '{"type":"workflow.completed"}',
      '',
    ].join('\n'))
    await writeFile(path.join(runDir, 'output.json'), JSON.stringify({
      arch_stage: 'awaiting_host_verification',
      selected_candidate_id: 'simd-batch-v1',
      expected_cycles_estimate: 2140,
      estimated_speedup: 69.03,
      overall_speedup: null,
      candidate_log: [
        { candidate_id: 'pack-scalar-v1', expected_cycles: 8700 },
        { candidate_id: 'simd-batch-v1', expected_cycles: 2140 },
      ],
      ignored_secret: 'SECRET-OUTPUT-CONTENT',
    }))
    await writeFile(path.join(runDir, 'host-verification.json'), JSON.stringify({
      verdict: 'pass',
      metric: { candidate_cycles: 2130, speedup: 69.35868544600939 },
      ignored_secret: 'SECRET-HOST-CONTENT',
    }))
    const ctx = sourceContext([workspace])
    const service = new KersorViewerService(ctx, {
      noDefaultRoots: true, classicSessionLimit: 0,
    })

    await service.rescan()
    await settleBackfill(service, runDir)
    await settleResult(service, runDir)

    const view = await service.runBacklog(runDir)
    const result = await service.runResult(runDir)
    expect(view).toMatchObject({
      workflow: 'vliw-pack',
      scriptHash: 'sha256:abc',
      result: {
        stage: 'host_verified',
        selectedCandidateId: 'simd-batch-v1',
        expectedCycles: 2140,
        measuredCycles: 2130,
        estimatedSpeedup: 69.03,
        measuredSpeedup: 69.35868544600939,
        candidates: [
          { id: 'pack-scalar-v1', expectedCycles: 8700 },
          { id: 'simd-batch-v1', expectedCycles: 2140 },
        ],
      },
    })
    expect(JSON.stringify(view)).not.toContain('SECRET-OUTPUT-CONTENT')
    expect(JSON.stringify(view)).not.toContain('SECRET-HOST-CONTENT')
    expect(result).toEqual(view?.result)
  })
})
