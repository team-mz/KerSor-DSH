---
name: kersor
description: Route local task evolution, benchmarked optimization, workflow execution, status, resume, trace, and diagnosis through the installed KerSor checkout
---

# KerSor DSH bridge

This skill is an adapter. The KerSor checkout owns its commands, defaults, workflow policy, and completion rules; do not restate or guess them here.

## Resolve the checkout

Use the bridge installed beside this skill:

```bash
bridge="${DSH_HOME:-$HOME/.dsh}/.agent-presets/kersor/bin/kersor_bridge.py"
kersor_root="$("${KERSOR_PYTHON:-python3}" "$bridge" root)"
```

`KERSOR_ROOT` overrides the checkout recorded by the installer for classic
optimize/status/compose operations. Generic evolve is security-sensitive: before
creating its contract, resolve
`"${KERSOR_PYTHON:-python3}" "$bridge" root --recorded` and use only that checkout
for its trusted runtime config. If resolution fails, stop and report the bridge
diagnostic instead of guessing a path.
`KERSOR_PYTHON` is the Python 3.10+ interpreter used by every bridge call; when
unset, the DSH Host's `python3` is used. The Host has already frozen and exported
`DSH_HOME` and `KERSOR_PYTHON` before this turn. Use the expressions above
directly: do not export, echo, inspect, list, or resolve either value, and never
call `env`, `which`, PATH search, filesystem search, or a version probe to select
another Python. The bridge validates the inherited interpreter itself.

Before changing a KerSor checkout, read `$kersor_root/AGENTS.md`. Before running a workflow, read the relevant current command protocol under `$kersor_root/commands/` and any file it directly names.

## Conversation ownership

In a top-level DSH conversation, do not execute the optimization protocol in
the parent. Start a new experiment with `kersor_start`, bind an existing
workspace Session with `kersor_attach`, and continue a bound experiment with
`kersor_resume`. These controls reserve and flush the Experiment-to-child
binding before a continuable DSH child starts, so the full controller dialog
and Workflow tree remain inspectable after a turn ends. `kersor_resume` always
targets the original child and never creates another dispatch.

Those controls are optimization-only. A `kersor-task-v1`, a
`kersor-mission-v1`, or a general non-benchmark problem must use the generic
evolve route below. Never translate a generic contract into backend, language,
speedup, correctness, or benchmark fields and never call `kersor_start` for it.

`kersor_start` requires the complete typed launch. `kersor_attach` requires the
exact durable origin Experiment id and an exact copy of that origin's typed
launch; it cannot infer authority from a Session directory. Attach persists a
recoverable intent, transfers and freezes the source controller authority, and
imports the bounded source event prefix into one stable attached controller.
If materialization is interrupted, use `kersor_resume` to complete that same
intent idempotently instead of issuing another attach or recreating receipts.

After any successful `kersor_start`, `kersor_attach`, or `kersor_resume` call,
end the parent turn immediately. The parent must not call `kersor_status`,
`list_agents`, subagent, job, Workflow, Bash, Read, or Glob to monitor or take
over the controller; the bound child and durable checkpoints are the only
execution path. A later user request may invoke the appropriate KerSor control
again, subject to its terminal-state guard.

When the current task explicitly identifies you as that KerSor controller
child, continue with the protocol below instead of calling any of those three
parent controls. The runtime is always `dsh`; Claude/Codex tools and fallbacks
are forbidden by the controller boundary.

After `kersor_status` reports `complete`, `single_run`, `stalled`, or
`cancelled`, stop the controller turn immediately. Do not invoke Bash,
subagents, Workflow, authoring, dispatch, or any other tool after that status;
the DSH executor enforces this terminal boundary even when prose reasoning is
wrong.

## Route the request

- For a frozen `kersor-mission-v1`, call `kersor_evolve` with
  `{"contract":"<absolute-contract-path>"}`. When the user supplied that exact
  path, this must be the first and only tool call of the turn: do not invoke
  Bash, pre-read, list, parse, or summarize the contract, Session, runtime
  config, source, or tests. The Host tool owns the foreground process, timeout,
  cancellation, bounded output, install-recorded checkout and Python, contract
  hash, Session admission, and terminal JSON. The recorded checkout must be
  physically outside the workspace, and the Host passes only frozen HOME, TMP,
  PATH, and KerSor routing values; ambient cloud, provider, and SSH tokens are
  never inherited. DSH does not add a competing process-wide elapsed-time
  watchdog around the complete multi-activation Core run; each activation and
  Host evaluator retains its own finite timeout, while cancellation and output
  caps stay active at the outer process. Provider CLIs use their
  install-recorded local login. Resume only on a later user turn
  in a new top-level DSH session with the same absolute `run_dir` and
  `resume:true`; every session may call `kersor_evolve` only once, including a
  failed or cancelled call. After any completed or
  blocked result, report that exact result and stop; never inspect, retry, or
  fall back in the same turn. A Mission is deliberately rejected from the Bash
  bridge route so it cannot inherit the calling agent's nested Seatbelt.
