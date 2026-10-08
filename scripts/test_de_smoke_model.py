"""Public DSL to IR regression for the frozen, demagnetizing DE smoke case."""
from pathlib import Path
import math
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages/fullmag-py/src"))
import fullmag as fm


@pytest.mark.parametrize("sampling,ky,mode_count", [
    ("two", [0, 2e6], 4),
    ("five", [0, 1e6, 2e6, 3e6, 5e6], 4),
    ("k2", [2e6], 1),
    ("k25", [25e6], 1),
    ("bv-k25", [25e6], 1),
    ("k0", [0], 1),
    ("signed-eleven", [-3e6, -2e6, -1.5e6, -1e6, -0.5e6, 0, 0.5e6,
                       1e6, 1.5e6, 2e6, 3e6], 1),
])
def test_de_smoke_preserves_physical_problem(monkeypatch, sampling, ky, mode_count):
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SAMPLING", sampling)
    monkeypatch.delenv("FULLMAG_DE_SMOKE_SOLVER_RTOL", raising=False)
    monkeypatch.delenv("FULLMAG_DE_SMOKE_MODAL_TARGET", raising=False)
    monkeypatch.delenv("FULLMAG_DE_SMOKE_TARGET_FREQUENCY_GHZ", raising=False)
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
    assert loaded.stages[1].stage_id == "modes"
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
    engine_source = (ROOT / "crates/fullmag-engine/src/lib.rs").read_text(encoding="utf-8")
    assert "pub const MU0: f64 = 4.0 * PI * 1e-7;" in engine_source
    assert meta["de_smoke"]["mu0_t_m_a"] == 4.0 * math.pi * 1e-7
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
    assert e["target"] == {"kind": "frequency_window", "frequency_min_hz": 12e9 if sampling == "k25" else 8.5e9, "frequency_max_hz": 16e9 if sampling == "k25" else 12e9}
    assert e["equilibrium"] == {"kind": "relaxed_initial_state"}
    assert e["damping_policy"] == "ignore"
    assert e["magnetostatic_bc"] == ("periodic_airbox_k0" if sampling == "k0" else "floquet_airbox")
    expected_bc = {"kind": "periodic", "pair_ids": ["x_faces", "y_faces"]} if sampling == "k0" else {
        "kind": "floquet", "pair_ids": ["x_faces", "y_faces"],
        "phase_convention": "exp_minus_i_k_dot_delta_r"}
    assert e["spin_wave_bc"] == expected_bc
    if sampling in ("k0", "k2", "k25", "bv-k25"):
        expected_vector = [ky[0], 0, 0] if sampling == "bv-k25" else [0, ky[0], 0]
        assert e["k_sampling"] == {"kind": "single", "k_vector": expected_vector}
        assert meta["de_smoke"]["k_vectors_rad_per_m"] == [expected_vector]
        assert meta["de_smoke"]["orientation"] == ("M0=x,k=x,normal=z" if sampling == "bv-k25" else "M0=x,k=y,normal=z")
    else:
        assert [p["k_vector"] for p in e["k_sampling"]["points"]] == [[0, k, 0] for k in ky]
        assert e["k_sampling"]["samples_per_segment"] == [1] * (len(ky) - 1)
    mode = next(o for o in e["sampling"]["outputs"] if o["kind"] == "eigen_mode")
    assert mode["indices"] == list(range(mode_count))
    assert mode["sample_selector"]["sample_indices"] == list(range(len(ky)))
    assert "dispersion_validation" not in meta


