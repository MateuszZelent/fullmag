#include "cpu/mfem/transport/conservative_constraint_rank.hpp"
#include "cpu/mfem/transport/affine_trace_relations.hpp"
#include "cpu/mfem/transport/conservative_current_view.hpp"
#include "cpu/mfem/transport/periodic_charge_potential.hpp"
#include "cpu/mfem/transport/terminal_constrained_rt0_projection.hpp"
#include "cpu/mfem/workflows/antenna_field_solve/charge_trace_workspace.hpp"
#include "cpu/mfem/workflows/antenna_field_solve/charge_current_response.hpp"
#include "cpu/mfem/workflows/antenna_field_solve/charge_control_nullspace_rank.hpp"
#include "cpu/mfem/workflows/antenna_field_solve/charge_terminal_current_constraints.hpp"
#include "cpu/mfem/workflows/antenna_field_solve/accepted_terminal_charge_source.hpp"
#include "cpu/mfem/workflows/antenna_field_solve/accepted_external_lead_source.hpp"

#include <mfem.hpp>

#include <boost/multiprecision/cpp_int.hpp>

#include <algorithm>
#include <atomic>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <fstream>
#include <functional>
#include <initializer_list>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <numeric>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <tuple>
#include <thread>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

namespace {

using fullmag::fem::transport::CanonicalFaceFluxRecord;
using fullmag::fem::transport::ClosedGeometryCurrentClosure;
using fullmag::fem::transport::ConservativeConstraintRank;
using fullmag::fem::transport::ConservativeConstraintRankRow;
using fullmag::fem::transport::ConservativeConstraintRankRowKind;
using fullmag::fem::transport::ConservativeCurrentBoundaryFace;
using fullmag::fem::transport::ConservativeCurrentBoundaryRole;
using fullmag::fem::transport::ConservativeCurrentBuildRequest;
using fullmag::fem::transport::ConservativeCurrentIdentity;
using fullmag::fem::transport::ConservativeCurrentIdentityInput;
using fullmag::fem::transport::ConservativeCurrentImportRequest;
using fullmag::fem::transport::ConservativeCurrentPins;
using fullmag::fem::transport::ConservativeCurrentView;
using fullmag::fem::transport::ConservativeCurrentViewOwner;
using fullmag::fem::transport::ConstraintOmissionReason;
using fullmag::fem::transport::ConstraintRankResourceLimitExceeded;
using fullmag::fem::transport::ResourceCounts;
using fullmag::fem::transport::InconsistentDependentConstraint;
using fullmag::fem::transport::ExternalLeadExtensionCurrentClosure;
using fullmag::fem::transport::ExternalLeadInterfacePair;
using fullmag::fem::transport::PeriodicCurrentSourceCut;
using fullmag::fem::transport::PeriodicCurrentSourceCutFacePair;
using fullmag::fem::transport::PeriodicChargePotentialSolveRequest;
using fullmag::fem::transport::PeriodicChargePotentialSnapshot;
using fullmag::fem::transport::PeriodicChargePotentialSolver;
using fullmag::fem::transport::StableMeshVertexIdentities;

constexpr double kAbsoluteCurrentToleranceA = 1.0e-12;
static_assert(std::numeric_limits<double>::is_iec559,
    "OE-T0 canonical f64 ABI requires IEC 60559 / IEEE-754 binary64");
static_assert(sizeof(double) == 8,
    "OE-T0 canonical f64 ABI requires eight-byte binary64");
static_assert(static_cast<uint8_t>(ConservativeConstraintRankRowKind::Generic) == 1 &&
        static_cast<uint8_t>(ConservativeConstraintRankRowKind::ClosedComponentDivergence) == 2,
    "constraint-rank row-kind ABI codes changed");
static_assert(static_cast<uint8_t>(ConstraintOmissionReason::ClosedComponentDivergenceDependency) == 1 &&
        static_cast<uint8_t>(ConstraintOmissionReason::ConsistentLinearDependency) == 2,
    "constraint-rank omission-reason ABI codes changed");
static_assert(std::is_same_v<
        decltype(ConservativeCurrentView::Build(
            std::declval<const ConservativeCurrentBuildRequest &>())),
        ConservativeCurrentView::Ptr>,
    "Build must return the immutable owned Ptr contract");
static_assert(std::is_same_v<
        decltype(ConservativeCurrentView::Import(
            std::declval<const ConservativeCurrentImportRequest &>())),
        ConservativeCurrentView::Ptr>,
    "Import must return the immutable owned Ptr contract");
static_assert(!std::is_default_constructible_v<ConservativeCurrentView>,
    "ConservativeCurrentView construction must remain private");
static_assert(!std::is_copy_constructible_v<ConservativeCurrentViewOwner> &&
        !std::is_copy_assignable_v<ConservativeCurrentViewOwner> &&
        !std::is_move_constructible_v<ConservativeCurrentViewOwner> &&
        !std::is_move_assignable_v<ConservativeCurrentViewOwner>,
    "the non-owning visualization owner must be neither copied nor moved");

void require(bool condition, const std::string &message)
{
    if (!condition) {
        throw std::runtime_error(message);
    }
}

template <typename Callable>
void require_rejected(Callable &&callable, const std::string &message)
{
    bool rejected = false;
    try {
        callable();
    } catch (const std::invalid_argument &) {
        rejected = true;
    } catch (const std::runtime_error &) {
        rejected = true;
    }
    require(rejected, message);
}

void affine_trace_relations_preserve_independent_jumps_and_reject_cycles()
{
    using fullmag::fem::transport::AffineTraceRelation;
    using fullmag::fem::transport::reduce_affine_trace_relations;
    const std::vector<AffineTraceRelation> relations{
        {0, 1, 2.0, "cut-a"}, {1, 2, -0.5, "cut-b"},
        {0, 2, 1.5, "consistent-cycle"}, {3, 4, -1.0e-4, "small-return"},
        {2, 2, 0.0, "identity"}};
    const auto reduction = reduce_affine_trace_relations(6, relations, 1.0e-18, 1.0e-12);
    require(reduction.reduced_size == 3 &&
            reduction.full_to_reduced == std::vector<int>({0, 0, 0, 1, 1, 2}),
        "affine trace quotient merged disconnected or unconstrained dofs");
    require(reduction.lift_v == std::vector<double>({0.0, 2.0, 1.5, 0.0, -1.0e-4, 0.0}),
        "affine trace lift lost signed independent jumps");
    auto permuted = relations;
    std::reverse(permuted.begin(), permuted.end());
    const auto reordered = reduce_affine_trace_relations(6, permuted, 1.0e-18, 1.0e-12);
    require(reordered.full_to_reduced == reduction.full_to_reduced &&
            reordered.lift_v == reduction.lift_v,
        "exact affine relations changed under relation permutation");
    auto inconsistent = relations;
    inconsistent[2].potential_jump_v = 1.6;
    require_rejected([&] {
        reduce_affine_trace_relations(6, inconsistent, 1.0e-18, 1.0e-12);
    }, "inconsistent affine cycle was accepted");
    inconsistent = relations;
    inconsistent.push_back({3, 4, 1.0e-4, "reversed-small-return"});
    require_rejected([&] {
        reduce_affine_trace_relations(6, inconsistent, 1.0e-18, 1.0e-12);
    }, "large component masked an inconsistent small jump");
    require_rejected([&] {
        reduce_affine_trace_relations(2, {{1, 1, 1.0, "self-jump"}}, 0.0, 0.0);
    }, "nonzero self jump was accepted");
    require_rejected([&] {
        reduce_affine_trace_relations(3,
            {{0, 1, 1.0e20, "large"}, {1, 2, 1.0e-4, "unrepresentable-small"}},
            1.0e-18, 1.0e-12);
    }, "unrepresentable canonical double lift silently lost a small jump");
    for (const auto &bad : std::vector<AffineTraceRelation>{
             {-1, 1, 1.0, "negative"}, {0, 6, 1.0, "out-of-range"},
             {0, 1, std::numeric_limits<double>::infinity(), "infinite"},
             {0, 1, 1.0, ""}}) {
        require_rejected([&] {
            reduce_affine_trace_relations(6, {bad}, 1.0e-18, 1.0e-12);
        }, "malformed affine trace relation was accepted");
    }
    const auto isolated = reduce_affine_trace_relations(3, {}, 0.0, 0.0);
    require(isolated.reduced_size == 3 && isolated.lift_v == std::vector<double>(3, 0.0),
        "empty trace relations fabricated connectivity or voltage");
}

ConservativeConstraintRankRow rank_row(
    std::string id,
    std::initializer_list<uint64_t> column_ids,
    std::initializer_list<int64_t> coefficients,
    double rhs_a)
{
    ConservativeConstraintRankRow row;
    row.constraint_id = std::move(id);
    row.kind = ConservativeConstraintRankRowKind::Generic;
    row.closed_component_anchor_element = {0, 0, 0, 0};
    row.row_element_key = {0, 0, 0, 0};
    row.canonical_column_ids.assign(column_ids.begin(), column_ids.end());
    row.incidence_coefficients.assign(coefficients.begin(), coefficients.end());
    row.rhs_a = rhs_a;
    return row;
}

ConservativeConstraintRankRow closed_component_rank_row(
    std::string id,
    std::array<uint64_t, 4> anchor,
    std::array<uint64_t, 4> row_element_key,
    std::initializer_list<uint64_t> column_ids,
    std::initializer_list<int64_t> coefficients,
    double rhs_a)
{
    auto row = rank_row(std::move(id), column_ids, coefficients, rhs_a);
    row.kind = ConservativeConstraintRankRowKind::ClosedComponentDivergence;
    row.closed_component_anchor_element = anchor;
    row.row_element_key = row_element_key;
    return row;
}

void deterministic_constraint_rank_oracle_is_exact()
{
    const std::vector<ConservativeConstraintRankRow> consistent{
        rank_row("r1", {101}, {1}, 1.0),
        rank_row("r2", {202}, {1}, 1.0),
        rank_row("r3", {101, 202}, {1, 1}, 2.0),
    };
    const auto certificate = ConservativeConstraintRank::Analyze(consistent);
    require(certificate.rows_before == 3 && certificate.rank == 2 &&
            certificate.omitted_rows.size() == 1,
        "deterministic integer-incidence rank oracle returned the wrong rank");
    const auto &omitted = certificate.omitted_rows.front();
    require(omitted.constraint_id == "r3" &&
            omitted.reason ==
                ConstraintOmissionReason::ConsistentLinearDependency &&
            std::abs(omitted.residual_a) <= 1.0e-12,
        "rank oracle did not deterministically omit/certify exactly r3");

    auto inconsistent = consistent;
    inconsistent.back().rhs_a = 3.0;
    bool typed_rejection = false;
    try {
        (void)ConservativeConstraintRank::Analyze(inconsistent);
    } catch (const InconsistentDependentConstraint &error) {
        typed_rejection = error.constraint_id() == "r3" &&
            std::abs(error.residual_a() - 1.0) <= 1.0e-12;
    }
    require(typed_rejection,
        "inconsistent dependent rhs did not raise typed r3 rank rejection");
}

void constraint_rank_row_semantics_are_explicit_and_validated()
{
    const std::array<uint64_t, 4> anchor{11, 13, 17, 19};
    const std::array<uint64_t, 4> non_anchor{23, 29, 31, 37};
    const std::vector<ConservativeConstraintRankRow> rows{
        closed_component_rank_row(
            "a-anchor-id-sorts-first", anchor, anchor, {101}, {1}, 4.0),
        closed_component_rank_row(
            "z-non-anchor-id-sorts-last", anchor, non_anchor,
            {101}, {1}, 4.0),
    };
    const auto certificate = ConservativeConstraintRank::Analyze(rows);
    require(certificate.omitted_rows.size() == 1 &&
            certificate.omitted_rows.front().constraint_id ==
                "a-anchor-id-sorts-first" &&
            certificate.omitted_rows.front().reason ==
                ConstraintOmissionReason::ClosedComponentDivergenceDependency &&
            certificate.omitted_rows.front().closed_component_anchor_element == anchor,
        "closed-component candidate was not processed after non-candidate rows solely from frozen metadata");

    auto generic_with_anchor = rank_row("generic-with-anchor", {101}, {1}, 0.0);
    generic_with_anchor.closed_component_anchor_element = anchor;
    auto generic_with_row_key = rank_row("generic-with-row-key", {101}, {1}, 0.0);
    generic_with_row_key.row_element_key = anchor;
    auto closed_zero_anchor = closed_component_rank_row(
        "closed-zero", {0, 0, 0, 0}, {0, 0, 0, 0}, {101}, {1}, 0.0);
    auto closed_unsorted_anchor = closed_component_rank_row(
        "closed-unsorted", {11, 17, 13, 19}, anchor, {101}, {1}, 0.0);
    auto closed_duplicate_anchor = closed_component_rank_row(
        "closed-duplicate", {11, 13, 13, 19}, anchor, {101}, {1}, 0.0);
    auto closed_unsorted_row_key = closed_component_rank_row(
        "closed-unsorted-row", anchor, {23, 31, 29, 37}, {101}, {1}, 0.0);
    auto row_before_anchor = closed_component_rank_row(
        "row-before-anchor", non_anchor, anchor, {101}, {1}, 0.0);
    auto missing_candidate = closed_component_rank_row(
        "missing-candidate", anchor, non_anchor, {101}, {1}, 0.0);
    auto duplicate_candidate_a = closed_component_rank_row(
        "duplicate-candidate-a", anchor, anchor, {101}, {1}, 0.0);
    auto duplicate_candidate_b = closed_component_rank_row(
        "duplicate-candidate-b", anchor, anchor, {202}, {1}, 0.0);
    auto duplicate_component_row_a = closed_component_rank_row(
        "duplicate-component-row-a", anchor, non_anchor, {101}, {1}, 0.0);
    auto duplicate_component_row_b = closed_component_rank_row(
        "duplicate-component-row-b", anchor, non_anchor, {202}, {1}, 0.0);
    auto unknown_zero = rank_row("unknown-zero", {101}, {1}, 0.0);
    unknown_zero.kind = static_cast<ConservativeConstraintRankRowKind>(0);
    auto unknown_255 = rank_row("unknown-255", {101}, {1}, 0.0);
    unknown_255.kind = static_cast<ConservativeConstraintRankRowKind>(255);
    const std::vector<std::vector<ConservativeConstraintRankRow>> invalid_cases{
        {generic_with_anchor}, {generic_with_row_key}, {closed_zero_anchor},
        {closed_unsorted_anchor}, {closed_duplicate_anchor},
        {closed_unsorted_row_key}, {row_before_anchor}, {missing_candidate},
        {duplicate_candidate_a, duplicate_candidate_b},
        {duplicate_candidate_a, duplicate_component_row_a,
            duplicate_component_row_b},
        {unknown_zero}, {unknown_255},
    };
    for (const auto &invalid : invalid_cases) {
        require_rejected([&] {
            (void)ConservativeConstraintRank::Analyze(invalid);
        }, "constraint rank accepted invalid row-kind/component metadata");
    }
}

void constraint_rank_resource_limits_are_bounded_without_large_fixtures()
{
    const ResourceCounts at_limit{
        ConservativeConstraintRank::kMaximumRows,
        ConservativeConstraintRank::kMaximumDistinctColumns,
        ConservativeConstraintRank::kMaximumNonzeros,
        ConservativeConstraintRank::kMaximumColumnsPerRow,
        ConservativeConstraintRank::kMaximumIntermediateNonzeros,
        ConservativeConstraintRank::kMaximumIntermediateStorageBits,
        ConservativeConstraintRank::kMaximumBareissWorkUnits,
        ConservativeConstraintRank::kMaximumIntermediateBitLength,
    };
    ConservativeConstraintRank::ValidateResourceCounts(at_limit);

    const auto expect_resource_rejection = [&](ResourceCounts counts,
                                               const std::string &name) {
        bool typed = false;
        try {
            ConservativeConstraintRank::ValidateResourceCounts(counts);
        } catch (const ConstraintRankResourceLimitExceeded &) {
            typed = true;
        }
        require(typed, "resource-count seam accepted limit+1 for " + name);
    };
    auto over = at_limit;
    over.rows = ConservativeConstraintRank::kMaximumRows + uint64_t{1};
    expect_resource_rejection(over, "rows");
    over = at_limit;
    over.distinct_columns = ConservativeConstraintRank::kMaximumDistinctColumns + uint64_t{1};
    expect_resource_rejection(over, "distinct columns");
    over = at_limit;
    over.total_nonzeros = ConservativeConstraintRank::kMaximumNonzeros + uint64_t{1};
    expect_resource_rejection(over, "total nonzeros");
    over = at_limit;
    over.maximum_nonzeros_per_row = ConservativeConstraintRank::kMaximumColumnsPerRow + uint64_t{1};
    expect_resource_rejection(over, "row nonzeros");
    over = at_limit;
    over.maximum_intermediate_nonzeros =
        ConservativeConstraintRank::kMaximumIntermediateNonzeros + uint64_t{1};
    expect_resource_rejection(over, "intermediate nonzeros");
    over = at_limit;
    over.intermediate_storage_bits =
        ConservativeConstraintRank::kMaximumIntermediateStorageBits + uint64_t{1};
    expect_resource_rejection(over, "intermediate storage bits");
    over = at_limit;
    over.bareiss_work_units = ConservativeConstraintRank::kMaximumBareissWorkUnits + uint64_t{1};
    expect_resource_rejection(over, "Bareiss work");
    over = at_limit;
    over.maximum_intermediate_bit_length =
        ConservativeConstraintRank::kMaximumIntermediateBitLength + uint64_t{1};
    expect_resource_rejection(over, "intermediate bit length");
}

double frozen_rhs_gate(double rhs_a, double absolute_gate_a, double relative_gate)
{
    return std::max(absolute_gate_a,
        relative_gate * std::max(std::abs(rhs_a), 1.0e-30));
}

void constraint_rank_handles_wide_exact_arithmetic_and_physical_rhs_gate()
{
    constexpr int64_t m = 4'000'000'000LL;
    constexpr int64_t c = -2'446'744'073'709'551'616LL;
    const std::vector<ConservativeConstraintRankRow> overflow_witness{
        rank_row("wide-r1", {101, 202}, {m, 1}, 1.0),
        rank_row("wide-r2", {101, 202}, {c, m}, 1.0),
        rank_row("wide-r3", {101, 202}, {m + c, m + 1}, 2.0),
    };
    const auto wide = ConservativeConstraintRank::Analyze(overflow_witness);
    require(wide.rows_before == 3 && wide.rank == 2 &&
            wide.omitted_rows.size() == 1 &&
            wide.omitted_rows.front().constraint_id == "wide-r3" &&
            wide.omitted_rows.front().reason ==
                ConstraintOmissionReason::ConsistentLinearDependency &&
            wide.omitted_rows.front().residual_a == 0.0,
        "cpp_int Bareiss did not survive determinant magnitude above INT64_MAX");
    const boost::multiprecision::cpp_int determinant =
        boost::multiprecision::cpp_int(m) * m - c;
    require(determinant == (boost::multiprecision::cpp_int(1) << 64),
        "overflow witness determinant is not exactly 2^64");

    constexpr double abs_gate = 1.0e-18;
    constexpr double rel_gate = 1.0e-10;
    const auto exercise_gate = [&](const std::string &name, double base_rhs,
                                   double residual, bool expect_inside) {
        std::vector<ConservativeConstraintRankRow> rows{
            rank_row(name + "-r1", {101}, {1}, base_rhs),
            rank_row(name + "-r2", {101}, {1}, base_rhs + residual),
        };
        const double expected_residual =
            rows.back().rhs_a - rows.front().rhs_a;
        const double subtraction_tolerance =
            std::numeric_limits<double>::epsilon() *
            std::max({std::abs(rows.front().rhs_a),
                std::abs(rows.back().rhs_a), 1.0e-30});
        const double gate = frozen_rhs_gate(
            rows.back().rhs_a, abs_gate, rel_gate);
        require((std::abs(expected_residual) <= gate) == expect_inside,
            "test vector does not sit on the intended side of the frozen gate");
        if (expect_inside) {
            const auto certificate = ConservativeConstraintRank::Analyze(
                rows, abs_gate, rel_gate);
            require(certificate.omitted_rows.size() == 1 &&
                    std::abs(certificate.omitted_rows.front().residual_a -
                        expected_residual) <= subtraction_tolerance,
                "inside-gate dependent residual was not persisted exactly");
        } else {
            bool typed = false;
            try {
                (void)ConservativeConstraintRank::Analyze(rows, abs_gate, rel_gate);
            } catch (const InconsistentDependentConstraint &error) {
                typed = error.constraint_id() == name + "-r2" &&
                    std::abs(error.residual_a() - expected_residual) <=
                        subtraction_tolerance;
            }
            require(typed, "outside-gate residual did not fail closed with typed evidence");
        }
    };
    exercise_gate("absolute-inside", 0.0, 0.5e-18, true);
    exercise_gate("absolute-outside", 0.0, 2.0e-18, false);
    exercise_gate("relative-inside", 1.0, 0.5e-10, true);
    exercise_gate("relative-outside", 1.0, 2.0e-10, false);
}

void deterministic_constraint_rank_rejects_malformed_rows()
{
    const auto valid = rank_row("valid", {101}, {1}, 1.0);
    struct RejectionCase {
        std::string name;
        std::vector<ConservativeConstraintRankRow> rows;
    };
    auto empty_id = valid;
    empty_id.constraint_id.clear();
    auto unsorted = rank_row("unsorted", {202, 101}, {1, 1}, 1.0);
    auto duplicate_columns = rank_row("duplicate-columns", {101, 101},
        {1, -1}, 0.0);
    auto mismatch = rank_row("mismatch", {101, 202}, {1}, 1.0);
    auto zero = rank_row("zero", {101}, {0}, 0.0);
    auto nonfinite = valid;
    nonfinite.constraint_id = "nonfinite";
    nonfinite.rhs_a = std::numeric_limits<double>::quiet_NaN();
    auto capped = valid;
    capped.constraint_id = "cap-overflow";
    capped.canonical_column_ids.resize(
        ConservativeConstraintRank::kMaximumColumnsPerRow + 1);
    capped.incidence_coefficients.resize(
        ConservativeConstraintRank::kMaximumColumnsPerRow + 1, 1);
    std::iota(capped.canonical_column_ids.begin(),
        capped.canonical_column_ids.end(), uint64_t{1});
    const std::vector<RejectionCase> cases{
        {"empty id", {empty_id}},
        {"duplicate id", {valid, valid}},
        {"unsorted columns", {unsorted}},
        {"duplicate columns", {duplicate_columns}},
        {"sizes mismatch", {mismatch}},
        {"zero coefficient", {zero}},
        {"nonfinite rhs", {nonfinite}},
        {"cap overflow", {capped}},
    };
    for (const auto &entry : cases) {
        require_rejected([&] {
            (void)ConservativeConstraintRank::Analyze(entry.rows);
        }, "constraint-rank API accepted malformed case: " + entry.name);
    }
}

using Bytes = std::vector<uint8_t>;

uint32_t rotate_right(uint32_t value, unsigned count)
{
    return (value >> count) | (value << (32u - count));
}

std::string sha256_hex(const Bytes &message)
{
    static constexpr std::array<uint32_t, 64> k{
        0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
        0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
        0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
        0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
        0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
        0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
        0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
        0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u};
    Bytes padded = message;
    const uint64_t bit_length = static_cast<uint64_t>(message.size()) * 8u;
    padded.push_back(0x80u);
    while ((padded.size() % 64u) != 56u) {
        padded.push_back(0u);
    }
    for (int shift = 56; shift >= 0; shift -= 8) {
        padded.push_back(static_cast<uint8_t>(bit_length >> shift));
    }
    std::array<uint32_t, 8> h{0x6a09e667u,0xbb67ae85u,0x3c6ef372u,0xa54ff53au,
        0x510e527fu,0x9b05688cu,0x1f83d9abu,0x5be0cd19u};
    for (std::size_t offset = 0; offset < padded.size(); offset += 64u) {
        std::array<uint32_t, 64> w{};
        for (std::size_t i = 0; i < 16; ++i) {
            const std::size_t p = offset + 4u * i;
            w[i] = (static_cast<uint32_t>(padded[p]) << 24u) |
                (static_cast<uint32_t>(padded[p + 1]) << 16u) |
                (static_cast<uint32_t>(padded[p + 2]) << 8u) |
                static_cast<uint32_t>(padded[p + 3]);
        }
        for (std::size_t i = 16; i < 64; ++i) {
            const uint32_t s0 = rotate_right(w[i - 15], 7) ^
                rotate_right(w[i - 15], 18) ^ (w[i - 15] >> 3u);
            const uint32_t s1 = rotate_right(w[i - 2], 17) ^
                rotate_right(w[i - 2], 19) ^ (w[i - 2] >> 10u);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        auto [a,b,c,d,e,f,g,hh] = h;
        for (std::size_t i = 0; i < 64; ++i) {
            const uint32_t s1 = rotate_right(e, 6) ^ rotate_right(e, 11) ^
                rotate_right(e, 25);
            const uint32_t choice = (e & f) ^ ((~e) & g);
            const uint32_t temp1 = hh + s1 + choice + k[i] + w[i];
            const uint32_t s0 = rotate_right(a, 2) ^ rotate_right(a, 13) ^
                rotate_right(a, 22);
            const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
            const uint32_t temp2 = s0 + majority;
            hh = g; g = f; f = e; e = d + temp1;
            d = c; c = b; b = a; a = temp1 + temp2;
        }
        h[0]+=a; h[1]+=b; h[2]+=c; h[3]+=d;
        h[4]+=e; h[5]+=f; h[6]+=g; h[7]+=hh;
    }
    static constexpr char hex[] = "0123456789abcdef";
    std::string result;
    result.reserve(64);
    for (const uint32_t word : h) {
        for (int shift = 28; shift >= 0; shift -= 4) {
            result.push_back(hex[(word >> shift) & 0x0fu]);
        }
    }
    return result;
}

void append_u64_le(Bytes &bytes, uint64_t value)
{
    for (unsigned shift = 0; shift < 64; shift += 8) {
        bytes.push_back(static_cast<uint8_t>(value >> shift));
    }
}

void append_f64_le(Bytes &bytes, double value)
{
    const double normalized = value == 0.0 ? 0.0 : value;
    uint64_t bits = 0;
    std::memcpy(&bits, &normalized, sizeof(bits));
    append_u64_le(bytes, bits);
}

void append_lp(Bytes &bytes, const std::string &value)
{
    append_u64_le(bytes, value.size());
    bytes.insert(bytes.end(), value.begin(), value.end());
}

Bytes decode_hex_32(const std::string &hex)
{
    require(hex.size() == 64, "digest oracle expected 64 lowercase hex bytes");
    Bytes result;
    result.reserve(32);
    const auto nibble = [](char value) -> uint8_t {
        if (value >= '0' && value <= '9') return value - '0';
        if (value >= 'a' && value <= 'f') return value - 'a' + 10;
        throw std::runtime_error("digest oracle found non-lowercase-hex input");
    };
    for (std::size_t i = 0; i < hex.size(); i += 2) {
        result.push_back(static_cast<uint8_t>(
            (nibble(hex[i]) << 4u) | nibble(hex[i + 1])));
    }
    return result;
}

std::array<uint64_t, 3> sorted_face_key(
    const mfem::Mesh &mesh,
    const StableMeshVertexIdentities &ids,
    int boundary_element)
{
    mfem::Array<int> vertices;
    mesh.GetBdrElementVertices(boundary_element, vertices);
    require(vertices.Size() == 3, "OE-T0 fixture boundary must be triangular");
    std::array<uint64_t, 3> key{
        ids.local_to_stable.at(vertices[0]),
        ids.local_to_stable.at(vertices[1]),
        ids.local_to_stable.at(vertices[2]),
    };
    std::sort(key.begin(), key.end());
    return key;
}

StableMeshVertexIdentities stable_vertex_ids(const mfem::Mesh &mesh)
{
    StableMeshVertexIdentities ids;
    ids.version = "stable_mesh_vertex_u64.v1";
    ids.local_to_stable.resize(mesh.GetNV());
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        ids.local_to_stable[vertex] = 1000u + static_cast<uint64_t>(vertex);
    }
    return ids;
}

StableMeshVertexIdentities coordinate_stable_vertex_ids(const mfem::Mesh &mesh);

std::vector<int> boundary_elements_on_x(
    const mfem::Mesh &mesh,
    double expected_x)
{
    std::vector<int> result;
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        mfem::Array<int> vertices;
        mesh.GetBdrElementVertices(boundary, vertices);
        bool matches = true;
        for (int i = 0; i < vertices.Size(); ++i) {
            matches = matches &&
                std::abs(mesh.GetVertex(vertices[i])[0] - expected_x) <= 1.0e-13;
        }
        if (matches) {
            result.push_back(boundary);
        }
    }
    return result;
}

struct ChargeFixture {
    explicit ChargeFixture(mfem::Mesh &&input_mesh)
        : mesh(std::move(input_mesh)), conductivity(4.0)
    {}

    mfem::Mesh mesh;
    mfem::ConstantCoefficient conductivity;
};

ChargeFixture periodic_cube_fixture()
{
    return ChargeFixture(mfem::Mesh::MakeCartesian3D(
        2, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0));
}

ClosedGeometryCurrentClosure periodic_source_cut(
    const mfem::Mesh &mesh,
    const StableMeshVertexIdentities &ids)
{
    PeriodicCurrentSourceCut cut;
    cut.id = "x-periodic-voltage-cut";
    cut.translation_m = {1.0, 0.0, 0.0};
    // The public convention is V_plus - V_minus = potential_drop_v.  The
    // fixture uses V(x)=1-x, hence the authored drop is -1 V while Jx is +4.
    cut.potential_drop_v = -1.0;
    const auto minus_faces = boundary_elements_on_x(mesh, 0.0);
    auto plus_faces = boundary_elements_on_x(mesh, 1.0);
    require(!minus_faces.empty(), "missing minus source-cut faces");
    require(minus_faces.size() == plus_faces.size(),
        "source-cut fixture faces do not pair");

    // Deliberately reverse the plus-side local enumeration. Pairing is made
    // by translated face geometry and frozen as stable face-key records; an
    // implementation that zips MFEM boundary arrays will fail this fixture.
    std::reverse(plus_faces.begin(), plus_faces.end());
    for (const int minus_boundary : minus_faces) {
        mfem::Array<int> minus_vertices;
        mesh.GetBdrElementVertices(minus_boundary, minus_vertices);
        double minus_y = 0.0;
        double minus_z = 0.0;
        for (int i = 0; i < minus_vertices.Size(); ++i) {
            minus_y += mesh.GetVertex(minus_vertices[i])[1];
            minus_z += mesh.GetVertex(minus_vertices[i])[2];
        }
        minus_y /= minus_vertices.Size();
        minus_z /= minus_vertices.Size();

        const auto match = std::find_if(
            plus_faces.begin(), plus_faces.end(), [&](int plus_boundary) {
                mfem::Array<int> plus_vertices;
                mesh.GetBdrElementVertices(plus_boundary, plus_vertices);
                double plus_y = 0.0;
                double plus_z = 0.0;
                for (int i = 0; i < plus_vertices.Size(); ++i) {
                    plus_y += mesh.GetVertex(plus_vertices[i])[1];
                    plus_z += mesh.GetVertex(plus_vertices[i])[2];
                }
                plus_y /= plus_vertices.Size();
                plus_z /= plus_vertices.Size();
                return std::abs(plus_y - minus_y) <= 1.0e-13 &&
                    std::abs(plus_z - minus_z) <= 1.0e-13;
            });
        require(match != plus_faces.end(),
            "source-cut face has no translated geometric peer");
        PeriodicCurrentSourceCutFacePair pair;
        pair.minus_face_vertex_ids = sorted_face_key(
            mesh, ids, minus_boundary);
        pair.plus_face_vertex_ids = sorted_face_key(
            mesh, ids, *match);
        cut.face_pairs.push_back(pair);
        plus_faces.erase(match);
    }
    require(plus_faces.empty(), "source-cut fixture left an unmatched plus face");

    ClosedGeometryCurrentClosure closure;
    closure.operator_version = "fem_closed_current_geometry.v1";
    closure.revision = "closure-r1";
    closure.digest = "closure-digest-r1";
    closure.source_cuts.push_back(std::move(cut));
    (void)ids;
    return closure;
}

std::vector<ConservativeCurrentBoundaryFace> periodic_boundary_roles(
    const mfem::Mesh &mesh)
{
    const auto minus = boundary_elements_on_x(mesh, 0.0);
    const auto plus = boundary_elements_on_x(mesh, 1.0);
    std::vector<ConservativeCurrentBoundaryFace> result;
    result.reserve(mesh.GetNBE());
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        ConservativeCurrentBoundaryFace face;
        face.boundary_element = boundary;
        if (std::find(minus.begin(), minus.end(), boundary) != minus.end() ||
            std::find(plus.begin(), plus.end(), boundary) != plus.end()) {
            face.role = ConservativeCurrentBoundaryRole::SourceCut;
            face.circuit_id = "x-periodic-voltage-cut";
        } else {
            face.role = ConservativeCurrentBoundaryRole::InsulatingOuter;
        }
        result.push_back(std::move(face));
    }
    return result;
}

ConservativeCurrentIdentityInput identity_input()
{
    ConservativeCurrentIdentityInput identity;
    identity.source_module_id = "drive";
    identity.source_state_revision = "source-r1";
    identity.source_field_digest = "source-field-r1";
    identity.mesh_revision = "mesh-r1";
    identity.topology_revision = "topology-r1";
    identity.geometry_digest = "geometry-r1";
    identity.envelope_revision = "envelope-r1";
    identity.envelope_digest = "envelope-digest-r1";
    identity.evaluated_envelope_multiplier = 1.0;
    identity.evaluation_time_s = 2.5e-12;
    identity.stage_identity = 7;
    return identity;
}

ConservativeCurrentPins pins_for(const ConservativeCurrentIdentityInput &identity)
{
    ConservativeCurrentPins pins;
    pins.required_source_state_revision = identity.source_state_revision;
    pins.required_source_field_digest = identity.source_field_digest;
    pins.required_mesh_revision = identity.mesh_revision;
    pins.required_topology_revision = identity.topology_revision;
    return pins;
}

ConservativeCurrentBuildRequest periodic_request(
    ChargeFixture &fixture,
    StableMeshVertexIdentities ids,
    ConservativeCurrentIdentityInput identity,
    mfem::Coefficient *conductivity_override = nullptr,
    std::string conductivity_digest = "conductivity-r1",
    std::string closure_revision = "closure-r1",
    std::string closure_digest = "closure-digest-r1")
{
    auto *conductivity = conductivity_override != nullptr
        ? conductivity_override
        : static_cast<mfem::Coefficient *>(&fixture.conductivity);
    ConservativeCurrentBuildRequest request;
    request.mesh = &fixture.mesh;
    request.conductivity = conductivity;
    request.stable_vertex_identities = std::move(ids);
    request.boundary_faces = periodic_boundary_roles(fixture.mesh);
    request.closure = periodic_source_cut(
        fixture.mesh, request.stable_vertex_identities);
    std::get<ClosedGeometryCurrentClosure>(request.closure).revision =
        std::move(closure_revision);
    std::get<ClosedGeometryCurrentClosure>(request.closure).digest =
        std::move(closure_digest);
    PeriodicChargePotentialSolveRequest periodic_solve;
    periodic_solve.mesh = &fixture.mesh;
    periodic_solve.conductivity = conductivity;
    periodic_solve.stable_vertex_identities = request.stable_vertex_identities;
    periodic_solve.boundary_faces = request.boundary_faces;
    periodic_solve.source_cut = std::get<ClosedGeometryCurrentClosure>(
        request.closure).source_cuts.front();
    periodic_solve.operator_version = "fem_charge_h1_periodic_jump.v1";
    periodic_solve.source_module_id = identity.source_module_id;
    periodic_solve.source_state_revision = identity.source_state_revision;
    periodic_solve.source_field_digest = identity.source_field_digest;
    periodic_solve.evaluation_time_s = identity.evaluation_time_s;
    periodic_solve.stage_identity = identity.stage_identity;
    periodic_solve.envelope_revision = identity.envelope_revision;
    periodic_solve.envelope_digest = identity.envelope_digest;
    periodic_solve.evaluated_envelope_multiplier =
        identity.evaluated_envelope_multiplier;
    periodic_solve.mesh_revision = identity.mesh_revision;
    periodic_solve.geometry_digest = identity.geometry_digest;
    periodic_solve.conductivity_digest = std::move(conductivity_digest);
    periodic_solve.source_cut_digest =
        std::get<ClosedGeometryCurrentClosure>(request.closure).digest;
    periodic_solve.algebraic_relative_tolerance = 1.0e-12;
    periodic_solve.maximum_iterations = 1000;
    request.periodic_charge_potential =
        PeriodicChargePotentialSolver::Solve(periodic_solve);
    request.identity = std::move(identity);
    request.pins = pins_for(request.identity);
    request.algebraic_relative_tolerance = 1.0e-12;
    request.physical_relative_gate = 1.0e-10;
    request.physical_absolute_gate_a = 1.0e-18;
    return request;
}

