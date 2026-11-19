#!/usr/bin/env python3
"""Bounded real HTTP closed-loop inspection checks; no scientific qualification."""
from __future__ import annotations
import argparse
from decimal import Decimal
from hashlib import sha256
import itertools
import json
import math
import re
import struct
import sys
from urllib.parse import quote, urlencode
from uuid import uuid4

from antenna_rt0_fixture_check import group, one
from smoke_antenna_external_lead_inspection import (
    HttpResult, json_body, request, require, session_scope, strong_etag,
    validate_origin, verify_binary,
)

METADATA_BOUND = 64 << 10
BINARY_BOUND = 16 << 20
TOTAL_BOUND = 64 << 20
CELL_BOUND = 4096
SAMPLE_CELL_BOUND = 16384
VERTEX_BOUND = 4 * CELL_BOUND
HEX = re.compile(r"[0-9a-f]{64}")
PIN = re.compile(r"sha256:[0-9a-f]{64}")
POLICIES = {
    "digest_encoding": "canonical_named_fields_be_bits.v2",
    "periodic_operator_version": "fem_charge_h1_periodic_jump.v2",
    "closure_operator_version": "fem_closed_current_geometry.v2",
    "conservative_current_operator_version": "fem_conservative_current_rt0_view.v1",
    "weak_reaction_ledger_version": "original_k_paired_vertex_reactions.v2",
    "sampling_policy": "cell_center_and_cell_local_vertices.v1",
    "source_current_orientation": "authored_minus_outward.v1",
}
SCHEMAS = {
    "prepared_preimage": ("prepared_execution_digest", "prepared_closed_loop_execution_input.v2"),
    "charge_preimage": ("accepted_charge_field_digest", "accepted_closed_loop_charge_field.v2"),
    "source_preimage": ("accepted_source_state_digest", "accepted_closed_loop_source_state.v2"),
}


def count(value, maximum, name):
    require(type(value) is int and 0 < value <= maximum, f"invalid bounded {name}")
    return value


def finite(value):
    return type(value) in (float, int) and math.isfinite(value)


