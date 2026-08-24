/** Conversation card for one DSH-owned KerSor experiment. */
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
/** Navigation injected by the KerSor client plugin. */
export interface KersorExperimentInjected {
    readonly openController: (childSessionId: SessionId) => void;
}
/** Complete keyed Chat renderer props. */
export type KersorExperimentNodeProps = PropsRuntime<'conversation.chat.node', 'kersor-experiment'> & PropsLocale<'kersorViewer'> & KersorExperimentInjected;
/** Render one stable experiment summary and its durable child-conversation link. */
export declare function KersorExperimentNode({ node, openController, t }: KersorExperimentNodeProps): import("react").JSX.Element;
//# sourceMappingURL=KersorExperimentNode.d.ts.map