void require_accepted_periodic_snapshot(
    const std::shared_ptr<const PeriodicChargePotentialSnapshot> &snapshot,
    const ConservativeCurrentIdentityInput &identity)
{
    require(snapshot != nullptr, "periodic H1 solver returned no snapshot");
    require(snapshot->operator_version() ==
            "fem_charge_h1_periodic_jump.v1",
        "periodic snapshot has the wrong operator version");
    require(snapshot->converged() &&
            snapshot->algebraic_relative_residual() <= 1.0e-12,
        "periodic H1 snapshot was not algebraically accepted");
    require(std::abs(snapshot->potential_jump_v() + 1.0) <= 1.0e-12,
        "periodic H1 trace jump does not equal V_plus-V_minus=-1 V");
    require(std::abs(snapshot->gauge_mean_v()) <= 1.0e-12,
        "periodic H1 snapshot did not enforce its explicit zero-mean gauge");
    require(snapshot->max_paired_weak_flux_mismatch_a() <= 1.0e-12,
        "periodic H1 snapshot failed the independent paired weak-flux gate");
    require(snapshot->mesh_revision() == identity.mesh_revision &&
            snapshot->geometry_digest() == identity.geometry_digest &&
            snapshot->conductivity_digest() == "conductivity-r1" &&
            snapshot->source_cut_digest() == "closure-digest-r1",
        "periodic snapshot is not pinned to the exact mesh/conductivity/cut identity");
    require(snapshot->source_module_id() == identity.source_module_id &&
            snapshot->source_state_revision() == identity.source_state_revision &&
            snapshot->source_field_digest() == identity.source_field_digest &&
            snapshot->evaluation_time_s() == identity.evaluation_time_s &&
            snapshot->stage_identity() == identity.stage_identity &&
            snapshot->envelope_revision() == identity.envelope_revision &&
            snapshot->envelope_digest() == identity.envelope_digest &&
            snapshot->evaluated_envelope_multiplier() ==
                identity.evaluated_envelope_multiplier,
        "periodic snapshot is not the exact same current source/time/envelope");
}

mfem::Vector coordinate_copy(const mfem::Mesh &mesh, int vertex);
mfem::Vector element_centroid(const mfem::Mesh &mesh, int element);

struct BoundaryFaceSample {
    int element = -1;
    mfem::IntegrationPoint element_point;
    mfem::Vector physical_centroid{3};
    mfem::Vector outward_area{3};
};

BoundaryFaceSample locate_boundary_face(
    mfem::Mesh &mesh,
    const StableMeshVertexIdentities &ids,
    const std::array<uint64_t, 3> &key)
{
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        if (sorted_face_key(mesh, ids, boundary) != key) {
            continue;
        }
        mfem::Array<int> vertices;
        mesh.GetBdrElementVertices(boundary, vertices);
        BoundaryFaceSample sample;
        sample.physical_centroid = 0.0;
        for (int i = 0; i < vertices.Size(); ++i) {
            sample.physical_centroid += coordinate_copy(mesh, vertices[i]);
        }
        sample.physical_centroid /= 3.0;
        int face_info = 0;
        mesh.GetBdrElementAdjacentElement(
            boundary, sample.element, face_info);
        require(sample.element >= 0,
            "periodic oracle boundary has no adjacent element");
        auto *transformation = mesh.GetElementTransformation(sample.element);
        mfem::InverseElementTransformation inverse(transformation);
        require(inverse.Transform(sample.physical_centroid,
                    sample.element_point) ==
                mfem::InverseElementTransformation::Inside,
            "periodic oracle could not invert a cut-face centroid");

        std::array<int, 3> ordered{vertices[0], vertices[1], vertices[2]};
        std::sort(ordered.begin(), ordered.end(), [&](int a, int b) {
            return ids.local_to_stable.at(a) < ids.local_to_stable.at(b);
        });
        const auto p0 = coordinate_copy(mesh, ordered[0]);
        auto e1 = coordinate_copy(mesh, ordered[1]);
        auto e2 = coordinate_copy(mesh, ordered[2]);
        e1 -= p0;
        e2 -= p0;
        sample.outward_area[0] = 0.5 * (e1[1] * e2[2] - e1[2] * e2[1]);
        sample.outward_area[1] = 0.5 * (e1[2] * e2[0] - e1[0] * e2[2]);
        sample.outward_area[2] = 0.5 * (e1[0] * e2[1] - e1[1] * e2[0]);
        auto inward = element_centroid(mesh, sample.element);
        inward -= sample.physical_centroid;
        if (sample.outward_area * inward > 0.0) {
            sample.outward_area *= -1.0;
        }
        return sample;
    }
    throw std::runtime_error("periodic oracle could not locate stable face key");
}

void independently_certify_periodic_field(
    const PeriodicChargePotentialSnapshot &snapshot,
    mfem::Coefficient &conductivity,
    const PeriodicCurrentSourceCut &cut)
{
    const auto &field = snapshot.potential_field();
    const auto &space = snapshot.potential_space();
    auto &mesh = *space.GetMesh();
    const auto &ids = snapshot.stable_vertex_identities();
    double weighted_mean = 0.0;
    double volume = 0.0;
    mfem::Vector assembled_residual(space.GetVSize());
    assembled_residual = 0.0;
    for (int element = 0; element < mesh.GetNE(); ++element) {
        auto *transformation = mesh.GetElementTransformation(element);
        const auto *finite_element = space.GetFE(element);
        mfem::Array<int> element_dofs;
        space.GetElementDofs(element, element_dofs);
        const auto &nodes = finite_element->GetNodes();
        for (int node = 0; node < nodes.GetNPoints(); ++node) {
            const auto &point = nodes.IntPoint(node);
            transformation->SetIntPoint(&point);
            mfem::Vector physical(3);
            transformation->Transform(point, physical);
            const double exact = 0.5 - physical[0];
            require(std::abs(field.GetValue(element, point) - exact) <= 1.0e-12,
                "periodic H1 nodal value disagrees with V=0.5-x");
        }
        const auto &rule = mfem::IntRules.Get(
            mesh.GetElementBaseGeometry(element), 4);
        for (int q = 0; q < rule.GetNPoints(); ++q) {
            const auto &point = rule.IntPoint(q);
            transformation->SetIntPoint(&point);
            const double weight = point.weight * transformation->Weight();
            mfem::Vector physical(3);
            transformation->Transform(point, physical);
            const double value = field.GetValue(element, point);
            require(std::abs(value - (0.5 - physical[0])) <= 1.0e-12,
                "periodic H1 quadrature value disagrees with V=0.5-x");
            mfem::Vector gradient(3);
            field.GetGradient(*transformation, gradient);
            require(std::abs(gradient[0] + 1.0) <= 1.0e-12 &&
                    std::abs(gradient[1]) <= 1.0e-12 &&
                    std::abs(gradient[2]) <= 1.0e-12,
                "periodic H1 quadrature gradient disagrees with (-1,0,0)");
            const double sigma = conductivity.Eval(*transformation, point);
            mfem::DenseMatrix physical_shape_gradient(
                finite_element->GetDof(), transformation->GetSpaceDim());
            finite_element->CalcPhysDShape(
                *transformation, physical_shape_gradient);
            for (int local = 0; local < element_dofs.Size(); ++local) {
                double weak_entry = 0.0;
                for (int component = 0; component < 3; ++component) {
                    weak_entry += gradient[component] *
                        physical_shape_gradient(local, component);
                }
                const int dof = element_dofs[local] >= 0
                    ? element_dofs[local] : -1 - element_dofs[local];
                assembled_residual[dof] += weight * sigma * weak_entry;
            }
            weighted_mean += weight * value;
            volume += weight;
        }
    }
    require(volume > 0.0 && std::abs(weighted_mean / volume) <= 1.0e-12,
        "independent periodic-field quadrature found a nonzero gauge mean");

    for (const auto &pair : cut.face_pairs) {
        const auto minus = locate_boundary_face(
            mesh, ids, pair.minus_face_vertex_ids);
        const auto plus = locate_boundary_face(
            mesh, ids, pair.plus_face_vertex_ids);
        const double jump = field.GetValue(plus.element, plus.element_point) -
            field.GetValue(minus.element, minus.element_point);
        require(std::abs(jump - cut.potential_drop_v) <= 1.0e-12,
            "independent cut trace evaluation found the wrong potential jump");

        auto weak_flux = [&](const BoundaryFaceSample &sample) {
            auto *transformation = mesh.GetElementTransformation(sample.element);
            transformation->SetIntPoint(&sample.element_point);
            mfem::Vector gradient(3);
            field.GetGradient(*transformation, gradient);
            return conductivity.Eval(*transformation, sample.element_point) *
                (gradient * sample.outward_area);
        };
        const double minus_flux = weak_flux(minus);
        const double plus_flux = weak_flux(plus);
        require(std::abs(minus_flux + 4.0 * minus.outward_area[0]) <= 1.0e-12 &&
                std::abs(plus_flux + 4.0 * plus.outward_area[0]) <= 1.0e-12,
            "independent cut flux disagrees with sigma*grad(V)=(-4,0,0) A/m2");
        require(std::abs(minus_flux + plus_flux) <= 1.0e-12,
            "independent sigma*grad(V) integration found unpaired weak flux");
    }

    // Assemble the weak Laplace residual independently from the solved
    // snapshot. The periodic quotient test basis identifies x=0 and x=1
    // vertex functions, so their two residual entries must be summed. This
    // catches a field that has the right trace jump but is not a weak solution.
    double x_min = std::numeric_limits<double>::infinity();
    double x_max = -std::numeric_limits<double>::infinity();
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        x_min = std::min(x_min, mesh.GetVertex(vertex)[0]);
        x_max = std::max(x_max, mesh.GetVertex(vertex)[0]);
    }
    std::map<std::pair<long long, long long>, double> quotient_cut_residual;
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        mfem::Array<int> dofs;
        space.GetVertexDofs(vertex, dofs);
        require(dofs.Size() == 1,
            "exact H1 oracle requires one scalar P1 vertex dof");
        const int dof = dofs[0] >= 0 ? dofs[0] : -1 - dofs[0];
        const auto *coordinate = mesh.GetVertex(vertex);
        if (std::abs(coordinate[0] - x_min) <= 1.0e-13 ||
            std::abs(coordinate[0] - x_max) <= 1.0e-13) {
            const auto key = std::make_pair(
                std::llround(coordinate[1] * 1.0e12),
                std::llround(coordinate[2] * 1.0e12));
            quotient_cut_residual[key] += assembled_residual[dof];
        } else {
            require(std::abs(assembled_residual[dof]) <= 1.0e-12,
                "independent weak Laplace residual is nonzero at an interior dof");
        }
    }
    for (const auto &[key, residual] : quotient_cut_residual) {
        (void)key;
        require(std::abs(residual) <= 1.0e-12,
            "independently reassembled periodic quotient weak residual is nonzero");
    }
}

std::vector<CanonicalFaceFluxRecord> records(
    const ConservativeCurrentView::Ptr &view)
{
    return view->canonical_face_flux_records();
}

bool same_records(
    const std::vector<CanonicalFaceFluxRecord> &left,
    const std::vector<CanonicalFaceFluxRecord> &right)
{
    if (left.size() != right.size()) {
        return false;
    }
    for (std::size_t i = 0; i < left.size(); ++i) {
        if (left[i].face_vertex_ids != right[i].face_vertex_ids ||
            left[i].flux_a != right[i].flux_a) {
            return false;
        }
    }
    return true;
}

Bytes encode_canonical_records(
    const std::vector<CanonicalFaceFluxRecord> &input)
{
    Bytes bytes;
    bytes.reserve(input.size() * 32u);
    for (const auto &record : input) {
        for (const uint64_t id : record.face_vertex_ids) {
            append_u64_le(bytes, id);
        }
        append_f64_le(bytes, record.flux_a);
    }
    return bytes;
}

std::string canonical_face_digest_oracle(
    const std::string &geometry_digest,
    uint64_t record_count,
    const std::string &payload_digest)
{
    Bytes preimage;
    append_lp(preimage, "fem_rt0_canonical_face_digest.v1");
    append_lp(preimage, "fem_conservative_current_rt0_view.v1");
    append_lp(preimage, "stable_vertex_lexicographic_normal.v1");
    append_lp(preimage, geometry_digest);
    append_u64_le(preimage, record_count);
    const auto nested = decode_hex_32(payload_digest);
    preimage.insert(preimage.end(), nested.begin(), nested.end());
    return sha256_hex(preimage);
}

std::string view_identity_digest_oracle(
    const ConservativeCurrentIdentity &identity)
{
    Bytes preimage;
    append_lp(preimage, "fem_conservative_current_view_identity_digest.v1");
    auto append_nested = [&](const std::string &digest) {
        const auto bytes = decode_hex_32(digest);
        preimage.insert(preimage.end(), bytes.begin(), bytes.end());
    };
    append_nested(identity.canonical_face_digest);
    append_lp(preimage, identity.source_module_id);
    append_lp(preimage, identity.source_state_revision);
    append_lp(preimage, identity.source_field_digest);
    append_lp(preimage, identity.mesh_revision);
    append_lp(preimage, identity.topology_revision);
    append_lp(preimage, identity.geometry_digest);
    append_lp(preimage, identity.closure_revision);
    append_lp(preimage, identity.closure_digest);
    append_lp(preimage, identity.envelope_revision);
    append_lp(preimage, identity.envelope_digest);
    append_f64_le(preimage, identity.evaluated_envelope_multiplier);
    append_f64_le(preimage, identity.evaluation_time_s);
    append_u64_le(preimage, identity.stage_identity);
    append_nested(identity.balance_certificate_digest);
    return sha256_hex(preimage);
}

bool valid_utf8_without_nul(const uint8_t *data, std::size_t size)
{
    for (std::size_t offset = 0; offset < size;) {
        const uint8_t lead = data[offset];
        if (lead == 0) return false;
        std::size_t continuation = 0;
        uint32_t code_point = 0;
        uint32_t minimum = 0;
        if (lead <= 0x7f) {
            ++offset;
            continue;
        } else if ((lead & 0xe0u) == 0xc0u) {
            continuation = 1; code_point = lead & 0x1fu; minimum = 0x80u;
        } else if ((lead & 0xf0u) == 0xe0u) {
            continuation = 2; code_point = lead & 0x0fu; minimum = 0x800u;
        } else if ((lead & 0xf8u) == 0xf0u) {
            continuation = 3; code_point = lead & 0x07u; minimum = 0x10000u;
        } else {
            return false;
        }
        if (continuation > size - offset - 1) return false;
        for (std::size_t i = 1; i <= continuation; ++i) {
            const uint8_t byte = data[offset + i];
            if ((byte & 0xc0u) != 0x80u) return false;
            code_point = (code_point << 6u) | (byte & 0x3fu);
        }
        if (code_point < minimum || code_point > 0x10ffffu ||
            (code_point >= 0xd800u && code_point <= 0xdfffu)) {
            return false;
        }
        offset += continuation + 1;
    }
    return true;
}

class ByteReader {
public:
    explicit ByteReader(const Bytes &bytes) : bytes_(bytes) {}
    uint8_t u8()
    {
        require(offset_ < bytes_.size(), "balance decoder truncated u8");
        return bytes_[offset_++];
    }
    uint64_t u64()
    {
        require(bytes_.size() - offset_ >= 8,
            "balance decoder truncated u64");
        uint64_t value = 0;
        for (unsigned shift = 0; shift < 64; shift += 8) {
            value |= static_cast<uint64_t>(bytes_[offset_++]) << shift;
        }
        return value;
    }
    double f64()
    {
        const uint64_t bits = u64();
        double value = 0.0;
        std::memcpy(&value, &bits, sizeof(value));
        require(std::isfinite(value), "balance decoder found non-finite f64");
        require(value != 0.0 || bits == 0,
            "balance decoder found non-canonical negative zero");
        return value;
    }
    std::string lp()
    {
        const uint64_t size = u64();
        require(size <= 4096,
            "balance decoder LP string exceeds 4096-byte ABI cap");
        require(size <= bytes_.size() - offset_,
            "balance decoder truncated LP string");
        require(valid_utf8_without_nul(bytes_.data() + offset_,
                    static_cast<std::size_t>(size)),
            "balance decoder found invalid UTF-8 or embedded NUL");
        std::string value(bytes_.begin() + static_cast<std::ptrdiff_t>(offset_),
            bytes_.begin() + static_cast<std::ptrdiff_t>(offset_ + size));
        offset_ += static_cast<std::size_t>(size);
        return value;
    }
    uint64_t count()
    {
        const uint64_t value = u64();
        require(value <= 0x7fffffffu,
            "balance decoder row-family count exceeds 2^31-1");
        return value;
    }
    bool finished() const { return offset_ == bytes_.size(); }
private:
    const Bytes &bytes_;
    std::size_t offset_ = 0;
};

void balance_decoder_rejects_unbounded_or_invalid_text()
{
    Bytes oversized_count;
    append_u64_le(oversized_count, 0x80000000u);
    require_rejected([&] { (void)ByteReader(oversized_count).count(); },
        "balance decoder accepted a row count above 2^31-1");

    Bytes oversized_text;
    append_u64_le(oversized_text, 4097);
    oversized_text.resize(8 + 4097, static_cast<uint8_t>('x'));
    require_rejected([&] { (void)ByteReader(oversized_text).lp(); },
        "balance decoder accepted an LP string above 4096 bytes");

    Bytes invalid_utf8;
    append_u64_le(invalid_utf8, 2);
    invalid_utf8.push_back(0xc0u);
    invalid_utf8.push_back(0xafu);
    require_rejected([&] { (void)ByteReader(invalid_utf8).lp(); },
        "balance decoder accepted an overlong UTF-8 sequence");
}

struct IndependentFluxOracle {
    struct ElementRow {
        std::array<uint64_t, 4> key{};
        double residual_a = 0.0;
        double denominator_a = 0.0;
    };
    struct FaceRow {
        std::array<uint64_t, 3> key{};
        uint8_t side_count = 0;
        double side1_flux_a = 0.0;
        double side2_flux_a = 0.0;
        double canonical_jump_a = 0.0;
    };
    std::vector<CanonicalFaceFluxRecord> records;
    std::map<std::array<uint64_t, 4>, ElementRow> element_rows;
    std::map<std::array<uint64_t, 3>, FaceRow> face_rows;
    double max_internal_jump_a = 0.0;
    double max_element_divergence_a = 0.0;
};

IndependentFluxOracle integrate_physical_piola_oracle(
    const mfem::GridFunction &field,
    const StableMeshVertexIdentities &ids);

std::string divergence_row_id(const std::array<uint64_t, 4> &key);

struct DecodedCircuitRow {
    uint8_t kind = 0;
    std::string id;
    std::array<uint64_t, 3> face_a{};
    std::array<uint64_t, 3> face_b{};
    double flux_a = 0.0;
    double paired_flux_a = 0.0;
    double mismatch_a = 0.0;
};

struct ExpectedCircuitPair {
    uint8_t kind = 0;
    std::string id;
    std::array<uint64_t, 3> face_a{};
    std::array<uint64_t, 3> face_b{};

    auto key() const { return std::make_tuple(kind, id, face_a, face_b); }
};

struct ExpectedBoundaryFace {
    std::array<uint64_t, 3> key{};
    ConservativeCurrentBoundaryRole role{};
    std::string circuit_id;
};

std::vector<ExpectedBoundaryFace> expected_boundary_map(
    const mfem::Mesh &mesh,
    const StableMeshVertexIdentities &ids,
    const std::vector<ConservativeCurrentBoundaryFace> &boundary_roles)
{
    require(boundary_roles.size() == static_cast<std::size_t>(mesh.GetNBE()),
        "boundary-element role map is incomplete");
    std::vector<ExpectedBoundaryFace> result;
    result.reserve(boundary_roles.size());
    for (const auto &face : boundary_roles) {
        require(face.boundary_element >= 0 &&
                face.boundary_element < mesh.GetNBE(),
            "boundary role references an invalid boundary element");
        result.push_back(ExpectedBoundaryFace{
            sorted_face_key(mesh, ids, face.boundary_element),
            face.role, face.circuit_id});
    }
    return result;
}

void independently_decode_and_match_balance_artifact(
    const ConservativeCurrentView::Ptr &view,
    const StableMeshVertexIdentities &ids,
    const std::vector<ExpectedBoundaryFace> &expected_boundary_faces,
    const std::vector<ExpectedCircuitPair> &expected_pairs,
    const std::vector<std::array<uint64_t, 3>> &expected_terminal_faces = {},
    const std::string &expected_terminal_id = {})
{
    const auto oracle = integrate_physical_piola_oracle(view->field(), ids);
    std::map<std::array<uint64_t, 3>,
        std::pair<ConservativeCurrentBoundaryRole, std::string>> authored_roles;
    for (const auto &face : expected_boundary_faces) {
        require(authored_roles.emplace(face.key,
                    std::make_pair(face.role, face.circuit_id)).second,
            "boundary element map contains a duplicate physical face key");
        require(oracle.face_rows.count(face.key) == 1 &&
                oracle.face_rows.at(face.key).side_count == 1,
            "boundary role does not map to a one-sided physical boundary face");
    }
    const auto &owned = view->canonical_balance_certificate_bytes();
    const Bytes bytes(owned.begin(), owned.end());
    ByteReader reader(bytes);
    require(reader.lp() == "fem_conservative_current_balance_certificate.v1",
        "balance artifact has the wrong schema preimage");
    const double algebraic_rtol = reader.f64();
    const double physical_relative_gate = reader.f64();
    const double physical_absolute_gate_a = reader.f64();
    require(algebraic_rtol == 1.0e-12 &&
            physical_relative_gate == 1.0e-10 &&
            physical_absolute_gate_a == 1.0e-18,
        "balance artifact changed the frozen gates");
    const uint64_t certified_rows_before = reader.count();
    const uint64_t certified_rank = reader.count();
    require(certified_rank <= certified_rows_before,
        "balance artifact rank exceeds rows_before");
    const uint64_t element_count = reader.count();
    const uint64_t face_count = reader.count();
    const uint64_t circuit_count = reader.count();
    const uint64_t omitted_count = reader.count();
    require(element_count == oracle.element_rows.size() &&
            face_count == oracle.face_rows.size(),
        "balance artifact row counts disagree with the physical mesh");

    std::array<uint64_t, 4> previous_element{};
    bool first_element = true;
    for (uint64_t row_index = 0; row_index < element_count; ++row_index) {
        std::array<uint64_t, 4> key{};
        for (auto &id : key) id = reader.u64();
        require(first_element || previous_element < key,
            "balance element rows are not strictly sorted/unique");
        first_element = false;
        previous_element = key;
        const double residual = reader.f64();
        const double denominator = reader.f64();
        const double normalized = reader.f64();
        const auto expected = oracle.element_rows.at(key);
        require(std::abs(residual - expected.residual_a) <= 1.0e-13 &&
                std::abs(denominator - expected.denominator_a) <= 1.0e-13 &&
                std::abs(normalized - residual /
                    std::max(denominator, 1.0e-30)) <= 1.0e-13,
            "balance element row disagrees with independent physical fluxes");
    }

    std::array<uint64_t, 3> previous_face{};
    bool first_face = true;
    for (uint64_t row_index = 0; row_index < face_count; ++row_index) {
        std::array<uint64_t, 3> key{};
        for (auto &id : key) id = reader.u64();
        require(first_face || previous_face < key,
            "balance face rows are not strictly sorted/unique");
        first_face = false;
        previous_face = key;
        const uint8_t side_count = reader.u8();
        const double side1 = reader.f64();
        const double side2 = reader.f64();
        const double jump = reader.f64();
        const auto expected = oracle.face_rows.at(key);
        require(side_count == expected.side_count &&
                std::abs(side1 - expected.side1_flux_a) <= 1.0e-13 &&
                std::abs(side2 - expected.side2_flux_a) <= 1.0e-13 &&
                std::abs(jump - expected.canonical_jump_a) <= 1.0e-13,
            "balance face row disagrees with independent Piola fluxes");
    }

    std::vector<DecodedCircuitRow> circuits;
    circuits.reserve(circuit_count);
    std::tuple<uint8_t, std::string, std::array<uint64_t, 3>,
        std::array<uint64_t, 3>> previous_circuit;
    bool first_circuit = true;
    for (uint64_t row_index = 0; row_index < circuit_count; ++row_index) {
        DecodedCircuitRow row;
        row.kind = reader.u8();
        row.id = reader.lp();
        for (auto &id : row.face_a) id = reader.u64();
        for (auto &id : row.face_b) id = reader.u64();
        row.flux_a = reader.f64();
        row.paired_flux_a = reader.f64();
        row.mismatch_a = reader.f64();
        const auto circuit_key = std::make_tuple(
            row.kind, row.id, row.face_a, row.face_b);
        require(first_circuit || previous_circuit < circuit_key,
            "balance circuit rows are not strictly sorted/unique");
        first_circuit = false;
        previous_circuit = circuit_key;
        require(row.kind >= 1 && row.kind <= 4,
            "balance circuit row has an unknown kind");
        require(oracle.face_rows.count(row.face_a) == 1 &&
                oracle.face_rows.at(row.face_a).side_count == 1,
            "balance circuit row references a non-boundary or internal face");
        const auto physical_a = oracle.face_rows.at(row.face_a).side1_flux_a;
        require(std::abs(row.flux_a - physical_a) <= 1.0e-13,
            "balance circuit flux disagrees with boundary quadrature");
        if (row.kind == 2 || row.kind == 3) {
            require(oracle.face_rows.count(row.face_b) == 1 &&
                    oracle.face_rows.at(row.face_b).side_count == 1,
                "paired circuit row references a non-boundary/internal peer");
            const auto physical_b = oracle.face_rows.at(row.face_b).side1_flux_a;
            require(std::abs(row.paired_flux_a - physical_b) <= 1.0e-13 &&
                    std::abs(row.mismatch_a -
                        (physical_a + physical_b)) <= 1.0e-13,
                "paired circuit row disagrees with physical join/cut flux");
        } else {
            require(row.face_b == std::array<uint64_t, 3>{0, 0, 0} &&
                    row.paired_flux_a == 0.0,
                "unpaired circuit row did not use canonical sentinels");
        }
        circuits.push_back(row);
    }
    std::string previous_omitted;
    struct DecodedOmittedRow {
        std::string id;
        uint8_t reason = 0;
        std::array<uint64_t, 4> anchor{};
        double residual_a = 0.0;
    };
    std::vector<DecodedOmittedRow> decoded_omitted;
    for (uint64_t row_index = 0; row_index < omitted_count; ++row_index) {
        const std::string constraint_id = reader.lp();
        const uint8_t reason = reader.u8();
        require(reason == 1 || reason == 2,
            "omitted rank row has an unknown reason code");
        std::array<uint64_t, 4> anchor{};
        for (auto &id : anchor) id = reader.u64();
        const double residual = reader.f64();
        const bool zero_anchor = anchor == std::array<uint64_t, 4>{0, 0, 0, 0};
        const bool strict_nonzero_anchor = anchor[0] != 0 &&
            anchor[0] < anchor[1] && anchor[1] < anchor[2] &&
            anchor[2] < anchor[3];
        const bool exact_closed_row = reason == 1 && strict_nonzero_anchor &&
            oracle.element_rows.count(anchor) == 1 &&
            constraint_id == divergence_row_id(anchor) &&
            std::abs(oracle.element_rows.at(anchor).residual_a - residual) <=
                1.0e-13;
        require(!constraint_id.empty() &&
                (row_index == 0 || previous_omitted < constraint_id) &&
                std::abs(residual) <= 1.0e-12 &&
                (exact_closed_row ||
                 (reason == 2 && zero_anchor)),
            "omitted constraint was not independently satisfied");
        previous_omitted = constraint_id;
        decoded_omitted.push_back(
            DecodedOmittedRow{constraint_id, reason, anchor, residual});
    }
    const auto &rank_certificate = view->constraint_rank_certificate();
    require(rank_certificate.rows_before == certified_rows_before &&
            rank_certificate.rank == certified_rank &&
            rank_certificate.rows_before >= rank_certificate.rank &&
            rank_certificate.rows_before - rank_certificate.rank ==
                rank_certificate.omitted_rows.size() &&
            rank_certificate.omitted_rows.size() == decoded_omitted.size(),
        "rank certificate dimensions disagree with omitted artifact rows");
    for (std::size_t index = 0; index < decoded_omitted.size(); ++index) {
        const auto &expected = rank_certificate.omitted_rows[index];
        const uint8_t expected_reason = expected.reason ==
                ConstraintOmissionReason::ClosedComponentDivergenceDependency
            ? 1 : expected.reason ==
                ConstraintOmissionReason::ConsistentLinearDependency ? 2 : 0;
        require(expected.constraint_id == decoded_omitted[index].id &&
                expected_reason == decoded_omitted[index].reason &&
                expected.closed_component_anchor_element ==
                    decoded_omitted[index].anchor &&
                std::abs(expected.residual_a -
                    decoded_omitted[index].residual_a) <= 1.0e-13 &&
                std::abs(expected.residual_a) <= 1.0e-12,
            "rank certificate omitted-row identity/reason/residual mismatch");
    }
    const double summary_element = reader.f64();
    const double summary_face = reader.f64();
    const double summary_outer = reader.f64();
    const double summary_electrode = reader.f64();
    const double summary_kkt = reader.f64();
    const double summary_correction = reader.f64();
    const uint8_t closure_complete = reader.u8();
    require(reader.finished(), "balance artifact has trailing/partial bytes");
    require(std::abs(summary_element - oracle.max_element_divergence_a) <=
                1.0e-13 &&
            std::abs(summary_face - oracle.max_internal_jump_a) <= 1.0e-13,
        "balance summary maxima disagree with independently decoded rows");
    require(std::abs(summary_kkt - view->balance().scaled_kkt_residual) <=
                1.0e-13 &&
            std::abs(summary_correction - view->balance().correction_norm_mw) <=
                1.0e-13 && closure_complete ==
                (view->balance().closure_complete ? 1u : 0u),
        "balance KKT diagnostics disagree with the accepted view");

    double outer_flux = 0.0;
    double max_circuit_mismatch = 0.0;
    double circuit_flux_scale = 0.0;
    double terminal_net_flux = 0.0;
    double terminal_flux_scale = 0.0;
    std::size_t terminal_rows = 0;
    for (const auto &row : circuits) {
        if (row.kind == 4) outer_flux += row.flux_a;
        if (row.kind == 1) {
            terminal_net_flux += row.flux_a;
            terminal_flux_scale += std::abs(row.flux_a);
            ++terminal_rows;
        }
        if (row.kind == 2 || row.kind == 3) {
            max_circuit_mismatch = std::max(
                max_circuit_mismatch, std::abs(row.mismatch_a));
            circuit_flux_scale = std::max(circuit_flux_scale,
                std::abs(row.flux_a) + std::abs(row.paired_flux_a));
        }
    }
    const double electrode_relative = std::max(
        max_circuit_mismatch, std::abs(terminal_net_flux)) /
        std::max({circuit_flux_scale, terminal_flux_scale, 1.0e-30});
    require(std::abs(summary_outer - outer_flux) <= 1.0e-13 &&
            std::abs(summary_electrode - electrode_relative) <= 1.0e-13 &&
            closure_complete == 1 && max_circuit_mismatch <= 1.0e-12 &&
            std::abs(terminal_net_flux) <= 1.0e-12,
        "balance summary/closure_complete is not implied by circuit rows");
    require(terminal_rows == expected_terminal_faces.size(),
        "balance artifact omitted or invented physical electrode rows");

    std::vector<std::tuple<uint8_t, std::string,
        std::array<uint64_t, 3>, std::array<uint64_t, 3>>> decoded_pairs;
    for (const auto &row : circuits) {
        if (row.kind == 2 || row.kind == 3) {
            decoded_pairs.emplace_back(
                row.kind, row.id, row.face_a, row.face_b);
        }
    }
    std::vector<std::tuple<uint8_t, std::string,
        std::array<uint64_t, 3>, std::array<uint64_t, 3>>> authored_pairs;
    for (const auto &pair : expected_pairs) authored_pairs.push_back(pair.key());
    std::sort(authored_pairs.begin(), authored_pairs.end());
    std::sort(decoded_pairs.begin(), decoded_pairs.end());
    require(decoded_pairs == authored_pairs,
        "decoded source-cut/lead pairs differ from the exact authored face map");

    std::vector<std::array<uint64_t, 3>> decoded_terminals;
    std::vector<std::array<uint64_t, 3>> decoded_outer;
    std::vector<std::array<uint64_t, 3>> expected_outer;
    std::vector<std::array<uint64_t, 3>> used_boundary_faces;
    for (const auto &pair : expected_pairs) {
        used_boundary_faces.push_back(pair.face_a);
        used_boundary_faces.push_back(pair.face_b);
    }
    used_boundary_faces.insert(used_boundary_faces.end(),
        expected_terminal_faces.begin(), expected_terminal_faces.end());
    for (const auto &row : circuits) {
        if (row.kind == 1) {
            require(row.id == expected_terminal_id,
                "terminal circuit row has the wrong authored drive ID");
            decoded_terminals.push_back(row.face_a);
        } else if (row.kind == 4) {
            decoded_outer.push_back(row.face_a);
        }
    }
    for (const auto &[key, row] : oracle.face_rows) {
        if (row.side_count == 1 && std::find(used_boundary_faces.begin(),
                used_boundary_faces.end(), key) == used_boundary_faces.end()) {
            expected_outer.push_back(key);
        }
    }
    auto sorted_unique = [](auto values) {
        std::sort(values.begin(), values.end());
        require(std::adjacent_find(values.begin(), values.end()) == values.end(),
            "decoded/authored boundary map contains duplicate face keys");
        return values;
    };
    require(sorted_unique(decoded_terminals) ==
                sorted_unique(expected_terminal_faces),
        "decoded terminal rows are not the complete authored electrode map");
    require(sorted_unique(decoded_outer) == sorted_unique(expected_outer),
        "decoded outer rows are incomplete or substitute an internal face");

    for (const auto &[key, role_and_id] : authored_roles) {
        const auto [role, circuit_id] = role_and_id;
        const uint8_t required_kind =
            role == ConservativeCurrentBoundaryRole::SourceCut ? 2 :
            role == ConservativeCurrentBoundaryRole::ClosureInterface ? 3 : 4;
        const auto match = std::find_if(circuits.begin(), circuits.end(),
            [&](const auto &row) {
                return row.kind == required_kind &&
                    (row.face_a == key || row.face_b == key) &&
                    row.id == circuit_id;
            });
        require(match != circuits.end(),
            "boundary-element role/circuit ID is absent from decoded rows");
    }
}

