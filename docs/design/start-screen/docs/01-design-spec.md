# Fullmag start screen — design specification

Status: proposal · Version 1.0 · 3 October 2026
Scope: the first screen shown when Fullmag opens with no active session.
Replaces: `apps/control-room/src/kernel/layout/EmptyWorkspace.tsx`

---

## 1. Why this screen is being redesigned

The current empty workspace is four buttons centred in a void:

> **Create a simulation** — Start with an empty FDM or FEM problem.
> `[Create simulation] [New project] [Open project] [Save project]`

It is correct and it is useless. It answers one question — *how do I make a new
thing* — and ignores every other question a person actually has when they open a
micromagnetic solver:

| What the user is thinking | What the current screen offers |
|---|---|
| "Where did I get to yesterday?" | nothing |
| "Which of my forty projects was the one with the DMI sweep?" | nothing |
| "Is this the YIG one or the Py one?" | nothing |
| "Will this run on this machine, or is the GPU busy?" | nothing |
| "Did Ania change the damping profile since I last looked?" | nothing |
| "What do I cite when I write this up?" | nothing |
| "What changed in 0.9.3?" | nothing |

In a professional simulation tool — COMSOL, Abaqus, Houdini, JetBrains IDEs,
Blender — the launcher is a **work surface**, not a splash screen. It is where
you re-enter yesterday's work, recognise a project by its result rather than its
file name, and confirm the machine can run what you are about to open. Opening
a file dialog is the fallback, not the main path.

### Design goals

1. **Resume beats create.** The most likely intent on launch is continuing, not
   starting. The interrupted run is the first thing on the page.
2. **Recognise by result, not by file name.** `sim_v3_final_FINAL.fms` tells you
   nothing; a thumbnail of the dispersion map tells you everything. Every project
   carries a rendered preview.
3. **Answer "can I run this?" before opening.** Grid size, interactions, solver,
   device and VRAM are visible without loading the project.
4. **Provenance is first-class.** Authors, ORCID, revision history and a BibTeX
   block belong in a research tool, not in an afterthought dialog.
5. **Never block the work.** A broken index, an offline network share or a
   missing GPU degrades the screen; it never prevents creating or opening a
   project.
6. **Build on what exists.** No new colour system, no new control geometry, no
   new primitives. The screen is assembled from `--fm-*` tokens, `shared/ui/*`
   and the existing command registry.

### Non-goals

- Replacing the workspace. Once a project opens, this screen unmounts.
- A project browser with folder trees. The recent list plus search plus
  `Browse…` covers it; a file manager is the OS's job.
- Cloud sync, accounts, or a project server. Everything here is local-first.

---

