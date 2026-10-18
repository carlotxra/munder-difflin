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
   *  upstream's. Default OFF until the eval shows it wins on two engines. */
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
}

export type OrchestratorLeverKey = keyof OrchestratorLevers;

/** This fork's defaults. */
export const ORCHESTRATOR_LEVERS_ON: OrchestratorLevers = {
  godPromptV2: false,
  spawnOffNotice: true,
  autoMergeWhenGreen: false,
  reviewPolicy: 'nontrivial',
  integrationBranch: ''
};

/** Upstream behaviour: what code sees before the app installs a config source. */
export const ORCHESTRATOR_LEVERS_OFF: OrchestratorLevers = {
  godPromptV2: false,
  spawnOffNotice: false,
  autoMergeWhenGreen: false,
  reviewPolicy: 'nontrivial',
  integrationBranch: ''
};

const REVIEW_POLICIES: readonly ReviewPolicy[] = ['always', 'nontrivial', 'tests-only'];
// A branch name the prompt can quote safely: no spaces, quotes or backticks.
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,100}$/;

/** The levers for a config object: fork defaults, overridden key by key by
 *  `config.orchestrator`. Values of the wrong type are ignored. */
export function resolveOrchestratorLevers(config: unknown): OrchestratorLevers {
  const raw = (config as { orchestrator?: unknown } | null | undefined)?.orchestrator;
  const out: OrchestratorLevers = { ...ORCHESTRATOR_LEVERS_ON };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const k of ['godPromptV2', 'spawnOffNotice', 'autoMergeWhenGreen'] as const) {
    if (typeof r[k] === 'boolean') out[k] = r[k] as boolean;
  }
  if (REVIEW_POLICIES.includes(r.reviewPolicy as ReviewPolicy)) out.reviewPolicy = r.reviewPolicy as ReviewPolicy;
  if (typeof r.integrationBranch === 'string' && (r.integrationBranch === '' || BRANCH_RE.test(r.integrationBranch))) {
    out.integrationBranch = r.integrationBranch;
  }
  return out;
}
