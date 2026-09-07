import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendWorkspaceLinks, createWorkerServer, postCallback } from "../lib/worker.js";

async function listeningServer(options) {
  const temporaryWorkspace = options?.env?.WORKER_WORKSPACE
    ? null
    : await fs.mkdtemp(path.join(os.tmpdir(), "agent-worker-workspace-"));
  const server = createWorkerServer({
    ...options,
    env: {
      ...options?.env,
      WORKER_WORKSPACE: options?.env?.WORKER_WORKSPACE || temporaryWorkspace,
      WORKER_TASK_DB: options?.env?.WORKER_TASK_DB || ":memory:",
    },
  });
  if (temporaryWorkspace) server.on("close", () => fs.rm(temporaryWorkspace, { recursive: true, force: true }));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}` };
}

test("accepts a message and sends its result to the callback", async (t) => {
  let resolveCallback;
  const callbackReceived = new Promise((resolve) => { resolveCallback = resolve; });
  const callbackFetch = async (url, request) => {
    resolveCallback({ url, request });
    return new Response(null, { status: 204 });
  };
  let taskWorkspace;
  const { server, url } = await listeningServer({
    runTask: async (prompt, context) => {
      taskWorkspace = context.workspace;
      await fs.writeFile(path.join(context.workspace, "result.txt"), "handoff contents", "utf8");
      return `finished: ${prompt}`;
    },
    callbackFetch,
  });
  t.after(() => server.close());

  const response = await fetch(`${url}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: { messageId: "msg-001", role: "user", parts: [{ kind: "text", text: "Do the work" }] },
      callback: { url: "https://orchestrator.example/callback", token: "secret" },
    }),
  });

  assert.equal(response.status, 202);
  const accepted = await response.json();
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.messageId, "msg-001");

  const delivered = await callbackReceived;
  assert.equal(delivered.url, "https://orchestrator.example/callback");
  assert.equal(delivered.request.headers.authorization, "Bearer secret");
  const result = JSON.parse(delivered.request.body);
  assert.equal(result.inReplyTo, "msg-001");
  assert.equal(result.status.state, "completed");
  assert.equal(result.message.parts[0].mimeType, "text/markdown");
  assert.equal(result.message.parts[0].text, "finished: Do the work");
  assert.equal(path.basename(taskWorkspace), result.taskId);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].artifactId, `workspace-${result.taskId}`);
  assert.equal(result.artifacts[0].parts[0].kind, "file");
  assert.equal(result.artifacts[0].parts[0].file.mimeType, "application/zip");
  assert.equal(result.artifacts[0].parts[0].file.uri, `${url}/workspace/${result.taskId}.zip`);
  assert.equal(result.artifacts[0].metadata.fileCount, 2);

  assert.equal(await fs.readFile(path.join(taskWorkspace, "output.md"), "utf8"), "finished: Do the work");

  const archiveResponse = await fetch(result.artifacts[0].parts[0].file.uri);
  assert.equal(archiveResponse.status, 200);
  assert.equal(archiveResponse.headers.get("content-type"), "application/zip");
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.equal(archive.includes(Buffer.from("result.txt")), true);
  assert.equal(archive.includes(Buffer.from("handoff contents")), true);
  assert.equal(archive.includes(Buffer.from("output.md")), true);
  assert.equal(archive.includes(Buffer.from("finished: Do the work")), true);
});

