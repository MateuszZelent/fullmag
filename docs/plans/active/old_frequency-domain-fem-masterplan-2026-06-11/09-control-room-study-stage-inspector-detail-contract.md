# 09 - Control Room Study/Stage Inspector Detail Contract

Status: implementation planning contract  
Scope: frequency-domain Study, Stage, Eigenmodes, Frequency Response, FMR, setup, calculation-mode, resource, and diagnostic inspector views

## Purpose

The current frequency-domain inspector work has too many views that are named
after tree nodes but do not yet express a physically meaningful control surface.
This document defines what each detailed inspector must contain so implementation
can move from generic node summaries toward professional, controllable panels.

This is a UI contract derived from the current physics and backend contracts:

- `docs/physics/0700-frequency-domain-linearized-llg.md`
- `docs/physics/0600-fem-eigenmodes-linearized-llg.md`
- `docs/specs/frequency-domain-artifacts-v2.md`
- `docs/plans/active/frequency-domain-fem-masterplan-2026-06-11/02-ir-planner-python-capabilities-api.md`
- `docs/plans/active/frequency-domain-fem-masterplan-2026-06-11/03-artifacts-resources-and-runtime.md`
- `docs/plans/active/frequency-domain-fem-masterplan-2026-06-11/04-control-room-explorer-tree.md`
- `crates/fullmag-ir/src/study.rs`
- `crates/fullmag-ir/src/frequency_response_contract.rs`
- `crates/fullmag-ir/src/plan.rs`
- `crates/fullmag-plan/src/fem.rs`
- `packages/fullmag-py/src/fullmag/model/study.py`

The inspector must not invent a second model. Every editable value must map to
Python DSL, `StudyIR`, planner fields, or an explicitly capability-gated future
field. Every read-only value must come from a resource, artifact, plan,
capability, or command result.

## Global Inspector Rules

All frequency-domain inspector views must follow these rules.

1. Use resource hooks, typed models, and command registry actions. React
   components must not build raw `/v2/...` endpoint strings or call `fetch()`.
2. Show requested intent and resolved execution separately when result or plan
   data exists.
3. Label the two canonical studies correctly:
   - `Eigenmodes` is the modal eigensystem product.
   - `FrequencyResponse` is the direct driven harmonic solver.
4. Use SI units in stored values:
   - frequency in `Hz`,
   - angular frequency in `rad/s`,
   - k vectors and k-path coordinate in `rad/m`,
   - dynamic drive field in `A/m`,
   - phase in `rad`,
   - normalized mode perturbation as `delta_m`.
5. UI may show GHz, MHz, degrees, or normalized display values, but the
   inspector must show the canonical SI value and the display conversion.
6. Treat dynamic magnetization and driven response fields as complex phasors.
   Views must expose at least `real`, `imag`, `abs` or `amplitude`, `phase`,
   and `phase_rotated_real` when field metadata says those views are available.
7. Mode animation is phasor reconstruction, not time integration.
8. Nonzero-k Floquet dynamic demag is unsupported until a validated dynamic
   demag-k operator exists. Inspector panels must explain this as a capability
   constraint, not hide the control or silently downgrade.
9. For every run-capable panel, disabled actions must show the exact validation
   or capability reason.
10. No detailed inspector should display raw JSON as its primary UI. JSON may be
    available behind an "artifact/source" section after the domain controls.

## Canonical Workflow Mapping

Calculation mode is a UI workflow preset. It is not a backend solver kind.

