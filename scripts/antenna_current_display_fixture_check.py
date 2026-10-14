"""Bounded snapshot association and independent fixed-fixture J comparison.

Not the canonical native decoder, a new RT0 solver, or a reusable field basis.
The caller must separately attest the executed build and validate V/RT0/H.
"""
from __future__ import annotations

import hashlib
import itertools
import math
import struct

from antenna_current_source_oracle import FIXTURE_INPUT_SHA256, fixture_input_digest
from antenna_rt0_fixture_check import LIMIT, cross, fields, group, one

HEADER = {
    "schema": "accepted_external_lead_current_display.ordered.v1",
    "operator_version": "fem_accepted_external_lead_current_display.v1",
    "current_evaluator_version": "fem_generic_affine_rt0.v1",
    "sampling_policy": "cell_center_and_cell_local_vertices.v1",
    "center_policy": "vertex_quarter_sum.long_double.v1",
    "field_scope": "external_electrode_truncation",
    "status": "inspection_only", "normalization": "raw_authored_current",
    "coordinate_unit": "m", "current_density_unit": "A/m^2",
}
CELL_LAYOUT = [("source_element_index", 2)] + (
    [("vertex_id", 2)] + [("vertex_coordinate_m", 4)] * 3 +
    [("vertex_current_apm2", 4)] * 3) * 4 + [
    ("center_coordinate_m", 4)] * 3 + [("center_current_apm2", 4)] * 3


def require(condition, message):
    if not condition:
        raise ValueError("Current snapshot: " + message)


def real_bytes(values):
    return b"".join(struct.pack(">d", value) for value in values)


