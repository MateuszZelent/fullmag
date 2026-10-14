"""Independent exact-fraction oracle for guarded complex modal norms.

The source-only checks in this module verify an interval-arithmetic method.
Finite input floats are treated as exact binary rationals. The interval
implementation uses outward nextafter expansion and consumes sparse entries
directly, including duplicate matrix entries. This module does not execute
Rust, a native backend, or a managed runner.
"""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
import math
import random
import unittest


def _finite_float(value: float) -> float:
    value = float(value)
    if not math.isfinite(value):
        raise ValueError("source inputs must be finite floats")
    return value


def _round_down(value: float) -> float:
    return math.nextafter(value, -math.inf)


def _round_up(value: float) -> float:
    return math.nextafter(value, math.inf)


@dataclass(frozen=True)
class Interval:
    """Closed float interval; infinities are allowed for rejection tests."""

    lower: float
    upper: float

    def __post_init__(self) -> None:
        if math.isnan(self.lower) or math.isnan(self.upper):
            raise ValueError("NaN is not an interval endpoint")
        if self.lower > self.upper:
            raise ValueError("interval endpoints are reversed")

    @classmethod
    def point(cls, value: float) -> "Interval":
        return cls(_finite_float(value), _finite_float(value))

    def is_exact_zero(self) -> bool:
        return self.lower == 0.0 and self.upper == 0.0


def interval_neg(value: Interval) -> Interval:
    return Interval(-value.upper, -value.lower)


def interval_add(left: Interval, right: Interval) -> Interval:
    # Exact structural zeros can be skipped without losing enclosure.
    if left.is_exact_zero():
        return right
    if right.is_exact_zero():
        return left
    return Interval(
        _round_down(left.lower + right.lower),
        _round_up(left.upper + right.upper),
    )


def interval_sub(left: Interval, right: Interval) -> Interval:
    # Exact structural zeros can be skipped without losing enclosure.
    if right.is_exact_zero():
        return left
    if left.is_exact_zero():
        return interval_neg(right)
    return Interval(
        _round_down(left.lower - right.upper),
        _round_up(left.upper - right.lower),
    )


def interval_mul(left: Interval, right: Interval) -> Interval:
    # This is the four-endpoint min/max product with outward expansion.
    if left.is_exact_zero() or right.is_exact_zero():
        return Interval.point(0.0)
    products = (
        left.lower * right.lower,
        left.lower * right.upper,
        left.upper * right.lower,
        left.upper * right.upper,
    )
    if any(math.isnan(product) for product in products):
        return Interval(-math.inf, math.inf)
    return Interval(_round_down(min(products)), _round_up(max(products)))


@dataclass(frozen=True)
class ComplexInterval:
    real: Interval
    imag: Interval

    @classmethod
    def point(cls, value: tuple[float, float]) -> "ComplexInterval":
        return cls(Interval.point(value[0]), Interval.point(value[1]))

    @classmethod
    def zero(cls) -> "ComplexInterval":
        return cls(Interval.point(0.0), Interval.point(0.0))

    def is_exact_zero(self) -> bool:
        return self.real.is_exact_zero() and self.imag.is_exact_zero()


def complex_interval_add(
    left: ComplexInterval, right: ComplexInterval
) -> ComplexInterval:
    if left.is_exact_zero():
        return right
    if right.is_exact_zero():
        return left
    return ComplexInterval(
        interval_add(left.real, right.real),
        interval_add(left.imag, right.imag),
    )


def complex_interval_conjugate(value: ComplexInterval) -> ComplexInterval:
    return ComplexInterval(value.real, interval_neg(value.imag))


def complex_interval_mul(
    left: ComplexInterval, right: ComplexInterval
) -> ComplexInterval:
    # The whole product is structurally zero when either complex factor is.
    if left.is_exact_zero() or right.is_exact_zero():
        return ComplexInterval.zero()
    real = interval_sub(
        interval_mul(left.real, right.real),
        interval_mul(left.imag, right.imag),
    )
    imag = interval_add(
        interval_mul(left.real, right.imag),
        interval_mul(left.imag, right.real),
    )
    return ComplexInterval(real, imag)


@dataclass(frozen=True)
class FractionComplex:
    real: Fraction
    imag: Fraction


