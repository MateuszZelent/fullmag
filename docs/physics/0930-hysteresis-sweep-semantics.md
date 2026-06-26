# Hysteresis Sweep Semantics

- Status: implementation-audited draft
- Owners: Fullmag Core
- Last updated: 2026-06-11
- Last implementation audit: 2026-06-11
- Related ADRs: `docs/adr/0011-resource-first-api.md`
- Related specs: `docs/specs/resource-first-control-room-api-v2.md`, `docs/specs/frontend-v2/16-charts-analysis-module.md`

## 1. Problem Statement

Quasistatic hysteresis loops are a primary scientific diagnostic in micromagnetics, representing the response of a ferromagnet to a sequence of external fields. This note documents the physics-first semantics for authoring, planning, executing, and analyzing hysteresis loops, including OOP/IP field geometries, auto-saturation probe passes, and history-dependent minor loops.

## 2. Physical Model

### 2.1 Governing Equations

Hysteresis is treated as a sequence of equilibrium or metastable states. For each external field magnitude $h_i$ along a unit direction vector $\mathbf{u}_H$, the total magnetic field is:

$$\mathbf{H}_{\text{ext}, i} = h_i \mathbf{u}_H$$

The magnetization $\mathbf{m}$ is relaxed to a local minimum of the total energy density:

$$E_{\text{total}} = E_{\text{ex}} + E_{\text{demag}} + E_{\text{ext}} + E_{\text{ani}} + E_{\text{dmi}} + \dots$$

#### Projections and Averages
The averaged magnetization vector $\langle\mathbf{m}\rangle$ is moment-weighted across multi-material geometries:

$$\langle\mathbf{m}\rangle = \frac{\int M_s(\mathbf{r}) \mathbf{m}(\mathbf{r}) dV}{\int M_s(\mathbf{r}) dV}$$

We define the following scalar observables:
- Parallel Magnetization: $m_{\parallel} = \langle\mathbf{m}\rangle \cdot \mathbf{u}_H$
- Out-of-Plane (OOP) Magnetization: $m_{\text{oop}} = \langle\mathbf{m}\rangle \cdot \mathbf{n}_{\text{sample}}$
- In-Plane (IP) Magnetization: $m_{\text{ip}} = |\langle\mathbf{m}\rangle - m_{\text{oop}}\mathbf{n}_{\text{sample}}|$
- Transverse component: $\mathbf{m}_{\text{transverse}} = \langle\mathbf{m}\rangle - m_{\parallel} \mathbf{u}_H$

#### Metrics
- Remanence $M_{r\pm}$: Interpolated value of $m_{\parallel}$ at $H_{\text{ext}} = 0$.
- Coercivity $H_{c\pm}$: Interpolated value of $H_{\text{ext}}$ where $m_{\parallel} = 0$.
- Differential susceptibility diagnostic:
  $\chi_{\Delta,i}=\Delta m_{\parallel}/\Delta H_{\text{mT}}$ between adjacent
  settled points. Fullmag reports the maximum absolute finite value in
  `max_differential_susceptibility` with units $1/\text{mT}$.
- Switching field candidates: adjacent point pairs with the largest finite
  $|\chi_{\Delta}|$ are reported as candidate switching intervals. They are
  derivative-based diagnostics, not confirmed coercive fields. A candidate may
  correspond to nucleation, domain-wall motion, reversal, or a numerical
  under-resolved jump depending on the problem and field spacing.
- Loop Area (Energy Dissipation):
  
  $$W = \mu_0 \oint \mathbf{M} \cdot d\mathbf{H}_{\text{ext}}$$
  Fullmag also reports `loop_closure_summary` with the first/last field gap
  and $m_{\parallel}$ gap. `loop_area` remains numeric for compatibility, but
  its metric status is `warning` unless the sampled path returns to the initial
  field and closes within the configured magnetization tolerance.

Metric warnings are part of the scientific result. Missing positive/negative
coercive crossings, missing remanence interpolation, too few points, unverified
saturation, and non-converged field points must be exposed as warnings rather
than silently represented by zero-valued metrics.

