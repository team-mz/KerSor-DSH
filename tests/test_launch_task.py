from __future__ import annotations

import json
import os
import pathlib
import signal
import subprocess
import sys
import time


ROOT = pathlib.Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "scripts" / "launch-task.py"


def test_launcher_detaches_and_persists_one_receipt(tmp_path: pathlib.Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    contract = tmp_path / "task.json"
    contract.write_text(json.dumps({
        "contract_version": "kersor-task-v1",
        "workspace": "workspace",
    }), encoding="utf-8")
    dsh_home = tmp_path / "dsh-home"
    dsh_home.mkdir()
    cli = tmp_path / "cli.js"
    cli.write_text("// fake DSH CLI\n", encoding="utf-8")
    fake_node = tmp_path / "node"
    fake_node.write_text(
        "#!/usr/bin/env python3\n"
        "import time\n"
        "time.sleep(30)\n",
        encoding="utf-8",
    )
    fake_node.chmod(0o755)
    state = tmp_path / "state"

    completed = subprocess.run(
        [
            sys.executable, str(LAUNCHER),
            "--node", str(fake_node),
            "--dsh-cli", str(cli),
            "--dsh-home", str(dsh_home),
            "--contract", str(contract),
            "--state-dir", str(state),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    receipt = json.loads(completed.stdout)
    try:
        assert receipt["status"] == "running"
        assert receipt["pid"] == receipt["process_group_id"]
        assert pathlib.Path(receipt["receipt"]).is_file()
        assert pathlib.Path(receipt["log"]).is_file()
        os.kill(receipt["pid"], 0)
    finally:
        try:
            os.killpg(receipt["process_group_id"], signal.SIGTERM)
        except ProcessLookupError:
            pass
        for _ in range(50):
            try:
                os.kill(receipt["pid"], 0)
            except ProcessLookupError:
                break
            time.sleep(0.02)
