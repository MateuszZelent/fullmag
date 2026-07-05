# Frequency-driven solver — solver tree architecture

Docelowy solver nie jest jedną funkcją `solve`. To system planowania, certyfikacji i wyboru backendu.

---

## 1. Główne komponenty

```text
frequency_domain/
├── algebra/
│   ├── canonical_frequency_pencil.hpp
│   ├── cartesian_tangent_adapter.hpp
│   ├── full_coupled_blocks.hpp
│   ├── schur_reduction.hpp
│   └── residual_norms.hpp
├── planner/
│   ├── frequency_solve_planner.hpp
│   ├── frequency_solve_plan.hpp
│   ├── backend_capabilities.hpp
│   └── solver_policy.hpp
├── operators/
│   ├── tangent_operator_bsr.hpp
│   ├── dynamic_demag_operator.hpp
│   ├── floquet_operator.hpp
│   └── drive_projection.hpp
├── engines/
│   ├── dense_reference/
│   ├── sparse_direct/
│   ├── full_coupled_fieldsplit/
│   ├── schur_reduced/
│   ├── modal_reduced/
│   └── gpu_device_krylov/
├── validation/
│   ├── comsol_physics_gates.hpp
│   ├── schur_certification.hpp
│   ├── residual_consistency.hpp
│   └── backend_crosscheck.hpp
└── diagnostics/
    ├── telemetry_schema.hpp
    ├── progress_throttle.hpp
    └── artifact_schema.hpp
```

---

## 2. Honest execution lanes

Obecne `production_gpu` jest za szerokie. Nowe nazwy:

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

Definicje:

| Lane | Znaczenie |
|---|---|
| `dense_cartesian_reference` | mały oracle `δm ∈ C^3` z constraintem |
| `dense_tangent_reference` | mały oracle tangent real-split |
| `cpu_sparse_direct` | assembled CSR/BSR + direct solve |
| `cpu_host_krylov` | Krylov i operator na CPU |
| `gpu_operator_host_krylov` | Krylov na CPU, operator/preconditioner może używać GPU |
| `full_coupled_field_split` | pełny blok `δm/φ` + preconditioner blokowy |
| `schur_reduced` | certyfikowany Schur fast path |
| `modal_reduced` | response przez mody/reduced basis |
| `gpu_device_krylov` | Krylov, operator i preconditioner device-resident |

---

## 3. FrequencySolvePlan

```cpp
struct FrequencySolvePlan {
    FrequencyExecutionLane lane;
    OperatorRepresentation operator_representation;
    LinearSolverFamily linear_solver;
    PreconditionerFamily preconditioner;

    bool use_cartesian_reference;
    bool use_tangent_internal_representation;
    bool use_full_coupled_system;
    bool use_schur_reduction;
    bool use_modal_reduction;
    bool use_device_resident_krylov;

    bool require_phase_convention_gate;
    bool require_cartesian_tangent_gate;
    bool require_true_residual_verification;
    bool require_schur_certification;

    const char* selection_reason;
    const char* fallback_reason;
};
```

---

## 4. Planner inputs

```cpp
struct FrequencySolvePlanningInput {
    std::uint64_t node_count;
    std::uint64_t tangent_dof_count;
    std::uint64_t cartesian_dof_count;
    std::uint64_t phi_dof_count;
    std::uint64_t frequency_count;

    bool has_dynamic_demag;
    bool has_airbox;
    bool has_periodic_boundary;
    bool has_floquet_boundary;
    bool has_dmi;
    bool has_easa;
    bool has_stt;

    bool dense_oracle_allowed;
    bool sparse_assembly_available;
    bool full_coupled_available;
    bool schur_certified;
    bool modal_basis_available;
    bool gpu_available;
    bool gpu_device_krylov_available;

    double memory_budget_bytes;
    double target_relative_tolerance;
    double target_absolute_tolerance;
};
```

---

## 5. Decision tree

```text
if tiny and validation_requested:
    dense_cartesian_reference

else if phase/cartesian/tangent gates missing:
    dense_tangent_reference or dense_cartesian_reference

else if single_frequency and sparse_direct_memory_ok:
    cpu_sparse_direct

else if dynamic_demag or airbox:
    if full_coupled_available:
        full_coupled_field_split
    else if schur_certified:
        schur_reduced
    else:
        reject with certification_required

else if frequency_count is large and modal_basis_available:
    modal_reduced

else if gpu_device_krylov_available and preconditioner_certified:
    gpu_device_krylov

else:
    cpu_sparse_direct or cpu_host_krylov fallback
```

---

## 6. Backend matrix

| Backend | Szybkość | Dokładność | Ryzyko | Cel |
|---|---:|---:|---:|---|
| Dense Cartesian reference | niska | najwyższa | niskie | oracle fizyczny |
| Dense tangent reference | niska | wysoka | niskie | oracle tangent/sign |
| CPU sparse/direct | średnia | wysoka | niskie/średnie | robust baseline |
| Full coupled field-split | średnia/wysoka | wysoka | średnie | core demag/airbox |
| Schur-reduced | wysoka | wysoka po certyfikacji | wysokie bez certyfikacji | fast path |
| Modal-reduced | bardzo wysoka dla sweepów | zależna od bazy | średnie | response spectrum |
| GPU device Krylov | wysoka | zależna od preconditionera | wysokie | duże układy |

---

## 7. Planner diagnostics

Każdy solve powinien zapisywać:

```json
{
  "selected_backend": "full_coupled_field_split",
  "fallback_backend": "cpu_sparse_direct",
  "execution_lane": "full_coupled_field_split",
  "operator_representation": "full_coupled_tangent2_phi",
  "solver_family": "fgmres",
  "preconditioner_family": "field_split_schur",
  "selection_reason": "dynamic_demag_airbox_requires_full_coupled_reference",
  "schur_certified": false,
  "gpu_residency": {
    "krylov_vectors": "host|device",
    "operator_buffers": "host|device",
    "preconditioner_buffers": "host|device"
  }
}
```

---

## 8. Separation of concerns

Zakazane w docelowym kodzie:

```text
solver wybiera Schura wewnątrz callbacka bez planu
operator callback robi ukryte H2D/D2H bez telemetry
execution_lane nazywa się GPU, mimo że Krylov jest hostowy
RHS może znaczyć δh albo tangent RHS bez drive_kind
phase_convention jest w dwóch strukturach jako dwa źródła prawdy
```

Wymagane:

```text
planner wybiera backend
engine wykonuje backend
operator tylko aplikuje operator
preconditioner tylko aplikuje preconditioner
diagnostics opisują wszystko jawnie
```

---

## 9. Minimalny source layout patch

Pierwszy physical split bez zmiany zachowania:

```text
backends/fem/src/frequency_domain/driven_response_solver.cpp
    pozostaje entrypointem

nowe pliki:
backends/fem/src/frequency_domain/planner/frequency_solve_plan.cpp
backends/fem/src/frequency_domain/planner/frequency_solve_planner.cpp
backends/fem/src/frequency_domain/engines/host_krylov/host_gmres_engine.cpp
backends/fem/src/frequency_domain/diagnostics/frequency_diagnostics_json.cpp
```

W pierwszym patchu engine może nadal wywoływać istniejący hostowy GMRES. Celem jest separacja, nie zmiana wyniku.
