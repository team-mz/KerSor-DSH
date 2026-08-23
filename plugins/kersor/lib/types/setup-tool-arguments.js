/** Host-normalizable Bash envelope rules for one canonical KerSor setup call. */
import { isAbsolute, resolve } from 'node:path';
const BASH_SANDBOX_PERMISSIONS = new Set([
    'read-only', 'workspace-write', 'danger-full-access',
]);
/**
 * Whether a durable Bash call can be normalized to the Host-owned foreground
 * setup envelope without changing its command.
 * @param argumentsValue - Parsed durable Bash arguments.
 * @param expectedCommand - Exact Host-generated setup command.
 * @param expectedWorkspace - Canonical controller workspace allowed as the exact workdir.
 * @returns Whether Host policy can safely suppress only authored escalation fields.
 */
export function hostNormalizableSetupArguments(argumentsValue, expectedCommand, expectedWorkspace) {
    if (argumentsValue === null || typeof argumentsValue !== 'object'
        || Array.isArray(argumentsValue))
        return false;
    const argumentsRecord = argumentsValue;
    if (argumentsRecord.command !== expectedCommand)
        return false;
    if (!isAbsolute(expectedWorkspace) || resolve(expectedWorkspace) !== expectedWorkspace)
        return false;
    const workdir = argumentsRecord.workdir;
    if (workdir !== undefined) {
        if (typeof workdir !== 'string')
            return false;
        if (workdir !== '.' && workdir !== expectedWorkspace)
            return false;
    }
    if (argumentsRecord.run_in_background === true)
        return false;
    if (argumentsRecord.run_in_background !== undefined
        && typeof argumentsRecord.run_in_background !== 'boolean')
        return false;
    const permissions = argumentsRecord.sandbox_permissions;
    if (permissions !== undefined
        && (typeof permissions !== 'string' || !BASH_SANDBOX_PERMISSIONS.has(permissions)))
        return false;
    const justification = argumentsRecord.justification;
    return justification === undefined || typeof justification === 'string';
}
//# sourceMappingURL=setup-tool-arguments.js.map