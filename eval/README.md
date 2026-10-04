# Hive protocol eval (T-036)

Eight fixtures (S1–S8, from T-033 §4) run headless against a throwaway hive and
are scored with file-system and git checks. It reports pass rate, tokens and $
per fixture, so a prompt or hook change can be A/B tested against `stable`.

```sh
npm run eval -- --ref stable --runs 1            # smoke: 8 runs
npm run eval -- --ref stable --runs 3 --budget 15
npm run eval -- --ref jim-prompt-cuts --runs 3 --budget 15
npm run eval -- --only S5,S7 --dry-run           # set up + check, no model call
node --test eval/                                # offline test of the checks
```

| Flag | Default | Meaning |
|---|---|---|
| `--ref <git ref>` | working tree | Take `src/` from this ref (`git archive`); an app build is evaluated through the ref it was built from |
| `--src <dir>` | | Or a checkout directory |
| `--runs N` | 1 | Runs per fixture |
| `--only S1,S7` | all | Subset |
| `--model <id>` | CLI default | `--model` for the agent |
| `--budget $` | 8 | Total cap; remaining runs are skipped once reached |
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
   written, then `claude -p "<inbox nudge>" --output-format stream-json
   --permission-mode bypassPermissions <harness args>` runs in the repo. The hook
   socket does not exist, so the hooks run but are no-ops. The live hive is never
   touched.
4. `lib/checks.mjs` asserts the outcome; `lib/usage.mjs` sums tokens per API call
   and takes $ from the CLI's `total_cost_usd`.

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
| S7 | Empty-inbox nudge | no outbox msg, memory unchanged, no commits, ≤3 API calls |
| S8 | God dispatch | one msg to `w1` carrying the ASK FIRST clause verbatim and the 4-part contract; `T-906` is `doing`, assignee `w1` |

Add a fixture by dropping `S9.json` into `fixtures/` (`{{ASK_FIRST_CLAUSE}}`,
`{{CLOSING_TEXT}}` and `{{REPO}}` are substituted at run time) and, if needed, a
check in `CHECKS`.
