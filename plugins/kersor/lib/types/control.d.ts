/**
 * Conversation-scoped KerSor controls. One tool reserves a durable
 * experiment-to-child binding before starting a continuable dsh child; the
 * other delivers a later turn to that same child or binds an existing KerSor
 * Session when the conversation has no binding yet.
 * @module @deepseek-ai/dsh-kersor/control
 */
import type { Context } from '@deepseek-ai/cordis';
/** Required host services: tools, durable sessions, and continuable subagents. */
export declare const name = "kersor-control";
export declare const inject: string[];
/** Register the start/resume tools and project child settlement into the parent log. */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=control.d.ts.map