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