- For a frozen `kersor-task-v1` that must run natively in DSH, call
  `kersor_evolve` with
  `{"contract":"<absolute-contract-path>","runtime":"dsh"}`. The contract may
  be inside the current workspace or be the canonical parent `task.json` whose
  relative `workspace` resolves to the current directory. Make this the first
  and only tool call. The Host freezes the contract and runtime config, starts
  the DSH RPC service, limits writes to the exact verifier artifact set, and
  lets Core own baseline and round verification. For an explicitly requested
  external Codex Task, retain the workspace-confined bridge route:
  `"${KERSOR_PYTHON:-python3}" "$bridge" evolve --contract <contract-path>`.
  Make that foreground invocation the first and only shell action; do not
  pre-read its inputs, add environment assignments, background it, or poll it.
  An explicit Task run directory must be one direct child of
  `workspace/.kersor`. Report the exact terminal JSON/status and stop.
- For a kernel file or task directory, preflight the direct route with `"${KERSOR_PYTHON:-python3}" "$bridge" compose optimize --path <path> --json`.
- For a bundled case, list or match cases first, then use `"${KERSOR_PYTHON:-python3}" "$bridge" compose build --case <id> --json`.
- For environment diagnosis, use `"${KERSOR_PYTHON:-python3}" "$bridge" doctor --runtime dsh`.
- For status, call `kersor_status` first with an empty argument object. It always reads the current DSH workspace; never pass the KerSor checkout or another filesystem path. It reads canonical Session and Attempt Result stores and renders the live round, workflow, best measured speedup, target, fit, and recent decisions.
- For resume, trace, campaign, research, export, or a named workflow, read the matching `$kersor_root/commands/<name>.md` protocol. Use `kersor_status` before resume or diagnosis so the current session—not chat memory—sets the starting point.

For a natural-language general problem without a contract, inspect the current
workspace read-only and choose the smallest profile that can satisfy the
request. Use `kersor-task-v1` for one bounded mutate/verify loop. Use
`kersor-mission-v1` only when the workflow topology must adapt across evidence,
branches, checkpoints, or feedback. Write the frozen contract under the current
workspace (for example `.kersor-contracts/<mission-id>.json`) and then use the
matching Host tool or the explicit external-Codex Task bridge route above;
the user must not prepare Session JSON by hand.

For a Mission, the capability registry may contain only authority already
granted by the user's request. The planner may choose and revise nodes but may
not invent permissions, verifier commands, output names, or Completion facts.
For an external runtime, bind acceptance to an existing workspace-owned
deterministic command through a Host evaluator; declare `side_effect: "read"`, use `command-v1` with
`filesystem_policy: "read-only"`, `network_policy: "denied"`,
`output_policy: "sealed"`, an optional `timeout_seconds` in `(0,120]`, an optional
`max_output_bytes` in `[1,4194304]`, and never use `materialize`. Core may execute a
safe standalone Host evaluator directly. When an agent capability names an evaluator
through `candidate_verifier`, that evaluator additionally must be non-retryable and
its exact Host-owned outputs and full gate must bind the candidate transaction;
several candidate capabilities may share one evaluator. Its fact
projections may read only `passed`, `exit_code`, `timed_out`, or
`artifact_set_sha256`, never raw stdout/stderr or parsed output. This policy is a
real fail-closed Host filesystem boundary for the evaluator and all descendants,
not a prompt-only promise. Do not create a new test oracle merely to make the
Mission pass. Put its new Session below the workspace, such as
`.kersor-autonomous/<mission-id>`. A read-only Mission may omit
`runtime_config`. Every agent capability must explicitly declare
`side_effect` as `none`, `read`, or `write`; every `write` capability must also
declare its exact transaction artifacts. Under `runtime=codex`, a mutating
Mission must bind
`$kersor_root/config/runtime-codex-autonomous-write.json`; a read-only Mission
uses `runtime-codex-autonomous.json`. Under `runtime=claude`, both profiles use
the sole canonical `runtime-claude-autonomous.json`: the broker maps read-only
capabilities to exactly `Read,Glob,Grep` and transaction-backed writes to exactly
`Read,Glob,Grep,Edit,Write`, requires its per-activation OS filesystem sandbox,
and fails preflight if that boundary is unavailable. Declare every intended
transaction artifact and
keep unrelated files and tests immutable. Do not author an arbitrary
workspace-local runtime config. A generic-v1 materializer may copy the matching
trusted KerSor config into the workspace; the bridge accepts that copy only
when it is a regular single-link file with an independent inode and its bytes
exactly match the runtime-specific trusted config, then binds the expected
SHA-256 again at launch. A completed DSH turn is not Mission success: only a
Host-owned `kersor_evolve` status of `completed` plus the matching Core result
may be reported as successful.