FRACTION_ZERO = FractionComplex(Fraction(0), Fraction(0))


def fraction_point(value: tuple[float, float]) -> FractionComplex:
    real = _finite_float(value[0])
    imag = _finite_float(value[1])
    return FractionComplex(Fraction.from_float(real), Fraction.from_float(imag))


def fraction_add(left: FractionComplex, right: FractionComplex) -> FractionComplex:
    return FractionComplex(left.real + right.real, left.imag + right.imag)


def fraction_conjugate(value: FractionComplex) -> FractionComplex:
    return FractionComplex(value.real, -value.imag)


def fraction_mul(left: FractionComplex, right: FractionComplex) -> FractionComplex:
    return FractionComplex(
        left.real * right.real - left.imag * right.imag,
        left.real * right.imag + left.imag * right.real,
    )


@dataclass(frozen=True)
class SparseEntry:
    row: int
    column: int
    real: float
    imag: float

    def __post_init__(self) -> None:
        _finite_float(self.real)
        _finite_float(self.imag)


def exact_fraction_sparse_q(
    q: tuple[tuple[float, float], ...],
    entries,
) -> FractionComplex:
    """Exact Fraction Q; the iterator may contain duplicate entries."""

    q_fraction = [fraction_point(value) for value in q]
    result = FRACTION_ZERO
    for entry in entries:
        if not 0 <= entry.row < len(q) or not 0 <= entry.column < len(q):
            raise IndexError("sparse entry is outside q")
        matrix_value = FractionComplex(
            Fraction.from_float(entry.real),
            Fraction.from_float(entry.imag),
        )
        term = fraction_mul(
            fraction_mul(
                fraction_conjugate(q_fraction[entry.row]),
                matrix_value,
            ),
            q_fraction[entry.column],
        )
        result = fraction_add(result, term)
    return result


def outward_interval_sparse_q(
    q: tuple[tuple[float, float], ...],
    entries,
) -> ComplexInterval:
    """Compute Q in O(number of sparse entries), without a dense matrix."""

    q_intervals = [ComplexInterval.point(value) for value in q]
    result = ComplexInterval.zero()
    for entry in entries:
        if not 0 <= entry.row < len(q) or not 0 <= entry.column < len(q):
            raise IndexError("sparse entry is outside q")
        matrix_value = ComplexInterval.point((entry.real, entry.imag))
        term = complex_interval_mul(
            complex_interval_mul(
                complex_interval_conjugate(q_intervals[entry.row]),
                matrix_value,
            ),
            q_intervals[entry.column],
        )
        result = complex_interval_add(result, term)
    return result


def _fraction_below_float(value: Fraction, endpoint: float) -> bool:
    return endpoint == math.inf or (
        endpoint != -math.inf and value <= Fraction.from_float(endpoint)
    )


def _fraction_above_float(value: Fraction, endpoint: float) -> bool:
    return endpoint == -math.inf or (
        endpoint != math.inf and Fraction.from_float(endpoint) <= value
    )


def interval_contains_fraction(
    interval: Interval, value: Fraction
) -> bool:
    return _fraction_below_float(value, interval.upper) and _fraction_above_float(
        value, interval.lower
    )


def complex_interval_contains_fraction(
    interval: ComplexInterval, value: FractionComplex
) -> bool:
    return interval_contains_fraction(interval.real, value.real) and interval_contains_fraction(
        interval.imag, value.imag
    )


class NormGuardError(ValueError):
    """The interval cannot certify a positive real Hermitian norm."""


def guard_positive_norm(
    q_interval: ComplexInterval,
    computed_re: float,
) -> float:
    """Guard a scalar norm before taking its square root."""

    endpoints = (
        q_interval.real.lower,
        q_interval.real.upper,
        q_interval.imag.lower,
        q_interval.imag.upper,
    )
    if not all(math.isfinite(endpoint) for endpoint in endpoints):
        raise NormGuardError("non-finite interval endpoint")
    if q_interval.real.lower <= 0.0:
        raise NormGuardError("real interval does not certify positivity")
    if not q_interval.imag.lower <= 0.0 <= q_interval.imag.upper:
        raise NormGuardError("imaginary interval does not contain zero")
    if not math.isfinite(computed_re) or computed_re <= 0.0:
        raise NormGuardError("computed real norm is not positive finite")
    return math.sqrt(computed_re)


