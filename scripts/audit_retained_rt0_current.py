"""Independent audit of retained Tet4 RT0 current, not a new Fullmag solve."""
from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import struct
import time

import numpy as np

WINDING = ((1,2,3),(0,3,2),(0,1,3),(0,2,1))
EDGES = ((0,1),(0,2),(0,3),(1,2),(1,3),(2,3))


def _geometry(vertices, coefficients):
    v,c = np.asarray(vertices,dtype=np.longdouble),np.asarray(coefficients,dtype=np.longdouble)
    if (v.ndim!=3 or v.shape[1:]!=(4,3) or not len(v) or c.shape!=v.shape[:2]
            or not np.all(np.isfinite(v)) or not np.all(np.isfinite(c))):
        raise ValueError("Finite nonempty Tet4 and four RT0 coefficients required")
    edges = v[:,1:]-v[:,0,None]
    a,b,z = edges[:,0],edges[:,1],edges[:,2]
    determinant = (a[:,0]*(b[:,1]*z[:,2]-b[:,2]*z[:,1])
                   -a[:,1]*(b[:,0]*z[:,2]-b[:,2]*z[:,0])
                   +a[:,2]*(b[:,0]*z[:,1]-b[:,1]*z[:,0]))
    if np.any(determinant<=0) or not np.all(np.isfinite(determinant)):
        raise ValueError("Positive nondegenerate Tet4 orientation required")
    return v,c,edges,determinant


def current_moments(vertices, coefficients):
    """Return cell-integrated divergence [A] and volume integral of J [A m]."""
    v,c,edges,_ = _geometry(vertices,coefficients)
    total = np.sum(c,axis=1)
    offset = np.sum(edges,axis=1)/4
    moment = total[:,None]*offset-np.sum(c[:,1:,None]*edges,axis=1)
    return total/2,np.sum(moment,axis=0,dtype=np.longdouble)/6


def section_currents(vertices, coefficients, plane_y_m, branches):
    """Integrate Jy over the physical polygon of each Tet4 slice; no nodal J."""
    v,c,_,determinant = _geometry(vertices,coefficients)
    if not math.isfinite(plane_y_m) or not branches:
        raise ValueError("Finite plane and explicit branches required")
    for bounds in branches.values():
        if len(bounds)!=2 or not all(math.isfinite(x) for x in bounds) or bounds[0]>=bounds[1]:
            raise ValueError("Finite ordered branch bounds required")
    result = {name:{"current_a":np.longdouble(0),"area_m2":np.longdouble(0),"cells":0}
              for name in branches}
    y0 = np.longdouble(plane_y_m)
    selected = np.flatnonzero((np.min(v[:,:,1],axis=1)<=y0)&(y0<np.max(v[:,:,1],axis=1)))
    for ordinal in selected:
        points = v[ordinal]
        signed = points[:,1]-y0
        polygon = [point[[0,2]] for point,value in zip(points,signed) if value==0]
        for a,b in EDGES:
            if (signed[a]<0<signed[b]) or (signed[b]<0<signed[a]):
                point = points[a]+(-signed[a]/(signed[b]-signed[a]))*(points[b]-points[a])
                polygon.append(point[[0,2]])
        unique = []
        for point in polygon:
            if not any(np.array_equal(point,old) for old in unique):
                unique.append(point)
        if len(unique)<3:
            continue
        polygon = np.array(unique,dtype=np.longdouble)
        center = np.mean(polygon,axis=0)
        angle = np.arctan2(polygon[:,1]-center[1],polygon[:,0]-center[0])
        polygon = polygon[np.argsort(angle)]
        minimum_x,maximum_x = np.min(polygon[:,0]),np.max(polygon[:,0])
        polygon -= polygon[0]
        area = abs(np.sum(polygon[:,0]*np.roll(polygon[:,1],-1)
                           -polygon[:,1]*np.roll(polygon[:,0],-1),dtype=np.longdouble))/2
        if area==0:
            continue
        owners = []
        for name,bounds in branches.items():
            scale = max(abs(bounds[0]),abs(bounds[1]),abs(minimum_x),abs(maximum_x))
            tolerance = 64*np.finfo(float).eps*scale
            if bounds[0]-tolerance<=minimum_x and maximum_x<=bounds[1]+tolerance:
                owners.append(name)
        if len(owners)!=1:
            raise ValueError("Section polygon has no unique authored branch")
        # Jy is constant on y=y0 for this RT0 cell.
        jy = np.sum(c[ordinal]*(y0-points[:,1]),dtype=np.longdouble)/determinant[ordinal]
        row = result[owners[0]]
        row["current_a"] += jy*area
        row["area_m2"] += area
        row["cells"] += 1
    return {name:{key:float(value) if key!="cells" else value for key,value in row.items()}
            for name,row in result.items()}


