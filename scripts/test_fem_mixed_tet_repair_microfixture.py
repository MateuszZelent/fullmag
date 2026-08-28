from __future__ import annotations

import importlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


try:
    import gmsh  # type: ignore[import-not-found]
except ModuleNotFoundError as error:
    if error.name == "gmsh":
        pytest.skip("real Gmsh is not installed", allow_module_level=True)
    raise


SCRIPT_DIR = Path(__file__).resolve().parent


def _fixture_module():
    module_path = SCRIPT_DIR / "fem_mixed_tet_repair_microfixture.py"
    if not module_path.exists():
        pytest.fail(f"microfixture implementation is missing: {module_path}")
    if str(SCRIPT_DIR) not in sys.path:
        sys.path.insert(0, str(SCRIPT_DIR))
    return importlib.import_module("fem_mixed_tet_repair_microfixture")


def test_real_discrete_hybrid_fixture_has_expected_counts_and_repairs_one_tet() -> None:
    fixture = _fixture_module()

    assert not gmsh.isInitialized()
    result = fixture.run_once()

    assert result["schema"] == "fullmag.fem-mixed-tet-repair-microfixture-run.v1"
    assert result["node_count"] == 161
    assert result["before"]["cell_counts"] == {
        "tet4": 101,
        "prism6": 1,
        "pyramid5": 1,
    }
    assert result["after"]["cell_counts"] == {
        "tet4": 100,
        "prism6": 1,
        "pyramid5": 1,
    }
    assert result["before"]["strict_degenerate_tet_count"] == 1
    assert result["after"]["strict_degenerate_tet_count"] == 0
    assert result["before"]["strict_degenerate_tet_tags"] == [
        fixture.CENTER_BRIDGE_ELEMENT_TAG
    ]
    assert result["after"]["strict_degenerate_tet_tags"] == []
    assert result["before"]["cavity_face_incidence_histogram"] == {
        "1": 8,
        "2": 6,
    }
    assert result["before"]["cavity_face_incidence_max"] == 2
    assert result["before"]["control_tet_topology_keys"]
    assert len(result["before"]["control_tet_topology_keys"]) == 96
    assert (
        result["before"]["control_tet_topology_keys"]
        == result["after"]["control_tet_topology_keys"]
    )
    assert not gmsh.isInitialized()


def test_repair_preserves_the_faulty_cavity_external_face_multiset() -> None:
    fixture = _fixture_module()
    result = fixture.run_once()

    before_faces = result["before"]["cavity_external_face_multiset"]
    after_faces = result["after"]["cavity_external_face_multiset"]
    assert len(before_faces) == 8
    assert before_faces == after_faces
    assert all(len(face) == 3 for face in before_faces)
    assert set().union(*(set(face) for face in before_faces)) == set(
        fixture.CENTER_NODE_TAGS
    )


def test_repair_has_no_duplicate_tets_and_positive_quality_margins() -> None:
    fixture = _fixture_module()
    result = fixture.run_once()
    after = result["after"]

    tet_connectivity = [tuple(row) for row in after["topology_keys"]["tet4"]]
    assert len(tet_connectivity) == 100
    assert len(set(tet_connectivity)) == len(tet_connectivity)
    assert min(after["tet_determinant_margins"]) > 1.0
    assert min(after["tet_scaled_jacobians"]) > 0.0
    assert min(after["cell_scaled_jacobians"]["prism6"]) > 0.0
    assert min(after["cell_scaled_jacobians"]["pyramid5"]) > 0.0


def test_control_raw_prism_and_pyramid_connectivity_is_preserved_exactly() -> None:
    fixture = _fixture_module()
    result = fixture.run_once()

    before = result["before"]["raw_connectivity"]
    after = result["after"]["raw_connectivity"]
    assert before["prism6"] == after["prism6"]
    assert before["pyramid5"] == after["pyramid5"]


def test_exception_path_restores_options_and_finalizes_gmsh(monkeypatch) -> None:
    fixture = _fixture_module()
    gmsh_module = fixture.gmsh
    gmsh_module.initialize([], False)
    previous_threshold = gmsh_module.option.getNumber("Mesh.OptimizeThreshold")
    previous_terminal = gmsh_module.option.getNumber("General.Terminal")
    gmsh_module.clear()
    gmsh_module.finalize()

    set_calls = []
    clear_calls = []
    finalize_calls = []
    original_set_number = gmsh_module.option.setNumber
    original_clear = gmsh_module.clear
    original_finalize = gmsh_module.finalize

    def record_set_number(name, value):
        set_calls.append((name, value))
        return original_set_number(name, value)

    def record_clear(*args, **kwargs):
        clear_calls.append((args, kwargs))
        return original_clear(*args, **kwargs)

    def record_finalize(*args, **kwargs):
        finalize_calls.append((args, kwargs))
        return original_finalize(*args, **kwargs)

    def fail_before_repair():
        raise RuntimeError("forced microfixture failure")

    monkeypatch.setattr(gmsh_module.option, "setNumber", record_set_number)
    monkeypatch.setattr(gmsh_module, "clear", record_clear)
    monkeypatch.setattr(gmsh_module, "finalize", record_finalize)
    monkeypatch.setattr(fixture, "_run_once_in_initialized_gmsh", fail_before_repair)

    with pytest.raises(RuntimeError, match="forced microfixture failure"):
        fixture.run_once()

    assert ("Mesh.OptimizeThreshold", previous_threshold) in set_calls
    assert ("General.Terminal", previous_terminal) in set_calls
    assert len(clear_calls) == 1
    assert len(finalize_calls) == 1
    assert not gmsh_module.isInitialized()


def test_ten_fresh_repairs_are_deterministic_and_report_fast_percentiles() -> None:
    fixture = _fixture_module()
    report = fixture.run_benchmark(runs=10)

    assert report["schema"] == "fullmag.fem-mixed-tet-repair-microfixture.v1"
    assert len(report["runs"]) == 10
    first = report["runs"][0]
    assert all(
        run["after"]["topology_keys"] == first["after"]["topology_keys"]
        and run["after"]["raw_connectivity"] == first["after"]["raw_connectivity"]
        for run in report["runs"]
    )
    assert all(
        run["after"]["cell_counts"] == first["after"]["cell_counts"]
        for run in report["runs"]
    )
    timings = report["summary"]["repair_ms"]
    assert set(timings) == {"p50", "p95", "max"}
    assert timings["p50"] <= timings["p95"] <= timings["max"]
    assert timings["p95"] < 50.0


def test_cli_writes_only_canonical_json_to_stdout(tmp_path: Path) -> None:
    fixture_path = SCRIPT_DIR / "fem_mixed_tet_repair_microfixture.py"
    if not fixture_path.exists():
        pytest.fail(f"microfixture implementation is missing: {fixture_path}")
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join(
        [str(SCRIPT_DIR), str(SCRIPT_DIR.parent / "packages" / "fullmag-py" / "src")]
    )
    completed = subprocess.run(
        [sys.executable, str(fixture_path), "--runs", "1"],
        check=True,
        capture_output=True,
        text=True,
        env=environment,
    )
    document = json.loads(completed.stdout)
    assert document["schema"] == "fullmag.fem-mixed-tet-repair-microfixture.v1"
    assert (
        completed.stdout
        == json.dumps(
            document,
            sort_keys=True,
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )
    assert completed.stderr == ""
