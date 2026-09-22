import numpy as np
import pytest
from de_film_demag_reference import film_response


def solve(k=0, **kwargs):
    return film_response(k_rad_per_m=k, thickness_m=10e-9, padding_m=2e-6, **kwargs)


def test_gamma_has_exact_finite_airbox_factor_and_sign():
    r = solve()
    assert r['mean_hz_a_per_m'].real == pytest.approx(-4000/4010, abs=1e-10)
    assert r['mean_hy_a_per_m'] == 0
    assert r['relative_residual'] < 1e-10
    assert r['potential_a'][0] == r['potential_a'][-1] == 0
    assert solve(my=1, mz=0)['energy_j_per_m2'] == 0


def test_nonzero_k_energy_reciprocity_and_potential_phase():
    r = solve(2e6, my=1, mz=1j)
    neg = solve(-2e6, my=1, mz=-1j)
    assert r['energy_j_per_m2'] > 0
    assert r['energy_j_per_m2'] == pytest.approx(r['work_energy_j_per_m2'], rel=1e-9)
    assert r['relative_residual'] < 1e-10
    np.testing.assert_allclose(r['potential_a'].conjugate(), neg['potential_a'], atol=1e-20)
    longitudinal = solve(2e6, my=1, mz=0)
    assert longitudinal['mean_hy_a_per_m'].real < 0
    assert np.max(np.abs(longitudinal['potential_a'].real)) == 0


def test_converges_to_open_film_factors_without_using_them_in_solve():
    q = 2e6 * 10e-9
    nz = -np.expm1(-q)/q
    errors = []
    for n in (128, 256, 512):
        r = film_response(k_rad_per_m=2e6, thickness_m=10e-9, padding_m=20e-6,
                          air_cells=n, layers=24)
        errors.append(abs(-r['mean_hz_a_per_m'].real-nz))
    assert errors[2] < errors[1] < errors[0]
    assert errors[-1] < 1e-4


@pytest.mark.parametrize('kwargs', [{'layers': 0}, {'air_cells': True}, {'my': float('nan')}])
def test_invalid_inputs_are_rejected(kwargs):
    with pytest.raises(ValueError):
        solve(**kwargs)
