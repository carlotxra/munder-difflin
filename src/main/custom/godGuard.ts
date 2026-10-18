/**
 * God write guard and compaction anchor (T-053).
 * Plan: docs/plans/orchestrator-alignment.md, Phase 3.
 *
 * The prompt says god never changes projects himself (V2 hard rule 1). This
 * makes it true on every engine with a hook bridge (Claude natively; Codex,
 * Copilot and the other bridged engines send Claude-shaped PreToolUse
 * payloads): a god tool call that would change files or a git repository
 * outside the hive is denied, with a reason that says what to do instead.
 *
 * Allowed: anything under the hive root (memory, inbox, outbox, board, tasks,
 * spawn requests) and the temp dir; read-only commands; and the one approved
 * project write, `git merge --ff-only <sha>`.
 *
 * Deliberately conservative: commands are split on shell separators without a
 * full parser, and anything it cannot read is allowed, never guessed at. Known
 * gaps (documented in CUSTOMIZATIONS.md): writes from inside an interpreter
 * (`python -c`, `node -e`), build tools (`npm install`, `make`), and engines
 * without hooks.
 */
import { resolve, join, sep, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync, existsSync } from 'node:fs';
import { orchestratorLevers } from './orchestrator';

export interface GuardInput {
  hiveRoot: string;
  cwd: string;
  toolName: string;
  toolInput: unknown;
}

/** null = allow; otherwise what was blocked and why. */
export interface GuardDecision {
  blocked: string;
  reason: string;
}

const RULE1 = "Orchestrator rule 1: you don't change project files or repositories yourself. Dispatch this to a worker (or ask the human on the card).";
const MERGE = 'Orchestrator rule 2: the only merge you run is `git merge --ff-only <reported SHA>` with the integration branch checked out, or `git fetch . <reported SHA>:<branch>` when it is not. If it cannot fast-forward, send the task back to the worker; never resolve a conflict yourself.';

/** Real path, resolving symlinks through the nearest existing parent, so a new
 *  file under /tmp (a symlink to /private/tmp on macOS) compares correctly. */
function canon(p: string): string {
  const abs = resolve(p);
  try { return realpathSync(abs); } catch { /* does not exist yet */ }
  const parent = dirname(abs);
  return parent === abs ? abs : join(canon(parent), basename(abs));
}
const under = (p: string, dir: string): boolean => { const a = canon(p); const b = canon(dir); return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep); };

/** True when `path` sits inside a git work tree below `stop` (a project that
 *  happens to live under the temp dir, like the eval's fixture repos). */
function inRepoBelow(path: string, stop: string): boolean {
  let d = canon(path);
  const end = canon(stop);
  while (d.startsWith(end) && d !== end) {
    if (existsSync(join(d, '.git'))) return true;
    d = dirname(d);
  }
  return false;
}

/** Paths god may write: the hive, /dev/null, and the temp dirs outside any repo. */
function writable(path: string, hiveRoot: string): boolean {
  if (path === '/dev/null' || path === 'NUL') return true;
  if (under(path, hiveRoot)) return true;
  return [tmpdir(), '/tmp', '/private/tmp'].some((d) => under(path, d) && !inRepoBelow(path, d));
}

// — shell —

/** Split on && || ; | and newlines (not inside quotes). Good enough to find
 *  each command's name; never used to run anything. */
