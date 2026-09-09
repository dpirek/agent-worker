import assert from "node:assert/strict";
import test from "node:test";

import { parseYaml } from "../lib/yaml.js";

test("parses the worker manifest YAML subset without dependencies", () => {
  assert.deepEqual(parseYaml(`
version: 1
service:
  enabled: true
  endpoint: ws://127.0.0.1:8080/ws/workers # office endpoint
  files:
    - .env
    - "secrets #1.env"
  defaults: [1, false, null, value]
  empty: {}
`), {
    version: 1,
    service: {
      enabled: true,
      endpoint: "ws://127.0.0.1:8080/ws/workers",
      files: [".env", "secrets #1.env"],
      defaults: [1, false, null, "value"],
      empty: {},
    },
  });
});

test("rejects malformed indentation and duplicate mapping keys", () => {
  assert.throws(() => parseYaml("root:\n  child: yes\n child: no\n"), /unexpected indentation|unable to parse/);
  assert.throws(() => parseYaml("name: one\nname: two\n"), /duplicate key/);
  assert.throws(() => parseYaml("root:\n\tchild: value\n"), /tabs are not allowed/);
});
