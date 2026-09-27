'use strict';

/**
 * Custom model ids typed into a picker's "Custom…" field (src/shared/customModel.ts):
 * validation, the per-engine format hint, and the round trip through the
 * provider+model <select> encoding in src/renderer/src/store/config.ts.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  validateCustomModelId, customModelFormat, isCustomModel, CUSTOM_MODEL_SENTINEL
} = loadTs('src/shared/customModel.ts');
const { MODEL_ID_MAX, parseModelCatalog } = loadTs('src/shared/modelCatalogPayload.ts');
const { encodeProviderModel, decodeProviderModel, buildSpawnCommand, tokenizeCommand } =
  loadTs('src/renderer/src/store/config.ts');

const ok = (id) => ({ ok: true, id });
const err = (error) => ({ ok: false, error });

test('a valid id is trimmed and otherwise stored verbatim', () => {
  assert.deepEqual(validateCustomModelId('  claude-opus-9  ', 'claude'), ok('claude-opus-9'));
  assert.deepEqual(validateCustomModelId('gpt-7.1-Sol', 'copilot'), ok('gpt-7.1-Sol'));
  assert.deepEqual(validateCustomModelId('openrouter/qwen/qwen3:free', 'opencode'), ok('openrouter/qwen/qwen3:free'));
});

test('empty and whitespace-only input is rejected', () => {
  assert.deepEqual(validateCustomModelId('', 'claude'), err('empty'));
  assert.deepEqual(validateCustomModelId('   \t ', 'claude'), err('empty'));
});

test('whitespace inside an id is rejected for slug and CLI-id engines', () => {
  for (const provider of ['claude', 'copilot', 'codex', 'opencode', 'crush', 'pi']) {
    assert.deepEqual(validateCustomModelId('claude opus', provider), err('whitespace'), provider);
  }
  assert.deepEqual(validateCustomModelId('a b', 'claude'), err('whitespace'));
});

test('antigravity takes a display label: single spaces allowed, runs and other whitespace are not', () => {
  assert.deepEqual(validateCustomModelId('Gemini 3.9 Pro (High)', 'antigravity'), ok('Gemini 3.9 Pro (High)'));
  assert.deepEqual(validateCustomModelId('Gemini  3.9', 'antigravity'), err('whitespace'));
  assert.deepEqual(validateCustomModelId('Gemini\u00a03.9', 'antigravity'), err('whitespace'));
});

test('control characters and line breaks are rejected, never neutralised', () => {
  for (const bad of ['a\nb', 'a\rb', 'a\u0000b', 'a\tb', 'a\u007fb', 'a\u0085b', 'a\u2028b']) {
    assert.deepEqual(validateCustomModelId(bad, 'claude'), err('control'), JSON.stringify(bad));
    assert.deepEqual(validateCustomModelId(bad, 'antigravity'), err('control'), JSON.stringify(bad));
  }
});

test('quotes and a leading dash are rejected (they break or hijack the command line)', () => {
  assert.deepEqual(validateCustomModelId('gpt"x', 'codex'), err('quote'));
  assert.deepEqual(validateCustomModelId("Gemini 3 'Pro'", 'antigravity'), err('quote'));
  assert.deepEqual(validateCustomModelId('a`b', 'claude'), err('quote'));
  assert.deepEqual(validateCustomModelId('--dangerously-skip-permissions', 'claude'), err('dash'));
});

test('ids are capped at the catalog row limit', () => {
  assert.deepEqual(validateCustomModelId('m'.repeat(MODEL_ID_MAX), 'claude'), ok('m'.repeat(MODEL_ID_MAX)));
  assert.deepEqual(validateCustomModelId('m'.repeat(MODEL_ID_MAX + 1), 'claude'), err('tooLong'));
});

test('every accepted id survives the catalog row sanitiser unchanged', () => {
  const samples = [
    ['claude', 'claude-opus-9'],
    ['antigravity', 'Gemini 3.9 Pro (High)'],
    ['pi', 'ollama/qwen3-coder:30b']
  ];
  for (const [provider, raw] of samples) {
    const r = validateCustomModelId(raw, provider);
    assert.equal(r.ok, true);
    const parsed = parseModelCatalog({ version: 1, providers: { [provider]: [{ id: r.id, label: r.id }] } });
    assert.equal(parsed.providers[provider][0].id, r.id);
  }
});

test('per-engine format hint', () => {
  assert.equal(customModelFormat('antigravity'), 'label');
  for (const p of ['opencode', 'crush', 'pi']) assert.equal(customModelFormat(p), 'slug');
  for (const p of ['claude', 'copilot', 'codex', 'gemini']) assert.equal(customModelFormat(p), 'cliId');
});

test('the sentinel can never be a valid custom id', () => {
  assert.equal(validateCustomModelId(CUSTOM_MODEL_SENTINEL, 'claude').ok, false);
});

test('isCustomModel: set, not the sentinel, and not in the known list', () => {
  const known = [{ label: 'CLI default' }, { id: 'claude-opus-5', label: 'Opus 5' }];
  assert.equal(isCustomModel(known, undefined), false);
  assert.equal(isCustomModel(known, ''), false);
  assert.equal(isCustomModel(known, 'claude-opus-5'), false);
  assert.equal(isCustomModel(known, CUSTOM_MODEL_SENTINEL), false);
  assert.equal(isCustomModel(known, 'claude-opus-9'), true);
});

test('custom ids round-trip through the provider+model <select> encoding', () => {
  const cases = [
    ['claude', 'claude-opus-9'],
    ['antigravity', 'Gemini 3.9 Pro (High)'],
    ['opencode', 'openrouter/qwen/qwen3:free'],
    ['pi', 'a%b&c=d#e'],
    ['copilot', 'provider:model']
  ];
  for (const [provider, id] of cases) {
    const value = encodeProviderModel(provider, id);
    assert.deepEqual(decodeProviderModel(value), { provider, model: id }, value);
  }
});

test('the "Custom…" entry round-trips per provider and never collides with a real id', () => {
  const value = encodeProviderModel('opencode', CUSTOM_MODEL_SENTINEL);
  assert.deepEqual(decodeProviderModel(value), { provider: 'opencode', model: CUSTOM_MODEL_SENTINEL });
  for (const id of ['custom', '%00custom', 'Custom…']) {
    assert.notEqual(encodeProviderModel('opencode', id), value, id);
  }
});

test('a custom id reaches the spawn command line as one --model argument', () => {
  const cfg = { defaultCommand: 'claude', autoMode: false };
  const agy = tokenizeCommand(buildSpawnCommand(cfg, 'Gemini 3.9 Pro (High)', 'antigravity'));
  assert.equal(agy[agy.indexOf('--model') + 1], 'Gemini 3.9 Pro (High)');
  const claude = tokenizeCommand(buildSpawnCommand(cfg, 'claude-opus-9', 'claude'));
  assert.equal(claude[claude.indexOf('--model') + 1], 'claude-opus-9');
});
