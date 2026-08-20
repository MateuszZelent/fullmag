#![allow(unused_imports)]

use super::eigen_capability::*;
use super::eigen_certificate::*;
use super::eigen_constants::*;
use super::eigen_digest::*;
use super::eigen_equilibrium::*;
use super::eigen_equilibrium_contract::*;
use super::eigen_execution::*;
use super::eigen_execution_resolution::*;
use super::eigen_math::*;
use super::eigen_native_result::*;
use super::eigen_native_window::*;
use super::eigen_operator::*;
use super::eigen_output::*;
use super::eigen_policy::*;
use super::eigen_progress::*;
use super::eigen_projection::*;
use super::eigen_reduction::*;
use super::eigen_shared_domain::*;
use super::eigen_shared_domain_geometry::*;
use super::eigen_solve::*;
use super::eigen_sweep::*;
use super::eigen_types::*;
use crate::eigen::assembly_scalar::AssembledScalarOperator;
use crate::native_fem;
use crate::types::{
    AuxiliaryArtifact, ExecutedRun, RunError, RunResult, RunStatus, StageFemMeshIdentity,
    StepAction, StepStats,
};
use crate::ExecutionProvenance;
use fullmag_engine::fem::{FemLlgProblem, MeshTopology};
use fullmag_engine::fem_sparse::{lobpcg_generalized_with_progress, CsrMatrix};
use fullmag_engine::periodic::constraints::PeriodicDofMap;
use fullmag_engine::{
    sub, EffectiveFieldObservables, EffectiveFieldTerms, LlgConfig, MaterialParameters,
    TimeIntegrator, Vector3, MU0,
};
use fullmag_ir::{
    EigenDampingPolicyIR, EigenNormalizationIR, EquilibriumSourceIR, FemEigenPlanIR, KSamplingIR,
    OutputIR, SpinWaveBoundaryConditionIR, SpinWaveBoundaryKindIR,
};
use nalgebra::{DMatrix, DVector, SymmetricEigen};
use num_complex::Complex64;
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

fn frozen_v2_record_fixture() -> AcceptedFemRelaxStageHandoffV2Record {
    let completion = fullmag_ir::StageCompletionIR {
        status: "completed".to_string(),
        converged: true,
        reason: Some(fullmag_ir::StageStopReason::Torque),
        metric: Some(fullmag_ir::StageMetricKind::MaxTorqueApm),
        metric_name: Some("max_torque_apm".to_string()),
        metric_value: Some(1.0),
        threshold: Some(2.0),
    };
    AcceptedFemRelaxStageHandoffV2Record {
        schema_version: ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V2.to_string(),
        source_run_id: "run-relax".to_string(),
        source_stage_id: "stage-000".to_string(),
        source_stage_kind: "flat_relax".to_string(),
        stage_fem_mesh_generation_id: format!("sha256:{}", "1".repeat(64)),
        source_mesh_topology_sha256: format!("sha256:{}", "2".repeat(64)),
        node_count: 4,
        indexing_sha256: format!("sha256:{}", "3".repeat(64)),
        part_registry_sha256: format!("sha256:{}", "4".repeat(64)),
        completion_sha256: format!("sha256:{}", "5".repeat(64)),
        completion,
        acceptance: AcceptedEquilibriumCriterion {
            criterion: "torque".to_string(),
            metric_kind: fullmag_ir::StageMetricKind::MaxTorqueApm,
            metric_value: 1.0,
            threshold: 2.0,
            unit: "A/m".to_string(),
            status: "completed".to_string(),
            converged: true,
            stop_reason: fullmag_ir::StageStopReason::Torque,
        },
        equilibrium_content_sha256: format!("sha256:{}", "6".repeat(64)),
        content_sha256: String::new(),
    }
}

#[test]
fn accepted_relax_stage_handoff_v2_hash_is_frozen_golden() {
    let record = frozen_v2_record_fixture();

    assert_eq!(
        relax_stage_handoff_v2_content_sha256(&record).unwrap(),
        "sha256:b50d79726a4593164767a289f05fb1ffa45c74b43add44324873da35fd82bc08"
    );
}

#[test]
fn accepted_relax_stage_handoff_v2_rejects_extended_payload() {
    let mut value = serde_json::to_value(frozen_v2_record_fixture()).unwrap();
    value.as_object_mut().unwrap().insert(
        "certified_fields_content_sha256".to_string(),
        serde_json::json!(format!("sha256:{}", "7".repeat(64))),
    );

    let error = serde_json::from_value::<AcceptedFemRelaxStageHandoffV2Record>(value)
        .expect_err("frozen v2 must reject fields introduced by v3");
    assert!(error.to_string().contains("unknown field"));
}

#[test]
fn accepted_relax_stage_handoff_v3_hash_uses_a_distinct_namespace_and_binds_source_signatures() {
    let baseline = AcceptedFemRelaxStageHandoffV3HashPreimage {
        schema_version: ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V3.to_string(),
        legacy_v2_content_sha256: format!("sha256:{}", "1".repeat(64)),
        acceptance_certificate_sha256: format!("sha256:{}", "2".repeat(64)),
        certified_fields_content_sha256: format!("sha256:{}", "3".repeat(64)),
        equilibrium_material_signature: format!("sha256:{}", "4".repeat(64)),
        equilibrium_static_physics_signature: format!("sha256:{}", "5".repeat(64)),
        equilibrium_boundary_signature: format!("sha256:{}", "6".repeat(64)),
    };
    let baseline_digest = relax_stage_handoff_v3_content_sha256(&baseline).unwrap();

    let mut changed = baseline.clone();
    changed.equilibrium_boundary_signature = format!("sha256:{}", "7".repeat(64));
    assert_ne!(
        baseline_digest,
        relax_stage_handoff_v3_content_sha256(&changed).unwrap()
    );
    assert_ne!(
        baseline_digest,
        relax_stage_handoff_v2_content_sha256(&frozen_v2_record_fixture()).unwrap(),
        "v2 and v3 must never share a hash namespace"
    );
}

#[test]
fn equilibrium_and_modal_identity_signatures_are_separated_by_semantics() {
    use crate::fem::equilibrium_identity::{
        EquilibriumIdentitySignaturesV1, ModalIdentitySignaturesV1,
    };

    let plan = minimal_native_modal_plan();
    let source = EquilibriumIdentitySignaturesV1::from_eigen_plan(&plan).unwrap();
    let modal = ModalIdentitySignaturesV1::from_eigen_plan(&plan).unwrap();

    let mut operator_changed = plan.clone();
    operator_changed.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    assert_eq!(
        source,
        EquilibriumIdentitySignaturesV1::from_eigen_plan(&operator_changed).unwrap(),
        "modal operator fields must not contaminate source equilibrium identity"
    );
    assert_ne!(
        modal.modal_operator_signature,
        ModalIdentitySignaturesV1::from_eigen_plan(&operator_changed)
            .unwrap()
            .modal_operator_signature
    );

    let mut dynamic_boundary_changed = plan.clone();
    dynamic_boundary_changed.spin_wave_bc =
        SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
            kind: SpinWaveBoundaryKindIR::Pinned,
            boundary_pair_id: None,
            pair_ids: Vec::new(),
            phase_convention: fullmag_ir::PhaseConventionIR::default(),
            surface_anisotropy_ks: None,
            surface_anisotropy_axis: None,
        });
    assert_eq!(
        source,
        EquilibriumIdentitySignaturesV1::from_eigen_plan(&dynamic_boundary_changed).unwrap(),
        "dynamic spin-wave BC must not contaminate source boundary identity"
    );
    assert_ne!(
        modal.modal_dynamic_boundary_signature,
        ModalIdentitySignaturesV1::from_eigen_plan(&dynamic_boundary_changed)
            .unwrap()
            .modal_dynamic_boundary_signature
    );
}

#[test]
fn equilibrium_identity_signatures_mutate_only_in_the_owning_source_family() {
    use crate::fem::equilibrium_identity::EquilibriumIdentitySignaturesV1;

    let plan = minimal_native_modal_plan();
    let baseline = EquilibriumIdentitySignaturesV1::from_eigen_plan(&plan).unwrap();

    let mut material_changed = plan.clone();
    material_changed.material.saturation_magnetisation += 1.0;
    let material = EquilibriumIdentitySignaturesV1::from_eigen_plan(&material_changed).unwrap();
    assert_ne!(
        baseline.equilibrium_material_signature,
        material.equilibrium_material_signature
    );
    assert_eq!(
        baseline.equilibrium_static_physics_signature,
        material.equilibrium_static_physics_signature
    );
    assert_eq!(
        baseline.equilibrium_boundary_signature,
        material.equilibrium_boundary_signature
    );

    let mut physics_changed = plan.clone();
    physics_changed.external_field = Some([1.0, 2.0, 3.0]);
    let physics = EquilibriumIdentitySignaturesV1::from_eigen_plan(&physics_changed).unwrap();
    assert_eq!(
        baseline.equilibrium_material_signature,
        physics.equilibrium_material_signature
    );
    assert_ne!(
        baseline.equilibrium_static_physics_signature,
        physics.equilibrium_static_physics_signature
    );
    assert_eq!(
        baseline.equilibrium_boundary_signature,
        physics.equilibrium_boundary_signature
    );

    let mut boundary_changed = plan;
    boundary_changed.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
        factor: 3.0,
        grading: 1.4,
        boundary_marker: 99,
        bc_kind: Some("robin".to_string()),
        robin_beta_mode: Some("dipole".to_string()),
        robin_beta_factor: Some(2.0),
        shape: Some("bbox".to_string()),
        factor_source: Some("user".to_string()),
        boundary_marker_source: Some("user_policy".to_string()),
    });
    let boundary = EquilibriumIdentitySignaturesV1::from_eigen_plan(&boundary_changed).unwrap();
    assert_eq!(
        baseline.equilibrium_material_signature,
        boundary.equilibrium_material_signature
    );
    assert_eq!(
        baseline.equilibrium_static_physics_signature,
        boundary.equilibrium_static_physics_signature
    );
    assert_ne!(
        baseline.equilibrium_boundary_signature,
        boundary.equilibrium_boundary_signature
    );
}

fn certified_fields(node_count: usize) -> crate::types::CertifiedFemEquilibriumFields {
    let zeros = vec![[0.0, 0.0, 0.0]; node_count];
    crate::types::CertifiedFemEquilibriumFields::from_fields(
        zeros.clone(),
        zeros.clone(),
        zeros.clone(),
        zeros,
        vec![0.0; node_count],
    )
    .expect("certified field fixture")
}

fn accepted_relax_completion() -> fullmag_ir::StageCompletionIR {
    fullmag_ir::StageCompletionIR {
        status: "completed".to_string(),
        converged: true,
        reason: Some(fullmag_ir::StageStopReason::Torque),
        metric: Some(fullmag_ir::StageMetricKind::MaxTorqueApm),
        metric_name: Some("max_torque_apm".to_string()),
        metric_value: Some(5.0e-5),
        threshold: Some(1.0e-4),
    }
}

fn accepted_energy_relax_completion() -> fullmag_ir::StageCompletionIR {
    fullmag_ir::StageCompletionIR {
        status: "completed".to_string(),
        converged: true,
        reason: Some(fullmag_ir::StageStopReason::Energy),
        metric: Some(fullmag_ir::StageMetricKind::TotalEnergyPlateauRangeJ),
        metric_name: Some("total_energy_plateau_range_J".to_string()),
        metric_value: Some(2.5e-19),
        threshold: Some(1.0e-18),
    }
}

fn relax_source_plan_from_eigen(plan: &FemEigenPlanIR) -> fullmag_ir::FemPlanIR {
    fullmag_ir::FemPlanIR {
        mesh_name: plan.mesh_name.clone(),
        mesh_source: plan.mesh_source.clone(),
        mesh: plan.mesh.clone(),
        object_segments: plan.object_segments.clone(),
        mesh_parts: plan.mesh_parts.clone(),
        mesh_build_report: plan.mesh_build_report.clone(),
        domain_mesh_mode: plan.domain_mesh_mode,
        domain_frame: plan.domain_frame.clone(),
        fe_order: plan.fe_order,
        hmax: plan.hmax,
        initial_magnetization: plan.equilibrium_magnetization.clone(),
        material: plan.material.clone(),
        anisotropy_axis_field: None,
        ms_element_field: None,
        a_element_field: None,
        region_materials: Vec::new(),
        enable_exchange: plan.enable_exchange,
        enable_demag: plan.enable_demag,
        external_field: plan.external_field,
        antenna_zeeman_masks: Vec::new(),
        field_drives: Vec::new(),
        field_drive_geometry_masks: Vec::new(),
        time_stage: Default::default(),
        current_modules: Vec::new(),
        spin_transport_plans: Vec::new(),
        gyromagnetic_ratio: plan.gyromagnetic_ratio,
        precision: plan.precision,
        exchange_bc: plan.exchange_bc,
        integrator: Some(fullmag_ir::IntegratorChoice::Heun),
        fixed_timestep: Some(1.0e-13),
        adaptive_timestep: None,
        field_refresh: None,
        relaxation: None,
        demag_realization: plan.demag_realization.clone(),
        air_box_config: plan.air_box_config.clone(),
        interfacial_dmi: plan.interfacial_dmi,
        dmi_interface_normal: plan.dmi_interface_normal,
        bulk_dmi: plan.bulk_dmi,
        dind_field: None,
        dbulk_field: None,
        temperature: None,
        current_density: None,
        stt_degree: None,
        stt_beta: None,
        stt_spin_polarization: None,
        stt_lambda: None,
        stt_epsilon_prime: None,
        stt_thickness: None,
        stt_fixed_layer_position: None,
        spin_torque_contract: None,
        has_oersted_cylinder: false,
        oersted_current: None,
        oersted_radius: None,
        oersted_center: None,
        oersted_axis: None,
        oersted_field_xyz: None,
        oersted_time_dep_kind: 0,
        oersted_time_dep_freq: 0.0,
        oersted_time_dep_phase: 0.0,
        oersted_time_dep_offset: 0.0,
        oersted_time_dep_t_on: 0.0,
        oersted_time_dep_t_off: 0.0,
        magnetoelastic: None,
        mechanics: None,
        demag_solver_policy: None,
        thermal_seed_config: None,
        oersted_realization: None,
        gpu_device_index: None,
        mfem_device_string: None,
        use_consistent_mass: None,
    }
}

fn relax_handoff_from_completion(
    plan: &FemEigenPlanIR,
    completion: &fullmag_ir::StageCompletionIR,
) -> Result<AcceptedFemRelaxStageHandoff, RunError> {
    let source_plan = relax_source_plan_from_eigen(plan);
    AcceptedFemRelaxStageHandoff::from_completed_relax(
        "run-relax",
        "stage-000",
        "flat_relax",
        true,
        &source_plan,
        &crate::types::FemMeshPayload::from(plan),
        completion,
        plan.equilibrium_magnetization.clone(),
        certified_fields(plan.mesh.nodes.len()),
    )
}

#[test]
fn accepted_relax_stage_handoff_v2_preserves_torque_and_energy_certificates() {
    let plan = minimal_native_modal_plan();
    let torque_completion = accepted_relax_completion();
    let torque_handoff = relax_handoff_from_completion(&plan, &torque_completion)
        .expect("torque completion should create a typed handoff");
    assert_eq!(torque_handoff.acceptance_json()["criterion"], "torque");
    assert_eq!(
        torque_handoff.acceptance_json()["metric_kind"],
        "max_torque_apm"
    );
    assert_eq!(torque_handoff.acceptance_json()["unit"], "A/m");

    let energy_completion = accepted_energy_relax_completion();
    let energy_handoff = relax_handoff_from_completion(&plan, &energy_completion)
        .expect("energy completion should create a typed handoff");
    assert_eq!(energy_handoff.acceptance_json()["criterion"], "energy");
    assert_eq!(
        energy_handoff.acceptance_json()["metric_kind"],
        "total_energy_plateau_range_j"
    );
    assert_eq!(energy_handoff.acceptance_json()["unit"], "J");
    assert_eq!(
        energy_handoff.legacy_v2_provenance_json()["schema_version"],
        "AcceptedFemRelaxStageHandoff.v2"
    );
    assert_eq!(
        energy_handoff.legacy_v2_provenance_json()["completion"],
        serde_json::to_value(&energy_completion).unwrap()
    );
    assert_eq!(
        energy_handoff.legacy_v2_provenance_json()["acceptance"],
        energy_handoff.acceptance_json()
    );
    assert!(
        energy_handoff
            .legacy_v2_provenance_json()
            .get("certified_fields_content_sha256")
            .is_none(),
        "frozen v2 provenance must not publish v3 fields"
    );
    serde_json::from_value::<AcceptedFemRelaxStageHandoffV2Record>(
        energy_handoff.legacy_v2_provenance_json(),
    )
    .expect("emitted v2 provenance must round-trip through the frozen schema");

    let node_count = plan.mesh.nodes.len();
    let changed_certified_fields = crate::types::CertifiedFemEquilibriumFields::from_fields(
        vec![[1.0, 0.0, 0.0]; node_count],
        vec![[0.0, 1.0, 0.0]; node_count],
        vec![[0.0, 0.0, 1.0]; node_count],
        vec![[1.0, 1.0, 1.0]; node_count],
        vec![2.0; node_count],
    )
    .unwrap();
    let source_plan = relax_source_plan_from_eigen(&plan);
    let same_v2_with_v3_only_state = AcceptedFemRelaxStageHandoff::from_completed_relax(
        "run-relax",
        "stage-000",
        "flat_relax",
        true,
        &source_plan,
        &crate::types::FemMeshPayload::from(&plan),
        &energy_completion,
        plan.equilibrium_magnetization.clone(),
        changed_certified_fields,
    )
    .unwrap();
    assert_eq!(
        energy_handoff.legacy_v2_content_sha256,
        same_v2_with_v3_only_state.legacy_v2_content_sha256,
        "v3-only certified fields must not mutate the frozen v2 hash preimage"
    );
    assert_ne!(
        energy_handoff.content_sha256(),
        same_v2_with_v3_only_state.content_sha256(),
        "v3 must bind the certified static fields digest"
    );

    let mut completion_snapshot_drift = energy_completion;
    completion_snapshot_drift.metric_name = Some("energy_plateau_range_j".to_string());
    let drifted_handoff = relax_handoff_from_completion(&plan, &completion_snapshot_drift)
        .expect("a valid completion snapshot should create a typed handoff");
    assert_eq!(
        drifted_handoff.acceptance_json(),
        energy_handoff.acceptance_json()
    );
    assert_ne!(
        drifted_handoff.content_sha256(),
        energy_handoff.content_sha256(),
        "the v2 digest must include the full completion snapshot"
    );
}

#[test]
fn accepted_relax_stage_handoff_v3_round_trips_and_rejects_unknown_fields() {
    let plan = minimal_native_modal_plan();
    let handoff = relax_handoff_from_completion(&plan, &accepted_relax_completion()).unwrap();
    let value = handoff.provenance_json();

    let record = serde_json::from_value::<AcceptedFemRelaxStageHandoffV3Record>(value.clone())
        .expect("emitted v3 provenance must round-trip through the typed schema");
    assert_eq!(record, handoff.v3_record());
    assert_eq!(record.schema_version, ACCEPTED_FEM_RELAX_STAGE_HANDOFF_V3);
    assert_eq!(
        record.certified_fields_content_sha256,
        record.certified_fields.content_sha256
    );

    let mut extended = value;
    extended
        .as_object_mut()
        .unwrap()
        .insert("unexpected_tail".to_string(), serde_json::json!(true));
    let error = serde_json::from_value::<AcceptedFemRelaxStageHandoffV3Record>(extended)
        .expect_err("v3 must reject unknown fields");
    assert!(error.to_string().contains("unknown field"));
}

#[test]
fn accepted_relax_stage_handoff_allows_zero_m0_on_air_nodes() {
    let mut plan = minimal_native_modal_plan();
    add_minimal_shared_domain_periodic_airbox(&mut plan);
    let topology = MeshTopology::from_ir(&plan.mesh).expect("fixture topology must be valid");
    let air_nodes = topology
        .magnetic_node_volumes
        .iter()
        .enumerate()
        .filter_map(|(node, volume)| (*volume <= 0.0).then_some(node))
        .collect::<Vec<_>>();
    assert!(!air_nodes.is_empty(), "fixture must include air-only nodes");

    let mut equilibrium = vec![[1.0, 0.0, 0.0]; plan.mesh.nodes.len()];
    for node in air_nodes {
        equilibrium[node] = [0.0, 0.0, 0.0];
    }
    plan.equilibrium_magnetization = equilibrium.clone();
    let source_plan = relax_source_plan_from_eigen(&plan);
    let source_mesh = crate::types::FemMeshPayload::from(&plan);
    let handoff = AcceptedFemRelaxStageHandoff::from_completed_relax(
        "run-relax",
        "stage-000",
        "flat_relax",
        true,
        &source_plan,
        &source_mesh,
        &accepted_relax_completion(),
        equilibrium,
        certified_fields(source_mesh.nodes.len()),
    )
    .expect("air-only nodes may carry zero equilibrium magnetization");
    handoff
        .validate_target_plan(&plan)
        .expect("the exact relaxed target must accept the certified handoff");

    let magnetic_node = topology
        .magnetic_node_volumes
        .iter()
        .position(|volume| *volume > 0.0)
        .expect("fixture must include a magnetic node");
    plan.equilibrium_magnetization[magnetic_node] = [0.0, 0.0, 0.0];
    let error = handoff
        .validate_target_plan(&plan)
        .expect_err("a magnetic node still requires a unit m0 norm");
    assert!(error.message.contains("m0_norm_mismatch"));
}

#[test]
fn accepted_relax_stage_handoff_rejects_source_identity_mutations_before_materialization() {
    let mut plan = minimal_native_modal_plan();
    let handoff = relax_handoff_from_completion(&plan, &accepted_relax_completion()).unwrap();

    plan.material.saturation_magnetisation *= 1.01;
    let error = prepare_single_k_stage_continuation(&plan, &handoff).unwrap_err();
    assert!(error.message.contains("material_signature_mismatch"));

    let mut plan = minimal_native_modal_plan();
    plan.external_field = Some([1.0, 0.0, 0.0]);
    let error = prepare_single_k_stage_continuation(&plan, &handoff).unwrap_err();
    assert!(error.message.contains("static_physics_signature_mismatch"));

    let mut plan = minimal_native_modal_plan();
    plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
        factor: 2.0,
        grading: 1.0,
        boundary_marker: 99,
        bc_kind: None,
        robin_beta_mode: None,
        robin_beta_factor: None,
        shape: None,
        factor_source: None,
        boundary_marker_source: None,
    });
    let error = prepare_single_k_stage_continuation(&plan, &handoff).unwrap_err();
    assert!(error.message.contains("boundary_signature_mismatch"));

    let mut modal_only = minimal_native_modal_plan();
    modal_only.spin_wave_bc =
        fullmag_ir::SpinWaveBoundaryConditionIR::Legacy(fullmag_ir::SpinWaveBoundaryKindIR::Pinned);
    prepare_single_k_stage_continuation(&modal_only, &handoff)
        .expect("modal-only dynamic BC must not impersonate or invalidate source identity");
}

#[test]
fn accepted_relax_stage_handoff_rejects_certified_field_and_m0_mutations() {
    let plan = minimal_native_modal_plan();
    let handoff = relax_handoff_from_completion(&plan, &accepted_relax_completion()).unwrap();

    let mut digest_drift = handoff.clone();
    digest_drift.certified_fields.h_ex_a_per_m[0][0] = 1.0;
    let error = prepare_single_k_stage_continuation(&plan, &digest_drift).unwrap_err();
    assert!(error.message.contains("certified_fields_invalid"));

    let mut component_drift = handoff.clone();
    component_drift.certified_fields.h_ex_a_per_m[0][0] = 1.0;
    component_drift.certified_fields.h_eff_a_per_m[0][0] = 1.0;
    component_drift.certified_fields.content_sha256 =
        crate::types::certified_equilibrium_fields_sha256(&component_drift.certified_fields);
    let error = prepare_single_k_stage_continuation(&plan, &component_drift).unwrap_err();
    assert!(error.message.contains("content_sha256_mismatch"));

    let mut phi_drift = handoff.clone();
    phi_drift.certified_fields.phi_a[0] = 1.0;
    phi_drift.certified_fields.content_sha256 =
        crate::types::certified_equilibrium_fields_sha256(&phi_drift.certified_fields);
    let error = prepare_single_k_stage_continuation(&plan, &phi_drift).unwrap_err();
    assert!(error.message.contains("content_sha256_mismatch"));

    let mut decomposition_drift = handoff.clone();
    decomposition_drift.certified_fields.h_eff_a_per_m[0][0] = 1.0;
    decomposition_drift.certified_fields.content_sha256 =
        crate::types::certified_equilibrium_fields_sha256(&decomposition_drift.certified_fields);
    let error = prepare_single_k_stage_continuation(&plan, &decomposition_drift).unwrap_err();
    assert!(error.message.contains("decomposition_mismatch"));

    let mut non_unit_source = relax_source_plan_from_eigen(&plan);
    non_unit_source.initial_magnetization[0] = [0.5, 0.0, 0.0];
    let error = AcceptedFemRelaxStageHandoff::from_completed_relax(
        "run-relax",
        "stage-000",
        "flat_relax",
        true,
        &non_unit_source,
        &crate::types::FemMeshPayload::from(&non_unit_source),
        &accepted_relax_completion(),
        non_unit_source.initial_magnetization.clone(),
        certified_fields(non_unit_source.mesh.nodes.len()),
    )
    .unwrap_err();
    assert!(error.message.contains("m0_norm_mismatch"));
}

#[test]
fn accepted_relax_stage_handoff_revalidates_schema_completion_and_all_hash_layers() {
    let plan = minimal_native_modal_plan();
    let handoff = relax_handoff_from_completion(&plan, &accepted_relax_completion()).unwrap();

    let mutations: Vec<(&str, Box<dyn Fn(&mut AcceptedFemRelaxStageHandoff)>, &str)> = vec![
        (
            "schema",
            Box::new(|handoff| handoff.schema_version = "unexpected".to_string()),
            "schema_version_mismatch",
        ),
        (
            "completion snapshot",
            Box::new(|handoff| handoff.completion.metric_value = Some(4.0e-5)),
            "acceptance_certificate_mismatch",
        ),
        (
            "completion digest",
            Box::new(|handoff| handoff.completion_sha256 = format!("sha256:{}", "0".repeat(64))),
            "completion_sha256_mismatch",
        ),
        (
            "acceptance digest",
            Box::new(|handoff| {
                handoff.acceptance_certificate_sha256 = format!("sha256:{}", "0".repeat(64))
            }),
            "acceptance_certificate_sha256_mismatch",
        ),
        (
            "legacy v2 digest",
            Box::new(|handoff| {
                handoff.legacy_v2_content_sha256 = format!("sha256:{}", "0".repeat(64))
            }),
            "v2_content_sha256_mismatch",
        ),
        (
            "v3 content digest",
            Box::new(|handoff| handoff.content_sha256 = format!("sha256:{}", "0".repeat(64))),
            "content_sha256_mismatch",
        ),
    ];

    for (name, mutate, expected) in mutations {
        let mut drift = handoff.clone();
        mutate(&mut drift);
        let error = prepare_single_k_stage_continuation(&plan, &drift)
            .expect_err("integrity mutation must fail closed");
        assert!(
            error.message.contains(expected),
            "{name} returned unexpected error: {}",
            error.message
        );
    }
}

#[test]
fn accepted_relax_stage_handoff_rejects_nonconvergent_and_incoherent_completions() {
    let plan = minimal_native_modal_plan();
    let rejected = [
        fullmag_ir::StageCompletionIR {
            status: "completed".to_string(),
            converged: false,
            reason: Some(fullmag_ir::StageStopReason::MaxSteps),
            metric: Some(fullmag_ir::StageMetricKind::Steps),
            metric_name: Some("steps".to_string()),
            metric_value: Some(50_000.0),
            threshold: Some(50_000.0),
        },
        fullmag_ir::StageCompletionIR {
            status: "cancelled".to_string(),
            converged: false,
            reason: Some(fullmag_ir::StageStopReason::UserCancelled),
            metric: None,
            metric_name: None,
            metric_value: None,
            threshold: None,
        },
        fullmag_ir::StageCompletionIR {
            reason: Some(fullmag_ir::StageStopReason::Torque),
            metric: Some(fullmag_ir::StageMetricKind::TotalEnergyPlateauRangeJ),
            ..accepted_energy_relax_completion()
        },
    ];

    for completion in rejected {
        let error = relax_handoff_from_completion(&plan, &completion)
            .expect_err("nonconvergent or incoherent completion must fail closed");
        assert!(error.message.contains("completion_not_accepted"));
    }
}

#[test]
fn operator_m0_uses_a_deterministic_unit_extension_on_air_nodes() {
    let plan = minimal_native_modal_plan();
    let mut topology = MeshTopology::from_ir(&plan.mesh).unwrap();
    let air_node = topology.n_nodes - 1;
    topology.magnetic_node_volumes[air_node] = 0.0;
    let mut equilibrium = vec![[1.0, 0.0, 0.0]; topology.n_nodes];
    equilibrium[air_node] = [0.0, 0.0, 0.0];

    let extended = extend_equilibrium_m0_to_air_nodes(&topology, &equilibrium);

    assert_eq!(extended[..air_node], equilibrium[..air_node]);
    assert_eq!(extended[air_node], [0.0, 0.0, 1.0]);
}

#[test]
fn relaxed_initial_state_without_handoff_fails_before_materialization() {
    let mut plan = minimal_native_modal_plan();
    plan.equilibrium = EquilibriumSourceIR::RelaxedInitialState;
    // A missing topology makes any attempt to materialize/assemble visible:
    // the certification gate must win before progress or mesh access.
    plan.mesh.nodes.clear();
    plan.mesh.cells = fullmag_ir::FemConnectivityIR::empty();
    plan.equilibrium_magnetization.clear();
    let mut progress_events = 0usize;
    let mut progress = |_event: FemEigenProgress| {
        progress_events += 1;
        StepAction::Continue
    };

    let error = execute_fem_eigen_inner(
        &plan,
        &[],
        false,
        false,
        Some(&mut progress),
        0,
        None,
        None,
        None,
        None,
    )
    .expect_err("uncertified relaxed_initial_state must fail closed");

    assert!(error
        .message
        .contains("accepted relaxation handoff is required"));
    assert_eq!(progress_events, 0, "failure must precede materialization");
}

#[test]
fn provided_equilibrium_without_certificate_fails_before_materialization() {
    let mut plan = minimal_native_modal_plan();
    plan.equilibrium = EquilibriumSourceIR::Provided;
    plan.mesh.nodes.clear();
    plan.mesh.cells = fullmag_ir::FemConnectivityIR::empty();
    plan.equilibrium_magnetization.clear();
    let mut progress_events = 0usize;
    let mut progress = |_event: FemEigenProgress| {
        progress_events += 1;
        StepAction::Continue
    };

    let error = execute_fem_eigen_inner(
        &plan,
        &[],
        false,
        false,
        Some(&mut progress),
        0,
        None,
        None,
        None,
        None,
    )
    .expect_err("uncertified provided equilibrium must fail closed");

    assert!(error.message.contains("uncertified_provided_equilibrium"));
    assert_eq!(progress_events, 0, "failure must precede materialization");
}

