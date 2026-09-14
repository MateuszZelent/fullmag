#!/usr/bin/env python3
"""Fail-closed scientific gate for the COMSOL-aligned FEM dispersion run.

The managed runner is responsible for source/runtime identity and for checking
that the expected files were written.  This module is the separate scientific
gate.  It consumes the numeric FEM artifacts, recomputes the analytic control
values from the canonical SI parameter file, and requires an explicitly
bound evidence bundle for the mesh, airbox, and requested-mode-count checks.

An analytic reference is allowed as a comparison oracle, but it can never be
accepted as the source of the FEM frequencies.  Missing or incomplete evidence
is reported as ``NOT VERIFIED`` rather than being inferred from file presence.
"""

from __future__ import annotations

import csv
import hashlib
import json
import math
from pathlib import Path
from typing import Any, Mapping, Sequence

from verify_fem_frequency_domain_eigen_artifacts import (
    kalinikos_slab_n0_frequency_hz,
)


GATE_SCHEMA = "fullmag.comsol-dispersion-scientific-gate.v1"
EVIDENCE_SCHEMA = "fullmag.comsol-dispersion-scientific-evidence.v1"
EVIDENCE_RELATIVE_PATH = Path("validation/scientific_gate.v1.json")
EXPECTED_CASES = ("c0", "c1", "a1")
PATH_CASES = frozenset(("c1", "a1"))
EXPECTED_PATH_SAMPLE_COUNT = 61
EXPECTED_TARGET_BANDS = 8
EXPECTED_CONTROL_SAMPLES = (0, 10, 20, 30, 40, 50, 60)
KITTEL_RELATIVE_TOLERANCE = 1.0e-3
KS_RELATIVE_TOLERANCE = 2.0e-2
CONVERGENCE_RELATIVE_TOLERANCE = 5.0e-3
_REQUIRED_ARTIFACTS = (
    Path("eigen/spectrum.v2.json"),
    Path("eigen/branches.v2.json"),
    Path("eigen/dispersion.csv"),
    Path("frequency_domain/manifest.v1.json"),
)


class ScientificGateError(RuntimeError):
    """Raised only for invalid direct API arguments, never for failed gates."""


