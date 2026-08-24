/** Terminal-aware presentation policy for a Session's historical fit verdict. */

import type { KersorClassicSession } from '@deepseek-ai/dsh-kersor-viewer/types'

/**
 * Apply the rule that a terminal veto outranks any earlier fit result.
 * @param session - Session whose lifecycle and historical confidence are projected.
 * @returns Visible confidence, or `undefined` when terminal ownership suppresses it.
 */
export function visibleFitConfidence(
  session: Pick<KersorClassicSession, 'lifecycle' | 'fit_confidence'>,
): string | undefined {
  if (session.lifecycle === 'stalled' || session.lifecycle === 'cancelled') return undefined
  return session.fit_confidence ?? undefined
}
