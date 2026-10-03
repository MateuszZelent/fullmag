# Implementation prompt — Fullmag start screen

Hand this file to the implementing agent (Claude Code, Codex, a contributor)
as the task brief. It is written to be executed without re-deriving anything:
the repo facts below were verified against the working tree on 2026-10-03.

---

## 0. The prompt

> You are implementing the Fullmag start screen in `apps/control-room`.
>
> The complete design already exists in `docs/design/start-screen/`. Read it
> before writing code. Your job is to land it in the app, not to redesign it.
> If something in the design cannot be implemented as specified, stop and say
> so in the PR description rather than silently substituting your own solution.
>
> Work one step at a time, from §5. Each step is independently shippable and has
> its own definition of done and its own verification command. Do not start a
> step before the previous one passes its gates. Open one PR per step.
>
> Non-negotiable constraints are in §4. Three of them are the whole point of the
> exercise, so re-read them before every commit:
> **no new palette hues**, **no new control geometry**, **nothing blocks
> creating or opening a project**.

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

Success is measured by: a user who launches Fullmag with a paused run reaches
that run in one click, and a user who launches it with forty projects finds the
right one without opening a file dialog.

---

## 2. Verified repo facts

Do not re-derive these. Do verify they still hold before relying on them.

### Stack
- Next.js 16.2.11, React 19.2.4, TypeScript 5.8.3, Tailwind **v4** (`@tailwindcss/postcss`)
- Radix primitives + shadcn conventions (`components.json`, style `new-york`, `cssVariables: true`)
- `lucide-react` icons, `cmdk` command palette, `class-variance-authority`, `clsx`, `tailwind-merge`
- `@tanstack/react-virtual` (already a dependency — use it for the list)
- `react-resizable-panels` (already a dependency — use it for the inspector splitter)
- Storybook 10 + `@storybook/addon-a11y`, Vitest 4, Playwright 1.6x

### Path aliases (`components.json`)
```
@/shared/ui      → src/shared/ui
@/shared/utils   → src/shared/utils     (cn lives in src/shared/utils/className)
@/shared/hooks   → src/shared/hooks
@/design/...     → src/design/...
```

### Where the screen is mounted
`src/kernel/layout/WorkspaceShellClient.tsx` renders `<EmptyWorkspace />` in
**two** places — this is easy to miss:

1. the `sessionState === "no-session"` branch, and
2. inside `SessionCollectionError`, below the error banner.

Both must render the new `<StartScreen />`. In case 2 the start screen is shown
underneath a session-error banner, so it must not assume it owns the full height.

### Existing commands (keep their ids and contracts)
| id | used by |
|---|---|
| `workspace.new-problem` | FDM / FEM launch tiles |
| `workspace.new-project` | behind the launch tiles |
| `workspace.open-project` | `Browse…`, row activation, inspector footer |
| `workspace.save-project` | **remove from this screen** — meaningless with no session |
| `workspace.theme-toggle` | shortcut is `Ctrl+Shift+T`, not `Ctrl+Shift+L` |

`CommandContribution` shape (`src/kernel/commands/commandTypes.ts`):
```ts
{ id, title, category, group, scope, shortcut?, isEnabled?, disabledReason?, run }
```
Registered by appending to `SHELL_COMMANDS` in `src/kernel/layout/shellCommands.ts`.
Context is built with `createCommandContext("menu", kernel, { sourceDetail })`
from `src/kernel/commands/commandContext.ts`.

### Design system
- `src/design/styles/tokens.css` — non-colour tokens (`--fm-space-*`, `--fm-radius-*`, `--fm-font-size-*`, `--fm-duration-*`, z-index scale)
- `src/design/styles/theme.css` — Catppuccin **Mocha** (`:root`, `[data-theme="dark"]`) and **Latte** (`[data-theme="light"]`)
- `src/design/styles/tailwind-theme.css` — the `@theme inline` bridge that turns `--fm-*` into Tailwind utilities (`bg-fm-panel`, `text-fm-primary`, `rounded-fm-control`, `h-fm-control-sm`, `text-fm-xs`, `font-fm-mono`, …)
- `app/globals.css` imports everything through **cascade layers**:
  `fm-tokens` → `fm-base` → `fm-primitives` → `fm-components` → `fm-modules`

### Project document API (`src/kernel/persistence/ProjectDocumentController.ts`)
Projects are `.fms` archives. `ProjectDocumentResource` carries
`project_id`, `revision`, `persisted_revision`, `schema_version`, `source_hash`,
`dirty`, `mode: { kind: "read_write" | "read_only", reason? }`, `migration`,
`durability`, `archive_base64`. There is **no** recent-project index, no
thumbnail pipeline, no `authors` / `history` / `runs` in the manifest. Adding
them is §6.

---

## 3. Read first

In this order, before writing any code:

1. `docs/design/start-screen/docs/01-design-spec.md` — the design
2. `docs/design/start-screen/docs/02-implementation-guide.md` — file map, host gaps, sequence
3. `docs/design/start-screen/docs/03-interaction-and-accessibility.md` — keyboard, focus, ARIA, contrast
4. `docs/design/start-screen/mockups/start-screen.html` — open it in a browser; it is the visual reference
5. `docs/design/start-screen/components/*` — reference implementation, written to be moved not adapted
6. `docs/design/start-screen/schema/*.schema.json` — the data contracts

Then, in the app: `EmptyWorkspace.tsx`, `WorkspaceShellClient.tsx`,
`shellCommands.ts`, `shared/ui/Button.tsx`, `shared/ui/controlVariants.ts`,
`design/styles/{tokens,theme,tailwind-theme}.css`, `app/globals.css`.

---

## 4. Hard constraints

**Must not change**
- `src/design/styles/theme.css` and `tokens.css` — the start screen adds a token
  layer, it does not edit the palette.
- The window chrome. Title bar, menu bar (`SlotHost slotId="app-menu"`) and
  status bar stay exactly as they are. The start screen occupies the body row
  only, so there is no flash of chrome when a project opens.
- The ids, enablement contracts or signatures of existing `workspace.*` commands.

**Must hold**
- **No new palette hues.** Every semantic token maps onto an existing one. The
  only new values permitted are the measured contrast-safe `-text` variants
  already specified in `tokens/start-screen.tokens.css`, and each one must keep
  its source hue.
- **No new control geometry.** Heights come from `--fm-control-height-*`,
  spacing from `--fm-space-*`, radii from `--fm-radius-*`. If a measurement is
  not in the token scale, it is wrong.
- **Nothing blocks the work.** A corrupt index, an offline share, a missing GPU
  or an absent host command degrades the screen. The four launch tiles are
  present and functional in **every** state, including the index-error state.
  There is a Playwright test for this; do not weaken it.
- **Colour is never the only carrier.** Every status pill is dot + word, every
  solver badge prints `FDM` / `FEM`, selection is background + border.
- **Keyboard parity.** Every action reachable by mouse is reachable by keyboard
  and registered as a command, so it also appears in `Ctrl K`.
- **No new runtime dependency** without saying why in the PR. Everything needed
  is already in `package.json`.

**Style**
- `"use client"` on anything with state or effects; the section bodies are
  client components, the route stays a server component.
- `cva` for variants, `cn()` for merging, `readonly` props, named exports.
- Comments explain *why*, never *what*. Pointless comments will be asked to be
  removed in review.

---

## 5. Steps

Each row is one PR. Run `pnpm control-room:lint`, `pnpm control-room:typecheck`
and `pnpm control-room:test` before opening it; they are the baseline gate for
every step and are not repeated below.

### Step 1 — Shell, rail, launch tiles  *(no new host API)*

The step that proves the design in the app with zero backend work.

**Scope**
- `src/design/styles/start-screen.tokens.css` ← copy of
  `docs/design/start-screen/tokens/start-screen.tokens.css`
- `app/globals.css`: add
  `@import "../src/design/styles/start-screen.tokens.css" layer(fm-tokens);`
  **after** the `theme.css` import, before `base.css`.
- `src/design/styles/tailwind-theme.css`: append the bridge block that is
  commented at the bottom of the token file to the existing `@theme inline`.
  Until this is done the new utilities are inert and badges render in the
  inherited colour — visible but wrong, so do it in the same commit.
- `src/design/styles/start-screen.css` — component CSS, imported from
  `design/styles/components/index.css` (which is already in `layer(fm-modules)`).
  It needs at minimum the `fm-pulse` keyframes used by `StatusPill`.
- New module `src/modules/start/` per `02-implementation-guide.md` §2:
  `StartScreen.tsx`, `rail/StartRail.tsx`, `rail/ComputeEnvironmentWidget.tsx`
  (static placeholder state for now), `home/LaunchTiles.tsx`,
  `ui/SolverBadge.tsx`, `ui/StatusPill.tsx`, `ui/SectionHeader.tsx`,
  `model/startScreenState.ts`, `model/startCommands.ts`.
- `WorkspaceShellClient.tsx`: replace **both** `<EmptyWorkspace />` usages.
- Delete `EmptyWorkspace.tsx` and update `WorkspaceNewProblemEntry.test.tsx` and
  `WorkspaceShellClient.test.tsx`, which reference its copy.
- Register the new commands in `shellCommands.ts`: `start.section.home`,
  `start.section.templates`, `start.section.import`, `start.section.learn`,
  `start.new-fdm`, `start.new-fem`, `start.browse`. Shortcuts per
  `03-interaction-and-accessibility.md` §1. `start.new-fdm` / `start.new-fem`
  delegate to `workspace.new-problem`.

**Not in scope:** recent list, inspector content, thumbnails, Continue card.
The inspector renders its section-specific empty state. Sections other than
Home render a titled placeholder.

**Definition of done**
- Launching with no session shows rail + content + inspector inside the
  unchanged chrome; the Home section shows the greeting and the four tiles.
