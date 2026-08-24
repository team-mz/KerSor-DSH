/**
 * Conversation-scoped KerSor controls. One tool reserves a durable
 * experiment-to-child binding before starting a continuable dsh child; the
 * other delivers a later turn to that same child or binds an existing KerSor
 * Session when the conversation has no binding yet.
 * @module @deepseek-ai/dsh-kersor/control
 */

import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants, type Dirent } from 'node:fs'
import { access, link, lstat, open, readdir, realpath, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import { createContext, Script } from 'node:vm'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue, Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tool-bash'
import {
  canonicalAuthorCommandKind,
  canonicalAuthorHandoffSealCommand,
  canonicalAuthorSaveCommand,
  hostCanonicalAuthorToolArguments,
} from './author-tool-commands.ts'
import type { CanonicalAuthorCommandKind, CanonicalAuthorCommands } from './author-tool-commands.ts'
import { hostNormalizableSetupArguments } from './setup-tool-arguments.ts'
import { canonicalKersorJson, parseKersorLaunchContract } from './types.ts'
import type {
  KersorBaselineExecutionEventData,
  KersorBaselineInitializedEventData,
  KersorBaselineRecordedEventData,
  KersorBaselineVerifiedEventData,
  KersorAuthorHandoffSealedEventData,
  KersorAuthorSaveAttemptedEventData,
  KersorCandidateOwnershipSealedEventData,
  KersorDispatchArgsProducedEventData,
  KersorDispatchArgsTransformedEventData,
  KersorExperimentCheckpointEventData,
  KersorExperimentId,
  KersorExperimentStartEventData,
  KersorExperimentStatus,
  KersorExperimentStep,
  KersorLaunchContract,
  KersorSessionAuthorityIntent,
  KersorSessionAuthorityTransferredEventData,
} from './types.ts'

const MAX_OBJECTIVE_CHARS = 4_000
const MAX_DSH_WORKFLOW_ENVELOPE_BYTES = 2 * 1024 * 1024
const MAX_DSH_WORKFLOW_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_DSH_COMPATIBILITY_BYTES = 512 * 1024
const MAX_DSH_DISPATCH_ARGS_BYTES = 1024 * 1024
const MAX_DSH_DISPATCH_RECEIPT_BYTES = 256 * 1024
const MAX_CANDIDATE_OWNERSHIP_SEAL_BYTES = 4 * 1024 * 1024
const MAX_SESSION_STATE_BYTES = 1024 * 1024
const MAX_BASELINE_AUTHORITY_BYTES = 16 * 1024 * 1024
const MAX_GIT_COMMAND_OUTPUT_BYTES = 128 * 1024 * 1024
const MAX_KERSOR_SELECTION_BYTES = 512 * 1024
const MAX_KERSOR_CATALOG_BYTES = 2 * 1024 * 1024
const MAX_KERSOR_PYTHON_BYTES = 128 * 1024 * 1024
const MAX_AUTHOR_HANDOFF_BYTES = 64 * 1024
const MAX_AUTHOR_FILE_BYTES = 2 * 1024 * 1024
const MAX_WORKFLOW_OUTPUT_BYTES = 4 * 1024 * 1024
const DSH_AGENT_BINDING_NAME = '__kersor_dsh_controller_agent_v1__'
const DSH_MODEL_POLICY = 'inherit_controller'
const DSH_ALLOWED_CHILD_TOOLS = Object.freeze(['glob', 'grep', 'read'])
const DSH_CHILD_TOOL_POLICY = Object.freeze({
  kind: 'allowlist',
  tools: DSH_ALLOWED_CHILD_TOOLS,
  enforcement: 'dsh_tool_filter',
  source: 'kersor_adapter_v1',
})
const DSH_META_CONTRACT = 'dsh_workflow_meta_v1'
const DSH_META_KEYS = Object.freeze([
  'description', 'name', 'phases', 'whenToUse', 'when_to_use',
])
const DSH_PHASE_KEYS = Object.freeze(['detail', 'model', 'provider', 'title'])
const DISPATCH_PRODUCER_DESCRIPTION = 'Synthesize dispatch args'
const DISPATCH_PRODUCER_MARKER = 'KERSOR_DISPATCH_ARG_SYNTHESIZER_V1'
const DISPATCH_PRODUCER_RECEIPT = 'dispatch-args-producer-receipt.json'
const DISPATCH_TRANSFORMATION_RECEIPT = 'dispatch-args-transformation-receipt.json'
const CANDIDATE_OWNERSHIP_SEAL = 'candidate-ownership-seal.json'
const CANDIDATE_OWNERSHIP_REPORT = 'candidate-ownership.json'
const BASELINE_INITIALIZATION_RECEIPT = 'baseline-initialization-receipt.json'
const BASELINE_RECORDING_RECEIPT = 'baseline-recording-receipt.json'
const BASELINE_VERIFICATION_RECEIPT = 'baseline-verification-receipt.json'
const SESSION_INITIALIZATION_RECEIPT = 'session-initialization-receipt.json'
const SESSION_AUTHORITY_TRANSFER_RECEIPT = 'session-authority-transfer-receipt.json'
const SESSION_AUTHORITY_IMPORT_RECEIPT = 'session-authority-import-receipt.json'
const AUTHOR_HANDOFF = 'author-handoff.json'
const AUTHOR_STAGING_FILES = Object.freeze(['workflow.js', 'metadata.json', 'rationale.md'] as const)
const BASELINE_AUTHORITY_ARTIFACTS = new Set([
  'session-config.json',
  'state.json',
  'workflow-catalog.json',
  'test-method.md',
  'baseline-witness.json',
  SESSION_INITIALIZATION_RECEIPT,
  SESSION_AUTHORITY_TRANSFER_RECEIPT,
  SESSION_AUTHORITY_IMPORT_RECEIPT,
  BASELINE_INITIALIZATION_RECEIPT,
  BASELINE_RECORDING_RECEIPT,
  BASELINE_VERIFICATION_RECEIPT,
])
const DISPATCH_ARTIFACTS = new Set([
  'dispatch-args.json',
  'dispatch-args-provenance.json',
  DISPATCH_PRODUCER_RECEIPT,
  DISPATCH_TRANSFORMATION_RECEIPT,
  CANDIDATE_OWNERSHIP_SEAL,
  CANDIDATE_OWNERSHIP_REPORT,
])
const PARENT_HANDOFF = 'The KerSor controller owns all further execution. End this parent turn immediately. Do not poll kersor_status or list_agents, call subagent, subagent_fork, workflow, or job tools, or read/search the workspace from the parent.'

type ExperimentClosure = 'blocked (stalled)' | 'completed' | 'cancelled'

interface ExperimentBinding {
  readonly start: KersorExperimentStartEventData
  readonly checkpoint?: KersorExperimentCheckpointEventData
  readonly closure?: ExperimentClosure
}

interface StartArgs {
  readonly objective: string
  readonly fresh_session?: boolean
  readonly launch: unknown
}

interface ResumeArgs {
  readonly experiment_id?: string
  readonly instruction?: string
}

interface AttachArgs {
  readonly experiment_id: string
  readonly launch: unknown
  readonly objective?: string
}

interface StartResult {
  readonly experimentId: KersorExperimentId
  readonly childSessionId: SessionId
  readonly action: 'started'
}

interface ResumeResult {
  readonly experimentId: KersorExperimentId
  readonly childSessionId: SessionId
  readonly action: 'resumed'
}

interface AttachResult {
  readonly experimentId: KersorExperimentId
  readonly childSessionId: SessionId
  readonly action: 'attached'
}

type CheckpointProjection = Omit<
  KersorExperimentCheckpointEventData,
  'experimentId' | 'childSessionId' | 'revision' | 'status'
>

/** Required host services: tools, durable sessions, and continuable subagents. */
export const name = 'kersor-control'
export const inject = ['tools', 'sessions', 'subagents']

function callLocation(session: Session, callId: string): { turn: number; step: number } {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event?.type === 'tool/call' && event.data.callId === callId) {
      return { turn: event.data.turn, step: event.data.step }
    }
  }
  throw new Error(`KerSor experiment control call ${callId} is not present in its dsh Session`)
}

function normalizedObjective(value: string): string {
  const objective = value.trim()
  if (objective.length === 0) throw new Error('KerSor experiment objective must not be empty')
  if (objective.length > MAX_OBJECTIVE_CHARS) {
    throw new Error(`KerSor experiment objective exceeds ${MAX_OBJECTIVE_CHARS} characters`)
  }
  return objective
}

async function frozenKersorPython(): Promise<string> {
  const configured = process.env.KERSOR_PYTHON
  if (configured === undefined || configured.trim().length === 0) {
    throw new Error('KERSOR_PYTHON must be a non-empty absolute path to the Host KerSor Python executable')
  }
  if (!isAbsolute(configured)) {
    throw new Error(`KERSOR_PYTHON must be an absolute path, received ${JSON.stringify(configured)}`)
  }
  try {
    const resolved = await realpath(configured)
    const metadata = await stat(resolved)
    if (!metadata.isFile()) {
      throw new Error('resolved path is not a file')
    }
    await access(resolved, constants.X_OK)
    return resolved
  } catch (cause) {
    throw new Error(
      `KERSOR_PYTHON ${JSON.stringify(configured)} must resolve to an executable file`,
      { cause },
    )
  }
}

