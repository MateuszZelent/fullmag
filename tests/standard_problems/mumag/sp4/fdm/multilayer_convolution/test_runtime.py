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
    RuntimeMeasurementError,
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


def _build_identity(snapshot: str = "a" * 64) -> dict[str, str]:
    return {
        "built_at_utc": "2026-08-14T00:00:00Z",
        "git_commit": "b" * 40,
        "worktree_state": "dirty",
        "source_snapshot_sha256": snapshot,
    }


def _measurement_identity(snapshot: str = "a" * 64) -> dict[str, object]:
    identity = _build_identity(snapshot)
    return {
        "build_identity": identity,
        "source_artifact_build_identities": {
            "ab": identity,
            "a_only": identity,
            "b_only": identity,
        },
    }


def _source_snapshot(snapshot: str = "a" * 64) -> dict[str, object]:
    return {
        "schema": "fullmag.source-snapshot.v2",
        "head_commit_full": "b" * 40,
        "source_snapshot_dirty": True,
        "source_snapshot_sha256": snapshot,
    }


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
        **_measurement_identity(),
        "outputs": {
            "field_a_from_b_apm": [1.0, 2.0, 3.0],
            "energy_demag_j": 4.0,
            "coupling_a_from_b_j": 5.0,
        },
        "artifact_verification_status": "verified",
    }
    artifact = tmp_path / "runtime.json"
    artifact.write_text(json.dumps(payload), encoding="utf-8")

    record = verify_runtime_artifacts(artifact)

    assert record["outputs"] == payload["outputs"]
    assert record["backend"] == "fdm"
    assert record["device"] == "cpu"
    assert record["structural_validation_status"] == "passed"
    assert "artifact_verification_status" not in record
    assert record["qualification_status"] == "not_qualified"
    assert record["qualification_reason_codes"] == [
        "cpu_fp64_thresholds_not_evaluated",
        "cpu_fp64_direct_oracle_not_evaluated",
        "cpu_fp64_reciprocity_not_evaluated",
        "cpu_fp64_control_equilibrium_not_evaluated",
        "cpu_fp64_source_identity_not_bound",
    ]


