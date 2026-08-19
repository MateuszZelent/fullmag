#include "frequency_domain/real_frequency_rotated_pencil.hpp"

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
    std::strncpy(out, message != nullptr ? message : "", 127);
    out[127] = '\0';
}

bool valid_csr(const CsrMatrixView &matrix, std::uint64_t dimension) noexcept
{
    if (matrix.row_count != dimension ||
        matrix.column_count != dimension ||
        matrix.row_offsets == nullptr ||
        matrix.row_offsets_len != dimension + 1u ||
        matrix.row_offsets[0] != 0u ||
        matrix.row_offsets[dimension] != matrix.values_len ||
        matrix.values_len > std::numeric_limits<std::uint32_t>::max()) {
        return false;
    }
    if (matrix.values_len > 0u &&
        (matrix.column_indices == nullptr || matrix.values == nullptr)) {
        return false;
    }
    for (std::uint64_t row = 0; row < dimension; ++row) {
        if (matrix.row_offsets[row] > matrix.row_offsets[row + 1u]) {
            return false;
        }
    }
    for (std::uint64_t entry = 0; entry < matrix.values_len; ++entry) {
        if (matrix.column_indices[entry] >= dimension ||
            !std::isfinite(matrix.values[entry])) {
            return false;
        }
    }
    return true;
}

bool append_entry(
    RealSplitCsrMatrix *matrix,
    std::uint64_t column,
    double value,
    char error_message[128]) noexcept
{
    if (column > std::numeric_limits<std::uint32_t>::max() ||
        matrix->values.size() >= std::numeric_limits<std::uint32_t>::max()) {
        copy_error(error_message, "real-frequency-rotated CSR index capacity exceeded");
        return false;
    }
    matrix->column_indices.push_back(static_cast<std::uint32_t>(column));
    matrix->values.push_back(value);
    return true;
}

bool append_source_row(
    const CsrMatrixView &source,
    std::uint64_t source_row,
    std::uint64_t column_offset,
    double sign,
    RealSplitCsrMatrix *destination,
    char error_message[128]) noexcept
{
    for (std::uint32_t entry = source.row_offsets[source_row];
         entry < source.row_offsets[source_row + 1u];
         ++entry) {
        if (!append_entry(
                destination,
                column_offset + source.column_indices[entry],
                sign * source.values[entry],
                error_message)) {
            return false;
        }
    }
    return true;
}

} // namespace

FrequencyDomainStatus assemble_real_frequency_rotated_pencil(
    const CsrMatrixView &lhs,
    const CsrMatrixView &mass,
    RealFrequencyRotatedPencil *out_pencil,
    char error_message[128]) noexcept
{
    if (out_pencil == nullptr) {
        copy_error(error_message, "real-frequency-rotated assembly requires an output pencil");
        return FrequencyDomainStatus::validation_error;
    }
    *out_pencil = RealFrequencyRotatedPencil{};
    if (lhs.row_count == 0 || lhs.row_count != lhs.column_count ||
        lhs.row_count != mass.row_count || mass.row_count != mass.column_count ||
        lhs.row_count > std::numeric_limits<std::uint64_t>::max() / 2u ||
        lhs.row_count > std::numeric_limits<std::uint32_t>::max() / 2u ||
        !valid_csr(lhs, lhs.row_count) || !valid_csr(mass, lhs.row_count)) {
        copy_error(error_message, "real-frequency-rotated assembly requires matching finite square CSR operators");
        return FrequencyDomainStatus::validation_error;
    }

    const std::uint64_t dimension = lhs.row_count;
    const std::uint64_t split_dimension = 2u * dimension;
    try {
        out_pencil->base_dimension = dimension;
        out_pencil->lhs.row_count = split_dimension;
        out_pencil->lhs.column_count = split_dimension;
        out_pencil->rhs.row_count = split_dimension;
        out_pencil->rhs.column_count = split_dimension;
        out_pencil->lhs.row_offsets.reserve(static_cast<std::size_t>(split_dimension + 1u));
        out_pencil->rhs.row_offsets.reserve(static_cast<std::size_t>(split_dimension + 1u));
        out_pencil->lhs.row_offsets.push_back(0u);
        out_pencil->rhs.row_offsets.push_back(0u);
        for (std::uint64_t row = 0; row < dimension; ++row) {
            if (!append_source_row(lhs, row, 0u, 1.0, &out_pencil->lhs, error_message) ||
                !append_source_row(mass, row, dimension, -1.0, &out_pencil->rhs, error_message)) {
                *out_pencil = RealFrequencyRotatedPencil{};
                return FrequencyDomainStatus::operator_error;
            }
            out_pencil->lhs.row_offsets.push_back(
                static_cast<std::uint32_t>(out_pencil->lhs.values.size()));
            out_pencil->rhs.row_offsets.push_back(
                static_cast<std::uint32_t>(out_pencil->rhs.values.size()));
        }
        for (std::uint64_t row = 0; row < dimension; ++row) {
            if (!append_source_row(lhs, row, dimension, 1.0, &out_pencil->lhs, error_message) ||
                !append_source_row(mass, row, 0u, 1.0, &out_pencil->rhs, error_message)) {
                *out_pencil = RealFrequencyRotatedPencil{};
                return FrequencyDomainStatus::operator_error;
            }
            out_pencil->lhs.row_offsets.push_back(
                static_cast<std::uint32_t>(out_pencil->lhs.values.size()));
            out_pencil->rhs.row_offsets.push_back(
                static_cast<std::uint32_t>(out_pencil->rhs.values.size()));
        }
    } catch (...) {
        *out_pencil = RealFrequencyRotatedPencil{};
        copy_error(error_message, "real-frequency-rotated assembly allocation failed");
        return FrequencyDomainStatus::operator_error;
    }
    return FrequencyDomainStatus::ok;
}

} // namespace fullmag::fem::frequency_domain
