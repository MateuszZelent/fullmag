# Interaction, keyboard and accessibility

---

## 1. Keyboard map

Everything on the start screen is reachable without a mouse. Each entry is a
registered command, so it also appears in `Ctrl K`.

### Global

| Action | Keys | Enabled when |
|---|---|---|
| Command search | `Ctrl K` | always |
| New FDM simulation | `Ctrl N` | always |
| New FEM simulation | `Ctrl ⇧ N` | always |
| Open project… | `Ctrl O` | always |
| Open recent (quick switch) | `Ctrl Alt O` (the design's `Ctrl ⇧ O` is already Restore Runtime State) | Home section |
| Browse templates | `Ctrl T` | always |
| Import model | `Ctrl I` | always |
| Settings | `Ctrl ,` | always |
| Documentation (opens the Docs section, `05-sphinx-integration.md`) | `F1` | always |
| Toggle theme | `Ctrl ⇧ T` | always |
| Rail sections 1–4 | `Ctrl 1` … `Ctrl 4` | always |

### Recent list (focus inside the listbox)

| Action | Keys |
|---|---|
| Focus the filter | `/` |
| Move selection | `↑` `↓` |
| Jump a group | `PgUp` `PgDn` |
| First / last | `Home` `End` |
| Open | `Enter` |
| Open a copy | `Ctrl Enter` |
| Open read-only | `Alt Enter` |
| Toggle the inspector | `Space` |
| Pin / unpin | `Ctrl P` |
| Remove from recent | `Del` |
| Rename | `F2` |
| Context menu | `⇧ F10` or the menu key |
| Type-ahead | any letter jumps to the next name starting with it |

`Esc` in the filter clears the query; `Esc` with an empty query returns focus to
the list.

### Inspector

| Action | Keys |
|---|---|
| Move between tabs | `←` `→` when a tab has focus |
| Activate the primary action | `Enter` on the footer button |
| Open the split menu | `Alt ↓` |
| Return focus to the list | `⇧ Tab` from the first tab stop |

---

## 2. Focus

**Order:** rail → content (toolbar → list) → inspector → status bar. The rail
and inspector are single tab stops with roving `tabindex` inside, so `Tab` does
not walk nine rail items before reaching the content.

**On mount:** focus goes to the Continue card's primary button when a checkpoint
exists, otherwise to the first launch tile. It never goes to the filter field —
landing in a text input means the first keystroke is swallowed.

**Focus ring:** `--fm-focus-ring` (2 px `--fm-bg-app` + 2 px `--fm-accent`), the
existing token. Visible for keyboard only (`:focus-visible`); the mouse never
shows a ring.

**Selection vs focus** are distinct. Arrowing through the list moves focus and
updates the inspector; it does not open anything. `Enter` opens. This mirrors
every file list the user already knows.

**After an action:** removing a row moves focus to the next row (or the previous
one if it was last). Rebuilding the index restores focus to the previously
selected project id if it survives the rebuild.

---

## 3. Semantics

```
<nav aria-label="Start screen sections">            rail
  <button aria-current="page">                      active section

<main id="fm-main-content" tabindex="-1">           content
  <h1>                                              one per section
  <section aria-labelledby="…">                     each content section
  <div role="listbox" aria-label="Recent projects"
       aria-activedescendant="row-…">               the list
    <div role="option" aria-selected>               each row
  <div role="group" aria-label="Today">             group headers

<aside aria-label="Project details">                inspector
  <div role="tablist">  <button role="tab">  <div role="tabpanel">
```

- Section eyebrows ("RECENT PROJECTS") are real headings (`h2`), styled small —
  not `div`s, so the heading outline is navigable.
- The status pill's text is inside the element; the dot is
  `aria-hidden`. A screen reader hears "Running", not "circle Running".
- Progress uses `role="progressbar"` with `aria-valuenow`/`min`/`max` and an
  `aria-valuetext` of "64 percent, about 12 minutes remaining".
- The thumbnail `alt` is `""` when the name is adjacent (decorative), and
  `"Last result of <name>"` in the inspector where it stands alone.
- Live regions: the index-rebuild result and run-progress updates announce via
  `aria-live="polite"`. Nothing uses `assertive` — nothing on this screen is
  urgent enough to interrupt.

---

## 4. Colour and contrast

### The rule

- Every status is **dot + word**. Removing colour entirely leaves the screen
  fully usable; this is the test the design is held to.
- Solver badges print `FDM` / `FEM`, never colour alone.
- Row selection is background **and** border, not hue.
- Status colours are used as text on panel surfaces, never as text on a filled
  chip of the same hue — which is exactly where contrast usually breaks.

### What the audit found

The design was measured on the rendered mockup, with translucent layers
composited, rather than on token values in isolation. The first pass found
**127 elements below WCAG AA** — 112 in Mocha, 15 in Latte.

Almost none of it was new. Catppuccin is an *accent* palette, and the repo uses
it as a *text* palette for small secondary type:

| Token | Theme | As 11–12 px text | Needs |
|---|---|---|---|
| `--fm-text-muted` | Mocha | 3.36:1 on panel, **2.13:1** behind a `kbd` | 4.5:1 |
| `--fm-text-muted` | Latte | **2.30:1** | 4.5:1 |
| `--fm-chart-yellow` | Latte | **2.15:1** | 4.5:1 |
| `--fm-degraded` | Latte | **2.45:1** | 4.5:1 |
| `--fm-success` | Latte | **2.75:1** | 4.5:1 |
| `--fm-chart-teal` | Latte | **3.08:1** | 4.5:1 |
| `--fm-accent` on `--fm-bg-selected` | Latte | **3.37:1** | 4.5:1 |
| `--fm-text-inverse` on `--fm-accent` | Latte | **4.34:1** | 4.5:1 |

### What was done about it

The semantic layer was split in two, which is the whole fix:

- **Mark colour** (`--fm-project-ready`, …) — the dot, the badge border, the
  badge fill, the timeline marker. These keep the palette hue untouched. The
  bar here is the 3:1 non-text threshold, and every value clears it.
- **Label colour** (`--fm-project-ready-text`, …) — the word beside the dot, at
  11–12 px. Darkened on Latte, lightened on Mocha, hue preserved, each one
  measured to ≥ 4.5:1 against the *worst* background the screen puts it on —
  which is the selected row, not the plain panel.

Plus three scoped tokens for cases the palette does not cover:
`--fm-start-meta` (10–11 px paths, sizes, dates), `--fm-start-nav-active` (the
active rail item on `--fm-bg-selected`) and `--fm-start-on-accent` (the primary
button label). On Latte the solver badge also drops its tinted fill
(`--fm-badge-fill: 0%`) and becomes a neutral chip with a coloured border,
because the tint was what pushed the label under on a selected row.

All of it lives in `tokens/start-screen.tokens.css` and is scoped to the start
screen **on purpose**. The same gap exists elsewhere in the light theme and
deserves a repo-wide decision rather than a quiet fork in one module. The
numbers above are the argument for making that decision.

### Result

```
$ node scripts/audit_contrast.mjs
dark/loaded/home           clean
… 18 combinations …
light/loaded/about         clean

TOTAL below WCAG AA: 0
```

2 themes × {loaded, first run, loading, index error} × {home, templates,
import, learn, settings, about}. Re-run it after any token change.

`diagrams/08-colour-mapping.svg` shows the full mark/label table with before
and after ratios. Storybook's `@storybook/addon-a11y` (already configured)
covers the component level.

## 5. Motion

| What | Duration | Token |
|---|---|---|
| Hover, pressed | 120 ms | `--fm-duration-fast` |
| Panel, tab, banner | 180 ms | `--fm-duration-normal` |
| Expand / reveal | 240 ms | `--fm-duration-moderate` |
| List entrance stagger | 24 ms per row | `--fm-start-stagger-step` |
| Skeleton shimmer | 1400 ms loop | `--fm-start-skeleton-period` |
| Running-dot pulse | 1600 ms loop | — |

Under `prefers-reduced-motion: reduce` **all** animation and transition is
disabled, including the shimmer and the pulse. The running state then reads
from the word and the progress number, which is why neither depends on motion.

Nothing animates on first paint except the skeleton rows. A launcher that
slides in on every start becomes irritating by the twentieth launch.

---

## 6. Pointer and touch

- Hit targets are ≥ 26 px tall, matching `--fm-control-height-compact`; the
  pin button is 26 × 26 inside a 52 px row.
- Double-click a row opens it. Single-click selects.
- The inspector splitter is a 4 px handle with an 8 px hit area and
  `cursor: col-resize`; `←` `→` resize it by 16 px when it has focus.
- Right-click anywhere in a row opens the context menu, including on the
  thumbnail.
- Drag a `.fms` file onto any part of the screen to open it; drag any supported
  model file to jump to Import with that file staged.

---

## 7. Copy rules

- **Sentence case** everywhere except section eyebrows, which are uppercase by
  token (`--fm-start-section-tracking`).
- **Errors state cause, number, then suggestion.** *"Run r-0027 diverged at
  t = 0.41 ns — |m| drift 4.2e-2 exceeded the 1e-3 tolerance. Likely cause:
  Δt too large for α = 0.001."*
- **No empty-state apologies.** "No runs yet — this project has a model but no
  study has been executed", not "Oops! Nothing here yet 😔".
- **Units belong to the value**, never to a separate column: `2.0 × 2.0 × 5.0 nm`.
- **Relative dates inside a week**, absolute beyond it: "today 12:04",
  "yesterday 16:40", "2 Aug 2026".
- **Numbers are tabular**, in `--fm-font-mono`, so columns align while scanning.

---

## 8. Internationalisation

The screen is English-only today, like the rest of the control room, but the
layout does not assume it:

- No text is baked into an image.
- Rail labels and tile names are given room to grow by ~40 % before truncating;
  German compounds (*"Simulationsvorlage"*) are the practical worst case.
- Dates and numbers go through `Intl.DateTimeFormat` / `Intl.NumberFormat` with
  the app locale, not hand-formatted strings — so a decimal comma works when the
  locale asks for one.
- Paths and physical units are never localised.
- Nothing is right-to-left-hostile: the layout uses logical properties
  (`padding-inline`, `margin-inline`) as the existing stylesheets already do.

---

## Documentation section

The frame has a title and the query box a label; focus lands in the query box when
the documentation is available and never inside the frame, so the section cannot
trap the keyboard. The theme follows the app. Details in
`05-sphinx-integration.md` §8.
