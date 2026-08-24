/**
 * Package-owned invariants for the KerSor launcher and conversation binding.
 * @module @deepseek-ai/dsh-kersor/invariant
 */
import type { Context } from '@deepseek-ai/cordis';
/** KerSor invariant companion plugin name. */
export declare const name = "kersor-invariant";
/** Services required before the companion can reserve package ownership. */
export declare const inject: string[];
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map