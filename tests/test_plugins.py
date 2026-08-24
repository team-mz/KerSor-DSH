"""Portable checks for the built KerSor plugins and their Web bundle."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGES = (
    ROOT / "plugins" / "kersor",
    ROOT / "plugins" / "kersor-viewer",
    ROOT / "plugins" / "ui-kersor-viewer",
)


def exported_paths(value: object) -> list[str]:
    """Collect package-relative targets from a nested exports declaration."""
    if isinstance(value, str):
        return [value] if value.startswith("./") else []
    if isinstance(value, dict):
        result: list[str] = []
        for child in value.values():
            result.extend(exported_paths(child))
        return result
    return []


class BuiltPluginTests(unittest.TestCase):
    """Keep copied build artifacts usable without the source monorepo."""

    def test_manifests_ship_every_declared_export(self) -> None:
        for package in PACKAGES:
            manifest = json.loads((package / "package.json").read_text(encoding="utf-8"))
            for target in exported_paths(manifest.get("exports", {})):
                if "*" in target:
                    continue
                self.assertTrue(
                    (package / target).is_file(),
                    f"{package.name}: missing export target {target}",
                )

    def test_kersor_manifest_ships_generated_control_chunks(self) -> None:
        package = ROOT / "plugins" / "kersor"
        manifest = json.loads((package / "package.json").read_text(encoding="utf-8"))
        control = (package / "lib" / "control.js").read_text(encoding="utf-8")
        chunks = {
            match.removeprefix("./")
            for match in re.findall(r'from\s+["\'](\./types-[^"\']+\.js)["\']', control)
        }
        self.assertTrue(chunks, "control.js must expose its generated runtime chunk imports")
        self.assertIn("lib/types-*.js", manifest["files"])
        for chunk in chunks:
            self.assertTrue((package / "lib" / chunk).is_file(), chunk)

    def test_kersor_control_preserves_the_authoring_escape_before_terminal(self) -> None:
        package = ROOT / "plugins" / "kersor"
        for path in (package / "src" / "control.ts", package / "lib" / "control.js"):
            control = path.read_text(encoding="utf-8")
            self.assertIn(
                "selected_workflow.name is STALLED is a recoverable routing gap",
                control,
                str(path),
            )
            self.assertIn(
                "complete Phase 3.6 and the full same-round selection sequence",
                control,
                str(path),
            )

    def test_web_bundle_owns_the_read_only_composition(self) -> None:
        bundle = ROOT / "bundles" / "kersor-web"
        manifest = json.loads((bundle / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(
            manifest["dsh"]["bundle"]["patch"],
            "./cordis.patch.yml",
        )
        self.assertEqual(
            set(manifest["dependencies"]),
            {
                "@deepseek-ai/dsh-client-ui-kersor-viewer",
                "@deepseek-ai/dsh-kersor",
                "@deepseek-ai/dsh-kersor-viewer",
            },
        )
        patch = (bundle / "cordis.patch.yml").read_text(encoding="utf-8")
        self.assertIn("name: '@deepseek-ai/dsh-kersor-viewer'", patch)
        self.assertIn("name: '@deepseek-ai/dsh-client-ui-kersor-viewer'", patch)
        self.assertNotIn("name: '@deepseek-ai/dsh-kersor'", patch)

    def test_ui_consumes_the_api_assembly_without_remounting_remotes(self) -> None:
        package = ROOT / "plugins" / "ui-kersor-viewer"
        for path in (
            package / "src" / "client" / "index.ts",
            package / "lib" / "types" / "client" / "index.js",
            package / "lib" / "client.js",
        ):
            client = path.read_text(encoding="utf-8")
            self.assertNotIn("ctx.remote.$mount(", client, str(path))
            self.assertNotIn("remoteDisposers", client, str(path))

        client = (package / "lib" / "client.js").read_text(encoding="utf-8")
        self.assertIn('ctx.get("remote.kersorViewer")', client)
        self.assertNotIn("ctx.remote.kersorViewer", client)
        self.assertIn("ctx.remote.pluginInventory.list()", client)
        self.assertIn('entry.moduleName === "@deepseek-ai/dsh-kersor"', client)
        self.assertIn("remote.snapshot()", client)
        self.assertIn('ctx.remote.$on("kersor/event"', client)
        self.assertNotIn("setInterval", client)
        self.assertNotIn("listClassicSessions", client)
        self.assertNotIn("listRuns", client)
        self.assertIn("integration_pattern", client)
        self.assertIn("allow_workflow_authoring", client)
        self.assertIn("workflow_authoring_budget", client)
        self.assertIn("decisionReason", client)
        self.assertIn("fitBadge", client)
        self.assertIn("Fit: {confidence}", client)
        self.assertIn("function visibleFitConfidence", client)
        self.assertIn('session.lifecycle === "stalled"', client)
        self.assertIn('session.lifecycle === "cancelled"', client)
        self.assertIn("routeBadge", client)
        self.assertIn("Authoring · used {used}/{budget}", client)
        self.assertIn("Round history", client)
        self.assertIn("KerSor experiment round tree", client)
        self.assertIn("Estimate excluded from results", client)
        self.assertIn("baseline_witness", client)
        self.assertIn("baseline_next_action", client)
        self.assertIn("baseline_reason", client)
        self.assertIn("profile_evidence", client)
        self.assertIn("profile_reason", client)
        self.assertIn("profile_owner", client)
        self.assertIn("dsh_compatibility", client)
        self.assertIn("candidate_ownership", client)
        self.assertIn("fresh_session", client)
        self.assertIn("gateBadge", client)
        self.assertIn("Baseline witness: {status}", client)
        self.assertIn("Profile evidence: {status}", client)
        self.assertIn("Profile owner: {owner}", client)
        self.assertIn("Profile blocked", client)
        self.assertIn("Initialize the baseline method", client)
        self.assertIn("Start a new Session before retrying", client)
        self.assertIn("DSH compatibility: {status}", client)
        self.assertIn("Candidate ownership: {status}", client)
        self.assertIn("Fresh isolation: {status}", client)

    def test_ui_source_matches_the_shared_client_bundle_entry(self) -> None:
        package = ROOT / "plugins" / "ui-kersor-viewer"
        self.assertTrue((package / "src" / "client" / "index.ts").is_file())
        self.assertFalse((package / "src" / "client" / "index.tsx").exists())

    def test_built_viewer_projects_task_native_routing(self) -> None:
        viewer = ROOT / "plugins" / "kersor-viewer" / "lib"
        schema = (viewer / "typert.host.js").read_text(encoding="utf-8")
        classic = (viewer / "types" / "classic.d.ts").read_text(encoding="utf-8")
        for field in (
            "integration_pattern",
            "allow_workflow_authoring",
            "workflow_authoring_budget",
            "baseline_witness",
            "baseline_next_action",
            "baseline_reason",
            "profile_evidence",
            "profile_reason",
            "profile_owner",
            "dsh_compatibility",
            "candidate_ownership",
            "fresh_session",
            "decision",
        ):
            self.assertIn(field, schema)
            self.assertIn(field, classic)

    def test_pure_viewer_fold_and_browser_store_compose(self) -> None:
        script = r'''
import { pathToFileURL } from 'node:url'
const fold = await import(pathToFileURL(process.env.FOLD).href)
const ui = await import(pathToFileURL(process.env.STORE).href)
const view = fold.createRunView('r1', '/runs/r1', '/sessions/s1')
for (const event of [
  { type: 'workflow.started', ts: '2026-08-17T00:00:00Z' },
  { type: 'phase.changed', phase: 'Generate' },
  { type: 'agent.queued', phase: 'Generate', call_id: 'c1', seq: 1, label: 'candidate' },
  { type: 'agent.completed', phase: 'Generate', call_id: 'c1', seq: 1, usage: { total_tokens: 42 } },
  { type: 'workflow.completed', ts: '2026-08-17T00:00:02Z', usage: { total_tokens: 42 } },
]) fold.foldEvent(view, event)
const store = new ui.KersorViewerStore()
store.setSnapshot({
  asOf: '2026-08-17T00:00:02Z',
  runs: [{ runId: 'r1', runDir: '/runs/r1', sessionDir: '/sessions/s1', root: '/sessions', discovery: 'completed' }],
  classic: { sessions: [], source: { state: 'healthy' } },
  diagnostics: {
    scan: { state: 'healthy', roots: [] },
    runs: [],
  },
})
store.applyFrame({ kind: 'run', run: view })
console.log(JSON.stringify({ view, state: store.getSnapshot(), active: store.activeView }))
'''
        environment = dict(os.environ)
        environment.update(
            {
                "FOLD": str(ROOT / "plugins" / "kersor-viewer" / "lib" / "types" / "fold.js"),
                "STORE": str(ROOT / "plugins" / "ui-kersor-viewer" / "lib" / "types" / "client" / "store.js"),
            }
        )
        completed = subprocess.run(
            ["node", "--input-type=module", "--eval", script],
            check=False,
            capture_output=True,
            text=True,
            env=environment,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        value = json.loads(completed.stdout)
        self.assertEqual(value["view"]["status"], "completed")
        self.assertEqual(value["view"]["totals"]["completed"], 1)
        self.assertEqual(value["view"]["totals"]["tokens"], 42)
        self.assertEqual(value["active"]["currentPhase"], "Generate")

    def test_built_scanner_recognizes_waiting_as_terminal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            session = root / "session"
            runtime = session / "autonomous-runs" / "run-waiting" / ".runtime"
            runtime.mkdir(parents=True)
            (session / "session-config.json").write_text("{}\n", encoding="utf-8")
            (session / "state.json").write_text("{}\n", encoding="utf-8")
            (runtime / "summary.json").write_text(
                json.dumps({"workflow_status": "waiting"}), encoding="utf-8"
            )
            script = r'''
import { pathToFileURL } from 'node:url'
const scanner = await import(pathToFileURL(process.env.SCANNER).href)
console.log(JSON.stringify(await scanner.scanRoots([process.env.ROOT], false)))
'''
            environment = dict(os.environ)
            environment.update(
                {
                    "SCANNER": str(ROOT / "plugins" / "kersor-viewer" / "lib" / "types" / "scanner.js"),
                    "ROOT": str(root),
                }
            )
            completed = subprocess.run(
                ["node", "--input-type=module", "--eval", script],
                check=False,
                capture_output=True,
                text=True,
                env=environment,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            value = json.loads(completed.stdout)
            self.assertEqual(value["runs"][0]["discovery"], "completed")
            self.assertEqual(value["observation"]["state"], "healthy")

    def test_built_scanner_reuses_installed_preset_checkout(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            checkout = root / "checkout"
            session = checkout / ".kersor" / "session"
            run = session / "autonomous-runs" / "run-recorded"
            (run / ".runtime").mkdir(parents=True)
            (session / "session-config.json").write_text("{}\n", encoding="utf-8")
            (session / "state.json").write_text("{}\n", encoding="utf-8")
            pointer = root / "dsh" / ".agent-presets" / "kersor" / ".local"
            pointer.mkdir(parents=True)
            (pointer / "kersor-root").write_text(f"{checkout}\n", encoding="utf-8")
            script = r'''
import { pathToFileURL } from 'node:url'
const scanner = await import(pathToFileURL(process.env.SCANNER).href)
console.log(JSON.stringify(await scanner.scanRoots([], true)))
'''
            environment = dict(os.environ)
            environment.update(
                {
                    "DSH_HOME": str(root / "dsh"),
                    "SCANNER": str(
                        ROOT
                        / "plugins"
                        / "kersor-viewer"
                        / "lib"
                        / "types"
                        / "scanner.js"
                    ),
                }
            )
            completed = subprocess.run(
                ["node", "--input-type=module", "--eval", script],
                check=False,
                capture_output=True,
                text=True,
                env=environment,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            value = json.loads(completed.stdout)
            self.assertTrue(any(item["runDir"] == str(run) for item in value["runs"]))

    def test_built_classic_adapter_uses_the_installed_preset_bridge(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            poisoned = root / "poisoned-path"
            poisoned.mkdir()
            fake_python = poisoned / "python3"
            fake_python.write_text("#!/bin/sh\nexit 97\n", encoding="utf-8")
            fake_python.chmod(0o755)
            bridge = (
                root / "dsh" / ".agent-presets" / "kersor" / "bin" / "kersor_bridge.py"
            )
            bridge.parent.mkdir(parents=True)
            bridge.write_text(
                """import json
