import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createGenerateImageTool, imageEndpoint } from "../lib/tools/generate-image.js";

test("builds the dedicated OpenRouter Image API endpoint", () => {
  assert.equal(imageEndpoint({ PROVIDER_URL: "https://openrouter.ai/api/v1" }).href, "https://openrouter.ai/api/v1/images");
  assert.throws(() => imageEndpoint({ PROVIDER_URL: "https://models.example/v1" }), /openrouter\.ai/);
});

test("generates an image with GPT Image 2 and saves it in the workspace", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "worker-image-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  let request;
  const tool = createGenerateImageTool({
    env: {
      PROVIDER_URL: "https://openrouter.ai/api/v1",
      PROVIDER_API_KEY: "secret",
      OPENROUTER_IMAGE_MODEL: "openai/gpt-image-2",
    },
    resolvePath(relativePath) { return path.join(workspace, relativePath); },
    async fetchImpl(url, options) {
      request = { url: url.href, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from("fake-png-bytes").toString("base64"), media_type: "image/png" }],
        usage: { cost: 0.13 },
      }));
    },
  });

  const result = await tool.execute({
    prompt: "Editorial product photograph",
    path: "assets/hero",
    aspect_ratio: "16:9",
    quality: "high",
    format: "png",
    background: "opaque",
  });
  assert.equal(request.url, "https://openrouter.ai/api/v1/images");
  assert.equal(request.options.headers.authorization, "Bearer secret");
  assert.equal(request.body.model, "openai/gpt-image-2");
  assert.equal(request.body.aspect_ratio, "16:9");
  assert.equal(result.path, "assets/hero.png");
  assert.equal(result.mimeType, "image/png");
  assert.equal(await fs.readFile(path.join(workspace, "assets/hero.png"), "utf8"), "fake-png-bytes");
});