#[test]
fn gpu_kittel_provided_equilibrium_without_certificate_fails_before_materialization() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.operator.include_demag = false;
    plan.enable_demag = false;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.k_sampling = Some(KSamplingIR::Single {
        k_vector: [0.0, 0.0, 0.0],
    });
    plan.equilibrium = EquilibriumSourceIR::Provided;
    plan.mesh.nodes.clear();
    plan.mesh.cells = fullmag_ir::FemConnectivityIR::empty();
    plan.equilibrium_magnetization.clear();

    let error = execute_gpu_fem_eigen(&plan, &[], None)
        .expect_err("GPU Kittel must reject uncertified provided equilibrium");

    assert!(error.message.contains("uncertified_provided_equilibrium"));
}

#[test]
fn raw_provided_fixture_requires_explicit_validation_only_adapter() {
    let mut plan = minimal_native_modal_plan();
    plan.equilibrium = EquilibriumSourceIR::Provided;

    let handoff = validation_only_raw_provided_fixture_handoff(&plan)
        .expect("test adapter should build a validation-only typed handoff");

    validate_eigen_equilibrium_certificate(&plan, Some(&handoff), None)
        .expect("explicit validation-only handoff should satisfy the test boundary");
    assert!(handoff.content_sha256().starts_with("sha256:"));
}

#[test]
fn validation_only_raw_provided_adapter_rejects_non_provided_source() {
    let mut plan = minimal_native_modal_plan();
    plan.equilibrium = EquilibriumSourceIR::RelaxedInitialState;

    let error = validation_only_raw_provided_fixture_handoff(&plan)
        .expect_err("test adapter must not certify a production equilibrium source");

    assert_eq!(
        error.message,
        "validation_only_raw_provided_requires_provided_equilibrium"
    );
}

#[test]
fn accepted_relax_stage_handoff_prepares_single_k_without_second_relaxation() {
    let mut plan = minimal_native_modal_plan();
    plan.equilibrium = EquilibriumSourceIR::RelaxedInitialState;
    plan.k_sampling = Some(KSamplingIR::Single {
        k_vector: [0.0, 0.0, 0.0],
    });
    let accepted_m0 = vec![[0.0, 1.0, 0.0]; plan.mesh.nodes.len()];
    plan.equilibrium_magnetization = accepted_m0.clone();
    let source_mesh = crate::types::FemMeshPayload::from(&plan);
    let source_plan = relax_source_plan_from_eigen(&plan);
    let handoff = AcceptedFemRelaxStageHandoff::from_completed_relax(
        "run-relax",
        "stage-000",
        "flat_relax",
        true,
        &source_plan,
        &source_mesh,
        &accepted_relax_completion(),
        accepted_m0.clone(),
        certified_fields(source_mesh.nodes.len()),
    )
    .expect("accepted relax completion should create a typed handoff");

    let prepared = prepare_single_k_stage_continuation(&plan, &handoff)
        .expect("same-mesh single-k target should accept the handoff");
    let (_problem, consumed_m0, relaxation_steps, _observables, _source) =
        materialize_equilibrium(&prepared, &prepared.equilibrium_magnetization, None)
            .expect("provided equilibrium should materialize without relaxation");

    assert_eq!(prepared.equilibrium, EquilibriumSourceIR::Provided);
    assert_eq!(consumed_m0, accepted_m0);
    assert_eq!(relaxation_steps, 0);
}

#[test]
fn accepted_relax_stage_handoff_preserves_exact_equilibrium_after_state_normalization() {
    let mut plan = minimal_native_modal_plan();
    plan.equilibrium = EquilibriumSourceIR::RelaxedInitialState;
    plan.k_sampling = Some(KSamplingIR::Single {
        k_vector: [0.0, 0.0, 0.0],
    });
    let scale = 1.0 + 5.0e-9;
    let accepted_m0 = vec![[0.6 * scale, 0.8 * scale, 0.0]; plan.mesh.nodes.len()];
    plan.equilibrium_magnetization = accepted_m0.clone();
    let source_mesh = crate::types::FemMeshPayload::from(&plan);
    let source_plan = relax_source_plan_from_eigen(&plan);
    let handoff = AcceptedFemRelaxStageHandoff::from_completed_relax(
        "run-relax",
        "stage-000",
        "flat_relax",
        true,
        &source_plan,
        &source_mesh,
        &accepted_relax_completion(),
        accepted_m0.clone(),
        certified_fields(source_mesh.nodes.len()),
    )
    .expect("accepted relax completion should create a typed handoff");

    let prepared = prepare_single_k_stage_continuation(&plan, &handoff)
        .expect("same-mesh single-k target should accept the handoff");
    let (_problem, consumed_m0, _steps, _observables, _source) = materialize_equilibrium(
        &prepared,
        &prepared.equilibrium_magnetization,
        Some(&handoff),
    )
    .expect("provided continuation equilibrium should materialize without relaxation");

    assert_eq!(consumed_m0, accepted_m0);
}

#[test]
fn gpu_stage_handoff_rejects_plan_outside_native_shared_domain_lane_before_progress() {
    let mut plan = minimal_native_modal_plan();
    add_minimal_shared_domain_periodic_airbox(&mut plan);
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.operator.include_demag = true;
    plan.enable_demag = true;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.target = fullmag_ir::EigenTargetIR::Nearest {
        frequency_hz: 2.0e9,
    };
    plan.count = 33;
    let handoff = relax_handoff_from_completion(&plan, &accepted_relax_completion())
        .expect("accepted completion should create a typed handoff");
    let mut progress_event_count = 0usize;
    let mut progress = |_event: FemEigenProgress| {
        progress_event_count += 1;
        StepAction::Stop
    };

    let error = execute_gpu_fem_eigen_with_progress_and_stage_handoff(
        &plan,
        &[],
        Some(&mut progress),
        &handoff,
    )
    .expect_err("an unsupported prepared GPU plan must fail before solver execution");

    assert_eq!(
        error.message,
        "relax_to_eigen_handoff_requires_shared_domain_modal_execution"
    );
    assert_eq!(progress_event_count, 0);
}

#[test]
fn equilibrium_artifact_v7_writer_preserves_stage_handoff_certificate() {
    let mut plan = minimal_native_modal_plan();
    add_minimal_shared_domain_periodic_airbox(&mut plan);
    plan.equilibrium = EquilibriumSourceIR::Provided;
    let completion = accepted_relax_completion();
    let handoff = relax_handoff_from_completion(&plan, &completion)
        .expect("accepted completion should create a certified handoff");
    let topology = MeshTopology::from_ir(&plan.mesh).unwrap();
    let material = MaterialParameters::new(
        plan.material.saturation_magnetisation,
        plan.material.exchange_stiffness,
        plan.material.damping,
    )
    .unwrap();
    let dynamics = LlgConfig::new(plan.gyromagnetic_ratio, TimeIntegrator::RK23).unwrap();
    let problem = FemLlgProblem::with_terms(
        topology.clone(),
        material,
        dynamics,
        EffectiveFieldTerms {
            exchange: plan.enable_exchange,
            external_field: plan.external_field,
            ..EffectiveFieldTerms::default()
        },
    );
    let state = problem
        .new_state(handoff.equilibrium_magnetization.clone())
        .unwrap();
    let observables = problem.observe(&state).unwrap();

    let linearization = build_shared_domain_linearization_state(
        &plan,
        &topology,
        &problem,
        None,
        Some(&handoff),
        &handoff.equilibrium_magnetization,
        &observables,
    )
    .unwrap();

    assert_eq!(
        linearization.equilibrium_artifact["acceptance_certificate"],
        serde_json::json!({
            "criterion": "torque",
            "metric_kind": "max_torque_apm",
            "metric_value": completion.metric_value.unwrap(),
            "threshold": completion.threshold.unwrap(),
            "unit": "A/m",
            "status": "completed",
            "converged": true,
            "stop_reason": "torque",
            "completion_sha256": handoff.completion_sha256,
        })
    );
}

#[test]
fn accepted_relax_stage_handoff_is_fail_closed_for_completion_mesh_and_m0_drift() {
    let mut plan = minimal_native_modal_plan();
    plan.equilibrium = EquilibriumSourceIR::RelaxedInitialState;
    plan.k_sampling = Some(KSamplingIR::Single {
        k_vector: [0.0, 0.0, 0.0],
    });
    let accepted_m0 = plan.equilibrium_magnetization.clone();
    let source_mesh = crate::types::FemMeshPayload::from(&plan);
    let source_plan = relax_source_plan_from_eigen(&plan);

    let error = AcceptedFemRelaxStageHandoff::from_completed_relax(
        "run-relax",
        "stage-000",
        "flat_run",
        false,
        &source_plan,
        &source_mesh,
        &accepted_relax_completion(),
        accepted_m0.clone(),
        certified_fields(source_mesh.nodes.len()),
    )
    .expect_err("a non-relaxation source stage must not create a handoff");
    assert!(error.message.contains("invalid_source_stage"));

    let mut rejected_completion = accepted_relax_completion();
    rejected_completion.converged = false;
    let error = AcceptedFemRelaxStageHandoff::from_completed_relax(
        "run-relax",
        "stage-000",
        "flat_relax",
        true,
        &source_plan,
        &source_mesh,
        &rejected_completion,
        accepted_m0.clone(),
        certified_fields(source_mesh.nodes.len()),
    )
    .expect_err("unaccepted completion must not create a handoff");
    assert!(error.message.contains("completion_not_accepted"));

    let handoff = AcceptedFemRelaxStageHandoff::from_completed_relax(
        "run-relax",
        "stage-000",
        "flat_relax",
        true,
        &source_plan,
        &source_mesh,
        &accepted_relax_completion(),
        accepted_m0.clone(),
        certified_fields(source_mesh.nodes.len()),
    )
    .expect("accepted completion should create a handoff");

    let mut topology_drift = plan.clone();
    topology_drift.mesh.set_tet4_cells(vec![[0, 2, 1, 3]]);
    let error = prepare_single_k_stage_continuation(&topology_drift, &handoff)
        .expect_err("same node count with changed indexing must fail");
    assert!(error.message.contains("mesh_identity_mismatch"));

    let mut m0_drift = plan.clone();
    m0_drift.equilibrium_magnetization[0] = [0.0, 0.0, 1.0];
    let error = prepare_single_k_stage_continuation(&m0_drift, &handoff)
        .expect_err("changed equilibrium content must fail");
    assert!(error.message.contains("equilibrium_content_mismatch"));
}

#[test]
fn accepted_relax_stage_handoff_binds_summary_and_mode_provenance() {
    let mut plan = minimal_native_modal_plan();
    plan.equilibrium = EquilibriumSourceIR::RelaxedInitialState;
    plan.k_sampling = Some(KSamplingIR::Single {
        k_vector: [0.0, 0.0, 0.0],
    });
    let source_mesh = crate::types::FemMeshPayload::from(&plan);
    let source_plan = relax_source_plan_from_eigen(&plan);
    let handoff = AcceptedFemRelaxStageHandoff::from_completed_relax(
        "run-relax",
        "stage-000",
        "flat_relax",
        true,
        &source_plan,
        &source_mesh,
        &accepted_relax_completion(),
        plan.equilibrium_magnetization.clone(),
        certified_fields(source_mesh.nodes.len()),
    )
    .expect("accepted completion should create a handoff");
    let mut run = ExecutedRun {
        result: RunResult {
            status: RunStatus::Completed,
            steps: Vec::new(),
            final_magnetization: plan.equilibrium_magnetization.clone(),
            completion: None,
        },
        initial_magnetization: plan.equilibrium_magnetization.clone(),
        field_snapshots: Vec::new(),
        field_snapshot_count: 0,
        auxiliary_artifacts: vec![
            json_artifact(
                "eigen/metadata/eigen_summary.json",
                &serde_json::json!({
                    "equilibrium_source": "provided",
                    "relaxation_steps": 0,
                    "solver_diagnostics": {},
                    "modes": [{"index": 0}],
                }),
            )
            .unwrap(),
            json_artifact(
                "eigen/modes/mode_0000.json",
                &serde_json::json!({"index": 0}),
            )
            .unwrap(),
            json_artifact(
                "eigen/diagnostics/solver.v1.json",
                &serde_json::json!({"solver_adapter": "test"}),
            )
            .unwrap(),
            json_artifact(
                "eigen/spectrum.v3.json",
                &serde_json::json!({
                    "schema_version": "eigen_spectrum.v3",
                    "samples": [{
                        "sample_index": 0,
                        "modes": [{"raw_mode_index": 0}]
                    }]
                }),
            )
            .unwrap(),
        ],
        provenance: ExecutionProvenance::default(),
    };

    bind_stage_continuation_artifacts(&mut run, &handoff)
        .expect("accepted handoff should bind artifacts");
    let summary: serde_json::Value =
        serde_json::from_slice(&run.auxiliary_artifacts[0].bytes).unwrap();
    let mode: serde_json::Value =
        serde_json::from_slice(&run.auxiliary_artifacts[1].bytes).unwrap();
    let solver: serde_json::Value =
        serde_json::from_slice(&run.auxiliary_artifacts[2].bytes).unwrap();
    let spectrum_v3: serde_json::Value =
        serde_json::from_slice(&run.auxiliary_artifacts[3].bytes).unwrap();

    assert_eq!(
        summary["equilibrium_source"]["handoff"],
        "stage_continuation"
    );
    assert_eq!(
        summary["equilibrium_source"]["content_sha256"],
        handoff.content_sha256()
    );
    assert_eq!(
        mode["relax_to_eigen_handoff_sha256"],
        handoff.content_sha256()
    );
    assert_eq!(
        mode["source_mesh_topology_sha256"],
        handoff.source_mesh_topology_sha256
    );
    assert_eq!(
        summary["solver_diagnostics"]["source_mesh_topology_sha256"],
        handoff.source_mesh_topology_sha256
    );
    assert_eq!(
        summary["modes"][0]["relax_to_eigen_handoff_sha256"],
        handoff.content_sha256()
    );
    assert_eq!(
        summary["modes"][0]["source_mesh_topology_sha256"],
        handoff.source_mesh_topology_sha256
    );
    assert_eq!(
        solver["relax_to_eigen_handoff_sha256"],
        handoff.content_sha256()
    );
    assert_eq!(
        solver["source_mesh_topology_sha256"],
        handoff.source_mesh_topology_sha256
    );
    assert_eq!(
        spectrum_v3["samples"][0]["modes"][0]["relax_to_eigen_handoff_sha256"],
        handoff.content_sha256()
    );
    assert_eq!(
        spectrum_v3["samples"][0]["modes"][0]["source_mesh_topology_sha256"],
        handoff.source_mesh_topology_sha256
    );
    assert_eq!(
        summary["solver_diagnostics"]["relax_to_eigen_handoff"]["source_run_id"],
        "run-relax"
    );
    assert_eq!(
        summary["solver_diagnostics"]["relax_to_eigen_handoff"]["source_stage_id"],
        "stage-000"
    );
    assert_eq!(
        summary["solver_diagnostics"]["relax_to_eigen_handoff"]["source_stage_kind"],
        "flat_relax"
    );
}

#[test]
fn accepted_relax_handoff_round_trips_through_summary_provenance() {
    let plan = minimal_native_modal_plan();
    let equilibrium = plan.equilibrium_magnetization.clone();
    let expected = AcceptedFemEigenEquilibriumHandoff::from_accepted_linearization(
        &plan,
        equilibrium.clone(),
        format!("sha256:{}", "a".repeat(64)),
        format!("sha256:{}", "b".repeat(64)),
    )
    .expect("accepted linearization should produce a handoff");
    let diagnostics = serde_json::json!({
        "source_mesh_topology_sha256": expected.source_mesh_topology_sha256(),
        "relax_to_eigen_handoff_sha256": expected.content_sha256(),
        "equilibrium_artifact_sha256": expected.equilibrium_artifact_sha256,
        "linearization_state_sha256": expected.linearization_state_sha256,
        "relax_to_eigen_handoff": expected.provenance_json(),
    });
    let run = ExecutedRun {
        result: RunResult {
            status: RunStatus::Completed,
            steps: Vec::new(),
            final_magnetization: equilibrium,
            completion: None,
        },
        initial_magnetization: Vec::new(),
        field_snapshots: Vec::new(),
        field_snapshot_count: 0,
        auxiliary_artifacts: vec![json_artifact(
            "eigen/metadata/eigen_summary.json",
            &serde_json::json!({"solver_diagnostics": diagnostics}),
        )
        .expect("summary fixture should serialize")],
        provenance: ExecutionProvenance::default(),
    };

    let restored = accepted_relax_to_eigen_handoff_from_run(&plan, &run)
        .expect("summary provenance should restore the exact handoff");

    assert_eq!(restored.content_sha256(), expected.content_sha256());
    assert_eq!(
        restored.source_mesh_topology_sha256(),
        expected.source_mesh_topology_sha256()
    );
}

#[test]
fn native_modal_progress_json_maps_to_runtime_progress() {
    let event = native_modal_progress_event(
            r#"{"schema_version":"fem_frequency_domain_progress.v1","solver_phase":"solving_shift_invert","candidate_mode_count":4,"accepted_mode_count":2,"outer_iteration":7,"max_outer_iterations":300,"linear_iteration":11,"current_residual_relative_l2":1.25e-9}"#,
            NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND,
            12,
            24,
            3,
        )
        .expect("valid native progress should map");
    assert_eq!(event.phase, "solving_native_shift_invert");
    assert_eq!(event.candidate_modes, 4);
    assert_eq!(event.computed_modes, 2);
    assert_eq!(event.iteration, Some(7));
    assert_eq!(event.max_iterations, Some(300));
    assert_eq!(event.residual, Some(1.25e-9));
    assert!(native_modal_progress_event("not-json", "solver", 1, 2, 1).is_none());
}

#[test]
fn bias_field_sweep_relax_each_always_starts_from_plan_initial_state() {
    let mut plan = minimal_native_modal_plan();
    plan.equilibrium = EquilibriumSourceIR::Provided;
    let base_initial = plan.equilibrium_magnetization.clone();
    let previous = vec![[0.0, 1.0, 0.0]; base_initial.len()];
    let sample = bias_field_sample(
        0,
        [20_000.0, 0.0, 0.0],
        fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::RelaxEach,
        fullmag_ir::BiasFieldSweepContinuationSeedIR::InitialState,
    );

    let prepared = prepare_bias_field_sample_plan(&plan, &sample, &base_initial, Some(&previous))
        .expect("relax_each sample should prepare without a native solve");

    assert_eq!(prepared.external_field, Some(sample.field_a_per_m));
    assert_eq!(
        prepared.equilibrium,
        EquilibriumSourceIR::RelaxedInitialState
    );
    assert_eq!(prepared.equilibrium_magnetization, base_initial);
}

#[test]
fn bias_field_sweep_continuation_uses_previous_accepted_equilibrium() {
    let plan = minimal_native_modal_plan();
    let base_initial = plan.equilibrium_magnetization.clone();
    let previous = vec![[0.0, 1.0, 0.0]; base_initial.len()];
    let sample = bias_field_sample(
        1,
        [40_000.0, 0.0, 0.0],
        fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::Continuation,
        fullmag_ir::BiasFieldSweepContinuationSeedIR::PreviousAcceptedEquilibrium,
    );

    let prepared = prepare_bias_field_sample_plan(&plan, &sample, &base_initial, Some(&previous))
        .expect("continuation sample should prepare without a native solve");

    assert_eq!(
        prepared.equilibrium,
        EquilibriumSourceIR::RelaxedInitialState
    );
    assert_eq!(prepared.equilibrium_magnetization, previous);
}

#[test]
fn bias_field_sweep_continuation_initial_state_bootstraps_from_plan_initial() {
    let plan = minimal_native_modal_plan();
    let base_initial = plan.equilibrium_magnetization.clone();
    let sample = bias_field_sample(
        0,
        [20_000.0, 0.0, 0.0],
        fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::Continuation,
        fullmag_ir::BiasFieldSweepContinuationSeedIR::InitialState,
    );

    let prepared = prepare_bias_field_sample_plan(&plan, &sample, &base_initial, None)
        .expect("initial-state continuation should prepare without a native solve");

    assert_eq!(
        prepared.equilibrium,
        EquilibriumSourceIR::RelaxedInitialState
    );
    assert_eq!(prepared.equilibrium_magnetization, base_initial);
}

#[test]
fn bias_field_sweep_accepts_finite_zero_field_sample() {
    let mut plan = minimal_native_modal_plan();
    plan.bias_field_samples = vec![bias_field_sample(
        0,
        [0.0, 0.0, 0.0],
        fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::RelaxEach,
        fullmag_ir::BiasFieldSweepContinuationSeedIR::InitialState,
    )];

    let samples = validate_bias_field_samples(&plan)
        .expect("a finite zero bias field is a legal physical sample");
    assert_eq!(samples[0].field_a_per_m, [0.0, 0.0, 0.0]);
}

#[test]
fn bias_field_sweep_rejects_relax_each_with_previous_seed() {
    let mut plan = minimal_native_modal_plan();
    plan.bias_field_samples = vec![bias_field_sample(
        0,
        [20_000.0, 0.0, 0.0],
        fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::RelaxEach,
        fullmag_ir::BiasFieldSweepContinuationSeedIR::PreviousAcceptedEquilibrium,
    )];

    let error = validate_bias_field_samples(&plan)
        .expect_err("relax_each must not silently ignore continuation seed");
    assert!(error.message.contains("use initial_state"));
}

#[test]
fn bias_field_sweep_stops_before_merge_on_cancelled_sample() {
    assert!(!bias_field_sample_is_complete(RunStatus::Cancelled));
    assert!(!bias_field_sample_is_complete(RunStatus::Paused));
    assert!(bias_field_sample_is_complete(RunStatus::Completed));
}

#[test]
fn cancelled_bias_field_sample_preserves_interrupted_partial_artifact() {
    let run = ExecutedRun {
        result: RunResult {
            status: RunStatus::Cancelled,
            steps: Vec::new(),
            final_magnetization: Vec::new(),
            completion: None,
        },
        initial_magnetization: Vec::new(),
        field_snapshots: Vec::new(),
        field_snapshot_count: 0,
        auxiliary_artifacts: vec![
            json_artifact(
                "eigen/partial.v1.json",
                &serde_json::json!({
                    "schema_version": "fem_k0_modal_partial.v1",
                    "complete": false,
                }),
            )
            .expect("partial artifact fixture should serialize"),
            json_artifact(
                "eigen/spectrum.v2.json",
                &serde_json::json!({
                    "schema_version": "eigen_spectrum.v2",
                    "complete": true,
                    "samples": []
                }),
            )
            .expect("spectrum artifact fixture should serialize"),
        ],
        provenance: ExecutionProvenance::default(),
    };

    let preserved = preserve_interrupted_bias_field_sweep_run(
        run,
        3,
        1,
        1,
        fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::Continuation,
        fullmag_ir::BiasFieldSweepContinuationSeedIR::PreviousAcceptedEquilibrium,
    )
    .expect("cancelled sample should preserve a partial artifact");
    let partial = preserved
        .auxiliary_artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "eigen/partial.v1.json")
        .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())
        .expect("preserved partial artifact should be valid JSON");
    assert_eq!(partial["status"], "interrupted");
    assert_eq!(partial["complete"], false);
    assert_eq!(partial["field_sweep"]["requested_sample_count"], 3);
    assert_eq!(partial["field_sweep"]["completed_sample_count"], 1);
    assert_eq!(partial["field_sweep"]["interrupted_sample_index"], 1);
    assert_eq!(
        partial["field_sweep"]["continuation_seed"],
        "previous_accepted_equilibrium"
    );
    let spectrum = preserved
        .auxiliary_artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "eigen/spectrum.v2.json")
        .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())
        .expect("spectrum artifact should remain valid JSON");
    assert_eq!(spectrum["status"], "interrupted");
    assert_eq!(spectrum["complete"], false);
    assert_eq!(preserved.result.status, RunStatus::Cancelled);
}

fn bias_field_sweep_run_fixture(sample_index: usize, status: RunStatus) -> ExecutedRun {
    let mode_field_id = format!("analysis:eigen:sample-{sample_index:04}:mode-0000");
    let mode_field_resource_key =
        format!("/v2/sessions/current/data/fields/{mode_field_id}/samples/vector");
    let spectrum_mode = serde_json::json!({
        "raw_mode_index": 0,
        "frequency_hz": 1.0e9 + sample_index as f64,
        "angular_frequency_rad_per_s": std::f64::consts::TAU * (1.0e9 + sample_index as f64),
        "mode_field_id": mode_field_id,
        "mode_field_resource_key": mode_field_resource_key,
        "residual_relative_l2": 1.0e-10,
        "equilibrium_artifact_sha256": format!("sha256:{}", "a".repeat(64)),
        "linearization_state_sha256": format!("sha256:{}", "b".repeat(64)),
        "operator_input_signature_sha256": format!("sha256:{}", "c".repeat(64)),
    });
    let spectrum = serde_json::json!({
        "schema_version": "eigen_spectrum.v2",
        "samples": [{
            "sample_index": sample_index,
            "external_field_a_per_m": [20_000.0 * (sample_index + 1) as f64, 0.0, 0.0],
            "mesh_id": "mesh:test",
            "topology_revision": "mesh-rev:test",
            "modes": [spectrum_mode.clone()],
        }],
    });
    let branches = serde_json::json!({
        "schema_version": "eigen_branches.v2",
        "branches": [{
            "branch_id": 0,
            "points": [{"sample_index": sample_index, "raw_mode_index": 0}],
        }],
    });
    let diagnostics = serde_json::json!({
        "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
        "study_product": "modal_eigen",
        "requested_execution": {"backend": "fem", "device": "cpu"},
        "resolved_execution": {"backend": "fem", "device": "cpu"},
    });
    let summary = serde_json::json!({
        "solver_kind": "k0_poisson_airbox_cpu_schur_slepc",
        "modes": [spectrum_mode],
        "solver_diagnostics": diagnostics,
    });
    let manifest = serde_json::json!({
        "schema_version": "frequency_domain_manifest.v1",
        "artifacts": {},
        "resources": {},
    });
    let mut auxiliary_artifacts = vec![
        json_artifact("eigen/spectrum.v2.json", &spectrum).unwrap(),
        json_artifact("eigen/branches.v2.json", &branches).unwrap(),
        json_artifact("eigen/metadata/eigen_summary.json", &summary).unwrap(),
        json_artifact("eigen/diagnostics/solver.v1.json", &diagnostics).unwrap(),
        json_artifact("frequency_domain/manifest.v1.json", &manifest).unwrap(),
        json_artifact(
            format!("eigen/modes/sample_{sample_index:04}/mode_0000.json"),
            &serde_json::json!({
                "mode_field_id": mode_field_id,
                "mode_field_resource_key": mode_field_resource_key,
            }),
        )
        .unwrap(),
        AuxiliaryArtifact {
            relative_path: format!(
                "eigen/mode_fields.zarr/sample_{sample_index:04}/mode_0000/real.bin"
            ),
            bytes: vec![0, 1, 2, 3],
        },
    ];
    if status != RunStatus::Completed {
        auxiliary_artifacts.push(
            json_artifact(
                "eigen/partial.v1.json",
                &serde_json::json!({"status": run_status_label(status), "complete": false}),
            )
            .unwrap(),
        );
    }
    ExecutedRun {
        result: RunResult {
            status,
            steps: Vec::new(),
            final_magnetization: Vec::new(),
            completion: None,
        },
        initial_magnetization: Vec::new(),
        field_snapshots: Vec::new(),
        field_snapshot_count: 0,
        auxiliary_artifacts,
        provenance: ExecutionProvenance::default(),
    }
}

#[test]
fn terminal_bias_field_sweep_publishes_only_completed_prefix_with_exact_lifecycle() {
    for (terminal_status, artifact_status, stop_reason, interrupted) in [
        (
            RunStatus::Cancelled,
            "interrupted",
            "cancel_requested",
            true,
        ),
        (RunStatus::Paused, "interrupted", "pause_requested", true),
        (RunStatus::Failed, "corrupt", "failed", false),
    ] {
        let merged = merge_bias_field_sweep_runs(
            vec![
                bias_field_sweep_run_fixture(0, RunStatus::Completed),
                bias_field_sweep_run_fixture(1, terminal_status),
            ],
            3,
            fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::Continuation,
            fullmag_ir::BiasFieldSweepContinuationSeedIR::PreviousAcceptedEquilibrium,
        )
        .expect("terminal sweep should publish a typed partial result");
        let typed = merged
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "eigen/field_sweep.v1.json")
            .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())
            .expect("typed field sweep must always be discoverable");
        assert_eq!(typed["status"], artifact_status);
        assert_eq!(typed["complete"], false);
        assert_eq!(typed["interrupted"], interrupted);
        assert_eq!(typed["stop_reason"], stop_reason);
        assert_eq!(typed["requested_sample_count"], 3);
        assert_eq!(typed["completed_sample_count"], 1);
        assert_eq!(typed["samples"].as_array().map(Vec::len), Some(1));
        assert_eq!(typed["samples"][0]["status"], "complete");
        assert_eq!(typed["samples"][0]["modes"][0]["status"], "complete");
        assert!(typed.get("promotion").is_none());
        assert!(typed.get("promotion_binding").is_none());
        assert!(!merged.auxiliary_artifacts.iter().any(|artifact| {
            artifact
                .relative_path
                .starts_with("eigen/modes/sample_0001/")
        }));
        assert!(!merged.auxiliary_artifacts.iter().any(|artifact| {
            artifact
                .relative_path
                .starts_with("eigen/mode_fields.zarr/sample_0001/")
        }));
        let manifest = merged
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "frequency_domain/manifest.v1.json")
            .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())
            .expect("typed field sweep discovery manifest must be valid");
        assert_eq!(
            manifest["artifacts"]["field_sweep_v1_path"],
            "eigen/field_sweep.v1.json"
        );
        assert_eq!(
            manifest["resources"]["field_sweep_resource_key"],
            "/v2/sessions/current/analysis/frequency-domain/eigen/field-sweep.v1"
        );
    }
}

#[test]
fn failed_bias_field_sweep_finalizer_publishes_completed_prefix_without_terminal_sample() {
    let failure_reason =
        "native FEM modal_eigen production CPU solve failed: injected sample failure";
    let finalized = finalize_failed_bias_field_sweep(
        vec![bias_field_sweep_run_fixture(0, RunStatus::Completed)],
        3,
        fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::Continuation,
        fullmag_ir::BiasFieldSweepContinuationSeedIR::PreviousAcceptedEquilibrium,
        RunError {
            message: failure_reason.to_string(),
        },
    )
    .expect("a failed later sample should publish the completed prefix");

    assert_eq!(finalized.result.status, RunStatus::Failed);
    let completion = finalized
        .result
        .completion
        .as_ref()
        .expect("failed sweep must expose terminal stage lifecycle");
    assert_eq!(completion.status, "failed");
    assert_eq!(
        completion.reason,
        Some(fullmag_ir::StageStopReason::BackendError)
    );
    let typed = finalized
        .auxiliary_artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "eigen/field_sweep.v1.json")
        .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())
        .expect("failed sweep must publish a typed field-sweep artifact");
    assert_eq!(typed["status"], "corrupt");
    assert_eq!(typed["complete"], false);
    assert_eq!(typed["interrupted"], false);
    assert_eq!(typed["stop_reason"], failure_reason);
    assert_eq!(typed["requested_sample_count"], 3);
    assert_eq!(typed["completed_sample_count"], 1);
    assert_eq!(typed["samples"].as_array().map(Vec::len), Some(1));
    assert_eq!(typed["samples"][0]["sample_index"], 0);
    assert!(!finalized.auxiliary_artifacts.iter().any(|artifact| {
        artifact
            .relative_path
            .starts_with("eigen/modes/sample_0001/")
    }));

    let diagnostics = finalized
        .auxiliary_artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "eigen/diagnostics/solver.v1.json")
        .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())
        .expect("failed sweep must preserve typed solver diagnostics");
    assert_eq!(diagnostics["status"], "corrupt");
    assert_eq!(diagnostics["field_sweep"]["run_status"], "failed");
    assert_eq!(diagnostics["field_sweep"]["stop_reason"], failure_reason);
}

