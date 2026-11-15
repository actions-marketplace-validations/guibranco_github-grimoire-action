'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  GrimoireClient,
  dotenvLine,
  heredoc,
  maskCommands,
  parseMappings,
  selectConfigurations,
  variableName,
} = require('./lib');

/** Read an action input the way the runner passes it (INPUT_<NAME>, hyphens kept). */
function input(env, name, fallback = '') {
  const value = env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  return value === undefined ? fallback : value.trim();
}

function bool(env, name, fallback) {
  const value = input(env, name, String(fallback)).toLowerCase();
  if (['true', 'yes', '1', 'on'].includes(value)) return true;
  if (['false', 'no', '0', 'off', ''].includes(value)) return value === '' ? fallback : false;
  throw new Error(`Input "${name}" must be true or false, got "${value}".`);
}

function positiveInt(env, name, fallback) {
  const raw = input(env, name, String(fallback));
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Input "${name}" must be a whole number, got "${raw}".`);
  }
  return value;
}

/** Run a function over items with at most `limit` in flight, preserving order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Run the action.
 * @param {NodeJS.ProcessEnv} env
 * @param {{ write: (text: string) => void }} out where workflow commands and logs go
 * @param {{ fetch?: typeof fetch, sleep?: (ms: number) => Promise<void> }} [deps]
 * @returns {Promise<number>} exit code
 */
async function run(env, out, deps = {}) {
  const log = (text) => out.write(`${text}\n`);
  const error = (text) => out.write(`::error::${text.replace(/\r?\n/g, '%0A')}\n`);
  const warning = (text) => out.write(`::warning::${text.replace(/\r?\n/g, '%0A')}\n`);

  try {
    const url = input(env, 'url');
    const apiKey = input(env, 'api-key');
    const environment = input(env, 'environment');
    if (!url) throw new Error('Input "url" is required.');
    if (!apiKey) throw new Error('Input "api-key" is required.');
    if (!environment) throw new Error('Input "environment" is required.');
    if (!/^https?:\/\//i.test(url)) throw new Error(`Input "url" must start with http:// or https://, got "${url}".`);
    if (/^http:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url)) {
      warning('The Grimoire URL uses plain HTTP: the API key and secrets travel unencrypted.');
    }

    // Never let the key show up in logs, even if a later error echoes a URL or header.
    out.write(maskCommands(apiKey));

    const secretMappings = parseMappings(input(env, 'secrets'));
    const configurationSelection = input(env, 'configurations', 'all');
    const prefix = input(env, 'prefix');
    const exportEnv = bool(env, 'export-env', true);
    const setOutputs = bool(env, 'set-outputs', true);
    const maskConfigurations = bool(env, 'mask-configurations', false);
    const failOnMissing = bool(env, 'fail-on-missing', true);
    const envFile = input(env, 'env-file');
    const timeoutMs = positiveInt(env, 'timeout', 30) * 1000;
    const retries = positiveInt(env, 'retries', 2);

    const client = new GrimoireClient({
      url,
      apiKey,
      environment,
      timeoutMs,
      retries,
      fetch: deps.fetch,
      sleep: deps.sleep,
    });

    const loadConfigurations = !['none', 'false'].includes(configurationSelection.toLowerCase());
    const allConfigurations = loadConfigurations ? await client.getConfigurations() : {};
    const { entries: configEntries, missing } = selectConfigurations(allConfigurations, configurationSelection);

    const secretValues = await mapLimit(secretMappings, 5, (mapping) => client.getSecret(mapping.name));

    /** @type {Map<string, {source: string, name: string, value: string, secret: boolean}>} */
    const variables = new Map();

    for (const entry of configEntries) {
      const name = variableName(entry.key, entry.envName, prefix);
      if (variables.has(name)) {
        warning(`Configuration keys "${variables.get(name).name}" and "${entry.key}" both map to ${name}; using "${entry.key}".`);
      }
      variables.set(name, { source: 'configuration', name: entry.key, value: entry.value, secret: false });
    }

    secretMappings.forEach((mapping, index) => {
      const value = secretValues[index];
      if (value === null) {
        missing.push(mapping.name);
        return;
      }
      const name = variableName(mapping.name, mapping.envName, prefix);
      const existing = variables.get(name);
      if (existing?.source === 'secret') {
        throw new Error(`Secrets "${existing.name}" and "${mapping.name}" both map to ${name}. Rename one with =ENV_NAME.`);
      }
      if (existing) {
        warning(`Secret "${mapping.name}" and configuration key "${existing.name}" both map to ${name}; the secret wins.`);
      }
      variables.set(name, { source: 'secret', name: mapping.name, value, secret: true });
    });

    // Mask before anything else can print a value.
    for (const variable of variables.values()) {
      if (variable.secret || maskConfigurations) {
        out.write(maskCommands(variable.value));
      }
    }

    if (missing.length > 0) {
      const message = `No value in Grimoire environment "${environment}" for: ${missing.join(', ')}`;
      if (failOnMissing) {
        throw new Error(message);
      }
      warning(message);
    }

    if (exportEnv) {
      if (!env.GITHUB_ENV) throw new Error('GITHUB_ENV is not set: export-env only works inside GitHub Actions.');
      fs.appendFileSync(env.GITHUB_ENV, [...variables].map(([name, v]) => heredoc(name, v.value)).join(''));
    }

    const outputs = [];
    if (setOutputs) {
      for (const [name, v] of variables) outputs.push(heredoc(name, v.value));
    }
    outputs.push(heredoc('loaded', String(variables.size)));
    outputs.push(heredoc('variables', JSON.stringify([...variables.keys()])));
    outputs.push(heredoc('missing', JSON.stringify(missing)));
    if (env.GITHUB_OUTPUT) {
      fs.appendFileSync(env.GITHUB_OUTPUT, outputs.join(''));
    }

    if (envFile) {
      const target = path.resolve(env.GITHUB_WORKSPACE || process.cwd(), envFile);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, [...variables].map(([name, v]) => dotenvLine(name, v.value)).join(''), { mode: 0o600 });
      fs.chmodSync(target, 0o600);
      warning(`Wrote ${variables.size} values, including secrets, to ${envFile}. Don't upload it as an artifact.`);
    }

    const secrets = [...variables.values()].filter((v) => v.secret).length;
    log(`Loaded ${secrets} secret(s) and ${variables.size - secrets} configuration value(s) from Grimoire (${environment}).`);
    for (const [name, v] of variables) {
      log(`  ${name} ← ${v.source} "${v.name}"`);
    }

    if (env.GITHUB_STEP_SUMMARY) {
      const rows = [...variables].map(([name, v]) => `| \`${name}\` | ${v.source} | \`${v.name.replace(/\|/g, '\\|')}\` |`);
      const summary = [
        `### 🔮 Grimoire: ${variables.size} value(s) loaded from \`${environment}\``,
        '',
        '| Variable | Source | Grimoire name |',
        '| --- | --- | --- |',
        ...rows,
        '',
        missing.length > 0 ? `⚠️ Missing: ${missing.map((m) => `\`${m}\``).join(', ')}\n` : '',
      ].join('\n');
      fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
    }

    return 0;
  } catch (e) {
    error(e.message);
    return 1;
  }
}

module.exports = { run, input, bool };

if (require.main === module) {
  run(process.env, process.stdout).then((code) => {
    process.exitCode = code;
  });
}
