"""Public DSL to IR regression for the frozen, demagnetizing DE smoke case."""
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages/fullmag-py/src"))
import fullmag as fm


@pytest.mark.parametrize("sampling,ky,mode_count", [
    ("two", [0, 2e6], 4),
    ("five", [0, 1e6, 2e6, 3e6, 5e6], 4),
    ("k2", [2e6], 1),
])
def test_de_smoke_preserves_physical_problem(monkeypatch, sampling, ky, mode_count):
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SAMPLING", sampling)
    # Canonical benchmark settings must not silently change this small control.
    monkeypatch.setenv("FULLMAG_COMSOL_DISPERSION_CASE", "a1")
    fm.reset()
    try:
        loaded = fm.load_problem_from_script(ROOT / "examples/fem_de_smoke_numeric.py", lightweight_assets=True)
        stages = [s.problem.to_ir(requested_backend="fem", execution_mode="strict",
                  execution_precision="double", include_geometry_assets=False) for s in loaded.stages]
    finally:
        fm.reset()
    assert len(stages) == 2
    relax, eigen = stages
    geometry = eigen["geometry"]["entries"]
    assert len(geometry) == 1
    assert geometry[0]["kind"] == "box"
    assert geometry[0]["size"] == pytest.approx([40e-9, 40e-9, 10e-9])
    material = eigen["materials"][0]
    assert material["saturation_magnetisation"] == 800000
    assert material["exchange_stiffness"] == 13e-12
    assert next(t for t in eigen["energy_terms"] if t["kind"] == "zeeman")["B"] == [0.1, 0, 0]
    meta = eigen["problem_meta"]["runtime_metadata"]
    assert meta["de_smoke"]["requested_mode_count"] == mode_count
    assert meta["runtime_selection"]["device"] == "cpu"
    assert meta["study_universe"]["size"] == pytest.approx([40e-9, 40e-9, 4010e-9])
    workflow = meta["mesh_workflow"]
    assert len(workflow["per_geometry"]) == 1
    mesh = workflow["per_geometry"][0]
    assert mesh["through_thickness_elements"] == 3
    assert mesh["hmax"] == 10e-9
    assert workflow["mesh_options"]["periodic_pair_ids"] == ["x_faces", "y_faces"]
    for ir in stages:
        assert sorted(t["kind"] for t in ir["energy_terms"]) == ["demag", "exchange", "zeeman"]
        assert next(t for t in ir["energy_terms"] if t["kind"] == "demag")["realization"] == "poisson_dirichlet"
        assert ir["pbc"]["demag"] == "periodic_airbox_k0"
        assert ir["study"]["dynamics"]["gyromagnetic_ratio"] == 2.211e5
    assert relax["study"]["algorithm"] == "llg_overdamped"
    e = eigen["study"]
    assert e["operator"] == {"kind": "full_2x2", "include_demag": True}
    assert e["count"] == mode_count
    assert e["target"] == {"kind": "frequency_window", "frequency_min_hz": 8.5e9, "frequency_max_hz": 12e9}
    assert e["equilibrium"] == {"kind": "relaxed_initial_state"}
    assert e["damping_policy"] == "ignore"
    assert e["magnetostatic_bc"] == "floquet_airbox"
    assert e["spin_wave_bc"] == {"kind": "floquet", "pair_ids": ["x_faces", "y_faces"],
                                   "phase_convention": "exp_minus_i_k_dot_delta_r"}
    if sampling == "k2":
        assert e["k_sampling"] == {"kind": "single", "k_vector": [0, ky[0], 0]}
    else:
        assert [p["k_vector"] for p in e["k_sampling"]["points"]] == [[0, k, 0] for k in ky]
        assert e["k_sampling"]["samples_per_segment"] == [1] * (len(ky) - 1)
    mode = next(o for o in e["sampling"]["outputs"] if o["kind"] == "eigen_mode")
    assert mode["indices"] == list(range(mode_count))
    assert mode["sample_selector"]["sample_indices"] == list(range(len(ky)))
    assert "dispersion_validation" not in meta


def test_invalid_sampling_is_rejected(monkeypatch):
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SAMPLING", "61")
    fm.reset()
    try:
        with pytest.raises(Exception, match="FULLMAG_DE_SMOKE_SAMPLING"):
            fm.load_problem_from_script(ROOT / "examples/fem_de_smoke_numeric.py", lightweight_assets=True)
    finally:
        fm.reset()
