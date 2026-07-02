# 02 - Target Interface Contract

## Product Shape

The target is a Dynamics Analysis workbench inside the unified Control Room.
It must feel like a scientific instrument, not a generic dashboard.

It covers:

- equilibrium/preconditioned state inspection,
- modal eigenmodes,
- driven frequency response,
- FMR peak analysis,
- dispersion and branch tracking,
- complex dynamic field visualization,
- provenance and diagnostics.

### Result Product Distinction

The interface must enforce a strict separation between three result products. These are **not interchangeable** in the UI:

| Product | Solver Source | Primary Data | Typical Actions |
|---|---|---|---|
| `Eigenmodes` | eigensolver / modal analysis | complex eigenfrequency, eigenvector / mode field | inspect mode, animate phase, compare with driven peak |
| `FrequencyResponse` | driven frequency sweep | response vs `f`, forced field payloads | inspect point, mark peak, plot response field |
| `Dispersion` | eigenmodes over `k_F` path | branch, sample index, mode index, `path_s` | track branch, plot selected k-mode, compare anticrossings |

This distinction must be preserved in component names, `SelectionRef` types, inspector panel IDs, and artifact models.

### Central Terminology Rules

- **Eigenmode**: A result of the eigensolver — complex eigenfrequency + eigenvector. Not a "frequency point".
- **Frequency Point**: A single step in a driven frequency sweep — excitation at a specific `f` with a forced response. Not a "mode".
- **Peak**: An analytical label/feature marking a local maximum in data. A peak may refer to a driven point, an eigenmode, or a comparison between modal and driven data. Peaks are **analysis annotations**, not solver-native entities.

These three concepts must never be conflated in names, icons, tooltips, or state types.

## Scientific Invariants

The following invariants are non-negotiable. Every inspector, chart, viewport, and command must respect them:

- Frequency-domain fields are **complex phasors**, not instantaneous magnetization snapshots.
- `δm` is a small-signal perturbation around equilibrium. The physical dynamic magnetization is reconstructed as $\mathbf{m}(t) = \mathbf{m}_0 + \text{Re}(\delta\mathbf{m} \, e^{i\omega t})$ using the manifest phasor convention.
- The linearized frequency-domain LLG is: $i\omega \delta\mathbf{m} = -\gamma \mathbf{m}_0 \times \delta\mathbf{h}_{\text{eff}} - \gamma \delta\mathbf{m} \times \mathbf{h}_{\text{eff}}^0 + i\omega\alpha \, \mathbf{m}_0 \times \delta\mathbf{m}$, with orthogonality constraint $\mathbf{m}_0 \cdot \delta\mathbf{m} = 0$.
- `m0` must be a valid equilibrium state for the selected static fields and material configuration. A formally solved but physically invalid `m0` (e.g., non-converged relaxation, stale revision) produces incorrect frequency-domain results.
- Driven frequency response requires a nonzero dynamic perturbation `δh`. Without excitation, the response is identically zero — this is a setup error, not a physical result.
- In frequency-domain studies, drive fields are **phasor amplitudes** (A/m). The harmonic factor $e^{i\omega t}$ is supplied automatically by the solver. Users must not include explicit $\sin(\omega t)$ or $\cos(\omega t)$ terms.
- Eigenmodes and driven response points are distinct result products with different solver origins.
- Peaks are analysis annotations, not solver-native entities.
- Floquet wavevector is always stored in SI `rad/m`.
- Viewport phase projection must use the manifest spatial and temporal sign conventions through a shared adapter — never hard-coded signs.

## COMSOL Variable Mapping

| COMSOL variable | Fullmag canonical name | Unit | Meaning |
|---|---|---|---|
| `dmX`, `dmY`, `dmZ` | `dmX`, `dmY`, `dmZ` | 1 (dimensionless) | complex dynamic magnetization excitation phasor |
| `m01`, `m02`, `m03` | `m0.x`, `m0.y`, `m0.z` | 1 (dimensionless) | equilibrium magnetization (unit vector) |
| `h01`, `h02`, `h03` | `h0.x`, `h0.y`, `h0.z` | A/m | static external/effective field source |
| `dh1`, `dh2`, `dh3` | `delta_h.x`, `delta_h.y`, `delta_h.z` | A/m | dynamic drive phasor amplitude (not time-domain waveform) |
| `kFX`, `kFY`, `kFZ` | `wavevectorKf[0..2]` | rad/m | Floquet/Bloch wavevector |

## Rendering Convention

The viewport must not hard-code a phase sign. It receives:
- `phasorConvention` — temporal convention from the manifest
- `floquetSpatialConvention` — spatial Floquet sign from the manifest
- `wavevectorKf` — Floquet wavevector in rad/m
- `cellOrigin` — unit cell origin in meters
- `visualizationPhaseRad` — current animation phase angle

and computes the phase through a shared convention adapter.

### Convention Types

```ts
type PhasorConvention =
  | "exp_i_omega_t"       // COMSOL default: m(t) = m0 + Re(δm · exp(+iωt))
  | "exp_minus_i_omega_t"; // physics textbook: m(t) = m0 + Re(δm · exp(-iωt))

type FloquetSpatialConvention =
  | "dst_equals_src_exp_minus_i_k_dot_delta_r"  // COMSOL manual: δm_dst = δm_src · exp(-ik·Δr)
  | "dst_equals_src_exp_plus_i_k_dot_delta_r";  // alternative convention
```

### Adapter Contract

