'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GrimoireClient,
  dotenvLine,
  heredoc,
  maskCommands,
  parseList,
  parseMappings,
  selectConfigurations,
  toEnvironmentName,
  variableName,
} = require('../src/lib');
const { API_KEY, createFetch } = require('./mock-grimoire');

test('parseList splits on newlines and commas and drops blanks and comments', () => {
  assert.deepEqual(parseList('a, b\n\n  c\n# skip\n'), ['a', 'b', 'c']);
  assert.deepEqual(parseList(''), []);
});

test('parseMappings reads optional =ENV_NAME', () => {
  assert.deepEqual(parseMappings('db-password=DB_PASS\nsmtp'), [
    { name: 'db-password', envName: 'DB_PASS' },
    { name: 'smtp', envName: null },
  ]);
  assert.throws(() => parseMappings('=X'), /name before = is empty/);
  assert.throws(() => parseMappings('a=1BAD'), /Invalid variable name/);
});

test('toEnvironmentName matches the Pancake client', () => {
  assert.equal(toEnvironmentName('database-password'), 'DATABASE_PASSWORD');
  assert.equal(toEnvironmentName('Feature:DarkMode'), 'FEATURE__DARKMODE');
  assert.equal(toEnvironmentName('a.b c'), 'A_B_C');
});

test('variableName applies the prefix and rejects reserved or invalid names', () => {
  assert.equal(variableName('db', null, 'APP_'), 'APP_DB');
  assert.equal(variableName('db', 'EXPLICIT', 'APP_'), 'EXPLICIT');
  assert.throws(() => variableName('path', null, ''), /reserved/);
  assert.throws(() => variableName('github-token', null, ''), /reserved/);
  assert.throws(() => variableName('1st', null, ''), /not a valid variable name/);
});

test('selectConfigurations supports all, none, keys, wildcards and mappings', () => {
  const all = { 'Database:Host': 'h', 'Database:Port': 'p', 'Feature:X': 'x' };

  assert.equal(selectConfigurations(all, 'all').entries.length, 3);
  assert.equal(selectConfigurations(all, '').entries.length, 3);
  assert.deepEqual(selectConfigurations(all, 'none'), { entries: [], missing: [] });

  const picked = selectConfigurations(all, 'database:*\nfeature:x=FLAG\nMissing:Key\nNope:*');
  assert.deepEqual(
    picked.entries.map((e) => [e.key, e.envName]),
    [['Database:Host', null], ['Database:Port', null], ['Feature:X', 'FLAG']],
  );
  assert.deepEqual(picked.missing, ['Missing:Key', 'Nope:*']);

  assert.throws(() => selectConfigurations(all, 'Database:*=DB'), /wildcard/);
});

test('heredoc picks a delimiter that is not in the value', () => {
  const text = heredoc('NAME', 'a\nb');
  const [first] = text.split('\n');
  const delimiter = first.split('<<')[1];
  assert.equal(text, `NAME<<${delimiter}\na\nb\n${delimiter}\n`);
});

test('dotenvLine escapes quotes, backslashes, dollars and newlines', () => {
  assert.equal(dotenvLine('X', 'a"b\\c$d\ne'), 'X="a\\"b\\\\c\\$d\\ne"\n');
});

test('maskCommands masks every non-empty line', () => {
  assert.equal(maskCommands('one\n\ntwo%'), '::add-mask::one\n::add-mask::two%25\n');
});

test('GrimoireClient reads secrets and configurations', async () => {
  const fetch = createFetch();
  const client = new GrimoireClient({ url: 'https://g.example/', apiKey: API_KEY, environment: 'production', fetch });

  assert.equal(await client.getSecret('smtp-password'), 'smtp-secret');
  assert.equal(await client.getSecret('missing'), null);
  assert.equal((await client.getConfigurations())['Database:Host'], 'osasco');
  assert.equal(fetch.calls[0], 'https://g.example/consumer/secrets/smtp-password?environment=production');
});

test('GrimoireClient reports bad keys and unknown environments', async () => {
  const bad = new GrimoireClient({ url: 'https://g', apiKey: 'wrong', environment: 'production', fetch: createFetch() });
  await assert.rejects(bad.getSecret('x'), { status: 401 });

  const unknown = new GrimoireClient({ url: 'https://g', apiKey: API_KEY, environment: 'nope', fetch: createFetch() });
  await assert.rejects(unknown.getConfigurations(), { status: 404 });
});

test('GrimoireClient retries network errors and 5xx, then gives up', async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 1) throw new Error('ECONNRESET');
    if (calls === 2) return new Response('{}', { status: 503 });
    return new Response(JSON.stringify({ name: 'x', value: 'v' }), { status: 200 });
  };
  const sleeps = [];
  const client = new GrimoireClient({
    url: 'https://g', apiKey: 'k', environment: 'e', fetch: flaky, retries: 2, sleep: async (ms) => sleeps.push(ms),
  });
  assert.equal(await client.getSecret('x'), 'v');
  assert.deepEqual(sleeps, [500, 1000]);

  const down = new GrimoireClient({
    url: 'https://g', apiKey: 'k', environment: 'e', retries: 1, sleep: async () => {},
    fetch: async () => { throw new Error('ENOTFOUND'); },
  });
  await assert.rejects(down.getSecret('x'), { status: -1, message: /Could not reach Grimoire/ });
});
