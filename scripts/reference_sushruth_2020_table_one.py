"""Arithmetic audit of Table I and Eq. 2-5; not a Fullmag solver.

Sushruth et al., Phys. Rev. Research 2, 043203 (2020).
The table does not specify k: its derived rows are checked conditionally
at the same k, without fitting parameters or changing production physics.
"""
import json
import math


_EFFECTIVE_T = .25
_SATURATION_T = .89
_THICKNESS_M = 20e-9
_GAMMA_HZ_PER_T = 30e9


def _dispersion(k):
    """Published exchange-free dispersion; k=0 returns the positive-side limit."""
    x = abs(k) * _THICKNESS_M
    if x < 1e-4:
        n = x * (.5 + x * (-1/6 + x * (1/24 - x/120)))
        dn = .5 + x * (-1/3 + x * (1/8 - x/30))
    else:
        n = 1 + math.expm1(-x) / x
        dn = (1 - (1 + x) * math.exp(-x)) / x**2
    root = math.sqrt(_EFFECTIVE_T * (_EFFECTIVE_T + _SATURATION_T * n))
    gamma = 2 * math.pi * _GAMMA_HZ_PER_T
    velocity = gamma * _EFFECTIVE_T * _SATURATION_T * _THICKNESS_M * dn / (2 * root)
    return {"frequency_hz": _GAMMA_HZ_PER_T * root,
            "group_velocity_m_per_s": -velocity if k < 0 else velocity}


def audit_table_one():
    """Fixed Table I inputs and conditional same-k identities; no solver launch."""
    zero = _dispersion(0)
    rows = []
    linewidths = []
    lengths = []
    for alpha, linewidth, length in ((.01, 230e6, 1.2e-6), (.1, 2.3e9, .12e-6)):
        inferred_length = 105 / (math.pi * linewidth)
        rows.append({
            "alpha": alpha,
            "table_linewidth_hz": linewidth,
            "table_attenuation_length_m": length,
            "table_group_velocity_m_per_s": 105,
            "length_from_velocity_linewidth_m": inferred_length,
            "velocity_from_length_linewidth_m_per_s": math.pi * linewidth * length,
            "length_ratio_table_to_identity": length / inferred_length,
        })
        zero_linewidth = alpha * _GAMMA_HZ_PER_T * 2 * _EFFECTIVE_T
        linewidths.append(zero_linewidth)
        lengths.append(zero["group_velocity_m_per_s"] / (math.pi * zero_linewidth))
    return {
        "source_doi": "10.1103/PhysRevResearch.2.043203",
        "source_location": "Table I; Eq. 2-5 and Appendix A",
        "table_wavevector": "unspecified; same-k interpretation is conditional",
        "parameters_si": {"mu0_h_eff_t": _EFFECTIVE_T, "mu0_ms_t": _SATURATION_T,
                          "film_thickness_m": _THICKNESS_M,
                          "gamma_hz_per_t": _GAMMA_HZ_PER_T},
        "same_k_identity": rows,
        "k_zero_positive_limit": {**zero, "alpha": [.01, .1],
                                 "linewidth_hz": linewidths,
                                 "attenuation_length_m": lengths},
        "fullmag_solver_executed": False,
        "boris_solver_executed": False,
        "physics_qualified": False,
        "limitations": [
            "The unspecified table wavevector prevents an unconditional author-error claim.",
            "No reproduction of Fig. 3, finite GSG, RF circuit, or spin-wave simulation.",
            "Small-damping, exchange-free dispersion; no production parameters changed.",
        ],
    }


if __name__ == "__main__":
    print(json.dumps(audit_table_one(), indent=2, allow_nan=False))
