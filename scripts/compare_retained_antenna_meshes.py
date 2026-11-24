"""Compare two retained RT0 solutions without a new transport or native solve."""
from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import resource
import time

import numpy as np

from reference_retained_rt0_spectrum import field_spectrum, write_csv, write_json


def integrated_current_squared(vertices, coefficients):
    """Exact integral of |J_RT0|^2 dV, in A^2/m, for positively oriented Tet4."""
    vertices = np.asarray(vertices,dtype=np.longdouble)
    coefficients = np.asarray(coefficients,dtype=np.longdouble)
    if (vertices.ndim!=3 or vertices.shape[1:]!=(4,3) or not len(vertices)
            or coefficients.shape!=vertices.shape[:2]
            or not np.all(np.isfinite(vertices)) or not np.all(np.isfinite(coefficients))):
        raise ValueError("Finite nonempty Tet4 vertices and four RT0 coefficients required")
    edges = vertices[:,1:]-vertices[:,0,None]
    a,b,c = edges[:,0],edges[:,1],edges[:,2]
    determinant = (a[:,0]*(b[:,1]*c[:,2]-b[:,2]*c[:,1])
                   - a[:,1]*(b[:,0]*c[:,2]-b[:,2]*c[:,0])
                   + a[:,2]*(b[:,0]*c[:,1]-b[:,1]*c[:,0]))
    if not np.all(np.isfinite(determinant)) or np.any(determinant<=0):
        raise ValueError("Strictly positive nondegenerate Tet4 orientation required")
    center_offset = np.sum(edges,axis=1)/4
    coefficient_sum = np.sum(coefficients,axis=1)
    center_moment = (coefficient_sum[:,None]*center_offset
                     - np.sum(coefficients[:,1:,None]*edges,axis=1))
    centered = np.concatenate((-center_offset[:,None],edges-center_offset[:,None]),axis=1)
    mean_square = (np.sum(center_moment**2,axis=1)
                   + coefficient_sum**2*np.sum(centered**2,axis=(1,2))/20)
    return np.sum(mean_square/(6*determinant),dtype=np.longdouble)


def _checked(path, expected):
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest()!=expected:
        raise ValueError("Input digest differs: "+str(path))
    return raw


def _csv_rows(path):
    with path.open(newline="") as stream:
        return list(csv.DictReader(stream))


def _column(rows,name):
    return np.array([float(row[name]) for row in rows])


