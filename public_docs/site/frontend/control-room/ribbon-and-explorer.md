---
title: Ribbon, Multi-Instance Tabs & Semantic Explorer
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-control-room-ribbon-and-explorer)=
# Ribbon, Multi-Instance Tabs & Semantic Explorer

The Control Room shell organizes global navigation and problem construction around four persistent
chrome regions: the **Application Menu Bar** (`AppMenuBar`), the **Multi-Instance Session Tab
Strip** (`InstanceTabStrip`), the **Contextual Ribbon** (`RibbonModule`), the **Semantic Explorer**
(`ExplorerModule`), and the **Footer Dock & Status Bar** (`FooterModule`, `StatusBarModule`).

## Multi-Instance Session Tabs and URL Routing

`InstanceTabStrip` (`apps/control-room/src/kernel/layout/InstanceTabStrip.tsx`) and `tabRoutes.ts`
manage navigation between Home, the local session, and sibling Control Room instances running on
other local ports:

| Route pattern | Meaning | Tab behavior |
|---|---|---|
| `/home` | Start Screen workspace hub | Opens Home overlay without stopping the active local session |
| `/session/<slug>` | Active simulation workspace (`MAX_SLUG_LENGTH = 96`) | Displays the active session with a live status dot (`sessionTone`) |
| `/session/<slug>?port=<port>` | Remote/sibling instance scoped beneath a session route | Opens or focuses an instance tab backed by `instanceOrigin` |
| `/instance/<port>` | Direct sibling instance tab (`port` in `1..65535`) | Keyboard-closable (`Delete` or `×`) without affecting the underlying backend |

Sibling instance tabs render in addition to Home and the host's current session so operators can
monitor parallel runs (e.g., separate Docker Compose development groups) from one browser window.

```{image} /_static/images/ui/multi-instance-session-tabs.png
:alt: Top instance tab strip showing Home, current active session tab, and sibling instance port tabs
:align: center
:width: 100%
```

## Application Menu Bar, Run Controls, and Command Palette

`AppMenuBar` (`apps/control-room/src/kernel/layout/AppMenuBar.tsx`) provides a WAI-ARIA menubar
(`File`, `Edit`, `View`, `Simulation`, `Tools`, `Help`), quick-action buttons (`Save Project`,
`Apply Inspector`, `Undo`, `Redo`), header run transport (`Compute Study`, `Pause`, `Stop`, `Skip`),
a Catppuccin theme switcher (`ThemeSwitcher` toggling Mocha Dark and Latte Light),
`ProjectDocumentStatus`, `ReadinessHelperHeaderControl`, and modal utility dialogs (`Material Library`,
`Data Preview`, `Communication`, `Diagnostic Recorder`, `Visualization Registry`).

The **Command Palette** (`CommandPaletteModule`) opens via **Command search** (`Ctrl+Shift+P`, or
`Edit -> Command Palette`), filtering registered non-input `CommandContribution` entries by ID,
title, group, category, and shortcut, and displaying live enabled/active status plus inline
`Detail` inspection when available.

```{image} /_static/images/ui/command-palette-ctrl-k.png
:alt: Control Room searchable Command Palette modal listing workspace, simulation, geometry, and layout commands
:align: center
:width: 100%
```

## Contextual Ribbon Architecture

`RIBBON_TABS` (`apps/control-room/src/modules/ribbon/ribbonTypes.ts`) defines ten canonical tab IDs
plus one contextual analysis tab (`ANALYSIS_CONTEXT_TAB_ID = "analysis-context"`). At render time,
`stripRibbonPlaceholders` (`ribbonContributions.tsx`) removes placeholder entries flagged with
`preview: true`, and `ribbonTabHasContent` displays only tabs that carry live executable commands.
As a result, the live tab strip currently renders eight core tabs—**Workspace** (`home`), **View**,
**Geometry**, **Materials**, **Physics**, **Mesh**, **Study**, **Results**—plus the contextual
**Analysis** tab when active, while **Definitions** (`definitions`) and **Automation**
(`automation`) remain defined in the tab model but hidden from the strip until their commands leave
preview.

### Workspace, View, and Geometry

