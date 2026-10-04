# Implementation status

What of this design is built, what was verified and how, and what is left.
Updated on 2026-10-05, after the merges of PR #128 (workspace UI) and #129
(script prerequisites). "Verified" names the evidence actually collected;
anything not named there was **not** verified.

Standing limitations: building Rust unit tests is suspended by `AGENTS.md`, so
the Rust tests written for the workspace database and the desktop host are
**uncompiled and unrun** (only `cargo check` ran). The frontend unit tests
(vitest) do run and are listed in section 2. Browser checks used mocked hosts or
the real built stylesheets; no check ran inside a packaged desktop application
against real project archives.

---

## 1. Steps

| Step | Scope | State | Evidence |
|---|---|---|---|
| 1 | Shell, rail, launch tiles | Done | typecheck, lint, browser |
| 2 | Recent index (list, search, filter, sort, grouping, virtualisation) | Done, front + host. The host list is a view of the per-user workspace database (section 5); projects and scripts share one list with a kind switch and unified sorting | typecheck, lint, vitest, browser against mocked host; `cargo check` |
| 3 | Inspector: header, chips, context banner, Overview | Done | typecheck, lint, browser (five banner states) |
| 4 | Thumbnails, card grid, result preview, LRU | Done in the renderer | typecheck, lint, browser. **No frame scrubber** (host provides no frames). The thumbnail is now written: a finished run records its outcome and a viewport thumbnail into the open project (`project_record_outcome`, `project/preview/thumb.png`, a PNG up to 256 kB) and the index reads it. Writer verified by `cargo check` and a mocked-host browser check, **not** in a packaged app |
| 5 | Authors, History, Runs, BibTeX | Done: read side and writer | browser (three tabs, mocked host); `cargo check`. Writer records edit saves only, see §3 |
| 6 | Continue card | Done: checkpoint-backed card in the renderer, fed by the recorded run outcome | vitest (`continueModel`), browser (resumable / not / host error). `discard_checkpoint` does not exist and its button stays disabled |
| 7 | Compute environment | Done, front + host | `cargo check`, typecheck; **not** against a real GPU |
| 8 | Templates gallery | Gallery plus a validated canonical Python script per template (save, copy, link to its documentation page) | each script loads to ProblemIR with the repository Python package (loader only, no solver); vitest `templates`. **Create project from template stays disabled with its reason**: the API has no operation that turns script text into a project |
| 9 | Import | `.fms`; `.mx3` as a reported subset translator | vitest `mx3Import`, `Mx3ImportReport`; a Python load of every generated fixture script. Opening the translated script as a project is disabled for the same reason as templates; save/copy work. No other importer |
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
  (`check:start-screen-browser`): 40 pairs per theme, 0 below AA; now a CI step
  of `browser-fixture-smoke` (Playwright Chromium, no server).
- **Scripts:** recent Python scripts (list, search, sort, pin, forget, reveal,
  open, copy, read text) over the workspace commands, with a script inspector
  (history, run outcome, `fullmag script inspect`). The CLI has one Python
  interpreter resolver and `fullmag script inspect` (`crates/fullmag-cli`,
  PR #129). **Run script in a new window stays disabled** with its reason.

---

## 2. Gates from `04-implementation-prompt.md` §7

| Gate | Result |
|---|---|
| Types | `node scripts/typecheck-control-room.mjs` clean on 2026-10-05 |
| Lint | `pnpm run lint` clean (`--max-warnings=0`) |
| Unit (frontend) | vitest `src/modules/start` plus `NewProblemDialog.test.tsx`: 29 files, 280 passed, 12 skipped, 0 failed (2026-10-05). Includes `useWorkspaceScripts` / `useScriptHistory` (mount, focus within 750 ms, after actions, unavailable host, error mapping) |
| Unit (Rust) | **not run** (suspended); `cargo check` only |
| Python | `packages/fullmag-py/tests/test_api.py`: 305 tests, OK (1 skipped), 2026-10-05 |
| Contrast | 0 below AA on the implementation, both themes (`check:start-screen-browser`, also in CI) |
| a11y | roles, names and keyboard paths implemented per `03-…`; Storybook + `addon-a11y` **not run** |
| E2E | **not run**; the shell needs a live backend session handshake |
| Visual | spot-checked in a browser; no screenshot diff against `mockups/assets/screens/` |

Continuous integration: the earlier red checks on `master` were repaired by
updating tests that predate the project output storage change (the new
simulation dialog submit path, and Python CLI test doubles that now receive the
storage keywords and expect `.zarr` stage directories). The one remaining red
area is three `fullmag-api` router tests that fail on open gaps of the P6-37
walker; they are unrelated to the start screen and are not fixed here.

---

## 3. Known gaps

Host (needs work outside the renderer):

- **Thumbnails** exist only for projects that finished a run since the writer
  landed; others show a placeholder. Scripts have no thumbnail.
- **Checkpoints:** `discard_checkpoint` does not exist; the Continue card shows
  it disabled.
- **Provenance writer** records only a generic "Saved revision N" entry when a
  save to an existing file changes its content. It does not record the first
  write of a new file or what changed, and is **unverified in a running
  application**. It touches the revision-checked save path and deserves review.
- **Index solver** is inferred from the scene's `study` keys, defaulting to FDM.
- **Rebuild** opens whole archives rather than reading only a manifest head.
- **Disabled, with their reason shown:** running a script from the inspector;
  creating a project from a template or from a translated `.mx3` (needs an API
  operation that accepts script text); importers other than `.fms` and the
  `.mx3` subset; discarding a checkpoint; the result frame scrubber.

Packaging and process:

- `docs:bundle --if-present` runs inside `pnpm --dir apps/control-room build`, so every build route bundles the documentation when the Sphinx site has been built first; no route builds Sphinx itself.
- The status strip lacks the mockup's update notice and telemetry switch
  (not exposed by the host); both stay absent.
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

## 5. Workspace database in the desktop host

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

- The renderer uses these commands (`useWorkspaceScripts`, `useScriptHistory`,
  the recent index); the list is re-read on mount, on window focus and after
  an action, with no timer.
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
