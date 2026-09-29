# Customizations

A living record of what this fork, `carlotxra/munder-difflin`, changes compared with upstream
`chaitanyagiri/munder-difflin`.

**Version:** `0.5.3-custom` (`package.json` and `package-lock.json`, set on branch
`release-0.5.3-custom`). Upstream `main` still says `0.4.6` in `package.json`.

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
| Ask-first setting | Workers send god a `DECISION NEEDED` message instead of silently picking between designs, changing an interface or config format, or deleting | Settings → Autonomy & Budgets → "Workers ask before ambiguous decisions"; config `askFirst` (default on) | `src/main/askFirst.ts`, `src/main/hive.ts`, `src/main/config.ts`, `SettingsModal.tsx` | `8f685eee` (merge `4da86e2f`) | merged |
| Orchestrator launch flags | Extra CLI flags (e.g. a reasoning-effort flag) appended to god's launch argv only, for any provider; other agents never get them | Settings → Agents & Models → Advanced → "Extra launch flags for <god>" (shell-style string); config `godArgs` (string[], default `[]`) | `src/shared/godArgs.ts`, `src/main/index.ts`, `src/main/config.ts`, `SettingsModal.tsx`, locales; test `test/god-launch-args.test.cjs` | branch `god-launch-args` | pending merge |
| Loopback listeners | Slack and webhook servers bind `127.0.0.1`, not all interfaces; the tunnel still dials in locally | none | `src/main/slack.ts`, `src/main/webhook.ts`; test `test/listen-loopback.test.cjs` | branch `security-hardening` (T-019) | pending merge |
| Config secrets encrypted | `slackBotToken`, `slackSigningSecret`, `groqApiKey`, `webhookSecret` move from `config.json` into the safeStorage store (one-time migration); `config.json` is written `0600` | `<userData>/integration-secrets.json` (refs `config:<key>`) | `src/main/secretStore.ts`, `src/main/config.ts`, `src/main/integrations.ts`; test `test/config-secrets.test.cjs` | branch `security-hardening` (T-019) | pending merge |
| Auto-updater removed | No electron-updater, no update IPC/toast/badge/Settings section, no `publish` feed; the fork can never poll or install the upstream build | none (the `autoUpdate` setting is gone) | deleted `src/main/updater.ts`, `UpdateToast.tsx`, `UpdateBadge.tsx`, `UpdatesSection.tsx`; `electron-builder.yml`; test `test/updater-removed.test.cjs` | branch `security-hardening` (T-019) | pending merge |
| Remote fetch off | No request to upstream `raw.githubusercontent` for the model catalog or the hero while off; bundled catalog + local override, bundled hero | Settings → General → "Fetch model list from GitHub"; config `remoteFetch` (default `false`) | `src/main/hero.ts`, `src/main/modelCatalogOverride.ts`, `src/main/index.ts`, `SettingsModal.tsx`; test `test/remote-fetch-off.test.cjs` | branch `security-hardening` (T-019) | pending merge |
| Tunnel deps | Unused `localtunnel` removed; tunnelmole telemetry off at install (CI env, documented command) and at runtime | `TUNNELMOLE_TELEMETRY=0` | `package.json`, `.github/workflows/{ci,release}.yml`, `src/main/{slack,webhook}.ts`; test `test/tunnel-deps.test.cjs` | branch `security-hardening` (T-019) | pending merge |

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
> `docs/model-catalog.json` has only 6 Copilot rows (checked at `e9793df3`), and that list
> replaces our bundled 24. To keep the 24, either repeat `copilot` in an override file or turn
> off the remote fetch.

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

## Auto-update default off (T-009), superseded by T-019

T-019 removed the updater entirely (see the summary row "Auto-updater removed"). The notes below are history.


- `c314a653`: `DEFAULTS.autoUpdate` is now `false`. Only an explicit `true` enables background
  checks. The updater gate fails closed if the config cannot be read.
