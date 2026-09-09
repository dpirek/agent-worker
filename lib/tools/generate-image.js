import fs from "node:fs/promises";
import path from "node:path";

import { objectSchema } from "./shared.js";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MEDIA_TYPES = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
const EXTENSIONS = { png: ".png", jpeg: ".jpg", webp: ".webp" };

function imageEndpoint(env) {
  const configured = String(env.OPENROUTER_URL || env.PROVIDER_URL || "https://openrouter.ai/api/v1").trim();
  const url = new URL(configured);
  if (url.hostname !== "openrouter.ai" || !["https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("OPENROUTER_URL must be a credential-free https://openrouter.ai URL.");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/images`;
  url.search = "";
  url.hash = "";
  return url;
}

function createGenerateImageTool({ resolvePath, env = process.env, fetchImpl = fetch } = {}) {
  return {
    name: "generate_image",
    description: "Generate a bitmap design asset with OpenRouter's dedicated Image API and save it in the task workspace.",
    parameters: objectSchema({
      prompt: { type: "string", description: "Detailed visual prompt including composition, style, content, and exact text requirements." },
      path: { type: "string", description: "Workspace-relative output path. The matching extension is added when omitted." },
      aspect_ratio: { type: ["string", "null"], description: "Aspect ratio such as 1:1, 16:9, 9:16, 4:3, or 3:4; null uses the model default." },
      quality: { type: ["string", "null"], enum: ["auto", "low", "medium", "high", null], description: "Image quality; null defaults to high." },
      format: { type: ["string", "null"], enum: ["png", "jpeg", "webp", null], description: "Output format; null defaults to png." },
      background: { type: ["string", "null"], enum: ["auto", "transparent", "opaque", null], description: "Background mode; transparent requires png or webp." },
    }),
    async execute({ prompt, path: requestedPath, aspect_ratio: aspectRatio, quality, format, background }, { signal } = {}) {
      const text = String(prompt || "").trim();
      if (!text) throw new Error("prompt is required.");
      const apiKey = String(env.OPENROUTER_API_KEY || env.PROVIDER_API_KEY || "").trim();
      if (!apiKey) throw new Error("OPENROUTER_API_KEY or PROVIDER_API_KEY is required for image generation.");
      const outputFormat = format || "png";
      const extension = EXTENSIONS[outputFormat];
      let relativePath = String(requestedPath || "").trim().replaceAll("\\", "/");
      if (!relativePath) throw new Error("path is required.");
      if (!path.posix.extname(relativePath)) relativePath += extension;
      if (path.posix.extname(relativePath).toLowerCase() !== extension) {
        throw new Error(`path must use the ${extension} extension for format ${outputFormat}.`);
      }
      if (background === "transparent" && outputFormat === "jpeg") throw new Error("JPEG does not support a transparent background.");

      const requestBody = {
        model: String(env.OPENROUTER_IMAGE_MODEL || "openai/gpt-5.4-image-2"),
        prompt: text,
        n: 1,
        quality: quality || "high",
        output_format: outputFormat,
        ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
        ...(background ? { background } : {}),
      };
      const response = await fetchImpl(imageEndpoint(env), {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(180_000)])
          : AbortSignal.timeout(180_000),
      });
      const raw = await response.text();
      let payload;
      try { payload = JSON.parse(raw); } catch { throw new Error(`OpenRouter returned invalid JSON (HTTP ${response.status}).`); }
      if (!response.ok) throw new Error(payload.error?.message || payload.error || `OpenRouter returned HTTP ${response.status}.`);
      const encoded = payload.data?.[0]?.b64_json;
      if (typeof encoded !== "string" || !encoded) throw new Error("OpenRouter did not return image data.");
      const bytes = Buffer.from(encoded, "base64");
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("Generated image is empty or exceeds 25 MiB.");
      const mediaType = payload.data[0].media_type || MEDIA_TYPES[outputFormat];
      const target = resolvePath(relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
      return {
        ok: true,
        path: relativePath,
        mimeType: mediaType,
        bytes: bytes.length,
        model: requestBody.model,
        usage: payload.usage || null,
      };
    },
  };
}

export { createGenerateImageTool, imageEndpoint };
