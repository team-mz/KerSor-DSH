// The browser store: one Host snapshot, folded run frames, backlog answers,
// transport failures, and orthogonal launcher ownership.

import { describe, expect, it } from 'vitest'
import type {
  KersorClassicSessionDetail,
  KersorRunView,
  KersorViewerFrame,
  KersorViewerSnapshot,
} from '@deepseek-ai/dsh-kersor-viewer/types'
import type { KersorActiveFrame, KersorRunId, KersorTaskId } from '@deepseek-ai/dsh-kersor/types'
import { KersorViewerStore } from '../src/client/store.ts'

const REF = {
  runId: 'r1', runDir: '/runs/r1', sessionDir: '/sessions/s1', root: '/root',
  kind: 'autonomous', discovery: 'active',
} as const

const CLASSIC_DETAIL: KersorClassicSessionDetail = {
  session_id: 's1',
  session_dir: '/sessions/s1',
  current_round: 1,
  steps: [{ id: 'authoring', status: 'active' }],
  selection: { status: 'stalled', rejectedCount: 4 },
  authoring: { status: 'in_progress', files: [] },
  validation: { status: 'pending', checks: [] },
  dispatch: { status: 'pending' },
  rounds: [],
}

function snapshot(overrides: Partial<KersorViewerSnapshot> = {}): KersorViewerSnapshot {
  return {
    asOf: '2026-08-17T00:00:00.000Z',
    runs: [REF],
    classic: { sessions: [], source: { state: 'healthy' } },
    diagnostics: {
      scan: {
        state: 'healthy',
        startedAt: '2026-08-17T00:00:00.000Z',
        completedAt: '2026-08-17T00:00:00.001Z',
        lastSuccessfulAt: '2026-08-17T00:00:00.001Z',
        roots: [],
      },
      runs: [],
    },
    ...overrides,
  }
}

function runFrame(status: 'running' | 'completed' | 'failed' = 'running'): KersorViewerFrame {
  return { kind: 'run', run: runView(status) }
}

function runView(status: 'running' | 'completed' | 'failed' = 'running'): KersorRunView {
  return {
    runId: 'r1', runDir: '/runs/r1', sessionDir: '/sessions/s1',
    status, currentPhase: 'Setup',
    phases: [{ title: 'Setup', index: 0, status: 'running', calls: [] }],
    totals: { calls: 0, completed: 0, failed: 0, tokens: 0 },
  }
}

