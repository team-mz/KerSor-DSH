/**
 * Root-directory discovery of KerSor autonomous runs and bounded source observations.
 * @module @deepseek-ai/dsh-kersor-viewer
 */
import type { KersorDiagnosticIssue } from './diagnostics.ts';
import type { KersorWorkflowResultView } from './fold.ts';
/** Default roots scanned in addition to configured ones. */
export declare const DEFAULT_KERSOR_ROOTS: string[];
/** Lifecycle classification of one discovered run directory. */
export type KersorRunDiscovery = 'active' | 'completed' | 'failed';
/** Storage family of one executable Workflow run. */
export type KersorRunKind = 'autonomous' | 'classic-round';
/** One discovered run: identity paths plus classification. */
export interface KersorRunRef {
    readonly runId: string;
    readonly runDir: string;
    readonly sessionDir: string;
    readonly root: string;
    readonly kind: KersorRunKind;
    readonly round?: number;
    readonly result?: KersorWorkflowResultView;
    readonly discovery: KersorRunDiscovery;
}
/** How a root entered the scanner. */
export type KersorRootOrigin = 'configured' | 'default' | 'checkout' | 'workspace';
/** Result of inspecting one root during the latest completed scan. */
export interface KersorRootObservation {
    readonly root: string;
    readonly origin: KersorRootOrigin;
    readonly state: 'absent' | 'healthy' | 'degraded' | 'failed';
    readonly sessionsExamined: number;
    readonly sessionsAccepted: number;
    readonly runsFound: number;
    readonly lastIssue?: KersorDiagnosticIssue;
}
/** Latest scanner lifecycle and per-root observations. */
export interface KersorScanObservation {
    readonly state: 'never' | 'running' | 'healthy' | 'degraded' | 'failed';
    readonly startedAt?: string;
    readonly completedAt?: string;
    readonly lastSuccessfulAt?: string;
    readonly roots: readonly KersorRootObservation[];
    readonly lastIssue?: KersorDiagnosticIssue;
}
/** A scanner issue scoped to one discovered run. */
export interface KersorScannedRunIssue {
    readonly runDir: string;
    readonly issue: KersorDiagnosticIssue;
}
/** Complete result committed by the viewer service after one scan. */
export interface KersorScanResult {
    readonly runs: readonly KersorRunRef[];
    readonly runIssues: readonly KersorScannedRunIssue[];
    readonly observation: KersorScanObservation;
}
/**
 * Scan all roots and return discovered runs plus bounded observations.
 * @param roots - Explicit KerSor Session roots.
 * @param includeDefaults - Whether built-in and installed-checkout roots participate.
 * @param workspaceRoots - Registered and persisted DSH Workspace roots.
 * @returns Complete committed inventory, run issues, and source observation.
 */
export declare function scanRoots(roots: readonly string[], includeDefaults: boolean, workspaceRoots?: readonly string[]): Promise<KersorScanResult>;
//# sourceMappingURL=scanner.d.ts.map