def run_comparison(criteria_path,output_dir):
    started = time.monotonic()
    criteria_raw = criteria_path.read_bytes()
    settings = json.loads(criteria_raw)
    repo = Path(__file__).resolve().parents[1]
    integrator = repo/"scripts/reference_retained_rt0_spectrum.py"
    parser_path = repo/"tools/gsg_surface_native_probe.py"
    _checked(integrator,settings["integrator_sha256"])
    _checked(parser_path,settings["parser_sha256"])
    output_dir.mkdir(exist_ok=False)
    provenance_path = criteria_path.parent/"provenance-addendum.json"
    provenance_raw = provenance_path.read_bytes()
    provenance = json.loads(provenance_raw)
    print(json.dumps({"phase":"verify_and_pack_coarse_source"}),flush=True)
    spec = importlib.util.spec_from_file_location("retained_rt0_readonly_parser",parser_path)
    parser = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(parser)
    manifest,payloads = parser.read_bundle(
        (repo/settings["coarse_bundle"]).resolve(),settings["coarse_bundle_sha256"])
    frozen,packing = parser.pack_rt0(payloads["cells"],payloads["faces"],
        settings["coarse_cells"],settings["coarse_vertices"])
    coarse_current = float(manifest["source"]["source_current_a"])
    fine_dir = repo/settings["fine_directory"]
    fine_readback = json.loads(_checked(fine_dir/"pilot-results/source-readback.json",
        settings["fine_readback_sha256"]))
    if fine_readback["bundle_sha256"]!=settings["fine_bundle_sha256"]:
        raise ValueError("Fine source bundle identity differs")
    fine_current = float(fine_readback["signed_reference_current_a"])
    if any(not math.isfinite(value) or value==0 for value in [coarse_current,fine_current]):
        raise ValueError("Finite nonzero signed currents required")
    fine_raw = _checked(fine_dir/"pilot-results/frozen-rt0-input.bin",
        settings["fine_frozen_sha256"])
    if fine_readback["packing"]["frozen_sha256"]!=settings["fine_frozen_sha256"]:
        raise ValueError("Fine frozen source/readback differ")
    fine_h_csv = fine_dir/"native-h-raw-readback.csv"
    _checked(fine_h_csv,settings["fine_h_raw_sha256"])
    fine_h_rows = _csv_rows(fine_h_csv)
    xyz = np.frombuffer(payloads["sample_xyz"],dtype="<f8").reshape(-1,3)
    coarse_h = np.frombuffer(payloads["h_raw"],dtype="<f8").reshape(-1,3)
    fine_xyz = np.column_stack([_column(fine_h_rows,name) for name in ["x_m","y_m","z_m"]])
    fine_h = np.column_stack([_column(fine_h_rows,name) for name in ["Hx_raw","Hy_raw","Hz_raw"]])
    fine_h_metadata = json.loads((fine_dir/"native-h-readback-metadata.json").read_text())
    if (not np.array_equal(xyz,fine_xyz) or coarse_h.shape!=fine_h.shape
            or hashlib.sha256(payloads["sample_xyz"]).hexdigest()!=fine_h_metadata["sample_xyz_sha256"]
            or hashlib.sha256(np.asarray(fine_h,dtype="<f8").tobytes()).hexdigest()!=fine_h_metadata["h_raw_sha256"]
            or manifest["payloads"]["h_raw"]["unit"]!="A/m"
            or not np.all(np.isfinite(coarse_h)) or not np.all(np.isfinite(fine_h))):
        raise ValueError("Native H payload units or target coordinates differ")
    high_path = fine_dir/"dense-results/higher-order-check.csv"
    _checked(high_path,settings["fine_spectrum_sha256"])
    high_rows = _csv_rows(high_path)
    k = np.array(settings["k_rad_per_m"],dtype=float)
    if not np.array_equal(k,_column(high_rows,"k_rad_per_m")):
        raise ValueError("Fine spectrum k grid differs")
    fine_amplitude = _column(high_rows,"A_order6_real")+1j*_column(high_rows,"A_order6_imag")
    (output_dir/"coarse-frozen-rt0-input.bin").write_bytes(frozen)
    coarse_readback = {"bundle_sha256":settings["coarse_bundle_sha256"],
        "all_bundle_payloads_freshly_verified":True,"packing":packing,
        "source":manifest["source"],"signed_reference_current_a":coarse_current,
        "target_xyz_sha256":hashlib.sha256(payloads["sample_xyz"]).hexdigest(),
        "native_h_raw_sha256":hashlib.sha256(payloads["h_raw"]).hexdigest(),
        "inspection_only":True,"durable_source_authentication":False}
    write_json(output_dir/"coarse-source-readback.json",coarse_readback)
    del payloads
    packed_sources = [np.frombuffer(raw,dtype="<f8").reshape(-1,16) for raw in [frozen,fine_raw]]
    sources = [(packed[:,:12].reshape(-1,4,3),packed[:,12:]) for packed in packed_sources]
    currents = [coarse_current,fine_current]
    norms = []
    for (vertices,coefficients),current in zip(sources,currents):
        raw_norm = integrated_current_squared(vertices,coefficients)
        normalized = float(raw_norm/current**2)
        norms.append({"integral_j_squared_a2_per_m":float(raw_norm),
            "per_current_squared_per_m":normalized,
            "rt0_dissipation_resistance_ohm":normalized/settings["conductivity_s_per_m"],
            "voltage_over_current_ohm":float(manifest["source"]["potential_jump_v"])/current})
    timings = []
    spectra = {}
    sample_args = {"y_m":settings["observation_y_m"],"z_m":settings["observation_z_m"]}
    def evaluate(label,source,current,waves,order):
        before = time.monotonic()
        def progress(row):
            print(json.dumps({"phase":"retained_source_quadrature","source":label,
                "order":order,"elapsed_seconds":time.monotonic()-started,**row}),flush=True)
        amplitude,bound = field_spectrum(*source,waves,order=order,progress=progress,**sample_args)
        timings.append({"source":label,"order":order,"k_count":len(waves),
            "seconds":time.monotonic()-before})
        return -2*amplitude/current,2*bound/abs(current)
    for order in settings["coarse_orders"]:
        amplitude,bound = evaluate("coarse",sources[0],currents[0],k,order)
        spectra[order] = amplitude
        write_csv(output_dir/f"coarse-spectrum-order-{order}.csv",
            ["k_rad_per_m","A_real","A_imag","power","absolute_source_sum"],
            zip(k,amplitude.real,amplitude.imag,abs(amplitude)**2,bound))
    check_k = np.array(settings["higher_check_k_rad_per_m"],dtype=float)
    indices = [list(k).index(value) for value in check_k]
    checked = []
    for label,source,current in zip(["coarse","fine"],sources,currents):
        amplitude,bound = evaluate(label,source,current,check_k,settings["higher_check_order"])
        checked.append(amplitude)
        write_csv(output_dir/f"{label}-spectrum-order8-check.csv",
            ["k_rad_per_m","A_real","A_imag","power","absolute_source_sum"],
            zip(check_k,amplitude.real,amplitude.imag,abs(amplitude)**2,bound))
    coarse_amplitude = spectra[6]
    amplitude_difference = coarse_amplitude-fine_amplitude
    native_difference = coarse_h[:,0]/coarse_current-fine_h[:,0]/fine_current
    higher_changes = [float(np.max(abs(value-baseline[indices])))
        for value,baseline in zip(checked,[coarse_amplitude,fine_amplitude])]
    peak_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024
    metrics = {
        "relative_l2_complex_amplitude":float(np.linalg.norm(amplitude_difference)/np.linalg.norm(fine_amplitude)),
        "maximum_absolute_amplitude":float(np.max(abs(amplitude_difference))),
        "maximum_absolute_power":float(np.max(abs(abs(coarse_amplitude)**2-abs(fine_amplitude)**2))),
        "native_Hx_per_A_relative_l2_change":float(np.linalg.norm(native_difference)/np.linalg.norm(fine_h[:,0]/fine_current)),
        "native_Hx_per_A_maximum_change_per_m":float(np.max(abs(native_difference))),
        "normalized_current_squared_relative_change":float(abs(norms[0]["per_current_squared_per_m"]/norms[1]["per_current_squared_per_m"]-1)),
        "raw_reference_current_relative_change":float(abs(coarse_current/fine_current-1)),
        "coarse_order4_to_6_maximum_amplitude":float(np.max(abs(spectra[4]-coarse_amplitude))),
        "coarse_order6_to_8_maximum_amplitude":higher_changes[0],
        "fine_order6_to_8_maximum_amplitude":higher_changes[1],
        "computational_peak_rss_mib":peak_rss}
    gates = settings["criteria"]
    passed = {
        "complex_amplitude_l2":metrics["relative_l2_complex_amplitude"]<=gates["maximum_mesh_relative_l2_amplitude"],
        "absolute_amplitude":metrics["maximum_absolute_amplitude"]<=gates["maximum_mesh_absolute_amplitude"],
        "native_Hx":metrics["native_Hx_per_A_relative_l2_change"]<=gates["maximum_native_Hx_relative_l2_change"],
        "current_norm":metrics["normalized_current_squared_relative_change"]<=gates["maximum_current_norm_relative_change"],
        "higher_quadrature":max(higher_changes)<=gates["maximum_order6_to_8_amplitude"],
        "memory":peak_rss<=gates["maximum_peak_rss_mib"]}
    write_csv(output_dir/"spectrum-comparison.csv",
        ["k_rad_per_m","coarse_A_real","coarse_A_imag","fine_A_real","fine_A_imag",
         "coarse_power","fine_power","absolute_amplitude_difference","power_difference"],
        zip(k,coarse_amplitude.real,coarse_amplitude.imag,fine_amplitude.real,fine_amplitude.imag,
            abs(coarse_amplitude)**2,abs(fine_amplitude)**2,abs(amplitude_difference),
            abs(coarse_amplitude)**2-abs(fine_amplitude)**2))
    write_csv(output_dir/"native-h-comparison.csv",
        ["x_m","y_m","z_m","coarse_Hx_per_A","fine_Hx_per_A","difference_per_m"],
        zip(*xyz.T,coarse_h[:,0]/coarse_current,fine_h[:,0]/fine_current,native_difference))
    record = {"verdict":"SAVED_SOLUTION_STABILITY_PASS" if all(passed.values()) else "SAVED_SOLUTION_STABILITY_FAIL",
        "criteria_sha256":hashlib.sha256(criteria_raw).hexdigest(),
        "driver_sha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "provenance_addendum_sha256":hashlib.sha256(provenance_raw).hexdigest(),
        "provenance_limitations":provenance,"settings":settings,"metrics":metrics,"gates":passed,
        "source_norms":{"coarse":norms[0],"fine":norms[1]},
        "signed_currents_a":currents,"source_counts":[len(sources[0][0]),len(sources[1][0])],
        "timings":timings,"elapsed_seconds_before_render":time.monotonic()-started,
        "native_spectrum":"NOT VERIFIED","source_qualification":"NOT VERIFIED",
        "new_transport_solve":False,"new_native_field_solve":False,"parameter_fit":False,
        "scope":"Stability of two retained solutions with different dirty runtimes; not a mesh-only convergence order."}
    write_json(output_dir/"results.json",record)
    render_comparison(output_dir,k,coarse_amplitude,fine_amplitude,spectra[4],
        check_k,checked,native_difference,record)
    write_json(output_dir/"artifact-manifest.json",{p.name:{
        "bytes":p.stat().st_size,"sha256":hashlib.sha256(p.read_bytes()).hexdigest()}
        for p in output_dir.iterdir() if p.is_file()})
    return record


