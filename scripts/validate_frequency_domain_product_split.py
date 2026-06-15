#!/usr/bin/env python3

from __future__ import annotations

from pathlib import Path
import sys


REPO_ROOT = Path(__file__).resolve().parent.parent

DOCS_REQUIRING_TOKENS = [
    Path("docs/physics/0700-frequency-domain-linearized-llg.md"),
    Path("docs/physics/frequency_domain_solver_physics.md"),
    Path("docs/physics/0600-fem-eigenmodes-linearized-llg.md"),
    Path("docs/specs/frequency-domain-artifacts-v2.md"),
    Path("docs/plans/active/frequency-domain-fem-masterplan-2026-06-11/01-backend-native-fem-frequency-domain.md"),
]


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def read_text(path: Path) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def require_contains(text: str, needle: str, label: str) -> None:
    if needle not in text:
        fail(f"{label} is missing required text: {needle}")


def require_separate_capability_rows(text: str) -> None:
    require_contains(text, "| FEM modal interior-window eigensolve |", "capability matrix")
    require_contains(text, "| FEM driven frequency response |", "capability matrix")


def require_modal_frequency_domain_wording(text: str, label: str) -> None:
    bad_phrase = "Eigenmodes is the frequency-domain solver"
    if bad_phrase in text:
        fail(f"{label} describes Eigenmodes as the frequency-domain solver without modal scope")
    if "frequency-domain solver" in text and "modal" not in text.lower():
        fail(f"{label} uses 'frequency-domain solver' without modal qualification")


def main() -> None:
    for relative_path in DOCS_REQUIRING_TOKENS:
        text = read_text(relative_path)
        require_contains(text, "modal_eigen", str(relative_path))
        require_contains(text, "driven_response", str(relative_path))

    capability_matrix = read_text(Path("docs/specs/capability-matrix-v0.md"))
    require_separate_capability_rows(capability_matrix)
    require_contains(capability_matrix, "modal_eigen", "capability matrix")
    require_contains(capability_matrix, "driven_response", "capability matrix")

    llg_contract = read_text(Path("docs/physics/0700-frequency-domain-linearized-llg.md"))
    require_contains(llg_contract, "A q = lambda B q", "0700 linearized LLG contract")
    require_contains(llg_contract, "(i omega B - A) q = b", "0700 linearized LLG contract")
    require_contains(llg_contract, "gamma0 = mu0 * |gamma|", "0700 linearized LLG contract")
    require_contains(llg_contract, "tangent variables", "0700 linearized LLG contract")
    require_modal_frequency_domain_wording(llg_contract, "0700 linearized LLG contract")

    artifacts = read_text(Path("docs/specs/frequency-domain-artifacts-v2.md"))
    require_contains(artifacts, '"study_product": "modal_eigen"', "artifact spec")
    require_contains(artifacts, '"study_product": "driven_response"', "artifact spec")
    require_contains(artifacts, "eigen/diagnostics/solver.v1.json", "artifact spec")
    require_contains(artifacts, "response/diagnostics/solver.v1.json", "artifact spec")

    solver_physics = read_text(Path("docs/physics/frequency_domain_solver_physics.md"))
    require_modal_frequency_domain_wording(solver_physics, "frequency-domain solver physics")

    print("frequency-domain product split docs are consistent")


if __name__ == "__main__":
    main()
