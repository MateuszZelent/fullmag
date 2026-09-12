from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from verify_fem_eigen_k0_periodic_airbox_cpu_gpu_parity import (  # noqa: E402
    ParityError,
    compare_bundles,
)


def _write_bundle(
    root: Path,
    device: str,
    frequencies: list[float],
    *,
    direct_production: bool = False,
) -> None:
    (root / "frequency_domain").mkdir(parents=True)
    (root / "eigen" / "diagnostics").mkdir(parents=True)
    manifest = {
        "schema_version": "frequency_domain_manifest.v1",
        "study_product": "modal_eigen",
        "physics": {"spin_wave_bc": "periodic"},
        "requested_execution": {
            "backend": "fem",
            "device": device,
            "precision": "double",
            "include_demag": True,
        },
        "resolved_execution": {
            "backend": "fem",
            "device": device,
            "precision": "double",
            "engine": f"k0_poisson_airbox_{device}_petsc_slepc",
            "fallback_used": False,
        },
        "validation": (
            {}
            if direct_production
            else {"k0_kittel_validation": {"demag_kind": "periodic_airbox_k0"}}
        ),
    }
    if direct_production:
        manifest["validated_scope"] = (
            "fem_k0_periodic_airbox_p1_double_cpu_slepc"
            if device == "cpu"
            else "fem_k0_periodic_airbox_p1_double_gpu_device_krylov"
        )
    samples = [
        {
            "sample_index": index,
            "k_vector": [0.0, 0.0, 0.0],
            "modes": [
                {
                    "frequency_hz": frequency,
                    "residual_relative_l2": 1.0e-12,
                }
            ],
        }
        for index, frequency in enumerate(frequencies)
    ]
    diagnostics: dict[str, object] = {
        "production_periodic_airbox_claim": True,
        "execution_lane": f"production_{device}",
        "sample_solver_diagnostics": [
            {
                "sample_index": index,
                "diagnostics": {
                    "assembly_kind": "mfem_weak_form_shared_domain",
                    "demag_kind": "periodic_airbox_k0",
                    "production_implication": True,
                    "matrix_equation": "L_eff q = lambda B_qq q; phi(q) = -P^-1 A_phiq q",
                    "physics_contract_version": "micromagnetics_frequency_domain_v5",
                    "operator_dictionary_version": "FrequencyOperatorDictionary.v1",
                    "phasor_convention": "exp_plus_i_omega_t",
                    "eigenvalue_mapping": "lambda_imag_positive_frequency",
                    "q_dof_count": 8,
                    "phi_dof_count": 8,
                    "outer_boundary_kind": "poisson_robin",
                    "robin_beta": 1.0,
                    "gauge_policy": "none",
                    "gauge_reason": "coercive_outer_boundary",
                    "boundary_gauge": {
                        "magnetostatic_bc": "periodic_airbox_k0",
                        "outer_boundary_kind": "poisson_robin",
                        "robin_beta": 1.0,
                        "robin_beta_unit": "1/m",
                        "gauge_policy": "none",
                        "gauge_reason": "coercive_outer_boundary",
                    },
                    "periodic_mesh_certificate_sha256": "sha256:"
                    + "1" * 64,
                    "periodic_modal_equivalence_map_binding_sha256": "sha256:"
                    + "2" * 64,
                    "operator_input_signature_sha256": "sha256:"
                    + "6" * 64,
                    "phase_constraint_sha256": "sha256:" + "3" * 64,
                    "equilibrium_artifact_sha256": "sha256:" + "4" * 64,
                    "linearization_state_sha256": "sha256:" + "5" * 64,
                    "action_residual_evaluated_count": 4,
                    "full_residual_accepted_count": 1,
                    "block_residuals": {
                        "eps_q": 1.0e-12,
                        "eps_phi": 1.0e-12,
                        "eps_gauge": 0.0,
                        "eps_full": 1.0e-12,
                        "certification_tolerance": 1.0e-8,
                        "certified": True,
                    },
                    "certification": {"full_residual_certified": True},
                    **(
                        {
                            "fallback_used": False,
                            "cpu_fallback": "disabled",
                            "device_transfer_audit": {
                                "device_resident_claim": True,
                                "hot_loop_h2d_bytes": 0,
                                "hot_loop_d2h_bytes": 0,
                                "hot_loop_host_sync_count": 0,
                            },
                        }
                        if device == "gpu"
                        else {}
                    ),
                },
            }
            for index in range(len(frequencies))
        ],
    }
    (root / "frequency_domain" / "manifest.v1.json").write_text(json.dumps(manifest), encoding="utf-8")
    (root / "eigen" / "spectrum.v2.json").write_text(
        json.dumps({"phase_convention": "exp_plus_i_omega_t", "samples": samples}),
        encoding="utf-8",
    )
    (root / "eigen" / "diagnostics" / "solver.v1.json").write_text(
        json.dumps(diagnostics), encoding="utf-8"
    )
    (root / "m_initial.json").write_text(
        json.dumps(
            {
                "observable": "m",
                "unit": "1",
                "values": [[1.0, 0.0, 0.0], [1.0, 1.0e-12, -1.0e-12]],
            }
        ),
        encoding="utf-8",
    )
    for index in range(len(frequencies)):
        metadata_dir = root / "eigen" / "metadata" / f"sample_{index:04d}"
        metadata_dir.mkdir(parents=True, exist_ok=True)
        (metadata_dir / "equilibrium_artifact.v6.json").write_text(
            json.dumps(
                {
                    "schema_version": "equilibrium_artifact.v6",
                    "accepted_for_linearization": True,
                    "content_sha256": "sha256:" + "4" * 64,
                }
            ),
            encoding="utf-8",
        )
        (metadata_dir / "linearization_state.v6.json").write_text(
            json.dumps(
                {
                    "schema_version": "LinearizationState.v6",
                    "accepted_for_frequency_operator": True,
                    "content_sha256": "sha256:" + "5" * 64,
                }
            ),
            encoding="utf-8",
        )


