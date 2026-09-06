const PROVIDER_DEFAULTS = Object.freeze({
  openai: Object.freeze({ url: "https://api.openai.com/v1", model: "gpt-5.1-codex" }),
  ollama: Object.freeze({ url: "http://localhost:11434", model: "llama3.1" }),
  custom: Object.freeze({ url: "http://localhost:8000/v1", model: "custom-model" }),
});

function normalizeProvider(value) {
  const name = String(value || "openai").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new Error("PROVIDER_NAME must contain only letters, numbers, dots, underscores, or hyphens.");
  }
  return name;
}

function isOllamaProvider(value) {
  return /^ollama(?:[._-]|$)/.test(normalizeProvider(value));
}

function providerConfiguration(env = process.env) {
  const name = normalizeProvider(env.PROVIDER_NAME);
  const defaults = PROVIDER_DEFAULTS[name] || (
    isOllamaProvider(name) ? PROVIDER_DEFAULTS.ollama : { url: "", model: "" }
  );
  const configuration = {
    name,
    url: String(env.PROVIDER_URL || defaults.url).trim(),
    apiKey: String(env.PROVIDER_API_KEY || "").trim(),
    model: String(env.PROVIDER_MODEL || defaults.model).trim(),
  };
  if (!configuration.url) throw new Error(`PROVIDER_URL is required for provider "${name}".`);
  if (!configuration.model) throw new Error(`PROVIDER_MODEL is required for provider "${name}".`);
  return configuration;
}

function defaultModelForProvider(provider) {
  const name = normalizeProvider(provider);
  return (PROVIDER_DEFAULTS[name] || (isOllamaProvider(name) ? PROVIDER_DEFAULTS.ollama : {})).model || "";
}

function defaultBaseUrlForProvider(provider) {
  const name = normalizeProvider(provider);
  return (PROVIDER_DEFAULTS[name] || (isOllamaProvider(name) ? PROVIDER_DEFAULTS.ollama : {})).url || "";
}

export {
  defaultBaseUrlForProvider,
  defaultModelForProvider,
  isOllamaProvider,
  normalizeProvider,
  providerConfiguration,
};
