"""Compare explicitly supplied +k and -k numeric spectra as a diagnostic only.

This helper is limited to caller-asserted symmetric reciprocal A1 benchmark
pairs. It does not load artifacts, validate either bundle's provenance, track
eigenvectors, or qualify a solver. The caller must validate the negative bundle
provenance and the benchmark's applicability before invoking it.

Only the lowest positive-real-frequency bands are compared. Each side is sorted
by (real frequency, imaginary frequency), and ranks are compared as a complex
frequency multiset with multiplicity preserved. Raw solver indices are carried
through for audit only; they never participate in matching.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Any


SIGNED_K_VECTOR_RELATIVE_TOLERANCE = 1.0e-8
DEFAULT_TARGET_BAND_COUNT = 8
REPORT_SCHEMA = "fullmag.comsol-signed-k-frequency-replay.v1"


def _is_sequence(value: object) -> bool:
    return isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray))


def _finite_number(value: object, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label} must be a finite number")
    try:
        converted = float(value)
    except (OverflowError, ValueError):
        raise ValueError(f"{label} must be a finite number") from None
    if not math.isfinite(converted):
        raise ValueError(f"{label} must be a finite number")
    return converted


def _nonnegative_integer(value: object, label: str) -> int:
    if type(value) is not int or value < 0:
        raise ValueError(f"{label} must be a non-negative integer")
    return value


def _relative_error(actual: float, expected: float) -> float:
    scale = max(abs(actual), abs(expected))
    if scale == 0.0:
        return 0.0
    # Normalize before subtracting so finite extreme values cannot overflow.
    return abs(actual / scale - expected / scale)


def _validate_k_vector(value: object, label: str) -> list[float]:
    if not _is_sequence(value) or len(value) != 3:
        raise ValueError(f"{label} must contain exactly three finite components")
    return [_finite_number(component, f"{label}[{axis}]") for axis, component in enumerate(value)]


def _validate_samples(
    samples: object,
    side: str,
    target_band_count: int,
) -> dict[int, dict[str, Any]]:
    if not _is_sequence(samples) or not samples:
        raise ValueError(f"{side} samples must be a non-empty sequence")
    indexed: dict[int, dict[str, Any]] = {}
    for sequence_index, sample in enumerate(samples):
        label = f"{side} samples[{sequence_index}]"
        if not isinstance(sample, Mapping):
            raise ValueError(f"{label} must be a mapping")
        sample_index = _nonnegative_integer(sample.get("sample_index"), f"{label}.sample_index")
        if sample_index in indexed:
            raise ValueError(f"{side} samples contain duplicate sample_index {sample_index}")
        k_vector = _validate_k_vector(sample.get("k_vector"), f"{label}.k_vector")
        raw_modes = sample.get("modes")
        if not _is_sequence(raw_modes):
            raise ValueError(f"{label}.modes must be a sequence")

        seen_raw_indices: set[int] = set()
        positive_modes: list[dict[str, float | int]] = []
        for mode_index, mode in enumerate(raw_modes):
            mode_label = f"{label}.modes[{mode_index}]"
            if not isinstance(mode, Mapping):
                raise ValueError(f"{mode_label} must be a mapping")
            raw_mode_index = _nonnegative_integer(
                mode.get("raw_mode_index"),
                f"{mode_label}.raw_mode_index",
            )
            if raw_mode_index in seen_raw_indices:
                raise ValueError(
                    f"{label} contains duplicate raw_mode_index {raw_mode_index}"
                )
            seen_raw_indices.add(raw_mode_index)
            frequency_real_hz = _finite_number(
                mode.get("frequency_real_hz"),
                f"{mode_label}.frequency_real_hz",
            )
            frequency_imag_hz = _finite_number(
                mode.get("frequency_imag_hz"),
                f"{mode_label}.frequency_imag_hz",
            )
            if frequency_real_hz > 0.0:
                positive_modes.append(
                    {
                        "raw_mode_index": raw_mode_index,
                        "frequency_real_hz": frequency_real_hz,
                        "frequency_imag_hz": frequency_imag_hz,
                    }
                )

        if len(positive_modes) < target_band_count:
            raise ValueError(
                f"{label} has {len(positive_modes)} positive-real-frequency modes; "
                f"at least {target_band_count} are required"
            )
        positive_modes.sort(
            key=lambda mode: (mode["frequency_real_hz"], mode["frequency_imag_hz"])
        )
        indexed[sample_index] = {
            "sample_index": sample_index,
            "k_vector": k_vector,
            "modes": positive_modes,
            "positive_frequency_mode_count": len(positive_modes),
            "raw_mode_count": len(raw_modes),
        }
    return indexed


def replay_signed_k_spectra(
    positive_samples: Sequence[Mapping[str, Any]],
    negative_samples: Sequence[Mapping[str, Any]],
    *,
    relative_tolerance: float,
    target_band_count: int = DEFAULT_TARGET_BAND_COUNT,
) -> dict[str, Any]:
    """Compare independently supplied +k and -k spectra without mode tracking.

    relative_tolerance is a caller-supplied, positive finite threshold applied
    independently to each real and imaginary frequency component. There is
    intentionally no default comparison tolerance. The established signed-k
    component check uses a separate fixed relative tolerance of 1e-8.

    Structural defects (including incomplete sample coverage or a wrong signed
    path) raise ValueError. A well-formed spectrum whose frequencies exceed the
    caller's tolerance returns a report with status == fail and measured errors.

    The report is diagnostic only. It cannot establish cross-run physical mode
    identity or solver qualification. Bundle provenance, complete expected
    sample-path coverage, and A1 reciprocal applicability must be validated by
    the caller; this helper enforces exact sample-index set equality between
    its two supplied sequences only.
    """
    if type(target_band_count) is not int or target_band_count <= 0:
        raise ValueError("target_band_count must be a positive integer")
    tolerance = _finite_number(relative_tolerance, "relative_tolerance")
    if tolerance <= 0.0:
        raise ValueError("relative_tolerance must be positive and finite")

    positive = _validate_samples(positive_samples, "positive", target_band_count)
    negative = _validate_samples(negative_samples, "negative", target_band_count)
    positive_indices = set(positive)
    negative_indices = set(negative)
    if positive_indices != negative_indices:
        missing_negative = sorted(positive_indices - negative_indices)
        missing_positive = sorted(negative_indices - positive_indices)
        raise ValueError(
            "positive and negative sample_index coverage differs "
            f"(missing negative={missing_negative}, missing positive={missing_positive})"
        )

    sample_reports: list[dict[str, Any]] = []
    all_relative_errors: list[float] = []
    for sample_index in sorted(positive_indices):
        positive_sample = positive[sample_index]
        negative_sample = negative[sample_index]
        positive_k = positive_sample["k_vector"]
        negative_k = negative_sample["k_vector"]
        signed_k_residuals: list[float] = []
        for axis, (positive_component, negative_component) in enumerate(
            zip(positive_k, negative_k)
        ):
            scale = max(1.0, abs(positive_component))
            residual = abs(positive_component / scale + negative_component / scale)
            signed_k_residuals.append(residual)
            if residual > SIGNED_K_VECTOR_RELATIVE_TOLERANCE:
                raise ValueError(
                    f"sample_index {sample_index} k_vector component {axis} is not "
                    "the negative of the positive sample within the established "
                    f"{SIGNED_K_VECTOR_RELATIVE_TOLERANCE:g} relative tolerance"
                )

        band_reports: list[dict[str, Any]] = []
        sample_relative_errors: list[float] = []
        for rank, (positive_mode, negative_mode) in enumerate(
            zip(
                positive_sample["modes"][:target_band_count],
                negative_sample["modes"][:target_band_count],
            ),
            start=1,
        ):
            real_error = _relative_error(
                positive_mode["frequency_real_hz"],
                negative_mode["frequency_real_hz"],
            )
            imag_error = _relative_error(
                positive_mode["frequency_imag_hz"],
                negative_mode["frequency_imag_hz"],
            )
            maximum_error = max(real_error, imag_error)
            within_tolerance = maximum_error <= tolerance
            sample_relative_errors.append(maximum_error)
            all_relative_errors.append(maximum_error)
            band_reports.append(
                {
                    "rank": rank,
                    "positive_raw_mode_index": positive_mode["raw_mode_index"],
                    "negative_raw_mode_index": negative_mode["raw_mode_index"],
                    "positive_frequency_real_hz": positive_mode["frequency_real_hz"],
                    "negative_frequency_real_hz": negative_mode["frequency_real_hz"],
                    "positive_frequency_imag_hz": positive_mode["frequency_imag_hz"],
                    "negative_frequency_imag_hz": negative_mode["frequency_imag_hz"],
                    "relative_error_real": real_error,
                    "relative_error_imag": imag_error,
                    "maximum_relative_error": maximum_error,
                    "within_tolerance": within_tolerance,
                }
            )

        sample_maximum_error = max(sample_relative_errors, default=0.0)
        sample_reports.append(
            {
                "sample_index": sample_index,
                "positive_k_vector": positive_k,
                "negative_k_vector": negative_k,
                "maximum_signed_k_component_residual": max(signed_k_residuals, default=0.0),
                "positive_raw_mode_count": positive_sample["raw_mode_count"],
                "negative_raw_mode_count": negative_sample["raw_mode_count"],
                "positive_frequency_mode_count": positive_sample["positive_frequency_mode_count"],
                "negative_frequency_mode_count": negative_sample["positive_frequency_mode_count"],
                "compared_band_count": target_band_count,
                "maximum_relative_error": sample_maximum_error,
                "status": "pass" if sample_maximum_error <= tolerance else "fail",
                "bands": band_reports,
            }
        )

    maximum_relative_error = max(all_relative_errors, default=0.0)
    status = "pass" if maximum_relative_error <= tolerance else "fail"
    paired_sample_count = len(sample_reports)
    return {
        "schema": REPORT_SCHEMA,
        "status": status,
        "diagnostic_only": True,
        "qualification": "NOT VERIFIED",
        "benchmark_scope": "caller_asserted_symmetric_reciprocal_A1_only",
        "comparison_basis": "lowest_positive_complex_frequency_multiset_by_rank",
        "mode_identity": "not_established_across_runs",
        "raw_mode_indices": "preserved_for_audit_only_not_used_for_matching",
        "provenance_boundary": {
            "negative_bundle_provenance": "must_be_validated_by_caller_before_invocation",
            "positive_bundle_provenance": "must_be_validated_by_caller_before_invocation",
            "benchmark_applicability": "must_be_validated_by_caller_before_invocation",
            "sample_path_completeness": (
                "caller_must_supply_full_expected_sample_sets;_helper_enforces_exact_"
                "positive_negative_sample_index_set_equality"
            ),
        },
        "relative_tolerance": tolerance,
        "signed_k_vector_relative_tolerance": SIGNED_K_VECTOR_RELATIVE_TOLERANCE,
        "target_band_count": target_band_count,
        "coverage": {
            "positive_sample_count": len(positive),
            "negative_sample_count": len(negative),
            "paired_sample_count": paired_sample_count,
            "sample_indices": [sample["sample_index"] for sample in sample_reports],
            "complete": (
                len(positive) == len(negative) == paired_sample_count
                and positive_indices == negative_indices
            ),
            "target_band_coverage_complete": all(
                sample["compared_band_count"] == target_band_count
                for sample in sample_reports
            ),
        },
        "maximum_relative_error": maximum_relative_error,
        "samples": sample_reports,
    }
