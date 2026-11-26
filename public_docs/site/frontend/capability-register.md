---
title: Control Room capability register
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-capability-register)=
# Control Room capability register

This register tracks which Control Room workflows are implemented for interactive browser authoring,
which are read-only inspection views, and which remain Python-only. A capability supported in
`packages/fullmag-py` or `ProblemIR` is listed as browser-authored only when a dedicated panel and
commit transaction exist in `apps/control-room`.

## 1. How to read the status

| Status | Browser support |
|---|---|
| `implemented` | Implemented in Control Room: the route, panel fields, and commit transaction exist in `apps/control-room/src`. |
| `partial` | A dedicated panel or editor covers an explicit subset of the Python/API surface; unexposed options remain `Python-only`. |
| `inspection-only` | Read-only view: the UI renders resolved runtime, mesh, or result artifacts without mutating the underlying model. |
| `Python-only` | Not exposed for interactive UI authoring; configure this capability in Python (`packages/fullmag-py`). |

## 2. Current Control Room v2 routes

| Capability area | Control Room route / shell surface | Current status | Source owner |
|---|---|---|---|
| Start Screen, templates, import, recent scripts and results & sibling instances | `/home` (`StartScreen` rail sections: `Overview`, `Templates`, `Import`, `Learn`, `Docs`, `Settings`, `About`, collapsible bottom `ComputeEnvironmentWidget` dock & `StartStatusBar`; `/instance/<port>`, `?port=`) | `implemented` (includes STL import & read-only script model preview; desktop `Open script…` gated on script host availability) | `StartScreen`, `LaunchTiles`, `OtherInstances`, `tabRoutes.ts` |
| Workspace chrome, multi-instance tabs, Mocha/Latte themes, 7-tab Explorer & Command Palette | Top header (`AppMenuBar`, `InstanceTabStrip`, `ThemeSwitcher`, `Ctrl+Shift+P` Command search) & Explorer rail (`Model`, `Resources`, `Results`, `Jobs`, `Diagnostics`, `Helper`, `Errors`) | `implemented` (`Definitions` & `Automation` ribbon tabs remain hidden while preview-only) | `InstanceTabStrip`, `AppMenuBar`, `CommandPaletteModule`, `RibbonModule`, `EXPLORER_TABS` |
| Parametric primitives, STL import, CSG booleans, Array 3D & Placement transforms | `Model Explorer -> Objects -> <object> -> Geometry` (Geometry / Placement tabs) & Ribbon `Geometry` (`Create`, `Boolean`, `Modify`, `Move` `W`) | `implemented` (9 shapes + `Import STL…`, live `Union`/`Subtract`/`Intersect`/`Imprint Regions`, `Duplicate`/`Array 3D`/`Split by Plane`/`Extract Operand`, Placement Euler XYZ rotation/pivot/scale/bake; ribbon `Rotate`/`Scale` buttons remain disabled) | `GeometryObjectInspectorPanel`, `GeometryStackEditor`, `Array3DLatticeTableSection` |
| Magnetic materials, absorbing boundary ramps & topological charge | `Model Explorer -> Objects -> <object> -> Magnetic Parameters`, **Physics → Add ABL**, `Topological Charge` extension | `partial` (scalar $M_{\text{sat}}, A_{\text{ex}}, \alpha, K_{u1}$, axis, material library create/assign, opt-in material physics activation, independent absorbing layers, topological charge extension; general spatial material callbacks remain `Python-only`). See {doc}`/frontend/inspectors/absorbing-boundaries` | `ObjectMaterialInspectorPanel`, `ObjectAbsorbingBoundaryInspectorPanel`, `TopologicalChargeExtensionPanel` |
| Sub-object spatial regions & nested overrides | `Model Explorer -> Objects -> <object> -> Regions -> <region>` | `partial` (bounds-checked shapes, scalar material/mesh/texture overrides implemented across declarative region specs) | `RegionsCollectionInspectorPanel`, `ObjectRegionOverviewInspectorPanel`, `ObjectRegionMagneticParametersInspectorPanel`, `ObjectRegionMeshInspectorPanel` |
| Initial magnetization textures, transforms & OVF/NPZ field import | `Model Explorer -> Objects -> <object> -> Magnetization` (or region texture) & Ribbon `Materials` (`More Presets`, `Load from field file…`, `Texture Transform`) | `implemented` for all 20 `MAGNETIZATION_TEXTURE_PRESETS` (`uniform`, `random`, `vortex`, `antivortex`, skyrmions, `bimeron`, `skyrmion_lattice`, domain walls, `artificial_spin_ice`, `helical`, `conical`, `spiral`, `hopfion*`, `bloch_point`), through-axis extent, `tile_period`, transforms & OVF/NPZ import; custom Python callable textures remain `Python-only` | `MagneticTextureInspectorPanel`, `texturePresets.ts` |
| Local & global magnetic interactions, field drives, mask antennas & couplings | `Model Explorer -> Objects -> <object> -> Physics`, `Couplings`, `Field Drives` | `partial` (lane-gated exchange/DMI/anisotropy/Zeeman/RKKY/demag, `sinc`/`sinusoidal`/`piecewise_linear` field drives, `Mask Antenna`, coupling enable/delete) | `ObjectPhysicsInspectorPanel`, `FieldDriveInspectorPanel`, `CouplingInspectorPanel` |
| Frozen spins constraints | `Model Explorer -> Objects -> <object> -> Constraints` (`Frozen Spins`) | `implemented` for selection expressions, membership/reference policy, 3D preview & activation | `FrozenSpinsInspectorPanel` |
| RF antennas, conductors, ports & EM basis preview | `Model Explorer -> Objects -> <object> -> Antennas` (11 dedicated antenna spec routes) | `implemented` for canonical field drives (`sinc`, `sinusoidal`), conductor placement, terminals, port composition, piecewise tables & field-basis preview | `AntennaOverviewInspectorSpecPanel`, `inspectors/objects/antenna/*` |
| Spin/current transport, STT/SOT, Oersted & spin interfaces | `Model Explorer -> Transport / Spin / Interfaces` & Ribbon `Physics` | `implemented` for `current_transport`, `spin_transport`, Zhang-Li/Slonczewski/Prescribed SOT, Oersted bindings, & `tet4` spin-interface normal verification | `CurrentTransportInspectorPanel`, `SpinTransportInspectorPanel`, `SpinTorqueInspectorPanel`, `OerstedFieldInspectorPanel`, `SpinInterfaceInspectorPanel` |
| FEM object, airbox & region mesh policy authoring | `Model Explorer -> Mesh`, `Objects / Universe / Regions -> Mesh` & Ribbon `Mesh` | `implemented` for advertised presets, sizes, `swept_prism` layer counts, airbox grading/curvature/narrow-region & builds (`swept_hex` disabled) | `MeshRootInspectorSpecPanel`, `ObjectMeshInspectorSpecPanel`, `AirboxMeshParametersInspectorSpecPanel`, `ObjectRegionMeshInspectorPanel` |
| FDM structured grid sizing, build & quality/history reports | `Model Explorer -> Mesh` (`Discretization & Mesh`), `Grid / Layer / Cell` & Footer `Operations` | `implemented` for interactive FDM cell size / cell count ($N_x,N_y,N_z$), Single 3D vs Multilayer Z-slices, live $l_{\mathrm{ex}}$ guard, 7-smooth FFT snap & `grid.build-fdm`; `FMRM`/`FMBM` masks and FEM quality/history histograms remain `inspection-only` | `MeshRootInspectorSpecPanel`, `FdmGridInspectorSpecPanel`, `MeshQualityInspectorSpecPanel`, `MeshQualityStatisticsView` |
| Study profile, ordered stages & safe Apply + Re-Run | `Model Explorer -> Study`, `Execution`, `Stages -> <stage>`, `Recovery` | `partial` (global backend/device/precision, compute scopes, editable `relax`/`run`/`hysteresis`/`eigenmodes`/`frequency_response`/`fft_response`/`mask_field_drive`/`autosave*`/`save_state`/`change_device`, `executeStageAfterApply` pinning; complex Python closures read-only via `ActionStageFallbackInspectorPanel`) | `StudyRootInspectorPanel`, `StudyExecutionInspectorPanel`, `StudyStagesInspectorPanel`, `StudyStageDraftEditor`, `studyStageApplyAndRun` |
| 3D WebGL viewport, clipping, studio HDRI, prepared preview & PNG export | `Viewport3DModule` & `Viewport3DSettingsDialog` | `implemented` (FDM/FEM adapters, projections, prepared-field preview without starting solver, instanced vectors, clipping, 5 quality profiles, offline softbox PMREM HDRI, `1×/2×/4×` transparent/view RGBA16F capture) | `Viewport3DModule`, `Viewport3DSettingsDialog`, `viewport3dImageExport.ts` |
| Planar monitors & interactive 2D Field Map | `Planar Monitors`, `FieldMapModule` & `PlanarToolbar` | `implemented` (draft plane creation with 3D gizmos, `XY`/`XZ`/`YZ`, zoom/crop/inspect/profile/measure tools, streamlines/contours, `PlanarFieldLayerList`, `PlanarMultisliceGrid`, `PlanarSnapshotNavigator`, PNG/CSV export) | `FieldMapModule`, `PlanarMonitorDraftTemplatePanel`, `PlanarMonitorTemplatePanel` |
| Live ECharts, hysteresis playback, dispersion & FMR spectral plots | `LiveChartsModule`, `AnalysisPlotsModule`, `Results` Explorer, `Footer -> Quick Chart` | `implemented` (live traces, hysteresis snapshot cursor sync, $\Gamma$ FFT, $S(k,f)$ heatmap with cuts, eigenmode dispersion & FMR peaks + 3D phase-animated spatial overlays) | `LiveChartsView`, `AnalysisPlotsView`, `EigenDispersionInspectorPanel`, `FmrResponseSweepInspectorPanel`, `ModeVisualizationInspectorPanel` |
| Saved SolutionSet browser & offline playback | `Explorer -> Results` (`SavedResultsBrowser`) & `SavedResultsPlaybackViewport` | `implemented` (`inspection-only` multi-run tables, materialized fields, playback timeline, comparison overlays) | `SavedResultsBrowser`, `MaterializedDatasetTemplateInspectorPanel` |
| Runtime, provenance, logs, problems & diagnostic recording | `Model Explorer -> Runtime`, `Jobs`, `Diagnostics`, Footer Dock & `StatusBarModule` | `inspection-only` (displays requested vs. resolved backend/device, transport audit, `RunProgressPanel`, `ProblemsPanel`, telemetry `Overview`/`Antenna`/`Eigensolve`, preparation blockers) | `RuntimeResourceInspectorPanel`, `FooterModule`, `RunProgressPanel`, `StatusBarModule` |

