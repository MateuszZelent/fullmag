"""Synthetic artifact gates and public IR for the dense numerical film grid.

These tests do not solve FEM or provide frequency/physics qualification.
"""
import copy
import json
from pathlib import Path
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "packages/fullmag-py/src"))
import fullmag as fm
import run_de_100nm_pilot as pilot
from validate_de_smoke_rows import validate_rows
import test_validate_de_smoke_rows as fixtures


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


def dense_artifacts(root, sampling):
    rows = fixtures.rows(sampling)
    if sampling.startswith("bv-"):
        for row in rows:
            row["kx_rad_per_m"], row["ky_rad_per_m"] = row["ky_rad_per_m"], 0
    rows[-1]["frequency_hz"] = 9.7e9 if sampling.startswith("bv-") else 13.6e9
    csv = root / "dispersion.csv"; fixtures.write(csv, rows)
    diagnostics = root / "solver.v1.json"; fixtures.write_diagnostics(diagnostics, sampling)
    metadata = root / "metadata.json"; fixtures.write_metadata(metadata)
    data = json.loads(metadata.read_text(encoding="utf-8"))
    model = data["problem_meta"]["runtime_metadata"]["de_smoke"]
    model.update(sampling=sampling, orientation="M0=x,k=x,normal=z" if sampling.startswith("bv-") else "M0=x,k=y,normal=z",
                 k_vectors_rad_per_m=[[r["kx_rad_per_m"],r["ky_rad_per_m"],0] for r in rows])
    metadata.write_text(json.dumps(data), encoding="utf-8")
    spectrum = root / "spectrum.v3.json"; fixtures.write_spectrum_v3(spectrum, sampling)
    data = json.loads(spectrum.read_text(encoding="utf-8"))
    temporary_template = root / "floquet-template.json"; fixtures.write_full_floquet_spectrum(temporary_template)
    template = json.loads(temporary_template.read_text(encoding="utf-8"))["samples"][0]["modes"][0]
    for index, sample in enumerate(data["samples"]):
        if index:
            sample["modes"] = [copy.deepcopy(template)]
            sample["modes"][0]["sample_index"] = index
        sample["modes"][0]["frequency_hz"] = rows[index]["frequency_hz"]
    spectrum.write_text(json.dumps(data), encoding="utf-8")
    return csv, diagnostics, metadata, spectrum, rows


@pytest.mark.parametrize("sampling", ["positive-26", "bv-positive-26"])
def test_dense_rows_require_all_26_full_certificates(tmp_path, sampling):
    csv, diagnostics, metadata, spectrum, rows = dense_artifacts(tmp_path, sampling)
    result = validate_rows(csv, sampling, diagnostics, metadata)
    assert result["sample_count"] == result["mode_rows"] == 26
    assert result["full_descriptor_certified"] is True
    assert len(result["dynamic_demag_operator_probes"]) == 25
    assert result["gamma_demag_operator_probe"]["status"] == "passed"
    assert result["qualification"] == "NOT VERIFIED"
    data = json.loads(spectrum.read_text(encoding="utf-8"))
    legacy = tmp_path / "legacy-spectrum.json"; fixtures.write_spectrum_v3(legacy, sampling)
    data["samples"][1]["modes"] = json.loads(legacy.read_text(encoding="utf-8"))["samples"][1]["modes"]
    spectrum.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError, match="full descriptor"):
        validate_rows(csv, sampling, diagnostics, metadata)


@pytest.mark.parametrize("mutation", ["missing_point", "missing_gamma_probe", "wrong_direction"])
def test_dense_series_rejects_missing_or_mismatched_samples(tmp_path, mutation):
    csv, diagnostics, metadata, spectrum, rows = dense_artifacts(tmp_path, "positive-26")
    if mutation == "missing_point":
        fixtures.write(csv, rows[:-1])
    elif mutation == "wrong_direction":
        rows[1]["kx_rad_per_m"],rows[1]["ky_rad_per_m"] = 1e6,0
        fixtures.write(csv, rows)
    else:
        data = json.loads(diagnostics.read_text(encoding="utf-8"))
        data["sample_solver_diagnostics"] = data["sample_solver_diagnostics"][1:]
        diagnostics.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError):
        validate_rows(csv, "positive-26", diagnostics, metadata)


@pytest.mark.parametrize("sampling", ["positive-26", "bv-positive-26"])
@pytest.mark.parametrize("mutation", ["loose_certificate", "native_nonzero_scope", "floquet_gamma_scope", "extra_sample", "extra_mode", "wrong_sample_count", "duplicate_sample", "wrong_boundary", "wrong_gauge"])
def test_dense_certificate_inventory_and_scope_are_strict(tmp_path, sampling, mutation):
    csv, diagnostics, metadata, spectrum, rows = dense_artifacts(tmp_path, sampling)
    data = json.loads(spectrum.read_text(encoding="utf-8"))
    if mutation == "loose_certificate":
        mode = data["samples"][0]["modes"][0]
        mode["residual_relative_l2"] = 2e-7
        mode["block_residuals"].update(eps_q=2e-7, eps_phi=2e-7,
                                     eps_full=2e-7, certification_tolerance=1e-6)
        meta = json.loads(metadata.read_text(encoding="utf-8"))
        meta["problem_meta"]["runtime_metadata"]["de_smoke"]["eigen_solver_rtol"] = 1e-6
        metadata.write_text(json.dumps(meta), encoding="utf-8")
    elif mutation in ("native_nonzero_scope", "floquet_gamma_scope"):
        target, source = (1, 0) if mutation == "native_nonzero_scope" else (0, 1)
        mode = copy.deepcopy(data["samples"][source]["modes"][0])
        mode.update(sample_index=target, frequency_hz=rows[target]["frequency_hz"])
        data["samples"][target]["modes"] = [mode]
    elif mutation in ("wrong_boundary", "wrong_gauge"):
        mode = data["samples"][1]["modes"][0]
        key, value = (("poisson_boundary_kind", "poisson_robin") if mutation == "wrong_boundary" else
                      ("poisson_gauge_policy", "mean_zero"))
        mode[key] = value
    elif mutation == "extra_sample":
        record = copy.deepcopy(data["samples"][0])
        record["sample_index"] = 26
        record["modes"][0]["sample_index"] = 26
        data["samples"].append(record)
        data["sample_count"] = 27
    elif mutation == "extra_mode":
        mode = copy.deepcopy(data["samples"][1]["modes"][0])
        mode["raw_mode_index"] = 1
        data["samples"][1]["modes"].append(mode)
    elif mutation == "duplicate_sample":
        record = copy.deepcopy(data["samples"][1])
        record["modes"][0]["raw_mode_index"] = 99
        data["samples"].append(record)
        data["sample_count"] = 27
    else:
        data["sample_count"] = 99
    spectrum.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ValueError):
        validate_rows(csv, sampling, diagnostics, metadata)


def test_nonzero_metadata_object_is_required(tmp_path):
    csv, diagnostics, metadata, spectrum, rows = dense_artifacts(tmp_path, "positive-26")
    fixtures.write(csv, [dict(rows[1], sample_index=0)])
    fixtures.write_diagnostics(diagnostics, "k1")
    fixtures.write_spectrum_v3(spectrum, "k1")
    metadata.write_text(json.dumps({"problem_meta": {"runtime_metadata": {"de_smoke": []}}}), encoding="utf-8")
    with pytest.raises(ValueError, match="model descriptor"):
        validate_rows(csv, "k1", diagnostics, metadata)
