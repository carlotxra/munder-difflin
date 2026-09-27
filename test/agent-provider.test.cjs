'use strict';
/**
 * Agent-provider registry tests. Self-contained, no test framework — run with
 * `node test/agent-provider.test.cjs` (mirrors test/kg-core.test.cjs). The
 * registry lives in TypeScript (src/shared/agentProvider.ts), so we transpile it
 * and its two dependency-free command-group siblings with the bundled `typescript`
 * compiler into a temp dir and require the result. Exercises the copilot preset
 * (GitHub Copilot CLI) end to end: registration, command inference, the print-mode
 * flag shape, and the model/resume passthrough — alongside the pre-existing codex
 * preset as a guard against regressions.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const SHARED = path.join(__dirname, '..', 'src', 'shared');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agentprov-'));
for (const name of ['claudeCommands', 'codexCommands', 'copilotCommands', 'grokCommands', 'agentProvider']) {
  const src = fs.readFileSync(path.join(SHARED, `${name}.ts`), 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText;
  fs.writeFileSync(path.join(out, `${name}.js`), js, 'utf8');
}
const ap = require(path.join(out, 'agentProvider.js'));

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.log(`  ✗ ${name}\n     ${err && err.message}`); }
}

console.log('agent-provider registry tests');

test('copilot is a recognized, selectable provider', () => {
  assert.ok(ap.isAgentProvider('copilot'), 'isAgentProvider("copilot")');
  assert.ok(ap.AGENT_PROVIDER_PRESETS.some((p) => p.id === 'copilot'), 'preset registered');
});

test('inferAgentProvider maps the copilot binary (with path/flags) to copilot', () => {
  assert.strictEqual(ap.inferAgentProvider('copilot'), 'copilot');
  assert.strictEqual(ap.inferAgentProvider('/usr/local/bin/copilot --model gpt-5.4'), 'copilot');
});

test('copilot preset runs the interactive TUI seeded via -i', () => {
  const p = ap.providerPreset('copilot');
  assert.strictEqual(p.defaultCommand, 'copilot', 'default command binary');
  assert.strictEqual(p.initialPromptFlag, '-i', 'seed rides in via -i, TUI stays alive');
  assert.strictEqual(p.seedDelivery, undefined, 'no type-into-tui needed');
  assert.strictEqual(ap.autoModeFlagForProvider('copilot'), '--allow-all-tools --no-ask-user');
  assert.strictEqual(p.autoFlag, '--allow-all-tools --no-ask-user', 'autoFlag mirrors autoModeFlag');
});

test('copilot is a hook-bridged, inbox-capable hive citizen', () => {
  const p = ap.providerPreset('copilot');
  assert.ok(p.supportsModel && p.modelFlag === '--model', 'model picker + --model');
  assert.strictEqual(p.resumeFlag, '--resume', 'session resume flag');
  assert.strictEqual(p.hiveAware, false, 'no Claude-only identity injection');
  assert.strictEqual(ap.canReceiveInbox('copilot'), true, 'receives routed mail');
  assert.deepStrictEqual(ap.bridgeOf('copilot'), { kind: 'hooks', shim: 'copilot' });
});

test('copilot exposes its verified slash-command catalogue', () => {
  const groups = ap.commandGroupsForProvider('copilot');
  assert.ok(groups.length > 0, 'command groups registered on the preset');
  const cmds = groups.flatMap((g) => g.items);
  // Slash commands confirmed in `copilot help commands` on CLI 1.0.88 (the /help
  // table). A new entry must be verified there and added here too.
  const verified = new Set(['/compact', '/clear', '/new', '/resume', '/rename', '/fork', '/context',
    '/usage', '/session', '/rewind', '/copy', '/share', '/exit', '/model', '/agent', '/subagents',
    '/tasks', '/fleet', '/plan', '/ask', '/permissions', '/allow-all', '/add-dir', '/list-dirs',
    '/reset-allowed-tools', '/diff', '/review', '/security-review', '/pr', '/env', '/instructions',
    '/mcp', '/skills', '/limits', '/help']);
  for (const c of cmds.filter((i) => i.kind === 'slash')) {
    assert.ok(verified.has(c.cmd), `${c.cmd} is not in the verified /help list`);
  }
  for (const c of cmds.filter((i) => i.kind === 'cli')) assert.match(c.cmd, /^copilot /);
  // The context commands providerAutomation types must be in the catalogue.
  assert.ok(cmds.some((c) => c.cmd === '/compact') && cmds.some((c) => c.cmd === '/clear'));
});

test('cursor is a recognized, selectable, god-eligible provider', () => {
  assert.ok(ap.isAgentProvider('cursor'), 'isAgentProvider("cursor")');
  assert.ok(ap.AGENT_PROVIDER_PRESETS.some((p) => p.id === 'cursor'), 'preset registered');
  assert.strictEqual(ap.canReceiveInbox('cursor'), true, 'interactive TUI can receive inbox');
});

test('inferAgentProvider maps cursor-agent (canonical) and agent (alias) to cursor', () => {
  assert.strictEqual(ap.inferAgentProvider('cursor-agent'), 'cursor');
  assert.strictEqual(ap.inferAgentProvider('/Users/me/.local/bin/cursor-agent --model gpt-5.6-luna-high'), 'cursor');
  assert.strictEqual(ap.inferAgentProvider('agent'), 'cursor');
});

test('cursor preset is interactive (no -p), uses force+trust auto flags, types seed into TUI', () => {
  const p = ap.providerPreset('cursor');
  assert.strictEqual(p.defaultCommand, 'cursor-agent', 'default command binary');
  assert.strictEqual(p.initialPromptFlag, undefined, 'no -p; stay interactive');
  assert.strictEqual(p.seedDelivery, 'type-into-tui', 'hive protocol typed after boot');
  assert.strictEqual(ap.autoModeFlagForProvider('cursor'), '--force --trust');
  assert.strictEqual(p.autoFlag, '--force --trust', 'autoFlag mirrors autoModeFlag');
  assert.strictEqual(p.recommendedOrchestratorModel, 'gpt-5.6-luna-high');
  assert.ok(p.supportsModel && p.modelFlag === '--model', 'model picker + --model');
  assert.strictEqual(p.resumeFlag, '--resume', 'session resume flag');
  assert.strictEqual(p.hiveAware, false, 'no Claude-only identity injection');
  assert.strictEqual(ap.bridgeOf('cursor'), undefined, 'no hook/proxy bridge yet');
});

test('codex preset still resolves (no regression)', () => {
  assert.strictEqual(ap.inferAgentProvider('codex'), 'codex');
  assert.strictEqual(ap.providerPreset('codex').defaultCommand, 'codex');
});

if (failures > 0) {
  console.log(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll agent-provider tests passed');