## 2. Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ● Fullmag                                                 ─  □  ✕        │  32px  title bar
├──────────────────────────────────────────────────────────────────────────┤
│ [▣] Fullmag   File Edit View Simulation Tools Help  [⌕ Command ⌘K]  ▶⏸⏹⏭ │  38px  --fm-menu-height
├────────────┬──────────────────────────────────┬──────────────────────────┤
│            │                                  │                          │
│   RAIL     │          CONTENT                 │        INSPECTOR         │
│   232px    │          fluid, max 1040         │        364px             │
│   fixed    │          scrolls                 │        resizable 320–520 │
│            │                                  │                          │
├────────────┴──────────────────────────────────┴──────────────────────────┤
│ ✓ Solver idle · 0.9.3-beta a1b2c3d · CUDA 12.4 RTX 4090 · 9 indexed  ⬇ 0.9.4│  26px --fm-status-height
└──────────────────────────────────────────────────────────────────────────┘
```

See `diagrams/01-window-zones.svg` for the annotated version and
`diagrams/03-layout-grid.svg` for the spacing derivation.

The title bar, menu bar and status bar are **unchanged** — the start screen
occupies the body row only, exactly where `WorkspaceShell` renders the dock
layout. This matters: the shell does not reconfigure itself between the start
screen and the workspace, so there is no flash of chrome on open.

### Responsive behaviour

| Width | Change |
|---|---|
| ≥ 1400 px | full row grid including the size column |
| < 1400 px | size column drops from the recent list |
| < 1180 px | inspector collapses; `Space` opens it as a right-hand sheet |
| < 940 px | rail becomes an icon rail (56 px), labels move to tooltips |
| < 720 px | not supported — the window has a 900 × 600 minimum |

---

## 3. Rail

Fixed 232 px, `--fm-bg-chrome`, right border `--fm-border-subtle`.

### 3.1 Identity block

Logo mark (30 px, `--fm-radius-md`), product name, version with channel badge.
Clicking it goes to **About**. The channel badge (`beta`, `rc`, `nightly`) is
omitted on a stable build — a release should not shout about being a release.

### 3.2 Navigation

| Item | Shortcut | Content |
|---|---|---|
| **Home** | `Ctrl 1` | Continue · Launch tiles · Recent projects |
| **Templates** | `Ctrl 2` | Gallery of ready-made studies, with a count badge |
| **Import** | `Ctrl 3` | Supported formats, drop target, import report |
| **Learn** | `Ctrl 4` | Release notes, keyboard map, docs, benchmarks |
| **Docs** | `F1` | The Sphinx documentation with its own search, offline (§6.6) |
| **Settings** | `Ctrl ,` | Start-screen-relevant preferences only |
| **About** | — | Build, runtime, team, citation, licences |

Active item: `--fm-bg-selected` background, `--fm-accent` text, 2 px accent bar
on the left edge. Shortcut hints appear on hover and on the active item, not
permanently — they are a reminder, not decoration.

### 3.3 Compute environment widget

Pinned to the bottom of the rail. This is the single highest-value element on
the screen for a simulation tool and no competitor puts it on the launcher.

```
COMPUTE ENVIRONMENT
● RTX 4090                CUDA 12.4
▬▬▬▬░░░░░░░░░░░░░░░░
VRAM              5.8 / 24.0 GB
⚙ CPU fallback      32 threads
        ⚙ Configure compute
