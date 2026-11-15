'use strict';

// A tiny stand-in for the Grimoire Consumer API, used by the unit tests (as a fetch
// implementation) and by the CI workflow (as an HTTP server: `node tests/mock-grimoire.js 8089`).

const API_KEY = 'grm_test_key';

const DATA = {
  production: {
    secrets: {
      'database-password': 'pa$$w0rd"with\\specials',
      'smtp-password': 'smtp-secret',
      'multi-line': 'line one\nline two',
    },
    configurations: {
      'Database:Host': 'osasco',
      'Database:Port': '3306',
      'Feature:DarkMode': 'true',
    },
  },
  staging: {
    secrets: {},
    configurations: { 'Feature:DarkMode': 'false' },
  },
};

/** @returns {{ status: number, body: unknown }} */
function handle(method, rawUrl, headers) {
  const url = new URL(rawUrl, 'http://localhost');
  if (method !== 'GET') return { status: 405, body: {} };
  if (url.pathname === '/health') return { status: 200, body: { status: 'Healthy' } };

  const key = headers['x-api-key'] ?? headers['X-Api-Key'];
  if (key !== API_KEY) return { status: 401, body: { title: 'Unauthorized' } };

  const environment = DATA[url.searchParams.get('environment')];
  if (!environment) return { status: 404, body: { title: 'Environment not found.' } };

  if (url.pathname === '/consumer/configurations') {
    return {
      status: 200,
      body: {
        items: Object.entries(environment.configurations).map(([k, value]) => ({
          key: k,
          value,
          label: url.searchParams.get('environment'),
        })),
      },
    };
  }

  const match = url.pathname.match(/^\/consumer\/secrets\/(.+)$/);
  if (match) {
    const name = decodeURIComponent(match[1]);
    if (!(name in environment.secrets)) return { status: 404, body: { title: 'Secret not found.' } };
    return {
      status: 200,
      body: {
        name,
        value: environment.secrets[name],
        properties: { enabled: true, version: 1, createdOn: '2026-01-01T00:00:00Z' },
      },
    };
  }

  return { status: 404, body: {} };
}

/** A fetch-compatible function backed by `handle`, recording the requested URLs. */
function createFetch() {
  const calls = [];
  async function fetch(url, init = {}) {
    calls.push(url);
    const { status, body } = handle('GET', url, init.headers || {});
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }
  fetch.calls = calls;
  return fetch;
}

module.exports = { API_KEY, DATA, createFetch, handle };

if (require.main === module) {
  const http = require('node:http');
  const port = Number(process.argv[2] || 8089);
  http
    .createServer((req, res) => {
      const lowerHeaders = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
      const { status, body } = handle(req.method, req.url, lowerHeaders);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    })
    .listen(port, '127.0.0.1', () => console.log(`Mock Grimoire listening on http://127.0.0.1:${port}`));
}
