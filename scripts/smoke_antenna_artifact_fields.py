#!/usr/bin/env python3
"""Read-only canonical H/J/V HTTP gate; no solver/science qualification."""
import argparse
from hashlib import sha256
import json
import math
import struct
from urllib.parse import quote, urlencode

from smoke_antenna_external_lead_inspection import (
    MAX_BINARY_BYTES, MAX_METADATA_BYTES, SmokeError, json_body, request, require,
    session_scope, validate_descriptor, validate_origin, validate_resource, verify_binary,
)

ROOT = "/v2/sessions/current/data"


def closed_geometry(quantity, payloads):
    """Native closed-loop layouts owned by inspection_field_provider::from_closed."""
    cells = list(struct.iter_unpack("<5Q30d", payloads["cells"]))
    ids = [v[0] for v in struct.iter_unpack("<Q", payloads["stable_vertex_ids"])]
    if quantity == "V_electric":
        by_id = {value: i for i, value in enumerate(ids)}
        return (4, payloads["vertex_xyz"], payloads["stable_vertex_ids"],
                b"".join(struct.pack("<4I", *(by_id[v] for v in row[1:5])) for row in cells))
    if quantity == "J_charge":
        return (7, b"".join(struct.pack("<12d", *row[5:17]) for row in cells),
                b"".join(struct.pack("<QB7xQ", row[0], local, row[1+local])
                         for row in cells for local in range(4)),
                b"".join(struct.pack("<4I", *(4*i+j for j in range(4))) for i in range(len(cells))))
    require(quantity == "H_ant", "unsupported closed-loop geometry")
    positions = payloads["sample_xyz"]
    return (5, positions, b"".join(struct.pack("<Q", i) for i in range(len(positions)//24)), payloads["sample_cells"])


def verify_closed_geometry(vector, topology, locator, expected):
    """Decode FMMI4 identity and FMMT2 Tet4 sections; never round native u64 IDs."""
    indexing, positions, identities, connectivity = expected
    count, cells = len(positions)//24, len(connectivity)//16
    size = struct.unpack_from("<I", vector, 8)[0]
    block = vector[48:48+size]
    require(len(block) == size and len(block) >= 88 and block[:8] == b"FMMI\x04\x00\x00\x00", "invalid FMMI4 block")
    generation_len, kind_len, source_len, field_len = struct.unpack_from("<4H", block, 8)
    scope_len, scope_id_len = struct.unpack_from("<2H", block, 64)
    require(struct.unpack_from("<Q", block, 16)[0] == int(locator["carrier_revision"])
            and block[24:56].hex() == locator["carrier_digest"], "mapping carrier identity differs")
    require(struct.unpack_from("<II", block, 56) == (indexing, count)
            and struct.unpack_from("<III", block, 76) == (24 if indexing == 7 else 8, indexing, 0), "mapping indexing/stride differs")
    lengths = (scope_len, scope_id_len, generation_len, kind_len, source_len, field_len)
    offset, strings = 88, []
    for length in lengths:
        require(offset+length <= len(block), "truncated mapping string")
        strings.append(block[offset:offset+length].decode("utf-8"))
        offset += length
    require(strings[:4] == [locator["carrier_scope_kind"], locator["carrier_scope_id"] or "", locator["carrier_digest"], "artifact_inspection"], "mapping source/scope differs")
    if "owner" in locator:
        require(strings[4:] == [locator["owner"]["source_digest"], locator["owner"]["content_digest"]], "mapping source generation differs")
    require(block[offset:offset+len(identities)] == identities, "native u64 sample identities differ")
    offset += len(identities)
    require(len(block) == (offset+7)//8*8 and not any(block[offset:]), "mapping trailing data/padding differs")
    require(len(topology) >= 64 and topology[:8] == b"FMMT\x02\x01\x00\x00", "invalid FMMT2 header")
    require(struct.unpack_from("<8I", topology, 8) == (count, cells, 0, 4*cells, 0, 0, 0, 64), "topology dimensions/sections differ")
    require(struct.unpack_from("<II", topology, 40) == (cells, 0) and not any(topology[48:64]), "unexpected topology ordinal sections")
    offset = 64
    for section in (positions, struct.pack("<"+"I"*cells, *([1]*cells)),
                    struct.pack("<"+"I"*(cells+1), *(4*i for i in range(cells+1))), connectivity,
                    b"", b"", struct.pack("<I", 0), b"", b"", b"",
                    struct.pack("<"+"Q"*cells, *range(cells))):
        aligned = (offset+7)//8*8
        require(not any(topology[offset:aligned]) and topology[aligned:aligned+len(section)] == section, "native geometry/connectivity differs")
        offset = aligned+len(section)
    require(len(topology) == offset, "unexpected topology trailing data")
    return {"positions_sha256": sha256(positions).hexdigest(),
            "sample_identity_sha256": sha256(identities).hexdigest(),
            "connectivity_sha256": sha256(connectivity).hexdigest()}


def verify_external_positions(topology, positions, point_count):
    """Bind canonical field coordinates to retained display order, without fixture decoding."""
    require(type(point_count) is int and 0 < point_count <= MAX_BINARY_BYTES // 24,
            "invalid external sample count")
    require(len(positions) == point_count * 24
            and all(math.isfinite(value) for (value,) in struct.iter_unpack("<d", positions)),
            "invalid retained external positions")
    require(len(topology) >= 64 + len(positions) and topology[:8] == b"FMMT\x02\x01\x00\x00"
            and struct.unpack_from("<I", topology, 8)[0] == point_count
            and struct.unpack_from("<I", topology, 36)[0] == 64 and not any(topology[48:64]),
            "external topology framing/cardinality differs")
    require(topology[64:64 + len(positions)] == positions,
            "canonical coordinates/order differ from retained external display")
    return {"positions_sha256": sha256(positions).hexdigest()}


def verify(origin, stage_id):
    origin = validate_origin(origin)
    require(isinstance(stage_id, str) and 0 < len(stage_id) <= 4096 and "\0" not in stage_id, "invalid stage")
    inspection = f"{ROOT}/antenna/stages/{quote(stage_id, safe='')}/external-lead-inspection"
    resource = json_body(request(origin, inspection, {}, MAX_METADATA_BYTES), 200)
    closed_loop = resource.get("schema_version") == "antenna_closed_loop_stage_output.v2"
    if closed_loop:
        from smoke_antenna_closed_loop_inspection import validate_resource as validate_closed_loop
        manifest, digest = validate_closed_loop(resource, stage_id)
    else:
        manifest, digest = validate_resource(resource, stage_id)
    headers = {"x-fullmag-session-scope": session_scope(resource, resource["request_scope_epoch"]),
               "Origin": "http://127.0.0.1:3276"}
    scoped = urlencode({"stage_id": stage_id})
    fields = json_body(request(origin, f"{ROOT}/fields?{scoped}", headers, MAX_METADATA_BYTES), 200)
    quantities = json_body(request(origin, f"{ROOT}/quantities?{scoped}", headers, MAX_METADATA_BYTES), 200)
    display = json_body(request(origin, f"{inspection}/display?{urlencode({'content_digest': digest})}", headers, MAX_METADATA_BYTES), 200)
    if closed_loop:
        require(display.get("closed_loop_display") == manifest, "closed-loop display manifest mismatch")
        expected = {quantity: (unit, components, {**manifest["payloads"][kind],
                    "byte_count": manifest["payloads"][kind]["byte_length"], "scalar_type": "opaque"}, kind)
                    for quantity, unit, components, kind in (
                        ("H_ant", "A/m", 3, "h_raw"), ("V_electric", "V", 1, "v_raw"),
                        ("J_charge", "A/m^2", 3, "j_local_raw"))}
    else:
        for key in ("session_id", "session_epoch", "request_scope_epoch", "run_id", "runtime_stage_id",
                    "stage_revision", "record_content_digest"):
            require(display.get(key) == resource[key], f"external display owner {key} mismatch")
        require(display.get("content_digest") == digest and display.get("source_object_id") == manifest["source_object_id"]
                and display.get("status") == "inspection_only", "external display identity/status mismatch")
        expected = {"H_ant": ("A/m", 3, display["magnetic_field"], "magnetic_field"),
                    "V_electric": ("V", 1, display["device_potential"], "device_potential")}
        if "current_display" in manifest:
            expected["J_charge"] = ("A/m^2", 3, display["device_current"]["trace_current_density"], "current_trace_density")
    require({row["quantity_id"] for row in fields["quantities"]} == set(expected), "unexpected retained field catalog")
    require({row["id"] for row in quantities["quantities"]} == set(expected), "unexpected retained quantity catalog")
    native_geometry = {}
    if closed_loop:
        for kind in ("cells", "stable_vertex_ids", "vertex_xyz", "sample_xyz", "sample_cells"):
            descriptor = manifest["payloads"][kind]
            native_geometry[kind], _ = verify_binary(origin,
                f"{inspection}/payloads/{kind}?{urlencode({'content_digest': digest})}", headers, kind,
                {**descriptor, "byte_count": descriptor["byte_length"], "scalar_type": "opaque"})
    results = {}
    for quantity, (unit, components, descriptor, payload_kind) in expected.items():
        entry = next(row for row in fields["quantities"] if row["quantity_id"] == quantity)
        locator = entry["artifact_field_locator"]
        require(entry["unit"] == unit and entry["components"] == components and entry["state"] == "stale_complete", "catalog units/state mismatch")
        owner = locator["owner"]
        for key in ("session_id", "session_epoch", "request_scope_epoch", "run_id", "runtime_stage_id"):
            require(owner[key] == resource[key], f"owner {key} mismatch")
        require(owner["authored_stage_id"] == resource["stage_id"] and owner["content_digest"] == digest
                and owner["object_id"] == manifest["source_object_id"] and owner["historical_inspection"] is True, "immutable result owner mismatch")
        pin = {"stage_id": stage_id, "carrier_id": locator["carrier_id"], "expected_carrier_revision": locator["carrier_revision"]}
        field_query = {**pin, "component": "full", "geometry_scope": "full", "scope_kind": locator["carrier_scope_kind"],
                       "expected_generation_id": locator["carrier_digest"]}
        if locator["carrier_scope_id"] is not None:
            field_query["scope_id"] = locator["carrier_scope_id"]
        meta = json_body(request(origin, f"{ROOT}/fields/{quantity}/meta?{urlencode(field_query)}", headers, MAX_METADATA_BYTES), 200)
        require(meta["artifact_field_locator"] == locator and meta["unit"] == unit and meta["state"] == "stale_complete", "meta/catalog mismatch")
        vector_path = f"{ROOT}/fields/{quantity}/samples/vector?{urlencode(field_query)}"
        topology_path = f"{ROOT}/domain/topology?{urlencode(pin)}"
        payload, _ = verify_binary(origin, f"{inspection}/payloads/{payload_kind}?{urlencode({'content_digest': digest})}", headers, payload_kind, descriptor)
        binaries = {}
        for name, path in (("vector", vector_path), ("topology", topology_path)):
            response = request(origin, path, headers, MAX_BINARY_BYTES)
            require(response.status == 200, f"{quantity} {name}: HTTP {response.status}")
            for key, value in (("id", locator["carrier_id"]), ("digest", locator["carrier_digest"]), ("revision", locator["carrier_revision"])):
                require(response.headers.get(f"x-fullmag-carrier-{key}") == value, f"binary carrier {key} mismatch")
            exposed = {name.strip().lower() for name in response.headers.get("access-control-expose-headers", "").split(",")}
            require({"etag", "content-range", "x-fullmag-carrier-id", "x-fullmag-carrier-digest", "x-fullmag-carrier-revision"} <= exposed, "missing browser identity headers")
            body, etag = verify_binary(origin, path, headers, name, {"byte_count": len(response.body), "sha256": sha256(response.body).hexdigest(), "scalar_type": "framed_binary"})
            stale = {**headers, "x-fullmag-session-scope": session_scope(resource, resource["request_scope_epoch"] + "-stale-smoke"), "If-None-Match": etag, "Range": "bytes=0-7"}
            require(request(origin, path, stale, MAX_METADATA_BYTES).status == 409, "stale session bypassed conditional/range admission")
            binary_query = field_query if name == "vector" else pin
            wrong_revision = "2" if locator["carrier_revision"] == "1" else "1"
            wrong = dict(binary_query, expected_carrier_revision=wrong_revision)
            require(request(origin, path.split("?")[0] + "?" + urlencode(wrong), headers, MAX_METADATA_BYTES).status == 409, "wrong carrier revision accepted")
            for missing in ("stage_id", "carrier_id", "expected_carrier_revision"):
                incomplete = {key: value for key, value in binary_query.items() if key != missing}
                conditional = {**headers, "If-None-Match": etag, "Range": "bytes=0-7"}
                require(request(origin, path.split("?")[0] + "?" + urlencode(incomplete), conditional,
                                MAX_METADATA_BYTES).status == 400, f"missing {missing} bypassed binary admission")
            binaries[name] = body
        for rejected_query, expected_status in (
            ({**field_query, "expected_generation_id": "foreign-generation"}, 409),
            ({**field_query, "scope_kind": "object", "scope_id": "foreign-object"}, 400),
            ({**field_query, "owner_object_id": "foreign-object"}, 409),
            ({**field_query, "expected_carrier_revision": "0"}, 400),
        ):
            require(request(origin, vector_path.split("?")[0] + "?" + urlencode(rejected_query), headers,
                            MAX_METADATA_BYTES).status == expected_status, "invalid owner/generation/scope/revision accepted")
        vector = binaries["vector"]
        require(len(vector) >= 48 and vector[:7] == b"FMVP\x06\x01" + bytes([components]), "wrong field framing")
        metadata_size, value_count, point_count = struct.unpack_from("<III", vector, 8)
        require(point_count == locator["sample_count"] and value_count == point_count * components
                and vector[48:54] == b"FMMI\x04\x00", "field/mapping cardinality mismatch")
        raw = vector[48 + metadata_size:]
        require(len(raw) == value_count * 8 and raw == payload, "canonical field values differ from retained native display payload")
        require(all(math.isfinite(value) for (value,) in struct.iter_unpack("<d", raw)), "nonfinite retained samples")
        topology = binaries["topology"]
        require(len(topology) >= 64 and topology[:6] == b"FMMT\x02\x01"
                and struct.unpack_from("<I", topology, 8)[0] == point_count, "topology/sample cardinality mismatch")
        if closed_loop:
            geometry_identity = verify_closed_geometry(vector, topology, locator,
                closed_geometry(quantity, native_geometry))
        else:
            if quantity == "J_charge":
                position_kind, position_descriptor, layout = (
                    "current_trace_positions", display["device_current"]["trace_positions"],
                    "cell_local_vertex_xyz_interleaved")
            else:
                position_kind, layout = (("device_positions", "node_xyz_interleaved")
                                         if quantity == "V_electric" else ("sample_positions", "sample_xyz_interleaved"))
                position_descriptor = display[position_kind]
            position_path = ("sample_positions.f64le.bin" if quantity == "H_ant"
                             else f"display/{position_kind}.bin")
            validate_descriptor(position_descriptor, position_kind,
                                (position_path, "float64_le", layout, "m", 8))
            positions, _ = verify_binary(origin,
                f"{inspection}/payloads/{position_kind}?{urlencode({'content_digest': digest})}",
                headers, position_kind, position_descriptor)
            geometry_identity = verify_external_positions(topology, positions, point_count)
        results[quantity] = {**geometry_identity,"unit": unit, "components": components, "samples": point_count,
                             "carrier_id": locator["carrier_id"], "values_sha256": sha256(raw).hexdigest(),
                             "vector_sha256": sha256(vector).hexdigest(), "topology_sha256": sha256(topology).hexdigest()}
    final_resource = json_body(request(origin, inspection, headers, MAX_METADATA_BYTES), 200)
    require(final_resource == resource, "inspection owner or artifact changed during HTTP checks")
    return {"schema": "fullmag.antenna_artifact_fields_http.v1", "status": "passed", "origin": origin,
            "runtime_stage_id": stage_id, "run_id": resource["run_id"], "fields": results,
            "inspection_family": "closed_loop" if closed_loop else "external_lead",
            "qualification": "actual_read_only_HTTP_and_retained_payload_identity_only",
            "production_frontend_codec_qualified": False, "physics_qualified": False, "cold_load_qualified": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--stage-id", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.origin, args.stage_id), sort_keys=True))
        return 0
    except (SmokeError, KeyError, TypeError, ValueError, struct.error) as error:
        print(json.dumps({"status": "failed", "error": str(error), "physics_qualified": False}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
