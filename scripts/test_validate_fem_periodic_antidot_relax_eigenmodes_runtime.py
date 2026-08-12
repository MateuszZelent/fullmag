from __future__ import annotations

import json
import hashlib
import re
import struct
import subprocess
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
JUSTFILE = REPO_ROOT / "justfile"
VALIDATOR = REPO_ROOT / "scripts/validate_fem_periodic_antidot_relax_eigenmodes_runtime.py"


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def recipe_source(name: str) -> str:
    source = JUSTFILE.read_text(encoding="utf-8")
    match = re.search(rf"^{re.escape(name)}(?:\s[^\n:]*)?:", source, re.MULTILINE)
    assert match is not None, f"missing just recipe {name}"
    following = source.find("\n\n", match.end())
    return source[match.start() :] if following == -1 else source[match.start() : following]


def runtime_metadata(device: str) -> dict[str, object]:
    return {
        "periodic_antidot_eigensolve": {
            "scenario": "relax_then_eigenmodes_k0",
            "exchange_coupled_across_periods": True,
            "magnetostatic_pbc": "periodic_airbox_k0",
            "periodic_pair_ids": ["x_faces", "y_faces"],
            "open_axis": "z",
            "film_size_m": [200e-9, 200e-9, 10e-9],
            "universe_size_m": [200e-9, 200e-9, 400e-9],
            "hole_radius_m": 25e-9,
            "bias_field_t": [10e-3, 0.0, 0.0],
            "requested_modal_device": device,
            "frequency_window_hz": [0.5e9, 30.0e9],
            "mode_count": 8,
            "saved_mode_indices": [0, 1, 2, 3],
        }
    }


def requested_execution(device: str) -> dict[str, object]:
    return {
        "backend": "fem",
        "device": device,
        "precision": "double",
        "mode": "strict",
        "fallback_policy": "forbidden",
    }


def mesh_metadata() -> dict[str, object]:
    return {
        "mesh_name": "periodic-antidot",
        "mesh_generation_id": "mesh-generation-1",
        "topology_fingerprint": "sha256:" + "1" * 64,
        "node_count": 2,
        "element_count": 27384,
    }