| Calculation mode | Canonical study | Backend meaning | Required authoring fields | Primary result resources |
|---|---|---|---|---|
| `fmr_modal` | `Eigenmodes` | k = 0 modal FMR/eigen spectrum | count, target, equilibrium, operator, k = 0/free or static periodic boundary, outputs | `eigen/spectrum.v2.json`, mode metadata, mode field resources |
| `fmr_response` | `FrequencyResponse` | k = 0 direct harmonic driven FMR sweep | equilibrium, operator, excitation phasor, positive frequency list, response outputs | `response/magnetic_response_sweep.v2.json`, frequency-point resources, response field resources |
| `free_modes` | `Eigenmodes` | modal eigensystem without k-path | count, target, equilibrium, operator, free/open boundary, outputs | `eigen/spectrum.v2.json`, mode fields |
| `dispersion_modal` | `Eigenmodes` | Bloch/Floquet k-path modal dispersion | k-path, periodic pairs, branch tracking, dispersion outputs | `eigen/dispersion.csv`, `eigen/branches.v2.json`, mode fields |
| `response_map` | `FrequencyResponse` | future driven response over `(k, f)` | k grid/path, excitation, frequency sweep, response outputs | future response-map resource, response field slices |

## Shared Stage Overview Views

### `study.stage.eigenmodes`

Purpose: full modal stage overview. This panel should be the user's command
center for a modal solve, not a generic list of properties.

Editable sections:

- Calculation workflow: `fmr_modal`, `free_modes`, or `dispersion_modal`.
- Equilibrium source: `provided`, `relaxed_initial_state`, or `artifact(path)`.
- Operator: `linearized_llg` or `full_2x2`, include demag, damping policy,
  normalization.
- Boundary/k sampling: free/open, static periodic, or Floquet/Bloch k-path.
- Solver request: mode count, target kind, target frequency when `nearest`,
  backend/device/precision/execution mode.
- Outputs: spectrum, selected modes, dispersion curve, branch tracking,
  diagnostics.

Read-only sections:

- Current validation status.
- Capability status for modal reference CPU, modal production CPU/GPU, k-path,
  mode tracking, linewidths, and mode field payloads.
- Latest manifest links if solved.
- Latest requested/resolved execution if a result exists.

Actions:

- Validate stage.
- Run modal stage.
- Open latest spectrum.
- Open latest dispersion.
- Export canonical Python for the stage.

Hard validation:

- `count` must be a positive integer.
- `target_frequency` must be positive when target is `nearest`.
- `Eigenmodes` outputs must not include frequency-response observables.
- Floquet/Bloch k-path requires valid periodic-pair metadata.
- Nonzero-k Floquet demag must be rejected until supported.

### `study.stage.frequency_response`

Purpose: full direct driven frequency-response stage overview. This panel must
make clear that this is the production frequency-domain solver direction, not a
modal postprocessing approximation.

Editable sections:

- Calculation workflow: `fmr_response` or future `response_map`.
- Equilibrium source.
- Operator: `linearized_llg`, include demag, damping policy, normalization.
- Boundary/k sampling: k = 0 free/open or static periodic now; future nonzero-k
  response-map controls remain capability-gated.
- Excitation phasor: field vector in `A/m`, phase in `rad`, coordinate frame.
- Frequency sweep: explicit positive `values_hz`; UI helpers may create linear
  or log ranges but must store explicit values.
- Outputs: response amplitude, response phase, susceptibility tensor, absorbed
  power density, complex response, diagnostics, response field payloads.
- Solver request: backend/device/precision/execution mode.

Read-only sections:

- Planner status and exact rejection reasons.
- Current native production CPU slice status: gamma/free-boundary or supported
  k = 0 static-periodic magnetic response only.
- Unsupported lanes: GPU response, nonzero-k Floquet/Bloch response,
  dynamic demag-k, magnetoelastic response.
- Latest progress, cancel-requested state, partial artifacts, and diagnostics.

Actions:

- Validate driven response.
- Run response sweep.
- Open latest sweep.
- Open strongest FMR peak.
- Plot selected response field in 3D when field metadata exists.
- Export canonical Python.

Hard validation:

- `frequencies_hz` must be non-empty, finite, and positive.
- Excitation vector components and phase must be finite.
- Zero excitation vector must be invalid for driven response.
- `FrequencyResponse` outputs must be response observables only.
- GPU and non-double precision are rejected for the current FEM response lane.

## Authoring Detail Inspectors

### `study.stage.eigenmodes.setup`

