/**
 * Pure fold of a KerSor `events.jsonl` stream into the viewer's run view
 * model. One `KersorRunView` accumulates every event of a single run; phases
 * are buckets in first-appearance order so loop re-visits (KSearch cycles
 * Select/Generate/Evaluate) each get their own bucket.
 * @module @deepseek-ai/dsh-kersor-viewer
 */
/** Terminal lifecycle of a whole workflow run. */
export type KersorRunStatus = 'running' | 'completed' | 'failed' | 'unknown';
/** Lifecycle of one agent or evaluation call row. */
export type KersorCallStatus = 'queued' | 'running' | 'completed' | 'failed';
/** Which host primitive emitted the call. */
export type KersorCallKind = 'agent' | 'evaluation';
/** One folded call row inside a phase bucket. */
export interface KersorCallView {
    readonly seq: number;
    readonly callId: string;
    readonly label: string;
    readonly kind: KersorCallKind;
    status: KersorCallStatus;
    startedTs?: string | undefined;
    endedTs?: string | undefined;
    tokens?: number | undefined;
    rolledBack?: boolean | undefined;
    error?: string | undefined;
}
/** One phase bucket holding its calls in arrival order. */
export interface KersorPhaseView {
    readonly title: string;
    readonly index: number;
    status: 'running' | 'completed' | 'failed';
    readonly calls: KersorCallView[];
}
/** One bounded authored candidate projected from the Workflow output. */
export interface KersorCandidateResultView {
    readonly id: string;
    readonly expectedCycles?: number;
}
/** Candidate-selection and verification state owned by one Workflow output. */
export interface KersorWorkflowResultView {
    readonly stage?: string;
    readonly verification?: 'passed' | 'failed';
    readonly failureKind?: 'correctness' | 'benchmark' | 'infrastructure';
    readonly selectedCandidateId?: string;
    readonly expectedCycles?: number;
    readonly measuredBaselineCycles?: number;
    readonly measuredCycles?: number;
    readonly estimatedSpeedup?: number;
    /** Host-measured speedup of this candidate, not the retained incumbent. */
    readonly measuredSpeedup?: number | null;
    readonly incumbentCycles?: number;
    readonly incumbentSpeedup?: number;
    readonly bestImproved?: boolean;
    readonly candidates: readonly KersorCandidateResultView[];
}
/** Folded projection of one KerSor autonomous run. */
export interface KersorRunView {
    readonly runId: string;
    readonly runDir: string;
    readonly sessionDir: string;
    status: KersorRunStatus;
    workflow?: string | undefined;
    scriptHash?: string | undefined;
    startedTs?: string | undefined;
    endedTs?: string | undefined;
    currentPhase: string;
    phases: KersorPhaseView[];
    totals: {
        calls: number;
        completed: number;
        failed: number;
        tokens: number;
    };
    error?: string | undefined;
    result?: KersorWorkflowResultView | undefined;
    candidateStage?: string | undefined;
    verification?: 'passed' | 'failed' | undefined;
    failureKind?: 'correctness' | 'benchmark' | 'infrastructure' | undefined;
    selectedCandidateId?: string | undefined;
    expectedCycles?: number | undefined;
    measuredBaselineCycles?: number | undefined;
    measuredCycles?: number | undefined;
    estimatedSpeedup?: number | undefined;
    measuredSpeedup?: number | null | undefined;
    incumbentCycles?: number | undefined;
    incumbentSpeedup?: number | undefined;
    bestImproved?: boolean | undefined;
    candidates?: readonly KersorCandidateResultView[] | undefined;
}
/** Shape of one parsed `events.jsonl` line (superset; unknown fields ignored). */
export interface KersorEvent {
    readonly type: string;
    readonly ts?: string;
    readonly phase?: string;
    readonly label?: string;
    readonly seq?: number;
    readonly call_id?: string;
    readonly usage?: {
        total_tokens?: number;
    };
    readonly script?: string;
    readonly script_hash?: string;
    readonly message?: string;
    readonly error?: {
        message?: string;
    } | string;
    [key: string]: unknown;
}
/**
 * Copy one canonical result into the flat wire projection and its grouped view.
 * @param view - Mutable folded run receiving the result.
 * @param result - Bounded candidate and Host verification projection.
 */
export declare function applyWorkflowResult(view: KersorRunView, result: KersorWorkflowResultView): void;
/**
 * Fold one parsed event into the view, mutating the view in place.
 * @param view - Mutable run projection receiving the event.
 * @param event - Validated Workflow runtime event.
 */
export declare function foldEvent(view: KersorRunView, event: KersorEvent): void;
/**
 * Create an empty view for a discovered run directory.
 * @param runId - Stable run identifier from discovery.
 * @param runDir - Absolute discovered run directory.
 * @param sessionDir - Absolute owning Session directory.
 * @returns Empty projection ready for event folding.
 */
export declare function createRunView(runId: string, runDir: string, sessionDir: string): KersorRunView;
//# sourceMappingURL=fold.d.ts.map