The DSH-native route accepts fixed Tasks plus `runtime=dsh` Mission read-only
capabilities and one-file Mission write capabilities. A fixed Task derives its
complete transaction artifact set from `verifier.artifacts`; Core retains its
ordinary baseline, `feedback=status`, round budget, and post-activation Host
verification. Mission planner and read-only activations receive only
`read`/`glob`/`grep`; an Execute worker with a bound transaction additionally
receives `edit`/`write`. A synchronous guard permits those mutation tools only
for the exact declared artifact, so the worker may revise that file repeatedly
without gaining arbitrary workspace write access. It denies aliases, links,
KerSor control trees, the frozen Mission/runtime config/Session, Bash,
subagents, Workflows, recursive KerSor, and paths outside the workspace. A
child also cannot read `.git`, `.conformance`, `.kersor`, or
`.kersor-autonomous`; `glob` and `grep` must name a proper non-control
workspace descendant instead of searching the workspace root. Their scoped
tool descriptions state this before the first call and direct the worker to
read known root files or search a public subdirectory. Transaction activations
also name their exact writable artifacts and state that helper or scratch files
are unavailable, so the worker leaves rejection and retry evidence to the Host.
A candidate verifier must be a non-retryable, sealed, read-only `command-v1` Host
evaluator whose full request, rollback policy, and candidate gate match the
frozen Mission; Core runs it while the snapshot is live and commits only an
accepted candidate. Every activation still uses the owner-only AF_UNIX endpoint
and a fresh DSH `spawn` child pinned to `deepseek-official/kimi-k2.7-code`.
The Host folds durable usage chunks and assistant messages by `(turn, step)`,
with the later sample replacing an earlier sample for that step, and processes
the durable terminal before requiring structured output. Completeness requires
the full child log to have contiguous `seq` values starting at zero, one fresh
`turn=1`, consecutive closed steps starting at 1, and a final `turn/end` event.
A typed `DSH_CHILD_QUOTA` has exactly two proof shapes. A first and only
unmetered step may produce the known pre-usage receipt
(`usage_observed=false`, `usage_complete=true`, all token counts zero). Or, after
one or more completely metered prior steps with positive aggregate usage, one
final unmetered step may preserve that cumulative usage and produce
`usage_observed=true`, `usage_complete=true`. The known pre-usage shape requires
empty in-process result output. The metered-progress shape instead requires that
output to equal the canonical content of the last non-empty `assistant/message`
before the terminal step. Neither shape permits a structured result. Only after
that proof does the Host normalize the typed Core receipt to `output=[]` and
`structured=null`. Both shapes also require canonically identical `finish` and
`turn/end` failures whose raw machine code is exactly `QUOTA` (without whitespace
trimming or case folding) and whose status is exactly HTTP 429. Neither proof shape
admits retry activity anywhere in the lifecycle. The final quota step must close
in `step/start -> finish -> step/end -> turn/end` order and contain no other
assistant output/message/usage or `tool/*`. Inbox,
user-message, title, and request-metadata events between lifecycle boundaries
are permitted. Approximate code/status, duplicate or drifted coordinates,
missing/reordered boundaries, post-terminal events, mismatched failures, any
retry, final-step output/tool/usage, an absent prior canonical assistant message,
result output that differs from its content, or any unmetered prior step remains
a generic `DSH_CHILD_TERMINAL_ERROR` with incomplete usage and preserves the
original result output. In particular, observing usage
in the failing quota step does not prove a pre-generation terminal quota.
General non-quota usage is complete only when every step has an authoritative
token-meter sample. Durable `blocked`, `aborted`, and `interrupted` terminals
map to `refusal`, `aborted`, and `error`; route drift, disconnect, cancellation,
and unsafe transactions also fail closed and dispose the child. Use an external
runtime for Mission mutation contracts that exceed the one-file capability
rule; fixed Tasks may retain their declared multi-file artifact set.

