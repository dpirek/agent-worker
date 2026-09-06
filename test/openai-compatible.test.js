import assert from "node:assert/strict";
import test from "node:test";

import { createModelClient } from "../lib/openai.js";

test("uses Chat Completions for an OpenRouter provider", async () => {
  let requestUrl;
  let requestBody;
  const client = createModelClient({
    name: "openrouter",
    url: "https://openrouter.ai/api/v1",
    apiKey: "secret",
    async fetchImpl(url, request) {
      requestUrl = url;
      requestBody = JSON.parse(request.body);
      return new Response(JSON.stringify({
        id: "response-1",
        choices: [{ message: { role: "assistant", content: "done" } }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const response = await client.createResponse({
    model: "openai/example-large",
    instructions: "Help the user.",
    input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
    tools: [],
  });

  assert.equal(requestUrl, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(requestBody.model, "openai/example-large");
  assert.equal(requestBody.messages[0].role, "system");
  assert.equal(response.output_text, "done");
});

test("uses the native Ollama API for an ollama-local provider", async () => {
  let requestUrl;
  let requestBody;
  const client = createModelClient({
    name: "ollama-local",
    url: "http://localhost:11434",
    async fetchImpl(url, request) {
      requestUrl = url;
      requestBody = JSON.parse(request.body);
      return new Response(JSON.stringify({
        message: { role: "assistant", content: "done locally" },
        prompt_eval_count: 4,
        eval_count: 2,
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const response = await client.createResponse({
    model: "qwen3-coder:30b",
    instructions: "Help the user.",
    input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
    tools: [],
  });

  assert.equal(requestUrl, "http://localhost:11434/api/chat");
  assert.equal(requestBody.model, "qwen3-coder:30b");
  assert.equal(requestBody.stream, false);
  assert.equal(response.output_text, "done locally");
});

test("reports the request URL, missing response, cause, and trace for fetch failures", async () => {
  const connectionError = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
    code: "ECONNREFUSED",
    address: "127.0.0.1",
    port: 11434,
  });
  const client = createModelClient({
    name: "ollama-local",
    url: "http://localhost:11434",
    async fetchImpl() {
      throw new TypeError("fetch failed", { cause: connectionError });
    },
  });

  await assert.rejects(
    client.createResponse({ model: "test-model", input: [], tools: [] }),
    (error) => {
      assert.match(error.message, /POST http:\/\/localhost:11434\/api\/chat/);
      assert.match(error.message, /ECONNREFUSED/);
      assert.deepEqual(error.details.request, {
        method: "POST",
        url: "http://localhost:11434/api/chat",
      });
      assert.equal(error.details.response, null);
      assert.equal(error.details.cause.cause.code, "ECONNREFUSED");
      assert.match(error.stack, /ProviderRequestError/);
      return true;
    },
  );
});

test("reports HTTP status and response body for provider failures", async () => {
  const client = createModelClient({
    name: "openrouter",
    url: "https://models.example/v1",
    async fetchImpl() {
      return new Response(JSON.stringify({ error: { message: "model unavailable" } }), {
        status: 503,
        statusText: "Service Unavailable",
      });
    },
  });

  await assert.rejects(
    client.createResponse({ model: "test-model", input: [], tools: [] }),
    (error) => {
      assert.equal(error.details.request.url, "https://models.example/v1/chat/completions");
      assert.equal(error.details.response.status, 503);
      assert.equal(error.details.response.statusText, "Service Unavailable");
      assert.match(error.details.response.body, /model unavailable/);
      return true;
    },
  );
});
