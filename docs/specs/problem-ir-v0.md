# ProblemIR v0

## Goal

`ProblemIR` is the canonical, typed representation of a Fullmag problem after Python-side serialization and before backend-specific lowering.

The source of truth is the serialized object graph, not Python source text.

## Top-level sections

- `ir_version`
- `ProblemMeta`
- `GeometryIR`
- `GeometryAssetsIR` (optional bootstrap carrier for precomputed mesh / grid realizations)
- `RegionIR`
- `MaterialIR`
- `MagnetIR`
- `EnergyTermsIR`
- `AntennaLayoutIR` collection
- `FieldDriveIR` collection
- `StudyIR`
- `BackendPolicyIR`
- `ValidationProfileIR`

## Design constraints

1. Python authors the problem; Rust validates and normalizes it.
2. The shared IR carries no grid indices, GPU storage layout, or FEM-only internals.
3. The IR is planner-ready: capability checks operate on canonical IR, not user syntax.
4. Reproducibility metadata is first-class for Python-authored runs.
5. `strict`, `extended`, and `hybrid` remain explicit in canonical validation state.
6. When geometry realization must be precomputed outside Rust (for example Gmsh meshing or STL
   voxelization), the canonical carrier is `geometry_assets`, not ad-hoc `runtime_metadata`.

## ProblemMeta

`ProblemMeta` carries:

- problem name and description
- `script_language = "python"`
- original script source when available
- `script_api_version`
- `serializer_version`
- `entrypoint_kind`
- `source_hash`
- runtime metadata
- backend revision
- seeds

## Current MVP surface

Current bootstrap coverage includes:

- imported geometry references
- named regions
- material constants
- ferromagnets with uniform initial magnetization
- `Exchange`, `Demag`, `InterfacialDMI`, `Zeeman`
- `StudyIR::TimeEvolution`
- `StudyIR::Relaxation`
- `LLG` with gyromagnetic ratio, integrator, and optional fixed timestep
- field/scalar sampling
- FDM/FEM/Hybrid discretization hints
- backend target and execution mode
- execution precision policy

Current public-executable FDM lowering supports:

- `Box` geometry,
- `LLG(heun)`,
- `Relaxation` with algorithm-specific dynamics, canonical `RelaxStopIR`, and
  execution-owned completion semantics,
- `Exchange`, `Demag`, and `Zeeman` in executable combinations,
- canonical field outputs `m`, `H_ex`, `H_demag`, `H_ext`, `H_eff`,
- canonical scalar outputs `E_ex`, `E_demag`, `E_ext`, `E_total`, `time`, `step`, `solver_dt`,
  `max_dm_dt`, and `max_h_eff`.

Current limitation:

- the bootstrap IR separates `RegionIR` and `MaterialIR`, but it does not yet contain the full
  semantic model for heterogeneous material assignment and spatial parameter fields.
- that long-term policy is defined in:
  - `docs/specs/material-assignment-and-spatial-fields-v0.md`


## `GeometryIR`

`GeometryIR` stores a canonical list of geometry entries:

- imported geometry references,
- analytic primitives (`box`, `cylinder`).

Canonical shape:

```json
{
  "geometry": {
    "entries": [
      {"kind": "imported_geometry", "name": "track", "source": "track.step", "format": "step"},
      {"kind": "box", "name": "strip", "size": [2.0e-7, 2.0e-8, 5.0e-9]},
      {"kind": "cylinder", "name": "pillar", "radius": 5.0e-8, "height": 1.0e-8}
    ]
  }
}
```

Validation rules:

- at least one geometry entry is required,
- geometry names must be unique across all entry kinds,
- `Box.size` components must be positive,
- `Cylinder.radius` and `Cylinder.height` must be positive.

## `GeometryAssetsIR`

`GeometryAssetsIR` is an optional bootstrap carrier for geometry realizations that are already
constructed before planner lowering.

Current variants:

- `fdm_grid_assets`
  - `geometry_name`
  - `cells`
  - `cell_size`
  - `origin`
  - `active_mask`
- `fem_mesh_assets`
  - `geometry_name`
  - `mesh_source`
  - `mesh: MeshIR`

Semantics:

