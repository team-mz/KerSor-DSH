/** Terminal-aware presentation policy for a Session's historical fit verdict. */
/**
 * Apply the rule that a terminal veto outranks any earlier fit result.
 * @param session - Session whose lifecycle and historical confidence are projected.
 * @returns Visible confidence, or `undefined` when terminal ownership suppresses it.
 */
export function visibleFitConfidence(session) {
    if (session.lifecycle === 'stalled' || session.lifecycle === 'cancelled')
        return undefined;
    return session.fit_confidence ?? undefined;
}
//# sourceMappingURL=readiness.js.map