import { objectSchema } from "./shared.js";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function officeHttpUrl(env) {
  const configured = String(env.AI_HARNESS_OFFICE_HTTP_URL || env.AI_HARNESS_OFFICE_URL || "").trim();
  if (!configured) throw new Error("AI_HARNESS_OFFICE_URL is required to read office context.");
  const url = new URL(configured);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("The office context URL must be credential-free HTTP(S) or WS(S).");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function summaryRecord(record) {
  return {
    id: record.id,
    title: record.title,
    summary: record.summary,
    status: record.status,
    agent: record.agent,
    sourceId: record.sourceId,
    occurredAt: record.occurredAt,
    artifactCount: Array.isArray(record.artifacts) ? record.artifacts.length : 0,
  };
}

function createReadOfficeContextTool({ env = process.env, fetchImpl = fetch } = {}) {
  async function request(pathname, searchParams = {}, signal) {
    const url = new URL(pathname, officeHttpUrl(env));
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const headers = { accept: "application/json" };
    const token = String(env.AI_HARNESS_WORKER_TOKEN || "").trim();
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetchImpl(url, {
      headers,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("Office response exceeds 5 MiB.");
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error(`Office returned invalid JSON (HTTP ${response.status}).`); }
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `Office returned HTTP ${response.status}.`);
    return payload;
  }

  return {
    name: "read_office_context",
    description: "Read completed-task summaries, full task details, or recent Office chat messages. Use this before answering questions about prior Office work.",
    parameters: objectSchema({
      view: {
        type: "string",
        enum: ["completed_tasks", "task_details", "messages"],
        description: "The Office information to read.",
      },
      query: { type: ["string", "null"], description: "Optional title/summary search for completed tasks, or task ID for task_details." },
      full_details: { type: ["boolean", "null"], description: "Include stored details and artifacts for completed_tasks; null defaults to summaries only." },
      limit: { type: ["integer", "null"], description: "Maximum records or messages, from 1 to 100; null defaults to 20." },
    }),
    async execute({ view, query, full_details: fullDetails, limit }, { signal } = {}) {
      const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 20));
      if (view === "completed_tasks") {
        const payload = await request("/api/memory", {
          kind: "task", status: "completed", query: query?.trim(), limit: boundedLimit,
        }, signal);
        const records = Array.isArray(payload.records) ? payload.records : [];
        return { ok: true, view, records: fullDetails ? records : records.map(summaryRecord) };
      }
      if (view === "task_details") {
        const taskId = String(query || "").trim();
        if (!taskId) throw new Error("query must contain a task ID for task_details.");
        const payload = await request("/api/tasks", {}, signal);
        const task = (Array.isArray(payload.tasks) ? payload.tasks : []).find((entry) => (
          [entry.id, entry.messageId, entry.workerTaskId].includes(taskId)
        ));
        if (!task) throw new Error(`Office task not found: ${taskId}`);
        return { ok: true, view, task };
      }
      if (view === "messages") {
        const payload = await request("/api/chat", { limit: boundedLimit }, signal);
        return { ok: true, view, messages: payload.messages || [], members: payload.members || [] };
      }
      throw new Error(`Unknown office context view: ${view}`);
    },
  };
}

export { createReadOfficeContextTool, officeHttpUrl, summaryRecord };
