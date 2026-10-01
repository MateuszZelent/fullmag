"""Postprocess genuine DE pilot artifacts; never certify from a plot alone."""
from __future__ import annotations
import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
from verify_fem_frequency_domain_eigen_artifacts import kalinikos_slab_n0_frequency_hz
from validate_de_smoke_rows import (
    SAMPLING, load_spectrum_v3_modes, validate_selected_only_diagnostics)
from de_pilot_receipts import validate_de_pilot_receipts

PARAMETERS = dict(geometry="damon_eshbach", bias_field_a_per_m=0.1/(4e-7*math.pi),
                  film_thickness_m=100e-9, exchange_stiffness_j_per_m=13e-12,
                  saturation_magnetisation_a_per_m=800000., gamma0_rad_s_per_a_m=221100.)


def reference(k, parameters=None):
    return kalinikos_slab_n0_frequency_hz(
        k_norm=abs(k), **(PARAMETERS if parameters is None else parameters))


def finite_airbox_gamma_hz(air_each_side_m=2e-6, parameters=None):
    """Uniform Gamma control with phi=0 at the two finite z boundaries."""
    if not math.isfinite(air_each_side_m) or air_each_side_m <= 0:
        raise ValueError("Air padding must be finite and positive")
    parameters = PARAMETERS if parameters is None else parameters
    thickness = parameters["film_thickness_m"]
    nz = 1 - thickness / (thickness + 2*air_each_side_m)
    bias = parameters["bias_field_a_per_m"]
    return parameters["gamma0_rad_s_per_a_m"]/(2*math.pi)*math.sqrt(
        bias*(bias + parameters["saturation_magnetisation_a_per_m"]*nz))


def read_modes(path, expected_k=None):
    with path.open(encoding="utf-8-sig", newline="") as stream:
        raw = list(csv.DictReader(stream))
    if not raw:
        raise ValueError("Numerical dispersion is empty")
    spectrum_path = path.parent / "spectrum.v3.json"
    native_modes = load_spectrum_v3_modes(spectrum_path) if spectrum_path.exists() else None
    rows = []
    keys = set()
    for row in raw:
        values = {key: float(row[key]) for key in
                  ("kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m", "frequency_hz")}
        if not all(math.isfinite(v) for v in values.values()):
            raise ValueError("Nonfinite numerical value")
        residual_text = row.get("residual_norm")
        if residual_text is None or residual_text.strip() == "":
            absolute_residual = None
        else:
            try:
                absolute_residual = float(residual_text)
            except (TypeError, ValueError) as error:
                raise ValueError("Invalid absolute residual_norm") from error
            if not math.isfinite(absolute_residual) or absolute_residual < 0:
                raise ValueError("Invalid absolute residual_norm")
        if values["frequency_hz"] <= 0:
            raise ValueError("Invalid frequency")
        if values["kx_rad_per_m"] != 0 or values["kz_rad_per_m"] != 0:
            raise ValueError("Expected DE propagation along y")
        for name in ("sample_index", "raw_mode_index", "branch_id"):
            value = row.get(name, "")
            if name == "branch_id" and value == "":
                continue
            if not isinstance(value, str) or not value.isascii() or not value.isdecimal():
                raise ValueError(f"Invalid numerical index: {name}")
        key = (int(row["sample_index"]), int(row["raw_mode_index"]))
        if key in keys:
            raise ValueError("Duplicate numerical mode")
        keys.add(key)
        residual_fields = {"residual_norm": absolute_residual,
                           "residual_relative_l2": None,
                           "residual_scope": None}
        if native_modes is not None:
            native_mode = native_modes.get(key)
            if native_mode is None:
                raise ValueError("Native spectrum is missing a CSV mode")
            if not math.isclose(values["frequency_hz"], native_mode["frequency_hz"],
                                rel_tol=1e-12, abs_tol=1e-6):
                raise ValueError("CSV frequency disagrees with native spectrum mode")
            residual_fields["residual_relative_l2"] = native_mode["residual_relative_l2"]
            residual_fields["residual_scope"] = native_mode["residual_scope"]
        rows.append({**values, "sample_index": key[0], "raw_mode_index": key[1],
                     "branch_id": int(row["branch_id"]) if row["branch_id"] else None,
                     **residual_fields})
    if native_modes is not None and keys != set(native_modes):
        raise ValueError("CSV/native spectrum mode coverage mismatch")
    expected_k = tuple(k*1e6 for k in range(-40, 41, 10)) if expected_k is None else tuple(expected_k)
    if {row["sample_index"] for row in rows} != set(range(len(expected_k))):
        raise ValueError("Numerical samples do not cover the declared DE path")
    for row in rows:
        if not math.isclose(row["ky_rad_per_m"], expected_k[row["sample_index"]], rel_tol=1e-12, abs_tol=1e-12):
            raise ValueError("Numerical wavevector disagrees with its declared sample")
    return rows


