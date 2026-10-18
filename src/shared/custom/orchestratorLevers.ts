/**
 * Orchestrator levers (T-052 onward): fork-only switches for how Michael (god)
 * is instructed. Plan: docs/plans/orchestrator-alignment.md.
 *
 * One config block, `config.orchestrator`, read straight off the config object
 * (unknown keys survive readConfig/writeConfig), so upstream's HarnessConfig is
 * not touched. Same pattern as costLevers.ts: until the app installs a config
 * source, everything reads OFF, so upstream's own tests see upstream behaviour.
 */

export type ReviewPolicy = 'always' | 'nontrivial' | 'tests-only';

export interface OrchestratorLevers {
  /** T-052: god gets the structured prompt (custom/godPrompt.ts) instead of
   *  upstream's. Default ON since the 3-run eval (eval/baselines/2026-10-18-ab-v2-x3.md):
   *  Claude 33/33 on both prompts, Copilot 24/33 → 29/33. False = upstream's prompt. */
  godPromptV2: boolean;
  /** T-052: when orchestrator spawning is off, god's prompt says so plainly
   *  (upstream's text still points at spawning). Fixes eval G4. Default ON. */
  spawnOffNotice: boolean;
  /** T-052 (prompt V2): god may merge a reviewed, green, in-scope change without
   *  asking. Default OFF: every merge needs the human's word. */
  autoMergeWhenGreen: boolean;
  /** T-052 (prompt V2): when a different agent must review a change before it lands. */
  reviewPolicy: ReviewPolicy;
  /** T-052 (prompt V2): the branch work lands on, when every project uses the same
   *  one. '' = each project's own (god asks the human once when unclear). */
  integrationBranch: string;
  /** T-051: engines (provider ids) whose agents get the hive prompt through the
   *  engine's own instructions file in their per-agent home, with only a short
   *  kick as the first message. Applies to every agent, not only god. Default:
   *  the engines checked on this machine (copilot, opencode). [] = upstream. */
  nativeInstructions: string[];
}

export type OrchestratorLeverKey = keyof OrchestratorLevers;

/** This fork's defaults. */
export const ORCHESTRATOR_LEVERS_ON: OrchestratorLevers = {
  godPromptV2: true,
  spawnOffNotice: true,
  autoMergeWhenGreen: false,
  reviewPolicy: 'nontrivial',
  integrationBranch: '',
  nativeInstructions: ['copilot', 'opencode']
};

/** Upstream behaviour: what code sees before the app installs a config source. */
export const ORCHESTRATOR_LEVERS_OFF: OrchestratorLevers = {
  godPromptV2: false,
  spawnOffNotice: false,
  autoMergeWhenGreen: false,
  reviewPolicy: 'nontrivial',
  integrationBranch: '',
  nativeInstructions: []
};

const REVIEW_POLICIES: readonly ReviewPolicy[] = ['always', 'nontrivial', 'tests-only'];
// A branch name the prompt can quote safely: no spaces, quotes or backticks.
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,100}$/;

/** The levers for a config object: fork defaults, overridden key by key by
 *  `config.orchestrator`. Values of the wrong type are ignored. */
export function resolveOrchestratorLevers(config: unknown): OrchestratorLevers {
  const raw = (config as { orchestrator?: unknown } | null | undefined)?.orchestrator;
  const out: OrchestratorLevers = { ...ORCHESTRATOR_LEVERS_ON, nativeInstructions: [...ORCHESTRATOR_LEVERS_ON.nativeInstructions] };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const k of ['godPromptV2', 'spawnOffNotice', 'autoMergeWhenGreen'] as const) {
    if (typeof r[k] === 'boolean') out[k] = r[k] as boolean;
  }
  if (REVIEW_POLICIES.includes(r.reviewPolicy as ReviewPolicy)) out.reviewPolicy = r.reviewPolicy as ReviewPolicy;
  if (typeof r.integrationBranch === 'string' && (r.integrationBranch === '' || BRANCH_RE.test(r.integrationBranch))) {
    out.integrationBranch = r.integrationBranch;
  }
  if (Array.isArray(r.nativeInstructions)) {
    out.nativeInstructions = r.nativeInstructions.filter((x): x is string => typeof x === 'string' && /^[a-z][a-z0-9-]{0,30}$/.test(x));
  }
  return out;
}
