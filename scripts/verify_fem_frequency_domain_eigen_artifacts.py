#!/usr/bin/env python3
"""Validate FEM frequency-domain modal eigen artifacts."""

from __future__ import annotations

import csv
import json
import math
import sys
from pathlib import Path


def fail(message: str) -> None:
    raise SystemExit(f"invalid frequency-domain eigen artifacts:\n{message}")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def require_file(path: Path) -> None:
    if not path.is_file():
        fail(f"missing required artifact: {path}")


def require_equal(actual: object, expected: object, name: str) -> None:
    if actual != expected:
        fail(f"{name}: got {actual!r}, expected {expected!r}")


def require_non_empty_string(value: object, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(f"{name} must be a non-empty string")
    return value


def require_finite_number(value: object, name: str) -> float:
    if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        fail(f"{name} must be a finite number")
    return float(value)


def require_non_negative_int(value: object, name: str) -> int:
    if not isinstance(value, int) or value < 0:
        fail(f"{name} must be a non-negative integer")
    return value


def require_object_list(value: object, name: str) -> list[dict]:
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        fail(f"{name} must be an object list")
    return value


def require_string_list(value: object, name: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        fail(f"{name} must be a string list")
    return value


def mode_field_id(sample_index: int, raw_mode_index: int) -> str:
    return f"analysis:eigen:sample-{sample_index:04d}:mode-{raw_mode_index:04d}"


def mode_field_resource_key(field_id: str) -> str:
    return (
        f"/v2/sessions/current/data/fields/{field_id}/samples/vector"
        "?view=phase_rotated_real&phase_rad=0"
    )


def mode_meta_resource_key(sample_index: int, raw_mode_index: int) -> str:
    return (
        "/v2/sessions/current/analysis/frequency-domain/eigen/"
        f"mode-field/{sample_index}/{raw_mode_index}/meta"
    )


def nested_mode_path(sample_index: int, raw_mode_index: int) -> str:
    return f"eigen/modes/sample_{sample_index:04d}/mode_{raw_mode_index:04d}.json"


def mode_payload_path(sample_index: int, raw_mode_index: int) -> str:
    return f"eigen/mode_fields/sample_{sample_index:04d}/mode_{raw_mode_index:04d}/vector.bin"


def require_mode_payload(root: Path, relative_path: str, name: str) -> None:
    path = root / relative_path
    require_file(path)
    size = path.stat().st_size
    if size <= 0:
        fail(f"{name} payload must not be empty")
    if size % 8 != 0:
        fail(f"{name} payload byte size must be divisible by 8")
    f64_count = size // 8
    if f64_count % 6 != 0:
        fail(f"{name} payload must contain complex xyz f64 tuples")


def require_mode_metadata_summaries(metadata: dict, metadata_path: str) -> None:
    for forbidden in ["real", "imag", "amplitude", "phase"]:
        if forbidden in metadata:
            fail(f"{metadata_path}.{forbidden} must not inline vector arrays")
    sample_count = require_non_negative_int(
        metadata.get("mode_field_sample_count"),
        f"{metadata_path}.mode_field_sample_count",
    )
    amplitude_summary = metadata.get("amplitude_summary")
    if not isinstance(amplitude_summary, dict):
        fail(f"{metadata_path}.amplitude_summary must be an object")
    require_equal(
        amplitude_summary.get("sample_count"),
        sample_count,
        f"{metadata_path}.amplitude_summary.sample_count",
    )
    component_summary = metadata.get("component_summary")
    if not isinstance(component_summary, dict):
        fail(f"{metadata_path}.component_summary must be an object")
    require_equal(
        component_summary.get("component_count"),
        3,
        f"{metadata_path}.component_summary.component_count",
    )
    require_equal(
        component_summary.get("real_sample_count"),
        sample_count,
        f"{metadata_path}.component_summary.real_sample_count",
    )
    require_equal(
        component_summary.get("imag_sample_count"),
        sample_count,
        f"{metadata_path}.component_summary.imag_sample_count",
    )


def validate_mode_summary(
    root: Path,
    mode: dict,
    sample_index: int,
    manifest_mode_paths: set[str],
    manifest_mode_resources: set[str],
) -> tuple[int, int]:
    raw_mode_index = require_non_negative_int(mode.get("raw_mode_index"), "mode.raw_mode_index")
    expected_field_id = mode_field_id(sample_index, raw_mode_index)
    expected_resource_key = mode_field_resource_key(expected_field_id)
    require_equal(mode.get("mode_field_id"), expected_field_id, "mode.mode_field_id")
    require_equal(
        mode.get("mode_field_resource_key"),
        expected_resource_key,
        "mode.mode_field_resource_key",
    )
    require_finite_number(mode.get("frequency_real_hz"), "mode.frequency_real_hz")
    require_finite_number(mode.get("frequency_imag_hz"), "mode.frequency_imag_hz")
    require_finite_number(
        mode.get("angular_frequency_rad_per_s"),
        "mode.angular_frequency_rad_per_s",
    )
    require_non_empty_string(mode.get("dominant_polarization"), "mode.dominant_polarization")

    metadata_path = nested_mode_path(sample_index, raw_mode_index)
    if manifest_mode_paths and metadata_path not in manifest_mode_paths:
        fail(f"manifest.artifacts.mode_metadata_paths missing {metadata_path}")
    metadata = load_json(root / metadata_path)
    require_equal(metadata.get("sample_index"), sample_index, f"{metadata_path}.sample_index")
    require_equal(
        metadata.get("raw_mode_index"),
        raw_mode_index,
        f"{metadata_path}.raw_mode_index",
    )
    require_equal(metadata.get("mode_field_id"), expected_field_id, f"{metadata_path}.mode_field_id")
    require_equal(
        metadata.get("mode_field_resource_key"),
        expected_resource_key,
        f"{metadata_path}.mode_field_resource_key",
    )
    require_mode_metadata_summaries(metadata, metadata_path)

    expected_meta_resource = mode_meta_resource_key(sample_index, raw_mode_index)
    if manifest_mode_resources and expected_meta_resource not in manifest_mode_resources:
        fail(f"manifest.resources.mode_field_resources missing {expected_meta_resource}")
    require_mode_payload(
        root,
        mode_payload_path(sample_index, raw_mode_index),
        f"mode {sample_index}/{raw_mode_index}",
    )
    return sample_index, raw_mode_index


def validate_dispersion(root: Path, known_modes: set[tuple[int, int]]) -> None:
    path = root / "eigen/dispersion.csv"
    require_file(path)
    rows = list(csv.DictReader(path.read_text().splitlines()))
    required_columns = {
        "sample_index",
        "path_s_rad_per_m",
        "kx_rad_per_m",
        "ky_rad_per_m",
        "kz_rad_per_m",
        "raw_mode_index",
        "frequency_hz",
        "omega_rad_s",
        "residual_norm",
    }
    missing = required_columns.difference(rows[0].keys() if rows else [])
    if missing:
        fail(f"eigen/dispersion.csv missing columns: {sorted(missing)!r}")
    for row_index, row in enumerate(rows):
        sample_index = require_non_negative_int(
            int(row["sample_index"]),
            f"dispersion row {row_index}.sample_index",
        )
        raw_mode_index = require_non_negative_int(
            int(row["raw_mode_index"]),
            f"dispersion row {row_index}.raw_mode_index",
        )
        if (sample_index, raw_mode_index) not in known_modes:
            fail(
                "eigen/dispersion.csv references unknown mode "
                f"sample={sample_index}, raw_mode={raw_mode_index}"
            )
        require_finite_number(float(row["frequency_hz"]), f"dispersion row {row_index}.frequency_hz")
        require_finite_number(float(row["omega_rad_s"]), f"dispersion row {row_index}.omega_rad_s")


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".fullmag/reports/eigen/artifacts")
    for relative_path in [
        "eigen/spectrum.v2.json",
        "eigen/branches.v2.json",
        "eigen/dispersion.csv",
        "frequency_domain/manifest.v1.json",
    ]:
        require_file(root / relative_path)

    spectrum = load_json(root / "eigen/spectrum.v2.json")
    branches = load_json(root / "eigen/branches.v2.json")
    manifest = load_json(root / "frequency_domain/manifest.v1.json")

    require_equal(spectrum.get("schema_version"), "eigen_spectrum.v2", "spectrum.schema_version")
    require_equal(branches.get("schema_version"), "eigen_branches.v2", "branches.schema_version")
    require_equal(
        manifest.get("schema_version"),
        "frequency_domain_manifest.v1",
        "manifest.schema_version",
    )
    require_equal(manifest.get("stage_kind"), "eigenmodes", "manifest.stage_kind")
    require_equal(
        manifest.get("artifacts", {}).get("spectrum_v2_path"),
        "eigen/spectrum.v2.json",
        "manifest.artifacts.spectrum_v2_path",
    )

    manifest_mode_paths = set(
        require_string_list(
            manifest.get("artifacts", {}).get("mode_metadata_paths"),
            "manifest.artifacts.mode_metadata_paths",
        )
    )
    manifest_mode_resources = set(
        require_string_list(
            manifest.get("resources", {}).get("mode_field_resources"),
            "manifest.resources.mode_field_resources",
        )
    )

    samples = require_object_list(spectrum.get("samples"), "spectrum.samples")
    require_equal(spectrum.get("sample_count"), len(samples), "spectrum.sample_count")
    known_modes: set[tuple[int, int]] = set()
    for sample_position, sample in enumerate(samples):
        sample_index = require_non_negative_int(
            sample.get("sample_index"),
            f"spectrum.samples[{sample_position}].sample_index",
        )
        require_finite_number(sample.get("path_s"), f"spectrum.samples[{sample_position}].path_s")
        modes = require_object_list(sample.get("modes"), f"spectrum.samples[{sample_position}].modes")
        for mode in modes:
            known_modes.add(
                validate_mode_summary(
                    root,
                    mode,
                    sample_index,
                    manifest_mode_paths,
                    manifest_mode_resources,
                )
            )
    if not known_modes:
        fail("spectrum.samples must include at least one mode")

    branch_modes: set[tuple[int, int]] = set()
    for branch_index, branch in enumerate(require_object_list(branches.get("branches"), "branches.branches")):
        require_non_negative_int(branch.get("branch_id"), f"branches[{branch_index}].branch_id")
        for point in require_object_list(branch.get("points"), f"branches[{branch_index}].points"):
            sample_index = require_non_negative_int(point.get("sample_index"), "branch point.sample_index")
            raw_mode_index = require_non_negative_int(
                point.get("raw_mode_index"),
                "branch point.raw_mode_index",
            )
            branch_modes.add((sample_index, raw_mode_index))
    unknown_branch_modes = branch_modes.difference(known_modes)
    if unknown_branch_modes:
        fail(f"branches reference unknown modes: {sorted(unknown_branch_modes)!r}")

    validate_dispersion(root, known_modes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
