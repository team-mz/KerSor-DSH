/** DSH-native KerSor experiment start, attach, progress, and resume contracts. */

import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type JsonValue, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { SubagentListEntry, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import * as BashEnv from '@deepseek-ai/dsh-shell-env'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import type { KersorLaunchContract } from '../src/types.ts'
import * as control from '../src/control.ts'

const signal = new AbortController().signal
const testKersorPython = realpathSync(execFileSync(
  'python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' },
).trim())
const testKersorRoot = realpathSync.native(join(process.cwd(), '..', 'KerSor'))
const testSetupAdapter = realpathSync.native(join(testKersorRoot, 'scripts', 'setup-session.sh'))
const originalKersorPython = process.env.KERSOR_PYTHON
const originalKersorRoot = process.env.KERSOR_ROOT
const launchContract = {
  backend: 'python',
  language: 'python_reference',
  integration_pattern: 'replace_kernel_entrypoint',
  target_speedup: 8,
  max_workflows: 4,
  mode: 'auto',
  workflow_authoring_budget: 2,
  retrieval_mode: 'off',
  transfer_mode: 'measured-only',
  experience_mode: 'off',
  kernelwiki_experience_export_mode: 'off',
  correctness_command: 'python3 verify.py --case baseline',
  benchmark_command: 'python3 benchmark.py --rounds 5',
} satisfies KersorLaunchContract
const workflowMeta = {
  name: 'prepared-workflow',
  description: 'Execute one prepared Workflow exactly.',
  phases: [{ title: 'Optimize', detail: 'Read and optimize the current kernel.' }],
}
const workflowBody = "phase('Optimize')\nreturn { best_kernel_code: 'candidate' }"
const workflowSource = `export const meta = ${JSON.stringify(workflowMeta)}\n${workflowBody}`

interface MutableFileBinding {
  path: string
  sha256: string
}

interface BaselineWitnessFixture {
  executions: Array<Record<string, unknown> & {
    kind: string
    command: string
    exit_code: number
    timed_out: boolean
    stdout: string
    stderr: string
  }>
}

interface BaselinePhaseData extends Record<string, unknown> {
  call_id: string
  initialization_receipt?: MutableFileBinding
  recording_receipt?: MutableFileBinding
}

interface MutableWorkflowEnvelope {
  script: string
  args: { target_speedup: number }
  meta: {
    name: string
    description: string
    phases: Array<Record<string, unknown> & { provider?: string }>
  }
  source: {
    workflow_path: string
    workflow_sha256: string
    effective_script_sha256: string
    projected_meta_sha256: string
    model_policy: string
    child_tool_policy: { tools: string[] }
  }
}

interface MutableCompatibility {
  workflow_source: string
  workflow_sha256: string
  effective_script_sha256: string
  projected_meta_sha256: string
  model_policy: string
  child_tool_policy: { tools: string[] }
}

function readJsonFixture(path: string): unknown {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  return value
}

function effectiveWorkflowScript(body: string): string {
  return [
    'return await (async () => {',
    '  const __kersor_dsh_controller_agent_v1__ = ((nativeAgent) => {',
    '    return (prompt, options = {}) => {',
    '      if (options === null || typeof options !== \'object\' || Array.isArray(options)) {',
    '        return nativeAgent(prompt, options)',
    '      }',
    '      const { provider: _provider, model: _model, toolFilter: _toolFilter, ...inheritedOptions } = options',
    '      return nativeAgent(prompt, {',
    '        ...inheritedOptions,',
    '        toolFilter: { allow: ["glob","grep","read"] },',
    '      })',
    '    }',
    '  })(agent)',
    '  Object.defineProperty(globalThis, \'agent\', {',
    '    value: __kersor_dsh_controller_agent_v1__,',
    '    writable: false,',
    '    configurable: false,',
    '    enumerable: true,',
    '  })',
    '  {',
    '    const agent = __kersor_dsh_controller_agent_v1__',
    body,
    '  }',
    '})()',
  ].join('\n')
}

const workflowScript = effectiveWorkflowScript(workflowBody)

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function jsonFileRecord(path: string): {
  readonly path: string
  readonly file_sha256: string
  readonly value_sha256: string
} {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  return {
    path,
    file_sha256: fileSha256(path),
    value_sha256: sha256(canonicalJson(value)),
  }
}

function testWorktreeSnapshot(
  projectRoot: string,
  sessionDir: string,
): Record<string, unknown> {
  let gitRoot: string
  try {
    gitRoot = realpathSync(execFileSync(
      'git', ['-C', projectRoot, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim())
  } catch {
    return {
      git_root: null,
      tracked_diff_sha256: null,
      staged_diff_sha256: null,
      untracked: {},
    }
  }
  const tracked = execFileSync(
    'git', ['-C', gitRoot, 'diff', '--binary', '--no-ext-diff', '--', '.'],
  )
  const staged = execFileSync(
    'git', ['-C', gitRoot, 'diff', '--cached', '--binary', '--no-ext-diff', '--', '.'],
  )
  const allowedPrefix = `${relative(gitRoot, sessionDir).split('\\').join('/')}/`
  const untracked: Record<string, string> = {}
  const paths = execFileSync(
    'git', ['-C', gitRoot, 'ls-files', '--others', '--exclude-standard', '-z'],
  ).toString('utf8').split('\0').filter(Boolean)
  for (const path of paths) {
    if (path === relative(gitRoot, sessionDir) || path.startsWith(allowedPrefix)) continue
    untracked[path] = fileSha256(join(gitRoot, path))
  }
  return {
    git_root: gitRoot,
    tracked_diff_sha256: createHash('sha256').update(tracked).digest('hex'),
    staged_diff_sha256: createHash('sha256').update(staged).digest('hex'),
    untracked,
  }
}

function collectRegularFiles(path: string, selected: Set<string>): void {
  if (!existsSync(path)) return
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) collectRegularFiles(child, selected)
    else if (entry.isFile()) selected.add(realpathSync(child))
  }
}

function testProtectedFiles(projectRoot: string, kernelPath: string): Record<string, string> {
  const selected = new Set<string>([realpathSync(kernelPath)])
  for (const name of ['problem.py', 'kersor-task.json']) {
    const path = join(projectRoot, name)
    if (existsSync(path)) selected.add(realpathSync(path))
  }
  collectRegularFiles(join(projectRoot, 'tests'), selected)
  collectRegularFiles(join(projectRoot, 'oracles'), selected)
  return Object.fromEntries([...selected].sort().map(path => [
    relative(projectRoot, path).split('\\').join('/'),
    fileSha256(path),
  ]))
}

function writeValidSessionState(
  sessionDir: string,
  round = 1,
  sessionId = basename(sessionDir),
): void {
  writeFileSync(join(sessionDir, 'state.json'), JSON.stringify({
    schema_version: 2,
    phase: 'optimizing',
    current_round: round,
    stall_count: 0,
    pending_terminal: '',
    prepared: true,
    session_id: sessionId,
    target_speedup: launchContract.target_speedup,
    target_override: false,
    workflows_filter: [],
    seed_origin: 'provided_kernel',
    kernel_language: launchContract.language,
    backend: launchContract.backend,
    integration_pattern: launchContract.integration_pattern,
    yolo: false,
    extensions: {},
  }))
}

function writeValidSetupArtifacts(
  workspace: string,
  sessionDir: string,
  launch: KersorLaunchContract = launchContract,
  controllerSessionId = '',
): void {
  const canonicalWorkspace = realpathSync(workspace)
  mkdirSync(sessionDir, { recursive: true })
  const canonicalSession = realpathSync(sessionDir)
  const kernelPath = join(canonicalWorkspace, 'kernel.py')
  if (!existsSync(kernelPath)) writeFileSync(kernelPath, 'VALUE = 1\n')
  writeFileSync(join(canonicalSession, 'session-config.json'), JSON.stringify({
    schema_version: 2,
    kersor_version: 'test',
    max_workflows: launch.max_workflows,
    mode: launch.mode,
    runner_kind: 'stable',
    input_mode: 'task_directory',
    task_dir: canonicalWorkspace,
    kernel_path: realpathSync(kernelPath),
    retrieval_mode: launch.retrieval_mode,
    transfer_mode: launch.transfer_mode,
    acceptance_gate: 'enforced',
    regime_regression_policy: 'enforced',
    experience_mode: launch.experience_mode,
    kernelwiki_experience_export_mode: launch.kernelwiki_experience_export_mode,
    workflow_dir: realpathSync.native(join(testKersorRoot, 'workflows', 'Awesome-Kernel-Workflows')),
    workflow_catalog: join(canonicalSession, 'workflow-catalog.json'),
    allow_workflow_evolution: false,
    workflow_authoring_budget: launch.workflow_authoring_budget,
    allow_workflow_authoring: launch.workflow_authoring_budget > 0,
    started_at: '2026-08-22T00:00:00Z',
    extensions: {
      agent_runtime: 'dsh',
      integration_pattern_contract: launch.integration_pattern,
      baseline_witness_required: launch.workflow_authoring_budget > 0,
      candidate_ownership_required: launch.workflow_authoring_budget > 0,
    },
  }))
  writeFileSync(join(canonicalSession, 'state.json'), JSON.stringify({
    schema_version: 2,
    phase: 'optimizing',
    current_round: 1,
    stall_count: 0,
    pending_terminal: '',
    prepared: null,
    session_id: controllerSessionId,
    target_speedup: launch.target_speedup,
    target_override: true,
    workflows_filter: [],
    seed_origin: 'provided_kernel',
    kernel_language: launch.language,
    backend: launch.backend,
    integration_pattern: launch.integration_pattern,
    yolo: false,
    extensions: {},
  }))
  writeFileSync(join(canonicalSession, 'workflow-catalog.json'), JSON.stringify({
    schema_version: 1,
    workflows: [],
  }))
}

function writeKersorProtocolContext(
  sessionDir: string,
  relativePath: string,
  dispatch: Record<string, unknown> = {
    description: 'Run one protocol child',
    prompt: 'Complete the canonical KerSor handoff.',
    run_in_background: false,
  },
  context: Record<string, unknown> = {},
): string {
  const path = join(sessionDir, relativePath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({
    schema_version: 99,
    ...context,
    session_dir: realpathSync.native(sessionDir),
    dispatch: { future_dispatch_field: true, ...dispatch },
    future_context_field: { accepted: true },
  }))
  return path
}

function writeKersorSelectionContext(
  sessionDir: string,
  disposition: 'stalled' | 'locked' | 'agent-advise' = 'agent-advise',
): string {
  const canonicalSession = realpathSync.native(sessionDir)
  const selectionPath = join(canonicalSession, 'round-1-selection.json')
  const catalogPath = join(canonicalSession, 'workflow-catalog.json')
  const contextPath = join(
    canonicalSession,
    'selection-handoff',
    'round-1-context.json',
  )
  mkdirSync(dirname(contextPath), { recursive: true })
  writeFileSync(contextPath, JSON.stringify({
    schema_version: 1,
    session_dir: canonicalSession,
    round: 1,
    disposition,
    selection: { path: selectionPath, sha256: fileSha256(selectionPath) },
    catalog: { path: catalogPath, sha256: fileSha256(catalogPath) },
    decision_path: join(canonicalSession, 'round-1-routing-decision.json'),
    dispatch: disposition === 'agent-advise'
      ? {
        description: 'Choose KerSor workflow for round 1',
        prompt: 'Read the Core strategy-selector role and write its decision.',
        run_in_background: false,
      }
      : null,
  }))
  return contextPath
}

function writeProtocolSelection(
  sessionDir: string,
  disposition: 'stalled' | 'locked' | 'agent-advise',
): void {
  const canonicalSession = realpathSync.native(sessionDir)
  const selected = disposition === 'stalled' ? 'STALLED' : 'alpha'
  const decidedBy = disposition === 'agent-advise'
    ? 'agent-advise-pending'
    : disposition === 'locked' ? 'explore' : 'fallback'
  writeFileSync(join(canonicalSession, 'round-1-selection.json'), JSON.stringify({
    schema_version: 2,
    round: 1,
    session_dir: canonicalSession,
    catalog_path: join(canonicalSession, 'workflow-catalog.json'),
    selected_workflow: { name: selected },
    routing: { decided_by: decidedBy, fallback_pick: selected },
    attempt_plan: {
      status: 'proposed',
      commit: {
        status: 'proposed',
        workflow: selected,
        decided_by: decidedBy,
        rationale: '',
      },
    },
    candidates: disposition === 'stalled' ? [] : [{ name: 'alpha' }],
  }))
}

function configureSelectionProcesses(
  harness: Harness,
  sessionDir: string,
  disposition: 'stalled' | 'locked' | 'agent-advise',
): void {
  harness.hostTransformSubprocess.onSpawn = (spec) => {
    if (spec.argv.some(argument => argument.endsWith('select-workflow.sh'))) {
      writeProtocolSelection(sessionDir, disposition)
    }
    if (spec.argv.includes('selection-handoff.py')) {
      writeKersorSelectionContext(sessionDir, disposition)
    }
    if (spec.argv.some(argument => argument.endsWith('finalize-selection.sh'))) {
      const path = join(realpathSync.native(sessionDir), 'round-1-selection.json')
      const selection = readJsonFixture(path) as {
        routing: { decided_by: string }
        selected_workflow: { name: string }
        attempt_plan: {
          status: string
          commit: { status: string; workflow: string; decided_by: string }
        }
      }
      const decidedBy = disposition === 'locked'
        ? 'explore'
        : 'fallback'
      selection.routing.decided_by = decidedBy
      selection.attempt_plan.status = 'committed'
      selection.attempt_plan.commit.status = 'committed'
      selection.attempt_plan.commit.workflow = selection.selected_workflow.name
      selection.attempt_plan.commit.decided_by = decidedBy
      writeFileSync(path, JSON.stringify(selection))
    }
  }
}

function candidateOwnershipSealCommand(runDir: string): string {
  const sessionDir = dirname(realpathSync(runDir))
  return `KERSOR_PYTHON='${testKersorPython}'; export KERSOR_PYTHON; bridge="\${DSH_HOME:-$HOME/.dsh}/.agent-presets/kersor/bin/kersor_bridge.py"; kersor_root="$("$KERSOR_PYTHON" "$bridge" root)"; "$KERSOR_PYTHON" "$kersor_root/scripts/candidate-ownership.py" seal --session '${sessionDir}' --run-dir '${realpathSync(runDir)}'`
}

function baselinePrefix(): string {
  return `KERSOR_PYTHON='${testKersorPython}'; export KERSOR_PYTHON; bridge="\${DSH_HOME:-$HOME/.dsh}/.agent-presets/kersor/bin/kersor_bridge.py"; kersor_root="$("$KERSOR_PYTHON" "$bridge" root)"; "$KERSOR_PYTHON" "$kersor_root/scripts/baseline-witness.py"`
}

function hostShellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function baselineInitCommand(sessionDir: string): string {
  return `${baselinePrefix()} init --session ${hostShellQuote(realpathSync(sessionDir))} --correctness-command ${hostShellQuote(launchContract.correctness_command)} --benchmark-command ${hostShellQuote(launchContract.benchmark_command)}`
}

function baselineRecordCommand(sessionDir: string, workspace: string): string {
  return `${baselinePrefix()} record --session ${hostShellQuote(realpathSync(sessionDir))} --project-root ${hostShellQuote(realpathSync(workspace))}`
}

function baselineVerifyCommand(sessionDir: string): string {
  return `${baselinePrefix()} verify --session ${hostShellQuote(realpathSync(sessionDir))}`
}

function shellQuote(value: string | number): string {
  return `'${String(value).replaceAll("'", '\'"\'"\'')}'`
}

function setupSessionCommand(
  workspace: string,
  controllerSessionId: string,
  launch: KersorLaunchContract = launchContract,
  freshSession = false,
): string {
  const canonicalWorkspace = realpathSync(workspace)
  const flags: Array<string | number> = [
    '--runtime', 'dsh',
    '--target-speedup', launch.target_speedup,
    '--max-workflows', launch.max_workflows,
    '--mode', launch.mode,
    '--backend', launch.backend,
    '--language', launch.language,
    '--integration-pattern', launch.integration_pattern,
    '--retrieval-mode', launch.retrieval_mode,
    '--transfer-mode', launch.transfer_mode,
    '--experience-mode', launch.experience_mode,
    '--kernelwiki-experience-export-mode', launch.kernelwiki_experience_export_mode,
    '--workflow-authoring-budget', launch.workflow_authoring_budget,
    ...(launch.workflow_authoring_budget > 0 ? ['--allow-workflow-authoring'] : []),
    '--no-workflow-evolution',
    '--no-yolo',
    '--acceptance-gate', 'enforced',
    '--regime-regression-policy', 'enforced',
    '--note', '',
    ...(freshSession ? ['--fresh-session'] : []),
  ]
  return [
    `KERSOR_PYTHON=${shellQuote(testKersorPython)}; export KERSOR_PYTHON;`,
    `CLAUDE_SESSION_ID=${shellQuote(controllerSessionId)}; CLAUDE_CODE_SESSION_ID=${shellQuote(controllerSessionId)}; export CLAUDE_SESSION_ID CLAUDE_CODE_SESSION_ID;`,
    `KERSOR_SESSION_ROOT=${shellQuote(join(canonicalWorkspace, '.kersor'))}; export KERSOR_SESSION_ROOT;`,
    'bridge="${DSH_HOME:-$HOME/.dsh}/.agent-presets/kersor/bin/kersor_bridge.py";',
    'kersor_root="$("$KERSOR_PYTHON" "$bridge" root)";',
    `bash "$kersor_root/scripts/setup-session.sh" ${shellQuote(canonicalWorkspace)} ${flags.map(shellQuote).join(' ')}`,
  ].join(' ')
}

function dispatchProducerArguments(
  sessionDir: string,
  runDir: string,
  workflowName = workflowMeta.name,
): Record<string, unknown> {
  return {
    description: 'Synthesize dispatch args',
    run_in_background: false,
    prompt: [
      'KERSOR_DISPATCH_ARG_SYNTHESIZER_V1',
      `SESSION_DIR=${realpathSync(sessionDir)}`,
      `RUN_DIR=${realpathSync(runDir)}`,
      `WORKFLOW_NAME=${workflowName}`,
      'Read and follow agents/dispatch-arg-synthesizer.md.',
    ].join('\n'),
  }
}

function writeDispatchSelection(
  sessionDir: string,
  workflowName = workflowMeta.name,
): void {
  const canonicalSessionDir = realpathSync.native(sessionDir)
  const workflowDirectory = 'prepared-workflow'
  const workflowPath = join(
    canonicalSessionDir,
    'workflow-authoring',
    'proposals',
    workflowDirectory,
    'workflow.js',
  )
  mkdirSync(dirname(workflowPath), { recursive: true })
  writeFileSync(workflowPath, workflowSource)
  const workflowContentHash = `sha256:${sha256(workflowSource)}`
  const catalogPath = join(canonicalSessionDir, 'workflow-catalog.json')
  writeFileSync(catalogPath, JSON.stringify({
    workflows: [{
      name: workflowName,
      directory: workflowDirectory,
      candidate_type: 'authored',
      js_path: workflowPath,
      workflow_content_hash: workflowContentHash,
    }],
  }))
  writeFileSync(join(canonicalSessionDir, 'round-1-selection.json'), JSON.stringify({
    schema_version: 2,
    round: 1,
    session_dir: canonicalSessionDir,
    catalog_path: catalogPath,
    routing: { decided_by: 'fallback' },
    attempt_plan: {
      status: 'committed',
      commit: {
        status: 'committed',
        workflow: workflowName,
        decided_by: 'fallback',
        rationale: '',
      },
    },
    selected_workflow: {
      name: workflowName,
      directory: workflowDirectory,
      candidate_type: 'authored',
      workflow_content_hash: workflowContentHash,
    },
  }))
}

function registerDispatchProducerProbe(
  harness: Harness,
  producer: Agent,
  runDir: string,
  dispatchArgs: Record<string, unknown>,
  provenance: Record<string, unknown>,
  calls?: string[],
): void {
  harness.ctx.tools.register(defineTool({
    name: 'write',
    description: 'Write one dispatch producer artifact.',
    parameters: {
      file_path: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: (args) => {
      writeFileSync(args.file_path, args.content)
      return Promise.resolve(args.file_path)
    },
  }))
  harness.ctx.tools.register(defineTool({
    name: 'subagent',
    description: 'Run one foreground producer probe.',
    parameters: {
      description: { type: 'string', required: true },
      prompt: { type: 'string', required: true },
      run_in_background: { type: 'boolean', required: true },
    },
    output: {
      schema: { type: 'json' },
      render: () => [{ type: 'text', text: 'producer complete' }],
    },
    execute: async () => {
      calls?.push('subagent')
      await call(harness, 'write', {
        file_path: join(runDir, 'dispatch-args.json'),
        content: JSON.stringify(dispatchArgs),
      }, producer)
      await call(harness, 'write', {
        file_path: join(runDir, 'dispatch-args-provenance.json'),
        content: JSON.stringify(provenance),
      }, producer)
      return { kind: 'foreground', runId: producer.id, output: [] }
    },
  }))
}

beforeEach(() => {
  process.env.KERSOR_PYTHON = testKersorPython
  process.env.KERSOR_ROOT = testKersorRoot
})

afterEach(() => {
  if (originalKersorPython === undefined) delete process.env.KERSOR_PYTHON
  else process.env.KERSOR_PYTHON = originalKersorPython
  if (originalKersorRoot === undefined) delete process.env.KERSOR_ROOT
  else process.env.KERSOR_ROOT = originalKersorRoot
})

class HostTransformSubprocess {
  readonly specs: SubprocessSpawnSpec[] = []
  exitCode = 0
  signal: NodeJS.Signals | null = null
  stdout = ''
  stderr = ''
  onSpawn: (spec: SubprocessSpawnSpec) => void = () => {}

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    this.onSpawn(spec)
    return {
      pid: 4242,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: {
        stdout: {
          readFrom: () => ({
            text: this.stdout,
            nextOffset: Buffer.byteLength(this.stdout),
            lossy: false,
          }),
        },
        stderr: {
          readFrom: () => ({
            text: this.stderr,
            nextOffset: Buffer.byteLength(this.stderr),
            lossy: false,
          }),
        },
      },
      done: Promise.resolve({ exitCode: this.exitCode, signal: this.signal }),
      terminate: () => {},
      waitForExit: () => Promise.resolve(true),
    }
  }
}

interface MockSubagents {
  readonly children: SubagentListEntry[]
  readonly starts: unknown[]
  readonly oneShotStarts: unknown[]
  readonly disposals: SessionId[]
  readonly followups: unknown[]
  oneShotResult: SubagentResult
  oneShotRun?: (id: SessionId) => Promise<SubagentResult>
  oneShotResultError?: Error
  disposalError?: Error
  listChildren(): Promise<SubagentListEntry[]>
  start(provider: string, spec: unknown): Promise<SubagentRun>
  startContinuable(spec: { childId: SessionId }): Promise<{ childId: SessionId; messageId: string }>
  followup(...args: unknown[]): Promise<string>
}

interface Harness {
  readonly ctx: Context
  readonly session: Session
  readonly agent: Agent
  readonly subagents: MockSubagents
  readonly order: string[]
  readonly hostTransformSubprocess: HostTransformSubprocess
  readonly controlFiber: { dispose(): Promise<void> }
}

class SetupSandboxExecutor extends ShellExecutor {
  readonly calls: ShellExecSpec[] = []
  onRun: (spec: ShellExecSpec) => void = () => {}
  resultFor?: (spec: ShellExecSpec) => ShellRunResult

  override get sandboxMode() {
    return 'workspace-write' as const
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      timeoutMs: request.timeoutMs ?? 10_000,
      ...request.signal !== undefined ? { signal: request.signal } : {},
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.calls.push(spec)
    this.onRun(spec)
    const result = this.resultFor?.(spec)
    if (result !== undefined) return Promise.resolve(result)
    return Promise.resolve({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: 'setup complete\n', truncated: false },
      stderr: { text: '', truncated: false },
      sandbox: {
        mode: spec.sandboxPolicy?.mode ?? 'workspace-write',
        denied: false,
        enforcement: 'full',
        runnerFailed: false,
      },
    })
  }

  start(): ShellProcess {
    throw new Error('background setup execution is forbidden in this test')
  }
}

const testControllerBindings = new WeakMap<Session, {
  readonly experimentId: string
  readonly launch: KersorLaunchContract
  readonly freshSession: boolean
}>()

async function setup(
  workspace = '/work/kernel',
  beforeControl?: (ctx: Context) => Promise<void>,
): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SessionStore)
  await ctx.plugin(ToolRuntime)
  const hostTransformSubprocess = new HostTransformSubprocess()
  ctx.provide('subprocess', hostTransformSubprocess as never)
  const order: string[] = []
  ctx.on('session/flush', () => { order.push('flush') })
  const children: SubagentListEntry[] = []
  const parentSessionId = SessionId('parent')
  const subagents: MockSubagents = {
    children,
    starts: [],
    oneShotStarts: [],
    disposals: [],
    followups: [],
    oneShotResult: { output: [], stopReason: 'completed' },
    listChildren: () => Promise.resolve([...children]),
    start(provider, spec) {
      const id = SessionId(`kersor-protocol-child-${this.oneShotStarts.length + 1}`)
      this.oneShotStarts.push({ provider, spec })
      const result = this.oneShotRun !== undefined
        ? this.oneShotRun(id)
        : this.oneShotResultError === undefined
          ? Promise.resolve(this.oneShotResult)
          : Promise.reject(this.oneShotResultError)
      return Promise.resolve({
        id,
        localAgent: undefined,
        result,
        dispose: () => {
          this.disposals.push(id)
          return this.disposalError === undefined
            ? Promise.resolve()
            : Promise.reject(this.disposalError)
        },
      })
    },
    startContinuable(spec) {
      order.push('start-child')
      this.starts.push(spec)
      if (ctx.sessions.get(spec.childId) === undefined) {
        const childWorkspace = existsSync(workspace)
          ? realpathSync.native(workspace)
          : workspace
        ctx.sessions.create(spec.childId, {
          meta: { cwd: childWorkspace, parentSession: parentSessionId, origin: 'subagent' },
        })
      }
      children.push({
        kind: 'child', id: spec.childId, mode: 'continuable', label: 'KerSor experiment',
        activity: 'running', hasChildren: false,
      })
      return Promise.resolve({ childId: spec.childId, messageId: 'message-1' })
    },
    followup(...args) {
      order.push('followup')
      this.followups.push(args)
      return Promise.resolve('message-2')
    },
  }
  ctx.provide('subagents', subagents as never)
  await beforeControl?.(ctx)
  const controlFiber = await ctx.plugin(control)
  const session = ctx.sessions.create(parentSessionId, { meta: { cwd: workspace } })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const agent = { id: session.id, session } as unknown as Agent
  return { ctx, session, agent, subagents, order, hostTransformSubprocess, controlFiber }
}

let callSequence = 0
async function call(harness: Harness, name: string, args: unknown, agent = harness.agent) {
  const callId = CallId(`kersor-control-${++callSequence}`)
  agent.session.append('tool/call', {
    turn: 1, step: 1, callId, name, arguments: JSON.stringify(args),
  })
  return harness.ctx.tools.execute({ callId, name, arguments: args, agent, signal })
}

function starts(session: Session) {
  return session.events.filter(event => event.type === 'kersor/experiment-start')
}

function checkpoints(session: Session) {
  return session.events.filter(event => event.type === 'kersor/experiment-checkpoint')
}

function promptText(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function startedPrompt(harness: Harness): string {
  const start = harness.subagents.starts[0] as {
    readonly request: { readonly prompt: readonly ContentBlock[] }
  }
  return promptText(start.request.prompt)
}

function resumedPrompt(harness: Harness): string {
  const followup = harness.subagents.followups[0] as readonly [unknown, unknown, readonly ContentBlock[]]
  return promptText(followup[2])
}

function registerProbe(harness: Harness, name: string, calls: string[]): void {
  harness.ctx.tools.register(defineTool({
    name,
    description: 'Record one test probe invocation.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: () => {
      calls.push(name)
      return Promise.resolve(name)
    },
  }))
}

