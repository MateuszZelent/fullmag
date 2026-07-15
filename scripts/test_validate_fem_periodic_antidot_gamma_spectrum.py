import importlib.util
import json
from pathlib import Path

import pytest


SCRIPT = Path(__file__).with_name("validate_fem_periodic_antidot_gamma_spectrum.py")
SPEC = importlib.util.spec_from_file_location("gamma_validator", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


def gamma_artifact(frequency=10e9, power=1.0):
    return {
        "schema_version":"spin_wave_response.gamma.v1", "time_s":[0,1e-12,2e-12,3e-12],
        "response_trace":[0,1,0,-1], "source_trace":[0,1,0,-1],
        "frequency_hz":[0,10e9,20e9], "response_psd":[0,power,0],
        "weighting":"Ms_times_lumped_volume",
        "normalization":"one_sided_abs_fft_squared_over_N_sum_window_squared",
        "peaks":[{"index":1,"frequency_hz":frequency,"power":power}],
    }


def test_accepts_canonical_gamma_artifact():
    MODULE.validate_single(gamma_artifact())


def test_rejects_nonuniform_time_axis():
    artifact=gamma_artifact(); artifact["time_s"][-1]=4e-12
    with pytest.raises(ValueError, match="not uniform"):
        MODULE.validate_single(artifact)


def test_dominant_peak_is_typed():
    assert MODULE.dominant_peak(gamma_artifact()) == (10e9, 1.0)
