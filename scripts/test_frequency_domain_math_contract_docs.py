import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
PLAN_ROOT = REPO_ROOT / "docs/plans/active/fd_sovler_masterplan"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def read_json(path: Path) -> dict[str, object]:
    value = json.loads(read(path))
    assert isinstance(value, dict)
    return value


def test_canonical_fem_dynamic_solver_contract_freezes_algebra_units_and_claims() -> None:
    contract_path = (
        REPO_ROOT
        / "docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md"
    )
    assert contract_path.is_file(), "canonical FEM dynamic-solver note is missing"
    contract = read(contract_path)
    normalized_contract = " ".join(contract.split())

    for required in (
        "L q = lambda B_alpha q",
        "A_omega = +i omega B_alpha - L",
        "b = T^T[-gamma0 * (m0 x delta_h)]",
        "lambda = i omega",
        "gamma_rad_s_T",
        "gamma0_rad_s_per_A_m",
        "omega_rad_s",
        "frequency_hz = Re(omega_rad_s) / (2 pi)",
        "sigma_real_per_s",
        "sigma_imag_rad_per_s",
        "left and right eigenvectors",
        "Petrov-Galerkin",
        "original_operator_residual",
        "poisson_robin, beta > 0 -> gauge_policy=none",
        "poisson_dirichlet -> gauge_policy=none",
        "pure_neumann -> gauge_policy=mean_zero_augmented",
        "phase = exp(-i k dot Delta r)",
        "T_dst q_dst = phase Q T_src q_src",
        "q_dst = phase (T_dst^T Q T_src) q_src",
        "Q = I for a pure translation",
        "gpu_operator_host_krylov",
        "gpu_device_krylov",
        "gpu_dense_modal_validation",
        "gpu_dense_k0_macrospin_modal_eigen",
        "implementation_state",
        "validation_state",
    ):
        assert required in normalized_contract

    assert "| `sigma_real` |" not in contract
    assert "sigma_real=0" not in contract


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

    assert "exp(+i omega t)" in floquet
    assert "q_dst = exp(-i kF · delta_r) T_dst^T R T_src q_src" in pbc_plan
    assert "q_dst = phase * G_pair q_src" in pbc_plan
    assert "duplicate periodic node pairs are rejected" in pbc_plan
    assert "phase = exp(-i k dot Delta r)" in floquet
    assert "T_dst q_dst = phase Q T_src q_src" in floquet
    assert "q_dst = phase (T_dst^T Q T_src) q_src" in floquet
    assert "Q = I for a pure translation" in floquet
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


