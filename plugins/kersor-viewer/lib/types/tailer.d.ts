/**
 * Position-tracking tail of one KerSor `events.jsonl`. The writer appends one
 * JSON record per flushed line, so a byte-offset reader with truncation
 * detection is a complete live stream; `fs.watch` wakes the reader and a slow
 * poll backs it up on platforms where watch events lag (macOS FSEvents).
 * @module @deepseek-ai/dsh-kersor-viewer
 */
import type { KersorDiagnosticIssue } from './diagnostics.ts';
/** Current health of one events.jsonl tail source. */
export interface EventsTailerObservation {
    readonly state: 'waiting' | 'healthy' | 'degraded' | 'failed';
    readonly byteOffset: number;
    readonly linesRead: number;
    readonly lastReadAt?: string;
    readonly lastIssue?: KersorDiagnosticIssue;
}
/** Optional polling and observation callbacks for one position-tracking tailer. */
export interface EventsTailerOptions {
    /** Poll fallback interval; also bounds watch-event latency. */
    readonly pollMs?: number;
    /** Complete replacement observation after source state changes. */
    readonly onObservation?: (observation: EventsTailerObservation) => void;
}
/** Live reader over one events.jsonl file. */
export declare class EventsTailer {
    private readonly file;
    private readonly pollMs;
    private readonly onLines;
    private readonly onEnd;
    private readonly onObservation;
    private offset;
    private watcher;
    private timer;
    private reading;
    private stopped;
    private watchDegraded;
    private observationState;
    /**
     * @param file - absolute path to `events.jsonl`.
     * @param onLines - complete new lines (no trailing newline), in file order.
     * @param onEnd - optional callback when stop() completes.
     * @param options - polling interval and optional observation sink.
     */
    constructor(file: string, onLines: (lines: string[]) => void, onEnd?: () => void, options?: EventsTailerOptions);
    /** Begin watching; the first drain reads any lines already present. */
    start(): void;
    /** Stop watching and invoke `onEnd`. Safe to call twice. */
    stop(): void;
    /** Current byte offset (diagnostics and tests). */
    get byteOffset(): number;
    /** Complete current tail-source observation. */
    get observation(): EventsTailerObservation;
    /** Read newly appended complete lines; detect truncation and reset. */
    drain(): Promise<void>;
    private recordWatchIssue;
    private recordReadIssue;
    private recordReadSuccess;
    private replaceObservation;
    private publishObservation;
}
//# sourceMappingURL=tailer.d.ts.map