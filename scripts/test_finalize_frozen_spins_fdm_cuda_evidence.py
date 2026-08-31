from __future__ import annotations

import copy
import math
import unittest

from scripts import finalize_frozen_spins_fdm_cuda_evidence as evidence


RUN_ID = "123e4567-e89b-42d3-a456-426614174000"
BUILD_SHA256 = "e" * 64
GPU_DEVICE = {
    "ordinal": 0,
    "name": "test CUDA device",
    "driver_version": "13000",
    "runtime_version": "13000",
    "compute_capability": "9.0",
}


def source_identity() -> dict[str, object]:
    payload: dict[str, object] = {
        "schema": "fullmag.source-snapshot.v2",
        "head_commit_full": "1" * 40,
        "head_tree_sha256": "2" * 64,
        "git_status_porcelain_v1": [],
        "dirty_path_content": [],
        "ignored_non_runtime_dirty": True,
    }
    return {
        **payload,
        "source_snapshot_dirty": False,
        "dirty_content_sha256": evidence._sha256_bytes(
            evidence._canonical_json_bytes([])
        ),
        "source_snapshot_sha256": evidence._sha256_bytes(
            evidence._canonical_json_bytes(payload)
        ),
    }


def resolved_plan() -> dict[str, object]:
    return {
        "schema_version": "resolved_frozen_spins_plan.v1",
        "constraint_ids": ["cpu-gpu-parity"],
        "frozen_mask": list(evidence.CANONICAL_FROZEN_MASK),
        "active_dof_count": 7,
        "frozen_dof_count": 3,
        "free_dof_count": 4,
        "mask_sha256": evidence.EXPECTED_MASK_SHA256,
        "grid_or_mesh_fingerprint": "f" * 64,
        "source_state_revision": 1,
        "all_active_dofs_frozen": False,
        "certificate": {
            "schema_version": "selection_certificate.v1",
            "evaluator_id": "selection.fdm_cell_center.v1",
            "constraint_ids": ["cpu-gpu-parity"],
            "authored_fingerprints": [
                {"constraint_id": "cpu-gpu-parity", "selector_sha256": "a" * 64}
            ],
            "raw_candidate_dof_count": 3,
            "inactive_candidate_dof_count": 0,
            "active_dof_count": 7,
            "frozen_dof_count": 3,
            "free_dof_count": 4,
            "grid_or_mesh_fingerprint": "f" * 64,
            "source_state_revision": 1,
            "mask_sha256": evidence.EXPECTED_MASK_SHA256,
            "resolved_reference_sha256": evidence.EXPECTED_REFERENCE_SHA256,
            "warnings": [],
        },
    }


def run_binding(*, include_plan: bool) -> dict[str, object]:
    binding: dict[str, object] = {
        "run_id": RUN_ID,
        "source_snapshot_sha256": source_identity()["source_snapshot_sha256"],
        "native_build_sha256": BUILD_SHA256,
        "requested_gpu_ordinal": 0,
    }
    if include_plan:
        binding["plan_binding_sha256"] = evidence._plan_binding_sha256(resolved_plan())
    return binding


def native_payload() -> dict[str, object]:
    return {
        "schema_version": "fullmag.frozen_spins.cuda.runtime.evidence.v1",
        "status": "PASS",
        "run_binding": run_binding(include_plan=False),
        "backend": "fullmag_fdm",
        "precision": "fp64+fp32",
        "lane": "single_grid_cuda_explicit_rk",
        "device": {
            **GPU_DEVICE,
            "pci_bus_id": "0000:01:00.0",
            "uuid": "d" * 32,
        },
        "fallback_trail": [],
        "integrators_verified": ["heun", "rk4", "rk23", "dp45", "abm3"],
        "cell_count": 2,
        "frozen_cell_count": 1,
        "max_frozen_defect": 0.0,
        "free_spin_displacement": 0.1,
        "checkpoint_preservation_defect": 0.0,
        "heun_passed": True,
        "rk4_passed": True,
        "checkpoint_passed": True,
        "full_fp64_integrator_matrix_passed": True,
        "full_fp32_integrator_matrix_passed": True,
    }