def test_ui_seven_is_a_nearest_selected_only_k_path_with_one_mode(monkeypatch):
    ky = [-25e6, -15e6, -5e6, 0.0, 5e6, 15e6, 25e6]
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SAMPLING", "ui-seven")
    monkeypatch.delenv("FULLMAG_DE_SMOKE_MODAL_TARGET", raising=False)
    monkeypatch.delenv("FULLMAG_DE_SMOKE_TARGET_FREQUENCY_GHZ", raising=False)
    monkeypatch.delenv("FULLMAG_DE_SMOKE_SOLVER_RTOL", raising=False)
    fm.reset()
    try:
        loaded = fm.load_problem_from_script(
            ROOT / "examples/fem_de_smoke_numeric.py", lightweight_assets=True)
        eigen = loaded.stages[-1].problem.to_ir(
            requested_backend="fem", execution_mode="strict",
            execution_precision="double", include_geometry_assets=False)
    finally:
        fm.reset()

    study = eigen["study"]
    metadata = eigen["problem_meta"]["runtime_metadata"]["de_smoke"]
    vectors = [[0.0, value, 0.0] for value in ky]
    assert study["target"] == {"kind": "nearest", "frequency_hz": 10.0e9}
    assert study["count"] == 1
    assert [point["k_vector"] for point in study["k_sampling"]["points"]] == vectors
    assert study["k_sampling"]["samples_per_segment"] == [1] * 6
    mode = next(output for output in study["sampling"]["outputs"] if output["kind"] == "eigen_mode")
    assert mode["indices"] == [0]
    assert mode["sample_selector"]["sample_indices"] == list(range(7))
    assert metadata["sampling"] == "ui-seven"
    assert metadata["k_vectors_rad_per_m"] == vectors
    assert metadata["requested_mode_count"] == 1
    assert metadata["eigen_solver_rtol"] == 1e-8
    assert metadata["modal_target"] == "nearest"
    assert metadata["target_frequency_hz"] == 10.0e9
    assert metadata["selection_scope"] == "selected_only"
    assert metadata["window_complete"] is False
    assert metadata["frequency_window_hz"] is None
    assert metadata["qualification"] == "NOT VERIFIED"
    assert metadata["purpose"] == "ui_diagnostic"
    assert metadata["branch_continuity"] == "NOT VERIFIED"
    assert "dispersion_validation" not in metadata


@pytest.mark.parametrize(("environment", "message"), [
    ({"FULLMAG_DE_SMOKE_MODAL_TARGET": "frequency_window"}, "ui-seven requires a nearest"),
    ({"FULLMAG_DE_SMOKE_SOLVER_RTOL": "1e-7"}, "ui-seven requires FULLMAG_DE_SMOKE_SOLVER_RTOL exactly 1e-8"),
])
def test_ui_seven_rejects_window_claims_and_tolerance_changes(monkeypatch, environment, message):
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SAMPLING", "ui-seven")
    monkeypatch.delenv("FULLMAG_DE_SMOKE_MODAL_TARGET", raising=False)
    monkeypatch.delenv("FULLMAG_DE_SMOKE_SOLVER_RTOL", raising=False)
    for name, value in environment.items():
        monkeypatch.setenv(name, value)
    fm.reset()
    try:
        with pytest.raises(ValueError, match=message):
            fm.load_problem_from_script(
                ROOT / "examples/fem_de_smoke_numeric.py", lightweight_assets=True)
    finally:
        fm.reset()


def test_nearest_single_k_target_is_explicitly_selected_only(monkeypatch):
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SAMPLING", "k2")
    monkeypatch.setenv("FULLMAG_DE_SMOKE_MODAL_TARGET", "nearest")
    monkeypatch.setenv("FULLMAG_DE_SMOKE_TARGET_FREQUENCY_GHZ", "10.0")
    fm.reset()
    try:
        loaded = fm.load_problem_from_script(
            ROOT / "examples/fem_de_smoke_numeric.py", lightweight_assets=True)
        eigen = loaded.stages[-1].problem.to_ir(
            requested_backend="fem", execution_mode="strict",
            execution_precision="double", include_geometry_assets=False)
    finally:
        fm.reset()
    study = eigen["study"]
    metadata = eigen["problem_meta"]["runtime_metadata"]["de_smoke"]
    assert study["count"] == 1
    assert study["target"] == {"kind": "nearest", "frequency_hz": 10.0e9}
    assert metadata["modal_target"] == "nearest"
    assert metadata["target_frequency_hz"] == 10.0e9
    assert metadata["selection_scope"] == "selected_only"
    assert metadata["window_complete"] is False
    assert metadata["frequency_window_hz"] is None
    assert metadata["k_vectors_rad_per_m"] == [[0.0, 2.0e6, 0.0]]


