/**
 * Read-only adapter from the installed KerSor preset bridge to the viewer.
 * @module @deepseek-ai/dsh-kersor-viewer
 */

import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createIssue, errorCode, issueFromError } from './diagnostics.ts'
import type { KersorDiagnosticIssue } from './diagnostics.ts'

const execFileAsync = promisify(execFile)

/** Canonical lifecycle read from the KerSor Session store. */
export type KersorClassicLifecycle = 'active' | 'completed' | 'stalled' | 'cancelled'
/** Advisory artifact health, kept separate from canonical lifecycle. */
export type KersorClassicHealth = 'active' | 'stale' | 'needs_resume' | 'terminal' | 'unknown'
/** Four-state result of one deterministic protocol gate. */
export type KersorClassicGate = 'pass' | 'fail' | 'pending' | 'not_required'
/** Canonical next action for an incomplete Session baseline witness. */
export type KersorBaselineAction = 'init' | 'record_verify' | 'new_session'
/** Canonical terminal cause, distinct from resumability and health. */
export type KersorClassicStopReason =
  | 'target_met'
  | 'execution_budget_exhausted'
  | 'selection_stalled'
  | 'authoring_budget_exhausted'
  | 'cancelled'
  | 'single_run_complete'
/** User-facing combination of lifecycle and resumability. */
export type KersorClassicStatus =
  | 'terminal-complete'
  | 'terminal-stalled'
  | 'terminal-cancelled'
  | 'resumable'
  | 'in-progress'
  | 'pre-round-1'

/** One recent optimization Session projected by the canonical KerSor stores. */
export interface KersorClassicSession {
  readonly session_id: string
  readonly session_dir: string
  readonly storage_kind: 'v2' | 'legacy'
  readonly phase?: string | null
  readonly lifecycle: KersorClassicLifecycle
  readonly status: KersorClassicStatus
  readonly health: KersorClassicHealth
  readonly started_at?: string | null
  readonly last_activity_at?: string | null
  readonly current_round?: number | null
  readonly max_workflows?: number | null
  readonly target_speedup?: number | null
  readonly target_met?: boolean | null
  readonly mode?: string | null
  readonly backend?: string | null
  readonly kernel_language?: string | null
  readonly integration_pattern?: string | null
  readonly allow_workflow_authoring?: boolean | null
  readonly workflow_authoring_budget?: number | null
  readonly workflow_authoring_used?: number | null
  readonly kernel_name?: string | null
  readonly workflow?: string | null
  /** Outcome of the deterministic selector, separate from a Workflow name. */
  readonly selection_status?: 'pending' | 'stalled' | 'selected' | null
  /** Latest canonical COMPLETE/CONTINUE/STALLED line, when a round has decided. */
  readonly decision?: string | null
  readonly fit_confidence?: string | null
  readonly baseline_witness?: KersorClassicGate | null
  readonly baseline_next_action?: KersorBaselineAction | null
  readonly baseline_reason?: string | null
  readonly profile_evidence?: KersorClassicGate | null
  readonly profile_reason?: string | null
  readonly profile_owner?: string | null
  readonly dsh_compatibility?: KersorClassicGate | null
  readonly candidate_ownership?: KersorClassicGate | null
  readonly fresh_session?: KersorClassicGate | null
  readonly best_speedup?: number | null
  readonly stop_reason?: KersorClassicStopReason | null
  /** Host-verified cycle lineage; Workflow estimates never contribute. */
  readonly cycle_lineage?: KersorClassicCycleLineage | null
  readonly warningCount: number
}

/** Host-verified lineage from the task baseline through the Session incumbent. */
export interface KersorClassicCycleLineage {
  readonly session_baseline_cycles?: number
  readonly best_cycles?: number
  readonly session_speedup?: number
  readonly task_baseline_cycles?: number
  readonly overall_speedup?: number
}

/** Workflow-authored estimate, never presented as Host measurement. */
export interface KersorClassicRoundEstimate {
  readonly cycles?: number
  readonly speedup?: number
}

/** Measurement accepted by the Host correctness and benchmark gates. */
export interface KersorClassicRoundMeasurement {
  readonly baseline_cycles?: number
  readonly candidate_cycles?: number
  readonly candidate_speedup?: number
  readonly incumbent_cycles?: number
  readonly incumbent_speedup?: number
  readonly best_improved?: boolean
  readonly overall_speedup?: number
}

