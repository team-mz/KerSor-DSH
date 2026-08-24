/** Bounded projection of one Workflow agent call's retained Codex artifacts. */
import type { KersorCallView } from './fold.ts';
/** One bounded assistant message retained by a Workflow worker. */
export interface KersorCallMessageView {
    readonly id: string;
    readonly text: string;
}
/** One tool or search activity without arguments, results, or credentials. */
export interface KersorCallActivityView {
    readonly id: string;
    readonly kind: 'tool' | 'web-search';
    readonly label: string;
    readonly status: string;
}
/** Token usage retained for one Workflow worker. */
export interface KersorCallUsageView {
    readonly inputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
}
/** On-demand, bounded detail for one discovered Workflow call. */
export interface KersorCallDetailView {
    readonly callId: string;
    readonly runner: 'codex-exec' | 'unknown';
    readonly threadId?: string;
    readonly model: string | null;
    readonly modelRole?: string | null;
    readonly provider?: string | null;
    readonly isolation?: string;
    readonly messages: readonly KersorCallMessageView[];
    readonly activities: readonly KersorCallActivityView[];
    readonly usage?: KersorCallUsageView;
    readonly truncated: boolean;
}
/**
 * Read one discovered call's retained worker artifacts without forwarding tool payloads.
 * @param runDir - Exact discovered run directory.
 * @param call - Call already present in the folded run view.
 * @returns Bounded messages and activity names, or `undefined` when no artifacts exist.
 */
export declare function readCallDetail(runDir: string, call: KersorCallView): Promise<KersorCallDetailView | undefined>;
//# sourceMappingURL=detail.d.ts.map