def test_cpu_gpu_parity_accepts_identical_scope(tmp_path: Path) -> None:
    cpu = tmp_path / "cpu"
    gpu = tmp_path / "gpu"
    frequencies = [1.0e9, 2.0e9]
    _write_bundle(cpu, "cpu", frequencies)
    _write_bundle(gpu, "gpu", [value * (1.0 + 1.0e-12) for value in frequencies])
    result = compare_bundles(cpu, gpu)
    assert result["status"] == "passed"
    assert result["comparison_count"] == 2


def test_cpu_gpu_parity_accepts_direct_production_scope_without_kittel_payload(
    tmp_path: Path,
) -> None:
    cpu = tmp_path / "cpu"
    gpu = tmp_path / "gpu"
    _write_bundle(cpu, "cpu", [1.0e9], direct_production=True)
    _write_bundle(gpu, "gpu", [1.0e9], direct_production=True)
    result = compare_bundles(cpu, gpu)
    assert result["status"] == "passed"
    assert result["comparison_count"] == 1


def test_cpu_gpu_parity_rejects_frequency_mismatch(tmp_path: Path) -> None:
    cpu = tmp_path / "cpu"
    gpu = tmp_path / "gpu"
    _write_bundle(cpu, "cpu", [1.0e9])
    _write_bundle(gpu, "gpu", [1.1e9])
    with pytest.raises(ParityError, match="frequency relative error"):
        compare_bundles(cpu, gpu)


def test_cpu_gpu_parity_rejects_gpu_without_residency(tmp_path: Path) -> None:
    cpu = tmp_path / "cpu"
    gpu = tmp_path / "gpu"
    _write_bundle(cpu, "cpu", [1.0e9])
    _write_bundle(gpu, "gpu", [1.0e9])
    diagnostics_path = gpu / "eigen" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text(encoding="utf-8"))
    diagnostics["sample_solver_diagnostics"][0]["diagnostics"]["device_transfer_audit"]["device_resident_claim"] = False
    diagnostics_path.write_text(json.dumps(diagnostics), encoding="utf-8")
    with pytest.raises(ParityError, match="device_resident_claim"):
        compare_bundles(cpu, gpu)


def test_cpu_gpu_parity_rejects_unknown_boundary_contract(tmp_path: Path) -> None:
    cpu = tmp_path / "cpu"
    gpu = tmp_path / "gpu"
    _write_bundle(cpu, "cpu", [1.0e9])
    _write_bundle(gpu, "gpu", [1.0e9])
    diagnostics_path = gpu / "eigen" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text(encoding="utf-8"))
    diagnostics["sample_solver_diagnostics"][0]["diagnostics"]["gauge_policy"] = "unknown"
    diagnostics_path.write_text(json.dumps(diagnostics), encoding="utf-8")
    with pytest.raises(ParityError, match="gauge_policy"):
        compare_bundles(cpu, gpu)