mfem::Vector volume_average(const mfem::GridFunction &field)
{
    mfem::Vector integral(3);
    integral = 0.0;
    double volume = 0.0;
    auto *mesh = field.FESpace()->GetMesh();
    for (int element = 0; element < mesh->GetNE(); ++element) {
        auto *transformation = mesh->GetElementTransformation(element);
        const auto &rule = mfem::IntRules.Get(
            mesh->GetElementBaseGeometry(element), 4);
        for (int q = 0; q < rule.GetNPoints(); ++q) {
            const auto &point = rule.IntPoint(q);
            transformation->SetIntPoint(&point);
            mfem::Vector value(3);
            field.GetVectorValue(*transformation, point, value);
            const double weight = point.weight * transformation->Weight();
            integral.Add(weight, value);
            volume += weight;
        }
    }
    require(volume > 0.0, "OE-T0 fixture has zero volume");
    integral /= volume;
    return integral;
}

mfem::Vector coordinate_copy(const mfem::Mesh &mesh, int vertex)
{
    mfem::Vector result(3);
    const double *coordinate = mesh.GetVertex(vertex);
    for (int component = 0; component < 3; ++component) {
        result[component] = coordinate[component];
    }
    return result;
}

mfem::Vector element_centroid(const mfem::Mesh &mesh, int element)
{
    mfem::Array<int> vertices;
    mesh.GetElementVertices(element, vertices);
    mfem::Vector centroid(3);
    centroid = 0.0;
    for (int i = 0; i < vertices.Size(); ++i) {
        const auto coordinate = coordinate_copy(mesh, vertices[i]);
        centroid += coordinate;
    }
    centroid /= static_cast<double>(vertices.Size());
    return centroid;
}

mfem::Vector evaluate_at_physical_point(
    const mfem::GridFunction &field,
    int element,
    const mfem::Vector &point)
{
    auto *transformation = field.FESpace()->GetMesh()->
        GetElementTransformation(element);
    mfem::InverseElementTransformation inverse(transformation);
    mfem::IntegrationPoint reference;
    require(inverse.Transform(point, reference) ==
            mfem::InverseElementTransformation::Inside,
        "independent oracle could not invert a face centroid");
    mfem::Vector value(3);
    field.GetVectorValue(element, reference, value);
    return value;
}

IndependentFluxOracle integrate_physical_piola_oracle(
    const mfem::GridFunction &field,
    const StableMeshVertexIdentities &ids)
{
    const auto &mesh = *field.FESpace()->GetMesh();
    require(static_cast<int>(ids.local_to_stable.size()) == mesh.GetNV(),
        "independent oracle stable-ID cardinality mismatch");
    IndependentFluxOracle oracle;
    std::vector<double> element_balance(mesh.GetNE(), 0.0);
    std::vector<double> element_denominator(mesh.GetNE(), 0.0);
    for (int face = 0; face < mesh.GetNumFaces(); ++face) {
        mfem::Array<int> face_vertices;
        mesh.GetFaceVertices(face, face_vertices);
        require(face_vertices.Size() == 3,
            "independent Piola oracle requires triangular faces");
        std::array<int, 3> local_vertices{
            face_vertices[0], face_vertices[1], face_vertices[2]};
        std::sort(local_vertices.begin(), local_vertices.end(),
            [&](int a, int b) {
                return ids.local_to_stable.at(a) <
                    ids.local_to_stable.at(b);
            });
        CanonicalFaceFluxRecord record;
        for (std::size_t i = 0; i < local_vertices.size(); ++i) {
            record.face_vertex_ids[i] =
                ids.local_to_stable.at(local_vertices[i]);
        }

        mfem::Vector p0 = coordinate_copy(mesh, local_vertices[0]);
        mfem::Vector edge1 = coordinate_copy(mesh, local_vertices[1]);
        mfem::Vector edge2 = coordinate_copy(mesh, local_vertices[2]);
        edge1 -= p0;
        edge2 -= p0;
        mfem::Vector canonical_area(3);
        canonical_area[0] = 0.5 *
            (edge1[1] * edge2[2] - edge1[2] * edge2[1]);
        canonical_area[1] = 0.5 *
            (edge1[2] * edge2[0] - edge1[0] * edge2[2]);
        canonical_area[2] = 0.5 *
            (edge1[0] * edge2[1] - edge1[1] * edge2[0]);
        require(canonical_area.Norml2() > 0.0,
            "independent oracle found a degenerate face");
        mfem::Vector face_centroid(3);
        face_centroid = p0;
        face_centroid += coordinate_copy(mesh, local_vertices[1]);
        face_centroid += coordinate_copy(mesh, local_vertices[2]);
        face_centroid /= 3.0;

        int element1 = -1;
        int element2 = -1;
        mesh.GetFaceElements(face, &element1, &element2);
        require(element1 >= 0, "face without an adjacent element");
        const auto value1 = evaluate_at_physical_point(
            field, element1, face_centroid);
        const double flux1 = value1 * canonical_area;
        record.flux_a = flux1 == 0.0 ? 0.0 : flux1;

        auto c1 = element_centroid(mesh, element1);
        c1 -= face_centroid;
        const double outward_sign1 = canonical_area * c1 < 0.0 ? 1.0 : -1.0;
        const double outward_flux1 = outward_sign1 * flux1;
        element_balance.at(element1) += outward_flux1;
        element_denominator.at(element1) += std::abs(outward_flux1);
        IndependentFluxOracle::FaceRow face_row;
        face_row.key = record.face_vertex_ids;
        face_row.side_count = element2 >= 0 ? 2 : 1;
        face_row.side1_flux_a = outward_flux1;
        if (element2 >= 0) {
            const auto value2 = evaluate_at_physical_point(
                field, element2, face_centroid);
            const double flux2 = value2 * canonical_area;
            oracle.max_internal_jump_a = std::max(
                oracle.max_internal_jump_a, std::abs(flux1 - flux2));
            auto c2 = element_centroid(mesh, element2);
            c2 -= face_centroid;
            const double outward_sign2 =
                canonical_area * c2 < 0.0 ? 1.0 : -1.0;
            const double outward_flux2 = outward_sign2 * flux2;
            element_balance.at(element2) += outward_flux2;
            element_denominator.at(element2) += std::abs(outward_flux2);
            face_row.side2_flux_a = outward_flux2;
            face_row.canonical_jump_a = outward_flux1 + outward_flux2;
            auto element_key = [&](int element) {
                mfem::Array<int> vertices;
                mesh.GetElementVertices(element, vertices);
                std::array<uint64_t, 4> key{};
                for (int i = 0; i < 4; ++i) {
                    key[i] = ids.local_to_stable.at(vertices[i]);
                }
                std::sort(key.begin(), key.end());
                return key;
            };
            if (element_key(element2) < element_key(element1)) {
                std::swap(face_row.side1_flux_a, face_row.side2_flux_a);
            }
        }
        oracle.face_rows.emplace(face_row.key, face_row);
        oracle.records.push_back(record);
    }
    std::sort(oracle.records.begin(), oracle.records.end(),
        [](const auto &a, const auto &b) {
            return a.face_vertex_ids < b.face_vertex_ids;
        });
    for (int element = 0; element < mesh.GetNE(); ++element) {
        mfem::Array<int> vertices;
        mesh.GetElementVertices(element, vertices);
        IndependentFluxOracle::ElementRow row;
        for (int i = 0; i < 4; ++i) {
            row.key[i] = ids.local_to_stable.at(vertices[i]);
        }
        std::sort(row.key.begin(), row.key.end());
        row.residual_a = element_balance.at(element);
        row.denominator_a = element_denominator.at(element);
        oracle.element_rows.emplace(row.key, row);
        const double residual = element_balance.at(element);
        oracle.max_element_divergence_a = std::max(
            oracle.max_element_divergence_a, std::abs(residual));
    }
    return oracle;
}

void orientation_conservation_and_source_cut_are_canonical()
{
    auto fixture = periodic_cube_fixture();
    auto ids = stable_vertex_ids(fixture.mesh);
    const auto identity = identity_input();
    auto request = periodic_request(fixture, ids, identity);
    require_accepted_periodic_snapshot(
        request.periodic_charge_potential, identity);
    independently_certify_periodic_field(
        *request.periodic_charge_potential,
        fixture.conductivity,
        std::get<ClosedGeometryCurrentClosure>(request.closure).
            source_cuts.front());
    const auto view = ConservativeCurrentView::Build(request);

    require(view->identity().operator_version ==
            "fem_conservative_current_rt0_view.v1",
        "wrong OE-T0 operator version");
    require(view->space().FEColl()->Name() == std::string("RT_3D_P0"),
        "OE-T0 did not construct RT0/H(div)");
    require(view->balance().max_internal_face_jump_a <=
            kAbsoluteCurrentToleranceA,
        "globally oriented shared-face flux is not single-valued");
    require(view->balance().max_element_divergence_a <=
            kAbsoluteCurrentToleranceA,
        "RT0 reconstruction is not elementwise conservative");
    require(std::abs(view->balance().net_outer_flux_a) <=
            kAbsoluteCurrentToleranceA,
        "periodic source-cut current leaked through the physical outer boundary");
    require(view->balance().electrode_balance_relative <= 1.0e-10,
        "source-cut terminal fluxes do not balance");
    require(view->balance().closure_complete,
        "periodic closed geometry was not certified complete");
    const auto average = volume_average(view->field());
    require(std::abs(average[0] - 4.0) <= 1.0e-11 &&
            std::abs(average[1]) <= 1.0e-12 &&
            std::abs(average[2]) <= 1.0e-12,
        "uniform conductor current has wrong sign or magnitude; expected "
        "J=(4,0,0) A/m^2 for V=1-x and sigma=4 S/m");

    const auto canonical_records = records(view);
    require(!canonical_records.empty(), "OE-T0 published no face-flux records");
    require(std::is_sorted(
            canonical_records.begin(), canonical_records.end(),
            [](const auto &a, const auto &b) {
                return a.face_vertex_ids < b.face_vertex_ids;
            }),
        "canonical face-flux records are not globally key-sorted");
    for (const auto &record : canonical_records) {
        require(std::isfinite(record.flux_a),
            "canonical record contains non-finite current flux");
        require(std::is_sorted(
                record.face_vertex_ids.begin(), record.face_vertex_ids.end()),
            "canonical face key does not use sorted stable vertex identities");
    }

    // This oracle starts from the physical Piola-mapped GridFunction, evaluates
    // face fluxes geometrically, and recomputes element/shared-face balances.
    // It does not consume the KKT residual or implementation certificate.
    const auto oracle = integrate_physical_piola_oracle(view->field(), ids);
    require(same_records(oracle.records, canonical_records),
        "published canonical records disagree with independent Piola quadrature");
    require(std::abs(oracle.max_internal_jump_a -
                view->balance().max_internal_face_jump_a) <= 1.0e-13,
        "certificate shared-face maximum is not independently reproducible");
    require(std::abs(oracle.max_element_divergence_a -
                view->balance().max_element_divergence_a) <= 1.0e-13,
        "certificate element balance is not independently reproducible");
    const auto &source_cut = std::get<ClosedGeometryCurrentClosure>(
        request.closure).source_cuts.front();
    std::vector<ExpectedCircuitPair> expected_pairs;
    for (const auto &pair : source_cut.face_pairs) {
        expected_pairs.push_back(ExpectedCircuitPair{2, source_cut.id,
            pair.minus_face_vertex_ids, pair.plus_face_vertex_ids});
    }
    independently_decode_and_match_balance_artifact(
        view, ids, expected_boundary_map(
            fixture.mesh, ids, request.boundary_faces), expected_pairs);
}

void layered_conductor_preserves_series_current()
{
    auto fixture = periodic_cube_fixture();
    for (int element = 0; element < fixture.mesh.GetNE(); ++element) {
        mfem::Array<int> vertices;
        fixture.mesh.GetElementVertices(element, vertices);
        double center_x = 0.0;
        for (int i = 0; i < vertices.Size(); ++i) {
            center_x += fixture.mesh.GetVertex(vertices[i])[0];
        }
        center_x /= vertices.Size();
        fixture.mesh.GetElement(element)->SetAttribute(center_x < 0.5 ? 1 : 2);
    }
    mfem::Vector conductivity_values(2);
    conductivity_values[0] = 1.0;
    conductivity_values[1] = 4.0;
    mfem::PWConstCoefficient layered_conductivity(conductivity_values);
    auto request = periodic_request(fixture,
        stable_vertex_ids(fixture.mesh), identity_input(),
        &layered_conductivity);
    const auto view = ConservativeCurrentView::Build(request);
    const auto average = volume_average(view->field());
    require(std::abs(average[0] - 1.6) <= 2.0e-10,
        "weighted RT0 reconstruction lost the analytic layered series current");
    require(view->balance().max_element_divergence_a <=
            kAbsoluteCurrentToleranceA,
        "layered RT0 current is not elementwise conservative");
    require(view->balance().electrode_balance_relative <= 1.0e-10,
        "layered periodic terminal currents do not balance");
}

void large_tetrahedral_projection_uses_sparse_kkt_lane()
{
    ChargeFixture fixture(mfem::Mesh::MakeCartesian3D(
        7, 7, 7, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0));
    require(fixture.mesh.GetNE() > 0,
        "large OE-T0 fixture did not create tetrahedra");
    const auto ids = stable_vertex_ids(fixture.mesh);
    const auto request = periodic_request(fixture, ids, identity_input());
    const auto view = ConservativeCurrentView::Build(request);
    require(view->space().GetVSize() > 4096,
        "large OE-T0 fixture did not exceed the dense-reference dof bound");
    require(std::isfinite(view->balance().scaled_kkt_residual) &&
            view->balance().scaled_kkt_residual <= 1.0e-10,
        "large OE-T0 sparse KKT residual exceeds the physical gate");
    require(view->balance().max_element_divergence_a <=
            kAbsoluteCurrentToleranceA,
        "large OE-T0 sparse KKT field is not elementwise conservative");
    require(view->balance().electrode_balance_relative <= 1.0e-10,
        "large OE-T0 sparse KKT terminal fluxes do not balance");
}

void identity_and_source_snapshot_are_immutable()
{
    ConservativeCurrentView::Ptr view;
    std::vector<CanonicalFaceFluxRecord> before;
    std::string accepted_source_revision;
    StableMeshVertexIdentities accepted_ids;
    std::vector<double> accepted_potential;
    {
        auto fixture = periodic_cube_fixture();
        auto ids = stable_vertex_ids(fixture.mesh);
        auto request = periodic_request(fixture, ids, identity_input());
        static_assert(std::is_same_v<
            decltype(request.periodic_charge_potential),
            std::shared_ptr<const PeriodicChargePotentialSnapshot>>,
            "periodic potential prerequisite must be immutable by construction");
        view = ConservativeCurrentView::Build(request);
        accepted_ids = ids;
        require(view->charge_potential_vertex_values_v() != nullptr,
            "periodic Build discarded its source charge potential");
        accepted_potential = *view->charge_potential_vertex_values_v();
        before = records(view);
        accepted_source_revision = view->identity().source_state_revision;
    }

    // Every source/request/mesh object is now destroyed. These accesses must
    // remain live, proving deep ownership rather than merely const aliases.
    require(view != nullptr, "Build returned a null accepted view");
    require(view->space().GetMesh() != nullptr &&
            view->space().GetNE() > 0 && view->field().Size() > 0,
        "accepted view did not retain a usable mesh/space/field snapshot");
    require(view->stable_vertex_identities().version == accepted_ids.version &&
            view->stable_vertex_identities().local_to_stable ==
                accepted_ids.local_to_stable,
        "owned charge potential lost its stable vertex identities");
    const auto *potential = view->charge_potential_vertex_values_v();
    require(potential != nullptr && *potential == accepted_potential &&
            potential->size() == static_cast<std::size_t>(
                view->space().GetMesh()->GetNV()),
        "owned charge potential did not survive source destruction");
    for (int vertex = 0; vertex < view->space().GetMesh()->GetNV(); ++vertex) {
        const double x = view->space().GetMesh()->GetVertex(vertex)[0];
        require(std::abs(potential->at(vertex) - (0.5 - x)) <= 1.0e-12,
            "periodic charge potential differs from its analytic gauge");
    }
    const auto average = volume_average(view->field());
    require(std::abs(average[0] - 4.0) <= 1.0e-11,
        "owned field became invalid after source fixture destruction");
    require(same_records(before, records(view)),
        "accepted OE-T0 records did not survive source destruction");
    require(view->identity().source_state_revision ==
            accepted_source_revision,
        "accepted OE-T0 identity did not survive source destruction");
    require(view->identity().evaluation_time_s == 2.5e-12 &&
            view->identity().stage_identity == 7,
        "accepted OE-T0 snapshot lost its time/stage pin");
    ConservativeCurrentView::Ptr owner;
    std::atomic_store(&owner, view);
    const auto reader_snapshot = std::atomic_load(&owner);
    require(reader_snapshot == view && reader_snapshot->field().Size() > 0,
        "transport-owner atomic_load did not retain a lifetime-safe Ptr");
}

void all_four_digests_match_independent_frozen_preimages()
{
    const Bytes abc{'a', 'b', 'c'};
    require(sha256_hex(abc) ==
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        "test-only SHA-256 oracle failed the standard known-byte vector");

    CanonicalFaceFluxRecord negative_zero_record;
    negative_zero_record.face_vertex_ids = {1, 2, 3};
    negative_zero_record.flux_a = -0.0;
    const auto zero_bytes = encode_canonical_records({negative_zero_record});
    require(zero_bytes.size() == 32 &&
            std::all_of(zero_bytes.begin() + 24, zero_bytes.end(),
                [](uint8_t byte) { return byte == 0; }),
        "canonical record oracle failed to normalize -0.0 to +0.0 bytes");

    auto fixture = periodic_cube_fixture();
    const auto view = ConservativeCurrentView::Build(periodic_request(
        fixture, stable_vertex_ids(fixture.mesh), identity_input()));
    const auto payload = encode_canonical_records(records(view));
    const auto payload_digest = sha256_hex(payload);
    require(payload_digest == view->identity().face_record_payload_sha256,
        "face_record_payload_sha256 disagrees with exact record bytes");
    const auto canonical_digest = canonical_face_digest_oracle(
        view->identity().geometry_digest, records(view).size(), payload_digest);
    require(canonical_digest == view->identity().canonical_face_digest,
        "canonical_face_digest disagrees with the sole nested preimage");
    const auto &owned_certificate = view->canonical_balance_certificate_bytes();
    const Bytes certificate_bytes(
        owned_certificate.begin(), owned_certificate.end());
    require(sha256_hex(certificate_bytes) ==
            view->identity().balance_certificate_digest,
        "balance_certificate_digest disagrees with deep-owned canonical bytes");
    require(view_identity_digest_oracle(view->identity()) ==
            view->identity().view_identity_digest,
        "view_identity_digest disagrees with its exact ordered preimage");

    ChargeFixture stronger(mfem::Mesh::MakeCartesian3D(
        2, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0));
    stronger.conductivity.constant = 8.0;
    auto stronger_identity = identity_input();
    stronger_identity.source_field_digest = "source-field-r2";
    const auto changed = ConservativeCurrentView::Build(periodic_request(
        stronger, stable_vertex_ids(stronger.mesh), stronger_identity,
        nullptr, "conductivity-r2"));
    require(view->identity().face_record_payload_sha256 !=
            changed->identity().face_record_payload_sha256 &&
            view->identity().canonical_face_digest !=
            changed->identity().canonical_face_digest &&
            view->identity().balance_certificate_digest !=
            changed->identity().balance_certificate_digest &&
            view->identity().view_identity_digest !=
            changed->identity().view_identity_digest,
        "changing physical current bytes did not change all four digest domains");
}

void current_transport_owner_is_atomic_fail_safe_and_non_aliasing()
{
    auto fixture = periodic_cube_fixture();
    mfem::H1_FECollection nodal_vector_collection(1, 3);
    mfem::FiniteElementSpace nodal_vector_space(
        &fixture.mesh, &nodal_vector_collection, 3);
    mfem::GridFunction nodal_visualization(&nodal_vector_space);
    nodal_visualization = 0.0;
    ConservativeCurrentViewOwner owner(nodal_visualization);
    require(&owner.charge_current_density() == &nodal_visualization,
        "owner did not retain the documented non-owning nodal visualization borrow");

    const auto accepted = ConservativeCurrentView::Build(periodic_request(
        fixture, stable_vertex_ids(fixture.mesh), identity_input()));
    owner.publish_accepted(accepted);
    const auto first_reader = owner.conservative_charge_current();
    require(first_reader == accepted,
        "owner did not atomically publish the accepted RT0 snapshot");
    require(&owner.charge_current_density() != &first_reader->field() &&
            owner.charge_current_density().GetData() !=
                first_reader->field().GetData(),
        "nodal visualization current aliases the conservative RT0 field");

    auto failed_build = periodic_request(
        fixture, stable_vertex_ids(fixture.mesh), identity_input());
    failed_build.pins.required_mesh_revision = "stale-mesh";
    require_rejected([&] {
        owner.publish_accepted(ConservativeCurrentView::Build(failed_build));
    }, "owner path accepted a failed/stale Build");
    require(owner.conservative_charge_current() == first_reader,
        "failed Build replaced the previous accepted owner snapshot");

    require_rejected([&] { owner.publish_accepted(nullptr); },
        "owner accepted a null/tentative publication");
    require(owner.conservative_charge_current() == first_reader,
        "failed publication discarded the previous accepted snapshot");

    mfem::RT_FECollection rt_collection(0, 3);
    mfem::FiniteElementSpace rt_space(&fixture.mesh, &rt_collection);
    mfem::GridFunction invalid_import(&rt_space);
    invalid_import = 0.0;
    invalid_import[0] = std::numeric_limits<double>::quiet_NaN();
    ConservativeCurrentImportRequest import_request;
    import_request.mesh = &fixture.mesh;
    import_request.rt0_field = &invalid_import;
    import_request.stable_vertex_identities = stable_vertex_ids(fixture.mesh);
    import_request.boundary_faces = periodic_boundary_roles(fixture.mesh);
    import_request.closure = periodic_source_cut(
        fixture.mesh, import_request.stable_vertex_identities);
    import_request.identity = identity_input();
    import_request.pins = pins_for(import_request.identity);
    require_rejected([&] {
        owner.publish_accepted(ConservativeCurrentView::Import(import_request));
    }, "owner path accepted a failed/non-finite Import");
    require(owner.conservative_charge_current() == first_reader,
        "failed Import replaced the previous accepted owner snapshot");

    auto alternate_identity = identity_input();
    alternate_identity.source_state_revision = "source-r2";
    alternate_identity.source_field_digest = "source-field-r2";
    const auto alternate = ConservativeCurrentView::Build(periodic_request(
        fixture, stable_vertex_ids(fixture.mesh), alternate_identity));
    require(alternate != accepted,
        "concurrency fixture did not produce two distinct immutable snapshots");

    std::atomic<bool> start{false};
    std::atomic<bool> done{false};
    std::atomic<bool> readers_ok{true};
    std::atomic<uint64_t> read_count{0};
    std::vector<std::thread> readers;
    for (int reader = 0; reader < 4; ++reader) {
        readers.emplace_back([&] {
            while (!start.load(std::memory_order_acquire)) {
                std::this_thread::yield();
            }
            do {
                const auto snapshot = owner.conservative_charge_current();
                if (snapshot != accepted && snapshot != alternate) {
                    readers_ok.store(false, std::memory_order_relaxed);
                }
                read_count.fetch_add(1, std::memory_order_relaxed);
            } while (!done.load(std::memory_order_acquire));
        });
    }
    std::thread writer([&] {
        while (!start.load(std::memory_order_acquire)) {
            std::this_thread::yield();
        }
        for (int iteration = 0; iteration < 5000; ++iteration) {
            owner.publish_accepted((iteration & 1) == 0 ? alternate : accepted);
        }
        done.store(true, std::memory_order_release);
    });
    start.store(true, std::memory_order_release);
    writer.join();
    for (auto &reader : readers) reader.join();
    require(readers_ok.load(std::memory_order_relaxed) && read_count > 0,
        "concurrent owner readers observed null/torn/non-accepted publication");
    const auto final_snapshot = owner.conservative_charge_current();
    require(final_snapshot == accepted || final_snapshot == alternate,
        "concurrent writer did not leave an accepted immutable snapshot");
}

void every_revision_participates_in_view_identity()
{
    auto fixture = periodic_cube_fixture();
    const auto ids = stable_vertex_ids(fixture.mesh);
    const auto baseline_identity = identity_input();
    const auto baseline = ConservativeCurrentView::Build(
        periodic_request(fixture, ids, baseline_identity));

    const auto assert_source_identity_changed = [&](const std::function<void(
                                              ConservativeCurrentIdentityInput &)> &mutate,
                                          const char *message) {
        auto candidate_identity = baseline_identity;
        mutate(candidate_identity);
        const auto candidate = ConservativeCurrentView::Build(
            periodic_request(fixture, ids, candidate_identity));
        require(candidate->identity().view_identity_digest !=
                baseline->identity().view_identity_digest,
            message);
        require(candidate->identity().canonical_face_digest ==
                baseline->identity().canonical_face_digest,
            "metadata-only revision changed canonical face-record content digest");
        require(same_records(records(candidate), records(baseline)),
            "metadata-only revision changed physical face-flux records");
    };

    assert_source_identity_changed([](auto &r) { r.source_state_revision = "source-r2"; },
        "source revision is absent from canonical view identity");
    assert_source_identity_changed([](auto &r) { r.source_field_digest = "field-r2"; },
        "source field digest is absent from canonical view identity");
    assert_source_identity_changed([](auto &r) { r.mesh_revision = "mesh-r2"; },
        "mesh revision is absent from canonical view identity");
    assert_source_identity_changed([](auto &r) { r.topology_revision = "topology-r2"; },
        "topology revision is absent from canonical view identity");
    assert_source_identity_changed([](auto &r) { r.envelope_revision = "envelope-r2"; },
        "envelope revision is absent from canonical view identity");
    assert_source_identity_changed([](auto &r) { r.envelope_digest = "envelope-digest-r2"; },
        "envelope digest is absent from canonical view identity");
    assert_source_identity_changed([](auto &r) { r.evaluation_time_s = 3.5e-12; },
        "evaluation time is absent from canonical view identity");
    assert_source_identity_changed([](auto &r) { r.stage_identity = 8; },
        "stage identity is absent from canonical view identity");

    const auto changed_closure_revision = ConservativeCurrentView::Build(
        periodic_request(fixture, ids, baseline_identity, nullptr,
            "conductivity-r1", "closure-r2", "closure-digest-r1"));
    require(changed_closure_revision->identity().view_identity_digest !=
            baseline->identity().view_identity_digest,
        "closure revision is absent from canonical view identity");
    const auto changed_closure_digest = ConservativeCurrentView::Build(
        periodic_request(fixture, ids, baseline_identity, nullptr,
            "conductivity-r1", "closure-r1", "closure-digest-r2"));
    require(changed_closure_digest->identity().view_identity_digest !=
            baseline->identity().view_identity_digest,
        "closure digest is absent from canonical view identity");

    auto changed_geometry_identity = baseline_identity;
    changed_geometry_identity.geometry_digest = "geometry-r2";
    const auto changed_geometry = ConservativeCurrentView::Build(
        periodic_request(fixture, ids, changed_geometry_identity));
    require(changed_geometry->identity().canonical_face_digest !=
            baseline->identity().canonical_face_digest,
        "geometry digest is absent from canonical face-record digest domain");

}

void validation_fails_closed()
{
    auto fixture = periodic_cube_fixture();
    const auto ids = stable_vertex_ids(fixture.mesh);
    const auto identity = identity_input();

    auto foreign_vertex_snapshot = periodic_request(fixture, ids, identity);
    auto foreign_ids = ids;
    for (auto &id : foreign_ids.local_to_stable) id += 100000;
    foreign_vertex_snapshot.periodic_charge_potential =
        periodic_request(fixture, foreign_ids, identity).periodic_charge_potential;
    require_rejected([&] {
        (void)ConservativeCurrentView::Build(foreign_vertex_snapshot);
    }, "OE-T0 accepted charge values with foreign stable vertex identities");

    auto stale = periodic_request(fixture, ids, identity);
    stale.pins.required_source_state_revision = "source-r0";
    require_rejected([&] { (void)ConservativeCurrentView::Build(stale); },
        "OE-T0 accepted a stale source revision");

    auto stale_field = periodic_request(fixture, ids, identity);
    stale_field.pins.required_source_field_digest = "source-field-r0";
    require_rejected([&] { (void)ConservativeCurrentView::Build(stale_field); },
        "OE-T0 accepted a stale source-field digest pin");

    auto stale_mesh = periodic_request(fixture, ids, identity);
    stale_mesh.pins.required_mesh_revision = "mesh-r0";
    require_rejected([&] { (void)ConservativeCurrentView::Build(stale_mesh); },
        "OE-T0 accepted a stale mesh revision pin");

    auto stale_topology = periodic_request(fixture, ids, identity);
    stale_topology.pins.required_topology_revision = "topology-r0";
    require_rejected([&] {
        (void)ConservativeCurrentView::Build(stale_topology);
    }, "OE-T0 accepted a stale topology revision pin");

    auto stale_time = periodic_request(fixture, ids, identity);
    stale_time.identity.evaluation_time_s += 1.0e-12;
    require_rejected([&] { (void)ConservativeCurrentView::Build(stale_time); },
        "OE-T0 reused a periodic potential from another evaluation time");

    auto stale_envelope = periodic_request(fixture, ids, identity);
    stale_envelope.identity.envelope_digest = "envelope-digest-r2";
    require_rejected([&] {
        (void)ConservativeCurrentView::Build(stale_envelope);
    }, "OE-T0 reused a periodic potential from another envelope identity");

    auto duplicate_ids = periodic_request(fixture, ids, identity);
    duplicate_ids.stable_vertex_identities.local_to_stable[1] =
        duplicate_ids.stable_vertex_identities.local_to_stable[0];
    require_rejected([&] { (void)ConservativeCurrentView::Build(duplicate_ids); },
        "OE-T0 accepted duplicate stable mesh vertex identities");

    auto id_coordinate_mismatch = periodic_request(fixture, ids, identity);
    auto &mismatched_pair = std::get<ClosedGeometryCurrentClosure>(
        id_coordinate_mismatch.closure).source_cuts.front().face_pairs.front();
    mismatched_pair.plus_face_vertex_ids[0] =
        id_coordinate_mismatch.stable_vertex_identities.local_to_stable.back();
    std::sort(mismatched_pair.plus_face_vertex_ids.begin(),
        mismatched_pair.plus_face_vertex_ids.end());
    require_rejected([&] {
        (void)ConservativeCurrentView::Build(id_coordinate_mismatch);
    }, "OE-T0 accepted stable face IDs whose certified coordinates do not match");

    auto unpaired_terminal = periodic_request(fixture, ids, identity);
    auto &cut = std::get<ClosedGeometryCurrentClosure>(
        unpaired_terminal.closure).source_cuts.front();
    cut.face_pairs.pop_back();
    require_rejected([&] {
        (void)ConservativeCurrentView::Build(unpaired_terminal);
    }, "OE-T0 accepted an unpaired source-cut terminal face");

    auto raw_periodic_p1 = periodic_request(fixture, ids, identity);
    mfem::H1_FECollection raw_h1_collection(1, 3);
    mfem::FiniteElementSpace raw_h1_space(&fixture.mesh, &raw_h1_collection);
    mfem::GridFunction raw_h1_potential(&raw_h1_space);
    raw_h1_potential = 0.0;
    raw_periodic_p1.periodic_charge_potential.reset();
    raw_periodic_p1.raw_single_valued_potential = &raw_h1_potential;
    require_rejected([&] {
        (void)ConservativeCurrentView::Build(raw_periodic_p1);
    }, "OE-T0 let a raw single-valued H1 field impersonate an accepted "
       "fem_charge_h1_periodic_jump.v1 solve");

    auto closure_without_drive = periodic_request(fixture, ids, identity);
    closure_without_drive.periodic_charge_potential.reset();
    require_rejected([&] {
        (void)ConservativeCurrentView::Build(closure_without_drive);
    }, "closed_geometry authored nonzero current without any drive");

    auto invented_excitation = periodic_request(fixture, ids, identity);
    std::get<ClosedGeometryCurrentClosure>(invented_excitation.closure).
        source_cuts.front().potential_drop_v = -2.0;
    require_rejected([&] {
        (void)ConservativeCurrentView::Build(invented_excitation);
    }, "OE-T0 accepted a cut excitation invented independently of its H1 solve");

    auto orientation_mismatch = periodic_request(fixture, ids, identity);
    std::get<ClosedGeometryCurrentClosure>(orientation_mismatch.closure).
        source_cuts.front().translation_m = {-1.0, 0.0, 0.0};
    require_rejected([&] {
        (void)ConservativeCurrentView::Build(orientation_mismatch);
    }, "OE-T0 accepted a source-cut geometry/orientation mismatch");

    mfem::RT_FECollection pairing_rt_collection(0, 3);
    mfem::FiniteElementSpace pairing_rt_space(
        &fixture.mesh, &pairing_rt_collection);
    mfem::GridFunction pairing_rt_field(&pairing_rt_space);
    mfem::Vector exact_pairing_current(3);
    exact_pairing_current = 0.0;
    exact_pairing_current[0] = 4.0;
    mfem::VectorConstantCoefficient exact_pairing_coefficient(
        exact_pairing_current);
    pairing_rt_field.ProjectCoefficient(exact_pairing_coefficient);
    ConservativeCurrentImportRequest multiply_paired;
    multiply_paired.mesh = &fixture.mesh;
    multiply_paired.rt0_field = &pairing_rt_field;
    multiply_paired.stable_vertex_identities = ids;
    multiply_paired.boundary_faces = periodic_boundary_roles(fixture.mesh);
    multiply_paired.closure = periodic_source_cut(fixture.mesh, ids);
    auto duplicate_cut = std::get<ClosedGeometryCurrentClosure>(
        multiply_paired.closure).source_cuts.front();
    // This is a physical topology error, not the rank oracle: every cut face
    // is authored twice and must be rejected by the unique-pairing gate.
    std::get<ClosedGeometryCurrentClosure>(multiply_paired.closure).
        source_cuts.push_back(duplicate_cut);
    multiply_paired.identity = identity;
    multiply_paired.pins = pins_for(identity);
    multiply_paired.require_independent_physical_certificate = true;
    require_rejected([&] {
        (void)ConservativeCurrentView::Import(multiply_paired);
    }, "OE-T0 accepted source-cut faces paired more than once");

    auto invalid_periodic_solve = PeriodicChargePotentialSolveRequest{};
    invalid_periodic_solve.mesh = &fixture.mesh;
    invalid_periodic_solve.conductivity = &fixture.conductivity;
    invalid_periodic_solve.stable_vertex_identities = ids;
    invalid_periodic_solve.boundary_faces = periodic_boundary_roles(fixture.mesh);
    invalid_periodic_solve.source_cut =
        std::get<ClosedGeometryCurrentClosure>(
            raw_periodic_p1.closure).source_cuts.front();
    invalid_periodic_solve.source_cut.face_pairs.pop_back();
    invalid_periodic_solve.operator_version = "fem_charge_h1_periodic_jump.v1";
    invalid_periodic_solve.algebraic_relative_tolerance = 1.0e-12;
    invalid_periodic_solve.maximum_iterations = 1000;
    require_rejected([&] {
        (void)PeriodicChargePotentialSolver::Solve(invalid_periodic_solve);
    }, "periodic charge solver accepted an incomplete stable face-key map");

    auto missing_boundary_role = periodic_request(fixture, ids, identity);
    missing_boundary_role.boundary_faces.pop_back();
    require_rejected([&] {
        (void)ConservativeCurrentView::Build(missing_boundary_role);
    }, "OE-T0 accepted an unclassified physical boundary face");

    ChargeFixture degenerate_fixture(mfem::Mesh::MakeCartesian3D(
        3, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0));
    int collapse_from = -1;
    int collapse_to = -1;
    for (int element = 0; element < degenerate_fixture.mesh.GetNE() &&
            collapse_from < 0; ++element) {
        mfem::Array<int> vertices;
        degenerate_fixture.mesh.GetElementVertices(element, vertices);
        for (int i = 0; i < vertices.Size() && collapse_from < 0; ++i) {
            for (int j = i + 1; j < vertices.Size(); ++j) {
                const double xi = degenerate_fixture.mesh.GetVertex(vertices[i])[0];
                const double xj = degenerate_fixture.mesh.GetVertex(vertices[j])[0];
                if (xi > 1.0e-13 && xi < 1.0 - 1.0e-13 &&
                    std::abs(xi - xj) <= 1.0e-13) {
                    collapse_to = vertices[i];
                    collapse_from = vertices[j];
                    break;
                }
            }
        }
    }
    require(collapse_from >= 0,
        "degenerate oracle could not find an interior same-plane tetra edge");
    for (int component = 0; component < 3; ++component) {
        degenerate_fixture.mesh.GetVertex(collapse_from)[component] =
            degenerate_fixture.mesh.GetVertex(collapse_to)[component];
    }
    const auto degenerate_ids = stable_vertex_ids(degenerate_fixture.mesh);
    PeriodicChargePotentialSolveRequest degenerate_solve;
    degenerate_solve.mesh = &degenerate_fixture.mesh;
    degenerate_solve.conductivity = &degenerate_fixture.conductivity;
    degenerate_solve.stable_vertex_identities = degenerate_ids;
    degenerate_solve.boundary_faces =
        periodic_boundary_roles(degenerate_fixture.mesh);
    degenerate_solve.source_cut = periodic_source_cut(
        degenerate_fixture.mesh, degenerate_ids).source_cuts.front();
    degenerate_solve.operator_version = "fem_charge_h1_periodic_jump.v1";
    degenerate_solve.mesh_revision = identity.mesh_revision;
    degenerate_solve.geometry_digest = identity.geometry_digest;
    degenerate_solve.conductivity_digest = "conductivity-r1";
    degenerate_solve.source_cut_digest = "closure-digest-r1";
    degenerate_solve.source_module_id = identity.source_module_id;
    degenerate_solve.source_state_revision = identity.source_state_revision;
    degenerate_solve.source_field_digest = identity.source_field_digest;
    degenerate_solve.evaluation_time_s = identity.evaluation_time_s;
    degenerate_solve.stage_identity = identity.stage_identity;
    degenerate_solve.envelope_revision = identity.envelope_revision;
    degenerate_solve.envelope_digest = identity.envelope_digest;
    degenerate_solve.evaluated_envelope_multiplier =
        identity.evaluated_envelope_multiplier;
    degenerate_solve.algebraic_relative_tolerance = 1.0e-12;
    degenerate_solve.maximum_iterations = 1000;
    require_rejected([&] {
        (void)PeriodicChargePotentialSolver::Solve(degenerate_solve);
    }, "periodic H1 solver accepted a pre-existing degenerate tetrahedron");

}

