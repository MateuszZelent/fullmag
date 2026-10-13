"""Analytical n=0 references for an open or finite Dirichlet thin film.

The finite reference is a continuum Green-function diagnostic for a uniform
film of thickness ``t`` between symmetric scalar-potential Dirichlet planes at
``z = +/- (d + t/2)``.  It is deliberately separate from the FEM solver and
does not claim mesh, airbox, or COMSOL qualification.
"""
from __future__ import annotations

import math


TWO_PI = 2.0 * math.pi


def _finite_real(value: object, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite real number")
    try:
        value = float(value)
    except (OverflowError, ValueError) as error:
        raise ValueError(f"{name} must be a finite real number") from error
    if not math.isfinite(value):
        raise ValueError(f"{name} must be a finite real number")
    return value


def _positive(value: object, name: str) -> float:
    value = _finite_real(value, name)
    if value <= 0.0:
        raise ValueError(f"{name} must be positive")
    return value


def _geometry(geometry: object) -> str:
    if not isinstance(geometry, str):
        raise ValueError(f"unsupported DE/BV geometry: {geometry!r}")
    if geometry in {"DE", "damon_eshbach"}:
        return "damon_eshbach"
    if geometry in {"BV", "backward_volume"}:
        return "backward_volume"
    raise ValueError(f"unsupported DE/BV geometry: {geometry!r}")


def _one_minus_exp_neg(value: float) -> float:
    """Return ``1 - exp(-value)`` without losing small positive values."""
    return -math.expm1(-value)


def _small_u_open_parallel(u: float) -> float:
    """Return ``P = 1 - (1 - exp(-u))/u`` without subtractive loss."""
    return u * (
        0.5
        + u * (
            -1.0 / 6.0
            + u * (
                1.0 / 24.0
                + u * (-1.0 / 120.0 + u * (1.0 / 720.0 + u * (-1.0 / 5040.0 + u / 40320.0)))
            )
        )
    )


def _small_u_parallel_boundary_term(u: float) -> float:
    """Return ``2P-uF`` without cancellation for small ``u``."""
    return u * u * (
        1.0 / 6.0
        + u * (-1.0 / 12.0 + u * (1.0 / 40.0 + u * (-1.0 / 180.0 + u / 1008.0)))
    )


def _zero_q_normal_factor(thickness: float, padding: float) -> float:
    """Return ``2d/(t+2d)`` without forming an overflowing ``2d``."""
    if padding >= thickness:
        return 1.0 / (1.0 + 0.5 * (thickness / padding))
    ratio = padding / thickness
    return (2.0 * ratio) / (1.0 + 2.0 * ratio)


def open_film_n0_demag_factors(
    *, k_rad_m: float, thickness_m: float
) -> tuple[float, float]:
    """Return ``(N_parallel, N_z)`` for the open-film uniform n=0 mode."""
    k = abs(_finite_real(k_rad_m, "k_rad_m"))
    thickness = _positive(thickness_m, "thickness_m")
    kd = k * thickness
    if not math.isfinite(kd):
        raise ValueError("|k|*thickness_m must be finite")
    if kd == 0.0:
        return 0.0, 1.0
    if kd < 1.0e-4:
        parallel = _small_u_open_parallel(kd)
    else:
        parallel = 1.0 + math.expm1(-kd) / kd
    return parallel, 1.0 - parallel


def finite_dirichlet_n0_demag_factors(
    *, k_rad_m: float, thickness_m: float, air_padding_each_side_m: float
) -> tuple[float, float]:
    """Return finite-Dirichlet ``(N_parallel, N_z)`` for a uniform n=0 mode.

    ``air_padding_each_side_m`` is the resolved distance from either film face
    to the corresponding scalar-potential Dirichlet plane.  The implementation
    uses scaled exponential forms of the Green-function result so large
    ``|k|d`` does not overflow in ``sinh``/``cosh``.
    """
    k = abs(_finite_real(k_rad_m, "k_rad_m"))
    thickness = _positive(thickness_m, "thickness_m")
    padding = _positive(air_padding_each_side_m, "air_padding_each_side_m")
    if k == 0.0:
        return 0.0, _zero_q_normal_factor(thickness, padding)

    a = k * thickness
    b = k * padding
    c = b + 0.5 * a
    if not all(math.isfinite(value) for value in (a, b, c)):
        raise ValueError("finite-airbox dimensionless products must be finite")
    # If multiplication underflows below the representable range, the
    # continuous k -> 0 limit is the only meaningful representable value.
    if a == 0.0 or c == 0.0:
        return 0.0, _zero_q_normal_factor(thickness, padding)

    # Let F=(1-exp(-a))/a, P=1-F, and E=exp(-2b).  The direct expression
    # for N_parallel is one minus a ratio close to one, and the previous
    # logarithmic form still lost the small difference between its two log
    # terms.  The equivalent expression below keeps the small factors
    # separate and evaluates the two remaining Taylor series explicitly.
    if a < 1.0e-3:
        p = _small_u_open_parallel(a)
        boundary_term = _small_u_parallel_boundary_term(a)
        film_factor = 1.0 - p
    else:
        film_factor = _one_minus_exp_neg(a) / a
        p = 1.0 - film_factor
        boundary_term = 2.0 * p - a * film_factor
    exp_boundary = math.exp(-2.0 * b)
    one_minus_exp_boundary = _one_minus_exp_neg(2.0 * b)
    denominator_parallel = 1.0 + exp_boundary * math.exp(-a)
    numerator_parallel = p * one_minus_exp_boundary + exp_boundary * boundary_term
    n_parallel = numerator_parallel / denominator_parallel

    # 2 sinh(b) sinh(a/2) / (a sinh(c)), again expressed with decaying
    # exponentials.  This is the normal-component factor obtained from the
    # two surface charges of a uniform m_z mode.
    denominator = _one_minus_exp_neg(2.0 * b + a)
    if denominator == 0.0:
        raise ValueError("finite-airbox Green-function denominator underflowed")
    # The e^{-a/2} and e^{a/2} factors from the two sinh ratios cancel here
    # as well.
    n_z = film_factor * one_minus_exp_boundary / denominator

    # Roundoff can put a physically bounded factor a few ulps outside its
    # interval.  Reject a true loss of the Green-function bounds rather than
    # hiding it with an unconditional clamp.
    for name, value in (("N_parallel", n_parallel), ("N_z", n_z)):
        if not math.isfinite(value) or value < -1.0e-12 or value > 1.0 + 1.0e-12:
            raise ValueError(f"finite-airbox {name} is outside [0, 1]")
    return min(1.0, max(0.0, n_parallel)), min(1.0, max(0.0, n_z))


def _frequency_from_demag_factors(
    *,
    geometry: object,
    k_rad_m: float,
    n_parallel: float,
    n_z: float,
    bias_field_a_per_m: float,
    film_thickness_m: float,
    exchange_stiffness_j_per_m: float,
    saturation_magnetisation_a_per_m: float,
    gamma0_rad_s_per_a_m: float,
    mu0_t_m_a: float,
) -> float:
    geometry = _geometry(geometry)
    k = abs(_finite_real(k_rad_m, "k_rad_m"))
    bias = _finite_real(bias_field_a_per_m, "bias_field_a_per_m")
    thickness = _positive(film_thickness_m, "film_thickness_m")
    exchange = _positive(exchange_stiffness_j_per_m, "exchange_stiffness_j_per_m")
    saturation = _positive(
        saturation_magnetisation_a_per_m, "saturation_magnetisation_a_per_m"
    )
    gamma0 = _positive(gamma0_rad_s_per_a_m, "gamma0_rad_s_per_a_m")
    mu0 = _positive(mu0_t_m_a, "mu0_t_m_a")
    kd = k * thickness
    if not math.isfinite(kd):
        raise ValueError("|k|*thickness_m must be finite")
    exchange_field = 2.0 * exchange * k * k / (mu0 * saturation)
    if not math.isfinite(exchange_field):
        raise ValueError("exchange field must be finite")
    common = bias + exchange_field
    if geometry == "damon_eshbach":
        factor_a = common + saturation * n_parallel
        factor_b = common + saturation * n_z
    else:
        factor_a = common
        factor_b = common + saturation * n_z
    if factor_a <= 0.0 or factor_b <= 0.0:
        raise ValueError("finite-airbox n=0 frequency factors must be positive")
    frequency = gamma0 * math.sqrt(factor_a * factor_b) / TWO_PI
    if not math.isfinite(frequency) or frequency <= 0.0:
        raise ValueError("finite-airbox n=0 frequency must be finite and positive")
    return frequency


def open_film_n0_frequency_hz(
    *,
    k_rad_m: float,
    geometry: str,
    bias_field_a_per_m: float,
    film_thickness_m: float,
    exchange_stiffness_j_per_m: float,
    saturation_magnetisation_a_per_m: float,
    gamma0_rad_s_per_a_m: float,
    mu0_t_m_a: float,
) -> float:
    """Return the resolved-parameter open-film n=0 frequency in Hz."""
    n_parallel, n_z = open_film_n0_demag_factors(
        k_rad_m=k_rad_m, thickness_m=film_thickness_m
    )
    return _frequency_from_demag_factors(
        geometry=geometry,
        k_rad_m=k_rad_m,
        n_parallel=n_parallel,
        n_z=n_z,
        bias_field_a_per_m=bias_field_a_per_m,
        film_thickness_m=film_thickness_m,
        exchange_stiffness_j_per_m=exchange_stiffness_j_per_m,
        saturation_magnetisation_a_per_m=saturation_magnetisation_a_per_m,
        gamma0_rad_s_per_a_m=gamma0_rad_s_per_a_m,
        mu0_t_m_a=mu0_t_m_a,
    )


def finite_dirichlet_n0_frequency_hz(
    *,
    k_rad_m: float,
    geometry: str,
    bias_field_a_per_m: float,
    film_thickness_m: float,
    air_padding_each_side_m: float,
    exchange_stiffness_j_per_m: float,
    saturation_magnetisation_a_per_m: float,
    gamma0_rad_s_per_a_m: float,
    mu0_t_m_a: float,
) -> float:
    """Return the resolved-parameter finite-Dirichlet n=0 frequency in Hz."""
    n_parallel, n_z = finite_dirichlet_n0_demag_factors(
        k_rad_m=k_rad_m,
        thickness_m=film_thickness_m,
        air_padding_each_side_m=air_padding_each_side_m,
    )
    return _frequency_from_demag_factors(
        geometry=geometry,
        k_rad_m=k_rad_m,
        n_parallel=n_parallel,
        n_z=n_z,
        bias_field_a_per_m=bias_field_a_per_m,
        film_thickness_m=film_thickness_m,
        exchange_stiffness_j_per_m=exchange_stiffness_j_per_m,
        saturation_magnetisation_a_per_m=saturation_magnetisation_a_per_m,
        gamma0_rad_s_per_a_m=gamma0_rad_s_per_a_m,
        mu0_t_m_a=mu0_t_m_a,
    )


def n0_reference_frequencies(
    *,
    k_rad_m: float,
    geometry: str,
    bias_field_a_per_m: float,
    film_thickness_m: float,
    air_padding_each_side_m: float,
    exchange_stiffness_j_per_m: float,
    saturation_magnetisation_a_per_m: float,
    gamma0_rad_s_per_a_m: float,
    mu0_t_m_a: float,
) -> dict[str, object]:
    """Return both n=0 references and their demag factors for one k point."""
    open_parallel, open_z = open_film_n0_demag_factors(
        k_rad_m=k_rad_m, thickness_m=film_thickness_m
    )
    finite_parallel, finite_z = finite_dirichlet_n0_demag_factors(
        k_rad_m=k_rad_m,
        thickness_m=film_thickness_m,
        air_padding_each_side_m=air_padding_each_side_m,
    )
    common = dict(
        geometry=geometry,
        k_rad_m=k_rad_m,
        bias_field_a_per_m=bias_field_a_per_m,
        film_thickness_m=film_thickness_m,
        exchange_stiffness_j_per_m=exchange_stiffness_j_per_m,
        saturation_magnetisation_a_per_m=saturation_magnetisation_a_per_m,
        gamma0_rad_s_per_a_m=gamma0_rad_s_per_a_m,
        mu0_t_m_a=mu0_t_m_a,
    )
    return {
        "open_film_n0_frequency_hz": open_film_n0_frequency_hz(**common),
        "finite_dirichlet_n0_frequency_hz": finite_dirichlet_n0_frequency_hz(
            air_padding_each_side_m=air_padding_each_side_m, **common
        ),
        "open_film_n0_demag_factors": {
            "n_parallel": open_parallel,
            "n_z": open_z,
        },
        "finite_dirichlet_n0_demag_factors": {
            "n_parallel": finite_parallel,
            "n_z": finite_z,
        },
    }
