#!/usr/bin/env python3
"""Read-only bounded HTTP checks for saved V/J/H; no solver or physics claim."""
from __future__ import annotations
import argparse
from hashlib import sha256
import json
import math
import re
import struct
from urllib.parse import quote, urlencode
from smoke_antenna_external_lead_inspection import SmokeError, json_body, request, require, validate_origin

META = 1 << 20
BINARY = 16 << 20
HEX = re.compile(r"[a-f0-9]{64}")
FIELDS = {"V_electric": ("V", 1, "source_nodes"), "J_charge": ("A/m^2", 3, "tet4_cell_local_nodes"), "H_ant": ("A/m", 3, "sample_nodes")}


def counter(value):
    require(isinstance(value, str) and re.fullmatch(r"0|[1-9][0-9]{0,19}", value) is not None, "noncanonical counter")
    result = int(value)
    require(result <= (1 << 64) - 1, "counter exceeds u64")
    return result


def segment(value):
    require(isinstance(value, str) and 0 < len(value) <= 4096 and value.strip() == value and "\0" not in value, "invalid owner ID")
    return quote(value, safe="")


def verify_slice(body, dataset):
    require(len(body) >= 12 and body[:8] == b"FMDS\x01\x00\x00\x00", "invalid FMDS framing")
    size = struct.unpack_from("<I", body, 8)[0]
    require(0 < size <= META and 12 + size <= len(body), "FMDS metadata bound")
    # Reuse the HTTP JSON parser's duplicate-key and nonfinite-token checks.
    from smoke_antenna_external_lead_inspection import HttpResult
    meta = json_body(HttpResult(200, {"content-type": "application/json"}, body[12:12 + size]), 200)
    for key in ("project_id", "run_id", "solution_set_id", "containing_solution_revision", "member_id", "artifact_id", "manifest_object_ref", "manifest_byte_length", "source"):
        require(meta.get(key) == dataset[key], "FMDS owner or manifest differs")
    require(meta.get("schema_version") == "fullmag.binary.materialized_dataset_slice.v1" and meta.get("integrity") == "verified_returned_ranges" and meta.get("descriptor") == dataset["field"]["descriptor"], "FMDS descriptor differs")
    coverage, sliced = dataset["field"]["coverage"], meta["slice"]
    for key, expected in {"dataset_id": dataset["dataset"]["dataset_id"], "dataset_revision": dataset["dataset"]["revision"], "sample_id": dataset["sample_id"], "item_id": dataset["item_id"], "field_id": dataset["field_id"], "field_layout_digest": dataset["field"]["descriptor"]["layout_digest"], "element_offset": "0", "element_count": coverage["total_elements"], "total_elements": coverage["total_elements"], "component_count": coverage["component_count"], "precision": "f64", "byte_order": "little_endian"}.items():
        require(sliced.get(key) == expected, "FMDS layout or range differs")
    payload = body[12 + size:]
    require(len(payload) == counter(coverage["total_bytes"]) == counter(sliced["payload_bytes"]), "FMDS payload size differs")
    parts = sliced["parts"]
    require(isinstance(parts, list) and 0 < len(parts) <= 4096, "FMDS part bound")
    offset = 0
    for part in parts:
        length = counter(part["byte_length"])
        object_offset = counter(part["object_offset_bytes"])
        require(part["plane"] == "values" and counter(part["plane_offset_bytes"]) == offset and length > 0 and length % 8 == 0 and object_offset % 8 == 0 and object_offset + length <= (1 << 64) - 1 and offset + length <= len(payload) and HEX.fullmatch(part["object_ref"]), "FMDS part coverage differs")
        require(part["range_sha256"] == "sha256:" + sha256(payload[offset:offset + length]).hexdigest(), "FMDS range checksum differs")
        offset += length
    require(offset == len(payload) and all(math.isfinite(value) for (value,) in struct.iter_unpack("<d", payload)), "FMDS incomplete or nonfinite values")
    return sha256(payload).hexdigest()


