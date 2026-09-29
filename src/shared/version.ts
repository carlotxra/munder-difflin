/**
 * Semver-ish version comparison. Pure and electron-free. `-rc.N` and other
 * suffixes are ignored, so `0.4.7-rc.1` and `0.4.7` compare equal.
 */

/** `1.2.3` / `v1.2.3` -> [1,2,3]; null for anything that isn't semver-ish. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = String(v ?? '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}
