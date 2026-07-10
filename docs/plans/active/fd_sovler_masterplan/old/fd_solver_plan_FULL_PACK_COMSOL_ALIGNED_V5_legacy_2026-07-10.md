> Historical snapshot captured on 2026-07-10. This file is excluded from the
> canonical read order and must not define current physics, algorithms or
> implementation status.

---
title: Frequency-driven solver - COMSOL-aligned V5 full pack
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: generated
---

# Frequency-driven solver - COMSOL-aligned V5 full pack

Generated from the individual v5 files after full read of the uploaded documentation package.


---

<!-- FILE: 00_README_CANONICAL_FULL_READ.md -->

---
title: Frequency-driven solver - canonical README after full read
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# Frequency-driven solver - canonical README after full read

This directory is the single canonical documentation package for the frequency-driven solver.
It was regenerated after a full beginning-to-end read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF.

## What this package fixes

The previous folder mixed several generations:

- the individual v2/v3 files,
- the older full pack,
- the v3 full pack whose internal first heading still said `masterplan v2`,
- a separate relaxed-texture addendum,
- a separate ADR addendum,
- a patch queue with newer implementation evidence that was not cleanly reflected in the main plan.

This v5 package merges those into one stable structure and makes the patch status explicit.

## Read order for Codex

1. `00_README_CANONICAL_FULL_READ.md`
2. `01_full_read_inventory_and_resolution.md`
3. `02_physics_contract.md`
4. `03_relaxed_texture_linearization.md`
5. `04_mesh_periodic_floquet_airbox.md`
6. `05_algebra_and_operator_representations.md`
7. `06_solver_tree_planner_and_lanes.md`
8. `07_api_abi_artifacts.md`
9. `08_backend_algorithms_and_status.md`
10. `09_validation_certification_benchmarks.md`
11. `10_patch_queue_current_status.md`
12. `11_runtime_telemetry_performance.md`
13. `12_adr_decisions.md`
14. `13_repo_migration_cleanup.md`
15. `14_sources_traceability.md`
16. `fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V5.md`

## Core decision

The final solver is not one monolithic GPU GMRES.
It is a COMSOL-aligned solver tree:

```text
FrequencyDomainSolver
├── FrequencySolvePlanner
├── DenseCartesianReferenceBackend
├── DenseTangentReferenceBackend
├── CpuSparseDirectBackend
├── FullCoupledFieldSplitBackend
├── SchurReducedBackend
├── ModalReducedBackend
└── GpuDeviceKrylovBackend
```

The public physics contract is:

```text
m(r,t) = m0(r) + Re(delta_m(r) exp(+i omega t))
delta_m(r) in C^3
m0(r) · delta_m(r) = 0
```

The optimized internal representation may be:

```text
delta_m_i = T_i q_i
q_i in C^2
```

## Implementation-state correction after full read

The patch queue is newer than parts of the old full pack. According to the patch queue, several items are no longer purely planned:

```text
Patch B: lane diagnostics/progress throttling - implemented at contract level.
Patch C: planner descriptors - implemented as conservative descriptors.
Patch D: COMSOL physics gates - implemented for drive_kind, zero-drive, drive projection, Cartesian/tangent adapters and local T^T A T projection.
Patch E: dense full-coupled oracle - implemented at tiny/oracle level.
Patch F: CPU sparse/direct baseline - implemented as PETSc KSPPREONLY/PCLU path where PETSc is available, with explicit unavailable fallback otherwise.
Patch G: full-coupled field-split prototype - implemented as dense/oracle-scale prototype.
Patch H: Schur certification gate - implemented at planner/certificate-signature level.
Patch I: modal response helper - implemented for validation/helper slices with modal basis policy and sparse/direct sample validation.
Patch J: GPU device Krylov - only API, residency diagnostics, prerequisites and callback probe exist; runtime FGMRES loop is not implemented.
```

## Non-negotiable ordering

```text
1. Accepted equilibrium artifact and LinearizationState.
2. Symmetric mesh / periodic / Floquet / airbox certificate.
3. COMSOL phase, drive and Cartesian/tangent gates.
4. Dense and sparse/direct reference backends.
5. Full-coupled dynamic demag field-split.
6. Certified Schur fast path.
7. Modal sweep acceleration.
8. True GPU device FGMRES after contraction and residency gates.
```

Do not treat `production_gpu` as true device Krylov. Until runtime Krylov vectors and operations are device-resident, call it `gpu_operator_host_krylov`.


---

<!-- FILE: 01_full_read_inventory_and_resolution.md -->

---
title: Frequency-driven solver - full read inventory and resolution
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# Full read inventory and resolution

The following uploaded files were read from start to end. This inventory records line counts and hashes so Codex can see which sources this v5 package consolidates.

## Source inventory

