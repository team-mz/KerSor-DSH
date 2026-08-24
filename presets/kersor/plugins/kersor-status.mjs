/** Read-only KerSor status tool with a replay-safe DSH presentation card. */

import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'


export const name = 'kersor-status'
export const inject = ['tools']

const execFileAsync = promisify(execFile)
const BRIDGE = fileURLToPath(new URL('../bin/kersor_bridge.py', import.meta.url))

function kersorPython() {
  return process.env.KERSOR_PYTHON?.trim() || 'python3'
}

const nullable = schema => ({ oneOf: [schema, { type: 'null' }] })

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    found: { type: 'boolean' },
    project_path: { type: 'string' },
    session_dir: nullable({ type: 'string' }),
    storage_kind: nullable({ type: 'string' }),
    phase: nullable({ type: 'string' }),
    session_phase: nullable({ type: 'string' }),
    autonomous_run_id: nullable({ type: 'string' }),
    autonomous_status: nullable({ type: 'string' }),
    current_round: nullable({ type: 'integer' }),
    max_workflows: nullable({ type: 'integer' }),
    target_speedup: nullable({ type: 'number' }),
    target_met: nullable({ type: 'boolean' }),
    mode: nullable({ type: 'string' }),
    backend: nullable({ type: 'string' }),
    kernel_language: nullable({ type: 'string' }),
    integration_pattern: nullable({ type: 'string' }),
    allow_workflow_authoring: nullable({ type: 'boolean' }),
    workflow_authoring_budget: nullable({ type: 'integer' }),
    kernel_path: nullable({ type: 'string' }),
    started_at: nullable({ type: 'string' }),
    workflow: nullable({ type: 'string' }),
    fit_confidence: nullable({ type: 'string' }),
    baseline_witness: nullable({ type: 'string' }),
    baseline_next_action: nullable({ type: 'string' }),
    baseline_reason: nullable({ type: 'string' }),
    profile_evidence: nullable({ type: 'string' }),
    profile_reason: nullable({ type: 'string' }),
    profile_owner: nullable({ type: 'string' }),
    dsh_compatibility: nullable({ type: 'string' }),
    candidate_ownership: nullable({ type: 'string' }),
    fresh_session: nullable({ type: 'string' }),
    best_speedup: nullable({ type: 'number' }),
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          status: { type: 'string' },
        },
        required: ['id', 'status'],
      },
    },
    rounds: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          round: { type: 'integer' },
          workflow: nullable({ type: 'string' }),
          speedup: nullable({ type: 'number' }),
          decision: nullable({ type: 'string' }),
        },
        required: ['round', 'workflow', 'speedup', 'decision'],
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'found', 'project_path', 'session_dir', 'storage_kind', 'phase',
    'session_phase', 'autonomous_run_id', 'autonomous_status',
    'current_round', 'max_workflows', 'target_speedup', 'target_met', 'mode',
    'backend', 'kernel_language', 'integration_pattern',
    'allow_workflow_authoring', 'workflow_authoring_budget',
    'kernel_path', 'started_at', 'workflow',
    'fit_confidence', 'baseline_witness', 'baseline_next_action', 'baseline_reason',
    'profile_evidence', 'profile_reason', 'profile_owner',
    'dsh_compatibility', 'candidate_ownership',
    'fresh_session',
    'best_speedup', 'steps', 'rounds', 'warnings',
  ],
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function display(value, suffix = '') {
  return value === null || value === undefined || value === '' ? '—' : `${value}${suffix}`
}

