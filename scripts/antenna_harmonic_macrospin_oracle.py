"""Independent transverse Gilbert LLG reference; no Fullmag backend imports.

The equilibrium is +z in H0>0, with no other interactions. Magnetization is
dimensionless; fields are A/m; gamma0 is m/(A s); frequency is Hz.
Phasors reconstruct as Re(amplitude * exp(+i*omega*t)).
This diagnostic qualifies its reference only, never a production backend.
"""

from __future__ import annotations

import cmath
import hashlib
import json
import math
from pathlib import Path


def harmonic_response(
    *, bias_a_per_m: float, field_xy_a_per_m: tuple[complex, complex],
    frequency_hz: float, alpha: float, gamma0: float = 2.211e5,
) -> tuple[complex, complex]:
    """Solve linearized Gilbert LLG, not a Fullmag operator matrix.

    Let J(x,y)=(-y,x), Omega=gamma0*H0. Gilbert gives
    (i*omega*(Id-alpha*J)-Omega*J) q = -gamma0*J*h.
    With a=Omega+i*alpha*omega and D=a*a-omega*omega:
    qx=gamma0*(a*hx+i*omega*hy)/D,
    qy=gamma0*(a*hy-i*omega*hx)/D.
    The zero-frequency limit is h/H0, independent of damping.
    """
    for name, value in (("bias_a_per_m", bias_a_per_m),
                        ("frequency_hz", frequency_hz), ("alpha", alpha),
                        ("gamma0", gamma0)):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"{name} must be finite")
    if bias_a_per_m <= 0 or gamma0 <= 0 or frequency_hz < 0 or alpha < 0:
        raise ValueError("positive bias/gamma0 and non-negative frequency/alpha required")
    if len(field_xy_a_per_m) != 2:
        raise ValueError("two transverse field components required")
    hx, hy = map(complex, field_xy_a_per_m)
    if not all(math.isfinite(v) for h in (hx, hy) for v in (h.real, h.imag)):
        raise ValueError("field components must be finite")
    omega = math.tau * frequency_hz
    a = gamma0 * bias_a_per_m + 1j * alpha * omega
    denominator = a * a - omega * omega
    if not all(math.isfinite(v) for v in (a.real, a.imag, denominator.real, denominator.imag)):
        raise ValueError("parameters exceed oracle arithmetic range")
    if denominator == 0:
        raise ValueError("undamped resonance has no finite steady response")
    result = (gamma0 * (a * hx + 1j * omega * hy) / denominator,
              gamma0 * (a * hy - 1j * omega * hx) / denominator)
    if not all(math.isfinite(v) for q in result for v in (q.real, q.imag)):
        raise ValueError("response exceeds oracle arithmetic range")
    return result


def _cross(a, b):
    return (a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0])


def _time_domain_response(field_xy_over_bias, ratio, alpha, samples_per_cycle):
    """Integrate full nonlinear 3D Gilbert LLG in u=gamma0*H0*t.

    No tangent matrix is used. Burn-in is 20 damping time constants; the
    measurement covers eight exact drive periods. No trajectory is retained.
    This small reference is neither an FEM/FDM realization nor a solver lane.
    """
    period = math.tau / ratio
    dt = period / samples_per_cycle
    burn_steps = math.ceil(20 * (1 + alpha*alpha) / alpha / dt)
    steps = burn_steps + 8 * samples_per_cycle
    m = (0.0, 0.0, 1.0)
    phasors = [0j, 0j]
    max_norm_defect = 0.0

    def rhs(state, u):
        carrier = cmath.exp(1j * ratio * u)
        h = ((field_xy_over_bias[0]*carrier).real,
             (field_xy_over_bias[1]*carrier).real, 1.0)
        precession = _cross(state, h)
        damping = _cross(state, precession)
        return tuple(-(p + alpha*d)/(1+alpha*alpha) for p, d in zip(precession, damping))

    def shifted(state, derivative, scale):
        return tuple(x + scale*y for x, y in zip(state, derivative))

    for step in range(steps):
        u = step * dt
        k1 = rhs(m, u)
        k2 = rhs(shifted(m, k1, dt/2), u+dt/2)
        k3 = rhs(shifted(m, k2, dt/2), u+dt/2)
        k4 = rhs(shifted(m, k3, dt), u+dt)
        m = tuple(x + dt*(a+2*b+2*c+d)/6 for x, a, b, c, d in zip(m, k1, k2, k3, k4))
        max_norm_defect = max(max_norm_defect, abs(math.hypot(*m)-1))
        if step >= burn_steps:
            carrier = cmath.exp(-1j * ratio * (step+1)*dt)
            for axis in range(2):
                phasors[axis] += 2*m[axis]*carrier/(8*samples_per_cycle)
    return tuple(phasors), max_norm_defect