A single `phasorAdapter` function maps conventions to sign factors:
- `decayRateSign`: determines whether $\text{Im}(\omega)$ gives positive or negative damping rate
- `phaseAnimationDirection`: determines which direction phase rotates during animation
- `spatialPhaseSign`: determines the sign of $\mathbf{k}_F \cdot (\mathbf{r} - \mathbf{r}_0)$ in the spatial phase projection

This adapter must be used everywhere: decay rate extraction in inspectors, phase animation in the viewport, and Floquet spatial projection in the shader. Hard-coding signs in any of these locations is a **scientific correctness bug** — it would reverse chirality / propagation direction.

## Implementation Status

The following components **already exist** in the codebase and must not be re-implemented from scratch:

| Component | File | Status |
|---|---|---|
| Mode visualization `SelectionRef` types | `selectionTypes.ts` | **Implemented** — `type: "mode-visualization"` with kinds `object.mode_visualization`, `.group`, `.field`, `.view` |
| Mode visualization Explorer tree | `buildModelTree.ts` | **Implemented** — `modeVisualizationNode()` builds subtree under object visualization |
| Mode visualization selection mapping | `explorerSelection.ts` | **Implemented** — maps mode viz nodes to `type: "mode-visualization"` selection refs |
| Analysis field overlay controller | `AnalysisFieldOverlayController.ts` | **Implemented** — 173 lines, pub/sub controller with `fieldId`, `query`, `source`, `appearance`, `animation` |
| Analysis field overlay phase animation | `AnalysisFieldOverlayPhaseAnimation.ts` | **Implemented** — interval timer incrementing `visualizationPhaseRad` |
| Object visualization controller | `ObjectVisualizationController.ts` | **Implemented** — 1495 lines, per-target settings (surface, vectors, colormap, opacity) |
| Mode display controls component | `FrequencyDomainModeDisplayControls.tsx` | **Implemented** — 555 lines, view selectors, appearance controls, phase slider |
| Object visualization inspector | `ObjectVisualizationPanel.tsx` | **Implemented** — 51KB |
| Frequency-domain results inspectors | `FrequencyDomainResultInspectors.tsx` | **Implemented** — 255KB, 80+ frequency-domain kinds |
| Viewport overlay integration | `useViewport3DSceneModel.ts` line 2101 | **Implemented** — `primaryFieldQuantityId = analysisOverlay?.fieldId ?? quantityId` |

**Missing (requires new work):**

| Component | Gap |
|---|---|
| Mode visualization inspector registration | `object.mode_visualization*` kinds **not registered** in `inspectorRegistry.tsx` — fall through to `PlaceholderPanel` |
| Wavevector in overlay state | `AnalysisFieldOverlayState` lacks `wavevectorKf` field — Floquet phase projection impossible |
| Study Setup transaction schemas | All `stage.study_type`, `stage.solver.*`, `stage.dependencies.*`, `stage.physics.*` mappings are aspirational — no backend Rust types or OpenAPI paths exist |

## Workspace Layout

| Surface | COMSOL analogue | Fullmag target |
|---|---|---|
| Left panel | Model Builder | Explorer tree: model, studies, results, resources, fields, peaks, diagnostics. |
| Right panel | Settings | Inspector: selected-node settings, provenance, controls, actions, diagnostics. |
| Center | Graphics | Unified viewport or analysis plot surface. |
| Bottom | Messages / Progress / Tables | Jobs, logs, exact point table, diagnostics, chart data table. |
| Ribbon | COMSOL toolbar / context actions | Run, plot, compare, animate, export, range/overlay controls. |

## Explorer Tree Contract

The Explorer must expose both the active study setup and the dynamics analysis results as inspectable tree nodes. This mirrors COMSOL's Model Builder structure but remains mapped to Fullmag v2 resource concepts:

```text
Study Setup (Active Simulation Stage)
  Dynamics Study Configuration
    Solver Mode Selection (Eigenfrequency vs. Driven Frequency Response)
    Eigenfrequency Solver Settings
      Target Frequency (Shift)
      Desired Mode Count
      Sparse Solver (ARPACK / shift-invert)
    Frequency Sweep Settings
      Range (f_start, f_stop, steps)
      Sweep spacing (linear / logarithmic)
    Dependent Variable Inheritance
      Equilibrium m0 stage source
      Static Zeeman field h0 source
    Physics Solve Selection (Lanes)
      Micromagnetics (Frequency Domain mmf)
      Coupled lanes (e.g., Solid Mechanics, RF) [Gated]
    Boundary & Floquet Setup
      Periodic boundary pairs selection
      Floquet Wave Vector (k_F) path sweep config
Results
  Dynamics Analysis
    Manifest
    Equilibrium Source
    Modal Eigenmodes
      Spectrum
      Modes
        Sample 0
          Mode 0
          Mode 1
      Branches
      Dispersion
      Mode Fields
      Diagnostics
    Driven Frequency Response
      Response Sweep
      Frequency Points
        f = 4.100 GHz
        f = 4.700 GHz
      Peaks
      Response Fields
      Susceptibility / Absorbed Power
      Diagnostics
    Comparison
      Modal vs Driven Peaks
      Validation / Capability
```

Rules:

- Every semantic node (both Study Setup and Results nodes) gets a dedicated Inspector detail view.
- A `Mode` node is not the same as a `Frequency Point` node.
- A `Peak` node can point to a modal mode, a driven point, or a paired modal-driven comparison.
- Study Setup nodes modify the draft state of the active stage, triggering transactions using the canonical authoring path, whereas Results nodes represent read-only, revision-locked run artifacts.
- Explorer selection changes inspector focus and chart/viewport selection, but selecting a Results node must not mutate solver state.

