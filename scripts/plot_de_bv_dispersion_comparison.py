"""Plot archived FEM samples against uniform and coupled open-film references.

This diagnostic never synthesizes FEM samples or certifies convergence.
"""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from compare_de_bv_mode_profiles import load_record
from thin_film_thickness_oracle import solve_thickness_modes, MU0


def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--comparison", action="append", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--pending-job", help="job with no new numerical result in this plot")
    args = parser.parse_args()
    rows, seen, inputs = [], set(), {}
    for path in args.comparison:
        data = json.loads(path.read_text(encoding="utf-8"))
        inputs[str(path)] = sha(path)
        for record in data["records"]:
            identity = (record["run_path"], record["pilot"])
            if identity in seen: continue
            _, _, _, _, bound_hashes, _ = load_record(record)
            seen.add(identity)
            rows.append({**record, "plot_mesh_level": record.get("mesh_level", data.get("mesh_level", "L0")),
                         "independent_input_hashes": bound_hashes})
    if not rows: raise ValueError("no bound numerical samples")
    parameters = {k:v for k,v in rows[0]["parameters"].items() if k != "geometry"}
    if any({k:v for k,v in r["parameters"].items() if k != "geometry"} != parameters for r in rows):
        raise ValueError("dispersion plot requires identical film and material parameters")
    ms, thickness = parameters["saturation_magnetisation_a_per_m"], parameters["film_thickness_m"]
    oracle = dict(ms_a_m=ms, thickness_m=thickness,
                  bias_t=parameters["bias_field_a_per_m"] * MU0,
                  exchange_j_m=parameters["exchange_stiffness_j_per_m"],
                  gamma0_m_a_s=parameters["gamma0_rad_s_per_a_m"])
    grid = np.linspace(0, max(r["k_rad_per_m"] for r in rows), 81)
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
            axes[0,col].scatter(x,[r["frequency_hz"]/1e9 for r in selected],label="Archiwalny FEM " + level,**style)
            axes[1,col].scatter(x,errors,**style)
        axes[0,col].set(title=short + (r": $\mathbf{k}\perp\mathbf{M}_0$" if short=="DE" else r": $\mathbf{k}\parallel\mathbf{M}_0$"),ylabel="Częstotliwość [GHz]")
        axes[0,col].legend(fontsize=8)
        axes[1,col].axhline(0,color="#202a35",linewidth=1)
        axes[1,col].set(xlabel="k [rad/µm]",ylabel="Różnica FEM względem N=32 [%]")
        for ax in axes[:,col]: ax.grid(alpha=.22)
    title="Dyspersja DE/BV — archiwalne punkty FEM i aktualna referencja"
    if args.pending_job: title += "\nJob #" + args.pending_job + ": jeszcze bez nowych punktów"
    fig.suptitle(title,fontsize=14)
    fig.supxlabel(f"Film {thickness*1e9:g} nm · Ms={ms/1e3:g} kA/m · A={oracle['exchange_j_m']*1e12:g} pJ/m · B₀={oracle['bias_t']:g} T · demag włączony\nDane historyczne z różnych siatek i wersji źródeł; zbieżność i pełna kwalifikacja nadal otwarte",fontsize=9)
    args.output.mkdir(parents=True,exist_ok=False)
    png,pdf=args.output/"dispersion-de-bv-updated.png",args.output/"dispersion-de-bv-updated.pdf"
    fig.savefig(png,dpi=170); fig.savefig(pdf); plt.close(fig)
    report={"schema":"fullmag.archived-dispersion-plot.v1","qualification":"NOT VERIFIED",
            "scope":"archived FEM points; open-film references; not a new solve or convergence certificate",
            "pending_job":args.pending_job,"parameters":parameters,"oracle_parameters":oracle,
            "input_comparison_sha256":inputs,"source_sha256":{str(p):sha(p) for p in (Path(__file__),Path(__file__).with_name("thin_film_thickness_oracle.py"),Path(__file__).with_name("compare_de_bv_mode_profiles.py"))},
            "records":rows,"references":reference,"output_sha256":{p.name:sha(p) for p in (png,pdf)}}
    (args.output/"plot-receipt.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
    print(json.dumps({"png":str(png),"pdf":str(pdf),"numerical_point_count":len(rows)}))


if __name__=="__main__": main()