Every reported metric has an explicit status in `metric_statuses`:
`available` means the numeric value is physically supported by the current
loop data, `unavailable` means the value is absent because the required
crossing, interpolation, or data support is missing, and `warning` means the
numeric value exists but interpretation is limited by saturation, convergence,
or loop-completeness diagnostics.

### 2.2 Symbols and SI Units

| Symbol | Description | SI Unit |
|---|---|---|
| $\mathbf{H}_{\text{ext}}$ | External magnetic field vector | $\text{A/m}$ |
| $h_i$ | Field amplitude at step $i$ | $\text{A/m}$ |
| $\mu_0$ | Vacuum permeability ($4\pi \times 10^{-7}$) | $\text{H/m}$ |
| $M_s$ | Saturation magnetization | $\text{A/m}$ |
| $\mathbf{m}$ | Normalized local magnetization vector | $1$ |
| $m_{\parallel}$ | Parallel projection of averaged magnetization | $1$ |
| $\hat{\mathbf{u}}_H$ | Unit vector of the applied hysteresis field | $1$ |
| $\hat{\mathbf{u}}_{\text{meas}}$ | Unit vector used for reported loop projection | $1$ |
| $\chi_{\Delta}$ | Finite-difference differential susceptibility of $m_{\parallel}$ versus field amplitude | $1/\text{mT}$ |
| $W$ | Hysteresis loop energy loss per unit volume | $\text{J/m}^3$ |
| $\theta, \phi$ | Field orientation angles | $\text{rad}$ (in UI: $\text{deg}$) |

Public hysteresis authoring fields named `*_mT` represent the magnetic flux
density equivalent $\mu_0 H$ in millitesla, matching common micromagnetics UI
and mumax-style sweep notation. The canonical physical field remains
$\mathbf{H}_{\text{ext}}$ in $\text{A/m}$; lowering therefore records
`field_unit_provenance` with `authored_quantity="mu0_h"`,
`authored_unit="mT"`, `canonical_quantity="h_ext"`,
`canonical_unit="A/m"`, `display_unit="mT"`, and
`mu0_h_per_m=1.2566370614359172e-6`.

### 2.3 Assumptions and Approximations
- **Quasistatic limit:** The sweep rate $dH/dt$ is assumed to be slow enough that magnetization relaxes fully to a steady state at each step.
- **Warm start:** Backends carry over the final magnetization state of step $i$ as the starting guess for step $i+1$ on the same branch.
- **Projection axis:** `field_axis` reports
  $m_{\parallel}=\langle\mathbf{m}\rangle\cdot\hat{\mathbf{u}}_H$.
  `sample_normal` reports projection onto the sample $+z$ normal, independent
  of the applied field direction. This keeps in-plane sweeps and OOP readouts
  scientifically distinguishable.
- **OOP/IP decomposition:** `m_oop` and `m_ip` are sample-frame observables,
  not aliases for whichever axis is used by `measurement_axis`.
  `m_oop = <m> . n_sample` and
  `m_ip = |<m> - m_oop n_sample|`. The current default sample frame uses
  `n_sample = +z`; future object/sample-frame extensions must resolve and
  record their `n_sample` instead of silently falling back to global axes.

## 3. Numerical Interpretation

### 3.1 FDM
- Computes volume averages by cell-count weighting.
- External field components are uniform across the grid.

### 3.2 FEM
- Averages are weighted by the volume elements and basis functions.
- Multi-region assemblies integrate $M_s(\mathbf{r})$ elements appropriately.
- Linear solvers (e.g., hypre AMG) cache preconditioners between steps.

### 3.3 Settle Pipeline and Retry Semantics
- Each hysteresis field point owns a settle pipeline made of relaxation,
  minimization, or dynamics-settle steps.
- Each settle step may define an explicit fixed `timestep_s` in seconds. When
  present, the runtime must pass it to the backend for that algorithm attempt
  and disable backend adaptive stepping for the attempt. When omitted, the
  resolved backend timestep or the hysteresis runtime default is used.
- Each settle step may define `max_pseudotime_s` and/or
  `max_physical_time_s` stop limits in seconds. These limits are part of the
  per-algorithm convergence contract, not a UI-only timeout. Runtime lowering
  must propagate them into `RelaxStopIR` so stop reasons and non-convergence
  handling remain auditable.
