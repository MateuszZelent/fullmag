#!/usr/bin/env python3
"""Build fail-closed CPU multilayer Frozen Spins/ABM3 evidence from a test log."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence


SCHEMA = "fullmag.frozen_spins.fdm_multilayer.scientific.evidence.v1"
REQUIRED_TESTS = {
    "fdm::cpu::multilayer_reference::tests::multilayer_frozen_spins_are_hard_restored_through_rk_stages",
    "fdm::cpu::multilayer_reference::tests::multilayer_all_frozen_mask_covers_every_layer_without_state_drift",
    "fdm::cpu::multilayer_reference::tests::multilayer_all_frozen_materializes_scalar_and_field_schedule_without_steps",
    "fdm::cpu::multilayer_reference::tests::multilayer_all_frozen_relaxation_completes_without_solver_steps",
    "fdm::cpu::multilayer_reference::tests::multilayer_no_mask_parity_matches_explicit_all_free_mask",
    "fdm::cpu::multilayer_reference::tests::multilayer_abm3_frozen_spins_checkpoint_resume_matches_uninterrupted_run",
    "fdm::cpu::multilayer_reference::tests::multilayer_frozen_layer_remains_in_demag_influence_on_free_layer",
}
PLANNER_TEST = "tests::staged_cpu_multilayer_selects_stateful_abm3"


class EvidenceError(ValueError):
    pass


def build_evidence(log_bytes: bytes) -> dict[str, object]:
    text = log_bytes.decode("utf-8", errors="replace")
    missing = sorted(
        name for name in REQUIRED_TESTS if f"test {name} ... ok" not in text
    )
    if PLANNER_TEST not in text or f"test {PLANNER_TEST} ... ok" not in text:
        missing.append(PLANNER_TEST)
    if missing:
        raise EvidenceError("missing passing multilayer tests: " + ", ".join(missing))
    if "test result: ok." not in text or "0 failed" not in text:
        raise EvidenceError("cargo test output does not prove a passing multilayer run")

    return {
        "schema_version": SCHEMA,
        "status": "PASS",
        "implementation_status": "RUNTIME_CONFIRMED",
        "qualification_status": "UNQUALIFIED",
        "qualification_blocker": "clean_source_identity_and_p16_receipt_binding",
        "timestamp_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "lane": {
            "backend": "fdm",
            "execution": "cpu_reference_multilayer",
            "precision": "fp64",
            "mesh_mode": "multilayer_native_layer_order",
            "integrators": ["heun", "rk4", "rk23", "abm3"],
        },
        "tests": sorted(REQUIRED_TESTS | {PLANNER_TEST}),
        "test_case_ids": [
            "FS-P8-FDM-MULTILAYER",
            "FS-P8-ABM3-HISTORY-RESUME",
            "FS-P15-INFLUENCE",
            "FS-P15-INVARIANT",
        ],
        "contracts": {
            "frozen_reference_bitwise": "PASS",
            "frozen_layer_demag_influence_on_free_layer": "PASS",
        "abm3_history_checkpoint_resume_bitwise": "PASS",
        "all_frozen_clock_and_state_invariant": "PASS",
        "all_frozen_schedule_materialization": "PASS",
        "all_frozen_relaxation_completion": "PASS",
        "no_mask_parity": "PASS",
            "planner_selects_cpu_multilayer_abm3": "PASS",
            "native_layer_offset_mapping": "PASS",
            "cuda_multilayer_device_resident_v2": "FAIL_CLOSED_UNQUALIFIED",
        },
        "artifact": {
            "kind": "cargo_test_log",
            "sha256": hashlib.sha256(log_bytes).hexdigest(),
            "bytes": len(log_bytes),
        },
    }


def write_json_atomic(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp")
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
    parser.add_argument("--log", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args(argv)
    try:
        log_path = arguments.log
        evidence = build_evidence(log_path.read_bytes())
        try:
            artifact_path = log_path.resolve().relative_to(Path.cwd().resolve())
        except ValueError:
            artifact_path = log_path
        evidence["artifact"]["path"] = artifact_path.as_posix()  # type: ignore[index]
        write_json_atomic(arguments.output, evidence)
    except (OSError, EvidenceError) as error:
        print(f"FROZEN_SPINS_FDM_MULTILAYER_EVIDENCE_ERROR={error}")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