# The tests below are deliberately independent of any Rust/native execution.
# A dense reference is used only by a test; the production oracle above never
# materializes a matrix.


def exact_fraction_dense_q(
    matrix: tuple[tuple[tuple[float, float], ...], ...],
    q: tuple[tuple[float, float], ...],
) -> FractionComplex:
    q_fraction = [fraction_point(value) for value in q]
    result = FRACTION_ZERO
    for row, matrix_row in enumerate(matrix):
        for column, matrix_value in enumerate(matrix_row):
            term = fraction_mul(
                fraction_mul(
                    fraction_conjugate(q_fraction[row]),
                    fraction_point(matrix_value),
                ),
                q_fraction[column],
            )
            result = fraction_add(result, term)
    return result


class CountingEntries:
    def __init__(self, entries) -> None:
        self._entries = tuple(entries)
        self.iterations = 0

    def __iter__(self):
        self.iterations += 1
        return iter(self._entries)

    def __len__(self):
        raise AssertionError("sparse oracle must not ask for entry count")


def assert_interval_contains(test: unittest.TestCase, interval, exact) -> None:
    test.assertTrue(
        complex_interval_contains_fraction(interval, exact),
        msg=(
            f"interval {interval!r} does not contain exact "
            f"({exact.real!r}, {exact.imag!r})"
        ),
    )