```

| State | Dot | Copy |
|---|---|---|
| GPU ready | `--fm-success` | device name + CUDA version |
| GPU busy | `--fm-warning` | "in use by run r-0042" |
| No GPU | `--fm-degraded` | "No GPU detected"; CPU thread count remains visible |
| Driver mismatch | `--fm-danger` | "CUDA 12.4 required, 11.8 found" |

The VRAM meter is live. A user who sees 22 of 24 GB in use knows why their
512³ problem will not start, before they wait four minutes to find out.

Aktualny kontrakt odczytu hosta, szczegółów Settings i stanów niedostępnej
telemetrii opisuje [Compute environment](09-compute-environment.md).
Wykrycie GPU nie potwierdza gotowości solvera. Nie stosujemy stałego mnożnika
spowolnienia CPU ani domyślnego fallbacku; wybór urządzenia należy do study.

---

## 4. Content column — Home

Inner measure capped at 1040 px and centred, so the text column stays readable
on an ultrawide monitor while the rail and inspector stay pinned to the edges.

### 4.1 Page header

```
Welcome back, Mateusz                        Saturday, 3 October 2026
One run is paused and waiting. 9 projects are indexed on this machine.   AG Magnonics · RPTU
```

The greeting line is **stateful**, not decorative. It summarises what the page
is about to show: a paused run, a failed run that needs attention, nothing at
all. If there is nothing to say, the subline states the project count and stops.

The name comes from the OS user or the configured author identity. If neither is
known, the greeting is simply "Fullmag" and the subline carries the content.

### 4.2 Continue card

Rendered only when `recent-index.continue` is present.

```
┌───────────────────────────────────────────────────────────────┐
│ ┌──────────┐  YIG waveguide — spin-wave dispersion            │
│ │ thumbnail│  D:\sim\magnonics\yig-waveguide-dispersion.fms   │
│ │ 176×110  │  ● paused at t = 3.20 ns / 5.00 ns  ▬▬▬▬▬▬░░ 64% │
│ └──────────┘  ≈ 12 min · 256 / 400 frames                     │
│               [Resume run] [Open project] [Discard checkpoint] │
└───────────────────────────────────────────────────────────────┘
```

- **Resume run** — primary. Loads the checkpoint and continues at `t`.
- **Open project** — secondary. Opens without resuming, for when you want to
  change a parameter before continuing.
- **Discard checkpoint** — ghost. Asks for confirmation; deletes the checkpoint
  file, keeps the project.

When `resumable: false`, the primary button is removed and the reason replaces
the ETA line: *"Checkpoint was written by 0.9.1 and cannot be resumed by this
build."* Never show a button that will fail.

The card has a faint accent wash (`--fm-accent` at 7 %) from the top-left. It is
the only element on the page with that treatment, which is what makes it read as
"the thing to do" without a coloured border or a badge.

### 4.3 Launch tiles

Four equal tiles, `repeat(auto-fit, minmax(156px, 1fr))`.

| Tile | Glyph colour | Second line | Shortcut |
|---|---|---|---|
| **FDM simulation** | `--fm-solver-fdm` | Structured finite-difference grid. GPU-accelerated, best for large uniform geometries. | `Ctrl N` |
| **FEM simulation** | `--fm-solver-fem` | Unstructured tetrahedral mesh. Curved bodies, Bloch-periodic eigenmode studies. | `Ctrl ⇧ N` |
| **From template** | `--fm-chart-teal` | Benchmarks and ready-made studies — µMAG problems, dispersion, FMR, skyrmions. | `Ctrl T` |
| **Import** | `--fm-chart-peach` | Bring in an existing model from another micromagnetic package or a Fullmag archive. | `Ctrl I` |

The descriptions do real work. "FDM" and "FEM" mean nothing to a new group
member; "structured grid, GPU, large uniform geometries" tells them which to
pick. This is the one place in the product where that distinction can be
explained without a tooltip.

Tiles stay present in **every** state of the screen, including the error state.
Creating a new problem never depends on the recent index being readable.

### 4.4 Recent projects

#### Toolbar

```
RECENT PROJECTS      [⌕ Filter projects…  /] [All|FDM|FEM|★] [⇅ Last opened ▾] [▤|▥]
```

- **Filter** — matches name, path, tags and solver. Focused with `/`.
- **Segmented filter** — All / FDM / FEM / Pinned. Multi-select is deliberately
  not offered; it is a nine-item list, not a database.
- **Sort** — Last opened (default) · Name · Created · Size · Last run.
- **View** — list (default) or card grid.

#### Grouping

List view groups by recency: **Today · Yesterday · Earlier this week · Older**.
Group headers are sticky within the scroll container. Pinned projects are hoisted
into a **Pinned** group above Today.

#### Row

52 px, grid `72px | 1fr | 74px | 96px | 64px | 78px | 26px`:

| # | Column | Detail |
|---|---|---|
| 1 | thumbnail | 72 × 45, 16:10, viewport-dark in both themes |
| 2 | name + path | 13 px / 500, path 10 px mono, ellipsised **from the left** so the file name survives |
| 3 | solver badge | FDM blue, FEM mauve, always with the letters |
| 4 | status pill | dot + word; the dot pulses while running |
| 5 | size | total on disk — archive **plus** results. The `.fms` itself is capped at 64 MB by the host, so a GB-scale figure is results. |
| 6 | last opened | relative ("today 12:04", "2 Aug 2026") |
| 7 | pin | appears on hover, persists when pinned |

Anatomy and states: `diagrams/04-anatomy-project-row.svg`.

#### Card (grid view)

232 px wide, 132 px thumbnail, solver badge overlaid on the image, name over two
lines, status and date in the footer. The grid is for recognising a project by
its result; the list is for scanning metadata. Both are offered because both
tasks are real.

#### Footer

`[Browse…] [Clear list]` and a count: *"9 of 9 shown · index rebuilt 4 min ago"*.
The index freshness is stated because a stale index is the one failure mode a
user cannot otherwise detect.

#### Context menu (per row)

Open · Open a copy · Open read-only · — · Reveal in Explorer · Copy path ·
Copy project id · — · Rename · Duplicate · — · Pin · Remove from recent ·
Delete from disk… (confirm, destructive, red).

---

## 5. Inspector

364 px, resizable 320–520, bound to the selected row. This is what makes the
start screen better than a file dialog: you can answer "is this the right
project?" without opening it.

Anatomy: `diagrams/05-inspector-anatomy.svg`.

### 5.1 Preview

16:10, the last rendered result. On hover an overlay reveals a play button and a
frame scrubber, so a 400-frame run can be skimmed without opening the project.
Projects with no run show a generated geometry render; projects with neither
show a muted placeholder, never a broken image.

Thumbnails are stored inside the archive, which the host caps at 64 MB, so they
carry a size budget: target ≤ 200 kB, hard-fail above 1 MB.

The preview keeps `--fm-bg-viewport` as its background in **both** themes. A
render is data; re-tinting it for the light theme would misrepresent it.

### 5.2 Header

Name (15 px / 650), path in mono with a copy button, then a chip row:
solver badge · status pill · `rev 42` · `schema 1.2` · tags.

### 5.3 Context banner

Shown only when there is something to say. At most one at a time, in this
priority order:

| Condition | Tone | Copy |
|---|---|---|
| run in progress | warning | "Run in progress — 64 %. t = 3.20 ns of 5.00 ns on RTX 4090; ≈ 12 min remaining." |
| last run failed | danger | the run's `error` string, verbatim |
| schema migration needed | warning | "Archive schema 1.0 → 1.2. Opening migrates a copy; the original file is left untouched." + the step list |
| read-only | info | the `mode_reason` string |
| file missing | danger | "The file is no longer at this path." + `Locate…` / `Remove` |

Error strings come from the solver and are written for a physicist: cause first,
then the number, then the suggestion. *"Run r-0027 diverged at t = 0.41 ns —
|m| drift 4.2e-2 exceeded the 1e-3 tolerance. Likely cause: Δt too large for
α = 0.001."* Not *"Simulation failed. See log."*

### 5.4 Tabs

| Tab | The question it answers |
|---|---|
| **Overview** | *Is this the project I mean, and can this machine run it?* |
| **Authors** | *Whose work is this, and how do I credit it?* |
| **History** | *What changed since I last opened it?* |
| **Runs** | *What has actually been computed?* |

**Overview** is a key/value grid in three groups — Model, Execution, Outputs,
Provenance. Values are mono, labels are UI font; units are part of the value,
never a separate column. Interactions render as chips.

**Authors** lists creator and contributors with affiliation and ORCID, then a
generated BibTeX block with a copy button and a DOI link when one is registered.
For an academic group this is the difference between "I'll find the citation
later" and citing correctly.

**History** is a timeline of revisions. Marker colour by kind: edit = accent,
run = success, migrate = degraded, import = info. Each entry carries a one-line
summary and the specific changes beneath it — *"cell z 10 → 5 nm"*, not
*"updated the mesh"*. Restorable entries offer a restore action.

**Runs** is a table: run id (as a status pill), started, duration, output size.
Opens the results viewer. Empty state for a project that has a model but no run.

### 5.5 Action footer

Split primary button:

- **Open project** — with a chevron for *Open a copy*, *Open read-only*,
  *Open in a new window*.
- The label changes with state: **Migrate & open** when a migration is pending,
  **Open running project** when a run is in flight.
- Secondary icon button: reveal in the file manager.

### 5.6 Empty states

The inspector is never blank. Its copy is section-specific:

- Home, nothing selected — *"Select a project in the list to see its model, authors, history and runs."*
- Templates — *"Select a template to see its model, the expected runtime and the reference it reproduces."*
- Import — *"Choose a file and Fullmag reports what maps cleanly and what needs a decision before anything is written."*

---

## 6. Other sections

### 6.1 Templates

Card gallery. Each card: thumbnail, name, two-line description, solver badge,
and an estimate — *"~25 min · 6 GB VRAM"*. The estimate is calibrated against
the detected device, so the same card reads *"~6 h · CPU ×32"* on a machine
without a GPU. Opening copies the template into the default project location,
never into the install directory.

Shipped set: µMAG Standard Problems #1–#5, spin-wave dispersion, magnonic
crystal bands, skyrmion phase diagram, broadband FMR, domain-wall motion,
vortex gyration.

### 6.2 Import

| Source | Extension | Fidelity |
|---|---|---|
| OOMMF | `.mif` 1.1 / 2.0 | full — geometry, regions, `Oxs_` evolver; custom Tcl reported, not executed |
| mumax³ | `.mx3` | full — grid, regions, material parameters, run script; `ext_` flagged |
| COMSOL | `.mph` | partial — mesh and materials into an FEM problem; other physics skipped |
| Fullmag | `.fms` | full — including results and history; older schemas migrated |
| Mesh | `.stl` `.vtk` `.msh` | geometry only |
| Field | `.ovf` `.omf` `.npy` | initial state only |

Nothing is written until an **import report** is confirmed: what mapped, what
was approximated, what was dropped, and why. A silent lossy import is worse than
a refused one.

### 6.3 Learn

Release notes as a timeline (same component as the inspector's History),
the full keyboard map, and links to documentation, tutorials, µMAG benchmarks
and the issue tracker.

### 6.4 Settings

Only what the start screen owns — startup behaviour, project locations and
index, compute backend, appearance and density — with a link to the full
preferences dialog. A launcher that becomes a second settings UI has failed.

### 6.5 About

Overview and the two engines, the authors with their affiliations and the project
coordinator, a **Cite Fullmag** block (the citation sentence and BibTeX, with a
copy button), build (version, platform, profile, archive schema), licence
statement, funding, and **Copy diagnostics** — a one-click block to paste into a
bug report.

The project's own facts (overview, authors, affiliations, citation, BibTeX,
licence statement, funding) are taken from the repository `readme.md`, not
written for the screen; a test fails if the two disagree. Facts the page cannot
know (a commit hash, third-party licences, the runtime stack) are not shown and
not invented.

### 6.6 Documentation

The public Sphinx documentation, inside the app, with search, offline. The
section takes the full content width (no inspector): a query box that drives
Sphinx's own search page, a **Contents** button, **Open online** (which follows
the page being read) and the documentation in a frame. `F1` and Help → Search
Docs open it from anywhere, over an open workspace without closing it. Without a
bundle the section says so and links to the online site; nothing else changes.

The full contract (messages, theme sync, bundling, degradation) is
`05-sphinx-integration.md`.

---

## 7. States

Full matrix: `diagrams/07-screen-states.svg`.

| State | Trigger | Behaviour |
|---|---|---|
| **First run** | no index, no projects | Hero "Welcome to Fullmag", launch tiles full width, three suggested templates, compute environment banner. No Continue card, no list. |
| **Loading** | scan in progress | Greeting + "Scanning locations…", six staggered skeleton rows (24 ms step), launch tiles interactive, toolbar disabled but visible. Resolves in place — no layout jump. |
| **Loaded** | the normal case | Everything in §4. |
| **Empty filter** | query matches nothing | Inline empty state inside the Recent section; query stays visible; Continue and tiles unaffected. |
| **Index error** | `recent-index.json` unreadable | Danger banner with the parse error, `Rebuild index` / `Show file`; launch tiles stay; section empty state offers `Open project…`; status bar reads "index unavailable". |
| **Degraded compute** | no GPU | Environment widget amber, "CPU fallback — roughly 40× slower", template estimates switch to CPU, warning repeated before a run starts. |

**Invariant:** a failure of the recent index never blocks creating or opening a
project. The launch tiles are present in every state.

---

## 8. Interaction and keyboard

Full list: `docs/03-interaction-and-accessibility.md`.

| Action | Keys |
|---|---|
| Command search | `Ctrl K` |
| New FDM / FEM simulation | `Ctrl N` / `Ctrl ⇧ N` |
| Open project / quick switch | `Ctrl O` / `Ctrl ⇧ O` |
| Templates / Import | `Ctrl T` / `Ctrl I` |
| Focus the filter | `/` |
| Move in list / open / open a copy | `↑ ↓` / `Enter` / `Ctrl Enter` |
| Toggle the inspector | `Space` |
| Pin / remove from recent / rename | `Ctrl P` / `Del` / `F2` |
| Rail sections | `Ctrl 1–4` |
| Settings / docs / theme | `Ctrl ,` / `F1` / `Ctrl ⇧ T` |

Every one of these is registered as a command in the existing registry, so the
whole screen is reachable from `Ctrl K` and nothing is mouse-only.

---

## 9. Data

| Artefact | Owner | Schema |
|---|---|---|
| `recent-index.json` | Tauri host | `schema/recent-index.schema.json` |
| `.fms` manifest | project archive | `schema/project-manifest.schema.json` |

The index is **derived state**: every field is rebuildable by rescanning the
configured locations. The renderer treats `summary` as a hint and re-reads the
manifest on open. This is what lets a corrupt index be thrown away rather than
repaired.

Gaps against today's API (`ProjectDocumentResource`) are listed in
`docs/02-implementation-guide.md` §4 — chiefly: a host-side scan and index, a
thumbnail pipeline, and `authors` / `history` / `runs` in the manifest.

---

## 10. Visual rules

1. **No new hues.** Every semantic token maps onto an existing palette token
   (`diagrams/08-colour-mapping.svg`). A palette change in `theme.css`
   propagates here for free.
2. **Mark colour and label colour are separate tokens.** The dot, the badge
   border and the badge fill keep the palette hue, where a 3:1 non-text
   threshold applies. The word beside the dot is a `-text` variant measured to
   ≥ 4.5:1 against the worst background on the screen. Catppuccin is an accent
   palette, not a text palette: as 11–12 px text its Latte status hues measure
   2.1–3.7:1, and Mocha's `--fm-text-muted` reaches 2.13:1 behind a `kbd`.
   `docs/03-interaction-and-accessibility.md` §4 has the measurements; the
   audit reports zero AA failures across all 18 theme × state × section
   combinations.
3. **Colour is never the only carrier.** Every status pill pairs its dot with a
   word; every solver badge prints the letters. Selection is background plus
   border, not hue.
4. **Thumbnails keep the viewport background in both themes.** A render is data.
   Anything overlaid on one — the solver badge on a grid card — keeps the dark-
   theme colours for the same reason.
5. **One accent wash on the page**, on the Continue card. Everything else earns
   attention through position and type, not colour.
6. **Density matches the workspace.** 13 px base, 26/30 px controls, 4 px scale.
   The start screen must not feel like a different application from the solver.
7. **Motion is functional.** 120 ms hover, 180 ms panel, 24 ms list stagger;
   everything disabled under `prefers-reduced-motion`.

---

## 11. Open decisions

These need a call from the team before implementation:

1. **Index location** — per-user app data (proposed) or a dotfile beside the
   project roots, which would make it shareable on a group NAS.
2. **Thumbnail generation cost** — rendering a preview after every run adds a
   few hundred ms. Proposed default: on, with a setting. Alternative: generate
   lazily when the start screen first needs it.
3. **Network shares** — scan them on launch (slow, accurate) or only on demand
   (fast, stale). Proposed: scan local roots on launch, network roots in the
   background with a visible "scanning" state.
4. **`Delete from disk`** — offer it at all? It is the only destructive action
   on the screen. Proposed: yes, with a typed confirmation, because the
   alternative is users deleting project folders in Explorer and leaving orphan
   index entries.
5. **Author identity** — read from git config, from a Fullmag setting, or from
   the OS user? Affects what lands in `authors[]` on project creation.

---

## 12. Files in this folder

```
mockups/start-screen.html        interactive mockup — open in a browser
mockups/assets/screens/*.png     rendered states, both themes
diagrams/*.svg                   the schematics referenced above
tokens/start-screen.tokens.css   additive token layer
schema/*.schema.json             data contracts + validated examples
components/*.tsx                 reference implementation (React 19 + Tailwind v4)
docs/02-implementation-guide.md  file map, component tree, host API gaps
docs/03-interaction-and-accessibility.md  keyboard, focus, ARIA, i18n
docs/05-sphinx-integration.md   documentation inside the app: contract, search, bundling
docs/06-implementation-status.md  what is built, how it was verified, what is left
```
