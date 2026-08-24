/** Pre-commit validation of durable KerSor experiment bindings. */

import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { CallId } from '@deepseek-ai/dsh-llm'
import {
  canonicalAuthorHandoffSealCommand,
  canonicalAuthorSaveCommand,
} from '../src/author-tool-commands.ts'
import { canonicalKersorJson } from '../src/types.ts'
import type {
  KersorAuthorHandoffSealedEventData,
  KersorAuthorSaveAttemptedEventData,
  KersorDispatchArgsProducedEventData,
  KersorDispatchArgsTransformedEventData,
  KersorExperimentId,
  KersorLaunchContract,
  KersorSessionAuthorityImportedEventData,
  KersorSessionAuthorityTransferredEventData,
  KersorSessionInitializedEventData,
} from '../src/types.ts'
import * as invariant from '../src/invariant.ts'

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
  correctness_command: 'python3 verify.py',
  benchmark_command: 'python3 benchmark.py',
} satisfies KersorLaunchContract

async function setup(): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(invariant)
  return { ctx, session: ctx.sessions.create(SessionId('parent')) }
}

async function setupBaseline(
  withSessionAuthority = true,
): Promise<{ ctx: Context; session: Session }> {
  const { ctx, session: parent } = await setup()
  parent.append('kersor/experiment-start', {
    experimentId: 'baseline-experiment' as KersorExperimentId,
    childSessionId: SessionId('controller'),
    origin: 'created',
    objective: 'Optimize',
    freshSession: true,
    launch: launchContract,
    turn: 1,
    step: 1,
  })
  const session = ctx.sessions.create(SessionId('controller'), {
    meta: { cwd: '/work/kernel', parentSession: parent.id, origin: 'subagent' },
  })
  if (withSessionAuthority) appendSessionInitialized(session)
  return { ctx, session }
}

function start(session: Session, experiment = 'experiment', child = 'child'): void {
  session.append('kersor/experiment-start', {
    experimentId: experiment as KersorExperimentId,
    childSessionId: SessionId(child),
    origin: 'created',
    objective: 'Optimize',
    freshSession: true,
    launch: launchContract,
    turn: 1,
    step: 1,
  })
}

function checkpoint(
  session: Session,
  revision: number,
  status: 'running' | 'waiting' | 'blocked' | 'completed' | 'cancelled' = 'running',
  child = 'child',
): void {
  session.append('kersor/experiment-checkpoint', {
    experimentId: 'experiment' as KersorExperimentId,
    childSessionId: SessionId(child),
    revision,
    status,
    steps: [],
  })
}

function rawStart(session: Session, launch: unknown): void {
  session.append('kersor/experiment-start', {
    experimentId: 'experiment' as KersorExperimentId,
    childSessionId: SessionId('child'),
    origin: 'created',
    objective: 'Optimize',
    freshSession: true,
    launch,
    turn: 1,
    step: 1,
  } as never)
}

const dispatchRun = '/work/kernel/.kersor/session/run-1'
const dispatchProducer = {
  schema_version: 1,
  contract: 'dsh_dispatch_args_producer_v1',
  authority: 'dsh_host',
  session_dir: '/work/kernel/.kersor/session',
  run_dir: dispatchRun,
  round: 1,
  workflow_name: 'prepared-workflow',
  controller_session_id: 'controller',
  producer_session_id: 'producer',
  producer_call_id: 'producer-call',
  dispatch_args: {
    path: `${dispatchRun}/dispatch-args.json`,
    sha256: 'a'.repeat(64),
  },
  dispatch_args_provenance: {
    path: `${dispatchRun}/dispatch-args-provenance.json`,
    sha256: 'b'.repeat(64),
  },
} satisfies KersorDispatchArgsProducedEventData

const dispatchTransformation = {
  schema_version: 1,
  contract: 'dsh_dispatch_args_transformation_v1',
  authority: 'dsh_host',
  transformer: 'inject-runtime-controls',
  session_dir: dispatchProducer.session_dir,
  run_dir: dispatchProducer.run_dir,
  round: dispatchProducer.round,
  workflow_name: dispatchProducer.workflow_name,
  controller_session_id: dispatchProducer.controller_session_id,
  transformation_call_id: 'transform-call',
  producer_receipt: {
    path: `${dispatchRun}/dispatch-args-producer-receipt.json`,
    sha256: 'c'.repeat(64),
  },
  input: {
    dispatch_args: dispatchProducer.dispatch_args,
    dispatch_args_provenance: dispatchProducer.dispatch_args_provenance,
  },
  output: {
    dispatch_args: dispatchProducer.dispatch_args,
    dispatch_args_provenance: dispatchProducer.dispatch_args_provenance,
  },
  changed: false,
  authorized_fields: { dispatch_args: [], dispatch_args_provenance: [] },
} satisfies KersorDispatchArgsTransformedEventData

const candidateOwnershipSeal = {
  schema_version: 1,
  contract: 'dsh_candidate_ownership_seal_v1',
  authority: 'dsh_host',
  session_dir: dispatchProducer.session_dir,
  run_dir: dispatchProducer.run_dir,
  round: dispatchProducer.round,
  controller_session_id: dispatchProducer.controller_session_id,
  seal_call_id: 'candidate-seal-call',
  seal: {
    path: `${dispatchRun}/candidate-ownership-seal.json`,
    sha256: 'd'.repeat(64),
  },
  state: {
    path: `${dispatchProducer.session_dir}/state.json`,
    sha256: 'e'.repeat(64),
  },
} as const

