"""Independent Eq. 1-3/9-10 reference, not a Fullmag or BORIS solver.

Sushruth et al., Phys. Rev. Research 2, 043203 (2020), Table I and Fig. 3.
See docs/physics/0951-sushruth-2020-forward-volume-reference.md for units,
approximations and the preregistered numerical checks.
"""
from __future__ import annotations

import json
import math
from numbers import Real

import numpy as np

from reference_sushruth_2020_antenna_spectrum import antenna_spectra


def _number(name, value, *, minimum=None, strict=False):
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, Real) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite real number, not bool")
    if minimum is not None and (value < minimum or (strict and value == minimum)):
        raise ValueError(f"{name} is outside its valid domain")
    return float(value)


def _real_array(name, values):
    if isinstance(values, (list, tuple)) and any(
        isinstance(value, (bool, np.bool_)) for value in np.asarray(values, dtype=object).flat
    ):
        raise ValueError(f"{name} must contain finite real numbers, not bool")
    raw = np.asarray(values)
    if raw.dtype.kind not in "iuf" or not np.all(np.isfinite(raw)):
        raise ValueError(f"{name} must contain finite real numbers, not bool")
    return raw.astype(np.float64)


def film_susceptibility(
    k_rad_per_m, frequency_hz, *, alpha=0.01, mu0_h_eff_t=0.25,
    mu0_ms_t=0.89, film_thickness_m=20e-9, gamma_hz_per_t=30e9,
):
    """Approximate dimensionless chi_xx; exp(+i*omega*t), Eq. 1."""
    k = _real_array("k_rad_per_m", k_rad_per_m)
    frequency = _number("frequency_hz", frequency_hz)
    damping = _number("alpha", alpha, minimum=0, strict=True)
    effective = _number("mu0_h_eff_t", mu0_h_eff_t, minimum=0, strict=True)
    saturation = _number("mu0_ms_t", mu0_ms_t, minimum=0, strict=True)
    thickness = _number("film_thickness_m", film_thickness_m, minimum=0)
    gamma = 2 * math.pi * _number("gamma_hz_per_t", gamma_hz_per_t, minimum=0, strict=True)
    x = np.abs(k) * thickness
    # expm1 handles the exponential; the series avoids cancellation in 1 + (...).
    ratio = np.divide(np.expm1(-x), x, out=np.full(np.shape(x), -1.0), where=x != 0)
    n = np.where(x < 1e-4, x * (0.5 + x * (-1/6 + x * (1/24 - x/120))), 1 + ratio)
    omega = 2 * math.pi * frequency
    omega_k_squared = gamma**2 * effective * (effective + n * saturation)
    linewidth = damping * gamma * (2 * effective + n * saturation)
    return gamma**2 * saturation * effective / (omega_k_squared - omega**2 + 1j * omega * linewidth)


