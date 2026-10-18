// @ts-nocheck — this function is serialised with toString() and written to
// <hive>/bin/hive-cli.cjs (custom/hiveCli.ts), where it runs under the hive's
// bundled node. It must stay self-contained: no imports, no outer references,
// only its parameters. Plain JS inside; types would not survive the trip.
/**
 * The `hive` command line for god (T-054). Plan: docs/plans/orchestrator-alignment.md, Phase 4.
 *
 * Each command checks its inputs, refuses with a reason (exit 2) rather than
 * guessing, and writes only upstream's own formats (outbox message JSON,
 * tasks.json cards and humanQA, spawn-requests), so the harness reads the
 * result exactly as if god had written the file by hand.
 */
export function hiveCliMain(req, proc, binDir) {
  const fs = req('node:fs');
  const path = req('node:path');
  const cp = req('node:child_process');
  const root = proc.env.HIVE_CLI_ROOT || path.resolve(binDir, '..');
  const out = (s) => proc.stdout.write(s + '\n');
  const refuse = (s) => { proc.stderr.write('hive: refused: ' + s + '\n'); return 2; };

  const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
  const writeJson = (f, v) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.' + proc.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n');
    fs.renameSync(tmp, f);
  };
  const settings = readJson(path.join(binDir, 'hive-cli.json'), {});
  const registry = () => readJson(path.join(root, 'registry.json'), { agents: {} });
  const tasksFile = path.join(root, 'tasks.json');
  const loadTasks = () => { const t = readJson(tasksFile, { tasks: [] }); if (!Array.isArray(t.tasks)) t.tasks = []; return t; };
  const stamp = () => new Date().toISOString();
  const rand = () => Math.random().toString(36).slice(2, 8);

  // argv: <cmd> [sub] --key value ... (a flag with no value is true)
  const argv = proc.argv.slice(2);
  const cmd = argv[0];
  const pos = [];
  const opt = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) opt[k] = true; else { opt[k] = v; i++; }
    } else pos.push(a);
  }
  const need = (...keys) => { const miss = keys.filter((k) => typeof opt[k] !== 'string' || !opt[k].trim()); return miss.length ? 'missing ' + miss.map((k) => '--' + k).join(', ') : null; };

  const reg = registry();
  const godId = reg.godId || settings.godId || 'god';
  const me = proc.env.AGENT_ID || godId;
  const agent = (id) => reg.agents && reg.agents[id];
  const live = (id) => { const a = agent(id); return a && !a.archived && !a.isAssistant; };
  const sendFrom = (msg) => {
    const f = path.join(root, 'agents', me, 'outbox', Date.now() + '-' + rand() + '.json');
    writeJson(f, msg);
    return f;
  };
  const godOnly = () => (me === godId ? null : 'only the orchestrator (' + godId + ') runs this; you are ' + me);
  const findTask = (tasks, id) => tasks.tasks.find((t) => t.id === id);
  const git = (repo, args) => cp.execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const tryGit = (repo, args) => { try { return git(repo, args); } catch { return null; } };

  const USAGE = [
    'hive <command> [options]   (orchestrator tools; each refuses with a reason instead of guessing)',
    '  roster                                   who is on the floor, their state and their cards',
    '  dispatch --to <agent> --task <id> --objective <text> --output <text> --boundaries <text> [--tools <text>] [--title <text>] [--no-code]',
    '  review   --task <id> --to <agent> --branch <name> --sha <sha>',
    '  merge    --task <id> --repo <path> --branch <name> --sha <sha> [--into <branch>] [--reviewed-by <agent>] [--human <the human\'s yes>]',
    '  ask      --task <id> --q <markdown> [--no-block]',
    '  task     add --id <id> --title <text> [--priority low|med|high] | status <id> <todo|doing|blocked|done> | done <id>',
    '  spawn    --objective <text> --cwd <repo> [--name <n>] [--provider <p>] [--model <m>] [--none-fit]'
  ].join('\n');

  if (!cmd || cmd === 'help' || opt.help) { out(USAGE); return 0; }

  if (cmd === 'roster') {
    const fleet = readJson(path.join(root, 'fleet.json'), { agents: [] });
    const rows = Array.isArray(fleet.agents) ? fleet.agents : Object.entries(fleet.agents || {}).map(([id, v]) => ({ id, ...v }));
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    const tasks = loadTasks().tasks;
    out('id | name | role | state | cards');
    for (const [id, a] of Object.entries(reg.agents || {})) {
      if (a.archived || a.isAssistant) continue;
      const f = byId[id] || {};
      const state = [f.breaker && f.breaker !== 'ok' ? 'breaker ' + f.breaker : null,
        typeof f.lastActiveSecAgo === 'number' ? 'active ' + f.lastActiveSecAgo + 's ago' : null,
        f.inboxBacklog ? 'inbox ' + f.inboxBacklog : null].filter(Boolean).join(', ') || '-';
      const cards = tasks.filter((t) => t.assignee === id && t.status !== 'done').map((t) => t.id + ' ' + t.status).join(', ') || '-';
      out([id, a.name || '', a.isGod ? 'orchestrator' : (a.role || ''), state, cards].join(' | '));
    }
    return 0;
  }

  if (cmd === 'dispatch') {
    const r = godOnly() || need('to', 'task', 'objective', 'output', 'boundaries');
    if (r) return refuse(r);
    if (!live(opt.to)) return refuse('no live agent "' + opt.to + '" on the roster (archived, the prep assistant, or unknown); run "roster"');
    if (opt.to === godId) return refuse('dispatch to a worker, not to yourself');
    const tasks = loadTasks();
    let t = findTask(tasks, opt.task);
    if (!t) {
      if (typeof opt.title !== 'string') return refuse('no card ' + opt.task + ' in tasks.json; add --title to create it');
      t = { id: opt.task, title: opt.title, status: 'todo', priority: 'med', assignee: null, deps: [] };
      tasks.tasks.push(t);
    }
    const done = opt['no-code'] ? '' : ' ' + (settings.doneClause || 'Bring your branch up to date with the integration branch, resolve any conflicts, run the tests, and report done with the branch name and tip SHA. Do not merge.');
    const ask = settings.askFirstClause ? ' ' + settings.askFirstClause : '';
    const body = [opt.task + '.', 'OBJECTIVE: ' + opt.objective, 'OUTPUT: ' + opt.output,
      'TOOLS: ' + (typeof opt.tools === 'string' ? opt.tools : 'your choice; read the references named above instead of re-deriving them'),
      'BOUNDARIES: ' + opt.boundaries + done + ask].join('\n');
    const f = sendFrom({ to: opt.to, act: 'request', subject: opt.task + ': ' + (t.title || opt.objective).slice(0, 80), body, requires_reply: true });
    t.status = 'doing';
    t.assignee = opt.to;
    writeJson(tasksFile, tasks);
    out('dispatched ' + opt.task + ' to ' + opt.to + ' (' + (agent(opt.to).name || opt.to) + '); card is doing, assignee ' + opt.to + '; message ' + path.basename(f));
    return 0;
  }

  if (cmd === 'review') {
    const r = godOnly() || need('task', 'to', 'branch', 'sha');
    if (r) return refuse(r);
    const tasks = loadTasks();
    const t = findTask(tasks, opt.task);
    if (!t) return refuse('no card ' + opt.task);
    if (!t.assignee) return refuse(opt.task + ' has no assignee, so there is no author to keep out of the review');
    if (opt.to === t.assignee) return refuse(opt.to + ' wrote ' + opt.task + '; the reviewer must be a different agent');
    if (!live(opt.to) || opt.to === godId) return refuse('no live worker "' + opt.to + '"; run "roster"');
    const body = [opt.task + ' review.', 'OBJECTIVE: review branch ' + opt.branch + ' at ' + opt.sha + ' against the ' + opt.task + ' contract (scope included).',
      'OUTPUT: a message to god with act "agree" if it can land as is, or "refuse" with numbered findings.',
      'TOOLS: read-only; git show / diff / log, and the tests.',
      'BOUNDARIES: do not change the branch or merge anything. Review exactly ' + opt.sha + '.'].join('\n');
    const f = sendFrom({ to: opt.to, act: 'request', subject: opt.task + ': review ' + opt.branch + ' at ' + String(opt.sha).slice(0, 7), body, requires_reply: true });
    t.reviewer = opt.to;
    writeJson(tasksFile, tasks);
    out('review of ' + opt.task + ' (' + opt.branch + ' at ' + opt.sha + ') sent to ' + opt.to + '; message ' + path.basename(f));
    return 0;
  }

  if (cmd === 'merge') {
    const r = godOnly() || need('task', 'repo', 'branch', 'sha');
    if (r) return refuse(r);
    const into = typeof opt.into === 'string' ? opt.into : settings.integrationBranch;
    if (!into) return refuse('which branch does this land on? pass --into <branch> (or set orchestrator.integrationBranch)');
    const tasks = loadTasks();
    const t = findTask(tasks, opt.task);
    if (!t) return refuse('no card ' + opt.task);
    if (!t.assignee) return refuse(opt.task + ' has no assignee; whose work is this?');
    const repo = path.resolve(opt.repo);
    const sha = tryGit(repo, ['rev-parse', '--verify', '-q', opt.sha + '^{commit}']);
    if (!sha) return refuse(opt.sha + ' is not a commit in ' + repo);
    const tip = tryGit(repo, ['rev-parse', '--verify', '-q', 'refs/heads/' + opt.branch]);
    if (!tip) return refuse('no branch ' + opt.branch + ' in ' + repo);
    if (tip !== sha) return refuse(opt.branch + ' has moved since the report (tip ' + tip.slice(0, 7) + ', reported ' + sha.slice(0, 7) + '); send it back to ' + t.assignee + ' for a fresh done report');
    const base = tryGit(repo, ['rev-parse', '--verify', '-q', 'refs/heads/' + into]);
    if (!base) return refuse('no branch ' + into + ' in ' + repo);
    if (base === sha) return refuse(into + ' is already at ' + sha.slice(0, 7));
    try { cp.execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', base, sha], { stdio: 'ignore' }); }
    catch { return refuse(sha.slice(0, 7) + ' cannot fast-forward ' + into + '; send it back to ' + t.assignee + ' to bring the branch up to date and resolve conflicts'); }
    const files = (tryGit(repo, ['diff', '--name-only', base, sha]) || '').split('\n').filter(Boolean);
    const policy = settings.reviewPolicy || 'nontrivial';
    const needsReview = policy === 'always' || (policy === 'nontrivial' && (files.length > 1 || files.some((f) => /(^|\/)(config|schema)|\.(json|ya?ml|toml|proto|graphql)$/i.test(f))));
    if (needsReview) {
      if (typeof opt['reviewed-by'] !== 'string') return refuse('this change (' + files.length + ' files) needs a review by a different agent first (policy ' + policy + '); run "review", then pass --reviewed-by <agent> once they agree');
      if (opt['reviewed-by'] === t.assignee) return refuse('the reviewer must not be the author (' + t.assignee + ')');
      if (t.reviewer && t.reviewer !== opt['reviewed-by']) return refuse(opt.task + ' was sent for review to ' + t.reviewer + ', not ' + opt['reviewed-by']);
    }
    if (!settings.autoMergeWhenGreen && typeof opt.human !== 'string') return refuse('merging needs the human\'s yes for ' + opt.task + ': pass --human "<what they said, or the message id>", or ask on the card first');
    const head = tryGit(repo, ['symbolic-ref', '--short', '-q', 'HEAD']);
    try {
      if (head === into) git(repo, ['merge', '--ff-only', sha]);
      else git(repo, ['fetch', '.', sha + ':' + into]);
    } catch (e) { return refuse('git refused the fast-forward: ' + String(e.stderr || e.message).trim().split('\n')[0]); }
    if (tryGit(repo, ['rev-parse', 'refs/heads/' + into]) !== sha) return refuse(into + ' did not move to ' + sha.slice(0, 7) + '; check the repo');
    t.status = 'done';
    t.merged = { into, sha, at: stamp(), human: typeof opt.human === 'string' ? opt.human : 'auto-merge', reviewedBy: typeof opt['reviewed-by'] === 'string' ? opt['reviewed-by'] : null };
    writeJson(tasksFile, tasks);
    out('merged ' + opt.task + ': ' + into + ' fast-forwarded to ' + sha.slice(0, 7) + ' (' + files.length + ' files); card done, assignee ' + t.assignee + ' kept. Not pushed.');
    return 0;
  }

  if (cmd === 'ask') {
    const r = godOnly() || need('task', 'q');
    if (r) return refuse(r);
    const q = opt.q.replace(/\\n/g, '\n');
    const probs = [];
    if (q.length > 700) probs.push('it is ' + q.length + ' characters; keep it under 700 (cut the narrative, keep the decision)');
    if (!/^\s*\*\*[^*\n]+\*\*/.test(q)) probs.push('open with one **bold** sentence saying what you need');
    if (!/^\s*(-|\*|\d+\.)\s/m.test(q)) probs.push('give each option or step its own "-" or "1." line');
    if (probs.length) return refuse('the ask is not in card shape: ' + probs.join('; '));
    const tasks = loadTasks();
    const t = findTask(tasks, opt.task);
    if (!t) return refuse('no card ' + opt.task);
    if (!Array.isArray(t.humanQA)) t.humanQA = [];
    t.humanQA.push({ q, askedAt: stamp() });
    if (!opt['no-block']) t.status = 'blocked';
    writeJson(tasksFile, tasks);
    out('asked on ' + opt.task + (opt['no-block'] ? '' : '; card blocked until the human answers') + '. It shows on the ASK ME board.');
    return 0;
  }

  if (cmd === 'task') {
    const r = godOnly();
    if (r) return refuse(r);
    const sub = pos[0];
    const tasks = loadTasks();
    if (sub === 'add') {
      const m = need('id', 'title');
      if (m) return refuse(m);
      if (findTask(tasks, opt.id)) return refuse(opt.id + ' already exists');
      tasks.tasks.push({ id: opt.id, title: opt.title, status: 'todo', priority: ['low', 'med', 'high'].includes(opt.priority) ? opt.priority : 'med', assignee: null, deps: [] });
      writeJson(tasksFile, tasks);
      out('added ' + opt.id);
      return 0;
    }
    if (sub === 'status' || sub === 'done') {
      const id = pos[1];
      const status = sub === 'done' ? 'done' : pos[2];
      if (!['todo', 'doing', 'blocked', 'done'].includes(status)) return refuse('status must be todo, doing, blocked or done');
      const t = findTask(tasks, id);
      if (!t) return refuse('no card ' + id);
      t.status = status; // never touches the assignee: a done card still says who did the work
      writeJson(tasksFile, tasks);
      out(id + ' is ' + status + (t.assignee ? ', assignee ' + t.assignee : ''));
      return 0;
    }
    return refuse('task add | status <id> <status> | done <id>');
  }

  if (cmd === 'spawn') {
    const r = godOnly() || need('objective', 'cwd');
    if (r) return refuse(r);
    if (!settings.maySpawn) return refuse('spawning is switched off: spawn requests will not run. Ask the human on the card to hire an agent or switch spawning on');
    const workers = Object.entries(reg.agents || {}).filter(([id, a]) => id !== godId && !a.archived && !a.isAssistant);
    if (workers.length && !opt['none-fit']) {
      return refuse('reuse an existing agent first. On the floor: ' + workers.map(([id, a]) => id + ' (' + (a.role || a.name || '?').slice(0, 40) + ')').join(', ') + '. If none fits, rerun with --none-fit');
    }
    const id = (typeof opt.name === 'string' ? opt.name.toLowerCase().replace(/[^a-z0-9-]/g, '-') : 'w') + '-' + rand();
    const reqBody = { objective: opt.objective, cwd: path.resolve(opt.cwd) };
    for (const k of ['name', 'provider', 'model']) if (typeof opt[k] === 'string') reqBody[k] = opt[k];
    if (opt.isolate === 'false') reqBody.isolate = false;
    writeJson(path.join(root, 'spawn-requests', id + '.json'), reqBody);
    out('spawn request ' + id + ' filed; the harness starts worker-' + id + ' and moves the request to spawn-requests/.done (or .failed with a reason)');
    return 0;
  }

  return refuse('unknown command "' + cmd + '"\n' + USAGE);
}
