---
title: Control Room capability register
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-capability-register)=
# Control Room capability register

This register is the authoritative source tracking implemented browser capability boundaries for
public documentation. It separates a backend Python/ProblemIR capability from an actually authored
Control Room v2 path: a Python parameter is never described as UI-supported merely because the
backend or OpenAPI schema can represent it.

## 1. How to read the status

| Status | Meaning for documentation |
|---|---|
| `implemented` | The named Control Room route, panel fields, and commit transaction exist in current source (`apps/control-room/src`). |
| `partial` | A dedicated panel or editor exists, covering an explicitly enumerated subset of the Python/API surface; unexposed options remain `TODO: frontend support`. |
| `inspection-only` | The UI renders resolved runtime, mesh, or result artifacts without mutating the underlying Python model. |
| `TODO` | No supported authoring UI exists yet; document Python authoring first and mark UI support explicitly as `TODO: frontend support`. |

## 2. Current Control Room v2 routes

| Capability area | Control Room route / shell surface | Current status | Source owner |
|---|---|---|---|
| Start Screen, templates, import, recent scripts/results & sibling instances | `/home` (`StartScreen` rail sections: `Overview`, `Templates`, `Import`, `Learn`, `Docs`, `Settings`, `About`; `/instance/<port>`, `?port=`) | `implemented` (desktop `Open script…` gated on script host availability) | `StartScreen`, `LaunchTiles`, `OtherInstances`, `tabRoutes.ts` |
| Workspace chrome, multi-instance tabs, Mocha/Latte themes & Command Palette | Top header (`AppMenuBar`, `InstanceTabStrip`, `ThemeSwitcher`, `Ctrl+Shift+P` Command search) | `implemented` (`Definitions` & `Automation` ribbon tabs remain hidden while preview-only) | `InstanceTabStrip`, `AppMenuBar`, `CommandPaletteModule`, `RibbonModule` |
| Primitive geometry placement & metadata | `Model Explorer -> Objects -> <object> -> Geometry / Placement / General` & Ribbon `Move` (`W`) | `partial` (primitives + rigid translation implemented; CSG booleans are preview-stripped & rigid Rotate/Scale remain disabled) | `GeometryObjectPanel`, `ObjectPlacementPanel`, `ObjectGeneralPanel` |
| Magnetic materials & absorbing boundary ramps | `Model Explorer -> Objects -> <object> -> Material` | `partial` (scalar $M_{\text{sat}}, A_{\text{ex}}, \alpha, K_{u1}$, axis, material library create/assign, absorbing faces/profile implemented; spatially varying functional material fields remain Python-only) | `ObjectMaterialPanel`, `ObjectAbsorbingBoundaryPanel` |
| Sub-object spatial regions & nested overrides | `Model Explorer -> Objects -> <object> -> Regions -> <region>` | `partial` (bounds-checked shapes, scalar material/mesh/texture overrides implemented across region sub-panels) | `ObjectRegionsPanel`, `RegionsListPanel` |
| Initial magnetization textures & coordinate transforms | `Model Explorer -> Objects -> <object> -> Magnetization` (or region texture) | `implemented` for all 16 `MAGNETIZATION_TEXTURE_PRESETS` + transforms (`uniform`, `random`, `vortex`, `antivortex`, skyrmions, `bimeron`, domain walls, `helical`, `conical`, `hopfion*`); custom Python callable textures remain `TODO` | `ObjectMagneticTexturePanel`, `texturePresets.ts` |
| Local & global magnetic interactions, field drives & couplings | `Model Explorer -> Objects -> <object> -> Physics`, `Couplings`, `Field Drives` | `partial` (lane-gated exchange/DMI/anisotropy/Zeeman/RKKY/demag, `sinc`/`sinusoidal`/`piecewise_linear` field drives, coupling enable/delete) | `PhysicsInteractionPanel`, `RegionalFieldDrivePanel`, `CouplingInspectorPanel` |
| Frozen spins constraints | `Model Explorer -> Objects -> <object> -> Constraints` (`Frozen Spins`) | `implemented` for selection expressions, membership/reference policy, 3D preview & activation | `FrozenSpinsInspectorPanel` |
| RF antennas, conductors, ports & EM basis preview | `Model Explorer -> Objects -> <object> -> Antennas` | `implemented` for canonical field drives (`sinc`, `sinusoidal`), conductor placement, port composition, piecewise tables & field-basis preview | `AntennaObjectPanel`, `antenna/*` |
| Spin/current transport, STT/SOT, Oersted & spin interfaces | `Model Explorer -> Transport / Spin / Interfaces` & Ribbon `Physics` | `implemented` for `current_transport`, `spin_transport`, Zhang-Li/Slonczewski/Prescribed SOT, Oersted bindings, & `tet4` spin-interface normal verification | `TransportAuthoringInspector`, `SpinAuthoringInspector`, `SpinInterfaceInspectorPanel` |
| FEM object, airbox & region mesh policy authoring | `Model Explorer -> Objects / Universe / Regions -> Mesh` & Ribbon `Mesh` | `implemented` for advertised presets, sizes, `swept_prism` layer counts, airbox grading/curvature/narrow-region & builds (`swept_hex` disabled) | `ObjectMeshPolicyPanel`, `AirboxMeshParametersPanel`, `ObjectRegionMeshPanel` |
| FDM structured grid & FEM quality/history reports | `Model Explorer -> Objects / Mesh / Jobs` & Footer `Operations` / `Mesh Jobs` | `inspection-only` (read-only FDM cell masks `FMRM`/`FMBM`; FEM histograms & latest-successful vs current distinction) | `FdmObjectMeshPolicySection`, `MeshQualityStatisticsView`, `MeshJobsPanel` |
| Study profile, ordered stages & safe Apply + Re-Run | `Model Explorer -> Study`, `Stages -> <stage>` | `partial` (global backend/device/precision, editable `relax`/`run`/`hysteresis`/`eigenmodes`/`frequency_response`/`fft_response`/`autosave*`/`save_state`/`change_device`, `executeStageAfterApply` pinning; complex Python closures read-only via `UnsupportedStageInspector`) | `StudyInspectorPanel`, `StudyStageInspectorRouter`, `StudyStageDraftEditor`, `studyStageApplyAndRun` |
| 3D WebGL viewport, clipping, studio HDRI & PNG export | `Viewport3DModule` & `Viewport3DSettingsDialog` | `implemented` (FDM/FEM adapters, projections, instanced vectors, clipping, 5 quality profiles, offline softbox PMREM HDRI, `1×/2×/4×` transparent/view RGBA16F capture) | `Viewport3DModule`, `Viewport3DSettingsDialog`, `viewport3dImageExport.ts` |
| Planar monitors & interactive 2D Field Map | `Planar Monitors`, `FieldMapModule` & `PlanarToolbar` | `implemented` (draft plane creation with 3D gizmos, `XY`/`XZ`/`YZ`, zoom/crop/inspect/profile/measure tools, streamlines/contours, `PlanarFieldLayerList`, `PlanarMultisliceGrid`, `PlanarSnapshotNavigator`, PNG/CSV export) | `FieldMapModule`, `PlanarMonitorDraftInspectorPanel`, `PlanarMonitorInspectorPanel` |
| Live ECharts, hysteresis playback, dispersion & FMR spectral plots | `LiveChartsModule`, `AnalysisPlotsModule`, `Results` Explorer, `Footer -> Quick Chart` | `implemented` (live traces, hysteresis snapshot cursor sync, $\Gamma$ FFT, $S(k,f)$ heatmap with cuts, eigenmode dispersion & FMR peaks + 3D phase-animated spatial overlays) | `LiveChartsView`, `AnalysisPlotsView`, `EigenDispersionInspectorPanel`, `FmrResponseSweepInspectorPanel`, `ModeVisualizationInspectorPanel` |
| Saved SolutionSet browser & offline playback | `Explorer -> Results` (`SavedResultsBrowser`) & `SavedResultsPlaybackViewport` | `implemented` (`inspection-only` multi-run tables, materialized fields, playback timeline, comparison overlays) | `SavedResultsBrowser`, `SavedResultsPlaybackInspector` |
| Runtime, provenance, logs, problems & diagnostic recording | `Model Explorer -> Runtime`, `Jobs`, `Diagnostics`, Footer Dock & `StatusBarModule` | `inspection-only` (displays requested vs. resolved backend/device, transport audit, command queue, preparation blockers) | `RuntimeResourceInspectorPanel`, `FooterModule`, `StatusBarModule` |

