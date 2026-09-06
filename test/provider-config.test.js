import assert from "node:assert/strict";
import test from "node:test";

import { providerConfiguration } from "../lib/provider-config.js";

test("reads a provider through the generic four-field contract", () => {
  assert.deepEqual(providerConfiguration({
    PROVIDER_NAME: "openrouter",
    PROVIDER_URL: "https://openrouter.ai/api/v1",
    PROVIDER_API_KEY: "secret",
    PROVIDER_MODEL: "openai/example-large",
  }), {
    name: "openrouter",
    url: "https://openrouter.ai/api/v1",
    apiKey: "secret",
    model: "openai/example-large",
  });
});

test("supplies adapter defaults when optional provider fields are empty", () => {
  assert.deepEqual(providerConfiguration({ PROVIDER_NAME: "ollama-local" }), {
    name: "ollama-local",
    url: "http://localhost:11434",
    apiKey: "",
    model: "llama3.1",
  });
});