function registerBashProbe(
  harness: Harness,
  calls: string[],
  execute?: (command: string) => string | Promise<string>,
): void {
  harness.ctx.tools.register(defineTool({
    name: 'bash',
    description: 'Execute one test Bash command.',
    parameters: {
      command: { type: 'string', required: true },
      workdir: { type: 'string' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args) => {
      calls.push(args.command)
      return execute === undefined ? args.command : await execute(args.command)
    },
  }))
}

interface WorkflowProbeValue {
  readonly runId: string
  readonly agentsStarted: number
  readonly result: JsonValue
}

function registerWorkflowProbe(
  harness: Harness,
  value: WorkflowProbeValue | Error,
  calls?: string[],
  onExecute?: () => void,
): void {
  harness.ctx.tools.register(defineTool({
    name: 'workflow',
    description: 'Return one canonical Workflow probe result.',
    parameters: {
      meta: {
        type: 'object',
        required: true,
        additionalProperties: true,
        properties: {
          name: { type: 'string', required: true },
          description: { type: 'string', required: true },
        },
      },
      script: { type: 'string', required: true },
      args: {
        type: 'object',
        required: true,
        additionalProperties: true,
        properties: {
          exp_dir: { type: 'string', required: true },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', required: true },
          agentsStarted: { type: 'integer', required: true },
          result: { type: 'json', required: true },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `truncated workflow preview: ${JSON.stringify(result).slice(0, 96)}`,
      }],
    },
    execute: () => {
      calls?.push('workflow')
      onExecute?.()
      if (value instanceof Error) throw value
      return Promise.resolve(value)
    },
  }))
}

function registerFileProbe(harness: Harness, name: 'write' | 'edit', calls: string[]): void {
  harness.ctx.tools.register(defineTool({
    name,
    description: 'Record one test file mutation.',
    parameters: {
      file_path: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: (args) => {
      calls.push(args.file_path)
      return Promise.resolve(args.file_path)
    },
  }))
}

function registerPathProbe(
  harness: Harness,
  name: 'read' | 'multi_edit',
  calls: string[],
): void {
  harness.ctx.tools.register(defineTool({
    name,
    description: 'Record one test path access.',
    parameters: {
      file_path: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: (args) => {
      calls.push(`${name}:${args.file_path}`)
      return Promise.resolve(args.file_path)
    },
  }))
}

function registerNestedMultiEditProbe(harness: Harness, calls: string[]): void {
  harness.ctx.tools.register(defineTool({
    name: 'multi_edit',
    description: 'Record one nested multi-edit request.',
    parameters: {
      edits: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: true,
          properties: { file_path: { type: 'string', required: true } },
        },
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: (args) => {
      const paths = args.edits.map(edit => edit.file_path)
      calls.push(...paths)
      return Promise.resolve(paths.join(','))
    },
  }))
}

function registerSearchPathProbe(
  harness: Harness,
  name: 'glob' | 'grep',
  calls: string[],
): void {
  harness.ctx.tools.register(defineTool({
    name,
    description: 'Record one filesystem search request.',
    parameters: {
      pattern: { type: 'string', required: true },
      path: { type: 'string' },
      include: { type: 'string' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: (args) => {
      calls.push(`${name}:${args.path ?? ''}:${args.pattern}:${args.include ?? ''}`)
      return Promise.resolve(name)
    },
  }))
}

function makeRunDirectory(workspace: string, run = 'run-1'): string {
  const path = join(workspace, '.kersor', '20260822-raw-custody', run)
  mkdirSync(path, { recursive: true })
  return realpathSync.native(path)
}

function initializeGitWorkspace(workspace: string): void {
  writeFileSync(join(workspace, 'kernel.py'), 'VALUE = 1\n')
  writeFileSync(join(workspace, 'README.md'), 'initial\n')
  execFileSync('git', ['init', '-q'], { cwd: workspace })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workspace })
  execFileSync('git', ['add', 'kernel.py', 'README.md'], { cwd: workspace })
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: workspace })
}

function workflowArguments(runDir: string): {
  meta: typeof workflowMeta
  script: string
  args: { exp_dir: string; kernel_path: string; target_speedup: number }
} {
  return {
    meta: structuredClone(workflowMeta),
    script: workflowScript,
    args: {
      exp_dir: runDir,
      kernel_path: 'Session/best-kernel/perf_takehome.py',
      target_speedup: 8,
    },
  }
}

interface WorkflowEnvelopeOptions {
  readonly appendBaselineCustody?: boolean
  readonly appendProducerEvent?: boolean
  readonly appendTransformation?: boolean
  readonly writeCandidateSeal?: boolean
  readonly appendCandidateSealCall?: boolean
  readonly appendCandidateSealEvent?: boolean
}

function writeWorkflowEnvelope(
  runDir: string,
  controller: Agent,
  call = workflowArguments(runDir),
  options: WorkflowEnvelopeOptions = {},
): void {
  const appendBaselineCustody = options.appendBaselineCustody ?? true
  const appendProducerEvent = options.appendProducerEvent ?? true
  const appendTransformation = options.appendTransformation ?? true
  const writeCandidateSeal = options.writeCandidateSeal ?? true
  const appendCandidateSealCall = options.appendCandidateSealCall ?? writeCandidateSeal
  const appendCandidateSealEvent = options.appendCandidateSealEvent ?? writeCandidateSeal
  const canonicalRunDir = realpathSync(runDir)
  const sessionDir = dirname(canonicalRunDir)
  const projectRoot = realpathSync(dirname(dirname(sessionDir)))
  const round = Number.parseInt(basename(runDir).slice('run-'.length), 10)
  const proposalDirectory = 'prepared-workflow'
  const workflowPath = join(
    sessionDir,
    'workflow-authoring',
    'proposals',
    proposalDirectory,
    'workflow.js',
  )
  const argsPath = join(canonicalRunDir, 'dispatch-args.json')
  const provenancePath = join(canonicalRunDir, 'dispatch-args-provenance.json')
  const producerReceiptPath = join(canonicalRunDir, 'dispatch-args-producer-receipt.json')
  const workflowHash = sha256(workflowSource)
  const argsHash = sha256(JSON.stringify(call.args))
  const scriptHash = sha256(call.script)
  const bodyHash = sha256(workflowBody)
  const originalMetaHash = sha256(JSON.stringify(workflowMeta))
  const projectedMetaHash = sha256(JSON.stringify(workflowMeta))
  const metaProjection = {
    contract: 'dsh_workflow_meta_v1',
    when_to_use: 'absent',
    dropped_top_level_fields: [],
    dropped_phase_fields: [],
  }
  const childToolPolicy = {
    kind: 'allowlist',
    tools: ['glob', 'grep', 'read'],
    enforcement: 'dsh_tool_filter',
    source: 'kersor_adapter_v1',
  }
  const kernelPath = join(projectRoot, 'kernel.py')
  if (!existsSync(kernelPath)) writeFileSync(kernelPath, 'VALUE = 1\n')
  if (appendBaselineCustody && !controller.session.events.some(event =>
    event.type === 'kersor/baseline-verified' && event.data.session_dir === sessionDir)) {
    appendValidBaselineCustody(sessionDir, projectRoot, controller)
  } else if (!appendBaselineCustody) {
    writeFileSync(join(sessionDir, 'session-config.json'), JSON.stringify({
      task_dir: projectRoot,
      kernel_path: kernelPath,
      workflow_catalog: join(sessionDir, 'workflow-catalog.json'),
      extensions: { agent_runtime: 'dsh' },
    }))
    writeFileSync(join(sessionDir, 'baseline-witness.json'), JSON.stringify({ verdict: 'pass' }))
  }
  writeValidSessionState(sessionDir, round, controller.id)
  mkdirSync(dirname(workflowPath), { recursive: true })
  writeFileSync(workflowPath, workflowSource)
  const argsBytes = JSON.stringify(call.args, null, 2)
  const provenanceBytes = JSON.stringify({
    schema_version: 1,
    source: 'dispatch-arg-synthesizer',
    workflow_name: call.meta.name,
    missing_required: [],
    unmet_note_requirements: [],
  }, null, 2)
  writeFileSync(argsPath, argsBytes)
  writeFileSync(provenancePath, provenanceBytes)
  const producerReceipt = {
    schema_version: 1 as const,
    contract: 'dsh_dispatch_args_producer_v1' as const,
    authority: 'dsh_host' as const,
    session_dir: sessionDir,
    run_dir: canonicalRunDir,
    round,
    workflow_name: call.meta.name,
    controller_session_id: controller.id,
    producer_session_id: `producer-${round}`,
    producer_call_id: `producer-call-${round}`,
    dispatch_args: { path: argsPath, sha256: sha256(argsBytes) },
    dispatch_args_provenance: {
      path: provenancePath,
      sha256: sha256(provenanceBytes),
    },
  }
  const producerReceiptBytes = JSON.stringify(producerReceipt, null, 2)
  writeFileSync(producerReceiptPath, producerReceiptBytes)
  if (appendProducerEvent && !controller.session.events.some(event =>
    event.type === 'kersor/dispatch-args-produced'
    && event.data.run_dir === canonicalRunDir)) {
    controller.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CallId(producerReceipt.producer_call_id),
      name: 'subagent',
      arguments: JSON.stringify({
        description: 'Synthesize dispatch args',
        run_in_background: false,
        prompt: [
          'KERSOR_DISPATCH_ARG_SYNTHESIZER_V1',
          `SESSION_DIR=${sessionDir}`,
          `RUN_DIR=${canonicalRunDir}`,
          `WORKFLOW_NAME=${call.meta.name}`,
        ].join('\n'),
      }),
    })
    controller.session.append('kersor/dispatch-args-produced', producerReceipt)
  }
  const transformationReceiptPath = join(
    canonicalRunDir, 'dispatch-args-transformation-receipt.json',
  )
  const transformationReceipt = {
    schema_version: 1 as const,
    contract: 'dsh_dispatch_args_transformation_v1' as const,
    authority: 'dsh_host' as const,
    transformer: 'inject-runtime-controls' as const,
    session_dir: sessionDir,
    run_dir: canonicalRunDir,
    round,
    workflow_name: call.meta.name,
    controller_session_id: controller.id,
    transformation_call_id: producerReceipt.producer_call_id,
    producer_receipt: {
      path: producerReceiptPath,
      sha256: sha256(producerReceiptBytes),
    },
    input: {
      dispatch_args: producerReceipt.dispatch_args,
      dispatch_args_provenance: producerReceipt.dispatch_args_provenance,
    },
    output: {
      dispatch_args: producerReceipt.dispatch_args,
      dispatch_args_provenance: producerReceipt.dispatch_args_provenance,
    },
    changed: false,
    authorized_fields: { dispatch_args: [], dispatch_args_provenance: [] },
  }
  const transformationReceiptBytes = JSON.stringify(transformationReceipt, null, 2)
  if (appendTransformation) {
    if (!appendProducerEvent) throw new Error('test transformation requires its producer event')
    writeFileSync(transformationReceiptPath, transformationReceiptBytes)
    if (!controller.session.events.some(event =>
      event.type === 'kersor/dispatch-args-transformed'
      && event.data.run_dir === canonicalRunDir)) {
      controller.session.append('kersor/dispatch-args-transformed', transformationReceipt)
    }
  }
  const proposalBindingHash = `sha256:${'1'.repeat(64)}`
  const workflowContentHash = `sha256:${workflowHash}`
  const proposalPath = join(dirname(workflowPath), 'proposal.json')
  const proposalMetadataPath = join(dirname(workflowPath), 'metadata.json')
  writeFileSync(proposalPath, JSON.stringify({
    schema_version: 1,
    workflow_name: workflowMeta.name,
    workflow_hash_ref: workflowContentHash,
    evidence_binding: {
      binding_hash: proposalBindingHash,
      workflow_hash: workflowContentHash,
    },
  }))
  writeFileSync(proposalMetadataPath, JSON.stringify({
    name: workflowMeta.name,
    candidate_type: 'authored',
    content_hash: workflowContentHash,
  }))
  writeFileSync(join(sessionDir, `round-${round}-selection.json`), JSON.stringify({
    schema_version: 2,
    round,
    session_dir: sessionDir,
    catalog_path: join(sessionDir, 'workflow-catalog.json'),
    routing: { decided_by: 'fallback' },
    attempt_plan: {
      status: 'committed',
      commit: {
        status: 'committed',
        workflow: workflowMeta.name,
        decided_by: 'fallback',
        rationale: '',
      },
    },
    selected_workflow: {
      name: workflowMeta.name,
      directory: proposalDirectory,
      candidate_type: 'authored',
      proposal_binding_hash: proposalBindingHash,
      workflow_content_hash: workflowContentHash,
    },
  }))
  writeFileSync(join(sessionDir, 'workflow-catalog.json'), JSON.stringify({
    workflows: [{
      name: workflowMeta.name,
      directory: proposalDirectory,
      candidate_type: 'authored',
      js_path: workflowPath,
      proposal_binding_hash: proposalBindingHash,
      workflow_content_hash: workflowContentHash,
    }],
  }))
  writeFileSync(join(canonicalRunDir, 'dsh-compatibility.json'), JSON.stringify({
    schema_version: 1,
    gate: 'dsh_workflow_v1',
    verdict: 'pass',
    workflow_source: workflowPath,
    workflow_sha256: workflowHash,
    args_source: argsPath,
    args_sha256: argsHash,
    dispatch_args_producer: producerReceipt,
    dispatch_args_producer_receipt_source: producerReceiptPath,
    dispatch_args_producer_receipt_sha256: sha256(producerReceiptBytes),
    dispatch_args_transformation: appendTransformation ? transformationReceipt : null,
    dispatch_args_transformation_receipt_source:
      appendTransformation ? transformationReceiptPath : null,
    dispatch_args_transformation_receipt_sha256:
      appendTransformation ? sha256(transformationReceiptBytes) : null,
    dispatch_args_provenance_source: provenancePath,
    dispatch_args_provenance_sha256: sha256(provenanceBytes),
    body_sha256: bodyHash,
    original_meta_sha256: originalMetaHash,
    projected_meta_sha256: projectedMetaHash,
    meta_projection: { ...metaProjection, original_meta: workflowMeta },
    effective_script_sha256: scriptHash,
    model_policy: 'inherit_controller',
    child_tool_policy: childToolPolicy,
    errors: [],
  }))
  writeFileSync(join(canonicalRunDir, 'dsh-workflow.json'), JSON.stringify({
    schema_version: 1,
    contract: 'dsh_workflow_v1',
    source: {
      workflow_path: workflowPath,
      workflow_sha256: workflowHash,
      args_path: argsPath,
      args_sha256: argsHash,
      dispatch_args_producer: producerReceipt,
      dispatch_args_producer_receipt_path: producerReceiptPath,
      dispatch_args_producer_receipt_sha256: sha256(producerReceiptBytes),
      dispatch_args_transformation: appendTransformation ? transformationReceipt : null,
      dispatch_args_transformation_receipt_path:
        appendTransformation ? transformationReceiptPath : null,
      dispatch_args_transformation_receipt_sha256:
        appendTransformation ? sha256(transformationReceiptBytes) : null,
      dispatch_args_provenance_path: provenancePath,
      dispatch_args_provenance_sha256: sha256(provenanceBytes),
      body_sha256: bodyHash,
      original_meta_sha256: originalMetaHash,
      projected_meta_sha256: projectedMetaHash,
      meta_projection: metaProjection,
      effective_script_sha256: scriptHash,
      model_policy: 'inherit_controller',
      child_tool_policy: childToolPolicy,
    },
    meta: call.meta,
    script: call.script,
    args: call.args,
  }))
  if (writeCandidateSeal) {
    if (!appendTransformation) {
      throw new Error('test candidate seal requires its transformation receipt')
    }
    const selectionPath = join(sessionDir, `round-${round}-selection.json`)
    const catalogPath = join(sessionDir, 'workflow-catalog.json')
    const envelopePath = join(canonicalRunDir, 'dsh-workflow.json')
    const compatibilityPath = join(canonicalRunDir, 'dsh-compatibility.json')
    const sealPath = join(canonicalRunDir, 'candidate-ownership-seal.json')
    const seal = {
      schema_version: 1,
      contract: 'candidate_output_ownership_v1',
      recorded_at: '2026-08-22T00:00:00Z',
      session_id: basename(sessionDir),
      session_dir: sessionDir,
      run_dir: canonicalRunDir,
      project_root: projectRoot,
      allowed_write_root: sessionDir,
      session_config_sha256: fileSha256(join(sessionDir, 'session-config.json')),
      baseline_witness_sha256: fileSha256(join(sessionDir, 'baseline-witness.json')),
      protected_files: testProtectedFiles(projectRoot, kernelPath),
      worktree: testWorktreeSnapshot(projectRoot, sessionDir),
      dsh_dispatch_package: {
        schema_version: 1,
        contract: 'dsh_dispatch_package_v1',
        runtime: 'dsh',
        round,
        bindings: {
          selected_workflow: call.meta.name,
          candidate_type: 'authored',
          proposal_binding_hash: proposalBindingHash,
          workflow_content_hash: workflowContentHash,
          canonical_workflow_path: workflowPath,
          canonical_workflow_sha256: workflowHash,
          dispatch_args_path: argsPath,
          dispatch_args_provenance_path: provenancePath,
          dispatch_args_producer_receipt_path: producerReceiptPath,
          dispatch_args_producer: {
            contract: producerReceipt.contract,
            authority: producerReceipt.authority,
            controller_session_id: producerReceipt.controller_session_id,
            producer_session_id: producerReceipt.producer_session_id,
            producer_call_id: producerReceipt.producer_call_id,
            receipt_sha256: sha256(producerReceiptBytes),
            dispatch_args_sha256: producerReceipt.dispatch_args.sha256,
            dispatch_args_provenance_sha256:
              producerReceipt.dispatch_args_provenance.sha256,
          },
          dispatch_args_transformation: {
            contract: transformationReceipt.contract,
            authority: transformationReceipt.authority,
            transformer: transformationReceipt.transformer,
            transformation_call_id: transformationReceipt.transformation_call_id,
            receipt_path: transformationReceiptPath,
            receipt_sha256: sha256(transformationReceiptBytes),
          },
          effective_dispatch: {
            dispatch_args: transformationReceipt.output.dispatch_args,
            dispatch_args_provenance:
              transformationReceipt.output.dispatch_args_provenance,
          },
          envelope_path: envelopePath,
          compatibility_report_path: compatibilityPath,
        },
        files: {
          selection: jsonFileRecord(selectionPath),
          catalog: jsonFileRecord(catalogPath),
          proposal: jsonFileRecord(proposalPath),
          proposal_metadata: jsonFileRecord(proposalMetadataPath),
          canonical_workflow: { path: workflowPath, file_sha256: fileSha256(workflowPath) },
          dispatch_args: jsonFileRecord(argsPath),
          dispatch_args_provenance: jsonFileRecord(provenancePath),
          dispatch_args_producer_receipt: jsonFileRecord(producerReceiptPath),
          dispatch_args_transformation_receipt: jsonFileRecord(transformationReceiptPath),
          envelope: jsonFileRecord(envelopePath),
          compatibility_report: jsonFileRecord(compatibilityPath),
        },
      },
    }
    writeFileSync(sealPath, JSON.stringify(seal))
    const hasCandidateSealEvent = controller.session.events.some(event =>
      event.type === 'kersor/candidate-ownership-sealed'
      && event.data.run_dir === canonicalRunDir)
    if (appendCandidateSealCall && !hasCandidateSealEvent) {
      const sealCallId = `candidate-seal-call-${round}`
      controller.session.append('tool/call', {
        turn: 1,
        step: 1,
        callId: CallId(sealCallId),
        name: 'bash',
        arguments: JSON.stringify({ command: candidateOwnershipSealCommand(canonicalRunDir) }),
      })
      if (appendCandidateSealEvent) {
        controller.session.append('kersor/candidate-ownership-sealed', {
          schema_version: 1,
          contract: 'dsh_candidate_ownership_seal_v1',
          authority: 'dsh_host',
          session_dir: sessionDir,
          run_dir: canonicalRunDir,
          round,
          controller_session_id: controller.id,
          seal_call_id: sealCallId,
          seal: { path: sealPath, sha256: fileSha256(sealPath) },
          state: {
            path: join(sessionDir, 'state.json'),
            sha256: fileSha256(join(sessionDir, 'state.json')),
          },
        } as never)
      }
    } else if (appendCandidateSealEvent && !hasCandidateSealEvent) {
      throw new Error('test candidate seal event requires its canonical Bash call')
    }
  }
}

function descendantAgent(harness: Harness, parent: Session, id: string): Agent {
  const sessionId = SessionId(id)
  const existing = harness.ctx.sessions.get(sessionId)
  const session = existing ?? harness.ctx.sessions.create(sessionId, {
    meta: { cwd: parent.header.cwd ?? '/work/kernel', parentSession: parent.id, origin: 'subagent' },
  })
  const start = parent.events.find(event =>
    event.type === 'kersor/experiment-start' && event.data.childSessionId === session.id)
  if (start?.type === 'kersor/experiment-start') {
    testControllerBindings.set(session, {
      experimentId: start.data.experimentId,
      launch: start.data.launch,
      freshSession: start.data.freshSession,
    })
  }
  return { id: session.id, session } as unknown as Agent
}

async function startController(harness: Harness): Promise<Agent> {
  await call(harness, 'kersor_start', { objective: 'Optimize', launch: launchContract })
  const controllerId = starts(harness.session)[0]!.data.childSessionId
  return descendantAgent(harness, harness.session, controllerId)
}

async function prepareTypedAuthor(
  harness: Harness,
  workspace: string,
  controller: Agent,
  name: string,
): Promise<string> {
  const sessionDir = join(workspace, '.kersor', name)
  writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
  ensureSessionInitializationFixture(sessionDir, workspace, controller)
  prepareAuthorStaging(sessionDir)
  writeKersorProtocolContext(sessionDir, 'workflow-authoring/author-context.json')
  const authored = await call(harness, 'kersor_protocol', { action: 'author' }, controller)
  if (authored.isError) throw new Error(promptText(authored.content))
  return realpathSync.native(sessionDir)
}

async function sealTypedAuthor(
  harness: Harness,
  controller: Agent,
  sessionDir: string,
): Promise<void> {
  harness.hostTransformSubprocess.exitCode = 0
  harness.hostTransformSubprocess.signal = null
  harness.hostTransformSubprocess.stderr = ''
  harness.hostTransformSubprocess.onSpawn = (spec) => {
    if (basename(spec.argv[1] ?? '') !== 'seal-author-handoff.py') return
    writeAuthorHandoff(sessionDir)
    harness.hostTransformSubprocess.stdout = `AUTHOR_HANDOFF=${join(sessionDir, 'workflow-authoring', 'author-handoff.json')}\n`
  }
  const result = await call(harness, 'kersor_author_commit', { action: 'seal' }, controller)
  if (result.isError) throw new Error(promptText(result.content))
}

let originSequence = 0
function appendDurableOrigin(
  harness: Harness,
  launch: KersorLaunchContract = launchContract,
  sourceWorkspace = harness.session.header.cwd,
  options: {
    readonly tamperInitialization?: boolean
    readonly omitInitializationEvent?: boolean
  } = {},
): {
  readonly experimentId: string
  readonly launch: KersorLaunchContract
  readonly parent: Session
  readonly controller: Session
  readonly sessionDir?: string
  readonly setupReceiptPath?: string
} {
  const sequence = ++originSequence
  const experimentId = `kersor-durable-origin-${sequence}`
  const origin = harness.ctx.sessions.create(SessionId(`origin-parent-${sequence}`), {
    meta: harness.session.header.cwd === undefined
      ? {}
      : { cwd: harness.session.header.cwd },
  })
  const controllerId = SessionId(`origin-child-${sequence}`)
  origin.append('kersor/experiment-start', {
    experimentId,
    childSessionId: controllerId,
    origin: 'created',
    objective: 'Original durable optimization',
    freshSession: false,
    launch,
    turn: 1,
    step: 1,
  } as never)
  const controller = harness.ctx.sessions.create(controllerId, {
    meta: {
      ...(sourceWorkspace === undefined ? {} : { cwd: sourceWorkspace }),
      parentSession: origin.id,
      origin: 'subagent',
    },
  })
  const workspace = sourceWorkspace
  if (workspace === undefined || !existsSync(workspace)) {
    return { experimentId, launch, parent: origin, controller }
  }
  const canonicalWorkspace = realpathSync.native(workspace)
  const sessionDir = join(canonicalWorkspace, '.kersor', `durable-origin-${sequence}`)
  writeValidSetupArtifacts(canonicalWorkspace, sessionDir, launch, controller.id)
  const canonicalSession = realpathSync.native(sessionDir)
  const setupCallId = CallId(`origin-setup-${sequence}`)
  controller.append('tool/call', {
    turn: 1,
    step: 1,
    callId: setupCallId,
    name: 'bash',
    arguments: JSON.stringify({
      command: setupSessionCommand(canonicalWorkspace, controller.id, launch),
    }),
  })
  const data = {
    schema_version: 1,
    contract: 'dsh_session_initialization_v1',
    authority: 'dsh_host',
    experiment_id: experimentId,
    workspace: canonicalWorkspace,
    session_dir: canonicalSession,
    controller_session_id: controller.id,
    setup_call_id: setupCallId,
    setup_command: setupSessionCommand(canonicalWorkspace, controller.id, launch),
    kersor_python: {
      path: testKersorPython,
      sha256: fileSha256(testKersorPython),
    },
    launch,
    session_config: {
      path: join(canonicalSession, 'session-config.json'),
      sha256: fileSha256(join(canonicalSession, 'session-config.json')),
    },
    state: {
      path: join(canonicalSession, 'state.json'),
      sha256: fileSha256(join(canonicalSession, 'state.json')),
    },
    workflow_catalog: {
      path: join(canonicalSession, 'workflow-catalog.json'),
      sha256: fileSha256(join(canonicalSession, 'workflow-catalog.json')),
    },
    adapter: { path: testSetupAdapter, sha256: fileSha256(testSetupAdapter) },
    kernel: {
      path: join(canonicalWorkspace, 'kernel.py'),
      sha256: fileSha256(join(canonicalWorkspace, 'kernel.py')),
    },
  }
  const durableData = options.tamperInitialization
    ? { ...data, session_config: { ...data.session_config, sha256: '0'.repeat(64) } }
    : data
  const setupReceiptPath = join(canonicalSession, 'session-initialization-receipt.json')
  writeFileSync(setupReceiptPath, JSON.stringify(durableData))
  if (!options.omitInitializationEvent) {
    controller.append('kersor/session-initialized', durableData as never)
  }
  return {
    experimentId,
    launch,
    parent: origin,
    controller,
    sessionDir: canonicalSession,
    setupReceiptPath,
  }
}

function attachArguments(origin: ReturnType<typeof appendDurableOrigin>): Record<string, unknown> {
  return {
    experiment_id: origin.experimentId,
    launch: origin.launch,
    objective: 'Continue the durable optimization',
  }
}

function appendTransferLeaseFixture(
  harness: Harness,
  origin: ReturnType<typeof appendDurableOrigin>,
): Record<string, unknown> {
  const existing = origin.controller.events.find(event =>
    event.type === 'kersor/session-authority-transferred')
  if (existing !== undefined) return existing.data as unknown as Record<string, unknown>
  const attachedStart = starts(harness.session).at(-1)!
  const attachCall = harness.session.events.filter(event =>
    event.type === 'tool/call' && event.data.name === 'kersor_attach').at(-1)!
  if (attachCall.type !== 'tool/call') throw new Error('expected KerSor attach call')
  const sessionDir = origin.sessionDir!
  const statePath = join(sessionDir, 'state.json')
  const catalogPath = join(sessionDir, 'workflow-catalog.json')
  const preTransferWatermark = origin.controller.events.at(-1)!.seq
  const preTransferPrefix = origin.controller.events.filter(event =>
    event.seq <= preTransferWatermark)
  const data = {
    schema_version: 1,
    contract: 'dsh_session_authority_transfer_v1',
    authority: 'dsh_host',
    experiment_id: origin.experimentId,
    workspace: realpathSync.native(harness.session.header.cwd!),
    session_dir: sessionDir,
    source_parent_session_id: origin.parent.id,
    source_controller_session_id: origin.controller.id,
    target_parent_session_id: harness.session.id,
    target_controller_session_id: attachedStart.data.childSessionId,
    attach_call_id: attachCall.data.callId,
    launch: origin.launch,
    pre_transfer_event_watermark: preTransferWatermark,
    pre_transfer_event_sha256: sha256(canonicalJson(preTransferPrefix)),
    source_setup_receipt: {
      path: origin.setupReceiptPath!,
      sha256: fileSha256(origin.setupReceiptPath!),
    },
    source_state: { path: statePath, sha256: fileSha256(statePath) },
    source_workflow_catalog: { path: catalogPath, sha256: fileSha256(catalogPath) },
  }
  const receiptPath = join(sessionDir, 'session-authority-transfer-receipt.json')
  writeFileSync(receiptPath, JSON.stringify(data))
  origin.controller.append('kersor/session-authority-transferred', data as never)
  return data
}

function writeValidBaselineAuthority(sessionDir: string, workspace: string): void {
  const canonicalSession = realpathSync.native(sessionDir)
  const canonicalWorkspace = realpathSync.native(workspace)
  const kernelPath = realpathSync.native(join(canonicalWorkspace, 'kernel.py'))
  const configPath = join(canonicalSession, 'session-config.json')
  const methodPath = join(canonicalSession, 'test-method.md')
  const witnessPath = join(canonicalSession, 'baseline-witness.json')
  const catalogPath = join(canonicalSession, 'workflow-catalog.json')
  if (!existsSync(catalogPath)) {
    writeFileSync(catalogPath, JSON.stringify({ workflows: [] }))
  }
  writeFileSync(configPath, JSON.stringify({
    schema_version: 2,
    started_at: '2026-08-22T00:00:00Z',
    input_mode: 'task_directory',
    task_dir: canonicalWorkspace,
    kernel_path: kernelPath,
    workflow_dir: realpathSync.native(
      join(testKersorRoot, 'workflows', 'Awesome-Kernel-Workflows'),
    ),
    workflow_catalog: catalogPath,
    max_workflows: launchContract.max_workflows,
    mode: launchContract.mode,
    retrieval_mode: launchContract.retrieval_mode,
    transfer_mode: launchContract.transfer_mode,
    experience_mode: launchContract.experience_mode,
    kernelwiki_experience_export_mode: launchContract.kernelwiki_experience_export_mode,
    workflow_authoring_budget: launchContract.workflow_authoring_budget,
    extensions: {
      agent_runtime: 'dsh',
      integration_pattern_contract: launchContract.integration_pattern,
    },
  }))
  writeFileSync(methodPath, [
    '# Test Method',
    '',
    `- Correctness Command: ${launchContract.correctness_command}`,
    `- Benchmark Command: ${launchContract.benchmark_command}`,
    '- Baseline Status: present',
    '',
  ].join('\n'))
  writeFileSync(witnessPath, JSON.stringify({
    schema_version: 1,
    verdict: 'pass',
    session: {
      id: basename(canonicalSession),
      dir: canonicalSession,
      started_at: '2026-08-22T00:00:00Z',
      config_sha256: fileSha256(configPath),
    },
    source: {
      project_root: canonicalWorkspace,
      test_method: methodPath,
      test_method_sha256_at_record: fileSha256(methodPath),
      kernel_path: kernelPath,
      kernel_sha256: fileSha256(kernelPath),
    },
    commands: {
      'Correctness Command': launchContract.correctness_command,
      'Benchmark Command': launchContract.benchmark_command,
    },
    recorded_at: '2026-08-22T00:00:03Z',
    executions: [
      {
        kind: 'correctness', command: launchContract.correctness_command,
        execution_mode: 'direct_argv', argv: [realpathSync.native(testKersorPython)],
        cwd: canonicalWorkspace, started_at: '2026-08-22T00:00:01Z',
        finished_at: '2026-08-22T00:00:02Z', exit_code: 0, timed_out: false,
        stdout: 'correct\n', stderr: '', stdout_truncated: false, stderr_truncated: false,
      },
      {
        kind: 'benchmark', command: launchContract.benchmark_command,
        execution_mode: 'direct_argv', argv: [realpathSync.native(testKersorPython)],
        cwd: canonicalWorkspace, started_at: '2026-08-22T00:00:02Z',
        finished_at: '2026-08-22T00:00:03Z', exit_code: 1, timed_out: false,
        stdout: 'baseline=1.0\n', stderr: '', stdout_truncated: false,
        stderr_truncated: false,
      },
    ],
    policy: {
      correctness_exit_zero_required: true,
      benchmark_exit_zero_required: false,
      reason: 'performance-threshold tests may execute a valid baseline and exit nonzero',
    },
  }))
  writeValidSessionState(canonicalSession)
}

function ensureSessionInitializationFixture(
  sessionDir: string,
  workspace: string,
  controller: Agent,
): void {
  if (controller.session.events.some(event =>
    event.type === 'kersor/session-initialized')) return
  const binding = testControllerBindings.get(controller.session)
  if (binding === undefined) {
    throw new Error(`test controller ${controller.id} lacks its Experiment binding`)
  }
  const canonicalWorkspace = realpathSync.native(workspace)
  const canonicalSession = realpathSync.native(sessionDir)
  writeValidSessionState(canonicalSession, 1, controller.id)
  const setupCallId = CallId(`fixture-setup-${controller.id}`)
  const command = setupSessionCommand(
    canonicalWorkspace,
    controller.id,
    binding.launch,
    binding.freshSession,
  )
  controller.session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: setupCallId,
    name: 'bash',
    arguments: JSON.stringify({ command }),
  })
  const data = {
    schema_version: 1,
    contract: 'dsh_session_initialization_v1',
    authority: 'dsh_host',
    experiment_id: binding.experimentId,
    workspace: canonicalWorkspace,
    session_dir: canonicalSession,
    controller_session_id: controller.id,
    setup_call_id: setupCallId,
    setup_command: command,
    kersor_python: {
      path: testKersorPython,
      sha256: fileSha256(testKersorPython),
    },
    launch: binding.launch,
    session_config: {
      path: join(canonicalSession, 'session-config.json'),
      sha256: fileSha256(join(canonicalSession, 'session-config.json')),
    },
    state: {
      path: join(canonicalSession, 'state.json'),
      sha256: fileSha256(join(canonicalSession, 'state.json')),
    },
    workflow_catalog: {
      path: join(canonicalSession, 'workflow-catalog.json'),
      sha256: fileSha256(join(canonicalSession, 'workflow-catalog.json')),
    },
    adapter: { path: testSetupAdapter, sha256: fileSha256(testSetupAdapter) },
    kernel: {
      path: join(canonicalWorkspace, 'kernel.py'),
      sha256: fileSha256(join(canonicalWorkspace, 'kernel.py')),
    },
  }
  writeFileSync(
    join(canonicalSession, 'session-initialization-receipt.json'),
    JSON.stringify(data),
  )
  controller.session.append('kersor/session-initialized', data as never)
}

function prepareAuthorStaging(sessionDir: string): string {
  const staging = join(sessionDir, 'workflow-authoring', 'staging')
  mkdirSync(staging, { recursive: true })
  writeFileSync(join(staging, 'workflow.js'), [
    "export const meta = { name: 'authored-test' }",
    'const result = { overall_speedup: null, best_kernel_code: null }',
    'return result',
    '',
  ].join('\n'))
  writeFileSync(join(staging, 'metadata.json'), JSON.stringify({
    candidate_type: 'authored',
    technique: 'instruction_scheduling',
    speedup_field: 'overall_speedup',
    best_kernel_field: 'best_kernel_code',
    languages: ['python_reference'],
    backends: ['python'],
    all_args: [],
  }))
  writeFileSync(join(staging, 'rationale.md'), 'author-owned rationale\n')
  return realpathSync.native(staging)
}

function writeAuthorContextFixture(sessionDir: string): void {
  const canonicalSession = realpathSync.native(sessionDir)
  const config = readJsonFixture(join(canonicalSession, 'session-config.json')) as {
    readonly task_dir: string
    readonly kernel_path: string
  }
  const projectRoot = realpathSync.native(config.task_dir)
  const kernelPath = realpathSync.native(config.kernel_path)
  const authoring = join(canonicalSession, 'workflow-authoring')
  writeFileSync(join(authoring, 'author-context.json'), JSON.stringify({
    schema_version: 1,
    session_dir: canonicalSession,
    task: { kernel_profile: '' },
    authoring_contract: {
      portable_path_contract: {
        schema_version: 1,
        physical_project_root: projectRoot,
        forbidden_static_roots: [projectRoot, canonicalSession],
        forbidden_static_paths: [projectRoot, kernelPath],
        enforced_files: ['workflow.js', 'metadata.json', 'rationale.md'],
        runtime_arg_examples: [
          '${args.kernel_path}',
          '${args.problem_path}',
          '${args.harness_path}',
          '${args.task_dir}',
        ],
      },
    },
  }))
}

function writeAuthorHandoff(sessionDir: string): string {
  const staging = realpathSync.native(join(sessionDir, 'workflow-authoring', 'staging'))
  const handoff = join(sessionDir, 'workflow-authoring', 'author-handoff.json')
  const authorContext = join(sessionDir, 'workflow-authoring', 'author-context.json')
  if (!existsSync(authorContext)) writeAuthorContextFixture(sessionDir)
  writeFileSync(handoff, `${JSON.stringify({
    schema_version: 1,
    staging,
    files: Object.fromEntries([
      'workflow.js', 'metadata.json', 'rationale.md',
    ].map(name => [name, `sha256:${fileSha256(join(staging, name))}`])),
    author_context: {
      path: authorContext,
      sha256: `sha256:${fileSha256(authorContext)}`,
    },
    future_core_field: { accepted_by_content_hash: true },
  }, null, 2)}\n`)
  return handoff
}

