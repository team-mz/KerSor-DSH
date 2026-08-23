"""Host-tool regression tests for the KerSor Mission launcher."""

from __future__ import annotations

import json
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "presets" / "kersor" / "plugins" / "kersor-evolve.mjs"
BRIDGE_SOURCE = ROOT / "presets" / "kersor" / "bin" / "kersor_bridge.py"
NODE = shutil.which("node")


FAKE_BRIDGE = """\
import json
import os
import subprocess
import sys
import time
from pathlib import Path

contract = Path(sys.argv[sys.argv.index("--contract") + 1])
request = json.loads(contract.read_text(encoding="utf-8"))
if request.get("mode") == "descendant":
    marker = request["marker"]
    subprocess.Popen([
        sys.executable,
        "-c",
        "import pathlib,time; time.sleep(1); pathlib.Path(" + repr(marker) + ").write_text('orphan')",
    ])
if request.get("mode") == "sleep":
    time.sleep(30)
if request.get("mode") == "descendant":
    time.sleep(30)
terminal = {
    "status": request.get("status", "completed"),
    "argv": sys.argv[1:],
    "cwd": os.getcwd(),
    "ambient_kersor_root": os.environ.get("KERSOR_ROOT"),
    "ambient_pythonpath": os.environ.get("PYTHONPATH"),
    "ambient_aws": os.environ.get("AWS_SECRET_ACCESS_KEY"),
    "ambient_github": os.environ.get("GITHUB_TOKEN"),
    "ambient_ssh": os.environ.get("SSH_AUTH_SOCK"),
    "ambient_openai": os.environ.get("OPENAI_API_KEY"),
}
if request.get("mode") == "multiple":
    print(json.dumps(terminal))
print(json.dumps(terminal))
raise SystemExit(request.get("exit", 0))
"""


NODE_DRIVER = r"""
import fs from 'node:fs'
import {pathToFileURL} from 'node:url'

const request = JSON.parse(fs.readFileSync(0, 'utf8'))
const plugin = await import(pathToFileURL(request.module).href)
const tool = plugin.createTool({timeoutMs: request.timeout_ms ?? 5000})
const controller = new AbortController()
if (request.abort_after_ms !== undefined) {
  setTimeout(() => controller.abort(new Error('test cancellation')), request.abort_after_ms).unref()
}
let concludeCount = 0
const exec = {
  callId: 'call-test-evolve',
  agent: {session: {
    header: {cwd: request.cwd, origin: request.origin ?? 'user'},
    events: [{type: 'tool/call', data: {turn: 1, step: 1, callId: 'call-test-evolve', name: 'kersor_evolve'}}],
  }},
  signal: controller.signal,
  concludeTurn() { concludeCount += 1 },
}
let payload
try {
  const value = await tool.execute(request.args, exec)
  const meta = tool.output.presentationMeta?.(request.args, value)
  const presentation = tool.presentResult?.(request.args, {isError: false, content: [], meta})
  if (request.second_call === true) {
    try {
      await tool.execute(request.args, exec)
      payload = {ok: false, conclude_count: concludeCount, error: 'second call unexpectedly succeeded'}
    } catch (error) {
      payload = {
        ok: true,
        conclude_count: concludeCount,
        value,
        presentation_meta: meta,
        presentation,
        second_error: String(error?.message ?? error),
      }
    }
  } else {
    payload = {
      ok: true,
      conclude_count: concludeCount,
      value,
      presentation_meta: meta,
      presentation,
    }
  }
} catch (error) {
  if (request.second_call === true) {
    const firstError = String(error?.message ?? error)
    try {
      await tool.execute(request.args, exec)
      payload = {ok: false, conclude_count: concludeCount, error: 'second call unexpectedly succeeded'}
    } catch (secondError) {
      payload = {
        ok: true,
        conclude_count: concludeCount,
        first_error: firstError,
        second_error: String(secondError?.message ?? secondError),
      }
    }
  } else {
    payload = {ok: false, conclude_count: concludeCount, error: String(error?.message ?? error)}
  }
}
payload.status_schema = tool.output.schema.properties.status
process.stdout.write(JSON.stringify(payload))
"""


