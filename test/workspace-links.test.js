import assert from "node:assert/strict";
import test from "node:test";
import { workspaceLink } from "../public/lib/workspace-links.mjs";

const origin = "https://agent-worker-2.bohoosh.com";

test("maps saved local workspace URLs to the console origin without losing path encoding", () => {
  for (const host of ["127.0.0.1:3002", "localhost:3002", "[::1]:3002", "0.0.0.0:3002"]) {
    assert.equal(workspaceLink(`http://${host}/workspace/task/assets/design%20one.svg?download=1#preview`, origin),
      `${origin}/workspace/task/assets/design%20one.svg?download=1#preview`);
  }
  assert.equal(workspaceLink("http://127.0.0.1:3002/workspace", origin), `${origin}/workspace`);
});

test("preserves other sites, non-workspace links, relative URLs, and unsupported schemes", () => {
  for (const value of [
    "https://other-worker.example/workspace/result.md",
    "https://example.com/reference", "http://127.0.0.1:8005/api/tasks", "/workspace/task/output.md",
    "http://localhost:3002/workspace-other/file", "mailto:person@example.com", "javascript:alert(1)",
    "http://localhost.evil.example/workspace/file", "http://user:pass@localhost/workspace/file", "http://[",
  ]) assert.equal(workspaceLink(value, origin), value);
});