#[test]
fn bias_field_sweep_executor_error_finalizes_completed_prefix_without_terminal_sample() {
    let mut plan = minimal_native_modal_plan();
    plan.bias_field_samples = (0..3)
        .map(|sample_index| {
            bias_field_sample(
                sample_index,
                [20_000.0 * f64::from(sample_index + 1), 0.0, 0.0],
                fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::Continuation,
                fullmag_ir::BiasFieldSweepContinuationSeedIR::PreviousAcceptedEquilibrium,
            )
        })
        .collect();
    let failure_reason =
        "native FEM modal_eigen production CPU solve failed: injected sample failure";
    let mut executor_entry_count = 0;
    let finalized =
        execute_bias_field_sweep_with_executor(&plan, |sample_plan, sample_position| {
            executor_entry_count += 1;
            assert_eq!(
                sample_plan.external_field,
                Some(plan.bias_field_samples[sample_position].field_a_per_m)
            );
            if sample_position == 0 {
                let mut completed = bias_field_sweep_run_fixture(0, RunStatus::Completed);
                completed.initial_magnetization = sample_plan.equilibrium_magnetization.clone();
                completed.result.final_magnetization =
                    sample_plan.equilibrium_magnetization.clone();
                return Ok(completed);
            }
            assert_eq!(
                sample_position, 1,
                "no sample may execute after the failure"
            );
            Err(RunError {
                message: failure_reason.to_string(),
            })
        })
        .expect("a later executor error should publish the completed prefix");

    assert_eq!(executor_entry_count, 2);
    assert_eq!(finalized.result.status, RunStatus::Failed);
    let completion = finalized
        .result
        .completion
        .as_ref()
        .expect("failed sweep must expose terminal stage lifecycle");
    assert_eq!(completion.status, "failed");
    assert_eq!(
        completion.reason,
        Some(fullmag_ir::StageStopReason::BackendError)
    );

    let typed = finalized
        .auxiliary_artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "eigen/field_sweep.v1.json")
        .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())
        .expect("failed sweep must publish a typed field-sweep artifact");
    assert_eq!(typed["status"], "corrupt");
    assert_eq!(typed["complete"], false);
    assert_eq!(typed["interrupted"], false);
    assert_eq!(typed["stop_reason"], failure_reason);
    assert_eq!(typed["requested_sample_count"], 3);
    assert_eq!(typed["completed_sample_count"], 1);
    assert_eq!(typed["samples"].as_array().map(Vec::len), Some(1));
    assert_eq!(typed["samples"][0]["sample_index"], 0);
    assert_eq!(typed["samples"][0]["status"], "complete");
    assert_eq!(typed["samples"][0]["modes"][0]["status"], "complete");
    assert_eq!(typed["revision"], typed["content_sha256"]);
    assert_eq!(
        native_field_sweep_content_digest(&typed)
            .expect("typed field sweep self-digest must be reproducible"),
        typed["content_sha256"]
            .as_str()
            .expect("typed field sweep digest must be a string")
    );
    assert!(!finalized.auxiliary_artifacts.iter().any(|artifact| {
        artifact
            .relative_path
            .starts_with("eigen/modes/sample_0001/")
    }));
    assert!(!finalized.auxiliary_artifacts.iter().any(|artifact| {
        artifact
            .relative_path
            .starts_with("eigen/mode_fields.zarr/sample_0001/")
    }));

    let diagnostics = finalized
        .auxiliary_artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "eigen/diagnostics/solver.v1.json")
        .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())
        .expect("failed sweep must preserve typed solver diagnostics");
    assert_eq!(diagnostics["status"], "corrupt");
    assert_eq!(diagnostics["field_sweep"]["run_status"], "failed");
    assert_eq!(diagnostics["field_sweep"]["stop_reason"], failure_reason);

    let manifest = finalized
        .auxiliary_artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "frequency_domain/manifest.v1.json")
        .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())
        .expect("typed field sweep discovery manifest must be valid");
    assert_eq!(
        manifest["artifacts"]["field_sweep_v1_path"],
        "eigen/field_sweep.v1.json"
    );
    assert_eq!(
        manifest["resources"]["field_sweep_resource_key"],
        "/v2/sessions/current/analysis/frequency-domain/eigen/field-sweep.v1"
    );
}

#[test]
fn bias_field_sweep_kittel_oracle_request_fails_closed() {
    let mut plan = minimal_native_modal_plan();
    plan.bias_field_samples = vec![bias_field_sample(
        0,
        [20_000.0, 0.0, 0.0],
        fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::RelaxEach,
        fullmag_ir::BiasFieldSweepContinuationSeedIR::InitialState,
    )];
    plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
        kind: "k0_kittel_field_sweep".to_string(),
        case_id: Some("K0-3".to_string()),
        demag_kind: Some("periodic_airbox_k0".to_string()),
        model: "thin_film_in_plane".to_string(),
        field_units: "A_per_m".to_string(),
        relative_tolerance: 0.05,
        material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
            effective_magnetisation: Some(800_000.0),
        },
        samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
            sample_index: 0,
            bias_field: [20_000.0, 0.0, 0.0],
        }],
    });

    let error = validate_bias_field_sweep_oracle_contract(&plan)
        .expect_err("unimplemented Kittel postsolve must fail closed");
    assert!(error
        .message
        .contains("bias_field_sweep_kittel_postsolve_oracle_unavailable"));
}

fn bias_field_sample(
    sample_index: u32,
    field_a_per_m: [f64; 3],
    equilibrium_policy: fullmag_ir::BiasFieldSweepEquilibriumPolicyIR,
    continuation_seed: fullmag_ir::BiasFieldSweepContinuationSeedIR,
) -> fullmag_ir::FemEigenBiasFieldSamplePlanIR {
    fullmag_ir::FemEigenBiasFieldSamplePlanIR {
        sample_index,
        field_a_per_m,
        equilibrium_policy,
        continuation_seed,
        execution: fullmag_ir::FemEigenExecutionResolutionIR {
            requested_device: fullmag_ir::ExecutionDevice::Cpu,
            resolved_device: fullmag_ir::ExecutionDevice::Cpu,
            requested_precision: fullmag_ir::ExecutionPrecision::Double,
            resolved_precision: fullmag_ir::ExecutionPrecision::Double,
            requested_engine: fullmag_ir::FemEigenEngineIR::Auto,
            resolved_engine: fullmag_ir::FemEigenEngineIR::K0PoissonAirboxCpuSchurSlepc,
            fallback_used: false,
            fallback_reason: None,
            selection_reason: "test.bias_field_sweep.cpu".to_string(),
        },
    }
}

#[test]
fn validation_oracle_full_interleaved_modal_a_qq_csr_preserves_scaled_entries() {
    let block_matrix = DMatrix::from_row_slice(2, 2, &[1.0e-21, -2.0e-21, 3.0e-21, -4.0e-21]);

    let (row_offsets, columns, values) =
        validation_oracle_full_interleaved_modal_a_qq_csr(&block_matrix, &[0], 1, 1.0).unwrap();

    assert_eq!(row_offsets, vec![0, 2, 4]);
    assert_eq!(columns, vec![0, 1, 0, 1]);
    assert_eq!(values, vec![1.0e-21, -2.0e-21, 3.0e-21, -4.0e-21]);
}

#[test]
fn modal_certificate_map_binding_rejects_tampered_class_map() {
    let plan = minimal_native_modal_plan();
    let topology = MeshTopology::from_ir(&plan.mesh).expect("minimal FEM mesh is valid");
    let (scalar, scalar_count, magnetic, magnetic_count) =
        modal_shared_domain_equivalence_classes(&topology).expect("maps should build");
    let certificate = fullmag_ir::PeriodicMeshCertificateV6IR {
        schema_version: "periodic_mesh_certificate.v6".to_string(),
        certificate_status: "accepted".to_string(),
        topology_fingerprint: plan.mesh.topology_fingerprint_v6(),
        axis_pairs: Vec::new(),
        magnetic_class_count: scalar_count,
        magnetic_pair_count: 0,
        scalar_class_count: scalar_count,
        scalar_pair_count: 0,
        magnetic_equivalence_classes_sha256: "sha256:magnetic".to_string(),
        scalar_equivalence_classes_sha256: "sha256:scalar".to_string(),
        translation_residual_max_m: 0.0,
        orientation_residual_max: 0.0,
        normal_mismatch_max: 0.0,
        boundary_topology_match: true,
        fe_order_match: true,
        material_region_match: true,
        corner_edge_cycle_unique: true,
        edge_class_count: 0,
        corner_class_count: 0,
        max_commutation_residual_m: 0.0,
        m0_seam_mismatch_max: 0.0,
        h_demag0_seam_mismatch_max: 0.0,
        marker_map_fingerprint: "sha256:markers".to_string(),
        material_realization_fingerprint: "sha256:materials".to_string(),
        region_class_count: 0,
        max_material_residual: 0.0,
    };
    let (_, binding_digest) = build_modal_certificate_map_binding(
        &plan,
        &topology,
        &certificate,
        &scalar,
        scalar_count,
        &magnetic,
        magnetic_count,
    )
    .expect("accepted certificate and maps should bind");
    assert!(binding_digest.starts_with("sha256:"));

    let mut tampered_scalar = scalar.clone();
    tampered_scalar[0] = tampered_scalar[0].saturating_add(1);
    let error = build_modal_certificate_map_binding(
        &plan,
        &topology,
        &certificate,
        &tampered_scalar,
        scalar_count,
        &magnetic,
        magnetic_count,
    )
    .expect_err("a class-map mutation must fail closed before native allocation");
    assert!(error
        .message
        .contains("periodic_mesh_certificate_equivalence_map_binding_map_mismatch"));
}

fn modal_v6_xy_shared_domain_mesh() -> fullmag_ir::MeshIR {
    let magnetic_nodes = vec![
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [1.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 1.0],
        [0.0, 1.0, 1.0],
        [1.0, 1.0, 1.0],
    ];
    let mut nodes = magnetic_nodes.clone();
    nodes.extend(
        magnetic_nodes
            .iter()
            .map(|node| [node[0] + 2.0, node[1], node[2]]),
    );
    let cube_cells = vec![
        [0, 1, 3, 7],
        [0, 3, 2, 7],
        [0, 2, 6, 7],
        [0, 6, 4, 7],
        [0, 4, 5, 7],
        [0, 5, 1, 7],
    ];
    let mut cells = cube_cells.clone();
    cells.extend(
        cube_cells
            .iter()
            .map(|cell| [cell[0] + 8, cell[1] + 8, cell[2] + 8, cell[3] + 8]),
    );
    let mut periodic_node_pairs = Vec::new();
    for offset in [0_u32, 8] {
        for (node_a, node_b) in [(0, 1), (2, 3), (4, 5), (6, 7)] {
            periodic_node_pairs.push(fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: node_a + offset,
                node_b: node_b + offset,
            });
        }
        for (node_a, node_b) in [(0, 2), (1, 3), (4, 6), (5, 7)] {
            periodic_node_pairs.push(fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "y_faces".to_string(),
                node_a: node_a + offset,
                node_b: node_b + offset,
            });
        }
    }
    let boundary_faces = [
        [0, 6, 2],
        [0, 4, 6],
        [1, 3, 7],
        [1, 7, 5],
        [0, 1, 5],
        [0, 5, 4],
        [2, 7, 3],
        [2, 6, 7],
    ];
    let mut facets = boundary_faces.to_vec();
    facets.extend(boundary_faces.iter().map(|face| face.map(|node| node + 8)));
    fullmag_ir::MeshIR {
        mesh_name: "modal-v6-xy-open-z".to_string(),
        nodes,
        cells: fullmag_ir::FemConnectivityIR::from_tet4(cells),
        element_markers: vec![1; 6].into_iter().chain(vec![0; 6]).collect(),
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(facets),
        boundary_markers: vec![10, 10, 11, 11, 12, 12, 13, 13]
            .into_iter()
            .chain(vec![10, 10, 11, 11, 12, 12, 13, 13])
            .collect(),
        periodic_boundary_pairs: vec![
            fullmag_ir::MeshPeriodicBoundaryPairIR {
                pair_id: "x_faces".to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: 10,
                marker_b: 11,
                translation: Some([1.0, 0.0, 0.0]),
                tolerance: Some(1.0e-12),
                axis_hint: Some("x".to_string()),
                orientation: None,
                pairing_policy: None,
            },
            fullmag_ir::MeshPeriodicBoundaryPairIR {
                pair_id: "y_faces".to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: 12,
                marker_b: 13,
                translation: Some([0.0, 1.0, 0.0]),
                tolerance: Some(1.0e-12),
                axis_hint: Some("y".to_string()),
                orientation: None,
                pairing_policy: None,
            },
        ],
        periodic_node_pairs,
        per_domain_quality: std::collections::HashMap::new(),
    }
}

fn accepted_modal_v6_certificate(
    mesh: &fullmag_ir::MeshIR,
) -> fullmag_ir::PeriodicMeshCertificateV6IR {
    mesh.periodic_mesh_certificate_v6()
        .expect("fixture must carry authoritative v6 face evidence")
}

fn modal_v6_xy_mesh_parts() -> Vec<fullmag_ir::FemMeshPartIR> {
    vec![
        fullmag_ir::FemMeshPartIR {
            id: "part:film".to_string(),
            label: "Film".to_string(),
            role: fullmag_ir::FemMeshPartRole::MagneticObject,
            object_id: Some("film".to_string()),
            geometry_id: Some("film".to_string()),
            material_id: None,
            element_selector: fullmag_ir::FemMeshPartSelector::ElementRange { start: 0, count: 6 },
            boundary_face_selector: fullmag_ir::FemMeshPartSelector::BoundaryFaceRange {
                start: 0,
                count: 8,
            },
            node_selector: fullmag_ir::FemMeshPartSelector::NodeRange { start: 0, count: 8 },
            boundary_face_indices: Vec::new(),
            node_indices: (0..8).collect(),
            facet_global_ordinals: Vec::new(),
            bounds_min: None,
            bounds_max: None,
            parent_id: None,
        },
        fullmag_ir::FemMeshPartIR {
            id: "part:__air__".to_string(),
            label: "Airbox".to_string(),
            role: fullmag_ir::FemMeshPartRole::Air,
            object_id: None,
            geometry_id: None,
            material_id: None,
            element_selector: fullmag_ir::FemMeshPartSelector::ElementRange { start: 6, count: 6 },
            boundary_face_selector: fullmag_ir::FemMeshPartSelector::BoundaryFaceRange {
                start: 8,
                count: 8,
            },
            node_selector: fullmag_ir::FemMeshPartSelector::NodeRange { start: 8, count: 8 },
            boundary_face_indices: Vec::new(),
            node_indices: (8..16).collect(),
            facet_global_ordinals: Vec::new(),
            bounds_min: None,
            bounds_max: None,
            parent_id: None,
        },
    ]
}

fn modal_v6_multi_part_mesh_and_parts() -> (fullmag_ir::MeshIR, Vec<fullmag_ir::FemMeshPartIR>) {
    let original = modal_v6_xy_shared_domain_mesh();
    let mut nodes = original.nodes[..8].to_vec();
    nodes.extend([[0.2, 0.0, 0.0], [0.0, 0.2, 0.0], [0.0, 0.0, 0.2]]);
    nodes.extend(original.nodes[8..].iter().copied());

    let original_cells = original
        .require_tet4_elements()
        .expect("base fixture must be tet4");
    let mut cells = original_cells[..6].to_vec();
    cells.push([0, 8, 9, 10]);
    cells.extend(
        original_cells[6..]
            .iter()
            .map(|cell| cell.map(|node| node + 3)),
    );

    let original_facets = original
        .require_tri3_boundary_faces()
        .expect("base fixture facets must be tri3");
    let mut facets = original_facets[..8].to_vec();
    facets.push([0, 8, 9]);
    facets.extend(
        original_facets[8..]
            .iter()
            .map(|face| face.map(|node| node + 3)),
    );

    let mesh = fullmag_ir::MeshIR {
        mesh_name: "modal-v6-multi-part-xy-open-z".to_string(),
        nodes,
        cells: fullmag_ir::FemConnectivityIR::from_tet4(cells),
        element_markers: vec![1, 1, 1, 1, 1, 1, 2, 0, 0, 0, 0, 0, 0],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(facets),
        boundary_markers: vec![10, 10, 11, 11, 12, 12, 13, 13, 30]
            .into_iter()
            .chain([10, 10, 11, 11, 12, 12, 13, 13])
            .collect(),
        periodic_boundary_pairs: original.periodic_boundary_pairs,
        periodic_node_pairs: original
            .periodic_node_pairs
            .into_iter()
            .map(|mut pair| {
                if pair.node_a >= 8 {
                    pair.node_a += 3;
                }
                if pair.node_b >= 8 {
                    pair.node_b += 3;
                }
                pair
            })
            .collect(),
        per_domain_quality: std::collections::HashMap::new(),
    };
    let parts = vec![
        fullmag_ir::FemMeshPartIR {
            id: "part:body".to_string(),
            label: "Body".to_string(),
            role: fullmag_ir::FemMeshPartRole::MagneticObject,
            object_id: Some("body".to_string()),
            geometry_id: Some("body".to_string()),
            material_id: None,
            element_selector: fullmag_ir::FemMeshPartSelector::ElementRange { start: 0, count: 6 },
            boundary_face_selector: fullmag_ir::FemMeshPartSelector::BoundaryFaceRange {
                start: 0,
                count: 8,
            },
            node_selector: fullmag_ir::FemMeshPartSelector::NodeRange { start: 0, count: 8 },
            boundary_face_indices: Vec::new(),
            node_indices: Vec::new(),
            facet_global_ordinals: Vec::new(),
            bounds_min: None,
            bounds_max: None,
            parent_id: None,
        },
        fullmag_ir::FemMeshPartIR {
            id: "part:hole_transition_refinement".to_string(),
            label: "Hole transition refinement".to_string(),
            role: fullmag_ir::FemMeshPartRole::MagneticObject,
            object_id: Some("body".to_string()),
            geometry_id: Some("hole_transition_refinement".to_string()),
            material_id: None,
            element_selector: fullmag_ir::FemMeshPartSelector::ElementRange { start: 6, count: 1 },
            boundary_face_selector: fullmag_ir::FemMeshPartSelector::BoundaryFaceRange {
                start: 8,
                count: 1,
            },
            node_selector: fullmag_ir::FemMeshPartSelector::NodeRange { start: 8, count: 3 },
            boundary_face_indices: Vec::new(),
            node_indices: vec![0, 8, 9, 10],
            facet_global_ordinals: Vec::new(),
            bounds_min: None,
            bounds_max: None,
            parent_id: None,
        },
        fullmag_ir::FemMeshPartIR {
            id: "part:__air__".to_string(),
            label: "Airbox".to_string(),
            role: fullmag_ir::FemMeshPartRole::Air,
            object_id: None,
            geometry_id: None,
            material_id: None,
            element_selector: fullmag_ir::FemMeshPartSelector::ElementRange { start: 7, count: 6 },
            boundary_face_selector: fullmag_ir::FemMeshPartSelector::BoundaryFaceRange {
                start: 9,
                count: 8,
            },
            node_selector: fullmag_ir::FemMeshPartSelector::NodeRange {
                start: 11,
                count: 8,
            },
            boundary_face_indices: Vec::new(),
            node_indices: (11..19).collect(),
            facet_global_ordinals: Vec::new(),
            bounds_min: None,
            bounds_max: None,
            parent_id: None,
        },
    ];
    (mesh, parts)
}

fn assert_modal_v6_part_registry_error(
    mesh: &fullmag_ir::MeshIR,
    parts: &[fullmag_ir::FemMeshPartIR],
    reason: &str,
) {
    let error = modal_v6_part_identities(mesh, parts, 11)
        .expect_err("mutated part registry must fail closed");
    assert!(
        error.message.contains(reason),
        "expected {reason:?}, got {:?}",
        error.message
    );
}

#[test]
fn modal_v6_multi_part_same_object_registry_is_accepted_and_ordered() {
    let (mesh, parts) = modal_v6_multi_part_mesh_and_parts();
    let certificate = accepted_modal_v6_certificate(&mesh);
    let (magnetic, air) = modal_v6_part_identities(&mesh, &parts, 11)
        .expect("ordered segments of one physical object must be accepted");
    assert_eq!(
            magnetic,
            "magnetic:object-id=4:body;part-count=2;part[0]-id=9:part:body;part[0]-marker=1;part[1]-id=31:part:hole_transition_refinement;part[1]-marker=2"
        );
    assert_eq!(air, "airbox:part-id=12:part:__air__");

    let topology = MeshTopology::from_ir(&mesh).expect("fixture topology must be valid");
    let (scalar, scalar_count, magnetic, magnetic_count) =
        modal_shared_domain_equivalence_classes(&topology).expect("maps must build");
    let binding = build_owned_modal_certificate_v6_binding(
        &mesh,
        &certificate,
        &parts,
        None,
        None,
        &scalar,
        scalar_count,
        &magnetic,
        magnetic_count,
        "robin",
        99,
        2.0,
        7,
        &[20_000.0, 0.0, 0.0],
    )
    .expect("complete multi-part producer must validate");
    assert_eq!(binding.mesh_magnetic.node_count(), 11);
    assert_eq!(binding.mesh_scalar.node_count(), 19);
    assert_eq!(&binding.mesh_scalar.region_ids[..11], &[1; 11]);
    assert_eq!(&binding.mesh_scalar.region_ids[11..], &[0; 8]);
    assert_eq!(
        binding.cell_markers,
        vec![1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0],
        "the native operator marker map must encode magnetic/air roles, not geometry part ids"
    );
    binding
        .validate()
        .expect("owned producer must self-validate");
}

#[test]
fn modal_v6_multi_part_registry_rejects_foreign_order_duplicate_overlap_and_gaps() {
    let (mesh, parts) = modal_v6_multi_part_mesh_and_parts();

    let mut foreign_object = parts.clone();
    foreign_object[1].object_id = Some("other".to_string());
    assert_modal_v6_part_registry_error(
        &mesh,
        &foreign_object,
        "multiple_magnetic_objects_unsupported",
    );

    let mut swapped = parts.clone();
    swapped.swap(0, 1);
    assert_modal_v6_part_registry_error(&mesh, &swapped, "magnetic_part_order_noncanonical");

    let mut duplicate_id = parts.clone();
    duplicate_id[1].id = duplicate_id[0].id.clone();
    assert_modal_v6_part_registry_error(&mesh, &duplicate_id, "mesh_part_id_duplicate");

    let mut swapped_markers = mesh.clone();
    swapped_markers.element_markers[..6].fill(2);
    swapped_markers.element_markers[6] = 1;
    assert_modal_v6_part_registry_error(
        &swapped_markers,
        &parts,
        "magnetic_marker_order_noncanonical",
    );

    let mut overlap = parts.clone();
    overlap[1].element_selector =
        fullmag_ir::FemMeshPartSelector::ElementMarkerSet { markers: vec![1] };
    assert_modal_v6_part_registry_error(&mesh, &overlap, "mesh_part_element_overlap");

    let mut missing_marker = parts.clone();
    missing_marker.remove(1);
    assert_modal_v6_part_registry_error(&mesh, &missing_marker, "magnetic_marker_uncovered");

    let mut marker_zero = parts.clone();
    marker_zero[1].element_selector =
        fullmag_ir::FemMeshPartSelector::ElementRange { start: 7, count: 6 };
    assert_modal_v6_part_registry_error(&mesh, &marker_zero, "magnetic_part_selects_air_marker");

    let mut duplicate_marker = parts;
    duplicate_marker[0].element_selector =
        fullmag_ir::FemMeshPartSelector::ElementRange { start: 0, count: 1 };
    duplicate_marker[0].node_selector =
        fullmag_ir::FemMeshPartSelector::NodeRange { start: 0, count: 1 };
    duplicate_marker[0].node_indices = vec![0, 1, 3, 7];
    duplicate_marker[1].element_selector =
        fullmag_ir::FemMeshPartSelector::ElementRange { start: 1, count: 2 };
    duplicate_marker[1].node_selector =
        fullmag_ir::FemMeshPartSelector::NodeRange { start: 1, count: 0 };
    duplicate_marker[1].node_indices = vec![0, 2, 3, 6, 7];
    assert_modal_v6_part_registry_error(&mesh, &duplicate_marker, "magnetic_marker_duplicate");
}

#[test]
fn modal_v6_part_registry_rejects_id_role_and_selector_mutations() {
    let mesh = modal_v6_xy_shared_domain_mesh();
    let parts = modal_v6_xy_mesh_parts();
    let (magnetic, air) = modal_v6_part_identities(&mesh, &parts, 8).unwrap();
    assert!(magnetic.contains("part:film"));
    assert!(air.contains("part:__air__"));

    let mut id_mutation = parts.clone();
    id_mutation[0].id = "part:renamed".to_string();
    assert!(modal_v6_part_identities(&mesh, &id_mutation, 8).is_err());

    let mut role_mutation = parts.clone();
    role_mutation[0].role = fullmag_ir::FemMeshPartRole::Air;
    assert!(modal_v6_part_identities(&mesh, &role_mutation, 8).is_err());

    let mut selector_mutation = parts;
    selector_mutation[0].node_selector =
        fullmag_ir::FemMeshPartSelector::NodeRange { start: 1, count: 7 };
    assert!(modal_v6_part_identities(&mesh, &selector_mutation, 8).is_err());
}

#[test]
fn modal_v6_owned_producer_builds_xy_edge_closure_and_keeps_z_open() {
    let mesh = modal_v6_xy_shared_domain_mesh();
    let topology = MeshTopology::from_ir(&mesh).expect("fixture topology must be valid");
    let (scalar, scalar_count, magnetic, magnetic_count) =
        modal_shared_domain_equivalence_classes(&topology).expect("maps must build");
    let certificate = accepted_modal_v6_certificate(&mesh);

    let binding = build_owned_modal_certificate_v6_binding(
        &mesh,
        &certificate,
        &modal_v6_xy_mesh_parts(),
        None,
        None,
        &scalar,
        scalar_count,
        &magnetic,
        magnetic_count,
        "robin",
        99,
        2.0,
        7,
        &[20_000.0, 0.0, 0.0],
    )
    .expect("complete x/y producer must validate");

    assert_eq!(binding.mesh_magnetic.node_count(), 8);
    assert_eq!(binding.mesh_scalar.node_count(), 16);
    assert!(binding
        .mesh_magnetic
        .closure_relations
        .iter()
        .any(|relation| relation.axis_mask == 3 && relation.kind == 2));
    assert!(binding
        .mesh_scalar
        .boundary_axis_masks
        .iter()
        .all(|mask| mask & 4 == 0));
    assert!(binding.canonical_preimage.starts_with(
        "periodic_modal_equivalence_map_binding.v1\nschema=periodic_mesh_certificate.v6\n"
    ));
    assert!(binding.canonical_preimage_sha256.starts_with("sha256:"));
    assert!(binding
        .shared_domain_map_binding_sha256
        .starts_with("sha256:"));
    binding
        .validate()
        .expect("owned producer must self-validate");
}

fn modal_v6_owned_binding_fixture() -> OwnedModalCertificateV6Binding {
    let mesh = modal_v6_xy_shared_domain_mesh();
    let topology = MeshTopology::from_ir(&mesh).expect("fixture topology must be valid");
    let (scalar, scalar_count, magnetic, magnetic_count) =
        modal_shared_domain_equivalence_classes(&topology).expect("maps must build");
    build_owned_modal_certificate_v6_binding(
        &mesh,
        &accepted_modal_v6_certificate(&mesh),
        &modal_v6_xy_mesh_parts(),
        None,
        None,
        &scalar,
        scalar_count,
        &magnetic,
        magnetic_count,
        "robin",
        99,
        2.0,
        7,
        &[20_000.0, 0.0, 0.0],
    )
    .expect("fixture binding must validate")
}

#[test]
fn modal_v6_owned_producer_rejects_missing_axis_and_interleaved_magnetic_nodes() {
    let mesh = modal_v6_xy_shared_domain_mesh();
    let topology = MeshTopology::from_ir(&mesh).expect("fixture topology must be valid");
    let (scalar, scalar_count, magnetic, magnetic_count) =
        modal_shared_domain_equivalence_classes(&topology).expect("maps must build");
    let mut certificate = accepted_modal_v6_certificate(&mesh);
    certificate
        .axis_pairs
        .retain(|axis| axis.axis.as_deref() != Some("y"));
    let axis_error = build_owned_modal_certificate_v6_binding(
        &mesh,
        &certificate,
        &modal_v6_xy_mesh_parts(),
        None,
        None,
        &scalar,
        scalar_count,
        &magnetic,
        magnetic_count,
        "robin",
        99,
        2.0,
        0,
        &[0.0, 0.0, 0.0],
    )
    .expect_err("missing accepted y-axis evidence must fail closed");
    assert!(axis_error
        .message
        .contains("accepted_certificate_missing_or_stale"));

    let mut swapped_certificate = accepted_modal_v6_certificate(&mesh);
    for evidence in &mut swapped_certificate.axis_pairs {
        evidence.axis = match evidence.axis.as_deref() {
            Some("x") => Some("y".to_string()),
            Some("y") => Some("x".to_string()),
            _ => evidence.axis.clone(),
        };
    }
    let swapped_error = build_owned_modal_certificate_v6_binding(
        &mesh,
        &swapped_certificate,
        &modal_v6_xy_mesh_parts(),
        None,
        None,
        &scalar,
        scalar_count,
        &magnetic,
        magnetic_count,
        "robin",
        99,
        2.0,
        0,
        &[0.0, 0.0, 0.0],
    )
    .expect_err("swapped x/y certificate evidence must fail closed");
    assert!(swapped_error
        .message
        .contains("accepted_certificate_missing_or_stale"));

    let mut stale_certificate = accepted_modal_v6_certificate(&mesh);
    stale_certificate.topology_fingerprint = format!("sha256:{}", "0".repeat(64));
    let stale_error = build_owned_modal_certificate_v6_binding(
        &mesh,
        &stale_certificate,
        &modal_v6_xy_mesh_parts(),
        None,
        None,
        &scalar,
        scalar_count,
        &magnetic,
        magnetic_count,
        "robin",
        99,
        2.0,
        0,
        &[0.0, 0.0, 0.0],
    )
    .expect_err("stale certificate topology fingerprint must fail closed");
    assert!(stale_error
        .message
        .contains("accepted_certificate_missing_or_stale"));

    let mut rejected_certificate = accepted_modal_v6_certificate(&mesh);
    rejected_certificate.certificate_status = "rejected".to_string();
    let rejected_error = build_owned_modal_certificate_v6_binding(
        &mesh,
        &rejected_certificate,
        &modal_v6_xy_mesh_parts(),
        None,
        None,
        &scalar,
        scalar_count,
        &magnetic,
        magnetic_count,
        "robin",
        99,
        2.0,
        0,
        &[0.0, 0.0, 0.0],
    )
    .expect_err("non-accepted certificate must fail closed");
    assert!(rejected_error
        .message
        .contains("accepted_certificate_missing_or_stale"));

    let mut interleaved = modal_v6_xy_shared_domain_mesh();
    interleaved.nodes.swap(1, 8);
    let remap = |node: u32| match node {
        1 => 8,
        8 => 1,
        value => value,
    };
    let remapped_cells = interleaved
        .require_tet4_elements()
        .unwrap()
        .iter()
        .map(|cell| cell.map(remap))
        .collect();
    interleaved.set_tet4_cells(remapped_cells);
    for pair in &mut interleaved.periodic_node_pairs {
        pair.node_a = remap(pair.node_a);
        pair.node_b = remap(pair.node_b);
    }
    let interleaved_errors = interleaved
        .periodic_mesh_certificate_v6()
        .expect_err("authoritative certificate generation must reject interleaved nodes");
    assert!(interleaved_errors
        .iter()
        .any(|error| error.contains("magnetic nodes do not form an exact leading prefix")));
}

