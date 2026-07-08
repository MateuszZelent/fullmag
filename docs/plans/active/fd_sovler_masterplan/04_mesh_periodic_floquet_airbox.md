---
title: Frequency-driven solver - mesh symmetry, periodic, Floquet and airbox
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# Mesh symmetry, periodic/Floquet and airbox contract

## 1. Strict v1 policy

Production FEM periodic/Floquet frequency-domain requires a matched symmetric mesh. Nonmatching periodic faces require a future mortar/interpolation backend and are not accepted in v1.

## 2. Certificate

```json
{
  "schema_version": "periodic_mesh_certificate.v5",
  "certificate_status": "accepted",
  "magnetic_pair_map_fingerprint": "fnv1a64:...",
  "airbox_pair_map_fingerprint": "fnv1a64:...",
  "magnetic_pair_map_sha256": "sha256:...",
  "airbox_pair_map_sha256": "sha256:...",
  "pair_count": 0,
  "translation_residual_max_m": 0.0,
  "normal_mismatch_max": 0.0,
  "boundary_topology_match": true,
  "fe_order_match": true,
  "material_region_match": true,
  "m0_seam_mismatch_max": 0.0,
  "h_demag0_seam_mismatch_max": 0.0,
  "tangent_frame_transfer_available": true,
  "tangent_frame_transfer_blocks_row_major_2x2": [
    [1.0, 0.0, 0.0, 1.0]
  ]
}
```

## 3. Cartesian physical boundary condition

```text
periodic: delta_m_dst = R delta_m_src
Floquet:  delta_m_dst = exp(-i kF · delta_r) R delta_m_src
```

`R = I` for pure translational periodicity.

## 4. Tangent-coordinate transfer

Because:

```text
delta_m_src = T_src q_src
delta_m_dst = T_dst q_dst
```

then:

```text
q_dst = T_dst^T R T_src q_src
```

For Floquet:

```text
q_dst = exp(-i kF · delta_r) T_dst^T R T_src q_src
```

Define:

```text
G_pair = T_dst^T R T_src
q_dst = phase * G_pair q_src
```

Do not use scalar periodicity in tangent coordinates unless `G_pair ≈ I`.

## 5. Airbox requirements

```text
magnetic pair map and airbox scalar-potential pair map exist
same periodic/Floquet/gauge policy in static and dynamic demag
static demag seam passes
Poisson nullspace/gauge policy is explicit
```

## 6. Current status after full read

The documentation specifies the certificate and tangent-frame transfer requirement. Native contract coverage now includes a certificate-level implementation slice: matched magnetic/airbox pair maps are accepted, duplicate periodic node pairs are rejected, certificate schema is recorded as `periodic_mesh_certificate.v5`, stable order-independent magnetic/airbox pair-map fingerprints are recorded as `fnv1a64:...`, canonical pair-map hashes are recorded as `sha256:...`, nonidentity tangent-frame transfers are stored explicitly as row-major `G_pair = T_dst^T R T_src` 2x2 blocks, inconsistent paired equilibrium directions are rejected with `periodic_m0_seam_mismatch`, optional same-step `H_demag0` seam mismatches are rejected with `periodic_static_demag_seam_mismatch`, and required-but-unspecified Poisson gauge policy is rejected with `periodic_poisson_gauge_policy_missing`. The certificate-level pair-map, `G_pair`, seam/gauge, fingerprint, and `sha256:` hash slice was verified by `just verify-fem-frequency-domain-native-contract` after a managed runtime rebuild on 2026-07-07.

Runtime integration has started: the FEM frequency-response input preflight
artifact now serializes a `periodic_mesh_certificate.v5` candidate section with
canonical `sha256:` magnetic and airbox pair-map hashes derived from the actual
solver-lane input pairs. This gives periodic-airbox runs artifact-level pair-map
identity before the native solver starts.

This is not yet complete periodic/Floquet runtime support. The remaining P0/P1
gaps before large periodic-airbox production runs are native runtime consumption
of `G_pair`, propagation of accepted certificate identity beyond the preflight
candidate into every relevant serialized solver-lane artifact, and end-to-end
validation that full-coupled/Schur/modal/GPU lanes consume the certificate
consistently.