async function frozenKersorRoot(): Promise<string> {
  const configured = process.env.KERSOR_ROOT
  if (configured !== undefined && configured.trim().length > 0) {
    if (!isAbsolute(configured)) throw new Error('KERSOR_ROOT must be an absolute path')
    const canonical = await realpath(configured)
    if (!(await stat(canonical)).isDirectory()) throw new Error('KERSOR_ROOT must name a directory')
    return canonical
  }
  const python = await frozenKersorPython()
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const bridge = await realpath(join(
    dshHome, '.agent-presets', 'kersor', 'bin', 'kersor_bridge.py',
  ))
  const output = await new Promise<Buffer>((resolveOutput, rejectOutput) => {
    const child = spawn(python, [bridge, 'root'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1024 * 1024) child.kill()
      else stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', rejectOutput)
    child.once('close', (code) => {
      if (code !== 0 || size > 1024 * 1024) {
        rejectOutput(new Error(
          `KerSor bridge root lookup failed: ${Buffer.concat(stderr).toString('utf8').trim() || `exit ${code}`}`,
        ))
      } else {
        resolveOutput(Buffer.concat(stdout))
      }
    })
  })
  const declared = output.toString('utf8').trim()
  if (!isAbsolute(declared)) throw new Error('KerSor bridge returned a non-absolute root')
  const canonical = await realpath(declared)
  if (canonical !== declared || !(await stat(canonical)).isDirectory()) {
    throw new Error('KerSor bridge returned a non-canonical root directory')
  }
  return canonical
}

function shellQuote(value: string): string {
  return `'${value.replaceAll('\'', '\'\\\'\'')}'`
}

function frozenPythonPrefix(kersorPython: string): string {
  return `KERSOR_PYTHON=${shellQuote(kersorPython)}; export KERSOR_PYTHON;`
}

function canonicalSessionSetupCommand(
  workspace: string,
  launch: KersorLaunchContract,
  freshSession: boolean,
  kersorPython: string,
  controllerSessionId: string,
): string {
  const flags = [
    '--runtime', 'dsh',
    '--target-speedup', String(launch.target_speedup),
    '--max-workflows', String(launch.max_workflows),
    '--mode', launch.mode,
    '--backend', launch.backend,
    '--language', launch.language,
    '--integration-pattern', launch.integration_pattern,
    '--retrieval-mode', launch.retrieval_mode,
    '--transfer-mode', launch.transfer_mode,
    '--experience-mode', launch.experience_mode,
    '--kernelwiki-experience-export-mode', launch.kernelwiki_experience_export_mode,
    '--workflow-authoring-budget', String(launch.workflow_authoring_budget),
    ...(launch.workflow_authoring_budget > 0 ? ['--allow-workflow-authoring'] : []),
    '--no-workflow-evolution',
    '--no-yolo',
    '--acceptance-gate', 'enforced',
    '--regime-regression-policy', 'enforced',
    '--note', '',
    ...(freshSession ? ['--fresh-session'] : []),
  ]
  return [
    frozenPythonPrefix(kersorPython),
    `CLAUDE_SESSION_ID=${shellQuote(controllerSessionId)}; CLAUDE_CODE_SESSION_ID=${shellQuote(controllerSessionId)}; export CLAUDE_SESSION_ID CLAUDE_CODE_SESSION_ID;`,
    `KERSOR_SESSION_ROOT=${shellQuote(join(workspace, '.kersor'))}; export KERSOR_SESSION_ROOT;`,
    'bridge="${DSH_HOME:-$HOME/.dsh}/.agent-presets/kersor/bin/kersor_bridge.py";',
    'kersor_root="$("$KERSOR_PYTHON" "$bridge" root)";',
    'bash "$kersor_root/scripts/setup-session.sh"',
    shellQuote(workspace),
    ...flags.map(shellQuote),
  ].join(' ')
}

function frozenPythonPrompt(kersorPython: string): string[] {
  const prefix = frozenPythonPrefix(kersorPython)
  return [
    `The Host-frozen KerSor Python executable is ${JSON.stringify(kersorPython)}.`,
    `Every shell command that touches the KerSor bridge, any KerSor helper, or setup-session.sh must begin with exactly ${prefix} When Python is invoked after that prefix, invoke it only as "$KERSOR_PYTHON".`,
    'Never use which, command -v, PATH lookup, a filesystem search, python, python3, or a versioned Python name to discover or substitute another interpreter.',
  ]
}

function typedLaunchPrompt(launch: KersorLaunchContract | undefined): string[] {
  if (launch === undefined) return []
  return [
    `Typed launch contract (canonical JSON): ${JSON.stringify(launch)}`,
    'This immutable typed launch contract is authoritative and overrides conflicting objective or continuation prose. Runtime is always dsh and is intentionally not a launch field.',
    `backend = ${JSON.stringify(launch.backend)} (use verbatim).`,
    `language = ${JSON.stringify(launch.language)} (use verbatim).`,
    `integration_pattern = ${JSON.stringify(launch.integration_pattern)} (use verbatim).`,
    `target_speedup = ${launch.target_speedup} (JSON number only; never append x, %, or another suffix).`,
    `max_workflows = ${launch.max_workflows} (positive integer).`,
    `mode = ${JSON.stringify(launch.mode)}.`,
    `workflow_authoring_budget = ${launch.workflow_authoring_budget} (nonnegative integer).`,
    `retrieval_mode = ${JSON.stringify(launch.retrieval_mode)}.`,
    `transfer_mode = ${JSON.stringify(launch.transfer_mode)}.`,
    `experience_mode = ${JSON.stringify(launch.experience_mode)}.`,
    `kernelwiki_experience_export_mode = ${JSON.stringify(launch.kernelwiki_experience_export_mode)}.`,
    `correctness_command = ${JSON.stringify(launch.correctness_command)} (copy and execute verbatim; do not rewrite, prepend, or append text).`,
    `benchmark_command = ${JSON.stringify(launch.benchmark_command)} (copy and execute verbatim; do not rewrite, prepend, or append text).`,
  ]
}

function effectiveLaunch(
  launch: KersorLaunchContract,
  freshSession: boolean,
): KersorLaunchContract {
  return freshSession
    ? {
      ...launch,
      retrieval_mode: 'off',
      transfer_mode: 'off',
      experience_mode: 'off',
      kernelwiki_experience_export_mode: 'off',
    }
    : launch
}

function workflowCustodyPrompt(): string[] {
  return [
    'A round selection whose selected_workflow.name is STALLED is a recoverable routing gap, not a canonical terminal phase.',
    'When Workflow authoring is enabled and saved-Proposal budget remains, complete Phase 3.6 and the full same-round selection sequence (select, strategy decision when required, finalize), then dispatch any non-STALLED commit before synthesizing a terminal STALLED decision.',
    'Dispatch the selected run only with kersor_workflow({exp_dir: <exact absolute run-N directory>}). The Host reads and validates dsh-workflow.json and invokes the native DSH Workflow with its exact meta/script/args; never call workflow directly or reconstruct, normalize, summarize, hash-check, extract, or retype that envelope.',
    'The first kersor_workflow call permanently consumes that run before envelope validation or native execution. Its durable controller tool/call tombstone and Host receipt forbid deletion/rebuild retries after any error or cancellation.',
    'For every successful workflow call, pass the exact absolute KerSor run directory as args.exp_dir. Before the result is shown, the Host atomically writes the complete raw workflow result object to that run\'s output.json.',
    'Treat an existing run-N/output.json as Host-owned and read-only: read it after workflow success and never call write or edit on it. The rendered workflow result may be truncated, but output.json is not.',
    'If a workflow call fails, the Host writes no output.json; only then may you use write once to create a missing failure stub. Once output.json exists it cannot be overwritten or edited.',
    'The foreground session-synthesizer is the sole writer of round-N-summary.md and round-N-transfer.json. If it fails or either file is missing, end this controller turn at the unchanged canonical round and resume later; never write, edit, reconstruct, or repair either artifact in the controller.',
    `For Gate B, the direct controller may never write, edit, or shell-mutate dispatch-args.json, dispatch-args-provenance.json, or either Host receipt. Invoke exactly one foreground subagent with description ${JSON.stringify(DISPATCH_PRODUCER_DESCRIPTION)}, run_in_background=false, and a prompt beginning with four lines: ${DISPATCH_PRODUCER_MARKER}, SESSION_DIR=<exact absolute Session>, RUN_DIR=<exact absolute run-N>, WORKFLOW_NAME=<selected name>. That child must read and follow agents/dispatch-arg-synthesizer.md and use write exactly once for each semantic output. A failed call consumes the run; never manufacture or repair its receipts.`,
    'After the Host producer receipt exists, its successful tool result adds one KERSOR_DISPATCH_TRANSFORM_COMMAND_V1 context bound to the durable run_dir and producer_call_id. Copy that returned command verbatim as the next Bash call. Do not add flags, variables, redirections, prefixes, or suffixes; do not inspect the injector, probe alternate syntax, or retry after any rejection or failure. The Host authorizes only that deterministic post-pass, compares its current hashes to the producer input, and mints the transformation receipt. No other post-producer mutation is allowed; cost reductions or user-supplied corrections require a fresh run/round rather than controller patching.',
    'After DSH preparation succeeds, run candidate-ownership.py seal exactly once through the documented Host-frozen canonical Bash command. The Host independently rechecks the Session config, passing baseline witness, protected files, complete worktree, and dispatch package before durably binding the seal bytes and call identity. The controller and every descendant are forbidden from creating, editing, redirecting, replacing, or repairing candidate-ownership-seal.json.',
    'Never call kersor-state.sh set current_round or kersor-state.sh advance. Only the deterministic normalize-transfer.py gate may commit a DSH CONTINUE round boundary.',
    'For an exact COMPLETE decision, normalize-transfer.py runs KerSor\'s deterministic acceptance rule gate: branch only on PHASE_COMMITTED=complete, advanced, or stalled. A prose COMPLETE while canonical phase remains optimizing is not terminal.',
    'Never manually transition the Session to stalled to compensate for a failed synthesizer, a missing transfer object, or a repeated Workflow that remains selected. Preserve the evidence and stop at the unchanged recoverable boundary.',
  ]
}

interface SealedWorkflowArgs {
  readonly exp_dir: string
}

function experimentBindings(events: readonly SessionEvent[]): ExperimentBinding[] {
  const ordered: ExperimentBinding[] = []
  const byId = new Map<string, number>()
  for (const event of events) {
    if (event.type === 'kersor/experiment-start') {
      const id = String(event.data.experimentId)
      if (byId.has(id)) continue
      byId.set(id, ordered.length)
      ordered.push({ start: event.data })
      continue
    }
    if (event.type !== 'kersor/experiment-checkpoint') continue
    const index = byId.get(String(event.data.experimentId))
    if (index === undefined) continue
    const binding = ordered[index]
    if (binding === undefined || binding.start.childSessionId !== event.data.childSessionId) continue
    // A stalled checkpoint was historically written as `waiting`; preserve the
    // first closed boundary and ignore the invalid parent-authored reopen tail.
    if (binding.closure !== undefined) continue
    const closure = experimentClosure(event.data)
    ordered[index] = {
      ...binding,
      checkpoint: event.data,
      ...(closure === undefined ? {} : { closure }),
    }
  }
  return ordered
}

function experimentClosure(checkpoint: KersorExperimentCheckpointEventData): ExperimentClosure | undefined {
  if (checkpoint.phase === 'stalled' || checkpoint.status === 'blocked') return 'blocked (stalled)'
  if (checkpoint.status === 'completed' || checkpoint.status === 'cancelled') return checkpoint.status
  return undefined
}

function latestOpenBinding(session: Session): ExperimentBinding | undefined {
  const bindings = experimentBindings(session.events)
  return bindings.findLast(binding => binding.closure === undefined)
}

function resumeBinding(session: Session, requested?: string): ExperimentBinding | undefined {
  const bindings = experimentBindings(session.events)
  return requested === undefined
    ? bindings.at(-1)
    : bindings.find(binding => binding.start.experimentId === requested)
}

async function checkpoint(
  ctx: Context,
  session: Session,
  start: KersorExperimentStartEventData,
  status: KersorExperimentStatus,
  nextAction?: string | null,
  projection: Partial<CheckpointProjection> = {},
): Promise<void> {
  const previous = experimentBindings(session.events)
    .find(binding => binding.start.experimentId === start.experimentId)
    ?.checkpoint
  const candidate: Omit<KersorExperimentCheckpointEventData, 'revision'> = {
    experimentId: start.experimentId,
    childSessionId: start.childSessionId,
    status,
    ...previous?.kersorSessionId === undefined ? {} : { kersorSessionId: previous.kersorSessionId },
    ...previous?.phase === undefined ? {} : { phase: previous.phase },
    ...previous?.currentRound === undefined ? {} : { currentRound: previous.currentRound },
    ...previous?.maxWorkflows === undefined ? {} : { maxWorkflows: previous.maxWorkflows },
    ...previous?.workflow === undefined ? {} : { workflow: previous.workflow },
    ...previous?.bestSpeedup === undefined ? {} : { bestSpeedup: previous.bestSpeedup },
    ...previous?.targetSpeedup === undefined ? {} : { targetSpeedup: previous.targetSpeedup },
    ...(nextAction === null
      ? {}
      : nextAction === undefined
        ? previous?.nextAction === undefined ? {} : { nextAction: previous.nextAction }
        : { nextAction }),
    steps: previous?.steps ?? [],
    ...projection,
  }
  if (previous !== undefined) {
    const { revision: _revision, ...priorProjection } = previous
    if (JSON.stringify(priorProjection) === JSON.stringify(candidate)) return
  }
  session.append('kersor/experiment-checkpoint', {
    ...candidate,
    revision: (previous?.revision ?? 0) + 1,
  })
  await ctx.sessions.flush(session)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function gateStatus(value: unknown): KersorExperimentStep['status'] {
  if (value === 'pass' || value === 'not_required') return 'completed'
  if (value === 'fail') return 'failed'
  return 'pending'
}

function milestoneSteps(value: Record<string, unknown>): KersorExperimentStep[] {
  if (Array.isArray(value.steps)) {
    const projected = value.steps.flatMap((candidate): KersorExperimentStep[] => {
      const step = record(candidate)
      const id = optionalString(step?.id)
      const status = step?.status
      if (id === undefined || (status !== 'pending' && status !== 'active'
        && status !== 'completed' && status !== 'failed')) return []
      return [{ id, status }]
    })
    if (projected.length > 0) return projected
  }
  return [
    { id: 'baseline', status: gateStatus(value.baseline_witness) },
    { id: 'profile', status: gateStatus(value.profile_evidence) },
    { id: 'workflow', status: gateStatus(value.dsh_compatibility) },
    { id: 'ownership', status: gateStatus(value.candidate_ownership) },
  ]
}

function experimentStatus(phase: unknown): KersorExperimentStatus {
  if (phase === 'complete' || phase === 'single_run') return 'completed'
  if (phase === 'stalled') return 'blocked'
  if (phase === 'cancelled') return 'cancelled'
  return 'running'
}

function terminalProjection(status: KersorExperimentStatus): boolean {
  return status === 'blocked' || status === 'completed' || status === 'cancelled'
}

function statusProjection(meta: unknown): {
  readonly status: KersorExperimentStatus
  readonly nextAction: string | null
  readonly projection: Partial<CheckpointProjection>
} | undefined {
  const value = record(meta)
  if (value === undefined || value.kind !== 'kersor-status' || typeof value.found !== 'boolean') return undefined
  const phase = optionalString(value.phase)
  const sessionDir = optionalString(value.session_dir)
  const baselineAction = optionalString(value.baseline_next_action)
  const blocker = optionalString(value.baseline_reason) ?? optionalString(value.profile_reason)
  const workflow = optionalString(value.workflow)
  const bestSpeedup = optionalNumber(value.best_speedup)
  const targetSpeedup = optionalNumber(value.target_speedup)
  return {
    status: experimentStatus(phase),
    nextAction: baselineAction !== undefined
      ? `Baseline: ${baselineAction}`
      : blocker !== undefined
        ? blocker
        : phase === 'stalled' || phase === 'complete' || phase === 'single_run' || phase === 'cancelled'
          ? null
          : 'Continue in the bound dsh execution conversation.',
    projection: {
      ...(sessionDir === undefined
        ? {}
        : { kersorSessionId: sessionDir.replaceAll('\\', '/').split('/').at(-1) as string }),
      ...(phase === undefined ? {} : { phase }),
      ...(Number.isInteger(value.current_round) ? { currentRound: value.current_round as number } : {}),
      ...(Number.isInteger(value.max_workflows) ? { maxWorkflows: value.max_workflows as number } : {}),
      ...(workflow === undefined ? {} : { workflow }),
      ...(bestSpeedup === undefined ? {} : { bestSpeedup }),
      ...(targetSpeedup === undefined ? {} : { targetSpeedup }),
      steps: milestoneSteps(value),
    },
  }
}

function startPrompt(
  start: KersorExperimentStartEventData,
  workspace: string,
  kersorPython: string,
): string {
  return [
    `You are the dsh-owned controller for KerSor experiment ${start.experimentId}.`,
    `Work only in the current workspace ${workspace}.`,
    ...frozenPythonPrompt(kersorPython),
    'Load the installed kersor skill before acting, then call kersor_status with an empty object.',
    'Start one KerSor optimization through the current optimize protocol.',
    'Use the explicit KerSor runtime dsh. Never select, invoke, or fall back to Claude or Codex.',
    start.freshSession ? 'Require a fresh KerSor Session and preserve all fresh-session gates.' : '',
    `Objective: ${start.objective}`,
    ...typedLaunchPrompt(start.launch),
    `Initialize the DSH KerSor Session exactly once with this Host-authorized command and no edits, reordered flags, substitutions, or retries: ${canonicalSessionSetupCommand(resolve(workspace), start.launch, start.freshSession, kersorPython, start.childSessionId)}`,
    ...workflowCustodyPrompt(),
    'Continue until the canonical KerSor phase is terminal or a genuine user decision is required.',
    'Call kersor_status after each major phase transition so the owning conversation receives durable progress.',
    'Do not call kersor_start or kersor_resume from this child.',
  ].filter(Boolean).join('\n')
}

function resumePrompt(
  binding: ExperimentBinding,
  workspace: string,
  kersorPython: string,
  instruction?: string,
): string {
  const extra = instruction?.trim()
  return [
    `Continue KerSor experiment ${binding.start.experimentId} in workspace ${workspace}.`,
    ...frozenPythonPrompt(kersorPython),
    ...typedLaunchPrompt(binding.start.launch),
    ...workflowCustodyPrompt(),
    'Load the installed kersor skill and call kersor_status first.',
    'Resume the same canonical KerSor Session. Do not create a new Session and do not repeat a completed dispatch.',
    'Use the explicit KerSor runtime dsh. Never select, invoke, or fall back to Claude or Codex.',
    'Continue from the on-disk next action until terminal state or a genuine user decision is required.',
    'Call kersor_status after each major phase transition.',
    extra === undefined || extra.length === 0 ? '' : `Additional user instruction: ${extra}`,
  ].filter(Boolean).join('\n')
}

async function materialize(
  ctx: Context,
  parent: Agent,
  start: KersorExperimentStartEventData,
  prompt: string,
  signal: AbortSignal,
): Promise<void> {
  const children = await ctx.subagents.listChildren(parent.id, signal)
  const existing = children.find(child => child.id === start.childSessionId)
  if (existing !== undefined) {
    if (existing.kind !== 'child') {
      throw new Error(`KerSor dsh child ${start.childSessionId} is unavailable (${existing.reason})`)
    }
    if (existing.mode !== 'continuable') {
      throw new Error(`KerSor dsh child ${start.childSessionId} is not continuable`)
    }
    await ctx.subagents.followup(parent, start.childSessionId, [{ type: 'text', text: prompt }], {
      source: {
        kind: 'coordinator',
        form: 'relay',
        senderSessionId: parent.id,
      },
      signal,
    })
    return
  }
  await ctx.subagents.startContinuable({
    provider: 'spawn',
    label: 'KerSor experiment',
    childId: start.childSessionId,
    request: {
      parent,
      prompt: [{ type: 'text', text: prompt }] as ContentBlock[],
      toolFilter: { deny: ['kersor_start', 'kersor_attach', 'kersor_resume'] },
    },
    signal,
  })
}

function parentOf(exec: { readonly agent?: Agent }): Agent {
  if (exec.agent === undefined) throw new Error('KerSor experiment controls require a calling dsh agent')
  if (exec.agent.session.header.origin === 'subagent') {
    throw new Error('KerSor experiment controls are available only in a top-level dsh conversation')
  }
  return exec.agent
}

function workspaceOf(parent: Agent): string {
  const workspace = parent.session.header.cwd
  if (workspace === undefined) throw new Error('KerSor experiment controls require a dsh workspace')
  return workspace
}

function createStart(ctx: Context) {
  return defineTool({
    name: 'kersor_start',
    description: 'Start one KerSor optimization as a durable dsh child bound to this conversation. The current dsh workspace is the only target; runtime is always dsh.',
    parameters: {
      objective: {
        type: 'string',
        required: true,
        description: 'The concrete optimization objective and acceptance condition.',
      },
      fresh_session: {
        type: 'boolean',
        description: 'Require KerSor fresh-session isolation. Defaults to false.',
      },
      launch: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: 'Required immutable typed launch contract. Every nested field is required and overrides conflicting objective prose; runtime remains dsh.',
        properties: {
          backend: {
            type: 'string', required: true,
            description: 'Exact non-empty KerSor backend name.',
          },
          language: {
            type: 'string', required: true,
            description: 'Exact non-empty implementation language.',
          },
          integration_pattern: {
            type: 'string', required: true,
            description: 'Exact non-empty integration pattern.',
          },
          target_speedup: {
            type: 'number', required: true,
            description: 'Positive numeric target speedup. Submit a JSON number such as 8, never a string such as "8x".',
          },
          max_workflows: {
            type: 'integer', required: true,
            description: 'Positive integer maximum number of Workflows.',
          },
          mode: {
            type: 'string', required: true, enum: ['auto', 'guided', 'explore'],
            description: 'KerSor optimization mode.',
          },
          workflow_authoring_budget: {
            type: 'integer', required: true,
            description: 'Nonnegative integer Workflow authoring budget.',
          },
          retrieval_mode: {
            type: 'string', required: true, enum: ['on', 'off'],
            description: 'Explicit retrieval mode.',
          },
          transfer_mode: {
            type: 'string', required: true, enum: ['full', 'measured-only', 'off'],
            description: 'Explicit transfer mode.',
          },
          experience_mode: {
            type: 'string', required: true, enum: ['on', 'off'],
            description: 'Explicit experience mode.',
          },
          kernelwiki_experience_export_mode: {
            type: 'string', required: true, enum: ['on', 'off'],
            description: 'Explicit KernelWiki experience export mode.',
          },
          correctness_command: {
            type: 'string', required: true,
            description: 'Exact non-empty single-line correctness command; the controller must execute it verbatim.',
          },
          benchmark_command: {
            type: 'string', required: true,
            description: 'Exact non-empty single-line benchmark command; the controller must execute it verbatim.',
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          experimentId: { type: 'string', required: true },
          childSessionId: { type: 'string', required: true },
          action: { type: 'string', required: true, const: 'started' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `started KerSor experiment ${value.experimentId} in dsh child ${value.childSessionId}. ${PARENT_HANDOFF}`,
      }],
    },
    async execute(args: StartArgs, exec): Promise<StartResult> {
      const parent = parentOf(exec)
      const existing = latestOpenBinding(parent.session)
      if (existing !== undefined) {
        throw new Error(`KerSor experiment ${existing.start.experimentId} already belongs to this conversation; use kersor_resume`)
      }
      const workspace = await canonicalWorkspacePath(workspaceOf(parent))
      const kersorPython = await frozenKersorPython()
      if (args.launch === undefined) {
        throw new Error('KerSor start requires an immutable typed launch contract')
      }
      const freshSession = args.fresh_session ?? false
      const launch = effectiveLaunch(parseKersorLaunchContract(args.launch), freshSession)
      const experimentId = `kersor-${randomUUID()}` as KersorExperimentId
      const childSessionId = SessionId(`kersor-${randomUUID()}`)
      const start: KersorExperimentStartEventData = {
        experimentId,
        childSessionId,
        origin: 'created',
        objective: normalizedObjective(args.objective),
        freshSession,
        launch,
        ...callLocation(parent.session, exec.callId),
      }
      parent.session.append('kersor/experiment-start', start)
      await ctx.sessions.flush(parent.session)
      try {
        await materialize(
          ctx,
          parent,
          start,
          startPrompt(start, workspace, kersorPython),
          exec.signal,
        )
        await checkpoint(ctx, parent.session, start, 'running', null)
      } catch (error) {
        await checkpoint(
          ctx,
          parent.session,
          start,
          'waiting',
          error instanceof Error ? error.message : String(error),
        )
        throw error
      }
      exec.concludeTurn()
      return { experimentId, childSessionId, action: 'started' }
    },
    presentCall: () => ({ card: 'generic', title: 'Start KerSor experiment', kind: 'execute' }),
  })
}

function createResume(ctx: Context) {
  return defineTool({
    name: 'kersor_resume',
    description: 'Resume the conversation-bound KerSor experiment in its original durable dsh child. This never creates another experiment or child.',
    parameters: {
      experiment_id: {
        type: 'string',
        description: 'Existing experiment id. Omit to select the latest binding; terminal bindings are rejected explicitly.',
      },
      instruction: {
        type: 'string',
        description: 'Optional additional user direction for this continuation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          experimentId: { type: 'string', required: true },
          childSessionId: { type: 'string', required: true },
          action: { type: 'string', required: true, const: 'resumed' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `resumed KerSor experiment ${value.experimentId} in dsh child ${value.childSessionId}. ${PARENT_HANDOFF}`,
      }],
    },
    async execute(args: ResumeArgs, exec): Promise<ResumeResult> {
      const parent = parentOf(exec)
      const binding = resumeBinding(parent.session, args.experiment_id)
      if (binding?.closure !== undefined) {
        throw new Error(binding.closure === 'blocked (stalled)'
          ? `KerSor experiment ${binding.start.experimentId} is blocked (stalled) and cannot be resumed; start a new Experiment after resolving the blocker`
          : `KerSor experiment ${binding.start.experimentId} is terminal (${binding.closure})`)
      }
      if (binding === undefined) {
        throw new Error(args.experiment_id === undefined
          ? 'No KerSor experiment is bound to this conversation; use kersor_attach for an existing KerSor Session'
          : `KerSor experiment ${JSON.stringify(args.experiment_id)} is not bound to this conversation`)
      }
      const workspace = workspaceOf(parent)
      const kersorPython = await frozenKersorPython()
      try {
        if (binding.start.origin === 'attached') {
          await ensureSourceAuthorityTransfer(ctx, parent, binding.start)
          if (ctx.sessions.get(binding.start.childSessionId) !== undefined) {
            await ensureAttachedAuthorityImport(ctx, parent, binding.start)
          }
        }
        await materialize(
          ctx,
          parent,
          binding.start,
          resumePrompt(binding, workspace, kersorPython, args.instruction),
          exec.signal,
        )
        if (binding.start.origin === 'attached') {
          await ensureAttachedAuthorityImport(ctx, parent, binding.start)
        }
        await checkpoint(ctx, parent.session, binding.start, 'running', null)
      } catch (error) {
        await checkpoint(
          ctx,
          parent.session,
          binding.start,
          'waiting',
          error instanceof Error ? error.message : String(error),
        )
        throw error
      }
      exec.concludeTurn()
      return {
        experimentId: binding.start.experimentId,
        childSessionId: binding.start.childSessionId,
        action: 'resumed',
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Resume KerSor experiment', kind: 'execute' }),
  })
}

interface DurableAttachOrigin {
  readonly binding: ExperimentBinding
  readonly parentSessionId: SessionId
  readonly controller: Agent
  readonly initialization: SessionInitializationBinding
  readonly preTransferEventWatermark: number
  readonly preTransferEventSha256: string
  readonly sourceState: { readonly path: string; readonly sha256: string }
  readonly sourceWorkflowCatalog: { readonly path: string; readonly sha256: string }
}

async function durableAttachOrigin(
  ctx: Context,
  parent: Agent,
  experimentId: string,
  suppliedLaunch: unknown,
): Promise<DurableAttachOrigin> {
  if (!nonWhitespaceToken(experimentId)) {
    throw new Error('KerSor attach requires one durable origin experiment_id token')
  }
  const matches: { binding: ExperimentBinding; sessionId: SessionId }[] = []
  for (const session of ctx.sessions.list()) {
    for (const binding of experimentBindings(session.events)) {
      if (binding.start.experimentId === experimentId
        && binding.start.origin === 'created') {
        matches.push({ binding, sessionId: session.id })
      }
    }
  }
  const origin = matches[0]
  if (matches.length !== 1 || origin === undefined) {
    throw new Error(`KerSor attach requires exactly one durable origin Experiment for ${JSON.stringify(experimentId)}`)
  }
  if (origin.binding.closure !== undefined) {
    throw new Error(`KerSor attach durable origin is terminal (${origin.binding.closure})`)
  }
  const launch = parseKersorLaunchContract(suppliedLaunch, 'KerSor attach launch')
  if (!isDeepStrictEqual(launch, origin.binding.start.launch)) {
    throw new Error('KerSor attach launch differs from its durable origin Experiment launch')
  }
  const parentWorkspace = await canonicalWorkspacePath(workspaceOf(parent))
  const originSession = ctx.sessions.get(origin.sessionId)
  const originWorkspace = originSession?.header.cwd
  if (originWorkspace === undefined
    || await canonicalWorkspacePath(originWorkspace) !== parentWorkspace) {
    throw new Error('KerSor attach durable origin belongs to a different workspace')
  }
  const sourceSession = ctx.sessions.get(origin.binding.start.childSessionId)
  if (sourceSession === undefined
    || sourceSession.header.parentSession !== origin.sessionId) {
    throw new Error('KerSor attach durable source controller Session is unavailable')
  }
  if (sourceSession.header.cwd === undefined
    || await canonicalWorkspacePath(sourceSession.header.cwd) !== parentWorkspace) {
    throw new Error('KerSor attach durable source controller belongs to a different workspace')
  }
  const controller = { id: sourceSession.id, session: sourceSession } as unknown as Agent
  const initialization = await validateSessionInitialization(
    controller, origin.binding,
  )
  if (sourceSession.events.some(event =>
    event.type === 'kersor/session-authority-transferred')) {
    throw new Error('KerSor attach durable source authority was already transferred')
  }
  const sourceData = initialization.data
  const sessionDir = sourceData.session_dir
  if (sourceData.workspace !== parentWorkspace || typeof sessionDir !== 'string') {
    throw new Error('KerSor attach source initialization workspace differs from its durable origin')
  }
  const sourceState = await currentSessionState(sessionDir, launch)
  const sourceWorkflowCatalog = await boundedFileBinding(
    join(sessionDir, 'workflow-catalog.json'), MAX_KERSOR_CATALOG_BYTES,
    'KerSor attach current workflow catalog',
  )
  const last = sourceSession.events.at(-1)
  if (last === undefined) throw new Error('KerSor attach source controller has no durable authority log')
  const sourcePrefix = sourceSession.events.filter(event => event.seq <= last.seq)
  return {
    binding: origin.binding,
    parentSessionId: origin.sessionId,
    controller,
    initialization,
    preTransferEventWatermark: last.seq,
    preTransferEventSha256: createHash('sha256')
      .update(canonicalKersorJson(sourcePrefix), 'utf8')
      .digest('hex'),
    sourceState,
    sourceWorkflowCatalog,
  }
}

function attachedAuthorityIntent(
  origin: DurableAttachOrigin,
  attachCallId: string,
): KersorSessionAuthorityIntent {
  const sessionDir = origin.initialization.data.session_dir
  if (typeof sessionDir !== 'string') {
    throw new Error('KerSor attach source initialization lost its Session path')
  }
  return {
    attach_call_id: attachCallId,
    workspace: origin.initialization.data.workspace as string,
    session_dir: sessionDir,
    source_parent_session_id: origin.parentSessionId,
    source_controller_session_id: origin.controller.id,
    pre_transfer_event_watermark: origin.preTransferEventWatermark,
    pre_transfer_event_sha256: origin.preTransferEventSha256,
    source_setup_receipt: origin.initialization.receipt,
    source_state: origin.sourceState,
    source_workflow_catalog: origin.sourceWorkflowCatalog,
  }
}

function exactAttachedStartCall(
  parent: Session,
  start: KersorExperimentStartEventData,
  intent: KersorSessionAuthorityIntent,
): void {
  const startEvents = parent.events.filter(event =>
    event.type === 'kersor/experiment-start'
    && event.data.experimentId === start.experimentId
    && event.data.childSessionId === start.childSessionId
    && event.data.origin === 'attached'
    && event.data.authorityIntent?.attach_call_id === intent.attach_call_id)
  const startEvent = startEvents[0]
  const startIndex = startEvent === undefined ? -1 : parent.events.indexOf(startEvent)
  const calls = parent.events.filter(event =>
    event.type === 'tool/call' && event.data.callId === intent.attach_call_id)
  const call = calls[0]
  if (startEvents.length !== 1
    || calls.length !== 1 || call?.type !== 'tool/call' || call.data.name !== 'kersor_attach'
    || parent.events.indexOf(call) >= startIndex) {
    throw new Error('KerSor attach intent lacks its exact preceding parent kersor_attach call')
  }
  let args: Record<string, unknown> | undefined
  try { args = record(JSON.parse(call.data.arguments)) } catch { /* rejected below */ }
  const expectedKeys = args !== undefined && Object.hasOwn(args, 'objective')
    ? ['experiment_id', 'launch', 'objective']
    : ['experiment_id', 'launch']
  const objective = typeof args?.objective === 'string'
    ? normalizedObjective(args.objective)
    : 'Resume the existing KerSor optimization to its next canonical boundary.'
  if (args === undefined || !hasExactKeys(args, expectedKeys)
    || args.experiment_id !== start.experimentId
    || !isDeepStrictEqual(parseKersorLaunchContract(args.launch, 'KerSor attach call launch'), start.launch)
    || objective !== start.objective) {
    throw new Error('KerSor attach intent differs from its exact parent call arguments')
  }
}

function sourceAuthorityForIntent(
  ctx: Context,
  start: KersorExperimentStartEventData,
): { readonly parent: Session; readonly controller: Agent; readonly intent: KersorSessionAuthorityIntent } {
  const intent = start.authorityIntent
  if (start.origin !== 'attached' || intent === undefined
    || start.originSessionId !== intent.source_parent_session_id) {
    throw new Error('attached KerSor Experiment lacks its durable source authority intent')
  }
  const sourceParent = ctx.sessions.get(intent.source_parent_session_id)
  const sourceSession = ctx.sessions.get(intent.source_controller_session_id)
  if (sourceParent === undefined || sourceSession === undefined
    || sourceSession.header.parentSession !== sourceParent.id) {
    throw new Error('attached KerSor source authority lineage is unavailable')
  }
  const sourceBindings = experimentBindings(sourceParent.events).filter(candidate =>
    candidate.start.experimentId === start.experimentId
    && candidate.start.origin === 'created'
    && candidate.start.childSessionId === sourceSession.id)
  if (sourceBindings.length !== 1 || !isDeepStrictEqual(sourceBindings[0]?.start.launch, start.launch)) {
    throw new Error('attached KerSor source Experiment authority is unavailable')
  }
  return {
    parent: sourceParent,
    controller: { id: sourceSession.id, session: sourceSession } as unknown as Agent,
    intent,
  }
}

async function ensureSourceAuthorityTransfer(
  ctx: Context,
  targetParent: Agent,
  start: KersorExperimentStartEventData,
): Promise<{
  readonly controller: Agent
  readonly event: Extract<SessionEvent, { type: 'kersor/session-authority-transferred' }>
  readonly receipt: { readonly path: string; readonly sha256: string }
  readonly sourcePrefix: readonly SessionEvent[]
}> {
  const { controller, intent } = sourceAuthorityForIntent(ctx, start)
  exactAttachedStartCall(targetParent.session, start, intent)
  if (intent.workspace !== await canonicalWorkspacePath(workspaceOf(targetParent))
    || controller.session.header.cwd === undefined
    || intent.workspace !== await canonicalWorkspacePath(controller.session.header.cwd)) {
    throw new Error('attached KerSor source/target workspace authority differs')
  }
  const prePrefix = controller.session.events.filter(event =>
    event.seq <= intent.pre_transfer_event_watermark)
  if (prePrefix.length !== intent.pre_transfer_event_watermark + 1
    || prePrefix.some((event, index) => event.seq !== index)
    || createHash('sha256').update(canonicalKersorJson(prePrefix), 'utf8').digest('hex')
      !== intent.pre_transfer_event_sha256) {
    throw new Error('attached KerSor pre-transfer source prefix changed or was truncated')
  }
  const sourceBinding = experimentBindings(
    ctx.sessions.get(intent.source_parent_session_id)?.events ?? [],
  ).find(candidate => candidate.start.experimentId === start.experimentId)
  if (sourceBinding === undefined) throw new Error('attached KerSor source binding disappeared')
  const projected = agentWithAuthorityEvents(controller, prePrefix)
  const initialization = await validateSessionInitialization(
    projected, sourceBinding, intent.session_dir,
  )
  if (!isDeepStrictEqual(initialization.receipt, intent.source_setup_receipt)) {
    throw new Error('attached KerSor intent differs from its historical setup receipt')
  }
  const targetSession = ctx.sessions.get(start.childSessionId)
  const importCommitted = targetSession?.events.some(event =>
    event.type === 'kersor/session-authority-imported'
    && event.data.experiment_id === start.experimentId) ?? false
  if (!importCommitted) {
    const currentState = await currentSessionState(intent.session_dir, start.launch)
    const currentCatalog = await boundedFileBinding(
      join(intent.session_dir, 'workflow-catalog.json'), MAX_KERSOR_CATALOG_BYTES,
      'KerSor pre-transfer workflow catalog',
    )
    if (!isDeepStrictEqual(currentState, intent.source_state)
      || !isDeepStrictEqual(currentCatalog, intent.source_workflow_catalog)) {
      throw new Error('attached KerSor source state/catalog changed before authority import')
    }
  }
  const data: KersorSessionAuthorityTransferredEventData = {
    schema_version: 1,
    contract: 'dsh_session_authority_transfer_v1',
    authority: 'dsh_host',
    experiment_id: start.experimentId,
    workspace: intent.workspace,
    session_dir: intent.session_dir,
    source_parent_session_id: intent.source_parent_session_id,
    source_controller_session_id: intent.source_controller_session_id,
    target_parent_session_id: targetParent.id,
    target_controller_session_id: start.childSessionId,
    attach_call_id: intent.attach_call_id,
    launch: start.launch,
    pre_transfer_event_watermark: intent.pre_transfer_event_watermark,
    pre_transfer_event_sha256: intent.pre_transfer_event_sha256,
    source_setup_receipt: intent.source_setup_receipt,
    source_state: intent.source_state,
    source_workflow_catalog: intent.source_workflow_catalog,
  }
  const existing = controller.session.events.filter(event =>
    event.type === 'kersor/session-authority-transferred')
  const receipt = await idempotentHostReceipt(
    join(intent.session_dir, SESSION_AUTHORITY_TRANSFER_RECEIPT), data,
    'Session authority transfer Host receipt',
  )
  if (existing.length === 0) {
    controller.session.append('kersor/session-authority-transferred', data)
    await ctx.sessions.flush(controller.session)
  } else if (existing.length !== 1 || !isDeepStrictEqual(existing[0]?.data, data)) {
    throw new Error('KerSor source controller has a different or duplicate authority transfer')
  }
  const event = controller.session.events.find(candidate =>
    candidate.type === 'kersor/session-authority-transferred')
  if (event?.type !== 'kersor/session-authority-transferred') {
    throw new Error('KerSor source authority transfer event was not committed')
  }
  const sourcePrefix = controller.session.events.filter(candidate => candidate.seq <= event.seq)
  return { controller, event, receipt, sourcePrefix }
}

async function ensureAttachedAuthorityImport(
  ctx: Context,
  targetParent: Agent,
  start: KersorExperimentStartEventData,
): Promise<void> {
  const transfer = await ensureSourceAuthorityTransfer(ctx, targetParent, start)
  const intent = start.authorityIntent
  const targetSession = ctx.sessions.get(start.childSessionId)
  if (intent === undefined || targetSession === undefined
    || targetSession.header.parentSession !== targetParent.id
    || targetSession.header.cwd === undefined
    || await canonicalWorkspacePath(targetSession.header.cwd) !== intent.workspace) {
    throw new Error('attached controller Session metadata differs from its durable Host intent')
  }
  const existingImports = targetSession.events.filter(event =>
    event.type === 'kersor/session-authority-imported')
  if (existingImports.length === 0) {
    const currentState = await currentSessionState(intent.session_dir, start.launch)
    const currentCatalog = await boundedFileBinding(
      join(intent.session_dir, 'workflow-catalog.json'), MAX_KERSOR_CATALOG_BYTES,
      'KerSor authority-import workflow catalog',
    )
    if (!isDeepStrictEqual(currentState, intent.source_state)
      || !isDeepStrictEqual(currentCatalog, intent.source_workflow_catalog)) {
      throw new Error('attached KerSor source state/catalog changed before authority import')
    }
  }
  const data = {
    schema_version: 1,
    contract: 'dsh_session_authority_import_v1',
    authority: 'dsh_host',
    experiment_id: start.experimentId,
    workspace: intent.workspace,
    session_dir: intent.session_dir,
    controller_session_id: start.childSessionId,
    attached_parent_session_id: targetParent.id,
    attach_call_id: intent.attach_call_id,
    launch: start.launch,
    source_parent_session_id: intent.source_parent_session_id,
    source_controller_session_id: intent.source_controller_session_id,
    source_event_watermark: transfer.event.seq,
    source_event_sha256: createHash('sha256')
      .update(canonicalKersorJson(transfer.sourcePrefix), 'utf8').digest('hex'),
    source_setup_receipt: intent.source_setup_receipt,
    source_transfer_receipt: transfer.receipt,
    source_state: intent.source_state,
    source_workflow_catalog: intent.source_workflow_catalog,
  }
  await idempotentHostReceipt(
    join(intent.session_dir, SESSION_AUTHORITY_IMPORT_RECEIPT), data,
    'Session authority import Host receipt',
  )
  if (existingImports.length === 0) {
    targetSession.append('kersor/session-authority-imported', data as never)
    await ctx.sessions.flush(targetSession)
  } else if (existingImports.length !== 1
    || !isDeepStrictEqual(existingImports[0]?.data, data)) {
    throw new Error('attached controller has a different or duplicate Host authority import')
  }
}

function createAttach(ctx: Context) {
  return defineTool({
    name: 'kersor_attach',
    description: 'Bind the current workspace\'s existing KerSor Session to one durable dsh child, then resume it. Use only when this conversation has no experiment binding.',
    parameters: {
      experiment_id: {
        type: 'string',
        required: true,
        description: 'Exact durable origin KerSor Experiment id from a persisted DSH Session.',
      },
      launch: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: 'Exact immutable typed launch; the Host compares it to the durable origin event.',
        properties: {
          backend: { type: 'string', required: true },
          language: { type: 'string', required: true },
          integration_pattern: { type: 'string', required: true },
          target_speedup: { type: 'number', required: true },
          max_workflows: { type: 'integer', required: true },
          mode: { type: 'string', required: true, enum: ['auto', 'guided', 'explore'] },
          workflow_authoring_budget: { type: 'integer', required: true },
          retrieval_mode: { type: 'string', required: true, enum: ['on', 'off'] },
          transfer_mode: {
            type: 'string', required: true, enum: ['full', 'measured-only', 'off'],
          },
          experience_mode: { type: 'string', required: true, enum: ['on', 'off'] },
          kernelwiki_experience_export_mode: {
            type: 'string', required: true, enum: ['on', 'off'],
          },
          correctness_command: { type: 'string', required: true },
          benchmark_command: { type: 'string', required: true },
        },
      },
      objective: {
        type: 'string',
        description: 'Optional continuation objective. The existing KerSor Session remains authoritative.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          experimentId: { type: 'string', required: true },
          childSessionId: { type: 'string', required: true },
          action: { type: 'string', required: true, const: 'attached' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `attached KerSor experiment ${value.experimentId} to dsh child ${value.childSessionId}. ${PARENT_HANDOFF}`,
      }],
    },
    async execute(args: AttachArgs, exec): Promise<AttachResult> {
      const parent = parentOf(exec)
      const existing = latestOpenBinding(parent.session)
      if (existing !== undefined) {
        throw new Error(`KerSor experiment ${existing.start.experimentId} already belongs to this conversation; use kersor_resume`)
      }
      const workspace = workspaceOf(parent)
      const kersorPython = await frozenKersorPython()
      const origin = await durableAttachOrigin(
        ctx, parent, args.experiment_id, args.launch,
      )
      const childSessionId = SessionId(`kersor-${randomUUID()}`)
      const authorityIntent = attachedAuthorityIntent(origin, exec.callId)
      const start: KersorExperimentStartEventData = {
        experimentId: origin.binding.start.experimentId,
        childSessionId,
        origin: 'attached',
        objective: normalizedObjective(args.objective ?? 'Resume the existing KerSor optimization to its next canonical boundary.'),
        freshSession: false,
        launch: origin.binding.start.launch,
        originSessionId: origin.parentSessionId,
        authorityIntent,
        ...callLocation(parent.session, exec.callId),
      }
      parent.session.append('kersor/experiment-start', start)
      await ctx.sessions.flush(parent.session)
      const binding = { start }
      try {
        await ensureSourceAuthorityTransfer(ctx, parent, start)
        await materialize(
          ctx,
          parent,
          start,
          resumePrompt(binding, workspace, kersorPython, args.objective),
          exec.signal,
        )
        await ensureAttachedAuthorityImport(ctx, parent, start)
        const controller = ctx.sessions.get(start.childSessionId)
        if (controller !== undefined) {
          if (!controller.events.some(event =>
            event.type === 'kersor/session-authority-imported'
            && event.data.experiment_id === start.experimentId)) {
            throw new Error('attached controller did not commit its Host authority import')
          }
          await ctx.sessions.flush(controller)
        }
        await checkpoint(ctx, parent.session, start, 'running', null)
      } catch (error) {
        await checkpoint(
          ctx,
          parent.session,
          start,
          'waiting',
          error instanceof Error ? error.message : String(error),
        )
        throw error
      }
      exec.concludeTurn()
      return { experimentId: start.experimentId, childSessionId: start.childSessionId, action: 'attached' }
    },
    presentCall: () => ({ card: 'generic', title: 'Attach KerSor experiment', kind: 'execute' }),
  })
}

function controllerBinding(ctx: Context, child: Agent): { parent: Session; binding: ExperimentBinding } | undefined {
  const parentId = child.session.header.parentSession
  if (parentId === undefined) return undefined
  const parent = ctx.sessions.get(parentId)
  if (parent === undefined) return undefined
  const binding = experimentBindings(parent.events)
    .find(candidate => candidate.start.childSessionId === child.id)
  return binding === undefined ? undefined : { parent, binding }
}

function experimentControllerAncestor(ctx: Context, descendant: Agent): ExperimentBinding | undefined {
  let child = descendant.session
  const visited = new Set<string>()
  while (child.header.parentSession !== undefined) {
    if (visited.has(child.id)) return undefined
    visited.add(child.id)
    const parent = ctx.sessions.get(child.header.parentSession)
    if (parent === undefined) return undefined
    const binding = experimentBindings(parent.events)
      .find(candidate => candidate.start.childSessionId === child.id)
    if (binding !== undefined) return binding
    child = parent
  }
  return undefined
}

function experimentControllerAgent(
  ctx: Context,
  descendant: Agent,
): { readonly controller: Agent; readonly binding: ExperimentBinding } | undefined {
  let child = descendant.session
  const visited = new Set<string>()
  while (child.header.parentSession !== undefined) {
    if (visited.has(child.id)) return undefined
    visited.add(child.id)
    const parent = ctx.sessions.get(child.header.parentSession)
    if (parent === undefined) return undefined
    const binding = experimentBindings(parent.events)
      .find(candidate => candidate.start.childSessionId === child.id)
    if (binding !== undefined) {
      return {
        controller: { id: child.id, session: child } as unknown as Agent,
        binding,
      }
    }
    child = parent
  }
  return undefined
}

function bashCommand(argumentsValue: unknown): string | undefined {
  const argumentsRecord = record(argumentsValue)
  return typeof argumentsRecord?.command === 'string' ? argumentsRecord.command : undefined
}

function touchesKersorRuntime(command: string): boolean {
  return /(?:^|\b)KerSor\/scripts\//.test(command)
    || /\$(?:kersor_root|\{kersor_root\})\/scripts\//i.test(command)
    || /\b(?:run-kersor-python\.sh|setup-session\.sh|kersor_bridge\.py)\b/i.test(command)
}

function discoversPython(command: string): boolean {
  return /\b(?:which|whereis)\s+(?:-[^\s]+\s+)*python(?:\d+(?:\.\d+)*)?\b/i.test(command)
    || /\bcommand\s+-v\s+python(?:\d+(?:\.\d+)*)?\b/i.test(command)
    || /\btype\s+(?:-[^\s]+\s+)*python(?:\d+(?:\.\d+)*)?\b/i.test(command)
    || /(?:["']?(?:[^\s;|&"']*\/)?python(?:\d+(?:\.\d+)*)?["']?|["']?\$\{?KERSOR_PYTHON\}?["']?)\s+(?:--version|-V)\b/i.test(command)
    || /\b(?:find|fd|fdfind|locate)\b[^\n;|&]*\bpython(?:\d+(?:\.\d+)*)?[?*]?/i.test(command)
    || /\b(?:rg|grep|ls)\b[^\n;|&]*(?:\/python(?:\d+(?:\.\d+)*)?|python[?*])/i.test(command)
    || /\b(?:sys\.executable|shutil\.which\s*\([^)]*python)/i.test(command)
}

function invokesAlternatePython(command: string): boolean {
  // Python must be the executable at a shell command boundary. Treating every
  // whitespace-delimited `python` token as an invocation also rejects typed
  // values such as `--backend python` and benchmark-command arguments.
  const pattern = [
    String.raw`(?:^|&&|\|\||[;|\n({])\s*`,
    String.raw`(?:[a-z_][a-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s;&|]+)\s+)*`,
    String.raw`(?:(?:if|then|while|until|do|!|time|command|exec|env|sudo)(?:\s+-[^\s;|&]+)*\s+)*`,
    String.raw`(?:["']?[^\s;|&"']*\/)?python(?:\d+(?:\.\d+)*)?["']?(?=\s|$)`,
  ].join('')
  return new RegExp(pattern, 'i').test(command)
}

async function kersorBashDenial(command: string): Promise<string | undefined> {
  const runtimeCommand = touchesKersorRuntime(command)
  const discovery = discoversPython(command)
  if (!runtimeCommand && !discovery) return undefined
  const prefix = frozenPythonPrefix(await frozenKersorPython())
  if (discovery) {
    return `KerSor Experiment descendants may not discover or substitute Python; use the Host-frozen interpreter through the exact prefix ${prefix}`
  }
  if (!command.startsWith(prefix)) {
    return `KerSor bridge/helper/setup commands must begin with the exact Host-frozen prefix ${prefix}`
  }
  if (invokesAlternatePython(command.slice(prefix.length).trimStart())) {
    return `KerSor bridge/helper/setup commands may not substitute python/python3; after the exact prefix ${prefix} invoke Python only as "$KERSOR_PYTHON"`
  }
  return undefined
}

function nodeErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string'
    ? error.code
    : undefined
}

function runPathParts(root: string, target: string, output: boolean): string[] | undefined {
  const path = relative(root, target)
  if (path.length === 0 || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) {
    return undefined
  }
  const parts = path.split(sep)
  const expectedLength = output ? 4 : 3
  if (parts.length !== expectedLength
    || parts[0] !== '.kersor'
    || parts[1]?.length === 0
    || !/^run-[1-9]\d*$/.test(parts[2] ?? '')
    || (output && parts[3] !== 'output.json')) {
    return undefined
  }
  return parts
}

async function canonicalRunDirectory(agent: Agent, expDir: unknown): Promise<string> {
  if (typeof expDir !== 'string' || expDir.length === 0 || !isAbsolute(expDir)) {
    throw new Error('workflow args.exp_dir must be a non-empty absolute path')
  }
  const workspace = workspaceOf(agent)
  const lexicalWorkspace = resolve(workspace)
  const lexicalRun = resolve(expDir)
  const parts = runPathParts(lexicalWorkspace, lexicalRun, false)
  if (parts === undefined) {
    throw new Error('workflow args.exp_dir must resolve exactly under <workspace>/.kersor/<session>/run-N')
  }
  let realWorkspace: string
  let realRun: string
  try {
    [realWorkspace, realRun] = await Promise.all([realpath(lexicalWorkspace), realpath(lexicalRun)])
  } catch (error: unknown) {
    throw new Error(`workflow args.exp_dir must name an existing run directory: ${error instanceof Error ? error.message : String(error)}`)
  }
  const expectedRealRun = join(realWorkspace, ...parts)
  if (realRun !== expectedRealRun || runPathParts(realWorkspace, realRun, false) === undefined) {
    throw new Error('workflow args.exp_dir contains a symlink escape or does not identify its exact run-N directory')
  }
  if (!(await stat(realRun)).isDirectory()) {
    throw new Error('workflow args.exp_dir must identify a directory')
  }
  return realRun
}

interface WorkflowCallContract {
  readonly meta: Record<string, unknown>
  readonly script: string
  readonly args: Record<string, unknown>
}

interface WorkflowHostGateState {
  readonly authorizedNativeCallIds: Set<string>
  readonly consumedRuns: Set<string>
  readonly producerCalls: Map<string, DispatchProducerState>
  readonly producerChildren: Map<string, DispatchProducerState>
  readonly transformationCalls: Map<string, DispatchTransformationState>
  readonly candidateSealCalls: Map<string, CandidateSealState>
  readonly baselineCalls: Map<string, BaselineCallState>
  readonly authorSealCalls: WeakMap<ToolExecution, AuthorSealCallState>
  readonly consumedAuthorSaves: Set<string>
  readonly setupCalls: WeakMap<ToolExecution, SessionSetupCallState>
  readonly activeExperiments: Set<string>
}

interface SessionSetupCallState {
  readonly controller: Agent
  readonly callId: string
  readonly experimentId: KersorExperimentId
  readonly workspace: string
  readonly launch: KersorLaunchContract
  readonly freshSession: boolean
  readonly kersorRoot: string
  readonly kersorPython: string
  readonly existingSessionNames: ReadonlySet<string>
}

interface SessionInitializationBinding {
  readonly data: Record<string, unknown>
  readonly receipt: { readonly path: string; readonly sha256: string }
  readonly eventIndex: number
  readonly authorityAgent: Agent
  readonly authorityEvents: readonly SessionEvent[]
}

function agentWithAuthorityEvents(
  agent: Agent,
  events: readonly SessionEvent[],
): Agent {
  const session = new Proxy(agent.session, {
    get(target, property) {
      if (property === 'events') return events
      const value = Reflect.get(target, property, target) as unknown
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => Reflect.apply(value, target, args) as unknown
    },
  })
  return { id: agent.id, session } as Agent
}

interface DispatchProducerState {
  readonly controller: Agent
  readonly callId: string
  readonly sessionDir: string
  readonly runDir: string
  readonly round: number
  readonly workflowName: string
  producerSessionId?: string
  readonly successfulWrites: Set<string>
}

interface DispatchTransformationState {
  readonly controller: Agent
  readonly callId: string
  readonly sessionDir: string
  readonly runDir: string
  readonly producer: KersorDispatchArgsProducedEventData
  readonly producerReceiptPath: string
  readonly producerReceiptSha256: string
  readonly beforeArgs: Record<string, unknown>
  readonly beforeProvenance: Record<string, unknown>
}

interface CandidateSealState {
  readonly controller: Agent
  readonly callId: string
  readonly sessionDir: string
  readonly runDir: string
  readonly round: number
}

interface AuthorAuthority {
  readonly controller: Agent
  readonly directController: boolean
  readonly sessionDir: string
  readonly stagingDir: string
  readonly handoffPath: string
  readonly kersorRoot: string
  readonly kersorPython: string
}

interface AuthorSealCallState extends AuthorAuthority {
  readonly callId: string
  readonly command: string
}

function canonicalAuthorCommands(authority: AuthorAuthority): CanonicalAuthorCommands {
  return {
    seal: canonicalAuthorHandoffSealCommand(authority.kersorPython, authority.sessionDir),
    save: canonicalAuthorSaveCommand(authority.kersorPython, authority.sessionDir),
  }
}

type BaselinePhase = 'initialized' | 'recorded' | 'verified'

interface BaselineOwner {
  readonly launch: KersorLaunchContract
  readonly workspace: string
  readonly sessionDir: string
  readonly taskDir: string
  readonly startedAt: string
  readonly sessionConfig: { readonly path: string; readonly sha256: string }
  readonly kernel: { readonly path: string; readonly sha256: string }
  readonly commands: { readonly correctness: string; readonly benchmark: string }
}

interface BaselineAuthority extends BaselineOwner {
  readonly testMethod: { readonly path: string; readonly sha256: string }
}

interface BaselineCallState {
  readonly controller: Agent
  readonly callId: string
  readonly phase: BaselinePhase
  readonly owner: BaselineOwner
}

async function canonicalWorkspacePath(value: string): Promise<string> {
  const lexical = resolve(value)
  try {
    return await realpath(lexical)
  } catch (error: unknown) {
    if (nodeErrorCode(error) === 'ENOENT') return lexical
    throw error
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch (error: unknown) {
    if (nodeErrorCode(error) === 'ENOENT') return false
    throw error
  }
}

async function isCanonicalSessionRootEntry(root: string, entry: Dirent): Promise<boolean> {
  if (!entry.isDirectory() || entry.isSymbolicLink()) return false
  const sessionDir = join(root, entry.name)
  if (!(await lstat(sessionDir)).isDirectory()) return false
  const hasConfig = await isRegularFile(join(sessionDir, 'session-config.json'))
  const hasState = await isRegularFile(join(sessionDir, 'state.json'))
  if (hasConfig || hasState) return hasConfig && hasState
  return isRegularFile(join(sessionDir, 'state.md'))
}

async function sessionRootChildren(workspace: string): Promise<ReadonlySet<string>> {
  const root = join(workspace, '.kersor')
  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error: unknown) {
    if (nodeErrorCode(error) === 'ENOENT') return new Set()
    throw error
  }
  const names = new Set<string>()
  for (const entry of entries) {
    if (await isCanonicalSessionRootEntry(root, entry)) names.add(entry.name)
  }
  return names
}

async function beginSessionSetup(
  exec: ToolExecution,
  binding: ExperimentBinding,
  hostGate: WorkflowHostGateState,
): Promise<string | undefined> {
  const agent = exec.agent
  if (agent === undefined) return 'KerSor Session setup requires its controller Agent'
  const callId = exec.callId
  const argumentsValue = exec.arguments
  const command = bashCommand(argumentsValue)
  if (command === undefined) return undefined
  if (!command.includes('setup-session.sh')) return undefined
  if (binding.start.origin !== 'created') {
    return 'Attached KerSor Experiments must import their durable source authority and may not run setup-session.sh again'
  }
  const cwd = agent.session.header.cwd
  if (cwd === undefined) return 'KerSor Session setup requires a controller workspace'
  const workspace = await canonicalWorkspacePath(cwd)
  const kersorPython = await frozenKersorPython()
  const expected = canonicalSessionSetupCommand(
    workspace,
    binding.start.launch,
    binding.start.freshSession,
    kersorPython,
    agent.id,
  )
  if (command !== expected) {
    return `KerSor Session setup must use the exact Host-authorized command: ${expected}`
  }
  if (!hostNormalizableSetupArguments(argumentsValue, expected, workspace)) {
    return 'KerSor Session setup requires one foreground Bash call in the canonical controller workspace whose sandbox escalation fields, when present, use the closed DSH mode vocabulary; the Host owns their effective disposition'
  }
  const exactCallIds: string[] = []
  for (const event of agent.session.events) {
    if (event.type !== 'tool/call' || event.data.name !== 'bash') continue
    try {
      if (hostNormalizableSetupArguments(JSON.parse(event.data.arguments), expected, workspace)) {
        exactCallIds.push(event.data.callId)
      }
    } catch {
      // Malformed historical tool arguments are not a canonical setup attempt.
    }
  }
  if (exactCallIds.length !== 1 || exactCallIds[0] !== callId) {
    return 'KerSor Session setup is exact-once; a prior canonical attempt consumed this Experiment'
  }
  if (agent.session.events.some(event =>
    event.type === 'kersor/session-initialized'
    || event.type.startsWith('kersor/baseline-')
    || event.type.startsWith('kersor/dispatch-args-')
    || event.type === 'kersor/candidate-ownership-sealed')) {
    return 'KerSor Session setup must precede every baseline, dispatch, and candidate authority event'
  }
  hostGate.setupCalls.set(exec, {
    controller: agent,
    callId,
    experimentId: binding.start.experimentId,
    workspace,
    launch: binding.start.launch,
    freshSession: binding.start.freshSession,
    kersorRoot: await frozenKersorRoot(),
    kersorPython,
    existingSessionNames: await sessionRootChildren(workspace),
  })
  return undefined
}

async function sessionSetupAuthority(
  state: SessionSetupCallState,
): Promise<Record<string, unknown>> {
  const current = await sessionRootChildren(state.workspace)
  const created = [...current].filter(name => !state.existingSessionNames.has(name))
  if (created.length !== 1 || created[0] === undefined) {
    throw new Error('canonical setup-session.sh must create exactly one new workspace/.kersor/Session')
  }
  const sessionDir = await realpath(join(state.workspace, '.kersor', created[0]))
  if (dirname(sessionDir) !== join(state.workspace, '.kersor')) {
    throw new Error('setup-session.sh created a non-canonical Session path')
  }
  return sessionInitializationData(
    state.controller,
    state.experimentId,
    state.callId,
    sessionDir,
    state.launch,
    state.freshSession,
    state.kersorRoot,
    state.kersorPython,
  )
}

const SESSION_INITIALIZATION_KEYS = Object.freeze([
  'schema_version', 'contract', 'authority', 'experiment_id', 'workspace',
  'session_dir', 'controller_session_id', 'setup_call_id', 'setup_command',
  'kersor_python', 'launch',
  'session_config', 'state', 'workflow_catalog', 'adapter', 'kernel',
])
const SESSION_AUTHORITY_IMPORT_KEYS = Object.freeze([
  'schema_version', 'contract', 'authority', 'experiment_id', 'workspace',
  'session_dir', 'controller_session_id', 'attached_parent_session_id',
  'attach_call_id', 'launch', 'source_parent_session_id',
  'source_controller_session_id', 'source_event_watermark', 'source_event_sha256',
  'source_setup_receipt', 'source_transfer_receipt', 'source_state',
  'source_workflow_catalog',
])

async function boundedFileBinding(
  path: string,
  limit: number,
  label: string,
): Promise<{ readonly path: string; readonly sha256: string }> {
  const bytes = await readBoundedRegularFile(path, limit, label)
  return { path, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function historicalFileBinding(
  value: unknown,
  expectedPath: string | undefined,
  label: string,
): { readonly path: string; readonly sha256: string } {
  const binding = record(value)
  if (binding === undefined || !hasExactKeys(binding, ['path', 'sha256'])
    || typeof binding.path !== 'string' || !isAbsolute(binding.path)
    || resolve(binding.path) !== binding.path
    || (expectedPath !== undefined && binding.path !== expectedPath)) {
    throw new Error(`${label} path binding is invalid`)
  }
  return {
    path: binding.path,
    sha256: normalizedSha256(binding.sha256, `${label} hash`),
  }
}

async function sessionInitializationData(
  controller: Agent,
  experimentId: KersorExperimentId,
  setupCallId: string,
  sessionDir: string,
  launch: KersorLaunchContract,
  freshSession: boolean,
  kersorRoot: string,
  kersorPython: string,
): Promise<Record<string, unknown>> {
  const owner = await baselineOwner(controller, sessionDir, launch)
  await currentSessionState(sessionDir, launch, undefined, controller.id)
  const config = await readBoundedJsonObject(
    owner.sessionConfig.path, MAX_BASELINE_AUTHORITY_BYTES, 'initialized Session config',
  )
  const workflowDir = config.workflow_dir
  if (typeof workflowDir !== 'string' || !isAbsolute(workflowDir)
    || await realpath(workflowDir) !== workflowDir) {
    throw new Error('initialized Session config workflow_dir is not canonical')
  }
  const adapterPath = join(kersorRoot, 'scripts', 'setup-session.sh')
  const catalogPath = join(sessionDir, 'workflow-catalog.json')
  const statePath = join(sessionDir, 'state.json')
  return {
    schema_version: 1,
    contract: 'dsh_session_initialization_v1',
    authority: 'dsh_host',
    experiment_id: experimentId,
    workspace: owner.workspace,
    session_dir: sessionDir,
    controller_session_id: controller.id,
    setup_call_id: setupCallId,
    setup_command: canonicalSessionSetupCommand(
      owner.workspace, launch, freshSession,
      kersorPython, controller.id,
    ),
    kersor_python: await boundedFileBinding(
      kersorPython, MAX_KERSOR_PYTHON_BYTES, 'Host-frozen KerSor Python',
    ),
    launch,
    session_config: owner.sessionConfig,
    state: await boundedFileBinding(statePath, MAX_SESSION_STATE_BYTES, 'initialized state.json'),
    workflow_catalog: await boundedFileBinding(
      catalogPath, MAX_KERSOR_CATALOG_BYTES, 'initialized workflow-catalog.json',
    ),
    adapter: await boundedFileBinding(
      adapterPath, MAX_DSH_WORKFLOW_SOURCE_BYTES, 'KerSor setup-session.sh adapter',
    ),
    kernel: owner.kernel,
  }
}

async function finishSessionSetup(
  ctx: Context,
  state: SessionSetupCallState,
): Promise<void> {
  const event = await sessionSetupAuthority(state)
  const sessionDir = event.session_dir
  if (typeof sessionDir !== 'string') throw new Error('Session initialization lost its Session path')
  await atomicHostReceipt(join(sessionDir, SESSION_INITIALIZATION_RECEIPT), event)
  state.controller.session.append('kersor/session-initialized', event as never)
  await ctx.sessions.flush(state.controller.session)
}

async function validateSessionInitialization(
  agent: Agent,
  binding: ExperimentBinding,
  sessionDir?: string,
): Promise<SessionInitializationBinding> {
  const events = agent.session.events.filter(event =>
    event.type === 'kersor/session-initialized'
    && event.data.experiment_id === binding.start.experimentId)
  const event = events[0]
  if (events.length !== 1 || event === undefined) {
    throw new Error('KerSor Session lacks exactly one durable Host initialization event')
  }
  const data = event.data as unknown as Record<string, unknown>
  if (!hasExactKeys(data, SESSION_INITIALIZATION_KEYS)
    || data.schema_version !== 1 || data.contract !== 'dsh_session_initialization_v1'
    || data.authority !== 'dsh_host' || data.experiment_id !== binding.start.experimentId
    || data.controller_session_id !== agent.id
    || !nonWhitespaceToken(data.setup_call_id)
    || !isDeepStrictEqual(data.launch, binding.start.launch)
    || (sessionDir !== undefined && data.session_dir !== sessionDir)) {
    throw new Error('KerSor Session initialization event identity/schema is invalid')
  }
  if (typeof data.session_dir !== 'string') {
    throw new Error('KerSor Session initialization event lacks its Session path')
  }
  const workspace = await canonicalWorkspacePath(workspaceOf(agent))
  const expectedSession = await realpath(data.session_dir)
  if (data.workspace !== workspace || expectedSession !== data.session_dir
    || dirname(expectedSession) !== join(workspace, '.kersor')) {
    throw new Error('KerSor Session initialization workspace/Session path is invalid')
  }
  const sessionConfig = historicalFileBinding(
    data.session_config, join(expectedSession, 'session-config.json'),
    'Session initialization config',
  )
  historicalFileBinding(
    data.state, join(expectedSession, 'state.json'), 'Session initialization state',
  )
  historicalFileBinding(
    data.workflow_catalog, join(expectedSession, 'workflow-catalog.json'),
    'Session initialization workflow catalog',
  )
  const adapter = historicalFileBinding(data.adapter, undefined, 'Session initialization adapter')
  if (basename(adapter.path) !== 'setup-session.sh') {
    throw new Error('Session initialization adapter must be setup-session.sh')
  }
  const kernel = historicalFileBinding(data.kernel, undefined, 'Session initialization kernel')
  const kernelRelative = relative(workspace, kernel.path)
  if (kernelRelative.length === 0 || isAbsolute(kernelRelative)
    || kernelRelative === '..' || kernelRelative.startsWith(`..${sep}`)) {
    throw new Error('Session initialization kernel must be inside its workspace')
  }
  const kersorPython = historicalFileBinding(
    data.kersor_python, undefined, 'Session initialization KerSor Python',
  )
  const setupCommand = canonicalSessionSetupCommand(
    workspace, binding.start.launch, binding.start.freshSession,
    kersorPython.path, agent.id,
  )
  if (data.setup_command !== setupCommand) {
    throw new Error('Session initialization setup command differs from its historical Host binding')
  }
  const receiptPath = join(data.session_dir, SESSION_INITIALIZATION_RECEIPT)
  const receiptBytes = await readBoundedRegularFile(
    receiptPath, MAX_BASELINE_AUTHORITY_BYTES, 'Session initialization Host receipt',
  )
  let receiptValue: unknown
  try { receiptValue = JSON.parse(receiptBytes.toString('utf8')) } catch {
    throw new Error('Session initialization Host receipt is malformed JSON')
  }
  if (!isDeepStrictEqual(receiptValue, data)) {
    throw new Error('Session initialization Host receipt differs from its durable event')
  }
  const calls = agent.session.events.filter((event) => {
    if (event.type !== 'tool/call' || event.data.name !== 'bash') return false
    try { return bashCommand(JSON.parse(event.data.arguments)) === setupCommand } catch { return false }
  })
  const call = calls[0]
  const eventIndex = agent.session.events.indexOf(event)
  if (calls.length !== 1 || call?.type !== 'tool/call'
    || call.data.callId !== data.setup_call_id
    || eventIndex <= agent.session.events.indexOf(call)) {
    throw new Error('Session initialization lacks its exact ordered canonical setup call')
  }
  const owner = await baselineOwner(agent, expectedSession, binding.start.launch)
  if (owner.workspace !== workspace || owner.sessionConfig.path !== sessionConfig.path
    || owner.sessionConfig.sha256 !== sessionConfig.sha256 || owner.kernel.path !== kernel.path) {
    throw new Error('Session initialization immutable config/kernel identity changed')
  }
  const currentAdapter = await boundedFileBinding(
    adapter.path, MAX_DSH_WORKFLOW_SOURCE_BYTES, 'current KerSor setup-session.sh adapter',
  )
  if (!isDeepStrictEqual(currentAdapter, adapter)) {
    throw new Error('Session initialization adapter is no longer Host-compatible')
  }
  return {
    data,
    receipt: {
      path: receiptPath,
      sha256: createHash('sha256').update(receiptBytes).digest('hex'),
    },
    eventIndex,
    authorityAgent: agent,
    authorityEvents: agent.session.events,
  }
}

async function validateSessionAuthority(
  ctx: Context,
  agent: Agent,
  binding: ExperimentBinding,
  sessionDir: string,
): Promise<SessionInitializationBinding> {
  if (binding.start.origin === 'created') {
    return validateSessionInitialization(agent, binding, sessionDir)
  }
  const imported = agent.session.events.filter(event =>
    event.type === 'kersor/session-authority-imported'
    && event.data.experiment_id === binding.start.experimentId)
  const event = imported[0]
  if (imported.length !== 1 || event === undefined) {
    throw new Error('attached KerSor Session lacks exactly one durable imported Host authority event')
  }
  const data = event.data as unknown as Record<string, unknown>
  const parentId = agent.session.header.parentSession
  const intent = binding.start.authorityIntent
  if (!hasExactKeys(data, SESSION_AUTHORITY_IMPORT_KEYS)
    || data.schema_version !== 1 || data.contract !== 'dsh_session_authority_import_v1'
    || data.authority !== 'dsh_host' || data.experiment_id !== binding.start.experimentId
    || data.workspace !== await canonicalWorkspacePath(workspaceOf(agent))
    || data.session_dir !== sessionDir || data.controller_session_id !== agent.id
    || data.attached_parent_session_id !== parentId
    || data.source_parent_session_id !== binding.start.originSessionId
    || intent === undefined
    || data.attach_call_id !== intent.attach_call_id
    || data.source_controller_session_id !== intent.source_controller_session_id
    || !isDeepStrictEqual(data.source_setup_receipt, intent.source_setup_receipt)
    || !isDeepStrictEqual(data.source_state, intent.source_state)
    || !isDeepStrictEqual(data.source_workflow_catalog, intent.source_workflow_catalog)
    || !nonWhitespaceToken(data.attach_call_id)
    || !nonWhitespaceToken(data.source_controller_session_id)
    || !Number.isSafeInteger(data.source_event_watermark)
    || (data.source_event_watermark as number) < 0
    || !isDeepStrictEqual(data.launch, binding.start.launch)) {
    throw new Error('attached KerSor Session authority import identity/schema is invalid')
  }
  const parent = parentId === undefined ? undefined : ctx.sessions.get(parentId)
  if (parent === undefined) throw new Error('attached KerSor parent Session is unavailable')
  exactAttachedStartCall(parent, binding.start, intent)
  const sourceParent = ctx.sessions.get(binding.start.originSessionId as SessionId)
  const sourceBindings = sourceParent === undefined
    ? []
    : experimentBindings(sourceParent.events).filter(candidate =>
      candidate.start.experimentId === binding.start.experimentId
      && candidate.start.origin === 'created')
  const sourceBinding = sourceBindings[0]
  if (sourceBindings.length !== 1 || sourceBinding === undefined
    || sourceBinding.start.childSessionId !== data.source_controller_session_id) {
    throw new Error('attached KerSor Session source Experiment authority is unavailable')
  }
  const sourceSession = ctx.sessions.get(data.source_controller_session_id as SessionId)
  if (sourceSession === undefined
    || sourceSession.header.parentSession !== binding.start.originSessionId) {
    throw new Error('attached KerSor Session source controller authority is unavailable')
  }
  const watermark = data.source_event_watermark as number
  const prefix = sourceSession.events.filter(candidate => candidate.seq <= watermark)
  if (prefix.length !== watermark + 1
    || prefix.some((candidate, index) => candidate.seq !== index)
    || createHash('sha256').update(canonicalKersorJson(prefix), 'utf8').digest('hex')
      !== data.source_event_sha256) {
    throw new Error('attached KerSor Session source event prefix was truncated or changed')
  }
  const sourceController = agentWithAuthorityEvents(
    { id: sourceSession.id, session: sourceSession } as unknown as Agent,
    prefix,
  )
  const transferEvents = prefix.filter(candidate =>
    candidate.type === 'kersor/session-authority-transferred')
  const transferEvent = transferEvents[0]
  const expectedTransfer = {
    schema_version: 1,
    contract: 'dsh_session_authority_transfer_v1',
    authority: 'dsh_host',
    experiment_id: binding.start.experimentId,
    workspace: intent.workspace,
    session_dir: intent.session_dir,
    source_parent_session_id: intent.source_parent_session_id,
    source_controller_session_id: intent.source_controller_session_id,
    target_parent_session_id: parentId,
    target_controller_session_id: agent.id,
    attach_call_id: intent.attach_call_id,
    launch: binding.start.launch,
    pre_transfer_event_watermark: intent.pre_transfer_event_watermark,
    pre_transfer_event_sha256: intent.pre_transfer_event_sha256,
    source_setup_receipt: intent.source_setup_receipt,
    source_state: intent.source_state,
    source_workflow_catalog: intent.source_workflow_catalog,
  }
  if (transferEvents.length !== 1 || transferEvent?.seq !== watermark
    || !isDeepStrictEqual(transferEvent.data, expectedTransfer)) {
    throw new Error('attached KerSor source prefix lacks its exact terminal authority transfer')
  }
  const transferReceiptPath = join(intent.session_dir, SESSION_AUTHORITY_TRANSFER_RECEIPT)
  const transferReceiptBytes = await readBoundedRegularFile(
    transferReceiptPath, MAX_BASELINE_AUTHORITY_BYTES, 'Session authority transfer Host receipt',
  )
  let transferReceipt: unknown
  try { transferReceipt = JSON.parse(transferReceiptBytes.toString('utf8')) } catch {
    throw new Error('Session authority transfer Host receipt is malformed JSON')
  }
  if (!isDeepStrictEqual(transferReceipt, expectedTransfer)
    || !isDeepStrictEqual(data.source_transfer_receipt, {
      path: transferReceiptPath,
      sha256: createHash('sha256').update(transferReceiptBytes).digest('hex'),
    })) {
    throw new Error('attached KerSor import differs from its source transfer receipt')
  }
  const sourceInitialization = await validateSessionInitialization(
    sourceController, sourceBinding, sessionDir,
  )
  if (!isDeepStrictEqual(data.source_setup_receipt, sourceInitialization.receipt)) {
    throw new Error('attached KerSor Session import differs from its source setup receipt')
  }
  const receiptPath = join(sessionDir, SESSION_AUTHORITY_IMPORT_RECEIPT)
  const receiptBytes = await readBoundedRegularFile(
    receiptPath, MAX_BASELINE_AUTHORITY_BYTES, 'Session authority import Host receipt',
  )
  let receipt: unknown
  try { receipt = JSON.parse(receiptBytes.toString('utf8')) } catch {
    throw new Error('Session authority import Host receipt is malformed JSON')
  }
  if (!isDeepStrictEqual(receipt, data)) {
    throw new Error('Session authority import receipt differs from its durable event')
  }
  return {
    data,
    receipt: {
      path: receiptPath,
      sha256: createHash('sha256').update(receiptBytes).digest('hex'),
    },
    eventIndex: agent.session.events.indexOf(event),
    authorityAgent: sourceController,
    authorityEvents: prefix,
  }
}

async function dispatchAuthorityAgent(
  ctx: Context,
  agent: Agent,
  runDir: string,
): Promise<Agent> {
  const binding = controllerBinding(ctx, agent)?.binding
  if (binding === undefined) throw new Error('dispatch custody lost its Experiment binding')
  const authority = await validateSessionAuthority(ctx, agent, binding, dirname(runDir))
  if (binding.start.origin === 'created') return agent
  const local = agent.session.events.filter(event =>
    event.type === 'kersor/dispatch-args-produced' && event.data.run_dir === runDir)
  const source = authority.authorityEvents.filter(event =>
    event.type === 'kersor/dispatch-args-produced' && event.data.run_dir === runDir)
  if (local.length + source.length !== 1) {
    throw new Error('attached dispatch run must belong to exactly one local or imported Host authority log')
  }
  return local.length === 1 ? agent : authority.authorityAgent
}

function dispatchProducerSpec(argumentsValue: unknown): {
  readonly sessionDir: string
  readonly runDir: string
  readonly workflowName: string
} | undefined {
  const value = record(argumentsValue)
  if (value?.description !== DISPATCH_PRODUCER_DESCRIPTION
    || value.run_in_background !== false
    || typeof value.prompt !== 'string') return undefined
  const lines = value.prompt.split(/\r?\n/)
  if (lines[0] !== DISPATCH_PRODUCER_MARKER) return undefined
  const sessionDir = lines[1]?.startsWith('SESSION_DIR=') ? lines[1].slice(12) : undefined
  const runDir = lines[2]?.startsWith('RUN_DIR=') ? lines[2].slice(8) : undefined
  const workflowName = lines[3]?.startsWith('WORKFLOW_NAME=') ? lines[3].slice(14) : undefined
  return sessionDir && runDir && workflowName ? { sessionDir, runDir, workflowName } : undefined
}

async function durableDispatchProducerCallIds(agent: Agent, runDir: string): Promise<string[]> {
  const matches: string[] = []
  for (const event of agent.session.events) {
    if (event.type !== 'tool/call' || event.data.name !== 'subagent') continue
    let argumentsValue: unknown
    try { argumentsValue = JSON.parse(event.data.arguments) } catch { continue }
    const spec = dispatchProducerSpec(argumentsValue)
    if (spec === undefined || !isAbsolute(spec.runDir)) continue
    let candidate = resolve(spec.runDir)
    try { candidate = await realpath(candidate) } catch { /* fail closed below */ }
    if (candidate === runDir) matches.push(event.data.callId)
  }
  return matches
}

async function durableDispatchTransformationCallIds(
  agent: Agent,
  runDir: string,
): Promise<string[]> {
  const matches: string[] = []
  for (const event of agent.session.events) {
    if (event.type !== 'tool/call' || event.data.name !== 'bash') continue
    let argumentsValue: unknown
    try { argumentsValue = JSON.parse(event.data.arguments) } catch { continue }
    const command = bashCommand(argumentsValue)
    if (command !== undefined && await isRuntimeControlsCommand(command, runDir)) {
      matches.push(event.data.callId)
    }
  }
  return matches
}

async function durableCandidateSealCallIds(agent: Agent, runDir: string): Promise<string[]> {
  const matches: string[] = []
  for (const event of agent.session.events) {
    if (event.type !== 'tool/call' || event.data.name !== 'bash') continue
    let argumentsValue: unknown
    try { argumentsValue = JSON.parse(event.data.arguments) } catch { continue }
    const command = bashCommand(argumentsValue)
    if (command !== undefined && command === await canonicalCandidateOwnershipSealCommand(runDir)) {
      matches.push(event.data.callId)
    }
  }
  return matches
}

async function durableBaselineCallIds(
  agent: Agent,
  phase: BaselinePhase,
  sessionDir: string,
  workspace: string,
  launch: KersorLaunchContract,
): Promise<string[]> {
  const canonical = await canonicalBaselineCommand(phase, sessionDir, workspace, launch)
  const matches: string[] = []
  for (const event of agent.session.events) {
    if (event.type !== 'tool/call' || event.data.name !== 'bash') continue
    let argumentsValue: unknown
    try { argumentsValue = JSON.parse(event.data.arguments) } catch { continue }
    if (bashCommand(argumentsValue) === canonical) matches.push(event.data.callId)
  }
  return matches
}

async function atomicHostReceipt(
  target: string,
  payload: unknown,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(target, 'wx', 0o600)
  } catch (error: unknown) {
    throw new Error(`Host receipt already exists or cannot be created: ${target}: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function idempotentHostReceipt(
  target: string,
  payload: unknown,
  label: string,
): Promise<{ readonly path: string; readonly sha256: string }> {
  try {
    await atomicHostReceipt(target, payload)
  } catch (error: unknown) {
    if (nodeErrorCode(error) !== 'EEXIST'
      && !(error instanceof Error && error.message.includes('already exists'))) {
      throw error
    }
    const existing = await readBoundedRegularFile(target, MAX_BASELINE_AUTHORITY_BYTES, label)
    let decoded: unknown
    try { decoded = JSON.parse(existing.toString('utf8')) } catch {
      throw new Error(`${label} exists with malformed JSON`)
    }
    if (!isDeepStrictEqual(decoded, payload)) {
      throw new Error(`${label} exists with different Host authority bytes`)
    }
    return {
      path: target,
      sha256: createHash('sha256').update(existing).digest('hex'),
    }
  }
  const bytes = await readBoundedRegularFile(target, MAX_BASELINE_AUTHORITY_BYTES, label)
  return { path: target, sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function dispatchFileBinding(path: string, label: string): Promise<{ path: string; sha256: string }> {
  const bytes = await readBoundedRegularFile(path, MAX_DSH_DISPATCH_ARGS_BYTES, label)
  return { path, sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function durableWorkflowCallIds(agent: Agent, runDir: string): Promise<string[]> {
  const matches: string[] = []
  for (const event of agent.session.events) {
    if (event.type !== 'tool/call' || event.data.name !== 'kersor_workflow') continue
    let argumentsValue: unknown
    try {
      argumentsValue = JSON.parse(event.data.arguments)
    } catch {
      continue
    }
    const expDir = record(argumentsValue)?.exp_dir
    if (typeof expDir !== 'string' || !isAbsolute(expDir)) continue
    let candidate = resolve(expDir)
    try {
      candidate = await realpath(candidate)
    } catch {
      // A missing historical path cannot alias the current existing run.
    }
    if (candidate === runDir) matches.push(event.data.callId)
  }
  return matches
}

async function consumeWorkflowRun(
  runDir: string,
  agent: Agent,
  callId: string,
  hostGate: WorkflowHostGateState,
): Promise<void> {
  const durableCalls = await durableWorkflowCallIds(agent, runDir)
  if (durableCalls.length !== 1 || durableCalls[0] !== callId) {
    throw new Error(`KerSor Workflow run is already consumed by an earlier durable controller tool/call: ${runDir}`)
  }
  if (hostGate.consumedRuns.has(runDir)) {
    throw new Error(`KerSor Workflow run is already consumed in this Host lifetime: ${runDir}`)
  }
  hostGate.consumedRuns.add(runDir)
  const receiptPath = join(runDir, 'workflow-call-receipt.json')
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(receiptPath, 'wx', 0o600)
  } catch (error: unknown) {
    if (nodeErrorCode(error) === 'EEXIST') {
      throw new Error(`KerSor Workflow run is already consumed by its durable Host receipt: ${runDir}`)
    }
    throw new Error(`KerSor Workflow call could not create its durable Host receipt: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    await handle.writeFile(`${JSON.stringify({
      schema_version: 1,
      contract: 'kersor_workflow_call_v1',
      run_dir: runDir,
      agent_session_id: agent.id,
      call_id: callId,
    }, null, 2)}\n`, 'utf8')
    await handle.sync()
  } catch (error: unknown) {
    throw new Error(`KerSor Workflow call could not persist its durable Host receipt: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await handle.close()
  }
}

function workflowCallContract(argumentsValue: unknown): WorkflowCallContract {
  const call = record(argumentsValue)
  const meta = record(call?.meta)
  const args = record(call?.args)
  if (meta === undefined || args === undefined || typeof call?.script !== 'string') {
    throw new Error('workflow call must carry object meta, string script, and object args')
  }
  return { meta, script: call.script, args }
}

async function readDshWorkflowEnvelope(runDir: string): Promise<Record<string, unknown>> {
  const envelopePath = join(runDir, 'dsh-workflow.json')
  let identity: Awaited<ReturnType<typeof lstat>>
  try {
    identity = await lstat(envelopePath)
  } catch (error: unknown) {
    if (nodeErrorCode(error) === 'ENOENT') {
      throw new Error(`required Workflow envelope is missing: ${envelopePath}`)
    }
    throw new Error(`Workflow envelope cannot be inspected: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (identity.isSymbolicLink()) throw new Error('Workflow envelope dsh-workflow.json must not be a symlink')
  if (!identity.isFile()) throw new Error('Workflow envelope dsh-workflow.json must be a regular file')
  if (identity.size > MAX_DSH_WORKFLOW_ENVELOPE_BYTES) {
    throw new Error(`Workflow envelope exceeds the ${MAX_DSH_WORKFLOW_ENVELOPE_BYTES}-byte limit`)
  }
  const realEnvelope = await realpath(envelopePath)
  if (realEnvelope !== envelopePath) {
    throw new Error('Workflow envelope dsh-workflow.json contains a symlink or path alias')
  }
  const handle = await open(
    envelopePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  )
  try {
    const current = await handle.stat()
    if (!current.isFile()) throw new Error('Workflow envelope dsh-workflow.json must be a regular file')
    if (current.size > MAX_DSH_WORKFLOW_ENVELOPE_BYTES) {
      throw new Error(`Workflow envelope exceeds the ${MAX_DSH_WORKFLOW_ENVELOPE_BYTES}-byte limit`)
    }
    const bytes = Buffer.alloc(MAX_DSH_WORKFLOW_ENVELOPE_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length)
      if (read.bytesRead === 0) break
      length += read.bytesRead
    }
    if (length > MAX_DSH_WORKFLOW_ENVELOPE_BYTES) {
      throw new Error(`Workflow envelope exceeds the ${MAX_DSH_WORKFLOW_ENVELOPE_BYTES}-byte limit`)
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(bytes.subarray(0, length).toString('utf8'))
    } catch {
      throw new Error('Workflow envelope dsh-workflow.json is malformed JSON')
    }
    const envelope = record(decoded)
    if (envelope === undefined
      || envelope.schema_version !== 1
      || envelope.contract !== 'dsh_workflow_v1'
      || record(envelope.meta) === undefined
      || typeof envelope.script !== 'string'
      || record(envelope.args) === undefined) {
      throw new Error('Workflow envelope must be a dsh_workflow_v1 object with meta, script, and args')
    }
    await validateWorkflowSourceBinding(runDir, envelope)
    return envelope
  } finally {
    await handle.close()
  }
}

function normalizedSha256(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a SHA-256 string`)
  const normalized = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a lowercase hexadecimal SHA-256 string`)
  }
  return normalized
}

function maskJavaScriptSource(source: string): string {
  const chars = source.split('')
  let state: 'code' | 'line-comment' | 'block-comment' | 'string' | 'regex' = 'code'
  let quote = ''
  let regexClass = false
  let lastSignificant = ''
  for (let index = 0; index < source.length; index += 1) {
    const current = source.charAt(index)
    const next = source[index + 1]
    if (state === 'code') {
      if (current === '/' && next === '/') {
        chars[index] = chars[index + 1] = ' '
        index += 1
        state = 'line-comment'
      } else if (current === '/' && next === '*') {
        chars[index] = chars[index + 1] = ' '
        index += 1
        state = 'block-comment'
      } else if (current === '\'' || current === '"' || current === '`') {
        chars[index] = ' '
        quote = current
        state = 'string'
      } else if (current === '/' && (!lastSignificant || '=([{,:;!?&|'.includes(lastSignificant))) {
        chars[index] = ' '
        regexClass = false
        state = 'regex'
      } else if (!/\s/.test(current)) {
        lastSignificant = current
      }
    } else if (state === 'line-comment') {
      if (current === '\n') state = 'code'
      else chars[index] = ' '
    } else if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        chars[index] = chars[index + 1] = ' '
        index += 1
        state = 'code'
      } else if (current !== '\n') chars[index] = ' '
    } else if (state === 'string') {
      if (current === '\\') {
        chars[index] = ' '
        if (index + 1 < chars.length) chars[index + 1] = ' '
        index += 1
      } else if (current === quote) {
        chars[index] = ' '
        state = 'code'
      } else if (current !== '\n') chars[index] = ' '
    } else {
      chars[index] = current === '\n' ? '\n' : ' '
      if (current === '\\') {
        if (index + 1 < chars.length) chars[index + 1] = ' '
        index += 1
      } else if (current === '[') {
        regexClass = true
      } else if (current === ']') {
        regexClass = false
      } else if (current === '/' && !regexClass) {
        state = 'code'
        lastSignificant = '/'
      }
    }
  }
  return chars.join('')
}

function balancedObjectEnd(source: string, openIndex: number): number {
  if (source[openIndex] !== '{') throw new Error('Workflow meta object must start with {')
  let depth = 0
  let state: 'code' | 'line-comment' | 'block-comment' | 'string' = 'code'
  let quote = ''
  for (let index = openIndex; index < source.length; index += 1) {
    const current = source.charAt(index)
    const next = source[index + 1]
    if (state === 'code') {
      if (current === '/' && next === '/') {
        index += 1
        state = 'line-comment'
      } else if (current === '/' && next === '*') {
        index += 1
        state = 'block-comment'
      } else if (current === '\'' || current === '"' || current === '`') {
        quote = current
        state = 'string'
      } else if (current === '{') {
        depth += 1
      } else if (current === '}') {
        depth -= 1
        if (depth === 0) return index + 1
      }
    } else if (state === 'line-comment') {
      if (current === '\n') state = 'code'
    } else if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        index += 1
        state = 'code'
      }
    } else if (current === '\\') {
      index += 1
    } else if (current === quote) {
      state = 'code'
    }
  }
  throw new Error('Workflow meta object is unterminated')
}

function staticJsonObject(source: string, label: string): Record<string, unknown> {
  let encoded: unknown
  try {
    const context = createContext(undefined, {
      codeGeneration: { strings: false, wasm: false },
    })
    const value = new Script(`(${source})`, { filename: label })
      .runInContext(context, { timeout: 250 }) as unknown
    encoded = JSON.stringify(value)
  } catch (error: unknown) {
    throw new Error(`${label} must be one static JSON-compatible object literal: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof encoded !== 'string') throw new Error(`${label} must be JSON-serializable`)
  const value = record(JSON.parse(encoded))
  if (value === undefined) throw new Error(`${label} must evaluate to an object`)
  return value
}

interface ProjectedWorkflowMeta {
  readonly projected: Record<string, unknown>
  readonly provenance: Record<string, unknown>
}

function projectWorkflowMeta(meta: Record<string, unknown>): ProjectedWorkflowMeta {
  if (typeof meta.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(meta.name)) {
    throw new Error('selected Workflow meta.name must be short kebab-case')
  }
  if (typeof meta.description !== 'string' || meta.description.trim().length === 0) {
    throw new Error('selected Workflow meta.description must be a non-empty string')
  }
  const camelWhen = meta.whenToUse
  const snakeWhen = meta.when_to_use
  if (camelWhen !== undefined && typeof camelWhen !== 'string') {
    throw new Error('selected Workflow meta.whenToUse must be a string')
  }
  if (snakeWhen !== undefined && typeof snakeWhen !== 'string') {
    throw new Error('selected Workflow meta.when_to_use must be a string')
  }
  if (camelWhen !== undefined && snakeWhen !== undefined && camelWhen !== snakeWhen) {
    throw new Error('selected Workflow meta.whenToUse conflicts with meta.when_to_use')
  }
  let whenProjection = 'absent'
  let whenToUse: string | undefined
  if (typeof camelWhen === 'string') {
    whenToUse = camelWhen
    whenProjection = snakeWhen === undefined ? 'retained_whenToUse' : 'equal_aliases_collapsed'
  } else if (typeof snakeWhen === 'string') {
    whenToUse = snakeWhen
    whenProjection = 'mapped_to_whenToUse'
  }
  let phases: Record<string, string>[] | undefined
  const droppedPhaseFields: { index: number; fields: string[] }[] = []
  if (meta.phases !== undefined) {
    if (!Array.isArray(meta.phases)) throw new Error('selected Workflow meta.phases must be an array')
    phases = meta.phases.map((value, index) => {
      const phase = record(value)
      if (phase === undefined || typeof phase.title !== 'string' || phase.title.length === 0) {
        throw new Error(`selected Workflow meta.phases[${index}].title must be a non-empty string`)
      }
      for (const key of ['detail', 'provider', 'model']) {
        if (phase[key] !== undefined && typeof phase[key] !== 'string') {
          throw new Error(`selected Workflow meta.phases[${index}].${key} must be a string`)
        }
      }
      const dropped = Object.keys(phase).filter(key => !DSH_PHASE_KEYS.includes(key)).sort()
      if (dropped.length > 0) droppedPhaseFields.push({ index, fields: dropped })
      return {
        title: phase.title,
        ...(typeof phase.detail === 'string' ? { detail: phase.detail } : {}),
        ...(typeof phase.provider === 'string' ? { provider: phase.provider } : {}),
        ...(typeof phase.model === 'string' ? { model: phase.model } : {}),
      }
    })
  }
  return {
    projected: {
      name: meta.name,
      description: meta.description,
      ...(whenToUse === undefined ? {} : { whenToUse }),
      ...(phases === undefined ? {} : { phases }),
    },
    provenance: {
      contract: DSH_META_CONTRACT,
      when_to_use: whenProjection,
      dropped_top_level_fields: Object.keys(meta)
        .filter(key => !DSH_META_KEYS.includes(key))
        .sort(),
      dropped_phase_fields: droppedPhaseFields,
    },
  }
}

interface CanonicalWorkflowSource {
  readonly body: string
  readonly originalMeta: Record<string, unknown>
  readonly projectedMeta: Record<string, unknown>
  readonly metaProjection: Record<string, unknown>
}

function canonicalWorkflowSource(source: string): CanonicalWorkflowSource {
  const masked = maskJavaScriptSource(source)
  const declaration = /\bexport\s+const\s+meta\s*=\s*/g
  const matches = [...masked.matchAll(declaration)]
  if (matches.length !== 1) {
    throw new Error(`selected Workflow source must contain exactly one export const meta declaration (found ${matches.length})`)
  }
  const match = matches[0]
  if (match === undefined) throw new Error('selected Workflow meta declaration is missing')
  const open = match.index + match[0].length
  if (source[open] !== '{') throw new Error('selected Workflow meta must use an inline object literal')
  const metaEnd = balancedObjectEnd(source, open)
  const originalMeta = staticJsonObject(source.slice(open, metaEnd), 'selected Workflow meta')
  const projection = projectWorkflowMeta(originalMeta)
  let end = metaEnd
  while (/\s/.test(source[end] ?? '')) end += 1
  if (source[end] === ';') end += 1
  return {
    body: `${source.slice(0, match.index)}${source.slice(end)}`.trim(),
    originalMeta,
    projectedMeta: projection.projected,
    metaProjection: projection.provenance,
  }
}

function dshEffectiveScript(body: string): string {
  return [
    'return await (async () => {',
    `  const ${DSH_AGENT_BINDING_NAME} = ((nativeAgent) => {`,
    '    return (prompt, options = {}) => {',
    '      if (options === null || typeof options !== \'object\' || Array.isArray(options)) {',
    '        return nativeAgent(prompt, options)',
    '      }',
    '      const { provider: _provider, model: _model, toolFilter: _toolFilter, ...inheritedOptions } = options',
    '      return nativeAgent(prompt, {',
    '        ...inheritedOptions,',
    `        toolFilter: { allow: ${JSON.stringify(DSH_ALLOWED_CHILD_TOOLS)} },`,
    '      })',
    '    }',
    '  })(agent)',
    '  Object.defineProperty(globalThis, \'agent\', {',
    `    value: ${DSH_AGENT_BINDING_NAME},`,
    '    writable: false,',
    '    configurable: false,',
    '    enumerable: true,',
    '  })',
    '  {',
    `    const agent = ${DSH_AGENT_BINDING_NAME}`,
    body,
    '  }',
    '})()',
  ].join('\n')
}

async function readBoundedRegularFile(path: string, limit: number, label: string): Promise<Buffer> {
  let identity: Awaited<ReturnType<typeof lstat>>
  try {
    identity = await lstat(path)
  } catch (error: unknown) {
    throw new Error(`${label} is missing or cannot be inspected: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (identity.isSymbolicLink()) throw new Error(`${label} must not be a symlink`)
  if (!identity.isFile()) throw new Error(`${label} must be a regular file`)
  if (identity.size > limit) throw new Error(`${label} exceeds the ${limit}-byte limit`)
  if (await realpath(path) !== path) throw new Error(`${label} contains a symlink or path alias`)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const current = await handle.stat()
    if (!current.isFile()) throw new Error(`${label} must be a regular file`)
    if (current.size > limit) throw new Error(`${label} exceeds the ${limit}-byte limit`)
    const bytes = Buffer.alloc(limit + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length)
      if (read.bytesRead === 0) break
      length += read.bytesRead
    }
    if (length > limit) throw new Error(`${label} exceeds the ${limit}-byte limit`)
    return bytes.subarray(0, length)
  } finally {
    await handle.close()
  }
}

async function readBoundedJsonObject(path: string, limit: number, label: string): Promise<Record<string, unknown>> {
  const bytes = await readBoundedRegularFile(path, limit, label)
  let decoded: unknown
  try {
    decoded = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error(`${label} is malformed JSON`)
  }
  const value = record(decoded)
  if (value === undefined) throw new Error(`${label} must contain a JSON object`)
  return value
}

function catalogEntries(catalog: Record<string, unknown>): readonly unknown[] {
  if (!Array.isArray(catalog.workflows)) {
    throw new Error('workflow-catalog.json must contain a workflows array')
  }
  return catalog.workflows
}

async function hostSelectedWorkflowName(runDir: string): Promise<string> {
  const sessionDir = dirname(runDir)
  const round = Number.parseInt(basename(runDir).slice('run-'.length), 10)
  const selectionName = `round-${round}-selection.json`
  const catalogPath = join(sessionDir, 'workflow-catalog.json')
  const selection = await readBoundedJsonObject(
    join(sessionDir, selectionName),
    MAX_KERSOR_SELECTION_BYTES,
    selectionName,
  )
  if (selection.round !== round || selection.session_dir !== sessionDir
    || selection.catalog_path !== catalogPath) {
    throw new Error(`${selectionName} does not identify this exact Session, round, and workflow-catalog.json`)
  }
  const selected = record(selection.selected_workflow)
  if (selected === undefined || selected.name === 'STALLED') {
    throw new Error(`${selectionName} must contain one non-STALLED selected_workflow`)
  }
  if (typeof selected.name !== 'string' || typeof selected.directory !== 'string'
    || typeof selected.candidate_type !== 'string') {
    throw new Error(`${selectionName} selected_workflow identity is incomplete`)
  }
  const selectedHash = normalizedSha256(
    selected.workflow_content_hash,
    `${selectionName} selected_workflow.workflow_content_hash`,
  )
  const catalog = await readBoundedJsonObject(
    catalogPath,
    MAX_KERSOR_CATALOG_BYTES,
    'workflow-catalog.json',
  )
  const matches = catalogEntries(catalog)
    .map(entry => record(entry))
    .filter(entry => entry?.name === selected.name)
  if (matches.length !== 1) {
    throw new Error(`workflow-catalog.json must contain exactly one entry selected by ${selectionName}`)
  }
  const catalogEntry = matches[0]
  if (catalogEntry === undefined || catalogEntry.directory !== selected.directory
    || catalogEntry.candidate_type !== selected.candidate_type) {
    throw new Error(`workflow-catalog.json identity differs from ${selectionName} selected_workflow`)
  }
  if (normalizedSha256(
    catalogEntry.workflow_content_hash,
    'workflow-catalog.json selected workflow_content_hash',
  ) !== selectedHash) {
    throw new Error(`workflow-catalog.json workflow_content_hash differs from ${selectionName}`)
  }
  return selected.name
}

async function validateWorkflowSourceBinding(
  runDir: string,
  envelope: Record<string, unknown>,
): Promise<void> {
  const sessionDir = dirname(runDir)
  const runName = basename(runDir)
  const round = Number.parseInt(runName.slice('run-'.length), 10)
  const selectionName = `round-${round}-selection.json`
  const selectionPath = join(sessionDir, selectionName)
  const catalogPath = join(sessionDir, 'workflow-catalog.json')
  const selection = await readBoundedJsonObject(
    selectionPath,
    MAX_KERSOR_SELECTION_BYTES,
    selectionName,
  )
  if (selection.round !== round || selection.session_dir !== sessionDir || selection.catalog_path !== catalogPath) {
    throw new Error(`${selectionName} does not identify this exact Session, round, and workflow-catalog.json`)
  }
  const selected = record(selection.selected_workflow)
  if (selected === undefined || selected.name === 'STALLED') {
    throw new Error(`${selectionName} must contain one non-STALLED selected_workflow`)
  }
  if (typeof selected.name !== 'string'
    || typeof selected.directory !== 'string'
    || typeof selected.candidate_type !== 'string') {
    throw new Error(`${selectionName} selected_workflow identity is incomplete`)
  }
  const selectedHash = normalizedSha256(
    selected.workflow_content_hash,
    `${selectionName} selected_workflow.workflow_content_hash`,
  )
  const catalog = await readBoundedJsonObject(
    catalogPath,
    MAX_KERSOR_CATALOG_BYTES,
    'workflow-catalog.json',
  )
  const matches = catalogEntries(catalog)
    .map(entry => record(entry))
    .filter(entry => entry?.name === selected.name)
  if (matches.length !== 1) {
    throw new Error(`workflow-catalog.json must contain exactly one entry selected by ${selectionName}`)
  }
  const catalogEntry = matches[0]
  if (catalogEntry === undefined) {
    throw new Error(`workflow-catalog.json entry selected by ${selectionName} is missing`)
  }
  if (catalogEntry.directory !== selected.directory
    || catalogEntry.candidate_type !== selected.candidate_type) {
    throw new Error(`workflow-catalog.json identity differs from ${selectionName} selected_workflow`)
  }
  const catalogHash = normalizedSha256(
    catalogEntry.workflow_content_hash,
    'workflow-catalog.json selected workflow_content_hash',
  )
  if (catalogHash !== selectedHash) {
    throw new Error(`workflow-catalog.json workflow_content_hash differs from ${selectionName}`)
  }
  const source = record(envelope.source)
  const meta = record(envelope.meta)
  if (source === undefined || meta?.name !== selected.name) {
    throw new Error(`dsh-workflow.json source/meta does not identify the Workflow selected by ${selectionName}`)
  }
  if (typeof source.workflow_path !== 'string' || !isAbsolute(source.workflow_path)) {
    throw new Error('dsh-workflow.json source.workflow_path must be an absolute path')
  }
  const workflowPath = resolve(source.workflow_path)
  if (workflowPath !== source.workflow_path) {
    throw new Error('dsh-workflow.json source.workflow_path must be lexically canonical')
  }
  if (selected.candidate_type === 'authored') {
    if (selected.directory.length === 0
      || selected.directory === '.'
      || selected.directory === '..'
      || selected.directory.includes('/')
      || selected.directory.includes('\\')) {
      throw new Error(`${selectionName} authored selected_workflow.directory must be one safe path segment`)
    }
    const expected = join(
      sessionDir,
      'workflow-authoring',
      'proposals',
      selected.directory,
      'workflow.js',
    )
    if (workflowPath !== expected) {
      throw new Error(`authored source selected by ${selectionName} must be the canonical proposal workflow.js`)
    }
  }
  const catalogJsPath = catalogEntry.js_path
  if (typeof catalogJsPath !== 'string' || catalogJsPath.length === 0) {
    throw new Error('workflow-catalog.json selected js_path is missing')
  }
  if (isAbsolute(catalogJsPath)) {
    if (resolve(catalogJsPath) !== workflowPath) {
      throw new Error(`workflow-catalog.json selected js_path differs from ${selectionName} source`)
    }
  } else {
    const normalizedRelative = relative('/', resolve('/', catalogJsPath))
    if (normalizedRelative !== catalogJsPath
      || !workflowPath.endsWith(`${sep}${normalizedRelative}`)) {
      throw new Error(`workflow-catalog.json selected relative js_path does not resolve to ${selectionName} source`)
    }
  }
  const sourceHash = normalizedSha256(
    source.workflow_sha256,
    'dsh-workflow.json source.workflow_sha256',
  )
  if (sourceHash !== selectedHash) {
    throw new Error(`dsh-workflow.json source.workflow_sha256 differs from ${selectionName} selected_workflow.workflow_content_hash`)
  }
  const workflowBytes = await readBoundedRegularFile(
    workflowPath,
    MAX_DSH_WORKFLOW_SOURCE_BYTES,
    'selected Workflow source',
  )
  const actualHash = createHash('sha256').update(workflowBytes).digest('hex')
  if (actualHash !== sourceHash) {
    throw new Error('selected Workflow source bytes differ from the sealed workflow_content_hash')
  }
  const canonicalSource = canonicalWorkflowSource(workflowBytes.toString('utf8'))
  if (!isDeepStrictEqual(meta, canonicalSource.projectedMeta)) {
    throw new Error('dsh-workflow.json meta does not equal the Host projection of the selected canonical Workflow source')
  }
  const actualBodyHash = createHash('sha256').update(canonicalSource.body, 'utf8').digest('hex')
  const expectedEffectiveScript = dshEffectiveScript(canonicalSource.body)
  if (envelope.script !== expectedEffectiveScript) {
    throw new Error('dsh-workflow.json script does not derive from the selected canonical Workflow source')
  }
  const compatibility = await readBoundedJsonObject(
    join(runDir, 'dsh-compatibility.json'),
    MAX_DSH_COMPATIBILITY_BYTES,
    'dsh-compatibility.json',
  )
  if (compatibility.schema_version !== 1 || compatibility.gate !== 'dsh_workflow_v1') {
    throw new Error('dsh-compatibility.json must carry the dsh_workflow_v1 gate')
  }
  if (compatibility.verdict !== 'pass' || !Array.isArray(compatibility.errors)
    || compatibility.errors.length !== 0) {
    throw new Error('dsh-compatibility.json verdict must be pass with no errors')
  }
  if (compatibility.workflow_source !== workflowPath) {
    throw new Error('dsh-compatibility.json workflow_source differs from dsh-workflow.json source.workflow_path')
  }
  if (normalizedSha256(
    compatibility.workflow_sha256,
    'dsh-compatibility.json workflow_sha256',
  ) !== sourceHash) {
    throw new Error('dsh-compatibility.json workflow_sha256 differs from the selected Workflow source')
  }
  const originalMetaHash = createHash('sha256')
    .update(JSON.stringify(canonicalSource.originalMeta), 'utf8')
    .digest('hex')
  const projectedMetaHash = createHash('sha256')
    .update(JSON.stringify(canonicalSource.projectedMeta), 'utf8')
    .digest('hex')
  if (normalizedSha256(
    source.original_meta_sha256,
    'dsh-workflow.json source.original_meta_sha256',
  ) !== originalMetaHash
    || normalizedSha256(
      compatibility.original_meta_sha256,
      'dsh-compatibility.json original_meta_sha256',
    ) !== originalMetaHash
    || normalizedSha256(
      source.projected_meta_sha256,
      'dsh-workflow.json source.projected_meta_sha256',
    ) !== projectedMetaHash
    || normalizedSha256(
      compatibility.projected_meta_sha256,
      'dsh-compatibility.json projected_meta_sha256',
    ) !== projectedMetaHash) {
    throw new Error('DSH meta hashes differ from the Host projection of the selected Workflow source')
  }
  if (!isDeepStrictEqual(source.meta_projection, canonicalSource.metaProjection)
    || !isDeepStrictEqual(compatibility.meta_projection, {
      ...canonicalSource.metaProjection,
      original_meta: canonicalSource.originalMeta,
    })) {
    throw new Error('DSH meta_projection differs from the Host projection of the selected Workflow source')
  }
  const args = record(envelope.args)
  if (args === undefined || typeof source.args_path !== 'string' || !isAbsolute(source.args_path)) {
    throw new Error('dsh-workflow.json must carry object args and an absolute source.args_path')
  }
  const argsPath = resolve(source.args_path)
  const expectedArgsPath = join(runDir, 'dispatch-args.json')
  if (argsPath !== source.args_path || argsPath !== expectedArgsPath
    || compatibility.args_source !== argsPath) {
    throw new Error('dsh-compatibility.json and dsh-workflow.json must identify this run\'s exact dispatch-args.json')
  }
  const persistedArgs = await readBoundedJsonObject(
    argsPath,
    MAX_DSH_DISPATCH_ARGS_BYTES,
    'dispatch-args.json',
  )
  if (!isDeepStrictEqual(persistedArgs, args)) {
    throw new Error('dispatch-args.json differs from dsh-workflow.json args')
  }
  const argsHash = createHash('sha256').update(JSON.stringify(args), 'utf8').digest('hex')
  if (normalizedSha256(source.args_sha256, 'dsh-workflow.json source.args_sha256') !== argsHash
    || normalizedSha256(
      compatibility.args_sha256,
      'dsh-compatibility.json args_sha256',
    ) !== argsHash) {
    throw new Error('DSH args_sha256 fields differ from the canonical envelope args')
  }
  const bodyHash = normalizedSha256(source.body_sha256, 'dsh-workflow.json source.body_sha256')
  if (bodyHash !== actualBodyHash || normalizedSha256(
    compatibility.body_sha256,
    'dsh-compatibility.json body_sha256',
  ) !== bodyHash) {
    throw new Error('DSH body_sha256 fields differ from the selected canonical Workflow body')
  }
  const effectiveHash = createHash('sha256')
    .update(expectedEffectiveScript, 'utf8')
    .digest('hex')
  if (normalizedSha256(
    source.effective_script_sha256,
    'dsh-workflow.json source.effective_script_sha256',
  ) !== effectiveHash
    || normalizedSha256(
      compatibility.effective_script_sha256,
      'dsh-compatibility.json effective_script_sha256',
    ) !== effectiveHash) {
    throw new Error('DSH effective_script_sha256 fields differ from the executable envelope script')
  }
  if (source.model_policy !== DSH_MODEL_POLICY
    || compatibility.model_policy !== DSH_MODEL_POLICY
    || !isDeepStrictEqual(source.child_tool_policy, DSH_CHILD_TOOL_POLICY)
    || !isDeepStrictEqual(compatibility.child_tool_policy, DSH_CHILD_TOOL_POLICY)) {
    throw new Error('DSH policy must use inherit_controller with the exact read-only child tool allowlist')
  }
}

const PRODUCER_RECEIPT_KEYS = Object.freeze([
  'schema_version', 'contract', 'authority', 'session_dir', 'run_dir', 'round',
  'workflow_name', 'controller_session_id', 'producer_session_id', 'producer_call_id',
  'dispatch_args', 'dispatch_args_provenance',
])
const TRANSFORMATION_RECEIPT_KEYS = Object.freeze([
  'schema_version', 'contract', 'authority', 'transformer', 'session_dir', 'run_dir',
  'round', 'workflow_name', 'controller_session_id', 'transformation_call_id',
  'producer_receipt', 'input', 'output', 'changed', 'authorized_fields',
])
const BASELINE_COMMON_KEYS = Object.freeze([
  'schema_version', 'contract', 'authority', 'launch', 'workspace', 'session_dir',
  'controller_session_id', 'call_id', 'session_config', 'task_dir', 'kernel',
  'test_method', 'commands',
])
const BASELINE_RECORDED_KEYS = Object.freeze([
  ...BASELINE_COMMON_KEYS, 'initialization_receipt', 'witness', 'executions',
])
const BASELINE_VERIFIED_KEYS = Object.freeze([
  ...BASELINE_COMMON_KEYS, 'recording_receipt', 'witness', 'executions',
  'protected_files', 'worktree', 'verdict',
])
const BASELINE_WITNESS_KEYS = Object.freeze([
  'schema_version', 'verdict', 'session', 'source', 'commands', 'recorded_at',
  'executions', 'policy',
])
const BASELINE_EXECUTION_KEYS = Object.freeze([
  'kind', 'command', 'shell', 'started_at', 'finished_at', 'exit_code',
  'timed_out', 'stdout', 'stderr', 'stdout_truncated', 'stderr_truncated',
])
const SESSION_STATE_KEYS = Object.freeze([
  'schema_version', 'phase', 'current_round', 'stall_count', 'pending_terminal',
  'prepared', 'session_id', 'target_speedup', 'target_override', 'workflows_filter',
  'seed_origin', 'kernel_language', 'backend', 'integration_pattern', 'yolo',
  'extensions',
])

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())
}

function nonWhitespaceToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/\s/.test(value)
}

function receiptFileBinding(
  owner: Record<string, unknown>,
  key: string,
  expectedPath: string,
  label: string,
): { path: string; sha256: string } {
  const binding = record(owner[key])
  if (binding === undefined || !hasExactKeys(binding, ['path', 'sha256'])
    || binding.path !== expectedPath) {
    throw new Error(`${label} ${key} path binding is invalid`)
  }
  return {
    path: expectedPath,
    sha256: normalizedSha256(binding.sha256, `${label} ${key} hash`),
  }
}

function authorizedDispatchFields(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a sorted unique deterministic allowlist subset`)
  }
  const fields: unknown[] = value
  if (!fields.every((field): field is string => typeof field === 'string')
    || !isDeepStrictEqual(fields, [...new Set(fields)].sort())
    || fields.some(field => !allowed.has(field))) {
    throw new Error(`${label} must be a sorted unique deterministic allowlist subset`)
  }
  return fields
}

interface DispatchCustodyBinding {
  readonly producer: KersorDispatchArgsProducedEventData
  readonly producerReceiptPath: string
  readonly producerReceiptSha256: string
  readonly transformation: KersorDispatchArgsTransformedEventData
  readonly transformationReceiptPath: string
  readonly transformationReceiptSha256: string
  readonly currentArgs: { readonly path: string; readonly sha256: string }
  readonly currentProvenance: { readonly path: string; readonly sha256: string }
}

interface CandidateOwnershipSealBinding {
  readonly path: string
  readonly sha256: string
  readonly baselineVerifiedEventIndex: number
  readonly protectedFiles: Record<string, string>
  readonly worktree: Record<string, unknown>
  readonly state: { readonly path: string; readonly sha256: string }
}

interface GitCommandResult {
  readonly code: number
  readonly stdout: Buffer
  readonly stderr: Buffer
}

async function runGitCommand(root: string, args: readonly string[]): Promise<GitCommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let exceeded = false
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_GIT_COMMAND_OUTPUT_BYTES) {
        exceeded = true
        child.kill()
      } else {
        stdout.push(chunk)
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes <= MAX_GIT_COMMAND_OUTPUT_BYTES) stderr.push(chunk)
    })
    child.once('error', rejectCommand)
    child.once('close', (code) => {
      if (exceeded || stderrBytes > MAX_GIT_COMMAND_OUTPUT_BYTES) {
        rejectCommand(new Error('git ownership snapshot exceeded its bounded Host output limit'))
        return
      }
      resolveCommand({
        code: code ?? -1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      })
    })
  })
}

async function requiredGitBytes(root: string, args: readonly string[]): Promise<Buffer> {
  const result = await runGitCommand(root, args)
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed during ownership validation: ${result.stderr.toString('utf8').trim()}`)
  }
  return result.stdout
}

