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
MIRROR_PATH = Path("plugins/dsh-mirror.json")
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
    if not isinstance(manifest, dict) or manifest.get("schema_version") != 1:
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


def _tool_identity(path: Path, version_arguments: list[str]) -> dict[str, object]:
    """Freeze one executable's requested path, physical file, hash, and version."""
    requested = path.expanduser().absolute()
    try:
        physical = requested.resolve(strict=True)
        metadata = physical.stat()
    except OSError as error:
        raise ReleaseError(f"release tool is unavailable: {requested}: {error}") from error
    if not stat.S_ISREG(metadata.st_mode) or not os.access(physical, os.X_OK):
        raise ReleaseError(f"release tool is not executable: {physical}")
    path_parts = [str(physical.parent)]
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
    }


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
        for key in ("requested_path", "realpath", "sha256", "mode", "size")
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
) -> dict[str, object]:
    """Verify every reconciled mirror byte against the named authority commit."""
    manifest = require_reconciled_mirror(personal_snapshot, authority_commit)
    for index, entry in enumerate(manifest["files"]):
        if not isinstance(entry, dict):
            raise ReleaseError(f"mirror files[{index}] must be an object")
        raw_path = entry.get("path")
        raw_source = entry.get("source")
        expected_hash = entry.get("sha256")
        if not isinstance(raw_path, str) or not isinstance(raw_source, str) \
                or not isinstance(expected_hash, str):
            raise ReleaseError(f"mirror files[{index}] is incomplete")
        relative = _safe_relative(raw_path, f"mirror files[{index}].path")
        source = _safe_relative(raw_source, f"mirror files[{index}].source")
        personal_file = personal_snapshot / relative
        if not personal_file.is_file() or sha256_file(personal_file) != expected_hash:
            raise ReleaseError(f"personal mirror differs from its manifest: {raw_path}")
        authority_bytes = _git_bytes(
            authority_repository,
            "show",
            f"{authority_commit}:{source.as_posix()}",
        )
        if sha256_bytes(authority_bytes) != expected_hash:
            raise ReleaseError(
                f"personal mirror differs from authority commit: {raw_path}"
            )
    return manifest


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


def _pack_environment(home: Path, pnpm: Path) -> dict[str, str]:
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = home / "tmp"
    temporary.mkdir(mode=0o700)
    node = shutil.which("node")
    path_parts = [str(pnpm.resolve().parent)]
    if node is not None:
        path_parts.append(str(Path(node).resolve().parent))
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
    if not root.exists():
        return
    paths = list(_walk_without_links(root))
    for path in paths:
        try:
            path.chmod(0o700 if path.is_dir() else 0o600)
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
    pnpm: Path,
) -> dict[str, object]:
    """Atomically create one read-only release from explicit Git commits."""
    destination = destination.expanduser().resolve()
    if destination.exists() or destination.is_symlink():
        raise ReleaseError(f"release destination already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    pnpm_identity = _tool_identity(pnpm, ["--version"])
    stage = Path(tempfile.mkdtemp(prefix=".kersor-release-", dir=destination.parent))
    try:
        personal = stage / "personal"
        core = stage / "core"
        materialize_git_snapshot(personal_repository, personal_commit, personal)
        materialize_git_snapshot(core_repository, core_commit, core)
        mirror = _verify_mirror_against_authority(
            personal,
            authority_repository,
            authority_commit,
        )
        toolchain = mirror.get("toolchain")
        expected_pnpm = toolchain.get("pnpm") if isinstance(toolchain, dict) else None
        if expected_pnpm != pnpm_identity["version"]:
            raise ReleaseError(
                "pnpm version differs from the reconciled mirror toolchain: "
                f"expected {expected_pnpm!r}, got {pnpm_identity['version']!r}"
            )

        package_output = stage / "packages"
        package_output.mkdir()
        build_root = stage / ".package-build"
        pack_home = stage / ".pack-home"
        environment = _pack_environment(pack_home, pnpm)
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
            output = package_output / _package_filename(name)
            _pack_package(build, output, pnpm, environment)
            tarballs[name] = output
            package_entries.append({
                "name": name,
                "version": manifest["version"],
                "tarball": output.relative_to(stage).as_posix(),
                "sha256": sha256_file(output),
                "tree": tarball_receipt(output),
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
            },
            "personal": {
                "root": "personal",
                "preset_root": "personal/presets/kersor",
                "tree": tree_receipt(personal),
                "mirror_manifest_sha256": sha256_file(personal / MIRROR_PATH),
            },
            "core": {"root": "core", "tree": tree_receipt(core)},
            "packages": sorted(package_entries, key=lambda item: str(item["name"])),
            "tools": {"pnpm": pnpm_identity},
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
    if not isinstance(tools, dict) or set(tools) != {"node", "pnpm", "dsh_bin"}:
        violations.append("Web release receipt has incomplete tool identity evidence")
        return violations
    for name, identity in sorted(tools.items()):
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
    pnpm_identity = _tool_identity(pnpm, ["--version"])
    recorded_pnpm = lock.get("tools")
    recorded_pnpm = recorded_pnpm.get("pnpm") if isinstance(recorded_pnpm, dict) else None
    if not isinstance(recorded_pnpm, dict) \
            or pnpm_identity["version"] != recorded_pnpm.get("version") \
            or pnpm_identity["sha256"] != recorded_pnpm.get("sha256"):
        raise ReleaseError("install pnpm identity differs from the release packer")
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


def _extract_git_archive(archive: bytes, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=False)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as stream:
        for member in stream.getmembers():
            relative = _safe_relative(member.name.rstrip("/"), "Git archive entry")
            target = destination / relative
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                target.chmod(member.mode & 0o777)
                continue
            if not member.isfile():
                raise ReleaseError(
                    f"Git archive contains a link or special file: {member.name}"
                )
            target.parent.mkdir(parents=True, exist_ok=True)
            extracted = stream.extractfile(member)
            if extracted is None:
                raise ReleaseError(f"cannot extract Git archive entry: {member.name}")
            with target.open("xb") as output:
                shutil.copyfileobj(extracted, output)
            target.chmod(member.mode & 0o777)


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
) -> None:
    repository = repository.resolve()
    _require_commit(repository, commit)
    identity = (repository, commit)
    if identity in seen:
        raise ReleaseError(f"recursive submodule graph at {repository} {commit}")
    seen.add(identity)
    try:
        archive = _git_bytes(repository, "archive", "--format=tar", commit)
        _extract_git_archive(archive, destination)
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
    _materialize_git_snapshot(repository, commit, destination, set())


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
