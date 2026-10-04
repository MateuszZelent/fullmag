# Implementation prompt — Fullmag start screen

Hand this file to the implementing agent (Claude Code, Codex, a contributor) as
the task brief. It is written to be executed without re-deriving anything.

- **Version 2** — 2026-10-03, revised after reading the Rust host and the
  `fullmag-application` crate. §12 lists what changed and why; three claims in
  v1 were wrong and one number in the design package was wrong.
- Repo facts verified against the working tree at `C:\git\fullmag\fullmag`.

---

## 0. The prompt

> You are implementing the Fullmag start screen in `apps/control-room`.
>
> The complete design already exists in `docs/design/start-screen/`. Read it
> before writing code. Your job is to land it in the app, not to redesign it.
> If something in the design cannot be implemented as specified, stop and say so
> in the PR description rather than silently substituting your own solution.
>
> Work one step at a time, from §5. Each step is independently shippable and has
> its own definition of done and its own verification command. Do not start a
> step before the previous one passes its gates. Open one PR per step.
>
> Non-negotiable constraints are in §4. Three of them are the whole point of the
> exercise, so re-read them before every commit: **no new palette hues**, **no
> new control geometry**, **nothing blocks creating or opening a project**.
>
> Before touching the Rust side, read §2.4. More already exists than the design
> documents assume, and two of the ten steps are cheaper than they look.

---

## 1. Goal

Replace `apps/control-room/src/kernel/layout/EmptyWorkspace.tsx` — four buttons
centred in a void — with a launcher that answers the questions a person actually
has when they open a micromagnetic solver:

1. Where did I get to yesterday? → **Continue card**, first on the page.
2. Which of my projects was the one with the DMI sweep? → **thumbnails**.
3. Will this run on this machine? → **compute widget** + model summary in the
   inspector, before anything is opened.
4. What changed, and who changed it? → **History** and **Authors** tabs.
5. What do I cite? → generated **BibTeX**.

Success: a user who launches with a paused run reaches it in one click, and a
user with forty projects finds the right one without a file dialog.

---

## 2. Verified repo facts

Do not re-derive these. Do confirm they still hold.

### 2.1 Stack
- Next.js 16.2.11, React 19.2.4, TypeScript 5.8.3, Tailwind **v4**
- Radix + shadcn conventions (`components.json`, style `new-york`, `cssVariables: true`)
- `lucide-react`, `cmdk`, `class-variance-authority`, `clsx`, `tailwind-merge`
- `@tanstack/react-virtual` — already a dependency, use it for the list
- `react-resizable-panels` — already a dependency, use it for the inspector splitter
- Storybook 10 + `@storybook/addon-a11y`, Vitest 4, Playwright 1.6x

### 2.2 Path aliases (`components.json`)
```
@/shared/ui     → src/shared/ui       @/shared/utils → src/shared/utils  (cn: utils/className)
@/shared/hooks  → src/shared/hooks    @/design/...   → src/design/...
```

### 2.3 Where the screen is mounted
`src/kernel/layout/WorkspaceShellClient.tsx` renders `<EmptyWorkspace />` in
**two** places — easy to miss:

1. the `sessionState === "no-session"` branch, and
2. inside `SessionCollectionError`, below the session-error banner.

Both must render `<StartScreen />`. In case 2 it sits under a banner, so it must
not assume it owns the full height.

### 2.4 The Rust host — read this before planning any backend work

**Tauri commands that exist today** (`apps/desktop/src-tauri/src/commands.rs`,
registered in `main.rs`). There are exactly seven:

| Command | Returns | What it gives the start screen |
|---|---|---|
| `open_project_path(path)` | `ProjectOpenSummary` | **Opening a recent entry needs no new host API.** |
| `open_project_dialog()` | `Option<ProjectOpenSummary>` | `Browse…` is free |
| `open_project_archive_dialog()` | archive bytes | — |
| `save_project_archive(...)` | `ProjectSaveSummary` | — |
| `reveal_in_file_manager(path)` | `()` | **Reveal button and context menu are free.** |
| `open_file_dialog()` | `Option<PickedTextFile>` | import picker |
| `get_app_config()` | `{ api_base, ui_url, launch_intent }` | **does not hold project locations** — scanned locations need new storage |