#[test]
fn modal_v6_owned_producer_rejects_all_authoritative_certificate_evidence_mutations() {
    let mesh = modal_v6_xy_shared_domain_mesh();
    let topology = MeshTopology::from_ir(&mesh).unwrap();
    let (scalar, scalar_count, magnetic, magnetic_count) =
        modal_shared_domain_equivalence_classes(&topology).unwrap();
    let authoritative = accepted_modal_v6_certificate(&mesh);
    let assert_rejected = |label: &str, certificate| {
        let error = build_owned_modal_certificate_v6_binding(
            &mesh,
            &certificate,
            &modal_v6_xy_mesh_parts(),
            None,
            None,
            &scalar,
            scalar_count,
            &magnetic,
            magnetic_count,
            "robin",
            99,
            2.0,
            0,
            &[0.0, 0.0, 0.0],
        )
        .expect_err("mutated authoritative evidence must fail before FFI");
        assert!(
            error
                .message
                .contains("accepted_certificate_missing_or_stale"),
            "{label}: {}",
            error.message
        );
    };

    let mut mutations = Vec::<(&str, fullmag_ir::PeriodicMeshCertificateV6IR)>::new();
    macro_rules! mutate {
        ($label:literal, $mutation:expr) => {{
            let mut certificate = authoritative.clone();
            $mutation(&mut certificate);
            mutations.push(($label, certificate));
        }};
    }
    mutate!(
        "schema_version",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.schema_version.push('0')
    );
    mutate!(
        "certificate_status",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.certificate_status =
            "rejected".to_string()
    );
    mutate!(
        "topology_fingerprint",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.topology_fingerprint.push('0')
    );
    mutate!(
        "magnetic_class_count",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.magnetic_class_count += 1
    );
    mutate!(
        "magnetic_pair_count",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.magnetic_pair_count += 1
    );
    mutate!(
        "scalar_class_count",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.scalar_class_count += 1
    );
    mutate!(
        "scalar_pair_count",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.scalar_pair_count += 1
    );
    mutate!(
        "magnetic_digest",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value
            .magnetic_equivalence_classes_sha256
            .push('0')
    );
    mutate!(
        "scalar_digest",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value
            .scalar_equivalence_classes_sha256
            .push('0')
    );
    mutate!(
        "edge_class_count",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.edge_class_count += 1
    );
    mutate!(
        "corner_class_count",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.corner_class_count += 1
    );
    mutate!(
        "region_class_count",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.region_class_count += 1
    );
    mutate!(
        "translation_residual",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.translation_residual_max_m +=
            1.0
    );
    mutate!(
        "orientation_residual",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.orientation_residual_max += 1.0
    );
    mutate!(
        "normal_mismatch",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.normal_mismatch_max += 1.0
    );
    mutate!(
        "commutation_residual",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.max_commutation_residual_m +=
            1.0
    );
    mutate!(
        "material_residual",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.max_material_residual += 1.0
    );
    mutate!(
        "boundary_topology_match",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.boundary_topology_match =
            !value.boundary_topology_match
    );
    mutate!(
        "fe_order_match",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.fe_order_match =
            !value.fe_order_match
    );
    mutate!(
        "material_region_match",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.material_region_match =
            !value.material_region_match
    );
    mutate!(
        "corner_edge_cycle_unique",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.corner_edge_cycle_unique =
            !value.corner_edge_cycle_unique
    );
    mutate!(
        "m0_seam_mismatch",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.m0_seam_mismatch_max += 1.0
    );
    mutate!(
        "h_demag0_seam_mismatch",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.h_demag0_seam_mismatch_max +=
            1.0
    );
    mutate!(
        "marker_map_fingerprint",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value
            .marker_map_fingerprint
            .push('0')
    );
    mutate!(
        "material_realization_fingerprint",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value
            .material_realization_fingerprint
            .push('0')
    );
    mutate!(
        "axis_pair_id",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].pair_id.push('0')
    );
    mutate!(
        "axis_identity",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].axis =
            Some("z".to_string())
    );
    mutate!(
        "axis_node_pair_count",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0]
            .node_pair_count += 1
    );
    mutate!(
        "axis_face_pair_count",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0]
            .face_pair_count += 1
    );
    mutate!(
        "axis_translation_residual",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0]
            .translation_residual_max_m +=
            1.0
    );
    mutate!(
        "axis_orientation_residual",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0]
            .orientation_residual_max += 1.0
    );
    mutate!(
        "axis_normal_mismatch",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0]
            .normal_mismatch_max += 1.0
    );
    mutate!(
        "axis_boundary_match",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0]
            .boundary_topology_match =
            !value.axis_pairs[0].boundary_topology_match
    );
    mutate!(
        "axis_material_match",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0]
            .material_region_match =
            !value.axis_pairs[0].material_region_match
    );
    mutate!(
        "face_pair_identity",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].face_pairs[0]
            .face_a += 1
    );
    mutate!(
        "face_pair_destination",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].face_pairs[0]
            .face_b += 1
    );
    mutate!(
        "face_vertex_pair",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].face_pairs[0]
            .vertex_pairs[0][0] += 1
    );
    mutate!(
        "face_vertex_destination",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].face_pairs[0]
            .vertex_pairs[0][1] += 1
    );
    mutate!(
        "face_translation_residual",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].face_pairs[0]
            .translation_residual_max_m +=
            1.0
    );
    mutate!(
        "face_area_residual",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].face_pairs[0]
            .area_residual_m2 += 1.0
    );
    mutate!(
        "face_normal_dot",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].face_pairs[0]
            .normal_dot += 1.0
    );
    mutate!(
        "face_source_marker",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].face_pairs[0]
            .source_marker += 1
    );
    mutate!(
        "face_destination_marker",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].face_pairs[0]
            .destination_marker += 1
    );
    mutate!(
        "face_source_region",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].face_pairs[0]
            .source_element_markers[0] += 1
    );
    mutate!(
        "face_destination_region",
        |value: &mut fullmag_ir::PeriodicMeshCertificateV6IR| value.axis_pairs[0].face_pairs[0]
            .destination_element_markers[0] +=
            1
    );

    for (label, certificate) in mutations {
        assert_rejected(label, certificate);
    }
}

#[test]
fn modal_v6_owned_binding_rejects_relation_identity_and_digest_mutations() {
    let baseline = modal_v6_owned_binding_fixture();

    let mut missing_scalar_relation = baseline.clone();
    missing_scalar_relation
        .mesh_scalar
        .generator_relations
        .pop();
    assert!(missing_scalar_relation.validate().is_err());

    let mut missing_edge = baseline.clone();
    missing_edge
        .mesh_magnetic
        .closure_relations
        .retain(|relation| relation.axis_mask != 3);
    assert!(missing_edge.validate().is_err());

    let mut relation_endpoint = baseline.clone();
    relation_endpoint.mesh_magnetic.generator_relations[0].destination_node = 7;
    assert!(relation_endpoint.validate().is_err());

    let mut relation_axis = baseline.clone();
    relation_axis.mesh_magnetic.generator_relations[0].axis_mask ^= 2;
    assert!(relation_axis.validate().is_err());

    let mut relation_kind = baseline.clone();
    relation_kind.mesh_magnetic.generator_relations[0].kind += 1;
    assert!(relation_kind.validate().is_err());

    let mut part_identity = baseline.clone();
    part_identity.mesh_scalar.part_identity = "airbox:mutated".to_string();
    assert!(part_identity.validate().is_err());

    let mut marker_map = baseline.clone();
    marker_map.cell_markers[0] = 0;
    assert!(marker_map.validate().is_err());

    let mut class_id = baseline.clone();
    class_id.mesh_magnetic.expected_class_ids[0] += 1;
    assert!(class_id.validate().is_err());

    let mut class_digest = baseline.clone();
    class_digest.mesh_scalar.expected_class_digests[0].sha256 =
        format!("sha256:{}", "0".repeat(64));
    assert!(class_digest.validate().is_err());

    let mut canonical_preimage = baseline.clone();
    canonical_preimage.canonical_preimage.push('x');
    assert!(canonical_preimage.validate().is_err());

    let mut map_digest = baseline.clone();
    map_digest.shared_domain_map_binding_sha256 = format!("sha256:{}", "0".repeat(64));
    assert!(map_digest.validate().is_err());

    let mut bias_signature = baseline;
    bias_signature.bias_field_sample_signature = format!("sha256:{}", "0".repeat(64));
    assert!(bias_signature.validate().is_err());

    let mut boundary_identity = modal_v6_owned_binding_fixture();
    boundary_identity.boundary_gauge_digest = format!("sha256:{}", "0".repeat(64));
    assert!(boundary_identity.validate().is_err());
}

#[test]
fn modal_v6_cross_language_golden_matches_native_preimage_and_class_digests() {
    let relations = [(0, 1, 1), (2, 3, 1), (0, 2, 2), (1, 3, 2)]
        .into_iter()
        .map(
            |(source_node, destination_node, axis_mask)| OwnedModalCertificateV6Relation {
                source_node,
                destination_node,
                axis_mask,
                kind: 1,
            },
        )
        .collect::<Vec<_>>();
    let closure = relations
        .iter()
        .cloned()
        .chain([
            OwnedModalCertificateV6Relation {
                source_node: 0,
                destination_node: 3,
                axis_mask: 3,
                kind: 2,
            },
            OwnedModalCertificateV6Relation {
                source_node: 1,
                destination_node: 2,
                axis_mask: 3,
                kind: 2,
            },
        ])
        .collect::<Vec<_>>();
    let make_view = |view_kind, part_role, identity: &str, topology: &str, region_id| {
        let mut view = OwnedModalCertificateV6View {
            view_kind,
            part_role,
            part_identity: identity.to_string(),
            topology_fingerprint: topology.to_string(),
            region_ids: vec![region_id; 4],
            boundary_axis_masks: vec![0, 1, 2, 3],
            region_roles: vec![OwnedModalCertificateV6RegionRole {
                region_id,
                part_role,
            }],
            generator_relations: relations.clone(),
            closure_relations: closure.clone(),
            expected_class_ids: Vec::new(),
            expected_class_digests: Vec::new(),
        };
        let (ids, digests, _) = view.canonical_state().unwrap();
        view.expected_class_ids = ids;
        view.expected_class_digests = digests;
        view
    };
    let magnetic = make_view(
        1,
        1,
        "magnetic:film:v1",
        &format!("sha256:{}", "1".repeat(64)),
        7,
    );
    let scalar = make_view(
        1,
        2,
        "airbox:poisson:v1",
        &format!("sha256:{}", "2".repeat(64)),
        100,
    );
    assert_eq!(
        magnetic.expected_class_digests[0].sha256,
        "sha256:88feeb3b3663fbb296e50c8f7793b69577d882945f921a5d296cbbd0d93cebac"
    );
    assert_eq!(
        scalar.expected_class_digests[0].sha256,
        "sha256:7ff33f86d0dc4a728a5beaf03ef9b05fb20ee1821b92218d846272a01db7366c"
    );
    let preimage =
        modal_v6_canonical_preimage("mesh-generation:periodic-film-v1", &magnetic, &scalar)
            .unwrap();
    assert_eq!(
        sha256_text(&preimage),
        "sha256:4397ddf3cf87bf263647dfc9d0d7f1e95ceda79ffe0b547ba99497e4d79c23a7"
    );
    let (_, _, magnetic_aggregate) = magnetic.canonical_state().unwrap();
    let (_, _, scalar_aggregate) = scalar.canonical_state().unwrap();
    let map_digest = modal_shared_domain_map_binding_digest(
        "mesh-generation:periodic-film-v1",
        &magnetic,
        &scalar,
        &sha256_text(&preimage),
        &magnetic_aggregate,
        &scalar_aggregate,
        &[1, 0],
        &[0, 0, 0, 0],
        1,
        &[0, 0, 0, 0],
        1,
    )
    .unwrap();
    assert_eq!(
        map_digest,
        "sha256:ba9534bd23575cdb97bc6224d8e6acbe07c04e3e0a180e417283953b9d849f67"
    );

    let corner_generators = (0_u64..8)
        .flat_map(|source| {
            [1_u32, 2, 4].into_iter().filter_map(move |axis_mask| {
                (source & axis_mask as u64 == 0).then_some(OwnedModalCertificateV6Relation {
                    source_node: source,
                    destination_node: source | axis_mask as u64,
                    axis_mask,
                    kind: 1,
                })
            })
        })
        .collect::<Vec<_>>();
    let corner_closure = (0_u64..8)
        .flat_map(|source| {
            (source + 1..8).map(move |destination| {
                let axis_mask = (source ^ destination) as u32;
                OwnedModalCertificateV6Relation {
                    source_node: source,
                    destination_node: destination,
                    axis_mask,
                    kind: axis_mask.count_ones(),
                }
            })
        })
        .collect::<Vec<_>>();
    let mut corner_view = OwnedModalCertificateV6View {
        view_kind: 1,
        part_role: 1,
        part_identity: "magnetic:corner:v1".to_string(),
        topology_fingerprint: format!("sha256:{}", "3".repeat(64)),
        region_ids: vec![7; 8],
        boundary_axis_masks: (0..8).collect(),
        region_roles: vec![OwnedModalCertificateV6RegionRole {
            region_id: 7,
            part_role: 1,
        }],
        generator_relations: corner_generators,
        closure_relations: corner_closure,
        expected_class_ids: Vec::new(),
        expected_class_digests: Vec::new(),
    };
    let (ids, digests, _) = corner_view.canonical_state().unwrap();
    corner_view.expected_class_ids = ids;
    corner_view.expected_class_digests = digests;
    corner_view.validate(1).unwrap();
    corner_view
        .closure_relations
        .retain(|relation| relation.axis_mask != 7);
    let corner_error = corner_view
        .canonical_state()
        .expect_err("missing x/y/z corner closure must fail closed");
    assert!(corner_error.message.contains("corner_closure_incomplete"));
}

fn minimal_native_modal_plan() -> FemEigenPlanIR {
    FemEigenPlanIR {
        mesh_build_report: None,
        mesh_name: "native_modal_mesh".to_string(),
        mesh_source: None,
        mesh: fullmag_ir::MeshIR {
            mesh_name: "native_modal_mesh".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
            element_markers: vec![1],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
            boundary_markers: vec![1],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
        },
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 1.0,
        equilibrium_magnetization: vec![
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
        ],
        material: fullmag_ir::MaterialIR {
            name: "Py".to_string(),
            saturation_magnetisation: 8.0e5,
            exchange_stiffness: 1.3e-11,
            damping: 0.01,
            uniaxial_anisotropy: None,
            uniaxial_anisotropy_k2: None,
            anisotropy_axis: None,
            cubic_anisotropy_kc1: None,
            cubic_anisotropy_kc2: None,
            cubic_anisotropy_kc3: None,
            cubic_anisotropy_axis1: None,
            cubic_anisotropy_axis2: None,
            ms_field: None,
            a_field: None,
            alpha_field: None,
            ku_field: None,
            ku2_field: None,
            kc1_field: None,
            kc2_field: None,
            kc3_field: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            dind_field: None,
            dbulk_field: None,
        },
        operator: fullmag_ir::EigenOperatorConfigIR {
            kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 6,
        target: fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0e8,
            frequency_max_hz: 5.0e9,
        },
        equilibrium: EquilibriumSourceIR::RelaxedInitialState,
        k_sampling: Some(KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        }),
        bias_field_samples: Vec::new(),
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Include,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        dmi_interface_normal: None,
        bulk_dmi: None,
        external_field: None,
        gyromagnetic_ratio: 2.211e5,
        precision: fullmag_ir::ExecutionPrecision::Double,
        exchange_bc: fullmag_ir::ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: SpinWaveBoundaryConditionIR::default(),
        demag_realization: None,
        air_box_config: None,
        mode_tracking: None,
        dispersion_validation: None,
        k0_kittel_validation: None,
    }
}

fn bounded_k0_execution_plan() -> FemEigenPlanIR {
    let mut plan = minimal_native_modal_plan();
    add_minimal_shared_domain_periodic_airbox(&mut plan);
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.operator.include_demag = true;
    plan.enable_demag = true;
    plan.damping_policy = fullmag_ir::EigenDampingPolicyIR::Ignore;
    plan.k_sampling = Some(fullmag_ir::KSamplingIR::Single {
        k_vector: [0.0, 0.0, 0.0],
    });
    plan
}

fn exact_k0_resolution(
    device: fullmag_ir::ExecutionDevice,
) -> fullmag_ir::FemEigenExecutionResolutionIR {
    let resolved_engine = match device {
        fullmag_ir::ExecutionDevice::Cpu => {
            fullmag_ir::FemEigenEngineIR::K0PoissonAirboxCpuSchurSlepc
        }
        fullmag_ir::ExecutionDevice::Gpu => fullmag_ir::FemEigenEngineIR::GpuModalDeviceKrylov,
        fullmag_ir::ExecutionDevice::Auto => fullmag_ir::FemEigenEngineIR::Auto,
    };
    fullmag_ir::FemEigenExecutionResolutionIR {
        requested_device: device,
        resolved_device: device,
        requested_precision: fullmag_ir::ExecutionPrecision::Double,
        resolved_precision: fullmag_ir::ExecutionPrecision::Double,
        requested_engine: resolved_engine,
        resolved_engine,
        fallback_used: false,
        fallback_reason: None,
        selection_reason: "test.exact_k0_resolution".to_string(),
    }
}

fn materialized_k0_execution_plan(
    device: fullmag_ir::ExecutionDevice,
) -> (fullmag_ir::ProblemIR, fullmag_ir::ExecutionPlanIR) {
    let requested_device = match device {
        fullmag_ir::ExecutionDevice::Auto => "auto",
        fullmag_ir::ExecutionDevice::Cpu => "cpu",
        fullmag_ir::ExecutionDevice::Gpu => "gpu",
    };
    let problem = real_bounded_k0_problem(requested_device, None);
    let execution_plan = fullmag_plan::plan(&problem).expect("real bounded K0 ProblemIR must plan");
    (problem, execution_plan)
}

pub(super) fn real_bounded_k0_problem(
    requested_device: &str,
    runtime_override: Option<serde_json::Value>,
) -> fullmag_ir::ProblemIR {
    let mut runtime_metadata = serde_json::Map::new();
    runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": requested_device, "precision": "double"}),
    );
    if let Some(runtime_override) = runtime_override {
        runtime_metadata.insert("runtime_device_override".to_string(), runtime_override);
    }
    let mut problem: fullmag_ir::ProblemIR = serde_json::from_value(serde_json::json!({
        "ir_version": fullmag_ir::IR_VERSION,
        "problem_meta": {
            "name": "runner_exact_k0_execution_contract",
            "description": "Standalone bounded K0 planner fixture",
            "script_language": "python",
            "script_source": null,
            "script_api_version": fullmag_ir::IR_VERSION,
            "serializer_version": fullmag_ir::IR_VERSION,
            "entrypoint_kind": "build",
            "source_hash": null,
            "runtime_metadata": runtime_metadata,
            "backend_revision": null,
            "seeds": [],
        },
        "geometry": {
            "entries": [{
                "kind": "box",
                "name": "strip",
                "size": [2.0e-7, 2.0e-8, 6.0e-9],
            }],
        },
        "regions": [{"name": "strip", "geometry": "strip"}],
        "materials": [{
            "name": "Py",
            "saturation_magnetisation": 800000.0,
            "exchange_stiffness": 1.3e-11,
            "damping": 0.0,
            "uniaxial_anisotropy": null,
            "anisotropy_axis": null,
        }],
        "magnets": [{
            "name": "strip",
            "region": "strip",
            "material": "Py",
            "initial_magnetization": {"kind": "uniform", "value": [1.0, 0.0, 0.0]},
        }],
        "energy_terms": [
            {"kind": "exchange"},
            {"kind": "demag", "realization": "auto"},
            {"kind": "zeeman", "B": [0.02, 0.0, 0.0]},
        ],
        "study": {
            "kind": "eigenmodes",
            "dynamics": {
                "kind": "llg",
                "gyromagnetic_ratio": 221100.0,
                "integrator": "heun",
                "fixed_timestep": 1.0e-13,
            },
            "operator": {"kind": "full_2x2", "include_demag": true},
            "count": 1,
            "target": {
                "kind": "frequency_window",
                "frequency_min_hz": 1.0e8,
                "frequency_max_hz": 2.5e10,
            },
            "equilibrium": {"kind": "provided"},
            "k_sampling": {"kind": "single", "k_vector": [0.0, 0.0, 0.0]},
            "normalization": "unit_l2",
            "damping_policy": "ignore",
            "spin_wave_bc": {
                "kind": "periodic",
                "boundary_pair_id": "x_faces",
            },
            "magnetostatic_bc": "periodic_airbox_k0",
            "sampling": {
                "outputs": [{"kind": "eigen_spectrum", "quantity": "eigenfrequency"}],
            },
        },
        "backend_policy": {
            "requested_backend": "fem",
            "execution_precision": "double",
            "discretization_hints": {
                "fdm": null,
                "fem": {"order": 1, "hmax": 2.0e-9},
                "hybrid": null,
            },
        },
        "validation_profile": {"execution_mode": "strict"},
        "pbc": {
            "axes": ["periodic", "periodic", "open"],
            "demag": "periodic_airbox_k0",
        },
    }))
    .expect("standalone bounded K0 ProblemIR JSON must deserialize");

    let mut mesh = fullmag_ir::MeshIR {
        mesh_name: "runner_exact_k0_shared_domain".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [2.0, 0.0, 0.0],
            [3.0, 0.0, 0.0],
            [2.0, 1.0, 0.0],
            [2.0, 0.0, 1.0],
        ],
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
        element_markers: vec![1, 0],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [4, 5, 6]]),
        boundary_markers: vec![10, 99],
        periodic_boundary_pairs: vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "x_faces".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 10,
            marker_b: 11,
            translation: Some([1.0, 0.0, 0.0]),
            tolerance: None,
            axis_hint: None,
            orientation: None,
            pairing_policy: None,
        }],
        periodic_node_pairs: vec![
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 0,
                node_b: 1,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 4,
                node_b: 5,
            },
        ],
        per_domain_quality: std::collections::HashMap::new(),
    };
    complete_real_k0_fixture_boundaries(&mut mesh);
    problem.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: Vec::new(),
        fem_mesh_assets: Vec::new(),
        fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
            mesh_source: None,
            mesh: Some(mesh),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            object_region_markers: Vec::new(),
            build_report: None,
        }),
    });
    problem
}

fn complete_real_k0_fixture_boundaries(mesh: &mut fullmag_ir::MeshIR) {
    let mut topology: std::collections::BTreeMap<[u32; 3], Vec<bool>> =
        std::collections::BTreeMap::new();
    for (index, element) in mesh
        .require_tet4_elements()
        .expect("fixture must contain tet4 elements")
        .iter()
        .enumerate()
    {
        let is_air = mesh.element_markers.get(index).copied().unwrap_or(1) == 0;
        for mut face in [
            [element[0], element[1], element[2]],
            [element[0], element[1], element[3]],
            [element[0], element[2], element[3]],
            [element[1], element[2], element[3]],
        ] {
            face.sort_unstable();
            topology.entry(face).or_default().push(is_air);
        }
    }
    let existing = mesh
        .require_tri3_boundary_faces()
        .expect("fixture must contain tri3 facets")
        .iter()
        .map(|face| {
            let mut key = *face;
            key.sort_unstable();
            key
        })
        .collect::<std::collections::BTreeSet<_>>();
    let magnetic_marker = 100;
    let interface_marker = 101;
    for (face, adjacent) in topology {
        if existing.contains(&face) {
            continue;
        }
        let marker = match adjacent.as_slice() {
            [is_air] if *is_air => 99,
            [is_air] if !*is_air => magnetic_marker,
            [first, second] if first != second => interface_marker,
            _ => continue,
        };
        mesh.push_tri3_facet(face)
            .expect("fixture boundary facet must be valid");
        mesh.boundary_markers.push(marker);
    }
}

#[test]
fn planned_k0_cpu_resolution_resists_gpu_environment_and_dispatches_cpu_schur() {
    let plan = bounded_k0_execution_plan();
    let resolution = exact_k0_resolution(fullmag_ir::ExecutionDevice::Cpu);
    unsafe {
        std::env::set_var("FULLMAG_FEM_EXECUTION", "gpu");
    }
    let execution = resolve_fem_eigen_execution_resolution(&plan, Some(&resolution))
        .expect("the materialized CPU resolution must win")
        .expect("bounded K0 must have an exact execution");
    unsafe {
        std::env::remove_var("FULLMAG_FEM_EXECUTION");
    }

    assert_eq!(execution.lane(), FemEigenExecutionLane::Cpu);
    assert_eq!(
        execution.native_target(),
        Some(native_fem::NativeModalExecutionTarget::ProductionCpu)
    );
    assert_eq!(execution.engine_id(), "k0_poisson_airbox_cpu_schur_slepc");
}

#[test]
fn planned_k0_gpu_resolution_resists_cpu_environment_and_dispatches_device_krylov() {
    let plan = bounded_k0_execution_plan();
    let resolution = exact_k0_resolution(fullmag_ir::ExecutionDevice::Gpu);
    unsafe {
        std::env::set_var("FULLMAG_FEM_EXECUTION", "cpu");
    }
    let execution = resolve_fem_eigen_execution_resolution(&plan, Some(&resolution))
        .expect("the materialized GPU resolution must win")
        .expect("bounded K0 must have an exact execution");
    unsafe {
        std::env::remove_var("FULLMAG_FEM_EXECUTION");
    }

    assert_eq!(execution.lane(), FemEigenExecutionLane::Gpu);
    assert_eq!(
        execution.native_target(),
        Some(native_fem::NativeModalExecutionTarget::ProductionGpu)
    );
    assert_eq!(execution.engine_id(), "gpu_modal_device_krylov");
}

#[test]
fn planned_k0_runtime_capabilities_and_session_report_one_exact_engine() {
    for (device, expected_runtime_engine, expected_exact_engine, expected_accelerator) in [
        (
            fullmag_ir::ExecutionDevice::Cpu,
            "fem_eigen_cpu_baseline",
            fullmag_ir::FemEigenEngineIR::K0PoissonAirboxCpuSchurSlepc,
            "cpu",
        ),
        (
            fullmag_ir::ExecutionDevice::Gpu,
            "fem_eigen_native_gpu",
            fullmag_ir::FemEigenEngineIR::GpuModalDeviceKrylov,
            "gpu",
        ),
    ] {
        let (problem, plan) = materialized_k0_execution_plan(device);
        let runtime = crate::resolve_planned_runtime_engine(&problem, &plan)
            .expect("exact planned runtime engine");
        assert_eq!(runtime.engine_id, expected_runtime_engine);
        assert_eq!(runtime.accelerator, expected_accelerator);

        let capabilities = crate::resolve_planned_runtime_capabilities(&problem, &plan)
            .expect("exact planned capabilities");
        assert_eq!(capabilities.engine_id.as_str(), expected_runtime_engine);

        let session = crate::resolve_planned_session_runtime_with_registry_and_preview(
            &problem, &plan, None, false,
        )
        .expect("exact planned session runtime");
        assert_eq!(
            session.resolved_engine_id.as_deref(),
            Some(expected_runtime_engine)
        );
        assert_eq!(session.resolved_device, expected_accelerator);
        assert_eq!(session.resolved_precision, "double");
        assert!(session.resolved_fallback.is_none());
        assert_eq!(
            plan.provenance
                .fem_eigen_execution_resolution
                .as_ref()
                .map(|resolution| resolution.resolved_engine),
            Some(expected_exact_engine)
        );
    }
}

#[test]
fn all_active_planned_entrypoints_preserve_exact_k0_dispatch_and_persisted_provenance() {
    let problem = real_bounded_k0_problem(
        "auto",
        Some(serde_json::json!({
            "device": "cpu",
            "source": "managed_launcher",
            "fallback_reason": "gpu_modal_device_krylov_unavailable",
        })),
    );
    let plan = fullmag_plan::plan(&problem).expect("real bounded K0 ProblemIR must plan");
    let fem = match &plan.backend_plan {
        fullmag_ir::BackendPlanIR::FemEigen(fem) => fem,
        other => panic!("expected real FEM eigen plan, got {other:?}"),
    };
    let execution = crate::dispatch::resolve_planned_fem_eigen_execution(&problem, &plan, fem)
        .expect("real exact K0 execution must resolve");
    let expected_resolution = plan
        .provenance
        .fem_eigen_execution_resolution
        .as_ref()
        .expect("real K0 plan must publish an execution resolution")
        .clone();
    assert_eq!(execution.lane(), FemEigenExecutionLane::Cpu);
    assert_eq!(
        execution.native_target(),
        Some(native_fem::NativeModalExecutionTarget::ProductionCpu)
    );

    for route in ["basic", "callback", "live_preview"] {
        let mut fake_executed = bias_field_sweep_run_fixture(0, RunStatus::Completed);
        fake_executed.initial_magnetization = fem.equilibrium_magnetization.clone();
        fake_executed.result.final_magnetization = fem.equilibrium_magnetization.clone();
        fake_executed
            .provenance
            .fem_eigen_native_execution_attestation = Some(execution.native_attestation(
            Some(1),
            "k0_poisson_airbox_cpu_schur_slepc",
            0,
            "none",
        ));
        let seam = crate::dispatch::install_test_fem_eigen_execution_seam(
            &fem.mesh.mesh_name,
            fake_executed,
        );
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-real-k0-entrypoint-{route}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos(),
        ));
        let run_result = match route {
            "basic" => crate::run_planned_problem(&problem, &plan, 0.0, &output_dir),
            "callback" => crate::run_planned_problem_with_callback(
                &problem,
                &plan,
                0.0,
                &output_dir,
                1,
                |_| StepAction::Continue,
            ),
            "live_preview" => {
                let display_selection = || crate::DisplaySelectionState::default();
                crate::run_planned_problem_with_live_preview_interruptible_with_initial_snapshot(
                    &problem,
                    &plan,
                    0.0,
                    &output_dir,
                    1,
                    &display_selection,
                    None,
                    false,
                    |_| StepAction::Continue,
                )
            }
            _ => unreachable!("enumerated entrypoint route"),
        }
        .unwrap_or_else(|error| panic!("{route} entrypoint failed: {}", error.message));
        assert_eq!(run_result.status, RunStatus::Completed);

        let observations = seam.take_observations();
        assert_eq!(observations.len(), 1, "{route} must dispatch exactly once");
        let observation = &observations[0];
        assert_eq!(
            observation.entrypoint,
            if route == "basic" {
                "execute_fem_eigen"
            } else {
                "execute_fem_eigen_with_progress"
            }
        );
        assert_eq!(observation.lane, FemEigenExecutionLane::Cpu);
        assert_eq!(
            observation.native_target,
            Some(native_fem::NativeModalExecutionTarget::ProductionCpu)
        );
        assert_eq!(observation.resolution, expected_resolution);
        assert_eq!(
            seam.generic_resolver_calls(),
            0,
            "{route} must not re-enter the generic FEM resolver"
        );

        let metadata: serde_json::Value = serde_json::from_slice(
            &std::fs::read(output_dir.join("metadata.json"))
                .expect("entrypoint must persist metadata.json"),
        )
        .expect("metadata.json must contain valid JSON");
        let provenance = &metadata["execution_provenance"];
        assert_eq!(provenance["execution_engine"], "fem_eigen_cpu_baseline");
        assert_eq!(
            provenance["fem_eigen_execution_resolution"],
            serde_json::to_value(&expected_resolution)
                .expect("accepted execution resolution must serialize")
        );
        assert_eq!(provenance["resolved_fallback"]["occurred"], true);
        assert_eq!(provenance["resolved_fallback"]["original_engine"], "auto");
        assert_eq!(
            provenance["resolved_fallback"]["fallback_engine"],
            "k0_poisson_airbox_cpu_schur_slepc"
        );
        assert_eq!(
            provenance["resolved_fallback"]["reason"],
            "gpu_modal_device_krylov_unavailable"
        );
        assert_eq!(
            provenance["fem_eigen_native_execution_attestation"]["requested_target"],
            "production_cpu"
        );
        assert_eq!(
            provenance["fem_eigen_native_execution_attestation"]["resolved_target"],
            "production_cpu"
        );
        assert_eq!(
            provenance["fem_eigen_native_execution_attestation"]["fallback_used"],
            false
        );
        assert!(provenance["fem_eigen_native_execution_attestation"]
            .get("fallback_reason")
            .is_none());

        drop(seam);
        std::fs::remove_dir_all(&output_dir).expect("remove entrypoint artifact fixture");
    }
}

