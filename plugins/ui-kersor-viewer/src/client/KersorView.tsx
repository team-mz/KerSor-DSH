/** KerSor conversation view: Session inventory with live Workflow progress. */

import { useEffect, useState, useSyncExternalStore } from 'react'
import { IconChevronRightOutline14, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  KersorBaselineAction,
  KersorCallDetailView,
  KersorClassicGate,
  KersorClassicSessionDetail,
  KersorClassicRound,
  KersorClassicStopReason,
  KersorClassicStepId,
  KersorClassicStepStatus,
  KersorCallView,
  KersorDiagnosticIssue,
  KersorPhaseView,
  KersorRunStatus,
  KersorRunView,
  KersorWorkflowResultView,
  KersorViewerSnapshot,
} from '@deepseek-ai/dsh-kersor-viewer/types'
import type { KersorClassicHealth, KersorClassicLifecycle, KersorClassicSession } from '@deepseek-ai/dsh-kersor-viewer/types'
import type { KersorTaskId } from '@deepseek-ai/dsh-kersor/types'
import type { KersorRunRow, KersorViewerState } from './store.ts'
import type { KersorViewerKey } from './locales.ts'
import type { KersorViewFace } from './slots.ts'
import { visibleFitConfidence } from './readiness.ts'
import css from './KersorView.module.css'

/** Full view props composed by the conversation view slot. */
export type KersorViewProps =
  PropsRuntime<'conversation.view'> & InjectFace<KersorViewFace> & PropsLocale<'kersorViewer'>

const RUN_STATUS_KEYS = {
  running: 'run.active',
  completed: 'run.completed',
  failed: 'run.failed',
  unknown: 'run.unknown',
} as const satisfies Record<KersorRunStatus, KersorViewerKey>

const CALL_STATUS_KEYS = {
  queued: 'call.queued',
  running: 'call.running',
  completed: 'call.completed',
  failed: 'call.failed',
} as const satisfies Record<KersorCallView['status'], KersorViewerKey>

function runDotState(status: KersorRunStatus): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'completed': return 'done'
    case 'failed': return 'error'
    /* v8 ignore next -- KersorRunStatus is closed and every variant is handled above. */
    default: return 'warning'
  }
}

function callDotState(status: KersorCallView['status']): StateDotState {
  switch (status) {
    case 'queued': return 'warning'
    case 'running': return 'ongoing'
    case 'completed': return 'done'
    case 'failed': return 'error'
  }
}

function phaseDotState(status: KersorPhaseView['status']): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'completed': return 'done'
    case 'failed': return 'error'
  }
}

const CLASSIC_HEALTH_KEYS = {
  active: 'session.health.active',
  stale: 'session.health.stale',
  needs_resume: 'session.health.needsResume',
  terminal: 'session.health.terminal',
  unknown: 'session.health.unknown',
} as const satisfies Record<KersorClassicHealth, KersorViewerKey>

const CLASSIC_STEP_KEYS = {
  setup: 'detail.step.setup',
  baseline: 'detail.step.baseline',
  profile: 'detail.step.profile',
  selection: 'detail.step.selection',
  authoring: 'detail.step.authoring',
  validation: 'detail.step.validation',
  dispatch: 'detail.step.dispatch',
  measurement: 'detail.step.measurement',
  decision: 'detail.step.decision',
} as const satisfies Record<KersorClassicStepId, KersorViewerKey>

const CLASSIC_STEP_STATUS_KEYS = {
  pending: 'step.pending',
  active: 'step.active',
  completed: 'step.completed',
  failed: 'step.failed',
} as const satisfies Record<KersorClassicStepStatus, KersorViewerKey>

function classicStepDotState(status: KersorClassicStepStatus): StateDotState {
  switch (status) {
    case 'pending': return 'warning'
    case 'active': return 'ongoing'
    case 'completed': return 'done'
    case 'failed': return 'error'
  }
}

function classicDotState(health: KersorClassicHealth, lifecycle: KersorClassicLifecycle): StateDotState {
  if (health === 'active') return 'ongoing'
  if (health !== 'terminal') return 'warning'
  switch (lifecycle) {
    case 'completed': return 'done'
    case 'stalled': return 'error'
    case 'cancelled': return 'warning'
    case 'active': return 'warning'
  }
}

function speedup(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : value.toFixed(2)
}

const GATE_KEYS = {
  pass: 'session.gate.pass',
  fail: 'session.gate.fail',
  pending: 'session.gate.pending',
  not_required: 'session.gate.notRequired',
} as const satisfies Record<KersorClassicGate, KersorViewerKey>

const BASELINE_ACTION_KEYS = {
  init: 'session.baselineAction.init',
  record_verify: 'session.baselineAction.recordVerify',
  new_session: 'session.baselineAction.newSession',
} as const satisfies Record<KersorBaselineAction, KersorViewerKey>

const STOP_REASON_KEYS = {
  target_met: 'detail.stop.targetMet',
  execution_budget_exhausted: 'detail.stop.executionBudget',
  selection_stalled: 'detail.stop.selectionStalled',
  authoring_budget_exhausted: 'detail.stop.authoringBudget',
  cancelled: 'detail.stop.cancelled',
  single_run_complete: 'detail.stop.singleRun',
} as const satisfies Record<KersorClassicStopReason, KersorViewerKey>

const FAILURE_KIND_KEYS = {
  correctness: 'detail.round.failure.correctness',
  benchmark: 'detail.round.failure.benchmark',
  infrastructure: 'detail.round.failure.infrastructure',
} as const satisfies Record<NonNullable<KersorClassicRound['failure_kind']>, KersorViewerKey>

