from __future__ import annotations

import csv
import json
from pathlib import Path

import pytest

from tests.standard_problems.mumag.sp4.fem.collect_results import (
    CollectionError,
    collect_attempt,
    record_failed_attempt,
)


def _write_artifacts(root: Path, *, crossing: bool = True) -> Path:
    artifacts = root / "artifacts"
    artifacts.mkdir(parents=True)
    metadata = {
        "requested_execution": {
            "backend": "fem",
            "device": "cpu",
            "precision": "double",
            "mode": "strict",
            "fallback_policy": "forbidden",
        },
        "execution_provenance": {
            "execution_engine": "fem_cpu_native",
            "precision": "double",
            "lossy_fallback_used": False,
            "integrator": "rk4",
            "timestep_policy": {
                "kind": "fixed",
                "fixed_dt": 2e-13,
            },
        },
        "demag_runtime": {
            "realization": "poisson_robin",
            "operator_mode": "cpu_hypre_poisson",
            "actual_iterations": 9,
            "final_residual_norm": 2e-13,
        },
        "mesh": {
            "topology_fingerprint": "sha256:mesh-a",
            "node_count": 1234,
            "element_count": 5678,
        },
        "problem_meta": {
            "runtime_metadata": {
                "domain_frame": {
                    "declared_universe": {"size": [7e-7, 2.5e-7, 2.5e-7]},
                },
                "mesh_workflow": {
                    "per_geometry": [
                        {
                            "maximum_element_size": 3e-9,
                            "through_thickness_elements": 3,
                        }
                    ]
                },
            }
        },
        "wall_time_s": 12.5,
    }
    (artifacts / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
    final_mx = -0.2 if crossing else 0.2
    (artifacts / "scalars.csv").write_text(
        "step,time,solver_dt,mx,my,mz,E_total,max_torque_T\n"
        "0,0,2e-13,0.8,0.1,0,-1e-17,2e-3\n"
        "1,1e-12,2e-13,0.2,0.2,0.1,-2e-17,2e-4\n"
        f"2,2e-12,2e-13,{final_mx},0.3,0.2,-3e-17,2e-5\n",
        encoding="utf-8",
    )
    return artifacts


def _read_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as stream:
        return list(csv.DictReader(stream))


def test_collect_attempt_writes_one_stable_application_result_row(tmp_path: Path) -> None:
    artifacts = _write_artifacts(tmp_path / "run-a")
    ledger = tmp_path / "results.csv"

    result = collect_attempt(
        artifacts,
        ledger,
        scenario="case_a_rk4_fixed",
        attempt_id="attempt-001",
    )

    rows = _read_rows(ledger)
    assert len(rows) == 1
    row = rows[0]
    assert result == row
    assert row["attempt_id"] == "attempt-001"
    assert row["scenario"] == "case_a_rk4_fixed"
    assert row["case"] == "case_a"
    assert row["integrator"] == "rk4"
    assert row["timestep_policy"] == "fixed"
    assert row["requested_device"] == "cpu"
    assert row["execution_engine"] == "fem_cpu_native"
    assert row["mesh_topology_fingerprint"] == "sha256:mesh-a"
    assert float(row["crossing_time_s"]) == pytest.approx(1.5e-12)
    assert int(row["sample_count"]) == 3
    assert float(row["final_E_total_J"]) == pytest.approx(-3e-17)
    assert float(row["final_max_torque_T"]) == pytest.approx(2e-5)
    assert float(row["wall_time_s"]) == pytest.approx(12.5)
    assert row["metadata_sha256"]
    assert row["scalars_sha256"]
    assert row["status"] == "completed"


def test_collect_attempt_appends_but_rejects_duplicate_attempt_id(tmp_path: Path) -> None:
    first = _write_artifacts(tmp_path / "run-a")
    second = _write_artifacts(tmp_path / "run-b")
    ledger = tmp_path / "results.csv"
    collect_attempt(first, ledger, scenario="case_a_rk4_fixed", attempt_id="one")
    collect_attempt(second, ledger, scenario="case_b_rk4_fixed", attempt_id="two")
    before = ledger.read_bytes()

    with pytest.raises(CollectionError, match="attempt ID already exists"):
        collect_attempt(second, ledger, scenario="case_b_rk4_fixed", attempt_id="one")

    assert ledger.read_bytes() == before
    assert [row["attempt_id"] for row in _read_rows(ledger)] == ["one", "two"]


def test_collect_attempt_accepts_the_sibling_zarr_bundle_root(tmp_path: Path) -> None:
    artifacts = _write_artifacts(tmp_path / "case_a_rk4_fixed.zarr")
    ledger = tmp_path / "results.csv"

    row = collect_attempt(
        artifacts.parent,
        ledger,
        scenario="case_a_rk4_fixed",
        attempt_id="bundle-root",
    )

    assert row["artifact_dir"] == str(artifacts.resolve())
    assert _read_rows(ledger)[0]["attempt_id"] == "bundle-root"


def test_failed_attempt_is_retained_without_claiming_physical_metrics(tmp_path: Path) -> None:
    ledger = tmp_path / "results.csv"

    row = record_failed_attempt(
        ledger,
        scenario="case_b_rk45_adaptive",
        attempt_id="failed-001",
        requested_device="gpu",
        category="execution_failure",
        detail="native runtime exited with status 1",
        wall_time_s=3.25,
        artifact_dir=tmp_path / "case_b_rk45_adaptive.zarr",
    )

    assert row["status"] == "execution_failure"
    assert row["failure_category"] == "execution_failure"
    assert row["failure_detail"] == "native runtime exited with status 1"
    assert row["requested_device"] == "gpu"
    assert row["integrator"] == "rk45"
    assert row["timestep_policy"] == "adaptive"
    assert row["crossing_time_s"] == ""
    assert float(row["wall_time_s"]) == pytest.approx(3.25)
    assert _read_rows(ledger) == [row]


@pytest.mark.parametrize(
    "damage,match",
    [
        ("missing_metadata", "missing metadata"),
        ("missing_column", "missing scalar columns"),
        ("nonfinite", "non-finite"),
        ("nonmonotone", "strictly increasing"),
        ("no_crossing", "no positive-to-nonpositive mx crossing"),
    ],
)
def test_collect_attempt_fails_closed_without_modifying_ledger(
    tmp_path: Path,
    damage: str,
    match: str,
) -> None:
    good = _write_artifacts(tmp_path / "good")
    broken = _write_artifacts(tmp_path / "broken", crossing=damage != "no_crossing")
    ledger = tmp_path / "results.csv"
    collect_attempt(good, ledger, scenario="case_a_rk4_fixed", attempt_id="good")
    before = ledger.read_bytes()

    if damage == "missing_metadata":
        (broken / "metadata.json").unlink()
    elif damage == "missing_column":
        text = (broken / "scalars.csv").read_text(encoding="utf-8")
        (broken / "scalars.csv").write_text(text.replace(",mz,", ","), encoding="utf-8")
    elif damage == "nonfinite":
        text = (broken / "scalars.csv").read_text(encoding="utf-8")
        (broken / "scalars.csv").write_text(text.replace("0.2,0.2", "nan,0.2"), encoding="utf-8")
    elif damage == "nonmonotone":
        text = (broken / "scalars.csv").read_text(encoding="utf-8")
        (broken / "scalars.csv").write_text(text.replace("2,2e-12", "2,1e-12"), encoding="utf-8")

    with pytest.raises(CollectionError, match=match):
        collect_attempt(
            broken,
            ledger,
            scenario="case_a_rk4_fixed",
            attempt_id=f"broken-{damage}",
        )

    assert ledger.read_bytes() == before