def boundary_ledger(cells, faces, settings):
    """Measure original outward moments and pair geometric source-cut faces."""
    usage,vertices = {},{}
    for row in struct.iter_unpack("<5Q30d",cells):
        ids = row[1:5]
        for i,identity in enumerate(ids):
            vertices[identity] = row[5+3*i:8+3*i]
        for winding in WINDING:
            ordered = tuple(ids[i] for i in winding)
            inversions = sum(ordered[i]>ordered[j] for i in range(3) for j in range(i+1,3))
            key = tuple(sorted(ordered))
            old = usage.setdefault(key,[0,0])
            old[0] += 1
            old[1] += -1 if inversions%2 else 1
    delta = settings["coordinate_matching_tolerance_m"]
    if not math.isfinite(delta) or delta<=0:
        raise ValueError("Positive coordinate matching tolerance required")
    outside,cut_fluxes,paired = [],[],{}
    boundary_count = 0
    for a,b,c,moment in struct.iter_unpack("<3Qd",faces):
        count,sign = usage[(a,b,c)]
        if count==2 and sign==0:
            continue
        if count!=1 or abs(sign)!=1:
            raise ValueError("Nonmanifold or inconsistently oriented face")
        boundary_count += 1
        xyz = np.array([vertices[i] for i in (a,b,c)])
        flux = float(sign*moment)
        on_cut = (
            np.max(abs(xyz[:,1]-settings["source_cut_y_m"]))<=delta
            and np.min(xyz[:,0])>=settings["source_cut_x_m"][0]-delta
            and np.max(xyz[:,0])<=settings["source_cut_x_m"][1]+delta
            and np.min(xyz[:,2])>=settings["source_cut_z_m"][0]-delta
            and np.max(xyz[:,2])<=settings["source_cut_z_m"][1]+delta)
        if on_cut:
            key = tuple(sorted(tuple(int(round(value/delta)) for value in point) for point in xyz))
            paired.setdefault(key,[]).append(flux)
            cut_fluxes.append(flux)
        else:
            outside.append(abs(flux))
    differences = [abs(math.fsum(values)) for values in paired.values() if len(values)==2]
    return {"boundary_faces":boundary_count,"source_cut_faces":len(cut_fluxes),
        "source_cut_pairs":sum(len(v)==2 for v in paired.values()),
        "unpaired_source_cut_groups":sum(len(v)!=2 for v in paired.values()),
        "maximum_source_cut_pair_mismatch_a":max(differences,default=0.),
        "outside_cut_absolute_flux_a":math.fsum(outside),
        "cut_net_flux_a":math.fsum(cut_fluxes),
        "cut_positive_flux_a":math.fsum(v for v in cut_fluxes if v>0),
        "cut_negative_flux_a":math.fsum(v for v in cut_fluxes if v<0)}


