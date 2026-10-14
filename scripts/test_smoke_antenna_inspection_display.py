"""Frozen HTTP/ordered-framing fixtures; never native or scientific proof."""
import copy
from hashlib import sha256
import json
import struct
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import pytest
import antenna_rt0_fixture_check as framing
import smoke_antenna_external_lead_inspection as metadata_smoke
import smoke_antenna_inspection_display as display_smoke
from scripts.test_antenna_rt0_fixture_check import encode
import test_smoke_antenna_external_lead_inspection as legacy_http_tests


def descriptor(payload, path, scalar, layout, unit, width):
    return {"path": path, "scalar_type": scalar, "layout": layout, "unit": unit,
            "value_count": len(payload) // width, "byte_count": len(payload),
            "sha256": sha256(payload).hexdigest()}


class FrozenInspection:
    """A partial ordered fixture intentionally unsuitable for native publication."""
    response = legacy_http_tests.InspectionHttpSmokeTests.response

    def __init__(self, generation):
        self.generation = generation
        self.calls = []
        self.digest = "sha256:" + "a" * 64
        self.ids = [5, 3, 1, 4, 2]  # Authored display order differs from native IDs.
        xyz = {1: [0., 0., 0.], 2: [1., 0., 0.], 3: [0., 1., 0.],
               4: [0., 0., 1.], 5: [0., 0., -1.], 6: [3., 0., 0.],
               7: [4., 0., 0.], 8: [3., 1., 0.], 9: [3., 0., 1.]}
        elements = [[1, 2, 3, 4], [6, 7, 8, 9], [1, 2, 3, 5]]
        charge = [("schema", 1, "accepted_terminal_charge_source.ordered.v1"),
                  ("operator", 1, "fem_accepted_terminal_charge_source.v1"),
                  ("vertices", 2, 9), ("stable_vertex_version", 1, "stable_mesh_vertex_u64.v1")]
        for identity, position in xyz.items():
            charge += [("vertex_id", 2, identity)] + [("xyz_m", 4, v) for v in position]
            charge += [("potential_v", 4, float(identity)), ("reaction_a", 4, 0.), ("vertex_component_id", 2, 1)]
        charge += [("elements", 2, 3)]
        for vertices in elements:
            charge += [("attribute", 2, 1)] + [("vertex_id", 2, v) for v in vertices] + [("conductivity_spm", 4, 4.)]
        charge_bytes = encode(charge)
        source = [("schema", 1, "accepted_external_lead_current_source.ordered.v2"),
                  ("operator_version", 1, "fem_accepted_external_lead_current_source.v2"),
                  ("field_scope", 1, "external_electrode_truncation"),
                  ("charge_content_digest", 1, sha256(charge_bytes).hexdigest()),
                  ("closure_revision", 1, "synthetic-transport-only"), ("device_vertex_count", 2, 5)]
        source += [("device_vertex_id", 2, v) for v in range(1, 6)] + [("lead_vertex_count", 2, 4)]
        source += [("lead_vertex_id", 2, v) for v in range(6, 10)]
        source_bytes = encode(source)
        outer = [("schema", 1, "accepted_external_lead_bundle.ordered.v1"),
                 ("operator_version", 1, "fem_accepted_external_lead_bundle.v1"),
                 ("field_scope", 1, "external_electrode_truncation")]
        for name, payload in (("charge", charge_bytes), ("source", source_bytes),
                              ("field", b"partial synthetic field, not a native record")):
            outer += [(name + "_content_sha256", 1, sha256(payload).hexdigest()), (name + "_record", 3, payload)]
        bundle = encode(outer)
        pack = lambda values: b"".join(struct.pack("<d", v) for v in values)
        indices = {identity: index for index, identity in enumerate(self.ids)}
        self.payloads = {
            "bundle": bundle,
            "device_vertex_ids": b"".join(struct.pack("<Q", v) for v in self.ids),
            "device_potential": pack(float(identity) for identity in self.ids),
            "device_positions": pack(v for identity in self.ids for v in xyz[identity]),
            "device_topology": b"".join(struct.pack("<I", indices[v]) for cell in (elements[0], elements[2]) for v in cell),
            "sample_positions": pack([2., 2., 2.]), "magnetic_field": pack([1., 2., 3.]),
        }
        manifest = {"schema_version": f"antenna_external_lead_solution.v{generation}",
                    "validation_scope": "manifest_only", "content_digest": self.digest,
                    "source_object_id": "antenna", "sampling_carrier": {"sample_count": 1}}
        for kind, spec in metadata_smoke.PAYLOADS.items():
            manifest[kind] = descriptor(self.payloads[kind], *spec)
        self.resource = {
            "resource_id": "data/antenna/stages/stage-000/external-lead-inspection",
            "session_id": "session", "session_epoch": "epoch", "run_id": "run",
            "request_scope_epoch": "api-instance:0", "runtime_stage_id": "stage-000", "stage_revision": 3,
            "record_content_digest": "sha256:" + "b" * 64,
            "schema_version": f"antenna_external_lead_stage_output.v{generation}",
            "stage_kind": "antenna_field_solve", "resolved_action": "external_lead_inspection",
            "stage_id": "authored", "port_mode_id": "port", "output_id": "output",
            "status": "inspection_only", "qualification": "NOT VERIFIED", "field_scope": "external_electrode_truncation",
            "outputs": [{"kind": "antenna_external_lead_inspection", "manifest_ref":
                f"antenna/external_lead_solutions/output/{self.digest[7:]}/manifest.v{generation}.json",
                "payload_units": {"V": "V", "RT0_coefficients": "A", "H": "A/m", "positions": "m"},
                "reused_existing": False, "inspection_ref": {"stage_id": "authored", "output_id": "output", "content_digest": self.digest}}],
            "manifest": manifest,
        }
        self.display = {key: self.resource[key] for key in (
            "session_id", "session_epoch", "request_scope_epoch", "run_id", "runtime_stage_id",
            "stage_revision", "record_content_digest", "status", "qualification", "field_scope")}
        self.display.update({"resource_id": self.resource["resource_id"] + "/display",
            "schema_version": f"antenna_inspection_display.v{generation}", "normalization": "raw_authored_current",
            "content_digest": self.digest, "source_object_id": "antenna", "device_node_count": 5,
            "device_cell_count": 2, "sampling_carrier": manifest["sampling_carrier"],
            "capabilities": {"display": True, "per_ampere_basis": False, "source_fft": False,
                             "llg_drive": False, "current_density": generation == 2}})
        for kind in ("device_potential", "sample_positions", "magnetic_field"):
            self.display[kind] = copy.deepcopy(manifest[kind])
        for kind, scalar, layout, unit, width in (
            ("device_positions", "float64_le", "node_xyz_interleaved", "m", 8),
            ("device_topology", "uint32_le", "tet4_connectivity", "1", 4)):
            self.display[kind] = descriptor(self.payloads[kind], f"display/{kind}.bin", scalar, layout, unit, width)
        if generation == 2:
            self.resource["outputs"][0]["payload_units"]["J_charge"] = "A/m^2"
            header = [("schema" if k == "schema_version" else k, 1, v) for k, v in metadata_smoke.CURRENT_POLICY.items()]
            header[5:5] = [("field_scope", 1, "external_electrode_truncation"), ("status", 1, "inspection_only")]
            header += [("bundle_content_sha256", 1, sha256(bundle).hexdigest()),
                       ("charge_content_sha256", 1, sha256(charge_bytes).hexdigest()),
                       ("source_content_sha256", 1, sha256(source_bytes).hexdigest()),
                       ("stable_vertex_id_version", 1, "stable_mesh_vertex_u64.v1"), ("cell_count", 2, 2)]
            samples, rows = [], list(header)
            for ordinal in (0, 2):
                vertices = elements[ordinal]
                j = [[float(ordinal * 20 + local * 3 + component + 1) for component in range(3)] for local in range(4)]
                # Do not recompute this preserved center in the consumer.
                center = [0.25000000000000006, 0.25, 0.25 if ordinal == 0 else -0.25]
                center_j = [101. + ordinal, 102. + ordinal, 103. + ordinal]
                samples.append({"source_element_index": ordinal, "vertex_ids": vertices,
                    "vertex_positions_m": [xyz[v] for v in vertices], "vertex_current_apm2": j,
                    "center_position_m": center, "center_current_apm2": center_j})
                rows += [("source_element_index", 2, ordinal)]
                for identity, vector in zip(vertices, j):
                    rows += [("vertex_id", 2, identity)] + [("vertex_coordinate_m", 4, v) for v in xyz[identity]]
                    rows += [("vertex_current_apm2", 4, v) for v in vector]
                rows += [("center_coordinate_m", 4, v) for v in center] + [("center_current_apm2", 4, v) for v in center_j]
            self.payloads["current_snapshot"] = encode(rows)
            receipt = {**metadata_smoke.CURRENT_POLICY, "cell_count": 2,
                       "payload": descriptor(self.payloads["current_snapshot"], *metadata_smoke.CURRENT_PAYLOAD)}
            manifest["current_display"] = receipt
            self.display["device_current"] = {"receipt": copy.deepcopy(receipt), "ordered_snapshot": copy.deepcopy(receipt["payload"])}
            for kind, (name, layout, unit, _) in display_smoke.CURRENT_CARRIERS.items():
                sample_key = {"center_positions": "center_position_m", "center_current_density": "center_current_apm2",
                              "trace_positions": "vertex_positions_m", "trace_current_density": "vertex_current_apm2"}[name]
                values = [sample[sample_key] for sample in samples]
                if name.startswith("trace"):
                    values = [row for rows in values for row in rows]
                self.payloads[kind] = pack(v for row in values for v in row)
                self.display["device_current"][name] = descriptor(self.payloads[kind], f"display/{kind}.bin", "float64_le", layout, unit, 8)

    def serve(self, origin, path, headers, limit):
        if urlsplit(path).path.endswith("/display"):
            self.calls.append((path, headers))
            scope = metadata_smoke.session_scope(self.resource, self.resource["request_scope_epoch"])
            if headers.get("x-fullmag-session-scope", scope) != scope:
                return self.response(409, b'{"error":"request_context_stale"}', **{"content-type": "application/json"})
            query = parse_qs(urlsplit(path).query)
            if set(query) != {"content_digest"}:
                return self.response(400, b'{"message":"invalid inspection display query: fixture"}', **{"content-type": "application/json"})
            if query["content_digest"] != [self.digest]:
                return self.response(409, b'{"code":"inspection_digest_mismatch"}', **{"content-type": "application/json"})
            common = {"etag": '"display"', "cache-control": "no-cache"}
            if headers.get("If-None-Match") == common["etag"]:
                return self.response(304, **common)
            return self.response(200, json.dumps(self.display).encode(), **common, **{"content-type": "application/json"})
        return legacy_http_tests.InspectionHttpSmokeTests.serve(self, origin, path, headers, limit)

    def run(self, module=display_smoke, fetch=None):
        with patch.object(module, "request", side_effect=fetch or self.serve):
            return module.verify("http://127.0.0.1:8080", "stage-000")