```json
[
  {
    "file": "fd_solver_plan_00_index(2).md",
    "lines": 213,
    "chars": 7065,
    "sha256": "548506fb4218ec53751198ef2205a17c0d215bb53833fe25923994c6637d2e32",
    "heading_count": 14
  },
  {
    "file": "fd_solver_plan_01_comsol_physics_contract(2).md",
    "lines": 421,
    "chars": 9205,
    "sha256": "72cfaf53b12d1f643dd9a5f60bab0f073ad409695fea51273dd4b18c0b7b4cdb",
    "heading_count": 24
  },
  {
    "file": "fd_solver_plan_02_algebra_representations(1).md",
    "lines": 300,
    "chars": 5686,
    "sha256": "86f0a2c09b0f06f414b787e1a1d2b0e8568a256f79c87b629549e3b39eb68915",
    "heading_count": 17
  },
  {
    "file": "fd_solver_plan_03_solver_tree_architecture(2).md",
    "lines": 253,
    "chars": 6739,
    "sha256": "88564843306337049828d791437b5147f45ea96a04503409b5114a27ceaa8787",
    "heading_count": 10
  },
  {
    "file": "fd_solver_plan_04_implementation_roadmap(1).md",
    "lines": 357,
    "chars": 7556,
    "sha256": "e980fc077831d917b9147f4bced4333b0b32db60fb38dc9bb2a644d3a7d06afc",
    "heading_count": 12
  },
  {
    "file": "fd_solver_plan_05_api_code_skeletons(2).md",
    "lines": 444,
    "chars": 11456,
    "sha256": "d3104a68d5bda059d0b7e9bbc163e6d04268201a87cb129ce6b36359b572429f",
    "heading_count": 13
  },
  {
    "file": "fd_solver_plan_06_backend_algorithms(1).md",
    "lines": 398,
    "chars": 6170,
    "sha256": "18d5387a5e03860e292fa6503a897d6dfafd7ffb3f2f6d33dfd9ee8ff08ec840",
    "heading_count": 47
  },
  {
    "file": "fd_solver_plan_07_validation_benchmarks(2).md",
    "lines": 349,
    "chars": 6820,
    "sha256": "68571b97eefa24e580f5894fa3e92e34c88515169c323a4ca175f44d0771c8df",
    "heading_count": 32
  },
  {
    "file": "fd_solver_plan_08_patch_queue(1).md",
    "lines": 609,
    "chars": 24563,
    "sha256": "715bde20f99bb553539ceaca3880c67c71980efc97fafe6983b2a0b569a1979b",
    "heading_count": 13
  },
  {
    "file": "fd_solver_plan_09_sources_and_traceability(1).md",
    "lines": 238,
    "chars": 5652,
    "sha256": "cb1235ab15b0f9d2bca44e41f239b585801c1ec710d7bfc39d896e8f3996ef2c",
    "heading_count": 17
  },
  {
    "file": "fd_solver_plan_10_relaxed_texture_handoff(1).md",
    "lines": 738,
    "chars": 21540,
    "sha256": "ba9470680758fbc50238c28fb6ad5313a1deab962b011f041c467091a71d62df",
    "heading_count": 46
  },
  {
    "file": "fd_solver_plan_11_decision_closures_adr(1).md",
    "lines": 336,
    "chars": 7586,
    "sha256": "109e4913a570c2dcfac9b9303679bfd259b27116462cd9e509ad948cbdf55741",
    "heading_count": 14
  },
  {
    "file": "fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md",
    "lines": 3207,
    "chars": 67762,
    "sha256": "730569745a9b11d0730543a6857a23f5953e61efc10b02922c4dbce39767783c",
    "heading_count": 196
  },
  {
    "file": "fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3(2).md",
    "lines": 4321,
    "chars": 96910,
    "sha256": "ac1446f3bae78bb4f7646d68b777ec40a5e0215c2feaa61444b02afd5841f25f",
    "heading_count": 260
  },
  {
    "file": "MicromagneticsModuleUsersGuideV2.13(1).pdf",
    "pages": 71,
    "bytes": 14582495,
    "sha256": "6c212ed2ee9580f2917118c58ed1caafec18488076a3e7bcb3eb15a64b5e49e1",
    "extracted_text_lines": 1944,
    "extracted_text_chars": 97886
  }
]
```

## Resolution of conflicting generations

| Conflict | Resolution in v5 |
|---|---|
| `fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md` says v3 but contains a `masterplan v2` heading | v5 uses one title and one version only. |
| relaxed texture handoff was separate v3 addendum | v5 promotes it to core P0 document: `03_relaxed_texture_linearization.md`. |
| ADR decisions were separate addendum | v5 promotes them to canonical `12_adr_decisions.md`. |
| patch queue contains newer implementation evidence than old main plan | v5 separates design goal from implementation status in `10_patch_queue_current_status.md`. |
| old documents call sparse/direct and field-split future work | v5 records that MVP/prototype slices are reported as implemented in the patch queue, but not final production backends. |
| old docs emit `micromagnetics_frequency_domain_v2` in JSON examples | v5 emits `micromagnetics_frequency_domain_v5`. |
| old docs have ambiguous drive sign text | v5 uses `b = -gamma T^T(m0 x delta_h)` with mandatory sign gate. |
| old docs alternate `exp_i_omega_t` and `exp_plus_i_omega_t` | v5 canonical emission token is `exp_plus_i_omega_t`; aliases may be accepted on input. |

## What is design and what is implementation

v5 distinguishes:

```text
contract/design: what final solver must support
current implemented gate: what patch queue says is already tested
runtime production backend: what can be selected safely by planner today
```

In particular:

```text
GpuDeviceKrylovBackend: design exists; API/probe exists; production runtime loop does not.
FullCoupledFieldSplitBackend: prototype exists; production large FEM field-split still needs integration.
CpuSparseDirectBackend: MVP exists; production scaling and reuse policies still need work.
ModalReducedBackend: helper/gates exist; full production sweep engine still needs integration.
SchurReducedBackend: certificate gates exist; production fast path still requires actual certificate and quality data per problem.
```


---

<!-- FILE: 02_physics_contract.md -->

---
title: Frequency-driven solver - COMSOL-aligned physics contract
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# COMSOL-aligned physics contract

Every backend must solve the same physics.

## 1. Canonical ansatz and equation

```text
m(r,t) = m0(r) + delta_m(r) exp(+i omega t)
delta_m << m0
m0 · delta_m = 0
H_eff(r,t) = h_eff0(r) + delta_h_eff(r) exp(+i omega t)
```

Linearized LLG:

```text
i omega delta_m
  = - gamma m0 x delta_h_eff
    - gamma delta_m x h_eff0
    + i omega alpha m0 x delta_m
    + linearized torque terms
```

The canonical phase convention is:

```text
exp_plus_i_omega_t
```

## 2. Public and internal unknowns

Public physical unknown:

```text
delta_m_i = (dmX_i, dmY_i, dmZ_i) in C^3
m0_i · delta_m_i = 0
```

Internal tangent unknown:

```text
T_i = [e1_i, e2_i]
q_i = (u_i, v_i) in C^2
delta_m_i = T_i q_i
```

Public artifacts must expose Cartesian fields. Tangent `u/v` is provenance or internal debug data.

## 3. Dynamic drive

Default user drive is a dynamic external field phasor:

```text
delta_h in C^3, unit A/m
```

No user-supplied sinusoid belongs in the value. The solver attaches `exp(+i omega t)`.

Canonical projection into RHS:

```text
b_cart = - gamma m0 x delta_h
b_tangent = T^T b_cart
```

This sign follows from moving the external-drive term to the RHS of the canonical equation. It must be locked by macrospin and dense Cartesian sign tests.

## 4. DriveKind

```cpp
enum class FrequencyDriveKind : std::uint32_t {
    dynamic_field_phasor_a_per_m = 1,
    tangent_rhs = 2,
    cartesian_torque_phasor = 3,
    stt_current_phasor = 4,
    coupled_external_provider = 5,
};
```

Rules:

```text
dynamic_field_phasor_a_per_m: public COMSOL-style drive.
tangent_rhs: low-level solver/benchmark/debug input.
cartesian_torque_phasor: physical torque-source input.
stt_current_phasor: current/STT source.
coupled_external_provider: source from another physics subsystem.
```

## 5. Zero-drive policy

```text
FrequencyResponse + physical drive_kind + zero drive:
    valid zero response + warning.

SolverBenchmark + tangent_rhs + require_nonzero_rhs=true:
    validation_error.

Eigenfrequency/modal:
    no drive required.
```

## 6. Static linearization state

Frequency-domain solve must use a consistent static state:

```text
|m0| = 1
m0 x h_eff0 approximately 0
```

The equilibrium may be nonuniform and metastable. It still must carry diagnostics:

```text
max_m0_norm_error
max_relative_torque_residual
max_m0_cross_heff0_relative
energy trend acceptance
```

## 7. Effective fields

Static:

```text
h_eff0 = h_exchange0
       + h_anisotropy0
       + h_external0
       + h_DMI0
       + h_demag0
       + h_custom0
```

Dynamic:

```text
delta_h_eff = delta_h_exchange[delta_m]
            + delta_h_anisotropy[delta_m]
            + delta_h_drive
            + delta_h_DMI[delta_m]
            + delta_h_demag[delta_m]
            + delta_h_STT_equivalent[delta_m]
            + delta_h_custom[delta_m]
```

Fields are in `A/m` unless a source explicitly declares otherwise with conversion provenance.

## 8. Internal real split

Allowed internal form:

```text
A(omega) = K - i omega M
```

Real split:

```text
[ K       +omega M ] [q_R] = [b_R]
[ -omega M  K     ] [q_I]   [b_I]
```

This is not the physics definition. It is an implementation form that must pass phase, drive, damping and macrospin sign gates.

## 9. DMI status

```text
DMI volume operator: production only after Cartesian/tangent tests.
DMI frequency-domain boundary terms: experimental/unsupported unless separately certified.
Only one DMI kind may be active at once.
```

## 10. Minimal result JSON

```json
{
  "physics_contract": "micromagnetics_frequency_domain_v5",
  "phasor_convention": "exp_plus_i_omega_t",
  "unknown_physics_representation": "cartesian3_complex_constrained",
  "unknown_internal_representation": "tangent2_complex",
  "constraint": "m0_dot_delta_m_zero",
  "drive_kind": "dynamic_field_phasor_a_per_m",
  "effective_field_units": "A_per_m",
  "time_reconstruction": "m(t)=m0+Re(delta_m*exp(+i*omega*t))"
}
```


---

<!-- FILE: 03_relaxed_texture_linearization.md -->

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


---

<!-- FILE: 04_mesh_periodic_floquet_airbox.md -->

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

The documentation specifies the certificate and tangent-frame transfer requirement. Native contract coverage now includes a certificate-level implementation slice: matched magnetic/airbox pair maps are accepted, duplicate periodic node pairs are rejected, certificate schema is recorded as `periodic_mesh_certificate.v5`, stable order-independent magnetic/airbox pair-map fingerprints are recorded as `fnv1a64:...`, nonidentity tangent-frame transfers are stored explicitly as row-major `G_pair = T_dst^T R T_src` 2x2 blocks, inconsistent paired equilibrium directions are rejected with `periodic_m0_seam_mismatch`, optional same-step `H_demag0` seam mismatches are rejected with `periodic_static_demag_seam_mismatch`, and required-but-unspecified Poisson gauge policy is rejected with `periodic_poisson_gauge_policy_missing`. The certificate-level pair-map, `G_pair`, seam/gauge, and fingerprint slice was verified by `just verify-fem-frequency-domain-native-contract` after a managed runtime rebuild on 2026-07-07.

This is not yet complete periodic/Floquet runtime support. The remaining P0/P1 gaps before large periodic-airbox production runs are runtime consumption of `G_pair`, serialized artifact-level canonical `sha256:` pair-map hashes, and end-to-end validation that full-coupled/Schur/modal/GPU lanes consume the certificate consistently.


---

<!-- FILE: 05_algebra_and_operator_representations.md -->

---
title: Frequency-driven solver - algebra and operator representations
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# Algebra and operator representations

## 1. Layer separation

```text
Physics:       Cartesian delta_m, constraint m0·delta_m=0
Adapter:       delta_m = T q
Algebra:       A(omega)x=b
Representation: dense/sparse/full-coupled/Schur/modal/GPU
Engine:        backend-specific solve
```

Callbacks must not secretly mix those layers without diagnostics.

## 2. Cartesian constrained oracle

Tiny physical oracle:

```text
[ A_cart  C^T ] [delta_m] = [b]
[ C       0   ] [lambda ]   [0]
```

or tangent elimination:

```text
A_t = T^T A_cart T
b_t = T^T b_cart
```

## 3. Tangent 2-DOF operator

```text
q in C^(2N)
delta_m = T q
```

Internal real-split convention:

```text
A_real(omega) = [K, +omega M; -omega M, K]
```

must be linked to the COMSOL phase contract by tests.

## 4. Full-coupled demag/airbox

Reference production form:

```text
[ A_qq(omega)  A_qphi   ] [q]   = [b_q]
[ A_phiq       A_phiphi ] [phi] = [b_phi]
```

Full-coupled is needed for:

```text
true residual
Poisson/gauge/nullspace diagnostics
field-split preconditioner
Schur certification
```

## 5. Schur reduced

```text
S(omega) = A_qq(omega) - A_qphi A_phiphi^-1 A_phiq
b_S      = b_q - A_qphi A_phiphi^-1 b_phi
```

Schur is only a certified fast path.

## 6. Sparse/direct

```text
assemble CSR/BSR real split
solve with direct sparse solver
compute true residual
```

In v5 status, the patch queue reports a PETSc `KSPPREONLY + PCLU` MVP for CPU sparse/direct baseline. This is a diagnostic production slice, not the final scalable sparse architecture.

## 7. Modal/eigen

Frequency sweeps should use modal or reduced-basis response when certified:

```text
x(omega) ≈ V c(omega)
```

Basis provenance must include:

```text
operator hash
equilibrium hash
material hash
boundary hash
demag hash
phase convention
frequency window
completeness certificate
```

## 8. GPU device representation

`gpu_device_krylov` requires device residency for:

```text
x, b, r, w, V, Z
operator buffers
preconditioner buffers
orthogonalization
residual estimate
```

Current host GMRES with GPU-backed operators remains `gpu_operator_host_krylov`.


---

<!-- FILE: 06_solver_tree_planner_and_lanes.md -->

---
title: Frequency-driven solver - solver tree, planner and lanes
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# Solver tree, planner and lanes

## 1. Execution lanes

```cpp
enum class FrequencyExecutionLane : std::uint32_t {
    dense_cartesian_reference = 1,
    dense_tangent_reference = 2,
    cpu_sparse_direct = 3,
    cpu_host_krylov = 4,
    gpu_operator_host_krylov = 5,
    full_coupled_field_split = 6,
    schur_reduced = 7,
    modal_reduced = 8,
    gpu_device_krylov = 9,
};
```

Legacy:

```text
PRODUCTION_GPU -> gpu_operator_host_krylov unless true device residency is proven.
```

## 2. FrequencySolvePlan

```cpp
struct FrequencySolvePlan {
    FrequencyExecutionLane lane;
    OperatorRepresentation representation;
    LinearSolverFamily linear_solver;
    PreconditionerFamily preconditioner;

    bool use_full_coupled_system;
    bool use_schur_reduction;
    bool use_modal_reduction;
    bool use_device_resident_krylov;

    bool require_phase_convention_gate;
    bool require_cartesian_tangent_gate;
    bool require_relaxed_texture_gate;
    bool require_symmetric_mesh_certificate;
    bool require_true_residual_verification;
    bool require_schur_certification;
    bool require_preconditioner_contraction_certificate;

    const char* selection_reason;
    const char* fallback_reason;
};
```

## 3. Decision tree

```text
if validation/tiny:
    dense_cartesian_reference

else if missing phase/cartesian/tangent gates:
    reject or validation backend

else if relaxed texture required but no accepted artifact:
    reject

else if periodic/Floquet but no symmetric mesh certificate:
    reject

else if dynamic demag/airbox:
    if full_coupled_available:
        full_coupled_field_split
    else if schur_certified and schur_quality_good:
        schur_reduced
    else if sparse_direct_available:
        cpu_sparse_direct
    else:
        reject certification_required

else if many frequencies and modal basis certified:
    modal_reduced

else if sparse direct available and memory ok:
    cpu_sparse_direct

else if gpu_device_krylov available and preconditioner contraction certified:
    gpu_device_krylov

else:
    cpu_host_krylov or gpu_operator_host_krylov with explicit warning
```

## 4. Current status after full read

Patch queue says native planner descriptors and conservative defaults already exist. The planner now also carries the relaxed-texture gate: `require_relaxed_texture_gate`, `accepted_linearization_state_available`, and the rejection reason `equilibrium_artifact_missing` are covered by the native contract gate. This was verified by `just verify-fem-frequency-domain-native-contract` on 2026-07-07.

However, the planner is not yet the single authoritative production runtime route for all frequency response paths. End-to-end artifact ingestion and backend dispatch integration remain implementation tasks.


---

<!-- FILE: 07_api_abi_artifacts.md -->

---
title: Frequency-driven solver - API, ABI and artifact schema
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# API, ABI and artifact schema

## 1. ABI rules

```text
every public struct has abi_version and struct_size
layout changes bump ABI
stable ABI enums use explicit uint32 values
bool should be avoided or normalized at FFI boundary
owned char* must have release function
```

## 2. Core enums

```cpp
enum class FrequencyPhaseConvention : std::uint32_t {
    exp_plus_i_omega_t = 1,
    exp_minus_i_omega_t = 2,
};

enum class FrequencyDriveKind : std::uint32_t {
    dynamic_field_phasor_a_per_m = 1,
    tangent_rhs = 2,
    cartesian_torque_phasor = 3,
    stt_current_phasor = 4,
    coupled_external_provider = 5,
};

enum class FrequencyUnknownRepresentation : std::uint32_t {
    cartesian3_complex_constrained = 1,
    tangent2_complex = 2,
    full_coupled_cartesian3_phi = 3,
    full_coupled_tangent2_phi = 4,
};
```

## 3. Dynamic-field phasor view

```cpp
struct DynamicFieldPhasorView {
    const double* hx_re;
    const double* hy_re;
    const double* hz_re;
    const double* hx_im; // nullable: zero imaginary
    const double* hy_im; // nullable: zero imaginary
    const double* hz_im; // nullable: zero imaginary
    std::uint64_t node_count;
};
```

Projection:

```cpp
FrequencyDomainStatus project_dynamic_field_drive_to_tangent_rhs(
    const TangentFrameNode* frames,
    std::uint64_t node_count,
    double gamma0,
    FrequencyPhaseConvention convention,
    const DynamicFieldPhasorView& drive,
    TangentComplexVectorView out_rhs,
    TangentExcitationDiagnostics* diagnostics) noexcept;
```

## 4. Output artifact

