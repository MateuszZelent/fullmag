# Frontend v2 - Shell, Main Menu, and Navigation

**Status:** Proposed architecture
**Date:** 2026-05-11

## 1. Shell Layout

The shell is fixed and module-driven:

```text
+----------------------------------------------+
| Main menu                                    |
+----------------------------------------------+
| Ribbon / contextual toolbar                  |
+--------------+----------------+--------------+
| Explorer     | Viewport        | Inspector    |
|              |                 |              |
+--------------+----------------+--------------+
| Bottom dock: charts / console / jobs / diag  |
+----------------------------------------------+
| Status bar                                   |
+----------------------------------------------+
```

The shell does not know which scientific workflow is active. It hosts slots and renders command/menu/ribbon contributions.

## 2. Workspace Contexts

Top-level contexts are:

- `Home`
- `Definitions`
- `Geometry`
- `Materials`
- `Physics`
- `Mesh`
- `Study`
- `Results`
- `Automation`

These are not separate pages or app shells. A context changes active ribbon groups, explorer filters, inspector defaults, viewport layer presets, and command availability.

## 3. Main Menu

The main menu renders command registry entries. It must not contain custom callback code.

| Menu | Command examples |
|---|---|
| `File` | new/open/save session, import, export Python, export artifacts |
| `Edit` | undo/redo transaction, duplicate, delete, rename, copy values |
| `View` | 3D, 2D, split view, reset layout, overlays, diagnostics |
| `Definitions` | add material, add parameter, add named field |
| `Geometry` | add primitive, boolean operation, transform, validate geometry |
| `Mesh` | build selected, build all, show quality, show shared-domain report |
| `Study` | add stage, run, pause, stop, resolve backend, show provenance |
| `Results` | open artifact, add chart series, export data |
| `Window` | toggle explorer, inspector, bottom dock, command palette |
| `Help` | docs, API contract, diagnostics, about runtime |

Menu items display capability state:

- available;
- unavailable because selection is wrong;
- unavailable because runtime capability is missing;
- degraded with explanation;
- active/running.

## 4. Navigation State

URL state owns only durable navigation:

```text
/workspace?context=mesh&selection=object:free-layer&view=3d
```

Local layout details such as panel width and chart brush range persist in layout stores, not in the URL. Session identity remains explicit when multiple sessions are supported.

## 5. Context Switching

Switching context may:

- change active ribbon tab;
- set explorer filter tab;
- activate inspector default section;
- set viewport layer preset;
- focus a module slot.

Switching context must not:

- replace the shell;
- reset session state;
- remount the API client;
- destroy the 3D renderer unless the active viewport module is actually disabled;
- rewrite physics state;
- hide unsupported commands without explanation.

## 6. Layout Persistence

Persist:

- panel open/closed state;
- panel sizes;
- active module per slot;
- viewport split ratio;
- selected ribbon tab;
- user debug overlay preferences.

Do not persist:

- server resources;
- field buffers;
- mesh topology;
- command completion;
- selected values that must be restored from canonical resource identity.

## 7. Error Boundaries

Each module root is wrapped by `ModuleBoundary`. A module crash shows:

- module id;
- slot id;
- error summary;
- reset module button;
- disable module for this session button in development mode;
- diagnostics link.

A module crash must not unmount the full shell or API provider.

## 8. Mobile and Small Screens

Frontend v2 is desktop-first, but small screens should degrade predictably:

- explorer and inspector become drawer panels;
- ribbon groups collapse into command palette and overflow menu;
- viewport remains the primary area;
- bottom dock collapses to tabs;
- no separate mobile product tree is introduced.
