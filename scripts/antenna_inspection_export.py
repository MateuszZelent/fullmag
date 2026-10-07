"""Bounded integrity read of native-published antenna inspection observables.

This is not the authoritative ordered-bundle decoder or an authenticity check.
The native publisher owns canonical charge/RT0/source/H validation. A caller
must separately verify executed build/input provenance before using the values
with the scientific oracle. Nothing here qualifies a reusable drive basis.
"""
from __future__ import annotations

import hashlib
import json
import re
import struct
from pathlib import Path

import fullmag_storage as storage

RECORD = "antenna_external_lead_stage_output.v1.json"
PAYLOADS = {
    "bundle": ("bundle.v1.bin", "ordered_binary_v1", "accepted_external_lead_bundle.ordered.v1", "1", None),
    "sample_positions": ("sample_positions.f64le.bin", "float64_le", "sample_xyz_interleaved", "m", 12),
    "magnetic_field": ("H.f64le.bin", "float64_le", "sample_xyz_interleaved", "A/m", 12),
    "device_vertex_ids": ("device_vertex_ids.u64le.bin", "uint64_le", "authored_device_vertex_order", "1", 16),
    "device_potential": ("device_V.f64le.bin", "float64_le", "authored_device_vertex_order", "V", 16),
}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def bounded_bytes(path, root, limit):
    path = storage.validate_path(path, root)
    if storage.is_link(path) or not path.is_file() or path.stat().st_size > limit:
        raise ValueError("Inspection input must be a bounded regular file")
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    if not data or len(data) > limit:
        raise ValueError("Inspection input is empty or exceeds its bound")
    return data


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate inspection JSON key")
        result[key] = value
    return result


def parse(data, **kwargs):
    def reject(value):
        raise ValueError(f"Nonfinite JSON token: {value}")
    return json.loads(data, object_pairs_hook=unique_object, parse_constant=reject, **kwargs)


class NumberToken(str):
    """Keep serde-written numeric lexemes when ordering the manifest preimage."""


