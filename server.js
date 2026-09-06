import { loadEnvironmentFile } from "./lib/env-config.js";
import { createWorkerServer, ensureWorkerWorkspace } from "./lib/worker.js";

loadEnvironmentFile(new URL(".env", import.meta.url));
await ensureWorkerWorkspace();

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const server = createWorkerServer();

server.listen(port, host, () => {
  console.log(`Worker agent listening on http://${host}:${port}`);
});
