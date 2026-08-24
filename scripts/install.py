#!/usr/bin/env python3
"""Render and install the KerSor preset from the current DSH standard preset."""

from __future__ import annotations

import argparse
import filecmp
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path

try:
    from scripts import release as release_tools
except ImportError:  # Direct ``python3 scripts/install.py`` execution.
    import release as release_tools


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
ASSET_ROOT = REPOSITORY_ROOT / "presets" / "kersor"
PERSONA_LINE = (
    "      You are a coding agent powered by the {{model}} model. "
    "Your working directory is {{cwd}}."
)
KERSOR_LINE = (
    "      Use the kersor skill plus kersor_status and kersor_evolve tools for KerSor tasks; "
    "the bridge resolves the configured checkout. DSH_HOME and KERSOR_PYTHON "
    "are Host-frozen inputs; use them without probing."
)
TOOL_SKILL_ENTRY = "- id: tool-skill\n  name: '@deepseek-ai/dsh-tool-skill'"
SKILL_FILESYSTEM_ENTRY = (
    "- id: skill-filesystem\n"
    "  name: '@deepseek-ai/dsh-skill-filesystem'"
)
KERSOR_STATUS_ENTRY = (
    "- id: kersor-status\n"
    "  name: './plugins/kersor-status.mjs'"
)
KERSOR_EVOLVE_ENTRY = (
    "- id: kersor-evolve\n"
    "  name: './plugins/kersor-evolve.mjs'"
)
KERSOR_CONTROL_ENTRY = (
    "- id: kersor-control\n"
    "  name: '@deepseek-ai/dsh-kersor/control'"
)
RUNTIME_TOOL_NAMES = ("bash", "python3", "node", "jq", "codex", "claude")
EXPECTED_OUTER_FILESYSTEM_POLICY = "workspace-write"
MAX_MODEL_ID_LENGTH = 128


def default_dsh_home() -> Path:
    """Resolve the DSH home without embedding a machine path in repository assets."""
    configured = os.environ.get("DSH_HOME", "").strip()
    return Path(configured).expanduser() if configured else Path.home() / ".dsh"


