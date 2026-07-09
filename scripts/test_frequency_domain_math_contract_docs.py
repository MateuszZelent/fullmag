from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
PLAN_ROOT = REPO_ROOT / "docs/plans/active/fd_sovler_masterplan"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_modal_gyrotropic_mapping_contract_is_explicit() -> None:
    plan = read(PLAN_ROOT / "02_physics_contract.md")

    assert "m(r,t) = m0(r) + delta_m(r) exp(+i omega t)" in plan
    assert "exp_plus_i_omega_t" in plan

    physics = read(REPO_ROOT / "docs/physics/0700-frequency-domain-linearized-llg.md")
    artifacts = read(REPO_ROOT / "docs/specs/frequency-domain-artifacts-v2.md")

    assert "B = -G" in physics
    assert "K phi = lambda (-G) phi" in physics
    assert "lambda = i omega" in physics
    assert 'gyrotropic_form = "pencil_B=-G=[[0,M],[-M,0]]"' in artifacts


def test_dynamic_demag_and_response_observables_use_si_contract() -> None:
    physics = read(REPO_ROOT / "docs/physics/0700-frequency-domain-linearized-llg.md")
    floquet = read(REPO_ROOT / "docs/physics/0828-fem-frequency-domain-floquet-demag.md")
    poisson = read(REPO_ROOT / "docs/physics/0830-fem-poisson-airbox-modal-eigen.md")

    assert "delta_H_demag = -grad(delta_phi)" in floquet
    assert "delta_H_demag = -grad(delta_phi)." in poisson
    assert "div(-grad(delta_phi)) = -div(delta_M)" in floquet
    assert "delta_M = Ms * delta_m" in physics
    assert "chi = delta_M / h_drive" in physics
    assert "p_abs = - 0.5 * mu0 * Ms * omega * Im(conj(h_drive) dot delta_m)" in physics
    assert "omega_complex = omega_r + i Gamma" in physics
    assert "Gamma > 0" in physics


def test_floquet_tangent_frame_transport_and_identity_rejection_are_documented() -> None:
    pbc_plan = read(PLAN_ROOT / "04_mesh_periodic_floquet_airbox.md")
    floquet = read(REPO_ROOT / "docs/physics/0828-fem-frequency-domain-floquet-demag.md")

    assert "q_dst = exp(-i kF · delta_r) T_dst^T R T_src q_src" in pbc_plan
    assert "q_dst = phase * G_pair q_src" in pbc_plan
    assert "duplicate periodic node pairs are rejected" in pbc_plan
    assert "T_dst q_dst = phase * T_src q_src" in floquet
    assert "q_dst = phase * (T_dst^T T_src) q_src" in floquet
    assert "The scalar-potential constraint is phase-only" in floquet
    assert "must reject these requests with explicit capability diagnostics" in floquet


def test_modal_dispersion_artifact_contract_names_tracking_and_mode_handoff() -> None:
    artifacts = read(REPO_ROOT / "docs/specs/frequency-domain-artifacts-v2.md")

    assert "`tracking_score_source`" in artifacts
    assert "`modal_overlap_available`" in artifacts
    assert "`modal_overlap_unavailable_reason`" in artifacts
    assert "`mode_field_id` and `mode_field_resource_key`" in artifacts
    assert (
        "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,"
        "label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,"
        "analytic_frequency_hz,relative_error,validation_geometry,"
        "line_width_hz,residual_norm,overlap_score,tracking_score_source,"
        "mode_field_id,mode_field_resource_key"
    ) in artifacts


def test_driven_response_manifest_links_progress_resource_contract() -> None:
    artifacts = read(REPO_ROOT / "docs/specs/frequency-domain-artifacts-v2.md")

    assert "artifacts.response_progress_v1_path" in artifacts
    assert "resources.response_progress_resource_key" in artifacts
    assert '"response/progress.v1.json"' in artifacts
    assert (
        '"/v2/sessions/current/analysis/frequency-domain/response/progress.v1"'
        in artifacts
    )
    assert "Completed driven-response manifests" in artifacts


def test_poisson_airbox_modal_docs_demote_synthetic_provenance_and_fix_signs() -> None:
    physics = read(REPO_ROOT / "docs/physics/0700-frequency-domain-linearized-llg.md")
    poisson = read(REPO_ROOT / "docs/physics/0830-fem-poisson-airbox-modal-eigen.md")
    plan = read(
        REPO_ROOT
        / "docs/plans/active/fd_sovler_masterplan/18_poisson_airbox_eigensolve_cpu_gpu_implementation.md"
    )
    audit = read(
        REPO_ROOT
        / "docs/plans/active/fd_sovler_masterplan/19_eigensolve_frequency_driven_physics_numerics_audit.md"
    )
    capability = read(REPO_ROOT / "docs/specs/capability-matrix-v0.md")

    assert "exp(+i omega t)" in physics
    assert "lambda = i omega" in physics
    assert "absorbed_by_magnetization" in physics
    assert (
        "p_abs = - 0.5 * mu0 * Ms * omega * Im(conj(h_drive) dot delta_m)"
        in physics
    )
    assert "sgn * 0.5 * mu0 * Ms * omega" not in physics

    assert "D = Omega_m union Omega_air." in poisson
    assert "Robin and Dirichlet have no `eta` row." in poisson
    assert "Pure Neumann has a constant nullspace and alone" in poisson
    assert "uses a mean-zero gauge." in poisson

    assert "assembly_kind = synthetic_algebraic_oracle" in audit
    assert "production_periodic_airbox_claim` może mieć wartość `true` dopiero po" in audit
    assert "gauge_policy=none" in audit

    assert "assembly_kind = synthetic_algebraic_oracle" in plan
    assert "production_periodic_airbox_claim = false" in plan
    assert "production_periodic_airbox_claim = true" not in plan
    assert "gauge_policy = none" in plan

    assert "periodic_airbox_k0.production_cpu_not_validated" in capability