/** One bounded round in the canonical Session chronology. */
export interface KersorClassicRound {
  readonly number: number
  readonly workflow?: string
  readonly workflow_origin?: 'catalog' | 'authored'
  readonly candidate_id?: string
  readonly host_verdict: 'pending' | 'pass' | 'fail'
  readonly failure_kind?: 'correctness' | 'benchmark' | 'infrastructure'
  readonly estimate?: KersorClassicRoundEstimate
  readonly measurement?: KersorClassicRoundMeasurement
  readonly decision?: string
}

/** Stable stage identifiers rendered by the classic Session inspector. */
export type KersorClassicStepId =
  | 'setup'
  | 'baseline'
  | 'profile'
  | 'selection'
  | 'authoring'
  | 'validation'
  | 'dispatch'
  | 'measurement'
  | 'decision'

/** Artifact-derived lifecycle of one inspector stage. */
export type KersorClassicStepStatus = 'pending' | 'active' | 'completed' | 'failed'

/** One artifact-derived step in a classic optimization Session. */
export interface KersorClassicStep {
  readonly id: KersorClassicStepId
  readonly status: KersorClassicStepStatus
}

/** Selector outcome kept separate from authored or released Workflow identity. */
export interface KersorClassicSelectionDetail {
  readonly status: 'pending' | 'stalled' | 'selected'
  readonly workflow?: string
  readonly reason?: string
  readonly rejectedCount: number
}

/** One sealed or persisted Workflow file. */
export interface KersorClassicArtifact {
  readonly name: string
  readonly sha256: string
  readonly bytes: number
}

/** One declared phase in the selected Workflow's portable DSH envelope. */
export interface KersorClassicWorkflowPhase {
  readonly title: string
  readonly detail: string
}

/** Curated routing metadata plus sealed, read-only design text. */
export interface KersorClassicWorkflowDesign {
  readonly name?: string
  readonly description?: string
  readonly whenToUse?: string
  readonly technique?: string
  readonly methodCategory?: string
  readonly topology?: string
  readonly phases?: readonly KersorClassicWorkflowPhase[]
  readonly requiredArgs: readonly string[]
  readonly languages: readonly string[]
  readonly backends: readonly string[]
  readonly integrationPatterns: readonly string[]
  readonly rationale: string
  readonly source: string
}

/** Foreground authoring state. Design content is absent until the handoff is sealed. */
export interface KersorClassicAuthoringDetail {
  readonly status: 'not_started' | 'in_progress' | 'sealed' | 'saved' | 'rejected'
  readonly files: readonly KersorClassicArtifact[]
  readonly design?: KersorClassicWorkflowDesign
  readonly omittedReason?: 'too_large' | 'invalid' | 'hash_mismatch'
}

/** One deterministic Proposal validation result. */
export interface KersorClassicValidationCheck {
  readonly name: string
  readonly passed: boolean
}

/** Bounded result of the canonical Proposal save validator. */
export interface KersorClassicValidationDetail {
  readonly status: 'pending' | 'passed' | 'failed'
  readonly checks: readonly KersorClassicValidationCheck[]
}

/** Dispatch preparation and Workflow Host lifecycle for the current round. */
export interface KersorClassicDispatchDetail {
  readonly status: 'pending' | 'preparing' | 'running' | 'completed' | 'failed'
  readonly runDir?: string
  readonly runtimeStatus?: string
}

/** On-demand inspector projection for one already-discovered classic Session. */
export interface KersorClassicSessionDetail {
  readonly session_id: string
  readonly session_dir: string
  readonly current_round: number
  readonly steps: readonly KersorClassicStep[]
  readonly selection: KersorClassicSelectionDetail
  readonly authoring: KersorClassicAuthoringDetail
  readonly validation: KersorClassicValidationDetail
  readonly dispatch: KersorClassicDispatchDetail
  /** Complete bounded chronology supplied on demand, ordered by round number. */
  readonly rounds: readonly KersorClassicRound[]
  /** Hash-verified selected Workflow, whether released or Session-authored. */
  readonly workflow?: KersorClassicWorkflowDesign
}

/** Health of the optional classic-Session bridge. */
export interface KersorClassicSource {
  readonly state: 'disabled' | 'not_installed' | 'healthy' | 'degraded' | 'failed'
  readonly lastIssue?: KersorDiagnosticIssue
}

/** Bounded recent-session inventory and its structured source state. */
export interface KersorClassicSnapshot {
  readonly sessions: readonly KersorClassicSession[]
  readonly source: KersorClassicSource
}

