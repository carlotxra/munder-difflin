/**
 * Renderer side of the wake levers (T-034, J1 + F15). See
 * src/shared/custom/wake.ts for the rules.
 *
 * Seams: the inbox-wake loop in hooks/useHive.ts (which messages count as
 * fresh, and the nudge text).
 */
import { useStore } from '@/store/store';
import { inboxNudgeText } from '../../../shared/hiveNudge';
import { resolveCostLevers, COST_LEVERS_OFF, type CostLevers } from '../../../shared/custom/costLevers';
import { isMechanicalMail, shortNudgeText, type MailLike } from '../../../shared/custom/wake';

/** The levers, refreshed from config at most every 15s. The wake loop runs in
 *  a long-lived interval whose closure would otherwise keep the config it
 *  started with. Until the first read lands, levers are off (upstream). */
let levers: CostLevers = COST_LEVERS_OFF;
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

/**
 * The fresh mail that should wake this agent. For god with digestWakes on,
 * mechanical mail is marked seen (so it never wakes god on its own) and left in
 * the inbox for god's next real wake. Anyone else, or the lever off: unchanged.
 */
export function wakeWorthy<M extends MailLike>(agent: { isGod?: boolean }, fresh: M[], seen: Set<string>): M[] {
  if (!agent.isGod || !leversNow().digestWakes) return fresh;
  return fresh.filter((m) => {
    if (!isMechanicalMail(m, isAgent)) return true;
    if (m.id) seen.add(m.id);
    return false;
  });
}

/** The nudge to queue: shorter when shortNudge is on. */
export function nudgeText(ids: string[]): string {
  return leversNow().shortNudge ? shortNudgeText(ids) : inboxNudgeText(ids);
}
