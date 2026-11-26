---
title: Control Room User Guide
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-getting-started-control-room)=
# Control Room User Guide

The **FullMag Control Room** is the interactive browser workspace and authoring companion for the
FullMag micromagnetics platform. Running inside your Docker Compose DEV group (typically at
`http://127.0.0.1:3197`), it pairs a live visual interface with the `ProblemIR` pipeline and runtime
APIs so you can build models, inspect 3D/2D fields, analyze scalar and spectral plots, and watch
live Python sessions (`fm.connect()`) update in real time.

Model edits commit typed authoring transactions and re-lower through the study/`ProblemIR` pipeline;
layout, active tabs, and visualization controls remain client-side UI state. Exported scripts preserve
supported authored models, while {doc}`/frontend/capability-register` tracks Python-only features
that do not expose a dedicated browser editor. Detailed module references live under
{doc}`/frontend/control-room/index`, {doc}`/frontend/inspectors/index`, and
{doc}`/frontend/visualization/index`, and full Python signatures live under {doc}`/python-api/index`.

---

## Start Screen Hub & Multi-Instance Sessions

When no project workspace is active—or when you return via the header **Home** navigation button—the
**Start Screen** serves as the workspace hub:

```{figure} /_static/images/ui/start-screen-hub-overview.png
:alt: FullMag Control Room Start Screen Workspace Hub
:class: fm-ui-figure
:width: 100%

The Start Screen launcher exposes empty FDM/FEM problem creation, benchmark templates, file imports (`.mif`, `.mx3`, `.mph`, `.fms`), recent projects, and active sessions.
```

From the Start Screen you can:

- **Launch a new study**: open an empty **FDM simulation** (`Ctrl+N`), an empty **FEM simulation**
  (`Ctrl+Shift+N`), or browse ready-made benchmarks under **From template** (`Ctrl+T`, saved as
  canonical Python `.py` scripts).
- **Attach to live Python sessions**: sessions created by an external script calling `fm.connect()`
  appear under **Active simulations** with their live lifecycle status pill so you can jump straight
  into the shared 3D/2D workspace.
- **Work across multiple DEV instances**: the header **Instance Tab Strip** lets you switch between
  multiple running FullMag instances and sessions (`/session/<slug>`, `/instance/<port>`) without
  leaving the workspace shell.

```{figure} /_static/images/ui/start-screen-model-templates.png
:alt: Start Screen Model Templates Browser
:class: fm-ui-figure
:width: 100%

Built-in templates (µMAG Standard Problem 4, spin-wave dispersion, FMR, and skyrmion benchmarks) ready to launch into a live session.
```

```{figure} /_static/images/ui/start-screen-python-live-connect.png
:alt: Start Screen showing an active live Python session from fm.connect()
:class: fm-ui-figure
:width: 100%

Active live Python sessions (`fm.connect()`) detected on the runtime and surfaced for interactive inspection.
```

```{figure} /_static/images/ui/multi-instance-session-tabs.png
:alt: Multi-instance session tab strip in the Control Room header
:class: fm-ui-figure
:width: 100%

Multi-instance session switching across running Control Room ports and workspaces.
```

---

## Workspace Layout & Themes

Inside an open project or active session, the Control Room organizes controls around a single
unified workspace shell shared by both FDM and FEM studies:

```{figure} /_static/images/ui/control-room-workspace-overview.png
:alt: FullMag Control Room Workspace Overview in Catppuccin Mocha Dark Theme
:class: fm-ui-figure
:width: 100%

Control Room workspace overview in the default **Catppuccin Mocha** (dark) theme.
```

