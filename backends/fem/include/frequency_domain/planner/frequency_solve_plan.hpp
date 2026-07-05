#pragma once

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
    bool require_true_residual_verification = true;
    bool allow_gpu_operator_backend = false;
    bool allow_device_resident_krylov = false;
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
