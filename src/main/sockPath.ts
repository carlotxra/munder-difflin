/**
 * Unix-domain socket path limits for the hook socket (HIVE_SOCK).
 *
 * libuv silently TRUNCATES a socket path longer than sun_path allows, so the
 * file it binds is not the file the caller named. The hook server's stale-file
 * check then looks at one name while listen() binds another (T-028). Every
 * POSIX socket path goes through here so the two always agree.
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';

/** Longest usable Unix-domain socket path in bytes: sun_path is 104 bytes on
 *  macOS/BSD (108 on Linux), less the terminating NUL. Take the smaller one. */
export const SOCK_PATH_MAX = 103;

/** A directory only this user can enter: created 0700, and rejected when it is
 *  a symlink, not a directory, or owned by someone else. The fallback bases
 *  include shared, world-writable ones (/tmp), where another local user could
 *  otherwise squat the socket path and read or answer hook traffic. */
function privateDir(dir: string): boolean {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  try {
    try { mkdirSync(dir, { mode: 0o700 }); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    }
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    if (uid >= 0 && st.uid !== uid) return false;
    if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
    return true;
  } catch {
    return false;
  }
}

/** The bases tried for a short socket path, most private first. */
export function defaultSockDirs(): string[] {
  const dirs = [process.env.XDG_RUNTIME_DIR, tmpdir(), '/tmp'];
  return dirs.filter((d): d is string => typeof d === 'string' && d.length > 0);
}

/** `preferred` when it fits in a socket address, else `hooks-<id>.sock` inside
 *  a private per-user `munder-difflin-<uid>` directory under the first base
 *  that yields a short enough path. Returns `preferred` unchanged when nothing
 *  fits; the hook server then refuses it (ENAMETOOLONG) rather than truncating. */
export function shortSockPath(preferred: string, id: string, dirs: string[] = defaultSockDirs()): string {
  if (Buffer.byteLength(preferred) <= SOCK_PATH_MAX) return preferred;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
  for (const base of dirs) {
    const dir = join(base, `munder-difflin-${uid}`);
    const candidate = join(dir, `hooks-${id}.sock`);
    if (Buffer.byteLength(candidate) > SOCK_PATH_MAX) continue;
    if (privateDir(dir)) return candidate;
  }
  return preferred;
}
