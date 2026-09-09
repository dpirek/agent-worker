import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { interpolate, readWorkerManifest } from "../lib/worker-manifest.js";

test("supports Docker-style variable interpolation", () => {
  assert.equal(interpolate("${SET}-${MISSING:-fallback}-$$HOME", { SET: "value" }), "value-fallback-$HOME");
  assert.throws(() => interpolate("${TOKEN:?Set TOKEN}", {}), /Set TOKEN/);
});

test("loads env_file values and overlays manifest environment", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "worker-manifest-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, ".env"), "WORKER_NAME=Env Worker\nPORT=3100\nSECRET=file-secret\n", "utf8");
  await fs.writeFile(path.join(directory, "worker.yaml"), `
version: "1"
services:
  coder:
    env_file: .env
    environment:
      WORKER_NAME: "${"${WORKER_NAME}"} - YAML"
      PORT: 3200
      AI_HARNESS_WORKER_TOKEN: ${"${SECRET:?SECRET is required}"}
`, "utf8");

  const result = readWorkerManifest({
    filePath: path.join(directory, "worker.yaml"),
    hostEnv: { SECRET: "shell-secret" },
  });
  assert.equal(result.serviceName, "coder");
  assert.equal(result.directory, directory);
  assert.equal(result.env.WORKER_NAME, "Env Worker - YAML");
  assert.equal(result.env.PORT, "3200");
  assert.equal(result.env.AI_HARNESS_WORKER_TOKEN, "shell-secret");
});

test("requires --service when a manifest defines multiple instances", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "worker-services-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, "worker.yaml");
  await fs.writeFile(manifestPath, "services:\n  one: {}\n  two: {}\n", "utf8");
  assert.throws(() => readWorkerManifest({ filePath: manifestPath, hostEnv: {} }), /Choose a service with --service/);
  assert.equal(readWorkerManifest({ filePath: manifestPath, serviceName: "two", hostEnv: {} }).serviceName, "two");
});

test("the CLI launches a worker instance from YAML", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "worker-cli-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manifestPath = path.join(directory, "worker.yaml");
  await fs.writeFile(manifestPath, `
version: "1"
services:
  test-worker:
    environment:
      HOST: 127.0.0.1
      PORT: 0
      AI_HARNESS_OFFICE_URL: ws://127.0.0.1:9/ws/workers
      AI_HARNESS_WORKER_TOKEN: test-token
      WORKER_NAME: YAML Test Worker
      WORKER_TASK_DB: ":memory:"
      WORKER_WORKSPACE: .workspace
      PROVIDER_NAME: test
      PROVIDER_URL: https://models.example/v1
      PROVIDER_MODEL: test-model
`, "utf8");

  const cliPath = path.resolve("bin/agent-worker.js");
  const child = spawn(process.execPath, [cliPath, "--config", manifestPath], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  let output = "";
  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI did not start. Output: ${output}`)), 5_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("exit", (code) => {
      if (code && !output.includes("listening on")) reject(new Error(`CLI exited with ${code}: ${output}`));
    });
  });

  const port = await listening;
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.ok, true);
  assert.match(health.orchestration, /connecting|reconnecting|registering|disconnected/);
  child.kill("SIGTERM");
  const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 0);
});