async function sha256RegularFile(path: string, label: string): Promise<string> {
  const identity = await lstat(path).catch((error: unknown) => {
    throw new Error(`${label} is missing or cannot be inspected: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (identity.isSymbolicLink() || !identity.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`)
  }
  if (await realpath(path) !== path) throw new Error(`${label} path must be canonical`)
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  const digest = createHash('sha256')
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let offset = 0
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      if (bytesRead === 0) break
      digest.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
  } finally {
    await handle.close()
  }
  return digest.digest('hex')
}

function relativeOwnershipPath(root: string, target: string, label: string): string {
  const value = relative(root, target)
  if (value.length === 0 || isAbsolute(value) || value === '..' || value.startsWith(`..${sep}`)) {
    throw new Error(`${label} escapes the candidate project root`)
  }
  return value.split(sep).join('/')
}

async function collectProtectedFiles(path: string, selected: Set<string>): Promise<void> {
  let identity: Awaited<ReturnType<typeof lstat>>
  try {
    identity = await lstat(path)
  } catch (error: unknown) {
    if (nodeErrorCode(error) === 'ENOENT') return
    throw error
  }
  if (identity.isSymbolicLink()) {
    throw new Error(`protected ownership path must not be a symlink: ${path}`)
  }
  if (identity.isFile()) {
    if (identity.nlink !== 1) {
      throw new Error(`protected ownership file must not be hard-linked: ${path}`)
    }
    if (await realpath(path) !== path) {
      throw new Error(`protected ownership file path must be canonical: ${path}`)
    }
    selected.add(path)
    return
  }
  if (!identity.isDirectory()) {
    throw new Error(`protected ownership path must be a directory or regular file: ${path}`)
  }
  if (await realpath(path) !== path) {
    throw new Error(`protected ownership directory path must be canonical: ${path}`)
  }
  const entries = await readdir(path, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    await collectProtectedFiles(join(path, entry.name), selected)
  }
}