/** Machine-local roots supplied by viewer configuration and DSH workspaces. */
export interface KersorClassicRoots {
  readonly includeCheckoutRoot?: boolean
  readonly sessionRoots?: readonly string[]
  readonly workspaceRoots?: readonly string[]
}

interface RawClassicSession extends Omit<KersorClassicSession, 'warningCount'> {
  readonly warnings: readonly string[]
}

interface RawClassicSessionDetail extends Omit<KersorClassicSessionDetail, 'rounds'> {
  readonly rounds?: readonly KersorClassicRound[]
}

const MAX_CLASSIC_ROUNDS = 100

function dshHome(): string {
  const configured = process.env.DSH_HOME?.trim()
  if (!configured) return path.join(homedir(), '.dsh')
  if (configured === '~') return homedir()
  return configured.startsWith('~/')
    ? path.join(homedir(), configured.slice(2))
    : path.resolve(configured)
}

/**
 * Resolve the bridge path copied by the portable preset installer.
 * @returns Absolute bridge path under the configured DSH home.
 */
export function installedBridge(): string {
  return path.join(dshHome(), '.agent-presets', 'kersor', 'bin', 'kersor_bridge.py')
}

function kersorPython(): string {
  return process.env.KERSOR_PYTHON?.trim() || 'python3'
}

function optionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string'
}

function optionalDetailString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'boolean'
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'number'
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function optionalFiniteNonNegative(value: unknown): boolean {
  return value === undefined || finiteNonNegative(value)
}

function optionalBoundedString(value: unknown, maximum: number): boolean {
  return value === undefined || (typeof value === 'string' && Buffer.byteLength(value) <= maximum)
}

function optionalGate(value: unknown): boolean {
  return value === undefined || value === null
    || value === 'pass' || value === 'fail' || value === 'pending' || value === 'not_required'
}

