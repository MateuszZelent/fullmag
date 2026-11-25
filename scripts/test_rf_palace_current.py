"""Verify the interior-probe quadrature for harmonic copper terminal current."""
import numpy as np
import pytest
from scipy.constants import epsilon_0

from rf_cpw_reference import locate_points, make_case, STRIP_NAMES
from rf_palace_current import terminal_quadrature, integrate_terminal_currents


@pytest.mark.parametrize("cpw", [1,2])
def test_terminal_integrates_a_complex_quadratic_in_both_planes(cpw):
    case = make_case(cpw)
    q = terminal_quadrature(case)
    points = q["xyz_m"]
    x,y,z = points.T
    assert np.all(case.material_id[locate_points(case,points)] == 1)
    assert np.all((x>case.axes_m[0][0])&(x<case.axes_m[0][-1]))
    u,v,w = x/1e-6,y/750e-9,z/10e-9
    e_x = (1+u+u**2+v**2+w**2)*(1+2j)
    measured = integrate_terminal_currents(q["terminal_index"],q["weight_m2"],e_x,
                                           5.88e7,1.0,22.12e9)
    for end,u_face in (("input",-1),("output",1)):
        for name,(a,b) in zip(STRIP_NAMES,case.strips_m):
            mean_y_sq = (a*a + a*b + b*b) / (3*(750e-9)**2)
            integral = (b-a)*10e-9*(1+u_face+u_face**2+mean_y_sq+1/3)*(1+2j)
            expected = (5.88e7+2j*np.pi*22.12e9*epsilon_0) * integral
            np.testing.assert_allclose(measured[f"{name}_{end}"]["total_a"],
                                       [expected.real,expected.imag],rtol=3e-14)



@pytest.mark.parametrize("cpw,width_nm", [(1, 622.5), (2, 525)])
def test_center_gap_current_integrates_uniform_conduction_and_preserves_probe_side(cpw, width_nm):
    from rf_palace_current import center_quadrature, integrate_center_current
    case = make_case(cpw)
    q = center_quadrature(case)
    p = q["xyz_m"]
    assert np.all((p[:, 0] > 0) & (p[:, 0] < case.axes_m[0][-1]))
    assert np.all(case.material_id[locate_points(case,p)] == 1)
    # E_x is quadratic, with a uniform complex trace on the central plane.
    x = p[:, 0] / 1e-6
    e_x = (2-3j) * (1 - 7*x + 8*x*x)
    measured = integrate_center_current(q, e_x, 5.88e7)
    assert measured["trace_x"] == "+"
    assert measured["gap_side_band_width_m"] == 20e-9
    for name, (lo, hi) in zip(STRIP_NAMES,case.strips_m,strict=True):
        expected = 5.88e7 * (2-3j) * (hi-lo) * 10e-9
        np.testing.assert_allclose(measured["conductor_currents_a"][name],
                                   [expected.real,expected.imag],rtol=3e-14)
    assert measured["ground_gap_fraction"] == pytest.approx(20/width_nm,rel=1e-12)