- **Workspace (`home`)**: `Project` (`Save Field`, `Load Field`) and `Workspace` (`Rotation mode`: Free camera / Object orbit; `Panel` visibility checkboxes for Explorer, Inspector, Bottom dock).
- **View (`view`)**: Global 3D display quality profiles (`Interactive Lite`, `Interactive`, `Balanced`, `Figure`, `Capture`), **Capture current frame** export (including viewport/transparent background and super-sampled scale), `Surface`, `Texture` (`Solid`, `HSL orientation`, component X/Y/Z, Magnitude $|m|$, colormap), `Quantity`, `Vectors` density/component/domain/color, `Airbox`, `Mesh View` + 3D trim (`X`, `Y`, `Z`), orientation widgets (`3D Box`, `HSL Sphere`), 2D slice monitor controls (`Monitor`, `Open`, 16 planar toolbar actions, `Export`, `Data`), selected-object display overrides, manipulation (`Control`, `Inspect`, `Gizmo`), view snapshot export, and `Display` (`Mode`, `Camera settings`, `Ortho`, `Panels`, `Frame`, `Topography`).
- **Geometry (`geometry`)**: `Create` shapes (`Box`, `Cylinder`, `Sphere`, `Microstrip`, `CPW`, `Thin Film`), `Transform` (`Move` shortcut `W`; rigid `Rotate`/`Scale` remain disabled with `PROBLEM_IR_03_RIGID_TRANSFORM_REASON`), `Lifecycle` (`Build Geometry`, `Apply Draft`, `Build Mesh` [hidden on FDM sessions], `Validate`), and camera focus (`Focus Selected` `F`, `Frame All` `Shift+F`).

```{image} /_static/images/ui/ribbon-tabs-geometry.png
:alt: Control Room Ribbon Geometry tab showing primitive creation, transform Move tool, lifecycle build/validate actions, and focus controls
:align: center
:width: 100%
```

### Materials and Mesh

- **Materials (`materials`)**: Initial magnetization presets (`Uniform`, `Random`, `Vortex`; `Bloch Sky` and `Néel Sky` are presently `preview`-gated). Core scalar material and anisotropy parameters are authored in the Semantic Inspector (`ObjectMaterialPanel`).
- **Mesh (`mesh`)**: Discretization-aware `Build` group (`Build Grid` in FDM sessions; `Build` for selected object, `Build All` shared domain, and `Statistics` in FEM sessions), `Element Size`, `Quality`, and `Mesh View` toggles (`Inspector`, `3D View`, `Pipeline`).

```{image} /_static/images/ui/ribbon-tabs-materials-and-mesh.png
:alt: Control Room Ribbon Materials and Mesh controls showing discretization-aware build, size, quality, and view actions
:align: center
:width: 100%
```

### Physics

- **Physics (`physics`)**: Dynamically populated from `interactionSpecsForDiscretization` and active lane capabilities (`resolveActiveLaneOperation`), offering **Add Physics** (including `Spin Transport / SHE`, `Spin Interface`, and active micromagnetic interactions), **Global Physics** (including `Field Drive`), and **Frozen Spins**.

```{image} /_static/images/ui/ribbon-tabs-physics.png
:alt: Control Room Ribbon Physics tab displaying lane-aware micromagnetic interactions, global field drives, spin transport, and frozen spins
:align: center
:width: 100%
```

### Study, Results, Contextual Analysis, and Python Canonical Export

- **Study (`study`)**: `Overview` / `Stages` navigation, stage creation (`Relax`, `Field Drive`, `Table`, `Autosave`, `FFT`, `Run`, `Hysteresis`, `Eigenmodes`, `Frequency`, `Save State`), `Remove`, and execution controls (`Compute Fields`, `Compute Energies`, `Prepare`, `Build + Study`, `Cancel Build + Study`, `Compute` `F5`, `Pause`, `Resume`, `Save Checkpoint`, `Restore`, `Restore Runtime State`, `Export State`, `Discard`, `Stop`, `Skip stage`).
- **Results (`results`)**: Spatial `Quantity` switchers (`M`, `H_eff`, `H_demag`, `H_ex`, `H_anis`, `Torque`, `Energy`, plus dynamic `Mode` toggle when inspecting an eigenmode or response overlay) and `Export` (`VTK`, `Save State`).
- **Analysis Contextual Tab (`analysis-context`)**: Surfaces `Chart`, `3D field`, and `Chart + 3D` view-mode switches alongside `Stop animation` / `Leave mode view` when a frequency-domain mode or response field is active.
- **Python Script & Canonical Export**: While the dedicated `Automation` (`automation`) ribbon tab stays hidden while its `Sync Script` placeholder is `preview: true`, **File -> Save canonical copy as…** (`workspace.export-python`) in `AppMenuBar` exports the current model as an editable Python script, and live Python sessions integrate continuously over HTTP/WebSocket.

