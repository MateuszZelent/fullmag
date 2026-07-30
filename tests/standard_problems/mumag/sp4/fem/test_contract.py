from pathlib import Path
import contextlib
from dataclasses import replace
import io
import json

from tests.standard_problems.mumag.sp4.common.references import load_reference_manifest
from tests.standard_problems.mumag.sp4.common.contract import (
    CANONICAL_RELAXATION_ALGORITHM,
    CANONICAL_RELAXATION_DEVICE,
    CONTRACT,
    DEFAULT_RELAXATION_ALGORITHM,
    MIXED_P1_QUALIFICATION,
    PRODUCTION_RELAXATION_ALGORITHMS,
    RELAXATION_DT_MAX_S,
    validate_device,
)
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
from tests.standard_problems.mumag.sp4.fem.verify import (
    equilibrium_metrics,
    load_artifact_field,
    provenance_errors,
)
import numpy as np
import pytest
from fullmag.runtime import helper as runtime_helper


REFERENCE_ROOT = Path(__file__).parents[1] / "references"
MANAGED_PROBLEM = Path(__file__).with_name("problem.py")


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


def test_qualification_defaults_to_monotone_overdamped_llg_relaxation():
    assert DEFAULT_RELAXATION_ALGORITHM == "llg_overdamped"
    assert CANONICAL_RELAXATION_ALGORITHM == "llg_overdamped"
    assert CANONICAL_RELAXATION_DEVICE == "gpu"
    assert PRODUCTION_RELAXATION_ALGORITHMS == (
        "llg_overdamped",
        "projected_gradient_bb",
        "nonlinear_cg",
    )
    assert RELAXATION_DT_MAX_S == 1e-14


def test_mixed_p1_qualification_contract_freezes_energy_and_temporal_gates():
    contract = MIXED_P1_QUALIFICATION

    assert (contract.mesh_energy.atol_j, contract.mesh_energy.rtol) == (2e-19, 2e-2)
    assert (contract.airbox_energy.atol_j, contract.airbox_energy.rtol) == (1e-19, 1e-2)
    assert (contract.operator_energy.atol_j, contract.operator_energy.rtol) == (1e-30, 1e-6)
    assert contract.fixed_finest_dt_pair_s == (2e-14, 1e-14)
    assert contract.adaptive_finest_max_err_pair == (1e-6, 1e-7)
    assert contract.component_rms_max == 0.01
    assert contract.component_p99_max == 0.03
    assert contract.component_endpoint_max == 0.01
    assert contract.crossing_delta_max_s == 5e-12
    assert contract.energy_trajectory_relative_rms_max == 0.01
    assert (
        contract.temporal_energy_endpoint.atol_j,
        contract.temporal_energy_endpoint.rtol,
    ) == (1e-19, 1e-2)


def test_mixed_p1_qualification_rules_are_executable_and_fail_closed():
    contract = MIXED_P1_QUALIFICATION

    assert contract.operator_energy.accepts(1e-18, 1e-18 + 1e-24)
    assert not contract.operator_energy.accepts(1e-18, 1e-18 + 3e-24)
    assert not contract.operator_energy.accepts(float("nan"), 0.0)
    assert contract.temporal_accepts(
        component_rms=(0.01, 0.0, 0.0),
        component_p99=(0.03, 0.0, 0.0),
        component_endpoint=(0.01, 0.0, 0.0),
        crossing_delta_s=5e-12,
        energy_relative_rms=(0.01, 0.0, 0.0),
        energy_endpoint_pairs_j=((1e-18, 1e-18),) * 3,
    )
    assert not contract.temporal_accepts(
        component_rms=(0.0100001, 0.0, 0.0),
        component_p99=(0.0, 0.0, 0.0),
        component_endpoint=(0.0, 0.0, 0.0),
        crossing_delta_s=0.0,
        energy_relative_rms=(0.0, 0.0, 0.0),
        energy_endpoint_pairs_j=((0.0, 0.0),) * 3,
    )


@pytest.mark.parametrize(
    "field",
    (
        "component_rms",
        "component_p99",
        "component_endpoint",
        "energy_relative_rms",
        "energy_endpoint_pairs_j",
    ),
)
@pytest.mark.parametrize("length", (0, 2, 4))
def test_mixed_p1_temporal_gate_rejects_non_triplet_metrics(field, length):
    kwargs = {
        "component_rms": (0.0, 0.0, 0.0),
        "component_p99": (0.0, 0.0, 0.0),
        "component_endpoint": (0.0, 0.0, 0.0),
        "crossing_delta_s": 0.0,
        "energy_relative_rms": (0.0, 0.0, 0.0),
        "energy_endpoint_pairs_j": ((0.0, 0.0),) * 3,
    }
    kwargs[field] = ((0.0, 0.0),) * length if field == "energy_endpoint_pairs_j" else (0.0,) * length

    assert not MIXED_P1_QUALIFICATION.temporal_accepts(**kwargs)


