"""Release and installed-byte parity tests for the KerSor DSH distribution."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import release


ROOT = Path(__file__).resolve().parents[1]
INSTALL_SPEC = importlib.util.spec_from_file_location(
    "dsh_release_install",
    ROOT / "scripts" / "install.py",
)
assert INSTALL_SPEC is not None and INSTALL_SPEC.loader is not None
INSTALLER = importlib.util.module_from_spec(INSTALL_SPEC)
INSTALL_SPEC.loader.exec_module(INSTALLER)


def run(command: list[str], cwd: Path) -> str:
    """Run one fixture command and return stripped stdout."""
    completed = subprocess.run(
        command,
        cwd=cwd,
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise AssertionError(
            f"command failed ({completed.returncode}): {' '.join(command)}\n"
            f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
        )
    return completed.stdout.strip()


def init_repository(path: Path) -> None:
    """Initialize one deterministic local Git fixture."""
    path.mkdir(parents=True)
    run(["git", "init", "--quiet"], path)
    run(["git", "config", "user.email", "release-tests@example.invalid"], path)
    run(["git", "config", "user.name", "Release Tests"], path)


def commit_all(path: Path, message: str = "fixture") -> str:
    """Commit every fixture file and return the full commit id."""
    run(["git", "add", "-A"], path)
    run(["git", "commit", "--quiet", "-m", message], path)
    return run(["git", "rev-parse", "HEAD"], path)


def write(path: Path, content: str, *, executable: bool = False) -> None:
    """Write one fixture file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    if executable:
        path.chmod(0o755)


