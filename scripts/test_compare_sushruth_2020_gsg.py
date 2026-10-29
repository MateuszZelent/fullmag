"""Diagnostic comparison regressions; synthetic samples are not solver evidence."""
import copy
from hashlib import sha256
import itertools
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

import compare_sushruth_2020_gsg as check


class GsgComparisonTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ref = check.ref
        points, voltage, current = [], [], []
        for _, center, weight in ref.BRANCHES:
            density = weight * ref.SIGNAL_CURRENT_A / (ref.WIDTH_M * ref.THICKNESS_M)
            for x, y, z in itertools.product(
                (center - ref.WIDTH_M / 2, center + ref.WIDTH_M / 2),
                (-ref.DEVICE_LENGTH_M / 2, ref.DEVICE_LENGTH_M / 2),
                (ref.SPACING_M, ref.SPACING_M + ref.THICKNESS_M),
            ):
                points.append((x, y, z))
                voltage.append(-density * y / ref.CONDUCTIVITY_SPM)
                current.extend((0., density, 0.))
        hp = list(itertools.product((-2e-6, 2e-6), (-50e-9, 50e-9), (-10e-9, 0.)))
        hp.extend(((0., 0., -5e-9), (100e-9, 0., -5e-9)))
        cls.expected_h = {p: ref.gsg_field(p) for p in hp}
        cls.samples = {
            "V_electric": (points, voltage),
            "J_charge": (points, current),
            "H_ant": (hp, [v for p in hp for v in cls.expected_h[p]]),
        }

    def compare(self, data):
        # Reference quadrature has independent tests; here exercise metric/admission.
        with patch.object(check.ref, "gsg_field", side_effect=lambda p: self.expected_h[tuple(p)]):
            return check.compare_samples(data)

    def test_reference_samples_pass_without_claiming_qualification(self):
        result = self.compare(copy.deepcopy(self.samples))
        self.assertEqual(result["status"], "passed")
        for key in ("physics_qualified", "omitted_feed_qualified", "boris_compared"):
            self.assertFalse(result[key])

    def test_gauge_offsets_are_not_fitted_slopes(self):
        data = copy.deepcopy(self.samples)
        for i in range(len(data["V_electric"][1])):
            data["V_electric"][1][i] += (0.1, -0.2, 0.3)[i // 8]
        self.assertEqual(self.compare(data)["status"], "passed")
        for i, p in enumerate(data["V_electric"][0]):
            data["V_electric"][1][i] += 0.01 * p[1]
        self.assertEqual(self.compare(data)["status"], "failed")

    def test_wrong_current_sign_and_transverse_component_fail(self):
        for component, value in ((1, -self.samples["J_charge"][1][1]), (0, 1e7)):
            data = copy.deepcopy(self.samples)
            data["J_charge"][1][component] = value
            self.assertEqual(self.compare(data)["status"], "failed")

    def test_wrong_field_sign_or_component_fails(self):
        for component, value in ((24, -self.samples["H_ant"][1][24]), (25, 1.)):
            data = copy.deepcopy(self.samples)
            data["H_ant"][1][component] = value
            self.assertEqual(self.compare(data)["status"], "failed")

    def test_nonfinite_and_cardinality_are_rejected_for_every_field(self):
        for quantity in self.samples:
            for fault in ("nan", "inf", "short"):
                with self.subTest(quantity=quantity, fault=fault):
                    data = copy.deepcopy(self.samples)
                    if fault == "short":
                        data[quantity][1].pop()
                    else:
                        data[quantity][1][0] = float(fault)
                    with self.assertRaises(check.SmokeError):
                        self.compare(data)

    def test_wrong_geometry_and_missing_branch_are_rejected(self):
        for quantity in self.samples:
            data = copy.deepcopy(self.samples)
            points = data[quantity][0]
            points[0] = (1., points[0][1], points[0][2])
            with self.subTest(quantity=quantity), self.assertRaises(check.SmokeError):
                self.compare(data)
        data = copy.deepcopy(self.samples)
        points, values = data["V_electric"]
        data["V_electric"] = (points[:16], values[:16])
        with self.assertRaises(check.SmokeError):
            self.compare(data)

    def test_sample_order_can_change_only_together_with_values(self):
        data = copy.deepcopy(self.samples)
        for quantity, count in (("V_electric", 1), ("J_charge", 3), ("H_ant", 3)):
            points, values = data[quantity]
            groups = [values[i:i + count] for i in range(0, len(values), count)]
            data[quantity] = (list(reversed(points)), [v for group in reversed(groups) for v in group])
        self.assertEqual(self.compare(data)["status"], "passed")
        points, values = data["V_electric"]
        data["V_electric"] = (list(reversed(points)), values)
        self.assertEqual(self.compare(data)["status"], "failed")

    def test_reference_work_is_bounded(self):
        data = copy.deepcopy(self.samples)
        points, values = data["H_ant"]
        data["H_ant"] = ((points * 410)[:4097], (values * 410)[:4097 * 3])
        with self.assertRaises(check.SmokeError):
            self.compare(data)

    def receipt(self):
        startup = check.startup
        auth = startup.StartupScriptAuthorization(
            source_root=Path("/source"), source_path=Path("/source") / check.SOURCE_RELATIVE,
            source_relative=check.SOURCE_RELATIVE, source_sha256=check.SOURCE_SHA256,
            source_size_bytes=1, container_source_root="/opt/fullmag/source",
            container_script_path=startup._container_script_path(check.SOURCE_RELATIVE),
            request_id="gsg-comparison-regression",
        ).as_dict()
        response = {
            "schema": startup.RESPONSE_SCHEMA, "authorization": startup.AUTHORIZATION_KIND,
            "request_id": auth["request_id"], "source_sha256": auth["source_sha256"],
            "session_id": "session-test", "run_id": "run-test", "step_ids": ["stage-test"],
            "scene_revision": 1, "status": "accepted", "execution": auth["execution_policy"],
            "runtime_metadata": {"interactive": False, "wait_for_solve": False},
        }
        receipt = startup._activation_receipt_started(auth, "a" * 64)
        receipt.update(state="activated", result={
            "schema": startup.RESPONSE_SCHEMA, "state": "activated", "request_id": auth["request_id"],
            "source_sha256": auth["source_sha256"], "source_relative": auth["source_relative"],
            "response": response,
        })
        return startup._validate_activation_receipt(receipt)

    def run_http(self, fault=None):
        receipt = self.receipt()
        resource = {"session_id": "session-test", "run_id": "run-test",
                    "stage_id": "inspect_gsg", "request_scope_epoch": "scope-test"}
        if fault == "foreign-run":
            resource["run_id"] = "other-run"
        if fault == "foreign-session":
            resource["session_id"] = "other-session"
        payloads, hashes = {}, {}
        for quantity, pk, vk in (
            ("V_electric", "device_positions", "device_potential"),
            ("J_charge", "current_trace_positions", "current_trace_density"),
            ("H_ant", "sample_positions", "magnetic_field"),
        ):
            points, values = self.samples[quantity]
            flattened = [v for p in points for v in p]
            payloads[pk] = struct.pack("<" + "d" * len(flattened), *flattened)
            payloads[vk] = struct.pack("<" + "d" * len(values), *values)
            hashes[quantity] = {"positions_sha256": sha256(payloads[pk]).hexdigest(),
                                "values_sha256": sha256(payloads[vk]).hexdigest()}
        display = {key: {} for key in payloads}
        display["device_current"] = {"trace_positions": {}, "trace_current_density": {}}
        http = {"run_id": "run-test", "fields": hashes}
        if fault == "payload-drift":
            payloads["device_potential"] += struct.pack("<d", 1.)
        final = copy.deepcopy(resource)
        if fault == "owner-drift":
            final["run_id"] = "changed-run"
        if fault == "foreign-source":
            receipt["source_sha256"] = "b" * 64
            receipt["authorization"]["source_sha256"] = "b" * 64
            receipt["result"]["source_sha256"] = "b" * 64
            receipt["result"]["response"]["source_sha256"] = "b" * 64
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "activation.json"
            path.write_text(json.dumps(receipt))
            with (
                patch.object(check.fields, "verify", return_value=http) as gate,
                patch.object(check, "request", side_effect=[resource, display, final]),
                patch.object(check, "json_body", side_effect=lambda value, _: value),
                patch.object(check, "validate_resource", return_value=({"source_object_id": "antenna"}, "a" * 64)),
                patch.object(check, "session_scope", return_value="scope"),
                patch.object(check, "verify_binary", side_effect=lambda o, p, h, kind, d: (payloads[kind], "etag")),
                patch.object(check.ref, "gsg_field", side_effect=lambda p: self.expected_h[tuple(p)]),
            ):
                try:
                    return check.compare("http://127.0.0.1:8081", "stage-test", path)
                finally:
                    if fault == "foreign-source":
                        gate.assert_not_called()

    def test_http_comparison_binds_validated_receipt_and_payloads(self):
        result = self.run_http()
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["session_id"], "session-test")
        self.assertEqual(result["source_sha256"], check.SOURCE_SHA256)

    def test_http_comparison_rejects_foreign_owner_source_and_drift(self):
        for fault in ("foreign-run", "foreign-session", "foreign-source", "payload-drift", "owner-drift"):
            with self.subTest(fault=fault), self.assertRaises(check.SmokeError):
                self.run_http(fault)

    def test_nominal_example_hash_is_pinned(self):
        source = Path(__file__).resolve().parents[1] / check.SOURCE_RELATIVE
        self.assertEqual(sha256(source.read_bytes()).hexdigest(), check.SOURCE_SHA256)


if __name__ == "__main__":
    unittest.main()