@pytest.mark.parametrize(
    "changes",
    (
        {"fixed_finest_dt_pair_s": (1e-14,)},
        {"fixed_finest_dt_pair_s": [2e-14, 1e-14]},
        {"fixed_finest_dt_pair_s": (1e-14, 2e-14)},
        {"adaptive_finest_max_err_pair": [1e-6, 1e-7]},
        {"adaptive_finest_max_err_pair": (1e-7, 1e-6)},
        {"component_rms_max": -1.0},
        {"component_p99_max": float("nan")},
        {"crossing_delta_max_s": float("inf")},
    ),
)
def test_mixed_p1_qualification_contract_rejects_invalid_frozen_values(changes):
    with pytest.raises((TypeError, ValueError)):
        replace(MIXED_P1_QUALIFICATION, **changes)


def _managed_problem_ir(
    monkeypatch,
    *,
    phase: str,
    algorithm: str,
    state=None,
    mesh: str = "coarse",
    topology_variant: str | None = None,
    layers: int | None = None,
):
    monkeypatch.setenv("FULLMAG_SP4_PHASE", phase)
    monkeypatch.setenv("FULLMAG_SP4_RELAX_ALGORITHM", algorithm)
    monkeypatch.setenv("FULLMAG_SP4_DEVICE", "cpu")
    monkeypatch.setenv("FULLMAG_SP4_MESH", mesh)
    monkeypatch.setenv("FULLMAG_SP4_AIRBOX", "baseline")
    if topology_variant is None:
        monkeypatch.delenv("FULLMAG_SP4_TOPOLOGY_VARIANT", raising=False)
    else:
        monkeypatch.setenv("FULLMAG_SP4_TOPOLOGY_VARIANT", topology_variant)
    if layers is None:
        monkeypatch.delenv("FULLMAG_SP4_LAYERS", raising=False)
    else:
        monkeypatch.setenv("FULLMAG_SP4_LAYERS", str(layers))
    if state is None:
        monkeypatch.delenv("FULLMAG_SP4_INITIAL_STATE", raising=False)
    else:
        monkeypatch.setenv("FULLMAG_SP4_INITIAL_STATE", str(state))
    stdout = io.StringIO()
    with contextlib.redirect_stdout(stdout):
        status = runtime_helper.main(
            [
                "export-run-config",
                "--script",
                str(MANAGED_PROBLEM),
                "--backend",
                "fem",
                "--mode",
                "strict",
                "--precision",
                "double",
                "--skip-geometry-assets",
            ]
        )
    assert status == 0
    payload = json.loads(stdout.getvalue())
    return payload["stages"][0]["ir"]


def _managed_mesh_entry(monkeypatch, **kwargs):
    ir = _managed_problem_ir(
        monkeypatch,
        phase="relax",
        algorithm="projected_gradient_bb",
        **kwargs,
    )
    [mesh] = ir["problem_meta"]["runtime_metadata"]["mesh_workflow"][
        "per_geometry"
    ]
    return mesh


def test_managed_problem_defaults_to_all_tet_without_layer_controls(
    monkeypatch,
) -> None:
    mesh = _managed_mesh_entry(monkeypatch)

    assert mesh["hmax"] == pytest.approx(3e-9)
    assert mesh["order"] == 1
    assert "topology" not in mesh
    assert "through_thickness_elements" not in mesh
    assert "exact_layer_count" not in mesh
    assert "transition_policy" not in mesh


@pytest.mark.parametrize("layers", (1, 2, 3))
def test_managed_problem_mixed_p1_lowers_hmax_and_exact_layers_1_2_3(
    monkeypatch,
    layers,
) -> None:
    mesh = _managed_mesh_entry(
        monkeypatch,
        mesh="medium",
        topology_variant="mixed_p1",
        layers=layers,
    )

    assert mesh["hmin"] == pytest.approx(2e-9)
    assert mesh["hmax"] == pytest.approx(2e-9)
    assert mesh["minimum_element_size"] == pytest.approx(2e-9)
    assert mesh["maximum_element_size"] == pytest.approx(2e-9)
    assert mesh["order"] == 1
    assert mesh["mesh_strategy"] == "swept_prism"
    assert mesh["topology"] == "prismatic"
    assert mesh["element_family"] == "prism"
    assert mesh["through_thickness_elements"] == layers
    assert mesh["exact_layer_count"] is True
    assert mesh["transition_policy"] == "pyramid_to_tetrahedra"


