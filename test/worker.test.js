import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
  const { server, url } = await listeningServer({
    env: {
      AI_HARNESS_OFFICE_URL: "ws://office.example:8080",
      AI_HARNESS_WORKER_TOKEN: "shared-secret",
      WORKER_NAME: "Repository Worker",
    },
    officeConnectionFactory: office.factory,
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
  assert.equal(result.artifacts[0].parts[0].file.uri, `${url}/workspace/task-001.zip`);
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
    .every((result) => result.artifacts[0].parts[0].file.uri.endsWith(`${result.taskId}.zip`)), true);
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