- `on_non_convergence="run_next_algorithm"` means the next sequence step or
  non-converged tree branch is executed only after the previous step reports a
  non-converged stop reason such as max steps or time limit.
- `on_non_convergence="retry_with_smaller_dt"` requires an explicit
  `retry_timestep_scale` in the public authoring contract. The retry attempt
  re-runs the same settle step from the step input magnetization with a smaller
  resolved fixed timestep. If the original step defines `timestep_s`, the retry
  scale is applied to that value; otherwise it is applied to the backend/default
  resolved timestep. `retry_max_attempts` bounds the retry count and defaults
  to one attempt when omitted.
- The runtime settle trace records the actually executed algorithm, status,
  fallback reason, retry attempt, resolved timestep, torque, and total energy
  for audit and Control Room inspection.
- Stage-level preparation and saturation-probe settles are recorded in the
  same settle trace with `protocol_role="preparation"` or
  `protocol_role="saturation_probe"` and without a measured sweep `point_id`.
  This preserves pre-sweep provenance without shifting `hysteresis_points.json`
  point identifiers or the `/steps/{point_id}` resource contract.

### 3.4 Saturation Preparation Status
- A `positive_saturation` or `negative_saturation` initial protocol applies a
  preparation field before the measured sweep.
- Applying a preparation field is not equivalent to proving saturation. When no
  `SaturationProbe` is configured, runtime metrics report
  `preparation_from_schedule_unverified` for a preparation field inferred from
  the requested sweep range.
- When `SaturationProbe` is configured, runtime executes probe points up to
  `max_field_mT`, records them in `hysteresis_saturation.json`, and classifies
  the start as `saturated`, `probably_saturated`, or `capped_by_limit` using
  the last-point susceptibility, transverse magnetization, and
  distance-to-saturation checks.
- `SaturationProbe.on_failure` controls what happens when the probe cannot
  verify at least `probably_saturated` before the field limit. The default is
  `continue_with_warning` for backward compatibility: the main sweep continues,
  but metrics and saturation resources expose the limited interpretation.
  `stop_stage` records the saturation artifact and terminates the hysteresis
  stage before writing ordinary major-loop points, preventing a capped
  preparation field from being presented as a valid measured loop.
- The reported saturation estimates are named `H_sat+` and `H_sat-` for
  positive and negative preparation directions. They are only available when
  probe evidence exists; a preparation field inferred from a schedule is
  reported as unverified and must not be relabeled as `H_sat`.
- The saturation artifact is exposed through
  `/v2/sessions/current/analysis/hysteresis/{stage_id}/saturation` and includes
  probe points, thresholds, status, and decision reason.
- The metrics artifact exposes the applied preparation field as
  `saturation_preparation_field_mT` when such a field was used.
- `as_authored` and `zero_field_relaxed` runs report saturation status
  `not_requested`.
- A checkpoint-started hysteresis run is requested as
  `initial_protocol="checkpoint"` plus a non-empty `initial_state_ref` that
  identifies the field-state artifact or hysteresis magnetization snapshot to
  load. The reference is part of the public experiment intent and must survive
  Python DSL, ProblemIR, UI authoring, and provenance round trips.

### 3.5 Magnetization Snapshot Storage
- `magnetization="every_step"` stores a full vector magnetization snapshot for
  every hysteresis field point.
- `magnetization="every_n"` stores a full vector magnetization snapshot when
  `point_index % every_n == 0`.
- `magnetization="key_events"` stores full vector magnetization snapshots only
  at scientifically relevant points: zero-field crossings, field turning
  points, large changes in $m_{\parallel}$ above `key_event_threshold_dm`, and
  points whose settle trace reports a non-converged warning or failed status.
- Stored snapshots are immutable artifacts referenced from the scalar
  hysteresis history by `snapshot_id`; visualization consumers must load the
  corresponding vector magnetization from that snapshot instead of inferring it
  from averaged loop data.
- Snapshot containers must preserve the averaging provenance used for
  `m_avg`, `m_parallel`, `m_oop`, and `m_ip`. When the reported
  `magnetization_average_weighting` is not `uniform_sample_average`, the
  container must include the per-sample averaging weights or an equivalent
  reproducible weighting reference. A verifier must not compare weighted FEM or
  multi-material FDM loop points against the unweighted full-snapshot mean,
  because `scope=full` may include airbox or zero-weight samples.
