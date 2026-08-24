/**
 * KerSor viewer Host service: commits one inventory/diagnostics snapshot and
 * folds each run's event stream for browser consumers.
 * @module @deepseek-ai/dsh-kersor-viewer
 */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { KersorClassicSessionDetail } from './classic.ts';
import type { KersorCallDetailView } from './detail.ts';
import type { KersorRunView } from './fold.ts';
import type { KersorWorkflowResultView } from './fold.ts';
import type { KersorViewerSnapshot } from './types.ts';
export type { KersorEvent, KersorRunView } from './fold.ts';
export type { KersorRunRef } from './scanner.ts';
export type { KersorCallDetailView } from './detail.ts';
export type { KersorBaselineAction, KersorClassicGate, KersorClassicHealth, KersorClassicLifecycle, KersorClassicSession, KersorClassicSessionDetail, KersorClassicSnapshot, KersorClassicStatus, } from './classic.ts';
export type { KersorRunObservation, KersorViewerFrame, KersorViewerSnapshot } from './types.ts';
export { EventsTailer } from './tailer.ts';
export { DEFAULT_KERSOR_ROOTS, scanRoots } from './scanner.ts';
export { createRunView, foldEvent } from './fold.ts';
export { installedBridge, readClassicSessionDetail, readClassicSessions } from './classic.ts';
/** Viewer configuration (cordis.patch.yml row config). */
export interface Config {
    /** Extra KerSor session roots scanned in addition to the defaults. */
    roots?: string[];
    /** Disable built-in and preset-checkout roots. */
    noDefaultRoots?: boolean;
    /** Discovery rescan interval in milliseconds. */
    scanIntervalMs?: number;
    /** Number of recent classic optimization Sessions shown; zero disables it. */
    classicSessionLimit?: number;
    /** Seconds without artifact activity before an unfinished Session is stale. */
    classicStaleAfterSeconds?: number;
}
/** Host service owning the viewer's single snapshot and folded run views. */
export declare class KersorViewerService extends TypertRemoteService {
    static inject: string[];
    static Config: z<Config>;
    private readonly rootCtx;
    private readonly configuredRoots;
    private readonly includeDefaults;
    private readonly scanIntervalMs;
    private readonly classicSessionLimit;
    private readonly classicStaleAfterSeconds;
    private readonly tracked;
    private group;
    private scanTimer;
    private scanInFlight;
    private persistedWorkspaceRoots;
    private scanObservation;
    private classicSnapshot;
    private lastPublishedSnapshotFingerprint;
    /** Create the service under the Host composition. */
    constructor(ctx: Context, config: Config);
    /** Start discovery and tailing under the plugin's fiber once ready. */
    [Service.init](): Generator<() => void, void, void>;
    private requireGroup;
    /**
     * Read the complete inventory and source-health snapshot for refresh or reconnect.
     * @returns Current atomic Host projection with a fresh observation timestamp.
     */
    snapshot(): KersorViewerSnapshot;
    /**
     * Read the full folded view of one discovered run.
     * @param runDir - Exact run directory from the current inventory.
     * @returns Folded backlog with bounded result, or `undefined` for an unknown run.
     */
    runBacklog(runDir: string): Promise<KersorRunView | undefined>;
    /**
     * Read the bounded candidate-selection result for one discovered run.
     * @param runDir - Exact run directory from the current inventory.
     * @returns Candidate and Host verification projection, or `undefined` when absent.
     */
    runResult(runDir: string): Promise<KersorWorkflowResultView | undefined>;
    /**
     * Read bounded worker messages and activity names for one folded call.
     * @param runDir - Exact discovered run directory.
     * @param callId - Exact call identity present in that run's folded event stream.
     * @returns Bounded detail, or `undefined` when the run, call, or artifacts are absent.
     */
    runCallDetail(runDir: string, callId: string): Promise<KersorCallDetailView | undefined>;
    /**
     * Read sealed, bounded detail for one classic Session present in the snapshot.
     * @param sessionDir - Exact discovered Session directory.
     * @returns Inspector detail, or `undefined` for an unknown or unreadable Session.
     */
    classicSessionDetail(sessionDir: string): Promise<KersorClassicSessionDetail | undefined>;
    /** Rescan roots once; concurrent callers share the in-flight scan. */
    rescan(): Promise<void>;
    private performRescan;
    /** Merge managed Workspaces with durable Session cwd values, retaining the last good durable list on failure. */
    private discoverWorkspaceRoots;
    private backfillTerminated;
    private attachTailer;
    private loadRunResult;
    private foldLine;
    private rejectLine;
    private recordRunIssue;
    private publishSnapshot;
    private publishRun;
}
/** Cordis plugin entry: the service class itself. */
export default KersorViewerService;
//# sourceMappingURL=service.d.ts.map