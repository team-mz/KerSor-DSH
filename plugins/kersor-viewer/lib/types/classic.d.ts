/**
 * Read-only adapter from the installed KerSor preset bridge to the viewer.
 * @module @deepseek-ai/dsh-kersor-viewer
 */
import type { KersorDiagnosticIssue } from './diagnostics.ts';
/** Canonical lifecycle read from the KerSor Session store. */
export type KersorClassicLifecycle = 'active' | 'completed' | 'stalled' | 'cancelled';
/** Advisory artifact health, kept separate from canonical lifecycle. */
export type KersorClassicHealth = 'active' | 'stale' | 'needs_resume' | 'terminal' | 'unknown';
/** Four-state result of one deterministic protocol gate. */
export type KersorClassicGate = 'pass' | 'fail' | 'pending' | 'not_required';
/** Canonical next action for an incomplete Session baseline witness. */
export type KersorBaselineAction = 'init' | 'record_verify' | 'new_session';
/** Canonical terminal cause, distinct from resumability and health. */
export type KersorClassicStopReason = 'target_met' | 'execution_budget_exhausted' | 'selection_stalled' | 'authoring_budget_exhausted' | 'cancelled' | 'single_run_complete';
/** User-facing combination of lifecycle and resumability. */
export type KersorClassicStatus = 'terminal-complete' | 'terminal-stalled' | 'terminal-cancelled' | 'resumable' | 'in-progress' | 'pre-round-1';
/** One recent optimization Session projected by the canonical KerSor stores. */
export interface KersorClassicSession {
    readonly session_id: string;
    readonly session_dir: string;
    readonly storage_kind: 'v2' | 'legacy';
    readonly phase?: string | null;
    readonly lifecycle: KersorClassicLifecycle;
    readonly status: KersorClassicStatus;
    readonly health: KersorClassicHealth;
    readonly started_at?: string | null;
    readonly last_activity_at?: string | null;
    readonly current_round?: number | null;
    readonly max_workflows?: number | null;
    readonly target_speedup?: number | null;
    readonly target_met?: boolean | null;
    readonly mode?: string | null;
    readonly backend?: string | null;
    readonly kernel_language?: string | null;
    readonly integration_pattern?: string | null;
    readonly allow_workflow_authoring?: boolean | null;
    readonly workflow_authoring_budget?: number | null;
    readonly workflow_authoring_used?: number | null;
    readonly kernel_name?: string | null;
    readonly workflow?: string | null;
    /** Outcome of the deterministic selector, separate from a Workflow name. */
    readonly selection_status?: 'pending' | 'stalled' | 'selected' | null;
    /** Latest canonical COMPLETE/CONTINUE/STALLED line, when a round has decided. */
    readonly decision?: string | null;
    readonly fit_confidence?: string | null;
    readonly baseline_witness?: KersorClassicGate | null;
    readonly baseline_next_action?: KersorBaselineAction | null;
    readonly baseline_reason?: string | null;
    readonly profile_evidence?: KersorClassicGate | null;
    readonly profile_reason?: string | null;
    readonly profile_owner?: string | null;
    readonly dsh_compatibility?: KersorClassicGate | null;
    readonly candidate_ownership?: KersorClassicGate | null;
    readonly fresh_session?: KersorClassicGate | null;
    readonly best_speedup?: number | null;
    readonly stop_reason?: KersorClassicStopReason | null;
    /** Host-verified cycle lineage; Workflow estimates never contribute. */
    readonly cycle_lineage?: KersorClassicCycleLineage | null;
    readonly warningCount: number;
}
/** Host-verified lineage from the task baseline through the Session incumbent. */
export interface KersorClassicCycleLineage {
    readonly session_baseline_cycles?: number;
    readonly best_cycles?: number;
    readonly session_speedup?: number;
    readonly task_baseline_cycles?: number;
    readonly overall_speedup?: number;
}
/** Workflow-authored estimate, never presented as Host measurement. */
export interface KersorClassicRoundEstimate {
    readonly cycles?: number;
    readonly speedup?: number;
}
/** Measurement accepted by the Host correctness and benchmark gates. */
export interface KersorClassicRoundMeasurement {
    readonly baseline_cycles?: number;
    readonly candidate_cycles?: number;
    readonly candidate_speedup?: number;
    readonly incumbent_cycles?: number;
    readonly incumbent_speedup?: number;
    readonly best_improved?: boolean;
    readonly overall_speedup?: number;
}
/** One bounded round in the canonical Session chronology. */
export interface KersorClassicRound {
    readonly number: number;
    readonly workflow?: string;
    readonly workflow_origin?: 'catalog' | 'authored';
    readonly candidate_id?: string;
    readonly host_verdict: 'pending' | 'pass' | 'fail';
    readonly failure_kind?: 'correctness' | 'benchmark' | 'infrastructure';
    readonly estimate?: KersorClassicRoundEstimate;
    readonly measurement?: KersorClassicRoundMeasurement;
    readonly decision?: string;
}
/** Stable stage identifiers rendered by the classic Session inspector. */
export type KersorClassicStepId = 'setup' | 'baseline' | 'profile' | 'selection' | 'authoring' | 'validation' | 'dispatch' | 'measurement' | 'decision';
/** Artifact-derived lifecycle of one inspector stage. */
export type KersorClassicStepStatus = 'pending' | 'active' | 'completed' | 'failed';
/** One artifact-derived step in a classic optimization Session. */
export interface KersorClassicStep {
    readonly id: KersorClassicStepId;
    readonly status: KersorClassicStepStatus;
}
/** Selector outcome kept separate from authored or released Workflow identity. */
export interface KersorClassicSelectionDetail {
    readonly status: 'pending' | 'stalled' | 'selected';
    readonly workflow?: string;
    readonly reason?: string;
    readonly rejectedCount: number;
}
/** One sealed or persisted Workflow file. */
export interface KersorClassicArtifact {
    readonly name: string;
    readonly sha256: string;
    readonly bytes: number;
}
/** One declared phase in the selected Workflow's portable DSH envelope. */
export interface KersorClassicWorkflowPhase {
    readonly title: string;
    readonly detail: string;
}
/** Curated routing metadata plus sealed, read-only design text. */
export interface KersorClassicWorkflowDesign {
    readonly name?: string;
    readonly description?: string;
    readonly whenToUse?: string;
    readonly technique?: string;
    readonly methodCategory?: string;
    readonly topology?: string;
    readonly phases?: readonly KersorClassicWorkflowPhase[];
    readonly requiredArgs: readonly string[];
    readonly languages: readonly string[];
    readonly backends: readonly string[];
    readonly integrationPatterns: readonly string[];
    readonly rationale: string;
    readonly source: string;
}
/** Foreground authoring state. Design content is absent until the handoff is sealed. */
export interface KersorClassicAuthoringDetail {
    readonly status: 'not_started' | 'in_progress' | 'sealed' | 'saved' | 'rejected';
    readonly files: readonly KersorClassicArtifact[];
    readonly design?: KersorClassicWorkflowDesign;
    readonly omittedReason?: 'too_large' | 'invalid' | 'hash_mismatch';
}
/** One deterministic Proposal validation result. */
export interface KersorClassicValidationCheck {
    readonly name: string;
    readonly passed: boolean;
}
/** Bounded result of the canonical Proposal save validator. */
export interface KersorClassicValidationDetail {
    readonly status: 'pending' | 'passed' | 'failed';
    readonly checks: readonly KersorClassicValidationCheck[];
}
/** Dispatch preparation and Workflow Host lifecycle for the current round. */
export interface KersorClassicDispatchDetail {
    readonly status: 'pending' | 'preparing' | 'running' | 'completed' | 'failed';
    readonly runDir?: string;
    readonly runtimeStatus?: string;
}
/** On-demand inspector projection for one already-discovered classic Session. */
export interface KersorClassicSessionDetail {
    readonly session_id: string;
    readonly session_dir: string;
    readonly current_round: number;
    readonly steps: readonly KersorClassicStep[];
    readonly selection: KersorClassicSelectionDetail;
    readonly authoring: KersorClassicAuthoringDetail;
    readonly validation: KersorClassicValidationDetail;
    readonly dispatch: KersorClassicDispatchDetail;
    /** Complete bounded chronology supplied on demand, ordered by round number. */
    readonly rounds: readonly KersorClassicRound[];
    /** Hash-verified selected Workflow, whether released or Session-authored. */
    readonly workflow?: KersorClassicWorkflowDesign;
}
/** Health of the optional classic-Session bridge. */
export interface KersorClassicSource {
    readonly state: 'disabled' | 'not_installed' | 'healthy' | 'degraded' | 'failed';
    readonly lastIssue?: KersorDiagnosticIssue;
}
/** Bounded recent-session inventory and its structured source state. */
export interface KersorClassicSnapshot {
    readonly sessions: readonly KersorClassicSession[];
    readonly source: KersorClassicSource;
}
/** Machine-local roots supplied by viewer configuration and DSH workspaces. */
export interface KersorClassicRoots {
    readonly includeCheckoutRoot?: boolean;
    readonly sessionRoots?: readonly string[];
    readonly workspaceRoots?: readonly string[];
}
/**
 * Resolve the bridge path copied by the portable preset installer.
 * @returns Absolute bridge path under the configured DSH home.
 */
export declare function installedBridge(): string;
/**
 * Read a sealed, bounded inspector projection for one classic Session.
 * @param sessionDir - Exact Session directory already discovered by the Host.
 * @returns Valid detail, or `undefined` when the bridge cannot provide it.
 */
export declare function readClassicSessionDetail(sessionDir: string): Promise<KersorClassicSessionDetail | undefined>;
/**
 * Invoke the installed bridge without a shell and return a bounded snapshot.
 * @param limit - Maximum recent Sessions to retain.
 * @param staleAfterSeconds - Advisory unfinished-Session inactivity threshold.
 * @param roots - Configured, persisted, and Workspace roots supplied by the Host.
 * @returns Valid Session summaries plus structured bridge health.
 */
export declare function readClassicSessions(limit: number, staleAfterSeconds?: number, roots?: KersorClassicRoots): Promise<KersorClassicSnapshot>;
//# sourceMappingURL=classic.d.ts.map