class ModalNormIntervalOracleTests(unittest.TestCase):
    def test_structural_zero_products_and_sums_are_exact(self):
        zero = ComplexInterval.zero()
        value = ComplexInterval.point((1.25, -2.5))
        self.assertEqual(complex_interval_mul(zero, value), zero)
        self.assertEqual(complex_interval_add(zero, value), value)
        self.assertEqual(interval_mul(Interval.point(0.0), Interval.point(3.0)),
                         Interval.point(0.0))

    def test_strict_known_pd_hermitian_scalar_passes_guard(self):
        entries = (
            SparseEntry(0, 0, 4.0, 0.0),
            SparseEntry(1, 1, 3.0, 0.0),
            SparseEntry(0, 1, 0.5, 0.25),
            SparseEntry(1, 0, 0.5, -0.25),
        )
        q = ((1.0, 0.25), (-0.5, 0.75))
        exact = exact_fraction_sparse_q(q, entries)
        interval = outward_interval_sparse_q(q, entries)
        self.assertEqual(exact.imag, Fraction(0))
        assert_interval_contains(self, interval, exact)
        self.assertGreater(interval.real.lower, 0.0)
        self.assertTrue(interval.imag.lower <= 0.0 <= interval.imag.upper)
        norm = guard_positive_norm(interval, float(exact.real))
        self.assertAlmostEqual(norm, math.sqrt(float(exact.real)), places=15)

    def test_substantial_imaginary_scalar_is_rejected(self):
        entries = (SparseEntry(0, 0, 2.0, 0.5),)
        q = ((1.0, 0.0),)
        exact = exact_fraction_sparse_q(q, entries)
        interval = outward_interval_sparse_q(q, entries)
        assert_interval_contains(self, interval, exact)
        self.assertGreater(interval.imag.lower, 0.0)
        with self.assertRaisesRegex(NormGuardError, "imaginary"):
            guard_positive_norm(interval, float(exact.real))

    def test_catastrophic_cancellation_rejects_uncertain_positive_norm(self):
        large = 1.0e16
        entries = (
            SparseEntry(0, 0, large, 0.0),
            SparseEntry(0, 0, -(large - 2.0), 0.0),
        )
        q = ((1.0, 0.0),)
        exact = exact_fraction_sparse_q(q, entries)
        interval = outward_interval_sparse_q(q, entries)
        self.assertEqual(exact, FractionComplex(Fraction(2), Fraction(0)))
        assert_interval_contains(self, interval, exact)
        self.assertLessEqual(interval.real.lower, 0.0)
        with self.assertRaisesRegex(NormGuardError, "positivity"):
            guard_positive_norm(interval, float(exact.real))

    def test_small_positive_norm_i_1e_minus_40_is_certified(self):
        q = ((1.0e-20, 0.0),)
        entries = (SparseEntry(0, 0, 1.0, 0.0),)
        exact = exact_fraction_sparse_q(q, entries)
        interval = outward_interval_sparse_q(q, entries)
        self.assertGreater(exact.real, 0)
        self.assertAlmostEqual(float(exact.real), 1.0e-40, places=54)
        assert_interval_contains(self, interval, exact)
        self.assertGreater(interval.real.lower, 0.0)
        norm = guard_positive_norm(interval, float(exact.real))
        self.assertAlmostEqual(norm, 1.0e-20, places=34)

    def test_subnormal_product_is_enclosed_by_nextafter(self):
        subnormal_input = math.ldexp(1.0, -538)
        q = ((subnormal_input, 0.0),)
        entries = (SparseEntry(0, 0, 1.0, 0.0),)
        exact = exact_fraction_sparse_q(q, entries)
        interval = outward_interval_sparse_q(q, entries)
        assert_interval_contains(self, interval, exact)
        min_subnormal = math.nextafter(0.0, math.inf)
        self.assertEqual(interval.real.lower, -min_subnormal)
        self.assertEqual(interval.real.upper, min_subnormal)
        with self.assertRaisesRegex(NormGuardError, "positivity"):
            guard_positive_norm(interval, float(exact.real))

    def test_guard_rejects_nonfinite_uncertain_and_nonpositive_computed_real(self):
        with self.assertRaisesRegex(NormGuardError, "non-finite"):
            guard_positive_norm(
                ComplexInterval(
                    Interval(-math.inf, 1.0),
                    Interval(-1.0, 1.0),
                ),
                1.0,
            )
        candidate = ComplexInterval(
            Interval(0.5, 1.5),
            Interval(-1.0e-12, 1.0e-12),
        )
        with self.assertRaisesRegex(NormGuardError, "computed real"):
            guard_positive_norm(candidate, 0.0)
        with self.assertRaisesRegex(NormGuardError, "computed real"):
            guard_positive_norm(candidate, math.nan)
        with self.assertRaisesRegex(NormGuardError, "positivity"):
            guard_positive_norm(
                ComplexInterval(
                    Interval(-1.0e-12, 1.0),
                    Interval(-1.0e-12, 1.0e-12),
                ),
                1.0,
            )

    def test_dense_and_duplicate_sparse_entries_have_same_exact_algebra(self):
        dense = (
            ((2.0, 0.0), (0.25, -0.125)),
            ((0.25, 0.125), (3.0, 0.0)),
        )
        q = ((0.75, -0.5), (-1.25, 0.25))
        duplicate_entries = (
            SparseEntry(0, 0, 1.0, 0.0),
            SparseEntry(0, 0, 1.0, 0.0),
            SparseEntry(0, 1, 0.125, -0.0625),
            SparseEntry(0, 1, 0.125, -0.0625),
            SparseEntry(1, 0, 0.125, 0.0625),
            SparseEntry(1, 0, 0.125, 0.0625),
            SparseEntry(1, 1, 1.5, 0.0),
            SparseEntry(1, 1, 1.5, 0.0),
        )
        dense_exact = exact_fraction_dense_q(dense, q)
        sparse_exact = exact_fraction_sparse_q(q, duplicate_entries)
        self.assertEqual(dense_exact, sparse_exact)
        counted = CountingEntries(duplicate_entries)
        interval = outward_interval_sparse_q(q, counted)
        self.assertEqual(counted.iterations, 1)
        assert_interval_contains(self, interval, dense_exact)

    def test_randomized_bounded_complex_values_have_rational_truth_enclosed(self):
        generator = random.Random(20261003)
        for case in range(128):
            size = 4
            q = tuple(
                (
                    generator.randint(-8, 8) / 8.0,
                    generator.randint(-8, 8) / 8.0,
                )
                for _ in range(size)
            )
            entries = tuple(
                SparseEntry(
                    generator.randrange(size),
                    generator.randrange(size),
                    generator.randint(-16, 16) / 16.0,
                    generator.randint(-16, 16) / 16.0,
                )
                for _ in range(32)
            )
            exact = exact_fraction_sparse_q(q, entries)
            interval = outward_interval_sparse_q(q, entries)
            with self.subTest(case=case):
                assert_interval_contains(self, interval, exact)


if __name__ == "__main__":
    unittest.main()