For `runtime=claude`, the bridge removes ambient `CLAUDE*`, `ANTHROPIC*`, and
KerSor routing controls and publishes only the Claude-compatible executable and
optional model id frozen at install time. A wrapper may therefore route this
optional backend to Infini-AI `deepseek-v4-flash`; in that configuration Claude
Code is the agent CLI, not the model provider. `runtime=codex|claude` remains an
external product-stack route; do not describe its results as a pure Harness
comparison with the DSH-native path.

For a direct task, preserve an explicit typed contract as composer flags such as
`--backend python --language python_reference`; do not hide those fields in
`--note`. When the user explicitly authorizes KerSor to create a task-native
Workflow, add `--allow-workflow-authoring` and, when specified, its
`--workflow-authoring-budget`. `--yolo` is not a creation grant. Workflow
evolution remains a Research Runner capability and must follow the current
`commands/research.md` protocol when the user explicitly authorizes it.

The composer emits a `/kersor:<command>` string as validated parameter binding. It is not a shell command. Execute the matching command protocol with the tools available in DSH, preserving its gates, evidence files, confirmation points, budgets, and stop semantics.

When the user asks for a “from scratch”, “fresh”, or “从头开始” evaluation,
the route must include `--fresh-session`. Run it in a fresh worktree. A new
empty `KERSOR_SESSION_ROOT` is valid only when the task workspace itself has no
`.kersor` history. Never inspect, search, or read an older
`.kersor/<session-id>` to obtain a baseline, test method, strategy, candidate,
or measurement. If setup finds prior Session history, stop and create the
physical isolation before continuing. Prompt instructions alone are not an
acceptable freshness boundary.

Session bootstrap has one Host-owned executable boundary. For a created DSH
Experiment, the controller prompt supplies the complete canonical
`setup-session.sh` command derived from its effective typed launch. Execute
that command byte-for-byte exactly once. Do not synthesize a shorter command,
omit/add/reorder flags, substitute paths or Python, change the environment
prefix, or retry after failure. The Host independently checks the new canonical
workspace-local Session config, initial state, workflow Catalog, adapter,
config-selected kernel, and frozen interpreter before exclusively writing
`session-initialization-receipt.json` and its matching durable event. Only
consume `SESSION_DIR` after that boundary succeeds.

An attached controller must not call `setup-session.sh`: it receives authority
only from the Host's durable transfer/import chain. Never call setup from
`commands/`; that directory owns Markdown protocols, not executable scripts.
A missing entrypoint, non-zero setup, absent Host receipt/event, or conflicting
existing receipt is a hard stop, not permission to guess another path or edit
Session JSON.

### Task-native authoring

When the task uses a custom simulator/build system and the user asks KerSor to
create a task-native workflow, preserve that grounded topology in the direct
preflight instead of routing by filename alone:

```bash
"${KERSOR_PYTHON:-python3}" "$bridge" compose optimize --path <task-dir> \
  --integration-pattern custom_simulator \
  --allow-workflow-authoring --workflow-authoring-budget 1 --json
```

Use the exact integration pattern evidenced by the task or explicitly supplied
by the user; do not invent `custom_simulator` for an ordinary standalone task.
Conversely, when the candidate emits/schedules instructions that a repository-
local interpreter or virtual machine executes and the task-native harness
reports simulator cycles, the topology is `custom_simulator`, not `standalone`.
Freeze that fact during setup; a single Python candidate file does not make its
evaluation topology standalone.
After setup and before mutation, verify the frozen Session language/backend and
integration pattern. If every released workflow is incompatible, selection must
remain `STALLED` until Phase 3.6 validates and re-catalogs a Proposal. Do not
bypass KerSor by editing the candidate first, and do not request research-only
workflow evolution through the stable `/kersor:optimize` path.

Never parse `session-config.json` directly to verify the setup contract. Its
immutable storage groups compatibility fields under `extensions`, while the
supported state adapter owns the stable projected names. Read each fact through
that adapter and compare the exact value before baseline initialization:

