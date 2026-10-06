import hashlib
import json
import math
import struct
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

from tests.antenna.verify_field_convergence import finite_wire_field, read_solution, verify


def write_v3_solution(root, scale=1.0, *, current=3.0, asset_id="current"):
    """Synthetic published wire format; not evidence of a native solve."""
    path = write_solution(root, scale, asset_id=asset_id)
    manifest = json.loads(path.read_text(encoding="utf-8"))
    basis = manifest["bases"][0]
    position = struct.unpack("<3d", (path.parent / "sample_positions.f64le").read_bytes())
    raw = tuple(value * current for value in finite_wire_field(
        (0, 0, -1), (0, 0, 1), position)[0])
    raw = tuple(value * scale for value in raw)
    norm = math.hypot(math.hypot(raw[0], raw[1]), raw[2])
    tau = float(Fraction(1e-5) * Fraction(norm) + Fraction(1e-9))
    data = struct.pack("<16s64s64s12Q6d", b"FM-OEF1-Q3-V1\0\0\0", b"a" * 64, b"b" * 64,
                       1, 1, 0, 0, 4, 1, 4, 6, 1000000, 1000000, 100000000, 100000000,
                       0.0, 1e-9, 1e-5, 0.0, current, 1.0 / current)
    data += struct.pack("<9d3Q", *position, *raw, 0.0, tau, 0.0, 1, 4, 1)
    (path.parent / "direct_quadrature.v1.bin").write_bytes(data)
    field = struct.pack("<3d", *(value * (1.0 / current) for value in raw))
    (path.parent / "H_per_A.f64le").write_bytes(field)
    basis["magnetic_field_per_ampere"]["sha256"] = hashlib.sha256(field).hexdigest()
    basis.update(measured_positive_terminal_current_a=current, normalization_scale=1.0 / current,
                 current_balance_certificate_digest="b" * 64,
                 oersted_operator_version="fem_oersted_direct_tetra_quadrature.v3",
                 quadrature_evidence={"schema_version": "fem_direct_oersted_evidence.v1",
                    "path": "antenna/field_solutions/wire/direct_quadrature.v1.bin",
                    "sha256": hashlib.sha256(data).hexdigest(), "byte_length": len(data), "target_count": 1},
                 quadrature_diagnostics={
                    "schema_version": "fem_oersted_direct_tetra_quadrature.v3",
                    "operator_version": "fem_oersted_direct_tetra_quadrature.v3",
                    "source_view_identity_digest": "a" * 64, "target_count": 1,
                    "source_target_pairs": 1, "refined_pairs": 0, "unconverged_pair_count": 0,
                    "maximum_pair_error_apm": 0.0, "kernel_evaluations": 4, "ledger_leaf_visits": 1,
                    "base_quadrature_order": 4, "maximum_subdivision_depth": 6,
                    "absolute_tolerance_apm": 1e-9, "relative_tolerance": 1e-5,
                    "relative_scale_floor_apm": 0.0, "maximum_source_target_pairs": 1000000,
                    "maximum_final_leaves_per_target": 1000000, "maximum_kernel_evaluations": 100000000,
                    "maximum_ledger_leaf_visits": 100000000, "quadrature_scope": "global_target",
                    "estimated_error_policy": "sum_final_leaf_l2_difference.v1",
                    "roundoff_indicator_policy": "weighted_terms_binary64_epsilon.v1"})
    path.write_text(json.dumps(manifest), encoding="utf-8")
    return path


def read_legacy_solution(path, port):
    return read_solution(path, port, allow_legacy_local_estimator=True)


