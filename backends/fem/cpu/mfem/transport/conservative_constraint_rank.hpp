#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace fullmag::fem::transport {

enum class ConservativeConstraintRankRowKind : std::uint8_t {
    Generic = 1,
    ClosedComponentDivergence = 2,
};

enum class ConstraintOmissionReason : std::uint8_t {
    ClosedComponentDivergenceDependency = 1,
    ConsistentLinearDependency = 2,
};

struct ConservativeConstraintRankRow {
    std::string constraint_id;
    ConservativeConstraintRankRowKind kind =
        ConservativeConstraintRankRowKind::Generic;
    std::array<std::uint64_t, 4> closed_component_anchor_element{};
    std::array<std::uint64_t, 4> row_element_key{};
    std::vector<std::uint64_t> canonical_column_ids;
    std::vector<std::int64_t> incidence_coefficients;
    double rhs_a = 0.0;
};

struct ConstraintRankOmittedRow {
    std::string constraint_id;
    ConstraintOmissionReason reason =
        ConstraintOmissionReason::ConsistentLinearDependency;
    double residual_a = 0.0;
    std::array<std::uint64_t, 4> closed_component_anchor_element{};
};

struct ConstraintRankCertificate {
    std::uint64_t rows_before = 0;
    std::uint64_t rank = 0;
    std::vector<ConstraintRankOmittedRow> omitted_rows;
};

class InconsistentDependentConstraint : public std::runtime_error {
public:
    InconsistentDependentConstraint(
        std::string constraint_id,
        double residual_a,
        const std::string &message);

    const std::string &constraint_id() const noexcept;
    double residual_a() const noexcept;

private:
    std::string constraint_id_;
    double residual_a_ = 0.0;
};

class ConstraintRankResourceLimitExceeded : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

struct ResourceCounts {
    std::uint64_t rows = 0;
    std::uint64_t distinct_columns = 0;
    std::uint64_t total_nonzeros = 0;
    std::uint64_t maximum_nonzeros_per_row = 0;
    std::uint64_t maximum_intermediate_nonzeros = 0;
    std::uint64_t intermediate_storage_bits = 0;
    std::uint64_t bareiss_work_units = 0;
    std::uint64_t maximum_intermediate_bit_length = 0;
};

class ConservativeConstraintRank {
public:
    static constexpr std::size_t kMaximumRows = 1u << 20;
    static constexpr std::size_t kMaximumDistinctColumns = 1u << 20;
    static constexpr std::size_t kMaximumNonzeros = 1u << 24;
    static constexpr std::size_t kMaximumColumnsPerRow = 4096;
    static constexpr std::uint64_t kMaximumIntermediateNonzeros =
        std::uint64_t{1} << 24;
    static constexpr std::uint64_t kMaximumIntermediateStorageBits =
        std::uint64_t{1} << 31;
    static constexpr std::uint64_t kMaximumBareissWorkUnits =
        std::uint64_t{1} << 32;
    static constexpr std::uint64_t kMaximumIntermediateBitLength =
        std::uint64_t{1} << 20;

    static void ValidateResourceCounts(const ResourceCounts &counts);
    static ConstraintRankCertificate Analyze(
        const std::vector<ConservativeConstraintRankRow> &rows,
        double physical_absolute_gate_a = 1.0e-18,
        double physical_relative_gate = 1.0e-10);
};

} // namespace fullmag::fem::transport
