#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"

#include <cstdint>

namespace fullmag::fem::frequency_domain {

struct CpuSparseDirectRealSplitProblem {
    std::uint64_t tangent_dof_count = 0;
    double frequency_hz = 0.0;
    const double *stiffness_matrix_row_major = nullptr;
    std::uint64_t stiffness_value_count = 0;
    const double *mass_matrix_row_major = nullptr;
    std::uint64_t mass_value_count = 0;
    const double *drive_real = nullptr;
    std::uint64_t drive_real_count = 0;
    const double *drive_imag = nullptr;
    std::uint64_t drive_imag_count = 0;
    double *out_response_real = nullptr;
    double *out_response_imag = nullptr;
    std::uint64_t response_capacity = 0;
    double angular_frequency_sign = 1.0;
};

struct CpuSparseDirectSolveResult {
    const char *solver_package = "unavailable";
    const char *linear_solver = "unavailable";
    std::uint64_t nnz = 0;
    double residual_l2_norm = 0.0;
    double relative_residual_l2_norm = 0.0;
    char error_message[128] = "";
};

FrequencyDomainStatus solve_cpu_sparse_direct_real_split(
    const CpuSparseDirectRealSplitProblem &problem,
    CpuSparseDirectSolveResult *out_result) noexcept;

} // namespace fullmag::fem::frequency_domain
