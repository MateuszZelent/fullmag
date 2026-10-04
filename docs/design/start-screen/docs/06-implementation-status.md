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
| 2 | Recent index (list, search, filter, sort, grouping, virtualisation) | Done, front + host. The host list is now a view of the workspace database (section 5), same JSON shape | typecheck, lint, browser against mocked host; `cargo check` |
| 3 | Inspector: header, chips, context banner, Overview | Done | typecheck, lint, browser (five banner states) |
| 4 | Thumbnails, card grid, result preview, LRU | Done in the renderer | typecheck, lint, browser. **No frame scrubber** (host provides no frames); the host reads `project/preview/thumb.png` (a PNG up to 256 kB) into the index; nothing writes that file yet |
| 5 | Authors, History, Runs, BibTeX | Done: read side and writer | browser (three tabs, mocked host); `cargo check`. Writer records edit saves only, see §3 |
| 6 | Continue card | Done in the renderer | browser (resumable / not / host error). `resume_run`, `discard_checkpoint` do not exist |
| 7 | Compute environment | Done, front + host | `cargo check`, typecheck; **not** against a real GPU |
| 8 | Templates gallery | Gallery plus a validated canonical Python script per template (save, copy) | each script loads to ProblemIR with the repository Python package (loader only, no solver). **Create project from template stays disabled with its reason**: the API has no operation that turns script text into a project |
| 9 | Import | `.fms`; `.mx3` as a reported subset translator | translator tests and a Python load of every generated fixture script. Opening the translated script as a project is disabled for the same reason as templates; save/copy work. No other importer |
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

- **Thumbnails** are read but not generated: the list carries `project/preview/thumb.png` when a project has one (PNG, up to 256 kB, stored in the database's `thumbnails` table and inlined as a data URI for the renderer), and nothing produces it after a run. Without it the renderer shows a placeholder.
- **Checkpoints:** no `resume_run` or `discard_checkpoint`; the Continue card
  appears only if an index carries `continue`, which nothing writes yet.
- **Provenance writer** records only a generic "Saved revision N" entry when a
  save to an existing file changes its content. It does not record the first
  write of a new file, runs, or what changed, and is **unverified in a running
  application**. It touches the revision-checked save path and deserves review.
- **Index solver** is inferred from the scene's `study` keys, defaulting to FDM.
- **Rebuild** opens whole archives rather than reading only a manifest head.
- **Importers** other than `.fms` and the `.mx3` subset; **opening a script as a project** (templates and `.mx3`), which needs an API operation that accepts script text.

Packaging and process:

- `docs:bundle --if-present` runs inside `pnpm --dir apps/control-room build`, so every build route bundles the documentation when the Sphinx site has been built first; no route builds Sphinx itself.
- The browser check is not part of CI (needs Chrome on the runner).
- The status strip lacks the mockup's update notice and telemetry switch
  (not exposed by the host).
- **Open recent (quick switch)** is `Ctrl Alt O`, not the design's `Ctrl ⇧ O`, which
  is already `study.import-state` (Restore Runtime State). It focuses the list and
  selects the first project.
- **Help menu:** Search Docs (`F1`), Reference (opens the Python API reference) and
  About (opens the About section), all over an open workspace without closing it.

Product decisions still open (`01-design-spec.md` §11): index location, thumbnail
cost, network shares, *Delete from disk*, author identity. The proposed answers
were implemented as the brief said (app-data index, local roots, git config then
OS user for identity); *Delete from disk* was not built.

---

## 4. Where things are

```
apps/control-room/src/modules/start/      the module (home, inspector, rail, sections, model, ui)
apps/control-room/src/kernel/layout/      homeView.ts, header and shell wiring
apps/desktop/src-tauri/src/               recent_index.rs, workspace_commands.rs, provenance.rs, compute_probe.rs, commands
crates/fullmag-workspace/                 the per-user database (docs/07-workspace-database.md)
apps/control-room/scripts/                check-start-screen-browser.mjs, bundle-docs.mjs
public_docs/site/_static/                 fullmag-embed.js / .css (Sphinx side)
```

---

## 5. Workspace database in the desktop host (2026-10-04)

Wired (host side, `apps/desktop/src-tauri`):

- **Location and handle:** the database is opened through
  `fullmag_workspace`'s default state directory (not Tauri's `app_data_dir`),
  lazily, once, in one cached handle in managed state. The first use imports
  the legacy `recent-index.json` from the old app-data directory once; legacy
  previews are moved out of `meta` into the `thumbnails` table (schema
  version 2, forward-only migration).
- **Commands** (`workspace_commands.rs`): `workspace_list`, `workspace_pin`,
  `workspace_forget`, `workspace_history`, `workspace_open_script_dialog`,
  `workspace_open_script`, `workspace_reveal`, `workspace_read_script_text`.
  `workspace_list` also returns the open outcome (`ready`, `created`,
  `migrated`, `quarantined`, `read_only_newer_schema`).
- **Project mirror:** opening a project, `save_project_archive` and
  `project_record_outcome` record `open`, `save` and `run` events (best effort,
  never failing the command); a recorded run also re-reads the archive so the
  list gets its new thumbnail and summary.
- **`recent_index_*`:** `read`, `rebuild`, `pin` and `forget` keep their JSON
  contract and now read and write the database; `recent-index.json` is no
  longer written. Rebuild scans the roots, upserts items without counting a
  use and marks vanished files `missing`.

Not wired or not verified:

- **No renderer uses the new commands yet**; the start-screen changes of
  `07-workspace-database.md` section 9 are not part of this host change.
- **Unrun tests:** the Rust tests written for this work (crate: schema 1 to 2,
  thumbnails, `observe`; host: script list/sort/search, missing-file marking,
  open-script recording, project mirror events, legacy import on first use,
  thumbnails through a rebuild, outcome mapping of quarantined and read-only
  databases) were **not compiled or run**, because building unit tests is
  suspended by `AGENTS.md`. Only `cargo check` of the crate and of the desktop
  binary was run. The Python tests of `fullmag.workspace` ran green.
- **Behaviour changes to know:** a project forgotten from the list stays
  forgotten across a rebuild (it returns when it is used again); a save records
  the file stem as the name of a project the database has not seen before until
  the next scan or open corrects it; a database written by this build is
  read-only for an older CLI or Python at schema version 1.
- Nothing ran inside a packaged desktop application.