def test_runtime_verifier_cli_fails_closed_without_scientific_qualification(
    tmp_path: Path,
) -> None:
    payload = {
        "schema_version": "sp4_fdm_multilayer_runtime.v1",
        "qualification_scope": "SP4-derived, not canonical SP4 qualification",
        "backend": "fdm",
        "device": "cpu",
        "precision": "double",
        "strategy": "multilayer_convolution",
        "mode": "two_d_stack",
        "airbox": dict(AIRBOX_RUNTIME),
        **_measurement_identity(),
        "outputs": {
            "field_a_from_b_apm": [1.0, 2.0, 3.0],
            "energy_demag_j": 4.0,
            "coupling_a_from_b_j": 5.0,
        },
    }
    artifact = tmp_path / "runtime.json"
    artifact.write_text(json.dumps(payload), encoding="utf-8")

    completed = subprocess.run(
        [
            sys.executable,
            "-m",
            "tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.runtime_verify",
            str(artifact),
        ],
        cwd=Path(__file__).resolve().parents[6],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 3
    record = json.loads(completed.stdout)
    assert record["structural_validation_status"] == "passed"
    assert "artifact_verification_status" not in record
    assert record["qualification_status"] == "not_qualified"

    artifact_only = subprocess.run(
        [
            sys.executable,
            "-m",
            "tests.standard_problems.mumag.sp4.fdm.multilayer_convolution.runtime_verify",
            str(artifact),
            "--artifact-only",
        ],
        cwd=Path(__file__).resolve().parents[6],
        check=False,
        capture_output=True,
        text=True,
    )

    assert artifact_only.returncode == 0
    assert json.loads(artifact_only.stdout)["qualification_status"] == "not_qualified"


def test_runtime_verifier_binds_measurement_to_exact_source_snapshot(tmp_path: Path) -> None:
    payload = {
        "schema_version": "sp4_fdm_multilayer_runtime.v1",
        "qualification_scope": "SP4-derived, not canonical SP4 qualification",
        "backend": "fdm",
        "device": "cpu",
        "precision": "double",
        "strategy": "multilayer_convolution",
        "mode": "two_d_stack",
        "airbox": dict(AIRBOX_RUNTIME),
        **_measurement_identity(),
        "outputs": {
            "field_a_from_b_apm": [1.0, 2.0, 3.0],
            "energy_demag_j": 4.0,
            "coupling_a_from_b_j": 5.0,
        },
    }
    artifact = tmp_path / "runtime.json"
    source_snapshot = tmp_path / "source-snapshot.v1.json"
    artifact.write_text(json.dumps(payload), encoding="utf-8")
    source_snapshot.write_text(json.dumps(_source_snapshot()), encoding="utf-8")

    record = verify_runtime_artifacts(artifact, source_snapshot=source_snapshot)

    assert record["source_identity_validation_status"] == "passed"
    assert record["build_identity"] == _build_identity()
    assert "cpu_fp64_source_identity_not_bound" not in record["qualification_reason_codes"]


def test_runtime_verifier_rejects_missing_measurement_build_identity(tmp_path: Path) -> None:
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

    with pytest.raises(RuntimeArtifactError, match="runtime_build_identity_missing"):
        verify_runtime_artifacts(artifact)


def test_runtime_verifier_rejects_mismatched_source_snapshot(tmp_path: Path) -> None:
    payload = {
        "schema_version": "sp4_fdm_multilayer_runtime.v1",
        "qualification_scope": "SP4-derived, not canonical SP4 qualification",
        "backend": "fdm",
        "device": "cpu",
        "precision": "double",
        "strategy": "multilayer_convolution",
        "mode": "two_d_stack",
        "airbox": dict(AIRBOX_RUNTIME),
        **_measurement_identity(),
        "outputs": {
            "field_a_from_b_apm": [1.0, 2.0, 3.0],
            "energy_demag_j": 4.0,
            "coupling_a_from_b_j": 5.0,
        },
    }
    artifact = tmp_path / "runtime.json"
    source_snapshot = tmp_path / "source-snapshot.v1.json"
    artifact.write_text(json.dumps(payload), encoding="utf-8")
    source_snapshot.write_text(json.dumps(_source_snapshot("c" * 64)), encoding="utf-8")

    with pytest.raises(RuntimeArtifactError, match="runtime_source_identity_mismatch"):
        verify_runtime_artifacts(artifact, source_snapshot=source_snapshot)


def test_managed_cpu_recipe_propagates_scientific_not_qualified_status() -> None:
    completed = subprocess.run(
        ["just", "--dry-run", "verify-fdm-multilayer-demag-runtime", "cpu-fp64"],
        cwd=Path(__file__).resolve().parents[6],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    rendered = completed.stdout + completed.stderr
    assert "cpu_fp64_scientific_qualification_not_evaluated" in rendered
    assert '"status":"verified"' not in rendered
    assert '\\"status\\":\\"qualified\\"' not in rendered
    assert "cpu_fp64_runtime_identity_not_bound" not in rendered
    capture = rendered.index("capture_source_snapshot_identity.py")
    build = rendered.index("just build target=fullmag cpu_only=1")
    assert capture < build
    assert "FULLMAG_SOURCE_GIT_COMMIT=" in rendered
    assert "FULLMAG_SOURCE_WORKTREE_STATE=" in rendered
    assert "FULLMAG_SOURCE_SNAPSHOT_SHA256=" in rendered
    assert "cpu_runtime_build_failed" in rendered
    assert '--source-snapshot "$run_root/source-snapshot.v1.json"' in rendered
    assert '--compare "$run_root/source-snapshot.v1.json"' in rendered


def test_airbox_recipe_requests_artifact_only_verification() -> None:
    completed = subprocess.run(
        ["just", "--dry-run", "verify-fdm-multilayer-airbox-runtime", "cpu-fp64"],
        cwd=Path(__file__).resolve().parents[6],
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    rendered = completed.stdout + completed.stderr
    assert "runtime_verify \"$runtime_json\" --artifact-only" in rendered
    assert "--runtime-json \"$runtime_json\"" in rendered
    assert "airbox_report_carrier_build_identity_missing" in rendered
    assert "airbox_report_carrier_build_identity_mismatch" in rendered
    assert "airbox_report_carrier_identity_unlinked" not in rendered


def test_measure_runtime_uses_three_real_snapshot_sets(tmp_path: Path) -> None:
    def write_run(root: Path, bottom: list[float], top: list[float]) -> None:
        field_root = root / "fields" / "H_demag"
        (field_root / "layer-layer_bottom").mkdir(parents=True)
        (field_root / "layer-layer_top").mkdir(parents=True)
        manifest = {
            "build_identity": _build_identity(),
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
                "provenance": {"build_identity": _build_identity()},
                "values": [values],
            }
            (field_root / f"layer-layer_{layer}" / "step_000000.json").write_text(
                json.dumps(payload), encoding="utf-8"
            )
        (root / "m_initial.json").write_text(
            json.dumps(
                {
                    "observable": "m",
                    "provenance": {"build_identity": _build_identity()},
                    "values": [[1.0, 0.0, 0.0], [1.0, 0.0, 0.0]],
                }
            ),
            encoding="utf-8",
        )
        (root / "metadata.json").write_text(
            json.dumps(
                {
                    "artifact_layout": {"backend": "fdm_multilayer"},
                    "build_identity": _build_identity(),
                }
            ),
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
    assert payload["build_identity"] == _build_identity()
    assert payload["source_artifact_build_identities"] == {
        "ab": _build_identity(),
        "a_only": _build_identity(),
        "b_only": _build_identity(),
    }
    assert verify_runtime_artifacts(tmp_path / "runtime.json")["mode"] == "two_d_stack"


def test_measure_runtime_rejects_mismatched_artifact_build_identity(tmp_path: Path) -> None:
    def write_run(root: Path, identity: dict[str, str]) -> None:
        field_root = root / "fields" / "H_demag"
        for layer in ("layer_bottom", "layer_top"):
            directory = field_root / f"layer-{layer}"
            directory.mkdir(parents=True, exist_ok=True)
            (directory / "step_000000.json").write_text(
                json.dumps(
                    {
                        "observable": "H_demag",
                        "unit": "A/m",
                        "step": 0,
                        "provenance": {"build_identity": identity},
                        "values": [[1.0, 0.0, 0.0]],
                    }
                ),
                encoding="utf-8",
            )
        (field_root / "manifest.json").write_text(
            json.dumps(
                {
                    "build_identity": identity,
                    "layers": [
                        {"id": "layer_bottom", "directory": "layer-layer_bottom"},
                        {"id": "layer_top", "directory": "layer-layer_top"},
                    ]
                }
            ),
            encoding="utf-8",
        )
        (root / "m_initial.json").write_text(
            json.dumps(
                {
                    "observable": "m",
                    "provenance": {"build_identity": identity},
                    "values": [[1.0, 0.0, 0.0], [1.0, 0.0, 0.0]],
                }
            ),
            encoding="utf-8",
        )
        (root / "metadata.json").write_text(
            json.dumps(
                {
                    "artifact_layout": {"backend": "fdm_multilayer"},
                    "build_identity": identity,
                }
            ),
            encoding="utf-8",
        )

    ab = tmp_path / "ab"
    a_only = tmp_path / "a-only"
    b_only = tmp_path / "b-only"
    write_run(ab, _build_identity())
    write_run(a_only, _build_identity("c" * 64))
    write_run(b_only, _build_identity())

    with pytest.raises(RuntimeMeasurementError, match="runtime_build_identity_mismatch"):
        measure_runtime(ab, a_only, b_only, tmp_path / "runtime.json")
