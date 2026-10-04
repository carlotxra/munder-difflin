/**
 * One call from index.ts wires every T-034 lever to the live app.
 * Keeping the wiring here keeps the index.ts seam to a single line.
 */
import { setCostLeversSource } from './levers';
import { setSlackProbe } from './promptTrim';
import { setClosingFacts } from './closingTime';
import { setProviderSource } from './provider';
import type { AgentProvider } from '../../shared/agentProvider';

export function installCostLevers(
  readConfig: () => unknown,
  facts: { lastOutputAt: (agentId: string) => number; providerOf?: (agentId: string) => AgentProvider | null | undefined }
): void {
  setCostLeversSource(readConfig);
  setSlackProbe(() => (readConfig() as { slackEnabled?: boolean } | null)?.slackEnabled === true);
  setClosingFacts(facts);
  if (facts.providerOf) setProviderSource(facts.providerOf);
}