@pytest.mark.parametrize("generation", [1, 2])
def test_frozen_display_v1_v2_preserves_scope_carriers_without_physics_promotion(generation):
    fixture = FrozenInspection(generation)
    result = fixture.run()
    assert result["status"] == "passed"
    assert result["physics_qualified"] is False
    assert result["native_canonical_bundle_redecoded"] is False
    assert result["current_density_display_checked"] is (generation == 2)
    assert result["device_nodes"] == 5 and result["device_cells"] == 2
    assert len(result["payloads_checked"]) == (12 if generation == 2 else 7)
    scope = metadata_smoke.session_scope(fixture.resource, fixture.resource["request_scope_epoch"])
    assert all(headers["x-fullmag-session-scope"] in (scope, scope + "-stale-smoke") for _, headers in fixture.calls[1:])


def test_external_v2_consumes_snapshot_and_checks_its_cache_range_scope():
    fixture = FrozenInspection(2)
    result = fixture.run(metadata_smoke)
    assert result["status"] == "pass" and result["physics_qualified"] is False
    assert result["current_snapshot_decoded"] is True
    assert len(result["payloads"]) == 6 and result["stale_scope_routes_checked"] == 8


@pytest.mark.parametrize("generation", [1, 2])
@pytest.mark.parametrize("mutation", ["schema", "current", "per_ampere_basis", "source_fft", "llg_drive", "bool", "owner", "count", "extra"])
def test_display_rejects_generation_capability_owner_and_count_drift(generation, mutation):
    fixture = FrozenInspection(generation)
    if mutation == "schema": fixture.display["schema_version"] = f"antenna_inspection_display.v{3 - generation}"
    elif mutation == "current":
        if generation == 1: fixture.display["device_current"] = None
        else: fixture.display.pop("device_current")
    elif mutation in ("per_ampere_basis", "source_fft", "llg_drive"): fixture.display["capabilities"][mutation] = True
    elif mutation == "bool": fixture.display["capabilities"]["display"] = 1
    elif mutation == "owner": fixture.display["request_scope_epoch"] = "other:1"
    elif mutation == "count": fixture.display["device_cell_count"] = 3
    else: fixture.display["magnetization"] = [1., 0., 0.]
    with pytest.raises(metadata_smoke.SmokeError): fixture.run()


