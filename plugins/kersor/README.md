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

The canonical setup boundary also owns its Bash sandbox disposition. A foreground call with the exact Host-generated command and a workdir that is absent, the literal `.`, or the exact canonical controller workspace string remains the one durable setup identity; other spellings are rejected so symlink/`..` aliases cannot cross the authorization boundary. After that exact registry execution is authenticated, any authored `sandbox_permissions` and `justification` are suppressed before Bash validates escalation or requests approval. Setup therefore runs under the Session's standing workspace policy; an authored escalation can neither prevent the first execution through an invalid pair nor widen its authority. The authorization is keyed by the registry-minted execution object, cleared again at the final `tools/result`, and cannot survive failure, call-id reuse, disposal, or reload.

Gate B gives the direct controller an event-bound transform command instead of asking it to reconstruct script syntax. After the sole foreground dispatch producer writes both semantic files, the Host first mints one `KERSOR_DISPATCH_TRANSFORM_COMMAND_V1` model context, then publishes its receipt and appends and flushes `kersor/dispatch-args-produced`; only that durable success returns the context. Failure to mint the context publishes neither receipt nor event. The context binds the event's exact `run_dir` and producer call identity to one complete Bash command and requires verbatim execution without added flags, variables, redirections, prefixes, suffixes, inspection, probes, or retries. Pre-execution authorization still requires byte-for-byte command equality with exactly one durable producer event; a mismatch reaches no Bash executor and, when one transform is pending, identifies the bound event and required command.

Workflow authoring gives the foreground author exclusive staging custody until the Host handoff seal. The direct controller cannot read, search, list, or mutate staging before that seal, while the author child retains its pre-seal file writes and syntax self-checks. File-tool enforcement walks nested path fields plus Glob/Grep roots and filters; Bash enforcement resolves the authored workdir, shell cwd changes, static variables and wrappers, globbed targets, raw symlink/`..` traversal, symlink aliases, and regular-file identity before dispatch. The Host classifies seal and Proposal-save only from complete Host-minted Bash envelopes, so basename fragments, aliases, `source`, alternate interpreters, variables, or extra fields never acquire gate identity. It binds the three direct staging files and `author-handoff.json` hashes to `kersor/author-handoff-sealed`, then permanently denies every Experiment actor direct or aliased staging access. The first exact canonical Proposal-save call appends and flushes `kersor/author-save-attempted` before Bash executes; success and script failure both consume it, later calls are rejected before dispatch, and sealed bytes never reopen for repair.

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

The parent sees three small tool schemas: start, attach, and resume. Each successful result states that the controller owns all further work, tells the parent to end its Turn without polling, delegation, or workspace inspection, and carries the runtime conclusion marker that enforces that stop. The start schema exposes the optional typed launch contract with field-level enum, number, command, and authority descriptions. The controller child receives the frozen objective, current workspace, resolved Host Python path, explicit `runtime=dsh`, canonical launch JSON plus one instruction per field when supplied, and the Host-owned Workflow output contract. After the dispatch producer succeeds, it also receives the exact event-bound Gate B transform command as an ordered user context rather than deriving a run path or command syntax. It is told to read the raw `output.json` after Workflow success instead of reconstructing it from capped result text, and to create a stub only after Workflow error while the file is absent. The child also receives the instruction to load the installed KerSor skill and report phase changes through `kersor_status`; it never receives the parent transcript. Session persistence retains the interpreter, launch, and custody instructions for every later resume.

#### Token effect

The parent pays only for tool calls and checkpoint cards. The controller and every Workflow member use independent child histories, so their tokens do not accumulate in the parent conversation. Each successful dispatch producer adds one bounded canonical-command user context to the controller's next model request and durable history.

#### KV Cache effect

The parent and each child have independent cache prefixes. Resume appends to the same controller child history; it does not create a fresh context or invalidate the parent's earlier prefix.

## Known Limitations and Deferred Work

- Tasks are static deployment config. Editing Missions, runtime configs, or arbitrary command arguments from the browser is intentionally unsupported.
- Resume is not exposed remotely. KerSor's canonical runner remains the owner of resume validation and policy.
- Launcher stdout/stderr is bounded for diagnostics but not exposed to browsers. Workflow diagnostics should be read from KerSor's `.runtime` files.
- The launcher does not infer workflow success from process exit; the viewer's folded KerSor state is authoritative.
- Closing the page or switching conversations does not stop a controller child. A Host restart preserves both Sessions but requires an explicit `kersor_resume`; the current Workflow engine cannot resume in the middle of one foreground script call.
- The optional registered-Mission launcher is a separate compatibility surface and may use its Mission-declared external runtime. The conversation controller is the canonical DSH-only optimization path.
