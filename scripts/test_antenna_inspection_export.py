"""Export-integrity regressions with synthetic bytes, never native proof."""
import json
import struct
from pathlib import Path

import pytest
from scripts import antenna_inspection_export as reader


def synthetic_export(root, *, manifest_change=None, record_change=None, generation=1):
    payloads = {"bundle": b"synthetic bundle: NOT a canonical native record",
        "sample_positions": struct.pack("<12d", 0, 0, 2, 1, 0, 2, 0, 1, 2, 0, 0, 3),
        "magnetic_field": struct.pack("<12d", *[0.0] * 12),
        "device_vertex_ids": struct.pack("<16Q", *range(1, 17)),
        "device_potential": struct.pack("<16d", *[0.0] * 16)}
    manifest = {"schema_version": f"antenna_external_lead_solution.v{generation}",
        "stage_id": "inspect_antenna", "port_mode_id": "port", "output_id": "inspection",
        "status": "inspection_only", "qualification": "NOT VERIFIED",
        "field_scope": "external_electrode_truncation", "source_object_id": "antenna",
        "current_transport_id": "antenna_charge", "drive_id": "drive",
        "closure_revision": "antenna_signal_return_input_v1",
        "resolved_execution": {"engine": "fem", "device": "cpu", "precision": "double",
            "operator_version": "fem_accepted_external_lead_bundle.v1",
            "adapter_version": "antenna_external_lead_request_adapter.v1"},
        "sampling_carrier": {"sample_count": 4}, "numeric_lexeme_test": 1e-12}
    for key, (name, scalar, layout, unit, count) in reader.PAYLOADS.items():
        data = payloads[key]
        manifest[key] = {"path": name, "scalar_type": scalar, "layout": layout, "unit": unit,
            "byte_count": len(data), "value_count": len(data) if count is None else count,
            "sha256": reader.sha256(data)}
    if generation == 2:
        from scripts.test_antenna_current_display_fixture_check import receipt_for
        # Envelope-only fixture, deliberately not a canonical native snapshot.
        payloads["current_display"] = b"synthetic J" * 2000
        manifest["current_display"] = receipt_for(payloads["current_display"])
    if manifest_change:
        manifest_change(manifest)
    # Match the Rust publisher's sorted object preimage without relying on the
    # reader's implementation; this fixture never purports to be a native bundle.
    compact = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    manifest["content_digest"] = "sha256:" + reader.sha256(compact)
    revision = manifest["content_digest"][7:]
    manifest_ref = f"antenna/external_lead_solutions/inspection/{revision}/manifest.v{generation}.json"
    revision_root = root / Path(manifest_ref).parent
    revision_root.mkdir(parents=True)
    (root / manifest_ref).write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    for key, (name, *_rest) in reader.PAYLOADS.items():
        (revision_root / name).write_bytes(payloads[key])
    if generation == 2:
        (revision_root / "current_display.v1.bin").write_bytes(payloads["current_display"])
    record = {"schema_version": f"antenna_external_lead_stage_output.v{generation}",
        "stage_kind": "antenna_field_solve", "resolved_action": "external_lead_inspection",
        **{k: manifest[k] for k in ("stage_id", "port_mode_id", "output_id", "status", "qualification", "field_scope")},
        "outputs": [{"kind": "antenna_external_lead_inspection",
            "inspection_ref": {"stage_id": "inspect_antenna", "output_id": "inspection",
                               "content_digest": manifest["content_digest"]},
            "manifest_ref": manifest_ref,
            "payload_units": {"V": "V", "RT0_coefficients": "A", "H": "A/m", "positions": "m"}}]}
    if generation == 2:
        record["outputs"][0]["payload_units"]["J_charge"] = "A/m^2"
    if record_change:
        record_change(record)
    stage = root / "stages/inspect_antenna" / reader.RECORD
    stage.parent.mkdir(parents=True)
    stage.write_text(json.dumps(record), encoding="utf-8")
    return stage, revision_root


def test_reads_all_values_without_claiming_native_canonical_validation(tmp_path):
    stage, _ = synthetic_export(tmp_path)
    result = reader.read_inspection(tmp_path, stage)
    assert result["device_ids"] == list(range(1, 17))
    assert result["positions_m"] == [[0, 0, 2], [1, 0, 2], [0, 1, 2], [0, 0, 3]]
    assert len(result["potential_v"]) == 16 and len(result["field_apm"]) == 4
    assert result["native_canonical_bundle_redecoded"] is False
    assert result["physics_qualified"] is False
    assert result["qualification"] == "NOT VERIFIED"


@pytest.mark.parametrize("key", list(reader.PAYLOADS))
def test_same_size_payload_mutation_is_rejected(tmp_path, key):
    stage, revision = synthetic_export(tmp_path)
    path = revision / reader.PAYLOADS[key][0]
    data = path.read_bytes()
    path.write_bytes(bytes([data[0] ^ 1]) + data[1:])
    with pytest.raises(ValueError, match="payload hash"):
        reader.read_inspection(tmp_path, stage)