- `GeometryIR` remains the backend-neutral physical description.
- `GeometryAssetsIR` carries a realized numerical representation that can be consumed by a planner.
- This is a bootstrap seam for the shared geometry asset pipeline; it does not replace the
  canonical geometry semantics in `GeometryIR`.

Current use:

- FDM may consume a precomputed voxelized `active_mask` for imported or curved geometry.
- FEM may consume a precomputed `MeshIR` produced by the external meshing stack.

Validation rules:

- every asset must reference an existing `geometry_name`,
- at most one asset of each family may exist per geometry,
- `fdm_grid_assets.active_mask.len()` must match `cells[0] * cells[1] * cells[2]`,
- `MeshIR` must pass structural validation.

## `InitialMagnetizationIR`

Canonical magnetization variants:

- `Uniform { value: [f64; 3] }`,
- `RandomSeeded { seed: u64 }`,
- `SampledField { values: Vec<[f64; 3]> }`.

Public Python mapping:

- `fm.init.uniform(...)` -> `Uniform`,
- `fm.init.random(seed=...)` -> `RandomSeeded`,
- `fm.init.from_function(...)` -> `SampledField` once lowering-time sampling is implemented.

Validation rules:

- `Uniform.value` must contain exactly 3 components,
- `RandomSeeded.seed` must be positive,
- `SampledField.values` must be non-empty.


## `StudyIR`

`StudyIR` is the canonical carrier for computation intent.

Current variants:

- `TimeEvolution`
  - `dynamics: DynamicsIR`
  - `sampling: SamplingIR`
- `Relaxation`
  - `algorithm`
  - `dynamics: Option<DynamicsIR>`
  - `stop: RelaxStopIR`
  - `sampling: SamplingIR`

`dynamics` is required for `llg_overdamped` and forbidden for the direct
minimizers. `RelaxStopIR` carries `torque_tolerance_apm`,
`energy_tolerance_j`, `max_steps`, and the LLG-only
`max_relaxation_time_s`. Canonical authoring defaults are `1e-4 A/m` and
`50000` steps. A PG-BB/NCG/TPI line-search step has unit `m/A`; it is not RK,
`dt`, physical time, or pseudo-time.

Current public-executable production relaxation subset:

- `llg_overdamped` on documented FDM and FEM lanes,
- `projected_gradient_bb` on documented FDM and FEM CPU/GPU lanes, including
  qualified FEM demag at `rtol<=1e-12`; there is no hidden fallback.
- `nonlinear_cg` on documented FDM and FEM CPU/GPU lanes, including qualified
  FEM demag execution with the algorithm-specific solver policy.

Development-only:

- `tangent_plane_implicit`: extended mode may resolve only to the CPU/MFEM
  development lane with visible requested/resolved provenance; strict mode and
  forced GPU reject.

Relaxation completion is represented by `StageCompletionIR`: execution owns
`status`, `converged`, `reason`, metric kind/name/value/unit, and threshold.
`max_torque_apm` is the accepted-state `max |m x H_eff|` in `A/m`;
`max_torque_T` is its equivalent induction value in `T`, while
`max_rhs_norm_per_s` is a separate dynamic observable in `1/s`. Exact zero is
valid, budget exhaustion is completed but non-converged, and numerical
stagnation is failed/non-converged. Artifact sampling never infers completion.

### Planned staged antenna-field extension

Physics note 0950 and ADR 0017 define the canonical extension for a
variable-width three-dimensional microstrip/CPW. It adds these semantic types:

- `AntennaLayoutIR`: straight local current axis, rigid 3D transform,
  conductor thickness/conductivity, ordered width stations, named conductor
  parts, and explicit port modes;
- `AntennaPortModeIR`: terminal selectors and signed current weights whose sum
  is zero, normalized to 1 A;
- `StudyIR::AntennaFieldSolve`: field model, conductor-mesh policy,
  field-sampling domain, magnetic target references, solver policy, and named
  outputs;
- `SolvedAntennaDriveIR`: reference to an earlier stage output, port mode, peak
  current, canonical waveform, time origin, and active stages;
- `RegionalFieldDriveIR`: prescribed region, field amplitude/direction,
  spatial profile, waveform, time origin, and active stages.