def verify_legacy(*args):
    return verify(*args, allow_legacy_local_estimator=True)


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
    def test_v3_reads_raw_evidence_and_nonunit_current(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = write_v3_solution(Path(temporary))
            positions, field = read_solution(path, "wire-port")
            self.assertEqual(positions, [(1.0, 0.0, 0.0)])
            self.assertAlmostEqual(field[0][1], finite_wire_field((0, 0, -1), (0, 0, 1), positions[0])[0][1])

    def test_default_does_not_promote_legacy_local_estimator(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = write_solution(Path(temporary), 1.0)
            with self.assertRaisesRegex(ValueError, "legacy"):
                read_solution(path, "wire-port")

    def test_v3_three_levels_keep_existing_error_thresholds(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifests = [write_v3_solution(Path(temporary), scale, asset_id=name)
                         for name, scale in (("coarse", 1.2), ("medium", 1.1), ("fine", 1.01))]
            result = verify(manifests, "wire-port", (0, 0, -1), (0, 0, 1), 0.5, 0.02, 0.02)
            self.assertEqual(result["quadrature_qualification"], "global_target_v3_evidence_checked")
            with self.assertRaisesRegex(ValueError, "requested tolerance"):
                verify(manifests, "wire-port", (0, 0, -1), (0, 0, 1), 0.5, 0.005, 0.02)

    def test_v3_rejects_numeric_and_binding_mutations_after_rehash(self):
        mutations = (("<Q", 144, 0), ("<Q", 144, 1000001), ("<Q", 144, 2**64 - 1),
                     ("<Q", 160, 2**64 - 1), ("<Q", 168, 1), ("<Q", 176, 5),
                     ("<Q", 192, 2**64 - 1), ("<Q", 208, 1000001),
                     ("<Q", 360, 2), ("<Q", 368, 0), ("<Q", 376, 0),
                     ("<d", 240, math.nan), ("<d", 264, -0.0), ("<d", 272, 0.0),
                     ("<d", 280, 1.0), ("<d", 288, 2.0), ("<d", 312, 1.0),
                     ("<d", 336, 1.0), ("<d", 344, 1.0), ("<d", 352, math.inf))
        with tempfile.TemporaryDirectory() as temporary:
            for fmt, offset, value in mutations:
                with self.subTest(offset=offset, value=value):
                    path = write_v3_solution(Path(temporary))
                    manifest = json.loads(path.read_text(encoding="utf-8"))
                    payload = path.parent / "direct_quadrature.v1.bin"
                    data = bytearray(payload.read_bytes())
                    struct.pack_into(fmt, data, offset, value)
                    payload.write_bytes(data)
                    manifest["bases"][0]["quadrature_evidence"]["sha256"] = hashlib.sha256(data).hexdigest()
                    path.write_text(json.dumps(manifest), encoding="utf-8")
                    with self.assertRaises(ValueError):
                        read_solution(path, "wire-port")

    def test_v3_subulp_roundoff_refused_at_equality(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = write_v3_solution(Path(temporary))
            manifest = json.loads(path.read_text(encoding="utf-8"))
            payload = path.parent / "direct_quadrature.v1.bin"
            data = bytearray(payload.read_bytes())
            tau = struct.unpack_from("<d", data, 344)[0]
            tiny = math.ulp(tau) / 4
            self.assertEqual(tau + tiny, tau)
            struct.pack_into("<d", data, 336, tau)
            struct.pack_into("<d", data, 352, tiny)
            payload.write_bytes(data)
            manifest["bases"][0]["quadrature_evidence"]["sha256"] = hashlib.sha256(data).hexdigest()
            path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "E\\+R"):
                read_solution(path, "wire-port")

    def test_v3_missing_mixed_future_and_summary_bits_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            for key, value in (("quadrature_evidence", None),
                               ("oersted_operator_version", "fem_oersted_direct_tetra_quadrature.v2"),
                               ("current_balance_certificate_digest", "c" * 64),
                               ("measured_positive_terminal_current_a", 1.0),
                               ("normalization_scale", 1.0)):
                with self.subTest(key=key):
                    path = write_v3_solution(Path(temporary))
                    manifest = json.loads(path.read_text(encoding="utf-8"))
                    manifest["bases"][0][key] = value
                    path.write_text(json.dumps(manifest), encoding="utf-8")
                    with self.assertRaises(ValueError):
                        read_solution(path, "wire-port")
            for section, key, value in (("quadrature_evidence", "schema_version", "fem_direct_oersted_evidence.v2"),
                                        ("quadrature_evidence", "target_count", True),
                                        ("quadrature_evidence", "byte_length", 2**64 - 1),
                                        ("quadrature_evidence", "path", "antenna/field_solutions/wire/H_per_A.f64le"),
                                        ("quadrature_diagnostics", "relative_scale_floor_apm", -0.0),
                                        ("quadrature_diagnostics", "target_count", True),
                                        ("quadrature_diagnostics", "quadrature_scope", "local_pair"),
                                        ("quadrature_diagnostics", "schema_version", "fem_oersted_direct_tetra_quadrature.v99")):
                with self.subTest(section=section, key=key):
                    path = write_v3_solution(Path(temporary))
                    manifest = json.loads(path.read_text(encoding="utf-8"))
                    manifest["bases"][0][section][key] = value
                    path.write_text(json.dumps(manifest), encoding="utf-8")
                    with self.assertRaises(ValueError):
                        read_solution(path, "wire-port")

    def test_v3_signed_zero_and_exact_framing(self):
        with tempfile.TemporaryDirectory() as temporary:
            for mutation in ("raw_negative_zero", "xyz_negative_zero", "trailing", "truncated", "magic"):
                with self.subTest(mutation=mutation):
                    path = write_v3_solution(Path(temporary))
                    manifest = json.loads(path.read_text(encoding="utf-8"))
                    payload = path.parent / "direct_quadrature.v1.bin"
                    data = bytearray(payload.read_bytes())
                    if mutation == "raw_negative_zero":
                        struct.pack_into("<d", data, 312, -0.0)
                    elif mutation == "xyz_negative_zero":
                        struct.pack_into("<d", data, 296, -0.0)
                    elif mutation == "trailing":
                        data += b"x"
                    elif mutation == "truncated":
                        data = data[:-1]
                    else:
                        data[0] = ord("X")
                    payload.write_bytes(data)
                    manifest["bases"][0]["quadrature_evidence"]["sha256"] = hashlib.sha256(data).hexdigest()
                    path.write_text(json.dumps(manifest), encoding="utf-8")
                    with self.assertRaises(ValueError):
                        read_solution(path, "wire-port")

    def test_legacy_v2_explicitly_remains_local_and_mixed_levels_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = write_solution(root, 1.2, asset_id="legacy")
            manifest = json.loads(path.read_text(encoding="utf-8"))
            manifest["bases"][0]["quadrature_diagnostics"]["schema_version"] = "fem_oersted_direct_tetra_quadrature.v2"
            path.write_text(json.dumps(manifest), encoding="utf-8")
            read_legacy_solution(path, "wire-port")
            with self.assertRaisesRegex(ValueError, "legacy"):
                read_solution(path, "wire-port")
            manifests = [path, write_v3_solution(root, 1.1, asset_id="medium"),
                         write_v3_solution(root, 1.01, asset_id="fine")]
            with self.assertRaisesRegex(ValueError, "mix quadrature"):
                verify_legacy(manifests, "wire-port", (0, 0, -1), (0, 0, 1), 0.5, 0.02, 0.02)

    def test_manifest_duplicate_keys_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = write_v3_solution(Path(temporary))
            text = path.read_text(encoding="utf-8")
            path.write_text(text.replace('"status": "ready"', '"status": "failed", "status": "ready"'), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "duplicate manifest"):
                read_solution(path, "wire-port")

    def test_v3_ordered_multi_target_binding(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = write_v3_solution(Path(temporary))
            manifest = json.loads(path.read_text(encoding="utf-8"))
            basis = manifest["bases"][0]
            original = (path.parent / "direct_quadrature.v1.bin").read_bytes()
            header = list(struct.unpack_from("<16s64s64s12Q6d", original))
            header[3:5] = [2, 2]
            header[7:9] = [8, 2]
            first = original[288:]
            second = bytearray(first)
            struct.pack_into("<d", second, 0, 2.0)
            data = struct.pack("<16s64s64s12Q6d", *header) + first + second
            for descriptor, name, payload in (
                (manifest["sample_positions"], "sample_positions.f64le", struct.pack("<6d", 1, 0, 0, 2, 0, 0)),
                (basis["magnetic_field_per_ampere"], "H_per_A.f64le", (path.parent / "H_per_A.f64le").read_bytes() * 2)):
                (path.parent / name).write_bytes(payload)
                descriptor["value_count"] = 6
                descriptor["sha256"] = hashlib.sha256(payload).hexdigest()
            summary = basis["quadrature_diagnostics"]
            summary.update(target_count=2, source_target_pairs=2, kernel_evaluations=8, ledger_leaf_visits=2)
            reference = basis["quadrature_evidence"]
            reference.update(target_count=2, byte_length=len(data), sha256=hashlib.sha256(data).hexdigest())
            payload_path = path.parent / "direct_quadrature.v1.bin"
            payload_path.write_bytes(data)
            path.write_text(json.dumps(manifest), encoding="utf-8")
            positions, _ = read_solution(path, "wire-port")
            self.assertEqual(positions, [(1.0, 0.0, 0.0), (2.0, 0.0, 0.0)])
            reordered = data[:288] + second + first
            payload_path.write_bytes(reordered)
            reference["sha256"] = hashlib.sha256(reordered).hexdigest()
            path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "ordered xyz"):
                read_solution(path, "wire-port")

    def test_legacy_report_cannot_claim_global_or_producer_qualification(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifests = [write_solution(Path(temporary), scale, asset_id=name)
                         for name, scale in (("coarse", 1.2), ("medium", 1.1), ("fine", 1.01))]
            result = verify_legacy(manifests, "wire-port", (0, 0, -1), (0, 0, 1), 0.5, 0.02, 0.02)
            self.assertEqual(result["quadrature_qualification"], "legacy_local_estimator_not_global_certificate")
            self.assertIs(result["producer_provenance_qualified"], False)

    def test_verify_function_rejects_nonfinite_or_nonpositive_thresholds(self):
        for value in (math.nan, math.inf, -math.inf, 0.0, -1.0, True):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "positive and finite"):
                verify([], "wire-port", (0, 0, -1), (0, 0, 1), 0.5, value, 0.02)

    def test_nonfinite_comparison_norm_cannot_pass(self):
        from tests.antenna.verify_field_convergence import relative_errors
        with self.assertRaises((ValueError, OverflowError)):
            relative_errors([(1.0, 0.0, 0.0)], [(1e308, 0.0, 0.0)], (0, 0, -1), (0, 0, 1), 0.5)

    def test_revisioned_manifest_reads_its_own_payloads(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_solution(root, 2.0)
            write_solution(root, 3.0, asset_id="older")
            manifest = write_solution(root, 1.0, asset_id="current")
            positions, field = read_legacy_solution(manifest, "wire-port")
            reference, _ = finite_wire_field((0, 0, -1), (0, 0, 1), positions[0])
            self.assertEqual(field, [reference])

    def test_revisioned_three_levels(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifests = [write_solution(root, scale, asset_id=name) for name, scale in
                         (("coarse", 1.2), ("medium", 1.1), ("fine", 1.01))]
            result = verify_legacy(manifests, "wire-port", (0, 0, -1), (0, 0, 1), 0.5, 0.02, 0.02)
            self.assertAlmostEqual(result["levels"][2]["l2_relative"], 0.01)

    def test_missing_revision_payload_never_falls_back(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_solution(root, 1.0)
            write_solution(root, 1.0, asset_id="older")
            manifest = write_solution(root, 1.0, asset_id="current")
            (manifest.parent / "H_per_A.f64le").unlink()
            with self.assertRaises(FileNotFoundError):
                read_legacy_solution(manifest, "wire-port")

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
                        read_legacy_solution(path, "wire-port")

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
                        read_legacy_solution(path, "wire-port")

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
                read_legacy_solution(manifest, "wire-port")

    def test_rejects_noncanonical_manifest_location(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = write_solution(root, 1.0)
            for path in (original.with_name("other.json"), root / "manifest.v1.json"):
                with self.subTest(path=path):
                    path.write_bytes(original.read_bytes())
                    with self.assertRaisesRegex(ValueError, "manifest"):
                        read_legacy_solution(path, "wire-port")

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
                        read_legacy_solution(path, "wire-port")
            path = write_solution(root, 1.0, asset_id="current")
            manifest = json.loads(path.read_text(encoding="utf-8"))
            data = struct.pack("<3d", 0.0, math.nan, 0.0)
            (path.parent / "H_per_A.f64le").write_bytes(data)
            manifest["bases"][0]["magnetic_field_per_ampere"]["sha256"] = hashlib.sha256(data).hexdigest()
            path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "non-finite"):
                read_legacy_solution(path, "wire-port")

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
                        read_legacy_solution(path, "wire-port")
            path = write_solution(root, 1.0, unconverged=1, asset_id="current")
            with self.assertRaisesRegex(ValueError, "quadrature certificate"):
                read_legacy_solution(path, "wire-port")

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
            result = verify_legacy(manifests, "wire-port", (0, 0, -1), (0, 0, 1), 0.5, 0.02, 0.02)
            self.assertEqual(result["status"], "pass")
            self.assertAlmostEqual(result["levels"][2]["l2_relative"], 0.01)
            with self.assertRaisesRegex(ValueError, "requested tolerance"):
                verify_legacy(manifests, "wire-port", (0, 0, -1), (0, 0, 1), 0.5, 0.005, 0.02)

    def test_rejects_corrupt_or_unconverged_asset(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = write_solution(root, 1.0, unconverged=1)
            with self.assertRaisesRegex(ValueError, "converged quadrature"):
                read_legacy_solution(manifest, "wire-port")
            manifest = write_solution(root, 1.0)
            payload = manifest.parent / "H_per_A.f64le"
            payload.write_bytes(b"bad")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                read_legacy_solution(manifest, "wire-port")

    def test_rejects_changed_sample_locations(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifests = [write_solution(root / name, 1.0 + error, position=point)
                         for name, error, point in (("coarse", 0.2, (1.0, 0.0, 0.0)),
                                                    ("medium", 0.1, (1.1, 0.0, 0.0)),
                                                    ("fine", 0.01, (1.0, 0.0, 0.0)))]
            with self.assertRaisesRegex(ValueError, "identical physical sample positions"):
                verify_legacy(manifests, "wire-port", (0, 0, -1), (0, 0, 1), 0.5, 0.02, 0.02)


if __name__ == "__main__":
    unittest.main()
