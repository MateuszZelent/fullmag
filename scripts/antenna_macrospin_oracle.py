"""Independent collinear-field LLG oracle for antenna trajectory qualification.

Validation support only; this module does not execute or qualify a backend.
Input impulse is integral H_z dt in A s/m, including bias and signed current.
The initial magnetization is a unit vector and gamma_mu0 is positive in m/(A s).
"""

from __future__ import annotations

import math
from collections.abc import Sequence


def _finite(value: float, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number")
    if not math.isfinite(value):
        raise ValueError(f"{name} must be finite")
    return float(value)


def macrospin_from_field_impulse(
    initial_m: Sequence[float],
    field_impulse_a_s_per_m: float,
    alpha: float,
    gamma_mu0: float = 2.211e5,
) -> tuple[float, float, float]:
    """Solve Gilbert LLG for H(t) parallel to +z, allowing signed H.

    With q = gamma_mu0 * integral(H_z dt)/(1+alpha**2), the equations
    separate as d(phi)/dq=1 and d(m_z)/dq=alpha*(1-m_z**2).
    No RK stages, field evaluators, or solver state are reused here.
    """
    if len(initial_m) != 3:
        raise ValueError("initial_m must have three components")
    x, y, z = (_finite(v, "initial_m") for v in initial_m)
    if abs(math.hypot(x, y, z) - 1.0) > 1e-12:
        raise ValueError("initial_m must be a unit vector")
    alpha = _finite(alpha, "alpha")
    gamma_mu0 = _finite(gamma_mu0, "gamma_mu0")
    impulse = _finite(field_impulse_a_s_per_m, "field_impulse_a_s_per_m")
    if alpha < 0.0 or gamma_mu0 <= 0.0:
        raise ValueError("alpha must be non-negative and gamma_mu0 positive")
    q = gamma_mu0 * impulse / (1.0 + alpha * alpha)
    if not math.isfinite(q):
        raise ValueError("field impulse exceeds the oracle range")
    transverse_initial = math.hypot(x, y)
    if transverse_initial == 0.0:
        return (0.0, 0.0, math.copysign(1.0, z))
    # asinh(z/r) equals atanh(z) for a unit vector, without a singularity
    # when the longitudinal component rounds to 1 but r is still nonzero.
    u = math.asinh(z / transverse_initial) + alpha * q
    decay = math.exp(-abs(u))
    transverse = 2.0 * decay / (1.0 + decay * decay)
    phi = math.atan2(y, x) + q
    return transverse * math.cos(phi), transverse * math.sin(phi), math.tanh(u)


def waveform_integral(waveform: dict, start_s: float, end_s: float) -> float:
    """Integrate a canonical waveform over its own clock, returning seconds.

    Callers subtract the physical stage origin for stage-local waveforms.
    Constant, sine, rectangular pulse and PWL use exact primitives. Sinc
    uses bounded, successively refined Simpson quadrature, independent of RK.
    """
    a = _finite(start_s, "start_s")
    b = _finite(end_s, "end_s")
    if b < a:
        raise ValueError("end_s must not precede start_s")
    kind = waveform.get("kind")
    if kind == "constant":
        return b - a
    if kind == "sinusoidal":
        frequency = _finite(waveform["frequency_hz"], "frequency_hz")
        phase = _finite(waveform.get("phase_rad", 0.0), "phase_rad")
        offset = _finite(waveform.get("offset", 0.0), "offset")
        if frequency <= 0:
            raise ValueError("frequency_hz must be positive")
        omega = math.tau * frequency
        # Cosine-difference identity avoids subtracting near-equal cosines.
        return offset * (b - a) + 2 * math.sin(omega * (a + b) / 2 + phase) * math.sin(omega * (b - a) / 2) / omega
    if kind == "pulse":
        on = _finite(waveform["t_on"], "t_on")
        off = _finite(waveform["t_off"], "t_off")
        if off <= on:
            raise ValueError("t_off_s must exceed t_on_s")
        return max(0.0, min(b, off) - max(a, on))
    if kind == "piecewise_linear":
        points = [(_finite(t, "point time"), _finite(v, "point value")) for t, v in waveform["points"]]
        if len(points) < 2 or any(t1 <= t0 for (t0, _), (t1, _) in zip(points, points[1:])):
            raise ValueError("PWL requires at least two strictly increasing times")
        result = points[0][1] * max(0.0, min(b, points[0][0]) - a)
        result += points[-1][1] * max(0.0, b - max(a, points[-1][0]))
        for (t0, v0), (t1, v1) in zip(points, points[1:]):
            left, right = max(a, t0), min(b, t1)
            if right > left:
                result += (right - left) * (v0 + (v1 - v0) * ((left + right) / 2 - t0) / (t1 - t0))
        return result
    if kind == "sinc_pulse":
        cutoff = _finite(waveform["cutoff_hz"], "cutoff_hz")
        center = _finite(waveform.get("t0", 0.0), "t0")
        amplitude = _finite(waveform.get("amplitude", 1.0), "amplitude")
        if cutoff <= 0 or center < 0:
            raise ValueError("cutoff must be positive and t0_s non-negative")
        if cutoff * (b - a) > 128:
            raise ValueError("sinc oracle interval exceeds 128 cycles")
        if a == b:
            return 0.0
        def value(t: float) -> float:
            x = math.tau * cutoff * (t - center)
            return math.sin(x) / x if x != 0 else 1.0
        def simpson(n: int) -> float:
            step = (b - a) / n
            return step / 3 * math.fsum(
                (1 if i in (0, n) else 4 if i % 2 else 2) * value(a + i * step)
                for i in range(n + 1)
            )
        n = max(64, 2 * math.ceil(16 * cutoff * (b - a)))
        previous = simpson(n)
        while n < 262144:
            n *= 2
            current = simpson(n)
            if abs(current - previous) <= 1e-12 * (b - a):
                return amplitude * current
            previous = current
        raise ValueError("sinc oracle quadrature did not converge")
    raise ValueError(f"unsupported waveform: {kind!r}")


def compare_collinear_trajectory(
    samples: Sequence[dict], *, initial_m: Sequence[float], alpha: float,
    waveform: dict, basis_hz_per_a: float, peak_current_a: float,
    bias_hz_a_per_m: float, start_time_s: float, stage_start_time_s: float,
    time_origin: str, vector_tolerance: float, gamma_mu0: float = 2.211e5,
) -> dict:
    """Compare recorded time_s/m samples without trusting reported errors.

    The fixture must have only uniform collinear Zeeman fields, no exchange,
    demag, anisotropy or direct torques. This function checks the numerical
    samples; backend identity and actual execution require separate evidence.
    """
    if not samples:
        raise ValueError("trajectory must contain samples")
    start = _finite(start_time_s, "start_time_s")
    stage = _finite(stage_start_time_s, "stage_start_time_s")
    if start < stage or stage < 0:
        raise ValueError("start time must be at or after a non-negative stage start")
    if time_origin not in ("absolute", "stage_local"):
        raise ValueError("unsupported time_origin")
    origin = stage if time_origin == "stage_local" else 0.0
    amplitude = _finite(basis_hz_per_a, "basis_hz_per_a") * _finite(peak_current_a, "peak_current_a")
    bias = _finite(bias_hz_a_per_m, "bias_hz_a_per_m")
    tolerance = _finite(vector_tolerance, "vector_tolerance")
    if tolerance <= 0:
        raise ValueError("vector_tolerance must be positive")
    previous = None
    maximum_error = 0.0
    maximum_norm_defect = 0.0
    for index, sample in enumerate(samples):
        time = _finite(sample["time_s"], "time_s")
        if time < start or (previous is not None and time <= previous):
            raise ValueError("sample times must increase strictly from start_time_s")
        measured = sample["m"]
        if len(measured) != 3:
            raise ValueError("sample m must have three components")
        measured = tuple(_finite(v, "sample m") for v in measured)
        impulse = bias * (time - start) + amplitude * waveform_integral(waveform, start - origin, time - origin)
        expected = macrospin_from_field_impulse(initial_m, impulse, alpha, gamma_mu0)
        error = math.dist(measured, expected)
        if error > tolerance:
            raise ValueError(f"sample {index} at {time} s: vector error {error} exceeds {tolerance}")
        maximum_error = max(maximum_error, error)
        maximum_norm_defect = max(maximum_norm_defect, abs(math.hypot(*measured) - 1))
        previous = time
    if previous <= start:
        raise ValueError("trajectory must advance beyond start_time_s")
    return {"sample_count": len(samples), "max_vector_error": maximum_error,
            "max_norm_defect": maximum_norm_defect, "final_time_s": previous}
