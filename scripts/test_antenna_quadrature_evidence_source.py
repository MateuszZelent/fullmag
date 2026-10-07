"""Independent wire/binary64 models and source wiring, NOT Rust/native execution."""
from decimal import Decimal, localcontext
import math
from pathlib import Path
import struct
import unittest

ROOT = Path(__file__).resolve().parents[1]
MAGIC = b"FM-OEF1-Q3-V1\0\0\0"
HEADER = struct.Struct("<16s64s64s12Q6d")
RECORD = struct.Struct("<9d3Q")


def bits(value):
    return struct.pack("<d", value)


def fused_tolerance(norm):
    with localcontext() as ctx:
        ctx.prec = 200
        return float(Decimal.from_float(1e-5) * Decimal.from_float(norm) + Decimal.from_float(1e-9))


def wire_example():
    row = RECORD.pack(0.0, -0.0, 2.0, 0.5, -0.0, 0.0, 0.0, fused_tolerance(0.5), 0.0, 1, 4, 1)
    return HEADER.pack(MAGIC, b"a" * 64, b"b" * 64,
                       12, 12, 0, 0, 48, 12, 4, 6, 1000000, 1000000, 100000000, 100000000,
                       0.0, 1e-9, 1e-5, 0.0, 3.0, 1.0 / 3.0) + row * 12


def independent_decode(data):
    if len(data) < HEADER.size:
        raise ValueError("header")
    magic, source, balance, *fields = HEADER.unpack_from(data)
    ints, reals = fields[:12], fields[12:]
    n, pairs, refinements, unconverged, kernels, visits, order, depth, cap_pairs, cap_leaf, cap_kernel, cap_visit = ints
    maximum_error, atol, rtol, floor, current, scale = reals
    if magic != MAGIC or not 1 <= n <= 1000000 or len(data) != 288 + 96 * n:
        raise ValueError("format/bound")
    if any(len(d) != 64 or any(b not in b"0123456789abcdef" for b in d) for d in (source, balance)):
        raise ValueError("digest")
    if (order, depth, cap_pairs, cap_leaf, cap_kernel, cap_visit) != (4, 6, 1000000, 1000000, 100000000, 100000000):
        raise ValueError("options/caps")
    if bits(atol) != bits(1e-9) or bits(rtol) != bits(1e-5) or bits(floor) != bits(0.0):
        raise ValueError("options")
    if not math.isfinite(current) or current <= 1e-30 or not math.isfinite(scale) or bits(scale) != bits(1.0 / current):
        raise ValueError("normalization")
    if not math.isfinite(maximum_error) or maximum_error < 0 or unconverged or not 1 <= pairs <= cap_pairs or pairs % n:
        raise ValueError("roots/convergence")
    sources = pairs // n
    rows, sums = [], [0, 0, 0]
    for offset in range(288, len(data), 96):
        row = RECORD.unpack_from(data, offset)
        xyz, raw, error, tolerance, roundoff, leaves, kernel, visit = row[:3], row[3:6], *row[6:]
        expected = fused_tolerance(math.hypot(math.hypot(raw[0], raw[1]), raw[2]))
        if any(not math.isfinite(v) for v in xyz + raw + (error, tolerance, roundoff)) or min(error, tolerance, roundoff) < 0:
            raise ValueError("finite")
        larger, smaller = max(error, roundoff), min(error, roundoff)
        total = larger + smaller
        residual = smaller - (total - larger)
        if bits(tolerance) != bits(expected) or not (total < tolerance or total == tolerance and residual <= 0):
            raise ValueError("E+R gate")
        if not sources <= leaves <= min(cap_leaf, sources * 8 ** depth) or (leaves - sources) % 7 or min(kernel, visit) < leaves:
            raise ValueError("leaf/work")
        sums = [a + b for a, b in zip(sums, (leaves, kernel, visit))]
        if max(sums) > 2**64 - 1:
            raise ValueError("overflow")
        rows.append(row)
    if sums != [pairs + 7 * refinements, kernels, visits] or kernels > cap_kernel or visits > cap_visit:
        raise ValueError("aggregate")
    return rows, current, scale


