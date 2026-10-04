# Implementation guide

How the design in `01-design-spec.md` lands in `apps/control-room`, what already
exists, and what the Tauri host still has to provide.

---

## 1. What this replaces

`src/kernel/layout/EmptyWorkspace.tsx` renders when there is no active session.
`WorkspaceShellClient` chooses it; nothing else references it, so the swap is
contained. Its four commands stay exactly as they are:

| Current button | Command | Where it goes |
|---|---|---|
| Create simulation | `workspace.new-problem` | FDM / FEM launch tiles |
| New project | `workspace.new-project` | behind the launch tiles |
| Open project | `workspace.open-project` | `Browse…`, row double-click, inspector footer |
| Save project | `workspace.save-project` | removed — meaningless with no session |

The start screen adds commands but changes none of the existing contracts.

---

## 2. File map

```
src/modules/start/                        ← new module, mirrors the modules/ convention
├─ StartScreen.tsx                        shell: rail | content | inspector
├─ model/
│  ├─ startScreenState.ts                 section, view, filter, query, selection, tab
│  ├─ recentIndex.ts                      types + parse + normalise + group-by-recency
│  ├─ recentIndex.test.ts
│  ├─ startCommands.ts                    command registrations (Ctrl N/O/T/I/1–4…)
│  └─ startCommands.test.ts
├─ rail/
│  ├─ StartRail.tsx
│  └─ ComputeEnvironmentWidget.tsx
├─ home/
│  ├─ HomeSection.tsx
│  ├─ ContinueCard.tsx
│  ├─ LaunchTiles.tsx
│  ├─ RecentProjects.tsx                  toolbar + grouping + virtualiser
│  ├─ ProjectRow.tsx
│  ├─ ProjectCard.tsx
│  └─ ProjectRowSkeleton.tsx
├─ sections/
│  ├─ TemplatesSection.tsx
│  ├─ ImportSection.tsx
│  ├─ LearnSection.tsx
│  ├─ SettingsSection.tsx
│  └─ AboutSection.tsx
├─ inspector/
│  ├─ ProjectInspector.tsx
│  ├─ ProjectPreview.tsx                  thumbnail + frame scrubber
│  ├─ OverviewTab.tsx
│  ├─ AuthorsTab.tsx                      includes the BibTeX builder
│  ├─ HistoryTab.tsx                      timeline
│  ├─ RunsTab.tsx
│  └─ ContextBanner.tsx                   the one-banner priority rule
└─ ui/
   ├─ SolverBadge.tsx
   ├─ StatusPill.tsx
   └─ SectionHeader.tsx

src/design/styles/start-screen.css        ← component CSS, imported from components/index.css
app/globals.css                           ← add the token import (see §3)
```

Three shared primitives are worth promoting into `shared/ui/` because the
workspace will want them too:

- `StatusPill` — generalises the existing `StatusBadge` with the dot + pulse.
- `KeyValueGrid` — the inspector's `dl` layout; the physics inspectors
  hand-roll the same thing today.
- `Timeline` — used by the inspector's History tab and by Learn's release notes.

---

### 2.1 Sphinx documentation

| File | Role |
|---|---|
| `sections/DocsSection.tsx` | query box, frame, **Contents**, **Open online**, unavailable state |
| `model/docs.ts` | URLs, availability probe, message parsing, online link (pure, tested) |
| `scripts/bundle-docs.mjs` | copies the built site into `public/docs/` |
| `public_docs/site/_static/fullmag-embed.{js,css}` | embedded mode on the Sphinx side |

Contract and rationale: `05-sphinx-integration.md`.

## 3. Tokens

`tokens/start-screen.tokens.css` is additive: it defines nothing that already
exists and redefines nothing. Import it between `theme.css` and
`tailwind-theme.css` in `app/globals.css`:

```css
@import "../src/design/styles/tokens.css";
@import "../src/design/styles/theme.css";
@import "../src/design/styles/start-screen.tokens.css";   /* ← new */
@import "../src/design/styles/tailwind-theme.css";
```

Then append the bridge block (commented at the bottom of the token file) to the
`@theme inline` in `tailwind-theme.css`, so `bg-fm-solver-fdm`,
`text-fm-project-running`, `w-fm-start-rail` and friends become Tailwind v4
utilities.

---

## 4. Host API gaps

Everything below is missing today. Each is a separate, shippable step.

### 4.1 Recent index (required)

```rust
#[tauri::command] async fn recent_index_read()    -> Result<RecentIndex, String>;
#[tauri::command] async fn recent_index_rebuild() -> Result<RecentIndex, String>;
#[tauri::command] async fn recent_index_forget(project_id: String) -> Result<(), String>;
#[tauri::command] async fn recent_index_pin(project_id: String, pinned: bool) -> Result<(), String>;
```

Schema: `schema/recent-index.schema.json`. The scan walks the configured roots
for `*.fms`, reads each manifest head (not the whole archive), and writes the
index atomically — temp file plus rename, so a crash mid-write cannot leave the
truncated file the error state is designed around.