def write_runtime_fixture(root: Path, device: str) -> Path:
    report_root = root / device
    session_root = report_root / "workspace-history/session-123"
    relax_root = session_root / "stages/stage_00_flat_relax"
    artifacts = report_root / "artifacts"
    final_values = [[1.0, 0.0, 0.0], [0.98, 0.2, 0.0]]
    handoff_sha256 = "sha256:" + "a" * 64
    equilibrium_sha256 = "sha256:" + "b" * 64

    relax_metadata = {
        "status": "completed",
        "problem_meta": {
            "entrypoint_kind": "flat_relax",
            "runtime_metadata": runtime_metadata(device),
        },
        "requested_execution": requested_execution("cpu"),
        "mesh": mesh_metadata(),
        "pbc": {
            "axes": ["periodic", "periodic", "open"],
            "demag": "periodic_airbox_k0",
        },
        "fem_cpu_relaxation_qualification": {
            "schema_version": "fem_cpu_relaxation_qualification.v1",
            "relaxation_algorithm": "nonlinear_cg",
            "executed_steps": 42,
            "stop_reason": "torque",
            "stop_metric_kind": "max_torque_apm",
            "stop_metric_value": 7.0e-4,
            "stop_threshold": 7.957747154594768e-4,
            "final_torque_apm": 7.0e-4,
        },
    }
    final_metadata = {
        "status": "completed",
        "problem_meta": {
            "entrypoint_kind": "flat_eigenmodes",
            "runtime_metadata": runtime_metadata(device),
        },
        "requested_execution": requested_execution(device),
        "mesh": mesh_metadata(),
        "pbc": {
            "axes": ["periodic", "periodic", "open"],
            "demag": "periodic_airbox_k0",
        },
    }
    state = {
        "observable": "m",
        "unit": "dimensionless",
        "layout": {"backend": "fem"},
        "values": final_values,
    }

    write_json(relax_root / "metadata.json", relax_metadata)
    write_json(relax_root / "m_final.json", state)
    if device == "gpu":
        write_json(
            session_root / "stages/stage_01_flat_change_device/synthetic_stage.json",
            {"kind": "change_device", "device": "gpu", "vector_count": 2},
        )
    write_json(artifacts / "metadata.json", final_metadata)
    write_json(artifacts / "m_initial.json", state)
    write_json(
        artifacts / "eigen/metadata/eigen_summary.json",
        {
            "equilibrium_source": {
                "kind": "relaxed_initial_state",
                "handoff": "stage_continuation",
                "content_sha256": handoff_sha256,
                "equilibrium_content_sha256": equilibrium_sha256,
            },
            "relaxation_steps": 0,
            "mode_count": 8,
            "operator": {"kind": "full2x2", "include_demag": True},
            "k_sampling": [0.0, 0.0, 0.0],
            "solver_diagnostics": {
                "relax_to_eigen_handoff_sha256": handoff_sha256,
                "relax_to_eigen_handoff": {
                    "schema_version": "AcceptedFemRelaxStageHandoff.v1",
                    "source_run_id": "run-session-123",
                    "source_stage_id": "stage-000",
                    "source_stage_kind": "flat_relax",
                    "equilibrium_content_sha256": equilibrium_sha256,
                    "content_sha256": handoff_sha256,
                },
            },
        },
    )
    write_json(
        artifacts / "eigen/metadata/equilibrium_artifact.v6.json",
        {"accepted_for_linearization": True},
    )
    write_json(
        artifacts / "eigen/metadata/linearization_state.v6.json",
        {"accepted_for_frequency_operator": True},
    )
    source_mesh_identity = {
        "mesh_id": "periodic-antidot",
        "topology_fingerprint": "sha256:" + "1" * 64,
        "indexing": "full_domain_node_order",
        "node_count": 2,
    }
    spectrum_modes = []
    for mode_index in range(8):
        mode_path = f"eigen/modes/sample_0000/mode_{mode_index:04}.json"
        mode_field_path = (
            f"eigen/mode_fields.zarr/sample_0000/mode_{mode_index:04}/"
            "vector_xyz_complex/0.0.0"
        )
        zarr_array_path = mode_field_path.rsplit("/", 1)[0]
        payload_values = [
            1.0 + mode_index,
            0.0,
            0.0,
            1.0,
            0.5,
            -0.5,
            0.25,
            0.75,
            -0.25,
            0.5,
            1.25,
            -1.0,
        ]
        payload = struct.pack("<12d", *payload_values)
        payload_sha256 = "sha256:" + hashlib.sha256(payload).hexdigest()
        spectrum_modes.append(
            {
                "mode_id": f"sample-0000/mode-{mode_index:04}",
                "raw_mode_index": mode_index,
                "frequency_hz": 1.0e9 + mode_index * 1.0e8,
                "residual_relative_l2": 1.0e-9,
                "mode_artifact_path": mode_path,
                "zarr_chunk_path": mode_field_path,
                "status": "complete",
            }
        )
        write_json(
            artifacts / mode_path,
            {
                "schema_version": "2",
                "value_kind": "complex_spatial_vector",
                "component_basis": "global_xyz",
                "component_count": 3,
                "source_mesh_identity": source_mesh_identity,
                "storage_format": "zarr",
                "zarr_array_path": zarr_array_path,
                "zarr_chunk_path": mode_field_path,
                "zarr_dtype": "<f8",
                "zarr_shape": [2, 3, 2],
                "zarr_chunk_shape": [2, 3, 2],
                "zarr_compressor": None,
                "payload_sha256": payload_sha256,
            },
        )
        chunk_path = artifacts / mode_field_path
        chunk_path.parent.mkdir(parents=True, exist_ok=True)
        write_json(
            chunk_path.parent / ".zarray",
            {
                "zarr_format": 2,
                "shape": [2, 3, 2],
                "chunks": [2, 3, 2],
                "dtype": "<f8",
                "compressor": None,
                "fill_value": 0.0,
                "order": "C",
                "filters": None,
                "dimension_separator": ".",
            },
        )
        chunk_path.write_bytes(payload)
    write_json(
        artifacts / "eigen/spectrum.v2.json",
        {
            "schema_version": "eigen_spectrum.v2",
            "complete": True,
            "sample_count": 1,
            "samples": [{"sample_index": 0, "status": "complete", "modes": spectrum_modes}],
        },
    )
    write_json(
        artifacts / "eigen/diagnostics/solver.v1.json",
        {"schema_version": "eigen_solver_diagnostics.v1", "eps_phi": 1.0e-10},
    )
    (report_root / "runtime.log").write_text("managed runtime completed\n", encoding="utf-8")
    return report_root


