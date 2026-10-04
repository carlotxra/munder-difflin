/**
 * One call from index.ts wires every T-034 lever to the live app.
 * Keeping the wiring here keeps the index.ts seam to a single line.
 */
import { setCostLeversSource } from './levers';
import { setSlackProbe } from './promptTrim';
import { setClosingFacts } from './closingTime';

export function installCostLevers(
  readConfig: () => unknown,
  facts: { lastOutputAt: (agentId: string) => number }
): void {
  setCostLeversSource(readConfig);
  setSlackProbe(() => (readConfig() as { slackEnabled?: boolean } | null)?.slackEnabled === true);
  setClosingFacts(facts);
}
