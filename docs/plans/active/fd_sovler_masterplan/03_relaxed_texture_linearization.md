---
title: Frequency-driven solver - relaxed texture linearization
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# Relaxed texture handoff and LinearizationState

## 1. Decision

Frequency-domain analysis around a nonlinear magnetic state must consume an accepted equilibrium artifact. It must not build hidden equilibrium state inside the driven or modal solver.

```text
relaxation/static demag
  -> accepted EquilibriumArtifact
  -> LinearizationState builder
  -> tangent frames and mesh certificates
  -> planner
  -> backend
```

## 2. Required EquilibriumArtifact

```json
{
  "schema_version": "frequency_domain_equilibrium.v5",
  "accepted_for_linearization": true,
  "equilibrium_id": "sha256:...",
  "mesh_snapshot_id": "sha256:...",
  "magnetic_mesh_id": "sha256:...",
  "airbox_mesh_id": "sha256:...",
  "material_snapshot_id": "sha256:...",
  "physics_snapshot_id": "sha256:...",
  "boundary_snapshot_id": "sha256:...",
  "demag_model": "periodic_airbox_k0",
  "fields": {
    "m0_unit": "fields/m0_unit.zarr",
    "h_eff0_a_per_m": "fields/h_eff0.zarr",
    "h_demag0_a_per_m": "fields/h_demag0.zarr",
    "phi_demag0": "fields/phi_demag0.zarr"
  },
  "diagnostics": {
    "max_m0_norm_error": 0.0,
    "max_relative_torque_residual": 0.0,
    "max_magnetic_seam_mismatch": 0.0,
    "max_static_demag_seam_mismatch": 0.0
  }
}
```

## 3. Required builder checks

```text
artifact.accepted_for_linearization == true
mesh/material/physics/boundary signatures match requested frequency problem
m0 exists and has the same node ordering as the magnetic mesh
h_eff0 exists or is recomputed and compared
h_demag0 exists if demag/airbox is enabled
phi0 exists if the airbox scalar-potential path requires it
periodic pair maps exist when periodic/Floquet is requested
```

Reject reasons must be exact:

```text
equilibrium_artifact_missing
equilibrium_artifact_not_accepted_for_linearization
equilibrium_mesh_hash_mismatch
equilibrium_material_hash_mismatch
equilibrium_physics_hash_mismatch
equilibrium_static_demag_required_but_missing
equilibrium_torque_residual_too_large
```

## 4. Tangent frames for skyrmions and other textures

For every node:

```text
m0_i normalized
T_i = [e1_i, e2_i]
e1_i · m0_i = 0
e2_i = m0_i x e1_i
delta_m_i = T_i q_i
```

The builder records:

```text
tangent_frame_gauge_policy
tangent_frame_smoothing_policy
max_frame_orthogonality_error
max_frame_handedness_error
tangent_frame_policy_hash
```

## 5. Static vs dynamic demag

Static demag:

```text
source: m0
output: h_demag0, phi0
role: component of h_eff0
appears in -gamma delta_m x h_eff0
```

Dynamic demag:

```text
source: delta_m
output: delta_h_demag[delta_m], delta_phi
role: linear operator or coupled block
```

These two must never be conflated.

## 6. Current status after full read

The old docs clearly define this as P0. Native contracts now include a planner-level gate: when relaxed texture linearization is required and no accepted `LinearizationState` is available, the planner rejects fast/backend lane selection with `equilibrium_artifact_missing`. This is verified by `just verify-fem-frequency-domain-native-contract` on 2026-07-07.

The `LinearizationState` builder now also reports v5 machine-readable reject reasons for unaccepted equilibrium artifacts, missing required static demag, excessive static torque residual, and mesh/material/physics signature mismatches against the requested frequency-domain problem. This builder-level contract is verified by the same native gate on 2026-07-07.

This does not yet prove complete accepted equilibrium artifact ingestion or end-to-end runtime handoff. Treat artifact materialization from relaxation outputs and frequency-domain runtime consumption as the remaining P0 implementation gap.
