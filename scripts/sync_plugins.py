#!/usr/bin/env python3
"""Verify or refresh the generated DeepSeek Harness plugin mirror.

The TypeScript sources, tests, package READMEs, build configs, and compiled
``lib/`` trees under ``plugins/`` are a distribution snapshot. Authority
tracked files come from one exact DeepSeek Harness commit; ignored ``lib/``
files must match that commit's central build receipt. The three package
manifests remain personal distribution policy. The normal command is
read-only; writing requires an explicit clean source checkout and an explicit
``--write`` flag.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import stat
import subprocess
import sys
from pathlib import Path, PurePosixPath
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "plugins" / "dsh-mirror.json"
SOURCE_REPOSITORY = "https://github.com/qhy991/deepseek-harness.git"
SOURCE_ROOT = PurePosixPath("packages/extensions")
MIRROR_SCHEMA_VERSION = 2
TOOLCHAIN_NODE = "24.19.0"
TOOLCHAIN_PNPM = "11.7.0"
BUILD_RECEIPT_PATH = PurePosixPath(
    "release/kersor-distribution-build-receipt.json"
)
BUILD_RECEIPT_TYPE = "kersor-distribution-build"
BUILD_RECIPE_ID = "dsh-kersor-distribution-build-v1"
BUILD_INSTALL = [
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
BUILD_COMMAND = ["node", "scripts/release/build-kersor-distribution.mjs"]
PACKAGES = ("kersor", "kersor-viewer", "ui-kersor-viewer")
MIRROR_DIRECTORIES = ("src", "tests", "lib")
PACKAGE_MANIFESTS = {
    PurePosixPath("plugins", package, "package.json") for package in PACKAGES
}


class MirrorError(RuntimeError):
    """A mirror source, manifest, or worktree violated the sync contract."""


def sha256(path: Path) -> str:
    """Return the lowercase SHA-256 digest of one file."""
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json(value: object) -> bytes:
    """Return the canonical JSON bytes used by cross-repository receipts."""
    return (
        json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")


def validate_portable_tree_receipt(value: object, label: str) -> None:
    """Validate one canonical path/size/hash package tree."""
    if not isinstance(value, dict) or set(value) != {
        "schema_version",
        "files",
        "tree_sha256",
    } or value.get("schema_version") != 1:
        raise MirrorError(f"{label} schema is invalid")
    files = value.get("files")
    if not isinstance(files, list) or not files:
        raise MirrorError(f"{label} files are invalid")
    paths: list[str] = []
    for index, entry in enumerate(files):
        if not isinstance(entry, dict) or set(entry) != {"path", "size", "sha256"}:
            raise MirrorError(f"{label} files[{index}] is invalid")
        raw_path = entry.get("path")
        size = entry.get("size")
        digest = entry.get("sha256")
        if not isinstance(raw_path, str):
            raise MirrorError(f"{label} files[{index}].path is invalid")
        relative = PurePosixPath(raw_path)
        if relative.is_absolute() or not relative.parts or ".." in relative.parts:
            raise MirrorError(f"{label} files[{index}].path is invalid")
        if type(size) is not int or size < 0 \
                or not isinstance(digest, str) or len(digest) != 64 \
                or any(character not in "0123456789abcdef" for character in digest):
            raise MirrorError(f"{label} files[{index}] metadata is invalid")
        paths.append(raw_path)
    if paths != sorted(paths) or len(paths) != len(set(paths)):
        raise MirrorError(f"{label} paths are not sorted and unique")
    if value.get("tree_sha256") != hashlib.sha256(canonical_json(files)).hexdigest():
        raise MirrorError(f"{label} digest differs")


def selected_relative_files(root: Path, prefix: str) -> list[PurePosixPath]:
    """List every physical file in the three distribution package trees."""
    selected: list[PurePosixPath] = []
    for package in PACKAGES:
        package_root = root / prefix / package
        if not package_root.is_dir():
            continue
        selected.extend(
            PurePosixPath(path.relative_to(root).as_posix())
            for path in package_root.rglob("*")
            if path.is_file() or path.is_symlink()
        )
    return sorted(selected, key=str)


def expected_source_path(mirror_path: PurePosixPath) -> PurePosixPath:
    """Map ``plugins/<package>/...`` to the authoritative DSH path."""
    parts = mirror_path.parts
    if len(parts) < 3 or parts[0] != "plugins" or parts[1] not in PACKAGES:
        raise MirrorError(f"unsupported mirror path {mirror_path}")
    return SOURCE_ROOT / PurePosixPath(*parts[1:])


def read_manifest(path: Path = MANIFEST) -> dict[str, object]:
    """Read the checked-in mirror manifest."""
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise MirrorError(f"cannot read {path}: {error}") from error
    if not isinstance(value, dict):
        raise MirrorError(f"{path}: top level must be an object")
    return value


def manifest_violations(root: Path = ROOT, path: Path = MANIFEST) -> list[str]:
    """Return every inventory, provenance, and content-hash violation."""
    try:
        manifest = read_manifest(path)
    except MirrorError as error:
        return [str(error)]

    violations: list[str] = []
    if manifest.get("schema_version") != MIRROR_SCHEMA_VERSION:
        violations.append(
            f"{path}: schema_version must be {MIRROR_SCHEMA_VERSION}"
        )

    if manifest.get("toolchain") != {
        "node": TOOLCHAIN_NODE,
        "pnpm": TOOLCHAIN_PNPM,
    }:
        violations.append(f"{path}: unexpected pinned test toolchain")

    authority = manifest.get("authority")
    if not isinstance(authority, dict):
        violations.append(f"{path}: authority must be an object")
    else:
        if authority.get("repository") != SOURCE_REPOSITORY:
            violations.append(f"{path}: unexpected authority.repository")
        if authority.get("source_root") != str(SOURCE_ROOT):
            violations.append(f"{path}: unexpected authority.source_root")
        revision = authority.get("revision")
        if not isinstance(revision, str) or len(revision) != 40 or any(
            character not in "0123456789abcdef" for character in revision
        ):
            violations.append(f"{path}: authority.revision must be a full Git SHA")
        if authority.get("reconciled") is not True:
            violations.append(f"{path}: authority.reconciled must be true")

    receipt = manifest.get("build_receipt")
    if not isinstance(receipt, dict):
        violations.append(f"{path}: build_receipt must be an object")
    else:
        if receipt.get("path") != str(BUILD_RECEIPT_PATH):
            violations.append(f"{path}: unexpected build_receipt.path")
        receipt_hash = receipt.get("sha256")
        if not isinstance(receipt_hash, str) or len(receipt_hash) != 64 or any(
            character not in "0123456789abcdef" for character in receipt_hash
        ):
            violations.append(f"{path}: build_receipt.sha256 must be a digest")
        if receipt.get("recipe_id") != BUILD_RECIPE_ID:
            violations.append(f"{path}: unexpected build_receipt.recipe_id")

    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        return [*violations, f"{path}: files must be a non-empty array"]

    listed: list[PurePosixPath] = []
    for index, entry in enumerate(files):
        label = f"{path}: files[{index}]"
        if not isinstance(entry, dict):
            violations.append(f"{label} must be an object")
            continue
        raw_path = entry.get("path")
        raw_source = entry.get("source")
        expected_hash = entry.get("sha256")
        origin = entry.get("origin")
        if not isinstance(raw_path, str):
            violations.append(f"{label}.path must be a string")
            continue
        relative = PurePosixPath(raw_path)
        if relative.is_absolute() or ".." in relative.parts:
            violations.append(f"{label}.path must stay inside the repository")
            continue
        try:
            source = expected_source_path(relative)
        except MirrorError as error:
            violations.append(f"{label}: {error}")
            continue
        listed.append(relative)
        expected_origin = (
            "distribution-owned"
            if relative in PACKAGE_MANIFESTS
            else (
                "derived-build"
                if len(relative.parts) >= 4 and relative.parts[2] == "lib"
                else "tracked"
            )
        )
        if origin != expected_origin:
            violations.append(f"{label}.origin must be {expected_origin}")
        if expected_origin == "distribution-owned":
            if raw_source is not None:
                violations.append(f"{label}.source must be absent")
            if entry.get("receipt_output") is not None:
                violations.append(f"{label}.receipt_output must be absent")
        else:
            if raw_source != str(source):
                violations.append(f"{label}.source must be {source}")
            if expected_origin == "derived-build":
                if entry.get("receipt_output") != str(source):
                    violations.append(f"{label}.receipt_output must be {source}")
            elif entry.get("receipt_output") is not None:
                violations.append(f"{label}.receipt_output must be absent")
        if not isinstance(expected_hash, str) or len(expected_hash) != 64 or any(
            character not in "0123456789abcdef" for character in expected_hash
        ):
            violations.append(f"{label}.sha256 must be a lowercase SHA-256 digest")
            continue
        physical = root / Path(*relative.parts)
        if physical.is_symlink() or not physical.is_file():
            violations.append(f"{relative}: listed mirror file is missing")
        elif sha256(physical) != expected_hash:
            violations.append(f"{relative}: content differs from plugins/dsh-mirror.json")

    if listed != sorted(listed, key=str):
        violations.append(f"{path}: files must be sorted by path")
    if len(listed) != len(set(listed)):
        violations.append(f"{path}: files contains duplicate paths")

    discovered = selected_relative_files(root, "plugins")
    for package in PACKAGES:
        package_root = root / "plugins" / package
        if package_root.is_symlink() or not package_root.is_dir():
            violations.append(f"{package_root}: package root must be a directory")
            continue
        for candidate in package_root.rglob("*"):
            if candidate.is_symlink():
                violations.append(
                    f"{candidate.relative_to(root)}: mirror tree contains a symlink"
                )
    listed_set = set(listed)
    for relative in sorted(set(discovered) - listed_set, key=str):
        violations.append(f"{relative}: mirrored file is absent from plugins/dsh-mirror.json")
    for relative in sorted(listed_set - set(discovered), key=str):
        violations.append(f"{relative}: manifest entry is outside the mirrored inventory")
    return violations


def git_output(checkout: Path, *args: str) -> str:
    """Run one read-only Git query against a checkout."""
    completed = subprocess.run(
        ["git", "-C", str(checkout), *args],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise MirrorError(f"git {' '.join(args)} failed for {checkout}: {detail}")
    return completed.stdout.strip()


def git_bytes(checkout: Path, *args: str) -> bytes:
    """Run one Git query without decoding its blob output."""
    completed = subprocess.run(
        ["git", "-C", str(checkout), *args],
        check=False,
        capture_output=True,
    )
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", errors="replace").strip()
        raise MirrorError(f"git {' '.join(args)} failed for {checkout}: {detail}")
    return completed.stdout


def git_tree_files(
    checkout: Path,
    revision: str,
    *,
    regular_only_roots: Iterable[PurePosixPath] = (),
) -> dict[PurePosixPath, int]:
    """Return every regular blob and normalized mode from one exact tree."""
    result: dict[PurePosixPath, int] = {}
    regular_only_roots = tuple(regular_only_roots)
    raw_tree = git_bytes(checkout, "ls-tree", "-r", "-z", revision)
    for raw in raw_tree.split(b"\0"):
        if not raw:
            continue
        metadata, separator, raw_path = raw.partition(b"\t")
        if not separator:
            raise MirrorError("cannot parse authority Git tree")
        mode, object_type, _ = metadata.decode("ascii").split(" ")
        path = PurePosixPath(raw_path.decode("utf-8"))
        if object_type != "blob" or mode not in {"100644", "100755"}:
            if any(path.is_relative_to(root) for root in regular_only_roots):
                raise MirrorError(
                    f"authority package tree contains a link or gitlink: {path}"
                )
            continue
        if path in result:
            raise MirrorError(f"authority Git tree duplicates a path: {path}")
        result[path] = 0o755 if mode == "100755" else 0o644
    return result


def authority_build_receipt(
    harness: Path,
    revision: str,
    tree_files: dict[PurePosixPath, int],
) -> tuple[dict[str, object], dict[str, dict[str, object]]]:
    """Read the canonical ignored-output receipt from one exact Git commit."""
    raw = git_bytes(harness, "show", f"{revision}:{BUILD_RECEIPT_PATH}")
    try:
        receipt = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise MirrorError(f"authority build receipt is invalid: {error}") from error
    if not isinstance(receipt, dict) or receipt.get("schema_version") != 1 \
            or receipt.get("receipt_type") != BUILD_RECEIPT_TYPE:
        raise MirrorError("authority build receipt schema is invalid")
    recipe = receipt.get("recipe")
    if not isinstance(recipe, dict) or recipe != {
        "id": BUILD_RECIPE_ID,
        "node": TOOLCHAIN_NODE,
        "pnpm": TOOLCHAIN_PNPM,
        "install": BUILD_INSTALL,
        "command": BUILD_COMMAND,
    }:
        raise MirrorError("authority build receipt recipe is not canonical")
    tools = receipt.get("tools")
    if not isinstance(tools, dict) or set(tools) != {"node", "pnpm"}:
        raise MirrorError("authority build receipt tools are invalid")
    pnpm_tool = tools.get("pnpm")
    if tools.get("node") != {"version": TOOLCHAIN_NODE} \
            or not isinstance(pnpm_tool, dict) \
            or set(pnpm_tool) != {"version", "tree"} \
            or pnpm_tool.get("version") != TOOLCHAIN_PNPM:
        raise MirrorError("authority build receipt tools are not canonical")
    validate_portable_tree_receipt(
        pnpm_tool.get("tree"),
        "authority pnpm package tree",
    )
    if receipt.get("tools_sha256") != hashlib.sha256(
        canonical_json(tools)
    ).hexdigest():
        raise MirrorError("authority build receipt tool digest differs")
    inputs = receipt.get("inputs")
    if not isinstance(inputs, list) or not inputs \
            or receipt.get("inputs_sha256") != hashlib.sha256(
                canonical_json(inputs)
            ).hexdigest():
        raise MirrorError("authority build receipt inputs are invalid")
    input_paths: list[str] = []
    required_inputs = {
        "package.json",
        "apps/cli/package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        BUILD_COMMAND[1],
        "tsconfig.base.json",
        "tsconfig.base.client.json",
        "tsconfig.host.json",
        "tsdown.config.ts",
    }
    required_inputs.update(
        str(path)
        for path in tree_files
        if path.name == "package.json"
        or path.is_relative_to(PurePosixPath("apps/cli"))
    )
    for index, input_file in enumerate(inputs):
        if not isinstance(input_file, dict):
            raise MirrorError(f"authority build receipt inputs[{index}] is invalid")
        raw_path = input_file.get("path")
        digest = input_file.get("git_blob_sha256")
        size = input_file.get("size")
        mode = input_file.get("mode")
        if not isinstance(raw_path, str):
            raise MirrorError(f"authority build receipt inputs[{index}].path is invalid")
        relative = PurePosixPath(raw_path)
        if relative.is_absolute() or ".." in relative.parts \
                or relative == BUILD_RECEIPT_PATH:
            raise MirrorError(f"authority build input path is invalid: {raw_path}")
        if not isinstance(digest, str) or len(digest) != 64 or any(
            character not in "0123456789abcdef" for character in digest
        ):
            raise MirrorError(f"authority build input hash is invalid: {raw_path}")
        if type(size) is not int or size < 0 or type(mode) is not int \
                or mode not in {0o644, 0o755}:
            raise MirrorError(f"authority build input metadata is invalid: {raw_path}")
        physical = harness / Path(*relative.parts)
        committed_mode = tree_files.get(relative)
        if physical.is_symlink() or not physical.is_file():
            raise MirrorError(f"authority build input is absent: {raw_path}")
        metadata = physical.stat()
        if sha256(physical) != digest or metadata.st_size != size \
                or committed_mode != mode \
                or stat.S_IMODE(metadata.st_mode) != mode:
            raise MirrorError(f"authority build input differs from commit: {raw_path}")
        input_paths.append(raw_path)
    if input_paths != sorted(input_paths) or len(input_paths) != len(set(input_paths)):
        raise MirrorError("authority build receipt inputs are not sorted and unique")
    if not required_inputs.issubset(input_paths):
        raise MirrorError("authority build receipt omits canonical inputs")
    outputs = receipt.get("outputs")
    if not isinstance(outputs, list) or not outputs \
            or receipt.get("outputs_sha256") != hashlib.sha256(
                canonical_json(outputs)
            ).hexdigest():
        raise MirrorError("authority build receipt outputs are invalid")
    by_path: dict[str, dict[str, object]] = {}
    listed: list[str] = []
    for index, output in enumerate(outputs):
        if not isinstance(output, dict):
            raise MirrorError(f"authority build receipt outputs[{index}] is invalid")
        raw_path = output.get("path")
        digest = output.get("sha256")
        size = output.get("size")
        mode = output.get("mode")
        if not isinstance(raw_path, str):
            raise MirrorError(f"authority build receipt outputs[{index}].path is invalid")
        relative = PurePosixPath(raw_path)
        parts = relative.parts
        if relative.is_absolute() or ".." in parts or len(parts) < 5 \
                or parts[:2] != ("packages", "extensions") \
                or parts[2] not in PACKAGES or parts[3] != "lib":
            raise MirrorError(f"authority build output is outside KerSor lib: {raw_path}")
        if not isinstance(digest, str) or len(digest) != 64 or any(
            character not in "0123456789abcdef" for character in digest
        ):
            raise MirrorError(f"authority build output hash is invalid: {raw_path}")
        if type(size) is not int or size < 0 or type(mode) is not int \
                or mode not in {0o644, 0o755}:
            raise MirrorError(f"authority build output metadata is invalid: {raw_path}")
        if raw_path in by_path:
            raise MirrorError(f"authority build output is duplicated: {raw_path}")
        listed.append(raw_path)
        by_path[raw_path] = output
    if listed != sorted(listed):
        raise MirrorError("authority build receipt outputs are not sorted")
    binding = {
        "path": str(BUILD_RECEIPT_PATH),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "recipe_id": BUILD_RECIPE_ID,
    }
    return binding, by_path


def require_clean(checkout: Path, paths: Iterable[str] = ()) -> None:
    """Refuse to overwrite or source a tracked dirty mirror."""
    arguments = ["status", "--porcelain", "--untracked-files=all"]
    paths = tuple(paths)
    if paths:
        arguments.extend(["--", *paths])
    dirty = git_output(checkout, *arguments)
    if dirty:
        raise MirrorError(f"refusing to sync a dirty worktree at {checkout}:\n{dirty}")


def source_snapshot(
    harness: Path,
) -> tuple[str, dict[PurePosixPath, Path], dict[str, object]]:
    """Preflight one clean, built DSH checkout and return its complete snapshot."""
    harness = harness.resolve()
    if not (harness / ".git").exists():
        raise MirrorError(f"{harness} is not a DeepSeek Harness Git checkout")
    require_clean(harness)
    revision = git_output(harness, "rev-parse", "HEAD")
    if len(revision) != 40:
        raise MirrorError(f"cannot resolve a full source revision from {harness}")
    package_roots = tuple(SOURCE_ROOT / package for package in PACKAGES)
    tree_files = git_tree_files(
        harness,
        revision,
        regular_only_roots=package_roots,
    )
    receipt_binding, receipt_outputs = authority_build_receipt(
        harness,
        revision,
        tree_files,
    )

    snapshot: dict[PurePosixPath, Path] = {}
    for source_relative, committed_mode in tree_files.items():
        if not any(source_relative.is_relative_to(root) for root in package_roots):
            continue
        parts = source_relative.parts
        if len(parts) < 4:
            raise MirrorError(f"unexpected source path {source_relative}")
        package_relative = PurePosixPath(*parts[3:])
        if package_relative == PurePosixPath("package.json"):
            continue
        if package_relative.parts[0] == "lib":
            raise MirrorError(
                f"authority unexpectedly tracks a build output: {source_relative}"
            )
        mirror_relative = PurePosixPath("plugins", *parts[2:])
        physical = harness / Path(*source_relative.parts)
        if physical.is_symlink() or not physical.is_file() \
                or stat.S_IMODE(physical.stat().st_mode) != committed_mode:
            raise MirrorError(
                f"tracked source differs from exact authority commit: {source_relative}"
            )
        snapshot[mirror_relative] = physical
    for raw_source, expected in receipt_outputs.items():
        source_relative = PurePosixPath(raw_source)
        physical = harness / Path(*source_relative.parts)
        if physical.is_symlink() or not physical.is_file():
            raise MirrorError(f"ignored build output is missing: {source_relative}")
        metadata = physical.stat()
        if sha256(physical) != expected.get("sha256") \
                or metadata.st_size != expected.get("size") \
                or stat.S_IMODE(metadata.st_mode) != expected.get("mode"):
            raise MirrorError(
                f"ignored build output differs from authority receipt: {source_relative}"
            )
        snapshot[PurePosixPath("plugins", *source_relative.parts[2:])] = physical
    discovered_outputs: set[str] = set()
    for package in PACKAGES:
        lib = harness / SOURCE_ROOT / package / "lib"
        if lib.is_symlink() or not lib.is_dir():
            continue
        for candidate in lib.rglob("*"):
            metadata = candidate.lstat()
            if stat.S_ISDIR(metadata.st_mode):
                continue
            if stat.S_ISLNK(metadata.st_mode) \
                    or not stat.S_ISREG(metadata.st_mode):
                raise MirrorError(
                    f"ignored build output tree contains a link: "
                    f"{candidate.relative_to(harness)}"
                )
            discovered_outputs.add(candidate.relative_to(harness).as_posix())
    if discovered_outputs != set(receipt_outputs):
        missing = sorted(set(receipt_outputs) - discovered_outputs)
        extra = sorted(discovered_outputs - set(receipt_outputs))
        raise MirrorError(
            "ignored build output inventory differs from authority receipt: "
            + ", ".join([
                *(f"missing {path}" for path in missing),
                *(f"orphan {path}" for path in extra),
            ])
        )
    for package in PACKAGES:
        for directory in ("src", "tests", "lib"):
            prefix = PurePosixPath("plugins", package, directory)
            if not any(path == prefix or prefix in path.parents for path in snapshot):
                raise MirrorError(
                    f"{SOURCE_ROOT / package / directory}: missing or empty; build DSH before sync"
                )
    return revision, snapshot, receipt_binding


def mirror_differences(snapshot: dict[PurePosixPath, Path]) -> list[str]:
    """Describe additions, removals, and byte changes without writing."""
    current = set(selected_relative_files(ROOT, "plugins")) - PACKAGE_MANIFESTS
    source = set(snapshot)
    differences = [f"add {path}" for path in sorted(source - current, key=str)]
    differences.extend(f"remove {path}" for path in sorted(current - source, key=str))
    for relative in sorted(source & current, key=str):
        destination = ROOT / Path(*relative.parts)
        if sha256(snapshot[relative]) != sha256(destination):
            differences.append(f"update {relative}")
    return differences


def write_manifest(
    revision: str,
    build_receipt: dict[str, object],
    reconciled: bool = True,
) -> None:
    """Write a deterministic manifest for the current personal snapshot."""
    files = []
    for relative in selected_relative_files(ROOT, "plugins"):
        entry = {
            "path": str(relative),
            "sha256": sha256(ROOT / Path(*relative.parts)),
            "origin": (
                "distribution-owned"
                if relative in PACKAGE_MANIFESTS
                else (
                    "derived-build"
                    if relative.parts[2] == "lib"
                    else "tracked"
                )
            ),
        }
        if entry["origin"] != "distribution-owned":
            source = str(expected_source_path(relative))
            entry["source"] = source
            if entry["origin"] == "derived-build":
                entry["receipt_output"] = source
        files.append(entry)
    value = {
        "schema_version": MIRROR_SCHEMA_VERSION,
        "authority": {
            "repository": SOURCE_REPOSITORY,
            "revision": revision,
            "source_root": str(SOURCE_ROOT),
            "reconciled": reconciled,
        },
        "toolchain": {
            "node": TOOLCHAIN_NODE,
            "pnpm": TOOLCHAIN_PNPM,
        },
        "build_receipt": build_receipt,
        "files": files,
    }
    MANIFEST.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def apply_snapshot(
    revision: str,
    snapshot: dict[PurePosixPath, Path],
    build_receipt: dict[str, object],
) -> None:
    """Replace only the known mirror surface after all safety checks pass."""
    mirror_paths = [f"plugins/{package}" for package in PACKAGES]
    mirror_paths.append("plugins/dsh-mirror.json")
    require_clean(ROOT, mirror_paths)

    current = set(selected_relative_files(ROOT, "plugins")) - PACKAGE_MANIFESTS
    source = set(snapshot)
    for relative in sorted(current - source, key=str, reverse=True):
        (ROOT / Path(*relative.parts)).unlink()
    for relative, source_path in sorted(snapshot.items(), key=lambda item: str(item[0])):
        destination = ROOT / Path(*relative.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, destination)
    for package in PACKAGES:
        package_root = ROOT / "plugins" / package
        for directory in MIRROR_DIRECTORIES:
            root = package_root / directory
            if not root.exists():
                continue
            for candidate in sorted(root.rglob("*"), reverse=True):
                if candidate.is_dir() and not any(candidate.iterdir()):
                    candidate.rmdir()
    write_manifest(revision, build_receipt)


def command_check() -> int:
    """CLI implementation for local and CI integrity checks."""
    violations = manifest_violations()
    if violations:
        print("plugin mirror: violations found", file=sys.stderr)
        for violation in violations:
            print(f"  - {violation}", file=sys.stderr)
        return 1
    print("plugin mirror: inventory and hashes match")
    return 0


def command_sync(harness: Path, write: bool) -> int:
    """Plan or explicitly apply one DSH-to-personal snapshot refresh."""
    revision, snapshot, build_receipt = source_snapshot(harness)
    differences = mirror_differences(snapshot)
    manifest = read_manifest()
    authority = manifest.get("authority")
    provenance_matches = isinstance(authority, dict) \
        and authority.get("revision") == revision \
        and authority.get("reconciled") is True \
        and manifest.get("build_receipt") == build_receipt \
        and manifest.get("schema_version") == MIRROR_SCHEMA_VERSION
    if not differences and provenance_matches:
        print(f"plugin mirror: already matches DeepSeek Harness {revision}")
        return 0
    print(f"plugin mirror: DeepSeek Harness {revision}")
    for difference in differences:
        print(f"  {difference}")
    if not provenance_matches:
        print("  update plugins/dsh-mirror.json provenance")
    if not write:
        print("plugin mirror: dry run only; pass --write after review")
        return 1
    if differences:
        apply_snapshot(revision, snapshot, build_receipt)
    else:
        require_clean(ROOT, ["plugins/dsh-mirror.json"])
        write_manifest(revision, build_receipt)
    print(f"plugin mirror: refreshed from DeepSeek Harness {revision}")
    return 0


def parser() -> argparse.ArgumentParser:
    """Build the command-line parser."""
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)
    commands.add_parser("check", help="verify the checked-in inventory and hashes")
    sync = commands.add_parser("sync", help="plan or apply a DSH-to-personal refresh")
    sync.add_argument("--harness", type=Path, required=True, help="clean DeepSeek Harness checkout")
    sync.add_argument("--write", action="store_true", help="apply the displayed refresh")
    return result


def main(argv: list[str] | None = None) -> int:
    """Dispatch one mirror command."""
    arguments = parser().parse_args(argv)
    try:
        if arguments.command == "check":
            return command_check()
        if arguments.command == "sync":
            return command_sync(arguments.harness, arguments.write)
        raise AssertionError(f"unhandled command {arguments.command}")
    except MirrorError as error:
        print(f"plugin mirror: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
