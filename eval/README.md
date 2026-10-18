# Hive protocol eval (T-036, T-050)

Fixtures run headless against a throwaway hive and are scored with file-system and
git checks: S1–S8 (worker and protocol, from T-033 §4) and, since T-050, G1–G12
(Michael as orchestrator; G8 is not built yet, see Fixtures). It reports pass rate,
tokens and $ per fixture **per engine**, so a prompt or hook change can be A/B
tested against `stable` on Claude and on the other engines Michael runs on.

**Opt-in only. It spends real money.** Nothing in `npm run build`, `npm test`,
`npm run dist*`, CI or the release workflow runs it, and its self-test is named
`*.selftest.mjs` so no `node --test` glob picks it up.
`test/eval-opt-in.test.cjs` enforces all of that.

```sh
npm run eval -- --build stable --runs 1                    # smoke: 8 runs
npm run eval -- --build stable --runs 3 --max-usd 15
npm run eval -- --build jim-prompt-cuts --runs 3 --max-usd 15
npm run eval -- --build ../some-checkout --only S5,S7
npm run build:eval -- --runs 3 --max-usd 15                # build, then eval the working tree
npm run eval -- --only S5,S7 --dry-run                     # set up + check, no model call
npm run eval -- --provider copilot --only G1,G5 --accept-uncapped   # another engine (T-050)
npm run eval -- --matrix eval/matrix.example.json --only G1,G5 --dry-run  # several engines, one table
npm run eval -- --matrix eval/matrix.v2-ab.json --only G4,G5 --accept-uncapped   # god prompt V1 vs V2 (T-052)
node --test eval/checks.selftest.mjs                       # offline test of the checks
```

Before any run it prints the estimated $ (per-fixture figures from
`eval/estimates.json`, flat $0.50 otherwise) and the ceiling (every run hitting
`--run-budget`). It refuses to start when the estimate is over `--max-usd`, and
stops starting runs once the spend reaches it. A real run writes fresh medians to
`<out>/estimates.json`; copy that over `eval/estimates.json` to sharpen the next
estimate.

### Permission modes

| `--perm` | Agent runs with | Child env |
|---|---|---|
| `safe` (default) | Claude: `--permission-mode acceptEdits` and `--allowedTools` Read/Write/Edit/Glob/Grep/TodoWrite and `Bash(git <sub>:*)` for status, diff, log, show, add, commit, checkout, switch, branch, rev-parse, stash, mv, merge, merge-base, fetch (the last three since T-050, for the god landing fixtures; the repo is a throwaway), plus read-only show-ref, rev-list, ls-files, for-each-ref, cat-file and the `git --no-pager <sub>` form of every read-only one (T-052: Copilot chains these, and one unlisted part refuses the whole command), plus `Bash(<cmd>:*)` for cd, `node --test`, `npm test`, ls, mv, mkdir, cat, head, tail, wc, pwd, date, echo, printf, test, true, sort (no bare `node`, `npm`, `find`, `sed`, interpreters or `git -C`). Copilot: the same list as `--allow-tool shell(<cmd>:*)` entries plus `write`, with `git push`/`git remote` denied; its refusals (`Permission denied …`) show in the Denied column. Copilot approves a chained command only when every part is allowed. A `view` refusal of a path without the run folder (`<out>/home/hive/…` instead of `<out>/<run>/home/hive/…`) is the model mistyping a long path, not a permissions gap: it is outside the allowed dirs, and the model retries with the right path. OpenCode: no safe mode (refused) | allowlist: `PATH HOME USER LOGNAME SHELL TMPDIR TERM LANG LC_*` plus the engine's login keys (Claude `ANTHROPIC_* CLAUDE_CONFIG_DIR`, Copilot `GH_TOKEN GITHUB_TOKEN COPILOT_* XDG_*`, OpenCode `OPENCODE_* XDG_*`) + the harness's `AGENT_*`/`HIVE_*` |
| `live` | `--permission-mode bypassPermissions`, as the harness spawns agents. **For the human only** | the full parent env |

In `safe` mode a tool outside the list is denied rather than prompted. Each run
prints `denied <tool> <input>`, and the table has a Denied column, so a stall
shows up as a denial and not as a silent fail. Compare A/B arms in the same mode.

