/** Host-normalizable Bash envelope rules for one canonical KerSor setup call. */
/**
 * Whether a durable Bash call can be normalized to the Host-owned foreground
 * setup envelope without changing its command.
 * @param argumentsValue - Parsed durable Bash arguments.
 * @param expectedCommand - Exact Host-generated setup command.
 * @param expectedWorkspace - Canonical controller workspace allowed as the exact workdir.
 * @returns Whether Host policy can safely suppress only authored escalation fields.
 */
export declare function hostNormalizableSetupArguments(argumentsValue: unknown, expectedCommand: string, expectedWorkspace: string): boolean;
//# sourceMappingURL=setup-tool-arguments.d.ts.map