# Customizations

A living record of what this fork, `carlotxra/munder-difflin`, changes compared with upstream
`chaitanyagiri/munder-difflin`.

**Intended version label:** `0.5.3-custom`. `package.json` still says `0.4.6`, the same value as
upstream `main`.

## Branch model

| Branch | Role |
|---|---|
| `main` | Mirror of upstream `main`. No fork changes land here. |
| `stable` | Upstream plus our features. Feature branches merge into `stable`, never into `main`. |
| feature branches | Branched from `stable` and merged back into it. |

**Upstream base:** `stable` is built on upstream `main` at `e9793df3` (Merge PR #623). The
latest upstream tag it contains is `v0.5.3` (`c7c8921f`).

**Refreshing this file:** after a merge into `stable`, run the commands below, then update the
table and sections to match.

```sh
git log --oneline main..stable     # fork commits
git diff --stat main..stable       # files touched
```

## Summary

| Customization | What it does | Setting / flag / file | Key files | Commits | Status |
|---|---|---|---|---|---|
| Copilot CLI harness | Runs Copilot CLI as an interactive, hook-bridged hive engine, with slash commands and OTel telemetry | engine `copilot`; config `copilotRequestCap` | `src/main/hive.ts`, `src/shared/agentProvider.ts`, `src/shared/copilotCommands.ts`, `src/main/telemetry.ts`, `src/main/breaker.ts` | `f9f72f58`, `c30439d8`, `65179ecd` (merges `813d41c4`, `aa19f355`) | merged |
| Model catalog | 24-entry bundled Copilot list, upstream remote fetch kept, plus a local override layer | `--model-catalog`, `MUNDER_MODEL_CATALOG`, `MUNDER_MODEL_CATALOG_REMOTE`, `<userData>/model-catalog.override.json` | `src/shared/modelCatalog.json`, `src/main/modelCatalogOverride.ts`, `docs/model-catalog.json` | `a237b387`, `92e96778`, `3180e268`, `7fb1a727`, `416186d7` | merged |
| Custom model entry | A "Custom…" option in every model picker for typing any model id | picker option "Custom…" | `src/shared/customModel.ts`, `src/renderer/src/components/CustomModelEntry.tsx` | `cbdc6d90` | merged |
| Office small talk | Override file for break-spot lines; small talk toggle; innuendo off by default | `<userData>/office-lines.json`; config `officeSmallTalk`, `officeInnuendo` | `src/shared/officeLinesPayload.ts`, `src/renderer/src/scene/office/officeLinesOverride.ts`, `cafeteriaLines.ts` | `123896da` | merged |
| Auto-update off | Auto-update is opt-in; downloads only start automatically when it is on | config `autoUpdate` (default `false`) | `src/main/updater.ts`, `src/main/config.ts`, `UpdatesSection.tsx` | `c314a653`, `17672cce`, `04afd636` | merged |
| Ask-first setting | Ask-first rule in hive prompts, behind a Settings toggle | Settings toggle (TBD) | TBD | none yet | **PENDING** |

## Copilot CLI harness (T-002, T-003)

- **Engine** (`f9f72f58`): Copilot used to be print-mode only (`-p`, PR #101), so it could not
  receive inbox mail or act as Michael. It now runs interactively (`-i`) with
  `--allow-all-tools --no-ask-user` and can receive inbox mail.
  - `hive.installCopilotHooks` gives each agent its own `COPILOT_HOME` containing
    `hooks/munder-hive.json` and `copilot-instructions.md`. It copies `config.json`, links
    `mcp-config.json`, and never writes to `~/.copilot`.
  - `cth-hook --flat` maps the hook output to Copilot's format and turns HALT into a PreToolUse
    deny.
  - `/compact` and `/clear` work as context commands.
- **Slash commands** (`c30439d8`): `src/shared/copilotCommands.ts`, checked against
  `copilot help commands` and `copilot --help` on Copilot CLI 1.0.88.
- **Telemetry** (`65179ecd`): Copilot workers export OTel to the embedded collector, which now
  ingests `/v1/traces`.
  - Chat spans supply tokens, requests (`github.copilot.cost`) and AI credits. Tool spans feed
    the tool waterfall.
  - Copilot has no per-token price, so cost shows as **n/a**, with requests and credits instead.
  - The breaker leaves Copilot out of the $ cap but counts its tokens. A new config-file-only
    cap, `copilotRequestCap`, is unset by default.

## Model catalog (T-004, T-005, T-006)

| Step | Commit | Change |
|---|---|---|
| T-004 | `a237b387` | Removed the remote catalog fetch, so the pickers used the bundled file only |
| T-005 | `92e96778` | Bundled `providers.copilot` now holds the current Copilot model ids (24 rows) |
| T-006 | `3180e268` | Reverted T-004 and restored upstream's fetch, cache, IPC and renderer overlay. The 24 Copilot rows stay |
| T-006 | `7fb1a727` | Re-synced `docs/model-catalog.json` with the bundled catalog (upstream's test requires them to match) |
| T-006 | `416186d7` | Added the local override layer in `src/main/modelCatalogOverride.ts` |

**Precedence** (highest first; merged per provider). Details are in
[`docs/model-catalog-override.md`](docs/model-catalog-override.md).

1. `--model-catalog=<path|https-url>`, or else `MUNDER_MODEL_CATALOG`
2. `<userData>/model-catalog.override.json`
3. the remote catalog (`docs/model-catalog.json` on upstream `main`, cached for 6 h)
4. the bundled `src/shared/modelCatalog.json`

To turn off the remote fetch, set `"remote": false` in either override, or set
`MUNDER_MODEL_CATALOG_REMOTE=0`.

> **Caveat: the remote Copilot list wins over the bundled one.** Upstream `main`'s
> `docs/model-catalog.json` has only 6 Copilot rows, and that list replaces our bundled 24. To
> keep the 24, either repeat `copilot` in an override file or turn off the remote fetch.

## Custom model entry in pickers (T-007)

- `cbdc6d90` adds a "Custom…" entry to each model picker: Add Agent, Edit Agent, the Command
  Center per-agent switch, Michael's engine row, and onboarding.
- Choosing it opens a shared inline field with a per-engine format hint. The id is stored
  verbatim and shown as `<id> (custom)`.
- Validation (`src/shared/customModel.ts`) rejects control characters, spaces inside the id
  (single spaces are allowed for antigravity labels), quotes, a leading `-`, and ids over the
  length cap.
- New strings are added in en, ar and zh-CN.

## Office small talk (T-008)

- `123896da`: `<userData>/office-lines.json` overrides any small-talk pool (coffee, vending,
  snack, table, characters, exchanges, twss, keyed).
  - A list replaces the pool; `{ "mode": "append" }` adds to it instead.
  - Pools the file leaves out keep their built-in lines. An invalid file is ignored.
- New toggles in Settings → General:
  - **Office small talk**: `officeSmallTalk`, default on.
  - **Allow innuendo**: `officeInnuendo`, **default off**. When off, every "that's what she
    said" line is removed, including lines from your own file.
- A clean example set is in `docs/office-lines.example.json`, and the file format is described
  in `docs/office-lines.md`.
- The override file is not created automatically. Copy the example into `<userData>` to start
  from it.

## Auto-update default off (T-009)

- `c314a653`: `DEFAULTS.autoUpdate` is now `false`. Only an explicit `true` enables background
  checks. The updater gate fails closed if the config cannot be read.
- `17672cce`: `autoDownload` follows the flag. With it off, a manual version-badge check stops
  at "available" and nothing downloads until you click download.
- `04afd636`: when checks are off, the idle Updates text says so (`updatesSection.idleDetailOff`).
- There is no migration: a saved config keeps whatever value it already has.

## Ask-first setting (T-010) — PENDING

- **Not merged.** Work is on branch `ask-first-setting`, which has no commits beyond `stable`
  yet.
- Goal: build the ask-first rule into the hive prompts, behind a Settings toggle.
- Fill in this section and the summary row once it merges.

## User-editable files (macOS)

`<userData>` is Electron's `app.getPath('userData')`, the folder that holds `config.json`.

| Build | `<userData>` |
|---|---|
| Dev (`npm run dev`) | `~/Library/Application Support/munder-difflin/` |
| Packaged | probably `~/Library/Application Support/Munder Difflin/` (from `productName`; unverified) |

| File | Purpose |
|---|---|
| `config.json` | Settings, including `autoUpdate`, `officeSmallTalk`, `officeInnuendo` and `copilotRequestCap` |
| `model-catalog.override.json` | Model catalog override |
| `model-catalog.json` | Upstream remote-catalog cache. Do not edit it |
| `office-lines.json` | Small-talk line override |

## Upstream merge hotspots

These files are the most likely to conflict when pulling upstream. After a merge, re-check each
item.

| File | Ours | Re-check |
|---|---|---|
| `src/main/hive.ts` | Copilot hook installer (writes the hive prompt into `copilot-instructions.md`), OTel env | `installCopilotHooks` still runs; Copilot agents still get inbox mail and telemetry; ask-first prompt text (once T-010 merges) |
| `src/main/config.ts` | `DEFAULTS` (`autoUpdate: false`, `officeSmallTalk`, `officeInnuendo`), `copilotRequestCap` | `autoUpdate` is still `false`; no new upstream default silently re-enables updates |
| `src/main/updater.ts` | `=== true` gate, `autoDownload` follows the flag | Upstream has not reset `autoDownload = true` or changed the gate |
| `src/main/index.ts` | Catalog override call sites, `office:lines` IPC, telemetry wiring | Override is still applied before the remote fetch |
| `src/renderer/src/components/SettingsModal.tsx` | Small-talk and innuendo toggles, auto-update toggle default | Toggles still render; auto-update starts off |
| `src/shared/modelCatalog.json` and `docs/model-catalog.json` | 24 Copilot rows; the mirror matches the bundled file | Keep our Copilot rows; re-sync the mirror (a test enforces it) |
| `src/shared/agentProvider.ts`, `providerAutomation.ts` | Copilot preset (`-i`, hooks bridge, commands) | Upstream preset changes have not reverted to `-p` |
| `src/main/telemetry.ts`, `breaker.ts`, `pricing.ts` | `/v1/traces` ingest, Copilot request cap | Copilot still shows n/a, not $0 |
| `src/renderer/src/scene/office/cafeteriaLines.ts` | Two pickers routed through `officeLinesOverride.ts` | New upstream lines or pools still pass through the filter |
| `src/renderer/src/i18n/locales/{en,ar,zh-CN}.json` | Custom-model, office and update strings | Keys are still present after a JSON merge |
| `CHANGELOG.md` | Fork entries | Keep them separate from upstream entries |