def run_validator(report_root: Path, device: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(VALIDATOR), str(report_root), "--device", device],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def test_managed_recipe_is_fail_closed_for_cpu_and_gpu() -> None:
    recipe = recipe_source("verify-fem-periodic-antidot-relax-eigenmodes-runtime")

    assert 'device="cpu"' in recipe.splitlines()[0]
    assert "just ensure-managed-fem-runtime" in recipe
    assert 'case "$mode" in cpu|gpu)' in recipe
    assert "fem-modal-cpu" in recipe
    assert "fem-gpu" in recipe
    assert "FULLMAG_FEM_EXECUTION=cpu" in recipe
    assert "FULLMAG_RELAX_DEVICE=cpu" in recipe
    assert 'FULLMAG_PERIODIC_ANTIDOT_EIGEN_DEVICE="$mode"' in recipe
    assert "/usr/bin/time" not in recipe
    assert "TIMEFORMAT=" in recipe
    assert '2> "$root/time.txt"' in recipe
    assert '--workspace-root "$root/workspace-history"' in recipe
    assert '--output-dir "$root/artifacts"' in recipe
    assert "--require-k0-periodic-airbox-production" in recipe
    assert "--require-gpu-modal-k0-periodic-airbox-production" in recipe
    assert "validate_fem_periodic_antidot_relax_eigenmodes_runtime.py" in recipe


@pytest.mark.parametrize("device", ["cpu", "gpu"])
def test_validator_accepts_complete_relax_to_eigen_handoff(
    tmp_path: Path, device: str
) -> None:
    report_root = write_runtime_fixture(tmp_path, device)

    result = run_validator(report_root, device)

    assert result.returncode == 0, result.stderr
    summary = json.loads(result.stdout)
    assert summary["status"] == "ok"
    assert summary["device"] == device
    assert summary["stage_count"] == (2 if device == "cpu" else 3)
    assert summary["mesh_generation_id"] == "mesh-generation-1"


def test_validator_rejects_mesh_identity_drift(tmp_path: Path) -> None:
    report_root = write_runtime_fixture(tmp_path, "cpu")
    final_metadata_path = report_root / "artifacts/metadata.json"
    metadata = json.loads(final_metadata_path.read_text(encoding="utf-8"))
    metadata["mesh"]["mesh_generation_id"] = "mesh-generation-2"
    write_json(final_metadata_path, metadata)

    result = run_validator(report_root, "cpu")

    assert result.returncode != 0
    assert "mesh_generation_id" in result.stderr


def test_validator_rejects_unproven_stage_handoff(tmp_path: Path) -> None:
    report_root = write_runtime_fixture(tmp_path, "gpu")
    summary_path = report_root / "artifacts/eigen/metadata/eigen_summary.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    summary["equilibrium_source"] = "provided"
    write_json(summary_path, summary)

    result = run_validator(report_root, "gpu")

    assert result.returncode != 0
    assert "stage_continuation" in result.stderr


@pytest.mark.parametrize(
    "mutation",
    ["source_content", "source_equilibrium", "diagnostic_content"],
)
def test_validator_rejects_relax_handoff_digest_drift(
    tmp_path: Path, mutation: str
) -> None:
    report_root = write_runtime_fixture(tmp_path, "cpu")
    summary_path = report_root / "artifacts/eigen/metadata/eigen_summary.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    drift = "sha256:" + "f" * 64
    if mutation == "source_content":
        summary["equilibrium_source"]["content_sha256"] = drift
    elif mutation == "source_equilibrium":
        summary["equilibrium_source"]["equilibrium_content_sha256"] = drift
    else:
        summary["solver_diagnostics"]["relax_to_eigen_handoff"][
            "content_sha256"
        ] = drift
    write_json(summary_path, summary)

    result = run_validator(report_root, "cpu")

    assert result.returncode != 0
    assert "handoff" in result.stderr and "sha256" in result.stderr


def test_validator_rejects_scenario_and_stage_drift(tmp_path: Path) -> None:
    report_root = write_runtime_fixture(tmp_path, "cpu")
    relax_metadata_path = (
        report_root
        / "workspace-history/session-123/stages/stage_00_flat_relax/metadata.json"
    )
    metadata = json.loads(relax_metadata_path.read_text(encoding="utf-8"))
    metadata["problem_meta"]["runtime_metadata"]["periodic_antidot_eigensolve"][
        "mode_count"
    ] = 4
    write_json(relax_metadata_path, metadata)
    write_json(
        report_root
        / "workspace-history/session-123/stages/stage_01_unexpected/synthetic_stage.json",
        {"kind": "unexpected"},
    )

    result = run_validator(report_root, "cpu")

    assert result.returncode != 0
    assert "stage directories" in result.stderr or "mode_count" in result.stderr


