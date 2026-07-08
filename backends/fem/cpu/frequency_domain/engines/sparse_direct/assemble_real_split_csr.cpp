#include "cpu/frequency_domain/engines/sparse_direct/assemble_real_split_csr.hpp"

#include <cmath>
#include <cstring>
#include <limits>

namespace fullmag::fem::frequency_domain {

namespace {

void copy_error(char out[128], const char *message) noexcept
{
    if (out == nullptr) {
        return;
    }
    std::strncpy(out, message, 127);
    out[127] = '\0';
}

bool square_count_matches(std::uint64_t n, std::uint64_t count) noexcept
{
    return n <= std::numeric_limits<std::uint64_t>::max() / n && count == n * n;
}

bool finite_values(const double *values, std::uint64_t count) noexcept
{
    if (values == nullptr) {
        return false;
    }
    for (std::uint64_t index = 0; index < count; ++index) {
        if (!std::isfinite(values[index])) {
            return false;
        }
    }
    return true;
}

bool push_entry(
    RealSplitCsrMatrix *matrix,
    std::uint64_t column,
    double value,
    char error_message[128]) noexcept
{
    if (value == 0.0) {
        return true;
    }
    if (column > std::numeric_limits<std::uint32_t>::max() ||
        matrix->values.size() >= std::numeric_limits<std::uint32_t>::max()) {
        copy_error(error_message, "real-split CSR matrix exceeds 32-bit index capacity");
        return false;
    }
    matrix->column_indices.push_back(static_cast<std::uint32_t>(column));
    matrix->values.push_back(value);
    return true;
}

} // namespace

FrequencyDomainStatus assemble_real_split_csr(
    const RealSplitCsrOperator &op,
    RealSplitCsrMatrix *out_matrix,
    char error_message[128]) noexcept
{
    if (out_matrix == nullptr) {
        copy_error(error_message, "real-split CSR assembly requires output matrix");
        return FrequencyDomainStatus::validation_error;
    }
    *out_matrix = RealSplitCsrMatrix{};
    const std::uint64_t n = op.tangent_dof_count;
    if (n == 0 ||
        n > std::numeric_limits<std::uint32_t>::max() / 2 ||
        !std::isfinite(op.omega_rad_per_s)) {
        copy_error(error_message, "real-split CSR assembly requires a finite positive-sized operator");
        return FrequencyDomainStatus::validation_error;
    }
    if (!square_count_matches(n, op.stiffness_value_count) ||
        !square_count_matches(n, op.mass_value_count) ||
        !finite_values(op.stiffness_matrix_row_major, op.stiffness_value_count) ||
        !finite_values(op.mass_matrix_row_major, op.mass_value_count)) {
        copy_error(error_message, "real-split CSR assembly requires finite square stiffness and mass matrices");
        return FrequencyDomainStatus::validation_error;
    }

    try {
        const std::uint64_t block_size = 2 * n;
        out_matrix->row_count = block_size;
        out_matrix->column_count = block_size;
        out_matrix->row_offsets.reserve(static_cast<std::size_t>(block_size + 1));
        out_matrix->column_indices.reserve(static_cast<std::size_t>(4 * n * n));
        out_matrix->values.reserve(static_cast<std::size_t>(4 * n * n));
        out_matrix->row_offsets.push_back(0);

        for (std::uint64_t row = 0; row < block_size; ++row) {
            const bool imag_row = row >= n;
            const std::uint64_t operator_row = imag_row ? row - n : row;
            for (std::uint64_t column = 0; column < n; ++column) {
                const double stiffness =
                    op.stiffness_matrix_row_major[operator_row * n + column];
                const double omega_mass =
                    op.omega_rad_per_s * op.mass_matrix_row_major[operator_row * n + column];
                if (!imag_row) {
                    if (!push_entry(out_matrix, column, stiffness, error_message) ||
                        !push_entry(out_matrix, column + n, omega_mass, error_message)) {
                        return FrequencyDomainStatus::validation_error;
                    }
                } else {
                    if (!push_entry(out_matrix, column, -omega_mass, error_message) ||
                        !push_entry(out_matrix, column + n, stiffness, error_message)) {
                        return FrequencyDomainStatus::validation_error;
                    }
                }
            }
            out_matrix->row_offsets.push_back(
                static_cast<std::uint32_t>(out_matrix->values.size()));
        }
    } catch (...) {
        copy_error(error_message, "real-split CSR assembly allocation failed");
        return FrequencyDomainStatus::operator_error;
    }

    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