```rust
pub struct ProjectOpenSummary {
    pub path: String,            pub project_id: String,
    pub schema_version: String,  pub revision: u64,
    pub dirty: bool,             pub mode: String,
    pub read_only_reason: Option<String>,
    pub source_hash: Option<String>,
    pub migrated: bool,          pub can_write: bool,
    pub warnings: Vec<String>,   pub preserved_paths: Vec<String>,
    pub runtime: String,
}
```

**The application/repository boundary** (`crates/fullmag-application/src/`),
shared with the CLI. New host work belongs here, not ad hoc in `commands.rs` —
`commands.rs` says so in a comment and routes everything through it.

```rust
ProjectApplication::new(FileProjectRepository::new()).open(ProjectSource::Path(p))

pub struct ProjectDefinition {           // project.rs
    pub project_id: ProjectId, pub schema_version: String,
    pub name: String, pub revision: DefinitionRevision,
    pub scene: RawJsonEnvelope,          // opaque JSON
}
pub struct ProjectEnvelope {
    pub definition: ProjectDefinition,   pub raw_definition: RawJsonEnvelope,
    pub source: Option<OpaqueDocument>,
    pub assets: Vec<OpaqueAsset>,        // has media_type — thumbnails live here
    pub opaque_documents: Vec<OpaqueDocument>,   // preserved across migrations
}
pub struct MigrationReport {
    pub source_schema: String, pub target_schema: String,
    pub migrated: bool, pub can_write: bool,
    pub warnings: Vec<String>, pub preserved_paths: Vec<String>,
}
```

Three consequences, each of which removes work:

- **The migration and read-only banners need zero new host API.**
  `MigrationReport` → `ProjectOpenSummary` already carries `schema_version`,
  `migrated`, `can_write`, `mode`, `read_only_reason`, `warnings`.
- **Thumbnails are a convention over an existing mechanism.** `OpaqueAsset` has
  `media_type` and is preserved across migrations. Store `preview/thumb.png` as
  an asset; do not invent a new archive concept.
- **Authors / history / runs should ride in `opaque_documents`, not in
  `ProjectDefinition`.** Opaque documents survive migration (`preserved_paths`)
  and need no `schema_version` bump, so older builds keep opening the file.
  Before adding anything, check whether metadata already lives inside `scene`
  (it is `RawJsonEnvelope`, so this is not visible from the type).

**Hard limit:** `MAX_PROJECT_ARCHIVE_BYTES = 64 * 1024 * 1024` in `commands.rs`.
The `.fms` holds the definition plus small assets. Results do **not** live in
it. See §4 for what this means for the design, which got it wrong.

### 2.5 Existing frontend commands (keep ids and contracts)
| id | used by |
|---|---|
| `workspace.new-problem` | FDM / FEM launch tiles |
| `workspace.new-project` | behind the launch tiles |
| `workspace.open-project` | `Browse…`, row activation, inspector footer |
| `workspace.save-project` | **remove from this screen** — meaningless with no session |
| `workspace.theme-toggle` | shortcut is `Ctrl+Shift+T`, not `Ctrl+Shift+L` |

`CommandContribution` (`src/kernel/commands/commandTypes.ts`):
`{ id, title, category, group, scope, shortcut?, isEnabled?, disabledReason?, run }`,
appended to `SHELL_COMMANDS` in `src/kernel/layout/shellCommands.ts`. Context
from `createCommandContext("menu", kernel, { sourceDetail })`.

### 2.6 Design system
- `src/design/styles/tokens.css` — non-colour tokens
- `src/design/styles/theme.css` — Catppuccin Mocha (`:root`, `[data-theme="dark"]`) / Latte (`[data-theme="light"]`)
- `src/design/styles/tailwind-theme.css` — the `@theme inline` bridge
- `app/globals.css` imports through cascade layers:
  `fm-tokens` → `fm-base` → `fm-primitives` → `fm-components` → `fm-modules`

---

## 3. Read first