| Region | Component | Primary Purpose |
|---|---|---|
| **Top Bar** | App Menu, Session Indicator & Theme Switcher | Navigate Home, switch multi-instance tabs, open Command Search (`Ctrl+Shift+P`), monitor session connectivity, control global Run/Pause/Stop transport, and toggle themes. |
| **Top Ribbon** | Ribbon Toolbar Strip | Contextual tabs (`Workspace`, `View`, `Geometry`, `Materials`, `Physics`, `Mesh`, `Study`, `Results`, plus contextual `Analysis` when inspecting Results; placeholder preview tabs such as `Definitions` and `Automation` stay hidden when they have no active non-preview actions). |
| **Left Dock** | Semantic Explorer Panel | Navigate seven dedicated explorer tabs (`Model`, `Resources`, `Results`, `Jobs`, `Diagnostics`, `Helper`, `Errors`). |
| **Center Stage** | 3D Viewport / 2D Planar Field Map / Split Plots | WebGL 3D vector & mesh canvas, 2D planar slice inspector, and optional companion analysis viewports. |
| **Right Dock** | Contextual Inspector Panel | Property editor for the selected Explorer node with explicit draft-and-apply isolation. |
| **Bottom Dock** | Footer Analysis & Telemetry | Tabbed workspace footer hosting `Telemetry`, `Diagnostics`, `Operations`, `Engine`, `Logs`, `Problems`, and `Quick Chart`. |
| **Footer Bar** | Status & Governance Strip | Continuous session connection dot, WebSocket realtime status, status freshness, resolved engine/device lane, mesh state, and simulation method badge. |

Use the **Theme Switcher** in the top-right header (or Command Search) to switch instantaneously
between **Catppuccin Mocha** (dark) and **Catppuccin Latte** (light):

```{figure} /_static/images/ui/control-room-light-latte-overview.png
:alt: FullMag Control Room Workspace Overview in Catppuccin Latte Light Theme
:class: fm-ui-figure
:width: 100%

The same unified workspace rendered in **Catppuccin Latte** (light) theme.
```

---

## Ribbon Toolbar Strip & Command Search

The **Ribbon Toolbar Strip** groups modeling, physics, meshing, study, and visualization actions
across active tabs (`Workspace`, `View`, `Geometry`, `Materials`, `Physics`, `Mesh`, `Study`,
`Results`, plus contextual `Analysis` when inspecting frequency-domain or saved result nodes).
`ribbonTabHasContent` hides tabs whose only contributions are `preview: true` placeholders (such as
`Definitions` and `Automation`), and remaining controls respect active session capabilities so
FEM-only mesh actions stay hidden or gated when working in an FDM study.

### Geometry, Physics, and Canonical Python Export

```{figure} /_static/images/ui/ribbon-tabs-geometry.png
:alt: Control Room Geometry Ribbon Tab
:class: fm-ui-figure
:width: 100%

The **Geometry** tab groups primitive creation (`Box`, `Thin Film`, `Cylinder`, `Sphere`, `Ellipsoid`, `Cone`, `Torus`, `Polygon Prism`, `Import STL…`), `AC/DC · Antennas` (`Microstrip`, `CPW`), `Boolean` (`Union`, `Subtract`, `Intersect`, `Imprint Regions`), `Modify` (`Duplicate`, `Array 3D`, `Split by Plane`, `Extract Operand`), `Transform` (`Move`), `Lifecycle` (`Realize Geometry`, `Mesh Selected`, `Validate`), and camera focus commands (`Focus Selected`, `Frame All`).
```

- **Primitives, Antennas, Booleans & Modifiers**: Create parametric ferromagnetic bodies (`Box`, `Thin Film`, `Cylinder`, `Sphere`, `Ellipsoid`, `Cone`, `Torus`, `Polygon Prism`), import STL surfaces (`Import STL…`), place microwave antennas (`Microstrip`, `CPW`), compose CSG operations (`Union`, `Subtract`, `Intersect`, `Imprint Regions`), or apply modifiers (`Duplicate`, `Array 3D`, `Split by Plane`, `Extract Operand`). Full programmatic CSG and CAD import workflows remain available in Python ({doc}`/python-api/geometry/boolean-operations` and {doc}`/python-api/geometry/imported-geometry`).
- **Transforms, Lifecycle & Focus**: Translate objects interactively with Ribbon `Move` (`W`), author center translation, Euler XYZ rotation, pivot, and scale/bake in the Geometry Inspector **Placement** tab, run `Realize Geometry`, `Mesh Selected` (FEM), or `Validate`, and frame objects in the 3D viewport (`Focus Selected`, `Frame All`).

