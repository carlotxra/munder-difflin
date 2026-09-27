'use strict';

/**
 * T-014: Settings > Maintenance "Scheduled auto-compact" reverted to off after
 * every restart. The toggle read and wrote the `compact-maintenance` mission, but
 * boot retires that mission into `contextTrigger.compact`, so after the first
 * boot the mission is gone: the toggle always read false and its save mapped
 * over a missions array with nothing to change. The toggle now reads and writes
 * `contextTrigger.compact.enabled`; this proves that value survives a
 * save → reload round trip.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// Never touch the real app config: point Electron's userData at a temp dir.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-compact-persist-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { writeConfig, readConfig } = loadTs('src/main/config.ts');
const { scheduledCompactEnabled, scheduledCompactPatch, DEFAULT_CONTEXT_TRIGGER } =
  loadTs('src/shared/triggers.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));
writeConfig({});
readConfig();

const ROOT = path.join(__dirname, '..');

for (const on of [false, true, false]) {
  test(`toggle ${on ? 'ON' : 'OFF'} survives a save/reload round trip`, () => {
    writeConfig(scheduledCompactPatch(readConfig(), on));
    // Reload from disk, as a restart does.
    assert.equal(scheduledCompactEnabled(readConfig()), on);
    assert.equal(readConfig().contextTrigger.compact.enabled, on);
  });
}

test('the patch keeps the rest of the trigger (cadence, gate, clear half)', () => {
  writeConfig({ contextTrigger: {
    compact: { ...DEFAULT_CONTEXT_TRIGGER.compact, everyMs: 1234, enabled: true },
    clear: { ...DEFAULT_CONTEXT_TRIGGER.clear, enabled: true }
  } });
  writeConfig(scheduledCompactPatch(readConfig(), false));
  const ct = readConfig().contextTrigger;
  assert.equal(ct.compact.enabled, false);
  assert.equal(ct.compact.everyMs, 1234);
  assert.equal(ct.clear.enabled, true);
});

test('no mission in config does not read as off (the retired-mission bug)', () => {
  writeConfig({ missions: [] });
  writeConfig(scheduledCompactPatch(readConfig(), true));
  assert.equal(scheduledCompactEnabled(readConfig()), true);
});

test('SettingsModal no longer keys the toggle off the retired mission', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/src/components/SettingsModal.tsx'), 'utf8');
  assert.ok(!/m\.id === 'compact-maintenance'/.test(src));
  assert.match(src, /scheduledCompactEnabled\(config\)/);
  assert.match(src, /scheduledCompactPatch\(cfg\b.*autoCompactPending\)/);
});
