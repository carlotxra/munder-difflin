/**
 * Main-process access to the cost levers (src/shared/custom/costLevers.ts).
 *
 * Until index.ts installs a source, every lever reads OFF, so any code path
 * built without the app (upstream's unit tests, a bare HiveManager) behaves
 * exactly like upstream.
 */
import { COST_LEVERS_OFF, resolveCostLevers, type CostLevers } from '../../shared/custom/costLevers';

let source: (() => unknown) | null = null;

/** Install the config reader (index.ts, once at startup). Tests pass a literal. */
export function setCostLeversSource(read: (() => unknown) | null): void {
  source = read;
}

/** The current levers. Read live, so a Settings change applies on the next use. */
export function costLevers(): CostLevers {
  if (!source) return COST_LEVERS_OFF;
  try { return resolveCostLevers(source()); } catch { return COST_LEVERS_OFF; }
}