def run_audit(criteria_path, output_dir):
    started = time.monotonic()
    raw = criteria_path.read_bytes()
    settings = json.loads(raw)
    repo = Path(__file__).resolve().parents[1]
    probe_path = repo/settings["probe_path"]
    if hashlib.sha256(probe_path.read_bytes()).hexdigest()!=settings["probe_sha256"]:
        raise ValueError("Pure source-reader pin differs")
    spec = importlib.util.spec_from_file_location("retained_current_source_reader",probe_path)
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    output_dir.mkdir(exist_ok=False)
    cases,rows,gate_rows = [],[],[]
    for case in settings["cases"]:
        manifest,payloads = probe.read_bundle(repo/case["bundle"],case["sha256"])
        frozen,packing = probe.pack_rt0(payloads["cells"],payloads["faces"],
                                       manifest["cell_count"],manifest["vertex_count"])
        source = np.frombuffer(frozen,dtype="<f8").reshape(-1,16)
        vertices,coefficients = source[:,:12].reshape(-1,4,3),source[:,12:]
        reference = manifest["signed_normalization_a"]
        if not math.isfinite(reference) or reference==0:
            raise ValueError("Nonzero signed normalization required")
        absolute = abs(reference)
        divergence,integral = current_moments(vertices,coefficients)
        ledger = boundary_ledger(payloads["cells"],payloads["faces"],settings)
        sections = []
        for plane in settings["planes_y_m"]:
            section = section_currents(vertices,coefficients,plane,settings["branches"])
            for name,value in section.items():
                value.update(case=case["label"],plane_y_m=plane,branch=name,
                    current_per_reference=value["current_a"]/reference,
                    expected_current_per_reference=settings["expected_relative_currents"][name],
                    relative_area_error=value["area_m2"]/settings["expected_branch_area_m2"]-1)
                sections.append(value)
            gate_rows.append(abs(math.fsum(v["current_a"] for v in section.values()))/absolute)
        norm_integral = float(np.sqrt(np.sum(integral**2,dtype=np.longdouble))/
                              (absolute*settings["integrated_current_length_m"]))
        metrics = {
            "maximum_cell_divergence_current_relative":float(np.max(abs(divergence))/absolute),
            "sum_absolute_cell_divergence_current_relative":float(np.sum(abs(divergence),dtype=np.longdouble)/absolute),
            "integrated_current_am":list(map(float,integral)),
            "normalized_integrated_current":norm_integral,
            "relative_cut_positive_error":abs(ledger["cut_positive_flux_a"]/absolute-1),
            "relative_cut_negative_error":abs(ledger["cut_negative_flux_a"]/absolute+1),
            "outside_boundary_absolute_flux_relative":ledger["outside_cut_absolute_flux_a"]/absolute,
            "maximum_source_cut_pair_mismatch_relative":ledger["maximum_source_cut_pair_mismatch_a"]/absolute,
            "maximum_branch_reference_error":max(abs(x["current_per_reference"]-x["expected_current_per_reference"]) for x in sections),
            "maximum_relative_area_error":max(abs(x["relative_area_error"]) for x in sections)}
        tolerance = settings["relative_flux_tolerance"]
        gates = {
            "cell_conservation":metrics["maximum_cell_divergence_current_relative"]<=tolerance,
            "external_boundary":metrics["outside_boundary_absolute_flux_relative"]<=tolerance,
            "cut_pairs":ledger["source_cut_pairs"]>0 and ledger["unpaired_source_cut_groups"]==0
                and metrics["maximum_source_cut_pair_mismatch_relative"]<=tolerance,
            "cut_current":max(metrics["relative_cut_positive_error"],metrics["relative_cut_negative_error"])<=tolerance,
            "compact_current_moment":norm_integral<=settings["relative_integrated_current_tolerance"],
            "branch_geometry":metrics["maximum_relative_area_error"]<=settings["relative_area_tolerance"],
            "branch_direction_and_split":metrics["maximum_branch_reference_error"]<=settings["relative_ideal_split_tolerance"],
            "section_conservation":max(gate_rows[-len(settings["planes_y_m"]):])<=tolerance}
        cases.append({"label":case["label"],"bundle_sha256":case["sha256"],"packing":packing,
            "signed_reference_current_a":reference,"metrics":metrics,"boundary":ledger,"gates":gates,
            "original_status":manifest["status"]})
        rows.extend(sections)
        np.savez_compressed(output_dir/(case["label"]+"-cell-residuals.npz"),
                            integrated_divergence_a=np.asarray(divergence,dtype=float))
        print(json.dumps({"case":case["label"],"metrics":metrics,"gates":gates}),flush=True)
    with (output_dir/"section-currents.csv").open("x",newline="") as stream:
        writer=csv.DictWriter(stream,fieldnames=list(rows[0]));writer.writeheader();writer.writerows(rows)
    result={"verdict":"RETAINED_CURRENT_AUDIT_PASS" if all(all(c["gates"].values()) for c in cases) else "RETAINED_CURRENT_AUDIT_FAIL",
        "cases":cases,"criteria_sha256":hashlib.sha256(raw).hexdigest(),
        "driver_sha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "elapsed_seconds_before_render":time.monotonic()-started,"new_solve":False,
        "native_field_spectrum":"NOT VERIFIED","source_status_changed":False}
    (output_dir/"results.json").write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False)+"\n")
    render_audit(output_dir,rows)
    pins={p.name:{"bytes":p.stat().st_size,"sha256":hashlib.sha256(p.read_bytes()).hexdigest()}
          for p in output_dir.iterdir() if p.is_file()}
    (output_dir/"artifact-manifest.json").write_text(json.dumps(pins,indent=2)+"\n")
    return result


