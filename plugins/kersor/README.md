# kersor — DSH-native KerSor control and registered Mission launcher

English | [中文](README.zh.md)

The `./control` function plugin binds a KerSor experiment to the current dsh conversation and runs it in one durable, continuable dsh child. The package root remains the optional Host launcher that makes registered [KerSor](https://github.com/qhy991/KerSor) autonomous Missions launchable without turning the browser into a shell.

KerSor files remain the source of truth for optimization state, evidence, artifacts, and resume decisions. The parent dsh Session owns only the immutable Experiment-to-child binding and monotonic display checkpoints; the child dsh Session owns the complete controller dialog and its existing `tool-workflow/*` execution tree. Pair the package with [`@deepseek-ai/dsh-kersor-viewer`](../kersor-viewer/README.md) and [`@deepseek-ai/dsh-client-ui-kersor-viewer`](../ui-kersor-viewer/README.md) for the global read-only view and the keyed Experiment Chat node.

## Conversation controller

Mount `@deepseek-ai/dsh-kersor/control` inside the KerSor agent preset. `kersor_start` reserves an Experiment id and continuable child id, appends and flushes `kersor/experiment-start`, then starts the child through the in-process `spawn` provider. `kersor_attach` performs the same binding for an existing workspace Session. `kersor_resume` accepts only an open binding and delivers a follow-up to its original child; it cannot create another Experiment or silently repeat a dispatch. KerSor `phase=stalled` closes that binding as `blocked`: resume rejects it explicitly, its next action is empty, and the parent may create a new Experiment after resolving the blocker.

`kersor_start` optionally accepts one immutable `launch` object. When present, all fields are required: non-empty `backend`, `language`, and `integration_pattern`; positive numeric `target_speedup`; positive integer `max_workflows`; `mode` in `auto|guided|explore`; nonnegative integer `workflow_authoring_budget`; explicit `retrieval_mode`, `experience_mode`, and `kernelwiki_experience_export_mode` in `on|off`; `transfer_mode` in `full|measured-only|off`; and non-empty single-line `correctness_command` and `benchmark_command`. The validated object is stored on `kersor/experiment-start` in canonical field order and reused unchanged by resume. It is authoritative over conflicting objective or continuation prose: numeric fields remain JSON numbers without `x` or `%` suffixes, and both commands remain verbatim. `runtime` is deliberately absent because the controller always uses `dsh`; Host `KERSOR_PYTHON` remains a separate interpreter authority.

The controller fixes KerSor runtime selection to `dsh`. A round selection named `STALLED` remains a recoverable routing gap while canonical phase is active: when Workflow authoring is enabled and saved-Proposal budget remains, the child must complete Phase 3.6, the full same-round selection commit, and any resulting dispatch before it may synthesize a terminal `STALLED` decision. After a top-level conversation binds its controller child, executor policy reserves direct delegation to every child id declared by that conversation's `kersor/experiment-start` events: parent-side subagent, fork, Workflow, agent-control, job-control, and status tools are denied, while the controller child may still create its own DSH-native workers. Recursive KerSor controls and product-specific Claude/Codex subagent tools remain denied inside the controller. A stalled, completed, or cancelled controller may call only `kersor_status`; that successful terminal status result concludes its Turn. Every successful `kersor_status` call produces a deduplicated, flushed checkpoint containing phase, round, selected Workflow, nine protocol milestones, next action, and measured summary fields. A completed parent Turn does not terminate or mark the Experiment interrupted.

The conversation controller requires Host `KERSOR_PYTHON` to be a non-empty absolute path that resolves to an executable file. Start and attach validate it before writing a binding; resume validates it before sending a follow-up. The resolved path is frozen into every child instruction, which requires each KerSor bridge, helper, and setup shell command to begin with an explicit `KERSOR_PYTHON='<frozen-path>'` assignment and forbids `which`, `PATH` lookup, filesystem search, or interpreter substitution.

That interpreter contract is also an execution gate, not prompt guidance alone. Before each Bash call, the controller walks the calling Session's live `parentSession` chain; the controller and every descendant must begin KerSor bridge/helper/setup commands with the exact canonical `KERSOR_PYTHON='<frozen-path>'; export KERSOR_PYTHON;` prefix. Python discovery and substitution are denied throughout that ancestry. Unrelated task Bash, KerSor agents/docs reads and listings, non-Bash tools, and agents outside an Experiment ancestry are unaffected.

`kersor_protocol` owns three complete DSH actions: profile handoff, Workflow selection, and author handoff. The direct controller supplies only `profile`, `select_workflow`, or `author`. The Host derives every path, current round, frozen executable, and adapter root from durable Session authority and runs fixed argument vectors through the managed subprocess service. Profile and author read the complete canonical dispatch and launch the exact foreground child, so the model never copies a long JSON prompt or passes a child id. Selection runs the Core filter, reads the Core `selection-handoff.py` context, launches one foreground strategy selector only for `agent-advise`, then runs the Core finalizer before returning; STALLED, fixed-order, score-only, and binding explore decisions finalize without a child. The selector child has an enforced `read`/`glob`/`grep`/`write` allowlist, and only that active child may write the exact canonical routing decision once. The context binds the catalog hash: an unchanged-catalog repeat is consumed, while a changed catalog permits same-round re-selection and Core archives any prior decision. Environment-only paired routing is rejected because its pair identity and shared store have no durable Session owner. Profile first verifies the durable baseline chain; a pre-baseline rejection starts no work and is retryable, while the first post-baseline call consumes the profile attempt. It then seals and verifies the child-owned bytes before returning; KerSor files remain the semantic sources of truth. Attached controllers cannot use this tool. The [typed-action decision](../../../.agents/notes/implemented/simplification/2026-08-24-host-owned-kersor-deterministic-actions.md) owns the rationale.

The canonical setup boundary also owns its Bash sandbox disposition. A foreground call with the exact Host-generated command and a workdir that is absent, the literal `.`, or the exact canonical controller workspace string remains the one durable setup identity; other spellings are rejected so symlink/`..` aliases cannot cross the authorization boundary. After that exact registry execution is authenticated, any authored `sandbox_permissions` and `justification` are suppressed before Bash validates escalation or requests approval. Setup therefore runs under the Session's standing workspace policy; an authored escalation can neither prevent the first execution through an invalid pair nor widen its authority. The authorization is keyed by the registry-minted execution object, cleared again at the final `tools/result`, and cannot survive failure, call-id reuse, disposal, or reload.

Gate B commits the deterministic runtime-control pass inside the Host operation that accepts the foreground dispatch producer. After the producer writes both semantic files, the Host publishes its receipt and durable `kersor/dispatch-args-produced` event, invokes the frozen `inject-runtime-controls.py` by argument vector through the managed subprocess service, checks that only the runtime-control field allowlists changed, then atomically publishes the transformation receipt and `kersor/dispatch-args-transformed`. The controller receives no transform command. A failed process or invalid mutation preserves producer evidence but publishes no successful transformation event. The [Host-owned transform decision](../../../.agents/notes/implemented/simplification/2026-08-24-host-owned-kersor-dispatch-transform.md) owns the rationale.

The selected Workflow becomes dispatchable only after KerSor's Router commit is complete. The one Host selection validator shared by Gate B and Workflow source validation requires both `attempt_plan.status=committed` and `attempt_plan.commit.status=committed`, requires that commit to name `selected_workflow.name`, and rejects an absent or pending `routing.decided_by`. A selector fallback written before finalization therefore cannot acquire dispatch or Workflow authority.

Workflow authoring gives the foreground author exclusive staging custody until the typed Host seal. The direct controller cannot read, search, list, or mutate staging before that seal, while the author child retains its pre-seal file writes and syntax self-checks. When `kersor_protocol({action: "author"})` completes, the Host records the context hash and the child id minted by its in-process start call in `kersor/author-produced`; this is a Host binding, not a separately replay-proven lineage claim. `kersor_author_commit({action: "seal"})` derives every path and executable from durable authority, validates a canonical non-symlink staging directory with exactly three bounded direct files before execution, invokes Core by fixed argv, then records only the complete handoff receipt path and SHA-256 in `kersor/author-handoff-sealed`. Core remains the owner of the handoff's open-world internal schema. Between seal and save, only the direct controller may use `read` on one exact canonical staging file at a time; the Host revalidates the current receipt before every read, while aliases, hardlinks, symlinks, searches, Bash, descendants, and all mutations remain denied. `kersor_author_commit({action: "save"})` validates canonical write targets and unchanged receipt bytes, appends and flushes `kersor/author-save-attempted`, then invokes Core's saver by fixed argv. It reports success only after Core emits one canonical Session-local probation Proposal, the Host binds its workflow, metadata, and record files, and a second fixed Host process rebuilds `workflow-catalog.json` from that Proposal store with the new entry verified. Process failure, malformed success output, missing artifacts, or invalid catalog remains consumed and cannot be retried. The [typed author commit decision](../../../.agents/notes/implemented/simplification/2026-08-24-host-owned-kersor-author-commit.md) owns this boundary.

Successful `workflow` results have one Host-owned filesystem boundary. Every Experiment descendant must pass an absolute `args.exp_dir` resolving without symlinks to exactly `<workspace>/.kersor/<session>/run-N`. Before the result reaches the model, the Host validates canonical `{runId, agentsStarted, result}`, requires the raw `result` to be a JSON object no larger than 4 MiB, writes a complete temporary file, and publishes it as `output.json` through an atomic exclusive hard link. Invalid paths, symlink escapes, non-object or oversized results, and an existing output all block the Workflow result; nothing is overwritten. The rendered tool result may be truncated, but this file is built from the untruncated canonical value.

Once `run-N/output.json` exists, Experiment descendants may read it but cannot mutate it through `write`, `edit`, obvious Bash redirection/`tee`/`cp`/`mv`/`rm`, or Python open/write paths. Only successful Workflow results are Host-committed. A failed Workflow creates no file, so the controller may use `write` once to create a missing failure stub; after that first creation, the same immutability rule applies.

## Configuration

Add the Host plugin through an overlay such as `~/.dsh/cordis.patch.yml`:

```yaml
- id: kersor
  name: '@deepseek-ai/dsh-kersor'
  config:
    root: /absolute/path/to/KerSor
    python: /absolute/path/to/python3
    tasks:
      - id: memo
        label: Build repository memo
        mission: /absolute/path/to/memo.mission.json
        runtimeConfig: /absolute/path/to/codex-runtime.json
    credentialRefs:
      - INFINI_API_KEY
    env:
      NO_PROXY: 127.0.0.1,localhost
    maxOutputBytes: 65536
    stopGraceMs: 3000
```

- `root` is the absolute KerSor checkout containing `scripts/run-autonomous-workflow.py`.
- `python` is an absolute executable or bare `PATH` name in the subprocess provider's execution world.
- `tasks` is the complete browser-launchable registry. `mission` and optional `runtimeConfig` paths must be absolute; remote callers submit only the task `id`.
- `credentialRefs` are resolved from dsh's credential provider for each launch and forwarded under the same environment names. Secret values never enter the task listing or launch receipt.
- `env` contains explicit non-secret child entries. It does not inherit credential-shaped variables scrubbed by the subprocess boundary.
- `maxOutputBytes` bounds each captured launcher stream; `stopGraceMs` controls TERM-to-KILL escalation.

The Mission must be a JSON `kersor-mission-v1` document. Its `workspace`, `session`, and `runtime` route the canonical KerSor runner. Relative Mission paths resolve from the Mission file itself; no equivalent routing fields exist in plugin config.

## Runtime semantics

`start(taskId)` returns after dsh owns the process tree and includes the generated `runId` and expected `runDir`. It does not claim that the workflow started successfully or completed. `listActive()` is only an inventory of launcher processes still owned by this dsh process. Workflow status comes from KerSor run files through the viewer.

Plugin disposal terminates and joins every owned process tree. A dsh restart does not reconstruct ownership of an already detached KerSor process; its run files remain discoverable by the viewer.

## Model Experience

### Controller tools and child prompt

#### What the model sees

The parent sees three small tool schemas: start, attach, and resume. Each successful result states that the controller owns all further work, tells the parent to end its Turn without polling, delegation, or workspace inspection, and carries the runtime conclusion marker that enforces that stop. The start schema exposes the optional typed launch contract with field-level enum, number, command, and authority descriptions. The controller child receives the frozen objective, current workspace, resolved Host Python path, explicit `runtime=dsh`, canonical launch JSON plus one instruction per field when supplied, the three-action `kersor_protocol` contract, the two-action `kersor_author_commit` contract, and the Host-owned Workflow output contract. It asks the Host to complete profile and author handoffs plus author seal/save instead of reading or reconstructing helper paths, dispatch prompts, child identities, receipt fields, or shell commands. It is told to read the raw `output.json` after Workflow success instead of reconstructing it from capped result text, and to create a stub only after Workflow error while the file is absent. The child also receives the instruction to load the installed KerSor skill and report phase changes through `kersor_status`; it never receives the parent transcript. Session persistence retains the interpreter, launch, and custody instructions for every later resume.

#### Token effect

The parent pays only for tool calls and checkpoint cards. The controller and every Workflow member use independent child histories, so their tokens do not accumulate in the parent conversation. Typed handoffs and commits carry no helper path, shell command, dispatch prompt, child-id, or receipt-body text in controller requests. Selection transfers the Core-owned prompt directly to its optional child; neither finalization nor runtime-control transformation adds controller request or model-visible command context.

#### KV Cache effect

The parent and each child have independent cache prefixes. Resume appends to the same controller child history; it does not create a fresh context or invalidate the parent's earlier prefix.

## Known Limitations and Deferred Work

- `kersor_protocol` currently accepts only created controller authority. Attached controllers retain their imported Session evidence but cannot invoke the three complete Host actions until imported current-action ownership is defined.
- The current DSH Session layout supports one authored producer, seal, and save. Values of `workflow_authoring_budget` above one remain unsupported until author attempts have distinct canonical identities and paths.
- Tasks are static deployment config. Editing Missions, runtime configs, or arbitrary command arguments from the browser is intentionally unsupported.
- Resume is not exposed remotely. KerSor's canonical runner remains the owner of resume validation and policy.
- Launcher stdout/stderr is bounded for diagnostics but not exposed to browsers. Workflow diagnostics should be read from KerSor's `.runtime` files.
- The launcher does not infer workflow success from process exit; the viewer's folded KerSor state is authoritative.
- Closing the page or switching conversations does not stop a controller child. A Host restart preserves both Sessions but requires an explicit `kersor_resume`; the current Workflow engine cannot resume in the middle of one foreground script call.
- The optional registered-Mission launcher is a separate compatibility surface and may use its Mission-declared external runtime. The conversation controller is the canonical DSH-only optimization path.
