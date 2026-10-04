/**
 * The LIVE ROSTER as a compact table (T-034, F2-F4).
 *
 * god reads the floor on every roster injection, so the row format is worth
 * keeping small: one header naming the columns, then one comma-separated row
 * per agent. That is the tabular form of TOON (Token-Oriented Object Notation,
 * github.com/toon-format/spec). Measured on the live floor it is about 30%
 * smaller than the same rows as compact JSON. Only this read-only, harness-built
 * block uses it; every file an agent WRITES stays JSON.
 *
 * Import-free so hive.ts and the tests share one definition.
 */

/** Quote a cell only when TOON requires it: a delimiter, a quote, a leading or
 *  trailing space, or an empty string would otherwise change the row. */
export function toonCell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '-';
  const s = String(v);
  if (s === '' || /[,"\n\r]/.test(s) || s.trim() !== s) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
  }
  return s;
}

/** `name[N]{f1,f2}:` header plus one indented row per record. */
export function toonTable(name: string, fields: string[], rows: Array<Array<string | number | boolean | null | undefined>>): string {
  const head = `${name}[${rows.length}]{${fields.join(',')}}:`;
  return [head, ...rows.map((r) => `  ${r.map(toonCell).join(',')}`)].join('\n');
}

/** Roles from a hire are often a whole bio ("I work on the X app. Expert senior
 *  engineer…"). The roster only needs enough to route by: the first clause,
 *  capped. */
export const ROLE_MAX = 32;
export function shortRole(role: string | undefined | null): string {
  const r = (role ?? '').trim();
  if (!r) return 'agent';
  const first = r.split(/(?<=[.;])\s|\s[—–-]\s/)[0].replace(/[.;]$/, '').trim() || r;
  return first.length > ROLE_MAX ? `${first.slice(0, ROLE_MAX - 1).trimEnd()}…` : first;
}

/** Breaker levels that mean "nothing to see". The circuit breaker's own healthy
 *  level is 'healthy' (breaker.ts); 'ok' and 'none' are older spellings. */
export function breakerArmed(level: string | undefined | null): boolean {
  return !!level && !['healthy', 'ok', 'none'].includes(level);
}