const baselineSession = '/work/kernel/.kersor/session'
const sessionInitialized = {
  schema_version: 1,
  contract: 'dsh_session_initialization_v1',
  authority: 'dsh_host',
  experiment_id: 'baseline-experiment' as KersorExperimentId,
  workspace: '/work/kernel',
  session_dir: baselineSession,
  controller_session_id: SessionId('controller'),
  setup_call_id: 'setup-call',
  setup_command: 'canonical setup-session.sh command',
  kersor_python: { path: '/opt/python3.12', sha256: '0'.repeat(64) },
  launch: launchContract,
  session_config: {
    path: `${baselineSession}/session-config.json`, sha256: '1'.repeat(64),
  },
  state: { path: `${baselineSession}/state.json`, sha256: '2'.repeat(64) },
  workflow_catalog: {
    path: `${baselineSession}/workflow-catalog.json`, sha256: '3'.repeat(64),
  },
  adapter: { path: '/opt/KerSor/scripts/setup-session.sh', sha256: '4'.repeat(64) },
  kernel: { path: '/work/kernel/kernel.py', sha256: '5'.repeat(64) },
} satisfies KersorSessionInitializedEventData

const authorStaging = `${baselineSession}/workflow-authoring/staging`
const authorSealCommand = canonicalAuthorHandoffSealCommand(
  sessionInitialized.kersor_python.path,
  baselineSession,
)
const authorSaveCommand = canonicalAuthorSaveCommand(
  sessionInitialized.kersor_python.path,
  baselineSession,
)
const authorFiles = {
  'workflow.js': { path: `${authorStaging}/workflow.js`, sha256: '6'.repeat(64) },
  'metadata.json': { path: `${authorStaging}/metadata.json`, sha256: '7'.repeat(64) },
  'rationale.md': { path: `${authorStaging}/rationale.md`, sha256: '8'.repeat(64) },
} as const
const authorSeal = {
  schema_version: 1,
  contract: 'dsh_author_handoff_seal_v1',
  authority: 'dsh_host',
  session_dir: baselineSession,
  controller_session_id: 'controller',
  seal_call_id: 'author-seal-call',
  seal_command: authorSealCommand,
  staging_dir: authorStaging,
  handoff: {
    path: `${baselineSession}/workflow-authoring/author-handoff.json`,
    sha256: '9'.repeat(64),
  },
  files: authorFiles,
} satisfies KersorAuthorHandoffSealedEventData
const authorSaveAttempt = {
  schema_version: 1,
  contract: 'dsh_author_save_attempt_v1',
  authority: 'dsh_host',
  session_dir: baselineSession,
  controller_session_id: 'controller',
  save_call_id: 'author-save-call',
  save_command: authorSaveCommand,
  seal_call_id: authorSeal.seal_call_id,
  staging_dir: authorStaging,
  handoff: authorSeal.handoff,
  files: authorFiles,
} satisfies KersorAuthorSaveAttemptedEventData

function appendAuthorBashCall(
  session: Session,
  callId: string,
  command: string,
  argumentsOverride: Record<string, unknown> = {},
): void {
  session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: CallId(callId),
    name: 'bash',
    arguments: JSON.stringify({ command, ...argumentsOverride }),
  })
}

function appendSetupCall(
  session: Session,
  callId = sessionInitialized.setup_call_id,
  argumentsOverride: Record<string, unknown> = {},
): void {
  session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: CallId(callId),
    name: 'bash',
    arguments: JSON.stringify({
      command: sessionInitialized.setup_command,
      ...argumentsOverride,
    }),
  })
}

function appendSessionInitialized(session: Session): void {
  appendSetupCall(session)
  session.append('kersor/session-initialized', sessionInitialized)
}

