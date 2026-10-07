"""Interpreted regressions for comparing already-revalidated frozen probes."""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import validate_frozen_v2_execution_parity as parity
from test_fem_linearization_identity_replay import fixture as identity_fixture


def bind_physical_identity(binding, identity):
    binding["immutable_physical_identity"] = identity
    binding["immutable_physical_identity_sha256"] = "sha256:" + hashlib.sha256(json.dumps(
        identity, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")).hexdigest()


def fixture():
    requests, validations = {}, {}
    for mode in ("serial", "adaptive"):
        requests[mode] = {
            "mode": mode, "mode_policy": {"mode": mode, "max_cpu_percent": 90.0},
            "job": {"job_id": "a" * 32}, "source": {"snapshot": "b" * 64},
            "bundle": {"manifest_sha256": "c" * 64}, "numerics": {"rtol": "1e-9"},
            "consumer_hashes": {"scripts/validator.py": "d" * 64},
            "model": {"original": {"sha256": "e" * 64}, "derived_script_sha256": "f" * 64,
                      "derived_script_path": f"/{mode}/model.py"},
        }
        bindings, phases, samples = [], [], []
        for index, vector in enumerate(parity.EXPECTED_VECTORS):
            bindings.append({
                "sample_index": index,
                "equilibrium_content_sha256": "sha256:" + "1" * 64,
                "source_mesh_topology_sha256": "sha256:" + "2" * 64,
                "modal_mesh_topology_fingerprint_v3": "sha256:" + "3" * 64,
                "linearization_state_sha256": "sha256:" + str(index + 4) * 64,
            })
            identity, _ = identity_fixture(sample_index=index, overrides={
                **{key: bindings[-1][key] for key in ("equilibrium_content_sha256",
                   "source_mesh_topology_sha256", "modal_mesh_topology_fingerprint_v3",
                   "linearization_state_sha256")},
                "consumer_plan_snapshot_sha256": "sha256:" + ("a" if mode == "serial" else "b") * 64,
                "recomputed_certificate_preimage_json": '{"status":"fields_verified"}',
            })
            bind_physical_identity(bindings[-1], parity.probe.immutable_physical_identity(identity, index))
            bindings[-1]["consumer_plan_snapshot_sha256"] = identity["consumer_plan_snapshot_sha256"]
            phases.append({"sample_index": index, "k_vector_rad_per_m": list(vector),
                           "phase_constraint_sha256": "sha256:" + ("7" if index == 1 else "8") * 64})
            samples.append({"sample_index": index, "source_sample_index": (3, 11, 3)[index],
                            "k_vector_rad_per_m": list(vector), "frequency_hz": 11.205e9,
                            "residual_relative_l2": 2e-10})
        validations[mode] = {"status": "passed_artifact_preflight", "qualification": "NOT VERIFIED",
                             "native_bindings_by_sample": bindings,
                             "solver": {"phase_constraints_by_sample": phases},
                             "samples": {"samples": samples},
                             "case_artifact_hashes_sha256": "9" * 64}
    return requests, validations


class FrozenV2ParityTests(unittest.TestCase):
    def test_same_native_inputs_allow_only_policy_mode_and_output_path_difference(self):
        requests, validations = fixture()
        result = parity.compare_validated_runs(requests, validations)
        self.assertEqual(result["status"], "parity_passed_unqualified")
        self.assertEqual(result["qualification"], "NOT VERIFIED")
        self.assertFalse(result["residual_equality_claimed"])
        self.assertNotEqual(validations["serial"]["native_bindings_by_sample"][0]["consumer_plan_snapshot_sha256"],
                            validations["adaptive"]["native_bindings_by_sample"][0]["consumer_plan_snapshot_sha256"])

    def test_full_physical_provenance_changes_are_rejected_even_after_rehash(self):
        for field in ("material_signature", "equilibrium_boundary_signature", "consumer_build_identity",
                      "producer_build_identity", "recomputed_certificate_content_sha256",
                      "accepted_fields_bytes_sha256", "producer_plan_snapshot_sha256"):
            with self.subTest(field=field):
                requests, validations = fixture()
                binding = validations["adaptive"]["native_bindings_by_sample"][1]
                identity = copy.deepcopy(binding["immutable_physical_identity"])
                identity[field] = {"changed": True} if isinstance(identity[field], dict) else "changed"
                bind_physical_identity(binding, identity)
                with self.assertRaisesRegex(ValueError, "immutable physical identity"):
                    parity.compare_validated_runs(requests, validations)

    def test_missing_stale_or_extra_physical_identity_cannot_pass(self):
        for mutation in ("missing", "stale_hash", "extra_field"):
            requests, validations = fixture()
            binding = validations["serial"]["native_bindings_by_sample"][0]
            if mutation == "missing":
                del binding["immutable_physical_identity"]
            elif mutation == "stale_hash":
                binding["immutable_physical_identity_sha256"] = "sha256:" + "0" * 64
            else:
                identity = copy.deepcopy(binding["immutable_physical_identity"])
                identity["consumer_plan_snapshot_sha256"] = "sha256:" + "a" * 64
                bind_physical_identity(binding, identity)
            with self.subTest(mutation=mutation), self.assertRaisesRegex(ValueError, "immutable physical identity"):
                parity.compare_validated_runs(requests, validations)

    def test_each_identity_and_physical_contract_difference_is_rejected(self):
        for field in ("job", "source", "bundle", "numerics", "consumer_hashes"):
            with self.subTest(field=field):
                requests, validations = fixture()
                requests["adaptive"][field]["different"] = True
                with self.assertRaisesRegex(ValueError, field):
                    parity.compare_validated_runs(requests, validations)
        for field in ("original", "derived_script_sha256"):
            requests, validations = fixture()
            requests["adaptive"]["model"][field] = "changed"
            with self.assertRaisesRegex(ValueError, "model"):
                parity.compare_validated_runs(requests, validations)

    def test_same_policy_numeric_bool_coercion_is_rejected(self):
        requests, validations = fixture()
        requests["serial"]["mode_policy"]["threads_per_worker"] = 1
        requests["adaptive"]["mode_policy"]["threads_per_worker"] = True
        with self.assertRaisesRegex(ValueError, "policy outside mode"):
            parity.compare_validated_runs(requests, validations)

    def test_native_per_sample_lin_and_floquet_differences_are_rejected(self):
        for field in ("equilibrium_content_sha256", "source_mesh_topology_sha256",
                      "modal_mesh_topology_fingerprint_v3", "linearization_state_sha256"):
            with self.subTest(field=field):
                requests, validations = fixture()
                validations["adaptive"]["native_bindings_by_sample"][1][field] = "sha256:" + "0" * 64
                with self.assertRaisesRegex(ValueError, field):
                    parity.compare_validated_runs(requests, validations)
        requests, validations = fixture()
        validations["adaptive"]["solver"]["phase_constraints_by_sample"][0]["phase_constraint_sha256"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(ValueError, "Floquet"):
            parity.compare_validated_runs(requests, validations)

    def test_frequency_difference_uses_existing_tolerance_without_changing_residual_ceiling(self):
        requests, validations = fixture()
        validations["adaptive"]["samples"]["samples"][1]["frequency_hz"] += 50.0
        result = parity.compare_validated_runs(requests, validations)
        self.assertEqual(result["status"], "parity_passed_unqualified")
        validations["adaptive"]["samples"]["samples"][1]["frequency_hz"] += 500.0
        self.assertEqual(parity.compare_validated_runs(requests, validations)["status"], "parity_failed")

    def test_repeat_negative_point_must_match_within_each_execution_mode(self):
        requests, validations = fixture()
        for mode in validations:
            validations[mode]["samples"]["samples"][2]["frequency_hz"] += 500.0
        result = parity.compare_validated_runs(requests, validations)
        self.assertTrue(all(item["within_tolerance"] for item in result["comparisons"]))
        self.assertEqual(result["status"], "parity_failed")

    def test_invalid_frequency_or_physical_residual_is_never_parity_pass(self):
        for field, value in (("frequency_hz", float("nan")), ("frequency_hz", 0.0),
                             ("residual_relative_l2", 2e-8), ("residual_relative_l2", -1.0),
                             ("residual_relative_l2", True)):
            with self.subTest(field=field, value=value):
                requests, validations = fixture()
                validations["serial"]["samples"]["samples"][0][field] = value
                with self.assertRaises(ValueError):
                    parity.compare_validated_runs(requests, validations)

    def test_exact_sample_mapping_and_current_preflight_are_required(self):
        requests, validations = fixture()
        validations["serial"]["samples"]["samples"][1]["source_sample_index"] = 3
        with self.assertRaisesRegex(ValueError, "mapping"):
            parity.compare_validated_runs(requests, validations)
        requests, validations = fixture()
        validations["serial"]["status"] = "pass"
        with self.assertRaisesRegex(ValueError, "current artifact"):
            parity.compare_validated_runs(requests, validations)

    def test_pipeline_revalidates_both_cases_and_keeps_missing_overlap_separate(self):
        requests, validations = fixture()
        hashes = {"serial": "a" * 64, "adaptive": "b" * 64}
        import hashlib
        raw = b"fixture request"
        expected_request_hash = hashlib.sha256(raw).hexdigest()
        def read_receipt(path, label):
            mode = path.parent.name
            return path, raw, requests[mode]
        def validate(case, request, result):
            return copy.deepcopy(validations[case.parent.name])
        def sha(path):
            return 1, expected_request_hash if path.name == "run-request.json" else hashes[path.parent.name]
        report = {"concurrency": {"status": "not_verified"}, "resource_quality": {"status": "pass"}}
        with patch.object(parity.probe, "_read_receipt", side_effect=read_receipt), \
             patch.object(parity.probe, "_sha256_file", side_effect=sha), \
             patch.object(parity.probe, "validate_probe_artifacts", side_effect=validate) as checked, \
             patch.object(parity, "validate_parallel_execution_report", return_value=report):
            result = parity.validate_execution_parity(Path("/serial"), Path("/adaptive"))
        self.assertEqual(checked.call_count, 4)
        self.assertEqual(result["status"], "parity_passed_unqualified")
        self.assertEqual(result["concurrency"]["status"], "not_verified")
        self.assertEqual(result["performance_qualification"], "NOT VERIFIED")
        self.assertFalse(result["speedup_claimed"])

    def test_changed_native_evidence_during_comparison_is_rejected(self):
        requests, validations = fixture()
        import hashlib
        raw = b"request"
        called = 0
        def validate(case, request, result):
            nonlocal called
            called += 1
            result = copy.deepcopy(validations[case.parent.name])
            if called > 2:
                result["case_artifact_hashes_sha256"] = "0" * 64
            return result
        with patch.object(parity.probe, "_read_receipt", side_effect=lambda path, label: (path, raw, requests[path.parent.name])), \
             patch.object(parity.probe, "_sha256_file", return_value=(1, hashlib.sha256(raw).hexdigest())), \
             patch.object(parity.probe, "validate_probe_artifacts", side_effect=validate), \
             patch.object(parity, "validate_parallel_execution_report", return_value={"concurrency": {}, "resource_quality": {}}):
            with self.assertRaisesRegex(ValueError, "current artifact validation"):
                parity.validate_execution_parity(Path("/serial"), Path("/adaptive"))


if __name__ == "__main__":
    unittest.main()
