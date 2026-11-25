"""Reference-only audit of spatial field sampling and Fourier conventions.

No Fullmag solve, native library, field qualification, FFT padding or fitted
normalization. Straight infinite-y uniform-current strips only.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
from pathlib import Path

import numpy as np

from antenna_metal_thickness_diagnostic import metal_thickness_factor
from reference_sushruth_2020_antenna_spectrum import antenna_spectra

NAMES = ("S", "GS", "GSG")


def strip_field_per_ampere(x_m, *, width_m, spacing_m, thickness_m, layer_order=16):
    """Hx/I below a +Y strip; Biot-Savart integrated over infinite y and width."""
    x = np.asarray(x_m, dtype=float)
    if (x.ndim != 1 or not np.all(np.isfinite(x))
            or not all(math.isfinite(v) for v in (width_m, spacing_m, thickness_m))
            or width_m <= 0 or spacing_m < 0 or thickness_m < 0):
        raise ValueError("Finite positions, positive width and nonnegative heights required")
    if thickness_m == 0 and spacing_m == 0:
        relative = np.abs(x) / (width_m/2)
        return -np.where(relative < 1, 1., np.where(relative == 1, .5, 0.))/(2*width_m)
    if thickness_m:
        if type(layer_order) is not int or layer_order < 2:
            raise ValueError("Layer quadrature order must be at least two")
        roots, weights = np.polynomial.legendre.leggauss(layer_order)
        heights = spacing_m + thickness_m*(1+roots)/2
        weights = weights/2
    else:
        heights, weights = np.array([spacing_m]), np.array([1.])
    angle = (np.arctan2(x[:, None]+width_m/2, heights)
             - np.arctan2(x[:, None]-width_m/2, heights))
    return -(angle @ weights)/(2*math.pi*width_m)


def antenna_fields(x_m, *, width_m, gap_m, spacing_m, thickness_m, layer_order=16):
    """Fixed signed currents; no normalization from the observed field."""
    if not math.isfinite(gap_m) or gap_m < 0:
        raise ValueError("Gap must be finite and nonnegative")
    pitch = width_m+gap_m
    branches = {"S": ((0., 1.),), "GS": ((-pitch/2, -1.), (pitch/2, 1.)),
                "GSG": ((-pitch, -.5), (0., 1.), (pitch, -.5))}
    result = {}
    for name, sources in branches.items():
        result[name] = sum(weight*strip_field_per_ampere(np.asarray(x_m)-center,
            width_m=width_m, spacing_m=spacing_m, thickness_m=thickness_m,
            layer_order=layer_order) for center, weight in sources)
    return result


def fourier_minus(x_m, field_per_ampere):
    """Integral-SI rectangular DFT, exp(-ikx), with the physical x origin."""
    x, h = np.asarray(x_m, dtype=float), np.asarray(field_per_ampere, dtype=float)
    if (x.ndim != 1 or h.shape != x.shape or x.size < 4
            or not np.all(np.isfinite(x)) or not np.all(np.isfinite(h))):
        raise ValueError("At least four finite x,H/I pairs are required")
    steps = np.diff(x)
    step = float((x[-1]-x[0])/(x.size-1))
    if step <= 0 or not np.allclose(steps, step, rtol=1e-9, atol=0):
        raise ValueError("Uniform, strictly increasing physical positions required")
    k = 2*math.pi*np.fft.fftfreq(x.size, d=step)
    transformed = step*np.fft.fft(h)*np.exp(-1j*k*x[0])
    return np.fft.fftshift(k), np.fft.fftshift(transformed)


def reference_plus(k, width_m, case):
    """Existing Eq6-8 and independently tested finite-thickness factor."""
    values = [antenna_spectra(float(value), width_m=width_m,
              gap_m=case["gap_m"], spacing_m=case["spacing_m"]) for value in k]
    factor = np.array([metal_thickness_factor(float(value), case["thickness_m"])
                       for value in k])
    return {name: np.array([row[name] for row in values])*factor for name in NAMES}


def write_csv(path, header, rows):
    with path.open("x", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(header)
        writer.writerows(rows)


def run_sampling(criteria_path, output_dir):
    criteria_raw = criteria_path.read_bytes()
    settings = json.loads(criteria_raw)
    output_dir.mkdir(exist_ok=False)
    records, cached = [], {}
    width, maximum_k = settings["width_m"], settings["maximum_k_rad_per_m"]
    largest, finest = max(settings["half_width_m"]), min(settings["step_m"])
    layer_checks = []
    for case in settings["cases"]:
        field_args = dict(width_m=width, **{key: case[key] for key in
                          ("gap_m", "spacing_m", "thickness_m")})
        probe_x = np.linspace(-2e-6, 2e-6, 1201)
        lower = antenna_fields(probe_x, **field_args, layer_order=settings["layer_gauss_order"])
        higher = antenna_fields(probe_x, **field_args, layer_order=2*settings["layer_gauss_order"])
        layer_checks.append({"case": case["id"], "relative_max_field_difference":
            max(float(np.max(np.abs(lower[name]-higher[name]))/np.max(np.abs(higher[name])))
                for name in NAMES)})
        for half_width in settings["half_width_m"]:
            for step in settings["step_m"]:
                count = round(2*half_width/step)
                if not math.isclose(count*step, 2*half_width, rel_tol=1e-12):
                    raise ValueError("Window must contain an integer number of sample cells")
                x = (np.arange(count)-(count-1)/2)*step
                fields = antenna_fields(x, **field_args, layer_order=settings["layer_gauss_order"])
                spectra = {}
                for name in NAMES:
                    k, raw = fourier_minus(x, fields[name])
                    # The real profile guarantees F_plus(k)=conj(F_minus(k)).
                    spectra[name] = (-2*raw).conjugate()
                selected = (k >= 0) & (k <= maximum_k)
                k = k[selected]
                spectra = {name: spectra[name][selected] for name in NAMES}
                expected = reference_plus(k, width, case)
                key = (case["id"], half_width, step)
                cached[key] = (k, spectra, expected)
                for name in NAMES:
                    power_scale = 4 if name == "S" else 1
                    records.append({"case": case["id"], "antenna": name,
                        "half_width_m": half_width, "step_m": step, "profile_count": count,
                        "positive_k_bins_including_zero": int(k.size),
                        "delta_k_rad_per_m": float(k[1]-k[0]),
                        "max_complex_amplitude_error": float(np.max(np.abs(spectra[name]-expected[name]))),
                        "relative_l2_complex_error": float(np.linalg.norm(spectra[name]-expected[name])/np.linalg.norm(expected[name])),
                        "max_display_power_error": float(np.max(power_scale*np.abs(np.abs(spectra[name])**2-np.abs(expected[name])**2)))})
                if half_width == largest and step == finest:
                    write_csv(output_dir/("profile-"+case["id"]+".csv"),
                        ["x_m"]+["Hx_over_I_"+name+"_per_m" for name in NAMES],
                        zip(x, *(fields[name] for name in NAMES)))
                    header = ["k_rad_per_m"]
                    columns = [k]
                    for name in NAMES:
                        header += [name+"_fft_plus_re",name+"_fft_plus_im",name+"_reference_plus_re",
                                   name+"_reference_plus_im",name+"_fft_minus_re",name+"_fft_minus_im"]
                        a, b = spectra[name], expected[name]
                        columns += [a.real, a.imag, b.real, b.imag, a.real, -a.imag]
                    write_csv(output_dir/("spectrum-"+case["id"]+".csv"), header, zip(*columns))
    gates = settings["criteria"]
    last = [row for row in records if row["half_width_m"] == largest and row["step_m"] == finest]
    increments = []
    previous_step = sorted(settings["step_m"])[1]
    previous_width = sorted(settings["half_width_m"])[-2]
    for case in settings["cases"]:
        k, fine, _ = cached[(case["id"], largest, finest)]
        sampling_k, sampled, _ = cached[(case["id"], largest, previous_step)]
        window_k, windowed, _ = cached[(case["id"], previous_width, finest)]
        if not (np.allclose(k, sampling_k, rtol=1e-12, atol=1e-6)
                and np.allclose(k[::2], window_k, rtol=1e-12, atol=1e-6)):
            raise ValueError("Convergence grids do not share physical Fourier bins")
        for name in NAMES:
            increments.append({"case": case["id"], "antenna": name,
                "last_sampling_increment_max": float(np.max(np.abs(fine[name]-sampled[name]))),
                "last_window_increment_max": float(np.max(np.abs(fine[name][::2]-windowed[name])))})
    passed = (all(row["max_complex_amplitude_error"] <= gates["finest_max_complex_amplitude_error"]
                  and row["max_display_power_error"] <= gates["finest_max_display_power_error"] for row in last)
              and all(row["last_sampling_increment_max"] <= gates["last_sampling_increment_max"]
                      and row["last_window_increment_max"] <= gates["last_window_increment_max"] for row in increments)
              and all(row["relative_max_field_difference"] <= gates["finite_layer_order_16_32_max_field_relative"]
                      for row in layer_checks))
    result = {"settings": settings, "criteria_sha256": hashlib.sha256(criteria_raw).hexdigest(),
        "driver_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "verdict": "REFERENCE_SAMPLING_PASS" if passed else "REFERENCE_SAMPLING_FAIL",
        "fullmag_field_spectrum": "NOT VERIFIED", "fullmag_solver_executed": False,
        "parameter_fit_performed": False, "records": records, "finest_records": last,
        "last_increments": increments, "layer_quadrature_checks": layer_checks}
    (output_dir/"results.json").write_text(json.dumps(result, ensure_ascii=False, indent=2)+"\n")
    render_sampling(output_dir, result, cached)
    manifest = {p.name: {"bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                for p in output_dir.iterdir() if p.is_file()}
    (output_dir/"artifact-manifest.json").write_text(json.dumps(manifest, indent=2)+"\n")
    return result


def render_sampling(output_dir, result, cached):
    os.environ["MPLCONFIGDIR"] = str(output_dir/"matplotlib-config")
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    settings = result["settings"]
    largest, finest = max(settings["half_width_m"]), min(settings["step_m"])
    fig, axes = plt.subplots(2, 2, figsize=(14, 9), layout="constrained")
    colors = {"S": "#2453ca", "GS": "#d12d35", "GSG": "#23252c"}
    k, actual, expected = cached[("figure1_ideal", largest, finest)]
    for name in NAMES:
        scale = 4 if name == "S" else 1
        axes[0, 0].plot(k/1e6, scale*np.abs(expected[name])**2, color=colors[name], label=name+" — Eq6–8")
        axes[0, 0].plot(k[::16]/1e6, scale*np.abs(actual[name][::16])**2, "o",
                       ms=3, fillstyle="none", color=colors[name])
    axes[0, 0].set(title="Fig1: wzór (linie), FFT pola (punkty)",
                   xlabel="k (rad/µm)", ylabel="Kwadrat modułu; S ×4", xlim=(0, 30))
    axes[0, 0].legend(fontsize=8)
    axes[0, 1].plot(k/1e6, expected["GS"].imag, color="#2453ca", label="Eq7: Im A₊")
    axes[0, 1].plot(k/1e6, -actual["GS"].imag, "--", color="#d12d35", label="FFT: Im A₋")
    axes[0, 1].plot(k[::16]/1e6, actual["GS"][::16].imag, "o", ms=3, fillstyle="none",
                   color="#277d45", label="Po jawnym k → −k")
    axes[0, 1].set(title="GS: konwencja zmienia Im, moc pozostaje taka sama",
                   xlabel="k (rad/µm)", ylabel="Im amplitudy (1)", xlim=(0, 30))
    axes[0, 1].legend(fontsize=8)
    for case, label in [("figure1_ideal", "Fig1: cienkie, s=0"),
                        ("finite_height_thickness", "g200, s43,7, t90 nm"),
                        ("nominal_gsg_cross_section", "g250, s43,7, t90 nm")]:
        rows = [row for row in result["records"] if row["case"] == case and row["half_width_m"] == largest]
        steps = sorted(set(row["step_m"] for row in rows))
        values = [max(row["max_complex_amplitude_error"] for row in rows if row["step_m"] == h) for h in steps]
        axes[1, 0].loglog(np.array(steps)*1e9, values, "o-", label=label)
    axes[1, 0].axhline(settings["criteria"]["finest_max_complex_amplitude_error"], color="#777777", ls=":")
    axes[1, 0].set(title="Zagęszczenie x przy stałym oknie ±64 µm",
                   xlabel="Odstęp próbek (nm)", ylabel="Max błąd amplitudy (1)")
    axes[1, 0].legend(fontsize=8)
    for name in NAMES:
        rows = sorted((row for row in result["records"] if row["case"] == "nominal_gsg_cross_section"
                       and row["step_m"] == finest and row["antenna"] == name), key=lambda row: row["half_width_m"])
        axes[1, 1].loglog([row["half_width_m"]*1e6 for row in rows],
                         [row["max_complex_amplitude_error"] for row in rows], "o-", color=colors[name], label=name)
    axes[1, 1].axhline(settings["criteria"]["finest_max_complex_amplitude_error"], color="#777777", ls=":")
    axes[1, 1].set(title="Rozmiar okna przy stałym Δx=6,25 nm",
                   xlabel="Połowa szerokości okna (µm)", ylabel="Max błąd amplitudy (1)")
    axes[1, 1].legend(fontsize=8)
    for axis in axes.flat:
        axis.grid(alpha=.2)
    fig.suptitle("Kontrola pola i FFT — niezależna referencja, Fullmag: NIEZWERYFIKOWANY", fontsize=15, fontweight="bold")
    fig.savefig(output_dir/"sampling-and-phase.png", dpi=170)
    fig.savefig(output_dir/"sampling-and-phase.svg")
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--criteria", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    result = run_sampling(args.criteria, args.output_dir)
    print(json.dumps({"verdict": result["verdict"], "fullmag": result["fullmag_field_spectrum"],
                      "cases": len(result["settings"]["cases"]), "profiles": len(result["records"])}, ensure_ascii=False))
    return 0 if result["verdict"] == "REFERENCE_SAMPLING_PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
