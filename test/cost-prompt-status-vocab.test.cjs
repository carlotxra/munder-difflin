'use strict';
/**
 * T-035 S8 regression: with promptTrim on, god's prompt lost the kanban status
 * vocabulary (todo/doing/blocked/done) and god wrote status "in_progress" on
 * dispatch (eval S8 1/3 vs 3/3 on stable). Pin the vocabulary through every
 * prompt override, against the real upstream guardrails line in hive.ts.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { PROMPT_OVERRIDES, applyOverrides, trimPrompt } = loadTs('src/main/custom/promptTrim.ts');
const { setCostLeversSource } = loadTs('src/main/custom/levers.ts');
const VOCAB = 'todo/doing/blocked/done';

const hive = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/hive.ts'), 'utf8');
const m = hive.match(/const guardrailsLine = '((?:[^'\\]|\\.)*)';/);
const upstreamGuardrails = m && m[1].replace(/\\'/g, "'");

test('the upstream guardrails line still names the kanban statuses', () => {
  assert.ok(upstreamGuardrails, 'guardrailsLine not found in hive.ts');
  assert.ok(upstreamGuardrails.includes(VOCAB));
});

test('promptTrim keeps the status vocabulary in the trimmed guardrails line', (t) => {
  setCostLeversSource(() => ({}));
  t.after(() => setCostLeversSource(null));
  const out = trimPrompt(upstreamGuardrails, { isGod: true });
  assert.notEqual(out, upstreamGuardrails, 'F14 override still matches upstream');
  assert.ok(out.includes(VOCAB), out);
});

test('no prompt override drops the status vocabulary from text that had it', () => {
  for (const o of PROMPT_OVERRIDES) {
    const before = typeof o.find === 'string' ? o.find : '';
    if (!before.includes(VOCAB)) continue;
    const { text } = applyOverrides(before, [o]);
    assert.ok(text.includes(VOCAB), `${o.id} drops "${VOCAB}"`);
  }
});