def _finite(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _finite_positive(value: object) -> bool:
    return _finite(value) and float(value) > 0.0


def _relative_error(actual: float, expected: float) -> float:
    scale = max(abs(actual), abs(expected), 1.0e-30)
    return abs(actual - expected) / scale


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_json(path: Path) -> tuple[dict[str, Any] | None, str | None]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as error:
        return None, f"cannot read valid JSON from {path}: {error}"
    if not isinstance(value, dict):
        return None, f"JSON root must be an object: {path}"
    return value, None


def _nested(value: Mapping[str, Any], *keys: str) -> object:
    current: object = value
    for key in keys:
        if not isinstance(current, Mapping):
            return None
        current = current.get(key)
    return current


def _number(value: object, label: str, reasons: list[str]) -> float | None:
    if not _finite(value):
        reasons.append(f"{label} is missing or non-finite")
        return None
    return float(value)


def _path_rows(kpath_path: Path) -> tuple[dict[int, tuple[float, float, float]], list[str]]:
    expected: dict[int, tuple[float, float, float]] = {}
    reasons: list[str] = []
    try:
        with kpath_path.open("r", encoding="utf-8-sig", newline="") as stream:
            for row in csv.DictReader(stream):
                try:
                    index = int(row["jpath"])
                    vector = tuple(float(row[key]) for key in ("kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m"))
                except (KeyError, TypeError, ValueError) as error:
                    reasons.append(f"canonical k-path contains an invalid row: {error}")
                    continue
                if len(vector) != 3 or not all(math.isfinite(item) for item in vector):
                    reasons.append(f"canonical k-path sample {index} is non-finite")
                    continue
                expected[index] = vector  # type: ignore[assignment]
    except OSError as error:
        reasons.append(f"cannot read canonical k-path {kpath_path}: {error}")
    return expected, reasons


def _load_parameters(parameters_path: Path) -> tuple[dict[str, Any] | None, list[str]]:
    value, error = _load_json(parameters_path)
    if error:
        return None, [error]
    assert value is not None
    required = (
        ("geometry", "film_thickness_m"),
        ("material", "Ms_A_per_m"),
        ("material", "Aex_J_per_m"),
        ("material", "mu0_H_per_m"),
        ("material", "gamma0_m_per_A_s"),
        ("bias_H_A_per_m",),
        ("controls_infinite_film_hz", "no_demag_gamma"),
        ("controls_finite_dirichlet_box", "with_demag_gamma_hz"),
    )
    reasons = []
    for keys in required:
        if _nested(value, *keys) is None:
            reasons.append(f"canonical parameters are missing {'.'.join(keys)}")
    return value, reasons


def _kalinikos_frequency_hz(
    k: float,
    geometry: str,
    parameters: Mapping[str, Any],
) -> float | None:
    thickness = _nested(parameters, "geometry", "film_thickness_m")
    ms = _nested(parameters, "material", "Ms_A_per_m")
    aex = _nested(parameters, "material", "Aex_J_per_m")
    mu0 = _nested(parameters, "material", "mu0_H_per_m")
    gamma0 = _nested(parameters, "material", "gamma0_m_per_A_s")
    bias = _nested(parameters, "bias_H_A_per_m", 0)
    if not all(_finite(value) for value in (k, thickness, ms, aex, mu0, gamma0, bias)):
        return None
    if geometry not in {"backward_volume", "damon_eshbach"} or k < 0.0:
        return None
    try:
        return float(
            kalinikos_slab_n0_frequency_hz(
                k_norm=k,
                geometry=geometry,
                bias_field_a_per_m=float(bias),
                film_thickness_m=float(thickness),
                exchange_stiffness_j_per_m=float(aex),
                saturation_magnetisation_a_per_m=float(ms),
                gamma0_rad_s_per_a_m=float(gamma0),
            )
        )
    except (ValueError, SystemExit):
        return None


def _new_check(status: str, **values: Any) -> dict[str, Any]:
    return {"status": status, **values}


def _artifact_map(case_dir: Path) -> tuple[dict[Path, dict[str, Any]], list[str]]:
    artifacts: dict[Path, dict[str, Any]] = {}
    reasons: list[str] = []
    for relative in _REQUIRED_ARTIFACTS:
        path = case_dir / relative
        if not path.is_file():
            reasons.append(f"missing required artifact: {relative.as_posix()}")
            continue
        if path.stat().st_size <= 0:
            reasons.append(f"required artifact is empty: {relative.as_posix()}")
            continue
        artifacts[relative] = {"sha256": _sha256(path), "size": path.stat().st_size}
    return artifacts, reasons


def _sample_frequency(sample: Mapping[str, Any], raw_mode_index: int | None = None) -> float | None:
    modes = sample.get("modes")
    if not isinstance(modes, list):
        return None
    candidates = modes
    if raw_mode_index is not None:
        candidates = [mode for mode in modes if isinstance(mode, Mapping) and mode.get("raw_mode_index", mode.get("index")) == raw_mode_index]
    values = []
    for mode in candidates:
        if not isinstance(mode, Mapping):
            continue
        frequency = mode.get("frequency_real_hz", mode.get("frequency_hz"))
        if _finite_positive(frequency):
            values.append(float(frequency))
    return min(values) if values else None


def _validate_spectrum(
    spectrum: Mapping[str, Any],
    case: str,
    expected_path: Mapping[int, tuple[float, float, float]],
    reasons: list[str],
) -> tuple[dict[int, dict[str, Any]], dict[tuple[int, int], float]]:
    samples = spectrum.get("samples")
    sample_map: dict[int, dict[str, Any]] = {}
    mode_map: dict[tuple[int, int], float] = {}
    if not isinstance(samples, list):
        reasons.append("spectrum.samples is missing or is not an array")
        return sample_map, mode_map
    expected_count = 1 if case == "c0" else EXPECTED_PATH_SAMPLE_COUNT
    if len(samples) != expected_count:
        reasons.append(f"{case} requires {expected_count} spectrum samples, found {len(samples)}")
    declared_count = spectrum.get("sample_count")
    if declared_count != len(samples):
        reasons.append("spectrum.sample_count does not match the serialized sample array")
    for sample in samples:
        if not isinstance(sample, Mapping):
            reasons.append("spectrum contains a non-object sample")
            continue
        index = sample.get("sample_index")
        if not isinstance(index, int) or isinstance(index, bool):
            reasons.append("spectrum sample has no integer sample_index")
            continue
        if index in sample_map:
            reasons.append(f"spectrum contains duplicate sample_index {index}")
            continue
        sample_map[index] = dict(sample)
        vector = sample.get("k_vector")
        if not isinstance(vector, list) or len(vector) != 3 or not all(_finite(item) for item in vector):
            reasons.append(f"spectrum sample {index} has a missing or non-finite k_vector")
        elif case in PATH_CASES and index in expected_path:
            expected = expected_path[index]
            if any(abs(float(actual) - wanted) > 1.0e-8 * max(1.0, abs(wanted)) for actual, wanted in zip(vector, expected)):
                reasons.append(f"spectrum sample {index} k_vector does not match the canonical 61-point k-path")
        modes = sample.get("modes")
        if not isinstance(modes, list) or not modes:
            reasons.append(f"spectrum sample {index} has no modes")
            continue
        for mode in modes:
            if not isinstance(mode, Mapping):
                reasons.append(f"spectrum sample {index} contains a non-object mode")
                continue
            raw = mode.get("raw_mode_index", mode.get("index"))
            if not isinstance(raw, int) or isinstance(raw, bool) or raw < 0:
                reasons.append(f"spectrum sample {index} contains a mode without a valid raw_mode_index")
                continue
            frequency = mode.get("frequency_real_hz", mode.get("frequency_hz"))
            imag = mode.get("frequency_imag_hz", 0.0)
            if not _finite(frequency) or not _finite(imag):
                reasons.append(f"spectrum sample {index} mode {raw} has a non-finite frequency")
                continue
            mode_map[(index, raw)] = float(frequency)
    expected_indices = {0} if case == "c0" else set(range(EXPECTED_PATH_SAMPLE_COUNT))
    if set(sample_map) != expected_indices:
        reasons.append(f"spectrum sample indices are {sorted(sample_map)}, expected {sorted(expected_indices)}")
    return sample_map, mode_map


def _validate_branches(
    branches: Mapping[str, Any],
    case: str,
    mode_map: Mapping[tuple[int, int], float],
    reasons: list[str],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    values = branches.get("branches")
    if not isinstance(values, list):
        reasons.append("branches.branches is missing or is not an array")
        return [], _new_check("fail", branch_count=0, target_band_count=0)
    parsed: list[dict[str, Any]] = []
    for branch in values:
        if not isinstance(branch, Mapping):
            reasons.append("branches contains a non-object branch")
            continue
        branch_id = branch.get("branch_id")
        points = branch.get("points")
        if not isinstance(branch_id, int) or isinstance(branch_id, bool) or not isinstance(points, list):
            reasons.append("branch is missing an integer branch_id or points array")
            continue
        parsed.append(dict(branch))
    parsed.sort(key=lambda item: int(item["branch_id"]))
    expected_indices = {0} if case == "c0" else set(range(EXPECTED_PATH_SAMPLE_COUNT))
    target = 1 if case == "c0" else EXPECTED_TARGET_BANDS
    complete: list[dict[str, Any]] = []
    for branch in parsed:
        branch_id = int(branch["branch_id"])
        point_map: dict[int, Mapping[str, Any]] = {}
        for point in branch["points"]:
            if not isinstance(point, Mapping):
                reasons.append(f"branch {branch_id} contains a non-object point")
                continue
            index = point.get("sample_index")
            if not isinstance(index, int) or isinstance(index, bool):
                reasons.append(f"branch {branch_id} contains a point without integer sample_index")
                continue
            if index in point_map:
                reasons.append(f"branch {branch_id} contains duplicate sample_index {index}")
                continue
            point_map[index] = point
            frequency = point.get("frequency_real_hz", point.get("frequency_hz"))
            imag = point.get("frequency_imag_hz", 0.0)
            if not _finite_positive(frequency) or not _finite(imag):
                reasons.append(f"branch {branch_id} sample {index} has a non-finite or non-positive frequency")
            raw = point.get("raw_mode_index")
            if isinstance(raw, int) and (index, raw) in mode_map and _finite(frequency):
                if _relative_error(float(frequency), mode_map[(index, raw)]) > 1.0e-9:
                    reasons.append(f"branch {branch_id} sample {index} disagrees with spectrum for raw mode {raw}")
        if set(point_map) == expected_indices:
            complete.append(branch)
    if len(complete) < target:
        reasons.append(f"only {len(complete)} complete tracked branches are available; {target} are required")
    selected = complete[:target]
    return selected, _new_check(
        "pass" if len(selected) == target else "fail",
        branch_count=len(parsed),
        complete_branch_count=len(complete),
        target_band_count=target,
        sample_count=(1 if case == "c0" else EXPECTED_PATH_SAMPLE_COUNT),
        selected_branch_ids=[int(branch["branch_id"]) for branch in selected],
    )


def _validate_dispersion_csv(path: Path, case: str, reasons: list[str]) -> dict[str, Any]:
    expected_indices = {0} if case == "c0" else set(range(EXPECTED_PATH_SAMPLE_COUNT))
    counts: dict[int, int] = {}
    rows = 0
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            fieldnames = set(reader.fieldnames or ())
            required = {"sample_index", "kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m"}
            frequency_key = "frequency_hz" if "frequency_hz" in fieldnames else "frequency_real_hz"
            missing = sorted(required - fieldnames)
            if frequency_key not in fieldnames:
                missing.append("frequency_hz or frequency_real_hz")
            if missing:
                reasons.append(f"dispersion.csv is missing columns: {', '.join(missing)}")
                return _new_check("fail", rows=0, sample_count=0, samples=[])
            for row in reader:
                rows += 1
                try:
                    index = int(row["sample_index"])
                except (TypeError, ValueError):
                    reasons.append(f"dispersion.csv row {rows} has an invalid sample_index")
                    continue
                counts[index] = counts.get(index, 0) + 1
                for key in ("kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m", frequency_key):
                    try:
                        value = float(row[key])
                    except (TypeError, ValueError):
                        value = math.nan
                    if not math.isfinite(value):
                        reasons.append(f"dispersion.csv row {rows} has a non-finite {key}")
                try:
                    if float(row[frequency_key]) <= 0.0:
                        reasons.append(f"dispersion.csv row {rows} has a non-positive frequency")
                except (TypeError, ValueError):
                    pass
    except (OSError, UnicodeError) as error:
        reasons.append(f"cannot read dispersion.csv: {error}")
    minimum_modes = 1 if case == "c0" else EXPECTED_TARGET_BANDS
    for index in sorted(expected_indices):
        if counts.get(index, 0) < minimum_modes:
            reasons.append(f"dispersion.csv sample {index} has {counts.get(index, 0)} rows; {minimum_modes} are required")
    if set(counts) != expected_indices:
        reasons.append(f"dispersion.csv sample indices are {sorted(counts)}, expected {sorted(expected_indices)}")
    return _new_check(
        "pass" if not any("dispersion.csv" in reason for reason in reasons) else "fail",
        rows=rows,
        sample_count=len(counts),
        samples=sorted(counts),
        minimum_modes_per_sample=minimum_modes,
    )


def _validate_numeric_source(manifest: Mapping[str, Any], case: str, reasons: list[str]) -> dict[str, Any]:
    source = _nested(manifest, "validation", "dispersion_frequency_source")
    dynamic_source = _nested(manifest, "validation", "dynamic_demag_operator_source")
    solver_model = manifest.get("solver_model")
    if source == "analytic_reference_model" or (isinstance(solver_model, str) and "kalinikos" in solver_model.lower()):
        reasons.append("analytic reference is declared as the frequency source; it cannot qualify a FEM run")
    if case in {"c1", "a1"} and dynamic_source != "numeric_modal_solver":
        reasons.append("dynamic demagnetization source is not declared as numeric_modal_solver")
    if case in {"c1", "a1"} and source == "analytic_reference_model":
        reasons.append("numeric dynamic-demag evidence is replaced by the analytic reference")
    return _new_check(
        "pass" if not any("analytic reference" in reason or "dynamic demagnetization" in reason for reason in reasons) else "fail",
        frequency_source=source,
        dynamic_demag_operator_source=dynamic_source,
        solver_model=solver_model,
    )


def _validate_kittel(
    case: str,
    selected_branches: Sequence[Mapping[str, Any]],
    parameters: Mapping[str, Any],
    reasons: list[str],
) -> dict[str, Any]:
    if case == "a1":
        return _new_check("not_applicable", reason="the antidot breaks the homogeneous-film Kittel control; c0 and c1 must be supplied")
    if not selected_branches:
        reasons.append(f"{case} Kittel control has no selected numeric branch")
        return _new_check("fail")
    point = next((point for point in selected_branches[0].get("points", []) if isinstance(point, Mapping) and point.get("sample_index") == 0), None)
    observed = point.get("frequency_real_hz", point.get("frequency_hz")) if isinstance(point, Mapping) else None
    expected_key = "no_demag_gamma" if case == "c0" else "with_demag_gamma_hz"
    expected = _nested(parameters, "controls_infinite_film_hz", expected_key) if case == "c0" else _nested(parameters, "controls_finite_dirichlet_box", expected_key)
    if not _finite_positive(observed) or not _finite_positive(expected):
        reasons.append(f"{case} Kittel control lacks finite positive observed/expected frequency")
        return _new_check("fail", observed_frequency_hz=observed, expected_frequency_hz=expected)
    relative_error = _relative_error(float(observed), float(expected))
    if relative_error > KITTEL_RELATIVE_TOLERANCE:
        reasons.append(f"{case} Kittel relative error {relative_error:.6g} exceeds {KITTEL_RELATIVE_TOLERANCE:.6g}")
    return _new_check(
        "pass" if relative_error <= KITTEL_RELATIVE_TOLERANCE else "fail",
        observed_frequency_hz=float(observed),
        expected_frequency_hz=float(expected),
        relative_error=relative_error,
        tolerance=KITTEL_RELATIVE_TOLERANCE,
    )


def _validate_ks(
    case: str,
    evidence: Mapping[str, Any] | None,
    parameters: Mapping[str, Any],
    reasons: list[str],
) -> dict[str, Any]:
    if case != "c1":
        return _new_check("not_applicable", reason="the homogeneous slab KS control is applicable to c1 only")
    controls = evidence.get("analytic_controls") if isinstance(evidence, Mapping) else None
    ks = controls.get("kalinikos_slab_n0") if isinstance(controls, Mapping) else None
    if not isinstance(ks, Mapping):
        reasons.append("missing analytic_controls.kalinikos_slab_n0 evidence for c1")
        return _new_check("missing")
    samples = ks.get("samples")
    if not isinstance(samples, list):
        reasons.append("Kalinikos–Slavin evidence has no samples array")
        return _new_check("fail")
    geometries: set[str] = set()
    errors: list[float] = []
    for index, sample in enumerate(samples):
        if not isinstance(sample, Mapping):
            reasons.append(f"Kalinikos–Slavin sample {index} is not an object")
            continue
        geometry = sample.get("geometry")
        k = sample.get("k_rad_per_m")
        observed = sample.get("observed_frequency_hz")
        expected = _kalinikos_frequency_hz(float(k), geometry, parameters) if _finite(k) and isinstance(geometry, str) else None
        if geometry not in {"backward_volume", "damon_eshbach"}:
            reasons.append(f"Kalinikos–Slavin sample {index} has unsupported geometry {geometry!r}")
            continue
        geometries.add(geometry)
        if not _finite_positive(observed) or not _finite_positive(expected):
            reasons.append(f"Kalinikos–Slavin sample {index} lacks finite positive observed/reference frequency")
            continue
        error = _relative_error(float(observed), float(expected))
        errors.append(error)
        if error > KS_RELATIVE_TOLERANCE:
            reasons.append(f"Kalinikos–Slavin {geometry} sample {index} error {error:.6g} exceeds {KS_RELATIVE_TOLERANCE:.6g}")
    for geometry in ("backward_volume", "damon_eshbach"):
        if geometry not in geometries:
            reasons.append(f"Kalinikos–Slavin evidence is missing a {geometry} applicability sample")
    maximum = max(errors, default=math.inf)
    if not isinstance(ks.get("status"), str) or ks.get("status") != "pass":
        reasons.append("Kalinikos–Slavin evidence is not explicitly marked pass")
    return _new_check(
        "pass" if geometries == {"backward_volume", "damon_eshbach"} and errors and maximum <= KS_RELATIVE_TOLERANCE and ks.get("status") == "pass" else "fail",
        sample_count=len(samples),
        geometries=sorted(geometries),
        max_relative_error=maximum if math.isfinite(maximum) else None,
        tolerance=KS_RELATIVE_TOLERANCE,
    )


def _validate_convergence(
    evidence: Mapping[str, Any] | None,
    key: str,
    case: str,
    reasons: list[str],
) -> dict[str, Any]:
    convergence = evidence.get("convergence") if isinstance(evidence, Mapping) else None
    section = convergence.get(key) if isinstance(convergence, Mapping) else None
    if key == "airbox" and case == "c0":
        if isinstance(section, Mapping) and section.get("status") == "not_applicable" and isinstance(section.get("reason"), str) and section["reason"].strip():
            return _new_check("not_applicable", reason=section["reason"])
        reasons.append("c0 airbox convergence must be explicitly marked not_applicable with a reason")
        return _new_check("missing")
    if not isinstance(section, Mapping):
        reasons.append(f"missing convergence.{key} evidence")
        return _new_check("missing")
    if section.get("status") != "pass":
        reasons.append(f"convergence.{key} is not explicitly marked pass")
    comparisons = section.get("comparisons")
    if not isinstance(comparisons, list):
        reasons.append(f"convergence.{key}.comparisons is missing")
        return _new_check("fail")
    expected_pairs = {(sample, band) for sample in (EXPECTED_CONTROL_SAMPLES if case in PATH_CASES else (0,)) for band in range(EXPECTED_TARGET_BANDS if case in PATH_CASES else 1)}
    observed_pairs: set[tuple[int, int]] = set()
    errors: list[float] = []
    for index, comparison in enumerate(comparisons):
        if not isinstance(comparison, Mapping):
            reasons.append(f"convergence.{key} comparison {index} is not an object")
            continue
        sample = comparison.get("sample_index")
        band = comparison.get("band_index", comparison.get("branch_index"))
        reference = comparison.get("reference_frequency_hz", comparison.get("coarse_frequency_hz"))
        refined = comparison.get("refined_frequency_hz", comparison.get("fine_frequency_hz"))
        if not isinstance(sample, int) or not isinstance(band, int):
            reasons.append(f"convergence.{key} comparison {index} lacks integer sample/band indices")
            continue
        observed_pairs.add((sample, band))
        if not _finite_positive(reference) or not _finite_positive(refined):
            reasons.append(f"convergence.{key} comparison {index} lacks finite positive frequencies")
            continue
        error = _relative_error(float(reference), float(refined))
        errors.append(error)
        reported = comparison.get("relative_change")
        if reported is not None and (not _finite(reported) or abs(float(reported) - error) > 1.0e-9):
            reasons.append(f"convergence.{key} comparison {index} reports an inconsistent relative_change")
    missing = sorted(expected_pairs - observed_pairs)
    if missing:
        reasons.append(f"convergence.{key} is missing {len(missing)} required sample/band comparisons")
    maximum = max(errors, default=math.inf)
    if maximum > CONVERGENCE_RELATIVE_TOLERANCE:
        reasons.append(f"convergence.{key} maximum relative change {maximum:.6g} exceeds {CONVERGENCE_RELATIVE_TOLERANCE:.6g}")
    if key == "mode_count":
        if section.get("baseline_requested_modes") != 24 or section.get("check_requested_modes") != 48:
            reasons.append("mode-count convergence must compare requested modes 24 against 48")
    return _new_check(
        "pass" if section.get("status") == "pass" and not missing and errors and maximum <= CONVERGENCE_RELATIVE_TOLERANCE else "fail",
        comparison_count=len(comparisons),
        expected_comparison_count=len(expected_pairs),
        max_relative_change=maximum if math.isfinite(maximum) else None,
        tolerance=CONVERGENCE_RELATIVE_TOLERANCE,
    )


def _validate_evidence_binding(
    case_dir: Path,
    evidence: Mapping[str, Any] | None,
    artifacts: Mapping[Path, Mapping[str, Any]],
    case: str,
    reasons: list[str],
) -> dict[str, Any]:
    if evidence is None:
        reasons.append(f"missing scientific evidence bundle: {EVIDENCE_RELATIVE_PATH.as_posix()}")
        return _new_check("missing", path=EVIDENCE_RELATIVE_PATH.as_posix())
    if evidence.get("schema_version") != EVIDENCE_SCHEMA:
        reasons.append("scientific evidence bundle has an unsupported schema_version")
    if evidence.get("case_id") != case:
        reasons.append("scientific evidence bundle case_id does not match the output directory")
    numeric = evidence.get("numeric_run")
    if not isinstance(numeric, Mapping):
        reasons.append("scientific evidence is missing numeric_run provenance")
    else:
        if numeric.get("frequency_source") != "numeric_modal_solver":
            reasons.append("scientific evidence does not identify numeric_modal_solver as frequency source")
        if numeric.get("analytic_solver_used_for_frequencies") is not False:
            reasons.append("scientific evidence does not prove that the analytic solver was excluded from FEM frequencies")
        if case in {"c1", "a1"} and numeric.get("dynamic_demag_operator_source") != "numeric_modal_solver":
            reasons.append("scientific evidence does not identify numeric_modal_solver as dynamic-demag source")
    bindings = evidence.get("artifact_bindings")
    if not isinstance(bindings, Mapping):
        reasons.append("scientific evidence is missing artifact_bindings")
    else:
        expected_keys = {
            "eigen/spectrum.v2.json": "spectrum_v2_sha256",
            "eigen/branches.v2.json": "branches_v2_sha256",
            "eigen/dispersion.csv": "dispersion_csv_sha256",
            "frequency_domain/manifest.v1.json": "manifest_sha256",
        }
        for relative, key in expected_keys.items():
            actual = artifacts.get(Path(relative), {}).get("sha256")
            if bindings.get(key) != actual:
                reasons.append(f"scientific evidence binding does not match current {relative}")
    return _new_check("pass" if not any("scientific evidence" in reason or "binding" in reason for reason in reasons) else "fail", path=EVIDENCE_RELATIVE_PATH.as_posix())


def validate_case(
    case_dir: Path,
    case: str,
    *,
    parameters_path: Path,
    kpath_path: Path | None = None,
) -> dict[str, Any]:
    """Validate one numeric case and return a JSON-serializable gate report."""

    if case not in EXPECTED_CASES:
        raise ScientificGateError(f"unsupported benchmark case: {case}")
    reasons: list[str] = []
    artifacts, artifact_reasons = _artifact_map(case_dir)
    reasons.extend(artifact_reasons)
    parameters, parameter_reasons = _load_parameters(parameters_path)
    reasons.extend(parameter_reasons)
    expected_path: dict[int, tuple[float, float, float]] = {}
    if kpath_path is None:
        kpath_path = parameters_path.parent / "kpath.csv"
    if case in PATH_CASES:
        expected_path, path_reasons = _path_rows(kpath_path)
        reasons.extend(path_reasons)
        if len(expected_path) != EXPECTED_PATH_SAMPLE_COUNT:
            reasons.append(f"canonical k-path has {len(expected_path)} samples; {EXPECTED_PATH_SAMPLE_COUNT} are required")
    spectrum: dict[str, Any] = {}
    branches: dict[str, Any] = {}
    manifest: dict[str, Any] = {}
    if Path("eigen/spectrum.v2.json") in artifacts:
        spectrum, error = _load_json(case_dir / "eigen/spectrum.v2.json")
        if error:
            reasons.append(error)
            spectrum = {}
    if Path("eigen/branches.v2.json") in artifacts:
        branches, error = _load_json(case_dir / "eigen/branches.v2.json")
        if error:
            reasons.append(error)
            branches = {}
    if Path("frequency_domain/manifest.v1.json") in artifacts:
        manifest, error = _load_json(case_dir / "frequency_domain/manifest.v1.json")
        if error:
            reasons.append(error)
            manifest = {}
    sample_map: dict[int, dict[str, Any]] = {}
    mode_map: dict[tuple[int, int], float] = {}
    if spectrum:
        sample_map, mode_map = _validate_spectrum(spectrum, case, expected_path, reasons)
    selected_branches: list[dict[str, Any]] = []
    branch_check = _new_check("missing")
    if branches:
        selected_branches, branch_check = _validate_branches(branches, case, mode_map, reasons)
    csv_check = _new_check("missing")
    if Path("eigen/dispersion.csv") in artifacts:
        csv_check = _validate_dispersion_csv(case_dir / "eigen/dispersion.csv", case, reasons)
    source_check = _new_check("missing")
    if manifest:
        source_check = _validate_numeric_source(manifest, case, reasons)
    evidence: dict[str, Any] | None = None
    evidence_path = case_dir / EVIDENCE_RELATIVE_PATH
    if evidence_path.is_file():
        evidence, error = _load_json(evidence_path)
        if error:
            reasons.append(error)
            evidence = None
    evidence_check = _validate_evidence_binding(case_dir, evidence, artifacts, case, reasons)
    kittel_check = _validate_kittel(case, selected_branches, parameters or {}, reasons) if parameters else _new_check("missing")
    ks_check = _validate_ks(case, evidence, parameters or {}, reasons) if parameters else _new_check("missing")
    convergence = {
        key: _validate_convergence(evidence, key, case, reasons)
        for key in ("mesh", "airbox", "mode_count")
    }
    finite_check = _new_check(
        "pass" if not any("non-finite" in reason for reason in reasons) else "fail",
        sample_count=len(sample_map),
        mode_count=len(mode_map),
    )
    status = "qualified" if not reasons else "not_qualified"
    return {
        "schema_version": GATE_SCHEMA,
        "case_id": case,
        "status": status,
        "qualification": "QUALIFIED" if status == "qualified" else "NOT VERIFIED",
        "reasons": reasons,
        "checks": {
            "artifact_binding": evidence_check,
            "numeric_source": source_check,
            "finite_values": finite_check,
            "spectrum_samples": _new_check("pass" if len(sample_map) == (1 if case == "c0" else EXPECTED_PATH_SAMPLE_COUNT) else "fail", sample_count=len(sample_map)),
            "tracked_branches": branch_check,
            "dispersion_csv": csv_check,
            "kittel": kittel_check,
            "kalinikos_slab_n0": ks_check,
            "mesh_convergence": convergence["mesh"],
            "airbox_convergence": convergence["airbox"],
            "mode_count_convergence": convergence["mode_count"],
        },
        "artifact_bindings": artifacts,
        "evidence_path": EVIDENCE_RELATIVE_PATH.as_posix(),
        "parameters_path": str(parameters_path),
    }


def validate_requested_cases(case_results: Mapping[str, Mapping[str, Any]], cases: Sequence[str]) -> dict[str, Any]:
    """Combine case gates without allowing a partial case selection to qualify."""

    reasons: list[str] = []
    requested = tuple(cases)
    if requested != EXPECTED_CASES:
        reasons.append(f"complete COMSOL qualification requires cases {','.join(EXPECTED_CASES)}; requested {','.join(requested)}")
    for case in requested:
        result = case_results.get(case)
        if not isinstance(result, Mapping):
            reasons.append(f"scientific gate result is missing for case {case}")
        elif result.get("status") != "qualified":
            reasons.extend(f"{case}: {reason}" for reason in result.get("reasons", []) if isinstance(reason, str))
    status = "qualified" if not reasons else "not_qualified"
    return {
        "schema_version": GATE_SCHEMA,
        "status": status,
        "qualification": "QUALIFIED" if status == "qualified" else "NOT VERIFIED",
        "requested_cases": list(requested),
        "required_cases": list(EXPECTED_CASES),
        "reasons": reasons,
    }


def main(argv: Sequence[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("case_dir", type=Path)
    parser.add_argument("--case", required=True, choices=EXPECTED_CASES)
    parser.add_argument("--parameters", type=Path, required=True)
    parser.add_argument("--kpath", type=Path)
    args = parser.parse_args(argv)
    report = validate_case(args.case_dir, args.case, parameters_path=args.parameters, kpath_path=args.kpath)
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if report["status"] == "qualified" else 1


if __name__ == "__main__":
    raise SystemExit(main())