```bash
bash "$kersor_root/scripts/kersor-state.sh" "$SESSION_DIR" get fresh_session_required
bash "$kersor_root/scripts/kersor-state.sh" "$SESSION_DIR" get baseline_witness_required
bash "$kersor_root/scripts/kersor-state.sh" "$SESSION_DIR" get candidate_ownership_required
bash "$kersor_root/scripts/kersor-state.sh" "$SESSION_DIR" get integration_pattern
bash "$kersor_root/scripts/kersor-state.sh" "$SESSION_DIR" get retrieval_mode
bash "$kersor_root/scripts/kersor-state.sh" "$SESSION_DIR" get experience_mode
bash "$kersor_root/scripts/kersor-state.sh" "$SESSION_DIR" get transfer_mode
bash "$kersor_root/scripts/kersor-state.sh" "$SESSION_DIR" get kernelwiki_experience_export_mode
```

For a fresh task-native authoring run the expected values are respectively
`true`, `true`, `true`, the grounded integration pattern, then `off`, `off`,
`off`, and `off`. Fresh isolation resolves all four modes to `off` before the
durable launch is written; conflicting request prose is not authority. A
mismatch is a hard stop; do not repair raw Session JSON.

Do not accept a prose-only baseline. After Session creation and before
selection or authoring, create the minimal task-native test method through the
deterministic initializer when the exact commands are already known, then
record and verify the baseline through KerSor's Session-owned witness:

Use the three exact Host-frozen DSH commands documented in
`commands/optimize.md`: `baseline-witness.py init`, then `record`, then
`verify`. Each must begin with the controller prompt's literal
`KERSOR_PYTHON='<absolute path>'; export KERSOR_PYTHON;` prefix and use the
canonical bridge/root expression and exact typed command/path arguments. Each
call is exact-once and is followed by an exclusive Host receipt plus matching
durable event; never abbreviate these commands to a direct Python invocation.

`test-method.md` owns the exact correctness and benchmark commands. The
initializer atomically writes both commands and `Baseline Status: present`,
rejects blank/multiline input, and never overwrites an existing owner. Do not
hand-format a minimal `test-method.md` or wrap its command values in Markdown
code spans. The immutable witness binds their post-Session execution to the
Session config and kernel hash. Output produced before Session creation, or a
historical cycle count copied into Markdown, is not execution evidence. A failed
witness is a hard stop; do not select, author, dispatch, or mutate the candidate.

Resolve and version-check `kersor_python` before `init`, and use that exact
executable inside every Python correctness or benchmark command passed to the
initializer. Decide both commands completely before the one allowed `init`.
Each command must invoke an existing task-owned authoritative harness directly;
do not create or reference a new helper/wrapper whose bytes can change outside
the receipt and witness bindings. A non-zero benchmark is admissible only when
it produced non-empty stdout execution evidence; a traceback or stderr-only
failure is a failed record, not a measured baseline.
If initialization, recording, or verification fails, never delete, rename, or
recreate `test-method.md`, the initialization receipt, or
`baseline-witness.json`; transition the Session to `stalled` and create a new
fresh Session after fixing the launch contract.

After the baseline witness passes and before selection, run the canonical
Phase 2 profiler handoff as one Host action:

```text
kersor_protocol({"action":"profile"})
```

The Host builds and reads `profile-handoff/context.json` without a model-visible
line projection, passes its complete dispatch unchanged to exactly one
foreground DSH child, retains that child Session id, and seals plus verifies
`kernel-profile.md` before returning. The controller must not read or copy the
long prompt, call `subagent`, pass a producer id, write/edit the profile, or
split the handoff across several calls.

The seal binds the profiler context, child owner, parseable fields, immutable
Session integration pattern, and profile hash. A missing/invalid seal or any
parent/post-seal edit is a hard stop: record the Profile gate failure, set the
Session to canonical `stalled`, and do not select, author, dispatch, or mutate
the candidate. Call `kersor_protocol({"action":"select_workflow"})` when the
current optimize protocol reaches selection, and never invoke
`select-workflow.sh` directly. This one typed action owns filtering, the
Core-authored selection handoff, any required foreground strategy-selector,
and deterministic finalization. Never call `subagent` for selection, write or
edit `round-N-routing-decision.json`, or invoke `selection-handoff.py` or
`finalize-selection.sh`. A second call in the same round is allowed only after
the Host-owned author save changes the bound workflow Catalog; repeating an
unchanged Catalog is consumed and rejected. Selection and author context both
re-verify the Profile boundary for fresh Sessions; never create or patch their
outputs by hand.

