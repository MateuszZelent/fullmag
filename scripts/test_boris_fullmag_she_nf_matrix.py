from __future__ import annotations

import copy

import pytest

from run_boris_fullmag_she_nf_matrix import validate_matrix_summary


def _metric(value: float) -> dict[str, float]:
    return {
        "max_absolute_error": value,
        "max_relative_error": value,
        "normalized_l2_error": value,
        "endpoint_error": value,
    }


def _fixture() -> dict[str, object]:
    runs = []
    resolutions = ((10, 4, 2, 2), (20, 8, 4, 4), (40, 16, 8, 8))
    for resolution_index, (nx, ny, nz_n, nz_f) in enumerate(resolutions):
        for tolerance, error in ((1.0e-8, 1.0e-3 / (resolution_index + 1)), (1.0e-10, 1.0e-4 / (resolution_index + 1))):
            runs.append(
                {
                    "run_key": f"{nx}x{ny}x{nz_n}+{nz_f}__tol-{tolerance:.0e}",
                    "resolution": {"nx": nx, "ny": ny, "nz_n": nz_n, "nz_f": nz_f},
                    "tolerance": tolerance,
                    "status": "diagnostic_match",
                    "comparison": {
                        "status": "diagnostic_match",
                        "observables": {"mu_s": _metric(error)},
                    },
                }
            )
    return {
        "schema_version": "fullmag.boris_fullmag_she_nf_matrix.v1",
        "declared_resolutions": 3,
        "declared_tolerances": [1.0e-8, 1.0e-10],
        "runs": runs,
    }


def test_matrix_requires_three_resolutions_and_two_tolerances() -> None:
    summary = _fixture()
    summary["declared_resolutions"] = 1
    with pytest.raises(ValueError, match="three resolutions"):
        validate_matrix_summary(summary)


def test_matrix_rejects_duplicate_run_identity() -> None:
    summary = _fixture()
    summary["runs"][1]["run_key"] = summary["runs"][0]["run_key"]
    with pytest.raises(ValueError, match="duplicate"):
        validate_matrix_summary(summary)


def test_matrix_accepts_complete_monotone_fixture() -> None:
    validate_matrix_summary(_fixture())


def test_matrix_rejects_nonmonotone_resolution_error() -> None:
    summary = _fixture()
    broken = copy.deepcopy(summary)
    broken["runs"][-2]["comparison"]["observables"]["mu_s"]["max_relative_error"] = 0.9
    broken["runs"][-1]["comparison"]["observables"]["mu_s"]["max_relative_error"] = 0.9
    with pytest.raises(ValueError, match="monotone across resolution"):
        validate_matrix_summary(broken)
