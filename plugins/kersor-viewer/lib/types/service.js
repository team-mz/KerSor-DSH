/**
 * KerSor viewer Host service: commits one inventory/diagnostics snapshot and
 * folds each run's event stream for browser consumers.
 * @module @deepseek-ai/dsh-kersor-viewer
 */
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import path from 'node:path';
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { readClassicSessionDetail, readClassicSessions } from "./classic.js";
import { createIssue, issueFromError, mergeIssue } from "./diagnostics.js";
import { readCallDetail } from "./detail.js";
import { applyWorkflowResult, createRunView, foldEvent } from "./fold.js";
import { readWorkflowResult } from "./result.js";
import { scanRoots } from "./scanner.js";
import { EventsTailer } from "./tailer.js";
export { EventsTailer } from "./tailer.js";
export { DEFAULT_KERSOR_ROOTS, scanRoots } from "./scanner.js";
export { createRunView, foldEvent } from "./fold.js";
export { installedBridge, readClassicSessionDetail, readClassicSessions } from "./classic.js";
/** Host service owning the viewer's single snapshot and folded run views. */
let KersorViewerService = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _snapshot_decorators;
    let _runBacklog_decorators;
    let _runResult_decorators;
    let _runCallDetail_decorators;
    let _classicSessionDetail_decorators;
    return class KersorViewerService extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _snapshot_decorators = [Remote('snapshot')];
            _runBacklog_decorators = [Remote('runBacklog')];
            _runResult_decorators = [Remote('runResult')];
            _runCallDetail_decorators = [Remote('runCallDetail')];
            _classicSessionDetail_decorators = [Remote('classicSessionDetail')];
            __esDecorate(this, null, _snapshot_decorators, { kind: "method", name: "snapshot", static: false, private: false, access: { has: obj => "snapshot" in obj, get: obj => obj.snapshot }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _runBacklog_decorators, { kind: "method", name: "runBacklog", static: false, private: false, access: { has: obj => "runBacklog" in obj, get: obj => obj.runBacklog }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _runResult_decorators, { kind: "method", name: "runResult", static: false, private: false, access: { has: obj => "runResult" in obj, get: obj => obj.runResult }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _runCallDetail_decorators, { kind: "method", name: "runCallDetail", static: false, private: false, access: { has: obj => "runCallDetail" in obj, get: obj => obj.runCallDetail }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _classicSessionDetail_decorators, { kind: "method", name: "classicSessionDetail", static: false, private: false, access: { has: obj => "classicSessionDetail" in obj, get: obj => obj.classicSessionDetail }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        static inject = ['workspaceRegistry', 'sessionPersistence'];
        static Config = z.object({
            roots: z.array(z.string()).default([]),
            noDefaultRoots: z.boolean().default(false),
            scanIntervalMs: z.number().min(500).default(5000),
            classicSessionLimit: z.number().step(1).min(0).max(100).default(20),
            classicStaleAfterSeconds: z.number().step(1).min(1).max(86_400).default(1800),
        });
        rootCtx = __runInitializers(this, _instanceExtraInitializers);
        configuredRoots;
        includeDefaults;
        scanIntervalMs;
        classicSessionLimit;
        classicStaleAfterSeconds;
        tracked = new Map();
        group;
        scanTimer;
        scanInFlight;
        persistedWorkspaceRoots = [];
        scanObservation = { state: 'never', roots: [] };
        classicSnapshot = {
            sessions: [],
            source: { state: 'not_installed' },
        };
        lastPublishedSnapshotFingerprint;
        /** Create the service under the Host composition. */
        constructor(ctx, config) {
            super(ctx, 'kersorViewer');
            this.rootCtx = ctx;
            this.configuredRoots = config.roots ?? [];
            this.includeDefaults = !(config.noDefaultRoots ?? false);
            this.scanIntervalMs = config.scanIntervalMs ?? 5000;
            this.classicSessionLimit = config.classicSessionLimit ?? 20;
            this.classicStaleAfterSeconds = config.classicStaleAfterSeconds ?? 1800;
        }
        /** Start discovery and tailing under the plugin's fiber once ready. */
        *[Service.init]() {
            yield () => {
                for (const tracked of this.tracked.values())
                    tracked.tailer?.stop();
                this.tracked.clear();
                if (this.scanTimer !== undefined)
                    clearInterval(this.scanTimer);
                this.scanTimer = undefined;
                void this.group?.dispose();
                this.group = undefined;
            };
            const group = this.requireGroup();
            group.effect(() => {
                void this.rescan();
                this.scanTimer = setInterval(() => { void this.rescan(); }, this.scanIntervalMs);
                this.scanTimer.unref();
                return () => {
                    if (this.scanTimer !== undefined)
                        clearInterval(this.scanTimer);
                    this.scanTimer = undefined;
                };
            });
        }
        requireGroup() {
            this.group ??= this.rootCtx.plugin({ name: 'kersor-viewer-group', apply: () => { } });
            return this.group;
        }
        /**
         * Read the complete inventory and source-health snapshot for refresh or reconnect.
         * @returns Current atomic Host projection with a fresh observation timestamp.
         */
        snapshot() {
            return {
                asOf: new Date().toISOString(),
                runs: [...this.tracked.values()].map(tracked => tracked.ref)
                    .sort((left, right) => rank(right) - rank(left) || right.runId.localeCompare(left.runId)),
                classic: this.classicSnapshot,
                diagnostics: {
                    scan: this.scanObservation,
                    runs: [...this.tracked.values()].map(tracked => tracked.observation)
                        .sort((left, right) => left.runDir.localeCompare(right.runDir)),
                },
            };
        }
        /**
         * Read the full folded view of one discovered run.
         * @param runDir - Exact run directory from the current inventory.
         * @returns Folded backlog with bounded result, or `undefined` for an unknown run.
         */
        async runBacklog(runDir) {
            const tracked = this.tracked.get(runDir);
            if (tracked === undefined)
                return undefined;
            const result = tracked.view.result ?? await readWorkflowResult(runDir);
            if (result !== undefined)
                applyWorkflowResult(tracked.view, result);
            return tracked.view;
        }
        /**
         * Read the bounded candidate-selection result for one discovered run.
         * @param runDir - Exact run directory from the current inventory.
         * @returns Candidate and Host verification projection, or `undefined` when absent.
         */
        async runResult(runDir) {
            if (!this.tracked.has(runDir))
                return undefined;
            return readWorkflowResult(runDir);
        }
        /**
         * Read bounded worker messages and activity names for one folded call.
         * @param runDir - Exact discovered run directory.
         * @param callId - Exact call identity present in that run's folded event stream.
         * @returns Bounded detail, or `undefined` when the run, call, or artifacts are absent.
         */
        async runCallDetail(runDir, callId) {
            const tracked = this.tracked.get(runDir);
            if (tracked === undefined)
                return undefined;
            const call = tracked.view.phases.flatMap(phase => phase.calls)
                .find(candidate => candidate.callId === callId);
            return call === undefined ? undefined : readCallDetail(runDir, call);
        }
        /**
         * Read sealed, bounded detail for one classic Session present in the snapshot.
         * @param sessionDir - Exact discovered Session directory.
         * @returns Inspector detail, or `undefined` for an unknown or unreadable Session.
         */
        async classicSessionDetail(sessionDir) {
            if (!this.classicSnapshot.sessions.some(session => session.session_dir === sessionDir))
                return undefined;
            return readClassicSessionDetail(sessionDir);
        }
        /** Rescan roots once; concurrent callers share the in-flight scan. */
        async rescan() {
            if (this.scanInFlight !== undefined)
                return this.scanInFlight;
            this.scanObservation = {
                ...this.scanObservation,
                state: 'running',
                startedAt: new Date().toISOString(),
            };
            const current = this.performRescan().catch((error) => {
                const now = new Date().toISOString();
                this.scanObservation = {
                    ...this.scanObservation,
                    state: 'failed',
                    completedAt: now,
                    lastIssue: issueFromError('root_scan', error),
                };
                this.publishSnapshot();
            });
            this.scanInFlight = current;
            try {
                await current;
            }
            finally {
                if (this.scanInFlight === current)
                    this.scanInFlight = undefined;
            }
        }
        async performRescan() {
            const workspaceDiscovery = await this.discoverWorkspaceRoots();
            const workspaceRoots = workspaceDiscovery.roots;
            const [scanned, classic] = await Promise.all([
                scanRoots(this.configuredRoots, this.includeDefaults, workspaceRoots),
                this.classicSessionLimit === 0
                    ? Promise.resolve({ sessions: [], source: { state: 'disabled' } })
                    : readClassicSessions(this.classicSessionLimit, this.classicStaleAfterSeconds, {
                        includeCheckoutRoot: this.includeDefaults,
                        sessionRoots: this.configuredRoots,
                        workspaceRoots,
                    }),
            ]);
            const previousSuccess = this.scanObservation.lastSuccessfulAt;
            const observation = workspaceDiscovery.issue === undefined
                ? scanned.observation
                : {
                    ...scanned.observation,
                    state: scanned.observation.state === 'failed' ? 'failed' : 'degraded',
                    lastIssue: mergeIssue(this.scanObservation.lastIssue, workspaceDiscovery.issue),
                };
            this.scanObservation = observation.state === 'failed' && previousSuccess !== undefined
                ? { ...observation, lastSuccessfulAt: previousSuccess }
                : observation;
            this.classicSnapshot = classic;
            const byRunDir = new Map(scanned.runs.map(ref => [ref.runDir, ref]));
            const scanIssues = new Map(scanned.runIssues.map(entry => [entry.runDir, entry.issue]));
            for (const [runDir, tracked] of this.tracked) {
                if (byRunDir.has(runDir))
                    continue;
                tracked.tailer?.stop();
                this.tracked.delete(runDir);
            }
            for (const ref of scanned.runs) {
                const issue = scanIssues.get(ref.runDir);
                const existing = this.tracked.get(ref.runDir);
                if (existing !== undefined) {
                    if (issue !== undefined)
                        this.recordRunIssue(existing, issue);
                    if (existing.ref.discovery !== ref.discovery) {
                        if (existing.ref.discovery !== 'active' && ref.discovery === 'active')
                            continue;
                        existing.ref = ref;
                        if (ref.discovery !== 'active') {
                            existing.tailer?.stop();
                            existing.tailer = undefined;
                            existing.view.status = terminalStatus(ref);
                            existing.observation = {
                                ...existing.observation,
                                state: existing.observation.lastIssue === undefined ? 'complete' : 'degraded',
                            };
                            this.publishRun(existing.view);
                            void this.loadRunResult(existing);
                        }
                        else {
                            this.attachTailer(existing);
                        }
                    }
                    if (existing.view.result === undefined && ref.discovery !== 'active')
                        void this.loadRunResult(existing);
                    continue;
                }
                const tracked = {
                    ref,
                    view: createRunView(ref.runId, ref.runDir, ref.sessionDir),
                    tailer: undefined,
                    observation: {
                        runDir: ref.runDir,
                        mode: ref.discovery === 'active' ? 'tail' : 'backfill',
                        state: issue === undefined ? 'waiting' : 'degraded',
                        byteOffset: 0,
                        linesRead: 0,
                        linesRejected: 0,
                        ...(issue === undefined ? {} : { lastIssue: issue }),
                    },
                };
                this.tracked.set(ref.runDir, tracked);
                if (ref.discovery === 'active')
                    this.attachTailer(tracked);
                else
                    void this.backfillTerminated(tracked);
            }
            this.publishSnapshot();
        }
        /** Merge managed Workspaces with durable Session cwd values, retaining the last good durable list on failure. */
        async discoverWorkspaceRoots() {
            const roots = new Set();
            for (const workspace of this.rootCtx.workspaceRegistry.list()) {
                const normalized = normalizeAbsoluteCwd(workspace.path);
                if (normalized !== undefined)
                    roots.add(normalized);
            }
            let issue;
            try {
                const persisted = new Set();
                for (const header of await this.rootCtx.sessionPersistence.list()) {
                    const normalized = normalizeAbsoluteCwd(header.cwd);
                    if (normalized !== undefined)
                        persisted.add(normalized);
                }
                this.persistedWorkspaceRoots = [...persisted].sort((left, right) => left.localeCompare(right));
            }
            catch (error) {
                issue = issueFromError('root_scan', error, 'warning');
            }
            for (const persisted of this.persistedWorkspaceRoots)
                roots.add(persisted);
            return { roots: [...roots], ...(issue === undefined ? {} : { issue }) };
        }
        async backfillTerminated(tracked) {
            const { ref, view } = tracked;
            let text;
            try {
                text = await (await import('node:fs/promises')).readFile(`${ref.runDir}/.runtime/events.jsonl`, 'utf8');
            }
            catch (error) {
                view.status = terminalStatus(ref);
                this.recordRunIssue(tracked, issueFromError('backfill_read', error));
                tracked.observation = { ...tracked.observation, state: 'failed' };
                if (this.tracked.get(ref.runDir) === tracked) {
                    this.publishRun(view);
                    this.publishSnapshot();
                }
                return;
            }
            for (const line of text.split('\n')) {
                if (line.length === 0)
                    continue;
                tracked.observation = {
                    ...tracked.observation,
                    linesRead: tracked.observation.linesRead + 1,
                    lastReadAt: new Date().toISOString(),
                };
                this.foldLine(tracked, line);
            }
            if (view.status !== 'completed' && view.status !== 'failed')
                view.status = terminalStatus(ref);
            const result = await readWorkflowResult(ref.runDir);
            if (result !== undefined)
                applyWorkflowResult(view, result);
            tracked.observation = {
                ...tracked.observation,
                state: tracked.observation.lastIssue === undefined ? 'complete' : 'degraded',
                byteOffset: Buffer.byteLength(text),
            };
            if (this.tracked.get(ref.runDir) !== tracked)
                return;
            this.publishRun(view);
            this.publishSnapshot();
        }
        attachTailer(tracked) {
            if (tracked.tailer !== undefined)
                return;
            const { ref, view } = tracked;
            const tailer = new EventsTailer(`${ref.runDir}/.runtime/events.jsonl`, (lines) => {
                for (const line of lines)
                    this.foldLine(tracked, line);
                tracked.observation = {
                    ...tracked.observation,
                    state: tracked.observation.lastIssue === undefined ? 'healthy' : 'degraded',
                    byteOffset: tailer.byteOffset,
                    linesRead: tracked.observation.linesRead + lines.length,
                    lastReadAt: new Date().toISOString(),
                };
                this.publishRun(view);
                if (view.status === 'completed' || view.status === 'failed') {
                    tracked.ref = { ...tracked.ref, discovery: view.status };
                    tracked.observation = {
                        ...tracked.observation,
                        state: tracked.observation.lastIssue === undefined ? 'complete' : 'degraded',
                    };
                    tailer.stop();
                    void this.loadRunResult(tracked);
                }
            }, () => {
                if (tracked.tailer === tailer)
                    tracked.tailer = undefined;
            }, {
                onObservation: (observation) => {
                    const previousFingerprint = observationFingerprint(tracked.observation);
                    const currentIssue = tracked.observation.lastIssue;
                    const tailerIssue = observation.lastIssue;
                    const lastIssue = tailerIssue !== undefined
                        && (currentIssue === undefined || tailerIssue.lastSeenAt >= currentIssue.lastSeenAt)
                        ? tailerIssue
                        : currentIssue;
                    const terminal = tracked.view.status === 'completed' || tracked.view.status === 'failed';
                    tracked.observation = {
                        ...tracked.observation,
                        state: terminal
                            ? (lastIssue === undefined ? 'complete' : 'degraded')
                            : observation.state === 'healthy' && lastIssue !== undefined
                                ? 'degraded'
                                : observation.state,
                        byteOffset: observation.byteOffset,
                        linesRead: observation.linesRead,
                        ...(observation.lastReadAt === undefined ? {} : { lastReadAt: observation.lastReadAt }),
                        ...(lastIssue === undefined ? {} : { lastIssue }),
                    };
                    if (observationFingerprint(tracked.observation) !== previousFingerprint)
                        this.publishSnapshot();
                },
            });
            tracked.tailer = tailer;
            try {
                tailer.start();
            }
            catch (error) {
                tracked.tailer = undefined;
                this.recordRunIssue(tracked, issueFromError('tailer_watch', error));
                tracked.observation = { ...tracked.observation, state: 'failed' };
                this.publishSnapshot();
            }
        }
        async loadRunResult(tracked) {
            const result = await readWorkflowResult(tracked.ref.runDir);
            if (result === undefined || this.tracked.get(tracked.ref.runDir) !== tracked)
                return;
            applyWorkflowResult(tracked.view, result);
            this.publishRun(tracked.view);
        }
        foldLine(tracked, line) {
            let decoded;
            try {
                decoded = JSON.parse(line);
            }
            catch (error) {
                this.rejectLine(tracked, issueFromError('event_parse', error, 'warning'));
                return;
            }
            if (decoded === null || typeof decoded !== 'object'
                || typeof decoded.type !== 'string') {
                this.rejectLine(tracked, createIssue('event_parse', 'invalid_payload', 'warning'));
                return;
            }
            try {
                foldEvent(tracked.view, decoded);
            }
            catch (error) {
                this.rejectLine(tracked, issueFromError('event_fold', error, 'warning'));
            }
        }
        rejectLine(tracked, issue) {
            this.recordRunIssue(tracked, issue);
            tracked.observation = {
                ...tracked.observation,
                state: 'degraded',
                linesRejected: tracked.observation.linesRejected + 1,
            };
        }
        recordRunIssue(tracked, issue) {
            tracked.observation = {
                ...tracked.observation,
                lastIssue: mergeIssue(tracked.observation.lastIssue, issue),
            };
        }
        publishSnapshot() {
            const snapshot = this.snapshot();
            const fingerprint = snapshotFingerprint(snapshot);
            if (fingerprint === this.lastPublishedSnapshotFingerprint)
                return;
            this.lastPublishedSnapshotFingerprint = fingerprint;
            this.rootCtx.emit('kersor/event', { kind: 'snapshot', snapshot });
        }
        publishRun(run) {
            this.rootCtx.emit('kersor/event', { kind: 'run', run });
        }
    };
})();
export { KersorViewerService };
function normalizeAbsoluteCwd(value) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !path.isAbsolute(value)) {
        return undefined;
    }
    return path.normalize(value);
}
function rank(ref) {
    if (ref.discovery === 'active')
        return 2;
    if (ref.discovery === 'failed')
        return 1;
    return 0;
}
function terminalStatus(ref) {
    return ref.discovery === 'failed' ? 'failed' : 'completed';
}
function observationFingerprint(observation) {
    const issue = observation.lastIssue;
    return `${observation.state}:${observation.byteOffset}:${observation.linesRead}:${issue?.stage ?? ''}:${issue?.code ?? ''}:${issue?.occurrences ?? 0}`;
}
function issueFingerprint(issue) {
    return issue === undefined ? undefined : [issue.stage, issue.code, issue.severity];
}
/** Ignore scan clocks and repeated identical diagnostics when deciding whether browser state changed. */
function snapshotFingerprint(snapshot) {
    return JSON.stringify({
        runs: snapshot.runs,
        classic: {
            sessions: snapshot.classic.sessions,
            source: {
                state: snapshot.classic.source.state,
                issue: issueFingerprint(snapshot.classic.source.lastIssue),
            },
        },
        scan: {
            state: snapshot.diagnostics.scan.state,
            roots: snapshot.diagnostics.scan.roots.map(root => ({
                root: root.root,
                origin: root.origin,
                state: root.state,
                sessionsExamined: root.sessionsExamined,
                sessionsAccepted: root.sessionsAccepted,
                runsFound: root.runsFound,
                issue: issueFingerprint(root.lastIssue),
            })),
            issue: issueFingerprint(snapshot.diagnostics.scan.lastIssue),
        },
        readers: snapshot.diagnostics.runs.map(run => ({
            runDir: run.runDir,
            mode: run.mode,
            state: run.state,
            byteOffset: run.byteOffset,
            linesRead: run.linesRead,
            linesRejected: run.linesRejected,
            issue: issueFingerprint(run.lastIssue),
        })),
    });
}
/** Cordis plugin entry: the service class itself. */
export default KersorViewerService;
//# sourceMappingURL=service.js.map