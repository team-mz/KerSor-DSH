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

from scripts import release, sync_plugins


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

    def test_authority_receipt_canonical_json_golden_vector(self) -> None:
        entries = [
            {
                "size": 1,
                "path": "z/é.ts",
                "mode": 0o644,
                "git_blob_sha256": "0" * 64,
            },
            {
                "path": "😀/a.ts",
                "mode": 0o755,
                "size": 2,
                "git_blob_sha256": "f" * 64,
            },
        ]

        digest = hashlib.sha256(release.canonical_json(entries)).hexdigest()

        self.assertEqual(
            digest,
            "adc371a32a54d4eb668655602bb35db968bf019364d9ee696695e92d649e5e18",
        )

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
                "schema_version": 2,
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
        self.node_version = run([self.node, "--version"], self.root).removeprefix("v")

        self.authority = self.root / "authority"
        init_repository(self.authority)
        write(self.authority / ".gitignore", "lib/\nnode_modules/\n")
        write(
            self.authority / "package.json",
            json.dumps({
                "name": "@deepseek-ai/dsh-root",
                "private": True,
                "packageManager": f"pnpm@{self.pnpm_version}",
            })
            + "\n",
        )
        write(
            self.authority / "pnpm-workspace.yaml",
            "packages:\n  - packages/extensions/*\n",
        )
        write(
            self.authority / "pnpm-lock.yaml",
            "lockfileVersion: '9.0'\n\n"
            "settings:\n"
            "  autoInstallPeers: true\n"
            "  excludeLinksFromLockfile: false\n\n"
            "importers:\n\n"
            "  .: {}\n\n"
            "  packages/extensions/kersor: {}\n\n"
            "  packages/extensions/kersor-viewer: {}\n\n"
            "  packages/extensions/ui-kersor-viewer: {}\n",
        )
        write(
            self.authority / "apps" / "cli" / "package.json",
            json.dumps({
                "name": "@deepseek-ai/dsh-cli",
                "private": True,
                "type": "module",
            })
            + "\n",
        )
        write(
            self.authority / "apps" / "cli" / "src" / "index.ts",
            "export const cli = true\n",
        )
        for root_config in (
            "tsconfig.base.json",
            "tsconfig.base.client.json",
            "tsconfig.host.json",
        ):
            write(self.authority / root_config, "{}\n")
        write(self.authority / "tsdown.config.ts", "export default {}\n")
        write(
            self.authority / "scripts" / "release" / "build-kersor-distribution.mjs",
            "import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'\n"
            "for (const name of ['kersor', 'kersor-viewer', 'ui-kersor-viewer']) {\n"
            "  const root = `packages/extensions/${name}`\n"
            "  const source = readFileSync(`${root}/src/index.ts`, 'utf8')\n"
            "  const value = /fixture = (true|false)/.exec(source)?.[1]\n"
            "  if (!value) throw new Error(`invalid fixture source: ${name}`)\n"
            "  rmSync(`${root}/lib`, { recursive: true, force: true })\n"
            "  mkdirSync(`${root}/lib/types`, { recursive: true })\n"
            "  writeFileSync(`${root}/lib/index.js`, `export const fixture = ${value}\\n`)\n"
            "  writeFileSync(`${root}/lib/types/index.d.ts`, 'export declare const fixture: boolean\\n')\n"
            "}\n",
        )
        authority_outputs = []
        for directory, package_name in self.PACKAGE_FIXTURES.items():
            package = self.authority / "packages" / "extensions" / directory
            write(
                package / "package.json",
                json.dumps({
                    "name": package_name,
                    "version": "1.0.0",
                    "type": "module",
                    "main": "lib/index.js",
                    "files": ["lib"],
                })
                + "\n",
            )
            write(package / "src" / "index.ts", "export const fixture = true\n")
            write(package / "tests" / "index.spec.ts", "export {}\n")
            output = package / "lib" / "index.js"
            write(output, "export const fixture = true\n")
            authority_outputs.append({
                "path": output.relative_to(self.authority).as_posix(),
                "sha256": file_sha256(output),
                "size": output.stat().st_size,
                "mode": stat.S_IMODE(output.stat().st_mode),
            })
            declaration = package / "lib" / "types" / "index.d.ts"
            write(declaration, "export declare const fixture: boolean\n")
            authority_outputs.append({
                "path": declaration.relative_to(self.authority).as_posix(),
                "sha256": file_sha256(declaration),
                "size": declaration.stat().st_size,
                "mode": stat.S_IMODE(declaration.stat().st_mode),
            })
        authority_outputs.sort(key=lambda item: item["path"])
        authority_inputs = []
        for path in sorted(self.authority.rglob("*")):
            relative = path.relative_to(self.authority)
            if not path.is_file() or ".git" in relative.parts or "lib" in relative.parts:
                continue
            authority_inputs.append({
                "path": relative.as_posix(),
                "git_blob_sha256": file_sha256(path),
                "size": path.stat().st_size,
                "mode": stat.S_IMODE(path.stat().st_mode),
            })
        authority_inputs.sort(key=lambda item: item["path"])
        pnpm_package = release.pnpm_package_identity(
            Path(self.pnpm),
            self.pnpm_version,
        )
        authority_tools = {
            "node": {"version": self.node_version},
            "pnpm": {
                "version": self.pnpm_version,
                "tree": pnpm_package["tree"],
            },
        }
        build_receipt = {
            "schema_version": 1,
            "receipt_type": "kersor-distribution-build",
            "recipe": {
                "id": "dsh-kersor-distribution-build-v1",
                "node": self.node_version,
                "pnpm": self.pnpm_version,
                "install": [
                    "pnpm",
                    "install",
                    "--frozen-lockfile",
                    "--ignore-scripts",
                    "--filter",
                    "@deepseek-ai/dsh-root",
                    "--filter",
                    "@deepseek-ai/dsh-kersor...",
                    "--filter",
                    "@deepseek-ai/dsh-kersor-viewer...",
                    "--filter",
                    "@deepseek-ai/dsh-client-ui-kersor-viewer...",
                    "--filter",
                    "@deepseek-ai/dsh-typert-generator...",
                ],
                "command": [
                    "node",
                    "scripts/release/build-kersor-distribution.mjs",
                ],
            },
            "tools": authority_tools,
            "tools_sha256": hashlib.sha256(
                release.canonical_json(authority_tools)
            ).hexdigest(),
            "inputs": authority_inputs,
            "inputs_sha256": hashlib.sha256(
                release.canonical_json(authority_inputs)
            ).hexdigest(),
            "outputs": authority_outputs,
            "outputs_sha256": hashlib.sha256(
                release.canonical_json(authority_outputs)
            ).hexdigest(),
        }
        authority_receipt = (
            self.authority
            / "release"
            / "kersor-distribution-build-receipt.json"
        )
        write(
            authority_receipt,
            json.dumps(build_receipt, indent=2) + "\n",
        )
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
                package_relative = path.relative_to(personal_package)
                source = (Path("packages/extensions") / directory / package_relative)
                entry = {
                    "path": relative,
                    "sha256": file_sha256(path),
                    "origin": (
                        "distribution-owned"
                        if package_relative == Path("package.json")
                        else (
                            "derived-build"
                            if package_relative.parts[0] == "lib"
                            else "tracked"
                        )
                    ),
                }
                if entry["origin"] != "distribution-owned":
                    entry["source"] = source.as_posix()
                if entry["origin"] == "derived-build":
                    entry["receipt_output"] = source.as_posix()
                mirror_entries.append(entry)
        receipt_bytes = authority_receipt.read_bytes()
        write(
            self.personal / "plugins" / "dsh-mirror.json",
            json.dumps({
                "schema_version": 2,
                "authority": {
                    "repository": "fixture",
                    "revision": self.authority_commit,
                    "source_root": "packages/extensions",
                    "reconciled": True,
                },
                "toolchain": {
                    "node": self.node_version,
                    "pnpm": self.pnpm_version,
                },
                "build_receipt": {
                    "path": "release/kersor-distribution-build-receipt.json",
                    "sha256": hashlib.sha256(receipt_bytes).hexdigest(),
                    "recipe_id": "dsh-kersor-distribution-build-v1",
                },
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

        for output in authority_outputs:
            write(
                self.authority / output["path"],
                "export const fixture = 'ignored authority worktree drift'\n",
            )

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
            node=Path(self.node),
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

    def test_sync_accepts_only_receipted_ignored_build_outputs(self) -> None:
        with mock.patch.multiple(
            sync_plugins,
            TOOLCHAIN_NODE=self.node_version,
            TOOLCHAIN_PNPM=self.pnpm_version,
        ):
            with self.assertRaisesRegex(
                sync_plugins.MirrorError,
                "ignored build output differs from authority receipt",
            ):
                sync_plugins.source_snapshot(self.authority)

            run(
                [
                    self.node,
                    "scripts/release/build-kersor-distribution.mjs",
                ],
                self.authority,
            )
            ignored_modules = (
                self.authority
                / "packages"
                / "extensions"
                / "kersor"
                / "node_modules"
            )
            ignored_modules.mkdir()
            (ignored_modules / "fixture-dependency").symlink_to(
                self.authority / "package.json"
            )
            revision, snapshot, binding = sync_plugins.source_snapshot(self.authority)

        self.assertEqual(revision, self.authority_commit)
        self.assertEqual(binding["recipe_id"], "dsh-kersor-distribution-build-v1")
        self.assertNotIn(
            Path("plugins/kersor/package.json"),
            {Path(str(path)) for path in snapshot},
        )

    def test_prepare_rejects_self_asserted_generated_bytes(self) -> None:
        generated = self.personal / "plugins" / "kersor" / "lib" / "index.js"
        write(generated, "export const fixture = 'stale generated output'\n")
        manifest_path = self.personal / "plugins" / "dsh-mirror.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        entry = next(item for item in manifest["files"] if item["path"] == (
            "plugins/kersor/lib/index.js"
        ))
        entry["sha256"] = file_sha256(generated)
        write(manifest_path, json.dumps(manifest, indent=2) + "\n")
        self.personal_commit = commit_all(self.personal, "self asserted output")

        with self.assertRaisesRegex(
            release.ReleaseError,
            "differs from authority build",
        ):
            self.prepare()

    def test_prepare_rebuilds_authority_instead_of_trusting_matching_receipts(self) -> None:
        generated = self.personal / "plugins" / "kersor" / "lib" / "index.js"
        write(generated, "export const fixture = false\n")
        generated_hash = file_sha256(generated)

        receipt_path = (
            self.authority
            / "release"
            / "kersor-distribution-build-receipt.json"
        )
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        output = next(
            item
            for item in receipt["outputs"]
            if item["path"] == "packages/extensions/kersor/lib/index.js"
        )
        output.update({
            "sha256": generated_hash,
            "size": generated.stat().st_size,
            "mode": stat.S_IMODE(generated.stat().st_mode),
        })
        receipt["outputs_sha256"] = hashlib.sha256(
            release.canonical_json(receipt["outputs"])
        ).hexdigest()
        write(receipt_path, json.dumps(receipt, indent=2) + "\n")
        self.authority_commit = commit_all(self.authority, "tampered build receipt")

        manifest_path = self.personal / "plugins" / "dsh-mirror.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["authority"]["revision"] = self.authority_commit
        manifest["build_receipt"]["sha256"] = file_sha256(receipt_path)
        entry = next(
            item
            for item in manifest["files"]
            if item["path"] == "plugins/kersor/lib/index.js"
        )
        entry["sha256"] = generated_hash
        write(manifest_path, json.dumps(manifest, indent=2) + "\n")
        self.personal_commit = commit_all(self.personal, "matching self assertion")

        with self.assertRaisesRegex(
            release.ReleaseError,
            "clean authority build",
        ):
            self.prepare()

    def test_prepare_rejects_receipt_outputs_missing_from_personal_mirror(self) -> None:
        (
            self.personal / "plugins" / "kersor" / "lib" / "index.js"
        ).unlink()
        manifest_path = self.personal / "plugins" / "dsh-mirror.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["files"] = [
            item
            for item in manifest["files"]
            if item["path"] != "plugins/kersor/lib/index.js"
        ]
        write(manifest_path, json.dumps(manifest, indent=2) + "\n")
        self.personal_commit = commit_all(self.personal, "omit generated output")

        with self.assertRaisesRegex(
            release.ReleaseError,
            "outputs absent from the mirror",
        ):
            self.prepare()

    def test_prepare_rejects_tracked_authority_files_missing_from_the_union(self) -> None:
        (
            self.personal / "plugins" / "kersor" / "src" / "index.ts"
        ).unlink()
        manifest_path = self.personal / "plugins" / "dsh-mirror.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["files"] = [
            item
            for item in manifest["files"]
            if item["path"] != "plugins/kersor/src/index.ts"
        ]
        write(manifest_path, json.dumps(manifest, indent=2) + "\n")
        self.personal_commit = commit_all(self.personal, "omit tracked authority file")

        with self.assertRaisesRegex(
            release.ReleaseError,
            "tracked authority files absent from the mirror",
        ):
            self.prepare()

    def test_prepare_rejects_tracked_authority_mode_drift(self) -> None:
        tracked = self.personal / "plugins" / "kersor" / "src" / "index.ts"
        tracked.chmod(0o755)
        self.personal_commit = commit_all(self.personal, "change tracked source mode")

        with self.assertRaisesRegex(
            release.ReleaseError,
            "personal mirror differs from authority commit",
        ):
            self.prepare()

    def test_prepare_rejects_unlisted_packable_files(self) -> None:
        extra = self.personal / "plugins" / "kersor" / "lib" / "injected.js"
        write(extra, "export const injected = true\n")
        package_path = self.personal / "plugins" / "kersor" / "package.json"
        package = json.loads(package_path.read_text(encoding="utf-8"))
        package["files"] = ["lib/*.js"]
        write(package_path, json.dumps(package, indent=2) + "\n")
        manifest_path = self.personal / "plugins" / "dsh-mirror.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        package_entry = next(
            item
            for item in manifest["files"]
            if item["path"] == "plugins/kersor/package.json"
        )
        package_entry["sha256"] = file_sha256(package_path)
        write(manifest_path, json.dumps(manifest, indent=2) + "\n")
        self.personal_commit = commit_all(self.personal, "unlisted packable file")

        with self.assertRaisesRegex(
            release.ReleaseError,
            "complete package tree",
        ):
            self.prepare()

    def test_prepare_requires_distribution_owned_package_manifests(self) -> None:
        manifest_path = self.personal / "plugins" / "dsh-mirror.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        entry = next(
            item
            for item in manifest["files"]
            if item["path"] == "plugins/kersor/package.json"
        )
        entry["origin"] = "tracked"
        entry["source"] = "packages/extensions/kersor/package.json"
        write(manifest_path, json.dumps(manifest, indent=2) + "\n")
        self.personal_commit = commit_all(self.personal, "misclassified package manifest")

        with self.assertRaisesRegex(
            release.ReleaseError,
            "package.json files must be distribution-owned",
        ):
            self.prepare()

    def test_prepare_rejects_authority_lock_drift(self) -> None:
        lock_path = self.authority / "pnpm-lock.yaml"
        write(
            lock_path,
            lock_path.read_text(encoding="utf-8") + "# committed drift\n",
        )
        self.authority_commit = commit_all(self.authority, "lock drift")
        manifest_path = self.personal / "plugins" / "dsh-mirror.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["authority"]["revision"] = self.authority_commit
        write(manifest_path, json.dumps(manifest, indent=2) + "\n")
        self.personal_commit = commit_all(self.personal, "bind drifted authority")

        with self.assertRaisesRegex(
            release.ReleaseError,
            "build input differs from commit: pnpm-lock.yaml",
        ):
            self.prepare()

    def test_prepare_rejects_incomplete_workspace_input_closure(self) -> None:
        receipt_path = (
            self.authority
            / "release"
            / "kersor-distribution-build-receipt.json"
        )
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["inputs"] = [
            entry
            for entry in receipt["inputs"]
            if entry["path"] != "apps/cli/src/index.ts"
        ]
        receipt["inputs_sha256"] = hashlib.sha256(
            release.canonical_json(receipt["inputs"])
        ).hexdigest()
        write(receipt_path, json.dumps(receipt, indent=2) + "\n")
        self.authority_commit = commit_all(
            self.authority,
            "omit workspace input closure",
        )

        manifest_path = self.personal / "plugins" / "dsh-mirror.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["authority"]["revision"] = self.authority_commit
        manifest["build_receipt"]["sha256"] = file_sha256(receipt_path)
        write(manifest_path, json.dumps(manifest, indent=2) + "\n")
        self.personal_commit = commit_all(
            self.personal,
            "bind incomplete workspace closure",
        )

        with self.assertRaisesRegex(
            release.ReleaseError,
            "omits canonical build inputs",
        ):
            self.prepare()

    def test_prepare_rejects_toolchain_drift(self) -> None:
        manifest_path = self.personal / "plugins" / "dsh-mirror.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["toolchain"]["node"] = "24.19.1"
        write(manifest_path, json.dumps(manifest, indent=2) + "\n")
        self.personal_commit = commit_all(self.personal, "toolchain drift")

        with self.assertRaisesRegex(
            release.ReleaseError,
            "toolchain differs from the authority build receipt",
        ):
            self.prepare()

    def test_prepare_rejects_self_asserted_pnpm_package_identity(self) -> None:
        receipt_path = (
            self.authority
            / "release"
            / "kersor-distribution-build-receipt.json"
        )
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        pnpm_tree = receipt["tools"]["pnpm"]["tree"]
        pnpm_tree["files"][0]["sha256"] = "0" * 64
        pnpm_tree["tree_sha256"] = hashlib.sha256(
            release.canonical_json(pnpm_tree["files"])
        ).hexdigest()
        receipt["tools_sha256"] = hashlib.sha256(
            release.canonical_json(receipt["tools"])
        ).hexdigest()
        write(receipt_path, json.dumps(receipt, indent=2) + "\n")
        self.authority_commit = commit_all(
            self.authority,
            "self-assert pnpm package identity",
        )

        manifest_path = self.personal / "plugins" / "dsh-mirror.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["authority"]["revision"] = self.authority_commit
        manifest["build_receipt"]["sha256"] = file_sha256(receipt_path)
        write(manifest_path, json.dumps(manifest, indent=2) + "\n")
        self.personal_commit = commit_all(
            self.personal,
            "bind self-asserted pnpm identity",
        )

        with self.assertRaisesRegex(
            release.ReleaseError,
            "selected pnpm package differs from the authority build receipt",
        ):
            self.prepare()

    def test_prepare_rejects_path_dependent_authority_builds(self) -> None:
        build_script = (
            self.authority
            / "scripts"
            / "release"
            / "build-kersor-distribution.mjs"
        )
        write(
            build_script,
            "import { mkdirSync, rmSync, writeFileSync } from 'node:fs'\n"
            "for (const name of ['kersor', 'kersor-viewer', 'ui-kersor-viewer']) {\n"
            "  const root = `packages/extensions/${name}`\n"
            "  rmSync(`${root}/lib`, { recursive: true, force: true })\n"
            "  mkdirSync(`${root}/lib`, { recursive: true })\n"
            "  mkdirSync(`${root}/lib/types`, { recursive: true })\n"
            "  writeFileSync(`${root}/lib/index.js`, `export const cwd = ${JSON.stringify(process.cwd())}\\n`)\n"
            "  writeFileSync(`${root}/lib/types/index.d.ts`, `export const cwd = ${JSON.stringify(process.cwd())}\\n`)\n"
            "}\n",
        )
        expected = f"export const cwd = {json.dumps(str(self.authority.resolve()))}\n"
        receipt_path = (
            self.authority
            / "release"
            / "kersor-distribution-build-receipt.json"
        )
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        script_input = next(
            item
            for item in receipt["inputs"]
            if item["path"] == "scripts/release/build-kersor-distribution.mjs"
        )
        script_input.update({
            "git_blob_sha256": file_sha256(build_script),
            "size": build_script.stat().st_size,
            "mode": stat.S_IMODE(build_script.stat().st_mode),
        })
        receipt["inputs_sha256"] = hashlib.sha256(
            release.canonical_json(receipt["inputs"])
        ).hexdigest()
        for output in receipt["outputs"]:
            output.update({
                "sha256": hashlib.sha256(expected.encode("utf-8")).hexdigest(),
                "size": len(expected.encode("utf-8")),
                "mode": 0o644,
            })
        receipt["outputs_sha256"] = hashlib.sha256(
            release.canonical_json(receipt["outputs"])
        ).hexdigest()
        write(receipt_path, json.dumps(receipt, indent=2) + "\n")
        self.authority_commit = commit_all(self.authority, "path dependent build")

        manifest_path = self.personal / "plugins" / "dsh-mirror.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["authority"]["revision"] = self.authority_commit
        manifest["build_receipt"]["sha256"] = file_sha256(receipt_path)
        for entry in manifest["files"]:
            if entry["origin"] != "derived-build":
                continue
            personal_output = self.personal / entry["path"]
            write(personal_output, expected)
            entry["sha256"] = file_sha256(personal_output)
        write(manifest_path, json.dumps(manifest, indent=2) + "\n")
        self.personal_commit = commit_all(self.personal, "path dependent outputs")

        with self.assertRaisesRegex(
            release.ReleaseError,
            "contains its staging path",
        ):
            self.prepare()

    def test_prepare_rejects_empty_mirror_inventory(self) -> None:
        manifest_path = self.personal / "plugins" / "dsh-mirror.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["files"] = []
        write(manifest_path, json.dumps(manifest, indent=2) + "\n")
        self.personal_commit = commit_all(self.personal, "empty mirror inventory")

        with self.assertRaisesRegex(
            release.ReleaseError,
            "complete package tree",
        ):
            self.prepare()

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
            {"node", "pnpm", "pnpm_package", "dsh_bin"},
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
        tampered_receipt = json.loads(json.dumps(persisted_receipt))
        tampered_receipt["tools"]["pnpm_package"]["tree"][
            "tree_sha256"
        ] = "0" * 64
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
            any("pnpm package identity" in item for item in violations),
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
