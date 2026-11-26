"""Measure periods from pinned Figure 3 inputs; no solver, fitting or quadrature."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image

from plot_sushruth_2020_response_reference import measure_figure3_anchors

IMAGE_SHA256 = "92aeb043aa5329cd73fc77fecc6eb110af760fe8b86a0f9b072cca2c83a7bf27"
REFERENCE_SHA256 = "3fa8dd8400f906870c9e794a88dbfda902c74616ab54328d73b031d9fa2751cd"


def crossings(coordinates, signs, *, max_gap):
    result = {"rising": [], "falling": []}
    previous = None
    for x, sign in zip(coordinates, signs):
        if sign == 0:
            continue
        if previous is not None:
            px, ps = previous
            if sign * ps < 0 and x - px <= max_gap:
                result["rising" if sign > 0 else "falling"].append([float(px), float(x)])
        previous = (x, sign)
    return result


def spacings(events):
    return [
        {"spacing_hz": b["frequency_hz"] - a["frequency_hz"],
         "bounds_hz": [b["bounds_hz"][0] - a["bounds_hz"][1],
                       b["bounds_hz"][1] - a["bounds_hz"][0]]}
        for a, b in zip(events, events[1:])
    ]


def sampled_events(frequency, values):
    f, v = np.asarray(frequency), np.asarray(values)
    result = {"maxima": [], "minima": [], "rising": [], "falling": []}
    for i in range(1, len(f) - 1):
        kind = None
        if v[i] > 0 and v[i] > v[i-1] and v[i] >= v[i+1]:
            kind = "maxima"
        elif v[i] < 0 and v[i] < v[i-1] and v[i] <= v[i+1]:
            kind = "minima"
        if kind:
            result[kind].append({"frequency_hz": float(f[i]),
                                 "bounds_hz": [float(f[i-1]), float(f[i+1])]})
    zeros = crossings(f, np.sign(v), max_gap=2.01 * float(np.max(np.diff(f))))
    for kind, brackets in zeros.items():
        result[kind] = [{"frequency_hz": sum(b) / 2, "bounds_hz": b} for b in brackets]
    return result


def _pixel_events(image, antenna, axes):
    left, right = axes
    base = 206 if antenna == "S" else 207
    convert = lambda x: (6 + 3 * (float(x) - left) / (right - left)) * 1e9
    result = {"maxima": [], "minima": [], "rising": [], "falling": []}
    windows = {
        "S": {"maxima": (275, 52, 391, 202), "minima": (245, 212, 431, 365)},
        "GSG": {"maxima": (760, 52, 911, 202), "minima": (755, 212, 911, 365)},
    }[antenna]

    def mask(xlo, ylo, xhi, yhi):
        region = image[ylo:yhi, xlo:xhi]
        if antenna == "S":
            return (region[:, :, 0] < 80) & (region[:, :, 1] < 80) & (region[:, :, 2] > 180)
        selected = region.max(axis=2) < 80
        yy, xx = np.indices(selected.shape)
        selected[(xx + xlo >= 850) & (yy + ylo <= 110)] = False
        return selected

    for kind, window in windows.items():
        xlo, ylo, xhi, yhi = window
        selected = mask(*window)
        columns = np.flatnonzero(selected.any(axis=0))
        groups = np.split(columns, np.flatnonzero(np.diff(columns) > 1) + 1)
        for group in groups:
            if not len(group):
                continue
            ys, xs = np.nonzero(selected[:, group[0]:group[-1]+1])
            extreme = ys.min() if kind == "maxima" else ys.max()
            hits = xs[ys == extreme] + group[0] + xlo
            result[kind].append({
                "frequency_hz": convert(hits.mean()),
                "bounds_hz": [convert(hits.min() - .5), convert(hits.max() + .5)],
                "pixel_span": [int(hits.min()), int(hits.max())],
            })
    xlo, xhi = (272, 391) if antenna == "S" else (772, 886)
    selected = mask(xlo, 52, xhi, 365)
    columns, signs = [], []
    for i in range(selected.shape[1]):
        ys = np.flatnonzero(selected[:, i]) + 52
        if len(ys) and (np.all(ys < base-1) or np.all(ys > base+1)):
            columns.append(xlo+i)
            signs.append(1 if np.all(ys < base-1) else -1)
    for kind, brackets in crossings(columns, signs, max_gap=5).items():
        result[kind] = [
            {"frequency_hz": convert(sum(b)/2),
             "bounds_hz": [convert(b[0]-.5), convert(b[1]+.5)], "pixel_span": b}
            for b in brackets
        ]
    return result, {"axis_pixels": axes, "baseline_y": base, "extrema_windows_xyxy": windows,
                    "zero_window_xyxy": [xlo, 52, xhi, 365], "maximum_zero_gap_pixels": 5,
                    "masked_GSG_text": [850, 52, 1015, 111] if antenna == "GSG" else None}


def audit_periods(published_png, reference_json):
    image_bytes, reference_bytes = Path(published_png).read_bytes(), Path(reference_json).read_bytes()
    if hashlib.sha256(image_bytes).hexdigest() != IMAGE_SHA256:
        raise ValueError("published image identity differs")
    if hashlib.sha256(reference_bytes).hexdigest() != REFERENCE_SHA256:
        raise ValueError("reference identity differs")
    image = np.asarray(Image.open(published_png).convert("RGB"))
    data = json.loads(reference_bytes)
    frequency = np.asarray(data["frequencies_hz"])
    visible = (frequency >= 6e9) & (frequency <= 9e9)
    result = {}
    for antenna, panel in [("S", "a"), ("GSG", "e")]:
        anchors = measure_figure3_anchors(published_png, reference_json, panel=panel)
        pixels, profile = _pixel_events(image, antenna, anchors["axis_pixel_bounds"])
        case = next(c for c in data["cases"] if c["antenna"] == antenna and c["alpha"] == .01)
        model = sampled_events(frequency[visible], np.asarray(case["transmission"])[visible, 0])
        result[antenna] = {
            "published": {"events": pixels, "spacings": {k: spacings(v) for k, v in pixels.items()},
                          "profile": profile},
            "reference": {"events": model, "spacings": {k: spacings(v) for k, v in model.items()}},
        }
    return {
        "schema": "fullmag.sushruth2020.figure3-period-audit.v1",
        "source_doi": "10.1103/PhysRevResearch.2.043203",
        "input_sha256": {"image": IMAGE_SHA256, "reference": REFERENCE_SHA256},
        "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "parameters_si": data["parameters_si"], "alpha": .01, "frequency_unit": "Hz",
        "reference_grid_hz": float(np.max(np.diff(frequency[visible]))),
        "panels": result, "amplitude_fit_applied": False, "frequency_shift_applied_hz": 0,
        "new_quadrature_executed": False, "fullmag_solver_executed": False,
        "boris_solver_executed": False, "physics_qualified": False, "cause_resolved": False,
        "uncertainty": "Stroke/bracket plus half-pixel endpoints; reference extrema plus one grid step. Not total digitization or model uncertainty.",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("published_png", type=Path)
    parser.add_argument("reference_json", type=Path)
    parser.add_argument("output_json", type=Path)
    args = parser.parse_args()
    result = audit_periods(args.published_png, args.reference_json)
    with args.output_json.open("x") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
