# Frequency-driven solver — API and code skeletons

Fragmenty są szkicami kontraktu. Nie są finalnym API ABI, ale pokazują docelowy podział odpowiedzialności.

---

## 1. Konwencje fizyczne

```cpp
enum class FrequencyPhaseConvention : std::uint32_t {
    exp_plus_i_omega_t = 1,
    exp_minus_i_omega_t = 2,
};

enum class FrequencyUnknownRepresentation : std::uint32_t {
    cartesian3_complex_constrained = 1,
    tangent2_complex = 2,
    full_coupled_cartesian3_phi = 3,
    full_coupled_tangent2_phi = 4,
};

enum class FrequencyDriveKind : std::uint32_t {
    dynamic_field_phasor_a_per_m = 1,
    tangent_rhs = 2,
    cartesian_torque_phasor = 3,
    stt_current_phasor = 4,
    coupled_external_provider = 5,
};
```

---

## 2. LinearizationState

```cpp
struct CartesianVectorFieldView {
    const double* x;
    const double* y;
    const double* z;
    std::uint64_t node_count;
};

struct MaterialSnapshot {
    const double* ms_a_per_m;
    const double* alpha;
    const double* exchange_a_m;
    const double* anisotropy_a_per_m;
    std::uint64_t node_count;
    std::uint64_t material_hash;
};

struct PhysicsTermSnapshot {
    bool exchange_enabled;
    bool anisotropy_enabled;
    bool zeeman_enabled;
    bool dmi_enabled;
    bool demag_enabled;
    bool stt_enabled;
    bool easa_enabled;
    std::uint64_t physics_hash;
};

struct LinearizationState {
    CartesianVectorFieldView m0_unit;
    CartesianVectorFieldView h_eff0_a_per_m;
    CartesianVectorFieldView h_demag0_a_per_m;
    MaterialSnapshot material;
    PhysicsTermSnapshot terms;
    double max_m0_norm_error;
    double max_m0_cross_heff0_relative;
};
```

---

## 3. Cartesian↔tangent adapter

```cpp
struct TangentFrameNodeView {
    double m0[3];
    double e1[3];
    double e2[3];
};

inline void lift_tangent_to_cartesian_node(
    const TangentFrameNodeView& f,
    double u_re,
    double v_re,
    double u_im,
    double v_im,
    double out_re[3],
    double out_im[3]) noexcept
{
    for (int c = 0; c < 3; ++c) {
        out_re[c] = u_re * f.e1[c] + v_re * f.e2[c];
        out_im[c] = u_im * f.e1[c] + v_im * f.e2[c];
    }
}

inline void project_cartesian_to_tangent_node(
    const TangentFrameNodeView& f,
    const double in_re[3],
    const double in_im[3],
    double& u_re,
    double& v_re,
    double& u_im,
    double& v_im) noexcept
{
    u_re = v_re = u_im = v_im = 0.0;
    for (int c = 0; c < 3; ++c) {
        u_re += f.e1[c] * in_re[c];
        v_re += f.e2[c] * in_re[c];
        u_im += f.e1[c] * in_im[c];
        v_im += f.e2[c] * in_im[c];
    }
}
```

---

## 4. Drive projection

```cpp
struct DynamicFieldPhasorView {
    const double* hx_re;
    const double* hy_re;
    const double* hz_re;
    const double* hx_im;
    const double* hy_im;
    const double* hz_im;
    std::uint64_t node_count;
};

struct TangentComplexVectorView {
    double* real;
    double* imag;
    std::uint64_t tangent_dof_count;
};

FrequencyDomainStatus project_dynamic_field_drive_to_tangent_rhs(
    const TangentFrameNodeView* frames,
    std::uint64_t node_count,
    double gamma0,
    FrequencyPhaseConvention convention,
    const DynamicFieldPhasorView& drive,
    TangentComplexVectorView out_rhs,
    FrequencyDiagnostics* diagnostics) noexcept;
```

W testach znak `γ m0×δh` musi zostać potwierdzony względem dense Cartesian oracle.

---

## 5. Solve plan

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

