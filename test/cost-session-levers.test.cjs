'use strict';
/**
 * T-035 cost levers J2 (fresh start instead of a costly resume) and J4 (trimmed
 * static prefix). Pure policy + the main-side lever module behind costLevers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { transcriptStats, decideResume, handoffBody, DEFAULT_RESUME_MAX_CONTEXT_TOKENS } = loadTs('src/shared/custom/resumePolicy.ts');
const { leanPluginOverrides, withLeanArgs, LEAN_DISABLED_PLUGINS } = loadTs('src/shared/custom/leanContext.ts');
const { COST_LEVERS_ON } = loadTs('src/shared/custom/costLevers.ts');
const { setCostLeversSource } = loadTs('src/main/custom/levers.ts');
const levers = loadTs('src/main/custom/sessionLevers.ts');
const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

const call = (ctx, model = 'claude-opus-5-5', text = 'done') => JSON.stringify({
  type: 'assistant',
  message: { id: `m${ctx}`, model, content: [{ type: 'text', text }], usage: { input_tokens: 2, cache_read_input_tokens: ctx - 1002, cache_creation_input_tokens: 1000, output_tokens: 5 } }
});
const prompt = (s) => JSON.stringify({ type: 'user', message: { role: 'user', content: s } });

// ── J2 policy ────────────────────────────────────────────────────────────────

test('transcriptStats reads the LAST call: context size, model, reply and prompt', () => {
  const s = transcriptStats([prompt('first'), call(50000), prompt('T-035 go'), call(180000, 'claude-opus-5-5', 'branch ready'),
    JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', content: [], usage: { input_tokens: 0 } } }), 'not json'].join('\n'));
  assert.equal(s.lastContextTokens, 180000);
  assert.equal(s.lastModel, 'claude-opus-5-5');
  assert.equal(s.lastAssistantText, 'branch ready');
  assert.equal(s.lastUserPrompt, 'T-035 go');
  assert.equal(transcriptStats(prompt('only a prompt')), undefined);
});

test('decideResume: explicit always resumes; big context or model switch starts fresh', () => {
  const big = { lastContextTokens: 250000, lastModel: 'claude-opus-5-5' };
  const small = { lastContextTokens: 60000, lastModel: 'claude-opus-5' };
  const max = DEFAULT_RESUME_MAX_CONTEXT_TOKENS;
  assert.equal(max, 100000);
  assert.deepEqual(decideResume({ explicit: true, stats: big, maxContextTokens: max }), { resume: true, reason: 'explicit' });
  assert.deepEqual(decideResume({ explicit: false, stats: undefined, maxContextTokens: max }), { resume: true, reason: 'no-stats' });
  assert.deepEqual(decideResume({ explicit: false, stats: big, maxContextTokens: max }), { resume: false, reason: 'context' });
  assert.deepEqual(decideResume({ explicit: false, stats: { ...big, lastContextTokens: max }, maxContextTokens: max }).resume, true, 'at the limit still resumes');
  assert.deepEqual(decideResume({ explicit: false, stats: small, launchModel: 'claude-opus-5-5', maxContextTokens: max }), { resume: false, reason: 'model' });
  assert.equal(decideResume({ explicit: false, stats: small, launchModel: 'opus', maxContextTokens: max }).resume, true, 'an alias is not compared');
  assert.equal(decideResume({ explicit: false, stats: big, maxContextTokens: 0 }).resume, true, '0 = no size limit');
});

test('the handoff note names the old session, the reason and the last exchange', () => {
  const body = handoffBody('sid-1', { resume: false, reason: 'context' }, { lastContextTokens: 250000, lastUserPrompt: 'do T-9', lastAssistantText: 'x'.repeat(2000) });
  assert.match(body, /sid-1/);
  assert.match(body, /250000 tokens/);
  assert.match(body, /do T-9/);
  assert.match(body, /memory\.md and your inbox/);
  assert.ok(body.length < 2600, 'long replies are clipped');
  assert.match(handoffBody('s', { resume: false, reason: 'model' }, { lastContextTokens: 1, lastModel: 'claude-opus-5' }, 'claude-opus-5-5'), /claude-opus-5 → claude-opus-5-5/);
});

// ── J4 policy ────────────────────────────────────────────────────────────────

test('only listed plugins the user has ON are switched off, keeping their marketplace key', () => {
  const o = leanPluginOverrides({
    'superpowers@claude-plugins-official': true, 'hookify@other-market': true, 'typescript-lsp@claude-plugins-official': true,
    'security-guidance@claude-plugins-official': true, 'feature-dev@claude-plugins-official': false
  });
  assert.deepEqual(o, { 'superpowers@claude-plugins-official': false, 'hookify@other-market': false });
  assert.deepEqual(leanPluginOverrides(undefined), {});
  for (const keep of ['typescript-lsp', 'security-guidance', 'lavish']) assert.ok(!LEAN_DISABLED_PLUGINS.includes(keep), keep);
});

test('withLeanArgs adds --strict-mcp-config once and leaves explicit MCP config alone', () => {
  assert.deepEqual(withLeanArgs(['--model', 'x']), ['--model', 'x', '--strict-mcp-config']);
  assert.deepEqual(withLeanArgs(['--strict-mcp-config']), ['--strict-mcp-config']);
  assert.deepEqual(withLeanArgs(['--mcp-config', 'a.json']), ['--mcp-config', 'a.json']);
});

// ── main-side levers ─────────────────────────────────────────────────────────

function sandboxHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'levers-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = prev; setCostLeversSource(null); fs.rmSync(home, { recursive: true, force: true }); });
  return home;
}

test('levers default ON in this fork', () => {
  assert.equal(COST_LEVERS_ON.trimPrefix, true);
  assert.equal(COST_LEVERS_ON.freshStartOnResume, true);
});

test('trimPrefix: off = args untouched; on = strict MCP + plugin overrides merged into the session settings', (t) => {
  const home = sandboxHome(t);
  const user = path.join(home, 'user-settings.json');
  fs.writeFileSync(user, JSON.stringify({ enabledPlugins: { 'superpowers@claude-plugins-official': true, 'typescript-lsp@claude-plugins-official': true } }));
  levers.setUserSettingsPathForTest(() => user);
  const settings = path.join(home, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks: { Stop: [] } }));
  const args = ['--settings', settings, '--model', 'claude-opus-5-5'];

  assert.deepEqual(levers.trimPrefixArgs(args), args, 'no config source = upstream behaviour');
  setCostLeversSource(() => ({ costLevers: { trimPrefix: false } }));
  assert.deepEqual(levers.trimPrefixArgs(args), args);

  setCostLeversSource(() => ({}));
  assert.deepEqual(levers.trimPrefixArgs(args), [...args, '--strict-mcp-config']);
  const written = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepEqual(written.enabledPlugins, { 'superpowers@claude-plugins-official': false });
  assert.deepEqual(written.hooks, { Stop: [] }, 'the hive settings are kept');
});

test('freshStartOnResume: a big session starts fresh and the agent gets a handoff; a small one resumes', (t) => {
  const home = sandboxHome(t);
  const cwd = path.join(home, 'repo');
  fs.mkdirSync(cwd);
  const { projectDir } = loadTs('src/main/transcript.ts');
  const dir = projectDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'big.jsonl'), [prompt('T-1'), call(240000)].join('\n'));
  fs.writeFileSync(path.join(dir, 'small.jsonl'), [prompt('T-2'), call(40000)].join('\n'));
  const sent = [];
  const base = { agentId: 'jim', cwd, explicit: false, args: ['--model', 'claude-opus-5-5'], send: (m) => sent.push(m) };

  assert.equal(levers.keepResume({ ...base, sessionId: 'big' }), true, 'levers off = always resume');
  setCostLeversSource(() => ({}));
  assert.equal(levers.keepResume({ ...base, sessionId: 'small' }), true);
  assert.equal(levers.keepResume({ ...base, sessionId: 'big', explicit: true }), true, 'explicit resume wins');
  assert.equal(sent.length, 0);
  assert.equal(levers.keepResume({ ...base, sessionId: 'big' }), false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'jim');
  assert.equal(sent[0].requires_reply, false);
  assert.match(sent[0].body, /FRESH session instead of a resume of big/);
});

test('index.ts carries only the two thin seams', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /import \{ keepResume, trimPrefixArgs \} from '\.\/custom\/sessionLevers';/);
  assert.match(idx, /if \(seedSessionTranscript\(opts\.cwd, sid\) && keepResume\(\{ agentId: opts\.hive\.id, sessionId: sid, cwd: opts\.cwd, explicit: !!explicitSid \|\| opts\.requireResume === true, args, send: \(m\) => hive\.send\(m, 'harness'\) \}\)\) \{/);
  assert.match(idx, /opts\.args = trimPrefixArgs\(args\);/);
});
