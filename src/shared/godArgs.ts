/** Extra CLI flags for the GOD orchestrator only (config `godArgs`, Settings →
 *  Autonomy & Budgets → "Orchestrator launch flags"). Shared by main (launch)
 *  and renderer (the Settings text field). */

/** Split a shell-style string into argv tokens. Handles single/double quotes and
 *  backslash escapes; no expansion of any kind. Unterminated quotes run to the end. */
export function splitArgString(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { quote = c; has = true; }
    else if (c === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; }
    else if (/\s/.test(c)) { if (has) { out.push(cur); cur = ''; has = false; } }
    else { cur += c; has = true; }
  }
  if (has) out.push(cur);
  return out;
}

/** Render argv back to a string for the Settings field (quotes tokens that need it). */
export function joinArgs(args: readonly string[]): string {
  return args.map((a) => (a === '' || /[\s"'\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)).join(' ');
}

/** Append the user's godArgs to a launch argv — only for the god, never for
 *  other agents. Returns a new array; non-string entries are dropped. */
export function withGodArgs(args: readonly string[], isGod: boolean | undefined, godArgs: unknown): string[] {
  if (!isGod || !Array.isArray(godArgs)) return [...args];
  return [...args, ...godArgs.filter((a): a is string => typeof a === 'string' && a !== '')];
}
