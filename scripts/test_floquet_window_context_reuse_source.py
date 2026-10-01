#!/usr/bin/env python3
"""Interpreted checks for the one-window Floquet PETSc reuse contract.

This file deliberately does not compile PETSc/SLEPc or execute a native
solver.  It checks source wiring and exercises the normalization recurrence
with a small algebraic model so a second shift cannot silently apply an
absolute scale twice.  Native residuals and performance remain unverified.
"""

from __future__ import annotations

import math
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FLOQUET_CPP = (
    ROOT / "backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp"
)
FLOQUET_HPP = (
    ROOT / "backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.hpp"
)
PRODUCTION_CPP = (
    ROOT / "backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp"
)


def require(text: str, needle: str, label: str) -> None:
    if needle not in text:
        raise AssertionError(f"missing {label}: {needle}")


def scaled_residual(
    scale: float,
    operator: tuple[tuple[float, ...], ...],
    mass: tuple[tuple[float, ...], ...],
    vector: tuple[float, ...],
    eigenvalue: float,
) -> float:
    def apply(matrix: tuple[tuple[float, ...], ...]) -> tuple[float, ...]:
        return tuple(sum(row[j] * vector[j] for j in range(len(vector))) for row in matrix)

    lhs = apply(operator)
    rhs = apply(mass)
    numerator = math.sqrt(
        sum((scale * (lhs[i] - eigenvalue * rhs[i])) ** 2 for i in range(len(vector)))
    )
    denominator = max(
        math.sqrt(sum((scale * lhs[i]) ** 2 for i in range(len(vector)))),
        math.sqrt(sum((scale * eigenvalue * rhs[i]) ** 2 for i in range(len(vector)))),
        1.0e-30,
    )
    return numerator / denominator


def check_three_shift_normalization() -> None:
    # The reference is the same max(magnetic, gyrotropic, |target|*gyrotropic)
    # used by normalize_native_floquet_pencil.  The raw references intentionally
    # change across shifts, as the target term changes.
    shifts = ((4.0, 1.5, 0.5), (2.0, 3.0, 1.0), (8.0, 0.75, 4.0))
    reused_absolute = 1.0
    operator = ((3.0, -1.0), (0.5, 2.0))
    mass = ((1.0, 0.0), (0.0, 2.0))
    vector = (0.25, -0.75)
    eigenvalue = 1.25
    fresh_residual = scaled_residual(1.0, operator, mass, vector, eigenvalue)
    for magnetic_norm, gyrotropic_norm, target in shifts:
        raw_reference = max(magnetic_norm, gyrotropic_norm, target * gyrotropic_norm)
        observed_reference = raw_reference * reused_absolute
        ratio = 1.0 / observed_reference
        reused_absolute *= ratio
        fresh_absolute = 1.0 / raw_reference
        if not math.isclose(reused_absolute, fresh_absolute, rel_tol=1.0e-12):
            raise AssertionError("reuse normalization diverged from fresh scaling")
        reused_residual = scaled_residual(
            reused_absolute, operator, mass, vector, eigenvalue
        )
        fresh_residual_for_shift = scaled_residual(
            fresh_absolute, operator, mass, vector, eigenvalue
        )
        if not math.isclose(
            reused_residual, fresh_residual_for_shift, rel_tol=1.0e-12
        ):
            raise AssertionError("reuse changed the normalized residual")
        if not math.isclose(reused_residual, fresh_residual, rel_tol=1.0e-12):
            raise AssertionError("scalar normalization changed the physical residual")


def check_hard_failure_stops_window_model() -> None:
    # A hard native failure must stop the aggregate immediately.  This small
    # model mirrors the production loop's contract without pretending to run
    # PETSc/SLEPc: later subwindows are never allowed to turn a partial list
    # into a complete window.
    attempts = (
        {"status": "ok", "ok": True},
        {"status": "solve_error", "ok": False},
        {"status": "ok", "ok": True},
    )
    processed = []
    for attempt in attempts:
        processed.append(attempt)
        if not attempt["ok"] and attempt["status"] == "solve_error":
            break
    if len(processed) != 2:
        raise AssertionError("hard subwindow failure did not stop the window")
    if processed[-1]["status"] != "solve_error":
        raise AssertionError("model did not retain the hard failure")


def check_unsafe_eps_lifetime_model() -> None:
    # Model the ownership decision made after a hard EPSSolve error.  The
    # borrowed EPS graph is retained, while the reusable context is made
    # permanently unusable; no later call may destroy or mutate its matrices.
    state = {"invalidated": False, "eps_lifetime_unsafe": False}
    eps_destroyed = False
    matrices_destroyed = False
    eps_solve_error = True
    if eps_solve_error:
        state["invalidated"] = True
        state["eps_lifetime_unsafe"] = True
    if not state["eps_lifetime_unsafe"]:
        eps_destroyed = True
        matrices_destroyed = True
    if not state["invalidated"] or not state["eps_lifetime_unsafe"]:
        raise AssertionError("hard EPS error did not quarantine the context")
    if eps_destroyed or matrices_destroyed:
        raise AssertionError("unsafe EPS graph was destroyed in the model")


