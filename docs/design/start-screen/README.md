# Fullmag start screen — design package

A complete redesign of the first screen Fullmag shows when it opens with no
active session. It replaces `apps/control-room/src/kernel/layout/EmptyWorkspace.tsx`
— four buttons centred in a void — with a launcher built for the way people
actually re-enter micromagnetic work: resume the paused run, recognise a project
by its result, confirm the machine can run it, and see who did what to it.

Everything here is built on the design system that already exists in the repo —
the `--fm-*` tokens, the Catppuccin Mocha/Latte themes in
`src/design/styles/theme.css`, the `shared/ui/*` primitives and the existing
command registry. No new colour system, no new control geometry.

---

## Start here

| | |
|---|---|
| **See it** | open `mockups/start-screen.html` in a browser — interactive, self-contained, no build step |
| **Read it** | `docs/01-design-spec.md` — the full specification |
| **Build it** | `docs/02-implementation-guide.md` — file map, host API gaps, shipping sequence |
| **Hand it over** | `docs/04-implementation-prompt.md` — the task brief for whoever implements it |
| **Docs in the app** | `docs/05-sphinx-integration.md` — the Sphinx documentation inside the app, with search |
| **Status** | `docs/06-implementation-status.md` — what is built, how it was verified, what is left |
| **Store it** | `docs/07-workspace-database.md` — the per-user SQLite database behind the recent list (projects and scripts) |
| **Host obliczeniowy** | `docs/09-compute-environment.md` — odczyty runtime, szczegóły urządzeń i jawne stany niedostępności |
| **Zasoby i równoległe zadania — projekt** | [Settings, profile i wiele urządzeń](docs/10-compute-settings-and-multi-device.md) — docelowa architektura CPU/GPU, solver settings i sweeps; nie deklaracja wdrożenia |

The mockup has a control bar at the bottom (hover to reveal) for switching
theme, screen state and section. Rendered stills of every combination are in
`mockups/assets/screens/`.

---

## Contents

```
README.md                            this file
docs/
  01-design-spec.md                  the design, A to Z — layout, components, states, rules
  02-implementation-guide.md         where the code goes, what the host must provide, in what order
  03-interaction-and-accessibility.md keyboard map, focus, ARIA, contrast, motion, copy rules, i18n
  04-implementation-prompt.md        executable brief: verified repo facts, constraints, 11 steps, gates
  05-sphinx-integration.md           the public Sphinx docs inside the app: contract, search, bundling
  06-implementation-status.md        what is built, evidence, known gaps
  07-workspace-database.md           per-user workspace database: schema, identity, concurrency, migration
  09-compute-environment.md          odczyty hosta, szczegóły urządzeń, stany i dowody weryfikacji
  10-compute-settings-and-multi-device.md projekt Settings, CPU/GPU placement i równoległych sweeps
mockups/
  start-screen.html                  interactive mockup (single file, 231 kB)
  start-screen.template.html         source; thumbnails injected by scripts/build_mockup.py
  assets/thumbs/*.png                nine generated result previews
  assets/screens/*.png               rendered stills — both themes, every state and section
diagrams/
  01-window-zones.svg                window strata and their dimensions
  02-information-architecture.svg    what the screen holds and where
  03-layout-grid.svg                 vertical rhythm, density, type and spacing scales
  04-anatomy-project-row.svg         list row and grid card, with every state
  05-inspector-anatomy.svg           inspector stack and what each tab answers
  06-launch-flow.svg                 process start → workspace
  07-screen-states.svg               first run, loading, loaded, empty filter, error, degraded compute
  08-colour-mapping.svg              every semantic token → existing palette token, both themes
tokens/
  start-screen.tokens.css            additive token layer; redefines nothing that exists
brand/
  fullmag-mark.svg                   the logo redrawn as vector geometry (2.4 kB)
  fullmag-mark-small.svg             simplified for ≤ 32 px (1.0 kB)
  fullmag-app-icon.svg               mark on the dark app-icon field (2.2 kB)
schema/
  recent-index.schema.json           the recent-project index the start screen reads
  project-manifest.schema.json       manifest fields the launcher needs (authors, history, runs…)
  examples/*.json                    validated examples of both
components/
  types.ts  recentIndex.ts           types and pure logic (parse, filter, sort, group, format)
  ProjectBadges.tsx  ProjectRow.tsx  ContinueCard.tsx  ContextBanner.tsx  StartScreen.tsx
scripts/
  make_thumbs.py  make_diagrams.py  build_mockup.py
  audit_contrast.mjs                WCAG audit over the rendered mockup
```

---

## The short version of the design

1. **Resume beats create.** The interrupted run is the first thing on the page,
   with its progress, simulated time and ETA, and a Resume button that is only
   shown when the checkpoint can actually be resumed on this machine.
2. **Recognise by result.** Every project carries a rendered thumbnail of its
   last result. `sim_v3_final_FINAL.fms` tells you nothing; a dispersion map
   tells you everything.
3. **Answer "can I run this?" before opening.** Grid, interactions, integrator,
   output size and the live GPU/VRAM state are visible without loading anything.
4. **Provenance is first-class.** Authors with ORCID, a revision timeline, a run
   table and a generated BibTeX block — this is a research tool.
5. **Never block the work.** A corrupt index, an offline share or a missing GPU
   degrades the screen; the launch tiles are present in every single state.

---

## Rebuilding the artefacts

```bash
python scripts/make_thumbs.py      # result previews  → mockups/assets/thumbs/
python scripts/make_diagrams.py    # schematics       → diagrams/
python scripts/build_mockup.py     # inline thumbs    → mockups/start-screen.html
node   scripts/audit_contrast.mjs  # WCAG AA over 18 theme × state × section combinations
```

Requires Python with `matplotlib`, `numpy` and `Pillow`. The diagrams carry
their own `prefers-color-scheme` styles, so they are legible in a light or dark
viewer and render correctly in GitHub Markdown.

---

## Notes for review

- **The logo in `docs/fullmag-logo-traced-optimized.svg` is a 1.4 MB bitmap
  trace** and cannot be used at 26–30 px in the menu bar or rail. `brand/`
  contains it redrawn as real vector geometry at 2.4 kB — the same two
  interlocking rings, the left carrying a structured square grid (FDM), the
  right an unstructured triangular mesh (FEM). That reading of the original
  also gave the colour pairing used throughout: FDM blue, FEM mauve.
- **The light theme has a contrast problem that predates this work.** Measured
  as 11–12 px text, Catppuccin Latte's status hues land at 2.1–3.7:1 and
  `--fm-text-muted` at 2.30:1; Mocha's muted reaches 2.13:1 behind a `kbd`. The
  start screen fixes it inside its own token layer by separating mark colour
  from label colour, and now audits clean — but the same gap exists elsewhere in
  the app. Numbers and a recommendation: `docs/03-interaction-and-accessibility.md` §4.
- **Five decisions need a call from the team** before implementation — index
  location, thumbnail cost, network-share scanning, `Delete from disk`, and
  where author identity comes from. They are listed with proposed answers in
  `docs/01-design-spec.md` §11.
- **Step 1 of the implementation sequence needs no new host API** and is already
  a visible improvement: the shell, rail, launch tiles and token layer, with the
  existing four commands wired through. `docs/04-implementation-prompt.md` has it
  broken down to the file.
- The documents are in English to match the repo. Say the word for a Polish set.
