# ADR 0004: Backend-Canonical Quantities

| Field     | Value                                                |
| --------- | ---------------------------------------------------- |
| Status    | Accepted                                             |
| Date      | 2026-04-12                                           |
| Deciders  | Fullmag core team                                    |
| Relates   | fullmag_quantities_backend_first_masterplan_2026-04-12.mdx |

## Context

Fullmag currently scatters quantity identity, metadata, and validation across
four independent locations:

1. `crates/fullmag-runner/src/quantities.rs` — `QuantityId`, `QuantitySpec`, `QUANTITY_SPECS`.
2. `packages/fullmag-py/src/fullmag/model/outputs.py` — `_KNOWN_FIELDS`, `_KNOWN_SCALARS`.
3. `crates/fullmag-api/src/types.rs` — `QuantityDescriptor` (API view model).
4. `apps/web/` — hardcoded column labels, preview aliases, chart presets.

This causes:

- **Silent data loss**: `e_ani` and `e_dmi` were present in `StepStats` but missing
  from `global_scalar_value` and Python `_KNOWN_SCALARS`.
- **Magnetization special-casing**: `m` has a dedicated transport path (`StepUpdate.magnetization`)
  while all other quantities share a different path (`preview_field`, `cached_preview_fields`).
- **Parallel catalogs**: adding a new quantity requires coordinated edits in 4+ files.
- **Mixed concerns**: `StepStats` blends physical observables (energies, averages) with solver
  diagnostics (wall_time, rhs_evals, error_estimate).

## Decision

**The Rust backend is the single source of truth for all quantity metadata.**

Specifically:

1. A new shared crate `fullmag-quantities` defines the canonical `QuantityId`,
   `QuantityDescriptor`, `QuantityShape`, `QuantityDomain`, `QuantityLocation`,
   `QuantityReduction`, `QuantityComponent`, and `NormalizationHint` types plus
   the static `CATALOG` table.

2. `fullmag-runner`, `fullmag-ir`, `fullmag-plan`, `fullmag-api`, and
   `fullmag-py-core` all import from `fullmag-quantities`.  No parallel catalogs.

3. `StepStats` is split into `StepDiagnostics` (solver telemetry) and
   `GlobalQuantityRow` (physical scalar samples).

4. `m` is a regular quantity — no special top-level fields in transport structs.

5. Python `SaveField` / `SaveScalar` become thin wrappers around a new
   `SaveQuantity` class that validates against the backend catalog.

6. The API exposes `GET /api/quantities/catalog` so the frontend fetches the
   catalog at runtime instead of maintaining a local copy.

## Naming Freeze

The following canonical quantity IDs are frozen and **must not be renamed**:

| ID               | Shape          | Unit          | Domain         |
| ---------------- | -------------- | ------------- | -------------- |
| `m`              | vector_field   | dimensionless | magnetic_only  |
| `H_ex`           | vector_field   | A/m           | magnetic_only  |
| `H_demag`        | vector_field   | A/m           | full_domain    |
| `H_ext`          | vector_field   | A/m           | full_domain    |
| `H_ant`          | vector_field   | A/m           | full_domain    |
| `H_eff`          | vector_field   | A/m           | full_domain    |
| `H_ani`          | vector_field   | A/m           | magnetic_only  |
| `H_dmi`          | vector_field   | A/m           | magnetic_only  |
| `H_mel`          | vector_field   | A/m           | magnetic_only  |
| `H_ani_cubic`    | vector_field   | A/m           | magnetic_only  |
| `H_dmi_bulk`     | vector_field   | A/m           | magnetic_only  |
| `H_oe`           | vector_field   | A/m           | full_domain    |
| `H_therm`        | vector_field   | A/m           | magnetic_only  |
| `E_ex`           | global_scalar  | J             | magnetic_only  |
| `E_demag`        | global_scalar  | J             | magnetic_only  |
| `E_ext`          | global_scalar  | J             | full_domain    |
| `E_ani`          | global_scalar  | J             | magnetic_only  |
| `E_dmi`          | global_scalar  | J             | magnetic_only  |
| `E_total`        | global_scalar  | J             | full_domain    |
| `mode_amplitude` | spatial_scalar | dimensionless | magnetic_only  |
| `mode_real`      | vector_field   | dimensionless | magnetic_only  |
| `mode_imag`      | vector_field   | dimensionless | magnetic_only  |
| `mode_phase`     | spatial_scalar | rad           | magnetic_only  |

New quantities may be added but existing IDs must not change.

## Key Terminology

| Term                | Meaning                                                  |
| ------------------- | -------------------------------------------------------- |
| **Quantity**         | A named physical observable with shape, unit, and domain |
| **QuantityId**       | Canonical string identifier (e.g. `"H_ex"`)              |
| **QuantityShape**    | `vector_field`, `spatial_scalar`, `global_scalar`        |
| **QuantityDomain**   | `magnetic_only`, `full_domain`                           |
| **QuantityLocation** | `node`, `cell`, `global`                                 |
| **QuantityReduction**| `none`, `average`, `sum`, `min`, `max`, `magnitude`      |
| **StepDiagnostics**  | Solver telemetry: step, dt, wall_time, error_estimate    |
| **GlobalQuantityRow**| Per-step physical scalar samples (energies, averages)    |
| **QuantityProvider** | trait: evaluates a quantity from runtime state           |
| **QuantitySink**     | Where output goes: live_preview, snapshot, table, API    |

## Consequences

- Adding a new quantity requires **one** Rust change (catalog entry) + auto-propagation.
- Frontend becomes a thin catalog consumer, not a catalog maintainer.
- Solver diagnostics have a clean separation from physical observables.
- Transport unification enables generic quantity preview without magnetization special-casing.
- Legacy `SaveField`/`SaveScalar` remain working during transition via compat wrappers.