@pytest.mark.parametrize("change", ["field_unit", "field_count", "cpu_lane", "target_count", "bundle_path"])
def test_resigned_incompatible_manifest_is_rejected(tmp_path, change):
    def mutate(value):
        if change == "field_unit": value["magnetic_field"]["unit"] = "T"
        elif change == "field_count": value["magnetic_field"]["value_count"] = 3
        elif change == "cpu_lane": value["resolved_execution"]["device"] = "gpu"
        elif change == "target_count": value["sampling_carrier"]["sample_count"] = 1
        elif change == "bundle_path": value["bundle"]["path"] = "../other.bin"
    stage, _ = synthetic_export(tmp_path, manifest_change=mutate)
    with pytest.raises(ValueError):
        reader.read_inspection(tmp_path, stage)


@pytest.mark.parametrize("change", ["other_stage", "latest_ref", "qualified", "double_output"])
def test_other_revision_or_promoted_record_is_rejected(tmp_path, change):
    def mutate(value):
        if change == "other_stage": value["stage_id"] = "another"
        elif change == "latest_ref": value["outputs"][0]["manifest_ref"] = "antenna/latest.json"
        elif change == "qualified": value["qualification"] = "qualified"
        elif change == "double_output": value["outputs"] *= 2
    stage, _ = synthetic_export(tmp_path, record_change=mutate)
    with pytest.raises(ValueError):
        reader.read_inspection(tmp_path, stage)


def test_rejects_duplicate_json_nonfinite_tokens_and_extra_files(tmp_path):
    for text in (b'{"key":1,"key":2}', b'{"key":NaN}'):
        with pytest.raises(ValueError):
            reader.parse(text)
    stage, revision = synthetic_export(tmp_path)
    (revision / "extra.bin").write_bytes(b"extra")
    with pytest.raises(ValueError, match="six files"):
        reader.read_inspection(tmp_path, stage)


def test_manifest_digest_preserves_serde_numeric_lexemes():
    # Re-encoding 1e-6 as Python float would yield 1e-06: keep the producer's
    # representation, sort objects, and remove only the digest field.
    data = b'{"z":1e-6,"a":{"v":-0.0},"content_digest":"old"}'
    assert reader.manifest_digest(data) == "sha256:" + reader.sha256(b'{"a":{"v":-0.0},"z":1e-6}')


def test_record_outside_executed_artifact_root_is_rejected(tmp_path):
    stage, _ = synthetic_export(tmp_path / "other")
    with pytest.raises(reader.storage.StorageError, match="must be contained"):
        reader.read_inspection(tmp_path / "expected", stage)


def test_v2_requires_current_payload_and_retains_legacy_bundle(tmp_path):
    stage, revision = synthetic_export(tmp_path, generation=2)
    result = reader.read_inspection(tmp_path, stage)
    assert result["inspection_generation"] == 2
    assert result["current_display_bytes"] == (revision / "current_display.v1.bin").read_bytes()
    assert result["current_display_receipt"]["cell_count"] == 12
    assert result["physics_qualified"] is False


@pytest.mark.parametrize("mutation", ["generation", "missing_receipt", "SI", "count", "hash", "unit", "path"])
def test_v2_resigned_incompatibilities_fail(tmp_path, mutation):
    def mutate(manifest):
        if mutation == "generation": manifest["schema_version"] = "antenna_external_lead_solution.v1"
        elif mutation == "missing_receipt": manifest.pop("current_display")
        elif mutation == "SI": manifest["current_display"]["current_density_unit"] = "A/m"
        elif mutation == "count": manifest["current_display"]["cell_count"] = 11
        elif mutation == "hash": manifest["current_display"]["payload"]["sha256"] = "0" * 64
        elif mutation == "unit": manifest["current_display"]["payload"]["unit"] = "T"
        else: manifest["current_display"]["payload"]["path"] = "../foreign.bin"
    stage, _ = synthetic_export(tmp_path, generation=2, manifest_change=mutate)
    with pytest.raises(ValueError):
        reader.read_inspection(tmp_path, stage)


def test_v1_current_receipt_and_two_manifests_fail(tmp_path):
    stage, _ = synthetic_export(tmp_path / "legacy", manifest_change=lambda manifest:
        manifest.update(current_display=None))
    with pytest.raises(ValueError, match="Legacy"):
        reader.read_inspection(tmp_path / "legacy", stage)
    stage, revision = synthetic_export(tmp_path / "v2", generation=2)
    (revision / "manifest.v1.json").write_bytes(b"{}")
    with pytest.raises(ValueError, match="seven files"):
        reader.read_inspection(tmp_path / "v2", stage)


def test_v2_missing_payload_wrong_stage_units_and_modified_J_fail(tmp_path):
    for name in ("missing", "modified", "stage_units"):
        stage, revision = synthetic_export(tmp_path / name, generation=2,
            record_change=(lambda record: record["outputs"][0]["payload_units"].pop("J_charge"))
                          if name == "stage_units" else None)
        payload = revision / "current_display.v1.bin"
        if name == "missing": payload.unlink()
        elif name == "modified": payload.write_bytes(b"X" + payload.read_bytes()[1:])
        with pytest.raises(ValueError):
            reader.read_inspection(tmp_path / name, stage)
