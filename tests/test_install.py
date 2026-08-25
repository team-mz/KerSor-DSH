"""Regression tests for the generated DSH preset installation contract."""

from __future__ import annotations

import importlib.util
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("dsh_plugin_install", ROOT / "scripts" / "install.py")
assert SPEC is not None and SPEC.loader is not None
INSTALLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALLER)
BRIDGE_SPEC = importlib.util.spec_from_file_location(
    "dsh_kersor_bridge",
    ROOT / "presets" / "kersor" / "bin" / "kersor_bridge.py",
)
assert BRIDGE_SPEC is not None and BRIDGE_SPEC.loader is not None
BRIDGE = importlib.util.module_from_spec(BRIDGE_SPEC)
BRIDGE_SPEC.loader.exec_module(BRIDGE)


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
        (self.kersor / "scripts" / "profile-handoff.py").write_text(
            "import sys\n"
            "if sys.argv[1] != 'verify': raise SystemExit(2)\n"
            "print('PROFILE_EVIDENCE=pass')\n"
            "print('PROFILE_SOURCE=sealed-kernel-profiler')\n",
            encoding="utf-8",
        )
        (self.kersor / "kersor_core").mkdir()
        (self.kersor / "kersor_core" / "__init__.py").write_text(
            FAKE_KERSOR_CORE, encoding="utf-8"
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_install(
        self,
        *,
        force: bool = False,
        claude_command: Path | None = None,
        claude_model: str | None = None,
    ):
        """Install into the isolated DSH home."""
        return INSTALLER.install(
            dsh_home=self.dsh_home,
            standard_preset=self.standard,
            kersor_root=self.kersor,
            force=force,
            dry_run=False,
            claude_command=claude_command,
            claude_model=claude_model,
        )

    def test_install_renders_delta_and_local_root(self) -> None:
        destination, backup, changed = self.run_install()
        self.assertTrue(changed)
        self.assertIsNone(backup)
        composition = (destination / "agent.cordis.yml").read_text(encoding="utf-8")
        self.assertIn("The `kersor` agent preset", composition)
        self.assertIn(INSTALLER.KERSOR_LINE, composition)
        self.assertIn("name: './plugins/kersor-status.mjs'", composition)
        self.assertIn("name: './plugins/kersor-evolve.mjs'", composition)
        self.assertIn("name: '@deepseek-ai/dsh-kersor/control'", composition)
        self.assertIn("customSkillDirs:", composition)
        self.assertIn(str((destination / "skills").resolve()), composition)
        self.assertNotIn(str(self.kersor), composition)
        self.assertTrue((destination / "plugins" / "kersor-status.mjs").is_file())
        self.assertTrue((destination / "plugins" / "kersor-evolve.mjs").is_file())
        self.assertEqual(
            (destination / ".local" / "kersor-root").read_text(encoding="utf-8"),
            f"{self.kersor.resolve()}\n",
        )
        runtime_tools = json.loads(
            (destination / ".local" / "runtime-tools.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(runtime_tools["schema_version"], 1)
        self.assertEqual(
            runtime_tools["expected_outer_filesystem_policy"],
            "workspace-write",
        )
        self.assertTrue(Path(runtime_tools["tools"]["bash"]).is_absolute())
        self.assertTrue(Path(runtime_tools["tools"]["python3"]).is_absolute())

    def test_runtime_tool_snapshot_freezes_an_absolute_claude_path(self) -> None:
        fake_claude = self.root / "bin" / "claude"
        fake_claude.parent.mkdir()
        fake_claude.write_text("#!/bin/sh\n", encoding="utf-8")
        with mock.patch.object(
            INSTALLER.shutil,
            "which",
            return_value=str(fake_claude),
        ):
            tools = INSTALLER.resolve_runtime_tools()
        self.assertEqual(tools["claude"], str(fake_claude.absolute()))

    def test_runtime_tool_snapshot_uses_the_installer_python(self) -> None:
        tools = INSTALLER.resolve_runtime_tools()
        self.assertEqual(tools["python3"], str(Path(sys.executable).resolve()))

    def test_install_freezes_an_explicit_claude_compatible_route(self) -> None:
        wrapper = self.root / "trusted-bin" / "claude-infini"
        wrapper.parent.mkdir()
        wrapper.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        wrapper.chmod(0o700)

        destination, _, _ = self.run_install(
            claude_command=wrapper,
            claude_model="deepseek-v4-flash",
        )
        manifest = json.loads(
            (destination / ".local" / "runtime-tools.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(manifest["tools"]["claude"], str(wrapper.resolve()))
        self.assertEqual(manifest["models"]["claude"], "deepseek-v4-flash")

        workspace = self.root / "route-workspace"
        workspace.mkdir()
        self.prepare_installed_generic_tools(destination)
        with mock.patch.object(
            BRIDGE,
            "RUNTIME_TOOLS_FILE",
            destination / ".local" / "runtime-tools.json",
        ):
            tools = BRIDGE.trusted_runtime_tools(workspace, "claude")
        environment = BRIDGE.generic_evolve_environment(tools, runtime="claude")
        self.assertEqual(environment["KERSOR_CLAUDE_COMMAND"], str(wrapper.resolve()))
        self.assertEqual(environment["KERSOR_CLAUDE_MODEL"], "deepseek-v4-flash")

    def test_install_rejects_an_invalid_explicit_claude_route(self) -> None:
        missing = self.root / "missing-claude"
        with self.assertRaisesRegex(RuntimeError, "not an executable"):
            self.run_install(
                claude_command=missing,
                claude_model="deepseek-v4-flash",
            )
        with self.assertRaisesRegex(RuntimeError, "without whitespace"):
            self.run_install(claude_model="deepseek v4 flash")

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

    def test_installed_bridge_can_resolve_recorded_checkout_despite_override(self) -> None:
        destination, _, _ = self.run_install()
        environment = dict(os.environ)
        environment["KERSOR_ROOT"] = str(self.root / "untrusted-override")
        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "root",
                "--recorded",
            ],
            check=False,
            capture_output=True,
            text=True,
            env=environment,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout.strip(), str(self.kersor.resolve()))

    def prepare_generic_evolve_checkout(self) -> None:
        """Install deterministic generic runner stubs in the fake checkout."""
        (self.kersor / "config").mkdir(exist_ok=True)
        for name, sandbox in (
            ("runtime-codex.json", "workspace-write"),
            ("runtime-codex-autonomous.json", "read-only"),
            ("runtime-codex-autonomous-write.json", "workspace-write"),
        ):
            (self.kersor / "config" / name).write_text(
                json.dumps({
                    "contract_version": "akw-js-runtime-v1",
                    "budget": {"total_tokens": 4_000_000},
                    "broker": {
                        "type": "codex-exec",
                        "sandbox": sandbox,
                        "approval_policy": "never",
                    },
                }),
                encoding="utf-8",
            )
        (self.kersor / "config" / "runtime-claude-autonomous.json").write_text(
            json.dumps({
                "contract_version": "akw-js-runtime-v1",
                "budget": {"total_tokens": 4_000_000},
                "broker": {
                    "type": "claude-code-exec",
                    "command": "claude",
                    "permission_mode": "dontAsk",
                    "read_only_tools": ["Read", "Glob", "Grep"],
                    "mutation_tools": ["Read", "Glob", "Grep", "Edit", "Write"],
                    "safe_mode": True,
                    "no_session_persistence": True,
                    "preflight": True,
                    "filesystem_sandbox": "required",
                },
            }),
            encoding="utf-8",
        )
        (self.kersor / "config" / "runtime-dsh-autonomous.json").write_text(
            json.dumps({
                "contract_version": "akw-js-runtime-v1",
                "budget": {"total_tokens": 4_000_000},
                "broker": {
                    "type": "dsh-host-rpc",
                    "protocol": "kersor-dsh-host-rpc-v1",
                    "socket_env": "KERSOR_DSH_RPC_SOCKET",
                    "nonce_env": "KERSOR_DSH_RPC_NONCE",
                    "max_frame_bytes": 16 * 1024 * 1024,
                    "provider": "deepseek-official",
                    "model": "kimi-k2.7-code",
                    "timeout_seconds": 900,
                },
            }),
            encoding="utf-8",
        )
        (self.kersor / "scripts" / "create-session.py").write_text(
            "import json, pathlib, sys\n"
            "payload = json.load(sys.stdin)\n"
            "target = pathlib.Path(sys.argv[1])\n"
            "(target / 'session-config.json').write_text(json.dumps(payload['config']))\n"
            "(target / 'state.json').write_text(json.dumps(payload['state']))\n",
            encoding="utf-8",
        )
        (self.kersor / "scripts" / "evolve.sh").write_text(
            "#!/usr/bin/env bash\n"
            "set -euo pipefail\n"
            "contract=$1\n"
            "  printf '%s\\n' \"${KERSOR_ROOT-unset}\" "
            "\"${KERSOR_AUTONOMOUS_RUNNER-unset}\" "
            "\"${KERSOR_NODE_BIN-unset}\" \"${KERSOR_CODEX_COMMAND-unset}\" "
            "\"${KERSOR_CODEX_AUTH_HOME-unset}\" "
            "\"${BASH_ENV-unset}\" \"${PYTHONPATH-unset}\" "
            "\"${NODE_OPTIONS-unset}\" \"${PATH-unset}\" "
            "\"${HOME-unset}\" \"${TMPDIR-unset}\" "
            "\"${KERSOR_CODEX_OUTER_SANDBOX-unset}\" "
            "\"${KERSOR_CLAUDE_COMMAND-unset}\" "
            "\"${KERSOR_CLAUDE_MODEL-unset}\" "
            "\"${KERSOR_CLAUDE_EFFORT-unset}\" "
            "\"${CLAUDECODE-unset}\" "
            "\"${CLAUDE_CONFIG_DIR-unset}\" "
            "\"${ANTHROPIC_MODEL-unset}\" "
            "\"${ANTHROPIC_BASE_URL-unset}\" "
            "> \"${contract}.env\"\n"
            "printf '%s\\n' \"$@\" > \"${contract}.argv\"\n",
            encoding="utf-8",
        )
        (self.kersor / "scripts" / "run-autonomous-workflow.py").write_text(
            "raise SystemExit(0)\n",
            encoding="utf-8",
        )

    def prepare_installed_generic_tools(self, destination: Path) -> None:
        """Keep generic bridge tests independent of a developer Codex install."""
        path = destination / ".local" / "runtime-tools.json"
        manifest = json.loads(path.read_text(encoding="utf-8"))
        for name in ("bash", "python3", "node", "jq", "codex", "claude"):
            manifest["tools"].setdefault(name, sys.executable)
        auth_home = destination / ".local" / "test-codex-auth"
        auth_home.mkdir()
        (auth_home / "auth.json").write_text("{}\n", encoding="utf-8")
        test_home = destination / ".local" / "test-home"
        test_home.mkdir()
        manifest["environment"]["home"] = str(test_home)
        manifest["environment"]["codex_auth_home"] = str(auth_home)
        path.write_text(json.dumps(manifest), encoding="utf-8")

    def generic_mission(self, mission_id: str) -> dict[str, object]:
        """Return a complete minimal Mission header for bridge security tests."""
        return {
            "mission_id": mission_id,
            "goal": f"exercise {mission_id}",
            "authority": [],
            "required_artifacts": [],
            "required_facts": {},
            "max_revisions": 1,
        }

    def candidate_verifier_capabilities(self) -> list[dict[str, object]]:
        """Return one DSH-admissible transactional agent and sealed verifier."""
        return [
            {
                "name": "mutate",
                "side_effect": "write",
                "transaction_artifacts": ["candidate.py"],
                "candidate_verifier": "verify",
            },
            {
                "name": "verify",
                "side_effect": "read",
                "produces_artifacts": ["verification.json"],
                "produces_facts": ["passed"],
                "execution": {
                    "kind": "host_evaluator",
                    "retryable": False,
                    "request": {
                        "protocol": "command-v1",
                        "argv": ["python3", "-m", "unittest"],
                        "filesystem_policy": "read-only",
                        "network_policy": "denied",
                        "output_policy": "sealed",
                        "timeout_seconds": 120,
                        "max_output_bytes": 4_194_304,
                    },
                    "fact_projections": [
                        {"output_name": "passed", "result_path": "passed"},
                        {"output_name": "code", "result_path": "exit_code"},
                        {"output_name": "timeout", "result_path": "timed_out"},
                        {
                            "output_name": "artifacts",
                            "result_path": "artifact_set_sha256",
                        },
                    ],
                },
            },
        ]

    def test_generic_host_evaluator_has_a_sealed_candidate_call_surface(
        self,
    ) -> None:
        capabilities = self.candidate_verifier_capabilities()
        self.assertTrue(BRIDGE.mission_needs_write({"capabilities": capabilities}))
        without_output_limit = json.loads(json.dumps(capabilities))
        without_output_limit[1]["execution"]["request"].pop("max_output_bytes")
        self.assertTrue(
            BRIDGE.mission_needs_write({"capabilities": without_output_limit})
        )
        without_timeout = json.loads(json.dumps(capabilities))
        without_timeout[1]["execution"]["request"].pop("timeout_seconds")
        self.assertTrue(
            BRIDGE.mission_needs_write({"capabilities": without_timeout})
        )

        standalone = json.loads(json.dumps(capabilities))
        standalone[0].pop("candidate_verifier")
        self.assertTrue(BRIDGE.mission_needs_write({"capabilities": standalone}))

        duplicate = json.loads(json.dumps(capabilities))
        duplicate.insert(1, {
            "name": "second_mutator",
            "side_effect": "write",
            "transaction_artifacts": ["other.py"],
            "candidate_verifier": "verify",
        })
        self.assertTrue(BRIDGE.mission_needs_write({"capabilities": duplicate}))

        wrong_kind = json.loads(json.dumps(capabilities))
        wrong_kind[0]["candidate_verifier"] = "another_agent"
        wrong_kind.insert(1, {"name": "another_agent", "side_effect": "read"})
        with self.assertRaisesRegex(RuntimeError, "must reference a Host evaluator"):
            BRIDGE.mission_needs_write({"capabilities": wrong_kind})

    def test_generic_host_evaluator_rejects_unsealed_or_unbounded_requests(
        self,
    ) -> None:
        cases = [
            (("request", "network_policy"), None, "network_policy=denied"),
            (("request", "network_policy"), "allowed", "network_policy=denied"),
            (("request", "output_policy"), None, "output_policy=sealed"),
            (("request", "output_policy"), "raw", "output_policy=sealed"),
            (("request", "timeout_seconds"), 0, "timeout_seconds"),
            (("request", "timeout_seconds"), 121, "timeout_seconds"),
            (("request", "timeout_seconds"), True, "timeout_seconds"),
            (("request", "max_output_bytes"), 0, "max_output_bytes"),
            (("request", "max_output_bytes"), 4_194_305, "max_output_bytes"),
            (("request", "max_output_bytes"), True, "max_output_bytes"),
            (("projection", "result_path"), "stdout_json.passed", "fact_projections"),
            (("projection", "result_path"), "stderr", "fact_projections"),
        ]
        for path_spec, replacement, message in cases:
            with self.subTest(path=path_spec, replacement=replacement):
                capabilities = self.candidate_verifier_capabilities()
                execution = capabilities[1]["execution"]
                assert isinstance(execution, dict)
                if path_spec[0] == "request":
                    request = execution["request"]
                    assert isinstance(request, dict)
                    request[path_spec[1]] = replacement
                else:
                    projections = execution["fact_projections"]
                    assert isinstance(projections, list)
                    projections[0][path_spec[1]] = replacement
                with self.assertRaisesRegex(RuntimeError, message):
                    BRIDGE.mission_needs_write({"capabilities": capabilities})

    def test_outer_sandbox_attestation_is_host_only_and_leaves_no_probes(
        self,
    ) -> None:
        workspace = self.root / "probe-workspace"
        trusted_home = self.root / "probe-home"
        workspace.mkdir()
        trusted_home.mkdir()
        tools = {
            name: sys.executable for name in BRIDGE.GENERIC_TOOL_NAMES
        }
        tools.update({
            "environment_home": str(trusted_home),
            "environment_temp_dir": str(self.root),
            "expected_outer_filesystem_policy": "workspace-write",
            "model_claude": "deepseek-v4-flash",
        })
        probe_glob = f"{BRIDGE.OUTER_SANDBOX_PROBE_PREFIX}*"

        self.assertIsNone(
            BRIDGE.attest_outer_workspace_write(workspace, tools)
        )
        self.assertEqual(list(workspace.glob(probe_glob)), [])
        self.assertEqual(list(trusted_home.glob(probe_glob)), [])

        real_open = BRIDGE.os.open

        def deny_home(path, flags, mode=0o777):
            if Path(path).parent == trusted_home:
                raise PermissionError(1, "denied")
            return real_open(path, flags, mode)

        with mock.patch.object(BRIDGE.os, "open", side_effect=deny_home):
            attested = BRIDGE.attest_outer_workspace_write(workspace, tools)
        self.assertEqual(attested, "workspace-write")
        self.assertEqual(list(workspace.glob(probe_glob)), [])
        self.assertEqual(list(trusted_home.glob(probe_glob)), [])

        def deny_workspace(path, flags, mode=0o777):
            if Path(path).parent == workspace:
                raise PermissionError(1, "denied")
            return real_open(path, flags, mode)

        with mock.patch.object(BRIDGE.os, "open", side_effect=deny_workspace):
            with self.assertRaisesRegex(RuntimeError, "workspace write denied"):
                BRIDGE.attest_outer_workspace_write(workspace, tools)
        self.assertEqual(list(workspace.glob(probe_glob)), [])
        self.assertEqual(list(trusted_home.glob(probe_glob)), [])

        with mock.patch.object(
            BRIDGE.os,
            "write",
            side_effect=OSError("probe write failed"),
        ):
            with self.assertRaisesRegex(RuntimeError, "probe write failed"):
                BRIDGE.attest_outer_workspace_write(workspace, tools)
        self.assertEqual(list(workspace.glob(probe_glob)), [])
        self.assertEqual(list(trusted_home.glob(probe_glob)), [])

        without_installed_policy = dict(tools)
        without_installed_policy.pop("expected_outer_filesystem_policy")
        self.assertIsNone(
            BRIDGE.attest_outer_workspace_write(
                workspace,
                without_installed_policy,
            )
        )
        with mock.patch.dict(
            os.environ,
            {
                BRIDGE.OUTER_SANDBOX_ENV: "danger-full-access",
                "AWS_SECRET_ACCESS_KEY": "ambient-aws-secret",
                "GITHUB_TOKEN": "ambient-github-secret",
                "SSH_AUTH_SOCK": str(workspace / "ambient-ssh.sock"),
                "OPENAI_API_KEY": "ambient-openai-secret",
            },
        ):
            clean = BRIDGE.generic_evolve_environment(tools, runtime="codex")
            asserted = BRIDGE.generic_evolve_environment(
                tools,
                runtime="codex",
                attested_outer_sandbox=attested,
            )
            claude_asserted = BRIDGE.generic_evolve_environment(
                tools,
                runtime="claude",
                attested_outer_sandbox=attested,
            )
        self.assertNotIn(BRIDGE.OUTER_SANDBOX_ENV, clean)
        for forbidden in (
            "AWS_SECRET_ACCESS_KEY",
            "GITHUB_TOKEN",
            "SSH_AUTH_SOCK",
            "OPENAI_API_KEY",
        ):
            self.assertNotIn(forbidden, clean)
            self.assertNotIn(forbidden, asserted)
            self.assertNotIn(forbidden, claude_asserted)
        self.assertEqual(
            asserted[BRIDGE.OUTER_SANDBOX_ENV],
            "workspace-write",
        )
        self.assertNotIn(BRIDGE.OUTER_SANDBOX_ENV, claude_asserted)
        self.assertEqual(
            claude_asserted["KERSOR_CLAUDE_COMMAND"],
            tools["claude"],
        )
        self.assertEqual(
            claude_asserted["KERSOR_CLAUDE_MODEL"],
            "deepseek-v4-flash",
        )
        self.assertNotIn("KERSOR_CODEX_COMMAND", claude_asserted)

    def test_generic_evolve_rejects_a_workspace_owned_recorded_checkout(
        self,
    ) -> None:
        workspace = self.root / "workspace-owned-core"
        workspace.mkdir()
        core = workspace / "KerSor"
        core.mkdir()
        with self.assertRaisesRegex(RuntimeError, "cannot be owned"):
            BRIDGE.require_checkout_outside_workspace(core, workspace)

        trusted_core = self.root / "trusted-core"
        trusted_core.mkdir()
        BRIDGE.require_checkout_outside_workspace(trusted_core, workspace)

    def test_generic_evolve_bootstraps_session_and_forwards_frozen_contract(self) -> None:
        self.prepare_generic_evolve_checkout()
        destination, _, _ = self.run_install()
        self.prepare_installed_generic_tools(destination)
        workspace = self.root / "workspace"
        workspace.mkdir()
        session = workspace / ".kersor-autonomous" / "memo"
        contract = workspace / "mission.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-mission-v1",
                "workspace": str(workspace),
                "session": str(session),
                "runtime": "codex",
                "mission": {
                    "mission_id": "memo",
                    "goal": "write a memo",
                    "authority": ["read workspace"],
                    "required_artifacts": ["memo"],
                    "required_facts": {"done": True},
                    "max_revisions": 2,
                },
                "capabilities": [{
                    "name": "analyze",
                    "side_effect": "read",
                    "required_authorities": ["read workspace"],
                    "produces_artifacts": ["memo"],
                    "produces_facts": ["done"],
                }],
            }),
            encoding="utf-8",
        )
        capture = Path(f"{contract}.argv")
        environment = dict(os.environ)
        environment.pop("KERSOR_ROOT", None)

        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "evolve",
                "--host-execution",
                "--contract",
                str(contract),
            ],
            cwd=workspace,
            check=False,
            capture_output=True,
            text=True,
            env=environment,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(
            capture.read_text(encoding="utf-8").splitlines(),
            [
                str(contract.resolve()),
                "--expected-contract-sha256",
                hashlib.sha256(contract.read_bytes()).hexdigest(),
                "--expected-runtime-config-sha256",
                hashlib.sha256(
                    (
                        self.kersor
                        / "config"
                        / "runtime-codex-autonomous.json"
                    ).read_bytes()
                ).hexdigest(),
            ],
        )
        session_config = json.loads((session / "session-config.json").read_text())
        session_state = json.loads((session / "state.json").read_text())
        self.assertEqual(session_config["input_mode"], "task_dir")
        self.assertEqual(session_config["retrieval_mode"], "off")
        self.assertEqual(session_state["session_id"], "dsh-autonomous-memo")
        self.assertIsNone(session_state["target_speedup"])

    def test_generic_evolve_uses_installed_root_and_sanitized_runtime_chain(self) -> None:
        self.prepare_generic_evolve_checkout()
        destination, _, _ = self.run_install()
        self.prepare_installed_generic_tools(destination)
        workspace = self.root / "workspace"
        workspace.mkdir()
        session = workspace / ".kersor-autonomous" / "sanitized"
        contract = workspace / "mission.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-mission-v1",
                "workspace": str(workspace),
                "session": str(session),
                "runtime": "codex",
                "mission": {
                    "mission_id": "sanitized",
                    "goal": "inspect safely",
                    "authority": ["read workspace"],
                    "required_artifacts": ["report"],
                    "required_facts": {"done": True},
                    "max_revisions": 1,
                },
                "capabilities": [{
                    "name": "inspect",
                    "side_effect": "read",
                    "produces_artifacts": ["report"],
                    "produces_facts": ["done"],
                }],
            }),
            encoding="utf-8",
        )
        injection = self.root / "bash-env.sh"
        marker = self.root / "bash-env-ran"
        injection.write_text(f"touch {marker}\n", encoding="utf-8")
        capture = Path(f"{contract}.argv")
        environment_capture = Path(f"{contract}.env")
        environment = dict(os.environ)
        environment.update({
            "KERSOR_ROOT": str(workspace / "fake-checkout"),
            "KERSOR_AUTONOMOUS_RUNNER": str(workspace / "fake-runner.py"),
            "KERSOR_NODE_BIN": str(workspace / "fake-node"),
            "KERSOR_CODEX_COMMAND": str(workspace / "fake-codex"),
            "KERSOR_CODEX_AUTH_HOME": str(workspace / "fake-codex-home"),
            "KERSOR_CODEX_OUTER_SANDBOX": "danger-full-access",
            "BASH_ENV": str(injection),
            "PYTHONPATH": str(workspace),
            "NODE_OPTIONS": "--require=/tmp/injected.js",
            "HOME": str(workspace),
            "TMPDIR": str(workspace),
        })

        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "evolve",
                "--host-execution",
                "--contract",
                str(contract),
            ],
            cwd=workspace,
            check=False,
            capture_output=True,
            text=True,
            env=environment,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertFalse(marker.exists())
        captured = environment_capture.read_text(encoding="utf-8").splitlines()
        self.assertEqual(captured[0:2], ["unset", "unset"])
        manifest = json.loads(
            (destination / ".local" / "runtime-tools.json").read_text()
        )
        trusted = manifest["tools"]
        self.assertEqual(captured[2], trusted["node"])
        self.assertEqual(captured[3], trusted["codex"])
        self.assertEqual(
            captured[4], manifest["environment"]["codex_auth_home"]
        )
        self.assertEqual(captured[5:8], ["unset", "unset", "unset"])
        self.assertNotIn(str(workspace), captured[8])
        self.assertEqual(captured[9], manifest["environment"]["home"])
        self.assertEqual(captured[10], manifest["environment"]["temp_dir"])
        self.assertEqual(captured[11], "unset")
        self.assertEqual(captured[12:19], ["unset"] * 7)

    def test_generic_claude_read_route_uses_only_the_installed_command(
        self,
    ) -> None:
        self.prepare_generic_evolve_checkout()
        destination, _, _ = self.run_install()
        self.prepare_installed_generic_tools(destination)
        workspace = self.root / "claude-read-workspace"
        workspace.mkdir()
        session = workspace / ".kersor-autonomous" / "claude-read"
        contract = workspace / "mission.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-mission-v1",
                "workspace": str(workspace),
                "session": str(session),
                "runtime": "claude",
                "mission": self.generic_mission("claude-read"),
                "capabilities": [{
                    "name": "inspect",
                    "side_effect": "read",
                }],
            }),
            encoding="utf-8",
        )
        capture = Path(f"{contract}.argv")
        environment_capture = Path(f"{contract}.env")
        environment = dict(os.environ)
        environment.update({
            "KERSOR_CLAUDE_COMMAND": str(workspace / "fake-claude"),
            "KERSOR_CLAUDE_MODEL": "ambient-model",
            "KERSOR_CLAUDE_EFFORT": "low",
            "KERSOR_CODEX_OUTER_SANDBOX": "workspace-write",
            "CLAUDECODE": "outer-controller",
            "CLAUDE_CONFIG_DIR": str(workspace / "fake-claude-home"),
            "ANTHROPIC_MODEL": "ambient-anthropic-model",
            "ANTHROPIC_BASE_URL": "https://ambient.invalid",
        })

        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "evolve",
                "--host-execution",
                "--contract",
                str(contract),
            ],
            cwd=workspace,
            check=False,
            capture_output=True,
            text=True,
            env=environment,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        runtime_config = (
            self.kersor / "config" / "runtime-claude-autonomous.json"
        )
        self.assertEqual(
            capture.read_text(encoding="utf-8").splitlines(),
            [
                str(contract.resolve()),
                "--expected-contract-sha256",
                hashlib.sha256(contract.read_bytes()).hexdigest(),
                "--expected-runtime-config-sha256",
                hashlib.sha256(runtime_config.read_bytes()).hexdigest(),
            ],
        )
        manifest = json.loads(
            (destination / ".local" / "runtime-tools.json").read_text()
        )
        captured = environment_capture.read_text(encoding="utf-8").splitlines()
        self.assertEqual(captured[2], manifest["tools"]["node"])
        self.assertEqual(captured[3:5], ["unset", "unset"])
        self.assertEqual(captured[11], "unset")
        self.assertEqual(captured[12], manifest["tools"]["claude"])
        self.assertEqual(captured[13:19], ["unset"] * 6)
        self.assertTrue(session.is_dir())

    def test_mutating_claude_host_route_does_not_require_outer_proof(self) -> None:
        self.prepare_generic_evolve_checkout()
        destination, _, _ = self.run_install()
        self.prepare_installed_generic_tools(destination)
        workspace = self.root / "claude-write-workspace"
        workspace.mkdir()
        session = workspace / ".kersor-autonomous" / "claude-write"
        contract = workspace / "mission.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-mission-v1",
                "workspace": str(workspace),
                "session": str(session),
                "runtime": "claude",
                "mission": self.generic_mission("claude-write"),
                "capabilities": [{
                    "name": "mutate",
                    "side_effect": "write",
                    "transaction_artifacts": ["answer.py"],
                }],
            }),
            encoding="utf-8",
        )
        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "evolve",
                "--host-execution",
                "--contract",
                str(contract),
            ],
            cwd=workspace,
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue(session.exists())
        manifest = json.loads(
            (destination / ".local" / "runtime-tools.json").read_text()
        )
        probe_glob = f"{BRIDGE.OUTER_SANDBOX_PROBE_PREFIX}*"
        self.assertEqual(list(workspace.glob(probe_glob)), [])
        self.assertEqual(
            list(Path(manifest["environment"]["home"]).glob(probe_glob)),
            [],
        )

    def test_generic_claude_config_is_canonical_and_exactly_restricted(
        self,
    ) -> None:
        self.prepare_generic_evolve_checkout()
        workspace = self.root / "claude-config-workspace"
        workspace.mkdir()
        contract = workspace / "mission.json"
        contract.write_text("{}\n", encoding="utf-8")
        config_path = (
            self.kersor / "config" / "runtime-claude-autonomous.json"
        )
        original = json.loads(config_path.read_text(encoding="utf-8"))

        observed_path, observed_hash = BRIDGE.validate_claude_runtime_config(
            self.kersor,
            contract,
            {},
            needs_write=False,
        )
        self.assertEqual(observed_path, config_path.resolve())
        self.assertEqual(
            observed_hash,
            hashlib.sha256(config_path.read_bytes()).hexdigest(),
        )
        BRIDGE.validate_claude_runtime_config(
            self.kersor,
            contract,
            {},
            needs_write=True,
        )

        variants = [
            (("budget", "total_tokens"), float("inf"), "finite positive"),
            (("broker", "type"), "codex-exec", "claude-code-exec"),
            (("broker", "safe_mode"), False, "safe_mode"),
            (("broker", "permission_mode"), "acceptEdits", "permission_mode"),
            (
                ("broker", "no_session_persistence"),
                False,
                "no_session_persistence",
            ),
            (("broker", "preflight"), False, "preflight"),
            (
                ("broker", "filesystem_sandbox"),
                "best-effort",
                "filesystem_sandbox",
            ),
            (
                ("broker", "read_only_tools"),
                ["Read", "Glob", "Grep", "Bash"],
                "read-only tool allowlist",
            ),
            (
                ("broker", "mutation_tools"),
                ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
                "mutation tool allowlist",
            ),
            (("broker", "extra_args"), ["--verbose"], "cannot add"),
        ]
        try:
            for path, replacement, message in variants:
                with self.subTest(path=path):
                    candidate = json.loads(json.dumps(original))
                    candidate[path[0]][path[1]] = replacement
                    config_path.write_text(json.dumps(candidate), encoding="utf-8")
                    with self.assertRaisesRegex(RuntimeError, message):
                        BRIDGE.validate_claude_runtime_config(
                            self.kersor,
                            contract,
                            {},
                            needs_write=False,
                        )
        finally:
            config_path.write_text(json.dumps(original), encoding="utf-8")

        local_config = workspace / "runtime-claude.json"
        local_config.write_bytes(config_path.read_bytes())
        local_path, local_hash = BRIDGE.validate_claude_runtime_config(
            self.kersor,
            contract,
            {"runtime_config": str(local_config)},
            needs_write=False,
        )
        self.assertEqual(local_path, local_config.resolve())
        self.assertEqual(local_hash, observed_hash)

    def test_generic_dsh_config_accepts_only_a_byte_identical_workspace_copy(
        self,
    ) -> None:
        self.prepare_generic_evolve_checkout()
        workspace = self.root / "dsh-config-workspace"
        workspace.mkdir()
        contract = workspace / "mission.json"
        contract.write_text("{}\n", encoding="utf-8")
        trusted = self.kersor / "config" / "runtime-dsh-autonomous.json"
        local_config = workspace / "runtime-config.json"
        local_config.write_bytes(trusted.read_bytes())

        observed_path, observed_hash = BRIDGE.validate_dsh_runtime_config(
            self.kersor,
            contract,
            {"runtime_config": local_config.name},
        )

        self.assertEqual(observed_path, local_config.resolve())
        self.assertEqual(
            observed_hash,
            hashlib.sha256(trusted.read_bytes()).hexdigest(),
        )
        local_value = json.loads(local_config.read_text(encoding="utf-8"))
        local_value["budget"]["total_tokens"] += 1
        local_config.write_text(json.dumps(local_value), encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "byte-identical"):
            BRIDGE.validate_dsh_runtime_config(
                self.kersor,
                contract,
                {"runtime_config": local_config.name},
            )

    def test_generic_runtime_config_rejects_a_hardlink_to_the_trusted_config(
        self,
    ) -> None:
        self.prepare_generic_evolve_checkout()
        workspace = self.root / "linked-config-workspace"
        workspace.mkdir()
        contract = workspace / "mission.json"
        contract.write_text("{}\n", encoding="utf-8")
        trusted = self.kersor / "config" / "runtime-dsh-autonomous.json"
        linked = workspace / "runtime-config.json"
        os.link(trusted, linked)

        with self.assertRaisesRegex(RuntimeError, "single-link|independent"):
            BRIDGE.validate_dsh_runtime_config(
                self.kersor,
                contract,
                {"runtime_config": linked.name},
            )

    def test_generic_runtime_config_rejects_a_workspace_symlink(self) -> None:
        self.prepare_generic_evolve_checkout()
        workspace = self.root / "symlink-config-workspace"
        workspace.mkdir()
        contract = workspace / "mission.json"
        contract.write_text("{}\n", encoding="utf-8")
        trusted = self.kersor / "config" / "runtime-dsh-autonomous.json"
        independent = self.root / "independent-runtime-config.json"
        independent.write_bytes(trusted.read_bytes())

        for label, target in (("trusted", trusted), ("independent", independent)):
            with self.subTest(label=label):
                linked = workspace / "runtime-config.json"
                linked.symlink_to(target)
                try:
                    with self.assertRaisesRegex(RuntimeError, "cannot read runtime config"):
                        BRIDGE.validate_dsh_runtime_config(
                            self.kersor,
                            contract,
                            {"runtime_config": linked.name},
                        )
                finally:
                    linked.unlink()

    def test_generic_evolve_requires_the_host_rpc_for_dsh_runtime(self) -> None:
        self.prepare_generic_evolve_checkout()
        destination, _, _ = self.run_install()
        self.prepare_installed_generic_tools(destination)
        workspace = self.root / "workspace"
        workspace.mkdir()
        contract = workspace / "mission.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-mission-v1",
                "workspace": str(workspace),
                "session": str(workspace / ".kersor-autonomous" / "unsupported"),
                "runtime": "dsh",
                "mission": self.generic_mission("unsupported"),
                "capabilities": [],
            }),
            encoding="utf-8",
        )
        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "evolve",
                "--host-execution",
                "--contract",
                str(contract),
            ],
            cwd=workspace,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn("requires a Host-owned absolute RPC socket", completed.stderr)
        self.assertFalse((workspace / ".kersor-autonomous").exists())

    def test_generic_evolve_rejects_contract_bytes_changed_after_host_admission(self) -> None:
        destination, _, _ = self.run_install()
        workspace = self.root / "changed-contract-workspace"
        workspace.mkdir()
        contract = workspace / "mission.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-mission-v1",
                "workspace": str(workspace),
                "runtime": "dsh",
            }),
            encoding="utf-8",
        )

        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "evolve",
                "--host-execution",
                "--contract",
                str(contract),
                "--expected-contract-sha256",
                "0" * 64,
                "--expected-runtime",
                "dsh",
            ],
            cwd=workspace,
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 2)
        self.assertIn("contract changed after Host admission", completed.stderr)
        self.assertFalse((workspace / ".kersor-autonomous").exists())

    def test_generic_mission_refuses_the_nested_shell_route(self) -> None:
        destination, _, _ = self.run_install()
        workspace = self.root / "shell-mission-workspace"
        workspace.mkdir()
        contract = workspace / "mission.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-mission-v1",
                "workspace": str(workspace),
                "runtime": "codex",
            }),
            encoding="utf-8",
        )
        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "evolve",
                "--contract",
                str(contract),
            ],
            cwd=workspace,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn("Host-side kersor_evolve tool", completed.stderr)
        self.assertIn("nested shell execution is refused", completed.stderr)

    def test_generic_evolve_rejects_mutation_under_read_only_runtime(self) -> None:
        self.prepare_generic_evolve_checkout()
        destination, _, _ = self.run_install()
        self.prepare_installed_generic_tools(destination)
        workspace = self.root / "workspace"
        workspace.mkdir()
        session = workspace / ".kersor-autonomous" / "write"
        contract = workspace / "mission.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-mission-v1",
                "workspace": str(workspace),
                "session": str(session),
                "runtime": "codex",
                "mission": self.generic_mission("write"),
                "capabilities": [{
                    "name": "mutate",
                    "side_effect": "write",
                    "transaction_artifacts": ["answer.py"],
                }],
            }),
            encoding="utf-8",
        )
        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "evolve",
                "--host-execution",
                "--contract",
                str(contract),
            ],
            cwd=workspace,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn(
            "runtime config must be runtime-codex-autonomous-write.json",
            completed.stderr,
        )
        self.assertFalse(session.exists())

    def test_generic_evolve_rejects_read_only_mission_under_write_runtime(self) -> None:
        self.prepare_generic_evolve_checkout()
        destination, _, _ = self.run_install()
        self.prepare_installed_generic_tools(destination)
        workspace = self.root / "workspace"
        workspace.mkdir()
        session = workspace / ".kersor-autonomous" / "read"
        contract = workspace / "mission.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-mission-v1",
                "workspace": str(workspace),
                "session": str(session),
                "runtime": "codex",
                "runtime_config": str(
                    self.kersor / "config" / "runtime-codex.json"
                ),
                "mission": self.generic_mission("read"),
                "capabilities": [{
                    "name": "inspect",
                    "side_effect": "read",
                    "produces_artifacts": ["report"],
                }],
            }),
            encoding="utf-8",
        )

        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "evolve",
                "--host-execution",
                "--contract",
                str(contract),
            ],
            cwd=workspace,
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 2)
        self.assertIn(
            "runtime config must be runtime-codex-autonomous.json",
            completed.stderr,
        )
        self.assertFalse(session.exists())

    def test_generic_evolve_accepts_byte_identical_workspace_runtime_config(
        self,
    ) -> None:
        self.prepare_generic_evolve_checkout()
        destination, _, _ = self.run_install()
        self.prepare_installed_generic_tools(destination)
        workspace = self.root / "workspace"
        workspace.mkdir()
        local_config = workspace / "runtime.json"
        local_config.write_text(
            (self.kersor / "config" / "runtime-codex-autonomous-write.json")
            .read_text(encoding="utf-8"),
            encoding="utf-8",
        )
        contract = workspace / "mission.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-mission-v1",
                "workspace": str(workspace),
                "session": str(workspace / ".kersor-autonomous" / "local-config"),
                "runtime": "codex",
                "runtime_config": str(local_config),
                "mission": self.generic_mission("local-config"),
                "capabilities": [{
                    "name": "mutate",
                    "side_effect": "write",
                    "transaction_artifacts": ["answer.py"],
                }],
            }),
            encoding="utf-8",
        )

        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "evolve",
                "--host-execution",
                "--contract",
                str(contract),
            ],
            cwd=workspace,
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        argv = (contract.with_suffix(".json.argv")).read_text(encoding="utf-8")
        self.assertIn(hashlib.sha256(local_config.read_bytes()).hexdigest(), argv)
        self.assertEqual(
            json.loads(contract.read_text(encoding="utf-8"))["runtime_config"],
            str(local_config),
        )

    def test_generic_evolve_rejects_unsandboxed_read_only_host_evaluator(self) -> None:
        self.prepare_generic_evolve_checkout()
        destination, _, _ = self.run_install()
        self.prepare_installed_generic_tools(destination)
        workspace = self.root / "workspace"
        workspace.mkdir()
        contract = workspace / "mission.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-mission-v1",
                "workspace": str(workspace),
                "session": str(workspace / ".kersor-autonomous" / "host-read"),
                "runtime": "codex",
                "mission": self.generic_mission("host-read"),
                "capabilities": [{
                    "name": "unsafe_verifier",
                    "side_effect": "read",
                    "execution": {
                        "kind": "host_evaluator",
                        "request": {
                            "protocol": "command-v1",
                            "argv": ["python3", "-c", "open('leak','w').write('x')"],
                        },
                    },
                }],
            }),
            encoding="utf-8",
        )

        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "evolve",
                "--host-execution",
                "--contract",
                str(contract),
            ],
            cwd=workspace,
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 2)
        self.assertIn("require filesystem_policy=read-only", completed.stderr)
        self.assertFalse((workspace / "leak").exists())

    def test_generic_evolve_rejects_host_materialization(self) -> None:
        self.prepare_generic_evolve_checkout()
        destination, _, _ = self.run_install()
        self.prepare_installed_generic_tools(destination)
        workspace = self.root / "workspace"
        workspace.mkdir()
        contract = workspace / "mission.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-mission-v1",
                "workspace": str(workspace),
                "session": str(workspace / ".kersor-autonomous" / "materialize"),
                "runtime": "codex",
                "runtime_config": str(
                    self.kersor / "config" / "runtime-codex-autonomous-write.json"
                ),
                "mission": self.generic_mission("materialize"),
                "capabilities": [
                    {
                        "name": "mutate",
                        "side_effect": "write",
                        "transaction_artifacts": ["answer.py"],
                    },
                    {
                        "name": "unsafe_verifier",
                        "side_effect": "read",
                        "execution": {
                            "kind": "host_evaluator",
                            "request": {
                                "protocol": "command-v1",
                                "filesystem_policy": "read-only",
                                "argv": ["python3", "-m", "unittest"],
                                "materialize": [{"path": "leak", "content": "x"}],
                            },
                        },
                    },
                ],
            }),
            encoding="utf-8",
        )

        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "evolve",
                "--host-execution",
                "--contract",
                str(contract),
            ],
            cwd=workspace,
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 2)
        self.assertIn("cannot materialize", completed.stderr)
        self.assertFalse((workspace / "leak").exists())

    def test_generic_task_rejects_run_dir_outside_workspace(self) -> None:
        self.prepare_generic_evolve_checkout()
        destination, _, _ = self.run_install()
        self.prepare_installed_generic_tools(destination)
        workspace = self.root / "workspace"
        workspace.mkdir()
        contract = workspace / "task.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-task-v1",
                "workspace": str(workspace),
                "runtime": "codex",
                "objective": "repair the ledger",
                "max_rounds": 1,
                "verifier": {"command": ["python3", "-m", "unittest"]},
            }),
            encoding="utf-8",
        )

        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "evolve",
                "--contract",
                str(contract),
                "--run-dir",
                str(self.root / "outside-run"),
            ],
            cwd=workspace,
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 2)
        self.assertIn("Task run-dir must stay inside", completed.stderr)

    def test_generic_task_requires_owned_run_namespace(self) -> None:
        self.prepare_generic_evolve_checkout()
        destination, _, _ = self.run_install()
        self.prepare_installed_generic_tools(destination)
        workspace = self.root / "workspace"
        workspace.mkdir()
        contract = workspace / "task.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-task-v1",
                "workspace": str(workspace),
                "runtime": "codex",
                "objective": "repair the ledger",
                "max_rounds": 1,
                "verifier": {"argv": ["python3", "-m", "unittest"]},
            }),
            encoding="utf-8",
        )

        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "evolve",
                "--contract",
                str(contract),
                "--run-dir",
                str(workspace / "ordinary-directory"),
            ],
            cwd=workspace,
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 2)
        self.assertIn("direct child of workspace/.kersor", completed.stderr)

    def test_generic_host_runs_parent_owned_fixed_task_through_dsh(self) -> None:
        self.prepare_generic_evolve_checkout()
        destination, _, _ = self.run_install()
        self.prepare_installed_generic_tools(destination)
        workspace = self.root / "challenge" / "workspace"
        workspace.mkdir(parents=True)
        contract = workspace.parent / "task.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-task-v1",
                "workspace": "workspace",
                "runtime": "codex",
                "objective": "repair the fixed challenge",
                "max_rounds": 1,
                "native_subagents": 0,
                "verifier": {
                    "argv": ["python3", "../verifier/verify.py"],
                    "cwd": ".",
                    "artifacts": ["solution.py"],
                    "feedback": "status",
                },
            }),
            encoding="utf-8",
        )
        (workspace / "solution.py").write_text("pass\n", encoding="utf-8")

        rpc_dir = self.root / "rpc"
        rpc_dir.mkdir(mode=0o700)
        rpc_path = rpc_dir / "host.sock"
        environment = dict(os.environ)
        environment.update({
            "KERSOR_DSH_RPC_SOCKET": str(rpc_path),
            "KERSOR_DSH_RPC_NONCE": "a" * 64,
        })
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as rpc:
            rpc.bind(str(rpc_path))
            rpc_path.chmod(0o600)
            completed = subprocess.run(
                [
                    sys.executable,
                    str(destination / "bin" / "kersor_bridge.py"),
                    "evolve",
                    "--host-execution",
                    "--contract",
                    str(contract),
                    "--runtime",
                    "dsh",
                    "--expected-runtime",
                    "dsh",
                ],
                cwd=workspace,
                check=False,
                capture_output=True,
                text=True,
                env=environment,
            )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        argv = (contract.with_suffix(".json.argv")).read_text(encoding="utf-8").splitlines()
        self.assertIn("--runtime", argv)
        self.assertEqual(argv[argv.index("--runtime") + 1], "dsh")
        self.assertIn("--expected-runtime-config-sha256", argv)
        environment = (contract.with_suffix(".json.env")).read_text(encoding="utf-8")
        self.assertNotIn("ambient", environment)

    def test_generic_host_rejects_non_dsh_fixed_task(self) -> None:
        self.prepare_generic_evolve_checkout()
        destination, _, _ = self.run_install()
        self.prepare_installed_generic_tools(destination)
        workspace = self.root / "challenge" / "workspace"
        workspace.mkdir(parents=True)
        contract = workspace.parent / "task.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-task-v1",
                "workspace": "workspace",
                "runtime": "codex",
                "objective": "reject product routing through the Host tool",
                "max_rounds": 1,
                "verifier": {
                    "argv": ["python3", "../verifier/verify.py"],
                    "artifacts": ["solution.py"],
                },
            }),
            encoding="utf-8",
        )
        (workspace / "solution.py").write_text("pass\n", encoding="utf-8")

        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "evolve",
                "--host-execution",
                "--contract",
                str(contract),
            ],
            cwd=workspace,
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 2)
        self.assertIn("Host fixed Task execution requires runtime=dsh", completed.stderr)

    def test_generic_session_bootstrap_failure_is_atomic(self) -> None:
        self.prepare_generic_evolve_checkout()
        (self.kersor / "scripts" / "create-session.py").write_text(
            "import pathlib, sys\n"
            "target = pathlib.Path(sys.argv[1])\n"
            "(target / 'session-config.json').write_text('{}')\n"
            "print('creator failed', file=sys.stderr)\n"
            "raise SystemExit(7)\n",
            encoding="utf-8",
        )
        destination, _, _ = self.run_install()
        self.prepare_installed_generic_tools(destination)
        workspace = self.root / "workspace"
        workspace.mkdir()
        session = workspace / ".kersor-autonomous" / "atomic"
        contract = workspace / "mission.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-mission-v1",
                "workspace": str(workspace),
                "session": str(session),
                "runtime": "codex",
                "mission": self.generic_mission("atomic"),
                "capabilities": [{
                    "name": "inspect",
                    "side_effect": "read",
                }],
            }),
            encoding="utf-8",
        )

        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "evolve",
                "--host-execution",
                "--contract",
                str(contract),
            ],
            cwd=workspace,
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 2)
        self.assertIn("cannot create generic Mission Session", completed.stderr)
        self.assertFalse(session.exists())
        self.assertEqual(list(session.parent.glob(".atomic.bootstrap-*")), [])

    def test_generic_core_schema_rejection_precedes_session_publication(self) -> None:
        self.prepare_generic_evolve_checkout()
        (self.kersor / "scripts" / "run-autonomous-workflow.py").write_text(
            "import sys\n"
            "print('deep Mission schema rejected', file=sys.stderr)\n"
            "raise SystemExit(1)\n",
            encoding="utf-8",
        )
        destination, _, _ = self.run_install()
        self.prepare_installed_generic_tools(destination)
        workspace = self.root / "workspace"
        workspace.mkdir()
        session = workspace / ".kersor-autonomous" / "schema"
        contract = workspace / "mission.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-mission-v1",
                "workspace": str(workspace),
                "session": str(session),
                "runtime": "codex",
                "mission": {
                    "mission_id": "schema",
                    "goal": "validate first",
                    "authority": ["read workspace"],
                    "required_artifacts": ["report"],
                    "required_facts": {"done": True},
                    "max_revisions": 1,
                },
                "capabilities": [{
                    "name": "inspect",
                    "side_effect": "read",
                    "produces_artifacts": ["report"],
                    "produces_facts": ["done"],
                }],
            }),
            encoding="utf-8",
        )

        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "evolve",
                "--host-execution",
                "--contract",
                str(contract),
            ],
            cwd=workspace,
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 2)
        self.assertIn("deep Mission schema rejected", completed.stderr)
        self.assertFalse(session.exists())

    def test_generic_evolve_rejects_foreign_existing_session_identity(self) -> None:
        self.prepare_generic_evolve_checkout()
        destination, _, _ = self.run_install()
        self.prepare_installed_generic_tools(destination)
        workspace = self.root / "workspace"
        workspace.mkdir()
        session = workspace / ".kersor-autonomous" / "foreign"
        session.mkdir(parents=True)
        (session / "session-config.json").write_text(
            json.dumps({
                "input_mode": "task_dir",
                "task_dir": str(self.root / "another-workspace"),
                "retrieval_mode": "off",
                "transfer_mode": "off",
                "experience_mode": "off",
                "kernelwiki_experience_export_mode": "off",
            }),
            encoding="utf-8",
        )
        (session / "state.json").write_text(
            json.dumps({
                "session_id": "some-other-session",
                "target_speedup": None,
                "seed_origin": "provided_task",
            }),
            encoding="utf-8",
        )
        contract = workspace / "mission.json"
        contract.write_text(
            json.dumps({
                "contract_version": "kersor-mission-v1",
                "workspace": str(workspace),
                "session": str(session),
                "runtime": "codex",
                "mission": self.generic_mission("foreign"),
                "capabilities": [{
                    "name": "inspect",
                    "side_effect": "read",
                }],
            }),
            encoding="utf-8",
        )

        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "evolve",
                "--host-execution",
                "--contract",
                str(contract),
            ],
            cwd=workspace,
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 2)
        self.assertIn("task_dir does not match", completed.stderr)

    def test_skill_routes_generic_contracts_without_optimization_rewrite(self) -> None:
        skill = (
            ROOT / "presets" / "kersor" / "skills" / "kersor" / "SKILL.md"
        ).read_text(encoding="utf-8")
        self.assertIn("bridge\" evolve --contract <contract-path>", skill)
        self.assertIn("For a frozen `kersor-mission-v1`, call `kersor_evolve`", skill)
        self.assertIn("first and only tool call of the turn", skill)
        self.assertIn("A Mission is deliberately rejected from the Bash", skill)
        self.assertIn("For a frozen `kersor-task-v1` that must run natively in DSH", skill)
        self.assertIn('{"contract":"<absolute-contract-path>","runtime":"dsh"}', skill)
        self.assertIn("canonical parent `task.json`", skill)
        self.assertIn("Never translate a generic contract", skill)
        self.assertIn("never call `kersor_start` for it", skill)
        self.assertIn("the user must not prepare Session JSON by hand", skill)
        self.assertIn("one-file Mission write capabilities", skill)
        self.assertIn("complete transaction artifact set", skill)
        self.assertIn("non-retryable, sealed, read-only `command-v1`", skill)
        self.assertIn("`deepseek-official/kimi-k2.7-code`", skill)
        self.assertIn("outside the workspace", skill)
        self.assertIn("external product-stack route", skill)
        self.assertIn("The Host tool owns the foreground process", skill)
        self.assertIn("matching Host tool or the explicit external-Codex Task bridge route", skill)

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
        self.assertIn("complete canonical\n`setup-session.sh` command", skill)
        self.assertIn("Host's durable transfer/import chain", skill)
        self.assertNotIn("--max-workflows 1", skill)
        self.assertIn("Fresh isolation resolves all four modes to `off`", skill)
        self.assertNotIn("explicit `measured-only` transfer", skill)
        self.assertIn("selection must\nremain `STALLED`", skill)
        self.assertIn("research-only\nworkflow evolution", skill)
        self.assertIn('--store "$SESSION_DIR/workflow-authoring/proposals"', skill)
        self.assertIn("Structural Proposal gates do not make", skill)
        self.assertIn("outer optimize alone installs a winner", skill)
        self.assertIn("transition the Session to `stalled`", skill)
        self.assertIn("prove candidate binding", skill)
        self.assertIn("same Session-local candidate", skill)
        self.assertIn("evaluation_status=pending_host_verification", skill)
        self.assertIn("host-verification.json` with `verdict=pass", skill)
        self.assertIn("invoke `candidate-ownership.py verify` manually", skill)
        self.assertIn("foreground `session-synthesizer` is the sole writer", skill)
        self.assertIn("Only\n`normalize-transfer.py` may atomically advance", skill)
        self.assertIn("Never\ncall `kersor-state.sh ... set current_round ...`", skill)
        self.assertIn("exact foreground author", skill)
        self.assertIn("`author-context.json.dispatch`", skill)
        self.assertIn("without model copying", skill)
        self.assertIn("call `list_agents` or a job tool", skill)
        self.assertIn('kersor_author_commit({"action":"seal"})', skill)
        self.assertIn('kersor_author_commit({"action":"save"})', skill)
        self.assertIn('kersor_protocol({"action":"author"})', skill)
        self.assertIn(
            "Proposal persistence remains Session-local at\n"
            "`workflow-authoring/proposals`",
            skill,
        )
        self.assertIn("whole handoff receipt to remain unchanged", skill)
        self.assertIn("same typed action rebuilds and\nverifies `workflow-catalog.json`", skill)
        self.assertIn("Do not invoke\n`generate-catalog.sh`", skill)
        self.assertIn("not permission to re-seal, retry, or\noverwrite a Proposal", skill)
        self.assertIn("must never repair them", skill)
        self.assertIn("extra staging file or directory is\nmixed provenance", skill)
        self.assertIn("means `needs_revision` plus canonical `stalled`", skill)
        self.assertIn("Do not accept a prose-only baseline", skill)
        self.assertIn("`baseline-witness.py init`, then `record`, then", skill)
        self.assertIn("controller prompt's literal", skill)
        self.assertIn("canonical bridge/root expression", skill)
        self.assertIn("Each\ncall is exact-once", skill)
        self.assertIn("never abbreviate these commands", skill)
        self.assertIn("Output produced before Session creation", skill)
        self.assertIn("Never parse `session-config.json` directly", skill)
        self.assertIn('kersor_protocol({"action":"profile"})', skill)
        self.assertLess(
            skill.index("Do not accept a prose-only baseline"),
            skill.index('kersor_protocol({"action":"profile"})'),
        )
        self.assertIn("without a model-visible\nline projection", skill)
        self.assertIn("exactly one\nforeground DSH child", skill)
        self.assertIn("must not read or copy the\nlong prompt", skill)
        self.assertNotIn('"action":"profile_context"', skill)
        self.assertNotIn('"action":"profile_seal"', skill)
        self.assertNotIn('"action":"profile_verify"', skill)
        self.assertNotIn('producer_session_id', skill)
        self.assertIn('kersor_protocol({"action":"select_workflow"})', skill)
        self.assertIn("owns filtering, the\nCore-authored selection handoff", skill)
        self.assertIn("Never call `subagent` for selection", skill)
        self.assertIn("`round-N-routing-decision.json`", skill)
        self.assertIn("repeating an\nunchanged Catalog is consumed and rejected", skill)
        self.assertIn("Selection and author context both\nre-verify the Profile boundary", skill)
        self.assertNotIn(
            'python3 "$kersor_root/scripts/profile-handoff.py"', skill
        )
        self.assertNotIn(
            'python3 "$kersor_root/scripts/baseline-witness.py"', skill
        )
        self.assertNotIn(
            '"${KERSOR_PYTHON:-python3}" '
            '"$kersor_root/scripts/profile-handoff.py"',
            skill,
        )
        self.assertIn("`KERSOR_PYTHON='<absolute path>'; export KERSOR_PYTHON;`", skill)
        self.assertIn("The Host has already frozen and exported", skill)
        self.assertIn("do not export, echo, inspect, list, or resolve", skill)
        self.assertIn("never\ncall `env`, `which`, PATH search", skill)
        self.assertIn("three exact Host-frozen DSH commands", skill)
        self.assertNotIn('--python-interpreter "$kersor_python"', skill)
        self.assertIn(
            "must invoke an existing task-owned authoritative harness directly",
            skill,
        )
        self.assertIn(
            "A non-zero benchmark is admissible only when\nit produced non-empty "
            "stdout execution evidence",
            skill,
        )
        self.assertNotIn(
            'bash "$kersor_root/scripts/run-kersor-python.sh" '
            'author-workflow-context.py',
            skill,
        )
        self.assertIn("Never invoke the wrapper", skill)
        self.assertIn(
            "After any successful `kersor_start`, `kersor_attach`, or "
            "`kersor_resume` call,\nend the parent turn immediately.",
            skill,
        )
        self.assertIn(
            "must not call `kersor_status`,\n`list_agents`, subagent, job, "
            "Workflow, Bash, Read, or Glob",
            skill,
        )
        self.assertIn(
            "After `kersor_status` reports `complete`, `single_run`, `stalled`, or\n"
            "`cancelled`, stop the controller turn immediately.",
            skill,
        )
        self.assertIn("or any other tool after that status", skill)
        self.assertIn("complete canonical\n`setup-session.sh` command", skill)
        self.assertIn("Never call setup from\n`commands/`", skill)
        self.assertIn('kersor-state.sh" "$SESSION_DIR" get fresh_session_required', skill)
        self.assertIn('get kernelwiki_experience_export_mode', skill)
        self.assertIn("scripts/prepare-dsh-workflow.mjs", skill)
        self.assertIn('--out "$RUN_DIR/dsh-workflow.json"', skill)
        self.assertIn('--report "$RUN_DIR/dsh-compatibility.json"', skill)
        self.assertIn("Call `kersor_workflow` exactly once", skill)
        self.assertIn('`{"exp_dir":"<exact absolute RUN_DIR>"}`', skill)
        self.assertIn("Never call raw `workflow`", skill)
        self.assertIn("exact Host-frozen DSH seal command", skill)
        self.assertIn("invoke `candidate-ownership.py verify` manually", skill)
        self.assertIn("`glob`/`grep`/`read` tools", skill)
        self.assertIn("exclusively writes\n`candidate-ownership.json`", skill)
        self.assertIn("publishes no\n`output.json`", skill)
        self.assertIn('check-runtime-budget.sh"', skill)
        self.assertIn('mark-dispatch-start.sh" "$RUN_DIR"', skill)
        self.assertIn("canonical distinction between a\nprepared run", skill)
        self.assertIn("Before any raw result is returned", skill)
        self.assertIn("Never pass `scriptPath`", skill)
        self.assertIn("not rewrite the author-owned script, retry dispatch, or optimize directly", skill)
        self.assertIn("immutable oracles", skill)
        self.assertIn("`kersor_status` first with an empty argument object", skill)
        self.assertIn("never pass the KerSor checkout", skill)

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
            json.dumps(
                {
                    "outcome": {"compiled": True, "correct": True},
                    "metric_contract": {"speedup": 1.25, "valid": True},
                    "optimization": {"best_improved": True},
                }
            ),
            encoding="utf-8",
        )
        (run / "host-verification.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "gate": "authored_candidate_host_review_v1",
                    "verdict": "pass",
                    "correctness": {"exit_code": 0},
                    "benchmark": {"exit_code": 0},
                    "candidate": {"id": "fresh29-r1"},
                    "metric": {
                        "name": "cycles",
                        "baseline_cycles": 125,
                        "candidate_cycles": 100,
                        "speedup": 1.25,
                    },
                    "workflow_estimate": {"cycles": 105, "speedup": 1.19},
                }
            ),
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

    def make_mission_status_project(
        self,
        *,
        run_id: str = "20260824T002911Z-autonomous-mission",
        status: str = "completed",
        created_at: str = "2026-08-24T00:29:11+00:00",
        project_name: str = "mission-project",
    ) -> tuple[Path, Path, Path]:
        """Create one bound generic Mission run for public bridge tests."""
        project = self.root / project_name
        session = project / ".kersor-autonomous" / "route-probe"
        session.mkdir(parents=True)
        config = {
            "schema_version": 2,
            "input_mode": "task_dir",
            "task_dir": str(project.resolve()),
            "max_workflows": 3,
            "mode": "auto",
            "allow_workflow_authoring": False,
            "workflow_authoring_budget": 0,
        }
        state = {
            "schema_version": 2,
            "session_id": "dsh-autonomous-route-probe",
            "phase": "optimizing",
            "current_round": 1,
            "target_speedup": None,
            "seed_origin": "dsh_generic_mission",
        }

        def canonical(value: object) -> bytes:
            return (
                json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True)
                + "\n"
            ).encode("utf-8")

        (session / "session-config.json").write_bytes(canonical(config))
        (session / "state.json").write_bytes(canonical(state))
        run = self.add_mission_status_run(
            session,
            run_id=run_id,
            status=status,
            created_at=created_at,
        )
        return project, session, run

    def add_mission_status_run(
        self,
        session: Path,
        *,
        run_id: str,
        status: str,
        created_at: str,
    ) -> Path:
        """Append one realistic autonomous run to a Mission Session fixture."""
        runtime = session / "autonomous-runs" / run_id / ".runtime"
        runtime.mkdir(parents=True)
        config = json.loads((session / "session-config.json").read_text())
        state = json.loads((session / "state.json").read_text())

        def canonical(value: object) -> bytes:
            return (
                json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True)
                + "\n"
            ).encode("utf-8")

        run = runtime.parent
        binding = {
            "schema_version": 1,
            "run_id": run_id,
            "created_at": created_at,
            "session_dir": str(session.resolve()),
            "session_id": state["session_id"],
            "session_config_sha256": hashlib.sha256(canonical(config)).hexdigest(),
            "session_state_sha256": hashlib.sha256(canonical(state)).hexdigest(),
        }
        (run / "binding.json").write_bytes(canonical(binding))
        (run / "result.json").write_bytes(
            canonical({"status": status, "binding": binding})
        )
        (runtime / "summary.json").write_bytes(
            canonical(
                {
                    "contract_version": "akw-js-runtime-v1",
                    "status": "completed",
                    "workflow_status": status,
                }
            )
        )
        verifier = self.kersor / "scripts" / "verify-autonomous-run.py"
        verifier.write_text(
            "import argparse, hashlib, json\n"
            "from pathlib import Path\n"
            "parser = argparse.ArgumentParser()\n"
            "parser.add_argument('--run-dir', type=Path, required=True)\n"
            "args = parser.parse_args()\n"
            "result = json.loads((args.run_dir / 'result.json').read_text())\n"
            "binding = json.loads((args.run_dir / 'binding.json').read_text())\n"
            "passed = result.get('binding') == binding\n"
            "print(json.dumps({'schema_version': 1, 'run_dir': str(args.run_dir.resolve()), "
            "'passed': passed, 'status': result.get('status'), 'result_sha256': "
            "hashlib.sha256((args.run_dir / 'result.json').read_bytes()).hexdigest()}))\n"
            "raise SystemExit(0 if passed else 1)\n",
            encoding="utf-8",
        )
        return run

    def rebind_mission_status_run(self, session: Path, run_name: str) -> Path:
        """Keep a moved Mission fixture valid so path provenance is the only failure."""
        run = session / "autonomous-runs" / run_name
        binding_path = run / "binding.json"
        binding = json.loads(binding_path.read_text())
        binding["session_dir"] = str(session.resolve())
        binding_path.write_text(json.dumps(binding), encoding="utf-8")
        result_path = run / "result.json"
        result = json.loads(result_path.read_text())
        result["binding"] = binding
        result_path.write_text(json.dumps(result), encoding="utf-8")
        return run

    def test_completed_generic_mission_projects_terminal_status_without_mutation(
        self,
    ) -> None:
        project, session, run = self.make_mission_status_project()
        state_path = session / "state.json"
        frozen_state = state_path.read_bytes()
        destination, _, _ = self.run_install()

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
        self.assertEqual(value["session_dir"], str(session.resolve()))
        self.assertEqual(value["session_phase"], "optimizing")
        self.assertEqual(value["phase"], "complete")
        self.assertEqual(value["autonomous_run_id"], run.name)
        self.assertEqual(value["autonomous_status"], "completed")
        self.assertEqual(value["steps"], [])

        listed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "sessions",
                "--no-checkout-root",
                "--workspace",
                str(project),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(listed.returncode, 0, listed.stderr)
        rows = json.loads(listed.stdout)["sessions"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["phase"], "complete")
        self.assertEqual(rows[0]["session_phase"], "optimizing")
        self.assertEqual(rows[0]["autonomous_run_id"], run.name)
        self.assertEqual(rows[0]["autonomous_status"], "completed")
        self.assertEqual(rows[0]["lifecycle"], "completed")
        self.assertEqual(rows[0]["status"], "terminal-complete")
        self.assertEqual(rows[0]["health"], "terminal")
        self.assertEqual(state_path.read_bytes(), frozen_state)

    def test_generic_mission_status_selects_the_newest_bound_run(self) -> None:
        project, session, _ = self.make_mission_status_project()
        latest = self.add_mission_status_run(
            session,
            run_id="20260824T003011Z-autonomous-mission",
            status="failed",
            created_at="2026-08-24T00:30:11+00:00",
        )
        destination, _, _ = self.run_install()

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
        self.assertEqual(value["autonomous_run_id"], latest.name)
        self.assertEqual(value["autonomous_status"], "failed")
        self.assertEqual(value["phase"], "stalled")

    def test_generic_mission_status_excludes_a_malformed_latest_result(self) -> None:
        project, session, _ = self.make_mission_status_project()
        latest = self.add_mission_status_run(
            session,
            run_id="20260824T003111Z-autonomous-mission",
            status="completed",
            created_at="2026-08-24T00:31:11+00:00",
        )
        (latest / "result.json").write_text("{", encoding="utf-8")
        destination, _, _ = self.run_install()

        direct = subprocess.run(
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
        self.assertEqual(direct.returncode, 0, direct.stderr)
        direct_value = json.loads(direct.stdout)
        self.assertFalse(direct_value["found"])
        self.assertTrue(direct_value["warnings"])

        listed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "sessions",
                "--no-checkout-root",
                "--workspace",
                str(project),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(listed.returncode, 0, listed.stderr)
        listed_value = json.loads(listed.stdout)
        self.assertEqual(listed_value["sessions"], [])
        self.assertEqual(
            listed_value["warnings"],
            ["Mission autonomous status unavailable"],
        )

    def test_generic_mission_status_rejects_symlinked_terminal_evidence(self) -> None:
        project, _, run = self.make_mission_status_project()
        result_path = run / "result.json"
        external = self.root / "forged-result.json"
        external.write_bytes(result_path.read_bytes())
        result_path.unlink()
        result_path.symlink_to(external)
        destination, _, _ = self.run_install()

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
        self.assertFalse(value["found"])
        self.assertEqual(value["phase"], None)
        self.assertTrue(
            any("Mission autonomous status unavailable" in item for item in value["warnings"])
        )

    def test_generic_mission_status_rejects_an_ambiguous_latest_run(self) -> None:
        project, session, _ = self.make_mission_status_project()
        self.add_mission_status_run(
            session,
            run_id="same-time-autonomous-mission",
            status="completed",
            created_at="2026-08-24T00:29:11+00:00",
        )
        destination, _, _ = self.run_install()

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
        self.assertFalse(value["found"])
        self.assertTrue(any("ambiguous" in item for item in value["warnings"]))

    def test_waiting_generic_mission_projects_a_resumable_invocation(self) -> None:
        project, _, run = self.make_mission_status_project(status="waiting")
        destination, _, _ = self.run_install()

        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "sessions",
                "--no-checkout-root",
                "--workspace",
                str(project),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        row = json.loads(completed.stdout)["sessions"][0]
        self.assertEqual(row["session_phase"], "optimizing")
        self.assertEqual(row["phase"], "optimizing")
        self.assertEqual(row["autonomous_run_id"], run.name)
        self.assertEqual(row["autonomous_status"], "waiting")
        self.assertEqual(row["lifecycle"], "active")
        self.assertEqual(row["status"], "resumable")
        self.assertEqual(row["health"], "needs_resume")

    def test_generic_mission_status_requires_a_canonical_runtime_summary(self) -> None:
        mutations = {
            "contract": {"contract_version": "forged-v1"},
            "host_status": {"status": "error"},
            "workflow_status": {"workflow_status": "failed"},
        }
        for label, mutation in mutations.items():
            with self.subTest(label=label):
                project, _, run = self.make_mission_status_project(
                    project_name=f"mission-summary-{label}"
                )
                summary_path = run / ".runtime" / "summary.json"
                summary = json.loads(summary_path.read_text())
                summary.update(mutation)
                summary_path.write_text(json.dumps(summary), encoding="utf-8")
                destination, _, _ = self.run_install()

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
                self.assertFalse(json.loads(completed.stdout)["found"])

    def test_generic_mission_status_rejects_duplicate_evidence_keys(self) -> None:
        cases = {
            "config": ("session-config.json", "mode", "auto"),
            "state": ("state.json", "phase", "optimizing"),
            "binding": ("binding.json", "run_id", None),
            "result": ("result.json", "status", "completed"),
            "summary": (".runtime/summary.json", "status", "completed"),
        }
        for label, (relative, field, configured_value) in cases.items():
            with self.subTest(label=label):
                project, session, run = self.make_mission_status_project(
                    project_name=f"mission-duplicate-{label}"
                )
                base = session if label in {"config", "state"} else run
                path = base / relative
                value = run.name if configured_value is None else configured_value
                source = path.read_text(encoding="utf-8").lstrip()
                path.write_text(
                    "{\n"
                    + json.dumps(field)
                    + ": "
                    + json.dumps(value)
                    + ","
                    + source[1:],
                    encoding="utf-8",
                )
                if label in {"config", "state"}:
                    binding_path = run / "binding.json"
                    binding = json.loads(binding_path.read_text())
                    hash_field = (
                        "session_config_sha256"
                        if label == "config"
                        else "session_state_sha256"
                    )
                    binding[hash_field] = hashlib.sha256(path.read_bytes()).hexdigest()
                    binding_path.write_text(json.dumps(binding), encoding="utf-8")
                    result_path = run / "result.json"
                    result = json.loads(result_path.read_text())
                    result["binding"] = binding
                    result_path.write_text(json.dumps(result), encoding="utf-8")
                destination, _, _ = self.run_install()

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
                self.assertFalse(json.loads(completed.stdout)["found"])

    def test_generic_mission_status_rejects_a_symlinked_session_candidate(self) -> None:
        project, session, run = self.make_mission_status_project()
        physical = project / "session-target"
        session.rename(physical)
        session.symlink_to(physical, target_is_directory=True)
        self.rebind_mission_status_run(session, run.name)
        destination, _, _ = self.run_install()

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
        self.assertFalse(json.loads(completed.stdout)["found"])

    def test_generic_mission_direct_status_rejects_a_symlinked_session(self) -> None:
        project, session, run = self.make_mission_status_project()
        physical = project / "direct-session-target"
        session.rename(physical)
        session.symlink_to(physical, target_is_directory=True)
        self.rebind_mission_status_run(session, run.name)
        destination, _, _ = self.run_install()

        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "status",
                "--path",
                str(session),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertFalse(json.loads(completed.stdout)["found"])

    def test_generic_mission_sessions_preserves_symlink_provenance(self) -> None:
        fixtures: list[Path] = []
        project, session, run = self.make_mission_status_project(
            project_name="mission-sessions-candidate-link"
        )
        physical_session = project / "session-target"
        session.rename(physical_session)
        session.symlink_to(physical_session, target_is_directory=True)
        self.rebind_mission_status_run(session, run.name)
        fixtures.append(project)

        project, session, run = self.make_mission_status_project(
            project_name="mission-sessions-root-link"
        )
        sessions_root = project / ".kersor-autonomous"
        physical_root = project / "sessions-root-target"
        sessions_root.rename(physical_root)
        sessions_root.symlink_to(physical_root, target_is_directory=True)
        self.rebind_mission_status_run(session, run.name)
        fixtures.append(project)
        destination, _, _ = self.run_install()

        for project in fixtures:
            with self.subTest(project=project.name):
                completed = subprocess.run(
                    [
                        sys.executable,
                        str(destination / "bin" / "kersor_bridge.py"),
                        "sessions",
                        "--no-checkout-root",
                        "--workspace",
                        str(project),
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
                value = json.loads(completed.stdout)
                self.assertEqual(value["sessions"], [])
                self.assertEqual(
                    value["warnings"], ["Mission autonomous status unavailable"]
                )

    def test_generic_mission_status_rejects_a_symlinked_runtime_directory(self) -> None:
        project, _, run = self.make_mission_status_project()
        runtime = run / ".runtime"
        physical = project / "runtime-target"
        runtime.rename(physical)
        runtime.symlink_to(physical, target_is_directory=True)
        destination, _, _ = self.run_install()

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
        self.assertFalse(json.loads(completed.stdout)["found"])

    def test_classic_status_still_accepts_a_symlinked_session_candidate(self) -> None:
        project = self.make_status_project()
        session = project / ".kersor" / "20260817-120000"
        physical = project / "classic-session-target"
        session.rename(physical)
        session.symlink_to(physical, target_is_directory=True)
        destination, _, _ = self.run_install()

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
        self.assertEqual(value["session_dir"], str(physical.resolve()))
        self.assertEqual(value["phase"], "optimizing")

    def make_dispatch_design(self, project: Path) -> dict[str, object]:
        """Create one internally hash-bound prepared DSH Workflow projection."""
        session = project / ".kersor" / "20260817-120000"
        run = session / "run-2"
        workflow = self.kersor / "workflows" / "adaexplore" / "workflow.js"
        workflow.parent.mkdir(parents=True, exist_ok=True)
        description = "Inspect one prepared stock Workflow."
        when_to_use = "Use when the selected workflow is ready for DSH dispatch."
        workflow_source = (
            "export const meta = {\n"
            "  name: 'adaexplore',\n"
            f"  description: {description!r},\n"
            f"  whenToUse: {when_to_use!r},\n"
            "  phases: [{ title: 'Inspect', detail: 'Read the current kernel.' }],\n"
            "}\n"
            "phase('Inspect')\n"
            "return { ok: true }\n"
        )
        body = "phase('Inspect')\nreturn { ok: true }"
        args = {"kernel_path": "kernel.cu", "target_speedup": 1.5}
        workflow.write_text(workflow_source, encoding="utf-8")
        args_path = run / "dispatch-args.json"
        args_path.write_text(json.dumps(args, indent=2) + "\n", encoding="utf-8")

        def digest(value: str) -> str:
            return hashlib.sha256(value.encode("utf-8")).hexdigest()

        workflow_hash = digest(workflow_source)
        args_hash = digest(
            json.dumps(args, ensure_ascii=False, separators=(",", ":"))
        )
        body_hash = digest(body)
        envelope = {
            "schema_version": 1,
            "contract": "dsh_workflow_v1",
            "source": {
                "workflow_path": str(workflow.resolve()),
                "workflow_sha256": workflow_hash,
                "args_path": str(args_path.resolve()),
                "args_sha256": args_hash,
                "body_sha256": body_hash,
            },
            "meta": {
                "name": "adaexplore",
                "description": description,
                "whenToUse": when_to_use,
                "phases": [
                    {"title": "Inspect", "detail": "Read the current kernel."}
                ],
            },
            "script": body,
            "args": args,
        }
        compatibility = {
            "schema_version": 1,
            "gate": "dsh_workflow_v1",
            "verdict": "pass",
            "workflow_source": str(workflow.resolve()),
            "workflow_sha256": workflow_hash,
            "args_source": str(args_path.resolve()),
            "args_sha256": args_hash,
            "body_sha256": body_hash,
            "errors": [],
        }
        catalog = {
            "name": "adaexplore",
            "directory": "adaexplore",
            "js_path": str(workflow.resolve()),
            "description": description,
            "when_to_use": when_to_use,
            "topology": "pipeline",
            "method_category": "analysis",
            "workflow_content_hash": f"sha256:{workflow_hash}",
            "languages": ["python_reference"],
            "backends": ["python"],
            "integration_patterns": ["custom_simulator"],
            "required_args": ["kernel_path"],
        }
        envelope_path = run / "dsh-workflow.json"
        compatibility_path = run / "dsh-compatibility.json"
        catalog_path = run / "catalog-entry.json"
        envelope_path.write_text(json.dumps(envelope), encoding="utf-8")
        compatibility_path.write_text(json.dumps(compatibility), encoding="utf-8")
        catalog_path.write_text(json.dumps(catalog), encoding="utf-8")
        return {
            "session": session,
            "workflow_path": workflow,
            "envelope_path": envelope_path,
            "compatibility_path": compatibility_path,
            "catalog_path": catalog_path,
            "description": description,
            "when_to_use": when_to_use,
            "body": body,
        }

    def use_sealed_session_catalog(
        self,
        fixture: dict[str, object],
        entries: list[dict[str, object]] | None = None,
    ) -> tuple[Path, Path]:
        """Replace the legacy per-run catalog projection with the sealed SSOT."""
        session = fixture["session"]
        legacy_path = fixture["catalog_path"]
        self.assertIsInstance(session, Path)
        self.assertIsInstance(legacy_path, Path)
        catalog_entry = json.loads(legacy_path.read_text(encoding="utf-8"))
        catalog_path = session / "workflow-catalog.json"
        catalog_text = json.dumps(
            {"workflows": entries if entries is not None else [catalog_entry]},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        catalog_path.write_text(catalog_text, encoding="utf-8")
        run = session / "run-2"
        seal_path = run / "candidate-ownership-seal.json"
        seal_path.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "contract": "candidate_output_ownership_v1",
                    "session_dir": str(session.resolve()),
                    "run_dir": str(run.resolve()),
                    "dispatch_package": {
                        "catalog": hashlib.sha256(
                            catalog_text.encode("utf-8")
                        ).hexdigest()
                    },
                }
            ),
            encoding="utf-8",
        )
        legacy_path.unlink()
        return catalog_path, seal_path

    def read_session_detail(self, destination: Path, session: Path) -> dict[str, object]:
        """Read one installed bridge session-detail answer."""
        completed = subprocess.run(
            [
                sys.executable,
                str(destination / "bin" / "kersor_bridge.py"),
                "session-detail",
                "--session",
                str(session),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        value = json.loads(completed.stdout)
        self.assertIsInstance(value, dict)
        return value

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
        self.assertEqual(
            [step["id"] for step in value["steps"]],
            [
                "setup", "baseline", "profile", "selection", "authoring",
                "validation", "dispatch", "measurement", "decision",
            ],
        )
        self.assertEqual(value["rounds"][0]["decision"].split(":", 1)[0], "CONTINUE")

    def test_status_bridge_excludes_incorrect_estimates_from_historical_best(self) -> None:
        """Fresh24-style estimates cannot outrank a Fresh29-style Host result."""
        destination, _, _ = self.run_install()
        project = self.make_status_project()
        session = project / ".kersor" / "20260817-120000"
        run = session / "run-2"
        (run / "attempt-result.json").write_text(
            json.dumps(
                {
                    "outcome": {
                        "compiled": True,
                        "correct": False,
                        "failure_class": "correctness_mismatch",
                    },
                    "metric_contract": {
                        "speedup": 17.924532880368844,
                        "valid": True,
                    },
                    "optimization": {"best_improved": None},
                }
            ),
            encoding="utf-8",
        )
        (run / "host-verification.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "gate": "authored_candidate_host_review_v1",
                    "verdict": "fail",
                    "reason": "candidate correctness command failed",
                }
            ),
            encoding="utf-8",
        )
        (session / "round-2-summary.md").write_text(
            "# Round 2\n\nSTALLED: candidate correctness failed.\n",
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
        self.assertEqual(value["best_speedup"], 1.25)
        self.assertIs(value["target_met"], False)
        failed_round = next(row for row in value["rounds"] if row["round"] == 2)
        self.assertIsNone(failed_round["speedup"])

    def test_fresh29_wire_projects_terminal_lineage_and_round_history(self) -> None:
        (self.kersor / "scripts" / "baseline-witness.py").write_text(
            "import sys\n"
            "if sys.argv[1] != 'verify': raise SystemExit(2)\n"
            "print('BASELINE_WITNESS=pass')\n",
            encoding="utf-8",
        )
        destination, _, _ = self.run_install()
        project = self.make_status_project()
        session = project / ".kersor" / "20260817-120000"
        config_path = session / "session-config.json"
        config = json.loads(config_path.read_text(encoding="utf-8"))
        config["max_workflows"] = 2
        config_path.write_text(json.dumps(config), encoding="utf-8")
        state_path = session / "state.json"
        state = json.loads(state_path.read_text(encoding="utf-8"))
        state["phase"] = "stalled"
        state_path.write_text(json.dumps(state), encoding="utf-8")
        (session / "baseline-witness.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "verdict": "pass",
                    "executions": [
                        {
                            "kind": "benchmark",
                            "exit_code": 0,
                            "stdout": (
                                "CYCLES: 125\n"
                                "Speedup over baseline: 10.0\n"
                            ),
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        (session / "run-1" / "output.json").write_text(
            json.dumps(
                {
                    "selected_candidate_id": "fresh29-r1",
                    "estimated_cycles": 105,
                    "estimated_speedup": 1.19,
                }
            ),
            encoding="utf-8",
        )

        run = session / "run-2"
        (run / "host-verification.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "gate": "authored_candidate_host_review_v1",
                    "verdict": "fail",
                    "reason": "candidate correctness command failed",
                }
            ),
            encoding="utf-8",
        )
        (run / "output.json").write_text(
            json.dumps(
                {
                    "selected_candidate_id": "fresh29-authored-r2",
                    "expected_cycles_estimate": 90,
                    "estimated_speedup": 1.3888888888888888,
                }
            ),
            encoding="utf-8",
        )
        (session / "round-2-summary.md").write_text(
            "# Round 2\n\n"
            "STALLED: execution budget exhausted; retain the verified incumbent.\n",
            encoding="utf-8",
        )
        attempt = session / "workflow-authoring" / "attempts" / "round-2"
        attempt.mkdir(parents=True)
        (attempt / "author-context.json").write_text("{}\n", encoding="utf-8")
        proposal = (
            session / "workflow-authoring" / "proposals" / "adaexplore"
        )
        proposal.mkdir(parents=True)
        (proposal / "workflow.js").write_text(
            "return { ok: true }\n", encoding="utf-8"
        )
        (proposal / "metadata.json").write_text(
            json.dumps({"name": "adaexplore"}), encoding="utf-8"
        )
        (proposal / "rationale.md").write_text(
            "Authored after the catalog route exhausted.\n", encoding="utf-8"
        )

        detail = self.read_session_detail(destination, session)
        self.assertEqual([row["number"] for row in detail["rounds"]], [1, 2])
        verified, failed = detail["rounds"]
        self.assertEqual(verified["workflow_origin"], "catalog")
        self.assertEqual(verified["candidate_id"], "fresh29-r1")
        self.assertEqual(verified["host_verdict"], "pass")
        self.assertEqual(verified["estimate"], {"cycles": 105.0, "speedup": 1.19})
        self.assertEqual(verified["measurement"]["candidate_cycles"], 100.0)
        self.assertEqual(verified["measurement"]["candidate_speedup"], 1.25)
        self.assertIs(verified["measurement"]["best_improved"], True)
        self.assertEqual(failed["workflow_origin"], "authored")
        self.assertEqual(failed["candidate_id"], "fresh29-authored-r2")
        self.assertEqual(failed["host_verdict"], "fail")
        self.assertEqual(failed["failure_kind"], "correctness")
        self.assertEqual(
            failed["estimate"],
            {"cycles": 90.0, "speedup": 1.3888888888888888},
        )
        self.assertNotIn("measurement", failed)

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
        summary = json.loads(completed.stdout)["sessions"][0]
        self.assertEqual(summary["stop_reason"], "execution_budget_exhausted")
        self.assertEqual(summary["workflow_authoring_used"], 1)
        self.assertEqual(
            summary["cycle_lineage"],
            {
                "session_baseline_cycles": 125.0,
                "best_cycles": 100.0,
                "session_speedup": 1.25,
                "task_baseline_cycles": 1250.0,
                "overall_speedup": 12.5,
            },
        )

        state_path = checkout_session / "state.json"
        state = json.loads(state_path.read_text(encoding="utf-8"))
        state.update({"phase": "stalled", "current_round": 1, "max_workflows": 3})
        state_path.write_text(json.dumps(state), encoding="utf-8")
        retried = subprocess.run(
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
        self.assertEqual(retried.returncode, 0, retried.stderr)
        self.assertEqual(
            json.loads(retried.stdout)["sessions"][0]["stop_reason"],
            "authoring_budget_exhausted",
        )

    def test_session_detail_caps_round_history_at_latest_100_in_order(self) -> None:
        destination, _, _ = self.run_install()
        project = self.make_status_project()
        session = project / ".kersor" / "20260817-120000"
        for number in range(3, 103):
            (session / f"run-{number}").mkdir()

        detail = self.read_session_detail(destination, session)
        numbers = [row["number"] for row in detail["rounds"]]
        self.assertEqual(len(numbers), 100)
        self.assertEqual(numbers, list(range(3, 103)))

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
        self.assertIsNone(value["profile_owner"])

    def test_status_bridge_rejects_unattributable_profile_producers(self) -> None:
        destination, _, _ = self.run_install()
        project = self.make_status_project()
        session = project / ".kersor" / "20260817-120000"
        seal_path = session / "profile-handoff" / "seal.json"
        original = json.loads(seal_path.read_text(encoding="utf-8"))

        for producer_session_id in ("none", "null", "unknown", None):
            with self.subTest(producer_session_id=producer_session_id):
                seal = json.loads(json.dumps(original))
                producer = seal["producer"]
                if producer_session_id is None:
                    producer.pop("session_id")
                else:
                    producer["session_id"] = producer_session_id
                seal_path.write_text(json.dumps(seal), encoding="utf-8")
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
                    "profile handoff producer provenance is invalid",
                )
                self.assertIsNone(value["profile_owner"])
                profile_step = next(
                    step for step in value["steps"] if step["id"] == "profile"
                )
                self.assertEqual(profile_step["status"], "failed")

    def test_terminal_phase_suppresses_residual_active_artifacts(self) -> None:
        destination, _, _ = self.run_install()
        project = self.make_status_project()
        session = project / ".kersor" / "20260817-120000"
        state_path = session / "state.json"
        authoring = session / "workflow-authoring"
        staging = authoring / "staging"
        staging.mkdir(parents=True)
        (authoring / "author-context.json").write_text("{}\n", encoding="utf-8")
        (staging / "workflow.js").write_text("return {}\n", encoding="utf-8")
        (session / "run-2" / ".dispatch-in-progress").write_text(
            "running\n", encoding="utf-8"
        )
        expected = {
            "stalled": ("stalled", "terminal-stalled"),
            "complete": ("completed", "terminal-complete"),
            "cancelled": ("cancelled", "terminal-cancelled"),
        }

        for phase, (expected_lifecycle, expected_status) in expected.items():
            with self.subTest(phase=phase):
                state = json.loads(state_path.read_text(encoding="utf-8"))
                state["phase"] = phase
                state_path.write_text(json.dumps(state), encoding="utf-8")

                status_result = subprocess.run(
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
                self.assertEqual(status_result.returncode, 0, status_result.stderr)
                status_value = json.loads(status_result.stdout)
                self.assertEqual(status_value["phase"], phase)
                self.assertIsNone(status_value["baseline_next_action"])
                self.assertNotIn(
                    "active", {step["status"] for step in status_value["steps"]}
                )

                detail_result = subprocess.run(
                    [
                        sys.executable,
                        str(destination / "bin" / "kersor_bridge.py"),
                        "session-detail",
                        "--session",
                        str(session),
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(detail_result.returncode, 0, detail_result.stderr)
                detail = json.loads(detail_result.stdout)
                self.assertNotEqual(detail["authoring"]["status"], "in_progress")
                self.assertNotIn(detail["dispatch"]["status"], {"preparing", "running"})
                self.assertNotIn(
                    "active", {step["status"] for step in detail["steps"]}
                )

                sessions_result = subprocess.run(
                    [
                        sys.executable,
                        str(destination / "bin" / "kersor_bridge.py"),
                        "sessions",
                        "--limit",
                        "1",
                        "--workspace",
                        str(project),
                        "--no-checkout-root",
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(sessions_result.returncode, 0, sessions_result.stderr)
                row = json.loads(sessions_result.stdout)["sessions"][0]
                self.assertEqual(row["lifecycle"], expected_lifecycle)
                self.assertEqual(row["status"], expected_status)
                self.assertEqual(row["health"], "terminal")
                self.assertNotEqual(row["status"], "resumable")
                self.assertNotEqual(row["health"], "active")

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

    def test_session_detail_projects_hash_bound_dispatch_design(self) -> None:
        destination, _, _ = self.run_install()
        project = self.make_status_project()
        fixture = self.make_dispatch_design(project)
        detail = self.read_session_detail(destination, fixture["session"])
        design = detail["workflow"]
        self.assertEqual(design["name"], "adaexplore")
        self.assertEqual(design["description"], fixture["description"])
        self.assertEqual(design["whenToUse"], fixture["when_to_use"])
        self.assertEqual(
            design["phases"],
            [{"title": "Inspect", "detail": "Read the current kernel."}],
        )
        self.assertEqual(design["topology"], "pipeline")
        self.assertEqual(design["methodCategory"], "analysis")
        self.assertEqual(design["requiredArgs"], ["kernel_path"])
        self.assertEqual(design["languages"], ["python_reference"])
        self.assertEqual(design["backends"], ["python"])
        self.assertEqual(design["integrationPatterns"], ["custom_simulator"])
        self.assertEqual(design["rationale"], fixture["when_to_use"])
        self.assertEqual(design["source"], fixture["body"])
        self.assertEqual(detail["selection"]["workflow"], "adaexplore")
        self.assertEqual(detail["dispatch"]["status"], "preparing")
        self.assertEqual(
            detail["authoring"], {"status": "not_started", "files": []}
        )

    def test_session_detail_projects_design_from_sealed_session_catalog(self) -> None:
        destination, _, _ = self.run_install()
        project = self.make_status_project()
        fixture = self.make_dispatch_design(project)
        self.use_sealed_session_catalog(fixture)

        detail = self.read_session_detail(destination, fixture["session"])

        self.assertEqual(detail["workflow"]["name"], "adaexplore")
        self.assertEqual(detail["workflow"]["topology"], "pipeline")
        self.assertEqual(detail["workflow"]["source"], fixture["body"])

    def test_session_detail_rejects_invalid_sealed_session_catalog(self) -> None:
        destination, _, _ = self.run_install()
        project = self.make_status_project()

        for failure in ("tampered", "duplicate", "missing_seal"):
            with self.subTest(failure=failure):
                fixture = self.make_dispatch_design(project)
                legacy_path = fixture["catalog_path"]
                self.assertIsInstance(legacy_path, Path)
                entry = json.loads(legacy_path.read_text(encoding="utf-8"))
                entries = [entry, dict(entry)] if failure == "duplicate" else [entry]
                catalog_path, seal_path = self.use_sealed_session_catalog(
                    fixture, entries
                )
                if failure == "tampered":
                    catalog_path.write_text(
                        catalog_path.read_text(encoding="utf-8") + "\n",
                        encoding="utf-8",
                    )
                elif failure == "missing_seal":
                    seal_path.unlink()

                detail = self.read_session_detail(destination, fixture["session"])
                self.assertEqual(detail["selection"]["workflow"], "adaexplore")
                self.assertNotIn("workflow", detail)

    def test_session_detail_keeps_historical_dispatch_after_checkout_changes(self) -> None:
        destination, _, _ = self.run_install()
        project = self.make_status_project()
        fixture = self.make_dispatch_design(project)
        fixture["workflow_path"].write_text(
            "export const meta = { name: 'new-version' }\n",
            encoding="utf-8",
        )
        detail = self.read_session_detail(destination, fixture["session"])
        self.assertEqual(detail["workflow"]["name"], "adaexplore")
        self.assertEqual(detail["workflow"]["topology"], "pipeline")
        self.assertEqual(detail["workflow"]["source"], fixture["body"])
        self.assertEqual(
            detail["authoring"], {"status": "not_started", "files": []}
        )

    def test_session_detail_rejects_workflow_source_path_outside_allowed_roots(self) -> None:
        destination, _, _ = self.run_install()
        project = self.make_status_project()
        fixture = self.make_dispatch_design(project)
        outside = self.root / "outside-workflow.js"
        outside.write_text("return { outside: true }\n", encoding="utf-8")
        envelope_path = fixture["envelope_path"]
        compatibility_path = fixture["compatibility_path"]
        catalog_path = fixture["catalog_path"]
        envelope = json.loads(envelope_path.read_text(encoding="utf-8"))
        compatibility = json.loads(compatibility_path.read_text(encoding="utf-8"))
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        envelope["source"]["workflow_path"] = str(outside.resolve())
        compatibility["workflow_source"] = str(outside.resolve())
        catalog["js_path"] = str(outside.resolve())
        envelope_path.write_text(json.dumps(envelope), encoding="utf-8")
        compatibility_path.write_text(json.dumps(compatibility), encoding="utf-8")
        catalog_path.write_text(json.dumps(catalog), encoding="utf-8")
        detail = self.read_session_detail(destination, fixture["session"])
        self.assertNotIn("workflow", detail)
        self.assertEqual(
            detail["authoring"], {"status": "not_started", "files": []}
        )

    def test_session_detail_rejects_dispatch_hash_tampering(self) -> None:
        destination, _, _ = self.run_install()
        project = self.make_status_project()

        for field in ("workflow_sha256", "args_sha256", "body_sha256"):
            with self.subTest(field=field):
                fixture = self.make_dispatch_design(project)
                compatibility_path = fixture["compatibility_path"]
                compatibility = json.loads(
                    compatibility_path.read_text(encoding="utf-8")
                )
                compatibility[field] = "0" * 64
                compatibility_path.write_text(
                    json.dumps(compatibility), encoding="utf-8"
                )
                detail = self.read_session_detail(destination, fixture["session"])
                self.assertEqual(detail["selection"]["workflow"], "adaexplore")
                self.assertNotIn("workflow", detail)
                self.assertEqual(
                    detail["authoring"], {"status": "not_started", "files": []}
                )

    def test_session_detail_rejects_dispatch_name_tampering(self) -> None:
        destination, _, _ = self.run_install()
        project = self.make_status_project()

        for target in ("envelope", "catalog"):
            with self.subTest(target=target):
                fixture = self.make_dispatch_design(project)
                path = (
                    fixture["envelope_path"]
                    if target == "envelope"
                    else fixture["catalog_path"]
                )
                payload = json.loads(path.read_text(encoding="utf-8"))
                if target == "envelope":
                    payload["meta"]["name"] = "other-workflow"
                else:
                    payload["name"] = "other-workflow"
                path.write_text(json.dumps(payload), encoding="utf-8")
                detail = self.read_session_detail(destination, fixture["session"])
                self.assertEqual(detail["selection"]["workflow"], "adaexplore")
                self.assertNotIn("workflow", detail)
                self.assertEqual(
                    detail["authoring"], {"status": "not_started", "files": []}
                )

    def test_session_detail_rejects_oversized_dispatch_body(self) -> None:
        destination, _, _ = self.run_install()
        project = self.make_status_project()
        fixture = self.make_dispatch_design(project)
        envelope_path = fixture["envelope_path"]
        compatibility_path = fixture["compatibility_path"]
        envelope = json.loads(envelope_path.read_text(encoding="utf-8"))
        compatibility = json.loads(compatibility_path.read_text(encoding="utf-8"))
        oversized = "x" * (512 * 1024 + 1)
        body_hash = hashlib.sha256(oversized.encode("utf-8")).hexdigest()
        envelope["script"] = oversized
        envelope["source"]["body_sha256"] = body_hash
        compatibility["body_sha256"] = body_hash
        envelope_path.write_text(json.dumps(envelope), encoding="utf-8")
        compatibility_path.write_text(json.dumps(compatibility), encoding="utf-8")
        detail = self.read_session_detail(destination, fixture["session"])
        self.assertEqual(detail["selection"]["workflow"], "adaexplore")
        self.assertNotIn("workflow", detail)
        self.assertEqual(
            detail["authoring"], {"status": "not_started", "files": []}
        )

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
        self.assertNotIn("workflow", before_value)

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
        self.assertNotIn("workflow", after_value)
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
        self.assertEqual(result["meta"]["kind"], "kersor-status")
        self.assertEqual(len(result["meta"]["steps"]), 9)
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
