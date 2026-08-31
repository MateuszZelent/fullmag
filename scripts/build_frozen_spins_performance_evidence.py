#!/usr/bin/env python3
"""Validate FDM CPU Frozen Spins performance measurements and build a receipt.

The raw benchmark is produced by:

    cargo run --release -p fullmag-bench -- frozen-spins-performance \
      --output C:\\absolute\\path\\frozen-spins-fdm-cpu-performance-v1.json

This builder does not run a GPU, infer H2D/D2H traffic, or turn missing data
into zeroes. A PASS here means that an executed CPU benchmark satisfied the
versioned CPU policy; the receipt remains UNQUALIFIED until source identity is
bound by the production qualification aggregator.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
from typing import Any, Mapping, Sequence

BENCHMARK_SCHEMA = "fullmag.frozen_spins.fdm_cpu.performance.benchmark.v1"
POLICY_SCHEMA = "fullmag.frozen_spins.performance_policy.v1"
EVIDENCE_SCHEMA = "fullmag.frozen_spins.fdm_cpu.performance.evidence.v1"
BENCHMARK_ID = "FS-P15-FDM-CPU-PERFORMANCE-V1"
REQUIRED_CASE_IDS = ("FS-P15-PERFORMANCE", "FS-P15-MILLION-SITES")
SUPPLEMENTAL_CASE_IDS = (
    "FS-P15-PERFORMANCE-FDM-CPU",
    "FS-P15-MILLION-SITES-FDM-CPU",
)
REQUIRED_MODES = ("no_mask", "partial_mask")
COMPARISON_SCOPE = "end_to_end_runtime_overhead_including_layout_dispatch"
PLAN_PROVENANCE = "synthetic_deterministic_performance_plan"
PLAN_VALIDATION = "validate_intrinsic_before_runtime_capture"
THREAD_POLICY_SCHEMA = "fullmag.frozen_spins.performance_thread_policy.v1"
PRODUCTION_THREAD_LANE = "production_default"
SERIAL_SUPPLEMENTAL_THREAD_LANE = "serial_deterministic_supplemental"
REQUIRED_PRODUCTION_RAYON_THREADS = 48
CANONICAL_SERIAL_RAYON_THREADS = 1
FORBIDDEN_GPU_KEYS = {
    "gpu_transfer_metrics",
    "h2d_bytes",
    "d2h_bytes",
    "per_step_frozen_h2d_d2h_bytes",
    "hot_loop_h2d_bytes",
    "hot_loop_d2h_bytes",
    "activation_h2d_bytes",
    "activation_d2h_bytes",
}


class EvidenceError(ValueError):
    """Raised when a raw benchmark or policy violates the receipt contract."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise EvidenceError(message)


def object_value(value: Any, label: str) -> Mapping[str, Any]:
    require(isinstance(value, dict), f"{label} must be an object")
    return value


def array_value(value: Any, label: str) -> list[Any]:
    require(isinstance(value, list), f"{label} must be an array")
    return value


def positive_integer(value: Any, label: str) -> int:
    require(
        isinstance(value, int) and not isinstance(value, bool) and value > 0,
        f"{label} must be a positive integer",
    )
    return value


def nonnegative_integer(value: Any, label: str) -> int:
    require(
        isinstance(value, int) and not isinstance(value, bool) and value >= 0,
        f"{label} must be a non-negative integer",
    )
    return value


def finite_number(value: Any, label: str) -> float:
    require(
        isinstance(value, (int, float)) and not isinstance(value, bool),
        f"{label} must be numeric",
    )
    result = float(value)
    require(math.isfinite(result), f"{label} must be finite")
    return result


def nonempty_string(value: Any, label: str) -> str:
    require(isinstance(value, str) and bool(value.strip()), f"{label} must be non-empty")
    return value


def sha256_hex(value: Any, label: str) -> str:
    digest = nonempty_string(value, label).lower()
    require(
        len(digest) == 64 and all(character in "0123456789abcdef" for character in digest),
        f"{label} must be a 64-character lowercase hexadecimal SHA-256",
    )
    return digest


def load_json(path: Path, label: str) -> tuple[dict[str, Any], bytes]:
    try:
        raw = path.read_bytes()
        value = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise EvidenceError(f"cannot read {label} {path}: {error}") from error
    require(isinstance(value, dict), f"{label} root must be an object")
    return value, raw


