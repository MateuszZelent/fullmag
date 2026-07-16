#include "cpu/mfem/transport/conservative_constraint_rank.hpp"

#include <boost/multiprecision/cpp_dec_float.hpp>
#include <boost/multiprecision/cpp_int.hpp>
#include <boost/rational.hpp>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <map>
#include <set>
#include <tuple>
#include <utility>

namespace fullmag::fem::transport {
namespace {

using BigInteger = boost::multiprecision::cpp_int;
using ExactRational = boost::rational<BigInteger>;
using SparseIntegerRow = std::map<std::size_t, BigInteger>;

constexpr std::array<std::uint64_t, 4> kZeroElementKey{};

std::uint64_t checked_add(
    std::uint64_t left,
    std::uint64_t right,
    const char *what)
{
    if (right > std::numeric_limits<std::uint64_t>::max() - left) {
        throw ConstraintRankResourceLimitExceeded(
            std::string("constraint-rank counter overflow: ") + what);
    }
    return left + right;
}

std::uint64_t integer_bit_length(const BigInteger &value)
{
    if (value == 0) {
        return 0;
    }
    const BigInteger magnitude = value < 0 ? -value : value;
    return checked_add(
        static_cast<std::uint64_t>(boost::multiprecision::msb(magnitude)),
        1,
        "integer bit length");
}

bool strict_nonzero_element_key(const std::array<std::uint64_t, 4> &key)
{
    return key[0] != 0 && key[0] < key[1] && key[1] < key[2] &&
        key[2] < key[3];
}

class ResourceBudget {
public:
    explicit ResourceBudget(ResourceCounts counts) : counts_(counts)
    {
        ConservativeConstraintRank::ValidateResourceCounts(counts_);
    }

    void add_work(std::uint64_t amount)
    {
        counts_.bareiss_work_units = checked_add(
            counts_.bareiss_work_units, amount, "work units");
        ConservativeConstraintRank::ValidateResourceCounts(counts_);
    }

    void observe_integer(const BigInteger &value)
    {
        counts_.maximum_intermediate_bit_length = std::max(
            counts_.maximum_intermediate_bit_length,
            integer_bit_length(value));
        ConservativeConstraintRank::ValidateResourceCounts(counts_);
    }

    void observe_sparse_integer_matrix(
        const std::vector<SparseIntegerRow> &matrix)
    {
        std::uint64_t nonzeros = 0;
        std::uint64_t storage_bits = 0;
        for (const auto &row : matrix) {
            nonzeros = checked_add(nonzeros,
                static_cast<std::uint64_t>(row.size()),
                "intermediate nonzeros");
            for (const auto &[column, value] : row) {
                (void)column;
                const auto bits = integer_bit_length(value);
                storage_bits = checked_add(
                    storage_bits, bits, "intermediate storage bits");
                counts_.maximum_intermediate_bit_length = std::max(
                    counts_.maximum_intermediate_bit_length, bits);
            }
        }
        counts_.maximum_intermediate_nonzeros = std::max(
            counts_.maximum_intermediate_nonzeros, nonzeros);
        counts_.intermediate_storage_bits = std::max(
            counts_.intermediate_storage_bits, storage_bits);
        ConservativeConstraintRank::ValidateResourceCounts(counts_);
    }

    void observe_rational(const ExactRational &value)
    {
        const auto numerator_bits = integer_bit_length(value.numerator());
        const auto denominator_bits = integer_bit_length(value.denominator());
        counts_.maximum_intermediate_bit_length = std::max({
            counts_.maximum_intermediate_bit_length,
            numerator_bits,
            denominator_bits});
        ConservativeConstraintRank::ValidateResourceCounts(counts_);
    }

