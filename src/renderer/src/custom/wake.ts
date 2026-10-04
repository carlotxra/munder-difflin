/**
 * Renderer side of the wake levers (T-034, J1 + F15). See
 * src/shared/custom/wake.ts for the rules.
 *
 * Seams: the inbox-wake loop in hooks/useHive.ts (which messages count as
 * fresh, and the nudge text).
 */
import { useStore } from '@/store/store';
import { inboxNudgeText } from '../../../shared/hiveNudge';
import { resolveCostLevers, COST_LEVERS_ON, type CostLevers } from '../../../shared/custom/costLevers';
import { isMechanicalMail, shortNudgeText, type MailLike } from '../../../shared/custom/wake';

/** The levers, refreshed from config at most every 15s. The wake loop runs in
 *  a long-lived interval whose closure would otherwise keep the config it
 *  started with. Until the first read lands, the fork defaults apply, as in
 *  main (T-042): the first wake after a start must not run as upstream. */
let levers: CostLevers = COST_LEVERS_ON;
let readAt = 0;
function leversNow(): CostLevers {
  const now = Date.now();
  if (now - readAt > 15_000) {
    readAt = now;
    window.cth.getConfig().then((c) => { levers = resolveCostLevers(c); }).catch(() => { /* keep last */ });
  }
  return levers;
}

const isAgent = (id: string): boolean =>
  id === 'harness' || useStore.getState().agents.some((a) => a.id === id);

/** T-041: in_reply_to id → whether god sent it, resolved over the existing
 *  hive:messages IPC (god's outbox/.sent and inbox). undefined = asked, no
 *  answer yet. Ids are unique and immutable, so answers are kept (bounded). */
const sentByGod = new Map<string, boolean | undefined>();
const CACHE_MAX = 500;

function resolveSentByGod(id: string): boolean | undefined {
  if (sentByGod.has(id)) return sentByGod.get(id);
  const god = useStore.getState().agents.find((a) => a.isGod);
  if (!god || !window.cth.hiveMessages) return false;
  if (sentByGod.size >= CACHE_MAX) sentByGod.delete(sentByGod.keys().next().value as string);
  sentByGod.set(id, undefined);
  window.cth.hiveMessages({ agentId: god.id, id })
    .then((ms) => { sentByGod.set(id, ms.some((v) => v.from === god.id)); })
    .catch(() => { sentByGod.set(id, false); });
  return undefined;
}

/**
 * The fresh mail that should wake this agent. For god with digestWakes on,
 * mechanical mail is marked seen (so it never wakes god on its own) and left in
 * the inbox for god's next real wake. Anyone else, or the lever off: unchanged.
 */
export function wakeWorthy<M extends MailLike>(agent: { isGod?: boolean }, fresh: M[], seen: Set<string>): M[] {
  if (!agent.isGod || !leversNow().digestWakes) return fresh;
  return fresh.filter((m) => {
    // A reply whose target is still being looked up waits one loop tick: not
    // woken, not marked seen, re-checked once the answer is in.
    if (m.in_reply_to && resolveSentByGod(m.in_reply_to) === undefined) return false;
    if (!isMechanicalMail(m, isAgent, (id) => sentByGod.get(id) === true)) return true;
    if (m.id) seen.add(m.id);
    return false;
  });
}

/** The nudge to queue: shorter when shortNudge is on. */
export function nudgeText(ids: string[]): string {
  return leversNow().shortNudge ? shortNudgeText(ids) : inboxNudgeText(ids);
}