function optionalBaselineAction(value: unknown): boolean {
  return value === undefined || value === null
    || value === 'init' || value === 'record_verify' || value === 'new_session'
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isClassicArtifact(value: unknown): value is KersorClassicArtifact {
  if (value === null || typeof value !== 'object') return false
  const artifact = value as Partial<KersorClassicArtifact>
  return typeof artifact.name === 'string'
    && typeof artifact.sha256 === 'string'
    && typeof artifact.bytes === 'number' && Number.isInteger(artifact.bytes) && artifact.bytes >= 0
}

function isClassicValidationCheck(value: unknown): value is KersorClassicValidationCheck {
  if (value === null || typeof value !== 'object') return false
  const check = value as Partial<KersorClassicValidationCheck>
  return typeof check.name === 'string' && typeof check.passed === 'boolean'
}

function isClassicCycleLineage(value: unknown): value is KersorClassicCycleLineage {
  if (value === null || typeof value !== 'object') return false
  const lineage = value as Partial<KersorClassicCycleLineage>
  const fields = [
    lineage.session_baseline_cycles,
    lineage.best_cycles,
    lineage.session_speedup,
    lineage.task_baseline_cycles,
    lineage.overall_speedup,
  ]
  return fields.some(field => field !== undefined) && fields.every(optionalFiniteNonNegative)
}

function isClassicRoundEstimate(value: unknown): value is KersorClassicRoundEstimate {
  if (value === null || typeof value !== 'object') return false
  const estimate = value as Partial<KersorClassicRoundEstimate>
  const fields = [estimate.cycles, estimate.speedup]
  return fields.some(field => field !== undefined) && fields.every(optionalFiniteNonNegative)
}

function isClassicRoundMeasurement(value: unknown): value is KersorClassicRoundMeasurement {
  if (value === null || typeof value !== 'object') return false
  const measurement = value as Partial<KersorClassicRoundMeasurement>
  const fields = [
    measurement.baseline_cycles,
    measurement.candidate_cycles,
    measurement.candidate_speedup,
    measurement.incumbent_cycles,
    measurement.incumbent_speedup,
    measurement.overall_speedup,
  ]
  return fields.some(field => field !== undefined) && fields.every(optionalFiniteNonNegative)
    && (measurement.best_improved === undefined || typeof measurement.best_improved === 'boolean')
}

function isClassicRound(value: unknown): value is KersorClassicRound {
  if (value === null || typeof value !== 'object') return false
  const round = value as Partial<KersorClassicRound>
  if (typeof round.number !== 'number' || !Number.isInteger(round.number) || round.number < 1
    || !optionalBoundedString(round.workflow, 1024)
    || !optionalBoundedString(round.candidate_id, 1024)
    || !optionalBoundedString(round.decision, 8192)
    || (round.workflow_origin !== undefined && !['catalog', 'authored'].includes(round.workflow_origin))
    || !['pending', 'pass', 'fail'].includes(round.host_verdict ?? '')) return false
  if (round.failure_kind !== undefined
    && !['correctness', 'benchmark', 'infrastructure'].includes(round.failure_kind)) return false
  if (round.estimate !== undefined && !isClassicRoundEstimate(round.estimate)) return false
  if (round.measurement !== undefined && !isClassicRoundMeasurement(round.measurement)) return false
  if (round.host_verdict !== 'pass' && round.measurement !== undefined) return false
  if (round.host_verdict !== 'fail' && round.failure_kind !== undefined) return false
  return true
}

function isClassicRounds(value: unknown): value is readonly KersorClassicRound[] {
  if (!Array.isArray(value) || value.length > MAX_CLASSIC_ROUNDS || !value.every(isClassicRound)) return false
  return value.every((round, index) => index === 0 || round.number > (value[index - 1]?.number ?? 0))
}

function isClassicWorkflowPhase(value: unknown): value is KersorClassicWorkflowPhase {
  if (value === null || typeof value !== 'object') return false
  const phase = value as Partial<KersorClassicWorkflowPhase>
  return typeof phase.title === 'string' && typeof phase.detail === 'string'
}

function isClassicWorkflowDesign(value: unknown): value is KersorClassicWorkflowDesign {
  if (value === null || typeof value !== 'object') return false
  const design = value as Partial<KersorClassicWorkflowDesign>
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
    && typeof design.source === 'string'
}

function isClassicSessionDetail(value: unknown): value is RawClassicSessionDetail {
  if (value === null || typeof value !== 'object') return false
  const detail = value as Partial<RawClassicSessionDetail>
  if (typeof detail.session_id !== 'string' || typeof detail.session_dir !== 'string'
    || typeof detail.current_round !== 'number' || !Number.isInteger(detail.current_round)
    || detail.current_round < 1 || !Array.isArray(detail.steps)) return false
  const validStepIds = new Set<KersorClassicStepId>([
    'setup', 'baseline', 'profile', 'selection', 'authoring', 'validation',
    'dispatch', 'measurement', 'decision',
  ])
  const validStepStatuses = new Set<KersorClassicStepStatus>(['pending', 'active', 'completed', 'failed'])
  if (!detail.steps.every(step => step !== null && typeof step === 'object'
    && validStepIds.has((step as KersorClassicStep).id)
    && validStepStatuses.has((step as KersorClassicStep).status))) return false
  const selection = detail.selection
  if (selection === undefined || !['pending', 'stalled', 'selected'].includes(selection.status)
    || typeof selection.rejectedCount !== 'number' || !Number.isInteger(selection.rejectedCount)
    || selection.rejectedCount < 0 || !optionalDetailString(selection.workflow)
    || !optionalDetailString(selection.reason)) return false
  const authoring = detail.authoring
  if (authoring === undefined
    || !['not_started', 'in_progress', 'sealed', 'saved', 'rejected'].includes(authoring.status)
    || !Array.isArray(authoring.files)
    || !authoring.files.every(isClassicArtifact)) return false
  if (authoring.omittedReason !== undefined
    && !['too_large', 'invalid', 'hash_mismatch'].includes(authoring.omittedReason)) return false
  if (authoring.design !== undefined) {
    if (!isClassicWorkflowDesign(authoring.design)) return false
  }
  const validation = detail.validation
  if (validation === undefined || !['pending', 'passed', 'failed'].includes(validation.status)
    || !Array.isArray(validation.checks)
    || !validation.checks.every(isClassicValidationCheck)) return false
  if (detail.rounds !== undefined && !isClassicRounds(detail.rounds)) return false
  const dispatch = detail.dispatch
  return dispatch !== undefined
    && ['pending', 'preparing', 'running', 'completed', 'failed'].includes(dispatch.status)
    && optionalDetailString(dispatch.runDir)
    && optionalDetailString(dispatch.runtimeStatus)
    && (detail.workflow === undefined || isClassicWorkflowDesign(detail.workflow))
}

function isClassicSession(value: unknown): value is RawClassicSession {
  if (value === null || typeof value !== 'object') return false
  const row = value as Partial<RawClassicSession>
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
    && row.warnings.every(item => typeof item === 'string')
}

function projectCycleLineage(value: KersorClassicCycleLineage): KersorClassicCycleLineage {
  return {
    ...(value.session_baseline_cycles === undefined
      ? {} : { session_baseline_cycles: value.session_baseline_cycles }),
    ...(value.best_cycles === undefined ? {} : { best_cycles: value.best_cycles }),
    ...(value.session_speedup === undefined ? {} : { session_speedup: value.session_speedup }),
    ...(value.task_baseline_cycles === undefined
      ? {} : { task_baseline_cycles: value.task_baseline_cycles }),
    ...(value.overall_speedup === undefined ? {} : { overall_speedup: value.overall_speedup }),
  }
}

function projectClassicRound(row: KersorClassicRound): KersorClassicRound {
  const estimate = row.estimate === undefined ? undefined : {
    ...(row.estimate.cycles === undefined ? {} : { cycles: row.estimate.cycles }),
    ...(row.estimate.speedup === undefined ? {} : { speedup: row.estimate.speedup }),
  }
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
  }
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
  }
}