## Inspector Contract

The Inspector is Fullmag's settings and detail surface, equivalent to COMSOL's Settings panel but resource-first, revision-aware, and capability-gated. It is divided into two distinct interaction models: **Study Setup Inspectors** (editable form views that modify draft configurations) and **Results Inspectors** (read-only diagnostics sheets displaying simulation outputs).

### I. Study Setup Inspectors (Form-based, Transactional)

Every Study Setup inspector modifies the draft state of the active stage. Changes are committed to the backend via a canonical stage transaction path when the user clicks "Apply" or "Save".

> **Phase 2 — Backend-Dependent**: All Study Setup inspectors require backend stage transaction schemas that **do not yet exist**. The transaction mappings listed below are target contracts. Frontend forms must not be wired to nonexistent endpoints. Until the backend schemas are implemented, Study Setup nodes may render as read-only informational panels with a "Configuration not yet available" status card.

#### Backend Contract Status

| Transaction Mapping | Backend Status | Notes |
|---|---|---|
| `stage.study_type` | ❌ Not implemented | No Rust type or OpenAPI path |
| `stage.solver.eigenfrequency` | ❌ Not implemented | No parameter schema |
| `stage.solver.frequency_response` | ❌ Not implemented | No sweep coordinate schema |
| `stage.dependencies.equilibrium_source` | ❌ Not implemented | No dependency commit path |
| `stage.physics.active_lanes` | ❌ Not implemented | No lane activation schema |
| `stage.physics.boundary_conditions` | ❌ Not implemented | No boundary commit path |
| `stage.physics.k_path` | ❌ Not implemented | No k-path commit path |

#### 1. `Dynamics Study Configuration`
- **Role**: Selects the primary dynamics simulation lane for the active stage.
- **Controls & Options**:
  - `Study Type` Dropdown: `Eigenmodes` (eigensolver path) or `Frequency Response` (driven sweep path).
- **Read-Only Fields**: Stage ID, version tag, revision count.
- **Transaction Mapping**: Updates `stage.study_type` in the draft stage configuration.

#### 2. `Eigenfrequency Solver Settings`
- **Role**: Configures the sparse eigensolver parameters for modal analysis.
- **Controls & Options**:
  - `Eigensolver` Dropdown: `ARPACK` (default) or sparse direct shift-invert.
  - `Desired Modes` Number Input (Integer, default 6, validation range 1 to 100).
  - `Search Frequency Around (Shift)` Number Input (Double, default 1.0, with unit selector: `Hz`, `kHz`, `MHz`, `GHz`, `rad/s`).
  - `Eigensolver Tolerance` Input (Double, scientific notation input e.g. `1e-6`).
- **Read-Only Fields**: Solver execution flags, ARPACK workspace size diagnostics.
- **Transaction Mapping**: Maps directly to `stage.solver.eigenfrequency` parameter schema.

#### 3. `Frequency Sweep Settings`
- **Role**: Sets up the coordinate sweep parameters for driven response excitation.
- **Controls & Options**:
  - `Start Frequency` Number Input (Double, default 0.1, unit selector: `Hz`, `kHz`, `MHz`, `GHz`, `rad/s`). Minimum value: 1 Hz (0 Hz is physically meaningless for dynamics).
  - `Stop Frequency` Number Input (Double, default 10.0, unit selector: `Hz`, `kHz`, `MHz`, `GHz`, `rad/s`).
  - `Sample Points` Number Input (Integer, default 100, range 2 to 1000).
  - `Spacing` Segmented Control: `Linear` or `Logarithmic`.
- **Read-Only Fields**: Resolved step size (e.g. `0.1 GHz`).
- **Transaction Mapping**: Maps directly to `stage.solver.frequency_response` sweep coordinates.

> **δh phasor amplitude warning**: In frequency-domain studies, the dynamic drive field `δh` is a phasor amplitude, not a time-domain waveform. The inspector and any drive source configuration must present amplitude (A/m), phase (rad), and direction — never an explicit `sin(ωt)` or `cos(ωt)` term. The harmonic factor is supplied by the solver convention.

#### 4. `Dependent Variable Inheritance`
- **Role**: Links the dynamic linearization operator to a static equilibrium condition.
- **Controls & Options**:
  - `Equilibrium State Source (m0)` Dropdown: List of completed relaxation or time-dependent stages in the active session.
  - `Static Zeeman Field Source (h0)` Dropdown: List of Zeeman field sources.
- **Read-Only Fields / Warnings**:
  - `Mesh Alignment Status`: Displays green badge `Aligned` or red alert `Mesh Mismatch` if the selected equilibrium stage geometry doesn't match the current stage.
  - Mismatch diagnostics: Lists mismatched coordinates, material constants, or boundary coordinates.
- **Equilibrium Validity Checklist** (all items displayed as read-only status badges):
  - `source_stage_id`: ID of the equilibrium source stage.
  - `mesh_revision_match`: ✅ or ❌ — whether the mesh revision used for equilibrium matches the current stage.
  - `material_revision_match`: ✅ or ❌ — whether material parameters changed since equilibrium was computed.
  - `field_configuration_match`: ✅ or ❌ — whether static field configuration (Zeeman, anisotropy axes) is consistent.
  - `max_torque_norm`: $|\mathbf{m} \times \mathbf{H}_{\text{eff}}|_{\text{max}}$ — if above threshold (e.g., $10^{-4}$), display warning `Equilibrium may not be fully converged`.
  - `average_m_norm_error`: $\langle | |\mathbf{m}| - 1 | \rangle$ — non-unit magnetization indicates numerical issues.
  - `timestamp / revision`: When the equilibrium was computed and its revision hash.
  - `stale_if_source_changed`: If the model (geometry, materials, fields) was modified after the equilibrium solve, display amber `Stale` badge with message: *"Equilibrium state was computed before the latest model change. Re-run relaxation for correct results."*

