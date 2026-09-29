'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { parseVersion, isNewer } = loadTs('src/shared/version.ts');

test('parseVersion accepts a leading v and ignores suffixes', () => {
  assert.deepEqual(parseVersion('v0.4.7-rc.1'), [0, 4, 7]);
  assert.equal(parseVersion('garbage'), null);
});

test('isNewer compares numerically, not lexically', () => {
  assert.equal(isNewer('0.3.10', '0.3.9'), true);
  assert.equal(isNewer('0.3.5', '0.3.6'), false);
  assert.equal(isNewer('0.3.6', '0.3.6'), false);
  assert.equal(isNewer('0.4.7-rc.2', '0.4.7-rc.1'), false);
  assert.equal(isNewer('garbage', '0.3.6'), false);
});