@pytest.mark.parametrize(
    ("topology_variant", "layers"),
    [
        ("mixed_p1", None),
        ("mixed_p1", 0),
        ("mixed_p1", 4),
        ("all_tet", 1),
        ("unsupported", None),
    ],
)
def test_managed_problem_rejects_invalid_topology_layer_combinations(
    monkeypatch,
    topology_variant,
    layers,
) -> None:
    with pytest.raises(ValueError):
        _managed_mesh_entry(
            monkeypatch,
            topology_variant=topology_variant,
            layers=layers,
        )


@pytest.mark.parametrize("algorithm", PRODUCTION_RELAXATION_ALGORITHMS)
def test_managed_relaxation_owns_only_applicable_numerical_policy(
    monkeypatch,
    algorithm,
):
    ir = _managed_problem_ir(
        monkeypatch,
        phase="relax",
        algorithm=algorithm,
    )
    relaxation = ir["study"]
    assert relaxation["algorithm"] == algorithm
    assert not any(term["kind"] == "zeeman" for term in ir["energy_terms"])
    if algorithm == "llg_overdamped":
        dynamics = relaxation["dynamics"]
        assert dynamics["integrator"] == "rk23"
        assert dynamics["fixed_timestep"] is None
        adaptive = dynamics["adaptive_timestep"]
        assert adaptive["dt_initial"] == pytest.approx(1e-15)
        assert adaptive["dt_min"] == pytest.approx(1e-17)
        assert adaptive["dt_max"] == pytest.approx(1e-14)
        assert adaptive["atol"] == pytest.approx(1e-7)
        assert ir["materials"][0]["damping"] == pytest.approx(1.0)
    else:
        assert "dynamics" not in relaxation


def test_managed_dynamics_restores_physical_alpha_and_separate_timestep(
    monkeypatch,
    tmp_path,
):
    state = tmp_path / "initial_state.json"
    state.write_text(
        json.dumps({"kind": "magnetization_state", "values": [[1.0, 0.0, 0.0]]})
    )
    ir = _managed_problem_ir(
        monkeypatch,
        phase="dynamic",
        algorithm=CANONICAL_RELAXATION_ALGORITHM,
        state=state,
    )
    dynamics = ir["study"]["dynamics"]
    assert dynamics["integrator"] == "rk45"
    assert dynamics["adaptive_timestep"]["dt_max"] == pytest.approx(2e-13)
    assert ir["materials"][0]["damping"] == pytest.approx(CONTRACT.alpha)
    universe = ir["problem_meta"]["runtime_metadata"]["study_universe"]
    assert universe["airbox_growth_rate"] == pytest.approx(1.7)
    assert universe["airbox_grading"] == "geometric"


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


def test_validator_provenance_rejects_gpu_hybrid_and_fallback():
    metadata = {
        "requested_execution": {
            "backend": "fem", "device": "gpu", "precision": "double",
            "mode": "strict", "fallback_policy": "forbidden",
        },
        "execution_provenance": {
            "execution_engine": "fem_native_gpu", "precision": "double",
            "lossy_fallback_used": False,
            "fem_demag_operator_mode": "device_hypre_poisson",
            "hypre_execution_policy": "device", "uses_gpu_poisson": True,
        },
        "demag_runtime": {"actual_iterations": 7, "final_residual_norm": 1e-10},
    }
    assert provenance_errors(metadata, "gpu") == []
    metadata["execution_provenance"]["fem_demag_operator_mode"] = "hybrid_cpu_poisson"
    assert "GPU demag is not device_hypre_poisson" in provenance_errors(metadata, "gpu")
    metadata["execution_provenance"]["lossy_fallback_used"] = True
    assert "fallback was used or not proven absent" in provenance_errors(metadata, "gpu")


def test_validator_loads_magnetic_slice_and_checks_norm(tmp_path):
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    (artifacts / "metadata.json").write_text(json.dumps({
        "execution_plan": {"backend_plan": {
            "mesh": {"nodes": [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [9, 9, 9]]},
            "object_segments": [
                {"object_id": "film", "node_start": 0, "node_count": 4},
                {"object_id": "__air__", "node_start": 4, "node_count": 1},
            ],
        }},
    }))
    (artifacts / "m_final.json").write_text(json.dumps({
        "values": [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, 0, 0]],
    }))
    nodes, values, info = load_artifact_field(artifacts)
    assert nodes.shape == values.shape == (4, 3)
    assert info["norm_defect"] == 0.0


def test_equilibrium_gate_requires_full_window_and_reports_drift():
    rows = [
        {"time": index * 1e-12, "mx": 0.5 + index * 1e-7, "my": 0.1,
         "mz": 0.0, "max_torque_T": 5e-6}
        for index in range(52)
    ]
    result = equilibrium_metrics(rows)
    assert result["maximum_torque_T"] == 5e-6
    assert max(result["component_drift"]) < 1e-4
    with pytest.raises(Exception, match="50 ps"):
        equilibrium_metrics(rows[:20])
