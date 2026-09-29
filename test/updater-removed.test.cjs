/**
 * The auto-updater is gone (T-019). This fork must never poll or install the
 * upstream build: no electron-updater code or dependency, no `autoUpdate`
 * setting or Settings toggle, and no `publish` feed in the builder config.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

function sources(dir) {
  const out = [];
  for (const name of readdirSync(join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) out.push(...sources(rel));
    else if (/\.(ts|tsx|cjs|js)$/.test(name)) out.push(rel);
  }
  return out;
}

test('the updater module and its UI are deleted', () => {
  for (const rel of [
    'src/main/updater.ts',
    'src/renderer/src/components/UpdateToast.tsx',
    'src/renderer/src/components/UpdateBadge.tsx',
    'src/renderer/src/components/UpdatesSection.tsx'
  ]) assert.ok(!existsSync(join(root, rel)), `${rel} must be gone`);
});

test('no source imports electron-updater or registers update IPC', () => {
  for (const rel of sources('src')) {
    const src = read(rel);
    assert.doesNotMatch(src, /(from|require\(|import\()\s*['"]electron-updater['"]/, `${rel} imports electron-updater`);
    assert.doesNotMatch(src, /['"]update:(status|current|checkNow|download|restartAndInstall|openRelease|simulate)['"]/,
      `${rel} still wires an update IPC channel`);
    assert.doesNotMatch(src, /\bautoUpdate\b/, `${rel} still reads the autoUpdate setting`);
  }
});

test('electron-updater is not a dependency', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(!('electron-updater' in (pkg.dependencies ?? {})));
  assert.ok(!('electron-updater' in (pkg.devDependencies ?? {})));
});

test('the builder config has no update feed', () => {
  const yml = read('electron-builder.yml');
  assert.doesNotMatch(yml, /^publish:/m, 'a publish block stamps app-update.yml into the app');
  assert.doesNotMatch(yml, /^releaseInfo:/m);
});
