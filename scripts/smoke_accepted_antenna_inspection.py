#!/usr/bin/env python3
"""Read-only accepted-run V/J/H HTTP gate; not solver qualification."""
from __future__ import annotations

import argparse
from hashlib import sha256
import json
import re
import struct
import sys
from urllib.parse import quote, urlencode

from smoke_antenna_external_lead_inspection import (
    MAX_METADATA_BYTES, PAYLOADS, SmokeError, json_body, request, require,
    strong_etag, validate_current_receipt, validate_descriptor, validate_origin,
    verify_binary,
)
from smoke_antenna_inspection_display import CURRENT_CARRIERS
import antenna_rt0_fixture_check as framing
from antenna_current_display_fixture_check import bounded_count, decode_current_snapshot

OWNER_FIELDS = {
    "run_id", "task_id", "study_step_id", "native_stage_id", "attempt_id",
    "ownership_epoch", "manifest_artifact_id", "manifest_object_ref",
    "artifact_id", "package_object_ref", "case_id",
}
PIN_FIELDS = ("attempt_id", "ownership_epoch", "package_object_ref")


def validate_owner(owner, run_id, step_id):
    require(isinstance(owner, dict) and set(owner) == OWNER_FIELDS,
            "accepted publication owner has unexpected fields")
    require(owner["run_id"] == run_id and owner["study_step_id"] == step_id,
            "accepted publication belongs to another run or Study step")
    for key in OWNER_FIELDS - {"ownership_epoch"}:
        require(isinstance(owner[key], str) and 0 < len(owner[key]) <= 4096
                and "\0" not in owner[key], f"invalid owner {key}")
    require(type(owner["ownership_epoch"]) is int and 0 <= owner["ownership_epoch"] < 2**64,
            "invalid ownership epoch")
    for key in ("manifest_object_ref", "package_object_ref"):
        require(re.fullmatch(r"[0-9a-f]{64}", owner[key]) is not None,
                f"invalid CAS identity {key}")
    return owner


def payload_etag(project_id, owner, kind, descriptor):
    token = [project_id, owner["run_id"], owner["study_step_id"],
             owner["native_stage_id"], owner["task_id"], owner["attempt_id"],
             owner["ownership_epoch"], owner["manifest_object_ref"],
             owner["artifact_id"], owner["package_object_ref"], kind, descriptor["sha256"]]
    encoded = json.dumps(token, ensure_ascii=False, separators=(",", ":")).encode()
    return '"' + sha256(encoded).hexdigest() + '"'


def display_descriptors(resource, project_id, owner, resource_id):
    require(set(resource) == {"schema_version", "resource_id", "project_id", "owner",
                             "port_mode_id", "output_id", "manifest", "display"},
            "unexpected accepted metadata fields")
    require(resource["schema_version"] == "accepted_antenna_inspection.v1"
            and resource["project_id"] == project_id and resource["owner"] == owner
            and resource["resource_id"] == resource_id, "accepted resource owner mismatch")
    for key in ("port_mode_id", "output_id"):
        require(isinstance(resource[key], str) and bool(resource[key]), f"missing {key}")
    manifest, display = resource["manifest"], resource["display"]
    require(manifest.get("validation_scope") == "accepted_plan_and_payloads"
            and manifest.get("schema_version") == "antenna_external_lead_solution.v2",
            "accepted result was not fully package/plan validated")
    require(isinstance(display, dict) and set(display) == {
        "content_digest", "source_object_id", "status", "qualification", "field_scope",
        "normalization", "capabilities", "device_node_count", "device_cell_count",
        "sampling_carrier", "device_positions", "device_topology", "device_potential",
        "sample_positions", "magnetic_field", "device_current"},
        "display contains unexpected fields or missing current")
    require(display["status"] == "inspection_only" and display["qualification"] == "NOT VERIFIED"
            and display["field_scope"] == "external_electrode_truncation"
            and display["normalization"] == "raw_authored_current", "raw inspection scope changed")
    require(display["capabilities"] == {"display": True, "per_ampere_basis": False,
        "source_fft": False, "llg_drive": False, "current_density": True}
        and all(type(value) is bool for value in display["capabilities"].values()),
        "raw result promoted to a qualified drive")
    for key in ("content_digest", "source_object_id", "sampling_carrier"):
        require(display[key] == manifest[key], f"display/manifest {key} mismatch")
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", display["content_digest"]) is not None,
            "invalid content digest")
    descriptors = {kind: manifest[kind] for kind in PAYLOADS}
    for kind, spec in PAYLOADS.items():
        validate_descriptor(descriptors[kind], kind, spec)
    for kind in ("device_potential", "sample_positions", "magnetic_field"):
        require(display[kind] == descriptors[kind], f"display/manifest {kind} mismatch")
    for kind, spec in {
        "device_positions": ("display/device_positions.bin", "float64_le", "node_xyz_interleaved", "m", 8),
        "device_topology": ("display/device_topology.bin", "uint32_le", "tet4_connectivity", "1", 4),
    }.items():
        descriptors[kind] = display[kind]
        validate_descriptor(descriptors[kind], kind, spec)
    current = display["device_current"]
    require(isinstance(current, dict) and set(current) == {"receipt", "ordered_snapshot"}
            | {entry[0] for entry in CURRENT_CARRIERS.values()}, "invalid J display")
    validate_current_receipt(current["receipt"])
    require(current["receipt"] == manifest["current_display"]
            and current["ordered_snapshot"] == current["receipt"]["payload"], "J receipt mismatch")
    descriptors["current_snapshot"] = current["ordered_snapshot"]
    nodes, cells = display["device_node_count"], display["device_cell_count"]
    require(type(nodes) is int and nodes > 0 and type(cells) is int and cells > 0,
            "invalid device cardinality")
    require(descriptors["device_positions"]["value_count"] == nodes * 3
            and descriptors["device_vertex_ids"]["value_count"] == nodes
            and descriptors["device_potential"]["value_count"] == nodes
            and descriptors["device_topology"]["value_count"] == cells * 4
            and current["receipt"]["cell_count"] == cells, "V/J geometry cardinality mismatch")
    samples = display["sampling_carrier"]["sample_count"]
    require(type(samples) is int and samples > 0
            and descriptors["sample_positions"]["value_count"]
            == descriptors["magnetic_field"]["value_count"] == samples * 3, "H carrier mismatch")
    for kind, (name, layout, unit, per_cell) in CURRENT_CARRIERS.items():
        descriptors[kind] = current[name]
        validate_descriptor(descriptors[kind], kind, (f"display/{kind}.bin", "float64_le", layout, unit, 8))
        require(descriptors[kind]["value_count"] == cells * per_cell, f"{kind} count mismatch")
    return descriptors


