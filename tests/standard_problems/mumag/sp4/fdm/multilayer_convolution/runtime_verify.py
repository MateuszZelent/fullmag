"""Fail-closed verifier for fresh SP4-derived FDM CPU artifacts."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

from .common import QUALIFICATION_SCOPE

RUNTIME_SCHEMA_VERSION = "sp4_fdm_multilayer_runtime.v1"
REQUIRED_OUTPUTS = ("field_a_from_b_apm", "energy_demag_j", "coupling_a_from_b_j")


class RuntimeArtifactError(ValueError):
    """Raised when a fresh, auditable CPU runtime artifact is unavailable."""


def _fail(message: str) -> None:
    raise RuntimeArtifactError(message)


def _artifact_path(path: Path) -> Path:
    if path.is_dir():
        path = path / "runtime.json"
    if not path.exists():
        _fail(f"runtime_artifacts_missing: {path}")
    if not path.is_file():
        _fail(f"runtime_artifacts_not_file: {path}")
    return path


def _finite(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(f"runtime_output_not_numeric: {label}")
    number = float(value)
    if not math.isfinite(number):
        _fail(f"runtime_output_not_finite: {label}")
    return number


def _tuple3(value: Any, label: str) -> tuple[float, float, float]:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        _fail(f"runtime_airbox_malformed: {label}")
    return tuple(_finite(item, label) for item in value)  # type: ignore[return-value]


def verify_runtime_artifacts(path: str | Path) -> dict[str, Any]:
    """Validate and return one fresh CPU artifact without inventing results."""

    artifact = _artifact_path(Path(path))
    try:
        payload = json.loads(artifact.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        _fail(f"runtime_artifacts_unreadable: {artifact}: {exc}")
    if not isinstance(payload, dict):
        _fail("runtime_artifacts_malformed: top-level object required")
    expected = {
        "schema_version": RUNTIME_SCHEMA_VERSION,
        "qualification_scope": QUALIFICATION_SCOPE,
        "backend": "fdm",
        "device": "cpu",
        "precision": "double",
        "strategy": "multilayer_convolution",
        "mode": "two_d_stack",
    }
    for key, value in expected.items():
        if payload.get(key) != value:
            _fail(f"runtime_provenance_mismatch: {key}")
    airbox = payload.get("airbox")
    if not isinstance(airbox, dict):
        _fail("runtime_airbox_missing")
    if airbox.get("target_only") is not True or airbox.get("scope_kind") != "airbox":
        _fail("runtime_airbox_source_policy_mismatch")
    if tuple(airbox.get("padding_cells_above_below", ())) != (5, 9):
        _fail("runtime_airbox_padding_mismatch")
    if tuple(airbox.get("cells_xy", ())) != (160, 40):
        _fail("runtime_airbox_cells_mismatch")
    _tuple3(airbox.get("origin_m"), "origin_m")
    _tuple3(airbox.get("spacing_m"), "spacing_m")
    outputs = payload.get("outputs")
    if not isinstance(outputs, dict):
        _fail("runtime_outputs_missing")
    for key in REQUIRED_OUTPUTS:
        if key not in outputs:
            _fail(f"runtime_output_missing: {key}")
    field = outputs["field_a_from_b_apm"]
    if not isinstance(field, (list, tuple)) or len(field) != 3:
        _fail("runtime_output_malformed: field_a_from_b_apm")
    outputs["field_a_from_b_apm"] = [_finite(value, "field_a_from_b_apm") for value in field]
    outputs["energy_demag_j"] = _finite(outputs["energy_demag_j"], "energy_demag_j")
    outputs["coupling_a_from_b_j"] = _finite(outputs["coupling_a_from_b_j"], "coupling_a_from_b_j")
    payload["artifact_path"] = str(artifact)
    return payload


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path)
    args = parser.parse_args(argv)
    try:
        record = verify_runtime_artifacts(args.artifact)
    except RuntimeArtifactError as exc:
        print(str(exc))
        return 2
    print(json.dumps(record, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