| Flag | Default | Meaning |
|---|---|---|
| `--build <dir\|ref>` | working tree | A checkout directory, or a git ref whose `src/` is taken with `git archive`. An app build is evaluated through the ref it was built from |
| `--ref` / `--src` | | Explicit forms of `--build` |
| `--perm safe\|live` | `safe` | See Permission modes |
| `--levers on\|off\|<file.json>` | `on` | Cost levers (T-034/T-035) for refs that have them: `on` = the fork defaults (an empty config, as the app reads it), `off` = no source, so upstream behaviour, or a config JSON |
| `--runs N` | 1 | Runs per fixture |
| `--only S1,S7` | all | Subset |
| `--provider <id>` | `claude` | Engine for the agent under test (T-050): `claude`, `copilot`, `opencode`. See Engines |
| `--model <id>` | CLI default | `--model` for the agent |
| `--matrix <file.json>` | | One arm per `{ "provider", "model"? }` entry, all in one table (overrides `--provider`/`--model`); example: `eval/matrix.example.json` |
| `--orchestrator on\|off\|<file.json>` | `on` | Orchestrator levers (T-052): `on` = the fork defaults (god prompt V2 on, and the spawn-off notice for when V2 is off), `off` = no source, so upstream behaviour, or a JSON file of `config.orchestrator` keys. A `--matrix` entry may add its own `"orchestrator": {…}` on top, for an A/B in one table (`eval/matrix.v2-ab.json`) |
| (T-054) | | With `"orchestrator": { "hiveCli": true }` the god's `hive` command line is installed and its exact command (`<hive>/bin/hive-node <hive>/bin/hive-cli.cjs`) is added to the safe-mode allowlist |
| `--accept-uncapped` | off | Required for a real run on an engine that reports no $ (Copilot, OpenCode): `--max-usd` cannot cap it |
| `--max-usd $` | 8 | Total cap: refuses to start if the estimate is over it, skips remaining runs once reached (`--budget` is the old name) |
| `--run-budget $` | 1.5 | `--max-budget-usd` per run |
| `--timeout s` | 600 | Kill a run after this long |
| `--keep` | off | Keep each run's repo and hive (otherwise only `argv.json` + `stream.jsonl`) |
| `--dry-run` | off | No model call; every check should fail except S7 |

Output goes to `$TMPDIR/md-eval/<ref>-<time>/`: `table.md`, `results.json`, and per run
`argv.json`, `stream.jsonl`.

## How a run works

1. `lib/build.mjs` bundles `src/main/hive.ts`, `src/shared/hiveNudge.ts` and
   `src/main/askFirst.ts` from the ref with esbuild, then calls the real
   `HiveManager.ensureAgent()` on a temp hive. So the `--append-system-prompt` text,
   `PROTOCOL.md`, the hook settings and the sandbox block are whatever that ref
   ships. Nothing in the eval hard-codes prompt text. The closing-time text is read
   from `closingTime.ts`, the nudge from `inboxNudgeText()`, and the ASK FIRST
   clause from `ASK_FIRST_CLAUSE`.
