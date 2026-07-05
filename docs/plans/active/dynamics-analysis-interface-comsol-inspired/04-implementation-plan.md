# Dynamics Analysis Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a COMSOL-inspired, resource-first Dynamics Analysis workbench for modal eigenmodes, driven response spectra, peak inspection, and complex field visualization in `apps/control-room`.

**Architecture:** Keep Fullmag's v2 module-kernel architecture. Explorer owns navigation, Inspector owns selected-node details/actions, Analysis Plots owns chart surfaces, Viewport 3D owns rendering, and all data flows through resource hooks, command registry, kernel selection, and analysis-field overlay state.

**Tech Stack:** Next.js 16 app in `apps/control-room`, React, TypeScript, ECharts, Three.js/R3F, v2 OpenAPI facade/resource hooks, kernel command registry, kernel selection, `--fm-*` Catppuccin tokens, shadcn/ui-style shared primitives.

---

## Scope

This plan is the Control Room implementation layer. It must be read together
with `05-frequency-driven-backend-refactor-plan.md`, which owns the corrected
backend plan for the `FrequencyResponse` solver, `periodic_airbox_k0` demag,
CPU/GPU execution, and future nonzero-k demag-k/dispersion work.

Frontend work may expose diagnostics and unavailable states, but it must not
present a read-only placeholder, validation fallback, no-demag smoke,
unavailable bundle, or local draft mutation as the production solver.

This plan is frontend/control-room only for presentation logic, but explicitly
boundaries backend-command and authoring contracts:
1. **Frontend-Only Presentation**: Tree results rendering, ECharts spectrum charts, dispersion plots, complex phase visualization sliders, and WebGL overlays.
2. **Backend-Command / Authoring Transactions**: Study Setup/Solver Configuration nodes must modify the stage draft and trigger API study transactions using the canonical transaction path. Actions that mutate state or request computation (e.g. `Trigger Field Calculation`, `Update Brillouin Zone Path`) must execute as capability-gated command dispatches to the backend, not as local UI mutations. If a capability (like Floquet dynamic demag or coupled magnon-polarons) is unsupported, the command registry must reject the action with a stable degraded diagnostic.

> **Corrected Phase Split**: Earlier `[P2]` labels mean "temporary
> backend-transaction dependency", not "acceptable final UX". Study Setup
> surfaces may render read-only diagnostics only while the canonical backend
> transaction schema is absent. Once a schema exists, the UI must commit through
> `model.commitTransaction`, preserve requested/resolved solver intent, and
> remove the read-only placeholder. Backend production sequencing is governed
> by `05-frequency-driven-backend-refactor-plan.md`.

## Priority 0: Scientific Invariant Prerequisites

The following tasks must be completed **before** any results visualization work, because incorrect convention handling produces scientifically wrong results (e.g., reversed chirality, wrong propagation direction).

### Task 0.1: Phasor Convention Adapter

**Goal:** Create a single canonical adapter that maps `phasor_convention` and `floquet_spatial_convention` to sign factors for decay rate extraction, phase animation direction, and Floquet spatial rendering.

- [x] Define TypeScript types:
  ```ts
  type PhasorConvention = "exp_i_omega_t" | "exp_minus_i_omega_t";
  type FloquetSpatialConvention = "dst_equals_src_exp_minus_i_k_dot_delta_r" | "dst_equals_src_exp_plus_i_k_dot_delta_r";
  ```
- [x] Implement `phasorAdapter(convention: PhasorConvention)` returning `{ decayRateSign: 1 | -1, phaseAnimationDirection: 1 | -1 }`.
- [x] Implement `floquetPhaseAdapter(convention: FloquetSpatialConvention)` returning `{ spatialPhaseSign: 1 | -1 }`.
- [x] Integrate adapter into `AnalysisFieldOverlayController` so the viewport shader never hard-codes a sign.
- [x] Write unit tests with both convention values verifying correct sign extraction.
- [x] Run:
  `pnpm --dir apps/control-room test -- --run phasorAdapter`

### Task 0.2: Driven Response δh Validation

**Goal:** Prevent the scientifically meaningless case where a frequency-domain driven response has no dynamic perturbation configured.

- [x] Add validation check in the Driven Frequency Response Inspector: if no `δh` source is configured, display a blocking status card:
  ```
  Drive source: missing
  Severity: blocking
  Message: Frequency-domain response requires a dynamic perturbation δh. Without excitation, the response is identically zero.
  Action: Add drive source
  ```
