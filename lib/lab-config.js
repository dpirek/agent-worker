import { parseEnv } from 'node:util';
import { providerConfiguration } from './provider-config.js';

export function testEnvironment(source, base) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 64 * 1024) throw new Error('envConfig must be .env text under 64 KiB.');
  const parsed = parseEnv(source);
  const selected = Object.fromEntries(Object.entries(parsed).filter(([key]) =>
    /^(PROVIDER_|AI_HARNESS_|OPENROUTER_|CHROME_)/.test(key) || ['WORKER_NAME', 'WORKER_TOOLS', 'WORKER_MAX_TURNS'].includes(key)));
  const env = { ...base, ...selected, WORKER_WORKSPACE: base.WORKER_WORKSPACE };
  providerConfiguration(env);
  if (env.WORKER_MAX_TURNS && (!/^\d+$/.test(env.WORKER_MAX_TURNS) || Number(env.WORKER_MAX_TURNS) < 1 || Number(env.WORKER_MAX_TURNS) > 200)) {
    throw new Error('WORKER_MAX_TURNS must be between 1 and 200.');
  }
  return env;
}

export function testRedactor(env) {
  const secrets = Object.entries(env).filter(([key, value]) => /TOKEN|SECRET|PASSWORD|API_KEY/i.test(key) && typeof value === 'string' && value.length > 3).map(([, value]) => value);
  return value => {
    if (typeof value !== 'string') return value;
    for (const secret of secrets) value = value.replaceAll(secret, '[redacted]');
    return value;
  };
}