void non_tetrahedral_mesh_is_rejected()
{
    ChargeFixture fixture(mfem::Mesh::MakeCartesian3D(
        1, 1, 1, mfem::Element::HEXAHEDRON, 1.0, 1.0, 1.0));
    const auto identity = identity_input();
    ConservativeCurrentBuildRequest request;
    request.mesh = &fixture.mesh;
    request.conductivity = &fixture.conductivity;
    request.identity = identity;
    request.pins = pins_for(identity);
    require_rejected([&] { (void)ConservativeCurrentView::Build(request); },
        "OE-T0 accepted non-tetrahedral input");
}

void curved_high_order_mesh_is_rejected_by_affine_v1()
{
    auto mesh = mfem::Mesh::MakeCartesian3D(
        1, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    mesh.SetCurvature(2);
    ChargeFixture fixture(std::move(mesh));
    const auto identity = identity_input();
    ConservativeCurrentBuildRequest request;
    request.mesh = &fixture.mesh;
    request.conductivity = &fixture.conductivity;
    request.identity = identity;
    request.pins = pins_for(identity);
    require_rejected([&] { (void)ConservativeCurrentView::Build(request); },
        "fem_conservative_current_rt0_view.v1 accepted curved/high-order "
        "geometry even though its canonical normal and affine RT0 contract "
        "are restricted to straight-sided tetrahedra");
}

void imported_rt0_nonfinite_dof_is_rejected()
{
    auto fixture = periodic_cube_fixture();
    mfem::RT_FECollection rt_collection(0, 3);
    mfem::FiniteElementSpace rt_space(&fixture.mesh, &rt_collection);
    mfem::GridFunction imported(&rt_space);
    imported = 0.0;
    imported[0] = std::numeric_limits<double>::quiet_NaN();

    ConservativeCurrentImportRequest request;
    request.mesh = &fixture.mesh;
    request.rt0_field = &imported;
    request.stable_vertex_identities = stable_vertex_ids(fixture.mesh);
    request.boundary_faces = periodic_boundary_roles(fixture.mesh);
    request.closure = periodic_source_cut(
        fixture.mesh, request.stable_vertex_identities);
    request.identity = identity_input();
    request.pins = pins_for(request.identity);
    require_rejected([&] { (void)ConservativeCurrentView::Import(request); },
        "OE-T0 accepted a non-finite imported RT0 degree of freedom");
    imported[0] = std::numeric_limits<double>::infinity();
    require_rejected([&] { (void)ConservativeCurrentView::Import(request); },
        "OE-T0 accepted an infinite imported RT0 degree of freedom");
}

void certified_imported_rt0_is_accepted_and_deep_owned()
{
    ConservativeCurrentView::Ptr imported_view;
    StableMeshVertexIdentities ids;
    std::vector<ExpectedBoundaryFace> boundary_roles;
    std::vector<ExpectedCircuitPair> expected_pairs;
    {
        auto fixture = periodic_cube_fixture();
        ids = stable_vertex_ids(fixture.mesh);
        mfem::RT_FECollection rt_collection(0, 3);
        mfem::FiniteElementSpace rt_space(&fixture.mesh, &rt_collection);
        mfem::GridFunction imported(&rt_space);
        mfem::Vector current(3);
        current = 0.0;
        current[0] = 4.0;
        mfem::VectorConstantCoefficient exact_current(current);
        imported.ProjectCoefficient(exact_current);

        ConservativeCurrentImportRequest request;
        request.mesh = &fixture.mesh;
        request.rt0_field = &imported;
        request.stable_vertex_identities = ids;
        request.boundary_faces = periodic_boundary_roles(fixture.mesh);
        request.closure = periodic_source_cut(fixture.mesh, ids);
        boundary_roles = expected_boundary_map(
            fixture.mesh, ids, request.boundary_faces);
        const auto &source_cut = std::get<ClosedGeometryCurrentClosure>(
            request.closure).source_cuts.front();
        for (const auto &pair : source_cut.face_pairs) {
            expected_pairs.push_back(ExpectedCircuitPair{2, source_cut.id,
                pair.minus_face_vertex_ids, pair.plus_face_vertex_ids});
        }
        request.identity = identity_input();
        request.pins = pins_for(request.identity);
        request.require_independent_physical_certificate = true;
        imported_view = ConservativeCurrentView::Import(request);
        require(imported_view->charge_potential_vertex_values_v() == nullptr,
            "RT0-only import fabricated charge-potential provenance");
    }
    require(imported_view != nullptr && imported_view->balance().closure_complete,
        "finite closed imported RT0 field was not independently certified");
    require(imported_view->charge_potential_vertex_values_v() == nullptr &&
            imported_view->stable_vertex_identities().version == ids.version &&
            imported_view->stable_vertex_identities().local_to_stable ==
                ids.local_to_stable,
        "RT0-only import lost stable IDs or fabricated a charge potential");
    require(imported_view->balance().max_element_divergence_a <= 1.0e-12 &&
            imported_view->balance().max_internal_face_jump_a <= 1.0e-12,
        "certified imported RT0 field failed conservation");
    require(std::abs(volume_average(imported_view->field())[0] - 4.0) <= 1.0e-12,
        "certified imported RT0 field did not survive caller destruction");
    const auto oracle = integrate_physical_piola_oracle(
        imported_view->field(), ids);
    require(same_records(oracle.records, records(imported_view)),
        "import certificate does not match independent field-to-record oracle");
    independently_decode_and_match_balance_artifact(
        imported_view, ids, boundary_roles, expected_pairs);
}

void incomplete_external_lead_extension_fails_closed()
{
    auto conductor = periodic_cube_fixture();
    auto leads = periodic_cube_fixture();
    auto conductor_ids = stable_vertex_ids(conductor.mesh);
    auto lead_ids = stable_vertex_ids(leads.mesh);
    for (auto &id : lead_ids.local_to_stable) {
        id += 100000;
    }

    ExternalLeadExtensionCurrentClosure closure;
    closure.operator_version = "fem_closed_current_extension.v1";
    closure.revision = "lead-r1";
    closure.digest = "lead-digest-r1";
    closure.lead_mesh = &leads.mesh;
    closure.lead_conductivity = &leads.conductivity;
    closure.lead_vertex_identities = lead_ids;

    auto conductor_faces = boundary_elements_on_x(conductor.mesh, 0.0);
    const auto conductor_plus = boundary_elements_on_x(conductor.mesh, 1.0);
    conductor_faces.insert(
        conductor_faces.end(), conductor_plus.begin(), conductor_plus.end());
    auto lead_faces = boundary_elements_on_x(leads.mesh, 0.0);
    const auto lead_plus = boundary_elements_on_x(leads.mesh, 1.0);
    lead_faces.insert(lead_faces.end(), lead_plus.begin(), lead_plus.end());
    require(conductor_faces.size() == lead_faces.size(),
        "external-lead fixture faces do not pair");
    // Leave one face deliberately unpaired. This fixture is a validation RED,
    // not a claim that two independently solved open bars form a qualified
    // composite closure.
    for (std::size_t i = 0; i + 1 < conductor_faces.size(); ++i) {
        ExternalLeadInterfacePair pair;
        pair.transport_face_vertex_ids = sorted_face_key(
            conductor.mesh, conductor_ids, conductor_faces[i]);
        pair.lead_face_vertex_ids = sorted_face_key(
            leads.mesh, lead_ids, lead_faces[i]);
        closure.interface_pairs.push_back(pair);
    }

    auto request = periodic_request(conductor, conductor_ids, identity_input());
    request.closure = closure;
    request.periodic_charge_potential.reset();
    for (auto &face : request.boundary_faces) {
        if (std::find(conductor_faces.begin(), conductor_faces.end(),
                face.boundary_element) != conductor_faces.end()) {
            face.role = ConservativeCurrentBoundaryRole::ClosureInterface;
            face.circuit_id = "external-lead-interface";
        }
    }
    require_rejected([&] { (void)ConservativeCurrentView::Build(request); },
        "OE-T0 accepted an incomplete external-lead interface map");
}

mfem::Mesh shifted_unit_cube(double x_min, int attribute)
{
    auto mesh = mfem::Mesh::MakeCartesian3D(
        2, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        mesh.GetVertex(vertex)[0] += x_min;
    }
    for (int element = 0; element < mesh.GetNE(); ++element) {
        mesh.GetElement(element)->SetAttribute(attribute);
    }
    return mesh;
}

mfem::Mesh combine_disjoint_tetrahedral_meshes(
    const mfem::Mesh &left,
    const mfem::Mesh &right)
{
    mfem::Mesh output(3, left.GetNV() + right.GetNV(),
        left.GetNE() + right.GetNE(), left.GetNBE() + right.GetNBE(), 3);
    const auto append = [&](const mfem::Mesh &mesh, int vertex_offset) {
        for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
            const auto coordinate = coordinate_copy(mesh, vertex);
            output.AddVertex(coordinate.GetData());
        }
        for (int element = 0; element < mesh.GetNE(); ++element) {
            mfem::Array<int> vertices;
            mesh.GetElementVertices(element, vertices);
            int tet[4]{vertices[0] + vertex_offset, vertices[1] + vertex_offset,
                vertices[2] + vertex_offset, vertices[3] + vertex_offset};
            output.AddTet(tet, mesh.GetElement(element)->GetAttribute());
        }
        for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
            mfem::Array<int> vertices;
            mesh.GetBdrElementVertices(boundary, vertices);
            int triangle[3]{vertices[0] + vertex_offset,
                vertices[1] + vertex_offset, vertices[2] + vertex_offset};
            output.AddBdrTriangle(triangle,
                mesh.GetBdrElement(boundary)->GetAttribute());
        }
    };
    append(left, 0);
    append(right, left.GetNV());
    output.FinalizeTetMesh(1, 1, true);
    return output;
}

using BigInteger = boost::multiprecision::cpp_int;
using ExactIntegerMatrix = std::vector<std::vector<BigInteger>>;

std::size_t bareiss_exact_rank(ExactIntegerMatrix matrix)
{
    if (matrix.empty() || matrix.front().empty()) return 0;
    const std::size_t row_count = matrix.size();
    const std::size_t column_count = matrix.front().size();
    for (const auto &row : matrix) {
        require(row.size() == column_count,
            "Bareiss oracle received a ragged integer matrix");
    }
    std::size_t pivot_row = 0;
    BigInteger previous_pivot = 1;
    for (std::size_t column = 0;
            column < column_count && pivot_row < row_count; ++column) {
        std::size_t selected = pivot_row;
        while (selected < row_count && matrix[selected][column] == 0) ++selected;
        if (selected == row_count) continue;
        if (selected != pivot_row) std::swap(matrix[selected], matrix[pivot_row]);
        const BigInteger pivot = matrix[pivot_row][column];
        for (std::size_t row = pivot_row + 1; row < row_count; ++row) {
            for (std::size_t next = column + 1; next < column_count; ++next) {
                const BigInteger numerator = matrix[row][next] * pivot -
                    matrix[row][column] * matrix[pivot_row][next];
                require(numerator % previous_pivot == 0,
                    "fraction-free Bareiss oracle lost exact divisibility");
                matrix[row][next] = numerator / previous_pivot;
            }
            matrix[row][column] = 0;
        }
        previous_pivot = pivot;
        ++pivot_row;
    }
    return pivot_row;
}

std::array<uint64_t, 4> stable_element_key(const mfem::Mesh &mesh,
    const StableMeshVertexIdentities &ids, int element)
{
    mfem::Array<int> vertices;
    mesh.GetElementVertices(element, vertices);
    require(vertices.Size() == 4, "exact D oracle requires tetrahedra");
    std::array<uint64_t, 4> key{};
    for (int i = 0; i < 4; ++i) key[i] = ids.local_to_stable.at(vertices[i]);
    std::sort(key.begin(), key.end());
    return key;
}

std::array<uint64_t, 3> stable_mesh_face_key(const mfem::Mesh &mesh,
    const StableMeshVertexIdentities &ids, int face)
{
    mfem::Array<int> vertices;
    mesh.GetFaceVertices(face, vertices);
    require(vertices.Size() == 3, "exact D oracle requires triangular faces");
    std::array<uint64_t, 3> key{};
    for (int i = 0; i < 3; ++i) key[i] = ids.local_to_stable.at(vertices[i]);
    std::sort(key.begin(), key.end());
    return key;
}

std::string divergence_row_id(const std::array<uint64_t, 4> &key)
{
    std::ostringstream output;
    output << "divergence";
    for (const auto id : key) output << ':' << id;
    return output.str();
}

int canonical_face_outward_sign(const mfem::Mesh &mesh,
    const StableMeshVertexIdentities &ids, int face, int element)
{
    mfem::Array<int> vertices;
    mesh.GetFaceVertices(face, vertices);
    std::array<int, 3> ordered{vertices[0], vertices[1], vertices[2]};
    std::sort(ordered.begin(), ordered.end(), [&](int left, int right) {
        return ids.local_to_stable.at(left) < ids.local_to_stable.at(right);
    });
    const auto p0 = coordinate_copy(mesh, ordered[0]);
    auto e1 = coordinate_copy(mesh, ordered[1]);
    auto e2 = coordinate_copy(mesh, ordered[2]);
    e1 -= p0;
    e2 -= p0;
    mfem::Vector canonical_area(3);
    canonical_area[0] = e1[1] * e2[2] - e1[2] * e2[1];
    canonical_area[1] = e1[2] * e2[0] - e1[0] * e2[2];
    canonical_area[2] = e1[0] * e2[1] - e1[1] * e2[0];
    mfem::Vector face_center(3);
    face_center = 0.0;
    for (int i = 0; i < 3; ++i) face_center += coordinate_copy(mesh, vertices[i]);
    face_center /= 3.0;
    auto inward = element_centroid(mesh, element);
    inward -= face_center;
    const double orientation = canonical_area * inward;
    require(std::abs(orientation) > 1.0e-15,
        "exact D oracle found a degenerate face orientation");
    return orientation < 0.0 ? 1 : -1;
}

struct ExactPhysicalConstraintOracle {
    ExactIntegerMatrix matrix;
    std::vector<std::string> row_ids;
    std::size_t divergence_rows = 0;
    std::size_t source_cut_rows = 0;
    std::size_t rank = 0;
    std::vector<std::array<uint64_t, 4>> component_anchors;
    std::vector<std::string> omitted_divergence_ids;
};

ExactPhysicalConstraintOracle assemble_exact_physical_constraint_oracle(
    const mfem::Mesh &mesh,
    const StableMeshVertexIdentities &ids,
    const std::vector<ExpectedBoundaryFace> &boundary_map,
    const ClosedGeometryCurrentClosure &closure)
{
    std::map<std::array<uint64_t, 3>, ConservativeCurrentBoundaryRole> roles;
    for (const auto &boundary : boundary_map) roles.emplace(boundary.key, boundary.role);

    std::vector<std::array<uint64_t, 3>> free_columns;
    std::map<std::array<uint64_t, 3>, int> key_to_face;
    for (int face = 0; face < mesh.GetNumFaces(); ++face) {
        const auto key = stable_mesh_face_key(mesh, ids, face);
        int element1 = -1;
        int element2 = -1;
        mesh.GetFaceElements(face, &element1, &element2);
        const bool insulating_boundary = element2 < 0 &&
            roles.at(key) == ConservativeCurrentBoundaryRole::InsulatingOuter;
        if (!insulating_boundary) free_columns.push_back(key);
        key_to_face.emplace(key, face);
    }
    std::sort(free_columns.begin(), free_columns.end());
    require(std::adjacent_find(free_columns.begin(), free_columns.end()) ==
            free_columns.end(), "exact D oracle found duplicate free face columns");
    std::map<std::array<uint64_t, 3>, std::size_t> column_index;
    for (std::size_t column = 0; column < free_columns.size(); ++column) {
        column_index.emplace(free_columns[column], column);
    }

    std::vector<std::pair<std::array<uint64_t, 4>, int>> elements;
    for (int element = 0; element < mesh.GetNE(); ++element) {
        elements.emplace_back(stable_element_key(mesh, ids, element), element);
    }
    std::sort(elements.begin(), elements.end());
    ExactPhysicalConstraintOracle oracle;
    oracle.divergence_rows = elements.size();
    for (const auto &[element_key, element] : elements) {
        std::vector<BigInteger> row(free_columns.size(), 0);
        for (int face = 0; face < mesh.GetNumFaces(); ++face) {
            int element1 = -1;
            int element2 = -1;
            mesh.GetFaceElements(face, &element1, &element2);
            if (element != element1 && element != element2) continue;
            const auto key = stable_mesh_face_key(mesh, ids, face);
            const auto column = column_index.find(key);
            if (column != column_index.end()) {
                row[column->second] = canonical_face_outward_sign(
                    mesh, ids, face, element);
            }
        }
        oracle.row_ids.push_back(divergence_row_id(element_key));
        oracle.matrix.push_back(std::move(row));
    }

    struct CutRow {
        std::string id;
        std::array<uint64_t, 3> minus{};
        std::array<uint64_t, 3> plus{};
    };
    std::vector<CutRow> cut_rows;
    for (const auto &cut : closure.source_cuts) {
        for (const auto &pair : cut.face_pairs) {
            cut_rows.push_back(CutRow{cut.id,
                pair.minus_face_vertex_ids, pair.plus_face_vertex_ids});
        }
    }
    std::sort(cut_rows.begin(), cut_rows.end(), [](const auto &left, const auto &right) {
        return std::tie(left.id, left.minus, left.plus) <
            std::tie(right.id, right.minus, right.plus);
    });
    oracle.source_cut_rows = cut_rows.size();
    for (const auto &cut : cut_rows) {
        std::vector<BigInteger> row(free_columns.size(), 0);
        for (const auto &key : {cut.minus, cut.plus}) {
            const int face = key_to_face.at(key);
            int element1 = -1;
            int element2 = -1;
            mesh.GetFaceElements(face, &element1, &element2);
            require(element1 >= 0 && element2 < 0,
                "source-cut C row did not reference a physical boundary face");
            row[column_index.at(key)] = canonical_face_outward_sign(
                mesh, ids, face, element1);
        }
        std::ostringstream id;
        id << "source-cut:" << cut.id;
        for (const auto value : cut.minus) id << ':' << value;
        for (const auto value : cut.plus) id << ':' << value;
        oracle.row_ids.push_back(id.str());
        oracle.matrix.push_back(std::move(row));
    }
    oracle.rank = bareiss_exact_rank(oracle.matrix);

    std::vector<std::vector<int>> adjacency(mesh.GetNE());
    for (int face = 0; face < mesh.GetNumFaces(); ++face) {
        int first = -1;
        int second = -1;
        mesh.GetFaceElements(face, &first, &second);
        if (first >= 0 && second >= 0) {
            adjacency[first].push_back(second);
            adjacency[second].push_back(first);
        }
    }
    std::vector<bool> visited(mesh.GetNE(), false);
    for (int seed = 0; seed < mesh.GetNE(); ++seed) {
        if (visited[seed]) continue;
        std::vector<int> stack{seed};
        visited[seed] = true;
        auto anchor = stable_element_key(mesh, ids, seed);
        while (!stack.empty()) {
            const int element = stack.back();
            stack.pop_back();
            anchor = std::min(anchor, stable_element_key(mesh, ids, element));
            for (const int peer : adjacency[element]) if (!visited[peer]) {
                visited[peer] = true;
                stack.push_back(peer);
            }
        }
        oracle.component_anchors.push_back(anchor);
        oracle.omitted_divergence_ids.push_back(divergence_row_id(anchor));
    }
    std::sort(oracle.component_anchors.begin(), oracle.component_anchors.end());
    std::sort(oracle.omitted_divergence_ids.begin(),
        oracle.omitted_divergence_ids.end());
    return oracle;
}

void charge_trace_workspace_preserves_component_gauges_and_weak_reactions()
{
    using fullmag::fem::antenna_field_solve::ChargeTraceSolveRequest;
    using fullmag::fem::antenna_field_solve::ChargeTraceSolution;
    using fullmag::fem::antenna_field_solve::solve_charge_trace_workspace;
    std::shared_ptr<const ChargeTraceSolution> accepted;
    {
        auto lower = shifted_unit_cube(0.0, 1);
        auto upper = shifted_unit_cube(0.0, 1);
        auto isolated = shifted_unit_cube(0.0, 1);
        for (int vertex = 0; vertex < upper.GetNV(); ++vertex) upper.GetVertex(vertex)[1] += 2.0;
        for (int vertex = 0; vertex < isolated.GetNV(); ++vertex) isolated.GetVertex(vertex)[1] += 4.0;
        const auto pair = combine_disjoint_tetrahedral_meshes(lower, upper);
        ChargeFixture fixture(combine_disjoint_tetrahedral_meshes(pair, isolated));
        mfem::H1_FECollection collection(1, 3);
        mfem::FiniteElementSpace space(&fixture.mesh, &collection);
        ChargeTraceSolveRequest request;
        request.mesh = &fixture.mesh;
        request.conductivity = &fixture.conductivity;
        request.stable_vertex_identities = coordinate_stable_vertex_ids(fixture.mesh);
        for (int minus = 0; minus < fixture.mesh.GetNV(); ++minus) {
            const auto *position = fixture.mesh.GetVertex(minus);
            if (position[0] != 0.0 || position[1] >= 3.5) continue;
            for (int plus = 0; plus < fixture.mesh.GetNV(); ++plus) {
                const auto *peer = fixture.mesh.GetVertex(plus);
                if (peer[0] != 1.0 || peer[1] != position[1] || peer[2] != position[2]) continue;
                mfem::Array<int> minus_dofs, plus_dofs;
                space.GetVertexDofs(minus, minus_dofs);
                space.GetVertexDofs(plus, plus_dofs);
                request.trace_relations.push_back({minus_dofs[0], plus_dofs[0],
                    position[1] < 1.5 ? 2.0 : -1.0e-4,
                    "component-cut:" + std::to_string(minus)});
            }
        }
        accepted = solve_charge_trace_workspace(request);
        require(accepted->gauge_vertex_ids.size() == 3 && accepted->component_ids.size() == 3,
            "charge trace solve did not gauge both driven and isolated components");
        for (int component = 0; component < 3; ++component) {
            require(accepted->component_relative_residuals[static_cast<std::size_t>(component)] <= 1.0e-12,
                "charge trace per-component independent residual failed");
        }
        mfem::Array<int> anchor_dofs;
        // Use the H1 map, not the mesh vertex number, for an explicit voltage anchor.
        space.GetVertexDofs(0, anchor_dofs);
        request.potential_anchors.push_back({anchor_dofs[0], 5.0});
        const auto anchored = solve_charge_trace_workspace(request);
        require(anchored->gauge_vertex_ids.size() == 2 &&
                std::abs(anchored->potential_vertex_values_v[0] - 5.0) <= 1.0e-12,
            "charge trace solve added a gauge to an already anchored component");
    }
    std::map<std::uint64_t, std::array<double, 3>> gauge_positions;
    for (std::size_t vertex = 0; vertex < accepted->vertex_positions_m.size(); ++vertex) {
        const auto id = accepted->stable_vertex_identities.local_to_stable[vertex];
        if (std::find(accepted->gauge_vertex_ids.begin(), accepted->gauge_vertex_ids.end(), id) !=
            accepted->gauge_vertex_ids.end()) gauge_positions[id] = accepted->vertex_positions_m[vertex];
    }
    std::array<std::array<double, 2>, 3> outward_currents{};
    for (std::size_t vertex = 0; vertex < accepted->vertex_positions_m.size(); ++vertex) {
        const auto position = accepted->vertex_positions_m[vertex];
        const int component = position[1] < 1.5 ? 0 : position[1] < 3.5 ? 1 : 2;
        const double jump = component == 0 ? 2.0 : component == 1 ? -1.0e-4 : 0.0;
        const auto gauge = gauge_positions.at(accepted->vertex_component_ids[vertex]);
        require(std::abs(accepted->potential_vertex_values_v[vertex] -
                    jump * (position[0] - gauge[0])) <= 1.0e-10 * std::max(std::abs(jump), 1.0e-12),
            "owned charge trace potential is not the affine component solution");
        if (position[0] == 0.0 || position[0] == 1.0) {
            outward_currents[static_cast<std::size_t>(component)][position[0] == 0.0 ? 0 : 1] -=
                accepted->reaction_vertex_values_a[vertex];
        }
    }
    for (int component = 0; component < 3; ++component) {
        const double current = component == 0 ? 8.0 : component == 1 ? -4.0e-4 : 0.0;
        const double tolerance = std::abs(current) * 1.0e-8 + 1.0e-18;
        require(std::abs(outward_currents[static_cast<std::size_t>(component)][0] - current) <= tolerance &&
                std::abs(outward_currents[static_cast<std::size_t>(component)][1] + current) <= tolerance,
            "charge trace weak reactions lost sign or hid a small component current");
    }
}

void charge_trace_workspace_rejects_jumps_lost_after_anchoring()
{
    using fullmag::fem::antenna_field_solve::ChargeTraceSolveRequest;
    using fullmag::fem::antenna_field_solve::solve_charge_trace_workspace;
    mfem::Mesh mesh(3, 4, 1, 4, 3);
    const double coordinates[4][3] = {{0.0, 0.0, 0.0}, {1.0, 0.0, 0.0},
        {0.0, 1.0, 0.0}, {0.0, 0.0, 1.0}};
    for (const auto &position : coordinates) mesh.AddVertex(position);
    int vertices[4] = {0, 1, 2, 3};
    mesh.AddTet(vertices, 1);
    int faces[4][3] = {{0, 2, 1}, {0, 1, 3}, {0, 3, 2}, {1, 2, 3}};
    for (auto &face : faces) mesh.AddBdrTriangle(face, 1);
    mesh.FinalizeTetMesh(1, 1, true);
    mfem::H1_FECollection collection(1, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    mfem::ConstantCoefficient conductivity(4.0);
    ChargeTraceSolveRequest request;
    request.mesh = &mesh;
    request.conductivity = &conductivity;
    request.stable_vertex_identities = coordinate_stable_vertex_ids(mesh);
    mfem::Array<int> root_dofs;
    space.GetVertexDofs(0, root_dofs);
    for (int vertex = 1; vertex < mesh.GetNV(); ++vertex) {
        mfem::Array<int> dofs;
        space.GetVertexDofs(vertex, dofs);
        request.trace_relations.push_back({root_dofs[0], dofs[0],
            vertex == 1 ? 1.0 : 0.0, "anchored-tet:" + std::to_string(vertex)});
    }
    // Every quotient DOF is fixed: there are no free residual rows to catch
    // loss of the 1 V jump when a large common double offset is added.
    request.potential_anchors.push_back({root_dofs[0], 0.0});
    const auto baseline = solve_charge_trace_workspace(request);
    require(baseline->gauge_vertex_ids.empty() &&
            baseline->potential_vertex_values_v[0] == 0.0 &&
            baseline->potential_vertex_values_v[1] == 1.0,
        "fully anchored trace fixture did not preserve its baseline jump");
    request.potential_anchors[0].potential_v = 1.0e20;
    bool rejected = false;
    try {
        (void)solve_charge_trace_workspace(request);
    } catch (const std::runtime_error &error) {
        rejected = std::string(error.what()).find("lost an authored jump") != std::string::npos;
    }
    require(rejected, "charge trace solve accepted an authored jump erased by a large anchor");
}

void charge_trace_workspace_reuses_owned_operator_after_sources_are_destroyed()
{
    using fullmag::fem::antenna_field_solve::ChargeTraceSolveRequest;
    using fullmag::fem::antenna_field_solve::ChargeTraceWorkspace;
    using fullmag::fem::antenna_field_solve::ChargeTraceSolution;
    class CountingConductivity final : public mfem::Coefficient {
    public:
        double value = 4.0;
        int evaluations = 0;
        double Eval(mfem::ElementTransformation &, const mfem::IntegrationPoint &) override
        {
            ++evaluations;
            return value;
        }
    };
    std::unique_ptr<ChargeTraceWorkspace> workspace;
    std::shared_ptr<const ChargeTraceSolution> unit_solution;
    std::vector<double> jumps;
    {
        auto mesh = shifted_unit_cube(0.0, 1);
        CountingConductivity conductivity;
        mfem::H1_FECollection collection(1, 3);
        mfem::FiniteElementSpace space(&mesh, &collection);
        ChargeTraceSolveRequest request;
        request.mesh = &mesh;
        request.conductivity = &conductivity;
        request.stable_vertex_identities = coordinate_stable_vertex_ids(mesh);
        for (int minus = 0; minus < mesh.GetNV(); ++minus) {
            const auto *position = mesh.GetVertex(minus);
            if (position[0] != 0.0) continue;
            for (int plus = 0; plus < mesh.GetNV(); ++plus) {
                const auto *peer = mesh.GetVertex(plus);
                if (peer[0] != 1.0 || peer[1] != position[1] || peer[2] != position[2]) continue;
                mfem::Array<int> minus_dofs, plus_dofs;
                space.GetVertexDofs(minus, minus_dofs);
                space.GetVertexDofs(plus, plus_dofs);
                request.trace_relations.push_back({minus_dofs[0], plus_dofs[0], 0.0,
                    "frozen-cut:" + std::to_string(minus)});
            }
        }
        workspace = std::make_unique<ChargeTraceWorkspace>(request);
        jumps.assign(request.trace_relations.size(), 1.0);
        const int assembled_evaluations = conductivity.evaluations;
        require(assembled_evaluations > 0, "charge workspace did not assemble conductivity");
        conductivity.value = 1000.0;
        unit_solution = workspace->solve(jumps, {});
        require(conductivity.evaluations == assembled_evaluations,
            "charge workspace reread mutated conductivity during a subsequent solve");
        for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) mesh.GetVertex(vertex)[0] *= 2.0;
        request.trace_relations.clear();
        request.stable_vertex_identities.local_to_stable.clear();
    }
    std::fill(jumps.begin(), jumps.end(), 2.0);
    const auto accepted = workspace->solve(jumps, {});
    require(accepted->vertex_positions_m == unit_solution->vertex_positions_m,
        "owned charge carrier changed after mutation of the source mesh");
    double left_outward_current_a = 0.0;
    double unit_left_outward_current_a = 0.0;
    for (std::size_t vertex = 0; vertex < accepted->vertex_positions_m.size(); ++vertex) {
        const double x = accepted->vertex_positions_m[vertex][0];
        if (x == 0.0) {
            left_outward_current_a -= accepted->reaction_vertex_values_a[vertex];
            unit_left_outward_current_a -= unit_solution->reaction_vertex_values_a[vertex];
        }
        require(std::abs(accepted->potential_vertex_values_v[vertex] -
                    2.0 * unit_solution->potential_vertex_values_v[vertex]) <= 1.0e-12,
            "charge workspace mutated an earlier owned voltage snapshot");
    }
    require(std::abs(left_outward_current_a - 8.0) <= 8.0e-8,
        "reused charge operator lost the original conductivity or its signed reaction");
    require(std::abs(unit_left_outward_current_a - 4.0) <= 4.0e-8,
        "charge workspace mutated an earlier owned reaction snapshot");
}

