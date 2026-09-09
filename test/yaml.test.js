import assert from "node:assert/strict";
import fs from "node:fs/promises";
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

test("parses the research assistant example", async () => {
  const manifest = parseYaml(await fs.readFile(new URL("../examples/research-assistant.yaml", import.meta.url), "utf8"));
  const environment = manifest.services["research-assistant"].environment;
  assert.equal(environment.WORKER_TOOLS, "curl,read_file,write_file,read_office_context");
  assert.match(environment.WORKER_SKILLS, /web-research/);
  assert.match(environment.AI_HARNESS_AGENT_INSTRUCTIONS, /current news/);
});

test("parses the designer example", async () => {
  const manifest = parseYaml(await fs.readFile(new URL("../examples/designer.yaml", import.meta.url), "utf8"));
  const environment = manifest.services.designer.environment;
  assert.equal(environment.PROVIDER_NAME, "openrouter");
  assert.equal(environment.OPENROUTER_IMAGE_MODEL, "openai/gpt-image-2");
  assert.match(environment.WORKER_TOOLS, /generate_image/);
  assert.match(environment.WORKER_SKILLS, /visual-design/);
});

test("parses the image-design developer example", async () => {
  const manifest = parseYaml(await fs.readFile(new URL("../examples/developer.yaml", import.meta.url), "utf8"));
  const environment = manifest.services.developer.environment;
  assert.equal(environment.PROVIDER_NAME, "openrouter");
  assert.equal(environment.PROVIDER_MODEL, "${DEVELOPER_AGENT_MODEL:-openai/gpt-5.4-image-2}");
  assert.equal(environment.OPENROUTER_IMAGE_MODEL, "${DEVELOPER_IMAGE_MODEL:-openai/gpt-5.4-image-2}");
  assert.match(environment.WORKER_TOOLS, /generate_image/);
  assert.match(environment.WORKER_SKILLS, /image-design/);
  assert.match(environment.AI_HARNESS_AGENT_INSTRUCTIONS, /primary output must be the generated image design files/);
});
