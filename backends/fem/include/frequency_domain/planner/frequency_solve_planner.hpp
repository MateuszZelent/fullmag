#pragma once

#include "frequency_domain/planner/frequency_solve_plan.hpp"

namespace fullmag::fem::frequency_domain {

struct FrequencySolvePlannerInput {
    bool tiny_problem = true;
    bool single_frequency = true;
    bool sparse_direct_memory_ok = false;
    bool periodic_airbox_k0 = false;
    bool full_coupled_blocks_available = false;
    bool schur_certified = false;
    bool many_frequencies = false;
    bool modal_basis_validated = false;
    bool requested_gpu = false;
    bool gpu_operator_backend_available = false;
    bool device_resident_krylov_available = false;
};

inline FrequencySolvePlan plan_frequency_response(
    const FrequencySolvePlannerInput& input)
{
    FrequencySolvePlan plan{};
    if (input.tiny_problem) {
        return plan;
    }

    if (input.single_frequency && input.sparse_direct_memory_ok) {
        plan.lane = FrequencyExecutionLane::cpu_sparse_direct;
        plan.operator_representation = FrequencyOperatorRepresentation::sparse_csr;
        plan.linear_solver = FrequencyLinearSolverFamily::sparse_direct;
        plan.require_true_residual_verification = true;
        return plan;
    }

    if (input.periodic_airbox_k0 && input.full_coupled_blocks_available) {
        plan.lane = FrequencyExecutionLane::full_coupled_field_split;
        plan.operator_representation =
            FrequencyOperatorRepresentation::coupled_block_matnest;
        plan.linear_solver = FrequencyLinearSolverFamily::host_fgmres;
        plan.preconditioner = FrequencyPreconditionerFamily::field_split_schur;
        plan.use_full_coupled_system = true;
        return plan;
    }

    if (input.periodic_airbox_k0 && input.schur_certified) {
        plan.lane = FrequencyExecutionLane::schur_reduced;
        plan.operator_representation =
            FrequencyOperatorRepresentation::schur_reduced_matrix_free;
        plan.linear_solver = FrequencyLinearSolverFamily::host_fgmres;
        plan.preconditioner = FrequencyPreconditionerFamily::schur_residual;
        plan.use_schur_reduction = true;
        return plan;
    }

    if (input.many_frequencies && input.modal_basis_validated) {
        plan.lane = FrequencyExecutionLane::modal_reduced;
        plan.operator_representation = FrequencyOperatorRepresentation::modal_reduced;
        plan.linear_solver = FrequencyLinearSolverFamily::modal_reduced;
        plan.preconditioner = FrequencyPreconditionerFamily::modal_reduced;
        return plan;
    }

    if (input.requested_gpu && input.device_resident_krylov_available) {
        plan.lane = FrequencyExecutionLane::gpu_device_krylov;
        plan.operator_representation = FrequencyOperatorRepresentation::matrix_free_gpu;
        plan.linear_solver = FrequencyLinearSolverFamily::device_fgmres;
        plan.allow_gpu_operator_backend = true;
        plan.allow_device_resident_krylov = true;
        return plan;
    }

    if (input.requested_gpu && input.gpu_operator_backend_available) {
        plan.lane = FrequencyExecutionLane::gpu_operator_host_krylov;
        plan.operator_representation = FrequencyOperatorRepresentation::matrix_free_gpu;
        plan.linear_solver = FrequencyLinearSolverFamily::host_gmres;
        plan.allow_gpu_operator_backend = true;
        plan.allow_device_resident_krylov = false;
        return plan;
    }

    plan.lane = FrequencyExecutionLane::schur_reduced;
    plan.operator_representation =
        FrequencyOperatorRepresentation::schur_reduced_matrix_free;
    plan.linear_solver = FrequencyLinearSolverFamily::host_gmres;
    plan.preconditioner = FrequencyPreconditionerFamily::block_jacobi;
    plan.use_schur_reduction = input.periodic_airbox_k0;
    return plan;
}

} // namespace fullmag::fem::frequency_domain
