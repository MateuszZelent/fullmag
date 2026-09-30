"""Check DE/BV 25 rad/um inputs through the public DSL and ProblemIR."""
import sys
from pathlib import Path
import pytest
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages/fullmag-py/src"))
import fullmag as fm

@pytest.mark.parametrize("sampling,vector,window", [
    ("k25", [0,25e6,0], (12e9,16e9)),
    ("bv-k25", [25e6,0,0], (8.5e9,12e9)),
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
    assert study["magnetostatic_bc"]=="floquet_airbox"
    assert next(t for t in ir["energy_terms"] if t["kind"]=="zeeman")["B"]==[0.1,0,0]
    assert ir["materials"][0]["saturation_magnetisation"]==800000
    assert ir["materials"][0]["exchange_stiffness"]==13e-12
    meta=ir["problem_meta"]["runtime_metadata"]["de_smoke"]
    assert meta["k_vectors_rad_per_m"]==[vector]
    assert meta["eigen_solver_rtol"]==1e-8
    assert meta["film_thickness_m"]==10e-9