def main() -> None:
    floquet = FLOQUET_CPP.read_text(encoding="utf-8")
    header = FLOQUET_HPP.read_text(encoding="utf-8")
    production = PRODUCTION_CPP.read_text(encoding="utf-8")

    for needle, label in (
        ("struct FloquetSharedDomainSparseModalSolveContext", "opaque context"),
        ("operator_identity", "operator identity guard"),
        ("phase_sign != requested_phase_sign", "phase guard"),
        ("residual_tolerance != spectral_request.residual_tolerance", "tolerance guard"),
        ("max_linear_iterations != spectral_request.max_linear_iterations", "iteration budget guard"),
    ):
        require(
            floquet if needle != "struct FloquetSharedDomainSparseModalSolveContext" else header,
            needle,
            label,
        )
    require(header, "FloquetSharedDomainSparseModalSolveContext() noexcept;", "context constructor")
    require(
        header,
        "const FloquetSharedDomainSparseModalSolveContext &) = delete",
        "non-copyable context",
    )
    require(header, "FloquetSharedDomainSparseModalSolveContext &&) = delete", "non-movable context")

    for needle, label in (
        ("ReusableFloquetWindowState", "per-window state"),
        ("std::nothrow", "allocation failure handling"),
        ("scale_ratio = 1.0 / scale_reference", "relative normalization update"),
        ("MatScale(context->a_qq, static_cast<PetscScalar>(scale_ratio))", "relative matrix rescale"),
        ("previous_normalization_scale", "previous scale input"),
        ("destroy_reusable_floquet_window_state(state)", "cache invalidation and cleanup"),
        ("state->demag_probe_completed = true", "one-time demag probe cache"),
        ("state->k_rad_per_m != operator_view.k_rad_per_m", "k-parameter guard"),
        ("context.error_message[0] = '\\0'", "per-attempt error reset"),
        ("MatCreateShell(", "persistent MatShell creation"),
        ("EPSSetOperators(eps, shell, gyrotropic)", "unchanged EPS pencil"),
        ("bool invalidated = false;", "invalidated-state marker"),
        ("bool eps_lifetime_unsafe = false;", "unsafe EPS lifetime marker"),
        ("if (state->invalidated)", "invalidated-state admission guard"),
        ("state->eps_lifetime_unsafe = true;", "hard-error lifetime quarantine"),
        ("Do not query or mutate EPS", "post-error mutation barrier"),
        ("if (state->eps_lifetime_unsafe)", "unsafe-state destruction guard"),
        ("struct ReusableFloquetWindowStateDeleter", "heap-state deleter"),
        ("using ReusableFloquetWindowStateOwner", "heap-state owner"),
        ("new (std::nothrow) ReusableFloquetWindowState{}", "nonreuse heap allocation"),
    ):
        require(floquet, needle, label)

    if "static ReusableFloquetWindowState" in floquet:
        raise AssertionError("reuse state must not become a process-global cache")
    if "ReusableFloquetWindowState local_state" in floquet:
        raise AssertionError("nonreuse state must not be stack-owned")
    require(
        production,
        "FloquetSharedDomainSparseModalSolveContext floquet_window_context{}",
        "one context per production window",
    )
    require(production, "reuse_context);", "context handoff to each subwindow")
    require(production, "window_complete", "unchanged window qualification gate")
    require(
        production,
        "solve_sparse_modal_spectrum_for_request(request, slepc_request, nullptr);",
        "nearest/single-shift path without borrowed window context",
    )
    require(
        production,
        "admit_floquet_modal_sparse_request(request, spectral_request)",
        "common sparse Floquet admission before reuse",
    )
    require(
        production,
        'rejected.status = "validation_error";',
        "local validation result for rejected reuse admission",
    )
    require(
        production,
        "rejected.unsupported_reason = admission.reason;",
        "admission reason propagation",
    )
    if "validation_failure(admission.reason)" in production:
        raise AssertionError("reuse adapter calls a private validation helper")
    require(
        production,
        "subwindow_requires_fail_closed",
        "hard subwindow failure predicate",
    )
    require(
        production,
        "subwindow_hard_failure",
        "aggregate fail-closed state",
    )
    require(
        production,
        "const bool hard_failure = std::any_of(",
        "nested window hard-error completeness",
    )
    require(
        production,
        '"window_completeness\\":\\"solver_error\\"',
        "incomplete hard-error certificate",
    )

    check_three_shift_normalization()
    check_hard_failure_stops_window_model()
    check_unsafe_eps_lifetime_model()
    print("PASS: interpreted Floquet reuse/admission/fail-closed contract and normalization")


if __name__ == "__main__":
    main()
