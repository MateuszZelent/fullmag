"""Plot archived FEM samples against uniform and coupled open-film references.

This diagnostic never synthesizes FEM samples or certifies convergence.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import numpy as np
from compare_de_bv_mode_profiles import load_record
from finite_dirichlet_thin_film_oracle import n0_reference_frequencies
from thin_film_thickness_oracle import solve_thickness_modes, MU0
from validate_de_smoke_rows import SAMPLING, validate_selected_only_diagnostics


def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _finite_positive_parameter(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("selected-only plot model parameter is invalid: " + name)
    try:
        value = float(value)
    except (OverflowError, ValueError) as error:
        raise ValueError("selected-only plot model parameter is invalid: " + name) from error
    if not math.isfinite(value) or value <= 0:
        raise ValueError("selected-only plot model parameter is invalid: " + name)
    return value


def _finite_real_parameter(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("selected-only plot model parameter is invalid: " + name)
    try:
        value = float(value)
    except (OverflowError, ValueError) as error:
        raise ValueError("selected-only plot model parameter is invalid: " + name) from error
    if not math.isfinite(value):
        raise ValueError("selected-only plot model parameter is invalid: " + name)
    return value


def _record_n0_reference(record):
    """Recompute both n=0 references from the record's resolved parameters."""
    parameters = record.get("parameters")
    if not isinstance(parameters, dict):
        return None, "record has no resolved material parameters"
    try:
        padding = _finite_positive_parameter(
            record.get("air_padding_each_side_m"), "air_padding_each_side_m"
        )
        mu0 = _finite_positive_parameter(parameters.get("mu0_t_m_a"), "mu0_t_m_a")
        external_induction = _finite_positive_parameter(
            parameters.get("external_induction_t"), "external_induction_t"
        )
        common = {
            "k_rad_m": record["k_rad_per_m"],
            "geometry": record["geometry"],
            "bias_field_a_per_m": _finite_positive_parameter(
                parameters.get("bias_field_a_per_m"), "bias_field_a_per_m"
            ),
            "film_thickness_m": _finite_positive_parameter(
                parameters.get("film_thickness_m"), "film_thickness_m"
            ),
            "air_padding_each_side_m": padding,
            "exchange_stiffness_j_per_m": _finite_positive_parameter(
                parameters.get("exchange_stiffness_j_per_m"),
                "exchange_stiffness_j_per_m",
            ),
            "saturation_magnetisation_a_per_m": _finite_positive_parameter(
                parameters.get("saturation_magnetisation_a_per_m"),
                "saturation_magnetisation_a_per_m",
            ),
            "gamma0_rad_s_per_a_m": _finite_positive_parameter(
                parameters.get("gamma0_rad_s_per_a_m"), "gamma0_rad_s_per_a_m"
            ),
            "mu0_t_m_a": mu0,
        }
        if not math.isclose(
            common["bias_field_a_per_m"] * mu0,
            external_induction,
            rel_tol=1e-12,
            abs_tol=0.0,
        ):
            return None, "external_induction_t does not match resolved bias and mu0"
        return n0_reference_frequencies(**common), None
    except (KeyError, TypeError, ValueError) as error:
        return None, str(error)


def _shared_finite_reference_context(rows):
    """Resolve one finite-airbox model, or return an explicit availability gap."""
    resolved = []
    for record in rows:
        references, reason = _record_n0_reference(record)
        if references is None:
            return {"status": "NOT_AVAILABLE", "reason": reason}, None
        resolved.append((record, references))
    if not resolved:
        return {"status": "NOT_AVAILABLE", "reason": "no records"}, None
    padding = resolved[0][0].get("air_padding_each_side_m")
    if any(
        not math.isclose(
            float(record.get("air_padding_each_side_m")),
            float(padding),
            rel_tol=1e-12,
            abs_tol=0.0,
        )
        for record, _ in resolved
    ):
        return {
            "status": "NOT_AVAILABLE",
            "reason": "records use different resolved airbox padding values",
        }, None
    first = resolved[0][0]
    parameters = first["parameters"]
    context = {
        "geometry_parameters": {
            "bias_field_a_per_m": parameters["bias_field_a_per_m"],
            "film_thickness_m": parameters["film_thickness_m"],
            "air_padding_each_side_m": float(padding),
            "exchange_stiffness_j_per_m": parameters["exchange_stiffness_j_per_m"],
            "saturation_magnetisation_a_per_m": parameters[
                "saturation_magnetisation_a_per_m"
            ],
            "gamma0_rad_s_per_a_m": parameters["gamma0_rad_s_per_a_m"],
            "mu0_t_m_a": parameters["mu0_t_m_a"],
        },
        "padding": float(padding),
    }
    return {
        "status": "available",
        "boundary": "scalar_potential_dirichlet",
        "air_padding_each_side_m": float(padding),
        "reference": "uniform n=0 finite Dirichlet Green function",
    }, context


