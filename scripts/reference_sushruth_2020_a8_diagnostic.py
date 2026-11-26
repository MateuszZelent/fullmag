"""Algebraic A8/A5 diagnostics; preserve the existing Eq1 model and all saved data.

See 0951-sushruth-2020-forward-volume-reference.md. These diagnostics are not a
solver, an accepted field correction or a qualification of any backend.
"""
from reference_sushruth_2020_response import _number


def _frequency_scale(alpha,mu0_h_eff_t,gamma_hz_per_t):
    damping=_number('alpha',alpha,minimum=0)
    field=_number('mu0_h_eff_t',mu0_h_eff_t,minimum=0,strict=True)
    gamma=_number('gamma_hz_per_t',gamma_hz_per_t,minimum=0,strict=True)
    scale=_number('reference_frequency_hz',gamma*field,minimum=0,strict=True)
    return damping,scale


def a8_numerator_factor(frequency_hz,*,alpha,mu0_h_eff_t=.25,gamma_hz_per_t=30e9):
    """Published first-order A8 divided by Eq1; independent of wave vector."""
    frequency=_number('frequency_hz',frequency_hz)
    damping,scale=_frequency_scale(alpha,mu0_h_eff_t,gamma_hz_per_t)
    imaginary=_number('numerator_imaginary_factor',damping*(frequency/scale))
    return complex(1.,imaginary)


def uniform_free_pole_hz(*,alpha,mu0_h_eff_t=.25,gamma_hz_per_t=30e9):
    """Exact free pole of the k=0 A5 matrix, not a transmission peak."""
    damping,scale=_frequency_scale(alpha,mu0_h_eff_t,gamma_hz_per_t)
    denominator=_number('pole_denominator',1+damping*damping,minimum=0,strict=True)
    real=_number('pole_real_frequency_hz',scale/denominator,minimum=0,strict=True)
    imaginary=_number('pole_imaginary_frequency_hz',real*damping,minimum=0)
    return complex(real,imaginary)


def uniform_susceptibility(frequency_hz,*,alpha,mu0_h_eff_t=.25,mu0_ms_t=.89,gamma_hz_per_t=30e9):
    """Exact linear k=0 A5 response (Mx/Hx, My/Hx), using exp(+i omega t)."""
    frequency=_number('frequency_hz',frequency_hz)
    damping,scale=_frequency_scale(alpha,mu0_h_eff_t,gamma_hz_per_t)
    if damping==0:
        raise ValueError('alpha must be positive for a steady-state response')
    magnetization=_number('mu0_ms_t',mu0_ms_t,minimum=0,strict=True)
    strength=_number('static_susceptibility',magnetization/mu0_h_eff_t,minimum=0,strict=True)
    z=_number('normalized_frequency',frequency/scale)
    az=_number('normalized_damping',damping*z)
    denominator=complex(_number('determinant_real',1-az*az-z*z),
                        _number('determinant_imaginary',2*az))
    if denominator==0:
        raise ValueError('steady-state response determinant is singular')
    values=(strength*complex(1,az)/denominator,strength*complex(0,-z)/denominator)
    for value in values:
        _number('response_real',value.real)
        _number('response_imaginary',value.imag)
    return values
