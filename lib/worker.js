import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CodingAgent } from "./agent.js";
import { environmentSystemPrompts } from "./env-config.js";
import { loadMcpTools } from "./mcp.js";
import { createOfficeConnection } from "./office-connection.js";
import { uploadConnectivityTest, uploadWorkspaceZip } from "./office-upload.js";
import { createModelClient } from "./openai.js";
import { providerConfiguration } from "./provider-config.js";
import { respondJson, serveStatic } from "./response.js";
import { createTaskStore } from "./task-store.js";
import { createTools } from "./tools/index.js";
import { createWorkspaceZip } from "./zip-workspace.js";
import { listWorkspace, readWorkspaceText } from "./workspace-browser.js";

const MAX_MESSAGE_BYTES = 1_000_000;
const BROWSER_MODULES = new Map([
  ["/vendor/marked.mjs", fileURLToPath(import.meta.resolve("marked"))],
  ["/vendor/dompurify.mjs", fileURLToPath(import.meta.resolve("dompurify"))],
]);

function allowedControlOrigin(origin, requestUrl, publicUrl) {
  if (!origin) return true; // Non-browser clients need not send Origin.
  if (origin === "null") return false;
  const allowed = new Set([requestUrl.origin]);
  // TLS commonly terminates at a reverse proxy while Host remains public.
  // Do not trust arbitrary X-Forwarded-Host values as additional origins.
  const secureOrigin = new URL(requestUrl.origin);
  secureOrigin.protocol = "https:";
  allowed.add(secureOrigin.origin);
  if (publicUrl) {
    try {
      const advertised = new URL(publicUrl);
      if (["http:", "https:"].includes(advertised.protocol) && !advertised.username && !advertised.password) {
        allowed.add(advertised.origin);
      }
    } catch { /* Invalid public configuration does not authorize another origin. */ }
  }
  return allowed.has(origin);
}
const DEFAULT_TOOLS = [
  "list_files", "read_file", "write_file", "search_files", "curl", "run_command",
  "read_office_context", "list_teammates", "ask_teammate",
];
const AGENT_SKILLS = [{
  id: "coding-task",
  name: "Coding Task",
  description: "Inspect, modify, and validate a software workspace.",
}];
const DEFAULT_PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

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

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanSetting(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  if (/^(?:1|true|yes|on)$/i.test(String(value).trim())) return true;
  if (/^(?:0|false|no|off)$/i.test(String(value).trim())) return false;
  throw new Error(`Expected a boolean setting, received ${JSON.stringify(value)}.`);
}

function configuredTools(env = process.env) {
  if (!Object.hasOwn(env, "WORKER_TOOLS")) return DEFAULT_TOOLS;
  return String(env.WORKER_TOOLS).split(",").map((name) => name.trim()).filter(Boolean);
}

function configuredSkills(env = process.env) {
  if (!String(env.WORKER_SKILLS || "").trim()) return AGENT_SKILLS;
  let skills;
  try { skills = JSON.parse(env.WORKER_SKILLS); } catch {
    throw new Error("WORKER_SKILLS must be a JSON array.");
  }
  if (!Array.isArray(skills)) throw new Error("WORKER_SKILLS must be a JSON array.");
  return skills.map((skill, index) => {
    if (!skill || typeof skill !== "object" || Array.isArray(skill)) {
      throw new Error(`WORKER_SKILLS entry ${index + 1} must be an object.`);
    }
    const normalized = {
      id: String(skill.id || "").trim(),
      name: String(skill.name || "").trim(),
      description: String(skill.description || "").trim(),
    };
    if (!normalized.id || !normalized.name || !normalized.description) {
      throw new Error(`WORKER_SKILLS entry ${index + 1} requires id, name, and description.`);
    }
    return normalized;
  });
}

async function ensureWorkerWorkspace(env = process.env, baseDir = process.cwd()) {
  const configuredPath = String(env.WORKER_WORKSPACE || ".workspace").trim() || ".workspace";
  const workspace = path.resolve(baseDir, configuredPath);
  await fs.mkdir(workspace, { recursive: true });
  return fs.realpath(workspace);
}