def validate_selected_only_record(record, report_scope="selected_only"):
    """Recheck native target provenance before plotting a nearest-mode point."""
    scope = record.get("selection_scope", report_scope)
    if scope != "selected_only":
        raise ValueError("selected-only plot record has an invalid selection scope")
    if report_scope == "selected_only" and record.get("selection_scope") != "selected_only":
        raise ValueError("selected-only comparison records must declare their selection scope")
    if record.get("modal_target") != "nearest" or record.get("window_complete") is not False:
        raise ValueError("selected-only plot record must declare nearest and window_complete=false")
    target = record.get("target_frequency_hz")
    if (isinstance(target, bool) or not isinstance(target, (int, float)) or
            not math.isfinite(target) or target <= 0):
        raise ValueError("selected-only plot record has no finite target frequency")
    run = Path(record["run_path"]).resolve()
    pilot = record.get("pilot")
    request_path, result_path = run / "run-request.json", run / "run-result.json"
    request = json.loads(request_path.read_text(encoding="utf-8"))
    result = json.loads(result_path.read_text(encoding="utf-8"))
    if (request.get("schema") != "fullmag.de-smoke.request.v1" or
            result.get("schema") != "fullmag.de-smoke.result.v1" or
            result.get("status") != "completed_unqualified" or
            type(result.get("return_code")) is not int or result["return_code"] != 0 or
            request.get("job") != record.get("job") or result.get("job") != record.get("job") or
            request.get("model_source") != record.get("model_source") or
            result.get("model_source") != record.get("model_source") or
            request.get("source") != result.get("source") or
            request.get("model_sha256") != result.get("model_sha256") or
            result.get("pilot") != pilot or request.get("cases") != [pilot]):
        raise ValueError("selected-only plot receipt is not bound to the collected record")
    if (request.get("modal_target") != "nearest" or request.get("spectral_target") != "nearest" or
            request.get("selection_scope") != "selected_only" or request.get("window_complete") is not False or
            isinstance(request.get("target_frequency_hz"), bool) or
            not isinstance(request.get("target_frequency_hz"), (int, float)) or
            not math.isfinite(request["target_frequency_hz"]) or
            not math.isclose(float(request["target_frequency_hz"]), float(target), rel_tol=1e-12, abs_tol=1e-6) or
            request.get("thickness_layers_requested") != "3"):
        raise ValueError("selected-only plot request disagrees with the collected record")
    sampling = request.get("sampling")
    if (pilot == "de-smoke-nearest-k2" and sampling != "k2") or (
            pilot != "de-smoke-nearest-k2" and sampling != str(pilot).removeprefix("de-smoke-")
            ) or sampling not in SAMPLING or len(SAMPLING[sampling]) != 1:
        raise ValueError("selected-only plot receipt does not identify one single-k sample")
    metadata = json.loads((run / pilot / "metadata.json").read_text(encoding="utf-8"))
    model = metadata["problem_meta"]["runtime_metadata"]["de_smoke"]
    expected_geometry = "backward_volume" if sampling.startswith("bv-") else "damon_eshbach"
    expected_orientation = "M0=x,k=x,normal=z" if sampling.startswith("bv-") else "M0=x,k=y,normal=z"
    if (model.get("sampling") != sampling or
            model.get("dispersion_geometry") != expected_geometry or
            model.get("orientation") != expected_orientation):
        raise ValueError("selected-only plot metadata disagrees with the requested geometry")
    metadata_target = model.get("target_frequency_hz")
    if (model.get("modal_target") != "nearest" or model.get("selection_scope") != "selected_only" or
            model.get("window_complete") is not False or
            isinstance(metadata_target, bool) or not isinstance(metadata_target, (int, float)) or
            not math.isfinite(metadata_target) or
            not math.isclose(float(metadata_target), float(target), rel_tol=1e-12, abs_tol=1e-6)):
        raise ValueError("selected-only plot metadata disagrees with the collected record")
    parameters = record.get("parameters")
    if not isinstance(parameters, dict):
        raise ValueError("selected-only plot record has no model parameter binding")
    if record.get("geometry") != expected_geometry or parameters.get("geometry") != expected_geometry:
        raise ValueError("selected-only plot record geometry differs from resolved model metadata")
    expected_k = _finite_real_parameter(SAMPLING[sampling][0], "expected_k_rad_per_m")
    declared_k = _finite_real_parameter(record.get("k_rad_per_m"), "k_rad_per_m")
    if not math.isclose(declared_k, expected_k, rel_tol=1e-12, abs_tol=1e-12):
        raise ValueError("selected-only plot wavevector differs from resolved model metadata")
    resolved_vectors = model.get("k_vectors_rad_per_m")
    expected_vector = [expected_k, 0.0, 0.0] if sampling.startswith("bv-") else [0.0, expected_k, 0.0]
    if (not isinstance(resolved_vectors, list) or len(resolved_vectors) != 1 or
            not isinstance(resolved_vectors[0], list) or len(resolved_vectors[0]) != 3):
        raise ValueError("selected-only plot metadata has no single resolved wavevector")
    for index, (declared_component, actual_component) in enumerate(
            zip(resolved_vectors[0], expected_vector)):
        try:
            declared_component = _finite_real_parameter(
                declared_component, f"k_vectors_rad_per_m[{index}]"
            )
        except ValueError as error:
            raise ValueError(
                "selected-only plot metadata has an invalid resolved wavevector"
            ) from error
        if not math.isclose(declared_component, actual_component, rel_tol=1e-12, abs_tol=1e-12):
            raise ValueError("selected-only plot metadata wavevector differs from the requested sample")
    for field in ("mu0_t_m_a", "external_induction_t", "air_padding_each_side_m"):
        try:
            declared = _finite_positive_parameter(
                record.get(field) if field == "air_padding_each_side_m" else parameters.get(field),
                field,
            )
            actual = _finite_positive_parameter(model.get(field), field)
        except ValueError:
            raise ValueError("selected-only plot model parameter differs from run metadata: " + field)
        if not math.isclose(declared, actual, rel_tol=1e-12, abs_tol=0.0):
            raise ValueError("selected-only plot model parameter differs from run metadata: " + field)
    resolved_material_bindings = (
        ("film_thickness_m", "film_thickness_m"),
        ("exchange_stiffness_j_per_m", "exchange_stiffness_j_per_m"),
        ("saturation_magnetisation_a_per_m", "saturation_magnetization_a_per_m"),
        ("gamma0_rad_s_per_a_m", "gamma0_m_per_a_s"),
    )
    for record_field, model_field in resolved_material_bindings:
        try:
            declared = _finite_positive_parameter(parameters.get(record_field), record_field)
            actual = _finite_positive_parameter(model.get(model_field), model_field)
        except ValueError as error:
            raise ValueError(
                "selected-only plot model parameter differs from run metadata: " + record_field
            ) from error
        if not math.isclose(declared, actual, rel_tol=1e-12, abs_tol=0.0):
            raise ValueError(
                "selected-only plot model parameter differs from run metadata: " + record_field
            )
    try:
        declared_bias = _finite_positive_parameter(
            parameters.get("bias_field_a_per_m"), "bias_field_a_per_m"
        )
        resolved_mu0 = _finite_positive_parameter(model.get("mu0_t_m_a"), "mu0_t_m_a")
        resolved_external = _finite_positive_parameter(
            model.get("external_induction_t"), "external_induction_t"
        )
    except ValueError as error:
        raise ValueError(
            "selected-only plot model parameter differs from run metadata: bias_field_a_per_m"
        ) from error
    resolved_bias = resolved_external / resolved_mu0
    if not math.isclose(declared_bias, resolved_bias, rel_tol=1e-12, abs_tol=0.0):
        raise ValueError(
            "selected-only plot model parameter differs from run metadata: bias_field_a_per_m"
        )
    diagnostics = run / pilot / "eigen/diagnostics/solver.v1.json"
    native = validate_selected_only_diagnostics(diagnostics, float(target))
    if "native_target_frequency_hz" not in record:
        raise ValueError("selected-only plot record has no native target binding")
    declared_native = record["native_target_frequency_hz"]
    if (isinstance(declared_native, bool) or not isinstance(declared_native, (int, float)) or
            not math.isfinite(declared_native) or
            not math.isclose(float(declared_native), native["target_frequency_hz"],
                             rel_tol=1e-12, abs_tol=1e-6)):
        raise ValueError("selected-only plot record target differs from native diagnostics")
    mode = json.loads((run / pilot / "eigen/modes/sample_0000/mode_0000.json").read_text(encoding="utf-8"))
    actual_residual = mode.get("block_residuals", {}).get("eps_full")
    declared_residual = record.get("full_residual")
    if (isinstance(actual_residual, bool) or not isinstance(actual_residual, (int, float)) or
            not math.isfinite(actual_residual) or not 0 <= actual_residual <= 1e-8 or
            isinstance(declared_residual, bool) or not isinstance(declared_residual, (int, float)) or
            not math.isfinite(declared_residual) or
            not math.isclose(float(declared_residual), float(actual_residual), rel_tol=1e-12, abs_tol=1e-18)):
        raise ValueError("selected-only plot residual is not bound to the native mode")
    return native


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--comparison", action="append", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--pending-job", help="job with no new numerical result in this plot")
    args = parser.parse_args()
    rows, seen, inputs = [], set(), {}
    scopes = set()
    for path in args.comparison:
        data = json.loads(path.read_text(encoding="utf-8"))
        inputs[str(path)] = sha(path)
        report_scope = data.get("selection_scope", "frequency_window")
        if report_scope not in {"frequency_window", "selected_only"}:
            raise ValueError("comparison has an unsupported selection scope")
        for record in data["records"]:
            identity = (record["run_path"], record["pilot"])
            if identity in seen: continue
            _, _, _, _, bound_hashes, _ = load_record(record)
            scope = record.get("selection_scope", report_scope)
            if scope not in {"frequency_window", "selected_only"}:
                raise ValueError("comparison record has an unsupported selection scope")
            if (report_scope == "selected_only" and
                    (scope != "selected_only" or record.get("selection_scope") != "selected_only")):
                raise ValueError("selected-only comparison contains a non-selected record")
            if scope == "selected_only":
                validate_selected_only_record(record, report_scope)
            seen.add(identity)
            rows.append({**record, "plot_mesh_level": record.get("mesh_level", data.get("mesh_level", "L0")),
                         "independent_input_hashes": bound_hashes,
                         "selection_scope": scope})
            scopes.add(scope)
    if not rows: raise ValueError("no bound numerical samples")
    parameters = {k:v for k,v in rows[0]["parameters"].items() if k != "geometry"}
    if any({k:v for k,v in r["parameters"].items() if k != "geometry"} != parameters for r in rows):
        raise ValueError("dispersion plot requires identical film and material parameters")
    finite_reference_status, finite_context = _shared_finite_reference_context(rows)
    ms, thickness = parameters["saturation_magnetisation_a_per_m"], parameters["film_thickness_m"]
    mu0 = parameters.get("mu0_t_m_a", MU0)
    if (isinstance(mu0, bool) or not isinstance(mu0, (int, float)) or
            not math.isfinite(mu0) or mu0 <= 0):
        raise ValueError("dispersion plot requires a finite positive mu0")
    oracle = dict(ms_a_m=ms, thickness_m=thickness,
                  bias_t=parameters["bias_field_a_per_m"] * mu0,
                  exchange_j_m=parameters["exchange_stiffness_j_per_m"],
                  gamma0_m_a_s=parameters["gamma0_rad_s_per_a_m"])
    grid = np.linspace(min(0, min(r["k_rad_per_m"] for r in rows)),
                       max(0, max(r["k_rad_per_m"] for r in rows)), 161)
    reference = []
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(2,2,figsize=(12,8),sharex="col",layout="constrained")
    palette = {"L0":"#7b8794", "L1":"#c47c16", "L2":"#1565c0", "L3":"#00875a"}
    markers = {"L0":"o", "L1":"^", "L2":"s", "L3":"D"}
    for col, (geometry, short) in enumerate((("damon_eshbach","DE"),("backward_volume","BV"))):
        frequencies = {}
        for n in (1,32):
            frequencies[n] = [solve_thickness_modes(**oracle, geometry=short, k_rad_m=float(k),
                basis_size=n)["modes"][0]["frequency_hz"] for k in grid]
        open_n0 = np.asarray(frequencies[1])
        if finite_context is not None:
            open_n0 = np.asarray([
                n0_reference_frequencies(
                    k_rad_m=float(k), geometry=geometry, **finite_context["geometry_parameters"]
                )["open_film_n0_frequency_hz"]
                for k in grid
            ])
        axes[0,col].plot(grid/1e6,open_n0/1e9,"--",color="#d58a18",label="Otwarty film: n=0")
        finite_n0 = None
        if finite_context is not None:
            finite_n0 = np.asarray([
                n0_reference_frequencies(
                    k_rad_m=float(k), geometry=geometry, **finite_context["geometry_parameters"]
                )["finite_dirichlet_n0_frequency_hz"]
                for k in grid
            ])
            axes[0,col].plot(
                grid / 1e6,
                finite_n0 / 1e9,
                "-.",
                color="#7b2cbf",
                label="Finite airbox Dirichlet: n=0",
            )
        axes[0,col].plot(grid/1e6,np.asarray(frequencies[32])/1e9,color="#202a35",label="Otwarty film: profile (N=32)")
        reference_entry = {
            "geometry": geometry,
            "k_rad_m": grid.tolist(),
            "open_film_n0_frequency_hz": open_n0.tolist(),
            "N32_frequency_hz": frequencies[32],
            "finite_dirichlet_n0_frequency_hz": (
                finite_n0.tolist() if finite_n0 is not None else None
            ),
        }
        reference.append(reference_entry)
        for level in ("L0","L1","L2","L3"):
            selected = [r for r in rows if r["geometry"]==geometry and r["plot_mesh_level"]==level]
            if not selected: continue
            errors = []
            for r in selected:
                expected=solve_thickness_modes(**oracle,geometry=short,k_rad_m=r["k_rad_per_m"],basis_size=32)["modes"][0]["frequency_hz"]
                r["N32_reference_frequency_hz"]=expected
                r["difference_from_N32_percent"]=100*(r["frequency_hz"]/expected-1)
                n0_reference, _ = _record_n0_reference(r)
                if n0_reference is not None:
                    r["analytic_open_film_n0_frequency_hz"] = n0_reference[
                        "open_film_n0_frequency_hz"
                    ]
                    r["analytic_finite_dirichlet_n0_frequency_hz"] = n0_reference[
                        "finite_dirichlet_n0_frequency_hz"
                    ]
                    r["difference_from_open_film_n0_percent"] = 100.0 * (
                        r["frequency_hz"] / n0_reference["open_film_n0_frequency_hz"] - 1.0
                    )
                    r["difference_from_finite_dirichlet_n0_percent"] = 100.0 * (
                        r["frequency_hz"]
                        / n0_reference["finite_dirichlet_n0_frequency_hz"]
                        - 1.0
                    )
                errors.append(r["difference_from_N32_percent"])
            x = [r["k_rad_per_m"]/1e6 for r in selected]
            style=dict(marker=markers[level],s=48,edgecolors=palette[level],facecolors="none" if level=="L0" else palette[level])
            selected_scopes = {r["selection_scope"] for r in selected}
            label = ("FEM nearest (selected-only) " if selected_scopes == {"selected_only"}
                     else "FEM (mixed scopes) " if "selected_only" in selected_scopes
                     else "Archiwalny FEM ") + level
            axes[0,col].scatter(x,[r["frequency_hz"]/1e9 for r in selected],label=label,**style)
            axes[1,col].scatter(x,errors,**style)
        axes[0,col].set(title=short + (r": $\mathbf{k}\perp\mathbf{M}_0$" if short=="DE" else r": $\mathbf{k}\parallel\mathbf{M}_0$"),ylabel="Częstotliwość [GHz]")
        axes[0,col].legend(fontsize=8)
        axes[1,col].axhline(0,color="#202a35",linewidth=1)
        axes[1,col].set(xlabel="k [rad/µm]",ylabel="Różnica FEM względem N=32 [%]")
        for ax in axes[:,col]: ax.grid(alpha=.22)
    scope_label = "selected-only" if scopes == {"selected_only"} else "frequency-window" if scopes == {"frequency_window"} else "mixed scopes"
    title="Dyspersja DE/BV — punkty FEM i referencje n=0 (" + scope_label + ")"
    if args.pending_job: title += "\nJob #" + args.pending_job + ": jeszcze bez nowych punktów"
    selected_only_report = scopes == {"selected_only"}
    fig.suptitle(title,fontsize=14)
    finite_footer = (
        f"Finite airbox n=0: d={finite_reference_status['air_padding_each_side_m']*1e6:g} µm"
        if finite_reference_status["status"] == "available"
        else "Finite airbox n=0: NOT AVAILABLE — brak kompletnego resolved padding/model metadata"
    )
    footer = (f"Film {thickness*1e9:g} nm · Ms={ms/1e3:g} kA/m · A={oracle['exchange_j_m']*1e12:g} pJ/m · B₀={oracle['bias_t']:g} T · demag włączony\n"
              "Rzeczywiste punkty nearest selected-only; pinned target służy wyłącznie wyborowi modu; pełne okno, zbieżność i kwalifikacja pozostają otwarte"
              + "\n" + finite_footer
              if selected_only_report else
              f"Film {thickness*1e9:g} nm · Ms={ms/1e3:g} kA/m · A={oracle['exchange_j_m']*1e12:g} pJ/m · B₀={oracle['bias_t']:g} T · demag włączony\n"
              "Dane historyczne z różnych siatek i wersji źródeł; zbieżność i pełna kwalifikacja nadal otwarte"
              + "\n" + finite_footer)
    fig.supxlabel(footer,fontsize=9)
    args.output.mkdir(parents=True,exist_ok=False)
    png,pdf=args.output/"dispersion-de-bv-updated.png",args.output/"dispersion-de-bv-updated.pdf"
    fig.savefig(png,dpi=170); fig.savefig(pdf); plt.close(fig)
    report={"schema":("fullmag.selected-de-bv-nearest-plot.v1" if selected_only_report
                       else "fullmag.archived-dispersion-plot.v1"),"qualification":"NOT VERIFIED",
            "scope":("selected-only nearest FEM points; open-film and finite-airbox n=0 references when resolved metadata is present; no full-window or convergence certificate"
                      if selected_only_report else
                      "archived FEM points; open-film and finite-airbox n=0 references when resolved metadata is present; not a new solve or convergence certificate"),
            "selection_scope": next(iter(scopes)) if len(scopes) == 1 else "mixed",
            "modal_target": "nearest" if scopes == {"selected_only"} else None,
            "window_complete": False if scopes == {"selected_only"} else None,
            "mirrored_samples": False,
            "pending_job":args.pending_job,"parameters":parameters,"oracle_parameters":oracle,
            "analytic_reference_models": {
                "open_film_n0": {
                    "status": "available",
                    "boundary": "open_magnetostatic_free",
                },
                "finite_dirichlet_n0": finite_reference_status,
            },
            "input_comparison_sha256":inputs,"source_sha256":{str(p):sha(p) for p in (Path(__file__),Path(__file__).with_name("thin_film_thickness_oracle.py"),Path(__file__).with_name("finite_dirichlet_thin_film_oracle.py"),Path(__file__).with_name("compare_de_bv_mode_profiles.py"),Path(__file__).with_name("validate_de_smoke_rows.py"))},
            "records":rows,"references":reference,"output_sha256":{p.name:sha(p) for p in (png,pdf)}}
    (args.output/"plot-receipt.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
    print(json.dumps({"png":str(png),"pdf":str(pdf),"numerical_point_count":len(rows)}))


if __name__=="__main__": main()
