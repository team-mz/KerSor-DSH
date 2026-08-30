"""Host-tool regression tests for the KerSor Mission launcher."""

from __future__ import annotations

import json
import hashlib
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "presets" / "kersor" / "plugins" / "kersor-evolve.mjs"
BRIDGE_SOURCE = ROOT / "presets" / "kersor" / "bin" / "kersor_bridge.py"
NODE = shutil.which("node")


FAKE_BRIDGE = """\
import json
import os
import subprocess
import sys
import time
from pathlib import Path

contract = Path(sys.argv[sys.argv.index("--contract") + 1])
request = json.loads(contract.read_text(encoding="utf-8"))
if request.get("launch_marker"):
    Path(request["launch_marker"]).write_text("launched", encoding="utf-8")
if request.get("mode") == "descendant":
    marker = request["marker"]
    subprocess.Popen([
        sys.executable,
        "-c",
        "import pathlib,time; time.sleep(1); pathlib.Path(" + repr(marker) + ").write_text('orphan')",
    ])
if request.get("mode") == "sleep":
    time.sleep(30)
if request.get("mode") == "descendant":
    time.sleep(30)
terminal = {
    "status": request.get("status", "completed"),
    "argv": sys.argv[1:],
    "cwd": os.getcwd(),
    "ambient_kersor_root": os.environ.get("KERSOR_ROOT"),
    "ambient_pythonpath": os.environ.get("PYTHONPATH"),
    "ambient_aws": os.environ.get("AWS_SECRET_ACCESS_KEY"),
    "ambient_github": os.environ.get("GITHUB_TOKEN"),
    "ambient_ssh": os.environ.get("SSH_AUTH_SOCK"),
    "ambient_openai": os.environ.get("OPENAI_API_KEY"),
}
if request.get("mode") == "multiple":
    print(json.dumps(terminal))
print(json.dumps(terminal))
raise SystemExit(request.get("exit", 0))
"""


NODE_DRIVER = r"""
import fs from 'node:fs'
import {pathToFileURL} from 'node:url'

const request = JSON.parse(fs.readFileSync(0, 'utf8'))
const plugin = await import(pathToFileURL(request.module).href)
const tool = plugin.createTool({timeoutMs: request.timeout_ms ?? 5000})
const controller = new AbortController()
if (request.abort_after_ms !== undefined) {
  setTimeout(() => controller.abort(new Error('test cancellation')), request.abort_after_ms).unref()
}
let concludeCount = 0
const exec = {
  callId: 'call-test-evolve',
  agent: {session: {
    header: {cwd: request.cwd, origin: request.origin ?? 'user'},
    events: request.historical_call === true
      ? [
          {type: 'tool/call', data: {turn: 1, step: 1, callId: 'call-previous-evolve', name: 'kersor_evolve'}},
          {type: 'turn/end', data: {turn: 1}},
          {type: 'tool/call', data: {turn: 2, step: 1, callId: 'call-test-evolve', name: 'kersor_evolve'}},
        ]
      : request.historical_command === true
        ? [
            {type: 'command/run', data: {commandId: 'cmd-previous', name: 'kersor-evolve', args: '{}', source: {kind: 'user'}}},
            {type: 'command/done', data: {commandId: 'cmd-previous', kind: 'success'}},
            {type: 'tool/call', data: {turn: 1, step: 1, callId: 'call-test-evolve', name: 'kersor_evolve'}},
          ]
      : [{type: 'tool/call', data: {turn: 1, step: 1, callId: 'call-test-evolve', name: 'kersor_evolve'}}],
  }},
  signal: controller.signal,
  concludeTurn() { concludeCount += 1 },
}
let payload
try {
  const value = await tool.execute(request.args, exec)
  const meta = tool.output.presentationMeta?.(request.args, value)
  const presentation = tool.presentResult?.(request.args, {isError: false, content: [], meta})
  if (request.second_call === true) {
    try {
      await tool.execute(request.args, exec)
      payload = {ok: false, conclude_count: concludeCount, error: 'second call unexpectedly succeeded'}
    } catch (error) {
      payload = {
        ok: true,
        conclude_count: concludeCount,
        value,
        presentation_meta: meta,
        presentation,
        second_error: String(error?.message ?? error),
      }
    }
  } else {
    payload = {
      ok: true,
      conclude_count: concludeCount,
      value,
      presentation_meta: meta,
      presentation,
    }
  }
} catch (error) {
  if (request.second_call === true) {
    const firstError = String(error?.message ?? error)
    try {
      await tool.execute(request.args, exec)
      payload = {ok: false, conclude_count: concludeCount, error: 'second call unexpectedly succeeded'}
    } catch (secondError) {
      payload = {
        ok: true,
        conclude_count: concludeCount,
        first_error: firstError,
        second_error: String(secondError?.message ?? secondError),
      }
    }
  } else {
    payload = {ok: false, conclude_count: concludeCount, error: String(error?.message ?? error)}
  }
}
payload.status_schema = tool.output.schema.properties.status
process.stdout.write(JSON.stringify(payload))
"""


