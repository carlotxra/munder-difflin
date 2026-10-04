// Builds the harness's own spawn injection from a source tree, so the eval runs
// the exact prompt, protocol text and hook settings that ref would ship. Nothing
// about the prompt is hard-coded here: it is read from src/ at run time.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const REPO = resolve(new URL('../..', import.meta.url).pathname);

/** Extract `src/` of a git ref (default: the working tree) into `out` and bundle the
 *  prompt builder. Returns the loaded module. */
export function buildHarness({ ref, src, out }) {
  mkdirSync(out, { recursive: true });
  let root = src ? resolve(src) : REPO;
  if (ref) {
    root = join(out, 'src-tree');
    mkdirSync(root, { recursive: true });
    const tar = execFileSync('git', ['-C', REPO, 'archive', ref, 'src'], { maxBuffer: 1 << 28 });
    execFileSync('tar', ['-x', '-C', root], { input: tar });
  }
  const entry = join(out, 'entry.ts');
  writeFileSync(entry, [
    `export { HiveManager } from ${JSON.stringify(join(root, 'src/main/hive'))};`,
    `export { inboxNudgeText } from ${JSON.stringify(join(root, 'src/shared/hiveNudge'))};`,
    `export { ASK_FIRST_CLAUSE } from ${JSON.stringify(join(root, 'src/main/askFirst'))};`
  ].join('\n'));
  const bundle = join(out, 'harness.cjs');
  execFileSync(join(REPO, 'node_modules/.bin/esbuild'),
    [entry, '--bundle', '--platform=node', '--format=cjs', `--outfile=${bundle}`, '--log-level=error']);
  const mod = createRequire(import.meta.url)(bundle);
  mod.srcRoot = root;
  return mod;
}

/** The worker closing-time instruction, read from closingTime.ts (not exported). */
export function closingTimeText(srcRoot) {
  const f = join(srcRoot, 'src/main/closingTime.ts');
  if (!existsSync(f)) throw new Error(`no closingTime.ts under ${srcRoot}`);
  const m = readFileSync(f, 'utf8').match(/'(CLOSING TIME — the office is shutting down[^']*)'/);
  if (!m) throw new Error('closing-time worker text not found in closingTime.ts');
  return m[1];
}

/** Provision a throwaway hive under `home` and return the claude argv + env for each agent. */
export async function provision(mod, home, agents, { askFirst = true, version = 'eval' } = {}) {
  const hive = new mod.HiveManager(() => home);
  hive.setRuntimeInfo?.({ version, packaged: false });
  for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(hive))) {
    if (/^setAskFirst$/i.test(k)) hive[k](askFirst);
  }
  const out = {};
  for (const a of agents) out[a.id] = await hive.ensureAgent({ provider: 'claude', role: '', ...a }, {});
  return { hive, root: join(home, 'hive'), inj: out };
}
