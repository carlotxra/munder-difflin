/**
 * T-019 dependency hardening: the unused `localtunnel` is gone, and tunnelmole's
 * install-time and runtime telemetry is switched off (TUNNELMOLE_TELEMETRY=0).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const read = (rel) => readFileSync(join(__dirname, '..', rel), 'utf8');

test('localtunnel is not a dependency', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const name of ['localtunnel', '@types/localtunnel']) {
    assert.ok(!(name in (pkg.dependencies ?? {})), name);
    assert.ok(!(name in (pkg.devDependencies ?? {})), name);
  }
  assert.ok(!('node_modules/localtunnel' in JSON.parse(read('package-lock.json')).packages));
});

test('CI installs run with tunnelmole telemetry off', () => {
  for (const wf of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    assert.match(read(wf), /^env:\n\s+TUNNELMOLE_TELEMETRY: '0'/m, wf);
  }
});

test('the app turns tunnelmole runtime telemetry off before loading it', () => {
  for (const rel of ['src/main/slack.ts', 'src/main/webhook.ts']) {
    const src = read(rel);
    const off = src.indexOf("process.env.TUNNELMOLE_TELEMETRY = '0';");
    assert.ok(off > 0, `${rel} must set TUNNELMOLE_TELEMETRY=0`);
    assert.ok(off < src.indexOf("await import('tunnelmole')"), `${rel}: set it before the import`);
  }
});
