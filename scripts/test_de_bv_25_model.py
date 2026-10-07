"""Check DE/BV 25 rad/um inputs through the public DSL and ProblemIR."""
import sys
from pathlib import Path
import pytest
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages/fullmag-py/src"))
import fullmag as fm

@pytest.mark.parametrize("sampling,vector,window", [
    ("k0", [0,0,0], (8.5e9,12e9)),
    ("k25", [0,25e6,0], (12e9,16e9)),
    ("bv-k25", [25e6,0,0], (8.5e9,12e9)),
    ("k-25", [0,-25e6,0], (12e9,16e9)),
    ("bv-k-25", [-25e6,0,0], (8.5e9,12e9)),
    *[(f"k{k}", [0,k*1e6,0], (8.5e9,16e9 if k >= 15 else 12e9)) for k in (5,7,10,12,15,17,20,22)],
    *[(f"bv-k{k}", [k*1e6,0,0], (8.5e9,12e9)) for k in (2,5,7,10,12,15,17,20,22)],
])
def test_same_physics_and_explicit_propagation(monkeypatch,sampling,vector,window):
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SAMPLING",sampling)
    monkeypatch.delenv("FULLMAG_DE_SMOKE_SOLVER_RTOL",raising=False)
    fm.reset()
    try:
        loaded=fm.load_problem_from_script(ROOT/"examples/fem_de_smoke_numeric.py",lightweight_assets=True)
        ir=loaded.stages[-1].problem.to_ir(requested_backend="fem",execution_mode="strict",
                                         execution_precision="double",include_geometry_assets=False)
    finally:
        fm.reset()
    study=ir["study"]
    assert study["k_sampling"]=={"kind":"single","k_vector":vector}
    assert study["operator"]=={"kind":"full_2x2","include_demag":True}
    assert study["count"]==1
    assert study["target"]=={"kind":"frequency_window","frequency_min_hz":window[0],"frequency_max_hz":window[1]}
    assert study["magnetostatic_bc"]==("periodic_airbox_k0" if sampling=="k0" else "floquet_airbox")
    if sampling=="k0":
        assert study["spin_wave_bc"]=={"kind":"periodic","pair_ids":["x_faces","y_faces"]}
    assert next(t for t in ir["energy_terms"] if t["kind"]=="zeeman")["B"]==[0.1,0,0]
    assert ir["materials"][0]["saturation_magnetisation"]==800000
    assert ir["materials"][0]["exchange_stiffness"]==13e-12
    meta=ir["problem_meta"]["runtime_metadata"]["de_smoke"]
    assert meta["k_vectors_rad_per_m"]==[vector]
    assert meta["eigen_solver_rtol"]==1e-8
    assert meta["film_thickness_m"]==10e-9

@pytest.mark.parametrize("sampling,axis,max_frequency", [
    ("positive-six",1,16e9),("bv-positive-six",0,12e9)])
def test_six_point_path_preserves_equilibrium_and_direction(monkeypatch,sampling,axis,max_frequency):
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SAMPLING",sampling)
    monkeypatch.delenv("FULLMAG_DE_SMOKE_SOLVER_RTOL",raising=False)
    fm.reset()
    try:
        loaded=fm.load_problem_from_script(ROOT/"examples/fem_de_smoke_numeric.py",lightweight_assets=True)
        ir=loaded.stages[-1].problem.to_ir(requested_backend="fem",execution_mode="strict",
                                         execution_precision="double",include_geometry_assets=False)
    finally:
        fm.reset()
    vectors=[]
    for k in (2e6,5e6,10e6,15e6,20e6,25e6):
        vector=[0,0,0];vector[axis]=k;vectors.append(vector)
    study=ir["study"]
    assert [p["k_vector"] for p in study["k_sampling"]["points"]]==vectors
    assert study["k_sampling"]["samples_per_segment"]==[1]*5
    assert study["count"]==1
    assert study["target"]["frequency_min_hz"]==8.5e9
    assert study["target"]["frequency_max_hz"]==max_frequency
    assert study["operator"]=={"kind":"full_2x2","include_demag":True}
    assert ir["problem_meta"]["runtime_metadata"]["de_smoke"]["k_vectors_rad_per_m"]==vectors
    assert study["equilibrium"]=={"kind":"relaxed_initial_state"}