> **Critical**: Fullmag must not only identify `m0`, but must verify whether `m0` is **physically and revisionally current**. A stale or unconverged equilibrium produces formally solvable but physically meaningless frequency-domain results.

- **Transaction Mapping**: Commits dependency IDs to `stage.dependencies.equilibrium_source`.

#### 5. `Physics Solve Selection`
- **Role**: Enables or disables equation modules (lanes) solved by the backend.
- **Controls & Options**:
  - `Solve Lanes` Checkboxes:
    - [x] Frequency-Domain Micromagnetics (`mmf`) — Always enabled and locked.
    - [ ] Solid Mechanics (Elastodynamics coupling) — Disabled by default.
    - [ ] RF Cavity / Microstrip coupling — Disabled by default.
- **Read-Only Fields & Badges**:
  - State Badges: `Active` (solved), `Passive` (calculated post-solve), `Unsupported` (displays capability mismatch details).
  - Capability Alert: Exposes warning `coupled.solid_mechanics.unsupported` if a lane is checked but the active backend solver lacks the capability.
- **Transaction Mapping**: Commits checked lanes list to `stage.physics.active_lanes`.

#### 6. `Boundary & Floquet Setup`
- **Role**: Defines periodic pair mapping and k-space path configurations.
- **Controls & Options**:
  - `Boundary Type` Dropdown: `Free` (open boundaries), `Periodic` (zero-phase), or `Floquet / Bloch` (nonzero wavevector).
  - `Periodic Pair Source` Resource Selector: Links to `/v2/sessions/current/meshing/mesh/periodic_pairs.v1`.
  - `Brillouin Zone Path Editor` List Table:
    - High-symmetry points list (e.g., coordinates $k_{Fx}, k_{Fy}$ in rad/m, with labels $\Gamma, X, M$).
    - Segment sample density inputs (Integer, points per segment).
- **Read-Only Fields**: Periodic node pair count, translation vector residuals.
- **Transaction Mapping**: Commits boundary properties to `stage.physics.boundary_conditions` and path settings to `stage.physics.k_path`.

---

### II. Results Inspectors (Read-only, Analysis-focused)

All Results inspectors render static properties fetched from revision-locked run artifacts. They do not mutate draft configurations.

#### 7. `Dynamics Manifest Inspector`
- **Role**: Displays execution provenance, solver convention, and global artifact status.
- **Information Presented**:
  - Execution Status: `Success`, `Degraded` (due to missing demag), or `Stale` (equilibrium source changed since solve).
  - Solver Engine: e.g. `Native FEM CPU solver`.
  - Conventions: phasor convention e.g. `exp(i*omega*t)`.
  - Artifact path directory list.
- **Actions**: `Export Manifest JSON`, `Copy Revision Hash`.

#### 8. `Equilibrium Source Inspector`
- **Role**: Displays read-only stats of the static magnetization state.
- **Information Presented**:
  - Source stage path, execution timestamp, convergence criteria.
  - Spatial magnetization averages: $\langle m_x \rangle$, $\langle m_y \rangle$, $\langle m_z \rangle$.
  - Maximum torque magnitude: $|\mathbf{m} \times \mathbf{H}_{\text{eff}}|_{\text{max}}$.
- **Actions**: `Plot Equilibrium Field in 3D Viewport`.

#### 9. `Modal Spectrum Inspector`
- **Role**: Exposes calculated metrics for a selected eigenmode.
- **Information Presented**:
  - Real Frequency: $f_r$ in GHz (internally stored in Hz).
  - Decay Rate: $\Gamma$ in GHz (calculated using the phasor convention adapter from `phasor_convention` field; canonical values: `"exp_i_omega_t"` or `"exp_minus_i_omega_t"`).
  - Linewidth (FWHM): $\Delta f = 2|\Gamma|$ in GHz. Explicitly labeled as Full-Width at Half-Maximum to distinguish from the half-width convention used in some publications.
  - Quality Factor: $Q = f_r / (2|\Gamma|)$ (dimensionless).
  - Residual error norm, tangent leakage, mass normalization check.
  - Dominant polarization direction and ellipticity.
  - Mode spatial extent / localization measure (when available from solver).
- **Controls**:
  - Component dropdown: `δmx`, `δmy`, `δmz`, `|δm|` (backend field keys: `dmX`, `dmY`, `dmZ`, `dm_magnitude`).
  - View dropdown: `real`, `imag`, `abs`, `phase`, `phase_rotated_real`.
  - Phase slider: rotates temporal phase $\omega t \in [0, 2\pi]$ for `phase_rotated_real` viewport display.
- **Actions**: `Plot Mode in 3D Viewport`, `Animate Phase`, `Trigger Mode Field Solve` (gated command, available if the field payload is missing).

