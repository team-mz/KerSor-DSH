/** Host-owned launcher and DSH-native activation broker for one KerSor contract. */

import { spawn } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants, lstatSync, realpathSync } from 'node:fs'
import { access, chmod, lstat, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'


export const name = 'kersor-evolve'
export const inject = ['tools', 'subagents', 'llm', 'commands']

const PRESET_ROOT = fileURLToPath(new URL('..', import.meta.url))
const BRIDGE = fileURLToPath(new URL('../bin/kersor_bridge.py', import.meta.url))
const RUNTIME_TOOLS = fileURLToPath(new URL('../.local/runtime-tools.json', import.meta.url))
const KERSOR_ROOT = fileURLToPath(new URL('../.local/kersor-root', import.meta.url))
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000
const DSH_MAX_ACTIVATION_TIMEOUT_SECONDS = 3600
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_CONTRACT_BYTES = 1024 * 1024
const KILL_GRACE_MS = 2_000
export const DSH_RPC_PROTOCOL = 'kersor-dsh-host-rpc-v3'
export const DSH_RPC_MAX_FRAME_BYTES = 16 * 1024 * 1024
export const DSH_PROVIDER = 'deepseek-official'
export const DSH_MODEL = 'kimi-k2.7-code'
export const DSH_BUDGET_CHARGE_BASIS = 'dsh-host-attested-actual-or-registration-context-reservation-v1'
const DSH_RPC_SOCKET_ENV = 'KERSOR_DSH_RPC_SOCKET'
const DSH_RPC_NONCE_ENV = 'KERSOR_DSH_RPC_NONCE'
const DSH_READ_TOOLS = Object.freeze(['read', 'glob', 'grep'])
const DSH_WRITE_TOOLS = Object.freeze(['edit', 'write'])
const DSH_ADVISER_TOOL = 'subagent'
const DSH_MAX_NATIVE_SUBAGENTS = 4
const DSH_DENIED_MUTATION_CALL_ID_MAX_BYTES = 256
const DSH_CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const DSH_STRUCTURED_OUTPUT_TOOL = 'structured_output'
const DSH_TOKEN_BUDGET_ERROR_CODE = 'DSH_CHILD_TOKEN_BUDGET_EXHAUSTED'
const DSH_TOKEN_BUDGET_ERROR_MESSAGE = 'DSH child activation token budget exhausted'
const DSH_TOKEN_BUDGET_FINISH_CODE = 'DSH_ACTIVATION_TOKEN_BUDGET_EXHAUSTED'
const DSH_ACTIVATION_BUDGET_KEYS = Object.freeze([
  'basis', 'limit_tokens', 'workflow_remaining_tokens',
])
const DSH_LLM_PURPOSES = new Set([undefined, 'session-title', 'compaction'])
const DSH_BUDGET_RUNTIME = Symbol('kersor-evolve-dsh-budget-runtime')
const DSH_ROOT_SEARCH_GUIDANCE = 'KerSor activation note: a workspace-root search is unavailable because Host control evidence shares that root. Read known root files directly, or set path to a specific public subdirectory.'
const DSH_RETRY_EVENT_TYPES = new Set(['llm/retry', 'llm/retry-started'])
const DSH_STEP_SCOPED_EVENT_TYPES = new Set([
  'assistant/chunk',
  'assistant/message',
  'tool/call',
  'tool/result',
  ...DSH_RETRY_EVENT_TYPES,
])
const DSH_PRE_USAGE_QUOTA_EVENT_TYPES = new Set([
  'sandbox/mode',
  'approval/policy',
  'agent/inbox/spliced',
  'subagent/descriptor',
  'turn/start',
  'step/start',
  'user/message',
  'session/title',
  'request/header',
  'request/context',
  'assistant/chunk',
  'step/end',
  'turn/end',
])
const DSH_POST_TERMINAL_METADATA_EVENT_TYPES = new Set(['session/title'])
const MAX_RPC_CONNECTIONS = 64
const MAX_RPC_ERROR_BYTES = 4_096
const TERMINAL_STATUSES = new Set(['completed', 'blocked', 'waiting', 'failed'])
const DSH_RPC_ERROR = Symbol('kersor-dsh-rpc-error')
const CLAIMED_SESSIONS = new WeakSet()
const CLAIMED_TURNS = new WeakMap()
const CHILD_POLICY = new AsyncLocalStorage()
const COMMAND_NAME = 'kersor-evolve'

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  )
}

async function executableOutsideWorkspace(candidate, workspace, label) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
    throw new Error(`${label} must be an install-recorded absolute path`)
  }
  const physical = await realpath(candidate)
  const metadata = await stat(physical)
  if (!metadata.isFile()) throw new Error(`${label} must resolve to a file`)
  await access(physical, constants.X_OK)
  if (inside(workspace, physical)) {
    throw new Error(`${label} cannot be owned by the DSH workspace`)
  }
  return physical
}

async function fileOutsideWorkspace(candidate, workspace, label) {
  const physical = await realpath(candidate)
  if (!(await stat(physical)).isFile()) throw new Error(`${label} must resolve to a file`)
  if (inside(workspace, physical)) throw new Error(`${label} cannot be owned by the DSH workspace`)
  return physical
}

async function installedRuntime(workspace) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(RUNTIME_TOOLS, 'utf8'))
  } catch (cause) {
    throw new Error('KerSor Host runtime manifest is unavailable; reinstall the preset', {cause})
  }
  if (!isRecord(manifest) || manifest.schema_version !== 1 || !isRecord(manifest.tools)) {
    throw new Error('KerSor Host runtime manifest is invalid; reinstall the preset')
  }
  const python = await executableOutsideWorkspace(
    manifest.tools.python3,
    workspace,
    'KerSor Host Python',
  )
  const bridge = await fileOutsideWorkspace(BRIDGE, workspace, 'KerSor bridge')
  let recordedRoot
  try {
    recordedRoot = (await readFile(KERSOR_ROOT, 'utf8')).trim()
  } catch (cause) {
    throw new Error('KerSor Host checkout record is unavailable; reinstall the preset', {cause})
  }
  if (!path.isAbsolute(recordedRoot)) {
    throw new Error('KerSor Host checkout record is invalid; reinstall the preset')
  }
  const core = await realpath(recordedRoot)
  if (!(await stat(core)).isDirectory()) {
    throw new Error('KerSor Host checkout is unavailable; reinstall the preset')
  }
  if (inside(workspace, core)) {
    throw new Error('KerSor Host checkout cannot be owned by the DSH workspace')
  }
  if (!isRecord(manifest.environment)) {
    throw new Error('KerSor Host runtime environment is invalid; reinstall the preset')
  }
  const home = manifest.environment.home
  const temp = manifest.environment.temp_dir
  for (const [label, value] of [['home', home], ['temp_dir', temp]]) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      throw new Error(`KerSor Host runtime ${label} is invalid; reinstall the preset`)
    }
    const metadata = await stat(value)
    if (!metadata.isDirectory()) {
      throw new Error(`KerSor Host runtime ${label} is unavailable; reinstall the preset`)
    }
  }
  if (inside(workspace, await realpath(home))) {
    throw new Error('KerSor Host HOME cannot be owned by the DSH workspace')
  }
  return {python, bridge, core, home, temp}
}

function hostEnvironment(runtime) {
  return {
    PATH: [...new Set([path.dirname(runtime.python), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])]
      .join(path.delimiter),
    HOME: runtime.home,
    TMPDIR: runtime.temp,
    TMP: runtime.temp,
    TEMP: runtime.temp,
    PYTHONDONTWRITEBYTECODE: '1',
  }
}

function dshHostEnvironment(runtime, rpc) {
  return {
    ...hostEnvironment(runtime),
    [DSH_RPC_SOCKET_ENV]: rpc.socketPath,
    [DSH_RPC_NONCE_ENV]: rpc.nonce,
  }
}

