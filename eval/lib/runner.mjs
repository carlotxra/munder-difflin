// T-050: one headless runner per engine, so the same fixtures can be scored on
// Claude and on the other engines Michael runs on.
//
// Each runner turns the harness's own launch injection (hive.ensureAgent for that
// provider) into a one-shot headless command. Nothing about the hive prompt is
// hard-coded: Claude gets it via --append-system-prompt exactly as in the app; a
// non-Claude engine gets it the way the app delivers it, as the first user message
// (the preset's initialPromptFlag or trailing positional), with the inbox nudge
// appended. In the app those are two turns; a one-shot run merges them, which is
// the closest a headless CLI allows.
//
// Only engines checked against their own `--help` on this machine are listed.
// `codex` (vendor binary missing here) and `pi` are left out until they can be
// checked; see eval/README.md.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseStream } from './usage.mjs';

const find = (name, extra = []) => [...extra, join(homedir(), '.local/bin', name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`].find(existsSync) ?? name;

/** The hive prompt a non-Claude engine receives as its first user message, read
 *  back from the launch argv the harness built for it. */
export function initialPrompt(args, preset) {
  if (preset.initialPromptFlag) {
    const i = args.lastIndexOf(preset.initialPromptFlag);
    return i >= 0 ? args[i + 1] ?? '' : '';
  }
  return preset.positionalInitialPrompt ? args[args.length - 1] ?? '' : '';
}

/** Best-effort token totals from an engine's JSONL output. Engines name the
 *  fields differently and none but Claude reports $, so tokens may stay 0 and
 *  costUsd is null (shown as n/a). File-system checks never depend on this. */
export function parseGenericUsage(text) {
  const u = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, turns: 0, error: null, denials: [] };
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const visit = (o) => {
    if (!o || typeof o !== 'object') return;
    const inp = o.input_tokens ?? o.inputTokens ?? o.input;
    const out = o.output_tokens ?? o.outputTokens ?? o.output;
    if (typeof inp === 'number' && typeof out === 'number') {
      u.calls++;
      u.input += num(inp);
      u.output += num(out);
      u.cacheRead += num(o.cache_read_input_tokens ?? o.cached_input_tokens ?? o.cacheReadTokens ?? o.cache?.read);
      u.cacheWrite += num(o.cache_creation_input_tokens ?? o.cacheWriteTokens ?? o.cache?.write);
      return;
    }
    for (const v of Object.values(o)) visit(v);
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { visit(JSON.parse(line)); } catch { /* not JSON: progress text */ }
  }
  return u;
}

/** Copilot `--output-format json`: each `session.usage_checkpoint` carries the
 *  session's running totals, repeated under several keys (per model, per agent,
 *  per provider), so summing every usage object counts them several times. Take
 *  the last checkpoint's `accountingSnapshot.modelMetrics` (summed over models)
 *  and count model calls from `model.call_finished`. Copilot CLI 1.0.98. */
export function parseCopilotUsage(text) {
  const u = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, turns: 0, error: null, denials: [] };
  let last = null;
  // Tool calls by id, so a permission refusal can name what was refused.
  const started = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'tool.execution_start') started.set(ev.data?.toolCallId, ev.data);
    else if (ev.type === 'tool.execution_complete' && ev.data?.success === false && /^Permission denied/i.test(ev.data?.error?.message ?? '')) {
      // --perm safe refusals, like Claude's permission_denials: tool + a hint of the input.
      const st = started.get(ev.data.toolCallId) ?? {};
      const hint = st.arguments?.command ?? st.arguments?.path ?? '';
      u.denials.push(`${st.toolName ?? 'tool'}${hint ? ` ${String(hint).slice(0, 60)}` : ''}`);
    }
    if (ev.type === 'model.call_finished') u.calls++;
    else if (ev.type === 'assistant.turn_end') u.turns++;
    else if (ev.type === 'session.usage_checkpoint') last = ev.data?.accountingSnapshot?.modelMetrics ?? last;
  }
  for (const m of Object.values(last ?? {})) {
    const x = m?.usage ?? {};
    u.input += x.inputTokens ?? 0;
    u.output += x.outputTokens ?? 0;
    u.cacheRead += x.cacheReadTokens ?? 0;
    u.cacheWrite += x.cacheWriteTokens ?? 0;
  }
  return u;
}

// Bash commands a fixture needs, shared by every engine's safe mode. `merge` and
// `fetch` are here for the god landing fixtures (G9-G12); the repo is a throwaway.
// Read-only git subcommands, also allowed as `git --no-pager <sub>`: Copilot chains
// these into one shell command, and one unlisted part refuses the whole command
// (T-052 confirmation run: G9/G11/G12 failed on `git show-ref` and `--no-pager`).
export const READ_GIT = ['status', 'diff', 'log', 'show', 'rev-parse', 'merge-base', 'show-ref', 'rev-list', 'ls-files', 'for-each-ref', 'cat-file'];
export const SAFE_GIT = [...READ_GIT, 'add', 'commit', 'checkout', 'switch', 'branch', 'stash', 'mv', 'merge', 'fetch', ...READ_GIT.map((c) => `--no-pager ${c}`)];
// `test`, `true`, `sort` and `npm test` since the eval-copilot-reads fix: Copilot chains
// them into its git checks (`git merge --ff-only <sha> && test "$(git rev-parse HEAD)" = <sha>`),
// and one unlisted part refuses the whole command. `npm test` runs the fixture repo's
// `node --test test/`, no more than `node --test`. Still off on purpose: `find` and
// `sed` (can run commands), interpreters, shell loops, and `git -C` (it would
// slip past the `git push` deny rule).
export const SAFE_CMDS = ['cd', 'node --test', 'npm test', 'ls', 'mv', 'mkdir', 'cat', 'head', 'tail', 'wc', 'pwd', 'date', 'echo', 'printf', 'test', 'true', 'sort'];

export const RUNNERS = {
  claude: {
    label: 'Claude Code',
    bin: (o) => o.claude ?? find('claude'),
    // Safe mode: acceptEdits plus a tool allowlist; anything else is denied and logged.
    safe: true,
    // Spend is capped by the CLI itself (--max-budget-usd) and reported as $.
    reportsUsd: true,
    envKeep: /^(ANTHROPIC_\w+|CLAUDE_CONFIG_DIR)$/,
    argv({ inj, trigger, perm, budgetUsd, model }) {
      const tools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite',
        ...SAFE_GIT.map((c) => `Bash(git ${c}:*)`), ...SAFE_CMDS.map((c) => `Bash(${c}:*)`)];
      const permArgs = perm === 'live'
        ? ['--permission-mode', 'bypassPermissions']
        : ['--permission-mode', 'acceptEdits', '--allowedTools', tools.join(',')];
      return ['-p', trigger, '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
        ...permArgs, '--max-budget-usd', budgetUsd.toFixed(2), ...(model ? ['--model', model] : []), ...inj.args];
    },
    parse: parseStream
  },
  copilot: {
    label: 'GitHub Copilot CLI',
    bin: () => find('copilot'),
    // Safe mode via Copilot's own tool permissions: file writes plus the same
    // command list; pushes and remotes denied. Copilot has no $ figure (it bills
    // premium requests), so --max-usd cannot cap it: see --accept-uncapped.
    safe: true,
    reportsUsd: false,
    envKeep: /^(GH_TOKEN|GITHUB_TOKEN|COPILOT_\w+|XDG_\w+)$/,
    argv({ inj, trigger, perm, model, preset, dirs }) {
      const message = `${initialPrompt(inj.args, preset)}\n\n${trigger}`;
      const permArgs = perm === 'live'
        ? ['--allow-all-tools']
        // Same list as Claude's, command by command (`shell(git status:*)`, not
        // `shell(git:*)`), so neither engine gets a wider allowlist than the other.
        : ['--allow-tool', 'write',
          ...[...SAFE_GIT.map((c) => `git ${c}`), ...SAFE_CMDS].flatMap((c) => ['--allow-tool', `shell(${c}:*)`]),
          '--deny-tool', 'shell(git push)', '--deny-tool', 'shell(git remote)'];
      return ['-p', message, '-s', '--output-format', 'json', '--no-ask-user', ...permArgs,
        ...dirs.flatMap((d) => ['--add-dir', d]), ...(model ? ['--model', model] : [])];
    },
    parse: parseCopilotUsage
  },
  opencode: {
    label: 'OpenCode',
    bin: () => find('opencode'),
    // OpenCode's permissions come from its config, not flags, and default to
    // allow, so it only runs with --perm live (the human's explicit opt-in).
    safe: false,
    reportsUsd: false,
    envKeep: /^(OPENCODE_\w+|XDG_\w+)$/,
    argv({ inj, trigger, model, preset, repo }) {
      const message = `${initialPrompt(inj.args, preset)}\n\n${trigger}`;
      return ['run', '--format', 'json', '--dir', repo, ...(model ? ['--model', model] : []), message];
    },
    parse: parseGenericUsage
  }
};