function displayTime(value: string): string | undefined {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function roundDotState(round: KersorClassicRound): StateDotState {
  if (round.host_verdict === 'fail') return 'error'
  if (round.host_verdict === 'pending') return 'ongoing'
  return round.measurement?.best_improved === true ? 'done' : 'warning'
}

function RoundHistory({ rounds, stopReason, t }: {
  readonly rounds: readonly KersorClassicRound[]
  readonly stopReason: KersorClassicStopReason | null | undefined
  readonly t: KersorViewProps['t']
}): React.JSX.Element | null {
  if (rounds.length === 0) return null
  return (
    <section className={css.roundHistory} aria-label={t('detail.rounds')}>
      <span className={css.detailTitle}>{t('detail.rounds')}</span>
      <ol className={css.roundTree} role="tree" aria-label={t('detail.roundTree')}>
        {rounds.map(round => (
          <li
            key={round.number}
            className={css.roundNode}
            role="treeitem"
            data-host-verdict={round.host_verdict}
            data-promoted={round.measurement?.best_improved ?? false}
          >
            <div className={css.roundHead}>
              <StateDot state={roundDotState(round)} />
              <strong>{t('detail.round.number', { round: round.number })}</strong>
              <span className={css.roundWorkflow}>{round.workflow ?? t('session.noWorkflow')}</span>
              {round.workflow_origin === 'authored'
                ? <span className={css.authoredBadge}>{t('detail.round.authored')}</span>
                : null}
              <span className={css.roundVerdict}>{t(`detail.round.verdict.${round.host_verdict}`)}</span>
            </div>
            <div className={css.roundFacts}>
              {round.candidate_id !== undefined
                ? <span className={css.mono}>{t('detail.round.candidate', { candidate: round.candidate_id })}</span>
                : null}
              {round.measurement?.candidate_cycles !== undefined
                ? <span data-measurement="measured">{t('detail.round.measuredCycles', {
                  cycles: round.measurement.candidate_cycles.toLocaleString(),
                })}</span>
                : null}
              {round.measurement?.candidate_speedup !== undefined
                ? <span data-measurement="measured">{t('detail.round.measuredSpeedup', {
                  speedup: speedup(round.measurement.candidate_speedup),
                })}</span>
                : null}
              {round.measurement?.best_improved === true
                ? <span className={css.promotedBadge}>{t('detail.round.promoted')}</span>
                : round.host_verdict === 'pass'
                  ? <span>{t('detail.round.retained')}</span>
                  : null}
              {round.failure_kind !== undefined
                ? <span className={css.failureBadge}>{t(FAILURE_KIND_KEYS[round.failure_kind])}</span>
                : null}
              {round.estimate?.cycles !== undefined
                ? <span data-measurement="estimated">{t('detail.round.estimatedCycles', {
                  cycles: round.estimate.cycles.toLocaleString(),
                })}</span>
                : null}
              {round.estimate?.speedup !== undefined
                ? <span data-measurement="estimated">{t('detail.round.estimatedSpeedup', {
                  speedup: speedup(round.estimate.speedup),
                })}</span>
                : null}
              {round.host_verdict === 'fail' && round.estimate !== undefined
                ? <span className={css.excludedBadge}>{t('detail.round.estimateExcluded')}</span>
                : null}
            </div>
            {round.workflow_origin === 'authored'
              ? <div className={css.authoringChain}>{t('detail.round.authoringChain')}</div>
              : null}
            {round.decision !== undefined
              ? <div className={css.roundDecision}>{round.decision}</div>
              : null}
          </li>
        ))}
        {stopReason !== null && stopReason !== undefined
          ? (
            <li className={css.stopNode} role="treeitem" data-stop-reason={stopReason}>
              <StateDot state={stopReason === 'target_met' ? 'done' : 'warning'} />
              <strong>{t('detail.stop')}</strong>
              <span>{t(STOP_REASON_KEYS[stopReason])}</span>
            </li>
          )
          : null}
      </ol>
    </section>
  )
}

function ClassicSessionDetail({ session, detail, t }: {
  readonly session: KersorClassicSession
  readonly detail: KersorClassicSessionDetail
  readonly t: KersorViewProps['t']
}): React.JSX.Element {
  const design = detail.workflow ?? detail.authoring.design
  const phases = design?.phases ?? []
  const lineage = session.cycle_lineage
  const latestFailureKind = detail.rounds.at(-1)?.failure_kind
  return (
    <div className={css.classicDetail}>
      <section className={css.outcomeSummary} data-stop-reason={session.stop_reason ?? undefined}>
        <div className={css.outcomeHead}>
          <span className={css.detailTitle}>{t('detail.outcome')}</span>
          {session.stop_reason !== null && session.stop_reason !== undefined
            ? <span>{t(STOP_REASON_KEYS[session.stop_reason])}</span>
            : <span>{t(CLASSIC_HEALTH_KEYS[session.health])}</span>}
        </div>
        <div className={css.outcomeMetrics}>
          {lineage?.best_cycles !== undefined
            ? <strong>{t('detail.bestCycles', { cycles: lineage.best_cycles.toLocaleString() })}</strong>
            : null}
          {lineage?.session_baseline_cycles !== undefined && lineage.best_cycles !== undefined
            ? <span>{t('detail.sessionLineage', {
              baseline: lineage.session_baseline_cycles.toLocaleString(),
              best: lineage.best_cycles.toLocaleString(),
              speedup: lineage.session_speedup === undefined ? '—' : speedup(lineage.session_speedup),
            })}</span>
            : null}
          {lineage?.task_baseline_cycles !== undefined && lineage.best_cycles !== undefined
            ? <span>{t('detail.overallLineage', {
              baseline: lineage.task_baseline_cycles.toLocaleString(),
              best: lineage.best_cycles.toLocaleString(),
              speedup: lineage.overall_speedup === undefined ? '—' : speedup(lineage.overall_speedup),
            })}</span>
            : null}
          {session.allow_workflow_authoring === true
            ? <span>{t('detail.authoringBudget', {
              used: session.workflow_authoring_used ?? 0,
              total: session.workflow_authoring_budget ?? '—',
            })}</span>
            : null}
        </div>
      </section>
      <RoundHistory rounds={detail.rounds} stopReason={session.stop_reason} t={t} />
      <ol className={css.timeline} aria-label={t('detail.timeline')}>
        {detail.steps.map(step => (
          <li key={step.id} className={css.timelineStep} data-step-status={step.status}>
            <StateDot state={classicStepDotState(step.status)} />
            <span>{t(CLASSIC_STEP_KEYS[step.id])}</span>
          </li>
        ))}
      </ol>
      <div className={css.detailGrid}>
        <section className={css.detailSection}>
          <span className={css.detailTitle}>{t('detail.selection')}</span>
          <span>{t(`detail.selection.${detail.selection.status}`)}</span>
          {detail.selection.workflow !== undefined
            ? <span className={css.mono}>{detail.selection.workflow}</span>
            : null}
          {detail.selection.reason !== undefined
            ? <span className={css.detailReason}>{detail.selection.reason}</span>
            : null}
          <span>{t('detail.rejected', { count: detail.selection.rejectedCount })}</span>
        </section>
        <section className={css.detailSection}>
          <span className={css.detailTitle}>{t('detail.authoring')}</span>
          <span>{t(`detail.authoring.${detail.authoring.status}`)}</span>
          {detail.authoring.omittedReason !== undefined
            ? <span className={css.detailError}>{t('detail.omitted', { reason: detail.authoring.omittedReason })}</span>
            : null}
        </section>
        <section className={css.detailSection}>
          <span className={css.detailTitle}>{t('detail.validation')}</span>
          <span>{t(`detail.validation.${detail.validation.status}`)}</span>
          {detail.validation.checks.length > 0
            ? (
              <ul className={css.checks}>
                {detail.validation.checks.map(check => (
                  <li key={check.name} data-check-passed={check.passed}>
                    {check.passed ? '✓' : '×'} {check.name}
                  </li>
                ))}
              </ul>
            )
            : null}
        </section>
        <section className={css.detailSection}>
          <span className={css.detailTitle}>{t('detail.dispatch')}</span>
          <span>{detail.dispatch.status === 'failed'
            && latestFailureKind !== undefined
            ? t(FAILURE_KIND_KEYS[latestFailureKind])
            : t(`detail.dispatch.${detail.dispatch.status}`)}</span>
          {detail.dispatch.runtimeStatus !== undefined
            ? <span className={css.mono}>{detail.dispatch.runtimeStatus}</span>
            : null}
          {detail.dispatch.runDir !== undefined
            ? <span className={css.detailPath} title={detail.dispatch.runDir}>{detail.dispatch.runDir}</span>
            : null}
        </section>
      </div>
      {detail.authoring.files.length > 0
        ? (
          <div className={css.artifacts}>
            {detail.authoring.files.map(file => (
              <span key={file.name} title={file.sha256}>
                <span className={css.mono}>{file.name}</span> · {file.bytes} B · {file.sha256.slice(0, 18)}…
              </span>
            ))}
          </div>
        )
        : null}
      {design !== undefined
        ? (
          <div className={css.design}>
            <span className={css.detailTitle}>{t('detail.workflowDesign')}</span>
            <div className={css.designMeta}>
              {design.name !== undefined ? <span className={css.mono}>{design.name}</span> : null}
              {design.technique !== undefined ? <span>{design.technique}</span> : null}
              {design.methodCategory !== undefined ? <span>{design.methodCategory}</span> : null}
              {design.topology !== undefined ? <span>{design.topology}</span> : null}
              {design.languages.map(value => <span key={`language:${value}`}>{value}</span>)}
              {design.backends.map(value => <span key={`backend:${value}`}>{value}</span>)}
              {design.integrationPatterns.map(value => <span key={`integration:${value}`}>{value}</span>)}
            </div>
            {design.description !== undefined
              ? <p className={css.designText}>{design.description}</p>
              : null}
            {phases.length > 0
              ? (
                <div className={css.workflowTree} role="tree" aria-label={t('detail.workflowTree')}>
                  <div className={css.workflowRoot} role="treeitem" aria-expanded="true">
                    <StateDot state={detail.dispatch.status === 'failed'
                      ? 'error'
                      : detail.dispatch.status === 'completed'
                        ? 'done'
                        : detail.dispatch.status === 'running'
                          ? 'ongoing'
                          : 'warning'} />
                    <span className={css.mono}>{design.name ?? detail.selection.workflow ?? 'Workflow'}</span>
                  </div>
                  <div className={css.workflowBranches} role="group">
                    {phases.map((phase, index) => (
                      <div className={css.workflowPhase} role="treeitem" key={`${index}:${phase.title}`}>
                        <span className={css.workflowBranch} aria-hidden="true">{index === phases.length - 1 ? '└' : '├'}</span>
                        <span className={css.workflowPhaseIndex}>{index + 1}</span>
                        <span className={css.workflowPhaseBody}>
                          <strong>{phase.title}</strong>
                          <span>{phase.detail}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )
              : null}
            {design.requiredArgs.length > 0
              ? <div className={css.requiredArgs}>{t('detail.requiredArgs')}: <span className={css.mono}>{design.requiredArgs.join(', ')}</span></div>
              : null}
            <details className={css.designDisclosure}>
              <summary>{t('detail.rationale')}</summary>
              <pre>{design.rationale}</pre>
            </details>
            {design.whenToUse !== undefined
              ? (
                <details className={css.designDisclosure}>
                  <summary>{t('detail.whenToUse')}</summary>
                  <pre>{design.whenToUse}</pre>
                </details>
              )
              : null}
            <details className={css.designDisclosure}>
              <summary>{t('detail.source')}</summary>
              <pre>{design.source}</pre>
            </details>
          </div>
        )
        : <div className={css.detailNote}>{t('detail.sealRequired')}</div>}
    </div>
  )
}

function ClassicSessionRow({ session, selected, crossWorkspace, detail, loading, error, onToggle, t }: {
  readonly session: KersorClassicSession
  readonly selected: boolean
  readonly crossWorkspace: boolean
  readonly detail?: KersorClassicSessionDetail | undefined
  readonly loading: boolean
  readonly error?: string | undefined
  readonly onToggle: () => void
  readonly t: KersorViewProps['t']
}): React.JSX.Element {
  const round = session.current_round !== null && session.current_round !== undefined
    ? session.max_workflows !== null && session.max_workflows !== undefined
      ? t('session.round', { current: session.current_round, maximum: session.max_workflows })
      : t('session.roundOpen', { current: session.current_round })
    : undefined
  const languageBackend = session.kernel_language !== null && session.kernel_language !== undefined
    ? session.backend !== null && session.backend !== undefined
      ? `${session.kernel_language}/${session.backend}`
      : session.kernel_language
    : session.backend ?? undefined
  const details = [languageBackend, session.mode, session.storage_kind].filter(Boolean).join(' · ')
  const activity = session.last_activity_at !== null && session.last_activity_at !== undefined
    ? displayTime(session.last_activity_at)
    : undefined
  const fitConfidence = visibleFitConfidence(session)
  return (
    <li
      className={css.classicRow}
      data-session-health={session.health}
      data-session-lifecycle={session.lifecycle}
      data-expanded={selected}
    >
      <div className={css.classicHead}>
        <StateDot state={session.stop_reason === 'execution_budget_exhausted'
          ? 'warning'
          : classicDotState(session.health, session.lifecycle)} />
        <span className={css.sessionId} title={session.session_dir}>{session.session_id}</span>
        <span className={css.phaseBadge}>{t(CLASSIC_HEALTH_KEYS[session.health])}</span>
        {crossWorkspace ? <span className={css.workspaceBadge}>{t('session.otherWorkspace')}</span> : null}
        <button
          type="button"
          className={css.classicExpand}
          aria-expanded={selected}
          aria-label={selected ? t('detail.collapse') : t('detail.expand')}
          onClick={onToggle}
        >
          <IconChevronRightOutline14 />
        </button>
      </div>
      <div className={css.classicMetrics}>
        {round !== undefined ? <span>{round}</span> : null}
        {session.best_speedup !== null && session.best_speedup !== undefined
          ? <span data-target-met={session.target_met ?? undefined}>{t('session.best', { speedup: speedup(session.best_speedup) })}</span>
          : null}
        {session.target_speedup !== null && session.target_speedup !== undefined
          ? <span>{t('session.target', { speedup: speedup(session.target_speedup) })}</span>
          : null}
        <span>{session.phase ?? t('session.unknownPhase')}</span>
        {details.length > 0 ? <span>{details}</span> : null}
        {session.integration_pattern !== null && session.integration_pattern !== undefined
          ? <span className={css.routeBadge}>{session.integration_pattern}</span>
          : null}
        {session.allow_workflow_authoring === true
          ? <span className={css.authoringBadge}>{t('session.authoring', {
            used: session.workflow_authoring_used ?? 0,
            budget: session.workflow_authoring_budget ?? '—',
          })}</span>
          : null}
        {session.fresh_session != null
          ? <span className={css.gateBadge} data-gate={session.fresh_session}>{t('session.freshGate', {
            status: t(GATE_KEYS[session.fresh_session]),
          })}</span>
          : null}
        {session.allow_workflow_authoring === true && session.baseline_witness != null
          ? <span className={css.gateBadge} data-gate={session.baseline_witness}>{t('session.baselineGate', {
            status: t(GATE_KEYS[session.baseline_witness]),
          })}</span>
          : null}
        {session.allow_workflow_authoring === true && session.profile_evidence != null
          ? <span className={css.gateBadge} data-gate={session.profile_evidence}>{t('session.profileGate', {
            status: t(GATE_KEYS[session.profile_evidence]),
          })}</span>
          : null}
        {session.allow_workflow_authoring === true && session.profile_owner != null
          ? <span className={css.routeBadge} data-profile-owner={session.profile_owner}>{t('session.profileOwner', {
            owner: session.profile_owner,
          })}</span>
          : null}
        {session.allow_workflow_authoring === true && session.dsh_compatibility != null
          ? <span className={css.gateBadge} data-gate={session.dsh_compatibility}>{t('session.dshGate', {
            status: t(GATE_KEYS[session.dsh_compatibility]),
          })}</span>
          : null}
        {session.allow_workflow_authoring === true && session.candidate_ownership != null
          ? <span className={css.gateBadge} data-gate={session.candidate_ownership}>{t('session.ownershipGate', {
            status: t(GATE_KEYS[session.candidate_ownership]),
          })}</span>
          : null}
        {activity !== undefined ? <span>{t('session.lastActivity', { time: activity })}</span> : null}
      </div>
      {session.allow_workflow_authoring === true && session.baseline_next_action != null
        ? <div
          className={css.baselineAction}
          data-baseline-action={session.baseline_next_action}
          title={session.baseline_reason ?? undefined}
        >
          <span className={css.baselineActionLabel}>{t(BASELINE_ACTION_KEYS[session.baseline_next_action])}</span>
          {session.baseline_reason != null
            ? <span className={css.baselineActionReason}>{session.baseline_reason}</span>
            : null}
        </div>
        : null}
      {session.allow_workflow_authoring === true && session.profile_evidence === 'fail'
        && session.profile_reason != null
        ? <div className={css.profileBlock} data-profile-gate="fail" title={session.profile_reason}>
          <span className={css.profileBlockLabel}>{t('session.profileBlocked')}</span>
          <span className={css.profileBlockReason}>{session.profile_reason}</span>
        </div>
        : null}
      <div className={css.classicFoot}>
        <span className={css.workflowName}>
          {session.selection_status === 'stalled'
            ? t('session.selectorStalled')
            : session.workflow !== null && session.workflow !== undefined
              ? t('session.workflow', { workflow: session.workflow })
              : t('session.noWorkflow')}
        </span>
        {fitConfidence !== undefined
          ? <span className={css.fitBadge} data-fit-confidence={fitConfidence}>{t('session.fit', { confidence: fitConfidence })}</span>
          : null}
        {session.warningCount > 0
          ? <span className={css.warningCount}>{t('session.warnings', { count: session.warningCount })}</span>
          : null}
      </div>
      {session.decision !== null && session.decision !== undefined
        ? <div className={css.decisionReason} title={session.decision}>{session.decision}</div>
        : null}
      {selected && loading ? <div className={css.detailNote}>{t('detail.loading')}</div> : null}
      {selected && error !== undefined ? <div className={css.detailError}>{error}</div> : null}
      {selected && detail !== undefined ? <ClassicSessionDetail session={session} detail={detail} t={t} /> : null}
    </li>
  )
}

function durationSeconds(startedTs?: string, endedTs?: string): string | undefined {
  if (startedTs === undefined || endedTs === undefined) return undefined
  const start = Date.parse(startedTs)
  const end = Date.parse(endedTs)
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined
  return `${((end - start) / 1000).toFixed(1)}s`
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

function belongsToWorkspace(sessionDir: string, workspace: string | undefined): boolean {
  if (workspace === undefined || workspace.length === 0) return true
  return normalizedPath(sessionDir).startsWith(`${normalizedPath(workspace)}/.kersor/`)
}

function sessionName(sessionDir: string): string {
  return normalizedPath(sessionDir).split('/').at(-1) ?? sessionDir
}

function runDisplayLabel(
  row: KersorRunRow,
  session: KersorClassicSession | undefined,
): string {
  const round = row.round ?? session?.current_round ?? undefined
  const roundLabel = round === undefined ? row.runId : `R${String(round).padStart(2, '0')}`
  const workflow = row.view?.workflow ?? session?.workflow ?? row.runId
  return `${session?.session_id ?? sessionName(row.sessionDir)} · ${roundLabel} · ${workflow}`
}

function CallDetail({ detail, t }: {
  readonly detail: KersorCallDetailView
  readonly t: KersorViewProps['t']
}): React.JSX.Element {
  return (
    <div className={css.callDetail}>
      <div className={css.callDetailMeta}>
        <span>{detail.runner === 'codex-exec' ? t('call.runner.codex') : t('call.runner.unknown')}</span>
        <span>{t('call.model', { model: detail.model ?? t('call.modelUnknown') })}</span>
        {detail.modelRole != null ? <span>{t('call.modelRole', { role: detail.modelRole })}</span> : null}
        {detail.threadId !== undefined ? <span className={css.mono}>{detail.threadId}</span> : null}
        {detail.isolation !== undefined ? <span>{detail.isolation}</span> : null}
      </div>
      {detail.messages.length > 0
        ? (
          <div className={css.callMessages}>
            {detail.messages.map(message => <pre key={message.id}>{message.text}</pre>)}
          </div>
        )
        : <div className={css.detailNote}>{t('call.noMessages')}</div>}
      {detail.activities.length > 0
        ? (
          <ul className={css.callActivities}>
            {detail.activities.map(activity => (
              <li key={activity.id}>
                <span>{activity.kind === 'web-search' ? t('call.webSearch') : t('call.tool')}</span>
                <span className={css.mono}>{activity.label}</span>
                <span>{activity.status}</span>
              </li>
            ))}
          </ul>
        )
        : null}
      {detail.truncated ? <div className={css.detailNote}>{t('call.truncated')}</div> : null}
    </div>
  )
}

function CallTreeNode({
  call, selectedCandidateId, selected, detail, loading, error, onToggle, t,
}: {
  readonly call: KersorCallView
  readonly selectedCandidateId?: string
  readonly selected: boolean
  readonly detail?: KersorCallDetailView
  readonly loading: boolean
  readonly error?: string
  readonly onToggle: () => void
  readonly t: KersorViewProps['t']
}): React.JSX.Element {
  const duration = durationSeconds(call.startedTs, call.endedTs)
  const chosen = selectedCandidateId !== undefined && call.label.endsWith(selectedCandidateId)
  return (
    <li role="treeitem" aria-expanded={selected} className={css.callTreeItem} data-call-status={call.status}>
      <button type="button" className={css.treeNodeButton} onClick={onToggle} aria-label={t('call.open', { label: call.label })}>
        <StateDot state={callDotState(call.status)} />
        <span className={css.callLabel} title={call.callId}>{call.label}</span>
        {chosen ? <span className={css.selectedBadge}>{t('run.result.chosen')}</span> : null}
        <span className={css.callMeta}>
          {call.kind === 'evaluation' ? t('call.evaluation') : null}
          {call.rolledBack ? <span className={css.badge}>{t('call.rolledBack')}</span> : null}
          {duration !== undefined ? <span>{duration}</span> : null}
          {call.tokens !== undefined ? <span>{call.tokens.toLocaleString()} tk</span> : null}
        </span>
        <span className={css.callStatus}>{t(CALL_STATUS_KEYS[call.status])}</span>
        <IconChevronRightOutline14 />
      </button>
      {selected && loading ? <div className={css.detailNote}>{t('call.loading')}</div> : null}
      {selected && error !== undefined ? <div className={css.detailError}>{error}</div> : null}
      {selected && !loading && detail !== undefined ? <CallDetail detail={detail} t={t} /> : null}
    </li>
  )
}

function hostStepStatus(
  detail: KersorClassicSessionDetail | undefined,
  id: KersorClassicStepId,
): KersorClassicStepStatus {
  return detail?.steps.find(step => step.id === id)?.status ?? 'pending'
}

function gateStepStatus(gate: KersorClassicGate | null | undefined): KersorClassicStepStatus {
  if (gate === 'pass' || gate === 'not_required') return 'completed'
  if (gate === 'fail') return 'failed'
  return 'pending'
}

function HostVerificationTree({ session, detail, result, t }: {
  readonly session: KersorClassicSession | undefined
  readonly detail: KersorClassicSessionDetail | undefined
  readonly result: KersorWorkflowResultView | undefined
  readonly t: KersorViewProps['t']
}): React.JSX.Element | null {
  const waiting = result?.stage === 'awaiting_host_verification'
  const verified = result?.stage === 'host_verified'
  const measurement = verified ? 'completed' : hostStepStatus(detail, 'measurement')
  const decision = session?.lifecycle === 'completed' ? 'completed' : hostStepStatus(detail, 'decision')
  if (!waiting && !verified && measurement === 'pending' && decision === 'pending') return null
  const status: KersorClassicStepStatus = measurement === 'failed' || decision === 'failed'
    ? 'failed'
    : decision === 'completed'
      ? 'completed'
      : waiting || measurement === 'active' || decision === 'active'
        ? 'active'
        : 'pending'
  const steps: Array<{ id: string; label: string; status: KersorClassicStepStatus }> = [
    { id: 'ownership', label: t('run.host.ownership'), status: gateStepStatus(session?.candidate_ownership) },
    { id: 'measurement', label: t('detail.step.measurement'), status: measurement },
    { id: 'decision', label: t('detail.step.decision'), status: decision },
  ]
  return (
    <li role="treeitem" aria-expanded={true} className={css.hostTreeItem} data-step-status={status}>
      <div className={css.treeNode}>
        <StateDot state={classicStepDotState(status)} />
        <span>{t('run.host.title')}</span>
        <span className={css.phaseSummary}>{t(CLASSIC_STEP_STATUS_KEYS[status])}</span>
      </div>
      <ul role="group" className={css.treeGroup}>
        {steps.map(step => (
          <li key={step.id} role="treeitem" className={css.hostStep} data-step-status={step.status}>
            <StateDot state={classicStepDotState(step.status)} />
            <span>{step.label}</span>
            <span>{t(CLASSIC_STEP_STATUS_KEYS[step.status])}</span>
          </li>
        ))}
      </ul>
    </li>
  )
}

function WorkflowTree({
  row, view, session, sessionDetail, state, loadCallDetail, t,
}: {
  readonly row: KersorRunRow
  readonly view: KersorRunView
  readonly session: KersorClassicSession | undefined
  readonly sessionDetail: KersorClassicSessionDetail | undefined
  readonly state: KersorViewerState
  readonly loadCallDetail: KersorViewFace['loadCallDetail']
  readonly t: KersorViewProps['t']
}): React.JSX.Element {
  const [selectedCallId, setSelectedCallId] = useState<string>()
  const result = workflowResultOf(view)
  const detailKey = selectedCallId === undefined ? undefined : `${view.runDir}\u0000${selectedCallId}`
  return (
    <ul role="tree" aria-label={t('run.tree')} className={css.executionTree}>
      <li role="treeitem" aria-expanded={true} className={css.roundTreeItem}>
        <div className={css.treeNode}>
          <StateDot state={session?.lifecycle === 'active' ? 'ongoing' : runDotState(view.status)} />
          <span>{session?.session_id ?? sessionName(view.sessionDir)}</span>
          <span>{row.round === undefined ? row.runId : `R${String(row.round).padStart(2, '0')}`}</span>
        </div>
        <ul role="group" className={css.treeGroup}>
          <li role="treeitem" aria-expanded={true} className={css.workflowTreeItem}>
            <div className={css.treeNode}>
              <StateDot state={runDotState(view.status)} />
              <span>{view.workflow ?? view.runId}</span>
              <span>{t(RUN_STATUS_KEYS[view.status])}</span>
            </div>
            <ul role="group" className={css.treeGroup}>
              {view.phases.map(phase => (
                <li
                  key={`${phase.index}-${phase.title}`}
                  role="treeitem"
                  aria-expanded={phase.calls.length > 0}
                  className={css.phaseTreeItem}
                  data-phase-status={phase.status}
                  data-parallel={phase.calls.length > 1}
                >
                  <div className={css.treeNode}>
                    <StateDot state={phaseDotState(phase.status)} />
                    <span>{phase.title.length > 0 ? phase.title : t('phase.empty')}</span>
                    <span>{phase.calls.length > 1
                      ? t('run.parallelCalls', { calls: phase.calls.length })
                      : t('run.calls', { calls: phase.calls.length })}</span>
                  </div>
                  {phase.calls.length > 0
                    ? (
                      <ul role="group" className={css.treeGroup}>
                        {phase.calls.map((call) => {
                          const selected = selectedCallId === call.callId
                          const errorPrefix = `${view.runDir}\u0000${call.callId}: `
                          const callDetail = state.callDetails.get(`${view.runDir}\u0000${call.callId}`)
                          return (
                            <CallTreeNode
                              key={call.callId}
                              call={call}
                              {...(result?.selectedCandidateId === undefined
                                ? {}
                                : { selectedCandidateId: result.selectedCandidateId })}
                              selected={selected}
                              loading={selected && state.callDetailLoading === detailKey}
                              {...(state.callDetailError?.startsWith(errorPrefix) === true
                                ? { error: state.callDetailError.slice(errorPrefix.length) }
                                : {})}
                              {...(callDetail === undefined ? {} : { detail: callDetail })}
                              onToggle={() => {
                                const next = selected ? undefined : call.callId
                                setSelectedCallId(next)
                                if (next !== undefined && state.callDetails.get(`${view.runDir}\u0000${next}`) === undefined) {
                                  void loadCallDetail(view.runDir, next)
                                }
                              }}
                              t={t}
                            />
                          )
                        })}
                      </ul>
                    )
                    : null}
                </li>
              ))}
            </ul>
          </li>
          <HostVerificationTree session={session} detail={sessionDetail} result={result} t={t} />
        </ul>
      </li>
    </ul>
  )
}

function WorkflowResult({ result, t }: {
  readonly result: KersorWorkflowResultView
  readonly t: KersorViewProps['t']
}): React.JSX.Element {
  return (
    <section className={css.workflowResult} aria-label={t('run.result.title')}>
      <div className={css.resultHead}>
        <span className={css.detailTitle}>{t('run.result.title')}</span>
        {result.stage !== undefined
          ? <span className={css.resultStage}>{t('run.result.stage', { stage: result.stage })}</span>
          : null}
      </div>
      <div className={css.resultMetrics}>
        {result.verification !== undefined
          ? <span data-verification={result.verification}>{t(`run.result.verification.${result.verification}`)}</span>
          : null}
        {result.failureKind !== undefined
          ? <span className={css.failureBadge}>{t(FAILURE_KIND_KEYS[result.failureKind])}</span>
          : null}
        {result.selectedCandidateId !== undefined
          ? <span>{t('run.result.selected', { candidate: result.selectedCandidateId })}</span>
          : null}
        {result.measuredCycles !== undefined
          ? <span data-measurement="measured">{t('run.result.cyclesMeasured', { cycles: result.measuredCycles.toLocaleString() })}</span>
          : result.expectedCycles !== undefined
            ? <span data-measurement="estimated">{t('run.result.cyclesEstimated', { cycles: result.expectedCycles.toLocaleString() })}</span>
            : null}
        {result.measuredSpeedup !== undefined && result.measuredSpeedup !== null
          ? <span data-measurement="measured">{t('run.result.measured', { speedup: speedup(result.measuredSpeedup) })}</span>
          : result.estimatedSpeedup !== undefined
            ? <span data-measurement="estimated">{t('run.result.estimated', { speedup: speedup(result.estimatedSpeedup) })}</span>
            : <span data-measurement="pending">{t('run.result.unmeasured')}</span>}
        {result.bestImproved === true
          ? <span className={css.promotedBadge}>{t('run.result.promoted')}</span>
          : result.bestImproved === false
            ? <span>{t('run.result.incumbentRetained')}</span>
            : null}
        {result.incumbentCycles !== undefined
          ? <span>{t('run.result.incumbentCycles', { cycles: result.incumbentCycles.toLocaleString() })}</span>
          : null}
        {result.verification === 'failed' && result.estimatedSpeedup !== undefined
          ? <span className={css.excludedBadge}>{t('run.result.estimateExcluded')}</span>
          : null}
      </div>
      {result.candidates.length > 0
        ? (
          <ul className={css.candidates}>
            {result.candidates.map(candidate => (
              <li
                key={candidate.id}
                className={css.candidate}
                data-selected={candidate.id === result.selectedCandidateId}
              >
                <span className={css.mono}>{candidate.id}</span>
                {candidate.id === result.selectedCandidateId && result.measuredCycles !== undefined
                  ? <span data-measurement="measured">{t('run.result.cyclesMeasured', { cycles: result.measuredCycles.toLocaleString() })}</span>
                  : candidate.expectedCycles !== undefined
                    ? <span>{t('run.result.cyclesEstimated', { cycles: candidate.expectedCycles.toLocaleString() })}</span>
                    : null}
                {candidate.id === result.selectedCandidateId ? <span>{t('run.result.chosen')}</span> : null}
              </li>
            ))}
          </ul>
        )
        : null}
    </section>
  )
}

function workflowResultOf(view: KersorRunView): KersorWorkflowResultView | undefined {
  const nested = view.result
  const candidates = view.candidates ?? nested?.candidates ?? []
  const stage = view.candidateStage ?? nested?.stage
  const verification = view.verification ?? nested?.verification
  const failureKind = view.failureKind ?? nested?.failureKind
  const selectedCandidateId = view.selectedCandidateId ?? nested?.selectedCandidateId
  const expectedCycles = view.expectedCycles ?? nested?.expectedCycles
  const measuredBaselineCycles = view.measuredBaselineCycles ?? nested?.measuredBaselineCycles
  const measuredCycles = view.measuredCycles ?? nested?.measuredCycles
  const estimatedSpeedup = view.estimatedSpeedup ?? nested?.estimatedSpeedup
  const measuredSpeedup = view.measuredSpeedup ?? nested?.measuredSpeedup
  const incumbentCycles = view.incumbentCycles ?? nested?.incumbentCycles
  const incumbentSpeedup = view.incumbentSpeedup ?? nested?.incumbentSpeedup
  const bestImproved = view.bestImproved ?? nested?.bestImproved
  if (
    stage === undefined && verification === undefined && selectedCandidateId === undefined
    && expectedCycles === undefined && measuredBaselineCycles === undefined && measuredCycles === undefined
    && estimatedSpeedup === undefined && measuredSpeedup === undefined && candidates.length === 0
  ) return undefined
  return {
    ...(stage === undefined ? {} : { stage }),
    ...(verification === undefined ? {} : { verification }),
    ...(failureKind === undefined ? {} : { failureKind }),
    ...(selectedCandidateId === undefined ? {} : { selectedCandidateId }),
    ...(expectedCycles === undefined ? {} : { expectedCycles }),
    ...(measuredBaselineCycles === undefined ? {} : { measuredBaselineCycles }),
    ...(measuredCycles === undefined ? {} : { measuredCycles }),
    ...(estimatedSpeedup === undefined ? {} : { estimatedSpeedup }),
    ...(measuredSpeedup === undefined ? {} : { measuredSpeedup }),
    ...(incumbentCycles === undefined ? {} : { incumbentCycles }),
    ...(incumbentSpeedup === undefined ? {} : { incumbentSpeedup }),
    ...(bestImproved === undefined ? {} : { bestImproved }),
    candidates,
  }
}

function RunDetail({
  row, view, session, sessionDetail, crossWorkspace, state, loadCallDetail, t,
}: {
  readonly row: KersorRunRow
  readonly view: KersorRunView
  readonly session: KersorClassicSession | undefined
  readonly sessionDetail: KersorClassicSessionDetail | undefined
  readonly crossWorkspace: boolean
  readonly state: KersorViewerState
  readonly loadCallDetail: KersorViewFace['loadCallDetail']
  readonly t: KersorViewProps['t']
}): React.JSX.Element {
  const result = workflowResultOf(view)
  const workflowWaiting = view.status === 'completed'
    && session?.lifecycle === 'active'
    && result?.stage === 'awaiting_host_verification'
  const statusLabel = workflowWaiting
    ? t('run.workflowCompletedHostPending')
    : view.status === 'completed' && session?.lifecycle === 'active'
      ? t('run.workflowCompletedSessionActive')
      : t(RUN_STATUS_KEYS[view.status])
  return (
    <div className={css.runDetail}>
      <div className={css.runHead}>
        <span className={css.workflowIdentity} title={view.runDir}>{runDisplayLabel(row, session)}</span>
        <span className={css.runId} title={view.runDir}>{view.runId}</span>
        {crossWorkspace ? <span className={css.workspaceBadge}>{t('session.otherWorkspace')}</span> : null}
        <span className={css.statusTail} data-status={view.status}>
          <StateDot state={workflowWaiting ? 'ongoing' : runDotState(view.status)} />
          <span>{statusLabel}</span>
        </span>
      </div>
      <div className={css.runMeta}>
        {view.currentPhase.length > 0 ? <span>{t('run.currentPhase', { phase: view.currentPhase })}</span> : null}
        <span>{t('run.calls', { calls: view.totals.calls })}</span>
        {view.totals.tokens > 0 ? <span>{t('run.tokens', { tokens: view.totals.tokens.toLocaleString() })}</span> : null}
      </div>
      {view.error !== undefined ? <div className={css.runError}>{t('run.error', { message: view.error })}</div> : null}
      {view.phases.length > 0
        ? (
          <WorkflowTree
            row={row}
            view={view}
            session={session}
            sessionDetail={sessionDetail}
            state={state}
            loadCallDetail={loadCallDetail}
            t={t}
          />
        )
        : null}
      {result !== undefined ? <WorkflowResult result={result} t={t} /> : null}
    </div>
  )
}

function LauncherControls({ launcher, busy, start, stop, t }: {
  readonly launcher: NonNullable<KersorViewerState['launcher']>
  readonly busy: string | undefined
  readonly start: (taskId: KersorTaskId) => Promise<void>
  readonly stop: (runDir: string) => Promise<void>
  readonly t: KersorViewProps['t']
}): React.JSX.Element {
  const labels = new Map(launcher.tasks.map(task => [task.id, task.label]))
  return (
    <section className={css.launcher} aria-label={t('launcher.title')}>
      <div className={css.launcherHead}>
        <span className={css.launcherTitle}>{t('launcher.title')}</span>
        {launcher.active.length > 0
          ? <span className={css.launcherSummary}>{t('launcher.running', { count: launcher.active.length })}</span>
          : null}
      </div>
      <div className={css.taskList}>
        {launcher.tasks.map((task) => {
          const key = `start:${task.id}`
          return (
            <div key={task.id} className={css.taskRow}>
              <span className={css.taskLabel}>{task.label}</span>
              <button
                type="button"
                className={css.controlButton}
                disabled={busy !== undefined}
                onClick={() => { void start(task.id) }}
                data-busy={busy === key}
              >
                {t('launcher.start')}
              </button>
            </div>
          )
        })}
      </div>
      {launcher.active.length > 0
        ? (
          <div className={css.activeList}>
            {launcher.active.map(launch => (
              <div key={launch.runDir} className={css.activeRow}>
                <StateDot state="ongoing" />
                <span className={css.activeLabel} title={launch.runDir}>
                  {labels.get(launch.taskId) ?? launch.taskId}
                  <span className={css.activeRunId}>{launch.runId}</span>
                </span>
                <button
                  type="button"
                  className={css.controlButton}
                  disabled={busy !== undefined}
                  onClick={() => { void stop(launch.runDir) }}
                  data-busy={busy === `stop:${launch.runDir}`}
                >
                  {t('launcher.stop')}
                </button>
              </div>
            ))}
          </div>
        )
        : null}
      {launcher.error !== undefined
        ? <div className={css.readError}>{t('launcher.error', { message: launcher.error })}</div>
        : null}
    </section>
  )
}

interface ViewerHealth {
  readonly state: 'healthy' | 'degraded' | 'failed'
  readonly roots: number
  readonly readers: number
  readonly sources: number
  readonly issue?: KersorDiagnosticIssue
}

function viewerHealth(snapshot: KersorViewerSnapshot): ViewerHealth {
  const roots = snapshot.diagnostics.scan.roots
  const readers = snapshot.diagnostics.runs
  const rootIssues = roots.flatMap(root => root.lastIssue === undefined ? [] : [root.lastIssue])
  const runIssues = readers.flatMap(run => run.lastIssue === undefined ? [] : [run.lastIssue])
  const classicIssue = snapshot.classic.source.lastIssue
  const issues = [...rootIssues, ...runIssues, ...(classicIssue === undefined ? [] : [classicIssue])]
  const classicFailed = snapshot.classic.source.state === 'failed'
  const degraded = snapshot.diagnostics.scan.state === 'degraded'
    || snapshot.diagnostics.scan.state === 'failed'
    || classicFailed
    || snapshot.classic.source.state === 'degraded'
    || readers.some(run => run.state === 'degraded' || run.state === 'failed')
  const noReadableSource = snapshot.diagnostics.scan.state === 'failed'
    && snapshot.classic.source.state !== 'healthy'
    && snapshot.classic.source.state !== 'degraded'
  const issue = snapshot.diagnostics.scan.lastIssue ?? classicIssue ?? runIssues.at(-1)
  return {
    state: noReadableSource ? 'failed' : degraded ? 'degraded' : 'healthy',
    roots: roots.length,
    readers: readers.length,
    sources: issues.length,
    ...(issue === undefined ? {} : { issue }),
  }
}

/** First-class KerSor view rendered beside Chat and Trajectory. */
export function KersorView({
  t, store, currentWorkspace, refresh, loadRun, loadCallDetail, loadClassic, start, stop,
}: KersorViewProps): React.JSX.Element {
  const [busy, setBusy] = useState<string>()
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const rows = store.rows
  const classicSessions = state.snapshot?.classic.sessions ?? []
  const visibleRows = store.selectedClassicSessionDir === undefined
    ? rows
    : rows.filter(row => row.sessionDir === store.selectedClassicSessionDir)
  const health = state.snapshot === undefined ? undefined : viewerHealth(state.snapshot)

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (store.selectedRunDir !== undefined || store.selectedClassicSessionDir !== undefined
      || rows.length === 0) return
    const currentSessions = classicSessions.filter(session => belongsToWorkspace(session.session_dir, currentWorkspace))
    const preferredSession = currentSessions.find(session => session.health === 'active')
      ?? currentSessions[0]
      ?? classicSessions.find(session => session.health === 'active')
      ?? classicSessions[0]
    const matching = preferredSession === undefined
      ? []
      : rows.filter(row => row.sessionDir === preferredSession.session_dir)
    const currentRows = rows.filter(row => belongsToWorkspace(row.sessionDir, currentWorkspace))
    const target = matching.sort((left, right) => (right.round ?? 0) - (left.round ?? 0))[0]
      ?? currentRows.find(row => row.discovery === 'active')
      ?? currentRows[0]
      ?? rows.find(row => row.discovery === 'active')
      ?? rows[0]
    if (target === undefined) return
    store.select(target.runDir)
    void loadRun(target.runDir)
  }, [classicSessions, currentWorkspace, loadRun, rows, store])

  const runStart = async (taskId: KersorTaskId): Promise<void> => {
    setBusy(`start:${taskId}`)
    try {
      await start(taskId)
    } finally {
      setBusy(undefined)
    }
  }

  const runStop = async (runDir: string): Promise<void> => {
    setBusy(`stop:${runDir}`)
    try {
      await stop(runDir)
    } finally {
      setBusy(undefined)
    }
  }

  const toggleClassic = (sessionDir: string): void => {
    if (store.selectedClassicSessionDir === sessionDir) {
      store.selectClassic(undefined)
      return
    }
    const runDir = store.selectClassic(sessionDir)
    void loadClassic(sessionDir)
    if (runDir !== undefined) void loadRun(runDir)
  }

  return (
    <section
      className={css.view}
      data-conversation-composer-overlay=""
      aria-label={t('panel.title')}
    >
      <div className={css.header}>
        <span className={css.title}>{t('panel.title')}</span>
        <span className={css.note}>{t('panel.hint')}</span>
      </div>
      <div className={css.body}>
        {state.launcher !== undefined
          ? <LauncherControls launcher={state.launcher} busy={busy} start={runStart} stop={runStop} t={t} />
          : null}
        {state.transportError !== undefined
          ? <div className={css.readError}>{t('panel.readFailed', { message: state.transportError })}</div>
          : null}
        {health !== undefined && health.state !== 'healthy'
          ? (
            <div className={css.readError} data-source-health={health.state}>
              {t(health.state === 'failed' ? 'panel.sourcesFailed' : 'panel.sourcesDegraded', {
                roots: health.roots,
                readers: health.readers,
                sources: health.sources,
                stage: health.issue?.stage ?? 'source',
                code: health.issue?.code ?? 'unavailable',
                occurrences: health.issue?.occurrences ?? 1,
              })}
            </div>
          )
          : null}
        {state.loading ? <div className={css.note}>{t('panel.loading')}</div> : null}
        {!state.loading
                && state.transportError === undefined
                && health?.state === 'healthy'
                && rows.length === 0
                && classicSessions.length === 0
          ? <div className={css.note}>{t('panel.empty', { roots: health.roots })}</div>
          : null}
        {classicSessions.length > 0
          ? (
            <section className={css.activitySection} aria-label={t('session.title')}>
              <div className={css.sectionHead}>
                <span className={css.sectionTitle}>{t('session.title')}</span>
                <span className={css.sectionSummary}>{t('session.summary', {
                  count: classicSessions.length,
                  active: classicSessions.filter(session => session.health === 'active').length,
                })}</span>
              </div>
              <ul className={css.classicRows}>
                {classicSessions.map(session => (
                  <ClassicSessionRow
                    key={session.session_dir}
                    session={session}
                    selected={store.selectedClassicSessionDir === session.session_dir}
                    crossWorkspace={!belongsToWorkspace(session.session_dir, currentWorkspace)}
                    loading={state.classicDetailLoading === session.session_dir}
                    {...(state.classicDetails.get(session.session_dir) === undefined
                      ? {}
                      : { detail: state.classicDetails.get(session.session_dir) })}
                    {...(state.classicDetailError?.startsWith(`${session.session_dir}: `) === true
                      ? { error: state.classicDetailError.slice(session.session_dir.length + 2) }
                      : {})}
                    onToggle={() => { toggleClassic(session.session_dir) }}
                    t={t}
                  />
                ))}
              </ul>
            </section>
          )
          : null}
        {visibleRows.length > 0
          ? (
            <section className={css.activitySection} aria-label={t('run.sectionTitle')}>
              <div className={css.sectionHead}>
                <span className={css.sectionTitle}>{t('run.sectionTitle')}</span>
                <span className={css.sectionSummary}>{visibleRows.length}</span>
              </div>
              <ul className={css.rows}>
                {visibleRows.map((row) => {
                  const session = classicSessions.find(candidate => candidate.session_dir === row.sessionDir)
                  const crossWorkspace = !belongsToWorkspace(row.sessionDir, currentWorkspace)
                  return (
                    <li key={row.runDir} className={css.row} data-run-status={row.discovery}>
                      <button
                        type="button"
                        className={css.rowHead}
                        aria-pressed={store.selectedRunDir === row.runDir}
                        onClick={() => {
                          const next = store.selectedRunDir === row.runDir ? undefined : row.runDir
                          store.select(next)
                          if (next !== undefined) {
                            void loadRun(next)
                            void loadClassic(row.sessionDir)
                          }
                        }}
                      >
                        <StateDot state={row.discovery === 'active' ? 'ongoing' : row.discovery === 'failed' ? 'error' : 'done'} />
                        <span className={css.rowLabel}>{runDisplayLabel(row, session)}</span>
                        <span className={css.runId}>{row.runId}</span>
                        {crossWorkspace ? <span className={css.workspaceBadge}>{t('session.otherWorkspace')}</span> : null}
                      </button>
                      {store.selectedRunDir === row.runDir && row.view !== undefined
                        ? (
                          <RunDetail
                            row={row}
                            view={row.view}
                            session={session}
                            sessionDetail={state.classicDetails.get(row.sessionDir)}
                            crossWorkspace={crossWorkspace}
                            state={state}
                            loadCallDetail={loadCallDetail}
                            t={t}
                          />
                        )
                        : null}
                    </li>
                  )
                })}
              </ul>
            </section>
          )
          : null}
      </div>
    </section>
  )
}