def test_cpu_gpu_parity_rejects_certificate_identity_mismatch(tmp_path: Path) -> None:
    cpu = tmp_path / "cpu"
    gpu = tmp_path / "gpu"
    _write_bundle(cpu, "cpu", [1.0e9])
    _write_bundle(gpu, "gpu", [1.0e9])
    diagnostics_path = gpu / "eigen" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text(encoding="utf-8"))
    diagnostics["sample_solver_diagnostics"][0]["diagnostics"][
        "periodic_mesh_certificate_sha256"
    ] = "sha256:" + "9" * 64
    diagnostics_path.write_text(json.dumps(diagnostics), encoding="utf-8")
    with pytest.raises(ParityError, match="operator identity"):
        compare_bundles(cpu, gpu)


def test_cpu_gpu_parity_accepts_independent_state_hashes_within_tolerance(tmp_path: Path) -> None:
    cpu = tmp_path / "cpu"
    gpu = tmp_path / "gpu"
    _write_bundle(cpu, "cpu", [1.0e9])
    _write_bundle(gpu, "gpu", [1.0e9])
    diagnostics_path = gpu / "eigen" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text(encoding="utf-8"))
    nested = diagnostics["sample_solver_diagnostics"][0]["diagnostics"]
    nested["phase_constraint_sha256"] = "sha256:" + "8" * 64
    nested["equilibrium_artifact_sha256"] = "sha256:" + "9" * 64
    nested["linearization_state_sha256"] = "sha256:" + "a" * 64
    diagnostics_path.write_text(json.dumps(diagnostics), encoding="utf-8")
    state_path = gpu / "m_initial.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    state["values"][1][1] += 5.0e-10
    state_path.write_text(json.dumps(state), encoding="utf-8")
    (gpu / "eigen" / "metadata" / "sample_0000" / "equilibrium_artifact.v6.json").write_text(
        json.dumps(
            {
                "schema_version": "equilibrium_artifact.v6",
                "accepted_for_linearization": True,
                "content_sha256": "sha256:" + "9" * 64,
            }
        ),
        encoding="utf-8",
    )
    (gpu / "eigen" / "metadata" / "sample_0000" / "linearization_state.v6.json").write_text(
        json.dumps(
            {
                "schema_version": "LinearizationState.v6",
                "accepted_for_frequency_operator": True,
                "content_sha256": "sha256:" + "a" * 64,
            }
        ),
        encoding="utf-8",
    )
    result = compare_bundles(cpu, gpu)
    assert result["status"] == "passed"
    assert result["max_equilibrium_component_absolute"] == 5.0e-10


def test_cpu_gpu_parity_rejects_operator_input_signature_mismatch(tmp_path: Path) -> None:
    cpu = tmp_path / "cpu"
    gpu = tmp_path / "gpu"
    _write_bundle(cpu, "cpu", [1.0e9])
    _write_bundle(gpu, "gpu", [1.0e9])
    diagnostics_path = gpu / "eigen" / "diagnostics" / "solver.v1.json"
    diagnostics = json.loads(diagnostics_path.read_text(encoding="utf-8"))
    diagnostics["sample_solver_diagnostics"][0]["diagnostics"][
        "operator_input_signature_sha256"
    ] = "sha256:" + "a" * 64
    diagnostics_path.write_text(json.dumps(diagnostics), encoding="utf-8")
    with pytest.raises(ParityError, match="operator input signature"):
        compare_bundles(cpu, gpu)


def test_cpu_gpu_parity_rejects_state_outside_tolerance(tmp_path: Path) -> None:
    cpu = tmp_path / "cpu"
    gpu = tmp_path / "gpu"
    _write_bundle(cpu, "cpu", [1.0e9])
    _write_bundle(gpu, "gpu", [1.0e9])
    state_path = gpu / "m_initial.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    state["values"][1][1] += 2.0e-9
    state_path.write_text(json.dumps(state), encoding="utf-8")
    with pytest.raises(ParityError, match="accepted equilibrium state"):
        compare_bundles(cpu, gpu)