function appendAuthorProducedFixture(controller: Agent, sessionDir: string): void {
  const canonicalSession = realpathSync.native(sessionDir)
  const context = join(canonicalSession, 'workflow-authoring', 'author-context.json')
  if (!existsSync(context)) writeAuthorContextFixture(sessionDir)
  controller.session.append('tool/call', {
    turn: 1, step: 1, callId: CallId('fixture-author-call'),
    name: 'kersor_protocol', arguments: JSON.stringify({ action: 'author' }),
  })
  controller.session.append('kersor/author-produced', {
    schema_version: 1,
    contract: 'dsh_author_producer_v1',
    authority: 'dsh_host',
    session_dir: canonicalSession,
    controller_session_id: controller.id,
    author_call_id: CallId('fixture-author-call'),
    author_session_id: SessionId('fixture-author-child'),
    author_context: { path: context, sha256: fileSha256(context) },
  })
}

function appendAuthorSealFixture(controller: Agent, sessionDir: string): void {
  appendAuthorProducedFixture(controller, sessionDir)
  const handoff = realpathSync.native(writeAuthorHandoff(sessionDir))
  controller.session.append('tool/call', {
    turn: 1, step: 1, callId: CallId('fixture-seal-call'),
    name: 'kersor_author_commit', arguments: JSON.stringify({ action: 'seal' }),
  })
  controller.session.append('kersor/author-handoff-sealed', {
    schema_version: 1,
    contract: 'dsh_author_handoff_seal_v2',
    authority: 'dsh_host',
    session_dir: realpathSync.native(sessionDir),
    controller_session_id: controller.id,
    author_call_id: CallId('fixture-author-call'),
    author_session_id: SessionId('fixture-author-child'),
    seal_call_id: CallId('fixture-seal-call'),
    handoff: { path: handoff, sha256: fileSha256(handoff) },
  })
}

function appendAuthorSaveFixture(controller: Agent, sessionDir: string): void {
  const seal = controller.session.events.find(
    (event): event is Extract<SessionEvent, { type: 'kersor/author-handoff-sealed' }> =>
      event.type === 'kersor/author-handoff-sealed',
  )
  if (seal === undefined) throw new Error('test author seal is missing')
  controller.session.append('tool/call', {
    turn: 1, step: 1, callId: CallId('fixture-save-call'),
    name: 'kersor_author_commit', arguments: JSON.stringify({ action: 'save' }),
  })
  controller.session.append('kersor/author-save-attempted', {
    schema_version: 1,
    contract: 'dsh_author_save_attempt_v2',
    authority: 'dsh_host',
    session_dir: realpathSync.native(sessionDir),
    controller_session_id: controller.id,
    save_call_id: CallId('fixture-save-call'),
    seal_call_id: seal.data.seal_call_id,
    handoff: seal.data.handoff,
  })
}

function writeSavedAuthorProposal(sessionDir: string, name = 'authored-test'): string {
  const directory = join(
    realpathSync.native(sessionDir), 'workflow-authoring', 'proposals', name,
  )
  mkdirSync(directory, { recursive: true })
  const workflowPath = join(directory, 'workflow.js')
  writeFileSync(workflowPath, 'export const meta = {}\nreturn {}\n')
  writeFileSync(join(directory, 'metadata.json'), '{}\n')
  writeFileSync(join(directory, 'proposal.json'), JSON.stringify({
    schema_version: 1,
    workflow_name: name,
    origin: 'authored',
    status: 'probation',
    evidence_binding: {
      workflow_hash: `sha256:${fileSha256(workflowPath)}`,
      binding_hash: `sha256:${'b'.repeat(64)}`,
    },
  }))
  return [
    `PROPOSAL_NAME=${name}`,
    `PROPOSAL_DIR=${directory}`,
    'ORIGIN=authored',
    'STATUS=probation',
    `METADATA=${join(directory, 'metadata.json')}`,
    `RECORD=${join(directory, 'proposal.json')}`,
    '',
  ].join('\n')
}

function writeAuthorCatalog(sessionDir: string, name = 'authored-test'): void {
  const canonicalSession = realpathSync.native(sessionDir)
  writeFileSync(join(canonicalSession, 'workflow-catalog.json'), JSON.stringify({
    workflows: [{
      name,
      js_path: join(
        canonicalSession, 'workflow-authoring', 'proposals', name, 'workflow.js',
      ),
      probation: true,
      proposal_status: 'probation',
      proposal_binding_hash: `sha256:${'b'.repeat(64)}`,
    }],
  }))
}

function appendValidBaselineCustody(
  sessionDir: string,
  workspace: string,
  controller: Agent,
  phaseCount = 3,
): void {
  writeValidBaselineAuthority(sessionDir, workspace)
  ensureSessionInitializationFixture(sessionDir, workspace, controller)
  const configPath = join(sessionDir, 'session-config.json')
  const methodPath = join(sessionDir, 'test-method.md')
  const witnessPath = join(sessionDir, 'baseline-witness.json')
  const witness = readJsonFixture(witnessPath) as BaselineWitnessFixture
  const common = {
    schema_version: 1 as const,
    authority: 'dsh_host' as const,
    launch: launchContract,
    workspace,
    session_dir: sessionDir,
    controller_session_id: controller.id,
    session_config: { path: configPath, sha256: fileSha256(configPath) },
    task_dir: workspace,
    kernel: { path: join(workspace, 'kernel.py'), sha256: fileSha256(join(workspace, 'kernel.py')) },
    test_method: { path: methodPath, sha256: fileSha256(methodPath) },
    commands: {
      correctness: launchContract.correctness_command,
      benchmark: launchContract.benchmark_command,
    },
  }
  const executions = witness.executions.map(execution => ({
    kind: execution.kind,
    command: execution.command,
    exit_code: execution.exit_code,
    timed_out: execution.timed_out,
    stdout_sha256: sha256(execution.stdout),
    stderr_sha256: sha256(execution.stderr),
  }))
  const phases: Array<{
    type: 'kersor/baseline-initialized' | 'kersor/baseline-recorded' | 'kersor/baseline-verified'
    receipt: string
    command: string
    data: BaselinePhaseData
  }> = [
    {
      type: 'kersor/baseline-initialized' as const,
      receipt: 'baseline-initialization-receipt.json',
      command: baselineInitCommand(sessionDir),
      data: {
        ...common,
        contract: 'dsh_baseline_initialized_v1' as const,
        call_id: `baseline-init-${basename(sessionDir)}`,
      },
    },
    {
      type: 'kersor/baseline-recorded' as const,
      receipt: 'baseline-recording-receipt.json',
      command: baselineRecordCommand(sessionDir, workspace),
      data: {
        ...common,
        contract: 'dsh_baseline_recorded_v1' as const,
        call_id: `baseline-record-${basename(sessionDir)}`,
        initialization_receipt: {
          path: join(sessionDir, 'baseline-initialization-receipt.json'),
          sha256: '',
        },
        witness: { path: witnessPath, sha256: fileSha256(witnessPath) },
        executions,
      },
    },
    {
      type: 'kersor/baseline-verified' as const,
      receipt: 'baseline-verification-receipt.json',
      command: baselineVerifyCommand(sessionDir),
      data: {
        ...common,
        contract: 'dsh_baseline_verified_v1' as const,
        call_id: `baseline-verify-${basename(sessionDir)}`,
        recording_receipt: {
          path: join(sessionDir, 'baseline-recording-receipt.json'),
          sha256: '',
        },
        witness: { path: witnessPath, sha256: fileSha256(witnessPath) },
        executions,
        protected_files: testProtectedFiles(workspace, join(workspace, 'kernel.py')),
        worktree: testWorktreeSnapshot(workspace, sessionDir),
        verdict: 'pass' as const,
      },
    },
  ]
  for (const [index, phase] of phases.slice(0, phaseCount).entries()) {
    if (index === 1) {
      const receipt = phase.data.initialization_receipt
      if (receipt === undefined) throw new Error('record phase lacks initialization receipt')
      receipt.sha256 = fileSha256(
        join(sessionDir, 'baseline-initialization-receipt.json'),
      )
    }
    if (index === 2) {
      const receipt = phase.data.recording_receipt
      if (receipt === undefined) throw new Error('verify phase lacks recording receipt')
      receipt.sha256 = fileSha256(
        join(sessionDir, 'baseline-recording-receipt.json'),
      )
    }
    controller.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CallId(phase.data.call_id),
      name: 'bash',
      arguments: JSON.stringify({ command: phase.command }),
    })
    writeFileSync(join(sessionDir, phase.receipt), JSON.stringify(phase.data))
    controller.session.append(phase.type, phase.data as never)
  }
}

