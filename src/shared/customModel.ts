/**
 * A model id the user types into a picker ("Custom…"), as opposed to one picked
 * from the catalog. It is spliced into the spawn command line as the `--model`
 * value exactly like a catalog id, so it is held to the same contract as a
 * catalog row (src/shared/modelCatalogPayload.ts): single-line, capped, and
 * unchanged by the row sanitiser. Unlike the catalog parser, which quietly
 * cleans a remote row, this REJECTS bad input — the user is right there and can
 * fix what they typed, and silently storing something other than what they
 * typed would be worse than an error.
 */
import { MODEL_ID_MAX, str } from './modelCatalogPayload';

/** How each engine names a model on its command line — drives the input hint. */
export type CustomModelFormat = 'label' | 'slug' | 'cliId';

/** antigravity (agy) echoes back the display label; opencode/crush/pi take a
 *  `provider/model` slug; everything else (claude, copilot, codex, …) takes the
 *  CLI's own model id. */
export function customModelFormat(provider: string): CustomModelFormat {
  if (provider === 'antigravity') return 'label';
  if (provider === 'opencode' || provider === 'crush' || provider === 'pi') return 'slug';
  return 'cliId';
}

export type CustomModelError = 'empty' | 'control' | 'whitespace' | 'quote' | 'dash' | 'tooLong';

export type CustomModelResult =
  | { ok: true; id: string }
  | { ok: false; error: CustomModelError };

/** C0/C1 controls, DEL, and the Unicode line/paragraph separators. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Trim and validate a typed model id for `provider`.
 *
 *  - control characters: an id carrying a newline or NUL is a command-line splice;
 *  - whitespace inside: rejected, except single spaces for a label-format engine
 *    (agy's "Gemini 3.1 Pro (High)"), which buildSpawnCommand quotes;
 *  - quotes: tokenizeCommand treats `"`/`'` as delimiters, so one inside an id
 *    would split or swallow the rest of the command line;
 *  - a leading `-`: the CLI would read the "id" as another flag;
 *  - longer than the catalog's id cap. */
export function validateCustomModelId(raw: string, provider: string): CustomModelResult {
  const id = raw.trim();
  if (!id) return { ok: false, error: 'empty' };
  if (CONTROL.test(id)) return { ok: false, error: 'control' };
  if (customModelFormat(provider) === 'label') {
    if (/[^\S ]| {2}/.test(id)) return { ok: false, error: 'whitespace' };
  } else if (/\s/.test(id)) {
    return { ok: false, error: 'whitespace' };
  }
  if (/["'`]/.test(id)) return { ok: false, error: 'quote' };
  if (id.startsWith('-')) return { ok: false, error: 'dash' };
  if (id.length > MODEL_ID_MAX) return { ok: false, error: 'tooLong' };
  // Whatever got this far must survive the catalog row sanitiser untouched —
  // the same function that guards every remote/override catalog id.
  if (str(id, MODEL_ID_MAX) !== id) return { ok: false, error: 'whitespace' };
  return { ok: true, id };
}

/** The value of the "Custom…" entry in a native <select>. A NUL can never be a
 *  valid model id (validateCustomModelId rejects control characters), so it can
 *  never collide with a real option — whether used raw, or as the model half of
 *  encodeProviderModel(provider, CUSTOM_MODEL_SENTINEL). */
export const CUSTOM_MODEL_SENTINEL = '\u0000custom';

/** Whether `model` is set but not one of `known` — i.e. it has to be shown as a
 *  custom entry for the picker to show the current selection at all. */
export function isCustomModel(known: readonly { id?: string }[], model: string | undefined): model is string {
  return !!model && model !== CUSTOM_MODEL_SENTINEL && !known.some((m) => m.id === model);
}
