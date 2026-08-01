#include "cpu/mfem/transport/conservative_constraint_rank.hpp"

#include <boost/multiprecision/cpp_int.hpp>
#include <boost/rational.hpp>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <initializer_list>
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

std::uint64_t checked_multiply(
    std::uint64_t left,
    std::uint64_t right,
    const char *what)
{
    if (left != 0 && right > std::numeric_limits<std::uint64_t>::max() / left) {
        throw ConstraintRankResourceLimitExceeded(
            std::string("constraint-rank counter overflow: ") + what);
    }
    return left * right;
}

std::uint64_t checked_subtract(
    std::uint64_t left,
    std::uint64_t right,
    const char *what)
{
    if (right > left) {
        throw std::runtime_error(
            std::string("constraint-rank accounting underflow: ") + what);
    }
    return left - right;
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
    ResourceBudget(ResourceCounts counts, ResourceCounts limits)
        : counts_(counts), limits_(limits)
    {
        validate();
    }

    void add_work(std::uint64_t amount)
    {
        counts_.bareiss_work_units = checked_add(
            counts_.bareiss_work_units, amount, "work units");
        validate();
    }

    void observe_exact_state(
        std::uint64_t nonzeros,
        std::uint64_t storage_bits,
        std::uint64_t maximum_bit_length)
    {
        counts_.maximum_intermediate_nonzeros = std::max(
            counts_.maximum_intermediate_nonzeros, nonzeros);
        counts_.intermediate_storage_bits = std::max(
            counts_.intermediate_storage_bits, storage_bits);
        counts_.maximum_intermediate_bit_length = std::max(
            counts_.maximum_intermediate_bit_length,
            maximum_bit_length);
        validate();
    }

private:
    void validate() const
    {
        ConservativeConstraintRank::ValidateResourceCounts(counts_);
        if (counts_.rows > limits_.rows ||
                counts_.distinct_columns > limits_.distinct_columns ||
                counts_.total_nonzeros > limits_.total_nonzeros ||
                counts_.maximum_nonzeros_per_row >
                    limits_.maximum_nonzeros_per_row ||
                counts_.maximum_intermediate_nonzeros >
                    limits_.maximum_intermediate_nonzeros ||
                counts_.intermediate_storage_bits >
                    limits_.intermediate_storage_bits ||
                counts_.bareiss_work_units > limits_.bareiss_work_units ||
                counts_.maximum_intermediate_bit_length >
                    limits_.maximum_intermediate_bit_length) {
            throw ConstraintRankResourceLimitExceeded(
                "constraint-rank Analyze resource budget exceeded");
        }
    }

    ResourceCounts counts_;
    ResourceCounts limits_;
};

ResourceCounts maximum_resource_counts()
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

#ifdef FULLMAG_CONSTRAINT_RANK_TESTING
ResourceCounts analyze_resource_limits = maximum_resource_counts();
#endif

ResourceCounts current_analyze_resource_limits()
{
#ifdef FULLMAG_CONSTRAINT_RANK_TESTING
    return analyze_resource_limits;
#else
    return maximum_resource_counts();
#endif
}

struct ExactStateSize {
    std::uint64_t nonzeros = 0;
    std::uint64_t storage_bits = 0;
    std::uint64_t maximum_bit_length = 0;
};

void append_integer_size(ExactStateSize *size, const BigInteger &value)
{
    const auto bits = integer_bit_length(value);
    if (value != 0) {
        size->nonzeros = checked_add(
            size->nonzeros, 1, "exact-state nonzeros");
    }
    size->storage_bits = checked_add(
        size->storage_bits, bits, "exact-state storage bits");
    size->maximum_bit_length = std::max(size->maximum_bit_length, bits);
}