```{figure} /_static/images/ui/ribbon-tabs-physics.png
:alt: Control Room Physics Ribbon Tab
:class: fm-ui-figure
:width: 100%

The **Physics** tab configures core/global interactions (`Add Physics`, `Global Physics` including `Field Drive` and `Mask Antenna`), spin transport / interface resources, and optional terms (`Add ABL`, `Frozen Spins`).
```

- **Micromagnetic Interactions**: Add and inspect Heisenberg exchange $A_{\text{ex}}$,
  demagnetization (FDM FFT convolution or FEM Poisson airbox/BEM), external Zeeman drives
  $\mathbf{H}_{\text{ext}}(t)$ and mask antennas, uniaxial/cubic anisotropy, bulk/interfacial DMI,
  spatial absorbing boundaries (`Add ABL`), frozen spins, and spin-transport resources
  (STT/SOT/SHE and spin interfaces), bounded by the resolved lane capabilities.

```{figure} /_static/images/ui/ribbon-tabs-automation-python.png
:alt: Control Room File menu showing Save canonical copy as for canonical Python script export
:class: fm-ui-figure
:width: 100%

Canonical Python export via **File -> Save canonical copy as...**, pairing with `fm.export_script()` in external `fullmag.live` sessions ({doc}`interactive-python`). Placeholder `Automation` ribbon items marked `preview: true` stay hidden via `stripRibbonPlaceholders`.
```

### Command Search (`Ctrl+Shift+P`)

Click **Command search** in the top header or press **`Ctrl + Shift + P`** to open the global
command palette and filter workspace commands, panel toggles, camera framing actions, and theme
switches by title, group, shortcut, or command ID:

```{figure} /_static/images/ui/command-palette-ctrl-k.png
:alt: Control Room Command Search Modal
:class: fm-ui-figure
:width: 100%

Global Command Search overlay triggered from the top bar or via `Ctrl+Shift+P`.
```

---

## Semantic Explorer Panel

The **Explorer Panel** on the left provides seven tabs—**Model**, **Resources**, **Results**,
**Jobs**, **Diagnostics**, **Helper**, and **Errors**—keeping structural authoring, compute
artifacts, job history, guided assistance, and structured errors strictly separated:

```{figure} /_static/images/ui/explorer-tree-structure.png
:alt: Control Room Semantic Explorer Tree Panel
:class: fm-ui-figure
:width: 360px

Hierarchical **Model** tree displaying geometry objects, material zones, physical interactions, meshing policies, ordered study stages, and monitors.
```

1. **Model**: Hierarchical model tree covering **Objects** (with CSG operand trees and sub-regions),
   **Materials**, **Physics** terms and couplings, **Discretization & Mesh**, **Study & Ordered
   Stages**, and configured **Outputs / Planar Monitors**.
2. **Resources**: Shared domain manifests, material libraries, field/quantity catalogs, and session
   assets.
3. **Results**: Current run outputs alongside browsable **Saved Results** history with comparison
   and playback controls.
4. **Jobs**: Active and completed mesh builds, stage commands, and compute queue history.
5. **Diagnostics**: Live telemetry, solver profiling summaries, and readiness diagnostics.
6. **Helper**: Guided workflow checks and next-step readiness recommendations.
7. **Errors**: Aggregated session errors with direct navigation to the affected object, stage, or
   diagnostic entry.

Selecting any node in the Explorer updates the **Inspector Panel** on the right without losing
uncommitted edits elsewhere in the model.

---

## Visualization: 3D Viewport, 2D Planar Field Maps, & Analysis Plots

The center canvas switches smoothly between the 3D WebGL scene, the 2D Planar Field Map, and
split/companion scientific chart panels.