describe('Host snapshot', () => {
  it('atomically replaces runs, classic Sessions, and diagnostics', () => {
    const store = new KersorViewerStore()
    expect(store.getSnapshot().loading).toBe(true)
    store.setSnapshot(snapshot({
      classic: {
        source: { state: 'healthy' },
        sessions: [{
          session_id: 's1',
          session_dir: '/sessions/s1',
          storage_kind: 'v2',
          lifecycle: 'active',
          status: 'in-progress',
          health: 'active',
          warningCount: 0,
        }],
      },
    }))
    expect(store.rows).toHaveLength(1)
    expect(store.getSnapshot().snapshot?.classic.sessions[0]?.session_id).toBe('s1')
    expect(store.getSnapshot().snapshot?.diagnostics.scan.state).toBe('healthy')
    expect(store.getSnapshot().loading).toBe(false)
  })

  it('keeps background rescans out of the visible loading state after first data', () => {
    const store = new KersorViewerStore()
    store.setSnapshot(snapshot({
      diagnostics: {
        scan: {
          state: 'running', startedAt: '2026-08-21T00:00:00.000Z', roots: [],
        },
        runs: [],
      },
    }))
    expect(store.getSnapshot().loading).toBe(true)

    store.setSnapshot(snapshot())
    store.setSnapshot(snapshot({
      diagnostics: {
        scan: {
          state: 'running', startedAt: '2026-08-21T00:00:05.000Z', roots: [],
        },
        runs: [],
      },
    }))
    expect(store.getSnapshot().loading).toBe(false)
  })

  it('a snapshot frame preserves a folded view for a still-discovered run', () => {
    const store = new KersorViewerStore()
    store.applyFrame(runFrame())
    store.applyFrame({ kind: 'snapshot', snapshot: snapshot() })
    expect(store.rows[0]?.view?.currentPhase).toBe('Setup')
  })

  it('drops views whose run left the authoritative inventory', () => {
    const store = new KersorViewerStore()
    store.applyFrame(runFrame())
    store.setSnapshot(snapshot({ runs: [] }))
    expect(store.rows).toEqual([])
    expect(store.getSnapshot().views.size).toBe(0)
  })
})
describe('folded run views', () => {
  it('does not fabricate an all-zero view before backlog arrives', () => {
    const store = new KersorViewerStore()
    store.setSnapshot(snapshot())
    expect(store.activeView).toBeUndefined()
  })

  it('selecting a run pins its real detail view', () => {
    const store = new KersorViewerStore()
    store.setSnapshot(snapshot({
      runs: [REF, { ...REF, runId: 'r2', runDir: '/runs/r2' }],
    }))
    store.select('/runs/r2')
    store.applyFrame({
      kind: 'run',
      run: { ...runView('completed'), runId: 'r2', runDir: '/runs/r2' },
    })
    expect(store.activeView?.runId).toBe('r2')
    expect(store.activeView?.status).toBe('completed')
  })

  it('setBacklog attaches a successful answer and ignores undefined', () => {
    const store = new KersorViewerStore()
    store.setSnapshot(snapshot())
    store.setBacklog('/runs/r1', undefined)
    expect(store.activeView).toBeUndefined()
    store.setBacklog('/runs/r1', runView('completed'))
    expect(store.activeView?.status).toBe('completed')
  })

  it('attaches a separately loaded bounded Workflow result', () => {
    const store = new KersorViewerStore()
    store.setSnapshot(snapshot())
    store.setBacklog('/runs/r1', runView('completed'))
    store.setRunResult('/runs/r1', {
      verification: 'failed', failureKind: 'correctness',
      selectedCandidateId: 'candidate-a', estimatedSpeedup: 1.2,
      candidates: [{ id: 'candidate-a' }],
    })
    expect(store.activeView?.result).toEqual({
      verification: 'failed', failureKind: 'correctness',
      selectedCandidateId: 'candidate-a', estimatedSpeedup: 1.2,
      candidates: [{ id: 'candidate-a' }],
    })
    expect(store.activeView).toMatchObject({
      verification: 'failed', failureKind: 'correctness', estimatedSpeedup: 1.2,
    })
  })

  it('stores bounded call detail independently from the run backlog', () => {
    const store = new KersorViewerStore()
    store.setSnapshot(snapshot())
    store.setCallDetailLoading('/runs/r1', 'Author/candidate/1')
    expect(store.getSnapshot().callDetailLoading).toBe('/runs/r1\u0000Author/candidate/1')
    store.setCallDetail('/runs/r1', 'Author/candidate/1', {
      callId: 'Author/candidate/1', runner: 'codex-exec', model: null,
      messages: [], activities: [], truncated: false,
    })
    expect(store.callDetail('/runs/r1', 'Author/candidate/1')?.runner).toBe('codex-exec')
    expect(store.getSnapshot().callDetailLoading).toBeUndefined()
  })
})

describe('classic Session details', () => {
  it('selects one experiment and its newest discovered run together', () => {
    const store = new KersorViewerStore()
    store.setSnapshot(snapshot({
      runs: [
        { ...REF, round: 1, runDir: '/sessions/s1/run-1' },
        { ...REF, round: 2, runDir: '/sessions/s1/run-2' },
        { ...REF, sessionDir: '/sessions/s2', runDir: '/sessions/s2/run-1' },
      ],
      classic: {
        source: { state: 'healthy' },
        sessions: [{
          session_id: 's1', session_dir: '/sessions/s1', storage_kind: 'v2',
          lifecycle: 'active', status: 'in-progress', health: 'active', warningCount: 0,
        }],
      },
    }))

    expect(store.selectClassic('/sessions/s1')).toBe('/sessions/s1/run-2')
    expect(store.selectedClassicSessionDir).toBe('/sessions/s1')
    expect(store.selectedRunDir).toBe('/sessions/s1/run-2')
    store.select('/sessions/s2/run-1')
    expect(store.selectedClassicSessionDir).toBe('/sessions/s2')
  })

  it('keeps a selected detail separate from the atomic summary snapshot', () => {
    const store = new KersorViewerStore()
    store.setSnapshot(snapshot({
      classic: {
        source: { state: 'healthy' },
        sessions: [{
          session_id: 's1', session_dir: '/sessions/s1', storage_kind: 'v2',
          lifecycle: 'active', status: 'in-progress', health: 'active', warningCount: 0,
        }],
      },
    }))
    store.selectClassic('/sessions/s1')
    store.setClassicDetailLoading('/sessions/s1')
    expect(store.getSnapshot().classicDetailLoading).toBe('/sessions/s1')
    store.setClassicDetail('/sessions/s1', CLASSIC_DETAIL)
    expect(store.selectedClassicSessionDir).toBe('/sessions/s1')
    expect(store.getSnapshot().classicDetails.get('/sessions/s1')?.authoring.status).toBe('in_progress')
    expect(store.getSnapshot().snapshot?.classic.sessions[0]?.health).toBe('active')
  })

  it('prunes details and selection when a Session leaves the snapshot', () => {
    const store = new KersorViewerStore()
    store.setSnapshot(snapshot({
      classic: {
        source: { state: 'healthy' },
        sessions: [{
          session_id: 's1', session_dir: '/sessions/s1', storage_kind: 'v2',
          lifecycle: 'active', status: 'in-progress', health: 'active', warningCount: 0,
        }],
      },
    }))
    store.selectClassic('/sessions/s1')
    store.setClassicDetail('/sessions/s1', CLASSIC_DETAIL)
    store.setSnapshot(snapshot())
    expect(store.selectedClassicSessionDir).toBeUndefined()
    expect(store.getSnapshot().classicDetails.size).toBe(0)
  })
})

