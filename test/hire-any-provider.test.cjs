'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { validateHireManifest } = loadTs('src/shared/hire.ts');
const base = (extra) => ({ spec: 'munder-difflin/hire@1', name: 'Jim', ...extra });

test('a copilot manifest imports with its model', () => {
  const v = validateHireManifest(base({ provider: 'copilot', model: 'claude-sonnet-4.5' }));
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.equal(v.manifest.provider, 'copilot');
  assert.equal(v.manifest.model, 'claude-sonnet-4.5');
});

test('every non-custom preset provider is accepted; custom and unknown are rejected', () => {
  for (const p of ['grok', 'kimi', 'qwen', 'opencode', 'crush', 'pi', 'gemini', 'claude', 'codex', 'cursor', 'agy']) {
    assert.equal(validateHireManifest(base({ provider: p })).ok, true, p);
  }
  assert.equal(validateHireManifest(base({ provider: 'custom' })).ok, false);
  assert.equal(validateHireManifest(base({ provider: 'evil-cli' })).ok, false);
});

test('new providers with no curated safe set accept no flags at all', () => {
  for (const flags of [['--model', 'gpt-5'], ['--verbose'], ['--base-url', 'https://x'], ['--config=a'], ['--mcp-config', 'x'], ['--add-dir', '/']]) {
    const v = validateHireManifest(base({ provider: 'copilot', commandFlags: flags }));
    assert.equal(v.ok, false, flags.join(' '));
  }
});

test('reviewed providers keep their safe set and still deny unsafe flags', () => {
  assert.equal(validateHireManifest(base({ provider: 'claude', commandFlags: ['--max-turns', '5'] })).ok, true);
  assert.equal(validateHireManifest(base({ provider: 'codex', commandFlags: ['-c', 'x=1'] })).ok, false);
});