const baselineCommon = {
  schema_version: 1,
  authority: 'dsh_host',
  workspace: '/work/kernel',
  session_dir: baselineSession,
  controller_session_id: 'controller',
  launch: launchContract,
  session_config: {
    path: `${baselineSession}/session-config.json`,
    sha256: '1'.repeat(64),
  },
  task_dir: '/work/kernel',
  kernel: { path: '/work/kernel/kernel.py', sha256: '2'.repeat(64) },
  test_method: {
    path: `${baselineSession}/test-method.md`,
    sha256: '3'.repeat(64),
  },
  commands: { correctness: 'python3 verify.py', benchmark: 'python3 benchmark.py' },
} as const
const baselineInitialized = {
  ...baselineCommon,
  contract: 'dsh_baseline_initialized_v1',
  call_id: 'baseline-init-call',
} as const
const baselineInitializationReceipt = {
  path: `${baselineSession}/baseline-initialization-receipt.json`,
  sha256: '9'.repeat(64),
} as const
const baselineExecutions = [
  {
    kind: 'correctness', command: baselineCommon.commands.correctness,
    exit_code: 0, timed_out: false,
    stdout_sha256: '4'.repeat(64), stderr_sha256: '5'.repeat(64),
  },
  {
    kind: 'benchmark', command: baselineCommon.commands.benchmark,
    exit_code: 1, timed_out: false,
    stdout_sha256: '6'.repeat(64), stderr_sha256: '7'.repeat(64),
  },
] as const
const baselineRecorded = {
  ...baselineCommon,
  contract: 'dsh_baseline_recorded_v1',
  call_id: 'baseline-record-call',
  initialization_receipt: baselineInitializationReceipt,
  witness: {
    path: `${baselineSession}/baseline-witness.json`,
    sha256: '8'.repeat(64),
  },
  executions: baselineExecutions,
} as const
const baselineRecordingReceipt = {
  path: `${baselineSession}/baseline-recording-receipt.json`,
  sha256: 'a'.repeat(64),
} as const
const baselineVerified = {
  ...baselineCommon,
  contract: 'dsh_baseline_verified_v1',
  call_id: 'baseline-verify-call',
  recording_receipt: baselineRecordingReceipt,
  witness: baselineRecorded.witness,
  executions: baselineExecutions,
  protected_files: { 'kernel.py': '2'.repeat(64) },
  worktree: {
    git_root: '/work/kernel',
    tracked_diff_sha256: '4'.repeat(64),
    staged_diff_sha256: '5'.repeat(64),
    untracked: {},
  },
  verdict: 'pass',
} as const

function appendVerifiedBaseline(session: Session): void {
  session.append('kersor/baseline-initialized', baselineInitialized)
  session.append('kersor/baseline-recorded', baselineRecorded)
  session.append('kersor/baseline-verified', baselineVerified)
}

async function setupAuthorityImport(options: {
  readonly transfer?: Partial<KersorSessionAuthorityTransferredEventData>
} = {}): Promise<{
  ctx: Context
  sourceParent: Session
  source: Session
  targetParent: Session
  target: Session
  transferred: KersorSessionAuthorityTransferredEventData
  imported: KersorSessionAuthorityImportedEventData
}> {
  const { ctx, session: sourceParent } = await setup()
  const experimentId = 'import-experiment' as KersorExperimentId
  const sourceControllerId = SessionId('import-source-controller')
  sourceParent.append('kersor/experiment-start', {
    experimentId,
    childSessionId: sourceControllerId,
    origin: 'created',
    objective: 'Create durable authority',
    freshSession: false,
    launch: launchContract,
    turn: 1,
    step: 1,
  })
  const source = ctx.sessions.create(sourceControllerId, {
    meta: { cwd: '/work/kernel', parentSession: sourceParent.id, origin: 'subagent' },
  })
  const sourceInitialization = {
    ...sessionInitialized,
    experiment_id: experimentId,
    controller_session_id: source.id,
  } satisfies KersorSessionInitializedEventData
  appendSetupCall(source, sourceInitialization.setup_call_id)
  source.append('kersor/session-initialized', sourceInitialization)

  const targetParent = ctx.sessions.create(SessionId('import-target-parent'), {
    meta: { cwd: '/work/kernel' },
  })
  const attachCallId = 'attach-call'
  const attachObjective = 'Import durable authority'
  targetParent.append('tool/call', {
    turn: 1,
    step: 1,
    callId: CallId(attachCallId),
    name: 'kersor_attach',
    arguments: JSON.stringify({
      experiment_id: experimentId,
      launch: launchContract,
      objective: attachObjective,
    }),
  })
  const targetControllerId = SessionId('import-target-controller')
  const preTransferEventWatermark = options.transfer?.pre_transfer_event_watermark
    ?? source.events.at(-1)!.seq
  const preTransferPrefix = source.events.filter(event =>
    event.seq <= preTransferEventWatermark)
  const sourceSetupReceipt = {
    path: `${baselineSession}/session-initialization-receipt.json`,
    sha256: '6'.repeat(64),
  } as const
  const sourceState = sourceInitialization.state
  const sourceWorkflowCatalog = sourceInitialization.workflow_catalog
  const transferred = {
    schema_version: 1,
    contract: 'dsh_session_authority_transfer_v1',
    authority: 'dsh_host',
    experiment_id: experimentId,
    workspace: '/work/kernel',
    session_dir: baselineSession,
    source_parent_session_id: sourceParent.id,
    source_controller_session_id: source.id,
    target_parent_session_id: targetParent.id,
    target_controller_session_id: targetControllerId,
    attach_call_id: attachCallId,
    launch: launchContract,
    pre_transfer_event_watermark: preTransferEventWatermark,
    pre_transfer_event_sha256: options.transfer?.pre_transfer_event_sha256
      ?? createHash('sha256')
        .update(canonicalKersorJson(preTransferPrefix), 'utf8')
        .digest('hex'),
    source_setup_receipt: sourceSetupReceipt,
    source_state: sourceState,
    source_workflow_catalog: sourceWorkflowCatalog,
    ...options.transfer,
  } satisfies KersorSessionAuthorityTransferredEventData
  const authorityIntent = {
    attach_call_id: transferred.attach_call_id,
    workspace: transferred.workspace,
    session_dir: transferred.session_dir,
    source_parent_session_id: transferred.source_parent_session_id,
    source_controller_session_id: transferred.source_controller_session_id,
    pre_transfer_event_watermark: transferred.pre_transfer_event_watermark,
    pre_transfer_event_sha256: transferred.pre_transfer_event_sha256,
    source_setup_receipt: transferred.source_setup_receipt,
    source_state: transferred.source_state,
    source_workflow_catalog: transferred.source_workflow_catalog,
  }
  targetParent.append('kersor/experiment-start', {
    experimentId,
    childSessionId: targetControllerId,
    origin: 'attached',
    originSessionId: sourceParent.id,
    objective: attachObjective,
    freshSession: false,
    launch: launchContract,
    authorityIntent,
    turn: 1,
    step: 1,
  })
  source.append('kersor/session-authority-transferred', transferred)
  const target = ctx.sessions.create(targetControllerId, {
    meta: { cwd: '/work/kernel', parentSession: targetParent.id, origin: 'subagent' },
  })
  const sourceEventWatermark = source.events.at(-1)!.seq
  const sourcePrefix = source.events.filter(event => event.seq <= sourceEventWatermark)
  const imported = {
    schema_version: 1,
    contract: 'dsh_session_authority_import_v1',
    authority: 'dsh_host',
    experiment_id: experimentId,
    workspace: '/work/kernel',
    session_dir: baselineSession,
    controller_session_id: target.id,
    attached_parent_session_id: targetParent.id,
    attach_call_id: attachCallId,
    launch: launchContract,
    source_parent_session_id: sourceParent.id,
    source_controller_session_id: source.id,
    source_event_watermark: sourceEventWatermark,
    source_event_sha256: createHash('sha256')
      .update(canonicalKersorJson(sourcePrefix), 'utf8')
      .digest('hex'),
    source_setup_receipt: sourceSetupReceipt,
    source_transfer_receipt: {
      path: `${baselineSession}/session-authority-transfer-receipt.json`,
      sha256: '7'.repeat(64),
    },
    source_state: sourceState,
    source_workflow_catalog: sourceWorkflowCatalog,
  } satisfies KersorSessionAuthorityImportedEventData
  return { ctx, sourceParent, source, targetParent, target, transferred, imported }
}