1. `docs/design/start-screen/docs/01-design-spec.md`
2. `docs/design/start-screen/docs/02-implementation-guide.md`
3. `docs/design/start-screen/docs/03-interaction-and-accessibility.md`
4. `docs/design/start-screen/mockups/start-screen.html` — open in a browser
5. `docs/design/start-screen/components/*` — written to be moved, not adapted
6. `docs/design/start-screen/schema/*.schema.json`

Then in the app: `EmptyWorkspace.tsx`, `WorkspaceShellClient.tsx`,
`shellCommands.ts`, `shared/ui/Button.tsx`, `shared/ui/controlVariants.ts`,
`design/styles/{tokens,theme,tailwind-theme}.css`, `app/globals.css`,
`apps/desktop/src-tauri/src/commands.rs`, `crates/fullmag-application/src/project.rs`.

---

## 4. Hard constraints

**Must not change**
- `theme.css`, `tokens.css` — the start screen adds a token layer, it does not
  edit the palette.
- The window chrome. Title bar, menu bar (`SlotHost slotId="app-menu"`) and
  status bar stay as they are; the start screen occupies the body row only, so
  there is no flash of chrome when a project opens.
- Ids, enablement contracts or signatures of existing `workspace.*` commands.
- The `commands.rs` → `fullmag-application` boundary. New host capability is a
  method on the application layer with a thin Tauri wrapper, so the CLI gets it
  too.

**Must hold**
- **No new palette hues.** Every semantic token maps onto an existing one. The
  only new values permitted are the measured contrast-safe `-text` variants in
  `tokens/start-screen.tokens.css`, each keeping its source hue.
- **No new control geometry.** Heights from `--fm-control-height-*`, spacing
  from `--fm-space-*`, radii from `--fm-radius-*`. A measurement outside the
  token scale is a bug.
- **Nothing blocks the work.** A corrupt index, an offline share, a missing GPU
  or an absent host command degrades the screen. The four launch tiles are
  present and functional in **every** state, including the index-error state.
  There is a Playwright test for this; do not weaken it.
- **Colour is never the only carrier.** Status = dot + word, solver badge prints
  `FDM`/`FEM`, selection is background + border.
- **Keyboard parity.** Everything reachable by mouse is reachable by keyboard
  and registered as a command, so it also appears in `Ctrl K`.
- **No new runtime dependency** without justifying it in the PR.

**Design correction — size figures**

The mockup shows projects of 1.42 GB and 3.10 GB. With a 64 MB archive cap that
is impossible for a `.fms`, so when you implement:

- the recent list's **size** column = archive bytes **+ results directory**,
  computed by the scanner, labelled as total on disk;
- `summary.output_bytes` = **results directory only**;
- the thumbnail has a size budget — target ≤ 200 kB, hard-fail above 1 MB — or
  it eats the archive cap for a project with many assets.

The mockup's numbers are illustrative. Do not treat them as a contract, and do
not reproduce them as the archive size.

**Style**
- `"use client"` on anything stateful; section bodies are client components, the
  route stays a server component.
- `cva` for variants, `cn()` for merging, `readonly` props, named exports.
- Comments explain *why*, never *what*.

---

## 5. Steps

One PR per step. `pnpm control-room:lint`, `:typecheck` and `:test` are the
baseline gate for every step and are not repeated below.

**Status at the time of writing: nothing is implemented.** `src/modules/start/`
does not exist, no start-screen CSS is present, `EmptyWorkspace.tsx` is still in
place and referenced from both call sites. Step 1 is the next action.

### Step 1 — Shell, rail, launch tiles  *(no new host API)*

**Scope**
- `src/design/styles/start-screen.tokens.css` ← copy of
  `docs/design/start-screen/tokens/start-screen.tokens.css`
- `app/globals.css`: add
  `@import "../src/design/styles/start-screen.tokens.css" layer(fm-tokens);`
  **after** `theme.css`, before `base.css`.
- `src/design/styles/tailwind-theme.css`: append the bridge block commented at
  the bottom of the token file to the existing `@theme inline`. Until this is
  done the new utilities are inert and badges render in the inherited colour —
  visible but wrong, so do it in the same commit.
