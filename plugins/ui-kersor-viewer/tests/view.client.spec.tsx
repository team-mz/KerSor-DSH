// @vitest-environment jsdom
/** KerSor is a first-class conversation view beside Chat and Trajectory. */

import { Context, Service } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { ConversationEventRegistry, SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { KersorViewerSnapshot } from '@deepseek-ai/dsh-kersor-viewer/types'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { apply, inject } from '../src/client/index.ts'
import { KersorView } from '../src/client/KersorView.tsx'
import { zh } from '../src/client/locales.ts'
import { KersorViewerStore } from '../src/client/store.ts'

const EMPTY_SNAPSHOT: KersorViewerSnapshot = {
  asOf: '2026-08-21T00:00:00.000Z',
  runs: [],
  classic: { sessions: [], source: { state: 'healthy' } },
  diagnostics: {
    scan: {
      state: 'healthy',
      startedAt: '2026-08-21T00:00:00.000Z',
      completedAt: '2026-08-21T00:00:00.001Z',
      lastSuccessfulAt: '2026-08-21T00:00:00.001Z',
      roots: [],
    },
    runs: [],
  },
}

class RemoteService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'remote')
  }

  $on(): () => void {
    return () => {}
  }
}

afterEach(cleanup)

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  await ctx.plugin(ConversationEventRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'conversation.view': { kind: 'list', scope: 'session' },
      'conversation.chat.node': { kind: 'keyed', scope: 'session' },
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
    },
  } as never, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('sessions', {
    list: { getSnapshot: () => ({ byId: { session: { cwd: '/work/current' } } }) },
    refreshSubagents: () => Promise.resolve(),
    openSubagent: () => {},
  })
  new RemoteService(ctx)
  ctx.provide('remote.pluginInventory', {
    list: () => Promise.resolve({ ok: true, value: { entries: [] } }),
  })
  ctx.provide('remote.kersorViewer', {
    snapshot: () => Promise.resolve({ ok: true, value: EMPTY_SNAPSHOT }),
    runBacklog: () => Promise.resolve({ ok: true, value: undefined }),
    runResult: () => Promise.resolve({ ok: true, value: undefined }),
    runCallDetail: () => Promise.resolve({ ok: true, value: undefined }),
    classicSessionDetail: () => Promise.resolve({ ok: true, value: undefined }),
  })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber }
}