async function candidateGitRoot(projectRoot: string): Promise<string | undefined> {
  const result = await runGitCommand(projectRoot, ['rev-parse', '--show-toplevel'])
  if (result.code !== 0) {
    const diagnostic = result.stderr.toString('utf8').trim()
    if (/\bnot a git repository\b/i.test(diagnostic)) return undefined
    throw new Error(`git ownership discovery failed: ${diagnostic || `exit ${result.code}`}`)
  }
  const declared = result.stdout.toString('utf8').trim()
  if (!isAbsolute(declared)) throw new Error('candidate ownership git root is not absolute')
  const canonical = await realpath(declared)
  if (canonical !== declared) throw new Error('candidate ownership git root is not canonical')
  return canonical
}

async function currentProtectedFiles(
  projectRoot: string,
  kernelPath: string,
  gitRoot: string | undefined,
): Promise<Record<string, string>> {
  const selected = new Set<string>()
  const protectedRoots = [
    kernelPath,
    join(projectRoot, 'problem.py'),
    join(projectRoot, 'kersor-task.json'),
    join(projectRoot, 'tests'),
    join(projectRoot, 'oracles'),
  ]
  for (const path of protectedRoots) await collectProtectedFiles(path, selected)
  if (gitRoot !== undefined) {
    const pathspecs: string[] = []
    for (const path of protectedRoots) {
      if (await pathExists(path)) {
        pathspecs.push(relativeOwnershipPath(gitRoot, await realpath(path), 'protected path'))
      }
    }
    const tracked = await requiredGitBytes(gitRoot, ['ls-files', '-z', '--', ...pathspecs])
    for (const raw of tracked.toString('utf8').split('\0')) {
      if (raw.length === 0) continue
      await collectProtectedFiles(await realpath(join(gitRoot, raw)), selected)
    }
  }
  const result: Record<string, string> = {}
  for (const path of [...selected].sort()) {
    result[relativeOwnershipPath(projectRoot, path, 'protected file')] = await sha256RegularFile(
      path, `protected file ${path}`,
    )
  }
  return result
}

function ownershipMapDifference(
  expected: Record<string, unknown>,
  current: Record<string, unknown>,
): string | undefined {
  for (const path of [...new Set([...Object.keys(expected), ...Object.keys(current)])].sort()) {
    if (!isDeepStrictEqual(expected[path], current[path])) return path
  }
  return undefined
}

async function currentWorktreeSnapshot(
  sessionDir: string,
  gitRoot: string | undefined,
): Promise<Record<string, unknown>> {
  if (gitRoot === undefined) {
    return {
      git_root: null,
      tracked_diff_sha256: null,
      staged_diff_sha256: null,
      untracked: {},
    }
  }
  const tracked = await requiredGitBytes(gitRoot, ['diff', '--binary', '--no-ext-diff', '--', '.'])
  const staged = await requiredGitBytes(
    gitRoot, ['diff', '--cached', '--binary', '--no-ext-diff', '--', '.'],
  )
  const untrackedRaw = await requiredGitBytes(
    gitRoot, ['ls-files', '--others', '--exclude-standard', '-z'],
  )
  const allowedRelative = relative(gitRoot, sessionDir).split(sep).join('/')
  const allowedInsideGit = allowedRelative.length > 0 && allowedRelative !== '..'
    && !allowedRelative.startsWith('../') && !isAbsolute(allowedRelative)
  const untracked: Record<string, string> = {}
  for (const path of untrackedRaw.toString('utf8').split('\0').filter(Boolean).sort()) {
    if (allowedInsideGit && (path === allowedRelative || path.startsWith(`${allowedRelative}/`))) {
      continue
    }
    const candidate = join(gitRoot, path)
    const identity = await stat(candidate).catch(() => undefined)
    if (identity?.isFile()) untracked[path] = await sha256RegularFile(await realpath(candidate), `untracked file ${path}`)
  }
  return {
    git_root: gitRoot,
    tracked_diff_sha256: createHash('sha256').update(tracked).digest('hex'),
    staged_diff_sha256: createHash('sha256').update(staged).digest('hex'),
    untracked,
  }
}

function pathIsStrictlyInside(root: string, target: string): boolean {
  const value = relative(root, target)
  return value.length > 0 && !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`)
}

async function currentSessionState(
  sessionDir: string,
  launch: KersorLaunchContract,
  expectedRound?: number,
  expectedSessionId?: string,
): Promise<{ readonly path: string; readonly sha256: string }> {
  const path = join(sessionDir, 'state.json')
  const bytes = await readBoundedRegularFile(path, MAX_SESSION_STATE_BYTES, 'state.json')
  let decoded: unknown
  try { decoded = JSON.parse(bytes.toString('utf8')) } catch {
    throw new Error('state.json is malformed JSON')
  }
  const state = record(decoded)
  if (state === undefined || !hasExactKeys(state, SESSION_STATE_KEYS)) {
    throw new Error('state.json fields differ from the canonical Session v2 schema')
  }
  const expected: ReadonlyArray<readonly [string, unknown]> = [
    ['schema_version', 2],
    ['phase', 'optimizing'],
    ['target_speedup', launch.target_speedup],
    ['kernel_language', launch.language],
    ['backend', launch.backend],
    ['integration_pattern', launch.integration_pattern],
  ]
  for (const [field, value] of expected) {
    if (!isDeepStrictEqual(state[field], value)) {
      throw new Error(`state.json ${field} differs from the typed launch/config authority`)
    }
  }
  if (!Number.isSafeInteger(state.current_round) || (state.current_round as number) < 1) {
    throw new Error('state.json current_round must be a positive safe integer')
  }
  if (expectedRound !== undefined && state.current_round !== expectedRound) {
    throw new Error('state.json current_round differs from the current run')
  }
  if (!nonWhitespaceToken(state.session_id)) {
    throw new Error('state.json session_id must be a non-empty immutable Host token')
  }
  if (expectedSessionId !== undefined && state.session_id !== expectedSessionId) {
    throw new Error('state.json session_id differs from the Host controller authority')
  }
  if (!Number.isSafeInteger(state.stall_count) || (state.stall_count as number) < 0
    || typeof state.pending_terminal !== 'string'
    || !(state.prepared === null || typeof state.prepared === 'boolean')
    || typeof state.target_override !== 'boolean'
    || !Array.isArray(state.workflows_filter)
    || state.workflows_filter.some(value => typeof value !== 'string')
    || typeof state.seed_origin !== 'string'
    || typeof state.yolo !== 'boolean' || record(state.extensions) === undefined) {
    throw new Error('state.json contains invalid canonical Session state values')
  }
  return { path, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function baselineTime(value: unknown, label: string): number {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty timestamp`)
  }
  const result = Date.parse(value)
  if (!Number.isFinite(result) || !/(?:Z|[+-]\d\d:\d\d)$/u.test(value)) {
    throw new Error(`${label} must be an ISO timestamp with timezone`)
  }
  return result
}

async function baselineOwner(
  agent: Agent,
  sessionDirValue: string,
  launch: KersorLaunchContract,
): Promise<BaselineOwner> {
  const cwd = agent.session.header.cwd
  if (cwd === undefined) throw new Error('baseline custody requires a controller workspace')
  const workspace = await realpath(resolve(cwd))
  if (!isAbsolute(sessionDirValue) || resolve(sessionDirValue) !== sessionDirValue) {
    throw new Error('baseline Session must be one canonical absolute path')
  }
  const sessionDir = await realpath(sessionDirValue)
  const sessionRelative = relative(workspace, sessionDir).split(sep)
  if (sessionDir !== sessionDirValue || sessionRelative.length !== 2
    || sessionRelative[0] !== '.kersor' || sessionRelative[1]?.length === 0
    || !(await stat(sessionDir)).isDirectory()) {
    throw new Error('baseline Session must be one canonical .kersor/<session> child of the controller workspace')
  }
  const sessionConfigPath = join(sessionDir, 'session-config.json')
  const sessionConfigBytes = await readBoundedRegularFile(
    sessionConfigPath, MAX_BASELINE_AUTHORITY_BYTES, 'baseline Session config',
  )
  let configValue: unknown
  try { configValue = JSON.parse(sessionConfigBytes.toString('utf8')) } catch {
    throw new Error('baseline Session config is malformed JSON')
  }
  const config = record(configValue)
  const extensions = record(config?.extensions)
  const kernelPath = config?.kernel_path
  const startedAt = config?.started_at
  if (config === undefined || config.schema_version !== 2
    || config.input_mode !== 'task_directory' || config.task_dir !== workspace
    || typeof kernelPath !== 'string' || !isAbsolute(kernelPath)
    || typeof startedAt !== 'string'
    || config.max_workflows !== launch.max_workflows || config.mode !== launch.mode
    || config.workflow_authoring_budget !== launch.workflow_authoring_budget
    || config.retrieval_mode !== launch.retrieval_mode
    || config.transfer_mode !== launch.transfer_mode
    || config.experience_mode !== launch.experience_mode
    || config.kernelwiki_experience_export_mode
      !== launch.kernelwiki_experience_export_mode
    || config.workflow_catalog !== join(sessionDir, 'workflow-catalog.json')
    || extensions?.agent_runtime !== 'dsh'
    || extensions.integration_pattern_contract !== launch.integration_pattern) {
    throw new Error('baseline Session config does not match the typed launch/workspace authority')
  }
  baselineTime(startedAt, 'session-config.started_at')
  const canonicalKernel = await realpath(kernelPath)
  if (canonicalKernel !== kernelPath || !pathIsStrictlyInside(workspace, canonicalKernel)) {
    throw new Error('baseline kernel must be one canonical file inside the controller workspace')
  }
  await currentSessionState(sessionDir, launch)
  const commands = {
    correctness: launch.correctness_command,
    benchmark: launch.benchmark_command,
  }
  return {
    launch,
    workspace,
    sessionDir,
    taskDir: workspace,
    startedAt,
    sessionConfig: {
      path: sessionConfigPath,
      sha256: createHash('sha256').update(sessionConfigBytes).digest('hex'),
    },
    kernel: {
      path: canonicalKernel,
      sha256: await sha256RegularFile(canonicalKernel, 'baseline kernel'),
    },
    commands,
  }
}

