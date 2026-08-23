#!/usr/bin/env python3
"""Initialize and atomically publish strict FDM GPU residency evidence."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path


SCHEMA_VERSION = "fdm_gpu_execution_receipt_evidence.v1"


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
        "fallback_count": 0,
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
    if not isinstance(document, dict):
        raise ValueError("evidence candidate must be a JSON object")
    if document.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("evidence candidate has an unsupported schema_version")
    if document.get("validation_state") != "validated":
        raise ValueError("evidence candidate is not validated")
    if document.get("runtime_check") != "passed":
        raise ValueError("evidence candidate runtime_check did not pass")
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
