/**
 * Wake levers shared by the renderer and main (T-034).
 *
 *  - digestWakes (J1): which mail is MECHANICAL for god, meaning it must not
 *    wake god on its own. God reads it with the next mail that does wake it, or
 *    with the next heartbeat (which lists it). Everything that needs god now
 *    still wakes at once: requests and queries, DECISION NEEDED, needs_human,
 *    anything that asks for a reply, and anything not from a floor agent
 *    (the human, webhooks, failure notices from the ephemeral-worker
 *    controller).
 *  - shortNudge (F15): the inbox-wake nudge in fewer words. It keeps upstream's
 *    head (hiveNudge.ts NUDGE_HEAD), because the message queue's one-pending
 *    rule recognises a nudge by that head.
 */

export interface MailLike {
  id?: string;
  from?: string;
  act?: string;
  subject?: string;
  requires_reply?: boolean;
  needs_human?: boolean;
}

const ACK_RE = /CLOSING[-_\s]*TIME[-_\s]*ACK/i;
const DECISION_RE = /DECISION\s+NEEDED/i;
/** Acts that only report. request/query/propose ask for something; refuse is
 *  pushback god should see now. */
const REPORT_ACTS = new Set(['inform', 'done', 'agree']);

/** True when this message, sent to god, can wait for god's next real wake. */
export function isMechanicalMail(m: MailLike, isAgent: (id: string) => boolean): boolean {
  if (!m || m.needs_human || m.requires_reply === true) return false;
  const from = m.from ?? '';
  const subject = m.subject ?? '';
  // A closing-time ACK is bookkeeping: the harness counts it, god only waits.
  if (ACK_RE.test(subject)) return from === 'harness' || isAgent(from);
  if (!isAgent(from) || DECISION_RE.test(subject)) return false;
  return REPORT_ACTS.has(m.act ?? '');
}

/** Must start with hiveNudge.ts NUDGE_HEAD (see isInboxNudge). */
export const SHORT_NUDGE_HEAD = 'You have new hive inbox message(s)';

export function shortNudgeText(ids: string[]): string {
  const named = ids.length ? ` — at least: ${ids.join(', ')}` : '';
  return `${SHORT_NUDGE_HEAD}${named}. Work everything pending in your inbox (it is authoritative; an id already in inbox/.done/ was handled earlier), move handled ones to inbox/.done/, and act autonomously: message god only for a real decision.`;
}
