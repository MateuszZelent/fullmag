"""RED tests for the SP4-derived CPU runtime qualification gate."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.runtime_verify import (
    RuntimeArtifactError,
    verify_runtime_artifacts,
)
from tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.measure_runtime import (
    measure_runtime,
)
from tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.scenario import (
    AIRBOX_RUNTIME,
    SCENARIO_PATH,
    STUDY_METADATA,
)
from fullmag.runtime.loader import load_problem_from_script


SCENARIO_L3_IDENTITY_3D_PATH = Path(__file__).with_name(
    "scenario_l3_identity_3d_small.py"
)


def test_l3_identity_three_d_scenario_preserves_common_identity_grid() -> None:
    assert SCENARIO_L3_IDENTITY_3D_PATH.is_file()

    loaded = load_problem_from_script(SCENARIO_L3_IDENTITY_3D_PATH, lightweight_assets=True)
    ir = loaded.problem.to_ir()
    fdm = ir["backend_policy"]["discretization_hints"]["fdm"]

    assert fdm["demag"] == {
        "strategy": "multilayer_convolution",
        "mode": "three_d",
        "common_cells": [8, 4, 2],
    }
    assert fdm["per_magnet"] == {
        "layer_bottom": {"cell": [3.90625e-09, 3.90625e-09, 3e-09]},
        "layer_middle": {"cell": [3.90625e-09, 3.90625e-09, 3e-09]},
        "layer_top": {"cell": [3.90625e-09, 3.90625e-09, 3e-09]},
    }


def test_sp4_derived_scenario_declares_multilayer_and_changed_airbox_mesh() -> None:
    loaded = load_problem_from_script(SCENARIO_PATH, lightweight_assets=True)
    ir = loaded.problem.to_ir()
    assert ir["backend_policy"]["discretization_hints"]["fdm"]["demag"] == {
        "strategy": "multilayer_convolution",
        "mode": "two_d_stack",
        "common_cells_xy": [160, 40],
    }
    assert STUDY_METADATA["qualification_scope"] == (
        "SP4-derived, not canonical SP4 qualification"
    )
    assert AIRBOX_RUNTIME["padding_cells_above_below"] == (5, 9)
    assert AIRBOX_RUNTIME["target_only"] is True
    assert AIRBOX_RUNTIME["origin_m"] == (-250e-9, -62.5e-9, -28.5e-9)


def test_sp4_derived_scenario_exports_scene_document_outside_repo_import_path(
    tmp_path: Path,
) -> None:
    package_source = Path(__file__).resolve().parents[6] / "packages" / "fullmag-py" / "src"
    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "fullmag.runtime.helper",
            "export-scene-document",
            "--script",
            str(SCENARIO_PATH),
        ],
        cwd=tmp_path,
        env={**os.environ, "PYTHONPATH": str(package_source)},
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    scene = json.loads(completed.stdout)
    assert {item["id"] for item in scene["objects"]} == {"layer_bottom", "layer_top"}
    assert scene["study"]["fdm"]["demag"]["strategy"] == "multilayer_convolution"


def test_runtime_verifier_fails_closed_when_cpu_artifacts_are_absent(tmp_path: Path) -> None:
    with pytest.raises(RuntimeArtifactError, match="runtime_artifacts_missing"):
        verify_runtime_artifacts(tmp_path / "missing")


def test_runtime_verifier_records_field_energy_and_coupling_outputs(tmp_path: Path) -> None:
    payload = {
        "schema_version": "sp4_fdm_multilayer_runtime.v1",
        "qualification_scope": "SP4-derived, not canonical SP4 qualification",
        "backend": "fdm",
        "device": "cpu",
        "precision": "double",
        "strategy": "multilayer_convolution",
        "mode": "two_d_stack",
        "airbox": dict(AIRBOX_RUNTIME),
        "outputs": {
            "field_a_from_b_apm": [1.0, 2.0, 3.0],
            "energy_demag_j": 4.0,
            "coupling_a_from_b_j": 5.0,
        },
    }
    artifact = tmp_path / "runtime.json"
    artifact.write_text(json.dumps(payload), encoding="utf-8")

    record = verify_runtime_artifacts(artifact)

    assert record["outputs"] == payload["outputs"]
    assert record["backend"] == "fdm"
    assert record["device"] == "cpu"


def test_measure_runtime_uses_three_real_snapshot_sets(tmp_path: Path) -> None:
    def write_run(root: Path, bottom: list[float], top: list[float]) -> None:
        field_root = root / "fields" / "H_demag"
        (field_root / "layer-layer_bottom").mkdir(parents=True)
        (field_root / "layer-layer_top").mkdir(parents=True)
        manifest = {
            "layers": [
                {"id": "layer_bottom", "directory": "layer-layer_bottom"},
                {"id": "layer_top", "directory": "layer-layer_top"},
            ]
        }
        (field_root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        for layer, values in (("bottom", bottom), ("top", top)):
            payload = {
                "observable": "H_demag",
                "unit": "A/m",
                "step": 0,
                "values": [values],
            }
            (field_root / f"layer-layer_{layer}" / "step_000000.json").write_text(
                json.dumps(payload), encoding="utf-8"
            )
        (root / "m_initial.json").write_text(
            json.dumps({"observable": "m", "values": [[1.0, 0.0, 0.0], [1.0, 0.0, 0.0]]}),
            encoding="utf-8",
        )
        (root / "metadata.json").write_text(
            json.dumps({"artifact_layout": {"backend": "fdm_multilayer"}}),
            encoding="utf-8",
        )

    ab = tmp_path / "ab"
    a_only = tmp_path / "a-only"
    b_only = tmp_path / "b-only"
    write_run(ab, [3.0, 0.0, 0.0], [4.0, 0.0, 0.0])
    write_run(a_only, [1.0, 0.0, 0.0], [2.0, 0.0, 0.0])
    write_run(b_only, [2.0, 0.0, 0.0], [2.0, 0.0, 0.0])

    payload = measure_runtime(ab, a_only, b_only, tmp_path / "runtime.json")

    assert payload["outputs"]["field_a_from_b_apm"] == [2.0, 0.0, 0.0]
    assert payload["outputs"]["coupling_a_from_b_j"] == payload["outputs"]["coupling_b_from_a_j"]
    assert verify_runtime_artifacts(tmp_path / "runtime.json")["mode"] == "two_d_stack"
