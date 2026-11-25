"""Prevent comparisons across different ports or phase conventions."""

import numpy as np
import pytest

from compare_rf_cpw_reference import compare


def fixture():
    meta = {
        "model": "maxwell",
        "cpw": 2,
        "frequency_hz": 22.12e9,
        "phasor_convention": "peak, exp(+i omega t)",
        "boundary_model": "ECE terminal patches",
        "sha256": {"points_m": "test-mesh"},
        "terminal_voltages_v": {"signal_input": [1, 0]},
        "terminal_loads_ohm": {"signal_output": [50, 0]},
        "cross_section": {"ground_gap_fraction": .08},
        "local_minimum": {"k_rad_per_m": 18.4e6, "relative_to_peak": .003},
    }
    ids = np.zeros((4, 3))
    field = np.ones((4, 3), dtype=complex)
    return meta, {"probe_xyz_m": ids, "probe_H_over_I_per_m": field}


def test_comparison_preserves_phase():
    full, field = fixture()
    candidate = {**full, "model": "darwin"}
    phased = {**field, "probe_H_over_I_per_m": field["probe_H_over_I_per_m"]*1j}
    assert compare(full, field, candidate, phased)["relative_vector_H_l2"] == pytest.approx(2**.5)


def test_comparison_rejects_retuned_load():
    full, field = fixture()
    candidate = {**full, "model": "darwin",
                 "terminal_loads_ohm": {"signal_output": [40, 0]}}
    with pytest.raises(ValueError, match="terminal_loads"):
        compare(full, field, candidate, field)
