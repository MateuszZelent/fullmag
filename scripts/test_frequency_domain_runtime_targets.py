#!/usr/bin/env python3
"""Static checks for frequency-domain managed runtime just targets."""

from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
JUSTFILE = REPO_ROOT / "justfile"
COMPOSE_FILE = REPO_ROOT / "compose.yaml"
FMR_SMOKE = REPO_ROOT / "examples" / "fem_frequency_response_smoke.py"
EIGEN_DISPERSION_SMOKE = (
    REPO_ROOT / "examples" / "fem_eigenmodes_dispersion_k_path.py"
)
EIGEN_DISPERSION_WINDOW_SMOKE = (
    REPO_ROOT / "examples" / "fem_eigenmodes_dispersion_window_k_path.py"
)
EIGEN_DISPERSION_DE_BV_LOW_K = (
    REPO_ROOT / "examples" / "fem_eigenmodes_dispersion_de_bv_low_k.py"
)
EIGEN_FREQUENCY_WINDOW_SMOKE = (
    REPO_ROOT / "examples" / "fem_eigenmodes_frequency_window.py"
)
EIGEN_PRODUCTION_GAMMA_K_PATH_SMOKE = (
    REPO_ROOT / "examples" / "fem_eigenmodes_production_gamma_k_path.py"
)
EIGEN_K0_KITTEL_ZEEMAN_NO_DEMAG = (
    REPO_ROOT / "examples" / "fem_eigen_k0_kittel_zeeman_no_demag.py"
)
EIGEN_K0_KITTEL_PERIODIC_AIRBOX_GPU = (
    REPO_ROOT
    / "examples"
    / "fem_eigen_k0_kittel_periodic_airbox_gpu.py"
)
EIGEN_K0_KITTEL_PERIODIC_AIRBOX = (
    REPO_ROOT
    / "examples"
    / "fem_eigen_k0_kittel_periodic_airbox.py"
)
EIGEN_K0_PRODUCTION_PERIODIC_AIRBOX = (
    REPO_ROOT
    / "examples"
    / "fem_eigen_k0_poisson_airbox_production.py"
)
CONTROL_ROOM_SMOKE = (
    REPO_ROOT / "apps" / "control-room" / "scripts" / "smoke-study-authoring-ui.mjs"
)
PERIODIC_K0_SMOKE = REPO_ROOT / "examples" / "fem_fmr_periodic_k0_smoke.py"
PERIODIC_ANTIDOT_FREQUENCY_DRIVEN = (
    REPO_ROOT
    / "examples"
    / "fem_periodic_antidot_relax_exchange_coupled_frequency_driven.py"
)
SHARED_DOMAIN_STATIC_PERIODIC_RESPONSE = (
    REPO_ROOT
    / "examples"
    / "fem_frequency_response_shared_domain_static_periodic_smoke.py"
)
GPU_FREE_DEMAG_RESPONSE = (
    REPO_ROOT / "examples" / "fem_frequency_response_gpu_free_demag_smoke.py"
)
CPU_FREE_DEMAG_RESPONSE = (
    REPO_ROOT / "examples" / "fem_frequency_response_cpu_free_demag_smoke.py"
)
CPU_PERIODIC_AIRBOX_DEMAG_RESPONSE = (
    REPO_ROOT
    / "examples"
    / "fem_frequency_response_cpu_periodic_airbox_demag_smoke.py"
)
DRIVEN_RESPONSE_SOLVER = (
    REPO_ROOT / "backends" / "fem" / "src" / "frequency_domain" / "driven_response_solver.cpp"
)
RUNNER_FREQUENCY_RESPONSE = (
    REPO_ROOT / "crates" / "fullmag-runner" / "src" / "frequency_response.rs"
)
PRODUCTION_CPU_DRIVEN_RESPONSE = (
    REPO_ROOT
    / "backends"
    / "fem"
    / "cpu"
    / "frequency_domain"
    / "production_cpu_driven_response.hpp"
)
FROZEN_SUBMESH_HELPER = REPO_ROOT / "scripts" / "prepare_fmr_frozen_magnetic_submesh.py"
PBC_AIRBOX_PLAN = (
    REPO_ROOT
    / "docs"
    / "plans"
    / "active"
    / "fullmag_pbc_fem_bloch_airbox_plan.md"
)


def test_production_cpu_frequency_response_defaults_are_not_low_iteration_debug_limits() -> None:
    source = DRIVEN_RESPONSE_SOLVER.read_text(encoding="utf-8")
    header = PRODUCTION_CPU_DRIVEN_RESPONSE.read_text(encoding="utf-8")

    assert '"FULLMAG_FMR_RESPONSE_RTOL",\n        1.0e-3' in source
    assert '"FULLMAG_FMR_RESPONSE_MAX_ITERATIONS",\n        8192' in source
    assert (
        '"FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS",\n            max_iterations'
        in source
    )
    assert "double relative_tolerance = 1.0e-3;" in header
    assert "std::uint64_t max_iterations = 8192;" in header
    assert "std::uint64_t restart_iterations = 8192;" in header


def test_frequency_response_preflight_serializes_periodic_certificate_hashes() -> None:
    source = RUNNER_FREQUENCY_RESPONSE.read_text(encoding="utf-8")

    assert '"schema_version": "periodic_mesh_certificate.v5"' in source
    assert (
        '"artifact_role": "frequency_response_input_preflight_candidate"'
        in source
    )
    assert '"magnetic_pair_map_sha256":' in source
    assert '"airbox_pair_map_sha256":' in source
    assert '"tangent_frame_transfer_required":' in source


def test_periodic_airbox_fmr_runtime_target_uses_real_antidot_example() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find("verify-fem-frequency-domain-periodic-airbox-runtime:")
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "examples/fem_frequency_response_smoke.py" in target
    assert "--require-periodic-airbox-cpu-demag-solved" in target
    assert "--require-frozen-magnetic-submesh" in target
    assert ".fullmag/reports/frequency-domain-periodic-airbox-runtime/artifacts" in target
    assert "scripts/prepare_fmr_frozen_magnetic_submesh.py" in target
    assert "periodic_antidot_frozen_magnetic_submesh.npz" in target
    assert "FULLMAG_FMR_FROZEN_MAGNETIC_SUBMESH_SOURCE=" in target
    assert "FULLMAG_FMR_FAST_RUNTIME_MESH=1" in target
    assert "FULLMAG_FMR_MESH_ALGORITHM_3D=" in target
    assert "FULLMAG_FMR_FREQUENCIES_GHZ=" in target
    assert "FULLMAG_FMR_RELAX_MAX_STEPS=" in target
    assert 'FULLMAG_FMR_DEMAG_MAX_ITERATIONS="${FULLMAG_FMR_DEMAG_MAX_ITERATIONS:-500}"' in target
    assert 'FULLMAG_FMR_RESPONSE_RTOL="${FULLMAG_FMR_RESPONSE_RTOL:-1e-3}"' in target
    assert (
        'FULLMAG_FMR_RESPONSE_MAX_ITERATIONS="${FULLMAG_FMR_RESPONSE_MAX_ITERATIONS:-8192}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS="${FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS:-8192}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL="${FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL:-128}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT:-auto}"'
        in target
    )