Purpose: narrow setup editor for what the modal solve asks the backend to find.

Controls:

- Mode count stepper.
- Target segmented control: `lowest`, `nearest`.
- Target frequency input with Hz/GHz display toggle.
- Operator preset: scalar projected `linearized_llg` versus `full_2x2`.
- Requested backend/device/precision/execution mode.
- Calculation workflow selector when the parent mode is modal.

Information:

- DOF estimate from FEM mesh when available.
- Whether selected operator is valid for non-uniform equilibrium.
- Expected result family: FMR modal spectrum, free modes, or dispersion.

### `study.stage.eigenmodes.calculation_mode`

Purpose: explain and set how modal authoring maps to product workflows.

Controls:

- Cards or segmented selector for `fmr_modal`, `free_modes`,
  `dispersion_modal`.
- Preview of canonical patches that the mode will apply:
  - `StudyIR::Eigenmodes`,
  - k sampling,
  - outputs,
  - boundary preset,
  - mode tracking.

Information:

- Lowering table from workflow to `StudyIR`.
- Required artifacts for each mode.
- Capability matrix for modal reference CPU, k-path, branch tracking, mode
  fields, linewidths.
- Explicit message that calculation mode is not exported as a separate backend
  solver kind unless a public Python helper is added later.

Actions:

- Apply calculation mode.
- Validate mode requirements.
- Open required detail node, e.g. k-path for dispersion.

### `study.stage.eigenmodes.equilibrium`

Purpose: choose and validate the static state used for linearization.

Controls:

- Equilibrium source selector:
  - provided current state,
  - relaxed initial state,
  - artifact path.
- Artifact picker when source is `artifact`.
- Relaxation prerequisite shortcut when source is `relaxed_initial_state`.

Information:

- Physics reminder: linearized LLG assumes `m0 x H0 ~= 0` and `|m0| = 1`.
- Latest equilibrium residual summary:
  - max `|m0 x H0|`,
  - max `||m0| - 1|`,
  - state provenance,
  - relaxation step count if produced by relaxation.

Validation:

- Artifact path is required for `artifact`.
- Result/run actions show a warning if residuals are missing or stale.

### `study.stage.eigenmodes.operator`

Purpose: edit the physical linearized operator.

Controls:

- Operator kind:
  - `linearized_llg`,
  - `full_2x2`.
- Include demag toggle.
- Damping policy: `ignore`, `include`.
- Normalization: `unit_l2`, `unit_max_amplitude`.
- Energy-term readout from the model: exchange, Zeeman, anisotropy, DMI,
  surface anisotropy.

Information:

- Tangent-space basis requirement: perturbations are two tangent components per
  magnetic DOF.
- Demag realization and support status.
- Unsupported term diagnostics from planner.
- If `linearized_llg` scalar projection is selected on a non-uniform state,
  show it as a reference/limited path and recommend `full_2x2`.

### `study.stage.eigenmodes.boundary`

Purpose: configure modal spin-wave boundary and Bloch/Floquet semantics.

Controls:

- Boundary condition selector:
  - free/open,
  - pinned when supported,
  - static periodic,
  - Floquet/Bloch.
- Periodic axes or pair IDs.
- k vector for single-k solve.
- Link to k-path inspector for path dispersion.
- Phase convention readout.

Information:

- Pair requirement and pair validation status.
- `Floquet(k=0) == Periodic` validation note.
- Nonzero-k dynamic demag unsupported note when demag is enabled.

### `study.stage.eigenmodes.periodic_pairs`

Purpose: inspect periodic-pair metadata needed by static periodic and Floquet
modal studies.

Data:

- `mesh/periodic_pairs.v1` or active mesh periodic-pair resource.
- Pair ID, source marker, destination marker, translation in meters.
- Paired node count, unpaired counts, max/RMS residual, tolerance.

Controls/actions:

- Select pair in viewport when supported.
- Copy diagnostics summary.
- Open boundary or k-path panel.

### `study.stage.eigenmodes.k_path`

Purpose: configure modal dispersion sampling.

