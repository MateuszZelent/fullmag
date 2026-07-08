#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"

#include <cstdint>
#include <vector>

namespace fullmag::fem::frequency_domain {

struct FullCoupledBlockOperator {
    std::uint64_t q_dof_count = 0;
    std::uint64_t phi_dof_count = 0;
    const double *a_qq_row_major = nullptr;
    std::uint64_t a_qq_value_count = 0;
    const double *a_qphi_row_major = nullptr;
    std::uint64_t a_qphi_value_count = 0;
    const double *a_phiq_row_major = nullptr;
    std::uint64_t a_phiq_value_count = 0;
    const double *a_phiphi_row_major = nullptr;
    std::uint64_t a_phiphi_value_count = 0;
    const double *b_q = nullptr;
    std::uint64_t b_q_value_count = 0;
    const double *b_phi = nullptr;
    std::uint64_t b_phi_value_count = 0;
};

struct PoissonBlockSolverAdapter {
    std::uint64_t phi_dof_count = 0;
    std::uint64_t setup_count = 0;
    std::uint64_t solve_count = 0;
    std::vector<double> inverse_row_major;
};

struct FieldSplitPreconditioner {
    const FullCoupledBlockOperator *op = nullptr;
    PoissonBlockSolverAdapter *poisson = nullptr;
};

struct FieldSplitPreconditionerSetup {
    const FullCoupledBlockOperator *op = nullptr;
    PoissonBlockSolverAdapter *poisson = nullptr;
};

struct FullCoupledFieldSplitProblem {
    const FullCoupledBlockOperator *op = nullptr;
    FieldSplitPreconditioner *preconditioner = nullptr;
    std::uint64_t max_iterations = 0;
    double relaxation = 1.0;
    double *out_q = nullptr;
    double *out_phi = nullptr;
    std::uint64_t out_q_capacity = 0;
    std::uint64_t out_phi_capacity = 0;
};

struct FullCoupledFieldSplitSolveResult {
    std::uint64_t completed_iterations = 0;
    std::uint64_t poisson_setup_count = 0;
    std::uint64_t poisson_solve_count = 0;
    double initial_residual_l2_norm = 0.0;
    double initial_relative_residual_l2_norm = 0.0;
    double final_residual_l2_norm = 0.0;
    double final_relative_residual_l2_norm = 0.0;
    double initial_phi_residual_l2_norm = 0.0;
    double initial_relative_phi_residual_l2_norm = 0.0;
    double final_phi_residual_l2_norm = 0.0;
    double final_relative_phi_residual_l2_norm = 0.0;
    double unpreconditioned_reference_final_residual_l2_norm = 0.0;
    double unpreconditioned_reference_final_relative_residual_l2_norm = 0.0;
    char error_message[160] = "";
};

FrequencyDomainStatus initialize_field_split_preconditioner(
    const FieldSplitPreconditionerSetup &setup,
    FieldSplitPreconditioner *out_preconditioner) noexcept;

FrequencyDomainStatus solve_full_coupled_field_split(
    const FullCoupledFieldSplitProblem &problem,
    FullCoupledFieldSplitSolveResult *out_result) noexcept;

} // namespace fullmag::fem::frequency_domain
