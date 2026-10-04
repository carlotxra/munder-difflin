/**
 * Cost levers (T-034/T-035): fork-only switches that cut what the floor spends
 * on instructions and wake-ups without changing what agents do.
 *
 * One config block, `config.costLevers`, read straight off the config object
 * (unknown keys survive readConfig/writeConfig), so upstream's HarnessConfig is
 * not touched. Each lever defaults ON in this fork; set one to false to get
 * upstream's behaviour back exactly, e.g. when an upstream merge changes the
 * same area.
 *
 * Owners: Jim owns this schema (T-034). Jimbo adds his T-035 keys here.
 */

export interface CostLevers {
  /** J1: god is not woken for mechanical mail (ACKs, inform/done that need no
   *  reply, duplicate nudges); it reads them with its next real wake. */
  digestWakes: boolean;
  /** F1: the LIVE ROSTER is injected at session start and when the floor
   *  changes, not on every prompt. */
  rosterOnChange: boolean;
  /** F2-F4: the roster as a compact TOON table with short roles, and only an
   *  armed breaker printed. */
  rosterToon: boolean;
  /** J5+F18: the harness parks strictly idle, clean workers itself and gives
   *  every other worker exactly one closing-time delivery. */
  harnessClosingTime: boolean;
  /** F5, F8-F12, F14: tighter system-prompt wording; Slack lines only when
   *  Slack is on; the LIVE CONTEXT line only for god. */
  promptTrim: boolean;
  /** F15: shorter inbox-wake nudge. */
  shortNudge: boolean;
  /** F17: heartbeat digest without raw log.jsonl lines. */
  slimHeartbeat: boolean;
  /** F13: PROTOCOL.md says god is the sole writer of tasks.json. */
  tasksOwnerProtocol: boolean;
  /** J4 (T-035): hive Claude agents start with a trimmed static prefix:
   *  `--strict-mcp-config` and unused plugins off (shared/custom/leanContext.ts). */
  trimPrefix: boolean;
  /** J2 (T-035): on restart, start fresh with an inbox handoff instead of
   *  resuming a big session or one on another model (shared/custom/resumePolicy.ts). */
  freshStartOnResume: boolean;
}

export type CostLeverKey = keyof CostLevers;

/** This fork's defaults: everything on. */
export const COST_LEVERS_ON: CostLevers = {
  digestWakes: true,
  rosterOnChange: true,
  rosterToon: true,
  harnessClosingTime: true,
  promptTrim: true,
  shortNudge: true,
  slimHeartbeat: true,
  tasksOwnerProtocol: true,
  trimPrefix: true,
  freshStartOnResume: true
};

/** Upstream behaviour: everything off. What code sees before the app has
 *  installed a config source, so upstream's own unit tests run unchanged. */
export const COST_LEVERS_OFF: CostLevers = Object.fromEntries(
  Object.keys(COST_LEVERS_ON).map((k) => [k, false])
) as unknown as CostLevers;

/** The levers for a config object: fork defaults, overridden key by key by
 *  `config.costLevers`. Anything that is not a boolean is ignored. */
export function resolveCostLevers(config: unknown): CostLevers {
  const raw = (config as { costLevers?: unknown } | null | undefined)?.costLevers;
  const out: CostLevers = { ...COST_LEVERS_ON };
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(out) as CostLeverKey[]) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === 'boolean') out[k] = v;
    }
  }
  return out;
}