void charge_current_response_preserves_sign_and_independent_component_scales()
{
    using fullmag::fem::antenna_field_solve::ChargeCurrentResponseRequest;
    using fullmag::fem::antenna_field_solve::solve_charge_current_response;
    auto lower = shifted_unit_cube(0.0, 1);
    auto upper = shifted_unit_cube(0.0, 2);
    for (int vertex = 0; vertex < upper.GetNV(); ++vertex) upper.GetVertex(vertex)[1] += 2.0;
    auto mesh = combine_disjoint_tetrahedral_meshes(lower, upper);
    mfem::Vector conductivity_values(2);
    conductivity_values[0] = 4.0;
    conductivity_values[1] = 4.0e-4;
    mfem::PWConstCoefficient conductivity(conductivity_values);
    mfem::H1_FECollection collection(1, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    ChargeCurrentResponseRequest request;
    auto &base = request.zero_baseline;
    base.mesh = &mesh;
    base.conductivity = &conductivity;
    base.stable_vertex_identities = coordinate_stable_vertex_ids(mesh);
    std::vector<int> relation_components;
    for (int minus = 0; minus < mesh.GetNV(); ++minus) {
        const auto *position = mesh.GetVertex(minus);
        if (position[0] != 0.0) continue;
        for (int plus = 0; plus < mesh.GetNV(); ++plus) {
            const auto *peer = mesh.GetVertex(plus);
            if (peer[0] != 1.0 || peer[1] != position[1] || peer[2] != position[2]) continue;
            mfem::Array<int> minus_dofs, plus_dofs;
            space.GetVertexDofs(minus, minus_dofs);
            space.GetVertexDofs(plus, plus_dofs);
            base.trace_relations.push_back({minus_dofs[0], plus_dofs[0], 0.0,
                "response-cut:" + std::to_string(minus)});
            relation_components.push_back(position[1] < 1.5 ? 0 : 1);
        }
    }
    for (int component = 0; component < 2; ++component) {
        fullmag::fem::antenna_field_solve::ChargeVoltageControlColumn column;
        column.id = "component-control:" + std::to_string(component);
        column.requested_conjugate_current_a = component == 0 ? -1.0 : -1.0e-4;
        for (int relation_component : relation_components) {
            column.trace_jump_coefficients.push_back(relation_component == component ? 1.0 : 0.0);
        }
        request.columns.push_back(std::move(column));
    }
    const auto result = solve_charge_current_response(request);
    require(result->accepted_solution->component_ids.size() == 2 &&
            result->accepted_solution->gauge_vertex_ids.size() == 2,
        "current response lost independent component gauges");
    for (int component = 0; component < 2; ++component) {
        const std::size_t index = static_cast<std::size_t>(component);
        const double conductance = component == 0 ? 4.0 : 4.0e-4;
        const double current = component == 0 ? -1.0 : -1.0e-4;
        require(std::abs(result->control_voltages_v[index] - 0.25) <= 1.0e-10 &&
                std::abs(result->response_matrix_s[index * 2 + index] - conductance) <=
                    1.0e-10 * conductance &&
                std::abs(result->measured_conjugate_currents_a[index] - current) <=
                    1.0e-8 * std::abs(current) + 1.0e-18,
            "current response hid a small component or lost its signed conductance");
    }
    require(std::abs(result->response_matrix_s[1]) <= 1.0e-18 &&
            std::abs(result->response_matrix_s[2]) <= 1.0e-18,
        "disconnected charge controls acquired spurious coupling");
    auto reversed = request;
    for (auto &column : reversed.columns) {
        column.requested_conjugate_current_a *= -1.0;
        for (double &coefficient : column.trace_jump_coefficients) coefficient *= -1.0;
    }
    const auto reversed_result = solve_charge_current_response(reversed);
    for (std::size_t vertex = 0; vertex < result->accepted_solution->potential_vertex_values_v.size(); ++vertex) {
        require(std::abs(result->accepted_solution->potential_vertex_values_v[vertex] -
                    reversed_result->accepted_solution->potential_vertex_values_v[vertex]) <= 1.0e-10,
            "reversing current-control orientation changed the physical potential");
    }
    auto zero = request;
    for (auto &column : zero.columns) column.requested_conjugate_current_a = 0.0;
    const auto zero_result = solve_charge_current_response(zero);
    for (double value : zero_result->accepted_solution->potential_vertex_values_v) {
        require(value == 0.0, "zero current response retained hidden baseline excitation");
    }
    auto dependent = request;
    auto duplicate = dependent.columns.front();
    duplicate.id = "dependent-control";
    duplicate.requested_conjugate_current_a *= 2.0;
    for (double &coefficient : duplicate.trace_jump_coefficients) coefficient *= 2.0;
    dependent.columns.push_back(duplicate);
    require_rejected([&] { (void)solve_charge_current_response(dependent); },
        "current response accepted energetically dependent controls with compatible RHS");
    for (auto &column : dependent.columns) column.requested_conjugate_current_a = 0.0;
    require_rejected([&] { (void)solve_charge_current_response(dependent); },
        "zero requested currents bypassed the response rank gate");
    auto hidden_baseline = request;
    hidden_baseline.zero_baseline.trace_relations.front().potential_jump_v = 1.0;
    require_rejected([&] { (void)solve_charge_current_response(hidden_baseline); },
        "current response accepted a hidden legacy voltage drop");
}

void charge_current_response_uses_terminal_anchors_and_rejects_common_mode()
{
    using fullmag::fem::antenna_field_solve::ChargeCurrentResponseRequest;
    using fullmag::fem::antenna_field_solve::ChargeVoltageControlColumn;
    using fullmag::fem::antenna_field_solve::solve_charge_current_response;
    auto mesh = shifted_unit_cube(0.0, 1);
    mfem::ConstantCoefficient conductivity(4.0);
    mfem::H1_FECollection collection(1, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    ChargeCurrentResponseRequest request;
    request.zero_baseline.mesh = &mesh;
    request.zero_baseline.conductivity = &conductivity;
    request.zero_baseline.stable_vertex_identities = coordinate_stable_vertex_ids(mesh);
    ChargeVoltageControlColumn control;
    control.id = "terminal-voltage-control";
    control.requested_conjugate_current_a = -1.0;
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        const double x = mesh.GetVertex(vertex)[0];
        if (x != 0.0 && x != 1.0) continue;
        mfem::Array<int> dofs;
        space.GetVertexDofs(vertex, dofs);
        request.zero_baseline.potential_anchors.push_back({dofs[0], 0.0});
        control.anchor_potential_coefficients.push_back(x);
    }
    request.columns.push_back(control);
    const auto result = solve_charge_current_response(request);
    require(result->accepted_solution->gauge_vertex_ids.empty() &&
            std::abs(result->control_voltages_v[0] - 0.25) <= 1.0e-10,
        "anchored terminal response added an extra gauge or lost current sign");
    double left = 0.0, right = 0.0;
    for (std::size_t vertex = 0; vertex < result->accepted_solution->vertex_positions_m.size(); ++vertex) {
        const double x = result->accepted_solution->vertex_positions_m[vertex][0];
        require(std::abs(result->accepted_solution->potential_vertex_values_v[vertex] - 0.25 * x) <= 1.0e-10,
            "terminal-anchor response is not the analytical affine potential");
        if (x == 0.0) left -= result->accepted_solution->reaction_vertex_values_a[vertex];
        if (x == 1.0) right -= result->accepted_solution->reaction_vertex_values_a[vertex];
    }
    require(std::abs(left - 1.0) <= 1.0e-8 && std::abs(right + 1.0) <= 1.0e-8,
        "terminal-anchor response did not preserve signed uneliminated weak reactions");
    request.columns.front().requested_conjugate_current_a = 0.0;
    std::fill(request.columns.front().anchor_potential_coefficients.begin(),
        request.columns.front().anchor_potential_coefficients.end(), 1.0);
    for (double algebraic_tolerance : {1.0e-12, 1.0e-3}) {
        request.zero_baseline.algebraic_relative_tolerance = algebraic_tolerance;
        bool authored_common_mode_rejected = false;
        try {
            (void)solve_charge_current_response(request);
        } catch (const std::invalid_argument &error) {
            authored_common_mode_rejected = std::string(error.what()).find(
                "authored charge current control is constant") != std::string::npos;
        }
        require(authored_common_mode_rejected,
            "common-mode terminal control was not rejected before the approximate H1 solve");
    }
}

void prepared_charge_current_response_reuses_owned_operator_and_checks_topology()
{
    using fullmag::fem::antenna_field_solve::ChargeCurrentResponseRequest;
    using fullmag::fem::antenna_field_solve::ChargeTraceWorkspace;
    using fullmag::fem::antenna_field_solve::solve_charge_current_response_prepared;
    class CountingConductivity final : public mfem::Coefficient {
    public:
        int evaluations = 0;
        double value = 4.0;
        double Eval(mfem::ElementTransformation &, const mfem::IntegrationPoint &) override
        {
            ++evaluations;
            return value;
        }
    };
    ChargeCurrentResponseRequest request;
    std::unique_ptr<ChargeTraceWorkspace> workspace;
    {
        auto mesh = shifted_unit_cube(0.0, 1);
        CountingConductivity conductivity;
        mfem::H1_FECollection collection(1, 3);
        mfem::FiniteElementSpace space(&mesh, &collection);
        request.zero_baseline.mesh = &mesh;
        request.zero_baseline.conductivity = &conductivity;
        request.zero_baseline.stable_vertex_identities = coordinate_stable_vertex_ids(mesh);
        request.columns = {{"frozen-terminal", {}, {}, -1.0}};
        for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
            const double x = mesh.GetVertex(vertex)[0];
            if (x != 0.0 && x != 1.0) continue;
            mfem::Array<int> dofs;
            space.GetVertexDofs(vertex, dofs);
            request.zero_baseline.potential_anchors.push_back({dofs[0], 0.0});
            request.columns.front().anchor_potential_coefficients.push_back(x);
        }
        workspace = std::make_unique<ChargeTraceWorkspace>(request.zero_baseline);
        const int assembled_count = conductivity.evaluations;
        require(assembled_count > 0, "prepared response did not assemble its conductivity");
        conductivity.value = 1000.0;
        const auto result = solve_charge_current_response_prepared(request, *workspace);
        require(conductivity.evaluations == assembled_count &&
                std::abs(result->control_voltages_v.front() - 0.25) <= 1.0e-10,
            "prepared current response reassembled or reread conductivity");
        for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
            mfem::Array<int> dofs;
            space.GetVertexDofs(vertex, dofs);
            require(workspace->vertex_index_for_full_dof(dofs[0]) == vertex,
                "prepared workspace lost its actual P1 DOF-to-vertex map");
        }
        request.zero_baseline.mesh = nullptr;
        request.zero_baseline.conductivity = nullptr;
    }
    const auto result = solve_charge_current_response_prepared(request, *workspace);
    require(std::abs(result->control_voltages_v.front() - 0.25) <= 1.0e-10,
        "prepared response required destroyed borrowed sources");
    const auto rejects_owned_mismatch = [&](const ChargeCurrentResponseRequest &candidate) {
        bool rejected = false;
        try {
            (void)solve_charge_current_response_prepared(candidate, *workspace);
        } catch (const std::invalid_argument &error) {
            rejected = std::string(error.what()).find("owned workspace") != std::string::npos;
        }
        require(rejected, "prepared response ignored a changed owned topology or solver policy");
    };
    auto changed = request;
    changed.zero_baseline.stable_vertex_identities.local_to_stable.front() += 1;
    rejects_owned_mismatch(changed);
    changed = request;
    std::swap(changed.zero_baseline.potential_anchors[0], changed.zero_baseline.potential_anchors[1]);
    rejects_owned_mismatch(changed);
    changed = request;
    changed.zero_baseline.maximum_iterations += 1;
    rejects_owned_mismatch(changed);
    require_rejected([&] { (void)workspace->vertex_index_for_full_dof(-1); },
        "owned DOF-to-vertex map accepted an invalid negative DOF");
}

void charge_current_controls_require_exact_rank_modulo_original_volumes()
{
    using fullmag::fem::antenna_field_solve::ChargeCurrentResponseRequest;
    using fullmag::fem::antenna_field_solve::ChargeTraceWorkspace;
    using fullmag::fem::antenna_field_solve::solve_charge_current_response;
    using fullmag::fem::antenna_field_solve::validate_charge_control_rank;
    auto lower = shifted_unit_cube(0.0, 1);
    auto upper = shifted_unit_cube(0.0, 2);
    for (int vertex = 0; vertex < upper.GetNV(); ++vertex) upper.GetVertex(vertex)[1] += 2.0;
    auto mesh = combine_disjoint_tetrahedral_meshes(lower, upper);
    mfem::ConstantCoefficient conductivity(4.0);
    mfem::H1_FECollection collection(1, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    const auto dof = [&](int vertex) {
        mfem::Array<int> values;
        space.GetVertexDofs(vertex, values);
        return values[0];
    };
    ChargeCurrentResponseRequest request;
    auto &base = request.zero_baseline;
    base.mesh = &mesh;
    base.conductivity = &conductivity;
    base.stable_vertex_identities = coordinate_stable_vertex_ids(mesh);
    const int lower_a = dof(0), lower_b = dof(1);
    const int upper_a = dof(lower.GetNV()), upper_b = dof(lower.GetNV() + 1);
    base.trace_relations = {{lower_a, upper_a, 0.0, "constant-volume-offset"}};
    request.columns = {{"bridge-offset", {1.0}, {}, 0.0}};
    const auto reject_with_message = [&](const ChargeCurrentResponseRequest &candidate,
                                        const char *message, bool use_response) {
        bool rejected = false;
        try {
            if (use_response) {
                (void)solve_charge_current_response(candidate);
            } else {
                ChargeTraceWorkspace owner(candidate.zero_baseline);
                validate_charge_control_rank(candidate, owner);
            }
        } catch (const std::invalid_argument &error) {
            rejected = std::string(error.what()).find(message) != std::string::npos;
        }
        require(rejected, "authored control did not fail its specific exact source gate");
    };
    reject_with_message(request, "dependent modulo original charge nullspace", true);
    base.potential_anchors = {{lower_a, 0.0}, {upper_a, 0.0}};
    request.columns.front().anchor_potential_coefficients = {0.0, 1.0};
    reject_with_message(request, "dependent modulo original charge nullspace", true);

    base.potential_anchors.clear();
    base.trace_relations = {{lower_a, lower_b, 0.0, "within-lower"},
                           {upper_a, upper_b, 0.0, "within-upper"}};
    request.columns = {{"lower", {1.0, 0.0}, {}, 0.0},
                       {"upper", {0.0, 1.0}, {}, 0.0}};
    {
        ChargeTraceWorkspace owner(base);
        require(owner.original_volume_component_for_full_dof(lower_a) ==
                    owner.original_volume_component_for_full_dof(lower_b) &&
                owner.original_volume_component_for_full_dof(lower_a) !=
                    owner.original_volume_component_for_full_dof(upper_a),
            "owned original-volume map was replaced by the trace quotient partition");
        validate_charge_control_rank(request, owner);
        request.columns[0].trace_jump_coefficients = {1.0, 1.0};
        request.columns[1].trace_jump_coefficients = {1.0, std::nextafter(1.0, 2.0)};
        validate_charge_control_rank(request, owner);
        std::reverse(request.columns.begin(), request.columns.end());
        validate_charge_control_rank(request, owner);
        request.columns.resize(1);
        request.columns[0].trace_jump_coefficients = {std::numeric_limits<double>::denorm_min(), 0.0};
        validate_charge_control_rank(request, owner);
        auto oversized = request;
        oversized.zero_baseline.trace_relations.resize(65537, base.trace_relations.front());
        oversized.columns.front().trace_jump_coefficients.resize(65537, 1.0);
        bool resource_rejected = false;
        try {
            validate_charge_control_rank(oversized, owner);
        } catch (const std::runtime_error &error) {
            resource_rejected = std::string(error.what()).find("exact rank resource exceeded") != std::string::npos;
        }
        require(resource_rejected, "exact rank resource refusal was mistaken for dependent controls");
    }

    // Different authored arrays may differ only by a large common-mode.
    base.trace_relations.clear();
    base.potential_anchors = {{lower_a, 0.0}, {lower_b, 0.0}};
    request.columns = {{"gradient", {}, {0.0, 1.0}, 0.0},
                       {"gradient-plus-constant", {}, {std::ldexp(1.0, 40),
                           std::ldexp(1.0, 40) + 1.0}, 0.0}};
    reject_with_message(request, "dependent modulo original charge nullspace", true);
    std::reverse(base.potential_anchors.begin(), base.potential_anchors.end());
    for (auto &column : request.columns) {
        std::reverse(column.anchor_potential_coefficients.begin(),
            column.anchor_potential_coefficients.end());
    }
    reject_with_message(request, "dependent modulo original charge nullspace", true);

    // Infeasible nodal cycles must not be counted as energetic controls.
    base.potential_anchors.clear();
    base.trace_relations = {{lower_a, lower_b, 0.0, "cycle-ab"},
                           {lower_b, dof(2), 0.0, "cycle-bc"},
                           {lower_a, dof(2), 0.0, "cycle-ac"}};
    request.columns = {{"infeasible-cycle", {1.0, 0.0, 0.0}, {}, 0.0}};
    reject_with_message(request, "infeasible in full DOF space", true);

    // An exact full-rank matrix may exceed the arithmetic budget; that
    // refusal must not be mislabeled as a dependent or infeasible control.
    base.trace_relations.clear();
    base.potential_anchors = {{lower_a, 0.0}, {lower_b, 0.0}, {dof(2), 0.0}, {dof(3), 0.0}};
    const double tiny = std::numeric_limits<double>::denorm_min();
    const double huge = std::numeric_limits<double>::max();
    request.columns = {{"budget-a", {}, {0.0, huge, tiny, 0.0}, 0.0},
                       {"budget-b", {}, {0.0, tiny, huge, tiny}, 0.0},
                       {"budget-c", {}, {0.0, 0.0, tiny, huge}, 0.0}};
    ChargeTraceWorkspace owner(base);
    bool bit_budget_rejected = false;
    try {
        validate_charge_control_rank(request, owner);
    } catch (const std::runtime_error &error) {
        bit_budget_rejected = std::string(error.what()).find("exact rank resource exceeded") != std::string::npos;
    }
    require(bit_budget_rejected, "exact rank intermediate-bit budget did not fail closed");
}

void two_disconnected_closed_components_have_two_certified_dependencies()
{
    auto first = mfem::Mesh::MakeCartesian3D(
        2, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    auto second = mfem::Mesh::MakeCartesian3D(
        2, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    for (int vertex = 0; vertex < second.GetNV(); ++vertex) {
        second.GetVertex(vertex)[1] += 2.0;
    }
    ChargeFixture fixture(combine_disjoint_tetrahedral_meshes(first, second));
    const auto ids = coordinate_stable_vertex_ids(fixture.mesh);

    auto all_cut = periodic_source_cut(
        fixture.mesh, ids).source_cuts.front();
    PeriodicCurrentSourceCut lower_cut = all_cut;
    PeriodicCurrentSourceCut upper_cut = all_cut;
    lower_cut.id = "lower-periodic-cut";
    upper_cut.id = "upper-periodic-cut";
    lower_cut.face_pairs.clear();
    upper_cut.face_pairs.clear();
    for (const auto &pair : all_cut.face_pairs) {
        const auto minus = locate_boundary_face(
            fixture.mesh, ids, pair.minus_face_vertex_ids);
        (minus.physical_centroid[1] < 1.5 ? lower_cut : upper_cut).
            face_pairs.push_back(pair);
    }
    require(!lower_cut.face_pairs.empty() && !upper_cut.face_pairs.empty(),
        "two-component fixture did not split its periodic cuts");
    ClosedGeometryCurrentClosure closure;
    closure.operator_version = "fem_closed_current_geometry.v1";
    closure.revision = "two-component-closure-r1";
    closure.digest = "two-component-closure-digest-r1";
    closure.source_cuts = {lower_cut, upper_cut};

    auto boundary_roles = periodic_boundary_roles(fixture.mesh);
    for (auto &face : boundary_roles) {
        if (face.role != ConservativeCurrentBoundaryRole::SourceCut) continue;
        mfem::Array<int> vertices;
        fixture.mesh.GetBdrElementVertices(face.boundary_element, vertices);
        double y = 0.0;
        for (int i = 0; i < vertices.Size(); ++i) {
            y += fixture.mesh.GetVertex(vertices[i])[1];
        }
        face.circuit_id = y / vertices.Size() < 1.5
            ? lower_cut.id : upper_cut.id;
    }
    const auto boundary_map = expected_boundary_map(
        fixture.mesh, ids, boundary_roles);
    const auto exact_d = assemble_exact_physical_constraint_oracle(
        fixture.mesh, ids, boundary_map, closure);
    require(exact_d.component_anchors.size() == 2 &&
            exact_d.matrix.size() - exact_d.rank == 2 &&
            exact_d.source_cut_rows == lower_cut.face_pairs.size() +
                upper_cut.face_pairs.size(),
        "exact physical [B;C] Bareiss oracle did not find nullity two");
    ExactIntegerMatrix b_only(exact_d.matrix.begin(),
        exact_d.matrix.begin() + static_cast<std::ptrdiff_t>(
            exact_d.divergence_rows));
    require(bareiss_exact_rank(b_only) == exact_d.divergence_rows,
        "B-only matrix was not full row rank before authored cut closure rows");
    ExactIntegerMatrix reduced_d;
    for (std::size_t row = 0; row < exact_d.matrix.size(); ++row) {
        if (std::find(exact_d.omitted_divergence_ids.begin(),
                exact_d.omitted_divergence_ids.end(), exact_d.row_ids[row]) ==
                exact_d.omitted_divergence_ids.end()) {
            reduced_d.push_back(exact_d.matrix[row]);
        }
    }
    require(reduced_d.size() + 2 == exact_d.matrix.size() &&
            bareiss_exact_rank(reduced_d) == reduced_d.size(),
        "removing min-anchor divergence row/component did not make D full rank");

    mfem::RT_FECollection rt_collection(0, 3);
    mfem::FiniteElementSpace rt_space(&fixture.mesh, &rt_collection);
    mfem::GridFunction imported(&rt_space);
    mfem::Vector current(3);
    current = 0.0;
    current[0] = 4.0;
    mfem::VectorConstantCoefficient exact_current(current);
    imported.ProjectCoefficient(exact_current);

    ConservativeCurrentImportRequest request;
    request.mesh = &fixture.mesh;
    request.rt0_field = &imported;
    request.stable_vertex_identities = ids;
    request.boundary_faces = boundary_roles;
    request.closure = closure;
    request.identity = identity_input();
    request.pins = pins_for(request.identity);
    request.require_independent_physical_certificate = true;
    const auto view = ConservativeCurrentView::Import(request);
    require(view != nullptr && view->balance().closure_complete,
        "two disjoint certified periodic currents were not accepted");

    const auto &certificate = view->constraint_rank_certificate();
    require(certificate.rows_before == exact_d.matrix.size() &&
            certificate.rank == exact_d.rank &&
            certificate.rows_before - certificate.rank == 2 &&
            certificate.omitted_rows.size() == 2,
        "production rank certificate disagrees with exact physical D rank");
    std::vector<std::array<uint64_t, 4>> certified_anchors;
    std::vector<std::string> omitted_ids;
    for (const auto &omitted : certificate.omitted_rows) {
        require(omitted.reason ==
                    ConstraintOmissionReason::ClosedComponentDivergenceDependency &&
                std::abs(omitted.residual_a) <= 1.0e-12,
            "physical omitted row has the wrong reason or residual");
        certified_anchors.push_back(omitted.closed_component_anchor_element);
        omitted_ids.push_back(omitted.constraint_id);
    }
    std::sort(certified_anchors.begin(), certified_anchors.end());
    std::sort(omitted_ids.begin(), omitted_ids.end());
    require(certified_anchors == exact_d.component_anchors &&
            omitted_ids == exact_d.omitted_divergence_ids &&
            std::adjacent_find(omitted_ids.begin(), omitted_ids.end()) ==
                omitted_ids.end(),
        "rank certificate did not identify one unique divergence row per component");

    std::vector<ExpectedCircuitPair> expected_pairs;
    for (const auto &cut : closure.source_cuts) {
        for (const auto &pair : cut.face_pairs) {
            expected_pairs.push_back(ExpectedCircuitPair{2, cut.id,
                pair.minus_face_vertex_ids, pair.plus_face_vertex_ids});
        }
    }
    independently_decode_and_match_balance_artifact(
        view, ids, boundary_map, expected_pairs);
}

fullmag::fem::antenna_field_solve::ResolvedChargeTerminal fixture_terminal_on_x(
    const mfem::Mesh &mesh, const StableMeshVertexIdentities &ids,
    const std::string &id, double x, double current,
    double minimum_y = -std::numeric_limits<double>::infinity(),
    double maximum_y = std::numeric_limits<double>::infinity())
{
    fullmag::fem::antenna_field_solve::ResolvedChargeTerminal terminal;
    terminal.id = id;
    terminal.requested_outward_current_a = current;
    for (int boundary : boundary_elements_on_x(mesh, x)) {
        mfem::Array<int> vertices;
        mesh.GetBdrElementVertices(boundary, vertices);
        double y = 0.0;
        for (int vertex : vertices) y += mesh.GetVertex(vertex)[1] / vertices.Size();
        if (y >= minimum_y && y <= maximum_y) {
            terminal.boundary_face_vertex_ids.push_back(sorted_face_key(mesh, ids, boundary));
        }
    }
    require(!terminal.boundary_face_vertex_ids.empty(), "physical terminal fixture has no boundary faces");
    return terminal;
}

void require_terminal_adapter_rejected(
    const fullmag::fem::antenna_field_solve::ChargeTerminalCurrentRequest &request,
    const std::string &fragment)
{
    bool rejected = false;
    try {
        (void)fullmag::fem::antenna_field_solve::solve_charge_terminal_current_constraints(request);
    } catch (const std::invalid_argument &error) {
        rejected = std::string(error.what()).find(fragment) != std::string::npos;
    }
    require(rejected, "physical terminal fixture missed its specific rejection: " + fragment);
}

void physical_charge_terminal_currents_preserve_signed_references_and_scale()
{
    using fullmag::fem::antenna_field_solve::ChargeTerminalCurrentRequest;
    using fullmag::fem::antenna_field_solve::solve_charge_terminal_current_constraints;
    auto mesh = shifted_unit_cube(0.0, 1);
    mfem::ConstantCoefficient conductivity(4.0);
    auto ids = stable_vertex_ids(mesh);
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        if (std::abs(mesh.GetVertex(vertex)[0] - 1.0) < 1.0e-13) ids.local_to_stable[vertex] = 100u + vertex;
    }
    ChargeTerminalCurrentRequest request;
    request.conductor.mesh = &mesh;
    request.conductor.conductivity = &conductivity;
    request.conductor.stable_vertex_identities = ids;
    request.terminals = {fixture_terminal_on_x(mesh, ids, "left", 0.0, -1.0),
        fixture_terminal_on_x(mesh, ids, "right", 1.0, 1.0)};
    const auto check = [&](const ChargeTerminalCurrentRequest &candidate, double scale) {
        const auto result = solve_charge_terminal_current_constraints(candidate);
        require(result->reference_terminal_ids == std::vector<std::string>{"right"} &&
                result->accepted_solution->gauge_vertex_ids.empty() && result->response != nullptr,
            "physical terminal reference followed authored order instead of stable vertex identity");
        for (std::size_t terminal = 0; terminal < result->terminal_ids.size(); ++terminal) {
            const double expected = result->terminal_ids[terminal] == "left" ? -scale : scale;
            require(std::abs(result->measured_outward_currents_a[terminal] - expected) <=
                    1.0e-18 + 1.0e-8 * std::abs(expected),
                "physical terminal signed current failed its own requested-current scale");
            require(result->terminal_boundary_face_vertex_ids[terminal] == candidate.terminals[terminal].boundary_face_vertex_ids &&
                    result->requested_outward_currents_a[terminal] == expected &&
                    std::abs(result->current_residuals_a[terminal]) <= 1.0e-18 + 1.0e-8 * std::abs(expected),
                "physical terminal result did not retain its face groups and signed certificate");
            require(std::abs(result->terminal_voltages_v[terminal] -
                    (result->terminal_ids[terminal] == "left" ? scale / 4.0 : 0.0)) < 1.0e-10,
                "physical terminal voltage/reference has the wrong sign");
        }
        for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
            require(std::abs(result->accepted_solution->potential_vertex_values_v[vertex] -
                    scale * (1.0 - mesh.GetVertex(vertex)[0]) / 4.0) < 1.0e-10,
                "physical terminal V disagrees with the analytic constant-conductivity bar");
        }
    };
    check(request, 1.0);
    auto reversed = request;
    for (auto &terminal : reversed.terminals) terminal.requested_outward_current_a *= -1.0;
    check(reversed, -1.0);
    auto doubled = request;
    for (auto &terminal : doubled.terminals) terminal.requested_outward_current_a *= 2.0;
    check(doubled, 2.0);
    std::reverse(doubled.terminals.begin(), doubled.terminals.end());
    check(doubled, 2.0);
    auto single = request;
    single.terminals = {request.terminals.back()};
    single.terminals.front().requested_outward_current_a = 0.0;
    const auto zero = solve_charge_terminal_current_constraints(single);
    require(zero->response == nullptr && zero->measured_outward_currents_a == std::vector<double>{0.0} &&
            zero->reference_terminal_ids == std::vector<std::string>{"right"},
        "single zero-current terminal manufactured an empty response or omitted its measurement");
    for (double value : zero->accepted_solution->potential_vertex_values_v) require(value == 0.0, "single-terminal zero source generated V");
    auto unknown = request;
    unknown.terminals.front().boundary_face_vertex_ids.front() = {999990u, 999991u, 999992u};
    require_terminal_adapter_rejected(unknown, "unknown or nonboundary");
    auto duplicate = request;
    duplicate.terminals.front().boundary_face_vertex_ids.back() = duplicate.terminals.front().boundary_face_vertex_ids.front();
    require_terminal_adapter_rejected(duplicate, "globally unique");
    auto shared = request;
    bool found_shared = false;
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        mfem::Array<int> vertices;
        mesh.GetBdrElementVertices(boundary, vertices);
        bool touches_right = false, all_right = true;
        for (int vertex : vertices) {
            const bool right = std::abs(mesh.GetVertex(vertex)[0] - 1.0) < 1.0e-13;
            touches_right = touches_right || right;
            all_right = all_right && right;
        }
        if (touches_right && !all_right) {
            shared.terminals.front().boundary_face_vertex_ids.push_back(sorted_face_key(mesh, ids, boundary));
            found_shared = true;
            break;
        }
    }
    require(found_shared, "shared-electrode fixture found no side triangle");
    require_terminal_adapter_rejected(shared, "share an essential DOF");
}

void physical_charge_terminal_currents_keep_components_and_zero_jump_interfaces()
{
    using fullmag::fem::antenna_field_solve::ChargeTerminalCurrentRequest;
    using fullmag::fem::antenna_field_solve::solve_charge_terminal_current_constraints;
    auto lower = shifted_unit_cube(0.0, 1);
    auto upper = shifted_unit_cube(0.0, 2);
    auto isolated = shifted_unit_cube(0.0, 3);
    for (int vertex = 0; vertex < upper.GetNV(); ++vertex) upper.GetVertex(vertex)[1] += 2.0;
    for (int vertex = 0; vertex < isolated.GetNV(); ++vertex) isolated.GetVertex(vertex)[1] += 4.0;
    const auto pair = combine_disjoint_tetrahedral_meshes(lower, upper);
    auto mesh = combine_disjoint_tetrahedral_meshes(pair, isolated);
    mfem::Vector values(3);
    values[0] = 4.0;
    values[1] = 4.0e-4;
    values[2] = 4.0;
    mfem::PWConstCoefficient conductivity(values);
    const auto ids = stable_vertex_ids(mesh);
    ChargeTerminalCurrentRequest request;
    request.conductor.mesh = &mesh;
    request.conductor.conductivity = &conductivity;
    request.conductor.stable_vertex_identities = ids;
    request.terminals = {fixture_terminal_on_x(mesh, ids, "a-left", 0.0, -1.0, 0.0, 1.0),
        fixture_terminal_on_x(mesh, ids, "a-right", 1.0, 1.0, 0.0, 1.0),
        fixture_terminal_on_x(mesh, ids, "b-left", 0.0, -1.0e-4, 2.0, 3.0),
        fixture_terminal_on_x(mesh, ids, "b-right", 1.0, 1.0e-4, 2.0, 3.0)};
    const auto result = solve_charge_terminal_current_constraints(request);
    require(result->reference_terminal_ids == std::vector<std::string>({"a-left", "b-left"}) &&
            result->accepted_solution->gauge_vertex_ids.size() == 1 &&
            result->terminal_component_ids[0] == result->terminal_component_ids[1] &&
            result->terminal_component_ids[2] == result->terminal_component_ids[3] &&
            result->terminal_component_ids[0] != result->terminal_component_ids[2],
        "physical terminal gauges/components collapsed independent conductors");
    for (std::size_t terminal = 0; terminal < request.terminals.size(); ++terminal) {
        const double expected = request.terminals[terminal].requested_outward_current_a;
        require(std::abs(result->measured_outward_currents_a[terminal] - expected) <= 1.0e-18 + 1.0e-8 * std::abs(expected),
            "small disconnected terminal was certified using another component's current scale");
    }
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        const double expected = mesh.GetVertex(vertex)[1] > 3.5 ? 0.0 : -mesh.GetVertex(vertex)[0] / 4.0;
        require(std::abs(result->accepted_solution->potential_vertex_values_v[vertex] - expected) < 1.0e-10,
            "disconnected or isolated physical terminal V has the wrong analytic gradient");
    }
    auto unbalanced = request;
    unbalanced.terminals[0].requested_outward_current_a += 0.25;
    unbalanced.terminals[2].requested_outward_current_a -= 0.25;
    require_terminal_adapter_rejected(unbalanced, "do not balance on an electrical component");
    auto spanning = request;
    spanning.terminals[0].boundary_face_vertex_ids.insert(spanning.terminals[0].boundary_face_vertex_ids.end(),
        spanning.terminals[2].boundary_face_vertex_ids.begin(), spanning.terminals[2].boundary_face_vertex_ids.end());
    spanning.terminals.erase(spanning.terminals.begin() + 2);
    require_terminal_adapter_rejected(spanning, "spans electrical components");

    auto left = shifted_unit_cube(0.0, 1);
    auto right = shifted_unit_cube(1.0, 1);
    auto joined = combine_disjoint_tetrahedral_meshes(left, right);
    mfem::ConstantCoefficient joined_conductivity(4.0);
    const auto joined_ids = stable_vertex_ids(joined); // Coincident interface vertices remain distinct.
    mfem::H1_FECollection collection(1, 3);
    mfem::FiniteElementSpace space(&joined, &collection);
    ChargeTerminalCurrentRequest connected;
    connected.conductor.mesh = &joined;
    connected.conductor.conductivity = &joined_conductivity;
    connected.conductor.stable_vertex_identities = joined_ids;
    connected.terminals = {fixture_terminal_on_x(joined, joined_ids, "left", 0.0, -1.0),
        fixture_terminal_on_x(joined, joined_ids, "right", 2.0, 1.0)};
    for (int vertex = 0; vertex < left.GetNV(); ++vertex) {
        if (std::abs(joined.GetVertex(vertex)[0] - 1.0) > 1.0e-13) continue;
        int match = -1;
        for (int other = left.GetNV(); other < joined.GetNV(); ++other) {
            const auto *point = joined.GetVertex(other);
            if (std::abs(point[0] - 1.0) < 1.0e-13 &&
                std::abs(point[1] - joined.GetVertex(vertex)[1]) < 1.0e-13 &&
                std::abs(point[2] - joined.GetVertex(vertex)[2]) < 1.0e-13) match = other;
        }
        require(match >= 0, "zero-jump interface fixture has no paired vertex");
        mfem::Array<int> minus, plus;
        space.GetVertexDofs(vertex, minus);
        space.GetVertexDofs(match, plus);
        require(minus.Size() == 1 && plus.Size() == 1, "interface vertex has no scalar P1 DOF");
        connected.conductor.trace_relations.push_back({minus[0], plus[0], 0.0, "interface:" + std::to_string(vertex)});
    }
    require(!connected.conductor.trace_relations.empty(), "zero-jump fixture created no interface");
    const auto continuous = solve_charge_terminal_current_constraints(connected);
    require(continuous->reference_terminal_ids == std::vector<std::string>{"left"} &&
            continuous->terminal_component_ids[0] == continuous->terminal_component_ids[1] &&
            continuous->accepted_solution->component_ids.size() == 1,
        "zero-jump interface did not join electrical components");
    for (std::size_t terminal = 0; terminal < connected.terminals.size(); ++terminal) {
        const double expected = connected.terminals[terminal].requested_outward_current_a;
        require(std::abs(continuous->measured_outward_currents_a[terminal] - expected) <= 1.0e-18 + 1.0e-8 * std::abs(expected),
            "zero-jump interface lost the physical terminal current");
    }
    for (int vertex = 0; vertex < joined.GetNV(); ++vertex) {
        require(std::abs(continuous->accepted_solution->potential_vertex_values_v[vertex] + joined.GetVertex(vertex)[0] / 4.0) < 1.0e-10,
            "zero-jump interface V disagrees with the full two-volume series bar");
    }
    auto nonzero = connected;
    nonzero.conductor.trace_relations.front().potential_jump_v = 0.1;
    require_terminal_adapter_rejected(nonzero, "nonzero cut actuators");
    auto aliased = connected;
    mfem::Array<int> electrode;
    space.GetVertexDofs(0, electrode);
    require(std::abs(joined.GetVertex(0)[0]) < 1.0e-13 && electrode.Size() == 1,
        "trace alias fixture did not select a left electrode vertex");
    aliased.conductor.trace_relations.push_back({electrode[0], connected.conductor.trace_relations.front().minus_dof, 0.0, "electrode-alias"});
    require_terminal_adapter_rejected(aliased, "trace-aliased electrode DOFs");
}