```{image} /_static/images/ui/ribbon-tabs-study-and-results.png
:alt: Control Room Ribbon Study and Results tabs showing stage additions, execution controls, spatial field selectors, and VTK export
:align: center
:width: 100%
```

```{image} /_static/images/ui/ribbon-tabs-automation-python.png
:alt: Control Room File menu showing New Problem, New Project, Open Project, Restore Runtime State, and Save canonical copy as... for canonical Python export
:align: center
:width: 100%
```

## Five-Tab Semantic Explorer

`ExplorerModule` (`apps/control-room/src/modules/explorer/ExplorerModule.tsx`) and `ExplorerTabBar`
(`ExplorerTabBar.tsx`) organize project entities across five tabs on the left dock:

### 1. Model Tab

The `Model` tree (`ModelTree`) mirrors the canonical semantic hierarchy: study root, global runtime,
`Universe / Airbox`, geometry `Objects` (with nested `Geometry`, `Material`, `Physics`,
`Magnetization`, `Mesh`, `Boundary Faces`, `Regions`, and per-object `Frozen Spins` / `Transport` /
`Antennas`), global `Couplings`, `Planar Monitors`, and the ordered `Stages` pipeline. Selecting
any node routes the right-hand Semantic Inspector to that resource owner.

```{image} /_static/images/ui/explorer-tree-structure.png
:alt: Model Explorer tree displaying semantic hierarchy across objects, materials, physics, regions, couplings, monitors, and study stages
:align: center
:width: 100%
```

### 2. Resources Tab

The `Resources` tab inspects backing session assets, active material definitions, shared-domain
mesh manifests, field/quantity catalogs, and binary resource endpoints without flattening them into
modeling objects.

```{image} /_static/images/ui/explorer-resources-tab.png
:alt: Explorer Resources tab showing session materials, mesh artifacts, and catalog resources
:align: center
:width: 100%
```

### 3. Results Tab

The `Results` tab (`ResultsNavigatorModule`) indexes live and materialized outputs—including time
tables, hysteresis points, eigenmode dispersion branches, FMR frequency sweeps, and saved
`SolutionSet` revisions—allowing direct selection into 2D charts, 3D spatial mode overlays, and
saved playback.

```{image} /_static/images/ui/explorer-results-tab.png
:alt: Explorer Results tab showing time-domain datasets, eigenmodes, frequency sweeps, and saved SolutionSet entries
:align: center
:width: 100%
```

### 4. Jobs and 5. Diagnostics Tabs

The `Jobs` and `Diagnostics` explorer tabs expose active/queued backend commands, FEM mesh build
executions (`current` vs. `latest-successful`), solver preparation checks, and session telemetry or
transport health. Selecting entries here opens corresponding dedicated explorer/runtime inspector
frames.

```{image} /_static/images/ui/explorer-jobs-and-diagnostics-tabs.png
:alt: Explorer Diagnostics tab opened beside the Jobs tab displaying Problem, Health, Capabilities, Solver, Mesh, Frequency Domain, and Performance nodes
:align: center
:width: 100%
```

## Footer Dock and Status Bar

`FooterModule` (`apps/control-room/src/modules/footer/FooterModule.tsx`) hosts seven dockable
operational tabs at the bottom of the workspace:

- **Logs**: Command audit (`CommandAuditTable`) and HTTP/WS transport log (`TransportLogTable`) filterable by `All`/`RX`/`TX` and `HTTP+WS`/`HTTP`/`WS`/`Perf`.
- **Telemetry**: Overview telemetry plus an auto-switching **Antenna** sub-tab when an `antenna_field_solve` stage runs.
- **Diagnostics**: `DiagnosticRecorderFooterPanel` for trace recording and performance export.
- **Engine**: `FooterDiagnostics` showing solver engine metrics and profiler readout.
- **Operations**: `OperationsPanel` paired with `MeshJobsPanel` (published operations and FEM mesh job progress).
- **Problems**: `ProblemsPanel` aggregating preparation blockers, geometry diagnostics, and failed mesh/command notices.
- **Quick Chart**: Embedded `QuickChartResourceView` for immediate scalar inspection without leaving the main canvas.

`StatusBarModule` (`apps/control-room/src/modules/status-bar/StatusBarModule.tsx`) sits beneath
the footer dock and summarizes session lifecycle (clicking opens Telemetry), active session name,
runtime bundle version, mesh status badge (clicking opens Operations),
`SimulationPreparationStatusEntry`, realtime WebSocket connection state, freshness indicator,
progress readout with conditional **Compute** action when awaiting compute, and resolved execution
method/device label.

```{image} /_static/images/ui/status-bar-footer.png
:alt: Control Room Status Bar and Footer Dock displaying Logs, Telemetry, Operations/Mesh Jobs, Problems, and live session telemetry
:align: center
:width: 100%
```

## Routing and Python interoperability

- **Navigation**: `InstanceTabStrip` (`/home`, `/session/<slug>`, `?port=`, `/instance/<port>`), `AppMenuBar`, and `CommandPaletteModule` (`Ctrl+Shift+P`).
- **Command authoring**: `RibbonModule` renders verified commands from `ribbonContributions.tsx` / `ribbonTabViews.tsx` after `stripRibbonPlaceholders`.
- **Selection routing**: `ExplorerModule` (`Model`, `Resources`, `Results`, `Jobs`, `Diagnostics`) drives `Selection` into `InspectorRegistry`, while `FooterModule` and `StatusBarModule` remain observational and diagnostic docks.
- **OpenAPI v2 & Python alignment**: Every Ribbon geometry, material, physics, mesh, and stage action commits via OpenAPI v2 session endpoints mirrored in `packages/fullmag-py`. `File -> Save canonical copy as…` exports an equivalent script, whereas two-way script diffing in the hidden `automation` tab remains `Python-only` (gated behind `preview: true`).

## Source-code index

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| Session & multi-instance tab strip | `apps/control-room/src/kernel/layout/InstanceTabStrip.tsx` | `InstanceTabStrip` |
| Tab URL parsing and port scoping | `apps/control-room/src/kernel/layout/tabRoutes.ts` | `parseTabRoute`, `formatTabRoute` |
| Menubar, quick actions, dialogs | `apps/control-room/src/kernel/layout/AppMenuBar.tsx` | `AppMenuBar` |
| Command Palette overlay | `apps/control-room/src/modules/overlay/CommandPaletteModule.tsx` | `CommandPaletteView` |
| Palette manifest & shortcut | `apps/control-room/src/modules/overlay/manifest.ts` | `overlayManifest` |
| Ribbon tab definitions & placeholder stripping | `apps/control-room/src/modules/ribbon/ribbonContributions.tsx` | `stripRibbonPlaceholders`, `ribbonTabHasContent` |
| Workspace & View ribbon definitions | `apps/control-room/src/modules/ribbon/ribbonTabViews.tsx` | `homeTab`, `viewTab` |
| Five-tab Semantic Explorer | `apps/control-room/src/modules/explorer/ExplorerModule.tsx` | `ExplorerModule` |
| Explorer tab switcher | `apps/control-room/src/modules/explorer/ExplorerTabBar.tsx` | `ExplorerTabBar` |
| Bottom dock tabs & antenna auto-focus | `apps/control-room/src/modules/footer/FooterModule.tsx` | `FooterModule` |
| Operations & Mesh Jobs dock panel | `apps/control-room/src/modules/footer/OperationsProblemsPanel.tsx` | `OperationsPanel`, `ProblemsPanel` |
| Bottom telemetry & state bar | `apps/control-room/src/modules/status-bar/StatusBarModule.tsx` | `StatusBarModule` |