Controls:

- K-point table with label and `(kx, ky, kz)` in `rad/m`.
- Samples per segment.
- Closed-path toggle.
- Unit display conversion.
- Branch tracking toggle/options.

Information:

- Sample count hint from `KSamplingIR::sample_count_hint`.
- Segment deduplication behavior.
- Periodic pair compatibility status.

Validation:

- Path mode needs at least two k points.
- Samples per segment must be positive.
- Nonzero-k Floquet demag rejected while unsupported.

### `study.stage.eigenmodes.solver`

Purpose: show solver lane, constraints, and convergence expectations.

Controls:

- Requested backend/device/precision if not already controlled in setup.
- Dense/reference versus future production solver lane display.
- Residual tolerance and max iteration fields only when exposed by backend
  contract; otherwise read-only "backend default".

Information:

- `FemEigenPlanIR` fields:
  - mesh name/source,
  - FE order,
  - `hmax`,
  - precision,
  - exchange BC,
  - demag realization,
  - gyromagnetic ratio.
- Latest residual, orthogonality, tangent leakage, and convergence counts when
  artifacts exist.

### `study.stage.eigenmodes.outputs`

Purpose: choose modal products to write.

Controls:

- Spectrum output toggle.
- Mode metadata/field output selector.
- Mode index/sample selector.
- Dispersion output toggle.
- Branch tracking output.
- Diagnostics output.

Information:

- Required resources that each output will produce.
- Storage policy: JSON metadata, Zarr field payloads, raw binary only as
  transitional export.

### `study.stage.eigenmodes.diagnostics`

Purpose: explain why modal authoring is or is not runnable.

Sections:

- Validation messages from UI draft and IR validation.
- Capability messages from frequency-domain capability matrix.
- Planner rejection reasons.
- Latest solver diagnostics from `eigen/diagnostics.v2.json`.
- Artifact freshness against `frequency_domain/manifest.v1.json`.

### `study.stage.frequency_response.setup`

Purpose: narrow setup editor for driven harmonic response.

Controls:

- Calculation workflow: `fmr_response` or future `response_map`.
- Requested backend/device/precision/execution mode.
- Operator preset.
- Boundary preset summary.
- Frequency count summary.
- Output family summary.

Information:

- Direct harmonic response solves `(i omega B - L) q = f` at requested
  frequencies.
- No time integrator applies to this study.
- Current executable lane is FEM magnetic-only CPU response; unsupported lanes
  must be shown explicitly.

### `study.stage.frequency_response.calculation_mode`

Purpose: explain and set response workflows.

Controls:

- `fmr_response`: k = 0 driven FMR sweep.
- `response_map`: future k/f response map, disabled until nonzero-k response
  support exists.

Information:

- Lowering table:
  - `fmr_response` -> `StudyIR::FrequencyResponse` with k = 0, excitation,
    frequency sweep, response observables.
  - `response_map` -> `StudyIR::FrequencyResponse` with k grid/path and
    frequency sweep, capability-gated.
- Required artifacts and field payloads.
- Capability reasons for disabled modes.

Actions:

- Apply response calculation mode.
- Open excitation panel.
- Open frequency sweep panel.

### `study.stage.frequency_response.equilibrium`

Purpose: same physical contract as modal equilibrium, but with response-specific
solver readiness.

Controls:

- Equilibrium source selector and artifact picker.

Information:

- Equilibrium residuals.
- Whether the same equilibrium can be used for modal comparison.
- Provenance link to relaxation/static stage.

### `study.stage.frequency_response.operator`

Purpose: configure the linear operator used by the driven harmonic solve.

Controls:

- Operator kind.
- Include demag toggle.
- Damping policy.
- Normalization.

Information:

- The response solver reuses modal/eigen planning pieces for mesh, material,
  equilibrium, operator support, and demag realization.
- Current production CPU response rejects unsupported demag/Floquet/magnetoelastic
  combinations.

### `study.stage.frequency_response.boundary`

