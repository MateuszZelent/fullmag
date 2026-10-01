import hashlib
import json
import math
import struct
import tempfile
import unittest
from pathlib import Path

from tests.antenna.verify_field_convergence import finite_wire_field, read_solution, verify


def write_solution(root, scale, *, unconverged=0, position=(1.0, 0.0, 0.0)):
    directory = root / "antenna" / "field_solutions" / "wire"
    directory.mkdir(parents=True, exist_ok=True)
    reference, _ = finite_wire_field((0.0, 0.0, -1.0), (0.0, 0.0, 1.0), position)

    def payload(name, values, unit):
        path = directory / name
        data = struct.pack(f"<{len(values)}d", *values)
        path.write_bytes(data)
        return {"path": str(path.relative_to(root)).replace("\\", "/"),
                "sha256": hashlib.sha256(data).hexdigest(),
                "scalar_type": "float64_le", "layout": "sample_xyz_interleaved",
                "unit": unit, "value_count": len(values)}

    manifest = {
        "schema_version": "antenna_field_solution.v1",
        "status": "ready",
        "sample_positions": payload("sample_positions.f64le", position, "m"),
        "bases": [{"port_mode_id": "wire-port", "normalization_current_a": 1.0,
                   "quadrature_diagnostics": {
                       "schema_version": "fem_oersted_direct_tetra_quadrature.v1",
                       "unconverged_pair_count": unconverged,
                       "maximum_pair_error_apm": 0.0},
                   "magnetic_field_per_ampere": payload(
                       "H_per_A.f64le", [value * scale for value in reference], "A/m/A")}]}
    path = directory / "manifest.v1.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    return path


class FieldConvergenceTests(unittest.TestCase):
    def test_finite_wire_sign_scale_and_far_field(self):
        field, radius = finite_wire_field((0, 0, -1), (0, 0, 1), (1, 0, 0))
        self.assertEqual(radius, 1.0)
        self.assertAlmostEqual(field[1], 1 / (2 * math.pi * math.sqrt(2)))
        self.assertEqual(field[0], 0.0)
        self.assertEqual(field[2], 0.0)
        reversed_field, _ = finite_wire_field((0, 0, 1), (0, 0, -1), (1, 0, 0))
        self.assertAlmostEqual(reversed_field[1], -field[1])

    def test_three_published_levels_are_compared_at_same_points(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifests = [write_solution(root / name, scale) for name, scale in
                         (("coarse", 1.2), ("medium", 1.1), ("fine", 1.01))]
            result = verify(manifests, "wire-port", (0, 0, -1), (0, 0, 1), 0.5, 0.02, 0.02)
            self.assertEqual(result["status"], "pass")
            self.assertAlmostEqual(result["levels"][2]["l2_relative"], 0.01)
            with self.assertRaisesRegex(ValueError, "requested tolerance"):
                verify(manifests, "wire-port", (0, 0, -1), (0, 0, 1), 0.5, 0.005, 0.02)

    def test_rejects_corrupt_or_unconverged_asset(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = write_solution(root, 1.0, unconverged=1)
            with self.assertRaisesRegex(ValueError, "converged quadrature"):
                read_solution(manifest, "wire-port")
            manifest = write_solution(root, 1.0)
            payload = manifest.parent / "H_per_A.f64le"
            payload.write_bytes(b"bad")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                read_solution(manifest, "wire-port")

    def test_rejects_changed_sample_locations(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifests = [write_solution(root / name, 1.0 + error, position=point)
                         for name, error, point in (("coarse", 0.2, (1.0, 0.0, 0.0)),
                                                    ("medium", 0.1, (1.1, 0.0, 0.0)),
                                                    ("fine", 0.01, (1.0, 0.0, 0.0)))]
            with self.assertRaisesRegex(ValueError, "identical physical sample positions"):
                verify(manifests, "wire-port", (0, 0, -1), (0, 0, 1), 0.5, 0.02, 0.02)


if __name__ == "__main__":
    unittest.main()