- `17672cce`: `autoDownload` follows the flag. With it off, a manual version-badge check stops
  at "available" and nothing downloads until you click download.
- `04afd636`: when checks are off, the idle Updates text says so (`updatesSection.idleDetailOff`).
- There is no migration: a saved config keeps whatever value it already has.
| Scheduled auto-compact persists | Settings → Maintenance toggle now survives a restart | config `contextTrigger.compact.enabled` | `src/shared/triggers.ts`, `SettingsModal.tsx` | `b6005270` | branch `fix-scheduled-compact-persist` |

## Ask-first setting (T-010)

- `8f685eee` (merged in `4da86e2f`): `src/main/askFirst.ts` holds all the prompt text.
  `hive.ts` adds one line to the prompt builder (`askFirstPromptLine`) and a `setAskFirst`
  mirror, the same pattern as `setOrchestratorMaySpawn`.
  - Workers get the ASK FIRST clause. For a real approach question (two valid designs, an
    interface or config-format change, scope doubt, deleting anything) they send god ONE
    `DECISION NEEDED: <topic>` message with the options and a recommendation, then wait on
    that part.
  - God must put the clause in every dispatch's BOUNDARIES. God either decides, or blocks the
    card and asks the human through its `humanQA`.
  - The prep assistant is excluded, because it only rewrites prompts.
- Setting: Settings → Autonomy & Budgets → **Workers ask before ambiguous decisions**, config
  `askFirst`, **default on** (an absent value reads as on). It is mirrored in the preload and
  renderer config types, and the strings are in en, ar and zh-CN.
- The setting is read when a prompt is built, so a change reaches agents spawned after it.
- With it off, the prompts are byte-identical to `stable` before this change.
- Test: `test/ask-first.test.cjs`.

## Scheduled auto-compact persistence (T-014)

- `b6005270`: bug fix. The Settings → Maintenance "Scheduled auto-compact" toggle read and
  wrote the `compact-maintenance` mission, but boot (`src/main/index.ts`) retires that mission
  into `contextTrigger.compact`. Once retired, the toggle always read off and its save changed
  nothing. It now reads and writes `contextTrigger.compact.enabled` through
  `scheduledCompactEnabled` / `scheduledCompactPatch` in `src/shared/triggers.ts`.
- Test: `test/scheduled-compact-persist.test.cjs` (save → reload round trip).


## Upstream sync (T-015)

- Branch `sync-upstream` merges upstream `main` at `0dd161ce` into stable `46db67ab` (a real
  merge, 45 upstream commits). No conflicts. Upstream changed only `docs/` and `blog/`, so no
  source file, no `package.json` and no version string moved. Every customization above is intact.
- Overlap: upstream added `claude-sonnet-5-5`, `gpt-6-sol`, `gpt-6-terra` and `gpt-6-luna` to
  `docs/model-catalog.json` without adding them to the bundled catalog. That breaks the
  mirror test, which upstream `main` presumably fails as well. Following the T-006 rule, the
  same rows went into `src/shared/modelCatalog.json`, and the pinned lists in
  `test/model-catalog.test.cjs` and `test/provider-config.test.cjs` were updated. Our 24 Copilot
  rows are unchanged.


## Custom model "use" keeps the model (T-016)

- Bug fix for T-007. The Add Agent and Edit Agent model rows are `<label>` Rows. Clicking
  "use" unmounts `CustomModelInput` during the click, so the label treated the click as
  outside its content and forwarded it to its first control, the "CLI default" chip. That
  reset the model and left the command as bare `copilot`. `CustomModelInput` now calls
  `preventDefault()` on clicks inside it. Command Center and onboarding had no wrapping
  label and were not affected.
- Test: `test/custom-model.test.cjs` (copilot `--model` command; label guard).


## Hire manifests accept any provider (T-017)

