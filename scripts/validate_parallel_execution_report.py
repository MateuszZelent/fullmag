"""Fail-closed validation of the adaptive FEM eigen process-pool report.

The native pool writes a bounded ``fullmag.eigen.admission_journal.v1``
envelope and also publishes the direct ``ProcessPoolReportV1`` payload.  This
checker validates the report's requested policy, sample
bindings, worker budgets, resource snapshots and CPU observations.  It does
not claim solver parity, numerical correctness, or scientific qualification.

The native report contains admission-event timestamps and an active-worker
count, but no per-worker start/end intervals.  Consequently this module only
reports a timestamped active-count observation when ``active_workers >= 2``
was actually recorded.  It never infers concurrency from ``max_workers`` or
``resolved_workers`` alone.
"""

from __future__ import annotations

import argparse
from collections.abc import Mapping, Sequence
import json
import math
from pathlib import Path
import sys
from typing import Any


ADMISSION_JOURNAL_SCHEMA = "fullmag.eigen.admission_journal.v1"
REPORT_PROTOCOL_V1 = "fullmag.eigen_k_worker.v1"
REPORT_PROTOCOL_V2 = "fullmag.eigen_k_worker.v2"
SUPPORTED_REPORT_PROTOCOLS = frozenset((REPORT_PROTOCOL_V1, REPORT_PROTOCOL_V2))
# Kept for the serial probe's legacy import; parsing uses the full allowlist.
REPORT_PROTOCOL = REPORT_PROTOCOL_V1
REPORT_SCHEMA = "fullmag.parallel-execution-report.v1"
MAX_ADMISSION_EVENTS = 2048
MAX_REPORT_BYTES = 4 * 1024 * 1024
KNOWN_MODES = frozenset(("serial", "adaptive"))
KNOWN_TERMINAL_STATES = frozenset(("running", "completed", "failed", "cancelled"))
_POLICY_PARITY_FIELDS = (
    "max_cpu_percent",
    "max_memory_percent",
    "memory_reserve_bytes",
    "max_workers",
    "threads_per_worker",
)


class ValidationError(ValueError):
    """The report is malformed or violates its producer contract."""


def _reject_duplicate_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON object key: {key}")
        value[key] = item
    return value


def _reject_nonfinite_json_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON constant is not allowed: {value}")


def _load_json_bytes(raw: bytes, label: str) -> Mapping[str, Any]:
    if len(raw) > MAX_REPORT_BYTES:
        raise ValidationError(
            f"{label} exceeds bounded report size {MAX_REPORT_BYTES} bytes"
        )
    try:
        value = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_reject_duplicate_pairs,
            parse_constant=_reject_nonfinite_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ValidationError(f"{label} is not strict JSON: {error}") from error
    if not isinstance(value, Mapping):
        raise ValidationError(f"{label} must be a JSON object")
    return value


def _load_source(source: str | Path | Mapping[str, Any]) -> tuple[Mapping[str, Any], int | None]:
    if isinstance(source, Mapping):
        return source, None
    path = Path(source)
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise ValidationError(f"cannot read parallel execution report {path}: {error}") from error
    return _load_json_bytes(raw, "parallel execution report"), len(raw)