def validate_policy(policy: Mapping[str, Any]) -> None:
    require(policy.get("schema_version") == POLICY_SCHEMA, "performance policy schema mismatch")
    require(
        policy.get("policy_status") == "provisional_engineering_gate",
        "performance policy must remain explicitly provisional",
    )
    require(
        policy.get("owner_approval_status") == "draft_pending_owner_approval",
        "performance policy owner approval status changed",
    )
    positive_integer(policy.get("policy_revision"), "policy_revision")
    require(
        policy.get("qualification_scope")
        == "fdm_cpu_reference_double_heun_minimal_no_demag_v1",
        "performance policy qualification scope mismatch",
    )
    require(
        policy.get("plan_provenance") == PLAN_PROVENANCE,
        "performance policy plan provenance must remain synthetic and lane-scoped",
    )
    require(
        policy.get("plan_validation") == PLAN_VALIDATION,
        "performance policy must require intrinsic plan validation",
    )
    require(
        policy.get("comparison_scope") == COMPARISON_SCOPE,
        "performance policy comparison scope must include layout dispatch",
    )
    layout_policy = object_value(policy.get("layout_comparison"), "layout_comparison")
    require(layout_policy.get("no_mask_layout") == "soa", "no-mask layout policy changed")
    require(layout_policy.get("partial_mask_layout") == "aos", "partial-mask layout policy changed")
    require(
        layout_policy.get("matched_layout_mask_isolation") == "not_measured",
        "matched-layout mask isolation must remain explicitly not measured",
    )
    nonempty_string(layout_policy.get("interpretation"), "layout_comparison.interpretation")
    measurements = object_value(policy.get("required_measurements"), "required_measurements")
    preview = object_value(measurements.get("preview_wall_time"), "required_measurements.preview_wall_time")
    require(
        preview.get("status") == "separate_preview_receipt_required",
        "preview wall-time ownership changed",
    )
    nonempty_string(preview.get("reason"), "required_measurements.preview_wall_time.reason")
    transfer = object_value(measurements.get("gpu_transfer_bytes"), "required_measurements.gpu_transfer_bytes")
    require(
        transfer.get("status") == "not_applicable_cpu_lane",
        "GPU transfer status must be not_applicable_cpu_lane",
    )
    nonempty_string(transfer.get("reason"), "required_measurements.gpu_transfer_bytes.reason")
    require(policy.get("required_case_ids") == list(REQUIRED_CASE_IDS), "required case IDs changed")
    require(
        policy.get("supplemental_case_ids") == list(SUPPLEMENTAL_CASE_IDS),
        "supplemental CPU case IDs changed",
    )
    require(
        policy.get("global_case_ids_not_claimed") == list(REQUIRED_CASE_IDS),
        "CPU evidence must leave global P15 case IDs unclaimed",
    )
    required_site_count = positive_integer(
        policy.get("required_site_count"), "required_site_count"
    )
    require(required_site_count >= 1_000_000, "million-site requirement was lowered")
    minimum_site_count_cases = positive_integer(
        policy.get("minimum_site_count_cases"), "minimum_site_count_cases"
    )
    require(minimum_site_count_cases >= 2, "at least two scaling points are required")
    positive_integer(policy.get("minimum_repetitions"), "minimum_repetitions")
    positive_integer(policy.get("minimum_steps_per_sample"), "minimum_steps_per_sample")
    stride = positive_integer(policy.get("partial_mask_stride"), "partial_mask_stride")
    require(stride == 4, "partial-mask stride is not the versioned deterministic fixture")

    thread_policy = object_value(policy.get("thread_policy"), "thread_policy")
    require(
        thread_policy.get("schema_version") == THREAD_POLICY_SCHEMA,
        "thread policy schema mismatch",
    )
    require(
        thread_policy.get("environment_variable") == "RAYON_NUM_THREADS",
        "thread policy environment variable changed",
    )
    production = object_value(
        thread_policy.get("production_default"), "thread_policy.production_default"
    )
    require(production.get("lane") == PRODUCTION_THREAD_LANE, "production thread lane changed")
    require(
        positive_integer(
            production.get("required_rayon_threads"),
            "thread_policy.production_default.required_rayon_threads",
        )
        == REQUIRED_PRODUCTION_RAYON_THREADS,
        "production Rayon thread count changed",
    )
    require(
        production.get("require_environment_variable_unset") is False,
        "production thread policy must pin RAYON_NUM_THREADS",
    )
    require(
        production.get("require_environment_variable_exact") == "48",
        "production thread policy must require RAYON_NUM_THREADS=48",
    )
    require(
        production.get("role") == "required_production_gate",
        "production thread policy role changed",
    )
    serial = object_value(
        thread_policy.get("serial_supplemental"), "thread_policy.serial_supplemental"
    )
    require(serial.get("lane") == SERIAL_SUPPLEMENTAL_THREAD_LANE, "serial thread lane changed")
    require(
        positive_integer(
            serial.get("canonical_rayon_threads"),
            "thread_policy.serial_supplemental.canonical_rayon_threads",
        )
        == CANONICAL_SERIAL_RAYON_THREADS,
        "canonical serial Rayon thread count changed",
    )
    require(
        serial.get("require_environment_variable_exact") == "1",
        "serial thread policy must require RAYON_NUM_THREADS=1",
    )
    require(
        serial.get("role") == "supplemental_microbenchmark_only",
        "serial thread policy role changed",
    )
    require(
        serial.get("may_replace_production_gate") is False,
        "serial thread policy may not replace the production gate",
    )

    storage = object_value(policy.get("storage_contract"), "storage_contract")
    require(storage.get("logical_mask_encoding") == "dense_u8", "mask encoding contract changed")
    require(
        positive_integer(storage.get("logical_mask_bytes_per_site"), "logical_mask_bytes_per_site")
        == 1,
        "logical mask storage contract changed",
    )
    require(
        positive_integer(
            storage.get("reference_payload_bytes_per_site"),
            "reference_payload_bytes_per_site",
        )
        == 24,
        "reference payload storage contract changed",
    )
    require(storage.get("mask_storage_type") == "Vec<bool>", "mask storage type changed")
    require(
        storage.get("mask_exact_allocated_bytes") == "not_observable",
        "mask exact allocation observability contract changed",
    )
    require(
        storage.get("reference_storage_type") == "Vec<[f64;3]>",
        "reference storage type changed",
    )
    require(
        storage.get("reference_bytes_semantics") == "logical_vec_payload",
        "reference bytes semantics changed",
    )

    timing = object_value(policy.get("timing"), "timing")
    for name in (
        "partial_over_no_mask_median_ratio_max",
        "partial_over_no_mask_p95_ratio_max",
        "activation_p95_wall_ns_per_site_max",
    ):
        require(finite_number(timing.get(name), f"timing.{name}") > 0.0, f"timing.{name} must be positive")
    activation = object_value(policy.get("activation"), "activation")
    positive_integer(
        activation.get("max_allocation_count_per_activation"),
        "activation.max_allocation_count_per_activation",
    )
    require(
        finite_number(
            activation.get("max_allocated_bytes_per_site"),
            "activation.max_allocated_bytes_per_site",
        )
        > 0.0,
        "activation.max_allocated_bytes_per_site must be positive",
    )
    steady = object_value(policy.get("steady_state"), "steady_state")
    nonnegative_integer(
        steady.get("max_allocated_bytes_per_sample"),
        "steady_state.max_allocated_bytes_per_sample",
    )
    nonnegative_integer(
        steady.get("max_allocation_count_per_sample"),
        "steady_state.max_allocation_count_per_sample",
    )
    gpu_policy = object_value(policy.get("gpu_transfer_metrics"), "gpu_transfer_metrics")
    require(gpu_policy.get("status") == "not_applicable", "GPU policy status must be not_applicable")
    require(gpu_policy.get("measured") is False, "CPU policy may not claim measured GPU metrics")
    nonempty_string(gpu_policy.get("reason"), "gpu_transfer_metrics.reason")