describe('KerSor conversation view registration', () => {
  it('keeps the final run clear of the floating conversation composer', () => {
    const styles = readFileSync(path.join(
      process.cwd(), 'packages/extensions/ui-kersor-viewer/src/client/KersorView.module.css',
    ), 'utf8')
    expect(styles).toContain('padding-bottom: calc(var(--dsh-composer-height, 152px) + 24px)')
  })

  it('registers beside Chat and Trajectory instead of in the sidebar footer', async () => {
    const b = await bench()
    const entry = b.ctx.slots.entries('conversation.view')[0]
    expect(entry?.options).toMatchObject({ id: 'kersor', order: 20 })
    expect(resolveSlotLabel(entry?.options.label)).toBe('KerSor')
    expect(b.ctx.slots.entries('sidebar.footer.action')).toHaveLength(0)

    await b.fiber.dispose()
    expect(b.ctx.slots.entries('conversation.view')).toHaveLength(0)
  })

  it('visualizes the runtime pipeline, parallel calls, and selected candidate', async () => {
    const store = new KersorViewerStore()
    const sessionDir = '/work/other/.kersor/20260821-134926'
    const runDir = `${sessionDir}/run-1`
    store.setSnapshot({
      ...EMPTY_SNAPSHOT,
      classic: {
        source: { state: 'healthy' },
        sessions: [{
          session_id: '20260821-134926', session_dir: sessionDir, storage_kind: 'v2',
          phase: 'optimizing', lifecycle: 'active', status: 'in-progress', health: 'stale',
          current_round: 1, max_workflows: 20, workflow: 'vliw-bundle-packing-optimization',
          allow_workflow_authoring: true, workflow_authoring_budget: 3, workflow_authoring_used: 1,
          cycle_lineage: {
            session_baseline_cycles: 14415, best_cycles: 13358, session_speedup: 1.0791286120676749,
            task_baseline_cycles: 147734, overall_speedup: 11.05958975894595,
          },
          candidate_ownership: 'pending', warningCount: 0,
        }],
      },
      runs: [{
        runId: 'run-1', runDir, sessionDir, root: '/work/other/.kersor',
        kind: 'classic-round', round: 1, discovery: 'completed',
      }],
    })
    store.applyFrame({
      kind: 'run',
      run: {
        runId: 'run-1', runDir, sessionDir, status: 'completed',
        workflow: 'vliw-bundle-packing-optimization', scriptHash: 'sha256:abc',
        currentPhase: 'Report',
        phases: [
          {
            title: 'Author', index: 0, status: 'completed',
            calls: [
              { seq: 1, callId: 'author/a', label: 'pack-scalar', kind: 'agent', status: 'completed' },
              { seq: 2, callId: 'author/b', label: 'simd-batch', kind: 'agent', status: 'completed' },
              { seq: 3, callId: 'author/c', label: 'simd-pipelined', kind: 'agent', status: 'completed' },
            ],
          },
          { title: 'Review', index: 1, status: 'completed', calls: [] },
        ],
        totals: { calls: 3, completed: 3, failed: 0, tokens: 1000 },
        result: {
          stage: 'awaiting_host_verification', selectedCandidateId: 'simd-batch-v1',
          expectedCycles: 2140, estimatedSpeedup: 69.03, measuredSpeedup: null,
          candidates: [
            { id: 'pack-scalar-v1', expectedCycles: 8700 },
            { id: 'simd-batch-v1', expectedCycles: 2140 },
          ],
        },
      },
    })
    store.selectClassic(sessionDir)
    store.setClassicDetail(sessionDir, {
      session_id: '20260821-134926', session_dir: sessionDir, current_round: 1,
      steps: [
        { id: 'dispatch', status: 'completed' },
        { id: 'measurement', status: 'pending' },
        { id: 'decision', status: 'pending' },
      ],
      selection: { status: 'selected', workflow: 'vliw-bundle-packing-optimization', rejectedCount: 1 },
      authoring: { status: 'saved', files: [] },
      validation: { status: 'passed', checks: [] },
      dispatch: { status: 'completed', runDir, runtimeStatus: 'completed' },
      rounds: [
        {
          number: 1,
          workflow: 'vliw-bundle-packing-optimization',
          workflow_origin: 'catalog',
          candidate_id: 'simd-batch-v1',
          host_verdict: 'pass',
          measurement: {
            candidate_cycles: 2130, candidate_speedup: 69.35868544600939,
            best_improved: true,
          },
          decision: 'CONTINUE',
        },
        {
          number: 2,
          workflow: 'level-aware-gather-kernel-optimization',
          workflow_origin: 'authored',
          candidate_id: 'level-aware-gather-r2',
          host_verdict: 'fail',
          failure_kind: 'correctness',
          estimate: { cycles: 2120, speedup: 69.68 },
          decision: 'STALLED',
        },
      ],
      workflow: {
        name: 'vliw-bundle-packing-optimization',
        description: 'Pack independent engine slots and vectorize VLEN=8 batches.',
        whenToUse: 'Custom Python VLIW simulators.',
        topology: 'pipeline',
        phases: [
          { title: 'Analyze', detail: 'Find legal bundles.' },
          { title: 'Generate', detail: 'Emit the Session-local candidate.' },
          { title: 'Report', detail: 'Return candidate and estimate.' },
        ],
        requiredArgs: ['kernel_path'], languages: ['python_reference'], backends: ['python'],
        integrationPatterns: ['custom_simulator'], rationale: 'Hash-verified dispatch envelope.',
        source: 'return { best_kernel_code }',
      },
    })
    const loadRun = vi.fn(() => Promise.resolve())
    const loadCallDetail = vi.fn(async (targetRunDir: string, callId: string) => {
      store.setCallDetail(targetRunDir, callId, {
        callId,
        runner: 'codex-exec',
        threadId: 'thread-123',
        model: null,
        isolation: 'fresh-process',
        messages: [{ id: 'm1', text: 'candidate analysis' }],
        activities: [{ id: 't1', kind: 'tool', label: 'node_repl/js', status: 'completed' }],
        usage: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 4, totalTokens: 16 },
        truncated: false,
      })
    })
    const props = {
      t: makeTranslate(zh, commonZh), store,
      currentWorkspace: '/work/current',
      refresh: vi.fn(() => Promise.resolve()),
      loadRun,
      loadCallDetail,
      loadClassic: vi.fn(() => Promise.resolve()),
      start: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve()),
    } as unknown as Parameters<typeof KersorView>[0]
    render(<KersorView {...props} />)

    expect(await screen.findByRole('tree', { name: 'KerSor 执行树' })).toBeTruthy()
    expect(screen.getAllByText('20260821-134926 · R01 · vliw-bundle-packing-optimization').length).toBeGreaterThan(0)
    expect(screen.getByText('Workflow 已完成 · Session 等待 Host 验证')).toBeTruthy()
    expect(screen.getAllByText('非当前对话工作区').length).toBeGreaterThan(0)
    expect(screen.getByText('3 个并行调用')).toBeTruthy()
    expect(screen.getByText('Host 验证')).toBeTruthy()
    expect(screen.getByText('候选所有权')).toBeTruthy()
    expect(screen.getAllByText('Measurement').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Decision').length).toBeGreaterThan(0)
    expect(screen.getAllByText('vliw-bundle-packing-optimization').length).toBeGreaterThan(0)
    expect(screen.getByRole('tree', { name: '所选 Workflow 拓扑' })).toBeTruthy()
    expect(screen.getByText('最佳正确结果：13,358 cycles')).toBeTruthy()
    expect(screen.getByText('本 Session：14,415 → 13,358 · 1.08x')).toBeTruthy()
    expect(screen.getByText('全链路：147,734 → 13,358 · 11.06x')).toBeTruthy()
    expect(screen.getByText('Workflow 创作：已用 1/3')).toBeTruthy()
    expect(screen.getByRole('tree', { name: 'KerSor 逐轮实验树' })).toBeTruthy()
    expect(screen.getByText('晋升为 best')).toBeTruthy()
    expect(screen.getByText('候选正确性失败')).toBeTruthy()
    expect(screen.getByText('估算未计入结果')).toBeTruthy()
    expect(screen.getByText('路由无解 → Author → Seal → Validate → Catalog → Reselect')).toBeTruthy()
    expect(screen.getByText('Analyze')).toBeTruthy()
    expect(screen.getByText('Generate')).toBeTruthy()
    expect(screen.getByText('Report')).toBeTruthy()
    expect(screen.getAllByText('pack-scalar').length).toBeGreaterThan(0)
    expect(screen.getAllByText('simd-batch-v1').length).toBeGreaterThan(0)
    expect(screen.getByText('69.03x 预估')).toBeTruthy()
    store.setRunResult(runDir, {
      stage: 'host_verified', selectedCandidateId: 'simd-batch-v1',
      expectedCycles: 2140, measuredCycles: 2130,
      estimatedSpeedup: 69.03, measuredSpeedup: 69.35868544600939,
      candidates: [
        { id: 'pack-scalar-v1', expectedCycles: 8700 },
        { id: 'simd-batch-v1', expectedCycles: 2140 },
      ],
    })
    expect((await screen.findAllByText('2,130 cycles 实测')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('69.36x 实测').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /simd-batch/ }))
    await waitFor(() => { expect(loadCallDetail).toHaveBeenCalledWith(runDir, 'author/b') })
    expect(screen.getByText('Codex exec')).toBeTruthy()
    expect(screen.getByText('thread-123')).toBeTruthy()
    expect(screen.getByText('candidate analysis')).toBeTruthy()
    expect(screen.getByText('node_repl/js')).toBeTruthy()
    expect(store.selectedRunDir).toBe(runDir)
  })

  it('preserves an explicit Session selection when that Session has no runtime run', async () => {
    const store = new KersorViewerStore()
    const sessionDir = '/work/current/.kersor/fresh29'
    store.setSnapshot({
      ...EMPTY_SNAPSHOT,
      classic: {
        source: { state: 'healthy' },
        sessions: [{
          session_id: 'fresh29', session_dir: sessionDir, storage_kind: 'v2',
          lifecycle: 'stalled', status: 'terminal-stalled', health: 'terminal',
          current_round: 6, max_workflows: 6, stop_reason: 'execution_budget_exhausted',
          warningCount: 0,
        }],
      },
      runs: [{
        runId: 'unrelated-run', runDir: '/work/other/.kersor/old/run-1',
        sessionDir: '/work/other/.kersor/old', root: '/work/other/.kersor',
        kind: 'classic-round', round: 1, discovery: 'completed',
      }],
    })
    const loadClassic = vi.fn(async (target: string) => {
      store.setClassicDetail(target, {
        session_id: 'fresh29', session_dir: target, current_round: 6,
        steps: [{ id: 'decision', status: 'completed' }],
        selection: { status: 'selected', rejectedCount: 1 },
        authoring: { status: 'saved', files: [] },
        validation: { status: 'passed', checks: [] },
        dispatch: { status: 'failed' },
        rounds: [{ number: 6, host_verdict: 'fail', failure_kind: 'correctness' }],
      })
    })
    const props = {
      t: makeTranslate(zh, commonZh), store,
      currentWorkspace: '/work/current',
      refresh: vi.fn(() => Promise.resolve()),
      loadRun: vi.fn(() => Promise.resolve()),
      loadCallDetail: vi.fn(() => Promise.resolve()),
      loadClassic,
      start: vi.fn(() => Promise.resolve()),
      stop: vi.fn(() => Promise.resolve()),
    } as unknown as Parameters<typeof KersorView>[0]
    render(<KersorView {...props} />)

    fireEvent.click(await screen.findByRole('button', { name: '展开 Session 详情' }))

    await waitFor(() => { expect(store.selectedClassicSessionDir).toBe(sessionDir) })
    expect(store.selectedRunDir).toBeUndefined()
    expect(await screen.findByRole('tree', { name: 'KerSor 逐轮实验树' })).toBeTruthy()
    expect(screen.queryByText('unrelated-run')).toBeNull()
  })
})
