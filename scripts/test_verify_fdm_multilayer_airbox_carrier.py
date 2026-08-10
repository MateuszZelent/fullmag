from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from scripts.verify_fdm_multilayer_airbox_carrier import (
    AirboxCarrierError,
    verify_airbox_carrier,
)


def _write_carrier(root: Path, *, tamper_hash: bool = False) -> Path:
    field = {
        "schema_version": "fdm_multilayer_observation_field.v1",
        "observable": "H_demag",
        "quantity_id": "H_demag",
        "unit": "A/m",
        "scope_kind": "airbox",
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


def test_runtime_origin_airbox_carrier_is_fail_closed_and_hash_bound(tmp_path: Path) -> None:
    carrier = _write_carrier(tmp_path)
    payload = verify_airbox_carrier(carrier)
    assert payload["field_artifact_sha256"] == hashlib.sha256(
        (carrier / "H_demag.samples.v1.json").read_bytes()
    ).hexdigest()


def test_airbox_carrier_rejects_manifest_field_hash_mismatch(tmp_path: Path) -> None:
    carrier = _write_carrier(tmp_path, tamper_hash=True)
    with pytest.raises(AirboxCarrierError, match="field_artifact_hash_mismatch"):
        verify_airbox_carrier(carrier)
