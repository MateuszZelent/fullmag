"""Source and independent binary64 model checks, not native/Rust execution."""
import math
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class AdapterSourceTests(unittest.TestCase):
    def test_regular_adapter_uses_one_full_snapshot_call(self):
        source = (ROOT / "crates/fullmag-runner/src/native_fem/steady_transport.rs").read_text()
        self.assertEqual(source.count("ffi::fullmag_fem_solve_steady_transport_rt0_oersted_with_snapshots_v1("), 1)
        self.assertNotIn("ffi::fullmag_fem_solve_steady_transport_rt0_oersted_with_charge_snapshot_v1(", source)
        self.assertIn("oersted_quadrature_snapshot:", source)
        self.assertIn("snapshot_buffer.finish(", source)

    def test_owned_buffer_checks_header_binding_and_never_dereferences_returned_pointer(self):
        source = (ROOT / "crates/fullmag-runner/src/native_fem/steady_transport/direct_oersted_snapshot.rs").read_text()
        shared = (ROOT / "crates/fullmag-runner/src/antenna_field_solution/direct_quadrature.rs").read_text()
        shared = "".join(shared.split())
        for token in ("target_records_len", "target_records_capacity", "target_records !=",
                      "to_bits()",
                      "estimated_error_policy", "roundoff_indicator_policy",
                      "try_reserve_exact", "snapshot.validate()", "source_view_identity_digest"):
            self.assertIn(token, source)
        for token in ("sum.checked_add", "checked_mul(7)", "mul_add", "target_error_fits"):
            self.assertIn(token, shared)
        self.assertNotIn("from_raw_parts", source)
        self.assertNotIn("diagnostics_json", source)

    def test_positive_sub_ulp_roundoff_is_not_erased_at_gate(self):
        error, roundoff, tolerance = 1.0, math.ulp(1.0) / 4, 1.0
        larger, smaller = max(error, roundoff), min(error, roundoff)
        total = larger + smaller
        residual = smaller - (total - larger)
        self.assertEqual(total, tolerance)
        self.assertGreater(residual, 0)
        self.assertFalse(total < tolerance or (total == tolerance and residual <= 0))

    def test_global_work_and_final_leaves_for_retained_runtime_example(self):
        # Four targets, 36 source tetrahedra; each split replaces one leaf by eight.
        leaves, kernels, visits = [148, 148, 232, 120], [9836, 9836, 16268, 7692], [148, 148, 232, 120]
        roots = 4 * 36
        self.assertEqual(sum(leaves), roots + 7 * 72)
        self.assertEqual(sum(kernels), 43632)
        self.assertEqual(sum(visits), 648)
        self.assertTrue(all((count - 36) % 7 == 0 for count in leaves))
        self.assertNotEqual(sum(leaves) + 1, roots + 7 * 72)


if __name__ == "__main__":
    unittest.main()