def verify_retained_payloads(display, payloads):
    """Compare projections byte-for-byte; not a native canonical decoder or solver oracle."""
    try:
        outer = framing.fields(payloads["bundle"])
        charge_bytes = framing.one(outer, "charge_record", 3)
        source_bytes = framing.one(outer, "source_record", 3)
        field_bytes = framing.one(outer, "field_record", 3)
        for name, body in (("charge", charge_bytes), ("source", source_bytes), ("field", field_bytes)):
            require(sha256(body).hexdigest() == framing.one(outer, name + "_content_sha256", 1),
                    f"retained {name} record SHA mismatch")
        charge = framing.fields(charge_bytes)
        vertices = framing.group(charge, "vertices", bounded_count(charge, "vertices", 8),
            [("vertex_id", 2)] + [("xyz_m", 4)] * 3 + [("potential_v", 4),
            ("reaction_a", 4), ("vertex_component_id", 2)], skip=1)
        elements = framing.group(charge, "elements", bounded_count(charge, "elements", 6),
            [("attribute", 2)] + [("vertex_id", 2)] * 4 + [("conductivity_spm", 4)])
        field = framing.fields(field_bytes)
        require(framing.one(field, "schema", 1) in {
            "accepted_external_lead_field.ordered.v1", "accepted_external_lead_field.ordered.v2"},
            "unsupported retained field framing")
        require(framing.one(field, "field_scope", 1) == "external_electrode_truncation"
                and framing.one(field, "charge_content_digest", 1) == sha256(charge_bytes).hexdigest()
                and framing.one(field, "accepted_external_source_digest", 1) == sha256(source_bytes).hexdigest(),
                "H record belongs to another current source")
        count = display["sampling_carrier"]["sample_count"]
        require(framing.one(field, "target_count", 2) == count, "retained H target count mismatch")
        samples = [(name, tag, value) for name, tag, value in field
                   if name in ("target_coordinate_m", "h_component_apm")]
        layout = [("target_coordinate_m", 4)] * 3 + [("h_component_apm", 4)] * 3
        require([(name, tag) for name, tag, _ in samples] == layout * count,
                "retained H sample ordering mismatch")
        current = decode_current_snapshot(payloads["current_snapshot"], bundle_bytes=payloads["bundle"],
                                          receipt=display["device_current"]["receipt"])
    except (ValueError, UnicodeError) as error:
        raise SmokeError("retained display framing/association failed") from error
    ids = [row[0] for row in struct.iter_unpack("<Q", payloads["device_vertex_ids"])]
    by_id = {row[0]: row for row in vertices}
    require(len(ids) == display["device_node_count"] and len(set(ids)) == len(ids)
            and len(by_id) == len(vertices) and all(identity in by_id for identity in ids),
            "retained device IDs are missing or duplicated")
    pack = lambda values: b"".join(struct.pack("<d", value) for value in values)
    require(pack(value for identity in ids for value in by_id[identity][1:4]) == payloads["device_positions"],
            "device coordinates differ from retained authored order")
    require(pack(by_id[identity][4] for identity in ids) == payloads["device_potential"],
            "V differs from retained authored order")
    indices = {identity: index for index, identity in enumerate(ids)}
    cells = []
    for row in elements:
        owned = [identity in indices for identity in row[1:5]]
        require(not any(owned) or all(owned), "mixed device/lead tetrahedron")
        if all(owned):
            cells.extend(indices[identity] for identity in row[1:5])
    require(b"".join(struct.pack("<I", index) for index in cells) == payloads["device_topology"],
            "device topology differs from retained element order")
    require(len(current) == display["device_cell_count"], "retained J cell count mismatch")
    expected = {
        "sample_positions": (row[2] for index, row in enumerate(samples) if index % 6 < 3),
        "magnetic_field": (row[2] for index, row in enumerate(samples) if index % 6 >= 3),
        "current_center_positions": (value for cell in current for value in cell["center_position_m"]),
        "current_center_density": (value for cell in current for value in cell["center_current_apm2"]),
        "current_trace_positions": (value for cell in current for row in cell["vertex_positions_m"] for value in row),
        "current_trace_density": (value for cell in current for row in cell["vertex_current_apm2"] for value in row),
    }
    for kind, values in expected.items():
        require(pack(values) == payloads[kind], f"{kind} differs from retained sample order")


