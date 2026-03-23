# Output Naming Policy v0

- Status: accepted
- Last updated: 2026-03-23
- Parent spec: `docs/specs/exchange-only-full-solver-architecture-v1.md`

---

## 1. Purpose

This document freezes the canonical observable names for the exchange-only release.
All backends must use exactly these names when publishing outputs. This ensures that:

- artifacts from FDM and FEM runs are directly comparable,
- post-processing tools can rely on stable field/scalar names,
- provenance metadata is unambiguous.

## 2. Canonical observable dictionary

### 2.1 Fields

| Name | Kind | Type | Unit | Description |
|------|------|------|------|-------------|
| `m` | vector field | `[f64; 3]` per cell/node | dimensionless | reduced magnetization $\mathbf{m} = \mathbf{M}/M_s$ |
| `H_ex` | vector field | `[f64; 3]` per cell/node | A/m | exchange effective field |

### 2.2 Scalars

| Name | Kind | Type | Unit | Description |
|------|------|------|------|-------------|
| `E_ex` | scalar | `f64` | J | total exchange energy $\int e_{\mathrm{ex}} \, dV$ |
| `time` | scalar | `f64` | s | simulation time |
| `step` | scalar | `u64` | 1 | time-step index (0-based) |
| `solver_dt` | scalar | `f64` | s | timestep used in the current step |

### 2.3 Naming convention

- Field names are lowercase with underscores.
- Energy terms use `E_` prefix + interaction abbreviation (e.g., `E_ex` for exchange).
- Effective field terms use `H_` prefix + interaction abbreviation (e.g., `H_ex`).
- When multiple energy terms are active (future releases), a `E_total` scalar aggregates all terms and `H_eff` aggregates all effective field contributions.

## 3. Output scheduling

Outputs are scheduled via `SamplingIR`:

```rust
pub enum OutputIR {
    Field { name: String, every_seconds: f64 },
    Scalar { name: String, every_seconds: f64 },
}
```

- `every_seconds` must be positive.
- The runner emits the output at the first step where `time >= last_output_time + every_seconds`.
- The first output is always emitted at `t = 0` (initial state).
- The final output is always emitted at the end of the simulation.

## 4. Validation rules

- Output names must match the canonical dictionary (§2). Unknown names are rejected.
- For the exchange-only release, only `m`, `H_ex`, `E_ex`, `time`, `step`, and `solver_dt` are legal.
- `every_seconds` must be positive.
- At least one output is required per problem.

## 5. Future extensions

When additional energy terms are implemented, the following names will be added:

| Name | Kind | Unit | Notes |
|------|------|------|-------|
| `H_demag` | vector field | A/m | demagnetization field |
| `H_ani` | vector field | A/m | anisotropy field |
| `H_dmi` | vector field | A/m | DMI effective field |
| `H_ext` | vector field | A/m | external (Zeeman) field |
| `H_eff` | vector field | A/m | total effective field |
| `E_demag` | scalar | J | demagnetization energy |
| `E_ani` | scalar | J | anisotropy energy |
| `E_dmi` | scalar | J | DMI energy |
| `E_ext` | scalar | J | Zeeman energy |
| `E_total` | scalar | J | total energy |
| `max_dm_dt` | scalar | 1/s | maximum $|d\mathbf{m}/dt|$ (convergence metric) |
| `max_torque` | scalar | A/m | maximum $|\mathbf{m} \times \mathbf{H}_{\mathrm{eff}}|$ |

These names are reserved — no output with these names may be created with different semantics.

## 6. Backend contract

Both FDM and FEM backends must:

1. Publish outputs using the exact names from §2.
2. Store fields in the same SI units regardless of internal representation.
3. Report `time`, `step`, and `solver_dt` with every output snapshot.
4. Include a provenance header linking the output to the `ProblemIR` and `ExecutionPlanIR` that produced it.
