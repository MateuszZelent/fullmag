"""Public IR contract checks for the dense numerical film grid.

These tests do not solve FEM or provide frequency/physics qualification.
"""
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages/fullmag-py/src"))
import fullmag as fm
import run_de_100nm_pilot as pilot


@pytest.mark.parametrize("geometry", ["de", "bv"])
def test_dense_path_has_26_samples_and_one_shared_relaxation(monkeypatch, geometry):
    sampling = "bv-positive-26" if geometry == "bv" else "positive-26"
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SAMPLING", sampling)
    fm.reset()
    try:
        loaded = fm.load_problem_from_script(ROOT / "examples/fem_de_smoke_numeric.py", lightweight_assets=True)
        assert len(loaded.stages) == 2
        stages = [stage.problem.to_ir(requested_backend="fem", execution_mode="strict",
                                     execution_precision="double", include_geometry_assets=False)
                  for stage in loaded.stages]
    finally:
        fm.reset()
    eigen = stages[-1]["study"]
    vectors = [[index*1e6, 0, 0] if geometry == "bv" else [0, index*1e6, 0] for index in range(26)]
    assert [point["k_vector"] for point in eigen["k_sampling"]["points"]] == vectors
    assert eigen["k_sampling"]["samples_per_segment"] == [1]*25
    assert eigen["count"] == 1
    assert eigen["operator"] == {"kind": "full_2x2", "include_demag": True}
    assert eigen["equilibrium"] == {"kind": "relaxed_initial_state"}
    assert eigen["target"] == {"kind": "frequency_window", "frequency_min_hz": 8.5e9,
                                "frequency_max_hz": 12e9 if geometry == "bv" else 16e9}
    mode = next(o for o in eigen["sampling"]["outputs"] if o["kind"] == "eigen_mode")
    assert mode["sample_selector"]["sample_indices"] == list(range(26))
    assert all(sorted(term["kind"] for term in stage["energy_terms"]) == ["demag", "exchange", "zeeman"] for stage in stages)
    assert pilot.PILOTS["de-smoke-"+sampling][1] == sampling


@pytest.mark.parametrize("geometry,k", [(g, k) for g in ("de", "bv") for k in range(26)])
def test_every_dense_grid_point_can_run_individually(monkeypatch, geometry, k):
    sampling = ("bv-" if geometry == "bv" else "") + f"k{k}"
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SAMPLING", sampling)
    fm.reset()
    try:
        loaded = fm.load_problem_from_script(ROOT / "examples/fem_de_smoke_numeric.py", lightweight_assets=True)
        ir = loaded.stages[-1].problem.to_ir(requested_backend="fem", execution_mode="strict",
                                           execution_precision="double", include_geometry_assets=False)
    finally:
        fm.reset()
    study = ir["study"]
    vector = [k*1e6, 0, 0] if geometry == "bv" else [0, k*1e6, 0]
    assert study["k_sampling"] == {"kind": "single", "k_vector": vector}
    assert study["count"] == 1
    assert study["spin_wave_bc"]["kind"] == ("periodic" if k == 0 else "floquet")
    assert study["magnetostatic_bc"] == ("periodic_airbox_k0" if k == 0 else "floquet_airbox")
    assert pilot.PILOTS["de-smoke-"+sampling][1] == sampling
