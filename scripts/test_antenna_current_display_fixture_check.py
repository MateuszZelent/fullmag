"""Synthetic transport/J-oracle regressions, never proof of a native solve."""
import hashlib
import math

import pytest
from scripts import antenna_current_display_fixture_check as check
from scripts import antenna_rt0_fixture_check as rt0
from scripts.test_antenna_rt0_fixture_check import inputs, encode, synthetic_bundle, change


def receipt_for(payload, count=12):
    return {("schema_version" if key == "schema" else key): value
            for key, value in check.HEADER.items() if key not in ("status", "field_scope")} | {
        "cell_count": count, "payload": {"path": "current_display.v1.bin",
            "scalar_type": "ordered_binary_v1", "layout": check.HEADER["schema"],
            "unit": "A/m^2", "byte_count": len(payload), "value_count": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest()}}


def snapshot_fixture(inputs):
    outer = rt0.fields(synthetic_bundle(inputs))
    source = rt0.fields(rt0.one(outer, "source_record", 3))
    authored = inputs["current_definition"]["conservative_current_source"]
    partition = []
    for kind in ("device", "lead"):
        ids = authored[kind + "_stable_vertex_ids"]
        partition += [(kind + "_vertex_count", 2, len(ids))] + [
            (kind + "_vertex_id", 2, identity) for identity in ids]
    begin = next(i for i, row in enumerate(source) if row[0] == "face_count")
    source[begin:begin] = partition
    source_bytes = encode(source)
    change(outer, "source_record", source_bytes)
    change(outer, "source_content_sha256", hashlib.sha256(source_bytes).hexdigest())
    bundle = encode(outer)
    charge = rt0.fields(rt0.one(outer, "charge_record", 3))
    vertices = rt0.group(charge, "vertices", 48, [("vertex_id", 2)] + [
        ("xyz_m", 4)] * 3 + [("potential_v", 4), ("reaction_a", 4),
        ("vertex_component_id", 2)], skip=1)
    xyz = {row[0]: row[1:4] for row in vertices}
    elements = rt0.group(charge, "elements", 36, [("attribute", 2)] + [
        ("vertex_id", 2)] * 4 + [("conductivity_spm", 4)])
    rows = [(name, 1, value) for name, value in check.HEADER.items()] + [
        ("bundle_content_sha256", 1, hashlib.sha256(bundle).hexdigest()),
        ("charge_content_sha256", 1, rt0.one(outer, "charge_content_sha256", 1)),
        ("source_content_sha256", 1, rt0.one(outer, "source_content_sha256", 1)),
        ("stable_vertex_id_version", 1, "stable_mesh_vertex_u64.v1"),
        ("cell_count", 2, 12)]
    for index, element in enumerate(elements):
        ids = element[1:5]
        if not set(ids) <= set(authored["device_stable_vertex_ids"]):
            continue
        center = [sum(xyz[identity][axis] for identity in ids) / 4 for axis in range(3)]
        current = [1.0 if center[1] <= 1 else -1.0, 0.0, 0.0]
        rows += [("source_element_index", 2, index)]
        for identity in ids:
            rows += [("vertex_id", 2, identity)] + [
                ("vertex_coordinate_m", 4, value) for value in xyz[identity]] + [
                ("vertex_current_apm2", 4, value) for value in current]
        rows += [("center_coordinate_m", 4, value) for value in center] + [
            ("center_current_apm2", 4, value) for value in current]
    payload = encode(rows)
    return bundle, payload, receipt_for(payload)


def test_complete_samples_bind_and_match_independent_current_and_face_moments(inputs):
    bundle, payload, receipt = snapshot_fixture(inputs)
    cells = check.decode_current_snapshot(payload, bundle_bytes=bundle, receipt=receipt)
    assert len(cells) == 12 and cells[0]["source_element_index"] == 0
    assert cells[-1]["source_element_index"] == 11
    result = check.compare_current_display_fixture(inputs, {"bundle_bytes": bundle,
        "current_display_bytes": payload, "current_display_receipt": receipt})
    assert result["center_sample_count"] == 12 and result["local_vertex_sample_count"] == 48
    assert result["face_trace_count"] == 48
    assert all(result[name] == 0 for name in ("max_current_vector_error_apm2",
        "max_affine_center_error_apm2", "max_trace_ledger_error_a", "max_device_element_flux_sum_a"))
    assert result["physics_qualified"] is False and result["native_canonical_bundle_redecoded"] is False


@pytest.mark.parametrize("name", list(check.HEADER) + ["bundle_content_sha256",
    "charge_content_sha256", "source_content_sha256", "stable_vertex_id_version",
    "source_element_index", "vertex_id", "vertex_coordinate_m", "cell_count"])
