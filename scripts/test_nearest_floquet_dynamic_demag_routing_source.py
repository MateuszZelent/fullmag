#!/usr/bin/env python3
"""Source-level contract checks for the nearest nonzero-k Floquet lane.

The checks intentionally avoid compiling or executing native MFEM/PETSc/SLEPc
code.  They verify that the public target reaches the existing native request,
that the planner and executor share one capability predicate, and that the
native result keeps selected-only semantics for nearest-frequency requests.
Managed runtime, residual and dispersion evidence remain separate gates.
"""

from __future__ import annotations

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def require(text: str, needle: str, label: str) -> None:
    if needle not in text:
        raise AssertionError(f"missing {label}: {needle}")


def test_capability_accepts_nearest_only_with_the_existing_floquet_guards() -> None:
    capability = read("crates/fullmag-runner/src/fem/eigen_capability.rs")
    require(
        capability,
        "fn native_cpu_modal_floquet_target_supported",
        "explicit Floquet target predicate",
    )
    require(
        capability,
        "EigenTargetIR::FrequencyWindow { .. } => true",
        "frequency-window target alternative",
    )
    require(
        capability,
        "frequency_hz.is_finite() && *frequency_hz > 0.0",
        "finite positive nearest target guard",
    )
    for guard in (
        "plan.enable_demag",
        "plan.operator.include_demag",
        "EigenOperatorIR::Full2x2",
        "EigenDampingPolicyIR::Ignore",
        "SpinWaveBoundaryKindIR::Floquet",
        "FemDomainMeshModeIR::SharedDomainMeshWithAir",
        "demag_realization",
        "native_shared_domain_mesh_metadata_valid(plan)",
        "periodic_domain_pair_stats",
        "pair_stats.magnetic_pair_count > 0",
        "pair_stats.airbox_pair_count > 0",
        "GAMMA_K_TOLERANCE_RAD_PER_M",
    ):
        require(capability, guard, f"Floquet capability guard {guard}")
    require(
        capability,
        'production_cpu_modal_unsupported_floquet_target',
        "unsupported Floquet target rejection reason",
    )


def test_planner_accepts_nearest_only_when_the_native_target_is_supported() -> None:
    planner = read("crates/fullmag-plan/src/fem.rs")
    helper_start = planner.index(
        "fn floquet_airbox_dynamic_demag_target_supported("
    )
    helper_end = planner.index(
        "/// Return whether the narrow, production-owned nonzero-k Floquet demag lane",
        helper_start,
    )
    helper = planner[helper_start:helper_end]
    for needle in (
        "EigenTargetIR::FrequencyWindow",
        "EigenTargetIR::Nearest { frequency_hz }",
        "frequency_hz.is_finite() && *frequency_hz > 0.0",
        "EigenTargetIR::Lowest => false",
    ):
        require(helper, needle, f"planner Floquet target guard {needle}")

    path_start = planner.index(
        "fn floquet_airbox_dynamic_demag_cpu_plan_supported("
    )
    path_end = planner.index(
        "/// Keep the planner boundary aligned with the local terms",
        path_start,
    )
    capability = planner[path_start:path_end]
    require(
        capability,
        "floquet_airbox_dynamic_demag_target_supported(target)",
        "planner/native Floquet target predicate binding",
    )
    if "matches!(target, fullmag_ir::EigenTargetIR::FrequencyWindow { .. })" in capability:
        raise AssertionError(
            "planner must not restrict the native Floquet route to frequency_window"
        )


def test_resolution_and_executor_share_the_bounded_native_route() -> None:
    resolution = read("crates/fullmag-runner/src/fem/eigen_execution_resolution.rs")
    execution = read("crates/fullmag-runner/src/fem/eigen_execution.rs")
    require(
        resolution,
        "let bounded_floquet = native_cpu_modal_window_has_floquet_dynamic_demag_path(plan);",
        "resolution capability binding",
    )
    require(
        resolution,
        "FemEigenEngineIR::FloquetAirboxCpuSchurSlepc",
        "exact Floquet CPU engine",
    )
    require(
        execution,
        "&& native_cpu_modal_window_has_floquet_dynamic_demag_path(plan);",
        "executor capability binding",
    )
    require(
        execution,
        "Nearest remains selected-only",
        "selected-only execution boundary",
    )


