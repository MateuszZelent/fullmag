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

**Current implementation at base `9902410b016dbe934669122ef00a7825bbd2d5b0`
(source inspection):** periodic `OutputIR` variants carry `every_seconds`;
automatic variants must be resolved before schedule collection
(`OutputIR`, `crates/fullmag-ir/src/study.rs:1824-1858`;
`require_resolved_periodic_outputs`,
`crates/fullmag-runner/src/schedules.rs:18-29`). The cadence must be positive.

The schedules start at `next_time = 0`. The runner samples the first accepted
state at or after that grid time, within `OUTPUT_TIME_TOLERANCE = 1e-18 s`.
It advances `next_time` by whole cadence intervals until the next grid time
is beyond the sampled time. It does **not** reset the grid to
`last_output_time + every_seconds`. A step that crosses multiple grid times
produces one sample, without interpolation
(`collect_scalar_schedules`, `collect_field_schedules`, `is_due`, and
`advance_due_schedules`, `crates/fullmag-runner/src/schedules.rs:8-179`).

The initial-state schedule is due at `t = 0`. Terminal-state output is a
separate finalization action; the CPU reference implementation avoids
repeating a field already sampled at that time
(`record_final_outputs`,
`crates/fullmag-runner/src/fdm/cpu/reference.rs:3427-3475`).
Time-cadenced tables also advance a fixed grid and label overshoot
`coalesced_to_step` (`TableStore::append_if_due`,
`crates/fullmag-runner/src/table_autosave.rs:166-198`).

**Future v1 contract:** [Canonical Zarr output store](output-store-zarr-v1.md)
retains accepted-state sampling on this grid and specifies actual absolute
sample times, steps, and stage metadata. This is a future writer contract,
not evidence that the cited writers already store that metadata.

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
- OVF / OVF2 remains an interoperability target for individual field snapshots
  in OOMMF/MuMax-style workflows. It is not a required sidecar for the future
  [v1 Zarr store](output-store-zarr-v1.md).

The observable names and SI semantics from this document must stay identical regardless of whether
the concrete container is JSON, CSV, Zarr, or HDF5.

**Current implementation at base `9902410b016dbe934669122ef00a7825bbd2d5b0`
(source inspection):** `writer_loop` writes CSV scalar rows and routes host
field snapshots to JSON or Zarr; native snapshot jobs use Zarr. These branches
do not emit an OVF sidecar (`crates/fullmag-runner/src/artifact_pipeline.rs:1685-1985`,
`writer_loop`). `ZarrFieldSeriesWriter::open` uses `fields/<observable>.zarr`
and `samples.csv`, and `write_zarray_metadata` uses uncompressed
`[sample, component, cell]` arrays with `<f4` or `<f8`. This writer is compiled
only with `cuda` or `fem-gpu`
(`crates/fullmag-runner/src/artifact_pipeline.rs:1350-1449,1651-1683`,
`ZarrFieldSeriesWriter`, `zarr_dtype`).

**Future v1 contract:** [Canonical Zarr output store](output-store-zarr-v1.md)
supersedes the legacy `stages/` payload layout and `fields/<observable>.zarr`
series for time-domain outputs after writer integration and reader migration.
It specifies root quantity arrays and a per-column `table/` group. Existing
CSV/JSON outputs remain compatibility outputs. This does not claim that v1
exists at the cited base. D6–D9 in the input plan remain recommendations,
not accepted decisions.

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
- `artifacts/fields/<observable>.zarr`: legacy time-sampled field arrays when
  the runner selects its Zarr field-series writer (not a universal path for
  every saved field);
- `scalars.csv`, `tables/*.csv`, JSON metadata, and manifests: transitional
  compatibility members retained inside the versioned result bundle.

The root `.zattrs` declares `fullmag.script_results.v1` and records script and
session identity. A repeated ordinary launch reserves a fresh directory with
an execution suffix (`existing_output=timestamp`) or fails explicitly
(`existing_output=error`). Existing results are never removed or overwritten.
An explicit `--output-dir` overrides the sibling convention with the same
safe reservation policy. Output format, private temporary storage and cleanup
follow [the common project policy](project-output-storage.md).