## 3. Python-only and gated capabilities

The following capabilities do not currently expose an authoring editor in `apps/control-room` and
are authored through the Python DSL ({doc}`/python-api/index`):

| Python / ProblemIR surface | Browser support |
|---|---|
| Direct standalone `fm.Problem` / raw `ProblemIR` JSON authoring | `Python-only`: the Control Room authors session-backed studies rather than standalone IR documents. |
| Ribbon `Rotate` / `Scale` 3D viewport gizmo buttons | Disabled on the Geometry Ribbon with `PROBLEM_IR_03_RIGID_TRANSFORM_REASON`; author Euler XYZ rotation, pivot, and scale/bake via the Geometry Inspector **Placement** tab or Python. |
| Two-way in-UI Python script synchronization (`Automation` tab `Sync Script`) | `Python-only`: the `Automation` ribbon tab is hidden (`preview: true`); use `File -> Save canonical copy as…` or `fullmag.live` (`fm.connect()`). |
| Arbitrary callable spatial material fields, callable magnetization textures & custom Python stage closures | `Python-only`: scalar, preset, and OVF/NPZ forms apply in the UI; functional Python expressions remain Python-authored (read-only stage summary via `ActionStageFallbackInspectorPanel`). |
| `swept_hex` mesh strategy and unsupported exact layer counts | `Python-only`: disabled in `ObjectMeshInspectorSpecPanel` until backend and UI gating enable them. |