#[test]
fn real_planner_resolution_drives_native_diagnostics_and_execution_provenance() {
    let cases = [
        (
            "cpu",
            None,
            fullmag_ir::ExecutionDevice::Cpu,
            fullmag_ir::FemEigenEngineIR::K0PoissonAirboxCpuSchurSlepc,
            native_fem::NativeModalExecutionTarget::ProductionCpu,
            1,
            "k0_poisson_airbox_cpu_schur_slepc",
            false,
        ),
        (
            "gpu",
            None,
            fullmag_ir::ExecutionDevice::Gpu,
            fullmag_ir::FemEigenEngineIR::GpuModalDeviceKrylov,
            native_fem::NativeModalExecutionTarget::ProductionGpu,
            2,
            "k0_poisson_airbox_gpu_petsc_slepc",
            false,
        ),
        (
            "auto",
            Some(serde_json::json!({
                "device": "cpu",
                "source": "managed_launcher",
                "fallback_reason": "gpu_modal_device_krylov_unavailable",
            })),
            fullmag_ir::ExecutionDevice::Cpu,
            fullmag_ir::FemEigenEngineIR::K0PoissonAirboxCpuSchurSlepc,
            native_fem::NativeModalExecutionTarget::ProductionCpu,
            1,
            "k0_poisson_airbox_cpu_schur_slepc",
            true,
        ),
    ];

    for (
        requested_device,
        runtime_override,
        resolved_device,
        resolved_engine,
        native_target,
        resolved_target,
        native_engine_id,
        planner_fallback_used,
    ) in cases
    {
        let problem = real_bounded_k0_problem(requested_device, runtime_override);
        let plan = fullmag_plan::plan(&problem).expect("real bounded K0 ProblemIR must plan");
        let fem = match &plan.backend_plan {
            fullmag_ir::BackendPlanIR::FemEigen(fem) => fem,
            other => panic!("expected real FEM eigen plan, got {other:?}"),
        };
        let execution = resolve_planned_fem_eigen_execution(&plan, fem)
            .expect("real exact K0 resolution must validate")
            .expect("real exact K0 plan must carry a resolution");
        assert_eq!(execution.native_target(), Some(native_target));
        let resolution = execution
            .resolution()
            .expect("exact execution must expose its accepted resolution");
        assert_eq!(resolution.resolved_device, resolved_device);
        assert_eq!(resolution.resolved_engine, resolved_engine);
        assert_eq!(resolution.fallback_used, planner_fallback_used);

        let native_attestation =
            execution.native_attestation(Some(resolved_target), native_engine_id, 0, "none");
        let mut diagnostics = serde_json::json!({
            "requested_execution": {
                "device": "incorrect_adapter_reconstruction",
            },
            "resolved_execution": {
                "device": "incorrect_adapter_reconstruction",
                "engine": "incorrect_adapter_reconstruction",
                "implementation_id": "native_adapter_implementation_detail",
            },
        });
        bind_planned_execution_diagnostics(&mut diagnostics, fem, execution, &native_attestation)
            .expect("planned execution must bind native diagnostics");

        assert_eq!(
            diagnostics["fem_eigen_execution_resolution"],
            serde_json::to_value(resolution).expect("resolution must serialize")
        );
        assert_eq!(
            diagnostics["requested_execution"]["device"],
            requested_device
        );
        assert_eq!(
            diagnostics["resolved_execution"]["device"],
            serde_json::to_value(resolved_device).expect("device must serialize")
        );
        assert_eq!(
            diagnostics["resolved_execution"]["engine"],
            serde_json::to_value(resolved_engine).expect("engine must serialize")
        );
        assert_eq!(
            diagnostics["resolved_execution"]["implementation_id"],
            "native_adapter_implementation_detail"
        );
        assert_eq!(
            diagnostics["resolved_execution"]["fallback_used"],
            planner_fallback_used
        );
        assert_eq!(
            diagnostics["native_execution_attestation"]["fallback_used"],
            false
        );
        assert_eq!(
            diagnostics["native_execution_attestation"]["resolved_engine_id"],
            native_engine_id
        );
        assert!(diagnostics["native_execution_attestation"]
            .get("fallback_reason")
            .is_none());

        let mut provenance = ExecutionProvenance::default();
        provenance.fem_eigen_native_execution_attestation = Some(native_attestation.clone());
        execution.bind_execution_provenance(&mut provenance);
        assert_eq!(
            provenance.execution_engine,
            if resolved_device == fullmag_ir::ExecutionDevice::Gpu {
                "fem_eigen_native_gpu"
            } else {
                "fem_eigen_cpu_baseline"
            }
        );
        assert_eq!(
            provenance.fem_eigen_execution_resolution.as_ref(),
            Some(resolution)
        );
        assert_eq!(
            provenance.resolved_fallback.is_some(),
            planner_fallback_used
        );
        assert_eq!(
            provenance.fem_eigen_native_execution_attestation.as_ref(),
            Some(&native_attestation)
        );
    }
}

#[test]
fn planned_k0_gpu_session_rejects_cpu_only_registry_without_fallback() {
    let (problem, plan) = materialized_k0_execution_plan(fullmag_ir::ExecutionDevice::Gpu);
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system time")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "fullmag-exact-eigen-registry-{}-{unique}",
        std::process::id()
    ));
    let pack = root.join("fem-cpu");
    std::fs::create_dir_all(pack.join("bin")).expect("create runtime pack");
    std::fs::write(pack.join("bin/worker"), b"stub").expect("write worker");
    std::fs::write(
        pack.join("manifest.json"),
        r#"{
          "family":"fem-cpu",
          "version":"1",
          "worker":"bin/worker",
          "engines":[{"backend":"fem","device":"cpu","precision":"double","public":true}]
        }"#,
    )
    .expect("write manifest");
    let registry = crate::RuntimeRegistry::discover(&root);
    let error = crate::resolve_planned_session_runtime_with_registry_and_preview(
        &problem,
        &plan,
        Some(&registry),
        false,
    )
    .expect_err("CPU-only registry cannot replace planned GPU execution");
    let _ = std::fs::remove_dir_all(&root);
    assert!(error
        .message
        .contains("planned_fem_eigen_runtime_unavailable"));
    assert!(error.message.contains("gpu_modal_device_krylov"));
}

#[test]
fn planned_k0_missing_auto_or_mismatched_resolution_fails_closed() {
    let plan = bounded_k0_execution_plan();
    let missing = resolve_fem_eigen_execution_resolution(&plan, None)
        .expect_err("bounded K0 without materialized resolution must require replanning");
    assert!(missing
        .message
        .contains("planned_fem_eigen_resolution_missing"));

    let auto = exact_k0_resolution(fullmag_ir::ExecutionDevice::Auto);
    let auto_error = resolve_fem_eigen_execution_resolution(&plan, Some(&auto))
        .expect_err("resolved auto is not executable");
    assert!(auto_error
        .message
        .contains("planned_fem_eigen_resolved_engine_auto"));

    let mut mismatch = exact_k0_resolution(fullmag_ir::ExecutionDevice::Cpu);
    mismatch.resolved_device = fullmag_ir::ExecutionDevice::Gpu;
    let mismatch_error = resolve_fem_eigen_execution_resolution(&plan, Some(&mismatch))
        .expect_err("CPU engine with GPU device must fail closed");
    assert!(mismatch_error
        .message
        .contains("planned_fem_eigen_resolution_mismatch"));
}

#[test]
fn planned_k0_rejects_fallback_inconsistency_and_explicit_fallback() {
    let plan = bounded_k0_execution_plan();
    let mut inconsistent = exact_k0_resolution(fullmag_ir::ExecutionDevice::Cpu);
    inconsistent.fallback_used = true;
    let inconsistency = resolve_fem_eigen_execution_resolution(&plan, Some(&inconsistent))
        .expect_err("fallback flag and reason must agree");
    assert!(inconsistency
        .message
        .contains("planned_fem_eigen_fallback_inconsistent"));

    inconsistent.fallback_reason = Some("forbidden_runtime_fallback".to_string());
    let explicit = resolve_fem_eigen_execution_resolution(&plan, Some(&inconsistent))
        .expect_err("explicit CPU cannot carry fallback");
    assert!(explicit
        .message
        .contains("planned_fem_eigen_explicit_fallback_forbidden"));
}

#[test]
fn planned_k0_rejects_sweep_sample_mismatch_before_executor_entry() {
    let mut plan = bounded_k0_execution_plan();
    let resolution = exact_k0_resolution(fullmag_ir::ExecutionDevice::Cpu);
    plan.bias_field_samples = vec![fullmag_ir::FemEigenBiasFieldSamplePlanIR {
        sample_index: 0,
        field_a_per_m: [20_000.0, 0.0, 0.0],
        equilibrium_policy: fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::RelaxEach,
        continuation_seed: fullmag_ir::BiasFieldSweepContinuationSeedIR::InitialState,
        execution: exact_k0_resolution(fullmag_ir::ExecutionDevice::Gpu),
    }];
    let mut executor_calls = 0;
    let error = execute_bias_field_sweep_with_planned_execution(
        &plan,
        &resolution,
        |_sample_plan, _sample_position| {
            executor_calls += 1;
            unreachable!("mismatched sample resolution must fail before executor entry")
        },
    )
    .expect_err("mismatched sample execution must reject the complete sweep");

    assert_eq!(executor_calls, 0);
    assert!(error
        .message
        .contains("planned_fem_eigen_sweep_resolution_mismatch"));
}

#[test]
fn exact_execution_is_rejected_for_reference_oracles_while_none_remains_isolated() {
    let mut plan = minimal_native_modal_plan();
    plan.k_sampling = Some(fullmag_ir::KSamplingIR::Path {
        points: vec![fullmag_ir::KPointIR {
            label: Some("G".to_string()),
            k_vector: [0.0, 0.0, 0.0],
        }],
        samples_per_segment: Vec::new(),
        closed: false,
    });
    plan.operator.include_demag = true;
    plan.enable_demag = true;
    plan.spin_wave_bc =
        fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
            kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
            boundary_pair_id: None,
            pair_ids: Vec::new(),
            phase_convention: fullmag_ir::PhaseConventionIR::default(),
            surface_anisotropy_ks: None,
            surface_anisotropy_axis: None,
        });
    plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
        kind: "k0_kittel_field_sweep".to_string(),
        case_id: Some("K0-3".to_string()),
        demag_kind: Some("synthetic_demag_factor".to_string()),
        model: "thin_film_in_plane".to_string(),
        field_units: "A_per_m".to_string(),
        relative_tolerance: 0.05,
        material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
            effective_magnetisation: Some(800_000.0),
        },
        samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
            sample_index: 0,
            bias_field: [20_000.0, 0.0, 0.0],
        }],
    });

    assert!(resolve_fem_eigen_execution_resolution(&plan, None)
        .expect("reference/oracle plan without exact execution remains isolated")
        .is_none());
    let resolution = exact_k0_resolution(fullmag_ir::ExecutionDevice::Cpu);
    let error = resolve_fem_eigen_execution_resolution(&plan, Some(&resolution))
        .expect_err("production resolution must not enter a synthetic reference oracle");
    assert!(error
        .message
        .contains("planned_fem_eigen_reference_resolution_forbidden"));
}

fn add_minimal_shared_domain_periodic_airbox(plan: &mut FemEigenPlanIR) {
    let (mesh, mesh_parts) = modal_v6_multi_part_mesh_and_parts();
    plan.mesh = mesh;
    plan.mesh_parts = mesh_parts;
    plan.equilibrium_magnetization = vec![[1.0, 0.0, 0.0]; plan.mesh.nodes.len()];
    plan.spin_wave_bc = SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
        kind: SpinWaveBoundaryKindIR::Periodic,
        boundary_pair_id: None,
        pair_ids: vec!["x_faces".to_string(), "y_faces".to_string()],
        phase_convention: fullmag_ir::PhaseConventionIR::default(),
        surface_anisotropy_ks: None,
        surface_anisotropy_axis: None,
    });
    plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
        factor: 2.0,
        grading: 1.2,
        boundary_marker: 99,
        bc_kind: Some("robin".to_string()),
        robin_beta_mode: Some("dipole".to_string()),
        robin_beta_factor: Some(2.0),
        shape: Some("bbox".to_string()),
        factor_source: Some("test".to_string()),
        boundary_marker_source: Some("test".to_string()),
    });
}

#[test]
fn modal_participation_context_aggregates_same_object_parts_by_markers() {
    let mut plan = minimal_native_modal_plan();
    add_minimal_shared_domain_periodic_airbox(&mut plan);

    let context = modal_participation_mesh_context(&plan)
        .expect("canonical magnetic mesh parts must define participation membership");

    assert_eq!(context.source_mesh_identity.mesh_id, plan.mesh_name);
    assert_eq!(
        context.source_mesh_identity.node_count,
        plan.mesh.nodes.len()
    );
    assert_eq!(context.object_marker_membership.len(), 1);
    assert_eq!(context.object_marker_membership[0].object_id, "body");
    assert_eq!(context.object_marker_membership[0].markers, vec![1, 2]);
}

fn add_x_floquet_pair_to_plan(plan: &mut FemEigenPlanIR) {
    plan.mesh.periodic_boundary_pairs = vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
        pair_id: "x_faces".to_string(),
        source_marker: None,
        destination_marker: None,
        marker_a: 10,
        marker_b: 11,
        translation: Some([1.0, 0.0, 0.0]),
        tolerance: Some(1e-12),
        axis_hint: None,
        orientation: None,
        pairing_policy: None,
    }];
    plan.mesh.periodic_node_pairs = vec![fullmag_ir::MeshPeriodicNodePairIR {
        pair_id: "x_faces".to_string(),
        node_a: 0,
        node_b: 1,
    }];
    plan.spin_wave_bc = SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
        kind: SpinWaveBoundaryKindIR::Floquet,
        boundary_pair_id: Some("x_faces".to_string()),
        pair_ids: Vec::new(),
        phase_convention: fullmag_ir::PhaseConventionIR::default(),
        surface_anisotropy_ks: None,
        surface_anisotropy_axis: None,
    });
    plan.k_sampling = Some(KSamplingIR::Single {
        k_vector: [1.0e6, 0.0, 0.0],
    });
}

#[test]
fn native_eigen_v2_mode_metadata_preserves_operator_provenance() {
    let plan = minimal_native_modal_plan();
    let provenance = serde_json::json!({
        "external_field_a_per_m": [3978.8735772973837, 0.0, 0.0],
        "assembly_kind": "mfem_weak_form_shared_domain",
        "operator_input_signature_sha256": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "phase_constraint_sha256": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "equilibrium_artifact_sha256": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "linearization_state_sha256": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        "relax_to_eigen_handoff_sha256": "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "source_mesh_topology_sha256": plan.mesh.topology_fingerprint_v6(),
        "periodic_mesh_certificate_sha256": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    });
    let mut legacy_mode = serde_json::json!({
        "index": 0,
        "frequency_hz": 1.0e9,
        "frequency_real_hz": 1.0e9,
        "frequency_imag_hz": 0.0,
        "angular_frequency_rad_per_s": std::f64::consts::TAU * 1.0e9,
        "omega_rad_s": std::f64::consts::TAU * 1.0e9,
        "eigenvalue_real": 0.0,
        "eigenvalue_imag": std::f64::consts::TAU * 1.0e9,
        "normalization": "unit_l2",
        "damping_policy": "ignore",
        "residual_norm": 1.0e-10,
        "residual_absolute_l2": 1.0e-10,
        "residual_relative_l2": 1.0e-10,
        "residual_linf": 1.0e-10,
        "mass_norm": 1.0,
        "tangent_leakage_mean_abs": 0.0,
        "tangent_leakage_max_abs": 0.0,
        "phasor_convention": "exp_plus_i_omega_t",
        "eigenvalue_mapping": "lambda_imag_positive_frequency",
        "gamma_rad_s_T": 1.0,
        "gamma0_rad_s_per_A_m": 2.211e5,
        "mu0_T_m_per_A": MU0,
        "dominant_polarization": "uniform",
        "k_vector": [0.0, 0.0, 0.0],
        "real": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 1.0, 0.0]],
        "imag": [[0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 1.0]],
        "amplitude": [1.0, 1.0, 1.0, 1.0],
    });
    for (key, value) in provenance.as_object().expect("provenance object") {
        legacy_mode[key] = value.clone();
    }
    let summary = serde_json::json!({
        "solver_kind": "k0_poisson_airbox_gpu_petsc_slepc",
        "modes": [legacy_mode.clone()],
    });
    let mut artifacts = vec![json_artifact("eigen/modes/mode_0000.json", &legacy_mode)
        .expect("legacy mode artifact should serialize")];
    write_eigen_v2_bundle(
        &plan,
        &summary,
        &std::collections::BTreeSet::from([0_u32]),
        &mut artifacts,
        0,
    )
    .expect("native v2 bundle should write");

    let spectrum_v2 = artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "eigen/spectrum.v2.json")
        .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())
        .expect("spectrum.v2 must be emitted");
    assert!(spectrum_v2["samples"][0]["modes"][0]
        .get("component_participation")
        .is_none());
    let spectrum_v3 = artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "eigen/spectrum.v3.json")
        .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())
        .expect("spectrum.v3 must be emitted");
    assert_eq!(spectrum_v3["schema_version"], "eigen_spectrum.v3");
    assert_eq!(
        spectrum_v3["samples"][0]["modes"][0]["component_participation"]["status"],
        "unavailable"
    );

    let nested = artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "eigen/modes/sample_0000/mode_0000.json")
        .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())
        .expect("nested mode metadata should be emitted");
    for key in provenance.as_object().expect("provenance object").keys() {
        assert_eq!(nested[key], provenance[key], "nested mode lost {key}");
    }
    assert_eq!(
        nested["source_mesh_identity"],
        serde_json::json!({
            "mesh_id": plan.mesh_name,
            "topology_fingerprint": plan.mesh.topology_fingerprint_v6(),
            "indexing": "full_domain_node_order",
            "node_count": plan.mesh.nodes.len(),
        })
    );
    let chunk = artifacts
        .iter()
        .find(|artifact| {
            artifact.relative_path
                == "eigen/mode_fields.zarr/sample_0000/mode_0000/vector_xyz_complex/0.0.0"
        })
        .expect("canonical Zarr v2 mode chunk should be emitted");
    assert_eq!(
        nested["payload_sha256"],
        format!("sha256:{:x}", Sha256::digest(&chunk.bytes))
    );
}

#[test]
fn native_eigen_v2_rejects_requested_mode_without_cartesian_complex_payload() {
    let plan = minimal_native_modal_plan();
    let summary = serde_json::json!({
        "solver_kind": "k0_poisson_airbox_cpu_petsc_slepc",
        "modes": [{"index": 0}],
    });
    let mut artifacts = Vec::new();

    let error = write_eigen_v2_bundle(
        &plan,
        &summary,
        &std::collections::BTreeSet::from([0_u32]),
        &mut artifacts,
        0,
    )
    .expect_err("a requested field export without payload must fail closed");

    assert!(error.message.contains("requested mode 0"));
}

#[test]
fn native_eigen_v2_rejects_malformed_or_asymmetric_complex_xyz_payload() {
    let plan = minimal_native_modal_plan();
    let summary = serde_json::json!({
        "solver_kind": "k0_poisson_airbox_cpu_petsc_slepc",
        "modes": [{"index": 0}],
    });
    let malformed = serde_json::json!({
        "real": [[1.0, 0.0]],
        "imag": [[0.0, 1.0, 0.0]],
    });
    let mut artifacts =
        vec![json_artifact("eigen/modes/mode_0000.json", &malformed)
            .expect("fixture should serialize")];

    let error = write_eigen_v2_bundle(
        &plan,
        &summary,
        &std::collections::BTreeSet::from([0_u32]),
        &mut artifacts,
        0,
    )
    .expect_err("a malformed Cartesian component must fail closed");

    assert!(error.message.contains("real[0]"));
}

#[test]
fn native_field_sweep_binds_published_sources_and_has_own_content_digest() {
    let spectrum = serde_json::json!({
        "samples": [{
            "sample_index": 7,
            "external_field_a_per_m": [40_000.0, 0.0, 0.0],
            "mesh_id": "mesh:periodic-airbox",
            "topology_revision": "sha256:mesh-revision",
            "modes": [{
                "raw_mode_index": 2,
                "frequency_hz": 6.1e9,
                "angular_frequency_rad_per_s": std::f64::consts::TAU * 6.1e9,
                "mode_field_id": "analysis:eigen:sample-0007:mode-0002",
                "mode_field_resource_key": "/v2/sessions/current/data/fields/analysis:eigen:sample-0007:mode-0002/samples/vector",
                "residual_relative_l2": 1.0e-10,
                "equilibrium_artifact_sha256": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "linearization_state_sha256": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "operator_input_signature_sha256": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
            }]
        }]
    });
    let branches = serde_json::json!({
        "branches": [{
            "branch_id": 3,
            "points": [{"sample_index": 7, "raw_mode_index": 2}]
        }]
    });
    let diagnostics = serde_json::json!({
        "requested_execution": {"backend": "fem", "device": "cpu"},
        "resolved_execution": {"backend": "fem", "device": "cpu"}
    });
    let artifacts = vec![
        json_artifact("eigen/spectrum.v2.json", &spectrum)
            .expect("spectrum fixture should serialize"),
        json_artifact("eigen/branches.v2.json", &branches)
            .expect("branches fixture should serialize"),
    ];

    let artifact = build_native_field_sweep_artifact(
        &spectrum,
        &branches,
        &diagnostics,
        &artifacts,
        1,
        RunStatus::Completed,
        None,
    )
    .expect("complete native field sweep should be serializable");
    let spectrum_revision = published_artifact_sha256(&artifacts, "eigen/spectrum.v2.json")
        .expect("published spectrum digest should resolve");
    let branches_revision = published_artifact_sha256(&artifacts, "eigen/branches.v2.json")
        .expect("published branches digest should resolve");

    assert_eq!(artifact["source"]["revision"], spectrum_revision);
    assert_eq!(artifact["source_revision"], spectrum_revision);
    assert_eq!(artifact["revision"], artifact["content_sha256"]);
    let mut normalized_envelope = artifact.clone();
    normalized_envelope["revision"] = serde_json::Value::String(String::new());
    normalized_envelope["content_sha256"] = serde_json::Value::String(String::new());
    let expected_content_digest = format!(
        "sha256:{:x}",
        Sha256::digest(
            serde_json::to_vec(&normalized_envelope)
                .expect("normalized field-sweep envelope should serialize")
        )
    );
    assert_eq!(artifact["revision"], expected_content_digest);
    assert_ne!(
        artifact["revision"], artifact["source_revision"],
        "the field-sweep envelope must not reuse the spectrum source digest"
    );
    assert_eq!(
        artifact["cross_artifact_refs"],
        serde_json::json!([
            {"relation": "source_spectrum", "artifact": "eigen/spectrum.v2.json", "revision": spectrum_revision},
            {"relation": "source_branches", "artifact": "eigen/branches.v2.json", "revision": branches_revision},
        ])
    );
}

fn scope_observables(node_count: usize, max_torque_apm: f64) -> EffectiveFieldObservables {
    let zeros = vec![[0.0, 0.0, 0.0]; node_count];
    let x_field = vec![[1.0, 0.0, 0.0]; node_count];
    EffectiveFieldObservables {
        magnetization: x_field.clone(),
        exchange_field: zeros.clone(),
        demag_field: zeros.clone(),
        external_field: x_field.clone(),
        effective_field: x_field,
        dmi_field: zeros,
        exchange_energy_joules: 0.0,
        demag_energy_joules: 0.0,
        external_energy_joules: 0.0,
        anisotropy_energy_joules: 0.0,
        dmi_energy_joules: 0.0,
        total_energy_joules: 0.0,
        max_effective_field_amplitude: 1.0,
        max_demag_field_amplitude: 0.0,
        max_rhs_amplitude: 0.0,
        max_torque_Apm: max_torque_apm,
    }
}

#[test]
fn native_modal_target_frequency_uses_the_authored_request() {
    assert_eq!(
        native_modal_target_frequency_hz(&fullmag_ir::EigenTargetIR::Lowest),
        0.0
    );
    assert_eq!(
        native_modal_target_frequency_hz(&fullmag_ir::EigenTargetIR::Nearest {
            frequency_hz: 1.25e9,
        }),
        1.25e9
    );
    assert_eq!(
        native_modal_target_frequency_hz(&fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 2.0e9,
            frequency_max_hz: 4.0e9,
        }),
        3.0e9
    );
}

#[test]
fn sparse_eigen_threshold_covers_mid_sized_full_2x2_smoke_meshes() {
    assert!(
            SPARSE_EIGEN_THRESHOLD <= 3_000,
            "mid-sized full 2x2 FEM eigensolve smoke meshes must use sparse LOBPCG instead of dense O(n^3) diagonalization"
        );
}

#[test]
fn frequency_window_sparse_lobpcg_oversamples_candidates() {
    let target = fullmag_ir::EigenTargetIR::FrequencyWindow {
        frequency_min_hz: 1.0,
        frequency_max_hz: 2.0,
    };

    assert_eq!(sparse_lobpcg_candidate_count(&target, 20, 10), 10);
    assert_eq!(sparse_lobpcg_candidate_count(&target, 20, 50), 50);
    assert!(sparse_lobpcg_candidate_count(&target, 20, 200) > 20);
    assert!(sparse_lobpcg_candidate_count(&target, 40, 10_000) > 40);
}

#[test]
fn native_modal_gyrotropic_pencil_uses_exp_i_omega_t_sign() {
    let mass = DMatrix::identity(2, 2);

    let gyrotropic = gyrotropic_matrix_row_major_from_tangent_mass(&mass, 1)
        .expect("single macrospin tangent mass should build a pencil matrix");

    assert_eq!(gyrotropic, vec![0.0, 1.0, -1.0, 0.0]);
}

#[test]
fn native_modal_magnetic_pencil_request_carries_payload_digest_and_canonical_gamma0() {
    let mut plan = minimal_native_modal_plan();
    plan.gyromagnetic_ratio = 1.987_654e5;
    let stiffness = vec![2.0, 0.0, 0.0, 3.0];
    let gyrotropic = vec![0.0, 1.0, -1.0, 0.0];
    let mass = vec![1.0, 0.0, 0.0, 1.0];

    let pencil = native_modal_magnetic_pencil_payload(&plan, &stiffness, &gyrotropic, &mass, &[]);
    let request =
        native_modal_mfem_operator_problem(2, &stiffness, &gyrotropic, &mass, &pencil, &[]);

    assert!(!pencil.dependency_digest.is_empty());
    assert_eq!(
        request.linearized_pencil_dependency_digest,
        Some(pencil.dependency_digest.as_str())
    );
    assert_eq!(
        request.linearized_pencil_gamma0_m_per_a_s,
        plan.gyromagnetic_ratio
    );

    let changed_stiffness = vec![2.5, 0.0, 0.0, 3.0];
    assert_ne!(
        pencil.dependency_digest,
        native_modal_magnetic_pencil_payload(&plan, &changed_stiffness, &gyrotropic, &mass, &[],)
            .dependency_digest
    );
}

#[test]
fn native_modal_provenance_uses_the_native_canonical_digest_known_vector() {
    let mut digest = CanonicalDigestBuilder::new("mfem_linearized_jvp_dependencies.v2");
    digest.add_string("label", "cross-language");
    digest.add_u64("count", 7);
    digest.add_double("negative_zero", -0.0);
    digest.add_double("nan", f64::NAN);
    digest.add_bytes("bytes", &[0x01, 0x02, 0xfe]);
    assert_eq!(
        digest.sha256_hex(),
        "1167f46ac77502f652f4fc5464070023419244dbd654d907970bd73e504afcbc"
    );
}

#[test]
fn native_modal_node_mass_weights_average_tangent_component_diagonals() {
    let mass = DMatrix::from_diagonal(&DVector::from_vec(vec![2.0, 4.0, 6.0, 10.0]));

    let weights = node_mass_weights_from_tangent_mass(&mass, 2)
        .expect("positive 2N tangent mass diagonal should produce per-node weights");

    assert_eq!(weights, vec![4.0, 7.0]);
}

#[test]
fn native_modal_full_2x2_operator_diagnostics_reports_frequency_range() {
    let mut plan = minimal_native_modal_plan();
    plan.gyromagnetic_ratio = std::f64::consts::TAU;
    let stiffness = DMatrix::identity(2, 2);
    let mass = DMatrix::identity(2, 2);

    let diagnostics = full_2x2_native_operator_diagnostics_json(&plan, &stiffness, &mass, 1);

    assert_eq!(diagnostics["payload_kind"], "rust_full_2x2_dense_operator");
    assert_eq!(
        diagnostics["generalized_field_spectrum_status"],
        "available"
    );
    assert_eq!(
        diagnostics["generalized_field_positive_eigenvalue_count"],
        2
    );
    assert!(
        (diagnostics["generalized_positive_frequency_min_hz"]
            .as_f64()
            .expect("minimum frequency should be numeric")
            - 1.0)
            .abs()
            < 1.0e-12
    );
}

#[test]
fn native_modal_full_2x2_operator_diagnostics_labels_floquet_pair_payload() {
    let mut plan = minimal_native_modal_plan();
    add_x_floquet_pair_to_plan(&mut plan);
    let stiffness = DMatrix::identity(2, 2);
    let mass = DMatrix::identity(2, 2);

    let diagnostics = full_2x2_native_operator_diagnostics_json(&plan, &stiffness, &mass, 1);

    assert_eq!(
        diagnostics["payload_kind"],
        "bloch_floquet_tangent_operator"
    );
}

