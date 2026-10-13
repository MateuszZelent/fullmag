import numpy as np
import pytest
from audit_de_bv_potential_fields import gradient_diagnostics


def fixture():
    nodes = np.array([[0., 0., 0.], [2., 0., 0.], [0., 3., 0.], [0., 0., 4.]])
    tetra = np.array([[0, 1, 2, 3]])
    gradient = np.array([1+2j, -3+1j, 4-2j])
    phi = nodes @ gradient + 2-1j
    return nodes, tetra, phi, -gradient[None, :]


def test_complex_affine_phi_has_exact_cartesian_demag_gradient():
    result = gradient_diagnostics(*fixture())
    assert result["volume_weighted_relative_l2"] < 1e-15
    assert result["relative_max"] < 1e-15


def test_wrong_demag_sign_is_detected_and_global_scale_preserved():
    values = list(fixture())
    values[3] *= -1
    assert gradient_diagnostics(*values)["volume_weighted_relative_l2"] == pytest.approx(2.)
    values[2] *= 1e50j
    values[3] *= 1e50j
    assert gradient_diagnostics(*values)["volume_weighted_relative_l2"] == pytest.approx(2.)


@pytest.mark.parametrize("kind", ["nonfinite", "degenerate", "bad_indices", "wrong_count"])
def test_invalid_potential_context_is_rejected(kind):
    values = list(fixture())
    if kind == "nonfinite": values[2][0] = np.nan
    if kind == "degenerate": values[0][3] = values[0][0]
    if kind == "bad_indices": values[1][0, 3] = 99
    if kind == "wrong_count": values[3] = np.zeros((2, 3), complex)
    with pytest.raises(ValueError): gradient_diagnostics(*values)