### Interactive 3D WebGL Viewport

```{figure} /_static/images/ui/viewport-3d-interactive.png
:alt: Control Room 3D WebGL Viewport Showing Vector Glyphs and Colormaps
:class: fm-ui-figure
:width: 100%

The Three.js WebGL 3D viewport displaying normalized magnetization glyphs, surface color projection, orientation cube HUD, and colorbar legend.
```

- **Vector Glyphs & Field Quantities**: Visualize binary-streamed `FMVP` fields ($\mathbf{m}$,
  $\mathbf{H}_{\text{eff}}$, $\mathbf{H}_{\text{demag}}$, spin accumulation, or mode profiles)
  colored by component ($m_x, m_y, m_z$) or magnitude using scientific colormaps (**viridis**,
  **plasma**, **coolwarm**, **hsv**).
- **Surface Projection Modes**: Switch between direct nodal interpolation, boundary surface faces,
  or depth-averaged projections, and toggle perspective/orthographic projection from the **View**
  ribbon.
- **FEM Meshes & Poisson Airbox**: Inspect conformal tetrahedral bodies together with surrounding
  FEM Poisson airbox extents and wireframe boundaries:

```{figure} /_static/images/ui/viewport-3d-fem-mesh-airbox.png
:alt: Control Room 3D Viewport Displaying FEM Mesh and Poisson Airbox Boundary
:class: fm-ui-figure
:width: 100%

Conformal tetrahedral ferromagnet mesh paired with the exterior FEM Poisson airbox wireframe.
```

### 2D Planar Field Map

Switch to the **Planar 2D** view to cut live `XY`, `XZ`, or `YZ` sections across FDM grids or FEM
tetrahedral volumes with streamline, contour, vector-glyph, mesh, and line-profile measurement tools:

```{figure} /_static/images/ui/planar-2d-field-map-overview.png
:alt: Control Room 2D Planar Field Map View
:class: fm-ui-figure
:width: 100%

2D Planar Field Map showing cross-section controls, layer visibility toggles, vector/contour overlays, and snapshot scrubbing.
```

### Live Charts, Hysteresis Loops, & Spectral Plots

Bottom-docked and companion ECharts views monitor live time-domain dynamics, hysteresis branches,
and FEM eigenmode dispersion / driven frequency response:

```{figure} /_static/images/ui/charts-live-time-series.png
:alt: Control Room Live Time-Series Scalar Plots
:class: fm-ui-figure
:width: 100%

Real-time streaming scalar trajectories ($\langle m_x \rangle, \langle m_y \rangle, \langle m_z \rangle$ and magnetic energies) during an LLG run.
```

```{figure} /_static/images/ui/charts-hysteresis-loop-playback.png
:alt: Control Room Hysteresis Loop and Playback Inspector
:class: fm-ui-figure
:width: 100%

Interactive hysteresis curve $M(H)$ with field-step playback and branch inspection.
```

```{figure} /_static/images/ui/charts-dispersion-and-fmr-spectrum.png
:alt: Control Room Spin-Wave Dispersion and FMR Frequency-Response Plots
:class: fm-ui-figure
:width: 100%

FEM modal dispersion $\omega(k)$ and driven frequency-response susceptibility spectra.
```

---

## Semantic Inspector & Interactive Stage Re-Execution

The **Inspector Panel** on the right edits properties of the active Explorer selection using an
explicit **Draft -> Save / Apply -> Revision** lifecycle so edits never silently corrupt an in-flight
solve:

```{figure} /_static/images/ui/inspector-panel-draft.png
:alt: Control Room Inspector Panel in Draft Mode
:class: fm-ui-figure
:width: 380px

Inspector panel showing draft isolation before committing model mutations to the runtime session.
```

```{figure} /_static/images/ui/inspector-geometry-and-csg.png
:alt: Control Room Geometry Inspector Panel showing Primitive Geometry controls
:class: fm-ui-figure
:width: 380px

Geometry inspector configuring primitive shape dimensions (`Kind: box`, `Size` X/Y/Z), `Placement`, and explicit `Revert` / `Apply` draft actions.
```

