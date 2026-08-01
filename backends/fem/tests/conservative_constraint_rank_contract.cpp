#include "cpu/mfem/transport/conservative_constraint_rank.hpp"

#include <boost/multiprecision/cpp_int.hpp>

#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <functional>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace fullmag::fem::transport::testing {

void SetConstraintRankAnalyzeResourceLimitsForTest(
    const ResourceCounts &limits);
void ResetConstraintRankAnalyzeResourceLimitsForTest();

} // namespace fullmag::fem::transport::testing

namespace {

using fullmag::fem::transport::ConservativeConstraintRank;
using fullmag::fem::transport::ConservativeConstraintRankRow;
using fullmag::fem::transport::ConservativeConstraintRankRowKind;
using fullmag::fem::transport::ConstraintOmissionReason;
using fullmag::fem::transport::ConstraintRankResourceLimitExceeded;
using fullmag::fem::transport::InconsistentDependentConstraint;
using fullmag::fem::transport::ResourceCounts;

using ElementKey = std::array<std::uint64_t, 4>;

ResourceCounts default_analyze_resource_limits()
{
    ResourceCounts limits;
    limits.rows = ConservativeConstraintRank::kMaximumRows;
    limits.distinct_columns =
        ConservativeConstraintRank::kMaximumDistinctColumns;
    limits.total_nonzeros = ConservativeConstraintRank::kMaximumNonzeros;
    limits.maximum_nonzeros_per_row =
        ConservativeConstraintRank::kMaximumColumnsPerRow;
    limits.maximum_intermediate_nonzeros =
        ConservativeConstraintRank::kMaximumIntermediateNonzeros;
    limits.intermediate_storage_bits =
        ConservativeConstraintRank::kMaximumIntermediateStorageBits;
    limits.bareiss_work_units =
        ConservativeConstraintRank::kMaximumBareissWorkUnits;
    limits.maximum_intermediate_bit_length =
        ConservativeConstraintRank::kMaximumIntermediateBitLength;
    return limits;
}

class ScopedAnalyzeResourceLimits {
public:
    explicit ScopedAnalyzeResourceLimits(const ResourceCounts &limits)
    {
        fullmag::fem::transport::testing::
            SetConstraintRankAnalyzeResourceLimitsForTest(limits);
    }

