import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureWorkerWorkspace } from "../lib/worker.js";

test("creates .workspace on first load", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-worker-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const workspace = await ensureWorkerWorkspace({}, root);
  assert.equal(workspace, await fs.realpath(path.join(root, ".workspace")));
  assert.equal((await fs.stat(workspace)).isDirectory(), true);
});
