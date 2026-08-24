#!/usr/bin/env python3
"""Initialize and atomically publish strict FDM GPU residency evidence."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path


SCHEMA_VERSION = "fdm_gpu_execution_receipt_evidence.v1"
KNOWN_OPERATOR_MASK = (1 << 19) - 1
TRANSFER_KEYS = {
    "setup_full_vector_h2d_count",
    "setup_full_vector_h2d_bytes",
    "setup_full_vector_d2h_count",
    "setup_full_vector_d2h_bytes",
    "hot_loop_full_vector_h2d_count",
    "hot_loop_full_vector_h2d_bytes",
    "hot_loop_full_vector_d2h_count",
    "hot_loop_full_vector_d2h_bytes",
    "hot_loop_host_compute_count",
    "hot_loop_host_sync_count",
    "hot_loop_control_scalar_d2h_bytes",
    "hot_loop_control_scalar_host_sync_count",
    "observation_full_vector_h2d_count",
    "observation_full_vector_h2d_bytes",
    "observation_full_vector_d2h_count",
    "observation_full_vector_d2h_bytes",
}


def _non_negative_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _validate_candidate(document: object) -> None:
    if not isinstance(document, dict):
        raise ValueError("evidence candidate must be a JSON object")
    required_fields = {
        "schema_version",
        "validation_state",
        "runtime_check",
        "requested",
        "resolved",
        "executed",
        "device_ordinal",
        "precision",
        "integrator",
        "required_operator_mask",
        "resolved_device_operator_mask",
        "resolved_host_operator_mask",
        "resolved_unknown_operator_mask",
        "executed_device_operator_mask",
        "executed_host_operator_mask",
        "executed_unknown_operator_mask",
        "fallback_count",
        "accounting_valid",
        "transfer_counts",
    }
    missing = required_fields - document.keys()
    if missing:
        raise ValueError(f"evidence candidate is missing fields: {sorted(missing)}")
    if document["schema_version"] != SCHEMA_VERSION:
        raise ValueError("evidence candidate has an unsupported schema_version")
    if document["validation_state"] != "validated" or document["runtime_check"] != "passed":
        raise ValueError("evidence candidate is not runtime-validated")
    if document["requested"] != "gpu" or document["resolved"] != "device_resident" or document["executed"] != "cuda_fdm":
        raise ValueError("evidence candidate execution identity is contradictory")
    if not _non_negative_integer(document["device_ordinal"]):
        raise ValueError("evidence candidate device_ordinal is invalid")
    if document["precision"] != "double" or document["integrator"] not in {
        "heun", "rk4", "rk23", "dp45", "abm3"
    }:
        raise ValueError("evidence candidate precision/integrator is invalid")
    mask_fields = [
        "required_operator_mask",
        "resolved_device_operator_mask",
        "resolved_host_operator_mask",
        "resolved_unknown_operator_mask",
        "executed_device_operator_mask",
        "executed_host_operator_mask",
        "executed_unknown_operator_mask",
    ]
    if not all(_non_negative_integer(document[name]) for name in mask_fields):
        raise ValueError("evidence candidate operator masks must be integers")
    required = document["required_operator_mask"]
    if required == 0 or required & ~KNOWN_OPERATOR_MASK:
        raise ValueError("evidence candidate required_operator_mask is invalid")
    if (
        document["resolved_device_operator_mask"] != required
        or document["resolved_host_operator_mask"] != 0
        or document["resolved_unknown_operator_mask"] != 0
        or document["executed_device_operator_mask"] != required
        or document["executed_host_operator_mask"] != 0
        or document["executed_unknown_operator_mask"] != 0
    ):
        raise ValueError("evidence candidate operator realization is incomplete")
    if document["fallback_count"] != 0 or document["accounting_valid"] is not True:
        raise ValueError("evidence candidate fallback/accounting is invalid")
    counts = document["transfer_counts"]
    if not isinstance(counts, dict) or set(counts) != TRANSFER_KEYS:
        raise ValueError("evidence candidate transfer_counts schema is incomplete")
    if not all(_non_negative_integer(value) for value in counts.values()):
        raise ValueError("evidence candidate transfer counts must be non-negative integers")
    if counts["setup_full_vector_h2d_count"] == 0 or counts["setup_full_vector_h2d_bytes"] == 0:
        raise ValueError("evidence candidate does not prove initial device upload")
    if any(counts[name] != 0 for name in (
        "hot_loop_full_vector_h2d_count",
        "hot_loop_full_vector_h2d_bytes",
        "hot_loop_full_vector_d2h_count",
        "hot_loop_full_vector_d2h_bytes",
        "hot_loop_host_compute_count",
    )):
        raise ValueError("evidence candidate contains forbidden hot-loop work")
    if counts["hot_loop_host_sync_count"] > counts["hot_loop_control_scalar_host_sync_count"]:
        raise ValueError("evidence candidate contains unclassified host synchronization")


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def initialize(final: Path, candidate: Path) -> None:
    candidate.unlink(missing_ok=True)
    unavailable = {
        "schema_version": SCHEMA_VERSION,
        "validation_state": "unvalidated",
        "runtime_check": "unavailable",
        "requested": "gpu",
        "resolved": "unavailable",
        "executed": "none",
        "device_ordinal": -1,
        "precision": "double",
        "integrator": "unknown",
        "required_operator_mask": 0,
        "resolved_device_operator_mask": 0,
        "resolved_host_operator_mask": 0,
        "resolved_unknown_operator_mask": 0,
        "executed_device_operator_mask": 0,
        "executed_host_operator_mask": 0,
        "executed_unknown_operator_mask": 0,
        "fallback_count": 0,
        "accounting_valid": False,
        "transfer_counts": {
            "setup_full_vector_h2d_count": 0,
            "setup_full_vector_h2d_bytes": 0,
            "setup_full_vector_d2h_count": 0,
            "setup_full_vector_d2h_bytes": 0,
            "hot_loop_full_vector_h2d_count": 0,
            "hot_loop_full_vector_h2d_bytes": 0,
            "hot_loop_full_vector_d2h_count": 0,
            "hot_loop_full_vector_d2h_bytes": 0,
            "hot_loop_host_compute_count": 0,
            "hot_loop_host_sync_count": 0,
            "hot_loop_control_scalar_d2h_bytes": 0,
            "hot_loop_control_scalar_host_sync_count": 0,
            "observation_full_vector_h2d_count": 0,
            "observation_full_vector_h2d_bytes": 0,
            "observation_full_vector_d2h_count": 0,
            "observation_full_vector_d2h_bytes": 0,
        },
    }
    _atomic_write(final, (json.dumps(unavailable, indent=2) + "\n").encode("utf-8"))


def publish(final: Path, candidate: Path) -> None:
    payload = candidate.read_bytes()
    document = json.loads(payload)
    _validate_candidate(document)
    _atomic_write(final, payload)
    candidate.unlink()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("init", "publish"))
    parser.add_argument("--final", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    arguments = parser.parse_args()
    if arguments.action == "init":
        initialize(arguments.final, arguments.candidate)
    else:
        publish(arguments.final, arguments.candidate)


if __name__ == "__main__":
    main()
