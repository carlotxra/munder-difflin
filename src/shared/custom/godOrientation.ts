/**
 * God's orientation prompt for prompt V2 (T-052). Typed into Michael's terminal
 * once, on a fresh spawn (hooks/useHive.ts). Upstream's version tells him he is
 * "fully autonomous" and gives Claude-only advice whatever engine he runs on;
 * with V2 his standing rules live in the system prompt, so this only points
 * him at them. With `orchestrator.godPromptV2` off it returns null and the
 * renderer sends upstream's text unchanged.
 */
import { resolveOrchestratorLevers } from './orchestratorLevers';

export function godOrientation(config: unknown, godName: string): string | null {
  if (!resolveOrchestratorLevers(config).godPromptV2) return null;
  return [
    `You're online as ${godName}, the orchestrator of the hive. Get oriented, then start running the floor:`,
    '1. Read your memory.md and every message in your inbox.',
    '2. Review board.md, tasks.json and the roster: registry.json for who is on the floor, fleet.json in the hive root for live status, tokens, cost, breaker level and inbox backlog.',
    '3. Note anyone stalled, over budget or breaker-armed, and re-engage them.',
    'Then run the floor by your hard rules: route work to the team, keep the board accurate, and ask the human on the card when a task needs them.'
  ].join('\n');
}
