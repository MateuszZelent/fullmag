"""Reference-only diagnosis of a single strip, return current, and aperture.

Ideal infinite-y, zero-thickness strips in the one-sided s=0 limit.
No Fullmag solve, full 3D circuit, fitted normalization, or native qualification.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
from pathlib import Path
import time

import numpy as np
from scipy.integrate import simpson
from scipy.special import sici

from reference_sushruth_2020_antenna_spectrum import antenna_spectra


def pair_spectrum(k_rad_per_m, *, width_m, return_width_m, gap_m, half_window_m=None):
    """Fourier integral of +1/L and -1/W rectangles, exp(+ikx), without refitting."""
    k = np.asarray(k_rad_per_m,dtype=float)
    if (k.ndim!=1 or not k.size or not np.all(np.isfinite(k))
            or not all(math.isfinite(v) for v in [width_m,return_width_m,gap_m])
            or min(width_m,return_width_m)<=0 or gap_m<0
            or (half_window_m is not None and
                (not math.isfinite(half_window_m) or half_window_m<=0))):
        raise ValueError("Finite k, positive strip widths and aperture, nonnegative gap required")
    answer = np.zeros(k.size,dtype=complex)
    for low,high,sign,width in [(-width_m/2,width_m/2,1.,width_m),
            (width_m/2+gap_m,width_m/2+gap_m+return_width_m,-1.,return_width_m)]:
        if half_window_m is not None:
            low,high = max(low,-half_window_m),min(high,half_window_m)
        if high>low:
            length,center = high-low,(high+low)/2
            answer += sign*(length/width)*np.sinc(k*length/(2*math.pi))*np.exp(1j*k*center)
    return answer


def strip_power_integral(width_m, maximum_k_rad_per_m):
    """Integral from 0 to K of sinc(k*w/2)^2, with SI k and a stable small argument."""
    if (not math.isfinite(width_m) or width_m<=0
            or not math.isfinite(maximum_k_rad_per_m) or maximum_k_rad_per_m<0):
        raise ValueError("Positive finite width and nonnegative finite bandwidth required")
    z = width_m*maximum_k_rad_per_m
    if z<1e-3:
        return maximum_k_rad_per_m*(1-z*z/36+z**4/1800-z**6/141120)
    return 2/width_m*(sici(z)[0]-2*math.sin(z/2)**2/z)


def run_diagnostic(criteria_path,output_dir):
    started = time.monotonic()
    criteria_raw = criteria_path.read_bytes()
    settings = json.loads(criteria_raw)
    repo = Path(__file__).resolve().parents[1]
    reference_path = repo/settings["reference_path"]
    if hashlib.sha256(reference_path.read_bytes()).hexdigest()!=settings["reference_sha256"]:
        raise ValueError("Existing spectrum reference pin differs")
    output_dir.mkdir(exist_ok=False)
    width = settings["width_m"]
    maximum = settings["maximum_k_rad_per_m"]
    records,windows = [],[]
    saved = {}
    for count in settings["interval_counts"]:
        k = np.linspace(0,maximum,count+1)
        ideal = np.array([antenna_spectra(float(wave),width_m=width,
            gap_m=200e-9,spacing_m=0.)["S"] for wave in k])
        denominator = simpson(abs(ideal)**2,x=k)
        for index,return_width in enumerate(settings["return_widths_m"]):
            pair = pair_spectrum(k,width_m=width,return_width_m=return_width,gap_m=settings["edge_gap_m"])
            measured = math.sqrt(simpson(abs(pair-ideal)**2,x=k)/denominator)
            expected = math.sqrt(strip_power_integral(return_width,maximum)/strip_power_integral(width,maximum))
            records.append({"intervals":count,"return_width_m":return_width,
                "finite_band_relative_l2_amplitude":measured,
                "finite_band_closed_integral_prediction":expected,
                "relative_integration_difference":abs(measured/expected-1),
                "whole_axis_l2_amplitude_prediction":math.sqrt(width/return_width),
                "global_A_zero_abs":float(abs(pair[0])),
                "maximum_display_power":float(np.max(4*abs(pair)**2))})
            if count==settings["interval_counts"][-1]:
                saved["pair_"+str(index)] = pair
                for half_window in settings["half_windows_m"]:
                    local = pair_spectrum(k,width_m=width,return_width_m=return_width,
                        gap_m=settings["edge_gap_m"],half_window_m=half_window)
                    windows.append({"return_width_m":return_width,"half_window_m":half_window,
                        "maximum_complex_amplitude_difference_from_S":float(np.max(abs(local-ideal))),
                        "local_A_zero_real":float(local[0].real),
                        "local_display_power_zero":float(4*abs(local[0])**2)})
        if count==settings["interval_counts"][-1]:
            saved.update(k_rad_per_m=k,ideal=ideal)
    np.savez_compressed(output_dir/"spectra.npz",**saved)
    increments = []
    final_count,previous_count = settings["interval_counts"][-1],settings["interval_counts"][-2]
    for return_width in settings["return_widths_m"]:
        final = next(r for r in records if r["intervals"]==final_count and r["return_width_m"]==return_width)
        previous = next(r for r in records if r["intervals"]==previous_count and r["return_width_m"]==return_width)
        increments.append({"return_width_m":return_width,
            "last_relative_increment":abs(final["finite_band_relative_l2_amplitude"]/
                previous["finite_band_relative_l2_amplitude"]-1)})
    gates = settings["criteria"]
    passed = {
        "zero_global":all(r["global_A_zero_abs"]<=gates["global_zero_mode_absolute"] for r in records),
        "declared_local_aperture":all(r["maximum_complex_amplitude_difference_from_S"]<=gates["local_window_maximum_amplitude_error"] for r in windows),
        "finite_band_quadrature":all(r["relative_integration_difference"]<=gates["finite_band_integral_relative_error"] for r in records if r["intervals"]==final_count),
        "last_increment":all(r["last_relative_increment"]<=gates["last_integral_increment_relative"] for r in increments)}
    result = {"verdict":"SINGLE_RETURN_MODEL_DIAGNOSTIC_PASS" if all(passed.values()) else "SINGLE_RETURN_MODEL_DIAGNOSTIC_FAIL",
        "settings":settings,"records":records,"windows":windows,"last_increments":increments,"gates":passed,
        "criteria_sha256":hashlib.sha256(criteria_raw).hexdigest(),
        "driver_sha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "elapsed_seconds_before_render":time.monotonic()-started,
        "new_transport_solve":False,"new_native_field_solve":False,"fullmag_spectrum":"NOT VERIFIED",
        "parameter_fit":False,"scope":"Ideal reference model; no finite 3D circuit or Fullmag qualification."}
    for filename,values in [("band-comparison.csv",records),("aperture-comparison.csv",windows)]:
        with (output_dir/filename).open("x",newline="") as stream:
            writer = csv.DictWriter(stream,fieldnames=list(values[0]))
            writer.writeheader()
            writer.writerows(values)
    (output_dir/"results.json").write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False)+"\n")
    render_diagnostic(output_dir,saved,result)
    manifest={p.name:{"bytes":p.stat().st_size,"sha256":hashlib.sha256(p.read_bytes()).hexdigest()}
        for p in output_dir.iterdir() if p.is_file()}
    (output_dir/"artifact-manifest.json").write_text(json.dumps(manifest,indent=2)+"\n")
    return result


def render_diagnostic(output_dir,saved,result):
    os.environ["MPLCONFIGDIR"] = str(output_dir/"matplotlib-cache")
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    settings = result["settings"]
    k = saved["k_rad_per_m"]/1e6
    ideal = 4*abs(saved["ideal"])**2
    fig,axes = plt.subplots(2,2,figsize=(13,9),layout="constrained")
    for ax in axes[0]:
        ax.plot(k,ideal,color="black",lw=2,label="Pasek S, Fig1: 4|A_S|²")
        for i in [0,3]:
            width = settings["return_widths_m"][i]
            ax.plot(k,4*abs(saved["pair_"+str(i)])**2,lw=1,label=f"S + powrót W={width*1e6:g} µm")
        ax.set(xlabel="k [rad/µm]",ylabel="4|A|² [1]")
        ax.legend(fontsize=9)
    axes[0,0].set(title="Cała oś x: dodanie powrotu zmienia widmo",xlim=(0,30))
    axes[0,1].set(title="Małe k: granica nie jest jednostajna",xlim=(0,.5))
    widths = np.array(settings["return_widths_m"])*1e6
    final = [r for r in result["records"] if r["intervals"]==settings["interval_counts"][-1]]
    global_zero = [4*r["global_A_zero_abs"]**2 for r in final]
    local_zero = [next(r["local_display_power_zero"] for r in result["windows"]
        if r["return_width_m"]==width and r["half_window_m"]==8e-6)
        for width in settings["return_widths_m"]]
    axes[1,0].semilogx(widths,global_zero,"o-",label="Cała oś: obliczone P(0)")
    axes[1,0].semilogx(widths,local_zero,"s--",label="Okno ±8 µm, s=t=0: obliczone P(0)")
    axes[1,0].set(title="Obszar obserwacji definiuje inny wynik",
        xlabel="Szerokość powrotu W [µm]",ylabel="Wartość przy k=0 [1]",ylim=(-.3,4.8))
    axes[1,0].legend(fontsize=9)
    final=[r for r in result["records"] if r["intervals"]==settings["interval_counts"][-1]]
    axes[1,1].loglog(widths,[100*r["finite_band_relative_l2_amplitude"] for r in final],"o",label="Całkowanie w paśmie 0…30 rad/µm")
    axes[1,1].loglog(widths,[100*r["finite_band_closed_integral_prediction"] for r in final],"--",label="Wzór dla tego samego pasma")
    axes[1,1].loglog(widths,[100*r["whole_axis_l2_amplitude_prediction"] for r in final],":",label="Cała oś k: 100√(L/W)")
    axes[1,1].set(title="Błąd amplitudy w L₂ maleje mimo różnicy przy zerze",
        xlabel="Szerokość powrotu W [µm]",ylabel="Względna różnica amplitudy [%]")
    axes[1,1].legend(fontsize=9)
    for ax in axes.flat:
        ax.grid(alpha=.2)
    fig.suptitle("Pojedynczy pasek S — powrót prądu i obszar obserwacji\n"
                 "Model analityczny: L=200 nm, g=16 µm, s=t=0; NIE wykonanie Fullmaga",
                 fontsize=13,fontweight="bold")
    fig.savefig(output_dir/"single-strip-return-and-aperture.png",dpi=170)
    fig.savefig(output_dir/"single-strip-return-and-aperture.svg")
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--criteria",type=Path,required=True)
    parser.add_argument("--output-dir",type=Path,required=True)
    args = parser.parse_args()
    if hasattr(os,"sched_getaffinity"):
        os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
    result = run_diagnostic(args.criteria,args.output_dir)
    print(json.dumps({"verdict":result["verdict"],"gates":result["gates"],
        "maximum_integration_difference":max(r["relative_integration_difference"] for r in result["records"]),
        "maximum_window_error":max(r["maximum_complex_amplitude_difference_from_S"] for r in result["windows"])}))
    return 0 if result["verdict"]=="SINGLE_RETURN_MODEL_DIAGNOSTIC_PASS" else 2


if __name__=="__main__":
    raise SystemExit(main())