```json
{
  "schema_version": "frequency_response_result.v5",
  "physics_contract": "micromagnetics_frequency_domain_v5",
  "phasor_convention": "exp_plus_i_omega_t",
  "drive_kind": "dynamic_field_phasor_a_per_m",
  "unknown_physics_representation": "cartesian3_complex_constrained",
  "unknown_internal_representation": "tangent2_complex",
  "requested_execution_lane": "production_gpu",
  "resolved_execution_lane": "gpu_operator_host_krylov",
  "gpu_device_resident_krylov": false,
  "fields": {
    "dmX_real": "...",
    "dmX_imag": "...",
    "dmY_real": "...",
    "dmY_imag": "...",
    "dmZ_real": "...",
    "dmZ_imag": "..."
  },
  "constraint_diagnostics": {
    "max_abs_m0_dot_delta_m_real": 0.0,
    "max_abs_m0_dot_delta_m_imag": 0.0
  }
}
```

## 5. Current status after full read

Patch queue reports that `FrequencyDriveKind`, `require_nonzero_rhs`, dynamic-field projection, null imaginary buffer policy, zero-drive warnings, Cartesian/tangent complex adapters, and local `T^T A T` projection tests have been added and verified by the native contract gate. Confirm exact ABI availability from the current branch before changing managed API.


---

<!-- FILE: 08_backend_algorithms_and_status.md -->

---
title: Frequency-driven solver - backend algorithms and status
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# Backend algorithms and status

## 1. Dense Cartesian reference

Purpose:

```text
highest-confidence tiny oracle for phase, drive, constraints.
```

Status:

```text
design required; implementation status should be verified per branch.
```

## 2. Dense tangent reference

Purpose:

```text
existing tiny validation path for [K,+omegaM;-omegaM,K].
```

Status:

```text
existing dense driven-response validation path is present.
```

## 3. CPU sparse/direct baseline

Algorithm:

```text
assemble real-split CSR
PETSc Mat AIJ
KSPPREONLY + PCLU
true residual
```

Status after full read:

```text
Patch F reports an MVP module under engines/sparse_direct with PETSc KSPPREONLY/PCLU and explicit unavailable fallback for non-PETSc builds.
Treat as diagnostic baseline, not final scalable direct backend.
```

## 4. Full-coupled field-split backend

Algorithm:

```text
[A_qq A_qphi; A_phiq A_phiphi] [q; phi] = [b_q; b_phi]
FGMRES + block/field-split preconditioner
```

Status after full read:

```text
Patch G reports a dense/oracle-scale prototype with cached A_phiphi inverse, block-triangular preconditioner, phi-block residual telemetry and unpreconditioned reference telemetry.
Production large FEM integration remains open.
```

## 5. Schur-reduced backend

Algorithm:

```text
S(q) = A_qq q - A_qphi solve(A_phiphi, A_phiq q)
```

Status after full read:

```text
Patch H reports SchurCertificationState, certificate checks, planner fallback when uncertified, and mesh/material/physics signature invalidation.
Production Schur selection still requires real per-problem certificate and quality diagnostics.
```

## 6. Modal-reduced backend

Algorithm:

```text
use modal basis V
project drive
solve reduced response
validate sparse/direct sample points
```

Status after full read:

```text
Patch I reports a modal response validation helper, modal basis policy/cache key, completeness gate, and sparse/direct sample validation.
The production CPU Gamma/k0 modal adapter bridge is runtime-verified through
just verify-fem-frequency-domain-eigen-production-gamma-k-path-runtime. This
proves SLEPc shift-invert selected-spectrum provenance, zero-k multi-sample
orchestration, mode-field artifacts, and verifier acceptance for the current
small Gamma-equivalent case.
Full production sweep engine integration remains open.
Nonzero-k dynamic demag-k, periodic-airbox modal production, modal GPU, and
modal-reduced driven sweep integration remain gated.
```

## 7. GPU device FGMRES backend

Algorithm target:

```text
device-resident FGMRES(m)
fused apply_Aomega_gpu
GPU right preconditioner
device orthogonalization
no per-iteration D2H/H2D
```

Status after full read:

```text
Patch J reports planner gate, device vector/callback API skeleton, transfer diagnostics, prerequisite validation, callback probe, and fused Aomega diagnostics contract wiring into FGMRESDeviceEngineConfig.
Runtime device FGMRES loop is explicitly not implemented.
```

## 8. Production optimization

Patch K remains future work:

```text
performance tuning, CUDA Graphs, batched operators, layout optimization, production GPU profiling.
```

Do not start Patch K before numerical contraction and residency gates pass.


---

<!-- FILE: 09_validation_certification_benchmarks.md -->

---
title: Frequency-driven solver - validation, certification and benchmarks
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# Validation, certification and benchmarks

## 1. Physics gates

```text
G1 phase convention and chirality under exp(+i omega t)
G2 dynamic-field drive projection: b = -gamma T^T(m0 x delta_h)
G3 Cartesian/tangent roundtrip and m0·delta_m constraint
G4 zero-drive policy
G5 relaxed equilibrium consistency
G6 periodic/Floquet tangent-transfer
G7 DMI status gate
```

## 2. Algebra gates

```text
A1 real split equals complex form
A2 full-coupled vs Schur explicit apply
A3 full residual reconstruction from Schur solution
A4 sparse/direct vs dense tiny
A5 modal response vs dense/sparse sample points
```

## 3. Schur thresholds

```text
tiny dense:     <= 1e-10
CPU matrix-free <= 1e-8
GPU/HYPRE       <= 1e-6 initially
```

Runtime quality:

```text
eta = ||r - A P^-1 r|| / ||r||
```

```text
eta <= 0.30: good
0.30-0.70: bounded run only unless pilot confirms
0.70-0.90: weak, not default
>0.90: do not choose by default
>1.05: harmful, auto-disable unless forced debug
```

## 4. Stagnation policy

Do not run long 8192 solves when 64/256 show no contraction:

```text
if relres_256 / relres_0 > 0.9 and relres_256 > 1e-2:
    status = solve_error
    stop_reason = stagnated
```

## 5. Benchmark matrix

