/**
 * KerSor viewer browser half: one atomic Host snapshot plus optional launcher
 * process ownership, rendered as a first-class conversation view.
 * @module @deepseek-ai/dsh-client-ui-kersor-viewer/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import { NS } from './locales.ts';
import type { KersorViewerKey } from './locales.ts';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** KerSor viewer panel copy. */
        kersorViewer: KersorViewerKey;
    }
}
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface TypertRemoteEventSelection extends Record<'kersor/event' | 'kersor/active', true> {
    }
}
export type { KersorViewFace } from './slots.ts';
export type { KersorRunRow, KersorSelectionIntent, KersorViewerState, KersorViewerStore, } from './store.ts';
export { KersorViewerStore as KersorViewerStoreClass } from './store.ts';
export { NS };
export type { KersorViewerKey } from './locales.ts';
/** Required services: viewer UI seams, assembled Remotes, and Host inventory. */
export declare const inject: string[];
/** Mount the KerSor viewer surfaces over the API assembly's Remote namespaces. */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map