#[test]
fn native_modal_lambda_i_omega_macrospin_mapping_has_positive_frequency_residual() {
    let stiffness_omega = DMatrix::identity(2, 2);
    let mass = DMatrix::identity(2, 2);
    let gyrotropic = gyrotropic_matrix_row_major_from_tangent_mass(&mass, 1)
        .expect("single macrospin tangent mass should build a pencil matrix");
    let lambda = Complex64::new(0.0, 1.0);
    let mode = vec![Complex64::new(1.0, 0.0), Complex64::new(0.0, -1.0)];

    let (absolute, relative, linf) =
        gyrotropic_pencil_residual_norms(&stiffness_omega, &gyrotropic, lambda, &mode);

    assert!(absolute < 1.0e-14);
    assert!(relative < 1.0e-14);
    assert!(linf < 1.0e-14);
    validate_native_modal_lambda_frequency_mapping(
        lambda.im,
        lambda.im,
        1.0 / std::f64::consts::TAU,
    )
    .expect("lambda=i*omega maps to positive frequency for the accepted branch");
}

#[test]
fn native_modal_lambda_i_omega_mapping_rejects_negative_branch() {
    let error =
        validate_native_modal_lambda_frequency_mapping(-1.0, 1.0, 1.0 / std::f64::consts::TAU)
            .expect_err("negative-frequency conjugate branch must not pass as accepted mode");

    assert!(error.message.contains("positive-frequency branch"));
}

#[test]
fn damping_linewidth_uses_exp_i_omega_t_decay_sign() {
    let alpha = 0.05;
    let factor = damping_imaginary_factor(alpha, EigenDampingPolicyIR::Include);

    assert!(factor > 0.0);
    assert!((factor - alpha / (1.0 + alpha * alpha)).abs() < 1.0e-15);
    assert_eq!(
        damping_imaginary_factor(alpha, EigenDampingPolicyIR::Ignore),
        0.0
    );
    assert_eq!(
        damping_imaginary_factor(-alpha, EigenDampingPolicyIR::Include),
        factor
    );
}

#[test]
fn dispersion_csv_maps_positive_imaginary_frequency_to_fwhm_linewidth() {
    let modes = serde_json::json!([
        {
            "index": 3,
            "frequency_hz": 1.0e9,
            "frequency_imag_hz": 2.5e6,
            "angular_frequency_rad_per_s": 2.0 * std::f64::consts::PI * 1.0e9,
            "residual_norm": 1.0e-9
        }
    ]);

    let csv = dispersion_v2_csv(None, &modes, &BTreeSet::from([3_u64]));
    let header = csv
        .lines()
        .next()
        .expect("dispersion CSV should include a header");
    assert!(header.contains("tracking_score_source"));
    assert!(header.contains("mode_field_id"));
    assert!(header.contains("mode_field_resource_key"));
    let row = csv
        .lines()
        .nth(1)
        .expect("dispersion CSV should include one data row");
    let columns: Vec<&str> = row.split(',').collect();

    assert_eq!(columns[6], "3");
    assert_eq!(columns[7], "3");
    assert_eq!(columns[10], "5.0000000000000000e6");
    assert_eq!(columns[13], "seed");
    assert_eq!(columns[14], "analysis:eigen:sample-0000:mode-0003");
    assert_eq!(
            columns[15],
            "/v2/sessions/current/data/fields/analysis:eigen:sample-0000:mode-0003/samples/vector?view=phase_rotated_real&phase_rad=0"
        );
}

#[test]
fn non_window_sparse_lobpcg_keeps_requested_count() {
    let target = fullmag_ir::EigenTargetIR::Lowest;

    assert_eq!(sparse_lobpcg_candidate_count(&target, 20, 200), 20);
}

#[test]
fn sparse_frequency_window_without_retained_modes_fails_clearly() {
    let target = fullmag_ir::EigenTargetIR::FrequencyWindow {
        frequency_min_hz: 1.0,
        frequency_max_hz: 2.0,
    };

    let error = reject_empty_frequency_window_result(&target, 60, 60, 0)
        .expect_err("empty sparse frequency-window results must not look successful");
    assert!(error
        .message
        .contains("cannot guarantee interior-window coverage"));
}

#[test]
fn frequency_window_solver_diagnostics_publish_completeness() {
    let plan = minimal_native_modal_plan();

    let diagnostics = modal_solver_diagnostics_json(&plan, "cpu_sparse_lobpcg", 6);

    assert_eq!(
        diagnostics
            .get("resolved_solver_family")
            .and_then(|value| value.as_str()),
        Some("cpu_sparse_lobpcg")
    );
    assert_eq!(
        diagnostics
            .get("spectral_transform")
            .and_then(|value| value.as_str()),
        Some("none")
    );
    assert_eq!(
        diagnostics
            .get("window_completeness")
            .and_then(|value| value.get("policy"))
            .and_then(|value| value.as_str()),
        Some("best_effort")
    );
    assert_eq!(
        diagnostics
            .get("requested_mode_count")
            .and_then(|value| value.as_u64()),
        Some(u64::from(plan.count))
    );
    assert_eq!(
        diagnostics
            .get("window_completeness")
            .and_then(|value| value.get("status"))
            .and_then(|value| value.as_str()),
        Some("not_certified")
    );
    assert!(diagnostics
        .get("subwindows")
        .and_then(|value| value.as_array())
        .is_some_and(|subwindows| !subwindows.is_empty()));
    let first_subwindow = &diagnostics
        .get("subwindows")
        .and_then(|value| value.as_array())
        .expect("subwindows must be present")[0];
    let requested_hz = first_subwindow
        .get("requested_hz")
        .and_then(|value| value.as_array())
        .expect("subwindow requested_hz must be present");
    let expected_shift_frequency_hz = 0.5
        * (requested_hz[0]
            .as_f64()
            .expect("requested lower bound must be numeric")
            + requested_hz[1]
                .as_f64()
                .expect("requested upper bound must be numeric"));
    let shift_frequency_hz = first_subwindow
        .get("shift_frequency_hz")
        .and_then(|value| value.as_f64())
        .expect("subwindow shift_frequency_hz must be present");
    let legacy_shift_hz = first_subwindow
        .get("shift_hz")
        .and_then(|value| value.as_f64())
        .expect("subwindow shift_hz must be present");
    assert_eq!(shift_frequency_hz, legacy_shift_hz);
    assert_eq!(shift_frequency_hz, expected_shift_frequency_hz);
    assert_eq!(
        first_subwindow
            .get("shift_omega_rad_s")
            .and_then(|value| value.as_f64()),
        Some(2.0 * std::f64::consts::PI * shift_frequency_hz)
    );
}

#[test]
fn native_frequency_window_solver_diagnostics_publish_mode_count() {
    let mut plan = minimal_native_modal_plan();
    plan.count = 10;
    plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
        frequency_min_hz: 1.0e8,
        frequency_max_hz: 5.0e9,
    };
    let diagnostics_json = serde_json::json!({
        "accepted_mode_count": 1,
        "accepted_mode_count_after_dedup": 1,
        "resolved_solver_family": "shift_invert",
        "solver_model": "slepc_multi_shift_invert_production_cpu_dense",
        "spectral_transform": "shift_invert",
        "requested_window_hz": [1.0e8, 5.0e9],
        "resolved_search_window_hz": [7.5e7, 5.125e9],
        "window_completeness": {
            "policy": "certified_count",
            "status": "not_certified",
            "certification_method": "none",
            "estimated_modes_in_window": 0,
            "certified_modes_in_window": 0,
            "additional_modes_may_exist": true,
        },
        "subwindows": [
            {
                "index": 0,
                "requested_hz": [1.0e8, 5.0e9],
                "search_hz": [7.5e7, 5.125e9],
                "shift_hz": 2.55e9,
                "shift_frequency_hz": 2.55e9,
                "shift_omega_rad_s": std::f64::consts::TAU * 2.55e9,
                "outer_iterations": 1,
                "linear_iterations_total": 1,
                "candidate_modes": 12,
                "accepted_modes": 1,
                "residual_max": 0.0,
                "stop_reason": "converged",
            }
        ],
    });

    let diagnostics_raw =
        serde_json::to_string(&diagnostics_json).expect("diagnostics JSON should serialize");
    let diagnostics = native_solver_diagnostics_json(&plan, &diagnostics_raw, None, None)
        .expect("native diagnostics should be normalized");

    assert_eq!(
        diagnostics
            .get("mode_count")
            .and_then(|value| value.as_u64()),
        Some(1)
    );
    assert_eq!(
        diagnostics
            .get("requested_mode_count")
            .and_then(|value| value.as_u64()),
        Some(10)
    );
}

#[test]
fn native_poisson_airbox_result_metrics_are_preserved_in_solver_diagnostics() {
    let plan = minimal_native_modal_plan();
    let diagnostics_raw = serde_json::json!({
        "resolved_solver_family": "shift_invert",
        "solver_model": "reference_full_2x2_tangent",
        "spectral_transform": "shift_invert",
        "spectral_pencil_kind": "real_frequency_rotated",
        "target_representation": "tau=omega_target",
        "target_tau_rad_s": 2.5e10,
        "outer_boundary_kind": "pure_neumann",
        "robin_beta": 0.0,
        "gauge_policy": "mean_zero_augmented",
        "gauge_reason": "pure_neumann_nullspace",
        "assembly_kind": "mfem_weak_form_shared_domain",
        "metrics": {
            "magnetic_block_backward_error": 4.0e-10,
            "poisson_block_backward_error": 7.0e-10,
            "gauge_constraint_backward_error": 2.0e-10,
            "slepc_reported_backward_error": 1.0e-12,
        },
    })
    .to_string();
    let result_raw = serde_json::json!({
        "solver_adapter": "k0_poisson_airbox_cpu_full_coupled_slepc",
        "demag_kind": "periodic_airbox_k0",
        "gauge_policy": "mean_zero_augmented",
        "q_dof_count": 2,
        "phi_dof_count": 8,
        "augmented_dof_count": 9,
        "augmented_phi_dof_count": 9,
        "slepc": {
            "accepted_mode_count": 1,
        },
        "metrics": {
            "poisson_constraint_relative_residual": 2.0e-15,
            "full_residual_reconstruction_relative_error": 8.0e-26,
            "relative_reference_frequency_error": 3.0e-16,
        },
        "eigenpair": {
            "omega_rad_s": 2.5e10,
            "frequency_hz": 4.0e9,
        },
    })
    .to_string();

    let diagnostics =
        native_solver_diagnostics_json(&plan, &diagnostics_raw, Some(&result_raw), None)
            .expect("native PA-E2 diagnostics should be normalized");

    assert_eq!(
        diagnostics["solver_adapter"],
        "k0_poisson_airbox_cpu_full_coupled_slepc"
    );
    assert_eq!(
        diagnostics["solver_model"],
        "k0_poisson_airbox_cpu_full_coupled_slepc"
    );
    assert_eq!(
        diagnostics["resolved_solver_family"],
        "k0_poisson_airbox_full_coupled"
    );
    assert_eq!(diagnostics["demag_kind"], "periodic_airbox_k0");
    assert_eq!(diagnostics["augmented_phi_dof_count"], 9);
    assert_eq!(
        diagnostics["poisson_constraint_relative_residual"]
            .as_f64()
            .unwrap(),
        2.0e-15
    );
    assert_eq!(
        diagnostics["relative_reference_frequency_error"]
            .as_f64()
            .unwrap(),
        3.0e-16
    );
    assert_eq!(
        diagnostics["physics_contract_version"],
        "micromagnetics_frequency_domain_v5"
    );
    assert_eq!(diagnostics["implementation_state"], "executable");
    assert_eq!(diagnostics["validation_state"], "unvalidated");
    assert_eq!(diagnostics["execution_lane"], "production_cpu");
    assert_eq!(diagnostics["production_periodic_airbox_claim"], true);
    assert_eq!(diagnostics["resolved_execution"]["device"], "cpu");
    assert_eq!(
        diagnostics["resolved_execution"]["native_backend"],
        "native_cpu"
    );
    assert_eq!(
        diagnostics["resolved_execution"]["reference_or_production"],
        "production"
    );
    assert_eq!(
        diagnostics["spectral"]["spectral_scalar_mode"],
        "real_split"
    );
    assert_eq!(
        diagnostics["spectral"]["spectral_pencil_kind"],
        "real_frequency_rotated"
    );
    assert_eq!(
        diagnostics["spectral"]["target_representation"],
        "tau=omega_target"
    );
    assert_eq!(diagnostics["spectral"]["tau_rad_per_s"], 2.5e10);
    assert!(diagnostics["spectral"]
        .get("sigma_imag_rad_per_s")
        .is_none());
    assert_eq!(diagnostics["boundary_gauge"]["eta_row_present"], true);
    assert_eq!(diagnostics["block_residuals"]["eps_full"], 7.0e-10);
    assert_eq!(diagnostics["block_residuals"]["certified"], true);
    let metrics = native_poisson_airbox_k0_metrics_from_result_json(
        &diagnostics.to_string(),
        NativePoissonAirboxK0MetricsInput {
            mesh_resolution_m: 10.0e-9,
            airbox_size_m: 400.0e-9,
            magnetic_pair_count: 12,
            airbox_pair_count: 20,
            effective_magnetisation_a_per_m: 800_000.0,
        },
    )
    .expect("normalized solver diagnostics must retain K0 periodic-airbox metrics");
    assert_eq!(metrics.augmented_phi_dof_count, 9);
}

#[test]
fn native_poisson_airbox_gpu_contract_publishes_real_split_schur_metadata() {
    let plan = minimal_native_modal_plan();
    let diagnostics_raw = serde_json::json!({
        "status": "ok",
        "solver_adapter": "k0_poisson_airbox_gpu_petsc_slepc",
        "assembly_kind": "mfem_weak_form_shared_domain",
        "demag_kind": "periodic_airbox_k0",
        "eigensolver_operator_kind": "materialized_schur_cuda",
        "petsc_matrix_type": "seqaijcusparse",
        "petsc_vector_type": "seqcuda",
        "slepc_basis_vector_type": "seqcuda",
        "shift_pc_type": "ilu",
        "gpu_device_resident_modal_eigensolver": true,
        "persistent_solver_context": true,
        "full_residual_certified": true,
        "residual_tolerance": 1.0e-8,
        "metrics": {
            "magnetic_block_backward_error": 1.0e-10,
            "poisson_block_backward_error": 2.0e-10,
            "gauge_constraint_backward_error": 0.0,
        },
        "executed_subwindows": [
            {
                "subwindow_index": 0,
                "shift_frequency_hz": 1.0e9,
                "status": "ok",
                "converged_eigenpair_count": 2,
                "accepted_mode_count": 1,
                "accepted_frequencies_hz": [1.0e9]
            },
            {
                "subwindow_index": 1,
                "shift_frequency_hz": 2.0e9,
                "status": "failed",
                "converged_eigenpair_count": 1,
                "accepted_mode_count": 0
            }
        ],
    })
    .to_string();
    let result_raw = serde_json::json!({
        "solver_adapter": "k0_poisson_airbox_gpu_petsc_slepc",
        "demag_kind": "periodic_airbox_k0",
        "accepted_mode_count": 1,
        "q_dof_count": 56,
        "phi_dof_count": 52,
        "augmented_phi_dof_count": 52,
        "frequency_hz": 1.95e9,
        "omega_rad_s": std::f64::consts::TAU * 1.95e9,
    })
    .to_string();

    let diagnostics = native_solver_diagnostics_json(
        &plan,
        &diagnostics_raw,
        Some(&result_raw),
        Some(&native_fem::measured_modal_gpu_attestation_fixture()),
    )
    .expect("native GPU PA-E2 diagnostics should be normalized");

    assert_eq!(
        diagnostics["solver_model"],
        "k0_poisson_airbox_gpu_petsc_slepc"
    );
    assert_eq!(
        diagnostics["resolved_solver_family"],
        "device_resident_arnoldi_shift_invert"
    );
    assert_eq!(diagnostics["algebraic_form"], "schur_reduced_descriptor");
    assert_eq!(
        diagnostics["matrix_equation"],
        "L_eff q = lambda B_qq q; phi(q) = -P^-1 A_phiq q"
    );
    assert_eq!(diagnostics["spectral_transform"], "shift_invert");
    assert_eq!(
        diagnostics["spectral"]["spectral_scalar_mode"],
        "real_split"
    );
    assert_eq!(
        diagnostics["requested_execution"]["preconditioner"],
        "shifted_schur_device"
    );
    assert_eq!(diagnostics["scalable_selected_spectrum"], true);
    assert_eq!(
        diagnostics["requested_window_hz"],
        serde_json::json!([1.0e8, 5.0e9])
    );
    assert_eq!(
        diagnostics["resolved_search_window_hz"],
        serde_json::json!([1.0e8, 5.0e9])
    );
    assert_eq!(
        diagnostics["window_completeness"]["status"],
        "not_certified"
    );
    assert_eq!(diagnostics["subwindows"][0]["subwindow_index"], 0);
    assert_eq!(
        diagnostics["subwindows"][0]["accepted_frequencies_hz"],
        serde_json::json!([1.0e9])
    );
    assert_eq!(diagnostics["subwindows"][1]["status"], "solve_error");
    assert_eq!(diagnostics["subwindows"][1]["candidate_mode_count"], 0);
    assert_eq!(
        diagnostics["subwindows"][1]["accepted_frequencies_hz"],
        serde_json::json!([])
    );
}

#[test]
fn native_poisson_airbox_gpu_adapter_without_attestation_fails_closed() {
    let plan = minimal_native_modal_plan();
    let diagnostics_raw = serde_json::json!({
        "status": "ok",
        "solver_adapter": "k0_poisson_airbox_gpu_petsc_slepc",
        "assembly_kind": "mfem_weak_form_shared_domain",
    })
    .to_string();

    let error = native_solver_diagnostics_json(&plan, &diagnostics_raw, None, None)
        .expect_err("adapter text must not create a GPU execution claim");
    assert_eq!(error.message, "k0_poisson_airbox_gpu_attestation_missing");
}

#[test]
fn native_production_poisson_airbox_diagnostics_reject_missing_boundary_contract() {
    let plan = minimal_native_modal_plan();
    let diagnostics_raw = serde_json::json!({
        "status": "ok",
        "solver_adapter": "k0_poisson_airbox_gpu_petsc_slepc",
        "assembly_kind": "mfem_weak_form_shared_domain",
        "production_implication": true,
        "full_residual_certified": true,
        "residual_tolerance": 1.0e-8,
        "metrics": {
            "magnetic_block_backward_error": 1.0e-10,
            "poisson_block_backward_error": 2.0e-10,
            "gauge_constraint_backward_error": 0.0,
        },
    })
    .to_string();

    let error = native_solver_diagnostics_json(&plan, &diagnostics_raw, None, None)
        .expect_err("production diagnostics must not default missing boundary metadata");
    assert!(error.message.contains("outer_boundary_kind"));
}

#[test]
fn native_poisson_airbox_top_level_accepted_mode_count_is_preserved() {
    let plan = minimal_native_modal_plan();
    let diagnostics_raw = serde_json::json!({
        "resolved_solver_family": "shift_invert",
        "solver_model": "reference_full_2x2_tangent",
        "spectral_transform": "shift_invert",
    })
    .to_string();
    let result_raw = serde_json::json!({
        "solver_adapter": "k0_poisson_airbox_cpu_schur_slepc",
        "accepted_mode_count": 3,
    })
    .to_string();

    let diagnostics =
        native_solver_diagnostics_json(&plan, &diagnostics_raw, Some(&result_raw), None)
            .expect("native Schur diagnostics should be normalized");

    assert_eq!(diagnostics["accepted_mode_count"], 3);
}

#[test]
fn native_poisson_airbox_result_maps_to_k0_kittel_metrics() {
    let raw = serde_json::json!({
        "schema_version": "frequency_domain_modal_result.v1",
        "study_product": "modal_eigen",
        "solver_adapter": "k0_poisson_airbox_cpu_full_coupled_slepc",
        "demag_kind": "periodic_airbox_k0",
        "accepted_mode_count": 1,
        "q_dof_count": 2,
        "phi_dof_count": 4,
        "augmented_phi_dof_count": 5,
        "frequency_hz": 2.1e9,
        "omega_rad_s": std::f64::consts::TAU * 2.1e9,
        "poisson_constraint_relative_residual": 2.0e-11,
        "relative_reference_frequency_error": 4.0e-3,
    })
    .to_string();
    let metrics = native_poisson_airbox_k0_metrics_from_result_json(
        &raw,
        NativePoissonAirboxK0MetricsInput {
            mesh_resolution_m: 10.0e-9,
            airbox_size_m: 400.0e-9,
            magnetic_pair_count: 12,
            airbox_pair_count: 20,
            effective_magnetisation_a_per_m: 800_000.0,
        },
    )
    .expect("PA-E2 result JSON should map to K0-3 artifact metrics");

    assert_eq!(metrics.phi_dof_count, 4);
    assert_eq!(metrics.augmented_phi_dof_count, 5);
    assert_eq!(metrics.magnetic_pair_count, 12);
    assert_eq!(metrics.airbox_pair_count, 20);
    assert_eq!(metrics.effective_magnetisation_a_per_m, 800_000.0);
    assert_eq!(metrics.poisson_constraint_relative_residual, 2.0e-11);
    assert_eq!(metrics.relative_kittel_frequency_error, 4.0e-3);
}

#[test]
fn native_poisson_airbox_metrics_reject_wrong_solver_adapter() {
    let raw = serde_json::json!({
        "schema_version": "frequency_domain_modal_result.v1",
        "solver_adapter": "slepc_modal_eigen",
        "demag_kind": "periodic_airbox_k0",
        "phi_dof_count": 4,
        "augmented_phi_dof_count": 5,
        "poisson_constraint_relative_residual": 0.0,
        "relative_reference_frequency_error": 0.0,
    })
    .to_string();
    let err = native_poisson_airbox_k0_metrics_from_result_json(
        &raw,
        NativePoissonAirboxK0MetricsInput {
            mesh_resolution_m: 10.0e-9,
            airbox_size_m: 400.0e-9,
            magnetic_pair_count: 12,
            airbox_pair_count: 20,
            effective_magnetisation_a_per_m: 800_000.0,
        },
    )
    .expect_err("generic modal JSON must not populate periodic-airbox metrics");

    assert!(err.message.contains("solver_adapter"));
}

#[test]
fn native_poisson_airbox_result_without_modes_is_rejected() {
    let plan = minimal_native_modal_plan();
    let omega = std::f64::consts::TAU * 4.0e9;
    let raw = serde_json::json!({
        "schema_version": "frequency_domain_modal_result.v1",
        "study_product": "modal_eigen",
        "solver_adapter": "k0_poisson_airbox_cpu_full_coupled_slepc",
        "demag_kind": "periodic_airbox_k0",
        "accepted_mode_count": 1,
        "q_dof_count": 16,
        "phi_dof_count": 28,
        "augmented_phi_dof_count": 29,
        "frequency_hz": 4.0e9,
        "omega_rad_s": omega,
        "poisson_constraint_relative_residual": 2.0e-15,
        "relative_reference_frequency_error": 0.0,
    })
    .to_string();
    let stiffness = DMatrix::<f64>::zeros(4, 4);
    let mass = DMatrix::<f64>::identity(4, 4);
    let gyrotropic = vec![0.0; 16];

    let error = native_modal_modes_from_result_json(
        &plan,
        &raw,
        Some((&stiffness, &gyrotropic, &mass)),
        None,
    )
    .expect_err("PA-E2 scalar result must not fabricate a modal vector");
    assert!(error.message.contains("missing complete modes[]"));
}

#[test]
fn native_poisson_airbox_modes_use_q_payload_and_certified_residuals() {
    let plan = minimal_native_modal_plan();
    let omega = std::f64::consts::TAU * 4.0e9;
    let raw = serde_json::json!({
        "schema_version": "frequency_domain_modal_result.v1",
        "study_product": "modal_eigen",
        "solver_adapter": "k0_poisson_airbox_cpu_full_coupled_slepc",
        "demag_kind": "periodic_airbox_k0",
        "modes": [{
            "mode_q_real": [1.0, 0.0, 0.0, 0.0],
            "mode_q_imag": [0.0, 1.0, 0.0, 0.0],
            "mode_phi_real": [2.0, 3.0],
            "mode_phi_imag": [4.0, 5.0],
            "eigenvalue_real": 0.0,
            "eigenvalue_imag": omega,
            "omega_rad_s": omega,
            "frequency_hz": 4.0e9,
            "relative_residual": 2.0e-12,
            "full_residual_reconstruction_relative_error": 3.0e-12,
        }]
    })
    .to_string();
    let stiffness = DMatrix::<f64>::identity(4, 4);
    let mass = DMatrix::<f64>::identity(4, 4);
    let gyrotropic = vec![0.0; 16];

    let modes = native_modal_modes_from_result_json(
        &plan,
        &raw,
        Some((&stiffness, &gyrotropic, &mass)),
        None,
    )
    .expect("complete PA-E2 q mode payload should be accepted");
    assert_eq!(modes.len(), 1);
    assert_eq!(modes[0].vector.len(), 4);
    assert_eq!(modes[0].frequency_hz, 4.0e9);
    assert_eq!(modes[0].residual_relative_l2, 2.0e-12);
    assert!(modes[0].vector.iter().any(|value| value.norm() > 0.0));
    assert_eq!(modes[0].q_vector.len(), 4);
    assert_eq!(modes[0].phi_vector.len(), 2);
    assert_eq!(modes[0].cluster_id, 0);
    assert_eq!(modes[0].block_residual_q, 3.0e-12);
    assert_eq!(modes[0].block_residual_phi, 0.0);
    let normalization = 2.0_f64.sqrt();
    assert_eq!(
        modes[0].phi_vector[0],
        Complex64::new(2.0 / normalization, 4.0 / normalization)
    );
}

#[test]
fn native_shared_domain_modes_require_phi_and_block_residuals() {
    let plan = minimal_native_modal_plan();
    let omega = std::f64::consts::TAU * 4.0e9;
    let mut mode = serde_json::json!({
        "mode_q_real": [1.0, 0.0, 0.0, 0.0],
        "mode_q_imag": [0.0, 1.0, 0.0, 0.0],
        "mode_phi_real": [2.0, 3.0],
        "mode_phi_imag": [4.0, 5.0],
        "eigenvalue_real": 0.0,
        "eigenvalue_imag": omega,
        "omega_rad_s": omega,
        "frequency_hz": 4.0e9,
        "relative_residual": 2.0e-12,
        "full_residual_reconstruction_relative_error": 3.0e-12,
    });
    let mass = DMatrix::<f64>::identity(4, 4);
    let active_nodes = [0_usize, 1_usize];
    let magnetic_classes = [0_u32, 1_u32];
    let context = SharedDomainModeContext {
        reduced_tangent_mass: &mass,
        active_nodes: &active_nodes,
        magnetic_classes: &magnetic_classes,
        magnetic_class_count: 2,
    };
    let error = native_poisson_airbox_mode_from_json(&plan, &mode, &mass, Some(&context))
        .expect_err("shared-domain mode must include certified block residuals");
    assert!(error.message.contains("magnetic_block_backward_error"));

    mode["magnetic_block_backward_error"] = serde_json::json!(3.0e-12);
    mode["poisson_block_backward_error"] = serde_json::json!(4.0e-12);
    mode["gauge_constraint_backward_error"] = serde_json::json!(0.0);
    let accepted = native_poisson_airbox_mode_from_json(&plan, &mode, &mass, Some(&context))
        .expect("complete shared-domain mode should be accepted");
    assert_eq!(accepted.block_residual_q, 3.0e-12);
    assert_eq!(accepted.block_residual_phi, 4.0e-12);
    assert_eq!(accepted.block_residual_gauge, 0.0);
}

#[test]
fn native_cpu_modal_window_accepts_explicit_gamma_single_k() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.k_sampling = Some(KSamplingIR::Single {
        k_vector: [0.0, 0.0, 0.0],
    });

    assert!(
        native_cpu_modal_window_enabled(&plan),
        "explicit gamma-point single-k sampling must not demote the production CPU window path"
    );
}

#[test]
fn shared_domain_modal_scope_requires_uniform_accepted_equilibrium() {
    let plan = minimal_native_modal_plan();
    let topology = MeshTopology::from_ir(&plan.mesh).expect("minimal FEM mesh is valid");
    let observables = scope_observables(plan.mesh.nodes.len(), 0.0);
    let mut equilibrium = plan.equilibrium_magnetization.clone();
    equilibrium[1] = [0.0, 1.0, 0.0];
    let error = validate_shared_domain_modal_scope(&plan, &topology, &equilibrium, &observables)
        .expect_err("nonuniform equilibrium must remain outside the first production scope");
    assert!(error.message.contains("uniform normalized equilibrium"));
}

#[test]
fn shared_domain_modal_scope_rejects_uncertified_local_tangent_terms() {
    let mut plan = minimal_native_modal_plan();
    plan.material.uniaxial_anisotropy = Some(1.0e3);
    let topology = MeshTopology::from_ir(&plan.mesh).expect("minimal FEM mesh is valid");
    let observables = scope_observables(plan.mesh.nodes.len(), 0.0);
    let error = validate_shared_domain_modal_scope(
        &plan,
        &topology,
        &plan.equilibrium_magnetization,
        &observables,
    )
    .expect_err("uncertified anisotropy tangent must be rejected");
    assert!(error.message.contains("anisotropy and DMI tangent terms"));
}

#[test]
fn native_cpu_modal_window_accepts_k0_periodic_airbox_with_v6_producer() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.operator.include_demag = true;
    plan.enable_demag = true;
    add_minimal_shared_domain_periodic_airbox(&mut plan);
    plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
        kind: "k0_kittel_field_sweep".to_string(),
        case_id: Some("K0-3".to_string()),
        demag_kind: Some("periodic_airbox_k0".to_string()),
        model: "thin_film_in_plane".to_string(),
        field_units: "A_per_m".to_string(),
        relative_tolerance: 0.05,
        material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
            effective_magnetisation: Some(800_000.0),
        },
        samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
            sample_index: 0,
            bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
        }],
    });

    assert!(native_cpu_modal_window_enabled(&plan));
    assert_eq!(native_cpu_modal_window_rejection_reason(&plan), None);
}

#[test]
fn native_cpu_modal_window_does_not_require_kittel_validation_metadata() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.operator.include_demag = true;
    plan.enable_demag = true;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.target = fullmag_ir::EigenTargetIR::Nearest {
        frequency_hz: 2.0e9,
    };
    add_minimal_shared_domain_periodic_airbox(&mut plan);
    plan.k_sampling = Some(KSamplingIR::Single {
        k_vector: [0.0, 0.0, 0.0],
    });

    assert!(
        plan.k0_kittel_validation.is_none(),
        "this routing test must not carry an analytical Kittel validator"
    );
    assert!(!native_cpu_modal_window_enabled(&plan));
    assert_eq!(
        native_cpu_modal_window_rejection_reason(&plan),
        Some("production_cpu_modal_periodic_airbox_k0_payload_missing")
    );
}

#[test]
fn native_gpu_k0_modal_selection_does_not_require_kittel_validation_metadata() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.operator.include_demag = false;
    plan.enable_demag = false;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.k_sampling = Some(KSamplingIR::Single {
        k_vector: [0.0, 0.0, 0.0],
    });

    assert!(plan.k0_kittel_validation.is_none());
    assert!(
        native_gpu_k0_kittel_modal_supported(&plan),
        "physical no-demag K0 GPU selection must not depend on analytical validation metadata"
    );
}

#[test]
fn native_gpu_k0_modal_selection_rejects_nonzero_k_without_kittel_oracle() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.operator.include_demag = false;
    plan.enable_demag = false;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.k_sampling = Some(KSamplingIR::Single {
        k_vector: [1.0e6, 0.0, 0.0],
    });

    assert!(!native_gpu_k0_kittel_modal_supported(&plan));
}

