/** Canonical DSH Bash envelopes for authored Workflow custody gates. */
/**
 * Build the sole controller command that seals one author-owned staging set.
 * @param kersorPython - Host-frozen canonical Python executable.
 * @param sessionDir - Host-authorized canonical KerSor Session directory.
 * @returns Exact Bash command accepted by the author seal gate.
 */
export declare function canonicalAuthorHandoffSealCommand(kersorPython: string, sessionDir: string): string;
/**
 * Build the sole controller command that attempts to save sealed author bytes.
 * @param kersorPython - Host-frozen canonical Python executable.
 * @param sessionDir - Host-authorized canonical KerSor Session directory.
 * @returns Exact Bash command accepted by the authored Proposal save gate.
 */
export declare function canonicalAuthorSaveCommand(kersorPython: string, sessionDir: string): string;
/**
 * Check the complete foreground Bash envelope for an authored Workflow gate.
 * Sandbox, workdir, background, and unknown fields are Host-owned and rejected.
 * @param value - Untrusted tool arguments authored by the controller model.
 * @param expectedCommand - Exact Host-generated seal or save command.
 * @returns Whether the arguments contain only inert presentation/timeout fields.
 */
export declare function hostCanonicalAuthorToolArguments(value: unknown, expectedCommand: string): boolean;
/** Host-minted command identities for the two authored Workflow gates. */
export interface CanonicalAuthorCommands {
    readonly seal: string;
    readonly save: string;
}
/** The only authored Workflow gate identities accepted by the Host. */
export type CanonicalAuthorCommandKind = 'seal' | 'save';
/**
 * Classify a complete foreground Bash envelope against Host-minted identities.
 * @param value - Untrusted Bash arguments from one Tool execution.
 * @param commands - Exact commands generated from durable author authority.
 * @returns The matching gate kind, or `undefined` for every noncanonical envelope.
 */
export declare function canonicalAuthorCommandKind(value: unknown, commands: CanonicalAuthorCommands): CanonicalAuthorCommandKind | undefined;
//# sourceMappingURL=author-tool-commands.d.ts.map