- Production storage for full hysteresis field playback is a data container,
  not a large JSON array. The preferred native container for per-point sampled
  magnetization is Zarr; HDF5 is the portable/export container. Small JSON
  artifacts may remain as manifests, point tables, metrics, and compatibility
  metadata, but full `m` playback frames should be referenced from the
  container by `snapshot_id`, point id, branch id, quantity id, mesh identity,
  and field revision.
- The playback container must record the resolved magnetization snapshot
  policy as `magnetization_storage_policy` in both `hysteresis.zarr/.zattrs`
  and `hysteresis.zarr/fields/m/.zattrs`. This policy is the provenance for
  whether the container represents `every_step`, `every_n`/`selected`, or
  `key_events` capture and must match the stage's resolved storage intent.
- Optional auxiliary field snapshots such as `H_demag` and `H_eff` are useful
  for debugging, diagnostics, and publication figures, but they are not part of
  the mandatory baseline hysteresis workflow and must not be treated as an MVP
  or production-readiness gate for magnetization playback. They must be
  controlled by an explicit auxiliary-field storage policy, disabled by default,
  because they can require extra backend recomputation or GPU/FEM host
  synchronization. The baseline "mumax-style playback" requirement is full `m`
  for every requested field point when `magnetization="every_step"`.

### 3.6 Minor Loop Execution Status
- The current runtime artifact policy `derived_from_major_loop_window` means
  that the reported minor-loop resource is derived from an already executed
  major-loop window between the configured reversal and return fields.
- This policy is useful for UI/API contract validation and branch-aware
  analysis plumbing, but it is not a history-dependent minor-loop fork.
- The runner now supports the first history-dependent execution policy:
  `branch_only`. If the configured reversal field is an already executed
  parent major-loop field, the branch forks from that parent magnetization. If
  the configured reversal field is off-grid, the runtime selects the nearest
  executed parent major-loop state as the physical initial state, executes an
  additional settle point at the exact configured reversal field, then forks
  the return branch from that computed reversal magnetization. The artifact
  must report the configured reversal field, not the nearest parent field, and
  must record both the parent point reference and the reversal settle trace.
  This avoids presenting an interpolated or snapped state as a measured minor
  loop branch.
- The public contract uses `minor_loop_id`, `reversal_field`, `return_field`,
  and `parent_branch_id` to keep a minor-loop branch distinct from the major
  loop and from derived chart windows.
- `branch_only` and `resume_parent` are intentionally non-mutating: after the
  minor-loop branch is recorded, the parent/major-loop state remains the final
  stage state. `resume_parent` records the requested continuation provenance
  explicitly for consumers that need to distinguish branch-only analysis from
  parent-resume intent.
- `replace_parent` is an explicit advanced continuation policy. It updates the
  runtime's working parent state at the minor-loop return field, so subsequent
  minor loops in the same stage can fork from the returned branch state instead
  of the originally executed major-loop state. It does not rewrite already
  published `hysteresis_points.json` major-loop points; consumers must treat
  the replacement as minor-loop continuation provenance recorded in
  `hysteresis_minor_loops.json`.
- Minor loops may include `intermediate_fields_mT` to execute additional
  history-dependent field points between the reversal field and return field.
  The runtime advances through each intermediate point in order from the
  previous computed magnetization; it does not interpolate magnetization or snap
  reported fields to major-loop points. `return_point_id` identifies the final
  point in the minor-loop artifact.
- Interpolated reversal states and richer labeled/segmented minor-loop schedule
  metadata remain deferred.
- Consumers must not interpret `derived_from_major_loop_window` as evidence
  that such a branch was executed.

### 3.7 Magnetization Average Weighting Status
- The physical target for hysteresis observables is the moment-weighted average
  $\langle\mathbf{m}\rangle = \int M_s \mathbf{m} dV / \int M_s dV$.
- The runtime reports `magnetization_average_weighting` in
  `hysteresis_metrics.json`, the v2 metrics resource, and stored snapshot
  container metadata.