describe('KerSor experiment invariants', () => {
  it.each(['created', 'attached'] as const)(
    'rejects a %s start without its durable typed launch authority',
    async (origin) => {
      const { session } = await setup()
      expect(() => {
        session.append('kersor/experiment-start', {
          experimentId: `${origin}-without-launch` as KersorExperimentId,
          childSessionId: SessionId(`${origin}-child`),
          origin,
          objective: 'Optimize',
          freshSession: false,
          ...(origin === 'attached' ? { originSessionId: SessionId('origin-parent') } : {}),
          turn: 1,
          step: 1,
        } as never)
      }).toThrow(/typed launch|launch.*required|missing required property "launch"/i)
      expect(session.events).toHaveLength(0)
    },
  )

  it('accepts and preserves a complete typed launch contract', async () => {
    const { session } = await setup()
    rawStart(session, launchContract)
    const event = session.events.find(candidate => candidate.type === 'kersor/experiment-start')
    expect(event?.data.launch).toEqual(launchContract)
  })

  it('strictly rejects incomplete, unknown, malformed, and out-of-range launch fields', async () => {
    const missing = { ...launchContract } as Record<string, unknown>
    delete missing.backend
    const cases: [unknown, RegExp][] = [
      [missing, /launch\.backend is required/],
      [{ ...launchContract, runtime: 'dsh' }, /unknown field "runtime"/],
      [{ ...launchContract, backend: '' }, /backend must be one of/],
      [{ ...launchContract, target_speedup: 0 }, /target_speedup must be a positive finite number/],
      [{ ...launchContract, max_workflows: 1.5 }, /max_workflows must be a safe integer/],
      [{ ...launchContract, workflow_authoring_budget: -1 }, /workflow_authoring_budget must be a safe integer/],
      [{ ...launchContract, mode: 'fast' }, /mode must be one of auto, guided, explore/],
      [{ ...launchContract, correctness_command: 'verify\nagain' }, /correctness_command must be a single-line string/],
    ]
    for (const [launch, expected] of cases) {
      const { session } = await setup()
      expect(() => { rawStart(session, launch) }).toThrow(expected)
      expect(session.events).toHaveLength(0)
    }
  })

  it('accepts a monotonic binding through terminal completion', async () => {
    const { session } = await setup()
    start(session)
    checkpoint(session, 1)
    checkpoint(session, 2, 'waiting')
    checkpoint(session, 3, 'running')
    checkpoint(session, 4, 'completed')
    expect(session.events.filter(event => event.type.startsWith('kersor/'))).toHaveLength(5)
  })

  it('rejects duplicate starts, child changes, revision gaps, and terminal reopening before commit', async () => {
    const { session } = await setup()
    start(session)
    expect(() => { start(session) }).toThrow(/repeats experiment/)
    const before = session.seq
    expect(() => { checkpoint(session, 1, 'running', 'other') }).toThrow(/changes child/)
    expect(() => { checkpoint(session, 2) }).toThrow(/does not follow 0/)
    expect(session.seq).toBe(before)
    checkpoint(session, 1, 'completed')
    expect(() => { checkpoint(session, 2, 'running') }).toThrow(/follows terminal status/)
  })

  it('does not poison the committed revision after a rejected candidate', async () => {
    const { session } = await setup()
    start(session)
    expect(() => { checkpoint(session, 2) }).toThrow(/does not follow 0/)
    expect(() => { checkpoint(session, 1) }).not.toThrow()
  })

  it('treats blocked as terminal before a later checkpoint can commit', async () => {
    const { session } = await setup()
    start(session)
    checkpoint(session, 1, 'blocked')
    expect(() => { checkpoint(session, 2, 'running') }).toThrow(/follows terminal status/)
  })

  it('rejects attached bindings that claim fresh-session creation', async () => {
    const { session } = await setup()
    expect(() => {
      session.append('kersor/experiment-start', {
        experimentId: 'attached' as KersorExperimentId,
        childSessionId: SessionId('attached-child'),
        origin: 'attached',
        objective: 'Continue',
        freshSession: true,
        launch: launchContract,
        turn: 1,
        step: 1,
      })
    }).toThrow(/attached origin cannot require a fresh Session/)
  })
})