@pytest.mark.parametrize("kind", list(display_smoke.CURRENT_CARRIERS))
def test_resigned_carrier_cannot_disagree_with_native_local_samples(kind):
    fixture = FrozenInspection(2)
    data = bytearray(fixture.payloads[kind])
    data[:8] = struct.pack("<d", 999.)
    fixture.payloads[kind] = bytes(data)
    name = display_smoke.CURRENT_CARRIERS[kind][0]
    fixture.display["device_current"][name]["sha256"] = sha256(data).hexdigest()
    with pytest.raises(metadata_smoke.SmokeError, match="retained native cell-local samples"):
        fixture.run()


@pytest.mark.parametrize("mutation", ["layout", "unit", "count", "sha", "path", "receipt", "snapshot"])
def test_current_metadata_invalidity_precedes_binary_io(mutation):
    fixture = FrozenInspection(2)
    current = fixture.display["device_current"]
    if mutation == "receipt": current["receipt"]["current_evaluator_version"] = "synthetic"
    elif mutation == "snapshot": current["ordered_snapshot"]["sha256"] = "0" * 64
    else:
        key, value = {"layout": ("layout", "node_vector"), "unit": ("unit", "A"), "count": ("value_count", 7),
                      "sha": ("sha256", "Z" * 64), "path": ("path", "../current.bin")}[mutation]
        current["center_current_density"][key] = value
    with pytest.raises(metadata_smoke.SmokeError): fixture.run()
    assert not any("/payloads/" in path for path, _ in fixture.calls)


