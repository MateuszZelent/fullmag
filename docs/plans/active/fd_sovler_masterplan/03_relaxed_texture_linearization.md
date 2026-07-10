---
title: Frequency-driven solver - relaxed texture linearization
version: target v6 contract over current v5 runtime
date: 2026-07-10
status: normative target; v6 runtime schema and consumers not yet implemented
---

# Relaxed texture handoff and LinearizationState

## 1. Authority and target status

This chapter consumes `FrequencyOperatorDictionary.v1` from
[physics note 0831](../../../physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md).
It defines the target `EquilibriumArtifact.v6` and `LinearizationState.v6`
documentation contracts. It does not claim that the target-v6 schemas,
materializers, builder, planner consumers, or runtime consumers exist.

The current executable contract remains v5 until every producer and consumer
has migrated and the corresponding runtime evidence has been accepted. A v5
artifact must not be relabelled as v6 without explicit migration and validation.

## 2. Accepted equilibrium is a hard input

Frequency-domain analysis around a nonlinear magnetic state consumes an
accepted equilibrium artifact. Driven and modal solvers must not relax,
reconstruct, or silently substitute equilibrium state.

```text
relaxation or certified static solve
  -> accepted EquilibriumArtifact.v6
  -> LinearizationState.v6 builder
  -> tangent frames and periodic mesh certificate
  -> FrequencySolvePlanner
  -> selected backend
```

The target artifact has a conditional shape selected by the required
`phi0_requirement` discriminator. The branch in which scalar-potential restart
or provenance is required is:

```json
{
  "schema_version": "EquilibriumArtifact.v6",
  "accepted_for_linearization": true,
  "stop_reason": "torque_tolerance",
  "m0": "fields/m0_unit.zarr",
  "h_eff0_a_per_m": "fields/h_eff0_a_per_m.zarr",
  "h_demag0_a_per_m": "fields/h_demag0_a_per_m.zarr",
  "phi0_requirement": "required_for_restart_or_provenance",
  "phi0_a": "fields/phi_demag0_a.zarr",
  "mesh_signature": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "material_signature": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "physics_signature": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "boundary_signature": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "static_demag_signature": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "max_m0_norm_error": 0.0,
  "max_m0_cross_h_eff0_relative": 0.0
}
```

`accepted_for_linearization=true` is valid only when `stop_reason` is an
accepted convergence or independently certified equilibrium reason under the
producer schema. Reaching a step, iteration, or wall-time limit is not implicit
acceptance. The artifact records the acceptance tolerances and producer run ID
in its provenance envelope.

`m0`, `h_eff0_a_per_m`, and `h_demag0_a_per_m` are required in both branches.
`phi0_requirement` is also required and has exactly these conditional-schema
rules:

| `phi0_requirement` | Canonical `phi0_a` shape |
|---|---|
| `required_for_restart_or_provenance` | required nonempty artifact reference |
| `not_required_by_resolved_demag_realization` | field must be absent |

Omission is the sole canonical representation for the not-required branch;
JSON `null` is invalid in both branches. The selected resolved static-demag
realization determines the discriminator. Validation rejects a missing or
unknown discriminator, a discriminator inconsistent with that realization, a
missing/empty `phi0_a` in the required branch, or any present `phi0_a` in the
not-required branch.

## 3. Static-field provenance and comparison

Every stored static field carries:

```text
field role and SI unit
content sha256
producer run and implementation identity
mesh/material/physics/boundary/static-demag signatures
resolved demag realization and BC/gauge tuple where applicable
```

If the builder recomputes `h_eff0`, `h_demag0`, or conditionally required
`phi0`, the recomputation must use the same five signatures as the accepted
artifact. It records the recomputed content hash, implementation identity,
comparison norm, comparison tolerance, and pass/fail result against the stored
field. A passing recomputed field may be selected only with explicit
`field_source=recomputed_verified` provenance. It cannot silently replace the
stored field. A signature mismatch, missing comparison, or failed comparison
invalidates the handoff.

Static and dynamic demag remain separate:

```text
static:  m0 -> h_demag0, phi0 -> component of h_eff0
dynamic: delta_m -> delta_h_demag[delta_m], delta_phi -> operator block
```

The static term enters the dictionary contribution
`-gamma0 * (delta_m x h_eff0)`. Dynamic demag is assembled or applied by the
linearized operator and is never recovered from static-field provenance.

## 4. LinearizationState.v6

The builder emits an immutable state only after all acceptance and identity
checks pass:

