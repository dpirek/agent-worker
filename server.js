import { loadEnvironmentFile } from "./lib/env-config.js";
import { createWorkerServer, ensureWorkerWorkspace } from "./lib/worker.js";
import { createTerminalMonitor, tuiRequested } from "./lib/tui.js";

loadEnvironmentFile(new URL(".env", import.meta.url));
await ensureWorkerWorkspace();

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const useTui = tuiRequested();
let monitor;
const startupLogs = [];
const server = createWorkerServer({ onInfo: message => {
  if (monitor) monitor.log(message);
  else if (useTui) { startupLogs.push(message); if (startupLogs.length > 200) startupLogs.shift(); }
  else console.error(message);
} });

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  monitor?.stop();
  // Office sockets and active tasks must not keep terminal shutdown pending.
  server.close(() => process.exit(0));
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
process.once('exit', () => monitor?.stop());
process.on('uncaughtExceptionMonitor', () => monitor?.stop());
server.on('error', error => {
  monitor?.stop();
  console.error(`Worker agent failed: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  const address = server.address();
  const displayHost = ['0.0.0.0', '::'].includes(host) ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  const url = `http://${displayHost}:${address.port}`;
  if (useTui) {
    monitor = createTerminalMonitor({ getStatus: () => server.getWorkerStatus(), onQuit: stop, address: url });
    server.on('activity', event => monitor.log(`${event.category || 'agent'} / ${event.message || ''}`));
    server.once('close', () => monitor.stop());
    monitor.start();
    for (const message of startupLogs.splice(0)) monitor.log(message);
    monitor.log(`Worker agent listening on ${url}`);
  } else console.log(`Worker agent listening on ${url}`);
});