def test_t1_k0_production_scope_is_scalable_future_only_and_source_mapped() -> None:
    physics = read(REPO_ROOT / "docs/physics/0830-fem-poisson-airbox-modal-eigen.md")
    normalized_physics = " ".join(physics.split())
    catalog = read_json(
        PLAN_ROOT / "25_frequency_domain_readiness_scope_catalog.json"
    )
    readiness = read_json(PLAN_ROOT / "25_frequency_domain_readiness_matrix.json")
    capability = read_json(REPO_ROOT / "docs/specs/capability-matrix-v0.json")
    source_map = read_json(
        REPO_ROOT
        / "docs/physics/0830-fem-poisson-airbox-modal-eigen.source-map.json"
    )

    cpu_scope_id = "modal_cpu_k0_periodic_airbox_real_shared_domain.production"
    gpu_scope_id = "modal_gpu_k0_periodic_airbox_scalable.production"
    for token in (
        cpu_scope_id,
        gpu_scope_id,
        "materialized descriptor dimension <= 1024 is validation_only",
        "production qualification requires a measured operator_dimension > 1024",
        "matrix_free_schur_selected_spectrum",
    ):
        assert token in normalized_physics

    scopes = catalog["scopes"]
    assert isinstance(scopes, dict)
    for scope_id, device, solver_lane in (
        (cpu_scope_id, "cpu", "cpu_slepc_schur_matrix_free"),
        (gpu_scope_id, "gpu", "gpu_petsc_slepc_schur_matrix_free"),
    ):
        scope = scopes[scope_id]
        assert isinstance(scope, dict)
        assert scope["claim_kind"] == "validated_scope"
        assert scope["device"] == device
        assert scope["solver_lane"] == solver_lane
        assert scope["implementation_state"] == "source_visible"
        assert scope["validation_state"] == "unvalidated"
        assert scope["production_operator_kind"] == "matrix_free_schur_selected_spectrum"
        assert scope["materialized_validation_limit_dimension"] == 1024
        assert (
            scope["production_scalability_gate"]
            == "requires_measured_operator_dimension_gt_1024"
        )
        exact_scope = scope["exact_scope"]
        assert isinstance(exact_scope, dict)
        assert exact_scope == {
            "backend": "fem",
            "device": device,
            "precision": "double",
            "wavevector": "exact_k0",
            "periodic_axes": ["x", "y"],
            "open_axes": ["z"],
            "domain_mesh": {
                "kind": "shared_magnetic_airbox",
                "fe_order": 1,
                "element_types": ["tet4", "prism6"],
            },
            "demag_model": "periodic_airbox_k0",
            "operator_form": "full_2x2",
            "operator_terms": ["exchange", "zeeman", "dynamic_demag"],
            "exchange_model": "native_mfem_weak_form_homogeneous_scalar_a_ex",
            "damping_alpha": 0.0,
            "target": "real_frequency_rotated",
            "spectrum": "finite_positive_physical_modes_in_requested_window",
            "required_artifacts": [
                "spectrum.v2",
                "solver_diagnostics_with_eps_phi",
                "complex_delta_m",
            ],
            "excluded_interactions": ["anisotropy", "dmi"],
            "fallback_policy": "strict_no_fallback",
        }

    cells = readiness["cells"]
    assert isinstance(cells, list)
    cells_by_id = {
        cell["cell_id"]: cell
        for cell in cells
        if isinstance(cell, dict) and isinstance(cell.get("cell_id"), str)
    }
    for cell_id, scope_id in (
        ("modal_cpu_k0_periodic_airbox_real_shared_domain", cpu_scope_id),
        ("modal_gpu_k0_periodic_airbox_scalable", gpu_scope_id),
    ):
        cell = cells_by_id[cell_id]
        assert cell["implementation_state"] == "source_visible"
        assert cell["validation_state"] == "unvalidated"
        assert cell["validated_scope"] is None
        assert cell["executable_scope"] is None
        future_binding = cell["future_production_scope"]
        assert isinstance(future_binding, dict)
        assert future_binding["scope_id"] == scope_id

    features = capability["features"]
    assert isinstance(features, list)
    modal_capability = next(
        feature
        for feature in features
        if isinstance(feature, dict)
        and feature.get("id") == "fem_modal_interior_window_eigensolve"
    )
    assert modal_capability["implementation_state"] == "source_visible"
    assert modal_capability["validation_state"] == "unvalidated"
    assert modal_capability["validated_workloads"] == []

    sources = source_map["sources"]
    assert isinstance(sources, list)
    source_identities = {
        (source.get("path"), source.get("symbol"))
        for source in sources
        if isinstance(source, dict)
    }
    for identity in (
        (
            "backends/fem/include/frequency_domain/modal_gpu_krylov.hpp",
            "solve_poisson_airbox_modal_eigen_gpu_petsc_slepc",
        ),
        (
            "backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp",
            "create_gpu_solver_state",
        ),
        (
            "backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp",
            "split_schur_matmult",
        ),
        ("crates/fullmag-runner/src/fem_eigen.rs", "native_solver_diagnostics_json"),
        ("crates/fullmag-runner/src/fem_eigen.rs", "write_eigen_v2_bundle"),
        (
            "crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs",
            "frequency_domain_artifact_content_digest",
        ),
        (
            "crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs",
            "eigen_mode_field_metadata",
        ),
        (
            "apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainResultInspectors.tsx",
            "EigenModeFieldResourceInspectorPanel",
        ),
        (
            "apps/control-room/src/kernel/visualization/ModeFieldOverlayIntentController.ts",
            "activate",
        ),
    ):
        assert identity in source_identities
        path, symbol = identity
        source_path = REPO_ROOT / path
        assert source_path.is_file(), f"missing source-map path: {path}"
        assert symbol in read(source_path), f"missing source-map symbol: {path} + {symbol}"

    sources_by_id = {
        source["id"]: source
        for source in sources
        if isinstance(source, dict) and isinstance(source.get("id"), str)
    }
    assert sources_by_id["source-gpu-schur-action"]["entrypoint"] == "apply_schur"
    assert (
        sources_by_id["source-api-eigen-diagnostics"]["handler"]
        == "get_frequency_domain_eigen_diagnostics_v2"
    )
    assert (
        sources_by_id["source-api-mode-field-meta"]["handler"]
        == "get_frequency_domain_eigen_mode_field_meta"
    )
    assert (
        sources_by_id["source-mode-field-overlay"]["controller"]
        == "class ModeFieldOverlayIntentController"
    )
    for source_id, field_name in (
        ("source-gpu-schur-action", "entrypoint"),
        ("source-api-eigen-diagnostics", "handler"),
        ("source-api-mode-field-meta", "handler"),
        ("source-mode-field-overlay", "controller"),
    ):
        source = sources_by_id[source_id]
        assert source[field_name] in read(REPO_ROOT / source["path"])