- All four tiles work. `Ctrl N`, `Ctrl ⇧ N`, `Ctrl O`, `Ctrl 1–4` work.
- Every new action appears in the `Ctrl K` palette.
- Light and dark both render correctly; toggling with `Ctrl+Shift+T` does not
  reflow the layout.
- `SessionCollectionError` still shows its banner, with the start screen below it.
- No measurement outside the token scale; `grep -nE '[0-9]+px' src/modules/start`
  returns only values that are in `tokens.css` or `start-screen.tokens.css`.

**Verify**
```bash
pnpm control-room:dev          # eyeball against mockups/assets/screens/*-home.png
node docs/design/start-screen/scripts/audit_contrast.mjs   # expect: TOTAL below WCAG AA: 0
```

### Step 2 — Recent index  *(needs §6.1)*
List, search, filter, sort, grouping, virtualisation above 40 rows.
Port `components/recentIndex.ts` as-is and write its vitest cases **first** —
local midnight, a DST change, a future timestamp, pinned hoisting, a truncated
index. Those are the behaviours that are invisible in a screenshot.
**Done when:** the list renders real projects, the index-error state shows the
banner with a working `Rebuild index`, and the launch tiles still work in that state.

### Step 3 — Inspector: Overview  *(needs §6.3 partially)*
Header, chips, `ContextBanner` (port `selectBanner` with its unit tests — the
priority order is the contract), Overview tab from `summary`. Other tabs show
their empty states.
**Done when:** selecting a row populates the inspector without opening the project.

### Step 4 — Thumbnails  *(needs §6.2)*
Row previews, card grid, inspector preview with the frame scrubber. Bounded LRU
of ~60 decoded images, `loading="lazy"` on rows, eager in the inspector.
**Done when:** a project is recognisable by its result at 72 × 45.

### Step 5 — Provenance  *(needs §6.3)*
Authors, History, Runs tabs. BibTeX generated from `authors` + name + revision,
overridable by `citation.preferred_bibtex`.
**Done when:** a project made before 0.9.3 shows "no history recorded before
Fullmag 0.9.3" rather than an empty tab.

### Step 6 — Continue card  *(needs §6.4)*
**Done when:** `resumable: false` removes the Resume button and shows the reason
in its place. Never render a button that will fail.

### Step 7 — Compute environment  *(needs §6.5)*
Live GPU / CUDA / VRAM, CPU fallback warning, 5 s poll cleared on unmount.
**Done when:** with no GPU the widget is amber and says "CPU fallback — roughly
40× slower", and template runtime estimates switch to CPU figures.

### Step 8 — Templates gallery
µMAG SP#1–#5, dispersion, magnonic crystal bands, skyrmion phase diagram,
broadband FMR, domain-wall motion, vortex gyration. Opening copies the template
into the default project location, never into the install directory.

### Step 9 — Import  *(needs §6.6)*
Ship `.fms` and `.mx3` first. Nothing is written until an import report is
confirmed. Formats without an importer are listed as "not yet supported" and the
drop target rejects them with a reason.

### Step 10 — Learn, Settings, About
Release-notes timeline (same component as History), keyboard map, start-screen
settings with a link to full preferences, build/runtime/team/citation and
**Copy diagnostics**.

### Promote to `shared/ui/` once Step 5 lands
`StatusPill`, `KeyValueGrid`, `Timeline` — the physics inspectors hand-roll all
three today.

---

## 6. Host API to add (Tauri)

Schemas: `docs/design/start-screen/schema/*.schema.json`.

**6.1 Recent index**
```rust
recent_index_read()    -> RecentIndex
recent_index_rebuild() -> RecentIndex        // cancellable, streaming
recent_index_forget(project_id: String)
recent_index_pin(project_id: String, pinned: bool)
```
Walk the configured roots for `*.fms`, read each manifest head (not the whole
archive), write **atomically** — temp file plus rename. A crash mid-write must
not produce the truncated file the error state is designed around. Rebuild
streams so the UI fills skeleton rows as entries arrive.

**6.2 Thumbnails** — render a 16:10 PNG from the last result frame after a run,
store at `preview/thumb.png` inside the archive, cache beside the index. Record
`preview.colouring` (`hsl-sphere`, `mz-diverging`, …) so a thumbnail is never
read under the wrong mapping — this matters for the HSL-sphere maps.

**6.3 Manifest additions** — `authors[]`, `citation`, `history[]`, `runs[]`,
`preview`, `summary`. `history` and `runs` are append-only. A 1.0/1.1 manifest
migrates with empty collections and synthetic stamps from the file.

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
| Visual | screenshots at 1680 and 1180 px, both themes, against `mockups/assets/screens/` | no unexplained diff |

The contrast gate is not optional. The design ships at 0 failures across 18
theme × state × section combinations; a regression there is a regression.

---

## 8. When you are blocked

Five decisions are **not** yours to make. If a step needs one, implement the
proposed answer behind a setting, note it in the PR, and move on:

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
- the gate output, including the contrast total
- anything from §4 you could not hold, and why
- any of §8 you hit, and which proposed answer you implemented

Attribution lines per the repo's `AGENTS.md`.
