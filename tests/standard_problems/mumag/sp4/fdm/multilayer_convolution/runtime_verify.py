"""Fail-closed structural verifier for SP4-derived FDM CPU artifacts."""

from __future__ import annotations

import json
import math
from pathlib import Path
import re
from typing import Any

from .common import QUALIFICATION_SCOPE

RUNTIME_SCHEMA_VERSION = "sp4_fdm_multilayer_runtime.v1"
REQUIRED_OUTPUTS = ("field_a_from_b_apm", "energy_demag_j", "coupling_a_from_b_j")
UNMET_SCIENTIFIC_QUALIFICATION = (
    "cpu_fp64_thresholds_not_evaluated",
    "cpu_fp64_direct_oracle_not_evaluated",
    "cpu_fp64_reciprocity_not_evaluated",
    "cpu_fp64_control_equilibrium_not_evaluated",
)
HEX_40 = re.compile(r"^[0-9a-f]{40}$")
HEX_64 = re.compile(r"^[0-9a-f]{64}$")
RFC3339_UTC = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


class RuntimeArtifactError(ValueError):
    """Raised when a declared CPU artifact is unavailable or malformed."""


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


def _build_identity(value: Any, label: str) -> dict[str, str]:
    if not isinstance(value, dict):
        _fail(f"runtime_build_identity_missing: {label}")
    identity = {
        "built_at_utc": value.get("built_at_utc"),
        "git_commit": value.get("git_commit"),
        "worktree_state": value.get("worktree_state"),
        "source_snapshot_sha256": value.get("source_snapshot_sha256"),
    }
    if not isinstance(identity["built_at_utc"], str) or not RFC3339_UTC.fullmatch(
        identity["built_at_utc"]
    ):
        _fail(f"runtime_build_identity_invalid: {label}:built_at_utc")
    if not isinstance(identity["git_commit"], str) or not HEX_40.fullmatch(
        identity["git_commit"]
    ):
        _fail(f"runtime_build_identity_invalid: {label}:git_commit")
    if identity["worktree_state"] not in {"clean", "dirty"}:
        _fail(f"runtime_build_identity_invalid: {label}:worktree_state")
    if not isinstance(identity["source_snapshot_sha256"], str) or not HEX_64.fullmatch(
        identity["source_snapshot_sha256"]
    ):
        _fail(f"runtime_build_identity_invalid: {label}:source_snapshot_sha256")
    return identity  # type: ignore[return-value]


def _source_identity(path: Path, build_identity: dict[str, str]) -> None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        _fail(f"runtime_source_identity_unreadable: {path}: {exc}")
    if not isinstance(payload, dict) or payload.get("schema") != "fullmag.source-snapshot.v2":
        _fail("runtime_source_identity_invalid: schema")
    dirty = payload.get("source_snapshot_dirty")
    if not isinstance(dirty, bool):
        _fail("runtime_source_identity_invalid: source_snapshot_dirty")
    expected = {
        "git_commit": payload.get("head_commit_full"),
        "worktree_state": "dirty" if dirty else "clean",
        "source_snapshot_sha256": payload.get("source_snapshot_sha256"),
    }
    for key, value in expected.items():
        if build_identity[key] != value:
            _fail(f"runtime_source_identity_mismatch: {key}")


def verify_runtime_artifacts(
    path: str | Path,
    *,
    source_snapshot: str | Path | None = None,
) -> dict[str, Any]:
    """Validate declared schema/values without proving runtime freshness."""

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
    build_identity = _build_identity(payload.get("build_identity"), "measurement")
    artifact_identities = payload.get("source_artifact_build_identities")
    if not isinstance(artifact_identities, dict):
        _fail("runtime_source_artifact_build_identities_missing")
    for label in ("ab", "a_only", "b_only"):
        artifact_identity = _build_identity(artifact_identities.get(label), label)
        if artifact_identity != build_identity:
            _fail(f"runtime_build_identity_mismatch: {label}")
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
    # This verifier only establishes that the JSON has the expected schema and
    # values.  It does not prove that the payload came from a fresh runtime or
    # that its source binary matches the current checkout; those are separate
    # recipe-level evidence requirements.  Keep this status structural so a
    # copied/self-authored JSON cannot present itself as runtime evidence.
    payload.pop("artifact_verification_status", None)
    payload["structural_validation_status"] = "passed"
    payload["qualification_status"] = "not_qualified"
    reason_codes = list(UNMET_SCIENTIFIC_QUALIFICATION)
    if source_snapshot is None:
        payload["source_identity_validation_status"] = "not_bound"
        reason_codes.append("cpu_fp64_source_identity_not_bound")
    else:
        _source_identity(Path(source_snapshot), build_identity)
        payload["source_identity_validation_status"] = "passed"
    payload["qualification_reason_codes"] = reason_codes
    payload["artifact_path"] = str(artifact)
    return payload


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path)
    parser.add_argument(
        "--artifact-only",
        action="store_true",
        help="perform structural validation only; no freshness or source identity proof",
    )
    parser.add_argument(
        "--source-snapshot",
        type=Path,
        help="exact source-snapshot identity captured before building the runtime",
    )
    args = parser.parse_args(argv)
    try:
        record = verify_runtime_artifacts(
            args.artifact,
            source_snapshot=args.source_snapshot,
        )
    except RuntimeArtifactError as exc:
        print(str(exc))
        return 2
    print(json.dumps(record, indent=2, sort_keys=True))
    if args.artifact_only:
        return 0
    return 0 if record["qualification_status"] == "qualified" else 3


if __name__ == "__main__":
    raise SystemExit(main())