print(json.dumps({"sessions": [{"session_id": "s1", "session_dir": "/sessions/s1", "storage_kind": "legacy", "phase": "optimizing", "lifecycle": "active", "status": "pre-round-1", "health": "active", "warnings": []}]}))
""",
                encoding="utf-8",
            )
            script = r'''
import { pathToFileURL } from 'node:url'
const viewer = await import(pathToFileURL(process.env.VIEWER).href)
console.log(JSON.stringify(await viewer.readClassicSessions(1)))
'''
            environment = dict(os.environ)
            environment.update(
                {
                    "DSH_HOME": str(root / "dsh"),
                    "KERSOR_PYTHON": sys.executable,
                    "PATH": f"{poisoned}{os.pathsep}{environment.get('PATH', '')}",
                    "VIEWER": str(
                        ROOT
                        / "plugins"
                        / "kersor-viewer"
                        / "lib"
                        / "types"
                        / "classic.js"
                    ),
                }
            )
            completed = subprocess.run(
                ["node", "--input-type=module", "--eval", script],
                check=False,
                capture_output=True,
                text=True,
                env=environment,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            value = json.loads(completed.stdout)
            self.assertEqual(value["sessions"][0]["session_id"], "s1")

    def test_skill_uses_one_configured_python_for_every_bridge_call(self) -> None:
        skill = (
            ROOT / "presets" / "kersor" / "skills" / "kersor" / "SKILL.md"
        ).read_text(encoding="utf-8")
        configured_calls = skill.count('"${KERSOR_PYTHON:-python3}" "$bridge"')
        self.assertGreater(configured_calls, 0)
        self.assertEqual(configured_calls, skill.count('"$bridge"'))
        self.assertNotIn('python3 "$bridge"', skill)

    def test_skill_preserves_typed_tasks_and_explicit_authoring_grants(self) -> None:
        skill = (
            ROOT / "presets" / "kersor" / "skills" / "kersor" / "SKILL.md"
        ).read_text(encoding="utf-8")
        self.assertIn("--backend python --language python_reference", skill)
        self.assertIn("--allow-workflow-authoring", skill)
        self.assertIn("--workflow-authoring-budget", skill)
        self.assertIn("`--yolo` is not a creation grant", skill)
        self.assertIn("commands/research.md", skill)

    def test_built_viewer_combines_workspace_and_session_persistence_roots(self) -> None:
        package = ROOT / "plugins" / "kersor-viewer"
        manifest = json.loads((package / "package.json").read_text(encoding="utf-8"))
        self.assertIn("@deepseek-ai/dsh-workspace", manifest["peerDependencies"])
        self.assertIn(
            "@deepseek-ai/dsh-session-persistence", manifest["peerDependencies"]
        )
        host = (package / "lib" / "index.js").read_text(encoding="utf-8")
        self.assertIn(
            'static inject = ["workspaceRegistry", "sessionPersistence"]', host
        )
        self.assertIn("workspaceRegistry.list()", host)
        self.assertIn("sessionPersistence.list()", host)


if __name__ == "__main__":
    unittest.main()