DSH_NODE_DRIVER = r"""
import fs from 'node:fs'
import {pathToFileURL} from 'node:url'

const request = JSON.parse(fs.readFileSync(0, 'utf8'))
const driverStartedAt = Date.now()
const plugin = await import(pathToFileURL(request.module).href)
const listeners = new Map()
const telemetry = {
  starts: [],
  guards: {},
  dispose_count: 0,
}
const topLevelGuards = []
let registeredTool
const child = {
  id: 'dsh-child-route-probe',
  options: {provider: plugin.DSH_PROVIDER, model: plugin.DSH_MODEL},
  session: {
    events: [{
      type: 'assistant/message',
      data: {
        usage: {
          inputTokens: 11,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
          outputTokens: 7,
        },
      },
    }],
  },
  ctx: {
    tools: {
      guard(value) {
        telemetry.guard_registered = true
        telemetry.guard = value
        return () => { telemetry.guard_disposed = true }
      },
    },
  },
  cancel() { telemetry.cancel_count = (telemetry.cancel_count ?? 0) + 1 },
}
const callingAgent = {
  id: 'dsh-parent-route-probe',
  session: {
    header: {cwd: request.cwd, origin: 'user'},
    events: [{type: 'tool/call', data: {turn: 1, step: 1, callId: 'call-dsh-evolve', name: 'kersor_evolve'}}],
  },
}
const ctx = {
  tools: {
    register(tool) {
      registeredTool = tool
      return () => undefined
    },
    guard(value) {
      topLevelGuards.push(value)
      return () => undefined
    },
  },
  on(name, listener) {
    const current = listeners.get(name) ?? []
    current.push(listener)
    listeners.set(name, current)
    return () => undefined
  },
  subagents: {
    async start(provider, value) {
      telemetry.starts.push({
        provider,
        parent_is_caller: value.parent === callingAgent,
        agent_options: value.agentOptions,
        tool_filter: value.toolFilter,
        output_schema: value.outputSchema,
        prompt: value.prompt,
      })
      for (const listener of listeners.get('agent/created') ?? []) listener({agent: child})
      if (typeof telemetry.guard !== 'function') throw new Error('child guard was not installed during agent/created')
      const guardProbes = {
        read: {name: 'read', arguments: {file_path: request.args.contract}},
        glob: {name: 'glob', arguments: {pattern: '*.json'}},
        grep: {name: 'grep', arguments: {pattern: 'runtime'}},
        structured_output: {name: 'structured_output', arguments: {observed: true}},
        edit: {name: 'edit', arguments: {}},
        write: {name: 'write', arguments: {}},
        bash: {name: 'bash', arguments: {}},
        subagent: {name: 'subagent', arguments: {}},
        workflow: {name: 'workflow', arguments: {}},
        kersor_evolve: {name: 'kersor_evolve', arguments: {}},
        read_outside: {name: 'read', arguments: {file_path: request.outside_file}},
        glob_outside: {name: 'glob', arguments: {pattern: '*', path: request.outside_directory}},
        grep_symlink_escape: {name: 'grep', arguments: {pattern: 'secret', path: request.escape_symlink}},
        glob_parent_pattern: {name: 'glob', arguments: {pattern: '../*'}},
      }
      for (const [probe, execution] of Object.entries(guardProbes)) {
        if (Object.values(execution.arguments).includes(undefined)) continue
        telemetry.guards[probe] = telemetry.guard({...execution, agent: child}) ?? null
      }
      let result
      if (request.child_mode === 'wait') {
        result = new Promise(resolve => {
          const settle = () => {
            telemetry.child_abort_count = (telemetry.child_abort_count ?? 0) + 1
            telemetry.child_abort_after_ms = Date.now() - driverStartedAt
            resolve({output: [], stopReason: 'aborted'})
          }
          if (value.signal.aborted) settle()
          else value.signal.addEventListener('abort', settle, {once: true})
        })
      } else {
        result = Promise.resolve({
          output: [{type: 'text', text: 'DSH route probe completed'}],
          structured: {observed: true},
          stopReason: 'completed',
        })
      }
      return {
        id: child.id,
        localAgent: child,
        result,
        async dispose() { telemetry.dispose_count += 1 },
      }
    },
  },
}
plugin.apply(ctx)
if (registeredTool === undefined) throw new Error('kersor_evolve tool was not registered')
const controller = new AbortController()
if (request.abort_after_ms !== undefined) {
  setTimeout(() => controller.abort(new Error('test DSH cancellation')), request.abort_after_ms).unref()
}
const exec = {
  callId: 'call-dsh-evolve',
  agent: callingAgent,
  signal: controller.signal,
  concludeTurn() { telemetry.conclude_count = (telemetry.conclude_count ?? 0) + 1 },
}
let payload
try {
  const value = await registeredTool.execute(request.args, exec)
  if (request.guard_probe === true) {
    callingAgent.session.events.push({
      type: 'tool/call',
      data: {turn: 1, step: 1, callId: 'call-same-turn-bash', name: 'bash'},
    })
    telemetry.same_turn_denials = topLevelGuards
      .map(guard => guard({name: 'bash', callId: 'call-same-turn-bash', agent: callingAgent}))
      .filter(value => value !== undefined)
    callingAgent.session.events.push({
      type: 'tool/call',
      data: {turn: 1, step: 1, callId: 'call-same-turn-code', name: 'run_code'},
    })
    telemetry.same_turn_nested_denials = topLevelGuards
      .map(guard => guard({
        name: 'read',
        callId: 'call-same-turn-code:code:1',
        rootCallId: 'call-same-turn-code',
        agent: callingAgent,
      }))
      .filter(value => value !== undefined)
    callingAgent.session.events.push({type: 'turn/end', data: {turn: 1}})
    callingAgent.session.events.push({
      type: 'tool/call',
      data: {turn: 2, step: 1, callId: 'call-next-turn-code', name: 'run_code'},
    })
    telemetry.next_turn_denials = topLevelGuards
      .map(guard => guard({
        name: 'read',
        callId: 'call-next-turn-code:code:1',
        rootCallId: 'call-next-turn-code',
        agent: callingAgent,
      }))
      .filter(value => value !== undefined)
  }
  payload = {ok: true, value, telemetry}
} catch (error) {
  payload = {ok: false, error: String(error?.message ?? error), telemetry}
}
delete telemetry.guard
process.stdout.write(JSON.stringify(payload))
"""


