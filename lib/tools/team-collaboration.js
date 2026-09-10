import { officeHttpUrl } from "./read-office-context.js";
import { objectSchema } from "./shared.js";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_REQUEST_LENGTH = 100_000;
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "timed_out"]);

function officeHeaders(env, extra = {}) {
  const token = String(env.AI_HARNESS_WORKER_TOKEN || "").trim();
  if (!token) throw new Error("AI_HARNESS_WORKER_TOKEN is required for teammate collaboration.");
  return {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "x-agent-name": String(env.WORKER_NAME || "Coding Worker Agent").trim(),
    ...extra,
  };
}

function combinedSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

async function readPayload(response) {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("Office response exceeds 5 MiB.");
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`Office returned invalid JSON (HTTP ${response.status}).`); }
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `Office returned HTTP ${response.status}.`);
  return payload;
}

function searchableWorkerText(worker) {
  const capabilities = worker?.capabilities || {};
  const skills = Array.isArray(capabilities.skills) ? capabilities.skills : [];
  return [
    worker?.name,
    worker?.description,
    ...skills.flatMap((skill) => [skill?.id, skill?.name, skill?.description]),
    ...(Array.isArray(capabilities.tools) ? capabilities.tools : []),
  ].filter(Boolean).join("\n").toLowerCase();
}

function publicTeammate(worker) {
  const capabilities = worker?.capabilities && typeof worker.capabilities === "object"
    ? worker.capabilities
    : {};
  const model = worker?.model && typeof worker.model === "object"
    ? { provider: String(worker.model.provider || ""), name: String(worker.model.name || "") }
    : undefined;
  return {
    name: String(worker?.name || ""),
    description: String(worker?.description || ""),
    status: String(worker?.status || "connected"),
    capabilities: {
      skills: Array.isArray(capabilities.skills) ? capabilities.skills : [],
      tools: Array.isArray(capabilities.tools) ? capabilities.tools : [],
      mcp: capabilities.mcp === true,
      workspaceArtifacts: capabilities.workspaceArtifacts === true,
    },
    ...(model ? { model } : {}),
  };
}

function createListTeammatesTool({ env = process.env, fetchImpl = fetch } = {}) {
  return {
    name: "list_teammates",
    description: "Discover connected Office teammates and inspect their descriptions, skills, tools, MCP support, availability, and model metadata. Use this to find a qualified teammate before asking for help.",
    parameters: objectSchema({
      query: { type: ["string", "null"], description: "Optional expertise, skill, or tool to match; null lists every teammate." },
      available_only: { type: ["boolean", "null"], description: "When true, omit teammates whose status is busy; null defaults to false." },
    }),
    async execute({ query, available_only: availableOnly }, { signal } = {}) {
      const url = new URL("/api/sub-agents", officeHttpUrl(env));
      const response = await fetchImpl(url, {
        headers: officeHeaders(env),
        signal: combinedSignal(signal, 30_000),
      });
      const payload = await readPayload(response);
      const self = String(env.WORKER_NAME || "Coding Worker Agent").trim().toLowerCase();
      const needle = String(query || "").trim().toLowerCase();
      const workers = (Array.isArray(payload.workers) ? payload.workers : [])
        .filter((worker) => String(worker?.name || "").trim().toLowerCase() !== self)
        .filter((worker) => !availableOnly || !["busy", "working", "offline", "disconnected"].includes(String(worker?.status || "").toLowerCase()))
        .filter((worker) => !needle || searchableWorkerText(worker).includes(needle))
        .map(publicTeammate);
      return { ok: true, teammates: workers, count: workers.length };
    },
  };
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error("Collaboration request was aborted."));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error("Collaboration request was aborted."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function delegationRecord(payload) {
  return payload.delegation && typeof payload.delegation === "object" ? payload.delegation : payload;
}

function createAskTeammateTool({ env = process.env, fetchImpl = fetch, pollIntervalMs = 1_000 } = {}) {
  return {
    name: "ask_teammate",
    description: "Ask a specifically chosen Office teammate for expert help and wait for their answer. The teammate may use their own built-in or MCP tools. Discover capabilities with list_teammates first, give a bounded request, and treat the returned answer as advisory input.",
    parameters: objectSchema({
      teammate: { type: "string", minLength: 1, maxLength: 100, description: "Exact teammate name returned by list_teammates." },
      request: { type: "string", minLength: 1, maxLength: MAX_REQUEST_LENGTH, description: "Self-contained question or subtask, including the expected output." },
      reason: { type: ["string", "null"], maxLength: 1_000, description: "Why this teammate's advertised expertise is relevant; null is allowed." },
      mode: { type: "string", enum: ["consult", "task"], description: "consult requests a direct expert answer; task delegates a bounded assignment that may produce artifacts." },
      timeout_seconds: { type: ["integer", "null"], minimum: 5, maximum: 600, description: "How long to wait; null defaults to 120 seconds." },
    }),
    async execute({ teammate, request, reason, mode, timeout_seconds: timeoutSeconds }, { signal } = {}) {
      const target = String(teammate || "").trim();
      const text = String(request || "").trim();
      if (!target) throw new Error("teammate is required.");
      if (!text) throw new Error("request is required.");
      if (text.length > MAX_REQUEST_LENGTH) throw new Error(`request exceeds ${MAX_REQUEST_LENGTH} characters.`);
      const self = String(env.WORKER_NAME || "Coding Worker Agent").trim();
      if (target.toLowerCase() === self.toLowerCase()) throw new Error("A worker cannot ask itself for teammate help.");
      const seconds = Number.isSafeInteger(timeoutSeconds) ? Math.max(5, Math.min(600, timeoutSeconds)) : 120;
      const requestSignal = combinedSignal(signal, seconds * 1_000);
      const url = new URL("/api/delegations", officeHttpUrl(env));
      const response = await fetchImpl(url, {
        method: "POST",
        headers: officeHeaders(env, { "content-type": "application/json" }),
        body: JSON.stringify({ teammate: target, request: text, reason: reason || null, mode, timeoutSeconds: seconds }),
        signal: requestSignal,
      });
      let payload = await readPayload(response);
      let delegation = delegationRecord(payload);
      const id = String(delegation.id || delegation.delegationId || "").trim();

      while (!TERMINAL_STATES.has(String(delegation.state || "").toLowerCase())) {
        if (!id) throw new Error("Office accepted the delegation without returning a delegation ID.");
        await wait(pollIntervalMs, requestSignal);
        const statusUrl = new URL("/api/delegations", officeHttpUrl(env));
        statusUrl.searchParams.set("id", id);
        const statusResponse = await fetchImpl(statusUrl, {
          headers: officeHeaders(env),
          signal: requestSignal,
        });
        payload = await readPayload(statusResponse);
        delegation = delegationRecord(payload);
      }

      const state = String(delegation.state).toLowerCase();
      return state === "completed"
        ? { ok: true, delegation }
        : { ok: false, delegation, error: delegation.error || `Teammate request ${state}.` };
    },
  };
}

export { createAskTeammateTool, createListTeammatesTool, publicTeammate, searchableWorkerText };
