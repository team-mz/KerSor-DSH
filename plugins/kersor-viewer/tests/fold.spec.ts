// The fold: how a KerSor events.jsonl stream becomes the panel's view model —
// phase buckets in execution order, call status machine, loop revisits,
// transaction rollback marks, and terminal totals.

import { describe, expect, it } from 'vitest'
import { applyWorkflowResult, createRunView, foldEvent, type KersorEvent, type KersorRunView } from '../src/fold.ts'

function events(...list: Array<Record<string, unknown>>): KersorEvent[] {
  return list.map((record, index) => ({ ts: `2026-08-14T10:00:${String(index).padStart(2, '0')}Z`, ...record }) as KersorEvent)
}

function foldAll(view: KersorRunView, list: KersorEvent[]): KersorRunView {
  for (const event of list) foldEvent(view, event)
  return view
}

describe('run lifecycle', () => {
  it('omits absent optional result fields at the JSON RPC boundary', () => {
    const view = createRunView('run', '/runs/run', '/sessions/session')
    applyWorkflowResult(view, {
      stage: 'estimated', verification: 'passed', failureKind: 'infrastructure',
      selectedCandidateId: 'old', expectedCycles: 10, measuredBaselineCycles: 12,
      measuredCycles: 9, estimatedSpeedup: 2, incumbentCycles: 8,
      incumbentSpeedup: 3, bestImproved: false, candidates: [],
    })
    applyWorkflowResult(view, { measuredSpeedup: 2.5, candidates: [] })

    expect(view).toMatchObject({ measuredSpeedup: 2.5, candidates: [] })
    expect(Object.hasOwn(view, 'candidateStage')).toBe(false)
    expect(Object.hasOwn(view, 'verification')).toBe(false)
    expect(Object.hasOwn(view, 'failureKind')).toBe(false)
    expect(Object.hasOwn(view, 'selectedCandidateId')).toBe(false)
    expect(Object.hasOwn(view, 'expectedCycles')).toBe(false)
    expect(Object.hasOwn(view, 'measuredBaselineCycles')).toBe(false)
    expect(Object.hasOwn(view, 'measuredCycles')).toBe(false)
    expect(Object.hasOwn(view, 'estimatedSpeedup')).toBe(false)
    expect(Object.hasOwn(view, 'incumbentCycles')).toBe(false)
    expect(Object.hasOwn(view, 'incumbentSpeedup')).toBe(false)
    expect(Object.hasOwn(view, 'bestImproved')).toBe(false)
  })

  it('starts unknown, then running on workflow.started, terminal on workflow.completed', () => {
    const view = createRunView('r1', '/runs/r1', '/sessions/s1')
    expect(view.status).toBe('unknown')
    foldAll(view, events(
      { type: 'workflow.started', script: '/wf.js' },
    ))
    expect(view.status).toBe('running')
    expect(view.startedTs).toBe('2026-08-14T10:00:00Z')
    foldAll(view, events(
      { type: 'workflow.completed', calls: 1, usage: { total_tokens: 42 } },
    ))
    expect(view.status).toBe('completed')
    expect(view.totals.tokens).toBe(42)
  })

  it('records the failure message on workflow.failed', () => {
    const view = createRunView('r1', '/runs/r1', '/sessions/s1')
    foldAll(view, events(
      { type: 'workflow.started' },
      { type: 'workflow.failed', error: { message: 'boom' } },
    ))
    expect(view.status).toBe('failed')
    expect(view.error).toBe('boom')
  })
})

