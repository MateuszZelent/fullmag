"""Signed-k contract tests; authoring/fixtures are not numerical FEM evidence."""
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages/fullmag-py/src"))
import fullmag as fm
from run_nonzero_k_validation_controller import validation_cases, prepare_controller_config
from run_de_100nm_pilot import PILOTS
from validate_de_smoke_rows import SAMPLING
from collect_de_bv_thickness_comparison import collect_record
from test_collect_de_bv_thickness_comparison import fixture_run


def test_signed_series_has_actual_paired_samples_and_retains_convergence():
    cases = validation_cases("signed-13")
    assert len(cases) == 30
    assert len({name for name, _, _ in cases}) == 30
    assert cases[0] == ("gamma-t3", "de-smoke-k0", "3")
    assert set(validation_cases("thickness")).issubset(cases)
    for prefix in ("", "bv-"):
        samplings = [PILOTS[pilot][1] for _, pilot, layers in cases
                     if layers == "3" and PILOTS[pilot][1].startswith("bv-") == bool(prefix)]
        assert len(samplings) == 13
        assert {SAMPLING[s][0] / 1e6 for s in samplings} == {0, -25, -20, -15, -10, -5, -2, 2, 5, 10, 15, 20, 25}
    with pytest.raises(ValueError):
        validation_cases("mirror")


@pytest.mark.parametrize("prefix", ["", "bv-"])
@pytest.mark.parametrize("value", [-25, -20, -15, -10, -5, -2, 0, 2, 5, 10, 15, 20, 25])
def test_actual_authoring_preserves_signed_vector_and_demag(monkeypatch, prefix, value):
    sampling = prefix + "k" + str(value)
    monkeypatch.setenv("FULLMAG_DE_SMOKE_SAMPLING", sampling)
    monkeypatch.setenv("FULLMAG_DE_SMOKE_MESH_LEVEL", "L2")
    fm.reset()
    try:
        loaded = fm.load_problem_from_script(ROOT / "examples/fem_de_smoke_numeric.py", lightweight_assets=True)
        ir = loaded.stages[-1].problem.to_ir(requested_backend="fem", execution_mode="strict",
            execution_precision="double", include_geometry_assets=False)
    finally:
        fm.reset()
    vector = [value * 1e6, 0, 0] if prefix else [0, value * 1e6, 0]
    assert ir["study"]["k_sampling"] == {"kind": "single", "k_vector": vector}
    assert ir["study"]["operator"]["include_demag"] is True
    assert ir["study"]["count"] == 1
    assert ir["study"]["magnetostatic_bc"] == ("periodic_airbox_k0" if value == 0 else "floquet_airbox")
    assert ir["study"]["target"]["frequency_max_hz"] == (16e9 if not prefix and abs(value) >= 15 else 12e9)
    assert SAMPLING[sampling] == (value * 1e6,)


@pytest.mark.parametrize("geometry,prefix", [("damon_eshbach", ""), ("backward_volume", "bv-")])
def test_collector_keeps_negative_coordinate_and_checks_requested_sign(tmp_path, geometry, prefix):
    job, result = fixture_run(tmp_path, geometry)
    original = result["pilot"]
    pilot = "de-smoke-" + prefix + "k-20"
    (tmp_path / original).rename(tmp_path / pilot)
    result["pilot"] = pilot
    (tmp_path / "run-result.json").write_text(json.dumps(result))
    csv = tmp_path / pilot / "eigen/dispersion.csv"
    csv.write_text(csv.read_text().replace("25000000.0", "-20000000.0"))
    with patch("collect_de_bv_thickness_comparison.validate_rows"), \
         patch("collect_de_bv_thickness_comparison.validate_thickness_layers_metadata", return_value={}), \
         patch("collect_de_bv_thickness_comparison.load_record", return_value=(SimpleNamespace(nodes=np.zeros((4,3))), None, np.array([[0,1,2,3]]), None, {}, .999)):
        record = collect_record(tmp_path, 3, job, sampling=prefix + "k-20")
        assert record["k_rad_per_m"] == -20e6
        assert record["geometry"] == geometry
        csv.write_text(csv.read_text().replace("-20000000.0", "20000000.0"))
        with pytest.raises(ValueError, match="signed wavevector"):
            collect_record(tmp_path, 3, job, sampling=prefix + "k-20")


def signed_controller_fixture(tmp_path):
    storage = tmp_path
    tmp_path = storage / "runs/test-wt/scientific-batches/nonzero-k-validation" / ("a" * 32)
    tmp_path.mkdir(parents=True)
    capsule_relative = "runs/test-wt/" + "d" * 32 + "/source"
    capsule = storage / capsule_relative / "tree"
    source = capsule / "scripts/run_nonzero_k_validation_controller.py"
    source.parent.mkdir(parents=True)
    source.write_bytes((ROOT / "scripts/run_nonzero_k_validation_controller.py").read_bytes())
    from compare_de_bv_mode_profiles import sha256
    job = {"job_id": "a" * 32, "source_digest": "b" * 64}
    config = {**job, "model_ref": "c" * 40, "series": "signed-13",
              "capsule": str(capsule), "controller_sha256": sha256(source)}
    (tmp_path / "controller-config.json").write_text(json.dumps(config))
    results = []
    for name, pilot, layers in validation_cases("signed-13"):
        output = tmp_path / name
        output.mkdir()
        (output / "run-request.json").write_text(json.dumps({"job": job, "source": {"capsule_relative": capsule_relative}}))
        results.append({"case": name, "wrapper_exit": 0, "output": str(output.resolve())})
    control = tmp_path / "controller-results.json"
    control.write_text(json.dumps({**job, "results": results}))
    return control