- [x] The spectrum chart must not render misleading flat-line data; show an empty state with the validation message instead.

## File Map

Expected implementation areas:

- `apps/control-room/src/modules/explorer/builders/frequencyDomainExplorerNodes.ts`
- `apps/control-room/src/modules/inspector/panels/frequency-domain/*`
- `apps/control-room/src/modules/inspector/panels/FrequencyDomainCharts.tsx`
- `apps/control-room/src/modules/inspector/panels/FrequencyDomainTables.tsx`
- `apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts`
- `apps/control-room/src/modules/analysis-plots/*`
- `apps/control-room/src/kernel/visualization/AnalysisFieldOverlayController.ts`
- `apps/control-room/src/modules/viewport-3d/*`
- `apps/control-room/src/design/styles/inspector.css`
- focused tests beside each module.

## Task 1: COMSOL-Style Dynamics Explorer Tree

**Goal:** Make the Explorer expose dynamics study setup and analysis results as an inspectable tree structure, separating active configuration from read-only run results.

- [x] Add or update Explorer node models for:
  - **Study Setup Nodes [P2]**: `Study Setup`, `Dynamics Study Configuration`, `Eigenfrequency Solver Settings`, `Frequency Sweep Settings`, `Dependent Variable Inheritance`, `Physics Solve Selection` (mmf and coupled lanes), and `Boundary & Floquet Setup` (periodic pairs and k-path). These require backend stage transaction schemas that do not yet exist.
  - **Results Nodes**: `Dynamics Analysis`, `Manifest`, `Equilibrium Source`, `Modal Eigenmodes`, `Spectrum`, `Mode`, `Branches`, `Dispersion`, `Mode Fields`, `Driven Frequency Response`, `Response Sweep`, `Frequency Point`, `Peak`, `Response Fields`, `Comparison`, and `Diagnostics`.
- [x] Write failing tests in the existing Explorer builder tests proving each semantic node has a distinct `kind` and selection ref.
- [x] Implement the tree builder changes.
- [x] Verify every new node routes to a specific Inspector panel ID.
- [x] Run:
  `pnpm --dir apps/control-room test -- --run buildModelTree`

## Task 2: Dedicated Inspector Contract For Every Node

**Goal:** Replace generic frequency-domain detail reuse with node-specific
Inspector surfaces.

- [x] Add failing tests for each node kind:
  - **Study Setup Nodes [P2]**: `Dynamics Study Configuration`, `Eigenfrequency Solver Settings`, `Frequency Sweep Settings`, `Dependent Variable Inheritance`, `Physics Solve Selection`, `Boundary & Floquet Setup`. Blocked until backend transaction schemas exist.
  - **Results Nodes**: `manifest`, `equilibrium source`, `modal spectrum`, `mode`, `branch`, `dispersion`, `response sweep`, `frequency point`, `peak`, `comparison`, `diagnostics`.
- [x] Implement dedicated panels or panel-model branches.
- [x] For Study Setup nodes, ensure that inputs trigger stage draft updates and dispatch transactions through the canonical authoring transaction path, verifying capability-gated status.
- [x] For Results nodes, ensure panels render read-only properties from revision-locked run artifacts.
- [x] Each panel must show resource identity, revision/status, provenance, available actions, and unsupported/degraded reason where applicable.
- [x] Run:
  `pnpm --dir apps/control-room test -- --run FrequencyDomainInspectorPanel`

## Task 2.5: Mode Visualization Inspector Registration

**Goal:** Register a dedicated inspector panel for `object.mode_visualization*` selection kinds that currently fall through to `PlaceholderPanel`.

**Status:** The Explorer tree nodes and `SelectionRef` types for mode visualization already exist in:
- `selectionTypes.ts`: `type: "mode-visualization"` with kinds `object.mode_visualization`, `object.mode_visualization.group`, `object.mode_visualization.field`, `object.mode_visualization.view`
- `buildModelTree.ts`: `modeVisualizationNode()` builds the subtree under each object's visualization node
- `explorerSelection.ts`: maps mode visualization nodes to `type: "mode-visualization"` selection refs

**Missing:** No inspector panel is registered in `inspectorRegistry.tsx` for these kinds.

