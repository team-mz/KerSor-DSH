// The scanner: session-v2 recognition (session-config.json + state.json),
// autonomous and classic-round discovery, summary-based classification, and quiet skips
// for absent roots.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanRoots } from '../src/scanner.ts'

const dirs: string[] = []

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kersor-scan-'))
  dirs.push(dir)
  return dir
}

async function makeSession(root: string, name: string): Promise<string> {
  const sessionDir = path.join(root, name)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(path.join(sessionDir, 'session-config.json'), '{}')
  await writeFile(path.join(sessionDir, 'state.json'), '{}')
  return sessionDir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('run discovery', () => {
  it('finds runs under session-v2 directories and classifies by summary', async () => {
    const root = await tempRoot()
    const active = await makeSession(root, 'sess-active')
    const done = await makeSession(root, 'sess-done')
    const waiting = await makeSession(root, 'sess-waiting')
    const blocked = await makeSession(root, 'sess-blocked')
    const failed = await makeSession(root, 'sess-failed')

    const activeRun = path.join(active, 'autonomous-runs', '20260814T100000Z')
    await mkdir(path.join(activeRun, '.runtime'), { recursive: true })
    await writeFile(path.join(activeRun, '.runtime', 'events.jsonl'), '{"type":"workflow.started"}\n')

    const doneRun = path.join(done, 'autonomous-runs', '20260813T090000Z')
    await mkdir(path.join(doneRun, '.runtime'), { recursive: true })
    await writeFile(path.join(doneRun, '.runtime', 'summary.json'), JSON.stringify({ workflow_status: 'completed' }))

    // Controller can also stop 'waiting' (awaiting external input); the host
    // summary is written either way, so the run is terminal, not active.
    const waitingRun = path.join(waiting, 'autonomous-runs', '20260813T093000Z')
    await mkdir(path.join(waitingRun, '.runtime'), { recursive: true })
    await writeFile(path.join(waitingRun, '.runtime', 'summary.json'), JSON.stringify({ status: 'completed', workflow_status: 'waiting' }))

    const blockedRun = path.join(blocked, 'autonomous-runs', '20260813T083000Z')
    await mkdir(path.join(blockedRun, '.runtime'), { recursive: true })
    await writeFile(path.join(blockedRun, '.runtime', 'summary.json'), JSON.stringify({ status: 'completed', workflow_status: 'blocked' }))

    const failedRun = path.join(failed, 'autonomous-runs', '20260813T080000Z')
    await mkdir(path.join(failedRun, '.runtime'), { recursive: true })
    // workflow-host's failure summary writes `status: 'error'` (no workflow_status).
    await writeFile(path.join(failedRun, '.runtime', 'summary.json'), JSON.stringify({ status: 'error' }))

    const found = await scanRoots([root], false)
    const byDir = new Map(found.runs.map(ref => [ref.runDir, ref]))
    expect(byDir.size).toBe(5)
    expect(byDir.get(activeRun)!.discovery).toBe('active')
    expect(byDir.get(doneRun)!.discovery).toBe('completed')
    expect(byDir.get(waitingRun)!.discovery).toBe('waiting')
    expect(byDir.get(blockedRun)!.discovery).toBe('failed')
    expect(byDir.get(failedRun)!.discovery).toBe('failed')
    expect(byDir.get(activeRun)!.runId).toBe('20260814T100000Z')
    expect(byDir.get(activeRun)!.sessionDir).toBe(active)
    expect(byDir.get(activeRun)).toMatchObject({ kind: 'autonomous' })
    expect(found.observation).toMatchObject({
      state: 'healthy',
      roots: [{ root, origin: 'configured', state: 'healthy', sessionsAccepted: 5, runsFound: 5 }],
    })
  })

  it('discovers classic run-N runtime events and ignores preparation-only directories', async () => {
    const root = await tempRoot()
    const session = await makeSession(root, 'sess-classic')
    const completed = path.join(session, 'run-3')
    await mkdir(path.join(completed, '.runtime'), { recursive: true })
    await writeFile(path.join(completed, '.runtime', 'events.jsonl'), [
      '{"type":"workflow.started"}',
      '{"type":"workflow.completed"}',
      '',
    ].join('\n'))
    await writeFile(path.join(completed, '.runtime', 'summary.json'), JSON.stringify({ status: 'completed' }))
    await mkdir(path.join(session, 'run-4'), { recursive: true })
    await writeFile(path.join(session, 'run-4', 'dispatch-args.json'), '{}')

    const found = await scanRoots([root], false)

    expect(found.runs).toEqual([{
      runId: 'run-3', runDir: completed, sessionDir: session, root,
      kind: 'classic-round', round: 3, discovery: 'completed',
    }])
    expect(found.observation.roots[0]).toMatchObject({ runsFound: 1 })
  })

  it('discovers direct general Task runs under a Workspace KerSor root', async () => {
    const workspace = await tempRoot()
    const root = path.join(workspace, '.kersor')
    const activeRun = path.join(root, '20260825T044946Z-general-evolve')
    const completedRun = path.join(root, '20260825T045500Z-general-evolve')
    const failedRun = path.join(root, '20260825T050000Z-general-evolve')
    for (const runDir of [activeRun, completedRun, failedRun]) {
      await mkdir(path.join(runDir, '.runtime'), { recursive: true })
      await writeFile(path.join(runDir, 'task.json'), '{"contract_version":"kersor-task-v1"}')
      await writeFile(path.join(runDir, '.runtime', 'events.jsonl'), '{"type":"workflow.started"}\n')
    }
    await writeFile(path.join(completedRun, '.runtime', 'events.jsonl'), [
      '{"type":"workflow.started"}',
      '{"type":"workflow.completed"}',
      '',
    ].join('\n'))
    await writeFile(path.join(failedRun, '.runtime', 'events.jsonl'), [
      '{"type":"workflow.started"}',
      '{"type":"workflow.failed"}',
      '',
    ].join('\n'))

    const found = await scanRoots([], false, [workspace])

    expect(new Map(found.runs.map(run => [run.runDir, run]))).toEqual(new Map([
      [activeRun, {
        runId: path.basename(activeRun), runDir: activeRun, sessionDir: activeRun, root,
        kind: 'general-task', discovery: 'active',
      }],
      [completedRun, {
        runId: path.basename(completedRun), runDir: completedRun, sessionDir: completedRun, root,
        kind: 'general-task', discovery: 'completed',
      }],
      [failedRun, {
        runId: path.basename(failedRun), runDir: failedRun, sessionDir: failedRun, root,
        kind: 'general-task', discovery: 'failed',
      }],
    ]))
    expect(found.observation.roots[0]).toMatchObject({
      root, origin: 'workspace', sessionsExamined: 3, sessionsAccepted: 0, runsFound: 3,
    })
  })

  it('normalizes canonical task-v1 terminal statuses', async () => {
    const root = await tempRoot()
    const session = await makeSession(root, 'sess-task-v1')
    const expected = new Map([
      ['succeeded', 'completed'],
      ['stagnated', 'failed'],
      ['exhausted', 'failed'],
    ])
    for (const status of expected.keys()) {
      const runDir = path.join(session, 'autonomous-runs', status)
      await mkdir(path.join(runDir, '.runtime'), { recursive: true })
      await writeFile(path.join(runDir, '.runtime', 'summary.json'), JSON.stringify({
        status: 'completed', workflow_status: status,
      }))
    }

    const found = await scanRoots([root], false)
    const byId = new Map(found.runs.map(ref => [ref.runId, ref.discovery]))

    expect(byId).toEqual(expected)
    expect(found.runIssues).toEqual([])
  })

  it('skips directories that are not session v2', async () => {
    const root = await tempRoot()
    const plain = path.join(root, 'plain-dir')
    const legacy = path.join(root, 'legacy')
    await mkdir(path.join(plain, 'autonomous-runs'), { recursive: true })
    await mkdir(path.join(legacy, 'autonomous-runs'), { recursive: true })
    await writeFile(path.join(legacy, 'state.json'), '{}') // config missing
    const found = await scanRoots([root], false)
    expect(found.runs).toEqual([])
    expect(found.observation.roots[0]).toMatchObject({ sessionsExamined: 2, sessionsAccepted: 0 })
  })

  it('distinguishes an absent configured root from a healthy empty root', async () => {
    const found = await scanRoots([path.join(tmpdir(), 'kersor-no-such-root-xyz')], false)
    expect(found.runs).toEqual([])
    expect(found.observation.state).toBe('failed')
    expect(found.observation.roots[0]).toMatchObject({
      origin: 'configured', state: 'absent', lastIssue: { stage: 'root_scan', code: 'not_found' },
    })
  })

  it('discovers workspace Sessions and reports malformed summaries without their content', async () => {
    const workspace = await tempRoot()
    const session = await makeSession(path.join(workspace, '.kersor'), 'sess-workspace')
    const runDir = path.join(session, 'autonomous-runs', 'run-secret')
    await mkdir(path.join(runDir, '.runtime'), { recursive: true })
    await writeFile(path.join(runDir, '.runtime', 'summary.json'), '{SECRET-CONTENT')

    const found = await scanRoots([], false, [workspace])
    expect(found.runs.map(ref => ref.runDir)).toEqual([runDir])
    expect(found.observation.state).toBe('degraded')
    expect(found.runIssues).toHaveLength(1)
    expect(found.runIssues[0]?.runDir).toBe(runDir)
    expect(found.runIssues[0]?.issue.stage).toBe('summary_read')
    expect(found.runIssues[0]?.issue.code).toBe('invalid_json')
    expect(JSON.stringify(found)).not.toContain('SECRET-CONTENT')
  })
})