def validate_resource(resource, stage_id):
    require(resource.get("runtime_stage_id") == stage_id and resource.get("resource_id") == f"data/antenna/stages/{stage_id}/external-lead-inspection", "wrong inspection runtime owner")
    for key in ("session_id", "session_epoch", "request_scope_epoch", "run_id", "stage_id", "output_id", "port_mode_id", "source_object_id"):
        value = resource.get(key)
        require(isinstance(value, str) and 0 < len(value) <= 4096 and value.strip() and "\0" not in value, f"invalid {key}")
    require(type(resource.get("stage_revision")) is int and resource["stage_revision"] >= 0 and isinstance(resource.get("record_content_digest"), str) and PIN.fullmatch(resource["record_content_digest"]), "invalid owner revision/digest")
    expected = {"schema_version": "antenna_closed_loop_stage_output.v2", "stage_kind": "antenna_field_solve", "resolved_action": "closed_loop_inspection", "status": "inspection_only", "qualification": "NOT VERIFIED", "field_scope": "full_closed_loop.inspection_only.v2"}
    require(all(resource.get(k) == v for k, v in expected.items()), "closed-loop record family/status mismatch")
    require(resource.get("manifest") is None and resource.get("diagnostic") is None, "closed-loop mixed manifest or diagnostic")
    outputs = resource.get("outputs")
    require(isinstance(outputs, list) and len(outputs) == 1 and isinstance(outputs[0], dict), "one exact output required")
    output = outputs[0]
    reference = output.get("inspection_ref")
    require(isinstance(reference, dict) and set(reference) == {"stage_id", "output_id", "content_digest"}, "invalid immutable inspection reference")
    digest = reference["content_digest"]
    require(isinstance(digest, str) and PIN.fullmatch(digest), "invalid inspection digest")
    require(reference["stage_id"] == resource["stage_id"] and reference["output_id"] == resource["output_id"] and output.get("content_digest") == digest and output.get("kind") == "antenna_closed_loop_inspection" and output.get("manifest_ref") == f"antenna/field_solutions/{resource['output_id']}/manifest.v2.json", "record output association differs")
    require(output.get("payload_units") == {"V_electric": "V", "J_charge": "A/m^2", "H_ant": "A/m", "H_ant_per_a": "1/m", "positions": "m"}, "raw/per-A units differ")
    m = resource.get("closed_loop_manifest")
    require(isinstance(m, dict) and m.get("schema_version") == "antenna_field_solution.v2" and m.get("status") == "inspection_only" and m.get("validation_scope") == "full_cold_bundle" and m.get("qualification") == "NOT VERIFIED" and m.get("field_scope") == expected["field_scope"], "missing bounded cold manifest metadata")
    require(m.get("content_digest") == digest and m.get("solution_id") == resource["output_id"] and m.get("stage_id") == resource["stage_id"] and m.get("port_mode_id") == resource["port_mode_id"] and m.get("source_object_id") == resource["source_object_id"], "manifest owner differs")
    require(isinstance(m.get("current_transport_id"), str) and bool(m["current_transport_id"].strip()) and all(isinstance(m.get(k), dict) for k in ("sample_carrier", "requested_intent", "resolved_execution")), "missing compact source/carrier provenance")
    s = m.get("source")
    require(isinstance(s, dict) and s == output.get("source") and all(s.get(k) == v for k, v in POLICIES.items()), "source owner/operator differs")
    for key in ("prepared_execution_digest", "accepted_charge_field_digest", "accepted_source_state_digest", "view_identity_digest", "current_balance_certificate_digest"):
        require(isinstance(s.get(key), str) and HEX.fullmatch(s[key]), f"invalid source {key}")
    current, flux = s.get("source_current_a"), s.get("source_absolute_flux_a")
    require(finite(current) and finite(flux) and flux >= abs(current) and abs(current) > 100 * (1e-18 + 1e-10 * flux), "normalization_not_resolvable")
    require(m.get("signed_normalization_a") == current and m.get("scale_per_a") == 1 / current and finite(m["scale_per_a"]), "unsigned or unresolved per-A scale")
    require(all(finite(s.get(k)) for k in ("potential_jump_v", "measured_potential_jump_v", "gauge_mean_v", "charge_relative_residual", "max_paired_weak_flux_mismatch_a")) and 0 <= s["charge_relative_residual"] <= 1e-12, "invalid accepted charge scalars")
    require(isinstance(s.get("terminal_observation_currents"), dict) and all(finite(v) for v in s["terminal_observation_currents"].values()), "invalid observation currents")
    n, c, t, h = (count(m.get(k), bound, k) for k, bound in (("vertex_count", VERTEX_BOUND), ("cell_count", CELL_BOUND), ("target_count", VERTEX_BOUND), ("sample_cell_count", SAMPLE_CELL_BOUND)))
    f, w = count(m.get("face_count"), 4*c, "face_count"), count(m.get("weak_reaction_count"), n, "weak_reaction_count")
    evidence_schema = m.get("direct_evidence_schema")
    require(evidence_schema in ("fem_direct_oersted_evidence.v2", "fem_rt0_surface_evidence.v1"), "unknown direct evidence schema")
    specs = {
        "stable_vertex_ids": ("node_u64_le", "1", n*8), "vertex_xyz": ("node_xyz_f64_le", "m", n*24),
        "sample_xyz": ("sample_xyz_f64_le", "m", t*24), "sample_cells": ("sample_tet4_u32_le", "1", h*16),
        "conductivity": ("cell_f64_le", "S/m", c*8), "v_raw": ("node_f64_le", "V", n*8), "v_per_a": ("node_f64_le", "V/A", n*8),
        "j_center_raw": ("cell_xyz_f64_le", "A/m^2", c*24), "j_center_per_a": ("cell_xyz_f64_le", "1/m^2", c*24),
        "j_local_raw": ("cell_local4_xyz_f64_le", "A/m^2", c*96), "j_local_per_a": ("cell_local4_xyz_f64_le", "1/m^2", c*96),
        "h_raw": ("sample_xyz_f64_le", "A/m", t*24), "h_per_a": ("sample_xyz_f64_le", "1/m", t*24),
        "cells": ("closed_loop_cell280_le", "SI", c*280), "faces": ("face_u64x3_f64_le", "A", f*32), "weak": ("paired_u64x2_f64x2_le", "A", w*32),
        **{key: ("canonical_named_fields_be_bits.v2", "1", None) for key in SCHEMAS},
        "certificate": ("canonical_balance_certificate.v1", "1", None), "authoring_receipt": ("utf8_json_input.v1", "1", None),
        "direct_evidence": (evidence_schema, "SI", 296+t*96 if evidence_schema == "fem_direct_oersted_evidence.v2" else None),
    }
    payloads = m.get("payloads")
    require(isinstance(payloads, dict) and set(payloads) == set(specs), "22-payload closure incomplete")
    require(re.fullmatch(r"[A-Za-z0-9_.-]{1,255}", resource["output_id"]) and ".." not in resource["output_id"], "unsafe artifact ID")
    for key, (layout, unit, size) in specs.items():
        d = payloads[key]
        require(isinstance(d, dict) and set(d) == {"path", "sha256", "byte_length", "layout", "unit"} and d["path"] == f"antenna/field_solutions/{m['solution_id']}/{key}.bin" and d["layout"] == layout and d["unit"] == unit and isinstance(d["sha256"], str) and HEX.fullmatch(d["sha256"]), f"{key} descriptor differs")
        count(d["byte_length"], BINARY_BOUND, key + " byte_length")
        require(size is None or size == d["byte_length"], f"{key} size differs")
    require(evidence_schema != "fem_rt0_surface_evidence.v1" or payloads["direct_evidence"]["byte_length"] > 176, "surface evidence header or length")
    require(sum(d["byte_length"] for d in payloads.values()) <= TOTAL_BOUND, "aggregate payload bound exceeded")
    return m, digest