```json
{
  "schema_version": "LinearizationState.v6",
  "source_equilibrium_artifact": "sha256:...",
  "operator_dictionary": "FrequencyOperatorDictionary.v1",
  "accepted_for_frequency_operator": true,
  "m0": "fields/m0_unit.zarr",
  "h_eff0_a_per_m": "fields/h_eff0_a_per_m.zarr",
  "h_demag0_a_per_m": "fields/h_demag0_a_per_m.zarr",
  "phi0_requirement": "required_for_restart_or_provenance",
  "phi0_a": "fields/phi_demag0_a.zarr",
  "mesh_signature": "sha256:...",
  "material_signature": "sha256:...",
  "physics_signature": "sha256:...",
  "boundary_signature": "sha256:...",
  "static_demag_signature": "sha256:...",
  "static_field_provenance": "sha256:...",
  "tangent_frame_policy": "sha256:...",
  "periodic_mesh_certificate": "sha256:..."
}
```

`LinearizationState.v6` copies `phi0_requirement` from the accepted artifact and
validates it again against the selected resolved static-demag realization. In
the required branch, `phi0_a` is a required nonempty reference to the verified
potential payload. In the not-required branch, `phi0_a` must be absent. JSON
`null` is invalid, and the builder must not change branches or synthesize a
not-required reason. The periodic certificate is required only for a
periodic/Floquet request; otherwise its explicit value is `not_applicable`. The
builder records frame orthogonality, handedness, and equilibrium residual
diagnostics in the state provenance.

Required checks are:

```text
accepted_for_linearization is true and stop_reason is acceptable
all required field payloads exist and their content hashes verify
mesh/material/physics/boundary/static-demag signatures match the request
m0 ordering matches the magnetic FE space and max_m0_norm_error passes
max_m0_cross_h_eff0_relative passes the declared acceptance tolerance
stored or recomputed static fields satisfy the provenance comparison policy
periodic_mesh_certificate.v6 is accepted when periodic/Floquet is requested
```

## 5. Invalidation and reject reasons

The state key covers the source artifact digest, all five signatures, required
field content hashes, static-field provenance, tangent-frame policy, and the
periodic certificate identity. Any covered input change creates a new state;
cache reuse under an old state ID is forbidden.

| Change | Required result |
|---|---|
| magnetic or airbox mesh/topology/FE ordering | invalidate fields, frames, periodic certificate, and state |
| material coefficients or region assignment | invalidate static fields and state |
| enabled physics, parameters, or static external field | invalidate static fields and state |
| static boundary or periodic policy | invalidate static fields, certificate, and state |
| static demag realization, assembly, BC/gauge, or solver-defining policy | invalidate static-demag fields and state |
| `m0` or required static-field content | invalidate state and rebuild from a newly accepted artifact |
| drive, output selection, or frequency window only | retain state if no covered signature changes |

Machine-readable rejection uses exact reasons:

```text
equilibrium_artifact_missing
equilibrium_artifact_not_accepted_for_linearization
equilibrium_stop_reason_not_accepted
equilibrium_mesh_hash_mismatch
equilibrium_material_hash_mismatch
equilibrium_physics_hash_mismatch
equilibrium_boundary_hash_mismatch
equilibrium_static_demag_hash_mismatch
equilibrium_required_field_missing
equilibrium_field_content_hash_mismatch
equilibrium_static_field_comparison_missing
equilibrium_static_field_comparison_failed
equilibrium_phi0_requirement_mismatch
equilibrium_phi0_required_missing
equilibrium_phi0_forbidden_present
equilibrium_m0_norm_error_too_large
equilibrium_torque_residual_too_large
equilibrium_periodic_certificate_missing_or_stale
```

## 6. Current-v5 to target-v6 migration

| Current v5 | Target v6 | Migration rule |
|---|---|---|
| `frequency_domain_equilibrium.v5` | `EquilibriumArtifact.v6` | create a new artifact; do not change the version token in place |
| `accepted_for_linearization` | same field plus `stop_reason` | recover an accepted producer reason or reject migration |
| nested `fields.m0_unit` | top-level `m0` | copy path and verify content hash |
| nested `fields.h_eff0_a_per_m` | top-level `h_eff0_a_per_m` | copy path, unit, signatures, and field provenance |
| nested `fields.h_demag0_a_per_m` | top-level `h_demag0_a_per_m` | copy path and bind `static_demag_signature` |
| implicit scalar-potential requirement | required `phi0_requirement` discriminator | derive from the resolved static-demag realization or reject migration |
| nested `fields.phi_demag0` | conditional top-level `phi0_a` | required branch: copy with unit `A`; not-required branch: omit the field; never emit `null` |
| snapshot and mesh IDs | five canonical signatures | recompute canonical sha256 signatures; IDs alone are insufficient |
| `max_relative_torque_residual` | `max_m0_cross_h_eff0_relative` | recompute under the v6 normalization; do not rename blindly |
| implicit static-field reuse | explicit stored/recomputed comparison provenance | compare or reject migration |
| v5 builder output | `LinearizationState.v6` | rebuild after all v6 checks; no wrapper-only conversion |

## 7. Production boundary

This file closes the target documentation contract only. Current v5 planner and
builder checks are not evidence of target-v6 artifact materialization,
migration, ingestion, or runtime consumption. Production status may advance
only after the v6 schemas, all producers and consumers, rejection paths, and
managed validation evidence exist.