function expectedBaselineTestMethod(commands: BaselineOwner['commands']): string {
  return [
    '# Test Method',
    '',
    `- Correctness Command: ${commands.correctness}`,
    `- Benchmark Command: ${commands.benchmark}`,
    '- Baseline Status: present',
    '',
  ].join('\n')
}

async function baselineAuthority(owner: BaselineOwner): Promise<BaselineAuthority> {
  const current = await baselineOwner(
    { session: { header: { cwd: owner.workspace } } } as unknown as Agent,
    owner.sessionDir,
    owner.launch,
  )
  if (!isDeepStrictEqual(current, owner)) {
    throw new Error('baseline Session config or kernel changed after Host authorization')
  }
  const path = join(owner.sessionDir, 'test-method.md')
  const bytes = await readBoundedRegularFile(
    path, MAX_BASELINE_AUTHORITY_BYTES, 'baseline test method',
  )
  if (bytes.toString('utf8') !== expectedBaselineTestMethod(owner.commands)) {
    throw new Error('baseline test method differs from the deterministic typed-launch owner')
  }
  return {
    ...owner,
    testMethod: { path, sha256: createHash('sha256').update(bytes).digest('hex') },
  }
}

function baselineEventCommon(
  authority: BaselineAuthority,
  controllerSessionId: string,
  callId: string,
): Omit<KersorBaselineInitializedEventData, 'contract'> {
  return {
    schema_version: 1,
    authority: 'dsh_host',
    launch: authority.launch,
    workspace: authority.workspace,
    session_dir: authority.sessionDir,
    controller_session_id: controllerSessionId,
    call_id: callId,
    session_config: authority.sessionConfig,
    task_dir: authority.taskDir,
    kernel: authority.kernel,
    test_method: authority.testMethod,
    commands: authority.commands,
  }
}

function baselineExecution(
  value: unknown,
  expectedKind: 'correctness' | 'benchmark',
  expectedCommand: string,
  sessionStarted: number,
  previousFinished: number,
): { readonly event: KersorBaselineExecutionEventData; readonly finished: number } {
  const execution = record(value)
  if (execution === undefined || !hasExactKeys(execution, BASELINE_EXECUTION_KEYS)
    || execution.kind !== expectedKind || execution.command !== expectedCommand
    || typeof execution.shell !== 'string' || !isAbsolute(execution.shell)
    || execution.timed_out !== false
    || typeof execution.stdout !== 'string' || typeof execution.stderr !== 'string'
    || typeof execution.stdout_truncated !== 'boolean'
    || typeof execution.stderr_truncated !== 'boolean'
    || !Number.isSafeInteger(execution.exit_code)
    || (expectedKind === 'correctness' && execution.exit_code !== 0)) {
    throw new Error(`baseline ${expectedKind} execution evidence is invalid`)
  }
  const started = baselineTime(execution.started_at, `${expectedKind}.started_at`)
  const finished = baselineTime(execution.finished_at, `${expectedKind}.finished_at`)
  if (started < sessionStarted || started < previousFinished || finished < started) {
    throw new Error(`baseline ${expectedKind} execution timestamp order is invalid`)
  }
  return {
    event: {
      kind: expectedKind,
      command: expectedCommand,
      exit_code: execution.exit_code as number,
      timed_out: false,
      stdout_sha256: createHash('sha256').update(execution.stdout, 'utf8').digest('hex'),
      stderr_sha256: createHash('sha256').update(execution.stderr, 'utf8').digest('hex'),
    },
    finished,
  }
}

async function validateBaselineWitness(authority: BaselineAuthority): Promise<{
  readonly binding: { readonly path: string; readonly sha256: string }
  readonly executions: readonly KersorBaselineExecutionEventData[]
}> {
  const path = join(authority.sessionDir, 'baseline-witness.json')
  const bytes = await readBoundedRegularFile(
    path, MAX_BASELINE_AUTHORITY_BYTES, 'baseline witness',
  )
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) } catch {
    throw new Error('baseline witness is malformed JSON')
  }
  const witness = record(value)
  const session = record(witness?.session)
  const source = record(witness?.source)
  const commands = record(witness?.commands)
  const policy = record(witness?.policy)
  if (witness === undefined || !hasExactKeys(witness, BASELINE_WITNESS_KEYS)
    || witness.schema_version !== 1 || witness.verdict !== 'pass'
    || session === undefined || !hasExactKeys(
    session, ['id', 'dir', 'started_at', 'config_sha256'],
  )
    || source === undefined || !hasExactKeys(source, [
    'project_root', 'test_method', 'test_method_sha256_at_record',
    'kernel_path', 'kernel_sha256',
  ])
    || commands === undefined
    || !hasExactKeys(commands, ['Correctness Command', 'Benchmark Command'])
    || policy === undefined || !hasExactKeys(policy, [
    'correctness_exit_zero_required', 'benchmark_exit_zero_required', 'reason',
  ])) {
    throw new Error('baseline witness fields differ from the canonical v1 schema')
  }
  if (source.kernel_path !== authority.kernel.path
    || source.kernel_sha256 !== authority.kernel.sha256) {
    throw new Error(`baseline witness kernel binding changed: ${relative(
      authority.workspace, authority.kernel.path,
    ).split(sep).join('/')}`)
  }
  if (session.id !== basename(authority.sessionDir) || session.dir !== authority.sessionDir
    || session.started_at !== authority.startedAt
    || session.config_sha256 !== authority.sessionConfig.sha256
    || source.project_root !== authority.workspace
    || source.test_method !== authority.testMethod.path
    || source.test_method_sha256_at_record !== authority.testMethod.sha256
    || commands['Correctness Command'] !== authority.commands.correctness
    || commands['Benchmark Command'] !== authority.commands.benchmark
    || policy.correctness_exit_zero_required !== true
    || policy.benchmark_exit_zero_required !== false
    || policy.reason
      !== 'performance-threshold tests may execute a valid baseline and exit nonzero') {
    throw new Error('baseline witness owner bindings differ from Host authority')
  }
  if (!Array.isArray(witness.executions) || witness.executions.length !== 2) {
    throw new Error('baseline witness must contain correctness then benchmark execution evidence')
  }
  const sessionStarted = baselineTime(authority.startedAt, 'session-config.started_at')
  const correctness = baselineExecution(
    witness.executions[0], 'correctness', authority.commands.correctness,
    sessionStarted, sessionStarted,
  )
  const benchmark = baselineExecution(
    witness.executions[1], 'benchmark', authority.commands.benchmark,
    sessionStarted, correctness.finished,
  )
  const recordedAt = baselineTime(witness.recorded_at, 'baseline-witness.recorded_at')
  if (recordedAt < benchmark.finished) {
    throw new Error('baseline witness recorded_at precedes its executions')
  }
  return {
    binding: { path, sha256: createHash('sha256').update(bytes).digest('hex') },
    executions: [correctness.event, benchmark.event],
  }
}

async function validateDispatchCustody(
  agent: Agent,
  runDir: string,
  envelope: Record<string, unknown>,
): Promise<DispatchCustodyBinding> {
  const source = record(envelope.source)
  if (source === undefined) throw new Error('dsh-workflow.json lacks dispatch custody source')
  const sessionDir = dirname(runDir)
  const round = Number.parseInt(basename(runDir).slice('run-'.length), 10)
  const workflowName = record(envelope.meta)?.name
  const producerPath = join(runDir, DISPATCH_PRODUCER_RECEIPT)
  const producerBytes = await readBoundedRegularFile(
    producerPath, MAX_DSH_DISPATCH_RECEIPT_BYTES, DISPATCH_PRODUCER_RECEIPT,
  )
  let producerValue: unknown
  try { producerValue = JSON.parse(producerBytes.toString('utf8')) } catch {
    throw new Error('dispatch producer receipt is malformed JSON')
  }
  const producer = record(producerValue)
  if (producer === undefined || !hasExactKeys(producer, PRODUCER_RECEIPT_KEYS)
    || producer.schema_version !== 1
    || producer.contract !== 'dsh_dispatch_args_producer_v1'
    || producer.authority !== 'dsh_host'
    || producer.session_dir !== sessionDir || producer.run_dir !== runDir
    || producer.round !== round || producer.workflow_name !== workflowName
    || producer.controller_session_id !== agent.id
    || !nonWhitespaceToken(producer.controller_session_id)
    || !nonWhitespaceToken(producer.producer_session_id)
    || !nonWhitespaceToken(producer.producer_call_id)) {
    throw new Error('dispatch producer receipt identity is invalid')
  }
  const argsPath = join(runDir, 'dispatch-args.json')
  const provenancePath = join(runDir, 'dispatch-args-provenance.json')
  const producerArgs = receiptFileBinding(
    producer, 'dispatch_args', argsPath, 'dispatch producer receipt',
  )
  const producerProvenance = receiptFileBinding(
    producer, 'dispatch_args_provenance', provenancePath, 'dispatch producer receipt',
  )
  const producerEvents = agent.session.events.filter(event =>
    event.type === 'kersor/dispatch-args-produced' && event.data.run_dir === runDir)
  const producerEvent = producerEvents[0]
  if (producerEvents.length !== 1 || producerEvent === undefined
    || !isDeepStrictEqual(producerEvent.data, producer)) {
    throw new Error('dispatch producer receipt lacks one matching durable Host event')
  }
  const producerCalls = await durableDispatchProducerCallIds(agent, runDir)
  if (producerCalls.length !== 1 || producerCalls[0] !== producer.producer_call_id) {
    throw new Error('dispatch producer receipt lacks its exact durable foreground producer call')
  }
  const producerHash = createHash('sha256').update(producerBytes).digest('hex')
  if (!isDeepStrictEqual(source.dispatch_args_producer, producer)
    || source.dispatch_args_producer_receipt_path !== producerPath
    || normalizedSha256(
      source.dispatch_args_producer_receipt_sha256,
      'dsh-workflow.json producer receipt hash',
    ) !== producerHash) {
    throw new Error('dsh-workflow.json does not bind the durable producer receipt')
  }
  const compatibility = await readBoundedJsonObject(
    join(runDir, 'dsh-compatibility.json'), MAX_DSH_COMPATIBILITY_BYTES,
    'dsh-compatibility.json',
  )
  if (!isDeepStrictEqual(compatibility.dispatch_args_producer, producer)
    || compatibility.dispatch_args_producer_receipt_source !== producerPath
    || normalizedSha256(
      compatibility.dispatch_args_producer_receipt_sha256,
      'dsh-compatibility.json producer receipt hash',
    ) !== producerHash) {
    throw new Error('dsh-compatibility.json does not bind the durable producer receipt')
  }
  const currentArgs = await dispatchFileBinding(argsPath, 'dispatch-args.json')
  const currentProvenance = await dispatchFileBinding(
    provenancePath, 'dispatch-args-provenance.json',
  )
  const changed = !isDeepStrictEqual(currentArgs, producerArgs)
    || !isDeepStrictEqual(currentProvenance, producerProvenance)
  const transformPath = join(runDir, DISPATCH_TRANSFORMATION_RECEIPT)
  const transformationBytes = await readBoundedRegularFile(
    transformPath, MAX_DSH_DISPATCH_RECEIPT_BYTES,
    'dispatch runtime-control transformation receipt',
  )
  let transformationValue: unknown
  try { transformationValue = JSON.parse(transformationBytes.toString('utf8')) } catch {
    throw new Error('dispatch runtime-control transformation receipt is malformed JSON')
  }
  const transformation = record(transformationValue)
  const input = record(transformation?.input)
  const output = record(transformation?.output)
  const authorized = record(transformation?.authorized_fields)
  const producerReceiptBinding = transformation === undefined
    ? undefined
    : receiptFileBinding(
      transformation, 'producer_receipt', producerPath, 'dispatch transformation receipt',
    )
  if (transformation === undefined || !hasExactKeys(transformation, TRANSFORMATION_RECEIPT_KEYS)
    || transformation.schema_version !== 1
    || transformation.contract !== 'dsh_dispatch_args_transformation_v1'
    || transformation.authority !== 'dsh_host'
    || transformation.transformer !== 'inject-runtime-controls'
    || transformation.session_dir !== sessionDir || transformation.run_dir !== runDir
    || transformation.round !== round || transformation.workflow_name !== workflowName
    || transformation.controller_session_id !== agent.id
    || !nonWhitespaceToken(transformation.controller_session_id)
    || !nonWhitespaceToken(transformation.transformation_call_id)
    || producerReceiptBinding?.sha256 !== producerHash
    || input === undefined || !hasExactKeys(input, ['dispatch_args', 'dispatch_args_provenance'])
    || output === undefined || !hasExactKeys(output, ['dispatch_args', 'dispatch_args_provenance'])
    || authorized === undefined
    || !hasExactKeys(authorized, ['dispatch_args', 'dispatch_args_provenance'])) {
    throw new Error('dispatch runtime-control transformation receipt identity is invalid')
  }
  const inputArgs = receiptFileBinding(
    input, 'dispatch_args', argsPath, 'dispatch transformation input',
  )
  const inputProvenance = receiptFileBinding(
    input, 'dispatch_args_provenance', provenancePath, 'dispatch transformation input',
  )
  const outputArgs = receiptFileBinding(
    output, 'dispatch_args', argsPath, 'dispatch transformation output',
  )
  const outputProvenance = receiptFileBinding(
    output, 'dispatch_args_provenance', provenancePath, 'dispatch transformation output',
  )
  if (!isDeepStrictEqual(inputArgs, producerArgs)
    || !isDeepStrictEqual(inputProvenance, producerProvenance)
    || !isDeepStrictEqual(outputArgs, currentArgs)
    || !isDeepStrictEqual(outputProvenance, currentProvenance)
    || transformation.changed !== changed) {
    throw new Error('dispatch transformation receipt does not link producer input to current bytes')
  }
  const argsFields = authorizedDispatchFields(
    authorized.dispatch_args, RUNTIME_ARGS_FIELDS,
    'dispatch transformation authorized_fields.dispatch_args',
  )
  const provenanceFields = authorizedDispatchFields(
    authorized.dispatch_args_provenance, RUNTIME_PROVENANCE_FIELDS,
    'dispatch transformation authorized_fields.dispatch_args_provenance',
  )
  if (!changed && (argsFields.length !== 0 || provenanceFields.length !== 0)) {
    throw new Error('unchanged dispatch transformation must authorize no changed fields')
  }
  const transformationEvents = agent.session.events.filter(event =>
    event.type === 'kersor/dispatch-args-transformed' && event.data.run_dir === runDir)
  const transformationEvent = transformationEvents[0]
  if (transformationEvents.length !== 1 || transformationEvent === undefined
    || !isDeepStrictEqual(transformationEvent.data, transformation)) {
    throw new Error('dispatch transformation receipt lacks one matching durable Host event')
  }
  const transformationCalls = await durableDispatchTransformationCallIds(agent, runDir)
  if (transformationCalls.length !== 1
    || transformationCalls[0] !== transformation.transformation_call_id) {
    throw new Error('dispatch transformation receipt lacks its exact durable canonical Bash call')
  }
  const producerEventIndex = agent.session.events.indexOf(producerEvent)
  const transformationEventIndex = agent.session.events.indexOf(transformationEvent)
  const producerCallIndex = agent.session.events.findIndex(event =>
    event.type === 'tool/call' && event.data.name === 'subagent'
    && event.data.callId === producer.producer_call_id)
  const transformationCallIndex = agent.session.events.findIndex(event =>
    event.type === 'tool/call' && event.data.name === 'bash'
    && event.data.callId === transformation.transformation_call_id)
  if (producerCallIndex < 0 || producerEventIndex <= producerCallIndex
    || transformationCallIndex <= producerEventIndex
    || transformationEventIndex <= transformationCallIndex) {
    throw new Error('dispatch transformation durable event does not follow its producer event')
  }
  const transformationHash = createHash('sha256').update(transformationBytes).digest('hex')
  if (!isDeepStrictEqual(source.dispatch_args_transformation, transformation)
    || source.dispatch_args_transformation_receipt_path !== transformPath
    || normalizedSha256(
      source.dispatch_args_transformation_receipt_sha256,
      'dsh-workflow.json transformation receipt hash',
    ) !== transformationHash
    || compatibility.dispatch_args_transformation_receipt_source !== transformPath
    || normalizedSha256(
      compatibility.dispatch_args_transformation_receipt_sha256,
      'dsh-compatibility.json transformation receipt hash',
    ) !== transformationHash
    || !isDeepStrictEqual(compatibility.dispatch_args_transformation, transformation)) {
    throw new Error('DSH envelope/report transformation binding differs from Host custody')
  }
  const provenanceHash = currentProvenance.sha256
  if (source.dispatch_args_provenance_path !== provenancePath
    || normalizedSha256(
      source.dispatch_args_provenance_sha256,
      'dsh-workflow.json dispatch provenance hash',
    ) !== provenanceHash
    || compatibility.dispatch_args_provenance_source !== provenancePath
    || normalizedSha256(
      compatibility.dispatch_args_provenance_sha256,
      'dsh-compatibility.json dispatch provenance hash',
    ) !== provenanceHash) {
    throw new Error('DSH envelope/report provenance binding differs from current bytes')
  }
  return {
    producer: producer as unknown as KersorDispatchArgsProducedEventData,
    producerReceiptPath: producerPath,
    producerReceiptSha256: producerHash,
    transformation: transformation as unknown as KersorDispatchArgsTransformedEventData,
    transformationReceiptPath: transformPath,
    transformationReceiptSha256: transformationHash,
    currentArgs,
    currentProvenance,
  }
}

const CANDIDATE_OWNERSHIP_SEAL_KEYS = Object.freeze([
  'schema_version', 'contract', 'recorded_at', 'session_id', 'session_dir',
  'run_dir', 'project_root', 'allowed_write_root', 'session_config_sha256',
  'baseline_witness_sha256', 'protected_files', 'worktree', 'dsh_dispatch_package',
])

async function validateCandidateOwnershipSealFile(
  ctx: Context,
  agent: Agent,
  runDir: string,
  envelope: Record<string, unknown>,
  custody: DispatchCustodyBinding,
  launch: KersorLaunchContract | undefined,
): Promise<CandidateOwnershipSealBinding> {
  const sealPath = join(runDir, CANDIDATE_OWNERSHIP_SEAL)
  const sealBytes = await readBoundedRegularFile(
    sealPath, MAX_CANDIDATE_OWNERSHIP_SEAL_BYTES, 'candidate ownership seal',
  )
  let sealValue: unknown
  try { sealValue = JSON.parse(sealBytes.toString('utf8')) } catch {
    throw new Error('candidate ownership seal is malformed JSON')
  }
  const seal = record(sealValue)
  if (seal === undefined || !hasExactKeys(seal, CANDIDATE_OWNERSHIP_SEAL_KEYS)) {
    throw new Error('candidate ownership seal fields differ from its canonical schema')
  }
  const sessionDir = dirname(runDir)
  const round = Number.parseInt(basename(runDir).slice('run-'.length), 10)
  let baseline: Awaited<ReturnType<typeof validateBaselineCustody>>
  try {
    baseline = await validateBaselineCustody(ctx, agent, sessionDir, launch)
  } catch (error: unknown) {
    throw new Error(
      `candidate ownership baseline Host custody failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const canonicalProjectRoot = baseline.authority.workspace
  const canonicalKernelPath = baseline.authority.kernel.path
  if (seal.schema_version !== 1 || seal.contract !== 'candidate_output_ownership_v1'
    || typeof seal.recorded_at !== 'string' || seal.recorded_at.length === 0
    || seal.session_id !== basename(sessionDir)
    || seal.session_dir !== sessionDir || seal.run_dir !== runDir
    || seal.project_root !== canonicalProjectRoot || seal.allowed_write_root !== sessionDir
    || seal.session_config_sha256 !== baseline.authority.sessionConfig.sha256
    || seal.baseline_witness_sha256 !== baseline.witness.sha256) {
    throw new Error('candidate ownership seal identity/config/baseline binding is invalid')
  }
  const gitRoot = await candidateGitRoot(canonicalProjectRoot)
  const state = await currentSessionState(
    sessionDir, baseline.authority.launch, round, baseline.stateSessionId,
  )
  const protectedFiles = await currentProtectedFiles(
    canonicalProjectRoot, canonicalKernelPath, gitRoot,
  )
  const worktree = await currentWorktreeSnapshot(sessionDir, gitRoot)
  const declaredProtected = record(seal.protected_files)
  if (declaredProtected === undefined) {
    throw new Error('candidate ownership seal protected_files is malformed')
  }
  const protectedDifference = ownershipMapDifference(declaredProtected, protectedFiles)
  if (protectedDifference !== undefined) {
    throw new Error(`candidate ownership protected file changed: ${protectedDifference}`)
  }
  if (!isDeepStrictEqual(seal.worktree, worktree)) {
    throw new Error('candidate ownership seal worktree differs from current Host state')
  }
  const dispatchPackage = record(seal.dsh_dispatch_package)
  const bindings = record(dispatchPackage?.bindings)
  const files = record(dispatchPackage?.files)
  if (dispatchPackage?.schema_version !== 1
    || dispatchPackage.contract !== 'dsh_dispatch_package_v1'
    || dispatchPackage.runtime !== 'dsh' || dispatchPackage.round !== round
    || bindings === undefined || files === undefined) {
    throw new Error('candidate ownership seal does not bind this DSH Session/run package')
  }
  const source = record(envelope.source)
  if (source === undefined || typeof source.workflow_path !== 'string') {
    throw new Error('candidate ownership seal cannot resolve the Workflow source')
  }
  const requiredPaths = new Map<string, string>([
    ['selection', join(sessionDir, `round-${round}-selection.json`)],
    ['catalog', join(sessionDir, 'workflow-catalog.json')],
    ['canonical_workflow', source.workflow_path],
    ['dispatch_args', join(runDir, 'dispatch-args.json')],
    ['dispatch_args_provenance', join(runDir, 'dispatch-args-provenance.json')],
    ['dispatch_args_producer_receipt', custody.producerReceiptPath],
    ['dispatch_args_transformation_receipt', custody.transformationReceiptPath],
    ['envelope', join(runDir, 'dsh-workflow.json')],
    ['compatibility_report', join(runDir, 'dsh-compatibility.json')],
  ])
  for (const [name, expectedPath] of requiredPaths) {
    const evidence = record(files[name])
    if (evidence === undefined || evidence.path !== expectedPath) {
      throw new Error(`candidate ownership seal lacks the canonical ${name} file binding`)
    }
  }
  for (const [name, rawEvidence] of Object.entries(files)) {
    const evidence = record(rawEvidence)
    if (evidence === undefined || typeof evidence.path !== 'string'
      || !isAbsolute(evidence.path) || resolve(evidence.path) !== evidence.path) {
      throw new Error(`candidate ownership seal ${name} file binding is malformed`)
    }
    const bytes = await readBoundedRegularFile(
      evidence.path, MAX_CANDIDATE_OWNERSHIP_SEAL_BYTES,
      `candidate ownership seal ${name}`,
    )
    const actualHash = createHash('sha256').update(bytes).digest('hex')
    if (normalizedSha256(
      evidence.file_sha256, `candidate ownership seal ${name} hash`,
    ) !== actualHash) {
      throw new Error(`candidate ownership seal ${name} differs from current bytes`)
    }
  }
  const expectedProducer = {
    contract: custody.producer.contract,
    authority: custody.producer.authority,
    controller_session_id: custody.producer.controller_session_id,
    producer_session_id: custody.producer.producer_session_id,
    producer_call_id: custody.producer.producer_call_id,
    receipt_sha256: custody.producerReceiptSha256,
    dispatch_args_sha256: custody.producer.dispatch_args.sha256,
    dispatch_args_provenance_sha256: custody.producer.dispatch_args_provenance.sha256,
  }
  const expectedTransformation = {
    contract: custody.transformation.contract,
    authority: custody.transformation.authority,
    transformer: custody.transformation.transformer,
    transformation_call_id: custody.transformation.transformation_call_id,
    receipt_path: custody.transformationReceiptPath,
    receipt_sha256: custody.transformationReceiptSha256,
  }
  if (bindings.selected_workflow !== custody.producer.workflow_name
    || bindings.dispatch_args_producer_receipt_path !== custody.producerReceiptPath
    || !isDeepStrictEqual(bindings.dispatch_args_producer, expectedProducer)
    || !isDeepStrictEqual(bindings.dispatch_args_transformation, expectedTransformation)
    || !isDeepStrictEqual(bindings.effective_dispatch, {
      dispatch_args: custody.currentArgs,
      dispatch_args_provenance: custody.currentProvenance,
    })
    || bindings.envelope_path !== join(runDir, 'dsh-workflow.json')
    || bindings.compatibility_report_path !== join(runDir, 'dsh-compatibility.json')) {
    throw new Error('candidate ownership seal dispatch bindings differ from current Host custody')
  }
  return {
    path: sealPath,
    sha256: createHash('sha256').update(sealBytes).digest('hex'),
    baselineVerifiedEventIndex: baseline.verifiedEventIndex,
    protectedFiles,
    worktree,
    state,
  }
}

const CANDIDATE_OWNERSHIP_EVENT_KEYS = Object.freeze([
  'schema_version', 'contract', 'authority', 'session_dir', 'run_dir', 'round',
  'controller_session_id', 'seal_call_id', 'seal', 'state',
])

async function validateCandidateOwnershipSeal(
  ctx: Context,
  custodyAgent: Agent,
  runDir: string,
  envelope: Record<string, unknown>,
  custody: DispatchCustodyBinding,
  workflowCallId: string,
  launch: KersorLaunchContract | undefined,
  workflowAgent: Agent = custodyAgent,
): Promise<CandidateOwnershipSealBinding> {
  const current = await validateCandidateOwnershipSealFile(
    ctx, custodyAgent, runDir, envelope, custody, launch,
  )
  const sessionDir = dirname(runDir)
  const round = Number.parseInt(basename(runDir).slice('run-'.length), 10)
  const events = custodyAgent.session.events.filter(
    (event): event is Extract<SessionEvent, { type: 'kersor/candidate-ownership-sealed' }> =>
      event.type === 'kersor/candidate-ownership-sealed' && event.data.run_dir === runDir,
  )
  if (events.length !== 1) {
    throw new Error('candidate ownership seal lacks one matching durable Host event')
  }
  const event = events[0]
  if (event === undefined) {
    throw new Error('candidate ownership seal durable Host event disappeared during validation')
  }
  const data = event.data
  const dataRecord = data as unknown as Record<string, unknown>
  const seal = receiptFileBinding(
    dataRecord, 'seal', current.path,
    'candidate ownership durable event',
  )
  const state = receiptFileBinding(
    dataRecord, 'state', current.state.path,
    'candidate ownership durable event',
  )
  if (!hasExactKeys(dataRecord, CANDIDATE_OWNERSHIP_EVENT_KEYS)
    || dataRecord.schema_version !== 1
    || dataRecord.contract !== 'dsh_candidate_ownership_seal_v1'
    || dataRecord.authority !== 'dsh_host' || dataRecord.session_dir !== sessionDir
    || dataRecord.run_dir !== runDir || dataRecord.round !== round
    || dataRecord.controller_session_id !== custodyAgent.id
    || !nonWhitespaceToken(dataRecord.controller_session_id)
    || !nonWhitespaceToken(dataRecord.seal_call_id)
    || seal.sha256 !== current.sha256 || state.sha256 !== current.state.sha256) {
    throw new Error('candidate ownership durable Host event identity or seal hash is invalid')
  }
  const calls = await durableCandidateSealCallIds(custodyAgent, runDir)
  if (calls.length !== 1 || calls[0] !== data.seal_call_id) {
    throw new Error('candidate ownership seal lacks its exact durable canonical Bash call')
  }
  const transformationEvent = custodyAgent.session.events.find(candidate =>
    candidate.type === 'kersor/dispatch-args-transformed'
    && isDeepStrictEqual(candidate.data, custody.transformation))
  const workflowCall = workflowAgent.session.events.find(candidate =>
    candidate.type === 'tool/call' && candidate.data.callId === workflowCallId
    && candidate.data.name === 'kersor_workflow')
  const sealCall = custodyAgent.session.events.find(candidate =>
    candidate.type === 'tool/call' && candidate.data.callId === data.seal_call_id
    && candidate.data.name === 'bash')
  const producerCall = custodyAgent.session.events.find(candidate =>
    candidate.type === 'tool/call'
    && candidate.data.callId === custody.producer.producer_call_id
    && candidate.data.name === 'subagent')
  const producerEvent = custodyAgent.session.events.find(candidate =>
    candidate.type === 'kersor/dispatch-args-produced'
    && isDeepStrictEqual(candidate.data, custody.producer))
  const transformationIndex = transformationEvent === undefined
    ? -1
    : custodyAgent.session.events.indexOf(transformationEvent)
  const producerCallIndex = producerCall === undefined
    ? -1
    : custodyAgent.session.events.indexOf(producerCall)
  const producerEventIndex = producerEvent === undefined
    ? -1
    : custodyAgent.session.events.indexOf(producerEvent)
  const sealCallIndex = sealCall === undefined ? -1 : custodyAgent.session.events.indexOf(sealCall)
  const sealIndex = custodyAgent.session.events.indexOf(event)
  const workflowIndex = workflowCall === undefined ? -1 : workflowAgent.session.events.indexOf(workflowCall)
  const sameController = workflowAgent.id === custodyAgent.id
  let authorityPrecedesWorkflow = true
  if (!sameController) {
    const workflowBinding = controllerBinding(ctx, workflowAgent)?.binding
    if (workflowBinding === undefined) {
      throw new Error('attached Workflow lost its controller authority')
    }
    const imported = await validateSessionAuthority(
      ctx, workflowAgent, workflowBinding, sessionDir,
    )
    authorityPrecedesWorkflow = workflowIndex > imported.eventIndex
  }
  if (current.baselineVerifiedEventIndex < 0
    || producerCallIndex <= current.baselineVerifiedEventIndex
    || producerEventIndex <= producerCallIndex
    || transformationIndex <= producerEventIndex
    || sealCallIndex <= transformationIndex || sealIndex <= sealCallIndex
    || sameController && workflowIndex <= sealIndex
    || !authorityPrecedesWorkflow) {
    throw new Error('candidate ownership durable event order is invalid')
  }
  return current
}

async function verifyPostWorkflowOwnership(
  ctx: Context,
  custodyAgent: Agent,
  runDir: string,
  envelope: Record<string, unknown>,
  custody: DispatchCustodyBinding,
  workflowCallId: string,
  launch: KersorLaunchContract,
  workflowAgent: Agent = custodyAgent,
): Promise<void> {
  let current: CandidateOwnershipSealBinding | undefined
  let violation: string | undefined
  try {
    current = await validateCandidateOwnershipSeal(
      ctx, custodyAgent, runDir, envelope, custody, workflowCallId, launch,
      workflowAgent,
    )
  } catch (error: unknown) {
    violation = error instanceof Error ? error.message : String(error)
  }
  const sealPath = join(runDir, CANDIDATE_OWNERSHIP_SEAL)
  let sealSha256: string | null = null
  try {
    const bytes = await readBoundedRegularFile(
      sealPath, MAX_CANDIDATE_OWNERSHIP_SEAL_BYTES, 'candidate ownership seal',
    )
    sealSha256 = createHash('sha256').update(bytes).digest('hex')
  } catch (error: unknown) {
    violation ??= error instanceof Error ? error.message : String(error)
  }
  const report = {
    schema_version: 1,
    gate: 'candidate_output_ownership_v1',
    authority: 'dsh_host',
    verdict: violation === undefined ? 'pass' : 'fail',
    recorded_at: new Date().toISOString(),
    seal: sealPath,
    seal_sha256: sealSha256,
    protected_files: current?.protectedFiles ?? {},
    worktree: current?.worktree ?? {},
    violations: violation === undefined ? [] : [violation],
  }
  await atomicHostReceipt(join(runDir, CANDIDATE_OWNERSHIP_REPORT), report)
  if (violation !== undefined) {
    throw new Error(`post-Workflow candidate ownership failed: ${violation}`)
  }
}

function createSealedWorkflow(ctx: Context, hostGate: WorkflowHostGateState) {
  return defineTool({
    name: 'kersor_workflow',
    description: 'Execute one prepared KerSor run from its Host-validated dsh-workflow.json. Pass only the exact absolute run-N directory; the Host owns envelope loading and raw output custody.',
    parameters: {
      exp_dir: {
        type: 'string',
        required: true,
        description: 'Exact absolute <workspace>/.kersor/<session>/run-N directory containing dsh-workflow.json.',
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
      render: (args, value) => [{
        type: 'text',
        text: `sealed KerSor Workflow ${value.runId} completed with ${value.agentsStarted} member(s); Host raw output custody completed for ${args.exp_dir}/output.json`,
      }],
    },
    async execute(args: SealedWorkflowArgs, exec) {
      const agent = exec.agent
      if (agent === undefined || controllerBinding(ctx, agent) === undefined) {
        throw new Error('kersor_workflow is available only to the conversation-bound KerSor controller')
      }
      const runDir = await canonicalRunDirectory(agent, args.exp_dir)
      await consumeWorkflowRun(runDir, agent, exec.callId, hostGate)
      const envelope = await readDshWorkflowEnvelope(runDir)
      const custodyAgent = await dispatchAuthorityAgent(ctx, agent, runDir)
      const custody = await validateDispatchCustody(custodyAgent, runDir, envelope)
      const binding = controllerBinding(ctx, agent)
      if (binding === undefined) {
        throw new Error('kersor_workflow lost its conversation-bound Experiment authority')
      }
      await validateCandidateOwnershipSeal(
        ctx, custodyAgent, runDir, envelope, custody, exec.callId,
        binding.binding.start.launch,
        agent,
      )
      const call = workflowCallContract(envelope)
      const nativeCallId = CallId(`${exec.callId}:sealed-workflow`)
      hostGate.authorizedNativeCallIds.add(nativeCallId)
      hostGate.activeExperiments.add(binding.binding.start.experimentId)
      let result
      let executionError: unknown
      try {
        result = await ctx.tools.execute({
          callId: nativeCallId,
          rootCallId: exec.rootCallId,
          name: 'workflow',
          arguments: call,
          agent,
          signal: exec.signal,
        })
      } catch (error: unknown) {
        executionError = error
      } finally {
        hostGate.authorizedNativeCallIds.delete(nativeCallId)
      }
      try {
        await verifyPostWorkflowOwnership(
          ctx, custodyAgent, runDir, envelope, custody, exec.callId,
          binding.binding.start.launch, agent,
        )
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error)
        await checkpoint(ctx, binding.parent, binding.binding.start, 'blocked', reason, {
          phase: 'stalled',
          steps: [
            ...(binding.binding.checkpoint?.steps ?? []).filter(step => step.id !== 'ownership'),
            { id: 'ownership', status: 'failed' },
          ],
        })
        throw error
      } finally {
        hostGate.activeExperiments.delete(binding.binding.start.experimentId)
      }
      if (executionError !== undefined) {
        throw executionError instanceof Error
          ? executionError
          : new Error('native workflow failed with a non-Error rejection', { cause: executionError })
      }
      if (result === undefined) throw new Error('native workflow returned no Host result')
      if (result.isError) throw new Error(result.error.message)
      await commitWorkflowOutput(agent, call, result.value)
      const value = record(result.value)
      if (value === undefined
        || typeof value.runId !== 'string'
        || !Number.isSafeInteger(value.agentsStarted)
        || !Object.hasOwn(value, 'result')) {
        throw new Error('native workflow returned a non-canonical result envelope')
      }
      return {
        runId: value.runId,
        agentsStarted: value.agentsStarted as number,
        result: value.result as JsonValue,
      }
    },
    presentCall: args => ({ card: 'generic', title: `Run sealed KerSor Workflow: ${args.exp_dir}`, kind: 'execute' }),
  })
}

async function workflowEnvelopeDenial(
  agent: Agent,
  argumentsValue: unknown,
): Promise<string | undefined> {
  try {
    const call = workflowCallContract(argumentsValue)
    const runDir = await canonicalRunDirectory(agent, call.args.exp_dir)
    const envelope = await readDshWorkflowEnvelope(runDir)
    if (!isDeepStrictEqual(call.meta, envelope.meta)) {
      throw new Error('workflow meta differs from dsh-workflow.json')
    }
    if (call.script !== envelope.script) {
      throw new Error('workflow script differs from dsh-workflow.json')
    }
    if (!isDeepStrictEqual(call.args, envelope.args)) {
      throw new Error('workflow args differ from dsh-workflow.json')
    }
    return undefined
  } catch (error: unknown) {
    return `KerSor Workflow envelope gate denied before execution: ${error instanceof Error ? error.message : String(error)}. Pass the exact dsh-workflow.json meta/script/args; do not reconstruct them.`
  }
}

function rawWorkflowResult(value: unknown): Record<string, unknown> {
  const wrapper = record(value)
  if (wrapper === undefined
    || Object.keys(wrapper).length !== 3
    || typeof wrapper.runId !== 'string'
    || wrapper.runId.length === 0
    || !Number.isSafeInteger(wrapper.agentsStarted)
    || (wrapper.agentsStarted as number) < 0
    || !Object.hasOwn(wrapper, 'result')) {
    throw new Error('workflow result.value must have canonical {runId, agentsStarted, result} shape')
  }
  const raw = record(wrapper.result)
  if (raw === undefined) {
    throw new Error('workflow result.value.result must be a JSON object')
  }
  return raw
}

function workflowExpDir(argumentsValue: unknown): unknown {
  return record(record(argumentsValue)?.args)?.exp_dir
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error: unknown) {
    if (nodeErrorCode(error) === 'ENOENT') return false
    throw error
  }
}

async function commitExclusiveOutput(runDir: string, serialized: string): Promise<void> {
  const outputPath = join(runDir, 'output.json')
  if (await pathExists(outputPath)) {
    throw new Error(`workflow output already exists and will not be overwritten: ${outputPath}`)
  }
  const temporaryPath = join(runDir, `.output.json.${randomUUID()}.tmp`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(serialized, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await link(temporaryPath, outputPath)
  } catch (error: unknown) {
    if (nodeErrorCode(error) === 'EEXIST') {
      throw new Error(`workflow output already exists and will not be overwritten: ${outputPath}`)
    }
    throw new Error(`workflow output could not be atomically committed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await handle?.close().catch(() => { /* best-effort cleanup after a failed write */ })
    await unlink(temporaryPath).catch(() => { /* absent after cleanup or retained only on an external filesystem fault */ })
  }
}

async function commitWorkflowOutput(agent: Agent, argumentsValue: unknown, value: unknown): Promise<void> {
  const raw = rawWorkflowResult(value)
  const serialized = `${JSON.stringify(raw, null, 2)}\n`
  const bytes = Buffer.byteLength(serialized, 'utf8')
  if (bytes > MAX_WORKFLOW_OUTPUT_BYTES) {
    throw new Error(`workflow raw result is ${bytes} bytes, exceeding the ${MAX_WORKFLOW_OUTPUT_BYTES}-byte output.json limit`)
  }
  const runDir = await canonicalRunDirectory(agent, workflowExpDir(argumentsValue))
  await commitExclusiveOutput(runDir, serialized)
}

function filePathArgument(argumentsValue: unknown): string | undefined {
  const argumentsRecord = record(argumentsValue)
  return typeof argumentsRecord?.file_path === 'string' ? argumentsRecord.file_path : undefined
}

function recursiveAuthorPathArguments(argumentsValue: unknown): readonly string[] {
  const paths: string[] = []
  const visit = (value: unknown, key?: string): void => {
    if (typeof value === 'string') {
      if (key === 'file_path' || key === 'filePath' || key === 'path'
        || key === 'directory' || key === 'root' || key === 'cwd') paths.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    const valueRecord = record(value)
    if (valueRecord === undefined) return
    for (const [childKey, child] of Object.entries(valueRecord)) visit(child, childKey)
  }
  visit(argumentsValue)
  return paths
}

function matchesStaticGlob(value: string, pattern: string): boolean {
  if (pattern.includes('\0') || /[{}]|[@+?!*]\(/u.test(pattern)) {
    throw new Error('unsupported static glob syntax')
  }
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern.charAt(index)
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/' || pattern[index + 1] === '\\') {
          index += 1
          source += '(?:.*[/\\\\])?'
        } else source += '.*'
      } else source += '[^/\\\\]*'
      continue
    }
    if (character === '?') {
      source += '[^/\\\\]'
      continue
    }
    if (character === '[') {
      const end = pattern.indexOf(']', index + 1)
      if (end < 0) throw new Error('unterminated static glob class')
      const body = pattern.slice(index + 1, end)
      if (body.length === 0) throw new Error('empty static glob class')
      const negated = body.startsWith('!') ? `^${body.slice(1)}` : body
      source += `[${negated.replaceAll('\\', '\\\\').replaceAll(']', '\\]')}]`
      index = end
      continue
    }
    if (character === '/' || character === '\\') source += '[/\\\\]'
    else source += character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  }
  return new RegExp(`${source}$`, 'u').test(value)
}