@pytest.mark.parametrize("status", [304, 206, 416])
def test_current_transport_cannot_drift_etags_ranges_or_stale_cache(status):
    fixture = FrozenInspection(2)
    def broken(*args):
        response = fixture.serve(*args)
        if "/current_trace_density?" in args[1] and response.status == status:
            return metadata_smoke.HttpResult(status, {**response.headers, "etag": '"different"'}, response.body)
        return response
    with pytest.raises(metadata_smoke.SmokeError): fixture.run(fetch=broken)


def test_stale_current_scope_must_reject_before_wildcard_304_or_range():
    fixture = FrozenInspection(2)
    def broken(*args):
        response = fixture.serve(*args)
        if "/current_snapshot?" in args[1] and "-stale-smoke" in args[2].get("x-fullmag-session-scope", ""):
            return metadata_smoke.HttpResult(304, {"etag": '"current_snapshot"', "cache-control": "no-cache"}, b"")
        return response
    with pytest.raises(metadata_smoke.SmokeError, match="409"): fixture.run(fetch=broken)


def test_final_display_revision_change_invalidates_all_payloads():
    fixture = FrozenInspection(2)
    display_conditional_reads = 0
    def changed(*args):
        nonlocal display_conditional_reads
        response = fixture.serve(*args)
        if "/display?" in args[1] and args[2].get("If-None-Match") == '"display"':
            display_conditional_reads += 1
            if display_conditional_reads == 2:
                return metadata_smoke.HttpResult(200, {"etag": '"other"'}, b"{}")
        return response
    with pytest.raises(metadata_smoke.SmokeError, match="revision changed"): fixture.run(fetch=changed)


