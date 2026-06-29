#!/usr/bin/env python3
"""Static checks for frequency-domain managed runtime just targets."""

from __future__ import annotations

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
JUSTFILE = REPO_ROOT / "justfile"
FMR_SMOKE = REPO_ROOT / "examples" / "fem_frequency_response_smoke.py"
PERIODIC_K0_SMOKE = REPO_ROOT / "examples" / "fem_fmr_periodic_k0_smoke.py"


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
        'FULLMAG_FMR_RESPONSE_MAX_ITERATIONS="${FULLMAG_FMR_RESPONSE_MAX_ITERATIONS:-4096}"'
        in target
    )
    assert (
        'FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS="${FULLMAG_FMR_RESPONSE_RESTART_ITERATIONS:-4096}"'
        in target
    )


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
    assert "--require-periodic-airbox-cpu-demag-solved" in target
    assert "--require-frozen-magnetic-submesh" in target
    assert "--require-min-frequency-points 3" in target
    assert "--require-response-peak" in target
    assert "--require-field-payloads-for-frequency-points" in target
    assert "scripts/derive_fem_frequency_response_modes.py" in target
    assert "response/derived_modes/fmr_peak_mode.v1.json" in target
    assert "--require-derived-peak-mode" in target


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


def test_periodic_airbox_gpu_unsupported_runtime_target_is_artifact_backed() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find("verify-fem-frequency-domain-periodic-airbox-gpu-unsupported-runtime:")
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "examples/fem_frequency_response_smoke.py" in target
    assert "--require-production-gpu" in target
    assert "--require-periodic-airbox-gpu-unsupported" in target
    assert ".fullmag/reports/frequency-domain-periodic-airbox-gpu-unsupported-runtime/artifacts" in target
    assert "FULLMAG_FEM_EXECUTION=gpu" in target
    assert "FULLMAG_FMR_DEVICE=gpu" in target
    assert "FULLMAG_FMR_EQUILIBRIUM_SOURCE=provided" in target
    assert "FULLMAG_FMR_FAST_RUNTIME_MESH=1" in target
    assert "FULLMAG_FMR_MESH_ALGORITHM_3D=" in target


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
    assert "FULLMAG_FMR_MESH_ALGORITHM_3D=" in target
    assert "--require-periodic-airbox-cpu-demag-solved" in target
    assert "--require-frozen-magnetic-submesh" in target
    assert "--compare-airbox-reference" in target
    assert "scripts/prepare_fmr_frozen_magnetic_submesh.py" in target
    assert "FULLMAG_FMR_FROZEN_MAGNETIC_SUBMESH_SOURCE=" in target


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


def test_frequency_domain_runtime_suite_includes_floquet_airbox_gpu_boundary() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    target_start = justfile.find("verify-fem-frequency-domain-runtime-suite:")
    assert target_start != -1
    next_target = justfile.find("\nverify-", target_start + 1)
    target = justfile[target_start:] if next_target == -1 else justfile[target_start:next_target]

    assert "just verify-fem-frequency-domain-gpu-floquet-airbox-unsupported-runtime" in target


def test_managed_fem_runtime_staleness_tracks_runtime_copy_helper() -> None:
    justfile = JUSTFILE.read_text(encoding="utf-8")

    assert (
        justfile.count("scripts/lib/runtime_bundle_copy.sh") >= 2
    ), "managed FEM runtime stale checks must track the export copy helper"
