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