Purpose: configure k = 0 free/static periodic response now and future nonzero-k
response-map semantics.

Controls:

- Free/open.
- Static periodic zero-phase.
- Floquet/Bloch nonzero-k option displayed as disabled unless supported.
- Periodic pair selector.

Information:

- Static periodic response requires validated `mesh.periodic_node_pairs`.
- Static periodic diagnostics:
  - projection enabled,
  - node pair count,
  - frame mismatch,
  - drive mismatch.

### `study.stage.frequency_response.periodic_pairs`

Purpose: reuse periodic-pair diagnostics with response-specific status.

Data:

- Same periodic-pair resource as modal.
- Response calculation mode and static-periodic projection readiness.

Actions:

- Select pair in viewport.
- Open boundary panel.
- Copy response periodic diagnostics.

### `study.stage.frequency_response.k_grid`

Purpose: future response-map sampling over `(k, f)`.

Current behavior:

- Show capability-gated unavailable state for nonzero-k driven response.

Future controls:

- K grid or k path.
- Frequency sweep coupling.
- k/f sampling density.
- Slice output policy.

Information:

- Nonzero-k driven response requires Floquet response support and dynamic
  demag-k support when demag is enabled.

### `study.stage.frequency_response.excitation`

Purpose: edit the harmonic drive phasor.

Controls:

- Field vector `(hx, hy, hz)` in `A/m`.
- Phase `phase_rad`.
- Display phase in degrees as secondary text.
- Coordinate frame selector when backend exposes frame support.
- Future antenna/source selector as capability-gated control.

Information:

- Public UI must not require the user to encode `sin(omega t)` or
  `cos(omega t)`. The drive is a phasor.
- `excitation_provenance.kind` and `phase_rad` must be preserved in response
  artifacts.

Validation:

- Components finite.
- Zero vector invalid.
- Phase finite.

### `study.stage.frequency_response.sweep`

Purpose: edit the frequency list solved by direct response.

Controls:

- Explicit frequency table.
- Range helper: start, stop, count, linear/log spacing.
- Unit display: Hz, MHz, GHz.
- Deduplication policy preview.
- Current selected frequency point if a result exists.

Information:

- Stored `FrequencySweepIR.values_hz`.
- Total frequency count and estimated artifact count.
- Progress resource mapping after run.

Validation:

- Non-empty list.
- All values finite and positive.
- Duplicates rejected or explicitly deduplicated according to final DSL policy.

### `study.stage.frequency_response.solver`

Purpose: expose response solver lane and convergence diagnostics.

Controls:

- Requested backend/device/precision where editable.
- Solver tolerance/iteration controls only when backend contract exposes them.

Information:

- `FemFrequencyResponsePlanIR` fields:
  - mesh,
  - FE order,
  - equilibrium,
  - material,
  - operator,
  - excitation,
  - frequencies,
  - precision,
  - demag realization.
- Current native production CPU diagnostics:
  - `matrix_free_solver`,
  - `krylov_solver = gmres`,
  - residual norms,
  - completed frequency count.
- Explicit unsupported GPU/single/nonzero-k/magnetoelastic statuses.

### `study.stage.frequency_response.outputs`

Purpose: choose driven response products.

Controls:

- Observable toggles:
  - complex magnetization response,
  - susceptibility tensor,
  - absorbed power density,
  - response amplitude,
  - response phase.
- Frequency point metadata output.
- Response field payload output.
- Diagnostics output.

Information:

- v1/v2 sweep artifact names.
- Zarr response field payload policy.
- Which outputs are needed for FMR chart, peak table, and 3D response field.

### `study.stage.frequency_response.diagnostics`

Purpose: explain why driven response is or is not runnable and whether published
artifacts are trustworthy.

Sections:

- UI validation.
- IR validation.
- Planner rejection reasons.
- Capability matrix.
- Response progress and cancellation resources.
- `response/diagnostics.v1.json`.
- Static periodic diagnostics when applicable.

## Result And Analysis Inspectors

### `results.frequency_domain.calculation_modes`

