import copy
import json
import tempfile
import unittest
from pathlib import Path

from scripts.build_frozen_spins_performance_evidence import (
    BENCHMARK_SCHEMA,
    EvidenceError,
    REQUIRED_CASE_IDS,
    SUPPLEMENTAL_CASE_IDS,
    build_evidence,
    run,
)


ROOT = Path(__file__).resolve().parents[1]
POLICY_PATH = ROOT / "crates" / "fullmag-bench" / "qualification" / "frozen_spins_performance_thresholds.v1.json"
POLICY = json.loads(POLICY_PATH.read_text(encoding="utf-8"))


def _layout_comparison():
    return {
        "no_mask_layout": "soa",
        "partial_mask_layout": "aos",
        "matched_layout_mask_isolation": "not_measured",
        "interpretation": "The ratio is an end-to-end production-path comparison; it is not an isolated mask-only overhead measurement.",
    }


def _case(site_count, mode):
    partial = mode == "partial_mask"
    return {
        "site_count": site_count,
        "mode": mode,
        "execution_layout": "aos" if partial else "soa",
        "frozen_site_count": (site_count + 3) // 4 if partial else 0,
        "free_site_count": site_count - ((site_count + 3) // 4 if partial else 0),
        "repetitions": 5,
        "steps_per_sample": 2,
        "warmup_steps": 2,
        "step_wall_time_ns": [1800, 1900, 1850, 1880, 1830]
        if partial
        else [1000, 1100, 1050, 1080, 1030],
        "activation_wall_time_ns": [100000, 101000, 99000, 100500, 100250]
        if partial
        else [],
        "activation_allocation_count": [1, 1, 1, 1, 1] if partial else [],
        "activation_allocated_bytes": [256, 256, 256, 256, 256] if partial else [],
        "steady_state_allocation_count": [0, 0, 0, 0, 0],
        "steady_state_allocated_bytes": [0, 0, 0, 0, 0],
        "mask_bytes": site_count if partial else 0,
        "mask_bytes_semantics": "logical_dense_u8_payload" if partial else "not_applicable",
        "host_mask_storage_type": "Vec<bool>" if partial else "none",
        "host_mask_exact_allocated_bytes": None if partial else 0,
        "host_mask_exact_allocated_bytes_status": "NOT_OBSERVABLE"
        if partial
        else "NOT_APPLICABLE",
        "reference_bytes": site_count * 24 if partial else 0,
        "reference_bytes_semantics": "logical_vec_payload" if partial else "not_applicable",
        "storage_bytes": site_count * 25 if partial else 0,
        "storage_bytes_semantics": "logical_dense_payload_sum" if partial else "not_applicable",
    }


def valid_benchmark(site_counts=(4096, 1_000_000)):
    return {
        "schema_version": BENCHMARK_SCHEMA,
        "policy_schema_version": POLICY["schema_version"],
        "benchmark_id": "FS-P15-FDM-CPU-PERFORMANCE-V1",
        "status": "MEASUREMENT_COMPLETED",
        "acceptance_status": "NOT_EVALUATED",
        "implementation_status": "EXECUTED",
        "plan_provenance": "synthetic_deterministic_performance_plan",
        "plan_validation": "validate_intrinsic_before_runtime_capture",
        "lane": {
            "backend": "fdm",
            "execution": "cpu_reference",
            "precision": "double",
            "integrator": "heun",
            "evaluation": "minimal",
            "terms": "none",
            "fallback_used": False,
        },
        "benchmark": {
            "site_counts_requested": list(site_counts),
            "repetitions": 5,
            "steps_per_sample": 2,
            "warmup_steps": 2,
            "partial_mask_stride": 4,
            "partial_mask_fraction": 0.25,
            "comparison_scope": "end_to_end_runtime_overhead_including_layout_dispatch",
            "layout_comparison": _layout_comparison(),
            "activation_timing_scope": "FrozenSpinsState::capture_at_activation",
            "step_timing_scope": "public_reusable_buffer_production_routes",
            "step_routes": {
                "no_mask": "ExchangeLlgProblem::step_soa_with_buffers_evaluation+ExchangeLlgStateSoA::publish_accepted_to",
                "partial_mask": "ExchangeLlgProblem::step_with_buffers_evaluation",
            },
            "workspace_scope": "inert_single_cell_no_demag",
            "dt_s": 1.0e-15,
            "cell_size_m": [5.0e-9, 5.0e-9, 5.0e-9],
        },
        "cases": [
            case
            for site_count in site_counts
            for case in (_case(site_count, "no_mask"), _case(site_count, "partial_mask"))
        ],
        "runtime": {
            "run_id": "frozen-spins-fdm-cpu-performance-test-1",
            "hostname": "test-host",
            "rayon_threads": 48,
            "thread_policy": {
                "schema_version": "fullmag.frozen_spins.performance_thread_policy.v1",
                "lane": "production_default",
                "environment_variable": "RAYON_NUM_THREADS",
                "environment_value": None,
                "requested_rayon_threads": None,
                "observed_rayon_threads": 48,
                "role": "required_production_gate",
            },
            "clock": "std::time::Instant::monotonic",
            "source_identity": {
                "status": "NOT_BOUND",
                "git_commit": None,
                "dirty_tree": None,
                "reason": "test fixture leaves source identity unbound",
            },
            "binary_identity": {
                "package": "fullmag-bench",
                "executable": "fullmag-bench",
                "profile": "release",
                "target_os": "windows",
                "path": "C:/git/fullmag/fullmag/target/release/fullmag-bench.exe",
                "size_bytes": 1,
                "sha256": "0" * 64,
            },
        },
    }


class FrozenSpinsPerformanceEvidenceTests(unittest.TestCase):
    def test_valid_cpu_receipt_is_scoped_and_does_not_claim_gpu_or_full_p15(self):
        evidence = build_evidence(valid_benchmark(), POLICY)
        self.assertEqual(evidence["status"], "PASS")
        self.assertEqual(evidence["qualification_status"], "UNQUALIFIED")
        self.assertEqual(evidence["test_case_ids"], list(SUPPLEMENTAL_CASE_IDS))
        self.assertEqual(evidence["global_case_ids_not_claimed"], list(REQUIRED_CASE_IDS))
        self.assertTrue(evidence["partial_coverage"])
        self.assertEqual(evidence["p15_coverage"]["full_p15_status"], "INCOMPLETE")
        self.assertEqual(
            evidence["configuration"]["layout_comparison"]["matched_layout_mask_isolation"],
            "not_measured",
        )
        self.assertEqual(evidence["p15_coverage"]["preview_wall_time"]["status"], "NOT_MEASURED")
        self.assertEqual(evidence["gpu_transfer_metrics"]["status"], "NOT_APPLICABLE")
        self.assertEqual(evidence["metrics"]["million_site"]["site_count"], 1_000_000)
        self.assertEqual(
            evidence["metrics"]["steady_state_allocation_budget"]["max_observed_allocation_count"],
            0,
        )
        self.assertEqual(
            evidence["configuration"]["thread_policy"]["lane"],
            "production_default",
        )

    def test_missing_million_site_fails_closed(self):
        with self.assertRaisesRegex(EvidenceError, "required >= 1000000"):
            build_evidence(valid_benchmark((4096, 999_999)), POLICY)

    def test_layout_claim_must_explicitly_reject_mask_only_interpretation(self):
        benchmark = valid_benchmark()
        benchmark["benchmark"]["layout_comparison"]["interpretation"] = "mask overhead"
        with self.assertRaisesRegex(EvidenceError, "must reject mask-only overhead claims"):
            build_evidence(benchmark, POLICY)

    def test_ratio_activation_and_storage_fail_closed(self):
        cases = [
            ("ratio", lambda benchmark: benchmark["cases"][1]["step_wall_time_ns"].__setitem__(0, 10000), "p95 ratio"),
            ("activation", lambda benchmark: benchmark["cases"][1].update({"activation_wall_time_ns": [], "activation_allocation_count": [], "activation_allocated_bytes": []}), "activation_wall_time_ns length"),
            ("activation budget", lambda benchmark: benchmark["cases"][1]["activation_allocated_bytes"].__setitem__(0, 1_000_000), "activation allocated bytes exceed policy"),
            ("storage", lambda benchmark: benchmark["cases"][1].__setitem__("reference_bytes", 1), "reference_bytes does not match"),
            ("storage semantics", lambda benchmark: benchmark["cases"][1].__setitem__("mask_bytes_semantics", "physical_host_bytes"), "logical dense-u8 payload"),
        ]
        for name, mutate, expected in cases:
            with self.subTest(name=name):
                benchmark = valid_benchmark()
                mutate(benchmark)
                with self.assertRaisesRegex(EvidenceError, expected):
                    build_evidence(benchmark, POLICY)

    def test_identity_and_top_level_binding_fail_closed(self):
        mutations = [
            ("benchmark_id", lambda benchmark: benchmark.__setitem__("benchmark_id", "wrong"), "benchmark ID mismatch"),
            ("policy schema", lambda benchmark: benchmark.__setitem__("policy_schema_version", "wrong"), "policy schema does not match"),
            ("run ID", lambda benchmark: benchmark["runtime"].__setitem__("run_id", ""), "runtime.run_id"),
            ("source status", lambda benchmark: benchmark["runtime"]["source_identity"].__setitem__("status", "CLEAN"), "source identity must remain NOT_BOUND"),
            ("binary profile", lambda benchmark: benchmark["runtime"]["binary_identity"].__setitem__("profile", "debug"), "requires release profile"),
            ("binary path", lambda benchmark: benchmark["runtime"]["binary_identity"].__setitem__("path", "relative.exe"), "path must be absolute"),
            ("binary size", lambda benchmark: benchmark["runtime"]["binary_identity"].__setitem__("size_bytes", 0), "size_bytes"),
            ("binary SHA", lambda benchmark: benchmark["runtime"]["binary_identity"].__setitem__("sha256", "not-a-sha"), "sha256"),
            ("thread policy lane", lambda benchmark: benchmark["runtime"]["thread_policy"].__setitem__("lane", "unqualified"), "not qualified"),
            ("thread policy observed count", lambda benchmark: benchmark["runtime"]["thread_policy"].__setitem__("observed_rayon_threads", 1), "observed count differs"),
        ]
        for name, mutate, expected in mutations:
            with self.subTest(name=name):
                benchmark = valid_benchmark()
                mutate(benchmark)
                with self.assertRaisesRegex(EvidenceError, expected):
                    build_evidence(benchmark, POLICY)

    def test_serial_thread_lane_is_supplemental_and_cannot_close_gate(self):
        benchmark = valid_benchmark()
        benchmark["runtime"]["rayon_threads"] = 1
        benchmark["runtime"]["thread_policy"] = {
            "schema_version": "fullmag.frozen_spins.performance_thread_policy.v1",
            "lane": "serial_deterministic_supplemental",
            "environment_variable": "RAYON_NUM_THREADS",
            "environment_value": "1",
            "requested_rayon_threads": 1,
            "observed_rayon_threads": 1,
            "role": "supplemental_microbenchmark_only",
        }
        with self.assertRaisesRegex(EvidenceError, "supplemental only"):
            build_evidence(benchmark, POLICY)

    def test_gpu_transfer_fields_are_rejected_in_raw_benchmark(self):
        benchmark = valid_benchmark()
        benchmark["gpu_transfer_metrics"] = {"h2d_bytes": 0}
        with self.assertRaisesRegex(EvidenceError, "GPU transfer metric"):
            build_evidence(benchmark, POLICY)

    def test_duplicate_case_fails_closed(self):
        benchmark = valid_benchmark()
        benchmark["cases"].append(copy.deepcopy(benchmark["cases"][0]))
        with self.assertRaisesRegex(EvidenceError, "duplicate performance case"):
            build_evidence(benchmark, POLICY)

    def test_cli_writes_atomic_evidence_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            directory_path = Path(directory)
            benchmark_path = directory_path / "benchmark.json"
            policy_path = directory_path / "policy.json"
            output_path = directory_path / "evidence.json"
            benchmark_path.write_text(
                json.dumps(valid_benchmark()), encoding="utf-8", newline="\n"
            )
            policy_path.write_text(
                json.dumps(POLICY), encoding="utf-8", newline="\n"
            )
            self.assertEqual(
                run(
                    [
                        "--benchmark",
                        str(benchmark_path),
                        "--policy",
                        str(policy_path),
                        "--output",
                        str(output_path),
                    ]
                ),
                0,
            )
            self.assertEqual(
                run(
                    [
                        "--benchmark",
                        str(benchmark_path),
                        "--policy",
                        str(policy_path),
                        "--output",
                        str(output_path),
                    ]
                ),
                0,
            )
            receipt = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(receipt["schema_version"], "fullmag.frozen_spins.fdm_cpu.performance.evidence.v1")
            self.assertEqual(receipt["test_case_ids"], list(SUPPLEMENTAL_CASE_IDS))
            self.assertEqual(receipt["global_case_ids_not_claimed"], list(REQUIRED_CASE_IDS))
            self.assertEqual(receipt["p15_coverage"]["full_p15_status"], "INCOMPLETE")


if __name__ == "__main__":
    unittest.main()