#[test]
fn shared_domain_builder_rejects_missing_accepted_linearization_state() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.operator.include_demag = true;
    plan.enable_demag = true;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.target = fullmag_ir::EigenTargetIR::Nearest {
        frequency_hz: 2.0e9,
    };
    plan.spin_wave_bc = SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
        kind: SpinWaveBoundaryKindIR::Periodic,
        boundary_pair_id: None,
        pair_ids: vec!["magnetic".to_string(), "airbox".to_string()],
        phase_convention: fullmag_ir::PhaseConventionIR::default(),
        surface_anisotropy_ks: None,
        surface_anisotropy_axis: None,
    });
    plan.mesh.nodes = vec![
        [0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 0.0],
        [1.0, 1.0, 0.0],
        [1.0, 0.0, 1.0],
        [2.0, 0.0, 0.0],
        [2.0, 1.0, 0.0],
        [2.0, 0.0, 1.0],
        [3.0, 0.0, 0.0],
        [3.0, 1.0, 0.0],
        [3.0, 0.0, 1.0],
    ];
    plan.mesh.set_tet4_cells(vec![
        [0, 1, 2, 3],
        [3, 5, 4, 0],
        [6, 7, 8, 9],
        [9, 11, 10, 6],
    ]);
    plan.mesh.element_markers = vec![1, 1, 0, 0];
    plan.mesh
        .set_tri3_facets(vec![[0, 1, 2], [3, 5, 4], [6, 7, 8], [9, 11, 10]]);
    plan.mesh.boundary_markers = vec![10, 11, 20, 21];
    plan.equilibrium_magnetization = vec![[1.0, 0.0, 0.0]; 12];
    plan.mesh.periodic_node_pairs = vec![
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "magnetic".to_string(),
            node_a: 0,
            node_b: 3,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "magnetic".to_string(),
            node_a: 1,
            node_b: 4,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "magnetic".to_string(),
            node_a: 2,
            node_b: 5,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "airbox".to_string(),
            node_a: 6,
            node_b: 9,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "airbox".to_string(),
            node_a: 7,
            node_b: 10,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "airbox".to_string(),
            node_a: 8,
            node_b: 11,
        },
    ];
    plan.mesh.periodic_boundary_pairs = vec![
        fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "magnetic".to_string(),
            marker_a: 10,
            marker_b: 11,
            translation: Some([1.0, 0.0, 0.0]),
            source_marker: None,
            destination_marker: None,
            tolerance: None,
            axis_hint: None,
            orientation: None,
            pairing_policy: None,
        },
        fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "airbox".to_string(),
            marker_a: 20,
            marker_b: 21,
            translation: Some([1.0, 0.0, 0.0]),
            source_marker: None,
            destination_marker: None,
            tolerance: None,
            axis_hint: None,
            orientation: None,
            pairing_policy: None,
        },
    ];
    plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
        factor: 2.0,
        grading: 1.2,
        boundary_marker: 0,
        bc_kind: Some("pure_neumann".to_string()),
        robin_beta_mode: None,
        robin_beta_factor: None,
        shape: Some("bbox".to_string()),
        factor_source: Some("test".to_string()),
        boundary_marker_source: Some("test".to_string()),
    });

    let topology = MeshTopology::from_ir(&plan.mesh).expect("test mesh is valid");
    let reduction = build_reduction_map(&topology, &plan.spin_wave_bc, plan.k_sampling.as_ref())
        .expect("periodic reduction should be valid");
    assert!(
        reduction.active_nodes.len()
            < topology
                .magnetic_node_volumes
                .iter()
                .filter(|volume| **volume > 0.0)
                .count(),
        "the fixture must actually reduce a magnetic periodic class"
    );
    let bases = tangent_bases(&plan.equilibrium_magnetization);
    let observables = scope_observables(plan.mesh.nodes.len(), 0.0);
    let (reduced_stiffness, _) = assemble_full_2x2_operator_real(
        &plan,
        &topology,
        &reduction,
        &observables,
        &plan.equilibrium_magnetization,
        &bases,
    );
    assert_eq!(
        reduced_stiffness.nrows(),
        2 * reduction.active_nodes.len(),
        "the pre-existing modal operator is class-reduced and must not be sent as A_qq"
    );

    let rejection = build_native_shared_domain_modal_problem(
        &plan,
        &topology,
        &plan.equilibrium_magnetization,
        &observables,
        None,
        0,
    )
    .expect_err("shared-domain K0 must require an accepted linearization state");
    assert!(
        rejection
            .message
            .contains("requires an accepted linearization state"),
        "missing accepted state must fail closed before descriptor construction: {}",
        rejection.message
    );
}

#[test]
fn shared_domain_builder_rejects_implicit_region_markers_before_native_assembly() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.operator.include_demag = true;
    plan.enable_demag = true;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.target = fullmag_ir::EigenTargetIR::Nearest {
        frequency_hz: 2.0e9,
    };
    add_minimal_shared_domain_periodic_airbox(&mut plan);
    plan.mesh.element_markers.fill(1);

    let topology = MeshTopology::from_ir(&plan.mesh).expect("test mesh is valid");
    let observables = scope_observables(plan.mesh.nodes.len(), 0.0);
    let rejection = build_native_shared_domain_modal_problem(
        &plan,
        &topology,
        &plan.equilibrium_magnetization,
        &observables,
        None,
        0,
    )
    .expect_err("shared-domain K0 must require explicit magnetic/airbox markers");
    assert!(
        rejection
            .message
            .contains("k0_poisson_airbox_requires_explicit_region_markers"),
        "implicit region markers must fail closed before native assembly: {}",
        rejection.message
    );
}

#[test]
fn native_gpu_shared_domain_requires_operator_demag_flag() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.operator.include_demag = true;
    plan.enable_demag = true;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.target = fullmag_ir::EigenTargetIR::Nearest {
        frequency_hz: 2.0e9,
    };
    add_minimal_shared_domain_periodic_airbox(&mut plan);

    assert!(native_gpu_shared_domain_modal_supported(&plan));
    plan.operator.include_demag = false;
    assert!(!native_gpu_shared_domain_modal_supported(&plan));
}

#[test]
fn shared_domain_k0_v6_producer_unlocks_native_magnetic_gate() {
    let mut plan = minimal_native_modal_plan();
    add_minimal_shared_domain_periodic_airbox(&mut plan);
    assert!(native_shared_domain_magnetic_assembly_available(&plan));

    let mut stale_part = plan.clone();
    stale_part.mesh_parts[0].id = "part:stale".to_string();
    assert!(!native_shared_domain_magnetic_assembly_available(
        &stale_part
    ));

    let mut stale_certificate_input = plan;
    stale_certificate_input.mesh.periodic_node_pairs.pop();
    assert!(!native_shared_domain_magnetic_assembly_available(
        &stale_certificate_input
    ));
}

#[test]
fn shared_domain_k0_diagnostics_do_not_publish_stale_producer_rejection() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.operator.include_demag = true;
    plan.enable_demag = true;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.target = fullmag_ir::EigenTargetIR::Nearest {
        frequency_hz: 2.0e9,
    };
    add_minimal_shared_domain_periodic_airbox(&mut plan);

    let diagnostics = modal_solver_diagnostics_json(&plan, "cpu_full_2x2_phase_reduced", 1);
    assert!(diagnostics.get("production_cpu_rejection_reason").is_none());
    assert!(diagnostics.get("runtime_capability_status").is_none());
    assert!(diagnostics.get("runtime_capability_reason").is_none());
}

#[test]
fn zero_k_path_is_gamma_for_shared_domain_modal_dispatch() {
    let zero_path = KSamplingIR::Path {
        points: vec![
            fullmag_ir::KPointIR::gamma(),
            fullmag_ir::KPointIR {
                label: Some("same-gamma".to_string()),
                k_vector: [0.0, -0.0, 0.0],
            },
        ],
        samples_per_segment: vec![1],
        closed: false,
    };
    assert!(is_gamma_k_sampling(Some(&zero_path)));

    let nonzero_path = KSamplingIR::Path {
        points: vec![
            fullmag_ir::KPointIR::gamma(),
            fullmag_ir::KPointIR {
                label: Some("finite-k".to_string()),
                k_vector: [1.0, 0.0, 0.0],
            },
        ],
        samples_per_segment: vec![1],
        closed: false,
    };
    assert!(!is_gamma_k_sampling(Some(&nonzero_path)));
}

#[test]
fn pa_e4b_k0_kittel_builder_creates_full_coupled_poisson_airbox_payload() {
    let mut plan = minimal_native_modal_plan();
    plan.target = fullmag_ir::EigenTargetIR::Nearest {
        frequency_hz: 1.25e9,
    };
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.operator.include_demag = true;
    plan.enable_demag = true;
    plan.gyromagnetic_ratio = 2.211e5;
    plan.mesh.nodes = vec![
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [2.0, 0.0, 0.0],
        [3.0, 0.0, 0.0],
        [2.0, 1.0, 0.0],
        [2.0, 0.0, 1.0],
    ];
    plan.mesh.set_tet4_cells(vec![[0, 1, 2, 3], [4, 5, 6, 7]]);
    plan.mesh.element_markers = vec![1, 0];
    plan.mesh.periodic_node_pairs = vec![
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "x".to_string(),
            node_a: 0,
            node_b: 1,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "y".to_string(),
            node_a: 4,
            node_b: 5,
        },
    ];
    plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
        factor: 2.0,
        grading: 1.2,
        boundary_marker: 99,
        bc_kind: Some("dirichlet".to_string()),
        robin_beta_mode: None,
        robin_beta_factor: None,
        shape: Some("bbox".to_string()),
        factor_source: Some("test".to_string()),
        boundary_marker_source: Some("test".to_string()),
    });
    plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
        kind: "k0_kittel_field_sweep".to_string(),
        case_id: Some("K0-3".to_string()),
        demag_kind: Some("periodic_airbox_k0".to_string()),
        model: "thin_film_in_plane".to_string(),
        field_units: "A_per_m".to_string(),
        relative_tolerance: 0.05,
        material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
            effective_magnetisation: Some(800_000.0),
        },
        samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
            sample_index: 0,
            bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
        }],
    });

    let payload = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
        .expect("PA-E4b builder should accept a K0-3 periodic-airbox plan")
        .expect("K0-3 periodic-airbox plan should produce a payload");
    let borrowed = payload.borrowed();

    assert_eq!(borrowed.q_dof_count, 2);
    assert_eq!(borrowed.phi_dof_count, 2);
    assert_eq!(
        borrowed.periodic_mesh_certificate_schema,
        "periodic_mesh_certificate.v6"
    );
    assert_eq!(borrowed.magnetic_pair_count, 1);
    assert_eq!(borrowed.airbox_pair_count, 1);
    assert_eq!(borrowed.phi_mean_weights, &[0.5, 0.5]);
    assert!(
        borrowed.a_qphi_csr.values.iter().any(|value| *value != 0.0),
        "PA-E4b payload must include nonzero magnetic feedback from phi"
    );
    assert!(
        borrowed.a_phiq_csr.values.iter().any(|value| *value != 0.0),
        "PA-E4b payload must include nonzero Poisson source from q"
    );
    assert_eq!(borrowed.target_frequency_hz, 1.25e9);
    assert_eq!(
        borrowed.expected_reference_frequency_hz, 0.0,
        "analytical Kittel reference must not enter the native solve request"
    );
}

#[test]
fn pa_e4b_k0_kittel_builder_scales_payload_dimensions_with_pair_maps() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.operator.include_demag = true;
    plan.enable_demag = true;
    plan.gyromagnetic_ratio = 2.211e5;
    plan.mesh.nodes = vec![
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [1.0, 1.0, 0.0],
        [1.0, 0.0, 1.0],
        [2.0, 0.0, 0.0],
        [3.0, 0.0, 0.0],
        [2.0, 1.0, 0.0],
        [2.0, 0.0, 1.0],
        [3.0, 1.0, 0.0],
        [3.0, 0.0, 1.0],
    ];
    plan.mesh.set_tet4_cells(vec![
        [0, 1, 2, 3],
        [1, 4, 2, 5],
        [6, 7, 8, 9],
        [7, 10, 8, 11],
    ]);
    plan.mesh.element_markers = vec![1, 1, 0, 0];
    plan.mesh.periodic_node_pairs = vec![
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "mx0".to_string(),
            node_a: 0,
            node_b: 1,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "mx1".to_string(),
            node_a: 2,
            node_b: 4,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "ax0".to_string(),
            node_a: 6,
            node_b: 7,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "ax1".to_string(),
            node_a: 8,
            node_b: 10,
        },
    ];
    plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
        factor: 2.0,
        grading: 1.2,
        boundary_marker: 99,
        bc_kind: Some("dirichlet".to_string()),
        robin_beta_mode: None,
        robin_beta_factor: None,
        shape: Some("bbox".to_string()),
        factor_source: Some("test".to_string()),
        boundary_marker_source: Some("test".to_string()),
    });
    plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
        kind: "k0_kittel_field_sweep".to_string(),
        case_id: Some("K0-3".to_string()),
        demag_kind: Some("periodic_airbox_k0".to_string()),
        model: "thin_film_in_plane".to_string(),
        field_units: "A_per_m".to_string(),
        relative_tolerance: 0.05,
        material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
            effective_magnetisation: Some(800_000.0),
        },
        samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
            sample_index: 0,
            bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
        }],
    });

    let payload = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
        .expect("PA-E4b builder should accept a K0-3 periodic-airbox plan")
        .expect("K0-3 periodic-airbox plan should produce a payload");
    let borrowed = payload.borrowed();

    assert_eq!(borrowed.magnetic_pair_count, 2);
    assert_eq!(borrowed.airbox_pair_count, 2);
    assert_eq!(borrowed.q_dof_count, 4);
    assert_eq!(borrowed.phi_dof_count, 4);
    assert_eq!(borrowed.phi_mean_weights, &[0.25, 0.25, 0.25, 0.25]);
    assert_eq!(borrowed.a_qq_csr.row_count, borrowed.q_dof_count);
    assert_eq!(borrowed.a_qphi_csr.column_count, borrowed.phi_dof_count);
    assert_eq!(borrowed.a_phiq_csr.row_count, borrowed.phi_dof_count);
    assert_eq!(borrowed.a_phiphi_csr.row_count, borrowed.phi_dof_count);
}

#[test]
fn pa_e4b_k0_kittel_builder_weights_poisson_block_by_airbox_pair_geometry() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.operator.include_demag = true;
    plan.enable_demag = true;
    plan.gyromagnetic_ratio = 2.211e5;
    plan.mesh.nodes = vec![
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [2.0, 0.0, 0.0],
        [3.0, 0.0, 0.0],
        [2.0, 1.0, 0.0],
        [2.0, 0.0, 1.0],
    ];
    plan.mesh.set_tet4_cells(vec![[0, 1, 2, 3], [4, 5, 6, 7]]);
    plan.mesh.element_markers = vec![1, 0];
    plan.mesh.periodic_node_pairs = vec![
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "mx".to_string(),
            node_a: 0,
            node_b: 1,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "ax".to_string(),
            node_a: 4,
            node_b: 5,
        },
    ];
    plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
        factor: 2.0,
        grading: 1.2,
        boundary_marker: 99,
        bc_kind: Some("dirichlet".to_string()),
        robin_beta_mode: None,
        robin_beta_factor: None,
        shape: Some("bbox".to_string()),
        factor_source: Some("test".to_string()),
        boundary_marker_source: Some("test".to_string()),
    });
    plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
        kind: "k0_kittel_field_sweep".to_string(),
        case_id: Some("K0-3".to_string()),
        demag_kind: Some("periodic_airbox_k0".to_string()),
        model: "thin_film_in_plane".to_string(),
        field_units: "A_per_m".to_string(),
        relative_tolerance: 0.05,
        material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
            effective_magnetisation: Some(800_000.0),
        },
        samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
            sample_index: 0,
            bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
        }],
    });

    let short_payload = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
        .expect("short airbox pair should be valid")
        .expect("short airbox pair should produce a payload");
    let short_values = short_payload.a_phiphi_csr.values.clone();

    plan.mesh.nodes[5] = [5.0, 0.0, 0.0];
    let long_payload = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
        .expect("long airbox pair should be valid")
        .expect("long airbox pair should produce a payload");

    assert_ne!(
        short_values, long_payload.a_phiphi_csr.values,
        "Poisson block weights must depend on airbox pair geometry, not only pair count"
    );
}

#[test]
fn pa_e4b_k0_kittel_builder_weights_phi_gauge_by_airbox_pair_geometry() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.operator.include_demag = true;
    plan.enable_demag = true;
    plan.gyromagnetic_ratio = 2.211e5;
    plan.mesh.nodes = vec![
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [1.0, 1.0, 0.0],
        [1.0, 0.0, 1.0],
        [2.0, 0.0, 0.0],
        [3.0, 0.0, 0.0],
        [2.0, 1.0, 0.0],
        [2.0, 0.0, 1.0],
        [4.0, 1.0, 0.0],
        [3.0, 0.0, 1.0],
    ];
    plan.mesh.set_tet4_cells(vec![
        [0, 1, 2, 3],
        [1, 4, 2, 5],
        [6, 7, 8, 9],
        [7, 10, 8, 11],
    ]);
    plan.mesh.element_markers = vec![1, 1, 0, 0];
    plan.mesh.periodic_node_pairs = vec![
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "mx0".to_string(),
            node_a: 0,
            node_b: 1,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "mx1".to_string(),
            node_a: 2,
            node_b: 4,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "ax0".to_string(),
            node_a: 6,
            node_b: 7,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "ax1".to_string(),
            node_a: 8,
            node_b: 10,
        },
    ];
    plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
        factor: 2.0,
        grading: 1.2,
        boundary_marker: 99,
        bc_kind: Some("dirichlet".to_string()),
        robin_beta_mode: None,
        robin_beta_factor: None,
        shape: Some("bbox".to_string()),
        factor_source: Some("test".to_string()),
        boundary_marker_source: Some("test".to_string()),
    });
    plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
        kind: "k0_kittel_field_sweep".to_string(),
        case_id: Some("K0-3".to_string()),
        demag_kind: Some("periodic_airbox_k0".to_string()),
        model: "thin_film_in_plane".to_string(),
        field_units: "A_per_m".to_string(),
        relative_tolerance: 0.05,
        material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
            effective_magnetisation: Some(800_000.0),
        },
        samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
            sample_index: 0,
            bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
        }],
    });

    let payload = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
        .expect("PA-E4b builder should accept unequal airbox pair lengths")
        .expect("PA-E4b builder should produce payload");
    let weights = payload.phi_mean_weights;
    let weight_sum = weights.iter().sum::<f64>();

    assert!(
        (weight_sum - 1.0).abs() < 1.0e-12,
        "phi gauge weights must be normalized, got {weights:?}"
    );
    assert!(
        weights[2] > weights[0],
        "longer airbox pair should carry larger mean-zero gauge weight, got {weights:?}"
    );
    assert!(
        (weights[0] - weights[1]).abs() < 1.0e-12 && (weights[2] - weights[3]).abs() < 1.0e-12,
        "two phi DOFs belonging to one airbox pair should share that pair weight, got {weights:?}"
    );
}

#[test]
fn pa_e4b_k0_kittel_builder_weights_mass_block_by_magnetic_element_volume() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.operator.include_demag = true;
    plan.enable_demag = true;
    plan.gyromagnetic_ratio = 2.211e5;
    plan.mesh.nodes = vec![
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [10.0, 0.0, 0.0],
        [12.0, 0.0, 0.0],
        [10.0, 2.0, 0.0],
        [10.0, 0.0, 2.0],
        [20.0, 0.0, 0.0],
        [21.0, 0.0, 0.0],
        [20.0, 1.0, 0.0],
        [20.0, 0.0, 1.0],
    ];
    plan.mesh
        .set_tet4_cells(vec![[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]]);
    plan.mesh.element_markers = vec![1, 1, 0];
    plan.mesh.periodic_node_pairs = vec![
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "mx0".to_string(),
            node_a: 0,
            node_b: 1,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "mx1".to_string(),
            node_a: 4,
            node_b: 5,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "ax0".to_string(),
            node_a: 8,
            node_b: 9,
        },
    ];
    plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
        factor: 2.0,
        grading: 1.2,
        boundary_marker: 99,
        bc_kind: Some("dirichlet".to_string()),
        robin_beta_mode: None,
        robin_beta_factor: None,
        shape: Some("bbox".to_string()),
        factor_source: Some("test".to_string()),
        boundary_marker_source: Some("test".to_string()),
    });
    plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
        kind: "k0_kittel_field_sweep".to_string(),
        case_id: Some("K0-3".to_string()),
        demag_kind: Some("periodic_airbox_k0".to_string()),
        model: "thin_film_in_plane".to_string(),
        field_units: "A_per_m".to_string(),
        relative_tolerance: 0.05,
        material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
            effective_magnetisation: Some(800_000.0),
        },
        samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
            sample_index: 0,
            bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
        }],
    });

    let payload = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
        .expect("PA-E4b builder should accept different magnetic volumes")
        .expect("PA-E4b builder should produce payload");
    let b_values = &payload.b_qq_csr.values;

    assert_eq!(payload.q_dof_count, 4);
    assert_eq!(payload.b_qq_csr.row_count, 4);
    assert_eq!(payload.b_qq_csr.column_count, 4);
    assert!(
        (b_values[0] - b_values[1]).abs() < 1.0e-18,
        "same magnetic pair tangent components must share the same mass"
    );
    assert!(
        (b_values[2] - b_values[3]).abs() < 1.0e-18,
        "same magnetic pair tangent components must share the same mass"
    );
    assert!(
        (b_values[2] - b_values[0]).abs() > b_values[0].abs() * 1.0,
        "B_qq masses must reflect different magnetic element volumes, got {b_values:?}"
    );
}

#[test]
fn pa_e4b_k0_kittel_builder_mass_weights_llg_block_consistently() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.damping_policy = fullmag_ir::EigenDampingPolicyIR::Ignore;
    plan.operator.include_demag = true;
    plan.enable_demag = true;
    plan.gyromagnetic_ratio = 2.211e5;
    plan.external_field = Some([50.0e-3 / crate::MU0, 0.0, 0.0]);
    plan.mesh.nodes = vec![
        [0.0, 0.0, 0.0],
        [20.0e-9, 0.0, 0.0],
        [0.0, 20.0e-9, 0.0],
        [0.0, 0.0, 10.0e-9],
        [30.0e-9, 0.0, 0.0],
        [50.0e-9, 0.0, 0.0],
        [30.0e-9, 20.0e-9, 0.0],
        [30.0e-9, 0.0, 20.0e-9],
    ];
    plan.mesh.set_tet4_cells(vec![[0, 1, 2, 3], [4, 5, 6, 7]]);
    plan.mesh.element_markers = vec![1, 0];
    plan.mesh.periodic_node_pairs = vec![
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "mx".to_string(),
            node_a: 0,
            node_b: 1,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "ax".to_string(),
            node_a: 4,
            node_b: 5,
        },
    ];
    plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
        factor: 2.0,
        grading: 1.2,
        boundary_marker: 99,
        bc_kind: Some("dirichlet".to_string()),
        robin_beta_mode: None,
        robin_beta_factor: None,
        shape: Some("bbox".to_string()),
        factor_source: Some("test".to_string()),
        boundary_marker_source: Some("test".to_string()),
    });
    plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
        kind: "k0_kittel_field_sweep".to_string(),
        case_id: Some("K0-3".to_string()),
        demag_kind: Some("periodic_airbox_k0".to_string()),
        model: "thin_film_in_plane".to_string(),
        field_units: "A_per_m".to_string(),
        relative_tolerance: 0.05,
        material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
            effective_magnetisation: Some(800_000.0),
        },
        samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
            sample_index: 0,
            bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
        }],
    });

    let payload = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
        .expect("PA-E4b builder should accept nanometer-scale mesh")
        .expect("PA-E4b builder should produce payload");
    let a_values = &payload.a_qq_csr.values;
    let b_values = &payload.b_qq_csr.values;
    let expected_omega = plan.gyromagnetic_ratio * vector_norm(plan.external_field.unwrap());

    let observed_omega = a_values[0].abs() / b_values[0];
    assert!(
        (observed_omega - expected_omega).abs() <= expected_omega * 1.0e-12,
        "A_qq/B_qq must preserve gamma*H0 scaling, got {observed_omega} expected {expected_omega}"
    );

    let max_phiq = payload
        .a_phiq_csr
        .values
        .iter()
        .map(|value| value.abs())
        .fold(0.0_f64, f64::max);
    let max_phiphi = payload
        .a_phiphi_csr
        .values
        .iter()
        .map(|value| value.abs())
        .fold(0.0_f64, f64::max);
    assert!(
            (0.05..=20.0).contains(&max_phiq),
            "A_phiq must be dimensionless-normalized for the mean-zero Poisson block, got max {max_phiq}"
        );
    assert!(
        (0.05..=40.0).contains(&max_phiphi),
        "A_phiphi must be dimensionless-normalized for nanometer meshes, got max {max_phiphi}"
    );
}

fn csr_value(matrix: &OwnedModalEigenCsrMatrix, row: usize, column: usize) -> f64 {
    let row_begin = matrix.row_offsets[row] as usize;
    let row_end = matrix.row_offsets[row + 1] as usize;
    for entry in row_begin..row_end {
        if matrix.column_indices[entry] as usize == column {
            return matrix.values[entry];
        }
    }
    0.0
}

#[test]
fn pa_e4b_k0_kittel_builder_calibrates_schur_demag_to_kittel_meff() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.damping_policy = fullmag_ir::EigenDampingPolicyIR::Ignore;
    plan.operator.include_demag = true;
    plan.enable_demag = true;
    plan.gyromagnetic_ratio = 2.211e5;
    plan.mesh.nodes = vec![
        [0.0, 0.0, 0.0],
        [20.0e-9, 0.0, 0.0],
        [0.0, 20.0e-9, 0.0],
        [0.0, 0.0, 10.0e-9],
        [30.0e-9, 0.0, 0.0],
        [50.0e-9, 0.0, 0.0],
        [30.0e-9, 20.0e-9, 0.0],
        [30.0e-9, 0.0, 20.0e-9],
    ];
    plan.mesh.set_tet4_cells(vec![[0, 1, 2, 3], [4, 5, 6, 7]]);
    plan.mesh.element_markers = vec![1, 0];
    plan.mesh.periodic_node_pairs = vec![
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "mx".to_string(),
            node_a: 0,
            node_b: 1,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "ax".to_string(),
            node_a: 4,
            node_b: 5,
        },
    ];
    plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
        factor: 2.0,
        grading: 1.2,
        boundary_marker: 99,
        bc_kind: Some("dirichlet".to_string()),
        robin_beta_mode: None,
        robin_beta_factor: None,
        shape: Some("bbox".to_string()),
        factor_source: Some("test".to_string()),
        boundary_marker_source: Some("test".to_string()),
    });
    plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
        kind: "k0_kittel_field_sweep".to_string(),
        case_id: Some("K0-3".to_string()),
        demag_kind: Some("periodic_airbox_k0".to_string()),
        model: "thin_film_in_plane".to_string(),
        field_units: "A_per_m".to_string(),
        relative_tolerance: 0.05,
        material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
            effective_magnetisation: Some(800_000.0),
        },
        samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
            sample_index: 0,
            bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
        }],
    });

    let payload = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
        .expect("PA-E4b builder should accept nanometer-scale mesh")
        .expect("PA-E4b builder should produce payload");
    assert_eq!(payload.q_dof_count, 2);
    assert_eq!(payload.phi_dof_count, 2);

    let source0 = csr_value(&payload.a_phiq_csr, 0, 1);
    let source1 = csr_value(&payload.a_phiq_csr, 1, 1);
    let p00 = csr_value(&payload.a_phiphi_csr, 0, 0);
    let p01 = csr_value(&payload.a_phiphi_csr, 0, 1);
    assert!(
        (source0 + source1).abs() < 1.0e-12,
        "single-pair Poisson source must be mean-zero, got [{source0}, {source1}]"
    );
    assert!(
        (p00 + p01).abs() < 1.0e-12,
        "single-pair Poisson row must be singular before gauge, got [{p00}, {p01}]"
    );
    let phi0_for_q1 = -source0 / (2.0 * p00);
    let phi1_for_q1 = -source1 / (2.0 * p00);
    let demag_feedback = csr_value(&payload.a_qphi_csr, 0, 0) * phi0_for_q1
        + csr_value(&payload.a_qphi_csr, 0, 1) * phi1_for_q1;
    let magnetic_mass = csr_value(&payload.b_qq_csr, 0, 0);
    let expected_feedback = -plan.gyromagnetic_ratio
        * plan
            .k0_kittel_validation
            .as_ref()
            .unwrap()
            .material
            .effective_magnetisation
            .unwrap()
        * magnetic_mass;

    assert!(
            (demag_feedback - expected_feedback).abs() <= expected_feedback.abs() * 1.0e-12,
            "Schur demag feedback must encode gamma*M_eff once, got {demag_feedback} expected {expected_feedback}"
        );
}

#[test]
fn pa_e4b_k0_kittel_builder_weights_demag_coupling_by_mesh_geometry() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.operator.include_demag = true;
    plan.enable_demag = true;
    plan.gyromagnetic_ratio = 2.211e5;
    plan.mesh.nodes = vec![
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [2.0, 0.0, 0.0],
        [3.0, 0.0, 0.0],
        [2.0, 1.0, 0.0],
        [2.0, 0.0, 1.0],
    ];
    plan.mesh.set_tet4_cells(vec![[0, 1, 2, 3], [4, 5, 6, 7]]);
    plan.mesh.element_markers = vec![1, 0];
    plan.mesh.periodic_node_pairs = vec![
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "mx".to_string(),
            node_a: 0,
            node_b: 1,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "ax".to_string(),
            node_a: 4,
            node_b: 5,
        },
    ];
    plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
        factor: 2.0,
        grading: 1.2,
        boundary_marker: 99,
        bc_kind: Some("dirichlet".to_string()),
        robin_beta_mode: None,
        robin_beta_factor: None,
        shape: Some("bbox".to_string()),
        factor_source: Some("test".to_string()),
        boundary_marker_source: Some("test".to_string()),
    });
    plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
        kind: "k0_kittel_field_sweep".to_string(),
        case_id: Some("K0-3".to_string()),
        demag_kind: Some("periodic_airbox_k0".to_string()),
        model: "thin_film_in_plane".to_string(),
        field_units: "A_per_m".to_string(),
        relative_tolerance: 0.05,
        material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
            effective_magnetisation: Some(800_000.0),
        },
        samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
            sample_index: 0,
            bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
        }],
    });

    let short_payload = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
        .expect("short airbox pair should be valid")
        .expect("short airbox pair should produce a payload");
    let short_a_qphi = short_payload.a_qphi_csr.values.clone();
    let short_a_phiq = short_payload.a_phiq_csr.values.clone();

    plan.mesh.nodes[5] = [5.0, 0.0, 0.0];
    let long_payload = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
        .expect("long airbox pair should be valid")
        .expect("long airbox pair should produce a payload");

    assert_ne!(
        short_a_qphi, long_payload.a_qphi_csr.values,
        "A_qphi coupling must depend on mesh geometry, not only H0/M_eff and pair count"
    );
    assert_ne!(
        short_a_phiq, long_payload.a_phiq_csr.values,
        "A_phiq coupling must depend on mesh geometry, not only pair count"
    );
}