- FDM hysteresis metrics use `moment_weighted_fdm_ms_volume` when the resolved
  plan has usable per-cell weights: $M_s$ from `ms_field` or uniform material
  $M_s$, active-mask exclusion, and boundary volume fraction where available.
  If those arrays are missing or inconsistent, the runtime falls back to
  `uniform_sample_average`.
- FEM hysteresis metrics use `moment_weighted_fem_p1_lumped_ms_volume` for the
  current P1 tetrahedral magnetization field: each magnetic tetrahedron
  contributes $M_s V_e / 4$ to its four nodes, with marker-0 air elements
  skipped. If node, element, or coefficient arrays are inconsistent, the
  runtime falls back to `uniform_sample_average`.
- `uniform_sample_average` remains scientifically valid only for uniform-
  material, uniform-sampling cases where all active samples represent the same
  magnetic moment. Consumers must inspect the reported weighting before using
  coercivity, remanence, or loop-area metrics for multi-material comparisons.
- Stored Zarr playback for weighted averages records the one-dimensional
  `average_weights` array alongside `fields/m`. The array length matches the
  `spatial_sample` axis, zero weights exclude airbox or inactive samples, and
  the weighted point average is
  `sum_i average_weights[i] * m_i / sum_i average_weights[i]`.

## 4. API, IR, and Planner Impact

### 4.1 Python API Surface
```python
study.stages.add_hysteresis_sweep(
    field_min_mT=-100.0,
    field_max_mT=100.0,
    field_step_mT=5.0,
    orientation=fm.FieldOrientation.preset("oop_positive"),
    initial_protocol="positive_saturation",
    settle_pipeline=fm.SettlePipeline([...])
)
```

### 4.2 ProblemIR Representation
`StudyIR` is extended to support `Hysteresis` containing a `field_schedule`, `settle_pipeline`, and `storage_policy`.
Adaptive refinement is represented as an explicit policy. Refined points affect
global hysteresis metrics only when `include_in_metrics=true`; the default is
`false`, so reproducible metrics remain tied to the requested field schedule
unless the user explicitly opts into refinement-aware metrics.
Runtime adaptive refinement honors `max_passes` as a bounded iterative
scheduler: each pass proposes at most `max_insertions_per_pass` candidates from
the current sweep order, including adaptive points inserted by earlier passes.

### 4.3 Planner and Capability-Matrix Impact
The planner expands the piecewise segments and refinements into a sequence of concrete `HysteresisPointIR` steps before execution.
Runtime adaptive-refinement points remain separate from `hysteresis_points.json`
and are reported through `hysteresis_adaptive_refinement.json`, even when they
are included in the final metrics calculation.

## 5. Validation Strategy

### 5.1 Analytical Checks
- Stoner-Wohlfarth coherent rotation loops for various angles $\theta$. The
  fast FDM macrospin regression uses a near-easy-axis variant at
  $\theta=30^\circ$ rather than the exactly collinear $\theta=0^\circ$ case,
  because ideal easy-axis switching is a torque-free saddle in deterministic
  local minimization and needs an explicit perturbation/noise policy. The fast
  artifact validator also rejects gross violations of the analytical
  Stoner-Wohlfarth astroid coercivity ratio between the $\theta=30^\circ$ and
  $\theta=45^\circ$ variants; tighter publication tolerances remain a separate
  acceptance gate.
- Thin-film demagnetizing contrast for OOP versus in-plane applied fields. The
  fast FDM CPU regression uses a tiny strip with demag enabled and verifies that
  the in-plane high-field projection remains much larger than the OOP
  high-field projection while both branches show a measurable hysteresis
  response.
- Projection-axis regression: an in-plane applied field with
  `measurement_axis="sample_normal"` must not report the in-plane component as
  $m_{\parallel}$.
- Runtime artifact projection benchmark: the small FEM waveguide projection
  smoke computes `ip_x`, `oop`, and `custom_theta45_phi30` angular-family
  variants and verifies that each stored point satisfies
  `m_parallel = <m> . u_meas`, `m_oop = <m> . n_sample`, and
  `m_ip = |<m> - m_oop n_sample|`.
- The publication-suite manifest validator requires the fast FDM macrospin
  Stoner-Wohlfarth trend, the FDM thin-film OOP/IP demag contrast fixture, and
  the projection/custom-angle benchmark to be present, reproducibly described,
  and individually valid before the suite is accepted.