void append_rational_size(ExactStateSize *size, const ExactRational &value)
{
    if (value.numerator() != 0) {
        size->nonzeros = checked_add(
            size->nonzeros, 1, "exact-state rational nonzeros");
    }
    const auto numerator_bits = integer_bit_length(value.numerator());
    const auto denominator_bits = integer_bit_length(value.denominator());
    size->storage_bits = checked_add(
        size->storage_bits, numerator_bits, "rational numerator storage");
    size->storage_bits = checked_add(
        size->storage_bits, denominator_bits, "rational denominator storage");
    size->maximum_bit_length = std::max({
        size->maximum_bit_length, numerator_bits, denominator_bits});
}

void replace_integer_size(
    ExactStateSize *size,
    const BigInteger &old_value,
    const BigInteger &new_value)
{
    const auto old_bits = integer_bit_length(old_value);
    const auto new_bits = integer_bit_length(new_value);
    if (old_value != 0) {
        size->nonzeros = checked_subtract(
            size->nonzeros, 1, "integer nonzeros");
    }
    if (new_value != 0) {
        size->nonzeros = checked_add(
            size->nonzeros, 1, "integer nonzeros");
    }
    size->storage_bits = checked_subtract(
        size->storage_bits, old_bits, "integer storage bits");
    size->storage_bits = checked_add(
        size->storage_bits, new_bits, "integer storage bits");
    size->maximum_bit_length = std::max(
        size->maximum_bit_length, new_bits);
}

void replace_rational_size(
    ExactStateSize *size,
    const ExactRational &old_value,
    const ExactRational &new_value)
{
    const auto old_numerator_bits =
        integer_bit_length(old_value.numerator());
    const auto old_denominator_bits =
        integer_bit_length(old_value.denominator());
    const auto new_numerator_bits =
        integer_bit_length(new_value.numerator());
    const auto new_denominator_bits =
        integer_bit_length(new_value.denominator());
    if (old_value.numerator() != 0) {
        size->nonzeros = checked_subtract(
            size->nonzeros, 1, "rational nonzeros");
    }
    if (new_value.numerator() != 0) {
        size->nonzeros = checked_add(
            size->nonzeros, 1, "rational nonzeros");
    }
    size->storage_bits = checked_subtract(size->storage_bits,
        checked_add(old_numerator_bits, old_denominator_bits,
            "old rational storage bits"),
        "rational storage bits");
    size->storage_bits = checked_add(size->storage_bits,
        checked_add(new_numerator_bits, new_denominator_bits,
            "new rational storage bits"),
        "rational storage bits");
    size->maximum_bit_length = std::max({size->maximum_bit_length,
        new_numerator_bits, new_denominator_bits});
}

ExactStateSize combine_sizes(
    const ExactStateSize &left,
    const ExactStateSize &right)
{
    ExactStateSize result;
    result.nonzeros = checked_add(
        left.nonzeros, right.nonzeros, "combined exact-state nonzeros");
    result.storage_bits = checked_add(
        left.storage_bits, right.storage_bits,
        "combined exact-state storage bits");
    result.maximum_bit_length = std::max(
        left.maximum_bit_length, right.maximum_bit_length);
    return result;
}

ExactStateSize measure_row(
    const SparseIntegerRow &coefficients,
    const ExactRational &rhs,
    ResourceBudget *budget)
{
    ExactStateSize result;
    for (const auto &[column, value] : coefficients) {
        (void)column;
        budget->add_work(1);
        append_integer_size(&result, value);
    }
    budget->add_work(1);
    append_rational_size(&result, rhs);
    return result;
}

void observe_state(
    ResourceBudget *budget,
    const ExactStateSize &persistent,
    const ExactStateSize &transient)
{
    const auto combined = combine_sizes(persistent, transient);
    budget->observe_exact_state(combined.nonzeros, combined.storage_bits,
        combined.maximum_bit_length);
}

void observe_integer_temporary(
    ResourceBudget *budget,
    const ExactStateSize &base,
    const BigInteger &value)
{
    auto combined = base;
    append_integer_size(&combined, value);
    budget->observe_exact_state(combined.nonzeros, combined.storage_bits,
        combined.maximum_bit_length);
}