def locate_standard(dsh_home: Path, explicit: Path | None) -> Path:
    """Locate the installed standard preset or fail with actionable guidance."""
    candidates: list[Path] = []
    if explicit is not None:
        candidates.append(explicit.expanduser())
    configured = os.environ.get("DSH_STANDARD_PRESET", "").strip()
    if configured:
        candidates.append(Path(configured).expanduser())
    candidates.append(
        dsh_home
        / "profiles"
        / "node_modules"
        / "@deepseek-ai"
        / "dsh"
        / "config"
        / "agent-presets"
        / "standard"
        / "agent.cordis.yml"
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    rendered = "\n  - ".join(str(candidate) for candidate in candidates)
    raise RuntimeError(
        "cannot locate DSH standard preset; checked:\n  - "
        f"{rendered}\npass --standard-preset explicitly"
    )


def validate_kersor_root(path: Path) -> Path:
    """Return a canonical KerSor checkout after checking bridge dependencies."""
    root = path.expanduser().resolve()
    required = ("AGENTS.md", "commands", "scripts/compose.py", "scripts/doctor.sh")
    missing = [relative for relative in required if not (root / relative).exists()]
    if missing:
        raise RuntimeError(f"invalid KerSor checkout {root}; missing {', '.join(missing)}")
    return root


def resolve_runtime_command(path: Path, label: str) -> str:
    """Resolve one explicitly selected executable without consulting PATH."""
    candidate = path.expanduser().resolve()
    if not candidate.is_file() or not os.access(candidate, os.X_OK):
        raise RuntimeError(f"{label} is not an executable file: {candidate}")
    return str(candidate)


def validate_model_id(value: str, label: str) -> str:
    """Return one bounded model identifier suitable for a frozen environment."""
    model = value.strip()
    if (
        not model
        or len(model) > MAX_MODEL_ID_LENGTH
        or any(character.isspace() or ord(character) < 32 for character in model)
    ):
        raise RuntimeError(f"{label} must be a non-empty model id without whitespace")
    return model


def resolve_runtime_tools(*, claude_command: Path | None = None) -> dict[str, str]:
    """Freeze absolute tool paths at trusted install time for generic evolve."""
    resolved: dict[str, str] = {}
    for name in RUNTIME_TOOL_NAMES:
        if name == "claude" and claude_command is not None:
            resolved[name] = resolve_runtime_command(
                claude_command,
                "--claude-command",
            )
            continue
        candidate = shutil.which(name)
        if candidate:
            resolved[name] = str(Path(candidate).absolute())
    return resolved


def resolve_codex_auth_home() -> str | None:
    """Record only the trusted auth directory path, never credential bytes."""
    configured = os.environ.get("CODEX_HOME", "").strip()
    candidate = (
        Path(configured).expanduser()
        if configured
        else Path.home() / ".codex"
    ).resolve()
    return str(candidate) if (candidate / "auth.json").is_file() else None


def render_composition(standard_source: str, *, skill_dir: Path) -> str:
    """Apply the KerSor-owned persona delta to a DSH standard composition."""
    if standard_source.count(PERSONA_LINE) != 1:
        raise RuntimeError(
            "standard preset persona anchor changed; inspect the current DSH preset "
            "before updating this renderer"
        )
    if standard_source.count(TOOL_SKILL_ENTRY) != 1:
        raise RuntimeError(
            "standard preset skill-tool anchor changed; inspect the current DSH preset "
            "before updating this renderer"
        )
    if standard_source.count(SKILL_FILESYSTEM_ENTRY) != 1:
        raise RuntimeError(
            "standard preset skill-filesystem anchor changed; inspect the current "
            "DSH preset before updating this renderer"
        )
    lines = standard_source.splitlines()
    if not lines:
        raise RuntimeError("standard preset is empty")
    lines[0] = "# The `kersor` agent preset: current DSH standard plus the KerSor bridge."
    rendered = "\n".join(lines).replace(
        PERSONA_LINE,
        f"{PERSONA_LINE}\n{KERSOR_LINE}",
        1,
    )
    rendered = rendered.replace(
        SKILL_FILESYSTEM_ENTRY,
        (
            f"{SKILL_FILESYSTEM_ENTRY}\n"
            "  config:\n"
            "    customSkillDirs:\n"
            f"      - {json.dumps(str(skill_dir.resolve()))}"
        ),
        1,
    )
    rendered = rendered.replace(
        TOOL_SKILL_ENTRY,
        (
            f"{TOOL_SKILL_ENTRY}\n\n{KERSOR_STATUS_ENTRY}\n\n"
            f"{KERSOR_EVOLVE_ENTRY}\n\n{KERSOR_CONTROL_ENTRY}"
        ),
        1,
    )
    return rendered.rstrip("\n") + "\n"


def directory_equal(left: Path, right: Path) -> bool:
    """Compare two directory trees without introducing a persisted fingerprint."""
    comparison = filecmp.dircmp(left, right)
    if comparison.left_only or comparison.right_only or comparison.funny_files:
        return False
    if any(
        not filecmp.cmp(left / name, right / name, shallow=False)
        for name in comparison.common_files
    ):
        return False
    return all(
        directory_equal(left / name, right / name)
        for name in comparison.common_dirs
    )


def stage_install(
    parent: Path,
    composition: str,
    kersor_root: Path,
    *,
    claude_command: Path | None,
    claude_model: str | None,
    asset_root: Path = ASSET_ROOT,
    release_metadata: dict[str, object] | None = None,
) -> Path:
    """Create a complete preset tree on the destination filesystem."""
    stage = Path(tempfile.mkdtemp(prefix=".kersor-install-", dir=parent))
    shutil.copy2(asset_root / "preset.yml", stage / "preset.yml")
    shutil.copytree(asset_root / "skills", stage / "skills")
    shutil.copytree(asset_root / "plugins", stage / "plugins")
    shutil.copytree(
        asset_root / "bin",
        stage / "bin",
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )
    (stage / "agent.cordis.yml").write_text(composition, encoding="utf-8")
    local = stage / ".local"
    local.mkdir()
    (local / "kersor-root").write_text(f"{kersor_root}\n", encoding="utf-8")
    trusted_environment = {
        "home": str(Path.home().resolve()),
        "temp_dir": str(Path(tempfile.gettempdir()).resolve()),
    }
    codex_auth_home = None if release_metadata is not None else resolve_codex_auth_home()
    if codex_auth_home is not None:
        trusted_environment["codex_auth_home"] = codex_auth_home
    frozen_models: dict[str, str] = {}
    if claude_model is not None:
        frozen_models["claude"] = validate_model_id(
            claude_model,
            "--claude-model",
        )
    runtime_tool_paths = resolve_runtime_tools(claude_command=claude_command)
    (local / "runtime-tools.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "expected_outer_filesystem_policy": (
                    EXPECTED_OUTER_FILESYSTEM_POLICY
                ),
                "tools": runtime_tool_paths,
                "models": frozen_models,
                "environment": trusted_environment,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    if release_metadata is not None:
        receipt = {
            "schema_version": 1,
            "mode": "release",
            "release_id": release_metadata["release_id"],
            "release_root": release_metadata["release_root"],
            "release_lock_sha256": release_metadata["release_lock_sha256"],
            "core_tree_sha256": release_metadata["core_tree_sha256"],
            "preset_source_tree_sha256": release_metadata[
                "preset_source_tree_sha256"
            ],
            "runtime_tools": {
                name: release_tools.file_identity(Path(path))
                for name, path in sorted(runtime_tool_paths.items())
            },
            "models": frozen_models,
            "preset_tree": release_tools.tree_receipt(
                stage,
                excluded=[".local/release-receipt.json"],
            ),
        }
        (local / "release-receipt.json").write_text(
            json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    return stage


def unique_backup(destination: Path) -> Path:
    """Choose a non-conflicting recoverable backup path beside the preset."""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    candidate = destination.with_name(f"{destination.name}.backup-{stamp}")
    suffix = 1
    while candidate.exists():
        candidate = destination.with_name(
            f"{destination.name}.backup-{stamp}-{suffix}"
        )
        suffix += 1
    return candidate


def install(
    *,
    dsh_home: Path,
    standard_preset: Path | None,
    kersor_root: Path | None,
    force: bool,
    dry_run: bool,
    claude_command: Path | None = None,
    claude_model: str | None = None,
    release_root: Path | None = None,
) -> tuple[Path, Path | None, bool]:
    """Install the rendered preset and return destination, backup, and changed state."""
    standard = locate_standard(dsh_home, standard_preset)
    if (kersor_root is None) == (release_root is None):
        raise RuntimeError("choose exactly one of --kersor-root or --release")
    asset_root = ASSET_ROOT
    release_metadata: dict[str, object] | None = None
    if release_root is None:
        assert kersor_root is not None
        root = validate_kersor_root(kersor_root)
    else:
        try:
            release_lock = release_tools.load_release(release_root)
        except (OSError, release_tools.ReleaseError) as error:
            raise RuntimeError(f"invalid KerSor release: {error}") from error
        resolved_release = release_root.expanduser().resolve()
        core = release_lock.get("core")
        personal = release_lock.get("personal")
        if not isinstance(core, dict) or not isinstance(core.get("root"), str) \
                or not isinstance(personal, dict) \
                or not isinstance(personal.get("preset_root"), str):
            raise RuntimeError("invalid KerSor release roots")
        root = validate_kersor_root(resolved_release / core["root"])
        asset_root = resolved_release / personal["preset_root"]
        if not asset_root.is_dir() or asset_root.is_symlink():
            raise RuntimeError("release preset source is unavailable")
        core_tree = core.get("tree")
        if not isinstance(core_tree, dict):
            raise RuntimeError("release Core tree receipt is unavailable")
        release_metadata = {
            "release_id": release_lock["release_id"],
            "release_root": str(resolved_release),
            "release_lock_sha256": release_tools.sha256_file(
                resolved_release / "release-lock.json"
            ),
            "core_tree_sha256": core_tree.get("tree_sha256"),
            "preset_source_tree_sha256": release_tools.tree_receipt(
                asset_root
            )["tree_sha256"],
        }
    if claude_command is not None:
        claude_command = Path(
            resolve_runtime_command(claude_command, "--claude-command")
        )
    if claude_model is not None:
        claude_model = validate_model_id(claude_model, "--claude-model")
    destination = dsh_home.expanduser().resolve() / ".agent-presets" / "kersor"
    composition = render_composition(
        standard.read_text(encoding="utf-8"),
        skill_dir=destination / "skills",
    )
    if dry_run:
        return destination, None, True

    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = stage_install(
        destination.parent,
        composition,
        root,
        claude_command=claude_command,
        claude_model=claude_model,
        asset_root=asset_root,
        release_metadata=release_metadata,
    )
    backup: Path | None = None
    try:
        if destination.exists() and directory_equal(stage, destination):
            shutil.rmtree(stage)
            return destination, None, False
        if destination.exists() and not force:
            raise RuntimeError(
                f"destination exists and differs: {destination}; rerun with --force"
            )
        if destination.exists():
            backup = unique_backup(destination)
            destination.rename(backup)
        try:
            stage.rename(destination)
        except Exception:
            if backup is not None and not destination.exists():
                backup.rename(destination)
            raise
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return destination, backup, True


def parser() -> argparse.ArgumentParser:
    """Build the installer command parser."""
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--dsh-home", type=Path, default=default_dsh_home())
    result.add_argument("--standard-preset", type=Path)
    source = result.add_mutually_exclusive_group(required=True)
    source.add_argument("--kersor-root", type=Path)
    source.add_argument(
        "--release",
        type=Path,
        help="detached release directory produced by scripts/release.py prepare",
    )
    result.add_argument(
        "--claude-command",
        type=Path,
        help="trusted Claude-compatible CLI executable for the optional Claude runtime",
    )
    result.add_argument(
        "--claude-model",
        help="model id frozen for the optional Claude-compatible runtime",
    )
    result.add_argument("--force", action="store_true")
    result.add_argument("--dry-run", action="store_true")
    return result


def main(argv: list[str] | None = None) -> int:
    """Run the installer CLI."""
    options = parser().parse_args(argv)
    try:
        destination, backup, changed = install(
            dsh_home=options.dsh_home,
            standard_preset=options.standard_preset,
            kersor_root=options.kersor_root,
            force=options.force,
            dry_run=options.dry_run,
            claude_command=options.claude_command,
            claude_model=options.claude_model,
            release_root=options.release,
        )
    except RuntimeError as error:
        print(f"install: {error}", file=sys.stderr)
        return 2

    if options.dry_run:
        print(f"would install KerSor preset at {destination}")
    elif changed:
        print(f"installed KerSor preset at {destination}")
    else:
        print(f"KerSor preset already up to date at {destination}")
    if backup is not None:
        print(f"previous preset preserved at {backup}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
