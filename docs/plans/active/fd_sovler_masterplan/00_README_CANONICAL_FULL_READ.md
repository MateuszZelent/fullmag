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
16. `15_self_weryfication_Kittel.md`
17. `16_implementation_plan_Kittel_D2.md`
18. `17_eigen_k0_gpu_readiness_audit.md`
19. `18_poisson_airbox_eigensolve_cpu_gpu_implementation.md`
20. `fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V5.md`

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