function progress(current, maximum) {
  if (!Number.isInteger(current) || !Number.isInteger(maximum) || maximum < 1) return null
  const ratio = Math.max(0, Math.min(1, current / maximum))
  const filled = Math.round(ratio * 10)
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${Math.round(ratio * 100)}%`
}

function decisionKind(decision) {
  if (typeof decision !== 'string') return '—'
  return decision.split(':', 1)[0]
}

function authoring(value) {
  if (value.allow_workflow_authoring !== true) return 'disabled'
  return Number.isInteger(value.workflow_authoring_budget)
    ? `enabled · budget ${value.workflow_authoring_budget}`
    : 'enabled'
}

function gate(value) {
  if (value === 'pass') return 'pass'
  if (value === 'fail') return 'fail'
  if (value === 'pending') return 'pending'
  return 'not required'
}

export function renderStatus(value) {
  if (!value.found) {
    const warnings = value.warnings.length > 0
      ? `\n\nWarnings:\n${value.warnings.map(item => `- ${item}`).join('\n')}`
      : ''
    return `No KerSor session found under \`${value.project_path}\`.${warnings}`
  }

  const lines = [`**KerSor** · ${display(value.phase)} · round ${display(value.current_round)}/${display(value.max_workflows)}`]
  if (value.autonomous_status !== null) {
    lines.push(
      `Autonomous run: ${value.autonomous_status} · ${display(value.autonomous_run_id)}`,
      `Canonical Session phase: ${display(value.session_phase)}`,
    )
  }
  const bar = progress(value.current_round, value.max_workflows)
  if (bar !== null) lines.push(`\`${bar}\``)
  lines.push(
    '',
    '| Current workflow | Best | Target | Fit | Mode / Backend |',
    '| --- | ---: | ---: | --- | --- |',
    `| ${display(value.workflow)} | ${display(value.best_speedup, 'x')} | ${display(value.target_speedup, 'x')} | ${display(value.fit_confidence)} | ${display(value.mode)} / ${display(value.backend)} |`,
    '',
    '| Language / Backend | Integration pattern | Workflow authoring |',
    '| --- | --- | --- |',
    `| ${display(value.kernel_language)} / ${display(value.backend)} | ${display(value.integration_pattern)} | ${authoring(value)} |`,
    '',
    '| Fresh isolation | Baseline witness | Profile evidence | DSH compatibility | Candidate ownership |',
    '| --- | --- | --- | --- | --- |',
    `| ${gate(value.fresh_session)} | ${gate(value.baseline_witness)} | ${gate(value.profile_evidence)} | ${gate(value.dsh_compatibility)} | ${gate(value.candidate_ownership)} |`,
  )
  if (value.baseline_next_action !== null) {
    lines.push('', `Baseline next action: ${value.baseline_next_action}`)
  }
  if (value.baseline_reason !== null) {
    lines.push(`Baseline blocker: ${value.baseline_reason}`)
  }
  if (value.profile_reason !== null) {
    lines.push(`Profile blocker: ${value.profile_reason}`)
  }
  if (value.profile_owner !== null) {
    lines.push(`Profile owner: ${value.profile_owner}`)
  }

  const recent = value.rounds.slice(-5)
  if (recent.length > 0) {
    lines.push(
      '',
      'Recent measured rounds:',
      '',
      '| Round | Workflow | Speedup | Decision |',
      '| ---: | --- | ---: | --- |',
      ...recent.map(row => `| ${row.round} | ${display(row.workflow)} | ${display(row.speedup, 'x')} | ${decisionKind(row.decision)} |`),
    )
  }
  if (value.warnings.length > 0) {
    lines.push('', 'Warnings:', ...value.warnings.map(item => `- ${item}`))
  }
  lines.push('', `Session: \`${value.session_dir}\``)
  return lines.join('\n')
}

export function statusTitle(meta) {
  if (!isRecord(meta) || meta.found !== true) return 'KerSor · No session'
  const round = Number.isInteger(meta.current_round) && Number.isInteger(meta.max_workflows)
    ? ` · r${meta.current_round}/${meta.max_workflows}`
    : ''
  const best = typeof meta.best_speedup === 'number' ? ` · ${meta.best_speedup}x` : ''
  return `KerSor · ${display(meta.phase)}${round}${best}`
}

async function workspaceTarget(exec) {
  const workspace = exec.agent?.session.header.cwd
  if (typeof workspace !== 'string' || workspace.length === 0) {
    throw new Error('kersor_status requires a DSH session workspace')
  }
  return realpath(workspace)
}

export function createTool() {
  return {
    name: 'kersor_status',
    description: 'Read the current KerSor session phase, routing contract, fresh-isolation/baseline/profile/DSH/candidate-ownership gates, workflow-authoring gate, progress, measured speedups, target, fit, and recent round decisions. Always reads the current DSH workspace; call with an empty argument object.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: STATUS_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
      presentationMeta: (_args, value) => ({
        kind: 'kersor-status',
        found: value.found,
        phase: value.phase,
        session_phase: value.session_phase,
        autonomous_run_id: value.autonomous_run_id,
        autonomous_status: value.autonomous_status,
        current_round: value.current_round,
        max_workflows: value.max_workflows,
        best_speedup: value.best_speedup,
        target_speedup: value.target_speedup,
        target_met: value.target_met,
        workflow: value.workflow,
        integration_pattern: value.integration_pattern,
        allow_workflow_authoring: value.allow_workflow_authoring,
        workflow_authoring_budget: value.workflow_authoring_budget,
        baseline_witness: value.baseline_witness,
        baseline_next_action: value.baseline_next_action,
        baseline_reason: value.baseline_reason,
        profile_evidence: value.profile_evidence,
        profile_reason: value.profile_reason,
        profile_owner: value.profile_owner,
        dsh_compatibility: value.dsh_compatibility,
        candidate_ownership: value.candidate_ownership,
        fresh_session: value.fresh_session,
        session_dir: value.session_dir,
        started_at: value.started_at,
        steps: value.steps,
      }),
    },
    async execute(_args, exec) {
      const target = await workspaceTarget(exec)
      const { stdout } = await execFileAsync(
        kersorPython(),
        [BRIDGE, 'status', '--path', target],
        { encoding: 'utf8', maxBuffer: 1024 * 1024, signal: exec.signal },
      )
      const value = JSON.parse(stdout)
      if (!isRecord(value)) throw new Error('KerSor status bridge returned a non-object')
      return value
    },
    presentCall(_args) {
      return {
        card: 'generic',
        title: 'Read KerSor status',
        kind: 'read',
      }
    },
    presentResult(_args, result) {
      if (result.isError) return { card: 'generic', title: 'KerSor status failed' }
      return {
        card: 'generic',
        title: statusTitle(result.meta),
        content: result.content,
      }
    },
  }
}

export function apply(ctx) {
  ctx.tools.register(createTool())
}
