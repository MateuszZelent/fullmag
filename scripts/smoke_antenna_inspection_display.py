#!/usr/bin/env python3
"""Read-only display HTTP checks, not solver or scientific qualification.

Bundle framing comparison is independently bounded to the fixture decoder's
2 MiB limit. Native integrity validation remains authoritative.
"""
import argparse
import json
import struct
from uuid import uuid4
from urllib.parse import quote, urlencode

import antenna_rt0_fixture_check as framing
from antenna_current_display_fixture_check import bounded_count
from smoke_antenna_external_lead_inspection import (
    MAX_METADATA_BYTES, PAYLOADS, SmokeError, json_body, request, require,
    session_scope, strong_etag, validate_descriptor, validate_origin, validate_resource, verify_binary,
)

CURRENT_CARRIERS = {
    "current_center_positions": ("center_positions", "cell_xyz_interleaved", "m", 3),
    "current_center_density": ("center_current_density", "cell_vector_xyz_interleaved", "A/m^2", 3),
    "current_trace_positions": ("trace_positions", "cell_local_vertex_xyz_interleaved", "m", 12),
    "current_trace_density": ("trace_current_density", "cell_local_vertex_vector_xyz_interleaved", "A/m^2", 12),
}


def verify_route_contract(origin):
    """Read-only admission checks; never claim a published numerical result."""
    spec = json_body(request(origin, "/v2/platform/openapi.json", {}, 4 << 20), 200)
    template = "/v2/sessions/current/data/antenna/stages/{stage_id}/external-lead-inspection"
    operation = spec["paths"][template + "/display"]["get"]
    require(any(parameter.get("name") == "content_digest" and parameter.get("in") == "query"
                and parameter.get("required") is True for parameter in operation["parameters"]),
            "display OpenAPI must require the immutable content digest")
    require(all(schema in spec["components"]["schemas"] for schema in (
        "AntennaInspectionDisplayResource", "AntennaInspectionCurrentReceiptResource",
        "AntennaInspectionCurrentDisplayResource")), "display/current schemas are absent from live OpenAPI")
    path = template.replace("{stage_id}", "missing-display-probe-" + uuid4().hex)
    missing = json_body(request(origin, path + "/display", {}, MAX_METADATA_BYTES), 400)
    require(missing.get("message", "").startswith("invalid inspection display query:"),
            "missing digest did not reach the display query guard")
    unknown = urlencode({"content_digest": "sha256:" + "0" * 64, "unexpected": "1"})
    json_body(request(origin, path + "/display?" + unknown, {}, MAX_METADATA_BYTES), 400)
    query = urlencode({"content_digest": "sha256:" + "0" * 64})
    for kind in ("device_positions", "device_topology", *CURRENT_CARRIERS, "current_snapshot"):
        # These kinds must be admitted by the binary router but cannot invent
        # a result for an unregistered stage (or an absent current session).
        json_body(request(origin, path + f"/payloads/{kind}?{query}", {}, MAX_METADATA_BYTES), 404)
    invalid = json_body(request(origin, path + "/payloads/not-a-quantity?" + query,
                                {}, MAX_METADATA_BYTES), 400)
    require(invalid.get("message") == "unknown inspection payload kind", "unknown payload kind admitted")
    return {"status": "passed", "qualification": "live route/query guards only, no published data or solver",
            "build_identity": spec.get("x-fullmag-build-identity")}


