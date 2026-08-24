/** Host-owned launcher and DSH-native activation broker for one KerSor Mission. */

import { spawn } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants, lstatSync, realpathSync } from 'node:fs'
import { access, chmod, lstat, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'


export const name = 'kersor-evolve'
export const inject = ['tools', 'subagents']

const PRESET_ROOT = fileURLToPath(new URL('..', import.meta.url))
const BRIDGE = fileURLToPath(new URL('../bin/kersor_bridge.py', import.meta.url))
const RUNTIME_TOOLS = fileURLToPath(new URL('../.local/runtime-tools.json', import.meta.url))
const KERSOR_ROOT = fileURLToPath(new URL('../.local/kersor-root', import.meta.url))
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const KILL_GRACE_MS = 2_000
export const DSH_RPC_PROTOCOL = 'kersor-dsh-host-rpc-v1'
export const DSH_RPC_MAX_FRAME_BYTES = 16 * 1024 * 1024
export const DSH_PROVIDER = 'deepseek-official'
export const DSH_MODEL = 'deepseek-v4-flash'
const DSH_RPC_SOCKET_ENV = 'KERSOR_DSH_RPC_SOCKET'
const DSH_RPC_NONCE_ENV = 'KERSOR_DSH_RPC_NONCE'
const DSH_READ_TOOLS = Object.freeze(['read', 'glob', 'grep'])
const DSH_WRITE_TOOLS = Object.freeze(['edit', 'write'])
const DSH_STRUCTURED_OUTPUT_TOOL = 'structured_output'
const DSH_MAX_ACTIVATION_TIMEOUT_SECONDS = 900
const MAX_RPC_CONNECTIONS = 64
const MAX_RPC_ERROR_BYTES = 4_096
const TERMINAL_STATUSES = new Set(['completed', 'blocked', 'waiting', 'failed'])
const CLAIMED_SESSIONS = new WeakSet()
const CLAIMED_TURNS = new WeakMap()
const CHILD_POLICY = new AsyncLocalStorage()

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
    const timer = setTimeout(
      () => terminate(new Error(`KerSor Host execution timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    timer.unref?.()
    signal?.addEventListener('abort', onAbort, {once: true})
    child.stdout.on('data', capture(stdout))
    child.stderr.on('data', capture(stderr))
    child.once('error', error => {
      terminalError ??= new Error(`failed to start KerSor Host bridge: ${error.message}`, {cause: error})
    })
    child.once('close', (code, exitSignal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
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

function childUsage(agent) {
  const events = agent?.session?.events
  if (!Array.isArray(events)) throw new Error('DSH child did not expose a durable Session event log')
  const usage = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  }
  let observed = false
  for (const event of events) {
    if (event?.type !== 'assistant/message' || event?.data?.usage === undefined) continue
    if (!isRecord(event.data.usage)) throw new Error('DSH child published malformed token usage')
    const input = safeTokenCount(event.data.usage.inputTokens, 'inputTokens')
    const output = safeTokenCount(event.data.usage.outputTokens, 'outputTokens')
    const cacheRead = event.data.usage.cacheReadTokens === undefined
      ? 0
      : safeTokenCount(event.data.usage.cacheReadTokens, 'cacheReadTokens')
    const cacheWrite = event.data.usage.cacheWriteTokens === undefined
      ? 0
      : safeTokenCount(event.data.usage.cacheWriteTokens, 'cacheWriteTokens')
    for (const [key, increment] of [
      ['input_tokens', input],
      ['cached_input_tokens', cacheRead + cacheWrite],
      ['output_tokens', output],
      ['total_tokens', input + cacheRead + cacheWrite + output],
    ]) {
      usage[key] = safeTokenCount(usage[key] + increment, `aggregate ${key}`)
    }
    observed = true
  }
  if (!observed) throw new Error('DSH child did not publish observed token usage')
  return usage
}

function activationModelRole(value) {
  if (Object.hasOwn(value, 'model_role') || Object.hasOwn(value, 'modelRole')) {
    throw new Error('DSH RPC activation model_role is Host-derived from phase and must not be supplied')
  }
  if (typeof value.phase !== 'string') {
    throw new Error('DSH RPC activation phase must be a string')
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
  if (value.schema !== undefined && !isRecord(value.schema)) {
    throw new Error('DSH RPC activation schema must be an object')
  }
  const timeoutSeconds = value.timeout_seconds ?? DSH_MAX_ACTIVATION_TIMEOUT_SECONDS
  if (
    typeof timeoutSeconds !== 'number'
    || !Number.isFinite(timeoutSeconds)
    || timeoutSeconds <= 0
    || timeoutSeconds > DSH_MAX_ACTIVATION_TIMEOUT_SECONDS
  ) {
    throw new Error(`DSH RPC activation timeout_seconds must be in (0, ${DSH_MAX_ACTIVATION_TIMEOUT_SECONDS}]`)
  }
  const modelRole = activationModelRole(value)
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
      || transaction.artifacts.length !== 1
      || new Set(transaction.artifacts).size !== transaction.artifacts.length
      || !transaction.artifacts.every(safeTransactionArtifact)
    ) {
      throw new Error('DSH activation transaction must declare exactly one canonical artifact')
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
        : hasCandidateGate && isRecord(transaction.candidate_gate)
          && sameJson(transaction.candidate_gate, item.candidateGate)
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
    transactionArtifacts,
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

function readOnlyChildGuard(workspace, lexicalWorkspace, activation, execution) {
  if (execution.name === DSH_STRUCTURED_OUTPUT_TOOL) return undefined
  if (DSH_WRITE_TOOLS.includes(execution.name)) {
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
    return pathInsideWorkspace(workspace, lexicalWorkspace, execution.arguments.file_path, 'read.file_path')
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
  return pathInsideWorkspace(workspace, lexicalWorkspace, searchPath, `${execution.name}.path`)
}

function activationSignal(parent, timeoutSeconds) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(
    parent.reason instanceof Error ? parent.reason : new Error('KerSor DSH activation cancelled'),
  )
  parent.addEventListener('abort', onAbort, {once: true})
  if (parent.aborted) onAbort()
  const timer = setTimeout(
    () => controller.abort(new Error(`KerSor DSH activation timed out after ${timeoutSeconds}s`)),
    timeoutSeconds * 1_000,
  )
  timer.unref?.()
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      parent.removeEventListener('abort', onAbort)
    },
  }
}

async function executeDshActivation(ctx, parent, workspace, lexicalWorkspace, missionPolicy, activationValue, hostSignal) {
  const activation = await readOnlyActivation(activationValue, workspace, missionPolicy)
  const operation = activationSignal(hostSignal, activation.timeoutSeconds)
  const policy = {
    guardedAgents: new Set(),
    guard: execution => readOnlyChildGuard(workspace, lexicalWorkspace, activation, execution),
  }
  let run
  try {
    run = await CHILD_POLICY.run(policy, () => ctx.subagents.start('spawn', {
      label: activation.label,
      prompt: activation.prompt,
      parent,
      signal: operation.signal,
      agentOptions: {provider: DSH_PROVIDER, model: DSH_MODEL},
      ...activation.outputSchema === undefined ? {} : {outputSchema: activation.outputSchema},
      toolFilter: {allow: [
        ...DSH_READ_TOOLS,
        ...(activation.transactionArtifacts.length > 0 ? DSH_WRITE_TOOLS : []),
      ]},
    }))
    if (!run?.localAgent || !policy.guardedAgents.has(run.localAgent)) {
      throw new Error('DSH spawn did not publish a locally guarded child')
    }
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
    if (activation.outputSchema !== undefined && result.structured === undefined) {
      throw new Error('DSH child did not publish the requested structured output')
    }
    const usage = childUsage(run.localAgent)
    const threadId = String(run.id ?? run.localAgent.id ?? '')
    if (!threadId) throw new Error('DSH spawn did not publish a child thread id')
    return {
      output: jsonClone(result.output ?? [], 'DSH child output'),
      structured: result.structured === undefined
        ? null
        : jsonClone(result.structured, 'DSH child structured output'),
      stop_reason: result.stopReason,
      usage,
      usage_observed: true,
      usage_complete: true,
      thread_id: threadId,
      provider: DSH_PROVIDER,
      model: DSH_MODEL,
      model_role: activation.modelRole,
      isolation: 'fresh-dsh-subagent',
      artifacts: [],
    }
  } finally {
    try {
      if (run !== undefined) await run.dispose()
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

async function missionRuntime(contract, workspace) {
  let bytes
  let value
  try {
    bytes = await readFile(contract)
    value = JSON.parse(bytes.toString('utf8'))
  } catch (cause) {
    throw new Error('KerSor Mission contract must be valid JSON', {cause})
  }
  if (!isRecord(value)) throw new Error('KerSor Mission contract must be an object')
  const selected = {
    runtime: value.runtime,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
  if (value.runtime !== 'dsh') return selected
  if (value.contract_version !== 'kersor-mission-v1') {
    throw new Error('runtime=dsh is supported only for kersor-mission-v1')
  }
  const contractOwnedPath = (candidate, label) => {
    if (typeof candidate !== 'string' || !candidate) {
      throw new Error(`runtime=dsh Mission ${label} must be a non-empty path`)
    }
    return path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(path.dirname(contract), candidate)
  }
  const lexicalDeclaredWorkspace = contractOwnedPath(value.workspace, 'workspace')
  const declaredWorkspace = await realpath(lexicalDeclaredWorkspace)
  if (declaredWorkspace !== workspace) {
    throw new Error('runtime=dsh Mission workspace does not match the top-level DSH workspace')
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
  const protectedFiles = [{path: contract, label: 'Mission contract'}]
  if (value.runtime_config !== undefined) {
    protectedFiles.push({
      path: await realpath(contractOwnedPath(value.runtime_config, 'runtime_config')),
      label: 'runtime config',
    })
  }
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
  selected.missionPolicy = {transactions, protectedFiles, protectedRoots: [sessionRoot]}
  return selected
}

async function createDshRpcHost({ctx, parent, workspace, lexicalWorkspace, runtime, missionPolicy, signal}) {
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
      socket.once('close', onDisconnect)
      try {
        const request = parseRpcRequest(await readRpcFrame(socket), nonce)
        requestId = request.request_id
        const result = await executeDshActivation(
          ctx,
          parent,
          workspace,
          lexicalWorkspace,
          missionPolicy,
          request.activation,
          connection.signal,
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
            await writeRpcFrame(socket, {
              protocol: DSH_RPC_PROTOCOL,
              type: 'result',
              request_id: requestId,
              ok: false,
              error: {code: 'DSH_ACTIVATION_REJECTED', message: boundedErrorMessage(error)},
            })
          } catch {
            socket.destroy()
          }
        }
      } finally {
        activationSettled = true
        controller.signal.removeEventListener('abort', onHostAbort)
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

async function topLevelWorkspace(exec) {
  if (exec.agent === undefined) throw new Error('kersor_evolve requires a calling DSH agent')
  if (exec.agent.session.header.origin === 'subagent') {
    throw new Error('kersor_evolve is available only in a top-level DSH conversation')
  }
  const cwd = exec.agent.session.header.cwd
  if (typeof cwd !== 'string' || !cwd) throw new Error('kersor_evolve requires a DSH workspace')
  return {
    workspace: await realpath(cwd),
    lexicalWorkspace: path.resolve(cwd),
    session: exec.agent.session,
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

function claimSession(session, exec) {
  if (!isRecord(session)) throw new Error('kersor_evolve requires a stable DSH session')
  if (CLAIMED_SESSIONS.has(session)) {
    throw new Error('kersor_evolve permits only one call per top-level DSH session; retry in a new session')
  }
  const turn = executionTurn(session, exec)
  if (turn === undefined) {
    throw new Error('kersor_evolve could not bind its top-level DSH turn')
  }
  CLAIMED_SESSIONS.add(session)
  CLAIMED_TURNS.set(session, turn)
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

async function missionPath(value, workspace) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error('kersor_evolve contract must be an absolute path')
  }
  const physical = await realpath(value)
  if (!inside(workspace, physical)) {
    throw new Error('kersor_evolve contract must stay inside the current DSH workspace')
  }
  if (!(await stat(physical)).isFile()) throw new Error('kersor_evolve contract must be a file')
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

export function createTool({ctx, timeoutMs = DEFAULT_TIMEOUT_MS} = {}) {
  return {
    name: 'kersor_evolve',
    description: 'Run exactly one frozen kersor-mission-v1 contract through the Host-owned KerSor launcher. The contract must be an absolute file inside the current top-level DSH workspace. This call owns the rest of the turn.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        contract: {type: 'string', description: 'Absolute path to one frozen kersor-mission-v1 JSON contract.'},
        run_dir: {type: 'string', description: 'Optional absolute existing Mission run directory for explicit resume.'},
        resume: {type: 'boolean', description: 'Resume exactly run_dir. Defaults to false.'},
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
      const {workspace, lexicalWorkspace, session} = await topLevelWorkspace(exec)
      const contract = await missionPath(args.contract, workspace)
      claimSession(session, exec)
      try {
        const resume = args.resume === true
        const runDir = optionalRunDir(args.run_dir, workspace, resume)
        const runtime = await installedRuntime(workspace)
        const selectedContract = await missionRuntime(contract, workspace)
        if (selectedContract.runtime === 'dsh' && !ctx?.subagents) {
          throw new Error('runtime=dsh requires the DSH subagent Host service')
        }
        const argv = [
          runtime.bridge,
          'evolve',
          '--host-execution',
          '--contract',
          contract,
          '--expected-contract-sha256',
          selectedContract.sha256,
        ]
        if (typeof selectedContract.runtime === 'string') {
          argv.push('--expected-runtime', selectedContract.runtime)
        }
        if (runDir !== null) argv.push('--run-dir', runDir)
        if (resume) argv.push('--resume')
        let rpc = null
        let completed
        try {
          if (selectedContract.runtime === 'dsh') {
            rpc = await createDshRpcHost({
              ctx,
              parent: exec.agent,
              workspace,
              lexicalWorkspace,
              runtime,
              missionPolicy: selectedContract.missionPolicy,
              signal: exec.signal,
            })
          }
          const process = runHostProcess({
            command: runtime.python,
            args: argv,
            cwd: workspace,
            environment: rpc === null ? hostEnvironment(runtime) : dshHostEnvironment(runtime, rpc),
            signal: rpc === null ? exec.signal : rpc.signal,
            timeoutMs,
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

export function apply(ctx) {
  ctx.tools.guard(claimedTurnGuard)
  ctx.on('agent/created', ({agent}) => {
    const policy = CHILD_POLICY.getStore()
    if (policy === undefined) return
    agent.ctx.tools.guard(policy.guard)
    policy.guardedAgents.add(agent)
  })
  ctx.tools.register(createTool({ctx}))
}

export const __test = Object.freeze({PRESET_ROOT, BRIDGE, RUNTIME_TOOLS, KERSOR_ROOT})
