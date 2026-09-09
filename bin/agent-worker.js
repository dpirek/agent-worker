#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createWorkerServer, ensureWorkerWorkspace } from "../lib/worker.js";
import { readWorkerManifest } from "../lib/worker-manifest.js";

function usage() {
  return `Usage: agent-worker [--config PATH] [--service NAME]

Starts one Agent Worker instance from a Docker-Compose-style YAML manifest.

Options:
  -c, --config PATH   Manifest path (default: agent-worker.yaml)
  -s, --service NAME  Service to start; optional when the manifest has one service
  -h, --help          Show this help`;
}

async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: "string", short: "c", default: "agent-worker.yaml" },
      service: { type: "string", short: "s" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(usage());
    return null;
  }

  const instance = readWorkerManifest({ filePath: values.config, serviceName: values.service });
  const env = instance.env;
  if (!String(env.AI_HARNESS_OFFICE_URL || "").trim()) throw new Error("AI_HARNESS_OFFICE_URL is required in the selected worker service.");
  if (!String(env.AI_HARNESS_WORKER_TOKEN || "").trim()) throw new Error("AI_HARNESS_WORKER_TOKEN is required in the selected worker service.");

  process.chdir(instance.directory);
  await ensureWorkerWorkspace(env);
  const port = Number(env.PORT || 3000);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error("PORT must be an integer between 0 and 65535.");
  const host = String(env.HOST || "0.0.0.0");
  const server = createWorkerServer({ env });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  console.log(`Agent worker "${instance.serviceName}" listening on http://${host}:${listeningPort}`);

  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
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
