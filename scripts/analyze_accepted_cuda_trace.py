"""Read an attempt-bound CUPTI trace without executing or modifying a run.

Intervals are clipped to the recorded capture window. Unions measure observed
activity, not hardware utilization. API durations overlap with GPU activity and
with nested driver/runtime calls; their sums must not be combined.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import stat
import sys

MAX_BYTES = 536870912
# Even the legacy native v1 activity envelope exceeds 256 bytes without a
# name. Keep an independent finite bound that covers every admitted file;
# interval storage scales with this bound, while file reads remain streaming.
MAX_RECORDS = MAX_BYTES // 256
MAX_NAMES = 2048
MAX_LINE_BYTES = 16384
LEGACY_KINDS = ("driver_api", "runtime_api", "kernel", "memcpy", "memset", "synchronization", "memory")
KINDS = (*LEGACY_KINDS, "cuda_event_metadata")
LOSS_FIELDS = ("dropped_records", "buffer_starvations", "unknown_records", "truncated_names", "incomplete_records", "limit_flags")
COUNTERS = (*LOSS_FIELDS, "records_written", "bytes_written", "api_errors", "io_errors")


class TraceError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise TraceError(message)


def uint(value, label):
    require(type(value) is int and 0 <= value <= 2**64-1, f"invalid {label}")
    return value


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"duplicate JSON key: {key}")
        result[key] = value
    return result


def parse(raw):
    try:
        return json.loads(raw, object_pairs_hook=_pairs,
            parse_constant=lambda value: (_ for _ in ()).throw(TraceError(f"invalid JSON constant {value}")))
    except (ValueError, UnicodeError, RecursionError) as error:
        raise TraceError(f"invalid bounded trace JSON: {error}") from error


@contextmanager
def regular(path, limit):
    fd = None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0))
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_size <= limit, "non-regular or oversized trace artifact")
        stream = os.fdopen(fd, "rb"); fd = None
        with stream:
            yield stream, info.st_size
    except OSError as error:
        raise TraceError(f"cannot read trace artifact: {error}") from error
    finally:
        if fd is not None:
            os.close(fd)


def document(path):
    with regular(path, 1048576) as (stream, size):
        raw = stream.read(1048577)
        require(len(raw) == size, "receipt changed while reading")
        value = parse(raw)
        require(isinstance(value, dict), "receipt must be an object")
        return value


def union_ns(intervals):
    total = 0
    end = 0
    for first, last in sorted(intervals):
        if last > end:
            total += last - max(first, end)
            end = last
    return total


def analyze(root: Path, *, run_id: str, attempt_id: str, worker_pid: int, gpu_uuid: str):
    root = Path(root)
    receipt = document(root / "worker_cuda_trace.v1.json")
    started = document(root / "worker_execution_started.v1.json")
    require(receipt.get("schema_version") == "worker_cuda_trace.v1", "unsupported trace receipt")
    identity = receipt.get("identity")
    require(isinstance(identity, dict) and identity == started.get("identity"), "trace belongs to a different started attempt")
    require(identity.get("schema_version") == "fullmag.accepted_worker_execution.v1", "unsupported attempt identity")
    claim = identity.get("claim", {})
    require(claim.get("run_id") == run_id and claim.get("attempt_id") == attempt_id, "unexpected run or attempt")
    require(type(worker_pid) is int and worker_pid > 0 and receipt.get("worker_pid") == worker_pid, "unexpected worker PID")
    require(bool(gpu_uuid) and receipt.get("gpu_uuid") == gpu_uuid, "unexpected GPU UUID")
    config = receipt.get("config")
    require(isinstance(config, dict) and set(config) == {"schema_version", "max_bytes", "max_duration_ms"}, "invalid trace config")
    require(config["schema_version"] == "accepted_cuda_trace.v1", "unsupported trace config")
    require(4096 <= uint(config["max_bytes"], "max_bytes") <= MAX_BYTES, "invalid byte budget")
    require(1 <= uint(config["max_duration_ms"], "max_duration_ms") <= 120000, "invalid time budget")
    config_hash = hashlib.sha256(json.dumps(config, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    require(receipt.get("config_sha256") == config_hash, "trace config digest mismatch")
    require(receipt.get("trace_file") == "worker_cuda_trace.v1.ndjson", "unexpected trace filename")
    size = uint(receipt.get("trace_size_bytes"), "trace_size_bytes")
    require(size <= config["max_bytes"], "trace exceeds its budget")
    native = receipt.get("native")
    require(isinstance(native, dict) and isinstance(native.get("stats"), dict), "missing native trace result")
    stats = native["stats"]
    api_version = stats.get("cupti_version")
    require(stats.get("schema_version") == 1 and type(api_version) is int and api_version in {24, 28},
        "unsupported native trace version")
    for key in COUNTERS:
        uint(stats.get(key), key)
    require(stats["bytes_written"] == size, "native byte count differs from trace file")
    start = uint(stats.get("start_timestamp_ns"), "capture start")
    end = uint(stats.get("end_timestamp_ns"), "capture end")
    require(0 < start <= end, "invalid capture window")
    require(receipt.get("status") in {"complete", "partial", "failed"}, "invalid capture status")
    require(receipt.get("solver_outcome") in {"completed", "cancelled", "failed", "aborted", "not_started"}, "invalid solver outcome")
    errors = receipt.get("errors")
    require(isinstance(errors, list) and all(isinstance(error, str) for error in errors), "invalid capture errors")
    if receipt["status"] == "complete":
        require(not errors and native.get("status_code") == 0 and not stats["api_errors"] and not stats["io_errors"]
            and not any(stats[key] for key in LOSS_FIELDS) and stats["records_written"] > 0
            and receipt["solver_outcome"] not in {"aborted", "not_started"}, "complete trace contains loss or failure")
    timing = {}
    for key in ("start_wall_seconds", "stop_wall_seconds", "total_wall_seconds"):
        value = receipt.get(key)
        require(type(value) in (float, int) and math.isfinite(value) and value >= 0, "invalid host timing")
        timing[key] = value

    intervals = defaultdict(list)
    names = defaultdict(dict)
    counts = defaultdict(lambda: {"count": 0, "summed_duration_ns": 0, "bytes": 0})
    devices = defaultdict(list)
    observed_devices = set()
    count = invalid = clipped = truncated_names = out_of_bounds = 0
    max_before_ns = max_after_ns = 0
    clock_source = None
    timestamp_callback_registered = None
    digest = hashlib.sha256()
    expected_header = {"type": "header", "schema": "worker_cuda_trace.v1", "timestamp_domain": "cupti_activity_ns",
        "cupti_api_version": api_version, "max_bytes": config["max_bytes"], "max_duration_ms": config["max_duration_ms"],
        "activity_kinds": list(KINDS)}
    monotonic_header = expected_header | {"clock_source": "clock_monotonic_raw",
        "timestamp_callback_registered": True}
    with regular(root / receipt["trace_file"], config["max_bytes"]) as (stream, actual_size):
        require(actual_size == size, "trace size mismatch")
        total = line_index = 0
        declared_kinds = ()
        while raw := stream.readline(MAX_LINE_BYTES + 1):
            require(len(raw) <= MAX_LINE_BYTES and raw.endswith(b"\n"), "oversized or incomplete NDJSON line")
            total += len(raw)
            require(total <= size, "trace changed during reading")
            digest.update(raw)
            event = parse(raw)
            if line_index == 0:
                legacy_api24_header = expected_header | {"activity_kinds": list(LEGACY_KINDS)}
                require(event == expected_header or (api_version == 24 and event == legacy_api24_header)
                    or (api_version == 28 and event == monotonic_header
                        and event.get("timestamp_callback_registered") is True),
                    "trace header differs from admitted capture")
                if event == monotonic_header:
                    clock_source = event["clock_source"]
                    timestamp_callback_registered = event["timestamp_callback_registered"]
                declared_kinds = tuple(event["activity_kinds"])
                line_index += 1
                continue
            require(isinstance(event, dict) and event.get("type") == "activity", "invalid activity record")
            kind = event.get("kind")
            require(kind in (*declared_kinds, "unknown"), "unsupported activity kind")
            require(event.get("timestamp_domain") == "cupti_activity_ns", "mixed timestamp domains")
            count += 1
            require(count <= MAX_RECORDS, "trace record limit exceeded")
            for key in ("start_ns", "end_ns", "duration_ns", "correlation_id", "runtime_correlation_id", "activity_kind"):
                uint(event.get(key), key)
            for key in ("process_id", "thread_id", "device_id", "context_id", "stream_id", "event_id", "bytes", "address", "return_value", "operation_kind"):
                if event.get(key) is not None:
                    uint(event[key], key)
            require(event.get("process_id") in (None, worker_pid), "record belongs to another worker PID")
            if kind in {"kernel", "memcpy", "memset"}:
                require(event.get("device_id") is not None, "device activity lacks device ID")
                observed_devices.add(event["device_id"])
                require(len(observed_devices) <= 1, "multiple CUDA devices in a single-GPU accepted capture")
            require(type(event.get("timestamps_valid")) is bool and type(event.get("name_truncated")) is bool, "invalid activity flags")
            timestamp_status = event.get("timestamp_status", "valid" if event["timestamps_valid"] else "incomplete")
            metadata = kind == "cuda_event_metadata"
            if metadata:
                # Event identity metadata is not a measured interval. API28 adds
                # a device timestamp, but still has no start/end duration pair.
                require(timestamp_status == "not_applicable" and not event["timestamps_valid"]
                    and event["activity_kind"] == 36
                    and event["start_ns"] == event["end_ns"] == event["duration_ns"] == 0,
                    "CUDA event metadata cannot claim a timed interval")
                uint(event.get("event_id"), "CUDA event ID")
                require(event.get("context_id") is not None and event.get("stream_id") is not None,
                    "CUDA event metadata lacks context or stream")
            else:
                require(timestamp_status == ("valid" if event["timestamps_valid"] else "incomplete"),
                    "timed activity timestamp status differs from its validity")
            truncated_names += int(event["name_truncated"])
            name = event.get("name")
            require(isinstance(name, str) and len(name.encode()) <= 2048, "invalid or oversized activity name")
            if name not in names[kind]:
                require(len(names[kind]) < MAX_NAMES, "distinct activity name limit exceeded")
                names[kind][name] = {"count": 0, "summed_duration_ns": 0, "bytes": 0}
            duration = 0
            if event["timestamps_valid"]:
                first, last = event["start_ns"], event["end_ns"]
                require(0 < first <= last and event["duration_ns"] == last-first, "inconsistent activity duration")
                if first < start or last > end:
                    out_of_bounds += 1
                    if first < start:
                        max_before_ns = max(max_before_ns, start - first)
                    if last > end:
                        max_after_ns = max(max_after_ns, last - end)
                left, right = max(start, first), min(end, last)
                duration = max(0, right - left)
                clipped += int(left != first or right != last)
                if right > left:
                    intervals[kind].append((left, right))
                    if kind in {"kernel", "memcpy", "memset"}:
                        devices[event["device_id"]].append((left, right))
            else:
                require(event["duration_ns"] == 0, "invalid timestamps have nonzero duration")
                invalid += int(not metadata)
            for target in (counts[kind], names[kind][name]):
                target["count"] += 1
                target["summed_duration_ns"] += duration
                target["bytes"] += event.get("bytes") or 0
        require(line_index == 1 and total == size, "missing header or trace changed during reading")
    require(digest.hexdigest() == receipt.get("trace_sha256"), "trace hash mismatch")
    require(count == stats["records_written"], "native record count differs from trace")
    require(invalid <= stats["incomplete_records"], "invalid timestamps absent from native loss counters")
    require(truncated_names <= stats["truncated_names"], "truncated names absent from native loss counters")
    require(counts["unknown"]["count"] <= stats["unknown_records"], "unknown activity absent from native loss counters")
    capture_duration_ns = end - start
    duration_tolerance_ns = 1_000_000
    timing_reasons = []
    if clock_source != "clock_monotonic_raw" or timestamp_callback_registered is not True:
        timing_reasons.append("clock_source_not_attested")
    if receipt["status"] != "complete":
        timing_reasons.append("capture_not_complete")
    if out_of_bounds:
        timing_reasons.append("timed_records_outside_capture_window")
    if invalid:
        timing_reasons.append("invalid_timed_records")
    if capture_duration_ns > timing["total_wall_seconds"] * 1_000_000_000 + duration_tolerance_ns:
        timing_reasons.append("capture_duration_exceeds_host_window")
    timing_qualification = {"status": "passed" if not timing_reasons else "not_verified",
        "clock_source": clock_source, "reasons": timing_reasons,
        "evidence": {"capture_status": receipt["status"],
            "timestamp_callback_registered": timestamp_callback_registered,
            "capture_duration_ns": capture_duration_ns,
            "total_wall_seconds": timing["total_wall_seconds"],
            "duration_tolerance_ns": duration_tolerance_ns,
            "out_of_bounds_timed_records": out_of_bounds,
            "max_before_ns": max_before_ns, "max_after_ns": max_after_ns,
            "invalid_timed_records": invalid}}
    for kind, record in counts.items():
        record["union_ns"] = union_ns(intervals[kind])
    return {"schema_version": "accepted_cuda_trace_analysis.v1", "identity": identity,
        "gpu_uuid": gpu_uuid, "worker_pid": worker_pid, "trace_sha256": digest.hexdigest(),
        "config_sha256": config_hash, "status": receipt["status"], "solver_outcome": receipt["solver_outcome"],
        "capture_window_ns": end-start, "records": count, "clipped_records": clipped,
        "timing_qualification": timing_qualification,
        "native": native, "errors": errors, "host_timing": timing, "kinds": dict(counts), "names": dict(names),
        "observed_gpu_union_ns": union_ns(pair for values in devices.values() for pair in values),
        "observed_gpu_union_by_device_ns": {str(device): union_ns(values) for device, values in devices.items()},
        "host_api_union_ns": union_ns(intervals["runtime_api"] + intervals["driver_api"]),
        "interpretation": "Observed interval unions are not hardware utilization. API, GPU and synchronization times overlap. Activity time aggregates remain clipped to the native capture window and are unqualified unless timing_qualification.status is 'passed'; consumers must gate on that status. Host timings exclude callback overhead; measure it with matched on/off runs."}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("attempt_directory", type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--attempt-id", required=True)
    parser.add_argument("--worker-pid", required=True, type=int)
    parser.add_argument("--gpu-uuid", required=True)
    args = parser.parse_args(argv)
    try:
        result = analyze(args.attempt_directory, run_id=args.run_id, attempt_id=args.attempt_id,
            worker_pid=args.worker_pid, gpu_uuid=args.gpu_uuid)
        print(json.dumps(result, sort_keys=True, indent=2))
        return 0
    except (TraceError, TypeError, KeyError) as error:
        print(f"CUDA trace rejected: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
