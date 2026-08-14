from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from scripts.verify_fdm_multilayer_airbox_carrier import (
    AirboxCarrierError,
    verify_airbox_carrier,
)


BUILD_IDENTITY = {
    "built_at_utc": "2026-08-14T00:00:00Z",
    "git_commit": "d" * 40,
    "worktree_state": "dirty",
    "source_snapshot_sha256": "e" * 64,
}


def _write_runtime_report(path: Path, build_identity: dict[str, str]) -> Path:
    path.write_text(
        json.dumps({"build_identity": build_identity}, indent=2) + "\n",
        encoding="utf-8",
    )
    return path


def _write_carrier(
    root: Path,
    *,
    tamper_hash: bool = False,
    build_identity: dict[str, str] | None = None,
) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    field = {
        "schema_version": "fdm_multilayer_observation_field.v1",
        "observable": "H_demag",
        "quantity_id": "H_demag",
        "unit": "A/m",
        "scope_kind": "airbox",
        "build_identity": build_identity if build_identity is not None else BUILD_IDENTITY,
        "grid": {"cells": [2, 2, 2], "origin_m": [0.0, 0.0, 0.0], "cell_size_m": [1e-9] * 3},
        "values": [[1.0, 2.0, 3.0], [0.0, 0.0, 1.0]],
    }
    field_path = root / "H_demag.samples.v1.json"
    field_path.write_text(json.dumps(field, indent=2) + "\n", encoding="utf-8")
    digest = hashlib.sha256(field_path.read_bytes()).hexdigest()
    manifest = {
        "schema_version": "fdm_multilayer_observation.v1",
        "scope_kind": "airbox",
        "quantity_id": "H_demag",
        "unit": "A/m",
        "build_identity": build_identity if build_identity is not None else BUILD_IDENTITY,
        "source_policy": "target_only",
        "target_only": True,
        "grid": {"cells": [2, 2, 2], "origin_m": [0.0, 0.0, 0.0], "cell_size_m": [1e-9] * 3},
        "padding_cells_above_below": [1, 1],
        "carrier_fingerprint": "a" * 64,
        "source_grid_fingerprints": ["b" * 64],
        "source_common_grid": {"cells": [2, 2, 1]},
        "source_runtime_identity": {
            "execution_engine": "cpu_reference_multilayer",
            "precision": "double",
            "demag_operator_kind": "multilayer_tensor_fft_newell",
            "run_status": "completed",
            "build_identity": build_identity if build_identity is not None else BUILD_IDENTITY,
        },
        "field_artifact": field_path.name,
        "field_artifact_sha256": ("c" * 64 if tamper_hash else digest),
        "sample_count": len(field["values"]),
        "published_quantities": ["H_demag"],
        "unavailable_quantities": {
            "H_eff": "fdm_multilayer_airbox_h_eff_unavailable.v1"
        },
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return root


def _rewrite_field(carrier: Path, field: dict[str, object]) -> None:
    field_path = carrier / "H_demag.samples.v1.json"
    field_path.write_text(json.dumps(field, indent=2) + "\n", encoding="utf-8")
    manifest_path = carrier / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["field_artifact_sha256"] = hashlib.sha256(field_path.read_bytes()).hexdigest()
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def test_runtime_origin_airbox_carrier_is_fail_closed_and_hash_bound(tmp_path: Path) -> None:
    carrier = _write_carrier(tmp_path)
    payload = verify_airbox_carrier(carrier)
    assert payload["field_artifact_sha256"] == hashlib.sha256(
        (carrier / "H_demag.samples.v1.json").read_bytes()
    ).hexdigest()
    assert payload["source_runtime_identity"]["build_identity"] == BUILD_IDENTITY


def test_airbox_carrier_rejects_manifest_field_hash_mismatch(tmp_path: Path) -> None:
    carrier = _write_carrier(tmp_path, tamper_hash=True)
    with pytest.raises(AirboxCarrierError, match="field_artifact_hash_mismatch"):
        verify_airbox_carrier(carrier)


def test_airbox_carrier_rejects_missing_source_runtime_build_identity(tmp_path: Path) -> None:
    carrier = _write_carrier(tmp_path)
    manifest_path = carrier / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    del manifest["source_runtime_identity"]["build_identity"]
    manifest_path.write_text(json.dumps(manifest) + "\n", encoding="utf-8")
    with pytest.raises(AirboxCarrierError, match="build_identity_missing"):
        verify_airbox_carrier(carrier)


def test_airbox_carrier_rejects_missing_manifest_build_identity(tmp_path: Path) -> None:
    carrier = _write_carrier(tmp_path)
    manifest_path = carrier / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    del manifest["build_identity"]
    manifest_path.write_text(json.dumps(manifest) + "\n", encoding="utf-8")

    with pytest.raises(
        AirboxCarrierError,
        match="airbox_carrier_build_identity_missing:manifest",
    ):
        verify_airbox_carrier(carrier)


def test_airbox_carrier_rejects_mismatched_manifest_build_identity(tmp_path: Path) -> None:
    carrier = _write_carrier(tmp_path)
    manifest_path = carrier / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["build_identity"]["source_snapshot_sha256"] = "f" * 64
    manifest_path.write_text(json.dumps(manifest) + "\n", encoding="utf-8")

    with pytest.raises(
        AirboxCarrierError,
        match="airbox_carrier_build_identity_mismatch:manifest",
    ):
        verify_airbox_carrier(carrier)


def test_airbox_carrier_rejects_missing_field_build_identity(tmp_path: Path) -> None:
    carrier = _write_carrier(tmp_path)
    field_path = carrier / "H_demag.samples.v1.json"
    field = json.loads(field_path.read_text(encoding="utf-8"))
    del field["build_identity"]
    _rewrite_field(carrier, field)

    with pytest.raises(
        AirboxCarrierError,
        match="airbox_carrier_build_identity_missing:field",
    ):
        verify_airbox_carrier(carrier)


def test_airbox_carrier_rejects_mismatched_field_build_identity(tmp_path: Path) -> None:
    carrier = _write_carrier(tmp_path)
    field_path = carrier / "H_demag.samples.v1.json"
    field = json.loads(field_path.read_text(encoding="utf-8"))
    field["build_identity"]["source_snapshot_sha256"] = "f" * 64
    _rewrite_field(carrier, field)

    with pytest.raises(
        AirboxCarrierError,
        match="airbox_carrier_build_identity_mismatch:field",
    ):
        verify_airbox_carrier(carrier)


def test_airbox_carrier_binds_equal_runtime_report_build_identity(tmp_path: Path) -> None:
    carrier = _write_carrier(tmp_path / "carrier")
    runtime = _write_runtime_report(tmp_path / "runtime.json", BUILD_IDENTITY)

    payload = verify_airbox_carrier(carrier, runtime_json=runtime)
    assert payload["build_identity"] == BUILD_IDENTITY
    assert payload["report_build_identity_validation_status"] == "passed"


def test_airbox_carrier_rejects_mismatched_runtime_report_build_identity(
    tmp_path: Path,
) -> None:
    carrier = _write_carrier(tmp_path / "carrier")
    mismatched = dict(BUILD_IDENTITY)
    mismatched["source_snapshot_sha256"] = "f" * 64
    runtime = _write_runtime_report(tmp_path / "runtime.json", mismatched)

    with pytest.raises(
        AirboxCarrierError,
        match="airbox_report_carrier_build_identity_mismatch",
    ):
        verify_airbox_carrier(carrier, runtime_json=runtime)