def test_full_antidot_frequency_driven_target_uses_gpu_solver_controls() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find(
        "run-fem-periodic-antidot-frequency-driven-managed-headless"
    )
    assert target_start != -1
    next_target = justfile.find("\nrun-permalloy", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "examples/fem_periodic_antidot_relax_exchange_coupled_frequency_driven.py" in target
    assert "FULLMAG_FEM_EXECUTION=gpu" in target
    assert "FULLMAG_RELAX_DEVICE=gpu" in target
    assert "FULLMAG_FMR_DEVICE=gpu" in target
    assert 'FULLMAG_FEM_GPU_DEMAG_MODE="${FULLMAG_FEM_GPU_DEMAG_MODE:-device_hypre_poisson}"' in target
    assert (
        'FULLMAG_FEM_FREQUENCY_RESPONSE_GPU_DEMAG_MODE="${FULLMAG_FEM_FREQUENCY_RESPONSE_GPU_DEMAG_MODE:-hybrid_cpu_poisson}"'
        in target
    )
    assert (
        'FULLMAG_FEM_FREQUENCY_RESPONSE_DELTA_PHI_FLUX_MAX_TOLERANCE_T="${FULLMAG_FEM_FREQUENCY_RESPONSE_DELTA_PHI_FLUX_MAX_TOLERANCE_T:-2e-2}"'
        in target
    )
    assert 'FULLMAG_FMR_DEMAG_RTOL="${FULLMAG_FMR_DEMAG_RTOL:-1e-4}"' in target
    assert (
        'FULLMAG_FMR_DEMAG_MAX_ITERATIONS="${FULLMAG_FMR_DEMAG_MAX_ITERATIONS:-1000}"'
        in target
    )
    assert 'FULLMAG_FMR_RESPONSE_RTOL="${FULLMAG_FMR_RESPONSE_RTOL:-1e-3}"' in target
    assert (
        'FULLMAG_FMR_RESPONSE_MAX_ITERATIONS="${FULLMAG_FMR_RESPONSE_MAX_ITERATIONS:-8192}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS="${FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS:-8192}"'
        in target
    )
    assert (
        'FULLMAG_FEM_FREQUENCY_RESPONSE_PRECONDITIONER_VARIANT="${FULLMAG_FEM_FREQUENCY_RESPONSE_PRECONDITIONER_VARIANT:-auto}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT:-auto}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_PRECONDITIONER_AUTO_DISABLE_THRESHOLD="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_AUTO_DISABLE_THRESHOLD:-1.0}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_PRECONDITIONER_AUTO_PILOT_ITERATIONS="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_AUTO_PILOT_ITERATIONS:-16}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_GRAPH_PRECONDITIONER_SWEEPS="${FULLMAG_FMR_RESPONSE_GRAPH_PRECONDITIONER_SWEEPS:-4}"'
        in target
    )
    assert "--require-production-gpu" in target
    assert "--require-periodic-airbox-gpu-demag-solved" in target


def test_frequency_response_gpu_demag_mode_is_response_scoped() -> None:
    source = (
        REPO_ROOT / "crates" / "fullmag-runner" / "src" / "frequency_response.rs"
    ).read_text(encoding="utf-8")

    assert "FULLMAG_FEM_FREQUENCY_RESPONSE_GPU_DEMAG_MODE" in source
    assert "FrequencyResponseGpuDemagModeEnvGuard" in source
    assert "let _gpu_demag_mode_env_guard =" in source
    assert source.find("let _gpu_demag_mode_env_guard =") < source.find(
        "NativeBackendDemagTangentProvider::create"
    )


def test_periodic_airbox_promotion_artifact_target_requires_m5_equilibrium_gate() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find(
        "verify-fem-frequency-domain-periodic-airbox-promotion-artifacts:"
    )
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "FULLMAG_FMR_PROMOTION_ARTIFACTS" in target
    assert "--require-periodic-airbox-cpu-demag-solved" in target
    assert "--require-frozen-magnetic-submesh" in target
    assert "--require-m5-equilibrium-provenance" in target
    assert "--require-min-frequency-points" in target
    assert "--require-response-peak" in target
    assert "--require-field-payloads-for-frequency-points" in target
    assert "--require-derived-peak-mode" in target
    assert "verify-fem-frequency-domain-periodic-airbox-runtime" not in target


def test_eigen_dispersion_runtime_target_uses_k_path_example_and_validator() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find("verify-fem-frequency-domain-eigen-dispersion-runtime:")
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "FULLMAG_FEM_EXECUTION=cpu" in target
    assert "just ensure-managed-fem-runtime" in target
    assert "examples/fem_eigenmodes_dispersion_k_path.py" in target
    assert ".fullmag/reports/frequency-domain-eigen-dispersion-runtime/artifacts" in target
    assert "eigen/spectrum.v2.json" in target
    assert "eigen/branches.v2.json" in target
    assert "eigen/dispersion.csv" in target
    assert "eigen/dispersion/path.json" in target
    assert "eigen/modes/sample_0003/mode_0000.json" in target
    assert "eigen/mode_fields.zarr/sample_0003/mode_0000/vector_xyz_complex/0.0.0" in target
    assert "scripts/verify_fem_frequency_domain_eigen_artifacts.py" in target
    assert "--require-reference-full-2x2-floquet" in target
    assert "--require-exchange-only-analytic-dispersion" in target
    assert "--require-exchange-only-reciprocal-dispersion" in target
    assert "scripts/plot_fem_frequency_domain_eigen_artifacts.py" in target
    assert "--dispersion-png examples/dyspersje.png" in target
    assert ".fullmag/reports/frequency-domain-eigen-dispersion-runtime/plots/spectrum.svg" in target
    assert "test -f examples/dyspersje.png" in target


def test_eigen_dispersion_window_runtime_target_uses_windowed_k_path_example() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find(
        "verify-fem-frequency-domain-eigen-dispersion-window-runtime:"
    )
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "just ensure-managed-fem-runtime" in target
    assert "examples/fem_eigenmodes_dispersion_window_k_path.py" in target
    assert ".fullmag/reports/frequency-domain-eigen-dispersion-window-runtime/artifacts" in target
    assert "eigen/spectrum.v2.json" in target
    assert "eigen/branches.v2.json" in target
    assert "eigen/dispersion.csv" in target
    assert "eigen/dispersion/path.json" in target
    assert "eigen/diagnostics/solver.v1.json" in target
    assert "production_cpu_rejection_reason" not in target
    assert "required_operator_contract" not in target
    assert "--require-production-modal-k-path" in target
    assert "--require-reference-full-2x2-floquet" not in target
    assert "--require-exchange-only-analytic-dispersion" in target
    assert "--require-exchange-only-reciprocal-dispersion" in target
    assert "scripts/plot_fem_frequency_domain_eigen_artifacts.py" in target
    assert "--dispersion-png examples/dyspersje.png" in target
    assert (
        ".fullmag/reports/frequency-domain-eigen-dispersion-window-runtime/plots/spectrum.svg"
        in target
    )
    assert "test -f examples/dyspersje.png" in target


def test_de_bv_low_k_dispersion_runtime_target_uses_analytic_reference_gate() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find(
        "verify-fem-frequency-domain-eigen-dispersion-de-bv-low-k-runtime:"
    )
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "just ensure-managed-fem-runtime" in target
    assert "examples/fem_eigenmodes_dispersion_de_bv_low_k.py" in target
    assert (
        ".fullmag/reports/frequency-domain-eigen-dispersion-de-bv-low-k-runtime"
        in target
    )
    assert "eigen/spectrum.v2.json" in target
    assert "eigen/branches.v2.json" in target
    assert "eigen/dispersion.csv" in target
    assert "eigen/dispersion/path.json" in target
    assert "eigen/modes/sample_0005/mode_0000.json" in target
    assert "eigen/mode_fields/sample_0005/mode_0000/vector.bin" in target
    assert "frequency_domain/manifest.v1.json" in target
    assert "--require-low-k-de-bv-analytic-dispersion" in target
    assert "scripts/plot_fem_frequency_domain_eigen_artifacts.py" in target
    assert (
        ".fullmag/reports/frequency-domain-eigen-dispersion-de-bv-low-k-runtime/plots/spectrum.svg"
        in target
    )
    assert "--dispersion-png examples/dyspersje.png" in target
    assert "test -f examples/dyspersje.png" in target
    assert "dynamic demag for Floquet periodic FEM is not implemented yet" not in target


def test_k0_kittel_runtime_target_uses_no_demag_validation_fixture() -> None:
    assert EIGEN_K0_KITTEL_ZEEMAN_NO_DEMAG.is_file()
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find(
        "verify-fem-frequency-domain-eigen-k0-kittel-runtime:"
    )
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "just ensure-managed-fem-runtime" in target
    assert "examples/fem_eigen_k0_kittel_zeeman_no_demag.py" in target
    assert ".fullmag/reports/frequency-domain-eigen-k0-kittel-runtime/artifacts" in target
    assert "eigen/spectrum.v2.json" in target
    assert "eigen/branches.v2.json" in target
    assert "eigen/dispersion.csv" in target
    assert "frequency_domain/manifest.v1.json" in target
    assert "validation/kittel_k0_pbc/summary.v1.json" in target
    assert "validation/kittel_k0_pbc/points.v1.csv" in target
    assert "scripts/verify_fem_frequency_domain_eigen_artifacts.py" in target
    assert "--require-k0-kittel-field-sweep" in target


def test_eigen_frequency_window_runtime_requires_production_shift_invert_validator() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find("verify-fem-frequency-domain-eigen-runtime:")
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    window_example = target.index("examples/fem_eigenmodes_frequency_window.py")
    window_validator = target.index(
        "python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py",
        window_example,
    )
    production_flag = target.index("--require-production-shift-invert-window")
    window_artifacts = target.index(
        ".fullmag/reports/frequency-domain-eigen-runtime/window-artifacts",
        production_flag,
    )

    assert window_example < window_validator < production_flag < window_artifacts


def test_eigen_production_gamma_k_path_runtime_requires_production_gamma_gate() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find(
        "verify-fem-frequency-domain-eigen-production-gamma-k-path-runtime:"
    )
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "just ensure-managed-fem-runtime" in target
    assert "examples/fem_eigenmodes_production_gamma_k_path.py" in target
    assert (
        ".fullmag/reports/frequency-domain-eigen-production-gamma-k-path-runtime/artifacts"
        in target
    )
    assert "eigen/spectrum.v2.json" in target
    assert "eigen/branches.v2.json" in target
    assert "eigen/dispersion.csv" in target
    assert "eigen/dispersion/path.json" in target
    assert "eigen/modes/sample_0002/mode_0000.json" in target
    assert "eigen/mode_fields.zarr/sample_0002/mode_0000/vector_xyz_complex/0.0.0" in target
    assert "--require-production-gamma-k-path" in target
    assert "--require-production-modal-k-path" not in target


def test_eigen_frequency_window_example_requests_full_2x2_operator() -> None:
    example = EIGEN_FREQUENCY_WINDOW_SMOKE.read_text(encoding="utf-8")

    assert 'target="frequency_window"' in example
    assert 'operator="full_2x2"' in example


def test_eigen_production_gamma_k_path_example_stays_gamma_only_and_windowed() -> None:
    assert EIGEN_PRODUCTION_GAMMA_K_PATH_SMOKE.is_file()
    example = EIGEN_PRODUCTION_GAMMA_K_PATH_SMOKE.read_text(encoding="utf-8")

    assert 'target="frequency_window"' in example
    assert 'operator="full_2x2"' in example
    assert "include_demag=True" in example
    assert 'bc="free"' in example
    assert "fm.KPath" in example
    assert 'fm.KPoint("G0", (0.0, 0.0, 0.0))' in example
    assert 'fm.KPoint("G2", (0.0, 0.0, 0.0))' in example
    assert 'fm.KPoint("X"' not in example
    assert "fm.FloquetBC" not in example
    assert 'study.save("dispersion")' in example
    assert 'study.save("mode", indices=(0,))' in example


def test_eigen_dispersion_example_declares_k_path_and_dispersion_outputs() -> None:
    assert EIGEN_DISPERSION_SMOKE.is_file()
    example = EIGEN_DISPERSION_SMOKE.read_text(encoding="utf-8")

    assert "size=(80e-9, 40e-9, 40e-9)" not in example
    assert "size=(40e-9, 40e-9, 40e-9)" in example
    assert 'target="lowest"' in example
    assert "FREQUENCY_MIN_HZ" not in example
    assert "FREQUENCY_MAX_HZ" not in example
    assert "fm.KPath" in example
    assert "fm.KPoint" in example
    assert 'fm.KPoint("X", (2.0e6, 0.0, 0.0))' in example
    assert 'fm.KPoint("-X", (-2.0e6, 0.0, 0.0))' in example
    assert "samples_per_segment=[1, 1, 1]" in example
    assert 'study.save("spectrum")' in example
    assert 'study.save("dispersion")' in example
    assert 'study.save("mode", indices=(0,))' in example
    assert "study.pbc(x=True)" in example
    assert "include_demag=False" in example
    assert 'bc=fm.FloquetBC(["x_faces"])' in example


def test_eigen_dispersion_window_example_declares_selected_spectrum_k_path() -> None:
    assert EIGEN_DISPERSION_WINDOW_SMOKE.is_file()
    example = EIGEN_DISPERSION_WINDOW_SMOKE.read_text(encoding="utf-8")

    assert 'study = fm.study("fem_eigenmodes_dispersion_window_k_path")' in example
    assert 'target="frequency_window"' in example
    assert "frequency_min=1.0e9" in example
    assert "frequency_max=3.0e9" in example
    assert 'operator="full_2x2"' in example
    assert "include_demag=False" in example
    assert "fm.KPath" in example
    assert 'fm.KPoint("G", (0.0, 0.0, 0.0))' in example
    assert 'fm.KPoint("X", (2.0e6, 0.0, 0.0))' in example
    assert 'fm.KPoint("-X", (-2.0e6, 0.0, 0.0))' in example
    assert "samples_per_segment=[1, 1, 1]" in example
    assert (
        'study.objects.mesh.defaults(maximum_element_size=40e-9, order=1, periodic_pair_ids=["x_faces"])'
        in example
    )
    assert "body.mesh(" not in example
    assert 'bc=fm.FloquetBC(["x_faces"])' in example
    assert 'study.save("dispersion")' in example
    assert 'study.save("mode", indices=(0,))' in example


def test_de_bv_low_k_dispersion_example_declares_dynamic_demag_validation_target() -> None:
    assert EIGEN_DISPERSION_DE_BV_LOW_K.is_file()
    example = EIGEN_DISPERSION_DE_BV_LOW_K.read_text(encoding="utf-8")
    justfile = JUSTFILE.read_text(encoding="utf-8")

    assert 'study = fm.study("fem_eigenmodes_dispersion_de_bv_low_k")' in example
    assert "study.pbc(x=True, y=True)" in example
    assert "fm.ThinFilmDEBVDispersionValidation" in example
    assert "fm.DispersionValidationScenario(\"backward_volume\"" in example
    assert "fm.DispersionValidationScenario(\"damon_eshbach\"" in example
    assert '[3, 4, 5]' in example
    assert "max_k_rad_per_m=3.0e6" in example
    assert "frequency_window_hz=(0.0, 5.0e9)" in example
    assert 'target="frequency_window"' in example
    assert "frequency_max=5.0e9" in example
    assert 'operator="full_2x2"' in example
    assert "include_demag=True" in example
    assert 'fm.KPoint("BV", (3.0e6, 0.0, 0.0))' in example
    assert 'fm.KPoint("DE", (0.0, 3.0e6, 0.0))' in example
    assert 'bc=fm.FloquetBC(["x_faces", "y_faces"])' in example
    assert (
        "verify-fem-frequency-domain-eigen-dispersion-de-bv-low-k-runtime"
        in justfile
    )


def test_pbc_airbox_plan_keeps_tetrax_audit_priority_boundary() -> None:
    plan = PBC_AIRBOX_PLAN.read_text(encoding="utf-8")

    assert (
        "docs/reports/2026-06-29/frequency-domain-tetrax-tetmag-fullmag-audit.md"
        in plan
    )
    assert "P0/P1: domknac produkcyjny `k=0` periodic **no-demag**" in plan
    assert (
        "Antidotowy `periodic_airbox_k0` smoke z `include_demag=True` jest"
        in plan
    )
    assert "wartosciowym gate'em eksperymentalnym dla P3" in plan
    assert (
        "examples/fem_frequency_response_static_periodic_smoke.py`:\n\n"
        "- is the clean smallest k=0 static-periodic frequency-response smoke;\n"
        "- has `include_demag=False`"
        in plan
    )
    assert (
        "Demagowy\nantidot `periodic_airbox_k0` pozostaje nastepnym etapem P3"
        in plan
    )


def test_pbc_airbox_plan_p1_section_does_not_claim_antidot_demag_smoke_is_no_demag() -> None:
    plan = PBC_AIRBOX_PLAN.read_text(encoding="utf-8")

    assert (
        "Keep `examples/fem_frequency_response_smoke.py` with `include_demag=False`"
        not in plan
    )
    assert (
        "P1 uses `examples/fem_frequency_response_static_periodic_smoke.py` as the"
        in plan
    )
    assert "P3/gated antidot periodic-airbox demag smoke" in plan


def test_periodic_airbox_spectrum_runtime_target_uses_multifrequency_gate() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find(
        "verify-fem-frequency-domain-periodic-airbox-spectrum-runtime:"
    )
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "examples/fem_frequency_response_smoke.py" in target
    assert "scripts/prepare_fmr_frozen_magnetic_submesh.py" in target
    assert "FULLMAG_FMR_FROZEN_MAGNETIC_SUBMESH_SOURCE=" in target
    assert "FULLMAG_FMR_FAST_RUNTIME_MESH=1" in target
    assert "FULLMAG_FMR_FREQUENCIES_GHZ=" in target
    assert "2.5,2.75,3.0" in target
    assert (
        'FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT:-auto}"'
        in target
    )
    assert "--require-periodic-airbox-cpu-demag-solved" in target
    assert "--require-frozen-magnetic-submesh" in target
    assert "--require-min-frequency-points 3" in target
    assert "--require-response-peak" in target
    assert "--require-field-payloads-for-frequency-points" in target
    assert "scripts/derive_fem_frequency_response_modes.py" in target
    assert "response/derived_modes/fmr_peak_mode.v1.json" in target
    assert "--require-derived-peak-mode" in target


def test_periodic_airbox_spectrum_bounded_runtime_target_is_diagnostic() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find(
        "verify-fem-frequency-domain-periodic-airbox-spectrum-bounded-runtime:"
    )
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "frequency-domain-periodic-airbox-spectrum-bounded-runtime" in target
    assert "examples/fem_frequency_response_smoke.py" in target
    assert "scripts/prepare_fmr_frozen_magnetic_submesh.py" in target
    assert 'FULLMAG_FMR_FREQUENCIES_GHZ="${FULLMAG_FMR_FREQUENCIES_GHZ:-2.5,2.75,3.0}"' in target
    assert (
        'FULLMAG_FMR_RESPONSE_MAX_ITERATIONS="${FULLMAG_FMR_RESPONSE_MAX_ITERATIONS:-512}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS="${FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS:-512}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL="${FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL:-128}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT:-auto}"'
        in target
    )
    assert "set +e;" in target
    assert "RESPONSE_STATUS=$?;" in target
    assert 'echo "response_status=$RESPONSE_STATUS"' in target
    assert "--allow-solve-error" in target
    assert "--require-periodic-airbox-cpu-demag-solved" in target
    assert "--require-frozen-magnetic-submesh" in target


def test_refinement_env_target_exports_next_periodic_airbox_sweep() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find("fem-frequency-response-refinement-env:")
    assert target_start != -1
    next_target = justfile.find("\n\n", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "scripts/fem_frequency_response_refinement_env.py" in target
    assert "--shell-export" in target
    assert (
        ".fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts"
        in target
    )
    assert "FULLMAG_FMR_FREQUENCIES_GHZ" in target
    assert "FULLMAG_FMR_REFINEMENT_SOURCE_ARTIFACTS" in target
    assert (
        '${FULLMAG_FMR_REFINEMENT_SOURCE_ARTIFACTS:-.fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts}'
        in target
    )


def test_refined_spectrum_runtime_target_uses_recommended_frequencies() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find(
        "verify-fem-frequency-domain-periodic-airbox-refined-spectrum-runtime:"
    )
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "scripts/fem_frequency_response_refinement_env.py" in target
    assert ".fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts" in target
    assert "FULLMAG_FMR_REFINEMENT_SOURCE_ARTIFACTS" in target
    assert (
        '${FULLMAG_FMR_REFINEMENT_SOURCE_ARTIFACTS:-.fullmag/reports/frequency-domain-periodic-airbox-spectrum-runtime/artifacts}'
        in target
    )
    assert (
        ".fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime"
        in target
    )
    assert 'FULLMAG_FMR_FREQUENCIES_GHZ="$REFINED_FREQUENCIES_GHZ"' in target
    assert "examples/fem_frequency_response_smoke.py" in target
    assert "--require-periodic-airbox-cpu-demag-solved" in target
    assert "--require-frozen-magnetic-submesh" in target
    assert "--require-min-frequency-points 5" in target
    assert "--require-response-peak" in target
    assert "--require-interior-response-peak" in target
    assert "--require-field-payloads-for-frequency-points" in target
    assert "--require-derived-peak-mode" in target


def test_refined_spectrum_runtime_reads_recommendation_before_cleaning_output() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find(
        "verify-fem-frequency-domain-periodic-airbox-refined-spectrum-runtime:"
    )
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    read_frequencies = target.index(
        'REFINED_FREQUENCIES_GHZ="$(python3 scripts/fem_frequency_response_refinement_env.py "$REFINEMENT_SOURCE_ARTIFACTS")"'
    )
    clean_output = target.index(
        "rm -rf .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime"
    )

    assert read_frequencies < clean_output


def test_refined_spectrum_runtime_validates_source_before_refinement() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find(
        "verify-fem-frequency-domain-periodic-airbox-refined-spectrum-runtime:"
    )
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    source_validation = target.index(
        'python3 scripts/verify_fem_frequency_domain_runtime_artifacts.py --require-periodic-airbox-cpu-demag-solved --require-frozen-magnetic-submesh --require-min-frequency-points 3 --require-response-peak --require-field-payloads-for-frequency-points --require-derived-peak-mode "$REFINEMENT_SOURCE_ARTIFACTS"'
    )
    output_cleanup = target.index(
        "if [ -d .fullmag/reports/frequency-domain-periodic-airbox-refined-spectrum-runtime ]; then docker compose"
    )
    read_frequencies = target.index(
        'REFINED_FREQUENCIES_GHZ="$(python3 scripts/fem_frequency_response_refinement_env.py "$REFINEMENT_SOURCE_ARTIFACTS")"'
    )

    assert source_validation < output_cleanup
    assert source_validation < read_frequencies


def test_periodic_k0_example_target_uses_periodic_airbox_response_runtime() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find("fem-fmr-periodic-k0-example:")
    assert target_start != -1
    next_target = justfile.find("\n\n", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "just verify-fem-fmr-periodic-k0-runtime" in target
    assert "fem-fmr-free-demag-airbox-example" not in target
    assert "frequency-domain-periodic-airbox-runtime" in target
    assert "magnetic_response_sweep.v2.json" in target
    assert "response/field_payloads.zarr" in target
    assert "mesh/periodic_pairs.v1.json" in target


def test_periodic_k0_smoke_delegates_to_periodic_airbox_response_smoke() -> None:
    example = PERIODIC_K0_SMOKE.read_text(encoding="utf-8")

    assert "fem_frequency_response_smoke.py" in example
    assert "periodic_airbox_k0" in example
    assert "fem_fmr_free_demag_airbox_smoke.py" in example
    assert "add_eigenmodes" not in example
    assert 'bc="free"' not in example


def test_simple_periodic_antidot_frequency_driven_target_runs_new_plain_script() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find("run-fem-periodic-antidot-frequency-driven-managed-headless")
    assert target_start != -1
    next_target = justfile.find("\n\n", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "just ensure-managed-fem-runtime" in target
    assert "rm -rf .fullmag/reports/fem-periodic-antidot-frequency-driven-runtime/artifacts" in target
    assert "mkdir -p .fullmag/reports/fem-periodic-antidot-frequency-driven-runtime" in target
    assert "examples/fem_periodic_antidot_relax_exchange_coupled_frequency_driven.py" in target
    assert "FULLMAG_PERIODIC_ANTIDOT_FREQUENCY_STAGE=relax" in target
    assert "FULLMAG_PERIODIC_ANTIDOT_FREQUENCY_STAGE=response" in target
    assert "relax_artifacts/m_final.json" in target
    assert "scripts/write_fem_magnetic_initial_state_from_shared_domain.py" in target
    assert "relaxed_magnetic_initial_state.json" in target
    assert (
        "FULLMAG_PERIODIC_ANTIDOT_RELAXED_MAGNETIC_STATE=/workspace/.fullmag/reports/fem-periodic-antidot-frequency-driven-runtime/relaxed_magnetic_initial_state.json"
        in target
    )
    assert "--initial-magnetization-state" not in target
    assert "examples/fem_frequency_response_smoke.py" not in target
    assert "--headless" in target
    assert "--json" in target
    assert (
        "--output-dir .fullmag/reports/fem-periodic-antidot-frequency-driven-runtime/artifacts"
        in target
    )
    assert "scripts/verify_fem_frequency_domain_runtime_artifacts.py" in target
    assert "--require-production-gpu --require-periodic-airbox-gpu-demag-solved" in target
    assert 'fem_execution="script"' in target
    assert "native GPU periodic-airbox dynamic-demag response slice" in target
    assert "expected gpu" in target
    assert "env -u FULLMAG_FEM_EXECUTION" not in target
    assert "FULLMAG_FEM_EXECUTION=gpu" in target
    assert "FULLMAG_RELAX_DEVICE=gpu" in target
    assert "FULLMAG_FMR_DEVICE=gpu" in target
    assert "FULLMAG_FDM_EXECUTION=cpu" in target
    assert 'FULLMAG_GMSH_THREADS="${FULLMAG_GMSH_THREADS:-1}"' in target
    assert 'FULLMAG_FMR_DEMAG_RTOL="${FULLMAG_FMR_DEMAG_RTOL:-1e-4}"' in target
    assert (
        'FULLMAG_FMR_DEMAG_MAX_ITERATIONS="${FULLMAG_FMR_DEMAG_MAX_ITERATIONS:-1000}"'
        in target
    )
    assert 'FULLMAG_FMR_RESPONSE_RTOL="${FULLMAG_FMR_RESPONSE_RTOL:-1e-3}"' in target
    assert (
        'FULLMAG_FMR_RESPONSE_MAX_ITERATIONS="${FULLMAG_FMR_RESPONSE_MAX_ITERATIONS:-8192}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS="${FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS:-8192}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL="${FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL:-128}"'
        in target
    )
    assert (
        'FULLMAG_FEM_FREQUENCY_RESPONSE_PRECONDITIONER_VARIANT="${FULLMAG_FEM_FREQUENCY_RESPONSE_PRECONDITIONER_VARIANT:-auto}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT:-auto}"'
        in target
    )


def test_periodic_antidot_frequency_driven_example_uses_gpu_transition() -> None:
    example = PERIODIC_ANTIDOT_FREQUENCY_DRIVEN.read_text(encoding="utf-8")

    assert 'study.device("gpu", precision="double")' in example
    assert "frequency_response_dynamic_demag" in example
    assert "study.interactive(False)" in example
    assert "study.clear_outputs()" in example
    assert "PeriodicAntidotFixtureConfig" not in example
    assert "load_periodic_antidot_fixture_config" in example
    assert "os.environ" not in example
    assert "fm.load_magnetization(fixture_config.relaxed_state_path, format=\"json\")" in example
    assert "if fixture_config.domain_mesh_path:" in example
    assert "study.domain_mesh(" in example
    assert "region_markers={\"periodic_antidot_film\": 1}" in example
    assert "run_stage = fixture_config.run_stage" in example
    assert "study.stages.add_minimize(" in example
    assert "method=\"bb\"" in example
    assert "algorithm=\"llg_overdamped\"" not in example
    assert "solver=\"rk23\"" not in example
    assert "equilibrium_torque_tolerance_t = 5.0e-3" in example
    assert "equilibrium_torque_tolerance_a_per_m" in example
    assert "minimum_element_size=0.5e-9" not in example
    assert "maximum_element_size=3e-9" not in example
    assert "rtol=1e-4" in example
    assert "max_iterations=1000" in example
    assert "tolA=equilibrium_torque_tolerance_a_per_m" in example
    assert "include_demag=True" in example
    assert 'magnetostatic_bc="periodic_airbox_k0"' in example
    assert 'solver_method="gpu_operator_host_krylov"' in example
    assert 'solver_preconditioner=fixture_config.preconditioner' in example
    assert "response_solver_max_iterations = 8192" in example
    assert "solver_max_iterations=response_solver_max_iterations" in example
    assert "solver_restart_iterations=response_solver_restart_iterations" in example
    assert "response_solver_restart_iterations = fixture_config.restart_iterations" in example
    assert 'equilibrium_source="relax" if run_stage == "combined" else "provided"' in example
    assert "solver_rtol=" not in example
    assert 'study.stages.change_device("gpu")' in example
    assert 'study.save("H_demag"' not in example
    assert 'study.save("demag_phi"' not in example


def test_periodic_airbox_gpu_runtime_target_is_artifact_backed() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find("verify-fem-frequency-domain-periodic-airbox-gpu-runtime:")
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "examples/fem_frequency_response_gpu_periodic_airbox_smoke.py" in target
    assert "--require-production-gpu" in target
    assert "--require-periodic-airbox-gpu-demag-solved" in target
    assert "--allow-unavailable" not in target
    assert ".fullmag/reports/frequency-domain-periodic-airbox-gpu-runtime/artifacts" in target
    assert "FULLMAG_FEM_EXECUTION=gpu" in target
    assert "FULLMAG_FMR_DEVICE=gpu" in target
    assert "FULLMAG_RELAX_DEVICE=gpu" in target
    assert 'FULLMAG_FEM_GPU_DEMAG_MODE="${FULLMAG_FEM_GPU_DEMAG_MODE:-device_hypre_poisson}"' in target
    assert (
        'FULLMAG_FEM_FREQUENCY_RESPONSE_GPU_DEMAG_MODE="${FULLMAG_FEM_FREQUENCY_RESPONSE_GPU_DEMAG_MODE:-hybrid_cpu_poisson}"'
        in target
    )
    assert 'FULLMAG_FMR_RESPONSE_RTOL="${FULLMAG_FMR_RESPONSE_RTOL:-1e-3}"' in target
    assert (
        'FULLMAG_FMR_RESPONSE_MAX_ITERATIONS="${FULLMAG_FMR_RESPONSE_MAX_ITERATIONS:-8192}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS="${FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS:-8192}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL="${FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL:-128}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT:-auto}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_PRECONDITIONER_AUTO_DISABLE_THRESHOLD="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_AUTO_DISABLE_THRESHOLD:-1.0}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_PRECONDITIONER_AUTO_PILOT_ITERATIONS="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_AUTO_PILOT_ITERATIONS:-16}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_GRAPH_PRECONDITIONER_SWEEPS="${FULLMAG_FMR_RESPONSE_GRAPH_PRECONDITIONER_SWEEPS:-4}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_GRAPH_PRECONDITIONER_RELAXATION="${FULLMAG_FMR_RESPONSE_GRAPH_PRECONDITIONER_RELAXATION:-1.0}"'
        in target
    )


def test_cpu_periodic_airbox_demag_smoke_runtime_target_is_artifact_backed() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    suite_start = justfile.find("verify-fem-frequency-domain-runtime-suite:")
    assert suite_start != -1
    next_target = justfile.find("\nverify-", suite_start + 1)
    suite = justfile[suite_start:] if next_target == -1 else justfile[suite_start:next_target]
    assert "just verify-fem-frequency-domain-cpu-periodic-airbox-demag-smoke-runtime" in suite

    target_start = justfile.find(
        'verify-fem-frequency-domain-cpu-periodic-airbox-demag-smoke-runtime cpu_threads="auto":'
    )
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "examples/fem_frequency_response_cpu_periodic_airbox_demag_smoke.py" in target
    assert "--require-periodic-airbox-cpu-demag-solved" in target
    assert (
        ".fullmag/reports/frequency-domain-cpu-periodic-airbox-demag-smoke-runtime/artifacts"
        in target
    )
    assert "FULLMAG_FMR_DEVICE=cpu" in target


def test_cpu_periodic_airbox_demag_smoke_requests_periodic_airbox_demag() -> None:
    example = CPU_PERIODIC_AIRBOX_DEMAG_RESPONSE.read_text(encoding="utf-8")

    assert 'study.device("cpu", precision="double")' in example
    assert 'study.pbc(x=True, y=True, demag="periodic_airbox_k0")' in example
    assert 'study.demag(realization="poisson_robin")' in example
    assert "study.build_domain_mesh()" in example
    assert "include_demag=True" in example
    assert 'bc=fm.PeriodicBC(["x_faces"])' in example
    assert 'magnetostatic_bc="periodic_airbox_k0"' in example


def test_periodic_airbox_z_padding_runtime_target_compares_two_airboxes() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find(
        "verify-fem-frequency-domain-periodic-airbox-z-padding-runtime:"
    )
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "examples/fem_frequency_response_smoke.py" in target
    assert ".fullmag/reports/frequency-domain-periodic-airbox-z-padding-runtime/reference/artifacts" in target
    assert ".fullmag/reports/frequency-domain-periodic-airbox-z-padding-runtime/candidate/artifacts" in target
    assert "FULLMAG_FMR_AIRBOX_THICKNESS_NM=" in target
    assert "FULLMAG_FMR_AIRBOX_REFERENCE_THICKNESS_NM" in target
    assert "FULLMAG_FMR_AIRBOX_CANDIDATE_THICKNESS_NM" in target
    assert 'FULLMAG_FMR_AIRBOX_REFERENCE_THICKNESS_NM="${FULLMAG_FMR_AIRBOX_REFERENCE_THICKNESS_NM:-120}"' in target
    assert 'FULLMAG_FMR_AIRBOX_CANDIDATE_THICKNESS_NM="${FULLMAG_FMR_AIRBOX_CANDIDATE_THICKNESS_NM:-150}"' in target
    assert "FULLMAG_FMR_MESH_ALGORITHM_3D=" in target
    assert (
        'FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT:-auto}"'
        in target
    )
    assert "--require-periodic-airbox-cpu-demag-solved" in target
    assert "--require-frozen-magnetic-submesh" in target
    assert "--compare-airbox-reference" in target
    assert "scripts/prepare_fmr_frozen_magnetic_submesh.py" in target
    assert "FULLMAG_FMR_FROZEN_MAGNETIC_SUBMESH_SOURCE=" in target


def test_periodic_airbox_supercell_artifact_target_compares_unit_and_supercell() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find(
        "verify-fem-frequency-domain-periodic-airbox-supercell-artifacts:"
    )
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "scripts/verify_fem_frequency_domain_supercell_artifacts.py" in target
    assert "FULLMAG_FMR_SUPERCELL_ARTIFACTS must point" in target
    assert "--unit-cell" in target
    assert "FULLMAG_FMR_UNIT_CELL_ARTIFACTS" in target
    assert "--supercell" in target
    assert "FULLMAG_FMR_SUPERCELL_ARTIFACTS" in target
    assert "--repeat-x" in target
    assert "FULLMAG_FMR_SUPERCELL_REPEAT_X" in target
    assert "--repeat-y" in target
    assert "FULLMAG_FMR_SUPERCELL_REPEAT_Y" in target
    assert "--write-report" in target
    assert "frequency-domain-periodic-airbox-supercell-validation" in target


def test_periodic_airbox_supercell_runtime_target_generates_unit_and_supercell() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find(
        "verify-fem-frequency-domain-periodic-airbox-supercell-runtime:"
    )
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "examples/fem_frequency_response_smoke.py" in target
    assert "scripts/prepare_fmr_frozen_magnetic_submesh.py" in target
    assert "FULLMAG_FMR_EQUILIBRIUM_SOURCE=provided" in target
    assert "FULLMAG_FMR_SUPERCELL_REPEAT_X=" in target
    assert "FULLMAG_FMR_SUPERCELL_REPEAT_Y=" in target
    assert "FULLMAG_FMR_SUPERCELL_REPEAT_X=1 FULLMAG_FMR_SUPERCELL_REPEAT_Y=1" in target
    assert (
        'FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT:-auto}"'
        in target
    )
    assert "frequency-domain-periodic-airbox-supercell-runtime/unit/artifacts" in target
    assert "frequency-domain-periodic-airbox-supercell-runtime/supercell/artifacts" in target
    assert "--require-periodic-airbox-cpu-demag-solved" in target
    assert "--require-frozen-magnetic-submesh" in target
    assert "--require-min-frequency-points 3" in target
    assert "scripts/verify_fem_frequency_domain_supercell_artifacts.py" in target
    assert "supercell_validation.v1.json" in target


def test_periodic_airbox_example_and_frozen_helper_accept_supercell_repeats() -> None:
    example = FMR_SMOKE.read_text(encoding="utf-8")
    helper = FROZEN_SUBMESH_HELPER.read_text(encoding="utf-8")

    for source in (example, helper):
        assert 'env_int("FULLMAG_FMR_SUPERCELL_REPEAT_X", 1)' in source
        assert 'env_int("FULLMAG_FMR_SUPERCELL_REPEAT_Y", 1)' in source
        assert "UNIT_CELL_SIZE[0] * SUPERCELL_REPEAT_X" in source or "UNIT_CELL_SIZE[0] * repeat_x" in source
        assert "UNIT_CELL_SIZE[1] * SUPERCELL_REPEAT_Y" in source or "UNIT_CELL_SIZE[1] * repeat_y" in source
    assert "periodic_antidot_geometry()" in example
    assert "periodic_antidot_geometry()" in helper
    assert "hole_centers()" in example
    assert "hole_centers()" in helper


def test_periodic_airbox_supercell_diagnostics_runtime_target_is_bounded() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find(
        "verify-fem-frequency-domain-periodic-airbox-supercell-diagnostics-runtime:"
    )
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "frequency-domain-periodic-airbox-supercell-diagnostics-runtime" in target
    assert "FULLMAG_FMR_SUPERCELL_REPEAT_X=1 FULLMAG_FMR_SUPERCELL_REPEAT_Y=1" in target
    assert "frequency-domain-periodic-airbox-supercell-diagnostics-runtime/unit/artifacts" in target
    assert "frequency-domain-periodic-airbox-supercell-diagnostics-runtime/supercell/artifacts" in target
    assert 'FULLMAG_FMR_FREQUENCIES_GHZ="${FULLMAG_FMR_FREQUENCIES_GHZ:-2.75}"' in target
    assert (
        'FULLMAG_FMR_RESPONSE_MAX_ITERATIONS="${FULLMAG_FMR_RESPONSE_MAX_ITERATIONS:-8}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS="${FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS:-8}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL="${FULLMAG_FMR_RESPONSE_PROGRESS_INTERVAL:-8}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT="${FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT:-auto}"'
        in target
    )
    assert "--allow-solve-error" in target
    assert "--require-periodic-airbox-cpu-demag-solved" in target
    assert "--require-frozen-magnetic-submesh" in target


def test_periodic_airbox_smoke_allows_mesh_algorithm_override() -> None:
    example = FMR_SMOKE.read_text(encoding="utf-8")

    assert 'env_int("FULLMAG_FMR_MESH_ALGORITHM_3D", 1)' in example


def test_gpu_floquet_reciprocal_runtime_target_compares_opposite_k_artifacts() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find("verify-fem-frequency-domain-gpu-floquet-reciprocal-runtime:")
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "examples/fem_frequency_response_gpu_floquet_no_demag_smoke.py" in target
    assert ".fullmag/reports/frequency-domain-gpu-floquet-reciprocal-runtime/positive-k" in target
    assert ".fullmag/reports/frequency-domain-gpu-floquet-reciprocal-runtime/negative-k" in target
    assert "FULLMAG_FMR_FLOQUET_KX_RAD_PER_M=1000000" in target
    assert "FULLMAG_FMR_FLOQUET_KX_RAD_PER_M=-1000000" in target
    assert "--require-production-gpu" in target
    assert "--require-floquet-phase-projection" in target
    assert "--compare-floquet-reciprocal-reference" in target


def test_cpu_floquet_runtime_target_is_artifact_backed() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find("verify-fem-frequency-domain-cpu-floquet-runtime:")
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "examples/fem_frequency_response_gpu_floquet_no_demag_smoke.py" in target
    assert ".fullmag/reports/frequency-domain-cpu-floquet-runtime/artifacts" in target
    assert "FULLMAG_FEM_EXECUTION=cpu" in target
    assert "FULLMAG_RELAX_DEVICE=cpu" in target
    assert "FULLMAG_FMR_DEVICE=cpu" in target
    assert "FULLMAG_FMR_FLOQUET_KX_RAD_PER_M=1000000" in target
    assert "--require-floquet-phase-projection" in target
    assert "--require-production-gpu" not in target


def test_gpu_floquet_airbox_unsupported_runtime_target_is_artifact_backed() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find(
        "verify-fem-frequency-domain-gpu-floquet-airbox-unsupported-runtime:"
    )
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "examples/fem_frequency_response_gpu_floquet_airbox_unsupported_smoke.py" in target
    assert "--require-production-gpu" in target
    assert "--require-floquet-airbox-gpu-unsupported" in target
    assert "--allow-unavailable" in target
    assert ".fullmag/reports/frequency-domain-gpu-floquet-airbox-unsupported-runtime/artifacts" in target
    assert "FULLMAG_FEM_EXECUTION=gpu" in target
    assert "FULLMAG_RELAX_DEVICE=gpu" in target
    assert "FULLMAG_FMR_FLOQUET_KX_RAD_PER_M=1000000" in target


def test_gpu_periodic_airbox_eigen_demag_target_is_artifact_backed() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    example = EIGEN_K0_KITTEL_PERIODIC_AIRBOX_GPU.read_text(encoding="utf-8")

    target_start = justfile.find(
        "verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-gpu:"
    )
    assert target_start != -1
    next_target = justfile.find("\n\n", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "just ensure-managed-fem-runtime" in target
    assert "examples/fem_eigen_k0_kittel_periodic_airbox_gpu.py" in target
    assert "frequency-domain-eigen-k0-kittel-periodic-airbox-gpu" in target
    assert "FULLMAG_FEM_EXECUTION=gpu" in target
    assert "FULLMAG_RELAX_DEVICE=gpu" in target
    assert "--require-gpu-modal-k0-periodic-airbox-provenance" in target
    assert "unexpectedly succeeded" not in target
    assert "unsupported_boundary.v1.json" not in target
    assert 'study.device("gpu", precision="double")' in example
    assert 'study.pbc(x=True, y=True, demag="periodic_airbox_k0")' in example
    assert "include_demag=True" in example
    assert "BIAS_FIELD_MIN_T = 5.0e-3" in example
    assert "BIAS_FIELD_MAX_T = 0.10" in example
    assert "samples_per_segment=[14]" in example
    assert 'study.save("spectrum")' in example
    assert 'study.save("mode", indices=(0,))' in example


def test_frequency_domain_runtime_suite_includes_gpu_periodic_airbox_eigen_demag_gate() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find("verify-fem-frequency-domain-runtime-suite:")
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert (
        "just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-gpu"
        in target
    )


def test_periodic_airbox_eigen_convergence_target_runs_independent_three_level_sequences() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    example = EIGEN_K0_KITTEL_PERIODIC_AIRBOX.read_text(encoding="utf-8")

    target_start = justfile.find(
        "verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-cpu:"
    )
    assert target_start != -1
    next_target = justfile.find("\n\n", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "just ensure-managed-fem-runtime" in target
    assert "examples/fem_eigen_k0_kittel_periodic_airbox.py" in target
    assert "run_case mesh/coarse 24 12 40 9" in target
    assert "run_case mesh/medium 20 10 40 9" in target
    assert "run_case mesh/fine 16 8 40 9" in target
    assert "run_case airbox/small 16 8 40 5" in target
    assert "run_case airbox/medium 16 8 40 7" in target
    assert "run_case airbox/large 16 8 40 9" in target
    assert target.count("--mesh-root") == 3
    assert target.count("--airbox-root") == 3
    assert "--output-dir \"$report/aggregate\"" in target
    assert "scripts/verify_fem_eigen_k0_periodic_airbox_convergence.py" in target
    assert "--require-k0-kittel-periodic-airbox-demag" in target
    assert "FULLMAG_FEM_EXECUTION=cpu" in target
    assert "FULLMAG_RELAX_DEVICE=cpu" in target
    assert "FULLMAG_K0_KITTEL_MAG_HMAX_NM" in example


def test_periodic_airbox_kittel_fixture_exports_a_shape_selectable_positive_field_sweep() -> None:
    example = EIGEN_K0_KITTEL_PERIODIC_AIRBOX.read_text(encoding="utf-8")

    assert "BIAS_FIELD_MIN_T = 5.0e-3" in example
    assert "BIAS_FIELD_MAX_T = 0.10" in example
    # The current production K0 lane qualifies one accepted mode per physical
    # field sample; requesting twelve modes would make this fixture claim a
    # qualification the GPU lane does not yet provide.
    assert "N_MODES = 1" in example
    assert "study.fem_demag_solver(rtol=1e-10, max_iterations=1000)" in example


def test_frequency_domain_runtime_suite_includes_periodic_airbox_eigen_convergence_gate() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find("verify-fem-frequency-domain-runtime-suite:")
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert (
        "just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-cpu"
        in target
    )


def test_periodic_airbox_eigen_gpu_convergence_target_runs_independent_three_level_sequences() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find(
        "verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-gpu:"
    )
    assert target_start != -1
    next_target = justfile.find("\n\n", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "just ensure-managed-fem-runtime" in target
    assert "examples/fem_eigen_k0_kittel_periodic_airbox_gpu.py" in target
    assert "run_case mesh/coarse 24 12 40 9" in target
    assert "run_case mesh/medium 20 10 40 9" in target
    assert "run_case mesh/fine 16 8 40 9" in target
    assert "run_case airbox/small 16 8 40 5" in target
    assert "run_case airbox/medium 16 8 40 7" in target
    assert "run_case airbox/large 16 8 40 9" in target
    assert target.count("--mesh-root") == 3
    assert target.count("--airbox-root") == 3
    assert "scripts/verify_fem_eigen_k0_periodic_airbox_convergence.py" in target
    assert "--require-gpu-modal-k0-periodic-airbox-provenance" in target
    assert "--execution-lane production_gpu" in target
    assert "FULLMAG_FEM_EXECUTION=gpu" in target
    assert "FULLMAG_RELAX_DEVICE=gpu" in target


def test_k0_production_release_runs_cpu_and_gpu_convergence_before_promotion() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find(
        "verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-release:"
    )
    assert target_start != -1
    next_target = justfile.find("\n\n", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-cpu" in target
    assert "just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-gpu" in target
    assert "just verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-cpu" in target
    assert "just verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-gpu" in target


def test_k0_production_targets_execute_fresh_scope_fixture_not_kittel_copy() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    example = EIGEN_K0_PRODUCTION_PERIODIC_AIRBOX.read_text(encoding="utf-8")

    assert "k0_kittel_validation" not in example
    assert "FULLMAG_K0_PRODUCTION_DEVICE" in example
    assert "study.pbc(x=True, y=True, demag=\"periodic_airbox_k0\")" in example
    assert 'study.stages.add_eigenmodes(' in example

    for target_name, device, verifier_flag in (
        (
            "verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-cpu:",
            "cpu",
            "--require-k0-periodic-airbox-production",
        ),
        (
            "verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-gpu:",
            "gpu",
            "--require-gpu-modal-k0-periodic-airbox-production",
        ),
    ):
        target_start = justfile.find(target_name)
        assert target_start != -1
        next_target = justfile.find("\n\n", target_start + 1)
        target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]
        service = "fem-modal-cpu" if device == "cpu" else "fem-gpu"
        profile = "fem-modal-cpu" if device == "cpu" else "fem-gpu"
        assert "examples/fem_eigen_k0_poisson_airbox_production.py" in target
        assert f"FULLMAG_K0_PRODUCTION_DEVICE={device}" in target
        assert f"docker compose --profile {profile} run" in target
        assert f"      {service} bash -lc" in target
        expected_scope_env = (
            "FULLMAG_FEM_K0_CPU_SCOPE_JSON"
            if device == "cpu"
            else "FULLMAG_FEM_K0_GPU_SCOPE_JSON"
        )
        assert expected_scope_env in target
        expected_evidence_env = (
            "FULLMAG_FEM_K0_CPU_EVIDENCE_MANIFEST"
            if device == "cpu"
            else "FULLMAG_FEM_K0_GPU_EVIDENCE_MANIFEST"
        )
        assert expected_evidence_env in target
        assert verifier_flag in target
        assert "frequency-domain-eigen-k0-kittel-periodic-airbox/artifacts" not in target
        assert "cp -a" not in target


def test_control_room_frequency_fixture_does_not_claim_k0_production_qualification() -> None:
    smoke = CONTROL_ROOM_SMOKE.read_text(encoding="utf-8")

    modal_start = smoke.index("modal: {")
    modal_end = smoke.index("response: {", modal_start)
    modal = smoke[modal_start:modal_end]

    assert 'production_cpu: frequencyDomainCapability(\n          "partial_production_executable",\n        )' in modal
    assert 'production_gpu: frequencyDomainCapability("source_visible")' in modal
    assert 'production_qualified' not in modal


def test_modal_cpu_compose_service_is_gpu_request_free() -> None:
    compose = COMPOSE_FILE.read_text(encoding="utf-8")
    start = compose.find("  fem-modal-cpu:\n")
    assert start != -1
    end = compose.find("\n  fem-cpu:\n", start)
    assert end != -1
    service = compose[start:end]
    assert "image: ${FULLMAG_FEM_GPU_IMAGE:-fullmag/fem-gpu:local}" in service
    assert "FULLMAG_FEM_WITH_SLEPC: \"ON\"" in service
    assert "FULLMAG_FEM_MFEM_DEVICE: cpu" in service
    assert "gpus:" not in service


def test_frequency_domain_runtime_suite_includes_floquet_airbox_gpu_boundary() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find("verify-fem-frequency-domain-runtime-suite:")
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "just verify-fem-frequency-domain-gpu-floquet-airbox-unsupported-runtime" in target


def test_frequency_domain_runtime_suite_includes_periodic_airbox_gpu_boundary() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find("verify-fem-frequency-domain-runtime-suite:")
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "just verify-fem-frequency-domain-periodic-airbox-gpu-runtime" in target


def test_periodic_airbox_gpu_device_poisson_parity_target_is_strict_device_backed() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")
    example = (REPO_ROOT / "examples" / "fem_frequency_response_gpu_periodic_airbox_smoke.py").read_text(
        encoding="utf-8"
    )

    target_start = justfile.find(
        "verify-fem-frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime:"
    )
    assert target_start != -1
    next_target = justfile.find("\n\n", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "just ensure-managed-fem-runtime" in target
    assert "frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/cpu/artifacts" in target
    assert "frequency-domain-periodic-airbox-gpu-device-poisson-parity-runtime/gpu/artifacts" in target
    assert "examples/fem_frequency_response_cpu_periodic_airbox_demag_smoke.py" in target
    assert "examples/fem_frequency_response_gpu_periodic_airbox_smoke.py" in target
    assert "FULLMAG_FEM_FREQUENCY_RESPONSE_GPU_DEMAG_MODE=device_hypre_poisson" in target
    assert "FULLMAG_FEM_GPU_DEMAG_MODE=device_hypre_poisson" in target
    assert 'FULLMAG_FMR_DEMAG_RTOL="${FULLMAG_FMR_DEMAG_RTOL:-1e-10}"' in target
    assert 'FULLMAG_FMR_DEMAG_MAX_ITERATIONS="${FULLMAG_FMR_DEMAG_MAX_ITERATIONS:-2000}"' in target
    assert "FULLMAG_FMR_RESPONSE_PRECONDITIONER_VARIANT=none" in target
    assert 'FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS="${FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS:-128}"' in target
    assert "FULLMAG_FMR_PERIODIC_AIRBOX_GPU_FREQUENCIES_HZ=1.0e9" in target
    assert "--require-production-gpu" in target
    assert "--require-periodic-airbox-gpu-demag-solved" in target
    assert "--compare-reference" in target
    assert "scripts/write_fem_gpu_poisson_parity_artifact.py" in target
    assert "scripts/verify_fem_gpu_poisson_parity_artifact.py" in target
    assert "gpu_poisson_parity.v1.json" in target
    assert "scripts/write_fem_gpu_schur_apply_parity_artifact.py" in target
    assert "scripts/verify_fem_gpu_schur_apply_parity_artifact.py" in target
    assert "gpu_schur_apply_parity.v1.json" in target
    assert "scripts/write_fem_gpu_shifted_solve_action_parity_artifact.py" in target
    assert "scripts/verify_fem_gpu_shifted_solve_action_parity_artifact.py" in target
    assert "gpu_shifted_solve_action_parity.v1.json" in target
    assert "hybrid_cpu_poisson" not in target
    assert "FULLMAG_FMR_PERIODIC_AIRBOX_GPU_FREQUENCIES_HZ" in example


def test_poisson_airbox_gpu_modal_shift_invert_action_target_is_not_frequency_response_proxy() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find(
        "verify-fem-frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action:"
    )
    assert target_start != -1
    next_target = justfile.find("\n\n", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "just ensure-managed-fem-runtime" in target
    assert "FULLMAG_PA_G3F_OUTPUT_DIR" in target
    assert "fem_poisson_airbox_modal_eigen_slepc_contract" in target
    assert "gpu_modal_shift_invert_action.v1.json" in target
    assert "gpu_modal_poisson_airbox_eigensolver.v1.json" in target
    assert "gpu_modal_poisson_airbox_descriptor_apply.v1.json" in target
    assert "poisson_airbox_modal_shift_invert_action.v1.json" in target
    assert "gpu_modal_shift_invert_action_parity.v1.json" in target
    assert "scripts/verify_fem_gpu_modal_poisson_airbox_descriptor_apply_artifact.py" in target
    assert "scripts/verify_fem_gpu_modal_poisson_airbox_eigensolver_artifact.py" in target
    assert "scripts/verify_fem_gpu_modal_shift_invert_action_parity_artifact.py" in target
    assert "gpu_shifted_solve_action_parity.v1.json" not in target
    assert "examples/fem_frequency_response_" not in target


def test_frequency_domain_runtime_suite_includes_cpu_floquet_gate() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find("verify-fem-frequency-domain-runtime-suite:")
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "just verify-fem-frequency-domain-cpu-floquet-runtime" in target


def test_frequency_domain_runtime_suite_includes_static_periodic_parity_gate() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find("verify-fem-frequency-domain-runtime-suite:")
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "just verify-fem-frequency-domain-gpu-static-periodic-parity-runtime" in target


def test_frequency_domain_runtime_suite_includes_gpu_free_demag_gate() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find("verify-fem-frequency-domain-runtime-suite:")
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "just verify-fem-frequency-domain-gpu-free-demag-runtime" in target


def test_frequency_domain_runtime_suite_includes_free_demag_parity_gate() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find("verify-fem-frequency-domain-runtime-suite:")
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "just verify-fem-frequency-domain-free-demag-parity-runtime" in target


def test_gpu_free_demag_target_requires_demag_operator_terms() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find("verify-fem-frequency-domain-gpu-free-demag-runtime:")
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "examples/fem_frequency_response_gpu_free_demag_smoke.py" in target
    assert "--require-production-gpu" in target
    assert '"demag" in d.get("operator_terms_included", [])' in target


def test_frequency_domain_runtime_suite_includes_shared_domain_static_periodic_parity_gate() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find("verify-fem-frequency-domain-runtime-suite:")
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "just verify-fem-frequency-domain-shared-domain-static-periodic-parity-runtime" in target


def test_shared_domain_static_periodic_parity_target_compares_cpu_and_gpu() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find(
        "verify-fem-frequency-domain-shared-domain-static-periodic-parity-runtime cpu_threads="
    )
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "examples/fem_frequency_response_shared_domain_static_periodic_smoke.py" in target
    assert "frequency-domain-shared-domain-static-periodic-parity-runtime/cpu/artifacts" in target
    assert "frequency-domain-shared-domain-static-periodic-parity-runtime/gpu/artifacts" in target
    assert "FULLMAG_FMR_DEVICE=cpu" in target
    assert "FULLMAG_FMR_DEVICE=gpu" in target
    assert "--require-static-periodic" in target
    assert "--require-production-gpu --require-static-periodic --compare-reference" in target
    assert 'FULLMAG_GMSH_THREADS="${FULLMAG_GMSH_THREADS:-1}"' in target


def test_shared_domain_static_periodic_smoke_is_no_demag_shared_domain() -> None:
    example = SHARED_DOMAIN_STATIC_PERIODIC_RESPONSE.read_text(encoding="utf-8")

    assert 'study.universe(' in example
    assert 'study.pbc(x=True, y=True, demag="periodic_airbox_k0")' in example
    assert 'study.demag(realization="poisson_robin")' in example
    assert "study.build_domain_mesh()" in example
    assert "study.demag(enabled=False)" in example
    assert "include_demag=False" in example


def test_gpu_free_demag_smoke_requests_gpu_demag_provider_path() -> None:
    example = GPU_FREE_DEMAG_RESPONSE.read_text(encoding="utf-8")

    assert 'study.device("gpu", precision="double")' in example
    assert 'study.demag(realization="poisson_robin")' in example
    assert "study.build_domain_mesh()" in example
    assert "include_demag=True" in example
    assert 'bc="free"' in example
    assert "magnetostatic_bc=" not in example


def test_free_demag_parity_target_compares_cpu_and_gpu() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find(
        'verify-fem-frequency-domain-free-demag-parity-runtime cpu_threads="auto":'
    )
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "examples/fem_frequency_response_cpu_free_demag_smoke.py" in target
    assert "examples/fem_frequency_response_gpu_free_demag_smoke.py" in target
    assert "frequency-domain-free-demag-parity-runtime/cpu/artifacts" in target
    assert "frequency-domain-free-demag-parity-runtime/gpu/artifacts" in target
    assert "--require-production-gpu --compare-reference" in target
    assert '"demag" in d.get("operator_terms_included", [])' in target


def test_cpu_free_demag_smoke_requests_cpu_demag_provider_path() -> None:
    example = CPU_FREE_DEMAG_RESPONSE.read_text(encoding="utf-8")

    assert 'study.device("cpu", precision="double")' in example
    assert 'study.demag(realization="poisson_robin")' in example
    assert "study.build_domain_mesh()" in example
    assert "include_demag=True" in example
    assert 'bc="free"' in example
    assert "magnetostatic_bc=" not in example


def test_frequency_domain_runtime_suite_includes_production_modal_k_path_gate() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find("verify-fem-frequency-domain-runtime-suite:")
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "just verify-fem-frequency-domain-eigen-dispersion-window-runtime" in target


def test_managed_fem_runtime_staleness_tracks_runtime_copy_helper() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    assert (
        justfile.count("scripts/lib/runtime_bundle_copy.sh") >= 2
    ), "managed FEM runtime stale checks must track the export copy helper"