These types replace the current design pressure to keep adding optional fields
to `CurrentModuleIR::AntennaFieldSource`. Existing constant-width antenna and
`prescribed_zeeman_mask` payloads remain compatibility inputs and normalize to
the new types. Existing `mqs_2p5d_az` input remains readable but lowers only to
the explicitly named `legacy_infinite_strip_biot_savart` compatibility
realization.

`ProblemIR` keeps one singular `study: StudyIR`. Multi-stage identity and
ordering remain owned by `StudyPipelineDocument`: add
`StudyPrimitiveStageKind::AntennaFieldSolve`, and let the primitive node id be
the `stage_id` used by downstream `StageOutputRefIR`. Before a downstream
`ProblemIR` reaches backend planning, orchestration resolves that reference to
a concrete `antenna_field_solution.v1` manifest id and content hash.

Validation requires monotone complete width stations, positive dimensions and
conductivity, explicit return conductors, terminal selectors that resolve to
nonempty faces, zero-sum current weights, unique ids, and an acyclic stage
reference to an earlier compatible field-solve output. Normalization may expand
symmetric CPW shorthand and constant-width layouts; it may not invent a missing
return path.

The shared IR does not carry MFEM finite-element spaces, CUDA buffers,
Biot-Savart work arrays, artifact paths, or target node/cell ordering. Those
belong to execution plans, native descriptors, and artifact provenance.

## `DynamicsIR::Llg` parameter policy

The LLG dynamics section carries the parameters needed for time integration.

### `integrator`

Type: `String` (enum-like).

Currently the only legal value is `"heun"` (explicit Heun / improved Euler).
Future values may include `"rk4"`, `"semi_implicit"`, or `"adaptive_rkf45"`.

The validator rejects unknown integrator names.

### `fixed_timestep`

Type: `Option<f64>`, unit: seconds.

Semantics:

- `None` — the runner picks `dt` (adaptive or default heuristic).
- `Some(dt)` — the runner calls the stepper with exactly this `dt` each step.

This is a **hint for the runner**, not a stepper-internal detail.
The stepper itself receives `dt` as a parameter and does not store it.

When provided, `fixed_timestep` must be positive.

### `gyromagnetic_ratio`

Type: `f64`, unit: m/(A·s).

Default value: `2.211e5` (Gilbert-form reduced gyromagnetic ratio).

This is the $\gamma$ in the reduced Gilbert-form LLG equation:

$$
\frac{\partial \mathbf{m}}{\partial t}
=
-\frac{\gamma}{1 + \alpha^2}
\left(
\mathbf{m} \times \mathbf{H}_{\mathrm{eff}}
+
\alpha \, \mathbf{m} \times
\left(\mathbf{m} \times \mathbf{H}_{\mathrm{eff}}\right)
\right)
$$

Must be positive. The validator rejects non-positive values.

---

## `BackendPolicyIR` precision policy

Execution precision is part of backend/runtime policy, not part of the physical LLG definition.

Canonical field:

- `backend_policy.execution_precision`

Legal values:

- `"double"`
- `"single"`

Semantics:

- `double` means the backend is asked to execute in double precision,
- `single` means the backend is asked to execute in single precision.

Current bootstrap state:

- CPU reference FDM is public-executable only for `double`,
- `single` is legal in Python API and canonical IR,
- `single` is reserved for the Phase 2 CUDA FDM path and is therefore not executable on the
  current CPU reference runner.

This field belongs to `BackendPolicyIR` because precision is an execution choice made by the user,
not a change in the physical problem description.

---

## Validation policy

Rust-side validation currently guarantees:

- required sections exist,
- names are unique where required,
- magnets reference known regions and materials,
- discretization hints are structurally valid,
- `LLG` parameters are structurally valid (see § DynamicsIR::Llg above),
- hybrid backend and hybrid mode stay coupled,
- only Python-authored IR is accepted by the bootstrap CLI and PyO3 helper.

Future IR expansion should preserve this rule:

- shared `ProblemIR` stores semantic relationships between regions, materials, and parameter
  variation,
- execution plans store the backend-specific realized cell/element data.