void physical_charge_terminal_faces_require_complete_dirichlet_closure()
{
    using fullmag::fem::antenna_field_solve::ChargeTerminalCurrentRequest;
    using fullmag::fem::antenna_field_solve::solve_charge_terminal_current_constraints;
    mfem::Mesh pyramid(3, 6, 4, 8, 3);
    const double positions[6][3] = {{0.0, 0.0, 0.0}, {0.0, 1.0, 0.0},
        {0.0, 1.0, 1.0}, {0.0, 0.0, 1.0}, {0.0, 0.5, 0.5}, {1.0, 0.5, 0.5}};
    for (const auto &position : positions) pyramid.AddVertex(position);
    for (int corner = 0; corner < 4; ++corner) {
        const int next = (corner + 1) % 4;
        int tetrahedron[4] = {4, corner, next, 5};
        int base[3] = {4, next, corner};
        int side[3] = {corner, next, 5};
        pyramid.AddTet(tetrahedron, 1);
        pyramid.AddBdrTriangle(base, 1);
        pyramid.AddBdrTriangle(side, 2);
    }
    pyramid.FinalizeTetMesh(1, 1, true);
    mfem::ConstantCoefficient conductivity(4.0);
    const auto ids = stable_vertex_ids(pyramid);
    ChargeTerminalCurrentRequest complete;
    complete.conductor.mesh = &pyramid;
    complete.conductor.conductivity = &conductivity;
    complete.conductor.stable_vertex_identities = ids;
    complete.terminals = {fixture_terminal_on_x(pyramid, ids, "base", 0.0, 0.0)};
    require(complete.terminals.front().boundary_face_vertex_ids.size() == 4, "pyramid fixture has no four-face base fan");
    auto incomplete = complete;
    incomplete.terminals.front().boundary_face_vertex_ids.pop_back();
    require_terminal_adapter_rejected(incomplete, "not closed under its essential P1 DOFs");
    const auto accepted = solve_charge_terminal_current_constraints(complete);
    require(accepted->response == nullptr && accepted->measured_outward_currents_a == std::vector<double>{0.0} &&
            accepted->terminal_boundary_face_vertex_ids.front() == complete.terminals.front().boundary_face_vertex_ids,
        "complete pyramid base did not preserve its physical terminal zero-current result");
    for (double value : accepted->accepted_solution->potential_vertex_values_v) require(value == 0.0, "complete zero-current pyramid created V");
    auto coarse = mfem::Mesh::MakeCartesian3D(1, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    const auto coarse_ids = stable_vertex_ids(coarse);
    ChargeTerminalCurrentRequest mixed;
    mixed.conductor.mesh = &coarse;
    mixed.conductor.conductivity = &conductivity;
    mixed.conductor.stable_vertex_identities = coarse_ids;
    mixed.terminals = {fixture_terminal_on_x(coarse, coarse_ids, "left", 0.0, 0.0),
        fixture_terminal_on_x(coarse, coarse_ids, "right", 1.0, 0.0)};
    require_terminal_adapter_rejected(mixed, "separator face has no free P1 DOF");
}

void terminal_constrained_rt0_projection_preserves_measured_h1_currents()
{
    using fullmag::fem::antenna_field_solve::ChargeTerminalCurrentRequest;
    using fullmag::fem::antenna_field_solve::solve_charge_terminal_current_constraints;
    using fullmag::fem::transport::Rt0TerminalFluxConstraint;
    using fullmag::fem::transport::TerminalConstrainedRt0Projection;
    using fullmag::fem::transport::project_terminal_constrained_rt0;
    const auto check_field = [](const TerminalConstrainedRt0Projection::Ptr &projection, double expected_x) {
        const auto &field = projection->field();
        auto *mesh = field.FESpace()->GetMesh();
        require(mesh != nullptr && mesh->GetNE() > 0, "terminal RT0 projection lost its owned field mesh");
        for (int element = 0; element < mesh->GetNE(); ++element) {
            auto *transformation = mesh->GetElementTransformation(element);
            const auto &rule = mfem::IntRules.Get(mfem::Geometry::TETRAHEDRON, 4);
            for (int point = 0; point < rule.GetNPoints(); ++point) {
                transformation->SetIntPoint(&rule.IntPoint(point));
                mfem::Vector value(3);
                field.GetVectorValue(*transformation, rule.IntPoint(point), value);
                require(std::abs(value[0] - expected_x) < 1.0e-10 &&
                        std::abs(value[1]) < 1.0e-10 && std::abs(value[2]) < 1.0e-10,
                    "terminal-constrained RT0 did not recover the analytic signed current density");
            }
        }
    };
    TerminalConstrainedRt0Projection::Ptr retained;
    StableMeshVertexIdentities retained_ids;
    int retained_element_count = 0;
    {
        auto mesh = shifted_unit_cube(0.0, 1);
        mfem::ConstantCoefficient conductivity(4.0);
        const auto ids = stable_vertex_ids(mesh);
        mfem::Vector raw_value(3);
        raw_value = 0.0;
        raw_value[0] = 1.0; // Deliberately differs from the measured H1 source.
        mfem::VectorConstantCoefficient raw_current(raw_value);
        ChargeTerminalCurrentRequest request;
        request.conductor.mesh = &mesh;
        request.conductor.conductivity = &conductivity;
        request.conductor.stable_vertex_identities = ids;
        request.terminals = {fixture_terminal_on_x(mesh, ids, "left", 0.0, -2.0),
            fixture_terminal_on_x(mesh, ids, "right", 1.0, 2.0)};
        const auto from_h1 = [&](const ChargeTerminalCurrentRequest &source) {
            const auto h1 = solve_charge_terminal_current_constraints(source);
            std::vector<Rt0TerminalFluxConstraint> terminals;
            for (std::size_t terminal = 0; terminal < h1->terminal_ids.size(); ++terminal) {
                terminals.push_back({h1->terminal_ids[terminal], h1->terminal_boundary_face_vertex_ids[terminal],
                    h1->measured_outward_currents_a[terminal]});
            }
            return terminals;
        };
        const auto terminals = from_h1(request);
        retained = project_terminal_constrained_rt0(mesh, ids, raw_current, conductivity, terminals);
        retained_ids = ids;
        retained_element_count = mesh.GetNE();
        const auto &rank = retained->constraint_rank_certificate();
        require(rank.rows_before == static_cast<std::uint64_t>(mesh.GetNE() + 2) &&
                rank.rank + 1 == rank.rows_before && rank.omitted_rows.size() == 1 &&
                rank.omitted_rows.front().reason == ConstraintOmissionReason::ConsistentLinearDependency &&
                std::abs(rank.omitted_rows.front().residual_a) <= 1.0e-18 +
                    1.0e-10 * (std::abs(terminals[0].measured_outward_current_a) +
                        std::abs(terminals[1].measured_outward_current_a)),
            "terminal RT0 rank did not certify the one consistent global flux dependency");
        const auto check_currents = [&](const TerminalConstrainedRt0Projection::Ptr &projection,
                                        const std::vector<Rt0TerminalFluxConstraint> &constraints) {
            require(projection->terminal_ids().size() == constraints.size() &&
                    projection->measured_outward_currents_a().size() == constraints.size() &&
                    projection->current_residuals_a().size() == constraints.size(),
                "terminal RT0 omitted measurement of a dependent input terminal row");
            for (std::size_t terminal = 0; terminal < constraints.size(); ++terminal) {
                const double measured_h1 = constraints[terminal].measured_outward_current_a;
                require(projection->terminal_ids()[terminal] == constraints[terminal].id &&
                        std::abs(projection->measured_outward_currents_a()[terminal] - measured_h1) <=
                            1.0e-18 + 1.0e-8 * std::abs(measured_h1) &&
                        std::abs(projection->current_residuals_a()[terminal]) <=
                            1.0e-18 + 1.0e-8 * std::abs(measured_h1),
                    "terminal RT0 flux changed the measured H1 terminal current");
            }
        };
        check_field(retained, 2.0);
        check_currents(retained, terminals);
        auto relabelled_ids = ids;
        for (auto &id : relabelled_ids.local_to_stable) id = 2000u - id;
        auto relabelled_terminals = terminals;
        for (auto &terminal : relabelled_terminals) {
            for (auto &key : terminal.boundary_face_vertex_ids) {
                for (auto &id : key) id = 2000u - id;
                std::sort(key.begin(), key.end());
            }
        }
        const auto relabelled = project_terminal_constrained_rt0(
            mesh, relabelled_ids, raw_current, conductivity, relabelled_terminals);
        require(relabelled->stable_vertex_identities().local_to_stable == relabelled_ids.local_to_stable,
            "terminal RT0 relabelling did not retain the actual stable vertex identities");
        check_field(relabelled, 2.0);
        check_currents(relabelled, relabelled_terminals);
        auto reversed = request;
        for (auto &terminal : reversed.terminals) terminal.requested_outward_current_a *= -1.0;
        const auto reverse_terminals = from_h1(reversed);
        const auto reverse_projection = project_terminal_constrained_rt0(mesh, ids, raw_current, conductivity, reverse_terminals);
        check_field(reverse_projection, -2.0);
        check_currents(reverse_projection, reverse_terminals);
        auto zero = request;
        for (auto &terminal : zero.terminals) terminal.requested_outward_current_a = 0.0;
        const auto zero_terminals = from_h1(zero);
        const auto zero_projection = project_terminal_constrained_rt0(mesh, ids, raw_current, conductivity, zero_terminals);
        check_field(zero_projection, 0.0);
        check_currents(zero_projection, zero_terminals);
        auto inconsistent = terminals;
        inconsistent.back().measured_outward_current_a += 0.25;
        bool dependency_rejected = false;
        try {
            (void)project_terminal_constrained_rt0(mesh, ids, raw_current, conductivity, inconsistent);
        } catch (const InconsistentDependentConstraint &error) {
            dependency_rejected = !error.constraint_id().empty() && std::isfinite(error.residual_a()) &&
                std::abs(error.residual_a()) > 1.0e-8;
        }
        require(dependency_rejected, "inconsistent H1 terminal RHS did not fail its exact dependent-row gate");
        auto unknown = terminals;
        unknown.front().boundary_face_vertex_ids.front() = {999990u, 999991u, 999992u};
        require_rejected([&] {
            (void)project_terminal_constrained_rt0(mesh, ids, raw_current, conductivity, unknown);
        }, "terminal RT0 accepted an unknown physical face");
        auto duplicate = terminals;
        duplicate.front().boundary_face_vertex_ids.back() = duplicate.front().boundary_face_vertex_ids.front();
        require_rejected([&] {
            (void)project_terminal_constrained_rt0(mesh, ids, raw_current, conductivity, duplicate);
        }, "terminal RT0 accepted a duplicate physical face");
    }
    require(retained->stable_vertex_identities().version == retained_ids.version &&
            retained->stable_vertex_identities().local_to_stable == retained_ids.local_to_stable &&
            retained->field().FESpace()->GetMesh()->GetNE() == retained_element_count &&
            retained->measured_outward_currents_a().size() == 2,
        "terminal RT0 projection lost stable topology or terminal measurements after source destruction");
    check_field(retained, 2.0);
}

std::vector<fullmag::fem::transport::Rt0InterfaceFacePair> fixture_series_interface_pairs(
    const mfem::Mesh &fixture, const StableMeshVertexIdentities &identities, int first_vertex_count)
{
    using fullmag::fem::transport::Rt0InterfaceFacePair;
    std::vector<Rt0InterfaceFacePair> pairs;
    for (int boundary : boundary_elements_on_x(fixture, 1.0)) {
        mfem::Array<int> vertices;
        fixture.GetBdrElementVertices(boundary, vertices);
        if (vertices[0] >= first_vertex_count) continue;
        Rt0InterfaceFacePair pair;
        pair.id = "series-interface:" + std::to_string(pairs.size());
        pair.first_face_vertex_ids = sorted_face_key(fixture, identities, boundary);
        for (int corner = 0; corner < 3; ++corner) {
            const int vertex = vertices[corner];
            int match = -1;
            for (int other = first_vertex_count; other < fixture.GetNV(); ++other) {
                const double *a = fixture.GetVertex(vertex), *b = fixture.GetVertex(other);
                if (a[0] == b[0] && a[1] == b[1] && a[2] == b[2]) match = other;
            }
            require(match >= 0, "explicit interface fixture has no coincident declared vertex");
            pair.vertex_pairs[corner] = {identities.local_to_stable[vertex], identities.local_to_stable[match]};
            pair.second_face_vertex_ids[corner] = identities.local_to_stable[match];
        }
        std::sort(pair.second_face_vertex_ids.begin(), pair.second_face_vertex_ids.end());
        bool exterior_match = false;
        for (int other : boundary_elements_on_x(fixture, 1.0)) {
            exterior_match = exterior_match || sorted_face_key(fixture, identities, other) == pair.second_face_vertex_ids;
        }
        require(exterior_match, "declared interface fixture does not resolve to a real second boundary face");
        pairs.push_back(pair);
    }
    require(pairs.size() == 2, "2x1x1 series fixture must declare both interface triangles");
    return pairs;
}

void terminal_rt0_explicit_interfaces_preserve_signed_series_currents()
{
    using fullmag::fem::antenna_field_solve::ChargeTerminalCurrentRequest;
    using fullmag::fem::antenna_field_solve::solve_charge_terminal_current_constraints;
    using fullmag::fem::transport::Rt0TerminalFluxConstraint;
    using fullmag::fem::transport::project_terminal_constrained_rt0;
    auto left = shifted_unit_cube(0.0, 1);
    auto right = shifted_unit_cube(1.0, 1);
    auto mesh = combine_disjoint_tetrahedral_meshes(left, right);
    const auto ids = stable_vertex_ids(mesh); // Real fixture IDs, including distinct coincident vertices.
    const auto interfaces = fixture_series_interface_pairs(mesh, ids, left.GetNV());
    mfem::ConstantCoefficient conductivity(4.0);
    mfem::Vector raw_value(3);
    raw_value = 0.0;
    raw_value[0] = 1.0;
    mfem::VectorConstantCoefficient raw_current(raw_value);
    mfem::H1_FECollection collection(1, 3);
    mfem::FiniteElementSpace space(&mesh, &collection);
    ChargeTerminalCurrentRequest request;
    request.conductor.mesh = &mesh;
    request.conductor.conductivity = &conductivity;
    request.conductor.stable_vertex_identities = ids;
    request.terminals = {fixture_terminal_on_x(mesh, ids, "left", 0.0, -1.0),
        fixture_terminal_on_x(mesh, ids, "right", 2.0, 1.0)};
    std::set<std::array<std::uint64_t, 2>> declared_vertices;
    for (const auto &pair : interfaces) {
        for (const auto &map : pair.vertex_pairs) {
            if (!declared_vertices.insert(map).second) continue;
            const int first = static_cast<int>(std::find(ids.local_to_stable.begin(), ids.local_to_stable.end(), map[0]) - ids.local_to_stable.begin());
            const int second = static_cast<int>(std::find(ids.local_to_stable.begin(), ids.local_to_stable.end(), map[1]) - ids.local_to_stable.begin());
            mfem::Array<int> minus, plus;
            space.GetVertexDofs(first, minus);
            space.GetVertexDofs(second, plus);
            require(minus.Size() == 1 && plus.Size() == 1, "declared interface vertex has no scalar P1 DOF");
            request.conductor.trace_relations.push_back({minus[0], plus[0], 0.0, "declared-interface:" + std::to_string(map[0])});
        }
    }
    const auto measured_h1 = [&](const ChargeTerminalCurrentRequest &source, double current) {
        const auto h1 = solve_charge_terminal_current_constraints(source);
        require(h1->accepted_solution->component_ids.size() == 1 &&
                h1->reference_terminal_ids == std::vector<std::string>{"left"},
            "declared P1 interface did not create one reference-anchored series conductor");
        for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
            require(std::abs(h1->accepted_solution->potential_vertex_values_v[vertex] + current * mesh.GetVertex(vertex)[0] / 4.0) < 1.0e-10,
                "declared P1 interface disagrees with analytic series V=-I*x/4");
        }
        std::vector<Rt0TerminalFluxConstraint> terminals;
        for (std::size_t terminal = 0; terminal < h1->terminal_ids.size(); ++terminal) {
            const double expected = source.terminals[terminal].requested_outward_current_a;
            require(std::abs(h1->measured_outward_currents_a[terminal] - expected) <= 1.0e-18 + 1.0e-8 * std::abs(expected),
                "declared P1 series source failed its own signed terminal certificate");
            terminals.push_back({h1->terminal_ids[terminal], h1->terminal_boundary_face_vertex_ids[terminal],
                h1->measured_outward_currents_a[terminal]});
        }
        return terminals;
    };
    const auto check_projection = [&](const auto &projection, const auto &terminals,
                                      const auto &pairs, double current) {
        const auto &rank = projection->constraint_rank_certificate();
        require(rank.rows_before == static_cast<std::uint64_t>(mesh.GetNE() + pairs.size() + terminals.size()) &&
                rank.rank + 1 == rank.rows_before && rank.omitted_rows.size() == 1 &&
                rank.omitted_rows.front().reason == ConstraintOmissionReason::ConsistentLinearDependency &&
                std::abs(rank.omitted_rows.front().residual_a) <= 1.0e-18 + 1.0e-10 *
                    (std::abs(terminals[0].measured_outward_current_a) + std::abs(terminals[1].measured_outward_current_a)),
            "series RT0 did not certify full div/pair/terminal rank and one compatible dependency");
        require(projection->measured_outward_currents_a().size() == terminals.size() &&
                projection->interface_flux_measurements().size() == pairs.size(),
            "series RT0 lost an input terminal or interface measurement");
        for (std::size_t terminal = 0; terminal < terminals.size(); ++terminal) {
            const double expected = terminals[terminal].measured_outward_current_a;
            require(projection->terminal_ids()[terminal] == terminals[terminal].id &&
                    std::abs(projection->measured_outward_currents_a()[terminal] - expected) <= 1.0e-18 + 1.0e-8 * std::abs(expected) &&
                    std::abs(projection->current_residuals_a()[terminal]) <= 1.0e-18 + 1.0e-8 * std::abs(expected),
                "series RT0 changed a measured H1 terminal current, including its dependent row");
        }
        for (std::size_t pair = 0; pair < pairs.size(); ++pair) {
            const auto &measurement = projection->interface_flux_measurements()[pair];
            require(measurement.id == pairs[pair].id &&
                    std::abs(measurement.first_outward_current_a - current / 2.0) < 1.0e-10 &&
                    std::abs(measurement.second_outward_current_a + current / 2.0) < 1.0e-10 &&
                    std::abs(measurement.mismatch_a) <= 1.0e-18 + 1.0e-10 *
                        (std::abs(measurement.first_outward_current_a) + std::abs(measurement.second_outward_current_a)),
                "series RT0 interface does not retain independently measured opposite signed triangle fluxes");
        }
        const auto &field = projection->field();
        auto *owned_mesh = field.FESpace()->GetMesh();
        for (int element = 0; element < owned_mesh->GetNE(); ++element) {
            auto *transformation = owned_mesh->GetElementTransformation(element);
            const auto &rule = mfem::IntRules.Get(mfem::Geometry::TETRAHEDRON, 4);
            for (int point = 0; point < rule.GetNPoints(); ++point) {
                transformation->SetIntPoint(&rule.IntPoint(point));
                mfem::Vector value(3);
                field.GetVectorValue(*transformation, rule.IntPoint(point), value);
                require(std::abs(value[0] - current) < 1.0e-10 && std::abs(value[1]) < 1.0e-10 && std::abs(value[2]) < 1.0e-10,
                    "series RT0 did not recover analytic J=(I,0,0) on both disconnected meshes");
            }
        }
    };
    const auto terminals = measured_h1(request, 1.0);
    check_projection(project_terminal_constrained_rt0(mesh, ids, raw_current, conductivity, terminals, interfaces),
        terminals, interfaces, 1.0);
    auto reversed = request;
    for (auto &terminal : reversed.terminals) terminal.requested_outward_current_a *= -1.0;
    const auto reverse_terminals = measured_h1(reversed, -1.0);
    auto permuted_pairs = interfaces;
    std::reverse(permuted_pairs.begin(), permuted_pairs.end());
    for (auto &pair : permuted_pairs) std::reverse(pair.vertex_pairs.begin(), pair.vertex_pairs.end());
    check_projection(project_terminal_constrained_rt0(mesh, ids, raw_current, conductivity, reverse_terminals, permuted_pairs),
        reverse_terminals, permuted_pairs, -1.0);
    const auto reject = [&](mfem::Mesh &fixture, const auto &constraints, const auto &pairs, const std::string &fragment) {
        bool rejected = false;
        try {
            (void)project_terminal_constrained_rt0(fixture, ids, raw_current, conductivity, constraints, pairs);
        } catch (const std::invalid_argument &error) {
            rejected = std::string(error.what()).find(fragment) != std::string::npos;
        }
        require(rejected, "explicit RT0 interface missed its specific rejection: " + fragment);
    };
    auto malformed = interfaces;
    malformed[0].vertex_pairs[0][1] = 0;
    reject(mesh, terminals, malformed, "vertex map is not a bijection");
    malformed = interfaces;
    malformed[0].vertex_pairs[1] = malformed[0].vertex_pairs[0];
    reject(mesh, terminals, malformed, "vertex map is not a bijection");
    malformed = interfaces;
    std::swap(malformed[0].vertex_pairs[0][1], malformed[0].vertex_pairs[1][1]);
    reject(mesh, terminals, malformed, "not exactly geometrically coincident");
    malformed = interfaces;
    malformed[1] = malformed[0];
    malformed[1].id = "reused-interface-face";
    reject(mesh, terminals, malformed, "not reused by a terminal or pair");
    malformed = interfaces;
    malformed[0].first_face_vertex_ids = terminals[0].boundary_face_vertex_ids[0];
    reject(mesh, terminals, malformed, "not reused by a terminal or pair");
    auto displaced = mfem::Mesh(mesh);
    // Displace a declared interface vertex, not an arbitrary interior vertex.
    const auto moved = std::find(ids.local_to_stable.begin(), ids.local_to_stable.end(), interfaces[0].vertex_pairs[0][1]);
    displaced.GetVertex(static_cast<int>(moved - ids.local_to_stable.begin()))[1] += 0.01;
    reject(displaced, terminals, interfaces, "not exactly geometrically coincident");
    auto overlapping = combine_disjoint_tetrahedral_meshes(left, left);
    const auto same_outward = fixture_series_interface_pairs(overlapping, ids, left.GetNV());
    std::vector<Rt0TerminalFluxConstraint> overlap_terminals{{"first-left", {}, 0.0}, {"second-left", {}, 0.0}};
    for (int boundary : boundary_elements_on_x(overlapping, 0.0)) {
        mfem::Array<int> vertices;
        overlapping.GetBdrElementVertices(boundary, vertices);
        overlap_terminals[vertices[0] < left.GetNV() ? 0 : 1].boundary_face_vertex_ids.push_back(sorted_face_key(overlapping, ids, boundary));
    }
    reject(overlapping, overlap_terminals, same_outward, "outward normals are not opposite");
}

void terminal_rt0_projection_keeps_disconnected_current_scales()
{
    using fullmag::fem::antenna_field_solve::ChargeTerminalCurrentRequest;
    using fullmag::fem::antenna_field_solve::solve_charge_terminal_current_constraints;
    using fullmag::fem::transport::Rt0TerminalFluxConstraint;
    using fullmag::fem::transport::project_terminal_constrained_rt0;
    auto lower = shifted_unit_cube(0.0, 1);
    auto upper = shifted_unit_cube(0.0, 2);
    for (int vertex = 0; vertex < upper.GetNV(); ++vertex) upper.GetVertex(vertex)[1] += 2.0;
    auto mesh = combine_disjoint_tetrahedral_meshes(lower, upper);
    const auto ids = stable_vertex_ids(mesh);
    mfem::Vector conductivity_values(2);
    conductivity_values[0] = 4.0;
    conductivity_values[1] = 4.0e-4;
    mfem::PWConstCoefficient conductivity(conductivity_values);
    ChargeTerminalCurrentRequest request;
    request.conductor.mesh = &mesh;
    request.conductor.conductivity = &conductivity;
    request.conductor.stable_vertex_identities = ids;
    request.terminals = {fixture_terminal_on_x(mesh, ids, "a-left", 0.0, -1.0, 0.0, 1.0),
        fixture_terminal_on_x(mesh, ids, "a-right", 1.0, 1.0, 0.0, 1.0),
        fixture_terminal_on_x(mesh, ids, "b-left", 0.0, -1.0e-4, 2.0, 3.0),
        fixture_terminal_on_x(mesh, ids, "b-right", 1.0, 1.0e-4, 2.0, 3.0)};
    const auto h1 = solve_charge_terminal_current_constraints(request);
    require(h1->reference_terminal_ids == std::vector<std::string>({"a-left", "b-left"}),
        "disconnected terminal RT0 fixture lost its two physical H1 references");
    std::vector<Rt0TerminalFluxConstraint> terminals;
    for (std::size_t terminal = 0; terminal < h1->terminal_ids.size(); ++terminal) {
        terminals.push_back({h1->terminal_ids[terminal], h1->terminal_boundary_face_vertex_ids[terminal],
            h1->measured_outward_currents_a[terminal]});
    }
    mfem::Vector raw_value(3);
    raw_value = 0.0;
    raw_value[0] = 1.0; // The small component must be constrained, not left at raw current.
    mfem::VectorConstantCoefficient raw_current(raw_value);
    const auto projection = project_terminal_constrained_rt0(mesh, ids, raw_current, conductivity, terminals);
    const auto &rank = projection->constraint_rank_certificate();
    require(rank.rows_before == static_cast<std::uint64_t>(mesh.GetNE() + 4) &&
            rank.rank + 2 == rank.rows_before && rank.omitted_rows.size() == 2 &&
            projection->terminal_ids().size() == 4 && projection->measured_outward_currents_a().size() == 4 &&
            projection->current_residuals_a().size() == 4,
        "disconnected terminal RT0 rank/results lost one component dependency or input terminal");
    for (const auto &omitted : rank.omitted_rows) {
        require(omitted.reason == ConstraintOmissionReason::ConsistentLinearDependency,
            "disconnected terminal RT0 omitted an unjustified constraint row");
    }
    for (std::size_t terminal = 0; terminal < terminals.size(); ++terminal) {
        const double expected = terminals[terminal].measured_outward_current_a;
        const double own_tolerance = 1.0e-18 + 1.0e-8 * std::abs(expected);
        require(projection->terminal_ids()[terminal] == terminals[terminal].id &&
                std::abs(projection->measured_outward_currents_a()[terminal] - expected) <= own_tolerance &&
                std::abs(projection->current_residuals_a()[terminal]) <= own_tolerance,
            "disconnected RT0 terminal/ref current was certified against a foreign component scale");
    }
    const auto &field = projection->field();
    for (int element = 0; element < mesh.GetNE(); ++element) {
        auto *transformation = field.FESpace()->GetMesh()->GetElementTransformation(element);
        const double expected = mesh.GetElement(element)->GetAttribute() == 1 ? 1.0 : 1.0e-4;
        const auto &rule = mfem::IntRules.Get(mfem::Geometry::TETRAHEDRON, 4);
        for (int point = 0; point < rule.GetNPoints(); ++point) {
            transformation->SetIntPoint(&rule.IntPoint(point));
            mfem::Vector value(3);
            field.GetVectorValue(*transformation, rule.IntPoint(point), value);
            require(std::abs(value[0] - expected) < 1.0e-10 &&
                    std::abs(value[1]) < 1.0e-10 && std::abs(value[2]) < 1.0e-10,
                "disconnected terminal RT0 retained raw J instead of the measured H1 current density");
        }
    }
}

void accepted_terminal_charge_source_freezes_layered_material_and_one_mesh()
{
    using fullmag::fem::antenna_field_solve::AcceptedTerminalChargeRequest;
    using fullmag::fem::antenna_field_solve::AcceptedTerminalChargeSource;
    using fullmag::fem::antenna_field_solve::solve_accepted_terminal_charge_source;
    AcceptedTerminalChargeSource::Ptr retained;
    StableMeshVertexIdentities frozen_ids;
    std::vector<double> frozen_sigma;
    std::vector<int> frozen_attributes;
    std::vector<std::array<double, 3>> frozen_positions;
    const auto check = [&](const AcceptedTerminalChargeSource::Ptr &source, double sign) {
        const auto &potential = source->potential();
        const auto &current = source->rt0_projection().field();
        auto *mesh = potential.FESpace()->GetMesh();
        require(mesh == current.FESpace()->GetMesh(), "accepted terminal P1 and RT0 retain different owned meshes");
        require(source->conductivity_spm_per_element() == frozen_sigma &&
                source->rt0_projection().stable_vertex_identities().local_to_stable == frozen_ids.local_to_stable &&
                source->terminal_solution().accepted_solution->stable_vertex_identities.local_to_stable == frozen_ids.local_to_stable,
            "accepted terminal result changed frozen conductivity or real vertex identities");
        require(source->terminal_solution().reference_terminal_ids == std::vector<std::string>{"left"},
            "layered accepted terminal source did not retain the stable-ID reference");
        for (int vertex = 0; vertex < mesh->GetNV(); ++vertex) {
            for (int component = 0; component < 3; ++component) {
                require(mesh->GetVertex(vertex)[component] == frozen_positions[vertex][component],
                    "accepted terminal mesh aliases a mutated source vertex");
            }
            mfem::Array<int> dofs;
            potential.FESpace()->GetVertexDofs(vertex, dofs);
            require(dofs.Size() == 1 && dofs[0] >= 0, "retained P1 has no unique vertex DOF");
            const double x = frozen_positions[vertex][0];
            const double expected = sign * (x <= 0.5 ? -x / 4.0 : -0.125 - (x - 0.5) / 8.0);
            require(std::abs(potential[dofs[0]] - expected) < 1.0e-10 &&
                    std::abs(source->terminal_solution().accepted_solution->potential_vertex_values_v[vertex] - expected) < 1.0e-10,
                "layered accepted terminal P1 V differs from the analytic series-conductor solution");
        }
        for (int element = 0; element < mesh->GetNE(); ++element) {
            require(mesh->GetElement(element)->GetAttribute() == frozen_attributes[element],
                "accepted terminal material attributes/order were rewritten to conductivity indices");
            auto *transformation = mesh->GetElementTransformation(element);
            const auto &rule = mfem::IntRules.Get(mfem::Geometry::TETRAHEDRON, 4);
            for (int point = 0; point < rule.GetNPoints(); ++point) {
                transformation->SetIntPoint(&rule.IntPoint(point));
                mfem::Vector gradient(3), value(3);
                potential.GetGradient(*transformation, gradient);
                current.GetVectorValue(*transformation, rule.IntPoint(point), value);
                for (int component = 0; component < 3; ++component) {
                    const double expected_gradient = component == 0 ? -sign / frozen_sigma[element] : 0.0;
                    const double expected_current = component == 0 ? sign : 0.0;
                    require(std::abs(gradient[component] - expected_gradient) < 1.0e-10 &&
                            std::abs(-frozen_sigma[element] * gradient[component] - expected_current) < 1.0e-10 &&
                            std::abs(value[component] - expected_current) < 1.0e-10,
                        "layered accepted source mixed P1 V, frozen sigma or reconstructed RT0 physics");
                }
            }
        }
        for (std::size_t terminal = 0; terminal < source->terminal_solution().terminal_ids.size(); ++terminal) {
            const double expected = source->terminal_solution().terminal_ids[terminal] == "left" ? -sign : sign;
            const double tolerance = 1.0e-18 + 1.0e-8 * std::abs(expected);
            require(std::abs(source->terminal_solution().measured_outward_currents_a[terminal] - expected) <= tolerance &&
                    std::abs(source->rt0_projection().measured_outward_currents_a()[terminal] - expected) <= tolerance,
                "accepted terminal source did not preserve all requested H1/RT0 signed currents");
        }
    };
    {
        auto mesh = shifted_unit_cube(0.0, 1);
        frozen_ids = stable_vertex_ids(mesh);
        for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
            if (std::abs(mesh.GetVertex(vertex)[0]) < 1.0e-13) frozen_ids.local_to_stable[vertex] = 100u + vertex;
            frozen_positions.push_back({mesh.GetVertex(vertex)[0], mesh.GetVertex(vertex)[1], mesh.GetVertex(vertex)[2]});
        }
        for (int element = 0; element < mesh.GetNE(); ++element) {
            mfem::Array<int> vertices;
            mesh.GetElementVertices(element, vertices);
            double x = 0.0;
            for (int vertex : vertices) x += mesh.GetVertex(vertex)[0] / vertices.Size();
            frozen_sigma.push_back(x < 0.5 ? 4.0 : 8.0);
            const int attribute = 17 + 3 * element;
            mesh.GetElement(element)->SetAttribute(attribute);
            frozen_attributes.push_back(attribute);
        }
        AcceptedTerminalChargeRequest request;
        request.mesh = &mesh;
        request.stable_vertex_identities = frozen_ids;
        request.conductivity_spm_per_element = frozen_sigma;
        request.terminals = {fixture_terminal_on_x(mesh, frozen_ids, "left", 0.0, -1.0),
            fixture_terminal_on_x(mesh, frozen_ids, "right", 1.0, 1.0)};
        retained = solve_accepted_terminal_charge_source(request);
        check(retained, 1.0);
        auto reversed = request;
        for (auto &terminal : reversed.terminals) terminal.requested_outward_current_a *= -1.0;
        check(solve_accepted_terminal_charge_source(reversed), -1.0);
        auto zero = request;
        for (auto &terminal : zero.terminals) terminal.requested_outward_current_a = 0.0;
        check(solve_accepted_terminal_charge_source(zero), 0.0);
        for (double jump : {0.0, 0.1}) {
            auto trace = request;
            trace.trace_relations.push_back({0, 0, jump, "unsupported-trace"});
            require_rejected([&] { (void)solve_accepted_terminal_charge_source(trace); },
                "accepted terminal source accepted a trace relation without RT0 pairing");
        }
        auto wrong_count = request;
        wrong_count.conductivity_spm_per_element.pop_back();
        require_rejected([&] { (void)solve_accepted_terminal_charge_source(wrong_count); },
            "accepted terminal source accepted a foreign conductivity element count");
        for (double invalid : {0.0, -1.0, std::numeric_limits<double>::infinity(),
                                std::numeric_limits<double>::quiet_NaN()}) {
            auto invalid_material = request;
            invalid_material.conductivity_spm_per_element.front() = invalid;
            require_rejected([&] { (void)solve_accepted_terminal_charge_source(invalid_material); },
                "accepted terminal source accepted nonpositive or nonfinite conductivity");
        }
        std::fill(request.conductivity_spm_per_element.begin(), request.conductivity_spm_per_element.end(), 99.0);
        std::fill(request.stable_vertex_identities.local_to_stable.begin(), request.stable_vertex_identities.local_to_stable.end(), 0u);
        for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) mesh.GetVertex(vertex)[0] += 7.0;
        for (int element = 0; element < mesh.GetNE(); ++element) mesh.GetElement(element)->SetAttribute(99);
        request.terminals.clear();
        check(retained, 1.0);
    }
    check(retained, 1.0);
}