    template <typename Basis>
    void observe_rational_basis(const Basis &basis)
    {
        std::uint64_t nonzeros = 0;
        std::uint64_t storage_bits = 0;
        for (const auto &[pivot, entry] : basis) {
            (void)pivot;
            nonzeros = checked_add(nonzeros,
                static_cast<std::uint64_t>(entry.coefficients.size()),
                "rational basis nonzeros");
            for (const auto &[column, value] : entry.coefficients) {
                (void)column;
                observe_rational(value);
                storage_bits = checked_add(storage_bits,
                    integer_bit_length(value.numerator()),
                    "rational numerator storage");
                storage_bits = checked_add(storage_bits,
                    integer_bit_length(value.denominator()),
                    "rational denominator storage");
            }
            observe_rational(entry.rhs);
            storage_bits = checked_add(storage_bits,
                integer_bit_length(entry.rhs.numerator()),
                "rational RHS numerator storage");
            storage_bits = checked_add(storage_bits,
                integer_bit_length(entry.rhs.denominator()),
                "rational RHS denominator storage");
        }
        counts_.maximum_intermediate_nonzeros = std::max(
            counts_.maximum_intermediate_nonzeros, nonzeros);
        counts_.intermediate_storage_bits = std::max(
            counts_.intermediate_storage_bits, storage_bits);
        ConservativeConstraintRank::ValidateResourceCounts(counts_);
    }

private:
    ResourceCounts counts_;
};

std::size_t exact_bareiss_rank(
    const std::vector<ConservativeConstraintRankRow> &rows,
    const std::vector<std::size_t> &row_indices,
    const std::map<std::uint64_t, std::size_t> &column_index,
    ResourceBudget *budget)
{
    std::vector<SparseIntegerRow> matrix;
    matrix.reserve(row_indices.size());
    for (const auto row_index : row_indices) {
        SparseIntegerRow row;
        const auto &source = rows[row_index];
        for (std::size_t entry = 0;
                entry < source.canonical_column_ids.size(); ++entry) {
            row.emplace(column_index.at(source.canonical_column_ids[entry]),
                BigInteger(source.incidence_coefficients[entry]));
        }
        matrix.push_back(std::move(row));
    }
    budget->observe_sparse_integer_matrix(matrix);
    if (matrix.empty() || column_index.empty()) {
        return 0;
    }

    std::size_t pivot_row = 0;
    BigInteger previous_pivot = 1;
    for (std::size_t column = 0;
            column < column_index.size() && pivot_row < matrix.size();
            ++column) {
        std::size_t selected = pivot_row;
        while (selected < matrix.size() &&
                matrix[selected].find(column) == matrix[selected].end()) {
            ++selected;
        }
        if (selected == matrix.size()) {
            continue;
        }
        if (selected != pivot_row) {
            std::swap(matrix[selected], matrix[pivot_row]);
        }
        const BigInteger pivot = matrix[pivot_row].at(column);
        budget->observe_integer(pivot);

        for (std::size_t row_index = pivot_row + 1;
                row_index < matrix.size(); ++row_index) {
            const auto eliminated = matrix[row_index].find(column);
            const BigInteger factor = eliminated == matrix[row_index].end()
                ? BigInteger(0) : eliminated->second;
            std::set<std::size_t> affected_columns;
            for (auto iterator = matrix[row_index].upper_bound(column);
                    iterator != matrix[row_index].end(); ++iterator) {
                affected_columns.insert(iterator->first);
            }
            for (auto iterator = matrix[pivot_row].upper_bound(column);
                    iterator != matrix[pivot_row].end(); ++iterator) {
                affected_columns.insert(iterator->first);
            }
            for (const auto affected : affected_columns) {
                const auto row_value_iterator = matrix[row_index].find(affected);
                const BigInteger row_value =
                    row_value_iterator == matrix[row_index].end()
                    ? BigInteger(0) : row_value_iterator->second;
                const auto pivot_value_iterator =
                    matrix[pivot_row].find(affected);
                const BigInteger pivot_value =
                    pivot_value_iterator == matrix[pivot_row].end()
                    ? BigInteger(0) : pivot_value_iterator->second;
                const BigInteger numerator =
                    row_value * pivot - factor * pivot_value;
                budget->add_work(1);
                budget->observe_integer(numerator);
                if (numerator % previous_pivot != 0) {
                    throw std::runtime_error(
                        "fraction-free Bareiss lost exact divisibility");
                }
                const BigInteger value = numerator / previous_pivot;
                budget->observe_integer(value);
                if (value == 0) {
                    matrix[row_index].erase(affected);
                } else {
                    matrix[row_index][affected] = value;
                }
            }
            matrix[row_index].erase(column);
        }
        previous_pivot = pivot;
        ++pivot_row;
        budget->observe_sparse_integer_matrix(matrix);
    }
    return pivot_row;
}

ExactRational exact_binary64(double value)
{
    std::uint64_t bits = 0;
    static_assert(sizeof(bits) == sizeof(value));
    std::memcpy(&bits, &value, sizeof(bits));
    const bool negative = (bits >> 63) != 0;
    const std::uint64_t exponent_bits = (bits >> 52) & 0x7ffu;
    const std::uint64_t fraction_bits = bits & ((std::uint64_t{1} << 52) - 1);
    if (exponent_bits == 0 && fraction_bits == 0) {
        return ExactRational(0);
    }
    BigInteger significand;
    int exponent;
    if (exponent_bits == 0) {
        significand = fraction_bits;
        exponent = -1074;
    } else {
        significand = (std::uint64_t{1} << 52) | fraction_bits;
        exponent = static_cast<int>(exponent_bits) - 1023 - 52;
    }
    if (negative) {
        significand = -significand;
    }
    if (exponent >= 0) {
        return ExactRational(significand << exponent);
    }
    return ExactRational(significand, BigInteger(1) << (-exponent));
}

ExactRational rational_abs(const ExactRational &value)
{
    return value < 0 ? -value : value;
}

double rational_to_double(const ExactRational &value)
{
    using Decimal = boost::multiprecision::cpp_dec_float_100;
    const Decimal numerator(value.numerator());
    const Decimal denominator(value.denominator());
    const double result = (numerator / denominator).convert_to<double>();
    return result == 0.0 ? 0.0 : result;
}

struct RationalBasisRow {
    std::map<std::size_t, ExactRational> coefficients;
    ExactRational rhs;
};

using RationalBasis = std::map<std::size_t, RationalBasisRow>;

RationalBasisRow make_rational_row(
    const ConservativeConstraintRankRow &row,
    const std::map<std::uint64_t, std::size_t> &column_index)
{
    RationalBasisRow result;
    for (std::size_t entry = 0;
            entry < row.canonical_column_ids.size(); ++entry) {
        result.coefficients.emplace(
            column_index.at(row.canonical_column_ids[entry]),
            ExactRational(row.incidence_coefficients[entry]));
    }
    result.rhs = exact_binary64(row.rhs_a);
    return result;
}

void reduce_against_basis(
    RationalBasisRow *row,
    const RationalBasis &basis,
    ResourceBudget *budget)
{
    for (const auto &[pivot, basis_row] : basis) {
        const auto entry = row->coefficients.find(pivot);
        if (entry == row->coefficients.end()) {
            continue;
        }
        const ExactRational factor = entry->second;
        row->coefficients.erase(entry);
        for (const auto &[column, coefficient] : basis_row.coefficients) {
            if (column == pivot) {
                continue;
            }
            const ExactRational updated = row->coefficients[column] -
                factor * coefficient;
            budget->add_work(1);
            budget->observe_rational(updated);
            if (updated == 0) {
                row->coefficients.erase(column);
            } else {
                row->coefficients[column] = updated;
            }
        }
        row->rhs -= factor * basis_row.rhs;
        budget->add_work(1);
        budget->observe_rational(row->rhs);
    }
}

void add_independent_row_to_basis(
    RationalBasisRow row,
    RationalBasis *basis,
    ResourceBudget *budget)
{
    reduce_against_basis(&row, *basis, budget);
    if (row.coefficients.empty()) {
        throw std::runtime_error(
            "Bareiss/rational rank disagreement for independent row");
    }
    const std::size_t pivot = row.coefficients.begin()->first;
    const ExactRational scale = row.coefficients.begin()->second;
    for (auto &[column, coefficient] : row.coefficients) {
        (void)column;
        coefficient /= scale;
        budget->add_work(1);
        budget->observe_rational(coefficient);
    }
    row.rhs /= scale;
    budget->add_work(1);
    budget->observe_rational(row.rhs);
    if (!basis->emplace(pivot, std::move(row)).second) {
        throw std::runtime_error("rational basis pivot collision");
    }
    budget->observe_rational_basis(*basis);
}

ExactRational dependent_residual(
    RationalBasisRow row,
    const RationalBasis &basis,
    ResourceBudget *budget)
{
    reduce_against_basis(&row, basis, budget);
    if (!row.coefficients.empty()) {
        throw std::runtime_error(
            "Bareiss/rational rank disagreement for dependent row");
    }
    return row.rhs;
}

ResourceCounts validate_rows_and_count_resources(
    const std::vector<ConservativeConstraintRankRow> &rows,
    std::set<std::uint64_t> *distinct_columns)
{
    ResourceCounts counts;
    counts.rows = static_cast<std::uint64_t>(rows.size());
    std::set<std::string> ids;
    std::map<std::array<std::uint64_t, 4>,
        std::set<std::array<std::uint64_t, 4>>> component_rows;
    std::map<std::array<std::uint64_t, 4>, std::uint64_t> candidates;

    for (const auto &row : rows) {
        if (row.constraint_id.empty()) {
            throw std::invalid_argument("constraint ID must not be empty");
        }
        if (!ids.insert(row.constraint_id).second) {
            throw std::invalid_argument("constraint IDs must be unique");
        }
        if (row.canonical_column_ids.size() !=
                row.incidence_coefficients.size()) {
            throw std::invalid_argument(
                "constraint column/coefficient lengths differ");
        }
        if (row.canonical_column_ids.size() >
                ConservativeConstraintRank::kMaximumColumnsPerRow) {
            throw ConstraintRankResourceLimitExceeded(
                "constraint row nonzero cap exceeded");
        }
        counts.maximum_nonzeros_per_row = std::max(
            counts.maximum_nonzeros_per_row,
            static_cast<std::uint64_t>(row.canonical_column_ids.size()));
        counts.total_nonzeros = checked_add(counts.total_nonzeros,
            static_cast<std::uint64_t>(row.canonical_column_ids.size()),
            "input nonzeros");
        for (std::size_t entry = 0;
                entry < row.canonical_column_ids.size(); ++entry) {
            if (row.canonical_column_ids[entry] == 0 ||
                    (entry != 0 && row.canonical_column_ids[entry - 1] >=
                        row.canonical_column_ids[entry])) {
                throw std::invalid_argument(
                    "constraint columns must be strictly increasing and nonzero");
            }
            if (row.incidence_coefficients[entry] == 0) {
                throw std::invalid_argument(
                    "constraint coefficients must not store zero");
            }
            distinct_columns->insert(row.canonical_column_ids[entry]);
        }
        if (!std::isfinite(row.rhs_a)) {
            throw std::invalid_argument("constraint RHS must be finite");
        }

        switch (row.kind) {
        case ConservativeConstraintRankRowKind::Generic:
            if (row.closed_component_anchor_element != kZeroElementKey ||
                    row.row_element_key != kZeroElementKey) {
                throw std::invalid_argument(
                    "generic constraint row must use zero element sentinels");
            }
            break;
        case ConservativeConstraintRankRowKind::ClosedComponentDivergence: {
            if (!strict_nonzero_element_key(
                    row.closed_component_anchor_element) ||
                    !strict_nonzero_element_key(row.row_element_key) ||
                    row.row_element_key <
                        row.closed_component_anchor_element) {
                throw std::invalid_argument(
                    "closed-component row metadata is invalid");
            }
            auto &row_keys =
                component_rows[row.closed_component_anchor_element];
            if (!row_keys.insert(row.row_element_key).second) {
                throw std::invalid_argument(
                    "closed component has a duplicate row element key");
            }
            if (row.row_element_key ==
                    row.closed_component_anchor_element) {
                candidates[row.closed_component_anchor_element] = checked_add(
                    candidates[row.closed_component_anchor_element], 1,
                    "component anchor candidates");
            }
            break;
        }
        default:
            throw std::invalid_argument("unknown constraint-rank row kind");
        }
    }
    for (const auto &[component, row_keys] : component_rows) {
        (void)row_keys;
        if (candidates[component] != 1) {
            throw std::invalid_argument(
                "closed component requires exactly one anchor candidate");
        }
    }
    counts.distinct_columns =
        static_cast<std::uint64_t>(distinct_columns->size());
    return counts;
}

bool is_anchor_candidate(const ConservativeConstraintRankRow &row)
{
    return row.kind ==
            ConservativeConstraintRankRowKind::ClosedComponentDivergence &&
        row.row_element_key == row.closed_component_anchor_element;
}

} // namespace

InconsistentDependentConstraint::InconsistentDependentConstraint(
    std::string constraint_id,
    double residual_a,
    const std::string &message)
    : std::runtime_error(message),
      constraint_id_(std::move(constraint_id)), residual_a_(residual_a)
{
}

const std::string &
InconsistentDependentConstraint::constraint_id() const noexcept
{
    return constraint_id_;
}

double InconsistentDependentConstraint::residual_a() const noexcept
{
    return residual_a_;
}

void ConservativeConstraintRank::ValidateResourceCounts(
    const ResourceCounts &counts)
{
    if (counts.rows > kMaximumRows ||
            counts.distinct_columns > kMaximumDistinctColumns ||
            counts.total_nonzeros > kMaximumNonzeros ||
            counts.maximum_nonzeros_per_row > kMaximumColumnsPerRow ||
            counts.maximum_intermediate_nonzeros >
                kMaximumIntermediateNonzeros ||
            counts.intermediate_storage_bits >
                kMaximumIntermediateStorageBits ||
            counts.bareiss_work_units > kMaximumBareissWorkUnits ||
            counts.maximum_intermediate_bit_length >
                kMaximumIntermediateBitLength) {
        throw ConstraintRankResourceLimitExceeded(
            "constraint-rank resource budget exceeded");
    }
}

ConstraintRankCertificate ConservativeConstraintRank::Analyze(
    const std::vector<ConservativeConstraintRankRow> &rows,
    double physical_absolute_gate_a,
    double physical_relative_gate)
{
    if (!(std::isfinite(physical_absolute_gate_a) &&
            physical_absolute_gate_a >= 0.0) ||
            !(std::isfinite(physical_relative_gate) &&
                physical_relative_gate >= 0.0)) {
        throw std::invalid_argument(
            "constraint-rank physical gates must be finite and nonnegative");
    }

    std::set<std::uint64_t> distinct_columns;
    const auto initial_counts =
        validate_rows_and_count_resources(rows, &distinct_columns);
    ResourceBudget budget(initial_counts);
    std::map<std::uint64_t, std::size_t> column_index;
    std::size_t next_column = 0;
    for (const auto column : distinct_columns) {
        column_index.emplace(column, next_column++);
    }

    std::vector<std::size_t> processing_order(rows.size());
    for (std::size_t index = 0; index < rows.size(); ++index) {
        processing_order[index] = index;
    }
    std::sort(processing_order.begin(), processing_order.end(),
        [&](std::size_t left, std::size_t right) {
            return std::make_tuple(is_anchor_candidate(rows[left]),
                       rows[left].constraint_id) <
                std::make_tuple(is_anchor_candidate(rows[right]),
                       rows[right].constraint_id);
        });

    ConstraintRankCertificate certificate;
    certificate.rows_before = static_cast<std::uint64_t>(rows.size());
    std::vector<std::size_t> retained_rows;
    RationalBasis rational_basis;
    for (const auto row_index : processing_order) {
        auto trial_rows = retained_rows;
        trial_rows.push_back(row_index);
        const auto trial_rank = exact_bareiss_rank(
            rows, trial_rows, column_index, &budget);
        if (trial_rank > retained_rows.size()) {
            if (is_anchor_candidate(rows[row_index])) {
                throw std::runtime_error(
                    "closed-component anchor candidate is independent");
            }
            add_independent_row_to_basis(
                make_rational_row(rows[row_index], column_index),
                &rational_basis, &budget);
            retained_rows.push_back(row_index);
            continue;
        }
        if (trial_rank != retained_rows.size()) {
            throw std::runtime_error("Bareiss rank changed non-monotonically");
        }
        if (rows[row_index].kind ==
                    ConservativeConstraintRankRowKind::ClosedComponentDivergence &&
                !is_anchor_candidate(rows[row_index])) {
            throw std::runtime_error(
                "closed-component non-candidate row is dependent");
        }

        const ExactRational residual = dependent_residual(
            make_rational_row(rows[row_index], column_index),
            rational_basis, &budget);
        const ExactRational authored_rhs = exact_binary64(rows[row_index].rhs_a);
        const ExactRational absolute_gate =
            exact_binary64(physical_absolute_gate_a);
        const ExactRational relative_gate =
            exact_binary64(physical_relative_gate);
        const ExactRational rhs_floor = exact_binary64(1.0e-30);
        const ExactRational rhs_scale = std::max(
            rational_abs(authored_rhs), rhs_floor);
        const ExactRational gate = std::max(
            absolute_gate, relative_gate * rhs_scale);
        const double residual_a = rational_to_double(residual);
        if (rational_abs(residual) > gate) {
            throw InconsistentDependentConstraint(
                rows[row_index].constraint_id,
                residual_a,
                "dependent constraint RHS is physically inconsistent");
        }

        ConstraintRankOmittedRow omitted;
        omitted.constraint_id = rows[row_index].constraint_id;
        omitted.residual_a = residual_a;
        if (rows[row_index].kind ==
                ConservativeConstraintRankRowKind::ClosedComponentDivergence) {
            omitted.reason =
                ConstraintOmissionReason::ClosedComponentDivergenceDependency;
            omitted.closed_component_anchor_element =
                rows[row_index].closed_component_anchor_element;
        } else {
            omitted.reason =
                ConstraintOmissionReason::ConsistentLinearDependency;
            omitted.closed_component_anchor_element = kZeroElementKey;
        }
        certificate.omitted_rows.push_back(std::move(omitted));
    }
    certificate.rank = static_cast<std::uint64_t>(retained_rows.size());
    std::sort(certificate.omitted_rows.begin(),
        certificate.omitted_rows.end(),
        [](const auto &left, const auto &right) {
            return left.constraint_id < right.constraint_id;
        });
    return certificate;
}

} // namespace fullmag::fem::transport
