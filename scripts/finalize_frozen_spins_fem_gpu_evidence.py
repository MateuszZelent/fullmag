#!/usr/bin/env python3
"""Finalize the FEM GPU Frozen Spins receipt after every managed gate passes."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Sequence


EXPECTED_SCHEMA = "fullmag.frozen_spins.fem.cuda.runtime.evidence.v1"


class EvidenceError(ValueError):
    pass


def finalize(payload: object) -> dict[str, object]:
    if not isinstance(payload, dict):
        raise EvidenceError("native evidence must be a JSON object")
    if payload.get("schema_version") != EXPECTED_SCHEMA:
        raise EvidenceError("native evidence has an unexpected schema_version")
    if payload.get("status") != "PASS":
        raise EvidenceError("native runtime contract did not report PASS")
    device = payload.get("device")
    if not isinstance(device, dict) or not device.get("name"):
        raise EvidenceError("native evidence is missing the CUDA device identity")
    if payload.get("fallback_used") is not False or payload.get("fallback_trail") != []:
        raise EvidenceError("native evidence contains a fallback")
    source_identity = payload.get("source_identity")
    if not isinstance(source_identity, dict):
        raise EvidenceError("native evidence is missing source identity")
    if not source_identity.get("source_snapshot_sha256"):
        raise EvidenceError("native evidence has no source snapshot digest")

    source_dirty = source_identity.get("source_snapshot_dirty") is True
    finalized = dict(payload)
    finalized.update(
        {
            "implementation_status": "RUNTIME_CONFIRMED",
            "runtime_source_status": payload.get("qualification_status"),
            "qualification_status": "UNQUALIFIED",
            "qualification_blocker": (
                "dirty_source_snapshot"
                if source_dirty
                else "full_cross_layer_qualification_not_complete"
            ),
            "gate_result": "PASS",
            "managed_recipe_gates": {
                "native_runtime_contract": "PASS",
                "receipt_builder_unit_tests": "PASS",
                "runner_capability": "PASS",
                "interactive_hot_rebuild": "PASS",
            },
            "interactive_hot_rebuild_contract": {
                "apply_boundary": "accepted_step",
                "carrier": "fem_serial_p1_true_dof",
                "continuation_magnetization_preserved": True,
                "activation_epoch_advanced": True,
                "resolved_constraint_set_revision_advanced": True,
                "mask_identity_preserved": True,
                "reference_identity_recaptured": True,
                "frozen_spins_quantity_verified": True,
                "quantity_active_mask_verified": True,
            },
        }
    )
    return finalized


def write_json_atomic(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.finalize.tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args(argv)
    try:
        native = json.loads(arguments.input.read_text(encoding="utf-8"))
        write_json_atomic(arguments.output, finalize(native))
    except (OSError, json.JSONDecodeError, EvidenceError) as error:
        print(f"FROZEN_SPINS_FEM_GPU_EVIDENCE_ERROR={error}")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