void observe_rational_temporary(
    ResourceBudget *budget,
    const ExactStateSize &base,
    const ExactRational &value)
{
    auto combined = base;
    append_rational_size(&combined, value);
    budget->observe_exact_state(combined.nonzeros, combined.storage_bits,
        combined.maximum_bit_length);
}

void observe_integer_temporaries(
    ResourceBudget *budget,
    const ExactStateSize &base,
    std::initializer_list<const BigInteger *> values)
{
    auto combined = base;
    for (const auto *value : values) {
        append_integer_size(&combined, *value);
    }
    budget->observe_exact_state(combined.nonzeros, combined.storage_bits,
        combined.maximum_bit_length);
}

void observe_rational_temporaries(
    ResourceBudget *budget,
    const ExactStateSize &base,
    std::initializer_list<const ExactRational *> values)
{
    auto combined = base;
    for (const auto *value : values) {
        append_rational_size(&combined, *value);
    }
    budget->observe_exact_state(combined.nonzeros, combined.storage_bits,
        combined.maximum_bit_length);
}

void observe_mixed_exact_temporaries(
    ResourceBudget *budget,
    const ExactStateSize &base,
    std::initializer_list<const BigInteger *> integer_values,
    std::initializer_list<const ExactRational *> rational_values)
{
    auto combined = base;
    for (const auto *value : integer_values) {
        append_integer_size(&combined, *value);
    }
    for (const auto *value : rational_values) {
        append_rational_size(&combined, *value);
    }
    budget->observe_exact_state(combined.nonzeros, combined.storage_bits,
        combined.maximum_bit_length);
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

ExactRational multiply_rational_integer(
    const ExactRational &value,
    const BigInteger &factor,
    ResourceBudget *budget,
    const ExactStateSize &base)
{
    const BigInteger numerator = value.numerator() * factor;
    const BigInteger denominator = value.denominator();
    budget->add_work(1);
    observe_integer_temporaries(
        budget, base, {&numerator, &denominator});
    const ExactRational result(numerator, denominator);
    observe_mixed_exact_temporaries(
        budget, base, {&numerator, &denominator}, {&result});
    return result;
}

ExactRational subtract_rationals(
    const ExactRational &left,
    const ExactRational &right,
    ResourceBudget *budget,
    const ExactStateSize &base)
{
    const BigInteger left_product =
        left.numerator() * right.denominator();
    const BigInteger right_product =
        right.numerator() * left.denominator();
    const BigInteger denominator =
        left.denominator() * right.denominator();
    budget->add_work(3);
    observe_integer_temporaries(budget, base,
        {&left_product, &right_product, &denominator});
    const BigInteger numerator = left_product - right_product;
    budget->add_work(1);
    observe_integer_temporaries(budget, base,
        {&left_product, &right_product, &numerator, &denominator});
    const ExactRational result(numerator, denominator);
    observe_mixed_exact_temporaries(budget, base,
        {&left_product, &right_product, &numerator, &denominator},
        {&result});
    return result;
}

ExactRational divide_rational_integer(
    const ExactRational &value,
    const BigInteger &divisor,
    ResourceBudget *budget,
    const ExactStateSize &base)
{
    if (divisor == 0) {
        throw std::runtime_error("fraction-free Bareiss produced a zero pivot");
    }
    const BigInteger numerator = value.numerator();
    const BigInteger denominator = value.denominator() * divisor;
    budget->add_work(1);
    observe_integer_temporaries(
        budget, base, {&numerator, &denominator});
    const ExactRational result(numerator, denominator);
    observe_mixed_exact_temporaries(
        budget, base, {&numerator, &denominator}, {&result});
    return result;
}

ExactRational multiply_rationals(
    const ExactRational &left,
    const ExactRational &right,
    ResourceBudget *budget,
    const ExactStateSize &base)
{
    const BigInteger numerator = left.numerator() * right.numerator();
    const BigInteger denominator =
        left.denominator() * right.denominator();
    budget->add_work(2);
    observe_integer_temporaries(
        budget, base, {&numerator, &denominator});
    const ExactRational result(numerator, denominator);
    observe_mixed_exact_temporaries(
        budget, base, {&numerator, &denominator}, {&result});
    return result;
}

std::int64_t binary_exponent_floor(
    const BigInteger &numerator,
    const BigInteger &denominator,
    ResourceBudget *budget,
    const ExactStateSize &base)
{
    const auto numerator_bits = integer_bit_length(numerator);
    const auto denominator_bits = integer_bit_length(denominator);
    std::int64_t exponent = static_cast<std::int64_t>(numerator_bits) -
        static_cast<std::int64_t>(denominator_bits);
    budget->add_work(1);
    if (exponent >= 0) {
        const BigInteger scaled_denominator = denominator << exponent;
        observe_integer_temporary(
            budget, base, scaled_denominator);
        budget->add_work(1);
        if (numerator < scaled_denominator) {
            --exponent;
        }
    } else {
        const BigInteger scaled_numerator = numerator << (-exponent);
        observe_integer_temporary(budget, base, scaled_numerator);
        budget->add_work(1);
        if (scaled_numerator < denominator) {
            --exponent;
        }
    }
    return exponent;
}

BigInteger rounded_scaled_ratio(
    const BigInteger &numerator,
    const BigInteger &denominator,
    std::int64_t binary_shift,
    ResourceBudget *budget,
    const ExactStateSize &base)
{
    BigInteger scaled_numerator = numerator;
    BigInteger scaled_denominator = denominator;
    if (binary_shift >= 0) {
        scaled_numerator <<= binary_shift;
    } else {
        scaled_denominator <<= -binary_shift;
    }
    budget->add_work(1);
    observe_integer_temporaries(
        budget, base, {&scaled_numerator, &scaled_denominator});

    BigInteger quotient = scaled_numerator / scaled_denominator;
    BigInteger remainder = scaled_numerator % scaled_denominator;
    budget->add_work(2);
    observe_integer_temporaries(
        budget, base, {&scaled_numerator, &scaled_denominator,
            &quotient, &remainder});
    const BigInteger doubled_remainder = remainder << 1;
    budget->add_work(1);
    observe_integer_temporaries(
        budget, base, {&scaled_numerator, &scaled_denominator, &quotient,
            &remainder, &doubled_remainder});
    budget->add_work(2);
    if (doubled_remainder > scaled_denominator ||
            (doubled_remainder == scaled_denominator &&
                static_cast<bool>(quotient & 1))) {
        ++quotient;
        observe_integer_temporaries(
            budget, base, {&scaled_numerator, &scaled_denominator,
                &quotient, &remainder, &doubled_remainder});
    }
    return quotient;
}

double rational_to_binary64(
    const ExactRational &value,
    ResourceBudget *budget,
    const ExactStateSize &base)
{
    if (value == 0) {
        return 0.0;
    }
    const bool negative = value < 0;
    const BigInteger numerator =
        negative ? -value.numerator() : value.numerator();
    const BigInteger denominator = value.denominator();
    auto conversion_base = base;
    append_integer_size(&conversion_base, numerator);
    append_integer_size(&conversion_base, denominator);
    budget->observe_exact_state(conversion_base.nonzeros,
        conversion_base.storage_bits, conversion_base.maximum_bit_length);
    std::int64_t exponent = binary_exponent_floor(
        numerator, denominator, budget, conversion_base);
    if (exponent > 1023) {
        throw std::overflow_error(
            "exact constraint residual is not finite binary64");
    }

    BigInteger significand;
    std::uint64_t exponent_bits = 0;
    if (exponent >= -1022) {
        significand = rounded_scaled_ratio(numerator, denominator,
            52 - exponent, budget, conversion_base);
        if (significand == (BigInteger(1) << 53)) {
            significand >>= 1;
            ++exponent;
        }
        if (exponent > 1023) {
            throw std::overflow_error(
                "exact constraint residual is not finite binary64");
        }
        exponent_bits = static_cast<std::uint64_t>(exponent + 1023);
        significand -= BigInteger(1) << 52;
    } else {
        significand = rounded_scaled_ratio(
            numerator, denominator, 1074, budget, conversion_base);
        if (significand == (BigInteger(1) << 52)) {
            exponent_bits = 1;
            significand = 0;
        }
    }
    observe_integer_temporary(budget, conversion_base, significand);
    if (significand < 0 || significand >= (BigInteger(1) << 52)) {
        throw std::runtime_error(
            "exact constraint residual binary64 rounding failed");
    }
    const std::uint64_t fraction_bits =
        significand.convert_to<std::uint64_t>();
    const std::uint64_t bits = (negative ? (std::uint64_t{1} << 63) : 0) |
        (exponent_bits << 52) | fraction_bits;
    double result = 0.0;
    static_assert(sizeof(bits) == sizeof(result));
    std::memcpy(&result, &bits, sizeof(result));
    if (!std::isfinite(result)) {
        throw std::overflow_error(
            "exact constraint residual is not finite binary64");
    }
    return result;
}

void assign_tracked_coefficient(
    SparseIntegerRow *coefficients,
    std::size_t column,
    const BigInteger &value,
    ExactStateSize *row_state,
    const ExactStateSize &persistent_state,
    ResourceBudget *budget)
{
    const auto iterator = coefficients->find(column);
    const BigInteger old_value = iterator == coefficients->end()
        ? BigInteger(0) : iterator->second;
    auto projected_state = *row_state;
    replace_integer_size(&projected_state, old_value, value);
    observe_state(budget, persistent_state, projected_state);
    if (value == 0) {
        coefficients->erase(column);
    } else {
        (*coefficients)[column] = value;
    }
    *row_state = projected_state;
}

void assign_tracked_rhs(
    ExactRational *rhs,
    const ExactRational &value,
    ExactStateSize *row_state,
    const ExactStateSize &persistent_state,
    ResourceBudget *budget)
{
    auto projected_state = *row_state;
    replace_rational_size(&projected_state, *rhs, value);
    observe_state(budget, persistent_state, projected_state);
    *rhs = value;
    *row_state = projected_state;
}

struct BareissBasisRow {
    std::size_t pivot = 0;
    SparseIntegerRow coefficients;
    ExactRational rhs;
};

BareissBasisRow make_bareiss_row(
    const ConservativeConstraintRankRow &row,
    const std::map<std::uint64_t, std::size_t> &column_index,
    ResourceBudget *budget)
{
    BareissBasisRow result;
    for (std::size_t entry = 0;
            entry < row.canonical_column_ids.size(); ++entry) {
        budget->add_work(1);
        result.coefficients.emplace(
            column_index.at(row.canonical_column_ids[entry]),
            BigInteger(row.incidence_coefficients[entry]));
    }
    result.rhs = exact_binary64(row.rhs_a);
    return result;
}

BigInteger reduce_bareiss_row(
    BareissBasisRow *row,
    const std::vector<BareissBasisRow> &basis,
    const ExactStateSize &persistent_state,
    ResourceBudget *budget,
    ExactStateSize *final_row_state)
{
    BigInteger previous_pivot = 1;
    auto row_state = measure_row(row->coefficients, row->rhs, budget);
    observe_state(budget, persistent_state, row_state);

    for (const auto &basis_row : basis) {
        const auto pivot_iterator =
            basis_row.coefficients.find(basis_row.pivot);
        if (pivot_iterator == basis_row.coefficients.end()) {
            throw std::runtime_error("Bareiss basis lost its pivot");
        }
        const BigInteger &pivot = pivot_iterator->second;
        const auto factor_iterator = row->coefficients.find(basis_row.pivot);
        const BigInteger factor = factor_iterator == row->coefficients.end()
            ? BigInteger(0) : factor_iterator->second;
        budget->add_work(2);

        std::set<std::size_t> affected_columns;
        for (auto iterator = row->coefficients.begin();
                iterator != row->coefficients.end(); ++iterator) {
            budget->add_work(1);
            if (iterator->first != basis_row.pivot) {
                affected_columns.insert(iterator->first);
            }
        }
        for (auto iterator = basis_row.coefficients.begin();
                iterator != basis_row.coefficients.end(); ++iterator) {
            budget->add_work(1);
            if (iterator->first != basis_row.pivot) {
                affected_columns.insert(iterator->first);
            }
        }
        budget->add_work(
            static_cast<std::uint64_t>(affected_columns.size()));

        for (const auto column : affected_columns) {
            const auto row_value_iterator = row->coefficients.find(column);
            const BigInteger row_value =
                row_value_iterator == row->coefficients.end()
                ? BigInteger(0) : row_value_iterator->second;
            const auto basis_value_iterator =
                basis_row.coefficients.find(column);
            const BigInteger basis_value =
                basis_value_iterator == basis_row.coefficients.end()
                ? BigInteger(0) : basis_value_iterator->second;
            budget->add_work(2);
            const auto base = combine_sizes(persistent_state, row_state);
            auto coefficient_base = base;
            append_integer_size(&coefficient_base, row_value);
            append_integer_size(&coefficient_base, basis_value);
            append_integer_size(&coefficient_base, factor);
            append_integer_size(&coefficient_base, previous_pivot);
            budget->observe_exact_state(coefficient_base.nonzeros,
                coefficient_base.storage_bits,
                coefficient_base.maximum_bit_length);

            const BigInteger left_product = row_value * pivot;
            const BigInteger right_product = factor * basis_value;
            budget->add_work(2);
            auto coefficient_with_products = coefficient_base;
            append_integer_size(&coefficient_with_products, left_product);
            append_integer_size(&coefficient_with_products, right_product);
            budget->observe_exact_state(coefficient_with_products.nonzeros,
                coefficient_with_products.storage_bits,
                coefficient_with_products.maximum_bit_length);
            const BigInteger numerator = left_product - right_product;
            budget->add_work(1);
            auto coefficient_with_numerator = coefficient_with_products;
            append_integer_size(&coefficient_with_numerator, numerator);
            budget->observe_exact_state(coefficient_with_numerator.nonzeros,
                coefficient_with_numerator.storage_bits,
                coefficient_with_numerator.maximum_bit_length);
            budget->add_work(1);
            if (numerator % previous_pivot != 0) {
                throw std::runtime_error(
                    "fraction-free Bareiss lost exact divisibility");
            }
            const BigInteger value = numerator / previous_pivot;
            budget->add_work(1);
            auto coefficient_with_value = coefficient_with_numerator;
            append_integer_size(&coefficient_with_value, value);
            budget->observe_exact_state(coefficient_with_value.nonzeros,
                coefficient_with_value.storage_bits,
                coefficient_with_value.maximum_bit_length);
            assign_tracked_coefficient(&row->coefficients, column, value,
                &row_state, persistent_state, budget);
            observe_mixed_exact_temporaries(
                budget, combine_sizes(persistent_state, row_state),
                {&row_value, &basis_value, &factor, &left_product,
                    &right_product, &numerator, &value, &previous_pivot},
                {});
        }

        const auto base = combine_sizes(persistent_state, row_state);
        auto rhs_base = base;
        append_integer_size(&rhs_base, factor);
        append_integer_size(&rhs_base, previous_pivot);
        budget->observe_exact_state(rhs_base.nonzeros, rhs_base.storage_bits,
            rhs_base.maximum_bit_length);
        const ExactRational left_rhs = multiply_rational_integer(
            row->rhs, pivot, budget, rhs_base);
        auto rhs_with_left = rhs_base;
        append_rational_size(&rhs_with_left, left_rhs);
        budget->observe_exact_state(rhs_with_left.nonzeros,
            rhs_with_left.storage_bits, rhs_with_left.maximum_bit_length);
        const ExactRational right_rhs = multiply_rational_integer(
            basis_row.rhs, factor, budget, rhs_with_left);
        auto rhs_with_products = rhs_with_left;
        append_rational_size(&rhs_with_products, right_rhs);
        budget->observe_exact_state(rhs_with_products.nonzeros,
            rhs_with_products.storage_bits,
            rhs_with_products.maximum_bit_length);
        const ExactRational numerator_rhs = subtract_rationals(
            left_rhs, right_rhs, budget, rhs_with_products);
        auto rhs_with_numerator = rhs_with_products;
        append_rational_size(&rhs_with_numerator, numerator_rhs);
        budget->observe_exact_state(rhs_with_numerator.nonzeros,
            rhs_with_numerator.storage_bits,
            rhs_with_numerator.maximum_bit_length);
        const ExactRational updated_rhs = divide_rational_integer(
            numerator_rhs, previous_pivot, budget, rhs_with_numerator);
        observe_rational_temporary(budget, rhs_with_numerator, updated_rhs);
        assign_tracked_rhs(&row->rhs, updated_rhs, &row_state,
            persistent_state, budget);
        observe_mixed_exact_temporaries(
            budget, combine_sizes(persistent_state, row_state),
            {&factor, &previous_pivot},
            {&left_rhs, &right_rhs, &numerator_rhs, &updated_rhs});
        assign_tracked_coefficient(&row->coefficients, basis_row.pivot,
            BigInteger(0), &row_state, persistent_state, budget);
        budget->add_work(1);
        previous_pivot = pivot;
    }
    *final_row_state = row_state;
    return previous_pivot;
}

ResourceCounts validate_rows_and_count_resources(
    const std::vector<ConservativeConstraintRankRow> &rows,
    std::set<std::uint64_t> *distinct_columns)
{
    ResourceCounts counts;
    counts.rows = static_cast<std::uint64_t>(rows.size());
    ConservativeConstraintRank::ValidateResourceCounts(counts);
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
        ConservativeConstraintRank::ValidateResourceCounts(counts);
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
            const auto column = row.canonical_column_ids[entry];
            if (distinct_columns->find(column) == distinct_columns->end() &&
                    distinct_columns->size() ==
                        ConservativeConstraintRank::kMaximumDistinctColumns) {
                throw ConstraintRankResourceLimitExceeded(
                    "constraint distinct-column cap exceeded");
            }
            distinct_columns->insert(column);
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
    ConservativeConstraintRank::ValidateResourceCounts(counts);
    return counts;
}

bool is_anchor_candidate(const ConservativeConstraintRankRow &row)
{
    return row.kind ==
            ConservativeConstraintRankRowKind::ClosedComponentDivergence &&
        row.row_element_key == row.closed_component_anchor_element;
}

} // namespace

