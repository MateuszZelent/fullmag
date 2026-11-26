---
title: Provenance
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/specs/provenance-contract.md
---

(public-docs-architecture-provenance)=
# Provenance

Provenance keeps **requested intent** separate from **resolved execution** and records the exact
solver, hardware, mesh, and artifact identities needed to audit reproducibility. A provenance
record establishes *what ran*; numerical convergence and scientific qualification remain separate
evidence documented under {doc}`../validation/index`.

## Recorded identities and solver receipts

| Record | Public meaning | Concrete IR / runtime realization |
|---|---|---|
| Requested vs. resolved backend, device & precision | What the script requested vs. what the planner and runtime executed | `CommonPlanMeta` (`requested_backend`, `resolved_backend`, `execution_mode`) + `apply_ir_runtime_device_override` |
| Physics graph & integrator resolution | Requested vs. resolved energy/torque modules and time-integrator contracts | `ProvenancePlanIR` (`PhysicsGraphRuntimeProvenanceIR`, `IntegratorResolutionProvenanceIR`) |
| FDM direct-minimizer realization | Distinguishes device-resident CUDA PG-BB from host-orchestrated NCG | `cuda_fdm_direct_minimizer_realization` (`native_cuda_pgbb` vs. `cuda_fdm_host_tangent_gradient`) |
| FDM M1 charge linear solver | Records default cooperative AMG-PCG vs. opt-in `cuDSS` direct Cholesky | `resolve_charge_linear_solver_realization` (`cg_device_amg_wcycle_v1` vs. `cudss_direct_cholesky_opt_in`) |
| FEM GPU demag linear solver & receipt bit | Records requested strategy (`auto`/`cg_amg`/`cudss`), resolved solver (`cudss_direct` vs. `hypre_krylov`), fallback reason, and operator receipt bit 12 (`FULLMAG_FEM_GPU_OPERATOR_DIRECT_SOLVE`, mutually exclusive with `PRECONDITIONER`) | `fullmag_fem_backend_get_gpu_demag_linear_solver_provenance_v1` |
| FEM modal & mixed/prism mesh provenance | Records modal shift-invert realization (`k0_augmented_exact_shift_mumps`, GPU `cuDSS` shifts), mixed/pure-prism topology certificates, and spatial material fields | `FemEigenExecutionResolutionIR`, `FemMixedTopologyProvenanceIR`, `MaterialFieldProvenanceIR` |
| Stage completion & artifact attestation | Why each stage stopped, revision keys for caching, and streaming file checksums for large result bundles | `ExecutionPlanIR`, `hash_regular_file_snapshot`, `ZarrFieldMetadataBatch` |

## Invariants

- A failure states the exact unsatisfied combination or device memory budget; FullMag never
  silently substitutes another interaction, backend, device, or precision.
- Permitted `"auto"` resolutions (such as FEM GPU `gpu_strategy="auto"` falling back from `cuDSS`
  to `CG`/`AMG` when the estimated factor exceeds device VRAM) always record an explicit
  `linear_solver_fallback_reason` in provenance; fallback is prohibited when explicit strict pins
  (`gpu_strategy="cudss"`) are requested.
- Artifacts, meshes, and field buffers are revision-keyed so Control Room cache invalidation and
  live Python synchronization follow `scene_revision`, `mesh_revision`, and `field_revision`
  deterministically.

See the Python runtime provenance surface in {doc}`../python-api/runtime/provenance` and
acceleration/receipt contracts in {ref}`numerical-methods-performance`.

## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `crates/fullmag-ir/src/plan.rs` | `CommonPlanMeta`, `ProvenancePlanIR`, `PhysicsGraphRuntimeProvenanceIR`, `IntegratorResolutionProvenanceIR`, `FemEigenExecutionResolutionIR`, `FemMixedTopologyProvenanceIR`, `MaterialFieldProvenanceIR` | requested/resolved backend, physics graph, modal, mesh, and material provenance |
| `crates/fullmag-runner/src/relaxation/provenance.rs` | `cuda_fdm_direct_minimizer_realization` | FDM CUDA PG-BB (`native_cuda_pgbb`) vs. host-orchestrated NCG provenance |
| `crates/fullmag-runner/src/fdm/gpu/cuda/charge_transport.rs` | `resolve_charge_linear_solver_realization` | FDM M1 charge AMG-PCG vs. opt-in `cuDSS` provenance |
| `backends/fem/src/api.cpp` | `fullmag_fem_backend_get_gpu_demag_linear_solver_provenance_v1` | FEM GPU demag requested/resolved linear solver and fallback-reason query |
| `crates/fullmag-workspace-inspect/src/manifest.rs` | `hash_regular_file_snapshot` | streaming run metadata attestation for large results |
| `packages/fullmag-py/src/fullmag/runtime/loader.py` | `apply_ir_runtime_device_override` | records managed launcher device override separately in runtime metadata |