In DSH Workspace Write, Phase 3.6 must keep the Proposal Registry below the
Session: save with `--store "$SESSION_DIR/workflow-authoring/proposals"` and
regenerate the Catalog with the same path in `KERSOR_PROPOSALS_DIR`. Do not fall
back to the checkout-level Proposal store, which is outside the task boundary.

Before dispatch, perform the semantic output-ownership review required by the
current optimize protocol. Structural Proposal gates do not make an in-place
checkpoint write safe: the authored workflow must return candidate code or
evaluate a Session-local copy, while outer optimize alone installs a winner
after correctness and objective proof. On a KILL/needs-revision stop, use
KerSor's state tool to transition the Session to `stalled`, then confirm the
terminal state with `kersor_status`; a Markdown summary is not a state change.
The review must also prove candidate binding: importing a candidate is
insufficient when the invoked harness still resolves the canonical
implementation. Correctness and benchmark evidence must name and execute the
same Session-local candidate. Keep authoring provenance equally strict.
Build the Session's only author context and launch its exact foreground author
with `kersor_protocol({"action":"author"})`. The Host derives the frozen Python,
KerSor root, Session, and output path, reads the complete
`author-context.json.dispatch` without model copying, and returns only after the
child settles. Never invoke the wrapper or `author-workflow-context.py` through
Bash, call `subagent`, copy the prompt, call `list_agents` or a job tool, or
inspect staging progress while it runs. If the typed action fails, transition
to `stalled` and stop.

The first controller action after that result must be
`kersor_author_commit({"action":"seal"})`. The Host derives the canonical
staging and handoff paths, binds the foreground author identity, runs Core's
exclusive seal, and records only the whole receipt path and hash rather than
duplicating Core's internal schema. Do not read staging before this action or
invoke/reconstruct a seal command through Bash.

After the typed seal succeeds, read and semantically review only the three
sealed direct author files. They are permanently immutable; the controller may
reject them but must never repair them. Any extra staging file or directory is
mixed provenance and means `needs_revision` plus canonical `stalled`.

If review passes, call `kersor_author_commit({"action":"save"})` exactly once.
The Host durably consumes the attempt before starting Core's saver and requires
the whole handoff receipt to remain unchanged. A hash, syntax, metadata,
taxonomy, or semantic failure is terminal, not permission to re-seal, retry, or
overwrite a Proposal. Proposal persistence remains Session-local at
`workflow-authoring/proposals`. On success the same typed action rebuilds and
verifies `workflow-catalog.json` from that store. Do not invoke
`generate-catalog.sh`; call `kersor_protocol({"action":"select_workflow"})`
again for the same round.

After KerSor's dispatch-args, harness-binding, and output-ownership gates pass,
convert the sealed Proposal to the one portable DSH wire contract before
calling the Workflow tool:

```bash
node "$kersor_root/scripts/prepare-dsh-workflow.mjs" \
  --script "$PROPOSAL_DIR/workflow.js" \
  --args-file "$RUN_DIR/dispatch-args.json" \
  --out "$RUN_DIR/dsh-workflow.json" \
  --report "$RUN_DIR/dsh-compatibility.json"
```

The adapter machine-restricts every Workflow child to the inherited
`glob`/`grep`/`read` tools. `structured_output` remains child-scoped and
available when a schema is declared. A child must return exact candidate source
inline; inability to write, edit, run shell commands, compile, or benchmark is
the intended advisory-only contract, not a reason to weaken the filter.

After compatibility passes, seal the host-owned candidate boundary exactly
once, before the Workflow call:

Use the exact Host-frozen DSH seal command documented in
`commands/optimize.md`. It must begin with the literal frozen Python prefix,
resolve the checkout through the canonical bridge, and pass the exact absolute
Session and run paths. The call is exact-once; never abbreviate it to a direct
Python invocation or create the seal yourself.

Then run the cooperative budget safe point and commit the durable dispatch
start marker before entering the blocking Workflow call:

```bash
bash "$kersor_root/scripts/check-runtime-budget.sh"
bash "$kersor_root/scripts/mark-dispatch-start.sh" "$RUN_DIR"
```

