"""Reproduce published Fig1 analytically; this never runs Fullmag."""
from __future__ import annotations
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import math
import numpy as np
from PIL import Image
from scipy.ndimage import label, find_objects
from reference_sushruth_2020_antenna_spectrum import antenna_spectra

NAMES=("S","GS","GSG")
COLORS={"S":"#1538e8","GS":"#e32926","GSG":"#202124"}

def require(ok,message):
    if not ok:raise ValueError(message)

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def model_grid(intervals):
    k=np.linspace(0.,30e6,intervals+1)
    amplitude={name:np.array([antenna_spectra(float(v))[name] for v in k]) for name in NAMES}
    power={name:np.abs(amplitude[name])**2*(4 if name=="S" else 1) for name in NAMES}
    return dict(k_rad_per_m=k,k_rad_per_um=k/1e6,amplitude=amplitude,power=power)

def integrate_strips(k,intervals):
    # Direct midpoint integration of rectangular currents, without sinc/array factors.
    width=gap=200e-9
    x=width*((np.arange(intervals)+.5)/intervals-.5)
    k=np.asarray(k)
    rectangles={"S":[(0.,1.)],"GS":[((width+gap)/2,1.),(-(width+gap)/2,-1.)],
                "GSG":[(0.,1.),(width+gap,-.5),(-(width+gap),-.5)]}
    return {name:sum(current*np.exp(1j*k[:,None]*(center+x)).mean(axis=1)
                     for center,current in strips) for name,strips in rectangles.items()}

def quadrature_convergence(intervals):
    grid=model_grid(1200)
    rows=[]
    for n in intervals:
        estimate=integrate_strips(grid["k_rad_per_m"],n)
        errors={name:float(np.max(np.abs(estimate[name]-grid["amplitude"][name]))) for name in NAMES}
        error=max(errors.values())
        rows.append(dict(intervals=n,maximum_complex_amplitude_error=error,per_antenna=errors,
                         previous_error_ratio=None if not rows else rows[-1]["maximum_complex_amplitude_error"]/error))
    return rows

def sampling_convergence(intervals):
    rows=[]
    for n in intervals:
        grid=model_grid(n)
        peaks={}
        for name in NAMES:
            index=int(np.argmax(grid["power"][name]))
            peaks[name]=dict(k_rad_per_um=float(grid["k_rad_per_um"][index]),
                             display_power=float(grid["power"][name][index]))
        rows.append(dict(intervals=n,step_rad_per_um=30/n,peaks=peaks))
    return rows

def load_source(page_png,criteria_path):
    raw=page_png.read_bytes()
    criteria=json.loads(criteria_path.read_text())
    require(sha(raw)==criteria["page_png_sha256"],"Source PNG SHA differs")
    image=np.asarray(Image.open(page_png).convert("RGB"))
    return image,criteria

def extract_curves(image,frame):
    require(image.ndim==3 and image.shape[2]==3,"RGB source image required")
    height,width=image.shape[:2]
    x0,x1,y0,y1=(frame[k] for k in ("left","right","top","bottom"))
    require(0<=x0<x1<width and 0<=y0<y1<height,"Calibration is outside source image")
    r,g,b=(image[:,:,i].astype(int) for i in range(3))
    masks={"S":(b>150)&(r<120)&(g<140),
           "GS":(r>150)&(g<120)&(b<120),
           "GSG":(r<90)&(g<90)&(b<90)}
    window=np.zeros((height,width),bool)
    window[math.ceil(y0)+3:math.floor(y1)-2,math.ceil(x0)+3:math.floor(x1)-2]=True
    result={}
    for name,mask in masks.items():
        numbered,_=label(mask&window,structure=np.ones((3,3),int))
        kept=np.zeros_like(window)
        for number,box in enumerate(find_objects(numbered),1):
            if box is None:continue
            sy,sx=box
            if sx.stop-sx.start >= .06*(x1-x0) and sy.stop-sy.start >= .035*(y1-y0):
                kept[sy,sx]|=numbered[sy,sx]==number
        points=[]
        for x in np.flatnonzero(kept.any(axis=0)):
            ys=np.flatnonzero(kept[:,x])
            span=int(ys[-1]-ys[0])
            if span<=7:points.append((float(x),float(np.median(ys)),span))
        require(points,"No scientific curve components for "+name)
        xs,ys,spans=map(np.array,zip(*points))
        result[name]=dict(x_pixel=xs,y_pixel=ys,vertical_span_pixel=spans,
                          k_rad_per_um=(xs-x0)/(x1-x0)*30,
                          display_power=(y1-ys)/(y1-y0)*4)
    return result