@pytest.mark.parametrize("sampling",["k25","bv-k25"])
@pytest.mark.parametrize("level,hmax",[("L0",10e-9),("L1",7.5e-9),("L2",5e-9),("L3",3.75e-9)])
def test_mesh_convergence_preserves_physics(monkeypatch,sampling,level,hmax):
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SAMPLING",sampling)
    monkeypatch.setenv("FULLMAG_DE_SMOKE_MESH_LEVEL",level)
    monkeypatch.delenv("FULLMAG_DE_SMOKE_SOLVER_RTOL",raising=False)
    fm.reset()
    try:
        loaded=fm.load_problem_from_script(ROOT/"examples/fem_de_smoke_numeric.py",lightweight_assets=True)
        ir=loaded.stages[-1].problem.to_ir(requested_backend="fem",execution_mode="strict",
                                         execution_precision="double",include_geometry_assets=False)
    finally:
        fm.reset()
    meta=ir["problem_meta"]["runtime_metadata"]
    assert meta["de_smoke"]["mesh_level"]==level
    assert meta["de_smoke"]["magnetic_element_size_m"]==hmax
    assert meta["mesh_workflow"]["per_geometry"][0]["hmax"]==hmax
    assert meta["mesh_workflow"]["per_geometry"][0]["through_thickness_elements"]==3
    assert meta["de_smoke"]["eigen_solver_rtol"]==1e-8
    assert meta["de_smoke"]["air_padding_each_side_m"]==2e-6
    assert ir["geometry"]["entries"][0]["size"]==pytest.approx([40e-9,40e-9,10e-9])
    assert next(t for t in ir["energy_terms"] if t["kind"]=="zeeman")["B"]==[0.1,0,0]


@pytest.mark.parametrize("sampling", ["k25", "bv-k25"])
@pytest.mark.parametrize("layers", ["3", "6", "9"])
def test_thickness_convergence_preserves_physics(monkeypatch, sampling, layers):
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SAMPLING", sampling)
    monkeypatch.setenv("FULLMAG_DE_SMOKE_THICKNESS_LAYERS", layers)
    monkeypatch.setenv("FULLMAG_DE_SMOKE_MESH_LEVEL", "L2")
    fm.reset()
    try:
        loaded = fm.load_problem_from_script(ROOT / "examples/fem_de_smoke_numeric.py", lightweight_assets=True)
        ir = loaded.stages[-1].problem.to_ir(requested_backend="fem", execution_mode="strict",
                                          execution_precision="double", include_geometry_assets=False)
    finally:
        fm.reset()
    meta = ir["problem_meta"]["runtime_metadata"]
    assert meta["de_smoke"]["through_thickness_elements"] == int(layers)
    assert meta["mesh_workflow"]["per_geometry"][0]["through_thickness_elements"] == int(layers)
    assert meta["de_smoke"]["magnetic_element_size_m"] == 5e-9
    assert meta["de_smoke"]["film_thickness_m"] == 10e-9
    assert meta["de_smoke"]["eigen_solver_rtol"] == 1e-8
    assert ir["study"]["operator"] == {"kind": "full_2x2", "include_demag": True}
    assert ir["materials"][0]["saturation_magnetisation"] == 800000
    assert ir["materials"][0]["exchange_stiffness"] == 13e-12
    assert next(t for t in ir["energy_terms"] if t["kind"] == "zeeman")["B"] == [0.1, 0, 0]


@pytest.mark.parametrize("layers", ["0", "4", "6.0", "true", "6;touch /tmp/unwanted"])
def test_invalid_thickness_request_fails_before_authoring(monkeypatch, layers):
    monkeypatch.setenv("FULLMAG_DE_SMOKE_THICKNESS_LAYERS", layers)
    fm.reset()
    try:
        with pytest.raises(Exception, match="Unsupported FULLMAG_DE_SMOKE_THICKNESS_LAYERS"):
            fm.load_problem_from_script(ROOT / "examples/fem_de_smoke_numeric.py", lightweight_assets=True)
    finally:
        fm.reset()