1. Editing fields puts the panel into an explicit **Draft** state without mutating the running
   simulation.
2. Saving/applying submits an atomic transaction to the backend, updates the scene revision, and
   invalidates dependent mesh or study resources cleanly.
3. Selecting any stage under **Study** opens `StageInspectorFrame` and `StageInitialStateSelector`:

```{figure} /_static/images/ui/inspector-study-stages-and-rerun.png
:alt: Control Room Study Stage Inspector with Initial Magnetization and Re-Run Controls
:class: fm-ui-figure
:width: 380px

Study stage inspector configuring stopping tolerances, output cadence, initial magnetization seed selection, and interactive stage re-execution.
```

Within the **Execution** section of a stage inspector, you can choose how the stage initializes
(`From the configured Study flow`, `Study initial texture (m₀)`, `Latest compatible state at start`,
prepared preview magnetization, or a pinned saved stage result), compare authored recipes against
saved results, preview prior magnetization states in the 3D viewport, and re-run that stage without
rewriting the entire script.

---

## Footer Status Bar & Governance

The **Status Bar** along the bottom edge summarizes live runtime telemetry and acts as a one-click
launcher into the **Telemetry**, **Operations**, **Diagnostics**, **Engine**, and **Quick Chart**
footer drawers:

```{figure} /_static/images/ui/status-bar-footer.png
:alt: Control Room Footer Status Bar
:class: fm-ui-figure
:width: 100%

Footer status bar reporting session state, runtime version, mesh status, WebSocket connection health, status freshness, resolved backend/device lane, and active simulation method.
```

- **Session & Runtime Identity**: Displays current lifecycle state, session name, runtime bundle
  version, and active mesh status badge.
- **Realtime & Freshness Axes**: Independently distinguishes the WebSocket stream health (`Realtime`)
  from HTTP status resource freshness (`Status`).
- **Resolved Engine & Method Badges**: Displays the resolved engine/device lane (for example `FDM`
  or `FEM`, `CPU` or `GPU`) alongside the active solver method, plus a quick **Compute** call to
  action when a script or model is awaiting compute. Published telemetry reflects the metrics
  reported by the active runtime and should not be read as total system RAM or VRAM measurement.

---

## Source-code index

- `apps/control-room/src/kernel/layout/WorkspaceShellClient.tsx` and `AppMenuBar.tsx` — root
  workspace shell, Start Screen toggle, theme switcher (`Catppuccin Mocha` / `Latte`), Command Search
  (`Ctrl+Shift+P`), and header session controls.
- `apps/control-room/src/modules/start/StartScreen.tsx` and `home/ActiveSessions.tsx` — Start
  Screen workspace hub, template browser, and `fm.connect()` active simulation list.
- `apps/control-room/src/modules/ribbon/ribbonContributions.tsx` — ribbon tab definitions and
  capability-gated actions.
- `apps/control-room/src/modules/explorer/ExplorerTabBar.tsx` and `explorerTabs.ts` — seven
  Explorer tabs (`Model`, `Resources`, `Results`, `Jobs`, `Diagnostics`, `Helper`, `Errors`).
- `apps/control-room/src/modules/inspector/inspectors/objects/geometry/ObjectGeometrySpec.tsx`,
  `apps/control-room/src/modules/inspector/inspectors/study/StudyRootSpec.tsx`,
  `apps/control-room/src/modules/inspector/panels/StudyStageDraftEditor.tsx`, and
  `apps/control-room/src/modules/inspector/panels/stages/StageInitialStateSelector.model.ts` —
  explicit draft-and-apply declarative spec editors and interactive stage re-execution.
- `apps/control-room/src/modules/status-bar/StatusBarModule.tsx` — live status strip and footer
  diagnostics launchers.
- {doc}`/frontend/capability-register` — authoritative boundary between implemented UI editors and
  Python-only features.
