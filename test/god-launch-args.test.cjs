'use strict';

/**
 * config.godArgs: extra CLI flags appended to GOD's launch argv only (any
 * provider). Default []. Workers never get them; a --model inside godArgs
 * suppresses the default one instead of duplicating it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { withGodArgs, splitArgString, joinArgs } = loadTs('src/shared/godArgs.ts');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('DEFAULTS ship godArgs: []', () => {
  const src = read('src/main/config.ts');
  assert.match(src.slice(src.indexOf('const DEFAULTS')), /\n\s*godArgs: \[\],/);
});

test('god gets godArgs appended', () => {
  assert.deepEqual(withGodArgs(['--x'], true, ['--effort', 'high']), ['--x', '--effort', 'high']);
});

test('workers never get godArgs', () => {
  assert.deepEqual(withGodArgs(['--x'], false, ['--effort', 'high']), ['--x']);
  assert.deepEqual(withGodArgs(['--x'], undefined, ['--effort', 'high']), ['--x']);
});

test('unset / malformed godArgs is a no-op', () => {
  assert.deepEqual(withGodArgs(['--x'], true, undefined), ['--x']);
  assert.deepEqual(withGodArgs(['--x'], true, '--effort high'), ['--x']);
  assert.deepEqual(withGodArgs([], true, ['a', 3, '', null]), ['a']);
});

test('--model in godArgs is not duplicated by the default model step', () => {
  // Mirror of the launch sequence: godArgs first, then the model default is
  // added only when --model is absent.
  const args = withGodArgs([], true, ['--model', 'claude-fable-5-1']);
  if (!args.includes('--model')) args.push('--model', 'claude-opus-4-8');
  assert.equal(args.filter((a) => a === '--model').length, 1);
  assert.deepEqual(args, ['--model', 'claude-fable-5-1']);
});

test('index.ts injects godArgs for god only, before the --model default, outside the Claude-only block', () => {
  const src = read('src/main/index.ts');
  const inj = src.indexOf('if (opts.hive?.isGod) opts.args = withGodArgs(');
  const claudeBlock = src.indexOf('if (opts.hive && claudeProvider) {');
  const modelStep = src.indexOf("if (!args.includes('--model')) {", claudeBlock);
  assert.ok(inj > 0 && claudeBlock > inj && modelStep > claudeBlock);
  assert.equal(src.split('withGodArgs(').length - 1, 1, 'exactly one injection site');
});

test('splitArgString handles quotes and escapes; joinArgs round-trips', () => {
  assert.deepEqual(splitArgString('  --effort  high '), ['--effort', 'high']);
  assert.deepEqual(splitArgString(`-c 'a b' "c \\"d\\"" e\\ f ''`), ['-c', 'a b', 'c "d"', 'e f', '']);
  assert.deepEqual(splitArgString(''), []);
  for (const argv of [['--effort', 'high'], ['-c', "it's a b", ''], []]) {
    assert.deepEqual(splitArgString(joinArgs(argv)), argv);
  }
});
