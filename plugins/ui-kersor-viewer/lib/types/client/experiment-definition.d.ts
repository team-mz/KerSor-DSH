/** Durable KerSor Experiment Conversation Node definition. */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client';
import type { KersorExperimentCheckpointEventData, KersorExperimentStartEventData, KersorExperimentStatus, KersorExperimentStep } from '@deepseek-ai/dsh-kersor/types';
/** Renderer-ready projection of one conversation-bound KerSor experiment. */
export interface KersorExperimentChatData {
    readonly experimentId: string;
    readonly childSessionId: string;
    readonly objective: string;
    readonly origin: 'created' | 'attached';
    readonly freshSession: boolean;
    readonly revision: number;
    readonly status: KersorExperimentStatus;
    readonly kersorSessionId?: string;
    readonly phase?: string;
    readonly currentRound?: number;
    readonly maxWorkflows?: number;
    readonly workflow?: string;
    readonly bestSpeedup?: number;
    readonly targetSpeedup?: number;
    readonly nextAction?: string;
    readonly steps: readonly KersorExperimentStep[];
}
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
    interface ChatNodeDataMap {
        /** One KerSor experiment whose execution conversation is a continuable child. */
        'kersor-experiment': KersorExperimentChatData;
    }
}
interface ExperimentState {
    readonly start: KersorExperimentStartEventData;
    readonly checkpoint?: KersorExperimentCheckpointEventData;
}
/** Experiment start plus monotonic latest-value checkpoints folded into one Chat node. */
export declare const kersorExperimentDefinition: ConversationNodeDefinition<ExperimentState>;
export {};
//# sourceMappingURL=experiment-definition.d.ts.map