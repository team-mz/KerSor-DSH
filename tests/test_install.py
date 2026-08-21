"""Regression tests for the generated DSH preset installation contract."""

from __future__ import annotations

import importlib.util
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("dsh_plugin_install", ROOT / "scripts" / "install.py")
assert SPEC is not None and SPEC.loader is not None
INSTALLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALLER)


STANDARD = """# The `standard` agent preset.
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'
"""


FAKE_KERSOR_CORE = '''
import json
from pathlib import Path

class AttemptResultError(ValueError):
    pass

class SessionStore:
    def __init__(self, session_dir):
        self.session_dir = Path(session_dir)
    @property
    def storage_kind(self):
        if (self.session_dir / "session-config.json").is_file() and (self.session_dir / "state.json").is_file():
            return "v2"
        if (self.session_dir / "state.md").is_file():
            return "legacy"
        return "missing"
    def snapshot(self):
        config = json.loads((self.session_dir / "session-config.json").read_text())
        state = json.loads((self.session_dir / "state.json").read_text())
        return {**config, **state}

class AttemptResultStore:
    def __init__(self, run_dir):
        self.run_dir = Path(run_dir)
        self.path = self.run_dir / "attempt-result.json"
    @property
    def storage_kind(self):
        return "canonical" if self.path.is_file() else "missing"
    def snapshot(self, allow_legacy=True):
        try:
            return json.loads(self.path.read_text())
        except Exception as error:
            raise AttemptResultError(str(error)) from error
'''


