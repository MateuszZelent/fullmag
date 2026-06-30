from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


SCRIPT = Path(__file__).with_name("verify_fem_frequency_domain_supercell_artifacts.py")


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def write_bundle(
    root: Path,
    *,
    amplitudes: list[float] | None = None,
    frequencies_hz: list[float] | None = None,
) -> None:
    if frequencies_hz is None:
        frequencies_hz = [2.5e9, 2.75e9, 3.0e9]
    if amplitudes is None:
        amplitudes = [0.5, 1.0, 0.75]
    assert len(frequencies_hz) == len(amplitudes)

    write_json(
        root / "response/progress.v1.json",
        {
            "schema_version": "frequency_domain_sweep_progress.v1",
            "status": "ok",
            "complete": True,
            "completed_frequency_points": len(frequencies_hz),
        },
    )
    write_json(
        root / "response/diagnostics/solver.v1.json",
        {
            "schema_version": "frequency_domain_response_diagnostics.v1",
            "status": "ok",
            "validation_fallback_used": False,
            "requested_magnetic_bc": "periodic",
            "resolved_magnetic_bc": "periodic",
            "requested_magnetostatic_bc": "periodic_airbox_k0",
            "resolved_magnetostatic_bc": "periodic_airbox_k0",
            "operator_terms_included": ["exchange", "zeeman", "demag"],
        },
    )
    write_json(
        root / "frequency_domain/manifest.v1.json",
        {
            "schema_version": "frequency_domain_manifest.v1",
            "status": "ready",
            "complete": True,
            "resolved_execution": {
                "requested_execution_lane": "production_cpu",
                "resolved_execution_lane": "production_cpu",
            },
            "physics": {
                "requested_magnetic_bc": "periodic",
                "resolved_magnetic_bc": "periodic",
                "requested_magnetostatic_bc": "periodic_airbox_k0",
                "resolved_magnetostatic_bc": "periodic_airbox_k0",
            },
        },
    )
    paths = []
    for index, (frequency_hz, amplitude) in enumerate(zip(frequencies_hz, amplitudes)):
        point_path = f"response/frequency_points/frequency_{index:04d}.json"
        paths.append(point_path)
        write_json(
            root / point_path,
            {
                "schema_version": "frequency_domain_response_frequency_point.v1",
                "frequency_hz": frequency_hz,
                "response_amplitude": amplitude,
                "component_response_amplitude": [amplitude, amplitude / 2.0],
                "demag_contribution": {"status": "solved"},
            },
        )
    write_json(
        root / "response/magnetic_response_sweep.v2.json",
        {
            "schema_version": "frequency_domain_magnetic_response_sweep.v2",
            "completed_frequency_point_count": len(paths),
            "frequency_point_artifact_paths": paths,
        },
    )


def run_validator(tmp_path: Path, *extra_args: str) -> subprocess.CompletedProcess[str]:
    unit = tmp_path / "unit"
    supercell = tmp_path / "supercell"
    command = [
        sys.executable,
        str(SCRIPT),
        "--unit-cell",
        str(unit),
        "--supercell",
        str(supercell),
        "--repeat-x",
        "2",
        "--repeat-y",
        "2",
        *extra_args,
    ]
    return subprocess.run(command, text=True, capture_output=True, check=False)


def test_supercell_validator_accepts_matching_gamma_like_response(tmp_path: Path) -> None:
    write_bundle(tmp_path / "unit")
    write_bundle(tmp_path / "supercell", amplitudes=[0.51, 1.02, 0.76])

    result = run_validator(tmp_path, "--response-rel-tol", "0.05")

    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["schema_version"] == "frequency_domain_supercell_validation.v1"
    assert report["cell_count"] == 4
    assert report["peak_index"] == 1


def test_supercell_validator_rejects_peak_shift(tmp_path: Path) -> None:
    write_bundle(tmp_path / "unit")
    write_bundle(tmp_path / "supercell", amplitudes=[0.5, 0.75, 1.0])

    result = run_validator(tmp_path, "--response-rel-tol", "1.0")

    assert result.returncode != 0
    assert "peak index mismatch" in result.stderr


def test_supercell_validator_rejects_response_amplitude_drift(tmp_path: Path) -> None:
    write_bundle(tmp_path / "unit")
    write_bundle(tmp_path / "supercell", amplitudes=[0.5, 1.6, 0.75])

    result = run_validator(tmp_path, "--response-rel-tol", "0.05")

    assert result.returncode != 0
    assert "response_amplitude mismatch" in result.stderr


def test_supercell_validator_writes_report(tmp_path: Path) -> None:
    write_bundle(tmp_path / "unit")
    write_bundle(tmp_path / "supercell")
    report_path = tmp_path / "reports" / "supercell.json"

    result = run_validator(tmp_path, "--write-report", str(report_path))

    assert result.returncode == 0, result.stderr
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["status"] == "ok"
    assert result.stdout == ""