def verify(origin, project, run, solution, revision, member):
    origin = validate_origin(origin)
    require(counter(revision) > 0, "positive solution revision required")
    owner = f"/v2/persistence/projects/{segment(project)}/runs/{segment(run)}/solution-sets/{segment(solution)}/revisions/{revision}/members/{segment(member)}"
    get = lambda path: json_body(request(origin, path, {}, META), 200)
    page = get(owner + "/artifacts?limit=100")
    require(page.get("next_after_artifact_id") is None and isinstance(page.get("items"), list) and len(page["items"]) <= 100, "artifact inventory exceeds bound")
    expected_owner = {"project_id": project, "run_id": run, "solution_set_id": solution, "containing_solution_revision": revision, "member_id": member}
    fields = {}
    for artifact in page["items"]:
        if artifact.get("schema_id") != "fullmag.materialized_dataset.v1":
            continue
        path = owner + "/artifacts/" + segment(artifact["artifact_id"])
        dataset = get(path + "/materialized-dataset")
        descriptor, coverage = dataset["field"]["descriptor"], dataset["field"]["coverage"]
        quantity = descriptor["quantity_id"]
        if quantity not in FIELDS:
            continue
        require(quantity not in fields, "ambiguous saved antenna quantity")
        unit, components, role = FIELDS[quantity]
        require(all(dataset.get(key) == value for key, value in expected_owner.items()) and dataset["integrity"] == "verified", "saved dataset owner differs")
        require(dataset["artifact_id"] == artifact["artifact_id"] == "materialized-dataset-" + artifact["object_ref"] and dataset["manifest_object_ref"] == artifact["object_ref"], "saved dataset CAS differs")
        require(descriptor["unit"] == unit and descriptor["tensor_rank"] == ("0" if components == 1 else "1") and descriptor["normalization"] == "none" and descriptor["complex_encoding"] == "real" and descriptor["value_representation"] == "physical_field", "saved field SI semantics differ")
        require(dataset["field"]["producer_id"] == "fullmag.closed-loop-inspection" and dataset["field"]["producer_version"] == "2" and dataset["field"]["accepted_state"] is None, "saved inspection producer differs")
        layout, space = descriptor["layout_digest"], descriptor["function_space"]
        require(space["family"] == "owned_sample_values" and space["order"] == "0" and space["vector_dimension"] == str(components) and space["basis_id"] == f"basis:{role}:{layout}" and descriptor["carrier_id"] == f"carrier:{role}:{layout}", "saved sample carrier differs")
        rows, size = counter(coverage["total_elements"]), counter(coverage["total_bytes"])
        require(0 < size <= BINARY and rows * components * 8 == size and coverage["component_count"] == str(components) and coverage["dtype"] == "f64" and coverage["endian"] == "little", "saved field cardinality differs")
        geometry = get(path + "/saved-field-geometry")
        require(all(geometry.get(key) == value for key, value in expected_owner.items()) and geometry["geometry_schema_version"] == "fullmag.owned_sample_field_geometry.v1" and geometry["coordinate_unit"] == "m" and geometry["dataset"]["descriptor"] == descriptor and counter(geometry["node_count"]) == rows, "saved geometry owner/layout differs")
        require(geometry["dataset_manifest"]["artifact_id"] == dataset["artifact_id"] and geometry["dataset_manifest"]["object_ref"] == dataset["manifest_object_ref"] and all(geometry["tensor_artifact"].get(key) == value for key, value in dataset["field"]["tensor_artifact"].items()), "saved geometry manifest or tensor differs")
        require(geometry["owner_solution_revision"] == dataset["source"]["solution_revision"] and geometry["source"]["tensor_object_ref"] == dataset["source"]["tensor_object_ref"] and geometry["source"]["tensor_artifact_id"] == dataset["source"]["artifact_id"] and geometry["producer_id"] == dataset["field"]["producer_id"] and geometry["producer_version"] == dataset["field"]["producer_version"], "saved geometry producer or tensor owner differs")
        binaries = {}
        for kind, magic in (("topology", b"FMMT"), ("support", b"FMSP")):
            count = counter(geometry[kind + "_binary_byte_length"])
            digest = geometry[kind + "_binary_sha256"]
            require(0 < count <= BINARY and isinstance(digest, str) and HEX.fullmatch(digest), "saved binary bound or digest")
            query = {"expected_dataset_manifest_object_ref": dataset["manifest_object_ref"], "expected_geometry_manifest_object_ref": geometry["geometry_manifest"]["object_ref"], "expected_geometry_object_ref": geometry["geometry_payload"]["object_ref"], "max_response_bytes": str(count)}
            route = path + "/saved-field-geometry/" + kind
            response = request(origin, route + "?" + urlencode(query), {}, BINARY)
            require(response.status == 200 and response.body[:4] == magic and len(response.body) == count and sha256(response.body).hexdigest() == digest, "saved binary checksum or framing differs")
            if kind == "topology":
                require(len(response.body) >= 64 and response.body[4:6] == b"\x02\x01" and struct.unpack_from("<III", response.body, 8) == (rows, counter(geometry["cell_count"]), counter(geometry["facet_count"])), "saved topology cardinality differs")
                require(64 + rows * 24 <= len(response.body) and all(math.isfinite(value) for (value,) in struct.iter_unpack("<d", response.body[64:64 + rows * 24])), "saved topology positions invalid")
            else:
                require(len(response.body) == 24 + (rows + 7) // 8 and response.body[4:8] == b"\x01\x00\x00\x00" and struct.unpack_from("<QQ", response.body, 8) == (rows, (rows + 7) // 8), "saved support framing differs")
                bits = response.body[24:]
                require((rows % 8 == 0 or bits[-1] >> (rows % 8) == 0) and sum(value.bit_count() for value in bits) == counter(geometry["active_node_count"]), "saved support count or padding differs")
            query["expected_geometry_object_ref"] = "0" * 64
            require(request(origin, route + "?" + urlencode(query), {}, META).status == 409, "foreign saved geometry pin accepted")
            binaries[kind] = digest
        query = {"expected_manifest_object_ref": dataset["manifest_object_ref"], "element_offset": "0", "element_count": str(rows), "max_response_bytes": str(size)}
        response = request(origin, path + "/materialized-dataset/slice?" + urlencode(query), {}, BINARY + META + 12)
        require(response.status == 200, "saved field slice unavailable")
        payload_hash = verify_slice(response.body, dataset)
        require(get(path + "/materialized-dataset") == dataset and get(path + "/saved-field-geometry") == geometry, "saved metadata changed during reads")
        fields[quantity] = {"unit": unit, "components": components, "rows": str(rows), "manifest": dataset["manifest_object_ref"], "payload_sha256": payload_hash, **binaries}
    require(set(fields) == set(FIELDS), "exact saved V/J/H set missing")
    require(get(owner + "/artifacts?limit=100") == page, "saved artifact inventory changed")
    return {"schema": "fullmag.saved_antenna_fields_http.v1", "status": "passed", "owner": expected_owner, "fields": fields, "read_only": True, "browser_qualified": False, "physics_qualified": False, "cold_reopen_qualified": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("origin", "project", "run", "solution", "revision", "member"):
        parser.add_argument("--" + flag, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.origin, args.project, args.run, args.solution, args.revision, args.member), sort_keys=True))
        return 0
    except (SmokeError, KeyError, TypeError, ValueError, struct.error) as error:
        print(json.dumps({"status": "failed", "error": str(error), "physics_qualified": False}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
