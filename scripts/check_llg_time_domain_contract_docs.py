#!/usr/bin/env python3
"""Check stable cross-document identifiers for the canonical LLG time contract."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
POLICY = "LLG-TD-POLICY-V1"
ATTEMPT = "LLG-TD-ATTEMPT-V1"
STIFF = "LLG-TD-STIFF-V1"
FIRST_DT = "LLG-TD-FIRST-DT-V1"
MAX_ERR = "LLG-TD-MAX-ERR-V1"
ATOMIC = "LLG-TD-ATOMIC-V1"

REQUIRED = {
    "docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md": (
        POLICY,
        ATTEMPT,
        STIFF,
        FIRST_DT,
        MAX_ERR,
        ATOMIC,
        "fix_dt",
        "dt_min_exhausted",
        "solver_attempts.csv",
    ),
    "docs/physics/0480-fdm-higher-order-and-adaptive-time-integrators.md": (
        POLICY,
        ATTEMPT,
        FIRST_DT,
        MAX_ERR,
        ATOMIC,
    ),
    "docs/physics/0490-fem-higher-order-and-adaptive-time-integrators-mfem-gpu.md": (
        POLICY,
        ATTEMPT,
        STIFF,
        FIRST_DT,
        MAX_ERR,
        ATOMIC,
    ),
    "docs/physics/llg_conventions.md": (
        POLICY,
        ATTEMPT,
        STIFF,
        FIRST_DT,
        MAX_ERR,
        ATOMIC,
    ),
    "docs/physics/0910-table-autosave-observables.md": (ATTEMPT,),
    "docs/architecture/backend-golden-masterplan.md": (
        POLICY,
        ATTEMPT,
        STIFF,
        ATOMIC,
    ),
    "docs/specs/capability-matrix-v0.md": (
        POLICY,
        ATTEMPT,
        STIFF,
        FIRST_DT,
        MAX_ERR,
        ATOMIC,
        "LLG explicit fixed",
        "LLG explicit adaptive",
        "LLG stiff time-domain",
    ),
}


def main() -> int:
    failures: list[str] = []
    for relative, markers in REQUIRED.items():
        path = ROOT / relative
        if not path.is_file():
            failures.append(f"missing document: {relative}")
            continue
        text = path.read_text(encoding="utf-8")
        for marker in markers:
            if marker not in text:
                failures.append(f"{relative}: missing {marker}")
    if failures:
        print("LLG time-domain documentation contract violations:")
        for failure in failures:
            print(f"- {failure}")
        return 1
    print("LLG time-domain documentation contract is canonical.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
