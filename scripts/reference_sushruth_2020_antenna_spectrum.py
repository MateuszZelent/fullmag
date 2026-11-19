"""Independent reference for Sushruth et al., PRResearch 2, 043203 (2020).

Equations (6)-(8), https://doi.org/10.1103/PhysRevResearch.2.043203 .
This reproduces the dimensionless antenna spectra used in Fig. 1. It is
validation data, not a Fullmag simulation or a solved current distribution.
The model assumes infinitely thin/long strips, uniform current per strip,
and no eddy-current shielding. Absolute H/I is not specified by Eq. (6).
"""
from __future__ import annotations

import json
import math


def antenna_spectra(k_rad_per_m, *, width_m=200e-9, gap_m=200e-9, spacing_m=0.0):
    """Return complex normalized h_x(k); translations use exp(+i k delta).

    S carries +1; GS carries +1 at +(L+g)/2 and -1 at -(L+g)/2.
    GSG carries +1 at zero and -1/2 at each of +/-(L+g).
    """
    parameters = (k_rad_per_m, width_m, gap_m, spacing_m)
    if any(isinstance(v, bool) or not isinstance(v, (int, float))
           or not math.isfinite(v) for v in parameters):
        raise ValueError("wave vector and dimensions must be finite numbers")
    if width_m <= 0 or gap_m < 0 or spacing_m < 0:
        raise ValueError("width must be positive; gap and spacing nonnegative")
    argument = k_rad_per_m * width_m / 2
    single = (1.0 if argument == 0 else math.sin(argument) / argument)
    single *= math.exp(-abs(k_rad_per_m) * spacing_m)
    phase = math.sin(k_rad_per_m * (gap_m + width_m) / 2)
    return {"S": complex(single), "GS": 2j * phase * single,
            "GSG": complex(2 * phase * phase * single)}


def figure1_reference():
    """Sample the published model; the sampling grid is ours, not digitized data."""
    width = gap = 200e-9
    samples = []
    for index in range(1201):
        k = (4 * math.pi / width) * index / 1200
        spectra = antenna_spectra(k, width_m=width, gap_m=gap)
        power = {name: abs(value)**2 for name, value in spectra.items()}
        samples.append({
            "k_rad_per_m": k,
            "h_normalized": {name: [value.real, value.imag]
                             for name, value in spectra.items()},
            "power_normalized": power,
            # The caption multiplies single-wire POWER, not amplitude, by four.
            "figure1_display_power": {**power, "S": 4 * power["S"]},
        })
    return {
        "schema": "fullmag.sushruth2020.antenna-reference.v1",
        "source_doi": "10.1103/PhysRevResearch.2.043203",
        "source_location": "published version, equations 6-8 and figure 1",
        "model": "infinitely_thin_uniform_current_strips",
        "parameters_si": {"width_m": width, "gap_m": gap, "spacing_m": 0.0},
        "normalization": "h_S(0)=1; shape only, no absolute H or H/I calibration",
        "fourier_translation": "exp(+i*k*delta)",
        "complex_encoding": ["real", "imaginary"],
        "units": {"k_rad_per_m": "rad/m", "h_normalized": "1",
                  "power_normalized": "1", "figure1_display_power": "1"},
        "sampling": "1201 uniform k samples from 0 to 4*pi/L inclusive",
        "fullmag_solver_executed": False,
        "boris_solver_executed": False,
        "physics_qualified": False,
        "samples": samples,
    }


if __name__ == "__main__":
    print(json.dumps(figure1_reference(), separators=(",", ":"), allow_nan=False))
