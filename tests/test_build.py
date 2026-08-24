"""Regression tests for the isolated DeepSeek Harness build staging."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import build


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


class BuildStagingTests(unittest.TestCase):
    def test_client_build_config_is_physical_inside_the_staging_repository(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            authority = root / "authority"
            staging = root / "staging"
            write(authority / "packages/client/tsdown.client.ts", "export const marker = 1\n")
            write(authority / "packages/client/modules/src/client/manifest.ts", "export const manifest = 1\n")
            write(authority / "packages/client/web/src/platform.ts", "export const platform = 1\n")
            write(authority / "packages/client/locale/package.json", '{"name":"locale"}\n')
            write(authority / "scripts/client-build-environment.ts", "export const environment = 1\n")
            (staging / "packages").mkdir(parents=True)
            (staging / "scripts").mkdir()

            build.stage_client_build_sources(authority, staging)

            client = staging / "packages/client"
            self.assertTrue(client.is_dir())
            self.assertFalse(client.is_symlink())
            self.assertTrue((client / "tsdown.client.ts").is_file())
            self.assertFalse((client / "tsdown.client.ts").is_symlink())
            self.assertTrue((client / "modules").is_dir())
            self.assertFalse((client / "modules").is_symlink())
            self.assertTrue((client / "web").is_dir())
            self.assertFalse((client / "web").is_symlink())
            self.assertTrue((client / "locale").is_symlink())
            environment = staging / "scripts/client-build-environment.ts"
            self.assertTrue(environment.is_file())
            self.assertFalse(environment.is_symlink())

    def test_authority_preflight_is_read_only_and_requires_the_exact_mirror(self) -> None:
        revision = "a" * 40
        receipt = {"schema_version": 1, "outputs_sha256": "b" * 64}
        manifest = {
            "schema_version": 2,
            "authority": {"revision": revision, "reconciled": True},
            "build_receipt": receipt,
        }
        with (
            mock.patch.object(
                build.sync_plugins,
                "source_snapshot",
                return_value=(revision, {}, receipt),
            ),
            mock.patch.object(build.sync_plugins, "mirror_differences", return_value=[]),
            mock.patch.object(build.sync_plugins, "read_manifest", return_value=manifest),
        ):
            self.assertEqual(build.verify_authoritative_mirror(Path("/authority")), revision)

        with (
            mock.patch.object(
                build.sync_plugins,
                "source_snapshot",
                return_value=(revision, {}, receipt),
            ),
            mock.patch.object(
                build.sync_plugins,
                "mirror_differences",
                return_value=["update plugins/kersor-viewer/lib/index.js"],
            ),
            mock.patch.object(build.sync_plugins, "read_manifest", return_value=manifest),
        ):
            with self.assertRaisesRegex(build.BuildError, "sync_plugins.py sync"):
                build.verify_authoritative_mirror(Path("/authority"))


if __name__ == "__main__":
    unittest.main()
