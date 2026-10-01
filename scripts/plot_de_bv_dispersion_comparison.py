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
    for field in ("mu0_t_m_a", "external_induction_t"):
        try:
            declared = _finite_positive_parameter(parameters.get(field), field)
            actual = _finite_positive_parameter(model.get(field), field)
        except ValueError:
            raise ValueError("selected-only plot model parameter differs from run metadata: " + field)
        if not math.isclose(declared, actual, rel_tol=1e-12, abs_tol=0.0):
            raise ValueError("selected-only plot model parameter differs from run metadata: " + field)
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
        axes[0,col].plot(grid/1e6,np.asarray(frequencies[1])/1e9,"--",color="#d58a18",label="Otwarty film: P00 (N=1)")
        axes[0,col].plot(grid/1e6,np.asarray(frequencies[32])/1e9,color="#202a35",label="Otwarty film: profile (N=32)")
        reference.append({"geometry":geometry,"k_rad_m":grid.tolist(),"P00_frequency_hz":frequencies[1],"N32_frequency_hz":frequencies[32]})
        for level in ("L0","L1","L2","L3"):
            selected = [r for r in rows if r["geometry"]==geometry and r["plot_mesh_level"]==level]
            if not selected: continue
            errors = []
            for r in selected:
                expected=solve_thickness_modes(**oracle,geometry=short,k_rad_m=r["k_rad_per_m"],basis_size=32)["modes"][0]["frequency_hz"]
                r["N32_reference_frequency_hz"]=expected
                r["difference_from_N32_percent"]=100*(r["frequency_hz"]/expected-1)
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
    title="Dyspersja DE/BV — punkty FEM i aktualna referencja (" + scope_label + ")"
    if args.pending_job: title += "\nJob #" + args.pending_job + ": jeszcze bez nowych punktów"
    selected_only_report = scopes == {"selected_only"}
    fig.suptitle(title,fontsize=14)
    footer = (f"Film {thickness*1e9:g} nm · Ms={ms/1e3:g} kA/m · A={oracle['exchange_j_m']*1e12:g} pJ/m · B₀={oracle['bias_t']:g} T · demag włączony\n"
              "Rzeczywiste punkty nearest selected-only; pinned target służy wyłącznie wyborowi modu; pełne okno, zbieżność i kwalifikacja pozostają otwarte"
              if selected_only_report else
              f"Film {thickness*1e9:g} nm · Ms={ms/1e3:g} kA/m · A={oracle['exchange_j_m']*1e12:g} pJ/m · B₀={oracle['bias_t']:g} T · demag włączony\n"
              "Dane historyczne z różnych siatek i wersji źródeł; zbieżność i pełna kwalifikacja nadal otwarte")
    fig.supxlabel(footer,fontsize=9)
    args.output.mkdir(parents=True,exist_ok=False)
    png,pdf=args.output/"dispersion-de-bv-updated.png",args.output/"dispersion-de-bv-updated.pdf"
    fig.savefig(png,dpi=170); fig.savefig(pdf); plt.close(fig)
    report={"schema":("fullmag.selected-de-bv-nearest-plot.v1" if selected_only_report
                       else "fullmag.archived-dispersion-plot.v1"),"qualification":"NOT VERIFIED",
            "scope":("selected-only nearest FEM points; open-film references; no full-window or convergence certificate"
                      if selected_only_report else
                      "archived FEM points; open-film references; not a new solve or convergence certificate"),
            "selection_scope": next(iter(scopes)) if len(scopes) == 1 else "mixed",
            "modal_target": "nearest" if scopes == {"selected_only"} else None,
            "window_complete": False if scopes == {"selected_only"} else None,
            "mirrored_samples": False,
            "pending_job":args.pending_job,"parameters":parameters,"oracle_parameters":oracle,
            "input_comparison_sha256":inputs,"source_sha256":{str(p):sha(p) for p in (Path(__file__),Path(__file__).with_name("thin_film_thickness_oracle.py"),Path(__file__).with_name("compare_de_bv_mode_profiles.py"),Path(__file__).with_name("validate_de_smoke_rows.py"))},
            "records":rows,"references":reference,"output_sha256":{p.name:sha(p) for p in (png,pdf)}}
    (args.output/"plot-receipt.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
    print(json.dumps({"png":str(png),"pdf":str(pdf),"numerical_point_count":len(rows)}))


if __name__=="__main__": main()