test("gives concurrent tasks different workspace subfolders", async (t) => {
  const workspaces = [];
  const callbacks = [];
  let resolveCallbacks;
  const callbacksReceived = new Promise((resolve) => { resolveCallbacks = resolve; });
  const { server, url } = await listeningServer({
    env: { WORKER_CONCURRENCY: "2" },
    runTask: async (_prompt, context) => {
      workspaces.push(context.workspace);
      await fs.writeFile(path.join(context.workspace, "output.txt"), path.basename(context.workspace));
      return "done";
    },
    callbackFetch: async (_callbackUrl, request) => {
      callbacks.push(JSON.parse(request.body));
      if (callbacks.length === 2) resolveCallbacks();
      return new Response(null, { status: 204 });
    },
  });
  t.after(() => server.close());

  await Promise.all(["isolated-1", "isolated-2"].map((messageId) => fetch(`${url}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: { messageId, parts: [{ kind: "text", text: "Run" }] },
      callback: { url: "https://orchestrator.example/callback" },
    }),
  })));
  await callbacksReceived;

  assert.equal(new Set(workspaces).size, 2);
  assert.equal(callbacks.every((result) => result.artifacts?.[0]?.parts?.[0]?.file?.uri.endsWith(`${result.taskId}.zip`)), true);
});

test("rejects malformed messages before queueing them", async (t) => {
  const { server, url } = await listeningServer({ runTask: async () => "unused" });
  t.after(() => server.close());
  const response = await fetch(`${url}/a2a`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: { messageId: "msg-002", parts: [] } }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /parts/);
});

test("reports agent failures through the callback", async (t) => {
  let resolveCallback;
  const callbackReceived = new Promise((resolve) => { resolveCallback = resolve; });
  const { server, url } = await listeningServer({
    runTask: async () => { throw new Error("model unavailable"); },
    callbackFetch: async (_url, request) => {
      resolveCallback(JSON.parse(request.body));
      return new Response(null, { status: 204 });
    },
  });
  t.after(() => server.close());

  const response = await fetch(`${url}/a2a`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: { messageId: "msg-failure", parts: [{ kind: "text", text: "Run" }] },
      callback: { url: "https://orchestrator.example/callback" },
    }),
  });
  assert.equal(response.status, 202);
  const result = await callbackReceived;
  assert.equal(result.status.state, "failed");
  assert.equal(result.error.code, "TASK_FAILED");
  assert.equal(result.error.details.name, "Error");
  assert.match(result.error.details.stack, /model unavailable/);
  assert.match(result.message.parts[0].text, /model unavailable/);
  assert.equal(result.artifacts[0].parts[0].file.mimeType, "application/zip");
  assert.equal(result.artifacts[0].metadata.fileCount, 0);
});

test("reports callback network diagnostics after retries are exhausted", async () => {
  const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9000"), {
    code: "ECONNREFUSED",
    address: "127.0.0.1",
    port: 9000,
  });
  const job = { callback: { url: "http://127.0.0.1:9000/callback", token: "secret" } };

  await assert.rejects(
    postCallback(job, { ok: true }, {
      retries: 2,
      timeoutMs: 100,
      async fetchImpl() { throw new TypeError("fetch failed", { cause }); },
    }),
    (error) => {
      assert.equal(error.details.request.method, "POST");
      assert.equal(error.details.request.url, "http://127.0.0.1:9000/callback");
      assert.equal(error.details.request.attempt, 2);
      assert.equal(error.details.response, null);
      assert.equal(error.details.cause.cause.code, "ECONNREFUSED");
      assert.match(error.stack, /CallbackRequestError/);
      return true;
    },
  );
});

test("reports callback HTTP response details", async () => {
  const job = { callback: { url: "https://orchestrator.example/callback", token: "secret" } };
  await assert.rejects(
    postCallback(job, { ok: true }, {
      retries: 1,
      async fetchImpl() {
        return new Response("gateway unavailable", { status: 502, statusText: "Bad Gateway" });
      },
    }),
    (error) => {
      assert.equal(error.details.response.status, 502);
      assert.equal(error.details.response.statusText, "Bad Gateway");
      assert.equal(error.details.response.body, "gateway unavailable");
      return true;
    },
  );
});

test("returns the discoverable agent card", async (t) => {
  const { server, url } = await listeningServer({ runTask: async () => "unused" });
  t.after(() => server.close());
  const response = await fetch(`${url}/.well-known/agent-card.json`);
  assert.equal(response.status, 200);
  const card = await response.json();
  assert.equal(card.url, `${url}/a2a`);
  assert.equal(card.skills[0].id, "coding-task");
});

test("serves the testing console and redacted agent status", async (t) => {
  const { server, url } = await listeningServer({
    env: {
      PROVIDER_NAME: "custom",
      PROVIDER_URL: "https://models.example/v1",
      PROVIDER_API_KEY: "do-not-expose",
      PROVIDER_MODEL: "test-model",
      WORKER_WORKSPACE: ".",
      WORKER_TOOLS: "read_file,search_files",
    },
    runTask: async () => "unused",
  });
  t.after(() => server.close());

  const pageResponse = await fetch(url);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get("content-type"), /text\/html/);
  const page = await pageResponse.text();
  assert.match(page, /Agent Worker Console/);
  assert.match(page, /<link rel="stylesheet" href="\/styles\.css">/);
  assert.match(page, /<script type="module" src="\/app\.mjs"><\/script>/);
  assert.match(page, /<agent-console-header><\/agent-console-header>/);
  assert.match(page, /<testing-repl><\/testing-repl>/);
  assert.match(page, /<recent-tasks-panel><\/recent-tasks-panel>/);
  assert.match(page, /<layout-resizer data-layout="dashboard"/);
  assert.match(page, /<body class="retro-pending">/);
  assert.doesNotMatch(page, /<style>|<script>/);

  const styleResponse = await fetch(`${url}/styles.css`);
  assert.equal(styleResponse.status, 200);
  assert.match(styleResponse.headers.get("content-type"), /text\/css/);

  const moduleResponse = await fetch(`${url}/app.mjs`);
  assert.equal(moduleResponse.status, 200);
  assert.match(moduleResponse.headers.get("content-type"), /text\/javascript/);
  const module = await moduleResponse.text();
  assert.match(module, /import "\.\/components\/index\.mjs"/);
  assert.match(module, /from "\.\/lib\/api\.mjs"/);

  const componentResponse = await fetch(`${url}/components/testing-repl.mjs`);
  assert.equal(componentResponse.status, 200);
  assert.match(componentResponse.headers.get("content-type"), /text\/javascript/);
  const component = await componentResponse.text();
  assert.match(component, /defineComponent\("testing-repl"/);
  assert.match(component, /data-panel-toggle/);

  const resizeResponse = await fetch(`${url}/lib/panel-resize.mjs`);
  assert.equal(resizeResponse.status, 200);
  assert.match(resizeResponse.headers.get("content-type"), /text\/javascript/);
  assert.match(await resizeResponse.text(), /agent-worker\.panel-layout\.v1/);

  const minimizeResponse = await fetch(`${url}/lib/panel-minimize.mjs`);
  assert.equal(minimizeResponse.status, 200);
  assert.match(minimizeResponse.headers.get("content-type"), /text\/javascript/);
  assert.match(await minimizeResponse.text(), /agent-worker\.minimized-panels\.v1/);

  const revealResponse = await fetch(`${url}/lib/retro-reveal.mjs`);
  assert.equal(revealResponse.status, 200);
  assert.match(revealResponse.headers.get("content-type"), /text\/javascript/);
  const revealModule = await revealResponse.text();
  assert.match(revealModule, /HEADING_STEP_MS = 72/);
  assert.match(revealModule, /textarea, button, \.panel-head, #health-text/);

  const statusResponse = await fetch(`${url}/api/status`);
  const status = await statusResponse.json();
  assert.equal(status.provider.name, "custom");
  assert.equal(status.provider.apiKeyConfigured, true);
  assert.equal(JSON.stringify(status).includes("do-not-expose"), false);
  assert.deepEqual(status.execution.tools, ["read_file", "search_files"]);
});

test("runs a REPL task and exposes its final status", async (t) => {
  const { server, url } = await listeningServer({ runTask: async (prompt) => `reply: ${prompt}` });
  t.after(() => server.close());

  const submitResponse = await fetch(`${url}/api/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "test the agent" }),
  });
  assert.equal(submitResponse.status, 202);
  const submitted = await submitResponse.json();

  let task;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const taskResponse = await fetch(`${url}/api/tasks/${submitted.taskId}`);
    task = (await taskResponse.json()).task;
    if (["completed", "failed"].includes(task.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(task.state, "completed");
  assert.equal(task.source, "repl");
  assert.equal(task.callbackDelivered, null);
  assert.equal(task.result.message.parts[0].text, "reply: test the agent");
  assert.equal(task.archive.fileCount, 1);
  const outputResponse = await fetch(`${url}/workspace/${submitted.taskId}/output.md`);
  assert.equal(outputResponse.status, 200);
  assert.equal(await outputResponse.text(), "reply: test the agent");
});

test("persists recent task history across worker restarts", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-worker-db-"));
  const databasePath = path.join(directory, "tasks.sqlite");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const first = await listeningServer({
    env: { WORKER_TASK_DB: databasePath },
    runTask: async (prompt) => `persisted: ${prompt}`,
  });
  const submitResponse = await fetch(`${first.url}/api/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "remember this task" }),
  });
  const submitted = await submitResponse.json();

  let task;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    task = (await (await fetch(`${first.url}/api/tasks/${submitted.taskId}`)).json()).task;
    if (task?.state === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(task.state, "completed");
  await new Promise((resolve, reject) => first.server.close((error) => error ? reject(error) : resolve()));

  const second = await listeningServer({
    env: { WORKER_TASK_DB: databasePath },
    runTask: async () => "unused",
  });
  t.after(() => second.server.close());
  const status = await (await fetch(`${second.url}/api/status`)).json();
  assert.equal(status.tasks[0].taskId, submitted.taskId);
  assert.equal(status.tasks[0].state, "completed");
  assert.equal(status.tasks[0].result.message.parts[0].text, "persisted: remember this task");

  const restored = await (await fetch(`${second.url}/api/tasks/${submitted.taskId}`)).json();
  assert.equal(restored.task.result.message.parts[0].text, "persisted: remember this task");
});

test("serves workspace resources over HTTP", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-worker-files-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, "reports"));
  await fs.writeFile(path.join(workspace, "reports", "result one.md"), "# Result\n", "utf8");
  const { server, url } = await listeningServer({
    env: { WORKER_WORKSPACE: workspace },
    runTask: async () => "unused",
  });
  t.after(() => server.close());

  const response = await fetch(`${url}/workspace/reports/result%20one.md`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/markdown/);
  assert.equal(await response.text(), "# Result\n");
});

test("appends percent-encoded HTTP links for created files", () => {
  const markdown = appendWorkspaceLinks(
    "Created the requested report.",
    ["reports/result one.md"],
    "https://worker.example/workspace",
  );
  assert.match(markdown, /### Created files/);
  assert.match(markdown, /https:\/\/worker\.example\/workspace\/reports\/result%20one\.md/);
});
