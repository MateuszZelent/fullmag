"""Read-only comparison of the pinned nominal GSG inspection against its reference."""
from __future__ import annotations

import argparse
from hashlib import sha256
import json
import math
from pathlib import Path
import struct
from urllib.parse import quote, urlencode

import docker_startup_script as startup
import reference_sushruth_2020_gsg_current as ref
import smoke_antenna_artifact_fields as fields
from smoke_antenna_external_lead_inspection import (
    MAX_BINARY_BYTES, MAX_METADATA_BYTES, SmokeError, json_body, request, require,
    session_scope, validate_origin, validate_resource, verify_binary,
)

SOURCE_SHA256 = "2510d8ed87f00437ca7c0d37fd5f416895ed884f83579354cbf15f2f9d99d5bd"
SOURCE_RELATIVE = "examples/fem_antenna_sushruth_2020_gsg.py"
GATES = {"current_relative": 1e-6, "potential_absolute_v": 1e-8,
         "field_absolute_apm": 0.01, "field_relative": 1e-5}
GEOMETRY_ATOL_M = 1e-15


def _vectors(values):
    require(len(values) % 3 == 0, "incomplete XYZ sample")
    return list(zip(values[::3], values[1::3], values[2::3]))


def _positions(points, lower, upper):
    require(bool(points) and all(len(p) == 3 and all(math.isfinite(v) for v in p) for p in points),
            "missing/nonfinite XYZ positions")
    for axis in range(3):
        require(abs(min(p[axis] for p in points) - lower[axis]) <= GEOMETRY_ATOL_M
                and abs(max(p[axis] for p in points) - upper[axis]) <= GEOMETRY_ATOL_M,
                "sample extents differ from nominal geometry")


def _branches(points):
    groups = {name: [] for name, _, _ in ref.BRANCHES}
    for index, point in enumerate(points):
        require(len(point) == 3 and all(math.isfinite(v) for v in point), "invalid conductor position")
        matches = [name for name, center, _ in ref.BRANCHES
                   if abs(point[0] - center) <= ref.WIDTH_M / 2 + GEOMETRY_ATOL_M]
        require(len(matches) == 1, "conductor point outside nominal branches")
        groups[matches[0]].append(index)
    for name, center, _ in ref.BRANCHES:
        _positions([points[i] for i in groups[name]],
                   (center - ref.WIDTH_M / 2, -ref.DEVICE_LENGTH_M / 2, ref.SPACING_M),
                   (center + ref.WIDTH_M / 2, ref.DEVICE_LENGTH_M / 2, ref.SPACING_M + ref.THICKNESS_M))
    return groups


def compare_samples(data):
    """Compare world-space raw samples; separate voltage gauges, never fitted slopes."""
    for quantity, components in (("V_electric", 1), ("J_charge", 3), ("H_ant", 3)):
        points, values = data[quantity]
        require(0 < len(points) <= MAX_BINARY_BYTES // 24 and len(values) == len(points) * components,
                "field sample cardinality mismatch")
        require(all(math.isfinite(value) for value in values), "nonfinite field value")
    vp, voltage = data["V_electric"]
    jp, current_raw = data["J_charge"]
    hp, field_raw = data["H_ant"]
    vgroups, jgroups = _branches(vp), _branches(jp)
    _positions(hp, (-2e-6, -50e-9, -10e-9), (2e-6, 50e-9, 0.0))
    require(len(hp) <= 4096, "reference comparison exceeds 4096 H samples")
    current, observed_field = _vectors(current_raw), _vectors(field_raw)
    branches = {}
    for name, _, weight in ref.BRANCHES:
        density = weight * ref.SIGNAL_CURRENT_A / (ref.WIDTH_M * ref.THICKNESS_M)
        current_error = max(math.dist(current[i], (0., density, 0.)) / abs(density) for i in jgroups[name])
        indices = vgroups[name]
        offset = math.fsum((voltage[i] + density * vp[i][1] / ref.CONDUCTIVITY_SPM) / len(indices)
                           for i in indices)
        potential_error = max(abs(voltage[i] - (offset - density * vp[i][1] / ref.CONDUCTIVITY_SPM))
                              for i in indices)
        branches[name] = {"current_samples": len(jgroups[name]), "potential_samples": len(indices),
                          "current_max_relative_error": current_error,
                          "potential_max_absolute_error_v": potential_error, "potential_gauge_offset_v": offset,
                          "passed": current_error <= GATES["current_relative"]
                          and potential_error <= GATES["potential_absolute_v"]}
    worst = {"gate_ratio": -1.}
    max_field_error = 0.
    for position, observed in zip(hp, observed_field):
        expected = ref.gsg_field(position)
        error = math.dist(observed, expected)
        tolerance = GATES["field_absolute_apm"] + GATES["field_relative"] * math.hypot(*expected)
        ratio = error / tolerance
        max_field_error = max(max_field_error, error)
        if ratio > worst["gate_ratio"]:
            worst = {"position_xyz_m": position, "observed_xyz_apm": observed, "reference_xyz_apm": expected,
                     "absolute_error_apm": error, "allowed_error_apm": tolerance, "gate_ratio": ratio}
    passed = all(row["passed"] for row in branches.values()) and worst["gate_ratio"] <= 1.
    return {"schema": "fullmag.sushruth-gsg-comparison.v1", "status": "passed" if passed else "failed",
            "scope": "nominal_modeled_finite_conductors_and_leads_only", "gates": dict(GATES),
            "branches": branches, "field": {"samples": len(hp), "max_absolute_error_apm": max_field_error,
                                          "worst": worst},
            "physics_qualified": False, "omitted_feed_qualified": False, "boris_compared": False}


