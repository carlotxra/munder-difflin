'use strict';

// ASK ME visibility (T-027): an open human question on ANY card that is not
// done shows on the tab, the kanban badge and the office floor. Before this a
// card also had to be "blocked", and god's asks on "doing" cards never surfaced.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { openQuestion, waitsOnHuman, countWaitingOnHuman } =
  loadTs('src/renderer/src/components/askMeFilter.ts');

const open = { q: '**Pick one**', askedAt: '2026-10-04T08:00:00Z' };
const answered = { q: 'earlier', a: 'yes', answeredAt: '2026-10-04T08:05:00Z' };
const dismissed = { q: 'skip me', dismissedAt: '2026-10-04T08:06:00Z' };

test('an open ask on a non-blocked card is visible', () => {
  for (const status of ['todo', 'doing', 'blocked']) {
    assert.equal(waitsOnHuman({ status, humanQA: [open] }), true, status);
  }
  // A hand-written status the kanban would normalise to "todo" still counts.
  assert.equal(waitsOnHuman({ status: 'review', humanQA: [open] }), true);
  assert.equal(waitsOnHuman({ humanQA: [open] }), true);
});

test('a done card is hidden even with an open ask', () => {
  assert.equal(waitsOnHuman({ status: 'done', humanQA: [open] }), false);
});

test('answered and dismissed asks are hidden', () => {
  assert.equal(waitsOnHuman({ status: 'doing', humanQA: [answered] }), false);
  assert.equal(waitsOnHuman({ status: 'blocked', humanQA: [dismissed] }), false);
  assert.equal(waitsOnHuman({ status: 'doing', humanQA: [] }), false);
  assert.equal(waitsOnHuman({ status: 'doing' }), false);
});

test('openQuestion returns the newest open entry, skipping resolved ones', () => {
  assert.equal(openQuestion({ humanQA: [open, answered] }), open);
  assert.equal(openQuestion({ humanQA: [answered, dismissed] }), undefined);
  assert.equal(openQuestion({ humanQA: [{ a: 'no q' }] }), undefined);
});

test('the floor count matches the tab filter on the same ledger', () => {
  const ledger = [
    { id: 'A', status: 'doing', humanQA: [open] },
    { id: 'B', status: 'blocked', humanQA: [answered, open] },
    { id: 'C', status: 'blocked', humanQA: [dismissed] },
    { id: 'D', status: 'done', humanQA: [open] },
    { id: 'E', status: 'todo' },
    null,
    'garbage'
  ];
  const tab = ledger.filter((t) => t && typeof t === 'object' && waitsOnHuman(t)).map((t) => t.id);
  assert.deepEqual(tab, ['A', 'B']);
  assert.equal(countWaitingOnHuman(ledger), tab.length);
  assert.equal(countWaitingOnHuman(undefined), 0);
});

test('every ASK ME surface uses the shared predicate', () => {
  const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
  const floor = read('src/renderer/src/scene/office/OfficeFloor.tsx');
  assert.match(floor, /countWaitingOnHuman\(arr\)/);
  assert.doesNotMatch(floor, /=== 'blocked'\s*\n\s*&& Array\.isArray\(t\?\.humanQA\)/);
  const kanban = read('src/renderer/src/components/TasksKanban.tsx');
  assert.match(kanban, /from '\.\/askMeFilter'/);
  assert.match(read('src/renderer/src/components/AskMeTab.tsx'), /\.filter\(waitsOnHuman\)/);
});
