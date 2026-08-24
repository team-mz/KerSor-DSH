# Autonomous KerSor Workflows: Start in Chat and Evolve by Round

English | [中文](kersor-autonomous-workflow.zh.md)

This use case shows how to run a bounded KerSor optimization experiment entirely inside a **DSH conversation** and observe each Workflow, candidate, Host verification, incumbent, and stop reason in the Web UI. The results come from two acceptance runs: Fresh27 reduced a VLIW simulator kernel from `147734` to `14415 cycles`; Fresh29 used `14415` as a new Session baseline and exercised on-demand Workflow authoring.

Fresh27 and Fresh29 are acceptance-run labels, not special commands or fixed configurations. Your own Experiment and Session identifiers will appear in the UI.

“Autonomous” has an important boundary: KerSor **generates a new candidate each round**, but it does not invent a new Workflow every round. A Workflow is a reusable strategy and agent topology. KerSor authors, seals, validates, catalogs, and reselects a new Workflow only when the current Workflow is exhausted, the Router has no viable alternative, and authoring budget remains.

## 1. What happens in one experiment

```text
DSH Chat
└── KerSor Experiment (bound to one continuable DSH controller child)
    ├── Setup / Baseline witness / Profile
    └── Round N
        ├── Router: filter and select an existing Workflow
        ├── Workflow: read the incumbent and measured prior-round evidence
        ├── Candidate: generate one round-unique candidate
        ├── Host: run correctness first, then benchmark
        ├── Decision: promote, continue, or stop
        └── On routing exhaustion: Author → Seal → Validate → Catalog → Reselect
```

The ownership boundary is:

| Layer | May decide autonomously | May not claim or bypass |
|---|---|---|
| Router / selector | Choose the next compatible Workflow | Backend, language, or integration-pattern compatibility |
| Workflow | Analyze the seed, consume transfer evidence, and generate a candidate | That a static estimate is a measured result |
| Workflow author | Design a Proposal when routing has a gap | Seal, schema, wire, safety, or provenance checks |
| Host reviewer | Run the frozen correctness and benchmark commands | A performance result from an incorrect candidate |
| Session synthesizer | Continue or stop from the target, budget, and measured history | Frozen targets, commands, or budgets |

The canonical optimization path uses a DSH-native controller and DSH Workflow workers. It does not require Claude Code or Codex as an external executor.

## 2. Prepare and start the Web Host

Install the KerSor preset and Web bundle using the repository's [five-minute setup](../../README.md#五分钟上手). The Host Python interpreter must be an absolute path to an executable file:

```bash
export DSH_CHECKOUT=/absolute/path/to/deepseek-harness
export KERSOR_PYTHON=/absolute/path/to/python3
cd "$DSH_CHECKOUT"
pnpm dsh web --port 3179
```

Open <http://127.0.0.1:3179/>. Omit `--port 3179` to use the default port.

The target workspace must already contain two deterministic commands:

- a correctness command that only decides whether the candidate is valid;
- a benchmark command that emits the single headline metric;
- tests, references, problem definitions, and the benchmark harness are immutable oracles.

## 3. Start the Experiment from Chat

Add the target workspace in DSH, create a new task, switch the top preset to **KerSor**, and send a task contract. The following public template mirrors Fresh29; replace the Python placeholder with a real absolute path before sending it:

```text
Start a new KerSor optimization experiment. DSH must own the controller,
Workflow workers, and verification end to end.

Goal: improve the current 14415-cycle VLIW kernel by at least 1.2x while
preserving full correctness.
Baseline: 14415 cycles; this is the incremental baseline for this Session.
Immutable boundaries: do not modify tests/, problem.py, references, simulator
constants, or the benchmark harness.
Stop: reach 1.2x or execute 6 rounds; author at most 3 Workflow Proposals.

Load the kersor skill and call kersor_start with this frozen contract:
- backend=python
- language=python_reference
- integration_pattern=custom_simulator
- target_speedup=1.2
- max_workflows=6
- mode=explore
- workflow_authoring_budget=3
- retrieval_mode=off
- experience_mode=off
- transfer_mode=off
- kernelwiki_experience_export_mode=off
- correctness_command=/absolute/path/to/python3 tests/submission_tests.py CorrectnessTests.test_kernel_correctness
- benchmark_command=/absolute/path/to/python3 tests/submission_tests.py SpeedTests.test_kernel_speedup

After start succeeds, let the controller child proceed independently. The
parent conversation must not poll, rewrite candidates, or take over execution.
```

The user does not need to invoke the shell `compose optimize` path. The top-level agent passes the contract to `kersor_start`; an Experiment card appears in the current conversation immediately, while the complete controller work runs in the bound DSH child.

To start from the official `147734-cycle` starter instead, use `147734` as the baseline and `8.0x` as the target. After a Fresh27-style run completes, use its Host-accepted `14415-cycle` incumbent as the explicit seed for a new fresh Experiment, then apply the Fresh29 contract above.

