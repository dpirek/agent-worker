import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  codexArguments,
  codexWorkerEnvironment,
  createCodexRunner,
  latestAgentMessage,
  loadCodexWorkerEnvironment,
} from "../codex.js";

test("builds a non-interactive Codex command from local settings", () => {
  const args = codexArguments({
    env: {
      CODEX_MODEL: "gpt-test",
      CODEX_PROFILE: "office",
      CODEX_SANDBOX: "read-only",
      CODEX_EPHEMERAL: "true",
    },
    workspace: "/tmp/workspace",
    outputPath: "/tmp/answer.md",
  });

  assert.deepEqual(args, [
    "exec", "--json", "--color", "never", "--skip-git-repo-check",
    "--sandbox", "read-only", "--config", 'approval_policy="never"',
    "--cd", "/tmp/workspace", "--output-last-message", "/tmp/answer.md",
    "--model", "gpt-test", "--profile", "office", "--ephemeral", "-",
  ]);
  assert.throws(() => codexArguments({
    env: { CODEX_SANDBOX: "unrestricted" }, workspace: "/tmp/workspace", outputPath: "/tmp/out",
  }), /CODEX_SANDBOX/);
});

test("runs Codex in the task workspace and returns its final message", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "codex-adapter-test-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  let invocation;
  let receivedPrompt = "";
  const spawnImpl = (executable, args, options) => {
    invocation = { executable, args, options };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on("data", (chunk) => { receivedPrompt += chunk; });
    child.kill = () => true;
    setImmediate(async () => {
      const outputPath = args[args.indexOf("--output-last-message") + 1];
      await fs.writeFile(outputPath, "Codex finished the task.\n", "utf8");
      child.stdout.end('{"type":"turn.completed"}\n');
      child.emit("close", 0, null);
    });
    return child;
  };

  const runner = createCodexRunner({ env: { CODEX_EXECUTABLE: "local-codex" }, spawnImpl });
  const answer = await runner("Implement the feature", { workspace });

  assert.equal(answer, "Codex finished the task.");
  assert.equal(receivedPrompt, "Implement the feature");
  assert.equal(invocation.executable, "local-codex");
  assert.equal(invocation.options.cwd, workspace);
  assert.equal(invocation.options.shell, false);
});

test("uses the JSONL agent message when the output file is absent", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "codex-adapter-jsonl-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.write(`${JSON.stringify({
        type: "item.completed", item: { type: "agent_message", text: "Fallback answer" },
      })}\n`);
      child.emit("close", 0, null);
    });
    return child;
  };
  const runner = createCodexRunner({ env: {}, spawnImpl });
  assert.equal(await runner("Answer", { workspace }), "Fallback answer");
});

test("terminates the Codex subprocess when an Office task is stopped", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "codex-adapter-stop-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const controller = new AbortController();
  let killedWith;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = (signal) => {
      killedWith = signal;
      setImmediate(() => child.emit("close", null, signal));
      return true;
    };
    setImmediate(() => controller.abort(new Error("Stopped by the Office.")));
    return child;
  };

  const runner = createCodexRunner({ env: {}, spawnImpl });
  await assert.rejects(runner("Keep working", { workspace, signal: controller.signal }), /Stopped by the Office/);
  assert.equal(killedWith, "SIGTERM");
});

test("advertises the local Codex runtime without provider credentials", () => {
  const env = codexWorkerEnvironment({ CODEX_MODEL: "gpt-local", CODEX_WORKER_NAME: "My Codex" });
  assert.equal(env.WORKER_NAME, "My Codex");
  assert.equal(env.PROVIDER_NAME, "codex-local");
  assert.equal(env.PROVIDER_URL, "local://codex-cli");
  assert.equal(env.PROVIDER_MODEL, "gpt-local");
  assert.equal(env.PROVIDER_API_KEY, "");
  assert.equal(env.WORKER_TOOLS, "codex_cli");
});

test("names the Codex worker after the current computer by default", () => {
  const env = codexWorkerEnvironment({ WORKER_NAME: "Generic Worker" });
  assert.equal(env.WORKER_NAME, `codex-${os.hostname()}`);
});

test("uses Office credentials from .env instead of stale shell values", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-adapter-env-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");
  await fs.writeFile(envPath, [
    "AI_HARNESS_OFFICE_URL=ws://office-from-file.example/ws/workers",
    "AI_HARNESS_WORKER_TOKEN=token-from-file",
    "CODEX_WORKER_NAME=Codex From File",
  ].join("\n"));

  const env = loadCodexWorkerEnvironment(envPath, {
    AI_HARNESS_OFFICE_URL: "ws://stale-shell.example/ws/workers",
    AI_HARNESS_WORKER_TOKEN: "stale-shell-token",
    CODEX_WORKER_NAME: "Stale Shell Agent",
  });

  assert.equal(env.AI_HARNESS_OFFICE_URL, "ws://office-from-file.example/ws/workers");
  assert.equal(env.AI_HARNESS_WORKER_TOKEN, "token-from-file");
  assert.equal(env.WORKER_NAME, "Codex From File");
});

test("extracts the last completed agent message from Codex JSONL", () => {
  const events = [
    { type: "item.completed", item: { type: "agent_message", text: "first" } },
    { type: "item.completed", item: { type: "command_execution", text: "ignored" } },
    { type: "item.completed", item: { type: "agent_message", text: "final" } },
  ].map(JSON.stringify).join("\n");
  assert.equal(latestAgentMessage(events), "final");
});