Purpose: read-only comparison of available workflow products in the solved
session.

Content:

- Five workflow rows: `fmr_modal`, `fmr_response`, `free_modes`,
  `dispersion_modal`, `response_map`.
- For each: canonical study, required authoring fields, capability state,
  produced artifacts, result availability.
- Commands to open available result nodes.

This panel must not be used as the authoring control surface. Authoring lives in
`study.stage.*.calculation_mode`.

### `results.frequency_domain.fmr`

Purpose: product-level FMR summary across modal and driven results.

Content:

- k = 0/free/static-periodic boundary summary.
- Equilibrium summary.
- Modal spectrum availability and frequency range.
- Driven sweep availability and frequency range.
- Peak count and strongest peak.
- Modal-vs-driven comparison readiness.

Actions:

- Open modal spectrum.
- Open response sweep.
- Open FMR peaks.
- Plot selected mode/response field when available.

### `results.frequency_domain.fmr_modal_spectrum`

Purpose: inspect modal FMR frequencies and mode fields.

Content:

- Modal spectrum chart.
- Mode table with sample, raw mode, branch, frequency, imaginary frequency or
  damping, residual, tangent leakage, mode field availability.
- Selected mode controls:
  - mode field view (`real`, `imag`, `abs`, `phase`,
    `phase_rotated_real`) instead of the ordinary quantity selector,
  - display passes matching ordinary object visualization: surface shader,
    vectors, wireframe/frame/points where supported,
  - surface coloring matching ordinary field visualization: solid color, HSL
    orientation, component X/Y/Z, magnitude, and scalar colormap,
  - vector controls matching ordinary field visualization: color mode, arrow
    budget, vector scope, arrow length/thickness/opacity where supported,
  - phase,
  - animation rate,
  - scale when viewport command supports it.
- Future volume-inspection controls: render-only clip/cutaway modes for mode
  fields, including half/quarter geometry cuts and shader transparency around
  50% opacity. The purpose is to inspect interior modal structure and gradients
  through the body volume. These controls must be documented and implemented as
  viewport visualization state only; they must not alter the physical geometry,
  mesh, solver domain, or saved mode artifacts.

Actions:

- Select mode.
- Plot mode in 3D.
- Plot real/imag/amplitude/phase/phase-rotated view.
- Animate/pause mode phase.
- Open mode metadata resource.

### `results.frequency_domain.fmr_response_sweep`

Purpose: inspect direct driven FMR response.

Content:

- Amplitude versus frequency.
- Phase versus frequency.
- Absorbed power versus frequency.
- Susceptibility component selector.
- Frequency point table with field availability.
- Peak table with source, frequency, amplitude, phase, linewidth, residual.

Actions:

- Select frequency point.
- Plot response field in 3D.
- Plot real/imag/amplitude/phase/phase-rotated response field.
- Open frequency-point resource.
- Compare strongest response peak with nearest modal mode.

### `results.frequency_domain.fmr_peaks`

Purpose: inspect detected and manually selected FMR peaks.

Content:

- Peak table:
  - source `modal` or `driven_response`,
  - frequency,
  - amplitude or mode norm,
  - phase,
  - linewidth,
  - quality factor when derivable,
  - linked mode or frequency point,
  - validation status.
- Difference table when both modal and driven data exist.

Actions:

- Select peak.
- Plot linked mode or response field.
- Open linked mode/frequency-point inspector.

### `results.eigen.mode`

Purpose: detailed selected mode inspector.

Content:

- Mode identity: sample index, raw mode index, branch ID, mode ID.
- Frequency in Hz/GHz and angular frequency in rad/s.
- Imaginary frequency/damping rate.
- Normalization and damping policy.
- k vector/path position.
- Diagnostics:
  - residual norm,
  - residual linf,
  - tangent leakage mean/max,
  - orthogonality when available,
  - convergence.
- Field metadata and available complex views.

Actions:

- Plot mode in 3D.
- Change phase and view.
- Animate/pause phase.
- Open branch.
- Open resource metadata.

