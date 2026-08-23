"""Regression tests for the one-way DeepSeek Harness plugin mirror."""

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from scripts import sync_plugins


ROOT = Path(__file__).resolve().parents[1]


class MirrorManifestTests(unittest.TestCase):
    """Make mirror drift a deterministic repository-check failure."""

    def test_repository_manifest_covers_the_complete_mirror(self) -> None:
        self.assertEqual(sync_plugins.manifest_violations(), [])

    def test_hash_and_inventory_drift_are_reported(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            checkout = Path(temporary)
            shutil.copytree(ROOT / "plugins", checkout / "plugins")
            source = checkout / "plugins" / "kersor-viewer" / "src" / "fold.ts"
            source.write_text(source.read_text(encoding="utf-8") + "// drift\n", encoding="utf-8")
            extra = checkout / "plugins" / "ui-kersor-viewer" / "tests" / "unlisted.spec.ts"
            extra.write_text("export {}\n", encoding="utf-8")
            build_map = checkout / "plugins" / "kersor-viewer" / "lib" / "index.js.map"
            build_map.write_text("{}\n", encoding="utf-8")
            build_info = checkout / "plugins" / "kersor-viewer" / "lib" / "tsconfig.tsbuildinfo"
            build_info.write_text("{}\n", encoding="utf-8")

            violations = sync_plugins.manifest_violations(
                checkout,
                checkout / "plugins" / "dsh-mirror.json",
            )
            self.assertTrue(any("fold.ts: content differs" in item for item in violations))
            self.assertTrue(any("unlisted.spec.ts: mirrored file is absent" in item for item in violations))
            self.assertFalse(any("index.js.map" in item for item in violations))
            self.assertFalse(any("tsconfig.tsbuildinfo" in item for item in violations))
            self.assertFalse(any("kersor-viewer/tsdown.config.ts" in item for item in violations))

    def test_unreconciled_snapshot_is_not_publishable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            checkout = Path(temporary)
            shutil.copytree(ROOT / "plugins", checkout / "plugins")
            manifest_path = checkout / "plugins" / "dsh-mirror.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["authority"]["reconciled"] = False
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

            violations = sync_plugins.manifest_violations(
                checkout,
                manifest_path,
            )

            self.assertTrue(
                any("authority.reconciled must be true" in item for item in violations),
                violations,
            )

    def test_ci_validates_the_public_snapshot_without_private_checkout(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "validate.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn('python-version: "3.12"', workflow)
        self.assertIn("node-version: ${{ steps.dsh-source.outputs.node }}", workflow)
        self.assertIn("python3 scripts/check.py", workflow)
        self.assertNotIn("repository: qhy991/deepseek-harness", workflow)
        self.assertNotIn("pnpm install", workflow)


if __name__ == "__main__":
    unittest.main()