async function authorAuthorityForAgent(
  ctx: Context,
  agent: Agent,
): Promise<AuthorAuthority | undefined> {
  const owned = controllerBinding(ctx, agent)
  const lineage = owned === undefined ? experimentControllerAgent(ctx, agent) : undefined
  const controller = owned === undefined ? lineage?.controller : agent
  const binding = owned?.binding ?? lineage?.binding
  if (controller === undefined || binding === undefined
    || binding.start.origin !== 'created'
    || binding.start.launch.workflow_authoring_budget === 0) return undefined
  const events = controller.session.events.filter(
    (event): event is Extract<SessionEvent, { type: 'kersor/session-initialized' }> =>
      event.type === 'kersor/session-initialized'
      && event.data.experiment_id === binding.start.experimentId,
  )
  const event = events[0]
  if (events.length === 0 || event === undefined) return undefined
  if (events.length !== 1 || event.data.controller_session_id !== controller.id) {
    throw new Error('author custody requires one Host-initialized controller Session')
  }
  const sessionDir = event.data.session_dir
  const workspace = await canonicalWorkspacePath(workspaceOf(controller))
  if (!isAbsolute(sessionDir) || resolve(sessionDir) !== sessionDir
    || await realpath(sessionDir) !== sessionDir
    || dirname(sessionDir) !== join(workspace, '.kersor')) {
    throw new Error('author custody Session path differs from Host initialization')
  }
  const python = record(event.data.kersor_python)
  const adapter = record(event.data.adapter)
  if (typeof python?.path !== 'string' || !isAbsolute(python.path)) {
    throw new Error('author custody lost its Host-frozen Python binding')
  }
  if (typeof adapter?.path !== 'string' || !isAbsolute(adapter.path)) {
    throw new Error('author custody lost its Host-frozen KerSor adapter binding')
  }
  const kersorRoot = dirname(dirname(adapter.path))
  if (await realpath(kersorRoot) !== kersorRoot) {
    throw new Error('author custody KerSor root contains a path alias')
  }
  return {
    controller,
    directController: controller.id === agent.id,
    sessionDir,
    stagingDir: join(sessionDir, 'workflow-authoring', 'staging'),
    handoffPath: join(sessionDir, 'workflow-authoring', AUTHOR_HANDOFF),
    kersorRoot,
    kersorPython: python.path,
  }
}

function pathInside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path.length === 0 || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function pathFromShellCwd(cwd: string, value: string): string {
  return isAbsolute(value) ? value : `${cwd}${cwd.endsWith(sep) ? '' : sep}${value}`
}

async function sameRegularFileIdentity(
  candidate: string,
  protectedPaths: readonly string[],
): Promise<boolean> {
  const candidateStat = await stat(candidate).catch(() => undefined)
  if (candidateStat === undefined || !candidateStat.isFile()) return false
  const protectedStats = await Promise.all(protectedPaths.map(path =>
    stat(path).catch(() => undefined)))
  return protectedStats.some(protectedStat => protectedStat?.isFile() === true
    && protectedStat.dev === candidateStat.dev
    && protectedStat.ino === candidateStat.ino)
}

async function targetsAuthorStaging(
  authority: AuthorAuthority,
  agent: Agent,
  filePath: string,
): Promise<boolean> {
  const cwd = await canonicalWorkspacePath(workspaceOf(agent))
  const rawTarget = pathFromShellCwd(cwd, filePath)
  const lexicalTarget = resolve(rawTarget)
  if (pathInside(authority.stagingDir, lexicalTarget)) return true
  const [realStaging, realTarget] = await Promise.all([
    realpath(authority.stagingDir).catch(() => undefined),
    realMutationTarget(rawTarget),
  ])
  return (realStaging !== undefined && realTarget !== undefined
      && pathInside(realStaging, realTarget))
    || await sameRegularFileIdentity(rawTarget, AUTHOR_STAGING_FILES.map(name =>
      join(authority.stagingDir, name)))
}

function searchFilterMatchesAuthorStaging(
  root: string,
  staging: string,
  filter: string,
): boolean {
  const candidates = AUTHOR_STAGING_FILES.flatMap((name) => {
    const path = join(staging, name)
    const relativePath = relative(root, path).split(sep).join('/')
    return [path, relativePath, basename(path)]
  })
  try {
    return candidates.some(candidate => matchesStaticGlob(candidate, filter))
  } catch {
    return true
  }
}

async function searchFilterMatchesAuthorStagingAlias(
  root: string,
  staging: string,
  filter: string,
): Promise<boolean> {
  const pending = [root]
  let visited = 0
  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) break
    let entries: Dirent[]
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return true }
    for (const entry of entries) {
      visited += 1
      if (visited > 256) return true
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await realpath(path).catch(() => undefined)
        if (target === undefined || !pathRelated(staging, target)) continue
        const aliases = pathInside(target, staging)
          ? AUTHOR_STAGING_FILES.map(name => join(path, relative(target, staging), name))
          : [path]
        const candidates = aliases.flatMap(alias => [
          alias,
          relative(root, alias).split(sep).join('/'),
          basename(alias),
        ])
        try {
          if (candidates.some(candidate => matchesStaticGlob(candidate, filter))) return true
        } catch {
          return true
        }
      } else if (entry.isFile()
        && await sameRegularFileIdentity(path, AUTHOR_STAGING_FILES.map(name =>
          join(staging, name)))) {
        const candidates = [
          path,
          relative(root, path).split(sep).join('/'),
          basename(path),
        ]
        try {
          if (candidates.some(candidate => matchesStaticGlob(candidate, filter))) return true
        } catch {
          return true
        }
      } else if (entry.isDirectory()) {
        pending.push(path)
      }
    }
  }
  return false
}

async function authorPathToolTargetsStaging(
  authority: AuthorAuthority,
  agent: Agent,
  toolName: string,
  argumentsValue: unknown,
): Promise<boolean> {
  const paths = recursiveAuthorPathArguments(argumentsValue)
  if ((await Promise.all(paths.map(path =>
    targetsAuthorStaging(authority, agent, path)))).some(Boolean)) return true
  if (toolName !== 'glob' && toolName !== 'grep') return false
  const args = record(argumentsValue)
  const cwd = await canonicalWorkspacePath(workspaceOf(agent))
  const path = typeof args?.path === 'string' ? args.path : cwd
  const lexicalRoot = isAbsolute(path) ? resolve(path) : resolve(cwd, path)
  const realRoot = await realpath(lexicalRoot).catch(() => undefined)
  const realStaging = await realpath(authority.stagingDir).catch(() => undefined)
  const root = realRoot ?? lexicalRoot
  const staging = realStaging ?? authority.stagingDir
  const filter = toolName === 'glob'
    ? args?.pattern
    : args?.include ?? '**/*'
  if (typeof filter !== 'string') return true
  if (pathInside(root, staging)
    && searchFilterMatchesAuthorStaging(root, staging, filter)) return true
  return searchFilterMatchesAuthorStagingAlias(root, staging, filter)
}

const SHELL_CONTROL_WORDS = new Set([';', '&&', '||', '|', '|&', '&', '\n'])
const SHELL_PATH_COMMANDS = new Set([
  '.', 'bash', 'cat', 'cp', 'find', 'grep', 'head', 'less', 'ls', 'mv', 'node',
  'python', 'python3', 'readlink', 'rg', 'sed', 'sh', 'source', 'stat', 'tail',
  'tee', 'test', 'unlink', 'wc', 'zsh',
])
const SHELL_EXECUTION_WRAPPERS = new Set(['command', 'env', 'exec', 'nohup'])

function shellRedirectionAt(command: string, index: number): string | undefined {
  for (const operator of ['&>>', '<<<', '&>', '>>', '<<', '<>', '>|', '<&', '>&', '>', '<']) {
    if (command.startsWith(operator, index)) return operator
  }
  return undefined
}

function staticShellTokens(command: string): string[] | undefined {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: '\'' | '"' | undefined
  const push = () => {
    if (started) tokens.push(current)
    current = ''
    started = false
  }
  for (let index = 0; index < command.length; index += 1) {
    const character = command.charAt(index)
    if (quote === '\'') {
      if (character === '\'') quote = undefined
      else current += character
      started = true
      continue
    }
    if (quote === '"') {
      if (character === '"') quote = undefined
      else if (character === '\\' && index + 1 < command.length
        && ['$', '`', '"', '\\', '\n'].includes(command.charAt(index + 1))) {
        current += command.charAt(index + 1)
        index += 1
      } else current += character
      started = true
      continue
    }
    if (character === '\'' || character === '"') {
      quote = character
      started = true
      continue
    }
    if (character === '\\') {
      if (index + 1 >= command.length) return undefined
      current += command.charAt(index + 1)
      index += 1
      started = true
      continue
    }
    if (/\s/u.test(character)) {
      push()
      if (character === '\n') tokens.push('\n')
      continue
    }
    const redirection = shellRedirectionAt(command, index)
    if (redirection !== undefined) {
      const descriptor = started && /^\d+$/u.test(current) ? current : ''
      if (descriptor.length === 0) push()
      else {
        current = ''
        started = false
      }
      tokens.push(`${descriptor}${redirection}`)
      index += redirection.length - 1
      continue
    }
    const pair = command.slice(index, index + 2)
    if (['&&', '||', '|&'].includes(pair)) {
      push()
      tokens.push(pair)
      index += 1
      continue
    }
    if ([';', '|', '&'].includes(character)) {
      push()
      tokens.push(character)
      continue
    }
    current += character
    started = true
  }
  if (quote !== undefined) return undefined
  push()
  return tokens
}

function expandStaticShellWord(
  word: string,
  variables: ReadonlyMap<string, string>,
): string | undefined {
  if (word.includes('$(') || word.includes('`') || word.includes('${!')) return undefined
  let expanded = word
  for (let pass = 0; pass < 8; pass += 1) {
    const before = expanded
    expanded = expanded.replace(
      /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/gu,
      (match, braced: string | undefined, fallback: string | undefined, bare: string | undefined) => {
        const name = braced ?? bare
        if (name === undefined) return match
        const value = variables.get(name)
        if (value !== undefined) {
          return value
        }
        if (fallback !== undefined) {
          return fallback
        }
        return match
      },
    )
    if (expanded === before) break
  }
  return expanded.includes('$') ? undefined : expanded
}

function shellCommands(tokens: readonly string[]): readonly string[][] {
  const commands: string[][] = []
  let current: string[] = []
  for (const token of tokens) {
    if (SHELL_CONTROL_WORDS.has(token)) {
      if (current.length > 0) commands.push(current)
      current = []
    } else current.push(token)
  }
  if (current.length > 0) commands.push(current)
  return commands
}

function shellRedirections(words: readonly string[]): {
  readonly invocation: readonly string[]
  readonly targets: readonly string[]
  readonly dynamic: boolean
} {
  const invocation: string[] = []
  const targets: string[] = []
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? ''
    if (!/^(?:\d+)?(?:&>>|&>|>>|<>|>\||<&|>&|>|<|<<|<<<)$/u.test(word)) {
      invocation.push(word)
      continue
    }
    const target = words[index + 1]
    if (target === undefined) return { invocation, targets, dynamic: true }
    index += 1
    if (/<<<?$/u.test(word)) {
      if (target.includes('$(') || target.includes('`')) {
        return { invocation, targets, dynamic: true }
      }
      continue
    }
    if (!/^&(?:\d+|-)$/u.test(target)) targets.push(target)
  }
  return { invocation, targets, dynamic: false }
}

interface StaticShellInvocation {
  readonly executableWord: string
  readonly executable: string
  readonly operands: readonly string[]
  readonly variables: ReadonlyMap<string, string>
}

function unwrapStaticShellInvocation(
  executableWord: string,
  operands: readonly string[],
  inheritedVariables: ReadonlyMap<string, string>,
): StaticShellInvocation | undefined {
  let word = executableWord
  let executable = basename(word).toLowerCase()
  let remaining = [...operands]
  const variables = new Map(inheritedVariables)
  for (let depth = 0; SHELL_EXECUTION_WRAPPERS.has(executable); depth += 1) {
    if (depth > 8) return undefined
    let index = 0
    if (executable === 'env') {
      while (index < remaining.length) {
        const operand = remaining.at(index)
        if (operand === undefined) break
        if (operand === '--') {
          index += 1
          break
        }
        if (['-i', '--ignore-environment', '-0', '--null'].includes(operand)) {
          index += 1
          continue
        }
        if (['-u', '--unset', '-C', '--chdir', '-S', '--split-string'].includes(operand)) {
          if (remaining[index + 1] === undefined) return undefined
          index += 2
          continue
        }
        if (operand.startsWith('-')) return undefined
        const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(operand)
        if (assignment === null) break
        const [, name, value] = assignment
        if (name === undefined || value === undefined) return undefined
        variables.set(name, value)
        index += 1
      }
    } else {
      while (remaining.at(index)?.startsWith('-') === true) {
        const option = remaining.at(index)
        if (option === undefined) break
        index += 1
        if (option === '--') break
        if (executable === 'exec' && option === '-a') {
          if (remaining[index] === undefined) return undefined
          index += 1
        }
      }
    }
    const target = remaining[index]
    if (target === undefined) return {
      executableWord: word, executable, operands: remaining, variables,
    }
    word = target
    executable = basename(word).toLowerCase()
    remaining = remaining.slice(index + 1)
  }
  return { executableWord: word, executable, operands: remaining, variables }
}

function pathRelated(left: string, right: string): boolean {
  return pathInside(left, right) || pathInside(right, left)
}

async function shellWordTargetsAuthorStaging(
  word: string,
  cwd: string,
  authority: AuthorAuthority,
): Promise<boolean> {
  const candidate = word.startsWith('-') && word.includes('=')
    ? word.slice(word.indexOf('=') + 1)
    : word
  if (candidate.length === 0 || candidate === '-' || candidate.startsWith('-')) return false
  const raw = pathFromShellCwd(cwd, candidate)
  const lexical = resolve(raw)
  const known = [
    authority.stagingDir,
    ...AUTHOR_STAGING_FILES.map(name => join(authority.stagingDir, name)),
  ]
  if (/[*?[]/u.test(candidate)) {
    if (known.some(path => matchesStaticGlob(path, lexical))) return true
    const expanded = await boundedShellGlob(raw)
    if (expanded === undefined) return true
    for (const path of expanded) {
      if (pathRelated(authority.stagingDir, path)) return true
      const realPath = await realMutationTarget(path)
      const realStaging = await realpath(authority.stagingDir).catch(() => undefined)
      if (realPath !== undefined && realStaging !== undefined
        && pathRelated(realStaging, realPath)) return true
    }
  }
  if (pathRelated(authority.stagingDir, lexical)) return true
  const [realStaging, realCandidate] = await Promise.all([
    realpath(authority.stagingDir).catch(() => undefined),
    realMutationTarget(raw),
  ])
  return (realStaging !== undefined && realCandidate !== undefined
      && pathRelated(realStaging, realCandidate))
    || await sameRegularFileIdentity(raw, AUTHOR_STAGING_FILES.map(name =>
      join(authority.stagingDir, name)))
}

async function boundedShellGlob(pattern: string): Promise<readonly string[] | undefined> {
  const magic = pattern.search(/[*?[]/u)
  if (magic < 0) return [pattern]
  const prefix = pattern.slice(0, magic)
  let root = prefix.endsWith(sep) ? prefix.slice(0, -1) : dirname(prefix)
  while (root.length > 0) {
    try {
      if ((await lstat(root)).isDirectory()) break
    } catch {
      // Continue toward the first existing literal ancestor.
    }
    const parent = dirname(root)
    if (parent === root) return []
    root = parent
  }
  const matched: string[] = []
  const pending = [root]
  let visited = 0
  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) break
    let entries: Dirent[]
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return [] }
    for (const entry of entries) {
      visited += 1
      if (visited > 256) return undefined
      const path = join(directory, entry.name)
      try {
        if (matchesStaticGlob(path, pattern)) matched.push(path)
      } catch {
        return undefined
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(path)
    }
  }
  return matched
}