def manifest_digest(data):
    value = parse(data, parse_float=NumberToken, parse_int=NumberToken)
    value.pop("content_digest", None)
    def ordered(item):
        if isinstance(item, NumberToken):
            return str(item)
        if isinstance(item, dict):
            return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + ordered(item[k])
                                  for k in sorted(item)) + "}"
        if isinstance(item, list):
            return "[" + ",".join(ordered(v) for v in item) + "]"
        return json.dumps(item, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return "sha256:" + sha256(ordered(value).encode("utf-8"))


def read_inspection(artifact_root, stage_record):
    """Read this fixed 16-node/4-probe fixture, refusing ambiguous revisions.

    The caller supplies the exact artifact root and stage record from the
    executed run, not a search result or the latest output of another run.
    """
    root = Path(artifact_root).resolve()
    record_path = Path(stage_record)
    if record_path.name != RECORD:
        raise ValueError("Exact inspection stage record required")
    record_bytes = bounded_bytes(record_path, root, 1 << 20)
    record = parse(record_bytes)
    expected = {"schema_version": "antenna_external_lead_stage_output.v1",
        "stage_kind": "antenna_field_solve", "resolved_action": "external_lead_inspection",
        "stage_id": "inspect_antenna", "port_mode_id": "port", "output_id": "inspection",
        "status": "inspection_only", "qualification": "NOT VERIFIED",
        "field_scope": "external_electrode_truncation"}
    if any(record.get(k) != v for k, v in expected.items()) \
            or not isinstance(record.get("outputs"), list) or len(record["outputs"]) != 1:
        raise ValueError("Exact fixed-fixture inspection stage/scope differs")
    output = record["outputs"][0]
    reference = output.get("inspection_ref", {})
    revision = reference.get("content_digest", "")
    if output.get("kind") != "antenna_external_lead_inspection" \
            or reference.get("stage_id") != "inspect_antenna" \
            or reference.get("output_id") != "inspection" \
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", revision) \
            or output.get("payload_units") != {"V": "V", "RT0_coefficients": "A", "H": "A/m", "positions": "m"}:
        raise ValueError("Inspection output reference/units differ")
    manifest_ref = f"antenna/external_lead_solutions/inspection/{revision[7:]}/manifest.v1.json"
    if output.get("manifest_ref") != manifest_ref:
        raise ValueError("Inspection manifest path differs from exact revision")
    manifest_path = root / manifest_ref
    manifest_bytes = bounded_bytes(manifest_path, root, 1 << 20)
    manifest = parse(manifest_bytes)
    if manifest_digest(manifest_bytes) != revision or manifest.get("content_digest") != revision \
            or manifest.get("schema_version") != "antenna_external_lead_solution.v1" \
            or any(manifest.get(k) != expected[k] for k in (
                "stage_id", "port_mode_id", "output_id", "status", "qualification", "field_scope")) \
            or manifest.get("source_object_id") != "antenna" \
            or manifest.get("current_transport_id") != "antenna_charge" \
            or manifest.get("drive_id") != "drive" \
            or manifest.get("closure_revision") != "antenna_signal_return_input_v1":
        raise ValueError("Inspection manifest identity/digest differs")
    execution = manifest.get("resolved_execution", {})
    if any(execution.get(k) != v for k, v in {
        "engine": "fem", "device": "cpu", "precision": "double",
        "operator_version": "fem_accepted_external_lead_bundle.v1",
        "adapter_version": "antenna_external_lead_request_adapter.v1"}.items()):
        raise ValueError("Inspection execution lane differs")
    if type(manifest.get("sampling_carrier", {}).get("sample_count")) is not int \
            or manifest["sampling_carrier"]["sample_count"] != 4:
        raise ValueError("Inspection sampling cardinality differs")
    revision_root = manifest_path.parent
    if {p.name for p in revision_root.iterdir()} != {"manifest.v1.json"} | {
            row[0] for row in PAYLOADS.values()}:
        raise ValueError("Inspection revision must contain exactly six files")
    payloads = {}
    for key, (name, scalar, layout, unit, count) in PAYLOADS.items():
        descriptor = manifest.get(key, {})
        if any(descriptor.get(k) != v for k, v in {
                "path": name, "scalar_type": scalar, "layout": layout, "unit": unit}.items()) \
                or type(descriptor.get("byte_count")) is not int \
                or type(descriptor.get("value_count")) is not int:
            raise ValueError("Inspection payload descriptor differs")
        data = bounded_bytes(revision_root / name, root, 128 << 20)
        width = 1 if count is None else 8
        expected_count = len(data) if count is None else count
        if descriptor["byte_count"] != len(data) or descriptor["value_count"] != expected_count \
                or len(data) != expected_count * width or descriptor.get("sha256") != sha256(data):
            raise ValueError("Inspection payload hash/size/cardinality differs")
        payloads[key] = data
    def doubles(key):
        data = payloads[key]
        return list(struct.unpack("<" + "d" * (len(data) // 8), data))
    def vectors(key):
        values = doubles(key)
        return [values[i:i + 3] for i in range(0, len(values), 3)]
    return {"device_ids": list(struct.unpack("<16Q", payloads["device_vertex_ids"])),
        "potential_v": doubles("device_potential"), "positions_m": vectors("sample_positions"),
        "field_apm": vectors("magnetic_field"), "record_sha256": sha256(record_bytes),
        "manifest_sha256": sha256(manifest_bytes), "bundle_sha256": sha256(payloads["bundle"]),
        "manifest_content_digest": revision, "bundle_bytes": payloads["bundle"],
        "nested_content_sha256": {name: manifest.get(name + "_content_sha256")
                                  for name in ("charge", "source", "field")},
        "native_canonical_bundle_redecoded": False,
        "physics_qualified": False, "qualification": "NOT VERIFIED"}