def verify(origin, project_id, run_id, step_id):
    origin = validate_origin(origin)
    for value in (project_id, run_id, step_id):
        require(isinstance(value, str) and 0 < len(value) <= 4096 and "\0" not in value,
                "an explicit bounded project/run/Study step is required")
    base = "/v2/persistence/projects/" + quote(project_id, safe="") + "/runs/" + quote(run_id, safe="") + "/antenna-inspections"
    response = request(origin, base, {}, MAX_METADATA_BYTES)
    catalog = json_body(response, 200)
    catalog_etag = strong_etag(response)
    require(set(catalog) == {"schema_version", "resource_id", "project_id", "run_id", "validation_scope", "entries"}
            and catalog["schema_version"] == "accepted_antenna_inspection_catalog.v1"
            and catalog["project_id"] == project_id and catalog["run_id"] == run_id
            and catalog["resource_id"] == base.removeprefix("/v2/")
            and catalog["validation_scope"] == "published_output_manifest"
            and isinstance(catalog["entries"], list)
            and all(isinstance(entry, dict) for entry in catalog["entries"]), "invalid discovery envelope")
    selected = [entry for entry in catalog["entries"] if entry.get("study_step_id") == step_id]
    require(len(selected) == 1, "explicit Study step has no unique published inspection")
    owner = validate_owner(selected[0], run_id, step_id)
    path = base + "/" + quote(step_id, safe="")
    pin = {key: owner[key] for key in PIN_FIELDS}
    pinned = path + "?" + urlencode(pin)
    response = request(origin, pinned, {}, MAX_METADATA_BYTES)
    resource = json_body(response, 200)
    metadata_etag = strong_etag(response)
    descriptors = display_descriptors(resource, project_id, owner,
        base.removeprefix("/v2/") + "/" + step_id)
    require(sum(descriptor["byte_count"] for descriptor in descriptors.values()) <= framing.LIMIT,
            "retained comparison exceeds the 2 MiB small-fixture budget")
    checked = []
    payloads = {}
    for kind, descriptor in descriptors.items():
        binary = path + "/payloads/" + kind + "?" + urlencode(pin)
        body, etag = verify_binary(origin, binary, {}, kind, descriptor, fetch=request)
        require(etag == payload_etag(project_id, owner, kind, descriptor), f"{kind}: durable owner ETag mismatch")
        checked.append({"kind": kind, "unit": descriptor["unit"], "byte_count": len(body), "sha256": descriptor["sha256"]})
        payloads[kind] = body
    verify_retained_payloads(resource["display"], payloads)
    stale_cases = {
        "attempt": {**pin, "attempt_id": pin["attempt_id"] + "-stale"},
        "epoch": {**pin, "ownership_epoch": (pin["ownership_epoch"] + 1) % 2**64},
        "package": {**pin, "package_object_ref": ("0" if pin["package_object_ref"][0] != "0" else "1") + pin["package_object_ref"][1:]},
    }
    for changed in stale_cases.values():
        for suffix in ("", "/payloads/magnetic_field"):
            rejected = json_body(request(origin, path + suffix + "?" + urlencode(changed),
                {"If-None-Match": "*", "Range": "bytes=0-7"}, MAX_METADATA_BYTES), 409)
            require(rejected.get("code") == "antenna_source_conflict", "stale pin bypassed ownership guard")
    for final_path, etag in ((base, catalog_etag), (pinned, metadata_etag)):
        final = request(origin, final_path, {"If-None-Match": etag}, MAX_METADATA_BYTES)
        require(final.status == 304 and not final.body and strong_etag(final) == etag,
                "publication changed during HTTP gate")
    return {"schema": "fullmag.accepted_antenna_http_smoke.v1", "status": "pass",
            "physics_qualified": False, "qualification": "NOT VERIFIED",
            "scope": "accepted_http_integrity_only", "project_id": project_id,
            "owner": owner, "payloads": checked, "stale_pin_cases_checked": 6,
            "retained_projection_checked": True, "native_canonical_bundle_redecoded": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("origin", "project-id", "run-id", "step-id"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.origin, args.project_id, args.run_id, args.step_id)))
    except (SmokeError, KeyError, TypeError) as error:
        print(f"accepted antenna HTTP gate: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
