import json
from pathlib import Path
import sys

import pytest

from plot_de_bv_dispersion_comparison import validate_selected_only_record


def test_plot_selected_only_rechecks_native_target_and_scope(tmp_path):
    run = Path(tmp_path)
    pilot = "de-smoke-k2"
    case = run / pilot
    (case / "eigen" / "diagnostics").mkdir(parents=True)
    job = {"job_id": "a" * 32, "source_digest": "b" * 64}
    model_source = {"commit": "c" * 40}
    source = {"snapshot": "d" * 64}
    target = 12.5e9
    mu0 = 4 * 3.141592653589793e-7
    external_induction = 0.1
    (run / "run-request.json").write_text(json.dumps({
        "schema": "fullmag.de-smoke.request.v1", "job": job,
        "model_source": model_source, "source": source, "model_sha256": "e" * 64,
        "cases": [pilot], "sampling": "k2",
        "operation": pilot + "-numerical-pilot", "modal_target": "nearest",
        "spectral_target": "nearest", "selection_scope": "selected_only",
        "window_complete": False, "target_frequency_hz": target,
        "thickness_layers_requested": "3"}))
    (run / "run-result.json").write_text(json.dumps({
        "schema": "fullmag.de-smoke.result.v1", "job": job,
        "model_source": model_source, "source": source, "model_sha256": "e" * 64,
        "pilot": pilot,
        "status": "completed_unqualified", "return_code": 0}))
    (case / "metadata.json").write_text(json.dumps({"problem_meta": {"runtime_metadata": {
        "de_smoke": {"modal_target": "nearest", "selection_scope": "selected_only",
                      "window_complete": False, "target_frequency_hz": target,
                      "mu0_t_m_a": mu0, "external_induction_t": external_induction,
                      "air_padding_each_side_m": 2e-6, "sampling": "k2",
                      "dispersion_geometry": "damon_eshbach",
                      "orientation": "M0=x,k=y,normal=z",
                      "k_vectors_rad_per_m": [[0.0, 2e6, 0.0]],
                      "film_thickness_m": 10e-9,
                      "exchange_stiffness_j_per_m": 13e-12,
                      "saturation_magnetization_a_per_m": 800000.0,
                      "gamma0_m_per_a_s": 221100.0}}}}))
    (case / "solver.v1.json").write_text(json.dumps({
        "target_kind": "nearest_frequency",
        "spectrum_completeness": "selected_only",
        "window_complete": False,
        "target_omega_rad_s": target * 2.0 * 3.141592653589793,
    }))
    (case / "eigen" / "diagnostics" / "solver.v1.json").write_text(
        (case / "solver.v1.json").read_text())
    (case / "eigen" / "modes" / "sample_0000").mkdir(parents=True)
    (case / "eigen" / "modes" / "sample_0000" / "mode_0000.json").write_text(
        json.dumps({"block_residuals": {"eps_full": 1e-10}}))
    record = {"run_path": str(run), "pilot": "de-smoke-k2", "geometry": "damon_eshbach",
              "k_rad_per_m": 2e6,
              "modal_target": "nearest", "selection_scope": "selected_only",
              "window_complete": False, "target_frequency_hz": target,
              "native_target_frequency_hz": target, "job": job,
              "model_source": model_source, "full_residual": 1e-10,
              "parameters": {"geometry": "damon_eshbach",
                             "bias_field_a_per_m": external_induction / mu0,
                             "mu0_t_m_a": mu0, "external_induction_t": external_induction,
                             "film_thickness_m": 10e-9,
                             "exchange_stiffness_j_per_m": 13e-12,
                             "saturation_magnetisation_a_per_m": 800000.0,
                             "gamma0_rad_s_per_a_m": 221100.0}}
    record["air_padding_each_side_m"] = 2e-6
    native = validate_selected_only_record(record)
    assert native["target_kind"] == "nearest_frequency"


