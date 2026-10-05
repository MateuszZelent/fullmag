# Implementation status

What of this design is built, what was verified and how, and what is left.
Updated on 2026-10-05, after the merges of PR #128 (workspace UI) and #129
(script prerequisites). "Verified" names the evidence actually collected;
anything not named there was **not** verified.

Standing limitations: building Rust unit tests is suspended by `AGENTS.md`, so
the Rust tests written for the workspace database and the desktop host were
**uncompiled and unrun** when this status was written. The follow-up work of
2026-10-05 (manifests of project runs, result thumbnails, syntax check, archive;
branch `codex/ws-finish-20261005`) was explicitly asked to run its Rust tests and
did: `cargo test -p fullmag-workspace-inspect -p fullmag-workspace` (48 + 30
passed), `cargo test -p fullmag-api --bin fullmag-api router_v2` (938 passed,
0 failed, 2 ignored, `FULLMAG_PYTHON` set), the `accepted_project_storage`,
`script_check` and `workspace_archive` tests (11 passed), `cargo check -p
fullmag-cli -p fullmag-desktop` clean; vitest `src/modules/start src/kernel`
(2497 passed, 13 skipped), typecheck and eslint clean. The frontend unit tests
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
| 4 | Thumbnails, card grid, result preview, LRU | Done in the renderer | typecheck, lint, browser. **No frame scrubber**: not built, see section 3 for the exact reason. Result folders show the stored preview of their source project (labelled "project preview"), never a render of the result. The thumbnail is now written: a finished run records its outcome and a viewport thumbnail into the open project (`project_record_outcome`, `project/preview/thumb.png`, a PNG up to 256 kB) and the index reads it. Writer verified by `cargo check` and a mocked-host browser check, **not** in a packaged app |
| 5 | Authors, History, Runs, BibTeX | Done: read side and writer | browser (three tabs, mocked host); `cargo check`. Writer records edit saves only, see §3 |
| 6 | Continue card | Done in the renderer. Discard checkpoint works for an open project through the runtime route `DELETE /v2/sessions/current/persistence/checkpoints/{id}` (inline two-step confirmation, command `study.discard-checkpoint`) | browser (resumable / not / host error) for the card; Rust handler tests, session store test and vitest for Discard; **no browser run of Discard and no run against a real project**. `resume_run` and the host `discard_checkpoint` do not exist |
| 7 | Compute environment | Rozbudowany widget i szczegóły Settings; istniejące zasoby runtime v2 | Przeglądarka: rzeczywisty RTX 4080 SUPER, 48 wątków CPU i 10 kontroli stanów/motywów/układu. Lint zmiany i kontrole API/architektury: PASS. Pełna kontrola typów/lint: błędy poza zakresem; szczegóły w [09-compute-environment.md](09-compute-environment.md) |
| 8 | Templates gallery | Gallery plus a validated canonical Python script per template (save, copy) | each script loads to ProblemIR with the repository Python package (loader only, no solver). **Create script from template…** (desktop only) saves the script through the host command `script_save_new` (native Save dialog, no overwrite without the dialog's confirmation, atomic UTF-8 write, first-line origin comment, `create` + `open` events), then Home selects it so Run in new window is next. Outside the desktop host the button is disabled with its reason; Download and Copy script work everywhere. **Create project...** (browser and desktop) runs the script once after a consent dialog, through `POST /v2/persistence/projects/from-script`, and opens a project with the exported scene, the original script embedded (`project/source/script.py`, `script.json`) and an `import` history entry; a banner reports the fidelity verdict (`08-script-open.md`, "Phase 3 as built"). The scene is an approximation: see the survey there |
| 9 | Import | `.fms`; `.mx3` as a reported subset translator | translator tests and a Python load of every generated fixture script. **Save translated script…** (desktop only) goes through the same `script_save_new` (event `import`); the report of untranslated statements stays visible before saving, and an incomplete translation can be saved (the report says it stops when run). Download and Copy script work everywhere. **Create project...** on the report does the same as for templates, from the translated script. No other importer |
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
  PR #129). Run script in a new window is implemented on the host and in the
  inspector (`08-script-open.md`, Phase 1); not verified on a packaged install
  or through the UI. Templates and translated `.mx3` files become scripts in
  this list through `script_save_new`.

---

## 2. Gates from `04-implementation-prompt.md` §7

| Gate | Result |
|---|---|
| Types | `node scripts/typecheck-control-room.mjs` clean on 2026-10-05 |
| Lint | `pnpm run lint` clean (`--max-warnings=0`) |
| Unit (frontend) | vitest `src/modules/start` plus `NewProblemDialog.test.tsx`: 29 files, 280 passed, 12 skipped, 0 failed (2026-10-05). Includes `useWorkspaceScripts` / `useScriptHistory` (mount, focus within 750 ms, after actions, unavailable host, error mapping) |
| Unit (Rust) | `cargo test -p fullmag-desktop` ran on 2026-10-05 for the desktop host: 95 passed, 0 failed, including the 10 `script_save` tests (file name, first line, validation, atomic write, refused overwrite, `create`/`import` events). The workspace crate tests were not re-run for this change |
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
  landed; others show a placeholder. Scripts have no thumbnail. A result folder
  has one only when its run manifest names a project that has a stored preview
  (the project's image, `thumbnail_origin: source_project`); results of script
  runs have none.
- **Run manifests of project runs** (2026-10-05, branch `codex/ws-finish-20261005`):
  accepted project runs write `fullmag-run.json` into their user-facing results
  leaf (`running` at reservation, then `completed`/`failed`/`cancelled`).
  `source.path` is empty because the accepted run does not know the `.fms` path;
  the link to the project item is by `project_id`. Runs without an
  `output_storage` policy have no leaf and no manifest. Verified by
  `accepted_project_storage::tests` (3) and a scanner link test; **not**
  exercised through a real solver run.
- **Script syntax check:** the script detail now uses Python's parser through
  the never-executing helper when an interpreter resolves (5 s deadline, cached).
  "Imports not found" is relative to that interpreter, not to the one a run will
  use. Verified with the interpreter of this machine (`FULLMAG_PYTHON`), not on
  a packaged install; without an interpreter the inspector says "not checked".
- **Download results:** `GET /v2/workspace/items/{id}/archive` streams a result
  folder as a zip (cap 2 GiB / 60 000 files, links refused). The result
  inspector ("Download as zip" in its menu) and the Runs tab of a project (newest
  linked, non-missing folder) use it. Verified by Rust tests (zip content, caps,
  links, route) and vitest; **not** exercised in a browser with a real
  multi-gigabyte folder.
- **Frame scrubber: an index of saved frames, not a player.** The runner now
  writes `frames.json` (`fullmag.frames_index.v1`: `index`, `step`, `time_s`,
  `stage_id`, `quantity_ids`, optional `bytes`, `path`) into each results leaf
  from the step and time every field snapshot already carries
  (`FieldSnapshot::step`/`time`, all four writer paths in
  `artifact_pipeline.rs` plus the non-streamed path in `artifacts.rs`),
  replaced atomically and bounded to 100 000 frames (`truncated: true` beyond).
  `fullmag-workspace-inspect` reads it (bounded JSON, no chunk is opened), joins
  the stage leaves and renumbers frames over the folder. The result detail
  carries `frames_index` (count, first/last step and time, per-stage counts,
  truncation, a note when a leaf was unreadable); `GET
  /v2/workspace/items/{id}/frames?from&limit` pages it (limit at most 1000).
  The inspector's Overview shows a slider with previous/next and the label
  "frame i of N - step - t = ... ns" plus the stage. It is labelled an index
  of saved frames: **no image is rendered per frame**, the header still shows
  only the stored project preview. A folder written before this change has no
  `frames.json`; it keeps its frame count and the inspector says it has no
  frame index. Nothing is reconstructed from counts, because the autosave stage
  manifests hold counts, not per-frame step or time. A run that is resumed into
  an existing leaf starts a fresh index for the frames written after the
  resume. Verified by Rust tests (writer, reader, route, OpenAPI) and vitest;
  the runner crate's own unit tests were not built or run (build rule for unit
  tests), and no run was executed end to end to produce a real `frames.json`.
- **Checkpoints:** Discard is built for a project that is **open** in the
  runtime: `DELETE /v2/sessions/current/persistence/checkpoints/{id}` removes
  the run's latest checkpoint (the one Resume would restore) and refuses with
  409 while a stage restored from it, or the run manifest names it as latest;
  CAS objects stay for the store's reviewed GC. The Tauri `discard_checkpoint`
  host command for a project that is **not open** does not exist and stays out
  of scope, so the card hides Discard then (no open runtime to delete from).
  Details: section 11.4 of `docs/specs/control-room-api-endpoint-reference-v1.md`.
- **Provenance writer** records only a generic "Saved revision N" entry when a
  save to an existing file changes its content. It does not record the first
  write of a new file or what changed, and is **unverified in a running
  application**. It touches the revision-checked save path and deserves review.
- **Index solver** is inferred from the scene's `study` keys, defaulting to FDM.
- **Rebuild** opens whole archives rather than reading only a manifest head.
- **Disabled, with their reason shown:** creating or saving a script from a
  template or a translated `.mx3` outside the desktop host (browser build);
  importers other than `.fms` and the `.mx3` subset; discarding the checkpoint of a project that is not open (Discard is hidden there);
  the result frame preview image (only the frame index is built, see above).
- **Not built:** turning script text into a *project* (the API still has no
  such operation); templates therefore create scripts, never projects. The
  Save dialog's own replacement prompt is the only overwrite confirmation, and
  no template version exists to record, so the first line carries the template
  id and the date. The Save flow was not exercised in a running desktop app.

Packaging and process:

- `docs:bundle --if-present` runs inside `pnpm --dir apps/control-room build`, so every build route bundles the documentation when the Sphinx site has been built first; no route builds Sphinx itself.
- **Status strip, telemetry and update notice.** The strip shows a Telemetry
  switch backed by the per-user setting `telemetry.enabled` (workspace database
  `kv`, default off) through `GET|PUT /v2/workspace/settings/{key}`. This build
  has **no telemetry sender and no collector**: the text reads "Telemetry off -
  this build sends no data" or "Telemetry on - no collector is configured in
  this build", and an info popover says the switch only stores a preference.
  The update notice appears only when `update.available` (kv, written by a
  future updater; the API refuses to write it) holds a value; otherwise it is
  absent. No network call is made by either. If the backend lacks the route the
  switch is disabled and says so. The mockup's build number is still absent.
  Verified by Rust route tests and vitest (parsers, switch and strip markup);
  the popover and toggle were not exercised in a browser.
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

---

## 6. Workspace API in the renderer and the three-kind inspector

Added on 2026-10-05 (branch `codex/ws-inspector-20261005`), so the browser build
shows the same lists and details as the desktop app.

- **Data flow.** `api.workspace` (typed client, `src/kernel/api/ControlRoomApi.ts`)
  serves `GET /v2/workspace/items`, `/items/{id}`, `/roots`, `POST /scan`, pin,
  forget and add-by-path. The routes and their wire types are hand-declared
  (`apiPaths.ts`, `model/workspaceApiTypes.ts`) until the generated OpenAPI
  types carry them; every parser leaves a missing optional field `undefined`
  and the view says "unavailable" for it. `useWorkspaceItems` and
  `useWorkspaceItemDetail` read through `useResource`: one cached resource per
  query, refetched when the `workspace:` prefix is invalidated (pin, forget,
  scan), on focus and when the document becomes visible, never on a timer.
- **Source choice** (`model/workspaceSource.ts`, `useWorkspaceSource.ts`): the
  backend answer is the source of every list once it arrives. A 404/405/501
  (older backend) or a failed read falls back to the desktop host's own recent
  index and script list; with neither the list says it needs the desktop app
  or a backend that serves the workspace database. Dialogs, reading, running
  and revealing a script stay on the desktop host, which reaches its own
  record of an API script by path.
- **Inspectors by kind:** project (Overview, Authors, History, Runs), script
  (Overview with syntax, imports and environment reads; History with edit
  events before/after; Runs from run events and linked result folders; the
  Run in new window panel) and result folder (Overview, Stages, History; the
  source links to and selects the script or project). Header with star and
  more-menu, path with copy, chips, context banner, and the bottom action bar
  (primary action, open-options dropdown, open-externally button) follow the
  sketch.
- **Open results viewer** is enabled only where a saved-results viewer route
  exists: the Results module of an open project (`SavedResultsBrowser`). A
  folder linked to a project opens that project on Results; a folder written
  by a script, or with no source, shows the button disabled with the reason.
  The **download** button on the Runs tab is disabled ("Downloading results is
  not available yet"): there is no route for it.
- **Settings > Indexed locations:** list and edit the roots (absolute paths are
  typed in a browser; the desktop app also offers its native folder picker),
  save, **Scan now** with the report. **Add file by path…** in the list footer
  adds one existing path through `POST /v2/workspace/items`.
- **Evidence:** vitest for the parsers, adapters, hooks (mount, focus merge,
  refetch after actions, 404 fallback, unavailable), source selection and every
  inspector; `check:start-screen-browser` now renders the three real inspectors
  through Vite's SSR loader into the real stylesheets and asserts the sketch
  layout (364 px right column, preview, title row, tabs, sections, action bar)
  and WCAG AA of every text they draw in both themes. Not verified against a
  real backend serving the routes, and nothing ran in a packaged desktop app.