export function runHostProcess({
  command,
  args,
  cwd,
  environment,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
}) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('KerSor Mission cancelled'))
  }
  return new Promise((resolve, reject) => {
    const ownsGroup = process.platform !== 'win32'
    const child = spawn(command, args, {
      cwd,
      env: environment,
      shell: false,
      detached: ownsGroup,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let outputBytes = 0
    let terminalError = null
    let killTimer = null
    let settled = false

    const kill = (name) => {
      if (!child.pid) return
      try {
        if (ownsGroup) process.kill(-child.pid, name)
        else child.kill(name)
      } catch (error) {
        if (error?.code !== 'ESRCH') terminalError ??= error
      }
    }
    const terminate = (error) => {
      if (terminalError === null) terminalError = error
      kill('SIGTERM')
      killTimer ??= setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS)
      killTimer.unref?.()
    }
    const capture = target => chunk => {
      outputBytes += chunk.length
      if (outputBytes > maxOutputBytes) {
        terminate(new Error(`KerSor Host output exceeded ${maxOutputBytes} bytes`))
        return
      }
      target.push(chunk)
    }
    const onAbort = () => terminate(
      signal.reason instanceof Error ? signal.reason : new Error('KerSor Mission cancelled'),
    )
    const timer = timeoutMs === null
      ? null
      : setTimeout(
        () => terminate(new Error(`KerSor Host execution timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )
    timer?.unref?.()
    signal?.addEventListener('abort', onAbort, {once: true})
    child.stdout.on('data', capture(stdout))
    child.stderr.on('data', capture(stderr))
    child.once('error', error => {
      terminalError ??= new Error(`failed to start KerSor Host bridge: ${error.message}`, {cause: error})
    })
    child.once('close', (code, exitSignal) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      if (killTimer !== null) clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
      if (terminalError !== null) {
        reject(terminalError)
        return
      }
      resolve({
        code,
        signal: exitSignal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

export function parseTerminalJson(stdout) {
  const terminal = String(stdout ?? '').trim()
  if (!terminal) throw new Error('KerSor Host bridge returned no JSON terminal')
  let value
  try {
    value = JSON.parse(terminal)
  } catch (cause) {
    throw new Error('KerSor Host bridge must return exactly one JSON terminal', {cause})
  }
  if (!isRecord(value) || !TERMINAL_STATUSES.has(value.status)) {
    throw new Error('KerSor Host bridge JSON terminal status must be completed|blocked|waiting|failed')
  }
  return value
}

function jsonClone(value, label) {
  let encoded
  try {
    encoded = JSON.stringify(value)
  } catch (cause) {
    throw new Error(`${label} must be JSON-serializable`, {cause})
  }
  if (encoded === undefined) throw new Error(`${label} must be JSON-serializable`)
  return JSON.parse(encoded)
}

function boundedErrorMessage(error) {
  const message = String(error?.message ?? error).replaceAll(/\s+/g, ' ').trim()
  const bytes = Buffer.from(message || 'DSH activation failed', 'utf8')
  return bytes.length <= MAX_RPC_ERROR_BYTES
    ? bytes.toString('utf8')
    : bytes.subarray(0, MAX_RPC_ERROR_BYTES).toString('utf8').replaceAll('\uFFFD', '')
}

function safeTokenCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`DSH child ${label} must be a non-negative safe integer`)
  }
  return value
}

function childUsageBuckets(value) {
  if (!isRecord(value)) throw new Error('DSH child published malformed token usage')
  const input = safeTokenCount(value.inputTokens, 'inputTokens')
  const output = safeTokenCount(value.outputTokens, 'outputTokens')
  const cacheRead = value.cacheReadTokens === undefined
    ? 0
    : safeTokenCount(value.cacheReadTokens, 'cacheReadTokens')
  const cacheWrite = value.cacheWriteTokens === undefined
    ? 0
    : safeTokenCount(value.cacheWriteTokens, 'cacheWriteTokens')
  return {
    input_tokens: input,
    cached_input_tokens: safeTokenCount(cacheRead + cacheWrite, 'cached input'),
    output_tokens: output,
    total_tokens: safeTokenCount(input + cacheRead + cacheWrite + output, 'totalTokens'),
  }
}

function zeroUsage() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  }
}

function addUsage(target, increment) {
  for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'total_tokens']) {
    target[key] = safeTokenCount(target[key] + increment[key], `aggregate ${key}`)
  }
}

function sameUsage(left, right) {
  return left.input_tokens === right.input_tokens
    && left.cached_input_tokens === right.cached_input_tokens
    && left.output_tokens === right.output_tokens
    && left.total_tokens === right.total_tokens
}

function exactActivationBudget(value) {
  if (!isRecord(value)) throw new Error('DSH RPC activation activation_budget must be an object')
  const keys = Object.keys(value).sort()
  if (
    keys.length !== DSH_ACTIVATION_BUDGET_KEYS.length
    || keys.some((key, index) => key !== DSH_ACTIVATION_BUDGET_KEYS[index])
  ) {
    throw new Error('DSH RPC activation activation_budget must contain only the exact budget fields')
  }
  if (
    value.basis !== 'remaining-workflow-budget'
    || !Number.isSafeInteger(value.limit_tokens)
    || value.limit_tokens <= 0
    || !Number.isSafeInteger(value.workflow_remaining_tokens)
    || value.workflow_remaining_tokens !== value.limit_tokens
  ) {
    throw new Error('DSH RPC activation activation_budget must be one positive remaining-workflow-budget limit')
  }
  return {
    basis: value.basis,
    limitTokens: value.limit_tokens,
    workflowRemainingTokens: value.workflow_remaining_tokens,
  }
}

function exactPreUsageQuota(chunks, usage) {
  if (usage !== null || chunks.length !== 1) return false
  const finish = chunks[0]
  const failure = finish?.type === 'finish' && finish.reason?.kind === 'error'
    ? finish.reason.failure
    : null
  return isRecord(failure) && failure.code === 'QUOTA' && failure.status === 429
}

class DshActivationTokenLedger {
  constructor({limitTokens, signal}) {
    this.limitTokens = limitTokens
    this.signal = signal
    this.usage = zeroUsage()
    this.conversationUsage = zeroUsage()
    this.chargedTokens = 0
    this.reservedTokens = 0
    this.inFlight = 0
    this.closed = false
    this.poisoned = false
    this.usageComplete = true
    this.unmeteredAttempts = 0
    this.meteredAttemptTokens = 0
    this.unmeteredReservationTokens = 0
    this.denial = null
    this.waiters = new Set()
  }

  notify() {
    for (const resolve of this.waiters) resolve()
    this.waiters.clear()
  }

  close() {
    this.closed = true
    this.notify()
  }

  poison() {
    this.poisoned = true
    this.close()
  }

  async waitForSettlement(signal) {
    if (signal?.aborted) throw signal.reason ?? new Error('DSH model request was aborted')
    await new Promise((resolve, reject) => {
      const done = () => {
        signal?.removeEventListener('abort', aborted)
        this.waiters.delete(done)
        resolve()
      }
      const aborted = () => {
        this.waiters.delete(done)
        reject(signal.reason ?? new Error('DSH model request was aborted'))
      }
      this.waiters.add(done)
      signal?.addEventListener('abort', aborted, {once: true})
      if (signal?.aborted) aborted()
    })
  }

  async admit(signal, currentContextWindow) {
    const requiredTokens = currentContextWindow
    while (true) {
      if (this.poisoned) return {kind: 'closed'}
      if (this.closed) return {kind: this.denial === null ? 'closed' : 'denied'}
      const unreserved = this.limitTokens - this.chargedTokens - this.reservedTokens
      if (unreserved >= requiredTokens) {
        this.reservedTokens += requiredTokens
        this.inFlight += 1
        return {kind: 'admitted', reservedTokens: requiredTokens}
      }
      if (this.limitTokens - this.chargedTokens < requiredTokens) {
        this.denial = {
          limitTokens: this.limitTokens,
          requiredReservationTokens: requiredTokens,
        }
        this.close()
        return {kind: 'denied'}
      }
      await this.waitForSettlement(signal)
    }
  }

  settle(reservation, {usage, complete, purpose}) {
    this.reservedTokens = safeTokenCount(
      this.reservedTokens - reservation.reservedTokens,
      'remaining reserved tokens',
    )
    this.inFlight = safeTokenCount(this.inFlight - 1, 'in-flight request count')
    if (usage !== null) {
      addUsage(this.usage, usage)
      if (purpose === undefined) addUsage(this.conversationUsage, usage)
    }
    if (complete) {
      this.meteredAttemptTokens = safeTokenCount(
        this.meteredAttemptTokens + (usage?.total_tokens ?? 0),
        'metered attempt tokens',
      )
      this.chargedTokens = safeTokenCount(
        this.chargedTokens + (usage?.total_tokens ?? 0),
        'charged tokens',
      )
    } else {
      this.unmeteredReservationTokens = safeTokenCount(
        this.unmeteredReservationTokens + reservation.reservedTokens,
        'unmetered reservation tokens',
      )
      this.chargedTokens = safeTokenCount(
        this.chargedTokens + Math.max(
          reservation.reservedTokens,
          usage?.total_tokens ?? 0,
        ),
        'conservative charged tokens',
      )
      this.usageComplete = false
      this.unmeteredAttempts += 1
    }
    this.notify()
  }

  async drain() {
    while (this.inFlight > 0) await this.waitForSettlement()
  }

  snapshot() {
    if (this.inFlight !== 0) throw new Error('DSH activation token ledger is not quiescent')
    return {
      usage: {...this.usage},
      conversationUsage: {...this.conversationUsage},
      usageObserved: this.usage.total_tokens > 0,
      usageComplete: this.usageComplete && !this.poisoned,
      chargedTokens: this.chargedTokens,
      unmeteredAttempts: this.unmeteredAttempts,
      meteredAttemptTokens: this.meteredAttemptTokens,
      unmeteredReservationTokens: this.unmeteredReservationTokens,
      poisoned: this.poisoned,
      denial: this.denial === null ? null : {...this.denial},
    }
  }
}

function budgetFailureStream(message, code = DSH_TOKEN_BUDGET_FINISH_CODE) {
  return (async function* () {
    yield {type: 'finish', reason: {kind: 'error', failure: {message, code}}}
  })()
}

function createDshBudgetRuntime(ctx) {
  if (ctx.llm.preparedStreamVersion !== 1) {
    throw new Error('KerSor DSH Host requires llm prepared-stream admission v1')
  }
  const sessions = new Map()
  ctx.on('llm/prepared-stream', (call, next) => {
    const options = call?.options
    const entry = sessions.get(String(options?.sessionId ?? ''))
    if (entry === undefined) return next()
    const ledger = entry.ledger
    if (
      options.provider !== DSH_PROVIDER
      || options.model !== DSH_MODEL
      || !DSH_LLM_PURPOSES.has(options.purpose)
    ) {
      ledger.poison()
      return budgetFailureStream(
        'KerSor DSH activation attempted an unpinned model route or purpose',
        'DSH_ACTIVATION_MODEL_ROUTE_INVALID',
      )
    }
    return (async function* () {
      const currentContextWindow = call?.context?.contextWindow
      if (!Number.isSafeInteger(currentContextWindow) || currentContextWindow <= 0) {
        ledger.poison()
        yield* budgetFailureStream(
          'KerSor DSH activation requires a positive exact model context window',
          'DSH_ACTIVATION_MODEL_CONTEXT_INVALID',
        )
        return
      }
      const reservation = await ledger.admit(
        options.signal ?? ledger.signal,
        currentContextWindow,
      )
      if (reservation.kind === 'denied') {
        yield* budgetFailureStream(DSH_TOKEN_BUDGET_ERROR_MESSAGE)
        return
      }
      if (reservation.kind !== 'admitted') {
        yield* budgetFailureStream('KerSor DSH activation model ledger is closed', 'ABORTED')
        return
      }
      let usage = null
      let valid = true
      let finishCount = 0
      let sawFinish = false
      const chunks = []
      try {
        for await (const chunk of next()) {
          chunks.push(chunk)
          if (chunk?.type === 'usage') {
            if (usage !== null || sawFinish) {
              valid = false
            } else {
              try {
                usage = childUsageBuckets(chunk.usage)
              } catch {
                valid = false
              }
            }
          } else if (chunk?.type === 'finish') {
            finishCount += 1
            sawFinish = true
          } else if (sawFinish) {
            valid = false
          }
          yield chunk
        }
      } catch (error) {
        valid = false
        throw error
      } finally {
        const knownZeroQuota = valid && finishCount === 1 && exactPreUsageQuota(chunks, usage)
        const complete = valid
          && finishCount === 1
          && (knownZeroQuota || (
            usage !== null && usage.total_tokens <= reservation.reservedTokens
          ))
        ledger.settle(reservation, {
          usage: knownZeroQuota ? null : usage,
          complete,
          purpose: options.purpose,
        })
      }
    })()
  }, {global: true})
  return {
    create({activationBudget, signal}) {
      return new DshActivationTokenLedger({
        limitTokens: activationBudget.limitTokens,
        signal,
      })
    },
    bind(policy, agent) {
      const id = String(agent.id ?? '')
      if (!id || sessions.has(id)) throw new Error('DSH activation child identity is unavailable or reused')
      if (policy.primaryAgent === null) {
        policy.primaryAgent = agent
        policy.activationAgents.set(id, agent)
        sessions.set(id, {agent, ledger: policy.ledger, policy})
        return 'primary'
      }
      if (agent.session?.header?.parentSession !== policy.primaryAgent.id) {
        throw new Error('DSH activation adviser must be a direct child of the primary worker')
      }
      if (policy.advisers.size >= policy.nativeSubagents) {
        throw new Error('DSH activation published more advisers than native_subagents permits')
      }
      policy.advisers.set(id, {
        agent,
      })
      policy.activationAgents.set(id, agent)
      sessions.set(id, {agent, ledger: policy.ledger, policy})
      return 'adviser'
    },
    assertBound(policy, agent) {
      const entry = sessions.get(String(agent?.id ?? ''))
      if (policy.primaryAgent !== agent || entry?.agent !== agent || entry.ledger !== policy.ledger) {
        throw new Error('DSH spawn child token ledger binding is invalid')
      }
    },
    policyFor(agent) {
      const parentId = String(agent?.session?.header?.parentSession ?? '')
      if (!parentId) return undefined
      const parent = sessions.get(parentId)
      return parent?.policy?.primaryAgent?.id === parentId ? parent.policy : undefined
    },
    async close(policy, run) {
      policy.ledger.close()
      let disposalError = null
      try {
        if (run !== undefined) await run.dispose()
      } catch (error) {
        disposalError = error
      }
      try {
        await policy.ledger.drain()
      } finally {
        for (const [id, agent] of policy.activationAgents) {
          const entry = sessions.get(id)
          if (entry?.agent === agent && entry.ledger === policy.ledger) sessions.delete(id)
        }
      }
      if (disposalError !== null) throw disposalError
    },
  }
}

function childStepOrNull(value) {
  if (
    !isRecord(value)
    || !Number.isSafeInteger(value.turn)
    || value.turn < 1
    || !Number.isSafeInteger(value.step)
    || value.step < 1
  ) return null
  return {turn: value.turn, step: value.step, key: `${value.turn}/${value.step}`}
}

function childStep(value, label) {
  const step = childStepOrNull(value)
  if (step === null) throw new Error(`DSH child published malformed ${label} coordinates`)
  return step
}

function terminalStopReason(reason) {
  switch (reason?.kind) {
    case 'completed':
      return 'completed'
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
      return 'aborted'
    case 'blocked':
      return 'refusal'
    case 'error':
    case 'interrupted':
    case 'disposed':
      return 'error'
    default:
      return null
  }
}

function providerFailureFrom(reason) {
  if (reason?.kind !== 'error' || !isRecord(reason.error)) return null
  const message = typeof reason.error.message === 'string' ? reason.error.message.trim() : ''
  const code = typeof reason.error.code === 'string' ? reason.error.code : ''
  if (!message || code.length === 0) return null
  const status = reason.error.status
  if (status !== undefined && (!Number.isSafeInteger(status) || status < 100 || status > 599)) {
    return null
  }
  return {message, code, ...(status === undefined ? {} : {status})}
}

function finalCanonicalAssistantOutput(events, beforeSeq) {
  let output = null
  for (const event of events) {
    if (event?.seq >= beforeSeq) break
    if (event?.type !== 'assistant/message') continue
    const message = event.data?.message
    const source = message?.source
    if (
      !isRecord(message)
      || typeof message.id !== 'string'
      || message.id.length === 0
      || message.role !== 'assistant'
      || !isRecord(source)
      || source.kind !== 'model'
      || source.provider !== DSH_PROVIDER
      || source.model !== DSH_MODEL
      || !Array.isArray(message.content)
      || message.content.some(block => !isRecord(block) || typeof block.type !== 'string')
    ) {
      return null
    }
    if (message.content.length > 0) output = message.content
  }
  return output
}

function childLifecycle(events) {
  const turnStarts = []
  const stepStarts = []
  const stepEnds = []
  const turnEnds = []
  const assistantEvents = []
  const retryEvents = []
  const startedSteps = []
  let valid = true
  let openTurn = null
  let openStep = null
  let nextStep = 1
  let terminal = null

  for (const [ordinal, event] of events.entries()) {
    if (!Number.isSafeInteger(event?.seq) || event.seq !== ordinal) valid = false
    const type = event?.type
    if (terminal !== null) {
      if (!DSH_POST_TERMINAL_METADATA_EVENT_TYPES.has(type)) valid = false
      continue
    }
    if (type === 'assistant/chunk' || type === 'assistant/message') assistantEvents.push(event)
    if (DSH_RETRY_EVENT_TYPES.has(type)) retryEvents.push(event)

    if (DSH_STEP_SCOPED_EVENT_TYPES.has(type)) {
      const position = childStepOrNull(event.data)
      if (
        position === null
        || openStep === null
        || position.turn !== openStep.turn
        || position.step !== openStep.step
      ) {
        valid = false
      }
    }

    if (type === 'turn/start') {
      turnStarts.push(event)
      const turn = Number.isSafeInteger(event?.data?.turn) && event.data.turn > 0
        ? event.data.turn
        : null
      if (
        turn !== 1
        || turnStarts.length !== 1
        || openTurn !== null
        || openStep !== null
        || turnEnds.length !== 0
      ) {
        valid = false
      }
      if (openTurn === null && turn !== null) openTurn = turn
      continue
    }

    if (type === 'step/start') {
      stepStarts.push(event)
      const position = childStepOrNull(event.data)
      if (
        position === null
        || openTurn === null
        || position.turn !== openTurn
        || position.step !== nextStep
        || openStep !== null
      ) {
        valid = false
      }
      if (position !== null) {
        startedSteps.push(position.key)
        if (openStep === null) openStep = position
      }
      continue
    }

    if (type === 'step/end') {
      stepEnds.push(event)
      const position = childStepOrNull(event.data)
      if (
        position === null
        || openStep === null
        || position.turn !== openStep.turn
        || position.step !== openStep.step
      ) {
        valid = false
      } else {
        openStep = null
        nextStep += 1
      }
      continue
    }

    if (type === 'turn/end') {
      turnEnds.push(event)
      terminal = event
      const turn = Number.isSafeInteger(event?.data?.turn) && event.data.turn > 0
        ? event.data.turn
        : null
      if (
        turn === null
        || !isRecord(event?.data?.reason)
        || turnEnds.length !== 1
        || openTurn === null
        || turn !== openTurn
        || openStep !== null
      ) {
        valid = false
      }
      if (openStep === null && openTurn === turn) openTurn = null
    }
  }

  if (
    turnStarts.length !== 1
    || turnEnds.length !== 1
    || stepStarts.length !== stepEnds.length
    || openTurn !== null
    || openStep !== null
  ) {
    valid = false
  }
  return {
    valid,
    terminal,
    turnStarts,
    stepStarts,
    stepEnds,
    turnEnds,
    assistantEvents,
    retryEvents,
    startedSteps,
  }
}

function conversationUsageEvidence(events) {
  const steps = new Map()
  const retried = new Set()
  const meteredSteps = new Set()
  let complete = true
  for (const event of events) {
    const position = childStepOrNull(event?.data)
    if (position === null) continue
    if (DSH_RETRY_EVENT_TYPES.has(event.type)) retried.add(position.key)
    let rawUsage
    let source
    if (event.type === 'assistant/chunk' && event.data?.chunk?.type === 'usage') {
      rawUsage = event.data.chunk.usage
      source = 'chunk'
    } else if (event.type === 'assistant/message' && event.data?.usage !== undefined) {
      rawUsage = event.data.usage
      source = 'message'
    } else {
      continue
    }
    let usage
    try {
      usage = childUsageBuckets(rawUsage)
    } catch {
      complete = false
      continue
    }
    meteredSteps.add(position.key)
    const step = steps.get(position.key) ?? {chunks: [], message: null}
    if (source === 'chunk') step.chunks.push(usage)
    else step.message = usage
    steps.set(position.key, step)
  }
  const usage = zeroUsage()
  for (const [key, step] of steps) {
    if (retried.has(key)) {
      if (step.chunks.length === 0) complete = false
      for (const sample of step.chunks) addUsage(usage, sample)
      continue
    }
    if (step.message !== null) {
      addUsage(usage, step.message)
      continue
    }
    if (step.chunks.length !== 1) {
      complete = false
      continue
    }
    addUsage(usage, step.chunks[0])
  }
  return {usage, complete, meteredSteps}
}

function childEvidence(agent, result) {
  const events = agent?.session?.events
  if (!Array.isArray(events)) throw new Error('DSH child did not expose a durable Session event log')
  const lifecycle = childLifecycle(events)
  const conversation = conversationUsageEvidence(events)
  const terminalReason = lifecycle.terminal?.data?.reason
  const terminalMatches = lifecycle.terminal !== null
    && terminalStopReason(terminalReason) === result.stopReason
  const providerFailure = providerFailureFrom(terminalReason)
  let knownPreUsageQuota = false
  if (
    lifecycle.valid
    && terminalMatches
    && result.stopReason === 'error'
    && providerFailure?.code === 'QUOTA'
    && providerFailure.status === 429
    && Array.isArray(result.output)
    && result.output.length === 0
    && result.structured === undefined
    && conversation.meteredSteps.size === 0
    && lifecycle.turnStarts.length === 1
    && lifecycle.stepStarts.length === 1
    && lifecycle.stepEnds.length === 1
    && lifecycle.turnEnds.length === 1
    && lifecycle.assistantEvents.length === 1
    && lifecycle.retryEvents.length === 0
    && events.every(event => DSH_PRE_USAGE_QUOTA_EVENT_TYPES.has(event?.type))
  ) {
    const turnStart = lifecycle.turnStarts[0]
    const stepStart = lifecycle.stepStarts[0]
    const finish = lifecycle.assistantEvents[0]
    const stepEnd = lifecycle.stepEnds[0]
    const turnEnd = lifecycle.turnEnds[0]
    const startStep = childStep(stepStart.data, 'quota step/start')
    const endStep = childStep(stepEnd.data, 'quota step/end')
    knownPreUsageQuota = turnStart.data?.turn === startStep.turn
      && turnStart.data?.trigger?.kind !== 'retry'
      && startStep.turn === endStep.turn
      && startStep.step === endStep.step
      && turnEnd.data.turn === startStep.turn
      && lifecycle.terminal === turnEnd
      && finish.type === 'assistant/chunk'
      && finish.data?.turn === startStep.turn
      && finish.data?.step === startStep.step
      && finish.data.chunk?.type === 'finish'
      && finish.data.chunk.reason?.kind === 'error'
      && sameJson(finish.data.chunk.reason.failure, terminalReason.error)
      && turnStart.seq < stepStart.seq
      && stepStart.seq < finish.seq
      && finish.seq < stepEnd.seq
      && stepEnd.seq < turnEnd.seq
  }

  let knownTerminalStepQuota = false
  if (
    lifecycle.valid
    && terminalMatches
    && result.stopReason === 'error'
    && providerFailure?.code === 'QUOTA'
    && providerFailure.status === 429
    && Array.isArray(result.output)
    && result.structured === undefined
    && conversation.usage.total_tokens > 0
    && lifecycle.turnStarts[0].data?.trigger?.kind !== 'retry'
    && lifecycle.retryEvents.length === 0
    && lifecycle.stepStarts.length > 1
    && lifecycle.stepStarts.length === lifecycle.stepEnds.length
    && lifecycle.turnEnds.length === 1
  ) {
    const stepStart = lifecycle.stepStarts.at(-1)
    const stepEnd = lifecycle.stepEnds.at(-1)
    const turnEnd = lifecycle.turnEnds[0]
    const startStep = childStep(stepStart.data, 'terminal quota step/start')
    const endStep = childStep(stepEnd.data, 'terminal quota step/end')
    const priorAssistantOutput = finalCanonicalAssistantOutput(events, stepStart.seq)
    const priorSteps = lifecycle.startedSteps.slice(0, -1)
    const terminalStepEvents = events.slice(stepStart.seq, stepEnd.seq + 1)
      .filter(event => DSH_STEP_SCOPED_EVENT_TYPES.has(event?.type))
    const finish = terminalStepEvents[0]
    knownTerminalStepQuota = priorSteps.length > 0
      && priorSteps.every(key => conversation.meteredSteps.has(key))
      && !conversation.meteredSteps.has(startStep.key)
      && priorAssistantOutput !== null
      && sameJson(result.output, priorAssistantOutput)
      && terminalStepEvents.length === 1
      && events.slice(stepStart.seq, turnEnd.seq + 1)
        .every(event => DSH_PRE_USAGE_QUOTA_EVENT_TYPES.has(event?.type))
      && startStep.turn === endStep.turn
      && startStep.step === endStep.step
      && turnEnd.data.turn === startStep.turn
      && lifecycle.terminal === turnEnd
      && finish.type === 'assistant/chunk'
      && finish.data?.turn === startStep.turn
      && finish.data?.step === startStep.step
      && finish.data.chunk?.type === 'finish'
      && finish.data.chunk.reason?.kind === 'error'
      && sameJson(finish.data.chunk.reason.failure, terminalReason.error)
      && stepStart.seq < finish.seq
      && finish.seq < stepEnd.seq
      && stepEnd.seq < turnEnd.seq
  }

  const everyStartedStepMetered = lifecycle.startedSteps.length > 0
    && lifecycle.startedSteps.every(key => conversation.meteredSteps.has(key))
  const knownQuota = knownPreUsageQuota || knownTerminalStepQuota
  const unprovenExactQuota = result.stopReason === 'error'
    && providerFailure?.code === 'QUOTA'
    && providerFailure.status === 429
    && !knownQuota
  return {
    usageComplete: lifecycle.valid
      && terminalMatches
      && conversation.complete
      && (knownQuota || (everyStartedStepMetered && !unprovenExactQuota)),
    terminalMatches,
    providerFailure,
    knownQuota,
    knownTerminalStepQuota,
    lifecycleValid: lifecycle.valid,
    conversationUsage: conversation,
  }
}

function adviserStopReason(agent) {
  const events = agent?.session?.events
  if (!Array.isArray(events)) return null
  const terminal = [...events].reverse().find(event => event?.type === 'turn/end')
  return terminalStopReason(terminal?.data?.reason)
}

function nativeSubagentEvidence(policy) {
  const threadIds = [...policy.advisers.keys()]
  const completed = [...policy.advisers.values()]
    .filter(adviser => adviserStopReason(adviser.agent) === 'completed').length
  return {
    requested: policy.nativeSubagents,
    spawned: threadIds.length,
    completed,
    thread_ids: threadIds,
    status: policy.nativeSubagents === 0
      ? 'not-requested'
      : threadIds.length === 0
        ? 'not-used'
        : threadIds.length <= policy.nativeSubagents
          ? 'observed'
          : 'limit-exceeded',
  }
}

function activationConversationEvidence(primaryEvidence, policy) {
  const usage = {...primaryEvidence.conversationUsage.usage}
  let complete = primaryEvidence.conversationUsage.complete
  let advisersValid = true
  for (const adviser of policy.advisers.values()) {
    const stopReason = adviserStopReason(adviser.agent)
    const evidence = childEvidence(adviser.agent, {
      stopReason: stopReason ?? 'error',
      output: [],
    })
    addUsage(usage, evidence.conversationUsage.usage)
    complete = complete && evidence.conversationUsage.complete
    advisersValid = advisersValid && stopReason === 'completed' && evidence.usageComplete
  }
  return {usage, complete, advisersValid}
}

function attachBudgetAttestation(receipt, ledgerEvidence) {
  receipt.budget_charge_tokens = ledgerEvidence.chargedTokens
  receipt.budget_charge_basis = DSH_BUDGET_CHARGE_BASIS
  receipt.unmetered_attempts = ledgerEvidence.unmeteredAttempts
  receipt.metered_attempt_tokens = ledgerEvidence.meteredAttemptTokens
  receipt.unmetered_reservation_tokens = ledgerEvidence.unmeteredReservationTokens
}

function deniedMutationRequestSha256(execution) {
  try {
    const encoded = JSON.stringify(canonicalJson({
      arguments: execution.arguments ?? null,
      name: execution.name,
    }))
    if (typeof encoded !== 'string') return null
    return createHash('sha256').update(encoded).digest('hex')
  } catch {
    return null
  }
}

function deniedMutationAttempt(execution) {
  if (!DSH_WRITE_TOOLS.includes(execution.name)) return null
  if (typeof execution.callId !== 'string' || execution.callId.length === 0) return null
  return {
    toolName: execution.name,
    toolCallId: execution.callId,
    requestSha256: deniedMutationRequestSha256(execution),
    valid: !DSH_CONTROL_CHARACTER.test(execution.callId)
      && Buffer.byteLength(execution.callId, 'utf8') <= DSH_DENIED_MUTATION_CALL_ID_MAX_BYTES,
  }
}

function durableToolResultIsError(event, callId) {
  if (event?.type !== 'tool/result') return false
  const message = event.data?.message
  if (!isRecord(message) || !Array.isArray(message.content)) return false
  if (message.source?.callId !== callId) return false
  return message.content.some(block => (
    isRecord(block)
    && block.type === 'tool-result'
    && block.toolCallId === callId
    && block.isError === true
  ))
}

function deniedMutationReceipt(events, denial) {
  if (denial === null) return null
  if (!denial.valid || denial.requestSha256 === null) return undefined
  const calls = events.filter(event => (
    event?.type === 'tool/call'
    && event.data?.callId === denial.toolCallId
    && event.data?.name === denial.toolName
  ))
  const results = events.filter(event => durableToolResultIsError(event, denial.toolCallId))
  if (calls.length !== 1 || results.length !== 1) return undefined
  const call = calls[0]
  const result = results[0]
  const callStep = childStepOrNull(call.data)
  const resultStep = childStepOrNull(result.data)
  if (
    callStep === null
    || resultStep === null
    || callStep.key !== resultStep.key
    || !Number.isSafeInteger(call.seq)
    || !Number.isSafeInteger(result.seq)
    || result.seq <= call.seq
  ) {
    return undefined
  }
  return {
    schema_version: 1,
    kind: 'dsh-denied-mutation',
    source: 'dsh-host-tool-guard',
    tool_name: denial.toolName,
    tool_call_id: denial.toolCallId,
    tool_call_seq: call.seq,
    tool_result_seq: result.seq,
    request_sha256: denial.requestSha256,
    reason_code: 'mutation-policy-denied',
    tool_executed: false,
  }
}

function dshActivationError(code, message, result, providerFailure = null) {
  const error = new Error(message)
  error[DSH_RPC_ERROR] = {
    code,
    result,
    ...(providerFailure === null ? {} : {
      providerCode: providerFailure.code,
      ...(providerFailure.status === undefined ? {} : {providerStatus: providerFailure.status}),
    }),
  }
  return error
}

function activationModelRole(value, policy) {
  if (Object.hasOwn(value, 'model_role') || Object.hasOwn(value, 'modelRole')) {
    throw new Error('DSH RPC activation model_role is Host-derived from phase and must not be supplied')
  }
  if (typeof value.phase !== 'string') {
    throw new Error('DSH RPC activation phase must be a string')
  }
  if (policy?.kind === 'task') {
    if (/^Evolve [1-9]\d*$/u.test(value.phase)) return 'worker'
    throw new Error('DSH fixed Task activation phase must match "Evolve <positive integer>"')
  }
  if (/^Plan revision [1-9]\d*$/u.test(value.phase)) return 'planner'
  if (/^Execute revision [1-9]\d*$/u.test(value.phase)) return 'worker'
  throw new Error(
    'DSH RPC activation phase must match "Plan revision <positive integer>" '
    + 'or "Execute revision <positive integer>"',
  )
}

function sameStringSet(left, right) {
  const sortedRight = [...right].sort()
  return left.length === right.length && [...left].sort().every((value, index) => value === sortedRight[index])
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]),
  )
}

function sameJson(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right))
}

function candidateGateMatches(transactionPolicy, observed) {
  if (!isRecord(observed)) return false
  if (transactionPolicy.dynamicCommitValue !== true) {
    return sameJson(observed, transactionPolicy.candidateGate)
  }
  if (
    !isRecord(observed.commit_projection)
    || typeof observed.commit_projection.value !== 'number'
    || !Number.isFinite(observed.commit_projection.value)
  ) return false
  return sameJson(
    {
      ...observed,
      commit_projection: {...observed.commit_projection, value: null},
    },
    transactionPolicy.candidateGate,
  )
}

function safeTransactionArtifact(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) return false
  const segments = value.split(/[\\/]+/u)
  return !segments.some(segment => !segment || segment === '.' || segment === '..')
}

function runtimeControlArtifact(value) {
  const [head] = value.split(/[\\/]+/u)
  return ['.git', '.conformance', '.kersor', '.kersor-autonomous'].includes(head)
}

async function rejectSymlinkSegments(root, relative, label) {
  let current = root
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`${label} path must not use symlinks`)
      }
    } catch (cause) {
      if (cause?.code === 'ENOENT') return
      throw cause
    }
  }
}

async function prepareTransactionArtifacts(
  workspace,
  artifacts,
  protectedFiles = [],
  protectedRoots = [],
) {
  const currentProtectedRoots = []
  for (const root of protectedRoots) {
    let metadata
    let physical
    try {
      metadata = await lstat(root)
      physical = await realpath(root)
    } catch (cause) {
      throw new Error('DSH Mission Session identity is unavailable during activation', {cause})
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || physical !== root) {
      throw new Error('DSH Mission Session identity changed before activation')
    }
    currentProtectedRoots.push(root, physical)
  }
  const prepared = []
  for (const artifact of artifacts) {
    if (!safeTransactionArtifact(artifact)) {
      throw new Error('DSH transaction artifacts must be canonical non-empty relative paths')
    }
    if (runtimeControlArtifact(artifact)) {
      throw new Error('DSH transaction artifact must not target KerSor runtime control paths')
    }
    const absolute = path.resolve(workspace, artifact)
    if (!inside(workspace, absolute)) throw new Error('DSH transaction artifact escapes the workspace')
    const metadata = await lstat(absolute)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error('DSH transaction artifact must be one regular single-link file')
    }
    const physical = await realpath(absolute)
    if (physical !== absolute || !inside(workspace, physical)) {
      throw new Error('DSH transaction artifact must not use a symlink or path alias')
    }
    const protectedFile = protectedFiles.find(item => item.path === physical)
    if (protectedFile !== undefined) {
      throw new Error(`DSH transaction artifact must not target the frozen ${protectedFile.label}`)
    }
    if (currentProtectedRoots.some(root => inside(root, absolute) || inside(root, physical))) {
      throw new Error('DSH transaction artifact must not target the Mission Session')
    }
    prepared.push({relative: artifact, absolute, physical})
  }
  return prepared
}

async function readOnlyActivation(value, workspace, missionPolicy) {
  if (!isRecord(value)) throw new Error('DSH RPC activation must be an object')
  if (value.contract_version !== 'akw-js-runtime-v1') {
    throw new Error('DSH RPC activation contract_version is invalid')
  }
  if (typeof value.call_id !== 'string' || !value.call_id.trim()) {
    throw new Error('DSH RPC activation call_id must be a non-empty string')
  }
  if (typeof value.prompt !== 'string' || !value.prompt.trim()) {
    throw new Error('DSH RPC activation prompt must be a non-empty string')
  }
  if (value.project_root !== undefined) {
    if (typeof value.project_root !== 'string' || await realpath(value.project_root) !== workspace) {
      throw new Error('DSH RPC activation project_root must equal the calling workspace')
    }
  }
  if (value.model !== undefined && value.model !== DSH_MODEL) {
    throw new Error(`DSH RPC activation model must be ${DSH_MODEL}`)
  }
  if (!isRecord(value.options)) {
    throw new Error('DSH RPC activation options must be an object')
  }
  const nativeSubagents = value.options.native_subagents ?? 0
  if (
    !Number.isSafeInteger(nativeSubagents)
    || nativeSubagents < 0
    || nativeSubagents > DSH_MAX_NATIVE_SUBAGENTS
  ) {
    throw new Error(`DSH activation native_subagents must be an integer from 0 through ${DSH_MAX_NATIVE_SUBAGENTS}`)
  }
  if (value.schema !== undefined && !isRecord(value.schema)) {
    throw new Error('DSH RPC activation schema must be an object')
  }
  const activationBudget = exactActivationBudget(value.activation_budget)
  const timeoutSeconds = value.timeout_seconds ?? DSH_MAX_ACTIVATION_TIMEOUT_SECONDS
  if (
    typeof timeoutSeconds !== 'number'
    || !Number.isFinite(timeoutSeconds)
    || timeoutSeconds <= 0
    || timeoutSeconds > DSH_MAX_ACTIVATION_TIMEOUT_SECONDS
  ) {
    throw new Error(`DSH RPC activation timeout_seconds must be in (0, ${DSH_MAX_ACTIVATION_TIMEOUT_SECONDS}]`)
  }
  const modelRole = activationModelRole(value, missionPolicy)
  let transactionArtifacts = []
  const transaction = value.options.transaction
  if (transaction !== undefined && transaction !== null) {
    if (modelRole !== 'worker') throw new Error('DSH transaction activation must be an Execute revision worker')
    if (!isRecord(transaction)) throw new Error('DSH activation transaction must be an object')
    const allowedKeys = new Set(['artifacts', 'rollback_on_noncompleted_status', 'candidate_gate'])
    if (Object.keys(transaction).some(key => !allowedKeys.has(key))) {
      throw new Error('DSH activation transaction contains unsupported fields')
    }
    if (
      !Array.isArray(transaction.artifacts)
      || transaction.artifacts.length === 0
      || new Set(transaction.artifacts).size !== transaction.artifacts.length
      || !transaction.artifacts.every(safeTransactionArtifact)
    ) {
      throw new Error('DSH activation transaction must declare a non-empty unique canonical artifact set')
    }
    if (
      transaction.rollback_on_noncompleted_status !== undefined
      && typeof transaction.rollback_on_noncompleted_status !== 'boolean'
    ) {
      throw new Error('DSH activation rollback_on_noncompleted_status must be a boolean')
    }
    const declaredTransactions = (missionPolicy?.transactions ?? [])
      .filter(item => sameStringSet(item.artifacts, transaction.artifacts))
    if (declaredTransactions.length === 0) {
      throw new Error('DSH activation transaction does not match one Mission capability')
    }
    const hasRollback = Object.prototype.hasOwnProperty.call(
      transaction,
      'rollback_on_noncompleted_status',
    )
    const rollbackMatches = declaredTransactions.filter(item => (
      item.rollbackOnNoncompletedStatus === undefined
        ? !hasRollback
        : hasRollback && transaction.rollback_on_noncompleted_status === item.rollbackOnNoncompletedStatus
    ))
    if (rollbackMatches.length === 0) {
      throw new Error('DSH activation transaction rollback policy does not match the Mission capability')
    }
    const hasCandidateGate = Object.prototype.hasOwnProperty.call(transaction, 'candidate_gate')
    const declared = rollbackMatches.find(item => (
      item.candidateGate === null
        ? !hasCandidateGate
        : hasCandidateGate && candidateGateMatches(item, transaction.candidate_gate)
    ))
    if (declared === undefined) {
      throw new Error('DSH activation candidate gate does not match the Mission evaluator contract')
    }
    transactionArtifacts = await prepareTransactionArtifacts(
      workspace,
      transaction.artifacts,
      missionPolicy?.protectedFiles ?? [],
      missionPolicy?.protectedRoots ?? [],
    )
  }
  return {
    label: typeof value.label === 'string' && value.label.trim() ? value.label.trim() : 'KerSor DSH activation',
    prompt: [{type: 'text', text: value.prompt}],
    outputSchema: value.schema === undefined ? undefined : jsonClone(value.schema, 'DSH output schema'),
    timeoutSeconds,
    modelRole,
    nativeSubagents,
    transactionArtifacts,
    activationBudget,
  }
}

function pathInsideWorkspace(workspace, lexicalWorkspace, value, label) {
  if (typeof value !== 'string' || !value.trim()) return `${label} must be a non-empty string`
  const lexical = path.resolve(lexicalWorkspace, value)
  if (!inside(lexicalWorkspace, lexical) && !inside(workspace, lexical)) {
    return `${label} must stay inside the DSH workspace`
  }
  let physical
  try {
    physical = realpathSync(lexical)
  } catch {
    return `${label} must resolve to an existing path inside the DSH workspace`
  }
  if (!inside(workspace, physical)) return `${label} cannot escape the DSH workspace through a symlink`
  return undefined
}

function runtimeControlReadProblem(workspace, lexicalWorkspace, value, label) {
  if (typeof value !== 'string' || !value.trim()) return `${label} must be a non-empty string`
  const lexical = path.resolve(lexicalWorkspace, value)
  const lexicalRelative = path.relative(lexicalWorkspace, lexical)
  if (runtimeControlArtifact(lexicalRelative)) {
    return `${label} must not inspect a KerSor or repository runtime-control path`
  }
  try {
    const physical = realpathSync(lexical)
    if (runtimeControlArtifact(path.relative(workspace, physical))) {
      return `${label} must not inspect a KerSor or repository runtime-control path`
    }
  } catch {
    // The ordinary existence diagnostic remains owned by pathInsideWorkspace.
  }
  return undefined
}

function transactionWritePathProblem(workspace, lexicalWorkspace, transactionArtifacts, value, label) {
  if (typeof value !== 'string' || !value) return `${label} must be a non-empty string`
  const match = transactionArtifacts.find(artifact => (
    value === artifact.relative
    || value === artifact.absolute
    || value === path.resolve(lexicalWorkspace, artifact.relative)
  ))
  if (match === undefined) return `${label} must name the declared transaction artifact exactly`
  let metadata
  let physical
  try {
    if (realpathSync(lexicalWorkspace) !== workspace) {
      return `${label} transaction workspace identity is unsafe`
    }
    const actual = path.isAbsolute(value)
      ? path.resolve(value)
      : path.resolve(lexicalWorkspace, value)
    metadata = lstatSync(actual)
    physical = realpathSync(actual)
  } catch {
    return `${label} must remain one existing declared transaction artifact`
  }
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || physical !== match.physical
    || !inside(workspace, physical)
  ) {
    return `${label} transaction artifact identity is unsafe`
  }
  return undefined
}

function readOnlyChildGuard(workspace, lexicalWorkspace, activation, policy, execution) {
  const primary = execution.agent === policy.primaryAgent
  if (execution.name === DSH_STRUCTURED_OUTPUT_TOOL) {
    return primary ? undefined : 'KerSor DSH advisers must return analysis as their ordinary final answer'
  }
  if (execution.name === DSH_ADVISER_TOOL) {
    if (!primary) return 'KerSor DSH advisers cannot delegate'
    if (activation.nativeSubagents === 0) return 'KerSor DSH activation did not request native advisers'
    if (!isRecord(execution.arguments) || execution.arguments.run_in_background === true) {
      return 'KerSor DSH advisers are Host-settled foreground calls and cannot request background execution'
    }
    const callId = String(execution.callId ?? '')
    if (!callId) return 'KerSor DSH adviser delegation requires a stable tool call id'
    if (!policy.adviserCallIds.has(callId)) {
      if (policy.adviserCallIds.size >= activation.nativeSubagents) {
        return 'KerSor DSH activation already requested its full native adviser budget'
      }
      policy.adviserCallIds.add(callId)
    }
    return undefined
  }
  if (DSH_WRITE_TOOLS.includes(execution.name)) {
    if (!primary) return `KerSor DSH adviser denies mutation tool ${JSON.stringify(execution.name)}`
    if (
      policy.advisers.size !== activation.nativeSubagents
      || [...policy.advisers.values()].some(
        adviser => adviserStopReason(adviser.agent) !== 'completed',
      )
    ) {
      return 'KerSor DSH primary worker must finish every requested read-only adviser before writing'
    }
    if (activation.transactionArtifacts.length === 0) {
      return `KerSor DSH-native read-only activation denies tool ${JSON.stringify(execution.name)}`
    }
    if (!isRecord(execution.arguments)) {
      return `KerSor DSH-native ${execution.name} arguments must be an object`
    }
    return transactionWritePathProblem(
      workspace,
      lexicalWorkspace,
      activation.transactionArtifacts,
      execution.arguments.file_path,
      `${execution.name}.file_path`,
    )
  }
  if (!DSH_READ_TOOLS.includes(execution.name)) {
    const mode = activation.transactionArtifacts.length > 0 ? 'transaction' : 'read-only'
    return `KerSor DSH-native ${mode} activation denies tool ${JSON.stringify(execution.name)}`
  }
  if (!isRecord(execution.arguments)) {
    return `KerSor DSH-native ${execution.name} arguments must be an object`
  }
  if (execution.name === 'read') {
    return runtimeControlReadProblem(
      workspace,
      lexicalWorkspace,
      execution.arguments.file_path,
      'read.file_path',
    ) ?? pathInsideWorkspace(
      workspace,
      lexicalWorkspace,
      execution.arguments.file_path,
      'read.file_path',
    )
  }
  if (typeof execution.arguments.pattern !== 'string' || !execution.arguments.pattern) {
    return `${execution.name}.pattern must be a non-empty string`
  }
  if (execution.name === 'glob') {
    const pattern = execution.arguments.pattern
    if (path.isAbsolute(pattern) || pattern.split(/[\\/]+/u).includes('..')) {
      return 'glob.pattern cannot be absolute or contain a parent path segment'
    }
  }
  const searchPath = execution.arguments.path ?? lexicalWorkspace
  const controlProblem = runtimeControlReadProblem(
    workspace,
    lexicalWorkspace,
    searchPath,
    `${execution.name}.path`,
  )
  if (controlProblem !== undefined) return controlProblem
  const lexicalSearch = path.resolve(lexicalWorkspace, searchPath)
  if (lexicalSearch === lexicalWorkspace || lexicalSearch === workspace) {
    return `${execution.name}.path cannot search the workspace root because it contains Host control evidence; read a known root file directly or search a specific public subdirectory`
  }
  return pathInsideWorkspace(workspace, lexicalWorkspace, searchPath, `${execution.name}.path`)
}

function installChildToolGuidance(agent, transactionArtifacts, nativeSubagents = 0) {
  for (const name of ['glob', 'grep']) {
    const definition = agent.ctx.tools.get(name, agent)
    if (definition === undefined) {
      throw new Error(`KerSor DSH activation requires the ${name} tool definition`)
    }
    agent.ctx.effect(() => agent.ctx.tools.register({
      ...definition,
      description: `${definition.description} ${DSH_ROOT_SEARCH_GUIDANCE}`,
    }))
  }
  if (nativeSubagents > 0) {
    const definition = agent.ctx.tools.get(DSH_ADVISER_TOOL, agent)
    if (definition === undefined) {
      throw new Error('KerSor DSH activation requested advisers but the subagent tool is unavailable')
    }
    if (isRecord(definition.parameters) && Object.hasOwn(definition.parameters, 'run_in_background')) {
      throw new Error('KerSor DSH preset must disable background subagent execution at the tool owner')
    }
  }
  if (transactionArtifacts.length === 0) return
  const artifactList = JSON.stringify(transactionArtifacts.map(artifact => artifact.relative))
  for (const name of DSH_WRITE_TOOLS) {
    const definition = agent.ctx.tools.get(name, agent)
    if (definition === undefined) {
      throw new Error(`KerSor DSH activation requires the ${name} tool definition`)
    }
    agent.ctx.effect(() => agent.ctx.tools.register({
      ...definition,
      description: `${definition.description} KerSor activation note: write only the exact declared transaction artifacts ${artifactList}. Helper, test, and scratch files are not exposed; the Host verifier supplies the next-round evidence.`,
    }))
  }
}

function activationSignal(parent, timeoutSeconds) {
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort(
    parent.reason instanceof Error ? parent.reason : new Error('KerSor DSH activation cancelled'),
  )
  parent.addEventListener('abort', onAbort, {once: true})
  if (parent.aborted) onAbort()
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return
    timedOut = true
    controller.abort(new Error(`KerSor DSH activation timed out after ${timeoutSeconds}s`))
  }, timeoutSeconds * 1_000)
  timer.unref?.()
  return {
    signal: controller.signal,
    get timedOut() { return timedOut },
    dispose() {
      clearTimeout(timer)
      parent.removeEventListener('abort', onAbort)
    },
  }
}

async function executeDshActivation(
  ctx,
  parent,
  workspace,
  lexicalWorkspace,
  missionPolicy,
  activationValue,
  hostSignal,
  budgetRuntime,
) {
  const activation = await readOnlyActivation(activationValue, workspace, missionPolicy)
  const operation = activationSignal(hostSignal, activation.timeoutSeconds)
  let policy
  let run
  let cleanupPromise = null
  try {
    policy = {
      guardedAgents: new Set(),
      deniedMutation: null,
      transactionArtifacts: activation.transactionArtifacts,
      nativeSubagents: activation.nativeSubagents,
      primaryAgent: null,
      advisers: new Map(),
      adviserCallIds: new Set(),
      activationAgents: new Map(),
      ledger: budgetRuntime.create({
        activationBudget: activation.activationBudget,
        signal: operation.signal,
      }),
    }
    policy.guard = execution => {
      const problem = readOnlyChildGuard(
        workspace,
        lexicalWorkspace,
        activation,
        policy,
        execution,
      )
      if (problem !== undefined && policy.deniedMutation === null) {
        policy.deniedMutation = deniedMutationAttempt(execution)
      }
      return problem
    }
    run = await CHILD_POLICY.run(policy, () => ctx.subagents.start('spawn', {
      label: `KerSor · ${activation.label}`,
      prompt: activation.prompt,
      parent,
      signal: operation.signal,
      agentOptions: {provider: DSH_PROVIDER, model: DSH_MODEL},
      ...activation.outputSchema === undefined ? {} : {outputSchema: activation.outputSchema},
      toolFilter: {allow: [
        ...DSH_READ_TOOLS,
        ...(activation.transactionArtifacts.length > 0 ? DSH_WRITE_TOOLS : []),
        ...(activation.nativeSubagents > 0 ? [DSH_ADVISER_TOOL] : []),
      ]},
    }))
    if (!run?.localAgent || !policy.guardedAgents.has(run.localAgent)) {
      throw new Error('DSH spawn did not publish a locally guarded child')
    }
    budgetRuntime.assertBound(policy, run.localAgent)
    if (
      run.localAgent.options?.provider !== DSH_PROVIDER
      || run.localAgent.options?.model !== DSH_MODEL
    ) {
      throw new Error('DSH spawn child route does not match the pinned provider and model')
    }
    const result = await run.result
    if (!isRecord(result) || typeof result.stopReason !== 'string') {
      throw new Error('DSH spawn returned an invalid terminal result')
    }
    const threadId = String(run.id ?? run.localAgent.id ?? '')
    if (!threadId) throw new Error('DSH spawn did not publish a child thread id')
    cleanupPromise = budgetRuntime.close(policy, run)
    await cleanupPromise
    const evidence = childEvidence(run.localAgent, result)
    const conversationEvidence = activationConversationEvidence(evidence, policy)
    const nativeSubagents = nativeSubagentEvidence(policy)
    const ledgerEvidence = policy.ledger.snapshot()
    const budgetTerminalMatches = ledgerEvidence.denial !== null
      && result.stopReason === 'error'
      && evidence.providerFailure?.code === DSH_TOKEN_BUDGET_FINISH_CODE
      && evidence.providerFailure.message === DSH_TOKEN_BUDGET_ERROR_MESSAGE
    const usageComplete = (evidence.usageComplete || (
      budgetTerminalMatches && evidence.lifecycleValid
    ))
      && conversationEvidence.complete
      && conversationEvidence.advisersValid
      && ledgerEvidence.usageComplete
      && sameUsage(conversationEvidence.usage, ledgerEvidence.conversationUsage)
    const upperBoundCoveredUsage = !usageComplete
      && ledgerEvidence.unmeteredAttempts > 0
      && !ledgerEvidence.poisoned
      && evidence.lifecycleValid
      && sameUsage(conversationEvidence.usage, ledgerEvidence.conversationUsage)
      && ledgerEvidence.meteredAttemptTokens <= ledgerEvidence.usage.total_tokens
      && ledgerEvidence.unmeteredReservationTokens
        >= ledgerEvidence.usage.total_tokens - ledgerEvidence.meteredAttemptTokens
      && ledgerEvidence.chargedTokens === ledgerEvidence.meteredAttemptTokens
        + ledgerEvidence.unmeteredReservationTokens
      && ledgerEvidence.chargedTokens >= ledgerEvidence.usage.total_tokens
      && ledgerEvidence.chargedTokens <= activation.activationBudget.limitTokens
    const receipt = {
      output: jsonClone(
        evidence.knownTerminalStepQuota ? [] : (result.output ?? []),
        'DSH child output',
      ),
      structured: evidence.knownTerminalStepQuota || result.structured === undefined
        ? null
        : jsonClone(result.structured, 'DSH child structured output'),
      stop_reason: result.stopReason,
      usage: ledgerEvidence.usage,
      usage_observed: ledgerEvidence.usageObserved,
      usage_complete: usageComplete,
      thread_id: threadId,
      provider: DSH_PROVIDER,
      model: DSH_MODEL,
      model_role: activation.modelRole,
      isolation: 'fresh-dsh-subagent',
      artifacts: [],
    }
    if (
      nativeSubagents.spawned !== activation.nativeSubagents
      || nativeSubagents.completed !== activation.nativeSubagents
      || nativeSubagents.status === 'limit-exceeded'
    ) {
      throw dshActivationError(
        'DSH_NATIVE_SUBAGENTS_INCOMPLETE',
        'DSH primary worker did not complete the exact requested native adviser set',
        receipt,
      )
    }
    if (!evidence.terminalMatches) {
      throw dshActivationError(
        'DSH_CHILD_EVIDENCE_INVALID',
        'DSH child result did not match its durable terminal',
        receipt,
      )
    }
    if (operation.timedOut) {
      if (result.stopReason !== 'aborted') {
        throw dshActivationError(
          'DSH_CHILD_EVIDENCE_INVALID',
          'DSH timed-out child did not publish an aborted terminal',
          receipt,
        )
      }
      receipt.output = []
      receipt.structured = null
      throw dshActivationError(
        'DSH_CHILD_TIMEOUT',
        'DSH child activation timed out',
        receipt,
      )
    }
    if (ledgerEvidence.denial !== null) {
      const failure = evidence.providerFailure
      if (!usageComplete) {
        throw dshActivationError(
          'DSH_CHILD_USAGE_INCOMPLETE',
          'DSH child did not publish complete observed token usage',
          receipt,
        )
      }
      if (
        result.stopReason !== 'error'
        || failure?.code !== DSH_TOKEN_BUDGET_FINISH_CODE
        || failure.message !== DSH_TOKEN_BUDGET_ERROR_MESSAGE
      ) {
        throw dshActivationError(
          'DSH_CHILD_EVIDENCE_INVALID',
          'DSH child token budget denial did not match its durable terminal',
          receipt,
        )
      }
      receipt.output = []
      receipt.structured = null
      receipt.artifacts = [{
        schema_version: 1,
        kind: 'dsh-activation-budget-exhausted',
        source: 'dsh-host-llm-stream-ledger',
        reason_code: 'insufficient-context-window-reservation',
        limit_tokens: ledgerEvidence.denial.limitTokens,
        charged_tokens: ledgerEvidence.chargedTokens,
        remaining_tokens: ledgerEvidence.denial.limitTokens - ledgerEvidence.chargedTokens,
        required_reservation_tokens: ledgerEvidence.denial.requiredReservationTokens,
        provider_request_started: false,
      }]
      throw dshActivationError(
        DSH_TOKEN_BUDGET_ERROR_CODE,
        DSH_TOKEN_BUDGET_ERROR_MESSAGE,
        receipt,
      )
    }
    if (result.stopReason !== 'completed') {
      const providerFailure = evidence.providerFailure
      throw dshActivationError(
        evidence.knownQuota ? 'DSH_CHILD_QUOTA' : 'DSH_CHILD_TERMINAL_ERROR',
        providerFailure?.message ?? `DSH child stopped with ${result.stopReason}`,
        receipt,
        providerFailure,
      )
    }
    if (!usageComplete && (!upperBoundCoveredUsage || policy.deniedMutation !== null)) {
      if (policy.deniedMutation !== null) {
        receipt.output = []
        receipt.structured = null
      }
      if (upperBoundCoveredUsage) attachBudgetAttestation(receipt, ledgerEvidence)
      throw dshActivationError(
        'DSH_CHILD_USAGE_INCOMPLETE',
        'DSH child did not publish complete observed token usage',
        receipt,
      )
    }
    const mutationReceipt = deniedMutationReceipt(run.localAgent.session.events, policy.deniedMutation)
    if (policy.deniedMutation !== null && mutationReceipt === undefined) {
      throw dshActivationError(
        'DSH_CHILD_EVIDENCE_INVALID',
        'DSH denied mutation did not match one durable failed tool result',
        receipt,
      )
    }
    // A durable error result proves the guard rejected the call before the
    // mutation tool ran. Keep that failed attempt in the DSH conversation, but
    // do not discard a later valid candidate merely because the model recovered
    // from an unavailable helper or scratch-file request.
    if (activation.outputSchema !== undefined && result.structured === undefined) {
      throw dshActivationError(
        'DSH_CHILD_RESULT_INVALID',
        'DSH child did not publish the requested structured output',
        receipt,
      )
    }
    attachBudgetAttestation(receipt, ledgerEvidence)
    receipt.native_subagents = nativeSubagents
    return receipt
  } finally {
    try {
      if (policy !== undefined) {
        cleanupPromise ??= budgetRuntime.close(policy, run)
        await cleanupPromise
      }
    } finally {
      operation.dispose()
    }
  }
}

function parseRpcRequest(frame, nonce) {
  let request
  try {
    request = JSON.parse(frame.toString('utf8'))
  } catch (cause) {
    throw new Error('DSH RPC request must be valid UTF-8 JSON', {cause})
  }
  if (!isRecord(request)) throw new Error('DSH RPC request must be an object')
  if (request.protocol !== DSH_RPC_PROTOCOL || request.type !== 'execute') {
    throw new Error('DSH RPC request protocol or type is invalid')
  }
  if (typeof request.request_id !== 'string' || !request.request_id.trim()) {
    throw new Error('DSH RPC request_id must be a non-empty string')
  }
  const expected = Buffer.from(nonce, 'utf8')
  const observed = typeof request.nonce === 'string' ? Buffer.from(request.nonce, 'utf8') : Buffer.alloc(0)
  if (observed.length !== expected.length || !timingSafeEqual(observed, expected)) {
    throw new Error('DSH RPC nonce is invalid')
  }
  return request
}

function readRpcFrame(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let frameBytes = null
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('end', onEnd)
      socket.off('close', onClose)
    }
    const fail = (error) => {
      cleanup()
      reject(error)
    }
    const onError = error => fail(error)
    const onEnd = () => fail(new Error('DSH RPC connection ended before one complete frame'))
    const onClose = () => fail(new Error('DSH RPC connection closed before one complete frame'))
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk])
      if (frameBytes === null && buffer.length >= 4) {
        frameBytes = buffer.readUInt32BE(0)
        if (frameBytes < 1 || frameBytes > DSH_RPC_MAX_FRAME_BYTES) {
          fail(new Error(`DSH RPC frame must be in [1, ${DSH_RPC_MAX_FRAME_BYTES}] bytes`))
          return
        }
      }
      if (frameBytes === null || buffer.length < frameBytes + 4) return
      if (buffer.length !== frameBytes + 4) {
        fail(new Error('DSH RPC connection must carry exactly one frame'))
        return
      }
      cleanup()
      socket.pause()
      resolve(buffer.subarray(4))
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('end', onEnd)
    socket.once('close', onClose)
  })
}

function writeRpcFrame(socket, value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  if (payload.length < 1 || payload.length > DSH_RPC_MAX_FRAME_BYTES) {
    return Promise.reject(new Error('DSH RPC response exceeds the maximum frame size'))
  }
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(payload.length, 0)
  return new Promise((resolve, reject) => {
    let settled = false
    const onError = error => {
      if (settled) return
      settled = true
      reject(error)
    }
    socket.on('error', onError)
    socket.once('close', () => socket.off('error', onError))
    socket.end(Buffer.concat([header, payload]), () => {
      if (settled) return
      settled = true
      resolve()
    })
  })
}

async function contractRuntime(contract, workspace, requestedRuntime) {
  let bytes
  let value
  try {
    const metadata = await stat(contract)
    if (metadata.size > MAX_CONTRACT_BYTES) {
      throw new Error(`KerSor contract exceeds the ${MAX_CONTRACT_BYTES}-byte limit`)
    }
    bytes = await readFile(contract)
    value = JSON.parse(bytes.toString('utf8'))
  } catch (cause) {
    throw new Error('KerSor contract must be valid JSON', {cause})
  }
  if (!isRecord(value)) throw new Error('KerSor contract must be an object')
  const version = value.contract_version
  if (requestedRuntime !== undefined && requestedRuntime !== 'dsh') {
    throw new Error('kersor_evolve runtime override must be dsh')
  }
  const selectedRuntime = requestedRuntime ?? value.runtime
  const selected = {
    runtime: selectedRuntime,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
  if (version === 'kersor-task-v1' && selectedRuntime !== 'dsh') {
    throw new Error('Host fixed Task execution requires runtime=dsh')
  }
  if (selectedRuntime !== 'dsh') return selected
  if (version !== 'kersor-task-v1' && version !== 'kersor-mission-v1') {
    throw new Error('runtime=dsh requires kersor-task-v1 or kersor-mission-v1')
  }
  if (version === 'kersor-mission-v1'
    && requestedRuntime !== undefined && value.runtime !== requestedRuntime) {
    throw new Error('KerSor Mission runtime differs from the requested Host runtime')
  }
  const contractOwnedPath = (candidate, label) => {
    if (typeof candidate !== 'string' || !candidate) {
      throw new Error(`runtime=dsh ${version === 'kersor-task-v1' ? 'Task' : 'Mission'} ${label} must be a non-empty path`)
    }
    return path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(path.dirname(contract), candidate)
  }
  const lexicalDeclaredWorkspace = contractOwnedPath(value.workspace, 'workspace')
  const declaredWorkspace = await realpath(lexicalDeclaredWorkspace)
  if (declaredWorkspace !== workspace) {
    throw new Error('runtime=dsh contract workspace does not match the top-level DSH workspace')
  }
  const protectedFiles = [{path: contract, label: `${version === 'kersor-task-v1' ? 'Task' : 'Mission'} contract`}]
  if (value.runtime_config !== undefined) {
    protectedFiles.push({
      path: await realpath(contractOwnedPath(value.runtime_config, 'runtime_config')),
      label: 'runtime config',
    })
  }
  if (version === 'kersor-task-v1') {
    const verifier = value.verifier
    const artifacts = isRecord(verifier) ? verifier.artifacts : undefined
    if (
      !Array.isArray(artifacts)
      || artifacts.length === 0
      || new Set(artifacts).size !== artifacts.length
      || !artifacts.every(safeTransactionArtifact)
    ) {
      throw new Error('runtime=dsh Task verifier.artifacts must be one non-empty unique canonical artifact set')
    }
    if (artifacts.some(runtimeControlArtifact)) {
      throw new Error('runtime=dsh Task artifacts must not target KerSor runtime control paths')
    }
    const incumbent = verifier.incumbent
    let candidateGate = null
    let dynamicCommitValue = false
    let rollbackOnNoncompletedStatus
    if (incumbent !== undefined && incumbent !== null) {
      if (
        !isRecord(incumbent)
        || typeof incumbent.result_path !== 'string'
        || !incumbent.result_path
        || !['minimize', 'maximize'].includes(incumbent.direction)
        || !Array.isArray(verifier.argv)
        || verifier.argv.length === 0
        || verifier.argv.some(item => typeof item !== 'string')
        || (incumbent.gate_argv !== undefined && (
          !Array.isArray(incumbent.gate_argv)
          || incumbent.gate_argv.length === 0
          || incumbent.gate_argv.some(item => typeof item !== 'string')
        ))
      ) {
        throw new Error('runtime=dsh Task verifier.incumbent is invalid')
      }
      const resultPath = incumbent.result_path
      const request = {
        protocol: 'command-v1',
        argv: [...(incumbent.gate_argv ?? verifier.argv)],
        cwd: verifier.cwd || '.',
        artifacts: [...artifacts],
        ...(verifier.timeout_seconds === undefined
          ? {}
          : {timeout_seconds: verifier.timeout_seconds}),
        ...(verifier.max_output_bytes === undefined
          ? {}
          : {max_output_bytes: verifier.max_output_bytes}),
        replay: false,
      }
      candidateGate = {
        verifier: 'task-incumbent',
        request,
        result_artifact: 'incumbent-verifier-result',
        fact_projections: [{
          output_name: 'candidate_score',
          result_path: resultPath,
        }],
        commit_projection: {
          result_path: resultPath,
          op: incumbent.direction === 'minimize' ? 'lt' : 'gt',
          value: null,
        },
      }
      dynamicCommitValue = true
      rollbackOnNoncompletedStatus = true
    }
    selected.missionPolicy = {
      kind: 'task',
      transactions: [{
        artifacts: [...artifacts],
        verifier: null,
        candidateGate,
        dynamicCommitValue,
        rollbackOnNoncompletedStatus,
      }],
      protectedFiles,
      protectedRoots: [],
    }
    return selected
  }
  const lexicalSessionRoot = contractOwnedPath(value.session, 'session')
  const sessionRelative = path.relative(lexicalDeclaredWorkspace, lexicalSessionRoot)
  if (
    !sessionRelative
    || sessionRelative === '..'
    || sessionRelative.startsWith(`..${path.sep}`)
    || path.isAbsolute(sessionRelative)
  ) {
    throw new Error('runtime=dsh Mission Session must be one proper workspace descendant')
  }
  await rejectSymlinkSegments(workspace, sessionRelative, 'runtime=dsh Mission Session')
  const sessionRoot = path.resolve(workspace, sessionRelative)
  if (!Array.isArray(value.capabilities)) {
    throw new Error('runtime=dsh Mission capabilities must be an array')
  }
  if (
    !isRecord(value.mission)
    || !Array.isArray(value.mission.authority)
    || value.mission.authority.some(item => typeof item !== 'string' || !item)
  ) {
    throw new Error('runtime=dsh Mission authority must be an array of non-empty strings')
  }
  const authority = new Set(value.mission.authority)
  const transactions = []
  const capabilityNames = new Set()
  const hostEvaluators = new Map()
  const verifierReferences = new Set()
  let admittedCount = 0
  for (const capability of value.capabilities) {
    if (!isRecord(capability)) throw new Error('runtime=dsh Mission capabilities must be objects')
    if (typeof capability.name !== 'string' || !capability.name || capabilityNames.has(capability.name)) {
      throw new Error('runtime=dsh Mission capability names must be unique and non-empty')
    }
    capabilityNames.add(capability.name)
    const requiredAuthorities = capability.required_authorities ?? []
    if (
      !Array.isArray(requiredAuthorities)
      || requiredAuthorities.some(item => typeof item !== 'string' || !item)
    ) {
      throw new Error('runtime=dsh capability required_authorities must contain non-empty strings')
    }
    const admitted = requiredAuthorities.every(item => authority.has(item))
    if (admitted) admittedCount += 1
    const execution = capability.execution ?? {kind: 'agent'}
    if (!isRecord(execution)) throw new Error('runtime=dsh Mission capability execution must be an object')
    const executionKind = execution.kind ?? 'agent'
    if (executionKind === 'host_evaluator') {
      const request = execution.request
      if (
        capability.side_effect !== 'read'
        || (capability.transaction_artifacts ?? []).length !== 0
        || !isRecord(request)
        || request.protocol !== 'command-v1'
        || !Array.isArray(request.argv)
        || request.argv.length === 0
        || request.argv.some(item => typeof item !== 'string')
        || request.filesystem_policy !== 'read-only'
        || request.network_policy !== 'denied'
        || request.output_policy !== 'sealed'
        || (request.materialize ?? []).length !== 0
      ) {
        throw new Error('runtime=dsh Host evaluator must use the registered read-only command-v1 contract')
      }
      const requestArtifacts = request.artifacts ?? []
      const timeoutSeconds = request.timeout_seconds
      const maxOutputBytes = request.max_output_bytes
      if (
        (execution.retryable !== undefined && typeof execution.retryable !== 'boolean')
        || !Array.isArray(requestArtifacts)
        || new Set(requestArtifacts).size !== requestArtifacts.length
        || !requestArtifacts.every(safeTransactionArtifact)
        || !Array.isArray(capability.produces_artifacts)
        || new Set(capability.produces_artifacts).size !== capability.produces_artifacts.length
        || capability.produces_artifacts.some(item => typeof item !== 'string' || !item)
        || !Array.isArray(capability.produces_facts)
        || new Set(capability.produces_facts).size !== capability.produces_facts.length
        || capability.produces_facts.some(item => typeof item !== 'string' || !item)
        || !Array.isArray(execution.fact_projections)
        || (timeoutSeconds !== undefined && (
          typeof timeoutSeconds !== 'number'
          || !Number.isFinite(timeoutSeconds)
          || timeoutSeconds <= 0
          || timeoutSeconds > 120
        ))
        || (maxOutputBytes !== undefined && (
          !Number.isSafeInteger(maxOutputBytes)
          || maxOutputBytes < 1
          || maxOutputBytes > 4_194_304
        ))
      ) {
        throw new Error('runtime=dsh Host evaluator has an invalid bounded output contract')
      }
      if (admitted) {
        hostEvaluators.set(capability.name, {
          request: jsonClone(request, `runtime=dsh Host evaluator ${capability.name} request`),
          retryable: execution.retryable,
          producesArtifacts: [...capability.produces_artifacts],
          producesFacts: [...capability.produces_facts],
          artifactOutputPrefixes: [...(capability.artifact_output_prefixes ?? [])],
          factOutputPrefixes: [...(capability.fact_output_prefixes ?? [])],
          factProjections: jsonClone(
            execution.fact_projections,
            `runtime=dsh Host evaluator ${capability.name} fact projections`,
          ),
          inputArtifactField: execution.input_artifact_field,
          commitProjection: execution.candidate_commit === undefined
            ? undefined
            : jsonClone(
              execution.candidate_commit,
              `runtime=dsh Host evaluator ${capability.name} commit projection`,
            ),
        })
      }
      continue
    }
    if (executionKind !== 'agent') {
      throw new Error('runtime=dsh capabilities require agent or host_evaluator execution')
    }
    const artifacts = capability.transaction_artifacts ?? []
    if (!Array.isArray(artifacts)) {
      throw new Error('runtime=dsh transaction_artifacts must be an array')
    }
    if (
      capability.commit_failed_outputs !== undefined
      && typeof capability.commit_failed_outputs !== 'boolean'
    ) {
      throw new Error('runtime=dsh commit_failed_outputs must be a boolean')
    }
    if (capability.side_effect === 'write') {
      if (
        artifacts.length !== 1
        || new Set(artifacts).size !== artifacts.length
        || !artifacts.every(safeTransactionArtifact)
      ) {
        throw new Error('runtime=dsh write capability must declare exactly one canonical transaction artifact')
      }
      if (artifacts.some(runtimeControlArtifact)) {
        throw new Error('runtime=dsh transaction artifacts must not target KerSor runtime control paths')
      }
      const verifier = capability.candidate_verifier ?? null
      if (verifier !== null && (typeof verifier !== 'string' || !verifier)) {
        throw new Error('runtime=dsh candidate_verifier must be a non-empty string')
      }
      if (verifier !== null && capability.commit_failed_outputs === true) {
        throw new Error('runtime=dsh candidate_verifier cannot commit failed outputs')
      }
      if (admitted) transactions.push({
        artifacts: [...artifacts],
        verifier,
        candidateGate: null,
        rollbackOnNoncompletedStatus: capability.commit_failed_outputs === true ? undefined : true,
      })
      if (admitted && verifier !== null) {
        verifierReferences.add(verifier)
      }
    } else if (artifacts.length > 0) {
      throw new Error('runtime=dsh transaction artifacts require side_effect=write')
    }
  }
  if (admittedCount === 0) throw new Error('runtime=dsh Mission authority admits no capabilities')
  for (const verifier of verifierReferences) {
    if (!hostEvaluators.has(verifier)) {
      throw new Error('runtime=dsh candidate_verifier must reference one Host evaluator')
    }
  }
  for (const transaction of transactions) {
    if (transaction.verifier === null) continue
    const evaluator = hostEvaluators.get(transaction.verifier)
    if (
      evaluator.retryable !== false
      || evaluator.producesArtifacts.length !== 1
      || evaluator.artifactOutputPrefixes.length !== 0
      || evaluator.producesFacts.length === 0
      || evaluator.factOutputPrefixes.length !== 0
      || evaluator.factProjections.length === 0
      || evaluator.factProjections.some(projection => !isRecord(projection) || !projection.output_name)
      || evaluator.inputArtifactField !== undefined
      || !Array.isArray(evaluator.request.artifacts)
      || evaluator.request.artifacts.length === 0
    ) {
      throw new Error('runtime=dsh Host evaluator is not a bounded candidate gate')
    }
    if (!transaction.artifacts.every(artifact => evaluator.request.artifacts.includes(artifact))) {
      throw new Error('runtime=dsh Host evaluator artifacts must include its candidate transaction')
    }
    transaction.candidateGate = {
      verifier: transaction.verifier,
      request: evaluator.request,
      result_artifact: evaluator.producesArtifacts[0],
      fact_projections: evaluator.factProjections,
      ...(evaluator.commitProjection === undefined
        ? {}
        : {commit_projection: evaluator.commitProjection}),
    }
  }
  selected.missionPolicy = {kind: 'mission', transactions, protectedFiles, protectedRoots: [sessionRoot]}
  return selected
}

async function createDshRpcHost({
  ctx,
  parent,
  workspace,
  lexicalWorkspace,
  runtime,
  missionPolicy,
  signal,
  budgetRuntime,
}) {
  const directory = await mkdtemp(path.join(runtime.temp, 'k-'))
  await chmod(directory, 0o700)
  const socketPath = path.join(directory, 's')
  const nonce = randomBytes(32).toString('hex')
  const controller = new AbortController()
  const onAbort = () => controller.abort(
    signal.reason instanceof Error ? signal.reason : new Error('KerSor DSH Host cancelled'),
  )
  signal.addEventListener('abort', onAbort, {once: true})
  if (signal.aborted) onAbort()
  const sockets = new Set()
  const tasks = new Set()
  let closing = false
  let rejectFailure
  const failure = new Promise((_, reject) => { rejectFailure = reject })
  const server = createServer(socket => {
    if (sockets.size >= MAX_RPC_CONNECTIONS || closing) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    const task = (async () => {
      let requestId = 'unknown'
      const connection = new AbortController()
      let activationSettled = false
      let onTrailingData = null
      const onHostAbort = () => connection.abort(
        controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error('KerSor DSH Host cancelled'),
      )
      const onDisconnect = () => {
        if (!activationSettled) connection.abort(new Error('KerSor core disconnected from DSH activation'))
      }
      controller.signal.addEventListener('abort', onHostAbort, {once: true})
      if (controller.signal.aborted) onHostAbort()
      socket.once('end', onDisconnect)
      socket.once('close', onDisconnect)
      try {
        const request = parseRpcRequest(await readRpcFrame(socket), nonce)
        onTrailingData = () => connection.abort(
          new Error('DSH RPC connection carried bytes after its request frame'),
        )
        socket.on('data', onTrailingData)
        socket.resume()
        requestId = request.request_id
        const result = await executeDshActivation(
          ctx,
          parent,
          workspace,
          lexicalWorkspace,
          missionPolicy,
          request.activation,
          connection.signal,
          budgetRuntime,
        )
        activationSettled = true
        await writeRpcFrame(socket, {
          protocol: DSH_RPC_PROTOCOL,
          type: 'result',
          request_id: requestId,
          ok: true,
          result,
        })
      } catch (error) {
        if (!socket.destroyed) {
          try {
            const activationFailure = error?.[DSH_RPC_ERROR]
            const rpcError = isRecord(activationFailure)
              ? {
                  code: activationFailure.code,
                  message: boundedErrorMessage(error),
                  ...(activationFailure.providerCode === undefined
                    ? {}
                    : {provider_code: activationFailure.providerCode}),
                  ...(activationFailure.providerStatus === undefined
                    ? {}
                    : {provider_status: activationFailure.providerStatus}),
                }
              : {code: 'DSH_ACTIVATION_REJECTED', message: boundedErrorMessage(error)}
            await writeRpcFrame(socket, {
              protocol: DSH_RPC_PROTOCOL,
              type: 'result',
              request_id: requestId,
              ok: false,
              error: rpcError,
              ...(isRecord(activationFailure?.result) ? {result: activationFailure.result} : {}),
            })
          } catch {
            socket.destroy()
          }
        }
      } finally {
        activationSettled = true
        controller.signal.removeEventListener('abort', onHostAbort)
        if (onTrailingData !== null) socket.removeListener('data', onTrailingData)
        socket.removeListener('end', onDisconnect)
        socket.removeListener('close', onDisconnect)
      }
    })()
    tasks.add(task)
    void task.finally(() => tasks.delete(task)).catch(() => {})
  })
  try {
    await new Promise((resolve, reject) => {
      const onListenError = error => reject(error)
      server.once('error', onListenError)
      server.listen(socketPath, () => {
        server.off('error', onListenError)
        resolve()
      })
    })
    await chmod(socketPath, 0o600)
    const [directoryMetadata, socketMetadata] = await Promise.all([lstat(directory), lstat(socketPath)])
    const currentUid = process.getuid?.()
    if (
      (directoryMetadata.mode & 0o777) !== 0o700
      || (socketMetadata.mode & 0o777) !== 0o600
      || !socketMetadata.isSocket()
      || (currentUid !== undefined && (directoryMetadata.uid !== currentUid || socketMetadata.uid !== currentUid))
    ) {
      throw new Error('KerSor DSH RPC endpoint permissions are invalid')
    }
  } catch (error) {
    server.close()
    signal.removeEventListener('abort', onAbort)
    await rm(directory, {recursive: true, force: true})
    throw error
  }
  server.on('error', error => {
    if (closing) return
    controller.abort(error)
    rejectFailure(error)
  })
  return {
    socketPath,
    nonce,
    signal: controller.signal,
    failure,
    async close() {
      if (closing) return
      closing = true
      signal.removeEventListener('abort', onAbort)
      controller.abort(new Error('KerSor DSH RPC Host closed'))
      for (const socket of sockets) socket.destroy()
      await Promise.allSettled([...tasks])
      await new Promise(resolve => server.close(() => resolve()))
      await rm(directory, {recursive: true, force: true})
    },
  }
}

async function topLevelWorkspace(agent) {
  if (agent === undefined) throw new Error('kersor_evolve requires a calling DSH agent')
  if (agent.session.header.origin === 'subagent') {
    throw new Error('kersor_evolve is available only in a top-level DSH conversation')
  }
  const cwd = agent.session.header.cwd
  if (typeof cwd !== 'string' || !cwd) throw new Error('kersor_evolve requires a DSH workspace')
  return {
    workspace: await realpath(cwd),
    lexicalWorkspace: path.resolve(cwd),
    session: agent.session,
  }
}

function toolCallTurn(session, callId) {
  const events = Array.isArray(session?.events) ? session.events : []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'tool/call' || event.data?.callId !== callId) continue
    return Number.isInteger(event.data.turn) && event.data.turn > 0
      ? event.data.turn
      : undefined
  }
  return undefined
}

function executionTurn(session, exec) {
  const directTurn = toolCallTurn(session, exec.callId)
  if (directTurn !== undefined) return directTurn
  if (exec.rootCallId === undefined || exec.rootCallId === exec.callId) return undefined
  return toolCallTurn(session, exec.rootCallId)
}

function isEvolveLaunchEvent(event) {
  return (event?.type === 'tool/call' && event.data?.name === 'kersor_evolve')
    || (event?.type === 'command/run' && event.data?.name === COMMAND_NAME)
}

function hasPriorEvolveCall(session, exec) {
  const events = Array.isArray(session?.events) ? session.events : []
  const currentCallIds = new Set([exec.callId, exec.rootCallId].filter(value => value !== undefined))
  let currentIndex = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'tool/call' && currentCallIds.has(event.data?.callId)) {
      currentIndex = index
      break
    }
  }
  if (currentIndex < 0) return false
  return events.slice(0, currentIndex).some(isEvolveLaunchEvent)
}

function claimSession(session, exec) {
  if (!isRecord(session)) throw new Error('kersor_evolve requires a stable DSH session')
  if (CLAIMED_SESSIONS.has(session) || hasPriorEvolveCall(session, exec)) {
    throw new Error('kersor_evolve permits only one call per top-level DSH session; retry in a new session')
  }
  const turn = executionTurn(session, exec)
  if (turn === undefined) {
    throw new Error('kersor_evolve could not bind its top-level DSH turn')
  }
  CLAIMED_SESSIONS.add(session)
  CLAIMED_TURNS.set(session, turn)
}

function commandRunIndex(session, commandId) {
  const events = Array.isArray(session?.events) ? session.events : []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'command/run' && event.data?.commandId === commandId) return index
  }
  return -1
}

function claimCommandSession(session, commandId) {
  if (!isRecord(session)) throw new Error('kersor_evolve requires a stable DSH session')
  const currentIndex = commandRunIndex(session, commandId)
  if (currentIndex < 0) throw new Error('kersor_evolve could not bind its DSH command lifecycle')
  const events = session.events
  const prior = events.slice(0, currentIndex).some(isEvolveLaunchEvent)
  if (CLAIMED_SESSIONS.has(session) || prior) {
    throw new Error('kersor_evolve permits only one launch per top-level DSH session; retry in a new session')
  }
  CLAIMED_SESSIONS.add(session)
}

function claimedTurnGuard(exec) {
  const session = exec.agent?.session
  if (!isRecord(session)) return undefined
  const claimedTurn = CLAIMED_TURNS.get(session)
  if (claimedTurn === undefined) return undefined
  const currentTurn = executionTurn(session, exec)
  if (currentTurn === claimedTurn || currentTurn === undefined) {
    return 'kersor_evolve owns the rest of this DSH turn; later tool calls are denied'
  }
  return undefined
}

async function contractPath(value, workspace, requestedRuntime) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error('kersor_evolve contract must be an absolute path')
  }
  const lexical = path.resolve(value)
  const metadata = await lstat(lexical)
  const physical = await realpath(lexical)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('kersor_evolve contract must be one canonical non-symlink file')
  }
  if (!inside(workspace, physical)) {
    const parentOwnedTask = requestedRuntime === 'dsh'
      && path.basename(physical) === 'task.json'
      && path.basename(workspace) === 'workspace'
      && path.dirname(physical) === path.dirname(workspace)
    if (!parentOwnedTask) {
      throw new Error('kersor_evolve contract must stay inside the current DSH workspace or be its parent-owned task.json')
    }
  }
  return physical
}

function optionalRunDir(value, workspace, resume) {
  if (resume === true && value === undefined) {
    throw new Error('kersor_evolve resume requires run_dir')
  }
  if (value === undefined) return null
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error('kersor_evolve run_dir must be an absolute path')
  }
  const normalized = path.resolve(value)
  if (!inside(workspace, normalized)) {
    throw new Error('kersor_evolve run_dir must stay inside the current DSH workspace')
  }
  return normalized
}

function optionalPredecessorRun(value, workspace, resume) {
  if (value === undefined) return null
  if (resume) throw new Error('kersor_evolve predecessor_run cannot be combined with resume')
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error('kersor_evolve predecessor_run must be an absolute path')
  }
  const normalized = path.resolve(value)
  if (!inside(workspace, normalized)) {
    throw new Error('kersor_evolve predecessor_run must stay inside the current DSH workspace')
  }
  return normalized
}

function commandArguments(rawInput) {
  let value
  try {
    value = JSON.parse(String(rawInput ?? '').trim())
  } catch (cause) {
    throw new Error('/kersor-evolve requires one JSON object', {cause})
  }
  if (!isRecord(value)) throw new Error('/kersor-evolve requires one JSON object')
  const allowed = new Set(['contract', 'runtime', 'run_dir', 'resume', 'predecessor_run'])
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new Error('/kersor-evolve JSON contains an unsupported field')
  }
  if (typeof value.contract !== 'string' || !value.contract) {
    throw new Error('/kersor-evolve JSON requires contract')
  }
  if (value.runtime !== 'dsh') {
    throw new Error('/kersor-evolve runtime must be dsh')
  }
  if (value.resume !== undefined && typeof value.resume !== 'boolean') {
    throw new Error('/kersor-evolve resume must be boolean')
  }
  for (const key of ['run_dir', 'predecessor_run']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      throw new Error(`/kersor-evolve ${key} must be a string`)
    }
  }
  return value
}

async function executeEvolve(args, {
  ctx,
  budgetRuntime,
  agent,
  signal,
  timeoutMs,
}) {
  const {workspace, lexicalWorkspace} = await topLevelWorkspace(agent)
  const contract = await contractPath(args.contract, workspace, args.runtime)
  const resume = args.resume === true
  const runDir = optionalRunDir(args.run_dir, workspace, resume)
  const predecessorRun = optionalPredecessorRun(args.predecessor_run, workspace, resume)
  const runtime = await installedRuntime(workspace)
  const selectedContract = await contractRuntime(contract, workspace, args.runtime)
  if (selectedContract.runtime === 'dsh' && !ctx?.subagents) {
    throw new Error('runtime=dsh requires the DSH subagent Host service')
  }
  if (selectedContract.runtime === 'dsh' && !budgetRuntime) {
    throw new Error('runtime=dsh requires the DSH activation token budget Host')
  }
  const argv = [
    runtime.bridge,
    'evolve',
    '--host-execution',
    '--contract',
    contract,
    ...(args.runtime === undefined ? [] : ['--runtime', args.runtime]),
    '--expected-contract-sha256',
    selectedContract.sha256,
  ]
  if (typeof selectedContract.runtime === 'string') {
    argv.push('--expected-runtime', selectedContract.runtime)
  }
  if (runDir !== null) argv.push('--run-dir', runDir)
  if (predecessorRun !== null) argv.push('--predecessor-run', predecessorRun)
  if (resume) argv.push('--resume')
  let rpc = null
  let completed
  try {
    if (selectedContract.runtime === 'dsh') {
      rpc = await createDshRpcHost({
        ctx,
        parent: agent,
        workspace,
        lexicalWorkspace,
        runtime,
        missionPolicy: selectedContract.missionPolicy,
        signal,
        budgetRuntime,
      })
    }
    const process = runHostProcess({
      command: runtime.python,
      args: argv,
      cwd: workspace,
      environment: rpc === null ? hostEnvironment(runtime) : dshHostEnvironment(runtime, rpc),
      signal: rpc === null ? signal : rpc.signal,
      // DSH owns per-activation and evaluator deadlines. One Core run may
      // contain several, so a process-wide watchdog would kill a valid later
      // round and discard its transaction.
      timeoutMs: selectedContract.runtime === 'dsh' ? null : timeoutMs,
    })
    if (rpc === null) {
      completed = await process
    } else {
      try {
        completed = await Promise.race([process, rpc.failure])
      } catch (error) {
        await Promise.allSettled([process])
        throw error
      }
    }
  } finally {
    if (rpc !== null) await rpc.close()
  }
  let terminal
  try {
    terminal = parseTerminalJson(completed.stdout)
  } catch (cause) {
    const detail = String(completed.stderr || completed.stdout || `exit ${completed.code}`).trim().slice(-4_096)
    throw new Error(
      `KerSor Host bridge failed with exit ${completed.code}: ${cause.message}; ${detail}`,
      {cause},
    )
  }
  const expectedExit = terminal.status === 'completed' ? 0 : 2
  if (completed.code !== expectedExit) {
    throw new Error(
      `KerSor Host bridge returned ${terminal.status} with exit ${completed.code}; expected ${expectedExit}`,
    )
  }
  return terminal
}

export function createTool({
  ctx,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  budgetRuntime = ctx?.[DSH_BUDGET_RUNTIME],
} = {}) {
  return {
    name: 'kersor_evolve',
    description: 'Run exactly one frozen kersor-task-v1 or kersor-mission-v1 contract through the Host-owned KerSor launcher. A Mission stays inside the top-level DSH workspace; a fixed Task may use the canonical parent task.json whose declared workspace is the current workspace. This call owns the rest of the turn.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        contract: {type: 'string', description: 'Absolute path to one frozen kersor-task-v1 or kersor-mission-v1 JSON contract.'},
        runtime: {type: 'string', enum: ['dsh'], description: 'Required DSH Host override for a fixed Task whose portable contract names another default runtime.'},
        run_dir: {type: 'string', description: 'Optional absolute existing Mission run directory for explicit resume.'},
        resume: {type: 'boolean', description: 'Resume exactly run_dir. Defaults to false.'},
        predecessor_run: {type: 'string', description: 'Optional terminal Fixed Task run whose immutable candidate snapshot seeds one fresh successor run.'},
      },
      required: ['contract'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          status: {type: 'string', enum: ['completed', 'blocked', 'waiting', 'failed']},
          revision: {oneOf: [{type: 'integer'}, {type: 'null'}]},
          run_dir: {type: 'string'},
          error: {type: 'string'},
        },
        required: ['status'],
      },
      render: (_args, value) => [{type: 'text', text: JSON.stringify(value)}],
      presentationMeta: (_args, value) => ({status: value.status}),
    },
    async execute(args, exec) {
      const {workspace, session} = await topLevelWorkspace(exec.agent)
      await contractPath(args.contract, workspace, args.runtime)
      claimSession(session, exec)
      try {
        const terminal = await executeEvolve(args, {
          ctx,
          budgetRuntime,
          agent: exec.agent,
          signal: exec.signal,
          timeoutMs,
        })
        exec.concludeTurn()
        return terminal
      } catch (error) {
        if (exec.signal.aborted) throw error
        exec.concludeTurn()
        return {
          status: 'failed',
          revision: null,
          error: String(error?.message ?? error).trim().slice(-4_096),
        }
      }
    },
    presentCall: () => ({card: 'generic', title: 'Run KerSor Mission', kind: 'execute'}),
    presentResult(_args, result) {
      if (result.isError) return {card: 'generic', title: 'KerSor Mission failed'}
      return {card: 'generic', title: `KerSor Mission · ${result.meta?.status ?? 'finished'}`, content: result.content}
    },
  }
}

export function createCommand({
  ctx,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  budgetRuntime = ctx?.[DSH_BUDGET_RUNTIME],
} = {}) {
  return {
    name: COMMAND_NAME,
    engagesSession: true,
    description: 'Run one frozen KerSor contract directly through the Host without a model request.',
    input: {hint: '{"contract":"/absolute/task.json","runtime":"dsh"}'},
    async handler(invocation) {
      const args = commandArguments(invocation.rawInput)
      const {workspace, session} = await topLevelWorkspace(invocation.agent)
      await contractPath(args.contract, workspace, args.runtime)
      claimCommandSession(session, invocation.commandId)
      const terminal = await executeEvolve(args, {
        ctx,
        budgetRuntime,
        agent: invocation.agent,
        signal: invocation.signal,
        timeoutMs,
      })
      const text = JSON.stringify(terminal)
      return terminal.status === 'completed'
        ? {kind: 'success', text}
        : {kind: 'error', text}
    },
  }
}

export function apply(ctx) {
  const budgetRuntime = createDshBudgetRuntime(ctx)
  Object.defineProperty(ctx, DSH_BUDGET_RUNTIME, {
    value: budgetRuntime,
    configurable: true,
  })
  ctx.tools.guard(claimedTurnGuard)
  ctx.on('agent/created', ({agent}) => {
    const policy = CHILD_POLICY.getStore() ?? budgetRuntime.policyFor(agent)
    if (policy === undefined) return
    const role = budgetRuntime.bind(policy, agent)
    if (role === 'adviser') {
      agent.ctx.tools.restrict({allow: [...DSH_READ_TOOLS]})
    }
    agent.ctx.tools.guard(policy.guard)
    installChildToolGuidance(
      agent,
      role === 'primary' ? policy.transactionArtifacts : [],
      role === 'primary' ? policy.nativeSubagents : 0,
    )
    policy.guardedAgents.add(agent)
  }, {global: true})
  ctx.tools.register(createTool({ctx, budgetRuntime}))
  ctx.commands.register(createCommand({ctx, budgetRuntime}))
}

export const __test = Object.freeze({
  PRESET_ROOT,
  BRIDGE,
  RUNTIME_TOOLS,
  KERSOR_ROOT,
})
