# Implementation status

What of this design is built, what was verified and how, and what is left.
Updated at the end of the implementation run of 2026-10-03/04. "Verified" names
the evidence actually collected; anything not named there was **not** verified.

Standing limitation of this run: unit-test compilation is suspended by
`AGENTS.md`, so every unit test written for this work is **unrun**. Browser checks
used mocked hosts or the real built stylesheets; no check ran inside a packaged
desktop application against real project archives.

---

## 1. Steps

| Step | Scope | State | Evidence |
|---|---|---|---|
| 1 | Shell, rail, launch tiles | Done | typecheck, lint, browser |
| 2 | Recent index (list, search, filter, sort, grouping, virtualisation) | Done, front + host | typecheck, lint, browser against mocked host; `cargo check` |
| 3 | Inspector: header, chips, context banner, Overview | Done | typecheck, lint, browser (five banner states) |
| 4 | Thumbnails, card grid, result preview, LRU | Done in the renderer | typecheck, lint, browser. **No frame scrubber** (host provides no frames); thumbnails are produced by nothing yet |
| 5 | Authors, History, Runs, BibTeX | Done: read side and writer | browser (three tabs, mocked host); `cargo check`. Writer records edit saves only, see §3 |
| 6 | Continue card | Done in the renderer | browser (resumable / not / host error). `resume_run`, `discard_checkpoint` do not exist |
| 7 | Compute environment | Done, front + host | `cargo check`, typecheck; **not** against a real GPU |
| 8 | Templates gallery | Done as a gallery | browser. Creating a project from a template is disabled with its reason |
| 9 | Import | `.fms` only | browser (a refused `.mx3`). No other importer |
| 10 | Learn, Settings, About | Done | browser |
| 11 | Sphinx documentation (this folder, `05-…`) | Done, not bundled by builds | browser against the real built site; `sphinx-build -W -n` of the site with the embed assets succeeds locally (exit 0) |

Additions beyond the original ten steps:

- **Home over a workspace** and a rebuilt header (Home first in the menu, brand
  without a menu, no wrapping labels).
- **Palette parity** for the list: open / pin / remove of the selection.
- **Status strip** along the bottom.
- **About** carries the README's authors, affiliations, citation, BibTeX,
  licence statement and funding verbatim, guarded by a drift test.
- **Build information** from the host (`app_build_info`).
- **Browser check** of layout and WCAG AA contrast on the real stylesheets
  (`check:start-screen-browser`): 37 pairs per theme, 0 below AA after one fix.

---

## 2. Gates from `04-implementation-prompt.md` §7

| Gate | Result |
|---|---|
| Types | clean for every touched file; the repository's baseline has unrelated errors in test files |
| Lint | clean |
| Unit | **not run** (suspended); tests written for `recentIndex`, `selectBanner`, provenance, templates, import, docs, About drift and more |
| Contrast | 0 below AA on the implementation, both themes (`check:start-screen-browser`); the original `audit_contrast.mjs` audits the mockup and needs a global Playwright path |
| a11y | roles, names and keyboard paths implemented per `03-…`; Storybook + `addon-a11y` **not run** |
| E2E | **not run**; the shell needs a live backend session handshake |
| Visual | spot-checked in a browser; no screenshot diff against `mockups/assets/screens/` |

Continuous integration shows four failing checks that also fail on an unmodified
`master` (`control-room-contracts`, `rust-contracts`, `canonicalization-guards`,
`browser-fixture-smoke`); none was introduced by this work.

---

## 3. Known gaps

Host (needs work outside the renderer):

- **Thumbnails** are not generated. The renderer shows a placeholder.
- **Checkpoints:** no `resume_run` or `discard_checkpoint`; the Continue card
  appears only if an index carries `continue`, which nothing writes yet.
- **Provenance writer** records only a generic "Saved revision N" entry when a
  save to an existing file changes its content. It does not record the first
  write of a new file, runs, or what changed, and is **unverified in a running
  application**. It touches the revision-checked save path and deserves review.
- **Index solver** is inferred from the scene's `study` keys, defaulting to FDM.
- **Rebuild** opens whole archives rather than reading only a manifest head.
- **Importers** other than `.fms`; **template instantiation**.

Packaging and process:

- `docs:bundle` is not part of the Windows, desktop or CI build routes.
- The browser check is not part of CI (needs Chrome on the runner).
- The status strip lacks the mockup's update notice and telemetry switch
  (not exposed by the host).
- **Open recent (quick switch), `Ctrl ⇧ O`** from `03-…` is not implemented: that
  chord is already `study.import-state` (Restore Runtime State). It needs a
  different chord or a decision about the old one; the list is reachable with
  `/` and the arrow keys meanwhile.
- **Help menu** shows Search Docs only; Reference and About stay hidden
  placeholders.

Product decisions still open (`01-design-spec.md` §11): index location, thumbnail
cost, network shares, *Delete from disk*, author identity. The proposed answers
were implemented as the brief said (app-data index, local roots, git config then
OS user for identity); *Delete from disk* was not built.

---

## 4. Where things are

```
apps/control-room/src/modules/start/      the module (home, inspector, rail, sections, model, ui)
apps/control-room/src/kernel/layout/      homeView.ts, header and shell wiring
apps/desktop/src-tauri/src/               recent_index.rs, provenance.rs, compute_probe.rs, commands
apps/control-room/scripts/                check-start-screen-browser.mjs, bundle-docs.mjs
public_docs/site/_static/                 fullmag-embed.js / .css (Sphinx side)
```
