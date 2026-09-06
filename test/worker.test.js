import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendWorkspaceLinks, createWorkerServer } from "../lib/worker.js";

async function listeningServer(options) {
  const server = createWorkerServer(options);
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
  const { server, url } = await listeningServer({
    runTask: async (prompt) => `finished: ${prompt}`,
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
  assert.match(result.message.parts[0].text, /model unavailable/);
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
  assert.match(await pageResponse.text(), /Agent Worker Console/);

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