def _object(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValidationError(f"{label} must be an object")
    return value


def _array(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValidationError(f"{label} must be an array")
    return value


def _string(value: Any, label: str, *, nonempty: bool = True) -> str:
    if not isinstance(value, str) or (nonempty and not value.strip()):
        raise ValidationError(f"{label} must be a non-empty string")
    return value


def _integer(value: Any, label: str, *, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum:  # bool is deliberately rejected
        raise ValidationError(f"{label} must be an integer >= {minimum}")
    return value


def _finite(value: Any, label: str, *, minimum: float = 0.0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValidationError(f"{label} must be a finite number >= {minimum}")
    result = float(value)
    if not math.isfinite(result) or result < minimum:
        raise ValidationError(f"{label} must be a finite number >= {minimum}")
    return result


def _digest(value: Any, label: str) -> str:
    value = _string(value, label)
    if len(value) != 71 or not value.startswith("sha256:") \
            or any(character not in "0123456789abcdefABCDEF" for character in value[7:]):
        raise ValidationError(f"{label} must be a sha256:<64 hex> digest")
    return value


def _unwrap(
    source: Mapping[str, Any],
) -> tuple[Mapping[str, Any] | None, str, str | None, bool | None, str | None]:
    """Return report, source schema, terminal state, truncation and reason.

    The native journal intentionally drops the report body when its bounded
    envelope cannot fit.  That is an unavailable evidence state, not a
    malformed producer report, so the caller receives ``report=None``.
    """

    if "schema_version" in source:
        schema = source.get("schema_version")
        if schema != ADMISSION_JOURNAL_SCHEMA:
            raise ValidationError(f"unsupported parallel execution schema: {schema!r}")
        terminal_state = source.get("terminal_state")
        if terminal_state not in KNOWN_TERMINAL_STATES:
            raise ValidationError("admission journal terminal_state is invalid")
        top_truncated = source.get("events_truncated")
        if not isinstance(top_truncated, bool):
            raise ValidationError("admission journal events_truncated must be boolean")
        if "report" not in source:
            return None, ADMISSION_JOURNAL_SCHEMA, terminal_state, top_truncated, \
                "bounded admission journal omitted its report body"
        report = source.get("report")
        if report is None:
            return None, ADMISSION_JOURNAL_SCHEMA, terminal_state, top_truncated, \
                "bounded admission journal has no report body"
        report = _object(report, "admission journal report")
        report_truncated = report.get("events_truncated")
        if not isinstance(report_truncated, bool) or report_truncated != top_truncated:
            raise ValidationError("journal and report events_truncated values disagree")
        return report, ADMISSION_JOURNAL_SCHEMA, terminal_state, top_truncated, None
    protocol = _string(source.get("protocol"), "report.protocol")
    if protocol not in SUPPORTED_REPORT_PROTOCOLS:
        raise ValidationError(f"unsupported report.protocol: {protocol!r}")
    return source, protocol, None, None, None


def _validate_policy(policy: Mapping[str, Any]) -> dict[str, Any]:
    mode = _string(policy.get("mode"), "policy.mode")
    if mode not in KNOWN_MODES:
        raise ValidationError(f"policy.mode must be serial or adaptive, got {mode!r}")
    max_cpu = _finite(policy.get("max_cpu_percent"), "policy.max_cpu_percent", minimum=0.0)
    max_memory = _finite(
        policy.get("max_memory_percent"), "policy.max_memory_percent", minimum=0.0
    )
    if max_cpu <= 0.0 or max_memory <= 0.0:
        raise ValidationError("policy CPU and memory percentages must be > 0")
    if max_cpu > 100.0 or max_memory > 100.0:
        raise ValidationError("policy CPU and memory percentages must be <= 100")
    reserve = _integer(policy.get("memory_reserve_bytes"), "policy.memory_reserve_bytes")
    max_workers = policy.get("max_workers")
    if max_workers is not None:
        max_workers = _integer(max_workers, "policy.max_workers", minimum=1)
    threads = _integer(policy.get("threads_per_worker"), "policy.threads_per_worker", minimum=1)
    return {
        "mode": mode,
        "max_cpu_percent": max_cpu,
        "max_memory_percent": max_memory,
        "memory_reserve_bytes": reserve,
        "max_workers": max_workers,
        "threads_per_worker": threads,
    }


def _sample_bindings(value: Any, label: str) -> dict[int, Mapping[str, Any]]:
    records = _array(value, label)
    by_index: dict[int, Mapping[str, Any]] = {}
    for position, item in enumerate(records):
        item = _object(item, f"{label}[{position}]")
        sample_index = _integer(item.get("sample_index"), f"{label}[{position}].sample_index")
        if sample_index in by_index:
            raise ValidationError(f"{label} contains duplicate sample_index {sample_index}")
        by_index[sample_index] = item
    return by_index


def _validate_inputs(value: Any) -> dict[int, Mapping[str, Any]]:
    by_index = _sample_bindings(value, "inputs")
    for sample_index, item in by_index.items():
        _digest(item.get("plan_sha256"), f"inputs[{sample_index}].plan_sha256")
        _digest(
            item.get("equilibrium_artifact_sha256"),
            f"inputs[{sample_index}].equilibrium_artifact_sha256",
        )
    return by_index


def _validate_budget(
    item: Mapping[str, Any],
    sample_index: int,
    policy: Mapping[str, Any],
) -> None:
    label = f"thread_bindings[{sample_index}].budget"
    requested = _integer(item.get("requested_threads"), f"{label}.requested_threads", minimum=1)
    resolved = _integer(item.get("resolved_threads"), f"{label}.resolved_threads", minimum=1)
    if requested != policy["threads_per_worker"]:
        raise ValidationError(f"{label}.requested_threads differs from policy.threads_per_worker")
    if resolved > requested:
        raise ValidationError(f"{label}.resolved_threads exceeds requested_threads")
    _string(item.get("cap_reason"), f"{label}.cap_reason")
    _finite(item.get("allocation_cpu_cores"), f"{label}.allocation_cpu_cores", minimum=0.0)
    _integer(item.get("host_cpu_cores"), f"{label}.host_cpu_cores", minimum=1)


def _validate_thread_bindings(
    value: Any,
    inputs: Mapping[int, Mapping[str, Any]],
    policy: Mapping[str, Any],
) -> dict[int, Mapping[str, Any]]:
    by_index = _sample_bindings(value, "thread_bindings")
    for sample_index, item in by_index.items():
        _validate_budget(_object(item.get("budget"), f"thread_bindings[{sample_index}].budget"),
                         sample_index, policy)
    return by_index


def _validate_observations(
    value: Any,
    policy: Mapping[str, Any],
    thread_bindings: Mapping[int, Mapping[str, Any]],
) -> dict[int, Mapping[str, Any]]:
    by_index = _sample_bindings(value, "cpu_observations")
    for sample_index, item in by_index.items():
        label = f"cpu_observations[{sample_index}]"
        intervals = _integer(item.get("valid_intervals"), f"{label}.valid_intervals")
        observed = _finite(item.get("observed_seconds"), f"{label}.observed_seconds")
        if intervals and observed <= 0.0:
            raise ValidationError(f"{label}.observed_seconds must be positive with intervals")
        if intervals == 0 and observed != 0.0:
            raise ValidationError(
                f"{label}.observed_seconds must be zero without valid intervals"
            )
        if observed > intervals + 1e-9:
            raise ValidationError(
                f"{label}.observed_seconds exceeds the one-second-per-interval bound"
            )
        _string(item.get("demand_source"), f"{label}.demand_source")
        demand_source = item["demand_source"]
        if demand_source not in {
            "periodic_peak_with_terminal_average",
            "resolved_team_envelope_with_terminal_average",
        }:
            raise ValidationError(f"{label}.demand_source is unsupported")
        sampled_peak = _finite(item.get("sampled_peak_cpu_cores"),
                               f"{label}.sampled_peak_cpu_cores")
        terminal_average = _finite(item.get("terminal_average_cpu_cores"),
                                   f"{label}.terminal_average_cpu_cores")
        resolved_threads = _integer(item.get("resolved_threads"),
                                    f"{label}.resolved_threads", minimum=1)
        if resolved_threads > policy["threads_per_worker"]:
            raise ValidationError(f"{label}.resolved_threads exceeds policy request")
        binding = thread_bindings.get(sample_index)
        if binding is None:
            raise ValidationError(f"{label} has no matching thread binding")
        binding_budget = _object(binding.get("budget"),
                                 f"thread_bindings[{sample_index}].budget")
        binding_threads = _integer(
            binding_budget.get("resolved_threads"),
            f"thread_bindings[{sample_index}].budget.resolved_threads",
            minimum=1,
        )
        if resolved_threads != binding_threads:
            raise ValidationError(
                f"{label}.resolved_threads differs from its thread binding"
            )
        demand = _finite(item.get("demand_cpu_cores"), f"{label}.demand_cpu_cores")
        if demand + 1e-12 < max(sampled_peak, terminal_average):
            raise ValidationError(f"{label}.demand_cpu_cores is below its component observations")
        if demand_source == "resolved_team_envelope_with_terminal_average" \
                and demand + 1e-12 < resolved_threads:
            raise ValidationError(
                f"{label}.demand_cpu_cores is below resolved_threads envelope"
            )
        if demand_source == "periodic_peak_with_terminal_average" and (
            intervals < 3 or observed < 1.0 or sampled_peak <= 0.0
        ):
            raise ValidationError(
                f"{label}.periodic_peak_with_terminal_average lacks required CPU coverage"
            )
    return by_index


def _validate_snapshot(
    snapshot: Mapping[str, Any],
    label: str,
) -> tuple[float, int]:
    _integer(snapshot.get("sampled_at_unix_ms"), f"{label}.sampled_at_unix_ms")
    allocated = _finite(snapshot.get("allocated_cpu_cores"),
                        f"{label}.allocated_cpu_cores", minimum=0.0)
    if allocated <= 0.0:
        raise ValidationError(f"{label}.allocated_cpu_cores must be positive")
    busy = _finite(snapshot.get("cpu_busy_percent"), f"{label}.cpu_busy_percent")
    if busy > 100.0:
        raise ValidationError(f"{label}.cpu_busy_percent must be <= 100")
    available = _finite(snapshot.get("cpu_available_cores"),
                        f"{label}.cpu_available_cores")
    if available > allocated:
        raise ValidationError(f"{label}.cpu_available_cores exceeds allocated_cpu_cores")
    memory_limit = _integer(snapshot.get("memory_limit_bytes"),
                            f"{label}.memory_limit_bytes", minimum=1)
    memory_available = _integer(snapshot.get("memory_available_bytes"),
                                f"{label}.memory_available_bytes")
    if memory_available > memory_limit:
        raise ValidationError(f"{label}.memory_available_bytes exceeds memory_limit_bytes")
    sources = _array(snapshot.get("allocation_sources"), f"{label}.allocation_sources")
    for index, source in enumerate(sources):
        _string(source, f"{label}.allocation_sources[{index}]")
    return allocated, memory_limit


def _validate_events(
    value: Any,
    *,
    resolved_workers: int,
    policy: Mapping[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    events = _array(value, "events")
    if len(events) > MAX_ADMISSION_EVENTS:
        raise ValidationError(f"events exceed bounded limit {MAX_ADMISSION_EVENTS}")
    warnings: list[str] = []
    previous_timestamp: int | None = None
    snapshot_count = 0
    observed_active_two = False
    pressure_reasons: list[str] = []
    for position, raw_event in enumerate(events):
        event = _object(raw_event, f"events[{position}]")
        timestamp = _integer(event.get("at_unix_ms"), f"events[{position}].at_unix_ms")
        if previous_timestamp is not None and timestamp < previous_timestamp:
            raise ValidationError("events timestamps must be non-decreasing")
        previous_timestamp = timestamp
        active = _integer(event.get("active_workers"), f"events[{position}].active_workers")
        pending = _integer(event.get("pending_samples"), f"events[{position}].pending_samples")
        desired = _integer(event.get("desired_workers"), f"events[{position}].desired_workers")
        if active > resolved_workers:
            raise ValidationError(f"events[{position}].active_workers exceeds resolved_workers")
        if policy["max_workers"] is not None and desired > policy["max_workers"]:
            raise ValidationError(f"events[{position}].desired_workers exceeds policy.max_workers")
        _string(event.get("reason"), f"events[{position}].reason")
        _string(event.get("cpu_target_kind"), f"events[{position}].cpu_target_kind")
        if active >= 2:
            observed_active_two = True
        snapshot_raw = event.get("snapshot")
        peak_raw = event.get("worker_peak")
        if snapshot_raw is not None:
            snapshot_count += 1
            snapshot = _object(snapshot_raw, f"events[{position}].snapshot")
            allocated, memory_limit = _validate_snapshot(snapshot, f"events[{position}].snapshot")
        else:
            allocated = None
            memory_limit = None
        if peak_raw is not None:
            peak = _object(peak_raw, f"events[{position}].worker_peak")
            cpu_peak = _finite(peak.get("cpu_cores"),
                               f"events[{position}].worker_peak.cpu_cores")
            rss_peak = _integer(peak.get("rss_bytes"),
                                f"events[{position}].worker_peak.rss_bytes")
            if allocated is not None and cpu_peak > allocated:
                pressure_reasons.append("worker CPU demand exceeds sampled allocation")
            if memory_limit is not None and rss_peak > memory_limit:
                pressure_reasons.append("worker RSS exceeds sampled memory limit")
        elif active:
            warnings.append(f"events[{position}] has active workers but no worker_peak")
    quality = {
        "status": "pass" if snapshot_count else "not_verified",
        "snapshot_count": snapshot_count,
    }
    if pressure_reasons:
        quality.update({
            "status": "not_verified",
            "reason": "; ".join(dict.fromkeys(pressure_reasons)),
        })
    elif not snapshot_count:
        quality["reason"] = "adaptive report has no timestamped resource snapshots"
    return {
        "event_count": len(events),
        "timestamped_active_workers_ge_2": observed_active_two,
        "resource_quality": quality,
    }, warnings


def _validate_worker_logs(value: Any) -> dict[int, Mapping[str, Any]]:
    by_index = _sample_bindings(value, "worker_logs")
    for sample_index, item in by_index.items():
        label = f"worker_logs[{sample_index}]"
        _string(item.get("stdout_path"), f"{label}.stdout_path")
        _string(item.get("stderr_path"), f"{label}.stderr_path")
        _string(item.get("handshake_path"), f"{label}.handshake_path")
        _digest(item.get("worker_executable_sha256"), f"{label}.worker_executable_sha256")
        _object(item.get("worker_build_identity"), f"{label}.worker_build_identity")
    return by_index


def _sets_must_match(
    expected: Mapping[int, Any],
    actual: Mapping[int, Any],
    label: str,
) -> None:
    if set(expected) != set(actual):
        missing = sorted(set(expected) - set(actual))
        extra = sorted(set(actual) - set(expected))
        raise ValidationError(f"{label} sample set mismatch: missing={missing}, extra={extra}")


def _unavailable_report(
    *,
    source_schema: str,
    terminal_state: str | None,
    truncated: bool | None,
    reason: str,
    raw_size: int | None,
) -> dict[str, Any]:
    return {
        "schema": REPORT_SCHEMA,
        "status": "not_verified",
        "qualification": "NOT VERIFIED",
        "source_schema": source_schema,
        "terminal_state": terminal_state,
        "events_truncated": truncated,
        "report_bytes": raw_size,
        "reason": reason,
        "pending_requirements": ["complete native process-pool report body"],
    }


def validate_parallel_execution_report(
    source: str | Path | Mapping[str, Any],
    *,
    expected_mode: str | None = None,
    expected_sample_count: int | None = None,
    require_concurrency: bool = False,
) -> dict[str, Any]:
    """Validate one direct report or one native admission-journal JSON file.

    ``status=pass`` means only that a completed journal body is structurally
    coherent.  A direct ``ProcessPoolReportV1`` has no terminal-state field,
    so its completion evidence remains explicitly ``NOT VERIFIED``.  The
    scientific ``qualification`` deliberately remains ``NOT VERIFIED``.  A
    caller that needs timestamped adaptive overlap can request the stricter
    ``require_concurrency`` CLI/function gate and must handle its unavailable
    result separately from malformed data.
    """

    if expected_mode is not None and expected_mode not in KNOWN_MODES:
        raise ValidationError("expected_mode must be serial or adaptive")
    if expected_sample_count is not None:
        _integer(expected_sample_count, "expected_sample_count", minimum=1)
    source_value, raw_size = _load_source(source)
    report, source_schema, terminal_state, top_truncated, unavailable_reason = _unwrap(source_value)
    if report is None:
        return _unavailable_report(
            source_schema=source_schema,
            terminal_state=terminal_state,
            truncated=top_truncated,
            reason=unavailable_reason or "parallel execution report body unavailable",
            raw_size=raw_size,
        )

    protocol = _string(report.get("protocol"), "report.protocol")
    if protocol not in SUPPORTED_REPORT_PROTOCOLS:
        raise ValidationError(f"unsupported report.protocol: {protocol!r}")
    if source_schema in SUPPORTED_REPORT_PROTOCOLS and source_schema != protocol:
        raise ValidationError("direct report protocol differs from its source classification")
    requested_mode = _string(report.get("requested_mode"), "report.requested_mode")
    if requested_mode not in KNOWN_MODES:
        raise ValidationError("report.requested_mode must be serial or adaptive")
    policy = _validate_policy(_object(report.get("policy"), "report.policy"))
    if policy["mode"] != requested_mode:
        raise ValidationError("report.requested_mode differs from policy.mode")
    if expected_mode is not None and requested_mode != expected_mode:
        raise ValidationError(
            f"report mode {requested_mode!r} does not match expected {expected_mode!r}"
        )
    resolved_mode = _string(report.get("resolved_mode"), "report.resolved_mode")
    allowed_resolved_modes = {
        "serial": {"serial_processes", "serial_bootstrap_only"},
        "adaptive": {"adaptive_processes", "serial_bootstrap_only"},
    }
    if resolved_mode not in allowed_resolved_modes[requested_mode]:
        if not (terminal_state not in (None, "completed") and resolved_mode == "serial_processes"):
            raise ValidationError(
                f"resolved_mode {resolved_mode!r} is incompatible with {requested_mode}"
            )
    resolved_workers = _integer(report.get("resolved_workers"), "report.resolved_workers")
    if policy["max_workers"] is not None and resolved_workers > policy["max_workers"]:
        raise ValidationError("report.resolved_workers exceeds policy.max_workers")
    if resolved_mode == "serial_bootstrap_only":
        if resolved_workers != 1:
            raise ValidationError("serial_bootstrap_only must report one resolved worker")
    elif resolved_workers < 1 and terminal_state in (None, "completed"):
        raise ValidationError("completed process-pool report must resolve at least one worker")

    inputs = _validate_inputs(report.get("inputs"))
    if expected_sample_count is not None and len(inputs) != expected_sample_count:
        raise ValidationError(
            f"input sample count {len(inputs)} differs from expected {expected_sample_count}"
        )
    thread_bindings = _validate_thread_bindings(report.get("thread_bindings"), inputs, policy)
    observations = _validate_observations(
        report.get("cpu_observations"), policy, thread_bindings
    )
    worker_logs = _validate_worker_logs(report.get("worker_logs"))
    events_truncated = report.get("events_truncated")
    if not isinstance(events_truncated, bool):
        raise ValidationError("report.events_truncated must be boolean")
    telemetry_reason = report.get("telemetry_reason")
    if telemetry_reason is not None:
        _string(telemetry_reason, "report.telemetry_reason")
    events_summary, warnings = _validate_events(
        report.get("events"), resolved_workers=resolved_workers, policy=policy
    )

    bootstrap_only = resolved_mode == "serial_bootstrap_only"
    normal_completed = terminal_state in (None, "completed") and not bootstrap_only
    if normal_completed:
        if not inputs:
            raise ValidationError("normal process-pool report must contain inputs")
        _sets_must_match(inputs, thread_bindings, "thread_bindings")
        _sets_must_match(inputs, worker_logs, "worker_logs")
        if requested_mode == "adaptive":
            _sets_must_match(inputs, observations, "cpu_observations")
            if any(item["demand_cpu_cores"] <= 0.0 for item in observations.values()):
                raise ValidationError("completed adaptive report contains zero CPU demand")
        elif observations:
            raise ValidationError("serial process-pool report must not contain cpu_observations")
    elif bootstrap_only:
        if inputs or thread_bindings or observations or worker_logs:
            raise ValidationError("serial_bootstrap_only report must have empty worker arrays")

    if terminal_state is not None and terminal_state != "completed":
        warnings.append(f"terminal_state={terminal_state}; report is not a completed run")
    if telemetry_reason:
        warnings.append(f"native telemetry_reason: {telemetry_reason}")
    if events_truncated:
        warnings.append("admission event history was truncated by the native bounded journal")

    if requested_mode == "serial":
        concurrency = {
            "status": "not_applicable",
            "availability": "not_applicable",
            "timestamped_evidence": False,
            "proof_scope": "serial_policy",
            "reason": "serial execution does not request concurrent workers",
        }
        resource_quality = {"status": "not_applicable", "reason": "serial pool has no adaptive resource admission"}
    elif events_summary["timestamped_active_workers_ge_2"]:
        concurrency = {
            "status": "observed_from_active_count",
            "availability": "observed",
            "timestamped_evidence": True,
            "proof_scope": "point_observation",
            "complete_history": not events_truncated,
            "reason": (
                "an admission event recorded active_workers >= 2 with at_unix_ms; "
                "this proves scheduler co-activity at a point, not solver-phase overlap or speedup"
            ),
            "coverage": "truncated" if events_truncated else "bounded_event_history",
        }
        resource_quality = events_summary["resource_quality"]
    else:
        concurrency = {
            "status": "not_verified",
            "availability": "unavailable",
            "timestamped_evidence": False,
            "proof_scope": "none",
            "complete_history": not events_truncated,
            "reason": (
                "report has no timestamped admission event with active_workers >= 2; "
                "resolved_workers/max_workers do not prove overlap"
            ),
        }
        resource_quality = events_summary["resource_quality"]

    direct_report_completion_unverified = source_schema in SUPPORTED_REPORT_PROTOCOLS
    status = "not_verified" if direct_report_completion_unverified else "pass"
    if terminal_state is not None and terminal_state != "completed":
        status = "not_verified"
    if telemetry_reason or (requested_mode == "adaptive" and resource_quality["status"] == "not_verified"):
        status = "not_verified"
    if require_concurrency and concurrency["status"] != "observed_from_active_count":
        status = "not_verified"
        warnings.append("required timestamped adaptive concurrency evidence is unavailable")
    if direct_report_completion_unverified:
        completion_evidence = {
            "status": "not_verified",
            "reason": (
                "direct ProcessPoolReportV1 has no terminal_state; caller must bind it "
                "to a completed execution artifact"
            ),
        }
    elif terminal_state == "completed":
        completion_evidence = {
            "status": "completed",
            "reason": "admission journal terminal_state=completed",
        }
    else:
        completion_evidence = {
            "status": "not_verified",
            "reason": f"admission journal terminal_state={terminal_state}",
        }
    result = {
        "schema": REPORT_SCHEMA,
        "status": status,
        "qualification": "NOT VERIFIED",
        "source_schema": source_schema,
        "terminal_state": terminal_state,
        "completion_evidence": completion_evidence,
        "requested_mode": requested_mode,
        "resolved_mode": resolved_mode,
        "resolved_workers": resolved_workers,
        "policy": policy,
        "counts": {
            "input_samples": len(inputs),
            "thread_bindings": len(thread_bindings),
            "cpu_observations": len(observations),
            "worker_logs": len(worker_logs),
            "events": events_summary["event_count"],
        },
        "report_bytes": raw_size,
        "events_truncated": events_truncated,
        "resource_quality": resource_quality,
        "concurrency": concurrency,
        "warnings": warnings,
        "pending_requirements": [
            "native managed runtime receipt",
            "serial/adaptive numerical and residual parity",
            "mesh, airbox and mode-count convergence",
        ],
    }
    return result


def _report_object(source: str | Path | Mapping[str, Any]) -> Mapping[str, Any]:
    raw, _, _, _, _ = _unwrap(_load_source(source)[0])
    if raw is None:
        raise ValidationError("report body is unavailable")
    return raw


def compare_serial_adaptive_policy(
    serial_source: str | Path | Mapping[str, Any],
    adaptive_source: str | Path | Mapping[str, Any],
) -> dict[str, Any]:
    """Check that serial and adaptive artifacts share input and policy limits.

    This is policy/input parity only; it never compares eigenfrequencies or
    residuals and therefore remains ``NOT VERIFIED`` scientifically.
    """

    serial_result = validate_parallel_execution_report(serial_source, expected_mode="serial")
    adaptive_result = validate_parallel_execution_report(adaptive_source, expected_mode="adaptive")
    serial = _report_object(serial_source)
    adaptive = _report_object(adaptive_source)
    serial_policy = _validate_policy(_object(serial.get("policy"), "serial.policy"))
    adaptive_policy = _validate_policy(_object(adaptive.get("policy"), "adaptive.policy"))
    if any(serial_policy[field] != adaptive_policy[field] for field in _POLICY_PARITY_FIELDS):
        raise ValidationError("serial/adaptive policy fields differ")
    serial_inputs = _validate_inputs(serial.get("inputs"))
    adaptive_inputs = _validate_inputs(adaptive.get("inputs"))
    if set(serial_inputs) != set(adaptive_inputs):
        raise ValidationError("serial/adaptive input sample sets differ")
    for sample_index in serial_inputs:
        for field in ("plan_sha256", "equilibrium_artifact_sha256"):
            if serial_inputs[sample_index].get(field) != adaptive_inputs[sample_index].get(field):
                raise ValidationError(
                    f"serial/adaptive input binding differs for sample_index {sample_index}"
                )
    return {
        "schema": "fullmag.parallel-execution-policy-parity.v1",
        "status": "pass",
        "qualification": "NOT VERIFIED",
        "serial_status": serial_result["status"],
        "adaptive_status": adaptive_result["status"],
        "policy_match": True,
        "input_binding_match": True,
        "sample_count": len(serial_inputs),
        "pending_requirements": [
            "serial/adaptive numerical and residual parity",
            "managed runtime receipt and immutable source binding",
        ],
    }


def _main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--expected-mode", choices=sorted(KNOWN_MODES))
    parser.add_argument("--expected-sample-count", type=int)
    parser.add_argument(
        "--require-concurrency",
        action="store_true",
        help="fail with NOT VERIFIED unless a timestamped active_workers>=2 event exists",
    )
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        result = validate_parallel_execution_report(
            args.report,
            expected_mode=args.expected_mode,
            expected_sample_count=args.expected_sample_count,
            require_concurrency=args.require_concurrency,
        )
    except (OSError, TypeError, ValueError, ValidationError) as error:
        result = {
            "schema": REPORT_SCHEMA,
            "status": "invalid",
            "qualification": "NOT VERIFIED",
            "reason": str(error),
        }
        exit_code = 2
    else:
        exit_code = 0 if result["status"] == "pass" else 3
    encoded = json.dumps(result, indent=2, sort_keys=True, allow_nan=False) + "\n"
    if args.output is not None:
        args.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(_main())