Rebuild must be cancellable and must stream: the UI shows skeleton rows and
fills them as entries arrive, rather than waiting for the whole walk.

### 4.2 Thumbnails (required for the core idea to work)

Render a 16:10 PNG from the last result frame after a run, store it at
`preview/thumb.png` inside the archive, and cache a copy beside the index. The
colouring convention goes in `preview.colouring` so a thumbnail is never read
under the wrong mapping — this matters for the HSL-sphere maps, where the same
image means something different under an `mz`-diverging palette.

Without thumbnails the design still works, but it degrades to a list of names,
which is most of what is wrong with the current screen.

### 4.3 Manifest additions (required)

`authors[]`, `citation`, `history[]`, `runs[]`, `preview`, `summary` — see
`schema/project-manifest.schema.json`. `history` and `runs` are append-only and
belong to the archive, not the index.

Migration: a 1.0 or 1.1 manifest gets empty `authors`/`history`/`runs` and a
synthetic `created`/`modified` from the file stamps. The start screen shows
"no history recorded before Fullmag 0.9.3" rather than an empty tab.

### 4.4 Checkpoints (required for the Continue card)

`runs[].checkpoint` plus a host command to resume from one. `resumable` must be
computed on the current machine — build version, device availability — not
copied from the file. The card never shows a button that will fail.

### 4.5 Compute probe (required for the environment widget)

Bieżąca implementacja w przeglądarce i desktopie korzysta w pierwszej
kolejności z istniejących zasobów CPU/GPU i capabilities runtime przez
typowany klient oraz resource hooks. Poniższe polecenie desktopowe pozostaje
trasą zgodności dla starszych hostów. Pełny kontrakt:
[Compute environment](09-compute-environment.md).

```rust
#[tauri::command] async fn compute_probe() -> Result<ComputeEnvironment, String>;
// { gpus: [{ name, cuda_version, vram_total, vram_free, busy_with_run }],
//   cpu_threads, preferred_backend, warnings: [string] }
```

Polled while the start screen is mounted (5 s is plenty), stopped on unmount.

### 4.6 Importers (can ship later)

The Import section degrades gracefully: formats without an importer are listed
with "not yet supported" and the drop target rejects them with a reason. Ship
`.fms` and `.mx3` first; they cover most of what the group has.

---

## 5. Suggested sequence

Each step is independently useful and independently shippable.

| Step | Delivers | Depends on |
|---|---|---|
| 1 | Shell: rail + content + inspector, Home with launch tiles only. Replaces `EmptyWorkspace` with no new host API. | — |
| 2 | Recent index: host scan, list, search, filter, sort, grouping. | 4.1 |
| 3 | Inspector: Overview tab from `summary`; the other tabs show empty states. | 4.3 (partial) |
| 4 | Thumbnails: row previews, card grid, inspector preview. | 4.2 |
| 5 | Provenance: Authors, History, Runs tabs; BibTeX. | 4.3 |
| 6 | Continue card. | 4.4 |
| 7 | Compute environment widget; CPU-fallback warnings. | 4.5 |
| 8 | Templates gallery. | template bundle |
| 9 | Import section. | 4.6 |
| 10 | Learn / Settings / About. | — |

Step 1 alone is already a visible improvement, and it is the step that gets the
layout, tokens and commands in place for everything after it.

---

## 6. Performance

| Concern | Approach |
|---|---|
| Long recent lists | `@tanstack/react-virtual` is already a dependency; virtualise above 40 rows. Grouping stays correct because group headers are rendered as sticky items in the same virtual list. |
| Thumbnail memory | Cache decoded images in a bounded LRU (≈ 60 entries). Rows use `loading="lazy"`; the inspector preview loads eagerly. |
| Index scan | Host-side and streamed; the renderer never walks the filesystem. |
| Compute poll | 5 s interval, cleared on unmount; the status bar reuses the same subscription. |
| First paint | The shell, rail and launch tiles render before the index resolves. Nothing waits on I/O to show the page. |

---

## 7. Testing

| Layer | What to cover |
|---|---|
| `vitest` | `recentIndex.ts` — parse, normalise, group-by-recency across midnight and across a DST change; malformed and truncated index; entries under an unreachable root. |
| `vitest` | `startCommands.ts` — every shortcut registers, enablement matches the current state (no `Resume` without a checkpoint). |
| Storybook | `ProjectRow` in all eight states; `ContextBanner` priority ordering; `ComputeEnvironmentWidget` in all four states. Storybook 10 and `addon-a11y` are already configured. |
| Playwright | Launch → start screen → open project → workspace. First-run, loading, error states. Keyboard-only path from launch to an open project. |
| Visual | Screenshot both themes at 1680 and 1180 px. `mockups/assets/screens/` is the reference set. |

---

## 8. Relationship to the mockup

`mockups/start-screen.html` is a faithful visual reference, not a source of
truth for code. It mirrors the real tokens verbatim and reproduces the real
`Button` variants, but it holds its own data and its own tiny renderer. Use it
to settle layout and copy questions; implement against `components/*.tsx` and
the schemas.