def compare(origin, stage_id, activation_receipt):
    """Bind actual HTTP samples to one successful managed activation, then compare."""
    raw_receipt = startup._bounded_regular(Path(activation_receipt), startup.MAX_ACTIVATION_RECEIPT_BYTES,
                                          "GSG activation receipt")
    receipt = startup._validate_activation_receipt(
        json.loads(raw_receipt.decode("utf-8"), object_pairs_hook=startup._reject_duplicate_keys))
    require(receipt["state"] == "activated" and receipt["source_sha256"] == SOURCE_SHA256
            and receipt["authorization"]["source_relative"] == SOURCE_RELATIVE, "not the pinned nominal GSG activation")
    activation = receipt["result"]["response"]
    origin = validate_origin(origin)
    http = fields.verify(origin, stage_id)
    path = f"{fields.ROOT}/antenna/stages/{quote(stage_id, safe='')}/external-lead-inspection"
    resource = json_body(request(origin, path, {}, MAX_METADATA_BYTES), 200)
    manifest, digest = validate_resource(resource, stage_id)
    require(resource["session_id"] == activation["session_id"] and resource["run_id"] == activation["run_id"]
            and http["run_id"] == activation["run_id"] and resource["stage_id"] == "inspect_gsg"
            and manifest["source_object_id"] == "antenna", "GSG result belongs to another activation/stage/source")
    headers = {"x-fullmag-session-scope": session_scope(resource, resource["request_scope_epoch"])}
    query = urlencode({"content_digest": digest})
    display = json_body(request(origin, f"{path}/display?{query}", headers, MAX_METADATA_BYTES), 200)
    data = {}
    for quantity, position_kind, value_kind in (
        ("V_electric", "device_positions", "device_potential"),
        ("J_charge", "current_trace_positions", "current_trace_density"),
        ("H_ant", "sample_positions", "magnetic_field"),
    ):
        if quantity == "J_charge":
            descriptors = (display["device_current"]["trace_positions"], display["device_current"]["trace_current_density"])
        else:
            descriptors = (display[position_kind], display[value_kind])
        arrays = []
        for kind, descriptor, hash_key in zip((position_kind, value_kind), descriptors,
                                              ("positions_sha256", "values_sha256")):
            payload, _ = verify_binary(origin, f"{path}/payloads/{kind}?{query}", headers, kind, descriptor)
            require(sha256(payload).hexdigest() == http["fields"][quantity][hash_key],
                    "payload changed after canonical HTTP gate")
            arrays.append([value for (value,) in struct.iter_unpack("<d", payload)])
        data[quantity] = (_vectors(arrays[0]), arrays[1])
    result = compare_samples(data)
    final = json_body(request(origin, path, headers, MAX_METADATA_BYTES), 200)
    require(final == resource, "result owner/artifact changed during comparison")
    result.update(source_sha256=SOURCE_SHA256, activation_receipt_sha256=sha256(raw_receipt).hexdigest(),
                  runtime_stage_id=stage_id, session_id=resource["session_id"], run_id=resource["run_id"],
                  content_digest=digest, canonical_http=http)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--stage-id", required=True)
    parser.add_argument("--activation-receipt", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = compare(args.origin, args.stage_id, args.activation_receipt)
        print(json.dumps(result, sort_keys=True, allow_nan=False))
        return 0 if result["status"] == "passed" else 1
    except (SmokeError, startup.StartupScriptError, OSError, KeyError, TypeError, ValueError, OverflowError, struct.error) as error:
        print(json.dumps({"status": "failed", "error": str(error), "physics_qualified": False}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
