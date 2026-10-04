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
  const from = (p) => JSON.stringify(join(root, p));
  // Fork-only hooks that index.ts wires up in the app. They are optional, so a ref
  // without them (stable) bundles as before: the cost-lever config source
  // (src/main/custom/levers.ts), the lever-aware nudge (custom/wake.ts) and the
  // spawn-path argv trim (sessionLevers.ts).
  const optional = [
    ['src/main/custom/levers.ts', `export { setCostLeversSource, costLevers } from ${from('src/main/custom/levers')};`],
    ['src/main/custom/wake.ts', `export { nudgeText } from ${from('src/main/custom/wake')};`],
    ['src/main/custom/sessionLevers.ts', `export { trimPrefixArgs } from ${from('src/main/custom/sessionLevers')};`]
  ].filter(([f]) => existsSync(join(root, f))).map(([, line]) => line);
  writeFileSync(entry, [
    `export { HiveManager } from ${from('src/main/hive')};`,
    `export { inboxNudgeText } from ${from('src/shared/hiveNudge')};`,
    `export { ASK_FIRST_CLAUSE } from ${from('src/main/askFirst')};`,
    ...optional
  ].join('\n'));
  const bundle = join(out, 'harness.cjs');
  execFileSync(join(REPO, 'node_modules/.bin/esbuild'),
    [entry, '--bundle', '--platform=node', '--format=cjs', `--outfile=${bundle}`, '--log-level=error']);
  const mod = createRequire(import.meta.url)(bundle);
  mod.srcRoot = root;
  // What the ref expects the app to wire up, so leverCheck() can tell a missing
  // hook from a ref that simply has none.
  const idx = existsSync(join(root, 'src/main/index.ts')) ? readFileSync(join(root, 'src/main/index.ts'), 'utf8') : '';
  mod.expects = {
    levers: existsSync(join(root, 'src/shared/custom/costLevers.ts')),
    trimPrefixArgs: /\btrimPrefixArgs\(/.test(idx)
  };
  return mod;
}

/** Fail loudly when a ref has cost levers but the eval would run it with them off,
 *  or when its spawn path uses trimPrefixArgs and the eval cannot apply it.
 *  Returns a one-line summary of the active levers for the table header. */
export function leverCheck(mod, levers) {
  const errs = [];
  if (mod.expects.trimPrefixArgs && !mod.trimPrefixArgs) {
    errs.push('index.ts calls trimPrefixArgs but src/main/custom/sessionLevers.ts is not in this ref (uncommitted?)');
  }
  if (!mod.expects.levers) return { errs, summary: 'none in this ref' };
  if (!mod.costLevers) { errs.push('costLevers.ts exists but src/main/custom/levers.ts exports no costLevers/setCostLeversSource'); return { errs, summary: '?' }; }
  mod.setCostLeversSource(levers === null ? null : () => levers);
  const active = mod.costLevers();
  const on = Object.entries(active).filter(([, v]) => v).map(([k]) => k);
  if (levers !== null && on.length === 0) errs.push('levers requested ON but every lever reads OFF');
  return { errs, summary: on.length ? `ON: ${on.join(', ')}` : 'all OFF' };
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
export async function provision(mod, home, agents, { askFirst = true, version = 'eval', levers = {} } = {}) {
  // Cost levers: `{}` = the fork's defaults (all ON), as the app reads an empty
  // config; null = no source installed, so every lever reads OFF (upstream).
  mod.setCostLeversSource?.(levers === null ? null : () => levers);
  const hive = new mod.HiveManager(() => home);
  hive.setRuntimeInfo?.({ version, packaged: false });
  for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(hive))) {
    if (/^setAskFirst$/i.test(k)) hive[k](askFirst);
  }
  const out = {};
  for (const a of agents) {
    const inj = await hive.ensureAgent({ provider: 'claude', role: '', ...a }, {});
    // Same post-processing index.ts applies to the argv on the fork's spawn path.
    if (mod.trimPrefixArgs) inj.args = await mod.trimPrefixArgs(inj.args);
    out[a.id] = inj;
  }
  return { hive, root: join(home, 'hive'), inj: out };
}