def diagnostic() -> dict:
    """Check reference signs/limits and independent time-domain convergence."""
    checks = []
    bias, gamma0 = 1e4, 2.211e5
    dc = harmonic_response(bias_a_per_m=bias, field_xy_a_per_m=(2+3j, -4+1j),
                           frequency_hz=0, alpha=0.2)
    if max(abs(a-b) for a, b in zip(dc, ((2+3j)/bias, (-4+1j)/bias))) > 1e-18:
        raise ValueError("DC tilt oracle failed")
    checks.append("dc_tilt")
    # Independent literal alpha=0, omega=Omega/2 result for x drive.
    lossless = harmonic_response(bias_a_per_m=bias, field_xy_a_per_m=(1, 0),
                                frequency_hz=gamma0*bias/(2*math.tau), alpha=0)
    if max(abs(a-b) for a, b in zip(lossless, (4/(3*bias), -2j/(3*bias)))) > 1e-18:
        raise ValueError("lossless precession sign oracle failed")
    checks.append("lossless_sign")
    for phase in (0, math.pi/2, math.pi):
        for amplitude in (-1, 1):
            sine = amplitude * cmath.exp(1j*(phase-math.pi/2))
            if abs((sine*cmath.exp(1j*0.7)).real-amplitude*math.sin(0.7+phase)) > 1e-15:
                raise ValueError("sine phasor reconstruction failed")
    checks.append("sine_phase")
    circular = harmonic_response(bias_a_per_m=bias, field_xy_a_per_m=(1, -1j),
                                 frequency_hz=gamma0*bias/math.tau, alpha=0.2)
    if max(abs(a-b) for a, b in zip(circular, (-5j/bias, -5/bias))) > 1e-18:
        raise ValueError("circular resonance phase failed")
    checks.append("circular_resonance_phase")
    try:
        harmonic_response(bias_a_per_m=bias, field_xy_a_per_m=(1, -1j),
                          frequency_hz=gamma0*bias/math.tau, alpha=0)
    except ValueError:
        checks.append("undamped_resonance_rejected")
    else:
        raise ValueError("undamped resonance must reject")
    cases = []
    for alpha, ratio, field in (
        (0.05, 0.5, (1e-6+0j, 0j)),
        (0.05, 1.0, (1e-6j, 0j)),
        (0.2, 1.4, (1e-6+0j, 0.5e-6j)),
    ):
        expected = harmonic_response(bias_a_per_m=bias,
                                     field_xy_a_per_m=tuple(h*bias for h in field),
                                     frequency_hz=ratio*gamma0*bias/math.tau,
                                     alpha=alpha, gamma0=gamma0)
        errors = []
        norm_defects = []
        for resolution in (128, 256):
            measured, norm_defect = _time_domain_response(field, ratio, alpha, resolution)
            error = math.sqrt(sum(abs(a-b)**2 for a, b in zip(measured, expected)))
            scale = math.sqrt(sum(abs(q)**2 for q in expected))
            errors.append(error/scale)
            norm_defects.append(norm_defect)
        if errors[1] > 2e-6 or errors[1] >= errors[0] or max(norm_defects) > 1e-10:
            raise ValueError(f"time-domain reference convergence failed: {alpha=}, {ratio=}, {errors=}")
        cases.append({"alpha": alpha, "omega_over_gamma0_H0": ratio,
                      "field_xy_over_bias": [[h.real, h.imag] for h in field],
                      "expected_m_xy": [[q.real, q.imag] for q in expected],
                      "relative_errors_128_256": errors, "max_norm_defects": norm_defects})
    return {"status": "PASS_ORACLE_ONLY", "fullmag_backend_qualified": False,
            "phase_convention": "exp_plus_i_omega_t", "checks": checks,
            "bias_a_per_m": bias, "gamma0_m_per_a_s": gamma0,
            "samples_per_cycle": [128, 256], "measurement_cycles": 8,
            "burn_in_damping_time_constants": 20,
            "relative_error_limit": 2e-6, "norm_defect_limit": 1e-10,
            "time_domain_cases": cases,
            "source_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}


if __name__ == "__main__":
    print(json.dumps(diagnostic(), indent=2, allow_nan=False))