async function shellWordIsAuthorGateScript(
  word: string,
  cwd: string,
  authority: AuthorAuthority,
): Promise<boolean> {
  const candidate = word.startsWith('-') && word.includes('=')
    ? word.slice(word.indexOf('=') + 1)
    : word
  if (candidate.length === 0 || candidate === '-' || candidate.startsWith('-')) return false
  const raw = pathFromShellCwd(cwd, candidate)
  const lexical = resolve(raw)
  const scripts = [
    join(authority.kersorRoot, 'scripts', 'seal-author-handoff.py'),
    join(authority.kersorRoot, 'scripts', 'save-authored-workflow.sh'),
  ]
  if (/[*?[]/u.test(candidate)) {
    try {
      if (scripts.some(path => matchesStaticGlob(path, lexical))) return true
    } catch {
      return true
    }
    const expanded = await boundedShellGlob(raw)
    if (expanded === undefined) return true
    for (const path of expanded) {
      const realPath = await realMutationTarget(path)
      if (realPath !== undefined && scripts.includes(realPath)) return true
    }
  }
  if (scripts.includes(lexical)) return true
  const realCandidate = await realMutationTarget(raw)
  return (realCandidate !== undefined && scripts.includes(realCandidate))
    || await sameRegularFileIdentity(raw, scripts)
}

async function shellInvokesAuthorGate(
  executableWord: string,
  executable: string,
  operands: readonly string[],
  cwd: string,
  authority: AuthorAuthority,
): Promise<boolean> {
  if (await shellWordIsAuthorGateScript(executableWord, cwd, authority)) return true
  const wrapper = join(authority.kersorRoot, 'scripts', 'run-kersor-python.sh')
  const executablePath = pathFromShellCwd(cwd, executableWord)
  const realExecutable = await realMutationTarget(executablePath)
  if (realExecutable === wrapper
    && operands.some(operand => basename(operand) === 'seal-author-handoff.py')) return true
  if (!['.', 'bash', 'python', 'python3', 'sh', 'source', 'zsh'].includes(executable)) {
    return false
  }
  const targets = operands.filter(operand => !operand.startsWith('-'))
  for (const target of targets) {
    if (await shellWordIsAuthorGateScript(target, cwd, authority)) return true
  }
  if (['bash', 'sh', 'zsh'].includes(executable)) {
    const script = targets[0]
    const tool = targets[1]
    if (script !== undefined && tool !== undefined) {
      const scriptPath = pathFromShellCwd(cwd, script)
      const realScript = await realMutationTarget(scriptPath)
      if (realScript === wrapper && basename(tool) === 'seal-author-handoff.py') return true
    }
  }
  return false
}

async function authorBashWorkdir(
  argumentsValue: unknown,
  authority: AuthorAuthority,
  agent: Agent,
): Promise<{
  readonly cwd: string
  readonly invalid: boolean
  readonly staging: boolean
}> {
  const workspace = await canonicalWorkspacePath(workspaceOf(agent))
  const args = record(argumentsValue)
  const authored = args?.workdir
  if (authored === undefined) return { cwd: workspace, invalid: false, staging: false }
  if (typeof authored !== 'string') return { cwd: workspace, invalid: true, staging: false }
  const effective = isAbsolute(authored) ? authored : resolve(workspace, authored)
  const lexical = resolve(effective)
  const canonical = await realpath(effective).catch(() => undefined)
  if (canonical === undefined || canonical !== lexical
    || !(await stat(canonical)).isDirectory()) {
    return { cwd: lexical, invalid: true, staging: false }
  }
  const staging = await realpath(authority.stagingDir).catch(() => authority.stagingDir)
  return {
    cwd: canonical,
    invalid: false,
    staging: pathInside(staging, canonical),
  }
}

async function bashTouchesAuthorStaging(
  argumentsValue: unknown,
  authority: AuthorAuthority,
  agent: Agent,
  stagingAccess = true,
): Promise<boolean> {
  const command = bashCommand(argumentsValue)
  if (command === undefined) return true
  const workdir = await authorBashWorkdir(argumentsValue, authority, agent)
  if (workdir.invalid || stagingAccess && workdir.staging) return true
  const initialCwd = workdir.cwd
  const inspect = async (
    source: string,
    inheritedCwd: string,
    inheritedVariables: ReadonlyMap<string, string>,
    depth: number,
  ): Promise<boolean> => {
    if (depth > 8) return true
    const tokens = staticShellTokens(source)
    if (tokens === undefined) return true
    const variables = new Map(inheritedVariables)
    let cwd = inheritedCwd
    for (const words of shellCommands(tokens)) {
      const redirections = shellRedirections(words)
      if (redirections.dynamic && stagingAccess) return true
      const invocationWords = redirections.invocation
      let index = 0
      for (; index < invocationWords.length; index += 1) {
        const word = invocationWords.at(index)
        if (word === undefined) break
        const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(word)
        if (assignment === null) break
        const [, name, assignmentValue] = assignment
        if (name === undefined || assignmentValue === undefined) return true
        const expanded = expandStaticShellWord(assignmentValue, variables)
        if (expanded === undefined) return true
        variables.set(name, expanded)
      }
      for (const target of redirections.targets) {
        const expanded = expandStaticShellWord(target, variables)
        if (expanded === undefined) {
          if (stagingAccess) return true
          continue
        }
        if (stagingAccess
          && await shellWordTargetsAuthorStaging(expanded, cwd, authority)) return true
      }
      if (index >= invocationWords.length) continue
      const unexpandedExecutable = invocationWords.at(index)
      if (unexpandedExecutable === undefined) return true
      const executableWord = expandStaticShellWord(unexpandedExecutable, variables)
      if (executableWord === undefined) return true
      const initialExecutable = basename(executableWord).toLowerCase()
      const operands: string[] = []
      for (const word of invocationWords.slice(index + 1)) {
        const expanded = expandStaticShellWord(word, variables)
        if (expanded === undefined) {
          if (SHELL_PATH_COMMANDS.has(initialExecutable)
            || SHELL_EXECUTION_WRAPPERS.has(initialExecutable)) return true
          continue
        }
        operands.push(expanded)
      }
      const invocation = unwrapStaticShellInvocation(executableWord, operands, variables)
      if (invocation === undefined) return true
      const {
        executableWord: effectiveExecutableWord,
        executable,
        operands: effectiveOperands,
        variables: effectiveVariables,
      } = invocation
      if (await shellInvokesAuthorGate(
        effectiveExecutableWord, executable, effectiveOperands, cwd, authority,
      )) return true
      if (executable === 'export' || executable === 'readonly') {
        for (const operand of effectiveOperands) {
          const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(operand)
          const name = assignment?.[1]
          const value = assignment?.[2]
          if (name !== undefined && value !== undefined) variables.set(name, value)
        }
        continue
      }
      if (executable === 'cd') {
        const target = effectiveOperands.find(operand => !operand.startsWith('-'))
        if (target === undefined) return true
        cwd = isAbsolute(target) ? resolve(target) : resolve(cwd, target)
        continue
      }
      if (['bash', 'sh', 'zsh'].includes(executable)) {
        const commandIndex = effectiveOperands.findIndex(operand =>
          operand === '-c' || /^-[^-]*c/u.test(operand))
        if (commandIndex >= 0) {
          const payload = effectiveOperands[commandIndex + 1]
          if (payload === undefined
            || await inspect(payload, cwd, effectiveVariables, depth + 1)) return true
        }
      } else if (executable === 'eval') {
        if (effectiveOperands.length === 0
          || await inspect(effectiveOperands.join(' '), cwd, effectiveVariables, depth + 1)) return true
      }
      if (!SHELL_PATH_COMMANDS.has(executable)) continue
      if (!stagingAccess) continue
      const candidates = effectiveOperands.filter(operand => !operand.startsWith('-'))
      if ((executable === 'ls' || executable === 'find') && candidates.length === 0) {
        candidates.push(cwd)
      }
      for (const candidate of candidates) {
        if (await shellWordTargetsAuthorStaging(candidate, cwd, authority)) return true
      }
    }
    return false
  }
  return inspect(command, initialCwd, new Map(), 0)
}

function authorSealEvent(
  authority: AuthorAuthority,
): Extract<SessionEvent, { type: 'kersor/author-handoff-sealed' }> | undefined {
  const events = authority.controller.session.events.filter(
    (event): event is Extract<SessionEvent, { type: 'kersor/author-handoff-sealed' }> =>
      event.type === 'kersor/author-handoff-sealed'
      && event.data.session_dir === authority.sessionDir,
  )
  if (events.length > 1) throw new Error('author handoff has duplicate durable Host seals')
  return events[0]
}

function authorSaveEvents(
  authority: AuthorAuthority,
): readonly Extract<SessionEvent, { type: 'kersor/author-save-attempted' }>[] {
  return authority.controller.session.events.filter(
    (event): event is Extract<SessionEvent, { type: 'kersor/author-save-attempted' }> =>
      event.type === 'kersor/author-save-attempted'
      && event.data.session_dir === authority.sessionDir,
  )
}

function durableAuthorCommandCallIds(
  controller: Agent,
  command: string,
): string[] {
  const calls: string[] = []
  for (const event of controller.session.events) {
    if (event.type !== 'tool/call' || event.data.name !== 'bash') continue
    try {
      if (hostCanonicalAuthorToolArguments(JSON.parse(event.data.arguments), command)) {
        calls.push(event.data.callId)
      }
    } catch {
      // A malformed historical Bash envelope is not a canonical author gate.
    }
  }
  return calls
}

type AuthorFileBindings = KersorAuthorHandoffSealedEventData['files']

async function authorHandoffBindings(authority: AuthorAuthority): Promise<{
  readonly handoff: { readonly path: string; readonly sha256: string }
  readonly files: AuthorFileBindings
}> {
  const staging = await realpath(authority.stagingDir)
  if (staging !== authority.stagingDir) {
    throw new Error('author staging directory contains a symlink or path alias')
  }
  const entries = await readdir(staging, { withFileTypes: true })
  const names = entries.map(entry => entry.name).sort()
  if (!isDeepStrictEqual(names, [...AUTHOR_STAGING_FILES].sort())
    || entries.some(entry => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error('author staging must contain exactly the three direct author files')
  }
  const files = Object.fromEntries(await Promise.all(AUTHOR_STAGING_FILES.map(async (name) => {
    const path = join(staging, name)
    const bytes = await readBoundedRegularFile(path, MAX_AUTHOR_FILE_BYTES, `author staging ${name}`)
    return [name, { path, sha256: createHash('sha256').update(bytes).digest('hex') }]
  }))) as unknown as AuthorFileBindings
  const handoffBytes = await readBoundedRegularFile(
    authority.handoffPath, MAX_AUTHOR_HANDOFF_BYTES, 'author handoff seal',
  )
  let handoffValue: unknown
  try { handoffValue = JSON.parse(handoffBytes.toString('utf8')) } catch {
    throw new Error('author handoff seal is malformed JSON')
  }
  const handoff = record(handoffValue)
  const sealedFiles = record(handoff?.files)
  if (handoff === undefined || !hasExactKeys(handoff, ['schema_version', 'staging', 'files'])
    || handoff.schema_version !== 1 || handoff.staging !== staging
    || sealedFiles === undefined || !hasExactKeys(sealedFiles, AUTHOR_STAGING_FILES)) {
    throw new Error('author handoff seal schema or staging identity is invalid')
  }
  for (const name of AUTHOR_STAGING_FILES) {
    if (sealedFiles[name] !== `sha256:${files[name].sha256}`) {
      throw new Error(`author handoff changed after seal: ${name} hash mismatch`)
    }
  }
  return {
    handoff: {
      path: authority.handoffPath,
      sha256: createHash('sha256').update(handoffBytes).digest('hex'),
    },
    files,
  }
}

async function beginAuthorHandoffSeal(
  authority: AuthorAuthority,
  exec: ToolExecution,
  command: string,
  hostGate: WorkflowHostGateState,
): Promise<string | undefined> {
  const callId = exec.callId
  const expected = canonicalAuthorHandoffSealCommand(
    authority.kersorPython, authority.sessionDir,
  )
  if (command !== expected) {
    return `author handoff sealing must use the exact Host-authorized command: ${expected}`
  }
  if (!hostCanonicalAuthorToolArguments(exec.arguments, expected)) {
    return 'author handoff sealing requires the exact foreground Host-owned Bash envelope'
  }
  if (authorSealEvent(authority) !== undefined || authorSaveEvents(authority).length !== 0
    || await pathExists(authority.handoffPath)) {
    return 'author handoff sealing is exact-once and this Session is already sealed or consumed'
  }
  const calls = durableAuthorCommandCallIds(authority.controller, expected)
  if (calls.length !== 1 || calls[0] !== callId) {
    return 'author handoff sealing is exact-once; a prior canonical attempt consumed this Session'
  }
  hostGate.authorSealCalls.set(exec, { ...authority, callId, command })
  return undefined
}

async function finishAuthorHandoffSeal(
  ctx: Context,
  state: AuthorSealCallState,
): Promise<void> {
  const bindings = await authorHandoffBindings(state)
  const event: KersorAuthorHandoffSealedEventData = {
    schema_version: 1,
    contract: 'dsh_author_handoff_seal_v1',
    authority: 'dsh_host',
    session_dir: state.sessionDir,
    controller_session_id: state.controller.id,
    seal_call_id: state.callId,
    seal_command: state.command,
    staging_dir: state.stagingDir,
    handoff: bindings.handoff,
    files: bindings.files,
  }
  state.controller.session.append('kersor/author-handoff-sealed', event)
  await ctx.sessions.flush(state.controller.session)
}

async function beginAuthorSaveAttempt(
  ctx: Context,
  authority: AuthorAuthority,
  callId: string,
  command: string,
  argumentsValue: unknown,
  hostGate: WorkflowHostGateState,
): Promise<string | undefined> {
  const expected = canonicalAuthorSaveCommand(authority.kersorPython, authority.sessionDir)
  if (command !== expected) {
    return `authored Proposal save must use the exact Host-authorized command: ${expected}`
  }
  if (!hostCanonicalAuthorToolArguments(argumentsValue, expected)) {
    return 'authored Proposal save requires the exact foreground Host-owned Bash envelope'
  }
  const seal = authorSealEvent(authority)
  if (seal === undefined) return 'authored Proposal save requires its durable Host author seal'
  if (hostGate.consumedAuthorSaves.has(authority.sessionDir)
    || authorSaveEvents(authority).length !== 0) {
    return 'authored Proposal save is exact-once; its canonical attempt is already consumed'
  }
  const calls = durableAuthorCommandCallIds(authority.controller, expected)
  if (calls.length !== 1 || calls[0] !== callId) {
    return 'authored Proposal save is exact-once; a prior canonical attempt consumed this Session'
  }
  const current = await authorHandoffBindings(authority)
  if (!isDeepStrictEqual(current.handoff, seal.data.handoff)
    || !isDeepStrictEqual(current.files, seal.data.files)) {
    return 'authored Proposal save input differs from its durable Host author seal'
  }
  const event: KersorAuthorSaveAttemptedEventData = {
    schema_version: 1,
    contract: 'dsh_author_save_attempt_v1',
    authority: 'dsh_host',
    session_dir: authority.sessionDir,
    controller_session_id: authority.controller.id,
    save_call_id: callId,
    save_command: command,
    seal_call_id: seal.data.seal_call_id,
    staging_dir: authority.stagingDir,
    handoff: current.handoff,
    files: current.files,
  }
  hostGate.consumedAuthorSaves.add(authority.sessionDir)
  authority.controller.session.append('kersor/author-save-attempted', event)
  await ctx.sessions.flush(authority.controller.session)
  return undefined
}

function dispatchArtifactAt(
  workspace: string,
  target: string,
): { readonly runDir: string; readonly name: string } | undefined {
  const path = relative(workspace, target)
  if (path.length === 0 || path === '..' || path.startsWith(`..${sep}`)) return undefined
  const parts = path.split(sep)
  if (parts.length !== 4 || parts[0] !== '.kersor' || parts[1]?.length === 0
    || !/^run-[1-9]\d*$/.test(parts[2] ?? '') || !DISPATCH_ARTIFACTS.has(parts[3] ?? '')) {
    return undefined
  }
  const name = parts[3]
  return name === undefined ? undefined : { runDir: dirname(target), name }
}

async function realMutationTarget(target: string): Promise<string | undefined> {
  try {
    return await realpath(target)
  } catch (error: unknown) {
    if (nodeErrorCode(error) !== 'ENOENT') return undefined
    try {
      return join(await realpath(dirname(target)), basename(target))
    } catch {
      return undefined
    }
  }
}

async function dispatchArtifact(
  agent: Agent,
  filePath: string,
): Promise<{ readonly runDir: string; readonly name: string } | undefined> {
  const workspace = agent.session.header.cwd
  if (workspace === undefined) return undefined
  const lexicalWorkspace = resolve(workspace)
  const lexicalTarget = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(lexicalWorkspace, filePath)
  const lexical = dispatchArtifactAt(lexicalWorkspace, lexicalTarget)
  if (lexical !== undefined) return lexical
  const [realWorkspace, realTarget] = await Promise.all([
    realpath(lexicalWorkspace).catch(() => undefined),
    realMutationTarget(lexicalTarget),
  ])
  return realWorkspace === undefined || realTarget === undefined
    ? undefined
    : dispatchArtifactAt(realWorkspace, realTarget)
}

function baselineArtifactAt(workspace: string, target: string): string | undefined {
  const path = relative(workspace, target)
  if (path.length === 0 || path === '..' || path.startsWith(`..${sep}`)) return undefined
  const parts = path.split(sep)
  return parts.length === 3 && parts[0] === '.kersor' && parts[1]?.length !== 0
    && BASELINE_AUTHORITY_ARTIFACTS.has(parts[2] ?? '')
    ? parts[2]
    : undefined
}

async function baselineArtifact(agent: Agent, filePath: string): Promise<string | undefined> {
  const workspace = agent.session.header.cwd
  if (workspace === undefined) return undefined
  const lexicalWorkspace = resolve(workspace)
  const lexicalTarget = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(lexicalWorkspace, filePath)
  const lexical = baselineArtifactAt(lexicalWorkspace, lexicalTarget)
  if (lexical !== undefined) return lexical
  const [realWorkspace, realTarget] = await Promise.all([
    realpath(lexicalWorkspace).catch(() => undefined),
    realMutationTarget(lexicalTarget),
  ])
  return realWorkspace === undefined || realTarget === undefined
    ? undefined
    : baselineArtifactAt(realWorkspace, realTarget)
}

function hasDispatchArtifactMutation(command: string): boolean {
  const artifact = /(?:dispatch-args(?:-provenance|-producer-receipt|-transformation-receipt)?\.json|candidate-ownership(?:-seal)?\.json)/i
  if (!artifact.test(command)) {
    return false
  }
  return /(?:>|>>|>\|)/.test(command)
    || /\b(?:tee|cp|mv|rm|install)\b/i.test(command)
    || /\bopen\s*\([^)]*,\s*["'][wax+]/i.test(command)
    || /\b(?:write_text|write_bytes)\s*\(/i.test(command)
    || /\bos\.(?:remove|unlink|replace|rename)\s*\(/i.test(command)
}

function hasBaselineAuthorityMutation(command: string): boolean {
  const artifact = new RegExp([
    String.raw`session-config\.json`,
    String.raw`state\.json`,
    String.raw`workflow-catalog\.json`,
    String.raw`test-method\.md`,
    String.raw`baseline-witness\.json`,
    String.raw`baseline-(?:initialization|recording|verification)-receipt\.json`,
    String.raw`session-(?:initialization|authority-import)-receipt\.json`,
  ].join('|'), 'i')
  if (!artifact.test(command)) {
    return false
  }
  return /(?:>|>>|>\|)/.test(command)
    || /\b(?:tee|cp|mv|rm|install)\b/i.test(command)
    || /\bopen\s*\([^)]*,\s*["'][wax+]/i.test(command)
    || /\b(?:write_text|write_bytes)\s*\(/i.test(command)
    || /\bos\.(?:remove|unlink|replace|rename)\s*\(/i.test(command)
}

async function canonicalRuntimeControlsCommand(runDir: string): Promise<string> {
  const prefix = frozenPythonPrefix(await frozenKersorPython())
  return `${prefix} bridge="\${DSH_HOME:-$HOME/.dsh}/.agent-presets/kersor/bin/kersor_bridge.py"; kersor_root="$("$KERSOR_PYTHON" "$bridge" root)"; "$KERSOR_PYTHON" "$kersor_root/scripts/inject-runtime-controls.py" ${shellQuote(runDir)}`
}

async function canonicalCandidateOwnershipSealCommand(runDir: string): Promise<string> {
  const prefix = frozenPythonPrefix(await frozenKersorPython())
  return `${prefix} bridge="\${DSH_HOME:-$HOME/.dsh}/.agent-presets/kersor/bin/kersor_bridge.py"; kersor_root="$("$KERSOR_PYTHON" "$bridge" root)"; "$KERSOR_PYTHON" "$kersor_root/scripts/candidate-ownership.py" seal --session ${shellQuote(dirname(runDir))} --run-dir ${shellQuote(runDir)}`
}

async function baselineWitnessCommandPrefix(): Promise<string> {
  const prefix = frozenPythonPrefix(await frozenKersorPython())
  return `${prefix} bridge="\${DSH_HOME:-$HOME/.dsh}/.agent-presets/kersor/bin/kersor_bridge.py"; kersor_root="$("$KERSOR_PYTHON" "$bridge" root)"; "$KERSOR_PYTHON" "$kersor_root/scripts/baseline-witness.py"`
}

async function canonicalBaselineCommand(
  phase: BaselinePhase,
  sessionDir: string,
  workspace: string,
  launch: KersorLaunchContract,
): Promise<string> {
  const prefix = await baselineWitnessCommandPrefix()
  if (phase === 'initialized') {
    return `${prefix} init --session ${shellQuote(sessionDir)} --correctness-command ${shellQuote(launch.correctness_command)} --benchmark-command ${shellQuote(launch.benchmark_command)}`
  }
  if (phase === 'recorded') {
    return `${prefix} record --session ${shellQuote(sessionDir)} --project-root ${shellQuote(workspace)}`
  }
  return `${prefix} verify --session ${shellQuote(sessionDir)}`
}

function canonicalShellValue(value: string): string | undefined {
  if (!value.startsWith('\'') || !value.endsWith('\'')) return undefined
  const decoded = value.slice(1, -1).replaceAll('\'\\\'\'', '\'')
  return shellQuote(decoded) === value ? decoded : undefined
}

async function baselineCommandSpec(
  command: string,
  workspace: string,
  launch: KersorLaunchContract,
): Promise<{ readonly phase: BaselinePhase; readonly sessionDir: string } | undefined> {
  const prefix = await baselineWitnessCommandPrefix()
  const variants: readonly {
    phase: BaselinePhase
    head: string
    tail: string
  }[] = [
    {
      phase: 'initialized',
      head: `${prefix} init --session `,
      tail: ` --correctness-command ${shellQuote(launch.correctness_command)} --benchmark-command ${shellQuote(launch.benchmark_command)}`,
    },
    {
      phase: 'recorded',
      head: `${prefix} record --session `,
      tail: ` --project-root ${shellQuote(workspace)}`,
    },
    { phase: 'verified', head: `${prefix} verify --session `, tail: '' },
  ]
  for (const variant of variants) {
    if (!command.startsWith(variant.head) || !command.endsWith(variant.tail)) continue
    const encoded = command.slice(variant.head.length, command.length - variant.tail.length)
    const sessionDir = canonicalShellValue(encoded)
    if (sessionDir === undefined
      || command !== await canonicalBaselineCommand(
        variant.phase, sessionDir, workspace, launch,
      )) return undefined
    return { phase: variant.phase, sessionDir }
  }
  return undefined
}

async function isRuntimeControlsCommand(command: string, runDir: string): Promise<boolean> {
  return command === await canonicalRuntimeControlsCommand(runDir)
}

function roundSynthesisPathParts(root: string, target: string): string[] | undefined {
  const path = relative(root, target)
  if (path.length === 0 || isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) {
    return undefined
  }
  const parts = path.split(sep)
  return parts.length === 3
    && parts[0] === '.kersor'
    && parts[1]?.length !== 0
    && /^round-[1-9]\d*-(?:summary\.md|transfer\.json)$/.test(parts[2] ?? '')
    ? parts
    : undefined
}

async function isRoundSynthesisArtifact(agent: Agent, filePath: string): Promise<boolean> {
  const workspace = agent.session.header.cwd
  if (workspace === undefined) return false
  const lexicalWorkspace = resolve(workspace)
  const lexicalTarget = isAbsolute(filePath) ? resolve(filePath) : resolve(lexicalWorkspace, filePath)
  if (roundSynthesisPathParts(lexicalWorkspace, lexicalTarget) !== undefined) return true
  if (!(await pathExists(lexicalTarget))) return false
  try {
    const [realWorkspace, realTarget] = await Promise.all([
      realpath(lexicalWorkspace),
      realpath(lexicalTarget),
    ])
    return roundSynthesisPathParts(realWorkspace, realTarget) !== undefined
  } catch {
    return false
  }
}

function hasRoundSynthesisMutation(command: string): boolean {
  const artifact = String.raw`round-[1-9]\d*-(?:summary\.md|transfer\.json)`
  if (!new RegExp(artifact, 'i').test(command)) return false
  return new RegExp(String.raw`(?:>|>>|>\|)\s*[^\n;|&]*${artifact}`, 'i').test(command)
    || new RegExp(String.raw`\b(?:tee|cp|mv|rm|install)\b[^\n;|&]*${artifact}`, 'i').test(command)
    || new RegExp(String.raw`\bopen\s*\([^)]*${artifact}[^)]*,\s*["'][wax+][^"']*["']`, 'i').test(command)
    || new RegExp(String.raw`\b(?:write_text|write_bytes)\s*\([^)]*${artifact}`, 'i').test(command)
    || new RegExp(String.raw`\bos\.(?:remove|unlink|replace|rename)\s*\([^)]*${artifact}`, 'i').test(command)
}

function manuallyAdvancesRound(command: string): boolean {
  if (!/\bkersor-state\.sh\b/i.test(command)) return false
  return /\bkersor-state\.sh\b[^\n;|&]*\bset\s+current_round\b/i.test(command)
    || /\bkersor-state\.sh\b[^\n;|&]*\badvance(?:\s|["'])/i.test(command)
}

function manuallyMutatesSessionAuthority(command: string): boolean {
  if (!/\bkersor-state\.sh\b/i.test(command)) return false
  const guardedFields = [
    'phase', 'current_round', 'session_id', 'target_speedup', 'target_override',
    'workflows_filter', 'seed_origin', 'kernel_language', 'backend',
    'integration_pattern', 'yolo',
  ].join('|')
  return new RegExp(
    String.raw`\bkersor-state\.sh\b[^\n;|&]*\bset\s+(?:${guardedFields})\b`,
    'i',
  ).test(command)
}

async function isExistingRunOutput(agent: Agent, filePath: string): Promise<boolean> {
  const workspace = agent.session.header.cwd
  if (workspace === undefined) return false
  const lexicalWorkspace = resolve(workspace)
  const lexicalTarget = isAbsolute(filePath) ? resolve(filePath) : resolve(lexicalWorkspace, filePath)
  if (!(await pathExists(lexicalTarget))) return false
  if (runPathParts(lexicalWorkspace, lexicalTarget, true) !== undefined) return true
  try {
    const [realWorkspace, realTarget] = await Promise.all([
      realpath(lexicalWorkspace),
      realpath(lexicalTarget),
    ])
    return runPathParts(realWorkspace, realTarget, true) !== undefined
  } catch {
    return false
  }
}

function hasRunOutputMutation(command: string): boolean {
  return /(?:>|>>|>\|)\s*[^\n;]*output\.json/i.test(command)
    || /\b(?:tee|cp|mv|rm|install)\b[^\n;]*output\.json/i.test(command)
    || /\bopen\s*\([^)]*output\.json[^)]*,\s*["'][wax+][^"']*["']/i.test(command)
    || /\b(?:write_text|write_bytes)\s*\([^)]*\)/i.test(command)
      && /output\.json/i.test(command)
    || /\bos\.(?:remove|unlink|replace|rename)\s*\([^)]*output\.json/i.test(command)
}

async function bashMutatesExistingRunOutput(agent: Agent, command: string): Promise<boolean> {
  if (!/output\.json/i.test(command) || !hasRunOutputMutation(command)) return false
  if (/\$(?:[a-z_][a-z0-9_]*|\{[a-z_][a-z0-9_]*\})[\\/]output\.json/i.test(command)) {
    // A shell/Python variable hides the target from path validation. Refuse
    // mutation rather than let an existing Host-owned file be an alias away.
    return true
  }
  const candidates = command.match(/(?:\/|\.\.?\/)[^\s"'();|&<>]*[\\/]run-[1-9]\d*[\\/]output\.json/gi) ?? []
  for (const candidate of candidates) {
    if (await isExistingRunOutput(agent, candidate)) return true
  }
  return false
}

function reportAsync(ctx: Context, operation: Promise<void>): void {
  void operation.catch((error: unknown) => {
    ctx.logger.warn('kersor-control: checkpoint persistence failed: %s', error instanceof Error ? error.message : String(error))
  })
}

async function beginDispatchProducer(
  ctx: Context,
  agent: Agent,
  callId: string,
  argumentsValue: unknown,
  launch: KersorLaunchContract,
  hostGate: WorkflowHostGateState,
): Promise<string | undefined> {
  const spec = dispatchProducerSpec(argumentsValue)
  if (spec === undefined) return undefined
  const runDir = await canonicalRunDirectory(agent, spec.runDir)
  const sessionDir = dirname(runDir)
  if (resolve(spec.sessionDir) !== sessionDir) {
    return 'dispatch producer SESSION_DIR does not own its exact RUN_DIR'
  }
  const baseline = await validateBaselineCustody(ctx, agent, sessionDir, launch)
  const producerCallIndex = agent.session.events.findIndex(event =>
    event.type === 'tool/call' && event.data.name === 'subagent'
    && event.data.callId === callId)
  if (producerCallIndex <= baseline.verifiedEventIndex) {
    return 'dispatch producer canonical call must follow verified baseline Host custody'
  }
  const round = Number.parseInt(basename(runDir).slice(4), 10)
  const selectedWorkflowName = await hostSelectedWorkflowName(runDir)
  if (spec.workflowName !== selectedWorkflowName) {
    return 'dispatch producer WORKFLOW_NAME differs from the Host selected workflow'
  }
  const calls = await durableDispatchProducerCallIds(agent, runDir)
  if (calls.length !== 1 || calls[0] !== callId) {
    return `dispatch producer is exact-once and this run already has a durable producer call: ${runDir}`
  }
  for (const name of [DISPATCH_PRODUCER_RECEIPT, DISPATCH_TRANSFORMATION_RECEIPT]) {
    if (await pathExists(join(runDir, name))) return `dispatch producer Host receipt already exists: ${join(runDir, name)}`
  }
  hostGate.producerCalls.set(callId, {
    controller: agent,
    callId,
    sessionDir,
    runDir,
    round,
    workflowName: spec.workflowName,
    successfulWrites: new Set<string>(),
  })
  return undefined
}

async function finishDispatchProducer(
  ctx: Context,
  state: DispatchProducerState,
  resultValue: unknown,
): Promise<UserMessage> {
  const result = record(resultValue)
  if (result?.kind !== 'foreground' || typeof result.runId !== 'string'
    || state.producerSessionId !== result.runId) {
    throw new Error('foreground dispatch producer result does not identify the sole writer child')
  }
  if (!isDeepStrictEqual(
    [...state.successfulWrites].sort(),
    ['dispatch-args-provenance.json', 'dispatch-args.json'],
  )) {
    throw new Error('foreground dispatch producer must successfully write each semantic output exactly once')
  }
  const args = await readBoundedJsonObject(
    join(state.runDir, 'dispatch-args.json'), MAX_DSH_DISPATCH_ARGS_BYTES, 'dispatch-args.json',
  )
  const provenance = await readBoundedJsonObject(
    join(state.runDir, 'dispatch-args-provenance.json'), MAX_DSH_DISPATCH_ARGS_BYTES,
    'dispatch-args-provenance.json',
  )
  const selectedWorkflowName = await hostSelectedWorkflowName(state.runDir)
  if (state.workflowName !== selectedWorkflowName) {
    throw new Error('foreground dispatch producer WORKFLOW_NAME differs from the Host selected workflow')
  }
  if (Object.hasOwn(args, 'workflow') || Object.hasOwn(args, 'workflow_name')) {
    throw new Error('dispatch-args.json contains a workflow audit field outside the runtime argument contract')
  }
  if (provenance.workflow_name !== selectedWorkflowName) {
    throw new Error('dispatch-args-provenance.json workflow_name differs from the Host selected workflow')
  }
  const receipt: KersorDispatchArgsProducedEventData = {
    schema_version: 1,
    contract: 'dsh_dispatch_args_producer_v1',
    authority: 'dsh_host',
    session_dir: state.sessionDir,
    run_dir: state.runDir,
    round: state.round,
    workflow_name: state.workflowName,
    controller_session_id: state.controller.id,
    producer_session_id: result.runId,
    producer_call_id: state.callId,
    dispatch_args: await dispatchFileBinding(join(state.runDir, 'dispatch-args.json'), 'dispatch-args.json'),
    dispatch_args_provenance: await dispatchFileBinding(
      join(state.runDir, 'dispatch-args-provenance.json'), 'dispatch-args-provenance.json',
    ),
  }
  const transformationContext = await dispatchTransformationContext(receipt)
  await atomicHostReceipt(join(state.runDir, DISPATCH_PRODUCER_RECEIPT), receipt)
  state.controller.session.append('kersor/dispatch-args-produced', receipt)
  await ctx.sessions.flush(state.controller.session)
  return transformationContext
}

async function dispatchTransformationContext(
  producer: KersorDispatchArgsProducedEventData,
): Promise<UserMessage> {
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        'KERSOR_DISPATCH_TRANSFORM_COMMAND_V1',
        `Host durable producer binding: run_dir=${producer.run_dir}; producer_call_id=${producer.producer_call_id}.`,
        'Execute the following exact single Bash command once, verbatim:',
        await canonicalRuntimeControlsCommand(producer.run_dir),
        'Do not add flags, variables, redirections, prefixes, or suffixes. Do not inspect the injector, probe alternate syntax, or retry after any rejection or failure.',
      ].join('\n'),
    }],
    source: { kind: 'plugin', plugin: 'kersor' },
  })
}

function topLevelChangedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => !isDeepStrictEqual(before[key], after[key]))
    .sort()
}

const RUNTIME_ARGS_FIELDS = new Set([
  'termination_file', 'deadline_epoch', 'sol_cuda_visible_devices',
  'cuda_visible_devices', 'gpu', 'gpu_id', 'device', 'sol_env_prefix',
  'env_prefix', 'sol_cli', 'benchmark_command', 'test_command', 'baseline_command',
])
const RUNTIME_PROVENANCE_FIELDS = new Set(['runtime_controls', 'benchmark_gpu_lease'])

async function beginDispatchTransformation(
  agent: Agent,
  callId: string,
  command: string,
  hostGate: WorkflowHostGateState,
): Promise<string | undefined> {
  if (!command.includes('inject-runtime-controls.py')) return undefined
  const produced = agent.session.events
    .filter((event): event is Extract<SessionEvent, { type: 'kersor/dispatch-args-produced' }> =>
      event.type === 'kersor/dispatch-args-produced')
  const matching: typeof produced = []
  for (const event of produced) {
    if (await isRuntimeControlsCommand(command, event.data.run_dir)) matching.push(event)
  }
  if (matching.length !== 1) {
    const transformedRuns = new Set(agent.session.events.flatMap(event =>
      event.type === 'kersor/dispatch-args-transformed' ? [event.data.run_dir] : []))
    const pending = produced.filter(event => !transformedRuns.has(event.data.run_dir))
    const producer = pending.length === 1 ? pending[0]?.data : undefined
    if (producer !== undefined) {
      return [
        'runtime-control injection command does not match the unique pending Host producer event.',
        `Bound run_dir=${producer.run_dir}; producer_call_id=${producer.producer_call_id}.`,
        `Required exact command: ${await canonicalRuntimeControlsCommand(producer.run_dir)}`,
        'Do not retry this transform call after the Host rejection.',
      ].join(' ')
    }
    return 'runtime-control injection must identify one Host-produced dispatch run'
  }
  const matchingProducer = matching[0]
  if (matchingProducer === undefined) return 'runtime-control injection lost its producer event'
  const producer = matchingProducer.data
  if (!await isRuntimeControlsCommand(command, producer.run_dir)) {
    return `runtime-control injection command is not the exact single deterministic injector invocation. Required: ${await canonicalRuntimeControlsCommand(producer.run_dir)}`
  }
  const priorCalls = await durableDispatchTransformationCallIds(agent, producer.run_dir)
  if (priorCalls.length !== 1 || priorCalls[0] !== callId) {
    return 'runtime-control injection is exact-once for this dispatch run'
  }
  const receiptPath = join(producer.run_dir, DISPATCH_PRODUCER_RECEIPT)
  const receiptBytes = await readBoundedRegularFile(
    receiptPath, MAX_DSH_DISPATCH_RECEIPT_BYTES, DISPATCH_PRODUCER_RECEIPT,
  )
  const receipt = JSON.parse(receiptBytes.toString('utf8')) as unknown
  if (!isDeepStrictEqual(receipt, producer)) return 'producer receipt differs from the durable Host producer event'
  const currentArgs = await dispatchFileBinding(producer.dispatch_args.path, 'dispatch-args.json')
  const currentProvenance = await dispatchFileBinding(
    producer.dispatch_args_provenance.path, 'dispatch-args-provenance.json',
  )
  if (!isDeepStrictEqual(currentArgs, producer.dispatch_args)
    || !isDeepStrictEqual(currentProvenance, producer.dispatch_args_provenance)) {
    return 'runtime-control injection input differs from the Host producer bytes'
  }
  if (await pathExists(join(producer.run_dir, DISPATCH_TRANSFORMATION_RECEIPT))) {
    return 'dispatch transformation receipt already exists'
  }
  hostGate.transformationCalls.set(callId, {
    controller: agent,
    callId,
    sessionDir: producer.session_dir,
    runDir: producer.run_dir,
    producer,
    producerReceiptPath: receiptPath,
    producerReceiptSha256: createHash('sha256').update(receiptBytes).digest('hex'),
    beforeArgs: await readBoundedJsonObject(
      producer.dispatch_args.path, MAX_DSH_DISPATCH_ARGS_BYTES, 'dispatch-args.json',
    ),
    beforeProvenance: await readBoundedJsonObject(
      producer.dispatch_args_provenance.path, MAX_DSH_DISPATCH_ARGS_BYTES,
      'dispatch-args-provenance.json',
    ),
  })
  return undefined
}

async function finishDispatchTransformation(
  ctx: Context,
  state: DispatchTransformationState,
): Promise<void> {
  const afterArgs = await readBoundedJsonObject(
    state.producer.dispatch_args.path, MAX_DSH_DISPATCH_ARGS_BYTES, 'dispatch-args.json',
  )
  const afterProvenance = await readBoundedJsonObject(
    state.producer.dispatch_args_provenance.path, MAX_DSH_DISPATCH_ARGS_BYTES,
    'dispatch-args-provenance.json',
  )
  const argsFields = topLevelChangedFields(state.beforeArgs, afterArgs)
  const provenanceFields = topLevelChangedFields(state.beforeProvenance, afterProvenance)
  if (argsFields.some(field => !RUNTIME_ARGS_FIELDS.has(field))
    || provenanceFields.some(field => !RUNTIME_PROVENANCE_FIELDS.has(field))) {
    throw new Error('inject-runtime-controls changed a field outside its deterministic allowlist')
  }
  const outputArgs = await dispatchFileBinding(state.producer.dispatch_args.path, 'dispatch-args.json')
  const outputProvenance = await dispatchFileBinding(
    state.producer.dispatch_args_provenance.path, 'dispatch-args-provenance.json',
  )
  const changed = !isDeepStrictEqual(outputArgs, state.producer.dispatch_args)
    || !isDeepStrictEqual(outputProvenance, state.producer.dispatch_args_provenance)
  const receipt: KersorDispatchArgsTransformedEventData = {
    schema_version: 1,
    contract: 'dsh_dispatch_args_transformation_v1',
    authority: 'dsh_host',
    transformer: 'inject-runtime-controls',
    session_dir: state.sessionDir,
    run_dir: state.runDir,
    round: state.producer.round,
    workflow_name: state.producer.workflow_name,
    controller_session_id: state.controller.id,
    transformation_call_id: state.callId,
    producer_receipt: { path: state.producerReceiptPath, sha256: state.producerReceiptSha256 },
    input: {
      dispatch_args: state.producer.dispatch_args,
      dispatch_args_provenance: state.producer.dispatch_args_provenance,
    },
    output: { dispatch_args: outputArgs, dispatch_args_provenance: outputProvenance },
    changed,
    authorized_fields: {
      dispatch_args: argsFields,
      dispatch_args_provenance: provenanceFields,
    },
  }
  await atomicHostReceipt(join(state.runDir, DISPATCH_TRANSFORMATION_RECEIPT), receipt)
  state.controller.session.append('kersor/dispatch-args-transformed', receipt)
  await ctx.sessions.flush(state.controller.session)
}

function baselineReceiptPath(sessionDir: string, phase: BaselinePhase): string {
  return join(sessionDir, phase === 'initialized'
    ? BASELINE_INITIALIZATION_RECEIPT
    : phase === 'recorded'
      ? BASELINE_RECORDING_RECEIPT
      : BASELINE_VERIFICATION_RECEIPT)
}

function baselineEventType(phase: BaselinePhase):
  | 'kersor/baseline-initialized'
  | 'kersor/baseline-recorded'
  | 'kersor/baseline-verified' {
  return `kersor/baseline-${phase}`
}

function baselineContract(phase: BaselinePhase): string {
  return `dsh_baseline_${phase}_v1`
}

function baselineDataMatchesAuthority(
  data: Record<string, unknown>,
  authority: BaselineAuthority,
  controllerSessionId: string,
): boolean {
  if (!nonWhitespaceToken(data.call_id)) return false
  const common = baselineEventCommon(authority, controllerSessionId, data.call_id)
  return Object.entries(common).every(([key, value]) => isDeepStrictEqual(data[key], value))
}

async function baselinePhaseReceipt(
  agent: Agent,
  phase: BaselinePhase,
  authority: BaselineAuthority,
): Promise<{
  readonly data: Record<string, unknown>
  readonly path: string
  readonly sha256: string
  readonly eventIndex: number
  readonly callIndex: number
}> {
  const path = baselineReceiptPath(authority.sessionDir, phase)
  const bytes = await readBoundedRegularFile(
    path, MAX_BASELINE_AUTHORITY_BYTES, `baseline ${phase} Host receipt`,
  )
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) } catch {
    throw new Error(`baseline ${phase} Host receipt is malformed JSON`)
  }
  const receipt = record(value)
  const expectedKeys = phase === 'initialized'
    ? BASELINE_COMMON_KEYS
    : phase === 'recorded'
      ? BASELINE_RECORDED_KEYS
      : BASELINE_VERIFIED_KEYS
  if (receipt === undefined || !hasExactKeys(receipt, expectedKeys)
    || receipt.schema_version !== 1 || receipt.contract !== baselineContract(phase)
    || receipt.authority !== 'dsh_host'
    || !baselineDataMatchesAuthority(receipt, authority, agent.id)) {
    throw new Error(`baseline ${phase} Host receipt identity is invalid`)
  }
  const type = baselineEventType(phase)
  const events = agent.session.events.filter(event =>
    event.type === type && event.data.session_dir === authority.sessionDir)
  const event = events[0]
  if (events.length !== 1 || event === undefined || !isDeepStrictEqual(event.data, receipt)) {
    throw new Error(`baseline ${phase} receipt lacks one matching durable Host event`)
  }
  const calls = await durableBaselineCallIds(
    agent, phase, authority.sessionDir, authority.workspace, authority.launch,
  )
  if (calls.length !== 1 || calls[0] !== receipt.call_id) {
    throw new Error(`baseline ${phase} receipt lacks its exact durable canonical Bash call`)
  }
  const eventIndex = agent.session.events.indexOf(event)
  const callIndex = agent.session.events.findIndex(event =>
    event.type === 'tool/call' && event.data.callId === receipt.call_id
    && event.data.name === 'bash')
  if (callIndex < 0 || eventIndex <= callIndex) {
    throw new Error(`baseline ${phase} durable event does not follow its canonical call`)
  }
  return {
    data: receipt,
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    eventIndex,
    callIndex,
  }
}

async function validateBaselineCustody(
  ctx: Context,
  agent: Agent,
  sessionDir: string,
  launch: KersorLaunchContract | undefined,
): Promise<{
  readonly authority: BaselineAuthority
  readonly witness: { readonly path: string; readonly sha256: string }
  readonly executions: readonly KersorBaselineExecutionEventData[]
  readonly verifiedEventIndex: number
  readonly stateSessionId: string
}> {
  if (launch === undefined) {
    throw new Error('baseline Host custody requires the immutable typed launch contract')
  }
  const binding = controllerBinding(ctx, agent)?.binding
  if (binding === undefined) {
    throw new Error('baseline Host custody lost its conversation Experiment binding')
  }
  const sessionAuthority = await validateSessionAuthority(ctx, agent, binding, sessionDir)
  const owner = await baselineOwner(agent, sessionDir, launch)
  const authority = await baselineAuthority(owner)
  const witness = await validateBaselineWitness(authority)
  const initialized = await baselinePhaseReceipt(
    sessionAuthority.authorityAgent, 'initialized', authority,
  )
  const recorded = await baselinePhaseReceipt(
    sessionAuthority.authorityAgent, 'recorded', authority,
  )
  const verified = await baselinePhaseReceipt(
    sessionAuthority.authorityAgent, 'verified', authority,
  )
  const initializationBinding = receiptFileBinding(
    recorded.data, 'initialization_receipt', initialized.path,
    'baseline recorded receipt',
  )
  const recordingBinding = receiptFileBinding(
    verified.data, 'recording_receipt', recorded.path,
    'baseline verified receipt',
  )
  const recordedWitness = receiptFileBinding(
    recorded.data, 'witness', witness.binding.path, 'baseline recorded receipt',
  )
  const verifiedWitness = receiptFileBinding(
    verified.data, 'witness', witness.binding.path, 'baseline verified receipt',
  )
  if (initializationBinding.sha256 !== initialized.sha256
    || recordingBinding.sha256 !== recorded.sha256
    || recordedWitness.sha256 !== witness.binding.sha256
    || verifiedWitness.sha256 !== witness.binding.sha256
    || !isDeepStrictEqual(recorded.data.executions, witness.executions)
    || !isDeepStrictEqual(verified.data.executions, witness.executions)
    || verified.data.verdict !== 'pass'
    || recorded.callIndex <= initialized.eventIndex
    || recorded.eventIndex <= recorded.callIndex
    || verified.callIndex <= recorded.eventIndex
    || verified.eventIndex <= verified.callIndex) {
    throw new Error('baseline Host custody receipt chain, execution evidence, or order is invalid')
  }
  const protectedFiles = record(verified.data.protected_files)
  const worktree = record(verified.data.worktree)
  if (protectedFiles === undefined || worktree === undefined
    || Object.values(protectedFiles).some(value =>
      typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))) {
    throw new Error('baseline verified ownership snapshot is malformed')
  }
  const gitRoot = await candidateGitRoot(authority.workspace)
  const currentProtected = await currentProtectedFiles(
    authority.workspace, authority.kernel.path, gitRoot,
  )
  const protectedDifference = ownershipMapDifference(protectedFiles, currentProtected)
  if (protectedDifference !== undefined) {
    throw new Error(`baseline protected file changed after verification: ${protectedDifference}`)
  }
  const currentWorktree = await currentWorktreeSnapshot(authority.sessionDir, gitRoot)
  if (!isDeepStrictEqual(worktree, currentWorktree)) {
    throw new Error('baseline worktree changed after verification')
  }
  return {
    authority,
    witness: witness.binding,
    executions: witness.executions,
    verifiedEventIndex: binding.start.origin === 'created'
      ? verified.eventIndex
      : sessionAuthority.eventIndex,
    stateSessionId: binding.start.origin === 'created'
      ? agent.id
      : String(sessionAuthority.data.source_controller_session_id),
  }
}