class InstallTests(unittest.TestCase):
    """Prove rendering, idempotency, and recoverable replacement."""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.dsh_home = self.root / "dsh-home"
        self.standard = self.root / "standard.yml"
        self.standard.write_text(STANDARD, encoding="utf-8")
        self.kersor = self.root / "KerSor"
        (self.kersor / "commands").mkdir(parents=True)
        (self.kersor / "scripts").mkdir()
        (self.kersor / "AGENTS.md").write_text("# Rules\n", encoding="utf-8")
        (self.kersor / "scripts" / "compose.py").write_text("", encoding="utf-8")
        (self.kersor / "scripts" / "doctor.sh").write_text("", encoding="utf-8")
        (self.kersor / "kersor_core").mkdir()
        (self.kersor / "kersor_core" / "__init__.py").write_text(
            FAKE_KERSOR_CORE, encoding="utf-8"
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_install(self, *, force: bool = False):
        """Install into the isolated DSH home."""
        return INSTALLER.install(
            dsh_home=self.dsh_home,
            standard_preset=self.standard,
            kersor_root=self.kersor,
            force=force,
            dry_run=False,
        )

    def test_install_renders_delta_and_local_root(self) -> None:
        destination, backup, changed = self.run_install()
        self.assertTrue(changed)
        self.assertIsNone(backup)
        composition = (destination / "agent.cordis.yml").read_text(encoding="utf-8")
        self.assertIn("The `kersor` agent preset", composition)
        self.assertIn(INSTALLER.KERSOR_LINE, composition)
        self.assertIn("name: './plugins/kersor-status.mjs'", composition)
        self.assertIn("customSkillDirs:", composition)
        self.assertIn(str((destination / "skills").resolve()), composition)
        self.assertNotIn(str(self.kersor), composition)
        self.assertTrue((destination / "plugins" / "kersor-status.mjs").is_file())
        self.assertEqual(
            (destination / ".local" / "kersor-root").read_text(encoding="utf-8"),
            f"{self.kersor.resolve()}\n",
        )

    def test_identical_reinstall_is_a_noop(self) -> None:
        destination, _, _ = self.run_install()
        second_destination, backup, changed = self.run_install()
        self.assertEqual(second_destination, destination)
        self.assertFalse(changed)
        self.assertIsNone(backup)

    def test_installed_bridge_resolves_recorded_checkout(self) -> None:
        destination, _, _ = self.run_install()
        environment = dict(os.environ)
        environment.pop("KERSOR_ROOT", None)
        completed = subprocess.run(
            [sys.executable, str(destination / "bin" / "kersor_bridge.py"), "root"],
            check=False,
            capture_output=True,
            text=True,
            env=environment,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout.strip(), str(self.kersor.resolve()))

    def test_same_size_local_edit_is_not_mistaken_for_identical(self) -> None:
        destination, _, _ = self.run_install()
        preset = destination / "preset.yml"
        original = preset.read_text(encoding="utf-8")
        preset.write_text("X" * len(original), encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "destination exists and differs"):
            self.run_install()

    def test_force_preserves_different_existing_preset(self) -> None:
        destination, _, _ = self.run_install()
        (destination / "preset.yml").write_text("local edit\n", encoding="utf-8")
        _, backup, changed = self.run_install(force=True)
        self.assertTrue(changed)
        self.assertIsNotNone(backup)
        assert backup is not None
        self.assertEqual((backup / "preset.yml").read_text(encoding="utf-8"), "local edit\n")

    def test_renderer_fails_when_upstream_anchor_changes(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "persona anchor changed"):
            INSTALLER.render_composition(
                "- id: persona\n", skill_dir=self.root / "skills"
            )

    def test_renderer_fails_when_skill_filesystem_anchor_changes(self) -> None:
        source = STANDARD.replace("- id: skill-filesystem\n", "- id: skills-local\n")
        with self.assertRaisesRegex(RuntimeError, "skill-filesystem anchor changed"):
            INSTALLER.render_composition(source, skill_dir=self.root / "skills")

    def test_skill_keeps_custom_tasks_on_bounded_authoring_route(self) -> None:
        skill = (
            ROOT / "presets" / "kersor" / "skills" / "kersor" / "SKILL.md"
        ).read_text(encoding="utf-8")
        self.assertIn("--integration-pattern custom_simulator", skill)
        self.assertIn("--allow-workflow-authoring", skill)
        self.assertIn("--workflow-authoring-budget 1", skill)
        self.assertIn("selection must\nremain `STALLED`", skill)
        self.assertIn("research-only\nworkflow evolution", skill)
        self.assertIn('--store "$SESSION_DIR/workflow-authoring/proposals"', skill)
        self.assertIn("Structural Proposal gates do not make", skill)
        self.assertIn("outer optimize alone installs a winner", skill)
        self.assertIn("transition the Session to `stalled`", skill)
        self.assertIn("prove candidate binding", skill)
        self.assertIn("same Session-local candidate", skill)
        self.assertIn("workflow-author in the foreground", skill)
        self.assertIn("`author-context.json.dispatch`", skill)
        self.assertIn("`description`, `run_in_background`, and `prompt`", skill)
        self.assertIn("blocking result is the completion\nnotification", skill)
        self.assertIn("Never call `list_agents`", skill)
        self.assertIn("`scripts/seal-author-handoff.py`", skill)
        self.assertIn("`workflow-authoring/author-handoff.json`", skill)
        self.assertIn("Save exactly once\nwith `--handoff`", skill)
        self.assertIn("must never repair them", skill)
        self.assertIn("extra staging file or directory is mixed provenance", skill)
        self.assertIn("canonical `stalled`, not a patch or\nretry", skill)
        self.assertIn("Do not accept a prose-only baseline", skill)
        self.assertIn("scripts/baseline-witness.py", skill)
        self.assertIn("baseline-witness.py\" init", skill)
        self.assertIn('--correctness-command "$CORRECTNESS_COMMAND"', skill)
        self.assertIn("baseline-witness.py\" record", skill)
        self.assertIn('--session "$SESSION_DIR" --project-root "$TASK_DIR"', skill)
        self.assertIn("Output produced before Session creation", skill)
        self.assertIn("Never parse `session-config.json` directly", skill)
        self.assertIn("scripts/profile-handoff.py\" context", skill)
        self.assertIn("exact `description`,\n`run_in_background`, and `prompt`", skill)
        self.assertIn("exactly one DSH\n`subagent` call in the foreground", skill)
        self.assertIn("must not write/edit\n`kernel-profile.md`", skill)
        self.assertIn("scripts/profile-handoff.py\" seal", skill)
        self.assertIn('--producer-session-id "$PROFILER_CHILD_SESSION_ID"', skill)
        self.assertIn("scripts/profile-handoff.py\" verify", skill)
        self.assertIn("The first parent action after that result", skill)
        self.assertIn("both\nre-verify this boundary", skill)
        self.assertIn('bash "$kersor_root/scripts/setup-session.sh" "$TASK_DIR"', skill)
        self.assertIn("Never call it from `commands/`", skill)
        self.assertIn('kersor-state.sh" "$SESSION_DIR" get fresh_session_required', skill)
        self.assertIn('get kernelwiki_experience_export_mode', skill)
        self.assertIn("scripts/prepare-dsh-workflow.mjs", skill)
        self.assertIn('--out "$RUN_DIR/dsh-workflow.json"', skill)
        self.assertIn('--report "$RUN_DIR/dsh-compatibility.json"', skill)
        self.assertIn("Workflow({meta: envelope.meta, script: envelope.script, args: envelope.args})", skill)
        self.assertIn("candidate-ownership.py\" seal", skill)
        self.assertIn("candidate-ownership.py\" verify", skill)
        self.assertIn("first parent action", skill)
        self.assertIn("Never pass `scriptPath`", skill)
        self.assertIn("not rewrite the author-owned script, retry dispatch, or optimize directly", skill)
        self.assertIn("immutable oracles", skill)
        self.assertIn("`kersor_status` first with an empty argument object", skill)
        self.assertIn("never pass the KerSor checkout", skill)

    def test_skill_routes_hf_apxinf_deployment_to_canonical_kersor_skill(self) -> None:
        skill = (
            ROOT / "presets" / "kersor" / "skills" / "kersor" / "SKILL.md"
        ).read_text(encoding="utf-8")
        self.assertIn("pinned Hugging Face to ApxInf deployment Missions", skill)
        self.assertIn("skills/deploy-hf-model-to-apxinf/SKILL.md", skill)
        self.assertIn("Do not route this open repository/service task", skill)

    def make_status_project(self) -> Path:
        """Create a small v2 project whose stores exercise the bridge contract."""
        project = self.root / "project"
        session = project / ".kersor" / "20260817-120000"
        run = session / "run-1"
        run.mkdir(parents=True)
        (session / "session-config.json").write_text(
            json.dumps(
                {
                    "max_workflows": 4,
                    "mode": "auto",
                    "kernel_path": "kernel.cu",
                    "started_at": "2026-08-17T12:00:00+08:00",
                    "allow_workflow_authoring": True,
                    "workflow_authoring_budget": 1,
                    "extensions": {
                        "baseline_witness_required": True,
                        "candidate_ownership_required": True,
                        "fresh_session_required": True,
                    },
                }
            ),
            encoding="utf-8",
        )
        (session / "state.json").write_text(
            json.dumps(
                {
                    "phase": "optimizing",
                    "current_round": 2,
                    "target_speedup": 1.5,
                    "backend": "python",
                    "kernel_language": "python_reference",
                    "integration_pattern": "custom_simulator",
                }
            ),
            encoding="utf-8",
        )
        profile = session / "kernel-profile.md"
        profile.write_text(
            "# Kernel Profile\n\n"
            "## Parseable Fields\n\n"
            "- Kernel Path: kernel.cu\n"
            "- Language: python_reference\n"
            "- Backend: python\n"
            "- Integration Pattern: custom_simulator\n"
            "- Operation Type: vliw\n"
            "- Bottleneck Hypothesis: scalar issue width\n",
            encoding="utf-8",
        )
        handoff_dir = session / "profile-handoff"
        handoff_dir.mkdir()
        context = handoff_dir / "context.json"
        context.write_text(
            json.dumps({"schema_version": 1, "session_dir": str(session.resolve())})
            + "\n",
            encoding="utf-8",
        )

        def digest(path: Path) -> str:
            return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()

        (handoff_dir / "seal.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "session_dir": str(session.resolve()),
                    "owner_role": "kernel-profiler",
                    "producer": {
                        "runtime": "dsh-subagent",
                        "session_id": "profile-child-123",
                    },
                    "context": {
                        "path": "profile-handoff/context.json",
                        "sha256": digest(context),
                    },
                    "profile": {
                        "path": "kernel-profile.md",
                        "sha256": digest(profile),
                    },
                }
            ),
            encoding="utf-8",
        )
        (session / "round-1-selection.json").write_text(
            json.dumps({"selected_workflow": {"name": "baseline"}}),
            encoding="utf-8",
        )
        (session / "round-1-summary.md").write_text(
            "# Round 1\n\nCONTINUE: measure another\nworkflow.\n\n## Evidence\n",
            encoding="utf-8",
        )
        (run / "attempt-result.json").write_text(
            json.dumps({"metric_contract": {"speedup": 1.25}}),
            encoding="utf-8",
        )
        (session / "round-2-selection.json").write_text(
            json.dumps({"selected_workflow": {"name": "adaexplore"}}),
            encoding="utf-8",
        )
        (session / "round-2-fit.json").write_text(
            json.dumps({"fit_confidence": "high"}), encoding="utf-8"
        )
        (session / "run-2").mkdir()
        (session / "run-2" / "dsh-compatibility.json").write_text(
            json.dumps({"schema_version": 1, "verdict": "pass"}),
            encoding="utf-8",
        )
        (session / "run-2" / "candidate-ownership.json").write_text(
            json.dumps({"schema_version": 1, "verdict": "pass"}),
            encoding="utf-8",
        )
        return project

    def test_status_bridge_uses_structured_kersor_stores(self) -> None:
        destination, _, _ = self.run_install()
        project = self.make_status_project()
        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "status",
                "--path",
                str(project),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        value = json.loads(completed.stdout)
        self.assertTrue(value["found"])
        self.assertEqual(value["phase"], "optimizing")
        self.assertEqual(value["workflow"], "adaexplore")
        self.assertEqual(value["best_speedup"], 1.25)
        self.assertEqual(value["target_met"], False)
        self.assertEqual(value["integration_pattern"], "custom_simulator")
        self.assertIs(value["allow_workflow_authoring"], True)
        self.assertEqual(value["workflow_authoring_budget"], 1)
        self.assertEqual(value["baseline_witness"], "pending")
        self.assertEqual(value["baseline_next_action"], "init")
        self.assertIsNone(value["baseline_reason"])
        self.assertEqual(value["profile_evidence"], "pass")
        self.assertIsNone(value["profile_reason"])
        self.assertEqual(
            value["profile_owner"], "kernel-profiler · profile-child-123"
        )
        self.assertEqual(value["dsh_compatibility"], "pass")
        self.assertEqual(value["candidate_ownership"], "pass")
        self.assertEqual(value["fresh_session"], "pass")
        self.assertEqual(value["rounds"][0]["decision"].split(":", 1)[0], "CONTINUE")

    def test_status_bridge_projects_profile_failure_reason(self) -> None:
        destination, _, _ = self.run_install()
        project = self.make_status_project()
        session = project / ".kersor" / "20260817-120000"
        (session / "kernel-profile.md").unlink()
        (session / "run-2" / "profile-gate.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "verdict": "fail",
                    "code": "missing_kernel_profile",
                    "reason": "Phase 2 kernel-profile.md was never produced",
                }
            ),
            encoding="utf-8",
        )
        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "status",
                "--path",
                str(project),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        value = json.loads(completed.stdout)
        self.assertEqual(value["profile_evidence"], "fail")
        self.assertIsNone(value["profile_owner"])
        self.assertEqual(
            value["profile_reason"],
            "Phase 2 kernel-profile.md was never produced",
        )

    def test_status_bridge_rejects_unsealed_fresh_profile(self) -> None:
        destination, _, _ = self.run_install()
        project = self.make_status_project()
        session = project / ".kersor" / "20260817-120000"
        (session / "profile-handoff" / "seal.json").unlink()
        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "status",
                "--path",
                str(project),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        value = json.loads(completed.stdout)
        self.assertEqual(value["profile_evidence"], "fail")
        self.assertEqual(
            value["profile_reason"],
            "profile handoff seal not found for fresh Session",
        )
        self.assertEqual(value["profile_owner"], "unsealed")

    def test_status_bridge_projects_a_fresh_boundary_failure(self) -> None:
        destination, _, _ = self.run_install()
        project = self.make_status_project()
        report = project / ".kersor" / "20260817-120000" / "run-2" / "fresh-session-boundary.json"
        report.write_text(
            json.dumps({"schema_version": 1, "verdict": "fail"}),
            encoding="utf-8",
        )
        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "status",
                "--path",
                str(project),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        value = json.loads(completed.stdout)
        self.assertEqual(value["fresh_session"], "fail")
        self.assertIsNone(value["baseline_next_action"])

    def test_status_bridge_projects_baseline_action_and_failure_reason(self) -> None:
        destination, _, _ = self.run_install()
        project = self.make_status_project()
        session = project / ".kersor" / "20260817-120000"
        method = session / "test-method.md"
        method.write_text(
            "# Test Method\n\n"
            "- Correctness Command: python tests.py correctness\n"
            "- Benchmark Command: python tests.py benchmark\n"
            "- Baseline Status: present\n",
            encoding="utf-8",
        )

        def status() -> dict[str, object]:
            completed = subprocess.run(
                [
                    sys.executable,
                    str(destination / "bin" / "kersor_bridge.py"),
                    "status",
                    "--path",
                    str(project),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            return json.loads(completed.stdout)

        ready = status()
        self.assertEqual(ready["baseline_witness"], "pending")
        self.assertEqual(ready["baseline_next_action"], "record_verify")
        self.assertIsNone(ready["baseline_reason"])

        (session / "run-2" / "baseline-gate.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "verdict": "fail",
                    "reason": "Baseline Status must be present before recording, found unknown",
                }
            ),
            encoding="utf-8",
        )
        failed = status()
        self.assertEqual(failed["baseline_witness"], "fail")
        self.assertEqual(failed["baseline_next_action"], "new_session")
        self.assertEqual(
            failed["baseline_reason"],
            "Baseline Status must be present before recording, found unknown",
        )

    def test_status_bridge_suppresses_pending_baseline_action_after_terminal_stop(self) -> None:
        destination, _, _ = self.run_install()
        project = self.make_status_project()
        state = project / ".kersor" / "20260817-120000" / "state.json"
        payload = json.loads(state.read_text(encoding="utf-8"))
        payload["phase"] = "stalled"
        state.write_text(json.dumps(payload), encoding="utf-8")
        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "status",
                "--path",
                str(project),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        value = json.loads(completed.stdout)
        self.assertEqual(value["phase"], "stalled")
        self.assertEqual(value["baseline_witness"], "pending")
        self.assertIsNone(value["baseline_next_action"])

    def test_sessions_bridge_lists_bounded_recent_store_snapshots(self) -> None:
        destination, _, _ = self.run_install()
        project = self.make_status_project()
        session = project / ".kersor" / "20260817-120000"
        # The inventory is checkout-scoped, matching the installed preset's
        # canonical KerSor root rather than a caller-selected workspace.
        checkout_session = self.kersor / ".kersor" / session.name
        checkout_session.parent.mkdir()
        shutil.copytree(session, checkout_session)
        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "sessions",
                "--limit",
                "1",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        value = json.loads(completed.stdout)
        self.assertEqual(len(value["sessions"]), 1)
        row = value["sessions"][0]
        self.assertEqual(row["session_id"], session.name)
        self.assertEqual(row["storage_kind"], "v2")
        self.assertEqual(row["lifecycle"], "active")
        self.assertEqual(row["health"], "active")
        self.assertEqual(row["status"], "resumable")
        self.assertEqual(row["started_at"], "2026-08-17T12:00:00+08:00")
        self.assertIsNotNone(row["last_activity_at"])
        self.assertEqual(row["best_speedup"], 1.25)
        self.assertEqual(row["kernel_name"], "kernel.cu")
        self.assertEqual(row["kernel_language"], "python_reference")
        self.assertEqual(row["backend"], "python")
        self.assertEqual(row["integration_pattern"], "custom_simulator")
        self.assertIs(row["allow_workflow_authoring"], True)
        self.assertEqual(row["workflow_authoring_budget"], 1)
        self.assertEqual(row["baseline_witness"], "pending")
        self.assertEqual(row["baseline_next_action"], "init")
        self.assertIsNone(row["baseline_reason"])
        self.assertEqual(row["dsh_compatibility"], "pass")
        self.assertEqual(row["candidate_ownership"], "pass")
        self.assertEqual(row["fresh_session"], "pass")
        self.assertEqual(row["selection_status"], "selected")
        self.assertEqual(row["decision"], "CONTINUE: measure another workflow.")
        self.assertNotIn("kernel_path", row)

    def test_sessions_bridge_includes_registered_dsh_workspace(self) -> None:
        destination, _, _ = self.run_install()
        project = self.make_status_project()
        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "sessions",
                "--limit",
                "1",
                "--workspace",
                str(project),
                "--workspace",
                str(project),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        rows = json.loads(completed.stdout)["sessions"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(
            rows[0]["session_dir"],
            str((project / ".kersor" / "20260817-120000").resolve()),
        )
        self.assertEqual(rows[0]["status"], "resumable")

    def test_sessions_bridge_marks_old_continuable_session_needs_resume(self) -> None:
        destination, _, _ = self.run_install()
        project = self.make_status_project()
        source = project / ".kersor" / "20260817-120000"
        session = self.kersor / ".kersor" / source.name
        session.parent.mkdir()
        shutil.copytree(source, session)
        for path in session.rglob("*"):
            if path.is_file():
                os.utime(path, (1, 1))
        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "sessions",
                "--limit",
                "1",
                "--stale-after",
                "1",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        row = json.loads(completed.stdout)["sessions"][0]
        self.assertEqual(row["status"], "resumable")
        self.assertEqual(row["health"], "needs_resume")

    def test_session_detail_withholds_design_until_a_verified_seal(self) -> None:
        destination, _, _ = self.run_install()
        project = self.make_status_project()
        session = project / ".kersor" / "20260817-120000"
        authoring = session / "workflow-authoring"
        staging = authoring / "staging"
        staging.mkdir(parents=True)
        (authoring / "author-context.json").write_text("{}\n", encoding="utf-8")
        files = {
            "workflow.js": "export const meta = {}\nreturn {}\n",
            "metadata.json": json.dumps(
                {
                    "name": "vliw-author",
                    "technique": "instruction_scheduling",
                    "required_args": ["kernel_path"],
                    "languages": ["python_reference"],
                    "backends": ["python"],
                    "integration_patterns": ["custom_simulator"],
                }
            )
            + "\n",
            "rationale.md": "# VLIW author\n\nBundle independent slots.\n",
        }
        for name, content in files.items():
            (staging / name).write_text(content, encoding="utf-8")

        command = [
            sys.executable,
            str(destination / "bin" / "kersor_bridge.py"),
            "session-detail",
            "--session",
            str(session),
        ]
        before = subprocess.run(command, check=False, capture_output=True, text=True)
        self.assertEqual(before.returncode, 0, before.stderr)
        before_value = json.loads(before.stdout)
        self.assertEqual(before_value["authoring"], {"status": "in_progress", "files": []})

        sealed = {
            "schema_version": 1,
            "staging": str(staging.resolve()),
            "files": {
                name: "sha256:" + hashlib.sha256(content.encode()).hexdigest()
                for name, content in files.items()
            },
        }
        (authoring / "author-handoff.json").write_text(json.dumps(sealed), encoding="utf-8")
        after = subprocess.run(command, check=False, capture_output=True, text=True)
        self.assertEqual(after.returncode, 0, after.stderr)
        after_value = json.loads(after.stdout)
        self.assertEqual(after_value["authoring"]["status"], "sealed")
        self.assertEqual(after_value["authoring"]["design"]["name"], "vliw-author")
        self.assertNotIn("methodCategory", after_value["authoring"]["design"])
        self.assertNotIn("topology", after_value["authoring"]["design"])
        self.assertIn("Bundle independent slots", after_value["authoring"]["design"]["rationale"])
        self.assertEqual(after_value["selection"]["status"], "selected")

        (staging / "workflow.js").write_text("tampered\n", encoding="utf-8")
        tampered = subprocess.run(command, check=False, capture_output=True, text=True)
        self.assertEqual(tampered.returncode, 0, tampered.stderr)
        tampered_value = json.loads(tampered.stdout)
        self.assertEqual(tampered_value["authoring"]["status"], "rejected")
        self.assertEqual(tampered_value["authoring"]["omittedReason"], "hash_mismatch")
        self.assertNotIn("design", tampered_value["authoring"])

    @unittest.skipIf(shutil.which("node") is None, "Node.js is required by DSH")
    def test_status_tool_executes_for_the_current_workspace_only(self) -> None:
        project = self.make_status_project()
        poisoned = self.root / "poisoned-path"
        poisoned.mkdir()
        fake_python = poisoned / "python3"
        fake_python.write_text("#!/bin/sh\nexit 97\n", encoding="utf-8")
        fake_python.chmod(0o755)
        plugin = ROOT / "presets" / "kersor" / "plugins" / "kersor-status.mjs"
        script = r'''
import { pathToFileURL } from 'node:url'
const plugin = await import(pathToFileURL(process.env.PLUGIN_PATH).href)
let tool
plugin.apply({ tools: { register(value) { tool = value } } })
const signal = new AbortController().signal
const exec = { signal, agent: { session: { header: { cwd: process.env.WORKSPACE } } } }
const value = await tool.execute({}, exec)
const schemaKeys = Object.keys(tool.output.schema.properties).sort()
const valueKeys = Object.keys(value).sort()
const requiredKeys = [...tool.output.schema.required].sort()
if (JSON.stringify(schemaKeys) !== JSON.stringify(valueKeys)) {
  throw new Error(`status schema/value drift: schema=${schemaKeys} value=${valueKeys}`)
}
if (JSON.stringify(requiredKeys) !== JSON.stringify(valueKeys)) {
  throw new Error(`status required/value drift: required=${requiredKeys} value=${valueKeys}`)
}
const content = tool.output.render({}, value)
const meta = tool.output.presentationMeta({}, value)
const card = tool.presentResult({}, { content, isError: false, meta })
console.log(JSON.stringify({
  name: tool.name,
  description: tool.description,
  parameterProperties: tool.parameters.properties,
  value,
  content,
  meta,
  card,
}))
'''
        environment = dict(os.environ)
        environment.update(
            {
                "KERSOR_ROOT": str(self.kersor),
                "PLUGIN_PATH": str(plugin),
                "WORKSPACE": str(project),
                "KERSOR_PYTHON": sys.executable,
                "PATH": f"{poisoned}{os.pathsep}{environment.get('PATH', '')}",
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
        result = json.loads(completed.stdout)
        self.assertEqual(result["name"], "kersor_status")
        self.assertEqual(result["value"]["started_at"], "2026-08-17T12:00:00+08:00")
        self.assertEqual(result["meta"]["started_at"], "2026-08-17T12:00:00+08:00")
        self.assertEqual(result["meta"]["integration_pattern"], "custom_simulator")
        self.assertIs(result["meta"]["allow_workflow_authoring"], True)
        self.assertEqual(result["meta"]["baseline_witness"], "pending")
        self.assertEqual(result["meta"]["baseline_next_action"], "init")
        self.assertEqual(result["meta"]["profile_evidence"], "pass")
        self.assertIsNone(result["meta"]["profile_reason"])
        self.assertEqual(
            result["meta"]["profile_owner"],
            "kernel-profiler · profile-child-123",
        )
        self.assertEqual(result["meta"]["dsh_compatibility"], "pass")
        self.assertEqual(result["meta"]["candidate_ownership"], "pass")
        self.assertIn("custom_simulator", result["content"][0]["text"])
        self.assertIn("enabled · budget 1", result["content"][0]["text"])
        self.assertIn("| pending | pass | pass |", result["content"][0]["text"])
        self.assertIn("Baseline next action: init", result["content"][0]["text"])
        self.assertIn(
            "Profile owner: kernel-profiler · profile-child-123",
            result["content"][0]["text"],
        )
        self.assertIn("1.25x", result["content"][0]["text"])
        self.assertEqual(result["card"]["title"], "KerSor · optimizing · r2/4 · 1.25x")
        self.assertEqual(result["parameterProperties"], {})
        self.assertIn("empty argument object", result["description"])


if __name__ == "__main__":
    unittest.main()