def test_validator_rejects_missing_real_spectrum(tmp_path: Path) -> None:
    report_root = write_runtime_fixture(tmp_path, "cpu")
    (report_root / "artifacts/eigen/spectrum.v2.json").unlink()

    result = run_validator(report_root, "cpu")

    assert result.returncode != 0
    assert "spectrum.v2" in result.stderr


def test_validator_rejects_missing_complex_mode_chunk(tmp_path: Path) -> None:
    report_root = write_runtime_fixture(tmp_path, "cpu")
    chunk = (
        report_root
        / "artifacts/eigen/mode_fields.zarr/sample_0000/mode_0000/vector_xyz_complex/0.0.0"
    )
    chunk.unlink()

    result = run_validator(report_root, "cpu")

    assert result.returncode != 0
    assert "complex" in result.stderr or "mode field" in result.stderr


def test_validator_rejects_zarr_v2_dtype_shape_and_exact_size_drift(tmp_path: Path) -> None:
    report_root = write_runtime_fixture(tmp_path, "cpu")
    array_metadata_path = (
        report_root
        / "artifacts/eigen/mode_fields.zarr/sample_0000/mode_0000/vector_xyz_complex/.zarray"
    )
    metadata = json.loads(array_metadata_path.read_text(encoding="utf-8"))
    metadata["dtype"] = "<f4"
    write_json(array_metadata_path, metadata)

    result = run_validator(report_root, "cpu")

    assert result.returncode != 0
    assert "dtype" in result.stderr

    report_root = write_runtime_fixture(tmp_path / "size", "cpu")
    chunk = (
        report_root
        / "artifacts/eigen/mode_fields.zarr/sample_0000/mode_0000/vector_xyz_complex/0.0.0"
    )
    chunk.write_bytes(chunk.read_bytes()[:-8])

    result = run_validator(report_root, "cpu")

    assert result.returncode != 0
    assert "size" in result.stderr


def test_validator_rejects_non_finite_or_hash_mismatched_zarr_payload(tmp_path: Path) -> None:
    report_root = write_runtime_fixture(tmp_path, "cpu")
    chunk = (
        report_root
        / "artifacts/eigen/mode_fields.zarr/sample_0000/mode_0000/vector_xyz_complex/0.0.0"
    )
    payload = bytearray(chunk.read_bytes())
    payload[:8] = struct.pack("<d", float("nan"))
    chunk.write_bytes(payload)

    result = run_validator(report_root, "cpu")

    assert result.returncode != 0
    assert "finite" in result.stderr

    report_root = write_runtime_fixture(tmp_path / "hash", "cpu")
    mode_path = report_root / "artifacts/eigen/modes/sample_0000/mode_0000.json"
    mode = json.loads(mode_path.read_text(encoding="utf-8"))
    mode["payload_sha256"] = "sha256:" + "f" * 64
    write_json(mode_path, mode)

    result = run_validator(report_root, "cpu")

    assert result.returncode != 0
    assert "payload_sha256" in result.stderr


def test_validator_rejects_mode_source_mesh_identity_drift(tmp_path: Path) -> None:
    report_root = write_runtime_fixture(tmp_path, "cpu")
    mode_path = report_root / "artifacts/eigen/modes/sample_0000/mode_0000.json"
    mode = json.loads(mode_path.read_text(encoding="utf-8"))
    mode["source_mesh_identity"]["topology_fingerprint"] = "sha256:" + "2" * 64
    write_json(mode_path, mode)

    result = run_validator(report_root, "cpu")

    assert result.returncode != 0
    assert "source_mesh_identity" in result.stderr


@pytest.mark.parametrize("field,drift", [("mesh_id", "mesh:other"), ("indexing", "local")])
def test_validator_rejects_actual_producer_mesh_identity_drift(
    tmp_path: Path, field: str, drift: str
) -> None:
    report_root = write_runtime_fixture(tmp_path, "cpu")
    mode_path = report_root / "artifacts/eigen/modes/sample_0000/mode_0000.json"
    mode = json.loads(mode_path.read_text(encoding="utf-8"))
    mode["source_mesh_identity"][field] = drift
    write_json(mode_path, mode)

    result = run_validator(report_root, "cpu")

    assert result.returncode != 0
    assert "source_mesh_identity" in result.stderr
