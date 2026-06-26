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
metrics_parity_fixtures = load_script_module(
    REPO_ROOT / "scripts" / "test_verify_hysteresis_metrics_parity.py"
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


def cross_backend_acceptance_fixture() -> dict:
    return {
        "status": "criteria_declared_runtime_open",
        "reference_lane": {
            "backend": "fdm",
            "device": "cpu",
            "precision": "double",
            "case_ids": ["macrospin_sw", "thinfilm_oop_ip"],
        },
        "required_metrics": ["H_c_plus", "H_c_minus", "M_r_plus", "M_r_minus"],
        "lanes": [
            {
                "backend": "fdm",
                "device": "cpu",
                "precision": "double",
                "status": "validated",
                "case_ids": ["macrospin_sw", "thinfilm_oop_ip"],
                "evidence": "fast publication fixtures pass current validators",
            },
            {
                "backend": "fem",
                "device": "cpu",
                "precision": "double",
                "status": "supported-with-warning",
                "case_ids": ["projection_benchmark"],
                "limitations": [
                    "projection benchmark is not coercivity/remanence parity",
                ],
            },
            {
                "backend": "fdm",
                "device": "gpu",
                "precision": "double",
                "status": "unsupported",
                "reason": "no publication-suite hysteresis parity fixture declared",
            },
            {
                "backend": "fem",
                "device": "gpu",
                "precision": "double",
                "status": "unsupported",
                "reason": "no publication-suite hysteresis parity fixture declared",
            },
        ],
        "tolerances": [
            {
                "metric": "coercivity_mT",
                "status": "deferred",
                "reason": (
                    "paired FDM/FEM runtime parity artifacts are not part of the fast suite"
                ),
            },
            {
                "metric": "remanence",
                "status": "deferred",
                "reason": (
                    "paired FDM/FEM runtime parity artifacts are not part of the fast suite"
                ),
            },
        ],
    }


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
            "cross_backend_acceptance": cross_backend_acceptance_fixture(),
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


def test_publication_suite_rejects_missing_cross_backend_acceptance(
    tmp_path: Path,
) -> None:
    manifest = write_publication_suite_fixture(tmp_path)
    payload = json.loads(manifest.read_text())
    del payload["cross_backend_acceptance"]
    write_json(manifest, payload)

    result = run_validator(manifest)

    assert result.returncode != 0
    assert "cross_backend_acceptance" in (result.stderr + result.stdout)


def test_publication_suite_rejects_single_backend_cross_backend_claim(
    tmp_path: Path,
) -> None:
    manifest = write_publication_suite_fixture(tmp_path)
    payload = json.loads(manifest.read_text())
    payload["cases"]["projection_benchmark"]["backend"] = "fdm"
    write_json(manifest, payload)

    result = run_validator(manifest)

    assert result.returncode != 0
    assert "cross_backend_acceptance" in (result.stderr + result.stdout)


def test_publication_suite_rejects_missing_required_cross_backend_lane(
    tmp_path: Path,
) -> None:
    manifest = write_publication_suite_fixture(tmp_path)
    payload = json.loads(manifest.read_text())
    payload["cross_backend_acceptance"]["lanes"] = [
        lane
        for lane in payload["cross_backend_acceptance"]["lanes"]
        if not (
            lane["backend"] == "fem"
            and lane["device"] == "gpu"
            and lane["precision"] == "double"
        )
    ]
    write_json(manifest, payload)

    result = run_validator(manifest)

    assert result.returncode != 0
    assert "fem/gpu/double" in (result.stderr + result.stdout)


def test_publication_suite_rejects_unsupported_lane_without_reason(
    tmp_path: Path,
) -> None:
    manifest = write_publication_suite_fixture(tmp_path)
    payload = json.loads(manifest.read_text())
    del payload["cross_backend_acceptance"]["lanes"][2]["reason"]
    write_json(manifest, payload)

    result = run_validator(manifest)

    assert result.returncode != 0
    assert "reason" in (result.stderr + result.stdout)


def test_publication_suite_rejects_case_artifact_dir_outside_manifest_tree(
    tmp_path: Path,
) -> None:
    manifest_root = tmp_path / "manifest"
    manifest = write_publication_suite_fixture(manifest_root)
    outside = tmp_path / "outside_case"
    projection_fixtures.write_projection_fixture(outside)
    payload = json.loads(manifest.read_text())
    payload["cases"]["projection_benchmark"]["artifact_dir"] = "../outside_case"
    write_json(manifest, payload)

    result = run_validator(manifest)

    assert result.returncode != 0
    assert "must stay under" in (result.stderr + result.stdout)


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


def test_publication_suite_runs_optional_metrics_parity_check(
    tmp_path: Path,
) -> None:
    manifest = write_publication_suite_fixture(tmp_path)
    metrics_parity_fixtures.write_parity_fixture(
        tmp_path / "parity",
        candidate_h_c_plus=15.5,
    )
    payload = json.loads(manifest.read_text())
    payload["cross_backend_acceptance"]["parity_checks"] = [
        "parity/hysteresis_metrics_parity.json"
    ]
    write_json(manifest, payload)

    result = run_validator(manifest)

    assert result.returncode != 0
    details = result.stderr + result.stdout
    assert "parity/hysteresis_metrics_parity.json" in details
    assert "H_c_plus" in details


def test_publication_suite_accepts_passing_metrics_parity_check(
    tmp_path: Path,
) -> None:
    manifest = write_publication_suite_fixture(tmp_path)
    metrics_parity_fixtures.write_parity_fixture(tmp_path / "parity")
    payload = json.loads(manifest.read_text())
    payload["cross_backend_acceptance"]["parity_checks"] = [
        "parity/hysteresis_metrics_parity.json"
    ]
    write_json(manifest, payload)

    result = run_validator(manifest)

    assert result.returncode == 0, result.stderr + result.stdout
    assert "validated hysteresis publication suite" in result.stdout


def test_publication_suite_rejects_parity_check_outside_manifest_tree(
    tmp_path: Path,
) -> None:
    manifest_root = tmp_path / "manifest"
    manifest = write_publication_suite_fixture(manifest_root)
    metrics_parity_fixtures.write_parity_fixture(tmp_path / "outside_parity")
    payload = json.loads(manifest.read_text())
    payload["cross_backend_acceptance"]["parity_checks"] = [
        "../outside_parity/hysteresis_metrics_parity.json"
    ]
    write_json(manifest, payload)

    result = run_validator(manifest)

    assert result.returncode != 0
    assert "must stay under" in (result.stderr + result.stdout)


def test_publication_suite_rejects_validated_acceptance_without_parity_check(
    tmp_path: Path,
) -> None:
    manifest = write_publication_suite_fixture(tmp_path)
    payload = json.loads(manifest.read_text())
    payload["cross_backend_acceptance"]["status"] = "validated"
    write_json(manifest, payload)

    result = run_validator(manifest)

    assert result.returncode != 0
    assert "parity_checks" in (result.stderr + result.stdout)


def test_publication_suite_rejects_validated_acceptance_with_deferred_tolerance(
    tmp_path: Path,
) -> None:
    manifest = write_publication_suite_fixture(tmp_path)
    metrics_parity_fixtures.write_parity_fixture(tmp_path / "parity")
    payload = json.loads(manifest.read_text())
    payload["cases"]["fdm_gpu_parity"] = {
        "backend": "fdm",
        "device": "gpu",
        "precision": "double",
    }
    payload["cases"]["fem_gpu_parity"] = {
        "backend": "fem",
        "device": "gpu",
        "precision": "double",
    }
    payload["cross_backend_acceptance"]["status"] = "validated"
    payload["cross_backend_acceptance"]["parity_checks"] = [
        "parity/hysteresis_metrics_parity.json"
    ]
    for lane in payload["cross_backend_acceptance"]["lanes"]:
        lane["status"] = "validated"
        lane["evidence"] = "synthetic parity evidence for tolerance gate"
        lane.pop("limitations", None)
        lane.pop("reason", None)
        if lane["backend"] == "fdm" and lane["device"] == "gpu":
            lane["case_ids"] = ["fdm_gpu_parity"]
        elif lane["backend"] == "fem" and lane["device"] == "gpu":
            lane["case_ids"] = ["fem_gpu_parity"]
    write_json(manifest, payload)

    result = run_validator(manifest)

    assert result.returncode != 0
    details = result.stderr + result.stdout
    assert "tolerances" in details
    assert "validated" in details


def test_publication_suite_rejects_validated_acceptance_with_open_lane(
    tmp_path: Path,
) -> None:
    manifest = write_publication_suite_fixture(tmp_path)
    metrics_parity_fixtures.write_parity_fixture(tmp_path / "parity")
    payload = json.loads(manifest.read_text())
    payload["cross_backend_acceptance"]["status"] = "validated"
    payload["cross_backend_acceptance"]["parity_checks"] = [
        "parity/hysteresis_metrics_parity.json"
    ]
    for tolerance in payload["cross_backend_acceptance"]["tolerances"]:
        tolerance["status"] = "validated"
    write_json(manifest, payload)

    result = run_validator(manifest)

    assert result.returncode != 0
    details = result.stderr + result.stdout
    assert "lane" in details
    assert "validated" in details


def test_publication_suite_rejects_validated_acceptance_with_uncovered_lane(
    tmp_path: Path,
) -> None:
    manifest = write_publication_suite_fixture(tmp_path)
    metrics_parity_fixtures.write_parity_fixture(tmp_path / "parity")
    payload = json.loads(manifest.read_text())
    payload["cases"]["fdm_gpu_parity"] = {
        "backend": "fdm",
        "device": "gpu",
        "precision": "double",
    }
    payload["cases"]["fem_gpu_parity"] = {
        "backend": "fem",
        "device": "gpu",
        "precision": "double",
    }
    payload["cross_backend_acceptance"]["status"] = "validated"
    payload["cross_backend_acceptance"]["parity_checks"] = [
        "parity/hysteresis_metrics_parity.json"
    ]
    for tolerance in payload["cross_backend_acceptance"]["tolerances"]:
        tolerance["status"] = "validated"
    for lane in payload["cross_backend_acceptance"]["lanes"]:
        lane["status"] = "validated"
        lane["evidence"] = "synthetic lane evidence for coverage gate"
        lane.pop("limitations", None)
        lane.pop("reason", None)
        if lane["backend"] == "fdm" and lane["device"] == "gpu":
            lane["case_ids"] = ["fdm_gpu_parity"]
        elif lane["backend"] == "fem" and lane["device"] == "gpu":
            lane["case_ids"] = ["fem_gpu_parity"]
    write_json(manifest, payload)

    result = run_validator(manifest)

    assert result.returncode != 0
    details = result.stderr + result.stdout
    assert "parity_checks" in details
    assert "fdm/gpu/double" in details


def test_publication_suite_accepts_validated_acceptance_with_full_parity_coverage(
    tmp_path: Path,
) -> None:
    manifest = write_publication_suite_fixture(tmp_path)
    parity_root = tmp_path / "parity"
    for lane_dir in ("fdm_cpu", "fdm_gpu", "fem_cpu", "fem_gpu"):
        metrics_parity_fixtures.write_json(
            parity_root / lane_dir / "hysteresis_metrics.json",
            metrics_parity_fixtures.metrics_payload(),
        )
    metrics_parity_fixtures.write_json(
        parity_root / "hysteresis_metrics_parity.json",
        {
            "schema_version": "hysteresis-metrics-parity/v1",
            "pairs": [
                {
                    "pair_id": "fdm_cpu_vs_fdm_gpu",
                    "reference": {
                        "backend": "fdm",
                        "device": "cpu",
                        "precision": "double",
                        "metrics_path": "fdm_cpu/hysteresis_metrics.json",
                    },
                    "candidate": {
                        "backend": "fdm",
                        "device": "gpu",
                        "precision": "double",
                        "metrics_path": "fdm_gpu/hysteresis_metrics.json",
                    },
                    "metrics": [
                        {"name": "H_c_plus", "unit": "mT", "abs_tolerance": 0.0},
                        {"name": "H_c_minus", "unit": "mT", "abs_tolerance": 0.0},
                        {"name": "M_r_plus", "unit": "1", "abs_tolerance": 0.0},
                        {"name": "M_r_minus", "unit": "1", "abs_tolerance": 0.0},
                    ],
                },
                {
                    "pair_id": "fdm_cpu_vs_fem_cpu",
                    "reference": {
                        "backend": "fdm",
                        "device": "cpu",
                        "precision": "double",
                        "metrics_path": "fdm_cpu/hysteresis_metrics.json",
                    },
                    "candidate": {
                        "backend": "fem",
                        "device": "cpu",
                        "precision": "double",
                        "metrics_path": "fem_cpu/hysteresis_metrics.json",
                    },
                    "metrics": [
                        {"name": "H_c_plus", "unit": "mT", "abs_tolerance": 0.0},
                        {"name": "H_c_minus", "unit": "mT", "abs_tolerance": 0.0},
                        {"name": "M_r_plus", "unit": "1", "abs_tolerance": 0.0},
                        {"name": "M_r_minus", "unit": "1", "abs_tolerance": 0.0},
                    ],
                },
                {
                    "pair_id": "fdm_cpu_vs_fem_gpu",
                    "reference": {
                        "backend": "fdm",
                        "device": "cpu",
                        "precision": "double",
                        "metrics_path": "fdm_cpu/hysteresis_metrics.json",
                    },
                    "candidate": {
                        "backend": "fem",
                        "device": "gpu",
                        "precision": "double",
                        "metrics_path": "fem_gpu/hysteresis_metrics.json",
                    },
                    "metrics": [
                        {"name": "H_c_plus", "unit": "mT", "abs_tolerance": 0.0},
                        {"name": "H_c_minus", "unit": "mT", "abs_tolerance": 0.0},
                        {"name": "M_r_plus", "unit": "1", "abs_tolerance": 0.0},
                        {"name": "M_r_minus", "unit": "1", "abs_tolerance": 0.0},
                    ],
                },
            ],
        },
    )
    payload = json.loads(manifest.read_text())
    payload["cases"]["fdm_gpu_parity"] = {
        "backend": "fdm",
        "device": "gpu",
        "precision": "double",
    }
    payload["cases"]["fem_gpu_parity"] = {
        "backend": "fem",
        "device": "gpu",
        "precision": "double",
    }
    payload["cross_backend_acceptance"]["status"] = "validated"
    payload["cross_backend_acceptance"]["parity_checks"] = [
        "parity/hysteresis_metrics_parity.json"
    ]
    for tolerance in payload["cross_backend_acceptance"]["tolerances"]:
        tolerance["status"] = "validated"
    for lane in payload["cross_backend_acceptance"]["lanes"]:
        lane["status"] = "validated"
        lane["evidence"] = "synthetic full parity coverage evidence"
        lane.pop("limitations", None)
        lane.pop("reason", None)
        if lane["backend"] == "fdm" and lane["device"] == "gpu":
            lane["case_ids"] = ["fdm_gpu_parity"]
        elif lane["backend"] == "fem" and lane["device"] == "gpu":
            lane["case_ids"] = ["fem_gpu_parity"]
    write_json(manifest, payload)

    result = run_validator(manifest)

    assert result.returncode == 0, result.stderr + result.stdout
    assert "validated hysteresis publication suite" in result.stdout


def test_publication_suite_rejects_validated_acceptance_with_reversed_parity_pair(
    tmp_path: Path,
) -> None:
    manifest = write_publication_suite_fixture(tmp_path)
    parity_root = tmp_path / "parity"
    for lane_dir in ("fdm_cpu", "fdm_gpu", "fem_cpu", "fem_gpu"):
        metrics_parity_fixtures.write_json(
            parity_root / lane_dir / "hysteresis_metrics.json",
            metrics_parity_fixtures.metrics_payload(),
        )
    metrics_parity_fixtures.write_json(
        parity_root / "hysteresis_metrics_parity.json",
        {
            "schema_version": "hysteresis-metrics-parity/v1",
            "pairs": [
                {
                    "pair_id": "fdm_gpu_vs_fdm_cpu_reversed",
                    "reference": {
                        "backend": "fdm",
                        "device": "gpu",
                        "precision": "double",
                        "metrics_path": "fdm_gpu/hysteresis_metrics.json",
                    },
                    "candidate": {
                        "backend": "fdm",
                        "device": "cpu",
                        "precision": "double",
                        "metrics_path": "fdm_cpu/hysteresis_metrics.json",
                    },
                    "metrics": [
                        {"name": "H_c_plus", "unit": "mT", "abs_tolerance": 0.0},
                        {"name": "H_c_minus", "unit": "mT", "abs_tolerance": 0.0},
                        {"name": "M_r_plus", "unit": "1", "abs_tolerance": 0.0},
                        {"name": "M_r_minus", "unit": "1", "abs_tolerance": 0.0},
                    ],
                },
                {
                    "pair_id": "fdm_cpu_vs_fem_cpu",
                    "reference": {
                        "backend": "fdm",
                        "device": "cpu",
                        "precision": "double",
                        "metrics_path": "fdm_cpu/hysteresis_metrics.json",
                    },
                    "candidate": {
                        "backend": "fem",
                        "device": "cpu",
                        "precision": "double",
                        "metrics_path": "fem_cpu/hysteresis_metrics.json",
                    },
                    "metrics": [
                        {"name": "H_c_plus", "unit": "mT", "abs_tolerance": 0.0},
                        {"name": "H_c_minus", "unit": "mT", "abs_tolerance": 0.0},
                        {"name": "M_r_plus", "unit": "1", "abs_tolerance": 0.0},
                        {"name": "M_r_minus", "unit": "1", "abs_tolerance": 0.0},
                    ],
                },
                {
                    "pair_id": "fdm_cpu_vs_fem_gpu",
                    "reference": {
                        "backend": "fdm",
                        "device": "cpu",
                        "precision": "double",
                        "metrics_path": "fdm_cpu/hysteresis_metrics.json",
                    },
                    "candidate": {
                        "backend": "fem",
                        "device": "gpu",
                        "precision": "double",
                        "metrics_path": "fem_gpu/hysteresis_metrics.json",
                    },
                    "metrics": [
                        {"name": "H_c_plus", "unit": "mT", "abs_tolerance": 0.0},
                        {"name": "H_c_minus", "unit": "mT", "abs_tolerance": 0.0},
                        {"name": "M_r_plus", "unit": "1", "abs_tolerance": 0.0},
                        {"name": "M_r_minus", "unit": "1", "abs_tolerance": 0.0},
                    ],
                },
            ],
        },
    )
    payload = json.loads(manifest.read_text())
    payload["cases"]["fdm_gpu_parity"] = {
        "backend": "fdm",
        "device": "gpu",
        "precision": "double",
    }
    payload["cases"]["fem_gpu_parity"] = {
        "backend": "fem",
        "device": "gpu",
        "precision": "double",
    }
    payload["cross_backend_acceptance"]["status"] = "validated"
    payload["cross_backend_acceptance"]["parity_checks"] = [
        "parity/hysteresis_metrics_parity.json"
    ]
    for tolerance in payload["cross_backend_acceptance"]["tolerances"]:
        tolerance["status"] = "validated"
    for lane in payload["cross_backend_acceptance"]["lanes"]:
        lane["status"] = "validated"
        lane["evidence"] = "synthetic reversed coverage evidence"
        lane.pop("limitations", None)
        lane.pop("reason", None)
        if lane["backend"] == "fdm" and lane["device"] == "gpu":
            lane["case_ids"] = ["fdm_gpu_parity"]
        elif lane["backend"] == "fem" and lane["device"] == "gpu":
            lane["case_ids"] = ["fem_gpu_parity"]
    write_json(manifest, payload)

    result = run_validator(manifest)

    assert result.returncode != 0
    details = result.stderr + result.stdout
    assert "parity_checks" in details
    assert "fdm/gpu/double" in details