describe('KerSor Session authority invariants', () => {
  it('accepts one created Session initialization after its canonical setup call', async () => {
    const { session } = await setupBaseline()
    expect(session.events.filter(event => event.type === 'kersor/session-initialized'))
      .toHaveLength(1)
  })

  it('accepts the Host-normalizable setup envelope with an unpaired authored escalation', async () => {
    const { session } = await setupBaseline(false)
    appendSetupCall(session, sessionInitialized.setup_call_id, {
      sandbox_permissions: 'workspace-write',
    })
    expect(() => {
      session.append('kersor/session-initialized', sessionInitialized)
    }).not.toThrow()
  })

  it.each(['.', sessionInitialized.workspace])(
    'accepts allowed setup workdir %s',
    async (workdir) => {
      const { session } = await setupBaseline(false)
      appendSetupCall(session, sessionInitialized.setup_call_id, { workdir })
      expect(() => {
        session.append('kersor/session-initialized', sessionInitialized)
      }).not.toThrow()
    },
  )

  it.each([
    { run_in_background: true },
    { sandbox_permissions: 'unrestricted' },
    { sandbox_permissions: 7 },
    { justification: 7 },
    { workdir: '/tmp' },
    { workdir: '../outside' },
    { workdir: '/work/kernel/link/..' },
  ])('rejects a Session initialization bound to a non-normalizable setup envelope %j', async (args) => {
    const { session } = await setupBaseline(false)
    appendSetupCall(session, sessionInitialized.setup_call_id, args)
    expect(() => {
      session.append('kersor/session-initialized', sessionInitialized)
    }).toThrow(/setup_call_id|setup.*call|Host.*setup/i)
  })

  it('rejects Session initialization without its preceding exact setup call', async () => {
    const { session } = await setupBaseline(false)
    expect(() => {
      session.append('kersor/session-initialized', sessionInitialized)
    }).toThrow(/setup.*call|canonical.*setup|precedes/i)
    expect(session.events.some(event => event.type === 'kersor/session-initialized'))
      .toBe(false)
  })

  it('rejects duplicate, redirected, and shape-invalid Session initialization', async () => {
    const duplicate = await setupBaseline()
    expect(() => {
      duplicate.session.append('kersor/session-initialized', sessionInitialized)
    }).toThrow(/repeats.*authority|duplicate/i)

    for (const forged of [
      { ...sessionInitialized, authority: 'controller' },
      { ...sessionInitialized, workspace: '/tmp/other' },
      { ...sessionInitialized, launch: { ...launchContract, max_workflows: 99 } },
      {
        ...sessionInitialized,
        session_config: { ...sessionInitialized.session_config, path: '/tmp/config.json' },
      },
      {
        ...sessionInitialized,
        adapter: { ...sessionInitialized.adapter, path: '/opt/KerSor/scripts/other.sh' },
      },
      { ...sessionInitialized, unexpected: true },
    ]) {
      const { session } = await setupBaseline(false)
      appendSetupCall(session)
      expect(() => {
        session.append('kersor/session-initialized', forged as never)
      }).toThrow(/Host schema|dsh_host|workspace|launch|canonical|adapter/i)
    }
  })

  it('rejects baseline custody before created Session initialization', async () => {
    const { session } = await setupBaseline(false)
    expect(() => {
      session.append('kersor/baseline-initialized', baselineInitialized)
    }).toThrow(/session-initialized|Session authority/i)
  })

  it('accepts one attached-controller authority import from a complete created prefix', async () => {
    const { source, target, transferred, imported } = await setupAuthorityImport()
    target.append('kersor/session-authority-imported', imported)
    expect(source.events.filter(event =>
      event.type === 'kersor/session-authority-transferred')).toHaveLength(1)
    expect(imported.source_event_watermark).toBe(source.events.at(-1)!.seq)
    expect(imported.source_transfer_receipt.path).toBe(
      `${baselineSession}/session-authority-transfer-receipt.json`,
    )
    expect(imported.source_state).toEqual(transferred.source_state)
    expect(imported.source_workflow_catalog).toEqual(transferred.source_workflow_catalog)
    expect(target.events.filter(event => event.type === 'kersor/session-authority-imported'))
      .toHaveLength(1)
  })

  it('rejects a transfer snapshot whose prefix stops before Session initialization', async () => {
    await expect(setupAuthorityImport({
      transfer: {
        pre_transfer_event_watermark: 0,
      },
    })).rejects.toThrow(/transfer|watermark|prefix|session-initialized|setup/i)
  })

  it('rejects an import watermark before its unique source transfer event', async () => {
    const fixture = await setupAuthorityImport()
    const watermark = fixture.transferred.pre_transfer_event_watermark
    const prefix = fixture.source.events.filter(event => event.seq <= watermark)
    expect(() => fixture.target.append('kersor/session-authority-imported', {
      ...fixture.imported,
      source_event_watermark: watermark,
      source_event_sha256: createHash('sha256')
        .update(canonicalKersorJson(prefix), 'utf8')
        .digest('hex'),
    })).toThrow(/transfer|watermark|prefix/i)
  })

  it('rejects source baseline authority appended after its transfer lease', async () => {
    const fixture = await setupAuthorityImport()
    expect(() => fixture.source.append('kersor/baseline-initialized', {
      ...baselineInitialized,
      controller_session_id: fixture.source.id,
    })).toThrow(/transferred|transfer.*lease|source.*retired/i)
  })

  it('binds import to the exact preceding parent attach call arguments and order', async () => {
    const wrongCall = await setupAuthorityImport()
    expect(() => wrongCall.target.append('kersor/session-authority-imported', {
      ...wrongCall.imported,
      attach_call_id: 'forged-attach-call',
    })).toThrow(/attach.*call|preceding parent|durable parent intent/i)

    const wrongLaunch = await setupAuthorityImport()
    expect(() => wrongLaunch.target.append('kersor/session-authority-imported', {
      ...wrongLaunch.imported,
      launch: { ...launchContract, target_speedup: 99 },
    })).toThrow(/launch|attach.*arguments|authority/i)
  })

  it('rejects duplicate and forged attached-controller authority imports', async () => {
    const duplicate = await setupAuthorityImport()
    duplicate.target.append('kersor/session-authority-imported', duplicate.imported)
    expect(() => {
      duplicate.target.append('kersor/session-authority-imported', duplicate.imported)
    }).toThrow(/repeats.*authority|duplicate/i)

    for (const forged of [
      { source_event_watermark: 999 },
      { source_event_sha256: 'f'.repeat(64) },
      { source_controller_session_id: SessionId('missing-source-controller') },
      { source_parent_session_id: SessionId('forged-source-parent') },
      { launch: { ...launchContract, max_workflows: 99 } },
      { workspace: '/tmp/other' },
    ]) {
      const fixture = await setupAuthorityImport()
      expect(() => {
        fixture.target.append('kersor/session-authority-imported', {
          ...fixture.imported,
          ...forged,
        })
      }).toThrow(/source|watermark|hash|lineage|launch|workspace|authority/i)
    }
  })

  it('rejects attached baseline custody before authority import', async () => {
    const { target } = await setupAuthorityImport()
    expect(() => {
      target.append('kersor/baseline-initialized', {
        ...baselineInitialized,
        controller_session_id: target.id,
      })
    }).toThrow(/session-authority-imported|Session authority/i)
  })
})

