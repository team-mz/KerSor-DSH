import { t as hostNormalizableSetupArguments } from "./setup-tool-arguments-CKyqBbr1.js";
import { n as parseKersorLaunchContract, t as canonicalKersorJson } from "./types-C5MPqkXa.js";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
//#region lib/types/invariant.js
/**
* Package-owned invariants for the KerSor launcher and conversation binding.
* @module @deepseek-ai/dsh-kersor/invariant
*/
const PACKAGE_NAME = "@deepseek-ai/dsh-kersor";
const STATUSES = new Set([
	"provisioning",
	"running",
	"waiting",
	"blocked",
	"completed",
	"cancelled"
]);
const STEP_STATUSES = new Set([
	"pending",
	"active",
	"completed",
	"failed"
]);
const SESSION_INITIALIZED_KEYS = Object.freeze([
	"schema_version",
	"contract",
	"authority",
	"experiment_id",
	"workspace",
	"session_dir",
	"controller_session_id",
	"setup_call_id",
	"setup_command",
	"kersor_python",
	"launch",
	"session_config",
	"state",
	"workflow_catalog",
	"adapter",
	"kernel"
]);
const SESSION_AUTHORITY_INTENT_KEYS = Object.freeze([
	"attach_call_id",
	"workspace",
	"session_dir",
	"source_parent_session_id",
	"source_controller_session_id",
	"pre_transfer_event_watermark",
	"pre_transfer_event_sha256",
	"source_setup_receipt",
	"source_state",
	"source_workflow_catalog"
]);
const SESSION_AUTHORITY_TRANSFERRED_KEYS = Object.freeze([
	"schema_version",
	"contract",
	"authority",
	"experiment_id",
	"workspace",
	"session_dir",
	"source_parent_session_id",
	"source_controller_session_id",
	"target_parent_session_id",
	"target_controller_session_id",
	"attach_call_id",
	"launch",
	"pre_transfer_event_watermark",
	"pre_transfer_event_sha256",
	"source_setup_receipt",
	"source_state",
	"source_workflow_catalog"
]);
const SESSION_AUTHORITY_IMPORTED_KEYS = Object.freeze([
	"schema_version",
	"contract",
	"authority",
	"experiment_id",
	"workspace",
	"session_dir",
	"controller_session_id",
	"attached_parent_session_id",
	"attach_call_id",
	"launch",
	"source_parent_session_id",
	"source_controller_session_id",
	"source_event_watermark",
	"source_event_sha256",
	"source_setup_receipt",
	"source_transfer_receipt",
	"source_state",
	"source_workflow_catalog"
]);
const PRODUCER_KEYS = Object.freeze([
	"schema_version",
	"contract",
	"authority",
	"session_dir",
	"run_dir",
	"round",
	"workflow_name",
	"controller_session_id",
	"producer_session_id",
	"producer_call_id",
	"dispatch_args",
	"dispatch_args_provenance"
]);
const TRANSFORMATION_KEYS = Object.freeze([
	"schema_version",
	"contract",
	"authority",
	"transformer",
	"session_dir",
	"run_dir",
	"round",
	"workflow_name",
	"controller_session_id",
	"transformation_call_id",
	"producer_receipt",
	"input",
	"output",
	"changed",
	"authorized_fields"
]);
const CANDIDATE_SEAL_KEYS = Object.freeze([
	"schema_version",
	"contract",
	"authority",
	"session_dir",
	"run_dir",
	"round",
	"controller_session_id",
	"seal_call_id",
	"seal",
	"state"
]);
const AUTHOR_PRODUCED_KEYS = Object.freeze([
	"schema_version",
	"contract",
	"authority",
	"session_dir",
	"controller_session_id",
	"author_call_id",
	"author_session_id",
	"author_context"
]);
const AUTHOR_SEAL_KEYS = Object.freeze([
	"schema_version",
	"contract",
	"authority",
	"session_dir",
	"controller_session_id",
	"author_call_id",
	"author_session_id",
	"seal_call_id",
	"handoff"
]);
const AUTHOR_SAVE_KEYS = Object.freeze([
	"schema_version",
	"contract",
	"authority",
	"session_dir",
	"controller_session_id",
	"save_call_id",
	"seal_call_id",
	"handoff"
]);
const BASELINE_COMMON_KEYS = Object.freeze([
	"schema_version",
	"contract",
	"authority",
	"launch",
	"workspace",
	"session_dir",
	"controller_session_id",
	"call_id",
	"session_config",
	"task_dir",
	"kernel",
	"test_method",
	"commands"
]);
const BASELINE_RECORDED_KEYS = Object.freeze([
	...BASELINE_COMMON_KEYS,
	"initialization_receipt",
	"witness",
	"executions"
]);
const BASELINE_VERIFIED_KEYS = Object.freeze([
	...BASELINE_COMMON_KEYS,
	"recording_receipt",
	"witness",
	"executions",
	"protected_files",
	"worktree",
	"verdict"
]);
const BASELINE_EXECUTION_KEYS = Object.freeze([
	"kind",
	"command",
	"exit_code",
	"timed_out",
	"stdout_sha256",
	"stderr_sha256"
]);
const RUNTIME_ARGS_FIELDS = new Set([
	"termination_file",
	"deadline_epoch",
	"sol_cuda_visible_devices",
	"cuda_visible_devices",
	"gpu",
	"gpu_id",
	"device",
	"sol_env_prefix",
	"env_prefix",
	"sol_cli",
	"benchmark_command",
	"test_command",
	"baseline_command"
]);
const RUNTIME_PROVENANCE_FIELDS = new Set(["runtime_controls", "benchmark_gpu_lease"]);
/** KerSor invariant companion plugin name. */
const name = "kersor-invariant";
/** Services required before the companion can reserve package ownership. */
const inject = ["invariants"];
function record(event, fail) {
	const value = event.data;
	if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${event.type} data must be a JSON object`);
	return value;
}
function text(value, label, fail) {
	if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
	return value;
}
function positiveInteger(value, label, fail) {
	if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive safe integer`);
	return value;
}
function nonNegativeInteger(value, label, fail) {
	if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a non-negative safe integer`);
	return value;
}
function sha256(value, label, fail) {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) fail(`${label} must be a lowercase SHA-256 digest`);
	return value;
}
function exactKeys(value, expected, label, fail) {
	if (!isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())) fail(`${label} fields differ from its Host schema`);
}
function token(value, label, fail) {
	const result = text(value, label, fail);
	if (/\s/.test(result)) fail(`${label} must be one token`);
	return result;
}
function object(value, label, fail) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a JSON object`);
	return value;
}
function fileBinding(value, expectedPath, label, fail) {
	const binding = object(value, label, fail);
	exactKeys(binding, ["path", "sha256"], label, fail);
	if (binding.path !== expectedPath || typeof binding.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(binding.sha256)) fail(`${label} must bind the canonical path and raw SHA-256 digest`);
	return binding;
}
function authorizedFields(value, allowed, label, fail) {
	if (!Array.isArray(value) || value.some((field) => typeof field !== "string")) fail(`${label} must be a sorted unique deterministic allowlist subset`);
	const fields = value;
	if (!isDeepStrictEqual(fields, [...new Set(fields)].sort()) || fields.some((field) => !allowed.has(field))) fail(`${label} must be a sorted unique deterministic allowlist subset`);
	return fields;
}
function canonicalWorkspace(value) {
	const lexical = resolve(value);
	try {
		return realpathSync(lexical);
	} catch {
		return lexical;
	}
}
function controllerEventContext(ctx, session, fail) {
	const parentId = session.header.parentSession;
	const starts = (parentId === void 0 ? void 0 : ctx.sessions.get(parentId))?.events.filter((event) => event.type === "kersor/experiment-start" && event.data.childSessionId === session.id) ?? [];
	if (starts.length !== 1 || starts[0]?.data.launch === void 0) fail("KerSor Host events require one typed launch owned by this controller");
	let launch;
	try {
		launch = parseKersorLaunchContract(starts[0].data.launch, "KerSor controller launch");
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
	const cwd = session.header.cwd;
	if (typeof cwd !== "string" || cwd.length === 0) fail("KerSor Host events require a controller workspace");
	const start = starts[0].data;
	const intent = start.authorityIntent === void 0 ? void 0 : object(start.authorityIntent, "KerSor attached authority intent", fail);
	return {
		controllerSessionId: session.id,
		parentSessionId: token(parentId, "KerSor controller parent Session", fail),
		startEventSeq: starts[0].seq,
		experimentId: text(start.experimentId, "KerSor controller experimentId", fail),
		objective: text(start.objective, "KerSor controller objective", fail),
		origin: start.origin,
		...start.originSessionId === void 0 ? {} : { sourceParentSessionId: token(start.originSessionId, "KerSor controller source parent Session", fail) },
		...intent === void 0 ? {} : { authorityIntent: intent },
		workspace: canonicalWorkspace(cwd),
		launch
	};
}
function baselineOwner(data) {
	return {
		launch: data.launch,
		workspace: data.workspace,
		session_dir: data.session_dir,
		controller_session_id: data.controller_session_id,
		session_config: data.session_config,
		task_dir: data.task_dir,
		kernel: data.kernel,
		test_method: data.test_method,
		commands: data.commands
	};
}
function baselineKernelBinding(value, workspace, fail) {
	const binding = object(value, "KerSor baseline kernel", fail);
	exactKeys(binding, ["path", "sha256"], "KerSor baseline kernel", fail);
	const path = text(binding.path, "KerSor baseline kernel path", fail);
	const relativePath = relative(workspace, path);
	if (!isAbsolute(path) || resolve(path) !== path || canonicalWorkspace(path) !== path || relativePath.length === 0 || isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) fail("KerSor baseline kernel must be one canonical file inside its workspace");
	if (typeof binding.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(binding.sha256)) fail("KerSor baseline kernel must carry a raw SHA-256 digest");
	return binding;
}
function sessionDirectory(value, workspace, label, fail) {
	const sessionDir = text(value, label, fail);
	const sessionParts = relative(workspace, sessionDir).split(sep);
	if (!isAbsolute(sessionDir) || resolve(sessionDir) !== sessionDir || canonicalWorkspace(sessionDir) !== sessionDir || sessionParts.length !== 2 || sessionParts[0] !== ".kersor" || sessionParts[1]?.length === 0) fail(`${label} must be one canonical workspace/.kersor/Session path`);
	return sessionDir;
}
function adapterBinding(value, label, fail) {
	const binding = object(value, label, fail);
	exactKeys(binding, ["path", "sha256"], label, fail);
	const path = text(binding.path, `${label} path`, fail);
	if (!isAbsolute(path) || resolve(path) !== path || canonicalWorkspace(path) !== path || basename(path) !== "setup-session.sh") fail(`${label} must bind the canonical setup-session.sh adapter`);
	sha256(binding.sha256, `${label} sha256`, fail);
	return binding;
}
function controllerLaunch(value, context, label, fail) {
	let launch;
	try {
		launch = parseKersorLaunchContract(value, label);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
	if (!isDeepStrictEqual(launch, context.launch)) fail(`${label} differs from the immutable parent launch`);
	return launch;
}
function requireSessionAuthority(trace, context, sessionDir, eventType, fail) {
	const authority = context.origin === "created" ? trace.initialized : trace.imported;
	if (authority === void 0) fail(context.origin === "created" ? `${eventType} precedes kersor/session-initialized Host authority` : `${eventType} precedes kersor/session-authority-imported Host authority`);
	if (authority.session_dir !== sessionDir || authority.controller_session_id !== context.controllerSessionId || authority.experiment_id !== context.experimentId) fail(`${eventType} differs from its controller Session authority`);
	if (context.origin === "created" && trace.transferred !== void 0) fail(`${eventType} follows a durably transferred Session authority lease`);
}
function requirePrecedingBashCall(session, event, callId, command, workspace, fail) {
	const calls = session.events.filter((candidate) => candidate.seq < event.seq && candidate.type === "tool/call" && candidate.data.callId === callId);
	let argumentsValue;
	try {
		argumentsValue = calls[0] === void 0 ? void 0 : JSON.parse(calls[0].data.arguments);
	} catch {
		argumentsValue = void 0;
	}
	const argumentsRecord = argumentsValue === null || typeof argumentsValue !== "object" || Array.isArray(argumentsValue) ? void 0 : argumentsValue;
	if (calls.length !== 1 || calls[0]?.data.name !== "bash" || !hostNormalizableSetupArguments(argumentsRecord, command, workspace)) fail("kersor/session-initialized setup_call_id must bind one preceding bash tool/call");
}
function requirePrecedingAuthorActionCall(session, event, callId, toolName, action, afterSeq, fail) {
	const matching = session.events.filter((candidate) => candidate.seq < event.seq && candidate.seq > afterSeq && candidate.type === "tool/call" && candidate.data.name === toolName).filter((call) => {
		try {
			const args = JSON.parse(call.data.arguments);
			return args !== null && typeof args === "object" && !Array.isArray(args) && Object.keys(args).length === 1 && args.action === action;
		} catch {
			return false;
		}
	});
	if (matching.length !== 1 || matching[0]?.data.callId !== callId) fail(`${event.type} call identity must bind the first and only preceding ${toolName} ${action} action`);
}
function requireParentAttachCall(ctx, context, callId, fail) {
	const calls = ctx.sessions.get(context.parentSessionId)?.events.filter((candidate) => candidate.seq < context.startEventSeq && candidate.type === "tool/call" && candidate.data.callId === callId) ?? [];
	let args;
	try {
		const value = calls[0] === void 0 ? void 0 : JSON.parse(calls[0].data.arguments);
		args = value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
	} catch {}
	const keys = args !== void 0 && Object.hasOwn(args, "objective") ? [
		"experiment_id",
		"launch",
		"objective"
	] : ["experiment_id", "launch"];
	const objective = typeof args?.objective === "string" ? args.objective.trim() : "Resume the existing KerSor optimization to its next canonical boundary.";
	let launchMatches = false;
	try {
		launchMatches = isDeepStrictEqual(parseKersorLaunchContract(args?.launch, "parent kersor_attach launch"), context.launch);
	} catch {}
	if (calls.length !== 1 || calls[0]?.data.name !== "kersor_attach" || args === void 0 || !isDeepStrictEqual(Object.keys(args).sort(), [...keys].sort()) || args.experiment_id !== context.experimentId || !launchMatches || objective !== context.objective) fail("kersor/session-authority-imported attach_call_id must bind one preceding parent kersor_attach tool/call");
}
function copyBaselineTrace(source, target) {
	target.clear();
	for (const [sessionDir, value] of source) target.set(sessionDir, { ...value });
}
function copyDispatchTrace(source, target) {
	target.clear();
	for (const [runDir, value] of source) target.set(runDir, { ...value });
}
function applySessionAuthorityEvent(ctx, session, trace, baselineTrace, dispatchTrace, event, context, fail) {
	const data = record(event, fail);
	const initialized = event.type === "kersor/session-initialized";
	const transferred = event.type === "kersor/session-authority-transferred";
	exactKeys(data, initialized ? SESSION_INITIALIZED_KEYS : transferred ? SESSION_AUTHORITY_TRANSFERRED_KEYS : SESSION_AUTHORITY_IMPORTED_KEYS, event.type, fail);
	const expectedContract = initialized ? "dsh_session_initialization_v1" : transferred ? "dsh_session_authority_transfer_v1" : "dsh_session_authority_import_v1";
	if (data.schema_version !== 1 || data.contract !== expectedContract || data.authority !== "dsh_host") fail(`${event.type} must carry its exact dsh_host contract`);
	token(data.experiment_id, `${event.type} experiment_id`, fail);
	if (data.experiment_id !== context.experimentId) fail(`${event.type} experiment identity differs from its owning controller`);
	controllerLaunch(data.launch, context, `${event.type} launch`, fail);
	const workspace = text(data.workspace, `${event.type} workspace`, fail);
	if (!isAbsolute(workspace) || resolve(workspace) !== workspace || canonicalWorkspace(workspace) !== workspace || workspace !== context.workspace) fail(`${event.type} workspace binding is invalid`);
	const sessionDir = sessionDirectory(data.session_dir, workspace, `${event.type} session_dir`, fail);
	if (transferred) {
		if (context.origin !== "created" || trace.initialized === void 0 || trace.transferred !== void 0 || trace.imported !== void 0) fail("kersor/session-authority-transferred requires one initialized created controller");
		token(data.source_parent_session_id, "authority transfer source_parent_session_id", fail);
		token(data.source_controller_session_id, "authority transfer source_controller_session_id", fail);
		token(data.target_parent_session_id, "authority transfer target_parent_session_id", fail);
		token(data.target_controller_session_id, "authority transfer target_controller_session_id", fail);
		const attachCallId = token(data.attach_call_id, "authority transfer attach_call_id", fail);
		if (data.source_parent_session_id !== context.parentSessionId || data.source_controller_session_id !== context.controllerSessionId || trace.initialized.session_dir !== sessionDir) fail("kersor/session-authority-transferred source identity differs from its controller");
		const watermark = nonNegativeInteger(data.pre_transfer_event_watermark, "authority transfer pre-transfer watermark", fail);
		const prefix = session.events.filter((candidate) => candidate.seq <= watermark);
		if (watermark + 1 !== event.seq || prefix.length !== watermark + 1 || prefix.some((candidate, index) => candidate.seq !== index) || createHash("sha256").update(canonicalKersorJson(prefix), "utf8").digest("hex") !== sha256(data.pre_transfer_event_sha256, "authority transfer prefix hash", fail)) fail("kersor/session-authority-transferred does not immediately seal its complete source prefix");
		fileBinding(data.source_setup_receipt, join(sessionDir, "session-initialization-receipt.json"), "authority transfer source setup receipt", fail);
		fileBinding(data.source_state, join(sessionDir, "state.json"), "authority transfer source state", fail);
		fileBinding(data.source_workflow_catalog, join(sessionDir, "workflow-catalog.json"), "authority transfer source workflow catalog", fail);
		const targetStarts = ctx.sessions.get(data.target_parent_session_id)?.events.filter((candidate) => candidate.type === "kersor/experiment-start" && candidate.data.childSessionId === data.target_controller_session_id && candidate.data.experimentId === context.experimentId && candidate.data.origin === "attached") ?? [];
		const targetStart = targetStarts[0];
		if (targetStarts.length !== 1 || targetStart?.type !== "kersor/experiment-start") fail("authority transfer target attached intent is unavailable");
		const intent = object(targetStart.data.authorityIntent, "authority transfer target intent", fail);
		if (targetStart.data.originSessionId !== context.parentSessionId || intent.attach_call_id !== attachCallId || intent.source_parent_session_id !== context.parentSessionId || intent.source_controller_session_id !== context.controllerSessionId || intent.workspace !== workspace || intent.session_dir !== sessionDir || intent.pre_transfer_event_watermark !== watermark || intent.pre_transfer_event_sha256 !== data.pre_transfer_event_sha256 || !isDeepStrictEqual(intent.source_setup_receipt, data.source_setup_receipt) || !isDeepStrictEqual(intent.source_state, data.source_state) || !isDeepStrictEqual(intent.source_workflow_catalog, data.source_workflow_catalog)) fail("authority transfer differs from its durable target intent");
		trace.transferred = data;
		return;
	}
	if (trace.initialized !== void 0 || trace.imported !== void 0) fail(`${event.type} repeats controller Session authority`);
	token(data.controller_session_id, `${event.type} controller_session_id`, fail);
	if (data.controller_session_id !== context.controllerSessionId) fail(`${event.type} controller identity differs from its owning Session`);
	if (initialized) {
		if (context.origin !== "created") fail("kersor/session-initialized is valid only for a created controller");
		requirePrecedingBashCall(session, event, token(data.setup_call_id, "kersor/session-initialized setup_call_id", fail), text(data.setup_command, "kersor/session-initialized setup_command", fail), workspace, fail);
		const python = object(data.kersor_python, "kersor/session-initialized kersor_python", fail);
		exactKeys(python, ["path", "sha256"], "kersor/session-initialized kersor_python", fail);
		const pythonPath = text(python.path, "kersor/session-initialized kersor_python path", fail);
		if (!isAbsolute(pythonPath) || resolve(pythonPath) !== pythonPath) fail("kersor/session-initialized kersor_python path must be canonical absolute");
		sha256(python.sha256, "kersor/session-initialized kersor_python sha256", fail);
		fileBinding(data.session_config, join(sessionDir, "session-config.json"), "kersor/session-initialized session_config", fail);
		fileBinding(data.state, join(sessionDir, "state.json"), "kersor/session-initialized state", fail);
		fileBinding(data.workflow_catalog, join(sessionDir, "workflow-catalog.json"), "kersor/session-initialized workflow_catalog", fail);
		adapterBinding(data.adapter, "kersor/session-initialized adapter", fail);
		baselineKernelBinding(data.kernel, workspace, fail);
		trace.initialized = data;
		return;
	}
	if (context.origin !== "attached") fail("kersor/session-authority-imported is valid only for an attached controller");
	token(data.attached_parent_session_id, "session authority attached_parent_session_id", fail);
	const attachCallId = token(data.attach_call_id, "session authority attach_call_id", fail);
	token(data.source_parent_session_id, "session authority source_parent_session_id", fail);
	const sourceControllerSessionId = token(data.source_controller_session_id, "session authority source_controller_session_id", fail);
	if (data.attached_parent_session_id !== context.parentSessionId || data.source_parent_session_id !== context.sourceParentSessionId || context.authorityIntent === void 0) fail("kersor/session-authority-imported parent lineage differs from experiment-start");
	const intent = context.authorityIntent;
	if (intent.attach_call_id !== attachCallId || intent.workspace !== workspace || intent.session_dir !== sessionDir || intent.source_parent_session_id !== data.source_parent_session_id || intent.source_controller_session_id !== sourceControllerSessionId || !isDeepStrictEqual(intent.source_setup_receipt, data.source_setup_receipt) || !isDeepStrictEqual(intent.source_state, data.source_state) || !isDeepStrictEqual(intent.source_workflow_catalog, data.source_workflow_catalog)) fail("kersor/session-authority-imported differs from its durable parent intent");
	requireParentAttachCall(ctx, context, attachCallId, fail);
	if (sourceControllerSessionId === session.id) fail("kersor/session-authority-imported cannot import its own controller");
	const watermark = nonNegativeInteger(data.source_event_watermark, "session authority source_event_watermark", fail);
	const expectedSourceHash = sha256(data.source_event_sha256, "session authority source_event_sha256", fail);
	fileBinding(data.source_setup_receipt, join(sessionDir, "session-initialization-receipt.json"), "session authority source_setup_receipt", fail);
	fileBinding(data.source_transfer_receipt, join(sessionDir, "session-authority-transfer-receipt.json"), "session authority source_transfer_receipt", fail);
	fileBinding(data.source_state, join(sessionDir, "state.json"), "session authority source_state", fail);
	fileBinding(data.source_workflow_catalog, join(sessionDir, "workflow-catalog.json"), "session authority source_workflow_catalog", fail);
	const source = ctx.sessions.get(sourceControllerSessionId);
	if (source === void 0 || source.header.parentSession !== data.source_parent_session_id) fail("kersor/session-authority-imported source controller lineage is unavailable");
	const sourceContext = controllerEventContext(ctx, source, fail);
	if (sourceContext.origin !== "created" || sourceContext.experimentId !== context.experimentId || sourceContext.parentSessionId !== data.source_parent_session_id || sourceContext.workspace !== workspace || !isDeepStrictEqual(sourceContext.launch, context.launch)) fail("kersor/session-authority-imported source controller authority is incompatible");
	const sourcePrefix = source.events.filter((candidate) => candidate.seq <= watermark);
	if (sourcePrefix.length !== watermark + 1 || sourcePrefix.some((candidate, index) => candidate.seq !== index)) fail("kersor/session-authority-imported source event watermark is not a complete prefix");
	if (createHash("sha256").update(canonicalKersorJson(sourcePrefix), "utf8").digest("hex") !== expectedSourceHash) fail("kersor/session-authority-imported source event prefix hash differs from its controller");
	const replay = replayControllerEvents(ctx, source, sourcePrefix, sourceContext, fail);
	const sourceInitialization = replay.authority.initialized;
	const sourceTransfer = replay.authority.transferred;
	if (sourceInitialization === void 0 || sourceInitialization.experiment_id !== context.experimentId || sourceInitialization.controller_session_id !== sourceControllerSessionId || sourceInitialization.workspace !== workspace || sourceInitialization.session_dir !== sessionDir || !isDeepStrictEqual(sourceInitialization.launch, context.launch)) fail("kersor/session-authority-imported source prefix has no matching initialization authority");
	if (sourceTransfer === void 0 || sourcePrefix.at(-1)?.type !== "kersor/session-authority-transferred" || sourceTransfer.target_parent_session_id !== context.parentSessionId || sourceTransfer.target_controller_session_id !== context.controllerSessionId || sourceTransfer.attach_call_id !== attachCallId || !isDeepStrictEqual(sourceTransfer.source_state, data.source_state) || !isDeepStrictEqual(sourceTransfer.source_workflow_catalog, data.source_workflow_catalog)) fail("kersor/session-authority-imported source prefix lacks its matching terminal transfer");
	copyBaselineTrace(replay.baseline, baselineTrace);
	copyDispatchTrace(replay.dispatch, dispatchTrace);
	trace.imported = data;
}
function baselineCommands(value, launch, fail) {
	const commands = object(value, "KerSor baseline commands", fail);
	exactKeys(commands, ["correctness", "benchmark"], "KerSor baseline commands", fail);
	if (commands.correctness !== launch.correctness_command || commands.benchmark !== launch.benchmark_command) fail("KerSor baseline commands differ from the immutable typed launch");
	return commands;
}
function baselineExecutions(value, commands, fail) {
	if (!Array.isArray(value) || value.length !== 2) fail("KerSor baseline executions must contain correctness then benchmark");
	const expected = [{
		kind: "correctness",
		command: commands.correctness
	}, {
		kind: "benchmark",
		command: commands.benchmark
	}];
	return value.map((candidate, index) => {
		const execution = object(candidate, `KerSor baseline execution ${index}`, fail);
		exactKeys(execution, BASELINE_EXECUTION_KEYS, `KerSor baseline execution ${index}`, fail);
		const owner = expected[index];
		if (owner === void 0 || execution.kind !== owner.kind || execution.command !== owner.command) fail(`KerSor baseline execution ${index} command/order differs from its typed owner`);
		if (!Number.isSafeInteger(execution.exit_code)) fail(`KerSor baseline execution ${index} exit_code must be a safe integer`);
		if (index === 0 && execution.exit_code !== 0) fail("KerSor baseline correctness execution must exit zero");
		if (execution.timed_out !== false) fail(`KerSor baseline execution ${index} timed out`);
		for (const key of ["stdout_sha256", "stderr_sha256"]) if (typeof execution[key] !== "string" || !/^[0-9a-f]{64}$/.test(execution[key])) fail(`KerSor baseline execution ${index} ${key} must be a raw SHA-256 digest`);
		return execution;
	});
}
function applyBaselineEvent(trace, authorityTrace, event, context, fail) {
	const data = record(event, fail);
	exactKeys(data, event.type === "kersor/baseline-initialized" ? BASELINE_COMMON_KEYS : event.type === "kersor/baseline-recorded" ? BASELINE_RECORDED_KEYS : BASELINE_VERIFIED_KEYS, event.type, fail);
	const expectedContract = event.type === "kersor/baseline-initialized" ? "dsh_baseline_initialized_v1" : event.type === "kersor/baseline-recorded" ? "dsh_baseline_recorded_v1" : "dsh_baseline_verified_v1";
	if (data.schema_version !== 1 || data.contract !== expectedContract || data.authority !== "dsh_host") fail(`${event.type} must carry its exact dsh_host contract`);
	token(data.controller_session_id, `${event.type} controller_session_id`, fail);
	token(data.call_id, `${event.type} call_id`, fail);
	if (data.controller_session_id !== context.controllerSessionId) fail(`${event.type} controller_session_id differs from its owning Session`);
	const launch = controllerLaunch(data.launch, context, `${event.type} launch`, fail);
	const workspace = text(data.workspace, `${event.type} workspace`, fail);
	if (!isAbsolute(workspace) || resolve(workspace) !== workspace || workspace !== context.workspace || data.task_dir !== workspace) fail(`${event.type} workspace/task_dir binding is invalid`);
	const sessionDir = sessionDirectory(data.session_dir, workspace, `${event.type} session_dir`, fail);
	requireSessionAuthority(authorityTrace, context, sessionDir, event.type, fail);
	fileBinding(data.session_config, join(sessionDir, "session-config.json"), `${event.type} session_config`, fail);
	baselineKernelBinding(data.kernel, workspace, fail);
	fileBinding(data.test_method, join(sessionDir, "test-method.md"), `${event.type} test_method`, fail);
	const commands = baselineCommands(data.commands, launch, fail);
	const current = trace.get(sessionDir);
	if (event.type === "kersor/baseline-initialized") {
		if (current !== void 0) fail(`kersor/baseline-initialized repeats Session ${sessionDir}`);
		trace.set(sessionDir, { initialized: data });
		return;
	}
	if (current === void 0) fail(event.type === "kersor/baseline-recorded" ? `kersor/baseline-recorded has no initialization for Session ${sessionDir}` : `kersor/baseline-verified has no initialization for Session ${sessionDir}`);
	if (!isDeepStrictEqual(baselineOwner(data), baselineOwner(current.initialized))) fail(`${event.type} baseline owner differs from its initialization`);
	if (event.type === "kersor/baseline-recorded") {
		if (current.recorded !== void 0) fail(`kersor/baseline-recorded repeats Session ${sessionDir}`);
		if (data.call_id === current.initialized.call_id) fail("kersor/baseline-recorded must use a distinct call after initialization");
		fileBinding(data.initialization_receipt, join(sessionDir, "baseline-initialization-receipt.json"), "kersor/baseline-recorded initialization_receipt", fail);
		fileBinding(data.witness, join(sessionDir, "baseline-witness.json"), "kersor/baseline-recorded witness", fail);
		baselineExecutions(data.executions, commands, fail);
		current.recorded = data;
		return;
	}
	if (current.recorded === void 0) fail(`kersor/baseline-verified has no recording for Session ${sessionDir}`);
	if (current.verified !== void 0) fail(`kersor/baseline-verified repeats Session ${sessionDir}`);
	if (data.call_id === current.initialized.call_id || data.call_id === current.recorded.call_id) fail("kersor/baseline-verified must use a distinct call after recording");
	fileBinding(data.recording_receipt, join(sessionDir, "baseline-recording-receipt.json"), "kersor/baseline-verified recording_receipt", fail);
	const witness = fileBinding(data.witness, join(sessionDir, "baseline-witness.json"), "kersor/baseline-verified witness", fail);
	const executions = baselineExecutions(data.executions, commands, fail);
	const protectedFiles = object(data.protected_files, "kersor/baseline-verified protected_files", fail);
	for (const [path, hash] of Object.entries(protectedFiles)) {
		if (path.length === 0 || isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) fail("kersor/baseline-verified protected_files contains a non-canonical relative path");
		const digest = text(hash, `kersor/baseline-verified protected_files.${path}`, fail);
		if (!/^[0-9a-f]{64}$/u.test(digest)) fail(`kersor/baseline-verified protected_files.${path} must be a lowercase SHA-256`);
	}
	object(data.worktree, "kersor/baseline-verified worktree", fail);
	if (data.verdict !== "pass") fail("kersor/baseline-verified verdict must be pass");
	if (!isDeepStrictEqual(witness, current.recorded.witness) || !isDeepStrictEqual(executions, current.recorded.executions)) fail("kersor/baseline-verified witness/executions differ from its recording");
	current.verified = data;
}
function applyExperimentEvent(trace, event, fail) {
	const data = record(event, fail);
	const experimentId = text(data.experimentId, `${event.type} experimentId`, fail);
	const childSessionId = text(data.childSessionId, `${event.type} childSessionId`, fail);
	if (event.type === "kersor/experiment-start") {
		if (trace.has(experimentId)) fail(`kersor/experiment-start repeats experiment ${experimentId}`);
		if ([...trace.values()].some((candidate) => candidate.childSessionId === childSessionId)) fail(`kersor/experiment-start reuses child ${childSessionId}`);
		if (text(data.objective, "kersor/experiment-start objective", fail).length > 4e3) fail("kersor/experiment-start objective exceeds 4000 characters");
		if (data.origin !== "created" && data.origin !== "attached") fail("kersor/experiment-start origin is invalid");
		if (typeof data.freshSession !== "boolean") fail("kersor/experiment-start freshSession must be a boolean");
		if (data.origin === "attached" && data.freshSession) fail("kersor/experiment-start attached origin cannot require a fresh Session");
		if (!Object.hasOwn(data, "launch")) fail("kersor/experiment-start requires an immutable typed launch");
		try {
			parseKersorLaunchContract(data.launch, "kersor/experiment-start launch");
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error));
		}
		if (data.origin === "attached") {
			token(data.originSessionId, "kersor/experiment-start originSessionId", fail);
			const intent = object(data.authorityIntent, "kersor/experiment-start authorityIntent", fail);
			exactKeys(intent, SESSION_AUTHORITY_INTENT_KEYS, "kersor/experiment-start authorityIntent", fail);
			token(intent.attach_call_id, "authority intent attach_call_id", fail);
			token(intent.source_parent_session_id, "authority intent source_parent_session_id", fail);
			token(intent.source_controller_session_id, "authority intent source_controller_session_id", fail);
			if (intent.source_parent_session_id !== data.originSessionId) fail("authority intent source parent differs from experiment-start originSessionId");
			const workspace = text(intent.workspace, "authority intent workspace", fail);
			if (!isAbsolute(workspace) || resolve(workspace) !== workspace || canonicalWorkspace(workspace) !== workspace) fail("authority intent workspace must be canonical");
			const sessionDir = sessionDirectory(intent.session_dir, workspace, "authority intent session_dir", fail);
			nonNegativeInteger(intent.pre_transfer_event_watermark, "authority intent pre-transfer watermark", fail);
			sha256(intent.pre_transfer_event_sha256, "authority intent pre-transfer hash", fail);
			fileBinding(intent.source_setup_receipt, join(sessionDir, "session-initialization-receipt.json"), "authority intent source setup receipt", fail);
			fileBinding(intent.source_state, join(sessionDir, "state.json"), "authority intent source state", fail);
			fileBinding(intent.source_workflow_catalog, join(sessionDir, "workflow-catalog.json"), "authority intent source workflow catalog", fail);
		} else if (Object.hasOwn(data, "originSessionId") || Object.hasOwn(data, "authorityIntent")) fail("kersor/experiment-start created origin cannot carry attached authority metadata");
		positiveInteger(data.turn, "kersor/experiment-start turn", fail);
		positiveInteger(data.step, "kersor/experiment-start step", fail);
		trace.set(experimentId, {
			childSessionId,
			revision: 0,
			status: "provisioning"
		});
		return;
	}
	const current = trace.get(experimentId);
	if (current === void 0) fail(`kersor/experiment-checkpoint has no start for ${experimentId}`);
	if (current.childSessionId !== childSessionId) fail(`kersor/experiment-checkpoint changes child for ${experimentId}`);
	if (current.status === "blocked" || current.status === "completed" || current.status === "cancelled") fail(`kersor/experiment-checkpoint follows terminal status ${current.status}`);
	const revision = positiveInteger(data.revision, "kersor/experiment-checkpoint revision", fail);
	if (revision !== current.revision + 1) fail(`kersor/experiment-checkpoint revision ${revision} does not follow ${current.revision}`);
	if (!STATUSES.has(data.status)) fail("kersor/experiment-checkpoint status is invalid");
	if (!Array.isArray(data.steps)) fail("kersor/experiment-checkpoint steps must be an array");
	const stepIds = /* @__PURE__ */ new Set();
	for (const candidate of data.steps) {
		if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) fail("kersor/experiment-checkpoint step must be an object");
		const step = candidate;
		const id = text(step.id, "kersor/experiment-checkpoint step id", fail);
		if (stepIds.has(id)) fail(`kersor/experiment-checkpoint repeats step ${id}`);
		stepIds.add(id);
		if (!STEP_STATUSES.has(step.status)) fail(`kersor/experiment-checkpoint step ${id} status is invalid`);
	}
	current.revision = revision;
	current.status = data.status;
}
function isExperimentEvent(event) {
	return event.type === "kersor/experiment-start" || event.type === "kersor/experiment-checkpoint";
}
function isSessionAuthorityEvent(event) {
	return event.type === "kersor/session-initialized" || event.type === "kersor/session-authority-transferred" || event.type === "kersor/session-authority-imported";
}
function isDispatchEvent(event) {
	return event.type === "kersor/dispatch-args-produced" || event.type === "kersor/dispatch-args-transformed" || event.type === "kersor/candidate-ownership-sealed";
}
function isBaselineEvent(event) {
	return event.type === "kersor/baseline-initialized" || event.type === "kersor/baseline-recorded" || event.type === "kersor/baseline-verified";
}
function isAuthorEvent(event) {
	return event.type === "kersor/author-produced" || event.type === "kersor/author-handoff-sealed" || event.type === "kersor/author-save-attempted";
}
function applyAuthorEvent(session, trace, authorityTrace, event, context, fail) {
	const data = record(event, fail);
	const produced = event.type === "kersor/author-produced";
	const sealed = event.type === "kersor/author-handoff-sealed";
	exactKeys(data, produced ? AUTHOR_PRODUCED_KEYS : sealed ? AUTHOR_SEAL_KEYS : AUTHOR_SAVE_KEYS, event.type, fail);
	const expectedContract = produced ? "dsh_author_producer_v1" : sealed ? "dsh_author_handoff_seal_v2" : "dsh_author_save_attempt_v2";
	if (data.schema_version !== 1 || data.contract !== expectedContract || data.authority !== "dsh_host") fail(`${event.type} must carry its dsh_host authored Workflow custody contract`);
	if (context.origin !== "created") fail(`${event.type} is scoped to freshly created controller authority`);
	if (context.launch.workflow_authoring_budget < 1) fail(`${event.type} requires an enabled workflow authoring budget`);
	const sessionDir = text(data.session_dir, `${event.type} session_dir`, fail);
	if (!isAbsolute(sessionDir) || resolve(sessionDir) !== sessionDir || dirname(sessionDir) !== join(context.workspace, ".kersor")) fail(`${event.type} session_dir must be the canonical workspace Session`);
	requireSessionAuthority(authorityTrace, context, sessionDir, event.type, fail);
	if (data.controller_session_id !== context.controllerSessionId) fail(`${event.type} controller_session_id differs from its owning Session`);
	const current = trace.get(sessionDir);
	if (produced) {
		if (current !== void 0) fail(`kersor/author-produced repeats Session ${sessionDir}`);
		const callId = token(data.author_call_id, "author author_call_id", fail);
		if (token(data.author_session_id, "author author_session_id", fail) === context.controllerSessionId) fail("kersor/author-produced author_session_id must identify its foreground child");
		fileBinding(data.author_context, join(sessionDir, "workflow-authoring", "author-context.json"), "kersor/author-produced author_context", fail);
		requirePrecedingAuthorActionCall(session, event, callId, "kersor_protocol", "author", -1, fail);
		trace.set(sessionDir, {
			produced: data,
			producedSeq: event.seq
		});
		return;
	}
	const handoff = fileBinding(data.handoff, join(sessionDir, "workflow-authoring", "author-handoff.json"), `${event.type} handoff`, fail);
	if (sealed) {
		if (current === void 0) fail("kersor/author-handoff-sealed has no durable Host author producer");
		if (current.seal !== void 0) fail(`kersor/author-handoff-sealed repeats Session ${sessionDir}`);
		const callId = token(data.seal_call_id, "author seal_call_id", fail);
		if (data.author_call_id !== current.produced.author_call_id || data.author_session_id !== current.produced.author_session_id) fail("kersor/author-handoff-sealed differs from its Host-run foreground author");
		requirePrecedingAuthorActionCall(session, event, callId, "kersor_author_commit", "seal", current.producedSeq, fail);
		current.seal = data;
		current.sealSeq = event.seq;
		return;
	}
	if (current?.seal === void 0) fail("kersor/author-save-attempted has no durable author seal");
	if (current.saveAttempted !== void 0) fail(`kersor/author-save-attempted repeats consumed Session ${sessionDir}`);
	requirePrecedingAuthorActionCall(session, event, token(data.save_call_id, "author save_call_id", fail), "kersor_author_commit", "save", current.sealSeq ?? -1, fail);
	if (data.seal_call_id !== current.seal.seal_call_id || !isDeepStrictEqual(handoff, current.seal.handoff)) fail("kersor/author-save-attempted differs from its sealed author bytes");
	current.saveAttempted = data;
}
function applyDispatchEvent(trace, baselineTrace, authorityTrace, event, context, fail) {
	const data = record(event, fail);
	const runDir = text(data.run_dir, `${event.type} run_dir`, fail);
	if (!isAbsolute(runDir) || resolve(runDir) !== runDir || !/^run-[1-9]\d*$/.test(basename(runDir))) fail(`${event.type} run_dir must be one canonical absolute run-N path`);
	const sessionDir = dirname(runDir);
	const round = Number.parseInt(basename(runDir).slice(4), 10);
	token(data.controller_session_id, `${event.type} controller_session_id`, fail);
	if (data.controller_session_id !== context.controllerSessionId) fail(`${event.type} controller_session_id differs from its owning Session`);
	requireSessionAuthority(authorityTrace, context, sessionDir, event.type, fail);
	if (event.type === "kersor/dispatch-args-produced") {
		if (baselineTrace.get(sessionDir)?.verified === void 0) fail(`kersor/dispatch-args-produced precedes verified baseline Host custody for ${sessionDir}`);
		exactKeys(data, PRODUCER_KEYS, event.type, fail);
		if (data.schema_version !== 1 || data.contract !== "dsh_dispatch_args_producer_v1" || data.authority !== "dsh_host") fail("kersor/dispatch-args-produced must carry the dsh_host producer contract");
		if (data.session_dir !== sessionDir || data.round !== round) fail("kersor/dispatch-args-produced Session/round binding is invalid");
		text(data.workflow_name, "kersor/dispatch-args-produced workflow_name", fail);
		token(data.producer_session_id, "kersor/dispatch-args-produced producer_session_id", fail);
		token(data.producer_call_id, "kersor/dispatch-args-produced producer_call_id", fail);
		fileBinding(data.dispatch_args, join(runDir, "dispatch-args.json"), "kersor/dispatch-args-produced dispatch_args", fail);
		fileBinding(data.dispatch_args_provenance, join(runDir, "dispatch-args-provenance.json"), "kersor/dispatch-args-produced dispatch_args_provenance", fail);
		if (trace.has(runDir)) fail(`kersor/dispatch-args-produced repeats run ${runDir}`);
		trace.set(runDir, {
			producer: data,
			transformed: false,
			sealed: false
		});
		return;
	}
	const current = trace.get(runDir);
	if (current === void 0) fail(event.type === "kersor/candidate-ownership-sealed" ? `kersor/candidate-ownership-sealed has no dispatch transformation for ${runDir}` : `${event.type} has no producer for ${runDir}`);
	if (event.type === "kersor/candidate-ownership-sealed") {
		if (!current.transformed) fail(`kersor/candidate-ownership-sealed has no dispatch transformation for ${runDir}`);
		if (current.sealed) fail(`kersor/candidate-ownership-sealed repeats run ${runDir}`);
		exactKeys(data, CANDIDATE_SEAL_KEYS, event.type, fail);
		if (data.schema_version !== 1 || data.contract !== "dsh_candidate_ownership_seal_v1" || data.authority !== "dsh_host") fail("kersor/candidate-ownership-sealed must carry the dsh_host seal contract");
		if (data.session_dir !== current.producer.session_dir || data.round !== current.producer.round || data.controller_session_id !== current.producer.controller_session_id) fail("kersor/candidate-ownership-sealed does not extend its producer event");
		token(data.seal_call_id, "kersor/candidate-ownership-sealed seal_call_id", fail);
		fileBinding(data.seal, join(runDir, "candidate-ownership-seal.json"), "kersor/candidate-ownership-sealed seal", fail);
		fileBinding(data.state, join(data.session_dir, "state.json"), "kersor/candidate-ownership-sealed state", fail);
		current.sealed = true;
		return;
	}
	if (current.transformed) fail(`kersor/dispatch-args-transformed repeats run ${runDir}`);
	exactKeys(data, TRANSFORMATION_KEYS, event.type, fail);
	if (data.schema_version !== 1 || data.contract !== "dsh_dispatch_args_transformation_v1" || data.authority !== "dsh_host" || data.transformer !== "inject-runtime-controls") fail("kersor/dispatch-args-transformed must carry the dsh_host runtime-control contract");
	if (data.session_dir !== current.producer.session_dir || data.round !== current.producer.round || data.workflow_name !== current.producer.workflow_name || data.controller_session_id !== current.producer.controller_session_id) fail("kersor/dispatch-args-transformed does not extend its producer event");
	if (data.transformation_call_id !== current.producer.producer_call_id) fail("kersor/dispatch-args-transformed must reuse its producer call identity");
	if (typeof fileBinding(data.producer_receipt, join(runDir, "dispatch-args-producer-receipt.json"), "kersor/dispatch-args-transformed producer_receipt", fail).sha256 !== "string") fail("kersor/dispatch-args-transformed producer receipt hash is invalid");
	const input = object(data.input, "kersor/dispatch-args-transformed input", fail);
	const output = object(data.output, "kersor/dispatch-args-transformed output", fail);
	exactKeys(input, ["dispatch_args", "dispatch_args_provenance"], "transformation input", fail);
	exactKeys(output, ["dispatch_args", "dispatch_args_provenance"], "transformation output", fail);
	const inputArgs = fileBinding(input.dispatch_args, join(runDir, "dispatch-args.json"), "transformation input args", fail);
	const inputProvenance = fileBinding(input.dispatch_args_provenance, join(runDir, "dispatch-args-provenance.json"), "transformation input provenance", fail);
	if (!isDeepStrictEqual(inputArgs, current.producer.dispatch_args) || !isDeepStrictEqual(inputProvenance, current.producer.dispatch_args_provenance)) fail("kersor/dispatch-args-transformed input does not equal its producer output");
	const outputArgs = fileBinding(output.dispatch_args, join(runDir, "dispatch-args.json"), "transformation output args", fail);
	const outputProvenance = fileBinding(output.dispatch_args_provenance, join(runDir, "dispatch-args-provenance.json"), "transformation output provenance", fail);
	if (typeof data.changed !== "boolean") fail("kersor/dispatch-args-transformed changed must be a boolean");
	const rawChanged = !isDeepStrictEqual(inputArgs, outputArgs) || !isDeepStrictEqual(inputProvenance, outputProvenance);
	if (data.changed !== rawChanged) fail("kersor/dispatch-args-transformed changed differs from its raw hash transition");
	const authorized = object(data.authorized_fields, "kersor/dispatch-args-transformed authorized_fields", fail);
	exactKeys(authorized, ["dispatch_args", "dispatch_args_provenance"], "transformation authorized_fields", fail);
	const argsFields = authorizedFields(authorized.dispatch_args, RUNTIME_ARGS_FIELDS, "transformation dispatch_args fields", fail);
	const provenanceFields = authorizedFields(authorized.dispatch_args_provenance, RUNTIME_PROVENANCE_FIELDS, "transformation provenance fields", fail);
	if (!rawChanged && (argsFields.length !== 0 || provenanceFields.length !== 0)) fail("kersor/dispatch-args-transformed no-op must authorize no fields");
	current.transformed = true;
}
function replayControllerEvents(ctx, session, events, context, fail) {
	const authority = {};
	const author = /* @__PURE__ */ new Map();
	const baseline = /* @__PURE__ */ new Map();
	const dispatch = /* @__PURE__ */ new Map();
	for (const event of events) if (isSessionAuthorityEvent(event)) applySessionAuthorityEvent(ctx, session, authority, baseline, dispatch, event, context, fail);
	else if (isBaselineEvent(event)) applyBaselineEvent(baseline, authority, event, context, fail);
	else if (isAuthorEvent(event)) applyAuthorEvent(session, author, authority, event, context, fail);
	else if (isDispatchEvent(event)) applyDispatchEvent(dispatch, baseline, authority, event, context, fail);
	return {
		authority,
		author,
		baseline,
		dispatch
	};
}
/** Active frames require a launcher; experiment events form one monotonic binding per Session. */
const install = Object.assign((ctx, fail) => {
	ctx.on("kersor/active", () => {
		if (ctx.get("kersor") === void 0) fail("kersor/active emitted without a live KerSor launcher");
	});
	const traces = /* @__PURE__ */ new WeakMap();
	const staged = /* @__PURE__ */ new WeakMap();
	const authorityTraces = /* @__PURE__ */ new WeakMap();
	const authorTraces = /* @__PURE__ */ new WeakMap();
	const stagedAuthority = /* @__PURE__ */ new WeakMap();
	const dispatchTraces = /* @__PURE__ */ new WeakMap();
	const stagedDispatch = /* @__PURE__ */ new WeakMap();
	const baselineTraces = /* @__PURE__ */ new WeakMap();
	const stagedBaseline = /* @__PURE__ */ new WeakMap();
	const stagedAuthor = /* @__PURE__ */ new WeakMap();
	const seed = (session) => {
		const trace = /* @__PURE__ */ new Map();
		for (const event of session.events.filter(isExperimentEvent)) applyExperimentEvent(trace, event, fail);
		traces.set(session, trace);
		if (!session.events.some((event) => isSessionAuthorityEvent(event) || isBaselineEvent(event) || isAuthorEvent(event) || isDispatchEvent(event))) {
			authorityTraces.set(session, {});
			authorTraces.set(session, /* @__PURE__ */ new Map());
			baselineTraces.set(session, /* @__PURE__ */ new Map());
			dispatchTraces.set(session, /* @__PURE__ */ new Map());
			return;
		}
		const replay = replayControllerEvents(ctx, session, session.events, controllerEventContext(ctx, session, fail), fail);
		authorityTraces.set(session, replay.authority);
		authorTraces.set(session, replay.author);
		baselineTraces.set(session, replay.baseline);
		dispatchTraces.set(session, replay.dispatch);
	};
	ctx.sessions.list().forEach(seed);
	ctx.on("session/created", seed, { global: true });
	ctx.on("internal/dispatch", (_mode, eventName, args) => {
		if (eventName !== "session/event") return;
		const [session, event] = args;
		if (isSessionAuthorityEvent(event)) {
			const authority = { ...authorityTraces.get(session) ?? {} };
			const baseline = new Map([...baselineTraces.get(session) ?? /* @__PURE__ */ new Map()].map(([sessionDir, value]) => [sessionDir, { ...value }]));
			const dispatch = new Map([...dispatchTraces.get(session) ?? /* @__PURE__ */ new Map()].map(([runDir, value]) => [runDir, { ...value }]));
			applySessionAuthorityEvent(ctx, session, authority, baseline, dispatch, event, controllerEventContext(ctx, session, fail), fail);
			stagedAuthority.set(event, {
				session,
				authority,
				baseline,
				dispatch
			});
			return;
		}
		if (isBaselineEvent(event)) {
			const trace = new Map([...baselineTraces.get(session) ?? /* @__PURE__ */ new Map()].map(([sessionDir, value]) => [sessionDir, { ...value }]));
			applyBaselineEvent(trace, authorityTraces.get(session) ?? {}, event, controllerEventContext(ctx, session, fail), fail);
			stagedBaseline.set(event, {
				session,
				trace
			});
			return;
		}
		if (isAuthorEvent(event)) {
			const trace = new Map([...authorTraces.get(session) ?? /* @__PURE__ */ new Map()].map(([sessionDir, value]) => [sessionDir, { ...value }]));
			applyAuthorEvent(session, trace, authorityTraces.get(session) ?? {}, event, controllerEventContext(ctx, session, fail), fail);
			stagedAuthor.set(event, {
				session,
				trace
			});
			return;
		}
		if (isDispatchEvent(event)) {
			const trace = new Map([...dispatchTraces.get(session) ?? /* @__PURE__ */ new Map()].map(([runDir, value]) => [runDir, { ...value }]));
			applyDispatchEvent(trace, baselineTraces.get(session) ?? /* @__PURE__ */ new Map(), authorityTraces.get(session) ?? {}, event, controllerEventContext(ctx, session, fail), fail);
			stagedDispatch.set(event, {
				session,
				trace
			});
			return;
		}
		if (!isExperimentEvent(event)) return;
		const trace = new Map([...traces.get(session) ?? /* @__PURE__ */ new Map()].map(([id, value]) => [id, { ...value }]));
		applyExperimentEvent(trace, event, fail);
		staged.set(event, {
			session,
			trace
		});
	}, { global: true });
	ctx.on("session/event", (session, event) => {
		if (isSessionAuthorityEvent(event)) {
			const candidate = stagedAuthority.get(event);
			if (candidate === void 0 || candidate.session !== session) return fail("KerSor Session authority event reached publication without validation");
			stagedAuthority.delete(event);
			authorityTraces.set(session, candidate.authority);
			baselineTraces.set(session, candidate.baseline);
			dispatchTraces.set(session, candidate.dispatch);
			return;
		}
		if (isBaselineEvent(event)) {
			const candidate = stagedBaseline.get(event);
			if (candidate === void 0 || candidate.session !== session) return fail("KerSor baseline event reached publication without validation");
			stagedBaseline.delete(event);
			baselineTraces.set(session, candidate.trace);
			return;
		}
		if (isAuthorEvent(event)) {
			const candidate = stagedAuthor.get(event);
			if (candidate === void 0 || candidate.session !== session) return fail("KerSor authored Workflow custody event reached publication without validation");
			stagedAuthor.delete(event);
			authorTraces.set(session, candidate.trace);
			return;
		}
		if (isDispatchEvent(event)) {
			const candidate = stagedDispatch.get(event);
			if (candidate === void 0 || candidate.session !== session) return fail("KerSor dispatch event reached publication without validation");
			stagedDispatch.delete(event);
			dispatchTraces.set(session, candidate.trace);
			return;
		}
		if (!isExperimentEvent(event)) return;
		const candidate = staged.get(event);
		if (candidate === void 0 || candidate.session !== session) return fail("KerSor experiment event reached publication without validation");
		staged.delete(event);
		traces.set(session, candidate.trace);
	}, { global: true });
}, { inject: ["sessions"] });
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns the installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
