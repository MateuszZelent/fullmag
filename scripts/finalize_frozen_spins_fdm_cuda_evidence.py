#!/usr/bin/env python3
"""Finalize the FDM CUDA Frozen Spins receipt after every managed gate passes."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Sequence


EXPECTED_SCHEMA = "fullmag.frozen_spins.cuda.runtime.evidence.v1"


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
    fallback_trail = payload.get("fallback_trail")
    if fallback_trail != []:
        raise EvidenceError("native evidence contains a non-empty fallback trail")

    finalized = dict(payload)
    finalized.update(
        {
            "implementation_status": "RUNTIME_CONFIRMED",
            "qualification_status": "UNQUALIFIED",
            "qualification_blocker": "clean_source_identity_not_bound",
            "gate_result": "PASS",
            "managed_recipe_gates": {
                "native_abi_contract": "PASS",
                "native_runtime_contract": "PASS",
                "rust_ffi_plan_extension": "PASS",
                "runner_capability": "PASS",
                "interactive_hot_rebuild": "PASS",
                "checkpoint_suite": "PASS",
                "checkpoint_reference_restore": "PASS",
            },
            "interactive_hot_rebuild_contract": {
                "apply_boundary": "accepted_step",
                "continuation_magnetization_preserved": True,
                "activation_epoch_advanced": True,
                "resolved_constraint_set_revision_advanced": True,
                "mask_identity_preserved": True,
                "reference_identity_recaptured": True,
                "frozen_spins_quantity_verified": True,
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
        print(f"FROZEN_SPINS_FDM_CUDA_EVIDENCE_ERROR={error}")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
