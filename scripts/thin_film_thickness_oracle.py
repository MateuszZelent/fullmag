"""Small open-film cosine-Galerkin oracle; never a production FEM solver."""
from __future__ import annotations

import math
import numpy as np

MU0 = 4.0 * math.pi * 1e-7


def _scalar(name, value, *, positive=False, nonnegative=False):
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, (int, float, np.integer, np.floating)):
        raise ValueError(f"{name} must be a finite real number")
    value = float(value)
    if not math.isfinite(value) or (positive and value <= 0) or (nonnegative and value < 0):
        raise ValueError(f"invalid {name}")
    return value


def modal_matrices(*, ms_a_m, exchange_j_m, bias_t, thickness_m, k_rad_m,
                   geometry, basis_size, quadrature_points=128):
    """Return restoring-field K [T] and dimensionless Hermitian demag N."""
    ms = _scalar("ms_a_m", ms_a_m, positive=True)
    exchange = _scalar("exchange_j_m", exchange_j_m, nonnegative=True)
    bias = _scalar("bias_t", bias_t, positive=True)
    thickness = _scalar("thickness_m", thickness_m, positive=True)
    k = _scalar("k_rad_m", k_rad_m)
    if geometry not in ("DE", "BV"):
        raise ValueError("geometry must be DE or BV")
    if type(basis_size) is not int or not 1 <= basis_size <= 64:
        raise ValueError("basis_size must be an integer in 1..64")
    if type(quadrature_points) is not int or not max(16, 2*basis_size) <= quadrature_points <= 512:
        raise ValueError("invalid quadrature_points")
    n = np.arange(basis_size)
    b = math.pi * n
    a = _scalar("abs(k)*thickness_m", abs(k) * thickness)
    eye = np.eye(basis_size)
    r = np.zeros_like(eye)
    s = np.zeros_like(eye)
    if a > 0:
        nodes, weights = np.polynomial.legendre.leggauss(quadrature_points)
        u = (nodes + 1) / 2
        weights = weights / 2
        norm = np.sqrt(2.0 - (n == 0))
        cosine = np.cos(u[:, None] * b)
        basis = cosine * norm
        denominator = a*a + b*b
        lower = np.exp(-a*u[:, None])
        upper = np.exp(-a*(1-u[:, None]))
        parity = (-1.0)**n
        e_basis = norm * (2*a*cosine - a*lower - a*upper*parity) / denominator
        s_basis = norm * (2*b*np.sin(u[:, None]*b) - a*lower + a*upper*parity) / denominator
        # Avoid cancellation of the continuous n=0 limit at very small |k|t.
        e_basis[:, 0] = (-np.expm1(-a*u) - np.expm1(-a*(1-u))) / a
        s_basis[:, 0] = (np.expm1(-a*(1-u)) - np.expm1(-a*u)) / a
        r = (a/2) * (basis.T @ (weights[:, None]*e_basis))
        s = (a/2) * (basis.T @ (weights[:, None]*s_basis))
        if np.max(np.abs(r-r.T)) > 1e-10 or np.max(np.abs(s+s.T)) > 1e-10:
            raise ValueError("quadrature does not preserve demag adjoint symmetry")
        r = (r+r.T)/2
        s = (s-s.T)/2
    zero = np.zeros_like(eye)
    if geometry == "DE":
        cross = 1j*np.sign(k)*s
        demag = np.block([[r, cross], [cross, eye-r]])
    else:
        demag = np.block([[zero, zero], [zero, eye-r]]).astype(complex)
    restoring = np.diag(bias + (2*exchange/ms)*(k*k + (b/thickness)**2))
    energy = np.block([[restoring, zero], [zero, restoring]]) + MU0*ms*demag
    if not np.isfinite(energy).all() or np.linalg.eigvalsh(energy).min() <= 0:
        raise ValueError("nonfinite or unstable restoring-field operator")
    return energy, demag


def solve_thickness_modes(*, ms_a_m, exchange_j_m, bias_t, thickness_m,
                          gamma0_m_a_s, k_rad_m, geometry, basis_size,
                          quadrature_points=128):
    """Return positive-frequency modes and residuals of this oracle only."""
    gamma0 = _scalar("gamma0_m_a_s", gamma0_m_a_s, positive=True)
    energy, demag = modal_matrices(
        ms_a_m=ms_a_m, exchange_j_m=exchange_j_m, bias_t=bias_t,
        thickness_m=thickness_m, k_rad_m=k_rad_m, geometry=geometry,
        basis_size=basis_size, quadrature_points=quadrature_points,
    )
    eye = np.eye(basis_size)
    zero = np.zeros_like(eye)
    operator = np.block([[zero, -eye], [eye, zero]]) @ energy
    eigenvalues, vectors = np.linalg.eig(operator)
    scale = np.linalg.norm(operator, 2)
    if not math.isfinite(scale) or not np.isfinite(eigenvalues).all():
        raise ValueError("nonfinite oracle spectrum")
    if np.max(np.abs(eigenvalues.real)) > 1e-10*scale:
        raise ValueError("oracle spectrum is not purely precessional")
    positive = np.flatnonzero(eigenvalues.imag > 0)
    if len(positive) != basis_size:
        raise ValueError("oracle positive-frequency mode count mismatch")
    modes = []
    for index in positive[np.argsort(eigenvalues[positive].imag)]:
        value, vector = eigenvalues[index], vectors[:, index]
        norm = np.linalg.norm(vector)
        residual = np.linalg.norm(operator @ vector - value*vector) / ((scale+abs(value))*norm)
        power = np.abs(vector.reshape(2, basis_size))**2
        frequency = float(value.imag)*(gamma0/MU0)/(2*math.pi)
        if not math.isfinite(frequency) or frequency <= 0:
            raise ValueError("nonfinite or nonpositive oracle frequency")
        modes.append({
            "frequency_hz": frequency,
            "oracle_residual_relative_l2": float(residual),
            "nonuniform_power_fraction": float(power[:, 1:].sum()/power.sum()),
        })
    return {
        "schema": "fullmag.thin_film_thickness_oracle.v1",
        "qualification": "diagnostic_oracle_only_not_FEM",
        "parameters": {"ms_a_m": float(ms_a_m), "exchange_j_m": float(exchange_j_m),
                       "bias_t": float(bias_t), "thickness_m": float(thickness_m),
                       "gamma0_m_a_s": gamma0, "k_rad_m": float(k_rad_m),
                       "geometry": geometry, "basis_size": basis_size,
                       "quadrature_points": quadrature_points,
                       "mu0_t_m_a": MU0, "boundary": "open_magnetostatic_free_exchange"},
        "demag_hermitian_error": float(np.max(np.abs(demag-demag.conj().T))),
        "modes": modes,
    }
