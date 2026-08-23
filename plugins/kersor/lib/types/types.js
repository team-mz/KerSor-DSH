/**
 * Client-safe KerSor launcher types: configured task identities, active
 * process receipts, and the forwarded active-launch frame.
 * @module @deepseek-ai/dsh-kersor/types
 */
const LAUNCH_KEYS = new Set([
    'backend',
    'language',
    'integration_pattern',
    'target_speedup',
    'max_workflows',
    'mode',
    'workflow_authoring_budget',
    'retrieval_mode',
    'transfer_mode',
    'experience_mode',
    'kernelwiki_experience_export_mode',
    'correctness_command',
    'benchmark_command',
]);
/**
 * Serialize a lossless JSON value with recursively sorted object keys.
 * Arrays retain their source order. Host authority hashes use these exact UTF-8
 * bytes so producers and invariant replay cannot diverge on property insertion
 * order.
 * @param value - Lossless JSON value to serialize canonically.
 * @returns Canonical JSON text with recursively sorted object keys.
 */
export function canonicalKersorJson(value) {
    if (value === null)
        return 'null';
    if (typeof value === 'string' || typeof value === 'boolean')
        return JSON.stringify(value);
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            throw new TypeError('KerSor canonical JSON requires finite numbers');
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
        return `[${value.map(canonicalKersorJson).join(',')}]`;
    if (typeof value !== 'object') {
        throw new TypeError('KerSor canonical JSON requires a lossless JSON value');
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) {
        throw new TypeError('KerSor canonical JSON requires plain JSON objects');
    }
    const record = value;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalKersorJson(record[key])}`).join(',')}}`;
}
function launchRecord(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be a plain JSON object`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) {
        throw new TypeError(`${label} must be a plain JSON object`);
    }
    const record = value;
    const unknown = Object.keys(record).find(key => !LAUNCH_KEYS.has(key));
    if (unknown !== undefined)
        throw new TypeError(`${label} has unknown field ${JSON.stringify(unknown)}`);
    for (const key of LAUNCH_KEYS) {
        if (!Object.hasOwn(record, key))
            throw new TypeError(`${label}.${key} is required`);
    }
    return record;
}
function launchText(record, key, label) {
    const value = record[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new TypeError(`${label}.${key} must be a non-empty string`);
    }
    return value;
}
function launchCommand(record, key, label) {
    const value = launchText(record, key, label);
    if (value !== value.trim()) {
        throw new TypeError(`${label}.${key} must already be trimmed`);
    }
    if (/[\r\n\u2028\u2029]/u.test(value)) {
        throw new TypeError(`${label}.${key} must be a single-line string`);
    }
    return value;
}
function launchEnum(record, key, values, label) {
    const value = record[key];
    if (typeof value !== 'string' || !values.includes(value)) {
        throw new TypeError(`${label}.${key} must be one of ${values.join(', ')}`);
    }
    return value;
}
function launchPositiveNumber(record, key, label) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new TypeError(`${label}.${key} must be a positive finite number`);
    }
    return value;
}
function launchInteger(record, key, minimum, label) {
    const value = record[key];
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new TypeError(`${label}.${key} must be a safe integer greater than or equal to ${minimum}`);
    }
    return value;
}
/**
 * Validate and copy one launch contract into canonical field order.
 * @param value - candidate plain JSON value.
 * @param label - error-path prefix.
 * @returns the validated contract without normalizing strings or numbers.
 */
export function parseKersorLaunchContract(value, label = 'KerSor launch contract') {
    const record = launchRecord(value, label);
    const backend = launchEnum(record, 'backend', ['cuda', 'rocm', 'triton', 'python', 'metal', 'metax', 'ascend', 'sycl'], label);
    const language = launchEnum(record, 'language', ['cuda', 'rocm', 'triton', 'python_reference', 'metal', 'metax', 'ascendc', 'sycl', 'cutlass'], label);
    const expectedBackend = {
        cuda: 'cuda',
        rocm: 'rocm',
        triton: 'triton',
        python_reference: 'python',
        metal: 'metal',
        metax: 'metax',
        ascendc: 'ascend',
        sycl: 'sycl',
        cutlass: 'cuda',
    };
    if (backend !== expectedBackend[language]) {
        throw new TypeError(`${label}.backend ${JSON.stringify(backend)} is incompatible with language ${JSON.stringify(language)}`);
    }
    return {
        backend,
        language,
        integration_pattern: launchText(record, 'integration_pattern', label),
        target_speedup: launchPositiveNumber(record, 'target_speedup', label),
        max_workflows: launchInteger(record, 'max_workflows', 1, label),
        mode: launchEnum(record, 'mode', ['auto', 'guided', 'explore'], label),
        workflow_authoring_budget: launchInteger(record, 'workflow_authoring_budget', 0, label),
        retrieval_mode: launchEnum(record, 'retrieval_mode', ['on', 'off'], label),
        transfer_mode: launchEnum(record, 'transfer_mode', ['full', 'measured-only', 'off'], label),
        experience_mode: launchEnum(record, 'experience_mode', ['on', 'off'], label),
        kernelwiki_experience_export_mode: launchEnum(record, 'kernelwiki_experience_export_mode', ['on', 'off'], label),
        correctness_command: launchCommand(record, 'correctness_command', label),
        benchmark_command: launchCommand(record, 'benchmark_command', label),
    };
}
//# sourceMappingURL=types.js.map