DSH_NODE_DRIVER = r"""
import fs from 'node:fs'
import {pathToFileURL} from 'node:url'

const request = JSON.parse(fs.readFileSync(0, 'utf8'))
const driverStartedAt = Date.now()
let contextWindowIndex = 0
const plugin = await import(pathToFileURL(request.module).href)
const listeners = new Map()
const telemetry = {
  starts: [],
  guards: {},
  agent_document: request.agent_document ?? null,
  scoped_tool_descriptions: {},
  dispose_count: 0,
  provider_calls: 0,
  streamed_calls: [],
}
const topLevelGuards = []
let registeredTool
let registeredCommand
let scopedSubagentDefinition
const quotaFailure = {
  message: '[Service quota exceeded.]',
  code: 'QUOTA',
  status: 429,
}
const serverFailure = {
  message: 'provider request failed after metering',
  code: 'SERVER',
  status: 503,
}
const unknownFailure = {
  message: 'provider request failed before usage was observed',
  code: 'UNKNOWN',
}
const timeoutFailure = {
  message: 'DeepSeek stream idle timeout after 300000ms',
  code: 'TIMEOUT',
}
const tokenBudgetFailure = {
  message: 'DSH child activation token budget exhausted',
  code: 'DSH_ACTIVATION_TOKEN_BUDGET_EXHAUSTED',
}
const withSeq = events => events.map((event, index) => ({...event, seq: index}))
const completedEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      usage: {
        inputTokens: 11,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        outputTokens: 7,
      },
    },
  },
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'completed'}}},
])
const ledgerAllCallsEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {
    type: 'assistant/chunk',
    data: {
      turn: 1,
      step: 1,
      chunk: {type: 'usage', usage: {inputTokens: 7, outputTokens: 3}},
    },
  },
  {type: 'llm/retry-started', data: {turn: 1, step: 1, retryId: 'retry-ledger', retry: 1}},
  {
    type: 'assistant/chunk',
    data: {
      turn: 1,
      step: 1,
      chunk: {type: 'usage', usage: {inputTokens: 11, cacheReadTokens: 4, outputTokens: 5}},
    },
  },
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'completed'}}},
])
const tokenBudgetEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {
    type: 'assistant/chunk',
    data: {
      turn: 1,
      step: 1,
      chunk: {type: 'usage', usage: {inputTokens: 70, outputTokens: 20}},
    },
  },
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'step/start', data: {turn: 1, step: 2}},
  {
    type: 'assistant/chunk',
    data: {turn: 1, step: 2, chunk: {type: 'finish', reason: {kind: 'error', failure: tokenBudgetFailure}}},
  },
  {type: 'step/end', data: {turn: 1, step: 2}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'error', error: tokenBudgetFailure}}},
])
const ledgerMissingUsageEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {
    type: 'assistant/chunk',
    data: {turn: 1, step: 1, chunk: {type: 'finish', reason: {kind: 'stop'}}},
  },
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'completed'}}},
])
const retryAfterUnmeteredTimeoutEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {
    type: 'assistant/chunk',
    data: {turn: 1, step: 1, chunk: {
      type: 'finish', reason: {kind: 'error', failure: timeoutFailure},
    }},
  },
  {type: 'llm/retry', data: {turn: 1, step: 1, retryId: 'retry-timeout', retry: 1}},
  {type: 'llm/retry-started', data: {turn: 1, step: 1, retryId: 'retry-timeout', retry: 1}},
  {
    type: 'assistant/chunk',
    data: {turn: 1, step: 1, chunk: {type: 'usage', usage: {
      inputTokens: 11, cacheReadTokens: 3, cacheWriteTokens: 2, outputTokens: 7,
    }}},
  },
  {
    type: 'assistant/chunk',
    data: {turn: 1, step: 1, chunk: {type: 'finish', reason: {kind: 'stop'}}},
  },
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'completed'}}},
])
const guardedToolEvents = ({toolName, callId, isError = true, includeResult = true}) => withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      usage: {
        inputTokens: 11,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        outputTokens: 7,
      },
      message: {
        id: `assistant-${callId}`,
        role: 'assistant',
        content: [{type: 'tool-call', id: callId, name: toolName, arguments: '{}'}],
        source: {kind: 'model', provider: 'deepseek-official', model: 'kimi-k2.7-code'},
      },
    },
  },
  {type: 'tool/call', data: {turn: 1, step: 1, callId, name: toolName, arguments: '{}'}},
  ...(includeResult ? [{
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {
        source: {kind: 'tool', callId},
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          content: [{type: 'text', text: isError ? 'Error: denied by test guard' : 'ordinary tool result'}],
          isError,
        }],
      },
    },
  }] : []),
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'completed'}}},
])
const deniedMutationEvents = guardedToolEvents({toolName: 'write', callId: 'denied-write-1'})
const deniedMutationMissingResultEvents = guardedToolEvents({
  toolName: 'write',
  callId: 'denied-write-missing-result',
  includeResult: false,
})
const deniedMutationNonerrorResultEvents = guardedToolEvents({
  toolName: 'write',
  callId: 'denied-write-nonerror-result',
  isError: false,
})
const deniedMutationUsageIncompleteEvents = withSeq(deniedMutationEvents.filter(
  event => event.type !== 'step/end',
))
const deniedMutationUnmeteredRetryEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {type: 'assistant/chunk', data: {turn: 1, step: 1, chunk: {
    type: 'finish', reason: {kind: 'error', failure: timeoutFailure},
  }}},
  {type: 'llm/retry', data: {turn: 1, step: 1, retryId: 'denied-retry', retry: 1}},
  {type: 'llm/retry-started', data: {turn: 1, step: 1, retryId: 'denied-retry', retry: 1}},
  {type: 'assistant/chunk', data: {turn: 1, step: 1, chunk: {type: 'usage', usage: {
    inputTokens: 11, cacheReadTokens: 3, cacheWriteTokens: 2, outputTokens: 7,
  }}}},
  {type: 'assistant/chunk', data: {turn: 1, step: 1, chunk: {type: 'finish', reason: {kind: 'stop'}}}},
  {type: 'assistant/message', data: {
    turn: 1,
    step: 1,
    usage: {inputTokens: 11, cacheReadTokens: 3, cacheWriteTokens: 2, outputTokens: 7},
    message: {
      id: 'assistant-denied-unmetered',
      role: 'assistant',
      content: [{type: 'tool-call', id: 'denied-write-unmetered', name: 'write', arguments: '{}'}],
      source: {kind: 'model', provider: 'deepseek-official', model: 'kimi-k2.7-code'},
    },
  }},
  {type: 'tool/call', data: {turn: 1, step: 1, callId: 'denied-write-unmetered', name: 'write', arguments: '{}'}},
  {type: 'tool/result', data: {turn: 1, step: 1, message: {
    source: {kind: 'tool', callId: 'denied-write-unmetered'},
    role: 'user',
    content: [{type: 'tool-result', toolCallId: 'denied-write-unmetered', content: [
      {type: 'text', text: 'Error: denied by test guard'},
    ], isError: true}],
  }}},
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'completed'}}},
])
const deniedReadEvents = guardedToolEvents({toolName: 'read', callId: 'denied-read-1'})
const deniedGlobEvents = guardedToolEvents({toolName: 'glob', callId: 'denied-glob-1'})
const allowedEditErrorEvents = guardedToolEvents({toolName: 'edit', callId: 'allowed-edit-error-1'})
const quotaLifecycle = failure => withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {
    type: 'assistant/chunk',
    data: {turn: 1, step: 1, chunk: {type: 'finish', reason: {kind: 'error', failure}}},
  },
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'error', error: failure}}},
])
const quotaEvents = quotaLifecycle(quotaFailure)
const quotaCodeVariantEvents = new Map([
  ['quota-code-leading-space', quotaLifecycle({...quotaFailure, code: ' QUOTA '})],
  ['quota-code-trailing-newline', quotaLifecycle({...quotaFailure, code: 'QUOTA\n'})],
  ['quota-code-lowercase', quotaLifecycle({...quotaFailure, code: 'quota'})],
])
const quotaAfterContentEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {
    type: 'assistant/chunk',
    data: {turn: 1, step: 1, chunk: {type: 'text-delta', text: 'partial output'}},
  },
  {
    type: 'assistant/chunk',
    data: {turn: 1, step: 1, chunk: {type: 'finish', reason: {kind: 'error', failure: quotaFailure}}},
  },
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'error', error: quotaFailure}}},
])
const usageChunkFailureEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {
    type: 'assistant/chunk',
    data: {
      turn: 1,
      step: 1,
      chunk: {type: 'usage', usage: {inputTokens: 9, outputTokens: 1}},
    },
  },
  {
    type: 'assistant/chunk',
    data: {turn: 1, step: 1, chunk: {type: 'finish', reason: {kind: 'error', failure: serverFailure}}},
  },
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'error', error: serverFailure}}},
])
const unknownFailureEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {
    type: 'assistant/chunk',
    data: {turn: 1, step: 1, chunk: {type: 'finish', reason: {kind: 'error', failure: unknownFailure}}},
  },
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'error', error: unknownFailure}}},
])
const multiStepFailureEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {
    type: 'assistant/chunk',
    data: {
      turn: 1,
      step: 1,
      chunk: {type: 'usage', usage: {inputTokens: 4, outputTokens: 1}},
    },
  },
  {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      usage: {inputTokens: 6, cacheReadTokens: 2, outputTokens: 2},
    },
  },
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'step/start', data: {turn: 1, step: 2}},
  {
    type: 'assistant/chunk',
    data: {
      turn: 1,
      step: 2,
      chunk: {type: 'usage', usage: {inputTokens: 3, outputTokens: 4}},
    },
  },
  {
    type: 'assistant/chunk',
    data: {turn: 1, step: 2, chunk: {type: 'finish', reason: {kind: 'error', failure: serverFailure}}},
  },
  {type: 'step/end', data: {turn: 1, step: 2}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'error', error: serverFailure}}},
])
const terminalStepPriorAssistantOutput = [
  {type: 'reasoning', text: 'Inspect the final artifact before reporting completion.'},
  {type: 'text', text: 'I will read the final artifact once more.'},
  {type: 'tool-call', id: 'read-2', name: 'read', arguments: '{"file_path":"dag_engine.py"}'},
]
const terminalStepQuotaAfterMeteredProgressEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {
    type: 'assistant/chunk',
    data: {
      turn: 1,
      step: 1,
      chunk: {
        type: 'usage',
        usage: {inputTokens: 10, cacheReadTokens: 2, outputTokens: 1},
      },
    },
  },
  {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: 'assistant-step-1',
        role: 'assistant',
        content: [{
          type: 'tool-call',
          id: 'read-1',
          name: 'read',
          arguments: '{"file_path":"README.md"}',
        }],
        source: {
          kind: 'model',
          provider: 'deepseek-official',
          model: 'kimi-k2.7-code',
        },
      },
    },
  },
  {type: 'tool/call', data: {turn: 1, step: 1, callId: 'read-1', name: 'read'}},
  {type: 'tool/result', data: {turn: 1, step: 1, callId: 'read-1'}},
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'step/start', data: {turn: 1, step: 2}},
  {
    type: 'assistant/chunk',
    data: {
      turn: 1,
      step: 2,
      chunk: {
        type: 'usage',
        usage: {inputTokens: 20, cacheWriteTokens: 3, outputTokens: 2},
      },
    },
  },
  {type: 'tool/call', data: {turn: 1, step: 2, callId: 'write-1', name: 'write'}},
  {type: 'tool/result', data: {turn: 1, step: 2, callId: 'write-1'}},
  {type: 'step/end', data: {turn: 1, step: 2}},
  {type: 'step/start', data: {turn: 1, step: 3}},
  {
    type: 'assistant/chunk',
    data: {
      turn: 1,
      step: 3,
      chunk: {
        type: 'usage',
        usage: {
          inputTokens: 30,
          cacheReadTokens: 4,
          cacheWriteTokens: 1,
          outputTokens: 3,
        },
      },
    },
  },
  {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 3,
      message: {
        id: 'assistant-step-3',
        role: 'assistant',
        content: terminalStepPriorAssistantOutput,
        source: {
          kind: 'model',
          provider: 'deepseek-official',
          model: 'kimi-k2.7-code',
        },
      },
    },
  },
  {type: 'tool/call', data: {turn: 1, step: 3, callId: 'read-2', name: 'read'}},
  {type: 'tool/result', data: {turn: 1, step: 3, callId: 'read-2'}},
  {type: 'step/end', data: {turn: 1, step: 3}},
  {type: 'step/start', data: {turn: 1, step: 4}},
  {
    type: 'assistant/chunk',
    data: {
      turn: 1,
      step: 4,
      chunk: {type: 'finish', reason: {kind: 'error', failure: quotaFailure}},
    },
  },
  {type: 'step/end', data: {turn: 1, step: 4}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'error', error: quotaFailure}}},
])
const terminalStepQuotaFailureVariant = failure => withSeq(
  terminalStepQuotaAfterMeteredProgressEvents.map(event => {
    if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'finish') {
      return {
        ...event,
        data: {
          ...event.data,
          chunk: {
            ...event.data.chunk,
            reason: {kind: 'error', failure},
          },
        },
      }
    }
    if (event.type === 'turn/end') {
      return {...event, data: {...event.data, reason: {kind: 'error', error: failure}}}
    }
    return event
  }),
)
const terminalStepQuotaFailureVariants = new Map([
  [
    'terminal-step-quota-code-lowercase',
    terminalStepQuotaFailureVariant({...quotaFailure, code: 'quota'}),
  ],
  [
    'terminal-step-quota-status-drift',
    terminalStepQuotaFailureVariant({...quotaFailure, status: 430}),
  ],
])
const terminalQuotaStepStartIndex = terminalStepQuotaAfterMeteredProgressEvents.findIndex(
  event => event.type === 'step/start' && event.data?.step === 4,
)
const terminalStepQuotaLifecycleVariants = new Map([
  [
    'terminal-step-quota-missing-step-end',
    withSeq(terminalStepQuotaAfterMeteredProgressEvents.filter(
      event => !(event.type === 'step/end' && event.data?.step === 4),
    )),
  ],
  [
    'terminal-step-quota-duplicate-step-start',
    withSeq([
      ...terminalStepQuotaAfterMeteredProgressEvents.slice(0, terminalQuotaStepStartIndex + 1),
      terminalStepQuotaAfterMeteredProgressEvents[terminalQuotaStepStartIndex],
      ...terminalStepQuotaAfterMeteredProgressEvents.slice(terminalQuotaStepStartIndex + 1),
    ]),
  ],
  [
    'terminal-step-quota-drifted-step-end',
    withSeq(terminalStepQuotaAfterMeteredProgressEvents.map(event => (
      event.type === 'step/end' && event.data?.step === 4
        ? {...event, data: {...event.data, step: 5}}
        : event
    ))),
  ],
])
const terminalQuotaFinishIndex = terminalStepQuotaAfterMeteredProgressEvents.findIndex(
  event => event.type === 'assistant/chunk'
    && event.data?.step === 4
    && event.data?.chunk?.type === 'finish',
)
const withTerminalStepEvents = additions => withSeq([
  ...terminalStepQuotaAfterMeteredProgressEvents.slice(0, terminalQuotaFinishIndex),
  ...additions,
  ...terminalStepQuotaAfterMeteredProgressEvents.slice(terminalQuotaFinishIndex),
])
const terminalStepQuotaOutputEvents = withTerminalStepEvents([{
  type: 'assistant/chunk',
  data: {turn: 1, step: 4, chunk: {type: 'text-delta', text: 'partial output'}},
}])
const terminalStepQuotaToolEvents = withTerminalStepEvents([
  {type: 'tool/call', data: {turn: 1, step: 4, callId: 'read-after-quota', name: 'read'}},
  {type: 'tool/result', data: {turn: 1, step: 4, callId: 'read-after-quota'}},
])
const terminalStepQuotaRetryEvents = withTerminalStepEvents([{
  type: 'llm/retry-started',
  data: {turn: 1, step: 4, retryId: 'retry-terminal', retry: 1},
}])
const terminalStepQuotaTurnRetryEvents = withSeq(
  terminalStepQuotaAfterMeteredProgressEvents.map(event => (
    event.type === 'turn/start'
      ? {...event, data: {...event.data, trigger: {kind: 'retry'}}}
      : event
  )),
)
const priorStepToolIndex = terminalStepQuotaAfterMeteredProgressEvents.findIndex(
  event => event.type === 'tool/call' && event.data?.step === 2,
)
const terminalStepQuotaPriorRetryEvents = withSeq([
  ...terminalStepQuotaAfterMeteredProgressEvents.slice(0, priorStepToolIndex),
  {
    type: 'llm/retry-started',
    data: {turn: 1, step: 2, retryId: 'retry-prior', retry: 1},
  },
  ...terminalStepQuotaAfterMeteredProgressEvents.slice(priorStepToolIndex),
])
const terminalStepQuotaMismatchedFailureEvents = withSeq(
  terminalStepQuotaAfterMeteredProgressEvents.map(event => (
    event.type === 'assistant/chunk' && event.data?.chunk?.type === 'finish'
      ? {
          ...event,
          data: {
            ...event.data,
            chunk: {
              ...event.data.chunk,
              reason: {
                kind: 'error',
                failure: {...quotaFailure, requestId: 'finish-only'},
              },
            },
          },
        }
      : event
  )),
)
const terminalStepQuotaUsageEvents = withTerminalStepEvents([{
  type: 'assistant/chunk',
  data: {
    turn: 1,
    step: 4,
    chunk: {type: 'usage', usage: {inputTokens: 7, outputTokens: 1}},
  },
}])
const terminalStepQuotaPriorUsageMissingEvents = withSeq(
  terminalStepQuotaAfterMeteredProgressEvents.filter(event => !(
    event.type === 'assistant/chunk'
    && event.data?.step === 2
    && event.data?.chunk?.type === 'usage'
  )),
)
const terminalStepQuotaZeroMeteredEvents = withSeq(
  terminalStepQuotaAfterMeteredProgressEvents.map(event => (
    event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage'
      ? {
          ...event,
          data: {
            ...event.data,
            chunk: {
              ...event.data.chunk,
              usage: {inputTokens: 0, outputTokens: 0},
            },
          },
        }
      : event
  )),
)
const terminalStepQuotaWithoutPriorAssistantEvents = withSeq(
  terminalStepQuotaAfterMeteredProgressEvents.filter(
    event => event.type !== 'assistant/message',
  ),
)
const quotaDuplicateTurnStartEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'turn/start', data: {turn: 1, trigger: {kind: 'retry'}}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {
    type: 'assistant/chunk',
    data: {turn: 1, step: 1, chunk: {type: 'finish', reason: {kind: 'error', failure: quotaFailure}}},
  },
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'error', error: quotaFailure}}},
])
const quotaDuplicateStepStartEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {
    type: 'assistant/chunk',
    data: {turn: 1, step: 1, chunk: {type: 'finish', reason: {kind: 'error', failure: quotaFailure}}},
  },
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'error', error: quotaFailure}}},
])
const quotaDuplicateTurnEndEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {
    type: 'assistant/chunk',
    data: {turn: 1, step: 1, chunk: {type: 'finish', reason: {kind: 'error', failure: quotaFailure}}},
  },
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'error', error: quotaFailure}}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'error', error: quotaFailure}}},
])
const quotaMissingStepEndEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {
    type: 'assistant/chunk',
    data: {turn: 1, step: 1, chunk: {type: 'finish', reason: {kind: 'error', failure: quotaFailure}}},
  },
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'error', error: quotaFailure}}},
])
const quotaTerminalBeforeFinishEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'error', error: quotaFailure}}},
  {
    type: 'assistant/chunk',
    data: {turn: 1, step: 1, chunk: {type: 'finish', reason: {kind: 'error', failure: quotaFailure}}},
  },
])
const quotaOtherCoordinateContentEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {
    type: 'assistant/chunk',
    data: {turn: 9, step: 9, chunk: {type: 'text-delta', text: 'ambiguous content'}},
  },
  {
    type: 'assistant/chunk',
    data: {turn: 1, step: 1, chunk: {type: 'finish', reason: {kind: 'error', failure: quotaFailure}}},
  },
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'error', error: quotaFailure}}},
])
const quotaMismatchedFailureEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {
    type: 'assistant/chunk',
    data: {
      turn: 1,
      step: 1,
      chunk: {
        type: 'finish',
        reason: {kind: 'error', failure: {...quotaFailure, requestId: 'finish-request'}},
      },
    },
  },
  {type: 'step/end', data: {turn: 1, step: 1}},
  {
    type: 'turn/end',
    data: {
      turn: 1,
      reason: {kind: 'error', error: {...quotaFailure, requestId: 'terminal-request'}},
    },
  },
])
const quotaRetryMarkerEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {type: 'llm/retry-started', data: {turn: 1, step: 1, retryId: 'retry-1', retry: 1}},
  {
    type: 'assistant/chunk',
    data: {turn: 1, step: 1, chunk: {type: 'finish', reason: {kind: 'error', failure: quotaFailure}}},
  },
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'error', error: quotaFailure}}},
])
const quotaNonFreshCoordinatesEvents = withSeq([
  {type: 'turn/start', data: {turn: 9}},
  {type: 'step/start', data: {turn: 9, step: 9}},
  {
    type: 'assistant/chunk',
    data: {turn: 9, step: 9, chunk: {type: 'finish', reason: {kind: 'error', failure: quotaFailure}}},
  },
  {type: 'step/end', data: {turn: 9, step: 9}},
  {type: 'turn/end', data: {turn: 9, reason: {kind: 'error', error: quotaFailure}}},
])
const quotaToolResultEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {
    type: 'tool/result',
    data: {
      turn: 1,
      step: 1,
      message: {role: 'tool', toolCallId: 'call-1', content: [{type: 'text', text: 'content'}]},
    },
  },
  {
    type: 'assistant/chunk',
    data: {turn: 1, step: 1, chunk: {type: 'finish', reason: {kind: 'error', failure: quotaFailure}}},
  },
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'error', error: quotaFailure}}},
])
const quotaPostTerminalExecutionEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {
    type: 'assistant/chunk',
    data: {turn: 1, step: 1, chunk: {type: 'finish', reason: {kind: 'error', failure: quotaFailure}}},
  },
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'error', error: quotaFailure}}},
  {type: 'request/context', data: {turn: 1, step: 1}},
])
const usageMissingStepEndEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {
    type: 'assistant/chunk',
    data: {
      turn: 1,
      step: 1,
      chunk: {type: 'usage', usage: {inputTokens: 9, outputTokens: 1}},
    },
  },
  {
    type: 'assistant/chunk',
    data: {turn: 1, step: 1, chunk: {type: 'finish', reason: {kind: 'error', failure: serverFailure}}},
  },
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'error', error: serverFailure}}},
])
const duplicateStepUsageEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {
    type: 'assistant/chunk',
    data: {
      turn: 1,
      step: 1,
      chunk: {type: 'usage', usage: {inputTokens: 100, outputTokens: 0}},
    },
  },
  {type: 'step/start', data: {turn: 1, step: 1}},
  {
    type: 'assistant/chunk',
    data: {
      turn: 1,
      step: 1,
      chunk: {type: 'usage', usage: {inputTokens: 1, outputTokens: 0}},
    },
  },
  {
    type: 'assistant/chunk',
    data: {turn: 1, step: 1, chunk: {type: 'finish', reason: {kind: 'error', failure: serverFailure}}},
  },
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'error', error: serverFailure}}},
])
// Public replay of the existing child 2aac0987-e73d-4033-b19c-fde5fe240623,
// retaining its event types, coordinates, ordering, and contiguous seq values.
const exportedQuotaEvents = withSeq([
  {type: 'sandbox/mode', data: {mode: 'workspace-write', source: 'delegation'}},
  {type: 'approval/policy', data: {policy: 'never', source: 'delegation'}},
  {type: 'agent/inbox/spliced', data: {}},
  {type: 'turn/start', data: {turn: 1}},
  {type: 'agent/inbox/spliced', data: {}},
  {type: 'subagent/descriptor', data: {}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {type: 'user/message', data: {}},
  {type: 'user/message', data: {}},
  {type: 'user/message', data: {}},
  {type: 'session/title', data: {}},
  {type: 'request/header', data: {}},
  {type: 'request/context', data: {}},
  {
    type: 'assistant/chunk',
    data: {turn: 1, step: 1, chunk: {type: 'finish', reason: {kind: 'error', failure: quotaFailure}}},
  },
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'error', error: quotaFailure}}},
])
const blockedEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'blocked'}}},
])
const abortedEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'aborted', reason: {kind: 'user'}}}},
])
const interruptedEvents = withSeq([
  {type: 'turn/start', data: {turn: 1}},
  {type: 'step/start', data: {turn: 1, step: 1}},
  {type: 'step/end', data: {turn: 1, step: 1}},
  {type: 'turn/end', data: {turn: 1, reason: {kind: 'interrupted'}}},
])
const malformedSeqEvents = completedEvents.map((event, index) => (
  index === 2 ? {...event, seq: 'not-an-integer'} : event
))
const nonmonotonicSeqEvents = completedEvents.map((event, index) => (
  index === 1 ? {...event, seq: 12} : index === 2 ? {...event, seq: 11} : event
))
const duplicateSeqEvents = completedEvents.map((event, index) => (
  index === 3 ? {...event, seq: completedEvents[2].seq} : event
))
const gapSeqEvents = completedEvents.map((event, index) => (
  index < 2 ? event : {...event, seq: event.seq + 1}
))
const eventsByMode = new Map([
  ['ledger-all-calls', ledgerAllCallsEvents],
  ['token-budget', tokenBudgetEvents],
  ['ledger-missing-usage', ledgerMissingUsageEvents],
  ['retry-after-unmetered-timeout', retryAfterUnmeteredTimeoutEvents],
  ['denied-mutation', deniedMutationEvents],
  ['denied-mutation-missing-result', deniedMutationMissingResultEvents],
  ['denied-mutation-nonerror-result', deniedMutationNonerrorResultEvents],
  ['denied-mutation-usage-incomplete', deniedMutationUsageIncompleteEvents],
  ['denied-mutation-unmetered-retry', deniedMutationUnmeteredRetryEvents],
  ['denied-read', deniedReadEvents],
  ['denied-glob', deniedGlobEvents],
  ['allowed-edit-error', allowedEditErrorEvents],
  ['quota', quotaEvents],
  ...quotaCodeVariantEvents,
  ['quota-after-content', quotaAfterContentEvents],
  ['quota-duplicate-turn-start', quotaDuplicateTurnStartEvents],
  ['quota-duplicate-step-start', quotaDuplicateStepStartEvents],
  ['quota-duplicate-turn-end', quotaDuplicateTurnEndEvents],
  ['quota-missing-step-end', quotaMissingStepEndEvents],
  ['quota-terminal-before-finish', quotaTerminalBeforeFinishEvents],
  ['quota-other-coordinate-content', quotaOtherCoordinateContentEvents],
  ['quota-mismatched-failure', quotaMismatchedFailureEvents],
  ['quota-retry-marker', quotaRetryMarkerEvents],
  ['quota-nonfresh-coordinates', quotaNonFreshCoordinatesEvents],
  ['quota-tool-result', quotaToolResultEvents],
  ['quota-post-terminal-execution', quotaPostTerminalExecutionEvents],
  ['quota-exported-replay', exportedQuotaEvents],
  ['usage-chunk-failure', usageChunkFailureEvents],
  ['unknown-failure', unknownFailureEvents],
  ['multi-step-failure', multiStepFailureEvents],
  ['terminal-step-quota-after-metered-progress', terminalStepQuotaAfterMeteredProgressEvents],
  ...terminalStepQuotaFailureVariants,
  ...terminalStepQuotaLifecycleVariants,
  ['terminal-step-quota-after-output', terminalStepQuotaOutputEvents],
  ['terminal-step-quota-with-mismatched-result-output', terminalStepQuotaAfterMeteredProgressEvents],
  ['terminal-step-quota-after-tool', terminalStepQuotaToolEvents],
  ['terminal-step-quota-after-retry', terminalStepQuotaRetryEvents],
  ['terminal-step-quota-retry-turn', terminalStepQuotaTurnRetryEvents],
  ['terminal-step-quota-prior-retry', terminalStepQuotaPriorRetryEvents],
  ['terminal-step-quota-mismatched-failure', terminalStepQuotaMismatchedFailureEvents],
  ['terminal-step-quota-after-usage', terminalStepQuotaUsageEvents],
  ['terminal-step-quota-prior-usage-missing', terminalStepQuotaPriorUsageMissingEvents],
  ['terminal-step-quota-zero-metered-progress', terminalStepQuotaZeroMeteredEvents],
  ['terminal-step-quota-without-prior-assistant', terminalStepQuotaWithoutPriorAssistantEvents],
  ['usage-missing-step-end', usageMissingStepEndEvents],
  ['duplicate-step-usage', duplicateStepUsageEvents],
  ['blocked', blockedEvents],
  ['aborted', abortedEvents],
  ['interrupted', interruptedEvents],
  ['malformed-seq', malformedSeqEvents],
  ['nonmonotonic-seq', nonmonotonicSeqEvents],
  ['duplicate-seq', duplicateSeqEvents],
  ['gap-seq', gapSeqEvents],
])
const childEvents = eventsByMode.get(request.child_mode) ?? completedEvents

function usageCallsFromEvents(events) {
  const byStep = new Map()
  const retrySteps = new Set()
  for (const event of events) {
    const data = event?.data
    const key = Number.isSafeInteger(data?.turn) && Number.isSafeInteger(data?.step)
      ? `${data.turn}/${data.step}`
      : null
    if (key === null) continue
    if (event.type === 'llm/retry-started') retrySteps.add(key)
    if (event.type === 'assistant/chunk' && data.chunk?.type === 'usage') {
      const current = byStep.get(key) ?? {chunks: [], message: null}
      current.chunks.push(data.chunk.usage)
      byStep.set(key, current)
    }
    if (event.type === 'assistant/message' && data.usage !== undefined) {
      const current = byStep.get(key) ?? {chunks: [], message: null}
      current.message = data.usage
      byStep.set(key, current)
    }
    if (event.type === 'assistant/chunk' && data.chunk?.type === 'finish') {
      const current = byStep.get(key) ?? {chunks: [], message: null}
      current.finish = data.chunk
      byStep.set(key, current)
    }
  }
  const calls = []
  for (const [key, samples] of byStep) {
    const usages = retrySteps.has(key)
      ? samples.chunks
      : [samples.message ?? samples.chunks.at(-1)].filter(value => value !== undefined)
    for (const [index, usage] of usages.entries()) {
      calls.push({
        session_id: 'child',
        chunks: [
          {type: 'usage', usage},
          index === usages.length - 1 && samples.finish !== undefined
            ? samples.finish
            : {type: 'finish', reason: {kind: 'stop'}},
        ],
      })
    }
    if (usages.length === 0 && samples.finish !== undefined) {
      calls.push({session_id: 'child', chunks: [samples.finish]})
    }
  }
  return calls
}

async function collectLlmStream(options, chunks) {
  const preparedListeners = listeners.get('llm/prepared-stream') ?? []
  const contextWindow = request.context_windows?.[contextWindowIndex++]
    ?? request.context_window
  const call = Object.freeze({
    registration: Object.freeze({
      provider: Object.freeze({id: options.provider, name: options.provider}),
      retryPolicy: Object.freeze({maxRetries: 0}),
    }),
    config: Object.freeze({provider: options.provider, model: options.model}),
    ...(contextWindow === null ? {} : {
      context: Object.freeze({contextWindow: contextWindow ?? 100}),
    }),
    options: Object.freeze(options),
  })
  const dispatchPrepared = index => {
    if (index >= preparedListeners.length) {
      telemetry.provider_calls += 1
      return (async function* () {
        for (const chunk of chunks) yield chunk
      })()
    }
    return preparedListeners[index](call, () => dispatchPrepared(index + 1))
  }
  const streamListeners = listeners.get('llm/stream') ?? []
  const dispatchOuter = index => {
    if (index >= streamListeners.length) return dispatchPrepared(0)
    return streamListeners[index](options, () => dispatchOuter(index + 1))
  }
  const observed = []
  for await (const chunk of dispatchOuter(0)) observed.push(chunk)
  telemetry.streamed_calls.push({options, chunks: observed})
  return observed
}

const child = {
  id: 'dsh-child-route-probe',
  options: {provider: plugin.DSH_PROVIDER, model: plugin.DSH_MODEL},
  session: {
    header: {parentSession: 'dsh-parent-route-probe'},
    events: childEvents,
  },
  ctx: {
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => undefined
    },
    tools: {
      get(name) {
        if (!['glob', 'grep', 'edit', 'write', 'subagent'].includes(name)) return undefined
        return {
          name,
          description: `${name} base description`,
          parameters: {},
          async execute(args) {
            if (name === 'subagent') telemetry.forwarded_adviser_args = args
            return {}
          },
        }
      },
      register(definition) {
        telemetry.scoped_tool_descriptions[definition.name] = definition.description
        if (definition.name === 'subagent') scopedSubagentDefinition = definition
        return () => undefined
      },
      guard(value) {
        telemetry.guard_registered = true
        telemetry.guard = value
        return () => { telemetry.guard_disposed = true }
      },
      restrict(value) {
        telemetry.primary_restriction = value
        return () => undefined
      },
    },
  },
  cancel() { telemetry.cancel_count = (telemetry.cancel_count ?? 0) + 1 },
}
const callingAgent = {
  id: 'dsh-parent-route-probe',
  session: {
    header: {cwd: request.cwd, origin: 'user'},
    events: [{type: 'tool/call', data: {turn: 1, step: 1, callId: 'call-dsh-evolve', name: 'kersor_evolve'}}],
  },
}
const ctx = {
  commands: {
    register(command) {
      registeredCommand = command
      return () => undefined
    },
  },
  tools: {
    register(tool) {
      registeredTool = tool
      return () => undefined
    },
    guard(value) {
      topLevelGuards.push(value)
      return () => undefined
    },
  },
  on(name, listener) {
    const current = listeners.get(name) ?? []
    current.push(listener)
    listeners.set(name, current)
    return () => undefined
  },
  llm: {
    preparedStreamVersion: request.prepared_stream_version ?? 1,
  },
  subagents: {
    async start(provider, value) {
      telemetry.starts.push({
        provider,
        label: value.label,
        parent_is_caller: value.parent === callingAgent,
        agent_options: value.agentOptions,
        tool_filter: value.toolFilter,
        output_schema: value.outputSchema,
        prompt: value.prompt,
      })
      if (request.swap_workspace_to !== undefined) {
        fs.unlinkSync(request.cwd)
        fs.symlinkSync(request.swap_workspace_to, request.cwd, 'dir')
      }
      for (const listener of listeners.get('agent/created') ?? []) listener({agent: child})
      if (typeof telemetry.guard !== 'function') throw new Error('child guard was not installed during agent/created')
      const primaryGuard = telemetry.guard
      const nativeAdvisers = request.native_advisers ?? 0
      if (nativeAdvisers > 0) {
        const adviserDefinition = scopedSubagentDefinition ?? child.ctx.tools.get('subagent')
        telemetry.scoped_adviser_parameters = Object.keys(adviserDefinition.parameters)
        await adviserDefinition.execute(
          {description: 'probe adviser', prompt: 'probe'},
          {agent: child, signal: value.signal},
        )
      }
      for (let index = 0; index < nativeAdvisers; index += 1) {
        const callId = `native-adviser-${index + 1}`
        const denial = primaryGuard({
          name: 'subagent',
          callId,
          arguments: {},
          agent: child,
        })
        if (denial !== undefined) throw new Error(denial)
        const adviserEvents = completedEvents.map(event => ({...event, data: {...event.data}}))
        const adviser = {
          id: `dsh-adviser-${index + 1}`,
          options: {provider: plugin.DSH_PROVIDER, model: plugin.DSH_MODEL},
          session: {
            header: {parentSession: child.id},
            events: adviserEvents,
          },
          ctx: {
            effect(callback) {
              const dispose = callback()
              return typeof dispose === 'function' ? dispose : () => undefined
            },
            tools: {
              get(name) {
                if (!['read', 'glob', 'grep'].includes(name)) return undefined
                return {name, description: `${name} adviser description`, parameters: {}, async execute() { return {} }}
              },
              register(definition) {
                telemetry.scoped_tool_descriptions[`${adviser.id}:${definition.name}`] = definition.description
                return () => undefined
              },
              guard(value) {
                adviser.guard = value
                return () => undefined
              },
              restrict(value) {
                adviser.restriction = value
                return () => undefined
              },
            },
          },
        }
        for (const listener of listeners.get('agent/created') ?? []) listener({agent: adviser})
        telemetry.advisers ??= []
        telemetry.advisers.push({
          id: adviser.id,
          restriction: adviser.restriction,
        })
        for (const call of usageCallsFromEvents(adviserEvents)) {
          await collectLlmStream({
            provider: plugin.DSH_PROVIDER,
            model: plugin.DSH_MODEL,
            sessionId: adviser.id,
            messages: [],
            signal: value.signal,
          }, call.chunks)
        }
      }
      const llmCalls = request.llm_calls ?? (
        request.child_mode === 'wait' ? [] : usageCallsFromEvents(childEvents)
      )
      for (const call of llmCalls) {
        await collectLlmStream({
          provider: call.provider ?? plugin.DSH_PROVIDER,
          model: call.model ?? plugin.DSH_MODEL,
          sessionId: call.session_id === 'other' ? 'unrelated-session' : child.id,
          ...(call.purpose === undefined ? {} : {purpose: call.purpose}),
          messages: [],
          signal: value.signal,
        }, call.chunks)
      }
      if (request.trailing_title_event === true) {
        child.session.events.push({
          type: 'session/title',
          seq: child.session.events.length,
          data: {title: 'Late title', messageSeqs: [], source: {kind: 'fallback'}},
        })
      }
      const actualGuardExecutions = {
        'denied-mutation': {
          name: 'write',
          callId: 'denied-write-1',
          arguments: {file_path: request.undeclared_artifact},
        },
        'denied-mutation-missing-result': {
          name: 'write',
          callId: 'denied-write-missing-result',
          arguments: {file_path: request.undeclared_artifact},
        },
        'denied-mutation-nonerror-result': {
          name: 'write',
          callId: 'denied-write-nonerror-result',
          arguments: {file_path: request.undeclared_artifact},
        },
        'denied-mutation-usage-incomplete': {
          name: 'write',
          callId: 'denied-write-1',
          arguments: {file_path: request.undeclared_artifact},
        },
        'denied-mutation-unmetered-retry': {
          name: 'write',
          callId: 'denied-write-unmetered',
          arguments: {file_path: request.undeclared_artifact},
        },
        'denied-read': {
          name: 'read',
          callId: 'denied-read-1',
          arguments: {file_path: '.kersor/control.json'},
        },
        'denied-glob': {
          name: 'glob',
          callId: 'denied-glob-1',
          arguments: {pattern: '*'},
        },
        'allowed-edit-error': {
          name: 'edit',
          callId: 'allowed-edit-error-1',
          arguments: {file_path: request.transaction_artifact},
        },
      }
      const actualGuardExecution = actualGuardExecutions[request.child_mode]
      if (actualGuardExecution !== undefined) {
        if (request.child_mode === 'denied-mutation') {
          telemetry.no_call_id_guard_result = telemetry.guard({
            name: 'write',
            arguments: {file_path: request.undeclared_artifact},
            agent: child,
          }) ?? null
        }
        telemetry.actual_guard_result = telemetry.guard({...actualGuardExecution, agent: child}) ?? null
        if (request.child_mode === 'denied-mutation') {
          telemetry.second_guard_result = telemetry.guard({
            name: 'edit',
            callId: 'denied-edit-2',
            arguments: {file_path: request.undeclared_artifact},
            agent: child,
          }) ?? null
        }
      }
      const guardProbes = {
        read: {name: 'read', arguments: {file_path: request.args.contract}},
        glob: {name: 'glob', arguments: {pattern: '*.json'}},
        grep: {name: 'grep', arguments: {pattern: 'runtime'}},
        structured_output: {name: 'structured_output', arguments: {observed: true}},
        edit: {name: 'edit', arguments: request.transaction_artifact === undefined
          ? {}
          : {file_path: request.transaction_artifact}},
        write: {name: 'write', arguments: request.transaction_artifact === undefined
          ? {}
          : {file_path: request.transaction_artifact}},
        edit_undeclared: {name: 'edit', arguments: request.undeclared_artifact === undefined
          ? {}
          : {file_path: request.undeclared_artifact}},
        write_undeclared: {name: 'write', arguments: request.undeclared_artifact === undefined
          ? {}
          : {file_path: request.undeclared_artifact}},
        edit_alias: {name: 'edit', arguments: request.transaction_alias === undefined
          ? {}
          : {file_path: request.transaction_alias}},
        write_alias: {name: 'write', arguments: request.transaction_alias === undefined
          ? {}
          : {file_path: request.transaction_alias}},
        bash: {name: 'bash', arguments: {}},
        subagent: {name: 'subagent', arguments: {}},
        workflow: {name: 'workflow', arguments: {}},
        kersor_evolve: {name: 'kersor_evolve', arguments: {}},
        read_outside: {name: 'read', arguments: {file_path: request.outside_file}},
        glob_outside: {name: 'glob', arguments: {pattern: '*', path: request.outside_directory}},
        grep_symlink_escape: {name: 'grep', arguments: {pattern: 'secret', path: request.escape_symlink}},
        glob_parent_pattern: {name: 'glob', arguments: {pattern: '../*'}},
        read_control: {name: 'read', arguments: {file_path: '.kersor/control.json'}},
        read_document: {name: 'read', arguments: {file_path: request.agent_document}},
        glob_control: {name: 'glob', arguments: {pattern: '*', path: '.kersor'}},
        grep_control: {name: 'grep', arguments: {pattern: 'secret', path: '.kersor'}},
      }
      for (const [probe, execution] of Object.entries(guardProbes)) {
        if (Object.values(execution.arguments).includes(undefined)) continue
        telemetry.guards[probe] = telemetry.guard({...execution, agent: child}) ?? null
      }
      let result
      if (request.child_mode === 'wait') {
        result = new Promise(resolve => {
          const settle = () => {
            child.session.events.splice(0, child.session.events.length, ...withSeq([
              {type: 'turn/start', data: {turn: 1}},
              {type: 'step/start', data: {turn: 1, step: 1}},
              {
                type: 'assistant/chunk',
                data: {
                  turn: 1,
                  step: 1,
                  chunk: {type: 'finish', reason: {kind: 'aborted', failure: {
                    message: 'KerSor DSH activation timed out', code: 'ABORTED',
                  }}},
                },
              },
              {type: 'step/end', data: {turn: 1, step: 1}},
              {type: 'turn/end', data: {turn: 1, reason: {kind: 'aborted'}}},
            ]))
            telemetry.child_abort_count = (telemetry.child_abort_count ?? 0) + 1
            telemetry.child_abort_after_ms = Date.now() - driverStartedAt
            resolve({output: [], stopReason: 'aborted'})
          }
          if (value.signal.aborted) settle()
          else value.signal.addEventListener('abort', settle, {once: true})
        })
      } else if (request.child_mode === 'terminal-step-quota-without-prior-assistant') {
        result = Promise.resolve({output: [], stopReason: 'error'})
      } else if (request.child_mode === 'terminal-step-quota-with-mismatched-result-output') {
        result = Promise.resolve({
          output: [{type: 'text', text: 'partial output'}],
          stopReason: 'error',
        })
      } else if (
        typeof request.child_mode === 'string'
        && request.child_mode.startsWith('terminal-step-quota-')
        && eventsByMode.has(request.child_mode)
      ) {
        result = Promise.resolve({
          output: terminalStepPriorAssistantOutput,
          stopReason: 'error',
        })
      } else if ([
        'quota',
        'quota-code-leading-space',
        'quota-code-trailing-newline',
        'quota-code-lowercase',
        'quota-after-content',
        'quota-duplicate-turn-start',
        'quota-duplicate-step-start',
        'quota-duplicate-turn-end',
        'quota-missing-step-end',
        'quota-terminal-before-finish',
        'quota-other-coordinate-content',
        'quota-mismatched-failure',
        'quota-retry-marker',
        'quota-nonfresh-coordinates',
        'quota-tool-result',
        'quota-post-terminal-execution',
        'quota-exported-replay',
        'usage-chunk-failure',
        'unknown-failure',
        'multi-step-failure',
        'terminal-step-quota-after-metered-progress',
        'terminal-step-quota-code-lowercase',
        'terminal-step-quota-status-drift',
        'terminal-step-quota-missing-step-end',
        'terminal-step-quota-duplicate-step-start',
        'terminal-step-quota-drifted-step-end',
        'terminal-step-quota-after-output',
        'terminal-step-quota-after-tool',
        'terminal-step-quota-after-retry',
        'terminal-step-quota-retry-turn',
        'terminal-step-quota-prior-retry',
        'terminal-step-quota-mismatched-failure',
        'terminal-step-quota-after-usage',
        'terminal-step-quota-prior-usage-missing',
        'terminal-step-quota-zero-metered-progress',
        'usage-missing-step-end',
        'duplicate-step-usage',
        'token-budget',
        'interrupted',
      ].includes(request.child_mode)) {
        result = Promise.resolve({output: [], stopReason: 'error'})
      } else if (request.child_mode === 'blocked') {
        result = Promise.resolve({output: [], stopReason: 'refusal'})
      } else if (request.child_mode === 'aborted') {
        result = Promise.resolve({output: [], stopReason: 'aborted'})
      } else {
        result = Promise.resolve({
          output: [{type: 'text', text: 'DSH route probe completed'}],
          structured: {observed: true},
          stopReason: 'completed',
        })
      }
      return {
        id: child.id,
        localAgent: child,
        result,
        async dispose() { telemetry.dispose_count += 1 },
      }
    },
  },
}
try {
  plugin.apply(ctx)
} catch (error) {
  process.stdout.write(JSON.stringify({apply_error: String(error?.message ?? error), telemetry}))
  process.exit(0)
}
if (registeredTool === undefined) throw new Error('kersor_evolve tool was not registered')
if (registeredCommand === undefined) throw new Error('kersor-evolve command was not registered')
if (request.timeout_ms !== undefined) {
  registeredTool = plugin.createTool({ctx, timeoutMs: request.timeout_ms})
}
const controller = new AbortController()
if (request.abort_after_ms !== undefined) {
  setTimeout(() => controller.abort(new Error('test DSH cancellation')), request.abort_after_ms).unref()
}
const exec = {
  callId: 'call-dsh-evolve',
  agent: callingAgent,
  signal: controller.signal,
  concludeTurn() { telemetry.conclude_count = (telemetry.conclude_count ?? 0) + 1 },
}
let payload
if (request.invoke_command === true) {
  const commandId = 'command-test-evolve'
  callingAgent.session.events = [{
    type: 'command/run',
    data: {commandId, name: 'kersor-evolve', args: JSON.stringify(request.args), source: {kind: 'user'}},
  }]
  try {
    const result = await registeredCommand.handler({
      commandId,
      agent: callingAgent,
      rawInput: JSON.stringify(request.args),
      attachments: [],
      signal: controller.signal,
    })
    payload = {
      ok: true,
      command_result: result,
      command_engages_session: registeredCommand.engagesSession,
      session_events: callingAgent.session.events,
      telemetry,
    }
  } catch (error) {
    payload = {ok: false, error: String(error?.message ?? error), telemetry}
  }
} else {
try {
  const value = await registeredTool.execute(request.args, exec)
  if (request.late_same_session_probe === true) {
    telemetry.late_same_session_chunks = await collectLlmStream({
      provider: plugin.DSH_PROVIDER,
      model: plugin.DSH_MODEL,
      sessionId: child.id,
      messages: [],
      signal: new AbortController().signal,
    }, [
      {type: 'usage', usage: {inputTokens: 1, outputTokens: 1}},
      {type: 'finish', reason: {kind: 'stop'}},
    ])
  }
  if (request.guard_probe === true) {
    callingAgent.session.events.push({
      type: 'tool/call',
      data: {turn: 1, step: 1, callId: 'call-same-turn-bash', name: 'bash'},
    })
    telemetry.same_turn_denials = topLevelGuards
      .map(guard => guard({name: 'bash', callId: 'call-same-turn-bash', agent: callingAgent}))
      .filter(value => value !== undefined)
    callingAgent.session.events.push({
      type: 'tool/call',
      data: {turn: 1, step: 1, callId: 'call-same-turn-code', name: 'run_code'},
    })
    telemetry.same_turn_nested_denials = topLevelGuards
      .map(guard => guard({
        name: 'read',
        callId: 'call-same-turn-code:code:1',
        rootCallId: 'call-same-turn-code',
        agent: callingAgent,
      }))
      .filter(value => value !== undefined)
    callingAgent.session.events.push({type: 'turn/end', data: {turn: 1}})
    callingAgent.session.events.push({
      type: 'tool/call',
      data: {turn: 2, step: 1, callId: 'call-next-turn-code', name: 'run_code'},
    })
    telemetry.next_turn_denials = topLevelGuards
      .map(guard => guard({
        name: 'read',
        callId: 'call-next-turn-code:code:1',
        rootCallId: 'call-next-turn-code',
        agent: callingAgent,
      }))
      .filter(value => value !== undefined)
  }
  payload = {ok: true, value, telemetry}
} catch (error) {
  payload = {ok: false, error: String(error?.message ?? error), telemetry}
}
}
delete telemetry.guard
process.stdout.write(JSON.stringify(payload))
"""


