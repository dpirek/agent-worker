import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CodingAgent } from "./agent.js";
import { environmentSystemPrompts } from "./env-config.js";
import { loadMcpTools } from "./mcp.js";
import { createModelClient } from "./openai.js";
import { providerConfiguration } from "./provider-config.js";
import { respondJson, serveStatic } from "./response.js";
import { createTools } from "./tools/index.js";

const MAX_MESSAGE_BYTES = 1_000_000;
const DEFAULT_CALLBACK_TIMEOUT_MS = 30_000;
const DEFAULT_TOOLS = ["list_files", "read_file", "write_file", "search_files", "curl", "run_command"];
const DEFAULT_PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const MAX_ERROR_RESPONSE_CHARS = 20_000;

function diagnosticUrl(value) {
  try {
    const url = new URL(value);
    if (url.username) url.username = "[redacted]";
    if (url.password) url.password = "[redacted]";
    for (const key of url.searchParams.keys()) {
      if (/(?:api[_-]?key|token|secret|password|auth)/i.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.toString();
  } catch {
    return String(value);
  }
}

function serializeError(error, depth = 0) {
  if (!error || depth > 4) return null;
  const serialized = {};
  for (const key of ["name", "message", "code", "errno", "syscall", "address", "port", "stack"]) {
    if (error[key] !== undefined) serialized[key] = error[key];
  }
  if (error.details && typeof error.details === "object") {
    Object.assign(serialized, error.details);
  }
  if (!serialized.cause && error.cause) serialized.cause = serializeError(error.cause, depth + 1);
  return Object.keys(serialized).length > 0 ? serialized : { message: String(error) };
}

function callbackHttpError(job, response, raw, attempt) {
  const body = String(raw || "");
  const error = new Error(`Callback returned HTTP ${response.status}.`);
  error.name = "CallbackResponseError";
  error.details = {
    request: { method: "POST", url: diagnosticUrl(job.callback.url), attempt },
    response: {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries([...response.headers].map(([name, value]) => [
        name,
        /(?:authorization|cookie|api[_-]?key|token|secret)/i.test(name) ? "[redacted]" : value,
      ])),
      body: body.slice(0, MAX_ERROR_RESPONSE_CHARS),
      truncated: body.length > MAX_ERROR_RESPONSE_CHARS,
    },
  };
  return error;
}

function callbackNetworkError(job, cause, attempt) {
  const causeMessage = cause?.cause?.message && cause.cause.message !== cause.message
    ? `: ${cause.cause.message}`
    : "";
  const error = new Error(`Callback request failed (POST ${diagnosticUrl(job.callback.url)}): ${cause?.message || String(cause)}${causeMessage}`, { cause });
  error.name = "CallbackRequestError";
  error.details = {
    request: { method: "POST", url: diagnosticUrl(job.callback.url), attempt },
    response: null,
    cause: serializeError(cause),
  };
  return error;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function configuredTools(env = process.env) {
  if (!Object.hasOwn(env, "WORKER_TOOLS")) return DEFAULT_TOOLS;
  return String(env.WORKER_TOOLS).split(",").map((name) => name.trim()).filter(Boolean);
}

async function ensureWorkerWorkspace(env = process.env, baseDir = process.cwd()) {
  const configuredPath = String(env.WORKER_WORKSPACE || ".workspace").trim() || ".workspace";
  const workspace = path.resolve(baseDir, configuredPath);
  await fs.mkdir(workspace, { recursive: true });
  return fs.realpath(workspace);
}

function messageText(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("message must be an object.");
  const messageId = String(message.messageId || "").trim();
  if (!messageId || messageId.length > 200) throw new Error("message.messageId is required and must be at most 200 characters.");
  if (!Array.isArray(message.parts) || message.parts.length === 0) throw new Error("message.parts must contain at least one text part.");
  const text = message.parts
    .filter((part) => part?.kind === "text" && typeof part.text === "string")
    .map((part) => part.text.trim()).filter(Boolean).join("\n\n");
  if (!text) throw new Error("message.parts must contain non-empty text.");
  return { messageId, text };
}

function workspaceResourceUrl(resourceBaseUrl, relativePath) {
  const encodedPath = String(relativePath)
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== ".")
    .map(encodeURIComponent)
    .join("/");
  return `${String(resourceBaseUrl).replace(/\/$/, "")}/${encodedPath}`;
}

function appendWorkspaceLinks(markdown, paths, resourceBaseUrl) {
  if (!resourceBaseUrl || paths.length === 0) return String(markdown);
  const links = paths
    .map((filePath) => ({ filePath, url: workspaceResourceUrl(resourceBaseUrl, filePath) }))
    .filter(({ url }) => !String(markdown).includes(url));
  if (links.length === 0) return String(markdown);
  return `${String(markdown).trimEnd()}\n\n### Created files\n\n${links
    .map(({ filePath, url }) => `- [${filePath}](${url})`)
    .join("\n")}`;
}

function callbackDetails(callback) {
  if (!callback || typeof callback !== "object" || Array.isArray(callback)) throw new Error("callback must be an object.");
  let url;
  try { url = new URL(callback.url); } catch { throw new Error("callback.url must be a valid URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("callback.url must be an HTTP(S) URL without embedded credentials.");
  }
  return { url: url.toString(), token: typeof callback.token === "string" ? callback.token.trim() : "" };
}

async function readJson(req, limit = MAX_MESSAGE_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error(`Request body exceeds ${limit} bytes.`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function resultMessage(job, state, text, error) {
  return {
    taskId: job.taskId,
    inReplyTo: job.messageId,
    status: { state },
    message: {
      messageId: `result-${job.taskId}`,
      role: "agent",
      parts: [{ kind: "text", mimeType: "text/markdown", text }],
    },
    ...(error ? { error } : {}),
  };
}

async function postCallback(job, payload, { fetchImpl = fetch, retries = 3, timeoutMs = DEFAULT_CALLBACK_TIMEOUT_MS } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { "content-type": "application/json" };
      if (job.callback.token) headers.authorization = `Bearer ${job.callback.token}`;
      let response;
      try {
        response = await fetchImpl(job.callback.url, {
          method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal,
        });
      } catch (error) {
        throw callbackNetworkError(job, error, attempt);
      }
      if (!response.ok) {
        let raw;
        try {
          raw = await response.text();
        } catch (error) {
          const diagnostic = callbackHttpError(job, response, "", attempt);
          diagnostic.message = `Callback response body could not be read (HTTP ${response.status}): ${error?.message || String(error)}`;
          diagnostic.cause = error;
          diagnostic.details.cause = serializeError(error);
          throw diagnostic;
        }
        throw callbackHttpError(job, response, raw, attempt);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** (attempt - 1))));
    } finally { clearTimeout(timer); }
  }
  throw lastError;
}

function createTaskQueue({ concurrency = 1, run }) {
  const pending = [];
  let active = 0;
  function drain() {
    while (active < concurrency && pending.length > 0) {
      const job = pending.shift();
      active += 1;
      Promise.resolve(run(job)).catch(() => {}).finally(() => { active -= 1; drain(); });
    }
  }
  return {
    add(job) { pending.push(job); drain(); },
    stats() { return { active, queued: pending.length }; },
  };
}

async function createHarnessRunner({ env = process.env, onInfo = console.error } = {}) {
  const root = await ensureWorkerWorkspace(env);
  const provider = providerConfiguration(env);
  const approval = async () => true;
  const allowedNames = new Set(configuredTools(env));
  const localTools = createTools({ root, approve: approval }).filter((tool) => allowedNames.has(tool.name));
  const mcpTools = await loadMcpTools({ root, env, approve: approval, autoApprove: true, onInfo });
  return async function runTask(prompt, { resourceBaseUrl = "" } = {}) {
    const createdPaths = new Set();
    // Some provider clients retain chat history internally, so each task gets
    // its own client as well as its own CodingAgent.
    const client = createModelClient({
      name: provider.name,
      url: provider.url,
      apiKey: provider.apiKey,
    });
    const agent = new CodingAgent({
      client, tools: [...localTools, ...mcpTools], model: provider.model, root, approve: approval, onInfo,
      maxTurns: positiveInteger(env.WORKER_MAX_TURNS, 30),
      systemPrompts: environmentSystemPrompts(env),
      resourceBaseUrl,
      onEvent(event) {
        if (event.type === "tool_result" && event.name === "write_file" && event.output?.ok) {
          createdPaths.add(event.output.path);
        }
      },
    });
    const markdown = await agent.run(prompt, { disabledSteps: ["composer"] });
    return appendWorkspaceLinks(markdown, [...createdPaths], resourceBaseUrl);
  };
}

function agentCard(baseUrl, env = process.env) {
  return {
    name: env.WORKER_NAME || "Coding Worker Agent",
    description: env.WORKER_DESCRIPTION || "Completes coding tasks in its configured workspace.",
    url: `${String(baseUrl).replace(/\/$/, "")}/a2a`,
    skills: [{ id: "coding-task", name: "Coding Task", description: "Inspect, modify, and validate a software workspace." }],
  };
}

function publicJob(job, includeResult = false) {
  return {
    taskId: job.taskId,
    messageId: job.messageId,
    state: job.state,
    source: job.internal ? "repl" : "a2a",
    callbackDelivered: job.internal ? null : job.callbackDelivered,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    error: job.error || null,
    errorDetails: job.errorDetails || null,
    callbackError: job.callbackError || null,
    callbackErrorDetails: job.callbackErrorDetails || null,
    ...(includeResult && job.result ? { result: job.result } : {}),
  };
}

function createWorkerServer({
  env = process.env,
  runTask,
  callbackFetch = fetch,
  onInfo = console.error,
  publicDir = DEFAULT_PUBLIC_DIR,
} = {}) {
  const jobs = new Map();
  const tasks = new Map();
  let runnerPromise;
  const runner = async (text, context) => {
    runnerPromise ||= runTask ? Promise.resolve(runTask) : createHarnessRunner({ env, onInfo });
    return (await runnerPromise)(text, context);
  };
  const callbackOptions = {
    fetchImpl: callbackFetch,
    retries: positiveInteger(env.WORKER_CALLBACK_RETRIES, 3),
    timeoutMs: positiveInteger(env.WORKER_CALLBACK_TIMEOUT_MS, DEFAULT_CALLBACK_TIMEOUT_MS),
  };
  const queue = createTaskQueue({
    concurrency: positiveInteger(env.WORKER_CONCURRENCY, 1),
    async run(job) {
      job.state = "working";
      job.startedAt = new Date().toISOString();
      let callbackPayload;
      try {
        const text = await runner(job.text, { resourceBaseUrl: job.resourceBaseUrl });
        job.state = "completed";
        callbackPayload = resultMessage(job, "completed", text);
      } catch (error) {
        job.state = "failed";
        job.error = error.message;
        job.errorDetails = serializeError(error);
        callbackPayload = resultMessage(job, "failed", `Task failed: ${error.message}`, {
          code: "TASK_FAILED", message: error.message, details: job.errorDetails,
        });
      }
      job.result = callbackPayload;
      job.finishedAt = new Date().toISOString();
      if (job.internal) return;
      try {
        await postCallback(job, callbackPayload, callbackOptions);
        job.callbackDelivered = true;
      } catch (callbackError) {
        job.callbackError = callbackError.message;
        job.callbackErrorDetails = serializeError(callbackError);
        onInfo(`Callback delivery failed for ${job.taskId}: ${callbackError.message}`);
      }
    },
  });

  function enqueue({ messageId, text, callback = null, internal = false, resourceBaseUrl }) {
    const job = {
      taskId: crypto.randomUUID(),
      messageId,
      text,
      callback,
      internal,
      state: "submitted",
      callbackDelivered: false,
      createdAt: new Date().toISOString(),
      resourceBaseUrl,
    };
    jobs.set(messageId, job);
    tasks.set(job.taskId, job);
    queue.add(job);
    return job;
  }

  function status() {
    const provider = providerConfiguration(env);
    const promptOverrides = Object.keys(environmentSystemPrompts(env));
    return {
      ok: true,
      agent: {
        name: env.WORKER_NAME || "Coding Worker Agent",
        description: env.WORKER_DESCRIPTION || "Completes coding tasks in its configured workspace.",
      },
      provider: {
        name: provider.name,
        url: provider.url,
        model: provider.model,
        apiKeyConfigured: Boolean(provider.apiKey),
      },
      execution: {
        workspace: path.resolve(env.WORKER_WORKSPACE || ".workspace"),
        workspaceUrl: `${String(env.WORKER_PUBLIC_URL || "").replace(/\/$/, "")}/workspace/`,
        concurrency: positiveInteger(env.WORKER_CONCURRENCY, 1),
        maxTurns: positiveInteger(env.WORKER_MAX_TURNS, 30),
        maxMessageBytes: positiveInteger(env.WORKER_MAX_MESSAGE_BYTES, MAX_MESSAGE_BYTES),
        tools: configuredTools(env),
        systemPromptOverrides: promptOverrides,
        mcpConfigured: Boolean(env.AI_HARNESS_MCP_SERVERS),
      },
      callback: {
        retries: positiveInteger(env.WORKER_CALLBACK_RETRIES, 3),
        timeoutMs: positiveInteger(env.WORKER_CALLBACK_TIMEOUT_MS, DEFAULT_CALLBACK_TIMEOUT_MS),
      },
      queue: queue.stats(),
      tasks: [...tasks.values()].slice(-50).reverse().map((job) => publicJob(job)),
    };
  }

  return http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && requestUrl.pathname === "/health") {
        respondJson(res, { ok: true, ...queue.stats() });
        return;
      }
      if (req.method === "GET" && requestUrl.pathname === "/api/status") {
        respondJson(res, status());
        return;
      }
      if (req.method === "GET" && requestUrl.pathname.startsWith("/api/tasks/")) {
        const taskId = decodeURIComponent(requestUrl.pathname.slice("/api/tasks/".length));
        const job = tasks.get(taskId);
        if (!job) respondJson(res, { ok: false, error: "Task not found." }, 404);
        else respondJson(res, { ok: true, task: publicJob(job, true) });
        return;
      }
      if (req.method === "GET" && ["/.well-known/agent-card.json", "/agent-card.json"].includes(requestUrl.pathname)) {
        respondJson(res, agentCard(env.WORKER_PUBLIC_URL || requestUrl.origin, env));
        return;
      }
      if (req.method === "POST" && requestUrl.pathname === "/api/test") {
        const payload = await readJson(req, positiveInteger(env.WORKER_MAX_MESSAGE_BYTES, MAX_MESSAGE_BYTES));
        const text = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
        if (!text) throw new Error("prompt must be a non-empty string.");
        const messageId = `repl-${crypto.randomUUID()}`;
        const baseUrl = env.WORKER_PUBLIC_URL || requestUrl.origin;
        const job = enqueue({
          messageId,
          text,
          internal: true,
          resourceBaseUrl: `${String(baseUrl).replace(/\/$/, "")}/workspace`,
        });
        respondJson(res, { accepted: true, taskId: job.taskId, messageId, status: job.state }, 202);
        return;
      }
      if (req.method === "POST" && requestUrl.pathname === "/a2a") {
        const payload = await readJson(req, positiveInteger(env.WORKER_MAX_MESSAGE_BYTES, MAX_MESSAGE_BYTES));
        const { messageId, text } = messageText(payload.message);
        const callback = callbackDetails(payload.callback);
        if (jobs.has(messageId)) {
          const existing = jobs.get(messageId);
          respondJson(res, { accepted: true, duplicate: true, taskId: existing.taskId, messageId, status: existing.state }, 202);
          return;
        }
        const baseUrl = env.WORKER_PUBLIC_URL || requestUrl.origin;
        const job = enqueue({
          messageId,
          text,
          callback,
          resourceBaseUrl: `${String(baseUrl).replace(/\/$/, "")}/workspace`,
        });
        respondJson(res, { accepted: true, taskId: job.taskId, messageId, status: job.state }, 202);
        return;
      }
      if (req.method === "GET" && requestUrl.pathname.startsWith("/workspace/")) {
        const workspace = await ensureWorkerWorkspace(env);
        const workspacePath = requestUrl.pathname.slice("/workspace".length);
        await serveStatic(req, res, workspace, workspacePath);
        return;
      }
      if (req.method === "GET" || req.method === "HEAD") {
        await serveStatic(req, res, publicDir);
        return;
      }
      respondJson(res, { ok: false, error: "Not found." }, 404);
    } catch (error) {
      respondJson(res, { ok: false, error: error.message }, error.statusCode || 400);
    }
  });
}

export {
  agentCard,
  appendWorkspaceLinks,
  createHarnessRunner,
  createWorkerServer,
  ensureWorkerWorkspace,
  messageText,
  postCallback,
};