#### 10. `Driven Frequency Response Inspector`
- **Role**: Shows global response parameters for the frequency sweep.
- **Information Presented**:
  - Excitation amplitude (A/m), antenna model geometry, excitation frequency range.
  - Global susceptibility tensor components: $\chi_{xx}, \chi_{yy}, \chi_{zz}$ (dimensionless when $M_s$-scaled: $\chi = \delta M / h_{\text{drive}} = M_s \cdot \delta m / h_{\text{drive}}$).
  - Total absorbed power: $P_{\text{abs}} = \int p_{\text{abs}} \, dV$ in watts (W). Distinguished from absorbed power **density** $p_{\text{abs}}$ in W/m³.
  - Solver convergence quality summary across the sweep.
- **Controls**:
  - ECharts Series Selector Dropdown: `Amplitude (a.u.)`, `Phase (rad)`, `Absorbed Power Density (W/m³)`, `Susceptibility (dimensionless)`.

> **Unit disambiguation**: "Absorbed Power" in the Y-axis selector refers to the **absorbed power density** $p_{\text{abs}}$ in W/m³ (per-element quantity). The "Total absorbed power" $P_{\text{abs}}$ in watts is a derived scalar displayed in the inspector header, not plotted as a series.

> **Drive source validation**: If no dynamic perturbation `δh` is configured for the driven response, the Inspector must display a blocking validation status:
> ```
> Drive source: missing
> Severity: blocking
> Message: Frequency-domain response requires a dynamic perturbation δh.
>          Without excitation, the response is identically zero.
> Action: Add drive source
> ```
> The spectrum chart must not render misleading flat-line data; show an empty state with the validation message instead.

#### 11. `Frequency Point / Peak Inspector`
- **Role**: Details a single frequency sweep step or marked peak.
- **Information Presented**:
  - Excitation frequency (GHz), response amplitude (a.u. — solver-normalized $\langle |\delta \mathbf{m}| \rangle$), phase offset (rad) — the phase of the complex response relative to the drive excitation.
  - Solver residual norm at this point.
  - Field payload availability state.
- **Actions**: `Plot Response Field in 3D Viewport`, `Compare with nearest modal mode`.

#### 12. `Modal-Driven Comparison Inspector`
- **Role**: Validates coupling between forced peaks and eigenmodes.
- **Information Presented**:
  - Detuning: $|f_r - f_{\text{driven}}|$ in GHz.
  - Spatial Overlap Coefficient using Hermitian inner product with FEM mass-matrix weighting:
    $$\eta_j = \frac{\left| \sum_e w_e \, \delta \mathbf{m}_{\text{driven},e}^\dagger \cdot \delta \mathbf{m}_{\text{modal},j,e} \right|}{\left( \sum_e w_e |\delta \mathbf{m}_{\text{driven},e}|^2 \right)^{1/2} \left( \sum_e w_e |\delta \mathbf{m}_{\text{modal},j,e}|^2 \right)^{1/2}}$$
    where $w_e$ is the FEM node volume weight (mass-matrix diagonal), $\dagger$ denotes Hermitian conjugate, sum runs over mesh nodes in the magnetic domain only, result clamped to $[0, 1]$.
  - Mesh alignment status badge, phase convention match check.
- **Actions**: `Plot overlap difference field in 3D`.

#### 13. `Branch Inspector`
- **Role**: Displays tracked mode branch connectivity across k-samples or parameter sweeps.
- **Information Presented**:
  - Branch ID and color assignment.
  - Branch continuity metric (tracking confidence across consecutive samples).
  - Number of tracked points in this branch.
  - Frequency range of the branch: $f_{\min}$ to $f_{\max}$ in GHz.
  - Hybridization index near anticrossing points (capability-gated: requires `frequency_domain.coupled.solid_mechanics`).
- **Controls**:
  - Branch visibility toggle (show/hide in dispersion chart).
  - Branch color override selector.
- **Actions**: `Highlight branch in dispersion chart`, `Export branch data as CSV`.

#### 14. `Mode Visualization Inspector` (Under Model → Object → Visualization)
- **Role**: Unified inspector for mode visualization nodes selected under the Model tree. Combines object appearance controls with mode-specific field display controls.
- **Implementation Note**: Reuses `FrequencyDomainModeDisplayControls` as the core control card, sharing the appearance model with `ObjectVisualizationPanel`. Must be **registered** in `inspectorRegistry.tsx` for all `object.mode_visualization*` kinds (currently these fall through to `PlaceholderPanel`).
- **Information Presented**:
  - Source: `Driven Response` or `Eigenmodes`.
  - Mode coordinate indices: frequency (GHz), sample index, mode index.
  - Active `fieldId` and resource fetch status (loading, available, missing, error).
  - Capability warning: if the solver backend cannot return object-scoped field data, display: *"Full-domain mode field displayed for selected object visualization"*.
- **Controls (Mode Section)**:
  - Component dropdown: `δmx`, `δmy`, `δmz`, `|δm|`.
  - View toggle: `Real` / `Imag` / `Abs` / `Phase` / `Phase-rotated real` — with active state highlight.
  - Phase rotation slider: $\omega t \in [0, 2\pi]$ (active only for `phase_rotated_real` view).
  - Animation toggle: periodically increments $\omega t$ to animate wave propagation.
- **Controls (Appearance Section — inherited from `ObjectVisualizationPanel`)**:
  - Surface rendering: scalar heatmap, vector overlay toggle.
  - Opacity slider, wireframe toggle.
  - Vector density budget slider.
  - Colormap selector and range scaling (min/max or auto-range).
  - Geometry scope: `Surface` or `Full`.

---

## Analysis Plot Contract

