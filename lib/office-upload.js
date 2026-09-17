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

function officeFileUrl(env, projectId, relativePath) {
  const url = new URL("/api/workspace-file-asset", officeHttpUrl(env));
  url.searchParams.set("projectId", projectId);
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
  projectId = env.AI_HARNESS_OFFICE_PROJECT_ID || "central-office",
  fetchImpl = fetch,
  signal,
}) {
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
    uri: String(payload.uri || officeFileUrl(env, projectId, relativePath)),
  };
}

async function uploadTaskArtifact({ archivePath, taskId, artifactUpload, env = process.env, fetchImpl = fetch, signal }) {
  const office = officeHttpUrl(env);
  let url;
  try { url = new URL(artifactUpload.url, office); } catch { throw new Error('Invalid assignment artifact upload URL.'); }
  if (url.origin !== office.origin || url.username || url.password || url.hash
    || url.pathname !== '/api/worker-artifacts' || url.searchParams.getAll('taskId').length !== 1
    || url.searchParams.get('taskId') !== taskId) {
    throw new Error('Assignment artifact upload URL must belong to this Office and task.');
  }
  const token = artifactUpload.token;
  if (typeof token !== 'string' || !token || /\s/.test(token)) throw new Error('Assignment artifact upload token is missing or invalid.');
  if (artifactUpload.method !== 'POST' || artifactUpload.contentType !== 'application/octet-stream') {
    throw new Error('Unsupported assignment artifact upload method or content type.');
  }
  const name = `${taskId}.zip`;
  url.searchParams.set('name', name);
  const configuredTimeout = Number(env.WORKER_UPLOAD_TIMEOUT_MS);
  const timeout = AbortSignal.timeout(Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout : DEFAULT_UPLOAD_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  requestSignal.throwIfAborted();
  const content = await fs.readFile(archivePath);
  if (content.length > 100 * 1024 * 1024) throw new Error('Artifact exceeds the 100 MB upload limit.');
  let response;
  try {
    response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: requestSignal,
      headers: { accept: 'application/json', authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream', 'content-length': String(content.length) },
      body: content });
  } catch {
    throw new Error(requestSignal.aborted ? 'Assignment artifact upload cancelled or timed out.' : 'Assignment artifact upload request failed.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Assignment artifact upload failed (HTTP ${response.status}).`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Office returned an empty artifact upload response.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error(); }
      chunks.push(Buffer.from(value));
    }
  } catch { throw new Error('Unable to read Office artifact upload response within limits.'); }
  finally { reader.releaseLock(); }
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Office returned invalid JSON for artifact upload.'); }
  if (payload?.ok !== true || typeof payload.artifactId !== 'string' || !/^artifact-[A-Za-z0-9-]+$/.test(payload.artifactId)) {
    throw new Error('Office artifact upload response is missing a valid artifact ID.');
  }
  requestSignal.throwIfAborted();
  return { name, size: content.length, artifactId: payload.artifactId };
}

async function uploadWorkspaceZip({ archivePath, taskId, artifactUpload, ...options }) {
  if (artifactUpload !== undefined) {
    if (!artifactUpload || typeof artifactUpload !== 'object' || Array.isArray(artifactUpload)) throw new Error('Invalid assignment artifact upload configuration.');
    return uploadTaskArtifact({ archivePath, taskId, artifactUpload, ...options });
  }
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