- Feature. `src/shared/hire.ts` derives `HireProvider` / the provider allowlist from
  `AGENT_PROVIDER_PRESETS` (every preset except `custom`), so a manifest can name copilot, grok,
  kimi, qwen, opencode, crush, pi, gemini, etc. The model still goes through the local preset's
  `modelFlag`.
- Security unchanged for the original four (claude/antigravity/codex/cursor keep the curated
  `SAFE_FLAG_NAMES`). Every other provider has no curated safe set, so any `commandFlags` entry
  rejects the manifest: only `provider` + `model` pass.
- `AddAgentModal.tsx` hire-prompt text lists the full provider set.
- Test: `test/hire-any-provider.test.cjs`.


## User-editable files (macOS)

`<userData>` is Electron's `app.getPath('userData')`, the folder that holds `config.json`.

| Build | `<userData>` |
|---|---|
| Dev (`npm run dev`) | `~/Library/Application Support/munder-difflin/` |
| Packaged | probably `~/Library/Application Support/Munder Difflin/` (from `productName`; unverified) |

| File | Purpose |
|---|---|
| `config.json` | Settings (mode `0600`, no secrets), including `remoteFetch`, `officeSmallTalk`, `officeInnuendo`, `askFirst` and `copilotRequestCap` |
| `model-catalog.override.json` | Model catalog override |
| `model-catalog.json` | Upstream remote-catalog cache (only used while `remoteFetch` is on). Do not edit it |
| `integration-secrets.json` | Encrypted secrets (integrations and the four config secrets), mode `0600` |
| `office-lines.json` | Small-talk line override |

## Upstream merge hotspots

These files are the most likely to conflict when pulling upstream. After a merge, re-check each
item.

| File | Ours | Re-check |
|---|---|---|
| `src/main/hive.ts` | Copilot hook installer (writes the hive prompt into `copilot-instructions.md`), OTel env | `installCopilotHooks` still runs; Copilot agents still get inbox mail and telemetry; `askFirstPromptLine` is still in the prompt builder |
| `src/main/config.ts` | `DEFAULTS` (`remoteFetch: false`, `askFirst: true`, `officeSmallTalk`, `officeInnuendo`), `copilotRequestCap`, `CONFIG_SECRET_KEYS` stash/load in `persistConfig`/`readConfig` | `remoteFetch` is still `false`; secrets still never reach `config.json`; an upstream `autoUpdate` field is not reintroduced |
| `src/main/updater.ts` (deleted) | Removed in T-019 | An upstream merge must not bring it (or `electron-updater`, or the `publish` block) back; `test/updater-removed.test.cjs` fails if it does |
| `src/main/index.ts` | Catalog override call sites, `office:lines` IPC, telemetry wiring, `hive.setAskFirst` (bootstrap and `config:update`) | Override is still applied before the remote fetch |
| `src/renderer/src/components/SettingsModal.tsx` | Small-talk and innuendo toggles, remote-fetch toggle, ask-first toggle | Toggles still render; remote fetch starts off; no auto-update toggle; ask-first starts on |
| `src/shared/modelCatalog.json` and `docs/model-catalog.json` | 24 Copilot rows; the mirror matches the bundled file | Keep our Copilot rows; re-sync the mirror (a test enforces it) |
| `src/shared/agentProvider.ts`, `providerAutomation.ts` | Copilot preset (`-i`, hooks bridge, commands) | Upstream preset changes have not reverted to `-p` |
| `src/main/telemetry.ts`, `breaker.ts`, `pricing.ts` | `/v1/traces` ingest, Copilot request cap | Copilot still shows n/a, not $0 |
| `src/renderer/src/scene/office/cafeteriaLines.ts` | Two pickers routed through `officeLinesOverride.ts` | New upstream lines or pools still pass through the filter |
| `src/renderer/src/i18n/locales/{en,ar,zh-CN}.json` | Custom-model, office, update and ask-first strings | Keys are still present after a JSON merge |
| `CHANGELOG.md` | Fork entries | Keep them separate from upstream entries |