async function ensureTaskWorkspace(env, taskId) {
  const root = await ensureWorkerWorkspace(env);
  const workspace = path.join(root, taskId);
  await fs.mkdir(workspace, { recursive: false });
  return workspace;
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

function workspaceArtifact(job) {
  if (!job.upload || !job.archive) return null;
  const name = `${job.taskId}.zip`;
  return {
    artifactId: `workspace-${job.taskId}`,
    name,
    parts: [{ kind: "file", file: { name, mimeType: "application/zip", uri: job.upload.uri } }],
    metadata: { fileCount: job.archive.fileCount, size: job.upload.size },
  };
}

function resultMessage(job, state, text, error) {
  const artifact = state === "completed" ? workspaceArtifact(job) : null;
  return {
    type: "task_update",
    taskId: job.taskId,
    inReplyTo: job.messageId,
    status: { state },
    message: {
      messageId: `${state}-${crypto.randomUUID()}`,
      role: "agent",
      parts: [{ kind: "text", mimeType: "text/markdown", text }],
    },
    ...(artifact ? { artifacts: [artifact] } : {}),
    ...(error ? { error } : {}),
  };
}

function directMessageResponse(messageId, text) {
  return {
    type: "direct_message_response",
    inReplyTo: messageId,
    message: {
      messageId: `reply-${crypto.randomUUID()}`,
      role: "agent",
      parts: [{ kind: "text", mimeType: "text/plain", text: String(text).trim() }],
    },
  };
}

function stopTaskCommand(text) {
  let command = String(text || "")
    .replace(/(^|\s)@[a-z0-9][a-z0-9-]*\b/gi, " ")
    .trim()
    .replace(/[?.!]+$/, "")
    .trim();
  command = command
    .replace(/^(?:can|could|would|will)\s+you\s+/i, "")
    .replace(/^please\s+/i, "");
  const match = command.match(/^(?:stop|cancel|abort)\b\s*(.*)$/i);
  if (!match) return null;
  let target = match[1].trim().replace(/^(?:the|this)\s+/i, "");
  if (!target || /^(?:current|active|ongoing)(?:\s+(?:task|job))?$/i.test(target)) {
    return { mode: "current" };
  }
  if (/^(?:all|every|everything|all\s+(?:tasks|jobs)|(?:active|ongoing)\s+(?:tasks|jobs))$/i.test(target)) {
    return { mode: "all" };
  }
  target = target.replace(/^(?:task|job)\s+/i, "").trim();
  return target ? { mode: "id", target } : { mode: "current" };
}

function createTaskExecutionControl() {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    stop(reason) {
      if (controller.signal.aborted) return false;
      controller.abort(new Error(reason));
      return true;
    },
    async waitIfPaused() {
      if (controller.signal.aborted) throw controller.signal.reason;
    },
  };
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
  const workerRoot = await ensureWorkerWorkspace(env);
  const provider = providerConfiguration(env);
  const approval = async () => true;
  const allowedNames = new Set(configuredTools(env));
  return async function runTask(prompt, { resourceBaseUrl = "", workspace = workerRoot, executionControl } = {}) {
    const root = await fs.realpath(workspace);
    const relative = path.relative(workerRoot, root);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Task workspace must be a subdirectory of the worker workspace.");
    }
    const localTools = createTools({ root, approve: approval, env }).filter((tool) => allowedNames.has(tool.name));
    const mcpTools = await loadMcpTools({ root, env, approve: approval, autoApprove: true, onInfo });
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
        if (event.type === "tool_result" && ["write_file", "generate_image"].includes(event.name) && event.output?.ok) {
          createdPaths.add(event.output.path);
        }
      },
    });
    const markdown = await agent.run(prompt, { disabledSteps: ["composer"], executionControl });
    return appendWorkspaceLinks(markdown, [...createdPaths], resourceBaseUrl);
  };
}

function workerPublicUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("WORKER_PUBLIC_URL must be a credential-free HTTP(S) URL.");
  }
  if (url.search) throw new Error("WORKER_PUBLIC_URL must not contain query parameters.");
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

function workerWebSocketUrl(baseUrl) {
  const url = new URL(workerPublicUrl(baseUrl));
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/agent`;
  return url.href;
}

function agentInfo(baseUrl, env = process.env) {
  const provider = providerConfiguration(env);
  const name = String(env.WORKER_NAME || "Coding Worker Agent").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,99}$/.test(name)) {
    throw new Error("WORKER_NAME must start with an alphanumeric character and contain only letters, numbers, spaces, underscores, or hyphens (100 characters maximum).");
  }
  return {
    name,
    description: env.WORKER_DESCRIPTION || "Completes coding tasks in its configured workspace.",
    url: workerWebSocketUrl(baseUrl),
    capabilities: {
      skills: configuredSkills(env),
      tools: configuredTools(env),
      mcp: Boolean(env.AI_HARNESS_MCP_SERVERS),
      workspaceArtifacts: true,
    },
    model: {
      provider: provider.name,
      name: provider.model,
      url: diagnosticUrl(provider.url),
    },
  };
}

function agentCard(baseUrl, env = process.env) {
  const info = agentInfo(baseUrl, env);
  return { name: info.name, description: info.description, url: info.url, skills: info.capabilities.skills };
}

function publicJob(job, includeResult = false) {
  return {
    taskId: job.taskId,
    messageId: job.messageId,
    state: job.state,
    source: job.internal ? "repl" : "office",
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    error: job.error || null,
    errorDetails: job.errorDetails || null,
    deliveryError: job.deliveryError || null,
    workspace: job.workspace ? path.basename(job.workspace) : null,
    archive: job.archive || null,
    upload: job.upload || null,
    ...(includeResult && job.result ? { result: job.result } : {}),
  };
}

function createWorkerServer({
  env = process.env,
  runTask,
  onInfo = console.error,
  publicDir = DEFAULT_PUBLIC_DIR,
  taskStore,
  officeConnectionFactory = createOfficeConnection,
  uploadWorkspace = uploadWorkspaceZip,
  fetchImpl = fetch,
  WebSocketImpl,
} = {}) {
  const ownsTaskStore = !taskStore;
  const store = taskStore || createTaskStore({ env });
  const tasks = new Map();
  let officeConnection = null;
  let officeEnabled = Boolean(String(env.AI_HARNESS_OFFICE_URL || "").trim());
  let officeGeneration = 0;
  let orchestration = { status: "disabled", endpoint: null, connectionId: null };
  let testedConnectionId = null;
  const connectivityAbort = new AbortController();

  function recordMessage(direction, source, payload, deliveryState) {
    const parts = payload.message?.parts || [];
    const text = parts.map(part => part.text || (part.file ? `[File: ${part.file.name || "attachment"}]` : "")).filter(Boolean).join("\n");
    store.recordMessage({ direction, source, text, type: payload.type || "task",
      taskId: payload.taskId || null, messageId: payload.message?.messageId || payload.inReplyTo || null,
      state: deliveryState || payload.status?.state || null });
  }

  function trackedSend(send) {
    return (payload) => {
      try { send(payload); }
      catch (error) { recordMessage("outgoing", "office", payload, "delivery failed"); throw error; }
      recordMessage("outgoing", "office", payload);
    };
  }

  function persist(job) {
    store.save(publicJob(job, true));
  }

  for (const storedTask of store.listIncomplete()) {
    const job = { ...storedTask, internal: storedTask.source === "repl" };
    const error = new Error("Worker restarted before this task completed.");
    job.state = "failed";
    job.error = error.message;
    job.errorDetails = serializeError(error);
    job.finishedAt = new Date().toISOString();
    job.result = resultMessage(job, "failed", `Task failed: ${error.message}`, {
      code: "TASK_INTERRUPTED", message: error.message, details: job.errorDetails,
    });
    persist(job);
  }

  let runnerPromise;
  const runner = async (text, context) => {
    runnerPromise ||= runTask ? Promise.resolve(runTask) : createHarnessRunner({ env, onInfo });
    return (await runnerPromise)(text, context);
  };
  const queue = createTaskQueue({
    concurrency: positiveInteger(env.WORKER_CONCURRENCY, 1),
    async run(job) {
      if (job.connectionClosed || job.stopped) return;
      job.state = "working";
      job.startedAt = new Date().toISOString();
      persist(job);
      if (!job.internal) {
        try {
          job.sendUpdate(resultMessage(job, "working", "Task accepted; work is starting."));
        } catch (error) {
          job.deliveryError = error.message;
          persist(job);
          return;
        }
      }
      let resultPayload;
      try {
        if (job.stopped) return;
        job.workspace = await ensureTaskWorkspace(env, job.taskId);
        persist(job);
        const text = await runner(job.text, {
          resourceBaseUrl: job.resourceBaseUrl,
          workspace: job.workspace,
          executionControl: job.executionControl,
          signal: job.executionControl.signal,
        });
        if (job.connectionClosed || job.stopped) return;
        await fs.writeFile(path.join(job.workspace, "output.md"), text, "utf8");
        const archivePath = `${job.workspace}.zip`;
        job.archive = await createWorkspaceZip(job.workspace, archivePath);
        if (!job.internal) {
          job.upload = await uploadWorkspace({
            archivePath,
            taskId: job.taskId,
            messageId: job.messageId,
            env,
            fetchImpl,
            signal: job.executionControl.signal,
          });
        }
        job.state = "completed";
        resultPayload = resultMessage(job, "completed", text);
      } catch (error) {
        if (job.connectionClosed || job.stopped) return;
        job.state = "failed";
        job.error = error.message;
        job.errorDetails = serializeError(error);
        resultPayload = resultMessage(job, "failed", `Task failed: ${error.message}`, {
          code: "TASK_FAILED", message: error.message, details: job.errorDetails,
        });
      }
      job.result = resultPayload;
      job.finishedAt = new Date().toISOString();
      persist(job);
      if (job.internal) { recordMessage("outgoing", "repl", resultPayload); return; }
      try {
        job.sendUpdate(resultPayload);
      } catch (deliveryError) {
        job.deliveryError = deliveryError.message;
        persist(job);
        onInfo(`Task update delivery failed for ${job.taskId}: ${deliveryError.message}`);
      }
    },
  });
  const directQueue = createTaskQueue({
    concurrency: positiveInteger(env.WORKER_DIRECT_MESSAGE_CONCURRENCY, 2),
    async run(message) {
      let workspace;
      let responseText;
      try {
        const workspaceRoot = await ensureWorkerWorkspace(env);
        workspace = path.join(workspaceRoot, `.direct-${crypto.randomUUID()}`);
        await fs.mkdir(workspace, { recursive: false });
        responseText = await runner(message.text, { resourceBaseUrl: "", workspace });
        if (!String(responseText || "").trim()) throw new Error("The agent returned an empty response.");
      } catch (error) {
        responseText = `Unable to answer: ${error.message}`;
      } finally {
        try { if (workspace) await fs.rm(workspace, { recursive: true, force: true }); } catch (error) {
          onInfo(`Unable to clean direct-message workspace: ${error.message}`);
        }
      }
      try {
        message.sendResponse(directMessageResponse(message.messageId, responseText));
      } catch (error) {
        onInfo(`Direct message response delivery failed for ${message.messageId}: ${error.message}`);
      }
    },
  });

  function enqueue({ taskId = crypto.randomUUID(), messageId, text, internal = false, resourceBaseUrl, connectionId = null, sendUpdate = null }) {
    if (internal) recordMessage("incoming", "repl", { taskId, message: { messageId, parts: [{ text }] } });
    const job = {
      taskId,
      messageId,
      text,
      internal,
      state: "submitted",
      connectionId,
      sendUpdate,
      createdAt: new Date().toISOString(),
      resourceBaseUrl: `${String(resourceBaseUrl).replace(/\/$/, "")}/${taskId}`,
      executionControl: createTaskExecutionControl(),
    };
    tasks.set(job.taskId, job);
    persist(job);
    queue.add(job);
    return job;
  }

  function disconnectConnection(connectionId, reason) {
    for (const job of tasks.values()) {
      if (job.connectionId !== connectionId || ["completed", "failed"].includes(job.state)) continue;
      const error = new Error(reason || "Office connection closed before the task completed.");
      job.connectionClosed = true;
      job.executionControl?.stop(error.message);
      job.state = "failed";
      job.error = error.message;
      job.errorDetails = serializeError(error);
      job.finishedAt = new Date().toISOString();
      job.result = resultMessage(job, "failed", `Task failed: ${error.message}`, { message: error.message });
      persist(job);
    }
  }

  function stopJob(job, reason = "Stopped by an Office message.") {
    if (!job || !["submitted", "working"].includes(job.state) || job.stopped) return false;
    job.stopped = true;
    job.executionControl?.stop(reason);
    job.state = "failed";
    job.error = reason;
    job.errorDetails = { name: "TaskStoppedError", message: reason };
    job.finishedAt = new Date().toISOString();
    job.result = resultMessage(job, "failed", `Task stopped: ${reason}`, {
      code: "TASK_STOPPED", message: reason,
    });
    persist(job);
    if (!job.internal) {
      try { job.sendUpdate(job.result); } catch (error) {
        job.deliveryError = error.message;
        persist(job);
        onInfo(`Stopped-task update delivery failed for ${job.taskId}: ${error.message}`);
      }
    }
    return true;
  }

  function handleStopCommand(text, connectionId, excludedTaskId = null) {
    const command = stopTaskCommand(text);
    if (!command) return null;
    const candidates = [...tasks.values()].filter((job) => (
      job.taskId !== excludedTaskId && job.connectionId === connectionId && !job.internal &&
      ["submitted", "working"].includes(job.state) && !job.stopped
    ));
    let selected = [];
    if (command.mode === "all") selected = candidates;
    else if (command.mode === "id") {
      selected = candidates.filter((job) => [job.taskId, job.messageId].includes(command.target));
      if (selected.length === 0) return `No active task matches ${command.target}.`;
    } else if (candidates.length === 1) selected = candidates;
    else if (candidates.length === 0) return "There are no active tasks to stop.";
    else return `More than one task is active. Specify a task ID or say “stop all tasks”: ${candidates.map((job) => job.taskId).join(", ")}.`;
    if (selected.length === 0) return "There are no active tasks to stop.";
    selected.forEach((job) => stopJob(job));
    return selected.length === 1
      ? `Stopped task ${selected[0].taskId}.`
      : `Stopped ${selected.length} tasks: ${selected.map((job) => job.taskId).join(", ")}.`;
  }

  function completeControlTask({ taskId, messageId, text, connectionId, sendUpdate }) {
    const job = {
      taskId, messageId, text, connectionId, sendUpdate, internal: false,
      state: "working", createdAt: new Date().toISOString(), startedAt: new Date().toISOString(),
      executionControl: createTaskExecutionControl(), resourceBaseUrl: "",
    };
    tasks.set(taskId, job);
    persist(job);
    sendUpdate(resultMessage(job, "working", "Stop request accepted."));
    const resultText = handleStopCommand(text, connectionId, taskId);
    job.state = "completed";
    job.finishedAt = new Date().toISOString();
    job.result = resultMessage(job, "completed", resultText);
    persist(job);
    sendUpdate(job.result);
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
        taskDatabase: store.path,
      },
      orchestration: { ...orchestration, configured: Boolean(String(env.AI_HARNESS_OFFICE_URL || "").trim()), enabled: officeEnabled },
      queue: { ...queue.stats(), directMessages: directQueue.stats() },
      tasks: store.listRecent(50),
    };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (req.method === "GET" && BROWSER_MODULES.has(requestUrl.pathname)) {
        const modulePath = BROWSER_MODULES.get(requestUrl.pathname);
        await serveStatic(req, res, path.dirname(modulePath), `/${path.basename(modulePath)}`);
        return;
      }
      if (req.method === "GET" && requestUrl.pathname === "/health") {
        respondJson(res, { ok: true, orchestration: orchestration.status, ...queue.stats() });
        return;
      }
      if (req.method === "GET" && requestUrl.pathname === "/api/status") {
        respondJson(res, status());
        return;
      }
      if (req.method === "GET" && requestUrl.pathname === "/api/info") {
        respondJson(res, agentInfo(env.WORKER_PUBLIC_URL || requestUrl.origin, env));
        return;
      }
      if (req.method === "GET" && requestUrl.pathname === "/api/messages") {
        const before = Number(requestUrl.searchParams.get("before") || 0);
        const after = Number(requestUrl.searchParams.get("after") || 0);
        if (![before, after].every(value => Number.isSafeInteger(value) && value >= 0) || (before && after)) {
          throw new Error("Invalid message cursor.");
        }
        respondJson(res, { ok: true, ...store.listMessages({ before, after }) });
        return;
      }
      if (req.method === "GET" && requestUrl.pathname === "/api/workspace") {
        respondJson(res, await listWorkspace(await ensureWorkerWorkspace(env), requestUrl.searchParams.get("path") || ""));
        return;
      }
      if (req.method === "GET" && requestUrl.pathname === "/api/workspace/file") {
        respondJson(res, await readWorkspaceText(await ensureWorkerWorkspace(env), requestUrl.searchParams.get("path") || ""));
        return;
      }
      if (req.method === "POST" && requestUrl.pathname === "/api/office/connection") {
        if (!allowedControlOrigin(req.headers.origin, requestUrl, env.WORKER_PUBLIC_URL)) {
          respondJson(res, { ok: false, error: "Cross-origin connection changes are not allowed." }, 403);
          return;
        }
        const { action } = await readJson(req, 1024);
        if (!["connect", "disconnect"].includes(action)) throw new Error("action must be connect or disconnect.");
        if (action === "connect") {
          if (!String(env.AI_HARNESS_OFFICE_URL || "").trim()) throw new Error("Office URL is not configured.");
          if (!officeEnabled || !officeConnection) startOffice();
          if (orchestration.status === "configuration_error") throw new Error(orchestration.error);
        } else {
          officeEnabled = false;
          officeGeneration += 1;
          const connectionId = orchestration.connectionId;
          officeConnection?.stop();
          officeConnection = null;
          if (connectionId) disconnectConnection(connectionId, "Disconnected from Office by user.");
          orchestration = { ...orchestration, status: "stopped", connectionId: null };
        }
        respondJson(res, { ok: true, orchestration: status().orchestration });
        return;
      }
      if (req.method === "GET" && requestUrl.pathname.startsWith("/api/tasks/")) {
        const taskId = decodeURIComponent(requestUrl.pathname.slice("/api/tasks/".length));
        const job = tasks.get(taskId);
        const task = job ? publicJob(job, true) : store.findByTaskId(taskId);
        if (!task) respondJson(res, { ok: false, error: "Task not found." }, 404);
        else respondJson(res, { ok: true, task });
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
      if (req.method === "GET" && requestUrl.pathname.startsWith("/workspace/")) {
        const workspace = await ensureWorkerWorkspace(env);
        const workspacePath = requestUrl.pathname.slice("/workspace".length);
        // Generated HTML/SVG must not execute with the console's origin privileges.
        res.setHeader("Content-Security-Policy", "sandbox; default-src 'self' data: blob: https:; script-src 'none'; style-src 'self' 'unsafe-inline' https:");
        res.setHeader("X-Content-Type-Options", "nosniff");
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

  function startOffice() {
    const officeUrl = String(env.AI_HARNESS_OFFICE_URL || "").trim();
    if (!officeUrl) return;
    officeEnabled = true;
    const generation = ++officeGeneration;
    officeConnection?.stop();
    officeConnection = null;
    testedConnectionId = null;
    const address = server.address();
    const advertisedHost = typeof address === "object" && address
      ? (["0.0.0.0", "::"].includes(address.address) ? "127.0.0.1" : address.address)
      : "127.0.0.1";
    const localBaseUrl = typeof address === "object" && address
      ? `http://${advertisedHost.includes(":") ? `[${advertisedHost}]` : advertisedHost}:${address.port}`
      : "http://127.0.0.1";
    try {
      const publicBaseUrl = workerPublicUrl(env.WORKER_PUBLIC_URL || localBaseUrl);
      officeConnection = officeConnectionFactory({
        url: officeUrl,
        token: env.AI_HARNESS_WORKER_TOKEN,
        worker: agentInfo(publicBaseUrl, env),
        WebSocketImpl,
        tlsRejectUnauthorized: booleanSetting(env.AI_HARNESS_OFFICE_TLS_REJECT_UNAUTHORIZED, true),
        reconnectMinMs: positiveInteger(env.WORKER_RECONNECT_MIN_MS, 1_000),
        reconnectMaxMs: positiveInteger(env.WORKER_RECONNECT_MAX_MS, 30_000),
        heartbeatMs: positiveInteger(env.WORKER_HEARTBEAT_MS, 30_000),
        onInfo,
        onStatus(next) {
          if (generation !== officeGeneration) return;
          orchestration = next;
          if (["replaced", "stopped"].includes(next.status)) officeEnabled = false;
          if (next.status !== "connected" || !next.connectionId || next.connectionId === testedConnectionId) return;
          testedConnectionId = next.connectionId;
          void uploadConnectivityTest({
            connectionId: next.connectionId, env, fetchImpl, signal: connectivityAbort.signal,
          }).then(
            (file) => onInfo(`Office connectivity test succeeded: uploaded test.md (${file.uri}).`),
            (error) => onInfo(`Office connectivity test failed: ${error.message}`),
          );
        },
        onDisconnect: disconnectConnection,
        onDirectMessage(payload, transport) {
          recordMessage("incoming", "office", payload);
          const send = trackedSend(transport.send);
          const { messageId, text } = messageText(payload.message);
          const stopResult = handleStopCommand(text, transport.connectionId);
          if (stopResult) {
            send(directMessageResponse(messageId, stopResult));
            return;
          }
          directQueue.add({ messageId, text, sendResponse: send });
        },
        onTask(payload, transport) {
          recordMessage("incoming", "office", payload);
          const send = trackedSend(transport.send);
          const taskId = String(payload.taskId || "").trim();
          if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(taskId)) {
            throw new Error("taskId is required and may contain only letters, numbers, underscores, or hyphens.");
          }
          if (tasks.has(taskId)) throw new Error(`Duplicate taskId: ${taskId}`);
          const { messageId, text } = messageText(payload.message);
          if (stopTaskCommand(text)) {
            completeControlTask({
              taskId, messageId, text, connectionId: transport.connectionId, sendUpdate: send,
            });
            return;
          }
          enqueue({
            taskId,
            messageId,
            text,
            connectionId: transport.connectionId,
            sendUpdate: send,
            resourceBaseUrl: `${publicBaseUrl}/workspace`,
          });
        },
      });
      officeConnection.start();
    } catch (error) {
      officeEnabled = false;
      officeConnection = null;
      orchestration = { status: "configuration_error", endpoint: officeUrl, connectionId: null, error: error.message };
      onInfo(`Office registration disabled: ${error.message}`);
    }
  }
  server.on("listening", startOffice);

  server.on("close", () => {
    connectivityAbort.abort();
    officeConnection?.stop();
    if (ownsTaskStore) store.close();
  });
  return server;
}

export {
  agentCard,
  agentInfo,
  appendWorkspaceLinks,
  createHarnessRunner,
  createWorkerServer,
  ensureWorkerWorkspace,
  directMessageResponse,
  messageText,
  stopTaskCommand,
  workerPublicUrl,
  workerWebSocketUrl,
};
