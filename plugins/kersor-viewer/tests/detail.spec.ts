import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readCallDetail } from '../src/detail.ts'
import type { KersorCallView } from '../src/fold.ts'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('bounded Workflow call detail', () => {
  it('projects messages and tool names without forwarding tool payloads', async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), 'kersor-call-detail-'))
    dirs.push(runDir)
    const resultsDir = path.join(runDir, '.runtime', 'agent-results')
    await mkdir(resultsDir, { recursive: true })
    const stem = '00002-author-simd-batch-v1'
    await writeFile(path.join(resultsDir, `${stem}.json`), JSON.stringify({
      thread_id: 'thread-123',
      model_role: null,
      isolation: { effective: 'fresh-process' },
      usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 4, total_tokens: 16 },
    }))
    await writeFile(path.join(resultsDir, `${stem}.codex-events.jsonl`), [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'm1', type: 'agent_message', text: 'candidate analysis' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 't1', type: 'mcp_tool_call', server: 'node_repl', tool: 'js', status: 'completed',
          arguments: { token: 'SECRET-ARGUMENT' }, result: { text: 'SECRET-RESULT' },
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'w1', type: 'web_search', query: 'VLIW scheduling' },
      }),
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 4 },
      }),
      '',
    ].join('\n'))
    const call: KersorCallView = {
      seq: 2,
      callId: 'Author/author-simd-batch-v1/2',
      label: 'author-simd-batch-v1',
      kind: 'agent',
      status: 'completed',
    }

    const detail = await readCallDetail(runDir, call)

    expect(detail).toMatchObject({
      callId: call.callId,
      runner: 'codex-exec',
      threadId: 'thread-123',
      model: null,
      isolation: 'fresh-process',
      messages: [{ id: 'm1', text: 'candidate analysis' }],
      activities: [
        { id: 't1', kind: 'tool', label: 'node_repl/js', status: 'completed' },
        { id: 'w1', kind: 'web-search', label: 'VLIW scheduling', status: 'completed' },
      ],
      usage: { inputTokens: 12, cachedInputTokens: 3, outputTokens: 4, totalTokens: 16 },
      truncated: false,
    })
    expect(JSON.stringify(detail)).not.toContain('SECRET-ARGUMENT')
    expect(JSON.stringify(detail)).not.toContain('SECRET-RESULT')
  })
})
