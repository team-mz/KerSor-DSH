# kersor-viewer — KerSor activity viewer

English | [中文](README.zh.md)

Viewer for [KerSor](https://github.com/qhy991/KerSor) activity inside the dsh Web UI. It exposes two intentionally separate projections: recent optimization Sessions (including the existing classic `state.md` format) and live autonomous-workflow runs. This host package asks the installed KerSor preset bridge for bounded Session summaries, discovers autonomous run directories, and tails each active run's `.runtime/events.jsonl`. One generated `snapshot` Remote and one replacement event carry both inventories with their source health atomically; `runBacklog` and `runResult` carry a selected run's folded progress and candidate result, `runCallDetail` lazily projects one known call's retained messages and activity names, and `classicSessionDetail` reads one already-discovered classic Session on demand. The browser half lives in [`@deepseek-ai/dsh-client-ui-kersor-viewer`](../ui-kersor-viewer/README.md).

KerSor remains the single state owner. The bridge imports KerSor's canonical `SessionStore` and `AttemptResultStore`; the TypeScript package does not reimplement legacy frontmatter parsing. The viewer scans each registered Workspace plus every valid absolute cwd in canonical Session persistence, so API-created and continuable-child sessions remain visible even when their cwd has no `workspaceRegistry` record. If persistence listing fails, discovery retains the last successful persisted cwd set, keeps current registered Workspaces, and marks the final source snapshot degraded without publishing an intermediate replacement. If the preset is absent, the snapshot records `not_installed` while autonomous run discovery continues.

This package is observation-only. To start a finite deployment-configured set of Missions from the same panel, compose the sibling launcher [`@deepseek-ai/dsh-kersor`](../kersor/README.md). KerSor run files remain authoritative whether or not that launcher is loaded.

## Configuration

The plugin row accepts config in `cordis.patch.yml`:

```yaml
- id: kersor-viewer
  name: '@deepseek-ai/dsh-kersor-viewer'
  config:
    roots:
      - /absolute/path/to/kersor/.kersor
    noDefaultRoots: false
    scanIntervalMs: 5000
    classicSessionLimit: 20
    classicStaleAfterSeconds: 1800
```

- `roots` — extra directories whose direct children are KerSor Sessions, scanned in addition to registered DSH Workspaces, persisted Session cwd values, and the defaults.
- `noDefaultRoots` — disable the built-in roots: `~/.local/share/kersor`, `~/Agent4Kernel/KerSor/.kersor`, and the checkout recorded by the installed `kersor` preset (or `KERSOR_ROOT`) with `/.kersor` appended. Registered Workspaces and persisted Session cwd roots remain visible because they are task state, not fallback defaults.
- `scanIntervalMs` — run-discovery rescan interval (minimum 500 ms).
- `classicSessionLimit` — recent optimization Sessions returned by the installed preset bridge (`0` disables, maximum `100`, default `20`).
- `classicStaleAfterSeconds` — advisory inactivity threshold for unfinished Sessions (default `1800`, maximum one day), matching the KerSor TUI/doctor default.

A summary with `workflow_status: "waiting"` is terminal for run discovery: the KerSor controller has stopped and written its summary, even though the workflow is awaiting external input rather than semantically completed. A completed Workflow does not make its parent optimization Session terminal; the browser joins the run with the canonical Session projection and shows outstanding Host measurement or decision stages separately.

Classic Session cards keep KerSor's canonical phase separate from advisory health. Stable-artifact activity within the threshold is `active`; an old clean `CONTINUE` boundary is `needs_resume`; other unfinished old work is `stale`; terminal phases are `terminal`. Elapsed time never mutates phase. The bounded summary also carries language/backend, integration pattern, workflow-authoring used/total budget, strict fresh-Session isolation, Session-owned baseline-witness and profile-evidence status plus their bounded canonical blockers, DSH-workflow compatibility, host-owned candidate-output ownership, selector outcome, terminal stop reason, and Host-verified cycle lineage. An expanded card requests an ordered, bounded Round history plus the artifact-derived stage timeline, selector rejection count, authoring/seal/save state, Proposal validation checks, dispatch lifecycle, and bounded Workflow design text. Each Round distinguishes the reusable Workflow from its round-unique candidate, and carries measurement only after a passing Host review; failed candidates may retain an explicitly estimated value but can never contribute to the Session best. A passing portable-dispatch envelope exposes the selected released or Proposal Workflow's declared phases and topology after its name and content hashes match the compatibility and catalog owners; a Session-authored Workflow remains hidden until its three-file author handoff exists and every sealed hash still matches. It includes the last stable-artifact timestamp, and a missing absolute kernel path becomes a path-free warning rather than leaking the old local path to the browser.

Source health is structured rather than inferred from an empty array. The snapshot records every scanned root, accepted Session count, discovered run count, backfill/tailer mode, line counters, and the latest bounded stage/code issue. A periodic scan publishes only after experiment or source-health semantics change; scan clocks and repeated identical diagnostics do not emit replacements or invalidate expanded client detail. Missing optional defaults are neutral; a configured missing root, persistence-list failure, permission failure, malformed summary, unreadable event log, or rejected event line is degraded or failed. Persistence-list failure never removes registered or last-successful persisted roots from that scan. Raw exceptions, bridge output, environment values, tool arguments, and tool results never cross the Remote boundary. Call detail accepts only a discovered run plus a call already present in its folded event stream, reads at most 2 MiB of Codex events, retains at most 12 bounded Agent messages and 40 tool/search names, and reports truncation instead of forwarding excess content. A passing bounded `host-verification.json` changes the result stage to `host_verified` and adds measured cycles/speedup without rewriting the raw Workflow `output.json`; absent or failed Host evidence leaves the estimate-only projection unchanged.

## Layout

| File | Role |
|---|---|
| `src/service.ts` | Host half: one cached atomic snapshot, run backlogs, tailing, folding, and replacement events |
| `src/diagnostics.ts` | Content-free issue classification and bounded occurrence tracking |
| `src/detail.ts` | On-demand bounded projection of retained worker identity, messages, and activity names |
| `src/classic.ts` | Bounded no-shell invocation of the installed preset bridge and wire-shape validation |
| `src/scanner.ts` | Root scanning: session-v2 directories and their `autonomous-runs/` children |
| `src/tailer.ts` | Position-tracking `events.jsonl` tail with truncation detection |
| `src/fold.ts` | Pure fold of the KerSor event stream into the view model |
| `src/result.ts` | Candidate-selection projection that excludes source and arbitrary report text |

## Model Experience

None, as this Host-side observer reads KerSor artifacts for browser presentation and registers no prompt, tool schema, or model request input.

#### KV Cache effect

None: the package does not assemble or modify model requests.

## Known Limitations and Deferred Work

- **Worker model identity depends on retained evidence** — older Codex artifacts can carry a runner and thread id without the underlying provider/model; the projection returns an explicit absent value instead of inferring from the parent dsh conversation.
- **Call detail is intentionally incomplete** — only bounded Agent messages and tool/search names render; prompts, tool arguments, tool results, command text, and arbitrary event kinds remain Host-only.