| Case | Purpose | Required backends |
|---|---|---|
| macrospin | phase/drive/damping | dense Cartesian/tangent |
| macrospin/Kittel k0 field sweep | eigen k=0 field scaling and thin-film FMR | modal eigen artifact verifier |
| standing spin waves | exchange/eigen | modal + sparse sample |
| skyrmion small | nonuniform m0 | relaxed texture + tangent gates |
| thin-film demag small | full vs Schur | full-coupled + Schur + sparse |
| periodic antidot small | PBC/Floquet/demag | mesh certificate + full-coupled |
| periodic antidot large | production | full-coupled/Schur/GPU when certified |
| wide sweep | speed | modal-reduced + sparse/direct samples |

## 6. Current status after full read

Patch queue reports many native contract gates already green for Patch D-J slices. The G5 relaxed-equilibrium gate now has native coverage for the missing accepted `LinearizationState` planner case and for builder-level v5 reject reasons/signature mismatches, verified by `just verify-fem-frequency-domain-native-contract` on 2026-07-07.

The modal/eigen k0 validation path now has a dedicated artifact-level Kittel
gate: `scripts/verify_fem_frequency_domain_eigen_artifacts.py
--require-k0-kittel-field-sweep`. It requires a zero-k branch over at least
three bias-field samples and checks either the macrospin Larmor law or the
in-plane thin-film Kittel formula declared in
`metadata.execution_plan.backend_plan.k0_kittel_validation`. This is the first
promotion gate before using larger periodic antidot or periodic-airbox modal
cases as evidence.

G6 now has certificate-level native coverage for bijective periodic pair maps, duplicate-pair rejection, schema marker `periodic_mesh_certificate.v5`, stable order-independent `fnv1a64:` magnetic/airbox pair-map fingerprints, explicit nonidentity tangent-frame transfer storage as row-major `G_pair` 2x2 blocks, rejection of inconsistent paired equilibrium directions with `periodic_m0_seam_mismatch`, optional same-step `H_demag0` seam rejection with `periodic_static_demag_seam_mismatch`, and required Poisson gauge policy rejection with `periodic_poisson_gauge_policy_missing`. The full certificate-level pair-map, `G_pair`, seam/gauge, and fingerprint slice passed `just verify-fem-frequency-domain-native-contract` after a managed runtime rebuild on 2026-07-07.

The remaining gap is production integration and larger-case validation, especially complete relaxed texture handoff, runtime consumption of periodic/Floquet `G_pair`, propagation of the seam/gauge/fingerprint certificate into serialized artifacts and solver lanes, artifact-level canonical `sha256:` pair-map hashes, full-coupled FEM field-split, certified Schur on real periodic-airbox workloads, and true runtime device FGMRES.


---

<!-- FILE: 10_patch_queue_current_status.md -->

---
title: Frequency-driven solver - patch queue current status
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# Patch queue current status after full read

This file replaces the older mixed patch queue language.

## Patch A - docs-only alignment

Status:

```text
Superseded by this v5 full-read documentation package.
```

## Patch B - lane diagnostics and progress throttling

Reported status:

```text
Implemented at native contract level.
Diagnostics publish Krylov host location and GPU operator/preconditioner provenance.
Progress interval default throttling is pinned in planner tests.
```

## Patch C - planner descriptors

Reported status:

```text
Implemented as header/descriptor skeleton and conservative planner gates.
Defaults are conservative: no Schur certificate and no device Krylov by default.
The planner now rejects relaxed-texture frequency-domain selection when an
accepted LinearizationState is required but unavailable, using the exact
rejection reason equilibrium_artifact_missing.
Verified by just verify-fem-frequency-domain-native-contract on 2026-07-07.
```

Related P0 relaxed-texture evidence:

```text
The LinearizationState builder reports exact v5 reject reasons for:
- equilibrium_artifact_not_accepted_for_linearization
- equilibrium_mesh_hash_mismatch
- equilibrium_material_hash_mismatch
- equilibrium_physics_hash_mismatch
- equilibrium_static_demag_required_but_missing
- equilibrium_torque_residual_too_large
The native contract gate also checks expected mesh/material/physics snapshot
matching against the requested frequency-domain problem.
Verified by just verify-fem-frequency-domain-native-contract on 2026-07-07.
```

Related P0 mesh/periodic evidence:

```text
The mesh symmetry certificate now reports accepted matched magnetic/airbox
pair maps, rejects duplicate periodic node pairs, records schema marker
periodic_mesh_certificate.v5, records stable order-independent fnv1a64
magnetic/airbox pair-map fingerprints, and stores nonidentity tangent-frame
transfer blocks as explicit row-major G_pair = T_dst^T R T_src 2x2 matrices.
It also rejects inconsistent paired equilibrium directions with
periodic_m0_seam_mismatch, optional same-step H_demag0 seam mismatches with
periodic_static_demag_seam_mismatch, and required-but-unspecified Poisson gauge
policy with periodic_poisson_gauge_policy_missing.
The full pair-map, G_pair, seam/gauge, and fingerprint certificate slice was
verified by just verify-fem-frequency-domain-native-contract after a managed
runtime rebuild on 2026-07-07.

This is certificate-level coverage only. Runtime solver lanes still need to
consume G_pair consistently and serialize canonical artifact-level sha256 pair
map hashes for periodic/Floquet constraints before large periodic-airbox
production workloads can be called covered.
```

## Patch D - COMSOL physics gates

Reported status:

```text
Implemented slices:
- drive_kind
- require_nonzero_rhs
- dynamic-field phasor projection through -gamma*m0_cross_delta_h
- null imaginary buffers treated as zero
- zero-drive warnings for physical drive
- zero tangent RHS rejection when require_nonzero_rhs=true
- complex lift/project Cartesian/tangent
- local Cartesian 3x3 operator projection T^T A T
```

## Patch E - dense full-coupled oracle

Reported status:

```text
Implemented tiny/oracle module:
- DenseFullCoupledMagnetostaticProblem
- DenseSchurExplicitBuilder
- FullReducedResidualReconstructionTest
- explicit Schur and full residual reconstruction checks
```

