import assert from "node:assert/strict";
import test from "node:test";

import { environmentSystemPrompts } from "../lib/env-config.js";

test("maps system prompt environment variables to harness prompt names", () => {
  assert.deepEqual(environmentSystemPrompts({
    AI_HARNESS_AGENT_INSTRUCTIONS: "Custom agent instructions",
    AI_HARNESS_RESPONSE_FORMAT: "Use Markdown and {{resource_base_url}}",
    AI_HARNESS_TOOL_CONTRACT: "Custom tool contract: {{tools}}",
  }), {
    agent_instructions: "Custom agent instructions",
    response_format: "Use Markdown and {{resource_base_url}}",
    tool_contract: "Custom tool contract: {{tools}}",
  });
});
