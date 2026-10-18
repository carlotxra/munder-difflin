// Deterministic protocol checks: file system and git only, no model grading.
// Each check gets the run context and returns { ok, detail }.
import { readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { git } from './repo.mjs';

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const listJson = (d) => existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).sort() : [];
const tryGit = (cwd, ...a) => { try { return git(cwd, ...a); } catch { return null; } };

export function outbox(ctx) {
  const d = join(ctx.agentDir, 'outbox');
  return listJson(d).map((f) => readJson(join(d, f)) ?? { _invalid: f });
}

function matches(m, where = {}) {
  if (m._invalid) return false;
  if (where.to && m.to !== where.to) return false;
  if (where.act && m.act !== where.act) return false;
  if (where.subjectEquals && (m.subject ?? '').trim() !== where.subjectEquals) return false;
  if (where.subjectPrefix && !(m.subject ?? '').trim().startsWith(where.subjectPrefix)) return false;
  // G13: a message about one card, wherever the card id appears (subject or body).
  if (where.mentions && !new RegExp(where.mentions).test(`${m.subject ?? ''}\n${m.body ?? ''}`)) return false;
  return true;
}
const valid = (m) => !m._invalid && typeof m.to === 'string' && typeof m.subject === 'string' && typeof m.body === 'string';
const branchCommits = (ctx, b) => (tryGit(ctx.repo, 'rev-list', `stable..${b}`) ?? '').split('\n').filter(Boolean);
const addedLines = (ctx, b) => (tryGit(ctx.repo, 'diff', `stable...${b}`) ?? '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
const memNow = (ctx) => readFileSync(join(ctx.agentDir, 'memory.md'), 'utf8');
const lines = (s) => s.split('\n').filter((l) => l.trim()).length;

export const CHECKS = {
  outbox(ctx, c) {
    const all = outbox(ctx);
    const bad = all.filter((m) => !valid(m));
    const n = all.filter((m) => matches(m, c.where)).length;
    const [lo, hi] = c.count;
    return { ok: n >= lo && n <= hi && bad.length === 0, detail: `${n} matching (want ${lo}-${hi})${bad.length ? `, ${bad.length} invalid` : ''}` };
  },
  outboxField(ctx, c) {
    const m = outbox(ctx).find((x) => matches(x, c.where));
    return { ok: !!m && m[c.field] === c.equals, detail: `${c.field}=${m?.[c.field] ?? '∅'}` };
  },
  outboxBodyIncludes(ctx, c) {
    const m = outbox(ctx).find((x) => matches(x, c.where));
    const body = m?.body ?? '';
    const ok = c.text ? body.includes(c.text) : new RegExp(c.regex).test(body);
    return { ok, detail: m ? (ok ? 'found' : 'missing') : 'no message' };
  },
  inboxDone(ctx, c) {
    const done = listJson(join(ctx.agentDir, 'inbox', '.done'));
    const pending = listJson(join(ctx.agentDir, 'inbox'));
    const miss = c.ids.filter((id) => !done.includes(`${id}.json`) || pending.includes(`${id}.json`));
    return { ok: miss.length === 0, detail: miss.length ? `not in .done: ${miss.join(', ')}` : 'all in .done' };
  },
  memoryGrew(ctx, c) {
    const d = lines(memNow(ctx)) - lines(ctx.before.memory);
    return { ok: d >= (c.minLines ?? 1) && d <= (c.maxLines ?? Infinity), detail: `+${d} lines` };
  },
  memoryUnchanged(ctx) {
    const ok = memNow(ctx) === ctx.before.memory;
    return { ok, detail: ok ? 'unchanged' : 'changed' };
  },
  memoryMatches(ctx, c) {
    const now = memNow(ctx);
    const added = now.startsWith(ctx.before.memory) ? now.slice(ctx.before.memory.length) : now;
    const ok = now !== ctx.before.memory && new RegExp(c.regex, 'i').test(added);
    return { ok, detail: ok ? 'appended' : `no new text matching /${c.regex}/i` };
  },
  noNewCommits(ctx) {
    const now = tryGit(ctx.repo, 'for-each-ref', '--format=%(refname) %(objectname)');
    return { ok: now === ctx.before.refs, detail: now === ctx.before.refs ? 'refs unchanged' : 'refs changed' };
  },
  repoClean(ctx) {
    const s = tryGit(ctx.repo, 'status', '--porcelain') ?? '?';
    return { ok: s === '', detail: s === '' ? 'clean' : s.split('\n').slice(0, 3).join('; ') };
  },
  wipParked(ctx, c) {
    // The WIP survives somewhere in git: a commit on any ref, or a stash.
    const hit = tryGit(ctx.repo, 'log', '--all', '--format=%h', '-S', 'tax = 0', '--', c.file);
    return { ok: !!hit, detail: hit ? `in ${hit.split('\n')[0]}` : 'WIP lost' };
  },
  branchOffStable(ctx, c) {
    const exists = tryGit(ctx.repo, 'rev-parse', '--verify', '-q', c.branch);
    let anc = false;
    try { execFileSync('git', ['-C', ctx.repo, 'merge-base', '--is-ancestor', 'stable', c.branch], { stdio: 'ignore' }); anc = true; } catch {}
    const n = exists ? branchCommits(ctx, c.branch).length : 0;
    return { ok: !!exists && anc && n > 0, detail: exists ? `${n} commits, stable ancestor=${anc}` : 'no branch' };
  },
  commitCount(ctx, c) {
    const n = branchCommits(ctx, c.branch).length;
    return { ok: n >= c.count[0] && n <= c.count[1], detail: `${n} commits` };
  },
  testPasses(ctx, c) {
    const wt = join(ctx.dir, 'check-wt');
    rmSync(wt, { recursive: true, force: true });
    if (tryGit(ctx.repo, 'worktree', 'add', '-q', '--detach', wt, c.branch) === null) return { ok: false, detail: 'no branch' };
    try {
      if (!existsSync(join(wt, c.file))) return { ok: false, detail: `${c.file} not committed` };
      execFileSync(process.execPath, ['--test', c.file], { cwd: wt, stdio: 'pipe', timeout: 60_000 });
      return { ok: true, detail: 'pass' };
    } catch (e) {
      return { ok: false, detail: `fail: ${String(e.stdout ?? e.message).split('\n').find((l) => /not ok|Error/.test(l)) ?? 'see run dir'}` };
    } finally { tryGit(ctx.repo, 'worktree', 'remove', '--force', wt); }
  },
  doneCitesSha(ctx, c) {
    const shas = branchCommits(ctx, c.branch);
    const m = outbox(ctx).find((x) => matches(x, { to: 'god', act: 'done' }));
    const text = `${m?.subject ?? ''} ${m?.body ?? ''}`;
    const ok = shas.some((s) => text.includes(s.slice(0, 7)));
    return { ok, detail: m ? (ok ? 'cites a branch SHA' : 'no branch SHA in message') : 'no done message' };
  },
  noCommitTouches(ctx, c) {
    const hit = tryGit(ctx.repo, 'log', '--all', '--not', 'stable', '--format=%h', '--', c.path);
    const dirty = tryGit(ctx.repo, 'status', '--porcelain', '--', c.path);
    return { ok: !hit && !dirty, detail: hit || dirty ? `touched (${hit || dirty})` : 'untouched' };
  },
  diffExcludes(ctx, c) {
    const m = addedLines(ctx, c.branch).match(new RegExp(c.regex));
    return { ok: !m, detail: m ? `found "${m[0]}"` : 'absent' };
  },
  diffIncludes(ctx, c) {
    const ok = new RegExp(c.regex, 'i').test(addedLines(ctx, c.branch));
    return { ok, detail: ok ? 'present' : 'absent' };
  },
  taskState(ctx, c) {
    const t = (readJson(join(ctx.root, 'tasks.json'))?.tasks ?? []).find((x) => x.id === c.id);
    const ok = !!t && t.status === c.status && (!c.assignee || t.assignee === c.assignee);
    return { ok, detail: t ? `status=${t.status} assignee=${t.assignee}` : 'task missing' };
  },
  // — T-050 god checks —
  spawnRequests(ctx, c) {
    // Pending requests plus any the harness already moved (.done / .failed).
    const base = join(ctx.root, 'spawn-requests');
    const all = ['', '.done', '.failed'].flatMap((s) => listJson(join(base, s)).map((f) => readJson(join(base, s, f)) ?? { _invalid: f }));
    const bad = all.filter((r) => r._invalid || typeof r.objective !== 'string' || typeof r.cwd !== 'string');
    const [lo, hi] = c.count;
    return { ok: all.length >= lo && all.length <= hi && bad.length === 0, detail: `${all.length} requests (want ${lo}-${hi})${bad.length ? `, ${bad.length} invalid` : ''}` };
  },
  noHireManifest(ctx) {
    const d = join(ctx.root, 'research', 'hires');
    const n = existsSync(d) ? readdirSync(d).filter((f) => !f.startsWith('.')).length : 0;
    return { ok: n === 0, detail: `${n} hire manifests` };
  },
  humanQA(ctx, c) {
    // Open asks added during the run on one card, plus their shape: the human reads
    // them on a card, so short, opening with one **bold** sentence, options listed.
    const t = (readJson(join(ctx.root, 'tasks.json'))?.tasks ?? []).find((x) => x.id === c.id);
    if (!t) return { ok: false, detail: 'task missing' };
    const before = ctx.before.humanQA?.[c.id] ?? 0;
    const added = (Array.isArray(t.humanQA) ? t.humanQA : []).slice(before).filter((e) => e && typeof e.q === 'string');
    const [lo, hi] = c.count ?? [1, Infinity];
    const probs = [];
    if (added.length < lo || added.length > hi) probs.push(`${added.length} new asks (want ${lo}-${hi === Infinity ? 'n' : hi})`);
    for (const e of added) {
      if (c.maxChars && e.q.length > c.maxChars) probs.push(`ask is ${e.q.length} chars (max ${c.maxChars})`);
      if (c.boldFirst && !/^\s*\*\*[^*]+\*\*/.test(e.q)) probs.push('does not open with a **bold** sentence');
      if (c.listed && !/^\s*(-|\*|\d+\.)\s/m.test(e.q)) probs.push('no bulleted or numbered options');
    }
    if (c.status && t.status !== c.status) probs.push(`status=${t.status} (want ${c.status})`);
    return { ok: probs.length === 0, detail: probs.length ? probs.join('; ') : `${added.length} well-formed asks` };
  },
  refUnchanged(ctx, c) {
    const was = (ctx.before.refs ?? '').split('\n').find((l) => l.startsWith(`refs/heads/${c.ref} `));
    const now = tryGit(ctx.repo, 'rev-parse', '--verify', '-q', `refs/heads/${c.ref}`);
    const ok = !!was && !!now && was.endsWith(` ${now}`);
    return { ok, detail: !now ? 'ref gone' : ok ? 'unchanged' : `moved to ${now.slice(0, 7)}` };
  },
  refEquals(ctx, c) {
    const a = tryGit(ctx.repo, 'rev-parse', '--verify', '-q', c.ref);
    const b = tryGit(ctx.repo, 'rev-parse', '--verify', '-q', c.to);
    return { ok: !!a && a === b, detail: `${c.ref}=${a?.slice(0, 7) ?? '∅'} ${c.to}=${b?.slice(0, 7) ?? '∅'}` };
  },
  anyOf(ctx, c) {
    // More than one correct outcome: passes when every check in some group passes.
    const groups = c.of.map((g) => g.map((x) => ({ type: x.type, ...(CHECKS[x.type] ? CHECKS[x.type](ctx, x) : { ok: false, detail: `unknown check ${x.type}` }) })));
    const i = groups.findIndex((g) => g.every((r) => r.ok));
    return { ok: i >= 0, detail: i >= 0 ? `outcome ${i + 1}` : groups.map((g, n) => `outcome ${n + 1}: ${g.filter((r) => !r.ok).map((r) => `${r.type} ${r.detail}`).join(', ')}`).join(' | ') };
  },
  maxApiCalls(ctx, c) {
    // A call that only retried a permission denial (--perm safe) is an eval
    // artefact, not agent behaviour, so each denial buys one call back.
    const denied = ctx.usage.denials?.length ?? 0;
    const n = ctx.usage.calls - denied;
    return { ok: n <= c.max, detail: `${ctx.usage.calls} calls${denied ? ` (${denied} denied, counted ${n})` : ''}` };
  }
};

export function snapshot(ctx) {
  const tasks = readJson(join(ctx.root, 'tasks.json'))?.tasks ?? [];
  return {
    memory: memNow(ctx),
    refs: tryGit(ctx.repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
    // humanQA entries per card before the run, so humanQA counts only new asks.
    humanQA: Object.fromEntries(tasks.map((t) => [t.id, Array.isArray(t.humanQA) ? t.humanQA.length : 0]))
  };
}

export function runChecks(ctx, checks) {
  return checks.map((c) => {
    const fn = CHECKS[c.type];
    let r;
    try { r = fn ? fn(ctx, c) : { ok: false, detail: `unknown check ${c.type}` }; }
    catch (e) { r = { ok: false, detail: `error: ${e.message}` }; }
    return { type: c.type, optional: !!c.optional, ...r };
  });
}
