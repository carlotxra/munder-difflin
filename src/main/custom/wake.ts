/**
 * Main-process wake levers (T-034). Rules in src/shared/custom/wake.ts.
 *
 *  - digestWakes (J1): the heartbeat's "actionable mail" count skips mechanical
 *    mail, so a worker's ACK or done report does not re-engage god by itself.
 *    The slim heartbeat lists that mail instead, so god sees it at the next beat.
 *    Seam: godActionableInboxCount() in index.ts.
 *  - shortNudge (F15): the watchdog's nudge text. Seam: nudgeWorker() in index.ts.
 *  - slimHeartbeat (F17): the heartbeat digest without raw log.jsonl lines.
 *    Seam: the first line of buildHeartbeatDigest() in index.ts.
 */
import type { HiveManager, HiveMessage } from '../hive';
import { inboxNudgeText } from '../../shared/hiveNudge';
import { isMechanicalMail, shortNudgeText } from '../../shared/custom/wake';
import { costLevers } from './levers';

function agentPredicate(hive: HiveManager): (id: string) => boolean {
  const reg = hive.registry();
  return (id) => id === 'harness' || (!!reg.agents[id] && id !== reg.godId);
}

/** True when this message in god's inbox should count as a reason to wake god. */
export function wakesGod(hive: HiveManager, m: HiveMessage): boolean {
  if (!costLevers().digestWakes) return true;
  return !isMechanicalMail(m, agentPredicate(hive));
}

export function nudgeText(ids: string[]): string {
  return costLevers().shortNudge ? shortNudgeText(ids) : inboxNudgeText(ids);
}

/** Mechanical mail waiting in god's inbox, newest last, for the digest. */
function waitingReports(hive: HiveManager): HiveMessage[] {
  const godId = hive.registry().godId;
  if (!godId) return [];
  const isAgent = agentPredicate(hive);
  return hive.inbox(godId).filter((m) => isMechanicalMail(m, isAgent));
}

/** One line for the last few log events: kinds with counts, plus the latest
 *  error if any. god can Read log.jsonl for the raw lines. */
function logSummary(entries: unknown[]): string {
  if (!entries.length) return '(none)';
  const counts = new Map<string, number>();
  let lastError = '';
  for (const e of entries) {
    const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
    const kind = typeof o.kind === 'string' ? o.kind : 'event';
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    const err = o.error ?? o.reason;
    if (typeof err === 'string' && err) lastError = `${kind}: ${err.slice(0, 120)}`;
  }
  const kinds = [...counts].map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join(', ');
  return lastError ? `${kinds}; last error ${lastError}` : kinds;
}

/** The slim digest, or null to fall through to upstream's. Same header and
 *  closing instruction as upstream; the board head is 5 lines and the log is
 *  one summary line. */
export function slimHeartbeatDigest(hive: HiveManager, quietMs: number, actionable: number): string | null {
  if (!costLevers().slimHeartbeat) return null;
  const reg = hive.registry();
  const active = Object.entries(reg.agents).filter(([id, a]) => !a.archived && id !== reg.godId);
  const names = active.map(([, a]) => a.name).join(', ') || '—';
  const withInbox = active.filter(([id]) => hive.inbox(id).length > 0).map(([, a]) => a.name);
  const boardHead = hive.board().split('\n').slice(0, 5).join('\n').trim();
  const reports = costLevers().digestWakes ? waitingReports(hive) : [];
  const header = actionable > 0
    ? `Floor heartbeat — ${actionable} actionable inbox message(s) awaiting you (worker/human mail). Drain your inbox NOW and act on them.`
    : `Floor heartbeat — quiet ~${Math.round(quietMs / 60000)}m.`;
  return [
    header,
    `Active agents (${active.length}): ${names}.`,
    withInbox.length ? `Undrained inbox: ${withInbox.join(', ')}.` : 'No undrained inboxes.',
    reports.length
      ? `Reports waiting in your inbox (${reports.length}, did not wake you): ${reports.slice(-5).map((m) => `${m.from}: ${m.subject}`).join('; ')}${reports.length > 5 ? '; …' : ''}.`
      : '',
    `Board (head): ${boardHead ? `\n${boardHead}` : '(empty)'}`,
    `Recent log: ${logSummary(hive.logTail(8))} (full: log.jsonl)`,
    'Re-engage anyone stalled or blocked and keep the board accurate — or rest if the work is genuinely done.'
  ].filter(Boolean).join('\n');
}
