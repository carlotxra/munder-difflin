# Overriding the model catalog

The model pickers read four layers. Each provider comes from the highest layer that names it:

1. `--model-catalog=<path|https-url>` on the command line, or else `MUNDER_MODEL_CATALOG`
2. `<userData>/model-catalog.override.json` (the same folder as `config.json`)
3. the remote catalog, `docs/model-catalog.json` on upstream `main` (cached for 6 hours)
4. the bundled `src/shared/modelCatalog.json`

The merge works per provider. When an override names `copilot`, its list replaces the whole Copilot
list, and every provider it leaves out falls through to the next layer. An override uses the same
schema as the catalog, and `version` is optional:

```json
{
  "remote": false,
  "providers": {
    "copilot": [
      { "label": "default (CLI default)" },
      { "id": "gpt-5.5", "label": "GPT-5.5" }
    ]
  }
}
```

Each row is validated like the remote copy: ids are length-capped and control characters are
stripped. If an override file is missing, unreadable, or not a catalog, it is skipped and the next
layer is used.

**Turning off the remote fetch:** put `"remote": false` in either override, or set
`MUNDER_MODEL_CATALOG_REMOTE=0` (`false`/`off`/`no` also work). With the fetch off, the pickers
show the overrides on top of the bundled catalog, and nothing is fetched at startup.

Examples:

```sh
MUNDER_MODEL_CATALOG=$HOME/models.json npm run dev     # env var
MUNDER_MODEL_CATALOG_REMOTE=0 npm run dev               # bundled catalog only
"/Applications/Munder Difflin.app/Contents/MacOS/Munder Difflin" --model-catalog=/path/models.json
```

The remote catalog ranks above the bundled one. When upstream's copy lists a provider, that list
replaces the bundled list for that provider. To keep a local list for a provider (for example the
bundled Copilot list), repeat it in an override or turn the remote fetch off.

Overrides are read each time the renderer asks for the catalog: once at launch, and again on a
forced refresh. After editing an override file, restart the app to see the change.