def compare_branch(rows, branch, parameters=None, expected_k=None):
    selected = sorted((r for r in rows if r["branch_id"] == branch), key=lambda r:r["ky_rad_per_m"])
    expected_k = tuple(k*1e6 for k in range(-40, 41, 10)) if expected_k is None else tuple(expected_k)
    if len(selected) != len(expected_k) or {r["ky_rad_per_m"] for r in selected} != set(expected_k):
        raise ValueError("Selected branch does not cover the declared k points uniquely")
    return [{**r, "analytic_n0_hz": reference(r["ky_rad_per_m"], parameters),
             "relative_difference": (r["frequency_hz"]-reference(r["ky_rad_per_m"], parameters))/reference(r["ky_rad_per_m"], parameters)}
            for r in selected]


def load_comparison_input(run):
    """Read actual model inputs; never infer 100 nm from the script name."""
    request = json.loads((run/"run-request.json").read_text(encoding="utf-8"))
    result = json.loads((run/"run-result.json").read_text(encoding="utf-8"))
    pilot = result.get("pilot")
    nearest_alias = pilot == "de-smoke-nearest-k2"
    sampling = (request.get("sampling") if nearest_alias else
                pilot.removeprefix("de-smoke-") if isinstance(pilot, str) else None)
    if pilot != "de100" and (
            not isinstance(pilot, str) or not pilot.startswith("de-smoke-") or
            sampling not in SAMPLING or sampling.startswith("bv-")):
        raise ValueError("Unsupported DE pilot")
    if nearest_alias and sampling != "k2":
        raise ValueError("nearest DE-SMOKE alias must preserve k2 sampling")
    validate_de_pilot_receipts(request, result, pilot)
    metadata_path = run/pilot/"metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    descriptor = "de_100nm_numeric_pilot" if pilot == "de100" else "de_smoke"
    try:
        model = metadata["problem_meta"]["runtime_metadata"][descriptor]
    except (KeyError, TypeError) as error:
        raise ValueError("Run metadata lacks DE material and geometry parameters") from error
    expected_schema = "fullmag.de100-pilot.v1" if pilot == "de100" else "fullmag.de-smoke.v1"
    if (not isinstance(model, dict) or model.get("schema") != expected_schema or model.get("orientation") != "M0=x,k=y,normal=z" or
            model.get("outer_boundary_kind") != "poisson_dirichlet"):
        raise ValueError("Expected DE orientation and finite Dirichlet airbox metadata")

    def positive(name):
        value = model.get(name)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise ValueError(f"Missing or invalid model parameter: {name}")
        return float(value)

    parameters = dict(
        geometry="damon_eshbach",
        bias_field_a_per_m=positive("external_induction_t")/positive("mu0_t_m_a"),
        film_thickness_m=positive("film_thickness_m"),
        exchange_stiffness_j_per_m=positive("exchange_stiffness_j_per_m"),
        saturation_magnetisation_a_per_m=positive("saturation_magnetization_a_per_m"),
        gamma0_rad_s_per_a_m=positive("gamma0_m_per_a_s"))
    padding = positive("air_padding_each_side_m")
    expected_k = model.get("ky_rad_per_m")
    if (not isinstance(expected_k, list) or not expected_k or
            any(isinstance(k, bool) or not isinstance(k, (int, float)) or not math.isfinite(k) for k in expected_k) or
            len(set(expected_k)) != len(expected_k)):
        raise ValueError("Missing or invalid declared DE wavevector samples")
    source = run/pilot/"eigen/dispersion.csv"
    if pilot != "de100":
        from validate_de_smoke_rows import validate_rows
        if model.get("sampling") != sampling or request.get("sampling") != sampling or tuple(expected_k) != SAMPLING[sampling]:
            raise ValueError("DE-SMOKE sampling metadata mismatch")
        modal_target = model.get("modal_target", request.get("modal_target", "frequency_window"))
        selected_only = nearest_alias or modal_target == "nearest"
        if selected_only:
            if len(SAMPLING[sampling]) != 1:
                raise ValueError("selected-only comparison requires one k sample")
            if (modal_target != "nearest" or model.get("selection_scope") != "selected_only" or
                    model.get("window_complete") is not False):
                raise ValueError("selected-only DE-SMOKE metadata is incomplete")
            target_hz = model.get("target_frequency_hz")
            if (isinstance(target_hz, bool) or not isinstance(target_hz, (int, float)) or
                    not math.isfinite(target_hz) or target_hz <= 0):
                raise ValueError("selected-only DE-SMOKE metadata has no target frequency")
            request_target_hz = request.get("target_frequency_hz")
            if request_target_hz is not None and (
                    isinstance(request_target_hz, bool) or
                    not isinstance(request_target_hz, (int, float)) or
                    not math.isfinite(request_target_hz) or request_target_hz <= 0 or
                    not math.isclose(float(request_target_hz), float(target_hz),
                                     rel_tol=1e-12, abs_tol=1e-6)):
                raise ValueError("selected-only request target disagrees with metadata")
            diagnostics_path = run/pilot/"eigen/diagnostics/solver.v1.json"
            validate_rows(source, sampling, diagnostics_path, metadata_path,
                          selection_scope="selected_only")
            validate_selected_only_diagnostics(diagnostics_path, float(target_hz))
        else:
            validate_rows(source, sampling, run/pilot/"eigen/diagnostics/solver.v1.json", metadata_path)
    rows = read_modes(source, expected_k)
    return request, rows, parameters, tuple(expected_k), padding, source, metadata_path


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path, help="managed de100 or DE-SMOKE run containing run-request.json")
    parser.add_argument("--branch-id", type=int, help="explicit branch selected using physical mode profiles")
    args = parser.parse_args(argv)
    request, rows, parameters, expected_k, padding, source, metadata_path = load_comparison_input(args.run)
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    result_path = args.run / "run-result.json"
    result_payload = (json.loads(result_path.read_text(encoding="utf-8"))
                      if result_path.exists() else {})
    pilot = result_payload.get("pilot")
    descriptor = "de_100nm_numeric_pilot" if pilot == "de100" else "de_smoke"
    model_metadata = metadata.get("problem_meta", {}).get("runtime_metadata", {}).get(descriptor, {})
    if not isinstance(model_metadata, dict):
        model_metadata = {}
    modal_target = request.get("spectral_target", request.get("modal_target",
                        model_metadata.get("modal_target", "frequency_window")))
    selected_only = (pilot == "de-smoke-nearest-k2" or modal_target == "nearest")
    comparison = (compare_branch(rows, args.branch_id, parameters, expected_k)
                  if args.branch_id is not None else None)
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    output = args.run/"analytic-comparison"
    output.mkdir(exist_ok=False)
    fig, ax = plt.subplots(figsize=(9,5))
    lower, upper = min(0.0, min(expected_k)), max(0.0, max(expected_k))
    k = [lower+i*(upper-lower)/800 for i in range(801)]
    ax.plot([x/1e6 for x in k], [reference(x, parameters)/1e9 for x in k], color="darkorange", label="Analityka n=0 (przybliżenie)")
    ax.scatter([r["ky_rad_per_m"]/1e6 for r in rows], [r["frequency_hz"]/1e9 for r in rows], s=16, color="steelblue", alpha=.55, label="Wszystkie mody FEM")
    if comparison:
        ax.plot([r["ky_rad_per_m"]/1e6 for r in comparison], [r["frequency_hz"]/1e9 for r in comparison], "o-", label=f"FEM: gałąź {args.branch_id}")
        with (output/"branch-comparison.csv").open("x", newline="", encoding="utf-8") as stream:
            writer=csv.DictWriter(stream,fieldnames=list(comparison[0]));writer.writeheader();writer.writerows(comparison)
    title_scope = "selected-only" if selected_only else "frequency-window"
    ax.set(xlabel="k_y [rad/µm]", ylabel="f [GHz]", title=f"DE {parameters['film_thickness_m']*1e9:g} nm: FEM i referencja n=0 ({title_scope}, bez kwalifikacji)")
    ax.grid(alpha=.25);ax.legend();fig.tight_layout()
    fig.savefig(output/"dispersion.png",dpi=180);fig.savefig(output/"dispersion.pdf");plt.close(fig)
    residual_scope_counts = {}
    residual_maxima = {}
    for row in rows:
        scope = row.get("residual_scope") or "unavailable"
        residual_scope_counts[scope] = residual_scope_counts.get(scope, 0) + 1
        residual = row.get("residual_relative_l2")
        if residual is not None:
            residual_maxima[scope] = max(residual_maxima.get(scope, 0.0), residual)
    report={"qualification":"NOT VERIFIED", "parameters_from_metadata":parameters,
            "modal_target":modal_target,
            "selection_scope":"selected_only" if selected_only else "frequency_window",
            "window_complete":False if selected_only else None,
            "analytic_comparison":"postsolve_only",
            "residual_scope": next(iter(residual_scope_counts)) if len(residual_scope_counts) == 1 else "mixed",
            "residual_scope_counts":residual_scope_counts,
            "max_relative_residual_l2_by_scope":residual_maxima,
            "model_sha256":request["model_sha256"],"source_job":request["job"],
            "dispersion_sha256":hashlib.sha256(source.read_bytes()).hexdigest(),
            "selected_branch":args.branch_id,"mode_rows":len(rows),
            "gamma_open_film_hz":reference(0, parameters),
            "gamma_finite_airbox_hz":finite_airbox_gamma_hz(padding, parameters),
            "air_padding_each_side_m":padding,
            "metadata_sha256":hashlib.sha256(metadata_path.read_bytes()).hexdigest(),
            "max_abs_relative_difference":max(abs(r["relative_difference"]) for r in comparison) if comparison else None,
            "max_relative_residual_l2":max(
                (r.get("residual_relative_l2") for r in rows
                 if r.get("residual_relative_l2") is not None), default=None),
            "limitations":["Parameters are read from run metadata; mesh and mode-profile verification remain required.",
                           "Uniform n=0 approximation; thickness-mode coupling is omitted.",
                           "Open-film analytic reference differs from a finite Dirichlet airbox.",
                           "Profile identification, spectral coverage and convergence remain required."]}
    if selected_only:
        report["limitations"].append(
            "Selected-only contains one requested mode and is not a complete frequency window or dispersion qualification.")
    (output/"comparison.json").write_text(json.dumps(report,indent=2)+"\n")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
