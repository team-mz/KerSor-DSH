/**
 * Browser-side KerSor viewer store. One Host snapshot owns inventory,
 * classic Sessions, and source health; folded run views and launcher process
 * ownership remain orthogonal client-side accounts.
 * @module @deepseek-ai/dsh-client-ui-kersor-viewer/client
 */
import type { KersorCallDetailView, KersorClassicSessionDetail, KersorRunRef, KersorRunView, KersorViewerFrame, KersorViewerSnapshot, KersorWorkflowResultView } from '@deepseek-ai/dsh-kersor-viewer/types';
import type { KersorActiveFrame, KersorActiveLaunch, KersorTaskRef } from '@deepseek-ai/dsh-kersor/types';
/** One discovered run joined with its independently folded detail, when loaded. */
export interface KersorRunRow extends KersorRunRef {
    readonly view?: KersorRunView | undefined;
}
/** Complete browser-local projection consumed through `useSyncExternalStore`. */
export interface KersorViewerState {
    /** Latest atomic Host projection; absent until the first successful read. */
    readonly snapshot?: KersorViewerSnapshot;
    /** Folded event backlogs keyed independently from the inventory snapshot. */
    readonly views: ReadonlyMap<string, KersorRunView>;
    /** On-demand, seal-aware classic Session details keyed by Session directory. */
    readonly classicDetails: ReadonlyMap<string, KersorClassicSessionDetail>;
    /** On-demand, bounded worker detail keyed by run directory and call id. */
    readonly callDetails: ReadonlyMap<string, KersorCallDetailView>;
    readonly callDetailLoading?: string;
    readonly callDetailError?: string;
    readonly classicDetailLoading?: string;
    readonly classicDetailError?: string;
    readonly loading: boolean;
    /** Transport failure only; Host source failures live in snapshot diagnostics. */
    readonly transportError?: string;
    /** Present only while the optional Host launcher namespace is available. */
    readonly launcher?: {
        readonly tasks: readonly KersorTaskRef[];
        readonly active: readonly KersorActiveLaunch[];
        readonly error?: string;
    };
}
type Listener = () => void;
/** Snapshot store over the Host projection and per-run folded views. */
export declare class KersorViewerStore {
    private state;
    private readonly listeners;
    private selected;
    private selectedClassic;
    /** Stable snapshot for useSyncExternalStore. */
    getSnapshot: () => KersorViewerState;
    /** Subscribe to snapshot replacements. */
    subscribe: (listener: Listener) => (() => void);
    /** Latest run inventory joined with independently folded views. */
    get rows(): readonly KersorRunRow[];
    /** Currently selected run directory (panel-local choice). */
    get selectedRunDir(): string | undefined;
    /** Currently expanded classic Session directory. */
    get selectedClassicSessionDir(): string | undefined;
    /**
     * Select one experiment and its newest discovered run as one UI choice.
     * @param sessionDir - Selected Session directory, or `undefined` to collapse.
     * @returns The newest matching run directory, when the Host discovered one.
     */
    selectClassic(sessionDir: string | undefined): string | undefined;
    /**
     * Select a run and its owning experiment; persists across Host snapshots.
     * @param runDir - Exact discovered run directory, or `undefined` to clear selection.
     */
    select(runDir: string | undefined): void;
    /**
     * Resolve one previously loaded call detail.
     * @param runDir - Exact discovered run directory.
     * @param callId - Exact folded call identity.
     * @returns Cached detail, or `undefined` before a successful load.
     */
    callDetail(runDir: string, callId: string): KersorCallDetailView | undefined;
    /** Selected folded view, falling back to a real available run view. */
    get activeView(): KersorRunView | undefined;
    /**
     * Atomically replace inventory, classic Sessions, and diagnostics.
     * @param snapshot - Complete Host projection from one committed scan.
     */
    setSnapshot(snapshot: KersorViewerSnapshot): void;
    /**
     * Record a Remote/connection failure without overwriting Host diagnostics.
     * @param message - Bounded transport diagnostic shown to the user.
     */
    setTransportError(message: string): void;
    /**
     * Mark one selected classic Session detail as loading.
     * @param sessionDir - Session whose on-demand detail is loading.
     */
    setClassicDetailLoading(sessionDir: string): void;
    /**
     * Store one successful classic Session detail answer.
     * @param sessionDir - Session owning the answer.
     * @param detail - Valid inspector detail, or `undefined` when unavailable.
     */
    setClassicDetail(sessionDir: string, detail: KersorClassicSessionDetail | undefined): void;
    /**
     * Record a bounded detail-read failure without replacing the summary snapshot.
     * @param sessionDir - Session whose detail failed.
     * @param message - Remote transport diagnostic.
     */
    setClassicDetailError(sessionDir: string, message: string): void;
    /**
     * Mark one call detail as loading.
     * @param runDir - Exact discovered run directory.
     * @param callId - Exact folded call identity.
     */
    setCallDetailLoading(runDir: string, callId: string): void;
    /**
     * Store one successful bounded call-detail answer.
     * @param runDir - Exact discovered run directory.
     * @param callId - Exact folded call identity.
     * @param detail - Bounded answer, or `undefined` when artifacts are unavailable.
     */
    setCallDetail(runDir: string, callId: string, detail: KersorCallDetailView | undefined): void;
    /**
     * Record a call-detail transport failure without replacing run progress.
     * @param runDir - Exact discovered run directory.
     * @param callId - Exact folded call identity.
     * @param message - Remote transport diagnostic.
     */
    setCallDetailError(runDir: string, callId: string, message: string): void;
    /**
     * Replace the optional launcher's configured-task and owned-process inventory.
     * @param tasks - Deployment-configured tasks exposed by the Host.
     * @param active - Processes currently owned by the launcher service.
     */
    setLauncher(tasks: readonly KersorTaskRef[], active: readonly KersorActiveLaunch[]): void;
    /** Hide controls when the Host launcher plugin is not loaded. */
    setLauncherUnavailable(): void;
    /**
     * Record a launch/stop failure without contaminating viewer read state.
     * @param message - Bounded launcher failure text.
     */
    setLauncherError(message: string): void;
    /**
     * Apply the Host launcher's complete owned-process replacement frame.
     * @param frame - Complete active-launch replacement.
     */
    applyActiveFrame(frame: KersorActiveFrame): void;
    /**
     * Apply one forwarded Host frame.
     * @param frame - Atomic snapshot replacement or one folded run update.
     */
    applyFrame(frame: KersorViewerFrame): void;
    /**
     * Store a successful `runBacklog` answer; undefined never fabricates zeros.
     * @param runDir - Exact discovered run directory.
     * @param view - Folded backlog, or `undefined` when unavailable.
     */
    setBacklog(runDir: string, view: KersorRunView | undefined): void;
    /**
     * Attach one separately loaded bounded Workflow result to its folded run view.
     * @param runDir - Exact discovered run directory.
     * @param result - Candidate and Host verification projection, when available.
     */
    setRunResult(runDir: string, result: KersorWorkflowResultView | undefined): void;
    /** Drop connection-scoped state. */
    reset(): void;
    private withInventoryResult;
    private emit;
}
export {};
//# sourceMappingURL=store.d.ts.map