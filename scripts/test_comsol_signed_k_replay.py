"""Contract tests for caller-supplied signed-k spectrum diagnostics."""

from __future__ import annotations

import copy
import math

import pytest

from comsol_signed_k_replay import replay_signed_k_spectra


def mode(raw_mode_index: int, real_hz: float, imag_hz: float = 0.0) -> dict[str, float | int]:
    return {
        "raw_mode_index": raw_mode_index,
        "frequency_real_hz": real_hz,
        "frequency_imag_hz": imag_hz,
    }


def sample(
    sample_index: int,
    k_vector: list[float],
    modes: list[dict[str, float | int]],
) -> dict[str, object]:
    return {
        "sample_index": sample_index,
        "k_vector": k_vector,
        "modes": modes,
    }


def test_distinct_raw_slots_and_degenerate_frequencies_preserve_multiplicity() -> None:
    positive = [
        sample(
            4,
            [2.0e6, 0.0, 0.0],
            [mode(91, 3.0e9), mode(8, 2.0e9), mode(31, 3.0e9)],
        )
    ]
    negative = [
        sample(
            4,
            [-2.0e6, 0.0, 0.0],
            [mode(700, 3.0e9), mode(14, 3.0e9), mode(2, 2.0e9)],
        )
    ]

    report = replay_signed_k_spectra(
        positive,
        negative,
        target_band_count=3,
        relative_tolerance=1.0e-12,
    )

    assert report["status"] == "pass"
    assert report["qualification"] == "NOT VERIFIED"
    assert report["mode_identity"] == "not_established_across_runs"
    assert report["coverage"]["complete"] is True
    bands = report["samples"][0]["bands"]
    assert [band["positive_frequency_real_hz"] for band in bands] == [
        2.0e9,
        3.0e9,
        3.0e9,
    ]
    assert [band["negative_frequency_real_hz"] for band in bands] == [
        2.0e9,
        3.0e9,
        3.0e9,
    ]
    assert {band["positive_raw_mode_index"] for band in bands} == {8, 31, 91}
    assert {band["negative_raw_mode_index"] for band in bands} == {2, 14, 700}
    assert all(band["within_tolerance"] for band in bands)


def test_frequency_mismatch_fails_with_rank_errors_and_original_raw_ids() -> None:
    positive = [
        sample(1, [1.0e6, 0.0, 0.0], [mode(55, 2.0e9), mode(9, 4.0e9)])
    ]
    negative = [
        sample(1, [-1.0e6, 0.0, 0.0], [mode(120, 2.0e9), mode(3, 4.2e9)])
    ]

    report = replay_signed_k_spectra(
        positive,
        negative,
        target_band_count=2,
        relative_tolerance=1.0e-3,
    )

    assert report["status"] == "fail"
    assert report["samples"][0]["status"] == "fail"
    assert report["samples"][0]["bands"][1]["positive_raw_mode_index"] == 9
    assert report["samples"][0]["bands"][1]["negative_raw_mode_index"] == 3
    assert report["samples"][0]["bands"][1]["relative_error_real"] > 1.0e-3


def test_imaginary_frequency_component_is_checked_too() -> None:
    report = replay_signed_k_spectra(
        [sample(2, [0.0, 1.0e6, 0.0], [mode(7, 3.0e9, -1.0e6)])],
        [sample(2, [0.0, -1.0e6, 0.0], [mode(19, 3.0e9, -1.1e6)])],
        target_band_count=1,
        relative_tolerance=1.0e-3,
    )

    assert report["status"] == "fail"
    band = report["samples"][0]["bands"][0]
    assert band["relative_error_real"] == 0.0
    assert band["relative_error_imag"] > 1.0e-3


def test_explicit_gamma_sample_is_paired_without_synthesizing_samples() -> None:
    positive = [
        sample(0, [0.0, 0.0, 0.0], [mode(50, 1.0e9), mode(6, 2.0e9)]),
        sample(3, [0.0, 2.0e6, 0.0], [mode(70, 1.5e9), mode(4, 2.5e9)]),
    ]
    negative = [
        sample(3, [0.0, -2.0e6, 0.0], [mode(14, 1.5e9), mode(29, 2.5e9)]),
        sample(0, [0.0, 0.0, 0.0], [mode(32, 1.0e9), mode(77, 2.0e9)]),
    ]

    report = replay_signed_k_spectra(
        positive,
        negative,
        target_band_count=2,
        relative_tolerance=1.0e-12,
    )

    assert report["status"] == "pass"
    assert report["coverage"]["sample_indices"] == [0, 3]
    assert report["coverage"]["paired_sample_count"] == 2
    assert report["samples"][0]["positive_k_vector"] == [0.0, 0.0, 0.0]
    assert report["samples"][0]["negative_k_vector"] == [0.0, 0.0, 0.0]


def test_default_band_count_is_eight_and_tolerance_has_no_default() -> None:
    positive_modes = [mode(100 + index, (index + 1) * 1.0e9) for index in range(8)]
    negative_modes = [mode(200 + index, (index + 1) * 1.0e9) for index in range(8)]

    report = replay_signed_k_spectra(
        [sample(0, [1.0, 0.0, 0.0], positive_modes)],
        [sample(0, [-1.0, 0.0, 0.0], negative_modes)],
        relative_tolerance=1.0e-12,
    )

    assert report["target_band_count"] == 8
    assert report["samples"][0]["compared_band_count"] == 8


def test_same_k_is_not_accepted_as_the_negative_path() -> None:
    with pytest.raises(ValueError, match="not the negative"):
        replay_signed_k_spectra(
            [sample(0, [1.0e6, 0.0, 0.0], [mode(1, 1.0e9)])],
            [sample(0, [1.0e6, 0.0, 0.0], [mode(2, 1.0e9)])],
            target_band_count=1,
            relative_tolerance=1.0e-8,
        )


