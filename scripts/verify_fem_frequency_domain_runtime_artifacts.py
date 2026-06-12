#!/usr/bin/env python3
"""Validate FEM frequency-domain runtime smoke artifacts."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def main() -> int:
    root = (
        Path(sys.argv[1])
        if len(sys.argv) > 1
        else Path(".fullmag/reports/frequency-domain-runtime/artifacts")
    )
    required = [
        root / "response/magnetic_response_sweep.v1.json",
        root / "response/magnetic_response_sweep.v2.json",
        root / "response/progress.v1.json",
        root / "response/diagnostics.v1.json",
        root / "response/frequency_points/frequency_0000.json",
        root / "response/field_payloads/frequency_0000/vector.bin",
        root / "frequency_domain/manifest.v1.json",
    ]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise SystemExit(
            "missing required frequency-domain runtime artifacts:\n"
            + "\n".join(missing)
        )

    payload = root / "response/field_payloads/frequency_0000/vector.bin"
    if payload.stat().st_size <= 0:
        raise SystemExit(f"empty response field payload: {payload}")

    sweep = load_json(root / "response/magnetic_response_sweep.v2.json")
    progress = load_json(root / "response/progress.v1.json")
    diagnostics = load_json(root / "response/diagnostics.v1.json")
    manifest = load_json(root / "frequency_domain/manifest.v1.json")

    expected = {
        "sweep.schema_version": (
            sweep.get("schema_version"),
            "magnetic_response_sweep.v2",
        ),
        "sweep.solve_kind": (sweep.get("solve_kind"), "direct_harmonic_response"),
        "sweep.complete": (sweep.get("complete"), True),
        "sweep.completed_frequency_point_count": (
            sweep.get("completed_frequency_point_count"),
            2,
        ),
        "progress.status": (progress.get("status"), "ready"),
        "progress.completed_frequency_points": (
            progress.get("completed_frequency_points"),
            2,
        ),
        "diagnostics.status": (diagnostics.get("status"), "ready"),
        "diagnostics.complete": (diagnostics.get("complete"), True),
        "manifest.stage_kind": (manifest.get("stage_kind"), "frequency_response"),
        "manifest.requested_execution.solve_equation": (
            manifest.get("requested_execution", {}).get("solve_equation"),
            "(i omega B - L) q = f",
        ),
        "manifest.resolved_execution.engine": (
            manifest.get("resolved_execution", {}).get("engine"),
            "runner.dense_block_real_validation",
        ),
        "manifest.resolved_execution.native_backend": (
            manifest.get("resolved_execution", {}).get("native_backend"),
            "runner_validation",
        ),
        "manifest.resolved_execution.reference_or_production": (
            manifest.get("resolved_execution", {}).get("reference_or_production"),
            "reference",
        ),
        "manifest.resolved_execution.solver_library": (
            manifest.get("resolved_execution", {}).get("solver_library"),
            "nalgebra",
        ),
        "manifest.resolved_execution.solver_model": (
            manifest.get("resolved_execution", {}).get("solver_model"),
            "dense_block_real_lu",
        ),
        "manifest.resolved_execution.solve_kind": (
            manifest.get("resolved_execution", {}).get("solve_kind"),
            "direct_harmonic_response",
        ),
        "manifest.capabilities.production_native_solver_available": (
            manifest.get("capabilities", {}).get("production_native_solver_available"),
            False,
        ),
        "manifest.capabilities.validation_artifact": (
            manifest.get("capabilities", {}).get("validation_artifact"),
            True,
        ),
        "manifest.resources.response_sweep_resource_key": (
            manifest.get("resources", {}).get("response_sweep_resource_key"),
            "/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep",
        ),
    }
    mismatches = [
        f"{name}: got {actual!r}, expected {expected_value!r}"
        for name, (actual, expected_value) in expected.items()
        if actual != expected_value
    ]
    if mismatches:
        raise SystemExit(
            "invalid frequency-domain runtime artifacts:\n" + "\n".join(mismatches)
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