## 3. Explicit frontend TODO boundaries

The following Python/API capabilities must remain explicitly documented as `TODO: frontend support`
until an authoring control and committed transaction exist in `apps/control-room`:

| Python / ProblemIR surface | Required documentation status |
|---|---|
| Direct standalone `fm.Problem` / raw `ProblemIR` JSON authoring | `TODO`: the Control Room authors session-backed studies, not arbitrary unattached IR documents. |
| Interactive CSG Boolean geometry operations (`union`, `difference`, `intersection`) & Ribbon `Create` extras (`Ellipsoid`, `Ring`, `Waveguide`) | `TODO`: currently marked `preview: true` and stripped from Ribbon rendering; inspectable read-only when authored in Python. |
| Rigid `Rotate` / `Scale` authoring in UI | `TODO`: disabled with `PROBLEM_IR_03_RIGID_TRANSFORM_REASON` in Geometry transform controls. |
| Two-way in-UI Python script synchronization (`Automation` tab `Sync Script`) | `TODO`: `Automation` ribbon tab is hidden (`preview: true`); use `File -> Save canonical copy as…` or `fullmag.live` (`fm.connect()`). |
| Arbitrary callable spatial material fields & custom Python stage closures | `TODO`: scalar/preset forms apply in UI; functional expressions stay Python-authoritative (`UnsupportedStageInspector`). |
| `swept_hex` mesh strategy and unsupported exact layer counts | `TODO`: disabled in `ObjectMeshPolicyPanel` until backend & UI gating enable them. |