enum class OperatorRepresentation : std::uint32_t {
    dense_cartesian_constrained = 1,
    dense_tangent_real_split = 2,
    sparse_csr_real_split = 3,
    sparse_bsr_tangent_blocks = 4,
    full_coupled_matnest = 5,
    schur_reduced_matrix_free = 6,
    modal_reduced_basis = 7,
    gpu_matrix_free = 8,
};

struct FrequencySolvePlan {
    FrequencyExecutionLane lane;
    OperatorRepresentation representation;
    bool require_phase_gate;
    bool require_cartesian_tangent_gate;
    bool require_schur_certification;
    bool verify_true_residual_on_convergence;
    bool use_full_coupled_system;
    bool use_schur_reduction;
    bool use_modal_reduction;
    bool use_device_resident_krylov;
    const char* selection_reason;
};
```

---

## 6. Planner skeleton

```cpp
FrequencySolvePlan plan_frequency_solve(
    const FrequencyProblemDescriptor& problem,
    const FrequencySolverPolicy& policy,
    const HardwareCapabilities& hardware,
    const CertificationState& cert) noexcept
{
    FrequencySolvePlan plan{};
    plan.require_phase_gate = true;
    plan.require_cartesian_tangent_gate = true;
    plan.verify_true_residual_on_convergence = true;

    if (policy.validation_mode || problem.tangent_dof_count <= 32) {
        plan.lane = FrequencyExecutionLane::dense_cartesian_reference;
        plan.representation = OperatorRepresentation::dense_cartesian_constrained;
        plan.selection_reason = "tiny_or_validation_requires_cartesian_oracle";
        return plan;
    }

    if (problem.has_dynamic_demag || problem.has_airbox) {
        if (cert.full_coupled_available) {
            plan.lane = FrequencyExecutionLane::full_coupled_field_split;
            plan.representation = OperatorRepresentation::full_coupled_matnest;
            plan.use_full_coupled_system = true;
            plan.selection_reason = "dynamic_demag_uses_full_coupled_core";
            return plan;
        }
        if (cert.schur_certified && cert.schur_quality_good) {
            plan.lane = FrequencyExecutionLane::schur_reduced;
            plan.representation = OperatorRepresentation::schur_reduced_matrix_free;
            plan.use_schur_reduction = true;
            plan.selection_reason = "certified_schur_fast_path";
            return plan;
        }
    }

    if (problem.frequency_count > policy.modal_frequency_count_threshold &&
        cert.modal_basis_available) {
        plan.lane = FrequencyExecutionLane::modal_reduced;
        plan.representation = OperatorRepresentation::modal_reduced_basis;
        plan.use_modal_reduction = true;
        plan.selection_reason = "many_frequencies_use_modal_reduction";
        return plan;
    }

    if (cert.sparse_direct_available && cert.sparse_direct_memory_ok) {
        plan.lane = FrequencyExecutionLane::cpu_sparse_direct;
        plan.representation = OperatorRepresentation::sparse_csr_real_split;
        plan.selection_reason = "sparse_direct_baseline_available";
        return plan;
    }

    if (hardware.cuda_available && cert.gpu_device_krylov_available &&
        cert.preconditioner_certified) {
        plan.lane = FrequencyExecutionLane::gpu_device_krylov;
        plan.representation = OperatorRepresentation::gpu_matrix_free;
        plan.use_device_resident_krylov = true;
        plan.selection_reason = "device_krylov_available_and_preconditioner_certified";
        return plan;
    }

    plan.lane = FrequencyExecutionLane::gpu_operator_host_krylov;
    plan.representation = OperatorRepresentation::schur_reduced_matrix_free;
    plan.selection_reason = "fallback_to_existing_host_krylov_path";
    return plan;
}
```

---

## 7. Sparse direct engine interface

```cpp
struct SparseDirectFrequencySystem {
    CsrMatrixView k_real_split_base;
    CsrMatrixView m_real_split_base;
    std::uint64_t block_dof_count;
    bool symbolic_pattern_frequency_independent;
};

struct SparseDirectSolveRequest {
    double frequency_hz;
    const double* rhs;
    double* solution;
    double relative_tolerance;
    double absolute_tolerance;
};

