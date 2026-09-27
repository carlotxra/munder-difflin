# Office small talk: toggles and `office-lines.json`

When an agent takes a break at the coffee machine, the vending machine, the snack
counter or a table, it may show a one-line quip, and two agents at one table may
have a short exchange. This page covers how to switch that off, how to keep it
clean, and how to write your own lines. The status bubbles an agent shows while
it works (tool calls, "waiting", "needs you") are not affected by any of this.

## Settings → General

| Toggle | Default | Effect |
| --- | --- | --- |
| **Office small talk** | on | Off = no break-spot bubbles at all: no quips, no gossip, no exchanges. |
| **Allow innuendo** | **off** | Off = no "that's what she said" anywhere. The whole TWSS exchange set is dropped, and any line or exchange containing the phrase (straight or curly apostrophe) is removed from every pool, including per-character lines and the openers a character uses when they sit down first. Michael and Jim get clean stand-ins. |

Both apply on **Save**.

## The override file

Put a file at `<userData>/office-lines.json`. On macOS that is
`~/Library/Application Support/munder-difflin/office-lines.json`, next to
`config.json`. It is read when the window loads and again on every Settings save,
so after editing it you can press Save in Settings (or reload the window).

A clean, complete set ships as [`office-lines.example.json`](office-lines.example.json):

```sh
cp docs/office-lines.example.json ~/Library/Application\ Support/munder-difflin/office-lines.json
```

### Pools

| Key | Shape | What it is |
| --- | --- | --- |
| `coffee`, `vending`, `snack`, `table` | list of lines | Solo quips at that spot |
| `characters` | `{ "<name>": list of lines }` | A character's own quips (used about 60% of the time) |
| `exchanges` | list of exchanges | Banter between any two agents at a table |
| `twss` | list of exchanges | "That's what she said" bits, used only when **Allow innuendo** is on |
| `keyed` | `{ "<name>": exchange or list of exchanges }` | Openers a character uses when they sit down first |

An exchange is a list of 2–8 beats that alternate between the two agents, the one
who sat down first speaking first: `["setup", "reply", "tag"]`. Character names
are the cast keys: `michael`, `jim`, `pam`, `dwight`, `kevin`, `angela`, `oscar`,
`stanley`, `phyllis`, `andy`, `kelly`, `ryan`, `toby`, `creed`, `meredith`.

### Replace or append

A bare list **replaces** the built-in pool. To add to it instead, wrap it:

```json
{
  "vending": { "mode": "append", "lines": ["B4. it's always B4."] },
  "characters": {
    "dwight": ["FALSE."],
    "pam": { "mode": "append", "lines": ["taping Jim's desk back together"] }
  }
}
```

The file may be partial. Any pool it leaves out, and any character it doesn't
name, keeps the built-in lines.

### Validation

- Lines must be strings. Anything else is dropped.
- Control characters and bidi overrides are removed, whitespace is collapsed, and
  a line over 120 characters is cut short with `…`.
- An exchange with fewer than 2 beats, or with any beat that isn't a string, is
  dropped as a whole. Beats past the 8th are cut.
- Each pool keeps at most 200 entries. The file may be at most 256 KB.
- A pool that ends up empty is ignored and keeps the built-in lines. To silence
  the small talk, use the toggle rather than an empty list.
- A missing, unreadable or invalid file is ignored and the built-in lines are used.
- With **Allow innuendo** off, the filter also applies to your own lines.

Code: `src/shared/officeLinesPayload.ts` (validation),
`src/main/officeLinesOverride.ts` (reading the file),
`src/renderer/src/scene/office/officeLinesOverride.ts` (merge and filter).