- [x] Register `object.mode_visualization`, `object.mode_visualization.group`, `object.mode_visualization.field`, `object.mode_visualization.view` kinds in `inspectorRegistry.tsx`.
- [x] Create `ModeVisualizationInspectorPanel` that reuses `FrequencyDomainModeDisplayControls` as its core control card, sharing appearance model with `ObjectVisualizationPanel`.
- [x] The panel must show: source (driven/eigenmode), frequency/sample/mode indices, active fieldId and resource status, Real/Imag/Abs/Phase/PhaseRotatedReal toggle, phase slider, animation toggle, surface/vectors/colormap controls inherited from object visualization, and capability warnings.
- [x] Write failing test: selecting an `object.mode_visualization.view` node renders the mode visualization inspector, not the placeholder.
- [x] Run:
  `pnpm --dir apps/control-room test -- --run inspectorRegistry`

## Task 3: Modal Spectrum Workbench

**Goal:** Provide a COMSOL-like mode result surface: selected mode, component, complex view, metrics, plot action.

- [x] Add model tests proving modal chart points preserve sample index, raw mode index, frequency, damping/imaginary frequency, residual, tangent leakage, and mode field ID.
- [x] Implement calculated complex frequency fields in the inspector via a solver/artifact sign convention adapter:
  - Read manifest `phasor_convention` field. Canonical values: `"exp_i_omega_t"` or `"exp_minus_i_omega_t"`.
  - Calculate decay rate $\Gamma = \text{Imag}(\omega)/(2\pi)$ if convention is $e^{i\omega t}$, or $\Gamma = -\text{Imag}(\omega)/(2\pi)$ if convention is $e^{-i\omega t}$.
  - Linewidth $\Delta f = 2|\Gamma|$
  - Quality factor $Q = f_r / (2|\Gamma|)$
- [x] Add UI tests proving controls exist for component and complex view.
- [x] Add mode selection actions: inspect, plot 3D, animate phase, compare.
- [x] Ensure chart click maps to a canonical frequency-domain mode selection ref.
- [x] Keep y-axis units explicit and avoid mixed diagnostic units on one axis unless split or dual-axis mode is explicit.
- [x] Run:
  `pnpm --dir apps/control-room test -- --run ModalSpectrum`

## Task 4: Driven Response Spectrum Workbench

**Goal:** Show response spectra as one selected physical observable at a time.

- [x] Add tests for observable/component selection: `delta mx`, `delta my`, `delta mz`, `|delta m|`.
- [x] Add tests for quantity selection: amplitude, phase, absorbed power, susceptibility.
- [x] Filter chart series by selected observable and selected quantity while preserving original row identity for selection.
- [x] Remove hidden valid-point truncation from action lists; use scrollable or table-backed point inspection instead.
- [x] Format tooltips as named fields with units. Never show raw arrays/tuples.
- [x] Run:
  `pnpm --dir apps/control-room test -- --run FrequencyDomainCharts`

## Task 5: Peak And Modal-Driven Comparison Surface

**Goal:** Make the spectrum-to-field workflow explicit, like COMSOL's spectrum with spatial mode maps at peak frequencies.

- [x] Add a peak table model for modal peaks, driven peaks, and paired nearest modal/driven comparisons.
- [x] Implement spatial overlap coefficient ($\eta_j$) calculation for comparison pairs using the Hermitian inner product with FEM mass-matrix weighting:
  $$\eta_j = \frac{\left| \sum_e w_e \, \delta \mathbf{m}_{\text{driven},e}^\dagger \cdot \delta \mathbf{m}_{\text{modal},j,e} \right|}{\left( \sum_e w_e |\delta \mathbf{m}_{\text{driven},e}|^2 \right)^{1/2} \left( \sum_e w_e |\delta \mathbf{m}_{\text{modal},j,e}|^2 \right)^{1/2}}
  $$
  where $w_e$ is the finite-element node volume weight (mass-matrix diagonal), $\dagger$ denotes the Hermitian conjugate (complex transpose), and the sum runs over mesh nodes $e$ in the magnetic domain only. Result is clamped to $[0, 1]$.
  - [x] Handle missing field payload states (render `degraded` and request link).
- [x] Add tests for detuning, overlap coefficient, source links, missing modal data, missing driven data, and unsupported comparison.
- [x] Add Inspector panels for selected peak and comparison pair (rendering $\eta_j$ value).
- [x] Add chart peak markers with exact frequency labels and selection refs.
- [x] Ensure peak labels use display units while internal values remain Hz.
- [x] Run:
  `pnpm --dir apps/control-room test -- --run PeakComparison`

