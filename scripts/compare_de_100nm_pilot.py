"""Postprocess genuine DE pilot artifacts; never certify from a plot alone."""
from __future__ import annotations
import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
from verify_fem_frequency_domain_eigen_artifacts import kalinikos_slab_n0_frequency_hz
from validate_de_smoke_rows import SAMPLING, load_spectrum_v3_modes
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
    sampling = pilot.removeprefix("de-smoke-") if isinstance(pilot, str) else None
    if pilot != "de100" and (
            not isinstance(pilot, str) or not pilot.startswith("de-smoke-") or
            sampling not in SAMPLING or sampling.startswith("bv-")):
        raise ValueError("Unsupported DE pilot")
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
        sampling = pilot.removeprefix("de-smoke-")
        if model.get("sampling") != sampling or request.get("sampling") != sampling or tuple(expected_k) != SAMPLING[sampling]:
            raise ValueError("DE-SMOKE sampling metadata mismatch")
        validate_rows(source, sampling, run/pilot/"eigen/diagnostics/solver.v1.json", metadata_path)
    rows = read_modes(source, expected_k)
    return request, rows, parameters, tuple(expected_k), padding, source, metadata_path


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path, help="managed de100 or DE-SMOKE run containing run-request.json")
    parser.add_argument("--branch-id", type=int, help="explicit branch selected using physical mode profiles")
    args = parser.parse_args(argv)
    request, rows, parameters, expected_k, padding, source, metadata_path = load_comparison_input(args.run)
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
    ax.set(xlabel="k_y [rad/µm]", ylabel="f [GHz]", title=f"DE {parameters['film_thickness_m']*1e9:g} nm: FEM i referencja n=0 (bez kwalifikacji)")
    ax.grid(alpha=.25);ax.legend();fig.tight_layout()
    fig.savefig(output/"dispersion.png",dpi=180);fig.savefig(output/"dispersion.pdf");plt.close(fig)
    report={"qualification":"NOT VERIFIED", "parameters_from_metadata":parameters,
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
    (output/"comparison.json").write_text(json.dumps(report,indent=2)+"\n")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
