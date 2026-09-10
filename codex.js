#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { createWorkerServer, ensureWorkerWorkspace } from "./lib/worker.js";

const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const DEFAULT_MAX_DIAGNOSTIC_BYTES = 32 * 1024;

function booleanSetting(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  if (/^(?:1|true|yes|on)$/i.test(String(value).trim())) return true;
  if (/^(?:0|false|no|off)$/i.test(String(value).trim())) return false;
  throw new Error(`Expected a boolean setting, received ${JSON.stringify(value)}.`);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function codexArguments({ env, workspace, outputPath }) {
  const sandbox = String(env.CODEX_SANDBOX || "workspace-write").trim();
  if (!SANDBOX_MODES.has(sandbox)) {
    throw new Error(`CODEX_SANDBOX must be one of: ${[...SANDBOX_MODES].join(", ")}.`);
  }

  const args = [
    "exec",
    "--json",
    "--color", "never",
    "--skip-git-repo-check",
    "--sandbox", sandbox,
    "--config", 'approval_policy="never"',
    "--cd", workspace,
    "--output-last-message", outputPath,
  ];
  const model = String(env.CODEX_MODEL || "").trim();
  const profile = String(env.CODEX_PROFILE || "").trim();
  if (model) args.push("--model", model);
  if (profile) args.push("--profile", profile);
  if (booleanSetting(env.CODEX_EPHEMERAL, false)) args.push("--ephemeral");
  args.push("-");
  return args;
}

function appendBounded(current, chunk, limit) {
  const next = current + String(chunk);
  return next.length <= limit ? next : next.slice(next.length - limit);
}

function latestAgentMessage(jsonLines) {
  let answer = "";
  for (const line of String(jsonLines).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        answer = String(event.item.text || "").trim();
      }
    } catch {
      // Codex's JSONL stream is diagnostic-only here. The output file below is
      // the authoritative final response, so an unrelated line can be ignored.
    }
  }
  return answer;
}

function createCodexRunner({
  env = process.env,
  spawnImpl = spawn,
  onInfo = console.error,
} = {}) {
  const executable = String(env.CODEX_EXECUTABLE || "codex").trim();
  if (!executable) throw new Error("CODEX_EXECUTABLE must not be empty.");
  const diagnosticLimit = positiveInteger(env.CODEX_MAX_DIAGNOSTIC_BYTES, DEFAULT_MAX_DIAGNOSTIC_BYTES);

  return async function runCodex(prompt, { workspace, signal } = {}) {
    if (!workspace) throw new Error("A task workspace is required for Codex execution.");
    if (signal?.aborted) throw signal.reason || new Error("Codex execution was stopped.");

    const outputDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-worker-codex-"));
    const outputPath = path.join(outputDirectory, "last-message.md");
    const args = codexArguments({ env, workspace, outputPath });
    let stderr = "";
    let stdout = "";
    let child;

    try {
      const result = await new Promise((resolve, reject) => {
        child = spawnImpl(executable, args, {
          cwd: workspace,
          env,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", abort);
          callback(value);
        };
        const abort = () => {
          child.kill("SIGTERM");
          const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
          timer.unref?.();
        };
        signal?.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk, diagnosticLimit); });
        child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk, diagnosticLimit); });
        child.once("error", (error) => finish(reject, error));
        child.once("close", (code, processSignal) => finish(resolve, { code, processSignal }));
        child.stdin.on("error", () => {});
        child.stdin.end(String(prompt));
      });

      if (signal?.aborted) throw signal.reason || new Error("Codex execution was stopped.");
      if (result.code !== 0) {
        const detail = stderr.trim() || `process exited with ${result.processSignal || `code ${result.code}`}`;
        throw new Error(`Codex CLI failed: ${detail}`);
      }

      let answer = "";
      try { answer = (await fsp.readFile(outputPath, "utf8")).trim(); } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      answer ||= latestAgentMessage(stdout);
      if (!answer) throw new Error("Codex CLI completed without a final response.");
      return answer;
    } finally {
      try { await fsp.rm(outputDirectory, { recursive: true, force: true }); } catch (error) {
        onInfo(`Unable to clean Codex response directory: ${error.message}`);
      }
    }
  };
}

function codexWorkerEnvironment(env = process.env) {
  const workerName = String(env.CODEX_WORKER_NAME || "").trim() || `codex-${os.hostname()}`;
  return {
    ...env,
    WORKER_NAME: workerName,
    WORKER_DESCRIPTION: env.WORKER_DESCRIPTION || "Completes Agent Office work with the locally authenticated Codex CLI.",
    WORKER_TOOLS: env.WORKER_TOOLS || "codex_cli",
    PROVIDER_NAME: "codex-local",
    PROVIDER_URL: "local://codex-cli",
    PROVIDER_API_KEY: "",
    PROVIDER_MODEL: env.CODEX_MODEL || "local-config",
  };
}

function loadCodexWorkerEnvironment(filePath, baseEnv = process.env) {
  let fileEnv = {};
  if (fs.existsSync(filePath)) {
    fileEnv = parseEnv(fs.readFileSync(filePath, "utf8"));
  }
  // The adapter may be launched from a terminal that still has credentials for
  // another Office exported. Treat this project's .env as authoritative so it
  // registers exactly like the workers configured from the same file.
  return codexWorkerEnvironment({ ...baseEnv, ...fileEnv });
}

async function main() {
  const env = loadCodexWorkerEnvironment(new URL(".env", import.meta.url));
  if (!String(env.AI_HARNESS_OFFICE_URL || "").trim()) throw new Error("AI_HARNESS_OFFICE_URL is required.");
  if (!String(env.AI_HARNESS_WORKER_TOKEN || "").trim()) throw new Error("AI_HARNESS_WORKER_TOKEN is required.");
  const port = Number(env.PORT || 3000);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }
  const host = String(env.HOST || "0.0.0.0");
  await ensureWorkerWorkspace(env);
  const server = createWorkerServer({ env, runTask: createCodexRunner({ env }) });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  console.log(`Local Codex agent listening on http://${host}:${listeningPort}`);

  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return server;
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`codex-worker: ${error.message}`);
    process.exitCode = 1;
  });
}

export {
  codexArguments,
  codexWorkerEnvironment,
  createCodexRunner,
  latestAgentMessage,
  loadCodexWorkerEnvironment,
  main,
};
