#pragma once

#include "cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp"
#include "cpu/frequency_domain/poisson_airbox_modal_eigen.hpp"

#include <algorithm>
#include <cmath>
#include <complex>
#include <cstdint>
#include <limits>
#include <optional>
#include <string_view>
#include <utility>
#include <vector>

namespace fullmag::fem::frequency_domain::gpu {

struct OpenAirboxAugmentedPencil {
    PoissonAirboxSharedDomainComplexCsrMatrix complex_csr;
    std::vector<double> equilibration;
    double potential_row_scale = 0.0;
};

// Non-owning view over the original phase-reduced complex Floquet blocks.
// Their dimensions define q and phi; their values remain owned by the CPU
// shared-domain assembly result for the duration of assembly/Ritz evaluation.
struct FloquetAirboxAugmentedPencilView {
    const PoissonAirboxSharedDomainComplexCsrMatrix &a_qq;
    const PoissonAirboxSharedDomainComplexCsrMatrix &b_qq;
    const PoissonAirboxSharedDomainComplexCsrMatrix &p;
    const PoissonAirboxSharedDomainComplexCsrMatrix &a_qphi;
    const PoissonAirboxSharedDomainComplexCsrMatrix &a_phiq;
};

namespace augmented_pencil_detail {

inline bool token_is(const char *value, std::string_view expected) noexcept
{
    return value != nullptr && value == expected;
}

inline bool valid_ordered_csr(const CsrMatrixView &block, std::uint64_t rows, std::uint64_t columns) noexcept
{
    if (block.row_count != rows || block.column_count != columns || block.row_offsets == nullptr ||
        block.row_offsets_len != rows + 1 || block.row_offsets[0] != 0 ||
        block.column_indices_len != block.values_len || block.row_offsets[rows] != block.values_len ||
        (block.values_len != 0 && (block.column_indices == nullptr || block.values == nullptr))) {
        return false;
    }
    for (std::uint64_t row = 0; row < rows; ++row) {
        const auto begin = block.row_offsets[row];
        const auto end = block.row_offsets[row + 1];
        if (begin > end || end > block.values_len) {
            return false;
        }
        for (auto entry = begin; entry < end; ++entry) {
            if (block.column_indices[entry] >= columns || !std::isfinite(block.values[entry]) ||
                (entry > begin && block.column_indices[entry - 1] >= block.column_indices[entry])) {
                return false;
            }
        }
    }
    return true;
}

inline bool valid_ordered_complex_csr(
    const PoissonAirboxSharedDomainComplexCsrMatrix &block,
    std::uint64_t rows,
    std::uint64_t columns) noexcept
{
    if (block.row_count != rows || block.column_count != columns ||
        block.row_offsets.size() != rows + 1u || block.row_offsets.empty() ||
        block.row_offsets.front() != 0u ||
        block.column_indices.size() != block.values.size() ||
        block.row_offsets.back() != block.values.size()) {
        return false;
    }
    for (std::uint64_t row = 0; row < rows; ++row) {
        const auto begin = block.row_offsets[static_cast<std::size_t>(row)];
        const auto end = block.row_offsets[static_cast<std::size_t>(row + 1u)];
        if (begin > end || end > block.values.size()) {
            return false;
        }
        for (auto entry = begin; entry < end; ++entry) {
            const auto index = static_cast<std::size_t>(entry);
            const auto value = block.values[index];
            if (block.column_indices[index] >= columns ||
                !std::isfinite(value.real()) || !std::isfinite(value.imag()) ||
                (entry > begin &&
                 block.column_indices[index - 1u] >= block.column_indices[index])) {
                return false;
            }
        }
    }
    return true;
}

inline std::complex<double> complex_csr_value(
    const PoissonAirboxSharedDomainComplexCsrMatrix &matrix,
    std::uint64_t row,
    std::uint32_t column) noexcept
{
    const auto begin = matrix.column_indices.begin() +
        matrix.row_offsets[static_cast<std::size_t>(row)];
    const auto end = matrix.column_indices.begin() +
        matrix.row_offsets[static_cast<std::size_t>(row + 1u)];
    const auto found = std::lower_bound(begin, end, column);
    return found != end && *found == column
        ? matrix.values[static_cast<std::size_t>(found - matrix.column_indices.begin())]
        : std::complex<double>{};
}

inline bool complex_csr_adjoint_identity(
    const PoissonAirboxSharedDomainComplexCsrMatrix &left,
    const PoissonAirboxSharedDomainComplexCsrMatrix &right,
    double adjoint_scale) noexcept
{
    if (!std::isfinite(adjoint_scale) ||
        left.row_count != right.column_count || left.column_count != right.row_count) {
        return false;
    }
    double scale = 0.0;
    for (const auto value : left.values) {
        scale = std::max(scale, std::abs(value));
    }
    for (const auto value : right.values) {
        scale = std::max(scale, std::abs(adjoint_scale * value));
    }
    scale = std::max(scale, std::numeric_limits<double>::min());
    const double tolerance = 256.0 * std::numeric_limits<double>::epsilon() * scale;
    for (std::uint64_t row = 0; row < left.row_count; ++row) {
        for (auto entry = left.row_offsets[static_cast<std::size_t>(row)];
             entry < left.row_offsets[static_cast<std::size_t>(row + 1u)]; ++entry) {
            const auto index = static_cast<std::size_t>(entry);
            const auto column = left.column_indices[index];
            const auto expected = adjoint_scale * std::conj(complex_csr_value(right, column,
                static_cast<std::uint32_t>(row)));
            if (!std::isfinite(std::abs(left.values[index] - expected)) ||
                std::abs(left.values[index] - expected) > tolerance) {
                return false;
            }
        }
    }
    for (std::uint64_t row = 0; row < right.row_count; ++row) {
        for (auto entry = right.row_offsets[static_cast<std::size_t>(row)];
             entry < right.row_offsets[static_cast<std::size_t>(row + 1u)]; ++entry) {
            const auto index = static_cast<std::size_t>(entry);
            const auto column = right.column_indices[index];
            const auto expected = adjoint_scale * std::conj(right.values[index]);
            const auto actual = complex_csr_value(left, column, static_cast<std::uint32_t>(row));
            if (!std::isfinite(std::abs(actual - expected)) ||
                std::abs(actual - expected) > tolerance) {
                return false;
            }
        }
    }
    return true;
}

inline bool equilibrate_and_check_hermitian(OpenAirboxAugmentedPencil &pencil)
{
    auto &matrix = pencil.complex_csr;
    const auto dimension = matrix.row_count;
    auto &scales = pencil.equilibration;
    scales.resize(dimension);
    for (std::uint64_t row = 0; row < dimension; ++row) {
        double norm = 0.0;
        for (auto entry = matrix.row_offsets[row]; entry < matrix.row_offsets[row + 1]; ++entry) {
            norm += std::abs(matrix.values[entry]);
        }
        if (!std::isfinite(norm) || norm <= 0.0) {
            return false;
        }
        scales[row] = 1.0 / std::sqrt(norm);
    }
    for (std::uint64_t row = 0; row < dimension; ++row) {
        for (auto entry = matrix.row_offsets[row]; entry < matrix.row_offsets[row + 1]; ++entry) {
            auto &value = matrix.values[entry];
            value *= scales[row];
            value *= scales[matrix.column_indices[entry]];
        }
    }

    constexpr double tolerance = 128.0 * std::numeric_limits<double>::epsilon();
    for (std::uint32_t row = 0; row < dimension; ++row) {
        for (auto entry = matrix.row_offsets[row]; entry < matrix.row_offsets[row + 1]; ++entry) {
            const auto column = matrix.column_indices[entry];
            const auto first = matrix.column_indices.begin() + matrix.row_offsets[column];
            const auto last = matrix.column_indices.begin() + matrix.row_offsets[column + 1];
            const auto transposed = std::lower_bound(first, last, row);
            const auto opposite = transposed != last && *transposed == row
                ? matrix.values[transposed - matrix.column_indices.begin()]
                : std::complex<double>{};
            const double difference = std::abs(matrix.values[entry] - std::conj(opposite));
            if (!std::isfinite(difference) || difference > tolerance) {
                return false;
            }
        }
    }
    return true;
}

} // namespace augmented_pencil_detail

// Q is the native complex tangent coordinate. With s = operator_scale and
// c = shifted_mass_coefficient the magnetic block is s*A_qq - i*c*B_qq.
// Multiplying the potential rows by -s*mu0 makes the reciprocal coupling
// Hermitian and leaves the zero potential RHS unchanged. See note 0830.
inline std::optional<OpenAirboxAugmentedPencil> assemble_open_airbox_augmented_pencil(
    const PoissonAirboxEigenBlockProblem &problem,
    double operator_scale,
    double shifted_mass_coefficient,
    double mu0)
{
    using namespace augmented_pencil_detail;
    constexpr auto limit = static_cast<std::uint64_t>(std::numeric_limits<std::int32_t>::max());
    const auto q = problem.q_dof_count;
    const auto phi = problem.phi_dof_count;
    if (q == 0 || phi == 0 || phi > limit || q > limit - phi ||
        !problem.k0_only || !problem.alpha_zero_required || !problem.real_fem_blocks ||
        problem.magnetic_pair_count != 0 || problem.airbox_pair_count != 0 ||
        problem.phi_mean_weights_count != 0 ||
        !token_is(problem.demag_kind, "open_airbox_k0") ||
        !token_is(problem.outer_boundary_kind, "poisson_robin") ||
        !token_is(problem.gauge_policy, "none") ||
        !std::isfinite(operator_scale) || operator_scale <= 0.0 ||
        !std::isfinite(shifted_mass_coefficient) || !std::isfinite(mu0) || mu0 <= 0.0 ||
        !valid_ordered_csr(problem.A_qq, q, q) || !valid_ordered_csr(problem.B_qq, q, q) ||
        !valid_ordered_csr(problem.A_qphi, q, phi) || !valid_ordered_csr(problem.A_phiq, phi, q) ||
        !valid_ordered_csr(problem.A_phiphi, phi, phi)) {
        return std::nullopt;
    }

    OpenAirboxAugmentedPencil result;
    result.potential_row_scale = -operator_scale * mu0;
    if (!std::isfinite(result.potential_row_scale) || result.potential_row_scale == 0.0) {
        return std::nullopt;
    }
    auto &matrix = result.complex_csr;
    matrix.row_count = matrix.column_count = q + phi;
    matrix.row_offsets.reserve(q + phi + 1);
    matrix.row_offsets.push_back(0);

    const auto append = [&matrix](std::uint32_t column, std::complex<double> value) {
        if (value != std::complex<double>{}) {
            matrix.column_indices.push_back(column);
            matrix.values.push_back(value);
        }
    };
    const auto append_real_row = [&append](
        const CsrMatrixView &block, std::uint64_t row, std::uint32_t offset, double scale) {
        for (auto entry = block.row_offsets[row]; entry < block.row_offsets[row + 1]; ++entry) {
            append(offset + block.column_indices[entry], scale * block.values[entry]);
        }
    };
    const auto commit_row = [&] {
        if (matrix.values.size() > limit) {
            return false;
        }
        matrix.row_offsets.push_back(static_cast<std::uint32_t>(matrix.values.size()));
        return true;
    };
    const auto &a = problem.A_qq;
    const auto &b = problem.B_qq;
    const auto q_offset = static_cast<std::uint32_t>(q);
    for (std::uint64_t row = 0; row < q; ++row) {
        auto ai = a.row_offsets[row];
        auto bi = b.row_offsets[row];
        const auto a_end = a.row_offsets[row + 1];
        const auto b_end = b.row_offsets[row + 1];
        while (ai < a_end || bi < b_end) {
            const auto ac = ai < a_end ? a.column_indices[ai] : q_offset;
            const auto bc = bi < b_end ? b.column_indices[bi] : q_offset;
            const auto column = std::min(ac, bc);
            const double real = ac == column ? operator_scale * a.values[ai++] : 0.0;
            const double imaginary = bc == column ? -shifted_mass_coefficient * b.values[bi++] : 0.0;
            append(column, {real, imaginary});
        }
        append_real_row(problem.A_qphi, row, q_offset, operator_scale);
        if (!commit_row()) {
            return std::nullopt;
        }
    }
    for (std::uint64_t row = 0; row < phi; ++row) {
        append_real_row(problem.A_phiq, row, 0, result.potential_row_scale);
        append_real_row(problem.A_phiphi, row, q_offset, result.potential_row_scale);
        if (!commit_row()) {
            return std::nullopt;
        }
    }
    if (!equilibrate_and_check_hermitian(result)) {
        return std::nullopt;
    }
    return result;
}

// Assemble the phase-reduced Floquet shift directly from the five original
// complex CSR blocks. No dense Schur complement is formed. The original
// blocks are independently checked before the Hermitian CSR is equilibrated.
inline std::optional<OpenAirboxAugmentedPencil> assemble_floquet_airbox_augmented_pencil(
    const FloquetAirboxAugmentedPencilView &blocks,
    double operator_scale,
    double shifted_mass_coefficient,
    double mu0)
{
    using namespace augmented_pencil_detail;
    constexpr auto limit = static_cast<std::uint64_t>(std::numeric_limits<std::int32_t>::max());
    const auto q = blocks.a_qq.row_count;
    const auto phi = blocks.p.row_count;
    if (q == 0u || phi == 0u || q > limit || phi > limit - q ||
        !std::isfinite(operator_scale) || operator_scale <= 0.0 ||
        !std::isfinite(shifted_mass_coefficient) || !std::isfinite(mu0) || mu0 <= 0.0 ||
        !valid_ordered_complex_csr(blocks.a_qq, q, q) ||
        !valid_ordered_complex_csr(blocks.b_qq, q, q) ||
        !valid_ordered_complex_csr(blocks.p, phi, phi) ||
        !valid_ordered_complex_csr(blocks.a_qphi, q, phi) ||
        !valid_ordered_complex_csr(blocks.a_phiq, phi, q) ||
        !complex_csr_adjoint_identity(blocks.a_qq, blocks.a_qq, 1.0) ||
        !complex_csr_adjoint_identity(blocks.b_qq, blocks.b_qq, -1.0) ||
        !complex_csr_adjoint_identity(blocks.p, blocks.p, 1.0) ||
        !complex_csr_adjoint_identity(blocks.a_qphi, blocks.a_phiq, -mu0)) {
        return std::nullopt;
    }

    OpenAirboxAugmentedPencil result;
    result.potential_row_scale = -operator_scale * mu0;
    if (!std::isfinite(result.potential_row_scale) || result.potential_row_scale == 0.0) {
        return std::nullopt;
    }
    auto &matrix = result.complex_csr;
    matrix.row_count = matrix.column_count = q + phi;
    matrix.row_offsets.reserve(static_cast<std::size_t>(q + phi + 1u));
    matrix.row_offsets.push_back(0u);

    const auto append = [&matrix](std::uint32_t column, std::complex<double> value) {
        if (value != std::complex<double>{}) {
            matrix.column_indices.push_back(column);
            matrix.values.push_back(value);
        }
    };
    const auto append_complex_row = [&append](
        const PoissonAirboxSharedDomainComplexCsrMatrix &block,
        std::uint64_t row,
        std::uint32_t column_offset,
        double scale) {
        for (auto entry = block.row_offsets[static_cast<std::size_t>(row)];
             entry < block.row_offsets[static_cast<std::size_t>(row + 1u)]; ++entry) {
            const auto index = static_cast<std::size_t>(entry);
            append(column_offset + block.column_indices[index], scale * block.values[index]);
        }
    };
    const auto commit_row = [&matrix] {
        if (matrix.values.size() > static_cast<std::size_t>(std::numeric_limits<std::uint32_t>::max())) {
            return false;
        }
        matrix.row_offsets.push_back(static_cast<std::uint32_t>(matrix.values.size()));
        return true;
    };

    const auto q_offset = static_cast<std::uint32_t>(q);
    const std::complex<double> minus_i_shift(0.0, -shifted_mass_coefficient);
    for (std::uint64_t row = 0; row < q; ++row) {
        auto ai = blocks.a_qq.row_offsets[static_cast<std::size_t>(row)];
        auto bi = blocks.b_qq.row_offsets[static_cast<std::size_t>(row)];
        const auto a_end = blocks.a_qq.row_offsets[static_cast<std::size_t>(row + 1u)];
        const auto b_end = blocks.b_qq.row_offsets[static_cast<std::size_t>(row + 1u)];
        while (ai < a_end || bi < b_end) {
            const auto ac = ai < a_end ? blocks.a_qq.column_indices[static_cast<std::size_t>(ai)] : q_offset;
            const auto bc = bi < b_end ? blocks.b_qq.column_indices[static_cast<std::size_t>(bi)] : q_offset;
            const auto column = std::min(ac, bc);
            std::complex<double> value{};
            if (ac == column) {
                value += operator_scale * blocks.a_qq.values[static_cast<std::size_t>(ai++)];
            }
            if (bc == column) {
                value += minus_i_shift * blocks.b_qq.values[static_cast<std::size_t>(bi++)];
            }
            append(column, value);
        }
        append_complex_row(blocks.a_qphi, row, q_offset, operator_scale);
        if (!commit_row()) {
            return std::nullopt;
        }
    }
    for (std::uint64_t row = 0; row < phi; ++row) {
        append_complex_row(blocks.a_phiq, row, 0u, result.potential_row_scale);
        append_complex_row(blocks.p, row, q_offset, result.potential_row_scale);
        if (!commit_row()) {
            return std::nullopt;
        }
    }
    if (!equilibrate_and_check_hermitian(result)) {
        return std::nullopt;
    }
    return result;
}

} // namespace fullmag::fem::frequency_domain::gpu