#[test]
fn pa_e4b_k0_kittel_builder_rejects_missing_real_periodic_airbox_pair_maps() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.operator.include_demag = true;
    plan.enable_demag = true;
    plan.gyromagnetic_ratio = 2.211e5;
    plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
        kind: "k0_kittel_field_sweep".to_string(),
        case_id: Some("K0-3".to_string()),
        demag_kind: Some("periodic_airbox_k0".to_string()),
        model: "thin_film_in_plane".to_string(),
        field_units: "A_per_m".to_string(),
        relative_tolerance: 0.05,
        material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
            effective_magnetisation: Some(800_000.0),
        },
        samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
            sample_index: 0,
            bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
        }],
    });

    let err = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
        .expect_err("PA-E4b payload must require real magnetic and airbox pair maps");

    assert!(
        err.message
            .contains("requires positive magnetic and airbox periodic pair counts"),
        "unexpected error: {}",
        err.message
    );
    assert!(
            !native_cpu_modal_window_enabled(&plan),
            "K0-3 periodic_airbox_k0 must not enter native modal production without real magnetic and airbox pair maps"
        );
}

#[test]
fn pa_e4b_k0_kittel_builder_rejects_missing_airbox_geometry_metadata() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.operator.include_demag = true;
    plan.enable_demag = true;
    plan.gyromagnetic_ratio = 2.211e5;
    plan.mesh.nodes = vec![
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [2.0, 0.0, 0.0],
        [3.0, 0.0, 0.0],
        [2.0, 1.0, 0.0],
        [2.0, 0.0, 1.0],
    ];
    plan.mesh.set_tet4_cells(vec![[0, 1, 2, 3], [4, 5, 6, 7]]);
    plan.mesh.element_markers = vec![1, 0];
    plan.mesh.periodic_node_pairs = vec![
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "x".to_string(),
            node_a: 0,
            node_b: 1,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "y".to_string(),
            node_a: 4,
            node_b: 5,
        },
    ];
    plan.air_box_config = None;
    plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
        kind: "k0_kittel_field_sweep".to_string(),
        case_id: Some("K0-3".to_string()),
        demag_kind: Some("periodic_airbox_k0".to_string()),
        model: "thin_film_in_plane".to_string(),
        field_units: "A_per_m".to_string(),
        relative_tolerance: 0.05,
        material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
            effective_magnetisation: Some(800_000.0),
        },
        samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
            sample_index: 0,
            bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
        }],
    });

    let err = build_pa_e4b_k0_kittel_poisson_airbox_payload(&plan)
        .expect_err("PA-E4b payload must require real airbox geometry metadata");

    assert!(
        err.message
            .contains("requires positive air_box_config.factor and mesh extent"),
        "unexpected error: {}",
        err.message
    );
    assert!(
            !native_cpu_modal_window_enabled(&plan),
            "K0-3 periodic_airbox_k0 must not enter native modal production without airbox geometry metadata"
        );
}

#[test]
fn native_cpu_modal_window_rejects_nonzero_single_k_until_floquet_operator_exists() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.k_sampling = Some(KSamplingIR::Single {
        k_vector: [1.0e6, 0.0, 0.0],
    });

    assert!(
        !native_cpu_modal_window_enabled(&plan),
        "nonzero-k modal production still requires a real Floquet/Bloch operator path"
    );
}

#[test]
fn native_cpu_modal_window_accepts_nonzero_floquet_single_k_with_bloch_payload_path() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    add_x_floquet_pair_to_plan(&mut plan);

    assert!(
            native_cpu_modal_window_enabled(&plan),
            "nonzero-k Floquet Full2x2 frequency-window requests should use the native Bloch/Floquet payload path"
        );
    assert_eq!(native_cpu_modal_window_rejection_reason(&plan), None);
}

#[test]
fn reference_modal_diagnostics_name_nonzero_k_production_cpu_rejection() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.spin_wave_bc = SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
        kind: SpinWaveBoundaryKindIR::Floquet,
        boundary_pair_id: Some("x_faces".to_string()),
        pair_ids: Vec::new(),
        phase_convention: fullmag_ir::PhaseConventionIR::default(),
        surface_anisotropy_ks: None,
        surface_anisotropy_axis: None,
    });
    plan.k_sampling = Some(KSamplingIR::Single {
        k_vector: [1.0e6, 0.0, 0.0],
    });

    let diagnostics = modal_solver_diagnostics_json(&plan, "cpu_full_2x2_phase_reduced_floquet", 1);

    assert_eq!(
        diagnostics
            .get("production_cpu_rejection_reason")
            .and_then(|value| value.as_str()),
        Some("production_cpu_modal_nonzero_k_floquet_operator_missing")
    );
    assert_eq!(
        diagnostics
            .get("production_cpu_rejection_scope")
            .and_then(|value| value.as_str()),
        Some("selected_spectrum_nonzero_k_floquet_modal")
    );
    assert_eq!(
        diagnostics
            .get("required_operator_contract")
            .and_then(|value| value.as_str()),
        Some("bloch_floquet_tangent_operator_with_periodic_pairs")
    );
    assert_eq!(
        diagnostics
            .get("required_operator_payload_kind")
            .and_then(|value| value.as_str()),
        Some("bloch_floquet_tangent_operator")
    );
    assert_eq!(
        diagnostics
            .get("modal_periodic_pair_contract_available")
            .and_then(|value| value.as_bool()),
        Some(false)
    );
}

#[test]
fn reference_modal_diagnostics_name_dynamic_demag_k_production_cpu_rejection() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.operator.include_demag = true;
    plan.enable_demag = true;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.spin_wave_bc = SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
        kind: SpinWaveBoundaryKindIR::Floquet,
        boundary_pair_id: Some("x_faces".to_string()),
        pair_ids: Vec::new(),
        phase_convention: fullmag_ir::PhaseConventionIR::default(),
        surface_anisotropy_ks: None,
        surface_anisotropy_axis: None,
    });
    plan.k_sampling = Some(KSamplingIR::Single {
        k_vector: [1.0e6, 0.0, 0.0],
    });

    let diagnostics = modal_solver_diagnostics_json(&plan, "cpu_full_2x2_phase_reduced_floquet", 1);

    assert_eq!(
        native_cpu_modal_window_rejection_reason(&plan),
        Some("production_cpu_modal_dynamic_demag_k_operator_missing")
    );
    assert_eq!(
        diagnostics
            .get("production_cpu_rejection_reason")
            .and_then(|value| value.as_str()),
        Some("production_cpu_modal_dynamic_demag_k_operator_missing")
    );
    assert_eq!(
        diagnostics
            .get("production_cpu_rejection_scope")
            .and_then(|value| value.as_str()),
        Some("selected_spectrum_nonzero_k_floquet_modal_dynamic_demag")
    );
    assert_eq!(
        diagnostics
            .get("required_operator_contract")
            .and_then(|value| value.as_str()),
        Some("bloch_floquet_tangent_operator_with_dynamic_demag_k")
    );
    assert_eq!(
        diagnostics
            .get("required_operator_payload_kind")
            .and_then(|value| value.as_str()),
        Some("bloch_floquet_tangent_operator")
    );
    assert_eq!(
        diagnostics
            .get("required_demag_payload_kind")
            .and_then(|value| value.as_str()),
        Some("dynamic_demag_k_operator")
    );
    assert_eq!(
        diagnostics
            .get("dynamic_demag_operator_source")
            .and_then(|value| value.as_str()),
        Some("missing_numeric_fem_demag_k")
    );
}

#[test]
fn sparse_lowest_without_retained_modes_does_not_raise_window_error() {
    let target = fullmag_ir::EigenTargetIR::Lowest;

    reject_empty_frequency_window_result(&target, 20, 0, 0)
        .expect("lowest target does not use the frequency-window coverage diagnostic");
}

#[test]
fn runner_rejects_floquet_dynamic_demag_gate() {
    let bc = SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
        kind: SpinWaveBoundaryKindIR::Floquet,
        boundary_pair_id: Some("x_faces".to_string()),
        pair_ids: Vec::new(),
        phase_convention: fullmag_ir::PhaseConventionIR::default(),
        surface_anisotropy_ks: None,
        surface_anisotropy_axis: None,
    });

    let err = reject_unsupported_floquet_dynamic_demag(&bc, true)
        .expect_err("Floquet dynamic demag must be blocked before execution");
    assert!(err
        .message
        .contains("dynamic demag for Floquet periodic FEM is not implemented yet"));
}

#[test]
fn runner_allows_floquet_without_dynamic_demag_gate() {
    let bc = SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
        kind: SpinWaveBoundaryKindIR::Floquet,
        boundary_pair_id: Some("x_faces".to_string()),
        pair_ids: Vec::new(),
        phase_convention: fullmag_ir::PhaseConventionIR::default(),
        surface_anisotropy_ks: None,
        surface_anisotropy_axis: None,
    });

    reject_unsupported_floquet_dynamic_demag(&bc, false)
        .expect("Floquet phase reduction remains valid when dynamic demag is disabled");
}

#[test]
fn floquet_phase_uses_minus_sign_and_boundary_translation() {
    let mesh = fullmag_ir::MeshIR {
        mesh_name: "periodic_tet".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ],
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
        element_markers: vec![1],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 2, 3], [1, 2, 3]]),
        boundary_markers: vec![10, 11],
        periodic_boundary_pairs: vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "x_faces".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 10,
            marker_b: 11,
            translation: Some([1.0, 0.0, 0.0]),
            tolerance: Some(1e-12),
            axis_hint: None,
            orientation: None,
            pairing_policy: None,
        }],
        periodic_node_pairs: vec![fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "x_faces".to_string(),
            node_a: 0,
            node_b: 1,
        }],
        per_domain_quality: std::collections::HashMap::new(),
    };
    let topology = MeshTopology::from_ir(&mesh).expect("valid FEM mesh");
    let bc = SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
        kind: SpinWaveBoundaryKindIR::Floquet,
        boundary_pair_id: Some("x_faces".to_string()),
        pair_ids: Vec::new(),
        phase_convention: fullmag_ir::PhaseConventionIR::default(),
        surface_anisotropy_ks: None,
        surface_anisotropy_axis: None,
    });

    let groups = phase_reduction(
        &topology,
        &bc,
        Some(&KSamplingIR::Single {
            k_vector: [std::f64::consts::FRAC_PI_2, 0.0, 0.0],
        }),
    )
    .expect("Floquet phase reduction should be built")
    .expect("Floquet BC should produce phase groups");

    let phase = groups.phases[1];
    assert!(
        phase.re.abs() < 1e-12,
        "phase should be imaginary: {phase:?}"
    );
    assert!(
        (phase.im + 1.0).abs() < 1e-12,
        "expected exp(-i*pi/2) from boundary translation, got {phase:?}"
    );
}

#[test]
fn native_modal_floquet_pair_payload_uses_selected_boundary_translation() {
    let mut plan = minimal_native_modal_plan();
    plan.mesh = fullmag_ir::MeshIR {
        mesh_name: "periodic_tet".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ],
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
        element_markers: vec![1],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 2, 3], [1, 2, 3]]),
        boundary_markers: vec![10, 11],
        periodic_boundary_pairs: vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "x_faces".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 10,
            marker_b: 11,
            translation: Some([1.0, 0.0, 0.0]),
            tolerance: Some(1e-12),
            axis_hint: None,
            orientation: None,
            pairing_policy: None,
        }],
        periodic_node_pairs: vec![fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "x_faces".to_string(),
            node_a: 0,
            node_b: 1,
        }],
        per_domain_quality: std::collections::HashMap::new(),
    };
    plan.spin_wave_bc = SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
        kind: SpinWaveBoundaryKindIR::Floquet,
        boundary_pair_id: Some("x_faces".to_string()),
        pair_ids: Vec::new(),
        phase_convention: fullmag_ir::PhaseConventionIR::default(),
        surface_anisotropy_ks: None,
        surface_anisotropy_axis: None,
    });
    plan.k_sampling = Some(KSamplingIR::Single {
        k_vector: [std::f64::consts::FRAC_PI_2, 0.0, 0.0],
    });

    let topology = MeshTopology::from_ir(&plan.mesh).expect("valid FEM mesh");
    let pairs = native_modal_floquet_periodic_pairs(&plan, &topology)
        .expect("native modal Floquet pairs should be built");

    assert_eq!(pairs.len(), 1);
    assert_eq!(pairs[0].pair_id, Some("x_faces"));
    assert_eq!(pairs[0].node_a, 0);
    assert_eq!(pairs[0].node_b, 1);
    assert_eq!(pairs[0].translation_m, Some([1.0, 0.0, 0.0]));
    assert_eq!(pairs[0].phase_rad, Some(-std::f64::consts::FRAC_PI_2));
}

#[test]
fn bloch_floquet_dense_payload_embeds_complex_operator_as_gyrotropic_pencil() {
    let stiffness = vec![vec![Complex64::new(2.0, 0.0)]];
    let mass = vec![vec![Complex64::new(1.0, 0.0)]];

    let payload = native_bloch_floquet_dense_payload_from_complex_pair(&stiffness, &mass)
        .expect("1x1 complex operator should embed as native Bloch/Floquet payload");

    assert_eq!(payload.physical_complex_dof, 1);
    assert_eq!(payload.stiffness.nrows(), 4);
    assert_eq!(payload.stiffness.ncols(), 4);
    assert_eq!(
        payload.gyrotropic_row_major,
        vec![
            0.0, 0.0, -1.0, 0.0, //
            0.0, 0.0, 0.0, -1.0, //
            1.0, 0.0, 0.0, 0.0, //
            0.0, 1.0, 0.0, 0.0,
        ]
    );
    assert_eq!(payload.tangent_mass.nrows(), 4);
    assert_eq!(payload.tangent_mass.ncols(), 4);

    let mode = vec![
        Complex64::new(1.0, 0.0),
        Complex64::new(0.0, 0.0),
        Complex64::new(0.0, 1.0),
        Complex64::new(0.0, 0.0),
    ];
    let lambda = Complex64::new(0.0, 2.0);
    let (absolute, relative, linf) = gyrotropic_pencil_residual_norms(
        &payload.stiffness,
        &payload.gyrotropic_row_major,
        lambda,
        &mode,
    );

    assert!(absolute < 1.0e-12, "absolute residual={absolute}");
    assert!(relative < 1.0e-12, "relative residual={relative}");
    assert!(linf < 1.0e-12, "linf residual={linf}");
}

#[test]
fn bloch_floquet_embedded_native_mode_deembeds_to_physical_complex_mode() {
    let physical_mode = vec![Complex64::new(1.0, 2.0), Complex64::new(-0.5, 0.25)];
    let real_block = vec![
        Complex64::new(physical_mode[0].re, 0.0),
        Complex64::new(physical_mode[1].re, 0.0),
        Complex64::new(physical_mode[0].im, 0.0),
        Complex64::new(physical_mode[1].im, 0.0),
    ];
    let mut embedded = real_block.clone();
    embedded.extend(real_block.iter().map(|value| Complex64::i() * *value));

    let deembedded = deembed_native_bloch_floquet_mode_vector(&embedded, physical_mode.len())
        .expect("embedded native mode should deembed to the physical complex mode");

    assert_eq!(deembedded.len(), physical_mode.len());
    for (actual, expected) in deembedded.iter().zip(physical_mode.iter()) {
        assert!(
            (*actual - *expected).norm() < 1.0e-12,
            "actual={actual:?}, expected={expected:?}"
        );
    }
}

#[test]
fn native_frequency_domain_unavailable_modal_is_not_treated_as_dense_fallback() {
    let err = execute_gpu_fem_eigen(&minimal_native_modal_plan(), &[], None)
        .expect_err("explicit native modal path must not fall back to dense reference solve");
    assert!(
        err.message
            .contains("native FEM modal_eigen production path is unavailable")
            || err
                .message
                .contains("native FEM modal eigen solve requires the fem-native feature")
            || err
                .message
                .contains("native FEM modal eigen solve requires the fem-gpu feature"),
        "unexpected native modal error: {}",
        err.message
    );
    assert!(
        !err.message.contains("FEM eigen GPU solve succeeded"),
        "explicit native modal path must not report dense GPU success"
    );
    assert!(
        !err.message.contains("cuSolverDN"),
        "explicit native modal path must not expose dense GPU fallback details"
    );
    if err.message.contains("diagnostics_json=") {
        assert!(
            err.message.contains("modal_eigen"),
            "missing modal diagnostics"
        );
    }
}

#[cfg(feature = "fem-gpu")]
#[test]
fn cpu_full_2x2_frequency_window_uses_native_modal_artifact_path() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.k_sampling = None;
    plan.count = 4;
    plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
        frequency_min_hz: 1.0e3,
        frequency_max_hz: 5.0e6,
    };

    let run = execute_cpu_fem_eigen(
        &plan,
        &[
            OutputIR::EigenSpectrum {
                quantity: "frequency_hz".to_string(),
            },
            OutputIR::EigenMode {
                field: "mode".to_string(),
                indices: vec![0],
            },
        ],
    )
    .expect("eligible full 2x2 frequency window should use native modal production");

    let summary = run
        .auxiliary_artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "eigen/metadata/eigen_summary.json")
        .expect("native modal path must publish eigen summary");
    let summary_json: serde_json::Value =
        serde_json::from_slice(&summary.bytes).expect("summary should be JSON");
    assert_eq!(
        summary_json
            .get("solver_backend")
            .and_then(|value| value.as_str()),
        Some("native_fem_modal_eigen")
    );
    assert_eq!(
        summary_json
            .get("solver_diagnostics")
            .and_then(|value| value.get("execution_lane"))
            .and_then(|value| value.as_str()),
        Some("production_cpu")
    );
    assert_eq!(
        summary_json
            .get("solver_diagnostics")
            .and_then(|value| value.get("solver_model"))
            .and_then(|value| value.as_str()),
        Some("slepc_multi_shift_invert_production_cpu_dense")
    );
    assert_eq!(
        summary_json
            .get("solver_kind")
            .and_then(|value| value.as_str()),
        Some("slepc_multi_shift_invert_production_cpu_dense")
    );
    assert!(
        summary_json
            .get("solver_capabilities")
            .and_then(|value| value.as_array())
            .is_some_and(|capabilities| capabilities
                .iter()
                .any(|value| value.as_str() == Some("shift_invert"))),
        "{}",
        summary_json
    );
    assert!(
        summary_json
            .get("solver_notes")
            .and_then(|value| value.as_str())
            .is_some_and(|notes| notes.contains("shift-invert")),
        "{}",
        summary_json
    );
}

#[cfg(feature = "fem-gpu")]
#[test]
fn cpu_full_2x2_nonzero_floquet_window_uses_native_bloch_payload_artifact_path() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.count = 2;
    plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
        frequency_min_hz: 1.0e8,
        frequency_max_hz: 5.0e9,
    };
    plan.external_field = Some([39_789.0, 0.0, 0.0]);
    add_x_floquet_pair_to_plan(&mut plan);

    let run = execute_cpu_fem_eigen(
        &plan,
        &[
            OutputIR::EigenSpectrum {
                quantity: "frequency_hz".to_string(),
            },
            OutputIR::EigenMode {
                field: "mode".to_string(),
                indices: vec![0],
            },
        ],
    )
    .expect("eligible nonzero-k Floquet window should use native Bloch/Floquet modal production");

    let summary = run
        .auxiliary_artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "eigen/metadata/eigen_summary.json")
        .expect("native modal path must publish eigen summary");
    let summary_json: serde_json::Value =
        serde_json::from_slice(&summary.bytes).expect("summary should be JSON");
    assert_eq!(
        summary_json
            .get("solver_backend")
            .and_then(|value| value.as_str()),
        Some("native_fem_modal_eigen")
    );
    let diagnostics = summary_json
        .get("solver_diagnostics")
        .expect("native summary should carry solver diagnostics");
    assert_eq!(
        diagnostics
            .get("execution_lane")
            .and_then(|value| value.as_str()),
        Some("production_cpu")
    );
    assert_eq!(
        diagnostics
            .get("operator_diagnostics")
            .and_then(|value| value.get("payload_kind"))
            .and_then(|value| value.as_str()),
        Some("bloch_floquet_tangent_operator")
    );
    assert_eq!(
        diagnostics
            .get("floquet_periodic_pair_count")
            .and_then(|value| value.as_u64()),
        Some(1)
    );
    assert_eq!(
        diagnostics
            .get("modal_periodic_pair_contract_available")
            .and_then(|value| value.as_bool()),
        Some(true)
    );
    assert!(
        diagnostics
            .get("production_cpu_rejection_reason")
            .and_then(|value| value.as_str())
            .is_none(),
        "{}",
        diagnostics
    );
}

#[test]
fn native_cpu_modal_window_accepts_floquet_gamma_with_pair_payload() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
        frequency_min_hz: 1.0e8,
        frequency_max_hz: 5.0e9,
    };
    add_x_floquet_pair_to_plan(&mut plan);
    plan.k_sampling = Some(KSamplingIR::Single {
        k_vector: [0.0, 0.0, 0.0],
    });

    assert!(
            native_cpu_modal_window_enabled(&plan),
            "Floquet gamma samples with periodic pair metadata must use the same native Bloch/Floquet payload path as nonzero-k samples so production k-paths do not mix reference and production samples"
        );
    assert_eq!(native_cpu_modal_window_rejection_reason(&plan), None);
}

#[cfg(feature = "fem-gpu")]
#[test]
fn cpu_full_2x2_frequency_window_progress_and_provenance_report_shift_invert() {
    let mut plan = minimal_native_modal_plan();
    plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
    plan.damping_policy = EigenDampingPolicyIR::Ignore;
    plan.k_sampling = None;
    plan.count = 4;
    plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
        frequency_min_hz: 1.0e3,
        frequency_max_hz: 5.0e6,
    };

    let mut progress_events = Vec::<FemEigenProgress>::new();
    let mut progress = |event: FemEigenProgress| {
        progress_events.push(event);
        StepAction::Continue
    };
    let run = execute_cpu_fem_eigen_with_progress(
        &plan,
        &[OutputIR::EigenSpectrum {
            quantity: "frequency_hz".to_string(),
        }],
        &mut progress,
    )
    .expect("native full 2x2 frequency window should solve with shift-invert");

    assert!(
        progress_events
            .iter()
            .any(|event| event.phase == "solving_native_shift_invert"
                && event.solver_kind == "slepc_multi_shift_invert_production_cpu_dense"),
        "{progress_events:?}"
    );
    assert!(
        progress_events
            .iter()
            .all(|event| event.solver_kind != "contour_interval_production_cpu_dense"),
        "{progress_events:?}"
    );
    assert_eq!(
        run.provenance.execution_engine,
        "native_fem_modal_eigen/slepc_multi_shift_invert_production_cpu_dense"
    );
}

#[test]
fn equilibrium_artifact_loader_requires_certified_v7_contract() {
    let path = std::env::temp_dir().join(format!(
        "fullmag-eigen-equilibrium-v7-{}.json",
        std::process::id()
    ));
    let completion_sha256 =
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    let mut artifact = serde_json::json!({
        "schema_version": "equilibrium_artifact.v7",
        "accepted_for_linearization": true,
        "acceptance_certificate": {
            "criterion": "energy",
            "metric_kind": "total_energy_plateau_range_j",
            "metric_value": 8e-13,
            "threshold": 1e-12,
            "unit": "J",
            "status": "completed",
            "converged": true,
            "stop_reason": "energy",
            "completion_sha256": completion_sha256,
        },
        "completion_sha256": completion_sha256,
        "producer_run_id": "run:eq", "mesh_signature": format!("sha256:{}", "1".repeat(64)),
        "material_signature": format!("sha256:{}", "2".repeat(64)), "physics_signature": format!("sha256:{}", "3".repeat(64)),
        "boundary_signature": format!("sha256:{}", "4".repeat(64)), "static_demag_signature": format!("sha256:{}", "5".repeat(64)),
        "m0": [[0.0, 0.0, 1.0]], "h_eff0_a_per_m": [[0.0, 0.0, 1.0]],
        "h_demag0_a_per_m": [[0.0, 0.0, 0.0]], "phi0_a": [0.0],
        "phi0_requirement": "required_for_restart_or_provenance",
        "observables": {"max_torque_Apm": 0.4, "max_torque_T": 5.026548245743669e-7, "max_torque_relative": 3.2e-5},
        "representation_integrity": {"m0_norm_tolerance": 1e-10},
        "periodic_mesh_certificate": {"schema_version": "periodic_mesh_certificate.v6", "certificate_id": "periodic_mesh_certificate.v6:cert", "content_sha256": "sha256:cert", "certificate": {"certificate_status": "accepted"}}
    });
    let content_sha256 =
        shared_domain_content_digest("equilibrium_artifact_v7", &artifact).unwrap();
    artifact["content_sha256"] = serde_json::json!(content_sha256);
    artifact["equilibrium_id"] = serde_json::json!(format!(
        "equilibrium_artifact.v7:{}",
        content_sha256.strip_prefix("sha256:").unwrap()
    ));
    std::fs::write(&path, artifact.to_string()).unwrap();
    assert_eq!(
        load_equilibrium_artifact_v7(path.to_str().unwrap(), 1)
            .unwrap()
            .m0,
        vec![[0.0, 0.0, 1.0]]
    );

    let mut invalid_cases = Vec::new();
    invalid_cases.push(serde_json::json!([[0.0, 0.0, 1.0]]));
    let mut v6 = artifact.clone();
    v6["schema_version"] = serde_json::json!("equilibrium_artifact.v6");
    invalid_cases.push(v6.clone());
    let mut missing_acceptance = artifact.clone();
    missing_acceptance
        .as_object_mut()
        .unwrap()
        .remove("acceptance_certificate");
    invalid_cases.push(missing_acceptance);
    let mut incoherent_unit = artifact.clone();
    incoherent_unit["acceptance_certificate"]["unit"] = serde_json::json!("A/m");
    invalid_cases.push(incoherent_unit);
    let mut unsatisfied = artifact.clone();
    unsatisfied["acceptance_certificate"]["metric_value"] = serde_json::json!(2e-12);
    invalid_cases.push(unsatisfied);
    let mut mismatched_completion = artifact.clone();
    mismatched_completion["completion_sha256"] =
        serde_json::json!(format!("sha256:{}", "c".repeat(64)));
    invalid_cases.push(mismatched_completion);

    for invalid in invalid_cases {
        std::fs::write(&path, invalid.to_string()).unwrap();
        assert!(load_equilibrium_artifact_v7(path.to_str().unwrap(), 1).is_err());
    }

    std::fs::write(&path, v6.to_string()).unwrap();
    let error = load_equilibrium_artifact_v7(path.to_str().unwrap(), 1).unwrap_err();
    assert!(error.message.contains(
            "equilibrium_artifact_v6_uncertified: rerun relaxation or migrate with source completion evidence"
        ));
    std::fs::remove_file(path).unwrap();
}

#[test]
fn equilibrium_artifact_v7_loader_rejects_payload_tamper() {
    let path = std::env::temp_dir().join(format!(
        "fullmag-eigen-equilibrium-v7-tamper-{}.json",
        std::process::id()
    ));
    let completion_sha256 = format!("sha256:{}", "0".repeat(64));
    let mut artifact = serde_json::json!({
        "schema_version": "equilibrium_artifact.v7",
        "accepted_for_linearization": true,
        "acceptance_certificate": {
            "criterion": "torque", "metric_kind": "max_torque_apm",
            "metric_value": 0.4, "threshold": 0.5, "unit": "A/m",
            "status": "completed", "converged": true, "stop_reason": "torque",
            "completion_sha256": completion_sha256,
        },
        "completion_sha256": completion_sha256,
        "producer_run_id": "run:eq", "mesh_signature": format!("sha256:{}", "1".repeat(64)),
        "material_signature": format!("sha256:{}", "2".repeat(64)), "physics_signature": format!("sha256:{}", "3".repeat(64)),
        "boundary_signature": format!("sha256:{}", "4".repeat(64)), "static_demag_signature": format!("sha256:{}", "5".repeat(64)),
        "m0": [[0.0, 0.0, 1.0]], "h_eff0_a_per_m": [[0.0, 0.0, 1.0]],
        "h_demag0_a_per_m": [[0.0, 0.0, 0.0]], "phi0_a": [0.0],
        "phi0_requirement": "required_for_restart_or_provenance",
        "observables": {"max_torque_Apm": 0.4, "max_torque_T": 5.026548245743669e-7, "max_torque_relative": 3.2e-5},
        "representation_integrity": {"m0_norm_tolerance": 1e-10},
        "periodic_mesh_certificate": {"schema_version": "periodic_mesh_certificate.v6", "certificate_id": "periodic_mesh_certificate.v6:cert", "content_sha256": "sha256:cert", "certificate": {"certificate_status": "accepted"}}
    });
    let content_sha256 =
        shared_domain_content_digest("equilibrium_artifact_v7", &artifact).unwrap();
    artifact["content_sha256"] = serde_json::json!(content_sha256);
    artifact["equilibrium_id"] = serde_json::json!(format!(
        "equilibrium_artifact.v7:{}",
        content_sha256.strip_prefix("sha256:").unwrap()
    ));

    artifact["m0"] = serde_json::json!([[0.0, 1.0, 0.0]]);
    std::fs::write(&path, artifact.to_string()).unwrap();
    let error = load_equilibrium_artifact_v7(path.to_str().unwrap(), 1)
        .expect_err("tampering after digest creation must fail closed");
    assert!(error.message.contains("content_sha256"));
    std::fs::remove_file(path).unwrap();
}

#[test]
fn equilibrium_artifact_v7_loader_rejects_arbitrary_declared_hash_and_id() {
    let path = std::env::temp_dir().join(format!(
        "fullmag-eigen-equilibrium-v7-forged-{}.json",
        std::process::id()
    ));
    let completion_sha256 = format!("sha256:{}", "0".repeat(64));
    let forged_sha256 = format!("sha256:{}", "f".repeat(64));
    let artifact = serde_json::json!({
        "schema_version": "equilibrium_artifact.v7",
        "accepted_for_linearization": true,
        "acceptance_certificate": {
            "criterion": "torque", "metric_kind": "max_torque_apm",
            "metric_value": 0.4, "threshold": 0.5, "unit": "A/m",
            "status": "completed", "converged": true, "stop_reason": "torque",
            "completion_sha256": completion_sha256,
        },
        "completion_sha256": completion_sha256,
        "producer_run_id": "run:eq", "content_sha256": forged_sha256,
        "equilibrium_id": format!("equilibrium_artifact.v7:{}", "f".repeat(64)),
        "mesh_signature": format!("sha256:{}", "1".repeat(64)),
        "material_signature": format!("sha256:{}", "2".repeat(64)), "physics_signature": format!("sha256:{}", "3".repeat(64)),
        "boundary_signature": format!("sha256:{}", "4".repeat(64)), "static_demag_signature": format!("sha256:{}", "5".repeat(64)),
        "m0": [[0.0, 0.0, 1.0]], "h_eff0_a_per_m": [[0.0, 0.0, 1.0]],
        "h_demag0_a_per_m": [[0.0, 0.0, 0.0]], "phi0_a": [0.0],
        "phi0_requirement": "required_for_restart_or_provenance",
        "observables": {"max_torque_Apm": 0.4, "max_torque_T": 5.026548245743669e-7, "max_torque_relative": 3.2e-5},
        "representation_integrity": {"m0_norm_tolerance": 1e-10},
        "periodic_mesh_certificate": {"schema_version": "periodic_mesh_certificate.v6", "certificate_id": "periodic_mesh_certificate.v6:cert", "content_sha256": "sha256:cert", "certificate": {"certificate_status": "accepted"}}
    });

    std::fs::write(&path, artifact.to_string()).unwrap();
    let error = load_equilibrium_artifact_v7(path.to_str().unwrap(), 1)
        .expect_err("a self-consistent but arbitrary declared hash/id must fail closed");
    assert!(error.message.contains("content_sha256"));
    std::fs::remove_file(path).unwrap();
}