def parity_payload() -> dict[str, object]:
    initial = [list(vector) for vector in evidence.CANONICAL_INITIAL_MAGNETIZATION]
    cpu = copy.deepcopy(initial)
    cpu[1][0] -= 2.0e-5
    cpu[1][1] += 1.0e-4
    gpu = copy.deepcopy(cpu)
    gpu[1][0] += 1.0e-10
    plan = resolved_plan()
    plan_binding_sha256 = evidence._plan_binding_sha256(plan)

    def displacement(field: list[list[float]]) -> float:
        return max(
            math.sqrt(
                sum((field[index][axis] - initial[index][axis]) ** 2 for axis in range(3))
            )
            for index, (active, frozen) in enumerate(
                zip(evidence.CANONICAL_ACTIVE_MASK, evidence.CANONICAL_FROZEN_MASK, strict=True)
            )
            if active and not frozen
        )

    max_abs = 0.0
    max_normalized = 0.0
    for gpu_vector, cpu_vector in zip(gpu, cpu, strict=True):
        for gpu_component, cpu_component in zip(gpu_vector, cpu_vector, strict=True):
            difference = abs(gpu_component - cpu_component)
            scale = max(abs(gpu_component), abs(cpu_component), 1.0)
            allowed = max(
                evidence.EXPECTED_ABSOLUTE_TOLERANCE,
                evidence.EXPECTED_RELATIVE_TOLERANCE * scale,
            )
            max_abs = max(max_abs, difference)
            max_normalized = max(max_normalized, difference / allowed)

    return {
        "schema_version": "fullmag.frozen_spins.fdm_cpu_gpu_parity.evidence.v1",
        "status": "PASS",
        "run_binding": run_binding(include_plan=True),
        "backend_pair": ["fdm_cpu_reference", "fdm_cuda"],
        "precision": "fp64",
        "integrator": "heun",
        "scientific_scope": evidence.EXPECTED_SCIENTIFIC_SCOPE,
        "known_limitations": evidence.EXPECTED_LIMITATIONS,
        "steps": 4,
        "cell_count": 9,
        "active_cell_count": 7,
        "frozen_cell_count": 3,
        "free_cell_count": 4,
        "mask_sha256": evidence.EXPECTED_MASK_SHA256,
        "plan_binding_sha256": plan_binding_sha256,
        "active_mask": list(evidence.CANONICAL_ACTIVE_MASK),
        "resolved_plan": plan,
        "initial_magnetization_sha256": evidence.EXPECTED_INITIAL_MAGNETIZATION_SHA256,
        "workload": {
            "grid_cells": [3, 3, 1],
            "cell_size_m": [5e-9, 5e-9, 1e-8],
            "fixed_timestep_seconds": 2.5e-13,
            "physics_terms": ["exchange", "external_field"],
            "demag_enabled": False,
        },
        "gpu_device": dict(GPU_DEVICE),
        "observed_step_stats": {
            "cpu": {
                "accepted_step_count": 4,
                "step": 4,
                "time_seconds": 1e-12,
                "dt_seconds": 2.5e-13,
            },
            "gpu": {"step": 4, "time_seconds": 1e-12, "dt_seconds": 2.5e-13},
        },
        "relative_tolerance": 5.0e-6,
        "absolute_tolerance": 1.0e-8,
        "max_abs_component_diff": max_abs,
        "max_normalized_error": max_normalized,
        "cpu_frozen_reference_bitwise": True,
        "gpu_frozen_reference_bitwise": True,
        "max_cpu_free_displacement": displacement(cpu),
        "max_gpu_free_displacement": displacement(gpu),
        "cpu_final_state_sha256": evidence._vector_field_sha256(cpu),
        "gpu_final_state_sha256": evidence._vector_field_sha256(gpu),
        "initial_magnetization": initial,
        "cpu_final_magnetization": cpu,
        "gpu_final_magnetization": gpu,
    }


