"""Interpreted HTTP-gate regressions; mock evidence is not backend evidence."""
import copy
import json
import struct
import unittest
from hashlib import sha256
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import smoke_accepted_antenna_inspection as gate
from smoke_antenna_external_lead_inspection import CURRENT_PAYLOAD, CURRENT_POLICY, HttpResult


def fixture():
    owner = {key: key for key in gate.OWNER_FIELDS}
    owner.update(run_id="run-one", study_step_id="study-one", native_stage_id="native-other",
                 ownership_epoch=2, manifest_object_ref="a" * 64, package_object_ref="b" * 64)
    bodies = {}

    def descriptor(kind, spec, count):
        path, scalar, layout, unit, width = spec
        body = bytes(count * width)
        bodies[kind] = body
        return dict(path=path, scalar_type=scalar, layout=layout, unit=unit,
                    value_count=count, byte_count=len(body), sha256=sha256(body).hexdigest())

    descriptors = {kind: descriptor(kind, spec, {"bundle": 1, "sample_positions": 3,
        "magnetic_field": 3, "device_vertex_ids": 4, "device_potential": 4}[kind])
        for kind, spec in gate.PAYLOADS.items()}
    receipt = {**CURRENT_POLICY, "cell_count": 1,
               "payload": descriptor("current_snapshot", CURRENT_PAYLOAD, 1502)}
    current = {"receipt": receipt, "ordered_snapshot": receipt["payload"]}
    for kind, (name, layout, unit, count) in gate.CURRENT_CARRIERS.items():
        current[name] = descriptor(kind, (f"display/{kind}.bin", "float64_le", layout, unit, 8), count)
    display = dict(content_digest="sha256:" + "c" * 64, source_object_id="antenna",
        status="inspection_only", qualification="NOT VERIFIED", field_scope="external_electrode_truncation",
        normalization="raw_authored_current", capabilities=dict(display=True, per_ampere_basis=False,
        source_fft=False, llg_drive=False, current_density=True), device_node_count=4, device_cell_count=1,
        sampling_carrier={"sample_count": 1}, device_current=current)
    display.update({kind: descriptors[kind] for kind in ("device_potential", "sample_positions", "magnetic_field")})
    display["device_positions"] = descriptor("device_positions",
        ("display/device_positions.bin", "float64_le", "node_xyz_interleaved", "m", 8), 12)
    display["device_topology"] = descriptor("device_topology",
        ("display/device_topology.bin", "uint32_le", "tet4_connectivity", "1", 4), 4)
    manifest = dict(schema_version="antenna_external_lead_solution.v2", validation_scope="accepted_plan_and_payloads",
        content_digest=display["content_digest"], source_object_id="antenna", sampling_carrier=display["sampling_carrier"],
        current_display=receipt, **descriptors)
    resource = dict(schema_version="accepted_antenna_inspection.v1",
        resource_id="persistence/projects/project-one/runs/run-one/antenna-inspections/study-one",
        project_id="project-one", owner=owner, port_mode_id="port", output_id="output", manifest=manifest, display=display)
    return owner, resource, bodies