def test_public_target_is_transferred_without_per_sample_retargeting() -> None:
    world = read("packages/fullmag-py/src/fullmag/world.py")
    script_builder = read("packages/fullmag-py/src/fullmag/runtime/script_builder.py")
    native_window = read("crates/fullmag-runner/src/fem/eigen_native_window.rs")
    for source, needles, label in (
        (
            world,
            ("target_frequency", '"nearest"'),
            "public nearest target",
        ),
        (script_builder, ("target_frequency",), "Python target serialization"),
        (
            native_window,
            (
                "target_kind: native_modal_target_kind(&plan.target)",
                "target_frequency_hz: native_modal_target_frequency_hz(&plan.target)",
                "frequency_min_hz: native_modal_frequency_min_hz(&plan.target)",
                "frequency_max_hz: native_modal_frequency_max_hz(&plan.target)",
            ),
            "native request target transfer",
        ),
    ):
        for needle in needles:
            require(source, needle, f"{label}: {needle}")


def test_native_solver_keeps_residual_and_selected_only_policies() -> None:
    floquet = read("backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp")
    producer = read("backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp")
    for needle in (
        "EPSSetOperators(eps, shell, gyrotropic)",
        "EPSSetWhichEigenpairs(eps, EPS_TARGET_MAGNITUDE)",
        "EPSSetTrueResidual(eps, PETSC_TRUE)",
        "STSetType(spectral_transform, STSINVERT)",
        "candidate.target_distance",
        "relative_residual",
        "floquet_magnetic_residual",
    ):
        require(floquet, needle, f"native solver invariant {needle}")
    require(
        producer,
        "bool is_nearest_frequency_target(const ModalEigenRequest &request)",
        "native producer nearest target discriminator",
    )
    require(
        producer,
        '\\"target_kind\\":\\"nearest_frequency\\"',
        "native producer nearest target spelling",
    )
    require(
        producer,
        '\\"target_frequency_hz\\":',
        "native producer target frequency field",
    )
    require(
        producer,
        '\\"spectrum_completeness\\":\\"selected_only\\"',
        "native producer selected-only spectrum status",
    )
    require(
        producer,
        '\\"window_complete\\":false',
        "native producer explicit window completeness field",
    )
    require(
        producer,
        "FrequencyDomainStatus status",
        "native producer status input",
    )
    require(
        producer,
        '\\"solve_complete\\":',
        "native producer explicit solver completion field",
    )
    sparse_payload = producer.split(
        "FrequencyDomainContractResult solve_sparse_production_modal_payload(",
        1,
    )[1].split(
        "FrequencyDomainContractResult solve_sparse_production_modal_window_payload(",
        1,
    )[0]
    require(
        sparse_payload,
        "append_nearest_frequency_metadata(result.result_json, request, result.status)",
        "actual sparse Floquet producer result metadata handoff",
    )
    require(
        sparse_payload,
        "with_modal_request_diagnostics(result.diagnostics_json, request, result.status)",
        "actual sparse Floquet producer diagnostics handoff",
    )


def test_nearest_completion_fields_have_separate_solver_and_coverage_meanings() -> None:
    producer = read("backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp")
    docs = read("docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md")
    require(
        producer,
        "status == FrequencyDomainStatus::ok",
        "enum status drives nearest solve completion",
    )
    if "json_status_is_ok" in producer:
        raise AssertionError("native producer must not infer solve status from JSON text")
    for needle in (
        "legacy native `complete` flag",
        "`solve_complete`",
        "`spectrum_completeness` and",
        "`window_complete` remain the explicit coverage fields",
        "not a spectrum/window certificate",
    ):
        require(docs, needle, f"nearest completion interpretation: {needle}")