@pytest.mark.parametrize(
    "mutation",
    [
        "window", "target", "mu0", "external_induction", "bias",
        "thickness", "exchange", "saturation", "gamma", "padding",
        "wavevector", "geometry",
    ],
)
def test_plot_selected_only_rejects_unqualified_record(tmp_path, mutation):
    run = Path(tmp_path)
    pilot = "de-smoke-k2"
    case = run / pilot
    (case / "eigen" / "diagnostics").mkdir(parents=True)
    job = {"job_id": "a" * 32, "source_digest": "b" * 64}
    model_source = {"commit": "c" * 40}
    source = {"snapshot": "d" * 64}
    target = 12.5e9
    mu0 = 4 * 3.141592653589793e-7
    external_induction = 0.1
    (run / "run-request.json").write_text(json.dumps({
        "schema": "fullmag.de-smoke.request.v1", "job": job,
        "model_source": model_source, "source": source, "model_sha256": "e" * 64,
        "cases": [pilot], "sampling": "k2",
        "operation": pilot + "-numerical-pilot", "modal_target": "nearest",
        "spectral_target": "nearest", "selection_scope": "selected_only",
        "window_complete": False, "target_frequency_hz": target,
        "thickness_layers_requested": "3"}))
    (run / "run-result.json").write_text(json.dumps({
        "schema": "fullmag.de-smoke.result.v1", "job": job,
        "model_source": model_source, "source": source, "model_sha256": "e" * 64,
        "pilot": pilot,
        "status": "completed_unqualified", "return_code": 0}))
    (case / "metadata.json").write_text(json.dumps({"problem_meta": {"runtime_metadata": {
        "de_smoke": {"modal_target": "nearest", "selection_scope": "selected_only",
                      "window_complete": False, "target_frequency_hz": target,
                      "mu0_t_m_a": mu0, "external_induction_t": external_induction,
                      "air_padding_each_side_m": 2e-6, "sampling": "k2",
                      "dispersion_geometry": "damon_eshbach",
                      "orientation": "M0=x,k=y,normal=z",
                      "k_vectors_rad_per_m": [[0.0, 2e6, 0.0]],
                      "film_thickness_m": 10e-9,
                      "exchange_stiffness_j_per_m": 13e-12,
                      "saturation_magnetization_a_per_m": 800000.0,
                      "gamma0_m_per_a_s": 221100.0}}}}))
    (case / "solver.v1.json").write_text(json.dumps({
        "target_kind": "nearest_frequency", "spectrum_completeness": "selected_only",
        "window_complete": False, "target_omega_rad_s": target * 2.0 * 3.141592653589793,
    }))
    (case / "eigen" / "diagnostics" / "solver.v1.json").write_text(
        (case / "solver.v1.json").read_text())
    (case / "eigen" / "modes" / "sample_0000").mkdir(parents=True)
    (case / "eigen" / "modes" / "sample_0000" / "mode_0000.json").write_text(
        json.dumps({"block_residuals": {"eps_full": 1e-10}}))
    record = {"run_path": str(run), "pilot": "de-smoke-k2", "geometry": "damon_eshbach",
              "k_rad_per_m": 2e6, "modal_target": "nearest",
              "selection_scope": "selected_only", "window_complete": False,
              "target_frequency_hz": target, "native_target_frequency_hz": target,
              "job": job, "model_source": model_source, "full_residual": 1e-10,
              "parameters": {"geometry": "damon_eshbach",
                             "bias_field_a_per_m": external_induction / mu0,
                             "mu0_t_m_a": mu0, "external_induction_t": external_induction,
                             "film_thickness_m": 10e-9,
                             "exchange_stiffness_j_per_m": 13e-12,
                             "saturation_magnetisation_a_per_m": 800000.0,
                             "gamma0_rad_s_per_a_m": 221100.0}}
    record["air_padding_each_side_m"] = 2e-6
    if mutation == "window":
        record["window_complete"] = True
    elif mutation == "target":
        record["native_target_frequency_hz"] = 13e9
    elif mutation == "mu0":
        record["parameters"]["mu0_t_m_a"] *= 1.001
    elif mutation == "external_induction":
        record["parameters"]["external_induction_t"] *= 1.001
    elif mutation == "bias":
        record["parameters"]["bias_field_a_per_m"] *= 1.001
    elif mutation == "thickness":
        record["parameters"]["film_thickness_m"] *= 1.001
    elif mutation == "exchange":
        record["parameters"]["exchange_stiffness_j_per_m"] *= 1.001
    elif mutation == "saturation":
        record["parameters"]["saturation_magnetisation_a_per_m"] *= 1.001
    elif mutation == "gamma":
        record["parameters"]["gamma0_rad_s_per_a_m"] *= 1.001
    elif mutation == "wavevector":
        record["k_rad_per_m"] *= 1.001
    elif mutation == "geometry":
        record["geometry"] = "backward_volume"
        record["parameters"]["geometry"] = "backward_volume"
    else:
        record["air_padding_each_side_m"] *= 1.001
    with pytest.raises(ValueError):
        validate_selected_only_record(record)


def test_plot_selected_only_uses_fresh_scope_and_schema(tmp_path, monkeypatch):
    import plot_de_bv_dispersion_comparison as plotting

    record = {
        "geometry": "damon_eshbach", "k_rad_per_m": 2e6, "frequency_hz": 9e9,
        "parameters": {"geometry": "damon_eshbach", "bias_field_a_per_m": 0.1 / (4 * 3.141592653589793e-7),
                       "mu0_t_m_a": 4 * 3.141592653589793e-7,
                       "external_induction_t": 0.1,
                       "film_thickness_m": 10e-9, "exchange_stiffness_j_per_m": 13e-12,
                       "saturation_magnetisation_a_per_m": 800000.0,
                       "gamma0_rad_s_per_a_m": 221100.0},
        "mesh_level": "L2", "run_path": str(tmp_path / "run"),
        "air_padding_each_side_m": 2e-6,
        "pilot": "de-smoke-k2", "selection_scope": "selected_only",
        "modal_target": "nearest", "window_complete": False,
        "target_frequency_hz": 10e9, "native_target_frequency_hz": 10e9,
        "full_residual": 1e-10, "job": {"job_id": "a" * 32},
        "model_source": {"commit": "b" * 40},
    }
    comparison = tmp_path / "comparison.json"
    comparison.write_text(json.dumps({"selection_scope": "selected_only", "records": [record]}))
    monkeypatch.setattr(plotting, "load_record",
                        lambda _: (None, None, None, None, {"mode": "c" * 64}, None))
    monkeypatch.setattr(plotting, "validate_selected_only_record",
                        lambda _record, _scope: {"target_frequency_hz": 10e9})
    monkeypatch.setattr(plotting, "solve_thickness_modes",
                        lambda **_kwargs: {"modes": [{"frequency_hz": 9e9}]})
    output = tmp_path / "plot"
    monkeypatch.setattr(sys, "argv", ["plot", "--comparison", str(comparison),
                                       "--output", str(output)])
    plotting.main()
    report = json.loads((output / "plot-receipt.json").read_text(encoding="utf-8"))
    assert report["schema"] == "fullmag.selected-de-bv-nearest-plot.v1"
    assert report["scope"].startswith("selected-only nearest FEM points")
    assert report["selection_scope"] == "selected_only"
    assert report["window_complete"] is False
    assert report["mirrored_samples"] is False
    assert report["analytic_reference_models"]["finite_dirichlet_n0"]["status"] == "available"
    assert report["references"][0]["finite_dirichlet_n0_frequency_hz"] is not None