@pytest.mark.parametrize("target", ["0", "-1", "nan", "inf", "-inf", "1e308", "not-a-number"])
def test_nearest_target_rejects_nonpositive_nonfinite_or_invalid_frequency(monkeypatch, target):
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SAMPLING", "k2")
    monkeypatch.setenv("FULLMAG_DE_SMOKE_MODAL_TARGET", "nearest")
    monkeypatch.setenv("FULLMAG_DE_SMOKE_TARGET_FREQUENCY_GHZ", target)
    fm.reset()
    try:
        with pytest.raises(ValueError, match="FULLMAG_DE_SMOKE_TARGET_FREQUENCY_GHZ"):
            fm.load_problem_from_script(
                ROOT / "examples/fem_de_smoke_numeric.py", lightweight_assets=True)
    finally:
        fm.reset()


def test_nearest_target_rejects_multi_k_sampling(monkeypatch):
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SAMPLING", "two")
    monkeypatch.setenv("FULLMAG_DE_SMOKE_MODAL_TARGET", "nearest")
    monkeypatch.setenv("FULLMAG_DE_SMOKE_TARGET_FREQUENCY_GHZ", "10.0")
    fm.reset()
    try:
        with pytest.raises(ValueError, match="single-k"):
            fm.load_problem_from_script(
                ROOT / "examples/fem_de_smoke_numeric.py", lightweight_assets=True)
    finally:
        fm.reset()


def test_invalid_sampling_is_rejected(monkeypatch):
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SAMPLING", "61")
    fm.reset()
    try:
        with pytest.raises(Exception, match="FULLMAG_DE_SMOKE_SAMPLING"):
            fm.load_problem_from_script(ROOT / "examples/fem_de_smoke_numeric.py", lightweight_assets=True)
    finally:
        fm.reset()


def test_de100_comparison_metadata_matches_lowered_physics():
    fm.reset()
    try:
        loaded = fm.load_problem_from_script(
            ROOT / "examples/fem_de_film_100nm_numeric_pilot.py", lightweight_assets=True)
        ir = loaded.stages[-1].problem.to_ir(
            requested_backend="fem", execution_mode="strict",
            execution_precision="double", include_geometry_assets=False)
    finally:
        fm.reset()


    meta = ir["problem_meta"]["runtime_metadata"]
    model = meta["de_100nm_numeric_pilot"]
    material = ir["materials"][0]
    assert model["schema"] == "fullmag.de100-pilot.v1"
    assert model["saturation_magnetization_a_per_m"] == material["saturation_magnetisation"]
    assert model["exchange_stiffness_j_per_m"] == material["exchange_stiffness"]
    assert model["gamma0_m_per_a_s"] == ir["study"]["dynamics"]["gyromagnetic_ratio"]
    field = next(t for t in ir["energy_terms"] if t["kind"] == "zeeman")["B"]
    assert field == [model["external_induction_t"], 0, 0]
    assert model["film_thickness_m"] == ir["geometry"]["entries"][0]["size"][2]
    height = meta["study_universe"]["size"][2]
    assert (height-model["film_thickness_m"])/2 == pytest.approx(model["air_padding_each_side_m"])
    demag = next(t for t in ir["energy_terms"] if t["kind"] == "demag")
    assert model["outer_boundary_kind"] == demag["realization"]
    sampling = ir["study"]["k_sampling"]
    points = sampling["points"]
    ky = []
    for j, count in enumerate(sampling["samples_per_segment"]):
        first, last = points[j]["k_vector"][1], points[j+1]["k_vector"][1]
        ky.extend(first+(last-first)*i/count for i in range(count))
    ky.append(points[-1]["k_vector"][1])
    assert model["ky_rad_per_m"] == ky


