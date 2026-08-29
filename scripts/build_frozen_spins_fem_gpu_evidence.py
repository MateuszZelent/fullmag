#!/usr/bin/env python3
"""Build a persistent FEM CUDA Frozen Spins runtime evidence receipt."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA = "fullmag.frozen_spins.fem.cuda.runtime.evidence.v1"
REQUIRED_PASS_LINES = (
    "PASS: FrozenSpins unit contract",
    "PASS: FrozenSpins periodic representation contract",
    "PASS: FrozenSpins architecture contract",
    "PASS: FrozenSpins CPU solver step contract",
    "PASS: FrozenSpins GPU solver step contract",
    "PASS: FrozenSpins direct minimizer contract",
)


def _marker_values(log: str, marker: str) -> dict[str, str]:
    match = re.search(rf"^{re.escape(marker)}\s+(.+)$", log, re.MULTILINE)
    if match is None:
        raise ValueError(f"missing runtime marker: {marker}")
    values: dict[str, str] = {}
    for token in match.group(1).split():
        if "=" not in token:
            raise ValueError(f"malformed {marker} token: {token}")
        key, value = token.split("=", 1)
        values[key] = value
    return values


def _required_int(values: dict[str, str], key: str) -> int:
    if key not in values:
        raise ValueError(f"missing marker field: {key}")
    return int(values[key], 10)


def parse_nvidia_smi_row(row: str) -> dict[str, str]:
    fields = next(csv.reader([row], skipinitialspace=True))
    if len(fields) != 5 or any(not field.strip() for field in fields):
        raise ValueError("nvidia-smi identity row must contain five non-empty fields")
    return {
        "uuid": fields[0].strip(),
        "name": fields[1].strip(),
        "pci_bus_id": fields[2].strip(),
        "nvidia_driver_version": fields[3].strip(),
        "compute_capability": fields[4].strip(),
    }


def query_nvidia_smi() -> dict[str, str]:
    output = subprocess.check_output(
        [
            "nvidia-smi",
            "--query-gpu=uuid,name,pci.bus_id,driver_version,compute_cap",
            "--format=csv,noheader",
        ],
        text=True,
    )
    rows = [line for line in output.splitlines() if line.strip()]
    if len(rows) != 1:
        raise ValueError(f"expected exactly one visible CUDA device, got {len(rows)}")
    return parse_nvidia_smi_row(rows[0])


def build_receipt(
    *,
    log: str,
    source_identity: dict[str, Any],
    gpu_identity: dict[str, str],
    timestamp_utc: str,
) -> dict[str, Any]:
    missing = [line for line in REQUIRED_PASS_LINES if line not in log]
    if missing:
        raise ValueError(f"test log is missing PASS gates: {missing}")

    device = _marker_values(log, "FROZEN_SPINS_FEM_GPU_DEVICE")
    transfer = _marker_values(log, "FROZEN_SPINS_FEM_GPU_TRANSFER")
    build = _marker_values(log, "FROZEN_SPINS_FEM_GPU_BUILD")
    marker_cc = device.get("compute_capability")
    if marker_cc != gpu_identity["compute_capability"]:
        raise ValueError(
            "CUDA runtime and nvidia-smi compute capability disagree: "
            f"{marker_cc!r} != {gpu_identity['compute_capability']!r}"
        )

    zero_transfer_fields = (
        "hot_loop_h2d_bytes",
        "hot_loop_compute_h2d_bytes",
        "hot_loop_compute_d2h_bytes",
        "hot_loop_exchange_h2d_bytes",
        "hot_loop_exchange_d2h_bytes",
    )
    parsed_transfer = {key: _required_int(transfer, key) for key in zero_transfer_fields}
    nonzero = {key: value for key, value in parsed_transfer.items() if value != 0}
    if nonzero:
        raise ValueError(f"Frozen Spins hot-loop transfer gate failed: {nonzero}")

    dirty = bool(source_identity.get("source_snapshot_dirty"))
    return {
        "schema_version": SCHEMA,
        "timestamp_utc": timestamp_utc,
        "backend": "fullmag_fem",
        "lane": "true_dof_cuda_explicit_rk_and_direct_minimizers",
        "precision": "fp64",
        "qualification_status": (
            "RUNTIME_CONFIRMED_DIRTY_SOURCE" if dirty else "RUNTIME_CONFIRMED"
        ),
        "source_identity": {
            "schema": source_identity.get("schema"),
            "head_commit_full": source_identity.get("head_commit_full"),
            "source_snapshot_sha256": source_identity.get("source_snapshot_sha256"),
            "source_snapshot_dirty": dirty,
            "dirty_content_sha256": source_identity.get("dirty_content_sha256"),
        },
        "device": {
            **gpu_identity,
            "cuda_driver_api_version": str(_required_int(device, "driver_version")),
            "cuda_runtime_version": str(_required_int(device, "runtime_version")),
        },
        "runtime": {
            "mfem_device_configuration": "cuda",
            "mfem_version": build.get("mfem_version", ""),
            "hypre_version": build.get("hypre_version", ""),
            "mpi_rank_count": 1,
        },
        "state": {
            "true_dof_count": _required_int(device, "node_count") * 3,
            "node_count": _required_int(device, "node_count"),
            "device_bytes": _required_int(device, "device_bytes"),
            "constraint_layout": "local_node_aos_identity_true_dof_map",
            "free_node_mask_device_resident": True,
            "frozen_reference_device_resident": True,
        },
        "algorithms_verified": ["heun", "projected_gradient_bb", "nonlinear_cg"],
        "tangent_plane_implicit": {
            "status": "UNSUPPORTED",
            "reason_code": "frozen_spins_fem_gpu_tpi_unqualified",
        },
        "cases": {
            "non_axis_bitwise_restore": True,
            "free_node_mobility": True,
            "all_frozen": True,
            "no_mask_bitwise_parity": True,
            "strict_device_execution": True,
        },
        "transfer_audit": parsed_transfer,
        "fallback_used": False,
        "fallback_trail": [],
        "test_log_sha256": hashlib.sha256(log.encode("utf-8")).hexdigest(),
        "status": "PASS",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--test-log", required=True, type=Path)
    parser.add_argument("--source-identity", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    log = args.test_log.read_text(encoding="utf-8")
    source_identity = json.loads(args.source_identity.read_text(encoding="utf-8"))
    receipt = build_receipt(
        log=log,
        source_identity=source_identity,
        gpu_identity=query_nvidia_smi(),
        timestamp_utc=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
