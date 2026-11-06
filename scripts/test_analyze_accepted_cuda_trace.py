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
        (self.root / "worker_cuda_trace.v1.json").write_bytes(encoded(self.receipt))

    def read(self, **overrides):
        return analyze(self.root, **({"run_id": "run-1", "attempt_id": "attempt-1", "worker_pid": 42, "gpu_uuid": "GPU-test"} | overrides))

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
