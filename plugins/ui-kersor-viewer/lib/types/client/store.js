/**
 * Browser-side KerSor viewer store. One Host snapshot owns inventory,
 * classic Sessions, and source health; folded run views and launcher process
 * ownership remain orthogonal client-side accounts.
 * @module @deepseek-ai/dsh-client-ui-kersor-viewer/client
 */
/** Snapshot store over the Host projection and per-run folded views. */
export class KersorViewerStore {
    state = {
        views: new Map(), classicDetails: new Map(), callDetails: new Map(), loading: true,
    };
    listeners = new Set();
    selected;
    selectedClassic;
    /** Stable snapshot for useSyncExternalStore. */
    getSnapshot = () => this.state;
    /** Subscribe to snapshot replacements. */
    subscribe = (listener) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };
    /** Latest run inventory joined with independently folded views. */
    get rows() {
        return (this.state.snapshot?.runs ?? []).map(ref => ({
            ...ref,
            view: this.withInventoryResult(ref.runDir, this.state.views.get(ref.runDir)),
        }));
    }
    /** Currently selected run directory (panel-local choice). */
    get selectedRunDir() {
        return this.selected;
    }
    /** Currently expanded classic Session directory. */
    get selectedClassicSessionDir() {
        return this.selectedClassic;
    }
    /**
     * Select one experiment and its newest discovered run as one UI choice.
     * @param sessionDir - Selected Session directory, or `undefined` to collapse.
     * @returns The newest matching run directory, when the Host discovered one.
     */
    selectClassic(sessionDir) {
        this.selectedClassic = sessionDir;
        this.selected = sessionDir === undefined
            ? undefined
            : [...(this.state.snapshot?.runs ?? [])]
                .filter(ref => ref.sessionDir === sessionDir)
                .sort((left, right) => (right.round ?? 0) - (left.round ?? 0))[0]?.runDir;
        this.state = { ...this.state };
        this.emit();
        return this.selected;
    }
    /**
     * Select a run and its owning experiment; persists across Host snapshots.
     * @param runDir - Exact discovered run directory, or `undefined` to clear selection.
     */
    select(runDir) {
        this.selected = runDir;
        if (runDir === undefined) {
            this.selectedClassic = undefined;
        }
        else {
            this.selectedClassic = this.state.snapshot?.runs.find(ref => ref.runDir === runDir)?.sessionDir;
        }
        this.state = { ...this.state };
        this.emit();
    }
    /**
     * Resolve one previously loaded call detail.
     * @param runDir - Exact discovered run directory.
     * @param callId - Exact folded call identity.
     * @returns Cached detail, or `undefined` before a successful load.
     */
    callDetail(runDir, callId) {
        return this.state.callDetails.get(callDetailKey(runDir, callId));
    }
    /** Selected folded view, falling back to a real available run view. */
    get activeView() {
        if (this.selected !== undefined)
            return this.state.views.get(this.selected);
        const active = this.state.snapshot?.runs.find(ref => ref.discovery === 'active');
        if (active !== undefined)
            return this.state.views.get(active.runDir);
        for (const ref of this.state.snapshot?.runs ?? []) {
            const view = this.state.views.get(ref.runDir);
            if (view !== undefined)
                return view;
        }
        return undefined;
    }
    /**
     * Atomically replace inventory, classic Sessions, and diagnostics.
     * @param snapshot - Complete Host projection from one committed scan.
     */
    setSnapshot(snapshot) {
        const live = new Set(snapshot.runs.map(ref => ref.runDir));
        const views = new Map([...this.state.views].filter(([runDir]) => live.has(runDir)));
        const liveClassic = new Set(snapshot.classic.sessions.map(session => session.session_dir));
        const classicDetails = new Map([...this.state.classicDetails].filter(([sessionDir]) => liveClassic.has(sessionDir)));
        const callDetails = new Map([...this.state.callDetails].filter(([key]) => [...live].some(runDir => key.startsWith(`${runDir}\u0000`))));
        if (this.selectedClassic !== undefined && !liveClassic.has(this.selectedClassic)) {
            this.selectedClassic = undefined;
        }
        if (this.selected !== undefined && !live.has(this.selected))
            this.selected = undefined;
        const { transportError: _, ...state } = this.state;
        const loading = this.state.snapshot === undefined && (snapshot.diagnostics.scan.state === 'never'
            || snapshot.diagnostics.scan.state === 'running');
        this.state = { ...state, snapshot, views, classicDetails, callDetails, loading };
        this.emit();
    }
    /**
     * Record a Remote/connection failure without overwriting Host diagnostics.
     * @param message - Bounded transport diagnostic shown to the user.
     */
    setTransportError(message) {
        this.state = { ...this.state, loading: false, transportError: message };
        this.emit();
    }
    /**
     * Mark one selected classic Session detail as loading.
     * @param sessionDir - Session whose on-demand detail is loading.
     */
    setClassicDetailLoading(sessionDir) {
        const { classicDetailError: _, ...state } = this.state;
        this.state = { ...state, classicDetailLoading: sessionDir };
        this.emit();
    }
    /**
     * Store one successful classic Session detail answer.
     * @param sessionDir - Session owning the answer.
     * @param detail - Valid inspector detail, or `undefined` when unavailable.
     */
    setClassicDetail(sessionDir, detail) {
        const { classicDetailLoading: _, classicDetailError: __, ...state } = this.state;
        const classicDetails = new Map(state.classicDetails);
        if (detail === undefined)
            classicDetails.delete(sessionDir);
        else
            classicDetails.set(sessionDir, detail);
        this.state = { ...state, classicDetails };
        this.emit();
    }
    /**
     * Record a bounded detail-read failure without replacing the summary snapshot.
     * @param sessionDir - Session whose detail failed.
     * @param message - Remote transport diagnostic.
     */
    setClassicDetailError(sessionDir, message) {
        const { classicDetailLoading: _, ...state } = this.state;
        this.state = { ...state, classicDetailError: `${sessionDir}: ${message}` };
        this.emit();
    }
    /**
     * Mark one call detail as loading.
     * @param runDir - Exact discovered run directory.
     * @param callId - Exact folded call identity.
     */
    setCallDetailLoading(runDir, callId) {
        const { callDetailError: _, ...state } = this.state;
        this.state = { ...state, callDetailLoading: callDetailKey(runDir, callId) };
        this.emit();
    }
    /**
     * Store one successful bounded call-detail answer.
     * @param runDir - Exact discovered run directory.
     * @param callId - Exact folded call identity.
     * @param detail - Bounded answer, or `undefined` when artifacts are unavailable.
     */
    setCallDetail(runDir, callId, detail) {
        const { callDetailLoading: _, callDetailError: __, ...state } = this.state;
        const callDetails = new Map(state.callDetails);
        const key = callDetailKey(runDir, callId);
        if (detail === undefined)
            callDetails.delete(key);
        else
            callDetails.set(key, detail);
        this.state = { ...state, callDetails };
        this.emit();
    }
    /**
     * Record a call-detail transport failure without replacing run progress.
     * @param runDir - Exact discovered run directory.
     * @param callId - Exact folded call identity.
     * @param message - Remote transport diagnostic.
     */
    setCallDetailError(runDir, callId, message) {
        const { callDetailLoading: _, ...state } = this.state;
        this.state = { ...state, callDetailError: `${callDetailKey(runDir, callId)}: ${message}` };
        this.emit();
    }
    /**
     * Replace the optional launcher's configured-task and owned-process inventory.
     * @param tasks - Deployment-configured tasks exposed by the Host.
     * @param active - Processes currently owned by the launcher service.
     */
    setLauncher(tasks, active) {
        this.state = { ...this.state, launcher: { tasks, active } };
        this.emit();
    }
    /** Hide controls when the Host launcher plugin is not loaded. */
    setLauncherUnavailable() {
        if (this.state.launcher === undefined)
            return;
        const { launcher: _, ...state } = this.state;
        this.state = state;
        this.emit();
    }
    /**
     * Record a launch/stop failure without contaminating viewer read state.
     * @param message - Bounded launcher failure text.
     */
    setLauncherError(message) {
        if (this.state.launcher === undefined)
            return;
        this.state = { ...this.state, launcher: { ...this.state.launcher, error: message } };
        this.emit();
    }
    /**
     * Apply the Host launcher's complete owned-process replacement frame.
     * @param frame - Complete active-launch replacement.
     */
    applyActiveFrame(frame) {
        if (this.state.launcher === undefined)
            return;
        this.state = { ...this.state, launcher: { ...this.state.launcher, active: frame.launches } };
        this.emit();
    }
    /**
     * Apply one forwarded Host frame.
     * @param frame - Atomic snapshot replacement or one folded run update.
     */
    applyFrame(frame) {
        if (frame.kind === 'snapshot') {
            this.setSnapshot(frame.snapshot);
            return;
        }
        const views = new Map(this.state.views);
        views.set(frame.run.runDir, this.withInventoryResult(frame.run.runDir, frame.run) ?? frame.run);
        this.state = { ...this.state, views, loading: false };
        this.emit();
    }
    /**
     * Store a successful `runBacklog` answer; undefined never fabricates zeros.
     * @param runDir - Exact discovered run directory.
     * @param view - Folded backlog, or `undefined` when unavailable.
     */
    setBacklog(runDir, view) {
        if (view === undefined)
            return;
        const views = new Map(this.state.views);
        views.set(runDir, this.withInventoryResult(runDir, view) ?? view);
        this.state = { ...this.state, views, loading: false };
        this.emit();
    }
    /**
     * Attach one separately loaded bounded Workflow result to its folded run view.
     * @param runDir - Exact discovered run directory.
     * @param result - Candidate and Host verification projection, when available.
     */
    setRunResult(runDir, result) {
        if (result === undefined)
            return;
        const existing = this.state.views.get(runDir);
        if (existing === undefined)
            return;
        const views = new Map(this.state.views);
        views.set(runDir, {
            ...existing,
            result,
            candidateStage: result.stage,
            verification: result.verification,
            failureKind: result.failureKind,
            selectedCandidateId: result.selectedCandidateId,
            expectedCycles: result.expectedCycles,
            measuredBaselineCycles: result.measuredBaselineCycles,
            measuredCycles: result.measuredCycles,
            estimatedSpeedup: result.estimatedSpeedup,
            measuredSpeedup: result.measuredSpeedup,
            incumbentCycles: result.incumbentCycles,
            incumbentSpeedup: result.incumbentSpeedup,
            bestImproved: result.bestImproved,
            candidates: result.candidates,
        });
        this.state = { ...this.state, views };
        this.emit();
    }
    /** Drop connection-scoped state. */
    reset() {
        this.state = {
            views: new Map(), classicDetails: new Map(), callDetails: new Map(), loading: true,
        };
        this.selected = undefined;
        this.selectedClassic = undefined;
        this.emit();
    }
    withInventoryResult(runDir, view) {
        if (view === undefined || view.result !== undefined)
            return view;
        const result = this.state.snapshot?.runs.find(ref => ref.runDir === runDir)?.result;
        return result === undefined
            ? view
            : {
                ...view,
                result,
                candidateStage: result.stage,
                verification: result.verification,
                failureKind: result.failureKind,
                selectedCandidateId: result.selectedCandidateId,
                expectedCycles: result.expectedCycles,
                measuredBaselineCycles: result.measuredBaselineCycles,
                measuredCycles: result.measuredCycles,
                estimatedSpeedup: result.estimatedSpeedup,
                measuredSpeedup: result.measuredSpeedup,
                incumbentCycles: result.incumbentCycles,
                incumbentSpeedup: result.incumbentSpeedup,
                bestImproved: result.bestImproved,
                candidates: result.candidates,
            };
    }
    emit() {
        for (const listener of this.listeners)
            listener();
    }
}
function callDetailKey(runDir, callId) {
    return `${runDir}\u0000${callId}`;
}
//# sourceMappingURL=store.js.map