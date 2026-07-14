from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERIFIER = ROOT / "scripts" / "verify_fem_static_pbc_m5_evidence.py"


def run_verifier(payload: dict, tmp_path: Path) -> subprocess.CompletedProcess[str]:
    manifest = tmp_path / "m5.json"
    manifest.write_text(json.dumps(payload), encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(VERIFIER), "--manifest", str(manifest)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def base_manifest() -> dict:
    fingerprint = "sha256:" + "a" * 64
    return {
        "schema_version": "fem_static_pbc_m5_evidence.v1",
        "mesh_generation_id": "m5-generation-1",
        "topology_hash": fingerprint,
        "marker_map_hash": fingerprint,
        "material_realization_hash": fingerprint,
        "strict_thresholds": True,
        "cases": {
            name: {
                "status": "pass",
                "artifact_fingerprint": fingerprint,
                "engine": engine,
                "metrics": {"max_relative_error": 1.0e-3},
            }
            for name, engine in (
                ("primitive_cell", "cpu"),
                ("supercell", "cpu"),
                ("z_padding", "cpu"),
                ("equilibrium_cpu", "cpu"),
                ("equilibrium_gpu", "gpu"),
            )
        },
    }


def test_missing_case_is_rejected_with_stable_reason(tmp_path: Path) -> None:
    payload = base_manifest()
    del payload["cases"]["equilibrium_gpu"]
    result = run_verifier(payload, tmp_path)
    assert result.returncode != 0
    assert "case_missing:equilibrium_gpu" in result.stderr


def test_non_strict_bundle_is_rejected(tmp_path: Path) -> None:
    payload = base_manifest()
    payload["strict_thresholds"] = False
    result = run_verifier(payload, tmp_path)
    assert result.returncode != 0
    assert "strict_thresholds_required" in result.stderr


def test_complete_strict_bundle_passes(tmp_path: Path) -> None:
    result = run_verifier(base_manifest(), tmp_path)
    assert result.returncode == 0
    assert "fem static PBC M5 evidence passed: 5 cases" in result.stdout
