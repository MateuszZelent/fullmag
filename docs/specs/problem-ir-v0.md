# ProblemIR v0

## Goal

`ProblemIR` is the canonical, typed representation of a Fullmag problem after Python-side serialization and before backend-specific lowering.

The source of truth is the serialized object graph, not Python source text.

## Top-level sections

- `ir_version`
- `ProblemMeta`
- `GeometryIR`
- `RegionIR`
- `MaterialIR`
- `MagnetIR`
- `EnergyTermsIR`
- `DynamicsIR`
- `SamplingIR`
- `BackendPolicyIR`
- `ValidationProfileIR`

## Design constraints

1. Python authors the problem; Rust validates and normalizes it.
2. The shared IR carries no grid indices, GPU storage layout, or FEM-only internals.
3. The IR is planner-ready: capability checks operate on canonical IR, not user syntax.
4. Reproducibility metadata is first-class for Python-authored runs.
5. `strict`, `extended`, and `hybrid` remain explicit in canonical validation state.

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
- `LLG` with gyromagnetic ratio, integrator, and optional fixed timestep
- field/scalar sampling
- FDM/FEM/Hybrid discretization hints
- backend target and execution mode
- execution precision policy

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