## 4. Required per-page frontend crosswalk contract

Every terminal documentation page must include `Control Room crosswalk` (or `How to set it in Control Room`) stating:

1. exact Explorer tree, Ribbon tab, or shell route and inspector component;
2. exposed field groups and parameter names;
3. commit transaction (`Apply`, `Build`, `Compute Study`, or `executeStageAfterApply`) and invalidation behavior;
4. supported subset when `partial`, and literal `TODO: frontend support` for unexposed options;
5. reference back to this register and verified source owners.

## Control Room crosswalk

This page is the Control Room capability register itself. Statuses reflect verified inspection of
`apps/control-room/src/**` and distinguish authoring (`implemented` / `partial`) from read-only
surfaces (`inspection-only`) and Python-only routes (`TODO`). See {doc}`/frontend/control-room/index`
and {doc}`/frontend/inspectors/index`.

## Python/API crosswalk

Python remains the authoritative authoring contract. Use {doc}`/python-api/index` for exact
constructors, methods, SI arguments, validation rules, and runtime exceptions; never infer a Python
signature from an internal Control Room draft field name.

## Physics and bibliography scope

This UI register introduces no independent physical equations. Scientific formulations belong to the
linked physics and numerical-methods sections.

## Source-code index

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| Workspace start hub | `apps/control-room/src/modules/start/StartScreen.tsx` | `StartScreen` |
| Ribbon commands & preview gate | `apps/control-room/src/modules/ribbon/ribbonContributions.tsx` | `stripRibbonPlaceholders` |
| Inspector route dispatcher | `apps/control-room/src/modules/inspector/inspectorRouteCatalog.tsx` | `resolveInspectorRoute` |
| Geometry, material, region & texture panels | `apps/control-room/src/modules/inspector/panels/GeometryObjectPanel.tsx` | `GeometryObjectPanel`, `ObjectMaterialPanel`, `ObjectRegionsPanel`, `ObjectMagneticTexturePanel` |
| Physics, antenna & transport inspectors | `apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanel.tsx` | `PhysicsInteractionPanel`, `AntennaObjectPanel`, `TransportAuthoringInspector`, `SpinAuthoringInspector`, `SpinInterfaceInspectorPanel` |
| Study, stage & runtime inspectors | `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx` | `StudyInspectorPanel`, `StudyStageInspectorRouter`, `RuntimeResourceInspectorPanel` |
| 3D, 2D & chart visualization modules | `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx` | `Viewport3DModule`, `FieldMapModule`, `LiveChartsView`, `AnalysisPlotsView`, `SavedResultsBrowser` |