- Playback artifact validation must verify `m_avg` directly from stored `m`
  snapshots. For `uniform_sample_average`, the verifier uses the unweighted
  mean. For weighted FDM/FEM cases, the verifier uses the stored
  `average_weights` array and must fail if the weights are missing or
  inconsistent with the snapshot sample axis.

### 5.2 Cross-Backend Checks
- Matching coercivity and remanence between FDM and FEM solver references.

## 6. Completeness Checklist
- [x] Documentation
- [x] Python API for canonical sweep authoring, piecewise schedules, dense
  windows, settle pipelines, storage policy, and derived minor-loop contract
- [x] ProblemIR validation for current canonical sweep fields and settle
  pipeline constraints
- [x] Planner routes canonical hysteresis as one workflow stage and leaves
  per-point field injection to runtime
- [x] Runner execution for average-only major-loop workflow, settle trace,
  auto-saturation probe artifacts, selected snapshots, and explicit
  average-weighting provenance
- [x] Production moment-weighted multi-material hysteresis metrics for FDM
  cell sampling and current FEM P1 tetrahedral sampling, with explicit fallback
  provenance
- [x] Initial history-dependent `branch_only` minor-loop fork/return execution
  with dedicated settle trace and non-mutating parent continuation
- [x] OpenAPI endpoints for current hysteresis points, metrics, saturation,
  minor-loop, settle-trace, and snapshot resources
- [x] Control Room UI for current inspector, explorer, and analysis chart
  surfaces
- [x] Live Charts for current progress/history selection workflow
- [x] Viewport 3D Replay for stored magnetization snapshots
- [x] Runtime artifact projection benchmark for OOP, in-plane, and custom-angle
  angular-family variants
- [x] Runtime artifact smoke for insufficient auto-saturation field limits with
  `capped_by_limit` provenance
- [x] Runtime artifact smoke for `branch_only` minor-loop execution with
  branch-local points and settle trace
- [x] Public DSL/ProblemIR/runtime provenance for `resume_parent` minor-loop
  continuation without mutating the major-loop artifact
- [x] Public DSL/ProblemIR/runtime provenance for `replace_parent` minor-loop
  continuation as a working-parent state replacement for later minor loops,
  without rewriting the major-loop artifact
- [ ] Higher-order FEM and future non-P1 basis-specific hysteresis averaging
- [x] Multi-point minor-loop schedules through `intermediate_fields_mT`, with
  history-dependent execution and final return-point provenance
- [ ] Complete remaining minor-loop extensions: interpolated reversal states
  and richer labeled/segmented schedule metadata
- [x] Explicit adaptive-refinement metrics policy (`include_in_metrics`) with
  default schedule-only metrics
- [x] Adaptive refinement scheduler honors `max_passes`,
  `max_insertions_per_pass`, and descendant adaptive points in metrics when
  explicitly opted in
- [x] Fast publication-suite manifest gate across macrospin, OOP/IP thin-film,
  and custom-angle projection benchmark cases
- [x] Fast publication validators require `metric_statuses` entries with
  `available` status and non-empty reasons for required publication metrics in
  OOP/IP thin-film and custom-angle projection benchmark artifacts
- [x] Publication-suite manifest declares cross-backend acceptance scope,
  reference lane, required coercivity/remanence metrics, explicit
  FDM/FEM CPU/GPU lane statuses, and deferred tolerance rationale
- [x] Optional cross-backend metrics parity validator for paired
  `hysteresis_metrics.json` artifacts, requiring finite coercivity/remanence
  values, `metric_statuses[*].status="available"`, and explicit per-metric
  tolerances for the required `H_c+/-` and `M_r+/-` set before a
  publication-suite manifest may claim validated cross-backend acceptance.
  Metrics and parity manifests must resolve only within the manifest tree, and
  a `validated` cross-backend acceptance claim may not retain deferred
  tolerance entries, non-validated lane statuses, or lane statuses not covered
  by parity checks whose pair reference is the declared reference lane.
- [ ] Publication-grade scientific validation suite with analytical
  Stoner-Wohlfarth tolerances and validated cross-backend numerical parity
