"""Fixed Faraday-observable diagnostic, not calibrated voltage or a solver.

The retained reference uses exp(+i*omega*t). See the canonical 0951 note.
"""
import math
from numbers import Complex, Real


def faraday_emf_proxy(frequency_hz, normalized_inductance, *, reference_frequency_hz):
    """Return E/(omega_ref*M_ref*I) = -i*(f/f_ref)*T, dimensionless.

    E = -d(Phi)/dt, Phi = M_ref*T*I. Neither M_ref nor port polarity is
    calibrated by the paper's normalized Eq. 10. Passive inductive voltage
    has the opposite sign. This does not alter T, material parameters or FMR.
    """
    for name, value, strictly_positive in (("frequency_hz", frequency_hz, False),
                                          ("reference_frequency_hz", reference_frequency_hz, True)):
        if (isinstance(value, bool) or not isinstance(value, Real) or not math.isfinite(value)
                or value < 0 or strictly_positive and value == 0):
            raise ValueError(name + " must be a finite frequency in Hz within its domain")
    if isinstance(normalized_inductance, bool) or not isinstance(normalized_inductance, Complex):
        raise ValueError("normalized_inductance must be a finite complex number")
    value = complex(normalized_inductance)
    if not math.isfinite(value.real) or not math.isfinite(value.imag):
        raise ValueError("normalized_inductance must be finite")
    result = -1j * (float(frequency_hz) / float(reference_frequency_hz)) * value
    if not math.isfinite(result.real) or not math.isfinite(result.imag):
        raise ValueError("Faraday proxy overflowed")
    return result
