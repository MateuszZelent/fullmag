#pragma once

#include "frequency_domain/checked_extent.hpp"
#include "frequency_domain/frequency_domain_contract.hpp"

#include <cmath>
#include <cstdint>

namespace fullmag::fem::frequency_domain {

struct DeviceComplexVectorView {
    double *real = nullptr;
    double *imag = nullptr;
    std::uint64_t n = 0;
};

struct GpuFrequencyOperatorContext {
    void *device_operator_data = nullptr;
    void *stream = nullptr;
    std::uint64_t tangent_dof_count = 0;
};

enum class GpuKrylovVectorLocation : std::uint32_t {
    unknown = 0,
    host = 1,
    device = 2,
};

enum class GpuKrylovBufferLocation : std::uint32_t {
    unknown = 0,
    host = 1,
    device = 2,
    mixed = 3,
};

struct GpuDeviceKrylovTransferDiagnostics {
    bool gpu_device_resident_solver = false;
    GpuKrylovVectorLocation krylov_vector_location =
        GpuKrylovVectorLocation::unknown;
    GpuKrylovBufferLocation operator_buffer_location =
        GpuKrylovBufferLocation::unknown;
    GpuKrylovBufferLocation preconditioner_buffer_location =
        GpuKrylovBufferLocation::unknown;
    std::uint64_t iteration_count = 0;
    std::uint64_t setup_h2d_transfer_count = 0;
    std::uint64_t final_d2h_transfer_count = 0;
    std::uint64_t per_iteration_h2d_transfer_count = 0;
    std::uint64_t per_iteration_d2h_transfer_count = 0;
};

struct FGMRESDeviceResidualDiagnostics {
    bool bounded_64_run_available = false;
    bool bounded_256_run_available = false;
    std::uint64_t iterations_64 = 0;
    std::uint64_t iterations_256 = 0;
    double initial_relative_residual_l2_norm = 0.0;
    double relative_residual_after_64_l2_norm = 0.0;
    double relative_residual_after_256_l2_norm = 0.0;
    double cpu_reference_relative_residual_after_64_l2_norm = 0.0;
    double cpu_reference_relative_residual_after_256_l2_norm = 0.0;
    double tracked_final_relative_residual_l2_norm = 0.0;
    double recomputed_final_relative_residual_l2_norm = 0.0;
    double max_tracked_recomputed_relative_mismatch = 0.0;
    double max_device_to_cpu_residual_ratio = 0.0;
};

struct GpuFusedAomegaDiagnostics {
    bool fused_operator = false;
    bool stiffness_or_jacobian_term_included = false;
    bool gyrotropic_frequency_term_included = false;
    bool damping_term_required = false;
    bool damping_term_included = false;
    bool dynamic_demag_term_required = false;
    bool dynamic_demag_term_included = false;
    GpuKrylovBufferLocation operator_input_location =
        GpuKrylovBufferLocation::unknown;
    GpuKrylovBufferLocation operator_output_location =
        GpuKrylovBufferLocation::unknown;
    GpuKrylovBufferLocation operator_scratch_location =
        GpuKrylovBufferLocation::unknown;
    std::uint64_t apply_count = 0;
    std::uint64_t kernel_launch_count = 0;
    std::uint64_t host_side_term_apply_count = 0;
    std::uint64_t per_apply_h2d_transfer_count = 0;
    std::uint64_t per_apply_d2h_transfer_count = 0;
    double omega_rad_s = 0.0;
};

using ApplyAomegaGpu = FrequencyDomainStatus (*)(
    GpuFrequencyOperatorContext *ctx,
    double omega_rad_s,
    DeviceComplexVectorView x,
    DeviceComplexVectorView y) noexcept;

using ApplyRightPreconditionerGpu = FrequencyDomainStatus (*)(
    GpuFrequencyOperatorContext *ctx,
    double omega_rad_s,
    DeviceComplexVectorView r,
    DeviceComplexVectorView z) noexcept;

using ApplyFGMRESDeviceOrthogonalizationGpu = FrequencyDomainStatus (*)(
    GpuFrequencyOperatorContext *ctx,
    DeviceComplexVectorView krylov_basis,
    std::uint64_t basis_vector_count,
    DeviceComplexVectorView work_vector,
    DeviceComplexVectorView hessenberg_column) noexcept;

struct FGMRESDeviceEngineConfig {
    GpuFrequencyOperatorContext *context = nullptr;
    ApplyAomegaGpu apply_aomega = nullptr;
    ApplyRightPreconditionerGpu apply_right_preconditioner = nullptr;
    DeviceComplexVectorView solution{};
    DeviceComplexVectorView rhs{};
    std::uint64_t workspace_vector_count = 0;
    std::uint64_t max_iterations = 0;
    GpuDeviceKrylovTransferDiagnostics transfer_diagnostics{};
    FGMRESDeviceResidualDiagnostics residual_diagnostics{};
    GpuFusedAomegaDiagnostics fused_aomega_diagnostics{};
};

struct FGMRESDeviceAlgebraConfig {
    GpuFrequencyOperatorContext *context = nullptr;
    ApplyFGMRESDeviceOrthogonalizationGpu apply_orthogonalization = nullptr;
    DeviceComplexVectorView krylov_basis{};
    DeviceComplexVectorView preconditioned_basis{};
    DeviceComplexVectorView work_vector{};
    DeviceComplexVectorView hessenberg_column{};
    std::uint64_t restart_dimension = 0;
    GpuDeviceKrylovTransferDiagnostics transfer_diagnostics{};
};

struct FGMRESDeviceWorkspace {
    bool owned_by_engine = false;
    GpuKrylovBufferLocation buffer_location = GpuKrylovBufferLocation::unknown;
    DeviceComplexVectorView scratch_vectors{};
    std::uint64_t workspace_vector_count = 0;
    std::uint64_t restart_dimension = 0;
};

struct FGMRESDeviceEngine {
    FGMRESDeviceEngineConfig engine_config{};
    FGMRESDeviceAlgebraConfig algebra_config{};
    FGMRESDeviceWorkspace workspace{};
};

struct FGMRESDeviceEngineState {
    bool ready = false;
    bool transfer_contract_passed = false;
    bool residual_contract_passed = false;
    bool fused_aomega_contract_passed = false;
    bool apply_aomega_probe_passed = false;
    bool right_preconditioner_probe_passed = false;
    std::uint64_t workspace_vector_count = 0;
    std::uint64_t max_iterations = 0;
};

struct FGMRESDeviceAlgebraState {
    bool ready = false;
    bool transfer_contract_passed = false;
    bool device_orthogonalization_required = false;
    bool orthogonalization_probe_passed = false;
    std::uint64_t restart_dimension = 0;
};

struct FGMRESDeviceEngineReadiness {
    bool contract_ready = false;
    bool engine_config_ready = false;
    bool algebra_config_ready = false;
    bool workspace_contract_passed = false;
    bool production_loop_available = false;
    std::uint64_t tangent_dof_count = 0;
    std::uint64_t workspace_vector_count = 0;
    std::uint64_t restart_dimension = 0;
};

inline bool gpu_device_krylov_residency_contract_passes(
    const GpuDeviceKrylovTransferDiagnostics &diagnostics) noexcept
{
    return diagnostics.gpu_device_resident_solver &&
        diagnostics.krylov_vector_location == GpuKrylovVectorLocation::device &&
        diagnostics.operator_buffer_location == GpuKrylovBufferLocation::device &&
        diagnostics.preconditioner_buffer_location == GpuKrylovBufferLocation::device &&
        diagnostics.iteration_count > 0 &&
        diagnostics.per_iteration_h2d_transfer_count == 0 &&
        diagnostics.per_iteration_d2h_transfer_count == 0;
}

inline bool fgmres_device_residual_contract_passes(
    const FGMRESDeviceResidualDiagnostics &diagnostics) noexcept
{
    const double residual_floor = 1.0e-300;
    const bool finite_scalars =
        std::isfinite(diagnostics.initial_relative_residual_l2_norm) &&
        std::isfinite(diagnostics.relative_residual_after_64_l2_norm) &&
        std::isfinite(diagnostics.relative_residual_after_256_l2_norm) &&
        std::isfinite(diagnostics.cpu_reference_relative_residual_after_64_l2_norm) &&
        std::isfinite(diagnostics.cpu_reference_relative_residual_after_256_l2_norm) &&
        std::isfinite(diagnostics.tracked_final_relative_residual_l2_norm) &&
        std::isfinite(diagnostics.recomputed_final_relative_residual_l2_norm) &&
        std::isfinite(diagnostics.max_tracked_recomputed_relative_mismatch) &&
        std::isfinite(diagnostics.max_device_to_cpu_residual_ratio);
    if (!diagnostics.bounded_64_run_available ||
        !diagnostics.bounded_256_run_available ||
        diagnostics.iterations_64 < 64 ||
        diagnostics.iterations_256 < 256 ||
        !finite_scalars ||
        diagnostics.initial_relative_residual_l2_norm <= 0.0 ||
        diagnostics.relative_residual_after_64_l2_norm < 0.0 ||
        diagnostics.relative_residual_after_256_l2_norm < 0.0 ||
        diagnostics.cpu_reference_relative_residual_after_64_l2_norm < 0.0 ||
        diagnostics.cpu_reference_relative_residual_after_256_l2_norm < 0.0 ||
        diagnostics.tracked_final_relative_residual_l2_norm < 0.0 ||
        diagnostics.recomputed_final_relative_residual_l2_norm < 0.0 ||
        diagnostics.max_tracked_recomputed_relative_mismatch <= 0.0 ||
        diagnostics.max_device_to_cpu_residual_ratio <= 0.0) {
        return false;
    }

    if (!(diagnostics.relative_residual_after_64_l2_norm <
            diagnostics.initial_relative_residual_l2_norm) ||
        !(diagnostics.relative_residual_after_256_l2_norm <
            diagnostics.relative_residual_after_64_l2_norm)) {
        return false;
    }

    if (!(diagnostics.cpu_reference_relative_residual_after_256_l2_norm <=
            diagnostics.cpu_reference_relative_residual_after_64_l2_norm)) {
        return false;
    }

    const double tracked_recomputed_scale =
        std::fmax(
            std::fmax(
                diagnostics.tracked_final_relative_residual_l2_norm,
                diagnostics.recomputed_final_relative_residual_l2_norm),
            residual_floor);
    const double tracked_recomputed_mismatch =
        std::fabs(
            diagnostics.tracked_final_relative_residual_l2_norm -
            diagnostics.recomputed_final_relative_residual_l2_norm) /
        tracked_recomputed_scale;
    if (tracked_recomputed_mismatch >
        diagnostics.max_tracked_recomputed_relative_mismatch) {
        return false;
    }

    const double cpu_reference_64 =
        std::fmax(
            diagnostics.cpu_reference_relative_residual_after_64_l2_norm,
            residual_floor);
    const double cpu_reference_256 =
        std::fmax(
            diagnostics.cpu_reference_relative_residual_after_256_l2_norm,
            residual_floor);
    return diagnostics.relative_residual_after_64_l2_norm <=
            diagnostics.max_device_to_cpu_residual_ratio * cpu_reference_64 &&
        diagnostics.relative_residual_after_256_l2_norm <=
            diagnostics.max_device_to_cpu_residual_ratio * cpu_reference_256;
}

inline bool gpu_fused_aomega_contract_passes(
    const GpuFusedAomegaDiagnostics &diagnostics) noexcept
{
    if (!diagnostics.fused_operator ||
        !diagnostics.stiffness_or_jacobian_term_included ||
        !diagnostics.gyrotropic_frequency_term_included ||
        diagnostics.operator_input_location != GpuKrylovBufferLocation::device ||
        diagnostics.operator_output_location != GpuKrylovBufferLocation::device ||
        diagnostics.operator_scratch_location != GpuKrylovBufferLocation::device ||
        diagnostics.apply_count == 0 ||
        diagnostics.kernel_launch_count < diagnostics.apply_count ||
        diagnostics.host_side_term_apply_count != 0 ||
        diagnostics.per_apply_h2d_transfer_count != 0 ||
        diagnostics.per_apply_d2h_transfer_count != 0 ||
        !std::isfinite(diagnostics.omega_rad_s) ||
        diagnostics.omega_rad_s <= 0.0) {
        return false;
    }
    if (diagnostics.damping_term_required &&
        !diagnostics.damping_term_included) {
        return false;
    }
    if (diagnostics.dynamic_demag_term_required &&
        !diagnostics.dynamic_demag_term_included) {
        return false;
    }
    return true;
}

inline bool device_complex_vector_view_valid(
    DeviceComplexVectorView view,
    std::uint64_t expected_size) noexcept
{
    return view.real != nullptr &&
        view.imag != nullptr &&
        view.n == expected_size &&
        view.n <= kMaxFrequencyDomainWorkspaceBytes / sizeof(double) &&
        view.n > 0;
}

inline bool device_complex_vector_basis_view_valid(
    DeviceComplexVectorView view,
    std::uint64_t expected_vector_size,
    std::uint64_t vector_count) noexcept
{
    if (expected_vector_size == 0 ||
        vector_count == 0 ||
        view.real == nullptr ||
        view.imag == nullptr) {
        return false;
    }
    std::uint64_t expected_extent = 0;
    return checked_mul_u64_limited(
               expected_vector_size,
               vector_count,
               kMaxFrequencyDomainWorkspaceBytes / sizeof(double),
               expected_extent) == CheckedExtentStatus::ok &&
        view.n == expected_extent;
}

inline FrequencyDomainStatus validate_fgmres_device_engine_config(
    const FGMRESDeviceEngineConfig &config,
    FGMRESDeviceEngineState *out_state) noexcept
{
    if (out_state == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_state = FGMRESDeviceEngineState{};
    if (config.context == nullptr ||
        config.context->tangent_dof_count == 0 ||
        config.apply_aomega == nullptr ||
        config.apply_right_preconditioner == nullptr ||
        !device_complex_vector_view_valid(
            config.solution,
            config.context->tangent_dof_count) ||
        !device_complex_vector_view_valid(
            config.rhs,
            config.context->tangent_dof_count) ||
        config.workspace_vector_count < 4 ||
        config.max_iterations == 0 ||
        !gpu_device_krylov_residency_contract_passes(
            config.transfer_diagnostics) ||
        !fgmres_device_residual_contract_passes(
            config.residual_diagnostics) ||
        !gpu_fused_aomega_contract_passes(
            config.fused_aomega_diagnostics)) {
        return FrequencyDomainStatus::validation_error;
    }
    out_state->ready = true;
    out_state->transfer_contract_passed = true;
    out_state->residual_contract_passed = true;
    out_state->fused_aomega_contract_passed = true;
    out_state->workspace_vector_count = config.workspace_vector_count;
    out_state->max_iterations = config.max_iterations;
    return FrequencyDomainStatus::ok;
}

inline FrequencyDomainStatus validate_fgmres_device_algebra_config(
    const FGMRESDeviceAlgebraConfig &config,
    FGMRESDeviceAlgebraState *out_state) noexcept
{
    if (out_state == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_state = FGMRESDeviceAlgebraState{};
    std::uint64_t hessenberg_column_count = 0;
    if (!checked_add_u64(
            config.restart_dimension,
            1,
            hessenberg_column_count) ||
        config.restart_dimension > kMaxFrequencyDomainKrylovRestartDimension ||
        config.context == nullptr ||
        config.context->tangent_dof_count == 0 ||
        config.apply_orthogonalization == nullptr ||
        config.restart_dimension == 0 ||
        !device_complex_vector_basis_view_valid(
            config.krylov_basis,
            config.context->tangent_dof_count,
            config.restart_dimension) ||
        !device_complex_vector_basis_view_valid(
            config.preconditioned_basis,
            config.context->tangent_dof_count,
            config.restart_dimension) ||
        !device_complex_vector_view_valid(
            config.work_vector,
            config.context->tangent_dof_count) ||
        !device_complex_vector_view_valid(
            config.hessenberg_column,
            hessenberg_column_count) ||
        !gpu_device_krylov_residency_contract_passes(
            config.transfer_diagnostics)) {
        return FrequencyDomainStatus::validation_error;
    }
    out_state->ready = true;
    out_state->transfer_contract_passed = true;
    out_state->device_orthogonalization_required = true;
    out_state->restart_dimension = config.restart_dimension;
    return FrequencyDomainStatus::ok;
}

inline FrequencyDomainStatus validate_fgmres_device_engine_readiness(
    const FGMRESDeviceEngine &engine,
    FGMRESDeviceEngineReadiness *out_readiness) noexcept
{
    if (out_readiness == nullptr) {
        return FrequencyDomainStatus::validation_error;
    }
    *out_readiness = FGMRESDeviceEngineReadiness{};

    FGMRESDeviceEngineState engine_state{};
    FGMRESDeviceAlgebraState algebra_state{};
    if (validate_fgmres_device_engine_config(
            engine.engine_config,
            &engine_state) != FrequencyDomainStatus::ok ||
        validate_fgmres_device_algebra_config(
            engine.algebra_config,
            &algebra_state) != FrequencyDomainStatus::ok ||
        engine.engine_config.context == nullptr ||
        engine.engine_config.context != engine.algebra_config.context ||
        !engine.workspace.owned_by_engine ||
        engine.workspace.buffer_location != GpuKrylovBufferLocation::device ||
        engine.workspace.workspace_vector_count <
            engine.engine_config.workspace_vector_count ||
        engine.workspace.restart_dimension !=
            engine.algebra_config.restart_dimension ||
        !device_complex_vector_basis_view_valid(
            engine.workspace.scratch_vectors,
            engine.engine_config.context->tangent_dof_count,
            engine.workspace.workspace_vector_count)) {
        return FrequencyDomainStatus::validation_error;
    }

    out_readiness->contract_ready = true;
    out_readiness->engine_config_ready = engine_state.ready;
    out_readiness->algebra_config_ready = algebra_state.ready;
    out_readiness->workspace_contract_passed = true;
    out_readiness->production_loop_available = false;
    out_readiness->tangent_dof_count =
        engine.engine_config.context->tangent_dof_count;
    out_readiness->workspace_vector_count =
        engine.workspace.workspace_vector_count;
    out_readiness->restart_dimension = engine.workspace.restart_dimension;
    return FrequencyDomainStatus::ok;
}

inline FrequencyDomainStatus probe_fgmres_device_engine_callbacks(
    const FGMRESDeviceEngineConfig &config,
    double omega_rad_s,
    DeviceComplexVectorView scratch,
    FGMRESDeviceEngineState *out_state) noexcept
{
    FrequencyDomainStatus status =
        validate_fgmres_device_engine_config(config, out_state);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    if (!(omega_rad_s > 0.0) ||
        !device_complex_vector_view_valid(
            scratch,
            config.context->tangent_dof_count)) {
        *out_state = FGMRESDeviceEngineState{};
        return FrequencyDomainStatus::validation_error;
    }

    status = config.apply_aomega(
        config.context,
        omega_rad_s,
        config.rhs,
        scratch);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    out_state->apply_aomega_probe_passed = true;

    status = config.apply_right_preconditioner(
        config.context,
        omega_rad_s,
        scratch,
        config.solution);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    out_state->right_preconditioner_probe_passed = true;
    return FrequencyDomainStatus::ok;
}

inline FrequencyDomainStatus probe_fgmres_device_algebra_callbacks(
    const FGMRESDeviceAlgebraConfig &config,
    std::uint64_t basis_vector_count,
    FGMRESDeviceAlgebraState *out_state) noexcept
{
    FrequencyDomainStatus status =
        validate_fgmres_device_algebra_config(config, out_state);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    std::uint64_t required_hessenberg_count = 0;
    if (!checked_add_u64(
            basis_vector_count,
            1,
            required_hessenberg_count) ||
        basis_vector_count == 0 ||
        basis_vector_count > config.restart_dimension ||
        config.hessenberg_column.n < required_hessenberg_count) {
        *out_state = FGMRESDeviceAlgebraState{};
        return FrequencyDomainStatus::validation_error;
    }

    status = config.apply_orthogonalization(
        config.context,
        config.krylov_basis,
        basis_vector_count,
        config.work_vector,
        config.hessenberg_column);
    if (status != FrequencyDomainStatus::ok) {
        return status;
    }
    out_state->orthogonalization_probe_passed = true;
    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
