---
title: Control Room
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-control-room-root)=
# Control Room

The Control Room (`apps/control-room`) is the active unified browser workspace for FullMag. It keeps
one semantic workspace model, one viewport layout model, and one typed client architecture across
FDM and FEM problems. Its core authoring invariant is explicit transactions: form edits create an
isolated draft, **Apply** commits canonical authored policy with `scene_revision` checks, and a
separate build or study command materializes backend resources.

```{image} /_static/images/ui/control-room-workspace-overview.png
:alt: FullMag Control Room v2 dark Catppuccin Mocha workspace layout
:align: center
:width: 100%
```

```{image} /_static/images/ui/control-room-light-latte-overview.png
:alt: FullMag Control Room v2 light Catppuccin Latte workspace layout
:align: center
:width: 100%
```

## Shell Routing, Theming, and Multi-Instance Tabs

- **Routes (`tabRoutes.ts`)**: `/home` overlays the non-blocking Start Screen hub while preserving any open session; `/session/<slug>` opens the workspace for the local backend instance; `/session/<slug>?port=<port>` and `/instance/<port>` attach sibling Control Room tabs on the same host (for parallel runs or separate Docker Compose development groups) without interrupting local sessions.
- **Mocha & Latte Themes (`theme.css`, `ThemeSwitcher`)**: Central `--fm-*` design tokens drive both Catppuccin **Mocha** (`data-theme="dark"`) and Catppuccin **Latte** (`data-theme="light"`) palettes, switchable directly from the `AppMenuBar`.

```{image} /_static/images/ui/multi-instance-session-tabs.png
:alt: Multi-instance session tab strip showing Home, local session, and host port tabs
:align: center
:width: 100%
```

## Workspace Ownership

| Area | Responsibility |
|---|---|
| `StartScreen` (`/home`) | Launch tiles (FDM/FEM/Template/Import/Script), checkpoint resume, active sessions, sibling instances |
| `AppMenuBar` & `CommandPaletteModule` | File/Edit/View/Simulation/Tools/Help menus, quick Save/Apply/Undo/Redo, transport controls, `Ctrl+Shift+P` command search |
| `RibbonModule` | Discretization- and lane-aware tabs (`Workspace`, `View`, `Geometry`, `Materials`, `Physics`, `Mesh`, `Study`, `Results`, contextual `analysis-context`) |
| `ExplorerModule` | Five semantic dock tabs: `Model`, `Resources`, `Results`, `Jobs`, `Diagnostics` |
| `InspectorRegistry` | Context-routed semantic property panels with draft isolation and validation |
| `Viewport3DModule`, `FieldMapModule`, Charts | Unified 3D WebGL scene, 2D planar probe map, live ECharts traces, dispersion/FMR plots, and saved playback |
| `FooterModule` & `StatusBarModule` | `Logs`, `Telemetry`, `Diagnostics`, `Engine`, `Operations` (including Mesh Jobs), `Problems`, `Quick Chart`, plus live status strip |
| Script export | `File -> Save canonical copy as…` exports editable stage-first Python DSL scripts |

```{image} /_static/images/ui/status-bar-footer.png
:alt: Control Room Status Bar and Footer Dock with Telemetry, Operations/Mesh Jobs, Problems, and Logs
:align: center
:width: 100%
```

The implementation lives in `apps/control-room/src/modules`, with API, resource, selection, and
layout controllers in `apps/control-room/src/kernel`. Screenshots illustrate the interface; they are
not runtime or physics qualification evidence.

```{toctree}
:maxdepth: 1

start-screen
ribbon-and-explorer
```
## Control Room crosswalk

This page is the Control Room surface itself. The status is `partial` unless every listed field has a named inspector and transaction. Fields not present in the cited component are `TODO: frontend support`; runtime/result-only views are `inspection-only`. See {doc}`/frontend/capability-register`.

## Python/API crosswalk

Python remains the authoritative authoring contract. Use the linked {doc}`/python-api/index` pages for exact constructors, functions, arguments, units, and failure semantics; this page must not invent a Python signature.

## Physics and bibliography scope

This UI page introduces no independent physical model. It presents controls for an existing backend contract. Bibliography: not applicable unless a terminal page below introduces a scientific model; implementation references are the cited frontend component and linked API page.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
