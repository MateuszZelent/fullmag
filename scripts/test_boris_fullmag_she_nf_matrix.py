from __future__ import annotations

import copy
import json
from types import SimpleNamespace

import run_boris_fullmag_she_nf_matrix as matrix

import pytest

from run_boris_fullmag_she_nf_matrix import Resolution, _verify_fullmag_binary, run_resolution_matrix, validate_matrix_summary


def _metric(value: float) -> dict[str, float]:
    return {
        "max_absolute_error": value,
        "max_relative_error": value,
        "normalized_l2_error": value,
        "endpoint_error": value,
    }


def _fixture() -> dict[str, object]:
    runs = []
    resolutions = ((4, 2, 2, 2), (10, 4, 2, 2), (20, 8, 4, 4))
    for resolution_index, (nx, ny, nz_n, nz_f) in enumerate(resolutions):
        for tolerance, error in ((1.0e-8, 1.0e-3 / (resolution_index + 1)), (1.0e-10, 1.0e-4 / (resolution_index + 1))):
            runs.append(
                {
                    "run_key": f"{nx}x{ny}x{nz_n}+{nz_f}__tol-{tolerance:.0e}",
                    "resolution": {"nx": nx, "ny": ny, "nz_n": nz_n, "nz_f": nz_f},
                    "tolerance": tolerance,
                    "status": "diagnostic_match",
                    "boris_runtime": {"schema_version": "fullmag.boris.runtime.v2", "identity_complete": True, "runtime_id": f"{resolution_index:032x}"},
                    "boris_reference_reuse": "same_fixed_BORIS_runtime_for_both_Fullmag_tolerances",
                    "comparison": {
                        "status": "diagnostic_match",
                        "observables": {"mu_s": _metric(error)},
                    },
                }
            )
    return {
        "schema_version": "fullmag.boris_fullmag_she_nf_matrix.v2",
        "tolerance_scope": "Fullmag_only; BORIS_fixed_managed_defaults_reused",
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


def test_matrix_rejects_unknown_device_before_running_cases(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(matrix, "sys", SimpleNamespace(platform="win32"))
    with pytest.raises(ValueError, match="requires CPU"):
        run_resolution_matrix(
            (Resolution(1, 1, 1, 1),),
            (1.0e-8,),
            {},
            tmp_path / "fullmag",
            tmp_path / "report",
            repo_root=tmp_path,
            fullmag_sha256="0" * 64,
            device="tpu",
        )


def test_matrix_rejects_legacy_report_without_managed_provenance():
    summary = _fixture()
    summary["schema_version"] = "fullmag.boris_fullmag_she_nf_matrix.v1"
    with pytest.raises(ValueError, match="legacy matrix"):
        validate_matrix_summary(summary)


def test_matrix_refuses_unpinned_fullmag_before_execution(tmp_path):
    binary = tmp_path / "fullmag"
    binary.write_bytes(b"fixture; never executed")
    with pytest.raises(ValueError, match="explicit SHA256"):
        _verify_fullmag_binary(binary, "", None)
    with pytest.raises(ValueError, match="differs"):
        _verify_fullmag_binary(binary, "0" * 64, None)


def test_matrix_rejects_legacy_grids_before_managed_observation(tmp_path, monkeypatch):
    monkeypatch.setattr(matrix, "sys", SimpleNamespace(platform="win32"))
    with pytest.raises(ValueError, match="legacy 10/20/40"):
        run_resolution_matrix((Resolution(40, 16, 8, 8),), (1e-8, 1e-10), {},
            tmp_path / "fullmag", tmp_path / "report", repo_root=tmp_path,
            fullmag_sha256="0" * 64)


def test_matrix_refuses_linux_before_runtime_or_binary_access(tmp_path, monkeypatch):
    monkeypatch.setattr(matrix, "sys", SimpleNamespace(platform="linux"))
    with pytest.raises(ValueError, match="Windows-only"):
        run_resolution_matrix((), (), {}, tmp_path / "missing", tmp_path / "report",
            repo_root=tmp_path, fullmag_sha256="")
    assert not (tmp_path / "report").exists()


@pytest.mark.parametrize("member", ["summary.json", "runtime.json", "receipt.json", "scenario.json"])
def test_matrix_reference_pin_refuses_changed_valid_json_bytes(tmp_path, member):
    export = tmp_path / "export"
    export.mkdir()
    (tmp_path / "input").mkdir()
    paths = {"summary.json": export / "summary.json", "runtime.json": export / "runtime.json",
        "receipt.json": tmp_path / "receipt.json", "scenario.json": tmp_path / "input/scenario.json"}
    for path in paths.values():
        path.write_text(json.dumps({"runtime": {"runtime_id": "1" * 32}}))
    pin = matrix._reference_pin(paths["summary.json"])
    paths[member].write_bytes(paths[member].read_bytes() + b" ")
    with pytest.raises(ValueError, match="pinned reference changed"):
        matrix._require_reference_pin(paths["summary.json"], pin)