## Patch F - CPU sparse/direct baseline

Reported status:

```text
Implemented MVP:
- engines/sparse_direct
- real-split CSR assembly [K, omega M; -omega M, K]
- PETSc sequential AIJ
- KSPPREONLY + PCLU
- explicit unavailable fallback for non-PETSc builds
- native contract compares to dense tiny and true residual
```

## Patch G - full-coupled field-split prototype

Reported status:

```text
Implemented dense/oracle-scale prototype:
- FullCoupledBlockOperator
- FieldSplitPreconditioner
- PoissonBlockSolverAdapter
- cached A_phiphi inverse
- block-triangular field-split preconditioner
- phi residual telemetry
- unpreconditioned reference telemetry
```

## Patch H - Schur certification gate

Reported status:

```text
Implemented contract/planner gate:
- SchurCertificationState
- finite full-vs-reduced reconstruction requirement
- residual-contraction requirement
- certificate-to-capability projection
- uncertified periodic-airbox fallback
- mesh/material/physics signature invalidation
```

## Patch I - modal response backend

Reported status:

```text
Implemented validation/helper slices:
- modal response diagonal validation helper
- ModalBasisPolicy
- cache key builder
- completeness certificate gate
- sparse/direct sample validation
- production CPU Gamma/k0 modal adapter runtime proof with SLEPc shift-invert
  selected-spectrum provenance and mode-field artifacts
```

Latest implementation evidence, 2026-07-07:

```text
- RED: the production Gamma/k0 modal verifier rejected the real runtime bundle
  because it applied the no-demag nonzero-k Floquet rule to
  --require-production-gamma-k-path and also required strictly increasing
  path_s for a degenerate all-Gamma k-path.
- GREEN: just verify-fem-frequency-domain-eigen-production-gamma-k-path-runtime
  passed after the verifier was narrowed: nonzero-k production modal k-path
  still requires no-demag, while Gamma/k0 production bridge accepts ordinary
  k0 demag and degenerate path_s when all sampled k-vectors are zero.
```

Explicitly still missing:

```text
modal-reduced driven sweep engine integration
nonzero-k dynamic demag-k modal operator
periodic-airbox modal production proof
modal GPU runtime solver
broader sparse/matrix-free Floquet validation
```

## Patch J - GPU device FGMRES

Reported status:

```text
Implemented only as gate/API/probe:
- planner entry gate
- DeviceComplexVectorView
- GpuFrequencyOperatorContext
- ApplyAomegaGpu
- ApplyRightPreconditionerGpu
- transfer diagnostics
- FGMRES prerequisites config validation
- callback probe
- fused Aomega diagnostics contract requiring device input/output/scratch,
  stiffness-or-Jacobian and gyrotropic-frequency terms, required damping/demag
  term inclusion when declared, no host-side split term application, and no
  per-apply H2D/D2H transfer
- FGMRESDeviceEngineConfig rejects missing fused Aomega diagnostics and records
  fused_aomega_contract_passed in the readiness state
```

Explicitly still missing:

```text
runtime device FGMRES loop
device basis allocation
GPU orthogonalization
production runtime fused apply_Aomega_gpu implementation
proof of no D2H per iteration on real workloads
```

Latest implementation evidence, 2026-07-07:

```text
- RED: just verify-fem-frequency-domain-native-contract failed on missing
  GpuFusedAomegaDiagnostics, gpu_fused_aomega_contract_passes,
  FGMRESDeviceEngineConfig::fused_aomega_diagnostics, and
  FGMRESDeviceEngineState::fused_aomega_contract_passed.
- GREEN: just verify-fem-frequency-domain-native-contract passed after adding
  the fused Aomega diagnostics contract and wiring it into the FGMRES device
  engine config validation. This is still a contract gate, not a production
  runtime device FGMRES loop.
```

## Patch K - production optimization

Status:

```text
future; blocked by proof of contraction and residency.
```

## Priority correction after full read

Do not describe CPU sparse/direct, field-split, Schur certification, modal helper, or GPU API as entirely future. They have contract/prototype slices according to the patch queue. Do describe them accurately as incomplete for production large periodic-airbox workloads.


---

<!-- FILE: 11_runtime_telemetry_performance.md -->

---
title: Frequency-driven solver - runtime telemetry and performance
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# Runtime telemetry and performance

## 1. Required solver telemetry

```json
{
  "krylov_vector_location": "host|device",
  "operator_input_location": "host|device",
  "operator_output_location": "host|device",
  "preconditioner_input_location": "host|device",
  "preconditioner_output_location": "host|device",
  "gpu_device_resident_solver": false,
  "operator_apply_count": 0,
  "preconditioner_apply_count": 0,
  "poisson_setup_count": 0,
  "poisson_solve_count": 0,
  "cuda_h2d_count": 0,
  "cuda_d2h_count": 0,
  "cuda_sync_count": 0,
  "progress_callback_count": 0,
  "snapshot_sync_count": 0
}
```

## 2. Progress policy

```text
progress_interval_iterations = 0 must not mean every iteration.
```

Benchmark mode:

```text
progress_callback = null
live_snapshot = false
write_partial_artifacts = false
```

UI mode:

```text
progress interval >= 128 iterations or >= 250 ms
snapshot interval >= 2000 ms
no blocking GPU sync for snapshot
```

## 3. Residual policy

Report both tracked and recomputed residuals:

```json
{
  "tracked_relative_residual_l2_norm": 0.0,
  "last_recomputed_relative_residual_l2_norm": 0.0,
  "true_residual_verified": true,
  "residual_norm_contract": "l2_rhs_scaled_real_split"
}
```

## 4. Schur quality

```text
z = P^-1 r
eta = ||r - A z|| / ||r||
```

Report on actual residuals, not only initial RHS.

## 5. GPU device-residency claim

`gpu_device_krylov` can be emitted only if:

```text
Krylov vectors are device-resident
operator buffers are device-resident
preconditioner buffers are device-resident
no per-iteration H2D/D2H
orthogonalization is device-side
residual trend matches CPU reference
```