    ~ScopedAnalyzeResourceLimits()
    {
        fullmag::fem::transport::testing::
            ResetConstraintRankAnalyzeResourceLimitsForTest();
    }
};

std::uint64_t binary64_bits(double value)
{
    std::uint64_t bits = 0;
    static_assert(sizeof(bits) == sizeof(value));
    std::memcpy(&bits, &value, sizeof(bits));
    return bits;
}

void require(bool condition, const std::string &message)
{
    if (!condition) {
        throw std::runtime_error(message);
    }
}

template <typename Exception, typename Callable>
Exception require_throws(Callable &&callable, const std::string &message)
{
    try {
        std::invoke(std::forward<Callable>(callable));
    } catch (const Exception &error) {
        return error;
    }
    throw std::runtime_error(message);
}

ConservativeConstraintRankRow generic_row(
    std::string id,
    std::vector<std::uint64_t> columns,
    std::vector<std::int64_t> coefficients,
    double rhs)
{
    ConservativeConstraintRankRow row;
    row.constraint_id = std::move(id);
    row.kind = ConservativeConstraintRankRowKind::Generic;
    row.canonical_column_ids = std::move(columns);
    row.incidence_coefficients = std::move(coefficients);
    row.rhs_a = rhs;
    return row;
}

ConservativeConstraintRankRow closed_row(
    std::string id,
    ElementKey anchor,
    ElementKey element,
    std::vector<std::uint64_t> columns,
    std::vector<std::int64_t> coefficients,
    double rhs)
{
    auto row = generic_row(
        std::move(id), std::move(columns), std::move(coefficients), rhs);
    row.kind = ConservativeConstraintRankRowKind::ClosedComponentDivergence;
    row.closed_component_anchor_element = anchor;
    row.row_element_key = element;
    return row;
}

void generic_dependencies_are_certified_or_rejected_physically()
{
    const auto consistent = ConservativeConstraintRank::Analyze({
        generic_row("r3", {11, 22}, {1, 1}, 2.0),
        generic_row("r2", {22}, {1}, 1.0),
        generic_row("r1", {11}, {1}, 1.0),
    });
    require(consistent.rows_before == 3, "generic certificate lost input row count");
    require(consistent.rank == 2, "generic exact rank is not two");
    require(consistent.omitted_rows.size() == 1, "generic dependency was not omitted once");
    require(consistent.omitted_rows[0].constraint_id == "r3", "wrong generic row was omitted");
    require(consistent.omitted_rows[0].reason ==
            ConstraintOmissionReason::ConsistentLinearDependency,
        "generic omission has the wrong semantic reason");
    require(consistent.omitted_rows[0].residual_a == 0.0,
        "consistent generic dependency has nonzero residual");
    require(consistent.omitted_rows[0].closed_component_anchor_element == ElementKey{},
        "generic omission persisted closed-component metadata");

    const auto error = require_throws<InconsistentDependentConstraint>([] {
        (void)ConservativeConstraintRank::Analyze({
            generic_row("r1", {11}, {1}, 1.0),
            generic_row("r2", {22}, {1}, 1.0),
            generic_row("r3", {11, 22}, {1, 1}, 3.0),
        });
    }, "inconsistent dependent RHS was accepted");
    require(error.constraint_id() == "r3", "inconsistent dependency lost its ID");
    require(error.residual_a() == 1.0, "inconsistent dependency lost its physical residual");

    const auto within_gate = ConservativeConstraintRank::Analyze({
        generic_row("gate-base", {31}, {1}, 2.0),
        generic_row("gate-copy", {31}, {1}, 2.0 + 1.0e-12),
    });
    require(within_gate.omitted_rows.size() == 1,
        "relative physical gate rejected a legal dependent RHS");
    require(std::abs(within_gate.omitted_rows[0].residual_a - 1.0e-12) < 1.0e-15,
        "accepted dependency did not persist its physical residual");
}

void physical_gate_boundaries_are_exact_and_inclusive()
{
    constexpr double absolute_gate = 1.0e-18;
    const auto absolute_equal = ConservativeConstraintRank::Analyze({
        generic_row("absolute-base", {1}, {1}, 0.0),
        generic_row("absolute-copy", {1}, {1}, absolute_gate),
    }, absolute_gate, 0.0);
    require(absolute_equal.omitted_rows.size() == 1,
        "absolute-gate equality was not accepted");

    const double below_absolute = std::nextafter(absolute_gate, 0.0);
    const auto absolute_below = ConservativeConstraintRank::Analyze({
        generic_row("absolute-base", {1}, {1}, 0.0),
        generic_row("absolute-copy", {1}, {1}, below_absolute),
    }, absolute_gate, 0.0);
    require(absolute_below.omitted_rows.size() == 1,
        "residual below the absolute gate was not accepted");

    const double above_absolute =
        std::nextafter(absolute_gate, std::numeric_limits<double>::infinity());
    require_throws<InconsistentDependentConstraint>([&] {
        (void)ConservativeConstraintRank::Analyze({
            generic_row("absolute-base", {1}, {1}, 0.0),
            generic_row("absolute-copy", {1}, {1}, above_absolute),
        }, absolute_gate, 0.0);
    }, "residual above the absolute gate was accepted");

    const auto relative_equal = ConservativeConstraintRank::Analyze({
        generic_row("relative-base", {1}, {1}, 1.0),
        generic_row("relative-copy", {1}, {1}, 2.0),
    }, 0.0, 0.5);
    require(relative_equal.omitted_rows.size() == 1,
        "relative-gate equality was not accepted");

    const double below_relative = std::nextafter(0.5, 0.0);
    require_throws<InconsistentDependentConstraint>([&] {
        (void)ConservativeConstraintRank::Analyze({
            generic_row("relative-base", {1}, {1}, 1.0),
            generic_row("relative-copy", {1}, {1}, 2.0),
        }, 0.0, below_relative);
    }, "residual above the reduced relative gate was accepted");

    const double above_relative =
        std::nextafter(0.5, std::numeric_limits<double>::infinity());
    const auto relative_above = ConservativeConstraintRank::Analyze({
        generic_row("relative-base", {1}, {1}, 1.0),
        generic_row("relative-copy", {1}, {1}, 2.0),
    }, 0.0, above_relative);
    require(relative_above.omitted_rows.size() == 1,
        "residual below the enlarged relative gate was not accepted");

    constexpr double rhs_floor = 1.0e-30;
    const auto floor_equal = ConservativeConstraintRank::Analyze({
        generic_row("floor-base", {1}, {1}, rhs_floor),
        generic_row("floor-copy", {1}, {1}, 0.0),
    }, 0.0, 1.0);
    require(floor_equal.omitted_rows.size() == 1,
        "RHS-floor equality was not accepted");

    const double below_floor = std::nextafter(rhs_floor, 0.0);
    const auto floor_below = ConservativeConstraintRank::Analyze({
        generic_row("floor-base", {1}, {1}, below_floor),
        generic_row("floor-copy", {1}, {1}, 0.0),
    }, 0.0, 1.0);
    require(floor_below.omitted_rows.size() == 1,
        "residual below the RHS floor gate was not accepted");

    const double above_floor =
        std::nextafter(rhs_floor, std::numeric_limits<double>::infinity());
    require_throws<InconsistentDependentConstraint>([&] {
        (void)ConservativeConstraintRank::Analyze({
            generic_row("floor-base", {1}, {1}, above_floor),
            generic_row("floor-copy", {1}, {1}, 0.0),
        }, 0.0, 1.0);
    }, "residual above the RHS floor gate was accepted");
}

void persisted_residual_uses_exact_ieee_binary64_rounding()
{
    const double minimum_subnormal =
        std::numeric_limits<double>::denorm_min();

    const auto negative_half = ConservativeConstraintRank::Analyze({
        generic_row("half-base", {1}, {2}, minimum_subnormal),
        generic_row("half-copy", {1}, {1}, 0.0),
    }, minimum_subnormal, 0.0);
    require(negative_half.omitted_rows.size() == 1,
        "half-subnormal residual was not omitted");
    require(binary64_bits(negative_half.omitted_rows[0].residual_a) ==
            (std::uint64_t{1} << 63),
        "half-subnormal residual did not round to IEEE negative zero");

    const auto negative_tie = ConservativeConstraintRank::Analyze({
        generic_row("tie-base", {1}, {2}, 3.0 * minimum_subnormal),
        generic_row("tie-copy", {1}, {1}, 0.0),
    }, 2.0 * minimum_subnormal, 0.0);
    require(negative_tie.omitted_rows.size() == 1,
        "subnormal tie residual was not omitted");
    require(binary64_bits(negative_tie.omitted_rows[0].residual_a) ==
            ((std::uint64_t{1} << 63) | 2),
        "subnormal tie did not round to the even IEEE significand");

    require_throws<std::overflow_error>([&] {
        (void)ConservativeConstraintRank::Analyze({
            generic_row("overflow-base", {1}, {1},
                std::numeric_limits<double>::max()),
            generic_row("overflow-copy", {1},
                {std::numeric_limits<std::int64_t>::max()}, 0.0),
        }, std::numeric_limits<double>::max(), 0.0);
    }, "non-representable finite residual published an infinity");
}

void incremental_bareiss_handles_nonmonotonic_pivot_columns()
{
    const auto consistent = ConservativeConstraintRank::Analyze({
        generic_row("a-high-pivot", {20, 30}, {2, -3}, 2.0),
        generic_row("b-mixed-pivot", {10, 20, 30}, {2, 3, -2}, 1.0),
        generic_row("c-low-pivot", {10, 20}, {1, 1}, 0.0),
        generic_row("d-dependent", {10, 20, 30}, {3, 7, -7}, 4.0),
    });
    require(consistent.rank == 3 && consistent.omitted_rows.size() == 1 &&
            consistent.omitted_rows[0].constraint_id == "d-dependent",
        "incremental Bareiss misclassified a descending-pivot dependency");

    const auto inconsistent =
        require_throws<InconsistentDependentConstraint>([] {
            (void)ConservativeConstraintRank::Analyze({
                generic_row("a-high-pivot", {20, 30}, {2, -3}, 2.0),
                generic_row("b-mixed-pivot", {10, 20, 30}, {2, 3, -2}, 1.0),
                generic_row("c-low-pivot", {10, 20}, {1, 1}, 0.0),
                generic_row("d-dependent", {10, 20, 30}, {3, 7, -7}, 5.0),
            });
        }, "descending-pivot inconsistent dependency was classified independent");
    require(inconsistent.constraint_id() == "d-dependent" &&
            inconsistent.residual_a() == 1.0,
        "descending-pivot dependency lost its exact physical residual");
}

void closed_components_omit_only_the_deterministic_anchor_candidate()
{
    constexpr ElementKey anchor_a{1, 2, 3, 4};
    constexpr ElementKey other_a{1, 2, 3, 5};
    constexpr ElementKey anchor_b{10, 11, 12, 13};
    constexpr ElementKey other_b{10, 11, 12, 14};
    const auto certificate = ConservativeConstraintRank::Analyze({
        closed_row("z-anchor", anchor_a, anchor_a, {101}, {-1}, 0.0),
        closed_row("z-row", anchor_a, other_a, {101}, {1}, 0.0),
        closed_row("a-anchor", anchor_b, anchor_b, {202}, {-1}, 0.0),
        closed_row("a-row", anchor_b, other_b, {202}, {1}, 0.0),
    });
    require(certificate.rank == 2, "two closed components have the wrong exact rank");
    require(certificate.omitted_rows.size() == 2,
        "closed components did not omit exactly one row each");
    require(certificate.omitted_rows[0].constraint_id == "a-anchor" &&
            certificate.omitted_rows[1].constraint_id == "z-anchor",
        "omitted rows are not deterministically sorted by constraint ID");
    require(certificate.omitted_rows[0].reason ==
            ConstraintOmissionReason::ClosedComponentDivergenceDependency &&
            certificate.omitted_rows[1].reason ==
            ConstraintOmissionReason::ClosedComponentDivergenceDependency,
        "closed-component omissions have the wrong reason");
    require(certificate.omitted_rows[0].closed_component_anchor_element == anchor_b &&
            certificate.omitted_rows[1].closed_component_anchor_element == anchor_a,
        "closed-component omissions lost their semantic anchors");

    require_throws<std::runtime_error>([] {
        constexpr ElementKey anchor{1, 2, 3, 4};
        (void)ConservativeConstraintRank::Analyze({
            closed_row("anchor", anchor, anchor, {1}, {1}, 0.0),
        });
    }, "independent closed-component anchor candidate was accepted");

    require_throws<std::runtime_error>([] {
        constexpr ElementKey anchor{1, 2, 3, 4};
        constexpr ElementKey other{1, 2, 3, 5};
        (void)ConservativeConstraintRank::Analyze({
            generic_row("generic", {1}, {1}, 0.0),
            closed_row("non-anchor", anchor, other, {1}, {1}, 0.0),
            closed_row("anchor", anchor, anchor, {2}, {1}, 0.0),
        });
    }, "dependent closed-component non-anchor row was accepted");
}

void malformed_rows_and_component_metadata_are_rejected()
{
    auto expect_invalid = [](std::vector<ConservativeConstraintRankRow> rows,
                              const std::string &message) {
        require_throws<std::invalid_argument>([&] {
            (void)ConservativeConstraintRank::Analyze(rows);
        }, message);
    };

    expect_invalid({generic_row("", {1}, {1}, 0.0)}, "empty constraint ID was accepted");
    expect_invalid({
        generic_row("same", {1}, {1}, 0.0),
        generic_row("same", {2}, {1}, 0.0),
    }, "duplicate constraint IDs were accepted");
    expect_invalid({generic_row("mismatch", {1, 2}, {1}, 0.0)},
        "mismatched column and coefficient vectors were accepted");
    expect_invalid({generic_row("zero-column", {0}, {1}, 0.0)},
        "zero canonical column ID was accepted");
    expect_invalid({generic_row("unsorted", {2, 1}, {1, 1}, 0.0)},
        "unsorted canonical columns were accepted");
    expect_invalid({generic_row("duplicate-column", {1, 1}, {1, 1}, 0.0)},
        "duplicate canonical columns were accepted");
    expect_invalid({generic_row("zero-coefficient", {1}, {0}, 0.0)},
        "stored zero coefficient was accepted");
    expect_invalid({generic_row("nonfinite", {1}, {1},
        std::numeric_limits<double>::infinity())}, "non-finite RHS was accepted");

    auto generic_with_metadata = generic_row("generic-metadata", {1}, {1}, 0.0);
    generic_with_metadata.closed_component_anchor_element = {1, 2, 3, 4};
    expect_invalid({generic_with_metadata}, "generic row carried component metadata");

    constexpr ElementKey anchor{1, 2, 3, 4};
    constexpr ElementKey other{1, 2, 3, 5};
    expect_invalid({closed_row("bad-key", {0, 2, 3, 4}, {0, 2, 3, 4},
        {1}, {1}, 0.0)}, "closed row accepted a zero vertex ID");
    expect_invalid({closed_row("before-anchor", anchor, {1, 2, 3, 3},
        {1}, {1}, 0.0)}, "closed row accepted a non-increasing element key");
    expect_invalid({closed_row("no-candidate", anchor, other, {1}, {1}, 0.0)},
        "closed component without an anchor candidate was accepted");
    expect_invalid({
        closed_row("candidate", anchor, anchor, {1}, {1}, 0.0),
        closed_row("duplicate-key", anchor, anchor, {2}, {1}, 0.0),
    }, "closed component accepted duplicate row element keys");

    auto unknown = generic_row("unknown-kind", {1}, {1}, 0.0);
    unknown.kind = static_cast<ConservativeConstraintRankRowKind>(255);
    expect_invalid({unknown}, "unknown rank-row kind was accepted");

    require_throws<std::invalid_argument>([] {
        (void)ConservativeConstraintRank::Analyze({}, -1.0, 1.0e-10);
    }, "negative absolute physical gate was accepted");
    require_throws<std::invalid_argument>([] {
        (void)ConservativeConstraintRank::Analyze({}, 1.0e-18,
            std::numeric_limits<double>::quiet_NaN());
    }, "non-finite relative physical gate was accepted");
}

void every_resource_limit_accepts_the_limit_and_rejects_limit_plus_one()
{
    ResourceCounts limits;
    limits.rows = ConservativeConstraintRank::kMaximumRows;
    limits.distinct_columns = ConservativeConstraintRank::kMaximumDistinctColumns;
    limits.total_nonzeros = ConservativeConstraintRank::kMaximumNonzeros;
    limits.maximum_nonzeros_per_row = ConservativeConstraintRank::kMaximumColumnsPerRow;
    limits.maximum_intermediate_nonzeros =
        ConservativeConstraintRank::kMaximumIntermediateNonzeros;
    limits.intermediate_storage_bits =
        ConservativeConstraintRank::kMaximumIntermediateStorageBits;
    limits.bareiss_work_units = ConservativeConstraintRank::kMaximumBareissWorkUnits;
    limits.maximum_intermediate_bit_length =
        ConservativeConstraintRank::kMaximumIntermediateBitLength;
    ConservativeConstraintRank::ValidateResourceCounts(limits);

    auto expect_excess = [&](auto member, const std::string &name) {
        ResourceCounts excess = limits;
        excess.*member += 1;
        require_throws<ConstraintRankResourceLimitExceeded>([&] {
            ConservativeConstraintRank::ValidateResourceCounts(excess);
        }, name + " limit+1 was accepted");
    };
    expect_excess(&ResourceCounts::rows, "rows");
    expect_excess(&ResourceCounts::distinct_columns, "distinct columns");
    expect_excess(&ResourceCounts::total_nonzeros, "total nonzeros");
    expect_excess(&ResourceCounts::maximum_nonzeros_per_row, "nonzeros per row");
    expect_excess(&ResourceCounts::maximum_intermediate_nonzeros,
        "intermediate nonzeros");
    expect_excess(&ResourceCounts::intermediate_storage_bits,
        "intermediate storage bits");
    expect_excess(&ResourceCounts::bareiss_work_units, "Bareiss work units");
    expect_excess(&ResourceCounts::maximum_intermediate_bit_length,
        "intermediate bit length");

    std::vector<std::uint64_t> columns(
        ConservativeConstraintRank::kMaximumColumnsPerRow + 1);
    std::vector<std::int64_t> coefficients(columns.size(), 1);
    for (std::size_t index = 0; index < columns.size(); ++index) {
        columns[index] = static_cast<std::uint64_t>(index + 1);
    }
    require_throws<ConstraintRankResourceLimitExceeded>([&] {
        (void)ConservativeConstraintRank::Analyze({
            generic_row("too-wide", columns, coefficients, 0.0),
        });
    }, "Analyze did not enforce the per-row pre-allocation cap");
}

void analyze_accounts_for_transient_exact_state_and_work()
{
    auto limits = default_analyze_resource_limits();
    limits.maximum_intermediate_nonzeros = 4;
    {
        ScopedAnalyzeResourceLimits scoped(limits);
        require_throws<ConstraintRankResourceLimitExceeded>([] {
            (void)ConservativeConstraintRank::Analyze({
                generic_row("fill-basis", {1, 3}, {1, 1}, 0.0),
                generic_row("fill-row", {1, 2}, {1, 1}, 0.0),
            });
        }, "Analyze did not count dependent-row fill-in nonzeros");
    }

    limits = default_analyze_resource_limits();
    limits.intermediate_storage_bits = 6;
    {
        ScopedAnalyzeResourceLimits scoped(limits);
        require_throws<ConstraintRankResourceLimitExceeded>([] {
            (void)ConservativeConstraintRank::Analyze({
                generic_row("storage-basis", {1, 3}, {1, 1}, 0.0),
                generic_row("storage-row", {1, 2}, {1, 1}, 0.0),
            });
        }, "Analyze did not count transient aggregate storage bits");
    }

    limits = default_analyze_resource_limits();
    limits.maximum_intermediate_bit_length = 64;
    {
        ScopedAnalyzeResourceLimits scoped(limits);
        require_throws<ConstraintRankResourceLimitExceeded>([] {
            constexpr std::int64_t large =
                std::numeric_limits<std::int64_t>::max();
            (void)ConservativeConstraintRank::Analyze({
                generic_row("bits-basis", {1, 2}, {large, large}, 0.0),
                generic_row("bits-row", {1, 2}, {large - 1, large}, 0.0),
            });
        }, "Analyze did not count transient scalar bit length");
    }

    limits = default_analyze_resource_limits();
    limits.bareiss_work_units = 24;
    {
        ScopedAnalyzeResourceLimits scoped(limits);
        const auto one_row = ConservativeConstraintRank::Analyze({
            generic_row("work-basis", {1, 2}, {1, 1}, 0.0),
        });
        require(one_row.rank == 1,
            "bounded work seam rejected a single unreduced row");
        require_throws<ConstraintRankResourceLimitExceeded>([] {
            (void)ConservativeConstraintRank::Analyze({
                generic_row("work-basis", {1, 2}, {1, 1}, 0.0),
                generic_row("work-row", {1, 2}, {1, -1}, 0.0),
            });
        }, "Analyze did not count scans and row-reduction work");
    }
}

void wide_exact_determinant_cannot_overflow_or_change_rank()
{
    using boost::multiprecision::cpp_int;
    constexpr std::int64_t m = 4'000'000'000LL;
    constexpr std::int64_t c = -2'446'744'073'709'551'616LL;
    const cpp_int determinant = cpp_int(m) * cpp_int(m) - cpp_int(c);
    require(determinant == (cpp_int(1) << 64),
        "independent cpp_int oracle did not prove determinant 2^64");
    const auto certificate = ConservativeConstraintRank::Analyze({
        generic_row("wide-a", {1, 2}, {m, 1}, 3.0),
        generic_row("wide-b", {1, 2}, {c, m}, 5.0),
        generic_row("wide-sum", {1, 2}, {m + c, m + 1}, 8.0),
    });
    require(certificate.rank == 2, "2^64 exact determinant was misclassified");
    require(certificate.omitted_rows.size() == 1 &&
            certificate.omitted_rows[0].constraint_id == "wide-sum",
        "wide exact sum row was not the sole deterministic omission");
    require(certificate.omitted_rows[0].residual_a == 0.0,
        "wide exact sum row has a nonzero physical residual");
}

} // namespace

int main()
{
    try {
        generic_dependencies_are_certified_or_rejected_physically();
        physical_gate_boundaries_are_exact_and_inclusive();
        persisted_residual_uses_exact_ieee_binary64_rounding();
        incremental_bareiss_handles_nonmonotonic_pivot_columns();
        closed_components_omit_only_the_deterministic_anchor_candidate();
        malformed_rows_and_component_metadata_are_rejected();
        every_resource_limit_accepts_the_limit_and_rejects_limit_plus_one();
        analyze_accounts_for_transient_exact_state_and_work();
        wide_exact_determinant_cannot_overflow_or_change_rank();
        std::cout << "conservative constraint rank contract passed\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "conservative constraint rank contract failed: "
                  << error.what() << '\n';
        return 1;
    }
}