describe('KerSor authored Workflow custody invariants', () => {
  it('accepts one exact author seal followed by one pre-execution save attempt', async () => {
    const { session } = await setupBaseline()
    appendAuthorBashCall(session, authorSeal.seal_call_id, authorSealCommand)
    session.append('kersor/author-handoff-sealed', authorSeal)
    appendAuthorBashCall(session, authorSaveAttempt.save_call_id, authorSaveCommand)
    session.append('kersor/author-save-attempted', authorSaveAttempt)

    expect(session.events.filter(event => event.type.startsWith('kersor/author-')))
      .toHaveLength(2)
  })

  it('rejects author seals without their exact preceding canonical Bash call', async () => {
    const missing = await setupBaseline()
    expect(() => {
      missing.session.append('kersor/author-handoff-sealed', authorSeal)
    }).toThrow(/author.*seal|preceding.*bash|canonical.*command/i)

    const forged = await setupBaseline()
    appendAuthorBashCall(forged.session, authorSeal.seal_call_id, authorSealCommand)
    expect(() => {
      forged.session.append('kersor/author-handoff-sealed', {
        ...authorSeal,
        seal_command: `${authorSealCommand} --force`,
      })
    }).toThrow(/author.*seal|canonical.*command|Host schema/i)

    const secondCall = await setupBaseline()
    appendAuthorBashCall(secondCall.session, 'earlier-seal-call', authorSealCommand)
    appendAuthorBashCall(secondCall.session, authorSeal.seal_call_id, authorSealCommand)
    expect(() => {
      secondCall.session.append('kersor/author-handoff-sealed', authorSeal)
    }).toThrow(/first and only|canonical.*Bash|author.*seal/i)

    for (const args of [
      {
        command: authorSealCommand.replace(
          'seal-author-handoff.py', "seal-author-''handoff.py",
        ),
        override: {},
      },
      { command: authorSealCommand, override: { workdir: '/tmp' } },
    ]) {
      const noncanonical = await setupBaseline()
      appendAuthorBashCall(
        noncanonical.session,
        authorSeal.seal_call_id,
        args.command,
        args.override,
      )
      expect(() => {
        noncanonical.session.append('kersor/author-handoff-sealed', authorSeal)
      }).toThrow(/first and only|canonical.*Bash|author.*seal/i)
    }
  })

  it('rejects save attempts before a seal, repeated attempts, and changed sealed bytes', async () => {
    const beforeSeal = await setupBaseline()
    appendAuthorBashCall(
      beforeSeal.session, authorSaveAttempt.save_call_id, authorSaveCommand,
    )
    expect(() => {
      beforeSeal.session.append('kersor/author-save-attempted', authorSaveAttempt)
    }).toThrow(/author.*seal|save.*seal/i)

    const duplicate = await setupBaseline()
    appendAuthorBashCall(duplicate.session, authorSeal.seal_call_id, authorSealCommand)
    duplicate.session.append('kersor/author-handoff-sealed', authorSeal)
    appendAuthorBashCall(
      duplicate.session, authorSaveAttempt.save_call_id, authorSaveCommand,
    )
    duplicate.session.append('kersor/author-save-attempted', authorSaveAttempt)
    expect(() => {
      duplicate.session.append('kersor/author-save-attempted', authorSaveAttempt)
    }).toThrow(/author.*save.*repeat|exact-once|consum/i)

    const changed = await setupBaseline()
    appendAuthorBashCall(changed.session, authorSeal.seal_call_id, authorSealCommand)
    changed.session.append('kersor/author-handoff-sealed', authorSeal)
    appendAuthorBashCall(changed.session, authorSaveAttempt.save_call_id, authorSaveCommand)
    expect(() => {
      changed.session.append('kersor/author-save-attempted', {
        ...authorSaveAttempt,
        files: {
          ...authorFiles,
          'workflow.js': { ...authorFiles['workflow.js'], sha256: 'f'.repeat(64) },
        },
      })
    }).toThrow(/sealed.*bytes|author.*seal|files/i)
  })
})

