/**
 * Auto-update is opt-in: a fresh install never downloads upstream releases.
 *
 * Semantics: `autoUpdate` undefined/missing means OFF; only an explicit `true`
 * enables the background check + download. Every reader has to agree, because a
 * single `!== false` anywhere turns "missing" back into "on" — the main-process
 * gate, the DEFAULTS, and the Settings toggle's initial state.
 *
 * Source-string checks, because updater.ts and config.ts import electron and
 * cannot be loaded in a plain test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const read = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');

test('DEFAULTS ship autoUpdate: false', () => {
  const src = read('src/main/config.ts');
  const defaults = src.slice(src.indexOf('const DEFAULTS'));
  assert.match(defaults, /\n\s*autoUpdate: false\b/, 'DEFAULTS must set autoUpdate: false');
  assert.doesNotMatch(defaults, /\n\s*autoUpdate: true\b/, 'DEFAULTS must not opt users in');
});

test('the updater gate treats only an explicit true as on, and fails closed', () => {
  const src = read('src/main/updater.ts');
  const start = src.indexOf('function autoUpdateEnabled');
  const gate = src.slice(start, src.indexOf('\n}\n', start));
  assert.match(gate, /readConfig\(\)\.autoUpdate === true/,
    'autoUpdateEnabled must require autoUpdate === true');
  assert.doesNotMatch(gate, /!== false/, 'a `!== false` gate turns a missing flag back into ON');
  assert.match(gate, /catch\s*\{\s*return false;/, 'an unreadable config must mean OFF');
});

test('the background tick is gated on the flag', () => {
  const src = read('src/main/updater.ts');
  assert.match(src, /const tick = \(\): void => \{ if \(autoUpdateEnabled\(\)\) void runCheck\(\); \};/);
});

test('the Settings toggle starts OFF unless the flag is explicitly true', () => {
  const src = read('src/renderer/src/components/SettingsModal.tsx');
  assert.match(src, /useState<boolean>\(config\.autoUpdate === true\)/);
  assert.doesNotMatch(src, /config\.autoUpdate !== false/);
});

test('no source reads autoUpdate with a default-on `!== false`', () => {
  const files = [
    'src/main/updater.ts', 'src/main/index.ts', 'src/main/config.ts',
    'src/renderer/src/components/SettingsModal.tsx',
    'src/renderer/src/components/UpdatesSection.tsx',
    'src/renderer/src/components/UpdateBadge.tsx'
  ];
  for (const f of files) {
    assert.doesNotMatch(read(f), /autoUpdate\s*!==\s*false/, `${f} treats a missing autoUpdate as ON`);
    assert.doesNotMatch(read(f), /autoUpdate\s*\?\?\s*true/, `${f} treats a missing autoUpdate as ON`);
  }
});
