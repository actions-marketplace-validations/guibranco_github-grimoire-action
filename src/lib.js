'use strict';

const crypto = require('node:crypto');

/** Split a newline or comma separated input, trimming entries and dropping blanks and # comments. */
function parseList(value) {
  return String(value || '')
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && !entry.startsWith('#'));
}

/**
 * Parse "name" or "name=ENV_NAME" entries.
 * @returns {{ name: string, envName: string | null }[]}
 */
function parseMappings(value) {
  return parseList(value).map((entry) => {
    const index = entry.indexOf('=');
    if (index === -1) {
      return { name: entry, envName: null };
    }
    const name = entry.slice(0, index).trim();
    const envName = entry.slice(index + 1).trim();
    if (name === '') {
      throw new Error(`Invalid entry "${entry}": the name before = is empty.`);
    }
    if (envName !== '' && !isValidEnvName(envName)) {
      throw new Error(`Invalid variable name "${envName}" in "${entry}". Use letters, digits and _, not starting with a digit.`);
    }
    return { name, envName: envName || null };
  });
}

/**
 * Convert a Grimoire secret name or configuration key into an environment variable name.
 * Same rules as Pancake's Grimoire::toEnvironmentName(): ":" → "__", other symbols → "_", upper case.
 */
function toEnvironmentName(key) {
  return String(key)
    .replace(/:/g, '__')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .toUpperCase();
}

function isValidEnvName(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** Names GitHub reserves or that would break the runner if overwritten. */
const RESERVED = /^(GITHUB_.*|RUNNER_.*|ACTIONS_.*|CI|HOME|PATH|NODE_OPTIONS)$/i;

function variableName(name, explicit, prefix) {
  const result = explicit || `${prefix || ''}${toEnvironmentName(name)}`;
  if (!isValidEnvName(result)) {
    throw new Error(
      `"${name}" maps to "${result}", which is not a valid variable name. Choose one with ${name}=ENV_NAME.`,
    );
  }
  if (RESERVED.test(result)) {
    throw new Error(`"${name}" maps to the reserved variable "${result}". Choose another name with ${name}=ENV_NAME.`);
  }
  return result;
}

/**
 * Pick the configuration entries requested by the "configurations" input.
 * @param {Record<string,string>} all effective configuration from Grimoire
 * @param {string} selection "all", "none" or a list of keys / prefixes ending in *
 * @returns {{ entries: {key: string, value: string, envName: string|null}[], missing: string[] }}
 */
function selectConfigurations(all, selection) {
  const trimmed = String(selection || '').trim().toLowerCase();
  if (trimmed === 'none' || trimmed === 'false') {
    return { entries: [], missing: [] };
  }
  if (trimmed === '' || trimmed === 'all' || trimmed === 'true' || trimmed === '*') {
    return {
      entries: Object.entries(all).map(([key, value]) => ({ key, value, envName: null })),
      missing: [],
    };
  }

  const keys = Object.keys(all);
  const entries = [];
  const missing = [];
  const seen = new Set();

  for (const { name, envName } of parseMappings(selection)) {
    if (name.endsWith('*')) {
      if (envName) {
        throw new Error(`"${name}=${envName}": a wildcard can't be mapped to a single variable name.`);
      }
      const prefix = name.slice(0, -1).toLowerCase();
      const matches = keys.filter((key) => key.toLowerCase().startsWith(prefix));
      if (matches.length === 0) {
        missing.push(name);
      }
      for (const key of matches) {
        if (!seen.has(key)) {
          seen.add(key);
          entries.push({ key, value: all[key], envName: null });
        }
      }
      continue;
    }

    // Keys are case-insensitive in Grimoire.
    const key = keys.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    if (key === undefined) {
      missing.push(name);
      continue;
    }
    if (!seen.has(key)) {
      seen.add(key);
      entries.push({ key, value: all[key], envName });
    }
  }

  return { entries, missing };
}

/** Delimiter for multi-line values in GITHUB_ENV / GITHUB_OUTPUT that can't occur in the value. */
function heredoc(name, value) {
  let delimiter;
  do {
    delimiter = `ghadelimiter_${crypto.randomUUID()}`;
  } while (value.includes(delimiter));
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
}

/** Quote a value for a dotenv file (double quotes, escaped). */
function dotenvLine(name, value) {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  return `${name}="${escaped}"\n`;
}

/** Workflow command to mask a value; every line separately, since masks apply per line. */
function maskCommands(value) {
  return String(value)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => `::add-mask::${escapeData(line)}\n`)
    .join('');
}

