"""Independent line-Fourier postprocessing of retained 3D RT0 current.

No native library, transport/field solve, public spectrum, or accepted-basis
promotion. The x observation integral is analytic; source integration is
Gauss-Duffy quadrature. Positive Fourier exponent, SI integral normalization.
"""
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
from scipy.special import k1

from verify_sushruth_2020_field_fft import reference_plus


def tetra_rule(order):
    """Barycentric points and reference-volume weights summing to 1/6."""
    if type(order) is not int or not 2 <= order <= 12:
        raise ValueError("Gauss order must be an integer from 2 to 12")
    roots, weights = np.polynomial.legendre.leggauss(order)
    roots, weights = (roots+1)/2, weights/2
    u,v,w = np.meshgrid(roots,roots,roots,indexing="ij")
    wu,wv,ww = np.meshgrid(weights,weights,weights,indexing="ij")
    bary = np.stack(((1-u)*(1-v)*(1-w),u,(1-u)*v,(1-u)*(1-v)*w),axis=-1)
    return bary.reshape(-1,4),(wu*wv*ww*(1-u)**2*(1-v)).ravel()


def rt0_sample_moment(vertices, coefficients, bary):
    """Return r_q and J(r_q)*D_T, not display/nodally averaged current."""
    vertices = np.asarray(vertices,dtype=np.longdouble)
    coefficients = np.asarray(coefficients,dtype=np.longdouble)
    edges = vertices[:,1:]-vertices[:,0,None]
    offset = np.sum(edges*np.asarray(bary[1:],dtype=np.longdouble)[None,:,None],axis=1)
    numerator = (np.sum(coefficients,axis=1)[:,None]*offset
                 - np.sum(coefficients[:,1:,None]*edges,axis=1))
    return vertices[:,0]+offset,numerator


def line_kernel(k_rad_per_m, radius_m):
    """q K1(q a)/a, using u*K1(u)/a^2 and its exact q=0 limit."""
    k = np.asarray(k_rad_per_m,dtype=float)
    radius = np.asarray(radius_m,dtype=float)
    if (k.ndim!=1 or radius.ndim!=1 or not np.all(np.isfinite(k))
            or not np.all(np.isfinite(radius)) or np.any(radius<=0)):
        raise ValueError("Finite wave numbers and positive separated radii required")
    u = np.abs(k[:,None])*radius[None,:]
    uk1 = np.ones_like(u)
    nonzero = u!=0
    uk1[nonzero] = u[nonzero]*k1(u[nonzero])
    return uk1/(radius[None,:]**2)


def field_spectrum(vertices, coefficients, k_rad_per_m, *, y_m, z_m, order, progress=None):
    """Return Hhat_x [A] and sum of absolute source terms [A].

    Only lines in a plane strictly above/below the entire source are accepted.
    This conservative condition guarantees separation for this experiment.
    """
    vertices = np.asarray(vertices,dtype=np.longdouble)
    coefficients = np.asarray(coefficients,dtype=np.longdouble)
    k = np.asarray(k_rad_per_m,dtype=float)
    if (vertices.ndim!=3 or vertices.shape[1:]!=(4,3) or vertices.shape[0]==0
            or coefficients.shape!=vertices.shape[:2] or k.ndim!=1 or k.size==0
            or not np.all(np.isfinite(vertices)) or not np.all(np.isfinite(coefficients))
            or not np.all(np.isfinite(k)) or not math.isfinite(y_m) or not math.isfinite(z_m)
            or not (z_m < np.min(vertices[:,:,2]) or z_m > np.max(vertices[:,:,2]))):
        raise ValueError("Finite Tet4 RT0 source and strictly separated observation plane required")
    bary,weights = tetra_rule(order)
    real,imag,bound = (np.zeros(k.size,dtype=np.longdouble) for _ in range(3))
    for number,(point,weight) in enumerate(zip(bary,weights),1):
        position,numerator = rt0_sample_moment(vertices,coefficients,point)
        dy,dz = np.longdouble(y_m)-position[:,1],np.longdouble(z_m)-position[:,2]
        radius = np.asarray(np.sqrt(dy*dy+dz*dz),dtype=float)
        strength = weight*(numerator[:,1]*dz-numerator[:,2]*dy)/(2*math.pi)
        x = np.asarray(position[:,0],dtype=float)
        for start in range(0,k.size,8):
            waves = k[start:start+8]
            values = line_kernel(waves,radius)*strength[None,:]
            phase = waves[:,None]*x[None,:]
            real[start:start+8] += np.sum(values*np.cos(phase),axis=1,dtype=np.longdouble)
            imag[start:start+8] += np.sum(values*np.sin(phase),axis=1,dtype=np.longdouble)
            bound[start:start+8] += np.sum(np.abs(values),axis=1,dtype=np.longdouble)
        if progress is not None and (number%8==0 or number==len(weights)):
            progress({"quadrature_point":number,"quadrature_total":len(weights),"k_count":k.size})
    return np.asarray(real,dtype=float)+1j*np.asarray(imag,dtype=float),np.asarray(bound,dtype=float)