#ifdef FULLMAG_CONSTRAINT_RANK_TESTING
namespace testing {

void SetConstraintRankAnalyzeResourceLimitsForTest(
    const ResourceCounts &limits)
{
    ConservativeConstraintRank::ValidateResourceCounts(limits);
    analyze_resource_limits = limits;
}

void ResetConstraintRankAnalyzeResourceLimitsForTest()
{
    analyze_resource_limits = maximum_resource_counts();
}

} // namespace testing
#endif

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
    ResourceBudget budget(initial_counts, current_analyze_resource_limits());
    std::map<std::uint64_t, std::size_t> column_index;
    std::size_t next_column = 0;
    for (const auto column : distinct_columns) {
        budget.add_work(1);
        column_index.emplace(column, next_column++);
    }

    std::vector<std::size_t> processing_order(rows.size());
    for (std::size_t index = 0; index < rows.size(); ++index) {
        budget.add_work(1);
        processing_order[index] = index;
    }
    std::uint64_t sort_levels = 0;
    for (std::size_t width = 1; width < processing_order.size();) {
        ++sort_levels;
        if (width > processing_order.size() / 2) {
            break;
        }
        width *= 2;
    }
    budget.add_work(checked_multiply(
        static_cast<std::uint64_t>(processing_order.size()),
        checked_add(sort_levels, 1, "processing-order sort levels"),
        "processing-order sort work"));
    std::sort(processing_order.begin(), processing_order.end(),
        [&](std::size_t left, std::size_t right) {
            return std::make_tuple(is_anchor_candidate(rows[left]),
                       rows[left].constraint_id) <
                std::make_tuple(is_anchor_candidate(rows[right]),
                       rows[right].constraint_id);
        });

    ConstraintRankCertificate certificate;
    certificate.rows_before = static_cast<std::uint64_t>(rows.size());
    std::vector<BareissBasisRow> basis;
    ExactStateSize persistent_state;
    for (const auto row_index : processing_order) {
        auto row = make_bareiss_row(rows[row_index], column_index, &budget);
        ExactStateSize row_state;
        const BigInteger final_pivot = reduce_bareiss_row(
            &row, basis, persistent_state, &budget, &row_state);
        if (!row.coefficients.empty()) {
            if (is_anchor_candidate(rows[row_index])) {
                throw std::runtime_error(
                    "closed-component anchor candidate is independent");
            }
            row.pivot = row.coefficients.begin()->first;
            persistent_state = combine_sizes(persistent_state, row_state);
            budget.observe_exact_state(persistent_state.nonzeros,
                persistent_state.storage_bits,
                persistent_state.maximum_bit_length);
            basis.push_back(std::move(row));
            continue;
        }
        if (rows[row_index].kind ==
                    ConservativeConstraintRankRowKind::ClosedComponentDivergence &&
                !is_anchor_candidate(rows[row_index])) {
            throw std::runtime_error(
                "closed-component non-candidate row is dependent");
        }

        ExactRational residual = row.rhs;
        const auto exact_base = combine_sizes(persistent_state, row_state);
        if (!basis.empty()) {
            residual = divide_rational_integer(
                residual, final_pivot, &budget, exact_base);
        }
        observe_rational_temporary(&budget, exact_base, residual);
        const ExactRational authored_rhs = exact_binary64(rows[row_index].rhs_a);
        const ExactRational absolute_gate =
            exact_binary64(physical_absolute_gate_a);
        const ExactRational relative_gate =
            exact_binary64(physical_relative_gate);
        const ExactRational rhs_floor = exact_binary64(1.0e-30);
        const ExactRational rhs_scale = std::max(
            rational_abs(authored_rhs), rhs_floor);
        const ExactRational relative_bound = multiply_rationals(
            relative_gate, rhs_scale, &budget, exact_base);
        observe_rational_temporaries(&budget, exact_base,
            {&authored_rhs, &absolute_gate, &relative_gate,
                &rhs_floor, &rhs_scale, &relative_bound});
        const ExactRational gate = std::max(absolute_gate, relative_bound);
        const double residual_a =
            rational_to_binary64(residual, &budget, exact_base);
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
    certificate.rank = static_cast<std::uint64_t>(basis.size());
    std::sort(certificate.omitted_rows.begin(),
        certificate.omitted_rows.end(),
        [](const auto &left, const auto &right) {
            return left.constraint_id < right.constraint_id;
        });
    return certificate;
}

} // namespace fullmag::fem::transport
