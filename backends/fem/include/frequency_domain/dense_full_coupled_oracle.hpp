#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

enum class DensePhiGaugePolicy : std::uint32_t {
    require_invertible = 0,
    pin_first_dof = 1,
};

struct DenseFullCoupledMagnetostaticProblem {
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
    DensePhiGaugePolicy phi_gauge_policy = DensePhiGaugePolicy::require_invertible;
};

struct DenseSchurExplicitBuilder {
    const DenseFullCoupledMagnetostaticProblem *problem = nullptr;
    double *out_schur_row_major = nullptr;
    std::uint64_t out_schur_value_count = 0;
    double *out_reduced_rhs = nullptr;
    std::uint64_t out_reduced_rhs_value_count = 0;
};

struct FullReducedResidualReconstructionTest {
    const DenseFullCoupledMagnetostaticProblem *problem = nullptr;
    const double *q = nullptr;
    std::uint64_t q_value_count = 0;
    const double *reduced_residual = nullptr;
    std::uint64_t reduced_residual_value_count = 0;
    double *out_phi = nullptr;
    std::uint64_t out_phi_value_count = 0;
    double *out_full_residual_q = nullptr;
    std::uint64_t out_full_residual_q_value_count = 0;
    double *out_full_residual_phi = nullptr;
    std::uint64_t out_full_residual_phi_value_count = 0;
};

struct DenseFullCoupledOracleDiagnostics {
    std::uint64_t q_dof_count = 0;
    std::uint64_t phi_dof_count = 0;
    DensePhiGaugePolicy phi_gauge_policy = DensePhiGaugePolicy::require_invertible;
    double max_abs_reduced_residual_mismatch = 0.0;
    double max_abs_full_q_residual = 0.0;
    double max_abs_full_phi_residual = 0.0;
    char error_message[160] = "";
};

FrequencyDomainStatus build_dense_explicit_schur(
    const DenseSchurExplicitBuilder &builder,
    DenseFullCoupledOracleDiagnostics *out_diagnostics) noexcept;

FrequencyDomainStatus apply_dense_full_coupled_schur(
    const DenseFullCoupledMagnetostaticProblem &problem,
    const double *q,
    std::uint64_t q_value_count,
    double *out_schur_q,
    std::uint64_t out_schur_q_value_count,
    DenseFullCoupledOracleDiagnostics *out_diagnostics) noexcept;

FrequencyDomainStatus reconstruct_dense_full_residual_from_schur_solution(
    const FullReducedResidualReconstructionTest &test,
    DenseFullCoupledOracleDiagnostics *out_diagnostics) noexcept;

} // namespace fullmag::fem::frequency_domain