def test_wrong_negative_path_is_rejected() -> None:
    with pytest.raises(ValueError, match="not the negative"):
        replay_signed_k_spectra(
            [sample(5, [1.0e6, 2.0e6, 0.0], [mode(1, 1.0e9)])],
            [sample(5, [-1.0e6, -1.9e6, 0.0], [mode(2, 1.0e9)])],
            target_band_count=1,
            relative_tolerance=1.0e-8,
        )


def test_missing_or_duplicate_sample_coverage_is_rejected() -> None:
    positive = [
        sample(0, [0.0, 0.0, 0.0], [mode(1, 1.0e9)]),
        sample(1, [1.0e6, 0.0, 0.0], [mode(2, 2.0e9)]),
    ]
    with pytest.raises(ValueError, match="coverage differs"):
        replay_signed_k_spectra(
            positive,
            [positive[0]],
            target_band_count=1,
            relative_tolerance=1.0e-8,
        )
    with pytest.raises(ValueError, match="duplicate sample_index"):
        replay_signed_k_spectra(
            [positive[0], copy.deepcopy(positive[0])],
            [positive[0]],
            target_band_count=1,
            relative_tolerance=1.0e-8,
        )


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("k_vector", [0.0, math.nan, 0.0], "finite"),
        ("k_vector", None, "exactly three"),
        ("k_vector", [0.0, 0.0], "exactly three"),
        ("frequency_real_hz", math.inf, "finite"),
        ("frequency_imag_hz", math.nan, "finite"),
    ],
)
def test_nonfinite_inputs_are_rejected(field: str, value: object, message: str) -> None:
    positive = sample(0, [1.0, 0.0, 0.0], [mode(1, 1.0e9)])
    negative = sample(0, [-1.0, 0.0, 0.0], [mode(2, 1.0e9)])
    if field == "k_vector":
        positive[field] = value
    else:
        positive["modes"][0][field] = value

    with pytest.raises(ValueError, match=message):
        replay_signed_k_spectra(
            [positive],
            [negative],
            target_band_count=1,
            relative_tolerance=1.0e-8,
        )


def test_duplicate_raw_modes_and_insufficient_positive_bands_are_rejected() -> None:
    duplicate_modes = [mode(4, 1.0e9), mode(4, 2.0e9)]
    with pytest.raises(ValueError, match="duplicate raw_mode_index"):
        replay_signed_k_spectra(
            [sample(0, [0.0, 0.0, 0.0], duplicate_modes)],
            [sample(0, [0.0, 0.0, 0.0], [mode(8, 1.0e9), mode(9, 2.0e9)])],
            target_band_count=2,
            relative_tolerance=1.0e-8,
        )

    with pytest.raises(ValueError, match="at least 2 are required"):
        replay_signed_k_spectra(
            [sample(0, [0.0, 0.0, 0.0], [mode(4, -1.0e9), mode(5, 1.0e9)])],
            [sample(0, [0.0, 0.0, 0.0], [mode(8, 1.0e9), mode(9, 2.0e9)])],
            target_band_count=2,
            relative_tolerance=1.0e-8,
        )


@pytest.mark.parametrize("tolerance", [0.0, -1.0, math.inf, math.nan, True])
def test_tolerance_must_be_explicit_positive_finite_numeric(tolerance: object) -> None:
    with pytest.raises(ValueError, match="relative_tolerance"):
        replay_signed_k_spectra(
            [sample(0, [0.0, 0.0, 0.0], [mode(1, 1.0e9)])],
            [sample(0, [0.0, 0.0, 0.0], [mode(2, 1.0e9)])],
            target_band_count=1,
            relative_tolerance=tolerance,  # type: ignore[arg-type]
        )


def test_empty_input_and_invalid_band_count_are_rejected() -> None:
    with pytest.raises(ValueError, match="non-empty sequence"):
        replay_signed_k_spectra(
            [],
            [sample(0, [0.0, 0.0, 0.0], [mode(1, 1.0e9)])],
            target_band_count=1,
            relative_tolerance=1.0e-8,
        )
    with pytest.raises(ValueError, match="positive integer"):
        replay_signed_k_spectra(
            [sample(0, [0.0, 0.0, 0.0], [mode(1, 1.0e9)])],
            [sample(0, [0.0, 0.0, 0.0], [mode(2, 1.0e9)])],
            target_band_count=0,
            relative_tolerance=1.0e-8,
        )


def test_relative_tolerance_is_required_by_caller() -> None:
    with pytest.raises(TypeError, match="relative_tolerance"):
        replay_signed_k_spectra(
            [sample(0, [0.0, 0.0, 0.0], [mode(1, 1.0e9)])],
            [sample(0, [0.0, 0.0, 0.0], [mode(2, 1.0e9)])],
            target_band_count=1,
        )  # type: ignore[call-arg]


def test_extreme_finite_k_and_frequency_values_do_not_overflow() -> None:
    largest = math.nextafter(math.inf, 0.0)
    adjacent = math.nextafter(largest, 0.0)
    positive = [
        sample(
            0,
            [largest, -largest, 0.0],
            [mode(91, largest, -largest)],
        )
    ]
    negative = [
        sample(
            0,
            [-largest, largest, 0.0],
            [mode(3, adjacent, math.nextafter(-largest, 0.0))],
        )
    ]

    report = replay_signed_k_spectra(
        positive,
        negative,
        target_band_count=1,
        relative_tolerance=1.0e-15,
    )

    assert report["status"] == "pass"
    assert math.isfinite(report["maximum_relative_error"])
    assert report["maximum_relative_error"] > 0.0