@pytest.mark.parametrize("relative_k_offset", [0.0, 2e-13])
def test_signed_collector_measures_asymmetry_without_reflecting_frequencies(tmp_path, relative_k_offset):
    from collect_signed_de_bv_dispersion import collect
    control = signed_controller_fixture(tmp_path)

    def accepted_record(output, layers, job, *, sampling):
        k = SAMPLING[sampling][0]
        return {"geometry": "backward_volume" if sampling.startswith("bv-") else "damon_eshbach",
                "k_rad_per_m": k * (1 + relative_k_offset), "frequency_hz": 12e9 if k < 0 else 13e9,
                "model_source": {"commit": "c" * 40}, "parameters": {"Ms": 800000},
                "mesh_level": "L2", "air_padding_each_side_m": 2e-6,
                "magnetic_xy_sha256": "d" * 64}

    from compare_de_bv_mode_profiles import sha256
    with patch("collect_signed_de_bv_dispersion.collect_record", side_effect=accepted_record) as reader, \
         patch("collect_signed_de_bv_dispersion.collect_control", return_value={"controller_config_sha256": sha256(control.parent / "controller-config.json")}) as convergence:
        report = collect(control)
    convergence.assert_called_once_with(control.parent / "convergence-results.json")
    assert reader.call_count == 26
    assert len(report["records"]) == 26
    assert len(report["symmetry_measurements"]) == 12
    assert all(r["signed_difference_hz"] == 1e9 for r in report["symmetry_measurements"])
    assert report["qualification"] == "NOT VERIFIED"


@pytest.mark.parametrize("mutation", ["missing", "duplicate", "failed", "outside", "identity"])
def test_signed_collector_rejects_incomplete_or_unbound_series(tmp_path, mutation):
    from collect_signed_de_bv_dispersion import collect
    control = signed_controller_fixture(tmp_path)
    data = json.loads(control.read_text())
    if mutation == "missing": data["results"].pop()
    if mutation == "duplicate": data["results"][-1]["case"] = data["results"][0]["case"]
    if mutation == "failed": data["results"][0]["wrapper_exit"] = 1
    if mutation == "outside": data["results"][0]["output"] = str(tmp_path.parent.resolve())
    if mutation == "identity": data["source_digest"] = "d" * 64
    control.write_text(json.dumps(data))
    # Other cases must not fail earlier merely because this fixture has no FEM files.
    def record(*args, **kwargs):
        sampling = kwargs["sampling"]
        return {"geometry": "backward_volume" if sampling.startswith("bv-") else "damon_eshbach",
                "k_rad_per_m": SAMPLING[sampling][0], "frequency_hz": 10e9,
                "model_source": {"commit": "c" * 40}, "parameters": {},
                "mesh_level": "L2", "air_padding_each_side_m": 2e-6,
                "magnetic_xy_sha256": "d" * 64}
    with patch("collect_signed_de_bv_dispersion.collect_record", side_effect=record):
        with pytest.raises(ValueError): collect(control)


@pytest.mark.parametrize("mutation", ["hash", "capsule", "missing_convergence", "different_convergence_config"])
def test_signed_collector_requires_controller_and_separate_convergence_binding(tmp_path, mutation):
    from collect_signed_de_bv_dispersion import collect
    from compare_de_bv_mode_profiles import sha256
    control = signed_controller_fixture(tmp_path)
    config_path = control.parent / "controller-config.json"
    config = json.loads(config_path.read_text())
    if mutation == "hash":
        config["controller_sha256"] = "e" * 64
        config_path.write_text(json.dumps(config))
    if mutation == "capsule":
        request_path = control.parent / "gamma-t3/run-request.json"
        request = json.loads(request_path.read_text())
        request["source"]["capsule_relative"] = "runs/test-wt/" + "e" * 32 + "/source"
        request_path.write_text(json.dumps(request))

    def record(*args, **kwargs):
        sampling = kwargs["sampling"]
        return {"geometry": "backward_volume" if sampling.startswith("bv-") else "damon_eshbach",
                "k_rad_per_m": SAMPLING[sampling][0], "frequency_hz": 10e9,
                "model_source": {"commit": "c" * 40}, "parameters": {},
                "mesh_level": "L2", "air_padding_each_side_m": 2e-6,
                "magnetic_xy_sha256": "d" * 64}
    convergence = {"controller_config_sha256": "f" * 64 if mutation == "different_convergence_config" else sha256(config_path)}
    error = FileNotFoundError("missing convergence results") if mutation == "missing_convergence" else None
    with patch("collect_signed_de_bv_dispersion.collect_record", side_effect=record), \
         patch("collect_signed_de_bv_dispersion.collect_control", return_value=convergence, side_effect=error):
        with pytest.raises((ValueError, FileNotFoundError)):
            collect(control)


def test_signed_collector_rejects_copied_controller_under_another_job(tmp_path):
    from collect_signed_de_bv_dispersion import collect
    control = signed_controller_fixture(tmp_path)
    other_root = control.parent.parent / ("e" * 32)
    control.parent.rename(other_root)
    with pytest.raises(ValueError, match="canonical batch"):
        collect(other_root / "controller-results.json")