All analysis plots are implemented using **Apache ECharts** and consume local theme tokens mapping to the central Catppuccin color scheme (Mocha for dark theme, Latte for light theme).

### 1. Modal Spectrum Chart
- **Visuals**: Scatter plot representing eigenfrequencies.
- **Axis Configuration**:
  - X-axis: Mode index.
  - Y-axis: Frequency in GHz.
- **Interactive Options**:
  - Hover tooltip: Renders mode index, real frequency, decay rate, linewidth, and quality factor in a structured table.
  - Click event: Selects the mode node in the Explorer and loads the `Modal Spectrum Inspector`.
  - Double-click event: Dispatches a kernel command to render the mode field in the 3D Viewport.

### 2. Driven Response Spectrum Chart
- **Visuals**: Line chart representing frequency sweeps.
- **Axis Configuration**:
  - X-axis: Frequency in GHz.
  - Y-axis: Single-unit axis. The displayed quantity is selected via a dropdown toolbar widget:
    - *Amplitude* (a.u.)
    - *Phase* (radians)
    - *Absorbed Power* (W/m³)
    - *Susceptibility* (dimensionless)
  - Zoom & Pan sliders (ECharts `dataZoom` slider) are enabled on the X-axis by default.
- **Interactive Options**:
  - Peak Markers: Visual triangles marking resolved peaks. Hovering shows the exact peak frequency and detuning. Clicking a marker sets the global selection to that `Peak` node.
  - Tooltip: Custom formatter listing named values, units, and residual values. Never exposes raw tuple arrays.

### 3. Dispersion Chart (k-path)
- **Visuals**: Multi-series scatter/line plot for magnonic band structures.
- **Axis Configuration**:
  - X-axis: k-path coordinate `path_s [rad/m]`. High-symmetry point markers ($\Gamma, X, M, \Gamma$) are rendered as vertical grid lines with text labels at their absolute wavevector coordinates.
  - Y-axis: Frequency in GHz.
- **Series Configuration**:
  - Tracked branches are rendered as colored continuous lines with distinct Branch IDs.
  - Fallback untracked points are rendered as gray scatter dots.
- **Interactive Options**:
  - Click point: Selects the k-sample and mode index. If a mode field payload is available in the CSV/branches columns, it updates the `Modal Spectrum Inspector` and enables viewport actions.
  - On-demand Trigger: If the point is uncomputed, the `Modal Spectrum Inspector` enables a `Trigger Mode Field Solve` button which dispatches a transaction to calculate the spatial mesh values.
  - Multiphysics Badge: If a point lies near a magnon-polaron anticrossing, the tooltip renders a hybridization index. This is capability-gated: if the solid mechanics lane is passive or unsupported, the hybridization indicator is disabled.

---

## 3D Viewport Contract

The viewport consumes analysis field resources and display state:
- selected field resource ID,
- component,
- complex view,
- phase,
- colormap/range,
- vector visibility/budget,
- geometry scope,
- opacity,
- **Floquet Phase Projection Mode**: For nonzero-k Floquet modes, the renderer must project phase across mesh nodes based on coordinate vectors $\mathbf{r}$:
  $$\delta \mathbf{m}(\mathbf{r}, t) = \text{Re}\left( \delta \mathbf{m}(\mathbf{r}) e^{i(\mathbf{k}_F \cdot (\mathbf{r} - \mathbf{r}_0) - \omega t)} \right)$$
  - **Data and Units Contract**:
    - *Wavevector $\mathbf{k}_F$*: Delivered strictly in SI units (`rad/m`), matching the backend's internal storage format.
    - *Cell Origin $\mathbf{r}_0$*: Determined by mesh boundary metadata; defaults to $[0, 0, 0]$ in meters.
    - *Sign Convention*: Must follow the manifest's phase convention. If the manifest specifies $e^{-i \mathbf{k}_F \cdot \delta \mathbf{r}}$, the shader phase projection factor must adapt to match.
    - *Position Units*: Coordinate vertices $\mathbf{r}$ must be evaluated in meters.
  - **Animation**: When animating, time $t$ increments. The phase shader calculates the dot product $\mathbf{k}_F \cdot (\mathbf{r} - \mathbf{r}_0)$ at each vertex to apply the local spatial phase offset.
  - **Tiling (Unit Cell Array)**: When rendering multiple unit cells periodic translation $\mathbf{R}$ (in meters), the phase offset of the cell at translation $\mathbf{R}$ is $\mathbf{k}_F \cdot \mathbf{R}$.
  - **Fallback / Rejection Policy**: If `include_demag=true` for a nonzero-k Floquet run, and the run has a degraded state because dynamic demag-k is unsupported, the viewport must render a warning banner `viewport.degraded.demag_pbc` and refuse to display the overlay rather than rendering an unphysical field.

### Overlay State Type Contract

The canonical overlay state consumed by the viewport:

```ts
type AnalysisFieldOverlayState = {
  fieldId: string;
  component: "dmX" | "dmY" | "dmZ" | "dm_magnitude";
  complexView: "real" | "imag" | "abs" | "phase" | "phase_rotated_real";
  visualizationPhaseRad: number;
  phasorConvention: PhasorConvention;
  floquetSpatialConvention?: FloquetSpatialConvention;
  wavevectorKf?: [number, number, number]; // SI, rad/m
  cellOrigin?: [number, number, number];   // SI, meters
};
```

The viewport reads `phasorConvention` and `floquetSpatialConvention` from this state and passes them to the convention adapter. It must never assume a fixed sign.