@unittest.skipIf(NODE is None, "Node.js is required for local plugin tests")
class KerSorEvolvePluginTests(unittest.TestCase):
    """Exercise path custody, Host spawning, terminal handling, and cancellation."""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.preset = self.root / "installed-preset"
        (self.preset / "plugins").mkdir(parents=True)
        (self.preset / "bin").mkdir()
        (self.preset / ".local").mkdir()
        self.module = self.preset / "plugins" / "kersor-evolve.mjs"
        shutil.copy2(SOURCE, self.module)
        (self.preset / "bin" / "kersor_bridge.py").write_text(
            FAKE_BRIDGE, encoding="utf-8"
        )
        self.core = self.root / "trusted-kersor-core"
        self.core.mkdir()
        (self.preset / ".local" / "kersor-root").write_text(
            f"{self.core}\n", encoding="utf-8"
        )
        self.home = self.root / "trusted-home"
        self.temp_dir = self.root / "trusted-temp"
        self.home.mkdir()
        self.temp_dir.mkdir()
        (self.preset / ".local" / "runtime-tools.json").write_text(
            json.dumps({
                "schema_version": 1,
                "tools": {"python3": sys.executable},
                "environment": {
                    "home": str(self.home),
                    "temp_dir": str(self.temp_dir),
                },
            }),
            encoding="utf-8",
        )
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.outside_secret = self.home / "secret.txt"
        self.outside_secret.write_text("outside-secret-must-not-leak\n", encoding="utf-8")
        self.escape_symlink = self.workspace / "outside-link"
        self.escape_symlink.symlink_to(self.home, target_is_directory=True)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def invoke(
        self,
        args: dict[str, object],
        *,
        origin: str = "user",
        abort_after_ms: int | None = None,
        timeout_ms: int = 5_000,
        second_call: bool = False,
    ) -> tuple[dict[str, object], float]:
        request: dict[str, object] = {
            "module": str(self.module),
            "cwd": str(self.workspace),
            "origin": origin,
            "args": args,
            "timeout_ms": timeout_ms,
            "second_call": second_call,
        }
        if abort_after_ms is not None:
            request["abort_after_ms"] = abort_after_ms
        environment = dict(os.environ)
        environment["KERSOR_ROOT"] = str(self.workspace / "poisoned-root")
        environment["PYTHONPATH"] = str(self.workspace / "poisoned-python")
        environment["AWS_SECRET_ACCESS_KEY"] = "ambient-aws-secret"
        environment["GITHUB_TOKEN"] = "ambient-github-secret"
        environment["SSH_AUTH_SOCK"] = str(self.workspace / "ambient-ssh.sock")
        environment["OPENAI_API_KEY"] = "ambient-openai-secret"
        started = time.monotonic()
        completed = subprocess.run(
            [NODE, "--input-type=module", "-e", NODE_DRIVER],
            input=json.dumps(request),
            check=False,
            capture_output=True,
            text=True,
            env=environment,
            timeout=10,
        )
        elapsed = time.monotonic() - started
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout), elapsed

    def write_contract(self, **value: object) -> Path:
        contract = self.workspace / f"mission-{len(list(self.workspace.iterdir()))}.json"
        contract.write_text(json.dumps(value), encoding="utf-8")
        return contract

    def prepare_dsh_native_core(self) -> None:
        """Provide a deterministic core transport while retaining the real bridge route."""
        shutil.copy2(BRIDGE_SOURCE, self.preset / "bin" / "kersor_bridge.py")
        (self.core / "AGENTS.md").write_text("test core\n", encoding="utf-8")
        (self.core / "commands").mkdir()
        scripts = self.core / "scripts"
        scripts.mkdir()
        (scripts / "compose.py").write_text("\n", encoding="utf-8")
        (scripts / "doctor.sh").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
        config = self.core / "config"
        config.mkdir()
        (config / "runtime-dsh-autonomous.json").write_text(
            json.dumps({
                "contract_version": "akw-js-runtime-v1",
                "budget": {"total_tokens": 1000},
                "broker": {
                    "type": "dsh-host-rpc",
                    "protocol": "kersor-dsh-host-rpc-v1",
                    "socket_env": "KERSOR_DSH_RPC_SOCKET",
                    "nonce_env": "KERSOR_DSH_RPC_NONCE",
                    "max_frame_bytes": 16 * 1024 * 1024,
                    "provider": "deepseek-official",
                    "model": "deepseek-v4-flash",
                    "timeout_seconds": 900,
                },
            }),
            encoding="utf-8",
        )
        (scripts / "create-session.py").write_text(
            "import json, pathlib, sys\n"
            "payload = json.load(sys.stdin)\n"
            "target = pathlib.Path(sys.argv[1])\n"
            "(target / 'session-config.json').write_text(json.dumps(payload['config']))\n"
            "(target / 'state.json').write_text(json.dumps(payload['state']))\n",
            encoding="utf-8",
        )
        (scripts / "run-autonomous-workflow.py").write_text(
            "raise SystemExit(0)\n", encoding="utf-8"
        )
        (scripts / "dsh-route-probe.py").write_text(
            "import json, os, socket, struct, sys, time\n"
            "from pathlib import Path\n"
            "contract = Path(sys.argv[1])\n"
            "contract_value = json.loads(contract.read_text())\n"
            "request = {\n"
            "  'protocol': 'kersor-dsh-host-rpc-v1',\n"
            "  'type': 'execute',\n"
            "  'request_id': 'route-probe-1',\n"
            "  'nonce': os.environ['KERSOR_DSH_RPC_NONCE'],\n"
            "  'activation': {\n"
            "    'contract_version': 'akw-js-runtime-v1',\n"
            "    'call_id': 'route-probe/inspect/1',\n"
            "    'label': 'read-only route probe',\n"
            "    'prompt': 'Inspect the workspace without mutation.',\n"
            "    'schema': {'type': 'object', 'properties': {'observed': {'type': 'boolean'}}, 'required': ['observed']},\n"
            "    'options': {},\n"
            f"    'project_root': {str(self.workspace)!r},\n"
            "  },\n"
            "}\n"
            "if contract_value.get('probe_mode') == 'sequential-65':\n"
            "  last = None\n"
            "  for index in range(65):\n"
            "    request['request_id'] = f'route-probe-{index}'\n"
            "    payload = json.dumps(request, separators=(',', ':')).encode()\n"
            "    sequential = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\n"
            "    sequential.connect(os.environ['KERSOR_DSH_RPC_SOCKET'])\n"
            "    sequential.sendall(struct.pack('>I', len(payload)) + payload)\n"
            "    header = sequential.recv(4)\n"
            "    size = struct.unpack('>I', header)[0]\n"
            "    chunks = bytearray()\n"
            "    while len(chunks) < size:\n"
            "      chunks.extend(sequential.recv(size - len(chunks)))\n"
            "    sequential.close()\n"
            "    last = json.loads(chunks)\n"
            "    if last.get('ok') is not True:\n"
            "      raise RuntimeError(last)\n"
            "  print(json.dumps({'status': 'completed', 'activation_count': 65, 'dsh_result': last['result']}))\n"
            "  raise SystemExit(0)\n"
            "payload = json.dumps(request, separators=(',', ':')).encode()\n"
            "sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)\n"
            "sock.connect(os.environ['KERSOR_DSH_RPC_SOCKET'])\n"
            "sock.sendall(struct.pack('>I', len(payload)) + payload)\n"
            "if contract_value.get('probe_mode') == 'disconnect':\n"
            "  sock.close()\n"
            "  time.sleep(1.2)\n"
            "  print(json.dumps({'status': 'failed'}))\n"
            "  raise SystemExit(2)\n"
            "header = sock.recv(4)\n"
            "size = struct.unpack('>I', header)[0]\n"
            "chunks = bytearray()\n"
            "while len(chunks) < size:\n"
            "  chunks.extend(sock.recv(size - len(chunks)))\n"
            "response = json.loads(chunks)\n"
            "if response.get('ok') is not True:\n"
            "  raise RuntimeError(response)\n"
            "socket_path = Path(os.environ['KERSOR_DSH_RPC_SOCKET'])\n"
            "terminal = {\n"
            "  'status': 'completed',\n"
            "  'dsh_result': response['result'],\n"
            "  'rpc_probe': {\n"
            "    'socket_mode': oct(socket_path.stat().st_mode & 0o777),\n"
            "    'directory_mode': oct(socket_path.parent.stat().st_mode & 0o777),\n"
            "    'nonce_bytes': len(bytes.fromhex(os.environ['KERSOR_DSH_RPC_NONCE'])),\n"
            "  },\n"
            "}\n"
            "print(json.dumps(terminal))\n",
            encoding="utf-8",
        )
        (scripts / "evolve.sh").write_text(
            "#!/usr/bin/env bash\n"
            "set -euo pipefail\n"
            f"exec {sys.executable!s} {scripts / 'dsh-route-probe.py'!s} \"$1\"\n",
            encoding="utf-8",
        )
        os.chmod(scripts / "evolve.sh", 0o755)
        manifest_path = self.preset / ".local" / "runtime-tools.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for name, executable in {
            "bash": shutil.which("bash"),
            "python3": sys.executable,
            "node": NODE,
            "jq": shutil.which("jq") or sys.executable,
        }.items():
            self.assertIsNotNone(executable, name)
            manifest["tools"][name] = executable
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    def invoke_dsh_native(
        self,
        contract: Path,
        *,
        abort_after_ms: int | None = None,
        child_mode: str | None = None,
        guard_probe: bool = False,
    ) -> dict[str, object]:
        request: dict[str, object] = {
            "module": str(self.module),
            "cwd": str(self.workspace),
            "args": {"contract": str(contract)},
            "outside_file": str(self.outside_secret),
            "outside_directory": str(self.home),
            "escape_symlink": str(self.escape_symlink),
        }
        if abort_after_ms is not None:
            request["abort_after_ms"] = abort_after_ms
        if child_mode is not None:
            request["child_mode"] = child_mode
        if guard_probe:
            request["guard_probe"] = True
        completed = subprocess.run(
            [NODE, "--input-type=module", "-e", DSH_NODE_DRIVER],
            input=json.dumps(request),
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def test_public_tool_routes_read_only_dsh_mission_to_pinned_spawn_child(self) -> None:
        self.prepare_dsh_native_core()
        session = self.workspace / ".kersor-autonomous" / "route-probe"
        local_runtime_config = self.workspace / "runtime-config.json"
        local_runtime_config.write_bytes(
            (self.core / "config" / "runtime-dsh-autonomous.json").read_bytes()
        )
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(session),
            runtime="dsh",
            runtime_config=local_runtime_config.name,
            mission={
                "mission_id": "route-probe",
                "goal": "inspect safely",
                "authority": ["read workspace"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{
                "name": "inspect",
                "side_effect": "read",
            }],
        )

        result = self.invoke_dsh_native(contract, guard_probe=True)

        self.assertTrue(result["ok"], result.get("error"))
        telemetry = result["telemetry"]
        self.assertEqual(len(telemetry["starts"]), 1)
        start = telemetry["starts"][0]
        self.assertEqual(start["provider"], "spawn")
        self.assertTrue(start["parent_is_caller"])
        self.assertEqual(start["agent_options"], {
            "provider": "deepseek-official",
            "model": "deepseek-v4-flash",
        })
        self.assertEqual(start["tool_filter"], {"allow": ["read", "glob", "grep"]})
        self.assertEqual(telemetry["dispose_count"], 1)
        self.assertEqual(telemetry["conclude_count"], 1)
        self.assertEqual(len(telemetry["same_turn_denials"]), 1)
        self.assertIn("owns the rest", telemetry["same_turn_denials"][0])
        self.assertEqual(len(telemetry["same_turn_nested_denials"]), 1)
        self.assertIn("owns the rest", telemetry["same_turn_nested_denials"][0])
        self.assertEqual(telemetry["next_turn_denials"], [])
        for allowed in ("read", "glob", "grep", "structured_output"):
            self.assertIsNone(telemetry["guards"][allowed])
        for forbidden in ("edit", "write", "bash", "subagent", "workflow", "kersor_evolve"):
            self.assertIn("read-only", telemetry["guards"][forbidden])
        for escaped in ("read_outside", "glob_outside", "grep_symlink_escape", "glob_parent_pattern"):
            self.assertIsNotNone(telemetry["guards"][escaped])
        self.assertNotIn("outside-secret-must-not-leak", json.dumps(result))
        terminal = result["value"]
        self.assertEqual(terminal["rpc_probe"], {
            "socket_mode": "0o600",
            "directory_mode": "0o700",
            "nonce_bytes": 32,
        })
        receipt = terminal["dsh_result"]
        self.assertEqual(receipt["provider"], "deepseek-official")
        self.assertEqual(receipt["model"], "deepseek-v4-flash")
        self.assertTrue(receipt["usage_observed"])
        self.assertTrue(receipt["usage_complete"])
        self.assertEqual(receipt["usage"], {
            "input_tokens": 11,
            "cached_input_tokens": 5,
            "output_tokens": 7,
            "total_tokens": 23,
        })

    def test_cancellation_aborts_and_disposes_the_dsh_child(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "cancel"),
            runtime="dsh",
            mission={
                "mission_id": "cancel",
                "goal": "wait safely",
                "authority": ["read workspace"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{"name": "inspect", "side_effect": "read"}],
        )

        started = time.monotonic()
        result = self.invoke_dsh_native(
            contract,
            abort_after_ms=250,
            child_mode="wait",
        )

        self.assertFalse(result["ok"])
        self.assertIn("test DSH cancellation", result["error"])
        self.assertEqual(result["telemetry"]["child_abort_count"], 1)
        self.assertEqual(result["telemetry"]["dispose_count"], 1)
        self.assertEqual(result["telemetry"].get("conclude_count", 0), 0)
        self.assertLess(time.monotonic() - started, 4)

    def test_public_tool_rejects_dsh_mutation_before_child_start(self) -> None:
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "write"),
            runtime="dsh",
            mission={
                "mission_id": "write",
                "goal": "mutate",
                "authority": ["write workspace"],
                "required_artifacts": ["candidate.py"],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{
                "name": "mutate",
                "side_effect": "write",
                "transaction_artifacts": ["candidate.py"],
            }],
        )

        result = self.invoke_dsh_native(contract)

        self.assertTrue(result["ok"])
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn(
            "read-only Mission capabilities only",
            result["value"]["error"],
        )
        self.assertEqual(result["telemetry"]["conclude_count"], 1)
        self.assertEqual(result["telemetry"]["starts"], [])

    def test_core_disconnect_aborts_and_disposes_only_that_dsh_child(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "disconnect"),
            runtime="dsh",
            probe_mode="disconnect",
            mission={
                "mission_id": "disconnect",
                "goal": "disconnect one activation",
                "authority": ["read workspace"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{"name": "inspect", "side_effect": "read"}],
        )

        result = self.invoke_dsh_native(contract, child_mode="wait")

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["status"], "failed")
        self.assertEqual(result["telemetry"]["child_abort_count"], 1)
        self.assertLess(result["telemetry"]["child_abort_after_ms"], 800)
        self.assertEqual(result["telemetry"]["dispose_count"], 1)

    def test_connection_limit_counts_concurrency_not_total_activations(self) -> None:
        self.prepare_dsh_native_core()
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "sequential"),
            runtime="dsh",
            probe_mode="sequential-65",
            mission={
                "mission_id": "sequential",
                "goal": "run bounded sequential reads",
                "authority": ["read workspace"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{"name": "inspect", "side_effect": "read"}],
        )

        result = self.invoke_dsh_native(contract)

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["value"]["activation_count"], 65)
        self.assertEqual(len(result["telemetry"]["starts"]), 65)
        self.assertEqual(result["telemetry"]["dispose_count"], 65)

    def test_public_tool_rejects_dsh_host_commands_without_reading_home(self) -> None:
        contract = self.write_contract(
            contract_version="kersor-mission-v1",
            workspace=str(self.workspace),
            session=str(self.workspace / ".kersor-autonomous" / "host-command"),
            runtime="dsh",
            mission={
                "mission_id": "host-command",
                "goal": "attempt a forbidden Host read",
                "authority": ["read workspace"],
                "required_artifacts": [],
                "required_facts": {},
                "max_revisions": 1,
            },
            capabilities=[{
                "name": "forbidden-host-reader",
                "side_effect": "read",
                "execution": {
                    "kind": "host_evaluator",
                    "request": {
                        "protocol": "command-v1",
                        "argv": ["/bin/cat", str(self.outside_secret)],
                        "filesystem_policy": "read-only",
                        "network_policy": "denied",
                        "output_policy": "sealed",
                        "timeout_seconds": 5,
                    },
                },
            }],
        )

        result = self.invoke_dsh_native(contract)

        self.assertTrue(result["ok"])
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn(
            "rejects Host evaluator and command",
            result["value"]["error"],
        )
        self.assertEqual(result["telemetry"]["conclude_count"], 1)
        self.assertEqual(result["telemetry"]["starts"], [])
        self.assertNotIn("outside-secret-must-not-leak", json.dumps(result))

    def test_calls_frozen_bridge_once_from_current_workspace_and_concludes(self) -> None:
        contract = self.write_contract(status="completed")
        result, _ = self.invoke({"contract": str(contract)})
        self.assertTrue(result["ok"])
        self.assertEqual(result["conclude_count"], 1)
        terminal = result["value"]
        self.assertEqual(terminal["cwd"], str(self.workspace.resolve()))
        self.assertEqual(
            terminal["argv"],
            [
                "evolve",
                "--host-execution",
                "--contract",
                str(contract.resolve()),
                "--expected-contract-sha256",
                hashlib.sha256(contract.read_bytes()).hexdigest(),
            ],
        )
        self.assertIsNone(terminal["ambient_kersor_root"])
        self.assertIsNone(terminal["ambient_pythonpath"])
        self.assertIsNone(terminal["ambient_aws"])
        self.assertIsNone(terminal["ambient_github"])
        self.assertIsNone(terminal["ambient_ssh"])
        self.assertIsNone(terminal["ambient_openai"])
        self.assertEqual(
            result["status_schema"]["enum"],
            ["completed", "blocked", "waiting", "failed"],
        )

    def test_rejects_relative_foreign_and_subagent_paths_without_concluding(self) -> None:
        contract = self.write_contract(status="completed")
        foreign = self.root / "foreign.json"
        foreign.write_text("{}", encoding="utf-8")
        cases = [
            ({"contract": contract.name}, "user", "absolute path"),
            ({"contract": str(foreign)}, "user", "current DSH workspace"),
            ({"contract": str(contract)}, "subagent", "top-level"),
        ]
        for args, origin, message in cases:
            with self.subTest(message=message):
                result, _ = self.invoke(args, origin=origin)
                self.assertFalse(result["ok"])
                self.assertEqual(result["conclude_count"], 0)
                self.assertIn(message, result["error"])

    def test_rejects_a_workspace_owned_installed_core(self) -> None:
        contract = self.write_contract(status="completed")
        (self.preset / ".local" / "kersor-root").write_text(
            f"{self.workspace}\n", encoding="utf-8"
        )
        result, _ = self.invoke({"contract": str(contract)})
        self.assertTrue(result["ok"])
        self.assertEqual(result["conclude_count"], 1)
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn(
            "checkout cannot be owned by the DSH workspace",
            result["value"]["error"],
        )

    def test_blocked_terminal_is_returned_and_concludes(self) -> None:
        contract = self.write_contract(status="blocked", exit=2)
        result, _ = self.invoke({"contract": str(contract)})
        self.assertTrue(result["ok"])
        self.assertEqual(result["conclude_count"], 1)
        self.assertEqual(result["value"]["status"], "blocked")

    def test_second_call_in_one_top_level_session_is_rejected(self) -> None:
        contract = self.write_contract(status="completed")
        result, _ = self.invoke({"contract": str(contract)}, second_call=True)
        self.assertTrue(result["ok"])
        self.assertEqual(result["conclude_count"], 1)
        self.assertIn("only one call per top-level DSH session", result["second_error"])

    def test_failed_call_also_consumes_the_top_level_session(self) -> None:
        contract = self.write_contract(status="cancelled", exit=2)
        result, _ = self.invoke(
            {"contract": str(contract)}, second_call=True
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["conclude_count"], 1)
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn("completed|blocked|waiting|failed", result["value"]["error"])
        self.assertEqual(result["presentation_meta"], {"status": "failed"})
        self.assertEqual(
            result["presentation"]["title"],
            "KerSor Mission · failed",
        )
        self.assertIn("only one call per top-level DSH session", result["second_error"])

    def test_terminal_status_and_exit_code_mapping_is_closed(self) -> None:
        for status in ("blocked", "waiting", "failed"):
            with self.subTest(status=status):
                contract = self.write_contract(status=status, exit=2)
                result, _ = self.invoke({"contract": str(contract)})
                self.assertTrue(result["ok"])
                self.assertEqual(result["conclude_count"], 1)
        unknown = self.write_contract(status="cancelled", exit=2)
        result, _ = self.invoke({"contract": str(unknown)})
        self.assertTrue(result["ok"])
        self.assertEqual(result["conclude_count"], 1)
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn(
            "completed|blocked|waiting|failed",
            result["value"]["error"],
        )
        mismatch = self.write_contract(status="waiting", exit=0)
        result, _ = self.invoke({"contract": str(mismatch)})
        self.assertTrue(result["ok"])
        self.assertEqual(result["conclude_count"], 1)
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn("expected 2", result["value"]["error"])

    def test_cancel_terminates_the_foreground_process_group(self) -> None:
        contract = self.write_contract(mode="sleep")
        result, elapsed = self.invoke(
            {"contract": str(contract)}, abort_after_ms=50, timeout_ms=5_000
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["conclude_count"], 0)
        self.assertIn("test cancellation", result["error"])
        self.assertLess(elapsed, 4)

    def test_cancelled_call_also_consumes_the_top_level_session(self) -> None:
        contract = self.write_contract(mode="sleep")
        result, elapsed = self.invoke(
            {"contract": str(contract)},
            abort_after_ms=50,
            timeout_ms=5_000,
            second_call=True,
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["conclude_count"], 0)
        self.assertIn("test cancellation", result["first_error"])
        self.assertIn("only one call per top-level DSH session", result["second_error"])
        self.assertLess(elapsed, 4)

    def test_cancel_kills_normal_descendants_without_orphans(self) -> None:
        marker = self.root / "orphan-marker"
        contract = self.write_contract(mode="descendant", marker=str(marker))
        result, elapsed = self.invoke(
            {"contract": str(contract)}, abort_after_ms=100, timeout_ms=5_000
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["conclude_count"], 0)
        self.assertLess(elapsed, 4)
        time.sleep(1.2)
        self.assertFalse(marker.exists())

    def test_rejects_multiple_json_terminals(self) -> None:
        contract = self.write_contract(mode="multiple")
        result, _ = self.invoke({"contract": str(contract)})
        self.assertTrue(result["ok"])
        self.assertEqual(result["conclude_count"], 1)
        self.assertEqual(result["value"]["status"], "failed")
        self.assertIn("exactly one JSON terminal", result["value"]["error"])


if __name__ == "__main__":
    unittest.main()