describe('phase and call folding', () => {
  it('creates phase buckets in order and routes calls by phase+call_id', () => {
    const view = createRunView('r1', '/runs/r1', '/sessions/s1')
    foldAll(view, events(
      { type: 'workflow.started' },
      { type: 'phase.changed', phase: 'Setup' },
      { type: 'agent.queued', seq: 0, call_id: 'setup/read-spec/0', phase: 'Setup', label: 'read-spec' },
      { type: 'agent.started', seq: 0, call_id: 'setup/read-spec/0', phase: 'Setup', label: 'read-spec' },
      { type: 'phase.changed', phase: 'Generate' },
      { type: 'agent.queued', seq: 1, call_id: 'generate/gen-1-0/1', phase: 'Generate', label: 'gen-1-0' },
      { type: 'agent.started', seq: 1, call_id: 'generate/gen-1-0/1', phase: 'Generate', label: 'gen-1-0' },
      { type: 'agent.completed', seq: 0, call_id: 'setup/read-spec/0', phase: 'Setup', label: 'read-spec', usage: { total_tokens: 10 } },
      { type: 'agent.completed', seq: 1, call_id: 'generate/gen-1-0/1', phase: 'Generate', label: 'gen-1-0', usage: { total_tokens: 20 } },
    ))
    expect(view.phases.map(phase => phase.title)).toEqual(['Setup', 'Generate'])
    expect(view.phases[0]!.calls[0]!.status).toBe('completed')
    expect(view.phases[0]!.calls[0]!.tokens).toBe(10)
    expect(view.phases[1]!.calls[0]!.status).toBe('completed')
    expect(view.currentPhase).toBe('Generate')
    expect(view.totals).toEqual({ calls: 2, completed: 2, failed: 0, tokens: 30 })
  })

  it('revisiting a phase title opens a fresh bucket (loop rounds)', () => {
    const view = createRunView('r1', '/runs/r1', '/sessions/s1')
    foldAll(view, events(
      { type: 'phase.changed', phase: 'Select' },
      { type: 'agent.queued', seq: 0, call_id: 'select/s-1/0', phase: 'Select', label: 's-1' },
      { type: 'phase.changed', phase: 'Generate' },
      { type: 'phase.changed', phase: 'Select' },
      { type: 'agent.queued', seq: 1, call_id: 'select/s-2/1', phase: 'Select', label: 's-2' },
    ))
    expect(view.phases.map(phase => phase.title)).toEqual(['Select', 'Generate', 'Select'])
    // Leaving a phase closes its bucket; the reopened Select is the running one.
    expect(view.phases.map(phase => phase.status)).toEqual(['completed', 'completed', 'running'])
    // The second Select's call lands in the LAST matching bucket.
    expect(view.phases[2]!.calls.map(call => call.label)).toEqual(['s-2'])
  })

  it('folds agent failure with error message and failed count', () => {
    const view = createRunView('r1', '/runs/r1', '/sessions/s1')
    foldAll(view, events(
      { type: 'phase.changed', phase: 'P' },
      { type: 'agent.queued', seq: 0, call_id: 'p/x/0', phase: 'P', label: 'x' },
      { type: 'agent.started', seq: 0, call_id: 'p/x/0', phase: 'P', label: 'x' },
      { type: 'agent.failed', seq: 0, call_id: 'p/x/0', phase: 'P', label: 'x', error: { message: 'denied' } },
    ))
    const call = view.phases[0]!.calls[0]!
    expect(call.status).toBe('failed')
    expect(call.error).toBe('denied')
    expect(view.totals.failed).toBe(1)
  })

  it('marks rolled-back transactions and folds evaluation calls', () => {
    const view = createRunView('r1', '/runs/r1', '/sessions/s1')
    foldAll(view, events(
      { type: 'phase.changed', phase: 'Evaluate' },
      { type: 'agent.queued', seq: 0, call_id: 'evaluate/w/0', phase: 'Evaluate', label: 'w' },
      { type: 'agent.transaction.started', seq: 0, call_id: 'evaluate/w/0', phase: 'Evaluate', label: 'w', transaction: { status: 'active' } },
      { type: 'agent.transaction.rolled-back', seq: 0, call_id: 'evaluate/w/0', phase: 'Evaluate', label: 'w', transaction: { status: 'rolled-back' } },
      { type: 'evaluation.queued', seq: 1, call_id: 'evaluate/bench/1', phase: 'Evaluate', label: 'bench' },
      { type: 'evaluation.completed', seq: 1, call_id: 'evaluate/bench/1', phase: 'Evaluate', label: 'bench', protocol: 'sol-execbench-v1' },
    ))
    expect(view.phases[0]!.calls[0]!.rolledBack).toBe(true)
    const bench = view.phases[0]!.calls[1]!
    expect(bench.kind).toBe('evaluation')
    expect(bench.status).toBe('completed')
  })

  it('materializes a row when terminal events arrive without queued (mid-run attach)', () => {
    const view = createRunView('r1', '/runs/r1', '/sessions/s1')
    foldAll(view, events(
      { type: 'phase.changed', phase: 'Setup' },
      { type: 'agent.completed', seq: 0, call_id: 'setup/x/0', phase: 'Setup', label: 'x', usage: { total_tokens: 5 } },
    ))
    expect(view.phases[0]!.calls[0]!.status).toBe('completed')
    expect(view.totals.calls).toBe(1)
  })

  it('ignores unrelated event types without touching the view', () => {
    const view = createRunView('r1', '/runs/r1', '/sessions/s1')
    foldAll(view, events(
      { type: 'workflow.log', phase: 'P', message: 'hello' },
      { type: 'agent.admission.accepted', seq: 0, call_id: 'c', phase: 'P', label: 'l' },
      { type: 'parallel.task-failed', phase: 'P', index: 1, error: { message: 'x' } },
    ))
    expect(view.phases).toEqual([])
    expect(view.totals.calls).toBe(0)
  })

  it('projects candidate creation and reviewer selection from bounded Workflow log records', () => {
    const view = createRunView('r1', '/runs/r1', '/sessions/s1')
    foldAll(view, events(
      {
        type: 'workflow.log', phase: 'Author',
        message: 'vliw-pack: candidate pack-scalar-v1 accepted, expected_cycles=8700, tag=x',
      },
      {
        type: 'workflow.log', phase: 'Author',
        message: 'vliw-pack: candidate simd-batch-v1 accepted, expected_cycles=2140, tag=y',
      },
      {
        type: 'workflow.log', phase: 'Review',
        message: 'vliw-pack: selected simd-batch-v1 (reviewer selection)',
      },
    ))
    expect(view.result).toEqual({
      selectedCandidateId: 'simd-batch-v1',
      expectedCycles: 2140,
      candidates: [
        { id: 'pack-scalar-v1', expectedCycles: 8700 },
        { id: 'simd-batch-v1', expectedCycles: 2140 },
      ],
    })
  })
})