def write_json(path,value):
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False)+"\n")


def write_csv(path,header,rows):
    with path.open("x",newline="") as stream:
        writer=csv.writer(stream)
        writer.writerow(header)
        writer.writerows(rows)


def run_reference(criteria_path, output_dir):
    started = time.monotonic()
    criteria_raw = criteria_path.read_bytes()
    settings = json.loads(criteria_raw)
    output_dir.mkdir(exist_ok=False)
    repo = Path(__file__).resolve().parents[1]
    parser_path = repo/"tools/gsg_surface_native_probe.py"
    if hashlib.sha256(parser_path.read_bytes()).hexdigest()!=settings["parser_sha256"]:
        raise ValueError("Source parser pin differs")
    spec = importlib.util.spec_from_file_location("retained_rt0_pure_parser",parser_path)
    parser = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(parser)
    print(json.dumps({"phase":"read_and_verify_source","seconds":time.monotonic()-started}),flush=True)
    manifest,payloads = parser.read_bundle((repo/settings["source_bundle"]).resolve(),settings["source_bundle_sha256"])
    frozen,packing = parser.pack_rt0(payloads["cells"],payloads["faces"],
        settings["source_cells"],settings["source_vertices"])
    if packing["frozen_sha256"]!=settings["frozen_sha256"]:
        raise ValueError("Reconstructed RT0 source pin differs")
    current = float(manifest["source"]["source_current_a"])
    if not math.isfinite(current) or current==0:
        raise ValueError("Finite nonzero signed reference current required")
    (output_dir/"frozen-rt0-input.bin").write_bytes(frozen)
    source_record = {"bundle_sha256":settings["source_bundle_sha256"],"packing":packing,
        "signed_reference_current_a":current,"source":manifest["source"],
        "inspection_only":True,"durable_source_authentication":False,
        "native_spectrum_executed":False}
    write_json(output_dir/"source-readback.json",source_record)
    del payloads
    packed = np.frombuffer(frozen,dtype="<f8").reshape(-1,16)
    vertices,coefficients = packed[:,:12].reshape(-1,4,3),packed[:,12:]
    k = np.asarray(settings["k_rad_per_m"])
    results,bounds,timings = {},{},[]
    args = dict(y_m=settings["observation_y_m"],z_m=settings["observation_z_m"])
    for order in settings["quadrature_orders"]:
        before=time.monotonic()
        def progress(row):
            print(json.dumps({"phase":"source_quadrature","order":order,
                             "elapsed_seconds":time.monotonic()-started,**row}),flush=True)
        transformed,absolute = field_spectrum(vertices,coefficients,k,order=order,progress=progress,**args)
        results[order],bounds[order] = -2*transformed/current,2*absolute/abs(current)
        timings.append({"order":order,"k_count":len(k),"seconds":time.monotonic()-before})
        write_csv(output_dir/f"spectrum-order-{order}.csv",
            ["k_rad_per_m","A_plus_real","A_plus_imag","power","absolute_source_sum"],
            zip(k,results[order].real,results[order].imag,np.abs(results[order])**2,bounds[order]))
    check_k=np.asarray(settings["check_k_rad_per_m"])
    order=settings["check_order"]
    before=time.monotonic()
    def progress(row):
        print(json.dumps({"phase":"higher_order_check","order":order,
                         "elapsed_seconds":time.monotonic()-started,**row}),flush=True)
    checked,checked_bound=field_spectrum(vertices,coefficients,check_k,order=order,progress=progress,**args)
    checked=-2*checked/current
    checked_bound=2*checked_bound/abs(current)
    timings.append({"order":order,"k_count":len(check_k),"seconds":time.monotonic()-before})
    write_csv(output_dir/f"spectrum-order-{order}-check.csv",
        ["k_rad_per_m","A_plus_real","A_plus_imag","power","absolute_source_sum"],
        zip(check_k,checked.real,checked.imag,np.abs(checked)**2,checked_bound))
    previous,last = settings["quadrature_orders"][-2:]
    # Increments are evaluated before any comparison with a different model.
    increment = float(np.max(np.abs(results[last]-results[previous])))
    indices=[list(k).index(wave) for wave in check_k]
    higher = float(np.max(np.abs(checked-results[last][indices])))
    zero = float(abs(checked[list(check_k).index(0.)]))
    expected=reference_plus(k,settings["reference"]["width_m"],settings["reference"])["GSG"]
    error=results[last]-expected
    write_csv(output_dir/"comparison.csv",
        ["k_rad_per_m","retained_A_real","retained_A_imag","infinite_A_real","infinite_A_imag",
         "retained_power","infinite_power","power_difference"],
        zip(k,results[last].real,results[last].imag,expected.real,expected.imag,
            abs(results[last])**2,abs(expected)**2,abs(results[last])**2-abs(expected)**2))
    peak_rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/1024
    gates=settings["criteria"]
    passed=(increment<=gates["last_order_increment_max_amplitude"]
            and higher<=gates["higher_order_check_max_amplitude"]
            and zero<=gates["zero_mode_max_amplitude"] and peak_rss<=gates["maximum_peak_rss_mib"])
    record={"criteria_sha256":hashlib.sha256(criteria_raw).hexdigest(),
        "driver_sha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "source":source_record,"settings":settings,"timings":timings,
        "elapsed_seconds":time.monotonic()-started,"peak_rss_mib":peak_rss,
        "last_order_increment_max_amplitude":increment,"higher_order_check_max_amplitude":higher,
        "zero_mode_amplitude":zero,"max_imaginary_amplitude":float(np.max(abs(results[last].imag))),
        "retained_vs_infinite_strips":{"relative_l2_complex_error":float(np.linalg.norm(error)/np.linalg.norm(expected)),
          "max_absolute_amplitude_difference":float(np.max(abs(error))),
          "max_absolute_power_difference":float(np.max(abs(abs(results[last])**2-abs(expected)**2))),
          "retained_max_on_pilot_grid":{"k_rad_per_m":float(k[np.argmax(abs(results[last])**2)]),
                                       "power":float(np.max(abs(results[last])**2))},
          "reference_max_on_pilot_grid":{"k_rad_per_m":float(k[np.argmax(abs(expected)**2)]),
                                       "power":float(np.max(abs(expected)**2))}},
        "verdict":"RETAINED_REFERENCE_PILOT_PASS" if passed else "RETAINED_REFERENCE_PILOT_FAIL",
        "fullmag_native_field_spectrum":"NOT VERIFIED","new_transport_solve":False,
        "parameter_fit_performed":False}
    write_json(output_dir/"results.json",record)
    render_comparison(output_dir,k,results,expected,checked,check_k,record)
    write_json(output_dir/"artifact-manifest.json",{
        p.name:{"bytes":p.stat().st_size,"sha256":hashlib.sha256(p.read_bytes()).hexdigest()}
        for p in output_dir.iterdir() if p.is_file()})
    return record


