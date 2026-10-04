'use strict';

// T-043: a lost Enter must not glue the next submission onto the same line.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { typeAndSubmit, clearInputSequence, submitPayload } = loadTs('src/shared/custom/ptySubmit.ts');

/** A fake line-editor TUI: keeps an input line, honours Ctrl+U, submits on
 *  "\r" unless told to drop the next Enter. Records what it echoes. */
function fakeTui({ dropEnters = 0, echoes = true } = {}) {
  const log = [];
  const submitted = [];
  let line = '';
  let listener = null;
  const io = {
    async write(data) {
      log.push(data);
      if (data === '\x15') line = '';
      else if (data === '\r') {
        if (dropEnters > 0) dropEnters -= 1;
        else { submitted.push(line); line = ''; }
      } else {
        line += data;
        if (echoes && listener) setImmediate(() => listener && listener());
      }
      return { ok: true };
    },
    waitForOutput(timeoutMs) {
      return new Promise((resolve) => {
        const t = setTimeout(() => { listener = null; resolve(false); }, timeoutMs);
        listener = () => { clearTimeout(t); listener = null; resolve(true); };
      });
    },
    sleep: async () => {}
  };
  return { io, log, submitted };
}

test('a lost Enter no longer glues /remote-control onto the next prompt', async () => {
  const tui = fakeTui({ dropEnters: 1 });
  await typeAndSubmit(tui.io, '/remote-control Michael', 'claude', 0);
  await typeAndSubmit(tui.io, "You're online as Michael", 'claude', 0);
  assert.deepEqual(tui.submitted, ["You're online as Michael"]);
});

test('without a lost Enter both lines submit separately, in order', async () => {
  const tui = fakeTui();
  await typeAndSubmit(tui.io, '/remote-control Michael', 'kimi', 0);
  await typeAndSubmit(tui.io, 'next', 'kimi', 0);
  assert.deepEqual(tui.submitted, ['/remote-control Michael', 'next']);
  assert.deepEqual(tui.log, ['\x15', '/remote-control Michael', '\r', '\x15', 'next', '\r']);
});

test('Enter waits for the echo, and still goes when the TUI never echoes', async () => {
  const order = [];
  let release;
  const io = {
    async write(d) { order.push(d); return { ok: true }; },
    waitForOutput() { return new Promise((r) => { release = () => { order.push('echo'); r(true); }; }); },
    sleep: async () => {}
  };
  const p = typeAndSubmit(io, 'hi', 'claude', 0);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['\x15', 'hi'], 'no Enter before the echo');
  release();
  await p;
  assert.deepEqual(order, ['\x15', 'hi', 'echo', '\r']);

  const silent = fakeTui({ echoes: false });
  silent.io.waitForOutput = async () => false; // the timeout path
  await typeAndSubmit(silent.io, 'hi', 'claude', 0);
  assert.deepEqual(silent.submitted, ['hi']);
});

test('a failed write rejects and sends no Enter', async () => {
  const writes = [];
  const io = {
    async write(d) { writes.push(d); return d === 'x' ? { ok: false, error: 'no pty: god' } : { ok: true }; },
    waitForOutput: async () => true,
    sleep: async () => {}
  };
  await assert.rejects(typeAndSubmit(io, 'x', 'claude', 0), /no pty: god/);
  assert.equal(writes.includes('\r'), false);
});

test('Enter is sent exactly once (a second could answer a permission prompt)', async () => {
  const tui = fakeTui({ dropEnters: 1 });
  await typeAndSubmit(tui.io, 'hello', 'claude', 0);
  assert.equal(tui.log.filter((d) => d === '\r').length, 1);
});

test('clear sequence: Ctrl+U only for verified line editors (T-047 allowlist)', () => {
  for (const p of ['claude', 'kimi', 'crush']) assert.equal(clearInputSequence(p), '\x15', p);
  // Ink-style inputs may type a literal "u"; unverified ones get no clear.
  for (const p of ['copilot', 'grok', 'cursor', 'pi', 'opencode', 'codex', 'gemini', 'qwen', 'antigravity', 'custom', 'someday']) {
    assert.equal(clearInputSequence(p), null, p);
  }
  const ink = fakeTui();
  return typeAndSubmit(ink.io, 'hi', 'copilot', 0).then(() => {
    assert.deepEqual(ink.log, ['hi', '\r'], 'no Ctrl+U, still one Enter after the echo wait');
  });
});

test('main-process nudge (submitLine) clears, waits for output via lastOutputAt, Enters once', async () => {
  const { submitLine } = loadTs('src/main/custom/ptySubmit.ts');
  const writes = [];
  let lastOut = 0;
  const pty = {
    write(id, d) {
      writes.push([id, d]);
      if (d !== '\x15' && d !== '\r') setTimeout(() => { lastOut = Date.now(); }, 30);
      return { ok: true };
    },
    lastOutputAt: () => lastOut
  };
  const t0 = Date.now();
  await submitLine(pty, 'w1', 'nudge', 'claude');
  assert.deepEqual(writes.map((w) => w[1]), ['\x15', 'nudge', '\r']);
  assert.ok(Date.now() - t0 < 900, 'returned on the echo, not the 1s timeout');

  const dead = { write: () => ({ ok: false, error: 'no pty: w2' }), lastOutputAt: () => undefined };
  await assert.rejects(submitLine(dead, 'w2', 'nudge', 'copilot'), /no pty: w2/);
});

test('bracketed paste only wraps multi-line text', () => {
  assert.equal(submitPayload('/remote-control Michael'), '/remote-control Michael');
  assert.equal(submitPayload('a\nb'), '\x1b[200~a\nb\x1b[201~');
});
