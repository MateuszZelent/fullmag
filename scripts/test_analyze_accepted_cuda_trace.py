"""Bounded trace interpretation; no CUDA or solver execution."""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts import analyze_accepted_cuda_trace as trace_analyzer
from scripts.analyze_accepted_cuda_trace import analyze, TraceError


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


class AcceptedCudaTraceTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.identity = {"schema_version": "fullmag.accepted_worker_execution.v1", "claim": {
            "run_id": "run-1", "task_id": "task-1", "attempt_id": "attempt-1", "ownership_epoch": 1,
            "lease": {"kind": "gpu", "lease_token": "lease-1"}}, "start_message_id": "start-1",
            "start_sequence": 1, "case_id": "default", "plan_fingerprint": "a" * 64}
        config = {"schema_version": "accepted_cuda_trace.v1", "max_bytes": 67108864, "max_duration_ms": 60000}
        self.receipt = {"schema_version": "worker_cuda_trace.v1", "identity": self.identity,
            "config": config, "config_sha256": hashlib.sha256(encoded(config)).hexdigest(),
            "worker_pid": 42, "gpu_uuid": "GPU-test", "solver_outcome": "completed", "status": "complete",
            "trace_file": "worker_cuda_trace.v1.ndjson", "native": {"status_code": 0, "stats": {
                "schema_version": 1, "cupti_version": 24, "start_timestamp_ns": 100, "end_timestamp_ns": 300,
                **{key: 0 for key in ("records_written", "bytes_written", "dropped_records", "buffer_starvations",
                    "unknown_records", "truncated_names", "incomplete_records", "api_errors", "io_errors", "limit_flags")}}},
            "start_wall_seconds": 0.001, "stop_wall_seconds": 0.002, "total_wall_seconds": 0.2,
            "overhead_scope": "start/stop only", "errors": []}
        self.header = {"type": "header", "schema": "worker_cuda_trace.v1", "timestamp_domain": "cupti_activity_ns",
            "cupti_api_version": 24, "max_bytes": config["max_bytes"], "max_duration_ms": config["max_duration_ms"],
            "activity_kinds": ["driver_api", "runtime_api", "kernel", "memcpy", "memset", "synchronization", "memory"]}

    def event(self, kind, start, end, name="example", **kwargs):
        return {"type": "activity", "kind": kind, "timestamp_domain": "cupti_activity_ns", "start_ns": start,
            "end_ns": end, "duration_ns": end - start, "timestamps_valid": True,
            "correlation_id": 1, "runtime_correlation_id": 0, "activity_kind": 1,
            "process_id": 42 if kind.endswith("api") else None, "thread_id": None,
            "device_id": 0 if kind in {"kernel", "memcpy", "memset"} else None,
            "context_id": None, "stream_id": None, "bytes": None, "address": None,
            "return_value": None, "operation_kind": None, "name": name, "name_truncated": False, **kwargs}

    def publish(self, events):
        raw = b"".join(encoded(value) + b"\n" for value in [self.header, *events])
        (self.root / self.receipt["trace_file"]).write_bytes(raw)
        self.receipt["trace_size_bytes"] = len(raw)
        self.receipt["trace_sha256"] = hashlib.sha256(raw).hexdigest()
        self.receipt["native"]["stats"].update(records_written=len(events), bytes_written=len(raw))
        self.save_receipt()
        (self.root / "worker_execution_started.v1.json").write_bytes(encoded({"identity": self.identity}))

    def save_receipt(self):
        version = self.receipt["schema_version"]
        name = "worker_cuda_trace.v2.json" if version == "worker_cuda_trace.v2" else "worker_cuda_trace.v1.json"
        (self.root / name).write_bytes(encoded(self.receipt))

    def read(self, **overrides):
        return analyze(self.root, **({"run_id": "run-1", "attempt_id": "attempt-1", "worker_pid": 42, "gpu_uuid": "GPU-test"} | overrides))

    def use_attested_clock(self, clock_source="clock_monotonic"):
        self.receipt["native"]["stats"]["cupti_version"] = 28
        self.header["cupti_api_version"] = 28
        if "cuda_event_metadata" not in self.header["activity_kinds"]:
            self.header["activity_kinds"].append("cuda_event_metadata")
        self.header["clock_source"] = clock_source
        self.header["timestamp_callback_registered"] = True

    def configure_v2(self):
        window = {"start_after_step": 16, "end_after_step": 32}
        config = {"schema_version": "accepted_cuda_trace.v2", "max_bytes": 67108864,
                  "max_duration_ms": 60000, "accepted_step_window": window}
        self.receipt["schema_version"] = "worker_cuda_trace.v2"
        self.receipt.update(status="complete", solver_outcome="completed", errors=[])
        self.receipt["config"] = config
        self.receipt["config_sha256"] = hashlib.sha256(encoded(config)).hexdigest()
        self.receipt["accepted_step_window"] = {
            **window, "observed_start_step": 16, "observed_end_step": 32,
            "observed_start_time_s": 1.0e-12, "observed_end_time_s": 2.0e-12,
            "completed": True, "completion_reason": "completed", "capture_wall_seconds": 1.2,
        }
        self.receipt["native"] = {"status_code": 0, "stats": {
            "schema_version": 1, "cupti_version": 28, "start_timestamp_ns": 1_000_000_000,
            "end_timestamp_ns": 2_000_000_000,
            **{key: 0 for key in ("records_written", "bytes_written", "dropped_records",
                "buffer_starvations", "unknown_records", "truncated_names", "incomplete_records",
                "api_errors", "io_errors", "limit_flags")}}}
        self.use_attested_clock()
        self.receipt["start_wall_seconds"] = 0.1
        self.receipt["stop_wall_seconds"] = 0.1
        self.receipt["total_wall_seconds"] = 2.0

    def publish_without_capture(self, trace_bytes=b""):
        (self.root / self.receipt["trace_file"]).write_bytes(trace_bytes)
        self.receipt["trace_size_bytes"] = len(trace_bytes)
        self.receipt["trace_sha256"] = hashlib.sha256(trace_bytes).hexdigest()
        self.save_receipt()
        (self.root / "worker_execution_started.v1.json").write_bytes(encoded({"identity": self.identity}))

    def set_capture_window(self, start, end, total_wall_seconds):
        self.receipt["native"]["stats"].update(start_timestamp_ns=start, end_timestamp_ns=end)
        self.receipt["total_wall_seconds"] = total_wall_seconds

    def test_legacy_api24_and_api28_headers_remain_readable_but_time_is_unverified(self):
        self.publish([self.event("kernel", 110, 180)])
        api24 = self.read()
        self.assertEqual(api24["status"], "complete")
        self.assertEqual(api24["capture_scope"], {"kind": "whole_runner"})
        self.assertEqual(set(api24["host_timing"]), {"start_wall_seconds", "stop_wall_seconds", "total_wall_seconds"})
        self.assertEqual(api24["interpretation"], (
            "Observed interval unions are not hardware utilization. API, GPU and synchronization times overlap. "
            "Activity time aggregates remain clipped to the native capture window and are unqualified unless "
            "timing_qualification.status is 'passed'; consumers must gate on that status. Host timings exclude "
            "callback overhead; measure it with matched on/off runs."
        ))
        self.assertEqual(api24["timing_qualification"]["status"], "not_verified")
        self.assertIsNone(api24["timing_qualification"]["clock_source"])

        self.receipt["native"]["stats"]["cupti_version"] = 28
        self.header["cupti_api_version"] = 28
        self.header["activity_kinds"].append("cuda_event_metadata")
        self.publish([self.event("kernel", 110, 180)])
        api28 = self.read()
        self.assertEqual(api28["status"], "complete")
        self.assertEqual(api28["capture_scope"], {"kind": "whole_runner"})
        self.assertEqual(api28["timing_qualification"]["status"], "not_verified")
        self.assertIsNone(api28["timing_qualification"]["clock_source"])

    def test_monotonic_clock_with_complete_in_bounds_capture_passes(self):
        self.use_attested_clock()
        self.set_capture_window(1_000_000_000, 2_000_000_000, 1.2)
        self.publish([self.event("kernel", 1_100_000_000, 1_800_000_000)])

        result = self.read()
        qualification = result["timing_qualification"]
        self.assertEqual(qualification["status"], "passed")
        self.assertEqual(qualification["clock_source"], "clock_monotonic")
        self.assertEqual(qualification["reasons"], [])
        self.assertEqual(qualification["evidence"]["capture_duration_ns"], 1_000_000_000)
        self.assertEqual(qualification["evidence"]["total_wall_seconds"], 1.2)

    def test_historical_monotonic_raw_header_is_readable_but_not_timing_qualified(self):
        self.use_attested_clock("clock_monotonic_raw")
        self.set_capture_window(1_000_000_000, 26_071_720_495, 23.388822552)
        self.publish([self.event("kernel", 2_000_000_000, 2_100_000_000)])

        result = self.read()
        qualification = result["timing_qualification"]
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["solver_outcome"], "completed")
        self.assertEqual(qualification["clock_source"], "clock_monotonic_raw")
        self.assertEqual(qualification["status"], "not_verified")
        self.assertIn("clock_domain_differs_from_host", qualification["reasons"])
        self.assertIn("capture_duration_exceeds_host_window", qualification["reasons"])
        self.assertEqual(qualification["evidence"]["out_of_bounds_timed_records"], 0)

    def test_historical_monotonic_raw_clock_is_never_passed(self):
        self.use_attested_clock("clock_monotonic_raw")
        self.set_capture_window(1_000_000_000, 2_000_000_000, 1.2)
        self.publish([self.event("kernel", 1_100_000_000, 1_800_000_000)])

        qualification = self.read()["timing_qualification"]
        self.assertEqual(qualification["status"], "not_verified")
        self.assertIn("clock_domain_differs_from_host", qualification["reasons"])

    def test_out_of_bounds_records_are_unverified_even_without_native_drops(self):
        self.use_attested_clock()
        self.publish([self.event("kernel", 50, 120), self.event("kernel", 280, 350)])

        result = self.read()
        qualification = result["timing_qualification"]
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["native"]["stats"]["dropped_records"], 0)
        self.assertEqual(qualification["status"], "not_verified")
        self.assertEqual(qualification["evidence"]["out_of_bounds_timed_records"], 2)
        self.assertEqual(qualification["evidence"]["max_before_ns"], 50)
        self.assertEqual(qualification["evidence"]["max_after_ns"], 50)
        self.assertEqual(result["clipped_records"], 2)
        self.assertEqual(result["kinds"]["kernel"]["summed_duration_ns"], 40)

    def test_capture_duration_must_fit_host_window_with_one_millisecond_tolerance(self):
        self.use_attested_clock()
        self.set_capture_window(1, 10_000_001, 0.001)
        self.publish([self.event("kernel", 100, 200)])

        qualification = self.read()["timing_qualification"]
        self.assertEqual(qualification["status"], "not_verified")
        self.assertIn("capture_duration_exceeds_host_window", qualification["reasons"])
        self.assertEqual(qualification["evidence"]["duration_tolerance_ns"], 1_000_000)

    def test_invalid_timed_records_and_incomplete_capture_are_unverified(self):
        self.use_attested_clock()
        self.receipt.update(status="partial", solver_outcome="cancelled")
        self.receipt["native"]["stats"]["incomplete_records"] = 1
        self.publish([self.event("kernel", 0, 0, timestamps_valid=False, timestamp_status="incomplete")])

        result = self.read()
        qualification = result["timing_qualification"]
        self.assertEqual(result["status"], "partial")
        self.assertEqual(qualification["status"], "not_verified")
        self.assertEqual(qualification["evidence"]["invalid_timed_records"], 1)
        self.assertIn("capture_not_complete", qualification["reasons"])
        self.assertIn("invalid_timed_records", qualification["reasons"])

    def test_unknown_false_incomplete_and_extra_clock_header_fields_refuse(self):
        base = dict(self.header)
        cases = [
            (28, {"clock_source": "clock_monotonic", "timestamp_callback_registered": False}, "false callback"),
            (28, {"clock_source": "clock_monotonic", "timestamp_callback_registered": 1}, "numeric callback"),
            (28, {"clock_source": "clock_monotonic"}, "incomplete pair"),
            (28, {"clock_source": "unknown_clock", "timestamp_callback_registered": True}, "unknown clock"),
            (28, {"clock_source": "clock_monotonic_raw", "timestamp_callback_registered": False}, "false callback"),
            (28, {"clock_source": "clock_monotonic_raw", "timestamp_callback_registered": 1}, "numeric callback"),
            (28, {"clock_source": "clock_monotonic_raw"}, "incomplete pair"),
            (28, {"timestamp_callback_registered": True}, "incomplete pair"),
            (28, {"clock_source": "clock_monotonic_raw", "timestamp_callback_registered": True,
                  "unexpected": True}, "extra field"),
            (24, {"clock_source": "clock_monotonic_raw", "timestamp_callback_registered": True}, "API24 pair"),
        ]
        for version, additions, label in cases:
            with self.subTest(label=label):
                self.receipt["native"]["stats"]["cupti_version"] = version
                activity_kinds = list(base["activity_kinds"])
                if version == 28 and "cuda_event_metadata" not in activity_kinds:
                    activity_kinds.append("cuda_event_metadata")
                self.header = {**base, "cupti_api_version": version, "activity_kinds": activity_kinds, **additions}
                self.publish([self.event("kernel", 110, 180)])
                with self.assertRaisesRegex(TraceError, "header"):
                    self.read()

    def test_overlapping_kernels_and_nested_apis_are_not_added_as_utilization(self):
        self.publish([self.event("kernel", 110, 180), self.event("kernel", 150, 220),
            self.event("runtime_api", 105, 240, "cudaLaunchKernel"),
            self.event("driver_api", 120, 200, "cuLaunchKernel"),
            self.event("memcpy", 200, 250, "device_to_host", bytes=4096, operation_kind=2)])
        result = self.read()
        self.assertEqual(result["kinds"]["kernel"]["summed_duration_ns"], 140)
        self.assertEqual(result["kinds"]["kernel"]["union_ns"], 110)
        self.assertEqual(result["observed_gpu_union_ns"], 140)
        self.assertEqual(result["host_api_union_ns"], 135)
        self.assertEqual(result["names"]["memcpy"]["device_to_host"]["bytes"], 4096)
        self.assertNotIn("gpu_utilization", result)

    def test_api28_requires_matching_receipt_and_complete_activity_header(self):
        self.receipt["native"]["stats"]["cupti_version"] = 28
        self.header["cupti_api_version"] = 28
        self.header["activity_kinds"].append("cuda_event_metadata")
        self.publish([self.event("kernel", 110, 180)])
        self.assertEqual(self.read()["status"], "complete")
        self.header["cupti_api_version"] = 24
        self.publish([self.event("kernel", 110, 180)])
        with self.assertRaisesRegex(TraceError, "header"):
            self.read()
        self.header["cupti_api_version"] = 28
        self.header["activity_kinds"].remove("cuda_event_metadata")
        self.publish([self.event("kernel", 110, 180)])
        with self.assertRaisesRegex(TraceError, "header"):
            self.read()
        self.receipt["native"]["stats"]["cupti_version"] = 27
        self.save_receipt()
        with self.assertRaisesRegex(TraceError, "unsupported native trace version"):
            self.read()

    def test_hash_identity_config_and_size_mismatches_refuse(self):
        self.publish([self.event("kernel", 110, 180)])
        for key, bad in [("trace_sha256", "0" * 64), ("trace_size_bytes", True),
            ("config_sha256", "f" * 64), ("trace_file", "../outside"), ("worker_pid", 43)]:
            original = self.receipt[key]
            self.receipt[key] = bad; self.save_receipt()
            with self.subTest(key=key), self.assertRaises(TraceError): self.read()
            self.receipt[key] = original; self.save_receipt()
        with self.assertRaises(TraceError): self.read(attempt_id="attempt-other")
        with self.assertRaises(TraceError): self.read(gpu_uuid="GPU-other")
        (self.root / "worker_execution_started.v1.json").write_bytes(encoded({"identity": {}}))
        with self.assertRaises(TraceError): self.read()

    def test_512_mib_boundary_is_accepted_without_large_reads_or_allocation(self):
        self.receipt["config"]["max_bytes"] = 536870912
        self.receipt["config_sha256"] = hashlib.sha256(encoded(self.receipt["config"])).hexdigest()
        self.header["max_bytes"] = 536870912
        self.publish([self.event("kernel", 110, 180)])

        real_regular = trace_analyzer.regular
        requested_line_sizes = []

        @contextmanager
        def guarded_regular(path, limit):
            with real_regular(path, limit) as (stream, size):
                if Path(path).name != self.receipt["trace_file"]:
                    yield stream, size
                    return

                class ReadlineOnly:
                    def readline(_self, size=-1):
                        requested_line_sizes.append(size)
                        if size < 0 or size > trace_analyzer.MAX_LINE_BYTES + 1:
                            raise AssertionError("trace reader requested an unbounded line")
                        return stream.readline(size)

                yield ReadlineOnly(), size

        with patch.object(trace_analyzer, "regular", guarded_regular):
            result = self.read()

        self.assertEqual(result["records"], 1)
        self.assertTrue(requested_line_sizes)
        self.assertEqual(set(requested_line_sizes), {trace_analyzer.MAX_LINE_BYTES + 1})

    def test_analyzer_rejects_byte_budget_one_byte_above_512_mib(self):
        self.publish([self.event("kernel", 110, 180)])
        self.receipt["config"]["max_bytes"] = 536870913
        self.receipt["config_sha256"] = hashlib.sha256(encoded(self.receipt["config"])).hexdigest()
        self.save_receipt()
        with self.assertRaisesRegex(TraceError, "invalid byte budget"):
            self.read()

    def test_complete_large_metadata_trace_exceeds_old_record_cap_without_large_file(self):
        # A complete native trace can contain over one million short records
        # within 512 MiB. Generate its byte stream lazily rather than writing it.
        count = 1_000_001
        self.receipt["config"]["max_bytes"] = 536870912
        self.receipt["config_sha256"] = hashlib.sha256(encoded(self.receipt["config"])).hexdigest()
        self.header["max_bytes"] = 536870912
        self.header["activity_kinds"].append("cuda_event_metadata")
        event = self.event("cuda_event_metadata", 0, 0, "cuda_event_record",
            timestamps_valid=False, timestamp_status="not_applicable", activity_kind=36,
            event_id=1234567, context_id=1, stream_id=7)
        self.publish([event])
        header, record = encoded(self.header) + b"\n", encoded(event) + b"\n"
        size = len(header) + count * len(record)
        self.assertLessEqual(size, self.receipt["config"]["max_bytes"])
        digest = hashlib.sha256(header)
        for _ in range(count):
            digest.update(record)
        self.receipt.update(trace_size_bytes=size, trace_sha256=digest.hexdigest())
        self.receipt["native"]["stats"].update(records_written=count, bytes_written=size)
        self.save_receipt()
        real_regular = trace_analyzer.regular

        @contextmanager
        def virtual_regular(path, limit):
            if Path(path).name != self.receipt["trace_file"]:
                with real_regular(path, limit) as value:
                    yield value
                return

            class RepeatedLines:
                index = -1

                def readline(_self, bound):
                    self.assertEqual(bound, trace_analyzer.MAX_LINE_BYTES + 1)
                    _self.index += 1
                    return header if _self.index == 0 else record if _self.index <= count else b""

            yield RepeatedLines(), size

        with patch.object(trace_analyzer, "regular", virtual_regular):
            result = self.read()
        self.assertEqual(result["records"], count)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["observed_gpu_union_ns"], 0)

    def test_partial_is_preserved_and_complete_with_loss_is_rejected(self):
        self.receipt["native"]["stats"]["dropped_records"] = 3
        self.receipt["native"]["stats"]["limit_flags"] = 2
        self.receipt.update(status="partial", solver_outcome="cancelled")
        self.publish([self.event("kernel", 110, 180)])
        result = self.read()
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["solver_outcome"], "cancelled")
        self.receipt["status"] = "complete"; self.save_receipt()
        with self.assertRaises(TraceError): self.read()

    def test_cuda_event_metadata_has_no_timing_or_loss_and_legacy_remains_readable(self):
        self.publish([self.event("kernel", 110, 180)])
        self.assertEqual(self.read()["status"], "complete")
        self.header["activity_kinds"].append("cuda_event_metadata")
        metadata = self.event("cuda_event_metadata", 0, 0, "cuda_event_record",
            timestamps_valid=False, timestamp_status="not_applicable", activity_kind=36,
            context_id=3, stream_id=4, event_id=5)
        self.publish([metadata, self.event("kernel", 110, 180, timestamp_status="valid")])
        result = self.read()
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["kinds"]["cuda_event_metadata"]["count"], 1)
        self.assertEqual(result["kinds"]["cuda_event_metadata"]["union_ns"], 0)
        self.assertEqual(result["observed_gpu_union_ns"], 70)
        for change in ({"timestamps_valid": True}, {"timestamp_status": "incomplete"},
            {"start_ns": 1}, {"event_id": None}, {"context_id": None}, {"activity_kind": 10}):
            self.publish([metadata | change])
            with self.subTest(change=change), self.assertRaises(TraceError): self.read()
        self.publish([self.event("kernel", 0, 0, timestamps_valid=False, timestamp_status="not_applicable")])
        with self.assertRaises(TraceError): self.read()
        self.publish([self.event("kernel", 110, 80, duration_ns=0,
            timestamps_valid=False, timestamp_status="incomplete")])
        with self.assertRaises(TraceError): self.read()
        self.receipt["native"]["stats"]["incomplete_records"] = 1
        self.receipt["status"] = "partial"; self.save_receipt()
        self.assertEqual(self.read()["observed_gpu_union_ns"], 0)

    def test_v2_complete_window_is_explicit_and_uses_capture_wall_denominator(self):
        self.configure_v2()
        self.receipt["accepted_step_window"]["capture_wall_seconds"] = 0.5
        self.receipt["native"]["stats"].update(start_timestamp_ns=1_000_000_000,
                                                  end_timestamp_ns=2_000_000_000)
        self.publish([self.event("kernel", 1_100_000_000, 1_800_000_000)])

        result = self.read()
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["capture_scope"], {
            "kind": "accepted_step_window", "start_after_step": 16, "end_after_step": 32,
            "observed_start_step": 16, "observed_end_step": 32,
            "observed_start_time_s": 1.0e-12, "observed_end_time_s": 2.0e-12,
            "completed": True, "completion_reason": "completed", "capture_wall_seconds": 0.5,
        })
        self.assertEqual(result["host_timing"]["total_wall_seconds"], 2.0)
        self.assertEqual(result["host_timing"]["capture_wall_seconds"], 0.5)
        self.assertEqual(result["timing_qualification"]["status"], "not_verified")
        self.assertIn("capture_duration_exceeds_host_window", result["timing_qualification"]["reasons"])
        self.assertEqual(result["timing_qualification"]["evidence"]["capture_wall_seconds"], 0.5)
        self.assertNotIn("total_wall_seconds", result["timing_qualification"]["evidence"])
        self.assertEqual(result["records"], 1)

    def test_v2_partial_before_window_with_native_null_has_no_gpu_metrics(self):
        self.configure_v2()
        self.receipt.update(status="partial", native=None)
        self.receipt["accepted_step_window"].update(
            observed_start_step=None, observed_end_step=None,
            observed_start_time_s=None, observed_end_time_s=None,
            completed=False, completion_reason="solver_finished_before_start", capture_wall_seconds=0.0,
        )
        self.publish_without_capture()

        result = self.read()
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["capture_scope"]["kind"], "accepted_step_window")
        self.assertEqual(result["timing_qualification"]["status"], "not_verified")
        self.assertIsNone(result["native"])
        self.assertIsNone(result["records"])
        self.assertIsNone(result["kinds"])
        self.assertIsNone(result["names"])
        self.assertIsNone(result["observed_gpu_union_ns"])

        self.configure_v2()
        self.receipt.update(status="partial", native=None, errors=["invalid step clock"])
        self.receipt["accepted_step_window"].update(
            observed_start_step=None, observed_end_step=None,
            observed_start_time_s=None, observed_end_time_s=None,
            completed=False, completion_reason="invalid_observation", capture_wall_seconds=0.0,
        )
        self.publish_without_capture()
        result = self.read()
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["errors"], ["invalid step clock"])
        self.assertIsNone(result["records"])

    def test_v2_early_end_or_invalid_observation_after_start_remains_partial(self):
        for reason in ("solver_finished_before_end", "invalid_observation"):
            with self.subTest(reason=reason):
                self.configure_v2()
                self.receipt.update(status="partial")
                self.receipt["accepted_step_window"].update(
                    observed_end_step=None, observed_end_time_s=None,
                    completed=False, completion_reason=reason, capture_wall_seconds=0.25,
                )
                self.publish([self.event("kernel", 1_100_000_000, 1_800_000_000)])
                result = self.read()
                self.assertEqual(result["status"], "partial")
                self.assertEqual(result["capture_scope"]["completion_reason"], reason)
                self.assertEqual(result["records"], 1)
                self.assertEqual(result["timing_qualification"]["status"], "not_verified")

    def test_v2_failed_native_start_authenticates_bytes_without_gpu_claims(self):
        self.configure_v2()
        self.receipt.update(status="failed", native=None, errors=["native start failed"])
        self.receipt["accepted_step_window"].update(
            observed_start_step=None, observed_end_step=None,
            observed_start_time_s=None, observed_end_time_s=None,
            completed=False, completion_reason="start_failed", capture_wall_seconds=0.0,
        )
        self.publish_without_capture(b"partial initialization evidence")

        result = self.read()
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["errors"], ["native start failed"])
        self.assertIsNone(result["records"])
        self.assertIsNone(result["observed_gpu_union_ns"])

    def test_v2_failed_native_stop_null_stats_reports_scope_without_gpu_metrics(self):
        self.configure_v2()
        self.receipt.update(status="failed", native=None, errors=["native stop failed"])
        self.receipt["accepted_step_window"].update(
            observed_end_step=None, observed_end_time_s=None,
            completed=False, completion_reason="stop_failed", capture_wall_seconds=0.25,
        )
        self.publish_without_capture(b"partial trace bytes from failed stop")

        result = self.read()
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["capture_scope"]["observed_start_step"], 16)
        self.assertIsNone(result["capture_scope"]["observed_end_step"])
        self.assertEqual(result["capture_scope"]["capture_wall_seconds"], 0.25)
        self.assertIn("native_stop_failed", result["timing_qualification"]["reasons"])
        self.assertEqual(result["errors"], ["native stop failed"])
        self.assertIsNone(result["native"])
        self.assertIsNone(result["records"])
        self.assertIsNone(result["observed_gpu_union_ns"])

        trace_path = self.root / self.receipt["trace_file"]
        trace_path.write_bytes(b"x" * len(b"partial trace bytes from failed stop"))
        with self.assertRaisesRegex(TraceError, "trace hash mismatch"):
            self.read()

    def test_v2_rejects_config_window_digest_and_duplicate_receipt_mismatches(self):
        self.configure_v2()
        self.publish([self.event("kernel", 1_100_000_000, 1_800_000_000)])
        self.receipt["accepted_step_window"]["end_after_step"] = 33
        self.save_receipt()
        with self.assertRaisesRegex(TraceError, "window differs from config"):
            self.read()

        self.configure_v2()
        self.publish([self.event("kernel", 1_100_000_000, 1_800_000_000)])
        self.receipt["config"]["accepted_step_window"]["end_after_step"] = 33
        self.save_receipt()
        with self.assertRaisesRegex(TraceError, "config digest mismatch"):
            self.read()

        self.configure_v2()
        self.publish([self.event("kernel", 1_100_000_000, 1_800_000_000)])
        (self.root / "worker_cuda_trace.v1.json").write_bytes(encoded(self.receipt))
        with self.assertRaisesRegex(TraceError, "exactly one trace receipt"):
            self.read()

    def test_v2_config_and_capture_wall_reject_open_fields_and_noninteger_bounds(self):
        cases = [
            ({"config_extra": True}, "invalid trace config"),
            ({"window_extra": True}, "invalid accepted-step window config"),
            ({"receipt_window_extra": True}, "invalid accepted-step window receipt"),
            ({"receipt_window_missing": True}, "invalid accepted-step window receipt"),
            ({"start_after_step": True}, "invalid window start step"),
            ({"end_after_step": 32.0}, "invalid window end step"),
            ({"end_after_step": 16}, "invalid accepted-step window bounds"),
            ({"end_after_step": 1017}, "invalid accepted-step window bounds"),
            ({"capture_wall_seconds": True}, "invalid capture wall time"),
            ({"observed_end_step": True}, "invalid observed end step"),
            ({"observed_start_time_s": True}, "invalid observed start time"),
            ({"completed": 1}, "invalid accepted-step completion flag"),
            ({"completion_reason": []}, "invalid accepted-step completion reason"),
        ]
        for changes, expected in cases:
            with self.subTest(changes=changes):
                self.configure_v2()
                self.publish([self.event("kernel", 1_100_000_000, 1_800_000_000)])
                config = self.receipt["config"]
                window = self.receipt["accepted_step_window"]
                if "config_extra" in changes:
                    config["unexpected"] = changes["config_extra"]
                elif "window_extra" in changes:
                    config["accepted_step_window"]["unexpected"] = changes["window_extra"]
                elif "receipt_window_extra" in changes:
                    window["unexpected"] = changes["receipt_window_extra"]
                elif "receipt_window_missing" in changes:
                    window.pop("observed_end_time_s")
                elif any(key in {"capture_wall_seconds", "observed_end_step", "observed_start_time_s",
                                 "completed", "completion_reason"} for key in changes):
                    window.update(changes)
                else:
                    config["accepted_step_window"].update(changes)
                self.receipt["config_sha256"] = hashlib.sha256(encoded(config)).hexdigest()
                self.save_receipt()
                with self.assertRaisesRegex(TraceError, expected):
                    self.read()

    def test_v1_config_continues_to_forbid_an_accepted_step_window(self):
        self.publish([self.event("kernel", 110, 180)])
        self.receipt["config"]["accepted_step_window"] = {"start_after_step": 16, "end_after_step": 32}
        self.receipt["config_sha256"] = hashlib.sha256(encoded(self.receipt["config"])).hexdigest()
        self.save_receipt()
        with self.assertRaisesRegex(TraceError, "invalid trace config"):
            self.read()

        self.receipt["config"] = {"schema_version": "accepted_cuda_trace.v1",
            "max_bytes": 67108864, "max_duration_ms": 60000}
        self.receipt["config_sha256"] = hashlib.sha256(encoded(self.receipt["config"])).hexdigest()
        self.receipt["accepted_step_window"] = {"start_after_step": 16, "end_after_step": 32}
        self.save_receipt()
        with self.assertRaisesRegex(TraceError, "v1 trace receipt cannot contain"):
            self.read()

    def test_v2_complete_with_missed_boundary_or_trace_loss_is_rejected(self):
        self.configure_v2()
        self.receipt["accepted_step_window"]["observed_end_step"] = 31
        self.publish([self.event("kernel", 1_100_000_000, 1_800_000_000)])
        with self.assertRaisesRegex(TraceError, "end boundary"):
            self.read()

        self.configure_v2()
        self.receipt["native"]["stats"]["dropped_records"] = 1
        self.publish([self.event("kernel", 1_100_000_000, 1_800_000_000)])
        with self.assertRaisesRegex(TraceError, "complete trace contains loss or failure"):
            self.read()

        self.configure_v2()
        self.receipt["native"]["stats"]["cupti_version"] = 24
        self.publish([self.event("kernel", 1_100_000_000, 1_800_000_000)])
        with self.assertRaisesRegex(TraceError, "complete v2 capture requires API28"):
            self.read()

    def test_long_escaped_kernel_names_fit_bounded_lines(self):
        name = "\x01" * 2048
        self.publish([self.event("kernel", 110, 180, name)])
        self.assertEqual(self.read()["names"]["kernel"][name]["count"], 1)
        self.publish([self.event("kernel", 110, 180, name, padding="x" * 4096)])
        with self.assertRaisesRegex(TraceError, "oversized or incomplete NDJSON line"): self.read()
        self.publish([self.event("kernel", 110, 180, "x" * 2049)])
        with self.assertRaises(TraceError): self.read()

    def test_clipped_durations_apply_to_rankings_and_truncation_is_counted(self):
        self.publish([self.event("kernel", 50, 500), self.event("kernel", 400, 450)])
        result = self.read()
        self.assertEqual(result["kinds"]["kernel"]["summed_duration_ns"], 200)
        self.assertEqual(result["names"]["kernel"]["example"]["summed_duration_ns"], 200)
        self.assertEqual(result["clipped_records"], 2)
        self.publish([self.event("kernel", 110, 180, name_truncated=True)])
        with self.assertRaises(TraceError): self.read()
        self.receipt["native"]["stats"]["truncated_names"] = 1
        self.receipt["status"] = "partial"; self.save_receipt()
        self.assertEqual(self.read()["status"], "partial")

    def test_malformed_records_and_cross_process_records_refuse(self):
        event = self.event("runtime_api", 110, 180)
        for key, bad in [("duration_ns", 71), ("process_id", 8), ("bytes", True),
            ("timestamps_valid", "true"), ("kind", "future"), ("name", "x" * 2049)]:
            self.publish([event | {key: bad}])
            with self.subTest(key=key), self.assertRaises(TraceError): self.read()
        self.publish([self.event("kernel", 110, 180, device_id=0),
            self.event("kernel", 110, 180, device_id=7)])
        with self.assertRaises(TraceError): self.read()

    def test_symlink_oversize_and_truncated_line_refuse(self):
        self.publish([self.event("kernel", 110, 180)])
        path = self.root / self.receipt["trace_file"]
        raw = path.read_bytes(); path.unlink()
        target = self.root / "untrusted"; target.write_bytes(raw); path.symlink_to(target)
        with self.assertRaises(TraceError): self.read()
        path.unlink(); path.write_bytes(raw[:-1])
        self.receipt["trace_size_bytes"] = len(raw)-1
        self.receipt["native"]["stats"]["bytes_written"] = len(raw)-1
        self.receipt["trace_sha256"] = hashlib.sha256(raw[:-1]).hexdigest(); self.save_receipt()
        with self.assertRaises(TraceError): self.read()
        self.receipt["trace_size_bytes"] = 536870913; self.save_receipt()
        with self.assertRaises(TraceError): self.read()


if __name__ == "__main__":
    unittest.main()
