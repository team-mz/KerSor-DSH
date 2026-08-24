// @vitest-environment jsdom
/** Conversation replay and rendering for durable KerSor experiment bindings. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ChatConversationViewNode, ConversationEventInput, ConversationNodeDefinition,
  ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import {
  KersorExperimentNode, type KersorExperimentNodeProps,
} from '../src/client/KersorExperimentNode.tsx'
import {
  kersorExperimentDefinition, type KersorExperimentChatData,
} from '../src/client/experiment-definition.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

interface ChatSnapshot {
  readonly nodes: ReadonlyMap<string, ChatConversationViewNode>
}

class Definitions {
  entries(): readonly ConversationNodeDefinition[] { return [kersorExperimentDefinition] }
  fallbackEntry(): undefined { return undefined }
}

class Views {
  entries(): readonly ConversationViewDefinition[] { return [chatView] }
}

const chatView: ConversationViewDefinition<ChatConversationViewNode, ChatSnapshot> = {
  target: 'chat',
  create: () => {
    let nodes = new Map<string, ChatConversationViewNode>()
    return {
      empty: { nodes },
      replace: ({ nodes: values }) => {
        nodes = new Map(values.map(node => [node.key, node]))
        return { nodes }
      },
      apply: ({ upserts }) => {
        nodes = new Map(nodes)
        for (const node of upserts) nodes.set(node.key, node)
        return { nodes }
      },
    }
  },
}

function at(seq: number, type: string, data: unknown): ConversationEventInput {
  return { event: { seq, time: seq * 100, type, data } as ConversationEventInput['event'], view: undefined }
}

function events(): ConversationEventInput[] {
  return [
    at(1, 'turn/start', { turn: 1 }),
    at(2, 'step/start', { turn: 1, step: 1 }),
    at(3, 'kersor/experiment-start', {
      experimentId: 'kersor-e1', childSessionId: 'kersor-child', origin: 'created',
      objective: 'Optimize the VLIW kernel', freshSession: true, turn: 1, step: 1,
    }),
    at(4, 'step/end', { turn: 1, step: 1 }),
    at(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    at(6, 'kersor/experiment-checkpoint', {
      experimentId: 'kersor-e1', childSessionId: 'kersor-child', revision: 1,
      status: 'running', kersorSessionId: '20260821-134926', phase: 'optimizing',
      currentRound: 1, maxWorkflows: 3, workflow: 'bundle-pack', bestSpeedup: 2.4,
      nextAction: 'Run Host verification',
      steps: [
        { id: 'setup', status: 'completed' },
        { id: 'baseline', status: 'completed' },
        { id: 'profile', status: 'active' },
      ],
    }),
  ]
}

function assembler(input: readonly ConversationEventInput[], hasMore = false): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(new Definitions(), new Views())
  value.replaceWindow(input, hasMore)
  value.flush()
  return value
}

type ExperimentNode = ChatConversationViewNode & {
  readonly kind: 'kersor-experiment'
  readonly data: KersorExperimentChatData
}

function node(value: ConversationNodeAssembler): ExperimentNode | undefined {
  const candidate = [...(value.snapshot('chat') as ChatSnapshot).nodes.values()][0]
  return candidate?.kind === 'kersor-experiment' ? candidate as ExperimentNode : undefined
}

function requiredNode(value: ConversationNodeAssembler): ExperimentNode {
  const candidate = node(value)
  if (candidate === undefined) throw new Error('expected a KerSor experiment node')
  return candidate
}

describe('KerSor Experiment Conversation Node', () => {
  it('keeps the background experiment running after its owning turn closes', () => {
    const value = assembler(events())
    expect(node(value)?.data).toMatchObject({
      experimentId: 'kersor-e1', childSessionId: 'kersor-child', status: 'running',
      phase: 'optimizing', workflow: 'bundle-pack', revision: 1,
    })
    expect(node(value)?.location.kind).toBe('step')
  })

  it('keeps an update-only tail pending until the immutable binding is prepended', () => {
    const complete = events()
    const value = assembler(complete.slice(5), true)
    expect(node(value)).toBeUndefined()
    value.prepend(complete.slice(0, 5), false)
    value.flush()
    expect(node(value)?.data).toEqual(node(assembler(complete))?.data)
  })

  it('adopts only increasing revisions and clears next action at completion', () => {
    const value = assembler(events())
    value.append(at(7, 'kersor/experiment-checkpoint', {
      experimentId: 'kersor-e1', childSessionId: 'kersor-child', revision: 1,
      status: 'waiting', nextAction: 'stale', steps: [],
    }))
    value.append(at(8, 'kersor/experiment-checkpoint', {
      experimentId: 'kersor-e1', childSessionId: 'kersor-child', revision: 2,
      status: 'completed', phase: 'complete', bestSpeedup: 69.35,
      steps: [{ id: 'decision', status: 'completed' }],
    }))
    value.flush()
    expect(node(value)?.data).toMatchObject({ status: 'completed', revision: 2, bestSpeedup: 69.35 })
    expect((node(value)?.data as KersorExperimentChatData).nextAction).toBeUndefined()
  })

  it('closes a legacy waiting checkpoint at stalled and ignores a later reopen', () => {
    const value = assembler(events())
    value.append(at(7, 'kersor/experiment-checkpoint', {
      experimentId: 'kersor-e1', childSessionId: 'kersor-child', revision: 2,
      status: 'waiting', phase: 'stalled', nextAction: 'Continue', steps: [],
    }))
    value.append(at(8, 'kersor/experiment-checkpoint', {
      experimentId: 'kersor-e1', childSessionId: 'kersor-child', revision: 3,
      status: 'running', nextAction: 'invalid reopen', steps: [],
    }))
    value.flush()
    expect(node(value)?.data).toMatchObject({ status: 'blocked', phase: 'stalled', revision: 2 })
    expect(node(value)?.data.nextAction).toBeUndefined()
  })

  it('renders milestones and opens the durable controller conversation', () => {
    const current = requiredNode(assembler(events()))
    const openController = vi.fn()
    const props = {
      node: current,
      openController,
      t: makeTranslate(zh),
    } as unknown as KersorExperimentNodeProps
    render(<KersorExperimentNode {...props} />)
    expect(screen.getByText('20260821-134926')).toBeTruthy()
    expect(screen.getByText('Optimize the VLIW kernel')).toBeTruthy()
    expect(screen.getByText('Workflow：bundle-pack')).toBeTruthy()
    expect(screen.getByText('Run Host verification')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看 DSH 执行对话' }))
    expect(openController).toHaveBeenCalledWith('kersor-child')
  })
})
