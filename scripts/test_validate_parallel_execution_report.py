"""Interpreted regressions for the adaptive process-pool report validator."""

from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from validate_parallel_execution_report import (  # noqa: E402
    ADMISSION_JOURNAL_SCHEMA,
    REPORT_PROTOCOL_V1,
    REPORT_PROTOCOL_V2,
    ValidationError,
    compare_serial_adaptive_policy,
    validate_parallel_execution_report,
)


PLAN_SHA = "sha256:" + "1" * 64
EQUILIBRIUM_SHA = "sha256:" + "2" * 64
WORKER_SHA = "sha256:" + "3" * 64


def _policy(mode: str = "adaptive") -> dict[str, object]:
    return {
        "mode": mode,
        "max_cpu_percent": 90.0,
        "max_memory_percent": 80.0,
        "memory_reserve_bytes": 1024**3,
        "max_workers": 2,
        "threads_per_worker": 1,
    }


def _snapshot() -> dict[str, object]:
    return {
        "sampled_at_unix_ms": 1_700_000_000_000,
        "allocated_cpu_cores": 8.0,
        "cpu_busy_percent": 12.5,
        "cpu_available_cores": 7.0,
        "memory_limit_bytes": 16 * 1024**3,
        "memory_available_bytes": 14 * 1024**3,
        "allocation_sources": ["cgroup_v2_cpu_max"],
    }


def _event(at_ms: int, active: int, *, peak_cpu: float = 1.0) -> dict[str, object]:
    return {
        "at_unix_ms": at_ms,
        "active_workers": active,
        "pending_samples": max(3 - active, 0),
        "desired_workers": min(active + 1, 2),
        "reason": "calibrated_cpu_memory_headroom",
        "cpu_target_kind": "allocation_soft_target",
        "snapshot": _snapshot(),
        "worker_peak": {
            "cpu_cores": peak_cpu if active else 0.0,
            "rss_bytes": 512 * 1024**2 if active else 0,
        },
    }


def _adaptive_report(
    *,
    events: list[dict[str, object]] | None = None,
    protocol: str = REPORT_PROTOCOL_V1,
) -> dict[str, object]:
    inputs = [
        {
            "sample_index": index,
            "plan_sha256": PLAN_SHA,
            "equilibrium_artifact_sha256": EQUILIBRIUM_SHA,
        }
        for index in range(3)
    ]
    thread_bindings = [
        {
            "sample_index": index,
            "budget": {
                "requested_threads": 1,
                "resolved_threads": 1,
                "cap_reason": "parent_admission_requested_threads",
                "allocation_cpu_cores": 8.0,
                "host_cpu_cores": 8,
            },
        }
        for index in range(3)
    ]
    cpu_observations = [
        {
            "sample_index": index,
            "valid_intervals": 4,
            "observed_seconds": 1.25,
            "demand_source": "periodic_peak_with_terminal_average",
            "sampled_peak_cpu_cores": 1.25,
            "terminal_average_cpu_cores": 0.75,
            "resolved_threads": 1,
            "demand_cpu_cores": 1.25,
        }
        for index in range(3)
    ]
    worker_logs = [
        {
            "sample_index": index,
            "stdout_path": f"/managed/worker-{index}/stdout.log",
            "stderr_path": f"/managed/worker-{index}/stderr.log",
            "handshake_path": f"/managed/worker-{index}/handshake.json",
            "worker_executable_sha256": WORKER_SHA,
            "worker_build_identity": {"profile": "fem-cpu-runtime-v2"},
        }
        for index in range(3)
    ]
    report = {
        "protocol": protocol,
        "requested_mode": "adaptive",
        "resolved_mode": "adaptive_processes",
        "resolved_workers": 2,
        "policy": _policy(),
        "inputs": inputs,
        "thread_bindings": thread_bindings,
        "cpu_observations": cpu_observations,
        "worker_logs": worker_logs,
        "events": events if events is not None else [
            _event(1_700_000_000_000, 0),
            _event(1_700_000_000_100, 1),
            _event(1_700_000_000_200, 2, peak_cpu=2.0),
            _event(1_700_000_000_300, 1),
            _event(1_700_000_000_400, 0),
        ],
        "events_truncated": False,
        "telemetry_reason": None,
    }
    return {
        "schema_version": ADMISSION_JOURNAL_SCHEMA,
        "terminal_state": "completed",
        "events_truncated": False,
        "report": report,
    }