@pytest.mark.parametrize("mutation", ["pin", "order", "source_index", "vertex_id", "nonfinite", "negative_zero", "trailing"])
def test_resigned_snapshot_cannot_hide_broken_framing_geometry_or_pins(mutation):
    fixture = FrozenInspection(2)
    rows = framing.fields(fixture.payloads["current_snapshot"])
    if mutation == "trailing": rows.append(("extra", 2, 0))
    else:
        field = {"pin": "bundle_content_sha256", "source_index": "source_element_index", "vertex_id": "vertex_id",
                 "nonfinite": "vertex_current_apm2", "negative_zero": "center_current_apm2"}.get(mutation)
        if mutation == "order": rows[0], rows[1] = rows[1], rows[0]
        else:
            index = next(i for i, row in enumerate(rows) if row[0] == field)
            value = {"pin": "0" * 64, "source_index": 1, "vertex_id": 9,
                     "nonfinite": float("nan"), "negative_zero": -0.0}[mutation]
            rows[index] = (field, rows[index][1], value)
    payload = encode(rows)
    fixture.payloads["current_snapshot"] = payload
    receipt = fixture.resource["manifest"]["current_display"]
    receipt["payload"] = descriptor(payload, *metadata_smoke.CURRENT_PAYLOAD)
    fixture.display["device_current"]["receipt"] = copy.deepcopy(receipt)
    fixture.display["device_current"]["ordered_snapshot"] = copy.deepcopy(receipt["payload"])
    for module in (metadata_smoke, display_smoke):
        with pytest.raises(metadata_smoke.SmokeError, match="bounded current snapshot"):
            fixture.run(module)


def test_current_payload_hash_and_nonfinite_vectors_cannot_be_accepted():
    fixture = FrozenInspection(2)
    fixture.payloads["current_center_density"] = struct.pack("<6d", float("inf"), 0., 0., 0., 0., 0.)
    with pytest.raises(metadata_smoke.SmokeError, match="SHA"):
        fixture.run()
    fixture.display["device_current"]["center_current_density"]["sha256"] = sha256(fixture.payloads["current_center_density"]).hexdigest()
    with pytest.raises(metadata_smoke.SmokeError, match="finite"):
        fixture.run()


