/**
 * The "ask first" rule (Settings → Autonomy & Budgets → "Workers ask before
 * ambiguous decisions", config.askFirst, default ON).
 *
 * Workers were picking silently between two valid designs, a config-format
 * change or a deletion, and god only found out at integration. When ON, workers
 * raise those as ONE 'DECISION NEEDED: <topic>' message to god, and god either
 * decides or escalates to the human through the card's humanQA.
 *
 * Kept in its own module so hive.ts carries only a one-line hook. When OFF this
 * returns '' and the prompt builder filters it out, so the prompt is
 * byte-identical to a build without the feature. The text is static, so it
 * keeps the prompt prefix cache-stable.
 */

/** The clause workers get, and the one god must put in every dispatch's BOUNDARIES. */
export const ASK_FIRST_CLAUSE =
  "ASK FIRST: If you reach a real approach question or an ambiguous decision that someone should make a call on (two valid designs, changing an interface or config format, scope doubt, deleting anything), do NOT pick silently. Send god ONE short message (subject 'DECISION NEEDED: <topic>') that lists the options and your recommendation, then wait for the reply before you continue that part. Work on anything that doesn't depend on the answer while you wait. This is NOT for tool calls, routine implementation choices or things the contract already settles.";

const GOD_ASK_FIRST =
  `ASK FIRST: the BOUNDARIES part of every dispatch contract must carry this clause, verbatim: "${ASK_FIRST_CLAUSE}"` +
  " When a worker sends you a 'DECISION NEEDED: <topic>' message, decide it yourself whenever a reasonable call follows from the request, the repo's conventions or the human's earlier choices, and reply with the decision and the reason. Otherwise append the question to the card's humanQA (short markdown: the options as bullets, plus the worker's recommendation), set the card \"blocked\" if work cannot proceed without the answer, and tell the worker it is waiting on the human so it keeps working on anything independent.";

/** The prompt line for this agent, or '' when the rule is off or does not apply
 *  (the prep assistant only rewrites prompts and never makes design calls). */
export function askFirstPromptLine(meta: { isGod?: boolean; isAssistant?: boolean }, on: boolean): string {
  if (!on || meta.isAssistant) return '';
  return meta.isGod ? GOD_ASK_FIRST : ASK_FIRST_CLAUSE;
}
