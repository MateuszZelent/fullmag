#!/usr/bin/env python3
"""Fail-closed common-limit comparison of Fullmag and MuMax racetrack dynamics.

This program deliberately does not compare solved-current implementations.  MuMax
must receive the field torque exported by Fullmag, identified by the same SHA-256
digest.  A missing executable digest or torque-identity proof is a qualification
failure, not a partially valid result.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Mapping, Sequence


SCHEMA_VERSION = "racetrack_mumax_common_limit_v1"
FULLMAG_INPUT_SCHEMA = "fullmag_racetrack_common_limit_input.v1"
MUMAX_INPUT_SCHEMA = "mumax_racetrack_common_limit_input.v1"
DEFAULT_THRESHOLDS = {
    "m_rms": 2.0e-3,
    "energy_relative": 5.0e-3,
    "topological_charge": 5.0e-2,
    "centre_m": 2.0e-9,
    "velocity_m_per_s": 5.0,
    "theta_h_rad": 5.0e-2,
}


class ComparisonError(ValueError):
    """A missing invariant or metric threshold prevents common-limit evidence."""


def _mapping(value: object, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ComparisonError(f"{label} must be an object")
    return value


def _text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ComparisonError(f"{label} must be a nonempty string")
    return value


def _number(value: object, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        raise ComparisonError(f"{label} must be a finite number")
    result = float(value)
    if not math.isfinite(result):
        raise ComparisonError(f"{label} must be a finite number")
    return result


def _vector(value: object, length: int, label: str) -> tuple[float, ...]:
    if not isinstance(value, list) or len(value) != length:
        raise ComparisonError(f"{label} must contain {length} values")
    return tuple(_number(component, f"{label}[{index}]") for index, component in enumerate(value))


def _trajectory(manifest: Mapping[str, Any], label: str) -> list[Mapping[str, Any]]:
    raw = manifest.get("trajectory")
    if not isinstance(raw, list) or len(raw) < 2:
        raise ComparisonError(f"{label} trajectory must contain at least two samples")
    return [_mapping(sample, f"{label} trajectory[{index}]") for index, sample in enumerate(raw)]


def _validate_identity(fullmag: Mapping[str, Any], mumax: Mapping[str, Any]) -> dict[str, str]:
    if fullmag.get("schema_version") != FULLMAG_INPUT_SCHEMA:
        raise ComparisonError(f"unexpected Fullmag input schema: {fullmag.get('schema_version')!r}")
    if mumax.get("schema_version") != MUMAX_INPUT_SCHEMA:
        raise ComparisonError(f"unexpected MuMax input schema: {mumax.get('schema_version')!r}")
    mumax_info = _mapping(mumax.get("mumax"), "mumax")
    mumax_version = _text(mumax_info.get("version"), "MuMax version")
    mumax_digest = _text(mumax_info.get("binary_digest_sha256"), "MuMax binary digest")
    fullmag_grid = _mapping(fullmag.get("grid"), "Fullmag grid")
    mumax_grid = _mapping(mumax.get("grid"), "MuMax grid")
    if fullmag_grid.get("shape") != mumax_grid.get("shape"):
        raise ComparisonError("grid shape mismatch")
    grid_digest = _text(fullmag_grid.get("digest_sha256"), "Fullmag grid digest")
    if grid_digest != _text(mumax_grid.get("digest_sha256"), "MuMax grid digest"):
        raise ComparisonError("grid digest mismatch")
    torque_export = _mapping(fullmag.get("torque_export"), "Fullmag torque export")
    torque_digest = _text(torque_export.get("field_digest_sha256"), "Fullmag torque digest")
    formula_version = _text(torque_export.get("formula_version"), "Fullmag torque formula")
    if formula_version != "transport_torque_angular_momentum.fullmag.v1":
        raise ComparisonError("Fullmag torque formula is not the solved-current export")
    if _text(torque_export.get("units"), "Fullmag torque units") != "s^-1":
        raise ComparisonError("Fullmag torque units must be s^-1")
    injected = _mapping(mumax.get("injected_torque"), "MuMax injected torque")
    if injected.get("identity_confirmed") is not True:
        raise ComparisonError("MuMax torque identity is not confirmed")
    if _text(injected.get("formula_version"), "MuMax torque formula") != formula_version:
        raise ComparisonError("MuMax torque formula does not match Fullmag torque formula")
    if _text(injected.get("units"), "MuMax injected torque units") != "s^-1":
        raise ComparisonError("MuMax torque units must be s^-1")
    if torque_digest != _text(injected.get("source_field_digest_sha256"), "MuMax torque source digest"):
        raise ComparisonError("MuMax torque identity digest does not match Fullmag export")
    fullmag_common_limit = _mapping(fullmag.get("common_limit"), "Fullmag common_limit")
    mumax_common_limit = _mapping(mumax.get("common_limit"), "MuMax common_limit")
    for key in ("integrator", "fixed_timestep_s", "demag_policy"):
        if fullmag_common_limit.get(key) != mumax_common_limit.get(key):
            raise ComparisonError(f"common-limit {key} mismatch")
    if _text(fullmag_common_limit.get("integrator"), "common-limit integrator") != "heun_fixed":
        raise ComparisonError("common-limit integrator must be heun_fixed")
    if _number(fullmag_common_limit.get("fixed_timestep_s"), "common-limit fixed_timestep_s") <= 0.0:
        raise ComparisonError("common-limit fixed_timestep_s must be positive")
    return {
        "mumax_version": mumax_version,
        "mumax_binary_digest_sha256": mumax_digest,
        "mumax_input_script_digest_sha256": _text(mumax_info.get("input_script_digest_sha256"), "MuMax input script digest"),
        "mumax_output_ovf_digest_sha256": _text(mumax_info.get("output_ovf_digest_sha256"), "MuMax output OVF digest"),
        "torque_digest_sha256": torque_digest,
        "grid_digest_sha256": grid_digest,
    }


def _sample_m(sample: Mapping[str, Any], label: str) -> list[tuple[float, float, float]]:
    raw = sample.get("m")
    if not isinstance(raw, list) or not raw:
        raise ComparisonError(f"{label}.m must be a nonempty vector field")
    return [tuple(_vector(vector, 3, f"{label}.m[{index}]")) for index, vector in enumerate(raw)]  # type: ignore[list-item]


def _velocity(trajectory: Sequence[Mapping[str, Any]], label: str) -> tuple[float, float]:
    first, last = trajectory[0], trajectory[-1]
    dt = _number(last.get("time_s"), f"{label} final time_s") - _number(first.get("time_s"), f"{label} initial time_s")
    if dt <= 0.0:
        raise ComparisonError(f"{label} trajectory duration must be positive")
    start = _vector(first.get("centre_m"), 2, f"{label} initial centre_m")
    end = _vector(last.get("centre_m"), 2, f"{label} final centre_m")
    return ((end[0] - start[0]) / dt, (end[1] - start[1]) / dt)


def _relative_error(candidate: float, reference: float, label: str) -> float:
    if reference == 0.0:
        if candidate != 0.0:
            raise ComparisonError(f"{label} reference is zero while candidate is nonzero")
        return 0.0
    return abs(candidate - reference) / abs(reference)


def _metric_limit(metrics: Mapping[str, float], thresholds: Mapping[str, float]) -> None:
    for metric, limit in thresholds.items():
        if metric not in metrics:
            raise ComparisonError(f"missing threshold metric {metric}")
        finite_limit = _number(limit, f"threshold {metric}")
        if finite_limit < 0.0:
            raise ComparisonError(f"threshold {metric} must be nonnegative")
        if metrics[metric] > finite_limit:
            raise ComparisonError(f"{metric}={metrics[metric]:.12g} exceeds threshold {finite_limit:.12g}")


def compare_common_limit(
    fullmag: Mapping[str, Any], mumax: Mapping[str, Any], *, thresholds: Mapping[str, float]
) -> dict[str, object]:
    """Compare exactly synchronized trajectories after identity checks."""
    identity = _validate_identity(fullmag, mumax)
    fullmag_samples = _trajectory(fullmag, "Fullmag")
    mumax_samples = _trajectory(mumax, "MuMax")
    if len(fullmag_samples) != len(mumax_samples):
        raise ComparisonError("sample count mismatch")

    squared_m_error = 0.0
    component_count = 0
    energy_relative = 0.0
    q_error = 0.0
    centre_error = 0.0
    topology_sign: int | None = None
    for index, (fullmag_sample, mumax_sample) in enumerate(zip(fullmag_samples, mumax_samples)):
        if _number(fullmag_sample.get("time_s"), f"Fullmag sample {index} time_s") != _number(mumax_sample.get("time_s"), f"MuMax sample {index} time_s"):
            raise ComparisonError(f"sample time mismatch at index {index}")
        fm_m = _sample_m(fullmag_sample, f"Fullmag sample {index}")
        mx_m = _sample_m(mumax_sample, f"MuMax sample {index}")
        if len(fm_m) != len(mx_m):
            raise ComparisonError(f"magnetization cell count mismatch at sample {index}")
        for fm_vector, mx_vector in zip(fm_m, mx_m):
            squared_m_error += sum((a - b) ** 2 for a, b in zip(fm_vector, mx_vector))
            component_count += 3
        energy_relative = max(energy_relative, _relative_error(_number(mx_sample := mumax_sample.get("energy_J"), f"MuMax sample {index} energy_J"), _number(fullmag_sample.get("energy_J"), f"Fullmag sample {index} energy_J"), "energy"))
        fm_q = _number(fullmag_sample.get("topological_charge"), f"Fullmag sample {index} topological_charge")
        mx_q = _number(mumax_sample.get("topological_charge"), f"MuMax sample {index} topological_charge")
        for q, source in ((fm_q, "Fullmag"), (mx_q, "MuMax")):
            if abs(q) < 0.5:
                raise ComparisonError(f"topology_lost: {source} sample {index} has |Q| < 0.5")
            sign = 1 if q > 0.0 else -1
            if topology_sign is None:
                topology_sign = sign
            elif sign != topology_sign:
                raise ComparisonError(f"topology_lost: sign changed at sample {index}")
        q_error = max(q_error, abs(fm_q - mx_q))
        fm_centre = _vector(fullmag_sample.get("centre_m"), 2, f"Fullmag sample {index} centre_m")
        mx_centre = _vector(mumax_sample.get("centre_m"), 2, f"MuMax sample {index} centre_m")
        centre_error = max(centre_error, math.hypot(fm_centre[0] - mx_centre[0], fm_centre[1] - mx_centre[1]))

    fm_velocity = _velocity(fullmag_samples, "Fullmag")
    mx_velocity = _velocity(mumax_samples, "MuMax")
    fm_theta = math.atan2(fm_velocity[1], fm_velocity[0])
    mx_theta = math.atan2(mx_velocity[1], mx_velocity[0])
    theta_error = abs(math.atan2(math.sin(fm_theta - mx_theta), math.cos(fm_theta - mx_theta)))
    metrics = {
        "m_rms": math.sqrt(squared_m_error / component_count),
        "energy_relative": energy_relative,
        "topological_charge": q_error,
        "centre_m": centre_error,
        "velocity_m_per_s": math.hypot(fm_velocity[0] - mx_velocity[0], fm_velocity[1] - mx_velocity[1]),
        "theta_h_rad": theta_error,
    }
    _metric_limit(metrics, thresholds)
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "pass",
        "identity": identity,
        "sample_count": len(fullmag_samples),
        "metrics": {**metrics, "theta_h_rad_error": theta_error},
        "fullmag": {"velocity_m_per_s": list(fm_velocity), "theta_h_rad": fm_theta},
        "mumax": {"velocity_m_per_s": list(mx_velocity), "theta_h_rad": mx_theta},
        "thresholds": dict(thresholds),
    }


def _load(path: Path) -> Mapping[str, Any]:
    try:
        return _mapping(json.loads(path.read_text(encoding="utf-8")), str(path))
    except OSError as error:
        raise ComparisonError(f"cannot read {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise ComparisonError(f"cannot parse {path}: {error}") from error


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fullmag", type=Path, required=True, help="Fullmag common-limit input manifest")
    parser.add_argument("--mumax", type=Path, required=True, help="MuMax common-limit input manifest")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--thresholds", type=Path, help="JSON object overriding default metric thresholds")
    args = parser.parse_args()
    thresholds: Mapping[str, float] = DEFAULT_THRESHOLDS
    if args.thresholds is not None:
        thresholds = _load(args.thresholds)
    try:
        report = compare_common_limit(_load(args.fullmag), _load(args.mumax), thresholds=thresholds)
    except ComparisonError as error:
        print(f"racetrack MuMax common-limit comparison failed: {error}", flush=True)
        return 2
    serialized = json.dumps(report, indent=2, sort_keys=True) + "\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(serialized, encoding="utf-8")
    print(serialized, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