def bounded_count(rows, name, width):
    count = one(rows, name, 2)
    require(0 < count <= len(rows) // width, "declared count exceeds available fields")
    return count


def validate_current_receipt(receipt, payload):
    """Check the receipt envelope without claiming a decoded native snapshot."""
    expected = {("schema_version" if key == "schema" else key): value
                for key, value in HEADER.items() if key not in ("field_scope", "status")}
    require(isinstance(receipt, dict) and set(receipt) == set(expected) | {"cell_count", "payload"}
            and all(receipt.get(key) == value for key, value in expected.items()),
            "receipt policy or SI differs")
    count = receipt["cell_count"]
    require(type(count) is int and 0 < count <= LIMIT // 1501 and
            1501 * count < len(payload) <= LIMIT, "receipt count or byte bound differs")
    descriptor = receipt["payload"]
    expected_payload = {"path": "current_display.v1.bin", "scalar_type": "ordered_binary_v1",
        "layout": HEADER["schema"], "unit": "A/m^2", "byte_count": len(payload),
        "value_count": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
    require(isinstance(descriptor, dict) and set(descriptor) == set(expected_payload) and
            type(descriptor.get("byte_count")) is int and
            type(descriptor.get("value_count")) is int and descriptor == expected_payload,
            "payload descriptor/hash differs")


def decode_current_snapshot(payload, *, bundle_bytes, receipt):
    """Bind native samples to retained geometry; no reconstruction of J.

    Partial charge/source extraction is intentionally distinct from the full
    Rust decoder. Center arithmetic is retained, not recomputed generically.
    """
    validate_current_receipt(receipt, payload)
    outer = fields(bundle_bytes)
    require([(name, tag) for name, tag, _ in outer] == [
        ("schema", 1), ("operator_version", 1), ("field_scope", 1),
        ("charge_content_sha256", 1), ("charge_record", 3),
        ("source_content_sha256", 1), ("source_record", 3),
        ("field_content_sha256", 1), ("field_record", 3)] and
        one(outer, "schema", 1) == "accepted_external_lead_bundle.ordered.v1" and
        one(outer, "operator_version", 1) == "fem_accepted_external_lead_bundle.v1" and
        one(outer, "field_scope", 1) == HEADER["field_scope"], "bundle identity/order differs")
    for name in ("charge", "source", "field"):
        require(hashlib.sha256(one(outer, name + "_record", 3)).hexdigest() ==
                one(outer, name + "_content_sha256", 1), "nested SHA differs")
    charge = fields(one(outer, "charge_record", 3))
    source = fields(one(outer, "source_record", 3))
    require(one(charge, "schema", 1) == "accepted_terminal_charge_source.ordered.v1" and
            one(charge, "operator", 1) == "fem_accepted_terminal_charge_source.v1" and
            one(source, "schema", 1) == "accepted_external_lead_current_source.ordered.v2" and
            one(source, "operator_version", 1) == "fem_accepted_external_lead_current_source.v2" and
            one(source, "field_scope", 1) == HEADER["field_scope"] and
            one(source, "charge_content_digest", 1) == one(outer, "charge_content_sha256", 1),
            "charge/source identity differs")
    vertices = group(charge, "vertices", bounded_count(charge, "vertices", 8),
        [("vertex_id", 2)] + [("xyz_m", 4)] * 3 +
        [("potential_v", 4), ("reaction_a", 4), ("vertex_component_id", 2)], skip=1)
    xyz = {row[0]: row[1:4] for row in vertices}
    require(vertices and len(xyz) == len(vertices) and all(xyz), "vertex identities differ")
    partitions = []
    for kind in ("device", "lead"):
        ids = [row[0] for row in group(source, kind + "_vertex_count",
            bounded_count(source, kind + "_vertex_count", 1), [(kind + "_vertex_id", 2)])]
        require(ids and ids == sorted(set(ids)) and all(identity in xyz for identity in ids),
                "partition IDs differ")
        partitions.append(set(ids))
    device, lead = partitions
    require(not device & lead and device | lead == set(xyz), "partition coverage differs")
    elements = group(charge, "elements", bounded_count(charge, "elements", 6),
        [("attribute", 2)] + [("vertex_id", 2)] * 4 + [("conductivity_spm", 4)])
    selected = []
    for index, element in enumerate(elements):
        ids = element[1:5]
        require(len(set(ids)) == 4 and (set(ids) <= device or set(ids) <= lead),
                "mixed/foreign element ownership")
        if set(ids) <= device:
            selected.append((index, ids))
    require(len(selected) == receipt["cell_count"], "complete device cell coverage differs")
    rows = fields(payload)
    pins = {"bundle_content_sha256": hashlib.sha256(bundle_bytes).hexdigest(),
        "charge_content_sha256": one(outer, "charge_content_sha256", 1),
        "source_content_sha256": one(outer, "source_content_sha256", 1),
        "stable_vertex_id_version": one(charge, "stable_vertex_version", 1)}
    expected_header = [(key, 1, value) for key, value in {**HEADER, **pins}.items()]
    require(rows[:14] == expected_header and
            [(name, tag) for name, tag, _ in rows] ==
            [(key, 1) for key in {**HEADER, **pins}] + [("cell_count", 2)] +
            CELL_LAYOUT * len(selected), "snapshot header/pins/exact order differs")
    chunks = group(rows, "cell_count", len(selected), CELL_LAYOUT)
    cells = []
    for chunk, (index, ids) in zip(chunks, selected):
        require(chunk[0] == index, "whole-mesh element index/order differs")
        positions, currents = [], []
        for local, identity in enumerate(ids):
            offset = 1 + 7 * local
            require(chunk[offset] == identity, "cell-local ID/order differs")
            position, current = chunk[offset + 1:offset + 4], chunk[offset + 4:offset + 7]
            require(real_bytes(position) == real_bytes(xyz[identity]), "retained coordinates differ")
            positions.append(position)
            currents.append(current)
        cells.append({"source_element_index": index, "vertex_ids": ids,
            "vertex_positions_m": positions, "vertex_current_apm2": currents,
            "center_position_m": chunk[29:32], "center_current_apm2": chunk[32:35]})
    return cells


def compare_current_display_fixture(inputs, values, *, current_tolerance_apm2=1e-8,
                                    flux_tolerance_a=1e-8):
    """Check every fixed-fixture J sample and affine normal-face integral."""
    require(fixture_input_digest(inputs) == FIXTURE_INPUT_SHA256, "fixed input pin differs")
    for tolerance in (current_tolerance_apm2, flux_tolerance_a):
        require(type(tolerance) in (int, float) and math.isfinite(tolerance) and tolerance > 0,
                "invalid comparison tolerance")
    cells = decode_current_snapshot(values["current_display_bytes"],
        bundle_bytes=values["bundle_bytes"], receipt=values["current_display_receipt"])
    authored = inputs["current_definition"]["conservative_current_source"]
    require(len(cells) == 12 and {identity for cell in cells for identity in cell["vertex_ids"]}
            == set(authored["device_stable_vertex_ids"]), "fixed device coverage differs")
    outer = fields(values["bundle_bytes"])
    ledger = group(fields(one(outer, "source_record", 3)), "face_count", 108,
        [("face_vertex_id", 2)] * 3 + [("face_side_count", 2),
        ("face_rt0_to_canonical_weight", 4), ("face_canonical_flux_a", 4),
        ("face_first_outward_a", 4), ("face_second_outward_a", 4), ("face_canonical_jump_a", 4)])
    by_face = {tuple(row[:3]): row[5] for row in ledger}
    require(len(by_face) == 108, "retained face identity differs")
    max_j, max_affine, max_flux, max_balance = 0.0, 0.0, 0.0, 0.0
    for cell in cells:
        positions, currents = cell["vertex_positions_m"], cell["vertex_current_apm2"]
        center = [math.fsum(point[axis] for point in positions) / 4 for axis in range(3)]
        require(real_bytes(center) == real_bytes(cell["center_position_m"]), "fixed center differs")
        expected = [1.0 if center[1] <= 1.0 else -1.0, 0.0, 0.0]
        for current in [*currents, cell["center_current_apm2"]]:
            error = math.dist(expected, current)
            require(math.isfinite(error) and error <= current_tolerance_apm2, "I/A vector mismatch")
            max_j = max(max_j, error)
        mean = [math.fsum(current[axis] for current in currents) / 4 for axis in range(3)]
        error = math.dist(mean, cell["center_current_apm2"])
        require(math.isfinite(error) and error <= current_tolerance_apm2, "affine center relation differs")
        max_affine = max(max_affine, error)
        local = {identity: i for i, identity in enumerate(cell["vertex_ids"])}
        outward = []
        for face in itertools.combinations(sorted(local), 3):
            a, b, c = [positions[local[identity]] for identity in face]
            area = [v / 2 for v in cross([b[i]-a[i] for i in range(3)],
                                        [c[i]-a[i] for i in range(3)])]
            mean = [math.fsum(currents[local[identity]][axis] for identity in face) / 3
                    for axis in range(3)]
            moment = math.fsum(mean[i] * area[i] for i in range(3))
            require(face in by_face, "face missing from retained ledger")
            error = abs(moment - by_face[face])
            require(math.isfinite(error) and error <= flux_tolerance_a, "trace/ledger moment mismatch")
            max_flux = max(max_flux, error)
            opposite = positions[local[next(identity for identity in local if identity not in face)]]
            orientation = math.fsum(area[i] * (opposite[i]-a[i]) for i in range(3))
            require(orientation != 0.0, "degenerate fixed tetrahedron")
            outward.append(moment if orientation < 0 else -moment)
        balance = abs(math.fsum(outward))
        require(math.isfinite(balance) and balance <= flux_tolerance_a, "trace element balance differs")
        max_balance = max(max_balance, balance)
    return {"scope": "fixed_fixture_native_J_samples_and_face_moments", "comparison": "PASS",
        "device_cell_count": 12, "center_sample_count": 12, "local_vertex_sample_count": 48,
        "face_trace_count": 48, "current_tolerance_apm2": current_tolerance_apm2,
        "flux_tolerance_a": flux_tolerance_a, "max_current_vector_error_apm2": max_j,
        "max_affine_center_error_apm2": max_affine, "max_trace_ledger_error_a": max_flux,
        "max_device_element_flux_sum_a": max_balance,
        "native_canonical_bundle_redecoded": False, "physics_qualified": False,
        "qualification": "NOT VERIFIED"}
