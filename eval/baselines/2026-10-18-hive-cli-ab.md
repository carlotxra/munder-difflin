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
- **Next:** make the eval allow the CLI in a form Copilot matches (check the command-stem rule, e.g.
  `shell(hive-node:*)`), then re-run the Copilot arms. A gain would most likely show on engines that
  fumble hand-written JSON (Copilot's card asks in G4, G5 and G7).