void accepted_terminal_charge_source_freezes_explicit_interface_series()
{
    using fullmag::fem::antenna_field_solve::AcceptedTerminalChargeRequest;
    using fullmag::fem::antenna_field_solve::AcceptedTerminalChargeSource;
    using fullmag::fem::antenna_field_solve::solve_accepted_terminal_charge_source;
    using fullmag::fem::transport::Rt0InterfaceFacePair;
    AcceptedTerminalChargeSource::Ptr retained;
    StableMeshVertexIdentities frozen_ids;
    std::vector<Rt0InterfaceFacePair> frozen_pairs;
    std::vector<double> frozen_sigma;
    std::vector<std::array<double, 3>> frozen_positions;
    const auto check = [&](const AcceptedTerminalChargeSource::Ptr &source, double current_a) {
        const auto &potential = source->potential();
        const auto &projection = source->rt0_projection();
        auto *mesh = potential.FESpace()->GetMesh();
        const auto &terminal = source->terminal_solution();
        require(mesh == projection.field().FESpace()->GetMesh() &&
                source->conductivity_spm_per_element() == frozen_sigma &&
                projection.stable_vertex_identities().local_to_stable == frozen_ids.local_to_stable &&
                terminal.accepted_solution->stable_vertex_identities.local_to_stable == frozen_ids.local_to_stable,
            "accepted interface source did not freeze one P1/RT0 mesh, material and real identities");
        require(terminal.terminal_ids == std::vector<std::string>({"left", "right"}) &&
                terminal.reference_terminal_ids == std::vector<std::string>{"left"} &&
                terminal.terminal_voltages_v.size() == 2 && terminal.measured_outward_currents_a.size() == 2 &&
                terminal.current_residuals_a.size() == 2 && projection.measured_outward_currents_a().size() == 2 &&
                projection.current_residuals_a().size() == 2 &&
                terminal.terminal_component_ids.size() == 2 &&
                terminal.terminal_component_ids[0] == terminal.terminal_component_ids[1] &&
                terminal.accepted_solution->component_ids.size() == 1 &&
                terminal.accepted_solution->gauge_vertex_ids.empty(),
            "accepted interface source did not keep both terminals in one reference-anchored component");
        require(source->interface_pairs().size() == frozen_pairs.size() &&
                projection.interface_flux_measurements().size() == frozen_pairs.size(),
            "accepted interface source did not retain all authored maps and independent measurements");
        for (std::size_t pair = 0; pair < frozen_pairs.size(); ++pair) {
            const auto &owned = source->interface_pairs()[pair];
            const auto &expected = frozen_pairs[pair];
            const auto &measurement = projection.interface_flux_measurements()[pair];
            require(owned.id == expected.id && owned.first_face_vertex_ids == expected.first_face_vertex_ids &&
                    owned.second_face_vertex_ids == expected.second_face_vertex_ids && owned.vertex_pairs == expected.vertex_pairs &&
                    measurement.id == expected.id,
                "accepted interface source aliases caller pair topology or changed measurement identity");
            require(std::abs(measurement.first_outward_current_a - current_a / 2.0) < 1.0e-10 &&
                    std::abs(measurement.second_outward_current_a + current_a / 2.0) < 1.0e-10 &&
                    std::abs(measurement.mismatch_a) <= 1.0e-18 + 1.0e-10 *
                        (std::abs(measurement.first_outward_current_a) + std::abs(measurement.second_outward_current_a)),
                "accepted series interface lost its signed half-area flux or own continuity certificate");
        }
        for (int vertex = 0; vertex < mesh->GetNV(); ++vertex) {
            for (int component = 0; component < 3; ++component) {
                require(mesh->GetVertex(vertex)[component] == frozen_positions[vertex][component],
                    "accepted interface mesh aliases a caller coordinate mutation");
            }
            mfem::Array<int> dofs;
            potential.FESpace()->GetVertexDofs(vertex, dofs);
            require(dofs.Size() == 1 && dofs[0] >= 0, "accepted interface vertex has no unique P1 DOF");
            const double x = frozen_positions[vertex][0];
            const double expected = current_a * (x <= 1.0 ? -x / 4.0 : -0.25 - (x - 1.0) / 8.0);
            require(std::abs(potential[dofs[0]] - expected) < 1.0e-10 &&
                    std::abs(terminal.accepted_solution->potential_vertex_values_v[vertex] - expected) < 1.0e-10,
                "accepted interface P1 V disagrees with sigma4/8 full-series solution");
        }
        for (int element = 0; element < mesh->GetNE(); ++element) {
            auto *transformation = mesh->GetElementTransformation(element);
            const auto &rule = mfem::IntRules.Get(mfem::Geometry::TETRAHEDRON, 4);
            for (int point = 0; point < rule.GetNPoints(); ++point) {
                transformation->SetIntPoint(&rule.IntPoint(point));
                mfem::Vector gradient(3), value(3);
                potential.GetGradient(*transformation, gradient);
                projection.field().GetVectorValue(*transformation, rule.IntPoint(point), value);
                for (int component = 0; component < 3; ++component) {
                    const double expected = component == 0 ? current_a : 0.0;
                    require(std::abs(gradient[component] + expected / frozen_sigma[element]) < 1.0e-10 &&
                            std::abs(-frozen_sigma[element] * gradient[component] - expected) < 1.0e-10 &&
                            std::abs(value[component] - expected) < 1.0e-10,
                        "accepted interface H1/material/RT0 do not describe the same series current");
                }
            }
        }
        require(std::abs(terminal.terminal_voltages_v[0]) < 1.0e-10 &&
                std::abs(terminal.terminal_voltages_v[1] + 3.0 * current_a / 8.0) < 1.0e-10,
            "accepted series terminal voltage differs from R=1/4+1/8 ohm");
        for (std::size_t index = 0; index < 2; ++index) {
            const double expected = index == 0 ? -current_a : current_a;
            const double tolerance = 1.0e-18 + 1.0e-8 * std::abs(expected);
            require(std::abs(terminal.measured_outward_currents_a[index] - expected) <= tolerance &&
                    std::abs(terminal.current_residuals_a[index]) <= tolerance &&
                    std::abs(projection.measured_outward_currents_a()[index] - expected) <= tolerance &&
                    std::abs(projection.current_residuals_a()[index]) <= tolerance,
                "accepted interface source lost an H1/RT0 terminal current, including reference or zero drive");
        }
    };
    {
        auto left = shifted_unit_cube(0.0, 1);
        auto right = shifted_unit_cube(1.0, 2);
        auto mesh = combine_disjoint_tetrahedral_meshes(left, right);
        frozen_ids = stable_vertex_ids(mesh);
        frozen_pairs = fixture_series_interface_pairs(mesh, frozen_ids, left.GetNV());
        for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
            frozen_positions.push_back({mesh.GetVertex(vertex)[0], mesh.GetVertex(vertex)[1], mesh.GetVertex(vertex)[2]});
        }
        frozen_sigma.assign(static_cast<std::size_t>(left.GetNE()), 4.0);
        frozen_sigma.insert(frozen_sigma.end(), static_cast<std::size_t>(right.GetNE()), 8.0);
        AcceptedTerminalChargeRequest request;
        request.mesh = &mesh;
        request.stable_vertex_identities = frozen_ids;
        request.conductivity_spm_per_element = frozen_sigma;
        request.interface_pairs = frozen_pairs;
        request.terminals = {fixture_terminal_on_x(mesh, frozen_ids, "left", 0.0, -1.0),
            fixture_terminal_on_x(mesh, frozen_ids, "right", 2.0, 1.0)};
        retained = solve_accepted_terminal_charge_source(request);
        check(retained, 1.0);
        auto reversed = request;
        for (auto &terminal : reversed.terminals) terminal.requested_outward_current_a *= -1.0;
        check(solve_accepted_terminal_charge_source(reversed), -1.0);
        auto zero = request;
        for (auto &terminal : zero.terminals) terminal.requested_outward_current_a = 0.0;
        check(solve_accepted_terminal_charge_source(zero), 0.0);
        const auto reject_before_h1 = [&](AcceptedTerminalChargeRequest invalid, const std::string &fragment) {
            invalid.maximum_iterations = 0; // An H1-first implementation would fail the iteration gate instead.
            bool rejected = false;
            try {
                (void)solve_accepted_terminal_charge_source(invalid);
            } catch (const std::invalid_argument &error) {
                rejected = std::string(error.what()).find(fragment) != std::string::npos;
            }
            require(rejected, "accepted interface missed its pre-H1 rejection: " + fragment);
        };
        auto malformed = request;
        malformed.interface_pairs[0].vertex_pairs[0][1] = 0;
        reject_before_h1(malformed, "vertex map is not a bijection");
        malformed = request;
        malformed.interface_pairs[0].first_face_vertex_ids = request.terminals[0].boundary_face_vertex_ids[0];
        reject_before_h1(malformed, "not reused by a terminal or pair");
        auto displaced = mfem::Mesh(mesh);
        const auto moved = std::find(frozen_ids.local_to_stable.begin(), frozen_ids.local_to_stable.end(), frozen_pairs[0].vertex_pairs[0][1]);
        displaced.GetVertex(static_cast<int>(moved - frozen_ids.local_to_stable.begin()))[1] += 0.01;
        malformed = request;
        malformed.mesh = &displaced;
        reject_before_h1(malformed, "not exactly geometrically coincident");
        malformed = request;
        malformed.trace_relations.push_back({0, 0, 0.0, "caller-authored-trace"});
        reject_before_h1(malformed, "trace");
        request.interface_pairs[0].id = "mutated-pair";
        request.interface_pairs[0].vertex_pairs[0] = {0u, 0u};
        request.interface_pairs[0].first_face_vertex_ids = {0u, 0u, 0u};
        request.interface_pairs.clear();
        std::fill(request.conductivity_spm_per_element.begin(), request.conductivity_spm_per_element.end(), 99.0);
        std::fill(request.stable_vertex_identities.local_to_stable.begin(), request.stable_vertex_identities.local_to_stable.end(), 0u);
        for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) mesh.GetVertex(vertex)[0] += 7.0;
        request.terminals.clear();
        check(retained, 1.0);
    }
    check(retained, 1.0); // All borrowed mesh/material/pair inputs have been destroyed.
}

std::string independent_accepted_terminal_content_digest(
    const fullmag::fem::antenna_field_solve::AcceptedTerminalChargeSource &source,
    const fullmag::fem::antenna_field_solve::AcceptedTerminalChargeRequest &policy,
    Bytes *preimage = nullptr)
{
    static_assert(sizeof(double) == 8 && std::numeric_limits<double>::is_iec559,
        "independent accepted digest oracle requires IEEE-754 binary64");
    Bytes bytes;
    const auto be64 = [&](std::uint64_t value) {
        for (int shift = 56; shift >= 0; shift -= 8) bytes.push_back(static_cast<std::uint8_t>(value >> shift));
    };
    const auto header = [&](const std::string &name, std::uint8_t type, std::uint64_t size) {
        be64(name.size());
        bytes.insert(bytes.end(), name.begin(), name.end());
        bytes.push_back(type);
        be64(size);
    };
    const auto text = [&](const std::string &name, const std::string &value) {
        header(name, 1, value.size());
        bytes.insert(bytes.end(), value.begin(), value.end());
    };
    const auto integer = [&](const std::string &name, std::uint64_t value) {
        header(name, 2, 8);
        be64(value);
    };
    const auto real = [&](const std::string &name, double value) {
        require(std::isfinite(value), "independent accepted digest oracle encountered a nonfinite double");
        std::uint64_t bits = 0;
        if (value != 0.0) std::memcpy(&bits, &value, sizeof(bits)); // Canonical +0 includes negative zero.
        header(name, 4, 8);
        be64(bits);
    };
    const auto signed_integer = [&](const std::string &name, int value) {
        integer(name, static_cast<std::uint64_t>(static_cast<std::int64_t>(value)));
    };
    text("schema", "accepted_terminal_charge_source.ordered.v1");
    text("operator", "fem_accepted_terminal_charge_source.v1");
    real("absolute_jump_tolerance_v", policy.absolute_jump_tolerance_v);
    real("relative_jump_tolerance", policy.relative_jump_tolerance);
    real("algebraic_relative_tolerance", policy.algebraic_relative_tolerance);
    integer("maximum_iterations", policy.maximum_iterations);
    const auto &projection = source.rt0_projection();
    const auto &ids = projection.stable_vertex_identities();
    const auto &field = projection.field();
    const auto &space = *field.FESpace();
    const auto &mesh = *space.GetMesh();
    const auto &terminal = source.terminal_solution();
    const auto &charge = *terminal.accepted_solution;
    integer("vertices", mesh.GetNV());
    text("stable_vertex_version", ids.version);
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        integer("vertex_id", ids.local_to_stable.at(vertex));
        for (int axis = 0; axis < 3; ++axis) real("xyz_m", mesh.GetVertex(vertex)[axis]);
        real("potential_v", charge.potential_vertex_values_v.at(vertex));
        real("reaction_a", charge.reaction_vertex_values_a.at(vertex));
        integer("vertex_component_id", charge.vertex_component_ids.at(vertex));
    }
    const auto vertex_ids = [&](const mfem::Array<int> &vertices) {
        for (int vertex : vertices) integer("vertex_id", ids.local_to_stable.at(vertex));
    };
    integer("elements", mesh.GetNE());
    for (int element = 0; element < mesh.GetNE(); ++element) {
        signed_integer("attribute", mesh.GetElement(element)->GetAttribute());
        mfem::Array<int> vertices;
        mesh.GetElementVertices(element, vertices);
        vertex_ids(vertices);
        real("conductivity_spm", source.conductivity_spm_per_element().at(element));
    }
    integer("boundary", mesh.GetNBE());
    for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
        signed_integer("attribute", mesh.GetBdrElement(boundary)->GetAttribute());
        mfem::Array<int> vertices;
        mesh.GetBdrElementVertices(boundary, vertices);
        vertex_ids(vertices);
    }
    integer("faces", mesh.GetNumFaces());
    for (int face = 0; face < mesh.GetNumFaces(); ++face) {
        mfem::Array<int> vertices, dofs;
        mesh.GetFaceVertices(face, vertices);
        vertex_ids(vertices);
        int first = -1, second = -1;
        mesh.GetFaceElements(face, &first, &second);
        signed_integer("first_element", first);
        signed_integer("second_element", second);
        space.GetFaceDofs(face, dofs);
        require(dofs.Size() == 1, "independent accepted digest oracle requires one actual RT0 face DOF");
        signed_integer("signed_rt0_dof", dofs[0]);
    }
    integer("rt0", field.Size());
    for (int dof = 0; dof < field.Size(); ++dof) real("rt0_flux_a", field[dof]);
    integer("terminals", terminal.terminal_ids.size());
    for (std::size_t index = 0; index < terminal.terminal_ids.size(); ++index) {
        text("terminal_id", terminal.terminal_ids[index]);
        const auto &faces = terminal.terminal_boundary_face_vertex_ids.at(index);
        integer("terminal_faces", faces.size());
        for (const auto &face : faces) for (auto id : face) integer("vertex_id", id);
        real("requested_current_a", terminal.requested_outward_currents_a.at(index));
        real("h1_current_a", terminal.measured_outward_currents_a.at(index));
        real("h1_residual_a", terminal.current_residuals_a.at(index));
        real("rt0_current_a", projection.measured_outward_currents_a().at(index));
        real("rt0_residual_a", projection.current_residuals_a().at(index));
        real("terminal_voltage_v", terminal.terminal_voltages_v.at(index));
        integer("terminal_component_id", terminal.terminal_component_ids.at(index));
    }
    integer("references", terminal.reference_terminal_ids.size());
    for (std::size_t index = 0; index < terminal.reference_terminal_ids.size(); ++index) {
        text("terminal_id", terminal.reference_terminal_ids[index]);
        integer("component_id", terminal.reference_component_ids.at(index));
    }
    integer("components", charge.component_ids.size());
    for (std::size_t index = 0; index < charge.component_ids.size(); ++index) {
        integer("component_id", charge.component_ids[index]);
        real("component_relative_residual", charge.component_relative_residuals.at(index));
    }
    integer("gauges", charge.gauge_vertex_ids.size());
    for (auto id : charge.gauge_vertex_ids) integer("vertex_id", id);
    integer("interfaces", source.interface_pairs().size());
    for (std::size_t index = 0; index < source.interface_pairs().size(); ++index) {
        const auto &pair = source.interface_pairs()[index];
        text("interface_id", pair.id);
        for (auto id : pair.first_face_vertex_ids) integer("vertex_id", id);
        for (auto id : pair.second_face_vertex_ids) integer("vertex_id", id);
        for (const auto &map : pair.vertex_pairs) for (auto id : map) integer("vertex_id", id);
        const auto &measurement = projection.interface_flux_measurements().at(index);
        real("first_current_a", measurement.first_outward_current_a);
        real("second_current_a", measurement.second_outward_current_a);
        real("interface_mismatch_a", measurement.mismatch_a);
    }
    const auto &rank = projection.constraint_rank_certificate();
    integer("rows_before", rank.rows_before);
    integer("rank", rank.rank);
    integer("omitted", rank.omitted_rows.size());
    for (const auto &row : rank.omitted_rows) {
        text("constraint_id", row.constraint_id);
        integer("omission_reason", static_cast<std::uint64_t>(row.reason));
        real("omitted_residual_a", row.residual_a);
        for (auto id : row.closed_component_anchor_element) integer("vertex_id", id);
    }
    if (preimage != nullptr) *preimage = bytes;
    return sha256_hex(bytes);
}

void accepted_terminal_content_digest_matches_independent_owned_codec()
{
    using fullmag::fem::antenna_field_solve::AcceptedTerminalChargeRequest;
    using fullmag::fem::antenna_field_solve::AcceptedTerminalChargeSource;
    using fullmag::fem::antenna_field_solve::solve_accepted_terminal_charge_source;
    require(sha256_hex(Bytes{'a', 'b', 'c'}) ==
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        "independent accepted digest SHA-256 oracle failed its abc known-answer selfcheck");
    AcceptedTerminalChargeSource::Ptr retained;
    AcceptedTerminalChargeRequest frozen_policy;
    std::string frozen_digest;
    {
        auto left = shifted_unit_cube(0.0, 1);
        auto right = shifted_unit_cube(1.0, 2);
        auto mesh = combine_disjoint_tetrahedral_meshes(left, right);
        AcceptedTerminalChargeRequest request;
        request.mesh = &mesh;
        request.stable_vertex_identities = stable_vertex_ids(mesh);
        request.conductivity_spm_per_element.assign(static_cast<std::size_t>(left.GetNE()), 4.0);
        request.conductivity_spm_per_element.insert(request.conductivity_spm_per_element.end(), static_cast<std::size_t>(right.GetNE()), 8.0);
        request.terminals = {fixture_terminal_on_x(mesh, request.stable_vertex_identities, "left", 0.0, -1.0),
            fixture_terminal_on_x(mesh, request.stable_vertex_identities, "right", 2.0, 1.0)};
        request.interface_pairs = fixture_series_interface_pairs(mesh, request.stable_vertex_identities, left.GetNV());
        const auto solve_and_check = [&](const AcceptedTerminalChargeRequest &input) {
            const auto source = solve_accepted_terminal_charge_source(input);
            Bytes preimage;
            require(source->content_digest() == independent_accepted_terminal_content_digest(*source, input, &preimage),
                "accepted source digest disagrees with independent typed big-endian owned-content codec");
            require(source->canonical_content_bytes() == std::string(preimage.begin(), preimage.end()),
                "accepted source returned bytes differ from the independent digest preimage");
            return source;
        };
        retained = solve_and_check(request);
        frozen_digest = retained->content_digest();
        frozen_policy.absolute_jump_tolerance_v = request.absolute_jump_tolerance_v;
        frozen_policy.relative_jump_tolerance = request.relative_jump_tolerance;
        frozen_policy.algebraic_relative_tolerance = request.algebraic_relative_tolerance;
        frozen_policy.maximum_iterations = request.maximum_iterations;
        require(solve_and_check(request)->content_digest() == frozen_digest,
            "equivalent repeated accepted source request changed its ordered content digest");
        const auto differs = [&](const AcceptedTerminalChargeRequest &input, const std::string &label) {
            require(solve_and_check(input)->content_digest() != frozen_digest,
                "accepted source digest did not bind changed " + label);
        };
        auto changed = request;
        for (auto &terminal : changed.terminals) terminal.requested_outward_current_a *= -1.0;
        differs(changed, "signed current");
        changed = request;
        for (auto &sigma : changed.conductivity_spm_per_element) sigma *= 2.0;
        differs(changed, "conductivity");
        auto moved = mfem::Mesh(mesh);
        for (int vertex = 0; vertex < moved.GetNV(); ++vertex) moved.GetVertex(vertex)[0] += 0.125;
        changed = request;
        changed.mesh = &moved;
        differs(changed, "geometry");
        changed = request;
        for (auto &id : changed.stable_vertex_identities.local_to_stable) id += 5000u;
        for (auto &terminal : changed.terminals) for (auto &face : terminal.boundary_face_vertex_ids) for (auto &id : face) id += 5000u;
        for (auto &pair : changed.interface_pairs) {
            for (auto &id : pair.first_face_vertex_ids) id += 5000u;
            for (auto &id : pair.second_face_vertex_ids) id += 5000u;
            for (auto &map : pair.vertex_pairs) for (auto &id : map) id += 5000u;
        }
        differs(changed, "actual stable IDs");
        auto attributed = mfem::Mesh(mesh);
        attributed.GetElement(0)->SetAttribute(17);
        changed = request;
        changed.mesh = &attributed;
        differs(changed, "element attribute");
        auto boundary_attributed = mfem::Mesh(mesh);
        boundary_attributed.GetBdrElement(0)->SetAttribute(23);
        changed.mesh = &boundary_attributed;
        differs(changed, "boundary attribute");
        changed = request;
        changed.terminals[0].id = "renamed-left";
        differs(changed, "terminal ID");
        changed = request;
        changed.interface_pairs[0].id = "renamed-interface";
        differs(changed, "interface ID");
        changed = request;
        changed.maximum_iterations += 1;
        differs(changed, "solver policy");
        request.interface_pairs.clear();
        request.terminals.clear();
        std::fill(request.conductivity_spm_per_element.begin(), request.conductivity_spm_per_element.end(), 99.0);
        std::fill(request.stable_vertex_identities.local_to_stable.begin(), request.stable_vertex_identities.local_to_stable.end(), 0u);
        for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) mesh.GetVertex(vertex)[0] += 7.0;
        require(retained->content_digest() == frozen_digest &&
                independent_accepted_terminal_content_digest(*retained, frozen_policy) == frozen_digest,
            "accepted digest or owned preimage changed after caller mutation");
    }
    require(retained->content_digest() == frozen_digest &&
            independent_accepted_terminal_content_digest(*retained, frozen_policy) == frozen_digest,
        "accepted digest or owned preimage changed after caller destruction");
}

void accepted_external_lead_finalizer_preserves_owned_series_and_rejects_foreign_descriptors()
{
    using namespace fullmag::fem::antenna_field_solve;
    using fullmag::fem::transport::Rt0InterfaceFacePair;
    AcceptedExternalLeadCurrentSource::Ptr retained;
    std::string retained_digest, retained_bytes;
    const auto exercise = [&](double scale, double current, bool negative_cases) {
        auto left = shifted_unit_cube(0.0, 1);
        auto device = shifted_unit_cube(1.0, 2);
        auto right = shifted_unit_cube(2.0, 3);
        auto first_two = combine_disjoint_tetrahedral_meshes(left, device);
        auto mesh = combine_disjoint_tetrahedral_meshes(first_two, right);
        for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
            for (int axis = 0; axis < 3; ++axis) mesh.GetVertex(vertex)[axis] *= scale;
        }
        const auto ids = stable_vertex_ids(mesh);
        AcceptedTerminalChargeRequest charge;
        charge.mesh = &mesh;
        charge.stable_vertex_identities = ids;
        charge.conductivity_spm_per_element.assign(mesh.GetNE(), scale == 1.0 ? 4.0 : 1.0e7);
        charge.terminals = {fixture_terminal_on_x(mesh, ids, "outer-left", 0.0, -current),
            fixture_terminal_on_x(mesh, ids, "outer-right", 3.0 * scale, current)};
        AcceptedExternalLeadSourceRequest closure;
        closure.closure_revision = "three-cube-series.v1";
        const int device_begin = left.GetNV(), device_end = device_begin + device.GetNV();
        for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
            (vertex >= device_begin && vertex < device_end ? closure.device_vertex_ids : closure.lead_vertex_ids)
                .push_back(ids.local_to_stable[vertex]);
        }
        closure.branch_observations = {{"device-left", {}, -current}, {"device-right", {}, current}};
        for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
            mfem::Array<int> vertices;
            mesh.GetBdrElementVertices(boundary, vertices);
            const bool device_face = vertices[0] >= device_begin && vertices[0] < device_end;
            const double x = mesh.GetVertex(vertices[0])[0];
            const bool contact = device_face && (x == scale || x == 2.0 * scale) &&
                mesh.GetVertex(vertices[1])[0] == x && mesh.GetVertex(vertices[2])[0] == x;
            if (!contact) continue;
            Rt0InterfaceFacePair pair;
            const std::size_t branch = x == scale ? 0 : 1;
            pair.id = "device-lead:" + std::to_string(charge.interface_pairs.size());
            pair.first_face_vertex_ids = sorted_face_key(mesh, ids, boundary);
            for (int corner = 0; corner < 3; ++corner) {
                int match = -1;
                for (int other = 0; other < mesh.GetNV(); ++other) {
                    if (other >= device_begin && other < device_end) continue;
                    const double *a = mesh.GetVertex(vertices[corner]), *b = mesh.GetVertex(other);
                    if (a[0] == b[0] && a[1] == b[1] && a[2] == b[2]) match = other;
                }
                require(match >= 0, "three-cube interface lacks an explicitly paired lead vertex");
                pair.vertex_pairs[corner] = {ids.local_to_stable[vertices[corner]], ids.local_to_stable[match]};
                pair.second_face_vertex_ids[corner] = ids.local_to_stable[match];
            }
            std::sort(pair.second_face_vertex_ids.begin(), pair.second_face_vertex_ids.end());
            closure.branch_observations[branch].interface_pair_ids.push_back(pair.id);
            charge.interface_pairs.push_back(pair);
        }
        require(charge.interface_pairs.size() == 4 && closure.branch_observations[0].interface_pair_ids.size() == 2 &&
                closure.branch_observations[1].interface_pair_ids.size() == 2,
            "three-cube fixture did not author both full contacts");
        std::map<std::array<std::uint64_t, 3>, std::string> outer_faces, interface_faces;
        for (const auto &terminal : charge.terminals) {
            for (const auto &key : terminal.boundary_face_vertex_ids) outer_faces.emplace(key, terminal.id);
        }
        for (const auto &pair : charge.interface_pairs) {
            interface_faces.emplace(pair.first_face_vertex_ids, pair.id);
            interface_faces.emplace(pair.second_face_vertex_ids, pair.id);
        }
        for (int boundary = 0; boundary < mesh.GetNBE(); ++boundary) {
            const auto key = sorted_face_key(mesh, ids, boundary);
            const auto role = outer_faces.count(key) ? ExternalLeadSourceBoundaryRole::OuterElectrode :
                interface_faces.count(key) ? ExternalLeadSourceBoundaryRole::DeviceLeadInterface : ExternalLeadSourceBoundaryRole::Insulating;
            const auto circuit_id = outer_faces.count(key) ? outer_faces.at(key) :
                interface_faces.count(key) ? interface_faces.at(key) : std::string{};
            closure.boundary_faces.push_back({key, role, circuit_id});
        }
        closure.accepted_source = solve_accepted_terminal_charge_source(charge);
        closure.required_charge_content_digest = closure.accepted_source->content_digest();
        const auto &projection = closure.accepted_source->rt0_projection();
        const auto *owned_mesh = projection.field().FESpace()->GetMesh();
        const auto *owned_field = &projection.field();
        const auto *owned_potential = &closure.accepted_source->potential();
        std::vector<double> frozen_dofs(projection.field().GetData(), projection.field().GetData() + projection.field().Size());
        const auto rank = projection.constraint_rank_certificate();
        const double kkt = projection.scaled_kkt_residual(), correction = projection.correction_norm_mw();
        const auto accepted = AcceptedExternalLeadCurrentSource::Finalize(closure);
        const auto repeated = AcceptedExternalLeadCurrentSource::Finalize(closure);
        const auto &owned = accepted->charge_source();
        const double expected_drop = -3.0 * current / (charge.conductivity_spm_per_element.front() * scale);
        require(std::abs(owned.terminal_solution().terminal_voltages_v.back() - expected_drop) <=
                1.0e-12 + 1.0e-8 * std::abs(expected_drop),
            "three-cube fixture disagrees with its analytic R=3/(sigma*length) ohm");
        require(&owned == closure.accepted_source.get() && &owned.rt0_projection().field() == owned_field &&
                &owned.potential() == owned_potential && owned.potential().FESpace()->GetMesh() == owned_mesh &&
                owned.rt0_projection().field().FESpace()->GetMesh() == owned_mesh,
            "external lead finalizer replaced or copied the accepted H1/RT0 owner");
        require(std::equal(frozen_dofs.begin(), frozen_dofs.end(), owned.rt0_projection().field().GetData()) &&
                owned.rt0_projection().constraint_rank_certificate().rank == rank.rank &&
                owned.rt0_projection().constraint_rank_certificate().rows_before == rank.rows_before &&
                owned.rt0_projection().scaled_kkt_residual() == kkt && std::isfinite(kkt) &&
                owned.rt0_projection().correction_norm_mw() == correction && std::isfinite(correction),
            "external lead finalizer changed DOFs, rank or real projection diagnostics");
        require(!accepted->canonical_content_bytes().empty() && accepted->content_digest().size() == 64 &&
                repeated->content_digest() == accepted->content_digest() &&
                repeated->canonical_content_bytes() == accepted->canonical_content_bytes(),
            "repeated external lead finalization changed its canonical identity");
        const auto &record_bytes = accepted->canonical_content_bytes();
        require(sha256_hex(Bytes(record_bytes.begin(), record_bytes.end())) == accepted->content_digest(),
            "external lead digest does not bind its exact retained canonical bytes");
        require(accepted->branch_measurements().size() == 2 && accepted->component_measurements().size() == 1 &&
                accepted->physical_measurements().elements.size() == static_cast<std::size_t>(mesh.GetNE()),
            "external lead finalizer omitted local or branch/component measurements");
        require(std::string(AcceptedExternalLeadCurrentSource::operator_version) == "fem_accepted_external_lead_current_source.v2" &&
                std::string(AcceptedExternalLeadCurrentSource::digest_schema) == "accepted_external_lead_current_source.ordered.v2",
            "external lead physical face ledger did not advance its source identity to v2");
        std::map<std::array<std::uint64_t, 4>, double> element_flux_scales;
        for (const auto &element : accepted->physical_measurements().elements) {
            element_flux_scales.emplace(element.vertex_ids, element.absolute_flux_sum_a);
        }
        std::map<std::array<std::uint64_t, 3>, int> actual_faces;
        for (int face = 0; face < owned_mesh->GetNumFaces(); ++face) {
            mfem::Array<int> vertices;
            owned_mesh->GetFaceVertices(face, vertices);
            std::array<std::uint64_t, 3> key{};
            for (int corner = 0; corner < 3; ++corner) key[corner] = ids.local_to_stable[vertices[corner]];
            std::sort(key.begin(), key.end()); actual_faces.emplace(key, face);
        }
        require(accepted->physical_measurements().faces.size() == actual_faces.size(),
            "source v2 omitted an actual face from its signed RT0 binding ledger");
        for (const auto &row : accepted->physical_measurements().faces) {
            const int face = actual_faces.at(row.vertex_ids);
            mfem::Array<int> dofs;
            owned_field->FESpace()->GetFaceDofs(face, dofs);
            require(dofs.Size() == 1, "source v2 face has no unique actual RT0 moment");
            const int dof = dofs[0] < 0 ? -1 - dofs[0] : dofs[0];
            require(dof >= 0 && dof < owned_field->Size(), "source v2 face references a foreign RT0 DOF");
            const double weight = row.rt0_dof_to_canonical_flux_weight;
            const long double expected_flux = static_cast<long double>(weight) * (*owned_field)[dof];
            int first = -1, second = -1;
            owned_mesh->GetFaceElements(face, &first, &second);
            long double adjacent_scale = 0.0L;
            for (int element : {first, second}) {
                if (element < 0) continue;
                mfem::Array<int> vertices; owned_mesh->GetElementVertices(element, vertices);
                std::array<std::uint64_t, 4> key{};
                for (int corner = 0; corner < 4; ++corner) key[corner] = ids.local_to_stable[vertices[corner]];
                std::sort(key.begin(), key.end()); adjacent_scale += element_flux_scales.at(key);
            }
            const long double gate = 1.0e-18L + 1.0e-10L * adjacent_scale;
            require(std::isfinite(weight) && weight != 0.0 && std::isfinite(expected_flux) &&
                    std::isfinite(adjacent_scale) && std::isfinite(gate) &&
                    std::abs(static_cast<long double>(row.canonical_flux_a) - expected_flux) <= gate,
                "source v2 canonical flux is not the signed basis-weight times retained raw RT0 DOF within its adjacent-element SI gate");
        }
        require(&owned.rt0_projection().field() == owned_field &&
                std::equal(frozen_dofs.begin(), frozen_dofs.end(), owned_field->GetData()),
            "source v2 physical face measurement modified its retained RT0 field");
        for (std::size_t branch = 0; branch < 2; ++branch) {
            const double expected = branch == 0 ? -current : current;
            const auto &measured = accepted->branch_measurements()[branch];
            const double tolerance = 1.0e-18 + 1.0e-8 * std::abs(expected);
            require(measured.id == closure.branch_observations[branch].id && measured.requested_outward_current_a == expected &&
                    std::abs(measured.h1_outward_current_a - expected) <= tolerance &&
                    std::abs(measured.rt0_outward_current_a - expected) <= tolerance,
                "external lead branch lost its signed device-outward current");
        }
        const auto &component = accepted->component_measurements().front();
        require(std::abs(component.requested_outward_current_sum_a) <= 1.0e-18 &&
                std::abs(component.h1_outward_current_sum_a) <= 1.0e-18 + 1.0e-8 * std::abs(current) &&
                std::abs(component.rt0_outward_current_sum_a) <= 1.0e-18 + 1.0e-8 * std::abs(current),
            "external lead component lacks its independent signed balance");
        const std::vector<std::array<double, 3>> targets{{4.0 * scale, 2.0 * scale, 2.0 * scale}};
        const auto field = evaluate_accepted_external_lead_field(*accepted, targets);
        require(field.field_scope == "external_electrode_truncation" &&
                field.accepted_external_source_digest == accepted->content_digest() &&
                field.quadrature.source_view_identity_digest.empty() &&
                field.quadrature.h_xyz_apm.size() == 3 &&
                field.quadrature.diagnostics.unconverged_pair_count == 0 &&
                std::all_of(field.quadrature.h_xyz_apm.begin(), field.quadrature.h_xyz_apm.end(),
                    [](double value) { return std::isfinite(value); }),
            "external lead field lost truncation scope, owned identity or finite converged quadrature");
        require(field.charge_content_digest == owned.content_digest() &&
                field.operator_version == "fem_accepted_external_lead_field.v1" &&
                field.evaluation_content_digest.size() == 64 && !field.canonical_evaluation_bytes.empty() &&
                sha256_hex(Bytes(field.canonical_evaluation_bytes.begin(), field.canonical_evaluation_bytes.end())) ==
                    field.evaluation_content_digest,
            "external lead evaluation digest does not bind its exact owned field record");
        if (current == 0.0) {
            require(std::all_of(field.quadrature.h_xyz_apm.begin(), field.quadrature.h_xyz_apm.end(),
                    [](double value) { return value == 0.0; }),
                "zero-drive external lead field is nonzero");
        }
        if (negative_cases) {
            auto unresolved_closure = closure;
            unresolved_closure.accepted_source.reset();
            unresolved_closure.required_charge_content_digest.clear();
            const auto bundle = solve_accepted_external_lead_bundle(charge, unresolved_closure, targets);
            const auto repeated_bundle = solve_accepted_external_lead_bundle(charge, unresolved_closure, targets);
            require(!bundle.canonical_content_bytes.empty() && bundle.content_digest.size() == 64 &&
                    sha256_hex(Bytes(bundle.canonical_content_bytes.begin(), bundle.canonical_content_bytes.end())) == bundle.content_digest &&
                    repeated_bundle.content_digest == bundle.content_digest &&
                    repeated_bundle.canonical_content_bytes == bundle.canonical_content_bytes,
                "one-call external lead bundle lost exact SHA, bytes or deterministic identity");
            require_rejected([&] { (void)solve_accepted_external_lead_bundle(charge, closure, targets); },
                "one-call bundle accepted a caller-owned charge result and precomputed content pin");
            auto caller_pin = unresolved_closure;
            caller_pin.required_charge_content_digest = closure.required_charge_content_digest;
            require_rejected([&] { (void)solve_accepted_external_lead_bundle(charge, caller_pin, targets); },
                "one-call bundle accepted a caller-supplied future charge content pin");
            auto shifted_targets = targets;
            shifted_targets.front()[0] += scale;
            const auto shifted_field = evaluate_accepted_external_lead_field(*accepted, shifted_targets);
            fullmag::fem::oersted::DirectTetraQuadratureOptions changed_policy;
            changed_policy.base_quadrature_order = 6;
            const auto policy_field = evaluate_accepted_external_lead_field(*accepted, targets, changed_policy);
            require(shifted_field.evaluation_content_digest != field.evaluation_content_digest &&
                    policy_field.evaluation_content_digest != field.evaluation_content_digest &&
                    shifted_field.charge_content_digest == field.charge_content_digest &&
                    policy_field.charge_content_digest == field.charge_content_digest &&
                    sha256_hex(Bytes(shifted_field.canonical_evaluation_bytes.begin(), shifted_field.canonical_evaluation_bytes.end())) ==
                        shifted_field.evaluation_content_digest &&
                    sha256_hex(Bytes(policy_field.canonical_evaluation_bytes.begin(), policy_field.canonical_evaluation_bytes.end())) ==
                        policy_field.evaluation_content_digest &&
                    &accepted->charge_source().rt0_projection().field() == owned_field &&
                    &accepted->charge_source().potential() == owned_potential &&
                    accepted->charge_source().content_digest() == closure.required_charge_content_digest &&
                    std::equal(frozen_dofs.begin(), frozen_dofs.end(), owned_field->GetData()),
                "field targets/options did not change evaluation identity or modified accepted charge DOFs");
            const auto reject_field_policy = [&](const fullmag::fem::oersted::DirectTetraQuadratureOptions &options) {
                bool rejected = false;
                try {
                    (void)evaluate_accepted_external_lead_field(*accepted, targets, options);
                } catch (const std::invalid_argument &error) {
                    rejected = std::string(error.what()).find("bounded private contract") != std::string::npos;
                }
                require(rejected, "pathological field policy did not fail its specific pre-kernel bound");
            };
            for (int order : {17, std::numeric_limits<int>::max()}) {
                auto options = changed_policy; options.base_quadrature_order = order; reject_field_policy(options);
            }
            for (int depth : {7, std::numeric_limits<int>::max()}) {
                auto options = changed_policy; options.maximum_subdivision_depth = depth; reject_field_policy(options);
            }
            auto oversized_budget = changed_policy;
            oversized_budget.maximum_source_target_pairs = 1'000'001;
            reject_field_policy(oversized_budget);
            const std::vector<std::array<double, 3>> oversized_targets(600'000, targets.front());
            bool preimage_rejected = false;
            try {
                (void)evaluate_accepted_external_lead_field(*accepted, oversized_targets);
            } catch (const std::invalid_argument &error) {
                preimage_rejected = std::string(error.what()).find("preflight 128 MiB") != std::string::npos;
            }
            require(preimage_rejected,
                "oversized field record did not fail its typed-preimage preflight before quadrature");
            const auto reject = [&](const AcceptedExternalLeadSourceRequest &bad, const char *message) {
                require_rejected([&] { (void)AcceptedExternalLeadCurrentSource::Finalize(bad); }, message);
            };
            auto bad = closure;
            bad.required_charge_content_digest.assign(64, '0'); reject(bad, "external finalizer accepted stale charge SHA");
            bad = closure; bad.device_vertex_ids.pop_back(); reject(bad, "external finalizer accepted missing partition ID");
            bad = closure; bad.device_vertex_ids.push_back(std::numeric_limits<std::uint64_t>::max()); reject(bad, "external finalizer accepted foreign ID");
            bad = closure; bad.lead_vertex_ids.push_back(bad.device_vertex_ids.back()); bad.device_vertex_ids.pop_back();
            reject(bad, "external finalizer accepted an element split between device and lead");
            bad = closure; bad.boundary_faces.pop_back(); reject(bad, "external finalizer accepted incomplete boundary roles");
            bad = closure;
            for (auto &face : bad.boundary_faces) if (face.role == ExternalLeadSourceBoundaryRole::OuterElectrode) { face.role = ExternalLeadSourceBoundaryRole::Insulating; break; }
            reject(bad, "external finalizer accepted wrongly classified outer terminal");
            bad = closure; bad.boundary_faces.front().circuit_id = "foreign-circuit";
            reject(bad, "external finalizer accepted a foreign boundary circuit identity");
            bad = closure; std::swap(bad.device_vertex_ids, bad.lead_vertex_ids); reject(bad, "external finalizer accepted swapped device/lead partition");
            bad = closure; bad.branch_observations[1].interface_pair_ids.push_back(bad.branch_observations[0].interface_pair_ids.front());
            reject(bad, "external finalizer accepted reused branch interface");
            bad = closure; bad.branch_observations.pop_back();
            reject(bad, "external finalizer accepted an unobserved interface branch");
            bad = closure; bad.branch_observations[0].requested_device_outward_current_a += 0.1;
            reject(bad, "external finalizer accepted a foreign observed branch current");
            auto nonfinite_targets = targets;
            nonfinite_targets.front()[0] = std::numeric_limits<double>::quiet_NaN();
            require_rejected([&] { (void)evaluate_accepted_external_lead_field(*accepted, nonfinite_targets); },
                "external lead field accepted nonfinite target coordinates");
            fullmag::fem::oersted::DirectTetraQuadratureOptions insufficient_budget;
            insufficient_budget.maximum_source_target_pairs = 1;
            require_rejected([&] { (void)evaluate_accepted_external_lead_field(*accepted, targets, insufficient_budget); },
                "external lead field exceeded its bounded quadrature budget");
            retained = accepted; retained_digest = accepted->content_digest(); retained_bytes = accepted->canonical_content_bytes();
            closure.accepted_source.reset(); closure.boundary_faces.clear(); closure.branch_observations.clear();
            for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) mesh.GetVertex(vertex)[0] += 9.0;
            require(retained->content_digest() == retained_digest && retained->canonical_content_bytes() == retained_bytes &&
                    retained->charge_source().potential().FESpace()->GetMesh() == owned_mesh,
                "external finalizer retained borrowed request state");
        }
    };
    exercise(1.0, 1.0, true);
    exercise(1.0, -1.0, false);
    exercise(1.0, 0.0, false);
    exercise(1.0e-9, 1.0e-9, false);
    require(retained && retained->content_digest() == retained_digest && retained->canonical_content_bytes() == retained_bytes &&
            retained->charge_source().rt0_projection().field().Size() > 0,
        "external finalizer lost its owner after original mesh and requests were destroyed");
}

