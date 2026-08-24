/**
 * Read-only adapter from the installed KerSor preset bridge to the viewer.
 * @module @deepseek-ai/dsh-kersor-viewer
 */
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createIssue, errorCode, issueFromError } from "./diagnostics.js";
const execFileAsync = promisify(execFile);
const MAX_CLASSIC_ROUNDS = 100;
function dshHome() {
    const configured = process.env.DSH_HOME?.trim();
    if (!configured)
        return path.join(homedir(), '.dsh');
    if (configured === '~')
        return homedir();
    return configured.startsWith('~/')
        ? path.join(homedir(), configured.slice(2))
        : path.resolve(configured);
}
/**
 * Resolve the bridge path copied by the portable preset installer.
 * @returns Absolute bridge path under the configured DSH home.
 */
export function installedBridge() {
    return path.join(dshHome(), '.agent-presets', 'kersor', 'bin', 'kersor_bridge.py');
}
function kersorPython() {
    return process.env.KERSOR_PYTHON?.trim() || 'python3';
}
function optionalString(value) {
    return value === undefined || value === null || typeof value === 'string';
}
function optionalDetailString(value) {
    return value === undefined || typeof value === 'string';
}
function optionalBoolean(value) {
    return value === undefined || value === null || typeof value === 'boolean';
}
function optionalNumber(value) {
    return value === undefined || value === null || typeof value === 'number';
}
function finiteNonNegative(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function optionalFiniteNonNegative(value) {
    return value === undefined || finiteNonNegative(value);
}
function optionalBoundedString(value, maximum) {
    return value === undefined || (typeof value === 'string' && Buffer.byteLength(value) <= maximum);
}
function optionalGate(value) {
    return value === undefined || value === null
        || value === 'pass' || value === 'fail' || value === 'pending' || value === 'not_required';
}
function optionalBaselineAction(value) {
    return value === undefined || value === null
        || value === 'init' || value === 'record_verify' || value === 'new_session';
}
function stringArray(value) {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}
function isClassicArtifact(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const artifact = value;
    return typeof artifact.name === 'string'
        && typeof artifact.sha256 === 'string'
        && typeof artifact.bytes === 'number' && Number.isInteger(artifact.bytes) && artifact.bytes >= 0;
}
function isClassicValidationCheck(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const check = value;
    return typeof check.name === 'string' && typeof check.passed === 'boolean';
}
function isClassicCycleLineage(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const lineage = value;
    const fields = [
        lineage.session_baseline_cycles,
        lineage.best_cycles,
        lineage.session_speedup,
        lineage.task_baseline_cycles,
        lineage.overall_speedup,
    ];
    return fields.some(field => field !== undefined) && fields.every(optionalFiniteNonNegative);
}
function isClassicRoundEstimate(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const estimate = value;
    const fields = [estimate.cycles, estimate.speedup];
    return fields.some(field => field !== undefined) && fields.every(optionalFiniteNonNegative);
}
function isClassicRoundMeasurement(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const measurement = value;
    const fields = [
        measurement.baseline_cycles,
        measurement.candidate_cycles,
        measurement.candidate_speedup,
        measurement.incumbent_cycles,
        measurement.incumbent_speedup,
        measurement.overall_speedup,
    ];
    return fields.some(field => field !== undefined) && fields.every(optionalFiniteNonNegative)
        && (measurement.best_improved === undefined || typeof measurement.best_improved === 'boolean');
}
function isClassicRound(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const round = value;
    if (typeof round.number !== 'number' || !Number.isInteger(round.number) || round.number < 1
        || !optionalBoundedString(round.workflow, 1024)
        || !optionalBoundedString(round.candidate_id, 1024)
        || !optionalBoundedString(round.decision, 8192)
        || (round.workflow_origin !== undefined && !['catalog', 'authored'].includes(round.workflow_origin))
        || !['pending', 'pass', 'fail'].includes(round.host_verdict ?? ''))
        return false;
    if (round.failure_kind !== undefined
        && !['correctness', 'benchmark', 'infrastructure'].includes(round.failure_kind))
        return false;
    if (round.estimate !== undefined && !isClassicRoundEstimate(round.estimate))
        return false;
    if (round.measurement !== undefined && !isClassicRoundMeasurement(round.measurement))
        return false;
    if (round.host_verdict !== 'pass' && round.measurement !== undefined)
        return false;
    if (round.host_verdict !== 'fail' && round.failure_kind !== undefined)
        return false;
    return true;
}
function isClassicRounds(value) {
    if (!Array.isArray(value) || value.length > MAX_CLASSIC_ROUNDS || !value.every(isClassicRound))
        return false;
    return value.every((round, index) => index === 0 || round.number > (value[index - 1]?.number ?? 0));
}
function isClassicWorkflowPhase(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const phase = value;
    return typeof phase.title === 'string' && typeof phase.detail === 'string';
}
function isClassicWorkflowDesign(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const design = value;
    return optionalDetailString(design.name)
        && optionalDetailString(design.description)
        && optionalDetailString(design.whenToUse)
        && optionalDetailString(design.technique)
        && optionalDetailString(design.methodCategory)
        && optionalDetailString(design.topology)
        && (design.phases === undefined
            || (Array.isArray(design.phases) && design.phases.every(isClassicWorkflowPhase)))
        && stringArray(design.requiredArgs)
        && stringArray(design.languages)
        && stringArray(design.backends)
        && stringArray(design.integrationPatterns)
        && typeof design.rationale === 'string'
        && typeof design.source === 'string';
}
function isClassicSessionDetail(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const detail = value;
    if (typeof detail.session_id !== 'string' || typeof detail.session_dir !== 'string'
        || typeof detail.current_round !== 'number' || !Number.isInteger(detail.current_round)
        || detail.current_round < 1 || !Array.isArray(detail.steps))
        return false;
    const validStepIds = new Set([
        'setup', 'baseline', 'profile', 'selection', 'authoring', 'validation',
        'dispatch', 'measurement', 'decision',
    ]);
    const validStepStatuses = new Set(['pending', 'active', 'completed', 'failed']);
    if (!detail.steps.every(step => step !== null && typeof step === 'object'
        && validStepIds.has(step.id)
        && validStepStatuses.has(step.status)))
        return false;
    const selection = detail.selection;
    if (selection === undefined || !['pending', 'stalled', 'selected'].includes(selection.status)
        || typeof selection.rejectedCount !== 'number' || !Number.isInteger(selection.rejectedCount)
        || selection.rejectedCount < 0 || !optionalDetailString(selection.workflow)
        || !optionalDetailString(selection.reason))
        return false;
    const authoring = detail.authoring;
    if (authoring === undefined
        || !['not_started', 'in_progress', 'sealed', 'saved', 'rejected'].includes(authoring.status)
        || !Array.isArray(authoring.files)
        || !authoring.files.every(isClassicArtifact))
        return false;
    if (authoring.omittedReason !== undefined
        && !['too_large', 'invalid', 'hash_mismatch'].includes(authoring.omittedReason))
        return false;
    if (authoring.design !== undefined) {
        if (!isClassicWorkflowDesign(authoring.design))
            return false;
    }
    const validation = detail.validation;
    if (validation === undefined || !['pending', 'passed', 'failed'].includes(validation.status)
        || !Array.isArray(validation.checks)
        || !validation.checks.every(isClassicValidationCheck))
        return false;
    if (detail.rounds !== undefined && !isClassicRounds(detail.rounds))
        return false;
    const dispatch = detail.dispatch;
    return dispatch !== undefined
        && ['pending', 'preparing', 'running', 'completed', 'failed'].includes(dispatch.status)
        && optionalDetailString(dispatch.runDir)
        && optionalDetailString(dispatch.runtimeStatus)
        && (detail.workflow === undefined || isClassicWorkflowDesign(detail.workflow));
}
function isClassicSession(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const row = value;
    return typeof row.session_id === 'string'
        && typeof row.session_dir === 'string'
        && (row.storage_kind === 'v2' || row.storage_kind === 'legacy')
        && (row.lifecycle === 'active' || row.lifecycle === 'completed'
            || row.lifecycle === 'stalled' || row.lifecycle === 'cancelled')
        && (row.health === 'active' || row.health === 'stale' || row.health === 'needs_resume'
            || row.health === 'terminal' || row.health === 'unknown')
        && (row.status === 'terminal-complete' || row.status === 'terminal-stalled'
            || row.status === 'terminal-cancelled' || row.status === 'resumable'
            || row.status === 'in-progress' || row.status === 'pre-round-1')
        && optionalString(row.kernel_language)
        && optionalString(row.backend)
        && optionalString(row.integration_pattern)
        && optionalBoolean(row.allow_workflow_authoring)
        && optionalNumber(row.workflow_authoring_budget)
        && optionalNumber(row.workflow_authoring_used)
        && (row.workflow_authoring_used === undefined || row.workflow_authoring_used === null
            || (Number.isInteger(row.workflow_authoring_used) && row.workflow_authoring_used >= 0))
        && (row.workflow_authoring_budget === undefined || row.workflow_authoring_budget === null
            || row.workflow_authoring_used === undefined || row.workflow_authoring_used === null
            || row.workflow_authoring_used <= row.workflow_authoring_budget)
        && (row.selection_status === undefined || row.selection_status === null
            || ['pending', 'stalled', 'selected'].includes(row.selection_status))
        && optionalString(row.decision)
        && optionalString(row.fit_confidence)
        && optionalGate(row.baseline_witness)
        && optionalBaselineAction(row.baseline_next_action)
        && optionalString(row.baseline_reason)
        && optionalGate(row.profile_evidence)
        && optionalString(row.profile_reason)
        && optionalString(row.profile_owner)
        && optionalGate(row.dsh_compatibility)
        && optionalGate(row.candidate_ownership)
        && optionalGate(row.fresh_session)
        && (row.stop_reason === undefined || row.stop_reason === null
            || ['target_met', 'execution_budget_exhausted', 'selection_stalled',
                'authoring_budget_exhausted', 'cancelled', 'single_run_complete'].includes(row.stop_reason))
        && (row.cycle_lineage === undefined || row.cycle_lineage === null
            || isClassicCycleLineage(row.cycle_lineage))
        && Array.isArray(row.warnings)
        && row.warnings.every(item => typeof item === 'string');
}
function projectCycleLineage(value) {
    return {
        ...(value.session_baseline_cycles === undefined
            ? {} : { session_baseline_cycles: value.session_baseline_cycles }),
        ...(value.best_cycles === undefined ? {} : { best_cycles: value.best_cycles }),
        ...(value.session_speedup === undefined ? {} : { session_speedup: value.session_speedup }),
        ...(value.task_baseline_cycles === undefined
            ? {} : { task_baseline_cycles: value.task_baseline_cycles }),
        ...(value.overall_speedup === undefined ? {} : { overall_speedup: value.overall_speedup }),
    };
}
function projectClassicRound(row) {
    const estimate = row.estimate === undefined ? undefined : {
        ...(row.estimate.cycles === undefined ? {} : { cycles: row.estimate.cycles }),
        ...(row.estimate.speedup === undefined ? {} : { speedup: row.estimate.speedup }),
    };
    const measurement = row.measurement === undefined ? undefined : {
        ...(row.measurement.baseline_cycles === undefined
            ? {} : { baseline_cycles: row.measurement.baseline_cycles }),
        ...(row.measurement.candidate_cycles === undefined
            ? {} : { candidate_cycles: row.measurement.candidate_cycles }),
        ...(row.measurement.candidate_speedup === undefined
            ? {} : { candidate_speedup: row.measurement.candidate_speedup }),
        ...(row.measurement.incumbent_cycles === undefined
            ? {} : { incumbent_cycles: row.measurement.incumbent_cycles }),
        ...(row.measurement.incumbent_speedup === undefined
            ? {} : { incumbent_speedup: row.measurement.incumbent_speedup }),
        ...(row.measurement.best_improved === undefined
            ? {} : { best_improved: row.measurement.best_improved }),
        ...(row.measurement.overall_speedup === undefined
            ? {} : { overall_speedup: row.measurement.overall_speedup }),
    };
    return {
        number: row.number,
        ...(row.workflow === undefined ? {} : { workflow: row.workflow }),
        ...(row.workflow_origin === undefined ? {} : { workflow_origin: row.workflow_origin }),
        ...(row.candidate_id === undefined ? {} : { candidate_id: row.candidate_id }),
        host_verdict: row.host_verdict,
        ...(row.failure_kind === undefined ? {} : { failure_kind: row.failure_kind }),
        ...(estimate === undefined ? {} : { estimate }),
        ...(measurement === undefined ? {} : { measurement }),
        ...(row.decision === undefined ? {} : { decision: row.decision }),
    };
}
function projectWorkflowDesign(design) {
    return {
        ...(design.name === undefined ? {} : { name: design.name }),
        ...(design.description === undefined ? {} : { description: design.description }),
        ...(design.whenToUse === undefined ? {} : { whenToUse: design.whenToUse }),
        ...(design.technique === undefined ? {} : { technique: design.technique }),
        ...(design.methodCategory === undefined ? {} : { methodCategory: design.methodCategory }),
        ...(design.topology === undefined ? {} : { topology: design.topology }),
        ...(design.phases === undefined
            ? {} : { phases: design.phases.map(phase => ({ title: phase.title, detail: phase.detail })) }),
        requiredArgs: [...design.requiredArgs],
        languages: [...design.languages],
        backends: [...design.backends],
        integrationPatterns: [...design.integrationPatterns],
        rationale: design.rationale,
        source: design.source,
    };
}
function projectSessionDetail(row) {
    return {
        session_id: row.session_id,
        session_dir: row.session_dir,
        current_round: row.current_round,
        steps: row.steps.map(step => ({ id: step.id, status: step.status })),
        selection: {
            status: row.selection.status,
            ...(row.selection.workflow === undefined ? {} : { workflow: row.selection.workflow }),
            ...(row.selection.reason === undefined ? {} : { reason: row.selection.reason }),
            rejectedCount: row.selection.rejectedCount,
        },
        authoring: {
            status: row.authoring.status,
            files: row.authoring.files.map(file => ({
                name: file.name, sha256: file.sha256, bytes: file.bytes,
            })),
            ...(row.authoring.design === undefined
                ? {} : { design: projectWorkflowDesign(row.authoring.design) }),
            ...(row.authoring.omittedReason === undefined
                ? {} : { omittedReason: row.authoring.omittedReason }),
        },
        validation: {
            status: row.validation.status,
            checks: row.validation.checks.map(check => ({ name: check.name, passed: check.passed })),
        },
        dispatch: {
            status: row.dispatch.status,
            ...(row.dispatch.runDir === undefined ? {} : { runDir: row.dispatch.runDir }),
            ...(row.dispatch.runtimeStatus === undefined
                ? {} : { runtimeStatus: row.dispatch.runtimeStatus }),
        },
        rounds: (row.rounds ?? []).map(projectClassicRound),
        ...(row.workflow === undefined ? {} : { workflow: projectWorkflowDesign(row.workflow) }),
    };
}
function projectSession(row) {
    return {
        session_id: row.session_id,
        session_dir: row.session_dir,
        storage_kind: row.storage_kind,
        phase: row.phase ?? null,
        lifecycle: row.lifecycle,
        status: row.status,
        health: row.health,
        started_at: row.started_at ?? null,
        last_activity_at: row.last_activity_at ?? null,
        current_round: row.current_round ?? null,
        max_workflows: row.max_workflows ?? null,
        target_speedup: row.target_speedup ?? null,
        target_met: row.target_met ?? null,
        mode: row.mode ?? null,
        backend: row.backend ?? null,
        kernel_language: row.kernel_language ?? null,
        integration_pattern: row.integration_pattern ?? null,
        allow_workflow_authoring: row.allow_workflow_authoring ?? null,
        workflow_authoring_budget: row.workflow_authoring_budget ?? null,
        workflow_authoring_used: row.workflow_authoring_used ?? null,
        kernel_name: row.kernel_name ?? null,
        workflow: row.workflow ?? null,
        selection_status: row.selection_status ?? null,
        decision: row.decision ?? null,
        fit_confidence: row.fit_confidence ?? null,
        baseline_witness: row.baseline_witness ?? null,
        baseline_next_action: row.baseline_next_action ?? null,
        baseline_reason: row.baseline_reason ?? null,
        profile_evidence: row.profile_evidence ?? null,
        profile_reason: row.profile_reason ?? null,
        profile_owner: row.profile_owner ?? null,
        dsh_compatibility: row.dsh_compatibility ?? null,
        candidate_ownership: row.candidate_ownership ?? null,
        fresh_session: row.fresh_session ?? null,
        best_speedup: row.best_speedup ?? null,
        stop_reason: row.stop_reason ?? null,
        cycle_lineage: row.cycle_lineage === undefined || row.cycle_lineage === null
            ? null
            : projectCycleLineage(row.cycle_lineage),
        warningCount: row.warnings.length,
    };
}
/**
 * Read a sealed, bounded inspector projection for one classic Session.
 * @param sessionDir - Exact Session directory already discovered by the Host.
 * @returns Valid detail, or `undefined` when the bridge cannot provide it.
 */
export async function readClassicSessionDetail(sessionDir) {
    try {
        const { stdout } = await execFileAsync(kersorPython(), [
            installedBridge(), 'session-detail', '--session', path.resolve(sessionDir),
        ], {
            encoding: 'utf8',
            maxBuffer: 2 * 1024 * 1024,
            timeout: 10_000,
        });
        const decoded = JSON.parse(stdout);
        return isClassicSessionDetail(decoded) ? projectSessionDetail(decoded) : undefined;
    }
    catch {
        // A selectable Session remains usable as a summary when detail is unavailable.
        return undefined;
    }
}
/**
 * Invoke the installed bridge without a shell and return a bounded snapshot.
 * @param limit - Maximum recent Sessions to retain.
 * @param staleAfterSeconds - Advisory unfinished-Session inactivity threshold.
 * @param roots - Configured, persisted, and Workspace roots supplied by the Host.
 * @returns Valid Session summaries plus structured bridge health.
 */
export async function readClassicSessions(limit, staleAfterSeconds = 1800, roots = {}) {
    const bridge = installedBridge();
    try {
        await access(bridge);
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return { sessions: [], source: { state: 'not_installed' } };
        return { sessions: [], source: { state: 'failed', lastIssue: issueFromError('classic_bridge', error) } };
    }
    try {
        const args = [
            bridge,
            'sessions',
            '--limit', String(limit),
            '--stale-after', String(staleAfterSeconds),
        ];
        for (const root of roots.sessionRoots ?? []) {
            if (root.trim())
                args.push('--root', root);
        }
        for (const workspace of roots.workspaceRoots ?? []) {
            if (workspace.trim())
                args.push('--workspace', workspace);
        }
        if (roots.includeCheckoutRoot === false)
            args.push('--no-checkout-root');
        const { stdout } = await execFileAsync(kersorPython(), args, {
            encoding: 'utf8',
            maxBuffer: 2 * 1024 * 1024,
            timeout: 10_000,
        });
        let decoded;
        try {
            decoded = JSON.parse(stdout);
        }
        catch (error) {
            return { sessions: [], source: { state: 'failed', lastIssue: issueFromError('classic_bridge', error) } };
        }
        if (!Array.isArray(decoded.sessions) || !decoded.sessions.every(isClassicSession)) {
            return {
                sessions: [],
                source: { state: 'failed', lastIssue: createIssue('classic_bridge', 'invalid_payload') },
            };
        }
        const degraded = Array.isArray(decoded.warnings) && decoded.warnings.length > 0;
        return {
            sessions: decoded.sessions.slice(0, limit).map(projectSession),
            source: degraded
                ? { state: 'degraded', lastIssue: createIssue('classic_bridge', 'io_error', 'warning') }
                : { state: 'healthy' },
        };
    }
    catch (error) {
        return { sessions: [], source: { state: 'failed', lastIssue: issueFromError('classic_bridge', error) } };
    }
}
//# sourceMappingURL=classic.js.map