@pytest.mark.parametrize("requested,expected", [("1e-8", 1e-8), ("1e-7", 1e-7), ("1e-6", 1e-6)])
def test_k2_tolerance_sweep_is_explicit_in_ir(monkeypatch, requested, expected):
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SAMPLING", "k2")
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SOLVER_RTOL", requested)
    fm.reset()
    try:
        loaded = fm.load_problem_from_script(ROOT / "examples/fem_de_smoke_numeric.py", lightweight_assets=True)
        ir = loaded.stages[-1].problem.to_ir(
            requested_backend="fem", execution_mode="strict",
            execution_precision="double", include_geometry_assets=False)
    finally:
        fm.reset()
    metadata = ir["problem_meta"]["runtime_metadata"]
    assert metadata["de_smoke"]["eigen_solver_rtol"] == expected
    assert metadata["modal_solver_policy"]["residual_tolerance"] == expected


def test_invalid_tolerance_sweep_is_rejected(monkeypatch):
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SOLVER_RTOL", "0.01")
    fm.reset()
    try:
        with pytest.raises(Exception, match="FULLMAG_DE_SMOKE_SOLVER_RTOL"):
            fm.load_problem_from_script(ROOT / "examples/fem_de_smoke_numeric.py", lightweight_assets=True)
    finally:
        fm.reset()


def test_dense_oracle_is_explicitly_bounded_to_k2_pilot(monkeypatch):
    sys.path.insert(0, str(ROOT / "scripts"))
    import run_de_100nm_pilot as pilot

    monkeypatch.setattr(
        pilot.managed, "_compose_command",
        lambda *_args, **_kwargs: ["docker", "run", "placeholder"],
    )
    command = pilot.compose_command(None, ROOT, pilot="de-smoke-k2", dense_oracle=True)
    assert "export FULLMAG_FLOQUET_DENSE_ORACLE=1" in command[-1]
    ordinary = pilot.compose_command(None, ROOT, pilot="de-smoke-k2")
    assert "FULLMAG_FLOQUET_DENSE_ORACLE" not in ordinary[-1]
    with pytest.raises(pilot.managed.BenchmarkError, match="restricted"):
        pilot.compose_command(None, ROOT, pilot="de-smoke-five", dense_oracle=True)
    tolerance_command = pilot.compose_command(None, ROOT, pilot="de-smoke-k2", solver_rtol="1e-7")
    assert "export FULLMAG_DE_SMOKE_SOLVER_RTOL=1e-7" in tolerance_command[-1]
    with pytest.raises(pilot.managed.BenchmarkError, match="restricted"):
        pilot.compose_command(None, ROOT, pilot="de-smoke-five", solver_rtol="1e-7")
    with pytest.raises(pilot.managed.BenchmarkError, match="unsupported"):
        pilot.compose_command(None, ROOT, pilot="de-smoke-k2", solver_rtol="0.01")
    independent = pilot.compose_command(
        None, ROOT, pilot="de-smoke-k2",
        eps_prefilter="1e-8", shifted_ksp_rtol="1e-11")
    assert "export FULLMAG_FLOQUET_EPS_PREFILTER_ABS=1e-8" in independent[-1]
    assert "export FULLMAG_FLOQUET_SHIFTED_KSP_RTOL=1e-11" in independent[-1]
    assert "FULLMAG_DE_SMOKE_SOLVER_RTOL" not in independent[-1]
    restart_command = pilot.compose_command(
        None, ROOT, pilot="de-smoke-k2", gmres_restart="10")
    assert "export FULLMAG_FLOQUET_GMRES_RESTART=10" in restart_command[-1]
    assert "FULLMAG_FLOQUET_GMRES_RESTART" not in ordinary[-1]
    multi_point = pilot.compose_command(
        None, ROOT, pilot="de-smoke-five", gmres_restart="10")
    assert "export FULLMAG_FLOQUET_GMRES_RESTART=10" in multi_point[-1]
    with pytest.raises(pilot.managed.BenchmarkError, match="restricted"):
        pilot.compose_command(None, ROOT, pilot="de100", gmres_restart="10")
    with pytest.raises(pilot.managed.BenchmarkError, match="unsupported"):
        pilot.compose_command(None, ROOT, pilot="de-smoke-k2", gmres_restart="100")
    multi_eps = pilot.compose_command(None, ROOT, pilot="de-smoke-five", eps_prefilter="1e-8")
    assert "export FULLMAG_FLOQUET_EPS_PREFILTER_ABS=1e-8" in multi_eps[-1]
    with pytest.raises(pilot.managed.BenchmarkError, match="unsupported"):
        pilot.compose_command(None, ROOT, pilot="de-smoke-k2", shifted_ksp_rtol="0.01")


