from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_cpu_modal_adapter_uses_real_frequency_rotated_pencil_and_signed_shift():
    source = (
        REPO_ROOT
        / "backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp"
    ).read_text(encoding="utf-8")
    assert "create_real_frequency_rotated_pencil" in source
    assert "R(iG) = [[0, -G], [G, 0]]" in source
    assert "STSetShift(spectral_transform" in source
    assert "rotated_mode[static_cast<std::size_t>(size + component)]" in source
    assert "EPSSetOperators(eps, rotated_stiffness, rotated_gyrotropic)" in source
    assert "target_shift = request.phase_convention" in source
    assert "EPSSetTarget(eps, static_cast<PetscScalar>(target_shift))" in source
    assert "!std::isfinite(scalar_imaginary)" in source
    assert "EPSSetOperators(eps, stiffness, gyrotropic)" not in source


def test_cpu_modal_diagnostics_name_the_rotated_real_split_form():
    source = (
        REPO_ROOT
        / "backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp"
    ).read_text(encoding="utf-8")
    assert "real_frequency_rotated_gyrotropic_sparse_csr" in source


def test_dispersion_path_rejects_reference_oracle_before_execution():
    path_source = (
        REPO_ROOT / "crates/fullmag-runner/src/fem/eigen_path.rs"
    ).read_text(encoding="utf-8")
    guards_source = (
        REPO_ROOT / "crates/fullmag-runner/src/fem/eigen_path_guards.rs"
    ).read_text(encoding="utf-8")

    assert "reject_reference_solver_for_dispersion_validation(plan)?;" in path_source
    assert "plan.dispersion_validation.is_some()" in guards_source
    assert "k0_kittel_synthetic_demag_factor_enabled(plan)" in guards_source
    assert "analytic_or_synthetic_reference_solver_cannot_provide_dispersion_frequencies" in guards_source
    assert "validate_kalinikos_parameters(" in guards_source
    assert "requires finite positive film thickness" in guards_source
