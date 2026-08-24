#!/usr/bin/env python3
"""Verify personal sources and refresh artifacts from one DSH checkout.

The source packages intentionally retain DSH's monorepo-relative TypeScript
contracts. This command stages them under the expected ``packages/extensions``
layout, links the selected DSH dependency graph read-only, and builds there.
After that proof succeeds it copies the selected DSH checkout's authoritative
``lib`` artifacts back. It never writes the DSH checkout.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLUGIN_NAMES = ("kersor", "kersor-viewer", "ui-kersor-viewer")


class BuildError(RuntimeError):
    """The selected DSH checkout cannot reproduce the plugin artifacts."""


def require(path: Path, label: str) -> Path:
    if not path.exists():
        raise BuildError(f"missing {label}: {path}")
    return path


def link(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.symlink_to(source.resolve(), target_is_directory=source.is_dir())


def stage_node_modules(dsh_root: Path, staging: Path, extensions: Path) -> str:
    source = require(dsh_root / "node_modules", "DSH node_modules")
    target = staging / "node_modules"
    target.mkdir()
    for entry in source.iterdir():
        if entry.name == "@deepseek-ai":
            continue
        link(entry, target / entry.name)
    scope = target / "@deepseek-ai"
    scope.mkdir()
    source_scope = require(source / "@deepseek-ai", "DSH package links")
    for entry in source_scope.iterdir():
        if entry.name in {"dsh-kersor", "dsh-kersor-viewer", "dsh-client-ui-kersor-viewer"}:
            continue
        link(entry, scope / entry.name)
    local_packages = {
        "dsh-kersor": "kersor",
        "dsh-kersor-viewer": "kersor-viewer",
        "dsh-client-ui-kersor-viewer": "ui-kersor-viewer",
    }
    for package_name, directory in local_packages.items():
        link(extensions / directory, scope / package_name)

    # pnpm keeps peer-only React links package-local rather than at the root.
    # Reuse one DSH UI package's resolved versions for the staged client build.
    ui_dependencies = require(
        dsh_root / "packages/extensions/ui-cordis/node_modules",
        "DSH UI peer dependencies",
    )
    local_ui = extensions / "ui-kersor-viewer" / "node_modules"
    local_ui.mkdir()
    link(require(ui_dependencies / "react", "React runtime"), local_ui / "react")
    local_types = local_ui / "@types"
    local_types.mkdir()
    link(
        require(ui_dependencies / "@types/react", "React declarations"),
        local_types / "react",
    )

    zod = require(
        dsh_root / "packages/typert/generator/node_modules/zod",
        "DSH zod dependency",
    )
    shutil.copytree(zod, target / "zod", symlinks=True)
    zod_version = json.loads((zod / "package.json").read_text(encoding="utf-8"))[
        "version"
    ]
    viewer_scope = extensions / "kersor-viewer/node_modules/@deepseek-ai"
    viewer_scope.mkdir(parents=True)
    link(
        require(
            dsh_root / "node_modules/.pnpm/node_modules/@deepseek-ai/schemastery",
            "DSH schemastery dependency",
        ),
        viewer_scope / "schemastery",
    )
    return str(zod_version)


def normalize_generated_bundles(viewer: Path, ui: Path, zod_version: str) -> None:
    """Remove staging-path entropy while preserving executable bundle code."""
    host_bundle = viewer / "lib/index.js"
    host = host_bundle.read_text(encoding="utf-8")
    host = re.sub(
        r"(?m)^//#region .*?/vendor/(.+)$",
        lambda match: f"//#region ../../../vendor/{match.group(1)}",
        host,
    ).replace(
        "//#region ../../../vendor/schemastery/lib/index.mjs",
        "//#region ../../../vendor/schemastery/src/index.ts",
    )
    host_bundle.write_text(host, encoding="utf-8")

    client_bundle = ui / "lib/client.js"
    client = client_bundle.read_text(encoding="utf-8")
    client = re.sub(
        r"(?m)^(\s*//#region \\0dsh-css:).*?/src/client/(.+)$",
        r"\1src/client/\2",
        client,
    ).replace(
        "//#region ../../../node_modules/zod/",
        f"//#region ../../../node_modules/.pnpm/zod@{zod_version}/node_modules/zod/",
    )
    css_prefixes = list(dict.fromkeys(
        re.findall(r"\.([A-Za-z0-9_-]+)_(?:view|card)", client)
    ))
    if not css_prefixes:
        raise BuildError("generated client bundle lacks the KerSor CSS module")
    for index, prefix in enumerate(css_prefixes, start=1):
        client = client.replace(f"{prefix}_", f"krsr{index:02d}_")
    normalized = "\n".join(line.rstrip(" \t") for line in client.split("\n"))
    client_bundle.write_text(normalized, encoding="utf-8")


def run(command: list[str], cwd: Path) -> None:
    completed = subprocess.run(command, cwd=cwd, check=False)
    if completed.returncode != 0:
        raise BuildError(f"command failed ({completed.returncode}): {' '.join(command)}")


def build(dsh_root: Path) -> None:
    dsh_root = dsh_root.expanduser().resolve()
    tsc = require(dsh_root / "node_modules/.bin/tsc", "TypeScript compiler")
    tsdown = require(dsh_root / "node_modules/.bin/tsdown", "tsdown")
    for config in ("tsconfig.base.json", "tsconfig.base.client.json"):
        require(dsh_root / config, config)
    host_aggregate = require(dsh_root / "tsconfig.host.json", "Host aggregate")

    with tempfile.TemporaryDirectory(prefix="dsh-kersor-plugin-build-") as temporary:
        staging = Path(temporary)
        for config in ("tsconfig.base.json", "tsconfig.base.client.json"):
            shutil.copy2(dsh_root / config, staging / config)
        scripts = staging / "scripts"
        scripts.mkdir()
        link(require(dsh_root / "scripts" / "types", "DSH compiler type roots"), scripts / "types")
        link(require(dsh_root / "vendor", "DSH vendor tree"), staging / "vendor")

        packages = staging / "packages"
        extensions = packages / "extensions"
        extensions.mkdir(parents=True)
        source_packages = require(dsh_root / "packages", "DSH package tree")
        for group in source_packages.iterdir():
            if group.name == "extensions":
                continue
            if group.name != "typert":
                link(group, packages / group.name)
                continue
            staged_typert = packages / "typert"
            staged_typert.mkdir()
            for package in group.iterdir():
                if package.name == "protocol":
                    shutil.copytree(
                        package,
                        staged_typert / package.name,
                        symlinks=True,
                        ignore=shutil.ignore_patterns("*.tsbuildinfo"),
                    )
                else:
                    link(package, staged_typert / package.name)
        source_extensions = require(
            source_packages / "extensions", "DSH extension package group"
        )
        for package in source_extensions.iterdir():
            if package.name not in PLUGIN_NAMES:
                link(package, extensions / package.name)
        for name in PLUGIN_NAMES:
            shutil.copytree(ROOT / "plugins" / name, extensions / name)

        aggregate = host_aggregate.read_text(encoding="utf-8")
        closing = aggregate.rfind("\n  ]")
        if closing < 0:
            raise BuildError("DSH Host aggregate has no references boundary")
        prefix = aggregate[:closing].rstrip()
        if not prefix.endswith(","):
            prefix += ","
        aggregate = (
            prefix
            + '\n    { "path": "./packages/extensions/kersor-viewer/tsconfig.host.json" }'
            + aggregate[closing:]
        )
        (staging / "tsconfig.host.json").write_text(aggregate, encoding="utf-8")
        zod_version = stage_node_modules(dsh_root, staging, extensions)

        viewer = extensions / "kersor-viewer"
        ui = extensions / "ui-kersor-viewer"
        run([os.fspath(tsc), "-p", "tsconfig.host.json", "--pretty", "false"], viewer)
        run(
            [
                "node",
                os.fspath(ROOT / "scripts/generate-typert.mjs"),
                os.fspath(staging),
                "@deepseek-ai/dsh-kersor-viewer",
            ],
            staging,
        )
        run([os.fspath(tsdown), "--config", "tsdown.config.ts"], viewer)
        run([os.fspath(tsc), "-p", "tsconfig.json", "--pretty", "false"], ui)
        run(
            [
                os.fspath(tsdown),
                "--config",
                "tsdown.config.ts",
                "--env.DSH_BUILD_FACE",
                "client",
            ],
            ui,
        )

        normalize_generated_bundles(viewer, ui, zod_version)

        for name in ("kersor-viewer", "ui-kersor-viewer"):
            built = require(
                extensions / name / "lib",
                f"verified staged {name} artifacts",
            )
            destination = ROOT / "plugins" / name / "lib"
            shutil.copytree(
                built,
                destination,
                dirs_exist_ok=True,
                ignore=shutil.ignore_patterns("*.map", "*.tsbuildinfo"),
            )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dsh-root",
        required=True,
        type=Path,
        help="DSH source checkout providing the pinned TypeScript build runtime",
    )
    args = parser.parse_args()
    try:
        build(args.dsh_root)
    except (BuildError, OSError) as exc:
        print(f"BUILD FAILED: {exc}")
        return 1
    print("Verified KerSor sources and refreshed DSH-owned artifacts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
