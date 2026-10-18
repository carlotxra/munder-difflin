# `hive` command line off vs on, 2026-10-18 (T-054)

`npm run eval -- --build t054-hive-cli --only S8,G1,G2,G3,G4,G5,G6,G7,G9,G10,G11,G12 --runs 2 --matrix <claude/copilot × hiveCli false/true> --max-usd 20 --accept-uncapped`

- Ref `t054-hive-cli`, `--perm safe`, cost levers on, orchestrator fork defaults (prompt V2,
  native instructions, spawn-off notice), plus `hiveCli` per arm.
- Claude: CLI default model, **$15.31** total. Copilot: CLI 1.0.98 default (`gpt-6-luna`).

| Arm | Pass | Sum of median tokens (12 fixtures) | Sum of median calls | $ |
|---|---|---|---|---|
| Claude, CLI off | 24/24 | 2.89M | 84 | 8.03 |
| Claude, CLI on | 24/24 | 3.14M (+8%) | 92 | 7.27 |
| Copilot, CLI off | 23/24 | 3.42M | 84 | n/a |
| Copilot, CLI on | 19/24 | 3.64M | 85 | n/a |

## Claude: the CLI works, with no change in outcomes

- Michael used it in **20 of 24** runs: 35 calls (`roster` 13, `ask` 9, `dispatch` 6, `review` 4,
  `help` 3, `merge` 2, `spawn` 2, `task` 2), and **none was refused** by the CLI's checks.
- Pass rate was already 24/24 without it, so these fixtures can't show a gain for Claude. Tokens
  went up 8% (the Commands section and `roster`/`help` output); dollars came out slightly lower,
  which is within run-to-run noise.

## Copilot: not a valid test of the CLI

**Every** Copilot attempt to run the CLI was refused by the eval's safe-mode permissions
(`Permission denied because no interactive user response was available`). The allow rule names the
command by its absolute path (`shell(<hive>/bin/hive-node <hive>/bin/hive-cli.cjs:*)`), and Copilot
does not match it that way (its docs say rules match on the command "stem"). After a refusal,
Michael sometimes recovered by hand (writing the files) and sometimes left the card unchanged:
G1#1 (card left `todo`), G4#1, G5#1 and G7#1 (no card ask), G11#2 (merged by hand, card not
updated). So the 19/24 measures the eval blocking the commands, not the commands.

The CLI-off Copilot arm (23/24; one G7 run without a card ask) is consistent with earlier runs.

## Conclusion

- **Keep `hiveCli` off by default for now.** On Claude it is used readily and behaves, but these
  fixtures can't show a gain; on Copilot it has not been tested yet.
- **Follow-up check (two single-request Copilot runs):** no `--allow-tool` form approves a command
  started by an absolute path on Copilot CLI 1.0.98. `shell(/abs/nodeA:*)`, `shell(nodeB:*)` and
  `shell(/abs/nodeC /abs/script:*)` were all refused, with and without `--add-dir` for the folder.
  Its rules match command names (`git`, `npm`), and the CLI must be run by absolute path (the
  bundled `hive-node` is not on PATH). This only affects the eval's restricted mode: in the app,
  Copilot agents run with `--allow-all-tools` (the floor's auto mode).
- **So the CLI can be tested on Copilot only with `--perm live`** (the human's opt-in; full
  permissions in a throwaway repo). The eval now refuses a Copilot `hiveCli` arm under
  `--perm safe` with that explanation, instead of silently scoring every call as refused.
  A gain would most likely show there, on Copilot's card asks in G4, G5 and G7.

## Copilot re-run with `--perm live` (the human's opt-in)

`npm run eval -- --build t054-hive-cli --only S8,G1,…,G12 --runs 2 --perm live --matrix <copilot hiveCli false/true> --accept-uncapped`

Full permissions in throwaway repos and hives, as Copilot runs in the app (`--allow-all-tools`).

| Arm | Pass | Sum of median tokens | Sum of median calls |
|---|---|---|---|
| Copilot, CLI off | 23/24 | 3.39M | 82 |
| Copilot, CLI on | 22/24 | 3.57M (+5%) | 86 |

- **Used readily:** in 22 of 24 runs, 57 calls (`roster` 20, `help` 14, `ask` 8, `dispatch` 7, `merge` 2,
  `spawn` 2, `task` 2, `review` 1). The CLI's own checks refused one call, and Michael corrected it.
  `help` is called often (14), which accounts for part of the token increase.
- **Failures, CLI on:** G10#1 stopped after one turn, claiming the worker's message was already
  handled (it was not): a model slip, no CLI call involved. G5#2 decided the provider question
  itself and filed only the account-setup ask with `--no-block`, so the card stayed `doing`.
  That is the option being used for a judgement call, not a CLI fault.
- **Failure, CLI off:** G3#2 wrote an invalid spawn request by hand (missing a required field), the
  kind of mistake the CLI's `spawn` command prevents.

## Overall conclusion (both engines)

- The CLI works on both engines and is used without prompting, but **these fixtures show no pass-rate
  gain** (Claude 24/24 → 24/24, Copilot 23/24 → 22/24, within noise) at **+5–8% tokens**.
- Recommendation: **keep `hiveCli` off by default** and merge it as an option. Its value is
  structural (the merge, review and ask rules become checks in code, not just prompt text), which
  these short one-shot fixtures barely exercise. Revisit with longer sessions or fixtures that
  need many hand-written files.
