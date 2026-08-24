/** Bounded projection of one Workflow agent call's retained Codex artifacts. */
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_EVENTS_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 12;
const MAX_ACTIVITIES = 40;
const MAX_MESSAGE_CHARS = 12_000;
const MAX_ACTIVITY_LABEL_CHARS = 500;
function optionalString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function optionalNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function stemOf(call) {
    const label = call.label
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'agent';
    return `${String(call.seq).padStart(5, '0')}-${label}`;
}
async function readBoundedJson(file) {
    try {
        const info = await stat(file);
        if (!info.isFile() || info.size > MAX_RESULT_BYTES)
            return undefined;
        return record(JSON.parse(await readFile(file, 'utf8')));
    }
    catch {
        return undefined;
    }
}
async function readEventsPrefix(file) {
    let handle;
    try {
        handle = await open(file, 'r');
        const buffer = Buffer.alloc(MAX_EVENTS_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const truncated = bytesRead > MAX_EVENTS_BYTES;
        let text = buffer.subarray(0, Math.min(bytesRead, MAX_EVENTS_BYTES)).toString('utf8');
        if (truncated)
            text = text.slice(0, Math.max(0, text.lastIndexOf('\n')));
        return { text, truncated };
    }
    catch {
        return { truncated: false };
    }
    finally {
        await handle?.close();
    }
}
function usageOf(result) {
    const usage = record(result?.usage);
    if (usage === undefined)
        return undefined;
    const inputTokens = optionalNumber(usage.input_tokens);
    const cachedInputTokens = optionalNumber(usage.cached_input_tokens);
    const outputTokens = optionalNumber(usage.output_tokens);
    const totalTokens = optionalNumber(usage.total_tokens);
    if (inputTokens === undefined && cachedInputTokens === undefined
        && outputTokens === undefined && totalTokens === undefined)
        return undefined;
    return {
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(totalTokens === undefined ? {} : { totalTokens }),
    };
}
/**
 * Read one discovered call's retained worker artifacts without forwarding tool payloads.
 * @param runDir - Exact discovered run directory.
 * @param call - Call already present in the folded run view.
 * @returns Bounded messages and activity names, or `undefined` when no artifacts exist.
 */
export async function readCallDetail(runDir, call) {
    const stem = stemOf(call);
    const resultFile = path.join(runDir, '.runtime', 'agent-results', `${stem}.json`);
    const eventsFile = path.join(runDir, '.runtime', 'agent-results', `${stem}.codex-events.jsonl`);
    const [result, events] = await Promise.all([
        readBoundedJson(resultFile),
        readEventsPrefix(eventsFile),
    ]);
    if (result === undefined && events.text === undefined)
        return undefined;
    const messages = [];
    const activities = [];
    let truncated = events.truncated;
    for (const line of events.text?.split('\n') ?? []) {
        if (line.length === 0)
            continue;
        let event;
        try {
            event = record(JSON.parse(line));
        }
        catch {
            truncated = true;
            continue;
        }
        if (event?.type !== 'item.completed')
            continue;
        const item = record(event.item);
        const id = optionalString(item?.id);
        if (item?.type === 'agent_message') {
            const text = optionalString(item.text);
            if (id === undefined || text === undefined)
                continue;
            if (messages.length >= MAX_MESSAGES) {
                truncated = true;
                continue;
            }
            if (text.length > MAX_MESSAGE_CHARS)
                truncated = true;
            messages.push({ id, text: text.slice(0, MAX_MESSAGE_CHARS) });
            continue;
        }
        if (activities.length >= MAX_ACTIVITIES) {
            truncated = true;
            continue;
        }
        if (item?.type === 'mcp_tool_call') {
            const server = optionalString(item.server);
            const tool = optionalString(item.tool);
            if (id === undefined || tool === undefined)
                continue;
            activities.push({
                id,
                kind: 'tool',
                label: `${server === undefined ? '' : `${server}/`}${tool}`.slice(0, MAX_ACTIVITY_LABEL_CHARS),
                status: optionalString(item.status) ?? 'completed',
            });
        }
        else if (item?.type === 'web_search') {
            const query = optionalString(item.query);
            if (id === undefined || query === undefined)
                continue;
            if (query.length > MAX_ACTIVITY_LABEL_CHARS)
                truncated = true;
            activities.push({
                id,
                kind: 'web-search',
                label: query.slice(0, MAX_ACTIVITY_LABEL_CHARS),
                status: 'completed',
            });
        }
    }
    const isolation = optionalString(record(result?.isolation)?.effective);
    const modelRole = result === undefined || result.model_role === null
        ? result?.model_role
        : optionalString(result.model_role);
    const provider = result === undefined || result.provider === null
        ? result?.provider
        : optionalString(result.provider);
    const threadId = optionalString(result?.thread_id);
    const usage = usageOf(result);
    return {
        callId: call.callId,
        runner: events.text === undefined ? 'unknown' : 'codex-exec',
        ...(threadId === undefined ? {} : { threadId }),
        model: optionalString(result?.model) ?? null,
        ...(modelRole === undefined ? {} : { modelRole }),
        ...(provider === undefined ? {} : { provider }),
        ...(isolation === undefined ? {} : { isolation }),
        messages,
        activities,
        ...(usage === undefined ? {} : { usage }),
        truncated,
    };
}
//# sourceMappingURL=detail.js.map