#pragma once

#include "frequency_domain/frequency_domain_contract.hpp"

#include <cstdint>
#include <vector>

namespace fullmag::fem::frequency_domain {

struct RealSplitCsrOperator {
    std::uint64_t tangent_dof_count = 0;
    double omega_rad_per_s = 0.0;
    const double *stiffness_matrix_row_major = nullptr;
    std::uint64_t stiffness_value_count = 0;
    const double *mass_matrix_row_major = nullptr;
    std::uint64_t mass_value_count = 0;
};

struct RealSplitCsrMatrix {
    std::uint64_t row_count = 0;
    std::uint64_t column_count = 0;
    std::vector<std::uint32_t> row_offsets{};
    std::vector<std::uint32_t> column_indices{};
    std::vector<double> values{};
};

FrequencyDomainStatus assemble_real_split_csr(
    const RealSplitCsrOperator &op,
    RealSplitCsrMatrix *out_matrix,
    char error_message[128]) noexcept;

} // namespace fullmag::fem::frequency_domain
