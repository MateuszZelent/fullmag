---
title: Planner and Capabilities
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/specs/capability-matrix-v0.json
---

(public-docs-architecture-planner-and-capabilities)=
# Planner and capabilities

The planner (`crates/fullmag-plan`) takes the canonical `ProblemIR` and resolves which backend,
device, precision, discretization realization, and linear/relaxation solver can satisfy the request.
It fails closed with an explicit scope reason instead of silently changing the requested
interaction, solver, device, precision, or mesh class.

## Resolution record

| Concept | Public meaning |
|---|---|
| Requested intent | What the Python script or Control Room authored (`engine`, `device`, `precision`, `mode`, solver policies) |
| Resolved execution | Concrete backend lane, mesh/grid certificate, and solver strategy chosen after capability & preflight checks |
| Capability matrix | Checked support and qualification register per `(FDM/FEM × CPU/GPU)` lane |
| Scope & fallback reasons | Fail-closed explanations for rejected combinations, or explicit provenance reasons when `"auto"` policies select an alternative realization |

## Lane, mode, and policy resolution rules

1. **`strict` vs. `auto` execution**: In `strict` mode, any unsupported engine/device/interaction/
   solver combination is rejected before backend startup. Availability-first device selection is
   used under `"auto"`; no unqualified mesh-size CPU/GPU crossover heuristic is silently applied.
   Multi-GPU requests (`gpu_count > 1`) are rejected on all current public lanes.
2. **Opt-in material physics activation**: Material properties alone do not silently enable extra
   energy terms where explicit interaction registration is required; planner capability checks
   align physics-graph modules with the resolved lane.
3. **FDM GPU capability & preflight gates**:
   - Single-layer demag automatically selects batched half-spectrum `D2Z`/`Z2D` (FP64) or
     `R2C`/`C2R` (FP32) cuFFT after exact `cufftMakePlanMany` workspace preflight; multilayer
     retains `Z2Z`/`C2C` with aggregate workspace preflight.
   - Single-layer and multilayer CUDA PG-BB run device-resident (`native_cuda_pgbb`) under strict
     operator receipts, while NCG remains host-orchestrated (`cuda_fdm_host_tangent_gradient`).
   - M1 charge transport defaults to multi-block cooperative AMG-PCG (`cg_device_amg_wcycle_v1`),
     with opt-in `cuDSS` Cholesky (`FULLMAG_FDM_CHARGE_GPU_DIRECT_SOLVER=cudss`) gated by device
     budget preflight.
4. **FEM GPU capability & preflight gates**:
   - **Three-state demag linear solver (`FemLinearSolverPolicy.gpu_strategy`)**: `"auto"` (default)
     selects `cuDSS` direct Cholesky when the estimated factor fits within the live device VRAM
     budget and falls back transparently to `CG`/`AMG` with `linear_solver_fallback_reason`
     otherwise; `"cudss"` fails closed if budget or matrix regularity checks fail; `"cg_amg"`
     forces iterative Krylov. Applies to open Poisson, 1D/2D PBC Poisson, and atomic `(u1, u2)`
     FEM/BEM pairs (`fullmag_fem_backend_create_v6`).
   - **Thin-film `pure_prism_p2` certificates**: `transition="pure_prism"` verifies a 100% `prism6`
     certificate (`validate_pure_prism_topology_certificate_against_mesh`), unlocking automatic P2
     demag potential while rejecting uncertified mixed/eigen combinations fail-closed.
   - **Relaxation preconditioning (`study.fem_bb_preconditioner`)**: `"auto"` promotes cooperative
     CUDA PCG `bb_exchange_mass` preconditioning when exchange is active; `"none"` and
     `"exchange_mass"` pin behavior explicitly.
   - **Spectral & driven-response lanes**: Open-airbox FEM GPU eigensolve is qualified on CUDA with
     guarded `cuDSS` shifts; single-$k$ GPU Floquet has bounded native contract scope; driven
     response `FrequencyResponseSolverPolicy.method="gpu_sparse_direct"` uses VRAM-guarded `cuDSS`
     and rejects unsupported nonzero-$k$ Floquet combinations explicitly.

## Qualification discipline

Resolved execution is always recorded in provenance. Source presence, compilation, or a skipped
test never promotes a lane to qualified; GPU parity claims require executed-device evidence.
Unsupported, bounded, and `NO-GO` realizations are documented explicitly rather than overclaimed.

## Where the policy is enforced

- Python `Problem` validation and lowering: `packages/fullmag-py/src/fullmag/model/problem.py` — `Problem.to_ir`.
- Capability and routing decisions: `crates/fullmag-plan/src/lib.rs` — `plan`.
- Public capability statuses: {doc}`../validation/qualification-status`.
- Hardware acceleration and preflight details: {ref}`numerical-methods-performance`.

## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/problem.py` | `Problem.to_ir` | Python validation and lowering |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `FemLinearSolverPolicy` | public FEM `gpu_strategy` (`auto` / `cg_amg` / `cudss`) policy |
| `packages/fullmag-py/src/fullmag/world.py` | `StudyBuilder.fem_bb_preconditioner` | public FEM GPU BB preconditioner policy |
| `crates/fullmag-plan/src/lib.rs` | `plan` | backend selection and rejected-combination reasons |
| `crates/fullmag-ir/src/plan.rs` | `ExecutionPlanIR` | resolved backend plan, output plan, and provenance |
| `backends/fem/gpu/cuda/demag_poisson/cudss_direct_solver.cpp` | `resolve_demag_gpu_solver_strategy` | three-state FEM GPU `cuDSS` vs. `CG`/`AMG` strategy resolution |
| `backends/fem/src/api.cpp` | `fullmag_fem_backend_create_v6` | versioned FEM C ABI carrying explicit linear-solver strategy |
