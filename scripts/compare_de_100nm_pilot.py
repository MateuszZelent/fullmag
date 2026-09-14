"""Postprocess genuine DE pilot artifacts; never certify from a plot alone."""
from __future__ import annotations
import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
from verify_fem_frequency_domain_eigen_artifacts import kalinikos_slab_n0_frequency_hz

PARAMETERS = dict(geometry="damon_eshbach", bias_field_a_per_m=0.1/(4e-7*math.pi),
                  film_thickness_m=100e-9, exchange_stiffness_j_per_m=13e-12,
                  saturation_magnetisation_a_per_m=800000., gamma0_rad_s_per_a_m=221100.)


def reference(k):
    return kalinikos_slab_n0_frequency_hz(k_norm=abs(k), **PARAMETERS)


def read_modes(path):
    with path.open(encoding="utf-8-sig", newline="") as stream:
        raw = list(csv.DictReader(stream))
    if not raw:
        raise ValueError("Numerical dispersion is empty")
    rows = []
    keys = set()
    for row in raw:
        values = {key: float(row[key]) for key in
                  ("kx_rad_per_m", "ky_rad_per_m", "kz_rad_per_m", "frequency_hz", "residual_norm")}
        if not all(math.isfinite(v) for v in values.values()):
            raise ValueError("Nonfinite numerical value")
        if values["frequency_hz"] <= 0 or values["residual_norm"] < 0:
            raise ValueError("Invalid frequency or residual")
        if values["kx_rad_per_m"] != 0 or values["kz_rad_per_m"] != 0:
            raise ValueError("Expected DE propagation along y")
        key = (int(row["sample_index"]), int(row["raw_mode_index"]))
        if key in keys:
            raise ValueError("Duplicate numerical mode")
        keys.add(key)
        rows.append({**values, "sample_index": key[0], "raw_mode_index": key[1],
                     "branch_id": int(row["branch_id"]) if row["branch_id"] else None})
    expected = {float(k)*1e6 for k in range(-40, 41, 10)}
    if {row["ky_rad_per_m"] for row in rows} != expected:
        raise ValueError("Expected all nine approved DE pilot k points")
    return rows


def compare_branch(rows, branch):
    selected = sorted((r for r in rows if r["branch_id"] == branch), key=lambda r:r["ky_rad_per_m"])
    if len(selected) != 9 or len({r["ky_rad_per_m"] for r in selected}) != 9:
        raise ValueError("Selected branch does not cover the nine k points uniquely")
    return [{**r, "analytic_n0_hz": reference(r["ky_rad_per_m"]),
             "relative_difference": (r["frequency_hz"]-reference(r["ky_rad_per_m"]))/reference(r["ky_rad_per_m"])}
            for r in selected]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path, help="DE run containing run-request.json and de100/")
    parser.add_argument("--branch-id", type=int, help="explicit branch selected using physical mode profiles")
    args = parser.parse_args(argv)
    request = json.loads((args.run/"run-request.json").read_text())
    result = json.loads((args.run/"run-result.json").read_text())
    if request.get("schema") != "fullmag.de100-pilot.request.v1" or result.get("status") != "completed_unqualified":
        raise ValueError("Expected a completed managed numerical DE pilot")
    if request.get("model_sha256") != result.get("model_sha256") or request["job"] != result["job"]:
        raise ValueError("Run identity mismatch")
    source = args.run/"de100/eigen/dispersion.csv"
    rows = read_modes(source)
    comparison = compare_branch(rows, args.branch_id) if args.branch_id is not None else None
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    output = args.run/"analytic-comparison"
    output.mkdir(exist_ok=False)
    fig, ax = plt.subplots(figsize=(9,5))
    k = [-40e6+i*80e6/800 for i in range(801)]
    ax.plot([x/1e6 for x in k], [reference(x)/1e9 for x in k], color="darkorange", label="Analityka n=0 (przybliżenie)")
    ax.scatter([r["ky_rad_per_m"]/1e6 for r in rows], [r["frequency_hz"]/1e9 for r in rows], s=16, color="steelblue", alpha=.55, label="Wszystkie mody FEM")
    if comparison:
        ax.plot([r["ky_rad_per_m"]/1e6 for r in comparison], [r["frequency_hz"]/1e9 for r in comparison], "o-", label=f"FEM: gałąź {args.branch_id}")
        with (output/"branch-comparison.csv").open("x", newline="", encoding="utf-8") as stream:
            writer=csv.DictWriter(stream,fieldnames=list(comparison[0]));writer.writeheader();writer.writerows(comparison)
    ax.set(xlabel="k_y [rad/µm]", ylabel="f [GHz]", title="DE 100 nm: FEM i model jednomodowy")
    ax.grid(alpha=.25);ax.legend();fig.tight_layout()
    fig.savefig(output/"dispersion.png",dpi=180);fig.savefig(output/"dispersion.pdf");plt.close(fig)
    report={"qualification":"NOT VERIFIED", "parameters_assumed":PARAMETERS,
            "model_sha256":request["model_sha256"],"source_job":request["job"],
            "dispersion_sha256":hashlib.sha256(source.read_bytes()).hexdigest(),
            "selected_branch":args.branch_id,"mode_rows":len(rows),
            "max_abs_relative_difference":max(abs(r["relative_difference"]) for r in comparison) if comparison else None,
            "limitations":["Verify approved material and geometry against the run input.",
                           "Uniform n=0 approximation; thickness-mode coupling is omitted.",
                           "Open-film analytic reference differs from a finite Dirichlet airbox.",
                           "Profile identification, spectral coverage and convergence remain required."]}
    (output/"comparison.json").write_text(json.dumps(report,indent=2)+"\n")
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