@pytest.mark.parametrize("sampling,vector", [("k10", [0, 1e7, 0]), ("k-10", [0, -1e7, 0])])
def test_explicit_window_preserves_signed_numeric_demag_model(monkeypatch, sampling, vector):
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SAMPLING", sampling)
    monkeypatch.setenv("FULLMAG_DE_SMOKE_MODAL_TARGET", "frequency_window")
    monkeypatch.setenv("FULLMAG_DE_SMOKE_FREQUENCY_MIN_GHZ", "10.9")
    monkeypatch.setenv("FULLMAG_DE_SMOKE_FREQUENCY_MAX_GHZ", "11.5")
    fm.reset()
    try:
        loaded = fm.load_problem_from_script(ROOT / "examples/fem_de_smoke_numeric.py", lightweight_assets=True)
        ir = loaded.stages[-1].problem.to_ir(requested_backend="fem", execution_mode="strict", execution_precision="double", include_geometry_assets=False)
    finally:
        fm.reset()
    assert ir["study"]["target"] == {"kind": "frequency_window", "frequency_min_hz": 10.9e9, "frequency_max_hz": 11.5e9}
    assert ir["study"]["operator"] == {"kind": "full_2x2", "include_demag": True}
    assert ir["study"]["magnetostatic_bc"] == "floquet_airbox"
    assert ir["study"]["k_sampling"] == {"kind": "single", "k_vector": vector}
    assert ir["problem_meta"]["runtime_metadata"]["de_smoke"]["frequency_window_hz"] == [10.9e9, 11.5e9]
    assert sorted(term["kind"] for term in ir["energy_terms"]) == ["demag", "exchange", "zeeman"]


@pytest.mark.parametrize("lower,upper,target", [("10.9", None, "frequency_window"), (None, "11.5", "frequency_window"), ("nan", "11.5", "frequency_window"), ("10.9", "inf", "frequency_window"), ("0", "11.5", "frequency_window"), ("-1", "11.5", "frequency_window"), ("12", "11.5", "frequency_window"), ("11.5", "11.5", "frequency_window"), ("10.9", "1e308", "frequency_window"), ("bad", "11.5", "frequency_window"), ("10.9", "11.5", "nearest")])
def test_explicit_window_rejects_invalid_or_incompatible_bounds(monkeypatch, lower, upper, target):
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SAMPLING", "k10")
    monkeypatch.setenv("FULLMAG_DE_SMOKE_MODAL_TARGET", target)
    for key, value in (("FULLMAG_DE_SMOKE_FREQUENCY_MIN_GHZ", lower), ("FULLMAG_DE_SMOKE_FREQUENCY_MAX_GHZ", upper)):
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, value)
    fm.reset()
    try:
        with pytest.raises(ValueError, match="FULLMAG_DE_SMOKE_FREQUENCY"):
            fm.load_problem_from_script(ROOT / "examples/fem_de_smoke_numeric.py", lightweight_assets=True)
    finally:
        fm.reset()
