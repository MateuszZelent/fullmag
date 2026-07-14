import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERIFIER = ROOT / "scripts" / "verify_pbc_production_matrix.py"


def run_verifier(manifest: dict, tmp_path: Path) -> subprocess.CompletedProcess[str]:
    manifest_path = tmp_path / "matrix.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(VERIFIER), "--manifest", str(manifest_path)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def test_pending_case_result_is_rejected(tmp_path: Path) -> None:
    result = run_verifier(
        {
            "schema_version": "pbc_production_matrix.v1",
            "matrix_id": "test",
            "cases": [
                {
                    "case_id": "fdm-cpu-double-standard-single-grid",
                    "backend": "fdm",
                    "device": "cpu",
                    "precision": "double",
                    "lane": "single-grid",
                    "capability_id": "fdm_periodic_demag_boundary_semantics",
                    "capability_status": "reference_executable",
                    "result": {"status": "not_run", "artifact_fingerprint": None},
                }
            ],
        },
        tmp_path,
    )

    assert result.returncode != 0
    assert "case_result_missing:fdm-cpu-double-standard-single-grid" in result.stderr


def test_pass_case_requires_sha256_artifact_fingerprint(tmp_path: Path) -> None:
    result = run_verifier(
        {
            "schema_version": "pbc_production_matrix.v1",
            "matrix_id": "test",
            "cases": [
                {
                    "case_id": "fdm-cpu-double-standard-single-grid",
                    "backend": "fdm",
                    "device": "cpu",
                    "precision": "double",
                    "lane": "single-grid",
                    "capability_id": "fdm_periodic_demag_boundary_semantics",
                    "capability_status": "reference_executable",
                    "result": {
                        "status": "pass",
                        "artifact_fingerprint": "sha256:" + "a" * 64,
                    },
                }
            ],
        },
        tmp_path,
    )

    assert result.returncode == 0
    assert "pbc production matrix passed: 1 cases" in result.stdout


def test_expected_unsupported_requires_unsupported_capability_and_reason(tmp_path: Path) -> None:
    result = run_verifier(
        {
            "schema_version": "pbc_production_matrix.v1",
            "matrix_id": "test",
            "cases": [
                {
                    "case_id": "fem-periodic-demag-unsupported",
                    "backend": "fem",
                    "device": "gpu",
                    "precision": "double",
                    "lane": "fully-periodic-3d",
                    "capability_id": "fdm_periodic_demag_boundary_semantics",
                    "capability_status": "production_executable",
                    "result": {
                        "status": "expected_unsupported",
                        "artifact_fingerprint": "sha256:" + "b" * 64,
                        "reason": "capability matrix marks this lane unsupported",
                    },
                }
            ],
        },
        tmp_path,
    )

    assert result.returncode != 0
    assert "unsupported_status_mismatch:fem-periodic-demag-unsupported" in result.stderr
