#include "frequency_domain/real_frequency_rotated_pencil.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

namespace fd = fullmag::fem::frequency_domain;

namespace {

void check(bool condition, const char *message)
{
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

fd::CsrMatrixView view(
    const std::vector<std::uint32_t> &row_offsets,
    const std::vector<std::uint32_t> &columns,
    const std::vector<double> &values,
    std::uint64_t dimension)
{
    return fd::CsrMatrixView{
        dimension,
        dimension,
        row_offsets.data(),
        static_cast<std::uint64_t>(row_offsets.size()),
        columns.data(),
        static_cast<std::uint64_t>(columns.size()),
        values.data(),
        static_cast<std::uint64_t>(values.size())};
}

void assembles_real_frequency_rotated_signs_and_order()
{
    const std::vector<std::uint32_t> offsets{0, 2, 4};
    const std::vector<std::uint32_t> columns{0, 1, 0, 1};
    const std::vector<double> lhs_values{2.0, -3.0, 5.0, 7.0};
    const std::vector<double> mass_values{11.0, 13.0, 17.0, 19.0};
    fd::RealFrequencyRotatedPencil pencil{};
    char error[128]{};
    check(
        fd::assemble_real_frequency_rotated_pencil(
            view(offsets, columns, lhs_values, 2),
            view(offsets, columns, mass_values, 2),
            &pencil,
            error) == fd::FrequencyDomainStatus::ok,
        error);
    check(pencil.base_dimension == 2, "real-split pencil must retain the base dimension");
    check(pencil.lhs.row_count == 4 && pencil.lhs.column_count == 4,
          "real-split lhs must double both dimensions");
    check(pencil.rhs.row_count == 4 && pencil.rhs.column_count == 4,
          "real-split rhs must double both dimensions");
    check(pencil.lhs.row_offsets == std::vector<std::uint32_t>({0, 2, 4, 6, 8}),
          "real-split lhs row structure must be block diagonal");
    check(pencil.rhs.row_offsets == std::vector<std::uint32_t>({0, 2, 4, 6, 8}),
          "real-split rhs row structure must be block off diagonal");

    const std::vector<std::uint32_t> expected_lhs_columns{0, 1, 0, 1, 2, 3, 2, 3};
    const std::vector<double> expected_lhs_values{2.0, -3.0, 5.0, 7.0, 2.0, -3.0, 5.0, 7.0};
    check(pencil.lhs.column_indices == expected_lhs_columns,
          "real-split lhs must preserve columns in both halves");
    check(pencil.lhs.values == expected_lhs_values,
          "real-split lhs must preserve values in both halves");

    const std::vector<std::uint32_t> expected_rhs_columns{2, 3, 2, 3, 0, 1, 0, 1};
    const std::vector<double> expected_rhs_values{-11.0, -13.0, -17.0, -19.0, 11.0, 13.0, 17.0, 19.0};
    check(pencil.rhs.column_indices == expected_rhs_columns,
          "real-split rhs must place -B above and +B below the diagonal");
    check(pencil.rhs.values == expected_rhs_values,
          "real-split rhs must use the canonical i-rotation signs");
}

void rejects_malformed_or_nonfinite_csr()
{
    const std::vector<std::uint32_t> offsets{0, 1};
    const std::vector<std::uint32_t> columns{0};
    const std::vector<double> lhs_values{std::nan("")};
    const std::vector<double> mass_values{1.0};
    fd::RealFrequencyRotatedPencil pencil{};
    char error[128]{};
    check(
        fd::assemble_real_frequency_rotated_pencil(
            view(offsets, columns, lhs_values, 1),
            view(offsets, columns, mass_values, 1),
            &pencil,
            error) == fd::FrequencyDomainStatus::validation_error,
        "real-split pencil must reject non-finite CSR values");
    check(std::strstr(error, "finite") != nullptr,
          "real-split pencil must explain non-finite CSR rejection");
}

} // namespace

int main()
{
    assembles_real_frequency_rotated_signs_and_order();
    rejects_malformed_or_nonfinite_csr();
}
