'use strict';

/**
 * Local model-catalog overrides (src/main/modelCatalogOverride.ts): precedence
 * flag > env > userData file > remote > bundled, per-provider merge, and the
 * switch that turns the remote fetch off.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const baked = require('../src/shared/modelCatalog.json');

const { loadModelCatalogWithOverrides, explicitSource, OVERRIDE_FILE } =
  loadTs('src/main/modelCatalogOverride.ts');
const { applyRemoteModelCatalog, modelsForProvider } =
  loadTs('src/renderer/src/store/config.ts');

test.afterEach(() => applyRemoteModelCatalog(null));

const row = (id) => ({ id, label: id });
const ids = (catalog, provider) => catalog.providers[provider].map((m) => m.id);

/** A fresh userData dir, plus a stubbed remote loader that records calls. */
function setup({ file, remote = { claude: [row('remote-claude')], codex: [row('remote-codex')] } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-override-'));
  if (file !== undefined) {
    fs.writeFileSync(path.join(dir, OVERRIDE_FILE), typeof file === 'string' ? file : JSON.stringify(file));
  }
  const calls = [];
  const load = async (cachePath, opts) => {
    calls.push({ cachePath, opts });
    return { catalog: remote && { version: 1, providers: remote }, fetchedAt: 42, stale: false };
  };
  return { dir, calls, load };
}

function write(dir, name, value) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(value));
  return p;
}

const run = (s, { argv = [], env = {}, fetchText } = {}) =>
  loadModelCatalogWithOverrides(path.join(s.dir, 'model-catalog.json'),
    { argv, env, userDataDir: s.dir, fetchText, remoteFetch: true }, { load: s.load });

// ─── source selection ───────────────────────────────────────────────────────

test('the flag is read in both forms and beats the env var', () => {
  const env = { MUNDER_MODEL_CATALOG: '/env.json' };
  assert.equal(explicitSource(['electron', '.', '--model-catalog=/a.json'], env), '/a.json');
  assert.equal(explicitSource(['--model-catalog', '/b.json'], env), '/b.json');
  assert.equal(explicitSource(['electron', '.'], env), '/env.json');
  assert.equal(explicitSource([], {}), null);
});

// ─── precedence + merge ─────────────────────────────────────────────────────

test('no override: the remote result passes through untouched', async () => {
  const s = setup();
  const out = await run(s);
  assert.deepEqual(ids(out.catalog, 'claude'), ['remote-claude']);
  assert.equal(out.fetchedAt, 42);
  assert.equal(s.calls.length, 1);
});

test('flag > well-known file > remote, merged per provider', async () => {
  const s = setup({ file: { providers: { claude: [row('file-claude')], gemini: [row('file-gemini')] } } });
  const flag = write(s.dir, 'flag.json', { providers: { claude: [row('flag-claude')] } });
  const out = await run(s, { argv: [`--model-catalog=${flag}`] });
  assert.deepEqual(ids(out.catalog, 'claude'), ['flag-claude']);   // flag wins
  assert.deepEqual(ids(out.catalog, 'gemini'), ['file-gemini']);   // file beats remote/bundled
  assert.deepEqual(ids(out.catalog, 'codex'), ['remote-codex']);   // untouched → remote
});

test('env var is a first-tier source when no flag is given', async () => {
  const s = setup({ file: { providers: { claude: [row('file-claude')] } } });
  const env = write(s.dir, 'env.json', { providers: { claude: [row('env-claude')] } });
  const out = await run(s, { env: { MUNDER_MODEL_CATALOG: env } });
  assert.deepEqual(ids(out.catalog, 'claude'), ['env-claude']);
});

test('a provider no layer names falls back to the bundled list in the pickers', async () => {
  const s = setup({ file: { providers: { claude: [row('file-claude')] } } });
  const out = await run(s);
  applyRemoteModelCatalog(out.catalog);
  assert.deepEqual(modelsForProvider('claude').map((m) => m.id), ['file-claude']);
  assert.deepEqual(
    modelsForProvider('copilot').map((m) => m.id),
    baked.providers.copilot.map((m) => m.id)
  );
});

test('an https override is fetched through the injected fetcher', async () => {
  const s = setup();
  const seen = [];
  const fetchText = async (url) => {
    seen.push(url);
    return JSON.stringify({ providers: { claude: [row('url-claude')] } });
  };
  const out = await run(s, { argv: ['--model-catalog=https://example.test/c.json'], fetchText });
  assert.deepEqual(seen, ['https://example.test/c.json']);
  assert.deepEqual(ids(out.catalog, 'claude'), ['url-claude']);
});

// ─── failure is never fatal ─────────────────────────────────────────────────

test('a missing, unreadable or malformed override is skipped, not fatal', async () => {
  for (const file of ['{not json', '[]', JSON.stringify({ version: 99, providers: { claude: [row('x')] } })]) {
    const s = setup({ file });
    const out = await run(s, { argv: ['--model-catalog=/does/not/exist.json'] });
    assert.deepEqual(ids(out.catalog, 'claude'), ['remote-claude'], file);
  }
});

test('override ids are sanitised by the same parser as the remote copy', async () => {
  const s = setup({ file: { providers: { claude: [{ id: 'evil\n--rm -rf', label: 'x' }] } } });
  const out = await run(s);
  assert.equal(out.catalog.providers.claude[0].id, 'evil --rm -rf');
});

// ─── switching the remote off ───────────────────────────────────────────────

test('"remote": false in the well-known file skips the fetch', async () => {
  const s = setup({ file: { remote: false, providers: { claude: [row('file-claude')] } } });
  const out = await run(s);
  assert.equal(s.calls.length, 0);
  assert.deepEqual(Object.keys(out.catalog.providers), ['claude']);
  assert.equal(out.fetchedAt, 0);
});

test('"remote": false works without any providers, leaving just the bundled list', async () => {
  const s = setup({ file: { remote: false } });
  const out = await run(s);
  assert.equal(s.calls.length, 0);
  assert.equal(out.catalog, null);
});

test('MUNDER_MODEL_CATALOG_REMOTE=0 skips the fetch', async () => {
  for (const v of ['0', 'false', 'OFF']) {
    const s = setup();
    const out = await run(s, { env: { MUNDER_MODEL_CATALOG_REMOTE: v } });
    assert.equal(s.calls.length, 0, v);
    assert.equal(out.catalog, null);
  }
});

test('force is passed through to the remote loader', async () => {
  const s = setup();
  await loadModelCatalogWithOverrides(path.join(s.dir, 'c.json'),
    { argv: [], env: {}, userDataDir: s.dir, remoteFetch: true }, { load: s.load, force: true });
  assert.equal(s.calls[0].opts.force, true);
});
