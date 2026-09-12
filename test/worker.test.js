import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { officeUploadUrl, uploadWorkspaceZip } from "../lib/office-upload.js";
import { agentInfo, appendWorkspaceLinks, createWorkerServer, stopTaskCommand } from "../lib/worker.js";

function officeHarness() {
  let options;
  const sent = [];
  return {
    sent,
    factory(nextOptions) {
      options = nextOptions;
      return {
        start() { options.onStatus({ status: "connected", endpoint: options.url, connectionId: "connection-1" }); },
        stop() {},
      };
    },
    registration() { return options; },
    deliver(payload) {
      options.onTask(payload, { connectionId: "connection-1", send(update) { sent.push(update); } });
    },
    deliverDirect(payload) {
      options.onDirectMessage(payload, { connectionId: "connection-1", send(response) { sent.push(response); } });
    },
    disconnect(reason = "Office connection closed.") { options.onDisconnect("connection-1", reason); },
  };
}

test("answers a correlated direct message without creating a task", async (t) => {
  const office = officeHarness();
  let directWorkspace;
  const { server, url } = await listeningServer({
    env: { AI_HARNESS_OFFICE_URL: "ws://office.example", AI_HARNESS_WORKER_TOKEN: "secret" },
    officeConnectionFactory: office.factory,
    runTask: async (prompt, context) => {
      directWorkspace = context.workspace;
      return `Version 1.2.3 answers: ${prompt}`;
    },
  });
  t.after(() => server.close());

  office.deliverDirect({
    type: "direct_message",
    message: {
      messageId: "direct-001",
      role: "user",
      parts: [{ kind: "text", mimeType: "text/plain", text: "What version are you using?" }],
    },
  });
  for (let attempt = 0; attempt < 40 && office.sent.length < 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(office.sent.length, 1);
  const response = office.sent[0];
  assert.equal(response.type, "direct_message_response");
  assert.equal(response.inReplyTo, "direct-001");
  assert.match(response.message.messageId, /^reply-/);
  assert.equal(response.message.role, "agent");
  assert.deepEqual(response.message.parts, [{
    kind: "text", mimeType: "text/plain", text: "Version 1.2.3 answers: What version are you using?",
  }]);
  assert.equal(response.taskId, undefined);
  assert.equal(response.status, undefined);
  assert.equal(response.artifacts, undefined);

  const status = await (await fetch(`${url}/api/status`)).json();
  assert.deepEqual(status.tasks, []);
  assert.equal(status.queue.directMessages.active, 0);
  assert.equal(path.basename(directWorkspace).startsWith(".direct-"), true);
  await assert.rejects(fs.access(directWorkspace));
});

test("recognizes Office stop commands", () => {
  assert.deepEqual(stopTaskCommand("@dave can you stop the current task?"), { mode: "current" });
  assert.deepEqual(stopTaskCommand("please cancel all tasks"), { mode: "all" });
  assert.deepEqual(stopTaskCommand("abort task task-123"), { mode: "id", target: "task-123" });
  assert.equal(stopTaskCommand("What is the task status?"), null);
});

test("stops an ongoing task when asked by direct Office message", async (t) => {
  const office = officeHarness();
  let taskSignal;
  const { server, url } = await listeningServer({
    env: { AI_HARNESS_OFFICE_URL: "ws://office.example", AI_HARNESS_WORKER_TOKEN: "secret" },
    officeConnectionFactory: office.factory,
    runTask: async (_prompt, context) => {
      taskSignal = context.signal;
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      });
    },
  });
  t.after(() => server.close());

  office.deliver({
    type: "task", taskId: "task-stop-me",
    message: { messageId: "msg-stop-me", parts: [{ kind: "text", text: "Keep working" }] },
  });
  for (let attempt = 0; attempt < 40 && (!taskSignal || office.sent.length < 1); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(taskSignal.aborted, false);

  office.deliverDirect({
    type: "direct_message",
    message: {
      messageId: "direct-stop",
      role: "user",
      parts: [{ kind: "text", mimeType: "text/plain", text: "@dave can you stop task task-stop-me?" }],
    },
  });
  for (let attempt = 0; attempt < 40 && office.sent.length < 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(taskSignal.aborted, true);
  const stopped = office.sent.find((message) => message.taskId === "task-stop-me" && message.status?.state === "failed");
  assert.equal(stopped.error.code, "TASK_STOPPED");
  assert.equal(stopped.artifacts, undefined);
  const answer = office.sent.find((message) => message.type === "direct_message_response");
  assert.equal(answer.inReplyTo, "direct-stop");
  assert.equal(answer.message.parts[0].text, "Stopped task task-stop-me.");

  const task = (await (await fetch(`${url}/api/tasks/task-stop-me`)).json()).task;
  assert.equal(task.state, "failed");
  assert.equal(task.result.error.code, "TASK_STOPPED");
  assert.equal(office.sent.some((message) => message.taskId === "task-stop-me" && message.status?.state === "completed"), false);
});

test("handles an imperative stop message as a control task", async (t) => {
  const office = officeHarness();
  let taskSignal;
  const { server } = await listeningServer({
    env: { AI_HARNESS_OFFICE_URL: "ws://office.example", AI_HARNESS_WORKER_TOKEN: "secret" },
    officeConnectionFactory: office.factory,
    runTask: async (_prompt, context) => {
      taskSignal = context.signal;
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      });
    },
  });
  t.after(() => server.close());

  office.deliver({
    type: "task", taskId: "task-running",
    message: { messageId: "msg-running", parts: [{ kind: "text", text: "Keep working" }] },
  });
  for (let attempt = 0; attempt < 40 && !taskSignal; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  office.deliver({
    type: "task", taskId: "task-control",
    message: { messageId: "msg-control", parts: [{ kind: "text", text: "Stop the current task" }] },
  });

  assert.equal(taskSignal.aborted, true);
  assert.equal(office.sent.filter((message) => message.taskId === "task-running" && message.status?.state === "failed").length, 1);
  const controlUpdates = office.sent.filter((message) => message.taskId === "task-control");
  assert.deepEqual(controlUpdates.map((message) => message.status.state), ["working", "completed"]);
  assert.equal(controlUpdates[1].message.parts[0].text, "Stopped task task-running.");
  assert.equal(controlUpdates[1].artifacts, undefined);
});

