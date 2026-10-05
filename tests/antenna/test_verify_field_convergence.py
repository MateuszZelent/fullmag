import hashlib
import json
import math
import struct
import tempfile
import unittest
from pathlib import Path

from tests.antenna.verify_field_convergence import finite_wire_field, read_solution, verify


def write_solution(root, scale, *, unconverged=0, position=(1.0, 0.0, 0.0), asset_id=None):
    prefix = Path("antenna") / "field_solutions" / "wire"
    directory = root / prefix
    if asset_id is not None:
        directory /= asset_id
    directory.mkdir(parents=True, exist_ok=True)
    reference, _ = finite_wire_field((0.0, 0.0, -1.0), (0.0, 0.0, 1.0), position)

    def payload(name, values, unit):
        path = directory / name
        data = struct.pack(f"<{len(values)}d", *values)
        path.write_bytes(data)
        return {"path": (prefix / name).as_posix(),
                "sha256": hashlib.sha256(data).hexdigest(),
                "scalar_type": "float64_le", "layout": "sample_xyz_interleaved",
                "unit": unit, "value_count": len(values)}

    manifest = {
        "schema_version": "antenna_field_solution.v1",
        "status": "ready",
        "solution_id": "wire",
        "asset_id": asset_id or "legacy-asset",
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
    def test_revisioned_manifest_reads_its_own_payloads(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_solution(root, 2.0)
            write_solution(root, 3.0, asset_id="older")
            manifest = write_solution(root, 1.0, asset_id="current")
            positions, field = read_solution(manifest, "wire-port")
            reference, _ = finite_wire_field((0, 0, -1), (0, 0, 1), positions[0])
            self.assertEqual(field, [reference])

    def test_revisioned_three_levels(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifests = [write_solution(root, scale, asset_id=name) for name, scale in
                         (("coarse", 1.2), ("medium", 1.1), ("fine", 1.01))]
            result = verify(manifests, "wire-port", (0, 0, -1), (0, 0, 1), 0.5, 0.02, 0.02)
            self.assertAlmostEqual(result["levels"][2]["l2_relative"], 0.01)

    def test_missing_revision_payload_never_falls_back(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_solution(root, 1.0)
            write_solution(root, 1.0, asset_id="older")
            manifest = write_solution(root, 1.0, asset_id="current")
            (manifest.parent / "H_per_A.f64le").unlink()
            with self.assertRaises(FileNotFoundError):
                read_solution(manifest, "wire-port")

    def test_rejects_manifest_identity_mismatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for asset_id, key, value in ((None, "solution_id", "other"),
                                         ("current", "solution_id", "other"),
                                         ("current", "asset_id", "older"),
                                         (None, "asset_id", "../escape"),
                                         (None, "solution_id", None)):
                with self.subTest(asset_id=asset_id, key=key, value=value):
                    path = write_solution(root, 1.0, asset_id=asset_id)
                    manifest = json.loads(path.read_text(encoding="utf-8"))
                    manifest[key] = value
                    path.write_text(json.dumps(manifest), encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, "identity"):
                        read_solution(path, "wire-port")

    def test_rejects_noncanonical_payload_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for relative in ("antenna/field_solutions/other/sample_positions.f64le",
                             "antenna/field_solutions/wire/../wire/sample_positions.f64le",
                             "antenna/field_solutions/wire/./sample_positions.f64le",
                             "antenna//field_solutions/wire/sample_positions.f64le",
                             "antenna\\field_solutions\\wire\\sample_positions.f64le",
                             "C:/sample_positions.f64le", "C:sample_positions.f64le",
                             "//server/share/sample_positions.f64le",
                             str(root / "antenna/field_solutions/wire/sample_positions.f64le")):
                with self.subTest(path=relative):
                    path = write_solution(root, 1.0)
                    manifest = json.loads(path.read_text(encoding="utf-8"))
                    manifest["sample_positions"]["path"] = relative
                    path.write_text(json.dumps(manifest), encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, "payload path"):
                        read_solution(path, "wire-port")

    def test_rejects_payload_symlink_to_legacy(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            legacy = write_solution(root, 1.0)
            manifest = write_solution(root, 1.0, asset_id="current")
            path = manifest.parent / "H_per_A.f64le"
            path.unlink()
            try:
                path.symlink_to(legacy.parent / path.name)
            except OSError as error:
                self.skipTest(f"host does not permit symlinks: {error}")
            with self.assertRaisesRegex(ValueError, "payload path"):
                read_solution(manifest, "wire-port")

    def test_rejects_noncanonical_manifest_location(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = write_solution(root, 1.0)
            for path in (original.with_name("other.json"), root / "manifest.v1.json"):
                with self.subTest(path=path):
                    path.write_bytes(original.read_bytes())
                    with self.assertRaisesRegex(ValueError, "manifest"):
                        read_solution(path, "wire-port")

    def test_revision_keeps_payload_integrity_checks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for key, value, error in (("unit", "T", "type, layout, or unit"),
                                       ("layout", "xyz_sample", "type, layout, or unit"),
                                       ("scalar_type", "float32_le", "type, layout, or unit"),
                                       ("value_count", 6, "payload length"),
                                       ("value_count", 0, "payload length"),
                                       ("sha256", "0" * 64, "hash mismatch")):
                with self.subTest(key=key):
                    path = write_solution(root, 1.0, asset_id="current")
                    manifest = json.loads(path.read_text(encoding="utf-8"))
                    manifest["bases"][0]["magnetic_field_per_ampere"][key] = value
                    path.write_text(json.dumps(manifest), encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, error):
                        read_solution(path, "wire-port")
            path = write_solution(root, 1.0, asset_id="current")
            manifest = json.loads(path.read_text(encoding="utf-8"))
            data = struct.pack("<3d", 0.0, math.nan, 0.0)
            (path.parent / "H_per_A.f64le").write_bytes(data)
            manifest["bases"][0]["magnetic_field_per_ampere"]["sha256"] = hashlib.sha256(data).hexdigest()
            path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "non-finite"):
                read_solution(path, "wire-port")

    def test_revision_keeps_basis_and_quadrature_checks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for key, value, error in (("normalization_current_a", 2.0, "normalized to 1 A"),
                                       ("quadrature_diagnostics", None, "quadrature certificate")):
                with self.subTest(key=key):
                    path = write_solution(root, 1.0, asset_id="current")
                    manifest = json.loads(path.read_text(encoding="utf-8"))
                    manifest["bases"][0][key] = value
                    path.write_text(json.dumps(manifest), encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, error):
                        read_solution(path, "wire-port")
            path = write_solution(root, 1.0, unconverged=1, asset_id="current")
            with self.assertRaisesRegex(ValueError, "quadrature certificate"):
                read_solution(path, "wire-port")

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