def render_comparison(output_dir,k,results,expected,checked,check_k,record):
    os.environ["MPLCONFIGDIR"]=str(output_dir/"matplotlib-config")
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig,axes=plt.subplots(2,2,figsize=(12,8),layout="constrained")
    finest=results[max(results)]
    axes[0,0].plot(k/1e6,abs(expected)**2,color="#222222",label="Paski nieskończone, jednorodny J")
    axes[0,0].plot(k/1e6,abs(finest)**2,"o-",ms=4,color="#2262aa",label="Zachowany prąd 3D → całka referencyjna")
    axes[0,0].set(title="GSG: ten sam przekrój, różne modele źródła",ylabel="Kwadrat modułu amplitudy (1)")
    axes[0,0].legend(fontsize=8)
    axes[0,1].plot(k/1e6,abs(finest)**2-abs(expected)**2,"o-",ms=3,color="#b13943")
    axes[0,1].set(title="Różnica modeli, bez dopasowania",ylabel="P₃D − P∞ (1)")
    for order in sorted(results)[:-1]:
        axes[1,0].semilogy(k/1e6,np.maximum(abs(results[order]-finest),1e-18),label=f"n={order} względem n={max(results)}")
    axes[1,0].semilogy(check_k/1e6,np.maximum(abs(checked-finest[[list(k).index(v) for v in check_k]]),1e-18),
                       "s",label=f"n={record['settings']['check_order']} względem n={max(results)}")
    axes[1,0].axhline(record["settings"]["criteria"]["higher_order_check_max_amplitude"],color="#888888",ls=":")
    axes[1,0].set(title="Przyrosty kwadratury pełnego źródła",ylabel="Bezwzględna różnica A (1)")
    axes[1,0].legend(fontsize=8)
    axes[1,1].plot(k/1e6,finest.real,label="Re A₃D")
    axes[1,1].plot(k/1e6,finest.imag,label="Im A₃D")
    axes[1,1].plot(k/1e6,expected.real,"--",label="Re A∞")
    axes[1,1].set(title="Amplituda zespolona; konwencja exp(+ikx)",ylabel="Amplituda (1)")
    axes[1,1].legend(fontsize=8)
    for ax in axes.flat:
        ax.set_xlabel("k (rad/µm)")
        ax.grid(alpha=.2)
    fig.suptitle("Pilot: rzeczywisty zapisany prąd Fullmaga, niezależne widmo referencyjne\n"
                 "L=200 nm, g=250 nm, s=43,7 nm, t=90 nm; native spectrum: NIEZWERYFIKOWANY",
                 fontsize=12,fontweight="bold")
    fig.savefig(output_dir/"retained-current-spectrum.png",dpi=170)
    fig.savefig(output_dir/"retained-current-spectrum.svg")
    plt.close(fig)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--criteria",type=Path,required=True)
    parser.add_argument("--output-dir",type=Path,required=True)
    args=parser.parse_args()
    if hasattr(os,"sched_getaffinity"):
        os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
    record=run_reference(args.criteria,args.output_dir)
    print(json.dumps({key:record[key] for key in ("verdict","last_order_increment_max_amplitude",
        "higher_order_check_max_amplitude","zero_mode_amplitude","elapsed_seconds","peak_rss_mib")}),flush=True)
    return 0 if record["verdict"]=="RETAINED_REFERENCE_PILOT_PASS" else 2


if __name__=="__main__":
    raise SystemExit(main())