- `src/design/styles/start-screen.css` — component CSS, imported from
  `design/styles/components/index.css` (already in `layer(fm-modules)`). Needs
  at minimum the `fm-pulse` keyframes used by `StatusPill`.
- New module `src/modules/start/` per `02-implementation-guide.md` §2:
  `StartScreen.tsx`, `rail/StartRail.tsx`, `rail/ComputeEnvironmentWidget.tsx`
  (static placeholder state), `home/LaunchTiles.tsx`, `ui/SolverBadge.tsx`,
  `ui/StatusPill.tsx`, `ui/SectionHeader.tsx`, `model/startScreenState.ts`,
  `model/startCommands.ts`.
- `WorkspaceShellClient.tsx`: replace **both** `<EmptyWorkspace />` usages.
- Delete `EmptyWorkspace.tsx`; update `WorkspaceNewProblemEntry.test.tsx` and
  `WorkspaceShellClient.test.tsx`, which assert on its copy.
- Register in `shellCommands.ts`: `start.section.home`, `start.section.templates`,
  `start.section.import`, `start.section.learn`, `start.new-fdm`, `start.new-fem`,
  `start.browse`. Shortcuts per `03-interaction-and-accessibility.md` §1.
  `start.new-fdm`/`start.new-fem` delegate to `workspace.new-problem`;
  `start.browse` delegates to `workspace.open-project`.

**Not in scope:** recent list, inspector content, thumbnails, Continue card.
The inspector renders its section-specific empty state; non-Home sections render
a titled placeholder.

**Done when**
- Launching with no session shows rail + content + inspector inside unchanged
  chrome; Home shows the greeting and four tiles.
- All four tiles work. `Ctrl N`, `Ctrl ⇧ N`, `Ctrl O`, `Ctrl 1–4` work.
- Every new action appears in `Ctrl K`.
- Both themes render; `Ctrl+Shift+T` does not reflow the layout.
- `SessionCollectionError` still shows its banner, start screen below it.
- `grep -nE '[0-9]+px' src/modules/start` returns only token-scale values.

**Verify**
```bash
pnpm control-room:dev     # compare against mockups/assets/screens/*-home.png
node docs/design/start-screen/scripts/audit_contrast.mjs   # TOTAL below WCAG AA: 0
```

### Step 2 — Recent index  *(needs §6.1 only)*
List, search, filter, sort, grouping, virtualisation above 40 rows. Opening a
row calls the existing `open_project_path` — no new command for that.
Port `components/recentIndex.ts` as-is and write its vitest cases **first**:
local midnight, a DST change, a future timestamp, pinned hoisting, a truncated
index. Those are invisible in a screenshot and easy to break.
**Done when:** the list renders real projects, the index-error state shows a
working `Rebuild index`, and the launch tiles still work in that state.

### Step 3 — Inspector: Overview and banners  *(needs §6.3 only for `summary`)*
Header, chips, `ContextBanner` (port `selectBanner` with its unit tests — the
priority order is the contract), Overview tab.

The **migration**, **read-only** and **warnings** banners need no new host API:
map them from `ProjectOpenSummary` (`migrated`, `can_write`, `mode`,
`read_only_reason`, `schema_version`, `warnings`). Only the model summary needs
new data, and it can start as "unavailable" per field without blocking the step.
**Done when:** selecting a row populates the inspector without opening the
project, and opening a 1.0-schema project shows a correct migration banner.

### Step 4 — Thumbnails  *(needs §6.2)*
Row previews, card grid, inspector preview with frame scrubber. Bounded LRU of
~60 decoded images, `loading="lazy"` on rows, eager in the inspector. Respect
the size budget in §4.
**Done when:** a project is recognisable by its result at 72 × 45.

### Step 5 — Provenance  *(needs §6.3)*
Authors, History, Runs tabs. BibTeX from `authors` + name + revision, overridable
by `citation.preferred_bibtex`.
**Done when:** a project made before 0.9.3 shows "no history recorded before
Fullmag 0.9.3" rather than an empty tab.

### Step 6 — Continue card  *(needs §6.4)*
**Done when:** `resumable: false` removes the Resume button and shows the reason
in its place. Never render a button that will fail.