def render_comparison(output_dir,k,coarse,fine,order4,check_k,checked,native_difference,record):
    os.environ["MPLCONFIGDIR"] = str(output_dir/"matplotlib-cache")
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig,axes = plt.subplots(2,2,figsize=(12,8),layout="constrained")
    axes[0,0].plot(k/1e6,abs(coarse)**2,label="40 728 Tet4")
    axes[0,0].plot(k/1e6,abs(fine)**2,"--",label="85 980 Tet4")
    axes[0,0].set(title="Widmo ze źródeł RT0, niezależna całka",ylabel="|A|² [1]")
    axes[0,0].legend()
    axes[0,1].semilogy(k/1e6,np.maximum(abs(coarse-fine),1e-20),label="Zmiana zapisanego rozwiązania")
    axes[0,1].semilogy(k/1e6,np.maximum(abs(order4-coarse),1e-20),label="Kwadratura 4 → 6, źródło 40k")
    for label,value,base in zip(["40k","86k"],checked,[coarse,fine]):
        indices = [list(k).index(v) for v in check_k]
        axes[0,1].semilogy(check_k/1e6,np.maximum(abs(value-base[indices]),1e-20),"o",label="Kwadratura 6 → 8, "+label)
    axes[0,1].axhline(record["settings"]["criteria"]["maximum_mesh_absolute_amplitude"],color=".5",ls=":")
    axes[0,1].set(title="Rozdzielone przyrosty amplitudy",ylabel="Bezwzględna różnica A [1]")
    axes[0,1].legend(fontsize=8)
    axes[1,0].plot(np.arange(len(native_difference)),native_difference,"o")
    axes[1,0].axhline(0,color=".5",lw=.8)
    axes[1,0].set(title="Hₓ: 20 identycznych zapisanych targetów",
                  xlabel="Indeks targetu",ylabel="Hₓ/I: 40k − 86k [1/m]")
    axes[1,1].axis("off")
    metrics = record["metrics"]
    text = (f"Zmiana zespolonej amplitudy L₂: {100*metrics['relative_l2_complex_amplitude']:.6g}%\n"
        f"Zmiana native Hₓ/I, L₂: {100*metrics['native_Hx_per_A_relative_l2_change']:.6g}%\n"
        f"Zmiana ∫|J/I|² dV: {100*metrics['normalized_current_squared_relative_change']:.6g}%\n"
        f"Próg każdej z tych zmian: 0,1%\n\n"
        "Różne wersje dirty runtime.\nLokalne zagęszczenie naroży i połączeń.\n"
        "Dwa rozwiązania nie wyznaczają rzędu zbieżności.\n"
        "Native spectrum i kwalifikacja źródła: NIEZWERYFIKOWANE.")
    axes[1,1].text(0,.9,text,va="top",fontsize=11,linespacing=1.6)
    for ax in [axes[0,0],axes[0,1]]:
        ax.set_xlabel("k [rad/µm]")
    for ax in axes.flat:
        ax.grid(alpha=.2)
    fig.suptitle("Stabilność zachowanych rozwiązań GSG — bez nowego Solve\n"
                 "Zgodność między tymi rozwiązaniami nie oznacza jeszcze odtworzenia publikacji",
                 fontsize=12,fontweight="bold")
    fig.savefig(output_dir/"saved-solution-stability.png",dpi=170)
    fig.savefig(output_dir/"saved-solution-stability.svg")
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--criteria",type=Path,required=True)
    parser.add_argument("--output-dir",type=Path,required=True)
    args = parser.parse_args()
    if hasattr(os,"sched_getaffinity"):
        os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
    record = run_comparison(args.criteria,args.output_dir)
    print(json.dumps({"verdict":record["verdict"],"metrics":record["metrics"]}),flush=True)
    return 0 if record["verdict"]=="SAVED_SOLUTION_STABILITY_PASS" else 2


if __name__=="__main__":
    raise SystemExit(main())