def test_route_admission_checks_cover_current_payload_kinds_and_required_digest():
    template = "/v2/sessions/current/data/antenna/stages/{stage_id}/external-lead-inspection"
    calls = []
    spec = {"paths": {template + "/display": {"get": {"parameters": [
        {"name": "content_digest", "in": "query", "required": True}]}}},
        "components": {"schemas": {name: {} for name in (
            "AntennaInspectionDisplayResource", "AntennaInspectionCurrentReceiptResource",
            "AntennaInspectionCurrentDisplayResource")}}}
    def serve(origin, path, headers, limit):
        calls.append(path)
        if path == "/v2/platform/openapi.json":
            status, body = 200, spec
        elif "/payloads/not-a-quantity?" in path:
            status, body = 400, {"message": "unknown inspection payload kind"}
        elif "/payloads/" in path:
            status, body = 404, {"code": "missing_stage"}
        else:
            status, body = 400, {"message": "invalid inspection display query: fixture"}
        return metadata_smoke.HttpResult(status, {"content-type": "application/json"}, json.dumps(body).encode())
    with patch.object(display_smoke, "request", side_effect=serve):
        assert display_smoke.verify_route_contract("http://127.0.0.1:8080")["status"] == "passed"
    assert {path.split("/payloads/")[1].split("?")[0] for path in calls if "/payloads/" in path} == {
        "device_positions", "device_topology", "current_snapshot", "not-a-quantity", *display_smoke.CURRENT_CARRIERS}
    spec["components"]["schemas"].pop("AntennaInspectionCurrentReceiptResource")
    with patch.object(display_smoke, "request", side_effect=serve), pytest.raises(metadata_smoke.SmokeError, match="schemas"):
        display_smoke.verify_route_contract("http://127.0.0.1:8080")


@pytest.mark.parametrize("generation", [1, 2])
@pytest.mark.parametrize("count_name", ["vertices", "elements"])
@pytest.mark.parametrize("count", [0, (1 << 64) - 1])
def test_resigned_bundle_counts_are_admitted_before_group_iteration(generation, count_name, count):
    fixture = FrozenInspection(generation)
    outer = framing.fields(fixture.payloads["bundle"])
    charge = framing.fields(framing.one(outer, "charge_record", 3))
    charge = [(name, tag, count if name == count_name else value) for name, tag, value in charge]
    charge_bytes = encode(charge)
    charge_sha = sha256(charge_bytes).hexdigest()
    source = framing.fields(framing.one(outer, "source_record", 3))
    source = [(name, tag, charge_sha if name == "charge_content_digest" else value) for name, tag, value in source]
    source_bytes = encode(source)
    source_sha = sha256(source_bytes).hexdigest()
    replacements = {"charge_record": charge_bytes, "charge_content_sha256": charge_sha,
                    "source_record": source_bytes, "source_content_sha256": source_sha}
    bundle = encode([(name, tag, replacements.get(name, value)) for name, tag, value in outer])
    fixture.payloads["bundle"] = bundle
    fixture.resource["manifest"]["bundle"] = descriptor(bundle, *metadata_smoke.PAYLOADS["bundle"])
    if generation == 2:
        replacements = {"bundle_content_sha256": sha256(bundle).hexdigest(),
                        "charge_content_sha256": charge_sha, "source_content_sha256": source_sha}
        snapshot = encode([(name, tag, replacements.get(name, value))
                           for name, tag, value in framing.fields(fixture.payloads["current_snapshot"])])
        fixture.payloads["current_snapshot"] = snapshot
        receipt = fixture.resource["manifest"]["current_display"]
        receipt["payload"] = descriptor(snapshot, *metadata_smoke.CURRENT_PAYLOAD)
        fixture.display["device_current"]["receipt"] = copy.deepcopy(receipt)
        fixture.display["device_current"]["ordered_snapshot"] = copy.deepcopy(receipt["payload"])
    original_group = framing.group
    def admitted_group(rows, name, expected_count, layout, **kwargs):
        assert 0 < expected_count <= len(rows) // len(layout), "unadmitted count reached iteration"
        return original_group(rows, name, expected_count, layout, **kwargs)
    with patch.object(framing, "group", side_effect=admitted_group), pytest.raises(
            metadata_smoke.SmokeError, match="invalid bounded bundle framing"):
        fixture.run()
