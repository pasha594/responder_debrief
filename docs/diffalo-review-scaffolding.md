# Diffalo review scaffolding

What this repo needs so Diffalo can record a review. Reviews are `manual`:
they run only when someone asks.

This app has no accounts. The generic Diffalo skill that says to mint one is
wrong here. The Cursor rule in `.cursor/rules/diffalo-state.mdc` is the
short version of this page.

## What is in place

`diffalo.json` names the static screens (`/`, `/health`, `/sources`) and
points at `scripts/diffalo-state.mjs`. It pins no fire pathname. Active fires
rotate; `routeKey` is an exact match, so a hardcoded `/fire/<slug>` goes stale
and the dump-dom gate then applies the home tagline to a fire page — a 90s
timeout.

`env` lives at the document root, not under `app`. The `app` block reads only
`install`, `dev`, and `cwd`. Nested `app.env` is dropped with no warning.
The data host is `f005`. `f004` 404s every path in this bucket.

Global `expectText` is the `<title>` ("Responder Brief"). That is the dump-dom
gate and means only "the SPA shell loaded". Per-route `expectText` replaces
the global list, so only the static pages get stronger text.

Map readiness is the state command's `ready` field, which the recording
browser waits on:

- `rd-fire-shell` — the existing «All fires» back button, once the fire chrome
  has mounted.
- `rd-fire-perimeter` — a hidden 1×1 marker, once the perimeter GeoJSON has
  landed. GeoJSON landed is not the same as the outline painted.

Stories that need a fire use `state: { name: "fire-detail" }` (or
`fire-map-overlay`) and no `place`. There is deliberately no `fire` place.

The Vite dev server strips `index.html`'s `upgrade-insecure-requests` CSP
(`apply: 'serve'`). A recording reached over LAN/Tailscale otherwise upgrades
every module request to https and lands on a blank page. The production build
keeps the tag.

## State families

Run from `frontend/` (that is `app.cwd`):

```
node ../scripts/diffalo-state.mjs list
node ../scripts/diffalo-state.mjs run <name> --args '<json>'
```

| Family | What it opens |
| --- | --- |
| `directory` | `/` |
| `fire-detail` | a live fire with a published perimeter; default ready is the perimeter marker |
| `fire-map-overlay` | a live fire whose forecast still covers *now* and that has a georeferenced map sheet; waits on the fire chrome, not the outline |
| `health` | `/health` |
| `sources` | `/sources` |

Every `run` returns `{ route }` and, for fire families, `{ ready }`. Never
`account`. Never `clientState`. Diffalo would treat those as a login.

`fire-detail` prefers Little Giant when that fire is still active; otherwise
the largest active fire with a published perimeter. `fire-map-overlay` picks
from catalogs at run time. Sheet ids and slugs rotate — do not pin them.

If the fire API or the B2 catalogs are unreachable, the story fails as
"state command failed" rather than recording a broken frame.

## What broke before this existed

1. A state result with `account` made Diffalo demand a sign-in command.
2. Global `expectText` was the home tagline, so fire pages timed out at 90s.
3. `/fires?limit=20` picked a 0-acre fire with no perimeter.
4. "Responder Brief" is in `<title>` and on the resolving placeholder, so it
   passed while the map was still a blank shell.
5. A pinned `/fire/<slug>` in `places` / `routes` went stale within a week.
6. `env` under `app` was ignored; `f004` 404s this bucket.

The contract tests in `frontend/src/app/diffalo.test.ts` lock the fixes.
Vitest runs them. `tsc --noEmit` (and `npm run build`) exclude `*.test.ts`,
because those files import Node builtins the app tsconfig does not type.

## What not to do

- Do not mint an account or emit `clientState`.
- Do not add a `fire` key under `places`, or a `/fire/…` entry under `routes`.
- Do not invent a fire slug in a story. Name a state family.
- Do not put map-ready strings in `expectText`. Use `ready`.
- Do not make the resolving shell paint "Acres" or "All fires" just to
  satisfy a ready-check.
- Do not treat a successful review URL as proof the story filmed the
  right frame. `rd-fire-perimeter` means the GeoJSON landed, not that the
  outline is on screen.