The viewport must not know whether the selection came from Explorer, chart, or Inspector. It receives a canonical analysis-field overlay selection from kernel state/commands.

## State Ownership

| State | Owner |
|---|---|
| Artifacts and resources | v2 API resource hooks |
| Selection | kernel selection store |
| Chart zoom/visible quantity | module-local UI state |
| Field overlay selection | kernel visualization/analysis overlay controller |
| Heavy field buffers | data-plane resource cache / renderer owner |
| ECharts instance | chart component lifecycle |
| Three.js resources | viewport resource tracker |

No module store may hold full field arrays, topology, or entire artifact payloads.

## Capability And Degraded States

The UI must distinguish:

- not requested,
- requested but not supported,
- supported but not yet solved,
- solved with partial artifacts,
- solved with degraded validation,
- solved and current,
- stale relative to model/mesh/equilibrium.

Unsupported states must point to the missing capability: dynamic demag, nonzero-k Floquet, GPU lane, modal production solver, missing field payload, missing equilibrium source, or missing artifact family. Expose explicit capability rejections like:
- `floquet.nonzero_k.demag_unsupported` when dynamic demag is requested for a Floquet study.
- `coupled.solid_mechanics.unsupported` or `coupled.rf.unsupported` when coupled multiphysics lanes are requested in Study Setup but are not supported by the active backend solver.
- `frequency_domain.dmi_boundary_condition_uncertain` when DMI is enabled in frequency-domain studies but the backend cannot validate the DMI boundary operator. The COMSOL Micromagnetics Module manual notes that frequency-domain DMI boundary conditions are not yet fully resolved; Fullmag must not provide false certainty.
- Display a clear "Capability Gated - Solver Not Available" status card in the Inspector when viewing draft configurations for unsupported coupled paths.

### DMI Frequency-Domain Boundary Warning

If DMI is enabled in a frequency-domain study, boundary-condition support must be reported explicitly:

| Backend DMI Support | UI Status | Badge |
|---|---|---|
| Bulk DMI operator only | `supported-with-warning` | ⚠️ Bulk DMI only — no boundary term |
| Interfacial DMI without validated BC | `degraded` | ⚠️ DMI BC uncertain |
| DMI + Floquet + demag all unsupported | `rejected` or `degraded` | ❌ Combination not supported |
| DMI boundary artifact explicitly validated | `success` | ✅ DMI BC validated |

The diagnostic ID is `frequency_domain.dmi_boundary_condition_uncertain`. This is not about blocking research — it is about not providing false certainty.

### Study Setup Phase 2 Lock

Until backend stage transaction schemas exist (`stage.study_type`, `stage.solver.*`, `stage.dependencies.*`, `stage.physics.*`, `stage.physics.boundary_conditions`, `stage.physics.k_path`), Study Setup Inspectors are **informational and read-only**. They must not:
- Call nonexistent endpoints.
- Emulate success locally or in draft store.
- Mutate solver configuration outside canonical transactions.
- Display "Apply" or "Save" buttons that invoke missing backend contracts.

When rendered in Phase 1, Study Setup nodes display an informational panel:
```
Configuration not yet available
Backend transaction schema missing:
  stage.solver.eigenfrequency
  stage.dependencies.equilibrium_source
  stage.physics.k_path
```

## Performance And Memory Budget

The dynamics analysis workbench must operate within explicit resource budgets to prevent UI degradation at scale.

### Explorer Tree Virtualization