## Task 6: Analysis Field Overlay Integration

**Goal:** One command path plots modal and response fields in the unified 3D viewport, supporting Floquet phase propagation.

- [x] Add tests for analysis-field overlay query updates: field ID, component, view, phase, wavevector $\mathbf{k}_F$, source label.
- [x] Extend `AnalysisFieldOverlayState` type with `wavevectorKf?: [number, number, number]` (SI, rad/m) and `cellOrigin?: [number, number, number]` (SI, meters). The viewport shader requires these for Floquet phase projection. Without this extension, Floquet mode visualization is impossible.
- [x] Add `floquetSpatialConvention?: FloquetSpatialConvention` field to `AnalysisFieldOverlayState`. The viewport must read the sign from this field through the `floquetPhaseAdapter`, not from a hard-coded formula. Values: `"dst_equals_src_exp_minus_i_k_dot_delta_r"` (COMSOL manual convention) or `"dst_equals_src_exp_plus_i_k_dot_delta_r"`.
- [x] Add `phasorConvention: PhasorConvention` field to `AnalysisFieldOverlayState`. Required for correct decay rate sign extraction and phase animation direction.
- [x] Implement spatial phase propagation in the viewport shader/renderer for Floquet modes:
  $$\delta \mathbf{m}(\mathbf{r}, t) = \text{Re}\left( \delta \mathbf{m}(\mathbf{r}) e^{i(\mathbf{k}_F \cdot (\mathbf{r} - \mathbf{r}_0) - \omega t)} \right)$$
  calculating the dot product $\mathbf{k}_F \cdot (\mathbf{r} - \mathbf{r}_0)$ for each vertex position $\mathbf{r}$ relative to the unit-cell origin $\mathbf{r}_0$.
- [x] Support tiled/periodic unit-cell phase offsets $\mathbf{k}_F \cdot \mathbf{R}$ where cell translation $\mathbf{R}$ is non-zero.
- [x] Route mode/response plot actions through kernel commands or the existing analysis overlay controller.
- [x] Do not import viewport internals into inspector or charts.
- [x] Ensure missing field resources disable plot actions with explicit reason.
- [x] Browser smoke must assert visible canvas, nonzero drawing buffer, and no lost WebGL context for a selected analysis field.
- [x] Run:
  `pnpm --dir apps/control-room test -- --run AnalysisFieldOverlay`
- [x] Implement field buffer eviction policy: maintain an LRU cache of at most 10 decoded analysis field buffers. When the 11th mode is selected, evict the least-recently-used buffer. Do not hold GPU texture references for evicted buffers.
- [x] Implement ECharts instance lifecycle budget: no more than 4 concurrent ECharts instances across all analysis plot surfaces. Dispose the oldest instance when the limit is exceeded.

## Task 7: Analysis Plots Center Surface

**Goal:** Make the center analysis surface a first-class dynamics workbench using Apache ECharts with clean lifecycle handling and responsive resizing.

- [x] Add route-aware chart composition for modal spectrum, response sweep, dispersion, and comparison.
- [x] Implement Apache ECharts configurations:
  - **Modal Spectrum**: Scatter plot ($f$ vs mode index), table formatter tooltip, click selects mode node.
  - **Driven Response**: Line plot, toolbar dropdown selector for Y-axis (Amplitude, Phase, Absorbed Power, Susceptibility), single-unit axis scaling, dataZoom pan/zoom controls.
  - **Dispersion**: Multi-series branch line/scatter plot ($f$ vs `path_s`), vertical grid lines marking labeled high-symmetry points ($\Gamma, X, M, \Gamma$), click selects sample/mode index.
- [x] Implement a Brillouin Zone Path Editor UI to author high-symmetry point sweeps ($\Gamma - X - M - \Gamma$, etc.) with segment densities.
- [x] Add "Trigger Field Calculation" button in the Inspector for dispersion points that lack saved field payloads, triggering background solver execution.
- [x] Add resource-status and capability badges.
- [x] Add exact point table or docked data inspector for selected chart point.
- [x] Ensure ECharts instances (`echarts.init`) and resize observers are cleanly disposed on unmount to prevent memory leaks.
- [x] Run chart lifecycle and adapter tests.