def assert_no_gpu_metrics(value: Any, label: str = "benchmark") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = str(key).lower()
            require(
                normalized not in FORBIDDEN_GPU_KEYS,
                f"{label}.{key} is a GPU transfer metric; CPU evidence must not fabricate it",
            )
            assert_no_gpu_metrics(child, f"{label}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            assert_no_gpu_metrics(child, f"{label}[{index}]")


def validate_thread_policy(runtime: Mapping[str, Any], policy: Mapping[str, Any]) -> str:
    """Validate the exact Rayon lane and return its lane name.

    The default 48-thread pool is the required production lane. A process
    explicitly launched with ``RAYON_NUM_THREADS=1`` is intentionally a
    separate deterministic supplemental probe; accepting it here as the
    production receipt would make the small-grid result non-comparable and
    could close the wrong P15 gate.
    """

    configured = object_value(runtime.get("thread_policy"), "runtime.thread_policy")
    require(
        configured.get("schema_version") == THREAD_POLICY_SCHEMA,
        "runtime thread policy schema mismatch",
    )
    require(
        configured.get("environment_variable") == "RAYON_NUM_THREADS",
        "runtime thread policy environment variable mismatch",
    )
    observed = positive_integer(runtime.get("rayon_threads"), "runtime.rayon_threads")
    require(
        configured.get("observed_rayon_threads") == observed,
        "runtime thread policy observed count differs from runtime.rayon_threads",
    )
    requested = configured.get("requested_rayon_threads")
    if requested is not None:
        positive_integer(requested, "runtime.thread_policy.requested_rayon_threads")
    environment_value = configured.get("environment_value")
    if environment_value is not None:
        nonempty_string(environment_value, "runtime.thread_policy.environment_value")
    lane = configured.get("lane")
    policy_threads = object_value(policy["thread_policy"], "policy.thread_policy")
    production = object_value(
        policy_threads["production_default"], "policy.thread_policy.production_default"
    )
    serial = object_value(
        policy_threads["serial_supplemental"], "policy.thread_policy.serial_supplemental"
    )
    if lane == PRODUCTION_THREAD_LANE:
        require(
            observed
            == positive_integer(
                production["required_rayon_threads"],
                "policy.thread_policy.production_default.required_rayon_threads",
            ),
            "production thread count differs from policy",
        )
        require(
            production["require_environment_variable_unset"] is False,
            "production thread policy must pin an environment variable",
        )
        require(
            production["require_environment_variable_exact"] == "48",
            "production thread policy requires RAYON_NUM_THREADS=48",
        )
        require(
            requested == 48 and environment_value == "48",
            "production_default lane requires RAYON_NUM_THREADS=48",
        )
        require(
            configured.get("role") == "required_production_gate",
            "production thread policy role mismatch",
        )
        return lane
    if lane == SERIAL_SUPPLEMENTAL_THREAD_LANE:
        require(
            observed
            == positive_integer(
                serial["canonical_rayon_threads"],
                "policy.thread_policy.serial_supplemental.canonical_rayon_threads",
            ),
            "serial supplemental thread count differs from policy",
        )
        require(
            serial["require_environment_variable_exact"] == "1",
            "serial supplemental thread policy requires RAYON_NUM_THREADS=1",
        )
        require(requested == 1 and environment_value == "1", "serial lane must record RAYON_NUM_THREADS=1")
        require(
            configured.get("role") == "supplemental_microbenchmark_only",
            "serial supplemental thread policy role mismatch",
        )
        require(
            serial["may_replace_production_gate"] is False,
            "serial supplemental lane may not replace production gate",
        )
        raise EvidenceError(
            "serial deterministic lane is supplemental only and cannot build the production performance receipt"
        )
    raise EvidenceError("runtime.thread_policy.lane is not qualified by the versioned policy")


def percentile(values: Sequence[int], quantile: float) -> int:
    require(values, "percentile requires at least one timing sample")
    ordered = sorted(values)
    rank = max(1, math.ceil(quantile * len(ordered)))
    return ordered[rank - 1]


def positive_samples(value: Any, label: str, expected_length: int) -> list[int]:
    samples = array_value(value, label)
    require(len(samples) == expected_length, f"{label} length must be {expected_length}")
    return [positive_integer(item, f"{label}[{index}]") for index, item in enumerate(samples)]


def nonnegative_samples(value: Any, label: str, expected_length: int) -> list[int]:
    samples = array_value(value, label)
    require(len(samples) == expected_length, f"{label} length must be {expected_length}")
    return [
        nonnegative_integer(item, f"{label}[{index}]")
        for index, item in enumerate(samples)
    ]


def expected_partial_frozen_count(site_count: int, stride: int) -> int:
    return (site_count + stride - 1) // stride


def validate_case(
    case: Mapping[str, Any],
    *,
    policy: Mapping[str, Any],
    benchmark: Mapping[str, Any],
    label: str,
) -> dict[str, Any]:
    site_count = positive_integer(case.get("site_count"), f"{label}.site_count")
    mode = case.get("mode")
    require(mode in REQUIRED_MODES, f"{label}.mode is not a supported performance mode")
    repetitions = positive_integer(case.get("repetitions"), f"{label}.repetitions")
    steps = positive_integer(case.get("steps_per_sample"), f"{label}.steps_per_sample")
    minimum_repetitions = positive_integer(
        policy["minimum_repetitions"], "policy.minimum_repetitions"
    )
    minimum_steps = positive_integer(
        policy["minimum_steps_per_sample"], "policy.minimum_steps_per_sample"
    )
    require(repetitions >= minimum_repetitions, f"{label} has too few repetitions")
    require(steps >= minimum_steps, f"{label} has too few steps per sample")
    require(
        repetitions == positive_integer(benchmark["repetitions"], "benchmark.repetitions"),
        f"{label}.repetitions differs from benchmark configuration",
    )
    require(
        steps == positive_integer(benchmark["steps_per_sample"], "benchmark.steps_per_sample"),
        f"{label}.steps_per_sample differs from benchmark configuration",
    )
    require(
        case.get("warmup_steps")
        == positive_integer(benchmark["warmup_steps"], "benchmark.warmup_steps"),
        f"{label}.warmup_steps differs from benchmark configuration",
    )

    expected_layout = "soa" if mode == "no_mask" else "aos"
    require(case.get("execution_layout") == expected_layout, f"{label} execution layout mismatch")
    frozen = nonnegative_integer(case.get("frozen_site_count"), f"{label}.frozen_site_count")
    free = nonnegative_integer(case.get("free_site_count"), f"{label}.free_site_count")
    require(frozen + free == site_count, f"{label} site counts do not add up")
    stride = positive_integer(policy["partial_mask_stride"], "policy.partial_mask_stride")
    if mode == "no_mask":
        require(frozen == 0 and free == site_count, f"{label} no-mask counts are invalid")
        expected_mask_bytes = 0
        expected_reference_bytes = 0
        activation_wall = array_value(
            case.get("activation_wall_time_ns"), f"{label}.activation_wall_time_ns"
        )
        activation_allocations = array_value(
            case.get("activation_allocation_count"), f"{label}.activation_allocation_count"
        )
        activation_bytes = array_value(
            case.get("activation_allocated_bytes"), f"{label}.activation_allocated_bytes"
        )
        require(
            not activation_wall and not activation_allocations and not activation_bytes,
            f"{label} no-mask case must not claim an activation measurement",
        )
    else:
        require(
            frozen == expected_partial_frozen_count(site_count, stride),
            f"{label} partial mask count is not the deterministic stride-{stride} mask",
        )
        require(0 < frozen < site_count, f"{label} partial mask must leave free sites")
        activation_wall = positive_samples(
            case.get("activation_wall_time_ns"),
            f"{label}.activation_wall_time_ns",
            repetitions,
        )
        activation_allocations = positive_samples(
            case.get("activation_allocation_count"),
            f"{label}.activation_allocation_count",
            len(activation_wall),
        )
        activation_bytes = positive_samples(
            case.get("activation_allocated_bytes"),
            f"{label}.activation_allocated_bytes",
            len(activation_wall),
        )
        activation_policy = object_value(policy["activation"], "policy.activation")
        max_activation_allocations = positive_integer(
            activation_policy["max_allocation_count_per_activation"],
            "policy.max_allocation_count_per_activation",
        )
        max_activation_bytes_per_site = finite_number(
            activation_policy["max_allocated_bytes_per_site"],
            "policy.max_allocated_bytes_per_site",
        )
        require(
            all(value <= max_activation_allocations for value in activation_allocations),
            f"{label} activation allocation count exceeds policy",
        )
        max_activation_bytes = math.ceil(site_count * max_activation_bytes_per_site)
        require(
            all(value <= max_activation_bytes for value in activation_bytes),
            f"{label} activation allocated bytes exceed policy",
        )
    storage_policy = object_value(policy["storage_contract"], "policy.storage_contract")
    expected_mask_bytes = (
        site_count
        * positive_integer(
            storage_policy["logical_mask_bytes_per_site"],
            "policy.logical_mask_bytes_per_site",
        )
        if mode == "partial_mask"
        else 0
    )
    expected_reference_bytes = (
        site_count
        * positive_integer(
            storage_policy["reference_payload_bytes_per_site"],
            "policy.reference_payload_bytes_per_site",
        )
        if mode == "partial_mask"
        else 0
    )
    require(
        nonnegative_integer(case.get("mask_bytes"), f"{label}.mask_bytes")
        == expected_mask_bytes,
        f"{label}.mask_bytes does not match the versioned storage contract",
    )
    require(
        nonnegative_integer(case.get("reference_bytes"), f"{label}.reference_bytes")
        == expected_reference_bytes,
        f"{label}.reference_bytes does not match the versioned storage contract",
    )
    require(
        nonnegative_integer(case.get("storage_bytes"), f"{label}.storage_bytes")
        == expected_mask_bytes + expected_reference_bytes,
        f"{label}.storage_bytes is inconsistent",
    )
    if mode == "partial_mask":
        require(
            case.get("mask_bytes_semantics") == "logical_dense_u8_payload",
            f"{label}.mask_bytes must be labelled logical dense-u8 payload",
        )
        require(
            case.get("host_mask_storage_type") == "Vec<bool>",
            f"{label}.host_mask_storage_type must be Vec<bool>",
        )
        require(
            case.get("host_mask_exact_allocated_bytes") is None,
            f"{label}.host_mask_exact_allocated_bytes must remain unobservable",
        )
        require(
            case.get("host_mask_exact_allocated_bytes_status") == "NOT_OBSERVABLE",
            f"{label}.host_mask_exact_allocated_bytes_status must be NOT_OBSERVABLE",
        )
        require(
            case.get("reference_bytes_semantics") == "logical_vec_payload",
            f"{label}.reference_bytes must be labelled logical Vec payload",
        )
        require(
            case.get("storage_bytes_semantics") == "logical_dense_payload_sum",
            f"{label}.storage_bytes must be labelled logical payload sum",
        )
    else:
        require(case.get("mask_bytes_semantics") == "not_applicable", f"{label} no-mask mask semantics changed")
        require(case.get("host_mask_storage_type") == "none", f"{label} no-mask host mask storage changed")
        require(case.get("host_mask_exact_allocated_bytes") == 0, f"{label} no-mask host mask bytes changed")
        require(
            case.get("host_mask_exact_allocated_bytes_status") == "NOT_APPLICABLE",
            f"{label} no-mask mask allocation status changed",
        )
        require(case.get("reference_bytes_semantics") == "not_applicable", f"{label} no-mask reference semantics changed")
        require(case.get("storage_bytes_semantics") == "not_applicable", f"{label} no-mask storage semantics changed")

    step_samples = positive_samples(
        case.get("step_wall_time_ns"), f"{label}.step_wall_time_ns", repetitions
    )
    steady_allocations = nonnegative_samples(
        case.get("steady_state_allocation_count"),
        f"{label}.steady_state_allocation_count",
        repetitions,
    )
    steady_bytes = nonnegative_samples(
        case.get("steady_state_allocated_bytes"),
        f"{label}.steady_state_allocated_bytes",
        repetitions,
    )
    steady_policy = object_value(policy["steady_state"], "policy.steady_state")
    max_allocations = nonnegative_integer(
        steady_policy["max_allocation_count_per_sample"],
        "policy.max_allocation_count_per_sample",
    )
    max_bytes = nonnegative_integer(
        steady_policy["max_allocated_bytes_per_sample"],
        "policy.max_allocated_bytes_per_sample",
    )
    require(
        all(value <= max_allocations for value in steady_allocations),
        f"{label} steady-state allocation count exceeds policy",
    )
    require(
        all(value <= max_bytes for value in steady_bytes),
        f"{label} steady-state allocation bytes exceed policy",
    )
    return {
        "site_count": site_count,
        "mode": mode,
        "execution_layout": case["execution_layout"],
        "frozen_site_count": frozen,
        "free_site_count": free,
        "step_wall_time_ns": step_samples,
        "step_wall_time_ns_per_step": [value / steps for value in step_samples],
        "activation_wall_time_ns": activation_wall,
        "activation_wall_ns_per_site": (
            [value / site_count for value in activation_wall] if activation_wall else []
        ),
        "activation_allocated_bytes": activation_bytes,
        "activation_allocation_count": activation_allocations,
        "mask_bytes": expected_mask_bytes,
        "mask_bytes_semantics": case["mask_bytes_semantics"],
        "host_mask_storage_type": case["host_mask_storage_type"],
        "host_mask_exact_allocated_bytes": case["host_mask_exact_allocated_bytes"],
        "host_mask_exact_allocated_bytes_status": case[
            "host_mask_exact_allocated_bytes_status"
        ],
        "reference_bytes": expected_reference_bytes,
        "reference_bytes_semantics": case["reference_bytes_semantics"],
        "storage_bytes": expected_mask_bytes + expected_reference_bytes,
        "storage_bytes_semantics": case["storage_bytes_semantics"],
        "steady_state_allocation_count": steady_allocations,
        "steady_state_allocated_bytes": steady_bytes,
        "repetitions": repetitions,
        "steps_per_sample": steps,
    }


def build_evidence(
    benchmark: Mapping[str, Any],
    policy: Mapping[str, Any],
    *,
    input_path: str | None = None,
    input_bytes: bytes | None = None,
    enforce_timing: bool = True,
) -> dict[str, Any]:
    validate_policy(policy)
    assert_no_gpu_metrics(benchmark)
    require(benchmark.get("schema_version") == BENCHMARK_SCHEMA, "benchmark schema mismatch")
    require(benchmark.get("benchmark_id") == BENCHMARK_ID, "benchmark ID mismatch")
    require(
        benchmark.get("policy_schema_version") == policy.get("schema_version"),
        "benchmark policy schema does not match the supplied policy",
    )
    require(
        benchmark.get("status") == "MEASUREMENT_COMPLETED",
        "raw benchmark status must be MEASUREMENT_COMPLETED",
    )
    require(
        benchmark.get("acceptance_status") == "NOT_EVALUATED",
        "raw benchmark acceptance_status must be NOT_EVALUATED",
    )
    require(
        benchmark.get("implementation_status") == "EXECUTED",
        "raw benchmark must explicitly report EXECUTED",
    )
    require(
        benchmark.get("plan_provenance") == PLAN_PROVENANCE,
        "raw benchmark plan provenance is not the approved synthetic lane scope",
    )
    require(
        benchmark.get("plan_validation") == PLAN_VALIDATION,
        "raw benchmark did not validate its synthetic plan intrinsically",
    )
    lane = object_value(benchmark.get("lane"), "lane")
    for key, expected in (
        ("backend", "fdm"),
        ("execution", "cpu_reference"),
        ("precision", "double"),
        ("integrator", "heun"),
        ("evaluation", "minimal"),
        ("terms", "none"),
    ):
        require(lane.get(key) == expected, f"lane.{key} must be {expected!r}")
    require(lane.get("fallback_used") is False, "CPU benchmark used a fallback")

    config = object_value(benchmark.get("benchmark"), "benchmark")
    storage_policy = object_value(policy["storage_contract"], "policy.storage_contract")
    requested_counts = array_value(
        config.get("site_counts_requested"), "benchmark.site_counts_requested"
    )
    require(
        requested_counts
        and all(
            isinstance(value, int) and not isinstance(value, bool) and value > 0
            for value in requested_counts
        ),
        "benchmark.site_counts_requested must contain positive integers",
    )
    repetitions = positive_integer(config.get("repetitions"), "benchmark.repetitions")
    steps = positive_integer(config.get("steps_per_sample"), "benchmark.steps_per_sample")
    warmup = positive_integer(config.get("warmup_steps"), "benchmark.warmup_steps")
    stride = positive_integer(config.get("partial_mask_stride"), "benchmark.partial_mask_stride")
    require(
        stride == positive_integer(policy["partial_mask_stride"], "policy.partial_mask_stride"),
        "benchmark partial-mask stride differs from policy",
    )
    require(
        config.get("comparison_scope") == COMPARISON_SCOPE,
        "benchmark comparison scope must include layout dispatch",
    )
    layout = object_value(config.get("layout_comparison"), "benchmark.layout_comparison")
    require(layout.get("no_mask_layout") == "soa", "benchmark no-mask layout is not SoA")
    require(layout.get("partial_mask_layout") == "aos", "benchmark partial-mask layout is not AoS")
    require(
        layout.get("matched_layout_mask_isolation") == "not_measured",
        "benchmark must not claim matched-layout mask isolation",
    )
    interpretation = nonempty_string(
        layout.get("interpretation"), "benchmark.layout_comparison.interpretation"
    )
    require(
        "not an isolated mask-only overhead" in interpretation.lower(),
        "benchmark interpretation must reject mask-only overhead claims",
    )
    require(
        math.isclose(
            finite_number(config.get("partial_mask_fraction"), "benchmark.partial_mask_fraction"),
            1.0 / stride,
            rel_tol=0.0,
            abs_tol=1.0e-15,
        ),
        "benchmark partial-mask fraction is inconsistent",
    )
    require(
        config.get("activation_timing_scope")
        == "FrozenSpinsState::capture_at_activation",
        "activation timing scope is not the runtime capture operation",
    )
    require(
        config.get("step_timing_scope")
        == "public_reusable_buffer_production_routes",
        "step timing scope is not the production public reusable-buffer routes",
    )
    routes = object_value(config.get("step_routes"), "benchmark.step_routes")
    require(
        routes.get("no_mask")
        == "ExchangeLlgProblem::step_soa_with_buffers_evaluation+ExchangeLlgStateSoA::publish_accepted_to",
        "no-mask route is not the persistent SoA production route plus publish",
    )
    require(
        routes.get("partial_mask") == "ExchangeLlgProblem::step_with_buffers_evaluation",
        "partial-mask route is not the AoS production route",
    )
    require(
        config.get("workspace_scope") == "inert_single_cell_no_demag",
        "benchmark workspace scope changed; it must remain explicit",
    )
    runtime = object_value(benchmark.get("runtime"), "runtime")
    run_id = nonempty_string(runtime.get("run_id"), "runtime.run_id")
    nonempty_string(runtime.get("hostname"), "runtime.hostname")
    thread_lane = validate_thread_policy(runtime, policy)
    require(
        runtime.get("clock") == "std::time::Instant::monotonic",
        "runtime clock is not monotonic",
    )
    source_identity = object_value(runtime.get("source_identity"), "runtime.source_identity")
    require(source_identity.get("status") == "NOT_BOUND", "source identity must remain NOT_BOUND")
    require(source_identity.get("git_commit") is None, "source identity must not invent a commit")
    require(source_identity.get("dirty_tree") is None, "source identity must not invent dirty-tree state")
    nonempty_string(source_identity.get("reason"), "runtime.source_identity.reason")
    binary_identity = object_value(runtime.get("binary_identity"), "runtime.binary_identity")
    require(binary_identity.get("package") == "fullmag-bench", "binary package identity mismatch")
    require(binary_identity.get("executable") == "fullmag-bench", "binary executable identity mismatch")
    require(binary_identity.get("profile") == "release", "canonical performance receipt requires release profile")
    nonempty_string(binary_identity.get("target_os"), "runtime.binary_identity.target_os")
    binary_path = nonempty_string(binary_identity.get("path"), "runtime.binary_identity.path")
    require(
        Path(binary_path).is_absolute(),
        "runtime.binary_identity.path must be absolute",
    )
    positive_integer(binary_identity.get("size_bytes"), "runtime.binary_identity.size_bytes")
    sha256_hex(binary_identity.get("sha256"), "runtime.binary_identity.sha256")

    raw_cases = array_value(benchmark.get("cases"), "cases")
    require(raw_cases, "benchmark must contain cases")
    case_map: dict[tuple[int, str], dict[str, Any]] = {}
    for index, raw_case in enumerate(raw_cases):
        case = object_value(raw_case, f"cases[{index}]")
        validated = validate_case(
            case,
            policy=policy,
            benchmark=config,
            label=f"cases[{index}]",
        )
        key = (validated["site_count"], validated["mode"])
        require(key not in case_map, f"duplicate performance case {key}")
        case_map[key] = validated

    site_counts = sorted({site_count for site_count, _ in case_map})
    minimum_site_count_cases = positive_integer(
        policy["minimum_site_count_cases"], "policy.minimum_site_count_cases"
    )
    require(
        len(site_counts) >= minimum_site_count_cases,
        "benchmark does not contain enough scaling points",
    )
    required_site_count = positive_integer(
        policy["required_site_count"], "policy.required_site_count"
    )
    require(
        max(site_counts) >= required_site_count,
        f"benchmark does not include the required >= {required_site_count} site case",
    )
    for site_count in site_counts:
        for mode in REQUIRED_MODES:
            require(
                (site_count, mode) in case_map,
                f"missing {mode} case for site_count={site_count}",
            )
    require(
        set(requested_counts) >= set(site_counts),
        "benchmark cases are not covered by site_counts_requested",
    )

    pair_metrics = []
    gate_failures: list[str] = []
    timing_policy = object_value(policy["timing"], "policy.timing")
    median_limit = finite_number(
        timing_policy["partial_over_no_mask_median_ratio_max"],
        "policy.partial_over_no_mask_median_ratio_max",
    )
    p95_limit = finite_number(
        timing_policy["partial_over_no_mask_p95_ratio_max"],
        "policy.partial_over_no_mask_p95_ratio_max",
    )
    activation_limit = finite_number(
        timing_policy["activation_p95_wall_ns_per_site_max"],
        "policy.activation_p95_wall_ns_per_site_max",
    )
    million_site_metrics = None
    for site_count in site_counts:
        no_mask = case_map[(site_count, "no_mask")]
        partial = case_map[(site_count, "partial_mask")]
        no_median = percentile(no_mask["step_wall_time_ns_per_step"], 0.5)
        partial_median = percentile(partial["step_wall_time_ns_per_step"], 0.5)
        no_p95 = percentile(no_mask["step_wall_time_ns_per_step"], 0.95)
        partial_p95 = percentile(partial["step_wall_time_ns_per_step"], 0.95)
        median_ratio = partial_median / no_median
        p95_ratio = partial_p95 / no_p95
        if median_ratio > median_limit:
            gate_failures.append(
                f"site_count={site_count} partial/no-mask median ratio {median_ratio:.6g} exceeds {median_limit:.6g}"
            )
        if p95_ratio > p95_limit:
            gate_failures.append(
                f"site_count={site_count} partial/no-mask p95 ratio {p95_ratio:.6g} exceeds {p95_limit:.6g}"
            )
        activation_p95 = (
            percentile(partial["activation_wall_ns_per_site"], 0.95)
            if partial["activation_wall_ns_per_site"]
            else 0.0
        )
        if activation_p95 > activation_limit:
            gate_failures.append(
                f"site_count={site_count} activation wall time per site {activation_p95:.6g} exceeds {activation_limit:.6g}"
            )
        metric = {
            "site_count": site_count,
            "no_mask_median_step_wall_ns": no_median,
            "partial_mask_median_step_wall_ns": partial_median,
            "partial_over_no_mask_median_ratio": median_ratio,
            "no_mask_p95_step_wall_ns": no_p95,
            "partial_mask_p95_step_wall_ns": partial_p95,
            "partial_over_no_mask_p95_ratio": p95_ratio,
            "partial_activation_p95_wall_ns_per_site": activation_p95,
            "mask_bytes": partial["mask_bytes"],
            "mask_bytes_semantics": partial["mask_bytes_semantics"],
            "host_mask_storage_type": partial["host_mask_storage_type"],
            "host_mask_exact_allocated_bytes": partial[
                "host_mask_exact_allocated_bytes"
            ],
            "reference_bytes": partial["reference_bytes"],
            "reference_bytes_semantics": partial["reference_bytes_semantics"],
        }
        pair_metrics.append(metric)
        if site_count >= required_site_count and million_site_metrics is None:
            million_site_metrics = metric
    require(million_site_metrics is not None, "million-site performance metrics are missing")

    if enforce_timing and gate_failures:
        raise EvidenceError("; ".join(gate_failures))

    max_observed_allocation_count = max(
        max(values["steady_state_allocation_count"])
        for values in case_map.values()
    )
    max_observed_allocated_bytes = max(
        max(values["steady_state_allocated_bytes"])
        for values in case_map.values()
    )
    partial_cases = [values for values in case_map.values() if values["mode"] == "partial_mask"]
    max_activation_allocation_count = max(
        max(values["activation_allocation_count"]) for values in partial_cases
    )
    max_activation_allocated_bytes = max(
        max(values["activation_allocated_bytes"]) for values in partial_cases
    )
    activation_policy = object_value(policy["activation"], "policy.activation")
    policy_sha256 = hashlib.sha256(
        json.dumps(policy, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()

    input_digest = (
        hashlib.sha256(input_bytes).hexdigest() if input_bytes is not None else None
    )
    evidence_material = json.dumps(
        {
            "benchmark_schema": BENCHMARK_SCHEMA,
            "benchmark_id": BENCHMARK_ID,
            "policy_schema": policy["schema_version"],
            "policy_revision": policy["policy_revision"],
            "policy_sha256": policy_sha256,
            "input_sha256": input_digest,
            "site_counts": site_counts,
            "pair_metrics": pair_metrics,
            "run_id": runtime["run_id"],
            "binary_sha256": binary_identity["sha256"],
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    evidence_id = f"frozen-spins-fdm-cpu-performance-{hashlib.sha256(evidence_material).hexdigest()}"
    timing_passed = not gate_failures
    return {
        "schema_version": EVIDENCE_SCHEMA,
        "evidence_id": evidence_id,
        # A threshold failure still has a valid, measured receipt. It is
        # deliberately not represented as PASS: callers receive a non-zero
        # exit code while retaining the JSON needed to diagnose the blocker.
        "status": "PASS" if timing_passed else "MEASURED",
        "implementation_status": "RUNTIME_CONFIRMED",
        "plan_provenance": PLAN_PROVENANCE,
        "plan_validation": PLAN_VALIDATION,
        "qualification_status": "UNQUALIFIED" if timing_passed else "PROVISIONAL_FAIL",
        "qualification_blocker": (
            "clean_source_identity_and_production_receipt_binding_pending"
            if timing_passed
            else "performance_policy_threshold_exceeded; " + "; ".join(gate_failures)
        ),
        # These IDs are lane-scoped supplemental evidence. The canonical
        # global IDs remain unclaimed until an aggregator has all required
        # CPU/GPU/FEM/preview measurements.
        "test_case_ids": list(SUPPLEMENTAL_CASE_IDS),
        "global_case_ids_not_claimed": list(REQUIRED_CASE_IDS),
        "partial_coverage": True,
        "lane": {
            "backend": "fdm",
            "execution": "cpu_reference",
            "precision": "double",
            "integrator": "heun",
            "evaluation": "minimal",
            "terms": "none",
            "fallback_used": False,
        },
        "policy": {
            "schema_version": policy["schema_version"],
            "status": policy["policy_status"],
            "owner_approval_status": policy["owner_approval_status"],
            "policy_revision": policy["policy_revision"],
            "sha256": policy_sha256,
        },
        "input_artifact": {
            "path": input_path,
            "bytes": len(input_bytes) if input_bytes is not None else None,
            "sha256": input_digest,
        },
        "runtime": {
            "run_id": run_id,
            "hostname": runtime["hostname"],
            "rayon_threads": runtime["rayon_threads"],
            "thread_policy": dict(runtime["thread_policy"]),
            "clock": runtime["clock"],
            "source_identity": dict(source_identity),
            "binary_identity": dict(binary_identity),
        },
        "configuration": {
            "site_counts": site_counts,
            "repetitions": repetitions,
            "steps_per_sample": steps,
            "warmup_steps": warmup,
            "partial_mask_stride": stride,
            "comparison_scope": COMPARISON_SCOPE,
            "layout_comparison": {
                "no_mask_layout": layout["no_mask_layout"],
                "partial_mask_layout": layout["partial_mask_layout"],
                "matched_layout_mask_isolation": layout["matched_layout_mask_isolation"],
                "interpretation": interpretation,
            },
            "storage_contract": {
                "logical_mask_encoding": storage_policy["logical_mask_encoding"],
                "logical_mask_bytes_per_site": storage_policy[
                    "logical_mask_bytes_per_site"
                ],
                "reference_payload_bytes_per_site": storage_policy[
                    "reference_payload_bytes_per_site"
                ],
                "mask_storage_type": storage_policy["mask_storage_type"],
                "mask_exact_allocated_bytes": storage_policy[
                    "mask_exact_allocated_bytes"
                ],
                "reference_storage_type": storage_policy["reference_storage_type"],
                "reference_bytes_semantics": storage_policy[
                    "reference_bytes_semantics"
                ],
            },
            "thread_policy": {
                "lane": thread_lane,
                "production_gate_required_rayon_threads": object_value(
                    policy["thread_policy"], "policy.thread_policy"
                )["production_default"]["required_rayon_threads"],
                "serial_supplemental_canonical_rayon_threads": object_value(
                    policy["thread_policy"], "policy.thread_policy"
                )["serial_supplemental"]["canonical_rayon_threads"],
            },
        },
        "cases": [case_map[key] for key in sorted(case_map)],
        "metrics": {
            "site_count_pairs": pair_metrics,
            "million_site": million_site_metrics,
            "steady_state_allocation_budget": {
                "max_observed_allocation_count": max_observed_allocation_count,
                "max_observed_allocated_bytes": max_observed_allocated_bytes,
                "policy_max_allocation_count": object_value(
                    policy["steady_state"], "policy.steady_state"
                )["max_allocation_count_per_sample"],
                "policy_max_allocated_bytes": object_value(
                    policy["steady_state"], "policy.steady_state"
                )["max_allocated_bytes_per_sample"],
            },
            "activation_allocation_budget": {
                "max_observed_allocation_count": max_activation_allocation_count,
                "max_observed_allocated_bytes": max_activation_allocated_bytes,
                "policy_max_allocation_count": activation_policy[
                    "max_allocation_count_per_activation"
                ],
                "policy_max_allocated_bytes_per_site": activation_policy[
                    "max_allocated_bytes_per_site"
                ],
            },
        },
        "contracts": {
            "no_mask_baseline": "PASS",
            "partial_mask_measurement": "PASS",
            "activation_wall_time": "PASS",
            "mask_reference_storage": "PASS_LOGICAL_PAYLOAD_HOST_MASK_BYTES_NOT_OBSERVABLE",
            "steady_state_allocation_budget": "PASS",
            "million_sites": "PASS",
            "timing_gate": "PASS" if timing_passed else "PROVISIONAL_FAIL",
            "timing_gate_failures": gate_failures,
            "versioned_acceptance_policy": "PROVISIONAL_NOT_RELEASE_APPROVED",
            "matched_layout_mask_isolation": "NOT_MEASURED",
            "preview_wall_time": "NOT_MEASURED",
            "gpu_transfer_bytes": "NOT_APPLICABLE",
            "full_p15": "INCOMPLETE",
        },
        "p15_coverage": {
            "full_p15_status": "INCOMPLETE",
            "acceptance_policy_status": "PROVISIONAL_ENGINEERING_GATE",
            "global_case_ids": {
                "status": "NOT_CLAIMED",
                "ids": list(REQUIRED_CASE_IDS),
                "reason": "This receipt is supplemental FDM CPU evidence; the global P15 IDs require all required lanes and preview/transfer receipts.",
            },
            "performance": {
                "status": "PASS" if timing_passed else "PROVISIONAL_FAIL",
                "scope": COMPARISON_SCOPE,
                "failures": gate_failures,
            },
            "million_sites": {
                "status": "PASS",
                "minimum_site_count": required_site_count,
            },
            "preview_wall_time": {
                "status": "NOT_MEASURED",
                "reason": "Preview wall time is covered by a separate browser/API receipt, not this CPU step benchmark.",
            },
            "gpu_transfer_bytes": {
                "status": "NOT_APPLICABLE",
                "measured": False,
                "reason": "CPU-only benchmark; GPU H2D/D2H transfer bytes require a separate executed GPU receipt.",
            },
        },
        "gpu_transfer_metrics": {
            "status": "NOT_APPLICABLE",
            "measured": False,
            "reason": "CPU-only benchmark; no GPU runtime was invoked and no H2D/D2H numbers are claimed.",
        },
    }


def write_json_atomic(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp.{os.getpid()}")
    try:
        temporary.write_text(
            json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def run(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--benchmark", type=Path, required=True)
    parser.add_argument("--policy", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args(argv)
    try:
        benchmark, benchmark_bytes = load_json(arguments.benchmark, "benchmark")
        policy, _ = load_json(arguments.policy, "policy")
        evidence = build_evidence(
            benchmark,
            policy,
            input_path=arguments.benchmark.resolve().as_posix(),
            input_bytes=benchmark_bytes,
            enforce_timing=False,
        )
        write_json_atomic(arguments.output, evidence)
        print(
            json.dumps(
                {
                    "output": arguments.output.resolve().as_posix(),
                    "status": evidence["status"],
                    "qualification_status": evidence["qualification_status"],
                    "test_case_ids": evidence["test_case_ids"],
                },
                sort_keys=True,
            )
        )
        return 0 if evidence["status"] == "PASS" else 2
    except (EvidenceError, OSError) as error:
        print(f"FROZEN_SPINS_PERFORMANCE_EVIDENCE_ERROR={error}")
        return 2


if __name__ == "__main__":
    raise SystemExit(run())