describe('KerSor conversation controls', () => {
  it('persists one typed launch authority and reuses its canonical JSON on resume', async () => {
    const harness = await setup()
    const started = await call(harness, 'kersor_start', {
      objective: 'Reach an 8x target, if possible.',
      launch: launchContract,
    })
    expect(started.isError, JSON.stringify(started.content)).toBe(false)
    expect(starts(harness.session)[0]?.data.launch).toEqual(launchContract)
    const canonical = JSON.stringify(launchContract)
    expect(startedPrompt(harness)).toContain(`Typed launch contract (canonical JSON): ${canonical}`)
    expect(startedPrompt(harness)).toContain('authoritative and overrides conflicting objective or continuation prose')
    expect(startedPrompt(harness)).toContain('target_speedup = 8 (JSON number only; never append x, %, or another suffix)')
    expect(startedPrompt(harness)).toContain(`correctness_command = ${JSON.stringify(launchContract.correctness_command)} (copy and execute verbatim`)
    expect(startedPrompt(harness)).toContain(`benchmark_command = ${JSON.stringify(launchContract.benchmark_command)} (copy and execute verbatim`)
    expect(startedPrompt(harness)).toContain('selected_workflow.name is STALLED is a recoverable routing gap')
    expect(startedPrompt(harness)).toContain('Use kersor_protocol for profile, select_workflow, and author')
    expect(startedPrompt(harness)).toContain('the Host owns each complete protocol handoff')
    expect(startedPrompt(harness)).toContain('complete Phase 3.6 and the full same-round selection sequence')
    expect(startedPrompt(harness)).toContain('kersor_workflow({exp_dir: <exact absolute run-N directory>})')
    expect(startedPrompt(harness)).toContain('never call workflow directly')
    expect(startedPrompt(harness)).toContain('first kersor_workflow call permanently consumes that run')
    expect(startedPrompt(harness)).toContain('session-synthesizer is the sole writer')
    expect(startedPrompt(harness)).not.toContain('KERSOR_DISPATCH_TRANSFORM_COMMAND_V1')
    expect(startedPrompt(harness)).toContain(
      'After the foreground dispatch producer succeeds, the Host applies runtime controls',
    )
    expect(startedPrompt(harness)).toContain(
      'call kersor_author_commit with action seal',
    )
    expect(startedPrompt(harness)).toContain('The Host owns both executions, receipt custody, and exact-once consumption')
    expect(startedPrompt(harness)).toContain('Never call kersor-state.sh set current_round')
    expect(startedPrompt(harness)).toContain('branch only on PHASE_COMMITTED=complete, advanced, or stalled')

    const resumed = await call(harness, 'kersor_resume', {
      instruction: 'Try a 9x target instead.',
    })
    expect(resumed.isError).toBe(false)
    expect(resumedPrompt(harness)).toContain(`Typed launch contract (canonical JSON): ${canonical}`)
    expect(resumedPrompt(harness)).toContain('target_speedup = 8 (JSON number only')
    expect(resumedPrompt(harness)).toContain('selected_workflow.name is STALLED is a recoverable routing gap')
    expect(resumedPrompt(harness)).toContain('Use kersor_protocol for profile, select_workflow, and author')
    expect(resumedPrompt(harness)).toContain('dispatch any non-STALLED commit before synthesizing a terminal STALLED decision')
    expect(resumedPrompt(harness)).toContain('end this controller turn at the unchanged canonical round and resume later')
    expect(starts(harness.session)).toHaveLength(1)
  })

  it('runs the complete profile handoff with one exact foreground child and Host-held provenance', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-protocol-profile-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'protocol-profile')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      appendValidBaselineCustody(
        realpathSync.native(sessionDir), realpathSync.native(workspace), controller,
      )
      writeKersorProtocolContext(
        sessionDir,
        'profile-handoff/context.json',
        {
          description: 'Profile one KerSor Session',
          prompt: 'Write the canonical kernel profile.',
          run_in_background: false,
        },
      )
      harness.hostTransformSubprocess.stdout = 'helper complete\n'
      const bashCallsBefore = controller.session.events.filter(event =>
        event.type === 'tool/call' && event.data.name === 'bash').length

      const result = await call(harness, 'kersor_protocol', {
        action: 'profile',
      }, controller)

      expect(result.isError, JSON.stringify(result.content)).toBe(false)
      expect(result.value).toEqual({
        action: 'profile',
        stdout: 'helper complete\nhelper complete\nhelper complete\n',
        stderr: '',
      })
      expect(controller.session.events.filter(event =>
        event.type === 'tool/call' && event.data.name === 'bash')).toHaveLength(bashCallsBefore)
      const canonicalSession = realpathSync.native(sessionDir)
      const script = join(testKersorRoot, 'scripts', 'profile-handoff.py')
      expect(harness.hostTransformSubprocess.specs.map(spec => spec.argv)).toEqual([
        [testKersorPython, script, 'context', '--session', canonicalSession],
        [
          testKersorPython, script, 'seal', '--session', canonicalSession,
          '--producer-session-id', 'kersor-protocol-child-1',
        ],
        [testKersorPython, script, 'verify', '--session', canonicalSession],
      ])
      expect(harness.hostTransformSubprocess.specs[0]).toMatchObject({
        cwd: realpathSync.native(workspace),
        env: { KERSOR_PYTHON: testKersorPython, KERSOR_ROOT: testKersorRoot },
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 64 * 1024 },
          stderr: { maxBytes: 64 * 1024 },
        },
        graceMs: 1_000,
        signal,
      })
      const started = harness.subagents.oneShotStarts[0] as {
        provider: string
        spec: { label: string; prompt: ContentBlock[]; parent: Agent; signal: AbortSignal }
      }
      expect(started).toEqual({
        provider: 'spawn',
        spec: {
          label: 'Profile one KerSor Session',
          prompt: [{ type: 'text', text: 'Write the canonical kernel profile.' }],
          parent: controller,
          signal,
        },
      })
      expect(harness.subagents.disposals).toEqual([SessionId('kersor-protocol-child-1')])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('ignores a premature profile call and consumes only the first post-baseline call', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-protocol-profile-baseline-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'protocol-profile-baseline')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      writeValidBaselineAuthority(sessionDir, workspace)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      writeKersorProtocolContext(sessionDir, 'profile-handoff/context.json')

      const premature = await call(harness, 'kersor_protocol', {
        action: 'profile',
      }, controller)
      expect(premature.isError).toBe(true)
      expect(promptText(premature.content)).toMatch(/baseline|receipt/i)
      expect(harness.hostTransformSubprocess.specs).toHaveLength(0)
      expect(harness.subagents.oneShotStarts).toHaveLength(0)

      appendValidBaselineCustody(
        realpathSync.native(sessionDir), realpathSync.native(workspace), controller,
      )
      writeValidSessionState(sessionDir, 1, controller.id)
      const completed = await call(harness, 'kersor_protocol', {
        action: 'profile',
      }, controller)
      expect(completed.isError, JSON.stringify(completed.content)).toBe(false)
      expect(harness.hostTransformSubprocess.specs).toHaveLength(3)
      expect(harness.subagents.oneShotStarts).toHaveLength(1)

      const retry = await call(harness, 'kersor_protocol', {
        action: 'profile',
      }, controller)
      expect(retry.isError).toBe(true)
      expect(promptText(retry.content)).toMatch(/already consumed|first durable/i)
      expect(harness.hostTransformSubprocess.specs).toHaveLength(3)
      expect(harness.subagents.oneShotStarts).toHaveLength(1)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('derives selection argv and the complete author handoff from durable Session authority', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-protocol-actions-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'protocol-actions')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      writeKersorProtocolContext(
        sessionDir,
        'workflow-authoring/author-context.json',
        {
          description: 'Author one KerSor workflow proposal',
          prompt: 'Write the three direct author files.',
          run_in_background: false,
          future_dispatch_key: ['accepted'],
        },
        { future_owner: { accepted: true } },
      )
      const canonicalSession = realpathSync.native(sessionDir)
      configureSelectionProcesses(harness, sessionDir, 'agent-advise')
      harness.ctx.tools.register(defineTool({
        name: 'write',
        description: 'Write the strategy-selector decision.',
        parameters: {
          file_path: { type: 'string', required: true },
          content: { type: 'string', required: true },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: (args) => {
          writeFileSync(args.file_path, args.content)
          return Promise.resolve(args.file_path)
        },
      }))
      harness.subagents.oneShotRun = async (id) => {
        if (id === SessionId('kersor-protocol-child-1')) {
          await new Promise(resolveTimer => setTimeout(resolveTimer, 0))
          const child = descendantAgent(harness, controller.session, id)
          const decision = await call(harness, 'write', {
            file_path: join(canonicalSession, 'round-1-routing-decision.json'),
            content: JSON.stringify({
              schema_version: 2,
              round: 1,
              chosen_workflow: 'alpha',
              phase_intent: 'optimize',
              rationale: 'kernel-profile.md matches alpha',
              considered: [{
                name: 'alpha', verdict: 'chosen', rank: 1,
                confidence_bucket: 'high', why: 'profile fit',
              }],
            }),
          }, child)
          if (decision.isError) throw new Error(promptText(decision.content))
        }
        return { output: [], stopReason: 'completed' }
      }

      const selection = await call(harness, 'kersor_protocol', {
        action: 'select_workflow',
      }, controller)
      const author = await call(harness, 'kersor_protocol', {
        action: 'author',
      }, controller)

      expect(selection.isError, JSON.stringify(selection.content)).toBe(false)
      expect(author.isError, JSON.stringify(author.content)).toBe(false)
      const scripts = join(testKersorRoot, 'scripts')
      expect(harness.hostTransformSubprocess.specs.map(spec => spec.argv)).toEqual([
        [
          'bash', join(scripts, 'select-workflow.sh'), canonicalSession, '1',
          join(canonicalSession, 'workflow-catalog.json'),
        ],
        [
          'bash', join(scripts, 'run-kersor-python.sh'),
          'selection-handoff.py', '--session', canonicalSession,
          '--round', '1',
        ],
        [
          'bash', join(scripts, 'finalize-selection.sh'), canonicalSession, '1',
        ],
        [
          'bash', join(scripts, 'run-kersor-python.sh'),
          'author-workflow-context.py', '--session', canonicalSession,
          '--out', join(canonicalSession, 'workflow-authoring', 'author-context.json'),
        ],
      ])
      const started = harness.subagents.oneShotStarts[1] as {
        provider: string
        spec: { label: string; prompt: ContentBlock[] }
      }
      expect(started).toMatchObject({
        provider: 'spawn',
        spec: {
          label: 'Author one KerSor workflow proposal',
          prompt: [{ type: 'text', text: 'Write the three direct author files.' }],
        },
      })
      expect(harness.subagents.oneShotStarts[0]).toMatchObject({
        provider: 'spawn',
        spec: {
          label: 'Choose KerSor workflow for round 1',
          prompt: [{
            type: 'text',
            text: 'Read the Core strategy-selector role and write its decision.',
          }],
          toolFilter: { allow: ['read', 'glob', 'grep', 'write'] },
        },
      })
      expect(harness.subagents.disposals).toEqual([
        SessionId('kersor-protocol-child-1'),
        SessionId('kersor-protocol-child-2'),
      ])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.each(['stalled', 'locked'] as const)(
    'finalizes a %s selection without starting a strategy-selector child',
    async (disposition) => {
      const workspace = mkdtempSync(join(tmpdir(), `dsh-kersor-selection-${disposition}-`))
      try {
        const harness = await setup(workspace)
        const controller = await startController(harness)
        const sessionDir = join(workspace, '.kersor', `selection-${disposition}`)
        writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
        ensureSessionInitializationFixture(sessionDir, workspace, controller)
        configureSelectionProcesses(harness, sessionDir, disposition)

        const result = await call(
          harness,
          'kersor_protocol',
          { action: 'select_workflow' },
          controller,
        )

        expect(result.isError, JSON.stringify(result.content)).toBe(false)
        expect(harness.subagents.oneShotStarts).toHaveLength(0)
        expect(harness.hostTransformSubprocess.specs).toHaveLength(3)
        expect(harness.hostTransformSubprocess.specs[2]?.argv[1]).toMatch(
          /finalize-selection\.sh$/,
        )
        const selection = readJsonFixture(
          join(realpathSync.native(sessionDir), 'round-1-selection.json'),
        ) as { attempt_plan: { status: string; commit: { status: string } } }
        expect(selection.attempt_plan.status).toBe('committed')
        expect(selection.attempt_plan.commit.status).toBe('committed')
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    },
  )

  it('rejects a strategy-selector that completes with externally written bytes but no accepted Write', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-selection-unobserved-write-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'selection-unobserved-write')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      configureSelectionProcesses(harness, sessionDir, 'agent-advise')
      harness.subagents.oneShotRun = async () => {
        await new Promise(resolveTimer => setTimeout(resolveTimer, 0))
        writeFileSync(
          join(realpathSync.native(sessionDir), 'round-1-routing-decision.json'),
          JSON.stringify({ chosen_workflow: 'alpha', rationale: 'external write' }),
        )
        return { output: [], stopReason: 'completed' }
      }

      const result = await call(
        harness, 'kersor_protocol', { action: 'select_workflow' }, controller,
      )

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/Host-observed.*write/i)
      expect(harness.hostTransformSubprocess.specs).toHaveLength(2)
      expect(harness.subagents.disposals).toEqual([
        SessionId('kersor-protocol-child-1'),
      ])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects a repeated same-catalog selection but permits a changed-catalog re-selection', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-selection-catalog-boundary-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'selection-catalog-boundary')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      configureSelectionProcesses(harness, sessionDir, 'locked')

      const first = await call(
        harness, 'kersor_protocol', { action: 'select_workflow' }, controller,
      )
      const repeated = await call(
        harness, 'kersor_protocol', { action: 'select_workflow' }, controller,
      )

      expect(first.isError, JSON.stringify(first.content)).toBe(false)
      expect(repeated.isError).toBe(true)
      expect(promptText(repeated.content)).toMatch(/already consumed|unchanged workflow catalog/i)
      expect(harness.hostTransformSubprocess.specs).toHaveLength(3)

      writeFileSync(join(realpathSync.native(sessionDir), 'workflow-catalog.json'), JSON.stringify({
        schema_version: 1,
        workflows: [{ name: 'new-proposal' }],
      }))
      const reselection = await call(
        harness, 'kersor_protocol', { action: 'select_workflow' }, controller,
      )

      expect(reselection.isError, JSON.stringify(reselection.content)).toBe(false)
      expect(harness.hostTransformSubprocess.specs).toHaveLength(6)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects environment-only paired routing before selection starts', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-selection-paired-'))
    const originalPair = process.env.KERSOR_PAIR_ID
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'selection-paired')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      process.env.KERSOR_PAIR_ID = 'pair-1'

      const result = await call(
        harness, 'kersor_protocol', { action: 'select_workflow' }, controller,
      )

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/paired routing|durable Session authority/i)
      expect(harness.hostTransformSubprocess.specs).toHaveLength(0)
      expect(harness.subagents.oneShotStarts).toHaveLength(0)
    } finally {
      if (originalPair === undefined) delete process.env.KERSOR_PAIR_ID
      else process.env.KERSOR_PAIR_ID = originalPair
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.each([
    [{ action: 'profile', producer_session_id: 'unexpected-child' }],
    [{ action: 'profile_context' }],
    [{ action: 'author', session_dir: '/tmp/guess' }],
    [{ action: 'unknown' }],
  ])('rejects non-canonical typed protocol arguments %j before subprocess dispatch', async (args) => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-protocol-arguments-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'protocol-arguments')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)

      const result = await call(harness, 'kersor_protocol', args, controller)

      expect(result.isError).toBe(true)
      expect(harness.hostTransformSubprocess.specs).toHaveLength(0)
      expect(harness.subagents.oneShotStarts).toHaveLength(0)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.each(['session', 'description', 'prompt', 'background'])(
    'rejects an invalid %s field in the Host-read author dispatch',
    async (field) => {
      const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-protocol-context-'))
      try {
        const harness = await setup(workspace)
        const controller = await startController(harness)
        const sessionDir = join(workspace, '.kersor', 'protocol-context')
        writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
        ensureSessionInitializationFixture(sessionDir, workspace, controller)
        const path = writeKersorProtocolContext(
          sessionDir, 'workflow-authoring/author-context.json',
        )
        const context = readJsonFixture(path) as Record<string, unknown>
        const dispatch = context.dispatch as Record<string, unknown>
        if (field === 'session') context.session_dir = `${sessionDir}-other`
        else if (field === 'description') dispatch.description = '  '
        else if (field === 'prompt') dispatch.prompt = ''
        else dispatch.run_in_background = true
        writeFileSync(path, JSON.stringify(context))

        const result = await call(harness, 'kersor_protocol', {
          action: 'author',
        }, controller)

        expect(result.isError).toBe(true)
        expect(harness.hostTransformSubprocess.specs).toHaveLength(1)
        expect(harness.subagents.oneShotStarts).toHaveLength(0)
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    },
  )

  it('durably consumes profile after a child failure and never launches a retry', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-protocol-child-failure-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'protocol-child-failure')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      appendValidBaselineCustody(
        realpathSync.native(sessionDir), realpathSync.native(workspace), controller,
      )
      writeKersorProtocolContext(sessionDir, 'profile-handoff/context.json')
      harness.subagents.oneShotResult = {
        output: [{ type: 'text', text: 'partial profile' }],
        stopReason: 'error',
        diagnostic: 'profiler failed',
      }

      const result = await call(harness, 'kersor_protocol', {
        action: 'profile',
      }, controller)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toContain('profiler failed')
      expect(harness.hostTransformSubprocess.specs).toHaveLength(1)
      expect(harness.subagents.oneShotStarts).toHaveLength(1)
      expect(harness.subagents.disposals).toEqual([SessionId('kersor-protocol-child-1')])

      const retry = await call(harness, 'kersor_protocol', {
        action: 'profile',
      }, controller)
      expect(retry.isError).toBe(true)
      expect(promptText(retry.content)).toMatch(/already consumed|first durable/i)
      expect(harness.hostTransformSubprocess.specs).toHaveLength(1)
      expect(harness.subagents.oneShotStarts).toHaveLength(1)
      expect(harness.subagents.disposals).toEqual([SessionId('kersor-protocol-child-1')])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects typed protocol calls from descendants, attached controllers, and closed Experiments', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-protocol-authority-'))
    try {
      const descendantHarness = await setup(workspace)
      const controller = await startController(descendantHarness)
      const sessionDir = join(workspace, '.kersor', 'protocol-authority')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      const descendant = descendantAgent(descendantHarness, controller.session, 'protocol-descendant')
      const descendantResult = await call(descendantHarness, 'kersor_protocol', {
        action: 'profile',
      }, descendant)
      expect(descendantResult.isError).toBe(true)

      const closedStart = starts(descendantHarness.session)[0]!
      descendantHarness.session.append('kersor/experiment-checkpoint', {
        experimentId: closedStart.data.experimentId,
        childSessionId: controller.id,
        revision: 2,
        status: 'completed',
        steps: [],
      } as never)
      const closedResult = await call(descendantHarness, 'kersor_protocol', {
        action: 'profile',
      }, controller)
      expect(closedResult.isError).toBe(true)
      expect(promptText(closedResult.content)).toMatch(/closed|terminal|completed/i)

      const attachedHarness = await setup(workspace)
      const origin = appendDurableOrigin(attachedHarness)
      const attachedResult = await call(
        attachedHarness, 'kersor_attach', attachArguments(origin),
      )
      expect(attachedResult.isError, JSON.stringify(attachedResult.content)).toBe(false)
      const attachedStart = starts(attachedHarness.session)[0]!
      const attachedController = descendantAgent(
        attachedHarness, attachedHarness.session, attachedStart.data.childSessionId,
      )
      const protocolResult = await call(attachedHarness, 'kersor_protocol', {
        action: 'profile',
      }, attachedController)
      expect(protocolResult.isError).toBe(true)
      expect(promptText(protocolResult.content)).toMatch(/created Session|attached/i)
      expect(attachedHarness.hostTransformSubprocess.specs).toHaveLength(0)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('does not report typed protocol success when its subprocess exits nonzero', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-protocol-failure-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'protocol-failure')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      appendValidBaselineCustody(
        realpathSync.native(sessionDir), realpathSync.native(workspace), controller,
      )
      harness.hostTransformSubprocess.exitCode = 7
      harness.hostTransformSubprocess.stdout = 'misleading success\n'
      harness.hostTransformSubprocess.stderr = 'profile context failed\n'

      const result = await call(harness, 'kersor_protocol', {
        action: 'profile',
      }, controller)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toContain('exit 7')
      expect(promptText(result.content)).toContain('profile context failed')
      expect(harness.hostTransformSubprocess.specs).toHaveLength(1)
      expect(harness.subagents.oneShotStarts).toHaveLength(0)

      const retry = await call(harness, 'kersor_protocol', {
        action: 'profile',
      }, controller)
      expect(retry.isError).toBe(true)
      expect(promptText(retry.content)).toMatch(/already consumed|first durable/i)
      expect(harness.hostTransformSubprocess.specs).toHaveLength(1)
      expect(harness.subagents.oneShotStarts).toHaveLength(0)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('requires a typed launch before creating a fresh Experiment binding', async () => {
    const harness = await setup()

    const result = await call(harness, 'kersor_start', { objective: 'Optimize' })

    expect(result.isError).toBe(true)
    expect(promptText(result.content)).toMatch(
      /typed launch|launch.*required|missing required property "launch"/i,
    )
    expect(starts(harness.session)).toHaveLength(0)
    expect(harness.subagents.starts).toHaveLength(0)
  })

  it('freezes all four isolation modes off in the effective fresh-session launch', async () => {
    const harness = await setup()
    const requested = {
      ...launchContract,
      retrieval_mode: 'on' as const,
      transfer_mode: 'full' as const,
      experience_mode: 'on' as const,
      kernelwiki_experience_export_mode: 'on' as const,
    }
    const effective = {
      ...requested,
      retrieval_mode: 'off' as const,
      transfer_mode: 'off' as const,
      experience_mode: 'off' as const,
      kernelwiki_experience_export_mode: 'off' as const,
    }

    const result = await call(harness, 'kersor_start', {
      objective: 'Isolated optimization', fresh_session: true, launch: requested,
    })

    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(starts(harness.session)[0]!.data).toMatchObject({
      freshSession: true,
      launch: effective,
    })
    expect(startedPrompt(harness)).toContain(
      `Typed launch contract (canonical JSON): ${JSON.stringify(effective)}`,
    )
  })

  it('cold-resumes only the typed launch from the same durable origin Experiment', async () => {
    const harness = await setup()
    const experimentId = 'kersor-cold-origin'
    const childSessionId = SessionId('kersor-cold-child')
    harness.session.append('kersor/experiment-start', {
      experimentId,
      childSessionId,
      origin: 'created',
      objective: 'Durable objective',
      freshSession: false,
      launch: launchContract,
      turn: 1,
      step: 1,
    } as never)

    const result = await call(harness, 'kersor_resume', {
      experiment_id: experimentId,
      instruction: 'Ignore the old target and use 99x.',
    })

    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(starts(harness.session)).toHaveLength(1)
    expect(startedPrompt(harness)).toContain(
      `Typed launch contract (canonical JSON): ${JSON.stringify(launchContract)}`,
    )
    expect(startedPrompt(harness)).toContain('target_speedup = 8')
    expect(harness.subagents.starts).toHaveLength(1)
  })

  it('rejects attach when the supplied launch differs from its durable origin Experiment', async () => {
    const harness = await setup()
    const origin = appendDurableOrigin(harness)
    const result = await call(harness, 'kersor_attach', {
      ...attachArguments(origin),
      launch: { ...origin.launch, target_speedup: origin.launch.target_speedup + 1 },
    })

    expect(result.isError).toBe(true)
    expect(promptText(result.content)).toMatch(/durable origin.*launch|launch.*differs/i)
    expect(starts(harness.session)).toHaveLength(0)
    expect(harness.subagents.starts).toHaveLength(0)
  })

  it('imports current source authority after legal state and Workflow catalog progression', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-attach-progress-'))
    try {
      const harness = await setup(workspace)
      const origin = appendDurableOrigin(harness)
      expect(origin.sessionDir).toBeDefined()
      const sessionDir = origin.sessionDir!
      const statePath = join(sessionDir, 'state.json')
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
      writeFileSync(statePath, JSON.stringify({ ...state, current_round: 2, prepared: true }))
      const catalog = JSON.parse(
        readFileSync(join(testKersorRoot, 'workflow-catalog.json'), 'utf8'),
      ) as { workflows: unknown[] }
      const catalogPath = join(sessionDir, 'workflow-catalog.json')
      writeFileSync(catalogPath, JSON.stringify({ workflows: catalog.workflows.slice(0, 1) }))

      const result = await call(harness, 'kersor_attach', attachArguments(origin))

      expect(result.isError, JSON.stringify(result.content)).toBe(false)
      const attachedStart = starts(harness.session)[0]!
      const controller = harness.ctx.sessions.get(attachedStart.data.childSessionId)!
      const imports = controller.events.filter(event =>
        event.type === 'kersor/session-authority-imported')
      expect(imports).toHaveLength(1)
      const receiptPath = join(sessionDir, 'session-authority-import-receipt.json')
      expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toEqual(imports[0]!.data)
      expect(imports[0]!.data).toMatchObject({
        contract: 'dsh_session_authority_import_v1',
        authority: 'dsh_host',
        experiment_id: origin.experimentId,
        controller_session_id: controller.id,
        source_controller_session_id: origin.controller.id,
        source_state: { path: statePath, sha256: fileSha256(statePath) },
        source_workflow_catalog: { path: catalogPath, sha256: fileSha256(catalogPath) },
      })
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects attach when the source controller authority belongs to another workspace', async () => {
    const targetWorkspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-attach-target-'))
    const sourceWorkspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-attach-source-'))
    try {
      const harness = await setup(targetWorkspace)
      const origin = appendDurableOrigin(harness, launchContract, sourceWorkspace)

      const result = await call(harness, 'kersor_attach', attachArguments(origin))

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(
        /source.*workspace|workspace.*source|session_dir.*workspace/i,
      )
      expect(starts(harness.session)).toHaveLength(0)
      expect(harness.subagents.starts).toHaveLength(0)
    } finally {
      rmSync(targetWorkspace, { recursive: true, force: true })
      rmSync(sourceWorkspace, { recursive: true, force: true })
    }
  })

  it('recovers one reserved attach after materialization fails without duplicating authority', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-attach-rollback-'))
    try {
      const harness = await setup(workspace)
      const origin = appendDurableOrigin(harness)
      const importReceiptPath = join(
        origin.sessionDir!, 'session-authority-import-receipt.json',
      )
      const transferReceiptPath = join(
        origin.sessionDir!, 'session-authority-transfer-receipt.json',
      )
      const startContinuable = harness.subagents.startContinuable.bind(harness.subagents)
      let failMaterialization = true
      harness.subagents.startContinuable = (spec) => {
        if (failMaterialization) return Promise.reject(new Error('materialize failed'))
        return startContinuable(spec)
      }

      const failed = await call(harness, 'kersor_attach', attachArguments(origin))

      expect(failed.isError).toBe(true)
      expect(starts(harness.session)).toHaveLength(1)
      const reserved = starts(harness.session)[0]!
      expect(checkpoints(harness.session).at(-1)?.data.status).toBe('waiting')
      expect(existsSync(transferReceiptPath)).toBe(true)
      expect(existsSync(importReceiptPath)).toBe(false)
      expect(origin.controller.events.filter(event =>
        event.type === 'kersor/session-authority-transferred')).toHaveLength(1)

      failMaterialization = false
      const resumed = await call(harness, 'kersor_resume', {
        experiment_id: origin.experimentId,
        instruction: 'Recover the reserved attach.',
      })

      expect(resumed.isError, JSON.stringify(resumed.content)).toBe(false)
      expect(starts(harness.session)).toHaveLength(1)
      expect(starts(harness.session)[0]!.data.childSessionId).toBe(
        reserved.data.childSessionId,
      )
      expect(checkpoints(harness.session).at(-1)?.data.status).toBe('running')
      expect(origin.controller.events.filter(event =>
        event.type === 'kersor/session-authority-transferred')).toHaveLength(1)
      const target = harness.ctx.sessions.get(reserved.data.childSessionId)!
      const imports = target.events.filter(event =>
        event.type === 'kersor/session-authority-imported')
      expect(imports).toHaveLength(1)
      expect(JSON.parse(readFileSync(importReceiptPath, 'utf8'))).toEqual(imports[0]!.data)
      expect(existsSync(transferReceiptPath)).toBe(true)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects a fake durable origin Experiment and an origin missing its source controller', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-attach-missing-'))
    try {
      const harness = await setup(workspace)
      const fake = await call(harness, 'kersor_attach', {
        experiment_id: 'does-not-exist',
        launch: launchContract,
      })
      expect(fake.isError).toBe(true)
      expect(promptText(fake.content)).toMatch(/exactly one durable origin/i)

      const experimentId = 'origin-without-source-controller'
      const originParent = harness.ctx.sessions.create(SessionId('missing-source-parent'), {
        meta: { cwd: workspace },
      })
      originParent.append('kersor/experiment-start', {
        experimentId,
        childSessionId: SessionId('missing-source-child'),
        origin: 'created',
        objective: 'Missing source',
        freshSession: false,
        launch: launchContract,
        turn: 1,
        step: 1,
      } as never)
      const missing = await call(harness, 'kersor_attach', {
        experiment_id: experimentId,
        launch: launchContract,
      })
      expect(missing.isError).toBe(true)
      expect(promptText(missing.content)).toMatch(/source controller.*unavailable/i)
      expect(starts(harness.session)).toHaveLength(0)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects a tampered source initialization receipt before importing authority', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-attach-receipt-tamper-'))
    try {
      const harness = await setup(workspace)
      const origin = appendDurableOrigin(harness)
      writeFileSync(origin.setupReceiptPath!, JSON.stringify({ authority: 'dsh_host' }))

      const result = await call(harness, 'kersor_attach', attachArguments(origin))

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/initialization.*receipt|receipt.*event/i)
      expect(starts(harness.session)).toHaveLength(0)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.each(['tampered', 'truncated'] as const)(
    'rejects a %s source initialization log before importing authority',
    async (mutation) => {
      const workspace = mkdtempSync(join(tmpdir(), `dsh-kersor-attach-${mutation}-`))
      try {
        const harness = await setup(workspace)
        const origin = appendDurableOrigin(
          harness,
          launchContract,
          workspace,
          mutation === 'tampered'
            ? { tamperInitialization: true }
            : { omitInitializationEvent: true },
        )

        const result = await call(harness, 'kersor_attach', attachArguments(origin))

        expect(result.isError).toBe(true)
        expect(promptText(result.content)).toMatch(
          /Host initialization|initialization.*(authority|identity)|immutable.*identity/i,
        )
        expect(starts(harness.session)).toHaveLength(0)
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    },
  )

  it('rejects duplicate imported authority events before baseline use', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-attach-duplicate-'))
    try {
      const harness = await setup(workspace)
      const origin = appendDurableOrigin(harness)
      const attached = await call(harness, 'kersor_attach', attachArguments(origin))
      expect(attached.isError, JSON.stringify(attached.content)).toBe(false)
      const attachedStart = starts(harness.session)[0]!
      const controller = descendantAgent(
        harness, harness.session, attachedStart.data.childSessionId,
      )
      const imported = controller.session.events.find(event =>
        event.type === 'kersor/session-authority-imported')!
      expect(() => controller.session.append(
        'kersor/session-authority-imported', imported.data as never,
      )).toThrow(/repeats controller Session authority/i)
      expect(controller.session.events.filter(event =>
        event.type === 'kersor/session-authority-imported')).toHaveLength(1)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('flushes one source transfer lease after the attached reservation and before import', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-transfer-order-'))
    try {
      const harness = await setup(workspace)
      const origin = appendDurableOrigin(harness)

      const result = await call(harness, 'kersor_attach', attachArguments(origin))

      expect(result.isError, JSON.stringify(result.content)).toBe(false)
      const attachedStart = starts(harness.session)[0]!
      const transfers = origin.controller.events.filter(event =>
        event.type === 'kersor/session-authority-transferred')
      expect(transfers).toHaveLength(1)
      const transfer = transfers[0]!
      const transferReceiptPath = join(
        origin.sessionDir!, 'session-authority-transfer-receipt.json',
      )
      const transferReceipt = {
        path: transferReceiptPath,
        sha256: fileSha256(transferReceiptPath),
      }
      expect(JSON.parse(readFileSync(transferReceiptPath, 'utf8'))).toEqual(transfer.data)
      expect(transfer.data).toMatchObject({
        contract: 'dsh_session_authority_transfer_v1',
        authority: 'dsh_host',
        experiment_id: origin.experimentId,
        source_parent_session_id: origin.parent.id,
        source_controller_session_id: origin.controller.id,
        target_parent_session_id: harness.session.id,
        target_controller_session_id: attachedStart.data.childSessionId,
      })
      const target = harness.ctx.sessions.get(attachedStart.data.childSessionId)!
      const imported = target.events.filter(event =>
        event.type === 'kersor/session-authority-imported')
      expect(imported).toHaveLength(1)
      expect(imported[0]!.data).toMatchObject({
        source_event_watermark: transfer.seq,
        source_event_sha256: sha256(canonicalJson(
          origin.controller.events.filter(event => event.seq <= transfer.seq),
        )),
        source_transfer_receipt: transferReceipt,
        source_state: transfer.data.source_state,
        source_workflow_catalog: transfer.data.source_workflow_catalog,
      })
      const attachCall = harness.session.events.find(event =>
        event.type === 'tool/call' && event.data.name === 'kersor_attach')!
      if (attachCall.type !== 'tool/call') throw new Error('expected KerSor attach call')
      expect(harness.session.events.indexOf(attachCall)).toBeLessThan(
        harness.session.events.indexOf(attachedStart),
      )
      expect(attachedStart.data).toMatchObject({
        authorityIntent: {
          attach_call_id: attachCall.data.callId,
          workspace: realpathSync.native(workspace),
          session_dir: origin.sessionDir,
          source_parent_session_id: origin.parent.id,
          source_controller_session_id: origin.controller.id,
          pre_transfer_event_watermark: transfer.data.pre_transfer_event_watermark,
          pre_transfer_event_sha256: transfer.data.pre_transfer_event_sha256,
          source_setup_receipt: transfer.data.source_setup_receipt,
          source_state: transfer.data.source_state,
          source_workflow_catalog: transfer.data.source_workflow_catalog,
        },
      })
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('denies a source controller canonical baseline mutation after authority transfer', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-transfer-source-gate-'))
    try {
      const harness = await setup(workspace)
      const origin = appendDurableOrigin(harness)
      const attached = await call(harness, 'kersor_attach', attachArguments(origin))
      expect(attached.isError, JSON.stringify(attached.content)).toBe(false)
      appendTransferLeaseFixture(harness, origin)
      const source = { id: origin.controller.id, session: origin.controller } as unknown as Agent
      const calls: string[] = []
      registerBashProbe(harness, calls)

      const result = await call(harness, 'bash', {
        command: baselineInitCommand(origin.sessionDir!),
      }, source)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/transferred|source.*lease|read-only/i)
      expect(calls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('denies source tool execution after transfer while retaining its call tombstone', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-transfer-event-drift-'))
    try {
      const harness = await setup(workspace)
      const origin = appendDurableOrigin(harness)
      const attached = await call(harness, 'kersor_attach', attachArguments(origin))
      expect(attached.isError, JSON.stringify(attached.content)).toBe(false)
      appendTransferLeaseFixture(harness, origin)
      const calls: string[] = []
      registerProbe(harness, 'read', calls)
      const source = { id: origin.controller.id, session: origin.controller } as unknown as Agent

      const result = await call(harness, 'read', {}, source)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/transferred|source.*lease|read-only/i)
      expect(calls).toEqual([])
      expect(origin.controller.events.filter(event =>
        event.type === 'tool/call' && event.data.name === 'read')).toHaveLength(1)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects reserved attach recovery when state or catalog changes between transfer and import', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-transfer-file-drift-'))
    try {
      const harness = await setup(workspace)
      const origin = appendDurableOrigin(harness)
      const startContinuable = harness.subagents.startContinuable.bind(harness.subagents)
      harness.subagents.startContinuable = () => Promise.reject(new Error('materialize failed'))

      const failed = await call(harness, 'kersor_attach', attachArguments(origin))

      expect(failed.isError).toBe(true)
      expect(starts(harness.session)).toHaveLength(1)
      const reserved = starts(harness.session)[0]!
      expect(origin.controller.events.filter(event =>
        event.type === 'kersor/session-authority-transferred')).toHaveLength(1)
      expect(harness.ctx.sessions.get(reserved.data.childSessionId)).toBeUndefined()
      const importReceiptPath = join(
        origin.sessionDir!, 'session-authority-import-receipt.json',
      )
      expect(existsSync(importReceiptPath)).toBe(false)

      const statePath = join(origin.sessionDir!, 'state.json')
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
      writeFileSync(statePath, JSON.stringify({ ...state, current_round: 2 }))
      const catalogPath = join(origin.sessionDir!, 'workflow-catalog.json')
      const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as Record<string, unknown>
      writeFileSync(catalogPath, JSON.stringify({ ...catalog, prepared: true }))
      harness.subagents.startContinuable = startContinuable

      const resumed = await call(harness, 'kersor_resume', {
        experiment_id: origin.experimentId,
        instruction: 'Recover only if the transferred snapshot is unchanged.',
      })

      expect(resumed.isError).toBe(true)
      expect(promptText(resumed.content)).toMatch(/state|catalog.*changed before authority import/i)
      expect(harness.ctx.sessions.get(reserved.data.childSessionId)).toBeUndefined()
      expect(existsSync(importReceiptPath)).toBe(false)
      expect(origin.controller.events.filter(event =>
        event.type === 'kersor/session-authority-transferred')).toHaveLength(1)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('resumes imported authority after legal state and Workflow catalog progression', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-import-progress-'))
    try {
      const harness = await setup(workspace)
      const origin = appendDurableOrigin(harness)
      const attached = await call(harness, 'kersor_attach', attachArguments(origin))
      expect(attached.isError, JSON.stringify(attached.content)).toBe(false)
      const attachedStart = starts(harness.session)[0]!
      const target = harness.ctx.sessions.get(attachedStart.data.childSessionId)!
      expect(target.events.filter(event =>
        event.type === 'kersor/session-authority-imported')).toHaveLength(1)

      const statePath = join(origin.sessionDir!, 'state.json')
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
      writeFileSync(statePath, JSON.stringify({ ...state, current_round: 2, prepared: true }))
      const catalog = JSON.parse(
        readFileSync(join(testKersorRoot, 'workflow-catalog.json'), 'utf8'),
      ) as { workflows: unknown[] }
      writeFileSync(join(origin.sessionDir!, 'workflow-catalog.json'), JSON.stringify({
        schema_version: 1,
        workflows: catalog.workflows.slice(0, 1),
      }))

      const resumed = await call(harness, 'kersor_resume', {
        experiment_id: origin.experimentId,
        instruction: 'Continue after the committed round progression.',
      })

      expect(resumed.isError, JSON.stringify(resumed.content)).toBe(false)
      expect(starts(harness.session)).toHaveLength(1)
      expect(starts(harness.session)[0]!.data.childSessionId).toBe(attachedStart.data.childSessionId)
      expect(origin.controller.events.filter(event =>
        event.type === 'kersor/session-authority-transferred')).toHaveLength(1)
      expect(target.events.filter(event =>
        event.type === 'kersor/session-authority-imported')).toHaveLength(1)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.each([
    ['empty backend', { ...launchContract, backend: '' }],
    ['blank language', { ...launchContract, language: '   ' }],
    ['multiline correctness command', { ...launchContract, correctness_command: 'verify\nagain' }],
    ['multiline benchmark command', { ...launchContract, benchmark_command: 'bench\ragain' }],
    ['string target', { ...launchContract, target_speedup: '8x' }],
    ['zero target', { ...launchContract, target_speedup: 0 }],
    ['zero workflow cap', { ...launchContract, max_workflows: 0 }],
    ['fractional workflow cap', { ...launchContract, max_workflows: 1.5 }],
    ['negative authoring budget', { ...launchContract, workflow_authoring_budget: -1 }],
    ['fractional authoring budget', { ...launchContract, workflow_authoring_budget: 1.5 }],
    ['unknown mode', { ...launchContract, mode: 'fast' }],
    ['unknown field', { ...launchContract, runtime: 'dsh' }],
  ])('rejects typed launch contract with %s before binding', async (_label, launch) => {
    const harness = await setup()
    const result = await call(harness, 'kersor_start', { objective: 'Optimize', launch })
    expect(result.isError).toBe(true)
    expect(starts(harness.session)).toHaveLength(0)
    expect(harness.subagents.starts).toHaveLength(0)
  })

  it('freezes the exact Host KerSor Python path in start, attach, and resume prompts', async () => {
    const started = await setup()
    await call(started, 'kersor_start', { objective: 'Optimize', launch: launchContract })
    const frozenAssignment = `KERSOR_PYTHON='${testKersorPython}'`
    expect(startedPrompt(started)).toContain(`Host-frozen KerSor Python executable is ${JSON.stringify(testKersorPython)}`)
    expect(startedPrompt(started)).toContain(`must begin with exactly ${frozenAssignment}`)
    expect(startedPrompt(started)).toContain('Never use which, command -v, PATH lookup, a filesystem search')

    await call(started, 'kersor_resume', { instruction: 'Continue' })
    expect(resumedPrompt(started)).toContain(`Host-frozen KerSor Python executable is ${JSON.stringify(testKersorPython)}`)
    expect(resumedPrompt(started)).toContain(`must begin with exactly ${frozenAssignment}`)

    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-python-attach-'))
    try {
      const attached = await setup(workspace)
      const origin = appendDurableOrigin(attached)
      const attachedResult = await call(attached, 'kersor_attach', attachArguments(origin))
      expect(attachedResult.isError, JSON.stringify(attachedResult.content)).toBe(false)
      expect(startedPrompt(attached)).toContain(`Host-frozen KerSor Python executable is ${JSON.stringify(testKersorPython)}`)
      expect(startedPrompt(attached)).toContain(`must begin with exactly ${frozenAssignment}`)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.each([
    ['missing', undefined],
    ['relative', 'python3'],
  ] as const)('rejects a %s Host KerSor Python path before start or attach binding', async (_label, configured) => {
    if (configured === undefined) delete process.env.KERSOR_PYTHON
    else process.env.KERSOR_PYTHON = configured
    for (const name of ['kersor_start', 'kersor_attach'] as const) {
      const harness = await setup()
      const args = name === 'kersor_start'
        ? { objective: 'Optimize', launch: launchContract }
        : attachArguments(appendDurableOrigin(harness))
      const result = await call(harness, name, args)
      expect(result.isError).toBe(true)
      expect(result.content.some(block => block.type === 'text'
        && block.text.includes('KERSOR_PYTHON'))).toBe(true)
      expect(starts(harness.session)).toHaveLength(0)
      expect(harness.subagents.starts).toHaveLength(0)
    }
  })

  it('rejects a non-file Host KerSor Python path before start or attach binding', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-kersor-python-directory-'))
    process.env.KERSOR_PYTHON = directory
    try {
      for (const name of ['kersor_start', 'kersor_attach'] as const) {
        const harness = await setup()
        const args = name === 'kersor_start'
          ? { objective: 'Optimize', launch: launchContract }
          : attachArguments(appendDurableOrigin(harness))
        const result = await call(harness, name, args)
        expect(result.isError).toBe(true)
        expect(starts(harness.session)).toHaveLength(0)
        expect(harness.subagents.starts).toHaveLength(0)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a non-executable Host KerSor Python path before start or attach binding',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'dsh-kersor-python-executable-'))
      const executable = join(directory, 'python')
      writeFileSync(executable, '#!/bin/sh\nexit 0\n')
      chmodSync(executable, 0o600)
      process.env.KERSOR_PYTHON = executable
      try {
        for (const name of ['kersor_start', 'kersor_attach'] as const) {
          const harness = await setup()
          const args = name === 'kersor_start'
            ? { objective: 'Optimize', launch: launchContract }
            : attachArguments(appendDurableOrigin(harness))
          const result = await call(harness, name, args)
          expect(result.isError).toBe(true)
          expect(starts(harness.session)).toHaveLength(0)
          expect(harness.subagents.starts).toHaveLength(0)
        }
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )

  it('does not follow up an existing binding when the Host KerSor Python path is invalid', async () => {
    const harness = await setup()
    await call(harness, 'kersor_start', { objective: 'Optimize', launch: launchContract })
    process.env.KERSOR_PYTHON = 'python3'

    const result = await call(harness, 'kersor_resume', { instruction: 'Continue' })
    expect(result.isError).toBe(true)
    expect(starts(harness.session)).toHaveLength(1)
    expect(harness.subagents.starts).toHaveLength(1)
    expect(harness.subagents.followups).toHaveLength(0)
  })

  it('flushes the immutable binding before materializing a dsh child', async () => {
    const harness = await setup()
    const result = await call(harness, 'kersor_start', {
      objective: 'Optimize instruction bundles', fresh_session: true, launch: launchContract,
    })
    expect(result.isError).toBe(false)
    expect(result.concludesTurn).toBe(true)
    expect(result.content.some(block => block.type === 'text'
      && block.text.includes('End this parent turn immediately'))).toBe(true)
    expect(harness.order.slice(0, 3)).toEqual(['flush', 'start-child', 'flush'])
    expect(starts(harness.session)[0]?.data).toMatchObject({
      origin: 'created', objective: 'Optimize instruction bundles', freshSession: true,
      turn: 1, step: 1,
    })
    expect(checkpoints(harness.session)[0]?.data).toMatchObject({ revision: 1, status: 'running' })
    expect(harness.subagents.starts).toHaveLength(1)
    expect(harness.subagents.starts[0]).toMatchObject({ provider: 'spawn' })
  })

  it('resumes the same experiment and continuable child without a second start', async () => {
    const harness = await setup()
    await call(harness, 'kersor_start', { objective: 'Optimize', launch: launchContract })
    const start = starts(harness.session)[0]!.data
    const result = await call(harness, 'kersor_resume', { instruction: 'Continue from disk' })
    expect(result.isError).toBe(false)
    expect(result.concludesTurn).toBe(true)
    expect(starts(harness.session)).toHaveLength(1)
    expect(harness.subagents.starts).toHaveLength(1)
    expect(harness.subagents.followups).toHaveLength(1)
    const followup = harness.subagents.followups[0] as readonly unknown[]
    expect(followup[1]).toBe(start.childSessionId)
  })

  it('requires explicit attach when no experiment is bound', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-explicit-attach-'))
    try {
      const harness = await setup(workspace)
      const missing = await call(harness, 'kersor_resume', {})
      expect(missing.isError).toBe(true)
      expect(starts(harness.session)).toHaveLength(0)

      const legacy = await call(harness, 'kersor_attach', {
        objective: 'Continue existing Session',
      })
      expect(legacy.isError).toBe(true)
      expect(promptText(legacy.content)).toMatch(/experiment_id|durable origin|typed launch/i)
      expect(starts(harness.session)).toHaveLength(0)

      const origin = appendDurableOrigin(harness)
      const attached = await call(harness, 'kersor_attach', attachArguments(origin))
      expect(attached.isError, JSON.stringify(attached.content)).toBe(false)
      expect(attached.concludesTurn).toBe(true)
      expect(starts(harness.session)[0]?.data).toMatchObject({
        experimentId: origin.experimentId,
        origin: 'attached', freshSession: false, launch: launchContract,
      })
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.each(['completed', 'cancelled'] as const)(
    'reports the latest %s binding without requiring an explicit experiment id',
    async (status) => {
      const harness = await setup()
      await call(harness, 'kersor_start', { objective: 'Optimize', launch: launchContract })
      const start = starts(harness.session)[0]!.data
      harness.session.append('kersor/experiment-checkpoint', {
        experimentId: start.experimentId,
        childSessionId: start.childSessionId,
        revision: 2,
        status,
        steps: [],
      })

      const result = await call(harness, 'kersor_resume', {})
      expect(result.isError).toBe(true)
      expect(result.content.some(block => block.type === 'text'
        && block.text.includes(`is terminal (${status})`))).toBe(true)
      expect(starts(harness.session)).toHaveLength(1)
      expect(harness.subagents.starts).toHaveLength(1)
      expect(harness.subagents.followups).toHaveLength(0)
    },
  )

  it('closes a stalled binding, rejects resume, and permits a new Experiment', async () => {
    const harness = await setup()
    await call(harness, 'kersor_start', { objective: 'First attempt', launch: launchContract })
    const first = starts(harness.session)[0]!.data
    harness.session.append('kersor/experiment-checkpoint', {
      experimentId: first.experimentId,
      childSessionId: first.childSessionId,
      revision: 2,
      status: 'waiting',
      phase: 'stalled',
      nextAction: 'Continue in the bound dsh execution conversation.',
      steps: [],
    })
    // Preserve the real historical failure shape: a parent illegally reopened
    // the same binding after the stalled checkpoint. The control fold must keep
    // the first closed boundary authoritative.
    harness.session.append('kersor/experiment-checkpoint', {
      experimentId: first.experimentId,
      childSessionId: first.childSessionId,
      revision: 3,
      status: 'running',
      steps: [],
    })

    const resume = await call(harness, 'kersor_resume', {})
    expect(resume.isError).toBe(true)
    expect(resume.content.some(block => block.type === 'text'
      && block.text.includes('is blocked (stalled)'))).toBe(true)
    expect(harness.subagents.followups).toHaveLength(0)

    const next = await call(harness, 'kersor_start', {
      objective: 'Second attempt', launch: launchContract,
    })
    expect(next.isError).toBe(false)
    expect(starts(harness.session)).toHaveLength(2)
    expect(harness.subagents.starts).toHaveLength(2)
  })

  it('reserves all direct subagents to declared controller children in the parent', async () => {
    const harness = await setup()
    const calls: string[] = []
    registerProbe(harness, 'subagent', calls)
    registerProbe(harness, 'subagent_fork', calls)
    registerProbe(harness, 'workflow', calls)
    await call(harness, 'kersor_start', { objective: 'Optimize', launch: launchContract })
    const declaredChild = starts(harness.session)[0]!.data.childSessionId

    const monitor = await call(harness, 'subagent', {})
    const author = await call(harness, 'subagent_fork', {})
    const workflow = await call(harness, 'workflow', {})
    expect(monitor.isError).toBe(true)
    expect(author.isError).toBe(true)
    expect(workflow.isError).toBe(true)
    expect(monitor.content.some(block => block.type === 'text'
      && block.text.includes('reserved to its declared controller child'))).toBe(true)
    expect(calls).toEqual([])
    expect(harness.subagents.starts).toHaveLength(1)
    expect(harness.subagents.children[0]).toMatchObject({ id: declaredChild, mode: 'continuable' })
  })

  it.each([
    {
      name: 'an unpaired workspace-write request',
      authored: { sandbox_permissions: 'workspace-write' },
    },
    {
      name: 'a forged danger-full-access request',
      authored: {
        sandbox_permissions: 'danger-full-access',
        justification: 'Run the Host-owned setup outside the workspace sandbox.',
      },
    },
  ])('normalizes $name before the first canonical setup executes', async ({ authored }) => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-setup-sandbox-'))
    let shell: SetupSandboxExecutor | undefined
    try {
      const harness = await setup(workspace, async (ctx) => {
        await ctx.plugin(SandboxPolicyService, {
          mode: 'workspace-write',
          workspaceRoot: workspace,
        })
        await ctx.plugin(SetupSandboxExecutor)
        shell = ctx.shell as SetupSandboxExecutor
        await ctx.plugin(BashEnv)
        await ctx.plugin(ToolBash)
      })
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', '20260823-setup-sandbox')
      const command = setupSessionCommand(workspace, controller.id)
      shell!.onRun = (spec) => {
        expect(spec.command).toBe(command)
        writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      }

      const result = await call(harness, 'bash', {
        command,
        description: 'Initialize Host-owned KerSor Session',
        ...authored,
      }, controller)

      expect(result.isError, JSON.stringify(result.content)).toBe(false)
      expect(shell!.calls).toHaveLength(1)
      expect(shell!.calls[0]!.sandboxPolicy?.mode).toBe('workspace-write')
      expect(controller.session.events.filter(event =>
        event.type === 'kersor/session-initialized')).toHaveLength(1)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.each(['tools/pre-execute', 'tools/execute'] as const)(
    'does not reuse setup sandbox authority after a %s failure',
    async (failureStage) => {
      const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-setup-cleanup-'))
      let shell: SetupSandboxExecutor | undefined
      try {
        const harness = await setup(workspace, async (ctx) => {
          await ctx.plugin(SandboxPolicyService, {
            mode: 'workspace-write',
            workspaceRoot: workspace,
          })
          await ctx.plugin(SetupSandboxExecutor)
          shell = ctx.shell as SetupSandboxExecutor
          await ctx.plugin(BashEnv)
          await ctx.plugin(ToolBash)
        })
        const controller = await startController(harness)
        const setupCommand = setupSessionCommand(workspace, controller.id)
        let failNext = true
        if (failureStage === 'tools/pre-execute') {
          harness.ctx.on('tools/pre-execute', async (_exec, next) => {
            if (failNext) {
              failNext = false
              throw new Error('downstream setup pre-execute failed')
            }
            return next()
          })
        } else {
          harness.ctx.on('tools/execute', async (_exec, next) => {
            if (failNext) {
              failNext = false
              throw new Error('setup execute wrapper failed')
            }
            return next()
          })
        }
        const reusedCallId = CallId(`reused-setup-${failureStage}`)
        const execute = async (args: Record<string, unknown>) => {
          controller.session.append('tool/call', {
            turn: 1,
            step: 1,
            callId: reusedCallId,
            name: 'bash',
            arguments: JSON.stringify(args),
          })
          return harness.ctx.tools.execute({
            callId: reusedCallId,
            name: 'bash',
            arguments: args,
            agent: controller,
            signal,
          })
        }

        const setupResult = await execute({
          command: setupCommand,
          description: 'Initialize Host-owned KerSor Session',
          sandbox_permissions: 'workspace-write',
        })
        expect(setupResult.isError).toBe(true)

        const unrelated = await execute({
          command: 'printf unrelated',
          description: 'Run unrelated Bash command',
          sandbox_permissions: 'danger-full-access',
          justification: 'Attempt to reuse stale setup authority.',
        })
        expect(unrelated.isError).toBe(true)
        expect(shell!.calls).toHaveLength(0)
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    },
  )

  it.each(['/tmp', '../outside'])(
    'rejects canonical setup with a non-workspace workdir %s',
    async (workdir) => {
      const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-setup-workdir-'))
      let shell: SetupSandboxExecutor | undefined
      try {
        const harness = await setup(workspace, async (ctx) => {
          await ctx.plugin(SandboxPolicyService, {
            mode: 'workspace-write',
            workspaceRoot: workspace,
          })
          await ctx.plugin(SetupSandboxExecutor)
          shell = ctx.shell as SetupSandboxExecutor
          await ctx.plugin(BashEnv)
          await ctx.plugin(ToolBash)
        })
        const controller = await startController(harness)
        const result = await call(harness, 'bash', {
          command: setupSessionCommand(workspace, controller.id),
          description: 'Initialize Host-owned KerSor Session',
          sandbox_permissions: 'workspace-write',
          workdir,
        }, controller)

        expect(result.isError).toBe(true)
        expect(shell!.calls).toHaveLength(0)
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    },
  )

  it('rejects canonical setup when a symlink followed by .. escapes the workspace', async () => {
    const root = realpathSync.native(
      mkdtempSync(join(tmpdir(), 'dsh-kersor-setup-workdir-symlink-')),
    )
    const workspace = join(root, 'workspace')
    const outsideChild = join(root, 'outside', 'child')
    let shell: SetupSandboxExecutor | undefined
    try {
      mkdirSync(workspace)
      mkdirSync(outsideChild, { recursive: true })
      symlinkSync(outsideChild, join(workspace, 'link'), 'dir')
      const harness = await setup(workspace, async (ctx) => {
        await ctx.plugin(SandboxPolicyService, {
          mode: 'workspace-write',
          workspaceRoot: workspace,
        })
        await ctx.plugin(SetupSandboxExecutor)
        shell = ctx.shell as SetupSandboxExecutor
        await ctx.plugin(BashEnv)
        await ctx.plugin(ToolBash)
      })
      const controller = await startController(harness)
      const result = await call(harness, 'bash', {
        command: setupSessionCommand(workspace, controller.id),
        description: 'Initialize Host-owned KerSor Session',
        sandbox_permissions: 'workspace-write',
        workdir: `${workspace}/link/..`,
      }, controller)

      expect(result.isError).toBe(true)
      expect(shell!.calls).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each(['.', 'exact canonical workspace'] as const)(
    'accepts setup workdir %s',
    async (workdirForm) => {
      const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-setup-workdir-ok-'))
      let shell: SetupSandboxExecutor | undefined
      try {
        const harness = await setup(workspace, async (ctx) => {
          await ctx.plugin(SandboxPolicyService, {
            mode: 'workspace-write',
            workspaceRoot: workspace,
          })
          await ctx.plugin(SetupSandboxExecutor)
          shell = ctx.shell as SetupSandboxExecutor
          await ctx.plugin(BashEnv)
          await ctx.plugin(ToolBash)
        })
        const controller = await startController(harness)
        const sessionDir = join(workspace, '.kersor', '20260823-setup-workdir-ok')
        shell!.onRun = () => {
          writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
        }
        const result = await call(harness, 'bash', {
          command: setupSessionCommand(workspace, controller.id),
          description: 'Initialize Host-owned KerSor Session',
          sandbox_permissions: 'workspace-write',
          workdir: workdirForm === '.' ? '.' : realpathSync.native(workspace),
        }, controller)

        expect(result.isError, JSON.stringify(result.content)).toBe(false)
        expect(shell!.calls).toHaveLength(1)
        expect(shell!.calls[0]!.workdir).toBe(realpathSync.native(workspace))
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    },
  )

  it('drops setup suppression authority across disposal and cold reload', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-setup-reload-'))
    let shell: SetupSandboxExecutor | undefined
    try {
      const harness = await setup(workspace, async (ctx) => {
        await ctx.plugin(SandboxPolicyService, {
          mode: 'workspace-write',
          workspaceRoot: workspace,
        })
        await ctx.plugin(SetupSandboxExecutor)
        shell = ctx.shell as SetupSandboxExecutor
        await ctx.plugin(BashEnv)
        await ctx.plugin(ToolBash)
      })
      const controller = await startController(harness)
      const setupCommand = setupSessionCommand(workspace, controller.id)
      let failNext = true
      harness.ctx.on('tools/execute', async (_exec, next) => {
        if (failNext) {
          failNext = false
          throw new Error('setup wrapper failed before cold reload')
        }
        return next()
      })
      const firstCallId = CallId('setup-before-cold-reload')
      const execute = async (callId: CallId, args: Record<string, unknown>) => {
        controller.session.append('tool/call', {
          turn: 1,
          step: 1,
          callId,
          name: 'bash',
          arguments: JSON.stringify(args),
        })
        return harness.ctx.tools.execute({
          callId,
          name: 'bash',
          arguments: args,
          agent: controller,
          signal,
        })
      }
      const failed = await execute(firstCallId, {
        command: setupCommand,
        description: 'Initialize Host-owned KerSor Session',
        sandbox_permissions: 'workspace-write',
      })
      expect(failed.isError).toBe(true)
      await harness.controlFiber.dispose()
      const reloaded = await harness.ctx.plugin(control)
      try {
        const unrelated = await execute(firstCallId, {
          command: 'printf unrelated-after-reload',
          description: 'Run unrelated Bash after reload',
          sandbox_permissions: 'danger-full-access',
          justification: 'Attempt to reuse disposed setup authority.',
        })
        expect(unrelated.isError).toBe(true)
        expect(shell!.calls).toHaveLength(0)

        const retry = await execute(CallId('setup-after-cold-reload'), {
          command: setupCommand,
          description: 'Retry exact setup after cold reload',
          sandbox_permissions: 'workspace-write',
        })
        expect(retry.isError).toBe(true)
        expect(promptText(retry.content)).toContain('exact-once')
        expect(shell!.calls).toHaveLength(0)
      } finally {
        await reloaded.dispose()
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('discovers only the canonical Session when fresh setup also creates infrastructure', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-session-setup-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', '20260823-011205')
      const calls: string[] = []
      const command = setupSessionCommand(workspace, controller.id)
      registerBashProbe(harness, calls, (executed) => {
        expect(executed).toBe(command)
        writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
        mkdirSync(join(sessionDir, 'run-1'))
        const root = join(workspace, '.kersor')
        mkdirSync(join(root, 'session-bindings'))
        mkdirSync(join(root, 'cell-bindings'))
        mkdirSync(join(root, 'partial-session'))
        writeFileSync(join(root, 'partial-session', 'session-config.json'), '{}')
        const symlinkTarget = join(workspace, 'symlink-target')
        writeValidSetupArtifacts(workspace, symlinkTarget, launchContract, controller.id)
        symlinkSync(symlinkTarget, join(root, 'linked-session'), 'dir')
        return `SESSION_DIR=${sessionDir}\n`
      })

      const result = await call(harness, 'bash', { command }, controller)

      expect(result.isError, JSON.stringify(result.content)).toBe(false)
      expect(calls).toEqual([command])
      const events = controller.session.events.filter(event =>
        event.type === 'kersor/session-initialized')
      expect(events).toHaveLength(1)
      const receiptPath = join(sessionDir, 'session-initialization-receipt.json')
      expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toEqual(events[0]!.data)
      const canonicalSession = realpathSync.native(sessionDir)
      const canonicalWorkspace = realpathSync.native(workspace)
      expect(events[0]!.data).toMatchObject({
        contract: 'dsh_session_initialization_v1',
        authority: 'dsh_host',
        workspace: canonicalWorkspace,
        session_dir: canonicalSession,
        controller_session_id: controller.id,
        launch: launchContract,
        setup_command: command,
        kersor_python: {
          path: testKersorPython,
          sha256: fileSha256(testKersorPython),
        },
        session_config: {
          path: join(canonicalSession, 'session-config.json'),
          sha256: fileSha256(join(sessionDir, 'session-config.json')),
        },
        state: {
          path: join(canonicalSession, 'state.json'),
          sha256: fileSha256(join(sessionDir, 'state.json')),
        },
        workflow_catalog: {
          path: join(canonicalSession, 'workflow-catalog.json'),
          sha256: fileSha256(join(sessionDir, 'workflow-catalog.json')),
        },
        adapter: { path: testSetupAdapter, sha256: fileSha256(testSetupAdapter) },
        kernel: {
          path: join(canonicalWorkspace, 'kernel.py'),
          sha256: fileSha256(join(workspace, 'kernel.py')),
        },
      })
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('ignores pre-existing canonical Sessions when setup creates one more', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-session-history-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const root = join(workspace, '.kersor')
      writeValidSetupArtifacts(workspace, join(root, 'old-session-a'), launchContract, controller.id)
      writeValidSetupArtifacts(workspace, join(root, 'old-session-b'), launchContract, controller.id)
      const sessionDir = join(root, '20260823-011205')
      const command = setupSessionCommand(workspace, controller.id)
      registerBashProbe(harness, [], () => {
        writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
        return `SESSION_DIR=${sessionDir}\n`
      })

      const result = await call(harness, 'bash', { command }, controller)

      expect(result.isError, JSON.stringify(result.content)).toBe(false)
      expect(controller.session.events.filter(event =>
        event.type === 'kersor/session-initialized')).toHaveLength(1)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('fails closed when setup concurrently creates two canonical Sessions', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-session-race-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const root = join(workspace, '.kersor')
      const first = join(root, '20260823-011205')
      const second = join(root, '20260823-011206')
      const command = setupSessionCommand(workspace, controller.id)
      registerBashProbe(harness, [], () => {
        writeValidSetupArtifacts(workspace, first, launchContract, controller.id)
        writeValidSetupArtifacts(workspace, second, launchContract, controller.id)
        return `SESSION_DIR=${first}\nSESSION_DIR=${second}\n`
      })

      const result = await call(harness, 'bash', { command }, controller)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toContain('exactly one new workspace/.kersor/Session')
      expect(controller.session.events.filter(event =>
        event.type === 'kersor/session-initialized')).toHaveLength(0)
      expect(existsSync(first)).toBe(true)
      expect(existsSync(second)).toBe(true)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('denies baseline initialization before Session setup Host authority', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-baseline-before-setup-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'setup-session')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      const calls: string[] = []
      registerBashProbe(harness, calls)

      const result = await call(harness, 'bash', {
        command: baselineInitCommand(sessionDir),
      }, controller)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(
        /session-initialized|Session setup|Host initialization|authority/i,
      )
      expect(calls).toEqual([])
      expect(existsSync(join(sessionDir, 'baseline-initialization-receipt.json'))).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('returns the current Session next exact baseline command after equivalent shell quoting is denied', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-baseline-command-hint-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      writeFileSync(join(workspace, 'kernel.py'), 'VALUE = 1\n')
      const sessionDir = join(workspace, '.kersor', "quoted'baseline")
      mkdirSync(sessionDir, { recursive: true })
      appendValidBaselineCustody(
        realpathSync.native(sessionDir), realpathSync.native(workspace), controller, 1,
      )
      const exact = baselineRecordCommand(sessionDir, workspace)
      const equivalent = exact.replaceAll("'\\''", "'\"'\"'")
      expect(exact).toContain("'\\''")
      expect(equivalent).toContain("'\"'\"'")
      expect(equivalent).not.toBe(exact)
      const calls: string[] = []
      registerBashProbe(harness, calls)

      const result = await call(harness, 'bash', { command: equivalent }, controller)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toContain(
        `Current Session next baseline phase is record. Required exact command: ${exact}`,
      )
      expect(calls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.each([
    {
      name: 'nonzero exit', exitCode: 23, signal: null,
      timedOut: false, aborted: false, expectedStatus: 'exit code 23',
    },
    {
      name: 'signal termination', exitCode: null, signal: 'SIGTERM',
      timedOut: false, aborted: false, expectedStatus: 'signal SIGTERM',
    },
    {
      name: 'timeout', exitCode: null, signal: null,
      timedOut: true, aborted: false, expectedStatus: 'timed out',
    },
    {
      name: 'missing exit status', exitCode: null, signal: null,
      timedOut: false, aborted: false, expectedStatus: 'exit code unavailable',
    },
  ] as const)('preserves a foreground baseline Bash $name instead of finishing missing custody artifacts', async ({
    name, exitCode, signal: exitSignal, timedOut, aborted, expectedStatus,
  }) => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-baseline-bash-failure-'))
    let shell: SetupSandboxExecutor | undefined
    try {
      const harness = await setup(workspace, async (ctx) => {
        await ctx.plugin(SandboxPolicyService, {
          mode: 'workspace-write',
          workspaceRoot: workspace,
        })
        await ctx.plugin(SetupSandboxExecutor)
        shell = ctx.shell as SetupSandboxExecutor
        await ctx.plugin(BashEnv)
        await ctx.plugin(ToolBash)
      })
      const controller = await startController(harness)
      writeFileSync(join(workspace, 'kernel.py'), 'VALUE = 1\n')
      const sessionDir = join(workspace, '.kersor', 'baseline-bash-failure')
      mkdirSync(sessionDir, { recursive: true })
      writeValidBaselineAuthority(sessionDir, workspace)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      rmSync(join(sessionDir, 'test-method.md'))
      rmSync(join(sessionDir, 'baseline-witness.json'))
      shell!.resultFor = spec => ({
        exitCode,
        signal: exitSignal,
        timedOut,
        aborted,
        timeoutMs: spec.timeoutMs,
        stdout: { text: '', truncated: false },
        stderr: { text: `baseline helper ${name}\n`, truncated: false },
        sandbox: {
          mode: spec.sandboxPolicy?.mode ?? 'workspace-write',
          denied: false,
          enforcement: 'full',
          runnerFailed: false,
        },
      })
      const command = baselineInitCommand(sessionDir)

      const result = await call(harness, 'bash', {
        command,
        description: 'Initialize the baseline witness',
        run_in_background: false,
      }, controller)

      expect(result.isError).toBe(true)
      const feedback = promptText(result.content)
      expect(feedback).toContain(`baseline helper ${name}`)
      expect(feedback).toContain(expectedStatus)
      expect(feedback).toContain('exact-once baseline phase is consumed')
      expect(feedback).not.toMatch(/test method|baseline witness.*(?:missing|ENOENT)/i)
      expect(shell!.calls).toHaveLength(1)
      expect(existsSync(join(sessionDir, 'baseline-initialization-receipt.json'))).toBe(false)
      expect(controller.session.events.some(event =>
        event.type === 'kersor/baseline-initialized')).toBe(false)

      const retry = await call(harness, 'bash', {
        command,
        description: 'Retry the baseline witness initialization',
        run_in_background: false,
      }, controller)
      expect(retry.isError).toBe(true)
      expect(promptText(retry.content)).toContain('exact-once')
      expect(shell!.calls).toHaveLength(1)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('denies the exact canonical setup command from a controller descendant pre-execution', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-descendant-setup-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const descendant = descendantAgent(harness, controller.session, 'setup-descendant')
      const calls: string[] = []
      registerBashProbe(harness, calls)

      const result = await call(harness, 'bash', {
        command: setupSessionCommand(workspace, controller.id),
      }, descendant)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/direct.*controller|descendant|setup/i)
      expect(calls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('hard-gates KerSor Python use in the direct controller while allowing unrelated Bash', async () => {
    const harness = await setup()
    const calls: string[] = []
    registerBashProbe(harness, calls)
    await call(harness, 'kersor_start', { objective: 'Optimize', launch: launchContract })
    const controllerId = starts(harness.session)[0]!.data.childSessionId
    const controller = descendantAgent(harness, harness.session, controllerId)
    const prefix = `KERSOR_PYTHON='${testKersorPython}'; export KERSOR_PYTHON;`

    const missingPrefix = await call(harness, 'bash', {
      command: 'python3 /opt/KerSor/scripts/normalize-transfer.py',
    }, controller)
    expect(missingPrefix.isError).toBe(true)
    expect(missingPrefix.content.some(block => block.type === 'text'
      && block.text.includes(`exact Host-frozen prefix ${prefix}`))).toBe(true)

    const substituted = await call(harness, 'bash', {
      command: `${prefix} python3 /opt/KerSor/scripts/normalize-transfer.py`,
    }, controller)
    expect(substituted.isError).toBe(true)
    expect(substituted.content.some(block => block.type === 'text'
      && block.text.includes('may not substitute python/python3'))).toBe(true)

    const discovery = await call(harness, 'bash', { command: 'which python3' }, controller)
    expect(discovery.isError).toBe(true)
    expect(discovery.content.some(block => block.type === 'text'
      && block.text.includes(`exact prefix ${prefix}`))).toBe(true)

    const exact = `${prefix} "$KERSOR_PYTHON" /opt/KerSor/scripts/normalize-transfer.py`
    expect((await call(harness, 'bash', { command: exact }, controller)).isError).toBe(false)
    const nonCanonicalSetup = `${prefix} bash /opt/KerSor/scripts/setup-session.sh /work/kernel --backend python --language python_reference --correctness-command '${testKersorPython} tests/check.py' --benchmark-command '${testKersorPython} tests/bench.py'`
    expect((await call(harness, 'bash', {
      command: nonCanonicalSetup,
    }, controller)).isError).toBe(true)
    expect((await call(harness, 'bash', {
      command: `${prefix} echo ready && python3 /opt/KerSor/scripts/normalize-transfer.py`,
    }, controller)).isError).toBe(true)
    expect((await call(harness, 'bash', {
      command: `${prefix} BACKEND=python python3 /opt/KerSor/scripts/normalize-transfer.py`,
    }, controller)).isError).toBe(true)
    expect((await call(harness, 'bash', { command: 'python3 analyze-results.py' }, controller)).isError).toBe(false)
    expect((await call(harness, 'bash', {
      command: 'ls /work/kernel/KerSor/agents /work/kernel/KerSor/docs',
    }, controller)).isError).toBe(false)
    expect(calls).toEqual([
      exact,
      'python3 analyze-results.py',
      'ls /work/kernel/KerSor/agents /work/kernel/KerSor/docs',
    ])
  })

  it('reserves round synthesis artifacts and cursor advancement to their deterministic owners', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-synthesis-ownership-'))
    try {
      const harness = await setup(workspace)
      const fileCalls: string[] = []
      registerFileProbe(harness, 'write', fileCalls)
      registerFileProbe(harness, 'edit', fileCalls)
      const bashCalls: string[] = []
      registerBashProbe(harness, bashCalls)
      const controller = await startController(harness)
      const synthesizer = descendantAgent(harness, controller.session, 'session-synthesizer')
      const controllerWorkspace = controller.session.header.cwd!
      const summary = join(
        controllerWorkspace, '.kersor', '20260822-synthesis', 'round-2-summary.md',
      )
      const transfer = join(
        controllerWorkspace, '.kersor', '20260822-synthesis', 'round-2-transfer.json',
      )
      const prefix = `KERSOR_PYTHON='${testKersorPython}'; export KERSOR_PYTHON;`

      for (const [operation, result] of [
        ['write summary', await call(harness, 'write', { file_path: summary }, controller)],
        ['edit transfer', await call(harness, 'edit', { file_path: transfer }, controller)],
        ['redirect transfer', await call(harness, 'bash', {
          command: `printf result > '${transfer}'`,
        }, controller)],
      ] as const) {
        expect(result.isError, `${operation}: ${JSON.stringify(result.content)}`).toBe(true)
        expect(result.content.some(block => block.type === 'text'
          && block.text.includes('session-synthesizer is their sole writer')),
        `${operation}: ${JSON.stringify(result.content)}`).toBe(true)
      }

      const setRound = await call(harness, 'bash', {
        command: `${prefix} bash /opt/KerSor/scripts/kersor-state.sh "$SESSION_DIR" set current_round 3`,
      }, controller)
      const advance = await call(harness, 'bash', {
        command: `${prefix} bash /opt/KerSor/scripts/kersor-state.sh "$SESSION_DIR" advance 3`,
      }, controller)
      expect(setRound.isError).toBe(true)
      expect(advance.isError).toBe(true)
      expect(promptText(setRound.content)).toContain(
        'Only Host-validated protocol adapters may change state.json',
      )
      expect(promptText(advance.content)).toContain(
        'Only Host-validated protocol adapters may change state.json',
      )

      const normalize = `${prefix} "$KERSOR_PYTHON" /opt/KerSor/scripts/normalize-transfer.py '${transfer}'`
      expect((await call(harness, 'bash', { command: normalize }, controller)).isError).toBe(false)
      expect((await call(harness, 'write', { file_path: summary }, synthesizer)).isError).toBe(false)
      expect((await call(harness, 'write', { file_path: transfer }, synthesizer)).isError).toBe(false)
      expect(fileCalls).toEqual([summary, transfer])
      expect(bashCalls).toEqual([normalize])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('propagates the Bash gate through a live one-shot grandchild ancestry', async () => {
    const harness = await setup()
    const calls: string[] = []
    registerBashProbe(harness, calls)
    await call(harness, 'kersor_start', { objective: 'Optimize', launch: launchContract })
    const controllerId = starts(harness.session)[0]!.data.childSessionId
    const controller = descendantAgent(harness, harness.session, controllerId)
    const grandchild = descendantAgent(harness, controller.session, 'session-synthesizer')
    const prefix = `KERSOR_PYTHON='${testKersorPython}'; export KERSOR_PYTHON;`

    for (const command of [
      '"$KERSOR_PYTHON" "$kersor_root/scripts/session-synthesizer.py"',
      'bash /opt/helpers/run-kersor-python.sh',
      'bash /opt/helpers/setup-session.sh',
      '"$KERSOR_PYTHON" /opt/helpers/kersor_bridge.py',
      'command -v python3',
      'type -a python3',
      'python3 --version',
      "find /usr -name 'python*'",
    ]) {
      const result = await call(harness, 'bash', { command }, grandchild)
      expect(result.isError, command).toBe(true)
    }

    const forbiddenSetup = `${prefix} bash /opt/helpers/setup-session.sh`
    expect((await call(harness, 'bash', {
      command: forbiddenSetup,
    }, grandchild)).isError).toBe(true)
    expect(calls).toEqual([])
  })

  it('does not apply the KerSor Bash gate outside an Experiment ancestry', async () => {
    const harness = await setup()
    const calls: string[] = []
    registerBashProbe(harness, calls)
    const ordinaryChild = descendantAgent(harness, harness.session, 'ordinary-child')
    for (const command of [
      'which python3',
      'python3 /opt/KerSor/scripts/normalize-transfer.py',
    ]) {
      expect((await call(harness, 'bash', { command }, ordinaryChild)).isError).toBe(false)
    }
    expect(calls).toEqual([
      'which python3',
      'python3 /opt/KerSor/scripts/normalize-transfer.py',
    ])
  })

  it('executes only a Host-bound dsh-workflow envelope and denies persisted meta/script/args drift', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-envelope-exact-'))
    try {
      const calls: string[] = []
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, {
        runId: 'workflow-envelope', agentsStarted: 1, result: { best_kernel_code: 'exact' },
      }, calls)
      const controller = await startController(harness)

      const exactRun = makeRunDirectory(workspace)
      writeWorkflowEnvelope(exactRun, controller)
      const exact = await call(harness, 'kersor_workflow', { exp_dir: exactRun }, controller)
      expect(exact.isError, JSON.stringify(exact.content)).toBe(false)
      expect(calls).toEqual(['workflow'])

      const scriptRun = makeRunDirectory(workspace, 'run-2')
      writeWorkflowEnvelope(scriptRun, controller)
      const scriptPath = join(scriptRun, 'dsh-workflow.json')
      const scriptEnvelope = readJsonFixture(scriptPath) as MutableWorkflowEnvelope
      scriptEnvelope.script = `${workflowScript}\nreturn { reconstructed: true }`
      writeFileSync(scriptPath, JSON.stringify(scriptEnvelope))
      const script = await call(harness, 'kersor_workflow', { exp_dir: scriptRun }, controller)
      expect(script.isError).toBe(true)
      expect(script.content.some(block => block.type === 'text'
        && block.text.includes('does not derive from the selected canonical Workflow source'))).toBe(true)

      const metaRun = makeRunDirectory(workspace, 'run-3')
      writeWorkflowEnvelope(metaRun, controller)
      const metaPath = join(metaRun, 'dsh-workflow.json')
      const metaEnvelope = readJsonFixture(metaPath) as MutableWorkflowEnvelope
      metaEnvelope.meta.name = 'controller-reconstructed-workflow'
      writeFileSync(metaPath, JSON.stringify(metaEnvelope))
      const meta = await call(harness, 'kersor_workflow', { exp_dir: metaRun }, controller)
      expect(meta.isError).toBe(true)
      expect(meta.content.some(block => block.type === 'text'
        && block.text.includes('source/meta does not identify'))).toBe(true)

      const argsRun = makeRunDirectory(workspace, 'run-4')
      writeWorkflowEnvelope(argsRun, controller)
      const argsPath = join(argsRun, 'dsh-workflow.json')
      const argsEnvelope = readJsonFixture(argsPath) as MutableWorkflowEnvelope
      argsEnvelope.args.target_speedup = 9
      writeFileSync(argsPath, JSON.stringify(argsEnvelope))
      const args = await call(harness, 'kersor_workflow', { exp_dir: argsRun }, controller)
      expect(args.isError).toBe(true)
      expect(args.content.some(block => block.type === 'text'
        && block.text.includes('dispatch-args.json differs'))).toBe(true)
      expect(calls).toEqual(['workflow'])
      for (const runDir of [scriptRun, metaRun, argsRun]) {
        expect(existsSync(join(runDir, 'output.json'))).toBe(false)
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects a sealed Workflow envelope when its selected Workflow reverted to pending', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-envelope-pending-selection-'))
    try {
      const calls: string[] = []
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, {
        runId: 'workflow-pending-selection', agentsStarted: 1, result: { bypass: true },
      }, calls)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      writeWorkflowEnvelope(runDir, controller)
      const selectionPath = join(dirname(runDir), 'round-1-selection.json')
      const selection = readJsonFixture(selectionPath) as {
        routing: { decided_by: string }
        attempt_plan: {
          status: string
          commit: { status: string; workflow: string }
        }
      }
      selection.routing.decided_by = 'agent-advise-pending'
      selection.attempt_plan.status = 'proposed'
      selection.attempt_plan.commit.status = 'proposed'
      writeFileSync(selectionPath, JSON.stringify(selection))

      const result = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/committed selection|selection.*commit/i)
      expect(calls).toEqual([])
      expect(existsSync(join(runDir, 'output.json'))).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('loads and executes a sealed Workflow envelope Host-side from exp_dir only', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-sealed-workflow-'))
    try {
      const calls: string[] = []
      const harness = await setup(workspace)
      const raw = { best_kernel_code: 'host-loaded-candidate', speedup: 8.5 }
      registerWorkflowProbe(harness, {
        runId: 'workflow-host-loaded', agentsStarted: 2, result: raw,
      }, calls)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      writeWorkflowEnvelope(runDir, controller)

      const result = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)

      expect(result.isError, JSON.stringify(result.content)).toBe(false)
      expect(result.value).toEqual({
        runId: 'workflow-host-loaded', agentsStarted: 2, result: raw,
      })
      expect(result.content.some(block => block.type === 'text'
        && block.text.includes('Host raw output custody completed'))).toBe(true)
      expect(calls).toEqual(['workflow'])
      const ownershipReport = JSON.parse(readFileSync(
        join(runDir, 'candidate-ownership.json'), 'utf8',
      )) as Record<string, unknown>
      expect(ownershipReport).toMatchObject({
        schema_version: 1,
        gate: 'candidate_output_ownership_v1',
        verdict: 'pass',
        seal: join(realpathSync(runDir), 'candidate-ownership-seal.json'),
        seal_sha256: fileSha256(join(runDir, 'candidate-ownership-seal.json')),
        violations: [],
      })
      expect(JSON.parse(readFileSync(join(runDir, 'output.json'), 'utf8'))).toEqual(raw)

      const ordinary = descendantAgent(harness, harness.session, 'ordinary-child')
      const denied = await call(harness, 'kersor_workflow', { exp_dir: runDir }, ordinary)
      expect(denied.isError).toBe(true)
      expect(denied.content.some(block => block.type === 'text'
        && block.text.includes('conversation-bound KerSor controller'))).toBe(true)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('fails the tool and stalls the Experiment when post-Workflow ownership changed', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-post-ownership-fail-'))
    try {
      const protectedPath = join(workspace, 'kernel.py')
      writeFileSync(protectedPath, 'VALUE = 1\n')
      const calls: string[] = []
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, {
        runId: 'workflow-post-ownership-fail',
        agentsStarted: 1,
        result: { best_kernel_code: 'untrusted-result' },
      }, calls, () => {
        writeFileSync(protectedPath, 'VALUE = 2\n')
      })
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      writeWorkflowEnvelope(runDir, controller)

      const result = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/post.*ownership|ownership.*failed/i)
      expect(calls).toEqual(['workflow'])
      expect(existsSync(join(runDir, 'output.json'))).toBe(false)
      const report = JSON.parse(readFileSync(
        join(runDir, 'candidate-ownership.json'), 'utf8',
      )) as Record<string, unknown>
      expect(report).toMatchObject({
        schema_version: 1,
        gate: 'candidate_output_ownership_v1',
        verdict: 'fail',
      })
      expect(JSON.stringify(report)).toContain('kernel.py')
      expect(checkpoints(harness.session).at(-1)?.data).toMatchObject({
        status: 'blocked',
        phase: 'stalled',
      })
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('never overwrites a pre-existing candidate-ownership.json during post verification', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-post-ownership-exclusive-'))
    try {
      const calls: string[] = []
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, {
        runId: 'workflow-post-ownership-exclusive',
        agentsStarted: 1,
        result: { best_kernel_code: 'unpublishable-result' },
      }, calls)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      writeWorkflowEnvelope(runDir, controller)
      const reportPath = join(runDir, 'candidate-ownership.json')
      const forged = '{"forged":"must-not-overwrite"}\n'
      writeFileSync(reportPath, forged)

      const result = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/candidate-ownership\.json.*exists|exclusive/i)
      expect(calls).toEqual(['workflow'])
      expect(readFileSync(reportPath, 'utf8')).toBe(forged)
      expect(existsSync(join(runDir, 'output.json'))).toBe(false)
      expect(checkpoints(harness.session).at(-1)?.data).toMatchObject({
        status: 'blocked', phase: 'stalled',
      })
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects a shape-valid manual producer receipt without its durable Host event', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-producer-event-'))
    try {
      const calls: string[] = []
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, {
        runId: 'workflow-forged-producer', agentsStarted: 1, result: { bypass: true },
      }, calls)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      writeWorkflowEnvelope(runDir, controller, workflowArguments(runDir), {
        appendProducerEvent: false,
        appendTransformation: false,
        writeCandidateSeal: false,
      })

      const result = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)

      expect(result.isError).toBe(true)
      expect(result.content.some(block => block.type === 'text'
        && block.text.includes('matching durable Host event'))).toBe(true)
      expect(calls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('denies direct controller writes to routing, dispatch semantic artifacts, and Host receipts', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-dispatch-write-'))
    try {
      const harness = await setup(workspace)
      const fileCalls: string[] = []
      registerFileProbe(harness, 'write', fileCalls)
      registerFileProbe(harness, 'edit', fileCalls)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      const routingDecision = join(dirname(runDir), 'round-1-routing-decision.json')
      expect((await call(
        harness, 'write', { file_path: routingDecision }, controller,
      )).isError).toBe(true)
      expect((await call(
        harness, 'edit', { file_path: routingDecision }, controller,
      )).isError).toBe(true)
      for (const name of [
        'dispatch-args.json',
        'dispatch-args-provenance.json',
        'dispatch-args-producer-receipt.json',
      ]) {
        expect((await call(
          harness, 'write', { file_path: join(runDir, name) }, controller,
        )).isError).toBe(true)
      }
      expect(fileCalls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('accepts canonical dispatch args without workflow audit fields when provenance and Host selection agree', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-dispatch-producer-'))
    try {
      const canonicalWorkspace = realpathSync(workspace)
      const harness = await setup(canonicalWorkspace)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(canonicalWorkspace)
      const sessionDir = dirname(realpathSync(runDir))
      writeFileSync(join(canonicalWorkspace, 'kernel.py'), 'VALUE = 1\n')
      appendValidBaselineCustody(sessionDir, canonicalWorkspace, controller)
      const workflowName = workflowMeta.name
      writeDispatchSelection(sessionDir, workflowName)
      const producer = descendantAgent(harness, controller.session, 'dispatch-producer-1')
      registerDispatchProducerProbe(
        harness,
        producer,
        runDir,
        { exp_dir: runDir, kernel_path: '/tmp/kernel.py' },
        {
          schema_version: 1,
          source: 'dispatch-arg-synthesizer',
          workflow_name: workflowName,
          missing_required: [],
          unmet_note_requirements: [],
        },
      )
      const producerArgs = dispatchProducerArguments(sessionDir, runDir, workflowName)
      harness.ctx.on('tools/execute', async (exec, next) => {
        const result = await next()
        if (exec.name === 'subagent') {
          process.env.KERSOR_PYTHON = join(canonicalWorkspace, 'reconfigured-python')
          process.env.KERSOR_ROOT = join(canonicalWorkspace, 'reconfigured-root')
        }
        return result
      })
      harness.hostTransformSubprocess.onSpawn = () => {
        expect(existsSync(join(runDir, 'dispatch-args-producer-receipt.json'))).toBe(true)
        expect(controller.session.events.some(event =>
          event.type === 'kersor/dispatch-args-produced')).toBe(true)
        const argsPath = join(runDir, 'dispatch-args.json')
        const provenancePath = join(runDir, 'dispatch-args-provenance.json')
        const dispatchArgs = JSON.parse(readFileSync(argsPath, 'utf8')) as Record<string, unknown>
        const provenance = JSON.parse(readFileSync(provenancePath, 'utf8')) as Record<string, unknown>
        dispatchArgs.termination_file = join(sessionDir, 'terminate')
        provenance.runtime_controls = {
          termination_file: {
            source: 'campaign_environment', value: dispatchArgs.termination_file,
          },
        }
        writeFileSync(argsPath, JSON.stringify(dispatchArgs))
        writeFileSync(provenancePath, JSON.stringify(provenance))
      }

      const first = await call(harness, 'subagent', producerArgs, controller)

      expect(first.isError, JSON.stringify(first.content)).toBe(false)
      const receipt = JSON.parse(readFileSync(
        join(runDir, 'dispatch-args-producer-receipt.json'), 'utf8',
      )) as Record<string, unknown>
      expect(receipt).toMatchObject({
        contract: 'dsh_dispatch_args_producer_v1',
        authority: 'dsh_host',
        producer_session_id: producer.id,
      })
      const produced = controller.session.events.filter(event =>
        event.type === 'kersor/dispatch-args-produced')
      expect(produced).toHaveLength(1)
      expect(first.additionalContexts).toBeUndefined()
      expect(harness.hostTransformSubprocess.specs).toHaveLength(1)
      expect(harness.hostTransformSubprocess.specs[0]).toMatchObject({
        argv: [
          testKersorPython,
          join(testKersorRoot, 'scripts', 'inject-runtime-controls.py'),
          runDir,
        ],
        cwd: canonicalWorkspace,
        signal,
      })
      const transformed = controller.session.events.filter(event =>
        event.type === 'kersor/dispatch-args-transformed')
      expect(transformed).toHaveLength(1)
      expect(transformed[0]?.data).toMatchObject({
        transformation_call_id: produced[0]?.data.producer_call_id,
        changed: true,
        authorized_fields: {
          dispatch_args: ['termination_file'],
          dispatch_args_provenance: ['runtime_controls'],
        },
      })
      process.env.KERSOR_PYTHON = testKersorPython
      process.env.KERSOR_ROOT = testKersorRoot

      const retry = await call(harness, 'subagent', producerArgs, controller)
      expect(retry.isError).toBe(true)
      expect(retry.content.some(block => block.type === 'text'
        && block.text.includes('exact-once'))).toBe(true)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.each([
    'pending-plan',
    'pending-commit',
    'mismatched-workflow',
    'pending-routing',
  ] as const)(
    'rejects a foreground dispatch producer when the selected Workflow has %s',
    async (failure) => {
      const workspace = mkdtempSync(join(tmpdir(), `dsh-kersor-selection-${failure}-`))
      try {
        const canonicalWorkspace = realpathSync(workspace)
        const harness = await setup(canonicalWorkspace)
        const controller = await startController(harness)
        const runDir = makeRunDirectory(canonicalWorkspace)
        const sessionDir = dirname(runDir)
        writeFileSync(join(canonicalWorkspace, 'kernel.py'), 'VALUE = 1\n')
        appendValidBaselineCustody(sessionDir, canonicalWorkspace, controller)
        writeDispatchSelection(sessionDir)
        const selectionPath = join(sessionDir, 'round-1-selection.json')
        const selection = readJsonFixture(selectionPath) as {
          routing: { decided_by: string }
          attempt_plan: {
            status: string
            commit: { status: string; workflow: string }
          }
        }
        if (failure === 'pending-plan') {
          selection.attempt_plan.status = 'proposed'
        } else if (failure === 'pending-commit') {
          selection.attempt_plan.commit.status = 'proposed'
        } else if (failure === 'mismatched-workflow') {
          selection.attempt_plan.commit.workflow = 'other-workflow'
        } else {
          selection.routing.decided_by = 'agent-advise-pending-demoted'
        }
        writeFileSync(selectionPath, JSON.stringify(selection))
        const calls: string[] = []
        const producer = descendantAgent(
          harness, controller.session, `dispatch-producer-${failure}`,
        )
        registerDispatchProducerProbe(
          harness,
          producer,
          runDir,
          { exp_dir: runDir, kernel_path: '/tmp/kernel.py' },
          {
            schema_version: 1,
            source: 'dispatch-arg-synthesizer',
            workflow_name: workflowMeta.name,
            missing_required: [],
            unmet_note_requirements: [],
          },
          calls,
        )

        const result = await call(
          harness,
          'subagent',
          dispatchProducerArguments(sessionDir, runDir),
          controller,
        )

        expect(result.isError).toBe(true)
        expect(promptText(result.content)).toMatch(/committed selection|selection.*commit/i)
        expect(calls).toEqual([])
        expect(existsSync(join(runDir, 'dispatch-args-producer-receipt.json'))).toBe(false)
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    },
  )

  it('keeps durable producer custody when the Host runtime-control subprocess fails', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-producer-context-fail-'))
    try {
      const canonicalWorkspace = realpathSync(workspace)
      const harness = await setup(canonicalWorkspace)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(canonicalWorkspace)
      const sessionDir = dirname(realpathSync(runDir))
      writeFileSync(join(canonicalWorkspace, 'kernel.py'), 'VALUE = 1\n')
      appendValidBaselineCustody(sessionDir, canonicalWorkspace, controller)
      writeDispatchSelection(sessionDir)
      const producer = descendantAgent(harness, controller.session, 'dispatch-producer-context-fail')
      registerDispatchProducerProbe(
        harness,
        producer,
        runDir,
        { exp_dir: runDir, kernel_path: '/tmp/kernel.py' },
        {
          schema_version: 1,
          source: 'dispatch-arg-synthesizer',
          workflow_name: workflowMeta.name,
          missing_required: [],
          unmet_note_requirements: [],
        },
      )
      harness.hostTransformSubprocess.exitCode = 23
      harness.hostTransformSubprocess.stderr = 'runtime controls failed\n'

      const result = await call(
        harness,
        'subagent',
        dispatchProducerArguments(sessionDir, runDir),
        controller,
      )
      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/producer custody failed|runtime controls failed/i)
      expect(result.additionalContexts).toBeUndefined()
      expect(existsSync(join(runDir, 'dispatch-args-producer-receipt.json'))).toBe(true)
      expect(controller.session.events.filter(event =>
        event.type === 'kersor/dispatch-args-produced')).toHaveLength(1)
      expect(existsSync(join(runDir, 'dispatch-args-transformation-receipt.json'))).toBe(false)
      expect(controller.session.events.filter(event =>
        event.type === 'kersor/dispatch-args-transformed')).toHaveLength(0)
    } finally {
      process.env.KERSOR_PYTHON = testKersorPython
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects dispatch provenance whose workflow_name differs from the Host selection', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-dispatch-provenance-name-'))
    try {
      const canonicalWorkspace = realpathSync(workspace)
      const harness = await setup(canonicalWorkspace)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(canonicalWorkspace)
      const sessionDir = dirname(runDir)
      writeFileSync(join(canonicalWorkspace, 'kernel.py'), 'VALUE = 1\n')
      appendValidBaselineCustody(sessionDir, canonicalWorkspace, controller)
      writeDispatchSelection(sessionDir)
      const producer = descendantAgent(harness, controller.session, 'dispatch-producer-wrong-name')
      registerDispatchProducerProbe(
        harness,
        producer,
        runDir,
        { exp_dir: runDir, kernel_path: '/tmp/kernel.py' },
        {
          schema_version: 1,
          source: 'dispatch-arg-synthesizer',
          workflow_name: 'wrong-workflow',
          missing_required: [],
          unmet_note_requirements: [],
        },
      )

      const result = await call(
        harness,
        'subagent',
        dispatchProducerArguments(sessionDir, runDir),
        controller,
      )

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/provenance.*selected workflow/i)
      expect(existsSync(join(runDir, 'dispatch-args-producer-receipt.json'))).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.each(['workflow', 'workflow_name'])(
    'rejects dispatch args that carry the unauthorized %s audit field',
    async (auditField) => {
      const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-dispatch-audit-field-'))
      try {
        const canonicalWorkspace = realpathSync(workspace)
        const harness = await setup(canonicalWorkspace)
        const controller = await startController(harness)
        const runDir = makeRunDirectory(canonicalWorkspace)
        const sessionDir = dirname(runDir)
        writeFileSync(join(canonicalWorkspace, 'kernel.py'), 'VALUE = 1\n')
        appendValidBaselineCustody(sessionDir, canonicalWorkspace, controller)
        writeDispatchSelection(sessionDir)
        const producer = descendantAgent(
          harness,
          controller.session,
          `dispatch-producer-audit-${auditField}`,
        )
        registerDispatchProducerProbe(
          harness,
          producer,
          runDir,
          {
            exp_dir: runDir,
            kernel_path: '/tmp/kernel.py',
            [auditField]: workflowMeta.name,
          },
          {
            schema_version: 1,
            source: 'dispatch-arg-synthesizer',
            workflow_name: workflowMeta.name,
            missing_required: [],
            unmet_note_requirements: [],
          },
        )

        const result = await call(
          harness,
          'subagent',
          dispatchProducerArguments(sessionDir, runDir),
          controller,
        )

        expect(result.isError).toBe(true)
        expect(promptText(result.content)).toMatch(/dispatch-args\.json.*audit field/i)
        expect(existsSync(join(runDir, 'dispatch-args-producer-receipt.json'))).toBe(false)
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    },
  )

  it('rejects dispatch when the requested workflow drifts from the Host selected entry', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-dispatch-selection-drift-'))
    try {
      const canonicalWorkspace = realpathSync(workspace)
      const calls: string[] = []
      const harness = await setup(canonicalWorkspace)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(canonicalWorkspace)
      const sessionDir = dirname(runDir)
      writeFileSync(join(canonicalWorkspace, 'kernel.py'), 'VALUE = 1\n')
      appendValidBaselineCustody(sessionDir, canonicalWorkspace, controller)
      writeDispatchSelection(sessionDir, 'different-selected-workflow')
      const producer = descendantAgent(harness, controller.session, 'dispatch-producer-selection-drift')
      registerDispatchProducerProbe(
        harness,
        producer,
        runDir,
        { exp_dir: runDir, kernel_path: '/tmp/kernel.py' },
        {
          schema_version: 1,
          source: 'dispatch-arg-synthesizer',
          workflow_name: workflowMeta.name,
          missing_required: [],
          unmet_note_requirements: [],
        },
        calls,
      )

      const result = await call(
        harness,
        'subagent',
        dispatchProducerArguments(sessionDir, runDir),
        controller,
      )

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/Host selected workflow/i)
      expect(calls).toEqual([])
      expect(existsSync(join(runDir, 'dispatch-args-producer-receipt.json'))).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('denies a foreground dispatch producer before the Session baseline is verified', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-producer-before-baseline-'))
    try {
      const canonicalWorkspace = realpathSync(workspace)
      const harness = await setup(canonicalWorkspace)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(canonicalWorkspace)
      const sessionDir = dirname(realpathSync(runDir))
      writeFileSync(join(canonicalWorkspace, 'kernel.py'), 'VALUE = 1\n')
      appendValidBaselineCustody(sessionDir, canonicalWorkspace, controller, 2)
      const calls: string[] = []
      harness.ctx.tools.register(defineTool({
        name: 'subagent',
        description: 'Rejectable producer probe.',
        parameters: {
          description: { type: 'string', required: true },
          prompt: { type: 'string', required: true },
          run_in_background: { type: 'boolean', required: true },
        },
        output: {
          schema: { type: 'json' },
          render: () => [{ type: 'text', text: 'unexpected producer execution' }],
        },
        execute: () => {
          calls.push('subagent')
          return Promise.resolve({ kind: 'foreground', runId: 'unexpected', output: [] })
        },
      }))

      const result = await call(
        harness,
        'subagent',
        dispatchProducerArguments(sessionDir, runDir),
        controller,
      )

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/verified baseline|baseline.*verified/i)
      expect(calls).toEqual([])
      expect(existsSync(join(runDir, 'dispatch-args-producer-receipt.json'))).toBe(false)
      expect(controller.session.events.filter(event =>
        event.type === 'kersor/dispatch-args-produced')).toHaveLength(0)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects sealed Workflow dispatch when the Host runtime-control pass was skipped', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-transform-required-'))
    try {
      const calls: string[] = []
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, {
        runId: 'workflow-transform-required', agentsStarted: 1, result: { bypass: true },
      }, calls)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      writeWorkflowEnvelope(runDir, controller, workflowArguments(runDir), {
        appendTransformation: false,
        writeCandidateSeal: false,
      })

      const result = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)

      expect(result.isError).toBe(true)
      expect(result.content.some(block => block.type === 'text'
        && block.text.includes('runtime-control transformation'))).toBe(true)
      expect(calls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects sealed Workflow dispatch without the candidate ownership seal', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-candidate-seal-required-'))
    try {
      const calls: string[] = []
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, {
        runId: 'workflow-candidate-seal-required', agentsStarted: 1, result: { bypass: true },
      }, calls)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      writeWorkflowEnvelope(runDir, controller, workflowArguments(runDir), {
        writeCandidateSeal: false,
      })

      const result = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)

      expect(result.isError).toBe(true)
      expect(result.content.some(block => block.type === 'text'
        && block.text.includes('candidate ownership seal'))).toBe(true)
      expect(calls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects a self-consistent forged current seal without its canonical call or Host event', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-candidate-seal-forged-'))
    try {
      const calls: string[] = []
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, {
        runId: 'workflow-forged-seal', agentsStarted: 1, result: { bypass: true },
      }, calls)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      writeWorkflowEnvelope(runDir, controller, workflowArguments(runDir), {
        appendCandidateSealCall: false,
        appendCandidateSealEvent: false,
      })

      const result = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)

      expect(result.isError).toBe(true)
      expect(result.content.some(block => block.type === 'text'
        && block.text.includes('candidate ownership seal')
        && block.text.includes('durable Host'))).toBe(true)
      expect(calls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('fails closed on cold replay when the canonical seal call lacks its Host event', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-candidate-seal-event-'))
    try {
      const calls: string[] = []
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, {
        runId: 'workflow-missing-seal-event', agentsStarted: 1, result: { bypass: true },
      }, calls)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      writeWorkflowEnvelope(runDir, controller, workflowArguments(runDir), {
        appendCandidateSealEvent: false,
      })

      const result = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)

      expect(result.isError).toBe(true)
      expect(result.content.some(block => block.type === 'text'
        && block.text.includes('matching durable Host event'))).toBe(true)
      expect(calls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects candidate ownership seal bytes changed after the Host event', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-candidate-seal-tamper-'))
    try {
      const calls: string[] = []
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, {
        runId: 'workflow-tampered-seal', agentsStarted: 1, result: { bypass: true },
      }, calls)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      writeWorkflowEnvelope(runDir, controller)
      const sealPath = join(realpathSync(runDir), 'candidate-ownership-seal.json')
      writeFileSync(sealPath, `${readFileSync(sealPath, 'utf8')}\n`)

      const result = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/durable Host event identity or seal hash/i)
      expect(calls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.each([
    ['phase', 'complete'],
    ['current_round', 2],
    ['backend', 'forged-backend'],
    ['kernel_language', 'forged-language'],
    ['target_speedup', 99],
  ] as const)(
    'rejects state.json %s drift from the current run and effective launch/config',
    async (field, value) => {
      const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-state-binding-'))
      try {
        const calls: string[] = []
        const harness = await setup(workspace)
        registerWorkflowProbe(harness, {
          runId: `workflow-state-${field}`, agentsStarted: 1, result: { bypass: true },
        }, calls)
        const controller = await startController(harness)
        const runDir = makeRunDirectory(workspace)
        writeWorkflowEnvelope(runDir, controller)
        const statePath = join(dirname(runDir), 'state.json')
        const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
        state[field] = value
        writeFileSync(statePath, JSON.stringify(state))

        const result = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)

        expect(result.isError).toBe(true)
        expect(promptText(result.content)).toMatch(new RegExp(`state\\.json.*${field}|${field}.*(?:launch|config|run)`, 'i'))
        expect(calls).toEqual([])
        expect(existsSync(join(runDir, 'output.json'))).toBe(false)
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    },
  )

  it.each([
    ['protected kernel', (workspace: string) => {
      writeFileSync(join(workspace, 'kernel.py'), 'VALUE = 2\n')
    }],
    ['session config', (_workspace: string, runDir: string) => {
      const path = join(dirname(runDir), 'session-config.json')
      const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      config.drift = true
      writeFileSync(path, JSON.stringify(config))
    }],
    ['baseline witness', (_workspace: string, runDir: string) => {
      writeFileSync(join(dirname(runDir), 'baseline-witness.json'), JSON.stringify({ verdict: 'fail' }))
    }],
    ['tracked worktree', (workspace: string) => {
      writeFileSync(join(workspace, 'README.md'), 'changed\n')
    }],
    ['untracked worktree', (workspace: string) => {
      writeFileSync(join(workspace, 'rogue.txt'), 'new untracked evidence\n')
    }],
  ] as const)('rejects %s drift after candidate ownership sealing', async (_label, mutate) => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-candidate-seal-drift-'))
    try {
      initializeGitWorkspace(workspace)
      const calls: string[] = []
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, {
        runId: 'workflow-drifted-seal', agentsStarted: 1, result: { bypass: true },
      }, calls)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      writeWorkflowEnvelope(runDir, controller)
      mutate(workspace, runDir)

      const result = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(
        /candidate ownership|Session initialization immutable config/i,
      )
      expect(calls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('denies controller and descendant mutation of exclusive Host ownership artifacts', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-candidate-seal-mutation-'))
    try {
      const harness = await setup(workspace)
      const fileCalls: string[] = []
      const bashCalls: string[] = []
      registerFileProbe(harness, 'write', fileCalls)
      registerFileProbe(harness, 'edit', fileCalls)
      registerBashProbe(harness, bashCalls)
      const controller = await startController(harness)
      const descendant = descendantAgent(harness, controller.session, 'seal-writer-descendant')
      const sealPath = join(makeRunDirectory(workspace), 'candidate-ownership-seal.json')
      for (const agent of [controller, descendant]) {
        for (const path of [sealPath, join(dirname(sealPath), 'candidate-ownership.json')]) {
          for (const name of ['write', 'edit'] as const) {
            const result = await call(harness, name, { file_path: path }, agent)
            expect(result.isError).toBe(true)
          }
          const bash = await call(harness, 'bash', {
            command: `cp /tmp/forged-ownership '${path}'`,
          }, agent)
          expect(bash.isError).toBe(true)
        }
      }
      expect(fileCalls).toEqual([])
      expect(bashCalls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('mints one Host seal event after a successful canonical seal call', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-candidate-seal-live-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      writeWorkflowEnvelope(runDir, controller, workflowArguments(runDir), {
        appendCandidateSealCall: false,
        appendCandidateSealEvent: false,
      })
      const sealPath = join(realpathSync(runDir), 'candidate-ownership-seal.json')
      const sealBytes = readFileSync(sealPath, 'utf8')
      rmSync(sealPath)
      harness.ctx.tools.register(defineTool({
        name: 'bash',
        description: 'Run the canonical candidate seal probe.',
        parameters: { command: { type: 'string', required: true } },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: (args) => {
          writeFileSync(sealPath, sealBytes)
          return Promise.resolve(args.command)
        },
      }))

      const result = await call(harness, 'bash', {
        command: candidateOwnershipSealCommand(runDir),
      }, controller)

      expect(result.isError, JSON.stringify(result.content)).toBe(false)
      const events = controller.session.events.filter(event =>
        event.type === 'kersor/candidate-ownership-sealed')
      expect(events, JSON.stringify(result.content)).toHaveLength(1)
      expect(events[0]!.data).toMatchObject({
        contract: 'dsh_candidate_ownership_seal_v1',
        authority: 'dsh_host',
        session_dir: dirname(realpathSync(runDir)),
        run_dir: realpathSync(runDir),
        controller_session_id: controller.id,
        seal: { path: sealPath, sha256: fileSha256(sealPath) },
      })
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('consumes a failed canonical candidate seal call and denies replay', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-candidate-seal-failed-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      writeWorkflowEnvelope(runDir, controller, workflowArguments(runDir), {
        writeCandidateSeal: false,
      })
      harness.ctx.tools.register(defineTool({
        name: 'bash',
        description: 'Fail the canonical candidate seal probe.',
        parameters: { command: { type: 'string', required: true } },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: () => { throw new Error('candidate seal failed') },
      }))
      const command = candidateOwnershipSealCommand(runDir)

      const failed = await call(harness, 'bash', { command }, controller)

      expect(failed.isError).toBe(true)
      expect(existsSync(join(runDir, 'candidate-ownership-seal.json'))).toBe(false)
      expect(controller.session.events.filter(event =>
        event.type === 'kersor/candidate-ownership-sealed')).toHaveLength(0)
      const retry = await call(harness, 'bash', { command }, controller)
      expect(retry.isError).toBe(true)
      expect(promptText(retry.content)).toContain('exact-once')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects dispatch production backed only by a forged verdict-pass baseline stub', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-baseline-stub-'))
    try {
      const canonicalWorkspace = realpathSync(workspace)
      const calls: string[] = []
      const harness = await setup(canonicalWorkspace)
      const controller = await startController(harness)
      writeFileSync(join(canonicalWorkspace, 'kernel.py'), 'VALUE = 1\n')
      const runDir = makeRunDirectory(canonicalWorkspace)
      const sessionDir = dirname(realpathSync(runDir))
      writeValidBaselineAuthority(sessionDir, canonicalWorkspace)
      ensureSessionInitializationFixture(sessionDir, canonicalWorkspace, controller)
      writeFileSync(join(sessionDir, 'baseline-witness.json'), JSON.stringify({ verdict: 'pass' }))
      expect(JSON.parse(readFileSync(
        join(sessionDir, 'baseline-witness.json'), 'utf8',
      ))).toEqual({ verdict: 'pass' })
      harness.ctx.tools.register(defineTool({
        name: 'subagent',
        description: 'Rejectable forged-baseline producer probe.',
        parameters: {
          description: { type: 'string', required: true },
          prompt: { type: 'string', required: true },
          run_in_background: { type: 'boolean', required: true },
        },
        output: {
          schema: { type: 'json' },
          render: () => [{ type: 'text', text: 'unexpected producer execution' }],
        },
        execute: () => {
          calls.push('subagent')
          return Promise.resolve({ kind: 'foreground', runId: 'unexpected', output: [] })
        },
      }))

      const result = await call(
        harness,
        'subagent',
        dispatchProducerArguments(sessionDir, runDir),
        controller,
      )

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(
        /baseline.*Host custody|baseline witness|baseline.*initializ/i,
      )
      expect(calls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects a seal call logged before its dispatch transformation even when its event follows', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-seal-call-order-'))
    try {
      const calls: string[] = []
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, {
        runId: 'workflow-seal-call-order', agentsStarted: 1, result: { bypass: true },
      }, calls)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      const canonicalRunDir = realpathSync(runDir)
      const sealCallId = 'candidate-seal-call-before-transform'
      controller.session.append('tool/call', {
        turn: 1,
        step: 1,
        callId: CallId(sealCallId),
        name: 'bash',
        arguments: JSON.stringify({ command: candidateOwnershipSealCommand(canonicalRunDir) }),
      })
      writeWorkflowEnvelope(runDir, controller, workflowArguments(runDir), {
        appendCandidateSealCall: false,
        appendCandidateSealEvent: false,
      })
      const sealPath = join(canonicalRunDir, 'candidate-ownership-seal.json')
      controller.session.append('kersor/candidate-ownership-sealed', {
        schema_version: 1,
        contract: 'dsh_candidate_ownership_seal_v1',
        authority: 'dsh_host',
        session_dir: dirname(canonicalRunDir),
        run_dir: canonicalRunDir,
        round: 1,
        controller_session_id: controller.id,
        seal_call_id: sealCallId,
        seal: { path: sealPath, sha256: fileSha256(sealPath) },
        state: {
          path: join(dirname(canonicalRunDir), 'state.json'),
          sha256: fileSha256(join(dirname(canonicalRunDir), 'state.json')),
        },
      } as never)

      const result = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/seal.*call.*order|durable event order/i)
      expect(calls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('denies an exact canonical candidate seal command from a controller descendant', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-descendant-seal-call-'))
    try {
      const calls: string[] = []
      const harness = await setup(workspace)
      registerBashProbe(harness, calls)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      writeWorkflowEnvelope(runDir, controller, workflowArguments(runDir), {
        writeCandidateSeal: false,
      })
      const descendant = descendantAgent(harness, controller.session, 'seal-call-descendant')

      const result = await call(harness, 'bash', {
        command: candidateOwnershipSealCommand(runDir),
      }, descendant)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/controller.*seal|Host-authorized/i)
      expect(calls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'denies real-path seal mutation when controller cwd reaches the workspace through a symlink',
    async () => {
      const container = mkdtempSync(join(tmpdir(), 'dsh-kersor-seal-alias-'))
      const realWorkspace = join(container, 'real-workspace')
      const linkedWorkspace = join(container, 'linked-workspace')
      mkdirSync(realWorkspace)
      symlinkSync(realWorkspace, linkedWorkspace)
      try {
        const harness = await setup(linkedWorkspace)
        const fileCalls: string[] = []
        const bashCalls: string[] = []
        registerFileProbe(harness, 'write', fileCalls)
        registerFileProbe(harness, 'edit', fileCalls)
        registerBashProbe(harness, bashCalls)
        const controller = await startController(harness)
        const descendant = descendantAgent(harness, controller.session, 'seal-alias-descendant')
        const runDir = makeRunDirectory(linkedWorkspace)
        const sealPath = join(realpathSync(runDir), 'candidate-ownership-seal.json')
        for (const agent of [controller, descendant]) {
          for (const name of ['write', 'edit'] as const) {
            expect((await call(harness, name, { file_path: sealPath }, agent)).isError)
              .toBe(true)
          }
          expect((await call(harness, 'bash', {
            command: `cp /tmp/forged-seal '${sealPath}'`,
          }, agent)).isError).toBe(true)
        }
        expect(fileCalls).toEqual([])
        expect(bashCalls).toEqual([])
      } finally {
        rmSync(container, { recursive: true, force: true })
      }
    },
  )

  it('hard-fails malformed repository metadata but accepts an explicit non-repository project', async () => {
    for (const malformedGit of [false, true]) {
      const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-git-probe-'))
      try {
        if (malformedGit) writeFileSync(join(workspace, '.git'), 'invalid gitfile\n')
        const calls: string[] = []
        const harness = await setup(workspace)
        registerWorkflowProbe(harness, {
          runId: `workflow-git-${malformedGit}`, agentsStarted: 1,
          result: { malformedGit },
        }, calls)
        const controller = await startController(harness)
        const runDir = makeRunDirectory(workspace)
        writeWorkflowEnvelope(runDir, controller)

        const result = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)

        expect(result.isError).toBe(malformedGit)
        expect(calls).toEqual(malformedGit ? [] : ['workflow'])
        if (malformedGit) expect(promptText(result.content)).toMatch(/git.*ownership|repository/i)
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    }
  })

  it('hard-fails when a repository-backed seal loses its established git mode', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-git-mode-loss-'))
    try {
      initializeGitWorkspace(workspace)
      const calls: string[] = []
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, {
        runId: 'workflow-git-mode-loss', agentsStarted: 1, result: { bypass: true },
      }, calls)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      writeWorkflowEnvelope(runDir, controller)
      rmSync(join(workspace, '.git'), { recursive: true })

      const result = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/candidate ownership|git|worktree/i)
      expect(calls).toEqual([])
      expect(existsSync(join(runDir, 'output.json'))).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.each([
    'tests/test_kernel.py',
    'oracles/reference.py',
    'kersor-task.json',
    'problem.py',
    'kernel.py',
  ])('recomputes non-git protected file %s before Workflow execution', async (relativePath) => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-nongit-protected-'))
    try {
      const protectedPath = join(workspace, relativePath)
      mkdirSync(dirname(protectedPath), { recursive: true })
      writeFileSync(protectedPath, 'trusted fixture\n')
      const calls: string[] = []
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, {
        runId: `workflow-protected-${basename(relativePath)}`,
        agentsStarted: 1,
        result: { bypass: true },
      }, calls)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      writeWorkflowEnvelope(runDir, controller)
      writeFileSync(protectedPath, 'tampered after ownership seal\n')

      const result = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toContain(relativePath)
      expect(calls).toEqual([])
      expect(existsSync(join(runDir, 'output.json'))).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('denies direct-controller staging inspection before seal while the author can self-check', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-author-preseal-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'author-preseal')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      const staging = prepareAuthorStaging(sessionDir)
      const author = descendantAgent(harness, controller.session, 'workflow-author-preseal')
      const bashCalls: string[] = []
      const pathCalls: string[] = []
      registerBashProbe(harness, bashCalls)
      registerPathProbe(harness, 'read', pathCalls)
      registerFileProbe(harness, 'write', pathCalls)

      const authorRead = await call(harness, 'read', {
        file_path: join(staging, 'workflow.js'),
      }, author)
      const authorWrite = await call(harness, 'write', {
        file_path: join(staging, 'rationale.md'),
      }, author)
      const syntaxCommand = 'node --check workflow.js'
      const authorCheck = await call(harness, 'bash', {
        command: syntaxCommand,
        workdir: staging,
      }, author)
      const controllerList = await call(harness, 'bash', {
        command: `ls -la '${staging}/'`,
      }, controller)

      expect(authorRead.isError).toBe(false)
      expect(authorWrite.isError).toBe(false)
      expect(authorCheck.isError).toBe(false)
      expect(controllerList.isError).toBe(true)
      expect(promptText(controllerList.content)).toMatch(/author|staging|seal|custody/i)
      expect(pathCalls).toEqual([
        `read:${join(staging, 'workflow.js')}`,
        join(staging, 'rationale.md'),
      ])
      expect(bashCalls).toEqual([syntaxCommand])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('runs typed author seal and save with direct Host argv and opaque Core receipt custody', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-author-commit-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'author-commit')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      prepareAuthorStaging(sessionDir)
      writeKersorProtocolContext(sessionDir, 'workflow-authoring/author-context.json')

      const prematureSeal = await call(harness, 'kersor_author_commit', { action: 'seal' }, controller)
      expect(prematureSeal.isError).toBe(true)
      expect(harness.hostTransformSubprocess.specs).toHaveLength(0)

      const authored = await call(harness, 'kersor_protocol', { action: 'author' }, controller)
      expect(authored.isError, JSON.stringify(authored.content)).toBe(false)
      const prematureSave = await call(harness, 'kersor_author_commit', { action: 'save' }, controller)
      expect(prematureSave.isError).toBe(true)
      expect(harness.hostTransformSubprocess.specs).toHaveLength(1)

      harness.hostTransformSubprocess.onSpawn = (spec) => {
        if (basename(spec.argv[1] ?? '') === 'seal-author-handoff.py') {
          writeAuthorHandoff(sessionDir)
          harness.hostTransformSubprocess.stdout = `AUTHOR_HANDOFF=${join(sessionDir, 'workflow-authoring', 'author-handoff.json')}\n`
          return
        }
        if (basename(spec.argv[1] ?? '') === 'save-authored-workflow.sh') {
          harness.hostTransformSubprocess.stdout = writeSavedAuthorProposal(sessionDir)
          return
        }
        if (basename(spec.argv[1] ?? '') === 'generate-catalog.sh') {
          writeAuthorCatalog(sessionDir)
          harness.hostTransformSubprocess.stdout = 'CATALOG_REFRESHED=true\n'
        }
      }
      const sealed = await call(harness, 'kersor_author_commit', { action: 'seal' }, controller)
      expect(sealed.isError, JSON.stringify(sealed.content)).toBe(false)
      const sealSpec = harness.hostTransformSubprocess.specs[1]!
      const canonicalSession = realpathSync.native(sessionDir)
      expect(sealSpec.argv).toEqual([
        testKersorPython, join(testKersorRoot, 'scripts', 'seal-author-handoff.py'),
        '--from', join(canonicalSession, 'workflow-authoring', 'staging'),
        '--out', join(canonicalSession, 'workflow-authoring', 'author-handoff.json'),
      ])
      const sealEvent = controller.session.events.find(event =>
        event.type === 'kersor/author-handoff-sealed')
      expect(sealEvent?.data).toMatchObject({
        contract: 'dsh_author_handoff_seal_v2',
        author_session_id: 'kersor-protocol-child-1',
        handoff: { sha256: fileSha256(join(canonicalSession, 'workflow-authoring', 'author-handoff.json')) },
      })
      expect(Object.keys(sealEvent?.data ?? {}).sort()).toEqual([
        'author_call_id', 'author_session_id', 'authority', 'contract', 'controller_session_id',
        'handoff', 'schema_version', 'seal_call_id', 'session_dir',
      ])

      const saved = await call(harness, 'kersor_author_commit', { action: 'save' }, controller)
      expect(saved.isError, JSON.stringify(saved.content)).toBe(false)
      expect(promptText(saved.content)).toContain('PROPOSAL_NAME=authored-test')
      expect(promptText(saved.content)).toContain('CATALOG_REFRESHED=true')
      expect(harness.hostTransformSubprocess.specs[2]?.argv).toEqual([
        'bash', join(testKersorRoot, 'scripts', 'save-authored-workflow.sh'),
        '--from', join(canonicalSession, 'workflow-authoring', 'staging'),
        '--store', join(canonicalSession, 'workflow-authoring', 'proposals'),
        '--handoff', join(canonicalSession, 'workflow-authoring', 'author-handoff.json'),
      ])
      expect(harness.hostTransformSubprocess.specs[3]).toMatchObject({
        argv: [
          'bash', join(testKersorRoot, 'scripts', 'generate-catalog.sh'),
          realpathSync.native(join(testKersorRoot, 'workflows', 'Awesome-Kernel-Workflows')),
          join(canonicalSession, 'workflow-catalog.json'),
        ],
        env: {
          KERSOR_PYTHON: testKersorPython,
          KERSOR_ROOT: testKersorRoot,
          KERSOR_PROPOSALS_DIR: join(
            canonicalSession, 'workflow-authoring', 'proposals',
          ),
        },
      })
      expect(controller.session.events.filter(event =>
        event.type === 'kersor/author-save-attempted')).toHaveLength(1)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('durably consumes typed seal and save process failures across cold reload', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-author-commit-failure-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      await prepareTypedAuthor(
        harness, workspace, controller, 'author-commit-failure',
      )
      harness.hostTransformSubprocess.exitCode = 17
      harness.hostTransformSubprocess.stderr = 'seal failed\n'
      const failedSeal = await call(
        harness, 'kersor_author_commit', { action: 'seal' }, controller,
      )
      expect(failedSeal.isError).toBe(true)
      expect(controller.session.events.some(event =>
        event.type === 'kersor/author-handoff-sealed')).toBe(false)
      const callsAfterSealFailure = harness.hostTransformSubprocess.specs.length
      const sealRetry = await call(
        harness, 'kersor_author_commit', { action: 'seal' }, controller,
      )
      expect(sealRetry.isError).toBe(true)
      expect(harness.hostTransformSubprocess.specs).toHaveLength(callsAfterSealFailure)

      // A fresh Session proves save's distinct pre-execution durable commit point.
      const saveHarness = await setup(workspace)
      const saveController = await startController(saveHarness)
      const saveSession = await prepareTypedAuthor(
        saveHarness, workspace, saveController, 'author-save-failure',
      )
      await sealTypedAuthor(saveHarness, saveController, saveSession)
      let durableBeforeProcess = false
      saveHarness.hostTransformSubprocess.exitCode = 19
      saveHarness.hostTransformSubprocess.stderr = 'save failed\n'
      saveHarness.hostTransformSubprocess.onSpawn = () => {
        durableBeforeProcess = saveController.session.events.some(event =>
          event.type === 'kersor/author-save-attempted')
      }
      const failedSave = await call(
        saveHarness, 'kersor_author_commit', { action: 'save' }, saveController,
      )
      expect(failedSave.isError).toBe(true)
      expect(promptText(failedSave.content)).toMatch(/consumed.*needs_revision.*do not retry/i)
      expect(durableBeforeProcess).toBe(true)
      expect(saveController.session.events.filter(event =>
        event.type === 'kersor/author-save-attempted')).toHaveLength(1)
      const callsAfterSaveFailure = saveHarness.hostTransformSubprocess.specs.length
      await saveHarness.controlFiber.dispose()
      const reloaded = await saveHarness.ctx.plugin(control)
      try {
        const retry = await call(
          saveHarness, 'kersor_author_commit', { action: 'save' }, saveController,
        )
        expect(retry.isError).toBe(true)
      } finally {
        await reloaded.dispose()
      }
      expect(saveHarness.hostTransformSubprocess.specs).toHaveLength(callsAfterSaveFailure)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.each([
    'malformed-output', 'missing-record', 'noncanonical-record-name',
    'catalog-process', 'catalog-missing-proposal',
  ] as const)(
    'does not complete typed save for %s',
    async (failure) => {
      const workspace = mkdtempSync(join(tmpdir(), `dsh-kersor-author-${failure}-`))
      try {
        const harness = await setup(workspace)
        const controller = await startController(harness)
        const sessionDir = await prepareTypedAuthor(harness, workspace, controller, failure)
        await sealTypedAuthor(harness, controller, sessionDir)
        harness.hostTransformSubprocess.onSpawn = (spec) => {
          const script = basename(spec.argv[1] ?? '')
          if (script === 'save-authored-workflow.sh') {
            harness.hostTransformSubprocess.exitCode = 0
            if (failure === 'malformed-output') {
              harness.hostTransformSubprocess.stdout = 'saved\n'
              return
            }
            harness.hostTransformSubprocess.stdout = writeSavedAuthorProposal(sessionDir)
            if (failure === 'missing-record') {
              rmSync(join(
                sessionDir, 'workflow-authoring', 'proposals', 'authored-test', 'proposal.json',
              ))
            }
            if (failure === 'noncanonical-record-name') {
              const recordPath = join(
                sessionDir, 'workflow-authoring', 'proposals', 'authored-test', 'proposal.json',
              )
              const proposal = readJsonFixture(recordPath) as Record<string, JsonValue>
              proposal.name = 'authored-test'
              delete proposal.workflow_name
              writeFileSync(recordPath, JSON.stringify(proposal))
            }
            return
          }
          if (script !== 'generate-catalog.sh') return
          if (failure === 'catalog-process') {
            harness.hostTransformSubprocess.exitCode = 29
            harness.hostTransformSubprocess.stderr = 'catalog refresh failed\n'
            return
          }
          harness.hostTransformSubprocess.exitCode = 0
          writeFileSync(join(sessionDir, 'workflow-catalog.json'), JSON.stringify({ workflows: [] }))
          harness.hostTransformSubprocess.stdout = 'CATALOG_REFRESHED=true\n'
        }

        const result = await call(
          harness, 'kersor_author_commit', { action: 'save' }, controller,
        )
        expect(result.isError).toBe(true)
        expect(promptText(result.content)).toMatch(/consumed.*needs_revision/i)
        expect(controller.session.events.filter(event =>
          event.type === 'kersor/author-save-attempted')).toHaveLength(1)
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    },
  )

  it.each(['authoring-parent', 'proposal-store'] as const)(
    'rejects a symlinked %s before the typed seal process can write externally',
    async (target) => {
      const workspace = mkdtempSync(join(tmpdir(), `dsh-kersor-author-${target}-`))
      try {
        const harness = await setup(workspace)
        const controller = await startController(harness)
        const sessionDir = join(workspace, '.kersor', target)
        writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
        ensureSessionInitializationFixture(sessionDir, workspace, controller)
        prepareAuthorStaging(sessionDir)
        writeAuthorContextFixture(sessionDir)
        appendAuthorProducedFixture(controller, sessionDir)
        const authoring = join(sessionDir, 'workflow-authoring')
        const external = join(workspace, `external-${target}`)
        if (target === 'authoring-parent') {
          renameSync(authoring, external)
          symlinkSync(external, authoring, 'dir')
        } else {
          mkdirSync(external)
          symlinkSync(external, join(authoring, 'proposals'), 'dir')
        }
        const before = harness.hostTransformSubprocess.specs.length

        const result = await call(
          harness, 'kersor_author_commit', { action: 'seal' }, controller,
        )
        expect(result.isError).toBe(true)
        expect(harness.hostTransformSubprocess.specs).toHaveLength(before)
        expect(existsSync(join(external, 'author-handoff.json'))).toBe(false)
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    },
  )

  it('denies a Host-authorized Python gate whose Bash workdir enters author staging', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-author-host-gate-workdir-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'author-host-gate-workdir')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      const staging = prepareAuthorStaging(sessionDir)
      const command = baselineInitCommand(sessionDir)
      const calls: string[] = []
      registerBashProbe(harness, calls)

      const result = await call(harness, 'bash', {
        command,
        description: 'Attempt a Host-authorized Python gate from author staging',
        workdir: staging,
      }, controller)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/author|staging|seal|custody/i)
      expect(calls).toEqual([])
      expect(controller.session.events.some(event =>
        event.type === 'kersor/baseline-initialized')).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('allows an exact Host-authorized baseline command outside author staging', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-author-host-gate-safe-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      writeFileSync(join(workspace, 'kernel.py'), 'VALUE = 1\n')
      const sessionDir = join(workspace, '.kersor', 'author-host-gate-safe')
      mkdirSync(sessionDir, { recursive: true })
      writeValidBaselineAuthority(sessionDir, workspace)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      prepareAuthorStaging(sessionDir)
      const methodPath = join(sessionDir, 'test-method.md')
      const witnessPath = join(sessionDir, 'baseline-witness.json')
      const methodBytes = readFileSync(methodPath)
      rmSync(methodPath)
      rmSync(witnessPath)
      const command = baselineInitCommand(sessionDir)
      const calls: string[] = []
      registerBashProbe(harness, calls, (candidate) => {
        if (candidate === command) writeFileSync(methodPath, methodBytes)
        return candidate
      })

      const result = await call(harness, 'bash', { command }, controller)

      expect(result.isError, JSON.stringify(result.content)).toBe(false)
      expect(calls).toEqual([command])
      expect(controller.session.events.filter(event =>
        event.type === 'kersor/baseline-initialized')).toHaveLength(1)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.each([
    'profile context',
    'Session state read',
    'integration preflight',
  ] as const)(
    'allows trusted direct KerSor helper %s with the Session root but rejects a trailing staging read',
    async (helper) => {
      const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-author-trusted-helper-'))
      try {
        const harness = await setup(workspace)
        const controller = await startController(harness)
        const sessionDir = join(workspace, '.kersor', 'author-trusted-helper')
        writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
        ensureSessionInitializationFixture(sessionDir, workspace, controller)
        const staging = prepareAuthorStaging(sessionDir)
        const canonicalSession = realpathSync.native(sessionDir)
        const prefix = `KERSOR_PYTHON=${hostShellQuote(testKersorPython)}; export KERSOR_PYTHON;`
        const invocation = helper === 'profile context'
          ? `"$KERSOR_PYTHON" ${hostShellQuote(join(testKersorRoot, 'scripts', 'profile-handoff.py'))} context --session ${hostShellQuote(canonicalSession)}`
          : helper === 'Session state read'
            ? `bash ${hostShellQuote(join(testKersorRoot, 'scripts', 'kersor-state.sh'))} ${hostShellQuote(canonicalSession)} get phase`
            : `bash ${hostShellQuote(join(testKersorRoot, 'scripts', 'integration-preflight.sh'))} ${hostShellQuote(canonicalSession)}`
        const command = `${prefix} ${invocation}`
        const calls: string[] = []
        registerBashProbe(harness, calls)

        const accepted = await call(harness, 'bash', {
          command,
          workdir: dirname(staging),
        }, controller)
        const rejected = await call(harness, 'bash', {
          command: `${command}; cat staging/workflow.js`,
          workdir: dirname(staging),
        }, controller)

        expect(accepted.isError, JSON.stringify(accepted.content)).toBe(false)
        expect(rejected.isError).toBe(true)
        expect(promptText(rejected.content)).toMatch(/author|staging|seal|custody/i)
        expect(calls).toEqual([command])
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    },
  )

  it('denies direct selection helpers because the typed Host action owns the sequence', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-selection-helper-denied-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'selection-helper-denied')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      const canonicalSession = realpathSync.native(sessionDir)
      const command = [
        `KERSOR_PYTHON=${hostShellQuote(testKersorPython)}; export KERSOR_PYTHON;`,
        'bash', hostShellQuote(join(testKersorRoot, 'scripts', 'select-workflow.sh')),
        hostShellQuote(canonicalSession), '1',
        hostShellQuote(join(canonicalSession, 'workflow-catalog.json')),
      ].join(' ')
      const calls: string[] = []
      registerBashProbe(harness, calls)

      const result = await call(harness, 'bash', { command }, controller)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/selection|select_workflow|Host/i)
      expect(calls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.each(['seal helper', 'Proposal CLI'] as const)(
    'denies a Host-frozen versioned Python direct %s call that targets author staging',
    async (entrypoint) => {
      const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-author-direct-python-'))
      try {
        const harness = await setup(workspace)
        const controller = await startController(harness)
        const sessionDir = join(workspace, '.kersor', 'author-direct-python')
        writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
        ensureSessionInitializationFixture(sessionDir, workspace, controller)
        const staging = prepareAuthorStaging(sessionDir)
        const authoring = dirname(staging)
        const command = entrypoint === 'seal helper'
          ? [
            `KERSOR_PYTHON=${hostShellQuote(testKersorPython)}; export KERSOR_PYTHON;`,
            '"$KERSOR_PYTHON"',
            hostShellQuote(join(testKersorRoot, 'scripts', 'seal-author-handoff.py')),
            '--from', hostShellQuote(staging),
            '--out', hostShellQuote(join(authoring, 'author-handoff.json')),
          ].join(' ')
          : [
            `KERSOR_PYTHON=${hostShellQuote(testKersorPython)}; export KERSOR_PYTHON;`,
            '"$KERSOR_PYTHON"',
            hostShellQuote(join(testKersorRoot, 'scripts', 'kersor-proposals.py')),
            'save --origin authored --from', hostShellQuote(staging),
            '--store', hostShellQuote(join(authoring, 'proposals')),
            '--handoff', hostShellQuote(join(authoring, 'author-handoff.json')),
          ].join(' ')
        const calls: string[] = []
        registerBashProbe(harness, calls)

        const result = await call(harness, 'bash', { command }, controller)

        expect(result.isError).toBe(true)
        expect(promptText(result.content)).toMatch(/author|staging|seal|custody/i)
        expect(calls).toEqual([])
        expect(controller.session.events.some(event =>
          event.type === 'kersor/author-handoff-sealed'
          || event.type === 'kersor/author-save-attempted')).toBe(false)
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    },
  )

  it('denies pre-seal controller directory inspection resolved from a changed shell cwd', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-author-preseal-cwd-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'author-preseal-cwd')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      const staging = prepareAuthorStaging(sessionDir)
      const bashCalls: string[] = []
      registerBashProbe(harness, bashCalls)
      const command = `cd '${dirname(staging)}' && ls staging`

      const result = await call(harness, 'bash', { command }, controller)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/author|staging|seal|custody/i)
      expect(bashCalls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('denies pre-seal controller directory inspection rooted by the Bash workdir envelope', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-author-preseal-workdir-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'author-preseal-workdir')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      const staging = prepareAuthorStaging(sessionDir)
      const bashCalls: string[] = []
      registerBashProbe(harness, bashCalls)

      const result = await call(harness, 'bash', {
        command: 'ls .',
        workdir: staging,
      }, controller)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/author|staging|seal|custody/i)
      expect(bashCalls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('denies an exact staging Bash workdir before the real ToolBash executor dispatches', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-author-workdir-tool-bash-'))
    let shell: SetupSandboxExecutor | undefined
    try {
      const harness = await setup(workspace, async (ctx) => {
        await ctx.plugin(SandboxPolicyService, {
          mode: 'workspace-write',
          workspaceRoot: workspace,
        })
        await ctx.plugin(SetupSandboxExecutor)
        shell = ctx.shell as SetupSandboxExecutor
        await ctx.plugin(BashEnv)
        await ctx.plugin(ToolBash)
      })
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'author-workdir-tool-bash')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      const staging = prepareAuthorStaging(sessionDir)

      const result = await call(harness, 'bash', {
        command: 'cat workflow.js',
        description: 'Attempt to inspect author staging from the Bash workdir',
        workdir: staging,
      }, controller)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/author|staging|seal|custody/i)
      expect(shell!.calls).toHaveLength(0)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('denies a staging redirection before real ToolBash can change sealed-input bytes', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-author-redirection-tool-bash-'))
    let shell: SetupSandboxExecutor | undefined
    try {
      const harness = await setup(workspace, async (ctx) => {
        await ctx.plugin(SandboxPolicyService, {
          mode: 'workspace-write',
          workspaceRoot: workspace,
        })
        await ctx.plugin(SetupSandboxExecutor)
        shell = ctx.shell as SetupSandboxExecutor
        await ctx.plugin(BashEnv)
        await ctx.plugin(ToolBash)
      })
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'author-redirection-tool-bash')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      const staging = prepareAuthorStaging(sessionDir)
      const workflowPath = join(staging, 'workflow.js')
      const before = fileSha256(workflowPath)
      const command = `printf forged > '${workflowPath}'`
      shell!.onRun = (spec) => {
        execFileSync('bash', ['-c', spec.command], { cwd: spec.workdir })
      }

      const result = await call(harness, 'bash', {
        command,
        description: 'Attempt to redirect forged bytes into author staging',
      }, controller)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/author|staging|seal|custody/i)
      expect(shell!.calls).toHaveLength(0)
      expect(fileSha256(workflowPath)).toBe(before)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('denies a staging tee target before real ToolBash can change sealed-input bytes', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-author-tee-tool-bash-'))
    let shell: SetupSandboxExecutor | undefined
    try {
      const harness = await setup(workspace, async (ctx) => {
        await ctx.plugin(SandboxPolicyService, {
          mode: 'workspace-write',
          workspaceRoot: workspace,
        })
        await ctx.plugin(SetupSandboxExecutor)
        shell = ctx.shell as SetupSandboxExecutor
        await ctx.plugin(BashEnv)
        await ctx.plugin(ToolBash)
      })
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'author-tee-tool-bash')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      const staging = prepareAuthorStaging(sessionDir)
      const workflowPath = join(staging, 'workflow.js')
      const before = fileSha256(workflowPath)
      const command = `printf forged | tee '${workflowPath}'`
      shell!.onRun = (spec) => {
        execFileSync('bash', ['-c', spec.command], { cwd: spec.workdir })
      }

      const result = await call(harness, 'bash', {
        command,
        description: 'Attempt to tee forged bytes into author staging',
      }, controller)

      expect(result.isError).toBe(true)
      expect(shell!.calls).toHaveLength(0)
      expect(fileSha256(workflowPath)).toBe(before)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.each([
    ['append redirection', (path: string) => `printf forged >> '${path}'`],
    ['read-write redirection', (path: string) => `printf forged 1<> '${path}'`],
    ['assigned redirection target', (path: string) => `OUT='${path}'; printf forged > "$OUT"`],
    [
      'command-substitution redirection target',
      (path: string) => `printf forged > "$(printf '%s' '${path}')"`,
    ],
  ] as const)(
    'denies a staging %s before real ToolBash can change sealed-input bytes',
    async (_kind, commandFor) => {
      const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-author-output-tool-bash-'))
      let shell: SetupSandboxExecutor | undefined
      try {
        const harness = await setup(workspace, async (ctx) => {
          await ctx.plugin(SandboxPolicyService, {
            mode: 'workspace-write',
            workspaceRoot: workspace,
          })
          await ctx.plugin(SetupSandboxExecutor)
          shell = ctx.shell as SetupSandboxExecutor
          await ctx.plugin(BashEnv)
          await ctx.plugin(ToolBash)
        })
        const controller = await startController(harness)
        const sessionDir = join(workspace, '.kersor', 'author-output-tool-bash')
        writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
        ensureSessionInitializationFixture(sessionDir, workspace, controller)
        const staging = prepareAuthorStaging(sessionDir)
        const workflowPath = join(staging, 'workflow.js')
        const before = fileSha256(workflowPath)
        const command = commandFor(workflowPath)
        shell!.onRun = (spec) => {
          execFileSync('bash', ['-c', spec.command], { cwd: spec.workdir })
        }

        const result = await call(harness, 'bash', {
          command,
          description: 'Attempt to write forged bytes through a shell output target',
        }, controller)

        expect(result.isError).toBe(true)
        expect(shell!.calls).toHaveLength(0)
        expect(fileSha256(workflowPath)).toBe(before)
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    },
  )

  it('denies symlinked and hardlinked staging redirection targets before real ToolBash dispatch', async () => {
    const workspace = realpathSync.native(
      mkdtempSync(join(tmpdir(), 'dsh-kersor-author-output-alias-tool-bash-')),
    )
    let shell: SetupSandboxExecutor | undefined
    try {
      const harness = await setup(workspace, async (ctx) => {
        await ctx.plugin(SandboxPolicyService, {
          mode: 'workspace-write',
          workspaceRoot: workspace,
        })
        await ctx.plugin(SetupSandboxExecutor)
        shell = ctx.shell as SetupSandboxExecutor
        await ctx.plugin(BashEnv)
        await ctx.plugin(ToolBash)
      })
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'author-output-alias-tool-bash')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      const staging = prepareAuthorStaging(sessionDir)
      const workflowPath = join(staging, 'workflow.js')
      const symlinkPath = join(workspace, 'workflow-symlink.js')
      const hardlinkPath = join(workspace, 'workflow-hardlink.js')
      symlinkSync(workflowPath, symlinkPath)
      linkSync(workflowPath, hardlinkPath)
      const before = fileSha256(workflowPath)
      shell!.onRun = (spec) => {
        execFileSync('bash', ['-c', spec.command], { cwd: spec.workdir })
      }

      for (const path of [symlinkPath, hardlinkPath]) {
        const result = await call(harness, 'bash', {
          command: `printf forged > '${path}'`,
          description: 'Attempt to redirect forged bytes through an author staging alias',
        }, controller)
        expect(result.isError, path).toBe(true)
      }

      expect(shell!.calls).toHaveLength(0)
      expect(fileSha256(workflowPath)).toBe(before)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('denies non-canonical and staging-ancestor Bash workdirs before real ToolBash dispatch', async () => {
    const workspace = realpathSync.native(
      mkdtempSync(join(tmpdir(), 'dsh-kersor-author-workdir-alias-tool-bash-')),
    )
    let shell: SetupSandboxExecutor | undefined
    try {
      const harness = await setup(workspace, async (ctx) => {
        await ctx.plugin(SandboxPolicyService, {
          mode: 'workspace-write',
          workspaceRoot: workspace,
        })
        await ctx.plugin(SetupSandboxExecutor)
        shell = ctx.shell as SetupSandboxExecutor
        await ctx.plugin(BashEnv)
        await ctx.plugin(ToolBash)
      })
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'author-workdir-alias-tool-bash')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      const staging = prepareAuthorStaging(sessionDir)
      const child = join(staging, 'child')
      mkdirSync(child)
      const stageAlias = join(workspace, 'stage-link')
      const childAlias = join(workspace, 'stage-child-link')
      const workflowHardlink = join(workspace, 'workflow-hardlink.js')
      symlinkSync(staging, stageAlias, 'dir')
      symlinkSync(child, childAlias, 'dir')
      linkSync(join(staging, 'workflow.js'), workflowHardlink)
      const attempts = [
        { command: 'cat workflow.js', workdir: stageAlias },
        { command: 'cat workflow.js', workdir: `${childAlias}/..` },
        { command: 'cat staging/workflow.js', workdir: dirname(staging) },
        { command: `cat '${basename(workflowHardlink)}'`, workdir: workspace },
      ]

      for (const attempt of attempts) {
        const result = await call(harness, 'bash', {
          ...attempt,
          description: 'Attempt to reach author staging from an authored Bash workdir',
        }, controller)
        expect(result.isError, JSON.stringify(attempt)).toBe(true)
      }
      expect(shell!.calls).toHaveLength(0)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('allows a canonical unrelated Bash workdir and redirection through real ToolBash', async () => {
    const workspace = realpathSync.native(
      mkdtempSync(join(tmpdir(), 'dsh-kersor-author-unrelated-tool-bash-')),
    )
    let shell: SetupSandboxExecutor | undefined
    try {
      const harness = await setup(workspace, async (ctx) => {
        await ctx.plugin(SandboxPolicyService, {
          mode: 'workspace-write',
          workspaceRoot: workspace,
        })
        await ctx.plugin(SetupSandboxExecutor)
        shell = ctx.shell as SetupSandboxExecutor
        await ctx.plugin(BashEnv)
        await ctx.plugin(ToolBash)
      })
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'author-unrelated-tool-bash')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      prepareAuthorStaging(sessionDir)
      const unrelated = join(workspace, 'unrelated')
      mkdirSync(unrelated)
      const output = join(unrelated, 'safe.txt')
      shell!.onRun = (spec) => {
        execFileSync('bash', ['-c', spec.command], { cwd: spec.workdir })
      }

      const result = await call(harness, 'bash', {
        command: 'printf safe > safe.txt',
        description: 'Write one unrelated output through a canonical workdir',
        workdir: realpathSync.native(unrelated),
      }, controller)

      expect(result.isError).toBe(false)
      expect(shell!.calls).toHaveLength(1)
      expect(shell!.calls[0]?.workdir).toBe(realpathSync.native(unrelated))
      expect(readFileSync(output, 'utf8')).toBe('safe')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('denies pre-seal controller find, stat, glob, variable, and symlink staging paths without blocking unrelated paths', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-author-preseal-shell-paths-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'author-preseal-shell-paths')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      const staging = prepareAuthorStaging(sessionDir)
      const aliasDir = join(workspace, 'author-path-aliases')
      const safeDir = join(workspace, 'unrelated')
      mkdirSync(aliasDir)
      mkdirSync(safeDir)
      const stageAlias = join(aliasDir, 'stage-link')
      symlinkSync(staging, stageAlias, 'dir')
      const bashCalls: string[] = []
      registerBashProbe(harness, bashCalls)
      const deniedCommands = [
        `find '${dirname(staging)}' -path '*/staging/*' -type f`,
        `stat '${dirname(staging)}/stag'*`,
        `TARGET='${stageAlias}'; ls "$TARGET"`,
        `ls '${aliasDir}/stage-'*`,
        `cp -R '${stageAlias}' '${join(workspace, 'copied-stage')}'`,
      ]

      for (const command of deniedCommands) {
        const result = await call(harness, 'bash', { command }, controller)
        expect(result.isError, command).toBe(true)
        expect(promptText(result.content)).toMatch(/author|staging|seal|custody/i)
      }
      const safeCommand = `cd '${safeDir}' && ls .`
      const safe = await call(harness, 'bash', { command: safeCommand }, controller)

      expect(safe.isError).toBe(false)
      expect(bashCalls).toEqual([safeCommand])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('denies pre-seal file and Bash paths that resolve into staging through symlink segments or hardlinks', async () => {
    const workspace = realpathSync.native(
      mkdtempSync(join(tmpdir(), 'dsh-kersor-author-preseal-symlink-dotdot-')),
    )
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'author-preseal-symlink-dotdot')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      const staging = prepareAuthorStaging(sessionDir)
      const child = join(staging, 'child')
      mkdirSync(child)
      const intermediate = join(workspace, 'staging-child-link')
      symlinkSync(child, intermediate, 'dir')
      const rawWorkflowPath = `${intermediate}/../workflow.js`
      const hardlinkPath = join(workspace, 'staging-workflow-hardlink.js')
      linkSync(join(staging, 'workflow.js'), hardlinkPath)
      const bashCalls: string[] = []
      const readCalls: string[] = []
      const globCalls: string[] = []
      registerBashProbe(harness, bashCalls)
      registerPathProbe(harness, 'read', readCalls)
      registerSearchPathProbe(harness, 'glob', globCalls)

      const read = await call(harness, 'read', {
        file_path: rawWorkflowPath,
      }, controller)
      const command = `cat '${rawWorkflowPath}'`
      const bash = await call(harness, 'bash', { command }, controller)
      const hardlinkRead = await call(harness, 'read', {
        file_path: hardlinkPath,
      }, controller)
      const hardlinkCommand = `cat '${hardlinkPath}'`
      const hardlinkBash = await call(harness, 'bash', {
        command: hardlinkCommand,
      }, controller)
      const hardlinkGlob = await call(harness, 'glob', {
        path: workspace,
        pattern: basename(hardlinkPath),
      }, controller)

      expect(read.isError).toBe(true)
      expect(bash.isError).toBe(true)
      expect(hardlinkRead.isError).toBe(true)
      expect(hardlinkBash.isError).toBe(true)
      expect(hardlinkGlob.isError).toBe(true)
      expect(readCalls).toEqual([])
      expect(bashCalls).toEqual([])
      expect(globCalls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('denies a pre-seal controller nested multi-edit that targets author staging', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-author-preseal-multiedit-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'author-preseal-multiedit')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      const staging = prepareAuthorStaging(sessionDir)
      const calls: string[] = []
      registerNestedMultiEditProbe(harness, calls)

      const result = await call(harness, 'multi_edit', {
        edits: [{ file_path: join(staging, 'workflow.js'), replacement: 'forged' }],
      }, controller)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/author|staging|seal|custody/i)
      expect(calls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.each([
    ['glob', 'staging/*.js', undefined],
    ['grep', 'return', 'staging/*.js'],
  ] as const)(
    'denies pre-seal controller %s search rooted above staging with a matching filter',
    async (name, pattern, include) => {
      const workspace = mkdtempSync(join(tmpdir(), `dsh-kersor-author-preseal-${name}-`))
      try {
        const harness = await setup(workspace)
        const controller = await startController(harness)
        const sessionDir = join(workspace, '.kersor', `author-preseal-${name}`)
        writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
        ensureSessionInitializationFixture(sessionDir, workspace, controller)
        const staging = prepareAuthorStaging(sessionDir)
        const calls: string[] = []
        registerSearchPathProbe(harness, name, calls)

        const result = await call(harness, name, {
          path: dirname(staging), pattern, ...include === undefined ? {} : { include },
        }, controller)

        expect(result.isError).toBe(true)
        expect(promptText(result.content)).toMatch(/author|staging|seal|custody/i)
        expect(calls).toEqual([])
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    },
  )

  it('allows only exact direct-controller reads between author seal and save', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-author-sealed-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'author-sealed')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      const staging = prepareAuthorStaging(sessionDir)
      const author = descendantAgent(harness, controller.session, 'workflow-author-sealed')
      const bashCalls: string[] = []
      const pathCalls: string[] = []
      registerBashProbe(harness, bashCalls)
      registerPathProbe(harness, 'read', pathCalls)
      registerFileProbe(harness, 'edit', pathCalls)
      registerPathProbe(harness, 'multi_edit', pathCalls)

      appendAuthorSealFixture(controller, sessionDir)
      expect(controller.session.events.filter(event =>
        event.type === 'kersor/author-handoff-sealed')).toHaveLength(1)

      const workflowPath = join(staging, 'workflow.js')
      const reviewed = await call(harness, 'read', { file_path: workflowPath }, controller)
      const denied = [
        await call(harness, 'edit', { file_path: workflowPath }, controller),
        await call(harness, 'multi_edit', { file_path: workflowPath }, controller),
        await call(harness, 'bash', { command: `sed -n '1,20p' '${workflowPath}'` }, controller),
        await call(harness, 'read', { file_path: workflowPath }, author),
        await call(harness, 'bash', { command: `node --check '${workflowPath}'` }, author),
      ]

      expect(reviewed.isError).toBe(false)
      for (const result of denied) {
        expect(result.isError).toBe(true)
        expect(promptText(result.content)).toMatch(/author|staging|seal|custody/i)
      }
      appendAuthorSaveFixture(controller, sessionDir)
      const postSaveRead = await call(harness, 'read', { file_path: workflowPath }, controller)
      expect(postSaveRead.isError).toBe(true)
      expect(pathCalls).toEqual([`read:${workflowPath}`])
      expect(bashCalls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('denies an exact sealed Read when a canonical author file changes identity', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-author-read-toctou-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'author-read-toctou')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      const staging = prepareAuthorStaging(sessionDir)
      appendAuthorSealFixture(controller, sessionDir)
      const workflow = join(staging, 'workflow.js')
      const external = join(workspace, 'external-workflow.js')
      writeFileSync(external, 'return { forged: true }\n')
      unlinkSync(workflow)
      symlinkSync(external, workflow)
      const calls: string[] = []
      registerPathProbe(harness, 'read', calls)

      const result = await call(harness, 'read', { file_path: workflow }, controller)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(/sealed|immutable|author/i)
      expect(calls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('permanently denies recursive file-tool searches and symlinked Bash paths for controller and author after seal', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-author-sealed-aliases-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const sessionDir = join(workspace, '.kersor', 'author-sealed-aliases')
      writeValidSetupArtifacts(workspace, sessionDir, launchContract, controller.id)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      const staging = prepareAuthorStaging(sessionDir)
      const author = descendantAgent(harness, controller.session, 'workflow-author-sealed-aliases')
      const aliasDir = join(workspace, 'sealed-author-aliases')
      mkdirSync(aliasDir)
      const stageAlias = join(aliasDir, 'stage-link')
      symlinkSync(staging, stageAlias, 'dir')
      const bashCalls: string[] = []
      const pathCalls: string[] = []
      registerBashProbe(harness, bashCalls)
      registerPathProbe(harness, 'read', pathCalls)
      registerFileProbe(harness, 'edit', pathCalls)
      registerNestedMultiEditProbe(harness, pathCalls)
      registerSearchPathProbe(harness, 'glob', pathCalls)
      registerSearchPathProbe(harness, 'grep', pathCalls)

      appendAuthorSealFixture(controller, sessionDir)
      const aliasedWorkflow = join(stageAlias, 'workflow.js')
      const denied = [
        await call(harness, 'read', { file_path: aliasedWorkflow }, controller),
        await call(harness, 'edit', { file_path: aliasedWorkflow }, controller),
        await call(harness, 'multi_edit', {
          edits: [{ file_path: aliasedWorkflow, replacement: 'forged' }],
        }, controller),
        await call(harness, 'glob', {
          path: aliasDir, pattern: 'stage-link/*.js',
        }, controller),
        await call(harness, 'grep', {
          path: aliasDir, pattern: 'return', include: 'stage-link/*.js',
        }, author),
        await call(harness, 'bash', { command: `ls '${stageAlias}'` }, controller),
        await call(harness, 'bash', {
          command: `cp -R '${stageAlias}' '${join(workspace, 'copied-sealed-stage')}'`,
        }, author),
      ]

      for (const result of denied) {
        expect(result.isError).toBe(true)
        expect(promptText(result.content)).toMatch(/author|staging|seal|custody/i)
      }
      expect(pathCalls).toEqual([])
      expect(bashCalls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('mints ordered baseline init/record/verify custody events and denies replay', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-baseline-custody-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      writeFileSync(join(workspace, 'kernel.py'), 'VALUE = 1\n')
      const runDir = makeRunDirectory(workspace)
      const sessionDir = dirname(realpathSync(runDir))
      writeValidBaselineAuthority(sessionDir, workspace)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      const methodPath = join(sessionDir, 'test-method.md')
      const witnessPath = join(sessionDir, 'baseline-witness.json')
      const methodBytes = readFileSync(methodPath, 'utf8')
      const witnessBytes = readFileSync(witnessPath, 'utf8')
      rmSync(methodPath)
      rmSync(witnessPath)
      const calls: string[] = []
      harness.ctx.tools.register(defineTool({
        name: 'bash',
        description: 'Run one baseline custody probe.',
        parameters: { command: { type: 'string', required: true } },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: (args) => {
          calls.push(args.command)
          if (args.command.includes('baseline-witness.py" init ')) {
            writeFileSync(methodPath, methodBytes)
          } else if (args.command.includes('baseline-witness.py" record ')) {
            writeFileSync(witnessPath, witnessBytes)
          }
          return Promise.resolve(args.command)
        },
      }))
      const commands = [
        baselineInitCommand(sessionDir),
        baselineRecordCommand(sessionDir, workspace),
        baselineVerifyCommand(sessionDir),
      ]
      for (const command of commands) {
        const result = await call(harness, 'bash', { command }, controller)
        expect(result.isError, JSON.stringify(result.content)).toBe(false)
      }
      const events = controller.session.events.filter(event =>
        event.type.startsWith('kersor/baseline-'))
      expect(events.map(event => event.type)).toEqual([
        'kersor/baseline-initialized',
        'kersor/baseline-recorded',
        'kersor/baseline-verified',
      ])
      const receiptNames = [
        'baseline-initialization-receipt.json',
        'baseline-recording-receipt.json',
        'baseline-verification-receipt.json',
      ] as const
      for (const [index, receiptName] of receiptNames.entries()) {
        const receiptPath = join(sessionDir, receiptName)
        expect(existsSync(receiptPath)).toBe(true)
        expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toEqual(events[index]!.data)
      }
      const initializationReceiptPath = join(
        sessionDir, 'baseline-initialization-receipt.json',
      )
      const recordingReceiptPath = join(sessionDir, 'baseline-recording-receipt.json')
      expect(events[0]!.data).toMatchObject({
        authority: 'dsh_host',
        launch: launchContract,
      })
      expect(events[1]?.data).toMatchObject({
        authority: 'dsh_host',
        workspace: realpathSync(workspace),
        session_dir: sessionDir,
        controller_session_id: controller.id,
        launch: launchContract,
        session_config: {
          path: join(sessionDir, 'session-config.json'),
          sha256: fileSha256(join(sessionDir, 'session-config.json')),
        },
        task_dir: realpathSync(workspace),
        kernel: { path: realpathSync(join(workspace, 'kernel.py')) },
        test_method: { path: methodPath, sha256: fileSha256(methodPath) },
        initialization_receipt: {
          path: initializationReceiptPath,
          sha256: fileSha256(initializationReceiptPath),
        },
        witness: { path: witnessPath, sha256: fileSha256(witnessPath) },
        commands: {
          correctness: launchContract.correctness_command,
          benchmark: launchContract.benchmark_command,
        },
        executions: [
          { kind: 'correctness', exit_code: 0, timed_out: false },
          { kind: 'benchmark', exit_code: 1, timed_out: false },
        ],
      })
      expect(events[2]!.data).toMatchObject({
        authority: 'dsh_host',
        launch: launchContract,
        recording_receipt: {
          path: recordingReceiptPath,
          sha256: fileSha256(recordingReceiptPath),
        },
      })
      for (const command of commands) {
        const retry = await call(harness, 'bash', { command }, controller)
        expect(retry.isError).toBe(true)
        expect(promptText(retry.content)).toContain('exact-once')
      }
      expect(calls).toHaveLength(3)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.each([
    {
      name: 'legacy shell schema',
      mutate: (execution: Record<string, unknown>) => {
        delete execution.execution_mode
        delete execution.argv
        delete execution.cwd
        execution.shell = '/bin/sh'
      },
    },
    {
      name: 'wrong execution mode',
      mutate: (execution: Record<string, unknown>) => {
        execution.execution_mode = 'shell'
      },
    },
    {
      name: 'non-authority cwd',
      mutate: (execution: Record<string, unknown>) => {
        execution.cwd = '/tmp'
      },
    },
    {
      name: 'empty argv',
      mutate: (execution: Record<string, unknown>) => {
        execution.argv = []
      },
    },
    {
      name: 'non-string argv member',
      mutate: (execution: Record<string, unknown>) => {
        execution.argv = [realpathSync.native(testKersorPython), 1]
      },
    },
    {
      name: 'relative argv executable',
      mutate: (execution: Record<string, unknown>) => {
        execution.argv = ['python3']
      },
    },
    {
      name: 'extra execution field',
      mutate: (execution: Record<string, unknown>) => {
        execution.extra = true
      },
    },
  ])('rejects baseline witness $name', async ({ mutate }) => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-baseline-execution-schema-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      writeFileSync(join(workspace, 'kernel.py'), 'VALUE = 1\n')
      const sessionDir = dirname(makeRunDirectory(workspace))
      writeValidBaselineAuthority(sessionDir, workspace)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      const methodPath = join(sessionDir, 'test-method.md')
      const witnessPath = join(sessionDir, 'baseline-witness.json')
      const methodBytes = readFileSync(methodPath, 'utf8')
      const witness = readJsonFixture(witnessPath) as BaselineWitnessFixture
      mutate(witness.executions[0]!)
      rmSync(methodPath)
      rmSync(witnessPath)
      harness.ctx.tools.register(defineTool({
        name: 'bash',
        description: 'Run one invalid baseline execution evidence probe.',
        parameters: { command: { type: 'string', required: true } },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        execute: (args) => {
          if (args.command.includes('baseline-witness.py" init ')) {
            writeFileSync(methodPath, methodBytes)
          } else if (args.command.includes('baseline-witness.py" record ')) {
            writeFileSync(witnessPath, JSON.stringify(witness))
          }
          return Promise.resolve(args.command)
        },
      }))

      const initialized = await call(harness, 'bash', {
        command: baselineInitCommand(sessionDir),
      }, controller)
      expect(initialized.isError, JSON.stringify(initialized.content)).toBe(false)
      const recorded = await call(harness, 'bash', {
        command: baselineRecordCommand(sessionDir, workspace),
      }, controller)

      expect(recorded.isError).toBe(true)
      expect(promptText(recorded.content)).toContain(
        'baseline correctness execution evidence is invalid',
      )
      expect(controller.session.events.some(event =>
        event.type === 'kersor/baseline-recorded')).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('denies canonical baseline custody when Session config differs from typed launch', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-baseline-launch-mismatch-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      writeFileSync(join(workspace, 'kernel.py'), 'VALUE = 1\n')
      const runDir = makeRunDirectory(workspace)
      const sessionDir = dirname(realpathSync(runDir))
      writeValidBaselineAuthority(sessionDir, workspace)
      ensureSessionInitializationFixture(sessionDir, workspace, controller)
      const configPath = join(sessionDir, 'session-config.json')
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
      config.max_workflows = launchContract.max_workflows + 1
      writeFileSync(configPath, JSON.stringify(config))
      const probeCalls: string[] = []
      registerBashProbe(harness, probeCalls)

      const result = await call(harness, 'bash', {
        command: baselineInitCommand(sessionDir),
      }, controller)

      expect(result.isError).toBe(true)
      expect(promptText(result.content)).toMatch(
        /typed launch|Session config|immutable config.*identity/i,
      )
      expect(probeCalls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('denies baseline command redirection and controller/descendant evidence mutation', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-baseline-denial-'))
    const alternate = mkdtempSync(join(tmpdir(), 'dsh-kersor-baseline-alternate-'))
    try {
      const harness = await setup(workspace)
      const controller = await startController(harness)
      const descendant = descendantAgent(harness, controller.session, 'baseline-descendant')
      writeFileSync(join(workspace, 'kernel.py'), 'VALUE = 1\n')
      const runDir = makeRunDirectory(workspace)
      const sessionDir = dirname(realpathSync(runDir))
      writeValidBaselineAuthority(sessionDir, workspace)
      const fileCalls: string[] = []
      const bashCalls: string[] = []
      registerFileProbe(harness, 'write', fileCalls)
      registerFileProbe(harness, 'edit', fileCalls)
      registerBashProbe(harness, bashCalls)
      for (const redirected of [
        baselineInitCommand(alternate),
        baselineRecordCommand(sessionDir, alternate),
        baselineVerifyCommand(alternate),
      ]) {
        expect((await call(harness, 'bash', { command: redirected }, controller)).isError)
          .toBe(true)
      }
      for (const agent of [controller, descendant]) {
        for (const path of [
          join(sessionDir, 'session-config.json'),
          join(sessionDir, 'test-method.md'),
          join(sessionDir, 'baseline-witness.json'),
        ]) {
          for (const name of ['write', 'edit'] as const) {
            expect((await call(harness, name, { file_path: path }, agent)).isError)
              .toBe(true)
          }
          expect((await call(harness, 'bash', {
            command: `cp /tmp/forged-baseline '${path}'`,
          }, agent)).isError).toBe(true)
        }
      }
      expect((await call(harness, 'bash', {
        command: baselineInitCommand(sessionDir),
      }, descendant)).isError).toBe(true)
      expect(fileCalls).toEqual([])
      expect(bashCalls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(alternate, { recursive: true, force: true })
    }
  })

  it('denies a direct native workflow call even when its envelope arguments are exact', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-native-workflow-denial-'))
    try {
      const calls: string[] = []
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, {
        runId: 'workflow-direct-denied', agentsStarted: 1, result: { best_kernel_code: 'bypass' },
      }, calls)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      writeWorkflowEnvelope(runDir, controller)

      const result = await call(harness, 'workflow', workflowArguments(runDir), controller)

      expect(result.isError).toBe(true)
      expect(result.content.some(block => block.type === 'text'
        && block.text.includes('must dispatch through kersor_workflow'))).toBe(true)
      expect(calls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects an adapter-rewritten source that no longer matches the same-round selection and catalog', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-source-binding-'))
    try {
      const calls: string[] = []
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, {
        runId: 'workflow-source-binding', agentsStarted: 1, result: { best_kernel_code: 'bypass' },
      }, calls)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      writeWorkflowEnvelope(runDir, controller)

      const envelopePath = join(runDir, 'dsh-workflow.json')
      const compatibilityPath = join(runDir, 'dsh-compatibility.json')
      const envelope = readJsonFixture(envelopePath) as MutableWorkflowEnvelope
      const compatibility = readJsonFixture(compatibilityPath) as MutableCompatibility
      const rewrittenPath = join(dirname(envelope.source.workflow_path), 'workflow-dsh.js')
      const rewrittenSource = `${workflowSource}\n// controller-authored retry adapter`
      const rewrittenHash = sha256(rewrittenSource)
      writeFileSync(rewrittenPath, rewrittenSource)
      envelope.source.workflow_path = rewrittenPath
      envelope.source.workflow_sha256 = rewrittenHash
      compatibility.workflow_source = rewrittenPath
      compatibility.workflow_sha256 = rewrittenHash
      writeFileSync(envelopePath, JSON.stringify(envelope))
      writeFileSync(compatibilityPath, JSON.stringify(compatibility))

      const result = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)

      expect(result.isError).toBe(true)
      expect(result.content.some(block => block.type === 'text'
        && block.text.includes('round-1-selection.json'))).toBe(true)
      expect(calls).toEqual([])
      expect(existsSync(join(runDir, 'output.json'))).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('fails closed when dsh-compatibility.json does not carry a passing verdict', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-compatibility-verdict-'))
    try {
      const calls: string[] = []
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, {
        runId: 'workflow-compatibility-verdict', agentsStarted: 1, result: { best_kernel_code: 'bypass' },
      }, calls)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      writeWorkflowEnvelope(runDir, controller)
      const compatibilityPath = join(runDir, 'dsh-compatibility.json')
      const compatibility = JSON.parse(readFileSync(compatibilityPath, 'utf8')) as Record<string, unknown>
      compatibility.verdict = 'fail'
      compatibility.errors = ['native meta rejected']
      writeFileSync(compatibilityPath, JSON.stringify(compatibility))

      const result = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)

      expect(result.isError).toBe(true)
      expect(result.content.some(block => block.type === 'text'
        && block.text.includes('dsh-compatibility.json verdict must be pass'))).toBe(true)
      expect(calls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects a jointly rewritten effective script and compatibility hash', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-effective-script-binding-'))
    try {
      const calls: string[] = []
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, {
        runId: 'workflow-effective-script', agentsStarted: 1, result: { best_kernel_code: 'bypass' },
      }, calls)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      writeWorkflowEnvelope(runDir, controller)
      const envelopePath = join(runDir, 'dsh-workflow.json')
      const compatibilityPath = join(runDir, 'dsh-compatibility.json')
      const envelope = readJsonFixture(envelopePath) as MutableWorkflowEnvelope
      const compatibility = readJsonFixture(compatibilityPath) as MutableCompatibility
      envelope.script = "return { best_kernel_code: 'controller-rewritten' }"
      const rewrittenHash = sha256(envelope.script)
      envelope.source.effective_script_sha256 = rewrittenHash
      compatibility.effective_script_sha256 = rewrittenHash
      writeFileSync(envelopePath, JSON.stringify(envelope))
      writeFileSync(compatibilityPath, JSON.stringify(compatibility))

      const result = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)

      expect(result.isError).toBe(true)
      expect(result.content.some(block => block.type === 'text'
        && block.text.includes('does not derive from the selected canonical Workflow source'))).toBe(true)
      expect(calls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects jointly rewritten projected meta even when its reported hash is updated', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-meta-projection-binding-'))
    try {
      const calls: string[] = []
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, {
        runId: 'workflow-meta-projection', agentsStarted: 1, result: { best_kernel_code: 'bypass' },
      }, calls)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      writeWorkflowEnvelope(runDir, controller)
      const envelopePath = join(runDir, 'dsh-workflow.json')
      const compatibilityPath = join(runDir, 'dsh-compatibility.json')
      const envelope = readJsonFixture(envelopePath) as MutableWorkflowEnvelope
      const compatibility = readJsonFixture(compatibilityPath) as MutableCompatibility
      envelope.meta.description = 'Controller-forged description.'
      const firstPhase = envelope.meta.phases[0]
      if (firstPhase === undefined) throw new Error('workflow fixture lacks its first phase')
      firstPhase.provider = 'controller-forged-provider'
      const forgedHash = sha256(JSON.stringify(envelope.meta))
      envelope.source.projected_meta_sha256 = forgedHash
      compatibility.projected_meta_sha256 = forgedHash
      writeFileSync(envelopePath, JSON.stringify(envelope))
      writeFileSync(compatibilityPath, JSON.stringify(compatibility))

      const result = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)

      expect(result.isError).toBe(true)
      expect(result.content.some(block => block.type === 'text'
        && block.text.includes('meta does not equal the Host projection'))).toBe(true)
      expect(calls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('requires the exact inherited-model and read-only child tool policies', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-policy-binding-'))
    try {
      const calls: string[] = []
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, {
        runId: 'workflow-policy', agentsStarted: 1, result: { best_kernel_code: 'bypass' },
      }, calls)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      writeWorkflowEnvelope(runDir, controller)
      const envelopePath = join(runDir, 'dsh-workflow.json')
      const compatibilityPath = join(runDir, 'dsh-compatibility.json')
      const envelope = readJsonFixture(envelopePath) as MutableWorkflowEnvelope
      const compatibility = readJsonFixture(compatibilityPath) as MutableCompatibility
      envelope.source.model_policy = compatibility.model_policy = 'controller-selected-model'
      envelope.source.child_tool_policy.tools = ['glob', 'grep', 'read', 'bash']
      compatibility.child_tool_policy.tools = ['glob', 'grep', 'read', 'bash']
      writeFileSync(envelopePath, JSON.stringify(envelope))
      writeFileSync(compatibilityPath, JSON.stringify(compatibility))

      const result = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)

      expect(result.isError).toBe(true)
      expect(result.content.some(block => block.type === 'text'
        && block.text.includes('exact read-only child tool allowlist'))).toBe(true)
      expect(calls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('permanently consumes the run on the first kersor_workflow call even when native Workflow errors', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-workflow-once-'))
    try {
      const calls: string[] = []
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, new Error('native meta rejected'), calls)
      const controller = await startController(harness)
      const runDir = makeRunDirectory(workspace)
      writeWorkflowEnvelope(runDir, controller)

      const first = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)
      expect(first.isError).toBe(true)
      const receiptPath = join(runDir, 'workflow-call-receipt.json')
      expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).toMatchObject({
        schema_version: 1,
        contract: 'kersor_workflow_call_v1',
      })

      rmSync(receiptPath)
      writeWorkflowEnvelope(runDir, controller)
      const retry = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)

      expect(retry.isError).toBe(true)
      expect(retry.content.some(block => block.type === 'text'
        && block.text.includes('already consumed'))).toBe(true)
      expect(calls).toEqual(['workflow'])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('rejects a replayed run from the durable controller call tombstone after receipt deletion', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-workflow-receipt-'))
    try {
      const runDir = makeRunDirectory(workspace)
      const firstHarness = await setup(workspace)
      registerWorkflowProbe(firstHarness, new Error('native cancelled'))
      const firstController = await startController(firstHarness)
      writeWorkflowEnvelope(runDir, firstController)
      expect((await call(
        firstHarness,
        'kersor_workflow',
        { exp_dir: runDir },
        firstController,
      )).isError).toBe(true)
      const historicCall = firstController.session.events.find(event =>
        event.type === 'tool/call' && event.data.name === 'kersor_workflow')
      expect(historicCall?.type).toBe('tool/call')
      rmSync(join(runDir, 'workflow-call-receipt.json'))

      const retryCalls: string[] = []
      const recreatedHarness = await setup(workspace)
      registerWorkflowProbe(recreatedHarness, {
        runId: 'workflow-retry', agentsStarted: 1, result: { best_kernel_code: 'bypass' },
      }, retryCalls)
      const recreatedController = await startController(recreatedHarness)
      if (historicCall?.type === 'tool/call') {
        recreatedController.session.append('tool/call', historicCall.data)
      }
      const retry = await call(
        recreatedHarness,
        'kersor_workflow',
        { exp_dir: runDir },
        recreatedController,
      )

      expect(retry.isError).toBe(true)
      expect(retry.content.some(block => block.type === 'text'
        && block.text.includes('earlier durable controller tool/call'))).toBe(true)
      expect(retryCalls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('denies missing, symlinked, and oversized dsh-workflow envelopes before execution', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-envelope-invalid-'))
    try {
      const calls: string[] = []
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, {
        runId: 'workflow-envelope-invalid', agentsStarted: 1, result: { best_kernel_code: 'no' },
      }, calls)
      const controller = await startController(harness)

      const missingRun = makeRunDirectory(workspace)
      const missing = await call(harness, 'kersor_workflow', { exp_dir: missingRun }, controller)
      expect(missing.isError).toBe(true)
      expect(missing.content.some(block => block.type === 'text'
        && block.text.includes('required Workflow envelope is missing'))).toBe(true)

      if (process.platform !== 'win32') {
        const symlinkRun = makeRunDirectory(workspace, 'run-2')
        const target = join(workspace, 'prepared-envelope.json')
        writeFileSync(target, JSON.stringify({
          schema_version: 1,
          contract: 'dsh_workflow_v1',
          ...workflowArguments(symlinkRun),
        }))
        symlinkSync(target, join(symlinkRun, 'dsh-workflow.json'))
        const symlink = await call(harness, 'kersor_workflow', { exp_dir: symlinkRun }, controller)
        expect(symlink.isError).toBe(true)
        expect(symlink.content.some(block => block.type === 'text'
          && block.text.includes('must not be a symlink'))).toBe(true)
      }

      const oversizedRun = makeRunDirectory(workspace, 'run-3')
      writeFileSync(join(oversizedRun, 'dsh-workflow.json'), 'x'.repeat(2 * 1024 * 1024 + 1))
      const oversized = await call(harness, 'kersor_workflow', { exp_dir: oversizedRun }, controller)
      expect(oversized.isError).toBe(true)
      expect(oversized.content.some(block => block.type === 'text'
        && block.text.includes('exceeds the 2097152-byte limit'))).toBe(true)
      expect(calls).toEqual([])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('atomically preserves a raw Workflow result beyond its rendered preview and denies overwrite', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-raw-output-'))
    try {
      const runDir = makeRunDirectory(workspace)
      const raw = {
        best_kernel_code: `kernel-start\n${'x'.repeat(120_000)}\nkernel-complete`,
        speedup: 8.25,
      }
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, { runId: 'workflow-raw', agentsStarted: 3, result: raw })
      const fileCalls: string[] = []
      registerFileProbe(harness, 'write', fileCalls)
      registerFileProbe(harness, 'edit', fileCalls)
      const bashCalls: string[] = []
      registerBashProbe(harness, bashCalls)
      const controller = await startController(harness)
      writeWorkflowEnvelope(runDir, controller)

      const result = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)
      expect(result.isError).toBe(false)
      expect(result.content.some(block => block.type === 'text'
        && block.text.includes('kernel-complete'))).toBe(false)
      const outputPath = join(runDir, 'output.json')
      expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual(raw)
      expect(readFileSync(outputPath, 'utf8')).toContain('kernel-complete')

      const write = await call(harness, 'write', { file_path: outputPath }, controller)
      const edit = await call(harness, 'edit', { file_path: outputPath }, controller)
      expect(write.isError).toBe(true)
      expect(edit.isError).toBe(true)
      expect(write.content.some(block => block.type === 'text'
        && block.text.includes('Host-owned'))).toBe(true)
      expect(fileCalls).toEqual([])
      expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual(raw)

      const pythonOverwrite = await call(harness, 'bash', {
        command: 'python -c "open(\'$RUN_DIR/output.json\',\'w\').write(\'truncated\')"',
      }, controller)
      const redirectOverwrite = await call(harness, 'bash', {
        command: `cat > '${outputPath}' <<'EOF'\ntruncated\nEOF`,
      }, controller)
      expect(pythonOverwrite.isError).toBe(true)
      expect(redirectOverwrite.isError).toBe(true)
      expect(pythonOverwrite.content.some(block => block.type === 'text'
        && block.text.includes('Python open/write'))).toBe(true)

      const catRead = `cat '${outputPath}'`
      const pythonRead = `python3 -c "print(open('${outputPath}').read())"`
      expect((await call(harness, 'bash', { command: catRead }, controller)).isError).toBe(false)
      expect((await call(harness, 'bash', { command: pythonRead }, controller)).isError).toBe(false)
      expect(bashCalls).toEqual([catRead, pythonRead])
      expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual(raw)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('blocks Workflow success for workspace escape, symlinked run, and existing output', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-custody-workspace-'))
    const outside = mkdtempSync(join(tmpdir(), 'dsh-kersor-custody-outside-'))
    try {
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, {
        runId: 'workflow-paths', agentsStarted: 1, result: { best_kernel_code: 'complete' },
      })
      const controller = await startController(harness)
      const outsideRun = makeRunDirectory(outside)
      writeWorkflowEnvelope(outsideRun, controller, workflowArguments(outsideRun), {
        appendBaselineCustody: false,
        appendProducerEvent: false,
        appendTransformation: false,
        writeCandidateSeal: false,
      })
      const outsideResult = await call(harness, 'kersor_workflow', { exp_dir: outsideRun }, controller)
      expect(outsideResult.isError).toBe(true)
      expect(outsideResult.content.some(block => block.type === 'text'
        && block.text.includes('must resolve exactly under'))).toBe(true)
      expect(existsSync(join(outsideRun, 'output.json'))).toBe(false)

      if (process.platform !== 'win32') {
        const symlinkTarget = join(outside, 'symlink-target')
        mkdirSync(symlinkTarget)
        const symlinkRun = join(workspace, '.kersor', '20260822-raw-custody', 'run-2')
        mkdirSync(join(workspace, '.kersor', '20260822-raw-custody'), { recursive: true })
        symlinkSync(symlinkTarget, symlinkRun, 'dir')
        writeWorkflowEnvelope(symlinkRun, controller, workflowArguments(symlinkRun), {
          appendBaselineCustody: false,
          appendProducerEvent: false,
          appendTransformation: false,
          writeCandidateSeal: false,
        })
        const symlinkResult = await call(harness, 'kersor_workflow', { exp_dir: symlinkRun }, controller)
        expect(symlinkResult.isError).toBe(true)
        expect(promptText(symlinkResult.content)).toContain(
          'workflow args.exp_dir must resolve exactly under',
        )
        expect(existsSync(join(symlinkTarget, 'output.json'))).toBe(false)
      }

      const existingRun = makeRunDirectory(workspace, 'run-3')
      const existingPath = join(existingRun, 'output.json')
      writeFileSync(existingPath, '{"failure":"existing"}\n')
      writeWorkflowEnvelope(existingRun, controller)
      const existingResult = await call(harness, 'kersor_workflow', { exp_dir: existingRun }, controller)
      expect(existingResult.isError).toBe(true)
      expect(existingResult.content.some(block => block.type === 'text'
        && block.text.includes('already exists and will not be overwritten'))).toBe(true)
      expect(readFileSync(existingPath, 'utf8')).toBe('{"failure":"existing"}\n')
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('blocks non-object and oversized raw Workflow results without creating output', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-custody-shape-'))
    try {
      const scalarRun = makeRunDirectory(workspace)
      const scalarHarness = await setup(workspace)
      registerWorkflowProbe(scalarHarness, {
        runId: 'workflow-scalar', agentsStarted: 1, result: 'truncated text',
      })
      const scalarController = await startController(scalarHarness)
      writeWorkflowEnvelope(scalarRun, scalarController)
      const scalar = await call(scalarHarness, 'kersor_workflow', { exp_dir: scalarRun }, scalarController)
      expect(scalar.isError).toBe(true)
      expect(scalar.content.some(block => block.type === 'text'
        && block.text.includes('result.value.result must be a JSON object'))).toBe(true)
      expect(existsSync(join(scalarRun, 'output.json'))).toBe(false)

      const largeRun = makeRunDirectory(workspace, 'run-2')
      const largeHarness = await setup(workspace)
      registerWorkflowProbe(largeHarness, {
        runId: 'workflow-large', agentsStarted: 1, result: { code: 'x'.repeat(4 * 1024 * 1024) },
      })
      const largeController = await startController(largeHarness)
      writeWorkflowEnvelope(largeRun, largeController)
      const large = await call(largeHarness, 'kersor_workflow', { exp_dir: largeRun }, largeController)
      expect(large.isError).toBe(true)
      expect(large.content.some(block => block.type === 'text'
        && block.text.includes('exceeding the 4194304-byte'))).toBe(true)
      expect(existsSync(join(largeRun, 'output.json'))).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('does not custody non-Experiment Workflow results', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-non-experiment-output-'))
    try {
      const runDir = makeRunDirectory(workspace)
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, {
        runId: 'workflow-ordinary', agentsStarted: 1, result: { best_kernel_code: 'ordinary' },
      })
      const result = await call(harness, 'workflow', workflowArguments(runDir))
      expect(result.isError).toBe(false)
      expect(existsSync(join(runDir, 'output.json'))).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('writes no Host output after Workflow error and permits one missing failure stub', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-kersor-failure-stub-'))
    try {
      const runDir = makeRunDirectory(workspace)
      const harness = await setup(workspace)
      registerWorkflowProbe(harness, new Error('workflow failed before a raw result'))
      const fileCalls: string[] = []
      registerFileProbe(harness, 'write', fileCalls)
      const controller = await startController(harness)
      writeWorkflowEnvelope(runDir, controller)
      const workflow = await call(harness, 'kersor_workflow', { exp_dir: runDir }, controller)
      expect(workflow.isError).toBe(true)
      const outputPath = join(runDir, 'output.json')
      expect(existsSync(outputPath)).toBe(false)

      const stub = await call(harness, 'write', { file_path: outputPath }, controller)
      expect(stub.isError).toBe(false)
      expect(fileCalls).toEqual([outputPath])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('projects kersor_status metadata into a flushed nine-stage checkpoint', async () => {
    const harness = await setup()
    await call(harness, 'kersor_start', { objective: 'Optimize', launch: launchContract })
    const childId = starts(harness.session)[0]!.data.childSessionId
    const childSession = harness.ctx.sessions.get(childId)!
    const child = { id: childId, session: childSession } as unknown as Agent
    harness.ctx.tools.register(defineTool({
      name: 'kersor_status',
      description: 'Return projected KerSor status for this test.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: () => [{ type: 'text', text: 'ok' }],
        presentationMeta: () => ({
          kind: 'kersor-status', found: true, session_dir: '/work/kernel/.kersor/20260821',
          phase: 'optimizing', current_round: 2, max_workflows: 4,
          workflow: 'bundle-pack', best_speedup: 3.5, target_speedup: 8,
          steps: [
            { id: 'setup', status: 'completed' },
            { id: 'baseline', status: 'completed' },
            { id: 'profile', status: 'completed' },
            { id: 'selection', status: 'completed' },
            { id: 'authoring', status: 'completed' },
            { id: 'validation', status: 'completed' },
            { id: 'dispatch', status: 'active' },
            { id: 'measurement', status: 'pending' },
            { id: 'decision', status: 'pending' },
          ],
        }),
      },
      execute: () => Promise.resolve({}),
    }))
    const result = await harness.ctx.tools.execute({
      callId: CallId('status-child'), name: 'kersor_status', arguments: {}, agent: child, signal,
    })
    expect(result.isError).toBe(false)
    const latest = checkpoints(harness.session).at(-1)?.data
    expect(latest).toMatchObject({
      revision: 2, status: 'running', kersorSessionId: '20260821', phase: 'optimizing',
      currentRound: 2, maxWorkflows: 4, workflow: 'bundle-pack', bestSpeedup: 3.5,
    })
    expect(latest?.steps).toContainEqual({ id: 'decision', status: 'pending' })
  })

  it('denies recursive controls and external product subagents inside the controller child', async () => {
    const harness = await setup()
    await call(harness, 'kersor_start', { objective: 'Optimize', launch: launchContract })
    const childId = starts(harness.session)[0]!.data.childSessionId
    const childSession = harness.ctx.sessions.get(childId)!
    const child = { id: childId, session: childSession } as unknown as Agent
    const recursive = await harness.ctx.tools.execute({
      callId: CallId('recursive'), name: 'kersor_resume', arguments: {}, agent: child, signal,
    })
    expect(recursive.isError).toBe(true)
    expect(recursive.content.some(block => block.type === 'text'
      && block.text.includes('cannot execute kersor_resume'))).toBe(true)
  })

  it('lets a running controller delegate, then denies every non-status tool after stalled', async () => {
    const harness = await setup()
    const calls: string[] = []
    registerProbe(harness, 'subagent', calls)
    registerProbe(harness, 'bash', calls)
    await call(harness, 'kersor_start', { objective: 'Optimize', launch: launchContract })
    const childId = starts(harness.session)[0]!.data.childSessionId
    const childSession = harness.ctx.sessions.get(childId)!
    const child = { id: childId, session: childSession } as unknown as Agent

    const delegated = await harness.ctx.tools.execute({
      callId: CallId('controller-delegates'), name: 'subagent', arguments: {}, agent: child, signal,
    })
    expect(delegated.isError).toBe(false)
    expect(calls).toEqual(['subagent'])

    harness.ctx.tools.register(defineTool({
      name: 'kersor_status',
      description: 'Return a stalled KerSor status for this test.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: () => [{ type: 'text', text: 'stalled' }],
        presentationMeta: () => ({
          kind: 'kersor-status', found: true, phase: 'stalled',
          session_dir: '/work/kernel/.kersor/stalled', steps: [],
        }),
      },
      execute: () => Promise.resolve({}),
    }))
    const status = await harness.ctx.tools.execute({
      callId: CallId('controller-stalled'), name: 'kersor_status', arguments: {}, agent: child, signal,
    })
    expect(status.isError).toBe(false)
    expect(status.concludesTurn).toBe(true)
    expect(checkpoints(harness.session).at(-1)?.data).toMatchObject({
      status: 'blocked', phase: 'stalled',
    })
    expect(checkpoints(harness.session).at(-1)?.data.nextAction).toBeUndefined()

    const repeatedStatus = await harness.ctx.tools.execute({
      callId: CallId('controller-stalled-again'), name: 'kersor_status', arguments: {}, agent: child, signal,
    })
    expect(repeatedStatus.isError).toBe(false)
    expect(repeatedStatus.concludesTurn).toBe(true)

    const subagent = await harness.ctx.tools.execute({
      callId: CallId('controller-subagent-after-stalled'), name: 'subagent', arguments: {}, agent: child, signal,
    })
    const bash = await harness.ctx.tools.execute({
      callId: CallId('controller-bash-after-stalled'), name: 'bash', arguments: {}, agent: child, signal,
    })
    expect(subagent.isError).toBe(true)
    expect(bash.isError).toBe(true)
    expect(calls).toEqual(['subagent'])
  })
})
