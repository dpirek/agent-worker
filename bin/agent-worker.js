#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createWorkerServer, ensureWorkerWorkspace } from "../lib/worker.js";
import { readWorkerConfig } from "../lib/worker-manifest.js";
import { createTerminalMonitor } from "../lib/tui.js";

function usage() {
  return `Usage: agent-worker [--config PATH] [--service NAME] [--tui]

Starts one Agent Worker instance from a YAML manifest or .env file.

Options:
  -c, --config PATH   YAML or .env file path (default: agent-worker.yaml)
  -s, --service NAME  Service to start; optional when the manifest has one service
      --tui           Show the terminal monitoring dashboard
  -h, --help          Show this help`;
}

async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string", short: "c", default: "agent-worker.yaml" },
      service: { type: "string", short: "s" },
      tui: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(usage());
    return null;
  }

  const instance = readWorkerConfig({ filePath: values.config, serviceName: values.service });
  const env = instance.env;
  if (!String(env.AI_HARNESS_OFFICE_URL || "").trim()) throw new Error("AI_HARNESS_OFFICE_URL is required in the selected worker configuration.");
  if (!String(env.AI_HARNESS_WORKER_TOKEN || "").trim()) throw new Error("AI_HARNESS_WORKER_TOKEN is required in the selected worker configuration.");

  process.chdir(instance.directory);
  await ensureWorkerWorkspace(env);
  const port = Number(env.PORT || 3000);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("PORT must be an integer between 0 and 65535.");
  const host = String(env.HOST || "0.0.0.0");
  let monitor;
  const startupLogs = [];
  const server = createWorkerServer({ env, onInfo: message => {
    if (monitor) monitor.log(message);
    else if (values.tui) { startupLogs.push(message); if (startupLogs.length > 200) startupLogs.shift(); }
    else console.error(message);
  } });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  const displayHost = ['0.0.0.0', '::'].includes(host) ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  const url = `http://${displayHost}:${listeningPort}`;
  const message = `Agent worker "${instance.serviceName}" listening on ${url}`;

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    monitor?.stop();
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 1500).unref();
  };
  const restoreTerminal = () => monitor?.stop();
  const activity = event => monitor?.log(`${event.category || 'agent'} / ${event.message || ''}`);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once('exit', restoreTerminal);
  process.on('uncaughtExceptionMonitor', restoreTerminal);
  server.once('close', () => {
    restoreTerminal();
    server.off('activity', activity);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.off('exit', restoreTerminal);
    process.off('uncaughtExceptionMonitor', restoreTerminal);
  });
  if (values.tui) {
    monitor = createTerminalMonitor({ getStatus: () => server.getWorkerStatus(), onQuit: stop, address: url });
    server.on('activity', activity);
    monitor.start();
    for (const entry of startupLogs.splice(0)) monitor.log(entry);
    monitor.log(message);
  } else console.log(message);
  return server;
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`agent-worker: ${error.message}`);
    process.exitCode = 1;
  });
}

export { main, usage };
