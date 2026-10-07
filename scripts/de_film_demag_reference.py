"""Independent 1D P1 magnetostatic reference for the DE operator audit.

Uses the scalar-potential weak form in docs/physics/0800-fem-static-pbc-demag.md
and the exp(-i*k*y) convention of 0828-fem-frequency-domain-floquet-demag.md.
This is a reference calculation, never a Fullmag eigenmode or qualification.
"""
from __future__ import annotations
import math
import numpy as np


def film_response(*, k_rad_per_m, thickness_m, padding_m, my=0j, mz=1+0j,
                  layers=12, air_cells=256):
    """Return phi [A], element H [A/m] for unit transverse M [A/m].

The amplitudes my/mz are magnetization in A/m (not normalized m).
Dirichlet endpoints enclose a centered film. Interfaces are exact mesh nodes.
Coordinates and potential are scaled by thickness during the linear solve.
"""
    if not all(math.isfinite(x) for x in (k_rad_per_m, thickness_m, padding_m)):
        raise ValueError("finite geometry and wavevector required")
    if thickness_m <= 0 or padding_m <= 0:
        raise ValueError("positive thickness and padding required")
    for count in (layers, air_cells):
        if isinstance(count, bool) or not isinstance(count, int) or count < 2:
            raise ValueError("at least two integer elements per region required")
    if not all(math.isfinite(x) for x in (complex(my).real, complex(my).imag, complex(mz).real, complex(mz).imag)):
        raise ValueError("finite magnetization required")
    d = padding_m / thickness_m
    z = np.concatenate((np.linspace(-.5-d, -.5, air_cells+1),
                        np.linspace(-.5, .5, layers+1)[1:],
                        np.linspace(.5, .5+d, air_cells+1)[1:]))
    h = np.diff(z)
    q = k_rad_per_m * thickness_m
    local_diag = 1/h + q*q*h/3
    off = -1/h + q*q*h/6
    diag = np.zeros(len(z))
    diag[:-1] += local_diag
    diag[1:] += local_diag
    rhs = np.zeros(len(z), dtype=complex)
    magnetic = slice(air_cells, air_cells+layers)
    for e in range(air_cells, air_cells+layers):
        # (grad v, M): conjugate Fourier derivative is +i*k.
        rhs[e] += 1j*q*my*h[e]/2 - mz
        rhs[e+1] += 1j*q*my*h[e]/2 + mz
    # Dirichlet zero at both ends; tridiagonal elimination in O(N).
    diagonal = diag[1:-1].copy()
    upper = off[1:-1]
    load = rhs[1:-1].copy()
    for i in range(1, len(diagonal)):
        factor = upper[i-1]/diagonal[i-1]
        diagonal[i] -= factor*upper[i-1]
        load[i] -= factor*load[i-1]
    p = np.zeros(len(z), dtype=complex)
    p[-2] = load[-1]/diagonal[-1]
    for i in range(len(diagonal)-2, -1, -1):
        p[i+1] = (load[i]-upper[i]*p[i+2])/diagonal[i]
    applied = diag*p
    applied[:-1] += off*p[1:]
    applied[1:] += off*p[:-1]
    residual = np.linalg.norm((applied-rhs)[1:-1]) / max(np.linalg.norm(rhs[1:-1]), 1e-300)
    hy = 1j*q*(p[:-1]+p[1:])/2
    hz = -np.diff(p)/h
    mean_hy = np.sum(h[magnetic]*hy[magnetic])
    mean_hz = np.sum(h[magnetic]*hz[magnetic])
    energy_form = float(np.vdot(p, applied).real)
    energy_work = float(-(complex(my).conjugate()*mean_hy + complex(mz).conjugate()*mean_hz).real)
    return {"z_m": z*thickness_m, "potential_a": p*thickness_m,
            "hy_a_per_m": hy, "hz_a_per_m": hz,
            "mean_hy_a_per_m": mean_hy, "mean_hz_a_per_m": mean_hz,
            "relative_residual": float(residual),
            "energy_j_per_m2": .5*(4e-7*math.pi)*thickness_m*energy_form,
            "work_energy_j_per_m2": .5*(4e-7*math.pi)*thickness_m*energy_work,
            "qualification": "REFERENCE_ONLY"}
