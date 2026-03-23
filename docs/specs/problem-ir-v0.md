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

## Validation policy

Rust-side validation currently guarantees:

- required sections exist,
- names are unique where required,
- magnets reference known regions and materials,
- discretization hints are structurally valid,
- `LLG` parameters are structurally valid (see § DynamicsIR::Llg above),
- hybrid backend and hybrid mode stay coupled,
- only Python-authored IR is accepted by the bootstrap CLI and PyO3 helper.