def verify(origin, stage_id):
    origin = validate_origin(origin)
    require(isinstance(stage_id, str) and bool(stage_id.strip()) and len(stage_id) <= 4096
            and "\0" not in stage_id, "invalid runtime stage ID")
    path = f"/v2/sessions/current/data/antenna/stages/{quote(stage_id, safe='')}/external-lead-inspection"
    metadata = request(origin, path, {}, MAX_METADATA_BYTES)
    resource = json_body(metadata, 200)
    metadata_etag = strong_etag(metadata)
    manifest, digest = validate_resource(resource, stage_id)
    require(isinstance(manifest.get("source_object_id"), str) and bool(manifest["source_object_id"].strip()),
            "missing source object identity")
    has_current = "current_display" in manifest
    headers = {"x-fullmag-session-scope": session_scope(resource, resource["request_scope_epoch"])}
    query = urlencode({"content_digest": digest})
    response = request(origin, f"{path}/display?{query}", headers, MAX_METADATA_BYTES)
    display = json_body(response, 200)
    expected_keys = {"schema_version", "resource_id", "session_id", "session_epoch", "request_scope_epoch",
        "run_id", "runtime_stage_id", "stage_revision", "record_content_digest", "content_digest", "source_object_id",
        "status", "qualification", "field_scope", "normalization", "capabilities", "device_node_count",
        "device_cell_count", "sampling_carrier", "device_positions", "device_topology", "device_potential",
        "sample_positions", "magnetic_field"}
    require(set(display) == expected_keys | ({"device_current"} if has_current else set()),
            "unexpected display schema fields or quantity promotion")
    for key, value in {
        "schema_version": "antenna_inspection_display.v2" if has_current else "antenna_inspection_display.v1", "status": "inspection_only",
        "qualification": "NOT VERIFIED", "field_scope": "external_electrode_truncation",
        "normalization": "raw_authored_current", "content_digest": digest,
        "runtime_stage_id": stage_id, "record_content_digest": resource["record_content_digest"],
        "resource_id": resource["resource_id"] + "/display", "source_object_id": manifest["source_object_id"],
        "sampling_carrier": manifest["sampling_carrier"],
    }.items():
        require(display.get(key) == value, f"display {key} mismatch")
    for key in ("session_id", "session_epoch", "request_scope_epoch", "run_id", "stage_revision"):
        require(type(display.get(key)) is type(resource[key]) and display[key] == resource[key],
                f"display owner {key} mismatch")
    require(display.get("capabilities") == {"display": True, "per_ampere_basis": False,
        "source_fft": False, "llg_drive": False, "current_density": has_current}
        and all(type(value) is bool for value in display["capabilities"].values()), "display capability promotion")
    etag = strong_etag(response)
    cached = request(origin, f"{path}/display?{query}", {**headers, "If-None-Match": etag}, MAX_METADATA_BYTES)
    require(cached.status == 304 and not cached.body and strong_etag(cached) == etag,
            "display conditional response mismatch")
    payloads = {}
    specs = {
        "device_positions": ("display/device_positions.bin", "float64_le", "node_xyz_interleaved", "m", 8),
        "device_topology": ("display/device_topology.bin", "uint32_le", "tet4_connectivity", "1", 4),
        **{kind: PAYLOADS[kind] for kind in ("device_potential", "sample_positions", "magnetic_field")},
    }
    descriptors = {kind: display.get(kind) for kind in specs}
    for kind, spec in specs.items():
        validate_descriptor(descriptors[kind], kind, spec)
        if kind in manifest:
            require(descriptors[kind] == manifest[kind], f"{kind} display/manifest mismatch")
    if has_current:
        current = display.get("device_current")
        require(isinstance(current, dict) and set(current) == {"receipt", "ordered_snapshot"}
                | {value[0] for value in CURRENT_CARRIERS.values()}, "invalid current display shape")
        require(current["receipt"] == manifest["current_display"], "current display/manifest receipt mismatch")
        require(current["ordered_snapshot"] == current["receipt"]["payload"], "current snapshot descriptor mismatch")
        for kind, (name, layout, unit, per_cell) in CURRENT_CARRIERS.items():
            descriptors[kind] = current[name]
            validate_descriptor(descriptors[kind], kind, (f"display/{kind}.bin", "float64_le", layout, unit, 8))
            require(descriptors[kind]["value_count"] == current["receipt"]["cell_count"] * per_cell,
                    f"{kind} cell cardinality mismatch")
        descriptors["current_snapshot"] = current["ordered_snapshot"]
        require(descriptors["current_snapshot"]["byte_count"] <= framing.LIMIT,
                "current snapshot exceeds bounded fixture comparison support")
    else:
        require("device_current" not in display, "legacy display cannot declare current")
    node_count, cell_count = display.get("device_node_count"), display.get("device_cell_count")
    require(type(node_count) is int and node_count > 0 and type(cell_count) is int and cell_count > 0,
            "invalid device cardinality")
    require(display["device_positions"]["value_count"] == node_count * 3
            and display["device_potential"]["value_count"] == node_count
            and display["device_topology"]["value_count"] == cell_count * 4, "device cardinality mismatch")
    require(display["sample_positions"]["value_count"] == display["magnetic_field"]["value_count"], "H carrier mismatch")
    require(not has_current or current["receipt"]["cell_count"] == cell_count, "J/device carrier mismatch")
    descriptors.update({kind: manifest[kind] for kind in ("device_vertex_ids", "bundle")})
    require(descriptors["bundle"]["byte_count"] <= framing.LIMIT,
            "bundle exceeds bounded fixture comparison support")
    for kind, desc in descriptors.items():
        payloads[kind], _ = verify_binary(origin, f"{path}/payloads/{kind}?{query}", headers,
                                          kind, desc, fetch=request)
    ids = [row[0] for row in struct.iter_unpack("<Q", payloads["device_vertex_ids"])]
    require(len(ids) == node_count and len(set(ids)) == len(ids), "device IDs cardinality/uniqueness mismatch")
    try:
        outer = framing.fields(payloads["bundle"])
        charge = framing.fields(framing.one(outer, "charge_record", 3))
        vertices = framing.group(charge, "vertices", bounded_count(charge, "vertices", 8),
            [("vertex_id", 2)] + [("xyz_m", 4)] * 3 + [("potential_v", 4), ("reaction_a", 4), ("vertex_component_id", 2)], skip=1)
        elements = framing.group(charge, "elements", bounded_count(charge, "elements", 6),
            [("attribute", 2)] + [("vertex_id", 2)] * 4 + [("conductivity_spm", 4)])
    except (ValueError, UnicodeError) as error:
        raise SmokeError("invalid bounded bundle framing") from error
    by_id = {row[0]: row for row in vertices}
    require(len(by_id) == len(vertices) and all(identity in by_id for identity in ids),
            "device IDs repeated or missing from retained vertices")
    expected_xyz = b"".join(struct.pack("<d", value) for identity in ids for value in by_id[identity][1:4])
    require(expected_xyz == payloads["device_positions"], "device XYZ differs from retained ordered IDs")
    expected_v = b"".join(struct.pack("<d", by_id[identity][4]) for identity in ids)
    require(expected_v == payloads["device_potential"], "device V differs from retained ordered IDs")
    indices = {identity: index for index, identity in enumerate(ids)}
    expected_cells = []
    for row in elements:
        owned = [identity in indices for identity in row[1:5]]
        require(not any(owned) or all(owned), "mixed device/lead tetrahedron")
        if all(owned):
            expected_cells.extend(indices[identity] for identity in row[1:5])
    require(b"".join(struct.pack("<I", value) for value in expected_cells) == payloads["device_topology"], "device topology differs from retained bundle")
    if has_current:
        from antenna_current_display_fixture_check import decode_current_snapshot
        try:
            samples = decode_current_snapshot(payloads["current_snapshot"], bundle_bytes=payloads["bundle"],
                                              receipt=current["receipt"])
        except (ValueError, UnicodeError) as error:
            raise SmokeError("invalid bounded current snapshot/bundle association") from error
        require(len(samples) == cell_count, "current snapshot decoded cell count mismatch")
        for kind, values in {
            "current_center_positions": (sample["center_position_m"] for sample in samples),
            "current_center_density": (sample["center_current_apm2"] for sample in samples),
            "current_trace_positions": (row for sample in samples for row in sample["vertex_positions_m"]),
            "current_trace_density": (row for sample in samples for row in sample["vertex_current_apm2"]),
        }.items():
            expected = b"".join(struct.pack("<d", value) for row in values for value in row)
            require(expected == payloads[kind], f"{kind} differs from retained native cell-local samples")
    wrong = urlencode({"content_digest": "sha256:" + ("0" * 64 if digest != "sha256:" + "0" * 64 else "1" * 64)})
    require(request(origin, f"{path}/display?{wrong}", headers, MAX_METADATA_BYTES).status == 409, "stale display digest accepted")
    stale = {"x-fullmag-session-scope": session_scope(resource, resource["request_scope_epoch"] + "-stale-smoke"),
             "If-None-Match": "*", "Range": "bytes=0-7"}
    for stale_path in [f"{path}/display?{query}"] + [f"{path}/payloads/{kind}?{query}" for kind in descriptors]:
        require(json_body(request(origin, stale_path, stale, MAX_METADATA_BYTES), 409).get("error")
                == "request_context_stale", "stale display request scope accepted")
    for resource_path, pinned_etag in ((f"{path}/display?{query}", etag), (path, metadata_etag)):
        final = request(origin, resource_path, {**headers, "If-None-Match": pinned_etag}, MAX_METADATA_BYTES)
        require(final.status == 304 and not final.body and strong_etag(final) == pinned_etag,
                "inspection revision changed during display smoke")
    return {"status": "passed", "qualification": "HTTP display transport only, not native scientific qualification",
            "physics_qualified": False, "native_canonical_bundle_redecoded": False,
            "runtime_stage_id": stage_id, "device_nodes": node_count, "device_cells": cell_count,
            "current_density_display_checked": has_current, "payloads_checked": list(descriptors)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--origin", default="http://127.0.0.1:8081")
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument("--stage-id")
    selection.add_argument("--route-only", action="store_true")
    args = parser.parse_args()
    print(json.dumps(verify_route_contract(args.origin) if args.route_only
                     else verify(args.origin, args.stage_id), indent=2))