class EvidenceSourceTests(unittest.TestCase):
    def test_wire_layout_and_nonunit_current_raw_bits(self):
        self.assertEqual((HEADER.size, RECORD.size), (288, 96))
        rows, current, scale = independent_decode(wire_example())
        self.assertEqual((len(rows), current, scale), (12, 3.0, 1.0 / 3.0))
        self.assertEqual(bits(rows[0][4] * scale), bits(-0.0))
        self.assertNotEqual(bits(rows[0][4] * scale), bits(0.0))

    def test_bounds_truncation_trailing_and_future_magic(self):
        data = wire_example()
        for candidate in (data[:15], data[:287], data[:-1], data + b"x", b"X" + data[1:]):
            with self.subTest(length=len(candidate)), self.assertRaises(ValueError):
                independent_decode(candidate)
        for count in (0, 1000001, 2**64 - 1):
            candidate = bytearray(data)
            struct.pack_into("<Q", candidate, 144, count)
            with self.subTest(count=count), self.assertRaises(ValueError):
                independent_decode(candidate)

    def test_numeric_refusals_are_independent_of_rehash(self):
        data = wire_example()
        for offset, value in ((168, 1), (176, 49), (192, 2**64 - 1), (208, 1000001),
                              (288 + 72, 2), (288 + 80, 0)):
            candidate = bytearray(data)
            struct.pack_into("<Q", candidate, offset, value)
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                independent_decode(candidate)
        for offset, value in ((264, -0.0), (280, 1.0), (288 + 48, 1.0), (288 + 56, 1.0), (288, float("nan"))):
            candidate = bytearray(data)
            struct.pack_into("<d", candidate, offset, value)
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                independent_decode(candidate)

    def test_positive_subulp_roundoff_refused_at_equality(self):
        candidate = bytearray(wire_example())
        tolerance = fused_tolerance(0.5)
        struct.pack_into("<d", candidate, 288 + 48, tolerance)
        struct.pack_into("<d", candidate, 288 + 64, math.ulp(tolerance) / 4)
        with self.assertRaises(ValueError):
            independent_decode(candidate)

    def test_production_source_uses_shared_gate_and_explicit_binary_codec(self):
        codec = (ROOT / "crates/fullmag-runner/src/antenna_field_solution/direct_quadrature.rs").read_text()
        compact = "".join(codec.split())
        asset = (ROOT / "crates/fullmag-runner/src/antenna_field_solution.rs").read_text()
        native = (ROOT / "crates/fullmag-runner/src/native_fem/steady_transport/direct_oersted_snapshot.rs").read_text()
        producer = (ROOT / "crates/fullmag-runner/src/native_fem/charge_transport.rs").read_text()
        for token in ("to_le_bytes", "from_le_bytes", "try_reserve_exact", "checked_mul(RECORD_BYTES)",
                      "target_error_fits", "mul_add", "checked_mul(7)", "verify_binding", "to_bits()"):
            self.assertIn(token, compact)
        self.assertLess(compact.index("targetboundorexactbinarylength"), compact.index("targets.try_reserve_exact"))
        self.assertNotIn("transmute", codec)
        self.assertIn("snapshot.validate()?", native)
        self.assertEqual(asset.count("verify_antenna_field_solution_referenced_data(manifest_bytes, payloads)?"), 2)
        self.assertIn("verify_antenna_field_solution_asset(&manifest_bytes, &artifacts)?", asset)
        self.assertIn("verify_basis_quadrature(&manifest, basis, payloads)?", asset)
        self.assertIn("direct_quadrature_snapshot: rt0.oersted_quadrature_snapshot.clone()", producer)
        self.assertIn("quadrature_evidence: data.evidence.as_ref()", asset)
        self.assertIn("cannot publish direct v3 antenna basis without full native snapshot", asset)


if __name__ == "__main__":
    unittest.main()