## Source-code index

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| Workspace start hub | `apps/control-room/src/modules/start/StartScreen.tsx` | `StartScreen` |
| Ribbon commands & preview gate | `apps/control-room/src/modules/ribbon/ribbonContributions.tsx` | `stripRibbonPlaceholders` |
| Seven-tab Explorer definitions | `apps/control-room/src/modules/explorer/explorerTabs.ts` | `EXPLORER_TABS` |
| 162-route Inspector dispatcher | `apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx` | `resolveInspectorRoute` |
| Geometry, CSG, Array 3D & Placement inspector | `apps/control-room/src/modules/inspector/inspectors/objects/geometry/ObjectGeometrySpec.tsx` | `GeometryObjectInspectorPanel` |
| Material & absorbing boundary inspectors | `apps/control-room/src/modules/inspector/inspectors/objects/material/ObjectMaterialSpec.tsx` | `ObjectMaterialInspectorPanel` |
| Region collection inspector | `apps/control-room/src/modules/inspector/inspectors/objects/regions/RegionsRootSpec.tsx` | `RegionsCollectionInspectorPanel` |
| Magnetic texture inspector | `apps/control-room/src/modules/inspector/panels/magnetic-texture/MagneticTextureInspectorPanel.tsx` | `MagneticTextureInspectorPanel` |
| Physics interaction inspector | `apps/control-room/src/modules/inspector/inspectors/objects/physics/ObjectPhysicsSpec.tsx` | `ObjectPhysicsInspectorPanel` |
| Antenna composition overview inspector | `apps/control-room/src/modules/inspector/inspectors/objects/antenna/AntennaOverviewSpec.tsx` | `AntennaOverviewInspectorSpecPanel` |
| Study root & execution inspectors | `apps/control-room/src/modules/inspector/inspectors/study/StudyRootSpec.tsx` | `StudyRootInspectorPanel` |
| Runtime resource inspector | `apps/control-room/src/modules/inspector/panels/RuntimeExplorerInspectorPanels.tsx` | `RuntimeResourceInspectorPanel` |
| Mesh root (FDM sizing & FEM defaults) | `apps/control-room/src/modules/inspector/inspectors/mesh/MeshRootSpec.tsx` | `MeshRootInspectorSpecPanel` |
| 3D viewport module | `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx` | `Viewport3DModule` |
| 2D planar field map module | `apps/control-room/src/modules/field-map/FieldMapModule.tsx` | `FieldMapModule` |
| Live & analysis chart views | `apps/control-room/src/modules/live-charts/LiveChartsView.tsx` | `LiveChartsView` |
| Analysis plots container | `apps/control-room/src/modules/analysis-plots/AnalysisPlotsView.tsx` | `AnalysisPlotsView` |
| Saved SolutionSet browser | `apps/control-room/src/modules/results-navigator/SavedResultsBrowser.tsx` | `SavedResultsBrowser` |
