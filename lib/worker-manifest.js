import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

import { parseYaml } from "./yaml.js";

const VARIABLE_PATTERN = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:-|-|:\?|\?)([^}]*))?\}/g;

function interpolate(value, source) {
  return String(value).replace(VARIABLE_PATTERN, (match, name, operator, operand = "") => {
    if (match === "$$") return "$";
    const exists = Object.hasOwn(source, name);
    const current = exists ? String(source[name]) : "";
    if (!operator) return current;
    if (operator === ":-") return current ? current : operand;
    if (operator === "-") return exists ? current : operand;
    if (operator === ":?") {
      if (current) return current;
      throw new Error(operand || `${name} must be set and non-empty.`);
    }
    if (operator === "?") {
      if (exists) return current;
      throw new Error(operand || `${name} must be set.`);
    }
    return "";
  });
}

function envFileList(value) {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error("env_file must be a path or an array of paths.");
  }
  return values.map((entry) => entry.trim());
}

function environmentEntries(value = {}) {
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry !== "string") throw new Error("environment array entries must be strings.");
      const separator = entry.indexOf("=");
      return separator === -1 ? [entry, null] : [entry.slice(0, separator), entry.slice(separator + 1)];
    });
  }
  if (!value || typeof value !== "object") throw new Error("environment must be an object or an array.");
  return Object.entries(value);
}

function selectService(manifest, requestedName) {
  const services = manifest?.services;
  if (!services || typeof services !== "object" || Array.isArray(services)) {
    throw new Error("The worker manifest must contain a services object.");
  }
  const names = Object.keys(services);
  if (names.length === 0) throw new Error("The worker manifest must define at least one service.");
  const name = requestedName || (names.length === 1 ? names[0] : "");
  if (!name) throw new Error(`Choose a service with --service. Available services: ${names.join(", ")}`);
  if (!Object.hasOwn(services, name)) throw new Error(`Unknown service "${name}". Available services: ${names.join(", ")}`);
  const service = services[name];
  if (!service || typeof service !== "object" || Array.isArray(service)) throw new Error(`Service "${name}" must be an object.`);
  return { name, service };
}

function readWorkerManifest({ filePath = "agent-worker.yaml", serviceName, hostEnv = process.env } = {}) {
  const absolutePath = path.resolve(filePath);
  let manifest;
  try {
    manifest = parseYaml(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read worker manifest ${absolutePath}: ${error.message}`, { cause: error });
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("The worker manifest must be a YAML object.");
  if (manifest.version !== undefined && String(manifest.version) !== "1") throw new Error(`Unsupported worker manifest version: ${manifest.version}`);

  const { name, service } = selectService(manifest, serviceName);
  const directory = path.dirname(absolutePath);
  const fileEnv = {};
  for (const envFile of envFileList(service.env_file)) {
    const envPath = path.resolve(directory, envFile);
    try {
      Object.assign(fileEnv, parseEnv(fs.readFileSync(envPath, "utf8")));
    } catch (error) {
      throw new Error(`Unable to read env_file ${envPath}: ${error.message}`, { cause: error });
    }
  }

  const interpolationSource = { ...fileEnv, ...hostEnv };
  const configuredEnv = {};
  for (const [rawKey, rawValue] of environmentEntries(service.environment)) {
    const key = String(rawKey).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${rawKey}`);
    if (rawValue === null) {
      if (Object.hasOwn(interpolationSource, key)) configuredEnv[key] = String(interpolationSource[key]);
      continue;
    }
    if (!["string", "number", "boolean"].includes(typeof rawValue)) {
      throw new Error(`Environment value for ${key} must be a string, number, boolean, or null.`);
    }
    configuredEnv[key] = interpolate(rawValue, interpolationSource);
  }

  return {
    version: "1",
    serviceName: name,
    manifestPath: absolutePath,
    directory,
    env: { ...fileEnv, ...hostEnv, ...configuredEnv },
  };
}

export { interpolate, readWorkerManifest };