def file_sha256(path: Path) -> str:
    """Hash one fixture file."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


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


class ReleaseParityTests(unittest.TestCase):
    """Reject live sources and prove releases come from committed Git objects."""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_rejects_directory_file_dependencies(self) -> None:
        profile = self.root / "profile"
        profile.mkdir()
        (profile / "package.json").write_text(
            json.dumps({
                "dependencies": {
                    "@qhy991/dsh-kersor-web": f"file:{self.root / 'live-bundle'}",
                }
            }),
            encoding="utf-8",
        )
        (profile / "pnpm-lock.yaml").write_text(
            "resolution: {directory: ../../live-bundle, type: directory}\n",
            encoding="utf-8",
        )

        violations = release.profile_dependency_violations(profile)

        self.assertTrue(any("tarball" in item for item in violations), violations)
        self.assertTrue(any("directory" in item for item in violations), violations)

    def test_rejects_symlink_hardlink_and_multiple_links(self) -> None:
        source = self.root / "source"
        installed = self.root / "installed"
        source.mkdir()
        installed.mkdir()
        original = source / "plugin.js"
        original.write_text("export const value = 1\n", encoding="utf-8")
        os.link(original, installed / "hardlink.js")
        (installed / "symlink.js").symlink_to(original)

        violations = release.filesystem_alias_violations(
            [installed],
            [source],
        )

        self.assertTrue(any("symbolic link" in item for item in violations), violations)
        self.assertTrue(any("multiple links" in item for item in violations), violations)
        self.assertTrue(any("source inode" in item for item in violations), violations)

    def test_rejects_reconciled_false(self) -> None:
        snapshot = self.root / "personal"
        manifest = snapshot / "plugins" / "dsh-mirror.json"
        write(
            manifest,
            json.dumps({
                "schema_version": 1,
                "authority": {
                    "revision": "a" * 40,
                    "reconciled": False,
                },
                "files": [],
            }),
        )

        with self.assertRaisesRegex(release.ReleaseError, "reconciled=true"):
            release.require_reconciled_mirror(snapshot, "a" * 40)

    def test_materializes_committed_bytes_not_dirty_worktree(self) -> None:
        repository = self.root / "repository"
        init_repository(repository)
        write(repository / "value.txt", "committed\n")
        commit = commit_all(repository)
        (repository / "value.txt").write_text("dirty\n", encoding="utf-8")
        destination = self.root / "snapshot"

        release.materialize_git_snapshot(repository, commit, destination)

        self.assertEqual(
            (destination / "value.txt").read_text(encoding="utf-8"),
            "committed\n",
        )

    def test_expands_every_pinned_submodule_from_git_objects(self) -> None:
        child = self.root / "child"
        init_repository(child)
        write(child / "owned.txt", "pinned child\n")
        child_commit = commit_all(child)

        parent = self.root / "parent"
        init_repository(parent)
        run(
            [
                "git",
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "--quiet",
                str(child),
                "vendor/child",
            ],
            parent,
        )
        parent_commit = commit_all(parent)
        self.assertEqual(
            run(["git", "rev-parse", "HEAD"], parent / "vendor" / "child"),
            child_commit,
        )
        (parent / "vendor" / "child" / "owned.txt").write_text(
            "dirty child\n",
            encoding="utf-8",
        )

        destination = self.root / "expanded"
        release.materialize_git_snapshot(parent, parent_commit, destination)

        self.assertEqual(
            (destination / "vendor" / "child" / "owned.txt").read_text(
                encoding="utf-8"
            ),
            "pinned child\n",
        )

    def test_source_mutation_does_not_change_detached_install(self) -> None:
        source = self.root / "source"
        installed = self.root / "installed"
        source.mkdir()
        installed.mkdir()
        original = source / "index.js"
        original.write_text("export const value = 1\n", encoding="utf-8")

        release.copy_detached_tree(source, installed)
        before = (installed / "index.js").read_bytes()
        original.write_text("export const value = 2\n", encoding="utf-8")

        self.assertEqual((installed / "index.js").read_bytes(), before)
        self.assertEqual(
            release.filesystem_alias_violations([installed], [source]),
            [],
        )

    def test_receipt_rejects_installed_drift(self) -> None:
        installed = self.root / "installed"
        installed.mkdir()
        write(installed / "index.js", "stable\n")
        receipt = release.tree_receipt(installed)
        write(installed / "index.js", "drift\n")

        violations = release.verify_tree_receipt(installed, receipt, "installed")

        self.assertTrue(any("content" in item for item in violations), violations)

    def test_tool_identity_rejects_executable_target_drift(self) -> None:
        tool = self.root / "tool"
        write(tool, "#!/bin/sh\nexit 0\n", executable=True)
        identity = release.file_identity(tool)
        tool.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
        tool.chmod(0o755)

        violations = release.verify_file_identity(identity, "fixture tool")

        self.assertTrue(any("identity" in item for item in violations), violations)

    def test_profile_local_resolution_rejects_fallback_package(self) -> None:
        home = self.root / "dsh"
        profile = home / "profiles" / "web"
        fallback = home / "profiles" / "node_modules" / "@deepseek-ai" / "dsh-kersor"
        write(profile / "package.json", json.dumps({"name": "profile"}))
        write(
            fallback / "package.json",
            json.dumps({"name": "@deepseek-ai/dsh-kersor", "version": "0.1.0"}),
        )

        violations = release.profile_local_resolution_violations(
            profile,
            ["@deepseek-ai/dsh-kersor"],
        )

        self.assertTrue(any("profile-local" in item for item in violations), violations)

    def test_release_preset_rejects_pointer_drift_and_development_receipt(self) -> None:
        release_root = self.root / "release"
        core = release_root / "core"
        write(core / "AGENTS.md", "# frozen\n")
        write(core / "commands" / "run.md", "frozen\n")
        write(core / "scripts" / "compose.py", "", executable=True)
        write(core / "scripts" / "doctor.sh", "", executable=True)
        core_receipt = release.tree_receipt(core)
        lock = {
            "schema_version": 1,
            "release_id": "release-test",
            "release_root": str(release_root),
            "core": {"root": "core", "tree": core_receipt},
            "personal": {"preset_root": "personal/presets/kersor"},
            "packages": [],
        }
        write(release_root / "release-lock.json", json.dumps(lock))
        preset = self.root / "preset"
        write(preset / ".local" / "kersor-root", f"{core}\n")
        write(
            preset / ".local" / "release-receipt.json",
            json.dumps({
                "schema_version": 1,
                "mode": "development",
                "release_id": "release-test",
                "release_root": str(release_root),
            }),
        )

        violations = release.verify_preset_install(preset, release_root)
        self.assertTrue(any("development" in item for item in violations), violations)

        receipt_path = preset / ".local" / "release-receipt.json"
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["mode"] = "release"
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        live = self.root / "live-core"
        live.mkdir()
        (preset / ".local" / "kersor-root").write_text(
            f"{live}\n",
            encoding="utf-8",
        )

        violations = release.verify_preset_install(preset, release_root)
        self.assertTrue(any("frozen Core" in item for item in violations), violations)

    def test_release_cli_exposes_prepare_install_and_read_only_verification(self) -> None:
        command = release.parser()
        subparsers = next(
            action
            for action in command._actions
            if hasattr(action, "choices") and action.choices
        )
        self.assertEqual(
            set(subparsers.choices),
            {"prepare", "install-web", "verify-installed"},
        )


class ReleaseWorkflowTests(unittest.TestCase):
    """Exercise committed staging and detached installs in temporary homes."""

    PACKAGE_FIXTURES = {
        "kersor": "@deepseek-ai/dsh-kersor",
        "kersor-viewer": "@deepseek-ai/dsh-kersor-viewer",
        "ui-kersor-viewer": "@deepseek-ai/dsh-client-ui-kersor-viewer",
    }

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.node = shutil.which("node")
        self.pnpm = shutil.which("pnpm")
        if self.node is None or self.pnpm is None:
            self.skipTest("Node.js and pnpm are required for release packing")
        self.pnpm_version = run([self.pnpm, "--version"], self.root)

        self.authority = self.root / "authority"
        init_repository(self.authority)
        for directory, package_name in self.PACKAGE_FIXTURES.items():
            package = self.authority / "packages" / "extensions" / directory
            write(
                package / "package.json",
                json.dumps({
                    "name": package_name,
                    "version": "1.0.0",
                    "type": "module",
                    "main": "lib/index.js",
                    "files": ["lib/index.js"],
                })
                + "\n",
            )
            write(package / "lib" / "index.js", "export const fixture = true\n")
        self.authority_commit = commit_all(self.authority)

        self.personal = self.root / "personal"
        init_repository(self.personal)
        mirror_entries = []
        for directory in self.PACKAGE_FIXTURES:
            authority_package = (
                self.authority / "packages" / "extensions" / directory
            )
            personal_package = self.personal / "plugins" / directory
            shutil.copytree(authority_package, personal_package)
            for path in sorted(personal_package.rglob("*")):
                if not path.is_file():
                    continue
                relative = path.relative_to(self.personal).as_posix()
                source = (
                    Path("packages/extensions")
                    / directory
                    / path.relative_to(personal_package)
                ).as_posix()
                mirror_entries.append({
                    "path": relative,
                    "source": source,
                    "sha256": file_sha256(path),
                })
        write(
            self.personal / "plugins" / "dsh-mirror.json",
            json.dumps({
                "schema_version": 1,
                "authority": {
                    "repository": "fixture",
                    "revision": self.authority_commit,
                    "source_root": "packages/extensions",
                    "reconciled": True,
                },
                "toolchain": {"node": "fixture", "pnpm": self.pnpm_version},
                "files": sorted(mirror_entries, key=lambda item: item["path"]),
            }, indent=2)
            + "\n",
        )
        bundle = self.personal / "bundles" / "kersor-web"
        write(
            bundle / "package.json",
            json.dumps({
                "name": "@qhy991/dsh-kersor-web",
                "version": "1.0.0",
                "private": True,
                "type": "module",
                "dependencies": {
                    package_name: f"file:../../plugins/{directory}"
                    for directory, package_name in self.PACKAGE_FIXTURES.items()
                },
                "dsh": {"bundle": {"patch": "./cordis.patch.yml"}},
                "files": ["cordis.patch.yml"],
            })
            + "\n",
        )
        write(bundle / "cordis.patch.yml", "[]\n")
        preset = self.personal / "presets" / "kersor"
        write(preset / "preset.yml", "name: KerSor\ndescription: fixture\n")
        write(
            preset / "skills" / "kersor" / "SKILL.md",
            "---\nname: kersor\ndescription: fixture\n---\n",
        )
        write(preset / "plugins" / "kersor-status.mjs", "export const name = 'status'\n")
        write(preset / "plugins" / "kersor-evolve.mjs", "export const name = 'evolve'\n")
        write(preset / "bin" / "kersor_bridge.py", "print('fixture')\n")
        self.personal_commit = commit_all(self.personal)

        self.core = self.root / "core-source"
        init_repository(self.core)
        write(self.core / "AGENTS.md", "# frozen Core\n")
        write(self.core / "commands" / "run.md", "run\n")
        write(self.core / "scripts" / "compose.py", "", executable=True)
        write(self.core / "scripts" / "doctor.sh", "", executable=True)
        self.core_commit = commit_all(self.core)
        self.release_root = self.root / "release"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def prepare(self) -> dict[str, object]:
        """Build the fixture release."""
        return release.prepare_release(
            personal_repository=self.personal,
            personal_commit=self.personal_commit,
            core_repository=self.core,
            core_commit=self.core_commit,
            authority_repository=self.authority,
            authority_commit=self.authority_commit,
            destination=self.release_root,
            pnpm=Path(self.pnpm),
        )

    def test_prepare_is_atomic_read_only_and_uses_local_tarballs(self) -> None:
        lock = self.prepare()

        self.assertEqual(lock, release.load_release(self.release_root))
        self.assertFalse(os.access(self.release_root, os.W_OK))
        self.assertEqual(stat.S_IMODE(self.release_root.stat().st_mode), 0o555)
        packages = lock["packages"]
        self.assertIsInstance(packages, list)
        tarball_hashes = {}
        for package in packages:
            self.assertIsInstance(package, dict)
            tarball = self.release_root / package["tarball"]
            self.assertTrue(tarball.is_file())
            self.assertEqual(stat.S_IMODE(tarball.stat().st_mode), 0o444)
            tarball_hashes[package["name"]] = file_sha256(tarball)

        bundle_entry = next(
            item for item in packages if item["name"] == release.WEB_BUNDLE_NAME
        )
        bundle_manifest = release.tarball_json_file(
            self.release_root / bundle_entry["tarball"],
            "package/package.json",
        )
        for dependency in self.PACKAGE_FIXTURES.values():
            specifier = bundle_manifest["dependencies"][dependency]
            self.assertTrue(specifier.startswith("file:"), specifier)
            self.assertTrue(specifier.endswith(".tgz"), specifier)
            self.assertNotIn(str(self.personal), specifier)

        (self.personal / "plugins" / "kersor" / "lib" / "index.js").write_text(
            "export const fixture = 'dirty after release'\n",
            encoding="utf-8",
        )
        for package in packages:
            tarball = self.release_root / package["tarball"]
            self.assertEqual(file_sha256(tarball), tarball_hashes[package["name"]])

    def test_release_mode_installs_preset_with_frozen_core_receipt(self) -> None:
        self.prepare()
        dsh_home = self.root / "preset-home"
        standard = self.root / "standard.yml"
        standard.write_text(STANDARD, encoding="utf-8")

        with mock.patch.object(
            INSTALLER,
            "resolve_codex_auth_home",
            side_effect=AssertionError("release mode must not inspect credentials"),
        ):
            destination, backup, changed = INSTALLER.install(
                dsh_home=dsh_home,
                standard_preset=standard,
                kersor_root=None,
                release_root=self.release_root,
                force=False,
                dry_run=False,
            )

        self.assertTrue(changed)
        self.assertIsNone(backup)
        receipt = json.loads(
            (destination / ".local" / "release-receipt.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(receipt["mode"], "release")
        self.assertEqual(release.verify_preset_install(destination, self.release_root), [])
        self.assertEqual(
            Path(
                (destination / ".local" / "kersor-root").read_text(
                    encoding="utf-8"
                ).strip()
            ),
            (self.release_root / "core").resolve(),
        )

    def test_dsh_plugin_manager_installs_detached_profile_and_detects_drift(self) -> None:
        dsh_bin = ROOT.parent / "deepseek-harness" / "apps" / "cli" / "lib" / "bin.js"
        if not dsh_bin.is_file():
            self.skipTest("built sibling DSH CLI is required for the local integration gate")
        self.prepare()
        dsh_home = self.root / "dsh-home"

        receipt = release.install_web_release(
            release_root=self.release_root,
            dsh_home=dsh_home,
            profile_name="web",
            node=Path(self.node),
            pnpm=Path(self.pnpm),
            dsh_bin=dsh_bin,
            source_roots=[self.personal],
        )

        profile = dsh_home / "profiles" / "web"
        self.assertEqual(receipt["mode"], "release")
        persisted_receipt = json.loads(
            (profile / ".kersor-release-receipt.json").read_text(encoding="utf-8")
        )
        self.assertEqual(
            set(persisted_receipt["tools"]),
            {"node", "pnpm", "dsh_bin"},
        )
        self.assertEqual(
            release.verify_web_install(
                self.release_root,
                profile,
                source_roots=[self.personal],
            ),
            [],
        )
        tampered_receipt = json.loads(json.dumps(persisted_receipt))
        tampered_receipt["tools"]["dsh_bin"]["sha256"] = "0" * 64
        (profile / ".kersor-release-receipt.json").write_text(
            json.dumps(tampered_receipt),
            encoding="utf-8",
        )
        violations = release.verify_web_install(
            self.release_root,
            profile,
            source_roots=[self.personal],
        )
        self.assertTrue(
            any("tool" in item and "identity" in item for item in violations),
            violations,
        )
        (profile / ".kersor-release-receipt.json").write_text(
            json.dumps(persisted_receipt),
            encoding="utf-8",
        )
        self.assertIn(
            "packageImportMethod: copy",
            (profile / "pnpm-workspace.yaml").read_text(encoding="utf-8"),
        )
        installed = profile / "node_modules" / "@deepseek-ai" / "dsh-kersor"
        for path in installed.rglob("*"):
            if path.is_file():
                self.assertEqual(path.stat().st_nlink, 1, path)

        source = self.personal / "plugins" / "kersor" / "lib" / "index.js"
        source.write_text("export const fixture = 'source drift'\n", encoding="utf-8")
        self.assertEqual(
            release.verify_web_install(
                self.release_root,
                profile,
                source_roots=[self.personal],
            ),
            [],
        )

        (installed / "lib" / "index.js").chmod(0o644)
        (installed / "lib" / "index.js").write_text(
            "export const fixture = 'installed drift'\n",
            encoding="utf-8",
        )
        violations = release.verify_web_install(
            self.release_root,
            profile,
            source_roots=[self.personal],
        )
        self.assertTrue(any("content" in item for item in violations), violations)


if __name__ == "__main__":
    unittest.main()