A 1000-point frequency sweep (maximum allowed by `Sample Points` range 2–1000) would create 1000+ child nodes plus 5 view children each = 5000+ DOM elements. The Explorer must:
- Virtualize frequency point children using windowed rendering (e.g., `react-window` or the existing Explorer virtualization strategy).
- Collapse frequency point children by default; expand only on user interaction.
- Lazy-load mode field availability status (don't fetch all 1000 field resource states on tree mount).

### Field Buffer Eviction

When a user clicks through modes/frequency points, each selection loads a decoded field buffer (complex 3-component vector per mesh node). Without eviction:
- 20 modes × 100K nodes × 6 floats × 8 bytes = ~96 MB of decoded field data.
- GPU texture uploads compound this.

Policy: Maintain an LRU cache of at most **10 decoded analysis field buffers**. Evict the least-recently-used buffer when the 11th is requested. Release associated GPU texture references on eviction.

### ECharts Instance Budget

Each ECharts instance allocates a Canvas 2D context (or WebGL context in GL mode). The dynamics workbench may display up to 4 chart surfaces simultaneously (modal spectrum, driven response, dispersion, comparison). Policy:
- Maximum **4 concurrent ECharts instances** across all analysis plot surfaces.
- Dispose the oldest instance when the limit is exceeded.
- All instances must call `echarts.dispose()` on React component unmount.
- All `ResizeObserver` handles must be disconnected on unmount.

### Dispersion Chart Data Budget

A dense k-path sweep (e.g., 100 k-points × 50 modes) generates 5000 data points. For larger sweeps:
- Render at most **5000 scatter points** in the dispersion chart before applying LOD (level-of-detail) decimation.
- Tracked branches (continuous lines) are exempt from decimation.
- Untracked fallback points are decimated first.

### Heavy Computation Offloading

The spatial overlap integral ($\eta_j$) requires iterating over all mesh nodes with complex arithmetic. For meshes with >50K nodes:
- Offload the computation to a **Web Worker** to avoid blocking the main thread.
- Display a progress indicator during computation.
- Cache computed $\eta_j$ values keyed by `(driven_fieldId, modal_fieldId)` pairs.

## Future Publication Visualization Capabilities

The following standard publication and COMSOL visualization features are not included in Phase 1 but should be designed for future phases:

| Feature | Description | Priority |
|---|---|---|
| Log-scale Y-axis | Logarithmic amplitude axis for broadband FMR (ECharts `type: 'log'`) | Phase 1 addition |
| PSD plot | Power Spectral Density representation | Future |
| Spatial FFT / k-space map | Reciprocal-space decomposition of mode shapes | Future |
| Mode profile line cut | 1D profile along a user-defined path through a mode shape | Future |
| Cut-plane / slice plot | 2D cross-section through 3D mode shape | Future |
| Streamline / LIC | Continuous vector field flow visualization | Future |
| Isosurface rendering | Constant-value 3D isosurfaces for mode amplitude | Future |
| Multi-mode comparison | Side-by-side or overlay of two mode shapes | Future |
| Animation export (GIF/MP4) | Export phase animation as video file | Future |
| Deformation plot | Elastic deformation overlay for magnon-polaron coupling | Future, capability-gated |

## Chart Unit Invariant

A chart Y-axis must represent **one selected observable with one unit**. This is a correctness rule, not a style preference.

- Amplitude (a.u.), phase (rad), susceptibility (dimensionless), absorbed power density (W/m³), and residual norm are **different observables** and must never share a Y-axis.
- Diagnostics (residual norms, convergence quality, solver iteration counts) may appear in tooltip or in the bottom dock data table — never as hidden mixed-axis chart series.
- If two observables need to be compared visually, use dual-axis (left Y + right Y) with explicit labeling, or split into two chart panels.

## Canonical Artifact Model Contracts

The following TypeScript types define the canonical shape of dynamics analysis artifacts consumed by Results Inspectors. They ensure that inspectors read structured data with known units, not opaque tuple arrays.

### DynamicsManifest

```ts
type DynamicsManifest = {
  artifactVersion: "frequency-domain-artifacts.v2";
  runId: string;
  stageRevision: string;
  meshRevision: string;
  materialRevision: string;
  equilibriumSource?: {
    stageId: string;
    revision: string;
    fieldId: string;
    maxTorqueNorm?: number;
    averageMNormError?: number;
  };
  solverEngine: string;
  phasorConvention: PhasorConvention;
  floquetSpatialConvention?: FloquetSpatialConvention;
  includedPhysics: {
    exchange: boolean;
    anisotropy: boolean;
    dmi: boolean;
    staticDemag: boolean;
    dynamicDemag: boolean;
    floquet: boolean;
    solidMechanics: boolean;
    rf: boolean;
  };
  capabilityStatus: "success" | "degraded" | "unsupported" | "stale";
  diagnostics: Diagnostic[];
};
```

### EigenModeRecord

```ts
type EigenModeRecord = {
  sampleIndex: number;
  modeIndex: number;
  kf?: [number, number, number]; // rad/m
  pathS?: number;                // rad/m (accumulated k-path distance)
  omegaRealRadS: number;         // rad/s
  omegaImagRadS: number;         // rad/s
  frequencyHz: number;           // Hz (derived: omegaRealRadS / 2π)
  decayRateHz: number;           // Hz (derived, sign from phasor convention adapter)
  linewidthFwhmHz: number;       // Hz (derived: 2|decayRateHz|)
  qualityFactor: number;         // dimensionless (derived: frequencyHz / linewidthFwhmHz)
  residualNorm?: number;         // dimensionless
  tangentLeakage?: number;       // dimensionless
  massNormalizationError?: number; // dimensionless
  fieldId?: string;              // resource ID for the mode field payload
};
```

### DrivenFrequencyPoint

```ts
type DrivenFrequencyPoint = {
  pointIndex: number;
  frequencyHz: number;           // Hz
  amplitudeAu?: number;          // a.u. (solver-normalized ⟨|δm|⟩)
  phaseRad?: number;             // rad (phase relative to drive excitation)
  susceptibility?: {
    xx?: number;                 // dimensionless (Ms-scaled)
    yy?: number;
    zz?: number;
  };
  absorbedPowerDensityWm3?: number; // W/m³ (per-element)
  totalAbsorbedPowerW?: number;     // W (integrated over volume)
  residualNorm?: number;            // dimensionless
  fieldId?: string;                 // resource ID for the response field payload
};
```

### PeakRecord

```ts
type PeakRecord = {
  peakId: string;
  source: "modal" | "driven" | "comparison";
  frequencyHz: number;           // Hz
  amplitudeAu?: number;          // a.u.
  modeRef?: { sampleIndex: number; modeIndex: number };
  drivenPointRef?: { pointIndex: number };
  detuningHz?: number;           // Hz (|f_modal - f_driven|)
  overlapEta?: number;           // dimensionless [0, 1]
};
```

### ModalDrivenComparison

```ts
type ModalDrivenComparison = {
  drivenFieldId: string;
  modalFieldId: string;
  meshRevision: string;
  phaseConventionMatch: boolean;
  detuningHz: number;            // Hz
  overlapEta: number;            // dimensionless [0, 1]
  overlapMethod: "hermitian_mass_weighted";
  nodeWeightSource: "mass_matrix_diagonal" | "node_volume";
  magneticDomainOnly: true;
  computedAt: string;            // ISO 8601 timestamp
};
```

These types are the **canonical data shapes** for Results Inspectors. Frontend components must consume these shapes, not raw JSON with implicit semantics.