def test_resigned_foreign_policies_pins_ids_coordinates_and_counts_fail(inputs, name):
    bundle, payload, _ = snapshot_fixture(inputs)
    rows = rt0.fields(payload)
    value = "wrong" if name in check.HEADER or name.endswith("sha256") or name.endswith("version") \
        else 13 if name == "cell_count" else 999 if name != "vertex_coordinate_m" else 0.125
    change(rows, name, value)
    payload = encode(rows)
    with pytest.raises(ValueError):
        check.decode_current_snapshot(payload, bundle_bytes=bundle, receipt=receipt_for(payload))


@pytest.mark.parametrize("name,value", [("center_current_apm2", float("nan")),
    ("vertex_current_apm2", float("inf")), ("center_coordinate_m", -0.0)])
def test_resigned_noncanonical_scalars_fail(inputs, name, value):
    bundle, payload, _ = snapshot_fixture(inputs)
    rows = rt0.fields(payload)
    change(rows, name, value)
    payload = encode(rows)
    with pytest.raises(ValueError):
        check.decode_current_snapshot(payload, bundle_bytes=bundle, receipt=receipt_for(payload))


@pytest.mark.parametrize("mutation", ["truncated", "extra", "duplicate_header", "reordered_cells"])
def test_exact_record_consumption_is_required(inputs, mutation):
    bundle, payload, _ = snapshot_fixture(inputs)
    rows = rt0.fields(payload)
    if mutation == "truncated": payload = payload[:-1]
    elif mutation == "extra": payload += b"x"
    elif mutation == "duplicate_header": payload = encode([rows[0], *rows])
    else: payload = encode(rows[:15] + rows[50:85] + rows[15:50] + rows[85:])
    with pytest.raises(ValueError):
        check.decode_current_snapshot(payload, bundle_bytes=bundle, receipt=receipt_for(payload))


@pytest.mark.parametrize("name", ["center_current_apm2", "vertex_current_apm2", "center_coordinate_m"])
def test_integrity_valid_but_scientifically_wrong_values_fail(inputs, name):
    bundle, payload, _ = snapshot_fixture(inputs)
    rows = rt0.fields(payload)
    change(rows, name, 0.123)
    payload = encode(rows)
    # Generic transport binding retains native values; the independent oracle
    # must reject them even though their hashes and topology still agree.
    assert len(check.decode_current_snapshot(payload, bundle_bytes=bundle,
        receipt=receipt_for(payload))) == 12
    with pytest.raises(ValueError, match="I/A|center"):
        check.compare_current_display_fixture(inputs, {"bundle_bytes": bundle,
            "current_display_bytes": payload, "current_display_receipt": receipt_for(payload)})


@pytest.mark.parametrize("name", ["vertices", "elements", "device_vertex_count", "lead_vertex_count"])
def test_huge_declared_counts_fail_without_iteration(inputs, name):
    bundle, payload, _ = snapshot_fixture(inputs)
    outer = rt0.fields(bundle)
    kind = "charge" if name in ("vertices", "elements") else "source"
    rows = rt0.fields(rt0.one(outer, kind + "_record", 3))
    change(rows, name, (1 << 64) - 1)
    nested = encode(rows)
    change(outer, kind + "_record", nested)
    change(outer, kind + "_content_sha256", hashlib.sha256(nested).hexdigest())
    if kind == "charge":
        source = rt0.fields(rt0.one(outer, "source_record", 3))
        change(source, "charge_content_digest", hashlib.sha256(nested).hexdigest())
        source_bytes = encode(source)
        change(outer, "source_record", source_bytes)
        change(outer, "source_content_sha256", hashlib.sha256(source_bytes).hexdigest())
    bundle = encode(outer)
    with pytest.raises(ValueError, match="declared count"):
        check.decode_current_snapshot(payload, bundle_bytes=bundle, receipt=receipt_for(payload))


def test_wrong_receipt_hash_issuer_and_tolerances_fail(inputs):
    bundle, payload, receipt = snapshot_fixture(inputs)
    receipt["payload"]["sha256"] = "0" * 64
    with pytest.raises(ValueError, match="descriptor/hash"):
        check.decode_current_snapshot(payload, bundle_bytes=bundle, receipt=receipt)
    values = {"bundle_bytes": bundle, "current_display_bytes": payload,
              "current_display_receipt": receipt_for(payload)}
    for tolerance in (True, 0, -1, math.nan, math.inf):
        with pytest.raises(ValueError, match="tolerance"):
            check.compare_current_display_fixture(inputs, values, current_tolerance_apm2=tolerance)
    with pytest.raises(ValueError, match="input pin"):
        check.compare_current_display_fixture({**inputs, "port_mode": {}}, values)