### Step 7 — Compute environment  *(needs §6.5)*
Live GPU / CUDA / VRAM, CPU fallback warning, 5 s poll cleared on unmount.
**Done when:** with no GPU the widget is amber, says "CPU fallback — roughly 40×
slower", and template runtime estimates switch to CPU figures.

### Step 8 — Templates gallery
µMAG SP#1–#5, dispersion, magnonic crystal bands, skyrmion phase diagram,
broadband FMR, domain-wall motion, vortex gyration. Opening copies the template
into the default project location, never into the install directory.

### Step 9 — Import  *(needs §6.6)*
`.fms` and `.mx3` first. Nothing is written until an import report is confirmed.
Unsupported formats are listed as such and rejected with a reason.

### Step 10 — Learn, Settings, About
Release-notes timeline (same component as History), keyboard map, start-screen
settings with a link to full preferences, build/runtime/team/citation and
**Copy diagnostics**. `get_app_config().launch_intent` already exists and is
where the "open the start screen on launch" setting should hook in.

### Step 11 — Sphinx documentation  *(see `05-sphinx-integration.md`)*
A **Docs** section (rail item, `F1`, Help → Search Docs) showing the bundled
Sphinx site with Sphinx's own search, offline. `apps/control-room/scripts/bundle-docs.mjs`
copies the built site into `public/docs/`; `public_docs/site/_static/fullmag-embed.js`
keeps the theme in step and reports navigation. Without a bundle the section says
so and links online. **Done when:** a query returns Sphinx results in the frame,
the theme follows the app both ways, and a build without `public/docs/` shows the
unavailable state without affecting anything else.

### Promote to `shared/ui/` once Step 5 lands
`StatusPill`, `KeyValueGrid`, `Timeline` — the physics inspectors hand-roll all
three today.

---

## 6. Host API to add

Schemas: `docs/design/start-screen/schema/*.schema.json`. Everything below is a
method on `fullmag-application` with a thin Tauri wrapper, so the CLI gets it too.

**6.1 Recent index** — the only hard blocker for Step 2.
```rust
recent_index_read()    -> RecentIndex
recent_index_rebuild() -> RecentIndex        // cancellable, streaming
recent_index_forget(project_id: String)
recent_index_pin(project_id: String, pinned: bool)
```
Walk the configured roots for `*.fms`; read each manifest head through
`ProjectApplication::open` (or a lighter read that stops after
`ProjectDefinition`) — it already yields `project_id`, `schema_version`,
`revision`, `name`, `migrated`, `can_write`. Size = archive + results directory
(§4). Write **atomically**: temp file plus rename. `ProjectSaveSummary` already
tracks `data_file_synced` / `parent_directory_synced` / `power_loss_qualified`
— follow that existing pattern rather than inventing one. A crash mid-write
must not produce the truncated file the error state is designed around. Rebuild
streams, so the UI fills skeleton rows as entries arrive.

Scanned locations need new storage: `AppConfig` is `{ api_base, ui_url,
launch_intent }` and does not hold them.

**6.2 Thumbnails** — render a 16:10 PNG from the last result frame after a run.
Store as an `OpaqueAsset` at `preview/thumb.png` with `media_type: image/png`;
cache a copy beside the index. Record `preview.colouring` (`hsl-sphere`,
`mz-diverging`, …) so a thumbnail is never read under the wrong mapping — this
matters for the HSL-sphere maps. Respect the §4 size budget.

**6.3 Project metadata** — `authors[]`, `citation`, `history[]`, `runs[]`,
`preview`, `summary`. Prefer a preserved entry in `opaque_documents` over
extending `ProjectDefinition`: no schema bump, older builds keep opening the
file, and `MigrationReport.preserved_paths` already guarantees survival.
**First check whether any of this already lives in `scene`** — it is a
`RawJsonEnvelope`, so the type does not tell you. `history` and `runs` are
append-only. A 1.0/1.1 project gets empty collections and synthetic stamps from
the file metadata.

**6.4 Checkpoints** — `runs[].checkpoint` plus a resume command. `resumable` is
computed on the current machine (build version, device availability), never
copied from the file.

