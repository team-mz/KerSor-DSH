#!/usr/bin/env python3
"""Launch one KerSor DSH Task in a durable process session."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time
import uuid


PROXY_KEYS = (
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "all_proxy",
)


def regular(path: pathlib.Path, label: str, *, executable: bool = False) -> pathlib.Path:
    resolved = path.expanduser().resolve(strict=True)
    if not resolved.is_file() or resolved.is_symlink():
        raise ValueError(f"{label} must be one regular non-symlink file: {resolved}")
    if executable and not os.access(resolved, os.X_OK):
        raise ValueError(f"{label} must be executable: {resolved}")
    return resolved


def contract_workspace(contract: pathlib.Path) -> pathlib.Path:
    try:
        value = json.loads(contract.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid Task contract: {exc}") from exc
    if not isinstance(value, dict) or value.get("contract_version") != "kersor-task-v1":
        raise ValueError("launcher requires one kersor-task-v1 contract")
    raw = value.get("workspace")
    if not isinstance(raw, str) or not raw:
        raise ValueError("Task workspace must be a non-empty path")
    workspace = pathlib.Path(raw)
    if not workspace.is_absolute():
        workspace = contract.parent / workspace
    workspace = workspace.resolve(strict=True)
    if not workspace.is_dir():
        raise ValueError(f"Task workspace is not a directory: {workspace}")
    return workspace


def canonical_run(path: pathlib.Path, label: str) -> pathlib.Path:
    resolved = path.expanduser().resolve(strict=True)
    if not resolved.is_dir() or resolved.is_symlink():
        raise ValueError(f"{label} must be one canonical directory: {resolved}")
    return resolved


def atomic_json(path: pathlib.Path, value: dict[str, object]) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--node", type=pathlib.Path, required=True)
    result.add_argument("--dsh-cli", type=pathlib.Path, required=True)
    result.add_argument("--dsh-home", type=pathlib.Path, required=True)
    result.add_argument("--contract", type=pathlib.Path, required=True)
    continuation = result.add_mutually_exclusive_group()
    continuation.add_argument("--predecessor-run", type=pathlib.Path)
    continuation.add_argument("--resume-run", type=pathlib.Path)
    result.add_argument("--state-dir", type=pathlib.Path)
    result.add_argument("--ca-file", type=pathlib.Path, default=pathlib.Path("/etc/ssl/cert.pem"))
    return result


def main(argv: list[str] | None = None) -> int:
    options = parser().parse_args(argv)
    try:
        node = regular(options.node, "Node", executable=True)
        dsh_cli = regular(options.dsh_cli, "DSH CLI")
        contract = regular(options.contract, "Task contract")
        workspace = contract_workspace(contract)
        predecessor = (
            canonical_run(options.predecessor_run, "predecessor run")
            if options.predecessor_run is not None
            else None
        )
        resume = (
            canonical_run(options.resume_run, "resume run")
            if options.resume_run is not None
            else None
        )
        dsh_home = options.dsh_home.expanduser().resolve(strict=True)
        if not dsh_home.is_dir():
            raise ValueError(f"DSH_HOME is not a directory: {dsh_home}")
        state_dir = (
            options.state_dir.expanduser().resolve()
            if options.state_dir is not None
            else dsh_home / "kersor-launches"
        )
        state_dir.mkdir(parents=True, exist_ok=True)
    except (OSError, ValueError) as exc:
        print(f"launch-task: {exc}", file=sys.stderr)
        return 2

    launch_id = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + f"-{uuid.uuid4().hex[:8]}"
    log_path = state_dir / f"{launch_id}.log"
    receipt_path = state_dir / f"{launch_id}.json"
    command = [
        str(node), str(dsh_cli), "--profile", "kersor", "evolve", str(contract),
        *([] if predecessor is None else ["--predecessor-run", str(predecessor)]),
        *([] if resume is None else ["--resume-run", str(resume)]),
    ]
    environment = os.environ.copy()
    environment["DSH_HOME"] = str(dsh_home)
    for key in PROXY_KEYS:
        environment.pop(key, None)
    if options.ca_file.is_file():
        environment["NODE_EXTRA_CA_CERTS"] = str(options.ca_file.resolve())

    try:
        with log_path.open("xb") as log:
            process = subprocess.Popen(
                command,
                cwd=workspace,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                close_fds=True,
            )
        time.sleep(0.5)
        returncode = process.poll()
        if returncode is not None:
            detail = log_path.read_text(encoding="utf-8", errors="replace")[-4000:]
            raise RuntimeError(f"DSH exited during launch with {returncode}: {detail}")
        receipt = {
            "schema_version": 1,
            "launch_id": launch_id,
            "status": "running",
            "started_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "pid": process.pid,
            "process_group_id": process.pid,
            "workspace": str(workspace),
            "contract": str(contract),
            "contract_sha256": hashlib.sha256(contract.read_bytes()).hexdigest(),
            "predecessor_run": None if predecessor is None else str(predecessor),
            "resume_run": None if resume is None else str(resume),
            "dsh_home": str(dsh_home),
            "command": command,
            "log": str(log_path),
        }
        atomic_json(receipt_path, receipt)
    except (OSError, RuntimeError) as exc:
        print(f"launch-task: {exc}", file=sys.stderr)
        return 1

    print(json.dumps({**receipt, "receipt": str(receipt_path)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
