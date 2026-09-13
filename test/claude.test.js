import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { claudeArguments, claudeWorkerEnvironment, createClaudeRunner,
  loadClaudeWorkerEnvironment } from "../claude.js";

function fakeProcess(onStart) {
  return (executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = signal => { setImmediate(() => child.emit("close", null, signal)); return true; };
    onStart({ child, executable, args, options });
    return child;
  };
}

test("builds a non-interactive Claude command and validates permission mode", () => {
  assert.deepEqual(claudeArguments({ env: { CLAUDE_MODEL: "sonnet", CLAUDE_PERMISSION_MODE: "acceptEdits" },
    mcpConfigPath: "/tmp/mcp.json" }), ["--print", "--output-format", "json", "--permission-mode",
    "acceptEdits", "--permission-prompts", "none", "--no-session-persistence", "--model", "sonnet",
    "--mcp-config", "/tmp/mcp.json"]);
  assert.throws(() => claudeArguments({ env: { CLAUDE_PERMISSION_MODE: "invalid" } }), /CLAUDE_PERMISSION_MODE/);
});

test("runs Claude in the task workspace and returns its JSON result", async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "claude-adapter-test-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  let invocation;
  let prompt = "";
  const spawnImpl = fakeProcess(value => {
    invocation = value;
    value.child.stdin.on("data", chunk => { prompt += chunk; });
    setImmediate(() => {
      value.child.stdout.end(JSON.stringify({ type: "result", result: "Claude finished." }));
      value.child.emit("close", 0, null);
    });
  });
  const answer = await createClaudeRunner({ env: { CLAUDE_EXECUTABLE: "local-claude" }, spawnImpl })(
    "Implement the feature", { workspace });
  assert.equal(answer, "Claude finished.");
  assert.equal(prompt, "Implement the feature");
  assert.equal(invocation.executable, "local-claude");
  assert.equal(invocation.options.cwd, workspace);
  assert.equal(invocation.options.shell, false);
});

test("provides task-scoped Office MCP credentials and removes their config", async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "claude-adapter-mcp-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  let configPath;
  let config;
  let prompt = "";
  const spawnImpl = fakeProcess(value => {
    configPath = value.args[value.args.indexOf("--mcp-config") + 1];
    value.child.stdin.on("data", chunk => { prompt += chunk; });
    setImmediate(async () => {
      config = JSON.parse(await fs.readFile(configPath, "utf8"));
      value.child.stdout.end(JSON.stringify({ type: "result", result: "Done" }));
      value.child.emit("close", 0, null);
    });
  });
  const answer = await createClaudeRunner({ env: {}, spawnImpl })("Task", { workspace,
    officeHttpOrigin: "http://office.example", officeMcpServers: [{ label: "project",
      url: "http://office.example/mcp", headers: { Authorization: "Bearer secret-token" } }] });
  assert.equal(answer, "Done");
  assert.deepEqual(config.mcpServers.project, { type: "http", url: "http://office.example/mcp",
    headers: { Authorization: "Bearer secret-token" } });
  assert.match(prompt, /Office HTTP origin: http:\/\/office.example/);
  await assert.rejects(fs.access(configPath), { code: "ENOENT" });
});

test("stops the Claude process when Office aborts a task", async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "claude-adapter-stop-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const controller = new AbortController();
  let killedWith;
  const spawnImpl = fakeProcess(value => {
    value.child.kill = signal => { killedWith = signal; setImmediate(() => value.child.emit("close", null, signal)); return true; };
    setImmediate(() => controller.abort(new Error("Stopped by Office")));
  });
  await assert.rejects(createClaudeRunner({ env: {}, spawnImpl })("Task", {
    workspace, signal: controller.signal }), /Stopped by Office/);
  assert.equal(killedWith, "SIGTERM");
});

test("advertises the Claude runtime and reads Office credentials from .env", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-adapter-env-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, ".env");
  await fs.writeFile(file, "AI_HARNESS_WORKER_TOKEN=file-token\nCLAUDE_WORKER_NAME=Claude From File\n");
  const env = loadClaudeWorkerEnvironment(file, { AI_HARNESS_WORKER_TOKEN: "stale-token" });
  assert.equal(env.AI_HARNESS_WORKER_TOKEN, "file-token");
  assert.equal(env.WORKER_NAME, "Claude From File");
  assert.equal(env.PROVIDER_NAME, "claude-local");
  assert.equal(env.PROVIDER_API_KEY, "");
  assert.equal(env.WORKER_TOOLS, "claude_cli");
  assert.equal(claudeWorkerEnvironment({}).WORKER_NAME,
    `claude-${os.hostname().replace(/[^A-Za-z0-9_-]+/g, "-")}`.slice(0, 100));
});