Do not omit or defer the marker. It is the canonical distinction between a
prepared run and a Workflow Host that has actually started, drives the KerSor
viewer's live dispatch state, and lets resume diagnose a Host process reaped at
a Session boundary. A non-zero safe-point or marker command is a hard stop;
transition the Session to `stalled` and do not call Workflow.

Call `kersor_workflow` exactly once with only
`{"exp_dir":"<exact absolute RUN_DIR>"}`. The Host reads and validates the
generated envelope and invokes the native DSH Workflow with its exact owned
fields. Before any raw result is returned or `output.json` is published, the
Host revalidates the baseline/dispatch/seal chain, current Session state,
protected files, worktree, and dispatch bytes, then exclusively writes
`candidate-ownership.json`. Only an exact `verdict=pass` permits the Host to
atomically commit `output.json` and return success. Never call raw `workflow`,
extract or retype the script, compare envelope hashes in the model, write a
rendered preview, or invoke `candidate-ownership.py verify` manually.

On ownership failure the Host discards the native raw result, publishes no
`output.json`, records the Experiment's stalled checkpoint, and returns a tool
error. Do not collect stray files, attempt re-verification, or invoke the
authored candidate reviewer after that error. Restoring an oracle afterward is
recovery, not a passing result.
For every selected authored Proposal, require returned `output.json` to declare
the canonical pair `arch_stage=awaiting_host_verification` and
`selected_candidate_id`. The bounded compatibility pair
`evaluation_status=pending_host_verification` and `candidate_identity` is also
accepted for an already-sealed older Proposal. Then run the current optimize
protocol's deterministic authored-candidate reviewer before result analysis:

```bash
KERSOR_PYTHON="${KERSOR_PYTHON:-python3}" \
  bash "$kersor_root/scripts/run-kersor-python.sh" review-authored-candidate.py \
  --session "$SESSION_DIR" \
  --run-dir "$RUN_DIR"
```

It owns Session-local materialization and the immutable witness commands. Do
not copy the returned candidate into the canonical task, edit an oracle, use a
Workflow estimate as a measurement, or replace its Host-owned analysis.
Require `host-verification.json` with `verdict=pass`; a missing stage/id or a
failed review is canonical `stalled`, not permission to skip this gate.
Never pass `scriptPath`, invoke a nested `workflow()` helper, or translate the
Proposal ad hoc. If compatibility preparation or the Workflow call fails, do
not rewrite the author-owned script, retry dispatch, or optimize directly as
the parent. Transition the Session to canonical `stalled`, record the failure,
and stop at that fresh boundary.

Task tests, reference implementations, problem definitions, and benchmark
harnesses are immutable oracles. A workflow may return a candidate or exercise
a candidate-aware Session-local seam; neither child nor parent may copy-edit an
oracle to manufacture such a seam.

At Phase 6, the foreground `session-synthesizer` is the sole writer of
`round-$CURRENT_ROUND-summary.md` and
`round-$CURRENT_ROUND-transfer.json`. The controller must not write, edit,
reconstruct, or repair either artifact after a timeout or failed child. Leave
canonical phase and round unchanged and end the controller turn; a later
`kersor_resume` retries from that exact synthesis boundary. Only
`normalize-transfer.py` may atomically advance a DSH `CONTINUE` round. Never
call `kersor-state.sh ... set current_round ...` or `kersor-state.sh ...
advance ...`, and never manufacture `phase=stalled` to compensate for missing
synthesis evidence.
For an exact `COMPLETE`, the same normalizer runs KerSor's deterministic
acceptance gate against the canonical Attempt Result and target: a pass commits
`phase=complete`; a fail continues or stalls at the execution budget. Publish a
committed terminal result with one final `kersor_status`; do not substitute a
prose completion or an external Claude/Codex acceptance process.

## Operating rules

1. Inspect the target repository and its local instructions before mutation. Preserve unrelated worktree changes.
2. Use KerSor's scripts for deterministic facts and validation; keep engineering judgment in the agent as required by the current command protocol.
3. Treat the target task, spec, session files, and measured benchmark output as their documented sources of truth. Do not reconstruct state from chat memory.
4. Report the exact validation commands and measured result. Never claim an optimization without the benchmark evidence required by the selected protocol.
5. If `kersor_status`, the composer, or a required command protocol cannot be loaded, stop before mutation and report the exact failure. Do not simulate or bypass KerSor.
6. If a current KerSor file conflicts with this adapter, follow the KerSor file and flag the adapter drift for maintenance.