class AcceptedHttpGateTests(unittest.TestCase):
    def test_owner_never_substitutes_native_stage_or_live_scope(self):
        owner, _, _ = fixture()
        self.assertEqual(gate.validate_owner(owner, "run-one", "study-one"), owner)
        for changed in ({**owner, "study_step_id": "native-other"}, {**owner, "run_id": "other"},
                        {**owner, "session_id": "fake"}, {**owner, "ownership_epoch": True},
                        {**owner, "package_object_ref": "B" * 64}):
            with self.assertRaises(gate.SmokeError):
                gate.validate_owner(changed, "run-one", "study-one")

    def test_etag_pins_ownership_not_only_numerical_content(self):
        owner, resource, _ = fixture()
        descriptor = resource["display"]["magnetic_field"]
        expected = gate.payload_etag("project-one", owner, "magnetic_field", descriptor)
        for key in ("run_id", "study_step_id", "native_stage_id", "task_id", "attempt_id",
                    "ownership_epoch", "manifest_object_ref", "artifact_id", "package_object_ref"):
            changed = {**owner, key: 3 if key == "ownership_epoch" else "other"}
            self.assertNotEqual(gate.payload_etag("project-one", changed, "magnetic_field", descriptor), expected)
        self.assertNotEqual(gate.payload_etag("other", owner, "magnetic_field", descriptor), expected)

    def test_display_rejects_promotion_wrong_units_and_wrong_carriers(self):
        owner, resource, _ = fixture()
        self.assertEqual(len(gate.display_descriptors(resource, "project-one", owner, resource["resource_id"])), 12)
        for change in ("promotion", "unit", "count", "live", "no_current"):
            bad = copy.deepcopy(resource)
            if change == "promotion": bad["display"]["capabilities"]["llg_drive"] = True
            elif change == "unit": bad["display"]["magnetic_field"]["unit"] = "T"
            elif change == "count": bad["display"]["device_cell_count"] = 2
            elif change == "live": bad["display"]["session_id"] = "fake"
            else: del bad["display"]["device_current"]
            with self.assertRaises(gate.SmokeError):
                gate.display_descriptors(bad, "project-one", owner, resource["resource_id"])

    def test_full_mock_http_contract_checks_all_payloads_and_stale_pins(self):
        owner, resource, bodies = fixture()
        descriptors = gate.display_descriptors(resource, "project-one", owner, resource["resource_id"])
        catalog = dict(schema_version="accepted_antenna_inspection_catalog.v1",
            resource_id=resource["resource_id"].rsplit("/", 1)[0], project_id="project-one",
            run_id="run-one", validation_scope="published_output_manifest", entries=[owner])
        rejected = []

        def fetch(origin, path, headers, limit):
            parsed = urlsplit(path)
            if parsed.query:
                query = parse_qs(parsed.query)
                if any(query.get(key) != [str(owner[key])] for key in gate.PIN_FIELDS):
                    rejected.append(path)
                    return HttpResult(409, {"content-type": "application/json"},
                        json.dumps({"code": "antenna_source_conflict"}).encode())
            kind = parsed.path.rsplit("/", 1)[-1]
            binary = "/payloads/" in parsed.path
            body = bodies[kind] if binary else json.dumps(resource if parsed.query else catalog).encode()
            etag = gate.payload_etag("project-one", owner, kind, descriptors[kind]) if binary else '"metadata"'
            result_headers = {"etag": etag, "cache-control": "no-cache",
                "content-type": "application/octet-stream" if binary else "application/json"}
            if binary: result_headers["accept-ranges"] = "bytes"
            if headers.get("If-None-Match") == etag:
                return HttpResult(304, result_headers, b"")
            if "Range" in headers:
                start, end = headers["Range"].removeprefix("bytes=").split("-")
                if int(start) >= len(body):
                    return HttpResult(416, {**result_headers, "content-range": f"bytes */{len(body)}"}, b"")
                result_headers["content-range"] = f"bytes {start}-{end}/{len(body)}"
                return HttpResult(206, result_headers, body[int(start):int(end) + 1])
            return HttpResult(200, result_headers, body)

        # This transport-only fixture deliberately has no canonical records.
        with patch.object(gate, "request", fetch), patch.object(gate, "verify_retained_payloads") as retained:
            result = gate.verify("http://127.0.0.1:8081", "project-one", "run-one", "study-one")
        retained.assert_called_once()
        self.assertEqual(len(result["payloads"]), 12)
        self.assertEqual(len(rejected), 6)
        self.assertFalse(result["physics_qualified"])

    def test_retained_projection_detects_wrong_values_despite_resignable_descriptors(self):
        from test_smoke_antenna_inspection_display import FrozenInspection, descriptor, encode
        from smoke_antenna_external_lead_inspection import CURRENT_PAYLOAD
        frozen = FrozenInspection(2)
        outer = gate.framing.fields(frozen.payloads["bundle"])
        values = lambda kind: [row[0] for row in struct.iter_unpack("<d", frozen.payloads[kind])]
        field = encode([
            ("schema", 1, "accepted_external_lead_field.ordered.v2"),
            ("field_scope", 1, "external_electrode_truncation"),
            ("charge_content_digest", 1, gate.framing.one(outer, "charge_content_sha256", 1)),
            ("accepted_external_source_digest", 1, gate.framing.one(outer, "source_content_sha256", 1)),
            ("target_count", 2, 1),
            *[("target_coordinate_m", 4, value) for value in values("sample_positions")],
            *[("h_component_apm", 4, value) for value in values("magnetic_field")],
        ])
        outer = [(name, tag, field if name == "field_record" else sha256(field).hexdigest()
                  if name == "field_content_sha256" else value) for name, tag, value in outer]
        frozen.payloads["bundle"] = encode(outer)
        rows = gate.framing.fields(frozen.payloads["current_snapshot"])
        rows = [(name, tag, sha256(frozen.payloads["bundle"]).hexdigest()
                 if name == "bundle_content_sha256" else value) for name, tag, value in rows]
        frozen.payloads["current_snapshot"] = encode(rows)
        receipt = frozen.display["device_current"]["receipt"]
        receipt["payload"] = descriptor(frozen.payloads["current_snapshot"], *CURRENT_PAYLOAD)
        gate.verify_retained_payloads(frozen.display, frozen.payloads)
        for kind in ("device_potential", "device_positions", "device_topology", "device_vertex_ids",
                     "sample_positions", "magnetic_field", *gate.CURRENT_CARRIERS):
            bad = {**frozen.payloads, kind: bytes([frozen.payloads[kind][0] ^ 1]) + frozen.payloads[kind][1:]}
            with self.subTest(kind=kind), self.assertRaises(gate.SmokeError):
                gate.verify_retained_payloads(frozen.display, bad)


if __name__ == "__main__":
    unittest.main()