def render_audit(output_dir, rows):
    os.environ["MPLCONFIGDIR"]=str(output_dir/"matplotlib-cache")
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig,axes=plt.subplots(1,2,figsize=(12,5),layout="constrained")
    colors={"signal":"#1565c0","ground_left":"#b45f06","ground_right":"#00796b"}
    for label,style in [("corner25","o-"),("corner12p5","s--")]:
        for branch in colors:
            values=[r for r in rows if r["case"]==label and r["branch"]==branch]
            y=[r["plane_y_m"]*1e6 for r in values]
            axes[0].plot(y,[r["current_per_reference"] for r in values],style,
                color=colors[branch],label=label+": "+branch,alpha=.8)
            axes[1].plot(y,[r["current_per_reference"]-r["expected_current_per_reference"] for r in values],
                style,color=colors[branch],alpha=.8)
    for reference in (-.5,1.):
        axes[0].axhline(reference,color="black",lw=.8,ls=":",alpha=.5)
    axes[1].axhline(0,color="black",lw=.8)
    axes[0].set(title="Prądy względem podpisanego Iref",ylabel="I / Iref [1]",xlabel="y przekroju [µm]")
    axes[1].set(title="Różnica względem +1, −1/2, −1/2",ylabel="Różnica I / Iref [1]",xlabel="y przekroju [µm]")
    axes[0].legend(fontsize=8)
    for ax in axes:
        ax.grid(alpha=.2)
    fig.suptitle("GSG: niezależne całki przekrojowe zachowanego RT0\n"
                 "Bez nowego Solve i bez kwalifikacji native H/spectrum",fontweight="bold")
    fig.savefig(output_dir/"current-path-and-residual.png",dpi=170)
    fig.savefig(output_dir/"current-path-and-residual.svg")
    plt.close(fig)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--criteria",type=Path,required=True)
    parser.add_argument("--output-dir",type=Path,required=True)
    args=parser.parse_args()
    if hasattr(os,"sched_getaffinity"):
        os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
    result=run_audit(args.criteria,args.output_dir)
    print(result["verdict"])
    return 0 if result["verdict"]=="RETAINED_CURRENT_AUDIT_PASS" else 2


if __name__=="__main__":
    raise SystemExit(main())
