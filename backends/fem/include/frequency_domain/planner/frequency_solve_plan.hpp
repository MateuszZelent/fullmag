#pragma once

#include <cmath>
#include <cstdint>

namespace fullmag::fem::frequency_domain {

enum class FrequencyExecutionLane {
    dense_reference,
    cpu_sparse_direct,
    full_coupled_field_split,
    schur_reduced,
    modal_reduced,
    gpu_operator_host_krylov,
    gpu_device_krylov,
};

enum class FrequencyOperatorRepresentation {
    dense_tiny,
    sparse_csr,
    sparse_bsr_2x2,
    matrix_free_cpu,
    matrix_free_gpu,
    coupled_block_matnest,
    schur_reduced_matrix_free,
    modal_reduced,
};

enum class FrequencyLinearSolverFamily {
    dense_direct,
    sparse_direct,
    host_gmres,
    host_fgmres,
    device_fgmres,
    modal_reduced,
};

enum class FrequencyPreconditionerFamily {
    none,
    block_jacobi,
    ilu,
    amg,
    field_split_schur,
    schur_residual,
    modal_reduced,
};

struct FrequencySolvePlan {
    FrequencyExecutionLane lane = FrequencyExecutionLane::dense_reference;
    FrequencyOperatorRepresentation operator_representation =
        FrequencyOperatorRepresentation::dense_tiny;
    FrequencyLinearSolverFamily linear_solver =
        FrequencyLinearSolverFamily::dense_direct;
    FrequencyPreconditionerFamily preconditioner =
        FrequencyPreconditionerFamily::none;
    bool use_full_coupled_system = false;
    bool use_schur_reduction = false;
    bool require_relaxed_texture_gate = false;
    bool require_symmetric_mesh_certificate = false;
    bool require_true_residual_verification = true;
    bool require_preconditioner_contraction_certificate = false;
    bool allow_gpu_operator_backend = false;
    bool allow_device_resident_krylov = false;
    bool rejected = false;
    const char *rejection_reason = "";
    const char *selection_reason = "";
    const char *fallback_reason = "";
};

struct FrequencyBackendCapabilities {
    bool sparse_direct_available = false;
    bool sparse_direct_memory_ok = false;
    bool full_coupled_blocks_available = false;
    bool accepted_linearization_state_available = false;
    bool periodic_mesh_symmetry_certified = false;
    bool schur_certified = false;
    bool schur_quality_good = false;
    bool modal_basis_validated = false;
    bool gpu_operator_backend_available = false;
    bool gpu_device_krylov_available = false;
    bool preconditioner_certified = false;
};

struct SchurCertificationState {
    bool quality_diagnostics_available = false;
    bool full_reduced_residual_reconstruction_passed = false;
    double full_reduced_relative_residual_error = 0.0;
    double max_full_reduced_relative_residual_error = 1.0e-10;
    double observed_residual_contraction = 1.0;
    double max_observed_residual_contraction = 0.95;
    std::uint64_t mesh_signature = 0;
    std::uint64_t material_signature = 0;
    std::uint64_t physics_signature = 0;
};

inline bool schur_certification_passes(const SchurCertificationState &state)
{
    return state.quality_diagnostics_available &&
        state.full_reduced_residual_reconstruction_passed &&
        std::isfinite(state.full_reduced_relative_residual_error) &&
        std::isfinite(state.max_full_reduced_relative_residual_error) &&
        std::isfinite(state.observed_residual_contraction) &&
        std::isfinite(state.max_observed_residual_contraction) &&
        state.full_reduced_relative_residual_error >= 0.0 &&
        state.max_full_reduced_relative_residual_error > 0.0 &&
        state.full_reduced_relative_residual_error <=
            state.max_full_reduced_relative_residual_error &&
        state.observed_residual_contraction >= 0.0 &&
        state.max_observed_residual_contraction > 0.0 &&
        state.observed_residual_contraction <=
            state.max_observed_residual_contraction;
}

inline bool schur_certification_passes_for_problem(
    const SchurCertificationState &state,
    std::uint64_t mesh_signature,
    std::uint64_t material_signature,
    std::uint64_t physics_signature)
{
    return schur_certification_passes(state) &&
        state.mesh_signature == mesh_signature &&
        state.material_signature == material_signature &&
        state.physics_signature == physics_signature;
}

inline void apply_schur_certification(
    const SchurCertificationState &state,
    FrequencyBackendCapabilities *capabilities)
{
    if (capabilities == nullptr) {
        return;
    }
    const bool certified = schur_certification_passes(state);
    capabilities->schur_certified = certified;
    capabilities->schur_quality_good = certified;
}

struct FrequencySolverPolicy {
    bool validation_mode = false;
    bool request_gpu = false;
    bool require_relaxed_texture_linearization = false;
    bool prefer_existing_host_krylov = true;
    bool allow_device_resident_krylov = false;
    bool prefer_sparse_direct_for_single_frequency = true;
    bool prefer_modal_for_sweeps = true;
    bool request_schur_reduced = false;
    std::uint64_t modal_frequency_count_threshold = 8;
    std::uint64_t progress_interval_iterations = 128;
};

inline const char* frequency_execution_lane_name(FrequencyExecutionLane lane)
{
    switch (lane) {
    case FrequencyExecutionLane::dense_reference:
        return "dense_reference";
    case FrequencyExecutionLane::cpu_sparse_direct:
        return "cpu_sparse_direct";
    case FrequencyExecutionLane::full_coupled_field_split:
        return "full_coupled_field_split";
    case FrequencyExecutionLane::schur_reduced:
        return "schur_reduced";
    case FrequencyExecutionLane::modal_reduced:
        return "modal_reduced";
    case FrequencyExecutionLane::gpu_operator_host_krylov:
        return "gpu_operator_host_krylov";
    case FrequencyExecutionLane::gpu_device_krylov:
        return "gpu_device_krylov";
    }
    return "unknown";
}

inline const char* frequency_operator_representation_name(
    FrequencyOperatorRepresentation representation)
{
    switch (representation) {
    case FrequencyOperatorRepresentation::dense_tiny:
        return "dense_tiny";
    case FrequencyOperatorRepresentation::sparse_csr:
        return "sparse_csr";
    case FrequencyOperatorRepresentation::sparse_bsr_2x2:
        return "sparse_bsr_2x2";
    case FrequencyOperatorRepresentation::matrix_free_cpu:
        return "matrix_free_cpu";
    case FrequencyOperatorRepresentation::matrix_free_gpu:
        return "matrix_free_gpu";
    case FrequencyOperatorRepresentation::coupled_block_matnest:
        return "coupled_block_matnest";
    case FrequencyOperatorRepresentation::schur_reduced_matrix_free:
        return "schur_reduced_matrix_free";
    case FrequencyOperatorRepresentation::modal_reduced:
        return "modal_reduced";
    }
    return "unknown";
}

} // namespace fullmag::fem::frequency_domain
