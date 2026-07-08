#pragma once

#include "frequency_domain/planner/frequency_solve_plan.hpp"

namespace fullmag::fem::frequency_domain {

struct FrequencySolvePlannerInput {
    bool tiny_problem = true;
    bool single_frequency = true;
    bool sparse_direct_memory_ok = false;
    bool relaxed_texture_linearization_required = false;
    bool accepted_linearization_state_available = false;
    bool periodic_airbox_k0 = false;
    bool periodic_mesh_symmetry_certified = false;
    bool full_coupled_blocks_available = false;
    bool schur_certified = false;
    bool schur_reduced_explicitly_requested = false;
    bool many_frequencies = false;
    bool modal_basis_validated = false;
    bool requested_gpu = false;
    bool gpu_operator_backend_available = false;
    bool device_resident_krylov_available = false;
    bool preconditioner_certified = false;
};

inline FrequencySolvePlan plan_frequency_response(
    const FrequencySolvePlannerInput& input)
{
    FrequencySolvePlan plan{};
    plan.require_relaxed_texture_gate =
        input.relaxed_texture_linearization_required;
    plan.require_symmetric_mesh_certificate = input.periodic_airbox_k0;
    if (input.tiny_problem) {
        return plan;
    }

    if (input.relaxed_texture_linearization_required &&
        !input.accepted_linearization_state_available) {
        plan.rejected = true;
        plan.rejection_reason = "equilibrium_artifact_missing";
        return plan;
    }

    if (input.single_frequency && input.sparse_direct_memory_ok) {
        plan.lane = FrequencyExecutionLane::cpu_sparse_direct;
        plan.operator_representation = FrequencyOperatorRepresentation::sparse_csr;
        plan.linear_solver = FrequencyLinearSolverFamily::sparse_direct;
        plan.require_true_residual_verification = true;
        return plan;
    }

    if (input.periodic_airbox_k0 && !input.periodic_mesh_symmetry_certified) {
        plan.rejected = true;
        plan.rejection_reason = "symmetric_mesh_certificate_missing";
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

    if (input.periodic_airbox_k0 &&
        input.schur_reduced_explicitly_requested &&
        input.schur_certified) {
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

    if (input.requested_gpu &&
        input.device_resident_krylov_available &&
        input.preconditioner_certified) {
        plan.lane = FrequencyExecutionLane::gpu_device_krylov;
        plan.operator_representation = FrequencyOperatorRepresentation::matrix_free_gpu;
        plan.linear_solver = FrequencyLinearSolverFamily::device_fgmres;
        plan.require_preconditioner_contraction_certificate = true;
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

    if (input.periodic_airbox_k0) {
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

inline FrequencySolvePlan plan_frequency_response(
    const FrequencyBackendCapabilities& capabilities,
    const FrequencySolverPolicy& policy)
{
    FrequencySolvePlannerInput input{};
    input.tiny_problem = policy.validation_mode;
    input.single_frequency = policy.prefer_sparse_direct_for_single_frequency;
    input.sparse_direct_memory_ok =
        capabilities.sparse_direct_available && capabilities.sparse_direct_memory_ok;
    input.relaxed_texture_linearization_required =
        policy.require_relaxed_texture_linearization;
    input.accepted_linearization_state_available =
        capabilities.accepted_linearization_state_available;
    input.full_coupled_blocks_available = capabilities.full_coupled_blocks_available;
    input.periodic_mesh_symmetry_certified =
        capabilities.periodic_mesh_symmetry_certified;
    input.schur_certified =
        capabilities.schur_certified && capabilities.schur_quality_good;
    input.schur_reduced_explicitly_requested = policy.request_schur_reduced;
    input.many_frequencies = policy.prefer_modal_for_sweeps;
    input.modal_basis_validated =
        capabilities.modal_basis_validated &&
        policy.modal_frequency_count_threshold > 0;
    input.requested_gpu = policy.request_gpu || policy.prefer_existing_host_krylov;
    input.gpu_operator_backend_available =
        capabilities.gpu_operator_backend_available ||
        policy.prefer_existing_host_krylov;
    input.device_resident_krylov_available =
        policy.allow_device_resident_krylov &&
        capabilities.gpu_device_krylov_available;
    input.preconditioner_certified = capabilities.preconditioner_certified;

    return plan_frequency_response(input);
}

} // namespace fullmag::fem::frequency_domain
