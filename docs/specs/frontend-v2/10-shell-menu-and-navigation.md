# Frontend v2 - Shell, Main Menu, and Navigation

**Status:** Proposed architecture, layout revised 2026-11-20
**Date:** 2026-05-11

## 1. Shell Layout

The shell is module-driven. Reference: `docs/design/inspector-redesign/` (the
"Full app" mockup). The viewport fills the window behind every layer; the
bars, rails, panels and dock are glass layers above it.

```text
+------------------------------------------------------------------+
| Instance tabs: Home · session tabs · new session                 |
+------------------------------------------------------------------+
| App bar: logo · main menu · save/undo/redo · search (Ctrl+K)     |
|          · API state · Compute/Pause/Stop/Skip · theme · problems|
+------------------------------------------------------------------+
| Ribbon: context tabs + command groups (collapsible)              |
+---+---------------+------------------------------+-----------+---+
| L | Left panel    |   viewport toolbar (top)     | Right     | R |
| e | (Model,       |                              | panel     | i |
| f | Results,      |        live viewport         | (Inspector| g |
| t | Charts,       |                              | 3D View,  | h |
|   | Library, …)   |                              | History,  | t |
| r +---------------+------------------------------+ Python, …)| r |
| a | Bottom dock (full width between rails):      |           | a |
| i | Telemetry · Problems · Logs · Operations · … |           | i |
| l |                                              |           | l |
+---+----------------------------------------------+-----------+---+
| Status bar: state · session · version · mesh rev · problems · …  |
+------------------------------------------------------------------+
```

The dock spans the full width between the two rails and sits below the left
panel, the viewport and the right panel. Rails run the full height of the work
area.

### 1a. Activity rails (2026-11-20)

- The left rail switches the model-builder panels (Explorer tabs: Model,
  Results, Live charts, Library and further tabs from `11-explorer-view.md`).
  The right rail switches the Inspector cards (Selection Inspector, 3D View
  settings, History, Python script and further cards).
- Each rail item is an icon button with an accessible name, a tooltip, an
  active indicator and an optional count badge. Clicking the active item
  collapses its panel and the viewport takes the space. The right panel width is
  adjustable with a pointer and keyboard handle.
- Panels report their extent to the viewport as insets; the canvas is not
  resized by panel changes.
- The viewport toolbar floats at the top centre of the viewport and hides its
  less important groups when the viewport is narrow (container queries).

The shell does not know which scientific workflow is active. It hosts slots and renders command/menu/ribbon contributions.

Shell chrome must use the shared shadcn/ui-style primitives for menu buttons, dropdowns, tabs, command palette, tooltips, and overflow behavior. The shell may add `fm-*` classes for Fullmag geometry, but must not hand-roll accessible menu, tab, or dialog primitives.

### Kontrakt nagłówka po audycie 26.10.2026

Pasek instancji jest nad nagłówkiem hosta, zgodnie z ADR 0069; osadzona instancja nie powiela paska. Nawigacja do Home pozostaje dostępna z nagłówka w obu przypadkach. Przy ograniczonej szerokości menu przechodzi do przycisku „Main menu”, który renderuje te same węzły, command ID i powody niedostępności. Żadna pozycja menu nie znika tylko wskutek breakpointu.

Transport globalny korzysta z jednego renderera dla stanu z sesją i bez niej. Pełny command ID pozostaje w `data-command-id`; `data-run-control` określa prezentację run/pause/stop/skip. Connection, execution i readiness pozostają odrębnymi osiami informacji. Wąski layout nie usuwa Stop ani dostępu do diagnostyki.

Przycisk zamknięcia obcej instancji ma własne pole co najmniej 24 px i nie nachodzi na nazwę lub port karty. Delete na karcie zamyka wyłącznie kartę, bez Stop; focus wraca do sąsiedniej karty lub Home. Przewijanie listy jest widoczne.

## 2. Workspace Contexts

Top-level contexts are:

- `Workspace`
- `View`
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
| `Geometry` | add primitive, edit primitive parameters, transform, validate geometry, focus primitive display |
| `Mesh` | build selected object, build all, build shared-domain mesh, show quality, show shared-domain report |
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

Geometry menu actions that create or edit objects open inspector drafts and commit through model transactions. Mesh menu actions that build topology submit backend mesh-build commands. The shell must not collapse both flows into one local callback path.

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