def inductive_response(
    frequencies_hz, *, antenna="GSG", width_m=200e-9, gap_m=250e-9,
    spacing_m=30e-9, distance_m=2e-6, alpha=0.01, mu0_h_eff_t=0.25,
    mu0_ms_t=0.89, film_thickness_m=20e-9, gamma_hz_per_t=30e9,
    intervals=16384, max_kl=80.0,
):
    """Composite Simpson reference on 0 <= q=|k|L <= max_kl.

    Both spectra are even in k. The full exp(-i*k*r) integral therefore
    reduces to a cosine integral, still with complex susceptibility.
    The finite cutoff requires convergence checks for each parameter regime.
    """
    frequencies = _real_array("frequencies_hz", frequencies_hz)
    if frequencies.ndim != 1 or not frequencies.size:
        raise ValueError("frequencies_hz must be a nonempty one-dimensional sequence")
    if antenna not in ("S", "GS", "GSG"):
        raise ValueError("antenna must be S, GS or GSG")
    width = _number("width_m", width_m, minimum=0, strict=True)
    gap = _number("gap_m", gap_m, minimum=0)
    spacing = _number("spacing_m", spacing_m, minimum=0)
    distance = _number("distance_m", distance_m)
    cutoff = _number("max_kl", max_kl, minimum=0, strict=True)
    if type(intervals) is not int or intervals < 2 or intervals % 2:
        raise ValueError("intervals must be an even integer >= 2, not bool")
    q = np.linspace(0.0, cutoff, intervals + 1)
    k = q / width
    power = np.array([abs(antenna_spectra(
        float(value), width_m=width, gap_m=gap, spacing_m=spacing,
    )[antenna])**2 for value in k])
    weights = np.ones(intervals + 1)
    weights[1:-1:2] = 4
    weights[2:-1:2] = 2
    weighted_power = weights * power
    denominator = weighted_power.sum()
    if not math.isfinite(denominator) or denominator <= 0:
        raise ValueError("source normalization must be finite and positive")
    cosine = np.cos(k * distance)
    reflection, transmission = [], []
    for frequency in frequencies:
        chi = film_susceptibility(
            k, float(frequency), alpha=alpha, mu0_h_eff_t=mu0_h_eff_t,
            mu0_ms_t=mu0_ms_t, film_thickness_m=film_thickness_m,
            gamma_hz_per_t=gamma_hz_per_t,
        )
        reflection.append(np.sum(weighted_power * chi) / denominator)
        transmission.append(np.sum(weighted_power * chi * cosine) / denominator)
    return {
        "reflection": np.asarray(reflection),
        "transmission": np.asarray(transmission),
        "normalization_integral_per_m": float(2 * cutoff / (3 * intervals * width) * denominator),
    }


def figure3_reference():
    """Equation-based samples with explicit Table I parameters, not digitized curves."""
    frequencies = np.linspace(7e9, 14e9, 141)
    cases = []
    for damping, scale_s, scale_composite in ((0.01, 1, 1), (0.03, 10, 30),
                                             (0.07, 30, 300), (0.1, 60, 600)):
        for antenna in ("S", "GS", "GSG"):
            result = inductive_response(frequencies, antenna=antenna, alpha=damping)
            cases.append({
                "antenna": antenna, "alpha": damping,
                "normalization_integral_per_m": result["normalization_integral_per_m"],
                "figure3_display_multiplier": scale_s if antenna == "S" else scale_composite,
                "reflection": [[float(z.real), float(z.imag)] for z in result["reflection"]],
                "transmission": [[float(z.real), float(z.imag)] for z in result["transmission"]],
            })
    return {
        "schema": "fullmag.sushruth2020.response-reference.v1",
        "source_doi": "10.1103/PhysRevResearch.2.043203",
        "source_location": "published Eq. 1-3/6-10, Table I and Fig. 3",
        "parameters_si": {"mu0_h_eff_t": 0.25, "mu0_ms_t": 0.89,
                          "gamma_hz_per_t": 30e9, "film_thickness_m": 20e-9,
                          "width_m": 200e-9, "gap_m": 250e-9,
                          "spacing_m": 30e-9, "distance_m": 2e-6},
        "quadrature": {"method": "composite_simpson_positive_q", "q_definition": "abs(k)*L",
                       "max_kl": 80.0, "intervals": 16384},
        "fmr_hz_from_table_parameters": 7.5e9,
        "time_convention": "exp(+i*omega*t)",
        "propagation_convention": "exp(-i*k*r); cosine reduction for an even integrand",
        "normalization": "Each antenna uses its own integral of abs(h)**2; raw R/T have no display multiplier",
        "units": {"reflection": "1", "transmission": "1", "frequency_hz": "Hz",
                  "normalization_integral_per_m": "1/m"},
        "complex_encoding": ["real", "imaginary"],
        "limitations": ["weak damping; no exchange or eddy shielding",
                        "infinitely thin and long uniform-current strips",
                        "not calibrated S11/S21; no fit to plotted frequency shifts"],
        "fullmag_solver_executed": False, "boris_solver_executed": False,
        "physics_qualified": False, "frequencies_hz": frequencies.tolist(), "cases": cases,
    }


if __name__ == "__main__":
    print(json.dumps(figure3_reference(), separators=(",", ":"), allow_nan=False))