function escapeData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

class GrimoireError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GrimoireError';
    this.status = status;
  }
}

/** Minimal Grimoire Consumer API client using the built-in fetch. */
class GrimoireClient {
  /**
   * @param {{ url: string, apiKey: string, environment: string, timeoutMs?: number, retries?: number,
   *           fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>, userAgent?: string }} options
   */
  constructor(options) {
    this.baseUrl = String(options.url).replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.environment = options.environment;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.retries = options.retries ?? 2;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.userAgent = options.userAgent ?? 'github-grimoire-action';
  }

  async request(path) {
    const url = `${this.baseUrl}${path}`;
    let lastError;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        await this.sleep(500 * 2 ** (attempt - 1));
      }

      let response;
      try {
        response = await this.fetch(url, {
          headers: { 'X-Api-Key': this.apiKey, Accept: 'application/json', 'User-Agent': this.userAgent },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        lastError = new GrimoireError(`Could not reach Grimoire at ${this.baseUrl}: ${error.message}`, -1);
        continue;
      }

      if (response.status >= 500) {
        lastError = new GrimoireError(`Grimoire returned HTTP ${response.status} for ${path.split('?')[0]}.`, response.status);
        continue;
      }

      return response;
    }

    throw lastError;
  }

  async json(response, what) {
    if (response.status === 401 || response.status === 403) {
      throw new GrimoireError(
        `Grimoire rejected the API key while reading ${what} (HTTP ${response.status}).`,
        response.status,
      );
    }
    if (!response.ok) {
      throw new GrimoireError(`Grimoire returned HTTP ${response.status} while reading ${what}.`, response.status);
    }
    try {
      return await response.json();
    } catch {
      throw new GrimoireError(`Grimoire returned invalid JSON while reading ${what}.`, response.status);
    }
  }

  /** @returns {Promise<string|null>} the secret value, or null when it has no active value */
  async getSecret(name) {
    const response = await this.request(
      `/consumer/secrets/${encodeURIComponent(name)}?environment=${encodeURIComponent(this.environment)}`,
    );
    if (response.status === 404) {
      return null;
    }
    const body = await this.json(response, `secret "${name}"`);
    if (typeof body?.value !== 'string') {
      throw new GrimoireError(`Grimoire returned no value for secret "${name}".`, response.status);
    }
    return body.value;
  }

  /** @returns {Promise<Record<string,string>>} effective configuration for the environment */
  async getConfigurations() {
    const response = await this.request(`/consumer/configurations?environment=${encodeURIComponent(this.environment)}`);
    if (response.status === 404) {
      throw new GrimoireError(`Environment "${this.environment}" was not found in Grimoire.`, 404);
    }
    const body = await this.json(response, 'configurations');
    if (!Array.isArray(body?.items)) {
      throw new GrimoireError('Grimoire returned a configuration list without "items".', response.status);
    }
    const result = {};
    for (const item of body.items) {
      if (item && typeof item.key === 'string') {
        result[item.key] = item.value == null ? '' : String(item.value);
      }
    }
    return result;
  }
}

module.exports = {
  GrimoireClient,
  GrimoireError,
  dotenvLine,
  heredoc,
  isValidEnvName,
  maskCommands,
  parseList,
  parseMappings,
  selectConfigurations,
  toEnvironmentName,
  variableName,
};
