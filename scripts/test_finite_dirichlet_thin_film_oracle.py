"""Independent mathematical checks for the finite-airbox n=0 reference."""
from __future__ import annotations

import math
from decimal import Decimal, localcontext

import numpy as np
import pytest

from finite_dirichlet_thin_film_oracle import (
    finite_dirichlet_n0_demag_factors,
    finite_dirichlet_n0_frequency_hz,
    n0_reference_frequencies,
    open_film_n0_demag_factors,
)


T = 10e-9
D = 2e-6
MU0 = 4.0 * math.pi * 1e-7
COMMON = {
    "geometry": "damon_eshbach",
    "bias_field_a_per_m": 0.1 / MU0,
    "film_thickness_m": T,
    "air_padding_each_side_m": D,
    "exchange_stiffness_j_per_m": 13e-12,
    "saturation_magnetisation_a_per_m": 8e5,
    "gamma0_rad_s_per_a_m": 2.211e5,
    "mu0_t_m_a": MU0,
}


def _dirichlet_green(z: float, z_prime: float, *, k: float, thickness: float, padding: float) -> float:
    """Independent Green function for (d²/dz²-k²) with phi=0 at both planes."""
    half = thickness / 2.0
    outer = padding + half
    lower, upper = sorted((z, z_prime))
    return (
        -math.sinh(k * (lower + outer))
        * math.sinh(k * (outer - upper))
        / (k * math.sinh(2.0 * k * outer))
    )


def _decimal_sinh(value: Decimal) -> Decimal:
    return (value.exp() - (-value).exp()) / Decimal(2)


def _decimal_cosh(value: Decimal) -> Decimal:
    return (value.exp() + (-value).exp()) / Decimal(2)


def test_small_k_parallel_factor_matches_decimal_high_precision():
    """The finite factor remains accurate when its result is much smaller than one."""
    for q_text in ("0.01", "1", "100", "10000"):
        with localcontext() as context:
            context.prec = 70
            q = Decimal(q_text)
            thickness = Decimal("1e-8")
            padding = Decimal("2e-6")
            a = q * thickness
            b = q * padding
            reference = Decimal(1) - _decimal_cosh(b) * _decimal_sinh(a / 2) / (
                (a / 2) * _decimal_cosh(b + a / 2)
            )
        actual, _ = finite_dirichlet_n0_demag_factors(
            k_rad_m=float(q_text), thickness_m=float(thickness), air_padding_each_side_m=float(padding)
        )
        assert actual == pytest.approx(float(reference), rel=1e-12, abs=1e-30)


def test_gamma_limit_and_open_film_limit():
    n_parallel, n_z = finite_dirichlet_n0_demag_factors(
        k_rad_m=0.0, thickness_m=T, air_padding_each_side_m=D
    )
    assert n_parallel == 0.0
    assert n_z == pytest.approx(2.0 * D / (T + 2.0 * D), rel=0.0, abs=1e-15)

    finite = finite_dirichlet_n0_demag_factors(
        k_rad_m=2e6, thickness_m=T, air_padding_each_side_m=1e-3
    )
    opened = open_film_n0_demag_factors(k_rad_m=2e6, thickness_m=T)
    assert finite == pytest.approx(opened, rel=1e-12, abs=1e-14)


@pytest.mark.parametrize("k", [0.0, 5e-324])
def test_zero_q_ratio_stays_finite_for_huge_padding(k):
    n_parallel, n_z = finite_dirichlet_n0_demag_factors(
        k_rad_m=k, thickness_m=1e-8, air_padding_each_side_m=1e308
    )
    assert n_parallel == 0.0
    assert math.isfinite(n_z)
    assert 0.0 <= n_z <= 1.0
    assert n_z == pytest.approx(1.0, rel=0.0, abs=1e-15)


def test_surface_and_volume_green_quadrature_reproduce_both_factors():
    """Use an independent Green-function quadrature, not the closed forms."""
    k = 2e6
    nodes, weights = np.polynomial.legendre.leggauss(384)
    z = (nodes * T / 2.0).astype(float)
    w = weights * T / 2.0
    volume_integral = 0.0
    for zi, wi in zip(z, w):
        for zj, wj in zip(z, w):
            volume_integral += wi * wj * _dirichlet_green(
                float(zi), float(zj), k=k, thickness=T, padding=D
            )
    # H_parallel = k² integral(G) M_parallel; N_parallel=-<H>/M.
    n_parallel_quadrature = -k * k * volume_integral / T

    bottom, top = -T / 2.0, T / 2.0
    # The normal mode is represented by the two surface charges, hence the
    # difference of the bottom-to-top and bottom-to-bottom Green values.
    n_z_surface = 2.0 / T * (
        _dirichlet_green(bottom, top, k=k, thickness=T, padding=D)
        - _dirichlet_green(bottom, bottom, k=k, thickness=T, padding=D)
    )
    expected = finite_dirichlet_n0_demag_factors(
        k_rad_m=k, thickness_m=T, air_padding_each_side_m=D
    )
    assert n_parallel_quadrature == pytest.approx(expected[0], rel=1e-7, abs=1e-12)
    assert n_z_surface == pytest.approx(expected[1], rel=1e-12, abs=1e-14)


def test_signed_k_and_frequency_are_even_for_symmetric_airbox():
    positive = n0_reference_frequencies(k_rad_m=2e6, **COMMON)
    negative = n0_reference_frequencies(k_rad_m=-2e6, **COMMON)
    assert negative == positive
    assert finite_dirichlet_n0_frequency_hz(k_rad_m=0.0, **COMMON) == pytest.approx(
        9.2992496970684e9, rel=1e-12
    )


def test_scaled_hyperbolic_evaluation_does_not_overflow():
    factors = finite_dirichlet_n0_demag_factors(
        k_rad_m=1e12, thickness_m=T, air_padding_each_side_m=D
    )
    assert factors == pytest.approx(open_film_n0_demag_factors(k_rad_m=1e12, thickness_m=T))
    result = n0_reference_frequencies(k_rad_m=1e12, **COMMON)
    assert math.isfinite(result["finite_dirichlet_n0_frequency_hz"])


def test_invalid_geometry_is_rejected_as_value_error():
    for geometry in ([], {}, ["DE"]):
        with pytest.raises(ValueError, match="unsupported DE/BV geometry"):
            finite_dirichlet_n0_frequency_hz(
                k_rad_m=2e6, **{**COMMON, "geometry": geometry}
            )


@pytest.mark.parametrize(
    "kwargs",
    [
        {"thickness_m": 0.0, "air_padding_each_side_m": D},
        {"thickness_m": T, "air_padding_each_side_m": 0.0},
        {"thickness_m": T, "air_padding_each_side_m": float("nan")},
    ],
)
def test_missing_or_invalid_resolved_padding_is_rejected(kwargs):
    with pytest.raises(ValueError):
        finite_dirichlet_n0_demag_factors(k_rad_m=2e6, **kwargs)
