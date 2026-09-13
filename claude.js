#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import { createWorkerServer, ensureWorkerWorkspace } from "./lib/worker.js";
import { OFFICE_MCP_INSTRUCTIONS } from "./lib/office-mcp.js";

const PERMISSION_MODES = new Set(["acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan"]);
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function claudeArguments({ env, mcpConfigPath = "" }) {
  const mode = String(env.CLAUDE_PERMISSION_MODE || "bypassPermissions").trim();
  if (!PERMISSION_MODES.has(mode)) throw new Error(`CLAUDE_PERMISSION_MODE must be one of: ${[...PERMISSION_MODES].join(", ")}.`);
  const args = ["--print", "--output-format", "json", "--permission-mode", mode,
    "--permission-prompts", "none", "--no-session-persistence"];
  const model = String(env.CLAUDE_MODEL || "").trim();
  if (model) args.push("--model", model);
  if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
  return args;
}

function claudeResult(stdout) {
  let result;
  try { result = JSON.parse(stdout); } catch { throw new Error("Claude CLI returned invalid JSON."); }
  if (result.is_error) throw new Error(`Claude CLI failed: ${String(result.result || "Unknown error")}`);
  const answer = String(result.result || "").trim();
  if (!answer) throw new Error("Claude CLI completed without a final response.");
  return answer;
}

function createClaudeRunner({ env = process.env, spawnImpl = spawn, onInfo = console.error } = {}) {
  const executable = String(env.CLAUDE_EXECUTABLE || "claude").trim();
  if (!executable) throw new Error("CLAUDE_EXECUTABLE must not be empty.");
  const outputLimit = positiveInteger(env.CLAUDE_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES);

  return async function runClaude(prompt, { workspace, signal, officeMcpServers = [], officeHttpOrigin = "" } = {}) {
    if (!workspace) throw new Error("A task workspace is required for Claude execution.");
    if (signal?.aborted) throw signal.reason || new Error("Claude execution was stopped.");
    const secrets = officeMcpServers.flatMap(server => [server.headers.Authorization, server.headers.Authorization.replace(/^Bearer /i, "")]);
    const redact = value => secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), String(value));
    let configDirectory = "";
    let stdout = "";
    let stderr = "";
    let overflow = false;
    try {
      if (officeMcpServers.length) {
        configDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-worker-claude-"));
        const configPath = path.join(configDirectory, "mcp.json");
        await fsp.writeFile(configPath, JSON.stringify({ mcpServers: Object.fromEntries(officeMcpServers.map(server => [
          server.label, { type: "http", url: server.url, headers: server.headers },
        ])) }), { mode: 0o600 });
      }
      const args = claudeArguments({ env, mcpConfigPath: configDirectory ? path.join(configDirectory, "mcp.json") : "" });
      const result = await new Promise((resolve, reject) => {
        const child = spawnImpl(executable, args, { cwd: workspace, env: { ...env }, shell: false,
          stdio: ["pipe", "pipe", "pipe"] });
        let settled = false;
        let killTimer;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", abort);
          clearTimeout(killTimer);
          callback(value);
        };
        const abort = () => {
          child.kill("SIGTERM");
          killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
          killTimer.unref?.();
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        child.stdout.on("data", chunk => {
          stdout += String(chunk);
          if (Buffer.byteLength(stdout) > outputLimit && !overflow) { overflow = true; child.kill("SIGTERM"); }
        });
        child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-32 * 1024); });
        child.once("error", error => finish(reject, error));
        child.once("close", (code, processSignal) => finish(resolve, { code, processSignal }));
        child.stdin.on("error", () => {});
        child.stdin.end(officeMcpServers.length
          ? `${OFFICE_MCP_INSTRUCTIONS}\nOffice HTTP origin: ${officeHttpOrigin}\n\n${String(prompt)}`
          : String(prompt));
      });
      if (signal?.aborted) throw signal.reason || new Error("Claude execution was stopped.");
      if (overflow) throw new Error(`Claude CLI output exceeded ${outputLimit} bytes.`);
      if (result.code !== 0) throw new Error(`Claude CLI failed: ${redact(stderr.trim() || `process exited with ${result.processSignal || `code ${result.code}`}`)}`);
      try { return redact(claudeResult(stdout)); }
      catch (error) { throw new Error(redact(error.message)); }
    } finally {
      if (configDirectory) {
        try { await fsp.rm(configDirectory, { recursive: true, force: true }); }
        catch (error) { onInfo(`Unable to clean Claude MCP configuration: ${error.message}`); }
      }
    }
  };
}

function claudeWorkerEnvironment(env = process.env) {
  const defaultName = `claude-${os.hostname().replace(/[^A-Za-z0-9_-]+/g, "-")}`.slice(0, 100);
  return { ...env,
    WORKER_NAME: String(env.CLAUDE_WORKER_NAME || "").trim() || defaultName,
    WORKER_DESCRIPTION: env.WORKER_DESCRIPTION || "Completes Agent Office work with the locally authenticated Claude Code CLI.",
    WORKER_TOOLS: env.WORKER_TOOLS || "claude_cli",
    PROVIDER_NAME: "claude-local", PROVIDER_URL: "local://claude-cli", PROVIDER_API_KEY: "",
    PROVIDER_MODEL: env.CLAUDE_MODEL || "local-config",
  };
}

function loadClaudeWorkerEnvironment(filePath, baseEnv = process.env) {
  const fileEnv = fs.existsSync(filePath) ? parseEnv(fs.readFileSync(filePath, "utf8")) : {};
  return claudeWorkerEnvironment({ ...baseEnv, ...fileEnv });
}

async function main() {
  const env = loadClaudeWorkerEnvironment(new URL(".env", import.meta.url));
  if (!String(env.AI_HARNESS_OFFICE_URL || "").trim()) throw new Error("AI_HARNESS_OFFICE_URL is required.");
  if (!String(env.AI_HARNESS_WORKER_TOKEN || "").trim()) throw new Error("AI_HARNESS_WORKER_TOKEN is required.");
  const port = Number(env.PORT || 3000);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("PORT must be an integer between 0 and 65535.");
  const host = String(env.HOST || "0.0.0.0");
  await ensureWorkerWorkspace(env);
  const server = createWorkerServer({ env, runTask: createClaudeRunner({ env }) });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  const address = server.address();
  console.log(`Local Claude agent listening on http://${host}:${typeof address === "object" && address ? address.port : port}`);
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return server;
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`claude-worker: ${error.message}`); process.exitCode = 1; });
}

export { claudeArguments, claudeResult, claudeWorkerEnvironment, createClaudeRunner,
  loadClaudeWorkerEnvironment, main };
