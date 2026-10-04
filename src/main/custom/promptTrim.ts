/**
 * Prompt and doc wording levers (T-034), applied as keyed overrides on top of
 * upstream's text instead of editing upstream's strings in place.
 *
 * Each override names the exact upstream wording it replaces. When an upstream
 * merge rewrites that wording, the override stops matching and
 * test/cost-levers-prompt.test.cjs fails, naming the override. Nothing
 * silently half-applies.
 *
 *  - promptTrim (F5, F8-F12, F14): tighter system-prompt wording, the SLACK
 *    REPLIES line only when Slack is on, LIVE CONTEXT only for god.
 *    Seam: the return of HiveManager.injectedPrompt().
 *  - tasksOwnerProtocol (F13): PROTOCOL.md says god is the sole writer of
 *    tasks.json; workers report status by message. Seam: the two loops that
 *    write GENERATED_HIVE_DOCS.
 *
 * Meaning is unchanged everywhere except F13, which records god's decision of
 * 2026-10-04 (god044).
 */
import { costLevers } from './levers';

export interface TextOverride {
  id: string;
  /** Exact upstream text, or a pattern when it embeds a path. */
  find: string | RegExp;
  replace: string;
}

/** System-prompt wording (lever promptTrim). Order matters only for readability. */
export const PROMPT_OVERRIDES: TextOverride[] = [
  {
    id: 'F8-memory-steps',
    find: /^2\. Record durable facts, decisions, and context by appending to (.+)\.\n(3\. .+)\n4\. At the END of a task, append what you learned to memory\.md so future-you remembers\.$/m,
    replace: '2. Append durable facts, decisions and context to $1 as you go, and what you learned at the END of a task, so future-you remembers.\n$2'
  },
  {
    id: 'F14-guardrails',
    find: 'Guardrails: a circuit breaker watches the floor — a "Circuit breaker: steer/constrain" message means you are looping or overspending, so STOP repeating, summarize what you tried, and follow it. Be token-frugal (a floor-wide or per-agent token budget can pause you). The shared plan has two parts: board.md (freeform; god is the sole scribe) and tasks.json (structured kanban — todo/doing/blocked/done).',
    replace: 'Guardrails: a circuit breaker watches the floor. A "Circuit breaker: steer/constrain" message means you are looping or overspending: STOP repeating, summarize what you tried, and follow it. Be token-frugal (a floor-wide or per-agent token budget can pause you). The shared plan is board.md (freeform) and tasks.json (kanban); god is the sole writer of both.'
  },
  {
    id: 'F9-knowledge-graph',
    find: /Enterprise knowledge: this organisation has a private Knowledge Graph of its own documents, policies, and business context\. When a task needs that context — company-specific facts, house style, internal processes — query it instead of guessing: run (`"[^`]+" "[^`]+" search "<query>"`) for ranked passages, `"[^`]+" "[^`]+" list` to see what is available, and `"[^`]+" "[^`]+" get <id>` for a full document\. \(That first path is the harness's bundled Node — use it instead of bare `node`, which may not be on your PATH\.\)/,
    replace: 'Enterprise knowledge: a private Knowledge Graph holds this organisation\'s documents, policies and business context. When a task needs company-specific facts, house style or internal processes, query it instead of guessing: $1 (ranked passages), then `list` (what is available) or `get <id>` (a full document) with the same two paths. The first path is the harness\'s bundled Node; use it, not bare `node`, which may not be on your PATH.'
  },
  {
    id: 'F10-running-build',
    find: 'A local dev build inherits the launching shell\'s environment (umask included) where a packaged app does not, so file modes and inherited env can legitimately differ between the two. `log.jsonl` records an `app-start` event on every launch, which is how you spot a restart or a build switch.',
    replace: 'A dev build inherits the launching shell\'s env (umask included); a packaged app does not. `log.jsonl` logs an `app-start` on every launch.'
  },
  {
    id: 'F12-spawn-queue',
    find: 'Required: `objective` (what the worker must do) and `cwd` (the repo it runs in). Optional: `name`, `command` (overrides the provider default), `provider` (selects its default CLI when command is omitted), `model`, `isolate` (default true = its own git worktree), `tokenCap`, and `slack` ({channel, thread_ts}) to route its failures back to a thread. The harness polls that directory, spawns `worker-<id>`, and moves the request to `spawn-requests/.done/` on success or `.failed/` with a reason. This is the ONLY way you can spawn; a hire manifest under research/hires/ needs the human to confirm it in the UI, so it is not a route you can complete on your own. Reuse an existing agent first, as above — a worker is a fresh spend every time.',
    replace: 'Required: `objective` and `cwd` (the repo it runs in); the optional fields (provider, model, isolate, tokenCap, slack, …) are in PROTOCOL.md. The harness spawns `worker-<id>` and moves the request to `spawn-requests/.done/`, or `.failed/` with a reason. This is the ONLY spawn route you can complete yourself (a hire manifest under research/hires/ needs the human to confirm it in the UI). Reuse an existing agent first: every worker is fresh spend.'
  },
  {
    id: 'F5-live-context',
    find: 'LIVE CONTEXT: each agent row in the LIVE ROSTER carries a `ctx NN%` tag — its live context-window occupancy. Treat it as the real headroom signal when routing: prefer an agent with a LOW `ctx` for a big task; treat a HIGH `ctx` (near 100%) as busy rather than idle, even if the cumulative token count looks modest.',
    replace: 'LIVE CONTEXT: the roster\'s `ctx` is each agent\'s live context-window use, the real headroom signal when routing: prefer a LOW `ctx` for a big task, and treat a HIGH `ctx` (near 100%) as busy rather than idle, even when its token count looks modest.'
  }
];

/** PROTOCOL.md wording (lever tasksOwnerProtocol). */
export const PROTOCOL_OVERRIDES: TextOverride[] = [
  {
    id: 'F13-tasks-owner',
    find: '  assignee, priority, deps). Keep the task you\'re working reflected in its status.',
    replace: '  assignee, priority, deps). God is its sole writer: report your task\'s status to god by message\n  (started, blocked, done) and never edit tasks.json yourself.'
  }
];

/** Apply overrides; returns the text and the ids that did not match. */
export function applyOverrides(text: string, overrides: TextOverride[]): { text: string; missed: string[] } {
  const missed: string[] = [];
  let out = text;
  for (const o of overrides) {
    const hit = typeof o.find === 'string' ? out.includes(o.find) : o.find.test(out);
    if (!hit) { missed.push(o.id); continue; }
    out = typeof o.find === 'string' ? out.split(o.find).join(o.replace) : out.replace(o.find, o.replace);
  }
  return { text: out, missed };
}

let slackOn: () => boolean = () => false;
/** Install the Slack probe (index.ts). Read once per prompt build, so a prompt
 *  stays stable for an agent's whole session (prompt-cache invariant). */
export function setSlackProbe(probe: () => boolean): void { slackOn = probe; }

/** Drop whole lines that start with `prefix`. */
const dropLine = (text: string, prefix: string): string =>
  text.split('\n').filter((l) => !l.startsWith(prefix)).join('\n');

/** Seam for HiveManager.injectedPrompt(): the trimmed prompt when the lever is on. */
export function trimPrompt(text: string, meta: { isGod?: boolean }): string {
  if (!costLevers().promptTrim) return text;
  let out = applyOverrides(text, PROMPT_OVERRIDES).text;
  if (!meta.isGod) out = dropLine(out, 'LIVE CONTEXT:'); // F5: only god gets a roster
  if (!slackOn()) out = dropLine(out, 'SLACK REPLIES:'); // F11: no Slack, no Slack rules
  return out;
}

/** Seam for the GENERATED_HIVE_DOCS writers. */
export function customDoc(filename: string, contents: string): string {
  if (filename !== 'PROTOCOL.md' || !costLevers().tasksOwnerProtocol) return contents;
  return applyOverrides(contents, PROTOCOL_OVERRIDES).text;
}
