/** Canonical DSH Bash envelopes for authored Workflow custody gates. */
function shellQuote(value) {
    return `'${value.replaceAll('\'', '\'\\\'\'')}'`;
}
/**
 * Build the sole controller command that seals one author-owned staging set.
 * @param kersorPython - Host-frozen canonical Python executable.
 * @param sessionDir - Host-authorized canonical KerSor Session directory.
 * @returns Exact Bash command accepted by the author seal gate.
 */
export function canonicalAuthorHandoffSealCommand(kersorPython, sessionDir) {
    return `KERSOR_PYTHON=${shellQuote(kersorPython)}; export KERSOR_PYTHON; SESSION_DIR=${shellQuote(sessionDir)}; bridge="\${DSH_HOME:-$HOME/.dsh}/.agent-presets/kersor/bin/kersor_bridge.py"; kersor_root="$("$KERSOR_PYTHON" "$bridge" root)"; KERSOR_PYTHON="\${KERSOR_PYTHON:-python3}" bash "$kersor_root/scripts/run-kersor-python.sh" seal-author-handoff.py --from "$SESSION_DIR/workflow-authoring/staging" --out "$SESSION_DIR/workflow-authoring/author-handoff.json"`;
}
/**
 * Build the sole controller command that attempts to save sealed author bytes.
 * @param kersorPython - Host-frozen canonical Python executable.
 * @param sessionDir - Host-authorized canonical KerSor Session directory.
 * @returns Exact Bash command accepted by the authored Proposal save gate.
 */
export function canonicalAuthorSaveCommand(kersorPython, sessionDir) {
    return `KERSOR_PYTHON=${shellQuote(kersorPython)}; export KERSOR_PYTHON; SESSION_DIR=${shellQuote(sessionDir)}; bridge="\${DSH_HOME:-$HOME/.dsh}/.agent-presets/kersor/bin/kersor_bridge.py"; kersor_root="$("$KERSOR_PYTHON" "$bridge" root)"; bash "$kersor_root/scripts/save-authored-workflow.sh" --from "$SESSION_DIR/workflow-authoring/staging" --store "$SESSION_DIR/workflow-authoring/proposals" --handoff "$SESSION_DIR/workflow-authoring/author-handoff.json"`;
}
/**
 * Check the complete foreground Bash envelope for an authored Workflow gate.
 * Sandbox, workdir, background, and unknown fields are Host-owned and rejected.
 * @param value - Untrusted tool arguments authored by the controller model.
 * @param expectedCommand - Exact Host-generated seal or save command.
 * @returns Whether the arguments contain only inert presentation/timeout fields.
 */
export function hostCanonicalAuthorToolArguments(value, expectedCommand) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const args = value;
    if (Object.keys(args).some(key => !['command', 'description', 'timeoutMs'].includes(key))) {
        return false;
    }
    return args.command === expectedCommand
        && (args.description === undefined || typeof args.description === 'string')
        && (args.timeoutMs === undefined
            || Number.isSafeInteger(args.timeoutMs) && args.timeoutMs > 0);
}
/**
 * Classify a complete foreground Bash envelope against Host-minted identities.
 * @param value - Untrusted Bash arguments from one Tool execution.
 * @param commands - Exact commands generated from durable author authority.
 * @returns The matching gate kind, or `undefined` for every noncanonical envelope.
 */
export function canonicalAuthorCommandKind(value, commands) {
    if (hostCanonicalAuthorToolArguments(value, commands.seal))
        return 'seal';
    if (hostCanonicalAuthorToolArguments(value, commands.save))
        return 'save';
    return undefined;
}
//# sourceMappingURL=author-tool-commands.js.map