Patch queue says diagnostics and callback probe exist; it does not say runtime FGMRES exists.


---

<!-- FILE: 12_adr_decisions.md -->

---
title: Frequency-driven solver - accepted ADR decisions
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# ADR decisions

## ADR-001 - GPU lane names

```text
gpu_operator_host_krylov: public transitional/provenance lane.
gpu_device_krylov: true device-resident Krylov only.
production_gpu: legacy alias.
```

## ADR-002 - Drive/RHS

```text
default drive_kind = dynamic_field_phasor_a_per_m
raw tangent_rhs = expert/debug/benchmark mode
```

## ADR-003 - Zero drive

```text
physical zero drive -> zero response + warning
required nonzero tangent RHS -> validation error
```

## ADR-004 - Phase token

```text
canonical output token = exp_plus_i_omega_t
input aliases may include exp_i_omega_t
```

## ADR-005 - Public field representation

```text
public = Cartesian dmX/dmY/dmZ
internal = tangent u/v
```

## ADR-006 - Schur certificate scope

Certificate key includes:

```text
mesh, FE space, material, m0, h_eff0, static demag, physics terms, boundary conditions, periodic/Floquet pairs, k-vector, demag operator, tangent frame policy, phase convention, backend version, frequency/frequency window.
```

## ADR-007 - Schur gates

```text
tiny/dense: 1e-10
CPU matrix-free: 1e-8
GPU/HYPRE: 1e-6
runtime eta gates as in validation doc
```

## ADR-008 - Direct sparse backend

```text
first backend = PETSc Mat AIJ + KSPPREONLY + PCLU.
```

## ADR-009 - Modal reduced basis policy

```text
use_existing_required
use_existing_or_compute
force_recompute
```

## ADR-010 - GPU device Krylov entry gate

```text
no runtime device FGMRES before phase, drive, equilibrium, sparse/direct, Schur/preconditioner, residual and transfer gates pass.
```

## ADR-011 - Relaxed texture handoff

```text
frequency-domain must consume accepted EquilibriumArtifact.
```

## ADR-012 - Symmetric mesh v1

```text
strict matched mesh for periodic/Floquet FEM v1.
```

## ADR-013 - DMI boundary status

```text
volume DMI after tests; frequency-domain DMI boundary terms experimental unless certified.
```


---

<!-- FILE: 13_repo_migration_cleanup.md -->

---
title: Frequency-driven solver - repo migration and cleanup
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# Repo migration and cleanup

## 1. Install canonical docs

Recommended path:

```text
docs/frequency_domain_solver_v5/
```

Copy all files from this package there.

## 2. Archive older docs

Move these to archive or delete from active docs:

```text
fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
fd_solver_plan_00_index.md ... fd_solver_plan_11_decision_closures_adr.md old copies
frequency_driven_masterplan_comsol_aligned_v2/
frequency_driven_masterplan_comsol_aligned_v3/
frequency_driven_masterplan_comsol_aligned_v3_relaxed_texture/
frequency_driven_masterplan_comsol_aligned_v4_clean/
```

Archive path:

```text
docs/archive/frequency_domain_solver_pre_v5/
```

Archive README:

```text
Historical planning files. Do not use for current implementation decisions. Use docs/frequency_domain_solver_v5/00_README_CANONICAL_FULL_READ.md.
```

## 3. Add pointer in docs index

```markdown
# Frequency-domain solver

Canonical current documentation:

`docs/frequency_domain_solver_v5/00_README_CANONICAL_FULL_READ.md`
```

## 4. Full pack policy

`fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V5.md` is generated from individual v5 files. Do not hand-edit it.


---

<!-- FILE: 14_sources_traceability.md -->

---
title: Frequency-driven solver - sources and traceability
version: COMSOL-aligned v5.0 full-read canonical
date: 2026-07-07
status: canonical
source_policy: derived only after full read of all uploaded planning documents and the Micromagnetics Module User's Guide V2.13 PDF
supersedes:
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED.md
  - fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V3.md
  - fd_solver_plan_00_index.md through fd_solver_plan_11_decision_closures_adr.md old copies
---

# Sources and traceability

## 1. Manual facts used

The Micromagnetics Module User's Guide V2.13 states that since version 2.0 the module has both Time Domain and Frequency Domain parts; the Frequency Domain part solves the linearized LLG and supports Frequency Domain and Eigenfrequency studies.

The Frequency Domain chapter defines:

```text
m = m0 + delta_m exp(i omega t)
exp(+i omega t), not exp(-i omega t)
delta_m << m0
m0 · delta_m = 0
H_eff = h_eff0 + delta_h_eff exp(i omega t)
linearized LLG equation with damping term i omega alpha m0 x delta_m
```

It also defines complex frequency-domain dependent variables `dmX`, `dmY`, `dmZ`, dynamic external field as a harmonic phasor amplitude, zero response when no external perturbation is applied, DMI caveats, Floquet condition, and dynamic magnetostatic coupling workflow.

## 2. Documentation sources fully read

See `01_full_read_inventory_and_resolution.md` for exact filenames, hashes and line counts.

## 3. Code/runtime facts carried from attached docs

```text
MFEM tangent layout: full DOF = 3 per node, tangent DOF = 2 per node.
Current driven GMRES is host-side in production_cpu_driven_response.cpp.
Dense validation uses real split [K,+omegaM;-omegaM,K].
Modal infrastructure uses SLEPc/shift-invert/contour/window/dedup pieces.
Logs show periodic_airbox_k0 GMRES residual stagnation.
```

## 4. What needs verification against actual branch

The patch queue includes implementation evidence, but before changing code based on it, verify actual current branch contains:

```text
FrequencyDriveKind and require_nonzero_rhs through C ABI/Rust/native
project_dynamic_field_drive_to_tangent_rhs
Cartesian/tangent complex adapters
Dense full-coupled oracle
CPU sparse/direct engine
full-coupled field-split prototype
SchurCertificationState
modal response helper/completeness gate
GPU device skeleton and callback probe
```

This v5 documentation records the plan and reported patch status. It does not replace compiling and running the native contract gate.