## 4. What to observe in the Web UI

### Chat

The KerSor Experiment card in the parent conversation is the primary entry point. It should show:

- canonical phase, current round, and total budget;
- current Workflow, Host-measured incumbent, and target;
- the nine protocol stages and next action;
- “Open DSH execution conversation” for the original controller child's complete dialog.

Closing the page or switching tasks does not stop the controller. After a Host restart, request continuation in the original parent conversation; the top-level agent uses `kersor_resume` to continue the same child.

### KerSor view

The **KerSor** tab beside Chat and Trajectory provides a cross-workspace overview. After selecting the current Experiment, its Round tree should preserve causal order:

```text
Fresh29 · STALLED · 6/6 · best 13358 cycles
├── Baseline / Profile
├── R1 · vliw-bundling · PASS · 13358 · promoted
├── R2 · vliw-bundling · PASS · 13903 · retained R1
├── R3 · vliw-bundling · PASS · 13876 · retained R1
├── R4 · vliw-bundling · PASS · 13392 · workflow exhausted
├── R5 · Author level-aware-gather
│   ├── routing gap → seal → validate → catalog → reselect
│   └── candidate correctness FAIL · estimate excluded
├── R6 · level-aware-gather repair · correctness FAIL · estimate excluded
└── Stop · execution budget exhausted · incumbent retained
```

The display semantics are strict:

- **Measured**: produced by the benchmark only after Host correctness passes;
- **Promoted**: a measured candidate that is also faster than the incumbent;
- **Estimated / reported**: a Workflow prediction or unverified output, useful only for diagnosis;
- **Correctness failed**: no benchmark value is accepted and the candidate cannot affect the incumbent;
- **Workflow authored**: includes the triggering routing gap, Proposal seal and validation, and reselection chain.

Selecting an Experiment should synchronize its Round tree and Workflow execution tree to the same Session. The UI must not combine the current Session card with an unrelated historical run dialog.

## 5. Fresh27 and Fresh29 acceptance results

Fresh27 verified the first optimization leg and the Host gate:

| Round | Workflow | Host result | Action |
|---:|---|---|---|
| 1 | `vliw-bundling-kernel-optimization` | correctness FAIL | Performance fields excluded from measured best |
| 2 | `vliw-bundling-kernel-optimization` | PASS, `147734 → 14415` | `10.2486x`, promoted; `8.0x` target met |

Fresh29 verified multiple candidates and the authoring escape:

| Round | Workflow | Host result | Session decision |
|---:|---|---|---|
| 1 | `vliw-bundling-kernel-optimization` | PASS, `13358 cycles`, `1.0791x` | Promote |
| 2 | Same Workflow, new candidate | PASS, `13903`, `1.0368x` | Retain R1 |
| 3 | Same Workflow, new candidate | PASS, `13876`, `1.0388x` | Retain R1 |
| 4 | Same Workflow, new candidate | PASS, `13392`, `1.0764x` | Retain R1; old Workflow exhausted |
| 5 | Authored `level-aware-gather-kernel-optimization` | correctness FAIL | Exclude the `1.076x` estimate |
| 6 | Repair candidate from the same new Workflow | correctness FAIL | Exclude estimate; exhaust 6/6 budget |

Fresh29 ended `STALLED` because the target was unmet and execution budget was exhausted, not because the infrastructure failed. Its valid `13358-cycle` incumbent was retained, and neither incorrect candidate contaminated the best result.

## 6. Interpret both speedup scopes correctly

Fresh27 and Fresh29 have different Session baselines, so the UI must name both scopes:

```text
Fresh29 incremental speedup = 14415 / 13358 = 1.0791x
Overall lineage speedup     = 147734 / 13358 = 11.0596x
```

`1.0791x` answers “what did Fresh29 add?”; `11.0596x` answers “what is the total improvement from the original starter?” Do not compare unnamed speedups across Session cards, and never treat a Workflow's `estimated_speedup` as a measured value in either scope.

## 7. Continue after an interruption or terminal result

- The controller is still active but the page or Host was interrupted: return to the original parent conversation and use `kersor_resume` to continue the same child.
- The Session is `complete`, `stalled`, or `cancelled`: its binding is terminal; do not silently increase budget or repeat a dispatch.
- More exploration is needed: explain the terminal reason, use the verified incumbent as a new seed, freeze a new goal and budget, then start a new Experiment from Chat. The new Session preserves an explicit baseline and lineage without rewriting the old conclusion.

Canonical evidence lives at:

```text
<workspace>/.kersor/<session>/state.json
<workspace>/.kersor/<session>/round-N-summary.md
<workspace>/.kersor/<session>/run-N/host-verification.json
<workspace>/.kersor/<session>/workflow-authoring/proposals/<workflow>/validation.json
```

The Chat card and KerSor view are projections of these artifacts. If the UI conflicts with disk evidence, treat the UI projection as untrusted and fix it rather than rewriting the experiment record.
