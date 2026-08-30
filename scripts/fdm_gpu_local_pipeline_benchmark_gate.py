#!/usr/bin/env python3
"""Validate and publish FDM GPU local-pipeline benchmark evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import statistics
import tempfile
from datetime import datetime, timezone
from pathlib import Path


SCHEMA = "fullmag.fdm_gpu.local_pipeline_performance_gate.v1"
RECORD_SCHEMA = "fullmag.fdm_gpu.local_pipeline_benchmark.v1"
EXPECTED_CELLS = (1024, 65536, 1048576)
EXPECTED_PRECISIONS = ("fp64", "fp32")
EXPECTED_REALIZATIONS = ("direct_fused", "direct_unfused")
KERNEL_RESOURCES_SCHEMA = "fullmag.fdm_gpu.local_pipeline_kernel_resources.v1"
MAX_REGISTERS_PER_THREAD = 128
MAX_LOCAL_BYTES_PER_THREAD = 0
MIN_THEORETICAL_OCCUPANCY_PERMYRIAD = 2500
SMALL_MEDIUM_MAXIMUM_RATIO = 1.01
LARGE_MAXIMUM_REGRESSION = 0.02
LARGE_MAXIMUM_RATIO = 1.02


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def _full_hash(value: str, length: int, label: str) -> str:
    _require(
        len(value) == length and all(char in "0123456789abcdef" for char in value),
        f"{label} must be a full lowercase hexadecimal hash",
    )
    return value


def load_records(path: Path) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"invalid JSON at line {line_number}: {error}") from error
        _require(isinstance(record, dict), f"line {line_number} is not an object")
        records.append(record)
    _require(records, "benchmark input is empty")
    return records


def evaluate(
    records: list[dict[str, object]],
    repetitions: int,
    source_commit: str,
    source_diff_sha256: str,
) -> dict[str, object]:
    _full_hash(source_commit, 40, "source commit")
    _full_hash(source_diff_sha256, 64, "source diff SHA-256")
    _require(repetitions >= 3, "performance gate requires at least three repetitions")
    grouped: dict[tuple[str, int, str], list[dict[str, object]]] = {}
    devices: set[tuple[str, str]] = set()
    kernel_resources: dict[str, set[tuple[int, ...]]] = {
        precision: set() for precision in EXPECTED_PRECISIONS
    }
    for record in records:
        _require(record.get("schema") == RECORD_SCHEMA, "unknown benchmark schema")
        precision = str(record.get("precision"))
        cells = int(record.get("cells", 0))
        realization = str(record.get("executed_realization"))
        _require(precision in EXPECTED_PRECISIONS, "unexpected precision")
        _require(cells in EXPECTED_CELLS, "unexpected grid size")
        _require(realization in EXPECTED_REALIZATIONS, "unexpected realization")
        _require(
            record.get("resolved_realization") == realization and
            record.get("requested_policy") == "auto_safe",
            "requested/resolved/executed provenance mismatch",
        )
        elapsed = float(record.get("ns_per_step", 0.0))
        checksum = float(record.get("checksum", math.nan))
        _require(math.isfinite(elapsed) and elapsed > 0.0, "invalid step latency")
        _require(math.isfinite(checksum), "invalid trajectory checksum")
        _require(
            record.get("kernel_resources_schema") == KERNEL_RESOURCES_SCHEMA,
            "unknown kernel-resources schema",
        )
        block_threads = int(record.get("kernel_block_threads", 0))
        registers_per_thread = int(record.get("kernel_registers_per_thread", -1))
        static_shared_bytes = int(record.get("kernel_static_shared_bytes", -1))
        local_bytes_per_thread = int(record.get("kernel_local_bytes_per_thread", -1))
        max_active_blocks_per_sm = int(
            record.get("kernel_max_active_blocks_per_sm", 0)
        )
        max_threads_per_sm = int(record.get("kernel_max_threads_per_sm", 0))
        multiprocessor_count = int(record.get("kernel_multiprocessor_count", 0))
        theoretical_occupancy = int(
            record.get("kernel_theoretical_occupancy_permyriad", -1)
        )
        _require(block_threads == 256, "unexpected fused-kernel block size")
        _require(
            0 <= registers_per_thread <= MAX_REGISTERS_PER_THREAD,
            "fused-kernel register budget exceeded",
        )
        _require(static_shared_bytes >= 0, "invalid static shared-memory accounting")
        _require(
            0 <= local_bytes_per_thread <= MAX_LOCAL_BYTES_PER_THREAD,
            "fused-kernel local-memory spill budget exceeded",
        )
        _require(
            max_active_blocks_per_sm > 0
            and max_threads_per_sm > 0
            and multiprocessor_count > 0,
            "invalid occupancy inputs",
        )
        expected_occupancy = min(
            10_000,
            max_active_blocks_per_sm * block_threads * 10_000 // max_threads_per_sm,
        )
        _require(
            theoretical_occupancy == expected_occupancy,
            "fused-kernel theoretical occupancy is inconsistent",
        )
        _require(
            theoretical_occupancy >= MIN_THEORETICAL_OCCUPANCY_PERMYRIAD,
            "fused-kernel theoretical occupancy budget not met",
        )
        kernel_resources[precision].add(
            (
                block_threads,
                registers_per_thread,
                static_shared_bytes,
                local_bytes_per_thread,
                max_active_blocks_per_sm,
                max_threads_per_sm,
                multiprocessor_count,
                theoretical_occupancy,
            )
        )
        total_steps = int(record.get("warmup_steps", 0)) + int(
            record.get("measured_steps", 0)
        )
        expected_stages = 2 * total_steps
        if realization == "direct_fused":
            _require(
                int(record.get("fused_launches", -1)) == expected_stages and
                int(record.get("unfused_field_launches", -1)) == 0 and
                int(record.get("unfused_rhs_launches", -1)) == 0,
                "fused launch accounting mismatch",
            )
        else:
            _require(
                int(record.get("fused_launches", -1)) == 0 and
                int(record.get("unfused_field_launches", -1)) == expected_stages and
                int(record.get("unfused_rhs_launches", -1)) == expected_stages,
                "unfused launch accounting mismatch",
            )
        grouped.setdefault((precision, cells, realization), []).append(record)
        devices.add((str(record.get("device")), str(record.get("compute_capability"))))

    expected_record_count = (
        len(EXPECTED_PRECISIONS) * len(EXPECTED_CELLS) *
        len(EXPECTED_REALIZATIONS) * repetitions
    )
    _require(len(records) == expected_record_count, "benchmark matrix is incomplete")
    _require(len(devices) == 1, "benchmark records mix device identities")
    _require(
        all(len(resources) == 1 for resources in kernel_resources.values()),
        "fused-kernel resources changed within one precision matrix",
    )

    cases: list[dict[str, object]] = []
    for precision in EXPECTED_PRECISIONS:
        for cells in EXPECTED_CELLS:
            fused = grouped.get((precision, cells, "direct_fused"), [])
            unfused = grouped.get((precision, cells, "direct_unfused"), [])
            _require(
                len(fused) == repetitions and len(unfused) == repetitions,
                "benchmark case has the wrong repetition count",
            )
            checksums = [float(record["checksum"]) for record in fused + unfused]
            checksum_span = max(checksums) - min(checksums)
            checksum_scale = max(1.0, max(abs(value) for value in checksums))
            tolerance = 1.0e-12 if precision == "fp64" else 1.0e-6
            _require(
                checksum_span <= tolerance * checksum_scale,
                "fused/unfused trajectory checksum parity failed",
            )
            fused_latency = statistics.median(
                float(record["ns_per_step"]) for record in fused
            )
            unfused_latency = statistics.median(
                float(record["ns_per_step"]) for record in unfused
            )
            ratio = fused_latency / unfused_latency
            maximum_ratio = (
                SMALL_MEDIUM_MAXIMUM_RATIO
                if cells <= 65536
                else LARGE_MAXIMUM_RATIO
            )
            _require(
                ratio <= maximum_ratio,
                f"performance budget exceeded for {precision}/{cells}: "
                f"ratio={ratio:.6f} budget={maximum_ratio:.6f}",
            )
            cases.append(
                {
                    "precision": precision,
                    "cells": cells,
                    "repetitions": repetitions,
                    "fused_median_ns_per_step": fused_latency,
                    "unfused_median_ns_per_step": unfused_latency,
                    "fused_to_unfused_ratio": ratio,
                    "maximum_ratio": maximum_ratio,
                    "checksum_span": checksum_span,
                    "launches_per_stage": {"fused": 1, "unfused": 2},
                    "status": "pass",
                }
            )

    device, compute_capability = next(iter(devices))
    resource_receipts = []
    for precision in EXPECTED_PRECISIONS:
        (
            block_threads,
            registers_per_thread,
            static_shared_bytes,
            local_bytes_per_thread,
            max_active_blocks_per_sm,
            max_threads_per_sm,
            multiprocessor_count,
            theoretical_occupancy,
        ) = next(iter(kernel_resources[precision]))
        resource_receipts.append(
            {
                "precision": precision,
                "block_threads": block_threads,
                "registers_per_thread": registers_per_thread,
                "static_shared_bytes": static_shared_bytes,
                "local_bytes_per_thread": local_bytes_per_thread,
                "max_active_blocks_per_sm": max_active_blocks_per_sm,
                "max_threads_per_sm": max_threads_per_sm,
                "multiprocessor_count": multiprocessor_count,
                "theoretical_occupancy_permyriad": theoretical_occupancy,
            }
        )
    return {
        "schema": SCHEMA,
        "status": "pass",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "source": {
            "commit": source_commit,
            "diff_sha256": source_diff_sha256,
        },
        "device": {
            "name": device,
            "compute_capability": compute_capability,
        },
        "policy": {
            "requested": "auto_safe",
            "tested_realizations": list(EXPECTED_REALIZATIONS),
            "small_medium_maximum_ratio": SMALL_MEDIUM_MAXIMUM_RATIO,
            "large_maximum_regression": LARGE_MAXIMUM_REGRESSION,
            "maximum_registers_per_thread": MAX_REGISTERS_PER_THREAD,
            "maximum_local_bytes_per_thread": MAX_LOCAL_BYTES_PER_THREAD,
            "minimum_theoretical_occupancy_permyriad":
                MIN_THEORETICAL_OCCUPANCY_PERMYRIAD,
        },
        "kernel_resources": resource_receipts,
        "cases": cases,
    }


def _assert_outside_repository(path: Path) -> None:
    repository = Path(__file__).resolve().parents[1]
    resolved = path.resolve()
    _require(
        resolved != repository and repository not in resolved.parents,
        "benchmark evidence must be written outside the Git repository",
    )


def write_atomic(path: Path, payload: dict[str, object]) -> None:
    _assert_outside_repository(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repetitions", type=int, required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--source-diff-sha256", required=True)
    args = parser.parse_args()
    _assert_outside_repository(args.input)
    payload = evaluate(
        load_records(args.input),
        args.repetitions,
        args.source_commit,
        args.source_diff_sha256,
    )
    payload["raw_input_sha256"] = hashlib.sha256(args.input.read_bytes()).hexdigest()
    write_atomic(args.output, payload)
    print(json.dumps(payload, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
