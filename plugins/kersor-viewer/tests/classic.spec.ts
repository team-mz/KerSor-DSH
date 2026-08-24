import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installedBridge, readClassicSessionDetail, readClassicSessions } from '../src/classic.ts'

const dirs: string[] = []
const originalDshHome = process.env.DSH_HOME
const originalKersorPython = process.env.KERSOR_PYTHON

async function tempDshHome(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kersor-classic-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
  if (originalKersorPython === undefined) delete process.env.KERSOR_PYTHON
  else process.env.KERSOR_PYTHON = originalKersorPython
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('classic Session bridge diagnostics', () => {
  it('distinguishes a bridge that is not installed from an empty inventory', async () => {
    process.env.DSH_HOME = await tempDshHome()
    expect(await readClassicSessions(20)).toEqual({
      sessions: [], source: { state: 'not_installed' },
    })
  })

  it('projects warning counts without forwarding warning content', async () => {
    process.env.DSH_HOME = await tempDshHome()
    process.env.KERSOR_PYTHON = 'python3'
    const bridge = installedBridge()
    await mkdir(path.dirname(bridge), { recursive: true })
    await writeFile(bridge, `
import json
print(json.dumps({"sessions": [{
  "session_id": "s1", "session_dir": "/sessions/s1", "storage_kind": "v2",
  "lifecycle": "active", "status": "in-progress", "health": "active",
  "kernel_language": "python_reference", "backend": "python",
  "integration_pattern": "custom_simulator",
  "allow_workflow_authoring": True, "workflow_authoring_budget": 3,
  "workflow_authoring_used": 1,
  "workflow": "vliw-schedule", "fit_confidence": "high",
  "profile_evidence": "pass", "profile_owner": "kernel-profiler · child-s1",
  "decision": "CONTINUE: measure the candidate",
  "stop_reason": "execution_budget_exhausted",
  "cycle_lineage": {
    "session_baseline_cycles": 14415, "best_cycles": 13358,
    "session_speedup": 1.0791286120676749,
    "task_baseline_cycles": 147734, "overall_speedup": 11.05958975894595,
    "extra": "SECRET-LINEAGE"
  },
  "warnings": ["SECRET-SESSION-WARNING"], "extra": "SECRET-EXTRA-FIELD"
}], "warnings": ["SECRET-BRIDGE-WARNING"]}))
`)

    const snapshot = await readClassicSessions(1)
    expect(snapshot).toMatchObject({
      sessions: [{
        session_id: 's1',
        kernel_language: 'python_reference',
        backend: 'python',
        integration_pattern: 'custom_simulator',
        allow_workflow_authoring: true,
        workflow_authoring_budget: 3,
        workflow_authoring_used: 1,
        workflow: 'vliw-schedule',
        fit_confidence: 'high',
        profile_evidence: 'pass',
        profile_owner: 'kernel-profiler · child-s1',
        decision: 'CONTINUE: measure the candidate',
        stop_reason: 'execution_budget_exhausted',
        cycle_lineage: {
          session_baseline_cycles: 14415,
          best_cycles: 13358,
          session_speedup: 1.0791286120676749,
          task_baseline_cycles: 147734,
          overall_speedup: 11.05958975894595,
        },
        warningCount: 1,
      }],
      source: { state: 'degraded', lastIssue: { stage: 'classic_bridge', code: 'io_error' } },
    })
    expect(JSON.stringify(snapshot)).not.toContain('SECRET')
  })

  it('classifies malformed bridge output without forwarding stdout', async () => {
    process.env.DSH_HOME = await tempDshHome()
    process.env.KERSOR_PYTHON = 'python3'
    const bridge = installedBridge()
    await mkdir(path.dirname(bridge), { recursive: true })
    await writeFile(bridge, 'print("{SECRET-MALFORMED")\n')

    const snapshot = await readClassicSessions(1)
    expect(snapshot.source).toMatchObject({
      state: 'failed', lastIssue: { stage: 'classic_bridge', code: 'invalid_json' },
    })
    expect(JSON.stringify(snapshot)).not.toContain('SECRET')
  })

  it('contains invalid task-routing fields at the classic source boundary', async () => {
    process.env.DSH_HOME = await tempDshHome()
    process.env.KERSOR_PYTHON = 'python3'
    const bridge = installedBridge()
    await mkdir(path.dirname(bridge), { recursive: true })
    await writeFile(bridge, `
import json
print(json.dumps({"sessions": [{
  "session_id": "s1", "session_dir": "/sessions/s1", "storage_kind": "v2",
  "lifecycle": "active", "status": "in-progress", "health": "active",
  "decision": {"raw": "SECRET-DECISION"}, "warnings": []
}]}))
`)

    const snapshot = await readClassicSessions(1)
    expect(snapshot.sessions).toEqual([])
    expect(snapshot.source.state).toBe('failed')
    expect(snapshot.source.lastIssue).toMatchObject({
      stage: 'classic_bridge', code: 'invalid_payload',
    })
    expect(JSON.stringify(snapshot)).not.toContain('SECRET')
  })

  it('reads a sealed bounded Session inspector projection on demand', async () => {
    process.env.DSH_HOME = await tempDshHome()
    process.env.KERSOR_PYTHON = 'python3'
    const bridge = installedBridge()
    await mkdir(path.dirname(bridge), { recursive: true })
    await writeFile(bridge, `
import json
print(json.dumps({
  "session_id": "s1", "session_dir": "/sessions/s1", "current_round": 1,
  "steps": [{"id": "authoring", "status": "completed"}],
  "selection": {"status": "stalled", "reason": "no fit", "rejectedCount": 4},
  "authoring": {
    "status": "sealed",
    "files": [{"name": "workflow.js", "sha256": "sha256:abc", "bytes": 42}],
    "design": {
      "name": "vliw-author", "technique": "instruction_scheduling",
      "methodCategory": "vliw_optimization", "topology": "pipeline",
      "requiredArgs": ["kernel_path"], "languages": ["python_reference"],
      "backends": ["python"], "integrationPatterns": ["custom_simulator"],
      "rationale": "sealed rationale", "source": "export const meta = {}"
    }
  },
  "validation": {"status": "pending", "checks": []},
  "dispatch": {"status": "pending"},
  "rounds": [
    {
      "number": 1, "workflow": "vliw-author", "workflow_origin": "catalog",
      "candidate_id": "vliw-r1", "host_verdict": "pass",
      "estimate": {"cycles": 13415, "speedup": 1.0745, "extra": "SECRET-ESTIMATE"},
      "measurement": {
        "baseline_cycles": 14415, "candidate_cycles": 13358,
        "candidate_speedup": 1.0791286120676749, "incumbent_cycles": 13358,
        "incumbent_speedup": 1.0791286120676749, "best_improved": True,
        "overall_speedup": 11.05958975894595, "extra": "SECRET-MEASUREMENT"
      },
      "decision": "CONTINUE: target not met", "extra": "SECRET-ROUND"
    },
    {
      "number": 2, "workflow": "vliw-author", "workflow_origin": "authored",
      "candidate_id": "vliw-r2", "host_verdict": "fail", "failure_kind": "correctness",
      "estimate": {"cycles": 13392, "speedup": 1.0763}
    }
  ],
  "workflow": {
    "name": "vliw-author", "description": "Pack VLIW slots", "whenToUse": "custom simulator",
    "technique": "instruction_scheduling", "methodCategory": "vliw_optimization",
    "topology": "pipeline", "phases": [{"title": "Analyze", "detail": "Inspect bundles"}],
    "requiredArgs": ["kernel_path"], "languages": ["python_reference"],
    "backends": ["python"], "integrationPatterns": ["custom_simulator"],
    "rationale": "verified dispatch rationale", "source": "const result = {}"
  }
}))
`)

    const detail = await readClassicSessionDetail('/sessions/s1')
    expect(detail).toMatchObject({
      session_id: 's1',
      selection: { status: 'stalled', rejectedCount: 4 },
      authoring: {
        status: 'sealed',
        design: { name: 'vliw-author', rationale: 'sealed rationale' },
      },
      workflow: {
        name: 'vliw-author',
        description: 'Pack VLIW slots',
        phases: [{ title: 'Analyze', detail: 'Inspect bundles' }],
      },
      rounds: [
        {
          number: 1,
          workflow: 'vliw-author',
          workflow_origin: 'catalog',
          candidate_id: 'vliw-r1',
          host_verdict: 'pass',
          estimate: { cycles: 13415, speedup: 1.0745 },
          measurement: {
            baseline_cycles: 14415,
            candidate_cycles: 13358,
            candidate_speedup: 1.0791286120676749,
            incumbent_cycles: 13358,
            incumbent_speedup: 1.0791286120676749,
            best_improved: true,
            overall_speedup: 11.05958975894595,
          },
          decision: 'CONTINUE: target not met',
        },
        {
          number: 2,
          workflow: 'vliw-author',
          workflow_origin: 'authored',
          candidate_id: 'vliw-r2',
          host_verdict: 'fail',
          failure_kind: 'correctness',
          estimate: { cycles: 13392, speedup: 1.0763 },
        },
      ],
    })
    expect(JSON.stringify(detail)).not.toContain('SECRET')
  })

  it('rejects measured values on a failed Host round', async () => {
    process.env.DSH_HOME = await tempDshHome()
    process.env.KERSOR_PYTHON = 'python3'
    const bridge = installedBridge()
    await mkdir(path.dirname(bridge), { recursive: true })
    await writeFile(bridge, `
import json
print(json.dumps({
  "session_id": "s1", "session_dir": "/sessions/s1", "current_round": 1,
  "steps": [],
  "selection": {"status": "selected", "workflow": "unsafe", "rejectedCount": 0},
  "authoring": {"status": "not_started", "files": []},
  "validation": {"status": "pending", "checks": []},
  "dispatch": {"status": "failed"},
  "rounds": [{
    "number": 1, "host_verdict": "fail", "failure_kind": "correctness",
    "measurement": {"candidate_cycles": 1}
  }]
}))
`)

    expect(await readClassicSessionDetail('/sessions/s1')).toBeUndefined()
  })

  it('rejects a Session chronology beyond the Host item bound', async () => {
    process.env.DSH_HOME = await tempDshHome()
    process.env.KERSOR_PYTHON = 'python3'
    const bridge = installedBridge()
    await mkdir(path.dirname(bridge), { recursive: true })
    await writeFile(bridge, `
import json
print(json.dumps({
  "session_id": "s1", "session_dir": "/sessions/s1", "current_round": 101,
  "steps": [],
  "selection": {"status": "pending", "rejectedCount": 0},
  "authoring": {"status": "not_started", "files": []},
  "validation": {"status": "pending", "checks": []},
  "dispatch": {"status": "pending"},
  "rounds": [{"number": number, "host_verdict": "pending"} for number in range(1, 102)]
}))
`)

    expect(await readClassicSessionDetail('/sessions/s1')).toBeUndefined()
  })
})