def compare_curves(curves,criteria):
    frame=criteria["axis_pixels"];gates=criteria["pixel_comparison"]
    rows=[];metrics={}
    for name in NAMES:
        curve=curves[name]
        k=curve["k_rad_per_um"]*1e6
        expected=np.array([abs(antenna_spectra(float(v))[name])**2*(4 if name=="S" else 1) for v in k])
        delta=expected-curve["display_power"]
        pixels=delta*(frame["bottom"]-frame["top"])/4
        absolute=np.abs(pixels)
        metrics[name]=dict(columns=len(k),k_range_rad_per_um=[float(k.min()/1e6),float(k.max()/1e6)],
          rms_difference_display_power=float(np.sqrt(np.mean(delta**2))),
          relative_l2_difference=float(np.linalg.norm(delta)/np.linalg.norm(curve["display_power"])),
          p95_absolute_residual_pixels=float(np.quantile(absolute,.95)),
          maximum_absolute_residual_pixels=float(absolute.max()),
          within_raster_gate=bool(len(k)>=gates["minimum_columns_per_curve"] and
              np.quantile(absolute,.95)<=gates["p95_absolute_residual_pixels_max"] and
              absolute.max()<=gates["maximum_absolute_residual_pixels_max"]))
        for i in range(len(k)):
            rows.append(dict(antenna=name,x_pixel=float(curve["x_pixel"][i]),y_pixel=float(curve["y_pixel"][i]),
                vertical_span_pixel=float(curve["vertical_span_pixel"][i]),k_rad_per_m=float(k[i]),
                digitized_display_power=float(curve["display_power"][i]),model_display_power=float(expected[i]),
                model_minus_digitized_display_power=float(delta[i]),model_minus_digitized_pixels=float(pixels[i])))
    return rows,metrics

def write_csv(path,rows):
    with path.open("x",newline="") as f:
        writer=csv.DictWriter(f,fieldnames=list(rows[0]));writer.writeheader();writer.writerows(rows)

def render_comparison(image,grid,curves,rows,output):
    os.environ.setdefault("MPLCONFIGDIR",str(output/"matplotlib-config"))
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.family":"DejaVu Sans","font.size":10,"axes.spines.top":False,
                         "axes.spines.right":False,"axes.labelsize":11})
    fig=plt.figure(figsize=(13.5,8.4),layout="constrained")
    gs=fig.add_gridspec(2,2,height_ratios=[2.2,1.])
    original=fig.add_subplot(gs[0,0])
    original.imshow(image[170:690,130:835]);original.axis("off")
    original.set_title("Oryginał — Sushruth et al., rys. 1",loc="left",fontweight="bold")
    ax=fig.add_subplot(gs[0,1])
    for name in NAMES:
        ax.plot(grid["k_rad_per_um"],grid["power"][name],color=COLORS[name],lw=1.8,label=name)
        c=curves[name];take=slice(None,None,12)
        ax.scatter(c["k_rad_per_um"][take],c["display_power"][take],s=13,facecolors="none",
                   edgecolors=COLORS[name],linewidths=.7,zorder=4)
    ax.set(xlim=(0,30),ylim=(-.04,4.1),xlabel=r"$k$ (rad/µm)",ylabel=r"Znormalizowane $|h_x(k)|^2$")
    ax.set_title("Model: linie · odczyt publikacji: punkty",loc="left",fontweight="bold")
    ax.grid(alpha=.16);ax.legend(frameon=False,ncol=3)
    ax.text(.98,.80,"L = g = 200 nm\ns = 0\nS: moc ×4",transform=ax.transAxes,ha="right",va="top",fontsize=10)
    difference=fig.add_subplot(gs[1,:])
    for name in NAMES:
        points=[r for r in rows if r["antenna"]==name]
        ks=np.array([r["k_rad_per_m"]/1e6 for r in points])
        delta=np.array([r["model_minus_digitized_pixels"] for r in points])
        gaps=np.flatnonzero(np.diff(ks)>1.5*np.min(np.diff(ks)))+1
        # Missing raster columns remain gaps; never draw invented residual segments.
        difference.plot(np.insert(ks,gaps,np.nan),np.insert(delta,gaps,np.nan),
                        color=COLORS[name],lw=.9,label=name)
    difference.axhspan(-3,3,color="#d9e6dc",alpha=.4,label="Próg p95: ±3 px")
    difference.axhline(0,color="#6b7280",lw=.6)
    difference.set(xlim=(0,30),xlabel=r"$k$ (rad/µm)",ylabel="Model − digitizacja (px)")
    difference.grid(alpha=.15);difference.legend(frameon=False,ncol=4,loc="upper right")
    fig.suptitle("Analityczne odtworzenie rysunku 1 — Fullmag: NIEZWERYFIKOWANY",
                 fontsize=14,fontweight="bold")
    fig.savefig(output/"figure1-comparison.png",dpi=180)
    fig.savefig(output/"figure1-comparison.svg")
    plt.close(fig)