def finalize(
    native: dict[str, object] | None = None,
    parity: dict[str, object] | None = None,
    source: dict[str, object] | None = None,
) -> dict[str, object]:
    return evidence.finalize(
        native if native is not None else native_payload(),
        parity if parity is not None else parity_payload(),
        source if source is not None else source_identity(),
        expected_run_id=RUN_ID,
        expected_native_build_sha256=BUILD_SHA256,
        expected_gpu_ordinal=0,
    )


class FinalizeFrozenSpinsFdmCudaEvidenceTests(unittest.TestCase):
    def test_finalized_receipt_records_bound_runtime_and_unqualified_status(self) -> None:
        receipt = finalize()
        self.assertEqual(receipt["implementation_status"], "RUNTIME_CONFIRMED")
        self.assertEqual(receipt["qualification_status"], "UNQUALIFIED")
        self.assertEqual(receipt["test_case_ids"], ["FS-P15-CPU-GPU-PARITY"])
        self.assertEqual(
            receipt["managed_recipe_gates"]["native_boundary_malformed_plan_rejection"],
            "PASS",
        )

    def test_rejects_failed_or_fallback_native_evidence(self) -> None:
        failed = native_payload()
        failed["status"] = "FAIL"
        with self.assertRaises(evidence.EvidenceError):
            finalize(native=failed)
        fallback = native_payload()
        fallback["fallback_trail"] = ["cpu"]
        with self.assertRaises(evidence.EvidenceError):
            finalize(native=fallback)

    def test_rejects_false_native_binding_to_distinct_parity_plan(self) -> None:
        native = native_payload()
        native["run_binding"]["plan_binding_sha256"] = "a" * 64
        with self.assertRaises(evidence.EvidenceError):
            finalize(native=native)

    def test_rejects_tampered_embedded_final_field_even_when_metrics_claim_pass(self) -> None:
        parity = parity_payload()
        parity["gpu_final_magnetization"][0][0] = 0.5
        with self.assertRaises(evidence.EvidenceError):
            finalize(parity=parity)

    def test_rejects_forged_declared_metric_with_unchanged_fields(self) -> None:
        parity = parity_payload()
        parity["max_abs_component_diff"] = 0.0
        with self.assertRaises(evidence.EvidenceError):
            finalize(parity=parity)

    def test_rejects_noncanonical_mask_reference_or_step_count(self) -> None:
        for mutation in ("mask", "reference", "steps"):
            parity = parity_payload()
            if mutation == "mask":
                parity["resolved_plan"]["frozen_mask"][1] = True
            elif mutation == "reference":
                parity["resolved_plan"]["certificate"]["resolved_reference_sha256"] = "b" * 64
            else:
                parity["steps"] = 1
            with self.subTest(mutation=mutation), self.assertRaises(evidence.EvidenceError):
                finalize(parity=parity)

    def test_rejects_run_source_build_or_device_identity_mismatch(self) -> None:
        for key in ("run_id", "source_snapshot_sha256", "native_build_sha256"):
            parity = parity_payload()
            parity["run_binding"][key] = "0" * (36 if key == "run_id" else 64)
            with self.subTest(key=key), self.assertRaises(evidence.EvidenceError):
                finalize(parity=parity)
        parity = parity_payload()
        parity["gpu_device"]["ordinal"] = 1
        with self.assertRaises(evidence.EvidenceError):
            finalize(parity=parity)

    def test_rejects_source_snapshot_with_stale_self_hash(self) -> None:
        source = source_identity()
        source["head_tree_sha256"] = "3" * 64
        with self.assertRaises(evidence.EvidenceError):
            finalize(source=source)


if __name__ == "__main__":
    unittest.main()
