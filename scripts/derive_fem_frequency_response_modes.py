#!/usr/bin/env python3
"""Derive driven FMR mode candidates from FEM frequency-response artifacts."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path


def fail(message: str) -> None:
    raise SystemExit(f"invalid frequency-response mode derivation input:\n{message}")


def load_json(path: Path) -> dict:
    if not path.is_file():
        fail(f"missing required artifact: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        fail(f"{path} must contain a JSON object")
    return value


def finite_number(value: object, name: str) -> float:
    if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        fail(f"{name} must be a finite number")
    return float(value)


def non_empty_string(value: object, name: str) -> str:
    if not isinstance(value, str) or not value:
        fail(f"{name} must be a non-empty string")
    return value


def point_amplitude(point: dict, index: int) -> float:
    value = point.get("max_response_amplitude")
    if value is None:
        value = point.get("response_amplitude")
    return finite_number(value, f"sweep.points[{index}].response_amplitude")


def point_amplitude_source(point: dict) -> str:
    return (
        "max_response_amplitude"
        if point.get("max_response_amplitude") is not None
        else "response_amplitude"
    )


def select_peak(points: list[dict]) -> tuple[int, dict, float]:
    if not points:
        fail("sweep.points must not be empty")
    selected: tuple[int, dict, float] | None = None
    for index, point in enumerate(points):
        if not isinstance(point, dict):
            fail(f"sweep.points[{index}] must be an object")
        amplitude = point_amplitude(point, index)
        if selected is None or amplitude > selected[2]:
            selected = (index, point, amplitude)
    assert selected is not None
    if selected[2] <= 0.0:
        fail("response sweep must contain a positive response peak")
    return selected


def linspace(start: float, stop: float, count: int) -> list[float]:
    if count == 1:
        return [start]
    step = (stop - start) / float(count - 1)
    return [start + step * index for index in range(count)]


def refinement_recommendation(points: list[dict], peak_position_index: int) -> dict:
    frequency_hz = [
        finite_number(point.get("frequency_hz"), f"sweep.points[{index}].frequency_hz")
        for index, point in enumerate(points)
    ]
    count = 5
    if len(frequency_hz) < 2:
        return {
            "schema_version": "frequency_response_peak_refinement.v1",
            "strategy": "local_peak_window",
            "peak_position": "single_point",
            "recommended_frequency_count": 0,
            "frequency_spacing_hz": None,
            "recommended_frequencies_hz": [],
        }
    peak_frequency = frequency_hz[peak_position_index]
    if peak_position_index == 0:
        spacing = abs(frequency_hz[1] - frequency_hz[0])
        start = max(0.0, peak_frequency - 2.0 * spacing)
        stop = peak_frequency
        peak_position = "lower_boundary"
    elif peak_position_index == len(frequency_hz) - 1:
        spacing = abs(frequency_hz[-1] - frequency_hz[-2])
        start = peak_frequency
        stop = peak_frequency + 2.0 * spacing
        peak_position = "upper_boundary"
    else:
        left_spacing = abs(peak_frequency - frequency_hz[peak_position_index - 1])
        right_spacing = abs(frequency_hz[peak_position_index + 1] - peak_frequency)
        spacing = min(left_spacing, right_spacing)
        start = max(0.0, peak_frequency - 0.5 * spacing)
        stop = peak_frequency + 0.5 * spacing
        peak_position = "interior"
    return {
        "schema_version": "frequency_response_peak_refinement.v1",
        "strategy": "local_peak_window",
        "peak_position": peak_position,
        "recommended_frequency_count": count,
        "frequency_spacing_hz": spacing,
        "recommended_frequencies_hz": linspace(start, stop, count),
    }


def derive_peak_mode(root: Path, output_path: Path) -> dict:
    sweep = load_json(root / "response" / "magnetic_response_sweep.v2.json")
    points_value = sweep.get("points")
    if not isinstance(points_value, list):
        fail("sweep.points must be a list")
    fallback_index, peak, amplitude = select_peak(points_value)
    frequency_index = peak.get("frequency_index")
    if not isinstance(frequency_index, int):
        frequency_index = fallback_index
    frequency_hz = finite_number(peak.get("frequency_hz"), "peak.frequency_hz")
    point_path = non_empty_string(
        peak.get("frequency_point_artifact_path"),
        "peak.frequency_point_artifact_path",
    )
    field_payload_path = non_empty_string(
        peak.get("response_field_payload_path"),
        "peak.response_field_payload_path",
    )
    if not (root / field_payload_path).is_file():
        fail(f"peak response field payload is missing: {field_payload_path}")
    if not (root / point_path).is_file():
        fail(f"peak frequency point artifact is missing: {point_path}")
    provenance = {
        "schema_version": "frequency_response_derived_mode_provenance.v1",
        "canonical_product": "frequency_response",
        "source_artifact_path": "response/magnetic_response_sweep.v2.json",
        "source_schema_version": sweep.get("schema_version"),
        "derivation_method": "select_max_response_amplitude",
        "selection_metric": point_amplitude_source(peak),
        "selected_sweep_point_index": fallback_index,
        "selected_frequency_index": frequency_index,
        "selected_frequency_hz": frequency_hz,
        "selected_response_amplitude": amplitude,
        "selected_frequency_point_artifact_path": point_path,
        "selected_field_payload_path": field_payload_path,
        "not_an_eigenmode": True,
    }
    payload = {
        "schema_version": "frequency_response_derived_mode.v1",
        "source": "magnetic_response_sweep.v2",
        "selection": "max_response_amplitude",
        "mode_label": "driven_response_peak_0000",
        "frequency_index": frequency_index,
        "frequency_hz": frequency_hz,
        "response_amplitude": amplitude,
        "frequency_point_artifact_path": point_path,
        "field_payload_path": field_payload_path,
        "interpretation": "driven_response_field_at_peak_frequency",
        "provenance": provenance,
        "refinement_recommendation": refinement_recommendation(
            points_value,
            fallback_index,
        ),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    return payload


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")
    output_path = (
        Path(sys.argv[2])
        if len(sys.argv) > 2
        else root / "response" / "derived_modes" / "fmr_peak_mode.v1.json"
    )
    payload = derive_peak_mode(root, output_path)
    print(
        f"derived FMR peak mode: index={payload['frequency_index']} "
        f"frequency_hz={payload['frequency_hz']:.12g} "
        f"amplitude={payload['response_amplitude']:.12g}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