def _serial_report(protocol: str = REPORT_PROTOCOL_V1) -> dict[str, object]:
    adaptive = _adaptive_report(protocol=protocol)
    report = copy.deepcopy(adaptive["report"])
    assert isinstance(report, dict)
    report["requested_mode"] = "serial"
    report["resolved_mode"] = "serial_processes"
    report["resolved_workers"] = 1
    report["policy"] = _policy("serial")
    report["cpu_observations"] = []
    report["events"] = []
    report["events_truncated"] = False
    return {
        "schema_version": ADMISSION_JOURNAL_SCHEMA,
        "terminal_state": "completed",
        "events_truncated": False,
        "report": report,
    }


class ParallelExecutionReportTests(unittest.TestCase):
    def test_completed_adaptive_report_exposes_timestamped_active_count(self) -> None:
        result = validate_parallel_execution_report(_adaptive_report())
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["qualification"], "NOT VERIFIED")
        self.assertEqual(result["counts"]["input_samples"], 3)
        self.assertEqual(result["concurrency"]["status"], "observed_from_active_count")
        self.assertTrue(result["concurrency"]["timestamped_evidence"])
        self.assertEqual(result["concurrency"]["proof_scope"], "point_observation")

    def test_resolved_workers_without_timestamped_overlap_is_not_verified(self) -> None:
        report = _adaptive_report(events=[_event(1_700_000_000_000, 0), _event(1_700_000_000_100, 1)])
        result = validate_parallel_execution_report(report)
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["resolved_workers"], 2)
        self.assertEqual(result["concurrency"]["status"], "not_verified")
        self.assertEqual(result["concurrency"]["availability"], "unavailable")
        self.assertIn("timestamped", result["concurrency"]["reason"])

    def test_truncated_event_history_marks_concurrency_partial(self) -> None:
        report = _adaptive_report()
        report["events_truncated"] = True
        report["report"]["events_truncated"] = True
        result = validate_parallel_execution_report(report)
        self.assertEqual(result["concurrency"]["status"], "observed_from_active_count")
        self.assertEqual(result["concurrency"]["coverage"], "truncated")
        self.assertFalse(result["concurrency"]["complete_history"])

    def test_serial_report_is_valid_without_adaptive_telemetry(self) -> None:
        result = validate_parallel_execution_report(_serial_report())
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["requested_mode"], "serial")
        self.assertEqual(result["concurrency"]["status"], "not_applicable")
        self.assertEqual(result["resource_quality"]["status"], "not_applicable")

    def test_v2_serial_report_uses_same_strict_process_report_shape(self) -> None:
        result = validate_parallel_execution_report(_serial_report(REPORT_PROTOCOL_V2))
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["requested_mode"], "serial")
        self.assertEqual(result["source_schema"], ADMISSION_JOURNAL_SCHEMA)

    def test_direct_public_report_does_not_invent_terminal_completion(self) -> None:
        journal = _adaptive_report()
        direct = journal["report"]
        result = validate_parallel_execution_report(direct)
        self.assertEqual(result["status"], "not_verified")
        self.assertEqual(result["completion_evidence"]["status"], "not_verified")
        self.assertIn("no terminal_state", result["completion_evidence"]["reason"])

    def test_supported_v1_and_v2_protocols_keep_direct_completion_unverified(self) -> None:
        for protocol in (REPORT_PROTOCOL_V1, REPORT_PROTOCOL_V2):
            journal = _adaptive_report(protocol=protocol)
            wrapped = validate_parallel_execution_report(journal)
            self.assertEqual(wrapped["status"], "pass")
            self.assertEqual(wrapped["schema"], "fullmag.parallel-execution-report.v1")

            direct = validate_parallel_execution_report(journal["report"])
            self.assertEqual(direct["status"], "not_verified")
            self.assertEqual(direct["source_schema"], protocol)
            self.assertEqual(direct["completion_evidence"]["status"], "not_verified")
            self.assertIn("no terminal_state", direct["completion_evidence"]["reason"])

    def test_unknown_worker_protocol_is_rejected_for_journal_and_direct_report(self) -> None:
        journal = _adaptive_report(protocol="fullmag.eigen_k_worker.v3")
        with self.assertRaisesRegex(ValidationError, "unsupported report.protocol"):
            validate_parallel_execution_report(journal)
        with self.assertRaisesRegex(ValidationError, "unsupported report.protocol"):
            validate_parallel_execution_report(journal["report"])

    def test_failed_journal_does_not_publish_completed_completion_evidence(self) -> None:
        report = _adaptive_report()
        report["terminal_state"] = "failed"
        result = validate_parallel_execution_report(report)
        self.assertEqual(result["status"], "not_verified")
        self.assertEqual(result["completion_evidence"]["status"], "not_verified")
        self.assertIn("terminal_state=failed", result["completion_evidence"]["reason"])

    def test_policy_comparison_requires_same_inputs_and_limits(self) -> None:
        result = compare_serial_adaptive_policy(_serial_report(), _adaptive_report())
        self.assertEqual(result["status"], "pass")
        self.assertTrue(result["input_binding_match"])
        self.assertTrue(result["policy_match"])

        changed = _adaptive_report()
        changed["report"]["policy"]["threads_per_worker"] = 2
        for binding in changed["report"]["thread_bindings"]:
            binding["budget"]["requested_threads"] = 2
            binding["budget"]["resolved_threads"] = 2
        for observation in changed["report"]["cpu_observations"]:
            observation["resolved_threads"] = 2
        with self.assertRaisesRegex(ValidationError, "policy fields differ"):
            compare_serial_adaptive_policy(_serial_report(), changed)

    def test_missing_sample_observation_is_rejected_for_completed_adaptive_run(self) -> None:
        report = _adaptive_report()
        report["report"]["cpu_observations"] = report["report"]["cpu_observations"][:-1]
        with self.assertRaisesRegex(ValidationError, "cpu_observations sample set"):
            validate_parallel_execution_report(report)

    def test_cpu_observation_bounds_and_thread_binding_are_consistent(self) -> None:
        report = _adaptive_report()
        report["report"]["cpu_observations"][0]["observed_seconds"] = 4.1
        with self.assertRaisesRegex(ValidationError, "one-second-per-interval"):
            validate_parallel_execution_report(report)

        report = _adaptive_report()
        report["report"]["cpu_observations"][0]["valid_intervals"] = 0
        report["report"]["cpu_observations"][0]["observed_seconds"] = 0.1
        with self.assertRaisesRegex(ValidationError, "must be zero"):
            validate_parallel_execution_report(report)

        report = _adaptive_report()
        report["report"]["policy"]["threads_per_worker"] = 2
        for binding in report["report"]["thread_bindings"]:
            binding["budget"]["requested_threads"] = 2
            binding["budget"]["resolved_threads"] = 2
        with self.assertRaisesRegex(ValidationError, "differs from its thread binding"):
            validate_parallel_execution_report(report)

        report = _adaptive_report()
        observation = report["report"]["cpu_observations"][0]
        observation["demand_source"] = "resolved_team_envelope_with_terminal_average"
        observation["sampled_peak_cpu_cores"] = 0.25
        observation["terminal_average_cpu_cores"] = 0.25
        observation["demand_cpu_cores"] = 0.5
        with self.assertRaisesRegex(ValidationError, "resolved_threads envelope"):
            validate_parallel_execution_report(report)

    def test_nonfinite_resource_and_boolean_integer_are_rejected(self) -> None:
        report = _adaptive_report()
        report["report"]["events"][1]["snapshot"]["allocated_cpu_cores"] = float("nan")
        with self.assertRaisesRegex(ValidationError, "allocated_cpu_cores"):
            validate_parallel_execution_report(report)

        report = _adaptive_report()
        report["report"]["resolved_workers"] = True
        with self.assertRaisesRegex(ValidationError, "resolved_workers"):
            validate_parallel_execution_report(report)

    def test_event_history_is_bounded(self) -> None:
        report = _adaptive_report(events=[_event(index, 0) for index in range(2049)])
        with self.assertRaisesRegex(ValidationError, "events exceed"):
            validate_parallel_execution_report(report)

    def test_report_with_worker_pressure_is_structurally_valid_but_not_verified(self) -> None:
        report = _adaptive_report()
        report["report"]["events"][2]["worker_peak"]["rss_bytes"] = 17 * 1024**3
        result = validate_parallel_execution_report(report)
        self.assertEqual(result["status"], "not_verified")
        self.assertEqual(result["resource_quality"]["status"], "not_verified")
        self.assertIn("memory", result["resource_quality"]["reason"])


if __name__ == "__main__":
    unittest.main()
