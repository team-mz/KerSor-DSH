#!/usr/bin/env python3
"""Verify or refresh the generated DeepSeek Harness plugin mirror.

The TypeScript sources, tests, package READMEs, build configs, and compiled
``lib/`` trees under ``plugins/`` are a distribution snapshot.  Their source
of truth lives under ``packages/extensions`` in DeepSeek Harness.  The normal
command is read-only; writing requires an explicit clean source checkout and
an explicit ``--write`` flag.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path, PurePosixPath
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "plugins" / "dsh-mirror.json"
SOURCE_REPOSITORY = "https://github.com/qhy991/deepseek-harness.git"
SOURCE_ROOT = PurePosixPath("packages/extensions")
TOOLCHAIN_NODE = "24"
TOOLCHAIN_PNPM = "11.7.0"
PACKAGES = ("kersor", "kersor-viewer", "ui-kersor-viewer")
TOP_LEVEL_FILES = (
    "README.i18n.yaml",
    "README.md",
    "README.zh.md",
    "tsconfig.host.json",
    "tsconfig.json",
    "tsdown.config.ts",
)
MIRROR_DIRECTORIES = ("src", "tests", "lib")
BUILD_INTERNAL_SUFFIXES = (".map", ".tsbuildinfo")
DISTRIBUTION_OWNED_FILES = {
    PurePosixPath("plugins/kersor-viewer/tsdown.config.ts"),
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


def selected_relative_files(root: Path, prefix: str) -> list[PurePosixPath]:
    """List every file in the mechanically mirrored surface."""
    selected: list[PurePosixPath] = []
    for package in PACKAGES:
        package_root = root / prefix / package
        for name in TOP_LEVEL_FILES:
            path = package_root / name
            relative = PurePosixPath(prefix, package, name)
            if path.is_file() and not (
                prefix == "plugins" and relative in DISTRIBUTION_OWNED_FILES
            ):
                selected.append(relative)
        for directory in MIRROR_DIRECTORIES:
            directory_root = package_root / directory
            if not directory_root.is_dir():
                continue
            selected.extend(
                PurePosixPath(path.relative_to(root).as_posix())
                for path in directory_root.rglob("*")
                if path.is_file()
                and not (
                    directory == "lib"
                    and path.name.endswith(BUILD_INTERNAL_SUFFIXES)
                )
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
    if manifest.get("schema_version") != 1:
        violations.append(f"{path}: schema_version must be 1")

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

    files = manifest.get("files")
    if not isinstance(files, list):
        return [*violations, f"{path}: files must be an array"]

    listed: list[PurePosixPath] = []
    for index, entry in enumerate(files):
        label = f"{path}: files[{index}]"
        if not isinstance(entry, dict):
            violations.append(f"{label} must be an object")
            continue
        raw_path = entry.get("path")
        raw_source = entry.get("source")
        expected_hash = entry.get("sha256")
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
        if raw_source != str(source):
            violations.append(f"{label}.source must be {source}")
        if not isinstance(expected_hash, str) or len(expected_hash) != 64 or any(
            character not in "0123456789abcdef" for character in expected_hash
        ):
            violations.append(f"{label}.sha256 must be a lowercase SHA-256 digest")
            continue
        physical = root / Path(*relative.parts)
        if not physical.is_file():
            violations.append(f"{relative}: listed mirror file is missing")
        elif sha256(physical) != expected_hash:
            violations.append(f"{relative}: content differs from plugins/dsh-mirror.json")

    if listed != sorted(listed, key=str):
        violations.append(f"{path}: files must be sorted by path")
    if len(listed) != len(set(listed)):
        violations.append(f"{path}: files contains duplicate paths")

    discovered = selected_relative_files(root, "plugins")
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


def require_clean(checkout: Path, paths: Iterable[str] = ()) -> None:
    """Refuse to overwrite or source a tracked dirty mirror."""
    arguments = ["status", "--porcelain", "--untracked-files=all"]
    paths = tuple(paths)
    if paths:
        arguments.extend(["--", *paths])
    dirty = git_output(checkout, *arguments)
    if dirty:
        raise MirrorError(f"refusing to sync a dirty worktree at {checkout}:\n{dirty}")


def source_snapshot(harness: Path) -> tuple[str, dict[PurePosixPath, Path]]:
    """Preflight one clean, built DSH checkout and return its complete snapshot."""
    harness = harness.resolve()
    if not (harness / ".git").exists():
        raise MirrorError(f"{harness} is not a DeepSeek Harness Git checkout")
    require_clean(harness)
    revision = git_output(harness, "rev-parse", "HEAD")
    if len(revision) != 40:
        raise MirrorError(f"cannot resolve a full source revision from {harness}")

    selected = selected_relative_files(harness, str(SOURCE_ROOT))
    snapshot: dict[PurePosixPath, Path] = {}
    for source_relative in selected:
        parts = source_relative.parts
        if len(parts) < 4:
            raise MirrorError(f"unexpected source path {source_relative}")
        mirror_relative = PurePosixPath("plugins", *parts[2:])
        snapshot[mirror_relative] = harness / Path(*source_relative.parts)
    for package in PACKAGES:
        for directory in ("src", "tests", "lib"):
            prefix = PurePosixPath("plugins", package, directory)
            if not any(path == prefix or prefix in path.parents for path in snapshot):
                raise MirrorError(
                    f"{SOURCE_ROOT / package / directory}: missing or empty; build DSH before sync"
                )
    return revision, snapshot


def mirror_differences(snapshot: dict[PurePosixPath, Path]) -> list[str]:
    """Describe additions, removals, and byte changes without writing."""
    current = set(selected_relative_files(ROOT, "plugins"))
    source = set(snapshot)
    differences = [f"add {path}" for path in sorted(source - current, key=str)]
    differences.extend(f"remove {path}" for path in sorted(current - source, key=str))
    for relative in sorted(source & current, key=str):
        destination = ROOT / Path(*relative.parts)
        if sha256(snapshot[relative]) != sha256(destination):
            differences.append(f"update {relative}")
    return differences


def write_manifest(revision: str, reconciled: bool = True) -> None:
    """Write a deterministic manifest for the current personal snapshot."""
    files = []
    for relative in selected_relative_files(ROOT, "plugins"):
        files.append(
            {
                "path": str(relative),
                "source": str(expected_source_path(relative)),
                "sha256": sha256(ROOT / Path(*relative.parts)),
            }
        )
    value = {
        "schema_version": 1,
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
        "files": files,
    }
    MANIFEST.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def apply_snapshot(revision: str, snapshot: dict[PurePosixPath, Path]) -> None:
    """Replace only the known mirror surface after all safety checks pass."""
    mirror_paths = [f"plugins/{package}" for package in PACKAGES]
    mirror_paths.append("plugins/dsh-mirror.json")
    require_clean(ROOT, mirror_paths)

    current = set(selected_relative_files(ROOT, "plugins"))
    source = set(snapshot)
    for relative in sorted(current - source, key=str, reverse=True):
        (ROOT / Path(*relative.parts)).unlink()
    for relative, source_path in sorted(snapshot.items(), key=lambda item: str(item[0])):
        destination = ROOT / Path(*relative.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source_path, destination)
    for package in PACKAGES:
        package_root = ROOT / "plugins" / package
        for directory in MIRROR_DIRECTORIES:
            root = package_root / directory
            if not root.exists():
                continue
            for candidate in sorted(root.rglob("*"), reverse=True):
                if candidate.is_dir() and not any(candidate.iterdir()):
                    candidate.rmdir()
    write_manifest(revision)


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
    revision, snapshot = source_snapshot(harness)
    differences = mirror_differences(snapshot)
    manifest = read_manifest()
    authority = manifest.get("authority")
    provenance_matches = isinstance(authority, dict) \
        and authority.get("revision") == revision \
        and authority.get("reconciled") is True
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
        apply_snapshot(revision, snapshot)
    else:
        require_clean(ROOT, ["plugins/dsh-mirror.json"])
        write_manifest(revision)
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
