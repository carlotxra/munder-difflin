'use strict';

/**
 * `remoteFetch` (default false): with it off, neither the model catalog nor the
 * Settings hero sends a request to raw.githubusercontent. The bundled catalog
 * and local override still apply; the hero falls back to the bundled default.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const loadTs = require('./load-ts.cjs');

// Record every outbound request. fetchText reads https.request at call time.
const calls = [];
const realRequest = https.request;
const realFetch = globalThis.fetch;
https.request = (...args) => { calls.push(String(args[0]?.href ?? args[0]?.hostname ?? args[0])); throw new Error('network disabled in test'); };
globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error('network disabled in test'); };

const { loadHero } = loadTs('src/main/hero.ts');
const { loadModelCatalogWithOverrides, OVERRIDE_FILE } = loadTs('src/main/modelCatalogOverride.ts');
const { DEFAULT_HERO } = loadTs('src/shared/heroPayload.ts');
const { CATALOG_SCHEMA_VERSION } = loadTs('src/shared/modelCatalogPayload.ts');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-remote-fetch-'));
test.after(() => {
  https.request = realRequest;
  globalThis.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
});
test.beforeEach(() => { calls.length = 0; });

test('hero: off by default, no request, bundled default, stale cache ignored', async () => {
  const cache = path.join(dir, 'hero.json');
  fs.writeFileSync(cache, JSON.stringify({ hero: { plan: { label: 'UPSTREAM' } }, fetchedAt: 0 }));
  for (const opts of [undefined, {}, { remoteFetch: false }, { force: true }]) {
    const r = await loadHero(cache, opts);
    assert.deepEqual(r.hero, DEFAULT_HERO);
  }
  assert.deepEqual(calls, []);
});

test('model catalog: off by default, no request, local override still applies', async () => {
  const override = {
    version: CATALOG_SCHEMA_VERSION,
    providers: { claude: [{ id: 'local-model', label: 'Local' }] }
  };
  fs.writeFileSync(path.join(dir, OVERRIDE_FILE), JSON.stringify(override));
  const ctx = { argv: [], env: {}, userDataDir: dir };
  for (const extra of [{}, { remoteFetch: false }]) {
    const r = await loadModelCatalogWithOverrides(path.join(dir, 'model-catalog.json'), { ...ctx, ...extra }, { force: true });
    assert.equal(r.catalog.providers.claude[0].id, 'local-model');
  }
  assert.deepEqual(calls, []);
});

test('with remoteFetch true, both try upstream as before', async () => {
  await loadHero(path.join(dir, 'hero.json'), { remoteFetch: true, force: true });
  await loadModelCatalogWithOverrides(path.join(dir, 'model-catalog.json'),
    { argv: [], env: {}, userDataDir: dir, remoteFetch: true }, { force: true });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((u) => u.includes('raw.githubusercontent.com')), calls.join(', '));
});

test('main wires the setting, and it ships off', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const index = read('src/main/index.ts');
  assert.equal((index.match(/remoteFetch: readConfig\(\)\.remoteFetch === true/g) ?? []).length, 2);
  const config = read('src/main/config.ts');
  assert.match(config.slice(config.indexOf('const DEFAULTS')), /\n\s*remoteFetch: false,/);
  assert.match(read('src/renderer/src/components/SettingsModal.tsx'), /useState<boolean>\(config\.remoteFetch === true\)/);
});