### `results.frequency_response.frequency_point`

Purpose: detailed selected driven response solve at one frequency.

Content:

- Frequency index, frequency Hz/GHz, angular frequency rad/s.
- Excitation provenance and phase.
- Response amplitude/phase.
- Absorbed power density.
- Susceptibility tensor summary.
- Residual and tangent leakage diagnostics.
- Sweep reuse/warm-start provenance.
- Response field metadata.

Actions:

- Plot field in 3D.
- Switch complex view.
- Animate phase.
- Open field resource.

## Resource Inspectors

Resource inspectors are not authoring panels. They explain what data exists,
what owns it, and whether it is fresh.

### `resources.analysis.frequency_domain.manifest`

Show:

- manifest schema/revision/session/run/stage,
- requested execution,
- resolved execution,
- physics block,
- artifact links,
- resource keys,
- diagnostics/capability summary.

Actions:

- Open result nodes referenced by the manifest.
- Copy manifest resource key.

### `resources.analysis.eigen.mode_field`

Show:

- field ID,
- source family `analysis/eigen`,
- quantity `delta_m`,
- value kind,
- components,
- storage layout,
- available views,
- data-plane resource key,
- revision.

Actions:

- Plot each available view.
- Animate phase when complex layout supports it.

### `resources.analysis.frequency_response.field`

Show:

- field ID,
- source family `analysis/frequency-response`,
- quantity,
- response frequency index,
- component basis,
- storage layout,
- available views,
- data-plane resource key.

Actions:

- Plot response field.
- Open owning frequency point.

## Diagnostics Inspectors

### `diagnostics.frequency_domain.capabilities`

Show every scoped capability used by UI gating:

- modal reference/production CPU/GPU,
- k-path,
- branch tracking,
- mode fields,
- response magnetic CPU/GPU,
- frequency sweep,
- Floquet response,
- static periodic boundary,
- dynamic demag-k,
- modal/response 3D visualization.

Each disabled command must point to one row here.

### `diagnostics.frequency_domain.equilibrium`

Show:

- equilibrium source,
- residual metrics,
- normalization errors,
- provenance,
- whether the state satisfies linearization requirements.

### `diagnostics.frequency_domain.operator`

Show:

- included energy terms,
- tangent basis status,
- demag realization,
- Floquet/demag compatibility,
- unsupported term reasons.

### `diagnostics.frequency_domain.solver`

Show:

- modal solver diagnostics when selected result is modal,
- response GMRES/matrix-free diagnostics when selected result is driven,
- requested versus resolved engine,
- precision/device,
- residual history when available,
- stop reason.

### `diagnostics.frequency_domain.artifacts`

Show:

- manifest consistency,
- missing artifact list,
- schema versions,
- v1/v2 fallback status,
- field payload availability.

### `diagnostics.frequency_domain.visualization`

Show:

- modal spectrum chart readiness,
- response sweep chart readiness,
- selected field metadata readiness,
- viewport command availability,
- last 3D overlay command result,
- canvas/WebGL readiness where exposed by diagnostics.

## Implementation Consequences

The current UI should be changed in this order:

1. Replace generic "node detail" language with domain titles and purpose text.
2. Split authoring detail panels by responsibility:
   - setup,
   - calculation mode,
   - equilibrium,
   - operator,
   - boundary,
   - k-path/k-grid,
   - excitation,
   - sweep,
   - solver,
   - outputs,
   - diagnostics.
3. Wire authoring controls to the same draft model and transaction/export path
   used by `StudyStageInspectorRouter`; do not create local-only state.
4. Keep result panels read-only except for visualization/selection commands.
5. Keep resource panels read-only except for "open", "copy", and "plot"
   commands.
6. Add tests per node kind proving:
   - no frequency-domain node routes to placeholder,
   - every node has a dedicated component identity,
   - authoring panels contain the canonical controls above,
   - result panels consume resource hooks and expose 3D commands when resources
     declare field availability,
   - disabled controls expose capability or validation reasons.