async function beginBaselineWitness(
  ctx: Context,
  agent: Agent,
  callId: string,
  command: string,
  launch: KersorLaunchContract | undefined,
  binding: ExperimentBinding,
  hostGate: WorkflowHostGateState,
): Promise<string | undefined> {
  if (!command.includes('baseline-witness.py')) return undefined
  if (launch === undefined) {
    return 'baseline custody requires an immutable typed KerSor launch contract'
  }
  const cwd = agent.session.header.cwd
  if (cwd === undefined) return 'baseline custody requires a controller workspace'
  const workspace = await realpath(resolve(cwd))
  const spec = await baselineCommandSpec(command, workspace, launch)
  if (spec === undefined) {
    return 'baseline init/record/verify must use one exact canonical Host-authorized command'
  }
  const initialization = await validateSessionAuthority(
    ctx, agent, binding, spec.sessionDir,
  )
  const owner = await baselineOwner(agent, spec.sessionDir, launch)
  const calls = await durableBaselineCallIds(
    agent, spec.phase, owner.sessionDir, owner.workspace, owner.launch,
  )
  if (calls.length !== 1 || calls[0] !== callId) {
    return `baseline ${spec.phase} is exact-once for this Session`
  }
  if (await pathExists(baselineReceiptPath(owner.sessionDir, spec.phase))) {
    return `baseline ${spec.phase} Host receipt already exists`
  }
  if (agent.session.events.some(event =>
    (event.type === 'kersor/dispatch-args-produced'
      || event.type === 'kersor/dispatch-args-transformed'
      || event.type === 'kersor/candidate-ownership-sealed')
    && event.data.session_dir === owner.sessionDir)) {
    return 'baseline verification must complete before dispatch production or candidate sealing'
  }
  const testMethodPath = join(owner.sessionDir, 'test-method.md')
  const witnessPath = join(owner.sessionDir, 'baseline-witness.json')
  const callIndex = agent.session.events.findIndex(event =>
    event.type === 'tool/call' && event.data.callId === callId && event.data.name === 'bash')
  if (callIndex <= initialization.eventIndex) {
    return 'baseline initialization call must follow durable Session initialization/import authority'
  }
  if (spec.phase === 'initialized') {
    if (await pathExists(testMethodPath) || await pathExists(witnessPath)
      || agent.session.events.some(event =>
        event.type === 'kersor/baseline-initialized'
        && event.data.session_dir === owner.sessionDir)) {
      return 'baseline initialization is exact-once and requires absent test-method/witness owners'
    }
  } else {
    const authority = await baselineAuthority(owner)
    const previousPhase: BaselinePhase = spec.phase === 'recorded' ? 'initialized' : 'recorded'
    const previous = await baselinePhaseReceipt(agent, previousPhase, authority)
    if (callIndex <= previous.eventIndex) {
      return `baseline ${spec.phase} canonical call does not follow its predecessor event`
    }
    if (spec.phase === 'recorded') {
      if (await pathExists(witnessPath)) {
        return 'baseline recording requires an absent immutable witness'
      }
    } else {
      await validateBaselineWitness(authority)
    }
  }
  hostGate.baselineCalls.set(callId, {
    controller: agent,
    callId,
    phase: spec.phase,
    owner,
  })
  return undefined
}

async function finishBaselineWitness(
  ctx: Context,
  state: BaselineCallState,
): Promise<void> {
  const authority = await baselineAuthority(state.owner)
  if (state.phase === 'initialized') {
    const event: KersorBaselineInitializedEventData = {
      ...baselineEventCommon(authority, state.controller.id, state.callId),
      contract: 'dsh_baseline_initialized_v1',
    }
    await atomicHostReceipt(baselineReceiptPath(authority.sessionDir, state.phase), event)
    state.controller.session.append('kersor/baseline-initialized', event)
    await ctx.sessions.flush(state.controller.session)
    return
  }
  const witness = await validateBaselineWitness(authority)
  if (state.phase === 'recorded') {
    const initialized = await baselinePhaseReceipt(
      state.controller, 'initialized', authority,
    )
    const event: KersorBaselineRecordedEventData = {
      ...baselineEventCommon(authority, state.controller.id, state.callId),
      contract: 'dsh_baseline_recorded_v1',
      initialization_receipt: { path: initialized.path, sha256: initialized.sha256 },
      witness: witness.binding,
      executions: witness.executions,
    }
    await atomicHostReceipt(baselineReceiptPath(authority.sessionDir, state.phase), event)
    state.controller.session.append('kersor/baseline-recorded', event)
    await ctx.sessions.flush(state.controller.session)
    return
  }
  const recorded = await baselinePhaseReceipt(state.controller, 'recorded', authority)
  const event: KersorBaselineVerifiedEventData = {
    ...baselineEventCommon(authority, state.controller.id, state.callId),
    contract: 'dsh_baseline_verified_v1',
    recording_receipt: { path: recorded.path, sha256: recorded.sha256 },
    witness: witness.binding,
    executions: witness.executions,
    protected_files: await currentProtectedFiles(
      authority.workspace,
      authority.kernel.path,
      await candidateGitRoot(authority.workspace),
    ),
    worktree: await currentWorktreeSnapshot(
      authority.sessionDir,
      await candidateGitRoot(authority.workspace),
    ),
    verdict: 'pass',
  }
  await atomicHostReceipt(baselineReceiptPath(authority.sessionDir, state.phase), event)
  state.controller.session.append('kersor/baseline-verified', event)
  await ctx.sessions.flush(state.controller.session)
}

async function beginCandidateOwnershipSeal(
  agent: Agent,
  callId: string,
  command: string,
  hostGate: WorkflowHostGateState,
): Promise<string | undefined> {
  if (!command.includes('candidate-ownership.py') || !/(?:^|\s)seal(?:\s|$)/.test(command)) {
    return undefined
  }
  const transformed = agent.session.events.filter(
    (event): event is Extract<SessionEvent, { type: 'kersor/dispatch-args-transformed' }> =>
      event.type === 'kersor/dispatch-args-transformed',
  )
  const matching: typeof transformed = []
  for (const event of transformed) {
    if (command === await canonicalCandidateOwnershipSealCommand(event.data.run_dir)) {
      matching.push(event)
    }
  }
  if (matching.length !== 1) {
    return 'candidate ownership sealing must be one exact canonical Host-authorized command for one transformed dispatch run'
  }
  const transformationEvent = matching[0]
  if (transformationEvent === undefined) {
    return 'candidate ownership sealing lost its transformed dispatch event'
  }
  const transformation = transformationEvent.data
  const calls = await durableCandidateSealCallIds(agent, transformation.run_dir)
  if (calls.length !== 1 || calls[0] !== callId) {
    return 'candidate ownership sealing is exact-once for this dispatch run'
  }
  const sealPath = join(transformation.run_dir, CANDIDATE_OWNERSHIP_SEAL)
  if (await pathExists(sealPath)) {
    return `candidate ownership seal already exists: ${sealPath}`
  }
  const priorEvents = agent.session.events.filter(event =>
    event.type === 'kersor/candidate-ownership-sealed'
    && event.data.run_dir === transformation.run_dir)
  if (priorEvents.length !== 0) {
    return 'candidate ownership durable seal event already exists for this run'
  }
  hostGate.candidateSealCalls.set(callId, {
    controller: agent,
    callId,
    sessionDir: transformation.session_dir,
    runDir: transformation.run_dir,
    round: transformation.round,
  })
  return undefined
}

async function finishCandidateOwnershipSeal(
  ctx: Context,
  state: CandidateSealState,
): Promise<void> {
  const envelope = await readDshWorkflowEnvelope(state.runDir)
  const custody = await validateDispatchCustody(state.controller, state.runDir, envelope)
  const launch = controllerBinding(ctx, state.controller)?.binding.start.launch
  const seal = await validateCandidateOwnershipSealFile(
    ctx, state.controller, state.runDir, envelope, custody, launch,
  )
  const event: KersorCandidateOwnershipSealedEventData = {
    schema_version: 1,
    contract: 'dsh_candidate_ownership_seal_v1',
    authority: 'dsh_host',
    session_dir: state.sessionDir,
    run_dir: state.runDir,
    round: state.round,
    controller_session_id: state.controller.id,
    seal_call_id: state.callId,
    seal: { path: seal.path, sha256: seal.sha256 },
    state: seal.state,
  }
  state.controller.session.append('kersor/candidate-ownership-sealed', event)
  await ctx.sessions.flush(state.controller.session)
}

/** Register the start/resume tools and project child settlement into the parent log. */
export function apply(ctx: Context): void {
  const workflowHostGate: WorkflowHostGateState = {
    authorizedNativeCallIds: new Set<string>(),
    consumedRuns: new Set<string>(),
    producerCalls: new Map<string, DispatchProducerState>(),
    producerChildren: new Map<string, DispatchProducerState>(),
    transformationCalls: new Map<string, DispatchTransformationState>(),
    candidateSealCalls: new Map<string, CandidateSealState>(),
    baselineCalls: new Map<string, BaselineCallState>(),
    authorSealCalls: new WeakMap<ToolExecution, AuthorSealCallState>(),
    consumedAuthorSaves: new Set<string>(),
    setupCalls: new WeakMap<ToolExecution, SessionSetupCallState>(),
    activeExperiments: new Set<string>(),
  }
  ctx.tools.register(createStart(ctx))
  ctx.tools.register(createAttach(ctx))
  ctx.tools.register(createResume(ctx))
  ctx.tools.register(createSealedWorkflow(ctx, workflowHostGate))
  ctx.on('bash/sandbox-escalation', (exec, escalation) => {
    const setup = workflowHostGate.setupCalls.get(exec)
    if (setup?.controller === exec.agent) escalation.suppress()
  })
  ctx.on('tools/result', (exec) => {
    workflowHostGate.setupCalls.delete(exec)
    workflowHostGate.authorSealCalls.delete(exec)
  })
  const forbiddenControllerTools = new Set([
    'kersor_start', 'kersor_attach', 'kersor_resume',
    'subagent_codex', 'subagent_claude_code',
  ])
  const forbiddenParentTools = new Set([
    'kersor_status',
    'subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code',
    'workflow', 'ralph',
    'list_agents', 'send_message', 'interrupt_agent',
    'job_output', 'job_list', 'job_kill',
  ])
  const authorPathTools = new Set([
    'read', 'write', 'edit', 'multi_edit', 'multiedit', 'glob', 'grep',
  ])
  ctx.on('tools/pre-execute', async (exec, next) => {
    const agent = exec.agent
    if (agent === undefined) return next()
    const owned = controllerBinding(ctx, agent)
    const experimentAncestry = owned?.binding ?? experimentControllerAncestor(ctx, agent)
    const transferredBy = ctx.sessions.list().flatMap(session =>
      session.events.filter((event): event is Extract<SessionEvent, { type: 'kersor/experiment-start' }> =>
        event.type === 'kersor/experiment-start'
        && event.data.origin === 'attached'
        && event.data.authorityIntent?.source_controller_session_id === agent.id))
    const pendingImportReadOnlyTools = new Set(['kersor_status', 'read', 'glob', 'grep'])
    if (transferredBy.length > 0) {
      return {
        kind: 'deny' as const,
        reason: 'KerSor source controller authority was durably transferred and this controller is permanently retired.',
      }
    }
    if (owned?.binding.start.origin === 'attached'
      && !agent.session.events.some(event =>
        event.type === 'kersor/session-authority-imported'
        && event.data.experiment_id === owned.binding.start.experimentId)
      && !pendingImportReadOnlyTools.has(exec.name)) {
      return {
        kind: 'deny' as const,
        reason: 'KerSor attached controller is waiting for its durable Host authority import; mutating and delegating tools are locked.',
      }
    }
    if (experimentAncestry !== undefined
      && workflowHostGate.activeExperiments.has(experimentAncestry.start.experimentId)
      && (exec.name === 'bash' || exec.name === 'write' || exec.name === 'edit'
        || exec.name === 'subagent')) {
      return {
        kind: 'deny' as const,
        reason: 'KerSor ownership verification is in flight; mutating or delegating tools remain locked until the Host publishes its post-Workflow verdict.',
      }
    }
    let authorAuthority: AuthorAuthority | undefined
    let authorCommand: CanonicalAuthorCommandKind | undefined
    let acceptedNonAuthorHostBashGate = false
    if (experimentAncestry !== undefined
      && (exec.name === 'bash' || authorPathTools.has(exec.name))) {
      try {
        authorAuthority = await authorAuthorityForAgent(ctx, agent)
        if (exec.name === 'bash' && authorAuthority !== undefined) {
          authorCommand = canonicalAuthorCommandKind(
            exec.arguments, canonicalAuthorCommands(authorAuthority),
          )
        }
      } catch (error: unknown) {
        return {
          kind: 'deny' as const,
          reason: `author custody failed closed: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
    if (owned !== undefined) {
      if (exec.name !== 'kersor_status' && owned.binding.closure !== undefined) {
        return Promise.resolve({
          kind: 'deny' as const,
          reason: `KerSor controller ${agent.id} is ${owned.binding.closure}; only kersor_status may run after this closed boundary`,
        })
      }
      if (forbiddenControllerTools.has(exec.name)) {
        return {
          kind: 'deny' as const,
          reason: `KerSor controller children cannot execute ${exec.name}; use dsh-native spawn/workflow capabilities`,
        }
      }
      if (authorAuthority !== undefined && authorPathTools.has(exec.name)) {
        if (await authorPathToolTargetsStaging(
          authorAuthority, agent, exec.name, exec.arguments,
        )) {
          return {
            kind: 'deny' as const,
            reason: 'The direct KerSor controller may not inspect or mutate author staging; only the foreground author may self-check before the Host seal.',
          }
        }
      }
      if (exec.name === 'subagent') {
        try {
          const reason = await beginDispatchProducer(
            ctx, agent, exec.callId, exec.arguments, owned.binding.start.launch,
            workflowHostGate,
          )
          if (reason !== undefined) return { kind: 'deny' as const, reason }
        } catch (error: unknown) {
          return {
            kind: 'deny' as const,
            reason: `dispatch producer custody failed closed: ${error instanceof Error ? error.message : String(error)}`,
          }
        }
      }
      if (exec.name === 'bash') {
        const command = bashCommand(exec.arguments)
        if (command !== undefined && authorCommand === 'seal') {
          if (authorAuthority === undefined) {
            return {
              kind: 'deny' as const,
              reason: 'author handoff sealing requires one Host-initialized authoring Session',
            }
          }
          try {
            const reason = await beginAuthorHandoffSeal(
              authorAuthority, exec, command, workflowHostGate,
            )
            if (reason !== undefined) return { kind: 'deny' as const, reason }
          } catch (error: unknown) {
            return {
              kind: 'deny' as const,
              reason: `author handoff custody failed closed: ${error instanceof Error ? error.message : String(error)}`,
            }
          }
        } else if (command !== undefined && authorCommand === 'save') {
          if (authorAuthority === undefined) {
            return {
              kind: 'deny' as const,
              reason: 'authored Proposal save requires one Host-initialized authoring Session',
            }
          }
          try {
            const reason = await beginAuthorSaveAttempt(
              ctx, authorAuthority, exec.callId, command, exec.arguments, workflowHostGate,
            )
            if (reason !== undefined) return { kind: 'deny' as const, reason }
          } catch (error: unknown) {
            return {
              kind: 'deny' as const,
              reason: `authored Proposal save custody failed closed: ${error instanceof Error ? error.message : String(error)}`,
            }
          }
        } else if (command !== undefined && command.includes('setup-session.sh')) {
          try {
            const reason = await beginSessionSetup(exec, owned.binding, workflowHostGate)
            if (reason !== undefined) return { kind: 'deny' as const, reason }
            acceptedNonAuthorHostBashGate = true
          } catch (error: unknown) {
            return {
              kind: 'deny' as const,
              reason: `Session initialization custody failed closed: ${error instanceof Error ? error.message : String(error)}`,
            }
          }
        } else if (command !== undefined && command.includes('baseline-witness.py')) {
          try {
            const reason = await beginBaselineWitness(
              ctx, agent, exec.callId, command, owned.binding.start.launch,
              owned.binding, workflowHostGate,
            )
            if (reason !== undefined) return { kind: 'deny' as const, reason }
            acceptedNonAuthorHostBashGate = true
          } catch (error: unknown) {
            return {
              kind: 'deny' as const,
              reason: `baseline Host custody failed closed: ${error instanceof Error ? error.message : String(error)}`,
            }
          }
        } else if (command !== undefined && command.includes('candidate-ownership.py')
          && /(?:^|\s)seal(?:\s|$)/.test(command)) {
          try {
            const reason = await beginCandidateOwnershipSeal(
              agent, exec.callId, command, workflowHostGate,
            )
            if (reason !== undefined) return { kind: 'deny' as const, reason }
            acceptedNonAuthorHostBashGate = true
          } catch (error: unknown) {
            return {
              kind: 'deny' as const,
              reason: `candidate ownership seal custody failed closed: ${error instanceof Error ? error.message : String(error)}`,
            }
          }
        } else if (command !== undefined && command.includes('inject-runtime-controls.py')) {
          try {
            const reason = await beginDispatchTransformation(
              agent, exec.callId, command, workflowHostGate,
            )
            if (reason !== undefined) return { kind: 'deny' as const, reason }
            acceptedNonAuthorHostBashGate = true
          } catch (error: unknown) {
            return {
              kind: 'deny' as const,
              reason: `dispatch transformation custody failed closed: ${error instanceof Error ? error.message : String(error)}`,
            }
          }
        } else if (command !== undefined && hasDispatchArtifactMutation(command)) {
          return {
            kind: 'deny' as const,
            reason: 'The direct KerSor controller may not shell-mutate dispatch args, provenance, or Host receipts; use the foreground producer and authorized runtime-control pass.',
          }
        } else if (command !== undefined && hasBaselineAuthorityMutation(command)) {
          return {
            kind: 'deny' as const,
            reason: 'The KerSor controller may not shell-mutate Session config, test method, baseline witness, or Host baseline receipts.',
          }
        }
        if (command !== undefined && (manuallyAdvancesRound(command)
          || manuallyMutatesSessionAuthority(command))) {
          return {
            kind: 'deny' as const,
            reason: 'The KerSor controller may not directly mutate launch-bound Session state or advance current_round. Only Host-validated protocol adapters may change state.json.',
          }
        }
        if (command !== undefined && hasRoundSynthesisMutation(command)) {
          return {
            kind: 'deny' as const,
            reason: 'The direct KerSor controller may not create or mutate round-N-summary.md or round-N-transfer.json; the foreground session-synthesizer is their sole writer.',
          }
        }
      }
      if (exec.name === 'write' || exec.name === 'edit') {
        const filePath = filePathArgument(exec.arguments)
        if (filePath !== undefined && await dispatchArtifact(agent, filePath) !== undefined) {
          return {
            kind: 'deny' as const,
            reason: 'The direct KerSor controller may not write or edit dispatch args, provenance, or Host receipts; only the foreground producer and Host may own them.',
          }
        }
        if (filePath !== undefined && await baselineArtifact(agent, filePath) !== undefined) {
          return {
            kind: 'deny' as const,
            reason: 'The KerSor controller may not write or edit Session config, test method, baseline witness, or Host baseline receipts.',
          }
        }
        if (filePath !== undefined && await isRoundSynthesisArtifact(agent, filePath)) {
          return {
            kind: 'deny' as const,
            reason: 'The direct KerSor controller may not create or mutate round-N-summary.md or round-N-transfer.json; the foreground session-synthesizer is their sole writer.',
          }
        }
      }
    }
    if (agent.session.header.origin !== 'subagent'
      && experimentBindings(agent.session.events).length > 0
      && forbiddenParentTools.has(exec.name)) {
      return {
        kind: 'deny' as const,
        reason: `KerSor delegation in this parent is reserved to its declared controller child; use kersor_resume instead of ${exec.name}`,
      }
    }
    const experimentDescendant = experimentAncestry !== undefined
    if (exec.name === 'workflow' && experimentDescendant) {
      if (!workflowHostGate.authorizedNativeCallIds.delete(exec.callId)) {
        return {
          kind: 'deny' as const,
          reason: 'KerSor Experiment descendants must dispatch through kersor_workflow; direct native workflow calls are forbidden.',
        }
      }
      const denial = await workflowEnvelopeDenial(agent, exec.arguments)
      if (denial !== undefined) return { kind: 'deny' as const, reason: denial }
    }
    if (exec.name === 'bash' && experimentDescendant) {
      const command = bashCommand(exec.arguments)
      if (command !== undefined) {
        if (owned === undefined && authorCommand !== undefined) {
          return {
            kind: 'deny' as const,
            reason: 'Only the direct KerSor controller may execute Host-authorized author seal and save commands.',
          }
        }
        if (owned === undefined && authorAuthority !== undefined
          && await bashTouchesAuthorStaging(exec.arguments, authorAuthority, agent, false)) {
          return {
            kind: 'deny' as const,
            reason: 'Only the direct KerSor controller may execute Host-authorized author seal and save commands.',
          }
        }
        if (owned === undefined && authorAuthority !== undefined
          && authorSealEvent(authorAuthority) !== undefined
          && await bashTouchesAuthorStaging(exec.arguments, authorAuthority, agent)) {
          return {
            kind: 'deny' as const,
            reason: 'Author staging is permanently inaccessible after its durable Host seal.',
          }
        }
        if (owned === undefined && command.includes('baseline-witness.py')) {
          return {
            kind: 'deny' as const,
            reason: 'Only the direct KerSor controller may execute one Host-authorized baseline command.',
          }
        }
        if (owned === undefined && command.includes('setup-session.sh')) {
          return {
            kind: 'deny' as const,
            reason: 'Only the direct KerSor controller may execute the exact Host-authorized Session setup command.',
          }
        }
        if (owned === undefined && command.includes('candidate-ownership.py')
          && /(?:^|\s)seal(?:\s|$)/.test(command)) {
          return {
            kind: 'deny' as const,
            reason: 'Only the direct KerSor controller may execute the Host-authorized candidate seal.',
          }
        }
        if (owned === undefined && command.includes('inject-runtime-controls.py')) {
          return {
            kind: 'deny' as const,
            reason: 'Only the direct KerSor controller may execute the exact Host-authorized runtime-control injector.',
          }
        }
        if (hasDispatchArtifactMutation(command)) {
          return {
            kind: 'deny' as const,
            reason: 'KerSor descendants may not shell-mutate dispatch args, provenance, or Host receipts.',
          }
        }
        if (hasBaselineAuthorityMutation(command)) {
          return {
            kind: 'deny' as const,
            reason: 'KerSor descendants may not shell-mutate baseline authority artifacts.',
          }
        }
        if (manuallyMutatesSessionAuthority(command)) {
          return {
            kind: 'deny' as const,
            reason: 'KerSor descendants may not directly mutate launch-bound Session state.',
          }
        }
        if (await bashMutatesExistingRunOutput(agent, command)) {
          return {
            kind: 'deny' as const,
            reason: 'Existing KerSor run-N/output.json is immutable and Host-owned; Bash redirection, tee/cp/mv/rm, and Python open/write mutation paths are forbidden.',
          }
        }
        const denial = await kersorBashDenial(command)
        if (denial !== undefined) return { kind: 'deny' as const, reason: denial }
      }
    }
    if (exec.name === 'bash' && owned !== undefined && authorAuthority !== undefined
      && authorCommand === undefined && !acceptedNonAuthorHostBashGate) {
      const command = bashCommand(exec.arguments)
      if (command !== undefined
        && await bashTouchesAuthorStaging(exec.arguments, authorAuthority, agent)) {
        return {
          kind: 'deny' as const,
          reason: 'The direct KerSor controller may not inspect or mutate author staging; its first staging action is the exact Host-authorized seal.',
        }
      }
    }
    if (owned === undefined && authorAuthority !== undefined
      && authorPathTools.has(exec.name)
      && authorSealEvent(authorAuthority) !== undefined) {
      if (await authorPathToolTargetsStaging(
        authorAuthority, agent, exec.name, exec.arguments,
      )) {
        return {
          kind: 'deny' as const,
          reason: 'Author staging is permanently inaccessible after its durable Host seal.',
        }
      }
    }
    if ((exec.name === 'write' || exec.name === 'edit') && experimentDescendant) {
      const filePath = filePathArgument(exec.arguments)
      if (filePath !== undefined) {
        if (await baselineArtifact(agent, filePath) !== undefined) {
          return {
            kind: 'deny' as const,
            reason: 'Baseline authority artifacts are Host-controlled and cannot be written or edited by KerSor descendants.',
          }
        }
        const artifact = await dispatchArtifact(agent, filePath)
        if (artifact !== undefined) {
          if (exec.name !== 'write'
            || !['dispatch-args.json', 'dispatch-args-provenance.json'].includes(artifact.name)) {
            return {
              kind: 'deny' as const,
              reason: 'Dispatch semantic outputs are write-once producer artifacts; edits and receipt writes are Host-forbidden.',
            }
          }
          const controllerId = agent.session.header.parentSession
          const state = [...workflowHostGate.producerCalls.values()].find(candidate =>
            candidate.controller.id === controllerId && candidate.runDir === artifact.runDir)
          if (state === undefined) {
            return {
              kind: 'deny' as const,
              reason: 'Only the active foreground dispatch-arg-synthesizer child may write dispatch semantic outputs.',
            }
          }
          if (state.producerSessionId !== undefined && state.producerSessionId !== agent.id) {
            return {
              kind: 'deny' as const,
              reason: 'A different child already owns this foreground dispatch producer call.',
            }
          }
          if (state.successfulWrites.has(artifact.name)) {
            return {
              kind: 'deny' as const,
              reason: `The dispatch producer may write ${artifact.name} exactly once.`,
            }
          }
          state.producerSessionId = agent.id
          workflowHostGate.producerChildren.set(agent.id, state)
        }
      }
      if (filePath !== undefined && await isExistingRunOutput(agent, filePath)) {
        return {
          kind: 'deny' as const,
          reason: 'Existing KerSor run-N/output.json is immutable. Successful Workflow output is Host-owned; after a Workflow error, create a failure stub only while output.json is absent.',
        }
      }
    }
    return next()
  })
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.agent !== undefined && exec.name === 'write'
      && decision.kind === 'accept' && !result.isError) {
      const state = workflowHostGate.producerChildren.get(exec.agent.id)
      const filePath = filePathArgument(exec.arguments)
      if (state !== undefined && filePath !== undefined) {
        const artifact = await dispatchArtifact(exec.agent, filePath)
        if (artifact !== undefined && artifact.runDir === state.runDir) {
          state.successfulWrites.add(artifact.name)
        }
      }
    }
    const authorSealState = workflowHostGate.authorSealCalls.get(exec)
    if (authorSealState !== undefined) {
      try {
        if (decision.kind !== 'accept' || result.isError) return decision
        await finishAuthorHandoffSeal(ctx, authorSealState)
        return decision
      } catch (error: unknown) {
        return {
          kind: 'block' as const,
          feedback: [{
            type: 'text' as const,
            text: `Author handoff custody failed: ${error instanceof Error ? error.message : String(error)}. This exact-once seal attempt is consumed; do not inspect, edit, or re-seal author staging.`,
          }],
        }
      } finally {
        workflowHostGate.authorSealCalls.delete(exec)
      }
    }
    const producerState = workflowHostGate.producerCalls.get(exec.callId)
    if (producerState !== undefined) {
      try {
        if (decision.kind !== 'accept' || result.isError) return decision
        const transformationContext = await finishDispatchProducer(
          ctx, producerState, result.value,
        )
        return {
          ...decision,
          additionalContexts: [
            ...decision.additionalContexts ?? [],
            transformationContext,
          ],
        }
      } catch (error: unknown) {
        return {
          kind: 'block' as const,
          feedback: [{
            type: 'text' as const,
            text: `Dispatch producer custody failed: ${error instanceof Error ? error.message : String(error)}. This exact-once producer call is consumed; do not write or repair its artifacts manually.`,
          }],
        }
      } finally {
        workflowHostGate.producerCalls.delete(exec.callId)
        if (producerState.producerSessionId !== undefined) {
          workflowHostGate.producerChildren.delete(producerState.producerSessionId)
        }
      }
    }
    const setupState = workflowHostGate.setupCalls.get(exec)
    if (setupState !== undefined) {
      try {
        if (decision.kind !== 'accept' || result.isError) return decision
        await finishSessionSetup(ctx, setupState)
        return decision
      } catch (error: unknown) {
        return {
          kind: 'block' as const,
          feedback: [{
            type: 'text' as const,
            text: `Session initialization custody failed: ${error instanceof Error ? error.message : String(error)}. This exact-once setup attempt is consumed; do not create or repair Session authority artifacts manually.`,
          }],
        }
      } finally {
        workflowHostGate.setupCalls.delete(exec)
      }
    }
    const transformationState = workflowHostGate.transformationCalls.get(exec.callId)
    if (transformationState !== undefined) {
      try {
        if (decision.kind !== 'accept' || result.isError) return decision
        await finishDispatchTransformation(ctx, transformationState)
        return decision
      } catch (error: unknown) {
        return {
          kind: 'block' as const,
          feedback: [{
            type: 'text' as const,
            text: `Dispatch runtime-control custody failed: ${error instanceof Error ? error.message : String(error)}. Do not mutate or re-seal the dispatch package manually.`,
          }],
        }
      } finally {
        workflowHostGate.transformationCalls.delete(exec.callId)
      }
    }
    const candidateSealState = workflowHostGate.candidateSealCalls.get(exec.callId)
    if (candidateSealState !== undefined) {
      try {
        if (decision.kind !== 'accept' || result.isError) return decision
        await finishCandidateOwnershipSeal(ctx, candidateSealState)
        return decision
      } catch (error: unknown) {
        return {
          kind: 'block' as const,
          feedback: [{
            type: 'text' as const,
            text: `Candidate ownership seal custody failed: ${error instanceof Error ? error.message : String(error)}. This exact-once seal call is consumed; do not create or repair the seal manually.`,
          }],
        }
      } finally {
        workflowHostGate.candidateSealCalls.delete(exec.callId)
      }
    }
    const baselineState = workflowHostGate.baselineCalls.get(exec.callId)
    if (baselineState !== undefined) {
      try {
        if (decision.kind !== 'accept' || result.isError) return decision
        await finishBaselineWitness(ctx, baselineState)
        return decision
      } catch (error: unknown) {
        return {
          kind: 'block' as const,
          feedback: [{
            type: 'text' as const,
            text: `Baseline Host custody failed: ${error instanceof Error ? error.message : String(error)}. This exact-once baseline phase is consumed; do not create or repair its authority artifacts manually.`,
          }],
        }
      } finally {
        workflowHostGate.baselineCalls.delete(exec.callId)
      }
    }
    if (decision.kind !== 'accept' || result.isError || exec.agent === undefined) return decision
    if (exec.name !== 'kersor_status') return decision
    const owned = controllerBinding(ctx, exec.agent)
    if (owned === undefined) return decision
    if (owned.binding.closure !== undefined) return { ...decision, concludesTurn: true as const }
    const projected = statusProjection(result.meta)
    if (projected === undefined) return decision
    await checkpoint(
      ctx,
      owned.parent,
      owned.binding.start,
      projected.status,
      projected.nextAction,
      projected.projection,
    )
    return terminalProjection(projected.status)
      ? { ...decision, concludesTurn: true as const }
      : decision
  })
  ctx.on('subagent/end', (info) => {
    for (const session of ctx.sessions.list()) {
      const binding = experimentBindings(session.events)
        .find(candidate => candidate.start.childSessionId === info.id)
      if (binding === undefined || binding.closure !== undefined) continue
      reportAsync(ctx, checkpoint(
        ctx,
        session,
        binding.start,
        'waiting',
        info.stopReason === 'completed'
          ? 'The dsh child is idle; resume this experiment to continue from the persisted KerSor Session.'
          : `The dsh child ended with ${info.stopReason}; inspect the persisted KerSor Session before resuming.`,
      ))
    }
  })
}
