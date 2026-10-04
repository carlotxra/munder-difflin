/**
 * LIVE ROSTER levers (T-034).
 *
 *  - rosterToon (F2-F4): the roster as a TOON table with short roles, only an
 *    armed breaker printed, and a one-line tail. Seam: the first line of
 *    HiveManager.rosterContext().
 *  - rosterOnChange (F1): god gets the roster at SessionStart and on the first
 *    prompt of a session the hook has not seen, then again only when the floor
 *    changes in a way god routes by. Every copy stays in god's transcript and
 *    is re-read on every later call, so an unchanged floor is not re-sent.
 *    Seam: the roster expression in HookServer.handle().
 *    Claude god only (T-040): other bridges may drop SessionStart context
 *    (agy turns it into a user-visible systemMessage), so a non-Claude god
 *    keeps upstream's roster on every prompt.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { costLevers } from './levers';
import { isClaudeAgent } from './provider';
import { toonTable, shortRole, breakerArmed } from '../../shared/custom/rosterTable';

type CtxOf = (agentId: string) => { tokens: number; limit: number } | undefined;

interface FleetAgent {
  id: string; name?: string; role?: string; isGod?: boolean;
  breaker?: string; tokens?: number; usd?: number;
  lastActiveSecAgo?: number | null; inboxBacklog?: number; onHold?: boolean;
}

/** Cap the table so a big floor can't crowd out the prompt; fleet.json has the rest. */
const MAX_ROWS = 24;

function readFleet(root: string | null): { ts?: number; agents: FleetAgent[] } | null {
  if (!root) return null;
  try {
    const snap = JSON.parse(readFileSync(join(root, 'fleet.json'), 'utf8')) as { ts?: number; agents?: FleetAgent[] };
    const agents = Array.isArray(snap.agents) ? snap.agents : [];
    return agents.length ? { ts: snap.ts, agents } : null;
  } catch { return null; }
}

/** Live context-window use, 0-100, or null when no statusLine tick has fired. */
function ctxPct(ctxOf: CtxOf | undefined, id: string): number | null {
  const cw = ctxOf?.(id);
  if (!cw || !(cw.limit > 0)) return null;
  return Math.max(0, Math.min(100, Math.round((cw.tokens / cw.limit) * 100)));
}

const ago = (s: number | null | undefined): string =>
  typeof s !== 'number' ? '-'
    : s < 90 ? `${s}s`
      : s < 5400 ? `${Math.round(s / 60)}m`
        : `${Math.round(s / 3600)}h`;

const roleOf = (a: FleetAgent): string => (a.isGod ? `${shortRole(a.role)} (you)` : shortRole(a.role));

/** The roster as a TOON table, or null when there is nothing to say. Keeps every
 *  instruction of upstream's line: current floor, supersedes, absent = gone, and
 *  the ON HOLD rules when anyone is held. */
export function toonRoster(root: string | null, ctxOf?: CtxOf): string | null {
  const snap = readFleet(root);
  if (!snap || !root) return null;
  const shown = snap.agents.slice(0, MAX_ROWS);
  const anyHold = shown.some((a) => a.onHold);
  const rows = shown.map((a) => {
    const pct = ctxPct(ctxOf, a.id);
    return [a.id, a.name ?? null, roleOf(a), ago(a.lastActiveSecAgo),
      a.tokens ? Math.round(a.tokens / 1000) : 0,
      a.usd ? a.usd.toFixed(2) : 0,
      a.inboxBacklog ?? 0,
      breakerArmed(a.breaker) ? a.breaker! : null,
      pct === null ? null : `${pct}%`,
      a.onHold ? 'ON HOLD' : null];
  });
  const more = snap.agents.length > shown.length ? ` (+${snap.agents.length - shown.length} more in fleet.json)` : '';
  const age = typeof snap.ts === 'number' ? ago(Math.round((Date.now() - snap.ts) / 1000)) : '-';
  return [
    `[LIVE ROSTER from ${join(root, 'fleet.json')}, snapshot ${age} old. This is the CURRENT floor and SUPERSEDES any earlier roster: an agent absent here was archived or killed, so do not message it.]`,
    toonTable('agents', ['id', 'name', 'role', 'lastActive', 'ktok', 'usd', 'inbox', 'breaker', 'ctx', 'hold'], rows) + more,
    '"-" = none/normal; ctx = live context-window use ("-" = not reported yet: unknown, not empty).'
      + (anyHold
        ? ' ON HOLD = 1:1 with the human, UNAVAILABLE: Do NOT message them, do NOT dispatch to them,'
          + ' and do NOT count them when picking an owner; route to someone else or say the work is waiting.'
          + ' They are still running, so it is no reason to archive them or spawn a replacement. The human lifts the hold.'
        : '')
  ].join('\n');
}

/** Seam for HiveManager.rosterContext(): our table when the lever is on,
 *  undefined to fall through to upstream's line. */
export function customRosterContext(root: string | null, ctxOf?: CtxOf): string | null | undefined {
  return costLevers().rosterToon ? toonRoster(root, ctxOf) : undefined;
}

/** Unread mail in routing-sized steps: none, a few, a pile-up. */
const inboxBucket = (n: number | undefined): string => (!n ? '0' : n < 5 ? '1-4' : '5+');

/**
 * What god routes by: who is on the floor, names, roles, holds, an armed
 * breaker, unread mail in buckets (0 / 1-4 / 5+), and ctx in 10% steps (T-042).
 * Left out, or the key would change on almost every wake and the roster would
 * go out every prompt again: token and dollar counters, "seconds ago" and
 * live/idle, exact inbox counts, and god's own row (god is woken because its
 * inbox moved, and it knows its own state).
 */
export function rosterKey(root: string | null, ctxOf?: CtxOf): string | null {
  const snap = readFleet(root);
  if (!snap) return null;
  return snap.agents.filter((a) => !a.isGod).map((a) => {
    const pct = ctxPct(ctxOf, a.id);
    return [a.id, a.name ?? '', roleOf(a), a.onHold ? 1 : 0,
      breakerArmed(a.breaker) ? a.breaker : '',
      inboxBucket(a.inboxBacklog),
      pct === null ? '' : Math.floor(pct / 10)].join('|');
  }).join(';');
}

/** agentId → the session and key last injected. One live session per agent. */
const delivered = new Map<string, { sessionId: string | null; key: string }>();

/**
 * Seam for HookServer.handle(): the roster to inject on this hook, or null.
 * Lever off, or a non-Claude god → `roster` unchanged (upstream: every
 * SessionStart and prompt).
 */
export function gateRoster(
  agentId: string | undefined,
  event: string,
  sessionId: string | null | undefined,
  roster: string | null,
  key: () => string | null
): string | null {
  if (!roster || !agentId || !costLevers().rosterOnChange || !isClaudeAgent(agentId)) return roster;
  const k = key() ?? roster;
  const sid = sessionId ?? null;
  const last = delivered.get(agentId);
  if (event === 'SessionStart' || !last || last.sessionId !== sid || last.key !== k) {
    delivered.set(agentId, { sessionId: sid, key: k });
    return roster;
  }
  return null;
}

/** Test hook: forget what was delivered. */
export function resetRosterGate(): void { delivered.clear(); }