function projectWorkflowDesign(design: KersorClassicWorkflowDesign): KersorClassicWorkflowDesign {
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
  }
}

function projectSessionDetail(row: RawClassicSessionDetail): KersorClassicSessionDetail {
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
  }
}

function projectSession(row: RawClassicSession): KersorClassicSession {
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
  }
}

/**
 * Read a sealed, bounded inspector projection for one classic Session.
 * @param sessionDir - Exact Session directory already discovered by the Host.
 * @returns Valid detail, or `undefined` when the bridge cannot provide it.
 */
export async function readClassicSessionDetail(
  sessionDir: string,
): Promise<KersorClassicSessionDetail | undefined> {
  try {
    const { stdout } = await execFileAsync(kersorPython(), [
      installedBridge(), 'session-detail', '--session', path.resolve(sessionDir),
    ], {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      timeout: 10_000,
    })
    const decoded: unknown = JSON.parse(stdout)
    return isClassicSessionDetail(decoded) ? projectSessionDetail(decoded) : undefined
  } catch {
    // A selectable Session remains usable as a summary when detail is unavailable.
    return undefined
  }
}

/**
 * Invoke the installed bridge without a shell and return a bounded snapshot.
 * @param limit - Maximum recent Sessions to retain.
 * @param staleAfterSeconds - Advisory unfinished-Session inactivity threshold.
 * @param roots - Configured, persisted, and Workspace roots supplied by the Host.
 * @returns Valid Session summaries plus structured bridge health.
 */
export async function readClassicSessions(
  limit: number,
  staleAfterSeconds = 1800,
  roots: KersorClassicRoots = {},
): Promise<KersorClassicSnapshot> {
  const bridge = installedBridge()
  try {
    await access(bridge)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { sessions: [], source: { state: 'not_installed' } }
    return { sessions: [], source: { state: 'failed', lastIssue: issueFromError('classic_bridge', error) } }
  }
  try {
    const args = [
      bridge,
      'sessions',
      '--limit', String(limit),
      '--stale-after', String(staleAfterSeconds),
    ]
    for (const root of roots.sessionRoots ?? []) {
      if (root.trim()) args.push('--root', root)
    }
    for (const workspace of roots.workspaceRoots ?? []) {
      if (workspace.trim()) args.push('--workspace', workspace)
    }
    if (roots.includeCheckoutRoot === false) args.push('--no-checkout-root')
    const { stdout } = await execFileAsync(kersorPython(), args, {
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      timeout: 10_000,
    })
    let decoded: { sessions?: unknown; warnings?: unknown }
    try {
      decoded = JSON.parse(stdout) as { sessions?: unknown; warnings?: unknown }
    } catch (error) {
      return { sessions: [], source: { state: 'failed', lastIssue: issueFromError('classic_bridge', error) } }
    }
    if (!Array.isArray(decoded.sessions) || !decoded.sessions.every(isClassicSession)) {
      return {
        sessions: [],
        source: { state: 'failed', lastIssue: createIssue('classic_bridge', 'invalid_payload') },
      }
    }
    const degraded = Array.isArray(decoded.warnings) && decoded.warnings.length > 0
    return {
      sessions: decoded.sessions.slice(0, limit).map(projectSession),
      source: degraded
        ? { state: 'degraded', lastIssue: createIssue('classic_bridge', 'io_error', 'warning') }
        : { state: 'healthy' },
    }
  } catch (error) {
    return { sessions: [], source: { state: 'failed', lastIssue: issueFromError('classic_bridge', error) } }
  }
}