## Task 8: Ribbon & Transaction Commands

**Goal:** Expose repeatable and authoring actions through the command registry, ensuring they are capability-gated and transaction-aware.

- [x] Add commands for:
  - *Presentation Actions*: open dynamics workbench, plot selected mode, plot selected response field, animate phase, compare selected peak, export selected metadata.
  - *Authoring & Transaction Actions*: trigger field calculation (on-demand solver dispatch), update k-path (mutates draft stage).
- [x] Implement capability gating on all commands: if the active solver backend does not support the required capability (e.g., nonzero-k Floquet demag, coupled solid mechanics), disable the command and show the rejection reason.
- [x] Add DMI boundary condition warning: if DMI is enabled in frequency-domain studies and the backend cannot validate the DMI boundary operator, the Inspector must render diagnostic `frequency_domain.dmi_boundary_condition_uncertain` with severity `warning`. This follows COMSOL manual guidance that frequency-domain DMI boundary conditions are not yet fully resolved.
- [x] Add command tests for available, disabled, unsupported (gated), rejected, and completed states.
- [x] Main menu, ribbon, context menu, and command palette must render the same command registry entries.
- [x] Run:
  `pnpm --dir apps/control-room test -- --run commandContributions`

## Task 9: Visual Polish And Density Pass

**Goal:** Match Fullmag control-room visual quality while preserving scientific
readability.

- [x] Use `fm-*` classes and `--fm-*` tokens only.
- [x] Use shared shadcn/ui-style primitives for tabs, dropdowns, segmented
  controls, tooltips, dialogs, switches, and menus.
- [x] Keep charts dense and readable: tabular numbers, units, clear legends,
  hover/focus states, stable dimensions.
- [x] Avoid nested cards and decorative surfaces.
- [x] Verify light/dark Catppuccin themes.
- [x] Run visual regression snapshot tests for light/dark Catppuccin themes.

## Task 10: Final Verification

- [x] Run:
  `pnpm --dir apps/control-room test`
- [x] Run:
  `pnpm --dir apps/control-room typecheck`
- [x] Run:
  `pnpm --dir apps/control-room lint`
- [x] Run API hygiene checks:
  `rg "fetch\\(" apps/control-room/src`
- [x] Run module boundary checks:
  `rg "from ['\\\"]\\.\\./" apps/control-room/src/modules`
- [x] Run browser smoke for analysis-field overlay if viewport behavior changed.
- [x] Verify Explorer tree virtualizes correctly with 1000+ frequency sweep points (no DOM explosion).
- [x] Verify field buffer eviction: clicking through >20 modes must not exceed GPU memory budget.
- [x] Verify ECharts dispersion chart renders <5000 data points without frame drops.
- [x] Verify chart unit invariant: every analysis chart Y-axis represents one selected observable with one unit. Mixed-unit series on one axis is a correctness bug. Diagnostics (residual norms, convergence) may appear in tooltip/table, never as hidden mixed-axis chart series.
- [x] Update this plan with completed tasks and any deferred capability gaps.

## Acceptance Checklist

- [x] Explorer exposes all dynamics result/resource families.
- [x] Every Explorer node has a dedicated Inspector.
- [x] Modal and driven products are visibly distinct.
- [x] Component and complex-view selectors are first-class controls.
- [x] Spectrum charts show one selected quantity per axis unless split/dual-axis
  mode is explicit.
- [x] Peak selection synchronizes chart, Inspector, table, and viewport overlay.
- [x] Unsupported/degraded states are visible and actionable.
- [x] No direct module `fetch()`.
- [x] No module imports another module's internals.
- [x] ECharts and viewport resources dispose correctly.

## Backend Readiness Caveat

The checked Control Room items above are UI/readiness claims only. They do not
mean that `periodic_airbox_k0` driven response, GPU frequency-driven demag,
nonzero-k Floquet demag-k, Study Setup transactions, or modal dispersion are
production complete. Those claims require the CPU/GPU backend gates, artifact
validators, capability-matrix status changes, and managed `just` verification
listed in `05-frequency-driven-backend-refactor-plan.md`.

Any implementation worker continuing from this file must first identify whether
the next task is UI presentation, authoring transaction wiring, CPU backend,
GPU backend, artifact/API, or future dispersion. A task in one layer must not
be closed with evidence from a different layer.