describe('KerSor dispatch custody invariants', () => {
  it('accepts exactly one producer followed by one durable no-op transformation', async () => {
    const { session } = await setupBaseline()
    appendVerifiedBaseline(session)
    session.append('kersor/dispatch-args-produced', dispatchProducer)
    session.append('kersor/dispatch-args-transformed', dispatchTransformation)
    expect(session.events.filter(event => event.type.startsWith('kersor/dispatch-args-')))
      .toHaveLength(2)
  })

  it('rejects transformation without producer and duplicate producer before commit', async () => {
    const missing = await setupBaseline()
    appendVerifiedBaseline(missing.session)
    expect(() => {
      missing.session.append('kersor/dispatch-args-transformed', dispatchTransformation)
    }).toThrow(/has no producer/)
    expect(missing.session.events.filter(event => event.type.startsWith('kersor/dispatch-args-')))
      .toHaveLength(0)

    const duplicate = await setupBaseline()
    appendVerifiedBaseline(duplicate.session)
    duplicate.session.append('kersor/dispatch-args-produced', dispatchProducer)
    expect(() => {
      duplicate.session.append('kersor/dispatch-args-produced', dispatchProducer)
    }).toThrow(/repeats run/)
  })

  it('rejects self-consistent unauthorized transformation fields', async () => {
    const { session } = await setupBaseline()
    appendVerifiedBaseline(session)
    session.append('kersor/dispatch-args-produced', dispatchProducer)
    const forged = structuredClone(dispatchTransformation) as unknown as {
      changed: boolean
      output: { dispatch_args: { path: string; sha256: string } }
      authorized_fields: { dispatch_args: string[] }
    }
    forged.changed = true
    forged.output.dispatch_args = {
      ...forged.output.dispatch_args,
      sha256: 'd'.repeat(64),
    }
    forged.authorized_fields.dispatch_args = ['kernel_path']
    expect(() => {
      session.append('kersor/dispatch-args-transformed', forged as never)
    }).toThrow(/deterministic allowlist subset/)
  })

  it('accepts one candidate ownership seal after its dispatch transformation', async () => {
    const { session } = await setupBaseline()
    appendVerifiedBaseline(session)
    session.append('kersor/dispatch-args-produced', dispatchProducer)
    session.append('kersor/dispatch-args-transformed', dispatchTransformation)
    session.append('kersor/candidate-ownership-sealed', candidateOwnershipSeal)
    expect(session.events.filter(event => event.type === 'kersor/candidate-ownership-sealed'))
      .toHaveLength(1)
  })

  it('rejects candidate ownership seal events without transformed custody or out of order', async () => {
    const missing = await setupBaseline()
    appendVerifiedBaseline(missing.session)
    expect(() => {
      missing.session.append('kersor/candidate-ownership-sealed', candidateOwnershipSeal)
    }).toThrow(/has no (?:producer|dispatch transformation)/)

    const producerOnly = await setupBaseline()
    appendVerifiedBaseline(producerOnly.session)
    producerOnly.session.append('kersor/dispatch-args-produced', dispatchProducer)
    expect(() => {
      producerOnly.session.append(
        'kersor/candidate-ownership-sealed', candidateOwnershipSeal,
      )
    }).toThrow(/(?:precedes|has no dispatch) transformation/)
  })

  it('rejects duplicate and non-canonical candidate ownership seal events', async () => {
    const duplicate = await setupBaseline()
    appendVerifiedBaseline(duplicate.session)
    duplicate.session.append('kersor/dispatch-args-produced', dispatchProducer)
    duplicate.session.append('kersor/dispatch-args-transformed', dispatchTransformation)
    duplicate.session.append('kersor/candidate-ownership-sealed', candidateOwnershipSeal)
    expect(() => {
      duplicate.session.append(
        'kersor/candidate-ownership-sealed', candidateOwnershipSeal,
      )
    }).toThrow(/repeats run/)

    const malformed = await setupBaseline()
    appendVerifiedBaseline(malformed.session)
    malformed.session.append('kersor/dispatch-args-produced', dispatchProducer)
    malformed.session.append('kersor/dispatch-args-transformed', dispatchTransformation)
    expect(() => {
      malformed.session.append('kersor/candidate-ownership-sealed', {
        ...candidateOwnershipSeal,
        authority: 'controller',
        unexpected: true,
      } as never)
    }).toThrow(/Host schema|dsh_host/)
  })

  it('rejects dispatch production before the owning Session has a verified baseline', async () => {
    const missing = await setupBaseline()
    expect(() => {
      missing.session.append('kersor/dispatch-args-produced', dispatchProducer)
    }).toThrow(/verified baseline|baseline.*verified/i)

    const recordedOnly = await setupBaseline()
    recordedOnly.session.append('kersor/baseline-initialized', baselineInitialized)
    recordedOnly.session.append('kersor/baseline-recorded', baselineRecorded)
    expect(() => {
      recordedOnly.session.append('kersor/dispatch-args-produced', dispatchProducer)
    }).toThrow(/verified baseline|baseline.*verified/i)
  })
})

