#!/usr/bin/env python3
"""Run repository metadata, portability, and installer contract checks."""

from __future__ import annotations

import subprocess
import shutil
import sys
from pathlib import Path

from sync_plugins import manifest_violations


ROOT = Path(__file__).resolve().parents[1]
TEXT_SUFFIXES = {
    "", ".css", ".js", ".json", ".md", ".mjs", ".py", ".ts", ".tsx",
    ".txt", ".yaml", ".yml",
}


def frontmatter(path: Path) -> dict[str, str]:
    """Parse the scalar top-level fields used by a DSH skill."""
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0] != "---":
        raise ValueError(f"{path}: missing opening frontmatter delimiter")
    try:
        end = lines.index("---", 1)
    except ValueError as error:
        raise ValueError(f"{path}: missing closing frontmatter delimiter") from error
    result: dict[str, str] = {}
    for line in lines[1:end]:
        key, separator, value = line.partition(":")
        if not separator or not key.strip() or not value.strip():
            raise ValueError(f"{path}: unsupported frontmatter line: {line}")
        result[key.strip()] = value.strip()
    return result


def repository_text_files() -> list[Path]:
    """List maintained text files while excluding generated local state."""
    return [
        path
        for path in ROOT.rglob("*")
        if path.is_file()
        and ".git" not in path.parts
        and "__pycache__" not in path.parts
        and ".local" not in path.parts
        and path.suffix in TEXT_SUFFIXES
    ]


def metadata_violations() -> list[str]:
    """Return violations in the one maintained DSH preset and skill."""
    violations: list[str] = []
    preset = (ROOT / "presets" / "kersor" / "preset.yml").read_text(encoding="utf-8")
    if "name: KerSor\n" not in preset or "description:" not in preset:
        violations.append("presets/kersor/preset.yml: name or description missing")

    skill_path = ROOT / "presets" / "kersor" / "skills" / "kersor" / "SKILL.md"
    try:
        skill = frontmatter(skill_path)
    except ValueError as error:
        violations.append(str(error))
    else:
        if skill.get("name") != "kersor":
            violations.append(f"{skill_path}: name must be kersor")
        if not skill.get("description"):
            violations.append(f"{skill_path}: description is required")
        unexpected = sorted(set(skill) - {"name", "description"})
        if unexpected:
            violations.append(
                f"{skill_path}: unsupported frontmatter fields: {', '.join(unexpected)}"
            )

    forbidden = (
        "/" + "Users/",
        "/" + "home/",
        "Documents/Infinity/" + "Agent4Kernel",
        "[" + "TODO:",
    )
    for path in repository_text_files():
        text = path.read_text(encoding="utf-8")
        for marker in forbidden:
            if marker in text:
                violations.append(f"{path.relative_to(ROOT)}: forbidden marker {marker!r}")
    return violations


def main() -> int:
    """Run static checks and the standard-library regression suite."""
    node = shutil.which("node")
    if node is None:
        print("check: Node.js is required to validate DSH plugins", file=sys.stderr)
        return 1

    violations = [*metadata_violations(), *manifest_violations()]
    if violations:
        print("check: violations found", file=sys.stderr)
        for violation in violations:
            print(f"  - {violation}", file=sys.stderr)
        return 1

    syntax_targets = (
        ROOT / "presets" / "kersor" / "plugins" / "kersor-status.mjs",
        ROOT / "tools" / "codex-infini-bridge" / "server.mjs",
    )
    for target in syntax_targets:
        syntax = subprocess.run(
            [node, "--check", str(target)],
            cwd=ROOT,
            check=False,
        )
        if syntax.returncode != 0:
            return syntax.returncode

    completed = subprocess.run(
        [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"],
        cwd=ROOT,
        check=False,
    )
    if completed.returncode != 0:
        return completed.returncode
    print(
        "check: metadata, mirror integrity, portability, bridge, installer, "
        "and detached-release contracts passed"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
