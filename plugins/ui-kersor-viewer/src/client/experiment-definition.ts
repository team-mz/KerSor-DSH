/** Durable KerSor Experiment Conversation Node definition. */

import type {
  ChatConversationViewNode, ConversationNodeContext, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  KersorExperimentCheckpointEventData,
  KersorExperimentStartEventData,
  KersorExperimentStatus,
  KersorExperimentStep,
} from '@deepseek-ai/dsh-kersor/types'

/** Renderer-ready projection of one conversation-bound KerSor experiment. */
export interface KersorExperimentChatData {
  readonly experimentId: string
  readonly childSessionId: string
  readonly objective: string
  readonly origin: 'created' | 'attached'
  readonly freshSession: boolean
  readonly revision: number
  readonly status: KersorExperimentStatus
  readonly kersorSessionId?: string
  readonly phase?: string
  readonly currentRound?: number
  readonly maxWorkflows?: number
  readonly workflow?: string
  readonly bestSpeedup?: number
  readonly targetSpeedup?: number
  readonly nextAction?: string
  readonly steps: readonly KersorExperimentStep[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** One KerSor experiment whose execution conversation is a continuable child. */
    'kersor-experiment': KersorExperimentChatData
  }
}

interface ExperimentState {
  readonly start: KersorExperimentStartEventData
  readonly checkpoint?: KersorExperimentCheckpointEventData
}

function checkpointClosed(checkpoint: KersorExperimentCheckpointEventData): boolean {
  return checkpoint.phase === 'stalled'
    || checkpoint.status === 'blocked'
    || checkpoint.status === 'completed'
    || checkpoint.status === 'cancelled'
}

function project(context: ConversationNodeContext<ExperimentState>): KersorExperimentChatData {
  const state = context.state
  if (state === undefined) throw new Error('kersor-experiment projection requires start state')
  const { start, checkpoint } = state
  const status = checkpoint?.phase === 'stalled' ? 'blocked' : checkpoint?.status ?? 'provisioning'
  return {
    experimentId: start.experimentId,
    childSessionId: start.childSessionId,
    objective: start.objective,
    origin: start.origin,
    freshSession: start.freshSession,
    revision: checkpoint?.revision ?? 0,
    status,
    ...(checkpoint?.kersorSessionId === undefined ? {} : { kersorSessionId: checkpoint.kersorSessionId }),
    ...(checkpoint?.phase === undefined ? {} : { phase: checkpoint.phase }),
    ...(checkpoint?.currentRound === undefined ? {} : { currentRound: checkpoint.currentRound }),
    ...(checkpoint?.maxWorkflows === undefined ? {} : { maxWorkflows: checkpoint.maxWorkflows }),
    ...(checkpoint?.workflow === undefined ? {} : { workflow: checkpoint.workflow }),
    ...(checkpoint?.bestSpeedup === undefined ? {} : { bestSpeedup: checkpoint.bestSpeedup }),
    ...(checkpoint?.targetSpeedup === undefined ? {} : { targetSpeedup: checkpoint.targetSpeedup }),
    ...(status === 'blocked' || checkpoint?.nextAction === undefined ? {} : { nextAction: checkpoint.nextAction }),
    steps: checkpoint?.steps ?? [],
  }
}

/** Experiment start plus monotonic latest-value checkpoints folded into one Chat node. */
export const kersorExperimentDefinition: ConversationNodeDefinition<ExperimentState> = {
  kind: 'kersor-experiment',
  target: 'chat',
  match: (event) => {
    if (event.type === 'kersor/experiment-start') {
      return { id: String(event.data.experimentId), role: 'start' }
    }
    if (event.type === 'kersor/experiment-checkpoint') {
      return { id: String(event.data.experimentId), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'kersor/experiment-start') {
      throw new Error('kersor-experiment start requires kersor/experiment-start')
    }
    return { start: match.event.data }
  },
  update: (context, match) => {
    if (match.event.type !== 'kersor/experiment-checkpoint') return context.state
    const previous = context.state.checkpoint
    if (match.event.data.childSessionId !== context.state.start.childSessionId
      || (previous !== undefined && (checkpointClosed(previous)
        || match.event.data.revision <= previous.revision))) return context.state
    return { ...context.state, checkpoint: match.event.data }
  },
  publication: () => 'immediate',
  buildViewNode: (context): ChatConversationViewNode | null => {
    if (context.start === undefined) return null
    return {
      key: context.key,
      kind: 'kersor-experiment',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start.event.seq,
      location: context.start.location,
      visibility: 'visible',
      data: project(context),
    }
  },
}