@unittest.skipIf(NODE is None, "Node.js is required for local plugin tests")
class KerSorEvolvePluginTests(unittest.TestCase):
    """Exercise path custody, Host spawning, terminal handling, and cancellation."""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.preset = self.root / "installed-preset"
        (self.preset / "plugins").mkdir(parents=True)
        (self.preset / "bin").mkdir()
        (self.preset / ".local").mkdir()
        self.module = self.preset / "plugins" / "kersor-evolve.mjs"
        shutil.copy2(SOURCE, self.module)
        (self.preset / "bin" / "kersor_bridge.py").write_text(
            FAKE_BRIDGE, encoding="utf-8"
        )
        self.core = self.root / "trusted-kersor-core"
        self.core.mkdir()
        (self.preset / ".local" / "kersor-root").write_text(
            f"{self.core}\n", encoding="utf-8"
        )
        self.home = self.root / "trusted-home"
        self.temp_dir = self.root / "trusted-temp"
        self.home.mkdir()
        self.temp_dir.mkdir()
        (self.preset / ".local" / "runtime-tools.json").write_text(
            json.dumps({
                "schema_version": 1,
                "tools": {"python3": sys.executable},
                "environment": {
                    "home": str(self.home),
                    "temp_dir": str(self.temp_dir),
                },
            }),
            encoding="utf-8",
        )
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.outside_secret = self.home / "secret.txt"
        self.outside_secret.write_text("outside-secret-must-not-leak\n", encoding="utf-8")
        self.escape_symlink = self.workspace / "outside-link"
        self.escape_symlink.symlink_to(self.home, target_is_directory=True)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def invoke(
        self,
        args: dict[str, object],
        *,
        origin: str = "user",
        abort_after_ms: int | None = None,
        timeout_ms: int = 5_000,
        second_call: bool = False,
        historical_call: bool = False,
        historical_command: bool = False,
    ) -> tuple[dict[str, object], float]:
        request: dict[str, object] = {
            "module": str(self.module),
            "cwd": str(self.workspace),
            "origin": origin,
            "args": args,
            "timeout_ms": timeout_ms,
            "second_call": second_call,
            "historical_call": historical_call,
            "historical_command": historical_command,
        }
        if abort_after_ms is not None:
            request["abort_after_ms"] = abort_after_ms
        environment = dict(os.environ)
        environment["KERSOR_ROOT"] = str(self.workspace / "poisoned-root")
        environment["PYTHONPATH"] = str(self.workspace / "poisoned-python")
        environment["AWS_SECRET_ACCESS_KEY"] = "ambient-aws-secret"
        environment["GITHUB_TOKEN"] = "ambient-github-secret"
        environment["SSH_AUTH_SOCK"] = str(self.workspace / "ambient-ssh.sock")
        environment["OPENAI_API_KEY"] = "ambient-openai-secret"
        started = time.monotonic()
        completed = subprocess.run(
            [NODE, "--input-type=module", "-e", NODE_DRIVER],
            input=json.dumps(request),
            check=False,
            capture_output=True,
            text=True,
            env=environment,
            timeout=10,
        )
        elapsed = time.monotonic() - started
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout), elapsed

    def write_contract(self, **value: object) -> Path:
        contract = self.workspace / f"mission-{len(list(self.workspace.iterdir()))}.json"
        contract.write_text(json.dumps(value), encoding="utf-8")
        return contract

    def prepare_dsh_native_core(self) -> None:
        """Provide a deterministic core transport while retaining the real bridge route."""
        shutil.copy2(BRIDGE_SOURCE, self.preset / "bin" / "kersor_bridge.py")
        (self.core / "AGENTS.md").write_text("test core\n", encoding="utf-8")
        (self.core / "commands").mkdir()
        scripts = self.core / "scripts"
        scripts.mkdir()
        (scripts / "compose.py").write_text("\n", encoding="utf-8")
        (scripts / "doctor.sh").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
        config = self.core / "config"
        config.mkdir()
        (config / "runtime-dsh-autonomous.json").write_text(
            json.dumps({
                "contract_version": "akw-js-runtime-v1",
                "broker": {
                    "type": "dsh-host-rpc",
                    "protocol": "kersor-dsh-host-rpc-v3",
                    "socket_env": "KERSOR_DSH_RPC_SOCKET",
                    "nonce_env": "KERSOR_DSH_RPC_NONCE",
                    "max_frame_bytes": 16 * 1024 * 1024,
                    "provider": "deepseek-official",
                    "model": "kimi-k2.7-code",
                    "timeout_seconds": 3600,
                },
            }),
            encoding="utf-8",
        )
        (scripts / "create-session.py").write_text(
            "import json, pathlib, sys\n"
            "payload = json.load(sys.stdin)\n"
            "target = pathlib.Path(sys.argv[1])\n"
            "(target / 'session-config.json').write_text(json.dumps(payload['config']))\n"
            "(target / 'state.json').write_text(json.dumps(payload['state']))\n",
            encoding="utf-8",
        )
        (scripts / "run-autonomous-workflow.py").write_text(
            "raise SystemExit(0)\n", encoding="utf-8"
        )
        (scripts / "dsh-route-probe.py").write_text(
            "import json, os, socket, struct, sys, time\n"
            "from pathlib import Path\n"
            "contract = Path(sys.argv[1])\n"
            "contract_value = json.loads(contract.read_text())\n"
            "request = {\n"
            "  'protocol': contract_value.get('rpc_protocol', 'kersor-dsh-host-rpc-v3'),\n"
            "  'type': 'execute',\n"
            "  'request_id': 'route-probe-1',\n"
            "  'nonce': os.environ['KERSOR_DSH_RPC_NONCE'],\n"
            "  'activation': {\n"
            "    'contract_version': 'akw-js-runtime-v1',\n"
            "    'call_id': 'route-probe/inspect/1',\n"
            "    'phase': contract_value.get('activation_phase', 'Plan revision 1'),\n"
            "    'label': contract_value.get('activation_label', 'plan-revision-1-attempt-1'),\n"
            "    'prompt': 'Inspect the workspace without mutation.',\n"
            "    'schema': {'type': 'object', 'properties': {'observed': {'type': 'boolean'}}, 'required': ['observed']},\n"
            "    'options': contract_value.get('activation_options', {}),\n"
            f"    'project_root': {str(self.workspace)!r},\n"
            "  },\n"
            "}\n"
            "if not contract_value.get('omit_activation_budget', False):\n"
            "  limit = contract_value.get('activation_budget_limit', 1000)\n"
            "  request['activation']['activation_budget'] = contract_value.get(\n"
            "    'activation_budget_override', {\n"
            "      'limit_tokens': limit,\n"
            "      'basis': 'remaining-workflow-budget',\n"
            "      'workflow_remaining_tokens': limit,\n"
            "    })\n"
            "if 'activation_model_role' in contract_value:\n"
            "  request['activation']['model_role'] = contract_value['activation_model_role']\n"
            "if 'activation_timeout_seconds' in contract_value:\n"
            "  request['activation']['timeout_seconds'] = contract_value['activation_timeout_seconds']\n"
            "if contract_value.get('probe_mode') in ('sequential-65', 'two-delayed'):\n"
            "  activation_count = 65 if contract_value['probe_mode'] == 'sequential-65' else 2\n"
            "  last = None\n"
            "  for index in range(activation_count):\n"
            "    request['request_id'] = f'route-probe-{index}'\n"
            "    request['activation']['call_id'] = f'route-probe/inspect/{index + 1}'\n"
            "    payload = json.dumps(request, separators=(',', ':')).encode()\n"
            "    sequential = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\n"
            "    sequential.connect(os.environ['KERSOR_DSH_RPC_SOCKET'])\n"
            "    sequential.sendall(struct.pack('>I', len(payload)) + payload)\n"
            "    header = sequential.recv(4)\n"
            "    size = struct.unpack('>I', header)[0]\n"
            "    chunks = bytearray()\n"
            "    while len(chunks) < size:\n"
            "      chunks.extend(sequential.recv(size - len(chunks)))\n"
            "    sequential.close()\n"
            "    last = json.loads(chunks)\n"
            "    if last.get('ok') is not True:\n"
            "      raise RuntimeError(last)\n"
            "    if contract_value['probe_mode'] == 'two-delayed':\n"
            "      time.sleep(0.08)\n"
            "  print(json.dumps({'status': 'completed', 'activation_count': activation_count, 'dsh_result': last['result']}))\n"
            "  raise SystemExit(0)\n"
            "payload = json.dumps(request, separators=(',', ':')).encode()\n"
            "sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\n"
            "sock.connect(os.environ['KERSOR_DSH_RPC_SOCKET'])\n"
            "sock.sendall(struct.pack('>I', len(payload)) + payload)\n"
            "if contract_value.get('probe_mode') == 'disconnect':\n"
            "  sock.close()\n"
            "  time.sleep(1.2)\n"
            "  print(json.dumps({'status': 'failed'}))\n"
            "  raise SystemExit(2)\n"
            "header = sock.recv(4)\n"
            "size = struct.unpack('>I', header)[0]\n"
            "chunks = bytearray()\n"
            "while len(chunks) < size:\n"
            "  chunks.extend(sock.recv(size - len(chunks)))\n"
            "response = json.loads(chunks)\n"
            "if response.get('ok') is not True:\n"
            "  if contract_value.get('probe_mode') == 'capture-error':\n"
            "    print(json.dumps({'status': 'failed', 'error': response['error']['message'], 'dsh_response': response}))\n"
            "    raise SystemExit(2)\n"
            "  raise RuntimeError(response)\n"
            "socket_path = Path(os.environ['KERSOR_DSH_RPC_SOCKET'])\n"
            "terminal = {\n"
            "  'status': 'completed',\n"
            "  'dsh_result': response['result'],\n"
            "  'rpc_probe': {\n"
            "    'socket_mode': oct(socket_path.stat().st_mode & 0o777),\n"
            "    'directory_mode': oct(socket_path.parent.stat().st_mode & 0o777),\n"
            "    'nonce_bytes': len(bytes.fromhex(os.environ['KERSOR_DSH_RPC_NONCE'])),\n"
            "  },\n"
            "}\n"
            "print(json.dumps(terminal))\n",
            encoding="utf-8",
        )
        (scripts / "evolve.sh").write_text(
            "#!/usr/bin/env bash\n"
            "set -euo pipefail\n"
            f"exec {sys.executable!s} {scripts / 'dsh-route-probe.py'!s} \"$1\"\n",
            encoding="utf-8",
        )
        os.chmod(scripts / "evolve.sh", 0o755)
        manifest_path = self.preset / ".local" / "runtime-tools.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for name, executable in {
            "bash": shutil.which("bash"),
            "python3": sys.executable,
            "node": NODE,
            "jq": shutil.which("jq") or sys.executable,
        }.items():
            self.assertIsNotNone(executable, name)
            manifest["tools"][name] = executable
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    def invoke_dsh_native(
        self,
        contract: Path,
        *,
        runtime: str | None = None,
        abort_after_ms: int | None = None,
        child_mode: str | None = None,
        guard_probe: bool = False,
        transaction_artifact: Path | None = None,
        undeclared_artifact: Path | None = None,
        transaction_alias: str | None = None,
        cwd: Path | None = None,
        swap_workspace_to: Path | None = None,
        timeout_ms: int | None = None,
        context_window: int | None = 100,
        context_windows: list[int] | None = None,
        llm_calls: list[dict[str, object]] | None = None,
        late_same_session_probe: bool = False,
        trailing_title_event: bool = False,
        prepared_stream_version: int | None = 1,
        invoke_command: bool = False,
        native_advisers: int = 0,
        agent_document: str | None = None,
    ) -> dict[str, object]:
        request: dict[str, object] = {
            "module": str(self.module),
            "cwd": str(self.workspace if cwd is None else cwd),
            "args": {
                "contract": str(contract),
                **({} if runtime is None else {"runtime": runtime}),
            },
            "outside_file": str(self.outside_secret),
            "outside_directory": str(self.home),
            "escape_symlink": str(self.escape_symlink),
            "context_window": context_window,
            "native_advisers": native_advisers,
        }
        if abort_after_ms is not None:
            request["abort_after_ms"] = abort_after_ms
        if child_mode is not None:
            request["child_mode"] = child_mode
        if guard_probe:
            request["guard_probe"] = True
        if transaction_artifact is not None:
            request["transaction_artifact"] = str(transaction_artifact)
        if undeclared_artifact is not None:
            request["undeclared_artifact"] = str(undeclared_artifact)
        if transaction_alias is not None:
            request["transaction_alias"] = transaction_alias
        if swap_workspace_to is not None:
            request["swap_workspace_to"] = str(swap_workspace_to)
        if timeout_ms is not None:
            request["timeout_ms"] = timeout_ms
        if llm_calls is not None:
            request["llm_calls"] = llm_calls
        if context_windows is not None:
            request["context_windows"] = context_windows
        if late_same_session_probe:
            request["late_same_session_probe"] = True
        if trailing_title_event:
            request["trailing_title_event"] = True
        if prepared_stream_version is not None:
            request["prepared_stream_version"] = prepared_stream_version
        if invoke_command:
            request["invoke_command"] = True
        if agent_document is not None:
            request["agent_document"] = agent_document
        completed = subprocess.run(
            [NODE, "--input-type=module", "-e", DSH_NODE_DRIVER],
            input=json.dumps(request),
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def write_transaction_probe_contract(
        self,
        candidate: Path,
        mission_id: str,
        *,
        capture_error: bool = False,
    ) -> Path:
        return self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / mission_id),
            runtime="dsh",
            **({"probe_mode": "capture-error"} if capture_error else {}),
            activation_phase="Execute revision 1",
            activation_label="mutate_candidate",
            activation_options={"transaction": {
                "artifacts": [candidate.name],
                "rollback_on_noncompleted_status": True,
            }},
            mission={
                "mission_id": mission_id,
                "goal": "mutate one declared candidate",
                "authority": [f"write {candidate.name}"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{
                "name": "mutate",
                "side_effect": "write",
                "transaction_artifacts": [candidate.name],
            }],
        )

    def test_public_host_runs_fixed_task_through_dsh_transaction(self) -> None:
        self.prepare_dsh_native_core()
        primary = self.workspace / "candidate.py"
        secondary = self.workspace / "semver.py"
        primary.write_text("baseline = True\n", encoding="utf-8")
        secondary.write_text("baseline = True\n", encoding="utf-8")
        contract = self.root / "task.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-task-v1",
                "workspace": "workspace",
                "runtime": "codex",
                "objective": "repair both declared artifacts",
                "max_rounds": 2,
                "native_subagents": 0,
                "activation_phase": "Evolve 1",
                "activation_label": "evolve-1",
                "activation_options": {"transaction": {
                    "artifacts": [primary.name, secondary.name],
                }},
                "verifier": {
                    "argv": ["python3", "../verifier/verify.py"],
                    "cwd": ".",
                    "artifacts": [primary.name, secondary.name],
                    "feedback": "status",
                },
            }),
            encoding="utf-8",
        )

        result = self.invoke_dsh_native(
            contract,
            runtime="dsh",
            transaction_artifact=primary,
        )

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "completed", result)
        self.assertEqual(result["value"]["dsh_result"]["model_role"], "worker")
        self.assertEqual(len(result["telemetry"]["starts"]), 1)
        self.assertEqual(result["telemetry"]["starts"][0]["label"], "KerSor · evolve-1")
        self.assertEqual(
            result["telemetry"]["starts"][0]["tool_filter"],
            {"allow": ["read", "glob", "grep", "edit", "write"]},
        )
        self.assertIsNone(result["telemetry"]["guards"]["edit"])
        self.assertIsNone(result["telemetry"]["guards"]["write"])

    def test_public_host_runs_fixed_task_with_dynamic_incumbent_gate(self) -> None:
        self.prepare_dsh_native_core()
        candidate = self.workspace / "candidate.py"
        candidate.write_text("baseline = True\n", encoding="utf-8")
        verifier_request = {
            "protocol": "command-v1",
            "argv": ["python3", "../verifier/verify.py", "--candidate-gate"],
            "cwd": ".",
            "artifacts": [candidate.name],
            "timeout_seconds": 1200,
            "replay": False,
        }
        contract = self.root / "task.json"
        contract_value = {
                "contract_version": "kersor-task-v1",
                "workspace": "workspace",
                "runtime": "codex",
                "objective": "improve one correct candidate",
                "max_rounds": 2,
                "native_subagents": 0,
                "activation_phase": "Evolve 1",
                "activation_label": "evolve-1",
                "activation_options": {"transaction": {
                    "artifacts": [candidate.name],
                    "rollback_on_noncompleted_status": True,
                    "candidate_gate": {
                        "verifier": "task-incumbent",
                        "request": verifier_request,
                        "result_artifact": "incumbent-verifier-result",
                        "fact_projections": [{
                            "output_name": "candidate_score",
                            "result_path": "stdout_json.promotion_score",
                        }],
                        "commit_projection": {
                            "result_path": "stdout_json.promotion_score",
                            "op": "lt",
                            "value": 1332,
                        },
                    },
                }},
                "verifier": {
                    "argv": ["python3", "../verifier/verify.py"],
                    "cwd": ".",
                    "artifacts": [candidate.name],
                    "feedback": "declared",
                    "timeout_seconds": 1200,
                    "incumbent": {
                        "result_path": "stdout_json.promotion_score",
                        "direction": "minimize",
                        "gate_argv": verifier_request["argv"],
                    },
                },
            }
        contract.write_text(
            json.dumps(contract_value),
            encoding="utf-8",
        )

        result = self.invoke_dsh_native(
            contract,
            runtime="dsh",
            transaction_artifact=candidate,
        )

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "completed", result)
        self.assertEqual(len(result["telemetry"]["starts"]), 1)
        self.assertIsNone(result["telemetry"]["guards"]["edit"])
        self.assertIsNone(result["telemetry"]["guards"]["write"])

        contract_value["activation_options"]["transaction"]["candidate_gate"][
            "commit_projection"
        ]["value"] = "1332"
        contract.write_text(json.dumps(contract_value), encoding="utf-8")
        rejected = self.invoke_dsh_native(
            contract,
            runtime="dsh",
            transaction_artifact=candidate,
        )
        self.assertTrue(rejected["ok"], rejected.get("error"))
        self.assertEqual(rejected["value"]["status"], "failed")
        self.assertIn("candidate gate does not match", rejected["value"]["error"])
        self.assertEqual(rejected["telemetry"]["starts"], [])

    def test_public_host_runs_exact_read_only_advisers_under_one_activation_ledger(self) -> None:
        self.prepare_dsh_native_core()
        candidate = self.workspace / "candidate.py"
        candidate.write_text("baseline = True\n", encoding="utf-8")
        contract = self.root / "task.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-task-v1",
                "workspace": "workspace",
                "runtime": "codex",
                "objective": "repair with two independent reviews",
                "max_rounds": 1,
                "native_subagents": 2,
                "activation_phase": "Evolve 1",
                "activation_label": "evolve-1",
                "activation_options": {
                    "native_subagents": 2,
                    "transaction": {"artifacts": [candidate.name]},
                },
                "verifier": {
                    "argv": ["python3", "../verifier/verify.py"],
                    "cwd": ".",
                    "artifacts": [candidate.name],
                    "feedback": "status",
                },
            }),
            encoding="utf-8",
        )

        result = self.invoke_dsh_native(
            contract,
            runtime="dsh",
            transaction_artifact=candidate,
            native_advisers=2,
        )

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "completed", result)
        receipt = result["value"]["dsh_result"]
        self.assertEqual(receipt["usage"]["total_tokens"], 69)
        self.assertEqual(receipt["budget_charge_tokens"], 69)
        self.assertEqual(receipt["native_subagents"], {
            "requested": 2,
            "spawned": 2,
            "completed": 2,
            "thread_ids": ["dsh-adviser-1", "dsh-adviser-2"],
            "status": "observed",
        })
        self.assertEqual(
            result["telemetry"]["starts"][0]["tool_filter"],
            {"allow": ["read", "glob", "grep", "edit", "write", "subagent"]},
        )
        self.assertEqual(
            [item["restriction"] for item in result["telemetry"]["advisers"]],
            [{"allow": ["read", "glob", "grep"]}] * 2,
        )
        self.assertNotIn("run_in_background", result["telemetry"]["scoped_adviser_parameters"])

        incomplete = self.invoke_dsh_native(
            contract,
            runtime="dsh",
            transaction_artifact=candidate,
            native_advisers=1,
        )
        self.assertTrue(incomplete["ok"], incomplete.get("error"))
        self.assertEqual(incomplete["value"]["status"], "failed")
        self.assertIn("exact requested native adviser set", incomplete["value"]["error"])

    def test_human_command_launches_fixed_task_without_a_model_turn(self) -> None:
        self.prepare_dsh_native_core()
        candidate = self.workspace / "candidate.py"
        candidate.write_text("baseline = True\n", encoding="utf-8")
        contract = self.root / "task.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-task-v1",
                "workspace": "workspace",
                "runtime": "codex",
                "objective": "repair the declared artifact",
                "max_rounds": 1,
                "native_subagents": 0,
                "activation_phase": "Evolve 1",
                "activation_label": "evolve-1",
                "activation_options": {"transaction": {
                    "artifacts": [candidate.name],
                }},
                "verifier": {
                    "argv": ["python3", "../verifier/verify.py"],
                    "cwd": ".",
                    "artifacts": [candidate.name],
                    "feedback": "status",
                },
            }),
            encoding="utf-8",
        )

        result = self.invoke_dsh_native(
            contract,
            runtime="dsh",
            transaction_artifact=candidate,
            invoke_command=True,
        )

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["command_result"]["kind"], "success")
        self.assertIs(result["command_engages_session"], True)
        terminal = json.loads(result["command_result"]["text"])
        self.assertEqual(terminal["status"], "completed")
        self.assertEqual(len(result["session_events"]), 1)
        self.assertEqual(len(result["telemetry"]["starts"]), 1)
        self.assertNotIn("conclude_count", result["telemetry"])

    def test_dsh_outer_host_does_not_time_out_a_later_bounded_activation(self) -> None:
        self.prepare_dsh_native_core()
        candidate = self.workspace / "candidate.py"
        candidate.write_text("baseline = True\n", encoding="utf-8")
        contract = self.root / "task.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-task-v1",
                "workspace": "workspace",
                "runtime": "codex",
                "objective": "exercise two sequential bounded activations",
                "max_rounds": 2,
                "native_subagents": 0,
                "probe_mode": "two-delayed",
                "activation_phase": "Evolve 1",
                "activation_options": {"transaction": {
                    "artifacts": [candidate.name],
                }},
                "verifier": {
                    "argv": ["python3", "../verifier/verify.py"],
                    "cwd": ".",
                    "artifacts": [candidate.name],
                    "feedback": "status",
                },
            }),
            encoding="utf-8",
        )

        result = self.invoke_dsh_native(
            contract,
            runtime="dsh",
            transaction_artifact=candidate,
            # The deterministic Core probe takes >160ms across two RPC
            # activations. A process-wide 50ms watchdog would kill round 1 or
            # round 2 even though each owned operation is bounded.
            timeout_ms=50,
        )

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "completed", result)
        self.assertEqual(result["value"]["activation_count"], 2)

    def test_dsh_activation_timeout_is_bounded_to_one_hour(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "hour-timeout"),
            runtime="dsh",
            activation_timeout_seconds=3600,
            mission={
                "mission_id": "hour-timeout",
                "goal": "accept the canonical DSH activation ceiling",
                "authority": ["read workspace"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{"name": "inspect", "side_effect": "read"}],
        )

        accepted = self.invoke_dsh_native(contract)

        self.assertTrue(accepted["ok"], accepted.get("error"))
        self.assertEqual(accepted["value"]["status"], "completed", accepted)
        self.assertEqual(len(accepted["telemetry"]["starts"]), 1)

        contract_value = json.loads(contract.read_text(encoding="utf-8"))
        contract_value["activation_timeout_seconds"] = 3601
        contract_value["probe_mode"] = "capture-error"
        contract.write_text(json.dumps(contract_value), encoding="utf-8")

        rejected = self.invoke_dsh_native(contract)

        self.assertTrue(rejected["ok"], rejected.get("error"))
        self.assertEqual(rejected["value"]["status"], "failed", rejected)
        self.assertIn("timeout_seconds must be in (0, 3600]", rejected["value"]["error"])
        self.assertEqual(rejected["telemetry"]["starts"], [])

    def test_public_host_allows_omitted_activation_budget_and_rejects_malformed_ones(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_dsh_failure_contract("unbounded-activation")
        value = json.loads(contract.read_text(encoding="utf-8"))
        value["omit_activation_budget"] = True
        contract.write_text(json.dumps(value), encoding="utf-8")
        accepted = self.invoke_dsh_native(contract)
        self.assertTrue(accepted["ok"], accepted.get("error"))
        receipt = accepted["value"]["dsh_result"]
        self.assertEqual(accepted["value"]["status"], "completed")
        self.assertNotIn("budget_charge_tokens", receipt)
        self.assertEqual(accepted["telemetry"]["provider_calls"], 1)

        for mutation in (
            {"activation_budget_override": {
                "limit_tokens": 1000,
                "basis": "remaining-workflow-budget",
                "workflow_remaining_tokens": 999,
            }},
            {"activation_budget_override": {
                "limit_tokens": 1000,
                "basis": "remaining-workflow-budget",
                "workflow_remaining_tokens": 1000,
                "extra": True,
            }},
        ):
            with self.subTest(mutation=mutation):
                contract = self.write_dsh_failure_contract("strict-activation-budget")
                value = json.loads(contract.read_text(encoding="utf-8"))
                value.update(mutation)
                contract.write_text(json.dumps(value), encoding="utf-8")

                result = self.invoke_dsh_native(contract)

                self.assertTrue(result["ok"], result.get("error"))
                response = result["value"]["dsh_response"]
                self.assertEqual(response["error"]["code"], "DSH_ACTIVATION_REJECTED")
                self.assertIn("activation_budget", response["error"]["message"])
                self.assertEqual(result["telemetry"]["starts"], [])
                self.assertEqual(result["telemetry"]["provider_calls"], 0)

    def test_unbounded_activation_keeps_incomplete_usage_observational(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_dsh_failure_contract("unbounded-incomplete-usage")
        value = json.loads(contract.read_text(encoding="utf-8"))
        value["omit_activation_budget"] = True
        contract.write_text(json.dumps(value), encoding="utf-8")

        result = self.invoke_dsh_native(
            contract,
            child_mode="ledger-missing-usage",
            llm_calls=[{"session_id": "child", "chunks": [
                {"type": "finish", "reason": {"kind": "stop"}},
            ]}],
        )

        self.assertTrue(result["ok"], result.get("error"))
        receipt = result["value"]["dsh_result"]
        self.assertEqual(result["value"]["status"], "completed")
        self.assertFalse(receipt["usage_observed"])
        self.assertFalse(receipt["usage_complete"])
        self.assertNotIn("budget_charge_tokens", receipt)
        self.assertEqual(result["telemetry"]["provider_calls"], 1)

    def test_public_host_requires_registration_bound_prepared_stream_seam(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_dsh_failure_contract("missing-prepared-stream-seam")

        result = self.invoke_dsh_native(contract, prepared_stream_version=0)

        self.assertIn("prepared-stream admission v1", result["apply_error"])
        self.assertEqual(result["telemetry"]["starts"], [])
        self.assertEqual(result["telemetry"]["provider_calls"], 0)

    def test_public_host_requires_prepared_context_before_provider_start(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_dsh_failure_contract("missing-context-window")

        result = self.invoke_dsh_native(contract, context_window=None)

        self.assertTrue(result["ok"], result.get("error"))
        response = result["value"]["dsh_response"]
        self.assertEqual(response["error"]["code"], "DSH_CHILD_USAGE_INCOMPLETE")
        self.assertEqual(len(result["telemetry"]["starts"]), 1)
        self.assertEqual(result["telemetry"]["provider_calls"], 0)

    def test_public_host_rejects_v1_before_child_or_provider_start(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_dsh_failure_contract("old-rpc-protocol")
        value = json.loads(contract.read_text(encoding="utf-8"))
        value["rpc_protocol"] = "kersor-dsh-host-rpc-v1"
        contract.write_text(json.dumps(value), encoding="utf-8")

        result = self.invoke_dsh_native(contract)

        self.assertTrue(result["ok"], result.get("error"))
        response = result["value"]["dsh_response"]
        self.assertEqual(response["error"]["code"], "DSH_ACTIVATION_REJECTED")
        self.assertIn("protocol or type", response["error"]["message"])
        self.assertEqual(result["telemetry"]["starts"], [])
        self.assertEqual(result["telemetry"]["provider_calls"], 0)

    def test_public_host_returns_typed_child_deadline_receipt(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_dsh_failure_contract("typed-child-timeout")
        value = json.loads(contract.read_text(encoding="utf-8"))
        value["activation_timeout_seconds"] = 0.05
        contract.write_text(json.dumps(value), encoding="utf-8")

        result = self.invoke_dsh_native(contract, child_mode="wait")

        self.assertTrue(result["ok"], result.get("error"))
        response = result["value"]["dsh_response"]
        self.assertEqual(response["error"], {
            "code": "DSH_CHILD_TIMEOUT",
            "message": "DSH child activation timed out",
        })
        self.assertEqual(response["result"]["stop_reason"], "aborted")
        self.assertFalse(response["result"]["usage_complete"])
        self.assertEqual(response["result"]["artifacts"], [])

    def test_public_host_allows_trailing_session_title_metadata(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_dsh_failure_contract("trailing-title")

        result = self.invoke_dsh_native(contract, trailing_title_event=True)

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "completed")
        self.assertTrue(result["value"]["dsh_result"]["usage_complete"])

    def test_public_host_ledgers_retry_title_and_compaction_by_child_session(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "ledger-all-calls"),
            runtime="dsh",
            mission={
                "mission_id": "ledger-all-calls",
                "goal": "account for every child model request",
                "authority": ["read workspace"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{"name": "inspect", "side_effect": "read"}],
        )
        calls = [
            {"session_id": "child", "chunks": [
                {"type": "usage", "usage": {"inputTokens": 7, "outputTokens": 3}},
                {"type": "finish", "reason": {"kind": "error", "failure": {
                    "message": "retryable", "code": "SERVER", "status": 503,
                }}},
            ]},
            {"session_id": "child", "chunks": [
                {"type": "usage", "usage": {
                    "inputTokens": 11, "cacheReadTokens": 4, "outputTokens": 5,
                }},
                {"type": "finish", "reason": {"kind": "stop"}},
            ]},
            {"session_id": "child", "purpose": "session-title", "chunks": [
                {"type": "usage", "usage": {"inputTokens": 2, "outputTokens": 1}},
                {"type": "finish", "reason": {"kind": "stop"}},
            ]},
            {"session_id": "child", "purpose": "compaction", "chunks": [
                {"type": "usage", "usage": {"inputTokens": 3, "outputTokens": 1}},
                {"type": "finish", "reason": {"kind": "stop"}},
            ]},
            {"session_id": "other", "chunks": [
                {"type": "usage", "usage": {"inputTokens": 80, "outputTokens": 20}},
                {"type": "finish", "reason": {"kind": "stop"}},
            ]},
        ]

        result = self.invoke_dsh_native(
            contract,
            child_mode="ledger-all-calls",
            llm_calls=calls,
            late_same_session_probe=True,
        )

        self.assertTrue(result["ok"], result.get("error"))
        receipt = result["value"]["dsh_result"]
        self.assertEqual(receipt["usage"], {
            "input_tokens": 23,
            "cached_input_tokens": 4,
            "output_tokens": 10,
            "total_tokens": 37,
        })
        self.assertTrue(receipt["usage_observed"])
        self.assertTrue(receipt["usage_complete"])
        self.assertEqual(receipt["budget_charge_tokens"], 37)
        self.assertEqual(
            receipt["budget_charge_basis"],
            "dsh-host-attested-actual-or-registration-context-reservation-v1",
        )
        self.assertEqual(receipt["unmetered_attempts"], 0)
        self.assertEqual(receipt["metered_attempt_tokens"], 37)
        self.assertEqual(receipt["unmetered_reservation_tokens"], 0)
        self.assertEqual(result["telemetry"]["provider_calls"], 6)
        self.assertEqual(
            result["telemetry"]["late_same_session_chunks"][-1]["type"],
            "finish",
        )

    def test_public_host_denies_next_request_before_provider_when_budget_cannot_reserve_context(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_dsh_failure_contract("token-budget")
        value = json.loads(contract.read_text(encoding="utf-8"))
        value["activation_budget_limit"] = 150
        contract.write_text(json.dumps(value), encoding="utf-8")
        calls = [
            {"session_id": "child", "chunks": [
                {"type": "usage", "usage": {"inputTokens": 70, "outputTokens": 20}},
                {"type": "finish", "reason": {"kind": "stop"}},
            ]},
            {"session_id": "child", "chunks": [
                {"type": "usage", "usage": {"inputTokens": 1, "outputTokens": 1}},
                {"type": "finish", "reason": {"kind": "stop"}},
            ]},
        ]

        result = self.invoke_dsh_native(
            contract,
            child_mode="token-budget",
            context_window=100,
            llm_calls=calls,
        )

        self.assertTrue(result["ok"], result.get("error"))
        response = result["value"]["dsh_response"]
        self.assertEqual(response["error"], {
            "code": "DSH_CHILD_TOKEN_BUDGET_EXHAUSTED",
            "message": "DSH child activation token budget exhausted",
        })
        self.assertEqual(result["telemetry"]["provider_calls"], 1)
        self.assertEqual(response["result"]["usage"], {
            "input_tokens": 70,
            "cached_input_tokens": 0,
            "output_tokens": 20,
            "total_tokens": 90,
        })
        self.assertTrue(response["result"]["usage_complete"])
        self.assertEqual(response["result"]["artifacts"], [{
            "schema_version": 1,
            "kind": "dsh-activation-budget-exhausted",
            "source": "dsh-host-llm-stream-ledger",
            "reason_code": "insufficient-context-window-reservation",
            "limit_tokens": 150,
            "charged_tokens": 90,
            "remaining_tokens": 60,
            "required_reservation_tokens": 100,
            "provider_request_started": False,
        }])

    def test_public_host_charges_one_unmetered_success_from_its_exact_reservation(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_dsh_failure_contract("ledger-missing-usage")

        result = self.invoke_dsh_native(
            contract,
            child_mode="ledger-missing-usage",
            llm_calls=[{"session_id": "child", "chunks": [
                {"type": "finish", "reason": {"kind": "stop"}},
            ]}],
        )

        self.assertTrue(result["ok"], result.get("error"))
        receipt = result["value"]["dsh_result"]
        self.assertEqual(receipt["usage"], {
            "input_tokens": 0,
            "cached_input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
        })
        self.assertFalse(receipt["usage_observed"])
        self.assertFalse(receipt["usage_complete"])
        self.assertEqual(receipt["budget_charge_tokens"], 100)
        self.assertEqual(
            receipt["budget_charge_basis"],
            "dsh-host-attested-actual-or-registration-context-reservation-v1",
        )
        self.assertEqual(receipt["unmetered_attempts"], 1)
        self.assertEqual(receipt["metered_attempt_tokens"], 0)
        self.assertEqual(receipt["unmetered_reservation_tokens"], 100)
        self.assertEqual(result["telemetry"]["provider_calls"], 1)

    def test_public_host_does_not_close_ledger_before_dsh_retry(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_dsh_failure_contract("retry-after-unmetered-timeout")
        calls = [
            {"session_id": "child", "chunks": [{
                "type": "finish",
                "reason": {"kind": "error", "failure": {
                    "message": "DeepSeek stream idle timeout after 300000ms",
                    "code": "TIMEOUT",
                }},
            }]},
            {"session_id": "child", "chunks": [
                {"type": "usage", "usage": {
                    "inputTokens": 11,
                    "cacheReadTokens": 3,
                    "cacheWriteTokens": 2,
                    "outputTokens": 7,
                }},
                {"type": "finish", "reason": {"kind": "stop"}},
            ]},
        ]

        result = self.invoke_dsh_native(
            contract,
            child_mode="retry-after-unmetered-timeout",
            llm_calls=calls,
        )

        self.assertTrue(result["ok"], result.get("error"))
        receipt = result["value"]["dsh_result"]
        self.assertEqual(receipt["usage"], {
            "input_tokens": 11,
            "cached_input_tokens": 5,
            "output_tokens": 7,
            "total_tokens": 23,
        })
        self.assertTrue(receipt["usage_observed"])
        self.assertFalse(receipt["usage_complete"])
        self.assertEqual(receipt["budget_charge_tokens"], 123)
        self.assertEqual(
            receipt["budget_charge_basis"],
            "dsh-host-attested-actual-or-registration-context-reservation-v1",
        )
        self.assertEqual(receipt["unmetered_attempts"], 1)
        self.assertEqual(receipt["metered_attempt_tokens"], 23)
        self.assertEqual(receipt["unmetered_reservation_tokens"], 100)
        self.assertEqual(result["telemetry"]["provider_calls"], 2)
        self.assertEqual(
            result["telemetry"]["streamed_calls"][1]["chunks"][-1],
            {"type": "finish", "reason": {"kind": "stop"}},
        )

    def test_public_host_reserves_a_larger_registration_bound_context_window(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_dsh_failure_contract("token-budget-context-growth")
        value = json.loads(contract.read_text(encoding="utf-8"))
        value["activation_budget_limit"] = 220
        contract.write_text(json.dumps(value), encoding="utf-8")
        calls = [
            {"session_id": "child", "chunks": [
                {"type": "usage", "usage": {"inputTokens": 70, "outputTokens": 20}},
                {"type": "finish", "reason": {"kind": "stop"}},
            ]},
            {"session_id": "child", "chunks": [
                {"type": "usage", "usage": {"inputTokens": 1, "outputTokens": 1}},
                {"type": "finish", "reason": {"kind": "stop"}},
            ]},
        ]

        result = self.invoke_dsh_native(
            contract,
            child_mode="token-budget",
            context_windows=[100, 150],
            llm_calls=calls,
        )

        self.assertTrue(result["ok"], result.get("error"))
        response = result["value"]["dsh_response"]
        self.assertEqual(response["error"]["code"], "DSH_CHILD_TOKEN_BUDGET_EXHAUSTED")
        self.assertEqual(result["telemetry"]["provider_calls"], 1)
        receipt = response["result"]["artifacts"][0]
        self.assertEqual(receipt["limit_tokens"], 220)
        self.assertEqual(receipt["charged_tokens"], 90)
        self.assertEqual(receipt["remaining_tokens"], 130)
        self.assertEqual(receipt["required_reservation_tokens"], 150)

    def test_public_host_rejects_fixed_task_phase_drift_before_child_start(self) -> None:
        self.prepare_dsh_native_core()
        candidate = self.workspace / "candidate.py"
        candidate.write_text("baseline = True\n", encoding="utf-8")
        contract = self.root / "task.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-task-v1",
                "workspace": "workspace",
                "runtime": "codex",
                "objective": "reject Mission phase aliases",
                "max_rounds": 1,
                "native_subagents": 0,
                "activation_phase": "Execute revision 1",
                "activation_options": {"transaction": {"artifacts": [candidate.name]}},
                "verifier": {
                    "argv": ["python3", "../verifier/verify.py"],
                    "cwd": ".",
                    "artifacts": [candidate.name],
                    "feedback": "status",
                },
            }),
            encoding="utf-8",
        )

        result = self.invoke_dsh_native(contract, runtime="dsh")

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn('must match "Evolve <positive integer>"', result["value"]["error"])
        self.assertEqual(result["telemetry"]["starts"], [])

    def write_dsh_failure_contract(self, mission_id: str) -> Path:
        return self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / mission_id),
            runtime="dsh",
            probe_mode="capture-error",
            mission={
                "mission_id": mission_id,
                "goal": "surface one child terminal failure safely",
                "authority": ["read workspace"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{"name": "inspect", "side_effect": "read"}],
        )

    def assert_unproven_quota_receipt(
        self,
        mode: str,
        provider_code: str = "QUOTA",
    ) -> dict[str, object]:
        contract = self.write_dsh_failure_contract(mode)
        result = self.invoke_dsh_native(contract, child_mode=mode)

        self.assertTrue(result["ok"], result.get("error"))
        response = result["value"]["dsh_response"]
        self.assertEqual(response["error"]["code"], "DSH_CHILD_TERMINAL_ERROR")
        self.assertEqual(response["error"]["provider_code"], provider_code)
        self.assertEqual(response["error"]["provider_status"], 429)
        self.assertEqual(response["result"]["usage"], {
            "input_tokens": 0,
            "cached_input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
        })
        self.assertFalse(response["result"]["usage_observed"])
        self.assertFalse(response["result"]["usage_complete"])

    def assert_terminal_step_quota_is_incomplete(
        self,
        mode: str,
        *,
        provider_code: str = "QUOTA",
        provider_status: int = 429,
        expected_usage: dict[str, int] | None = None,
        expected_usage_observed: bool = True,
    ) -> None:
        contract = self.write_dsh_failure_contract(mode)
        result = self.invoke_dsh_native(contract, child_mode=mode)

        self.assertTrue(result["ok"], result.get("error"))
        response = result["value"]["dsh_response"]
        self.assertEqual(response["error"]["code"], "DSH_CHILD_TERMINAL_ERROR")
        self.assertEqual(response["error"]["provider_code"], provider_code)
        self.assertEqual(response["error"]["provider_status"], provider_status)
        self.assertEqual(response["result"]["usage"], expected_usage or {
            "input_tokens": 60,
            "cached_input_tokens": 10,
            "output_tokens": 6,
            "total_tokens": 76,
        })
        self.assertEqual(
            response["result"]["usage_observed"], expected_usage_observed
        )
        self.assertFalse(response["result"]["usage_complete"])
        return response

    def test_public_tool_routes_read_only_dsh_mission_to_pinned_spawn_child(self) -> None:
        self.prepare_dsh_native_core()
        session = self.workspace / ".kersor-autonomous" / "route-probe"
        local_runtime_config = self.workspace / "runtime-config.json"
        local_runtime_config.write_bytes(
            (self.core / "config" / "runtime-dsh-autonomous.json").read_bytes()
        )
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(session),
            runtime="dsh",
            runtime_config=local_runtime_config.name,
            mission={
                "mission_id": "route-probe",
                "goal": "inspect safely",
                "authority": ["read workspace"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{
                "name": "inspect",
                "side_effect": "read",
            }],
        )

        result = self.invoke_dsh_native(contract, guard_probe=True)

        self.assertTrue(result["ok"], result.get("error"))
        telemetry = result["telemetry"]
        self.assertEqual(len(telemetry["starts"]), 1)
        start = telemetry["starts"][0]
        self.assertEqual(start["provider"], "spawn")
        self.assertTrue(start["parent_is_caller"])
        self.assertEqual(start["agent_options"], {
            "provider": "deepseek-official",
            "model": "kimi-k2.7-code",
        })
        self.assertEqual(start["tool_filter"], {"allow": ["read", "glob", "grep"]})
        self.assertEqual(telemetry["dispose_count"], 1)
        self.assertEqual(telemetry["conclude_count"], 1)
        self.assertEqual(len(telemetry["same_turn_denials"]), 1)
        self.assertIn("owns the rest", telemetry["same_turn_denials"][0])
        self.assertEqual(len(telemetry["same_turn_nested_denials"]), 1)
        self.assertIn("owns the rest", telemetry["same_turn_nested_denials"][0])
        self.assertEqual(telemetry["next_turn_denials"], [])
        for allowed in ("read", "structured_output"):
            self.assertIsNone(telemetry["guards"][allowed])
        for broad_search in ("glob", "grep"):
            self.assertIn("workspace root", telemetry["guards"][broad_search])
            self.assertIn(
                "workspace-root search is unavailable",
                telemetry["scoped_tool_descriptions"][broad_search],
            )
        for forbidden in ("edit", "write", "bash", "workflow", "kersor_evolve"):
            self.assertIn("read-only", telemetry["guards"][forbidden])
        self.assertIn("did not request native advisers", telemetry["guards"]["subagent"])
        for escaped in ("read_outside", "glob_outside", "grep_symlink_escape", "glob_parent_pattern"):
            self.assertIsNotNone(telemetry["guards"][escaped])
        for control in ("read_control", "glob_control", "grep_control"):
            self.assertIn("runtime-control", telemetry["guards"][control])
        self.assertNotIn("outside-secret-must-not-leak", json.dumps(result))
        terminal = result["value"]
        self.assertEqual(terminal["rpc_probe"], {
            "socket_mode": "0o600",
            "directory_mode": "0o700",
            "nonce_bytes": 32,
        })
        receipt = terminal["dsh_result"]
        self.assertEqual(receipt["provider"], "deepseek-official")
        self.assertEqual(receipt["model"], "kimi-k2.7-code")
        self.assertEqual(receipt["model_role"], "planner")
        self.assertTrue(receipt["usage_observed"])
        self.assertTrue(receipt["usage_complete"])
        self.assertEqual(receipt["usage"], {
            "input_tokens": 11,
            "cached_input_tokens": 5,
            "output_tokens": 7,
            "total_tokens": 23,
        })

    def test_public_host_allows_only_hash_bound_agent_document_reads(self) -> None:
        self.prepare_dsh_native_core()
        relative = ".kersor/agent-documents/0123456789abcdef/handoff.md"
        document = self.workspace / relative
        document.parent.mkdir(parents=True)
        document.write_text("# Handoff\n\nHost evidence.\n", encoding="utf-8")
        descriptor = {
            "path": relative,
            "sha256": hashlib.sha256(document.read_bytes()).hexdigest(),
        }
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "document-read"),
            runtime="dsh",
            activation_options={"documents": [descriptor]},
            mission={
                "mission_id": "document-read",
                "goal": "read one Host handoff",
                "authority": ["read workspace"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{"name": "inspect", "side_effect": "read"}],
        )

        result = self.invoke_dsh_native(
            contract,
            guard_probe=True,
            agent_document=relative,
        )

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["telemetry"]["agent_document"], relative, result)
        self.assertIn("read_document", result["telemetry"]["guards"], result)
        self.assertIsNone(result["telemetry"]["guards"]["read_document"])
        self.assertIn("runtime-control", result["telemetry"]["guards"]["read_control"])

        document.write_text("drifted\n", encoding="utf-8")
        rejected = self.invoke_dsh_native(contract, agent_document=relative)
        self.assertTrue(rejected["ok"], rejected.get("error"))
        self.assertEqual(rejected["value"]["status"], "failed")
        self.assertIn("document hash", rejected["value"]["error"])

    def test_public_host_projects_execute_phase_as_worker_role(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "worker-role"),
            runtime="dsh",
            activation_phase="Execute revision 1",
            activation_label="route_probe_1",
            mission={
                "mission_id": "worker-role",
                "goal": "inspect safely",
                "authority": ["read workspace"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{"name": "inspect", "side_effect": "read"}],
        )

        result = self.invoke_dsh_native(contract)

        self.assertTrue(result["ok"], result.get("error"))
        receipt = result["value"]["dsh_result"]
        self.assertEqual(receipt["model_role"], "worker")
        self.assertEqual(receipt["provider"], "deepseek-official")
        self.assertEqual(receipt["model"], "kimi-k2.7-code")

    def test_public_host_reports_exact_pre_usage_quota_as_complete_zero_receipt(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_dsh_failure_contract("quota-before-usage")

        result = self.invoke_dsh_native(contract, child_mode="quota")

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "failed")
        response = result["value"]["dsh_response"]
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"], {
            "code": "DSH_CHILD_QUOTA",
            "message": "[Service quota exceeded.]",
            "provider_code": "QUOTA",
            "provider_status": 429,
        })
        self.assertEqual(response["result"], {
            "output": [],
            "structured": None,
            "stop_reason": "error",
            "usage": {
                "input_tokens": 0,
                "cached_input_tokens": 0,
                "output_tokens": 0,
                "total_tokens": 0,
            },
            "usage_observed": False,
            "usage_complete": True,
            "thread_id": "dsh-child-route-probe",
            "provider": "deepseek-official",
            "model": "kimi-k2.7-code",
            "model_role": "planner",
            "isolation": "fresh-dsh-subagent",
            "artifacts": [],
        })

    def test_public_host_requires_exact_raw_quota_machine_code_for_known_zero(self) -> None:
        self.prepare_dsh_native_core()
        for mode, raw_code in (
            ("quota-code-leading-space", " QUOTA "),
            ("quota-code-trailing-newline", "QUOTA\n"),
            ("quota-code-lowercase", "quota"),
        ):
            with self.subTest(raw_code=raw_code):
                self.assert_unproven_quota_receipt(mode, provider_code=raw_code)

    def test_public_host_rejects_duplicate_quota_turn_start_as_known_zero(self) -> None:
        self.prepare_dsh_native_core()
        self.assert_unproven_quota_receipt("quota-duplicate-turn-start")

    def test_public_host_rejects_duplicate_quota_step_start_as_known_zero(self) -> None:
        self.prepare_dsh_native_core()
        self.assert_unproven_quota_receipt("quota-duplicate-step-start")

    def test_public_host_rejects_duplicate_quota_turn_end_as_known_zero(self) -> None:
        self.prepare_dsh_native_core()
        self.assert_unproven_quota_receipt("quota-duplicate-turn-end")

    def test_public_host_rejects_quota_without_step_end_as_known_zero(self) -> None:
        self.prepare_dsh_native_core()
        self.assert_unproven_quota_receipt("quota-missing-step-end")

    def test_public_host_rejects_quota_terminal_before_finish_as_known_zero(self) -> None:
        self.prepare_dsh_native_core()
        self.assert_unproven_quota_receipt("quota-terminal-before-finish")

    def test_public_host_rejects_quota_with_other_coordinate_content_as_known_zero(self) -> None:
        self.prepare_dsh_native_core()
        self.assert_unproven_quota_receipt("quota-other-coordinate-content")

    def test_public_host_rejects_mismatched_quota_failure_facts_as_known_zero(self) -> None:
        self.prepare_dsh_native_core()
        self.assert_unproven_quota_receipt("quota-mismatched-failure")

    def test_public_host_rejects_quota_retry_marker_as_known_zero(self) -> None:
        self.prepare_dsh_native_core()
        self.assert_unproven_quota_receipt("quota-retry-marker")

    def test_public_host_rejects_nonfresh_quota_coordinates_as_known_zero(self) -> None:
        self.prepare_dsh_native_core()
        self.assert_unproven_quota_receipt("quota-nonfresh-coordinates")

    def test_public_host_rejects_quota_tool_result_as_known_zero(self) -> None:
        self.prepare_dsh_native_core()
        self.assert_unproven_quota_receipt("quota-tool-result")

    def test_public_host_rejects_post_terminal_execution_as_known_zero(self) -> None:
        self.prepare_dsh_native_core()
        self.assert_unproven_quota_receipt("quota-post-terminal-execution")

    def test_public_host_accepts_the_exported_real_quota_lifecycle_replay(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_dsh_failure_contract("quota-exported-replay")

        result = self.invoke_dsh_native(contract, child_mode="quota-exported-replay")

        self.assertTrue(result["ok"], result.get("error"))
        response = result["value"]["dsh_response"]
        self.assertEqual(response["error"]["code"], "DSH_CHILD_QUOTA")
        self.assertFalse(response["result"]["usage_observed"])
        self.assertTrue(response["result"]["usage_complete"])

    def test_public_host_keeps_usage_chunk_when_child_fails_after_metering(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_dsh_failure_contract("failure-after-usage")

        result = self.invoke_dsh_native(contract, child_mode="usage-chunk-failure")

        self.assertTrue(result["ok"], result.get("error"))
        response = result["value"]["dsh_response"]
        self.assertEqual(response["error"]["code"], "DSH_CHILD_TERMINAL_ERROR")
        self.assertEqual(response["error"]["provider_code"], "SERVER")
        self.assertEqual(response["error"]["provider_status"], 503)
        self.assertEqual(response["result"]["usage"], {
            "input_tokens": 9,
            "cached_input_tokens": 0,
            "output_tokens": 1,
            "total_tokens": 10,
        })
        self.assertTrue(response["result"]["usage_observed"])
        self.assertTrue(response["result"]["usage_complete"])

    def test_public_host_reports_strict_terminal_step_quota_after_metered_progress(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_dsh_failure_contract("terminal-step-quota-after-metered-progress")

        result = self.invoke_dsh_native(
            contract,
            child_mode="terminal-step-quota-after-metered-progress",
        )

        self.assertTrue(result["ok"], result.get("error"))
        response = result["value"]["dsh_response"]
        self.assertEqual(response["error"], {
            "code": "DSH_CHILD_QUOTA",
            "message": "[Service quota exceeded.]",
            "provider_code": "QUOTA",
            "provider_status": 429,
        })
        self.assertEqual(response["result"]["usage"], {
            "input_tokens": 60,
            "cached_input_tokens": 10,
            "output_tokens": 6,
            "total_tokens": 76,
        })
        self.assertEqual(response["result"]["output"], [])
        self.assertIsNone(response["result"]["structured"])
        self.assertTrue(response["result"]["usage_observed"])
        self.assertTrue(response["result"]["usage_complete"])

    def test_public_host_requires_exact_terminal_step_quota_code_and_status(self) -> None:
        self.prepare_dsh_native_core()
        for mode, provider_code, provider_status in (
            ("terminal-step-quota-code-lowercase", "quota", 429),
            ("terminal-step-quota-status-drift", "QUOTA", 430),
        ):
            with self.subTest(mode=mode):
                self.assert_terminal_step_quota_is_incomplete(
                    mode,
                    provider_code=provider_code,
                    provider_status=provider_status,
                )

    def test_public_host_requires_closed_unique_terminal_step_quota_lifecycle(self) -> None:
        self.prepare_dsh_native_core()
        for mode in (
            "terminal-step-quota-missing-step-end",
            "terminal-step-quota-duplicate-step-start",
            "terminal-step-quota-drifted-step-end",
        ):
            with self.subTest(mode=mode):
                self.assert_terminal_step_quota_is_incomplete(mode)

    def test_public_host_rejects_terminal_step_quota_after_output(self) -> None:
        self.prepare_dsh_native_core()
        self.assert_terminal_step_quota_is_incomplete("terminal-step-quota-after-output")

    def test_public_host_rejects_terminal_step_quota_with_mismatched_result_output(self) -> None:
        self.prepare_dsh_native_core()
        response = self.assert_terminal_step_quota_is_incomplete(
            "terminal-step-quota-with-mismatched-result-output",
        )
        self.assertEqual(response["result"]["output"], [{
            "type": "text",
            "text": "partial output",
        }])

    def test_public_host_rejects_terminal_step_quota_after_tool_activity(self) -> None:
        self.prepare_dsh_native_core()
        self.assert_terminal_step_quota_is_incomplete("terminal-step-quota-after-tool")

    def test_public_host_rejects_terminal_step_quota_after_retry(self) -> None:
        self.prepare_dsh_native_core()
        self.assert_terminal_step_quota_is_incomplete("terminal-step-quota-after-retry")

    def test_public_host_rejects_terminal_step_quota_from_retry_turn(self) -> None:
        self.prepare_dsh_native_core()
        self.assert_terminal_step_quota_is_incomplete("terminal-step-quota-retry-turn")

    def test_public_host_rejects_terminal_step_quota_after_prior_step_retry(self) -> None:
        self.prepare_dsh_native_core()
        self.assert_terminal_step_quota_is_incomplete("terminal-step-quota-prior-retry")

    def test_public_host_requires_matching_terminal_step_quota_failures(self) -> None:
        self.prepare_dsh_native_core()
        self.assert_terminal_step_quota_is_incomplete(
            "terminal-step-quota-mismatched-failure",
        )

    def test_public_host_rejects_terminal_step_quota_after_usage(self) -> None:
        self.prepare_dsh_native_core()
        self.assert_terminal_step_quota_is_incomplete(
            "terminal-step-quota-after-usage",
            expected_usage={
                "input_tokens": 67,
                "cached_input_tokens": 10,
                "output_tokens": 7,
                "total_tokens": 84,
            },
        )

    def test_public_host_requires_every_prior_step_to_be_metered(self) -> None:
        self.prepare_dsh_native_core()
        self.assert_terminal_step_quota_is_incomplete(
            "terminal-step-quota-prior-usage-missing",
            expected_usage={
                "input_tokens": 40,
                "cached_input_tokens": 7,
                "output_tokens": 4,
                "total_tokens": 51,
            },
        )

    def test_public_host_requires_positive_prior_usage_for_terminal_step_quota(self) -> None:
        self.prepare_dsh_native_core()
        self.assert_terminal_step_quota_is_incomplete(
            "terminal-step-quota-zero-metered-progress",
            expected_usage={
                "input_tokens": 0,
                "cached_input_tokens": 0,
                "output_tokens": 0,
                "total_tokens": 0,
            },
            expected_usage_observed=False,
        )

    def test_public_host_requires_prior_canonical_assistant_output_for_terminal_quota(self) -> None:
        self.prepare_dsh_native_core()
        response = self.assert_terminal_step_quota_is_incomplete(
            "terminal-step-quota-without-prior-assistant",
        )
        self.assertEqual(response["result"]["output"], [])

    def test_public_host_does_not_claim_known_zero_quota_after_content(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_dsh_failure_contract("quota-after-content")

        result = self.invoke_dsh_native(contract, child_mode="quota-after-content")

        self.assertTrue(result["ok"], result.get("error"))
        response = result["value"]["dsh_response"]
        self.assertEqual(response["error"]["code"], "DSH_CHILD_TERMINAL_ERROR")
        self.assertEqual(response["error"]["provider_code"], "QUOTA")
        self.assertEqual(response["error"]["provider_status"], 429)
        self.assertFalse(response["result"]["usage_observed"])
        self.assertFalse(response["result"]["usage_complete"])

    def test_public_host_marks_unknown_unmetered_failure_usage_incomplete(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_dsh_failure_contract("unknown-before-usage")

        result = self.invoke_dsh_native(contract, child_mode="unknown-failure")

        self.assertTrue(result["ok"], result.get("error"))
        response = result["value"]["dsh_response"]
        self.assertEqual(response["error"]["code"], "DSH_CHILD_TERMINAL_ERROR")
        self.assertEqual(response["error"]["provider_code"], "UNKNOWN")
        self.assertEqual(response["result"]["usage"], {
            "input_tokens": 0,
            "cached_input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
        })
        self.assertFalse(response["result"]["usage_observed"])
        self.assertFalse(response["result"]["usage_complete"])

    def test_public_host_folds_chunk_and_message_usage_last_wins_per_step(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_dsh_failure_contract("multi-step-metering")

        result = self.invoke_dsh_native(contract, child_mode="multi-step-failure")

        self.assertTrue(result["ok"], result.get("error"))
        receipt = result["value"]["dsh_response"]["result"]
        self.assertEqual(receipt["usage"], {
            "input_tokens": 9,
            "cached_input_tokens": 2,
            "output_tokens": 6,
            "total_tokens": 17,
        })
        self.assertTrue(receipt["usage_observed"])
        self.assertTrue(receipt["usage_complete"])

    def test_public_host_marks_metered_failure_with_missing_step_end_incomplete(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_dsh_failure_contract("usage-missing-step-end")

        result = self.invoke_dsh_native(contract, child_mode="usage-missing-step-end")

        self.assertTrue(result["ok"], result.get("error"))
        response = result["value"]["dsh_response"]
        self.assertEqual(response["error"]["code"], "DSH_CHILD_TERMINAL_ERROR")
        self.assertEqual(response["result"]["usage"], {
            "input_tokens": 9,
            "cached_input_tokens": 0,
            "output_tokens": 1,
            "total_tokens": 10,
        })
        self.assertTrue(response["result"]["usage_observed"])
        self.assertFalse(response["result"]["usage_complete"])

    def test_public_host_marks_duplicate_same_coordinate_step_usage_incomplete(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_dsh_failure_contract("duplicate-step-usage")

        result = self.invoke_dsh_native(contract, child_mode="duplicate-step-usage")

        self.assertTrue(result["ok"], result.get("error"))
        response = result["value"]["dsh_response"]
        self.assertEqual(response["error"]["code"], "DSH_CHILD_TERMINAL_ERROR")
        self.assertEqual(response["result"]["usage"], {
            "input_tokens": 1,
            "cached_input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 1,
        })
        self.assertTrue(response["result"]["usage_observed"])
        self.assertFalse(response["result"]["usage_complete"])

    def test_public_host_requires_strict_unique_monotonic_event_sequences(self) -> None:
        self.prepare_dsh_native_core()
        for mode in (
            "malformed-seq",
            "nonmonotonic-seq",
            "duplicate-seq",
            "gap-seq",
        ):
            with self.subTest(mode=mode):
                contract = self.write_dsh_failure_contract(mode)
                result = self.invoke_dsh_native(contract, child_mode=mode)

                self.assertTrue(result["ok"], result.get("error"))
                response = result["value"]["dsh_response"]
                self.assertEqual(response["error"]["code"], "DSH_CHILD_USAGE_INCOMPLETE")
                self.assertTrue(response["result"]["usage_observed"])
                self.assertFalse(response["result"]["usage_complete"])

    def test_public_host_maps_durable_terminal_stop_reasons(self) -> None:
        self.prepare_dsh_native_core()
        for mode, stop_reason in (
            ("blocked", "refusal"),
            ("aborted", "aborted"),
            ("interrupted", "error"),
        ):
            with self.subTest(mode=mode):
                contract = self.write_dsh_failure_contract(f"terminal-{mode}")
                result = self.invoke_dsh_native(contract, child_mode=mode)

                self.assertTrue(result["ok"], result.get("error"))
                response = result["value"]["dsh_response"]
                self.assertEqual(response["error"]["code"], "DSH_CHILD_TERMINAL_ERROR")
                self.assertEqual(response["result"]["stop_reason"], stop_reason)
                self.assertFalse(response["result"]["usage_complete"])

    def test_public_host_rejects_unknown_activation_phase_before_child_start(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "unknown-phase"),
            runtime="dsh",
            activation_phase="Review revision 1",
            activation_label="review_1",
            mission={
                "mission_id": "unknown-phase",
                "goal": "inspect safely",
                "authority": ["read workspace"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{"name": "inspect", "side_effect": "read"}],
        )

        result = self.invoke_dsh_native(contract)

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn("activation phase", result["value"]["error"])
        self.assertEqual(result["telemetry"]["starts"], [])

    def test_public_host_rejects_caller_supplied_model_role(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "forged-role"),
            runtime="dsh",
            activation_phase="Execute revision 1",
            activation_label="route_probe_1",
            activation_model_role="planner",
            mission={
                "mission_id": "forged-role",
                "goal": "inspect safely",
                "authority": ["read workspace"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{"name": "inspect", "side_effect": "read"}],
        )

        result = self.invoke_dsh_native(contract)

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn("model_role is Host-derived", result["value"]["error"])
        self.assertEqual(result["telemetry"]["starts"], [])

    def test_public_host_rejects_non_string_activation_phase(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "malformed-phase"),
            runtime="dsh",
            activation_phase=["Plan revision 1"],
            activation_label="plan-revision-1-attempt-1",
            mission={
                "mission_id": "malformed-phase",
                "goal": "inspect safely",
                "authority": ["read workspace"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{"name": "inspect", "side_effect": "read"}],
        )

        result = self.invoke_dsh_native(contract)

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn("activation phase", result["value"]["error"])
        self.assertEqual(result["telemetry"]["starts"], [])

    def test_public_host_keeps_planner_role_on_later_planner_attempt(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "planner-retry"),
            runtime="dsh",
            activation_phase="Plan revision 3",
            activation_label="plan-revision-3-attempt-2",
            mission={
                "mission_id": "planner-retry",
                "goal": "inspect safely",
                "authority": ["read workspace"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 3,
            },
            capabilities=[{"name": "inspect", "side_effect": "read"}],
        )

        result = self.invoke_dsh_native(contract)

        self.assertTrue(result["ok"], result.get("error"))
        receipt = result["value"]["dsh_result"]
        self.assertEqual(receipt["model_role"], "planner")
        self.assertEqual(receipt["provider"], "deepseek-official")
        self.assertEqual(receipt["model"], "kimi-k2.7-code")

    def test_cancellation_aborts_and_disposes_the_dsh_child(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "cancel"),
            runtime="dsh",
            mission={
                "mission_id": "cancel",
                "goal": "wait safely",
                "authority": ["read workspace"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{"name": "inspect", "side_effect": "read"}],
        )

        started = time.monotonic()
        result = self.invoke_dsh_native(
            contract,
            abort_after_ms=1_000,
            child_mode="wait",
        )

        self.assertFalse(result["ok"])
        self.assertIn("test DSH cancellation", result["error"])
        self.assertEqual(result["telemetry"]["child_abort_count"], 1)
        self.assertEqual(result["telemetry"]["dispose_count"], 1)
        self.assertEqual(result["telemetry"].get("conclude_count", 0), 0)
        self.assertLess(time.monotonic() - started, 4)

    def test_public_tool_rejects_dsh_write_without_transaction_artifact(self) -> None:
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "write"),
            runtime="dsh",
            mission={
                "mission_id": "write",
                "goal": "mutate",
                "authority": ["write workspace"],
                "required_artifacts": ["candidate.py"],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{
                "name": "mutate",
                "side_effect": "write",
                "transaction_artifacts": [],
            }],
        )

        result = self.invoke_dsh_native(contract)

        self.assertTrue(result["ok"])
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn(
            "write capability must declare",
            result["value"]["error"],
        )
        self.assertEqual(result["telemetry"]["conclude_count"], 1)
        self.assertEqual(result["telemetry"]["starts"], [])

    def test_public_host_allows_only_declared_dsh_transaction_artifact_tools(self) -> None:
        self.prepare_dsh_native_core()
        candidate = self.workspace / "candidate.py"
        candidate.write_text("baseline = True\n", encoding="utf-8")
        undeclared = self.workspace / "undeclared.py"
        undeclared.write_text("protected = True\n", encoding="utf-8")
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "write-transaction"),
            runtime="dsh",
            activation_phase="Execute revision 1",
            activation_label="mutate_candidate",
            activation_options={
                "transaction": {
                    "artifacts": [candidate.name],
                    "rollback_on_noncompleted_status": True,
                },
            },
            mission={
                "mission_id": "write-transaction",
                "goal": "mutate one declared candidate",
                "authority": ["write candidate.py"],
                "required_artifacts": ["candidate_source"],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{
                "name": "mutate",
                "side_effect": "write",
                "transaction_artifacts": [candidate.name],
            }],
        )

        result = self.invoke_dsh_native(
            contract,
            transaction_artifact=candidate,
            undeclared_artifact=undeclared,
            transaction_alias=f"{self.workspace}/./{candidate.name}",
        )

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "completed", result)
        self.assertEqual(len(result["telemetry"]["starts"]), 1)
        self.assertEqual(
            result["telemetry"]["starts"][0]["tool_filter"],
            {"allow": ["read", "glob", "grep", "edit", "write"]},
        )
        for allowed in ("read", "structured_output", "edit", "write"):
            self.assertIsNone(result["telemetry"]["guards"][allowed])
        for broad_search in ("glob", "grep"):
            self.assertIn("workspace root", result["telemetry"]["guards"][broad_search])
            self.assertIn(
                "workspace-root search is unavailable",
                result["telemetry"]["scoped_tool_descriptions"][broad_search],
            )
        for control in ("read_control", "glob_control", "grep_control"):
            self.assertIn("runtime-control", result["telemetry"]["guards"][control])
        for forbidden in ("edit_undeclared", "write_undeclared", "edit_alias", "write_alias"):
            self.assertIn("declared transaction artifact", result["telemetry"]["guards"][forbidden])
        for mutation in ("edit", "write"):
            self.assertIn(
                candidate.name,
                result["telemetry"]["scoped_tool_descriptions"][mutation],
            )
            self.assertIn(
                "Helper, test, and scratch files are not exposed",
                result["telemetry"]["scoped_tool_descriptions"][mutation],
            )
        self.assertEqual(candidate.read_text(encoding="utf-8"), "baseline = True\n")
        self.assertEqual(undeclared.read_text(encoding="utf-8"), "protected = True\n")

    def test_public_host_keeps_a_proven_unexecuted_mutation_nonterminal(
        self,
    ) -> None:
        self.prepare_dsh_native_core()
        candidate = self.workspace / "candidate.py"
        candidate.write_text("baseline = True\n", encoding="utf-8")
        denied = self.workspace / "SECRET_DENIED_HELPER_PATH.py"
        contract = self.write_transaction_probe_contract(
            candidate,
            "denied-mutation-receipt",
            capture_error=True,
        )

        result = self.invoke_dsh_native(
            contract,
            child_mode="denied-mutation",
            transaction_artifact=candidate,
            undeclared_artifact=denied,
        )

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "completed", result)
        receipt = result["value"]["dsh_result"]
        self.assertEqual(
            receipt["output"],
            [{"type": "text", "text": "DSH route probe completed"}],
        )
        self.assertEqual(receipt["structured"], {"observed": True})
        self.assertEqual(receipt["stop_reason"], "completed")
        self.assertTrue(receipt["usage_observed"])
        self.assertTrue(receipt["usage_complete"])
        self.assertEqual(receipt["artifacts"], [])
        self.assertIn("declared transaction artifact", result["telemetry"]["no_call_id_guard_result"])
        self.assertIn("declared transaction artifact", result["telemetry"]["actual_guard_result"])
        self.assertIn("declared transaction artifact", result["telemetry"]["second_guard_result"])
        self.assertNotIn(str(denied), json.dumps(result))
        self.assertFalse(denied.exists())

    def test_public_host_requires_durable_error_result_for_denied_mutation_receipt(
        self,
    ) -> None:
        self.prepare_dsh_native_core()
        candidate = self.workspace / "candidate.py"
        candidate.write_text("baseline = True\n", encoding="utf-8")
        denied = self.workspace / "helper.py"
        for child_mode in (
            "denied-mutation-missing-result",
            "denied-mutation-nonerror-result",
        ):
            with self.subTest(child_mode=child_mode):
                contract = self.write_transaction_probe_contract(
                    candidate,
                    child_mode,
                    capture_error=True,
                )
                result = self.invoke_dsh_native(
                    contract,
                    child_mode=child_mode,
                    transaction_artifact=candidate,
                    undeclared_artifact=denied,
                )

                self.assertTrue(result["ok"], result.get("error"))
                response = result["value"]["dsh_response"]
                self.assertFalse(response["ok"])
                self.assertEqual(response["error"]["code"], "DSH_CHILD_EVIDENCE_INVALID")
                self.assertNotEqual(response["error"]["code"], "DSH_MUTATION_PERMISSION_DENIED")
                self.assertEqual(response["result"]["artifacts"], [])

    def test_public_host_requires_complete_usage_before_denied_mutation_receipt(
        self,
    ) -> None:
        self.prepare_dsh_native_core()
        candidate = self.workspace / "candidate.py"
        candidate.write_text("baseline = True\n", encoding="utf-8")
        denied = self.workspace / "helper.py"
        contract = self.write_transaction_probe_contract(
            candidate,
            "denied-mutation-usage-incomplete",
            capture_error=True,
        )

        result = self.invoke_dsh_native(
            contract,
            child_mode="denied-mutation-usage-incomplete",
            transaction_artifact=candidate,
            undeclared_artifact=denied,
        )

        self.assertTrue(result["ok"], result.get("error"))
        response = result["value"]["dsh_response"]
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"], {
            "code": "DSH_CHILD_USAGE_INCOMPLETE",
            "message": "DSH child did not publish complete observed token usage",
        })
        self.assertNotEqual(response["error"]["code"], "DSH_MUTATION_PERMISSION_DENIED")
        self.assertEqual(response["result"]["output"], [])
        self.assertIsNone(response["result"]["structured"])
        self.assertEqual(response["result"]["stop_reason"], "completed")
        self.assertFalse(response["result"]["usage_complete"])
        self.assertEqual(response["result"]["artifacts"], [])

    def test_public_host_attests_denied_mutation_after_one_unmetered_retry(self) -> None:
        self.prepare_dsh_native_core()
        candidate = self.workspace / "candidate.py"
        candidate.write_text("baseline = True\n", encoding="utf-8")
        denied = self.workspace / "helper.py"
        contract = self.write_transaction_probe_contract(
            candidate,
            "denied-mutation-unmetered-retry",
            capture_error=True,
        )
        calls = [
            {"session_id": "child", "chunks": [{
                "type": "finish",
                "reason": {"kind": "error", "failure": {
                    "message": "DeepSeek stream idle timeout after 300000ms",
                    "code": "TIMEOUT",
                }},
            }]},
            {"session_id": "child", "chunks": [
                {"type": "usage", "usage": {
                    "inputTokens": 11,
                    "cacheReadTokens": 3,
                    "cacheWriteTokens": 2,
                    "outputTokens": 7,
                }},
                {"type": "finish", "reason": {"kind": "stop"}},
            ]},
        ]

        result = self.invoke_dsh_native(
            contract,
            child_mode="denied-mutation-unmetered-retry",
            transaction_artifact=candidate,
            undeclared_artifact=denied,
            llm_calls=calls,
        )

        self.assertTrue(result["ok"], result.get("error"))
        response = result["value"]["dsh_response"]
        self.assertEqual(response["error"]["code"], "DSH_CHILD_USAGE_INCOMPLETE")
        self.assertEqual(response["result"]["budget_charge_tokens"], 123)
        self.assertEqual(response["result"]["metered_attempt_tokens"], 23)
        self.assertEqual(response["result"]["unmetered_reservation_tokens"], 100)
        self.assertEqual(response["result"]["unmetered_attempts"], 1)
        self.assertEqual(
            response["result"]["budget_charge_basis"],
            "dsh-host-attested-actual-or-registration-context-reservation-v1",
        )

    def test_public_host_keeps_denied_reads_and_ordinary_tool_errors_nonterminal(
        self,
    ) -> None:
        self.prepare_dsh_native_core()
        candidate = self.workspace / "candidate.py"
        candidate.write_text("baseline = True\n", encoding="utf-8")
        for child_mode in ("denied-read", "denied-glob", "allowed-edit-error"):
            with self.subTest(child_mode=child_mode):
                contract = self.write_transaction_probe_contract(
                    candidate,
                    f"nonterminal-{child_mode}",
                )
                result = self.invoke_dsh_native(
                    contract,
                    child_mode=child_mode,
                    transaction_artifact=candidate,
                )

                self.assertTrue(result["ok"], result.get("error"))
                self.assertEqual(result["value"]["status"], "completed", result)
                self.assertEqual(result["value"]["dsh_result"]["artifacts"], [])
                if child_mode == "allowed-edit-error":
                    self.assertIsNone(result["telemetry"]["actual_guard_result"])
                else:
                    self.assertIsInstance(result["telemetry"]["actual_guard_result"], str)

    def test_public_host_rechecks_the_actual_write_path_after_cwd_alias_drift(self) -> None:
        self.prepare_dsh_native_core()
        candidate = self.workspace / "candidate.py"
        candidate.write_text("baseline = True\n", encoding="utf-8")
        workspace_alias = self.root / "workspace-alias"
        workspace_alias.symlink_to(self.workspace, target_is_directory=True)
        alternate = self.root / "alternate-workspace"
        alternate.mkdir()
        alternate_candidate = alternate / candidate.name
        alternate_candidate.write_text("must stay unchanged\n", encoding="utf-8")
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "cwd-alias-drift"),
            runtime="dsh",
            activation_phase="Execute revision 1",
            activation_label="mutate_candidate",
            activation_options={"transaction": {
                "artifacts": [candidate.name],
                "rollback_on_noncompleted_status": True,
            }},
            mission={
                "mission_id": "cwd-alias-drift",
                "goal": "reject a changed child cwd alias",
                "authority": ["write candidate"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{
                "name": "mutate",
                "side_effect": "write",
                "transaction_artifacts": [candidate.name],
            }],
        )

        result = self.invoke_dsh_native(
            contract,
            transaction_artifact=workspace_alias / candidate.name,
            cwd=workspace_alias,
            swap_workspace_to=alternate,
        )

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "completed", result)
        for tool in ("edit", "write"):
            self.assertIn("identity is unsafe", result["telemetry"]["guards"][tool])
        self.assertEqual(candidate.read_text(encoding="utf-8"), "baseline = True\n")
        self.assertEqual(
            alternate_candidate.read_text(encoding="utf-8"),
            "must stay unchanged\n",
        )

    def test_public_host_rejects_transaction_on_planner_activation(self) -> None:
        self.prepare_dsh_native_core()
        candidate = self.workspace / "candidate.py"
        candidate.write_text("baseline = True\n", encoding="utf-8")
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "planner-transaction"),
            runtime="dsh",
            activation_phase="Plan revision 1",
            activation_label="plan-revision-1-attempt-1",
            activation_options={
                "transaction": {
                    "artifacts": [candidate.name],
                    "rollback_on_noncompleted_status": True,
                },
            },
            mission={
                "mission_id": "planner-transaction",
                "goal": "reject planner mutation",
                "authority": ["write candidate.py"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{
                "name": "mutate",
                "side_effect": "write",
                "transaction_artifacts": [candidate.name],
            }],
        )

        result = self.invoke_dsh_native(contract)

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn("Execute revision worker", result["value"]["error"])
        self.assertEqual(result["telemetry"]["starts"], [])
        self.assertEqual(candidate.read_text(encoding="utf-8"), "baseline = True\n")

    def test_public_host_rejects_symlink_transaction_artifact_before_child_start(self) -> None:
        self.prepare_dsh_native_core()
        candidate = self.workspace / "candidate.py"
        candidate.symlink_to(self.outside_secret)
        original = self.outside_secret.read_bytes()
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "symlink-transaction"),
            runtime="dsh",
            activation_phase="Execute revision 1",
            activation_label="mutate_candidate",
            activation_options={"transaction": {
                "artifacts": [candidate.name],
                "rollback_on_noncompleted_status": True,
            }},
            mission={
                "mission_id": "symlink-transaction",
                "goal": "reject aliased mutation",
                "authority": ["write candidate.py"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{
                "name": "mutate",
                "side_effect": "write",
                "transaction_artifacts": [candidate.name],
            }],
        )

        result = self.invoke_dsh_native(contract)

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn("regular single-link file", result["value"]["error"])
        self.assertEqual(result["telemetry"]["starts"], [])
        self.assertEqual(self.outside_secret.read_bytes(), original)

    def test_public_host_rejects_hardlink_transaction_artifact_before_child_start(self) -> None:
        self.prepare_dsh_native_core()
        candidate = self.workspace / "candidate.py"
        os.link(self.outside_secret, candidate)
        original = self.outside_secret.read_bytes()
        original_mode = stat.S_IMODE(self.outside_secret.stat().st_mode)
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "hardlink-transaction"),
            runtime="dsh",
            activation_phase="Execute revision 1",
            activation_label="mutate_candidate",
            activation_options={"transaction": {
                "artifacts": [candidate.name],
                "rollback_on_noncompleted_status": True,
            }},
            mission={
                "mission_id": "hardlink-transaction",
                "goal": "reject shared-inode mutation",
                "authority": ["write candidate.py"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{
                "name": "mutate",
                "side_effect": "write",
                "transaction_artifacts": [candidate.name],
            }],
        )

        result = self.invoke_dsh_native(contract)

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn("regular single-link file", result["value"]["error"])
        self.assertEqual(result["telemetry"]["starts"], [])
        self.assertEqual(self.outside_secret.read_bytes(), original)
        self.assertEqual(stat.S_IMODE(self.outside_secret.stat().st_mode), original_mode)

    def test_public_host_accepts_bound_candidate_evaluator_transaction(self) -> None:
        self.prepare_dsh_native_core()
        candidate = self.workspace / "candidate.py"
        candidate.write_text("baseline = True\n", encoding="utf-8")
        immutable_input = self.workspace / "inputs.json"
        immutable_input.write_text("{}\n", encoding="utf-8")
        evaluator_request = {
            "protocol": "command-v1",
            "argv": ["python3", "-B", "verify.py"],
            "cwd": ".",
            "artifacts": [candidate.name, immutable_input.name],
            "filesystem_policy": "read-only",
            "network_policy": "denied",
            "output_policy": "sealed",
            "timeout_seconds": 5,
        }
        fact_projections = [{
            "output_name": "verified",
            "result_path": "passed",
        }]
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "candidate-gate"),
            runtime="dsh",
            activation_phase="Execute revision 1",
            activation_label="mutate_candidate",
            activation_options={
                "transaction": {
                    "artifacts": [candidate.name],
                    "rollback_on_noncompleted_status": True,
                    "candidate_gate": {
                        "verifier": "verify_candidate",
                        "request": evaluator_request,
                        "result_artifact": "measurement",
                        "fact_projections": fact_projections,
                    },
                },
            },
            mission={
                "mission_id": "candidate-gate",
                "goal": "mutate and verify one candidate",
                "authority": ["write candidate.py", "run registered verifier"],
                "required_artifacts": ["candidate_summary", "measurement"],
                "required_facts": {"verified": True},
                "max_revisions": 1,
            },
            capabilities=[
                {
                    "name": "mutate",
                    "side_effect": "write",
                    "transaction_artifacts": [candidate.name],
                    "candidate_verifier": "verify_candidate",
                    "produces_artifacts": ["candidate_summary"],
                    "produces_facts": [],
                },
                {
                    "name": "repair",
                    "side_effect": "write",
                    "transaction_artifacts": [candidate.name],
                    "candidate_verifier": "verify_candidate",
                    "produces_artifacts": ["repair_summary"],
                    "produces_facts": [],
                },
                {
                    "name": "verify_candidate",
                    "side_effect": "read",
                    "produces_artifacts": ["measurement"],
                    "produces_facts": ["verified"],
                    "execution": {
                        "kind": "host_evaluator",
                        "retryable": False,
                        "request": evaluator_request,
                        "fact_projections": fact_projections,
                    },
                },
            ],
        )

        result = self.invoke_dsh_native(contract, transaction_artifact=candidate)

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "completed", result)
        self.assertEqual(len(result["telemetry"]["starts"]), 1)
        self.assertEqual(
            result["telemetry"]["starts"][0]["tool_filter"],
            {"allow": ["read", "glob", "grep", "edit", "write"]},
        )

    def test_public_host_rejects_candidate_gate_drift_before_child_start(self) -> None:
        self.prepare_dsh_native_core()
        candidate = self.workspace / "candidate.py"
        candidate.write_text("baseline = True\n", encoding="utf-8")
        evaluator_request = {
            "protocol": "command-v1",
            "argv": ["python3", "-B", "verify.py"],
            "cwd": ".",
            "artifacts": [candidate.name],
            "filesystem_policy": "read-only",
            "network_policy": "denied",
            "output_policy": "sealed",
            "timeout_seconds": 5,
        }
        fact_projections = [{"output_name": "verified", "result_path": "passed"}]
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "candidate-gate-drift"),
            runtime="dsh",
            activation_phase="Execute revision 1",
            activation_label="mutate_candidate",
            activation_options={
                "transaction": {
                    "artifacts": [candidate.name],
                    "rollback_on_noncompleted_status": True,
                    "candidate_gate": {
                        "verifier": "verify_candidate",
                        "request": {**evaluator_request, "argv": ["/bin/cat", "/etc/passwd"]},
                        "result_artifact": "measurement",
                        "fact_projections": fact_projections,
                    },
                },
            },
            mission={
                "mission_id": "candidate-gate-drift",
                "goal": "reject activation drift",
                "authority": ["write candidate.py", "run registered verifier"],
                "required_artifacts": ["candidate_summary", "measurement"],
                "required_facts": {"verified": True},
                "max_revisions": 1,
            },
            capabilities=[
                {
                    "name": "mutate",
                    "side_effect": "write",
                    "transaction_artifacts": [candidate.name],
                    "candidate_verifier": "verify_candidate",
                    "produces_artifacts": ["candidate_summary"],
                    "produces_facts": [],
                },
                {
                    "name": "verify_candidate",
                    "side_effect": "read",
                    "produces_artifacts": ["measurement"],
                    "produces_facts": ["verified"],
                    "execution": {
                        "kind": "host_evaluator",
                        "retryable": False,
                        "request": evaluator_request,
                        "fact_projections": fact_projections,
                    },
                },
            ],
        )

        result = self.invoke_dsh_native(contract, transaction_artifact=candidate)

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn("candidate gate does not match", result["value"]["error"])
        self.assertEqual(result["telemetry"]["starts"], [])
        self.assertEqual(candidate.read_text(encoding="utf-8"), "baseline = True\n")

    def test_public_host_rejects_transaction_rollback_policy_drift(self) -> None:
        self.prepare_dsh_native_core()
        candidate = self.workspace / "candidate.py"
        candidate.write_text("baseline = True\n", encoding="utf-8")
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "rollback-drift"),
            runtime="dsh",
            activation_phase="Execute revision 1",
            activation_label="mutate_candidate",
            activation_options={
                "transaction": {
                    "artifacts": [candidate.name],
                    "rollback_on_noncompleted_status": False,
                },
            },
            mission={
                "mission_id": "rollback-drift",
                "goal": "reject rollback policy drift",
                "authority": ["write candidate"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{
                "name": "mutate",
                "required_authorities": ["write candidate"],
                "side_effect": "write",
                "transaction_artifacts": [candidate.name],
            }],
        )

        result = self.invoke_dsh_native(contract, transaction_artifact=candidate)

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn("rollback policy", result["value"]["error"])
        self.assertEqual(result["telemetry"]["starts"], [])
        self.assertEqual(candidate.read_text(encoding="utf-8"), "baseline = True\n")

    def test_public_host_rejects_unadmitted_transaction_capability(self) -> None:
        self.prepare_dsh_native_core()
        candidate = self.workspace / "candidate.py"
        candidate.write_text("baseline = True\n", encoding="utf-8")
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "authority-drift"),
            runtime="dsh",
            activation_phase="Execute revision 1",
            activation_label="mutate_candidate",
            activation_options={
                "transaction": {
                    "artifacts": [candidate.name],
                    "rollback_on_noncompleted_status": True,
                },
            },
            mission={
                "mission_id": "authority-drift",
                "goal": "reject unadmitted mutation",
                "authority": ["read workspace"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[
                {
                    "name": "inspect",
                    "required_authorities": ["read workspace"],
                    "side_effect": "read",
                },
                {
                    "name": "mutate",
                    "required_authorities": ["write candidate"],
                    "side_effect": "write",
                    "transaction_artifacts": [candidate.name],
                },
            ],
        )

        result = self.invoke_dsh_native(contract, transaction_artifact=candidate)

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn("does not match one Mission capability", result["value"]["error"])
        self.assertEqual(result["telemetry"]["starts"], [])
        self.assertEqual(candidate.read_text(encoding="utf-8"), "baseline = True\n")

    def test_public_host_rejects_runtime_control_transaction_artifact(self) -> None:
        self.prepare_dsh_native_core()
        control = self.workspace / ".kersor-autonomous" / "control.json"
        control.parent.mkdir()
        control.write_text("{}\n", encoding="utf-8")
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "control-session"),
            runtime="dsh",
            activation_phase="Execute revision 1",
            activation_label="mutate_control",
            activation_options={"transaction": {
                "artifacts": [".kersor-autonomous/control.json"],
                "rollback_on_noncompleted_status": True,
            }},
            mission={
                "mission_id": "runtime-control-transaction",
                "goal": "reject runtime control mutation",
                "authority": ["write runtime control"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{
                "name": "mutate",
                "side_effect": "write",
                "transaction_artifacts": [".kersor-autonomous/control.json"],
            }],
        )

        result = self.invoke_dsh_native(contract, transaction_artifact=control)

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn("runtime control", result["value"]["error"])
        self.assertEqual(result["telemetry"]["starts"], [])
        self.assertEqual(control.read_text(encoding="utf-8"), "{}\n")

    def test_public_host_rejects_runtime_config_as_transaction_artifact(self) -> None:
        self.prepare_dsh_native_core()
        runtime_config = self.workspace / "runtime-dsh.json"
        runtime_config.write_bytes(
            (self.core / "config" / "runtime-dsh-autonomous.json").read_bytes()
        )
        original = runtime_config.read_bytes()
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "runtime-config-control"),
            runtime="dsh",
            runtime_config=runtime_config.name,
            activation_phase="Execute revision 1",
            activation_label="mutate_runtime_config",
            activation_options={"transaction": {
                "artifacts": [runtime_config.name],
                "rollback_on_noncompleted_status": True,
            }},
            mission={
                "mission_id": "runtime-config-control",
                "goal": "reject runtime config mutation",
                "authority": ["write runtime config"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{
                "name": "mutate",
                "side_effect": "write",
                "transaction_artifacts": [runtime_config.name],
            }],
        )

        result = self.invoke_dsh_native(contract, transaction_artifact=runtime_config)

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn("runtime config", result["value"]["error"])
        self.assertEqual(result["telemetry"]["starts"], [])
        self.assertEqual(runtime_config.read_bytes(), original)

    def test_public_host_rejects_custom_mission_session_as_transaction_artifact(self) -> None:
        self.prepare_dsh_native_core()
        session = self.workspace / "custom-session"
        session_config = session / "session-config.json"
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(session),
            runtime="dsh",
            activation_phase="Execute revision 1",
            activation_label="mutate_session",
            activation_options={"transaction": {
                "artifacts": ["custom-session/session-config.json"],
                "rollback_on_noncompleted_status": True,
            }},
            mission={
                "mission_id": "custom-session-control",
                "goal": "reject custom Session mutation",
                "authority": ["write Session config"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{
                "name": "mutate",
                "side_effect": "write",
                "transaction_artifacts": ["custom-session/session-config.json"],
            }],
        )

        result = self.invoke_dsh_native(contract, transaction_artifact=session_config)

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn("Mission Session", result["value"]["error"])
        self.assertEqual(result["telemetry"]["starts"], [])
        self.assertTrue(session_config.is_file())

    def test_public_host_rejects_symlinked_custom_session_transaction_alias(self) -> None:
        self.prepare_dsh_native_core()
        session_alias = self.workspace / "custom-link-session"
        real_session = self.workspace / "custom-real-session"
        session_alias.symlink_to(real_session, target_is_directory=True)
        real_session_config = real_session / "session-config.json"
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(session_alias),
            runtime="dsh",
            activation_phase="Execute revision 1",
            activation_label="mutate_session_alias",
            activation_options={"transaction": {
                "artifacts": ["custom-real-session/session-config.json"],
                "rollback_on_noncompleted_status": True,
            }},
            mission={
                "mission_id": "custom-session-alias",
                "goal": "reject Session alias mutation",
                "authority": ["write Session config"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{
                "name": "mutate",
                "side_effect": "write",
                "transaction_artifacts": ["custom-real-session/session-config.json"],
            }],
        )

        result = self.invoke_dsh_native(contract, transaction_artifact=real_session_config)

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn("Session path must not use symlinks", result["value"]["error"])
        self.assertEqual(result["telemetry"]["starts"], [])

    def test_public_host_rejects_mission_contract_as_transaction_artifact(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.workspace / "mission-owned-control.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-mission-v1",
                "workspace": str(self.workspace),
                "session": str(self.workspace / ".kersor-autonomous" / "mission-control"),
                "runtime": "dsh",
                "activation_phase": "Execute revision 1",
                "activation_label": "mutate_contract",
                "activation_options": {
                    "transaction": {
                        "artifacts": [contract.name],
                        "rollback_on_noncompleted_status": True,
                    },
                },
                "mission": {
                    "mission_id": "mission-control-transaction",
                    "goal": "reject Mission mutation",
                    "authority": ["write Mission contract"],
                    "required_artifacts": [],
                    "required_facts": {},
                    "max_revisions": 1,
                },
                "capabilities": [{
                    "name": "mutate",
                    "side_effect": "write",
                    "transaction_artifacts": [contract.name],
                }],
            }),
            encoding="utf-8",
        )
        original = contract.read_bytes()

        result = self.invoke_dsh_native(contract, transaction_artifact=contract)

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn("Mission contract", result["value"]["error"])
        self.assertEqual(result["telemetry"]["starts"], [])
        self.assertEqual(contract.read_bytes(), original)

    def test_core_disconnect_aborts_and_disposes_only_that_dsh_child(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "disconnect"),
            runtime="dsh",
            probe_mode="disconnect",
            mission={
                "mission_id": "disconnect",
                "goal": "disconnect one activation",
                "authority": ["read workspace"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{"name": "inspect", "side_effect": "read"}],
        )

        result = self.invoke_dsh_native(contract, child_mode="wait")

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "failed")
        self.assertEqual(result["telemetry"]["child_abort_count"], 1)
        self.assertLess(result["telemetry"]["child_abort_after_ms"], 800)
        self.assertEqual(result["telemetry"]["dispose_count"], 1)

    def test_connection_limit_counts_concurrency_not_total_activations(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "sequential"),
            runtime="dsh",
            probe_mode="sequential-65",
            mission={
                "mission_id": "sequential",
                "goal": "run bounded sequential reads",
                "authority": ["read workspace"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{"name": "inspect", "side_effect": "read"}],
        )

        result = self.invoke_dsh_native(contract)

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["activation_count"], 65)
        self.assertEqual(len(result["telemetry"]["starts"]), 65)
        self.assertEqual(result["telemetry"]["dispose_count"], 65)

    def test_public_tool_rejects_dsh_host_commands_without_reading_home(self) -> None:
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "host-command"),
            runtime="dsh",
            mission={
                "mission_id": "host-command",
                "goal": "attempt a forbidden Host read",
                "authority": ["read workspace"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{
                "name": "forbidden-host-reader",
                "side_effect": "read",
                "execution": {
                    "kind": "host_evaluator",
                    "request": {
                        "protocol": "command-v1",
                        "argv": ["/bin/cat", str(self.outside_secret)],
                        "filesystem_policy": "read-only",
                        "network_policy": "denied",
                        "output_policy": "sealed",
                        "timeout_seconds": 5,
                    },
                },
            }],
        )

        result = self.invoke_dsh_native(contract)

        self.assertTrue(result["ok"])
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn(
            "Host evaluator has an invalid bounded output contract",
            result["value"]["error"],
        )
        self.assertEqual(result["telemetry"]["conclude_count"], 1)
        self.assertEqual(result["telemetry"]["starts"], [])
        self.assertNotIn("outside-secret-must-not-leak", json.dumps(result))

    def test_public_tool_accepts_a_safe_standalone_host_evaluator_mission(self) -> None:
        self.prepare_dsh_native_core()
        immutable_input = self.workspace / "input.txt"
        immutable_input.write_text("frozen\n", encoding="utf-8")
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "standalone-evaluator"),
            runtime="dsh",
            mission={
                "mission_id": "standalone-evaluator",
                "goal": "run one Core-owned read-only evaluator",
                "authority": ["run registered verifier"],
                "required_artifacts": ["measurement"],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{
                "name": "check",
                "required_authorities": ["run registered verifier"],
                "side_effect": "read",
                "produces_artifacts": ["measurement"],
                "produces_facts": [],
                "execution": {
                    "kind": "host_evaluator",
                    "request": {
                        "protocol": "command-v1",
                        "argv": ["/usr/bin/true"],
                        "cwd": ".",
                        "artifacts": [],
                        "filesystem_policy": "read-only",
                        "network_policy": "denied",
                        "output_policy": "sealed",
                    },
                    "fact_projections": [],
                },
            }],
        )

        result = self.invoke_dsh_native(contract)

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "completed", result)
        self.assertEqual(len(result["telemetry"]["starts"]), 1)
        self.assertEqual(
            result["telemetry"]["starts"][0]["tool_filter"],
            {"allow": ["read", "glob", "grep"]},
        )

    def test_calls_frozen_bridge_once_from_current_workspace_and_concludes(self) -> None:
        contract = self.write_contract(status="completed")
        result, _ = self.invoke({"contract": str(contract)})
        self.assertTrue(result["ok"])
        self.assertEqual(result["conclude_count"], 1)
        terminal = result["value"]
        self.assertEqual(terminal["cwd"], str(self.workspace.resolve()))
        self.assertEqual(
            terminal["argv"],
            [
                "evolve",
                "--host-execution",
                "--contract",
                str(contract.resolve()),
                "--expected-contract-sha256",
                hashlib.sha256(contract.read_bytes()).hexdigest(),
            ],
        )
        self.assertIsNone(terminal["ambient_kersor_root"])
        self.assertIsNone(terminal["ambient_pythonpath"])
        self.assertIsNone(terminal["ambient_aws"])
        self.assertIsNone(terminal["ambient_github"])
        self.assertIsNone(terminal["ambient_ssh"])
        self.assertIsNone(terminal["ambient_openai"])
        self.assertEqual(
            result["status_schema"]["enum"],
            ["completed", "blocked", "waiting", "failed"],
        )

    def test_rejects_relative_foreign_and_subagent_paths_without_concluding(self) -> None:
        contract = self.write_contract(status="completed")
        foreign = self.root / "foreign.json"
        foreign.write_text("{}", encoding="utf-8")
        cases = [
            ({"contract": contract.name}, "user", "absolute path"),
            ({"contract": str(foreign)}, "user", "current DSH workspace"),
            ({"contract": str(contract)}, "subagent", "top-level"),
        ]
        for args, origin, message in cases:
            with self.subTest(message=message):
                result, _ = self.invoke(args, origin=origin)
                self.assertFalse(result["ok"])
                self.assertEqual(result["conclude_count"], 0)
                self.assertIn(message, result["error"])

    def test_rejects_a_workspace_owned_installed_core(self) -> None:
        contract = self.write_contract(status="completed")
        (self.preset / ".local" / "kersor-root").write_text(
            f"{self.workspace}\n", encoding="utf-8"
        )
        result, _ = self.invoke({"contract": str(contract)})
        self.assertTrue(result["ok"])
        self.assertEqual(result["conclude_count"], 1)
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn(
            "checkout cannot be owned by the DSH workspace",
            result["value"]["error"],
        )

    def test_blocked_terminal_is_returned_and_concludes(self) -> None:
        contract = self.write_contract(status="blocked", exit=2)
        result, _ = self.invoke({"contract": str(contract)})
        self.assertTrue(result["ok"])
        self.assertEqual(result["conclude_count"], 1)
        self.assertEqual(result["value"]["status"], "blocked")

    def test_second_call_in_one_top_level_session_is_rejected(self) -> None:
        contract = self.write_contract(status="completed")
        result, _ = self.invoke({"contract": str(contract)}, second_call=True)
        self.assertTrue(result["ok"])
        self.assertEqual(result["conclude_count"], 1)
        self.assertIn("only one call per top-level DSH session", result["second_error"])

    def test_durable_history_rejects_a_second_call_after_process_reconstruction(self) -> None:
        marker = self.workspace / "bridge-launched"
        contract = self.write_contract(status="completed", launch_marker=str(marker))

        result, _ = self.invoke(
            {"contract": str(contract)},
            historical_call=True,
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["conclude_count"], 0)
        self.assertIn("only one call per top-level DSH session", result["error"])
        self.assertFalse(marker.exists(), "second durable call reached the bridge")

    def test_durable_command_history_blocks_a_tool_launch_after_restart(self) -> None:
        marker = self.workspace / "bridge-launched"
        contract = self.write_contract(status="completed", launch_marker=str(marker))

        result, _ = self.invoke(
            {"contract": str(contract)},
            historical_command=True,
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["conclude_count"], 0)
        self.assertIn("only one call per top-level DSH session", result["error"])
        self.assertFalse(marker.exists(), "tool launch bypassed durable command claim")

    def test_fresh_top_level_session_can_resume_one_exact_run_directory(self) -> None:
        contract = self.write_contract(status="completed")
        run_dir = self.workspace / ".kersor" / "session" / "autonomous-runs" / "run-1"
        run_dir.mkdir(parents=True)
        physical_run_dir = run_dir.resolve()

        result, _ = self.invoke({
            "contract": str(contract),
            "run_dir": str(physical_run_dir),
            "resume": True,
        })

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["conclude_count"], 1)
        self.assertEqual(
            result["value"]["argv"],
            [
                "evolve",
                "--host-execution",
                "--contract",
                str(contract.resolve()),
                "--expected-contract-sha256",
                hashlib.sha256(contract.read_bytes()).hexdigest(),
                "--run-dir",
                str(physical_run_dir),
                "--resume",
            ],
        )

    def test_failed_call_also_consumes_the_top_level_session(self) -> None:
        contract = self.write_contract(status="cancelled", exit=2)
        result, _ = self.invoke(
            {"contract": str(contract)}, second_call=True
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["conclude_count"], 1)
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn("completed|blocked|waiting|failed", result["value"]["error"])
        self.assertEqual(result["presentation_meta"], {"status": "failed"})
        self.assertEqual(
            result["presentation"]["title"],
            "KerSor Mission · failed",
        )
        self.assertIn("only one call per top-level DSH session", result["second_error"])

    def test_terminal_status_and_exit_code_mapping_is_closed(self) -> None:
        for status in ("blocked", "waiting", "failed"):
            with self.subTest(status=status):
                contract = self.write_contract(status=status, exit=2)
                result, _ = self.invoke({"contract": str(contract)})
                self.assertTrue(result["ok"])
                self.assertEqual(result["conclude_count"], 1)
        unknown = self.write_contract(status="cancelled", exit=2)
        result, _ = self.invoke({"contract": str(unknown)})
        self.assertTrue(result["ok"])
        self.assertEqual(result["conclude_count"], 1)
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn(
            "completed|blocked|waiting|failed",
            result["value"]["error"],
        )
        mismatch = self.write_contract(status="waiting", exit=0)
        result, _ = self.invoke({"contract": str(mismatch)})
        self.assertTrue(result["ok"])
        self.assertEqual(result["conclude_count"], 1)
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn("expected 2", result["value"]["error"])

    def test_cancel_terminates_the_foreground_process_group(self) -> None:
        contract = self.write_contract(mode="sleep")
        result, elapsed = self.invoke(
            {"contract": str(contract)}, abort_after_ms=50, timeout_ms=5_000
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["conclude_count"], 0)
        self.assertIn("test cancellation", result["error"])
        self.assertLess(elapsed, 4)

    def test_cancelled_call_also_consumes_the_top_level_session(self) -> None:
        contract = self.write_contract(mode="sleep")
        result, elapsed = self.invoke(
            {"contract": str(contract)},
            abort_after_ms=50,
            timeout_ms=5_000,
            second_call=True,
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["conclude_count"], 0)
        self.assertIn("test cancellation", result["first_error"])
        self.assertIn("only one call per top-level DSH session", result["second_error"])
        self.assertLess(elapsed, 4)

    def test_cancel_kills_normal_descendants_without_orphans(self) -> None:
        marker = self.root / "orphan-marker"
        contract = self.write_contract(mode="descendant", marker=str(marker))
        result, elapsed = self.invoke(
            {"contract": str(contract)}, abort_after_ms=100, timeout_ms=5_000
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["conclude_count"], 0)
        self.assertLess(elapsed, 4)
        time.sleep(1.2)
        self.assertFalse(marker.exists())

    def test_rejects_multiple_json_terminals(self) -> None:
        contract = self.write_contract(mode="multiple")
        result, _ = self.invoke({"contract": str(contract)})
        self.assertTrue(result["ok"])
        self.assertEqual(result["conclude_count"], 1)
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn("exactly one JSON terminal", result["value"]["error"])


if __name__ == "__main__":
    unittest.main()
