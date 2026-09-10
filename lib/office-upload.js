import fs from "node:fs/promises";

const MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 120_000;

function officeHttpUrl(env = process.env) {
  const configured = String(env.AI_HARNESS_OFFICE_HTTP_URL || env.AI_HARNESS_OFFICE_URL || "").trim();
  if (!configured) throw new Error("AI_HARNESS_OFFICE_URL is required to upload workspace artifacts.");
  const url = new URL(configured);
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("The Office upload URL must be credential-free HTTP(S) or WS(S).");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function officeUploadUrl(env, name) {
  const url = new URL("/api/workspace-upload", officeHttpUrl(env));
  url.searchParams.set("workspace", String(env.AI_HARNESS_OFFICE_UPLOAD_WORKSPACE || ".").trim() || ".");
  url.searchParams.set("name", name);
  return url;
}

function officeFileUrl(env, workspace, relativePath) {
  const url = new URL("/api/workspace-file-asset", officeHttpUrl(env));
  url.searchParams.set("workspace", workspace);
  url.searchParams.set("path", relativePath);
  return url.href;
}

async function uploadOfficeFile({
  name,
  content,
  mimeType,
  taskId,
  messageId,
  env = process.env,
  fetchImpl = fetch,
  signal,
}) {
  const workspace = String(env.AI_HARNESS_OFFICE_UPLOAD_WORKSPACE || ".").trim() || ".";
  const token = String(env.AI_HARNESS_WORKER_TOKEN || "").trim();
  if (!token) throw new Error("AI_HARNESS_WORKER_TOKEN is required to upload workspace artifacts.");
  const configuredTimeout = Number(env.WORKER_UPLOAD_TIMEOUT_MS);
  const timeoutMs = Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_UPLOAD_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(officeUploadUrl(env, name), {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": mimeType,
      "content-length": String(content.length),
      "x-agent-name": String(env.WORKER_NAME || "Coding Worker Agent").trim(),
      ...(taskId ? { "x-office-task-id": taskId } : {}),
      ...(messageId ? { "x-office-message-id": messageId } : {}),
    },
    body: content,
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
  });
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("Office upload response exceeds 1 MiB.");
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`Office returned invalid JSON for artifact upload (HTTP ${response.status}).`); }
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Office artifact upload failed (HTTP ${response.status}).`);
  }
  const relativePath = String(payload.relativePath || name);
  return {
    name,
    size: Number(payload.size) || content.length,
    uri: String(payload.uri || officeFileUrl(env, workspace, relativePath)),
  };
}

async function uploadWorkspaceZip({ archivePath, taskId, ...options }) {
  return uploadOfficeFile({
    ...options,
    taskId,
    name: `${taskId}.zip`,
    content: await fs.readFile(archivePath),
    mimeType: "application/zip",
  });
}

async function uploadConnectivityTest({ connectionId, env = process.env, ...options }) {
  return uploadOfficeFile({
    ...options,
    env,
    name: "test.md",
    mimeType: "text/markdown; charset=utf-8",
    content: Buffer.from([
      "# Worker connectivity test",
      "",
      `Worker: ${env.WORKER_NAME || "Coding Worker Agent"}`,
      `Connection: ${connectionId}`,
      `Joined at: ${new Date().toISOString()}`,
      "",
      "This file verifies that the worker can upload files to the Office.",
      "",
    ].join("\n")),
  });
}

export { officeFileUrl, officeHttpUrl, officeUploadUrl, uploadConnectivityTest, uploadWorkspaceZip };
