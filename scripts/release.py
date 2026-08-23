#!/usr/bin/env python3
"""Build and verify detached KerSor release artifacts for DSH.

The release path is deliberately separate from the developer installation in
``scripts/install.py``.  Release materialization reads explicit Git objects,
expands the superproject's pinned submodules, and rejects directory-backed or
inode-shared profile packages.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from typing import Iterable, Iterator


ROOT = Path(__file__).resolve().parents[1]
FULL_COMMIT = re.compile(r"[0-9a-f]{40}")
RELEASE_SCHEMA_VERSION = 1
MIRROR_SCHEMA_VERSION = 2
MIRROR_PATH = Path("plugins/dsh-mirror.json")
BUILD_RECEIPT_PATH = "release/kersor-distribution-build-receipt.json"
BUILD_RECEIPT_TYPE = "kersor-distribution-build"
BUILD_RECIPE_ID = "dsh-kersor-distribution-build-v1"
MIRROR_PACKAGES = ("kersor", "kersor-viewer", "ui-kersor-viewer")
AUTHORITY_INSTALL_RECIPE = [
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
]
AUTHORITY_BUILD_RECIPE = [
    "node",
    "scripts/release/build-kersor-distribution.mjs",
]
PACKAGE_PATHS = {
    "@deepseek-ai/dsh-kersor": Path("plugins/kersor"),
    "@deepseek-ai/dsh-kersor-viewer": Path("plugins/kersor-viewer"),
    "@deepseek-ai/dsh-client-ui-kersor-viewer": Path(
        "plugins/ui-kersor-viewer"
    ),
    "@qhy991/dsh-kersor-web": Path("bundles/kersor-web"),
}
WEB_BUNDLE_NAME = "@qhy991/dsh-kersor-web"


class ReleaseError(RuntimeError):
    """A source snapshot, artifact, or installed tree violated release policy."""


def canonical_json(value: object) -> bytes:
    """Return deterministic UTF-8 JSON bytes for hashing."""
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    """Return a lowercase SHA-256 digest."""
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    """Hash one regular file without following a final symlink."""
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode):
        raise ReleaseError(f"expected a regular file: {path}")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_relative(raw: str, label: str) -> Path:
    relative = PurePosixPath(raw)
    if relative.is_absolute() or not relative.parts or ".." in relative.parts:
        raise ReleaseError(f"{label} escapes its snapshot: {raw}")
    return Path(*relative.parts)


def _walk_without_links(root: Path) -> Iterator[Path]:
    """Yield a tree without following links, including linked entries."""
    if root.is_symlink():
        yield root
        return
    if not root.is_dir():
        return
    for current, directories, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        for name in sorted((*directories, *files)):
            yield current_path / name


def tree_receipt(
    root: Path,
    *,
    excluded: Iterable[str] = (),
) -> dict[str, object]:
    """Describe every regular file in one symlink-free directory tree."""
    root = root.absolute()
    if root.is_symlink() or not root.is_dir():
        raise ReleaseError(f"tree root must be a physical directory: {root}")
    excluded_paths = set(excluded)
    files: list[dict[str, object]] = []
    for path in _walk_without_links(root):
        metadata = path.lstat()
        relative = path.relative_to(root).as_posix()
        if relative in excluded_paths:
            continue
        if stat.S_ISLNK(metadata.st_mode):
            raise ReleaseError(f"release tree contains a symbolic link: {relative}")
        if stat.S_ISDIR(metadata.st_mode):
            continue
        if not stat.S_ISREG(metadata.st_mode):
            raise ReleaseError(f"release tree contains a non-regular file: {relative}")
        files.append({
            "path": relative,
            "mode": stat.S_IMODE(metadata.st_mode),
            "size": metadata.st_size,
            "sha256": sha256_file(path),
        })
    files.sort(key=lambda item: str(item["path"]))
    return {
        "schema_version": 1,
        "files": files,
        "tree_sha256": sha256_bytes(canonical_json(files)),
    }


def verify_tree_receipt(
    root: Path,
    expected: object,
    label: str,
    *,
    excluded: Iterable[str] = (),
) -> list[str]:
    """Return inventory, mode, and content violations for a tree receipt."""
    if not isinstance(expected, dict) or expected.get("schema_version") != 1:
        return [f"{label}: receipt is invalid"]
    try:
        actual = tree_receipt(root, excluded=excluded)
    except (OSError, ReleaseError) as error:
        return [f"{label}: {error}"]
    expected_files = expected.get("files")
    if not isinstance(expected_files, list):
        return [f"{label}: receipt files are invalid"]
    expected_by_path = {
        entry.get("path"): entry
        for entry in expected_files
        if isinstance(entry, dict) and isinstance(entry.get("path"), str)
    }
    actual_by_path = {
        entry["path"]: entry
        for entry in actual["files"]
        if isinstance(entry, dict)
    }
    violations: list[str] = []
    for path in sorted(set(expected_by_path) - set(actual_by_path)):
        violations.append(f"{label}: missing file {path}")
    for path in sorted(set(actual_by_path) - set(expected_by_path)):
        violations.append(f"{label}: unexpected file {path}")
    for path in sorted(set(expected_by_path) & set(actual_by_path)):
        wanted = expected_by_path[path]
        found = actual_by_path[path]
        if wanted.get("sha256") != found.get("sha256"):
            violations.append(f"{label}: content differs for {path}")
        if wanted.get("mode") != found.get("mode"):
            violations.append(f"{label}: mode differs for {path}")
        if wanted.get("size") != found.get("size"):
            violations.append(f"{label}: size differs for {path}")
    if expected.get("tree_sha256") != actual.get("tree_sha256"):
        violations.append(f"{label}: tree digest differs")
    return violations


def copy_detached_tree(source: Path, destination: Path) -> None:
    """Copy a physical tree while guaranteeing new regular-file inodes."""
    aliases = filesystem_alias_violations([source], [])
    link_violations = [item for item in aliases if "symbolic link" in item]
    if link_violations:
        raise ReleaseError("; ".join(link_violations))
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copytree(
        source,
        destination,
        dirs_exist_ok=True,
        copy_function=shutil.copy2,
    )


def _regular_inode_set(roots: Iterable[Path]) -> set[tuple[int, int]]:
    result: set[tuple[int, int]] = set()
    for root in roots:
        if not root.exists() or root.is_symlink():
            continue
        for path in _walk_without_links(root):
            metadata = path.lstat()
            if stat.S_ISREG(metadata.st_mode):
                result.add((metadata.st_dev, metadata.st_ino))
    return result


def filesystem_alias_violations(
    installed_roots: Iterable[Path],
    source_roots: Iterable[Path],
) -> list[str]:
    """Reject symlinks, multiply-linked files, and source inode aliases."""
    source_inodes = _regular_inode_set(source_roots)
    violations: list[str] = []
    for root in installed_roots:
        if root.is_symlink():
            violations.append(f"{root}: installed root is a symbolic link")
            continue
        if not root.is_dir():
            violations.append(f"{root}: installed root is missing")
            continue
        for path in _walk_without_links(root):
            metadata = path.lstat()
            if stat.S_ISLNK(metadata.st_mode):
                violations.append(f"{path}: installed entry is a symbolic link")
                continue
            if not stat.S_ISREG(metadata.st_mode):
                continue
            if metadata.st_nlink != 1:
                violations.append(
                    f"{path}: installed regular file has multiple links "
                    f"({metadata.st_nlink})"
                )
            if (metadata.st_dev, metadata.st_ino) in source_inodes:
                violations.append(f"{path}: installed file shares a source inode")
    return violations


def profile_dependency_violations(profile: Path) -> list[str]:
    """Reject live directory dependency specs in one DSH profile."""
    violations: list[str] = []
    manifest_path = profile / "package.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return [f"profile manifest is unavailable: {error}"]
    dependencies = manifest.get("dependencies")
    if not isinstance(dependencies, dict):
        dependencies = {}
    bundle_spec = dependencies.get(WEB_BUNDLE_NAME)
    if not isinstance(bundle_spec, str) or not bundle_spec.startswith("file:") \
            or not bundle_spec.endswith(".tgz"):
        violations.append(
            f"{WEB_BUNDLE_NAME}: release dependency must be a file: tarball"
        )
    lock_path = profile / "pnpm-lock.yaml"
    try:
        lock = lock_path.read_text(encoding="utf-8")
    except OSError as error:
        violations.append(f"profile lock is unavailable: {error}")
    else:
        if re.search(r"\btype:\s*directory\b", lock) or re.search(
            r"resolution:\s*\{\s*directory:",
            lock,
        ):
            violations.append("profile lock contains a live directory resolution")
        if re.search(r"(?:^|\s)link:", lock):
            violations.append("profile lock contains a live link dependency")
    return violations


def profile_local_resolution_violations(
    profile: Path,
    package_names: Iterable[str],
) -> list[str]:
    """Require every selected package to resolve inside profile/node_modules."""
    violations: list[str] = []
    modules = profile / "node_modules"
    for package_name in package_names:
        package = modules.joinpath(*package_name.split("/"))
        manifest = package / "package.json"
        if package.is_symlink() or not manifest.is_file():
            violations.append(
                f"{package_name}: package is not installed profile-local"
            )
            continue
        try:
            physical = manifest.resolve(strict=True)
            physical.relative_to(modules.resolve(strict=True))
        except (OSError, ValueError):
            violations.append(
                f"{package_name}: package resolution escapes profile-local node_modules"
            )
    return violations


def require_reconciled_mirror(snapshot: Path, authority_commit: str) -> dict[str, object]:
    """Load a mirror manifest that names one reconciled authority commit."""
    if FULL_COMMIT.fullmatch(authority_commit) is None:
        raise ReleaseError("authority commit must be 40 lowercase hexadecimal characters")
    path = snapshot / MIRROR_PATH
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ReleaseError(f"cannot read mirror manifest: {error}") from error
    if not isinstance(manifest, dict) or manifest.get("schema_version") != \
            MIRROR_SCHEMA_VERSION:
        raise ReleaseError("mirror manifest schema is invalid")
    authority = manifest.get("authority")
    if not isinstance(authority, dict):
        raise ReleaseError("mirror authority is invalid")
    if authority.get("reconciled") is not True:
        raise ReleaseError("release requires mirror authority.reconciled=true")
    if authority.get("revision") != authority_commit:
        raise ReleaseError("mirror authority revision differs from the release commit")
    if not isinstance(manifest.get("files"), list):
        raise ReleaseError("mirror file inventory is invalid")
    return manifest


def _derived_source_path(path: Path) -> Path | None:
    """Map one personal lib path to its only allowed authority output path."""
    parts = path.parts
    if len(parts) < 4 or parts[0] != "plugins" \
            or parts[1] not in MIRROR_PACKAGES or parts[2] != "lib":
        return None
    return Path("packages", "extensions", *parts[1:])


def _mirror_package_files(snapshot: Path) -> dict[str, Path]:
    """Return the complete regular-file inventory of the three mirror packages."""
    result: dict[str, Path] = {}
    for package in MIRROR_PACKAGES:
        root = snapshot / "plugins" / package
        if root.is_symlink() or not root.is_dir():
            raise ReleaseError(f"mirror package root is unavailable: {root}")
        for path in _walk_without_links(root):
            metadata = path.lstat()
            relative = path.relative_to(snapshot).as_posix()
            if stat.S_ISDIR(metadata.st_mode):
                continue
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
                raise ReleaseError(f"mirror package tree contains a link or special file: {relative}")
            result[relative] = path
    return result


def _require_complete_mirror_inventory(
    snapshot: Path,
    entries: object,
) -> dict[str, Path]:
    """Require the manifest and physical package trees to be an exact bijection."""
    if not isinstance(entries, list) or not entries:
        raise ReleaseError("mirror manifest does not cover the complete package tree")
    listed: list[str] = []
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            raise ReleaseError(f"mirror files[{index}].path is invalid")
        relative = _safe_relative(entry["path"], f"mirror files[{index}].path")
        parts = relative.parts
        if len(parts) < 3 or parts[0] != "plugins" \
                or parts[1] not in MIRROR_PACKAGES:
            raise ReleaseError(f"mirror files[{index}].path is outside package trees")
        listed.append(entry["path"])
    if listed != sorted(listed) or len(listed) != len(set(listed)):
        raise ReleaseError("mirror file inventory must be sorted and unique")
    actual = _mirror_package_files(snapshot)
    if set(listed) != set(actual):
        missing = sorted(set(actual) - set(listed))
        extra = sorted(set(listed) - set(actual))
        details = [*(f"unlisted {path}" for path in missing), *(
            f"missing {path}" for path in extra
        )]
        raise ReleaseError(
            "mirror manifest does not cover the complete package tree: "
            + ", ".join(details)
        )
    return actual


def _authority_build_receipt(
    manifest: dict[str, object],
    authority_repository: Path,
    authority_commit: str,
    authority_snapshot: Path,
) -> tuple[
    dict[str, object],
    dict[str, object],
    dict[str, dict[str, object]],
]:
    """Load and validate the build receipt committed by the DSH authority."""
    binding = manifest.get("build_receipt")
    if not isinstance(binding, dict):
        raise ReleaseError("mirror build receipt binding is invalid")
    if binding.get("path") != BUILD_RECEIPT_PATH:
        raise ReleaseError("mirror build receipt path is invalid")
    expected_blob_hash = binding.get("sha256")
    if not isinstance(expected_blob_hash, str) or re.fullmatch(
        r"[0-9a-f]{64}", expected_blob_hash
    ) is None:
        raise ReleaseError("mirror build receipt hash is invalid")
    if binding.get("recipe_id") != BUILD_RECIPE_ID:
        raise ReleaseError("mirror build receipt recipe is invalid")

    receipt_bytes = _git_bytes(
        authority_repository,
        "show",
        f"{authority_commit}:{BUILD_RECEIPT_PATH}",
    )
    if sha256_bytes(receipt_bytes) != expected_blob_hash:
        raise ReleaseError("authority build receipt differs from the mirror binding")
    try:
        receipt = json.loads(receipt_bytes.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ReleaseError(f"authority build receipt is invalid JSON: {error}") from error
    if not isinstance(receipt, dict) or receipt.get("schema_version") != 1 \
            or receipt.get("receipt_type") != BUILD_RECEIPT_TYPE:
        raise ReleaseError("authority build receipt schema is invalid")
    recipe = receipt.get("recipe")
    if not isinstance(recipe, dict) or set(recipe) != {
        "id",
        "node",
        "pnpm",
        "install",
        "command",
    } or recipe.get("id") != BUILD_RECIPE_ID:
        raise ReleaseError("authority build receipt recipe is invalid")
    if recipe.get("install") != AUTHORITY_INSTALL_RECIPE \
            or recipe.get("command") != AUTHORITY_BUILD_RECIPE:
        raise ReleaseError("authority build receipt commands are not canonical")
    tools = receipt.get("tools")
    if not isinstance(tools, dict) or set(tools) != {"node", "pnpm"}:
        raise ReleaseError("authority build receipt tools are invalid")
    expected_node_tool = {"version": recipe.get("node")}
    pnpm_tool = tools.get("pnpm")
    if tools.get("node") != expected_node_tool \
            or not isinstance(pnpm_tool, dict) \
            or set(pnpm_tool) != {"version", "tree"} \
            or pnpm_tool.get("version") != recipe.get("pnpm"):
        raise ReleaseError("authority build receipt tools are not canonical")
    validate_portable_tree_receipt(
        pnpm_tool.get("tree"),
        "authority pnpm package tree",
    )
    if receipt.get("tools_sha256") != sha256_bytes(canonical_json(tools)):
        raise ReleaseError("authority build receipt tool digest differs")
    toolchain = manifest.get("toolchain")
    if not isinstance(toolchain, dict) or {
        "node": recipe.get("node"),
        "pnpm": recipe.get("pnpm"),
    } != toolchain:
        raise ReleaseError("mirror toolchain differs from the authority build receipt")

    inputs = receipt.get("inputs")
    if not isinstance(inputs, list) or not inputs:
        raise ReleaseError("authority build receipt inputs are invalid")
    if receipt.get("inputs_sha256") != sha256_bytes(canonical_json(inputs)):
        raise ReleaseError("authority build receipt input digest differs")
    input_paths: list[str] = []
    required_inputs = {
        "package.json",
        "apps/cli/package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        AUTHORITY_BUILD_RECIPE[1],
        "tsconfig.base.json",
        "tsconfig.base.client.json",
        "tsconfig.host.json",
        "tsdown.config.ts",
    }
    for package_manifest in authority_snapshot.rglob("package.json"):
        if package_manifest.is_symlink() or not package_manifest.is_file():
            raise ReleaseError(
                "authority snapshot contains an invalid package.json input"
            )
        required_inputs.add(
            package_manifest.relative_to(authority_snapshot).as_posix()
        )
    cli_root = authority_snapshot / "apps" / "cli"
    if cli_root.is_symlink() or not cli_root.is_dir():
        raise ReleaseError("authority snapshot omits the canonical apps/cli closure")
    for cli_input in _walk_without_links(cli_root):
        metadata = cli_input.lstat()
        if stat.S_ISDIR(metadata.st_mode):
            continue
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise ReleaseError("authority apps/cli closure contains a link")
        required_inputs.add(cli_input.relative_to(authority_snapshot).as_posix())
    for index, input_file in enumerate(inputs):
        if not isinstance(input_file, dict):
            raise ReleaseError(f"authority build receipt inputs[{index}] is invalid")
        raw_path = input_file.get("path")
        digest = input_file.get("git_blob_sha256")
        size = input_file.get("size")
        mode = input_file.get("mode")
        if not isinstance(raw_path, str):
            raise ReleaseError(f"authority build receipt inputs[{index}].path is invalid")
        relative = _safe_relative(
            raw_path,
            f"authority build receipt inputs[{index}].path",
        )
        if relative.as_posix() == BUILD_RECEIPT_PATH:
            raise ReleaseError("authority build receipt cannot list itself as an input")
        if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
            raise ReleaseError(f"authority build input hash is invalid: {raw_path}")
        if type(size) is not int or size < 0:
            raise ReleaseError(f"authority build input size is invalid: {raw_path}")
        if type(mode) is not int or mode not in {0o644, 0o755}:
            raise ReleaseError(f"authority build input mode is invalid: {raw_path}")
        path = authority_snapshot / relative
        if path.is_symlink() or not path.is_file():
            raise ReleaseError(f"authority build input is absent: {raw_path}")
        metadata = path.stat()
        if sha256_file(path) != digest or metadata.st_size != size:
            raise ReleaseError(f"authority build input differs from commit: {raw_path}")
        if mode != stat.S_IMODE(metadata.st_mode):
            raise ReleaseError(f"authority build input mode differs: {raw_path}")
        input_paths.append(raw_path)
    if input_paths != sorted(input_paths) or len(input_paths) != len(set(input_paths)):
        raise ReleaseError("authority build receipt inputs are not sorted and unique")
    if not required_inputs.issubset(input_paths):
        raise ReleaseError("authority build receipt omits canonical build inputs")

    outputs = receipt.get("outputs")
    if not isinstance(outputs, list) or not outputs:
        raise ReleaseError("authority build receipt outputs are invalid")
    if receipt.get("outputs_sha256") != sha256_bytes(canonical_json(outputs)):
        raise ReleaseError("authority build receipt output digest differs")
    by_path: dict[str, dict[str, object]] = {}
    listed_paths: list[str] = []
    for index, output in enumerate(outputs):
        if not isinstance(output, dict):
            raise ReleaseError(f"authority build receipt outputs[{index}] is invalid")
        raw_path = output.get("path")
        digest = output.get("sha256")
        size = output.get("size")
        mode = output.get("mode")
        if not isinstance(raw_path, str):
            raise ReleaseError(
                f"authority build receipt outputs[{index}].path is invalid"
            )
        relative = _safe_relative(
            raw_path,
            f"authority build receipt outputs[{index}].path",
        )
        parts = relative.parts
        if len(parts) < 5 or parts[:2] != ("packages", "extensions") \
                or parts[2] not in MIRROR_PACKAGES or parts[3] != "lib":
            raise ReleaseError(f"authority build output is outside KerSor lib: {raw_path}")
        if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
            raise ReleaseError(f"authority build output hash is invalid: {raw_path}")
        if type(size) is not int or size < 0:
            raise ReleaseError(f"authority build output size is invalid: {raw_path}")
        if type(mode) is not int or mode not in {0o644, 0o755}:
            raise ReleaseError(f"authority build output mode is invalid: {raw_path}")
        listed_paths.append(raw_path)
        if raw_path in by_path:
            raise ReleaseError(f"authority build output is duplicated: {raw_path}")
        by_path[raw_path] = output
    if listed_paths != sorted(listed_paths):
        raise ReleaseError("authority build receipt outputs are not sorted")
    return binding, receipt, by_path


def _authority_tracked_mirror_files(
    authority_snapshot: Path,
) -> dict[str, str]:
    """Map the complete tracked authority package surface into personal paths."""
    result: dict[str, str] = {}
    for package in MIRROR_PACKAGES:
        package_root = authority_snapshot / "packages" / "extensions" / package
        if package_root.is_symlink() or not package_root.is_dir():
            raise ReleaseError(f"authority package root is unavailable: {package}")
        for path in _walk_without_links(package_root):
            metadata = path.lstat()
            source = path.relative_to(authority_snapshot)
            if stat.S_ISDIR(metadata.st_mode):
                continue
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
                raise ReleaseError(
                    f"authority package tree contains a link or special file: {source}"
                )
            package_relative = path.relative_to(package_root)
            if package_relative == Path("package.json"):
                continue
            if package_relative.parts[0] == "lib":
                raise ReleaseError(
                    f"authority unexpectedly tracks a build output: {source}"
                )
            personal = Path("plugins", package, package_relative).as_posix()
            result[personal] = source.as_posix()
    return result


def _tool_identity(
    path: Path,
    version_arguments: list[str],
    *,
    path_tools: Iterable[Path] = (),
) -> dict[str, object]:
    """Freeze one executable's requested path, physical file, hash, and version."""
    requested = path.expanduser().absolute()
    try:
        physical = requested.resolve(strict=True)
        metadata = physical.stat()
    except OSError as error:
        raise ReleaseError(f"release tool is unavailable: {requested}: {error}") from error
    if not stat.S_ISREG(metadata.st_mode) or not os.access(physical, os.X_OK):
        raise ReleaseError(f"release tool is not executable: {physical}")
    path_parts = [
        str(physical.parent),
        *(str(tool.expanduser().resolve().parent) for tool in path_tools),
    ]
    node = shutil.which("node")
    if node is not None:
        path_parts.append(str(Path(node).resolve().parent))
    path_parts.extend(["/usr/bin", "/bin"])
    completed = subprocess.run(
        [str(requested), *version_arguments],
        check=False,
        capture_output=True,
        text=True,
        env={"PATH": os.pathsep.join(dict.fromkeys(path_parts)), "LANG": "C"},
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        raise ReleaseError(f"cannot identify release tool {requested}: {detail}")
    version = (completed.stdout or completed.stderr).strip().splitlines()
    if not version:
        raise ReleaseError(f"release tool printed no version: {requested}")
    identity = file_identity(requested)
    identity["version"] = version[0]
    return identity


def file_identity(path: Path) -> dict[str, object]:
    """Record one regular file's requested path and physical-byte identity."""
    requested = path.expanduser().absolute()
    try:
        physical = requested.resolve(strict=True)
        metadata = physical.stat()
    except OSError as error:
        raise ReleaseError(f"identity file is unavailable: {requested}: {error}") from error
    if not stat.S_ISREG(metadata.st_mode):
        raise ReleaseError(f"identity path is not a regular file: {physical}")
    return {
        "requested_path": str(requested),
        "realpath": str(physical),
        "sha256": sha256_file(physical),
        "mode": stat.S_IMODE(metadata.st_mode),
        "size": metadata.st_size,
        "platform": platform.system().lower(),
        "arch": platform.machine().lower(),
    }


def portable_tree_receipt(root: Path) -> dict[str, object]:
    """Hash a cross-platform regular-file tree without platform mode bits."""
    requested = root.expanduser().absolute()
    if requested.is_symlink() or not requested.is_dir():
        raise ReleaseError(
            f"portable tree root must be a physical directory: {requested}"
        )
    root = requested.resolve(strict=True)
    files: list[dict[str, object]] = []
    for path in _walk_without_links(root):
        metadata = path.lstat()
        relative = path.relative_to(root).as_posix()
        if stat.S_ISDIR(metadata.st_mode):
            continue
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise ReleaseError(
                f"portable tree contains a link or special file: {relative}"
            )
        files.append({
            "path": relative,
            "size": metadata.st_size,
            "sha256": sha256_file(path),
        })
    files.sort(key=lambda item: str(item["path"]))
    if not files:
        raise ReleaseError(f"portable tree contains no files: {root}")
    return {
        "schema_version": 1,
        "files": files,
        "tree_sha256": sha256_bytes(canonical_json(files)),
    }


def validate_portable_tree_receipt(value: object, label: str) -> None:
    """Validate the canonical cross-platform tree receipt schema."""
    if not isinstance(value, dict) or set(value) != {
        "schema_version",
        "files",
        "tree_sha256",
    } or value.get("schema_version") != 1:
        raise ReleaseError(f"{label} schema is invalid")
    files = value.get("files")
    if not isinstance(files, list) or not files:
        raise ReleaseError(f"{label} files are invalid")
    paths: list[str] = []
    for index, entry in enumerate(files):
        if not isinstance(entry, dict) or set(entry) != {"path", "size", "sha256"}:
            raise ReleaseError(f"{label} files[{index}] is invalid")
        raw_path = entry.get("path")
        size = entry.get("size")
        digest = entry.get("sha256")
        if not isinstance(raw_path, str):
            raise ReleaseError(f"{label} files[{index}].path is invalid")
        _safe_relative(raw_path, f"{label} files[{index}].path")
        if type(size) is not int or size < 0 \
                or not isinstance(digest, str) \
                or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
            raise ReleaseError(f"{label} files[{index}] metadata is invalid")
        paths.append(raw_path)
    if paths != sorted(paths) or len(paths) != len(set(paths)):
        raise ReleaseError(f"{label} paths are not sorted and unique")
    if value.get("tree_sha256") != sha256_bytes(canonical_json(files)):
        raise ReleaseError(f"{label} digest differs")


def pnpm_package_identity(pnpm: Path, version: str) -> dict[str, object]:
    """Identify the portable node_modules/pnpm package behind one wrapper."""
    wrapper = pnpm.expanduser().resolve(strict=True)
    candidates: set[Path] = set()
    ancestors = (wrapper.parent, *tuple(wrapper.parents)[:5])
    for ancestor in ancestors:
        for relative in (
            Path("node_modules/pnpm/bin/pnpm.mjs"),
            Path("node/node_modules/pnpm/bin/pnpm.mjs"),
            Path("lib/node_modules/pnpm/bin/pnpm.mjs"),
        ):
            candidate = ancestor / relative
            if candidate.is_symlink() or not candidate.is_file():
                continue
            candidates.add(candidate.resolve(strict=True))
    if len(candidates) != 1:
        raise ReleaseError(
            "cannot uniquely resolve pnpm's portable node_modules/pnpm/bin/pnpm.mjs "
            f"artifact from {wrapper}"
        )
    package_root = candidates.pop().parents[1]
    return {
        "requested_wrapper": str(pnpm.expanduser().absolute()),
        "realpath": str(package_root),
        "version": version,
        "platform": platform.system().lower(),
        "arch": platform.machine().lower(),
        "tree": portable_tree_receipt(package_root),
    }


def verify_pnpm_package_identity(expected: object, label: str) -> list[str]:
    """Re-hash a recorded pnpm package tree and report any drift."""
    if not isinstance(expected, dict) or not isinstance(expected.get("realpath"), str):
        return [f"{label}: identity receipt is invalid"]
    try:
        current_tree = portable_tree_receipt(Path(expected["realpath"]))
    except (OSError, ReleaseError) as error:
        return [f"{label}: identity is unavailable: {error}"]
    if current_tree != expected.get("tree") \
            or expected.get("platform") != platform.system().lower() \
            or expected.get("arch") != platform.machine().lower():
        return [f"{label}: pnpm package identity differs"]
    return []


def verify_file_identity(expected: object, label: str) -> list[str]:
    """Return a violation when a recorded physical file identity has drifted."""
    if not isinstance(expected, dict) or not isinstance(
        expected.get("requested_path"), str
    ):
        return [f"{label}: identity receipt is invalid"]
    try:
        current = file_identity(Path(expected["requested_path"]))
    except (OSError, ReleaseError) as error:
        return [f"{label}: identity is unavailable: {error}"]
    recorded = {
        key: expected.get(key)
        for key in (
            "requested_path",
            "realpath",
            "sha256",
            "mode",
            "size",
            "platform",
            "arch",
        )
    }
    if current != recorded:
        return [f"{label}: executable identity differs"]
    return []


def _dsh_bin_identity(node: Path, dsh_bin: Path) -> dict[str, object]:
    """Identify the DSH JavaScript entrypoint under the selected Node binary."""
    requested = dsh_bin.expanduser().absolute()
    try:
        physical = requested.resolve(strict=True)
    except OSError as error:
        raise ReleaseError(f"DSH entrypoint is unavailable: {requested}: {error}") from error
    if not physical.is_file():
        raise ReleaseError(f"DSH entrypoint is not a regular file: {physical}")
    completed = subprocess.run(
        [str(node), str(physical), "--version"],
        check=False,
        capture_output=True,
        text=True,
        env={
            "PATH": f"{node.resolve().parent}:/usr/bin:/bin",
            "LANG": "C",
        },
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        raise ReleaseError(f"cannot identify DSH entrypoint {requested}: {detail}")
    versions = (completed.stdout or completed.stderr).strip().splitlines()
    if not versions:
        raise ReleaseError(f"DSH entrypoint printed no version: {requested}")
    identity = file_identity(requested)
    identity["version"] = versions[0]
    return identity


def _verify_mirror_against_authority(
    personal_snapshot: Path,
    authority_repository: Path,
    authority_commit: str,
    authority_snapshot: Path,
) -> tuple[
    dict[str, object],
    dict[str, object],
    dict[str, object],
    dict[str, dict[str, object]],
]:
    """Verify every reconciled mirror byte against the named authority commit."""
    _require_commit(authority_repository, authority_commit)
    manifest = require_reconciled_mirror(personal_snapshot, authority_commit)
    package_files = _require_complete_mirror_inventory(
        personal_snapshot,
        manifest["files"],
    )
    receipt_binding, receipt, receipt_outputs = _authority_build_receipt(
        manifest,
        authority_repository,
        authority_commit,
        authority_snapshot,
    )
    used_outputs: set[str] = set()
    expected_tracked_files = _authority_tracked_mirror_files(
        authority_snapshot,
    )
    used_tracked_files: dict[str, str] = {}
    used_distribution_files: set[str] = set()
    expected_distribution_files = {
        f"plugins/{package}/package.json" for package in MIRROR_PACKAGES
    }
    listed_paths: list[str] = []
    for index, entry in enumerate(manifest["files"]):
        if not isinstance(entry, dict):
            raise ReleaseError(f"mirror files[{index}] must be an object")
        raw_path = entry.get("path")
        raw_source = entry.get("source")
        expected_hash = entry.get("sha256")
        origin = entry.get("origin")
        if not isinstance(raw_path, str) or not isinstance(expected_hash, str) \
                or origin not in {"tracked", "derived-build", "distribution-owned"}:
            raise ReleaseError(f"mirror files[{index}] is incomplete")
        relative = _safe_relative(raw_path, f"mirror files[{index}].path")
        listed_paths.append(raw_path)
        personal_file = package_files[raw_path]
        if sha256_file(personal_file) != expected_hash:
            raise ReleaseError(f"personal mirror differs from its manifest: {raw_path}")
        if origin == "distribution-owned":
            if raw_path not in expected_distribution_files \
                    or raw_source is not None or entry.get("receipt_output") is not None:
                raise ReleaseError(
                    f"distribution-owned mirror entry is invalid: {raw_path}"
                )
            used_distribution_files.add(raw_path)
            continue

        if not isinstance(raw_source, str):
            raise ReleaseError(f"mirror files[{index}].source is invalid")
        source = _safe_relative(raw_source, f"mirror files[{index}].source")
        expected_source = Path("packages", "extensions", *relative.parts[1:])
        if source != expected_source:
            raise ReleaseError(f"mirror source mapping is invalid: {raw_path}")
        derived_source = _derived_source_path(relative)
        if origin == "tracked":
            if entry.get("receipt_output") is not None:
                raise ReleaseError(f"tracked mirror entry references a build receipt: {raw_path}")
            authority_file = authority_snapshot / source
            if authority_file.is_symlink() or not authority_file.is_file() \
                    or sha256_file(authority_file) != expected_hash \
                    or stat.S_IMODE(authority_file.stat().st_mode) != \
                    stat.S_IMODE(personal_file.stat().st_mode):
                raise ReleaseError(
                    f"personal mirror differs from authority commit: {raw_path}"
                )
            used_tracked_files[raw_path] = raw_source
            continue

        if derived_source is None or source != derived_source:
            raise ReleaseError(f"derived mirror entry is outside KerSor lib: {raw_path}")
        receipt_output = entry.get("receipt_output")
        if receipt_output != source.as_posix():
            raise ReleaseError(f"derived mirror entry has no matching receipt output: {raw_path}")
        if (authority_snapshot / source).exists():
            raise ReleaseError(f"derived mirror output is tracked by authority: {raw_source}")
        output = receipt_outputs.get(receipt_output)
        if output is None:
            raise ReleaseError(f"authority build receipt omits mirror output: {raw_source}")
        metadata = personal_file.stat()
        if output.get("sha256") != expected_hash \
                or output.get("size") != metadata.st_size \
                or output.get("mode") != stat.S_IMODE(metadata.st_mode):
            raise ReleaseError(f"personal mirror differs from authority build: {raw_path}")
        used_outputs.add(receipt_output)
    if listed_paths != sorted(listed_paths) or len(listed_paths) != len(set(listed_paths)):
        raise ReleaseError("mirror file inventory must be sorted and unique")
    if used_distribution_files != expected_distribution_files:
        raise ReleaseError(
            "mirror package.json files must be distribution-owned by the personal commit"
        )
    if used_tracked_files != expected_tracked_files:
        missing = sorted(set(expected_tracked_files) - set(used_tracked_files))
        extra = sorted(set(used_tracked_files) - set(expected_tracked_files))
        raise ReleaseError(
            "tracked authority files absent from the mirror: "
            + ", ".join([
                *(f"missing {path}" for path in missing),
                *(f"unexpected {path}" for path in extra),
            ])
        )
    orphaned_outputs = sorted(set(receipt_outputs) - used_outputs)
    if orphaned_outputs:
        raise ReleaseError(
            "authority build receipt has outputs absent from the mirror: "
            + ", ".join(orphaned_outputs)
        )
    return manifest, receipt_binding, receipt, receipt_outputs


def _run_authority_command(
    command: list[str],
    *,
    cwd: Path,
    environment: dict[str, str],
    label: str,
) -> None:
    completed = subprocess.run(
        command,
        cwd=cwd,
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        umask=0o022,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        raise ReleaseError(f"{label} failed: {detail}")


def _rebuild_authority_outputs(
    *,
    authority_repository: Path,
    authority_commit: str,
    authority_snapshot: Path,
    build_home: Path,
    receipt_binding: dict[str, object],
    receipt: dict[str, object],
    receipt_outputs: dict[str, dict[str, object]],
    node: Path,
    pnpm: Path,
) -> dict[str, object]:
    """Rebuild ignored lib outputs from one clean, exact authority snapshot."""
    for raw_path in receipt_outputs:
        if (authority_snapshot / raw_path).exists():
            raise ReleaseError(
                f"clean authority snapshot unexpectedly contains build output: {raw_path}"
            )

    build_home.mkdir(parents=True, mode=0o700)
    temporary = build_home / "tmp"
    temporary.mkdir(mode=0o700)
    empty_npm_config = build_home / "empty.npmrc"
    empty_npm_config.write_text("", encoding="utf-8")
    corepack_home = build_home / "corepack"
    pnpm_home = build_home / "pnpm"
    xdg_config = build_home / "xdg-config"
    xdg_cache = build_home / "xdg-cache"
    xdg_data = build_home / "xdg-data"
    xdg_state = build_home / "xdg-state"
    for directory in (
        corepack_home,
        pnpm_home,
        xdg_config,
        xdg_cache,
        xdg_data,
        xdg_state,
    ):
        directory.mkdir(mode=0o700)
    environment = {
        "HOME": str(build_home),
        "USERPROFILE": str(build_home),
        "TMPDIR": str(temporary),
        "PATH": os.pathsep.join([
            str(node.resolve().parent),
            "/usr/bin",
            "/bin",
        ]),
        "LANG": "C",
        "LC_ALL": "C",
        "CI": "1",
        "NODE_ENV": "production",
        "TZ": "UTC",
        "SOURCE_DATE_EPOCH": "0",
        "COREPACK_HOME": str(corepack_home),
        "PNPM_HOME": str(pnpm_home),
        "XDG_CONFIG_HOME": str(xdg_config),
        "XDG_CACHE_HOME": str(xdg_cache),
        "XDG_DATA_HOME": str(xdg_data),
        "XDG_STATE_HOME": str(xdg_state),
        "npm_config_userconfig": str(empty_npm_config),
        "npm_config_globalconfig": str(empty_npm_config),
        "npm_config_ignore_scripts": "true",
        "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0",
    }
    pnpm_store_setting = os.environ.get("PNPM_CONFIG_STORE_DIR")
    if pnpm_store_setting:
        pnpm_store = Path(pnpm_store_setting).expanduser().absolute()
        if pnpm_store.is_symlink() or not pnpm_store.is_dir():
            raise ReleaseError(
                "PNPM_CONFIG_STORE_DIR must name a physical package store"
            )
        environment["PNPM_CONFIG_STORE_DIR"] = str(
            pnpm_store.resolve(strict=True)
        )
    _run_authority_command(
        [str(pnpm), *AUTHORITY_INSTALL_RECIPE[1:]],
        cwd=authority_snapshot,
        environment=environment,
        label="frozen authority dependency install",
    )
    _run_authority_command(
        [str(node), *AUTHORITY_BUILD_RECIPE[1:]],
        cwd=authority_snapshot,
        environment=environment,
        label="clean authority build",
    )

    built: dict[str, Path] = {}
    for package in MIRROR_PACKAGES:
        lib = authority_snapshot / "packages" / "extensions" / package / "lib"
        if lib.is_symlink() or not lib.is_dir():
            raise ReleaseError(f"clean authority build omitted lib tree: {package}")
        for path in _walk_without_links(lib):
            metadata = path.lstat()
            relative = path.relative_to(authority_snapshot).as_posix()
            if stat.S_ISDIR(metadata.st_mode):
                continue
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
                raise ReleaseError(
                    f"clean authority build produced a link or special file: {relative}"
                )
            built[relative] = path
    if set(built) != set(receipt_outputs):
        missing = sorted(set(receipt_outputs) - set(built))
        extra = sorted(set(built) - set(receipt_outputs))
        raise ReleaseError(
            "clean authority build output inventory differs: "
            + ", ".join([
                *(f"missing {path}" for path in missing),
                *(f"unexpected {path}" for path in extra),
            ])
        )
    snapshot_marker = str(authority_snapshot).encode("utf-8")
    for raw_path, expected in receipt_outputs.items():
        path = built[raw_path]
        content = path.read_bytes()
        metadata = path.stat()
        if snapshot_marker in content:
            raise ReleaseError(
                f"clean authority build output contains its staging path: {raw_path}"
            )
        if sha256_bytes(content) != expected.get("sha256") \
                or len(content) != expected.get("size") \
                or stat.S_IMODE(metadata.st_mode) != expected.get("mode"):
            raise ReleaseError(
                f"clean authority build differs from committed receipt: {raw_path}"
            )
    receipt_inputs = receipt.get("inputs")
    if not isinstance(receipt_inputs, list):
        raise ReleaseError("authority build receipt inputs are invalid")
    for input_file in receipt_inputs:
        if not isinstance(input_file, dict) or not isinstance(input_file.get("path"), str):
            raise ReleaseError("authority build receipt input is invalid")
        path = authority_snapshot / input_file["path"]
        if path.is_symlink() or not path.is_file():
            raise ReleaseError(
                f"clean authority build changed an input: {input_file['path']}"
            )
        metadata = path.stat()
        if sha256_file(path) != input_file.get("git_blob_sha256") \
                or metadata.st_size != input_file.get("size") \
                or stat.S_IMODE(metadata.st_mode) != input_file.get("mode"):
            raise ReleaseError(
                f"clean authority build changed an input: {input_file['path']}"
            )
    tree_oid = _git_bytes(
        authority_repository,
        "rev-parse",
        f"{authority_commit}^{{tree}}",
    ).decode("ascii").strip()
    return {
        "authority_commit": authority_commit,
        "authority_tree_oid": tree_oid,
        "receipt": receipt_binding,
        "recipe_id": BUILD_RECIPE_ID,
        "inputs_sha256": receipt["inputs_sha256"],
        "outputs_sha256": receipt["outputs_sha256"],
        "pnpm_lock_sha256": sha256_file(authority_snapshot / "pnpm-lock.yaml"),
        "initial_outputs_absent": True,
        "clean_rebuild_passed": True,
    }


def tarball_receipt(path: Path) -> dict[str, object]:
    """Describe the regular package files in one npm-compatible tarball."""
    files: list[dict[str, object]] = []
    try:
        stream = tarfile.open(path, mode="r:gz")
    except (OSError, tarfile.TarError) as error:
        raise ReleaseError(f"cannot read package tarball {path}: {error}") from error
    with stream:
        for member in stream.getmembers():
            name = member.name.rstrip("/")
            if not name:
                continue
            relative = _safe_relative(name, "package tarball entry")
            if relative.parts[0] != "package":
                raise ReleaseError(f"tarball entry is outside package/: {member.name}")
            if member.isdir():
                continue
            if not member.isfile():
                raise ReleaseError(
                    f"package tarball contains a link or special file: {member.name}"
                )
            extracted = stream.extractfile(member)
            if extracted is None:
                raise ReleaseError(f"cannot read package tarball entry: {member.name}")
            content = extracted.read()
            files.append({
                "path": Path(*relative.parts[1:]).as_posix(),
                "mode": member.mode & 0o777,
                "size": len(content),
                "sha256": sha256_bytes(content),
            })
    files.sort(key=lambda item: str(item["path"]))
    return {
        "schema_version": 1,
        "files": files,
        "tree_sha256": sha256_bytes(canonical_json(files)),
    }


def tarball_json_file(path: Path, member_name: str) -> dict[str, object]:
    """Read one JSON object from a regular member of a package tarball."""
    try:
        with tarfile.open(path, mode="r:gz") as stream:
            member = stream.getmember(member_name)
            if not member.isfile():
                raise ReleaseError(f"tarball member is not regular: {member_name}")
            extracted = stream.extractfile(member)
            if extracted is None:
                raise ReleaseError(f"cannot read tarball member: {member_name}")
            value = json.loads(extracted.read().decode("utf-8"))
    except (KeyError, OSError, UnicodeError, json.JSONDecodeError, tarfile.TarError) as error:
        raise ReleaseError(
            f"cannot read {member_name} from package tarball {path}: {error}"
        ) from error
    if not isinstance(value, dict):
        raise ReleaseError(f"tarball member must contain a JSON object: {member_name}")
    return value


def _publish_manifest(source: dict[str, object]) -> dict[str, object]:
    """Create the deterministic install contract used for detached tarballs."""
    manifest = json.loads(json.dumps(source, ensure_ascii=False))
    manifest.pop("devDependencies", None)

    def reject_workspace_protocol(value: object, field: str) -> None:
        if isinstance(value, str):
            if value.startswith("workspace:"):
                raise ReleaseError(
                    f"publish package manifest retains workspace protocol at {field}"
                )
            return
        if isinstance(value, list):
            for index, item in enumerate(value):
                reject_workspace_protocol(item, f"{field}[{index}]")
            return
        if isinstance(value, dict):
            for key, item in value.items():
                reject_workspace_protocol(item, f"{field}.{key}")

    reject_workspace_protocol(manifest, "package.json")
    return manifest


def _verify_package_tarball_traceability(
    *,
    package_name: str,
    package_root: Path,
    tarball: Path,
    tarball_tree: dict[str, object],
    mirror: dict[str, object],
) -> None:
    """Require every mirrored package tar member to come from the v2 union."""
    entries = mirror.get("files")
    if not isinstance(entries, list):
        raise ReleaseError("mirror file inventory is invalid")
    by_path = {
        entry.get("path"): entry
        for entry in entries
        if isinstance(entry, dict) and isinstance(entry.get("path"), str)
    }
    members = tarball_tree.get("files")
    if not isinstance(members, list):
        raise ReleaseError(f"{package_name} tarball receipt is invalid")
    source_prefix = PACKAGE_PATHS[package_name]
    for member in members:
        if not isinstance(member, dict) or not isinstance(member.get("path"), str):
            raise ReleaseError(f"{package_name} tarball member is invalid")
        relative = _safe_relative(member["path"], f"{package_name} tarball member")
        manifest_path = (source_prefix / relative).as_posix()
        entry = by_path.get(manifest_path)
        physical = package_root / relative
        if entry is None or not physical.is_file():
            raise ReleaseError(
                f"{package_name} tarball member is absent from the mirror union: "
                f"{member['path']}"
            )
        metadata = physical.stat()
        if relative == Path("package.json"):
            packaged_manifest = tarball_json_file(tarball, "package/package.json")
            try:
                source_manifest = json.loads(physical.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise ReleaseError(
                    f"{package_name} source package.json is invalid: {error}"
                ) from error
            # pnpm rewrites JSON whitespace during pack. The member remains
            # traceable when it equals the deterministic publish projection.
            member_matches = packaged_manifest == _publish_manifest(source_manifest) \
                and member.get("mode") == stat.S_IMODE(metadata.st_mode)
        else:
            member_matches = member.get("sha256") == entry.get("sha256") \
                and member.get("sha256") == sha256_file(physical) \
                and member.get("size") == metadata.st_size \
                and member.get("mode") == stat.S_IMODE(metadata.st_mode)
        if not member_matches:
            raise ReleaseError(
                f"{package_name} tarball member differs from the mirror union: "
                f"{member['path']}"
            )


def _pack_environment(home: Path, node: Path, pnpm: Path) -> dict[str, str]:
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = home / "tmp"
    temporary.mkdir(mode=0o700)
    path_parts = [str(pnpm.resolve().parent), str(node.resolve().parent)]
    path_parts.extend(["/usr/bin", "/bin"])
    return {
        "HOME": str(home),
        "TMPDIR": str(temporary),
        "PATH": os.pathsep.join(dict.fromkeys(path_parts)),
        "LANG": "C",
        "npm_config_ignore_scripts": "true",
        "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0",
    }


def _pack_package(
    package_root: Path,
    output: Path,
    pnpm: Path,
    environment: dict[str, str],
) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    completed = subprocess.run(
        [str(pnpm), "pack", "--out", str(output)],
        cwd=package_root,
        check=False,
        capture_output=True,
        text=True,
        env=environment,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        raise ReleaseError(f"pnpm pack failed for {package_root}: {detail}")
    if not output.is_file():
        raise ReleaseError(f"pnpm pack did not create {output}")


def _seal_read_only(root: Path) -> None:
    """Make a release subtree immutable to ordinary writes by its owner."""
    paths = list(_walk_without_links(root))
    for path in paths:
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            raise ReleaseError(f"cannot seal a symbolic link: {path}")
        if stat.S_ISREG(metadata.st_mode):
            executable = bool(stat.S_IMODE(metadata.st_mode) & 0o111)
            path.chmod(0o555 if executable else 0o444)
        elif not stat.S_ISDIR(metadata.st_mode):
            raise ReleaseError(f"cannot seal a special file: {path}")
    for path in sorted(
        (item for item in paths if item.is_dir()),
        key=lambda item: len(item.parts),
        reverse=True,
    ):
        path.chmod(0o555)
    root.chmod(0o555)


def _make_tree_writable(root: Path) -> None:
    """Restore owner write permission so a failed staging tree is removable."""
    try:
        root_metadata = root.lstat()
    except OSError:
        return
    if stat.S_ISLNK(root_metadata.st_mode) or not stat.S_ISDIR(root_metadata.st_mode):
        return
    paths = list(_walk_without_links(root))
    for path in paths:
        try:
            metadata = path.lstat()
            if stat.S_ISLNK(metadata.st_mode):
                continue
            if stat.S_ISDIR(metadata.st_mode):
                path.chmod(0o700)
            elif stat.S_ISREG(metadata.st_mode):
                path.chmod(0o600)
        except OSError:
            pass
    try:
        root.chmod(0o700)
    except OSError:
        pass


def _package_filename(name: str) -> str:
    return {
        "@deepseek-ai/dsh-kersor": "dsh-kersor.tgz",
        "@deepseek-ai/dsh-kersor-viewer": "dsh-kersor-viewer.tgz",
        "@deepseek-ai/dsh-client-ui-kersor-viewer": "dsh-client-ui-kersor-viewer.tgz",
        "@qhy991/dsh-kersor-web": "dsh-kersor-web.tgz",
    }[name]


def prepare_release(
    *,
    personal_repository: Path,
    personal_commit: str,
    core_repository: Path,
    core_commit: str,
    authority_repository: Path,
    authority_commit: str,
    destination: Path,
    node: Path,
    pnpm: Path,
) -> dict[str, object]:
    """Atomically create one read-only release from explicit Git commits."""
    destination = destination.expanduser().resolve()
    if destination.exists() or destination.is_symlink():
        raise ReleaseError(f"release destination already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    node_identity = _tool_identity(node, ["--version"])
    pnpm_identity = _tool_identity(pnpm, ["--version"], path_tools=[node])
    pnpm_package = pnpm_package_identity(pnpm, str(pnpm_identity["version"]))
    stage = Path(tempfile.mkdtemp(prefix=".kersor-release-", dir=destination.parent))
    try:
        personal = stage / "personal"
        core = stage / "core"
        authority_snapshot = stage / ".authority-source"
        materialize_git_snapshot(personal_repository, personal_commit, personal)
        materialize_git_snapshot(core_repository, core_commit, core)
        _materialize_authority_git_snapshot(
            authority_repository,
            authority_commit,
            authority_snapshot,
        )
        mirror, receipt_binding, receipt, receipt_outputs = (
            _verify_mirror_against_authority(
                personal,
                authority_repository,
                authority_commit,
                authority_snapshot,
            )
        )
        toolchain = mirror.get("toolchain")
        expected_node = toolchain.get("node") if isinstance(toolchain, dict) else None
        expected_pnpm = toolchain.get("pnpm") if isinstance(toolchain, dict) else None
        receipt_tools = receipt.get("tools")
        receipt_pnpm = receipt_tools.get("pnpm") \
            if isinstance(receipt_tools, dict) else None
        if not isinstance(receipt_pnpm, dict) \
                or pnpm_package["version"] != receipt_pnpm.get("version") \
                or pnpm_package["tree"] != receipt_pnpm.get("tree"):
            raise ReleaseError(
                "selected pnpm package differs from the authority build receipt"
            )
        actual_node = str(node_identity["version"]).removeprefix("v")
        if expected_node != actual_node:
            raise ReleaseError(
                "Node version differs from the reconciled mirror toolchain: "
                f"expected {expected_node!r}, got {actual_node!r}"
            )
        if expected_pnpm != pnpm_identity["version"]:
            raise ReleaseError(
                "pnpm version differs from the reconciled mirror toolchain: "
                f"expected {expected_pnpm!r}, got {pnpm_identity['version']!r}"
            )
        authority_home = stage / ".authority-home"
        authority_build = _rebuild_authority_outputs(
            authority_repository=authority_repository,
            authority_commit=authority_commit,
            authority_snapshot=authority_snapshot,
            build_home=authority_home,
            receipt_binding=receipt_binding,
            receipt=receipt,
            receipt_outputs=receipt_outputs,
            node=node,
            pnpm=pnpm,
        )
        shutil.rmtree(authority_snapshot)
        shutil.rmtree(authority_home)

        package_output = stage / "packages"
        package_output.mkdir()
        build_root = stage / ".package-build"
        pack_home = stage / ".pack-home"
        environment = _pack_environment(pack_home, node, pnpm)
        package_entries: list[dict[str, object]] = []
        tarballs: dict[str, Path] = {}
        for name in (
            "@deepseek-ai/dsh-kersor",
            "@deepseek-ai/dsh-kersor-viewer",
            "@deepseek-ai/dsh-client-ui-kersor-viewer",
        ):
            source = personal / PACKAGE_PATHS[name]
            build = build_root / PACKAGE_PATHS[name]
            copy_detached_tree(source, build)
            manifest = _read_json(build / "package.json", f"{name} package manifest")
            if manifest.get("name") != name or not isinstance(manifest.get("version"), str):
                raise ReleaseError(f"package identity differs at {source}")
            (build / "package.json").write_text(
                json.dumps(
                    _publish_manifest(manifest),
                    ensure_ascii=False,
                    indent=2,
                ) + "\n",
                encoding="utf-8",
            )
            output = package_output / _package_filename(name)
            _pack_package(build, output, pnpm, environment)
            package_tree = tarball_receipt(output)
            _verify_package_tarball_traceability(
                package_name=name,
                package_root=source,
                tarball=output,
                tarball_tree=package_tree,
                mirror=mirror,
            )
            tarballs[name] = output
            package_entries.append({
                "name": name,
                "version": manifest["version"],
                "tarball": output.relative_to(stage).as_posix(),
                "sha256": sha256_file(output),
                "tree": package_tree,
                "source_path": PACKAGE_PATHS[name].as_posix(),
            })

        name = WEB_BUNDLE_NAME
        source = personal / PACKAGE_PATHS[name]
        build = build_root / PACKAGE_PATHS[name]
        copy_detached_tree(source, build)
        manifest = _read_json(build / "package.json", "web bundle manifest")
        if manifest.get("name") != name or not isinstance(manifest.get("version"), str):
            raise ReleaseError("web bundle identity differs")
        dependencies = manifest.get("dependencies")
        if not isinstance(dependencies, dict):
            raise ReleaseError("web bundle dependencies are invalid")
        for dependency, tarball in tarballs.items():
            if dependency not in dependencies:
                raise ReleaseError(f"web bundle is missing dependency {dependency}")
            dependencies[dependency] = f"file:{destination / 'packages' / tarball.name}"
        (build / "package.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        output = package_output / _package_filename(name)
        _pack_package(build, output, pnpm, environment)
        package_entries.append({
            "name": name,
            "version": manifest["version"],
            "tarball": output.relative_to(stage).as_posix(),
            "sha256": sha256_file(output),
            "tree": tarball_receipt(output),
            "source_path": PACKAGE_PATHS[name].as_posix(),
            "derived_dependencies": {
                dependency: dependencies[dependency]
                for dependency in sorted(tarballs)
            },
        })
        shutil.rmtree(build_root)
        shutil.rmtree(pack_home)

        if _tool_identity(node, ["--version"]) != node_identity \
                or _tool_identity(pnpm, ["--version"], path_tools=[node]) != \
                pnpm_identity \
                or pnpm_package_identity(pnpm, str(pnpm_identity["version"])) != \
                pnpm_package:
            raise ReleaseError("release tool identity changed during preparation")

        _seal_read_only(personal)
        _seal_read_only(core)
        _seal_read_only(package_output)
        payload: dict[str, object] = {
            "schema_version": RELEASE_SCHEMA_VERSION,
            "release_root": str(destination),
            "sources": {
                "personal_commit": personal_commit,
                "core_commit": core_commit,
                "authority_commit": authority_commit,
                "source_from_git_objects": True,
                "authority_build": authority_build,
            },
            "personal": {
                "root": "personal",
                "preset_root": "personal/presets/kersor",
                "tree": tree_receipt(personal),
                "mirror_manifest_sha256": sha256_file(personal / MIRROR_PATH),
            },
            "core": {"root": "core", "tree": tree_receipt(core)},
            "packages": sorted(package_entries, key=lambda item: str(item["name"])),
            "tools": {
                "node": node_identity,
                "pnpm": pnpm_identity,
                "pnpm_package": pnpm_package,
            },
        }
        payload["release_id"] = sha256_bytes(canonical_json(payload))
        lock_path = stage / "release-lock.json"
        lock_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        lock_path.chmod(0o444)
        stage.rename(destination)
        destination.chmod(0o555)
    except Exception:
        if stage.exists():
            _make_tree_writable(stage)
            shutil.rmtree(stage)
        if destination.exists():
            _make_tree_writable(destination)
            shutil.rmtree(destination)
        raise
    return load_release(destination)


def load_release(release_root: Path) -> dict[str, object]:
    """Load and fully verify one detached release directory."""
    release_root = release_root.expanduser().resolve()
    if release_root.is_symlink() or not release_root.is_dir():
        raise ReleaseError(f"release root must be a physical directory: {release_root}")
    lock_path = release_root / "release-lock.json"
    lock = _read_json(lock_path, "release lock")
    if lock.get("schema_version") != RELEASE_SCHEMA_VERSION:
        raise ReleaseError("release lock schema is invalid")
    if lock.get("release_root") != str(release_root):
        raise ReleaseError("release lock belongs to a different physical path")
    release_id = lock.get("release_id")
    unsigned = dict(lock)
    unsigned.pop("release_id", None)
    if release_id != sha256_bytes(canonical_json(unsigned)):
        raise ReleaseError("release id differs from the lock content")
    for field, label in (("personal", "personal snapshot"), ("core", "Core snapshot")):
        value = lock.get(field)
        if not isinstance(value, dict) or not isinstance(value.get("root"), str):
            raise ReleaseError(f"release lock has no {label}")
        violations = verify_tree_receipt(
            release_root / value["root"],
            value.get("tree"),
            label,
        )
        if violations:
            raise ReleaseError("; ".join(violations))
    packages = lock.get("packages")
    if not isinstance(packages, list):
        raise ReleaseError("release package inventory is invalid")
    names: set[str] = set()
    for entry in packages:
        if not isinstance(entry, dict) or not isinstance(entry.get("name"), str) \
                or not isinstance(entry.get("tarball"), str):
            raise ReleaseError("release package entry is invalid")
        name = entry["name"]
        names.add(name)
        relative = _safe_relative(entry["tarball"], f"{name} tarball")
        tarball = release_root / relative
        if sha256_file(tarball) != entry.get("sha256"):
            raise ReleaseError(f"release package tarball differs: {name}")
        if tarball_receipt(tarball) != entry.get("tree"):
            raise ReleaseError(f"release package contents differ: {name}")
    if names != set(PACKAGE_PATHS):
        raise ReleaseError("release package inventory is incomplete")
    tools = lock.get("tools")
    if not isinstance(tools, dict) or set(tools) != {
        "node",
        "pnpm",
        "pnpm_package",
    }:
        raise ReleaseError("release tool identity evidence is incomplete")
    file_identity_fields = {
        "requested_path",
        "realpath",
        "sha256",
        "mode",
        "size",
        "platform",
        "arch",
        "version",
    }
    for name in ("node", "pnpm"):
        identity = tools.get(name)
        if not isinstance(identity, dict) or set(identity) != file_identity_fields:
            raise ReleaseError(f"release {name} identity evidence is invalid")
    package_identity = tools.get("pnpm_package")
    if not isinstance(package_identity, dict) or set(package_identity) != {
        "requested_wrapper",
        "realpath",
        "version",
        "platform",
        "arch",
        "tree",
    }:
        raise ReleaseError("release pnpm package identity evidence is invalid")
    validate_portable_tree_receipt(
        package_identity.get("tree"),
        "release pnpm package tree",
    )
    return lock


def _package_entries(lock: dict[str, object]) -> dict[str, dict[str, object]]:
    packages = lock.get("packages")
    if not isinstance(packages, list):
        raise ReleaseError("release package inventory is invalid")
    return {
        entry["name"]: entry
        for entry in packages
        if isinstance(entry, dict) and isinstance(entry.get("name"), str)
    }


def _installed_package_path(profile: Path, package_name: str) -> Path:
    return profile / "node_modules" / Path(*package_name.split("/"))


def _append_copy_import_setting(workspace: Path) -> None:
    try:
        content = workspace.read_text(encoding="utf-8")
    except OSError as error:
        raise ReleaseError(f"DSH profile workspace settings are unavailable: {error}") from error
    matches = re.findall(r"(?m)^packageImportMethod:\s*(\S+)\s*$", content)
    if matches and matches != ["copy"]:
        raise ReleaseError("DSH profile packageImportMethod must be copy")
    if not matches:
        workspace.write_text(
            content.rstrip("\n") + "\npackageImportMethod: copy\n",
            encoding="utf-8",
        )


def _run_dsh_plugin(
    *,
    node: Path,
    pnpm: Path,
    dsh_bin: Path,
    dsh_home: Path,
    runtime_home: Path,
    profile_name: str,
    arguments: list[str],
) -> None:
    runtime_home.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = runtime_home / "tmp"
    temporary.mkdir(exist_ok=True, mode=0o700)
    environment = {
        "DSH_HOME": str(dsh_home),
        "HOME": str(runtime_home),
        "TMPDIR": str(temporary),
        "PATH": os.pathsep.join(dict.fromkeys([
            str(pnpm.resolve().parent),
            str(node.resolve().parent),
            "/usr/bin",
            "/bin",
        ])),
        "LANG": "C",
        "npm_config_ignore_scripts": "true",
        "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0",
    }
    completed = subprocess.run(
        [
            str(node),
            str(dsh_bin),
            "plugin",
            "--profile",
            profile_name,
            *arguments,
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        cwd=dsh_home,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        raise ReleaseError(f"DSH plugin manager failed: {detail}")


def _current_profile_receipt(
    release_root: Path,
    profile: Path,
    lock: dict[str, object],
) -> dict[str, object]:
    packages = _package_entries(lock)
    profile_files: dict[str, str] = {}
    for name in ("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"):
        profile_files[name] = sha256_file(profile / name)
    installed = {
        name: tree_receipt(_installed_package_path(profile, name))["tree_sha256"]
        for name in sorted(packages)
    }
    return {
        "schema_version": 1,
        "mode": "release",
        "release_id": lock["release_id"],
        "release_root": str(release_root.resolve()),
        "release_lock_sha256": sha256_file(release_root / "release-lock.json"),
        "profile": str(profile.absolute()),
        "profile_files": profile_files,
        "installed_package_tree_sha256": installed,
        "source_inode_overlap": 0,
        "no_symlinks": True,
        "all_regular_nlink_one": True,
    }


def verify_web_install(
    release_root: Path,
    profile: Path,
    *,
    source_roots: Iterable[Path] = (),
    require_receipt: bool = True,
) -> list[str]:
    """Verify profile-local package bytes, lock form, and release receipt."""
    try:
        lock = load_release(release_root)
    except (OSError, ReleaseError) as error:
        return [str(error)]
    packages = _package_entries(lock)
    violations = profile_dependency_violations(profile)
    violations.extend(profile_local_resolution_violations(profile, packages))
    installed_roots = [
        _installed_package_path(profile, name)
        for name in sorted(packages)
    ]
    violations.extend(filesystem_alias_violations(installed_roots, source_roots))
    for name, entry in sorted(packages.items()):
        violations.extend(
            verify_tree_receipt(
                _installed_package_path(profile, name),
                entry.get("tree"),
                f"installed package {name}",
            )
        )
    workspace = profile / "pnpm-workspace.yaml"
    try:
        settings = workspace.read_text(encoding="utf-8")
    except OSError as error:
        violations.append(f"profile workspace settings are unavailable: {error}")
    else:
        if not re.search(r"(?m)^packageImportMethod:\s*copy\s*$", settings):
            violations.append("profile packageImportMethod is not copy")
    if violations or not require_receipt:
        return violations
    receipt_path = profile / ".kersor-release-receipt.json"
    try:
        receipt = _read_json(receipt_path, "Web release receipt")
        current = _current_profile_receipt(release_root, profile, lock)
    except (OSError, ReleaseError) as error:
        return [str(error)]
    tools = receipt.get("tools")
    if not isinstance(tools, dict) or set(tools) != {
        "node",
        "pnpm",
        "pnpm_package",
        "dsh_bin",
    }:
        violations.append("Web release receipt has incomplete tool identity evidence")
        return violations
    for name, identity in sorted(tools.items()):
        if name == "pnpm_package":
            violations.extend(
                verify_pnpm_package_identity(identity, "Web release pnpm package")
            )
        else:
            violations.extend(
                verify_file_identity(identity, f"Web release tool {name}")
            )
    stable_receipt = dict(receipt)
    stable_receipt.pop("tools", None)
    if stable_receipt != current:
        violations.append("Web release receipt differs from installed profile bytes")
    return violations


def install_web_release(
    *,
    release_root: Path,
    dsh_home: Path,
    profile_name: str,
    node: Path,
    pnpm: Path,
    dsh_bin: Path,
    source_roots: Iterable[Path] = (),
) -> dict[str, object]:
    """Install the release bundle through DSH into one temporary or real profile."""
    lock = load_release(release_root)
    node_identity = _tool_identity(node, ["--version"])
    pnpm_identity = _tool_identity(pnpm, ["--version"], path_tools=[node])
    pnpm_package = pnpm_package_identity(pnpm, str(pnpm_identity["version"]))
    recorded_tools = lock.get("tools")
    recorded_package = recorded_tools.get("pnpm_package") \
        if isinstance(recorded_tools, dict) else None
    if not isinstance(recorded_package, dict) \
            or pnpm_package["version"] != recorded_package.get("version") \
            or pnpm_package["tree"] != recorded_package.get("tree"):
        raise ReleaseError("install pnpm package differs from the release packer")
    dsh_bin_identity = _dsh_bin_identity(node, dsh_bin)
    dsh_home = dsh_home.expanduser().absolute()
    dsh_home.mkdir(parents=True, exist_ok=True)
    runtime_home = dsh_home / ".release-runtime-home"
    profile = dsh_home / "profiles" / profile_name
    if not (profile / "package.json").is_file():
        _run_dsh_plugin(
            node=node,
            pnpm=pnpm,
            dsh_bin=dsh_bin,
            dsh_home=dsh_home,
            runtime_home=runtime_home,
            profile_name=profile_name,
            arguments=["root"],
        )
    _append_copy_import_setting(profile / "pnpm-workspace.yaml")
    bundle = _package_entries(lock)[WEB_BUNDLE_NAME]
    tarball = release_root / str(bundle["tarball"])
    _run_dsh_plugin(
        node=node,
        pnpm=pnpm,
        dsh_bin=dsh_bin,
        dsh_home=dsh_home,
        runtime_home=runtime_home,
        profile_name=profile_name,
        arguments=["add", "--save-exact", "--ignore-scripts", str(tarball)],
    )
    violations = verify_web_install(
        release_root,
        profile,
        source_roots=source_roots,
        require_receipt=False,
    )
    if violations:
        raise ReleaseError("; ".join(violations))
    receipt = _current_profile_receipt(release_root, profile, lock)
    receipt["tools"] = {
        "node": node_identity,
        "pnpm": pnpm_identity,
        "pnpm_package": pnpm_package,
        "dsh_bin": dsh_bin_identity,
    }
    receipt_path = profile / ".kersor-release-receipt.json"
    temporary = receipt_path.with_name(f".{receipt_path.name}.tmp")
    temporary.write_bytes(canonical_json(receipt))
    os.replace(temporary, receipt_path)
    return receipt


def _git_bytes(repository: Path, *arguments: str) -> bytes:
    completed = subprocess.run(
        ["git", "-C", str(repository), *arguments],
        check=False,
        capture_output=True,
    )
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", errors="replace").strip()
        raise ReleaseError(
            f"git {' '.join(arguments)} failed for {repository}: {detail}"
        )
    return completed.stdout


def _require_commit(repository: Path, commit: str) -> None:
    if FULL_COMMIT.fullmatch(commit) is None:
        raise ReleaseError("release commits must be 40 lowercase hexadecimal characters")
    resolved = _git_bytes(repository, "rev-parse", f"{commit}^{{commit}}") \
        .decode("ascii").strip()
    if resolved != commit:
        raise ReleaseError(f"Git object is not the requested commit: {commit}")


def _internal_link_target(
    link: PurePosixPath,
    raw_target: str,
) -> PurePosixPath:
    """Normalize one relative archive link target without leaving its root."""
    if not raw_target or PurePosixPath(raw_target).is_absolute():
        raise ReleaseError(f"Git archive link target escapes its snapshot: {raw_target}")
    parts = list(link.parent.parts)
    for part in PurePosixPath(raw_target).parts:
        if part in {"", "."}:
            continue
        if part == "..":
            if not parts:
                raise ReleaseError(
                    f"Git archive link target escapes its snapshot: {raw_target}"
                )
            parts.pop()
            continue
        parts.append(part)
    return PurePosixPath(*parts)


def _validated_archive_links(
    links: dict[PurePosixPath, str],
    entries: dict[PurePosixPath, str],
) -> dict[PurePosixPath, tuple[PurePosixPath, bool]]:
    """Resolve archive links against its declared tree and reject unsafe graphs."""
    result: dict[PurePosixPath, tuple[PurePosixPath, bool]] = {}
    for link, raw_target in links.items():
        current = _internal_link_target(link, raw_target)
        for length in range(1, len(current.parts) + 1):
            prefix = PurePosixPath(*current.parts[:length])
            if prefix in links:
                raise ReleaseError(
                    f"Git archive link cycle or chain is not allowed: {link}"
                )
        kind = entries.get(current)
        if kind not in {"file", "directory"}:
            raise ReleaseError(
                f"Git archive link target is dangling: {link} -> {raw_target}"
            )
        if kind == "directory" \
                and link.parts[:len(current.parts)] == current.parts:
            raise ReleaseError(f"Git archive link cycle: {link}")
        result[link] = (current, kind == "directory")

    graph: dict[PurePosixPath, list[PurePosixPath]] = {}
    for link, (target, target_is_directory) in result.items():
        graph[link] = []
        if not target_is_directory:
            continue
        graph[link] = sorted(
            nested
            for nested in links
            if nested.parts[:len(target.parts)] == target.parts
        )
    visiting: set[PurePosixPath] = set()
    visited: set[PurePosixPath] = set()

    def visit(link: PurePosixPath) -> None:
        if link in visiting:
            raise ReleaseError(f"Git archive link cycle: {link}")
        if link in visited:
            return
        visiting.add(link)
        for nested in graph[link]:
            visit(nested)
        visiting.remove(link)
        visited.add(link)

    for link in sorted(links):
        visit(link)
    return result


def _extract_git_archive(
    archive: bytes,
    destination: Path,
    *,
    allow_internal_symlinks: bool = False,
) -> None:
    destination.mkdir(parents=True, exist_ok=False)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as stream:
        members: dict[PurePosixPath, tarfile.TarInfo] = {}
        entries: dict[PurePosixPath, str] = {PurePosixPath(): "directory"}
        links: dict[PurePosixPath, str] = {}
        for member in stream.getmembers():
            relative = _safe_relative(member.name.rstrip("/"), "Git archive entry")
            archive_path = PurePosixPath(relative.as_posix())
            if archive_path in members:
                raise ReleaseError(f"Git archive contains a duplicate entry: {member.name}")
            members[archive_path] = member
            if member.isdir():
                entries[archive_path] = "directory"
                continue
            if member.isfile():
                entries[archive_path] = "file"
                continue
            if member.issym() and allow_internal_symlinks:
                entries[archive_path] = "symlink"
                links[archive_path] = member.linkname
                continue
            if member.islnk() or member.issym() or not member.isfile():
                raise ReleaseError(
                    f"Git archive contains a link or special file: {member.name}"
                )

        for archive_path, kind in tuple(entries.items()):
            if not archive_path.parts:
                continue
            for length in range(1, len(archive_path.parts)):
                parent = PurePosixPath(*archive_path.parts[:length])
                parent_kind = entries.setdefault(parent, "directory")
                if parent_kind != "directory":
                    raise ReleaseError(
                        f"Git archive entry has a non-directory parent: {archive_path}"
                    )
        resolved_links = _validated_archive_links(links, entries)

        for archive_path, member in sorted(
            members.items(),
            key=lambda item: (len(item[0].parts), item[0].as_posix()),
        ):
            target = destination.joinpath(*archive_path.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                target.chmod(0o755)
                continue
            if member.issym():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            extracted = stream.extractfile(member)
            if extracted is None:
                raise ReleaseError(f"cannot extract Git archive entry: {member.name}")
            with target.open("xb") as output:
                shutil.copyfileobj(extracted, output)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)

        for archive_path, member in sorted(
            ((path, members[path]) for path in links),
            key=lambda item: item[0].as_posix(),
        ):
            target = destination.joinpath(*archive_path.parts)
            _, target_is_directory = resolved_links[archive_path]
            target.symlink_to(member.linkname, target_is_directory=target_is_directory)
            try:
                physical = target.resolve(strict=True)
                physical.relative_to(destination.resolve(strict=True))
            except (OSError, RuntimeError, ValueError) as error:
                raise ReleaseError(
                    f"Git archive link does not resolve inside its snapshot: {archive_path}"
                ) from error


def _gitlinks(repository: Path, commit: str) -> list[tuple[Path, str]]:
    output = _git_bytes(repository, "ls-tree", "-rz", commit)
    result: list[tuple[Path, str]] = []
    for raw in output.split(b"\0"):
        if not raw:
            continue
        metadata, separator, name = raw.partition(b"\t")
        if not separator:
            raise ReleaseError("cannot parse Git tree entry")
        mode, object_type, object_id = metadata.decode("ascii").split(" ")
        if mode != "160000":
            continue
        if object_type != "commit" or FULL_COMMIT.fullmatch(object_id) is None:
            raise ReleaseError("Gitlink does not name a full commit")
        relative = _safe_relative(name.decode("utf-8"), "Gitlink")
        result.append((relative, object_id))
    return result


def _materialize_git_snapshot(
    repository: Path,
    commit: str,
    destination: Path,
    seen: set[tuple[Path, str]],
    *,
    allow_internal_symlinks: bool,
) -> None:
    repository = repository.resolve()
    _require_commit(repository, commit)
    identity = (repository, commit)
    if identity in seen:
        raise ReleaseError(f"recursive submodule graph at {repository} {commit}")
    seen.add(identity)
    try:
        archive = _git_bytes(repository, "archive", "--format=tar", commit)
        _extract_git_archive(
            archive,
            destination,
            allow_internal_symlinks=allow_internal_symlinks,
        )
        for relative, child_commit in _gitlinks(repository, commit):
            child_repository = repository / relative
            try:
                _require_commit(child_repository, child_commit)
            except (OSError, ReleaseError) as error:
                raise ReleaseError(
                    f"pinned submodule object is unavailable for {relative}: {error}"
                ) from error
            target = destination / relative
            if target.exists():
                if target.is_dir() and not any(target.iterdir()):
                    target.rmdir()
                else:
                    raise ReleaseError(f"Gitlink target collides with archive data: {relative}")
            _materialize_git_snapshot(
                child_repository,
                child_commit,
                target,
                seen,
                allow_internal_symlinks=allow_internal_symlinks,
            )
    finally:
        seen.remove(identity)


def materialize_git_snapshot(
    repository: Path,
    commit: str,
    destination: Path,
) -> None:
    """Materialize one commit and every pinned submodule from Git objects."""
    if destination.exists():
        raise ReleaseError(f"snapshot destination already exists: {destination}")
    _materialize_git_snapshot(
        repository,
        commit,
        destination,
        set(),
        allow_internal_symlinks=False,
    )


def _materialize_authority_git_snapshot(
    repository: Path,
    commit: str,
    destination: Path,
) -> None:
    """Materialize one build-only authority snapshot with safe internal links."""
    if destination.exists():
        raise ReleaseError(f"snapshot destination already exists: {destination}")
    _materialize_git_snapshot(
        repository,
        commit,
        destination,
        set(),
        allow_internal_symlinks=True,
    )


def _read_json(path: Path, label: str) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ReleaseError(f"cannot read {label}: {error}") from error
    if not isinstance(value, dict):
        raise ReleaseError(f"{label} must contain a JSON object")
    return value


def verify_preset_install(preset: Path, release_root: Path) -> list[str]:
    """Verify that an installed preset uses one frozen release Core."""
    violations: list[str] = []
    try:
        lock = _read_json(release_root / "release-lock.json", "release lock")
    except ReleaseError as error:
        return [str(error)]
    receipt_path = preset / ".local" / "release-receipt.json"
    try:
        receipt = _read_json(receipt_path, "preset release receipt")
    except ReleaseError as error:
        return [str(error)]
    if receipt.get("mode") != "release":
        violations.append("preset receipt describes a development installation")
    if receipt.get("release_id") != lock.get("release_id"):
        violations.append("preset release id differs from the release lock")
    try:
        lock_sha256 = sha256_file(release_root / "release-lock.json")
    except (OSError, ReleaseError) as error:
        violations.append(f"release lock identity is unavailable: {error}")
    else:
        if receipt.get("release_lock_sha256") != lock_sha256:
            violations.append("preset release-lock identity differs")
    recorded_release = receipt.get("release_root")
    if not isinstance(recorded_release, str) or Path(recorded_release).resolve() != release_root.resolve():
        violations.append("preset receipt points at a different release root")
    core_value = lock.get("core")
    if not isinstance(core_value, dict) or not isinstance(core_value.get("root"), str):
        violations.append("release lock has no frozen Core root")
        return violations
    expected_core = (release_root / core_value["root"]).resolve()
    pointer = preset / ".local" / "kersor-root"
    try:
        recorded_core = Path(pointer.read_text(encoding="utf-8").strip()).resolve()
    except OSError as error:
        violations.append(f"preset frozen Core pointer is unavailable: {error}")
        return violations
    if recorded_core != expected_core:
        violations.append("preset does not point at the release's frozen Core")
    tree = core_value.get("tree")
    violations.extend(verify_tree_receipt(expected_core, tree, "frozen Core"))
    if not isinstance(tree, dict) or receipt.get("core_tree_sha256") != tree.get(
        "tree_sha256"
    ):
        violations.append("preset frozen Core receipt differs from the release lock")
    personal = lock.get("personal")
    if isinstance(personal, dict) and isinstance(personal.get("preset_root"), str):
        try:
            preset_source_sha256 = tree_receipt(
                release_root / personal["preset_root"]
            )["tree_sha256"]
        except (OSError, ReleaseError) as error:
            violations.append(f"release preset source is unavailable: {error}")
        else:
            if receipt.get("preset_source_tree_sha256") != preset_source_sha256:
                violations.append("installed preset source receipt differs")
    else:
        violations.append("release lock has no preset source root")
    preset_tree = receipt.get("preset_tree")
    if not isinstance(preset_tree, dict):
        violations.append("installed preset tree receipt is missing")
    else:
        violations.extend(
            verify_tree_receipt(
                preset,
                preset_tree,
                "installed preset",
                excluded=[".local/release-receipt.json"],
            )
        )
    runtime_tools = receipt.get("runtime_tools")
    if not isinstance(runtime_tools, dict):
        violations.append("preset runtime tool identities are invalid")
    else:
        for name, identity in sorted(runtime_tools.items()):
            violations.extend(
                verify_file_identity(identity, f"preset runtime tool {name}")
            )
    if not isinstance(receipt.get("models"), dict):
        violations.append("preset runtime model identity is invalid")
    return violations


def parser() -> argparse.ArgumentParser:
    """Build the release command parser."""
    command = argparse.ArgumentParser(description=__doc__)
    subcommands = command.add_subparsers(dest="command", required=True)
    prepare = subcommands.add_parser(
        "prepare",
        help="materialize committed Core and personal sources into a release",
    )
    prepare.add_argument("--personal-root", required=True, type=Path)
    prepare.add_argument("--personal-commit", required=True)
    prepare.add_argument("--core-root", required=True, type=Path)
    prepare.add_argument("--core-commit", required=True)
    prepare.add_argument("--authority-root", required=True, type=Path)
    prepare.add_argument("--authority-commit", required=True)
    prepare.add_argument("--output", required=True, type=Path)
    prepare.add_argument("--node", required=True, type=Path)
    prepare.add_argument("--pnpm", required=True, type=Path)

    install_web = subcommands.add_parser(
        "install-web",
        help="install local release tarballs through the DSH plugin manager",
    )
    install_web.add_argument("--release", required=True, type=Path)
    install_web.add_argument("--dsh-home", required=True, type=Path)
    install_web.add_argument("--profile", default="web")
    install_web.add_argument("--node", required=True, type=Path)
    install_web.add_argument("--pnpm", required=True, type=Path)
    install_web.add_argument("--dsh-bin", required=True, type=Path)
    install_web.add_argument("--source-root", action="append", type=Path)

    verify = subcommands.add_parser(
        "verify-installed",
        help="verify Web and preset bytes without installing or starting DSH",
    )
    verify.add_argument("--release", required=True, type=Path)
    verify.add_argument("--dsh-home", required=True, type=Path)
    verify.add_argument("--profile", default="web")
    verify.add_argument("--preset", type=Path)
    verify.add_argument("--source-root", action="append", type=Path)
    return command


def main(argv: list[str] | None = None) -> int:
    """Prepare, install, or verify one detached release."""
    options = parser().parse_args(argv)
    try:
        if options.command == "prepare":
            lock = prepare_release(
                personal_repository=options.personal_root,
                personal_commit=options.personal_commit,
                core_repository=options.core_root,
                core_commit=options.core_commit,
                authority_repository=options.authority_root,
                authority_commit=options.authority_commit,
                destination=options.output,
                node=options.node,
                pnpm=options.pnpm,
            )
            print(
                f"release: prepared {lock['release_id']} at {options.output.absolute()}"
            )
            return 0
        if options.command == "install-web":
            receipt = install_web_release(
                release_root=options.release,
                dsh_home=options.dsh_home,
                profile_name=options.profile,
                node=options.node,
                pnpm=options.pnpm,
                dsh_bin=options.dsh_bin,
                source_roots=options.source_root or [ROOT],
            )
            print(
                f"release: installed Web profile for {receipt['release_id']}; "
                "restart DSH before use"
            )
            return 0
        if options.command == "verify-installed":
            profile = options.dsh_home / "profiles" / options.profile
            preset = options.preset or (
                options.dsh_home / ".agent-presets" / "kersor"
            )
            violations = verify_web_install(
                options.release,
                profile,
                source_roots=options.source_root or [ROOT],
            )
            violations.extend(
                verify_preset_install(preset, options.release)
            )
        else:
            raise AssertionError(f"unhandled release command {options.command}")
    except (OSError, ReleaseError) as error:
        print(f"release: {error}", file=sys.stderr)
        return 2
    if violations:
        print("release: verification failed", file=sys.stderr)
        for violation in violations:
            print(f"  - {violation}", file=sys.stderr)
        return 1
    print("release: verification passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