async function listeningServer(options) {
  const temporaryWorkspace = options?.env?.WORKER_WORKSPACE
    ? null
    : await fs.mkdtemp(path.join(os.tmpdir(), "agent-worker-workspace-"));
  const server = createWorkerServer({
    ...options,
    fetchImpl: options?.fetchImpl || (async () => new Response(JSON.stringify({ ok: true }))),
    uploadWorkspace: options?.uploadWorkspace || (async ({ archivePath, taskId }) => ({
      name: `${taskId}.zip`,
      size: (await fs.stat(archivePath)).size,
      uri: `https://office.example/api/workspace-file-asset?workspace=.&path=${taskId}.zip`,
    })),
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

test("registers with the office and completes a delivered WebSocket task", async (t) => {
  const office = officeHarness();
  let taskWorkspace;
  let uploadedArchive;
  const { server, url } = await listeningServer({
    env: {
      AI_HARNESS_OFFICE_URL: "ws://office.example:8080",
      AI_HARNESS_WORKER_TOKEN: "shared-secret",
      WORKER_NAME: "Repository Worker",
    },
    officeConnectionFactory: office.factory,
    uploadWorkspace: async ({ archivePath, taskId, messageId }) => {
      uploadedArchive = { content: await fs.readFile(archivePath), taskId, messageId };
      return {
        name: `${taskId}.zip`,
        size: (await fs.stat(archivePath)).size,
        uri: `https://office.example/uploads/${taskId}.zip`,
      };
    },
    runTask: async (prompt, context) => {
      taskWorkspace = context.workspace;
      await fs.writeFile(path.join(context.workspace, "result.txt"), "handoff contents", "utf8");
      return `finished: ${prompt}`;
    },
  });
  t.after(() => server.close());

  assert.equal(office.registration().url, "ws://office.example:8080");
  assert.equal(office.registration().token, "shared-secret");
  assert.equal(office.registration().worker.name, "Repository Worker");
  assert.equal(office.registration().worker.url, `${url.replace("http:", "ws:")}/agent`);
  office.deliver({
    type: "task",
    taskId: "task-001",
    priority: "high",
    message: { messageId: "msg-001", role: "manager", parts: [{ kind: "text", text: "Do the work" }] },
  });

  for (let attempt = 0; attempt < 40 && office.sent.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(office.sent[0].type, "task_update");
  assert.equal(office.sent[0].status.state, "working");
  const result = office.sent[1];
  assert.equal(result.type, "task_update");
  assert.equal(result.taskId, "task-001");
  assert.equal(result.inReplyTo, "msg-001");
  assert.equal(result.status.state, "completed");
  assert.equal(result.message.parts[0].mimeType, "text/markdown");
  assert.equal(result.message.parts[0].text, "finished: Do the work");
  assert.equal(path.basename(taskWorkspace), result.taskId);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].artifactId, `workspace-${result.taskId}`);
  assert.equal(result.artifacts[0].parts[0].kind, "file");
  assert.equal(result.artifacts[0].parts[0].file.mimeType, "application/zip");
  assert.equal(result.artifacts[0].parts[0].file.uri, "https://office.example/uploads/task-001.zip");
  assert.equal(result.artifacts[0].metadata.fileCount, 2);

  assert.equal(await fs.readFile(path.join(taskWorkspace, "output.md"), "utf8"), "finished: Do the work");

  assert.equal(uploadedArchive.taskId, "task-001");
  assert.equal(uploadedArchive.messageId, "msg-001");
  const archive = uploadedArchive.content;
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.equal(archive.includes(Buffer.from("result.txt")), true);
  assert.equal(archive.includes(Buffer.from("handoff contents")), true);
  assert.equal(archive.includes(Buffer.from("output.md")), true);
  assert.equal(archive.includes(Buffer.from("finished: Do the work")), true);
});

test("uploads test.md once per Office registration and reports upload failures", async (t) => {
  const office = officeHarness();
  const requests = [];
  const logs = [];
  const { server, url } = await listeningServer({
    env: {
      AI_HARNESS_OFFICE_URL: "wss://office.example/ws/workers",
      AI_HARNESS_WORKER_TOKEN: "shared-secret",
      AI_HARNESS_OFFICE_UPLOAD_WORKSPACE: "connectivity",
      WORKER_NAME: "Test Worker",
    },
    officeConnectionFactory: office.factory,
    onInfo: (message) => logs.push(message),
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (requests.length > 1) throw new Error("Upload unavailable");
      return new Response(JSON.stringify({ ok: true }));
    },
  });
  t.after(() => server.close());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.url, "https://office.example/api/workspace-upload?workspace=connectivity&name=test.md");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.authorization, "Bearer shared-secret");
  assert.equal(request.options.headers["content-type"], "text/markdown; charset=utf-8");
  assert.equal(request.options.headers["x-office-task-id"], undefined);
  assert.match(request.options.body.toString(), /Worker: Test Worker\nConnection: connection-1/);
  assert.ok(logs.some((message) => message.includes("connectivity test succeeded")));

  const status = { status: "connected", endpoint: "wss://office.example/ws/workers", connectionId: "connection-1" };
  office.registration().onStatus(status);
  assert.equal(requests.length, 1);
  office.registration().onStatus({ ...status, connectionId: "connection-2" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.ok(logs.some((message) => message.includes("connectivity test failed: Upload unavailable")));
  const workerStatus = await (await fetch(`${url}/api/status`)).json();
  assert.deepEqual(workerStatus.tasks, []);
  assert.equal(server.listening, true);
});

test("posts a workspace ZIP directly to the Office upload endpoint", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-worker-upload-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const archivePath = path.join(directory, "task-upload.zip");
  const archive = Buffer.from("zip bytes");
  await fs.writeFile(archivePath, archive);
  let request;
  const env = {
    AI_HARNESS_OFFICE_URL: "wss://office.example/ws/workers",
    AI_HARNESS_WORKER_TOKEN: "shared-secret",
    WORKER_NAME: "Repository Worker",
  };

  const uploaded = await uploadWorkspaceZip({
    archivePath,
    taskId: "task-upload",
    messageId: "message-upload",
    env,
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify({ ok: true, relativePath: "task-upload.zip", size: archive.length }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(request.url, "https://office.example/api/workspace-upload?workspace=.&name=task-upload.zip");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.authorization, "Bearer shared-secret");
  assert.equal(request.options.headers["content-type"], "application/zip");
  assert.equal(request.options.headers["x-agent-name"], "Repository Worker");
  assert.equal(request.options.headers["x-office-task-id"], "task-upload");
  assert.equal(request.options.headers["x-office-message-id"], "message-upload");
  assert.deepEqual(request.options.body, archive);
  assert.equal(uploaded.uri, "https://office.example/api/workspace-file-asset?workspace=.&path=task-upload.zip");
});

test("derives the Office upload endpoint from the worker WebSocket URL", () => {
  assert.equal(
    officeUploadUrl({ AI_HARNESS_OFFICE_URL: "ws://office.example:8080/ws/workers" }, "result one.zip").href,
    "http://office.example:8080/api/workspace-upload?workspace=.&name=result+one.zip",
  );
});

test("fails a task when its workspace ZIP cannot be uploaded", async (t) => {
  const office = officeHarness();
  const { server } = await listeningServer({
    env: { AI_HARNESS_OFFICE_URL: "ws://office.example", AI_HARNESS_WORKER_TOKEN: "secret" },
    officeConnectionFactory: office.factory,
    uploadWorkspace: async () => { throw new Error("Office upload unavailable"); },
    runTask: async () => "finished",
  });
  t.after(() => server.close());

  office.deliver({
    type: "task",
    taskId: "task-upload-failure",
    message: { messageId: "message-upload-failure", parts: [{ kind: "text", text: "Run" }] },
  });
  for (let attempt = 0; attempt < 40 && office.sent.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const result = office.sent[1];
  assert.equal(result.status.state, "failed");
  assert.match(result.error.message, /Office upload unavailable/);
  assert.equal(result.artifacts, undefined);
});

test("gives concurrent office tasks different workspace subfolders", async (t) => {
  const office = officeHarness();
  const workspaces = [];
  const { server, url } = await listeningServer({
    env: {
      WORKER_CONCURRENCY: "2",
      AI_HARNESS_OFFICE_URL: "ws://office.example/ws/workers",
      AI_HARNESS_WORKER_TOKEN: "secret",
    },
    officeConnectionFactory: office.factory,
    runTask: async (_prompt, context) => {
      workspaces.push(context.workspace);
      await fs.writeFile(path.join(context.workspace, "output.txt"), path.basename(context.workspace));
      return "done";
    },
  });
  t.after(() => server.close());

  for (const id of ["1", "2"]) office.deliver({
    type: "task", taskId: `task-${id}`,
    message: { messageId: `message-${id}`, parts: [{ kind: "text", text: "Run" }] },
  });
  for (let attempt = 0; attempt < 40 && office.sent.filter((item) => item.status.state === "completed").length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(new Set(workspaces).size, 2);
  assert.equal(office.sent.filter((item) => item.status.state === "completed")
    .every((result) => result.artifacts[0].parts[0].file.uri.includes(`${result.taskId}.zip`)), true);
  assert.match(url, /^http:/);
});

test("does not expose the removed HTTP task endpoint", async (t) => {
  const { server, url } = await listeningServer({ runTask: async () => "unused" });
  t.after(() => server.close());
  const response = await fetch(`${url}/a2a`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: { messageId: "msg-002", parts: [{ kind: "text", text: "Run" }] } }),
  });
  assert.equal(response.status, 404);
});

test("reports agent failures without deliverables over the task socket", async (t) => {
  const office = officeHarness();
  const { server, url } = await listeningServer({
    env: { AI_HARNESS_OFFICE_URL: "ws://office.example", AI_HARNESS_WORKER_TOKEN: "secret" },
    officeConnectionFactory: office.factory,
    runTask: async () => { throw new Error("model unavailable"); },
  });
  t.after(() => server.close());

  office.deliver({
    type: "task", taskId: "task-failure",
    message: { messageId: "msg-failure", parts: [{ kind: "text", text: "Run" }] },
  });
  for (let attempt = 0; attempt < 40 && office.sent.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const result = office.sent[1];
  assert.equal(result.status.state, "failed");
  assert.equal(result.error.code, "TASK_FAILED");
  assert.equal(result.error.details.name, "Error");
  assert.match(result.error.details.stack, /model unavailable/);
  assert.match(result.message.parts[0].text, /model unavailable/);
  assert.equal(result.artifacts, undefined);
  assert.match(url, /^http:/);
});

test("marks in-flight work failed on disconnect and does not resume it", async (t) => {
  const office = officeHarness();
  let finishTask;
  const { server, url } = await listeningServer({
    env: { AI_HARNESS_OFFICE_URL: "ws://office.example", AI_HARNESS_WORKER_TOKEN: "secret" },
    officeConnectionFactory: office.factory,
    runTask: async () => new Promise((resolve) => { finishTask = resolve; }),
  });
  t.after(() => server.close());

  office.deliver({
    type: "task", taskId: "task-disconnected",
    message: { messageId: "msg-disconnected", parts: [{ kind: "text", text: "Run slowly" }] },
  });
  for (let attempt = 0; attempt < 40 && (office.sent.length < 1 || typeof finishTask !== "function"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(typeof finishTask, "function");
  office.disconnect("Socket lost.");
  let task = (await (await fetch(`${url}/api/tasks/task-disconnected`)).json()).task;
  assert.equal(task.state, "failed");
  assert.equal(task.error, "Socket lost.");
  finishTask("late result");
  await new Promise((resolve) => setTimeout(resolve, 10));
  task = (await (await fetch(`${url}/api/tasks/task-disconnected`)).json()).task;
  assert.equal(task.state, "failed");
  assert.equal(office.sent.length, 1);
});

test("returns the discoverable agent card", async (t) => {
  const { server, url } = await listeningServer({ runTask: async () => "unused" });
  t.after(() => server.close());
  const response = await fetch(`${url}/.well-known/agent-card.json`);
  assert.equal(response.status, 200);
  const card = await response.json();
  assert.equal(card.url, `${url.replace("http:", "ws:")}/agent`);
  assert.equal(card.skills[0].id, "coding-task");
});

test("returns agent capabilities and redacted model information", async (t) => {
  const { server, url } = await listeningServer({
    env: {
      PROVIDER_NAME: "custom",
      PROVIDER_URL: "https://models.example/v1?api_key=url-secret",
      PROVIDER_API_KEY: "do-not-expose",
      PROVIDER_MODEL: "test-model",
      WORKER_NAME: "Repository Worker",
      WORKER_DESCRIPTION: "Builds and tests repository changes.",
      WORKER_TOOLS: "read_file,write_file,run_command",
      WORKER_SKILLS: '[{"id":"research","name":"Research","description":"Research current information."}]',
      AI_HARNESS_MCP_SERVERS: "[]",
    },
    runTask: async () => "unused",
  });
  t.after(() => server.close());

  const response = await fetch(`${url}/api/info`);
  assert.equal(response.status, 200);
  const info = await response.json();
  assert.equal(info.name, "Repository Worker");
  assert.equal(info.description, "Builds and tests repository changes.");
  assert.equal(info.url, `${url.replace("http:", "ws:")}/agent`);
  assert.deepEqual(info.capabilities.skills, [{
    id: "research", name: "Research", description: "Research current information.",
  }]);
  assert.deepEqual(info.capabilities.tools, ["read_file", "write_file", "run_command"]);
  assert.equal(info.capabilities.mcp, true);
  assert.equal(info.capabilities.workspaceArtifacts, true);
  assert.deepEqual(info.model, {
    provider: "custom",
    name: "test-model",
    url: "https://models.example/v1?api_key=%5Bredacted%5D",
  });
  assert.equal(JSON.stringify(info).includes("do-not-expose"), false);
  assert.equal(JSON.stringify(info).includes("url-secret"), false);
});

test("rejects malformed custom skill declarations", () => {
  assert.throws(() => agentInfo("http://worker.example", { WORKER_SKILLS: "not-json" }), /JSON array/);
  assert.throws(() => agentInfo("http://worker.example", { WORKER_SKILLS: "[{}]" }), /requires id, name, and description/);
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
  assert.equal(task.deliveryError, null);
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

test("browses workspace folders and bounds safe text previews", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-browser-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-outside-'));
  t.after(() => Promise.all([fs.rm(workspace, {recursive:true,force:true}), fs.rm(outside, {recursive:true,force:true})]));
  await fs.mkdir(path.join(workspace,'assets'));
  await fs.writeFile(path.join(workspace,'a # file.md'),'# Preview <script>bad()</script>');
  await fs.writeFile(path.join(workspace,'large.txt'),'x'.repeat(300 * 1024));
  await fs.writeFile(path.join(workspace,'binary.zip'),Buffer.from([1,0,2]));
  await fs.writeFile(path.join(workspace,'index.html'),'<h1>Preview</h1>');
  await fs.writeFile(path.join(outside,'secret.txt'),'secret');
  await fs.symlink(outside,path.join(workspace,'escape'));
  const {server,url} = await listeningServer({env:{WORKER_WORKSPACE:workspace}, runTask:async()=>''});
  t.after(()=>server.close());
  const listing = await (await fetch(`${url}/api/workspace`)).json();
  assert.equal(listing.entries[0].name,'assets');
  assert.ok(!listing.entries.some(e=>e.name==='escape'));
  const text = await (await fetch(`${url}/api/workspace/file?path=${encodeURIComponent('a # file.md')}`)).json();
  assert.equal(text.content,'# Preview <script>bad()</script>');
  const large = await (await fetch(`${url}/api/workspace/file?path=large.txt`)).json();
  assert.equal(large.content.length,256 * 1024);
  assert.equal(large.truncated,true);
  assert.equal((await fetch(`${url}/api/workspace/file?path=binary.zip`)).status,415);
  for (const target of ['../secret.txt','escape/secret.txt','/etc/passwd','..\\secret.txt']) {
    assert.equal((await fetch(`${url}/api/workspace/file?path=${encodeURIComponent(target)}`)).status,403);
  }
  assert.equal((await fetch(`${url}/api/workspace?path=missing`)).status,404);
  const html = await fetch(`${url}/workspace/index.html`);
  assert.match(html.headers.get('content-security-policy'),/sandbox/);
  assert.match(html.headers.get('content-security-policy'),/script-src 'none'/);
});

test("manually disconnects and creates a fresh Office connection without duplicate starts", async (t) => {
  let starts=0, stops=0;
  const callbacks=[];
  const {server,url}=await listeningServer({
    env:{AI_HARNESS_OFFICE_URL:'ws://office.example'},runTask:async()=>'',onInfo:()=>{},
    officeConnectionFactory(options) {
      callbacks.push(options);
      return {start(){starts++;options.onStatus({status:'connected',connectionId:`connection-${starts}`,endpoint:options.url});},stop(){stops++;options.onStatus({status:'stopped',connectionId:null});}};
    },
  });
  t.after(()=>server.close());
  const change = (action,origin) => fetch(`${url}/api/office/connection`,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify({action})});
  assert.equal(starts,1);
  assert.equal((await change('disconnect','https://untrusted.example')).status,403);
  assert.equal((await change('disconnect','null')).status,403);
  let response=await (await change('disconnect')).json();
  assert.equal(response.orchestration.enabled,false);
  assert.equal(response.orchestration.status,'stopped');
  assert.equal(stops,1);
  callbacks[0].onStatus({status:'reconnecting'});
  assert.equal((await (await fetch(`${url}/api/status`)).json()).orchestration.status,'stopped');
  response=await (await change('connect')).json();
  assert.equal(response.orchestration.enabled,true);
  assert.equal(starts,2);
  await change('connect');
  assert.equal(starts,2);
  assert.equal((await change('invalid')).status,400);
});

test("records incoming and outgoing Office and REPL chat with persisted pagination", async (t) => {
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'worker-chat-'));
  t.after(()=>fs.rm(workspace,{recursive:true,force:true}));
  const dbPath=path.join(workspace,'history.sqlite');
  const office=officeHarness();
  const options={env:{WORKER_WORKSPACE:workspace,WORKER_TASK_DB:dbPath,AI_HARNESS_OFFICE_URL:'ws://office.example'},officeConnectionFactory:office.factory,runTask:async text=>`Reply to ${text}`,onInfo:()=>{}};
  const first=await listeningServer(options);
  t.after(()=>{ if (first.server.listening) first.server.close(); });
  office.deliverDirect({type:'direct_message',message:{messageId:'chat-in',parts:[{text:'Hello <img onerror=bad()>',kind:'text'}]}});
  const submitted=await (await fetch(`${first.url}/api/test`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:'REPL hello'})})).json();
  let data;
  for(let i=0;i<100;i++) {
    data=await (await fetch(`${first.url}/api/messages`)).json();
    if(data.messages.length===4)break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal(data.messages.length,4);
  assert.deepEqual(new Set(data.messages.map(m=>`${m.source}/${m.direction}`)),new Set(['office/incoming','office/outgoing','repl/incoming','repl/outgoing']));
  assert.ok(data.messages.some(m=>m.taskId===submitted.taskId));
  const cursor=data.messages[1].id;
  assert.equal((await (await fetch(`${first.url}/api/messages?before=${cursor}`)).json()).messages.length,1);
  assert.equal((await (await fetch(`${first.url}/api/messages?after=${cursor}`)).json()).messages.length,2);
  assert.equal((await fetch(`${first.url}/api/messages?after=-1`)).status,400);
  await new Promise(resolve=>first.server.close(resolve));
  const second=await listeningServer(options);
  t.after(()=>second.server.close());
  assert.equal((await (await fetch(`${second.url}/api/messages`)).json()).messages.length,4);
});

test("serves the pinned Markdown browser modules without exposing node_modules", async (t) => {
  const {server,url}=await listeningServer({runTask:async()=>''});
  t.after(()=>server.close());
  for(const module of ['marked','dompurify']) {
    const response=await fetch(`${url}/vendor/${module}.mjs`);
    assert.equal(response.status,200);
    assert.match(response.headers.get('content-type'),/javascript/);
    assert.match(await response.text(),/export/);
  }
  assert.equal((await fetch(`${url}/vendor/package.json`)).status,404);
});
