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


def test_launcher_detaches_and_keeps_receipt_outside_workspace(tmp_path: pathlib.Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    predecessor = workspace / ".kersor" / "prior-run"
    predecessor.mkdir(parents=True)
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
    completed = subprocess.run(
        [
            sys.executable, str(LAUNCHER),
            "--node", str(fake_node),
            "--dsh-cli", str(cli),
            "--dsh-home", str(dsh_home),
            "--contract", str(contract),
            "--predecessor-run", str(predecessor),
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
        assert pathlib.Path(receipt["receipt"]).parent == dsh_home / "kersor-launches"
        assert receipt["predecessor_run"] == str(predecessor)
        assert receipt["resume_run"] is None
        assert receipt["command"][-2:] == ["--predecessor-run", str(predecessor)]
        assert not (workspace / ".kersor-launches").exists()
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


def test_launcher_passes_explicit_resume_run(tmp_path: pathlib.Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    run = workspace / ".kersor" / "interrupted-run"
    run.mkdir(parents=True)
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

    completed = subprocess.run(
        [
            sys.executable, str(LAUNCHER),
            "--node", str(fake_node),
            "--dsh-cli", str(cli),
            "--dsh-home", str(dsh_home),
            "--contract", str(contract),
            "--resume-run", str(run),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    receipt = json.loads(completed.stdout)
    try:
        assert receipt["predecessor_run"] is None
        assert receipt["resume_run"] == str(run)
        assert receipt["command"][-2:] == ["--resume-run", str(run)]
    finally:
        try:
            os.killpg(receipt["process_group_id"], signal.SIGTERM)
        except ProcessLookupError:
            pass
