'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/main');
const { API_KEY, createFetch } = require('./mock-grimoire');

function setup(inputs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grimoire-action-'));
  const files = {
    GITHUB_ENV: path.join(dir, 'env'),
    GITHUB_OUTPUT: path.join(dir, 'output'),
    GITHUB_STEP_SUMMARY: path.join(dir, 'summary'),
  };
  for (const file of Object.values(files)) fs.writeFileSync(file, '');

  const env = { ...files, GITHUB_WORKSPACE: dir };
  const defaults = { url: 'https://grimoire.example', 'api-key': API_KEY, environment: 'production' };
  for (const [name, value] of Object.entries({ ...defaults, ...inputs })) {
    env[`INPUT_${name.toUpperCase()}`] = value;
  }

  let log = '';
  const out = { write: (text) => { log += text; } };
  const read = (name) => fs.readFileSync(files[name], 'utf8');

  /** Parse NAME<<DELIM ... DELIM blocks into an object. */
  const parse = (name) => {
    const result = {};
    const regex = /^(.+?)<<(ghadelimiter_[^\n]+)\n([\s\S]*?)\n\2\n/gm;
    for (const m of read(name).matchAll(regex)) result[m[1]] = m[3];
    return result;
  };

  return { env, out, dir, read, parse, log: () => log };
}

test('loads secrets and all configuration into env and outputs', async () => {
  const ctx = setup({ secrets: 'database-password\nsmtp-password=MAIL_PASS\nmulti-line' });

  const code = await run(ctx.env, ctx.out, { fetch: createFetch() });

  assert.equal(code, 0, ctx.log());
  const exported = ctx.parse('GITHUB_ENV');
  assert.deepEqual(exported, {
    DATABASE__HOST: 'osasco',
    DATABASE__PORT: '3306',
    FEATURE__DARKMODE: 'true',
    DATABASE_PASSWORD: 'pa$$w0rd"with\\specials',
    MAIL_PASS: 'smtp-secret',
    MULTI_LINE: 'line one\nline two',
  });

  const outputs = ctx.parse('GITHUB_OUTPUT');
  assert.equal(outputs.MAIL_PASS, 'smtp-secret');
  assert.equal(outputs.loaded, '6');
  assert.deepEqual(JSON.parse(outputs.missing), []);
  assert.ok(JSON.parse(outputs.variables).includes('DATABASE_PASSWORD'));

  // Secrets (each line) and the API key are masked; configuration is not by default.
  assert.match(ctx.log(), /::add-mask::grm_test_key/);
  assert.match(ctx.log(), /::add-mask::smtp-secret/);
  assert.match(ctx.log(), /::add-mask::line one\n::add-mask::line two/);
  assert.doesNotMatch(ctx.log(), /::add-mask::osasco/);
  // Values never appear in the log outside the mask commands.
  assert.doesNotMatch(ctx.log().replace(/::add-mask::.*\n/g, ''), /smtp-secret|pa\$\$w0rd/);

  assert.match(ctx.read('GITHUB_STEP_SUMMARY'), /6 value\(s\) loaded from `production`/);
  assert.doesNotMatch(ctx.read('GITHUB_STEP_SUMMARY'), /smtp-secret/);
});

test('selected configuration, prefix, masked configuration and no outputs', async () => {
  const ctx = setup({
    configurations: 'Database:*',
    prefix: 'APP_',
    'mask-configurations': 'true',
    'set-outputs': 'false',
  });

  assert.equal(await run(ctx.env, ctx.out, { fetch: createFetch() }), 0, ctx.log());
  assert.deepEqual(Object.keys(ctx.parse('GITHUB_ENV')), ['APP_DATABASE__HOST', 'APP_DATABASE__PORT']);
  assert.deepEqual(Object.keys(ctx.parse('GITHUB_OUTPUT')), ['loaded', 'variables', 'missing']);
  assert.match(ctx.log(), /::add-mask::osasco/);
});

test('fails on a missing secret by default, without exporting anything', async () => {
  const ctx = setup({ secrets: 'smtp-password\nnot-there', configurations: 'none' });

  assert.equal(await run(ctx.env, ctx.out, { fetch: createFetch() }), 1);
  assert.match(ctx.log(), /::error::No value in Grimoire environment "production" for: not-there/);
  assert.equal(ctx.read('GITHUB_ENV'), '');
});

test('fail-on-missing false only warns', async () => {
  const ctx = setup({ secrets: 'not-there', configurations: 'Nope:Key', 'fail-on-missing': 'false' });

  assert.equal(await run(ctx.env, ctx.out, { fetch: createFetch() }), 0, ctx.log());
  assert.match(ctx.log(), /::warning::No value .* for: Nope:Key, not-there/);
  assert.deepEqual(JSON.parse(ctx.parse('GITHUB_OUTPUT').missing), ['Nope:Key', 'not-there']);
});

test('writes a dotenv file with restricted permissions', async () => {
  const ctx = setup({ secrets: 'database-password', configurations: 'none', 'env-file': 'deploy/.env', 'export-env': 'false' });

  assert.equal(await run(ctx.env, ctx.out, { fetch: createFetch() }), 0, ctx.log());
  const file = path.join(ctx.dir, 'deploy/.env');
  assert.equal(fs.readFileSync(file, 'utf8'), 'DATABASE_PASSWORD="pa\\$\\$w0rd\\"with\\\\specials"\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(ctx.read('GITHUB_ENV'), '');
});

test('a secret overrides a configuration entry with the same variable name', async () => {
  const ctx = setup({ secrets: 'smtp-password=FEATURE__DARKMODE' });

  assert.equal(await run(ctx.env, ctx.out, { fetch: createFetch() }), 0, ctx.log());
  assert.equal(ctx.parse('GITHUB_ENV').FEATURE__DARKMODE, 'smtp-secret');
  assert.match(ctx.log(), /::warning::Secret "smtp-password" and configuration key "Feature:DarkMode"/);
});

test('two secrets mapping to the same name fail', async () => {
  const ctx = setup({ secrets: 'smtp-password=X\ndatabase-password=X', configurations: 'none' });
  assert.equal(await run(ctx.env, ctx.out, { fetch: createFetch() }), 1);
  assert.match(ctx.log(), /both map to X/);
});

test('validates required inputs and reports a bad API key', async () => {
  const missing = setup({ url: '' });
  assert.equal(await run(missing.env, missing.out, { fetch: createFetch() }), 1);
  assert.match(missing.log(), /Input "url" is required/);

  const badKey = setup({ 'api-key': 'nope', secrets: 'x' });
  assert.equal(await run(badKey.env, badKey.out, { fetch: createFetch() }), 1);
  assert.match(badKey.log(), /rejected the API key .*HTTP 401/);

  const badBool = setup({ 'export-env': 'maybe' });
  assert.equal(await run(badBool.env, badBool.out, { fetch: createFetch() }), 1);
  assert.match(badBool.log(), /must be true or false/);
});

test('warns about plain HTTP except for localhost', async () => {
  const remote = setup({ url: 'http://grimoire.example', configurations: 'none' });
  await run(remote.env, remote.out, { fetch: createFetch() });
  assert.match(remote.log(), /::warning::The Grimoire URL uses plain HTTP/);

  const local = setup({ url: 'http://127.0.0.1:8089', configurations: 'none' });
  await run(local.env, local.out, { fetch: createFetch() });
  assert.doesNotMatch(local.log(), /plain HTTP/);
});
