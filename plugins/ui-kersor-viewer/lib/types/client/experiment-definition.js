/** Durable KerSor Experiment Conversation Node definition. */
function checkpointClosed(checkpoint) {
    return checkpoint.phase === 'stalled'
        || checkpoint.status === 'blocked'
        || checkpoint.status === 'completed'
        || checkpoint.status === 'cancelled';
}
function project(context) {
    const state = context.state;
    if (state === undefined)
        throw new Error('kersor-experiment projection requires start state');
    const { start, checkpoint } = state;
    const status = checkpoint?.phase === 'stalled' ? 'blocked' : checkpoint?.status ?? 'provisioning';
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
    };
}
/** Experiment start plus monotonic latest-value checkpoints folded into one Chat node. */
export const kersorExperimentDefinition = {
    kind: 'kersor-experiment',
    target: 'chat',
    match: (event) => {
        if (event.type === 'kersor/experiment-start') {
            return { id: String(event.data.experimentId), role: 'start' };
        }
        if (event.type === 'kersor/experiment-checkpoint') {
            return { id: String(event.data.experimentId), role: 'update' };
        }
        return null;
    },
    start: (_context, match) => {
        if (match.event.type !== 'kersor/experiment-start') {
            throw new Error('kersor-experiment start requires kersor/experiment-start');
        }
        return { start: match.event.data };
    },
    update: (context, match) => {
        if (match.event.type !== 'kersor/experiment-checkpoint')
            return context.state;
        const previous = context.state.checkpoint;
        if (match.event.data.childSessionId !== context.state.start.childSessionId
            || (previous !== undefined && (checkpointClosed(previous)
                || match.event.data.revision <= previous.revision)))
            return context.state;
        return { ...context.state, checkpoint: match.event.data };
    },
    publication: () => 'immediate',
    buildViewNode: (context) => {
        if (context.start === undefined)
            return null;
        return {
            key: context.key,
            kind: 'kersor-experiment',
            id: context.id,
            target: 'chat',
            anchorSeq: context.start.event.seq,
            location: context.start.location,
            visibility: 'visible',
            data: project(context),
        };
    },
};
//# sourceMappingURL=experiment-definition.js.map