"""Measure the registered finite-k control from retained continuous Zarr fields.

This is offline analysis, not a solver or an authentication of run provenance.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np

MU0 = 4e-7 * math.pi
MS = .89 / MU0
GAMMA_B = math.tau * 30e9
ALPHA = .01


def _linear_modes(a, b):
    radicand = a*b - ALPHA**2*(a-b)**2/4
    if a <= 0 or b <= 0 or radicand <= 0:
        raise ValueError("the registered underdamped perpendicular state is not stable")
    scale = GAMMA_B / (1+ALPHA**2)
    return scale*math.sqrt(radicand)/math.tau, scale*ALPHA*(a+b)/2


def analyze_trajectory(times, magnetization, demag):
    t, m, h = np.asarray(times), np.asarray(magnetization), np.asarray(demag)
    if m.shape != (len(t), 128, 3) or h.shape != m.shape:
        raise ValueError("expected aligned full fields with 128 cells and xyz components")
    if len(t) < 32 or not all(np.isfinite(x).all() for x in (t, m, h)) or np.any(np.diff(t) <= 0):
        raise ValueError("trajectory is incomplete, nonfinite or has unordered sample times")
    x = (np.arange(128)+.5-64)/128
    cosine, sine = np.cos(math.tau*x), np.sin(math.tau*x)
    project = lambda values, basis: 2*np.einsum("tni,n->ti", values, basis)/128
    modal = project(m, cosine)
    field = project(h, cosine)
    field_sine = project(h, sine)
    radius = np.linalg.norm(modal[:, :2], axis=1)
    if np.min(radius) <= 0:
        raise ValueError("no resolved transverse fundamental mode")
    reconstructed_m = cosine[None, :, None]*modal[:, None, :2]
    transverse_residual = m[:, :, :2]-reconstructed_m
    purity = float(np.max(np.sqrt(2*np.sum(transverse_residual**2, axis=(1, 2))/128)/radius))
    ax, ay = modal[:, 0], modal[:, 1]
    indices = np.flatnonzero((ay[:-1] < 0) & (ay[1:] >= 0) & (t[:-1] >= .25e-9))
    if len(indices) < 8:
        raise ValueError("not enough same-direction crossings after the initial window")
    fraction = -ay[indices]/(ay[indices+1]-ay[indices])
    zeros = t[indices]+fraction*(t[indices+1]-t[indices])
    ax_zeros = ax[indices]+fraction*(ax[indices+1]-ax[indices])
    period = float(np.polyfit(np.arange(len(zeros)), zeros-zeros[0], 1)[0])
    frequency = 1/period
    decay = -float(np.polyfit(zeros-zeros[0], np.log(np.abs(ax_zeros)), 1)[0])
    nxx = -float(np.dot(ax, field[:, 0])/(MS*np.dot(ax, ax)))
    nyy = -float(np.dot(ay, field[:, 1])/(MS*np.dot(ay, ay)))
    nzz = -float(np.mean(h[0, :, 2])/(MS*np.mean(m[0, :, 2])))
    effective = 1.14-.89*nzz
    a, b = effective+.89*nxx, effective+.89*nyy
    expected, expected_decay = _linear_modes(a, b)
    scale = GAMMA_B/(1+ALPHA**2)
    initial = modal[0, :2]
    initial_rate = scale*np.array([-ALPHA*a*initial[0]-b*initial[1],
                                  a*initial[0]-ALPHA*b*initial[1]])
    elapsed = (t-t[0])[:, None]
    omega = math.tau*expected
    reference = np.exp(-expected_decay*elapsed)*(
        np.cos(omega*elapsed)*initial
        + np.sin(omega*elapsed)/omega*(initial_rate+expected_decay*initial))
    trajectory_error = float(np.max(np.linalg.norm(modal[:, :2]-reference, axis=1)
                                    / np.linalg.norm(reference, axis=1)))
    kt = math.tau/1.28e-6*20e-9
    uniform_n = 1+math.expm1(-kt)/kt
    nominal, nominal_decay = _linear_modes(.25+.89*uniform_n, .25)
    residual = h[:, :, :2]+MS*reconstructed_m*np.array([nxx, nyy])
    residual_n = float(np.linalg.norm(residual)/(MS*math.sqrt(128/2)*np.linalg.norm(modal[:, :2])))
    sine_n = float(np.max(np.linalg.norm(field_sine[:, :2], axis=1)/(MS*radius)))
    norm_error = float(np.max(np.abs(np.linalg.norm(m, axis=2)-1)))
    frequency_error = abs(frequency/expected-1)
    decay_error = abs(decay/expected_decay-1)
    applicable = max(residual_n, sine_n) <= 1e-4
    result = {
        "samples": len(t), "time_range_s": [float(t[0]), float(t[-1])],
        "maximum_sample_gap_s": float(np.max(np.diff(t))), "same_direction_crossings": len(zeros),
        "frequency_hz": frequency, "decay_per_s": decay,
        "measured_operator_frequency_hz": expected, "measured_operator_decay_per_s": expected_decay,
        "frequency_relative_error": frequency_error, "decay_relative_error": decay_error,
        "nominal_infinite_film_frequency_hz": nominal, "nominal_infinite_film_decay_per_s": nominal_decay,
        "nominal_frequency_relative_difference": frequency/nominal-1,
        "demag": {"Nxx": nxx, "Nyy": nyy, "Nzz_static": nzz, "uniform_thickness_Nxx": uniform_n,
                  "effective_static_field_T": effective, "diagonal_residual_N": residual_n,
                  "sine_residual_N": sine_n},
        "maximum_undesired_transverse_mode_ratio": purity, "maximum_m_norm_error": norm_error,
        "maximum_linear_trajectory_relative_error": trajectory_error,
        "checks": {"frequency_matches_measured_operator": bool(applicable and frequency_error <= 2e-4),
                   "decay_matches_measured_operator": bool(applicable and decay_error <= 1e-2),
                   "single_transverse_mode": purity < 1e-3, "unit_m_norm": norm_error <= 1e-6,
                   "positive_precession": bool(np.all(ax_zeros > 0)),
                   "diagonal_operator_applicable": bool(applicable),
                   "linear_trajectory_matches": bool(applicable and trajectory_error <= 2e-3),
                   "time_support_complete": bool(t[0] <= 2e-12 and t[-1] >= 3e-9-2e-12
                                                  and np.max(np.diff(t)) <= 2e-12*1.01)},
        "scope": "one registered harmonic; separate run provenance verification required",
        "paper_reproduced": False,
    }

    result["control_passed"] = all(result["checks"].values())
    return result


def read_trajectory(store, quantity):
    import zarr
    root = Path(store)
    manifests = list(root.glob("stages/*/manifest.json"))
    if len(manifests) != 1:
        raise ValueError("expected one retained Run stage")
    manifest_path = manifests[0]
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("complete") is not True or not {"m", "H_demag"} <= set(manifest.get("field_quantities", [])):
        raise ValueError("complete m and H_demag field manifests are required")
    stage = manifest_path.parent.relative_to(root).as_posix()
    array_path = stage+"/fields/"+quantity
    array = zarr.open_group(str(root), mode="r")[array_path]
    metadata = json.loads((root/array_path/".zarray").read_text())
    if (array.ndim != 2 or array.shape[1] != 384 or metadata.get("dtype") != "<f8"
            or metadata.get("chunks") != [1, 384] or metadata.get("compressor") is not None):
        raise ValueError("expected the registered 128-cell uncompressed float64 field layout")
    index = [json.loads(line) for line in (root/"continuous/index.jsonl").read_text().splitlines() if line.strip()]
    prefix = array_path+"/"
    rows = [r for r in index if r.get("sample_kind") == "field" and r.get("payload_ref", "").startswith(prefix)]
    rows.sort(key=lambda r: int(r["payload_ref"][len(prefix):]))
    if [int(r["payload_ref"][len(prefix):]) for r in rows] != list(range(array.shape[0])):
        raise ValueError("continuous field index is incomplete or duplicated")
    if any(r.get("coordinate", {}).get("kind") != "physical_time" for r in rows):
        raise ValueError("field times must be explicit physical coordinates")
    for sample in range(array.shape[0]):
        chunk = root/array_path/f"{sample}.0"
        if not chunk.is_file() or chunk.stat().st_size != 384*8:
            raise ValueError("missing or truncated field chunk; fill values are not measurement data")
    times = np.array([r["coordinate"]["time_s"] for r in rows], dtype=np.float64)
    values = np.asarray(array[:], dtype=np.float64).reshape(-1, 128, 3)
    return times, values


def verify_store(store):
    tm, m = read_trajectory(store, "m")
    th, h = read_trajectory(store, "H_demag")
    if tm.shape != th.shape or not np.allclose(tm, th, atol=1e-18, rtol=0):
        raise ValueError("m and H_demag sample coordinates do not match")
    result = analyze_trajectory(tm, m, h)
    result["schema"] = "fullmag.sushruth2020.finite-k-control-analysis.v1"
    result["store"] = str(Path(store).resolve())
    result["analysis_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    result["index_sha256"] = hashlib.sha256((Path(store)/"continuous/index.jsonl").read_bytes()).hexdigest()
    result["runtime_identity_verified"] = False
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("store", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    result = verify_store(args.store)
    with args.output.open("x") as stream:
        json.dump(result, stream, indent=2, allow_nan=False)
        stream.write("\n")
    raise SystemExit(0 if result["control_passed"] else 2)