describe('transport and reset', () => {
  it('a successful Host snapshot clears an older transport failure', () => {
    const store = new KersorViewerStore()
    store.setTransportError('ECONNREFUSED')
    expect(store.getSnapshot().transportError).toBe('ECONNREFUSED')
    store.setSnapshot(snapshot())
    expect(store.getSnapshot().transportError).toBeUndefined()
  })

  it('keeps degraded source health inside the Host snapshot', () => {
    const store = new KersorViewerStore()
    store.setSnapshot(snapshot({
      diagnostics: {
        scan: {
          state: 'degraded',
          roots: [],
          lastIssue: {
            stage: 'root_scan',
            code: 'permission_denied',
            severity: 'error',
            occurrences: 1,
            lastSeenAt: '2026-08-17T00:00:00.000Z',
          },
        },
        runs: [],
      },
    }))
    expect(store.getSnapshot().transportError).toBeUndefined()
    expect(store.getSnapshot().snapshot?.diagnostics.scan.state).toBe('degraded')
  })

  it('reset returns to the loading state', () => {
    const store = new KersorViewerStore()
    store.setSnapshot(snapshot())
    store.select('/runs/r1')
    store.reset()
    expect(store.getSnapshot().loading).toBe(true)
    expect(store.selectedRunDir).toBeUndefined()
    expect(store.selectedClassicSessionDir).toBeUndefined()
  })
})

describe('optional launcher composition', () => {
  it('keeps configured tasks separate from the Host viewer snapshot', () => {
    const store = new KersorViewerStore()
    store.setSnapshot(snapshot())
    store.setLauncher([{ id: 'memo' as KersorTaskId, label: 'Memo' }], [])
    expect(store.rows[0]?.runId).toBe('r1')
    expect(store.getSnapshot().launcher?.tasks[0]?.id).toBe('memo')
  })

  it('replaces owned processes and hides unavailable controls', () => {
    const store = new KersorViewerStore()
    store.setLauncher([{ id: 'memo' as KersorTaskId, label: 'Memo' }], [])
    store.applyActiveFrame({
      kind: 'active',
      launches: [{
        taskId: 'memo' as KersorTaskId,
        runId: 'r2' as KersorRunId,
        runDir: '/runs/r2',
        startedTs: '2026-08-16T00:00:00.000Z',
        pid: 42,
      }],
    } satisfies KersorActiveFrame)
    expect(store.getSnapshot().launcher?.active[0]?.runId).toBe('r2')
    store.setLauncherUnavailable()
    expect(store.getSnapshot().launcher).toBeUndefined()
  })

  it('keeps launcher failures out of viewer transport state', () => {
    const store = new KersorViewerStore()
    store.setLauncher([{ id: 'memo' as KersorTaskId, label: 'Memo' }], [])
    store.setLauncherError('spawn failed')
    expect(store.getSnapshot().launcher?.error).toBe('spawn failed')
    expect(store.getSnapshot().transportError).toBeUndefined()
  })

  it('ignores active frames until the optional launcher is confirmed', () => {
    const store = new KersorViewerStore()
    store.applyActiveFrame({ kind: 'active', launches: [] })
    expect(store.getSnapshot().launcher).toBeUndefined()
  })
})
