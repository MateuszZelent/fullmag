import numpy as np
import pytest
from audit_de_bv_periodic_seams import magnetic_pair_seams


def fixture():
    nodes = np.array([[0., 0., 0.], [4e-8, 0., 0.]])
    k = np.array([25e6, 0., 0.])
    field = np.array([[0., 1., 1j], [0., np.exp(-1j), 1j*np.exp(-1j)]])
    pairs = [{"pair_id": "x", "node_a": 0, "node_b": 1}]
    definitions = [{"pair_id": "x", "translation": [4e-8, 0., 0.], "tolerance_m": 1e-15}]
    return nodes, field, [0, 1], pairs, definitions, k


def test_correct_phase_detects_wrong_sign_and_missing_phase():
    result = magnetic_pair_seams(*fixture())[0]
    assert result["relative_mismatch"] < 1e-15
    assert result["wrong_sign_relative_mismatch"] > 1.6
    assert result["no_phase_relative_mismatch"] > 0.9


def test_global_complex_amplitude_does_not_change_seam():
    values = list(fixture())
    reference = magnetic_pair_seams(*values)[0]
    values[1] *= 1e100j
    actual = magnetic_pair_seams(*values)[0]
    assert actual["relative_mismatch"] == pytest.approx(reference["relative_mismatch"], abs=1e-15)
    assert actual["wrong_sign_relative_mismatch"] == pytest.approx(reference["wrong_sign_relative_mismatch"])


@pytest.mark.parametrize("kind", ["missing_pairs", "duplicate", "bad_translation", "zero", "nonfinite"])
def test_bad_seam_context_is_not_a_zero_certificate(kind):
    values = list(fixture())
    if kind == "missing_pairs": values[3] = []
    if kind == "duplicate": values[3] *= 2
    if kind == "bad_translation": values[4][0]["translation"] = [-4e-8, 0., 0.]
    if kind == "zero": values[1][:] = 0.
    if kind == "nonfinite": values[1][0, 0] = np.nan
    with pytest.raises(ValueError): magnetic_pair_seams(*values)