def reproduce(page_png,criteria_path,output):
    image,criteria=load_source(page_png,criteria_path)
    require(criteria["parameters_si"]==dict(width_m=200e-9,gap_m=200e-9,spacing_m=0.),
            "Published Figure1 parameters differ")
    output.mkdir(parents=True,exist_ok=False)
    grid=model_grid(1200)
    curves=extract_curves(image,criteria["axis_pixels"])
    rows,metrics=compare_curves(curves,criteria)
    quad=quadrature_convergence(criteria["independent_quadrature"]["midpoints_per_strip"])
    sampling=sampling_convergence(criteria["sampling"]["intervals"])
    q=criteria["independent_quadrature"]
    quad_pass=quad[-1]["maximum_complex_amplitude_error"]<=q["maximum_complex_amplitude_error"] and \
        q["last_error_reduction_ratio_min"]<=quad[-1]["previous_error_ratio"]<=q["last_error_reduction_ratio_max"]
    s=criteria["sampling"]
    sampling_pass=all(abs(sampling[-1]["peaks"][name]["k_rad_per_um"]-sampling[-2]["peaks"][name]["k_rad_per_um"])<=s["peak_position_change_rad_per_um_max"] and
                      abs(sampling[-1]["peaks"][name]["display_power"]-sampling[-2]["peaks"][name]["display_power"])<=s["peak_power_change_max"] for name in NAMES)
    model=[]
    for i,k in enumerate(grid["k_rad_per_m"]):
        row=dict(k_rad_per_m=float(k),k_rad_per_um=float(k/1e6))
        for name in NAMES:
            row.update({name+"_real":float(grid["amplitude"][name][i].real),
                        name+"_imag":float(grid["amplitude"][name][i].imag),
                        name+"_display_power":float(grid["power"][name][i])})
        model.append(row)
    write_csv(output/"analytic-model.csv",model)
    write_csv(output/"digitization-and-residuals.csv",rows)
    passed=bool(quad_pass and sampling_pass and all(v["within_raster_gate"] for v in metrics.values()))
    report=dict(schema="fullmag.sushruth-figure1-reproduction.v1",
      source_doi=criteria["source_doi"],parameters_si=criteria["parameters_si"],
      analytic_figure1_verdict="CONFIRMED_WITHIN_REGISTERED_RASTER_GATE" if passed else "NOT CONFIRMED",
      fullmag_field_spectrum_verdict="NOT VERIFIED",fullmag_solver_executed=False,parameter_fit_performed=False,
      criteria_sha256=sha(criteria_path.read_bytes()),page_png_sha256=sha(page_png.read_bytes()),
      driver_sha256=sha(Path(__file__).read_bytes()),
      reference_sha256=sha(Path(__file__).with_name("reference_sushruth_2020_antenna_spectrum.py").read_bytes()),
      raster_metrics=metrics,independent_quadrature=quad,independent_quadrature_pass=bool(quad_pass),
      sampling_convergence=sampling,sampling_pass=bool(sampling_pass),
      units={"k":"rad/m","display_power":"1","amplitude":"1","pixel_residual":"px"},
      model_assumptions="infinitely thin/long uniform-current strips; no shielding; hS(0)=1",
      raster_limitation="Digitized raster points are not authors' original numerical data.",
      source_attribution="M. Sushruth et al., Phys. Rev. Research 2,043203(2020), Fig1, CC BY4.0")
    (output/"results.json").write_text(json.dumps(report,ensure_ascii=False,allow_nan=False,indent=2)+"\n")
    render_comparison(image,grid,curves,rows,output)
    artifacts={p.name:dict(byte_length=p.stat().st_size,sha256=sha(p.read_bytes()))
               for p in output.iterdir() if p.is_file()}
    (output/"artifact-manifest.json").write_text(json.dumps(artifacts,indent=2)+"\n")
    return report

if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--page-png",type=Path,required=True)
    parser.add_argument("--criteria",type=Path,required=True)
    parser.add_argument("--output-dir",type=Path,required=True)
    args=parser.parse_args()
    result=reproduce(args.page_png,args.criteria,args.output_dir)
    print(json.dumps({k:result[k] for k in ("analytic_figure1_verdict","fullmag_field_spectrum_verdict","raster_metrics",
                                            "independent_quadrature_pass","sampling_pass")},ensure_ascii=False))
    raise SystemExit(0 if result["analytic_figure1_verdict"].startswith("CONFIRMED") else 2)