**6.5 Compute probe**
```rust
compute_probe() -> { gpus: [{ name, cuda_version, vram_total, vram_free, busy_with_run }],
                     cpu_threads, preferred_backend, warnings: [String] }
```

**6.6 Importers** — `.fms` and `.mx3` first; `.mif`, `.mph`, mesh and field
formats after.

---

## 7. Gates

| Gate | Command | Threshold |
|---|---|---|
| Types | `pnpm control-room:typecheck` | clean |
| Lint | `pnpm control-room:lint` | clean |
| Unit | `pnpm control-room:test` | clean; `recentIndex` and `selectBanner` covered |
| Contrast | `node docs/design/start-screen/scripts/audit_contrast.mjs` | `TOTAL below WCAG AA: 0` |
| a11y | Storybook + `addon-a11y` on `ProjectRow`, `ContextBanner`, `ComputeEnvironmentWidget` | no violations |
| E2E | Playwright: launch → start screen → open project → workspace; first-run, loading, index-error; a keyboard-only path end to end | green |
| Visual | 1680 and 1180 px, both themes, against `mockups/assets/screens/` | no unexplained diff |

The contrast gate is not optional. The design ships at 0 failures across 18
theme × state × section combinations; a regression there is a regression.

---

## 8. When you are blocked

Five decisions are **not** yours. If a step needs one, implement the proposed
answer behind a setting, note it in the PR, and move on:

| # | Decision | Proposed |
|---|---|---|
| 1 | Index location | per-user app data; alternative is a dotfile beside the project roots so a group NAS can share it |
| 2 | Thumbnail cost | generate after every run (a few hundred ms), with a setting to disable |
| 3 | Network shares | local roots on launch, network roots in the background with a visible scanning state |
| 4 | `Delete from disk` | offer it, with a typed confirmation |
| 5 | Author identity | git config, falling back to the OS user, overridable in settings |

Anything else that contradicts the design: stop and ask. Do not substitute.

---

## 9. PR conventions

One PR per step. Title: `start-screen: step N — <scope>`. Body must contain:

- what landed, in one paragraph
- before/after screenshots, **both themes**
- gate output, including the contrast total
- anything from §4 you could not hold, and why
- any of §8 you hit, and which proposed answer you implemented

Attribution lines per the repo's `AGENTS.md`.

---

## 12. Changelog

**v2 — 2026-10-03.** Revised after reading `apps/desktop/src-tauri/src/` and
`crates/fullmag-application/src/`. Four corrections, three of which make the
work smaller:

1. **`open_project_path` and `reveal_in_file_manager` already exist.** v1
   implied opening a recent entry and revealing it needed new host work. They
   do not. Step 2's only blocker is the index itself.
2. **The migration and read-only banners need no new host API.**
   `MigrationReport` → `ProjectOpenSummary` already carries `migrated`,
   `can_write`, `mode`, `read_only_reason`, `schema_version`, `warnings`. v1
   put these behind §6.3; Step 3 is correspondingly cheaper.
3. **Metadata should ride in `opaque_documents`, and thumbnails in `assets`.**
   v1 said "add fields to the manifest", which would mean a `schema_version`
   bump and would break older builds. Both mechanisms already exist and are
   preserved across migrations.
4. **`MAX_PROJECT_ARCHIVE_BYTES = 64 MB` contradicts the mockup's GB-scale
   sizes.** The design package's 1.42 GB / 3.10 GB figures are illustrative of
   *total on disk*, not of the archive. §4 now states how size must be computed
   and adds a thumbnail size budget. This is an error in the design package,
   not in the implementation.

Also added: the `commands.rs` → `fullmag-application` boundary as a hard
constraint, `get_app_config().launch_intent` as the hook for the launch
setting, and the existing atomic-write pattern in `ProjectSaveSummary` as the
model for the index write.

**v3 — 2026-10-04.** Added Step 11 (Sphinx documentation) and
`05-sphinx-integration.md`; added `06-implementation-status.md`, which records
what was built, the evidence, and the gaps. About now takes the project's facts
from the repository README.