def preimage_fields(data):
    """Actual BE named-field codec; binary64 physics uses tag2 raw bits, not tag4."""
    require(0 < len(data) <= BINARY_BOUND, "preimage byte bound")
    rows, offset = [], 0
    def take(n):
        nonlocal offset
        require(n <= len(data)-offset, "truncated preimage")
        value, offset = data[offset:offset+n], offset+n
        return value
    def word():
        return struct.unpack(">Q", take(8))[0]
    while offset < len(data):
        require(len(rows) < 64*CELL_BOUND+256, "preimage field bound")
        name = take(count(word(), 255, "field name")).decode("utf-8")
        require("\0" not in name, "invalid preimage field name")
        tag, length = take(1)[0], word()
        require(tag in (1, 2, 3) and length <= BINARY_BOUND, "unknown preimage tag/length")
        value = take(length)
        if tag == 1:
            require(length < 256 and b"\0" not in value, "preimage string bound")
            value = value.decode("utf-8")
        elif tag == 2:
            require(length == 8, "preimage u64 width")
            value = struct.unpack(">Q", value)[0]
        rows.append((name, tag, value))
    return rows


def bits(value):
    return struct.unpack("<Q", struct.pack("<d", value))[0]


def tagged_json_digest(value):
    """Existing fullmag:transport-tagged-json:v1 codec, not a new identity."""
    digest = sha256(b"fullmag:transport-tagged-json:v1")
    def encode(value, depth=0):
        require(depth <= 64, "authoring JSON nesting bound")
        if value is None:
            digest.update(b"N")
        elif type(value) is bool:
            digest.update(b"T" if value else b"F")
        elif type(value) in (int, float):
            require(finite(value) and (type(value) is float or abs(value) <= 2**53), "invalid authored number")
            digest.update(b"D"+struct.pack("<d", 0.0 if value == 0 else value))
        elif isinstance(value, str):
            raw = value.encode("utf-8")
            digest.update(b"S"+struct.pack("<Q", len(raw))+raw)
        elif isinstance(value, list):
            digest.update(b"A"+struct.pack("<Q", len(value)))
            for item in value:
                encode(item, depth+1)
        elif isinstance(value, dict):
            digest.update(b"O"+struct.pack("<Q", len(value)))
            for key in sorted(value):
                encode(key, depth+1)
                encode(value[key], depth+1)
        else:
            require(False, "unsupported authored JSON")
    encode(value)
    return "sha256:"+digest.hexdigest()


def doubles(data):
    require(len(data) % 8 == 0, "invalid f64 carrier length")
    values = [v for (v,) in struct.iter_unpack("<d", data)]
    require(all(math.isfinite(v) for v in values), "non-finite numeric payload")
    return values


