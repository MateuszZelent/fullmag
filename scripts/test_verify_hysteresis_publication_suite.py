#!/usr/bin/env python3
"""Unit tests for the hysteresis publication validation suite manifest."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "verify_hysteresis_publication_suite.py"


def load_script_module(path: Path):
    spec = importlib.util.spec_from_file_location(path.stem, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


macrospin_fixtures = load_script_module(
    REPO_ROOT / "scripts" / "test_verify_hysteresis_fdm_macrospin_sw_artifacts.py"
)
thinfilm_fixtures = load_script_module(
    REPO_ROOT / "scripts" / "test_verify_hysteresis_fdm_thinfilm_oop_ip_artifacts.py"
)
projection_fixtures = load_script_module(
    REPO_ROOT / "scripts" / "test_verify_hysteresis_projection_benchmark.py"
)


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload))


def run_validator(manifest: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(VALIDATOR), str(manifest)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def write_publication_suite_fixture(root: Path, *, omit_case: str | None = None) -> Path:
    macrospin = root / "macrospin_sw"
    thinfilm = root / "thinfilm_oop_ip"
    projection = root / "projection_benchmark"
    macrospin_fixtures.write_macrospin_fixture(
        macrospin,
        easy_orientation={"kind": "sample", "theta": 30.0, "phi": 0.0},
        theta_orientation={"kind": "sample", "theta": 45.0, "phi": 0.0},
    )
    thinfilm_fixtures.write_thinfilm_fixture(thinfilm)
    projection_fixtures.write_projection_fixture(projection)

    cases = {
        "macrospin_sw": {
            "artifact_dir": "macrospin_sw",
            "run_command": "just run-hysteresis-fdm-macrospin-sw-smoke",
            "validator": "verify_hysteresis_fdm_macrospin_sw_artifacts.py",
            "backend": "fdm",
            "device": "cpu",
            "precision": "double",
            "roles": ["macrospin_sw", "custom_angle"],
        },
        "thinfilm_oop_ip": {
            "artifact_dir": "thinfilm_oop_ip",
            "run_command": "just run-hysteresis-fdm-thinfilm-oop-ip-smoke",
            "validator": "verify_hysteresis_fdm_thinfilm_oop_ip_artifacts.py",
            "backend": "fdm",
            "device": "cpu",
            "precision": "double",
            "roles": ["in_plane", "oop"],
        },
        "projection_benchmark": {
            "artifact_dir": "projection_benchmark",
            "run_command": "just run-hysteresis-waveguide-projection-benchmark-smoke cpu",
            "validator": "verify_hysteresis_projection_benchmark.py",
            "backend": "fem",
            "device": "cpu",
            "precision": "double",
            "roles": ["in_plane", "oop", "custom_angle"],
        },
    }
    if omit_case is not None:
        cases.pop(omit_case)
    manifest = root / "hysteresis_publication_suite.json"
    write_json(
        manifest,
        {
            "schema_version": "hysteresis-publication-suite/v1",
            "cases": cases,
        },
    )
    return manifest


def test_publication_suite_accepts_required_cases(tmp_path: Path) -> None:
    manifest = write_publication_suite_fixture(tmp_path)

    result = run_validator(manifest)

    assert result.returncode == 0, result.stderr + result.stdout
    assert "validated hysteresis publication suite" in result.stdout
    assert "macrospin_sw" in result.stdout
    assert "thinfilm_oop_ip" in result.stdout
    assert "projection_benchmark" in result.stdout


def test_publication_suite_rejects_missing_required_case(tmp_path: Path) -> None:
    manifest = write_publication_suite_fixture(tmp_path, omit_case="projection_benchmark")

    result = run_validator(manifest)

    assert result.returncode != 0
    assert "missing required case" in (result.stderr + result.stdout)


def test_publication_suite_rejects_bare_string_case_entries(tmp_path: Path) -> None:
    manifest = write_publication_suite_fixture(tmp_path)
    payload = json.loads(manifest.read_text())
    payload["cases"]["macrospin_sw"] = "macrospin_sw"
    write_json(manifest, payload)

    result = run_validator(manifest)

    assert result.returncode != 0
    assert "case 'macrospin_sw' must be an object" in (result.stderr + result.stdout)


def test_publication_suite_rejects_missing_reproducibility_metadata(
    tmp_path: Path,
) -> None:
    manifest = write_publication_suite_fixture(tmp_path)
    payload = json.loads(manifest.read_text())
    del payload["cases"]["thinfilm_oop_ip"]["run_command"]
    write_json(manifest, payload)

    result = run_validator(manifest)

    assert result.returncode != 0
    assert "run_command" in (result.stderr + result.stdout)


def test_publication_suite_surfaces_case_validator_failure(tmp_path: Path) -> None:
    manifest = write_publication_suite_fixture(tmp_path)
    fields = [50.0, 0.0, -50.0, 0.0, 50.0]
    write_json(
        tmp_path
        / "projection_benchmark"
        / "hysteresis_angular_family"
        / "custom_theta45_phi30"
        / "hysteresis_points.json",
        [
            projection_fixtures.point(field, [0.2, 0.3, 0.4], -1.0)
            for field in fields
        ],
    )

    result = run_validator(manifest)

    assert result.returncode != 0
    assert "projection_benchmark" in (result.stderr + result.stdout)
    assert "m_parallel" in (result.stderr + result.stdout)