def test_nonzero_k_nearest_uses_floquet_sparse_owner_not_k0_poisson_writer() -> None:
    contract = read("backends/fem/src/frequency_domain/modal_eigen_solver.cpp")
    producer = read("backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp")
    floquet = read("backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp")
    docs = read("docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md")
    for needle in (
        "effective_request.floquet_shared_domain_operator =",
        "native_nonzero_k_shared_domain_provider = true",
        "production_cpu_modal_eigen_unavailable(effective_request",
    ):
        require(contract, needle, f"nonzero-k shared-domain route: {needle}")
    for needle in (
        "request.floquet_shared_domain_operator != nullptr",
        "solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context(",
    ):
        require(floquet, needle, f"Floquet sparse owner: {needle}")
    wrapper = re.search(
        r"solve_floquet_shared_domain_sparse_modal_spectrum\(\s*"
        r"const FloquetSharedDomainSparseModalOperator &operator_view,\s*"
        r"const SLEPcSparseGyrotropicModalEigenRequest &spectral_request\) noexcept\s*"
        r"\{(.*?)\n\}", floquet, re.S,
    )
    expected = ("return solve_floquet_shared_domain_sparse_modal_spectrum_reusing_context("
                "operator_view, spectral_request, nullptr);")
    if wrapper is None or re.sub(r"\s+", "", wrapper.group(1)) != re.sub(r"\s+", "", expected):
        raise AssertionError("two-argument Floquet wrapper must only delegate with nullptr")
    require(
        producer,
        "with_modal_request_diagnostics(result.diagnostics_json, request, result.status)",
        "status-bound nearest diagnostics on the sparse Floquet owner",
    )
    require(
        docs,
        "The descriptor Poisson Schur writer in",
        "explicit k=0 Schur branch boundary",
    )


def test_de_smoke_pilot_routes_nearest_as_one_point_selected_only() -> None:
    example = read("examples/fem_de_smoke_numeric.py")
    pilot = read("scripts/run_de_100nm_pilot.py")
    rows = read("scripts/validate_de_smoke_rows.py")
    for needle in (
        "MODAL_TARGET = os.environ.get(\"FULLMAG_DE_SMOKE_MODAL_TARGET\", \"frequency_window\")",
        "TARGET_FREQUENCY_HZ = _target_frequency_ghz * 1.0e9",
        '"window_complete": False if MODAL_TARGET == "nearest" else None',
        "target_frequency=TARGET_FREQUENCY_HZ if MODAL_TARGET == \"nearest\" else None",
    ):
        require(example, needle, f"DE-SMOKE nearest authoring transfer: {needle}")
    for needle in (
        "NEAREST_PILOT = \"de-smoke-nearest-k2\"",
        "def validate_selected_only_metadata",
        "FULLMAG_DE_SMOKE_MODAL_TARGET=\" + modal_target",
        "selection_scope=\"selected_only\"",
    ):
        require(pilot, needle, f"managed selected-only pilot handoff: {needle}")
    for needle in (
        "selection_scope: str = \"frequency_window\"",
        "selection_scope == \"selected_only\" and len(expected) != 1",
        "if selection_scope == \"frequency_window\":",
    ):
        require(rows, needle, f"selected-only row validation: {needle}")


def test_native_rust_contract_prepares_nearest_single_and_path_cases() -> None:
    tests = read("crates/fullmag-runner/src/fem/eigen_tests.rs")
    for needle in (
        "planned_floquet_dynamic_demag_nearest_target_dispatches_same_cpu_engine",
        "native_cpu_modal_window_accepts_nonzero_floquet_airbox_demag_nearest_target",
        "native_cpu_modal_window_rejects_floquet_airbox_demag_without_both_domain_pair_classes",
        "EigenTargetIR::Nearest",
        "single global target",
    ):
        require(tests, needle, f"prepared nearest regression {needle}")


def main() -> None:
    checks = (
        test_capability_accepts_nearest_only_with_the_existing_floquet_guards,
        test_planner_accepts_nearest_only_when_the_native_target_is_supported,
        test_resolution_and_executor_share_the_bounded_native_route,
        test_public_target_is_transferred_without_per_sample_retargeting,
        test_native_solver_keeps_residual_and_selected_only_policies,
        test_nearest_completion_fields_have_separate_solver_and_coverage_meanings,
        test_nonzero_k_nearest_uses_floquet_sparse_owner_not_k0_poisson_writer,
        test_de_smoke_pilot_routes_nearest_as_one_point_selected_only,
        test_native_rust_contract_prepares_nearest_single_and_path_cases,
    )
    for check in checks:
        check()
    print("PASS: nearest nonzero-k Floquet dynamic-demag routing source contract")


if __name__ == "__main__":
    main()