def verify_field_evidence(m, payloads):
    """Check retained transport bindings; canonical Rust owns numerical admission."""
    evidence, s, n = payloads["direct_evidence"], m["source"], m["target_count"]
    require(len(evidence) == m["payloads"]["direct_evidence"]["byte_length"] <= BINARY_BOUND, "evidence descriptor length differs")
    require(len(payloads["sample_xyz"]) == len(payloads["h_raw"]) == n * 24, "evidence carrier length differs")
    if m["direct_evidence_schema"] == "fem_direct_oersted_evidence.v2":
        require(len(evidence) == 296+n*96 and evidence[:16] == b"FM-OEF1-Q3-V2\0\0\0" and evidence[16:80] == s["view_identity_digest"].encode() and evidence[80:144] == s["current_balance_certificate_digest"].encode(), "direct evidence source/certificate or length differs")
        require(struct.unpack_from("<Q", evidence, 144)[0] == n and struct.unpack_from("<Q", evidence, 168)[0] == 0 and evidence[272:296] == struct.pack("<3d", s["source_current_a"], m["scale_per_a"], s["source_absolute_flux_a"]), "direct evidence target count/current/scale differs")
        for i in range(n):
            row = evidence[296+96*i:296+96*(i+1)]
            require(row[:24] == payloads["sample_xyz"][24*i:24*(i+1)] and row[24:48] == payloads["h_raw"][24*i:24*(i+1)] and all(math.isfinite(v) for v in struct.unpack("<9d", row[:72])), "direct H/target sampling carrier differs")
        return
    require(m["direct_evidence_schema"] == "fem_rt0_surface_evidence.v1" and len(evidence) > 176 and evidence[:16] == b"FM-RT0-SURF-V1\0\0", "surface evidence header or schema")
    require(struct.unpack_from("<Q", evidence, 16)[0] == len(evidence)-176, "surface exact evidence length")
    require(evidence[24:48] == struct.pack("<3d", s["source_current_a"], s["source_absolute_flux_a"], m["scale_per_a"]) and evidence[48:112] == s["current_balance_certificate_digest"].encode(), "surface evidence current/certificate differs")
    ordered = sha256(b"antenna_rt0_surface_ordered_targets.v1" + struct.pack("<Q", n) + payloads["sample_xyz"]).hexdigest()
    require(evidence[112:176] == ordered.encode(), "surface ordered target digest differs")
    snapshot = json_body(HttpResult(200, {"content-type": "application/json"}, evidence[176:]), 200)
    require(snapshot.get("schema_version") == "fem_rt0_surface_snapshot.v1" and snapshot.get("operator_version") in ("fem_oersted_rt0_surface.inspection.v1", "fem_oersted_rt0_surface.mpfr128_160_rndn_etoff.inspection.v1") and snapshot.get("basis_version") == "fem_generic_affine_rt0.v1" and snapshot.get("inspection_only") is True and snapshot.get("error_certificate_available") is False, "surface snapshot versions or qualification differ")
    require(snapshot.get("source_view_identity_digest") == s["view_identity_digest"] and snapshot.get("accepted_source_state_digest") == s["accepted_source_state_digest"], "surface accepted source differs")
    policy = {key: snapshot[key] for key in ("policy_version", "limits", "tolerances")}
    # Match closed_loop_public_inspection::inspection_view's thin named counters.
    encoding = m.get("surface_counter_encoding")
    require(encoding in (None, "named_work_kind.v1"), "surface counter encoding differs")
    if encoding is not None:
        names = ("source_target_pairs", "face_precision_passes", "whole_face_formulas",
                 "signed_fan_panels", "exact_fraction_operations", "exact_integer_operations",
                 "exact_comparisons", "real_divisions", "copied_input_bytes",
                 "reserved_output_bytes", "sqrt_calls", "log_calls", "log1p_calls", "atan2_calls")
        policy["limits"] = dict(policy["limits"])
        for name in ("total", "per_target"):
            counts = policy["limits"].get(name)
            require(isinstance(counts, list) and len(counts) == len(names), "surface counter array differs")
            policy["limits"][name] = dict(zip(names, counts))
    require(policy == m["requested_intent"].get("surface_field_policy") == m["resolved_execution"].get("surface_field_policy"), "surface requested/resolved policy differs")
    pending = [snapshot]
    while pending:
        value = pending.pop()
        if isinstance(value, dict): pending.extend(value.values())
        elif isinstance(value, list): pending.extend(value)
        elif isinstance(value, float): require(math.isfinite(value), "surface nonfinite JSON number")
    def vector(values):
        require(isinstance(values, list) and len(values) == 3 and all(finite(v) for v in values), "surface invalid vector")
        return struct.pack("<3d", *values)
    def decimal(value, nonnegative=False):
        require(isinstance(value, str) and 0 < len(value) <= 4096 and re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", value), "surface invalid decimal")
        exponent = re.split("[eE]", value)
        require(len(exponent) == 1 or -(1 << 31) <= int(exponent[1]) < (1 << 31), "surface decimal exponent bound")
        number = Decimal(value)
        require(number.is_finite() and (not nonnegative or number >= 0), "surface nonfinite or negative diagnostic")
        return number
    positions, targets = snapshot.get("targets_xyz_m"), snapshot.get("targets")
    require(isinstance(positions, list) and isinstance(targets, list) and len(positions) == len(targets) == n, "surface target count differs")
    for i, (position, target) in enumerate(zip(positions, targets)):
        require(vector(position) == payloads["sample_xyz"][24*i:24*(i+1)] and vector(target["h_xyz_apm"]) == payloads["h_raw"][24*i:24*(i+1)], "surface H/target sampling carrier differs")
        precisions = target["precisions"]
        require(isinstance(precisions, list) and len(precisions) == 3 and type(target["binary64_requires_highprecision"]) is bool, "surface precision shape differs")
        for index, precision in enumerate(precisions):
            evaluated = precision["evaluated"]
            require(type(evaluated) is bool, "surface precision flag differs")
            numbers = [*precision["h_xyz_apm"], *precision["whole_h_xyz_apm"], *(precision[key] for key in ("sum_local_norm_apm", "cancellation", "maximum_face_cancellation"))]
            require(isinstance(precision["h_xyz_apm"], list) and isinstance(precision["whole_h_xyz_apm"], list) and len(precision["h_xyz_apm"]) == len(precision["whole_h_xyz_apm"]) == 3, "surface precision vector differs")
            if not evaluated:
                reason = precision["refusal_reason"]
                require(index == 0 and target["binary64_requires_highprecision"] and isinstance(reason, str) and 0 < len(reason) <= 4096 and "\0" not in reason and all(value == "" for value in numbers), "surface refused precision differs")
                continue
            require(precision["refusal_reason"] == "", "surface evaluated precision refusal")
            for j, number in enumerate(numbers): decimal(number, j >= 6)
        require(struct.pack("<3d", *(float(decimal(v)) for v in precisions[2]["h_xyz_apm"])) == payloads["h_raw"][24*i:24*(i+1)], "surface highprecision H rounding differs")
        for key in ("precision_budget_apm", "local_precision_delta_apm", "local_formula_delta_apm", "local_formula_delta_80_apm"):
            decimal(target[key], True)
        if precisions[0]["evaluated"]:
            decimal(target["binary64_roundoff_indicator_apm"], True)
        else:
            require(target["binary64_roundoff_indicator_apm"] == "", "surface refused binary roundoff")


def decode_payloads(m, payloads):
    s, n, c = m["source"], m["vertex_count"], m["cell_count"]
    for key in ("vertex_xyz", "sample_xyz", "conductivity", "v_raw", "v_per_a", "j_center_raw", "j_center_per_a", "j_local_raw", "j_local_per_a", "h_raw", "h_per_a"):
        doubles(payloads[key])
    require(all(v > 0 for v in doubles(payloads["conductivity"])), "nonpositive conductivity")
    for raw, per_a in (("v_raw", "v_per_a"), ("j_center_raw", "j_center_per_a"), ("j_local_raw", "j_local_per_a"), ("h_raw", "h_per_a")):
        scaled = b"".join(struct.pack("<d", v*m["scale_per_a"]) for v in doubles(payloads[raw]))
        require(scaled == payloads[per_a], f"{per_a} not exact signed raw/Ic")
    ids = [v for (v,) in struct.iter_unpack("<Q", payloads["stable_vertex_ids"])]
    require(len(ids) == n and len(set(ids)) == n, "duplicate stable u64 identity")
    xyz = list(struct.iter_unpack("<3d", payloads["vertex_xyz"]))
    by_id = dict(zip(ids, xyz))
    cells = list(struct.iter_unpack("<5Q30d", payloads["cells"]))
    require(len(cells) == c and all(row[0] == i for i, row in enumerate(cells)), "cell ordinal/count differs")
    for row in cells:
        require(len(set(row[1:5])) == 4 and all(v in by_id for v in row[1:5]), "cell vertex identity differs")
        require(all(bits(row[5+3*j+a]) == bits(by_id[v][a]) for j, v in enumerate(row[1:5]) for a in range(3)), "foreign cell-local geometry")
        require(all(math.isfinite(v) for v in row[5:]), "non-finite cells280 scalar")
    require(b"".join(struct.pack("<12d", *row[17:29]) for row in cells) == payloads["j_local_raw"] and b"".join(struct.pack("<3d", *row[32:35]) for row in cells) == payloads["j_center_raw"], "separate J carrier differs from cells280")
    sample = list(struct.iter_unpack("<3d", payloads["sample_xyz"]))
    sample_cells = list(struct.iter_unpack("<4I", payloads["sample_cells"]))
    used = set()
    for tet in sample_cells:
        require(len(set(tet)) == 4 and max(tet) < len(sample), "invalid H sampling Tet4 indices")
        used.update(tet)
        a, b, d, e = (sample[v] for v in tet)
        edges = [tuple(p[k]-a[k] for k in range(3)) for p in (b, d, e)]
        scale = max(abs(v) for edge in edges for v in edge)
        require(scale > 0 and math.isfinite(scale), "invalid H Tet4 extent")
        x, y, z = (tuple(v/scale for v in edge) for edge in edges)
        det = x[0]*(y[1]*z[2]-y[2]*z[1])-x[1]*(y[0]*z[2]-y[2]*z[0])+x[2]*(y[0]*z[1]-y[1]*z[0])
        require(math.isfinite(det) and det > 0, "nonpositive H sampling Tet4 volume")
    require(used == set(range(len(sample))), "H sampling nodes not covered by cells")
    rows = {}
    for key, (digest_key, schema) in SCHEMAS.items():
        require(sha256(payloads[key]).hexdigest() == s[digest_key], "crossed canonical preimage digest")
        rows[key] = preimage_fields(payloads[key])
        require(rows[key][0] == ("schema", 1, schema), "canonical preimage schema/order")
    p, q, state = (rows[key] for key in SCHEMAS)
    require(one(p, "object_id", 1) == m["source_object_id"] and one(p, "source_module_id", 1) == m["current_transport_id"], "prepared source owner differs")
    authored = json_body(HttpResult(200, {"content-type": "application/json"}, payloads["authoring_receipt"]), 200)
    require(tagged_json_digest(authored) == one(p, "authored_input_digest", 1) and "requested_execution" in authored and m["requested_intent"].get("requested_execution") == authored["requested_execution"], "authored receipt/digest/requested execution differs")
    require(one(q, "prepared_execution_digest", 3) == bytes.fromhex(s["prepared_execution_digest"]) and one(state, "prepared_execution_digest", 3) == bytes.fromhex(s["prepared_execution_digest"]) and one(state, "accepted_charge_field_digest", 3) == bytes.fromhex(s["accepted_charge_field_digest"]), "nested accepted identity differs")
    layout = [("vertex_id", 2)] + [(k, 2) for k in ("vertex_x_bits", "vertex_y_bits", "vertex_z_bits", "potential_v_bits")]
    vertices = group(q, "vertex_count", n, layout)
    require(vertices == [[id, *(bits(v) for v in position), bits(potential)] for id, position, potential in zip(ids, xyz, doubles(payloads["v_raw"]))], "charge preimage/Vnode carrier differs")
    mesh_layout = [(f"cell_vertex_{i}_id", 2) for i in range(4)] + [("conductivity_spm_bits", 2)]
    expected_cells = [[*row[1:5], bits(sigma)] for row, sigma in zip(cells, doubles(payloads["conductivity"]))]
    require(group(p, "element_count", c, mesh_layout) == expected_cells and group(q, "element_count", c, mesh_layout) == expected_cells, "prepared/charge element carrier differs")
    source_layout = [("source_element_index", 2)] + [(name, 2) for _ in range(4) for name in ("vertex_id", "vertex_x_bits", "vertex_y_bits", "vertex_z_bits", "current_x_apm2_bits", "current_y_apm2_bits", "current_z_apm2_bits")] + [(name, 2) for name in ("center_x_bits", "center_y_bits", "center_z_bits", "center_current_x_apm2_bits", "center_current_y_apm2_bits", "center_current_z_apm2_bits")]
    expected_source = [[row[0], *itertools.chain.from_iterable([row[1+j], *(bits(v) for v in row[5+3*j:8+3*j]), *(bits(v) for v in row[17+3*j:20+3*j])] for j in range(4)), *(bits(v) for v in row[29:35])] for row in cells]
    require(group(state, "sampled_cell_count", c, source_layout) == expected_source, "source preimage/cells280 differs")
    for name, metadata in (("source_current_a_bits", "source_current_a"), ("source_absolute_flux_a_bits", "source_absolute_flux_a"), ("max_paired_weak_flux_mismatch_a_bits", "max_paired_weak_flux_mismatch_a")):
        require(one(state, name, 2) == bits(s[metadata]), "source scalar/preimage differs")
    for name, metadata in (("potential_drop_v_bits", "potential_jump_v"), ("measured_potential_jump_v_bits", "measured_potential_jump_v"), ("gauge_mean_v_bits", "gauge_mean_v"), ("charge_relative_residual_bits", "charge_relative_residual")):
        require(one(q, name, 2) == bits(s[metadata]), "charge scalar/preimage differs")
    require(one(state, "canonical_balance_certificate", 3) == payloads["certificate"] and sha256(payloads["certificate"]).hexdigest() == s["current_balance_certificate_digest"], "certificate/source preimage differs")
    certificate = payloads["certificate"]
    label = b"fem_conservative_current_balance_certificate.v1"
    offset = 8+len(label)
    require(len(certificate) >= offset+24+48+49 and certificate[:offset] == struct.pack("<Q", len(label))+label and certificate[offset:offset+24] == struct.pack("<3d", 1e-12, 1e-10, 1e-18), "certificate schema/gates differ")
    balance_rows, rank, ne, nf, nc, no = struct.unpack_from("<6Q", certificate, offset+24)
    require(ne == c and nf <= 4*c and nc <= nf and no <= balance_rows and rank+no == balance_rows, "certificate dimensions/rank differ")
    summary = struct.unpack("<6dB", certificate[-49:])
    require(all(math.isfinite(v) for v in summary[:6]) and 0 <= summary[4] <= 1e-12 and summary[5] >= 0 and summary[6] == 1, "certificate closure/KKT summary differs")
    faces = list(struct.iter_unpack("<3Qd", payloads["faces"]))
    require(group(state, "canonical_face_count", m["face_count"], [(f"face_vertex_{i}_id", 2) for i in range(3)]+[("flux_a_bits", 2)]) == [[*row[:3], bits(row[3])] for row in faces], "canonical face/preimage differs")
    weak = list(struct.iter_unpack("<2Q2d", payloads["weak"]))
    require(group(state, "paired_weak_reaction_count", m["weak_reaction_count"], [(k, 2) for k in ("minus_vertex_id", "plus_vertex_id", "minus_reaction_a_bits", "plus_reaction_a_bits")]) == [[*row[:2], bits(row[2]), bits(row[3])] for row in weak], "weak ledger/preimage differs")
    require(all(abs(a+b) <= 1e-18+1e-10*(abs(a)+abs(b)) for _, _, a, b in weak), "paired weak gate differs")
    verify_field_evidence(m, payloads)
    # Full prepared-input, physical certificate and direct ledger admission is
    # performed by the API's canonical cold verifier, not this transport smoke.
    return {"source": s, "sample_carrier": m["sample_carrier"], "signed_normalization_a": m["signed_normalization_a"], "scale_per_a": m["scale_per_a"], "counts": {k:m[k] for k in ("vertex_count", "cell_count", "target_count", "sample_cell_count", "face_count", "weak_reaction_count")}, "payloads": m["payloads"], "content_digest": m["content_digest"], "requested_intent": m["requested_intent"], "resolved_execution": m["resolved_execution"]}


def verify(origin, stage_id, *, fetch=None):
    fetch = request if fetch is None else fetch
    origin = validate_origin(origin)
    require(isinstance(stage_id, str) and 0 < len(stage_id) <= 4096 and stage_id.strip() and "\0" not in stage_id, "invalid runtime stage ID")
    path = f"/v2/sessions/current/data/antenna/stages/{quote(stage_id, safe='')}/external-lead-inspection"
    metadata = fetch(origin, path, {}, METADATA_BOUND)
    resource = json_body(metadata, 200)
    metadata_etag = strong_etag(metadata)
    m, digest = validate_resource(resource, stage_id)
    scope = {"x-fullmag-session-scope": session_scope(resource, resource["request_scope_epoch"])}
    query = urlencode({"content_digest": digest})
    display_response = fetch(origin, f"{path}/display?{query}", scope, METADATA_BOUND)
    display = json_body(display_response, 200)
    display_etag = strong_etag(display_response)
    require(display.get("schema_version") == "antenna_inspection_display.closed_loop.v2" and display.get("closed_loop_display") == m and display.get("content_digest") == digest and display.get("normalization") == "raw_authored_potential_jump", "display family/source manifest differs")
    require(all(display.get(k) == resource[k] for k in ("session_id", "session_epoch", "request_scope_epoch", "run_id", "runtime_stage_id", "stage_revision", "record_content_digest")), "display owner differs")
    require(display.get("capabilities") == {"display": True, "current_density": True, "per_ampere_basis": False, "source_fft": False, "llg_drive": False}, "inspection promoted to scientific capability")
    retained, checked = {}, []
    for kind, descriptor in m["payloads"].items():
        # Reuse the shared binary/cache/range verifier; these are actual v2 paths.
        d = {**descriptor, "byte_count": descriptor["byte_length"], "scalar_type": "opaque"}
        body, etag = verify_binary(origin, f"{path}/payloads/{kind}?{query}", scope, kind, d, fetch=fetch)
        retained[kind] = body
        checked.append({"kind": kind, "sha256": descriptor["sha256"], "byte_count": len(body), "unit": descriptor["unit"], "etag": etag})
    scientific_identity = decode_payloads(m, retained)
    changed = "sha256:" + ("0" if digest[7] != "0" else "1") + digest[8:]
    for tail in ("display", "payloads/h_raw"):
        rejected = json_body(fetch(origin, f"{path}/{tail}?{urlencode({'content_digest': changed})}", {**scope, "If-None-Match": "*"}, METADATA_BOUND), 409)
        require(rejected.get("code") == "inspection_digest_mismatch", "stale digest accepted")
    stale = {"x-fullmag-session-scope": session_scope(resource, resource["request_scope_epoch"]+"-stale-smoke"), "If-None-Match": "*", "Range": "bytes=0-7"}
    for stale_path in [path, f"{path}/display?{query}"]+[f"{path}/payloads/{key}?{query}" for key in m["payloads"]]:
        require(json_body(fetch(origin, stale_path, stale, METADATA_BOUND), 409).get("error") == "request_context_stale", "stale scope accepted")
    missing_path = path.replace("/stages/"+quote(stage_id, safe='')+"/", "/stages/missing-closed-smoke-"+uuid4().hex+"/", 1)
    for tail in ("", f"/display?{query}", f"/payloads/h_raw?{query}"):
        json_body(fetch(origin, missing_path+tail, scope, METADATA_BOUND), 404)
    for pinned_path, etag in ((path, metadata_etag), (f"{path}/display?{query}", display_etag)):
        final = fetch(origin, pinned_path, {**scope, "If-None-Match": etag}, METADATA_BOUND)
        require(final.status == 304 and not final.body and strong_etag(final) == etag, "owner/revision changed during complete read")
    return {"schema": "fullmag.antenna_closed_loop_http_smoke.v2", "status": "pass", "scope": "http_closed_loop_inspection_integrity_only", "qualification": "NOT VERIFIED", "physics_qualified": False, "native_canonical_bundle_redecoded": False, "inspection_ref": resource["outputs"][0]["inspection_ref"], "scientific_identity": scientific_identity, "runtime_stage_id": stage_id, "payloads": checked}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--stage-id", required=True)
    args = parser.parse_args(argv)
    try:
        result = verify(args.origin, args.stage_id)
    except (ValueError, UnicodeError, struct.error, OverflowError, KeyError, TypeError) as error:
        result = {"schema": "fullmag.antenna_closed_loop_http_smoke.v2", "status": "fail", "physics_qualified": False, "qualification": "NOT VERIFIED", "reason": str(error)}
    print(json.dumps(result, sort_keys=True))
    return 0 if result["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
