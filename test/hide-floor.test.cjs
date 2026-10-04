'use strict';
/**
 * Hide / restore the office floor (T-031): a header toggle, snap-to-close on
 * the splitter, persisted like sidebarWidth. No keyboard shortcut (by request).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  LS_FLOOR_HIDDEN, FLOOR_SNAP_PX, FLOOR_ROW_CHROME_PX,
  parseFloorHidden, serializeFloorHidden, shouldSnapCloseFloor, isFloorEffectivelyHidden
} = loadTs('src/shared/floorLayout.ts');
const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

test('hidden state round-trips; anything but "1" shows the floor', () => {
  assert.equal(parseFloorHidden(serializeFloorHidden(true)), true);
  assert.equal(parseFloorHidden(serializeFloorHidden(false)), false);
  for (const raw of [null, undefined, '', 'true', '0', 'yes']) assert.equal(parseFloorHidden(raw), false, String(raw));
});

test('the toggle only hides the floor while there are agents', () => {
  assert.equal(isFloorEffectivelyHidden(true, 3), true);
  assert.equal(isFloorEffectivelyHidden(false, 3), false);
  assert.equal(isFloorEffectivelyHidden(true, 0), false, 'empty-floor add-agent prompt stays reachable');
});

test('snap threshold: the floor snaps shut once it would be under FLOOR_SNAP_PX', () => {
  const vp = 1600;
  const edge = vp - FLOOR_ROW_CHROME_PX - FLOOR_SNAP_PX; // sidebar width where floor == threshold
  assert.equal(shouldSnapCloseFloor(edge, vp), false, 'exactly at the threshold still clamps');
  assert.equal(shouldSnapCloseFloor(edge + 1, vp), true);
  assert.equal(shouldSnapCloseFloor(420, vp), false);
  assert.equal(shouldSnapCloseFloor(vp, vp), true);
});

test('store persists floorHidden like sidebarWidth and leaves the width alone', () => {
  const store = read('src/renderer/src/store/store.ts');
  assert.equal(LS_FLOOR_HIDDEN, 'cth.floorHidden');
  assert.match(store, /parseFloorHidden\(window\.localStorage\.getItem\(LS_FLOOR_HIDDEN\)\)/);
  assert.match(store, /floorHidden: initialFloorHidden,/);
  const setter = store.slice(store.indexOf('setFloorHidden: (hidden) =>'));
  assert.match(setter.slice(0, 300), /localStorage\.setItem\(LS_FLOOR_HIDDEN, serializeFloorHidden\(hidden\)\)/);
  assert.doesNotMatch(setter.slice(0, 300), /sidebarWidth/);
});

test('splitter snaps to close instead of clamping, restoring the drag-start width', () => {
  const sp = read('src/renderer/src/components/SidebarSplitter.tsx');
  assert.match(sp, /shouldSnapCloseFloor\(startRef\.current\.width \+ delta, viewportWidth\)/);
  assert.match(sp, /onChange\(startRef\.current\.width\);\s*onUp\(\);\s*onSnapClose\(\);/);
});

test('App: header toggle, floor + splitter hidden, panel full width, no shortcut', () => {
  const app = read('src/renderer/src/App.tsx');
  assert.match(app, /onClick=\{\(\) => setFloorHidden\(!floorHidden\)\}/);
  assert.match(app, /data-tip=\{floorHidden \? t\('floor\.show'\) : t\('floor\.hide'\)\}/);
  assert.match(app, /aria-label=\{floorHidden \? t\('floor\.show'\) : t\('floor\.hide'\)\}/);
  assert.match(app, /\{!floorHidden && \(\s*<div[^>]*>\s*<OfficeFloor \/>/);
  assert.match(app, /\{!floorHidden && \(\s*<SidebarSplitter[\s\S]*?onSnapClose=\{\(\) => setFloorHidden\(true\)\}/);
  assert.match(app, /floorHidden \? \{ flex: 1, minWidth: 0 \} : \{ width: sidebarWidth, flexShrink: 0 \}/);
  assert.match(app, /isFloorEffectivelyHidden\(floorHiddenPref, agentCount\)/);
  // The focus-mode button is still there and unchanged in behaviour.
  assert.match(app, /aria-label="Toggle focus mode"/);
  // No keyboard shortcut for the floor (human change to T-031).
  assert.doesNotMatch(app, /setFloorHidden[\s\S]{0,200}key(down|board)|key === '\\\\'/i);
});

test('floor strings exist in en, ar and zh-CN', () => {
  for (const loc of ['en', 'ar', 'zh-CN']) {
    const d = JSON.parse(read(`src/renderer/src/i18n/locales/${loc}.json`));
    assert.ok(d.floor?.hide && d.floor?.show, loc);
  }
});
