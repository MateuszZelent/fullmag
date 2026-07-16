import importlib.util
from pathlib import Path

import pytest


SCRIPT = Path(__file__).with_name("validate_fem_antidot_waveguide_dynamic_structure_factor.py")
SPEC = importlib.util.spec_from_file_location("finite_k_validator", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


def finite_k_artifact():
    nk=4; nf=3; power=[0.0]*(nk*nf); power[1*nk+3]=5.0
    return {
        "schema_version":"dynamic_structure_factor.1d.v1", "x_m":[0,1e-9,2e-9,3e-9],
        "time_s":[0,1e-12,2e-12,3e-12], "k_rad_per_m":[-1e9,-0.5e9,0,0.5e9],
        "frequency_hz":[0,10e9,20e9], "power":power,
        "wavevector_count":nk, "frequency_count":nf,
        "phase_convention":"exp[-i(k*x-2*pi*f*t)]",
        "normalization":"one_sided_abs_fft2_squared_over_Nx_Nt_Ux_Ut",
        "invalid_probe_mask":[False]*nk, "mesh_probe_signature":"abc",
    }


def test_accepts_canonical_finite_k_artifact():
    MODULE.validate_single(finite_k_artifact())
    assert MODULE.peak(finite_k_artifact()) == (0.5e9,10e9,5.0)


def test_rejects_invalid_probe():
    artifact=finite_k_artifact(); artifact["invalid_probe_mask"][2]=True
    with pytest.raises(ValueError, match="invalid cross-section"):
        MODULE.validate_single(artifact)


def test_rejects_wrong_phase_convention():
    artifact=finite_k_artifact(); artifact["phase_convention"]="wrong"
    with pytest.raises(ValueError, match="phase convention"):
        MODULE.validate_single(artifact)
