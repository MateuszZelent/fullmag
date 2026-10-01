#!/usr/bin/env python3
"""Source-level contract checks for CPU Schur execution observability.

These checks deliberately do not compile PETSc/SLEPc code.  They protect the
wiring and the unchanged solver policies while the native build lane is
paused.  Runtime values remain unverified until a managed native run produces
the diagnostics JSON.
"""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCHUR = ROOT / "backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp"
RESULT = ROOT / "backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp"
ADAPTER = ROOT / "backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp"
NATIVE_TEST = (
    ROOT
    / "backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp"
)


def require(text: str, needle: str, label: str) -> None:
    if needle not in text:
        raise AssertionError(f"missing {label}: {needle}")


def main() -> None:
    schur = SCHUR.read_text(encoding="utf-8")
    result = RESULT.read_text(encoding="utf-8")
    adapter = ADAPTER.read_text(encoding="utf-8")
    native_test = NATIVE_TEST.read_text(encoding="utf-8")

    for field in (
        "split_dof_count_available",
        "split_dof_count",
        "exact_preconditioner_enabled",
        "exact_preconditioner_status",
        "exact_preconditioner_shift_failure_observed",
        "exact_preconditioner_dimension_available",
        "exact_preconditioner_column_count_available",
        "exact_preconditioner_construction_metrics_available",
        "exact_preconditioner_construction_timing_available",
        "shifted_preconditioner_setup_timing_available",
        "eps_solve_timing_available",
    ):
        require(result, field, f"result field {field}")

    for symbol in (
        "struct ProductionCpuOperatorContext",
        "copy_exact_cache_observability",
        "create_production_exact_shift_preconditioner",
        "create_production_cached_window_preconditioner",
        "exact_cache_shift_failure_observed",
        "solve_poisson_airbox_modal_eigen_cpu_schur",
        "write_production_schur_diagnostics",
        "format_nullable_u64_json",
        "format_nullable_double_json",
        "diagnostics_written",
        "kDiagnosticsTruncatedJson",
    ):
        require(schur, symbol, f"implementation symbol {symbol}")

    for key in (
        "q_dof_count",
        "split_dof_count",
        "phi_dof_count",
        "augmented_dof_count",
        "exact_preconditioner",
        "construction_poisson_solve_count",
        "construction_seconds",
        "shifted_setup_seconds",
        "eps_solve_seconds",
        "shift_failure_observed",
    ):
        require(schur, key, f"diagnostic key {key}")

    # The outer SLEPc operator stays the production MatShell; the materialized
    # matrix is supplied only to STSINVERT as its shifted preconditioner.
    require(
        schur,
        "EPSSetOperators(eps, schur_shell, split_mass)",
        "MatShell EPS pencil binding",
    )
    require(
        schur,
        "STSetPreconditionerMat(st, shifted_preconditioner)",
        "shifted preconditioner binding",
    )
    require(
        schur,
        "constexpr PetscInt kProductionWindowExactPreconditionerMaxDimension = 512;",
        "unchanged frequency-window exact-cache cap",
    )
    require(
        schur,
        "constexpr PetscInt kProductionExactPreconditionerMaxDimension = 8192;",
        "unchanged single-shift exact cap",
    )
    require(
        schur,
        "std::uint64_t *completed_column_count",
        "partial exact-cache column counter",
    )
    require(
        schur,
        "*completed_column_count = static_cast<std::uint64_t>(column + 1)",
        "completed-column update",
    )
    require(
        schur,
        'std::snprintf(destination, destination_size, "%s", "null")',
        "nullable dimension serialization",
    )
    require(
        schur,
        "!available || !std::isfinite(value)",
        "nullable timing serialization",
    )
    require(schur, "subwindow_json_complete", "bounded subwindow trace state")
    require(
        schur,
        "diagnostics_truncated",
        "fail-closed trace overflow marker",
    )
    require(
        schur,
        "cache_reused_after_shift_failure",
        "preserved cache-shift failure status",
    )
    require(
        schur,
        "window_shift_setup_seconds",
        "separate per-shift cache setup timing",
    )
    require(
        schur,
        "diagnostics_json_truncated",
        "fail-closed top-level diagnostics marker",
    )
    if (
        "64MiB" in schur
        or "2048basis" in schur
        or "kProductionWindowExactPreconditionerMaxDimension = 2048" in schur
    ):
        raise AssertionError(
            "observability patch must not introduce an unapproved 64MiB/2048 policy"
        )

    # The generic adapter must continue to carry native operator diagnostics;
    # it does not reinterpret execution telemetry as an input digest.
    require(
        adapter,
        "std::string with_operator_diagnostics(",
        "generic diagnostics adapter",
    )
    require(
        adapter,
        "request.operator_request.operator_diagnostics_json",
        "diagnostics passthrough",
    )

    for key in (
        "split_dof_count",
        "exact_preconditioner",
        "construction_poisson_solve_count",
        "eps_solve_seconds",
        "shift_failure_observed",
    ):
        require(native_test, key, f"prepared native regression {key}")
    require(
        native_test,
        "result.split_dof_count == 2u * result.q_dof_count",
        "real-split dimension regression",
    )

    print("PASS: CPU Schur observability source contract")


if __name__ == "__main__":
    main()
