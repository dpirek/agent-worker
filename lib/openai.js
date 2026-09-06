import {
  defaultBaseUrlForProvider,
  isOllamaProvider,
  normalizeProvider,
} from "./provider-config.js";

const MAX_RESPONSE_DETAIL_CHARS = 20_000;

function diagnosticUrl(value) {
  try {
    const url = new URL(value);
    if (url.username) url.username = "[redacted]";
    if (url.password) url.password = "[redacted]";
    for (const key of url.searchParams.keys()) {
      if (/(?:api[_-]?key|token|secret|password|auth)/i.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.toString();
  } catch {
    return String(value);
  }
}

function errorCauseDetails(error, depth = 0) {
  if (!error || depth > 4) return null;
  const details = {};
  for (const key of ["name", "message", "code", "errno", "syscall", "address", "port", "stack"]) {
    if (error[key] !== undefined) details[key] = error[key];
  }
  const cause = error.cause ? errorCauseDetails(error.cause, depth + 1) : null;
  if (cause) details.cause = cause;
  return Object.keys(details).length > 0 ? details : { message: String(error) };
}

function requestDetails(url, options = {}) {
  return { method: String(options.method || "GET").toUpperCase(), url: diagnosticUrl(url) };
}

async function fetchWithDiagnostics(fetchImpl, url, options, providerName) {
  try {
    return await fetchImpl(url, options);
  } catch (cause) {
    const causeMessage = cause?.cause?.message && cause.cause.message !== cause.message
      ? `: ${cause.cause.message}`
      : "";
    const error = new Error(
      `${providerName} request failed (${requestDetails(url, options).method} ${diagnosticUrl(url)}): ${cause?.message || String(cause)}${causeMessage}`,
      { cause },
    );
    error.name = "ProviderRequestError";
    error.details = {
      request: requestDetails(url, options),
      response: null,
      cause: errorCauseDetails(cause),
    };
    throw error;
  }
}

function responseBodyDetails(raw) {
  const text = String(raw ?? "");
  if (text.length <= MAX_RESPONSE_DETAIL_CHARS) return { body: text, truncated: false };
  return { body: text.slice(0, MAX_RESPONSE_DETAIL_CHARS), truncated: true };
}

function responseHeaderDetails(response) {
  const headers = {};
  for (const [name, value] of response.headers || []) {
    headers[name] = /(?:authorization|cookie|api[_-]?key|token|secret)/i.test(name) ? "[redacted]" : value;
  }
  return headers;
}

function responseError(message, url, options, response, raw, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "ProviderResponseError";
  error.details = {
    request: requestDetails(url, options),
    response: {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaderDetails(response),
      ...responseBodyDetails(raw),
    },
    ...(cause ? { cause: errorCauseDetails(cause) } : {}),
  };
  return error;
}

async function readResponseText(response, url, options, providerName) {
  try {
    return await response.text();
  } catch (cause) {
    throw responseError(
      `${providerName} response body could not be read (HTTP ${response.status}): ${cause?.message || String(cause)}`,
      url,
      options,
      response,
      "",
      cause,
    );
  }
}

async function readSse(response, onEvent) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Streaming response body is not readable.");
  const decoder = new TextDecoder();
  let buffer = "";
  const handleEventText = (eventText) => {
    for (const line of eventText.split(/\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      onEvent(JSON.parse(data));
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";
    for (const eventText of events) {
      handleEventText(eventText);
    }
  }
  if (buffer.trim()) handleEventText(buffer);
}

function inputText(input = []) {
  return input
    .flatMap((item) => item.content || [])
    .filter((content) => content.type === "input_text")
    .map((content) => content.text)
    .join("\n");
}

function inputImages(input = []) {
  return input
    .flatMap((item) => item.content || [])
    .filter((content) => content.type === "input_image" && content.image_url)
    .map((content) => content.image_url);
}

function base64Image(dataUrl) {
  return String(dataUrl).replace(/^data:image\/[A-Za-z0-9.+-]+;base64,/, "");
}

function toolMessages(input = []) {
  return input
    .filter((item) => item.type === "function_call_output")
    .map((item) => ({
      role: "tool",
      content: item.output,
      tool_name: item.call_id,
    }));
}

function ollamaToolDefinition(tool) {
  if (tool.type === "mcp") return null;
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function stringifyToolArguments(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value || {});
}

function taggedParameterValue(raw, schema = {}) {
  const value = raw.trim();
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("integer") && /^-?\d+$/.test(value)) return Number(value);
  if (types.includes("number") && /^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);
  if (types.includes("boolean") && /^(true|false)$/i.test(value)) return value === "true";
  if (types.includes("null") && value === "null") return null;
  if (types.includes("array") || types.includes("object")) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

// Some local models print their tool protocol as text instead of returning the
// native Ollama `tool_calls` field. Normalize that common protocol so the agent
// loop can execute it exactly like a native call.
function parseTaggedToolCalls(content, tools = []) {
  const definitions = new Map(tools.map((tool) => [tool.function?.name, tool.function]));
  const calls = [];
  const blockPattern = /(?:<tool_call>\s*)?<function=([A-Za-z_][\w.-]*)>\s*([\s\S]*?)<\/function>\s*(?:<\/tool_call>)?/g;
  const remaining = String(content || "").replace(blockPattern, (block, name, body) => {
    const definition = definitions.get(name);
    if (!definition) return block;
    const args = {};
    const parameterPattern = /<parameter=([A-Za-z_][\w.-]*)>\s*([\s\S]*?)<\/parameter>/g;
    for (const match of body.matchAll(parameterPattern)) {
      const parameterSchema = definition.parameters?.properties?.[match[1]] || {};
      args[match[1]] = taggedParameterValue(match[2], parameterSchema);
    }
    calls.push({
      function: { name, arguments: args },
    });
    return "";
  }).trim();
  return { calls, content: remaining };
}

function ollamaToolsUnsupported(status, data, raw) {
  const message = String(data?.error || raw || "");
  return status === 400 && /does not support tools/i.test(message);
}

function chatToolDefinitions(tools = []) {
  return tools.filter((tool) => tool.type === "function" && tool.name).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function chatInputMessages(input = []) {
  return input.flatMap((item) => {
    if (item.type === "function_call_output") {
      return [{
        role: "tool",
        tool_call_id: item.call_id,
        content: String(item.output || ""),
      }];
    }
    if (!item.role || !Array.isArray(item.content)) return [];
    const text = item.content
      .filter((part) => part.type === "input_text")
      .map((part) => part.text)
      .join("\n");
    const images = item.content
      .filter((part) => part.type === "input_image" && part.image_url)
      .map((part) => ({ type: "image_url", image_url: { url: part.image_url } }));
    return [{
      role: item.role,
      content: images.length > 0
        ? [{ type: "text", text }, ...images]
        : text,
    }];
  });
}

function normalizedChatUsage(usage = {}) {
  return {
    input_tokens: Number(usage.prompt_tokens) || 0,
    output_tokens: Number(usage.completion_tokens) || 0,
  };
}

function normalizedChatResponse(id, message, usage = {}) {
  const calls = (message.tool_calls || []).map((call, index) => ({
    type: "function_call",
    name: call.function?.name,
    call_id: call.id || `call_${index + 1}`,
    arguments: stringifyToolArguments(call.function?.arguments),
  }));
  const result = { id, usage: normalizedChatUsage(usage), output: calls };
  if (calls.length === 0) {
    result.output_text = String(message.content || "");
    result.output = [{
      type: "message",
      content: [{ type: "output_text", text: result.output_text }],
    }];
  }
  return result;
}

class ChatCompletionsClient {
  constructor({ apiKey, baseUrl, providerName = "Provider", fetchImpl = fetch }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.providerName = providerName;
    this.fetch = fetchImpl;
    this.histories = new Map();
  }

  headers() {
    return {
      "content-type": "application/json",
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  requestMessages(body) {
    const previous = body.previous_response_id
      ? this.histories.get(body.previous_response_id) || []
      : [];
    const messages = structuredClone(previous);
    if (body.instructions) {
      const system = { role: "system", content: body.instructions };
      if (messages[0]?.role === "system") messages[0] = system;
      else messages.unshift(system);
    }
    messages.push(...chatInputMessages(body.input));
    return messages;
  }

  requestBody(body, messages, stream = false) {
    const tools = chatToolDefinitions(body.tools);
    return {
      model: body.model,
      messages,
      ...(tools.length > 0 ? { tools, tool_choice: body.tool_choice || "auto" } : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
  }

  remember(id, messages, message) {
    this.histories.set(id, structuredClone([...messages, message]));
    if (this.histories.size > 100) this.histories.delete(this.histories.keys().next().value);
  }

  async createResponse(body, { onTextDelta } = {}) {
    const messages = this.requestMessages(body);
    if (onTextDelta) return this.createStreamingResponse(body, messages, onTextDelta);
    const url = `${this.baseUrl}/chat/completions`;
    const options = {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.requestBody(body, messages)),
    };
    const response = await fetchWithDiagnostics(this.fetch, url, options, this.providerName);
    const raw = await readResponseText(response, url, options, this.providerName);
    let data;
    try {
      data = JSON.parse(raw);
    } catch (cause) {
      throw responseError(`${this.providerName} returned invalid JSON (HTTP ${response.status}): ${raw}`, url, options, response, raw, cause);
    }
    if (!response.ok) {
      throw responseError(`${this.providerName} API error (HTTP ${response.status}): ${data.error?.message || raw}`, url, options, response, raw);
    }
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error(`${this.providerName} returned no assistant message.`);
    const id = data.id || `chat_${Date.now()}`;
    this.remember(id, messages, message);
    return normalizedChatResponse(id, message, data.usage);
  }

  async createStreamingResponse(body, messages, onTextDelta) {
    const url = `${this.baseUrl}/chat/completions`;
    const options = {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(this.requestBody(body, messages, true)),
    };
    const response = await fetchWithDiagnostics(this.fetch, url, options, this.providerName);
    if (!response.ok) {
      const raw = await readResponseText(response, url, options, this.providerName);
      let data;
      try {
        data = JSON.parse(raw);
      } catch (cause) {
        throw responseError(`${this.providerName} returned invalid JSON (HTTP ${response.status}): ${raw}`, url, options, response, raw, cause);
      }
      throw responseError(`${this.providerName} API error (HTTP ${response.status}): ${data.error?.message || raw}`, url, options, response, raw);
    }

    let id = `chat_${Date.now()}`;
    let content = "";
    let reasoningContent = "";
    let usage = {};
    const toolCalls = [];
    await readSse(response, (chunk) => {
      if (chunk.error) throw new Error(`${this.providerName} API error: ${chunk.error.message || JSON.stringify(chunk.error)}`);
      if (chunk.id) id = chunk.id;
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return;
      if (delta.content) {
        content += delta.content;
        onTextDelta(delta.content);
      }
      if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
      for (const fragment of delta.tool_calls || []) {
        const index = Number(fragment.index) || 0;
        toolCalls[index] ||= { id: "", type: "function", function: { name: "", arguments: "" } };
        if (fragment.id) toolCalls[index].id = fragment.id;
        if (fragment.type) toolCalls[index].type = fragment.type;
        if (fragment.function?.name) toolCalls[index].function.name += fragment.function.name;
        if (fragment.function?.arguments) toolCalls[index].function.arguments += fragment.function.arguments;
      }
    });
    const message = {
      role: "assistant",
      content: content || null,
      ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
    this.remember(id, messages, message);
    return normalizedChatResponse(id, message, usage);
  }
}

class OllamaClient {
  constructor({ baseUrl = "http://localhost:11434", fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.fetch = fetchImpl;
    this.messages = [];
  }

  async createResponse(body, { onTextDelta } = {}) {
    const text = inputText(body.input);
    const images = inputImages(body.input);
    if (!body.previous_response_id) {
      this.messages = [{ role: "system", content: body.instructions }];
    }
    this.messages.push(...toolMessages(body.input));
    if (text || images.length > 0) {
      this.messages.push({
        role: "user",
        content: text,
        ...(images.length > 0 ? { images: images.map(base64Image) } : {}),
      });
    }

    const tools = (body.tools || []).map(ollamaToolDefinition).filter(Boolean);
    const requestBody = {
      model: body.model,
      messages: this.messages,
      stream: Boolean(onTextDelta),
    };
    if (tools.length > 0) requestBody.tools = tools;

    const url = `${this.baseUrl}/api/chat`;
    const options = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    };
    let response = await fetchWithDiagnostics(this.fetch, url, options, "Ollama");

    if (onTextDelta && response.ok) {
      return this.readStreamingChatResponse(response, onTextDelta, tools);
    }

    let raw = await readResponseText(response, url, options, "Ollama");
    let data;
    try {
      data = JSON.parse(raw);
    } catch (cause) {
      throw responseError(`Ollama returned invalid JSON (HTTP ${response.status}): ${raw}`, url, options, response, raw, cause);
    }
    if (!response.ok && tools.length > 0 && ollamaToolsUnsupported(response.status, data, raw)) {
      const fallbackOptions = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...requestBody, tools: undefined }),
      };
      response = await fetchWithDiagnostics(this.fetch, url, fallbackOptions, "Ollama");
      if (onTextDelta && response.ok) {
        return this.readStreamingChatResponse(response, onTextDelta, []);
      }
      raw = await readResponseText(response, url, fallbackOptions, "Ollama");
      try {
        data = JSON.parse(raw);
      } catch (cause) {
        throw responseError(`Ollama returned invalid JSON (HTTP ${response.status}): ${raw}`, url, fallbackOptions, response, raw, cause);
      }
    }
    if (!response.ok) {
      throw responseError(`Ollama API error (HTTP ${response.status}): ${data.error || raw}`, url, options, response, raw);
    }

    const message = data.message || {};
    const tagged = message.tool_calls?.length
      ? { calls: [], content: message.content || "" }
      : parseTaggedToolCalls(message.content, tools);
    const normalizedToolCalls = message.tool_calls?.length ? message.tool_calls : tagged.calls;
    this.messages.push({
      role: "assistant",
      content: tagged.content,
      tool_calls: normalizedToolCalls,
    });

    const id = `ollama_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const toolCalls = normalizedToolCalls.map((call, index) => ({
      type: "function_call",
      name: call.function?.name || call.name,
      call_id: call.id || `call_${index + 1}`,
      arguments: stringifyToolArguments(call.function?.arguments || call.arguments),
    }));

    const usage = {
      input_tokens: Number(data.prompt_eval_count) || 0,
      output_tokens: Number(data.eval_count) || 0,
    };
    if (toolCalls.length > 0) return { id, output: toolCalls, usage };
    return {
      id,
      usage,
      output_text: tagged.content,
      output: [{
        type: "message",
        content: [{ type: "output_text", text: tagged.content }],
      }],
    };
  }

  async readStreamingChatResponse(response, onTextDelta, tools = []) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Ollama streaming response body is not readable.");
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let toolCalls = [];
    let contentMode = null;
    let usage = { input_tokens: 0, output_tokens: 0 };
    const handleLine = (line) => {
      if (!line.trim()) return;
      const data = JSON.parse(line);
      const message = data.message || {};
      if (message.content) {
        content += message.content;
        if (!contentMode && content.trim()) {
          contentMode = content.trimStart().startsWith("<") ? "possible_tool" : "text";
        }
        if (contentMode === "text") onTextDelta(message.content);
      }
      if (message.tool_calls) toolCalls = message.tool_calls;
      if (Number.isFinite(data.prompt_eval_count)) usage.input_tokens = data.prompt_eval_count;
      if (Number.isFinite(data.eval_count)) usage.output_tokens = data.eval_count;
      if (data.error) throw new Error(`Ollama API error: ${data.error}`);
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        handleLine(line);
      }
    }
    handleLine(buffer);

    const tagged = toolCalls.length > 0
      ? { calls: [], content }
      : parseTaggedToolCalls(content, tools);
    if (toolCalls.length === 0) toolCalls = tagged.calls;
    if (toolCalls.length === 0 && tagged.content && contentMode !== "text") {
      onTextDelta(tagged.content);
    }
    const message = { role: "assistant", content: tagged.content, tool_calls: toolCalls };
    this.messages.push(message);
    const id = `ollama_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const outputCalls = (toolCalls || []).map((call, index) => ({
      type: "function_call",
      name: call.function?.name || call.name,
      call_id: call.id || `call_${index + 1}`,
      arguments: stringifyToolArguments(call.function?.arguments || call.arguments),
    }));

    if (outputCalls.length > 0) return { id, output: outputCalls, usage };
    return {
      id,
      usage,
      output_text: tagged.content,
      output: [{
        type: "message",
        content: [{ type: "output_text", text: tagged.content }],
      }],
    };
  }
}

function createModelClient({
  name = "openai",
  url,
  apiKey = "",
  fetchImpl = fetch,
} = {}) {
  const normalizedProvider = normalizeProvider(name);
  if (isOllamaProvider(normalizedProvider)) {
    return new OllamaClient({
      baseUrl: url || defaultBaseUrlForProvider("ollama"),
      fetchImpl,
    });
  }
  // All hosted providers use the broadly supported OpenAI-compatible Chat
  // Completions protocol. The provider name is identity, not an API selector.
  return new ChatCompletionsClient({
    apiKey,
    baseUrl: url || defaultBaseUrlForProvider("openai"),
    providerName: normalizedProvider,
    fetchImpl,
  });
}

export { createModelClient };
