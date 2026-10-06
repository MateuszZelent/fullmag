"""Independent cold OE-F1 reader; does not import producer or source-test models."""

import math
import re
import struct
from fractions import Fraction

OPERATOR = "fem_oersted_direct_tetra_quadrature.v3"
SCHEMA = "fem_direct_oersted_evidence.v1"
HEADER = struct.Struct("<16s64s64s12Q6d")
RECORD = struct.Struct("<9d3Q")
MAX_TARGETS = 1_000_000
MAX_BYTES = HEADER.size + RECORD.size * MAX_TARGETS
U64_MAX = 2**64 - 1


def bits(value):
    if type(value) not in (float, int) or not math.isfinite(value):
        raise ValueError("evidence requires finite numeric values")
    return struct.pack("<d", value)


def digest(value):
    return isinstance(value, str) and re.fullmatch("[0-9a-f]{64}", value) is not None


def exact_tolerance(raw):
    norm = math.hypot(math.hypot(raw[0], raw[1]), raw[2])
    if not math.isfinite(norm):
        raise ValueError("evidence norm is non-finite")
    # Exact binary64 operands, one final nearest-even rounding, no decimal guess.
    return float(Fraction(1e-5) * Fraction(norm) + Fraction(1e-9))


def verify_direct_evidence(data, basis, positions, per_ampere):
    if len(data) < HEADER.size or len(data) > MAX_BYTES:
        raise ValueError("evidence header/size bound")
    magic, source_bytes, balance_bytes, *values = HEADER.unpack_from(data)
    integers, reals = values[:12], values[12:]
    n, roots, refinements, unconverged, kernels, visits, order, depth, *caps = integers
    maximum_error, atol, rtol, floor, current, scale = reals
    if (magic != b"FM-OEF1-Q3-V1\0\0\0" or not 1 <= n <= MAX_TARGETS
            or len(data) != HEADER.size + RECORD.size * n):
        raise ValueError("evidence magic/count/exact length")
    try:
        source = source_bytes.decode("ascii")
        balance = balance_bytes.decode("ascii")
    except UnicodeDecodeError as error:
        raise ValueError("evidence digest encoding") from error
    if not digest(source) or not digest(balance):
        raise ValueError("evidence source/balance digest")
    if (order, depth, *caps) != (4, 6, 1_000_000, 1_000_000, 100_000_000, 100_000_000):
        raise ValueError("evidence options/caps")
    if (bits(atol), bits(rtol), bits(floor)) != (bits(1e-9), bits(1e-5), bits(0.0)):
        raise ValueError("evidence tolerance/floor options")
    if (not math.isfinite(current) or current <= 1e-30 or not math.isfinite(scale)
            or bits(scale) != bits(1.0 / current)):
        raise ValueError("evidence measured current/scale")
    if (bits(basis.get("measured_positive_terminal_current_a")) != bits(current)
            or bits(basis.get("normalization_scale")) != bits(scale)
            or bits(basis.get("normalization_current_a")) != bits(1.0)
            or basis.get("current_balance_certificate_digest") != balance):
        raise ValueError("evidence manifest normalization/balance binding")
    if (not math.isfinite(maximum_error) or maximum_error < 0 or unconverged
            or not 1 <= roots <= caps[0] or roots % n):
        raise ValueError("evidence roots/convergence")
    names = ("target_count", "source_target_pairs", "refined_pairs", "unconverged_pair_count",
             "kernel_evaluations", "ledger_leaf_visits", "base_quadrature_order",
             "maximum_subdivision_depth", "maximum_source_target_pairs",
             "maximum_final_leaves_per_target", "maximum_kernel_evaluations", "maximum_ledger_leaf_visits")
    float_names = ("maximum_pair_error_apm", "absolute_tolerance_apm", "relative_tolerance",
                   "relative_scale_floor_apm")
    expected = dict(zip(names, integers))
    expected.update(zip(float_names, reals[:4]))
    expected.update(schema_version=OPERATOR, operator_version=OPERATOR,
                    source_view_identity_digest=source, quadrature_scope="global_target",
                    estimated_error_policy="sum_final_leaf_l2_difference.v1",
                    roundoff_indicator_policy="weighted_terms_binary64_epsilon.v1")
    summary = basis.get("quadrature_diagnostics")
    if (basis.get("oersted_operator_version") != OPERATOR or summary != expected
            or any(type(summary[name]) is not int for name in names)
            or any(bits(summary[name]) != bits(expected[name]) for name in float_names)):
        raise ValueError("evidence thin summary/operator binding")
    if len(positions) != n or len(per_ampere) != n:
        raise ValueError("evidence carrier count")
    sources, sums = roots // n, [0, 0, 0]
    for index in range(n):
        row = RECORD.unpack_from(data, HEADER.size + index * RECORD.size)
        xyz, raw = row[:3], row[3:6]
        error, tolerance, roundoff = row[6:9]
        leaves, kernel, visit = row[9:]
        if (any(not math.isfinite(value) for value in row[:9])
                or min(error, tolerance, roundoff) < 0):
            raise ValueError("evidence non-finite or negative target")
        if (bits(tolerance) != bits(exact_tolerance(raw))
                or Fraction(error) + Fraction(roundoff) > Fraction(tolerance)):
            raise ValueError("evidence target E+R/tau acceptance")
        if (not sources <= leaves <= min(caps[1], sources * 8**depth)
                or (leaves - sources) % 7 or min(kernel, visit) < leaves):
            raise ValueError("evidence target leaf/work counts")
        sums = [a + b for a, b in zip(sums, (leaves, kernel, visit))]
        if any(value > U64_MAX for value in sums):
            raise ValueError("evidence aggregate overflow")
        if (any(bits(xyz[c]) != bits(positions[index][c]) for c in range(3))
                or any(bits(raw[c] * scale) != bits(per_ampere[index][c]) for c in range(3))):
            raise ValueError("evidence ordered xyz/raw to per-A binding")
    expected_leaves = roots + 7 * refinements
    if (expected_leaves > U64_MAX or sums != [expected_leaves, kernels, visits]
            or kernels > caps[2] or visits > caps[3]):
        raise ValueError("evidence global work/refinement conservation")
    return "global_target_v3_evidence_checked"