class CpuSparseDirectEngine {
public:
    FrequencyDomainStatus analyze_pattern(
        const SparseDirectFrequencySystem& system,
        SparseDirectDiagnostics& diagnostics);

    FrequencyDomainStatus factorize_shifted(
        double omega_rad_s,
        SparseDirectDiagnostics& diagnostics);

    FrequencyDomainStatus solve(
        const SparseDirectSolveRequest& request,
        SparseDirectDiagnostics& diagnostics);
};
```

---

## 8. Full coupled operator interface

```cpp
struct FullCoupledBlockSizes {
    std::uint64_t q_dof_complex;
    std::uint64_t phi_dof_complex;
};

struct FullCoupledOperator {
    FullCoupledBlockSizes sizes;

    FrequencyDomainStatus apply_Aqq(
        double omega,
        ComplexVectorView q,
        ComplexVectorView out_q) noexcept;

    FrequencyDomainStatus apply_Aqphi(
        ComplexVectorView phi,
        ComplexVectorView out_q) noexcept;

    FrequencyDomainStatus apply_Aphiq(
        ComplexVectorView q,
        ComplexVectorView out_phi) noexcept;

    FrequencyDomainStatus apply_Aphiphi(
        ComplexVectorView phi,
        ComplexVectorView out_phi) noexcept;
};
```

---

## 9. Schur certification interface

```cpp
struct SchurCertificationResult {
    bool certified;
    double relative_apply_error;
    double full_reconstruction_relative_error;
    double poisson_block_relative_residual;
    char failure_reason[128];
};

FrequencyDomainStatus certify_schur_reduction(
    const FullCoupledOperator& full,
    const SchurReducedOperator& schur,
    const SchurCertificationPolicy& policy,
    SchurCertificationResult* out) noexcept;
```

---

## 10. Device-resident GPU interface

```cpp
struct DeviceComplexVectorView {
    double* real;
    double* imag;
    std::uint64_t n;
};

struct GpuOperatorContext {
    void* device_operator_data;
    void* stream; // cudaStream_t hidden from public C ABI if needed
    std::uint64_t tangent_dof_count;
};

using ApplyAomegaGpu = FrequencyDomainStatus (*)(
    GpuOperatorContext* ctx,
    double omega_rad_s,
    DeviceComplexVectorView x,
    DeviceComplexVectorView y) noexcept;

using ApplyRightPreconditionerGpu = FrequencyDomainStatus (*)(
    GpuOperatorContext* ctx,
    double omega_rad_s,
    DeviceComplexVectorView r,
    DeviceComplexVectorView z) noexcept;
```

---

## 11. Progress throttling

```cpp
struct ProgressThrottlePolicy {
    std::uint64_t iteration_interval = 128;
    std::uint64_t min_interval_ms = 250;
    bool publish_initial = true;
    bool publish_final = true;
};

bool should_publish_progress(
    const ProgressThrottlePolicy& p,
    std::uint64_t iteration,
    std::uint64_t elapsed_ms_since_last,
    bool final_event) noexcept
{
    if (final_event && p.publish_final) return true;
    if (iteration == 0 && p.publish_initial) return true;
    if (p.iteration_interval == 0) return false;
    return iteration % p.iteration_interval == 0 &&
           elapsed_ms_since_last >= p.min_interval_ms;
}
```

---

## 12. Stagnation diagnostics, bez nowego ABI statusu na start

```cpp
struct StagnationDetector {
    std::uint64_t window_iterations = 256;
    double minimum_required_ratio_drop = 0.10;
    double residual_floor_to_ignore = 1e-2;
};

bool gmres_is_stagnating(
    double relres_before_window,
    double relres_now,
    const StagnationDetector& d) noexcept
{
    if (!(relres_now > d.residual_floor_to_ignore)) return false;
    if (!(relres_before_window > 0.0)) return false;
    const double ratio = relres_now / relres_before_window;
    return ratio > (1.0 - d.minimum_required_ratio_drop);
}
```

Na początku raportować jako:

```json
{
  "status": "solve_error",
  "stop_reason": "stagnated"
}
```

bez dodawania nowego enum ABI.