export function splitCommands(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') { out.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '|' || c === '\n') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Words of one simple command, quotes removed. */
export function words(part: string): string[] {
  return (part.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map((w) => w.replace(/^(["'])(.*)\1$/, '$2'));
}

const MUTATING_GIT = new Set(['add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'commit', 'filter-branch', 'gc', 'mv', 'notes', 'pull', 'push', 'rebase', 'replace', 'reset', 'restore', 'revert', 'rm', 'switch', 'update-ref', 'worktree']);

/** Why a git command changes a repo, or null when it is read-only / allowed. */
function gitVerdict(args: string[]): { what: string; merge?: boolean } | null {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree'].includes(args[i]) ? 2 : 1;
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub) return null;
  if (MUTATING_GIT.has(sub)) return { what: `git ${sub}` };
  if (sub === 'merge') return rest.includes('--ff-only') && !rest.includes('--no-ff') && !rest.some((a) => a === '--abort' || a === '--continue') ? null : { what: 'git merge without --ff-only', merge: true };
  if (sub === 'branch') {
    const changing = rest.some((a) => ['-d', '-D', '-m', '-M', '-c', '-C', '-f', '--delete', '--move', '--copy', '--force', '--set-upstream-to', '-u'].includes(a));
    const positional = rest.filter((a) => !a.startsWith('-'));
    const listing = rest.some((a) => ['--list', '-l', '--contains', '--merged', '--no-merged', '--show-current', '-a', '-r', '-v', '-vv'].includes(a));
    return changing || (positional.length && !listing) ? { what: 'git branch (create/delete/move)' } : null;
  }
  if (sub === 'tag') return rest.filter((a) => !a.startsWith('-')).length && !rest.some((a) => a === '-l' || a === '--list') ? { what: 'git tag (create)' } : null;
  if (sub === 'stash') return ['list', 'show'].includes(rest[0]) ? null : { what: 'git stash' };
  if (sub === 'fetch') return rest.some((a) => a.startsWith('+')) ? { what: 'git fetch with a forced refspec' } : null;
  if (sub === 'remote') return rest.some((a) => ['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'prune'].includes(a)) ? { what: 'git remote (change)' } : null;
  if (sub === 'config') return rest.some((a) => ['--get', '--get-all', '--list', '-l', '--get-regexp'].includes(a)) ? null : { what: 'git config (write)' };
  return null;
}

/** The git dir a command acts on: `-C <dir>` or the current dir. */
function gitDir(args: string[], cwd: string): string {
  const i = args.indexOf('-C');
  return i >= 0 && args[i + 1] ? resolve(cwd, args[i + 1]) : cwd;
}

const FILE_CMDS = new Set(['rm', 'rmdir', 'mv', 'cp', 'touch', 'truncate', 'chmod', 'chown', 'ln', 'tee', 'mkdir', 'install', 'unlink']);

export function shellDecision(command: string, cwd0: string, hiveRoot: string): GuardDecision | null {
  let cwd = cwd0;
  for (const part of splitCommands(command)) {
    // Output redirections: `> file`, `>> file` (not `2>&1` / `>&2`). Quoted text is
    // masked first, so `node -e "x => y"` is not read as a redirect to `y`.
    const quoted: string[] = [];
    const masked = part.replace(/"[^"]*"|'[^']*'/g, (q) => `\u0000${quoted.push(q) - 1}\u0000`);
    const unmask = (s: string): string => s.replace(/\u0000(\d+)\u0000/g, (_, i) => quoted[Number(i)]);
    for (const m of masked.matchAll(/(?:^|[^0-9&<>=])>>?\s*([^\s&|;<>]+)/g)) {
      const target = resolve(cwd, unmask(m[1]).replace(/^(["'])(.*)\1$/, '$2'));
      if (!writable(target, hiveRoot)) return { blocked: `writing ${target}`, reason: RULE1 };
    }
    const w = words(unmask(masked.replace(/\d?>>?\s*\S+/g, '')));
    let k = 0;
    while (k < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[k])) k++; // env assignments
    const name = w[k];
    const args = w.slice(k + 1);
    if (!name) continue;
    if (name === 'cd') { cwd = resolve(cwd, args[0] ?? cwd); continue; }
    if (name === 'git') {
      const v = gitVerdict(args);
      if (v && !under(gitDir(args, cwd), hiveRoot)) return { blocked: v.what, reason: v.merge ? MERGE : RULE1 };
      continue;
    }
    if (name === 'sed' || name === 'perl') {
      if (!args.some((a) => /^-i/.test(a) || /^-[a-zA-Z]*i/.test(a))) continue;
      const files = args.filter((a) => !a.startsWith('-')).slice(1);
      const bad = files.map((f) => resolve(cwd, f)).find((f) => !writable(f, hiveRoot));
      if (bad) return { blocked: `${name} -i on ${bad}`, reason: RULE1 };
      continue;
    }
    if (FILE_CMDS.has(name)) {
      const paths = args.filter((a) => !a.startsWith('-'));
      const targets = name === 'cp' || name === 'install' ? paths.slice(-1) : paths;
      const bad = targets.map((f) => resolve(cwd, f)).find((f) => !writable(f, hiveRoot));
      if (bad) return { blocked: `${name} ${bad}`, reason: RULE1 };
    }
  }
  return null;
}

// — tool calls —

const SHELL_TOOL = /^(bash|shell|run_shell_command|exec_command|run_terminal_cmd|terminal|local_shell|powershell)$/i;
const WRITE_TOOL = /(write|edit|create|replace|insert|patch|notebook|delete|move|rename)/i;

/** The shell command in a tool input, whatever the engine calls it. */
function commandOf(input: Record<string, unknown>): string | null {
  const c = input.command ?? input.cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every((x) => typeof x === 'string')) {
    const a = c as string[];
    // ['bash', '-lc', '<script>'] → the script
    const i = a.findIndex((x) => x === '-c' || x === '-lc');
    return i >= 0 && a[i + 1] ? a[i + 1] : a.join(' ');
  }
  return null;
}

/** Paths a file-writing tool targets: the usual fields, plus apply_patch headers. */
function writePaths(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ['file_path', 'path', 'filePath', 'notebook_path', 'target_file', 'filename']) {
    if (typeof input[k] === 'string') out.push(input[k] as string);
  }
  for (const v of Object.values(input)) {
    if (typeof v !== 'string') continue;
    for (const m of v.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) out.push((m[1] ?? m[2]).trim());
  }
  return out;
}

/** The decision for one god tool call (pure; exported for tests). */
export function decide(g: GuardInput): GuardDecision | null {
  const input = (g.toolInput && typeof g.toolInput === 'object' ? g.toolInput : {}) as Record<string, unknown>;
  const cmd = SHELL_TOOL.test(g.toolName) ? commandOf(input) : null;
  if (cmd !== null) return shellDecision(cmd, g.cwd, g.hiveRoot);
  if (WRITE_TOOL.test(g.toolName)) {
    const bad = writePaths(input).map((p) => resolve(g.cwd, p)).find((p) => !writable(p, g.hiveRoot));
    if (bad) return { blocked: `${g.toolName} ${bad}`, reason: RULE1 };
  }
  return null;
}

interface HiveLike {
  isGod(agentId: string): boolean;
  root(): string | null;
  appendLog(event: Record<string, unknown>): void;
  registry(): { agents: Record<string, { name?: string } | undefined> };
}

/** hooks.ts seam: the PreToolUse deny for god, or null to carry on. Logs every
 *  denial to log.jsonl as `god-guard`. */
export function godWriteGuard(
  hive: HiveLike,
  agentId: string | undefined,
  event: string,
  p: { tool_name?: string; tool_input?: unknown; cwd?: string }
): { reason: string; output: unknown } | null {
  if (event !== 'PreToolUse' || !agentId || !orchestratorLevers().godWriteGuard || !hive.isGod(agentId)) return null;
  const root = hive.root();
  if (!root) return null;
  let d: GuardDecision | null = null;
  try {
    d = decide({ hiveRoot: root, cwd: p.cwd || root, toolName: p.tool_name ?? '', toolInput: p.tool_input });
  } catch { return null; } // never break a hook over the guard
  if (!d) return null;
  const reason = `${d.reason} Blocked: ${d.blocked}.`;
  try { hive.appendLog({ kind: 'god-guard', agentId, tool: p.tool_name, blocked: d.blocked }); } catch { /* best effort */ }
  return { reason, output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } };
}

/** hooks.ts seam: a role reminder for god's SessionStart after a compaction or
 *  resume, merged with the other additionalContext; null otherwise. */
export function compactAnchor(
  hive: HiveLike,
  agentId: string | undefined,
  event: string,
  source: string | undefined
): string | null {
  if (event !== 'SessionStart' || !agentId || !orchestratorLevers().compactAnchor || !hive.isGod(agentId)) return null;
  if (source !== 'compact' && source !== 'resume') return null;
  const name = hive.registry().agents[agentId]?.name ?? 'the orchestrator';
  const root = hive.root();
  return [
    `ROLE REMINDER (your context was ${source === 'compact' ? 'compacted' : 'resumed'}): you are ${name}, the orchestrator of this hive. You run the team; you do not do its work.`,
    'Hard rules: 1. never change project files or repositories yourself (the one exception is the approved `git merge --ff-only <reported SHA>`); 2. merge only with the human\'s yes for that task; 3. you alone write board.md and tasks.json; 4. only you talk to the human, through humanQA asks on cards; 5. report outcomes faithfully.',
    `Next: read your memory.md and every file in your inbox${root ? ` (${join(root, 'agents', agentId)})` : ''}.`
  ].join('\n');
}