describe('KerSor baseline custody invariants', () => {
  it('accepts exactly one initialized, recorded, and verified Host sequence', async () => {
    const { session } = await setupBaseline()
    session.append('kersor/baseline-initialized', baselineInitialized)
    session.append('kersor/baseline-recorded', baselineRecorded)
    session.append('kersor/baseline-verified', baselineVerified)
    expect(session.events.filter(event => event.type.startsWith('kersor/baseline-')))
      .toHaveLength(3)
  })

  it('rejects baseline record/verify events without their exact predecessor', async () => {
    const missingInit = await setupBaseline()
    expect(() => {
      missingInit.session.append('kersor/baseline-recorded', baselineRecorded)
    }).toThrow(/has no initialization/)

    const missingRecord = await setupBaseline()
    missingRecord.session.append('kersor/baseline-initialized', baselineInitialized)
    expect(() => {
      missingRecord.session.append('kersor/baseline-verified', baselineVerified)
    }).toThrow(/has no recording/)
  })

  it('rejects duplicate baseline phases before commit', async () => {
    const initialized = await setupBaseline()
    initialized.session.append('kersor/baseline-initialized', baselineInitialized)
    expect(() => {
      initialized.session.append('kersor/baseline-initialized', baselineInitialized)
    }).toThrow(/repeats Session/)

    const recorded = await setupBaseline()
    recorded.session.append('kersor/baseline-initialized', baselineInitialized)
    recorded.session.append('kersor/baseline-recorded', baselineRecorded)
    expect(() => {
      recorded.session.append('kersor/baseline-recorded', baselineRecorded)
    }).toThrow(/repeats Session/)
  })

  it('rejects baseline schema, authority, and owner redirection', async () => {
    for (const forged of [
      { ...baselineInitialized, authority: 'controller' },
      { ...baselineInitialized, workspace: '/tmp/other' },
      { ...baselineInitialized, task_dir: '/tmp/other' },
      {
        ...baselineInitialized,
        kernel: { ...baselineInitialized.kernel, path: '/tmp/other/kernel.py' },
      },
      {
        ...baselineInitialized,
        launch: { ...baselineInitialized.launch, max_workflows: 99 },
      },
      { ...baselineInitialized, unexpected: true },
    ]) {
      const { session } = await setupBaseline()
      expect(() => {
        session.append('kersor/baseline-initialized', forged as never)
      }).toThrow(/Host schema|dsh_host|workspace|task_dir|kernel|launch/)
    }
  })

  it('rejects execution command, exit, timeout, and hash forgery', async () => {
    for (const executions of [
      [{ ...baselineExecutions[0], command: 'true' }, baselineExecutions[1]],
      [{ ...baselineExecutions[0], exit_code: 1 }, baselineExecutions[1]],
      [baselineExecutions[0], { ...baselineExecutions[1], timed_out: true }],
      [{ ...baselineExecutions[0], stdout_sha256: 'not-a-hash' }, baselineExecutions[1]],
    ]) {
      const { session } = await setupBaseline()
      session.append('kersor/baseline-initialized', baselineInitialized)
      expect(() => {
        session.append('kersor/baseline-recorded', {
          ...baselineRecorded,
          executions,
        })
      }).toThrow(/execution|command|exit|timed out|SHA-256/)
    }
  })
})