void accepted_terminal_charge_source_preserves_nanometre_scale_and_rejects_degeneracy()
{
    using fullmag::fem::antenna_field_solve::AcceptedTerminalChargeRequest;
    using fullmag::fem::antenna_field_solve::solve_accepted_terminal_charge_source;
    constexpr double length_m = 1.0e-9;
    constexpr double conductivity_spm = 1.0e7;
    constexpr double current_a = 1.0e-9;
    auto mesh = shifted_unit_cube(0.0, 1);
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        for (int component = 0; component < 3; ++component) mesh.GetVertex(vertex)[component] *= length_m;
    }
    const auto ids = stable_vertex_ids(mesh);
    AcceptedTerminalChargeRequest request;
    request.mesh = &mesh;
    request.stable_vertex_identities = ids;
    request.conductivity_spm_per_element.assign(static_cast<std::size_t>(mesh.GetNE()), conductivity_spm);
    request.terminals = {fixture_terminal_on_x(mesh, ids, "left", 0.0, -current_a),
        fixture_terminal_on_x(mesh, ids, "right", length_m, current_a)};
    const auto source = solve_accepted_terminal_charge_source(request);
    const auto &potential = source->potential();
    const auto &rt0 = source->rt0_projection().field();
    auto *owned_mesh = potential.FESpace()->GetMesh();
    require(owned_mesh == rt0.FESpace()->GetMesh(), "nanometre accepted P1 and RT0 do not share one owned mesh");
    require(source->terminal_solution().reference_terminal_ids == std::vector<std::string>{"left"},
        "nanometre fixture did not retain the left reference");
    for (int vertex = 0; vertex < owned_mesh->GetNV(); ++vertex) {
        mfem::Array<int> dofs;
        potential.FESpace()->GetVertexDofs(vertex, dofs);
        require(dofs.Size() == 1 && dofs[0] >= 0, "nanometre retained P1 vertex lacks a scalar DOF");
        require(std::abs(potential[dofs[0]] + 100.0 * owned_mesh->GetVertex(vertex)[0]) < 1.0e-17,
            "nanometre conductor voltage differs from V=-100*x, right=-1e-7 V");
    }
    for (int element = 0; element < owned_mesh->GetNE(); ++element) {
        auto *transformation = owned_mesh->GetElementTransformation(element);
        const auto &rule = mfem::IntRules.Get(mfem::Geometry::TETRAHEDRON, 4);
        for (int point = 0; point < rule.GetNPoints(); ++point) {
            transformation->SetIntPoint(&rule.IntPoint(point));
            mfem::Vector gradient(3), value(3);
            potential.GetGradient(*transformation, gradient);
            rt0.GetVectorValue(*transformation, rule.IntPoint(point), value);
            require(std::abs(gradient[0] + 100.0) < 1.0e-8 &&
                    std::abs(gradient[1]) < 1.0e-8 && std::abs(gradient[2]) < 1.0e-8,
                "nanometre retained P1 gradient differs from (-100,0,0) V/m");
            require(std::abs(value[0] - 1.0e9) <= 1.0e-8 * 1.0e9 &&
                    std::abs(value[1]) <= 1.0e-8 * 1.0e9 && std::abs(value[2]) <= 1.0e-8 * 1.0e9 &&
                    std::abs(-conductivity_spm * gradient[0] - value[0]) <= 1.0e-8 * 1.0e9,
                "nanometre accepted current differs from J=(1e9,0,0) A/m2 or its frozen constitutive relation");
        }
    }
    for (std::size_t terminal = 0; terminal < request.terminals.size(); ++terminal) {
        const double expected = request.terminals[terminal].requested_outward_current_a;
        require(std::abs(source->terminal_solution().measured_outward_currents_a[terminal] - expected) <=
                    1.0e-18 + 1.0e-8 * std::abs(expected) &&
                std::abs(source->rt0_projection().measured_outward_currents_a()[terminal] - expected) <=
                    1.0e-18 + 1.0e-8 * std::abs(expected),
            "nanometre accepted terminal currents failed the unchanged signed certificate");
    }
    auto degenerate = mesh;
    for (int vertex = 0; vertex < degenerate.GetNV(); ++vertex) degenerate.GetVertex(vertex)[2] = 0.0;
    auto invalid = request;
    invalid.mesh = &degenerate;
    require_rejected([&] { (void)solve_accepted_terminal_charge_source(invalid); },
        "nanometre geometry guard accepted a geometrically collapsed conductor");
}

void coupled_volumetric_external_lead_extension_is_accepted()
{
    ChargeFixture conductor(shifted_unit_cube(0.0, 1));
    const auto left_lead = shifted_unit_cube(-1.0, 1);
    const auto right_lead = shifted_unit_cube(1.0, 2);
    ChargeFixture leads(combine_disjoint_tetrahedral_meshes(
        left_lead, right_lead));
    const auto conductor_ids = coordinate_stable_vertex_ids(conductor.mesh);
    auto lead_ids = coordinate_stable_vertex_ids(leads.mesh);
    constexpr uint64_t kLeadStableIdNamespace = uint64_t{1} << 63;
    for (auto &id : lead_ids.local_to_stable) {
        require(id < kLeadStableIdNamespace,
            "lead stable ID cannot be placed in the disjoint lead namespace");
        id += kLeadStableIdNamespace;
    }
    mfem::Vector lead_sigma_values(2);
    lead_sigma_values = 1.0;
    mfem::PWConstCoefficient lead_conductivity(lead_sigma_values);

    ExternalLeadExtensionCurrentClosure closure;
    closure.operator_version = "fem_closed_current_extension.v1";
    closure.revision = "lead-r1";
    closure.digest = "lead-digest-r1";
    closure.drive_id = "coupled-lead-drop";
    closure.outer_electrode_potential_drop_v = -1.0;
    closure.lead_mesh = &leads.mesh;
    closure.lead_conductivity = &lead_conductivity;
    closure.lead_conductivity_digest = "lead-conductivity-1";
    closure.lead_vertex_identities = lead_ids;

    const auto device_left = boundary_elements_on_x(conductor.mesh, 0.0);
    const auto device_right = boundary_elements_on_x(conductor.mesh, 1.0);
    const auto lead_left_join = boundary_elements_on_x(leads.mesh, 0.0);
    const auto lead_right_join = boundary_elements_on_x(leads.mesh, 1.0);
    const auto outer_minus = boundary_elements_on_x(leads.mesh, -1.0);
    const auto outer_plus = boundary_elements_on_x(leads.mesh, 2.0);
    require(device_left.size() == lead_left_join.size() &&
            device_right.size() == lead_right_join.size(),
        "continuous external-lead join triangulations do not match");
    const auto boundary_centroid = [](const mfem::Mesh &mesh, int boundary) {
        mfem::Array<int> vertices;
        mesh.GetBdrElementVertices(boundary, vertices);
        require(vertices.Size() == 3,
            "external-lead fixture boundary must be triangular");
        mfem::Vector centroid(3);
        centroid = 0.0;
        for (int i = 0; i < vertices.Size(); ++i) {
            centroid += coordinate_copy(mesh, vertices[i]);
        }
        centroid /= static_cast<double>(vertices.Size());
        return centroid;
    };
    const auto append_pairs = [&](const std::vector<int> &device_faces,
                                  const std::vector<int> &lead_faces) {
        std::vector<bool> lead_face_used(lead_faces.size(), false);
        for (const int device_face : device_faces) {
            const auto device_centroid = boundary_centroid(
                conductor.mesh, device_face);
            std::size_t matched_lead = lead_faces.size();
            for (std::size_t i = 0; i < lead_faces.size(); ++i) {
                if (lead_face_used[i]) continue;
                auto separation = device_centroid;
                separation -= boundary_centroid(leads.mesh, lead_faces[i]);
                if (separation.Norml2() <= 1.0e-13) {
                    matched_lead = i;
                    break;
                }
            }
            require(matched_lead != lead_faces.size(),
                "external-lead fixture left a device face unmatched");
            lead_face_used[matched_lead] = true;
            ExternalLeadInterfacePair pair;
            pair.transport_face_vertex_ids = sorted_face_key(
                conductor.mesh, conductor_ids, device_face);
            pair.lead_face_vertex_ids = sorted_face_key(
                leads.mesh, lead_ids, lead_faces[matched_lead]);
            closure.interface_pairs.push_back(pair);
        }
        require(std::all_of(lead_face_used.begin(), lead_face_used.end(),
                    [](bool used) { return used; }),
            "external-lead fixture left a lead face unmatched");
    };
    append_pairs(device_left, lead_left_join);
    append_pairs(device_right, lead_right_join);
    for (const int boundary : outer_minus) {
        closure.minus_outer_electrode_faces.push_back(
            sorted_face_key(leads.mesh, lead_ids, boundary));
    }
    for (const int boundary : outer_plus) {
        closure.plus_outer_electrode_faces.push_back(
            sorted_face_key(leads.mesh, lead_ids, boundary));
    }

    auto request = periodic_request(conductor, conductor_ids, identity_input());
    request.closure = closure;
    request.periodic_charge_potential.reset();
    request.external_lead_coupled_solve = true;
    for (auto &face : request.boundary_faces) {
        if (std::find(device_left.begin(), device_left.end(),
                face.boundary_element) != device_left.end() ||
            std::find(device_right.begin(), device_right.end(),
                face.boundary_element) != device_right.end()) {
            face.role = ConservativeCurrentBoundaryRole::ClosureInterface;
            face.circuit_id = "external-lead-interface";
        }
    }
    const auto view = ConservativeCurrentView::Build(request);
    require(view->balance().closure_complete &&
            view->balance().max_closure_interface_mismatch_a <= 1.0e-12,
        "coupled volumetric lead solve did not certify equal/opposite join flux");
    require(view->space().GetMesh()->GetNE() ==
            conductor.mesh.GetNE() + leads.mesh.GetNE(),
        "external lead was not included in the same volumetric coupled solve");
    require(view->identity().closure_revision == "lead-r1" &&
            view->identity().closure_digest == "lead-digest-r1",
        "coupled external-lead identity was not retained");
    std::vector<ExpectedCircuitPair> expected_pairs;
    for (const auto &pair : closure.interface_pairs) {
        expected_pairs.push_back(ExpectedCircuitPair{3,
            "external-lead-interface", pair.transport_face_vertex_ids,
            pair.lead_face_vertex_ids});
    }
    std::vector<std::array<uint64_t, 3>> expected_terminals =
        closure.minus_outer_electrode_faces;
    expected_terminals.insert(expected_terminals.end(),
        closure.plus_outer_electrode_faces.begin(),
        closure.plus_outer_electrode_faces.end());
    StableMeshVertexIdentities combined_ids;
    combined_ids.version = conductor_ids.version;
    combined_ids.local_to_stable = conductor_ids.local_to_stable;
    combined_ids.local_to_stable.insert(combined_ids.local_to_stable.end(),
        lead_ids.local_to_stable.begin(), lead_ids.local_to_stable.end());
    require(static_cast<int>(combined_ids.local_to_stable.size()) ==
            view->space().GetMesh()->GetNV(),
        "combined view did not preserve device-then-lead stable-ID ownership");
    const auto check_charge_potential = [&](
        const ConservativeCurrentView::Ptr &candidate, double current_a,
        double lead_sigma) {
        const auto *potential = candidate->charge_potential_vertex_values_v();
        require(potential != nullptr && potential->size() ==
                combined_ids.local_to_stable.size() &&
                candidate->stable_vertex_identities().version ==
                    combined_ids.version &&
                candidate->stable_vertex_identities().local_to_stable ==
                    combined_ids.local_to_stable,
            "coupled charge snapshot omitted device/lead values or stable IDs");
        const auto *mesh = candidate->space().GetMesh();
        for (int vertex = 0; vertex < mesh->GetNV(); ++vertex) {
            const double x = mesh->GetVertex(vertex)[0];
            const double expected = x <= 0.0
                ? -current_a * (x + 1.0) / lead_sigma
                : x <= 1.0
                    ? -current_a / lead_sigma - current_a * x / 4.0
                    : -current_a / lead_sigma - current_a / 4.0 -
                        current_a * (x - 1.0) / lead_sigma;
            require(std::abs(potential->at(vertex) - expected) <= 1.0e-11,
                "coupled charge potential differs from analytic series resistance");
        }
    };
    independently_decode_and_match_balance_artifact(view, combined_ids,
        expected_boundary_map(conductor.mesh, conductor_ids,
            request.boundary_faces), expected_pairs, expected_terminals,
        closure.drive_id);
    const double expected_current_a = 1.0 / (1.0 / 1.0 + 1.0 / 4.0 + 1.0 / 1.0);
    check_charge_potential(view, expected_current_a, 1.0);
    const auto original_potential = *view->charge_potential_vertex_values_v();
    require(std::abs(volume_average(view->field())[0] - expected_current_a) <=
            1.0e-11,
        "coupled lead/device current disagrees with analytic series resistance");

    mfem::Vector feedback_sigma_values(2);
    feedback_sigma_values = 2.0;
    mfem::PWConstCoefficient feedback_conductivity(feedback_sigma_values);
    auto &feedback_closure = std::get<ExternalLeadExtensionCurrentClosure>(
        request.closure);
    feedback_closure.revision = "lead-r2";
    feedback_closure.digest = "lead-digest-r2";
    feedback_closure.lead_conductivity_digest = "lead-conductivity-2";
    feedback_closure.lead_conductivity = &feedback_conductivity;
    request.identity.source_field_digest = "source-field-r2";
    request.pins = pins_for(request.identity);
    const auto feedback = ConservativeCurrentView::Build(request);
    const double expected_feedback_a =
        1.0 / (1.0 / 2.0 + 1.0 / 4.0 + 1.0 / 2.0);
    check_charge_potential(feedback, expected_feedback_a, 2.0);
    check_charge_potential(view, expected_current_a, 1.0);
    require(*view->charge_potential_vertex_values_v() == original_potential &&
            *feedback->charge_potential_vertex_values_v() != original_potential,
        "a later coupled solve mutated or reused the prior charge snapshot");
    require(std::abs(volume_average(feedback->field())[0] -
                expected_feedback_a) <= 1.0e-11 &&
            std::abs(expected_feedback_a - expected_current_a) > 0.1,
        "lead conductivity did not feed back into the device current");
}

StableMeshVertexIdentities coordinate_stable_vertex_ids(const mfem::Mesh &mesh)
{
    StableMeshVertexIdentities ids;
    ids.version = "stable_mesh_vertex_u64.v1";
    ids.local_to_stable.resize(mesh.GetNV());
    for (int vertex = 0; vertex < mesh.GetNV(); ++vertex) {
        const auto *x = mesh.GetVertex(vertex);
        const uint64_t ix = static_cast<uint64_t>(
            std::llround((x[0] + 2.0) * 1000.0));
        const uint64_t iy = static_cast<uint64_t>(
            std::llround((x[1] + 2.0) * 1000.0));
        const uint64_t iz = static_cast<uint64_t>(
            std::llround((x[2] + 2.0) * 1000.0));
        ids.local_to_stable[vertex] = 1u + ix + 2001u * iy + 4004001u * iz;
    }
    return ids;
}

mfem::Mesh clone_with_permuted_local_numbering(const mfem::Mesh &input)
{
    const int nv = input.GetNV();
    std::vector<int> new_to_old(nv);
    std::iota(new_to_old.begin(), new_to_old.end(), 0);
    std::reverse(new_to_old.begin(), new_to_old.end());
    std::vector<int> old_to_new(nv);
    for (int next = 0; next < nv; ++next) {
        old_to_new.at(new_to_old.at(next)) = next;
    }
    mfem::Mesh output(3, nv, input.GetNE(), input.GetNBE(), 3);
    for (const int old_vertex : new_to_old) {
        output.AddVertex(input.GetVertex(old_vertex));
    }
    for (int reverse = input.GetNE() - 1; reverse >= 0; --reverse) {
        mfem::Array<int> vertices;
        input.GetElementVertices(reverse, vertices);
        require(vertices.Size() == 4, "permutation fixture requires tetrahedra");
        // Even local rotation changes every local face/RT-DOF enumeration
        // without reflecting the physical tetrahedron.
        int tet[4]{old_to_new.at(vertices[1]), old_to_new.at(vertices[2]),
            old_to_new.at(vertices[0]), old_to_new.at(vertices[3])};
        output.AddTet(tet, input.GetElement(reverse)->GetAttribute());
    }
    for (int reverse = input.GetNBE() - 1; reverse >= 0; --reverse) {
        mfem::Array<int> vertices;
        input.GetBdrElementVertices(reverse, vertices);
        require(vertices.Size() == 3,
            "permutation fixture requires triangular boundary faces");
        int triangle[3]{old_to_new.at(vertices[1]), old_to_new.at(vertices[2]),
            old_to_new.at(vertices[0])};
        output.AddBdrTriangle(triangle,
            input.GetBdrElement(reverse)->GetAttribute());
    }
    output.FinalizeTetMesh(1, 1, true);
    return output;
}

ConservativeCurrentView::Ptr import_uniform_rt0(
    ChargeFixture &fixture,
    const StableMeshVertexIdentities &ids)
{
    mfem::RT_FECollection rt_collection(0, 3);
    mfem::FiniteElementSpace rt_space(&fixture.mesh, &rt_collection);
    mfem::GridFunction field(&rt_space);
    mfem::Vector current(3);
    current = 0.0;
    current[0] = 4.0;
    mfem::VectorConstantCoefficient coefficient(current);
    field.ProjectCoefficient(coefficient);
    ConservativeCurrentImportRequest request;
    request.mesh = &fixture.mesh;
    request.rt0_field = &field;
    request.stable_vertex_identities = ids;
    request.boundary_faces = periodic_boundary_roles(fixture.mesh);
    request.closure = periodic_source_cut(fixture.mesh, ids);
    request.identity = identity_input();
    request.pins = pins_for(request.identity);
    request.require_independent_physical_certificate = true;
    return ConservativeCurrentView::Import(request);
}

void canonical_records_ignore_real_mesh_face_and_rt_dof_permutations()
{
    auto baseline_fixture = periodic_cube_fixture();
    const auto baseline_ids = coordinate_stable_vertex_ids(baseline_fixture.mesh);
    const auto baseline = import_uniform_rt0(baseline_fixture, baseline_ids);

    auto permuted_mesh = clone_with_permuted_local_numbering(
        baseline_fixture.mesh);
    ChargeFixture reordered_fixture(std::move(permuted_mesh));
    const auto reordered_ids = coordinate_stable_vertex_ids(
        reordered_fixture.mesh);
    const auto reordered = import_uniform_rt0(reordered_fixture, reordered_ids);

    require(same_records(records(baseline), records(reordered)),
        "canonical records depend on real vertex/element/local-face/RT-DOF numbering");
    require(baseline->identity().canonical_face_digest ==
            reordered->identity().canonical_face_digest,
        "canonical face digest depends on MFEM numbering");
}

void write_global_view_bytes(
    const ConservativeCurrentView::Ptr &view,
    const std::string &path)
{
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    require(output.good(), "cannot create canonical partition fixture artifact");
    const auto write_u64_little_endian = [&](uint64_t value) {
        std::array<unsigned char, 8> bytes{};
        for (std::size_t byte = 0; byte < bytes.size(); ++byte) {
            bytes[byte] = static_cast<unsigned char>(
                (value >> (8u * byte)) & 0xffu);
        }
        output.write(reinterpret_cast<const char *>(bytes.data()), bytes.size());
    };
    for (const auto &record : records(view)) {
        for (const auto id : record.face_vertex_ids) {
            write_u64_little_endian(id);
        }
        const double canonical_flux = record.flux_a == 0.0 ? 0.0 : record.flux_a;
        uint64_t flux_bits = 0;
        static_assert(sizeof(flux_bits) == sizeof(canonical_flux),
            "canonical f64 encoding requires 64-bit IEEE storage");
        std::memcpy(&flux_bits, &canonical_flux, sizeof(flux_bits));
        write_u64_little_endian(flux_bits);
    }
    const auto certificate = view->canonical_balance_certificate_bytes();
    output.write(reinterpret_cast<const char *>(certificate.data()),
        static_cast<std::streamsize>(certificate.size()));
    require(output.good(), "cannot finish canonical partition fixture artifact");
}

#if defined(MFEM_USE_MPI) && !defined(FULLMAG_OET0_DISABLE_MPI)
void emit_mpi_qualified_records(const std::string &path)
{
    int rank = -1;
    int size = 0;
    MPI_Comm_rank(MPI_COMM_WORLD, &rank);
    MPI_Comm_size(MPI_COMM_WORLD, &size);
    require(size == 1 || size == 2,
        "MPI qualification is frozen to exactly one or two ranks");

    auto serial = mfem::Mesh::MakeCartesian3D(
        2, 1, 1, mfem::Element::TETRAHEDRON, 1.0, 1.0, 1.0);
    const auto global_ids = coordinate_stable_vertex_ids(serial);
    const auto global_closure = periodic_source_cut(serial, global_ids);
    std::vector<int> partition(static_cast<std::size_t>(serial.GetNE()));
    for (int element = 0; element < serial.GetNE(); ++element) {
        partition.at(static_cast<std::size_t>(element)) =
            element < serial.GetNE() / size ? 0 : 1;
    }
    mfem::ParMesh parallel(MPI_COMM_WORLD, serial, partition.data());
    const auto local_ids = coordinate_stable_vertex_ids(parallel);
    mfem::ConstantCoefficient conductivity(4.0);
    const auto identity = identity_input();
    const auto boundary_faces = periodic_boundary_roles(parallel);
    PeriodicChargePotentialSolveRequest periodic_solve;
    periodic_solve.mesh = &parallel;
    periodic_solve.conductivity = &conductivity;
    periodic_solve.stable_vertex_identities = local_ids;
    periodic_solve.boundary_faces = boundary_faces;
    periodic_solve.source_cut = global_closure.source_cuts.front();
    periodic_solve.operator_version = "fem_charge_h1_periodic_jump.v1";
    periodic_solve.mesh_revision = identity.mesh_revision;
    periodic_solve.geometry_digest = identity.geometry_digest;
    periodic_solve.conductivity_digest = "conductivity-r1";
    periodic_solve.source_cut_digest = global_closure.digest;
    periodic_solve.source_module_id = identity.source_module_id;
    periodic_solve.source_state_revision = identity.source_state_revision;
    periodic_solve.source_field_digest = identity.source_field_digest;
    periodic_solve.evaluation_time_s = identity.evaluation_time_s;
    periodic_solve.stage_identity = identity.stage_identity;
    periodic_solve.envelope_revision = identity.envelope_revision;
    periodic_solve.envelope_digest = identity.envelope_digest;
    periodic_solve.evaluated_envelope_multiplier =
        identity.evaluated_envelope_multiplier;
    periodic_solve.algebraic_relative_tolerance = 1.0e-12;
    periodic_solve.maximum_iterations = 1000;
    periodic_solve.reference_mpi_gather_rank0_broadcast = true;
    const auto potential = PeriodicChargePotentialSolver::Solve(periodic_solve);

    ConservativeCurrentBuildRequest request;
    request.mesh = &parallel;
    request.conductivity = &conductivity;
    request.stable_vertex_identities = local_ids;
    request.boundary_faces = boundary_faces;
    request.closure = global_closure;
    request.periodic_charge_potential = potential;
    request.identity = identity;
    request.pins = pins_for(request.identity);
    request.algebraic_relative_tolerance = 1.0e-12;
    request.physical_relative_gate = 1.0e-10;
    request.physical_absolute_gate_a = 1.0e-18;
    request.reference_mpi_gather_broadcast = true;
    const auto view = ConservativeCurrentView::Build(request);
    require(view->canonical_face_flux_records_are_global_and_broadcast(),
        "MPI view exposed partition-local rather than global broadcast records");

    const auto local_digest = view->identity().canonical_face_digest;
    require(local_digest.size() == 64,
        "MPI canonical digest is not 64 lowercase hexadecimal bytes");
    std::array<char, 64> root_digest{};
    if (rank == 0) {
        std::copy(local_digest.begin(), local_digest.end(), root_digest.begin());
    }
    MPI_Bcast(root_digest.data(), root_digest.size(), MPI_CHAR, 0,
        MPI_COMM_WORLD);
    require(local_digest == std::string(root_digest.data(), root_digest.size()),
        "canonical digest was not byte-identical on every MPI rank");
    if (rank == 0) {
        write_global_view_bytes(view, path);
    }
    MPI_Barrier(MPI_COMM_WORLD);
}
#endif

} // namespace

int main(int argc, char **argv)
{
    try {
#if defined(MFEM_USE_MPI) && !defined(FULLMAG_OET0_DISABLE_MPI)
        if (argc == 3 && std::string(argv[1]) == "--emit-mpi-records") {
            MPI_Init(&argc, &argv);
            try {
                emit_mpi_qualified_records(argv[2]);
                MPI_Finalize();
                return EXIT_SUCCESS;
            } catch (...) {
                MPI_Abort(MPI_COMM_WORLD, EXIT_FAILURE);
                throw;
            }
        }
#endif
#if defined(MFEM_USE_MPI) && !defined(FULLMAG_OET0_DISABLE_MPI)
        require(argc == 1,
            "usage: fem_conservative_current_view_contract "
            "[--emit-mpi-records PATH]");
#else
        require(argc == 1,
            "usage: fem_conservative_current_view_contract");
#endif

        affine_trace_relations_preserve_independent_jumps_and_reject_cycles();
        deterministic_constraint_rank_oracle_is_exact();
        constraint_rank_row_semantics_are_explicit_and_validated();
        constraint_rank_resource_limits_are_bounded_without_large_fixtures();
        constraint_rank_handles_wide_exact_arithmetic_and_physical_rhs_gate();
        deterministic_constraint_rank_rejects_malformed_rows();
        orientation_conservation_and_source_cut_are_canonical();
        layered_conductor_preserves_series_current();
        if (std::getenv("FULLMAG_OET0_LARGE_MESH") != nullptr) {
            large_tetrahedral_projection_uses_sparse_kkt_lane();
        }
        identity_and_source_snapshot_are_immutable();
        all_four_digests_match_independent_frozen_preimages();
        balance_decoder_rejects_unbounded_or_invalid_text();
        current_transport_owner_is_atomic_fail_safe_and_non_aliasing();
        every_revision_participates_in_view_identity();
        validation_fails_closed();
        non_tetrahedral_mesh_is_rejected();
        curved_high_order_mesh_is_rejected_by_affine_v1();
        imported_rt0_nonfinite_dof_is_rejected();
        certified_imported_rt0_is_accepted_and_deep_owned();
        two_disconnected_closed_components_have_two_certified_dependencies();
        charge_trace_workspace_preserves_component_gauges_and_weak_reactions();
        charge_trace_workspace_rejects_jumps_lost_after_anchoring();
        charge_trace_workspace_reuses_owned_operator_after_sources_are_destroyed();
        charge_current_response_preserves_sign_and_independent_component_scales();
        charge_current_response_uses_terminal_anchors_and_rejects_common_mode();
        prepared_charge_current_response_reuses_owned_operator_and_checks_topology();
        charge_current_controls_require_exact_rank_modulo_original_volumes();
        physical_charge_terminal_currents_preserve_signed_references_and_scale();
        physical_charge_terminal_currents_keep_components_and_zero_jump_interfaces();
        physical_charge_terminal_faces_require_complete_dirichlet_closure();
        terminal_constrained_rt0_projection_preserves_measured_h1_currents();
        terminal_rt0_explicit_interfaces_preserve_signed_series_currents();
        terminal_rt0_projection_keeps_disconnected_current_scales();
        accepted_terminal_charge_source_freezes_layered_material_and_one_mesh();
        accepted_terminal_charge_source_freezes_explicit_interface_series();
        accepted_terminal_content_digest_matches_independent_owned_codec();
        accepted_terminal_charge_source_preserves_nanometre_scale_and_rejects_degeneracy();
        accepted_external_lead_finalizer_preserves_owned_series_and_rejects_foreign_descriptors();
        incomplete_external_lead_extension_fails_closed();
        coupled_volumetric_external_lead_extension_is_accepted();
        canonical_records_ignore_real_mesh_face_and_rt_dof_permutations();
        std::cout << "fem conservative current view contract: PASS\n";
        return EXIT_SUCCESS;
    } catch (const std::exception &error) {
        std::cerr << "fem conservative current view contract: FAIL: "
                  << error.what() << '\n';
        return EXIT_FAILURE;
    }
}
