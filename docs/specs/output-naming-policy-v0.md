# Output Naming Policy v0

- Status: accepted
- Last updated: 2026-03-24
- Parent spec: `docs/specs/exchange-only-full-solver-architecture-v1.md`

---

## 1. Purpose

This document freezes the canonical observable names for the current narrow executable release.
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
| `H_demag` | vector field | `[f64; 3]` per cell/node | A/m | demagnetization field |
| `H_ext` | vector field | `[f64; 3]` per cell/node | A/m | externally applied field |
| `H_eff` | vector field | `[f64; 3]` per cell/node | A/m | total effective field for the active interaction set |

### 2.2 Scalars

| Name | Kind | Type | Unit | Description |
|------|------|------|------|-------------|
| `E_ex` | scalar | `f64` | J | total exchange energy $\int e_{\mathrm{ex}} \, dV$ |
| `E_demag` | scalar | `f64` | J | total demagnetization energy |
| `E_ext` | scalar | `f64` | J | total external-field energy |
| `E_total` | scalar | `f64` | J | total realized energy for the active interaction set |
| `time` | scalar | `f64` | s | simulation time |
| `step` | scalar | `u64` | 1 | time-step index (0-based) |
| `solver_dt` | scalar | `f64` | s | timestep used in the current step |
| `max_dm_dt` | scalar | `f64` | 1/s | maximum $|d\mathbf{m}/dt|$ across the realized grid |
| `max_h_eff` | scalar | `f64` | A/m | maximum $|\mathbf{H}_{\mathrm{eff}}|$ across the realized grid |

### 2.3 Naming convention

- Field names are lowercase with underscores.
- Energy terms use `E_` prefix + interaction abbreviation (e.g., `E_ex` for exchange).
- Effective field terms use `H_` prefix + interaction abbreviation (e.g., `H_ex`).
- When multiple energy terms are active, `E_total` aggregates all terms and `H_eff` aggregates all
  effective field contributions.

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
- For the current executable FDM release, legal outputs are:
  - `m`
  - `H_ex`
  - `H_demag`
  - `H_ext`
  - `H_eff`
  - `E_ex`
  - `E_demag`
  - `E_ext`
  - `E_total`
  - `time`
  - `step`
  - `solver_dt`
  - `max_dm_dt`
  - `max_h_eff`
- `every_seconds` must be positive.
- At least one output is required per problem.

## 5. Future extensions

When additional energy terms are implemented, the following names will be added:

| Name | Kind | Unit | Notes |
|------|------|------|-------|
| `H_ani` | vector field | A/m | anisotropy field |
| `H_dmi` | vector field | A/m | DMI effective field |
| `H_mel` | vector field | A/m | magnetoelastic effective field |
| `E_ani` | scalar | J | anisotropy energy |
| `E_dmi` | scalar | J | DMI energy |
| `E_mel` | scalar | J | magnetoelastic coupling energy |
| `E_el` | scalar | J | elastic strain energy |
| `E_kin_el` | scalar | J | mechanical kinetic energy (elastodynamics) |
| `u` | vector field | m | displacement field |
| `u_dot` | vector field | m/s | velocity field (elastodynamics) |
| `eps` | tensor field | 1 | strain tensor (Voigt 6-component) |
| `sigma` | tensor field | Pa | stress tensor (Voigt 6-component) |
| `max_u` | scalar | m | maximum displacement magnitude |
| `max_sigma_vm` | scalar | Pa | maximum von Mises stress |
| `elastic_residual_norm` | scalar | 1 | mechanical solver convergence residual |
| `max_torque` | scalar | A/m | maximum $|\mathbf{m} \times \mathbf{H}_{\mathrm{eff}}|$ |

These names are reserved — no output with these names may be created with different semantics.
See `docs/specs/output-naming-policy-magnetoelastic-v1.md` for full magnetoelastic output specification.

## 6. Backend contract

Both FDM and FEM backends must:

1. Publish outputs using the exact names from §2.
2. Store fields in the same SI units regardless of internal representation.
3. Report `time`, `step`, and `solver_dt` with every output snapshot.
4. Include a provenance header linking the output to the `ProblemIR` and `ExecutionPlanIR` that produced it.

## 7. Container independence

The canonical observable names in this document are independent of storage container.

Current bootstrap reality:

- some outputs are still written as JSON/CSV.

Canonical product target:

- sampled scientific outputs should be storable in `.zarr` and `.h5`.
- OVF / OVF2 is the required interoperability format for field snapshots in OOMMF/MuMax-style
  workflows.

The observable names and SI semantics from this document must stay identical regardless of whether
the concrete container is JSON, CSV, Zarr, or HDF5.

Container-role clarification:

- `.zarr` is the preferred native container for time-sampled run data.
- `.h5` is the preferred portable scientific package/export container.
- OVF/OVF2 is the interchange format for individual field snapshots, especially for regular-grid FDM
  data.
- FEM outputs may provide OVF-compatible sampled field exports, but the canonical FEM artifact model
  must also preserve coordinates, connectivity, and FE metadata outside the OVF abstraction.

### 7.1 Ordinary script result bundle

For an ordinary launch with no explicit `--output-dir`, `/path/x.py` writes the
sibling `/path/x.zarr` Zarr v2 group. The bundle has the stable roles:

- `artifacts/`: final stage artifacts;
- `stages/`: preceding and interactive stage artifacts;
- `artifacts/fields/<observable>.zarr`: native time-sampled field arrays;
- `scalars.csv`, `tables/*.csv`, JSON metadata, and manifests: transitional
  compatibility members retained inside the versioned result bundle.

The root `.zattrs` declares `fullmag.script_results.v1` and records script and
session identity. Fullmag fails closed if the default sibling bundle already
exists; it never silently mixes two attempts. An explicit `--output-dir`
overrides the sibling-bundle convention and preserves its caller-selected
artifact/session layout.
