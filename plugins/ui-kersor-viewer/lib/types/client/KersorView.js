import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** KerSor conversation view: Session inventory with live Workflow progress. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { IconChevronRightOutline14, StateDot } from '@deepseek-ai/dsh-client-ui-primitives';
import { visibleFitConfidence } from "./readiness.js";
import css from './KersorView.module.css';
const RUN_STATUS_KEYS = {
    running: 'run.active',
    completed: 'run.completed',
    failed: 'run.failed',
    unknown: 'run.unknown',
};
const CALL_STATUS_KEYS = {
    queued: 'call.queued',
    running: 'call.running',
    completed: 'call.completed',
    failed: 'call.failed',
};
function runDotState(status) {
    switch (status) {
        case 'running': return 'ongoing';
        case 'completed': return 'done';
        case 'failed': return 'error';
        /* v8 ignore next -- KersorRunStatus is closed and every variant is handled above. */
        default: return 'warning';
    }
}
function callDotState(status) {
    switch (status) {
        case 'queued': return 'warning';
        case 'running': return 'ongoing';
        case 'completed': return 'done';
        case 'failed': return 'error';
    }
}
function phaseDotState(status) {
    switch (status) {
        case 'running': return 'ongoing';
        case 'completed': return 'done';
        case 'failed': return 'error';
    }
}
const CLASSIC_HEALTH_KEYS = {
    active: 'session.health.active',
    stale: 'session.health.stale',
    needs_resume: 'session.health.needsResume',
    terminal: 'session.health.terminal',
    unknown: 'session.health.unknown',
};
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
};
const CLASSIC_STEP_STATUS_KEYS = {
    pending: 'step.pending',
    active: 'step.active',
    completed: 'step.completed',
    failed: 'step.failed',
};
function classicStepDotState(status) {
    switch (status) {
        case 'pending': return 'warning';
        case 'active': return 'ongoing';
        case 'completed': return 'done';
        case 'failed': return 'error';
    }
}
function classicDotState(health, lifecycle) {
    if (health === 'active')
        return 'ongoing';
    if (health !== 'terminal')
        return 'warning';
    switch (lifecycle) {
        case 'completed': return 'done';
        case 'stalled': return 'error';
        case 'cancelled': return 'warning';
        case 'active': return 'warning';
    }
}
function speedup(value) {
    return Number.isInteger(value) ? value.toFixed(1) : value.toFixed(2);
}
const GATE_KEYS = {
    pass: 'session.gate.pass',
    fail: 'session.gate.fail',
    pending: 'session.gate.pending',
    not_required: 'session.gate.notRequired',
};
const BASELINE_ACTION_KEYS = {
    init: 'session.baselineAction.init',
    record_verify: 'session.baselineAction.recordVerify',
    new_session: 'session.baselineAction.newSession',
};
const STOP_REASON_KEYS = {
    target_met: 'detail.stop.targetMet',
    execution_budget_exhausted: 'detail.stop.executionBudget',
    selection_stalled: 'detail.stop.selectionStalled',
    authoring_budget_exhausted: 'detail.stop.authoringBudget',
    cancelled: 'detail.stop.cancelled',
    single_run_complete: 'detail.stop.singleRun',
};
const FAILURE_KIND_KEYS = {
    correctness: 'detail.round.failure.correctness',
    benchmark: 'detail.round.failure.benchmark',
    infrastructure: 'detail.round.failure.infrastructure',
};
function displayTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
        return undefined;
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(date);
}
function roundDotState(round) {
    if (round.host_verdict === 'fail')
        return 'error';
    if (round.host_verdict === 'pending')
        return 'ongoing';
    return round.measurement?.best_improved === true ? 'done' : 'warning';
}
function RoundHistory({ rounds, stopReason, t }) {
    if (rounds.length === 0)
        return null;
    return (_jsxs("section", { className: css.roundHistory, "aria-label": t('detail.rounds'), children: [_jsx("span", { className: css.detailTitle, children: t('detail.rounds') }), _jsxs("ol", { className: css.roundTree, role: "tree", "aria-label": t('detail.roundTree'), children: [rounds.map(round => (_jsxs("li", { className: css.roundNode, role: "treeitem", "data-host-verdict": round.host_verdict, "data-promoted": round.measurement?.best_improved ?? false, children: [_jsxs("div", { className: css.roundHead, children: [_jsx(StateDot, { state: roundDotState(round) }), _jsx("strong", { children: t('detail.round.number', { round: round.number }) }), _jsx("span", { className: css.roundWorkflow, children: round.workflow ?? t('session.noWorkflow') }), round.workflow_origin === 'authored'
                                        ? _jsx("span", { className: css.authoredBadge, children: t('detail.round.authored') })
                                        : null, _jsx("span", { className: css.roundVerdict, children: t(`detail.round.verdict.${round.host_verdict}`) })] }), _jsxs("div", { className: css.roundFacts, children: [round.candidate_id !== undefined
                                        ? _jsx("span", { className: css.mono, children: t('detail.round.candidate', { candidate: round.candidate_id }) })
                                        : null, round.measurement?.candidate_cycles !== undefined
                                        ? _jsx("span", { "data-measurement": "measured", children: t('detail.round.measuredCycles', {
                                                cycles: round.measurement.candidate_cycles.toLocaleString(),
                                            }) })
                                        : null, round.measurement?.candidate_speedup !== undefined
                                        ? _jsx("span", { "data-measurement": "measured", children: t('detail.round.measuredSpeedup', {
                                                speedup: speedup(round.measurement.candidate_speedup),
                                            }) })
                                        : null, round.measurement?.best_improved === true
                                        ? _jsx("span", { className: css.promotedBadge, children: t('detail.round.promoted') })
                                        : round.host_verdict === 'pass'
                                            ? _jsx("span", { children: t('detail.round.retained') })
                                            : null, round.failure_kind !== undefined
                                        ? _jsx("span", { className: css.failureBadge, children: t(FAILURE_KIND_KEYS[round.failure_kind]) })
                                        : null, round.estimate?.cycles !== undefined
                                        ? _jsx("span", { "data-measurement": "estimated", children: t('detail.round.estimatedCycles', {
                                                cycles: round.estimate.cycles.toLocaleString(),
                                            }) })
                                        : null, round.estimate?.speedup !== undefined
                                        ? _jsx("span", { "data-measurement": "estimated", children: t('detail.round.estimatedSpeedup', {
                                                speedup: speedup(round.estimate.speedup),
                                            }) })
                                        : null, round.host_verdict === 'fail' && round.estimate !== undefined
                                        ? _jsx("span", { className: css.excludedBadge, children: t('detail.round.estimateExcluded') })
                                        : null] }), round.workflow_origin === 'authored'
                                ? _jsx("div", { className: css.authoringChain, children: t('detail.round.authoringChain') })
                                : null, round.decision !== undefined
                                ? _jsx("div", { className: css.roundDecision, children: round.decision })
                                : null] }, round.number))), stopReason !== null && stopReason !== undefined
                        ? (_jsxs("li", { className: css.stopNode, role: "treeitem", "data-stop-reason": stopReason, children: [_jsx(StateDot, { state: stopReason === 'target_met' ? 'done' : 'warning' }), _jsx("strong", { children: t('detail.stop') }), _jsx("span", { children: t(STOP_REASON_KEYS[stopReason]) })] }))
                        : null] })] }));
}
function ClassicSessionDetail({ session, detail, t }) {
    const design = detail.workflow ?? detail.authoring.design;
    const phases = design?.phases ?? [];
    const lineage = session.cycle_lineage;
    const latestFailureKind = detail.rounds.at(-1)?.failure_kind;
    return (_jsxs("div", { className: css.classicDetail, children: [_jsxs("section", { className: css.outcomeSummary, "data-stop-reason": session.stop_reason ?? undefined, children: [_jsxs("div", { className: css.outcomeHead, children: [_jsx("span", { className: css.detailTitle, children: t('detail.outcome') }), session.stop_reason !== null && session.stop_reason !== undefined
                                ? _jsx("span", { children: t(STOP_REASON_KEYS[session.stop_reason]) })
                                : _jsx("span", { children: t(CLASSIC_HEALTH_KEYS[session.health]) })] }), _jsxs("div", { className: css.outcomeMetrics, children: [lineage?.best_cycles !== undefined
                                ? _jsx("strong", { children: t('detail.bestCycles', { cycles: lineage.best_cycles.toLocaleString() }) })
                                : null, lineage?.session_baseline_cycles !== undefined && lineage.best_cycles !== undefined
                                ? _jsx("span", { children: t('detail.sessionLineage', {
                                        baseline: lineage.session_baseline_cycles.toLocaleString(),
                                        best: lineage.best_cycles.toLocaleString(),
                                        speedup: lineage.session_speedup === undefined ? '—' : speedup(lineage.session_speedup),
                                    }) })
                                : null, lineage?.task_baseline_cycles !== undefined && lineage.best_cycles !== undefined
                                ? _jsx("span", { children: t('detail.overallLineage', {
                                        baseline: lineage.task_baseline_cycles.toLocaleString(),
                                        best: lineage.best_cycles.toLocaleString(),
                                        speedup: lineage.overall_speedup === undefined ? '—' : speedup(lineage.overall_speedup),
                                    }) })
                                : null, session.allow_workflow_authoring === true
                                ? _jsx("span", { children: t('detail.authoringBudget', {
                                        used: session.workflow_authoring_used ?? 0,
                                        total: session.workflow_authoring_budget ?? '—',
                                    }) })
                                : null] })] }), _jsx(RoundHistory, { rounds: detail.rounds, stopReason: session.stop_reason, t: t }), _jsx("ol", { className: css.timeline, "aria-label": t('detail.timeline'), children: detail.steps.map(step => (_jsxs("li", { className: css.timelineStep, "data-step-status": step.status, children: [_jsx(StateDot, { state: classicStepDotState(step.status) }), _jsx("span", { children: t(CLASSIC_STEP_KEYS[step.id]) })] }, step.id))) }), _jsxs("div", { className: css.detailGrid, children: [_jsxs("section", { className: css.detailSection, children: [_jsx("span", { className: css.detailTitle, children: t('detail.selection') }), _jsx("span", { children: t(`detail.selection.${detail.selection.status}`) }), detail.selection.workflow !== undefined
                                ? _jsx("span", { className: css.mono, children: detail.selection.workflow })
                                : null, detail.selection.reason !== undefined
                                ? _jsx("span", { className: css.detailReason, children: detail.selection.reason })
                                : null, _jsx("span", { children: t('detail.rejected', { count: detail.selection.rejectedCount }) })] }), _jsxs("section", { className: css.detailSection, children: [_jsx("span", { className: css.detailTitle, children: t('detail.authoring') }), _jsx("span", { children: t(`detail.authoring.${detail.authoring.status}`) }), detail.authoring.omittedReason !== undefined
                                ? _jsx("span", { className: css.detailError, children: t('detail.omitted', { reason: detail.authoring.omittedReason }) })
                                : null] }), _jsxs("section", { className: css.detailSection, children: [_jsx("span", { className: css.detailTitle, children: t('detail.validation') }), _jsx("span", { children: t(`detail.validation.${detail.validation.status}`) }), detail.validation.checks.length > 0
                                ? (_jsx("ul", { className: css.checks, children: detail.validation.checks.map(check => (_jsxs("li", { "data-check-passed": check.passed, children: [check.passed ? '✓' : '×', " ", check.name] }, check.name))) }))
                                : null] }), _jsxs("section", { className: css.detailSection, children: [_jsx("span", { className: css.detailTitle, children: t('detail.dispatch') }), _jsx("span", { children: detail.dispatch.status === 'failed'
                                    && latestFailureKind !== undefined
                                    ? t(FAILURE_KIND_KEYS[latestFailureKind])
                                    : t(`detail.dispatch.${detail.dispatch.status}`) }), detail.dispatch.runtimeStatus !== undefined
                                ? _jsx("span", { className: css.mono, children: detail.dispatch.runtimeStatus })
                                : null, detail.dispatch.runDir !== undefined
                                ? _jsx("span", { className: css.detailPath, title: detail.dispatch.runDir, children: detail.dispatch.runDir })
                                : null] })] }), detail.authoring.files.length > 0
                ? (_jsx("div", { className: css.artifacts, children: detail.authoring.files.map(file => (_jsxs("span", { title: file.sha256, children: [_jsx("span", { className: css.mono, children: file.name }), " \u00B7 ", file.bytes, " B \u00B7 ", file.sha256.slice(0, 18), "\u2026"] }, file.name))) }))
                : null, design !== undefined
                ? (_jsxs("div", { className: css.design, children: [_jsx("span", { className: css.detailTitle, children: t('detail.workflowDesign') }), _jsxs("div", { className: css.designMeta, children: [design.name !== undefined ? _jsx("span", { className: css.mono, children: design.name }) : null, design.technique !== undefined ? _jsx("span", { children: design.technique }) : null, design.methodCategory !== undefined ? _jsx("span", { children: design.methodCategory }) : null, design.topology !== undefined ? _jsx("span", { children: design.topology }) : null, design.languages.map(value => _jsx("span", { children: value }, `language:${value}`)), design.backends.map(value => _jsx("span", { children: value }, `backend:${value}`)), design.integrationPatterns.map(value => _jsx("span", { children: value }, `integration:${value}`))] }), design.description !== undefined
                            ? _jsx("p", { className: css.designText, children: design.description })
                            : null, phases.length > 0
                            ? (_jsxs("div", { className: css.workflowTree, role: "tree", "aria-label": t('detail.workflowTree'), children: [_jsxs("div", { className: css.workflowRoot, role: "treeitem", "aria-expanded": "true", children: [_jsx(StateDot, { state: detail.dispatch.status === 'failed'
                                                    ? 'error'
                                                    : detail.dispatch.status === 'completed'
                                                        ? 'done'
                                                        : detail.dispatch.status === 'running'
                                                            ? 'ongoing'
                                                            : 'warning' }), _jsx("span", { className: css.mono, children: design.name ?? detail.selection.workflow ?? 'Workflow' })] }), _jsx("div", { className: css.workflowBranches, role: "group", children: phases.map((phase, index) => (_jsxs("div", { className: css.workflowPhase, role: "treeitem", children: [_jsx("span", { className: css.workflowBranch, "aria-hidden": "true", children: index === phases.length - 1 ? '└' : '├' }), _jsx("span", { className: css.workflowPhaseIndex, children: index + 1 }), _jsxs("span", { className: css.workflowPhaseBody, children: [_jsx("strong", { children: phase.title }), _jsx("span", { children: phase.detail })] })] }, `${index}:${phase.title}`))) })] }))
                            : null, design.requiredArgs.length > 0
                            ? _jsxs("div", { className: css.requiredArgs, children: [t('detail.requiredArgs'), ": ", _jsx("span", { className: css.mono, children: design.requiredArgs.join(', ') })] })
                            : null, _jsxs("details", { className: css.designDisclosure, children: [_jsx("summary", { children: t('detail.rationale') }), _jsx("pre", { children: design.rationale })] }), design.whenToUse !== undefined
                            ? (_jsxs("details", { className: css.designDisclosure, children: [_jsx("summary", { children: t('detail.whenToUse') }), _jsx("pre", { children: design.whenToUse })] }))
                            : null, _jsxs("details", { className: css.designDisclosure, children: [_jsx("summary", { children: t('detail.source') }), _jsx("pre", { children: design.source })] })] }))
                : _jsx("div", { className: css.detailNote, children: t('detail.sealRequired') })] }));
}
function ClassicSessionRow({ session, selected, crossWorkspace, detail, loading, error, onToggle, t }) {
    const round = session.current_round !== null && session.current_round !== undefined
        ? session.max_workflows !== null && session.max_workflows !== undefined
            ? t('session.round', { current: session.current_round, maximum: session.max_workflows })
            : t('session.roundOpen', { current: session.current_round })
        : undefined;
    const languageBackend = session.kernel_language !== null && session.kernel_language !== undefined
        ? session.backend !== null && session.backend !== undefined
            ? `${session.kernel_language}/${session.backend}`
            : session.kernel_language
        : session.backend ?? undefined;
    const details = [languageBackend, session.mode, session.storage_kind].filter(Boolean).join(' · ');
    const activity = session.last_activity_at !== null && session.last_activity_at !== undefined
        ? displayTime(session.last_activity_at)
        : undefined;
    const fitConfidence = visibleFitConfidence(session);
    return (_jsxs("li", { className: css.classicRow, "data-session-health": session.health, "data-session-lifecycle": session.lifecycle, "data-expanded": selected, children: [_jsxs("div", { className: css.classicHead, children: [_jsx(StateDot, { state: session.stop_reason === 'execution_budget_exhausted'
                            ? 'warning'
                            : classicDotState(session.health, session.lifecycle) }), _jsx("span", { className: css.sessionId, title: session.session_dir, children: session.session_id }), _jsx("span", { className: css.phaseBadge, children: t(CLASSIC_HEALTH_KEYS[session.health]) }), crossWorkspace ? _jsx("span", { className: css.workspaceBadge, children: t('session.otherWorkspace') }) : null, _jsx("button", { type: "button", className: css.classicExpand, "aria-expanded": selected, "aria-label": selected ? t('detail.collapse') : t('detail.expand'), onClick: onToggle, children: _jsx(IconChevronRightOutline14, {}) })] }), _jsxs("div", { className: css.classicMetrics, children: [round !== undefined ? _jsx("span", { children: round }) : null, session.best_speedup !== null && session.best_speedup !== undefined
                        ? _jsx("span", { "data-target-met": session.target_met ?? undefined, children: t('session.best', { speedup: speedup(session.best_speedup) }) })
                        : null, session.target_speedup !== null && session.target_speedup !== undefined
                        ? _jsx("span", { children: t('session.target', { speedup: speedup(session.target_speedup) }) })
                        : null, _jsx("span", { children: session.phase ?? t('session.unknownPhase') }), details.length > 0 ? _jsx("span", { children: details }) : null, session.integration_pattern !== null && session.integration_pattern !== undefined
                        ? _jsx("span", { className: css.routeBadge, children: session.integration_pattern })
                        : null, session.allow_workflow_authoring === true
                        ? _jsx("span", { className: css.authoringBadge, children: t('session.authoring', {
                                used: session.workflow_authoring_used ?? 0,
                                budget: session.workflow_authoring_budget ?? '—',
                            }) })
                        : null, session.fresh_session != null
                        ? _jsx("span", { className: css.gateBadge, "data-gate": session.fresh_session, children: t('session.freshGate', {
                                status: t(GATE_KEYS[session.fresh_session]),
                            }) })
                        : null, session.allow_workflow_authoring === true && session.baseline_witness != null
                        ? _jsx("span", { className: css.gateBadge, "data-gate": session.baseline_witness, children: t('session.baselineGate', {
                                status: t(GATE_KEYS[session.baseline_witness]),
                            }) })
                        : null, session.allow_workflow_authoring === true && session.profile_evidence != null
                        ? _jsx("span", { className: css.gateBadge, "data-gate": session.profile_evidence, children: t('session.profileGate', {
                                status: t(GATE_KEYS[session.profile_evidence]),
                            }) })
                        : null, session.allow_workflow_authoring === true && session.profile_owner != null
                        ? _jsx("span", { className: css.routeBadge, "data-profile-owner": session.profile_owner, children: t('session.profileOwner', {
                                owner: session.profile_owner,
                            }) })
                        : null, session.allow_workflow_authoring === true && session.dsh_compatibility != null
                        ? _jsx("span", { className: css.gateBadge, "data-gate": session.dsh_compatibility, children: t('session.dshGate', {
                                status: t(GATE_KEYS[session.dsh_compatibility]),
                            }) })
                        : null, session.allow_workflow_authoring === true && session.candidate_ownership != null
                        ? _jsx("span", { className: css.gateBadge, "data-gate": session.candidate_ownership, children: t('session.ownershipGate', {
                                status: t(GATE_KEYS[session.candidate_ownership]),
                            }) })
                        : null, activity !== undefined ? _jsx("span", { children: t('session.lastActivity', { time: activity }) }) : null] }), session.allow_workflow_authoring === true && session.baseline_next_action != null
                ? _jsxs("div", { className: css.baselineAction, "data-baseline-action": session.baseline_next_action, title: session.baseline_reason ?? undefined, children: [_jsx("span", { className: css.baselineActionLabel, children: t(BASELINE_ACTION_KEYS[session.baseline_next_action]) }), session.baseline_reason != null
                            ? _jsx("span", { className: css.baselineActionReason, children: session.baseline_reason })
                            : null] })
                : null, session.allow_workflow_authoring === true && session.profile_evidence === 'fail'
                && session.profile_reason != null
                ? _jsxs("div", { className: css.profileBlock, "data-profile-gate": "fail", title: session.profile_reason, children: [_jsx("span", { className: css.profileBlockLabel, children: t('session.profileBlocked') }), _jsx("span", { className: css.profileBlockReason, children: session.profile_reason })] })
                : null, _jsxs("div", { className: css.classicFoot, children: [_jsx("span", { className: css.workflowName, children: session.selection_status === 'stalled'
                            ? t('session.selectorStalled')
                            : session.workflow !== null && session.workflow !== undefined
                                ? t('session.workflow', { workflow: session.workflow })
                                : t('session.noWorkflow') }), fitConfidence !== undefined
                        ? _jsx("span", { className: css.fitBadge, "data-fit-confidence": fitConfidence, children: t('session.fit', { confidence: fitConfidence }) })
                        : null, session.warningCount > 0
                        ? _jsx("span", { className: css.warningCount, children: t('session.warnings', { count: session.warningCount }) })
                        : null] }), session.decision !== null && session.decision !== undefined
                ? _jsx("div", { className: css.decisionReason, title: session.decision, children: session.decision })
                : null, selected && loading ? _jsx("div", { className: css.detailNote, children: t('detail.loading') }) : null, selected && error !== undefined ? _jsx("div", { className: css.detailError, children: error }) : null, selected && detail !== undefined ? _jsx(ClassicSessionDetail, { session: session, detail: detail, t: t }) : null] }));
}
function durationSeconds(startedTs, endedTs) {
    if (startedTs === undefined || endedTs === undefined)
        return undefined;
    const start = Date.parse(startedTs);
    const end = Date.parse(endedTs);
    if (Number.isNaN(start) || Number.isNaN(end) || end < start)
        return undefined;
    return `${((end - start) / 1000).toFixed(1)}s`;
}
function normalizedPath(value) {
    return value.replace(/\\/g, '/').replace(/\/+$/, '');
}
function belongsToWorkspace(sessionDir, workspace) {
    if (workspace === undefined || workspace.length === 0)
        return true;
    return normalizedPath(sessionDir).startsWith(`${normalizedPath(workspace)}/.kersor/`);
}
function sessionName(sessionDir) {
    return normalizedPath(sessionDir).split('/').at(-1) ?? sessionDir;
}
function runDisplayLabel(row, session) {
    const round = row.round ?? session?.current_round ?? undefined;
    const roundLabel = round === undefined ? row.runId : `R${String(round).padStart(2, '0')}`;
    const workflow = row.view?.workflow ?? session?.workflow ?? row.runId;
    return `${session?.session_id ?? sessionName(row.sessionDir)} · ${roundLabel} · ${workflow}`;
}
function CallDetail({ detail, t }) {
    return (_jsxs("div", { className: css.callDetail, children: [_jsxs("div", { className: css.callDetailMeta, children: [_jsx("span", { children: detail.runner === 'codex-exec' ? t('call.runner.codex') : t('call.runner.unknown') }), _jsx("span", { children: t('call.model', { model: detail.model ?? t('call.modelUnknown') }) }), detail.modelRole != null ? _jsx("span", { children: t('call.modelRole', { role: detail.modelRole }) }) : null, detail.threadId !== undefined ? _jsx("span", { className: css.mono, children: detail.threadId }) : null, detail.isolation !== undefined ? _jsx("span", { children: detail.isolation }) : null] }), detail.messages.length > 0
                ? (_jsx("div", { className: css.callMessages, children: detail.messages.map(message => _jsx("pre", { children: message.text }, message.id)) }))
                : _jsx("div", { className: css.detailNote, children: t('call.noMessages') }), detail.activities.length > 0
                ? (_jsx("ul", { className: css.callActivities, children: detail.activities.map(activity => (_jsxs("li", { children: [_jsx("span", { children: activity.kind === 'web-search' ? t('call.webSearch') : t('call.tool') }), _jsx("span", { className: css.mono, children: activity.label }), _jsx("span", { children: activity.status })] }, activity.id))) }))
                : null, detail.truncated ? _jsx("div", { className: css.detailNote, children: t('call.truncated') }) : null] }));
}
function CallTreeNode({ call, selectedCandidateId, selected, detail, loading, error, onToggle, t, }) {
    const duration = durationSeconds(call.startedTs, call.endedTs);
    const chosen = selectedCandidateId !== undefined && call.label.endsWith(selectedCandidateId);
    return (_jsxs("li", { role: "treeitem", "aria-expanded": selected, className: css.callTreeItem, "data-call-status": call.status, children: [_jsxs("button", { type: "button", className: css.treeNodeButton, onClick: onToggle, "aria-label": t('call.open', { label: call.label }), children: [_jsx(StateDot, { state: callDotState(call.status) }), _jsx("span", { className: css.callLabel, title: call.callId, children: call.label }), chosen ? _jsx("span", { className: css.selectedBadge, children: t('run.result.chosen') }) : null, _jsxs("span", { className: css.callMeta, children: [call.kind === 'evaluation' ? t('call.evaluation') : null, call.rolledBack ? _jsx("span", { className: css.badge, children: t('call.rolledBack') }) : null, duration !== undefined ? _jsx("span", { children: duration }) : null, call.tokens !== undefined ? _jsxs("span", { children: [call.tokens.toLocaleString(), " tk"] }) : null] }), _jsx("span", { className: css.callStatus, children: t(CALL_STATUS_KEYS[call.status]) }), _jsx(IconChevronRightOutline14, {})] }), selected && loading ? _jsx("div", { className: css.detailNote, children: t('call.loading') }) : null, selected && error !== undefined ? _jsx("div", { className: css.detailError, children: error }) : null, selected && !loading && detail !== undefined ? _jsx(CallDetail, { detail: detail, t: t }) : null] }));
}
function hostStepStatus(detail, id) {
    return detail?.steps.find(step => step.id === id)?.status ?? 'pending';
}
function gateStepStatus(gate) {
    if (gate === 'pass' || gate === 'not_required')
        return 'completed';
    if (gate === 'fail')
        return 'failed';
    return 'pending';
}
function HostVerificationTree({ session, detail, result, t }) {
    const waiting = result?.stage === 'awaiting_host_verification';
    const verified = result?.stage === 'host_verified';
    const measurement = verified ? 'completed' : hostStepStatus(detail, 'measurement');
    const decision = session?.lifecycle === 'completed' ? 'completed' : hostStepStatus(detail, 'decision');
    if (!waiting && !verified && measurement === 'pending' && decision === 'pending')
        return null;
    const status = measurement === 'failed' || decision === 'failed'
        ? 'failed'
        : decision === 'completed'
            ? 'completed'
            : waiting || measurement === 'active' || decision === 'active'
                ? 'active'
                : 'pending';
    const steps = [
        { id: 'ownership', label: t('run.host.ownership'), status: gateStepStatus(session?.candidate_ownership) },
        { id: 'measurement', label: t('detail.step.measurement'), status: measurement },
        { id: 'decision', label: t('detail.step.decision'), status: decision },
    ];
    return (_jsxs("li", { role: "treeitem", "aria-expanded": true, className: css.hostTreeItem, "data-step-status": status, children: [_jsxs("div", { className: css.treeNode, children: [_jsx(StateDot, { state: classicStepDotState(status) }), _jsx("span", { children: t('run.host.title') }), _jsx("span", { className: css.phaseSummary, children: t(CLASSIC_STEP_STATUS_KEYS[status]) })] }), _jsx("ul", { role: "group", className: css.treeGroup, children: steps.map(step => (_jsxs("li", { role: "treeitem", className: css.hostStep, "data-step-status": step.status, children: [_jsx(StateDot, { state: classicStepDotState(step.status) }), _jsx("span", { children: step.label }), _jsx("span", { children: t(CLASSIC_STEP_STATUS_KEYS[step.status]) })] }, step.id))) })] }));
}
function WorkflowTree({ row, view, session, sessionDetail, state, loadCallDetail, t, }) {
    const [selectedCallId, setSelectedCallId] = useState();
    const result = workflowResultOf(view);
    const detailKey = selectedCallId === undefined ? undefined : `${view.runDir}\u0000${selectedCallId}`;
    return (_jsx("ul", { role: "tree", "aria-label": t('run.tree'), className: css.executionTree, children: _jsxs("li", { role: "treeitem", "aria-expanded": true, className: css.roundTreeItem, children: [_jsxs("div", { className: css.treeNode, children: [_jsx(StateDot, { state: session?.lifecycle === 'active' ? 'ongoing' : runDotState(view.status) }), _jsx("span", { children: session?.session_id ?? sessionName(view.sessionDir) }), _jsx("span", { children: row.round === undefined ? row.runId : `R${String(row.round).padStart(2, '0')}` })] }), _jsxs("ul", { role: "group", className: css.treeGroup, children: [_jsxs("li", { role: "treeitem", "aria-expanded": true, className: css.workflowTreeItem, children: [_jsxs("div", { className: css.treeNode, children: [_jsx(StateDot, { state: runDotState(view.status) }), _jsx("span", { children: view.workflow ?? view.runId }), _jsx("span", { children: t(RUN_STATUS_KEYS[view.status]) })] }), _jsx("ul", { role: "group", className: css.treeGroup, children: view.phases.map(phase => (_jsxs("li", { role: "treeitem", "aria-expanded": phase.calls.length > 0, className: css.phaseTreeItem, "data-phase-status": phase.status, "data-parallel": phase.calls.length > 1, children: [_jsxs("div", { className: css.treeNode, children: [_jsx(StateDot, { state: phaseDotState(phase.status) }), _jsx("span", { children: phase.title.length > 0 ? phase.title : t('phase.empty') }), _jsx("span", { children: phase.calls.length > 1
                                                            ? t('run.parallelCalls', { calls: phase.calls.length })
                                                            : t('run.calls', { calls: phase.calls.length }) })] }), phase.calls.length > 0
                                                ? (_jsx("ul", { role: "group", className: css.treeGroup, children: phase.calls.map((call) => {
                                                        const selected = selectedCallId === call.callId;
                                                        const errorPrefix = `${view.runDir}\u0000${call.callId}: `;
                                                        const callDetail = state.callDetails.get(`${view.runDir}\u0000${call.callId}`);
                                                        return (_jsx(CallTreeNode, { call: call, ...(result?.selectedCandidateId === undefined
                                                                ? {}
                                                                : { selectedCandidateId: result.selectedCandidateId }), selected: selected, loading: selected && state.callDetailLoading === detailKey, ...(state.callDetailError?.startsWith(errorPrefix) === true
                                                                ? { error: state.callDetailError.slice(errorPrefix.length) }
                                                                : {}), ...(callDetail === undefined ? {} : { detail: callDetail }), onToggle: () => {
                                                                const next = selected ? undefined : call.callId;
                                                                setSelectedCallId(next);
                                                                if (next !== undefined && state.callDetails.get(`${view.runDir}\u0000${next}`) === undefined) {
                                                                    void loadCallDetail(view.runDir, next);
                                                                }
                                                            }, t: t }, call.callId));
                                                    }) }))
                                                : null] }, `${phase.index}-${phase.title}`))) })] }), _jsx(HostVerificationTree, { session: session, detail: sessionDetail, result: result, t: t })] })] }) }));
}
function WorkflowResult({ result, t }) {
    return (_jsxs("section", { className: css.workflowResult, "aria-label": t('run.result.title'), children: [_jsxs("div", { className: css.resultHead, children: [_jsx("span", { className: css.detailTitle, children: t('run.result.title') }), result.stage !== undefined
                        ? _jsx("span", { className: css.resultStage, children: t('run.result.stage', { stage: result.stage }) })
                        : null] }), _jsxs("div", { className: css.resultMetrics, children: [result.verification !== undefined
                        ? _jsx("span", { "data-verification": result.verification, children: t(`run.result.verification.${result.verification}`) })
                        : null, result.failureKind !== undefined
                        ? _jsx("span", { className: css.failureBadge, children: t(FAILURE_KIND_KEYS[result.failureKind]) })
                        : null, result.selectedCandidateId !== undefined
                        ? _jsx("span", { children: t('run.result.selected', { candidate: result.selectedCandidateId }) })
                        : null, result.measuredCycles !== undefined
                        ? _jsx("span", { "data-measurement": "measured", children: t('run.result.cyclesMeasured', { cycles: result.measuredCycles.toLocaleString() }) })
                        : result.expectedCycles !== undefined
                            ? _jsx("span", { "data-measurement": "estimated", children: t('run.result.cyclesEstimated', { cycles: result.expectedCycles.toLocaleString() }) })
                            : null, result.measuredSpeedup !== undefined && result.measuredSpeedup !== null
                        ? _jsx("span", { "data-measurement": "measured", children: t('run.result.measured', { speedup: speedup(result.measuredSpeedup) }) })
                        : result.estimatedSpeedup !== undefined
                            ? _jsx("span", { "data-measurement": "estimated", children: t('run.result.estimated', { speedup: speedup(result.estimatedSpeedup) }) })
                            : _jsx("span", { "data-measurement": "pending", children: t('run.result.unmeasured') }), result.bestImproved === true
                        ? _jsx("span", { className: css.promotedBadge, children: t('run.result.promoted') })
                        : result.bestImproved === false
                            ? _jsx("span", { children: t('run.result.incumbentRetained') })
                            : null, result.incumbentCycles !== undefined
                        ? _jsx("span", { children: t('run.result.incumbentCycles', { cycles: result.incumbentCycles.toLocaleString() }) })
                        : null, result.verification === 'failed' && result.estimatedSpeedup !== undefined
                        ? _jsx("span", { className: css.excludedBadge, children: t('run.result.estimateExcluded') })
                        : null] }), result.candidates.length > 0
                ? (_jsx("ul", { className: css.candidates, children: result.candidates.map(candidate => (_jsxs("li", { className: css.candidate, "data-selected": candidate.id === result.selectedCandidateId, children: [_jsx("span", { className: css.mono, children: candidate.id }), candidate.id === result.selectedCandidateId && result.measuredCycles !== undefined
                                ? _jsx("span", { "data-measurement": "measured", children: t('run.result.cyclesMeasured', { cycles: result.measuredCycles.toLocaleString() }) })
                                : candidate.expectedCycles !== undefined
                                    ? _jsx("span", { children: t('run.result.cyclesEstimated', { cycles: candidate.expectedCycles.toLocaleString() }) })
                                    : null, candidate.id === result.selectedCandidateId ? _jsx("span", { children: t('run.result.chosen') }) : null] }, candidate.id))) }))
                : null] }));
}
function workflowResultOf(view) {
    const nested = view.result;
    const candidates = view.candidates ?? nested?.candidates ?? [];
    const stage = view.candidateStage ?? nested?.stage;
    const verification = view.verification ?? nested?.verification;
    const failureKind = view.failureKind ?? nested?.failureKind;
    const selectedCandidateId = view.selectedCandidateId ?? nested?.selectedCandidateId;
    const expectedCycles = view.expectedCycles ?? nested?.expectedCycles;
    const measuredBaselineCycles = view.measuredBaselineCycles ?? nested?.measuredBaselineCycles;
    const measuredCycles = view.measuredCycles ?? nested?.measuredCycles;
    const estimatedSpeedup = view.estimatedSpeedup ?? nested?.estimatedSpeedup;
    const measuredSpeedup = view.measuredSpeedup ?? nested?.measuredSpeedup;
    const incumbentCycles = view.incumbentCycles ?? nested?.incumbentCycles;
    const incumbentSpeedup = view.incumbentSpeedup ?? nested?.incumbentSpeedup;
    const bestImproved = view.bestImproved ?? nested?.bestImproved;
    if (stage === undefined && verification === undefined && selectedCandidateId === undefined
        && expectedCycles === undefined && measuredBaselineCycles === undefined && measuredCycles === undefined
        && estimatedSpeedup === undefined && measuredSpeedup === undefined && candidates.length === 0)
        return undefined;
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
    };
}
function RunDetail({ row, view, session, sessionDetail, crossWorkspace, state, loadCallDetail, t, }) {
    const result = workflowResultOf(view);
    const workflowWaiting = view.status === 'completed'
        && session?.lifecycle === 'active'
        && result?.stage === 'awaiting_host_verification';
    const statusLabel = workflowWaiting
        ? t('run.workflowCompletedHostPending')
        : view.status === 'completed' && session?.lifecycle === 'active'
            ? t('run.workflowCompletedSessionActive')
            : t(RUN_STATUS_KEYS[view.status]);
    return (_jsxs("div", { className: css.runDetail, children: [_jsxs("div", { className: css.runHead, children: [_jsx("span", { className: css.workflowIdentity, title: view.runDir, children: runDisplayLabel(row, session) }), _jsx("span", { className: css.runId, title: view.runDir, children: view.runId }), crossWorkspace ? _jsx("span", { className: css.workspaceBadge, children: t('session.otherWorkspace') }) : null, _jsxs("span", { className: css.statusTail, "data-status": view.status, children: [_jsx(StateDot, { state: workflowWaiting ? 'ongoing' : runDotState(view.status) }), _jsx("span", { children: statusLabel })] })] }), _jsxs("div", { className: css.runMeta, children: [view.currentPhase.length > 0 ? _jsx("span", { children: t('run.currentPhase', { phase: view.currentPhase }) }) : null, _jsx("span", { children: t('run.calls', { calls: view.totals.calls }) }), view.totals.tokens > 0 ? _jsx("span", { children: t('run.tokens', { tokens: view.totals.tokens.toLocaleString() }) }) : null] }), view.error !== undefined ? _jsx("div", { className: css.runError, children: t('run.error', { message: view.error }) }) : null, view.phases.length > 0
                ? (_jsx(WorkflowTree, { row: row, view: view, session: session, sessionDetail: sessionDetail, state: state, loadCallDetail: loadCallDetail, t: t }))
                : null, result !== undefined ? _jsx(WorkflowResult, { result: result, t: t }) : null] }));
}
function LauncherControls({ launcher, busy, start, stop, t }) {
    const labels = new Map(launcher.tasks.map(task => [task.id, task.label]));
    return (_jsxs("section", { className: css.launcher, "aria-label": t('launcher.title'), children: [_jsxs("div", { className: css.launcherHead, children: [_jsx("span", { className: css.launcherTitle, children: t('launcher.title') }), launcher.active.length > 0
                        ? _jsx("span", { className: css.launcherSummary, children: t('launcher.running', { count: launcher.active.length }) })
                        : null] }), _jsx("div", { className: css.taskList, children: launcher.tasks.map((task) => {
                    const key = `start:${task.id}`;
                    return (_jsxs("div", { className: css.taskRow, children: [_jsx("span", { className: css.taskLabel, children: task.label }), _jsx("button", { type: "button", className: css.controlButton, disabled: busy !== undefined, onClick: () => { void start(task.id); }, "data-busy": busy === key, children: t('launcher.start') })] }, task.id));
                }) }), launcher.active.length > 0
                ? (_jsx("div", { className: css.activeList, children: launcher.active.map(launch => (_jsxs("div", { className: css.activeRow, children: [_jsx(StateDot, { state: "ongoing" }), _jsxs("span", { className: css.activeLabel, title: launch.runDir, children: [labels.get(launch.taskId) ?? launch.taskId, _jsx("span", { className: css.activeRunId, children: launch.runId })] }), _jsx("button", { type: "button", className: css.controlButton, disabled: busy !== undefined, onClick: () => { void stop(launch.runDir); }, "data-busy": busy === `stop:${launch.runDir}`, children: t('launcher.stop') })] }, launch.runDir))) }))
                : null, launcher.error !== undefined
                ? _jsx("div", { className: css.readError, children: t('launcher.error', { message: launcher.error }) })
                : null] }));
}
function viewerHealth(snapshot) {
    const roots = snapshot.diagnostics.scan.roots;
    const readers = snapshot.diagnostics.runs;
    const rootIssues = roots.flatMap(root => root.lastIssue === undefined ? [] : [root.lastIssue]);
    const runIssues = readers.flatMap(run => run.lastIssue === undefined ? [] : [run.lastIssue]);
    const classicIssue = snapshot.classic.source.lastIssue;
    const issues = [...rootIssues, ...runIssues, ...(classicIssue === undefined ? [] : [classicIssue])];
    const classicFailed = snapshot.classic.source.state === 'failed';
    const degraded = snapshot.diagnostics.scan.state === 'degraded'
        || snapshot.diagnostics.scan.state === 'failed'
        || classicFailed
        || snapshot.classic.source.state === 'degraded'
        || readers.some(run => run.state === 'degraded' || run.state === 'failed');
    const noReadableSource = snapshot.diagnostics.scan.state === 'failed'
        && snapshot.classic.source.state !== 'healthy'
        && snapshot.classic.source.state !== 'degraded';
    const issue = snapshot.diagnostics.scan.lastIssue ?? classicIssue ?? runIssues.at(-1);
    return {
        state: noReadableSource ? 'failed' : degraded ? 'degraded' : 'healthy',
        roots: roots.length,
        readers: readers.length,
        sources: issues.length,
        ...(issue === undefined ? {} : { issue }),
    };
}
/** First-class KerSor view rendered beside Chat and Trajectory. */
export function KersorView({ t, store, currentWorkspace, refresh, loadRun, loadCallDetail, loadClassic, start, stop, }) {
    const [busy, setBusy] = useState();
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const rows = store.rows;
    const classicSessions = state.snapshot?.classic.sessions ?? [];
    const visibleRows = store.selectedClassicSessionDir === undefined
        ? rows
        : rows.filter(row => row.sessionDir === store.selectedClassicSessionDir);
    const health = state.snapshot === undefined ? undefined : viewerHealth(state.snapshot);
    useEffect(() => {
        void refresh();
    }, [refresh]);
    useEffect(() => {
        if (store.selectedRunDir !== undefined || store.selectedClassicSessionDir !== undefined
            || rows.length === 0)
            return;
        const currentSessions = classicSessions.filter(session => belongsToWorkspace(session.session_dir, currentWorkspace));
        const preferredSession = currentSessions.find(session => session.health === 'active')
            ?? currentSessions[0]
            ?? classicSessions.find(session => session.health === 'active')
            ?? classicSessions[0];
        const matching = preferredSession === undefined
            ? []
            : rows.filter(row => row.sessionDir === preferredSession.session_dir);
        const currentRows = rows.filter(row => belongsToWorkspace(row.sessionDir, currentWorkspace));
        const target = matching.sort((left, right) => (right.round ?? 0) - (left.round ?? 0))[0]
            ?? currentRows.find(row => row.discovery === 'active')
            ?? currentRows[0]
            ?? rows.find(row => row.discovery === 'active')
            ?? rows[0];
        if (target === undefined)
            return;
        store.select(target.runDir);
        void loadRun(target.runDir);
    }, [classicSessions, currentWorkspace, loadRun, rows, store]);
    const runStart = async (taskId) => {
        setBusy(`start:${taskId}`);
        try {
            await start(taskId);
        }
        finally {
            setBusy(undefined);
        }
    };
    const runStop = async (runDir) => {
        setBusy(`stop:${runDir}`);
        try {
            await stop(runDir);
        }
        finally {
            setBusy(undefined);
        }
    };
    const toggleClassic = (sessionDir) => {
        if (store.selectedClassicSessionDir === sessionDir) {
            store.selectClassic(undefined);
            return;
        }
        const runDir = store.selectClassic(sessionDir);
        void loadClassic(sessionDir);
        if (runDir !== undefined)
            void loadRun(runDir);
    };
    return (_jsxs("section", { className: css.view, "data-conversation-composer-overlay": "", "aria-label": t('panel.title'), children: [_jsxs("div", { className: css.header, children: [_jsx("span", { className: css.title, children: t('panel.title') }), _jsx("span", { className: css.note, children: t('panel.hint') })] }), _jsxs("div", { className: css.body, children: [state.launcher !== undefined
                        ? _jsx(LauncherControls, { launcher: state.launcher, busy: busy, start: runStart, stop: runStop, t: t })
                        : null, state.transportError !== undefined
                        ? _jsx("div", { className: css.readError, children: t('panel.readFailed', { message: state.transportError }) })
                        : null, health !== undefined && health.state !== 'healthy'
                        ? (_jsx("div", { className: css.readError, "data-source-health": health.state, children: t(health.state === 'failed' ? 'panel.sourcesFailed' : 'panel.sourcesDegraded', {
                                roots: health.roots,
                                readers: health.readers,
                                sources: health.sources,
                                stage: health.issue?.stage ?? 'source',
                                code: health.issue?.code ?? 'unavailable',
                                occurrences: health.issue?.occurrences ?? 1,
                            }) }))
                        : null, state.loading ? _jsx("div", { className: css.note, children: t('panel.loading') }) : null, !state.loading
                        && state.transportError === undefined
                        && health?.state === 'healthy'
                        && rows.length === 0
                        && classicSessions.length === 0
                        ? _jsx("div", { className: css.note, children: t('panel.empty', { roots: health.roots }) })
                        : null, classicSessions.length > 0
                        ? (_jsxs("section", { className: css.activitySection, "aria-label": t('session.title'), children: [_jsxs("div", { className: css.sectionHead, children: [_jsx("span", { className: css.sectionTitle, children: t('session.title') }), _jsx("span", { className: css.sectionSummary, children: t('session.summary', {
                                                count: classicSessions.length,
                                                active: classicSessions.filter(session => session.health === 'active').length,
                                            }) })] }), _jsx("ul", { className: css.classicRows, children: classicSessions.map(session => (_jsx(ClassicSessionRow, { session: session, selected: store.selectedClassicSessionDir === session.session_dir, crossWorkspace: !belongsToWorkspace(session.session_dir, currentWorkspace), loading: state.classicDetailLoading === session.session_dir, ...(state.classicDetails.get(session.session_dir) === undefined
                                            ? {}
                                            : { detail: state.classicDetails.get(session.session_dir) }), ...(state.classicDetailError?.startsWith(`${session.session_dir}: `) === true
                                            ? { error: state.classicDetailError.slice(session.session_dir.length + 2) }
                                            : {}), onToggle: () => { toggleClassic(session.session_dir); }, t: t }, session.session_dir))) })] }))
                        : null, visibleRows.length > 0
                        ? (_jsxs("section", { className: css.activitySection, "aria-label": t('run.sectionTitle'), children: [_jsxs("div", { className: css.sectionHead, children: [_jsx("span", { className: css.sectionTitle, children: t('run.sectionTitle') }), _jsx("span", { className: css.sectionSummary, children: visibleRows.length })] }), _jsx("ul", { className: css.rows, children: visibleRows.map((row) => {
                                        const session = classicSessions.find(candidate => candidate.session_dir === row.sessionDir);
                                        const crossWorkspace = !belongsToWorkspace(row.sessionDir, currentWorkspace);
                                        return (_jsxs("li", { className: css.row, "data-run-status": row.discovery, children: [_jsxs("button", { type: "button", className: css.rowHead, "aria-pressed": store.selectedRunDir === row.runDir, onClick: () => {
                                                        const next = store.selectedRunDir === row.runDir ? undefined : row.runDir;
                                                        store.select(next);
                                                        if (next !== undefined) {
                                                            void loadRun(next);
                                                            void loadClassic(row.sessionDir);
                                                        }
                                                    }, children: [_jsx(StateDot, { state: row.discovery === 'active' ? 'ongoing' : row.discovery === 'failed' ? 'error' : 'done' }), _jsx("span", { className: css.rowLabel, children: runDisplayLabel(row, session) }), _jsx("span", { className: css.runId, children: row.runId }), crossWorkspace ? _jsx("span", { className: css.workspaceBadge, children: t('session.otherWorkspace') }) : null] }), store.selectedRunDir === row.runDir && row.view !== undefined
                                                    ? (_jsx(RunDetail, { row: row, view: row.view, session: session, sessionDetail: state.classicDetails.get(row.sessionDir), crossWorkspace: crossWorkspace, state: state, loadCallDetail: loadCallDetail, t: t }))
                                                    : null] }, row.runDir));
                                    }) })] }))
                        : null] })] }));
}
//# sourceMappingURL=KersorView.js.map