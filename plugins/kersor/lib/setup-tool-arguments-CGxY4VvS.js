import { isAbsolute, resolve } from "node:path";
//#region lib/types/author-tool-commands.js
/** Canonical DSH Bash envelopes for authored Workflow custody gates. */
function shellQuote(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
/**
* Build the sole controller command that seals one author-owned staging set.
* @param kersorPython - Host-frozen canonical Python executable.
* @param sessionDir - Host-authorized canonical KerSor Session directory.
* @returns Exact Bash command accepted by the author seal gate.
*/
function canonicalAuthorHandoffSealCommand(kersorPython, sessionDir) {
	return `KERSOR_PYTHON=${shellQuote(kersorPython)}; export KERSOR_PYTHON; SESSION_DIR=${shellQuote(sessionDir)}; bridge="\${DSH_HOME:-$HOME/.dsh}/.agent-presets/kersor/bin/kersor_bridge.py"; kersor_root="$("$KERSOR_PYTHON" "$bridge" root)"; KERSOR_PYTHON="\${KERSOR_PYTHON:-python3}" bash "$kersor_root/scripts/run-kersor-python.sh" seal-author-handoff.py --from "$SESSION_DIR/workflow-authoring/staging" --out "$SESSION_DIR/workflow-authoring/author-handoff.json"`;
}
/**
* Build the sole controller command that attempts to save sealed author bytes.
* @param kersorPython - Host-frozen canonical Python executable.
* @param sessionDir - Host-authorized canonical KerSor Session directory.
* @returns Exact Bash command accepted by the authored Proposal save gate.
*/
function canonicalAuthorSaveCommand(kersorPython, sessionDir) {
	return `KERSOR_PYTHON=${shellQuote(kersorPython)}; export KERSOR_PYTHON; SESSION_DIR=${shellQuote(sessionDir)}; bridge="\${DSH_HOME:-$HOME/.dsh}/.agent-presets/kersor/bin/kersor_bridge.py"; kersor_root="$("$KERSOR_PYTHON" "$bridge" root)"; bash "$kersor_root/scripts/save-authored-workflow.sh" --from "$SESSION_DIR/workflow-authoring/staging" --store "$SESSION_DIR/workflow-authoring/proposals" --handoff "$SESSION_DIR/workflow-authoring/author-handoff.json"`;
}
/**
* Check the complete foreground Bash envelope for an authored Workflow gate.
* Sandbox, workdir, background, and unknown fields are Host-owned and rejected.
* @param value - Untrusted tool arguments authored by the controller model.
* @param expectedCommand - Exact Host-generated seal or save command.
* @returns Whether the arguments contain only inert presentation/timeout fields.
*/
function hostCanonicalAuthorToolArguments(value, expectedCommand) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const args = value;
	if (Object.keys(args).some((key) => ![
		"command",
		"description",
		"timeoutMs"
	].includes(key))) return false;
	return args.command === expectedCommand && (args.description === void 0 || typeof args.description === "string") && (args.timeoutMs === void 0 || Number.isSafeInteger(args.timeoutMs) && args.timeoutMs > 0);
}
/**
* Classify a complete foreground Bash envelope against Host-minted identities.
* @param value - Untrusted Bash arguments from one Tool execution.
* @param commands - Exact commands generated from durable author authority.
* @returns The matching gate kind, or `undefined` for every noncanonical envelope.
*/
function canonicalAuthorCommandKind(value, commands) {
	if (hostCanonicalAuthorToolArguments(value, commands.seal)) return "seal";
	if (hostCanonicalAuthorToolArguments(value, commands.save)) return "save";
}
//#endregion
//#region lib/types/setup-tool-arguments.js
/** Host-normalizable Bash envelope rules for one canonical KerSor setup call. */
const BASH_SANDBOX_PERMISSIONS = new Set([
	"read-only",
	"workspace-write",
	"danger-full-access"
]);
/**
* Whether a durable Bash call can be normalized to the Host-owned foreground
* setup envelope without changing its command.
* @param argumentsValue - Parsed durable Bash arguments.
* @param expectedCommand - Exact Host-generated setup command.
* @param expectedWorkspace - Canonical controller workspace allowed as the exact workdir.
* @returns Whether Host policy can safely suppress only authored escalation fields.
*/
function hostNormalizableSetupArguments(argumentsValue, expectedCommand, expectedWorkspace) {
	if (argumentsValue === null || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) return false;
	const argumentsRecord = argumentsValue;
	if (argumentsRecord.command !== expectedCommand) return false;
	if (!isAbsolute(expectedWorkspace) || resolve(expectedWorkspace) !== expectedWorkspace) return false;
	const workdir = argumentsRecord.workdir;
	if (workdir !== void 0) {
		if (typeof workdir !== "string") return false;
		if (workdir !== "." && workdir !== expectedWorkspace) return false;
	}
	if (argumentsRecord.run_in_background === true) return false;
	if (argumentsRecord.run_in_background !== void 0 && typeof argumentsRecord.run_in_background !== "boolean") return false;
	const permissions = argumentsRecord.sandbox_permissions;
	if (permissions !== void 0 && (typeof permissions !== "string" || !BASH_SANDBOX_PERMISSIONS.has(permissions))) return false;
	const justification = argumentsRecord.justification;
	return justification === void 0 || typeof justification === "string";
}
//#endregion
export { hostCanonicalAuthorToolArguments as a, canonicalAuthorSaveCommand as i, canonicalAuthorCommandKind as n, canonicalAuthorHandoffSealCommand as r, hostNormalizableSetupArguments as t };
