from __future__ import annotations

import json
from pathlib import Path

from verify_fem_meshing_production import validate_evidence_manifest


def test_manifest_fails_closed_when_required_stages_are_missing(tmp_path: Path) -> None:
    manifest = tmp_path / "evidence.json"
    manifest.write_text(json.dumps({"schema_version": "fem_meshing_production_gate.v1"}))

    errors = validate_evidence_manifest(manifest)

    assert any("native_fem_contract" in error for error in errors)
    assert any("managed_native_runtime" in error for error in errors)
    assert any("browser_mesh_smoke" in error for error in errors)


def test_manifest_requires_browser_metrics_and_shared_fingerprint(tmp_path: Path) -> None:
    native = tmp_path / "native.json"
    managed = tmp_path / "managed.json"
    screenshot = tmp_path / "mesh.png"
    for path in (native, managed, screenshot):
        path.write_text("artifact")
    manifest = tmp_path / "evidence.json"
    manifest.write_text(
        json.dumps(
            {
                "schema_version": "fem_meshing_production_gate.v1",
                "status": "passed",
                "mesh_fingerprint": "sha256:mesh",
                "stages": {
                    "native_fem_contract": {
                        "status": "passed",
                        "result_path": str(native),
                        "mesh_fingerprint": "sha256:mesh",
                    },
                    "managed_native_runtime": {
                        "status": "passed",
                        "artifact_path": str(managed),
                        "mesh_fingerprint": "sha256:stale",
                    },
                    "browser_mesh_smoke": {
                        "status": "passed",
                        "screenshot_path": str(screenshot),
                        "mesh_fingerprint": "sha256:mesh",
                        "metrics": {"canvas_visible": True, "context_lost": False},
                    },
                },
            }
        )
    )

    errors = validate_evidence_manifest(manifest)

    assert any("managed_native_runtime.mesh_fingerprint" in error for error in errors)
    assert any("drawing_buffer_width" in error for error in errors)


def test_manifest_accepts_complete_native_managed_and_browser_evidence(tmp_path: Path) -> None:
    native = tmp_path / "native.json"
    managed = tmp_path / "managed.json"
    screenshot = tmp_path / "mesh.png"
    for path in (native, managed, screenshot):
        path.write_text("artifact")
    manifest = tmp_path / "evidence.json"
    manifest.write_text(
        json.dumps(
            {
                "schema_version": "fem_meshing_production_gate.v1",
                "status": "passed",
                "mesh_fingerprint": "sha256:mesh",
                "stages": {
                    "native_fem_contract": {
                        "status": "passed",
                        "result_path": str(native),
                        "mesh_fingerprint": "sha256:mesh",
                    },
                    "managed_native_runtime": {
                        "status": "passed",
                        "artifact_path": str(managed),
                        "mesh_fingerprint": "sha256:mesh",
                    },
                    "browser_mesh_smoke": {
                        "status": "passed",
                        "screenshot_path": str(screenshot),
                        "mesh_fingerprint": "sha256:mesh",
                        "metrics": {
                            "canvas_visible": True,
                            "context_lost": False,
                            "drawing_buffer_width": 1280,
                            "drawing_buffer_height": 720,
                        },
                    },
                },
            }
        )
    )

    assert validate_evidence_manifest(manifest) == []
