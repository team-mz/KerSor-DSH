/**
 * Bounded, content-free diagnostics shared by KerSor viewer sources.
 * @module @deepseek-ai/dsh-kersor-viewer
 */

/** Operation that produced a viewer source issue. */
export type KersorDiagnosticStage =
  | 'checkout_pointer'
  | 'root_scan'
  | 'session_inspect'
  | 'runs_scan'
  | 'summary_read'
  | 'backfill_read'
  | 'event_parse'
  | 'event_fold'
  | 'tailer_watch'
  | 'tailer_read'
  | 'classic_bridge'

/** Stable, content-free classification safe to send over the Remote boundary. */
export type KersorDiagnosticCode =
  | 'not_found'
  | 'permission_denied'
  | 'invalid_json'
  | 'invalid_payload'
  | 'watch_unavailable'
  | 'process_unavailable'
  | 'timeout'
  | 'io_error'
  | 'unexpected'

/** Last bounded issue for one source; raw exception text is never retained. */
export interface KersorDiagnosticIssue {
  readonly stage: KersorDiagnosticStage
  readonly code: KersorDiagnosticCode
  readonly severity: 'warning' | 'error'
  readonly occurrences: number
  readonly lastSeenAt: string
}

/**
 * Create a safe issue from a runtime failure without retaining its message.
 * @param stage - Operation that failed.
 * @param error - Untrusted runtime failure to classify without its text.
 * @param severity - Stable user-facing impact category.
 * @returns Content-free diagnostic safe for the Remote wire.
 */
export function issueFromError(
  stage: KersorDiagnosticStage,
  error: unknown,
  severity: KersorDiagnosticIssue['severity'] = 'error',
): KersorDiagnosticIssue {
  return createIssue(stage, classifyError(stage, error), severity)
}

/**
 * Create a safe issue for a validated failure code.
 * @param stage - Operation that failed.
 * @param code - Stable failure classification.
 * @param severity - Stable user-facing impact category.
 * @returns Content-free diagnostic safe for the Remote wire.
 */
export function createIssue(
  stage: KersorDiagnosticStage,
  code: KersorDiagnosticCode,
  severity: KersorDiagnosticIssue['severity'] = 'error',
): KersorDiagnosticIssue {
  return { stage, code, severity, occurrences: 1, lastSeenAt: new Date().toISOString() }
}

/**
 * Merge repeated identical failures while bounding history to the latest kind.
 * @param previous - Previously retained issue, when one exists.
 * @param current - Newly observed issue.
 * @returns Current issue with an accumulated count only for the same kind.
 */
export function mergeIssue(
  previous: KersorDiagnosticIssue | undefined,
  current: KersorDiagnosticIssue,
): KersorDiagnosticIssue {
  if (previous?.stage !== current.stage || previous.code !== current.code) return current
  return { ...current, occurrences: previous.occurrences + 1 }
}

/**
 * Read a Node-style error code from an unknown exception.
 * @param error - Unknown caught value.
 * @returns Stringified code, or `undefined` when none is present.
 */
export function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined
}

function classifyError(stage: KersorDiagnosticStage, error: unknown): KersorDiagnosticCode {
  if (error instanceof SyntaxError) return 'invalid_json'
  const code = errorCode(error)
  if (code === 'EACCES' || code === 'EPERM') return 'permission_denied'
  if (code === 'ETIMEDOUT') return 'timeout'
  if (code === 'ENOENT') return stage === 'classic_bridge' ? 'process_unavailable' : 'not_found'
  if (stage === 'tailer_watch') return 'watch_unavailable'
  if (code !== undefined) return 'io_error'
  return 'unexpected'
}
