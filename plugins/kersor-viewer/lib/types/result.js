/** Bounded projection of a Workflow Host output for browser visualization. */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_HOST_VERIFICATION_BYTES = 1024 * 1024;
const MAX_CANDIDATES = 20;
function optionalString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function optionalNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function failureKind(value) {
    const reason = typeof value === 'string' ? value.toLowerCase() : '';
    if (reason.includes('correctness'))
        return 'correctness';
    if (reason.includes('benchmark'))
        return 'benchmark';
    return 'infrastructure';
}
async function readObject(file, maxBytes) {
    try {
        const info = await stat(file);
        if (!info.isFile() || info.size > maxBytes)
            return undefined;
        const decoded = JSON.parse(await readFile(file, 'utf8'));
        return decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)
            ? decoded
            : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Read one canonical output without forwarding candidate source or arbitrary report text.
 * @param runDir - Exact discovered run directory.
 * @returns Bounded candidate-selection facts, or `undefined` when absent or invalid.
 */
export async function readWorkflowResult(runDir) {
    const [value, host] = await Promise.all([
        readObject(path.join(runDir, 'output.json'), MAX_OUTPUT_BYTES),
        readObject(path.join(runDir, 'host-verification.json'), MAX_HOST_VERIFICATION_BYTES),
    ]);
    try {
        if (value === undefined && host === undefined)
            return undefined;
        const output = value ?? {};
        const rawCandidates = Array.isArray(output.candidate_log) ? output.candidate_log : [];
        const candidates = rawCandidates.slice(0, MAX_CANDIDATES).flatMap((candidate) => {
            if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
                return [];
            const row = candidate;
            const id = optionalString(row.candidate_id);
            if (id === undefined)
                return [];
            const expectedCycles = optionalNumber(row.expected_cycles);
            return [{ id, ...(expectedCycles === undefined ? {} : { expectedCycles }) }];
        });
        const hostMetric = host?.verdict === 'pass' && host.metric !== null
            && typeof host.metric === 'object' && !Array.isArray(host.metric)
            ? host.metric
            : undefined;
        const verification = host?.verdict === 'pass'
            ? 'passed'
            : host?.verdict === 'fail' ? 'failed' : undefined;
        const rejectedKind = verification === 'failed' ? failureKind(host?.reason) : undefined;
        const stage = verification === 'passed'
            ? 'host_verified'
            : verification === 'failed' ? 'host_rejected' : optionalString(output.arch_stage);
        const selectedCandidateId = optionalString(output.selected_candidate_id);
        const expectedCycles = optionalNumber(output.expected_cycles_estimate);
        const measuredBaselineCycles = optionalNumber(hostMetric?.baseline_cycles);
        const measuredCycles = optionalNumber(hostMetric?.candidate_cycles);
        const estimatedSpeedup = optionalNumber(output.estimated_speedup);
        const measured = hostMetric?.candidate_speedup ?? hostMetric?.speedup;
        const measuredSpeedup = measured === null ? null : optionalNumber(measured);
        const incumbentCycles = optionalNumber(hostMetric?.incumbent_cycles);
        const incumbentSpeedup = optionalNumber(hostMetric?.incumbent_speedup);
        const bestImproved = typeof hostMetric?.best_improved === 'boolean'
            ? hostMetric.best_improved
            : undefined;
        if (stage === undefined && verification === undefined && selectedCandidateId === undefined
            && expectedCycles === undefined && measuredBaselineCycles === undefined
            && measuredCycles === undefined && estimatedSpeedup === undefined
            && measuredSpeedup === undefined && candidates.length === 0)
            return undefined;
        return {
            ...(stage === undefined ? {} : { stage }),
            ...(verification === undefined ? {} : { verification }),
            ...(rejectedKind === undefined ? {} : { failureKind: rejectedKind }),
            ...(selectedCandidateId === undefined ? {} : { selectedCandidateId }),
            ...(expectedCycles === undefined ? {} : { expectedCycles }),
            ...(measuredBaselineCycles === undefined ? {} : { measuredBaselineCycles }),
            ...(measuredCycles === undefined ? {} : { measuredCycles }),
            ...(estimatedSpeedup === undefined ? {} : { estimatedSpeedup }),
            ...(measuredSpeedup === undefined ? {} : { measuredSpeedup }),
            ...(incumbentCycles === undefined ? {} : { incumbentCycles }),
            ...(incumbentSpeedup === undefined ? {} : { incumbentSpeedup }),
            ...(bestImproved === undefined ? {} : { bestImproved }),
            candidates,
        };
    }
    catch {
        // Missing or invalid optional output leaves runtime progress usable.
        return undefined;
    }
}
//# sourceMappingURL=result.js.map