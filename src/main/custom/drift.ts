/**
 * Drift visibility (T-056). Plan: docs/plans/orchestrator-alignment.md, Phase 6.
 *
 * The harness checks what god left on disk against his hard rules and makes
 * breaches visible: once to god (on his next prompt, through the same hook
 * context as the roster), as a count in the heartbeat digest, and as a
 * `god-drift` line in log.jsonl for the human.
 *
 * Only checks that cannot misfire. Each reads a file the harness already
 * keeps; none guesses at intent:
 *   - assignee: a card that is doing, blocked or done with no assignee
 *   - ask:      an open humanQA ask over 700 characters, without a **bold**
 *               first sentence, or without listed options
 *   - spawn:    a pending spawn request while orchestrator spawning is off
 *   - outbox:   a message god wrote that the harness could not read
 *               (archived as outbox/.sent/bad-*)
 * Guard denials (T-053) are already logged as `god-guard` and god saw the
 * reason in-turn; they are counted in the heartbeat, not repeated to him.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { orchestratorLevers } from './orchestrator';

export interface Breach {
  rule: 'assignee' | 'ask' | 'spawn' | 'outbox';
  /** Stable identity, so each breach is reported once. */
  key: string;
  /** What god should do about it, in one line. */
  text: string;
}

interface HiveLike {
  root(): string | null;
  isGod(agentId: string): boolean;
  orchestratorMaySpawn(): boolean;
  appendLog(event: Record<string, unknown>): void;
  logTail(n?: number): unknown[];
  registry(): { godId?: string | null };
}

interface Card {
  id?: string;
  status?: string;
  assignee?: string | null;
  humanQA?: { q?: unknown; a?: unknown; askedAt?: unknown }[];
}

const readJson = (f: string): unknown => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const listJson = (d: string): string[] => { try { return readdirSync(d).filter((f) => f.endsWith('.json')).sort(); } catch { return []; } };

/** Why an ask is not in card shape, or [] when it is. Same rules as the prompt and `hive ask`. */
export function askProblems(q: string): string[] {
  const p: string[] = [];
  if (q.length > 700) p.push(`${q.length} characters (keep it under 700)`);
  if (!/^\s*\*\*[^*\n]+\*\*/.test(q)) p.push('no **bold** first sentence');
  if (!/^\s*(-|\*|\d+\.)\s/m.test(q)) p.push('no listed options');
  return p;
}

/** Every breach currently on disk (pure apart from reads; exported for tests). */
export function scanDrift(hive: HiveLike): Breach[] {
  const root = hive.root();
  if (!root) return [];
  const out: Breach[] = [];
  const tasks = (readJson(join(root, 'tasks.json')) as { tasks?: Card[] } | null)?.tasks;
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || typeof t.id !== 'string') continue;
    if (['doing', 'blocked', 'done'].includes(t.status ?? '') && !t.assignee) {
      out.push({ rule: 'assignee', key: `assignee:${t.id}:${t.status}`, text: `Card ${t.id} is ${t.status} with no assignee: set "assignee" to the worker's agent id (never clear it).` });
    }
    (Array.isArray(t.humanQA) ? t.humanQA : []).forEach((e, i) => {
      if (!e || typeof e.q !== 'string' || e.a !== undefined) return;
      const p = askProblems(e.q);
      if (p.length) out.push({ rule: 'ask', key: `ask:${t.id}:${i}`, text: `The open ask on ${t.id} is not in card shape (${p.join('; ')}): add a rewritten one that opens with one **bold** sentence and lists the options.` });
    });
  }
  if (!hive.orchestratorMaySpawn()) {
    for (const f of listJson(join(root, 'spawn-requests'))) {
      out.push({ rule: 'spawn', key: `spawn:${f}`, text: `Spawn request ${f} was filed while spawning is off, so it will not run: delete it and ask the human on the card to hire someone or switch spawning on.` });
    }
  }
  const godId = hive.registry().godId;
  if (godId) {
    const sent = join(root, 'agents', godId, 'outbox', '.sent');
    let bad: string[] = [];
    try { bad = readdirSync(sent).filter((f) => f.startsWith('bad-')); } catch { /* none */ }
    for (const f of bad) out.push({ rule: 'outbox', key: `outbox:${f}`, text: `Your message ${f.slice(4)} could not be read, so it was not delivered: write it again as valid JSON (schema in PROTOCOL.md).` });
  }
  return out;
}

// Breaches already reported to god, per god agent id. In memory: after an app
// restart each open breach is reported once more, which is the right default.
const reported = new Map<string, Set<string>>();

/** Test hook. */
export function resetDriftReports(): void { reported.clear(); }

/** hooks.ts seam (merged into the same context as the roster): new breaches for
 *  god on SessionStart / UserPromptSubmit, each reported once and logged. */
export function driftNotice(hive: HiveLike, agentId: string | undefined, event: string): string | null {
  if ((event !== 'UserPromptSubmit' && event !== 'SessionStart') || !agentId) return null;
  if (!orchestratorLevers().driftNotice || !hive.isGod(agentId)) return null;
  let fresh: Breach[];
  try {
    const seen = reported.get(agentId) ?? new Set<string>();
    reported.set(agentId, seen);
    fresh = scanDrift(hive).filter((b) => !seen.has(b.key));
    for (const b of fresh) {
      seen.add(b.key);
      try { hive.appendLog({ kind: 'god-drift', agentId, rule: b.rule, key: b.key }); } catch { /* best effort */ }
    }
  } catch { return null; }
  if (!fresh.length) return null;
  return [`RULE CHECK: the harness found ${fresh.length} thing(s) on disk that break your rules. Fix them now:`, ...fresh.map((b) => `- ${b.text}`)].join('\n');
}

/** Heartbeat digest line (custom/wake.ts): open breaches plus recent guard denials, or ''. */
export function driftDigestLine(hive: HiveLike): string {
  if (!orchestratorLevers().driftNotice) return '';
  let open: Breach[] = [];
  let denials = 0;
  try {
    open = scanDrift(hive);
    denials = hive.logTail(200).filter((e) => (e as { kind?: string } | null)?.kind === 'god-guard').length;
  } catch { return ''; }
  if (!open.length && !denials) return '';
  const byRule = Object.entries(open.reduce<Record<string, number>>((m, b) => ({ ...m, [b.rule]: (m[b.rule] ?? 0) + 1 }), {}))
    .map(([r, n]) => `${r} ${n}`).join(', ');
  return `Rule check: ${open.length} open breach(es)${byRule ? ` (${byRule})` : ''}; ${denials} blocked attempt(s) to change a project in the recent log.`;
}
