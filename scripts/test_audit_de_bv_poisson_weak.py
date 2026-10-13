import numpy as np
import pytest
from audit_de_bv_poisson_weak import weak_poisson_residual


def fixture():
    nodes = np.array([[0., 0., 0.], [2., 0., 0.], [0., 3., 0.], [0., 0., 4.]])
    M = np.array([1+2j, -3+1j, 4-2j])
    phi = nodes @ M + 2-1j
    return [nodes, np.array([[0, 1, 2, 3]]), np.array([1]), phi,
            np.broadcast_to(M/8., (4, 3)).copy(), 8., [], [], np.zeros(3), np.array([], dtype=int)]


def test_affine_complex_phi_satisfies_independent_weak_form():
    result = weak_poisson_residual(*fixture())
    assert result["relative_weak_residual"] < 1e-15
    assert result["wrong_source_sign_relative"] == pytest.approx(1.)
    assert result["free_phi_class_count"] == 4


def test_wrong_source_sign_and_material_scale_are_detected():
    values = fixture(); values[4] *= -1
    assert weak_poisson_residual(*values)["relative_weak_residual"] == pytest.approx(1.)
    values = fixture(); values[5] *= 2
    assert weak_poisson_residual(*values)["relative_weak_residual"] == pytest.approx(1/3)


def test_complex_global_amplitude_and_additive_gauge_do_not_change_weak_form():
    values = fixture(); values[3] *= 1e30j; values[4] *= 1e30j
    assert weak_poisson_residual(*values)["relative_weak_residual"] < 1e-14
    values = fixture(); values[3] += 100j
    assert weak_poisson_residual(*values)["relative_weak_residual"] < 1e-14


@pytest.mark.parametrize("kind", ["bad_ms", "nonfinite", "degenerate", "bad_marker", "all_fixed"])
def test_invalid_poisson_context_fails_closed(kind):
    values = fixture()
    if kind == "bad_ms": values[5] = -1.
    if kind == "nonfinite": values[3][0] = np.nan
    if kind == "degenerate": values[0][3] = values[0][0]
    if kind == "bad_marker": values[2][0] = 2
    if kind == "all_fixed": values[-1] = np.arange(4)
    with pytest.raises(ValueError): weak_poisson_residual(*values)


def test_magnetization_only_normalization_breaks_coupled_poisson_pair():
    values = fixture()
    values[4] /= 1.4
    result = weak_poisson_residual(*values)
    assert result["relative_weak_residual"] == pytest.approx(1/6)
    assert result["diagnostic_source_scale_fit_real"] == pytest.approx(1.4)
    assert abs(result["diagnostic_source_scale_fit_imag"]) < 1e-14
    assert result["diagnostic_after_fit_relative_defect"] < 1e-14
    assert result["source_scale_fit_applied_to_data"] is False
    # A common scale preserves the coupled field; the publication must do this.
    values[3] /= 1.4
    assert weak_poisson_residual(*values)["relative_weak_residual"] < 1e-14


def test_complex_floquet_adjoint_and_dirichlet_against_explicit_matrix():
    values = fixture()
    values[3] = np.array([2+3j, -1+4j, 5-2j, -3+1j])
    values[4] = np.array([[1+2j, 3-1j, 2j], [2-1j, -2j, 1],
                          [3, 1+1j, -2], [-1j, 4, 2-3j]]) / 8.
    values[6] = [{"node_a": 0, "node_b": 1, "pair_id": "x"}]
    values[7] = [{"pair_id": "x", "translation": [2., 0., 0.], "tolerance_m": 1e-12}]
    values[8] = np.array([.37, 0., 0.])
    values[9] = np.array([3])
    # Explicit analytic tetra gradients and prolongation, independent of graph assembly.
    gradients = np.array([[-.5, -1/3, -.25], [.5, 0., 0.],
                          [0., 1/3, 0.], [0., 0., .25]])
    C = np.zeros((4, 3), complex)
    C[0, 0] = 1; C[1, 0] = np.exp(-.74j)
    C[2, 1] = 1; C[3, 2] = 1
    lhs = (C.conj().T @ (4 * gradients @ gradients.T @ values[3]))[:2]
    rhs = (C.conj().T @ (4 * gradients @ (8*values[4].mean(axis=0))))[:2]
    expected = np.linalg.norm(lhs-rhs) / (np.linalg.norm(lhs)+np.linalg.norm(rhs))
    result = weak_poisson_residual(*values)
    assert result["relative_weak_residual"] == pytest.approx(expected, abs=1e-14)
    assert result["free_phi_class_count"] == 2
    assert result["dirichlet_phi_class_count"] == 1
