from pathlib import Path

from tests.standard_problems.mumag.sp4.common.references import load_reference_manifest
from tests.standard_problems.mumag.sp4.common.contract import CONTRACT, validate_device
from tests.standard_problems.mumag.sp4.common.metrics import (
    find_first_zero_crossing,
    parity_metrics,
    reference_envelope_metrics,
)
from tests.standard_problems.mumag.sp4.common.references import (
    ReferenceDataError,
    Trajectory,
    parse_albuquerque_trace,
    parse_oommf_odt,
    parse_ovf2_rectangular,
)
import numpy as np
import pytest


REFERENCE_ROOT = Path(__file__).parents[1] / "references"


EXPECTED_DIGESTS = {
    "nist/oommf/stdprob4a.odt": "d80253f04485cc189d91c900a121b516926b0082928ff288e20f912ea066070b",
    "nist/oommf/stdprob4b.odt": "deb6211a09eb084282e43063e79391f656e52ffd5c25cd4951ce62eeb1ed1453",
    "nist/oommf/stdprob4a-138ps.omf": "7502952714ab24a7e4d90755c3e7041efe5dd5f2e6a258cab631a4d06c1867db",
    "nist/oommf/stdprob4b-137ps.omf": "cec02b4883de33acc32dc4a69ed5a6be573e300c2df38b4bc987e10ed3056001",
    "nist/oommf/stdprob4-start.omf": "e0a4a130f54af5f85288805a51f857a97143051df7e47bdc677c49f2bf3ebb2e",
    "nist/albuquerque/FIELD_1_SM_DT25.TXT": "e620dbe69bc226a5f20ad6bf599cdb346b69655d5685297252274abdd276293e",
    "nist/albuquerque/FIELD_1_LM_DT25.TXT": "74acd8a9236e95017bc2647ec7592fa2e66e644c94a591fd4e9fadd13a4678d9",
    "nist/albuquerque/FIELD_1_SM_MxEQ0.OVF": "12b83b290ffc4ac72d4514dd5e892859a07992b5de8b61c6197718a81ef4a86a",
    "nist/albuquerque/FIELD_2_SM_DT25.TXT": "11ded0d75950b39f187a328a92ee706b357523126bbfd22fe630d7da37c9a093",
    "nist/albuquerque/FIELD_2_LM_DT25.TXT": "5ca10c812c8dacaa26314dd3c6f6f14abc4b885ed8a28f01c50f9b430fb53861",
    "nist/albuquerque/FIELD_2_SM_MxEQ0.OVF": "ed27429faba63b93c05fddfa51a2eeea411bc3af34a7423adeac94d1d1216649",
}


def test_reference_manifest_covers_and_verifies_official_nist_files():
    manifest = load_reference_manifest(REFERENCE_ROOT / "manifest.json")

    assert manifest.schema == "fullmag.mumag.sp4.references.v1"
    assert manifest.downloaded == "2026-07-18"
    assert {entry.path: entry.sha256 for entry in manifest.files} == EXPECTED_DIGESTS
    assert all(entry.url.startswith("https://www.ctcms.nist.gov/") for entry in manifest.files)
    assert all(entry.author and entry.units and entry.mesh for entry in manifest.files)


def test_contract_has_exact_nist_si_values_and_cpu_gpu_lanes():
    assert CONTRACT.dimensions_m == (500e-9, 125e-9, 3e-9)
    assert CONTRACT.ms_a_per_m == 8e5
    assert CONTRACT.aex_j_per_m == 1.3e-11
    assert CONTRACT.alpha == 0.02
    assert CONTRACT.gamma_mu0_m_per_as == 2.211e5
    assert np.linalg.norm(CONTRACT.initial_m) == pytest.approx(1.0)
    assert [case.field_t for case in CONTRACT.cases] == [(-24.6e-3, 4.3e-3, 0.0), (-35.5e-3, -6.3e-3, 0.0)]
    assert [mesh.hmax_m for mesh in CONTRACT.meshes] == [3e-9, 2e-9, 1.5e-9]
    assert validate_device("cpu") == "cpu"
    assert validate_device("gpu") == "gpu"
    with pytest.raises(ValueError):
        validate_device("auto")


def test_real_reference_parsers_and_crossings():
    root = REFERENCE_ROOT / "nist"
    a = parse_oommf_odt(root / "oommf/stdprob4a.odt")
    b = parse_oommf_odt(root / "oommf/stdprob4b.odt")
    assert len(a.time_s) == len(b.time_s) == 5001
    assert find_first_zero_crossing(a) / 1e-12 == pytest.approx(138.419, abs=0.001)
    assert find_first_zero_crossing(b) / 1e-12 == pytest.approx(136.685, abs=0.001)
    field = parse_ovf2_rectangular(root / "oommf/stdprob4-start.omf")
    assert field.shape == (500, 125, 3, 3)
    assert field.values_are_reduced_magnetization
    albuquerque = parse_albuquerque_trace(root / "albuquerque/FIELD_1_SM_DT25.TXT")
    assert len(albuquerque.time_s) == 1001


def test_metrics_are_fail_closed_and_report_component_values():
    time = np.array([0.0, 1.0, 2.0])
    reference = Trajectory(time, np.array([[1., 0., 0.], [0., 1., 0.], [-1., 0., 0.]]), "reference")
    candidate = Trajectory(time, reference.m.copy(), "candidate")
    assert find_first_zero_crossing(candidate) == 1.0
    metrics = reference_envelope_metrics(candidate, [reference])
    assert metrics["normalized_rms"] == [0.0, 0.0, 0.0]
    assert parity_metrics(candidate, reference)["crossing_delta_s"] == 0.0
    without_crossing = Trajectory(time, np.ones((3, 3)), "bad")
    with pytest.raises(ReferenceDataError):
        find_first_zero_crossing(without_crossing)