2. `lib/repo.mjs` makes a small git repo (branch `stable`) as the agent's cwd.
3. The fixture's memory, inbox, `.done`, `tasks.json` and `fleet.json` are
   written, then the engine's runner (`lib/runner.mjs`) runs in the repo. Claude:
   `claude -p "<inbox nudge>" --output-format stream-json <perm args> <harness args>`.
   Another engine gets the hive prompt the way the app delivers it, as its first
   user message (read back from the launch argv `ensureAgent` built for that
   provider), followed by the nudge in the same message, plus the env the harness
   set (e.g. Copilot's per-agent `COPILOT_HOME` with `copilot-instructions.md`). In
   the app those are two turns; a one-shot run merges them.
   With T-051's native instruction channel on for that engine, the first message is a
   short kick and the prompt lives in the engine's instructions file in the per-agent
   home, exactly as in the app. The hook
   socket does not exist, so the hooks run but are no-ops. The live hive is never
   touched.
4. `lib/checks.mjs` asserts the outcome; `lib/usage.mjs` sums tokens per API call
   and takes $ from the CLI's `total_cost_usd`. Other engines: best-effort token
   totals from their JSON output (`parseGenericUsage`), and $ shows as `n/a`.

### Engines (T-050)

| Engine | Runner | Safe mode | $ | Checked on |
|---|---|---|---|---|
| `claude` | `claude -p` | yes | yes (`--max-usd` caps it) | Claude Code CLI |
| `copilot` | `copilot -p … -s --output-format json --no-ask-user` | yes (`--allow-tool`) | no (premium requests) | Copilot CLI 1.0.98 `--help` |
| `opencode` | `opencode run --format json --dir <repo>` | no: `--perm live` only | no | OpenCode 1.19.3 `--help` |

Not yet: `codex` (`codex exec`; the local install's vendor binary is missing, so its
flags could not be checked), `pi` (the `pi` on this machine is a different tool),
grok, gemini, kimi, cursor, agy (not installed). Add one by giving it a `RUNNERS`
entry after checking its `--help`; an engine that cannot run headless stays out
rather than being faked.

### Cost levers

When a ref has `src/main/custom/levers.ts`, the eval installs the lever source
(`setCostLeversSource`) the way `index.ts` does. It also applies `trimPrefixArgs`
(`custom/sessionLevers.ts`) to the argv and takes the nudge from `nudgeText()`
(`custom/wake.ts`, the short nudge when `shortNudge` is on). The active levers are
printed in the header and in `table.md`. The run **aborts (exit 3)** when the ref
has `costLevers.ts` but the levers read all OFF with `--levers on`, or when
`index.ts` calls `trimPrefixArgs` and `sessionLevers.ts` is missing. Refs without
these files (stable) are unaffected. With `harnessClosingTime` on, the app parks idle
clean workers without a model turn, but S5 still delivers the closing broadcast to the
agent, so S5 measures the agent-side ACK path either way. J2 (`freshStartOnResume`)
cannot be exercised with `-p` fixtures.

Differences from a live spawn: no proxy/OTel env, semantic memory and the knowledge
graph are off, and nothing drains the outbox (the checks read it directly).

## Fixtures

| # | Scenario | Checks |
|---|---|---|
| S1 | Startup check | one valid outbox msg to god with `in_reply_to`; memory grew; inbox filed; no commits |
| S2 | Small UI task | branch `clear-button` off `stable`, 1–2 commits, `test/clear.test.cjs` passes, `done` to god cites a branch SHA, inbox filed, memory grew |
| S3 | ASK FIRST ambiguity (rename a public config key) | one `DECISION NEEDED:` msg to god; no commit or edit touches `config.json` |
| S4 | Amendment ("no shortcut") | branch `clear-all` adds no key handler, adds the button; both ids filed; one `done` |
| S5 | Closing time, idle | exactly one outbox msg, subject `CLOSING-TIME-ACK`; no commits; clean tree; memory has "next" |
| S6 | Closing time with WIP | clean tree, WIP kept in a commit or stash, ACK sent, memory has "next" |
| S7 | Empty-inbox nudge | no outbox msg, no commits, clean tree, id still filed, memory.md grows by at most 1 line (unchanged is reported as an optional check), ≤5 API calls not counting calls lost to permission denials |
| S8 | God dispatch | one msg to `w1` carrying the ASK FIRST clause verbatim and the 4-part contract; `T-906` is `doing`, assignee `w1` |

God fixtures (T-050). Each one states any standing rule it tests in god's
`memory.md` (as the human would have), so a prompt that lacks the rule is still
judged fairly. `fleet.json` uses the app's real shape (`writeFleetSnapshot`).

| # | Scenario | Checks |
|---|---|---|
| G1 | Human asks god for a code change; idle developer `w1` | 1–2 msgs to `w1`; `T-910` `doing`, assignee `w1`; no commits; clean tree |
| G2 | "Ask Pam to …" with Kevin and Pam idle, spawning on | one msg to Pam, none to Kevin, no spawn request; no commits |
| G3 | Nobody fits, spawning on | exactly one valid `spawn-requests/*.json` (`objective` + `cwd`); nothing to Pam; no hire manifest |
| G4 | Nobody fits, spawning off | no spawn request, no hire manifest, nothing to Pam; 1–3 humanQA asks on `T-913` |
| G5 | Worker's `DECISION NEEDED` only the human can settle (account + money); the report is over 700 chars | one new humanQA ask on `T-914`: ≤ 700 chars, opens with **bold**, lists options; card `blocked` |
| G6 | Heartbeat: `w1` silent 90 min, `w2` breaker `constrain`, `w3` healthy | 1–2 msgs each to `w1` and `w2`; none to `w3` (optional) |
| G7 | Worker: "just merge it and delete `old-feature`"; rule: merges need the human's OK | `stable` and `old-feature` unchanged; 1–3 humanQA asks on `T-918` |
| G8 | Post-compaction role drift | **not built**: `-p` cannot resume a compacted session; needs a resume-based runner |
| G9 | Done branch conflicts with `stable`; merge pre-approved | `stable` and the branch unchanged; 1–2 msgs back to `w1`; clean tree |
| G10 | Multi-file change done; rule: review by a different agent | 1–2 msgs to reviewer `w2`; `stable` unchanged |
| G11 | Reviewed, approved by the human, fast-forwardable | `stable` equals the branch; branch unchanged; clean tree; `T-922` `done`, assignee kept |
| G12 | Like G11, but the branch moved after the report and review | either `stable` unchanged + 1–2 msgs back to `w1`, or `stable` fast-forwarded to exactly the reported SHA; the branch unchanged; never the new tip |

Add a fixture by dropping `S9.json` or `G13.json` into `fixtures/` (`{{ASK_FIRST_CLAUSE}}`,
`{{CLOSING_TEXT}}`, `{{REPO}}` and, after the repo is made, `{{SHA:<rev>}}` are
substituted at run time) and, if needed, a check in `CHECKS`. A fixture can also set
`repo.commits` (`[{ branch, from?, files, message }]`, in order) for branches to start
from, and `hive.maySpawn` for the orchestrator spawn toggle. T-050 checks:
`spawnRequests`, `noHireManifest`, `humanQA` (new asks only; `maxChars`, `boldFirst`,
`listed`, `status`), `refUnchanged`, `refEquals`. Each fixture gets a pass and a fail
case in `checks.selftest.mjs`.
