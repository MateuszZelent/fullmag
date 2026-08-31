#!/usr/bin/env python3
"""Build fail-closed FDM CPU Frozen Spins scientific runtime evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence


SCHEMA = "fullmag.frozen_spins.fdm_cpu.scientific.evidence.v1"
SCIENTIFIC_TESTS = {
    "frozen_spins_two_spin_exchange_matches_independent_oracle_and_reference_influence",
    "frozen_spins_fdm_cpu_preserves_pinned_cell_and_evolves_free_exchange_neighbor",
    "frozen_spins_fdm_cpu_keeps_pinned_source_in_exchange_and_demag",
    "frozen_spins_fdm_cpu_masks_stt_sot_and_thermal_rhs",
    "frozen_spins_thermal_fixed_seed_is_bitwise_reproducible",
    "frozen_spins_fdm_cpu_all_frozen_completes_without_integrator_steps",
    "frozen_spins_fdm_cpu_publishes_free_and_all_telemetry_without_hiding_pinned_torque",
    "frozen_spins_all_frozen_telemetry_retains_stt_sot_and_thermal_rhs",
    "frozen_spins_fdm_cpu_preserves_candidate_references_for_every_public_integrator",
    "frozen_spins_fdm_cpu_false_mask_is_bitwise_legacy_parity",
    "frozen_spins_direct_minimizer_preserves_reference_with_one_free_dof",
    "frozen_spins_direct_minimizer_all_frozen_is_finite_zero_step_noop",
}
CHECKPOINT_TESTS = {
    "fdm::cpu::reference::tests::frozen_spins_checkpoint_round_trip_restores_reference_without_selector_recapture",
    "fdm::cpu::reference::tests::abm3_frozen_spins_checkpoint_resume_is_bitwise_identical",
}
REQUIRED_TESTS = SCIENTIFIC_TESTS | CHECKPOINT_TESTS
TEST_CASE_IDS = [
    "FS-P6-EXACT-RESUME",
    "FS-P7-ALL-FROZEN-RELAXATION",
    "FS-P7-FDM-CPU-FP64",
    "FS-P8-ABM3-HISTORY-RESUME",
    "FS-P15-CHECKPOINT-CONTINUITY",
    "FS-P15-ENERGY-ACCOUNTING",
    "FS-P15-FREE-ONLY-STOPPING",
    "FS-P15-INDEPENDENT-ORACLE",
    "FS-P15-INFLUENCE",
    "FS-P15-INVARIANT",
    "FS-P15-MINIMIZER-ORACLE",
    "FS-P15-MOBILITY",
    "FS-P15-NO-MASK-PARITY",
    "FS-P15-THERMAL",
]


class EvidenceError(ValueError):
    pass


def build_evidence(log_bytes: bytes) -> dict[str, object]:
    text = log_bytes.decode("utf-8", errors="replace")
    missing = sorted(
        [
            name
            for name in SCIENTIFIC_TESTS
            if f"fdm_relaxation::{name} ... ok" not in text
        ]
        + [name for name in CHECKPOINT_TESTS if f"test {name} ... ok" not in text]
    )
    if missing:
        raise EvidenceError("missing passing scientific tests: " + ", ".join(missing))
    expected_summary = (
        f"test result: ok. {len(SCIENTIFIC_TESTS)} passed; 0 failed; 0 ignored; "
    )
    if expected_summary not in text:
        raise EvidenceError("cargo test summary does not prove the complete scientific set")
    if text.count("test result: ok. 1 passed; 0 failed; 0 ignored;") < len(
        CHECKPOINT_TESTS
    ):
        raise EvidenceError("cargo test summaries do not prove both checkpoint tests")

    return {
        "schema_version": SCHEMA,
        "status": "PASS",
        "implementation_status": "RUNTIME_CONFIRMED",
        "qualification_status": "UNQUALIFIED",
        "qualification_blocker": "clean_source_identity_and_remaining_p15_matrix_not_bound",
        "timestamp_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "lane": {
            "backend": "fdm",
            "execution": "cpu_reference",
            "precision": "fp64",
            "mesh_mode": "single_grid",
        },
        "test_count": len(REQUIRED_TESTS),
        "tests": sorted(REQUIRED_TESTS),
        "test_case_ids": TEST_CASE_IDS,
        "contracts": {
            "frozen_reference_bitwise": "PASS",
            "free_dof_mobility": "PASS",
            "reference_influence": "PASS",
            "two_spin_exchange_independent_oracle": "PASS",
            "frozen_spin_energy_accounting": "PASS",
            "free_only_telemetry_and_stopping": "PASS",
            "no_mask_bitwise_parity": "PASS",
            "fixed_seed_thermal_reproducibility": "PASS",
            "minimizer_accepted_energy_monotonic": "PASS",
            "all_frozen_relaxation_noop": "PASS",
            "checkpoint_persisted_reference": "PASS",
            "checkpoint_continuity_bitwise": "PASS",
            "abm3_history_resume_bitwise": "PASS",
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
        log_bytes = arguments.log.read_bytes()
        evidence = build_evidence(log_bytes)
        try:
            artifact_path = arguments.log.resolve().relative_to(Path.cwd().resolve())
        except ValueError:
            artifact_path = arguments.log
        evidence["artifact"]["path"] = artifact_path.as_posix()
        write_json_atomic(arguments.output, evidence)
    except (OSError, EvidenceError) as error:
        print(f"FROZEN_SPINS_FDM_CPU_SCIENTIFIC_EVIDENCE_ERROR={error}")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
