use crate::artifact_pipeline::{ArtifactPipelineSender, ArtifactRecorder};
use std::collections::HashSet;

#[cfg(feature = "fem-gpu")]
use fullmag_engine::fem::FemBackendId;
use fullmag_engine::fem::{FemIntegratorWorkspace, FemLlgProblem, FemLlgState};
use fullmag_engine::{
    EvaluationRequest, ExchangeLlgProblem, ExchangeLlgState, ExchangeLlgStateSoA, FftWorkspace,
    IntegratorBuffers, StepReport,
};
use fullmag_ir::{BackendPlanIR, FdmPlanIR, FemPlanIR, OutputIR, ProblemIR};

use crate::dispatch::{self, FdmEngine, FemEngine};
use crate::fdm::cpu::reference as cpu_reference;
#[cfg(feature = "cuda")]
use crate::fdm::gpu::cuda::native::{NativeFdmBackend, NativeFdmPreviewSnapshot};
use crate::fem_baseline;
#[cfg(feature = "fem-gpu")]
use crate::native_fem::{DeviceInfo as FemDeviceInfo, NativeFemBackend};
use crate::preview::{
    build_grid_preview_field, build_mesh_preview_field_with_active_mask, mesh_quantity_active_mask,
    select_observables,
};
use crate::quantities::{
    active_fdm_preview_quantities, active_fem_preview_quantities, normalized_quantity_name,
};
use crate::relaxation::{
    llg_overdamped_uses_pure_damping, RelaxationEnergyPlateauWindow, RelaxationTorqueConfirmation,
};
use crate::schedules::{
    advance_due_schedules, collect_field_schedules, collect_scalar_schedules, is_due, same_time,
    OutputSchedule,
};
use crate::types::{
    ExecutedRun, ExecutionProvenance, FemStageExecutionContext, FieldSnapshot, LivePreviewField,
    LivePreviewRequest, ResolvedFallback, RunError, RunResult, RunStatus, StateObservables,
    StepAction, StepStats, StepUpdate,
};
use crate::DisplaySelectionState;

pub(crate) fn display_refresh_due(
    last_preview_revision: Option<u64>,
    display_state: &DisplaySelectionState,
    local_step: u64,
) -> bool {
    let cadence = u64::from(display_state.selection.every_n.max(1));
    last_preview_revision != Some(display_state.revision)
        || local_step <= 1
        || local_step % cadence == 0
}

pub(crate) fn cached_display_refresh_due(
    last_cached_preview_revision: Option<u64>,
    display_state: &DisplaySelectionState,
    local_step: u64,
    field_every_n: u64,
) -> bool {
    let cadence = field_every_n.max(1);
    last_cached_preview_revision != Some(display_state.revision)
        || local_step <= 1
        || local_step % cadence == 0
}

pub(crate) fn cached_preview_quantities_for(
    display_state: &DisplaySelectionState,
) -> Vec<&'static str> {
    let active_quantity = (!display_is_global_scalar(display_state))
        .then_some(display_state.selection.quantity.as_str());
    crate::quantities::cached_preview_quantity_ids()
        .into_iter()
        .filter(|quantity| Some(*quantity) != active_quantity)
        .collect()
}

fn interactive_time_event_schedule(
    drives: &[fullmag_ir::RegionalFieldDriveIR],
    stage_start_s: f64,
    duration_s: f64,
    output_periods_s: impl IntoIterator<Item = f64>,
) -> Vec<f64> {
    let stage_end_s = stage_start_s + duration_s;
    let mut times = crate::time_events::build_resolved_stage_event_schedule(
        drives,
        stage_start_s,
        stage_end_s,
        &[],
        crate::schedules::OUTPUT_TIME_TOLERANCE,
    )
    .times_s;
    for period_s in output_periods_s {
        if period_s.is_finite() && period_s > 0.0 {
            let count = (duration_s / period_s).floor() as u64;
            times.extend((0..=count).map(|index| stage_start_s + index as f64 * period_s));
        }
    }
    times.sort_by(f64::total_cmp);
    times.dedup_by(|right, left| (*right - *left).abs() <= crate::schedules::OUTPUT_TIME_TOLERANCE);
    times
}

fn reject_non_llg_interactive_relaxation(
    relaxation: Option<&fullmag_ir::RelaxationControlIR>,
    runtime: &str,
) -> Result<(), RunError> {
    if relaxation.is_some_and(|control| {
        control.algorithm != fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped
    }) {
        return Err(RunError {
            message: format!(
                "{runtime} does not support direct or implicit relaxation; use a batch relaxation stage"
            ),
        });
    }
    Ok(())
}

pub(crate) fn build_cached_grid_preview_fields(
    display_state: &DisplaySelectionState,
    observables: &StateObservables,
    grid: [u32; 3],
    active_mask: Option<&[bool]>,
) -> Option<Vec<LivePreviewField>> {
    let quantities = cached_preview_quantities_for(display_state);
    if quantities.is_empty() {
        return None;
    }
    let expected_len = grid[0] as usize * grid[1] as usize * grid[2] as usize;
    let base_request = display_state.preview_request();
    let mut cached = Vec::new();
    for quantity in quantities {
        let mut request = base_request.clone();
        request.quantity = quantity.to_string();
        let Ok(values) = select_observables(observables, quantity) else {
            continue;
        };
        if values.len() != expected_len {
            continue;
        }
        cached.push(build_grid_preview_field(
            &request,
            values,
            grid,
            active_mask,
        ));
    }
    (!cached.is_empty()).then_some(cached)
}

pub(crate) fn build_full_grid_materialized_fields(
    quantities: &[&str],
    observables: &StateObservables,
    grid: [u32; 3],
    active_mask: Option<&[bool]>,
    config_revision: u64,
) -> Option<Vec<LivePreviewField>> {
    let expected_len = grid[0] as usize * grid[1] as usize * grid[2] as usize;
    let mut fields = Vec::new();
    for quantity in quantities {
        let Ok(values) = select_observables(observables, quantity) else {
            continue;
        };
        if values.len() != expected_len {
            continue;
        }
        let request = LivePreviewRequest {
            revision: config_revision,
            quantity: (*quantity).to_string(),
            component: "3D".to_string(),
            layer: 0,
            all_layers: true,
            every_n: 1,
            x_chosen_size: 0,
            y_chosen_size: 0,
            auto_scale_enabled: false,
            max_points: 0,
        };
        fields.push(build_grid_preview_field(
            &request,
            values,
            grid,
            active_mask,
        ));
    }
    (!fields.is_empty()).then_some(fields)
}

fn build_cached_mesh_preview_fields(
    display_state: &DisplaySelectionState,
    observables: &StateObservables,
    mesh: &fullmag_ir::MeshIR,
) -> Option<Vec<LivePreviewField>> {
    let quantities = cached_preview_quantities_for(display_state);
    if quantities.is_empty() {
        return None;
    }
    let expected_len = mesh.nodes.len();
    let base_request = display_state.preview_request();
    let mut cached = Vec::new();
    for quantity in quantities {
        let mut request = base_request.clone();
        request.quantity = quantity.to_string();
        let Ok(values) = select_observables(observables, quantity) else {
            continue;
        };
        if values.len() != expected_len {
            continue;
        }
        cached.push(build_mesh_preview_field_with_active_mask(
            &request,
            values,
            mesh_quantity_active_mask(quantity, mesh),
        ));
    }
    (!cached.is_empty()).then_some(cached)
}

pub(crate) fn display_is_global_scalar(display_state: &DisplaySelectionState) -> bool {
    matches!(
        display_state.selection.kind,
        crate::DisplayKind::GlobalScalar
    )
}

#[cfg_attr(not(feature = "fem-gpu"), allow(dead_code))]
fn attach_resolved_fallback_to_provenance(
    provenance: &mut ExecutionProvenance,
    fallback: Option<ResolvedFallback>,
) {
    if provenance.resolved_fallback.is_none() {
        provenance.resolved_fallback = fallback;
    }
}

#[cfg_attr(not(feature = "fem-gpu"), allow(dead_code))]
fn attach_fem_crossover_decision_to_provenance(
    provenance: &mut ExecutionProvenance,
    crossover_decision: Option<crate::types::FemCrossoverDecision>,
) {
    if provenance.fem_crossover_decision.is_none() {
        provenance.fem_crossover_decision = crossover_decision;
    }
}

#[cfg(test)]
mod tests {
    use super::{
        attach_fem_crossover_decision_to_provenance, attach_resolved_fallback_to_provenance,
        build_full_grid_materialized_fields, cached_display_refresh_due, cpu_execution_provenance,
        display_refresh_due, normalize_runtime_context_signature, InteractiveFdmPreviewRuntime,
        InteractiveFdmPreviewRuntimeInner,
    };
    use crate::dispatch::FdmEngine;
    use crate::fdm::cpu::reference::{
        direct_h_eff_assembly_call_count, observe_state_call_count,
        reset_direct_field_assembly_calls, reset_observe_state_calls,
    };
    use crate::interactive::display::{DisplayKind, DisplaySelectionState};
    use crate::types::{LivePreviewRequest, StateObservables, StepAction};
    use fullmag_ir::{
        ExchangeBoundaryCondition, ExecutionPrecision, FdmMaterialIR, FdmPlanIR, GridDimensions,
        IntegratorChoice, RelaxationAlgorithmIR, RelaxationControlIR,
    };
    use std::collections::HashMap;

    #[test]
    fn interactive_fem_runtime_reuses_runtime_owned_stage_context() {
        let runtime_source = include_str!("interactive_runtime.rs");
        assert!(runtime_source.contains("stage_context: FemStageExecutionContext"));
        assert!(runtime_source
            .contains("pub(crate) fn stage_context(&self) -> &FemStageExecutionContext"));
        let runner_source = include_str!("lib.rs");
        let interactive = runner_source
            .split("pub fn run_problem_with_interactive_fem_runtime_live_preview_interruptible")
            .nth(1)
            .and_then(|tail| tail.split("/// Create an interactive runtime").next())
            .expect("interactive FEM execution function");
        assert!(interactive.contains("runtime.stage_context()"));
        assert!(!interactive.contains("StageFemMeshAsset::build_from_fem_plan"));
    }

    #[test]
    fn strict_interactive_fem_attaches_mfem_identity_before_recording_initial_fields() {
        let runtime_source = include_str!("interactive_runtime.rs");
        let version_attachment = runtime_source
            .find("provenance.hypre_version = Some(build_info.hypre_version);")
            .expect("strict interactive FEM must attach the loaded HYPRE version");
        let native_recorder = runtime_source
            .rfind("ArtifactRecorder::streaming(self.provenance.clone(), writer)")
            .expect("native FEM interactive runtime must create an artifact recorder");
        let initial_fields = runtime_source
            .rfind("capture_initial_native_fem_runtime_fields")
            .expect("native FEM interactive runtime must capture its initial fields");

        assert!(version_attachment < native_recorder);
        assert!(native_recorder < initial_fields);
    }

    fn make_soa_fdm_plan() -> FdmPlanIR {
        FdmPlanIR {
            grid: GridDimensions { cells: [4, 2, 1] },
            cell_size: [2e-9, 2e-9, 2e-9],
            region_mask: vec![0; 8],
            active_mask: None,
            initial_magnetization: vec![
                [1.0, 0.1, 0.0],
                [0.2, 1.0, 0.1],
                [0.1, 0.0, 1.0],
                [1.0, -0.2, 0.1],
                [0.0, 1.0, 0.3],
                [0.3, 0.2, 1.0],
                [1.0, 0.0, -0.2],
                [0.1, 1.0, 0.2],
            ],
            material: FdmMaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.2,
                ..Default::default()
            },
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: Some(IntegratorChoice::Heun),
            fixed_timestep: Some(1e-14),
            adaptive_timestep: None,
            enable_exchange: true,
            enable_demag: true,
            ..Default::default()
        }
    }

    #[test]
    fn full_grid_materialization_does_not_downscale_solver_fields() {
        let grid = [32, 32, 16];
        let count = grid[0] as usize * grid[1] as usize * grid[2] as usize;
        let vectors = || vec![[1.0, 2.0, 3.0]; count];
        let observables = StateObservables {
            magnetization: vectors(),
            torque_field: vectors(),
            exchange_field: vectors(),
            demag_field: vectors(),
            external_field: vectors(),
            antenna_field: vectors(),
            drive_field: vectors(),
            effective_field: vectors(),
            anisotropy_field: vectors(),
            dmi_field: vectors(),
            magnetoelastic_field: vectors(),
            cubic_anisotropy_field: vectors(),
            bulk_dmi_field: vectors(),
            oersted_field: vectors(),
            thermal_field: vectors(),
            exchange_energy: 0.0,
            demag_energy: 0.0,
            external_energy: 0.0,
            drive_energy: 0.0,
            anisotropy_energy: 0.0,
            dmi_energy: 0.0,
            total_energy: 0.0,
            max_dm_dt: 0.0,
            max_h_eff: 0.0,
            max_h_demag: 0.0,
            max_torque_Apm: 0.0,
            per_object_scalars: HashMap::new(),
        };

        let fields = build_full_grid_materialized_fields(
            &["m", "H_demag", "H_eff"],
            &observables,
            grid,
            None,
            9,
        )
        .expect("full materialization should produce vector fields");

        assert_eq!(
            fields
                .iter()
                .map(|field| field.quantity.as_str())
                .collect::<Vec<_>>(),
            vec!["m", "H_demag", "H_eff"]
        );
        for field in fields {
            assert_eq!(field.preview_grid, grid);
            assert_eq!(field.original_grid, grid);
            assert_eq!(field.vector_field_values.len(), count * 3);
            assert!(!field.auto_downscaled);
            assert_eq!(field.source_revision, 9);
        }
    }

    #[test]
    fn runtime_context_signature_ignores_stage_controls_and_keeps_physical_identity() {
        let first = make_soa_fdm_plan();
        let mut second = first.clone();
        second.integrator = Some(IntegratorChoice::Rk23);
        second.fixed_timestep = Some(1e-15);
        second.relaxation = Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::LlgOverdamped,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-6),
                energy_tolerance_j: None,
                max_steps: Some(50_000),
                max_relaxation_time_s: None,
            },
        });

        assert_eq!(
            normalize_runtime_context_signature(&first),
            normalize_runtime_context_signature(&second),
            "a stage must change execution controls without changing the runtime context"
        );

        second.cell_size[0] *= 2.0;
        assert_ne!(
            normalize_runtime_context_signature(&first),
            normalize_runtime_context_signature(&second),
            "a physical grid change must remain a runtime boundary"
        );
    }

    #[test]
    fn interactive_cpu_direct_minimizer_has_no_physical_timestep_provenance() {
        let mut plan = make_soa_fdm_plan();
        plan.integrator = None;
        plan.fixed_timestep = None;
        plan.relaxation = Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-6),
                energy_tolerance_j: None,
                max_steps: Some(10),
                max_relaxation_time_s: None,
            },
        });

        let provenance = cpu_execution_provenance(&plan)
            .expect("direct minimizer provenance must not require an LLG timestep policy");
        assert_eq!(provenance.timestep_policy, None);
        let error = super::reject_non_llg_interactive_relaxation(
            plan.relaxation.as_ref(),
            "interactive FDM CPU runtime",
        )
        .expect_err("interactive direct minimization must fail before physical-time stepping");
        assert!(error.message.contains("use a batch relaxation stage"));
    }

    #[test]
    fn interactive_fem_runtime_attaches_fallback_to_provenance() {
        let fallback = crate::ResolvedFallback {
            occurred: true,
            original_engine: "fem_native_gpu".to_string(),
            fallback_engine: "fem_cpu_native".to_string(),
            reason: "native_fem_gpu_unavailable".to_string(),
            message: "native FEM GPU unavailable in test".to_string(),
        };
        let mut provenance = crate::ExecutionProvenance {
            execution_engine: "fem_cpu_native".to_string(),
            precision: "double".to_string(),
            ..crate::ExecutionProvenance::default()
        };

        attach_resolved_fallback_to_provenance(&mut provenance, Some(fallback.clone()));

        let fallback = provenance
            .resolved_fallback
            .expect("interactive FEM runtime should keep fallback in provenance");
        assert_eq!(fallback.original_engine, "fem_native_gpu");
        assert_eq!(fallback.fallback_engine, "fem_cpu_native");
        assert_eq!(fallback.reason, "native_fem_gpu_unavailable");
    }

    #[test]
    fn persistent_interactive_fem_provenance_keeps_the_pinned_crossover_decision() {
        let decision = crate::FemCrossoverDecision {
            requested: "auto".to_string(),
            resolved: "cpu".to_string(),
            reason: "calibrated_below_lower_bound".to_string(),
            calibration_id: Some("calibration-a".to_string()),
            confidence: Some(0.97),
        };
        let mut provenance = crate::ExecutionProvenance {
            execution_engine: "fem_cpu_native".to_string(),
            precision: "double".to_string(),
            ..crate::ExecutionProvenance::default()
        };

        attach_fem_crossover_decision_to_provenance(&mut provenance, Some(decision.clone()));

        assert_eq!(provenance.fem_crossover_decision, Some(decision));
        let artifact_json = serde_json::to_value(&provenance).expect("serialize provenance");
        let crossover = &artifact_json["fem_crossover_decision"];
        assert_eq!(crossover["requested"], "auto");
        assert_eq!(crossover["resolved"], "cpu");
        assert_eq!(crossover["reason"], "calibrated_below_lower_bound");
        assert_eq!(crossover["calibration_id"], "calibration-a");
        assert_eq!(crossover["confidence"], 0.97);
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn persistent_fem_runtime_keeps_resolved_crossover_after_profile_mutation_and_removal() {
        use crate::solver_runtime::fem_crossover::{
            features_from_plan, profile_payload_sha256, resolve_auto_fem_device,
            validate_fem_crossover_profile, FemCrossoverHardwareIdentity, FemCrossoverProfileV1,
            FemCrossoverRuntimeIdentity, FemCrossoverSample, FemCrossoverSampleDistribution,
            FemCrossoverStratum, FEM_CROSSOVER_SCHEMA_V1,
        };
        use fullmag_ir::{
            BackendTarget, DiscretizationHintsIR, FdmHintsIR, FemHintsIR, FemMeshAssetIR,
            GeometryAssetsIR, MeshIR, ProblemIR,
        };
        use std::collections::BTreeMap;

        let mut problem = ProblemIR::bootstrap_example();
        problem.backend_policy.requested_backend = BackendTarget::Fem;
        problem.backend_policy.discretization_hints = Some(DiscretizationHintsIR {
            fdm: Some(FdmHintsIR {
                cell: [2e-9, 2e-9, 2e-9],
                default_cell: None,
                per_magnet: None,
                demag: None,
                boundary_correction: None,
                boundary_phi_floor: None,
                boundary_delta_min: None,
            }),
            fem: Some(FemHintsIR {
                order: 1,
                hmax: 2e-9,
                mesh: Some("meshes/unit_tet.msh".to_string()),
                demag_solver_policy: None,
            }),
            hybrid: None,
        });
        problem.geometry_assets = Some(GeometryAssetsIR {
            fdm_grid_assets: Vec::new(),
            fem_mesh_assets: vec![FemMeshAssetIR {
                geometry_name: "strip".to_string(),
                mesh_source: Some("meshes/unit_tet.msh".to_string()),
                mesh: Some(MeshIR::from_legacy_tet4(
                    "strip".to_string(),
                    vec![
                        [0.0, 0.0, 0.0],
                        [1.0, 0.0, 0.0],
                        [0.0, 1.0, 0.0],
                        [0.0, 0.0, 1.0],
                    ],
                    vec![[0, 1, 2, 3]],
                    vec![1],
                    vec![[0, 1, 2]],
                    vec![1],
                    Vec::new(),
                    Vec::new(),
                    std::collections::HashMap::new(),
                )),
            }],
            fem_domain_mesh_asset: None,
        });
        let planned = fullmag_plan::plan(&problem).expect("build FEM persistence test plan");
        let fullmag_ir::BackendPlanIR::Fem(plan) = planned.backend_plan else {
            panic!("persistence test requires a FEM plan");
        };
        let features = features_from_plan(&plan, false);
        let runtime_identity = FemCrossoverRuntimeIdentity {
            bundle_sha256: "bundle-pinned".to_string(),
            library_sha256: BTreeMap::from([
                ("libmfem.so".to_string(), "mfem-pinned".to_string()),
                ("libHYPRE.so".to_string(), "hypre-pinned".to_string()),
            ]),
            hardware: FemCrossoverHardwareIdentity {
                gpu_uuid: "GPU-pinned".to_string(),
                gpu_name: "Pinned test GPU".to_string(),
                compute_capability: "8.9".to_string(),
                driver_version: "590.48".to_string(),
                cuda_toolkit_version: "13.1".to_string(),
                cpu_identity: "Pinned test CPU".to_string(),
            },
        };
        let sample = FemCrossoverSample {
            fixture_id: "persistence-fixture".to_string(),
            node_count: features.node_count,
            matrix_nnz: None,
            cpu: FemCrossoverSampleDistribution {
                p50_seconds: 1.0,
                p95_seconds: 1.1,
                stddev_seconds: 0.05,
                count: 3,
            },
            gpu: FemCrossoverSampleDistribution {
                p50_seconds: 2.0,
                p95_seconds: 2.1,
                stddev_seconds: 0.05,
                count: 3,
            },
        };
        let mut profile = FemCrossoverProfileV1 {
            schema_version: FEM_CROSSOVER_SCHEMA_V1.to_string(),
            calibration_id: "pinned-calibration".to_string(),
            qualified: true,
            qualification_notes: Vec::new(),
            evidence_sources: vec!["persistence-fixture".to_string()],
            confidence: 0.96,
            warmup_runs: 1,
            repeat_runs: 3,
            runtime: runtime_identity.clone(),
            strata: vec![FemCrossoverStratum {
                id: "persistent-runtime".to_string(),
                demag_enabled: features.demag_enabled,
                relaxation_algorithm: features.relaxation_algorithm.clone(),
                preview_enabled: features.preview_enabled,
                requires_matrix_nnz: false,
                minimum_matrix_nnz: None,
                maximum_matrix_nnz: None,
                lower_node_count: features.node_count + 1,
                upper_node_count: features.node_count + 2,
                within_band_device: "gpu".to_string(),
                samples: vec![sample],
            }],
            signature: None,
            profile_sha256: String::new(),
        };
        profile.profile_sha256 = profile_payload_sha256(&profile);

        let profile_path = std::env::temp_dir().join(format!(
            "fullmag-pinned-crossover-{}-{:?}.json",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::write(
            &profile_path,
            serde_json::to_vec(&profile).expect("serialize qualified profile"),
        )
        .expect("write qualified profile");
        let loaded: FemCrossoverProfileV1 = serde_json::from_slice(
            &std::fs::read(&profile_path).expect("read qualified profile once"),
        )
        .expect("parse qualified profile");
        let loaded = validate_fem_crossover_profile(loaded, &runtime_identity)
            .expect("validate qualified profile once");
        let decision = resolve_auto_fem_device(&features, Some(&loaded));
        assert_eq!(decision.resolved, "cpu");

        std::fs::write(&profile_path, b"{\"mutated\":true}").expect("mutate profile");
        std::fs::remove_file(&profile_path).expect("remove profile");

        let fallback = crate::ResolvedFallback {
            occurred: true,
            original_engine: "fem_native_gpu".to_string(),
            fallback_engine: "fem_cpu_native".to_string(),
            reason: decision.reason.clone(),
            message: "pinned crossover selected CPU for persistence test".to_string(),
        };
        let runtime = super::InteractiveFemPreviewRuntime::from_fem_plan(
            &plan,
            crate::dispatch::FemEngine::CpuNative,
            Some(fallback),
            Some(decision.clone()),
            None,
            fullmag_ir::ExecutionMode::Strict,
        )
        .expect("construct persistent FEM runtime from the pinned decision");
        let serialized = serde_json::to_value(runtime.execution_provenance())
            .expect("serialize persistent runtime provenance");

        assert_eq!(serialized["fem_crossover_decision"]["requested"], "auto");
        assert_eq!(serialized["fem_crossover_decision"]["resolved"], "cpu");
        assert_eq!(
            serialized["fem_crossover_decision"]["reason"],
            "calibrated_below_lower_bound"
        );
        assert_eq!(
            serialized["fem_crossover_decision"]["calibration_id"],
            "pinned-calibration"
        );
        assert_eq!(serialized["fem_crossover_decision"]["confidence"], 0.96);
        assert_eq!(
            runtime.execution_provenance().fem_crossover_decision,
            Some(decision)
        );
    }

    #[test]
    fn interactive_fdm_runtime_attaches_fallback_to_provenance() {
        let fallback = crate::ResolvedFallback {
            occurred: true,
            original_engine: "fdm_cuda".to_string(),
            fallback_engine: "fdm_cpu_reference".to_string(),
            reason: "fdm_cuda_unavailable".to_string(),
            message: "CUDA unavailable in test".to_string(),
        };
        let runtime = InteractiveFdmPreviewRuntime::from_fdm_plan(
            &make_soa_fdm_plan(),
            FdmEngine::CpuReference,
            Some(fallback.clone()),
        )
        .expect("CPU interactive runtime should build");

        assert_eq!(
            runtime.execution_provenance().resolved_fallback,
            Some(fallback)
        );
    }

    #[test]
    fn display_refresh_due_honors_selection_revision_and_every_n() {
        let mut display_state = DisplaySelectionState::default();
        display_state.revision = 7;
        display_state.selection.every_n = 50;

        assert!(display_refresh_due(None, &display_state, 0));
        assert!(display_refresh_due(Some(6), &display_state, 13));
        assert!(display_refresh_due(Some(7), &display_state, 0));
        assert!(display_refresh_due(Some(7), &display_state, 1));
        assert!(!display_refresh_due(Some(7), &display_state, 2));
        assert!(!display_refresh_due(Some(7), &display_state, 49));
        assert!(display_refresh_due(Some(7), &display_state, 50));
        assert!(display_refresh_due(Some(7), &display_state, 100));
    }

    #[test]
    fn cached_display_refresh_due_honors_field_every_n() {
        let mut display_state = DisplaySelectionState::default();
        display_state.revision = 3;

        assert!(cached_display_refresh_due(None, &display_state, 0, 25));
        assert!(cached_display_refresh_due(Some(2), &display_state, 17, 25));
        assert!(cached_display_refresh_due(Some(3), &display_state, 0, 25));
        assert!(cached_display_refresh_due(Some(3), &display_state, 1, 25));
        assert!(!cached_display_refresh_due(Some(3), &display_state, 2, 25));
        assert!(!cached_display_refresh_due(Some(3), &display_state, 24, 25));
        assert!(cached_display_refresh_due(Some(3), &display_state, 25, 25));
    }

    #[test]
    fn cpu_interactive_runtime_keeps_supported_fdm_segment_on_persistent_soa_state() {
        let plan = make_soa_fdm_plan();
        let mut runtime =
            InteractiveFdmPreviewRuntime::from_fdm_plan(&plan, FdmEngine::CpuReference, None)
                .expect("CPU interactive runtime should build");
        let cpu = match &mut runtime.inner {
            InteractiveFdmPreviewRuntimeInner::Cpu(cpu) => cpu,
            #[cfg(feature = "cuda")]
            InteractiveFdmPreviewRuntimeInner::Cuda(_) => {
                panic!("CPU engine should build a CPU interactive runtime")
            }
        };
        assert!(cpu.soa_fast_path_active());

        let display_selection = || {
            let mut state = DisplaySelectionState::default();
            state.selection.quantity = "E_total".to_string();
            state.selection.kind = DisplayKind::GlobalScalar;
            state
        };
        let mut seen_steps = 0;
        let result = runtime
            .execute_with_live_preview(
                &plan,
                2e-14,
                plan.grid.cells,
                8,
                &display_selection,
                None,
                &mut |update| {
                    seen_steps = seen_steps.max(update.stats.step);
                    StepAction::Continue
                },
            )
            .expect("CPU interactive runtime should execute");

        assert!(seen_steps > 0);
        assert!(!result.final_magnetization.is_empty());
        let cpu = match &mut runtime.inner {
            InteractiveFdmPreviewRuntimeInner::Cpu(cpu) => cpu,
            #[cfg(feature = "cuda")]
            InteractiveFdmPreviewRuntimeInner::Cuda(_) => {
                panic!("CPU engine should keep a CPU interactive runtime")
            }
        };
        assert!(cpu.soa_fast_path_active());
    }

    #[test]
    fn cpu_interactive_snapshot_preview_m_uses_direct_state_without_reobserving_state() {
        let plan = make_soa_fdm_plan();
        let mut runtime =
            InteractiveFdmPreviewRuntime::from_fdm_plan(&plan, FdmEngine::CpuReference, None)
                .expect("CPU interactive runtime should build");

        reset_observe_state_calls();
        let preview = runtime
            .snapshot_preview(&LivePreviewRequest {
                quantity: "m".to_string(),
                auto_scale_enabled: false,
                ..Default::default()
            })
            .expect("interactive magnetization preview should build");

        assert_eq!(preview.quantity, "m");
        assert_eq!(preview.vector_field_values.len(), 8 * 3);
        assert_eq!(
            observe_state_call_count(),
            0,
            "interactive magnetization preview should read CPU state directly"
        );
    }

    #[test]
    fn cpu_interactive_snapshot_vector_fields_share_direct_effective_field_cache_without_reobserving_state(
    ) {
        let plan = make_soa_fdm_plan();
        let mut runtime =
            InteractiveFdmPreviewRuntime::from_fdm_plan(&plan, FdmEngine::CpuReference, None)
                .expect("CPU interactive runtime should build");

        reset_observe_state_calls();
        reset_direct_field_assembly_calls();
        let fields = runtime
            .snapshot_vector_fields(
                &["H_eff", "torque"],
                &LivePreviewRequest {
                    auto_scale_enabled: false,
                    ..Default::default()
                },
            )
            .expect("interactive vector previews should build");

        assert_eq!(
            fields
                .iter()
                .map(|field| field.quantity.as_str())
                .collect::<Vec<_>>(),
            vec!["H_eff", "torque"]
        );
        assert_eq!(
            observe_state_call_count(),
            0,
            "interactive direct vector previews should not force a full observables pass"
        );
        assert_eq!(
            direct_h_eff_assembly_call_count(),
            1,
            "interactive H_eff and torque previews should share one direct effective-field assembly"
        );
    }

    #[test]
    fn cpu_interactive_cache_keeps_h_demag_in_inactive_fdm_cells() {
        let mut plan = make_soa_fdm_plan();
        plan.active_mask = Some(
            std::iter::once(true)
                .chain(std::iter::repeat_n(false, 7))
                .collect(),
        );
        plan.initial_magnetization = std::iter::once([1.0, 0.0, 0.0])
            .chain(std::iter::repeat_n([0.0, 0.0, 0.0], 7))
            .collect();
        let mut runtime =
            InteractiveFdmPreviewRuntime::from_fdm_plan(&plan, FdmEngine::CpuReference, None)
                .expect("CPU interactive runtime should build");
        let cpu = match &mut runtime.inner {
            InteractiveFdmPreviewRuntimeInner::Cpu(cpu) => cpu,
            #[cfg(feature = "cuda")]
            InteractiveFdmPreviewRuntimeInner::Cuda(_) => panic!("expected CPU runtime"),
        };
        let observables = crate::fdm::cpu::reference::observe_state(&cpu.problem, &cpu.state)
            .expect("solver observables should build");
        let mut display = DisplaySelectionState::default();
        display.selection.quantity = "H_eff".to_string();
        display.selection.kind = DisplayKind::VectorField;

        let fields = cpu
            .live_cached_preview_fields(&display, &observables, plan.grid.cells)
            .expect("interactive cache should build")
            .expect("interactive cache should include fields");
        let demag = fields
            .iter()
            .find(|field| field.quantity == "H_demag")
            .expect("cached H_demag should be present");

        assert!(
            demag.vector_field_values[3..6]
                .iter()
                .any(|component| component.abs() > 0.0),
            "the live H_demag cache must retain airbox vectors"
        );
    }

    #[test]
    fn cpu_interactive_streaming_preview_keeps_h_demag_in_inactive_fdm_cells() {
        let mut plan = make_soa_fdm_plan();
        plan.active_mask = Some(
            std::iter::once(true)
                .chain(std::iter::repeat_n(false, 7))
                .collect(),
        );
        plan.initial_magnetization = std::iter::once([1.0, 0.0, 0.0])
            .chain(std::iter::repeat_n([0.0, 0.0, 0.0], 7))
            .collect();
        let mut runtime =
            InteractiveFdmPreviewRuntime::from_fdm_plan(&plan, FdmEngine::CpuReference, None)
                .expect("CPU interactive runtime should build");
        let display_selection = || {
            let mut state = DisplaySelectionState::default();
            state.selection.quantity = "H_demag".to_string();
            state.selection.kind = DisplayKind::VectorField;
            state
        };
        let mut preview = None;

        runtime
            .execute_with_live_preview_streaming(
                &plan,
                1e-14,
                &[],
                plan.grid.cells,
                8,
                &display_selection,
                None,
                None,
                &mut |update| {
                    if preview.is_none() {
                        preview = update.preview_field;
                    }
                    StepAction::Stop
                },
            )
            .expect("CPU interactive streaming runtime should execute");

        let preview = preview.expect("streaming update should include H_demag preview");
        assert!(
            preview.vector_field_values[3..6]
                .iter()
                .any(|component| component.abs() > 0.0),
            "the streaming H_demag preview must retain airbox vectors"
        );
    }

    #[test]
    fn cpu_interactive_snapshot_step_stats_uses_last_step_report_without_reobserving_state() {
        let plan = make_soa_fdm_plan();
        let mut runtime =
            InteractiveFdmPreviewRuntime::from_fdm_plan(&plan, FdmEngine::CpuReference, None)
                .expect("CPU interactive runtime should build");
        let display_selection = || {
            let mut state = DisplaySelectionState::default();
            state.selection.quantity = "E_total".to_string();
            state.selection.kind = DisplayKind::GlobalScalar;
            state
        };
        runtime
            .execute_with_live_preview(
                &plan,
                2e-14,
                plan.grid.cells,
                8,
                &display_selection,
                None,
                &mut |_| StepAction::Continue,
            )
            .expect("CPU interactive runtime should execute");

        reset_observe_state_calls();
        let stats = runtime
            .snapshot_step_stats()
            .expect("interactive step stats snapshot should build");

        assert_eq!(stats.step, 2);
        assert!(stats.e_total.is_finite());
        assert_eq!(
            observe_state_call_count(),
            0,
            "interactive step stats snapshot should reuse the last StepReport"
        );
    }
}

pub struct InteractiveFdmPreviewRuntime {
    inner: InteractiveFdmPreviewRuntimeInner,
}

enum InteractiveFdmPreviewRuntimeInner {
    Cpu(CpuInteractiveFdmPreviewRuntime),
    #[cfg(feature = "cuda")]
    Cuda(CudaInteractiveFdmPreviewRuntime),
}

struct CpuInteractiveFdmPreviewRuntime {
    problem: ExchangeLlgProblem,
    state: ExchangeLlgState,
    state_soa: Option<ExchangeLlgStateSoA>,
    last_step_report: Option<StepReport>,
    fft_workspace: FftWorkspace,
    integrator_buffers: IntegratorBuffers,
    original_grid: [u32; 3],
    plan_signature: FdmPlanIR,
    provenance: ExecutionProvenance,
    total_steps: u64,
}

#[cfg(feature = "cuda")]
struct CudaInteractiveFdmPreviewRuntime {
    backend: NativeFdmBackend,
    original_grid: [u32; 3],
    plan_signature: FdmPlanIR,
    provenance: ExecutionProvenance,
    total_steps: u64,
    total_time: f64,
}

pub struct InteractiveFemPreviewRuntime {
    inner: InteractiveFemPreviewRuntimeInner,
    stage_context: FemStageExecutionContext,
}

enum InteractiveFemPreviewRuntimeInner {
    #[allow(dead_code)]
    Cpu(CpuInteractiveFemPreviewRuntime),
    #[cfg(feature = "fem-gpu")]
    Gpu(GpuInteractiveFemPreviewRuntime),
}

struct CpuInteractiveFemPreviewRuntime {
    problem: FemLlgProblem,
    state: FemLlgState,
    integrator_ws: FemIntegratorWorkspace,
    antenna_field: Vec<[f64; 3]>,
    mesh: crate::types::FemMeshPayload,
    plan_signature: FemPlanIR,
    provenance: ExecutionProvenance,
    total_steps: u64,
}

#[cfg(feature = "fem-gpu")]
struct GpuInteractiveFemPreviewRuntime {
    backend: NativeFemBackend,
    mesh: crate::types::FemMeshPayload,
    node_count: usize,
    plan_signature: FemPlanIR,
    provenance: ExecutionProvenance,
    total_steps: u64,
    total_time: f64,
    antenna_field: Vec<[f64; 3]>,
}

impl InteractiveFdmPreviewRuntime {
    pub fn create(problem: &ProblemIR) -> Result<Self, RunError> {
        let plan = fullmag_plan::plan(problem)?;
        let BackendPlanIR::Fdm(fdm) = &plan.backend_plan else {
            return Err(RunError {
                message:
                    "interactive FDM preview runtime is supported only for single-layer FDM plans"
                        .to_string(),
            });
        };
        let resolution = dispatch::resolve_fdm_engine_for_plan_with_trail(problem, fdm)?;
        Self::from_fdm_plan(fdm, resolution.engine, resolution.fallback)
    }

    pub(crate) fn create_from_plan(
        problem: &ProblemIR,
        plan: &FdmPlanIR,
    ) -> Result<Self, RunError> {
        let resolution = dispatch::resolve_fdm_engine_for_plan_with_trail(problem, plan)?;
        Self::from_fdm_plan(plan, resolution.engine, resolution.fallback)
    }

    fn from_fdm_plan(
        plan: &FdmPlanIR,
        engine: FdmEngine,
        fallback: Option<ResolvedFallback>,
    ) -> Result<Self, RunError> {
        let inner = match engine {
            FdmEngine::CpuReference => {
                let (problem, state) = cpu_reference::build_snapshot_problem_and_state(plan)?;
                let state_soa = if problem.soa_fast_path_supported() {
                    Some(state.to_soa())
                } else {
                    None
                };
                let fft_workspace = problem.create_workspace();
                let integrator_buffers = problem.create_integrator_buffers();
                let mut provenance = cpu_execution_provenance(plan)?;
                attach_resolved_fallback_to_provenance(&mut provenance, fallback);
                InteractiveFdmPreviewRuntimeInner::Cpu(CpuInteractiveFdmPreviewRuntime {
                    problem,
                    state,
                    state_soa,
                    last_step_report: None,
                    fft_workspace,
                    integrator_buffers,
                    original_grid: plan.grid.cells,
                    plan_signature: normalize_plan_signature(plan),
                    provenance,
                    total_steps: 0,
                })
            }
            FdmEngine::CudaFdm => {
                #[cfg(feature = "cuda")]
                {
                    let backend = NativeFdmBackend::create(plan)?;
                    let device_info = backend.device_info()?;
                    let mut provenance = cuda_execution_provenance(plan, &device_info)?;
                    attach_resolved_fallback_to_provenance(&mut provenance, fallback);
                    InteractiveFdmPreviewRuntimeInner::Cuda(CudaInteractiveFdmPreviewRuntime {
                        backend,
                        original_grid: plan.grid.cells,
                        plan_signature: normalize_plan_signature(plan),
                        provenance,
                        total_steps: 0,
                        total_time: 0.0,
                    })
                }
                #[cfg(not(feature = "cuda"))]
                {
                    return Err(RunError {
                        message:
                            "interactive CUDA FDM preview runtime requested but the runner was built without cuda"
                                .to_string(),
                    });
                }
            }
        };
        Ok(Self { inner })
    }

    pub fn matches_plan(&self, plan: &FdmPlanIR) -> bool {
        let normalized = normalize_plan_signature(plan);
        match &self.inner {
            InteractiveFdmPreviewRuntimeInner::Cpu(runtime) => runtime.plan_signature == normalized,
            #[cfg(feature = "cuda")]
            InteractiveFdmPreviewRuntimeInner::Cuda(runtime) => {
                runtime.plan_signature == normalized
            }
        }
    }

    pub fn can_continue_with_plan(&self, plan: &FdmPlanIR) -> bool {
        let normalized = normalize_runtime_context_signature(plan);
        match &self.inner {
            InteractiveFdmPreviewRuntimeInner::Cpu(runtime) => {
                normalize_runtime_context_signature(&runtime.plan_signature) == normalized
            }
            #[cfg(feature = "cuda")]
            InteractiveFdmPreviewRuntimeInner::Cuda(runtime) => {
                normalize_runtime_context_signature(&runtime.plan_signature) == normalized
            }
        }
    }

    pub fn execution_provenance(&self) -> ExecutionProvenance {
        match &self.inner {
            InteractiveFdmPreviewRuntimeInner::Cpu(runtime) => runtime.provenance.clone(),
            #[cfg(feature = "cuda")]
            InteractiveFdmPreviewRuntimeInner::Cuda(runtime) => runtime.provenance.clone(),
        }
    }

    pub fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        match &mut self.inner {
            InteractiveFdmPreviewRuntimeInner::Cpu(runtime) => {
                runtime.upload_magnetization(magnetization)
            }
            #[cfg(feature = "cuda")]
            InteractiveFdmPreviewRuntimeInner::Cuda(runtime) => {
                runtime.upload_magnetization(magnetization)
            }
        }
    }

    pub fn snapshot_preview(
        &mut self,
        request: &LivePreviewRequest,
    ) -> Result<LivePreviewField, RunError> {
        match &mut self.inner {
            InteractiveFdmPreviewRuntimeInner::Cpu(runtime) => runtime.snapshot_preview(request),
            #[cfg(feature = "cuda")]
            InteractiveFdmPreviewRuntimeInner::Cuda(runtime) => runtime.snapshot_preview(request),
        }
    }

    pub fn snapshot_vector_fields(
        &mut self,
        quantities: &[&str],
        request: &LivePreviewRequest,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        match &mut self.inner {
            InteractiveFdmPreviewRuntimeInner::Cpu(runtime) => {
                runtime.snapshot_vector_fields(quantities, request)
            }
            #[cfg(feature = "cuda")]
            InteractiveFdmPreviewRuntimeInner::Cuda(runtime) => {
                runtime.snapshot_vector_fields(quantities, request)
            }
        }
    }

    pub fn snapshot_step_stats(&mut self) -> Result<StepStats, RunError> {
        match &mut self.inner {
            InteractiveFdmPreviewRuntimeInner::Cpu(runtime) => runtime.snapshot_step_stats(),
            #[cfg(feature = "cuda")]
            InteractiveFdmPreviewRuntimeInner::Cuda(runtime) => runtime.snapshot_step_stats(),
        }
    }

    pub fn execute_with_live_preview(
        &mut self,
        plan: &FdmPlanIR,
        until_seconds: f64,
        grid: [u32; 3],
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<RunResult, RunError> {
        match &mut self.inner {
            InteractiveFdmPreviewRuntimeInner::Cpu(runtime) => runtime.execute_with_live_preview(
                plan,
                until_seconds,
                grid,
                field_every_n,
                display_selection,
                interrupt_requested,
                on_step,
            ),
            #[cfg(feature = "cuda")]
            InteractiveFdmPreviewRuntimeInner::Cuda(runtime) => runtime.execute_with_live_preview(
                plan,
                until_seconds,
                grid,
                field_every_n,
                display_selection,
                interrupt_requested,
                on_step,
            ),
        }
    }

    pub(crate) fn execute_with_live_preview_streaming(
        &mut self,
        plan: &FdmPlanIR,
        until_seconds: f64,
        outputs: &[OutputIR],
        grid: [u32; 3],
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
        artifact_writer: Option<ArtifactPipelineSender>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<ExecutedRun, RunError> {
        match &mut self.inner {
            InteractiveFdmPreviewRuntimeInner::Cpu(runtime) => runtime
                .execute_with_live_preview_streaming(
                    plan,
                    until_seconds,
                    outputs,
                    grid,
                    field_every_n,
                    display_selection,
                    interrupt_requested,
                    artifact_writer,
                    on_step,
                ),
            #[cfg(feature = "cuda")]
            InteractiveFdmPreviewRuntimeInner::Cuda(runtime) => runtime
                .execute_with_live_preview_streaming(
                    plan,
                    until_seconds,
                    outputs,
                    grid,
                    field_every_n,
                    display_selection,
                    interrupt_requested,
                    artifact_writer,
                    on_step,
                ),
        }
    }
}

#[cfg_attr(not(any(test, feature = "fem-gpu")), allow(dead_code))]
pub(crate) fn reuse_stage_fem_mesh_asset(
    stage_asset: &crate::types::StageFemMeshAsset,
) -> (crate::types::FemMeshPayload, FemStageExecutionContext) {
    (
        stage_asset.payload.clone(),
        FemStageExecutionContext::from_mesh_identity(stage_asset.identity.clone()),
    )
}

impl InteractiveFemPreviewRuntime {
    pub fn create(problem: &ProblemIR) -> Result<Self, RunError> {
        let plan = fullmag_plan::plan(problem)?;
        let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
            return Err(RunError {
                message:
                    "interactive FEM preview runtime is supported only for FEM execution plans"
                        .to_string(),
            });
        };
        let resolution = dispatch::resolve_fem_engine_for_plan_with_trail(problem, fem, false)?;
        eprintln!(
            "[fullmag-runner] interactive FEM engine: resolved_engine_id={} fallback={:?}",
            dispatch::fem_engine_label(resolution.engine),
            resolution.fallback.as_ref().map(|f| &f.reason),
        );
        Self::from_fem_plan(
            fem,
            resolution.engine,
            resolution.fallback,
            resolution.fem_crossover_decision,
            None,
            plan.common.execution_mode,
        )
    }

    pub(crate) fn create_from_plan(
        problem: &ProblemIR,
        plan: &FemPlanIR,
        stage_asset: Option<&crate::types::StageFemMeshAsset>,
        preview_enabled: bool,
    ) -> Result<Self, RunError> {
        let resolution =
            dispatch::resolve_fem_engine_for_plan_with_trail(problem, plan, preview_enabled)?;
        eprintln!(
            "[fullmag-runner] interactive FEM engine: resolved_engine_id={} fallback={:?}",
            dispatch::fem_engine_label(resolution.engine),
            resolution.fallback.as_ref().map(|f| &f.reason),
        );
        Self::from_fem_plan(
            plan,
            resolution.engine,
            resolution.fallback,
            resolution.fem_crossover_decision,
            stage_asset,
            problem.validation_profile.execution_mode,
        )
    }

    fn from_fem_plan(
        plan: &FemPlanIR,
        engine: FemEngine,
        fallback: Option<ResolvedFallback>,
        crossover_decision: Option<crate::types::FemCrossoverDecision>,
        stage_asset: Option<&crate::types::StageFemMeshAsset>,
        execution_mode: fullmag_ir::ExecutionMode,
    ) -> Result<Self, RunError> {
        #[cfg(not(feature = "fem-gpu"))]
        {
            let _ = (
                plan,
                engine,
                fallback,
                crossover_decision,
                stage_asset,
                execution_mode,
            );
            return Err(RunError {
                message:
                    "interactive native FEM runtime requested but the runner was built without fem-gpu"
                        .to_string(),
            });
        }

        #[cfg(feature = "fem-gpu")]
        {
            let effective_plan = match engine {
                FemEngine::CpuNative => fem_plan_for_cpu_native(plan),
                FemEngine::NativeGpu => fem_plan_for_native_gpu(plan),
            };
            let owned_stage_asset;
            let stage_asset = match stage_asset {
                Some(stage_asset) => stage_asset,
                None => {
                    owned_stage_asset =
                        crate::types::StageFemMeshAsset::build_from_fem_plan(&effective_plan);
                    &owned_stage_asset
                }
            };
            let (mesh, stage_context) = reuse_stage_fem_mesh_asset(stage_asset);
            let backend = NativeFemBackend::create(&effective_plan)?;
            let device_info = backend.device_info()?;
            let antenna_field = crate::antenna_fields::compute_antenna_field(&effective_plan)?;
            let mut provenance = fem_gpu_execution_provenance(&effective_plan, &device_info)?;
            if execution_mode == fullmag_ir::ExecutionMode::Strict
                && provenance.execution_engine == "fem_native_gpu"
            {
                let build_info = crate::native_fem::strict_gpu_runtime_build_info()?;
                provenance.mfem_version = Some(build_info.mfem_version);
                provenance.hypre_version = Some(build_info.hypre_version);
            }
            attach_resolved_fallback_to_provenance(&mut provenance, fallback);
            attach_fem_crossover_decision_to_provenance(&mut provenance, crossover_decision);
            let inner = InteractiveFemPreviewRuntimeInner::Gpu(GpuInteractiveFemPreviewRuntime {
                backend,
                mesh,
                node_count: effective_plan.mesh.nodes.len(),
                plan_signature: normalize_fem_plan_signature(&effective_plan),
                provenance,
                total_steps: 0,
                total_time: effective_plan.time_stage.start_time_s,
                antenna_field,
            });
            Ok(Self {
                inner,
                stage_context,
            })
        }
    }

    pub(crate) fn stage_context(&self) -> &FemStageExecutionContext {
        &self.stage_context
    }

    pub fn matches_plan(&self, plan: &FemPlanIR) -> bool {
        match &self.inner {
            InteractiveFemPreviewRuntimeInner::Cpu(runtime) => {
                runtime.plan_signature
                    == normalize_fem_plan_signature(&fem_plan_for_cpu_native(plan))
            }
            #[cfg(feature = "fem-gpu")]
            InteractiveFemPreviewRuntimeInner::Gpu(runtime) => {
                runtime.plan_signature
                    == normalize_fem_plan_signature(&fem_plan_for_native_gpu(plan))
            }
        }
    }

    pub fn can_continue_with_plan(&self, plan: &FemPlanIR) -> bool {
        match &self.inner {
            InteractiveFemPreviewRuntimeInner::Cpu(runtime) => {
                normalize_fem_runtime_context_signature(&runtime.plan_signature)
                    == normalize_fem_runtime_context_signature(&fem_plan_for_cpu_native(plan))
            }
            #[cfg(feature = "fem-gpu")]
            InteractiveFemPreviewRuntimeInner::Gpu(runtime) => {
                normalize_fem_runtime_context_signature(&runtime.plan_signature)
                    == normalize_fem_runtime_context_signature(&fem_plan_for_native_gpu(plan))
            }
        }
    }

    pub fn execution_provenance(&self) -> ExecutionProvenance {
        match &self.inner {
            InteractiveFemPreviewRuntimeInner::Cpu(runtime) => runtime.provenance.clone(),
            #[cfg(feature = "fem-gpu")]
            InteractiveFemPreviewRuntimeInner::Gpu(runtime) => runtime.provenance.clone(),
        }
    }

    pub fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        match &mut self.inner {
            InteractiveFemPreviewRuntimeInner::Cpu(runtime) => {
                runtime.upload_magnetization(magnetization)
            }
            #[cfg(feature = "fem-gpu")]
            InteractiveFemPreviewRuntimeInner::Gpu(runtime) => {
                runtime.upload_magnetization(magnetization)
            }
        }
    }

    pub fn snapshot_preview(
        &mut self,
        request: &LivePreviewRequest,
    ) -> Result<LivePreviewField, RunError> {
        match &mut self.inner {
            InteractiveFemPreviewRuntimeInner::Cpu(runtime) => runtime.snapshot_preview(request),
            #[cfg(feature = "fem-gpu")]
            InteractiveFemPreviewRuntimeInner::Gpu(runtime) => runtime.snapshot_preview(request),
        }
    }

    pub fn snapshot_vector_fields(
        &mut self,
        quantities: &[&str],
        request: &LivePreviewRequest,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        match &mut self.inner {
            InteractiveFemPreviewRuntimeInner::Cpu(runtime) => {
                runtime.snapshot_vector_fields(quantities, request)
            }
            #[cfg(feature = "fem-gpu")]
            InteractiveFemPreviewRuntimeInner::Gpu(runtime) => {
                runtime.snapshot_vector_fields(quantities, request)
            }
        }
    }

    pub fn execute_with_live_preview(
        &mut self,
        plan: &FemPlanIR,
        until_seconds: f64,
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<RunResult, RunError> {
        match &mut self.inner {
            InteractiveFemPreviewRuntimeInner::Cpu(runtime) => runtime.execute_with_live_preview(
                plan,
                until_seconds,
                field_every_n,
                display_selection,
                interrupt_requested,
                on_step,
            ),
            #[cfg(feature = "fem-gpu")]
            InteractiveFemPreviewRuntimeInner::Gpu(runtime) => runtime.execute_with_live_preview(
                plan,
                until_seconds,
                field_every_n,
                display_selection,
                interrupt_requested,
                on_step,
            ),
        }
    }

    pub(crate) fn execute_with_live_preview_streaming(
        &mut self,
        plan: &FemPlanIR,
        until_seconds: f64,
        outputs: &[OutputIR],
        field_every_n: u64,
        artifact_writer: Option<ArtifactPipelineSender>,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<ExecutedRun, RunError> {
        match &mut self.inner {
            InteractiveFemPreviewRuntimeInner::Cpu(runtime) => runtime
                .execute_with_live_preview_streaming(
                    plan,
                    until_seconds,
                    outputs,
                    field_every_n,
                    artifact_writer,
                    display_selection,
                    interrupt_requested,
                    on_step,
                ),
            #[cfg(feature = "fem-gpu")]
            InteractiveFemPreviewRuntimeInner::Gpu(runtime) => runtime
                .execute_with_live_preview_streaming(
                    plan,
                    until_seconds,
                    outputs,
                    field_every_n,
                    artifact_writer,
                    display_selection,
                    interrupt_requested,
                    on_step,
                ),
        }
    }

    pub fn snapshot_step_stats(&mut self) -> Result<StepStats, RunError> {
        match &mut self.inner {
            InteractiveFemPreviewRuntimeInner::Cpu(runtime) => runtime.snapshot_step_stats(),
            #[cfg(feature = "fem-gpu")]
            InteractiveFemPreviewRuntimeInner::Gpu(runtime) => runtime.snapshot_step_stats(),
        }
    }

    pub fn set_solver_profile_config(
        &mut self,
        config: &crate::SolverProfileConfig,
    ) -> Result<(), RunError> {
        let _ = config;
        match &mut self.inner {
            InteractiveFemPreviewRuntimeInner::Cpu(_) => Ok(()),
            #[cfg(feature = "fem-gpu")]
            InteractiveFemPreviewRuntimeInner::Gpu(runtime) => {
                runtime.backend.set_step_profile(config.enabled)
            }
        }
    }
}

impl CpuInteractiveFdmPreviewRuntime {
    fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        self.state
            .set_magnetization(magnetization.to_vec())
            .map_err(|error| RunError {
                message: format!("setting interactive CPU magnetization failed: {}", error),
            })?;
        self.state_soa = if self.problem.soa_fast_path_supported() {
            Some(self.state.to_soa())
        } else {
            None
        };
        self.last_step_report = None;
        Ok(())
    }

    #[cfg(test)]
    fn soa_fast_path_active(&self) -> bool {
        self.state_soa.is_some()
    }

    fn step(&mut self, dt_step: f64) -> Result<StepReport, RunError> {
        if self.state_soa.is_none() && self.problem.soa_fast_path_supported() {
            self.state_soa = Some(self.state.to_soa());
        }

        let report = if let Some(state_soa) = self.state_soa.as_mut() {
            let report = self
                .problem
                .step_soa_with_buffers_evaluation(
                    state_soa,
                    dt_step,
                    &mut self.fft_workspace,
                    &mut self.integrator_buffers,
                    EvaluationRequest::Full,
                )
                .map_err(|error| RunError {
                    message: format!("interactive CPU step failed: {}", error),
                })?;
            state_soa.write_back_to(&mut self.state);
            report
        } else {
            self.problem
                .step_with_buffers(
                    &mut self.state,
                    dt_step,
                    &mut self.fft_workspace,
                    &mut self.integrator_buffers,
                )
                .map_err(|error| RunError {
                    message: format!("interactive CPU step failed: {}", error),
                })?
        };
        self.last_step_report = Some(report);
        Ok(report)
    }

    fn snapshot_preview(
        &mut self,
        request: &LivePreviewRequest,
    ) -> Result<LivePreviewField, RunError> {
        let requested = [request.quantity.as_str()];
        if active_fdm_preview_quantities(FdmEngine::CpuReference, &self.plan_signature, &requested)
            .is_empty()
        {
            return Err(RunError {
                message: format!(
                    "preview quantity '{}' is not active for the current FDM problem",
                    request.quantity
                ),
            });
        }
        cpu_reference::snapshot_preview_from_state(
            &self.problem,
            &self.state,
            request,
            self.original_grid,
            self.plan_signature.active_mask.as_deref(),
        )
    }

    fn snapshot_vector_fields(
        &mut self,
        quantities: &[&str],
        request: &LivePreviewRequest,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        let quantities = active_fdm_preview_quantities(
            FdmEngine::CpuReference,
            &self.plan_signature,
            quantities,
        );
        cpu_reference::snapshot_vector_fields_from_state(
            &self.problem,
            &self.state,
            &quantities,
            request,
            self.original_grid,
            self.plan_signature.active_mask.as_deref(),
        )
    }

    fn snapshot_step_stats(&mut self) -> Result<StepStats, RunError> {
        if let Some(report) = self
            .last_step_report
            .as_ref()
            .filter(|report| same_time(report.time_seconds, self.state.time_seconds))
        {
            return Ok(make_step_stats_from_report(
                self.total_steps,
                self.state.time_seconds,
                report,
                0,
                self.state.magnetization(),
            ));
        }

        let observables = cpu_reference::observe_state(&self.problem, &self.state)?;
        Ok(make_step_stats(
            self.total_steps,
            self.state.time_seconds,
            0.0,
            0,
            &observables,
        ))
    }

    fn live_preview_field(
        &mut self,
        request: &LivePreviewRequest,
        observables: &StateObservables,
        grid: [u32; 3],
    ) -> Result<LivePreviewField, RunError> {
        if matches!(
            request.quantity.as_str(),
            "H_demag" | "H_demag.x" | "H_demag.y" | "H_demag.z"
        ) {
            return self.snapshot_preview(request);
        }
        Ok(build_grid_preview_field(
            request,
            select_observables(observables, &request.quantity)?,
            grid,
            self.plan_signature.active_mask.as_deref(),
        ))
    }

    fn live_cached_preview_fields(
        &mut self,
        display_state: &DisplaySelectionState,
        observables: &StateObservables,
        grid: [u32; 3],
    ) -> Result<Option<Vec<LivePreviewField>>, RunError> {
        let Some(mut fields) = build_cached_grid_preview_fields(
            display_state,
            observables,
            grid,
            self.plan_signature.active_mask.as_deref(),
        ) else {
            return Ok(None);
        };
        for field in &mut fields {
            if field.quantity == "H_demag" {
                let mut request = display_state.preview_request();
                request.quantity = "H_demag".to_string();
                *field = self.snapshot_preview(&request)?;
            }
        }
        Ok(Some(fields))
    }

    fn execute_with_live_preview(
        &mut self,
        plan: &FdmPlanIR,
        until_seconds: f64,
        grid: [u32; 3],
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<RunResult, RunError> {
        if !normalize_runtime_context_signature(&self.plan_signature)
            .eq(&normalize_runtime_context_signature(plan))
        {
            return Err(RunError {
                message:
                    "interactive CPU runtime context mismatch; caller must rebuild runtime before executing"
                        .to_string(),
            });
        }
        if until_seconds <= 0.0 {
            return Err(RunError {
                message: "interactive runtime until_seconds must be positive".to_string(),
            });
        }
        reject_non_llg_interactive_relaxation(
            plan.relaxation.as_ref(),
            "interactive FDM CPU runtime",
        )?;

        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let base_step = self.total_steps;
        let base_time = self.state.time_seconds;
        self.problem.regional_field_drives =
            cpu_reference::resolved_regional_field_drives(plan, base_time);
        let time_events = interactive_time_event_schedule(
            &plan.field_drives,
            base_time,
            until_seconds,
            std::iter::empty(),
        );
        let mut dt = crate::resolve_timestep_policy(
            plan.integrator,
            plan.fixed_timestep,
            plan.adaptive_timestep.as_ref(),
            crate::types::TimestepExecutionLane::fdm_cpu(),
        )?
        .initial_dt();
        let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
        let mut torque_confirmation = RelaxationTorqueConfirmation::default();
        let mut checkpoint = crate::interactive::CheckpointContext {
            display_selection,
            interrupt_requested,
            last_preview_revision: None,
        };
        let mut last_cached_preview_revision: Option<u64> = None;
        let mut cancelled = false;
        let mut paused = false;
        let mut steps: Vec<StepStats> = Vec::new();
        let initial_observables = cpu_reference::observe_state(&self.problem, &self.state)?;
        let mut current_observables = initial_observables;
        let mut current_local_stats = make_step_stats(
            self.total_steps,
            self.state.time_seconds,
            0.0,
            0,
            &current_observables,
        );
        current_local_stats.step -= base_step;
        current_local_stats.time -= base_time;

        while self.state.time_seconds - base_time < until_seconds {
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                current_local_stats.step,
            );
            let cached_display_due = cached_display_refresh_due(
                last_cached_preview_revision,
                &display_state,
                current_local_stats.step,
                field_every_n,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.live_preview_field(&preview_cfg, &current_observables, grid)?)
            } else {
                None
            };
            let cached_preview_fields = if cached_display_due {
                self.live_cached_preview_fields(&display_state, &current_observables, grid)?
            } else {
                None
            };
            let action = on_step(StepUpdate {
                coupled_checkpoint: None,
                stats: current_local_stats.clone(),
                grid,
                fem_mesh_generation_id: None,
                magnetization: None,
                preview_field,
                cached_preview_fields,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due: preview_due && display_is_global_scalar(&display_state),
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            if cached_display_due {
                last_cached_preview_revision = Some(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let proposed_dt = dt.min(until_seconds - (self.state.time_seconds - base_time));
            let dt_step = crate::time_events::cap_timestep_to_next_event(
                self.state.time_seconds,
                proposed_dt,
                &time_events,
                crate::schedules::OUTPUT_TIME_TOLERANCE,
            );
            let wall_start = std::time::Instant::now();
            let report = self.step(dt_step)?;
            let wall_elapsed = wall_start.elapsed().as_nanos() as u64;
            self.total_steps += 1;
            if let Some(next) = report.suggested_next_dt {
                dt = next;
            }

            // Build lightweight StepStats from the StepReport (no redundant
            // observe).  Full observe_state is deferred until we know that
            // preview or cached-preview data is actually needed.
            let total_stats = make_step_stats_from_report(
                self.total_steps,
                self.state.time_seconds,
                &report,
                wall_elapsed,
                self.state.magnetization(),
            );
            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            current_local_stats = local_stats.clone();
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                local_stats.step,
            );
            let cached_display_due = cached_display_refresh_due(
                last_cached_preview_revision,
                &display_state,
                local_stats.step,
                field_every_n,
            );

            // Only run the expensive full observe when vector-field data is
            // actually needed (preview refresh or cached preview refresh).
            let needs_observables =
                (preview_due && !display_is_global_scalar(&display_state)) || cached_display_due;

            if needs_observables {
                let observables = cpu_reference::observe_state(&self.problem, &self.state)?;
                current_observables = observables;
            }

            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.live_preview_field(&preview_cfg, &current_observables, grid)?)
            } else {
                None
            };
            let cached_preview_fields = if cached_display_due {
                self.live_cached_preview_fields(&display_state, &current_observables, grid)?
            } else {
                None
            };
            let scalar_row_due = local_stats.step <= 1
                || local_stats.step % field_every_n.max(1) == 0
                || (preview_due && display_is_global_scalar(&display_state));
            let action = on_step(StepUpdate {
                coupled_checkpoint: None,
                stats: local_stats.clone(),
                grid,
                fem_mesh_generation_id: None,
                magnetization: None,
                preview_field,
                cached_preview_fields,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due,
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            if cached_display_due {
                last_cached_preview_revision = Some(display_state.revision);
            }
            steps.push(local_stats.clone());
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let energy_plateau_range = energy_plateau.record(total_stats.e_total);
            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                local_stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
                    || torque_confirmation.observe_stats(
                        control,
                        &total_stats,
                        energy_plateau_range,
                        plan.gyromagnetic_ratio,
                        plan.material.damping,
                        pure_damping_relax,
                    )
            });
            if stop_for_relaxation {
                break;
            }
        }

        let status = if paused {
            RunStatus::Paused
        } else if cancelled {
            RunStatus::Cancelled
        } else {
            RunStatus::Completed
        };
        let completion = crate::relaxation::resolve_stage_completion(
            status,
            plan.relaxation.as_ref(),
            crate::relaxation::RelaxationCompletionMetrics {
                max_torque_apm: Some(current_local_stats.max_torque_Apm),
                torque_confirmed: torque_confirmation.confirmed(),
                accepted_energy_plateau_range_j: energy_plateau.range(),
                steps: current_local_stats.step,
                relaxation_time_s: Some(current_local_stats.time),
                numerical_stagnation: false,
            },
        );

        Ok(RunResult {
            status,
            steps,
            final_magnetization: self.state.magnetization().to_vec(),
            completion: Some(completion),
        })
    }

    fn execute_with_live_preview_streaming(
        &mut self,
        plan: &FdmPlanIR,
        until_seconds: f64,
        outputs: &[OutputIR],
        grid: [u32; 3],
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        _interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
        artifact_writer: Option<ArtifactPipelineSender>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<ExecutedRun, RunError> {
        if !normalize_runtime_context_signature(&self.plan_signature)
            .eq(&normalize_runtime_context_signature(plan))
        {
            return Err(RunError {
                message:
                    "interactive CPU runtime context mismatch; caller must rebuild runtime before executing"
                        .to_string(),
            });
        }
        if until_seconds <= 0.0 {
            return Err(RunError {
                message: "interactive runtime until_seconds must be positive".to_string(),
            });
        }
        reject_non_llg_interactive_relaxation(
            plan.relaxation.as_ref(),
            "interactive FDM CPU runtime",
        )?;

        let initial_magnetization = self.state.magnetization().to_vec();
        let mut artifacts = if let Some(writer) = artifact_writer {
            ArtifactRecorder::streaming(self.provenance.clone(), writer)
        } else {
            ArtifactRecorder::in_memory(self.provenance.clone())
        };
        let mut scalar_schedules = collect_scalar_schedules(outputs)?;
        let mut field_schedules = collect_field_schedules(outputs)?;
        let default_scalar_trace = scalar_schedules.is_empty();
        let initial_observables = cpu_reference::observe_state(&self.problem, &self.state)?;
        let mut steps = Vec::new();
        if default_scalar_trace {
            let stats = make_step_stats(0, 0.0, 0.0, 0, &initial_observables);
            artifacts.record_scalar(&stats)?;
            steps.push(stats);
        } else {
            record_due_cpu_outputs(
                &initial_observables,
                0,
                0.0,
                0.0,
                0,
                &mut scalar_schedules,
                &mut field_schedules,
                &mut steps,
                &mut artifacts,
            )?;
        }
        let result = self.execute_cpu_streaming_loop(
            plan,
            until_seconds,
            grid,
            field_every_n,
            display_selection,
            on_step,
            default_scalar_trace,
            &mut scalar_schedules,
            &mut field_schedules,
            &mut steps,
            &mut artifacts,
        )?;
        let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();
        Ok(ExecutedRun {
            result,
            initial_magnetization,
            field_snapshots,
            field_snapshot_count,
            provenance,
            auxiliary_artifacts: vec![],
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn execute_cpu_streaming_loop(
        &mut self,
        plan: &FdmPlanIR,
        until_seconds: f64,
        grid: [u32; 3],
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
        default_scalar_trace: bool,
        scalar_schedules: &mut [OutputSchedule],
        field_schedules: &mut [OutputSchedule],
        steps: &mut Vec<StepStats>,
        artifacts: &mut ArtifactRecorder,
    ) -> Result<RunResult, RunError> {
        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let base_step = self.total_steps;
        let base_time = self.state.time_seconds;
        self.problem.regional_field_drives =
            cpu_reference::resolved_regional_field_drives(plan, base_time);
        let output_periods = scalar_schedules
            .iter()
            .chain(field_schedules.iter())
            .map(|schedule| schedule.every_seconds);
        let time_events = interactive_time_event_schedule(
            &plan.field_drives,
            base_time,
            until_seconds,
            output_periods,
        );
        let mut dt = crate::resolve_timestep_policy(
            plan.integrator,
            plan.fixed_timestep,
            plan.adaptive_timestep.as_ref(),
            crate::types::TimestepExecutionLane::fdm_cpu(),
        )?
        .initial_dt();
        let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
        let mut torque_confirmation = RelaxationTorqueConfirmation::default();
        let mut checkpoint = crate::interactive::CheckpointContext {
            display_selection,
            interrupt_requested: None, // CPU FDM checks interrupt via on_step StepAction
            last_preview_revision: None,
        };
        let mut cancelled = false;
        let mut paused = false;
        let mut latest_local_stats: Option<StepStats> = None;
        let mut current_observables = cpu_reference::observe_state(&self.problem, &self.state)?;
        let mut current_local_stats = make_step_stats(
            self.total_steps,
            self.state.time_seconds,
            0.0,
            0,
            &current_observables,
        );
        current_local_stats.step -= base_step;
        current_local_stats.time -= base_time;

        while self.state.time_seconds - base_time < until_seconds {
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                current_local_stats.step,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.live_preview_field(&preview_cfg, &current_observables, grid)?)
            } else {
                None
            };
            let action = on_step(StepUpdate {
                coupled_checkpoint: None,
                stats: current_local_stats.clone(),
                grid,
                fem_mesh_generation_id: None,
                magnetization: None,
                preview_field,
                cached_preview_fields: None,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due: preview_due && display_is_global_scalar(&display_state),
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let proposed_dt = dt.min(until_seconds - (self.state.time_seconds - base_time));
            let dt_step = crate::time_events::cap_timestep_to_next_event(
                self.state.time_seconds,
                proposed_dt,
                &time_events,
                crate::schedules::OUTPUT_TIME_TOLERANCE,
            );
            let wall_start = std::time::Instant::now();
            let report = self.step(dt_step)?;
            artifacts.observe_physics_execution();
            let wall_elapsed = wall_start.elapsed().as_nanos() as u64;
            self.total_steps += 1;
            if let Some(next) = report.suggested_next_dt {
                dt = next;
            }

            // Build lightweight StepStats from the StepReport (no redundant
            // observe).  Full observe_state is deferred until we know that
            // outputs, preview, or field data is actually needed.
            let total_stats = make_step_stats_from_report(
                self.total_steps,
                self.state.time_seconds,
                &report,
                wall_elapsed,
                self.state.magnetization(),
            );
            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            current_local_stats = local_stats.clone();
            latest_local_stats = Some(local_stats.clone());

            // Determine what outputs are due BEFORE deciding whether to run
            // the expensive observe_state.
            let scalar_output_due = scalar_schedules
                .iter()
                .any(|schedule| is_due(local_stats.time, schedule.next_time));
            let due_field_names: Vec<String> = field_schedules
                .iter()
                .filter(|schedule| is_due(local_stats.time, schedule.next_time))
                .map(|schedule| schedule.name.clone())
                .collect();

            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                local_stats.step,
            );
            let needs_observables = scalar_output_due
                || !due_field_names.is_empty()
                || (preview_due && !display_is_global_scalar(&display_state));

            // Only run the expensive full observe when actually needed.
            if needs_observables {
                let observables = cpu_reference::observe_state(&self.problem, &self.state)?;
                current_observables = observables;
            }

            if scalar_output_due || !due_field_names.is_empty() {
                record_due_cpu_outputs(
                    &current_observables,
                    local_stats.step,
                    local_stats.time,
                    report.dt_used,
                    wall_elapsed,
                    scalar_schedules,
                    field_schedules,
                    steps,
                    artifacts,
                )?;
            }

            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.live_preview_field(&preview_cfg, &current_observables, grid)?)
            } else {
                None
            };
            let scalar_row_due = local_stats.step <= 1
                || local_stats.step % field_every_n.max(1) == 0
                || (preview_due && display_is_global_scalar(&display_state));
            let action = on_step(StepUpdate {
                coupled_checkpoint: None,
                stats: local_stats.clone(),
                grid,
                fem_mesh_generation_id: None,
                magnetization: None,
                preview_field,
                cached_preview_fields: None,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due,
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            // Cooperative checkpoint: poll for pending control requests
            let control = checkpoint.check_control();
            if control != crate::interactive::commands::RuntimeControlOutcome::Continue {
                cancelled = true;
                break;
            }

            let energy_plateau_range = energy_plateau.record(total_stats.e_total);
            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                local_stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
                    || torque_confirmation.observe_stats(
                        control,
                        &total_stats,
                        energy_plateau_range,
                        plan.gyromagnetic_ratio,
                        plan.material.damping,
                        pure_damping_relax,
                    )
            });
            if stop_for_relaxation {
                break;
            }
        }

        if let Some(final_stats) = latest_local_stats {
            let final_observables = cpu_reference::observe_state(&self.problem, &self.state)?;
            record_final_cpu_outputs(
                &final_observables,
                final_stats.step,
                final_stats.time,
                final_stats.dt,
                default_scalar_trace,
                field_schedules,
                steps,
                artifacts,
            )?;
        }

        let status = if paused {
            RunStatus::Paused
        } else if cancelled {
            RunStatus::Cancelled
        } else {
            RunStatus::Completed
        };
        let completion = crate::relaxation::resolve_stage_completion(
            status,
            plan.relaxation.as_ref(),
            crate::relaxation::RelaxationCompletionMetrics {
                max_torque_apm: Some(current_local_stats.max_torque_Apm),
                torque_confirmed: torque_confirmation.confirmed(),
                accepted_energy_plateau_range_j: energy_plateau.range(),
                steps: current_local_stats.step,
                relaxation_time_s: Some(current_local_stats.time),
                numerical_stagnation: false,
            },
        );

        Ok(RunResult {
            status,
            steps: steps.clone(),
            final_magnetization: self.state.magnetization().to_vec(),
            completion: Some(completion),
        })
    }
}

#[cfg(feature = "cuda")]
impl CudaInteractiveFdmPreviewRuntime {
    fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        self.backend.upload_magnetization(magnetization)?;
        self.backend.refresh_observables()
    }

    fn snapshot_preview(
        &mut self,
        request: &LivePreviewRequest,
    ) -> Result<LivePreviewField, RunError> {
        let requested = [request.quantity.as_str()];
        if active_fdm_preview_quantities(FdmEngine::CudaFdm, &self.plan_signature, &requested)
            .is_empty()
        {
            return Err(RunError {
                message: format!(
                    "preview quantity '{}' is not active for the current FDM problem",
                    request.quantity
                ),
            });
        }
        self.backend.copy_live_preview_field(
            request,
            self.original_grid,
            self.plan_signature.active_mask.as_deref(),
        )
    }

    fn snapshot_vector_fields(
        &mut self,
        quantities: &[&str],
        request: &LivePreviewRequest,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        let quantities =
            active_fdm_preview_quantities(FdmEngine::CudaFdm, &self.plan_signature, quantities);
        let mut cached = Vec::new();
        let mut seen = HashSet::new();

        for quantity in quantities
            .iter()
            .filter_map(|quantity| normalized_quantity_name(quantity).ok())
        {
            if !seen.insert(quantity) {
                continue;
            }
            let mut preview_request = request.clone();
            preview_request.quantity = quantity.to_string();
            cached.push(self.backend.copy_live_preview_field(
                &preview_request,
                self.original_grid,
                self.plan_signature.active_mask.as_deref(),
            )?);
        }

        Ok(cached)
    }

    fn snapshot_step_stats(&mut self) -> Result<StepStats, RunError> {
        self.backend.snapshot_step_stats(self.original_grid)
    }

    fn begin_cached_preview_prefetch(
        &self,
        display_state: &DisplaySelectionState,
    ) -> Result<Option<Vec<NativeFdmPreviewSnapshot>>, RunError> {
        let quantities = active_fdm_preview_quantities(
            FdmEngine::CudaFdm,
            &self.plan_signature,
            &cached_preview_quantities_for(display_state),
        );
        if quantities.is_empty() {
            return Ok(None);
        }
        let base_request = display_state.preview_request();
        let mut snapshots = Vec::with_capacity(quantities.len());
        let mut seen = HashSet::new();
        for quantity in quantities
            .into_iter()
            .filter_map(|quantity| normalized_quantity_name(quantity).ok())
        {
            if !seen.insert(quantity) {
                continue;
            }
            let mut request = base_request.clone();
            request.quantity = quantity.to_string();
            snapshots.push(
                self.backend
                    .begin_live_preview_snapshot(&request, self.original_grid)?,
            );
        }
        Ok(Some(snapshots))
    }

    fn resolve_cached_preview_prefetch(
        &self,
        snapshots: Vec<NativeFdmPreviewSnapshot>,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        snapshots
            .into_iter()
            .map(|snapshot| {
                snapshot.into_live_preview_field(self.plan_signature.active_mask.as_deref())
            })
            .collect()
    }

    fn execute_with_live_preview(
        &mut self,
        plan: &FdmPlanIR,
        until_seconds: f64,
        grid: [u32; 3],
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<RunResult, RunError> {
        if !normalize_runtime_context_signature(&self.plan_signature)
            .eq(&normalize_runtime_context_signature(plan))
        {
            return Err(RunError {
                message:
                    "interactive CUDA runtime context mismatch; caller must rebuild runtime before executing"
                        .to_string(),
            });
        }
        if until_seconds <= 0.0 {
            return Err(RunError {
                message: "interactive runtime until_seconds must be positive".to_string(),
            });
        }
        let base_step = self.total_steps;
        let base_time = self.total_time;
        let time_events = interactive_time_event_schedule(
            &plan.field_drives,
            base_time,
            until_seconds,
            std::iter::empty(),
        );
        reject_non_llg_interactive_relaxation(
            plan.relaxation.as_ref(),
            "interactive FDM CUDA runtime",
        )?;
        let mut dt = crate::resolve_timestep_policy(
            plan.integrator,
            plan.fixed_timestep,
            plan.adaptive_timestep.as_ref(),
            crate::types::TimestepExecutionLane::fdm_cuda(plan.precision),
        )?
        .initial_dt();
        let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
        let mut torque_confirmation = RelaxationTorqueConfirmation::default();
        let mut backend_completion: Option<fullmag_ir::StageCompletionIR> = None;
        let mut checkpoint = crate::interactive::CheckpointContext {
            display_selection,
            interrupt_requested,
            last_preview_revision: None,
        };
        let mut last_cached_preview_revision: Option<u64> = None;
        let cell_count = (self.original_grid[0] as usize)
            * (self.original_grid[1] as usize)
            * (self.original_grid[2] as usize);
        let mut cancelled = false;
        let mut paused = false;
        let mut steps: Vec<StepStats> = Vec::new();
        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let mut current_local_stats = self.backend.snapshot_step_stats(grid)?;
        current_local_stats.step -= base_step;
        current_local_stats.time -= base_time;
        let initial_display_state = (checkpoint.display_selection)();
        let mut pending_cached_preview_snapshots =
            self.begin_cached_preview_prefetch(&initial_display_state)?;

        while self.total_time - base_time < until_seconds {
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                current_local_stats.step,
            );
            let cached_display_due = cached_display_refresh_due(
                last_cached_preview_revision,
                &display_state,
                current_local_stats.step,
                field_every_n,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.backend.copy_live_preview_field(
                    &preview_cfg,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                )?)
            } else {
                None
            };
            let cached_preview_fields = if cached_display_due {
                match pending_cached_preview_snapshots.take() {
                    Some(snapshots) => Some(self.resolve_cached_preview_prefetch(snapshots)?),
                    None => {
                        let preview_cfg = display_state.preview_request();
                        let quantities = cached_preview_quantities_for(&display_state);
                        if quantities.is_empty() {
                            None
                        } else {
                            Some(self.snapshot_vector_fields(&quantities, &preview_cfg)?)
                        }
                    }
                }
            } else {
                None
            };
            let action = on_step(StepUpdate {
                coupled_checkpoint: None,
                stats: current_local_stats.clone(),
                grid,
                fem_mesh_generation_id: None,
                magnetization: None,
                preview_field,
                cached_preview_fields,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due: preview_due && display_is_global_scalar(&display_state),
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            if cached_display_due {
                last_cached_preview_revision = Some(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let proposed_dt = dt.min(until_seconds - (self.total_time - base_time));
            let dt_step = crate::time_events::cap_timestep_to_next_event(
                self.total_time,
                proposed_dt,
                &time_events,
                crate::schedules::OUTPUT_TIME_TOLERANCE,
            );
            let Some(total_stats) = self
                .backend
                .step_interruptible(dt_step, interrupt_requested)?
            else {
                continue;
            };
            self.total_steps = total_stats.step;
            self.total_time = total_stats.time;
            if let Some(next) = total_stats.dt_suggested {
                dt = next;
            }
            let post_step_display_state = (checkpoint.display_selection)();
            // Only start async cached-preview GPU→CPU copies when the next
            // iteration will actually consume them.
            let next_cached_step = (total_stats.step - base_step) + 1;
            if cached_display_refresh_due(
                last_cached_preview_revision,
                &post_step_display_state,
                next_cached_step,
                field_every_n,
            ) {
                pending_cached_preview_snapshots =
                    self.begin_cached_preview_prefetch(&post_step_display_state)?;
            } else {
                pending_cached_preview_snapshots = None;
            }

            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            current_local_stats = local_stats.clone();
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                local_stats.step,
            );
            let cached_display_due = cached_display_refresh_due(
                last_cached_preview_revision,
                &display_state,
                local_stats.step,
                field_every_n,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.backend.copy_live_preview_field(
                    &preview_cfg,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                )?)
            } else {
                None
            };
            let scalar_row_due = local_stats.step <= 1
                || local_stats.step % field_every_n.max(1) == 0
                || (preview_due && display_is_global_scalar(&display_state));
            let action = on_step(StepUpdate {
                coupled_checkpoint: None,
                stats: local_stats.clone(),
                grid,
                fem_mesh_generation_id: None,
                magnetization: None,
                preview_field,
                cached_preview_fields: None,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due,
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            if cached_display_due {
                last_cached_preview_revision = Some(display_state.revision);
            }
            steps.push(local_stats.clone());
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let energy_plateau_range = energy_plateau.record(total_stats.e_total);
            let stop_for_relaxation = if let Some(control) = plan.relaxation.as_ref() {
                if let Some(completion) = self.backend.stage_completion()? {
                    backend_completion = Some(completion);
                    true
                } else {
                    local_stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
                        || torque_confirmation.observe_stats(
                            control,
                            &total_stats,
                            energy_plateau_range,
                            plan.gyromagnetic_ratio,
                            plan.material.damping,
                            pure_damping_relax,
                        )
                }
            } else {
                false
            };
            if stop_for_relaxation {
                break;
            }
        }

        let status = if paused {
            RunStatus::Paused
        } else if cancelled {
            RunStatus::Cancelled
        } else {
            RunStatus::Completed
        };
        let completion = if let Some(mut completion) = backend_completion {
            completion.status = match status {
                RunStatus::Completed => "completed",
                RunStatus::Cancelled => "cancelled",
                RunStatus::Paused => "paused",
                RunStatus::Failed => "failed",
            }
            .to_string();
            completion
        } else {
            crate::relaxation::resolve_stage_completion(
                status,
                plan.relaxation.as_ref(),
                crate::relaxation::RelaxationCompletionMetrics {
                    max_torque_apm: Some(current_local_stats.max_torque_Apm),
                    torque_confirmed: torque_confirmation.confirmed(),
                    accepted_energy_plateau_range_j: energy_plateau.range(),
                    steps: current_local_stats.step,
                    relaxation_time_s: Some(current_local_stats.time),
                    numerical_stagnation: false,
                },
            )
        };

        Ok(RunResult {
            status,
            steps,
            final_magnetization: self.backend.copy_m(cell_count)?,
            completion: Some(completion),
        })
    }

    fn execute_with_live_preview_streaming(
        &mut self,
        plan: &FdmPlanIR,
        until_seconds: f64,
        outputs: &[OutputIR],
        grid: [u32; 3],
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
        artifact_writer: Option<ArtifactPipelineSender>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<ExecutedRun, RunError> {
        if !normalize_runtime_context_signature(&self.plan_signature)
            .eq(&normalize_runtime_context_signature(plan))
        {
            return Err(RunError {
                message:
                    "interactive CUDA runtime context mismatch; caller must rebuild runtime before executing"
                        .to_string(),
            });
        }
        if until_seconds <= 0.0 {
            return Err(RunError {
                message: "interactive runtime until_seconds must be positive".to_string(),
            });
        }

        let cell_count = (self.original_grid[0] as usize)
            * (self.original_grid[1] as usize)
            * (self.original_grid[2] as usize);
        let initial_magnetization = self.backend.copy_m(cell_count)?;
        let mut artifacts = if let Some(writer) = artifact_writer {
            ArtifactRecorder::streaming(self.provenance.clone(), writer)
        } else {
            ArtifactRecorder::in_memory(self.provenance.clone())
        };
        let mut scalar_schedules = collect_scalar_schedules(outputs)?;
        let mut field_schedules = collect_field_schedules(outputs)?;
        let default_scalar_trace = scalar_schedules.is_empty();
        capture_initial_cuda_runtime_fields(
            &self.backend,
            cell_count,
            &mut field_schedules,
            &mut artifacts,
        )?;

        let base_step = self.total_steps;
        let base_time = self.total_time;
        let output_periods = scalar_schedules
            .iter()
            .chain(field_schedules.iter())
            .map(|schedule| schedule.every_seconds);
        let time_events = interactive_time_event_schedule(
            &plan.field_drives,
            base_time,
            until_seconds,
            output_periods,
        );
        reject_non_llg_interactive_relaxation(
            plan.relaxation.as_ref(),
            "interactive FDM CUDA runtime",
        )?;
        let mut dt = crate::resolve_timestep_policy(
            plan.integrator,
            plan.fixed_timestep,
            plan.adaptive_timestep.as_ref(),
            crate::types::TimestepExecutionLane::fdm_cuda(plan.precision),
        )?
        .initial_dt();
        let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
        let mut torque_confirmation = RelaxationTorqueConfirmation::default();
        let mut checkpoint = crate::interactive::CheckpointContext {
            display_selection,
            interrupt_requested,
            last_preview_revision: None,
        };
        let mut last_cached_preview_revision: Option<u64> = None;
        let mut cancelled = false;
        let mut paused = false;
        let mut steps: Vec<StepStats> = Vec::new();
        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let mut latest_local_stats: Option<StepStats> = None;
        let mut current_local_stats = self.backend.snapshot_step_stats(grid)?;
        current_local_stats.step -= base_step;
        current_local_stats.time -= base_time;
        let initial_display_state = (checkpoint.display_selection)();
        let mut pending_cached_preview_snapshots =
            self.begin_cached_preview_prefetch(&initial_display_state)?;

        while self.total_time - base_time < until_seconds {
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                current_local_stats.step,
            );
            let cached_display_due = cached_display_refresh_due(
                last_cached_preview_revision,
                &display_state,
                current_local_stats.step,
                field_every_n,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.backend.copy_live_preview_field(
                    &preview_cfg,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                )?)
            } else {
                None
            };
            let cached_preview_fields = if cached_display_due {
                match pending_cached_preview_snapshots.take() {
                    Some(snapshots) => Some(self.resolve_cached_preview_prefetch(snapshots)?),
                    None => {
                        let preview_cfg = display_state.preview_request();
                        let quantities = cached_preview_quantities_for(&display_state);
                        if quantities.is_empty() {
                            None
                        } else {
                            Some(self.snapshot_vector_fields(&quantities, &preview_cfg)?)
                        }
                    }
                }
            } else {
                None
            };
            let action = on_step(StepUpdate {
                coupled_checkpoint: None,
                stats: current_local_stats.clone(),
                grid,
                fem_mesh_generation_id: None,
                magnetization: None,
                preview_field,
                cached_preview_fields,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due: preview_due && display_is_global_scalar(&display_state),
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            if cached_display_due {
                last_cached_preview_revision = Some(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let proposed_dt = dt.min(until_seconds - (self.total_time - base_time));
            let dt_step = crate::time_events::cap_timestep_to_next_event(
                self.total_time,
                proposed_dt,
                &time_events,
                crate::schedules::OUTPUT_TIME_TOLERANCE,
            );
            let Some(total_stats) = self
                .backend
                .step_interruptible(dt_step, interrupt_requested)?
            else {
                continue;
            };
            self.total_steps = total_stats.step;
            self.total_time = total_stats.time;
            if let Some(next) = total_stats.dt_suggested {
                dt = next;
            }
            let post_step_display_state = (checkpoint.display_selection)();
            // Only start async cached-preview GPU→CPU copies when the next
            // iteration will actually consume them.
            let next_cached_step = (total_stats.step - base_step) + 1;
            if cached_display_refresh_due(
                last_cached_preview_revision,
                &post_step_display_state,
                next_cached_step,
                field_every_n,
            ) {
                pending_cached_preview_snapshots =
                    self.begin_cached_preview_prefetch(&post_step_display_state)?;
            } else {
                pending_cached_preview_snapshots = None;
            }

            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            current_local_stats = local_stats.clone();
            latest_local_stats = Some(local_stats.clone());
            artifacts.observe_physics_execution();
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                local_stats.step,
            );
            let cached_display_due = cached_display_refresh_due(
                last_cached_preview_revision,
                &display_state,
                local_stats.step,
                field_every_n,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.backend.copy_live_preview_field(
                    &preview_cfg,
                    grid,
                    self.plan_signature.active_mask.as_deref(),
                )?)
            } else {
                None
            };
            let scalar_row_due = local_stats.step <= 1
                || local_stats.step % field_every_n.max(1) == 0
                || (preview_due && display_is_global_scalar(&display_state));
            let scalar_output_due = scalar_schedules
                .iter()
                .any(|schedule| is_due(local_stats.time, schedule.next_time));
            if scalar_row_due || scalar_output_due {
                self.backend
                    .apply_average_m_to_step_stats(&mut local_stats)?;
                current_local_stats = local_stats.clone();
                latest_local_stats = Some(local_stats.clone());
            }
            let action = on_step(StepUpdate {
                coupled_checkpoint: None,
                stats: local_stats.clone(),
                grid,
                fem_mesh_generation_id: None,
                magnetization: None,
                preview_field,
                cached_preview_fields: None,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due,
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            if cached_display_due {
                last_cached_preview_revision = Some(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            record_due_cuda_runtime_outputs(
                &self.backend,
                cell_count,
                &local_stats,
                &mut scalar_schedules,
                &mut field_schedules,
                &mut steps,
                &mut artifacts,
            )?;

            let energy_plateau_range = energy_plateau.record(total_stats.e_total);
            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                local_stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
                    || torque_confirmation.observe_stats(
                        control,
                        &total_stats,
                        energy_plateau_range,
                        plan.gyromagnetic_ratio,
                        plan.material.damping,
                        pure_damping_relax,
                    )
            });
            if stop_for_relaxation {
                break;
            }
        }

        record_final_cuda_runtime_outputs(
            &self.backend,
            cell_count,
            latest_local_stats,
            default_scalar_trace,
            &scalar_schedules,
            &field_schedules,
            &mut steps,
            &mut artifacts,
        )?;

        let final_magnetization = self.backend.copy_m(cell_count)?;
        let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();
        let status = if paused {
            RunStatus::Paused
        } else if cancelled {
            RunStatus::Cancelled
        } else {
            RunStatus::Completed
        };
        let completion = crate::relaxation::resolve_stage_completion(
            status,
            plan.relaxation.as_ref(),
            crate::relaxation::RelaxationCompletionMetrics {
                max_torque_apm: Some(current_local_stats.max_torque_Apm),
                torque_confirmed: torque_confirmation.confirmed(),
                accepted_energy_plateau_range_j: energy_plateau.range(),
                steps: current_local_stats.step,
                relaxation_time_s: Some(current_local_stats.time),
                numerical_stagnation: false,
            },
        );
        Ok(ExecutedRun {
            result: RunResult {
                status,
                steps,
                final_magnetization,
                completion: Some(completion),
            },
            initial_magnetization,
            field_snapshots,
            field_snapshot_count,
            auxiliary_artifacts: vec![],
            provenance,
        })
    }
}

impl CpuInteractiveFemPreviewRuntime {
    fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        self.state
            .set_magnetization(magnetization.to_vec())
            .map_err(|error| RunError {
                message: format!(
                    "setting interactive FEM CPU magnetization failed: {}",
                    error
                ),
            })
    }

    fn snapshot_preview(
        &mut self,
        request: &LivePreviewRequest,
    ) -> Result<LivePreviewField, RunError> {
        let requested = [request.quantity.as_str()];
        if active_fem_preview_quantities(FemEngine::CpuNative, &self.plan_signature, &requested)
            .is_empty()
        {
            return Err(RunError {
                message: format!(
                    "preview quantity '{}' is not active for the current FEM problem",
                    request.quantity
                ),
            });
        }
        let observables =
            fem_baseline::observe_state(&self.problem, &self.state, &self.antenna_field)?;
        fem_baseline::build_fem_preview_field(
            request,
            &observables,
            &self.plan_signature.mesh,
            self.problem.material.saturation_magnetisation,
        )
    }

    fn snapshot_vector_fields(
        &mut self,
        quantities: &[&str],
        request: &LivePreviewRequest,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        let quantities =
            active_fem_preview_quantities(FemEngine::CpuNative, &self.plan_signature, quantities);
        let observables =
            fem_baseline::observe_state(&self.problem, &self.state, &self.antenna_field)?;
        let mut cached = Vec::new();
        let mut seen = HashSet::new();
        for quantity in quantities
            .iter()
            .filter_map(|quantity| normalized_quantity_name(quantity).ok())
        {
            if !seen.insert(quantity) {
                continue;
            }
            let mut preview_request = request.clone();
            preview_request.quantity = quantity.to_string();
            cached.push(fem_baseline::build_fem_preview_field(
                &preview_request,
                &observables,
                &self.plan_signature.mesh,
                self.problem.material.saturation_magnetisation,
            )?);
        }
        Ok(cached)
    }

    fn snapshot_step_stats(&mut self) -> Result<StepStats, RunError> {
        let observables =
            fem_baseline::observe_state(&self.problem, &self.state, &self.antenna_field)?;
        Ok(make_step_stats(
            self.total_steps,
            self.state.time_seconds,
            0.0,
            0,
            &observables,
        ))
    }

    fn execute_with_live_preview(
        &mut self,
        plan: &FemPlanIR,
        until_seconds: f64,
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<RunResult, RunError> {
        if !normalize_fem_runtime_context_signature(&self.plan_signature).eq(
            &normalize_fem_runtime_context_signature(&fem_plan_for_cpu_native(plan)),
        ) {
            return Err(RunError {
                message:
                    "interactive FEM CPU runtime context mismatch; caller must rebuild runtime before executing"
                        .to_string(),
            });
        }
        if until_seconds <= 0.0 {
            return Err(RunError {
                message: "interactive runtime until_seconds must be positive".to_string(),
            });
        }

        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let base_step = self.total_steps;
        let base_time = self.state.time_seconds;
        let time_events = interactive_time_event_schedule(
            &plan.field_drives,
            base_time,
            until_seconds,
            std::iter::empty(),
        );
        reject_non_llg_interactive_relaxation(
            plan.relaxation.as_ref(),
            "interactive FEM CPU runtime",
        )?;
        let mut dt = crate::resolve_timestep_policy(
            plan.integrator,
            plan.fixed_timestep,
            plan.adaptive_timestep.as_ref(),
            crate::types::TimestepExecutionLane::fem_cpu(plan.precision),
        )?
        .initial_dt();
        let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
        let mut torque_confirmation = RelaxationTorqueConfirmation::default();
        let mut checkpoint = crate::interactive::CheckpointContext {
            display_selection,
            interrupt_requested,
            last_preview_revision: None,
        };
        let mut last_cached_preview_revision: Option<u64> = None;
        let mut cancelled = false;
        let mut paused = false;
        let mut steps: Vec<StepStats> = Vec::new();
        let initial_observables =
            fem_baseline::observe_state(&self.problem, &self.state, &self.antenna_field)?;
        let mut current_observables = initial_observables;
        let mut current_local_stats = make_step_stats(
            self.total_steps,
            self.state.time_seconds,
            0.0,
            0,
            &current_observables,
        );
        current_local_stats.step -= base_step;
        current_local_stats.time -= base_time;

        while self.state.time_seconds - base_time < until_seconds {
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                current_local_stats.step,
            );
            let cached_display_due = cached_display_refresh_due(
                last_cached_preview_revision,
                &display_state,
                current_local_stats.step,
                field_every_n,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(build_mesh_preview_field_with_active_mask(
                    &preview_cfg,
                    select_observables(&current_observables, &preview_cfg.quantity)?,
                    mesh_quantity_active_mask(&preview_cfg.quantity, &self.plan_signature.mesh),
                ))
            } else {
                None
            };
            let cached_preview_fields = if cached_display_due {
                build_cached_mesh_preview_fields(
                    &display_state,
                    &current_observables,
                    &self.plan_signature.mesh,
                )
            } else {
                None
            };
            let action = on_step(StepUpdate {
                coupled_checkpoint: None,
                stats: current_local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh_generation_id: self.mesh.generation_id.clone(),
                magnetization: None,
                preview_field,
                cached_preview_fields,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due: preview_due && display_is_global_scalar(&display_state),
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            if cached_display_due {
                last_cached_preview_revision = Some(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let proposed_dt = dt.min(until_seconds - (self.state.time_seconds - base_time));
            let dt_step = crate::time_events::cap_timestep_to_next_event(
                self.state.time_seconds,
                proposed_dt,
                &time_events,
                crate::schedules::OUTPUT_TIME_TOLERANCE,
            );
            let wall_start = std::time::Instant::now();
            let report = self
                .problem
                .step_with_workspace(&mut self.state, dt_step, &mut self.integrator_ws)
                .map_err(|error| RunError {
                    message: format!("interactive FEM CPU step failed: {}", error),
                })?;
            let step_wall_us = wall_start.elapsed().as_micros();
            let wall_elapsed = wall_start.elapsed().as_nanos() as u64;
            self.total_steps += 1;
            if let Some(next) = report.suggested_next_dt {
                dt = next;
            }

            // Build lightweight StepStats from the StepReport (no redundant
            // demag / observe).  Full observe_state is deferred until we know
            // that preview or cached-preview data is actually needed.
            let total_stats = make_step_stats_from_report(
                self.total_steps,
                self.state.time_seconds,
                &report,
                wall_elapsed,
                self.state.magnetization(),
            );
            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            current_local_stats = local_stats.clone();
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                local_stats.step,
            );
            let cached_display_due = cached_display_refresh_due(
                last_cached_preview_revision,
                &display_state,
                local_stats.step,
                field_every_n,
            );

            // Only run the expensive full observe when vector-field data is
            // actually needed (preview refresh or cached preview refresh).
            let needs_observables =
                (preview_due && !display_is_global_scalar(&display_state)) || cached_display_due;

            if needs_observables {
                let observe_start = std::time::Instant::now();
                let observables =
                    fem_baseline::observe_state(&self.problem, &self.state, &self.antenna_field)?;
                let observe_us = observe_start.elapsed().as_micros();
                current_observables = observables;

                if self.total_steps % 100 == 0 && (observe_us > 100 || step_wall_us > 5000) {
                    eprintln!(
                        "[fullmag-runner] FEM CPU step {} telemetry: integrate={:.1}ms observe={:.1}ms",
                        self.total_steps,
                        step_wall_us as f64 / 1000.0,
                        observe_us as f64 / 1000.0,
                    );
                }
            }

            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(build_mesh_preview_field_with_active_mask(
                    &preview_cfg,
                    select_observables(&current_observables, &preview_cfg.quantity)?,
                    mesh_quantity_active_mask(&preview_cfg.quantity, &self.plan_signature.mesh),
                ))
            } else {
                None
            };
            let cached_preview_fields = if cached_display_due {
                build_cached_mesh_preview_fields(
                    &display_state,
                    &current_observables,
                    &self.plan_signature.mesh,
                )
            } else {
                None
            };
            let scalar_row_due = local_stats.step <= 1
                || local_stats.step % field_every_n.max(1) == 0
                || (preview_due && display_is_global_scalar(&display_state));
            let action = on_step(StepUpdate {
                coupled_checkpoint: None,
                stats: local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh_generation_id: self.mesh.generation_id.clone(),
                magnetization: None,
                preview_field,
                cached_preview_fields,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due,
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            if cached_display_due {
                last_cached_preview_revision = Some(display_state.revision);
            }
            steps.push(local_stats.clone());
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let energy_plateau_range = energy_plateau.record(total_stats.e_total);
            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                local_stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
                    || torque_confirmation.observe_stats(
                        control,
                        &total_stats,
                        energy_plateau_range,
                        plan.gyromagnetic_ratio,
                        plan.material.damping,
                        pure_damping_relax,
                    )
            });
            if stop_for_relaxation {
                break;
            }
        }

        let status = if paused {
            RunStatus::Paused
        } else if cancelled {
            RunStatus::Cancelled
        } else {
            RunStatus::Completed
        };
        let completion = crate::relaxation::resolve_stage_completion(
            status,
            plan.relaxation.as_ref(),
            crate::relaxation::RelaxationCompletionMetrics {
                max_torque_apm: None,
                torque_confirmed: false,
                accepted_energy_plateau_range_j: energy_plateau.range(),
                steps: current_local_stats.step,
                relaxation_time_s: Some(current_local_stats.time),
                numerical_stagnation: false,
            },
        );

        Ok(RunResult {
            status,
            steps,
            final_magnetization: self.state.magnetization().to_vec(),
            completion: Some(completion),
        })
    }

    fn execute_with_live_preview_streaming(
        &mut self,
        plan: &FemPlanIR,
        until_seconds: f64,
        outputs: &[OutputIR],
        field_every_n: u64,
        artifact_writer: Option<ArtifactPipelineSender>,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<ExecutedRun, RunError> {
        if !normalize_fem_runtime_context_signature(&self.plan_signature).eq(
            &normalize_fem_runtime_context_signature(&fem_plan_for_cpu_native(plan)),
        ) {
            return Err(RunError {
                message:
                    "interactive FEM CPU runtime context mismatch; caller must rebuild runtime before executing"
                        .to_string(),
            });
        }
        if until_seconds <= 0.0 {
            return Err(RunError {
                message: "interactive runtime until_seconds must be positive".to_string(),
            });
        }

        let initial_magnetization = self.state.magnetization().to_vec();
        let mut artifacts = if let Some(writer) = artifact_writer {
            ArtifactRecorder::streaming(self.provenance.clone(), writer)
        } else {
            ArtifactRecorder::in_memory(self.provenance.clone())
        };
        let mut scalar_schedules = collect_scalar_schedules(outputs)?;
        let mut field_schedules = collect_field_schedules(outputs)?;
        let default_scalar_trace = scalar_schedules.is_empty();
        let initial_observables =
            fem_baseline::observe_state(&self.problem, &self.state, &self.antenna_field)?;
        let mut steps = Vec::new();
        if default_scalar_trace {
            let stats = make_step_stats(0, 0.0, 0.0, 0, &initial_observables);
            artifacts.record_scalar(&stats)?;
            steps.push(stats);
        } else {
            record_due_cpu_outputs(
                &initial_observables,
                0,
                0.0,
                0.0,
                0,
                &mut scalar_schedules,
                &mut field_schedules,
                &mut steps,
                &mut artifacts,
            )?;
        }

        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let base_step = self.total_steps;
        let base_time = self.state.time_seconds;
        let output_periods = scalar_schedules
            .iter()
            .chain(field_schedules.iter())
            .map(|schedule| schedule.every_seconds);
        let time_events = interactive_time_event_schedule(
            &plan.field_drives,
            base_time,
            until_seconds,
            output_periods,
        );
        reject_non_llg_interactive_relaxation(
            plan.relaxation.as_ref(),
            "interactive FEM CPU runtime",
        )?;
        let mut dt = crate::resolve_timestep_policy(
            plan.integrator,
            plan.fixed_timestep,
            plan.adaptive_timestep.as_ref(),
            crate::types::TimestepExecutionLane::fem_cpu(plan.precision),
        )?
        .initial_dt();
        let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
        let mut torque_confirmation = RelaxationTorqueConfirmation::default();
        let mut checkpoint = crate::interactive::CheckpointContext {
            display_selection,
            interrupt_requested,
            last_preview_revision: None,
        };
        let mut cancelled = false;
        let mut paused = false;
        let mut latest_local_stats: Option<StepStats> = None;
        let mut current_observables =
            fem_baseline::observe_state(&self.problem, &self.state, &self.antenna_field)?;
        let mut current_local_stats = make_step_stats(
            self.total_steps,
            self.state.time_seconds,
            0.0,
            0,
            &current_observables,
        );
        current_local_stats.step -= base_step;
        current_local_stats.time -= base_time;

        while self.state.time_seconds - base_time < until_seconds {
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                current_local_stats.step,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(build_mesh_preview_field_with_active_mask(
                    &preview_cfg,
                    select_observables(&current_observables, &preview_cfg.quantity)?,
                    mesh_quantity_active_mask(&preview_cfg.quantity, &self.plan_signature.mesh),
                ))
            } else {
                None
            };
            let action = on_step(StepUpdate {
                coupled_checkpoint: None,
                stats: current_local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh_generation_id: self.mesh.generation_id.clone(),
                magnetization: None,
                preview_field,
                cached_preview_fields: None,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due: preview_due && display_is_global_scalar(&display_state),
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let proposed_dt = dt.min(until_seconds - (self.state.time_seconds - base_time));
            let dt_step = crate::time_events::cap_timestep_to_next_event(
                self.state.time_seconds,
                proposed_dt,
                &time_events,
                crate::schedules::OUTPUT_TIME_TOLERANCE,
            );
            let wall_start = std::time::Instant::now();
            let report = self
                .problem
                .step_with_workspace(&mut self.state, dt_step, &mut self.integrator_ws)
                .map_err(|error| RunError {
                    message: format!("interactive FEM CPU step failed: {}", error),
                })?;
            artifacts.observe_physics_execution();
            let step_wall_us = wall_start.elapsed().as_micros();
            let wall_elapsed = wall_start.elapsed().as_nanos() as u64;
            self.total_steps += 1;
            if let Some(next) = report.suggested_next_dt {
                dt = next;
            }

            // Build lightweight StepStats from the StepReport (no redundant
            // demag / observe).  Full observe_state is deferred until we know
            // that preview or field-snapshot data is actually needed.
            let total_stats = make_step_stats_from_report(
                self.total_steps,
                self.state.time_seconds,
                &report,
                wall_elapsed,
                self.state.magnetization(),
            );
            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            current_local_stats = local_stats.clone();
            latest_local_stats = Some(local_stats.clone());

            // Determine what outputs are due BEFORE deciding whether to run
            // the expensive observe_state.
            let scalar_due_for_output = scalar_schedules
                .iter()
                .any(|schedule| is_due(local_stats.time, schedule.next_time));
            let due_field_names: Vec<String> = field_schedules
                .iter()
                .filter(|schedule| is_due(local_stats.time, schedule.next_time))
                .map(|schedule| schedule.name.clone())
                .collect();

            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                local_stats.step,
            );
            let needs_observables = !due_field_names.is_empty()
                || (preview_due && !display_is_global_scalar(&display_state));

            // Only run the expensive full observe when vector-field data is
            // actually needed (preview refresh or field snapshot output).
            if needs_observables {
                let observe_start = std::time::Instant::now();
                let observables =
                    fem_baseline::observe_state(&self.problem, &self.state, &self.antenna_field)?;
                let observe_us = observe_start.elapsed().as_micros();
                current_observables = observables.clone();

                if self.total_steps % 100 == 0 && (observe_us > 100 || step_wall_us > 5000) {
                    eprintln!(
                        "[fullmag-runner] FEM CPU output-step {} telemetry: integrate={:.1}ms observe={:.1}ms",
                        self.total_steps,
                        step_wall_us as f64 / 1000.0,
                        observe_us as f64 / 1000.0,
                    );
                }

                // Record field snapshots that are due.
                if !due_field_names.is_empty() {
                    for name in &due_field_names {
                        artifacts.record_field_snapshot(FieldSnapshot {
                            name: name.clone(),
                            step: local_stats.step,
                            time: local_stats.time,
                            solver_dt: report.dt_used,
                            component_count: 3,
                            component_order: "xyz".into(),
                            location: "sample".into(),
                            scope: "full".into(),
                            revision: (local_stats.step as u64).saturating_add(1),
                            values: FieldSnapshot::flatten_vec3(
                                select_output_field_values_from_observables(&observables, name)?,
                            ),
                        })?;
                    }
                    advance_due_schedules(&mut field_schedules, local_stats.time);
                }
            }

            // Record scalar outputs (uses StepStats only, no vector fields).
            if scalar_due_for_output {
                artifacts.record_scalar(&local_stats)?;
                steps.push(local_stats.clone());
                advance_due_schedules(&mut scalar_schedules, local_stats.time);
            }

            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(build_mesh_preview_field_with_active_mask(
                    &preview_cfg,
                    select_observables(&current_observables, &preview_cfg.quantity)?,
                    mesh_quantity_active_mask(&preview_cfg.quantity, &self.plan_signature.mesh),
                ))
            } else {
                None
            };
            let scalar_row_due = local_stats.step <= 1
                || local_stats.step % field_every_n.max(1) == 0
                || (preview_due && display_is_global_scalar(&display_state));
            let action = on_step(StepUpdate {
                coupled_checkpoint: None,
                stats: local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh_generation_id: self.mesh.generation_id.clone(),
                magnetization: None,
                preview_field,
                cached_preview_fields: None,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due,
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let energy_plateau_range = energy_plateau.record(total_stats.e_total);
            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                local_stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
                    || torque_confirmation.observe_stats(
                        control,
                        &total_stats,
                        energy_plateau_range,
                        plan.gyromagnetic_ratio,
                        plan.material.damping,
                        pure_damping_relax,
                    )
            });
            if stop_for_relaxation {
                break;
            }
        }

        if let Some(final_stats) = latest_local_stats {
            let final_observables =
                fem_baseline::observe_state(&self.problem, &self.state, &self.antenna_field)?;
            record_final_cpu_outputs(
                &final_observables,
                final_stats.step,
                final_stats.time,
                final_stats.dt,
                default_scalar_trace,
                &field_schedules,
                &mut steps,
                &mut artifacts,
            )?;
        }

        let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();
        let status = if paused {
            RunStatus::Paused
        } else if cancelled {
            RunStatus::Cancelled
        } else {
            RunStatus::Completed
        };
        let completion = crate::relaxation::resolve_stage_completion(
            status,
            plan.relaxation.as_ref(),
            crate::relaxation::RelaxationCompletionMetrics {
                max_torque_apm: Some(current_local_stats.max_torque_Apm),
                torque_confirmed: torque_confirmation.confirmed(),
                accepted_energy_plateau_range_j: energy_plateau.range(),
                steps: current_local_stats.step,
                relaxation_time_s: Some(current_local_stats.time),
                numerical_stagnation: false,
            },
        );
        Ok(ExecutedRun {
            result: RunResult {
                status,
                steps,
                final_magnetization: self.state.magnetization().to_vec(),
                completion: Some(completion),
            },
            initial_magnetization,
            field_snapshots,
            field_snapshot_count,
            provenance,
            auxiliary_artifacts: vec![],
        })
    }
}

#[cfg(feature = "fem-gpu")]
impl GpuInteractiveFemPreviewRuntime {
    fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        self.backend.upload_magnetization(magnetization)?;
        let _ = self.backend.snapshot_step_stats(self.node_count)?;
        Ok(())
    }

    fn snapshot_preview(
        &mut self,
        request: &LivePreviewRequest,
    ) -> Result<LivePreviewField, RunError> {
        let requested = [request.quantity.as_str()];
        if active_fem_preview_quantities(FemEngine::NativeGpu, &self.plan_signature, &requested)
            .is_empty()
        {
            return Err(RunError {
                message: format!(
                    "preview quantity '{}' is not active for the current FEM problem",
                    request.quantity
                ),
            });
        }
        if normalized_quantity_name(&request.quantity).ok() == Some("H_ant") {
            return Ok(build_mesh_preview_field_with_active_mask(
                request,
                &self.antenna_field,
                None,
            ));
        }
        self.backend
            .copy_live_preview_field(request, self.node_count)
    }

    fn snapshot_vector_fields(
        &mut self,
        quantities: &[&str],
        request: &LivePreviewRequest,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        let quantities =
            active_fem_preview_quantities(FemEngine::NativeGpu, &self.plan_signature, quantities);
        let mut cached = Vec::new();
        let mut seen = HashSet::new();

        for quantity in quantities
            .iter()
            .filter_map(|quantity| normalized_quantity_name(quantity).ok())
        {
            if !seen.insert(quantity) {
                continue;
            }
            let mut preview_request = request.clone();
            preview_request.quantity = quantity.to_string();
            if quantity == "H_ant" {
                cached.push(build_mesh_preview_field_with_active_mask(
                    &preview_request,
                    &self.antenna_field,
                    None,
                ));
            } else {
                cached.push(
                    self.backend
                        .copy_live_preview_field(&preview_request, self.node_count)?,
                );
            }
        }

        Ok(cached)
    }

    fn snapshot_step_stats(&mut self) -> Result<StepStats, RunError> {
        self.backend.snapshot_step_stats(self.node_count)
    }

    fn execute_with_live_preview(
        &mut self,
        plan: &FemPlanIR,
        until_seconds: f64,
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<RunResult, RunError> {
        if !normalize_fem_runtime_context_signature(&self.plan_signature).eq(
            &normalize_fem_runtime_context_signature(&fem_plan_for_native_gpu(plan)),
        ) {
            return Err(RunError {
                message:
                    "interactive FEM GPU runtime context mismatch; caller must rebuild runtime before executing"
                        .to_string(),
            });
        }
        if until_seconds <= 0.0 {
            return Err(RunError {
                message: "interactive runtime until_seconds must be positive".to_string(),
            });
        }

        let base_step = self.total_steps;
        let base_time = self.total_time;
        self.backend.begin_stage(base_time)?;
        let time_events = interactive_time_event_schedule(
            &plan.field_drives,
            base_time,
            until_seconds,
            std::iter::empty(),
        );
        reject_non_llg_interactive_relaxation(
            plan.relaxation.as_ref(),
            "interactive FEM GPU runtime",
        )?;
        let mut dt = crate::resolve_timestep_policy(
            plan.integrator,
            plan.fixed_timestep,
            plan.adaptive_timestep.as_ref(),
            crate::types::TimestepExecutionLane::fem_gpu(plan.precision),
        )?
        .initial_dt();
        let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
        let mut torque_confirmation = RelaxationTorqueConfirmation::default();
        let mut checkpoint = crate::interactive::CheckpointContext {
            display_selection,
            interrupt_requested,
            last_preview_revision: None,
        };
        let mut last_cached_preview_revision: Option<u64> = None;
        let mut cancelled = false;
        let mut paused = false;
        let mut steps: Vec<StepStats> = Vec::new();
        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let mut current_local_stats = self.backend.snapshot_step_stats(self.node_count)?;
        current_local_stats.step -= base_step;
        current_local_stats.time -= base_time;

        while self.total_time - base_time < until_seconds {
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                current_local_stats.step,
            );
            let cached_display_due = cached_display_refresh_due(
                last_cached_preview_revision,
                &display_state,
                current_local_stats.step,
                field_every_n,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.snapshot_preview(&preview_cfg)?)
            } else {
                None
            };
            let cached_preview_fields = if cached_display_due {
                let preview_cfg = display_state.preview_request();
                let quantities = cached_preview_quantities_for(&display_state);
                if quantities.is_empty() {
                    None
                } else {
                    Some(self.snapshot_vector_fields(&quantities, &preview_cfg)?)
                }
            } else {
                None
            };
            let action = on_step(StepUpdate {
                coupled_checkpoint: None,
                stats: current_local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh_generation_id: self.mesh.generation_id.clone(),
                magnetization: None,
                preview_field,
                cached_preview_fields,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due: preview_due && display_is_global_scalar(&display_state),
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            if cached_display_due {
                last_cached_preview_revision = Some(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let proposed_dt = dt.min(until_seconds - (self.total_time - base_time));
            let dt_step = crate::time_events::cap_timestep_to_next_event(
                self.total_time,
                proposed_dt,
                &time_events,
                crate::schedules::OUTPUT_TIME_TOLERANCE,
            );
            let Some(total_stats) = self
                .backend
                .step_interruptible(dt_step, interrupt_requested)?
            else {
                continue;
            };
            self.total_steps = total_stats.step;
            self.total_time = total_stats.time;
            if let Some(next) = total_stats.dt_suggested {
                dt = next;
            }

            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            current_local_stats = local_stats.clone();
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                local_stats.step,
            );
            let cached_display_due = cached_display_refresh_due(
                last_cached_preview_revision,
                &display_state,
                local_stats.step,
                field_every_n,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.snapshot_preview(&preview_cfg)?)
            } else {
                None
            };
            let cached_preview_fields = if cached_display_due {
                let preview_cfg = display_state.preview_request();
                let quantities = cached_preview_quantities_for(&display_state);
                if quantities.is_empty() {
                    None
                } else {
                    Some(self.snapshot_vector_fields(&quantities, &preview_cfg)?)
                }
            } else {
                None
            };
            let scalar_row_due = local_stats.step <= 1
                || local_stats.step % field_every_n.max(1) == 0
                || (preview_due && display_is_global_scalar(&display_state));
            let action = on_step(StepUpdate {
                coupled_checkpoint: None,
                stats: local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh_generation_id: self.mesh.generation_id.clone(),
                magnetization: None,
                preview_field,
                cached_preview_fields,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due,
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            if cached_display_due {
                last_cached_preview_revision = Some(display_state.revision);
            }
            steps.push(local_stats.clone());
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let energy_plateau_range = energy_plateau.record(total_stats.e_total);
            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                local_stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
                    || torque_confirmation.observe_stats(
                        control,
                        &total_stats,
                        energy_plateau_range,
                        plan.gyromagnetic_ratio,
                        plan.material.damping,
                        pure_damping_relax,
                    )
            });
            if stop_for_relaxation {
                break;
            }
        }

        let status = if paused {
            RunStatus::Paused
        } else if cancelled {
            RunStatus::Cancelled
        } else {
            RunStatus::Completed
        };
        let completion = crate::relaxation::resolve_stage_completion(
            status,
            plan.relaxation.as_ref(),
            crate::relaxation::RelaxationCompletionMetrics {
                max_torque_apm: Some(current_local_stats.max_torque_Apm),
                torque_confirmed: torque_confirmation.confirmed(),
                accepted_energy_plateau_range_j: energy_plateau.range(),
                steps: current_local_stats.step,
                relaxation_time_s: Some(current_local_stats.time),
                numerical_stagnation: false,
            },
        );

        Ok(RunResult {
            status,
            steps,
            final_magnetization: self.backend.copy_m(self.node_count)?,
            completion: Some(completion),
        })
    }

    fn execute_with_live_preview_streaming(
        &mut self,
        plan: &FemPlanIR,
        until_seconds: f64,
        outputs: &[OutputIR],
        field_every_n: u64,
        artifact_writer: Option<ArtifactPipelineSender>,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<ExecutedRun, RunError> {
        if !normalize_fem_runtime_context_signature(&self.plan_signature).eq(
            &normalize_fem_runtime_context_signature(&fem_plan_for_native_gpu(plan)),
        ) {
            return Err(RunError {
                message:
                    "interactive FEM GPU runtime context mismatch; caller must rebuild runtime before executing"
                        .to_string(),
            });
        }
        if until_seconds <= 0.0 {
            return Err(RunError {
                message: "interactive runtime until_seconds must be positive".to_string(),
            });
        }

        let initial_magnetization = self.backend.copy_m(self.node_count)?;
        let mut artifacts = if let Some(writer) = artifact_writer {
            ArtifactRecorder::streaming(self.provenance.clone(), writer)
        } else {
            ArtifactRecorder::in_memory(self.provenance.clone())
        };
        let mut scalar_schedules = collect_scalar_schedules(outputs)?;
        let mut field_schedules = collect_field_schedules(outputs)?;
        let default_scalar_trace = scalar_schedules.is_empty();
        capture_initial_native_fem_runtime_fields(
            &self.backend,
            self.node_count,
            &mut field_schedules,
            &mut artifacts,
        )?;

        let base_step = self.total_steps;
        let base_time = self.total_time;
        self.backend.begin_stage(base_time)?;
        let output_periods = scalar_schedules
            .iter()
            .chain(field_schedules.iter())
            .map(|schedule| schedule.every_seconds);
        let time_events = interactive_time_event_schedule(
            &plan.field_drives,
            base_time,
            until_seconds,
            output_periods,
        );
        reject_non_llg_interactive_relaxation(
            plan.relaxation.as_ref(),
            "interactive FEM GPU runtime",
        )?;
        let mut dt = crate::resolve_timestep_policy(
            plan.integrator,
            plan.fixed_timestep,
            plan.adaptive_timestep.as_ref(),
            crate::types::TimestepExecutionLane::fem_gpu(plan.precision),
        )?
        .initial_dt();
        let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
        let mut torque_confirmation = RelaxationTorqueConfirmation::default();
        let mut checkpoint = crate::interactive::CheckpointContext {
            display_selection,
            interrupt_requested,
            last_preview_revision: None,
        };
        let mut cancelled = false;
        let mut paused = false;
        let mut steps: Vec<StepStats> = Vec::new();
        let pure_damping_relax = llg_overdamped_uses_pure_damping(plan.relaxation.as_ref());
        let mut latest_local_stats: Option<StepStats> = None;
        let mut current_local_stats = self.backend.snapshot_step_stats(self.node_count)?;
        current_local_stats.step -= base_step;
        current_local_stats.time -= base_time;

        while self.total_time - base_time < until_seconds {
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                current_local_stats.step,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.snapshot_preview(&preview_cfg)?)
            } else {
                None
            };
            let action = on_step(StepUpdate {
                coupled_checkpoint: None,
                stats: current_local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh_generation_id: self.mesh.generation_id.clone(),
                magnetization: None,
                preview_field,
                cached_preview_fields: None,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due: preview_due && display_is_global_scalar(&display_state),
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            let proposed_dt = dt.min(until_seconds - (self.total_time - base_time));
            let dt_step = crate::time_events::cap_timestep_to_next_event(
                self.total_time,
                proposed_dt,
                &time_events,
                crate::schedules::OUTPUT_TIME_TOLERANCE,
            );
            let Some(total_stats) = self
                .backend
                .step_interruptible(dt_step, interrupt_requested)?
            else {
                continue;
            };
            artifacts.observe_physics_execution();
            self.total_steps = total_stats.step;
            self.total_time = total_stats.time;
            if let Some(next) = total_stats.dt_suggested {
                dt = next;
            }

            let mut local_stats = total_stats.clone();
            local_stats.step -= base_step;
            local_stats.time -= base_time;
            current_local_stats = local_stats.clone();
            latest_local_stats = Some(local_stats.clone());
            let display_state = (checkpoint.display_selection)();
            let preview_due = display_refresh_due(
                checkpoint.last_preview_revision,
                &display_state,
                local_stats.step,
            );
            let preview_field = if preview_due && !display_is_global_scalar(&display_state) {
                let preview_cfg = display_state.preview_request();
                Some(self.snapshot_preview(&preview_cfg)?)
            } else {
                None
            };
            let scalar_row_due = local_stats.step <= 1
                || local_stats.step % field_every_n.max(1) == 0
                || (preview_due && display_is_global_scalar(&display_state));
            let action = on_step(StepUpdate {
                coupled_checkpoint: None,
                stats: local_stats.clone(),
                grid: [0, 0, 0],
                fem_mesh_generation_id: self.mesh.generation_id.clone(),
                magnetization: None,
                preview_field,
                cached_preview_fields: None,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due,
                finished: false,
            });
            if preview_due {
                checkpoint.mark_display_refreshed(display_state.revision);
            }
            match action {
                StepAction::Stop => {
                    cancelled = true;
                    break;
                }
                StepAction::Pause => {
                    paused = true;
                    break;
                }
                _ => {}
            }

            record_due_native_fem_runtime_outputs(
                &self.backend,
                self.node_count,
                &local_stats,
                &mut scalar_schedules,
                &mut field_schedules,
                &mut steps,
                &mut artifacts,
            )?;

            let energy_plateau_range = energy_plateau.record(total_stats.e_total);
            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                local_stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
                    || torque_confirmation.observe_stats(
                        control,
                        &total_stats,
                        energy_plateau_range,
                        plan.gyromagnetic_ratio,
                        plan.material.damping,
                        pure_damping_relax,
                    )
            });
            if stop_for_relaxation {
                break;
            }
        }

        record_final_native_fem_runtime_outputs(
            &self.backend,
            self.node_count,
            latest_local_stats,
            default_scalar_trace,
            &scalar_schedules,
            &field_schedules,
            &mut steps,
            &mut artifacts,
        )?;

        let final_magnetization = self.backend.copy_m(self.node_count)?;
        let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();
        let status = if paused {
            RunStatus::Paused
        } else if cancelled {
            RunStatus::Cancelled
        } else {
            RunStatus::Completed
        };
        let completion = crate::relaxation::resolve_stage_completion(
            status,
            plan.relaxation.as_ref(),
            crate::relaxation::RelaxationCompletionMetrics {
                max_torque_apm: None,
                torque_confirmed: false,
                accepted_energy_plateau_range_j: energy_plateau.range(),
                steps: current_local_stats.step,
                relaxation_time_s: Some(current_local_stats.time),
                numerical_stagnation: false,
            },
        );
        Ok(ExecutedRun {
            result: RunResult {
                status,
                steps,
                final_magnetization,
                completion: Some(completion),
            },
            initial_magnetization,
            field_snapshots,
            field_snapshot_count,
            auxiliary_artifacts: vec![],
            provenance,
        })
    }
}

fn normalize_plan_signature(plan: &FdmPlanIR) -> FdmPlanIR {
    let mut normalized = plan.clone();
    normalized.initial_magnetization.clear();
    normalized
}

fn normalize_runtime_context_signature(plan: &FdmPlanIR) -> FdmPlanIR {
    let mut normalized = normalize_plan_signature(plan);
    normalized.integrator = None;
    normalized.fixed_timestep = None;
    normalized.adaptive_timestep = None;
    normalized.field_refresh = None;
    normalized.relaxation = None;
    normalized.time_stage = Default::default();
    normalized
}

fn normalize_fem_plan_signature(plan: &FemPlanIR) -> FemPlanIR {
    let mut normalized = plan.clone();
    normalized.initial_magnetization.clear();
    normalized
}

fn normalize_fem_runtime_context_signature(plan: &FemPlanIR) -> FemPlanIR {
    let mut normalized = normalize_fem_plan_signature(plan);
    normalized.integrator = None;
    normalized.fixed_timestep = None;
    normalized.adaptive_timestep = None;
    normalized.field_refresh = None;
    normalized.relaxation = None;
    normalized.time_stage = Default::default();
    normalized
}

fn fem_plan_for_cpu_native(plan: &FemPlanIR) -> FemPlanIR {
    let mut native = plan.clone();
    if native.mfem_device_string.is_none() {
        native.mfem_device_string = Some("cpu".to_string());
    }
    native
}

#[cfg(feature = "fem-gpu")]
fn fem_plan_for_native_gpu(plan: &FemPlanIR) -> FemPlanIR {
    let mut native = plan.clone();
    if native.mfem_device_string.is_none() {
        let mfem_device = std::env::var("FULLMAG_FEM_MFEM_DEVICE")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| crate::native_fem::native_fem_mfem_device_string_requests_gpu(value))
            .unwrap_or_else(|| "cuda".to_string());
        native.mfem_device_string = Some(mfem_device);
    }
    native
}

fn record_due_cpu_outputs(
    observables: &StateObservables,
    step: u64,
    time: f64,
    solver_dt: f64,
    wall_time_ns: u64,
    scalar_schedules: &mut [OutputSchedule],
    field_schedules: &mut [OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let scalar_due = scalar_schedules
        .iter()
        .any(|schedule| is_due(time, schedule.next_time));
    let due_field_names = field_schedules
        .iter()
        .filter(|schedule| is_due(time, schedule.next_time))
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();

    if !scalar_due && due_field_names.is_empty() {
        return Ok(());
    }

    if scalar_due {
        let stats = make_step_stats(step, time, solver_dt, wall_time_ns, observables);
        artifacts.record_scalar(&stats)?;
        steps.push(stats);
        advance_due_schedules(scalar_schedules, time);
    }

    if !due_field_names.is_empty() {
        for name in due_field_names {
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step,
                time,
                solver_dt,
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: step.saturating_add(1),
                values: FieldSnapshot::flatten_vec3(select_output_field_values_from_observables(
                    observables,
                    &name,
                )?),
            })?;
        }
        advance_due_schedules(field_schedules, time);
    }

    Ok(())
}

fn record_final_cpu_outputs(
    observables: &StateObservables,
    step: u64,
    time: f64,
    solver_dt: f64,
    default_scalar_trace: bool,
    field_schedules: &[OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let need_scalar = default_scalar_trace
        || steps
            .last()
            .map(|stats| !same_time(stats.time, time))
            .unwrap_or(true);

    let missing_field_names = field_schedules
        .iter()
        .filter(|schedule| {
            schedule
                .last_sampled_time
                .map(|sampled| !same_time(sampled, time))
                .unwrap_or(true)
        })
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();

    if !need_scalar && missing_field_names.is_empty() {
        return Ok(());
    }

    if need_scalar {
        let stats = make_step_stats(step, time, solver_dt, 0, observables);
        artifacts.record_scalar(&stats)?;
        steps.push(stats);
    }

    for name in missing_field_names {
        artifacts.record_field_snapshot(FieldSnapshot {
            name: name.clone(),
            step,
            time,
            solver_dt,
            component_count: 3,
            component_order: "xyz".into(),
            location: "sample".into(),
            scope: "full".into(),
            revision: step.saturating_add(1),
            values: FieldSnapshot::flatten_vec3(select_output_field_values_from_observables(
                observables,
                &name,
            )?),
        })?;
    }

    Ok(())
}

fn select_output_field_values_from_observables(
    observables: &StateObservables,
    name: &str,
) -> Result<Vec<[f64; 3]>, RunError> {
    if let Some(dot_pos) = name.find('.') {
        let base = &name[..dot_pos];
        let component = &name[dot_pos + 1..];
        let full = select_output_base_field_from_observables(observables, base)?;
        let idx = match component {
            "x" => 0,
            "y" => 1,
            "z" => 2,
            other => {
                return Err(RunError {
                    message: format!(
                        "unsupported interactive output snapshot component '{}' in '{}'",
                        other, name
                    ),
                });
            }
        };
        return Ok(full.iter().map(|value| [value[idx], 0.0, 0.0]).collect());
    }
    select_output_base_field_from_observables(observables, name)
}

fn select_output_base_field_from_observables(
    observables: &StateObservables,
    name: &str,
) -> Result<Vec<[f64; 3]>, RunError> {
    Ok(match name {
        "m" => observables.magnetization.clone(),
        "H_ex" => observables.exchange_field.clone(),
        "H_demag" => observables.demag_field.clone(),
        "H_ant" => observables.antenna_field.clone(),
        "H_ext" => observables.external_field.clone(),
        "H_eff" => observables.effective_field.clone(),
        "torque" => observables.torque_field.clone(),
        other => {
            return Err(RunError {
                message: format!("unsupported interactive output field snapshot '{}'", other),
            });
        }
    })
}

#[cfg(feature = "fem-gpu")]
fn capture_initial_native_fem_runtime_fields(
    backend: &NativeFemBackend,
    node_count: usize,
    field_schedules: &mut [OutputSchedule],
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let due_field_names = field_schedules
        .iter()
        .filter(|schedule| is_due(0.0, schedule.next_time))
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();

    for name in due_field_names {
        artifacts.record_field_snapshot(FieldSnapshot {
            name: name.clone(),
            step: 0,
            time: 0.0,
            solver_dt: 0.0,
            component_count: 3,
            component_order: "xyz".into(),
            location: "sample".into(),
            scope: "full".into(),
            revision: (0 as u64).saturating_add(1),
            values: FieldSnapshot::flatten_vec3(copy_native_fem_field_values(
                backend, node_count, &name,
            )?),
        })?;
    }
    advance_due_schedules(field_schedules, 0.0);
    Ok(())
}

#[cfg(feature = "fem-gpu")]
fn record_due_native_fem_runtime_outputs(
    backend: &NativeFemBackend,
    node_count: usize,
    stats: &StepStats,
    scalar_schedules: &mut [OutputSchedule],
    field_schedules: &mut [OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let scalar_due = scalar_schedules
        .iter()
        .any(|schedule| is_due(stats.time, schedule.next_time));
    if scalar_due {
        artifacts.record_scalar(stats)?;
        steps.push(stats.clone());
        advance_due_schedules(scalar_schedules, stats.time);
    }

    let due_field_names = field_schedules
        .iter()
        .filter(|schedule| is_due(stats.time, schedule.next_time))
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();
    for name in due_field_names {
        artifacts.record_field_snapshot(FieldSnapshot {
            name: name.clone(),
            step: stats.step,
            time: stats.time,
            solver_dt: stats.dt,
            component_count: 3,
            component_order: "xyz".into(),
            location: "sample".into(),
            scope: "full".into(),
            revision: (stats.step as u64).saturating_add(1),
            values: FieldSnapshot::flatten_vec3(copy_native_fem_field_values(
                backend, node_count, &name,
            )?),
        })?;
    }
    advance_due_schedules(field_schedules, stats.time);
    Ok(())
}

#[cfg(feature = "fem-gpu")]
fn record_final_native_fem_runtime_outputs(
    backend: &NativeFemBackend,
    node_count: usize,
    latest_stats: Option<StepStats>,
    default_scalar_trace: bool,
    scalar_schedules: &[OutputSchedule],
    field_schedules: &[OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let Some(latest_stats) = latest_stats else {
        return Ok(());
    };

    let need_scalar = default_scalar_trace
        || steps
            .last()
            .map(|stats| !same_time(stats.time, latest_stats.time))
            .unwrap_or(true);
    if need_scalar {
        artifacts.record_scalar(&latest_stats)?;
        steps.push(latest_stats.clone());
    }

    let missing_field_names = field_schedules
        .iter()
        .filter(|schedule| {
            schedule
                .last_sampled_time
                .map(|sampled| !same_time(sampled, latest_stats.time))
                .unwrap_or(true)
        })
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();

    for name in &missing_field_names {
        artifacts.record_field_snapshot(FieldSnapshot {
            name: name.clone(),
            step: latest_stats.step,
            time: latest_stats.time,
            solver_dt: latest_stats.dt,
            component_count: 3,
            component_order: "xyz".into(),
            location: "sample".into(),
            scope: "full".into(),
            revision: (latest_stats.step as u64).saturating_add(1),
            values: FieldSnapshot::flatten_vec3(copy_native_fem_field_values(
                backend, node_count, name,
            )?),
        })?;
    }
    let _ = scalar_schedules;
    Ok(())
}

#[cfg(feature = "fem-gpu")]
fn copy_native_fem_field_values(
    backend: &NativeFemBackend,
    node_count: usize,
    name: &str,
) -> Result<Vec<[f64; 3]>, RunError> {
    if let Some(dot_pos) = name.find('.') {
        let base = &name[..dot_pos];
        let component = &name[dot_pos + 1..];
        let full = copy_native_fem_base_field_values(backend, node_count, base)?;
        let idx = match component {
            "x" => 0,
            "y" => 1,
            "z" => 2,
            other => {
                return Err(RunError {
                    message: format!(
                        "unsupported interactive FEM snapshot component '{}' in '{}'",
                        other, name
                    ),
                });
            }
        };
        return Ok(full.iter().map(|value| [value[idx], 0.0, 0.0]).collect());
    }

    copy_native_fem_base_field_values(backend, node_count, name)
}

#[cfg(feature = "fem-gpu")]
fn copy_native_fem_base_field_values(
    backend: &NativeFemBackend,
    node_count: usize,
    name: &str,
) -> Result<Vec<[f64; 3]>, RunError> {
    match name {
        "m" => backend.copy_m(node_count),
        "H_ex" => backend.copy_h_ex(node_count),
        "H_demag" => backend.copy_h_demag(node_count),
        "H_ext" => backend.copy_h_ext(node_count),
        "H_eff" => backend.copy_h_eff(node_count),
        "torque" => backend.copy_torque(node_count),
        other => Err(RunError {
            message: format!(
                "unsupported interactive FEM output field snapshot '{}'",
                other
            ),
        }),
    }
}

#[cfg(feature = "cuda")]
fn capture_initial_cuda_runtime_fields(
    backend: &NativeFdmBackend,
    cell_count: usize,
    field_schedules: &mut [OutputSchedule],
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let due_field_names = field_schedules
        .iter()
        .filter(|schedule| is_due(0.0, schedule.next_time))
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();

    for name in due_field_names {
        artifacts.record_field_snapshot(FieldSnapshot {
            name: name.clone(),
            step: 0,
            time: 0.0,
            solver_dt: 0.0,
            component_count: 3,
            component_order: "xyz".into(),
            location: "sample".into(),
            scope: "full".into(),
            revision: (0 as u64).saturating_add(1),
            values: FieldSnapshot::flatten_vec3(copy_cuda_field_values(
                backend, cell_count, &name,
            )?),
        })?;
    }
    advance_due_schedules(field_schedules, 0.0);
    Ok(())
}

#[cfg(feature = "cuda")]
fn record_due_cuda_runtime_outputs(
    backend: &NativeFdmBackend,
    cell_count: usize,
    stats: &StepStats,
    scalar_schedules: &mut [OutputSchedule],
    field_schedules: &mut [OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let scalar_due = scalar_schedules
        .iter()
        .any(|schedule| is_due(stats.time, schedule.next_time));
    if scalar_due {
        let mut sampled_stats = stats.clone();
        backend.apply_average_m_to_step_stats(&mut sampled_stats)?;
        artifacts.record_scalar(&sampled_stats)?;
        steps.push(sampled_stats);
        advance_due_schedules(scalar_schedules, stats.time);
    }

    let due_field_names = field_schedules
        .iter()
        .filter(|schedule| is_due(stats.time, schedule.next_time))
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();
    for name in due_field_names {
        artifacts.record_field_snapshot(FieldSnapshot {
            name: name.clone(),
            step: stats.step,
            time: stats.time,
            solver_dt: stats.dt,
            component_count: 3,
            component_order: "xyz".into(),
            location: "sample".into(),
            scope: "full".into(),
            revision: (stats.step as u64).saturating_add(1),
            values: FieldSnapshot::flatten_vec3(copy_cuda_field_values(
                backend, cell_count, &name,
            )?),
        })?;
    }
    advance_due_schedules(field_schedules, stats.time);
    Ok(())
}

#[cfg(feature = "cuda")]
fn record_final_cuda_runtime_outputs(
    backend: &NativeFdmBackend,
    cell_count: usize,
    latest_stats: Option<StepStats>,
    default_scalar_trace: bool,
    scalar_schedules: &[OutputSchedule],
    field_schedules: &[OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let Some(latest_stats) = latest_stats else {
        return Ok(());
    };

    let need_scalar = default_scalar_trace
        || steps
            .last()
            .map(|stats| !same_time(stats.time, latest_stats.time))
            .unwrap_or(true);
    if need_scalar {
        let mut final_stats = latest_stats.clone();
        backend.apply_average_m_to_step_stats(&mut final_stats)?;
        artifacts.record_scalar(&final_stats)?;
        steps.push(final_stats);
    }

    let missing_field_names = field_schedules
        .iter()
        .filter(|schedule| {
            schedule
                .last_sampled_time
                .map(|sampled| !same_time(sampled, latest_stats.time))
                .unwrap_or(true)
        })
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();

    for name in &missing_field_names {
        artifacts.record_field_snapshot(FieldSnapshot {
            name: name.clone(),
            step: latest_stats.step,
            time: latest_stats.time,
            solver_dt: latest_stats.dt,
            component_count: 3,
            component_order: "xyz".into(),
            location: "sample".into(),
            scope: "full".into(),
            revision: (latest_stats.step as u64).saturating_add(1),
            values: FieldSnapshot::flatten_vec3(copy_cuda_field_values(backend, cell_count, name)?),
        })?;
    }
    let _ = scalar_schedules;
    Ok(())
}

#[cfg(feature = "cuda")]
fn copy_cuda_field_values(
    backend: &NativeFdmBackend,
    cell_count: usize,
    name: &str,
) -> Result<Vec<[f64; 3]>, RunError> {
    if let Some(dot_pos) = name.find('.') {
        let base = &name[..dot_pos];
        let component = &name[dot_pos + 1..];
        let full = copy_cuda_base_field_values(backend, cell_count, base)?;
        let idx = match component {
            "x" => 0,
            "y" => 1,
            "z" => 2,
            other => {
                return Err(RunError {
                    message: format!(
                        "unsupported interactive CUDA snapshot component '{}' in '{}'",
                        other, name
                    ),
                });
            }
        };
        return Ok(full.iter().map(|value| [value[idx], 0.0, 0.0]).collect());
    }

    copy_cuda_base_field_values(backend, cell_count, name)
}

#[cfg(feature = "cuda")]
fn copy_cuda_base_field_values(
    backend: &NativeFdmBackend,
    cell_count: usize,
    name: &str,
) -> Result<Vec<[f64; 3]>, RunError> {
    match name {
        "m" => backend.copy_m(cell_count),
        "H_ex" => backend.copy_h_ex(cell_count),
        "H_demag" => backend.copy_h_demag(cell_count),
        "H_ext" => backend.copy_h_ext(cell_count),
        "H_eff" => backend.copy_h_eff(cell_count),
        "torque" => backend.copy_torque(cell_count),
        other => Err(RunError {
            message: format!(
                "unsupported interactive CUDA output field snapshot '{}'",
                other
            ),
        }),
    }
}

fn cpu_execution_provenance(plan: &FdmPlanIR) -> Result<ExecutionProvenance, RunError> {
    let fft_backend = cpu_reference::resolve_cpu_fft_backend_name_for_demag(plan.enable_demag)?;
    let timestep_policy =
        if crate::relaxation::direct_minimizer::direct_minimizer_control(plan.relaxation.as_ref())
            .is_some()
        {
            None
        } else {
            Some(crate::resolve_timestep_policy(
                plan.integrator,
                plan.fixed_timestep,
                plan.adaptive_timestep.as_ref(),
                crate::types::TimestepExecutionLane::fdm_cpu(),
            )?)
        };

    Ok(ExecutionProvenance {
        charge_transport: None,
        transport_modules: Vec::new(),
        executed_physics_kinds: if timestep_policy.is_some()
            && (plan.zhang_li_formula_version.is_some()
                || plan.slonczewski_formula_version.is_some()
                || plan.sot_formula_version.is_some())
        {
            vec!["spin_torque".to_string()]
        } else {
            Vec::new()
        },
        executed_physics_module_ids: Vec::new(),
        execution_engine: "cpu_reference".to_string(),
        precision: "double".to_string(),
        demag_operator_kind: if plan.enable_demag {
            Some("tensor_fft_newell".to_string())
        } else {
            None
        },
        fft_backend,
        device_name: None,
        compute_capability: None,
        cuda_driver_version: None,
        cuda_runtime_version: None,
        lossy_fallback_used: false,
        resolved_fallback: None,
        fem_crossover_decision: None,
        ignored_terms: Vec::new(),
        random_seed: None,
        requested_integrator: None,
        resolved_integrator: plan
            .integrator
            .map(crate::integrator_choice_name)
            .map(str::to_string),
        requested_energy_minimizer: None,
        resolved_energy_minimizer: None,
        energy_minimizer_realization: None,
        requested_demag_realization: None,
        resolved_demag_realization: None,
        timestep_policy,
        fdm_multilayer_transfer_telemetry: None,
        fdm_multilayer_stage_telemetry: None,
        dt_policy: None,
        llg_mode: None,
        mfem_device: None,
        mfem_version: None,
        hypre_version: None,
        demag_refresh_interval_s: None,
        fem_assembly_mode: None,
        fem_execution_mode: None,
        fem_gpu_qualification_status: None,
        fem_exchange_operator_mode: None,
        fem_data_residency: None,
        uses_cuda_kernels: None,
        uses_gpu_poisson: None,
        fem_demag_operator_mode: None,
        hypre_execution_policy: None,
        demag_residency: None,
        hot_loop_host_sync_count: None,
        hot_loop_exchange_h2d_bytes: None,
        hot_loop_exchange_d2h_bytes: None,
        hot_loop_exchange_host_sync_count: None,
        hot_loop_compute_h2d_bytes: None,
        hot_loop_compute_d2h_bytes: None,
        hot_loop_compute_host_sync_count: None,
        hot_loop_control_scalar_d2h_bytes: None,
        hot_loop_control_scalar_host_sync_count: None,
        fem_gpu_state_allocated: None,
        fem_gpu_state_node_count: None,
        fem_gpu_state_dof_len: None,
        fem_gpu_state_stage_count: None,
        fem_gpu_state_device_bytes: None,
        fem_gpu_state_reduction_workspace_bytes: None,
        fem_gpu_rk_exchange_only_enabled: None,
        fem_gpu_rk_stage_count: None,
        fem_gpu_rk_uses_cuda_kernels: None,
        fem_gpu_rk_allows_exchange_host_sync: None,
        fem_gpu_rk_stage_exchange_device_resident: None,
        fem_gpu_rk_block_reason: None,
        requested_cpu_threads: None,
        resolved_cpu_threads: None,
        requested_fem_omp_threads: None,
        effective_fem_omp_threads: None,
        fem_poisson_demag: None,
    })
}

#[cfg(feature = "cuda")]
fn cuda_execution_provenance(
    plan: &FdmPlanIR,
    device_info: &crate::fdm::gpu::cuda::native::DeviceInfo,
) -> Result<ExecutionProvenance, RunError> {
    let timestep_policy =
        if crate::fem::relax::algorithm::native_step_control(plan.relaxation.as_ref()).is_some() {
            None
        } else {
            Some(crate::resolve_timestep_policy(
                plan.integrator,
                plan.fixed_timestep,
                plan.adaptive_timestep.as_ref(),
                crate::types::TimestepExecutionLane::fdm_cuda(plan.precision),
            )?)
        };
    Ok(ExecutionProvenance {
        charge_transport: None,
        transport_modules: Vec::new(),
        executed_physics_kinds: if timestep_policy.is_some()
            && (plan.zhang_li_formula_version.is_some()
                || plan.slonczewski_formula_version.is_some()
                || plan.sot_formula_version.is_some())
        {
            vec!["spin_torque".to_string()]
        } else {
            Vec::new()
        },
        executed_physics_module_ids: Vec::new(),
        execution_engine: "cuda_fdm".to_string(),
        precision: match plan.precision {
            fullmag_ir::ExecutionPrecision::Single => "single".to_string(),
            fullmag_ir::ExecutionPrecision::Double => "double".to_string(),
        },
        demag_operator_kind: if plan.enable_demag {
            Some("tensor_fft_newell".to_string())
        } else {
            None
        },
        fft_backend: if plan.enable_demag {
            Some("cuFFT".to_string())
        } else {
            None
        },
        device_name: Some(device_info.name.clone()),
        compute_capability: Some(device_info.compute_capability.clone()),
        cuda_driver_version: Some(device_info.driver_version),
        cuda_runtime_version: Some(device_info.runtime_version),
        lossy_fallback_used: false,
        resolved_fallback: None,
        fem_crossover_decision: None,
        ignored_terms: Vec::new(),
        random_seed: None,
        requested_integrator: None,
        resolved_integrator: plan
            .integrator
            .map(crate::integrator_choice_name)
            .map(str::to_string),
        requested_energy_minimizer: None,
        resolved_energy_minimizer: None,
        energy_minimizer_realization: None,
        requested_demag_realization: None,
        resolved_demag_realization: None,
        timestep_policy,
        fdm_multilayer_transfer_telemetry: None,
        fdm_multilayer_stage_telemetry: None,
        dt_policy: None,
        llg_mode: Some(
            if llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()) {
                "pure_damping"
            } else {
                "precessional"
            }
            .to_string(),
        ),
        mfem_device: None,
        mfem_version: None,
        hypre_version: None,
        demag_refresh_interval_s: None,
        fem_assembly_mode: None,
        fem_execution_mode: None,
        fem_gpu_qualification_status: None,
        fem_exchange_operator_mode: None,
        fem_data_residency: None,
        uses_cuda_kernels: None,
        uses_gpu_poisson: None,
        fem_demag_operator_mode: None,
        hypre_execution_policy: None,
        demag_residency: None,
        hot_loop_host_sync_count: None,
        hot_loop_exchange_h2d_bytes: None,
        hot_loop_exchange_d2h_bytes: None,
        hot_loop_exchange_host_sync_count: None,
        hot_loop_compute_h2d_bytes: None,
        hot_loop_compute_d2h_bytes: None,
        hot_loop_compute_host_sync_count: None,
        hot_loop_control_scalar_d2h_bytes: None,
        hot_loop_control_scalar_host_sync_count: None,
        fem_gpu_state_allocated: None,
        fem_gpu_state_node_count: None,
        fem_gpu_state_dof_len: None,
        fem_gpu_state_stage_count: None,
        fem_gpu_state_device_bytes: None,
        fem_gpu_state_reduction_workspace_bytes: None,
        fem_gpu_rk_exchange_only_enabled: None,
        fem_gpu_rk_stage_count: None,
        fem_gpu_rk_uses_cuda_kernels: None,
        fem_gpu_rk_allows_exchange_host_sync: None,
        fem_gpu_rk_stage_exchange_device_resident: None,
        fem_gpu_rk_block_reason: None,
        requested_cpu_threads: None,
        resolved_cpu_threads: None,
        requested_fem_omp_threads: None,
        effective_fem_omp_threads: None,
        fem_poisson_demag: None,
    })
}

#[cfg(feature = "fem-gpu")]
fn fem_gpu_execution_provenance(
    plan: &FemPlanIR,
    device_info: &FemDeviceInfo,
) -> Result<ExecutionProvenance, RunError> {
    let timestep_policy =
        if crate::fem::relax::algorithm::native_step_control(plan.relaxation.as_ref()).is_some() {
            None
        } else {
            Some(crate::resolve_timestep_policy(
                plan.integrator,
                plan.fixed_timestep,
                plan.adaptive_timestep.as_ref(),
                if plan.mfem_device_string.as_deref() == Some("cpu") {
                    crate::types::TimestepExecutionLane::fem_cpu(plan.precision)
                } else {
                    crate::types::TimestepExecutionLane::fem_gpu(plan.precision)
                },
            )?)
        };
    let execution_engine = native_fem_backend_id(plan).provenance_name();
    let resolved_demag_realization = resolved_native_fem_demag(plan);
    let mut provenance = ExecutionProvenance {
        transport_modules: Vec::new(),
        executed_physics_kinds: if timestep_policy.is_some() && plan.spin_torque_contract.is_some()
        {
            vec!["spin_torque".to_string()]
        } else {
            Vec::new()
        },
        executed_physics_module_ids: Vec::new(),
        execution_engine: execution_engine.to_string(),
        precision: match plan.precision {
            fullmag_ir::ExecutionPrecision::Single => "single".to_string(),
            fullmag_ir::ExecutionPrecision::Double => "double".to_string(),
        },
        demag_operator_kind: resolved_demag_realization
            .map(|realization| realization.provenance_name().to_string()),
        fft_backend: None,
        device_name: Some(device_info.name.clone()),
        compute_capability: Some(device_info.compute_capability.clone()),
        cuda_driver_version: Some(device_info.driver_version),
        cuda_runtime_version: Some(device_info.runtime_version),
        lossy_fallback_used: false,
        resolved_fallback: None,
        fem_crossover_decision: None,
        ignored_terms: Vec::new(),
        random_seed: None,
        requested_integrator: plan.integrator.map(|integrator| format!("{integrator:?}")),
        resolved_integrator: plan.integrator.map(|integrator| format!("{integrator:?}")),
        requested_energy_minimizer: None,
        resolved_energy_minimizer: None,
        energy_minimizer_realization: None,
        requested_demag_realization: plan
            .demag_realization
            .map(|r| r.provenance_name().to_string()),
        resolved_demag_realization: resolved_demag_realization
            .map(|realization| realization.provenance_name().to_string()),
        timestep_policy,
        fdm_multilayer_transfer_telemetry: None,
        fdm_multilayer_stage_telemetry: None,
        dt_policy: None,
        llg_mode: Some(
            if llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()) {
                "pure_damping"
            } else {
                "precessional"
            }
            .to_string(),
        ),
        mfem_device: plan.mfem_device_string.clone(),
        mfem_version: None,
        hypre_version: None,
        demag_refresh_interval_s: plan
            .field_refresh
            .as_ref()
            .and_then(|policy| policy.demag_interval_s),
        fem_assembly_mode: Some("legacy_sparse".to_string()),
        fem_execution_mode: Some(
            if plan.mfem_device_string.as_deref() == Some("cpu") {
                "cpu_native"
            } else {
                "all_in_gpu_legacy_sparse"
            }
            .to_string(),
        ),
        fem_gpu_qualification_status: Some(
            if plan.mfem_device_string.as_deref() == Some("cpu") {
                "unsupported"
            } else {
                "source_visible"
            }
            .to_string(),
        ),
        fem_exchange_operator_mode: Some("unsupported".to_string()),
        fem_demag_operator_mode: Some(
            if plan.mfem_device_string.as_deref() == Some("cpu") {
                "none"
            } else {
                "device_hypre_poisson"
            }
            .to_string(),
        ),
        hypre_execution_policy: Some(
            if plan.mfem_device_string.as_deref() == Some("cpu") {
                "host"
            } else {
                "device"
            }
            .to_string(),
        ),
        demag_residency: Some(
            if plan.mfem_device_string.as_deref() == Some("cpu") {
                "host"
            } else {
                "device"
            }
            .to_string(),
        ),
        fem_data_residency: Some(
            if plan.mfem_device_string.as_deref() == Some("cpu") {
                "host_source_of_truth"
            } else {
                "device_source_of_truth"
            }
            .to_string(),
        ),
        uses_cuda_kernels: Some(plan.mfem_device_string.as_deref() != Some("cpu")),
        uses_gpu_poisson: Some(
            plan.mfem_device_string.as_deref() != Some("cpu") && plan.enable_demag,
        ),
        hot_loop_host_sync_count: None,
        hot_loop_exchange_h2d_bytes: None,
        hot_loop_exchange_d2h_bytes: None,
        hot_loop_exchange_host_sync_count: None,
        hot_loop_compute_h2d_bytes: None,
        hot_loop_compute_d2h_bytes: None,
        hot_loop_compute_host_sync_count: None,
        hot_loop_control_scalar_d2h_bytes: None,
        hot_loop_control_scalar_host_sync_count: None,
        fem_gpu_state_allocated: None,
        fem_gpu_state_node_count: None,
        fem_gpu_state_dof_len: None,
        fem_gpu_state_stage_count: None,
        fem_gpu_state_device_bytes: None,
        fem_gpu_state_reduction_workspace_bytes: None,
        fem_gpu_rk_exchange_only_enabled: None,
        fem_gpu_rk_stage_count: None,
        fem_gpu_rk_uses_cuda_kernels: None,
        fem_gpu_rk_allows_exchange_host_sync: None,
        fem_gpu_rk_stage_exchange_device_resident: None,
        fem_gpu_rk_block_reason: None,
        requested_cpu_threads: None,
        resolved_cpu_threads: None,
        requested_fem_omp_threads: None,
        effective_fem_omp_threads: None,
        fem_poisson_demag: None,
    };
    crate::relaxation::apply_energy_minimizer_provenance(&mut provenance, plan.relaxation.as_ref());
    Ok(provenance)
}

#[cfg(feature = "fem-gpu")]
fn native_fem_backend_id(plan: &FemPlanIR) -> FemBackendId {
    if plan.mfem_device_string.as_deref() == Some("cpu") {
        FemBackendId::CpuNative
    } else {
        FemBackendId::GpuNative
    }
}

#[cfg(feature = "fem-gpu")]
fn resolved_native_fem_demag(plan: &FemPlanIR) -> Option<fullmag_ir::ResolvedFemDemagIR> {
    if plan.enable_demag {
        Some(
            plan.demag_realization
                .unwrap_or(fullmag_ir::ResolvedFemDemagIR::PoissonRobin),
        )
    } else {
        None
    }
}

fn make_step_stats(
    step: u64,
    time: f64,
    solver_dt: f64,
    wall_time_ns: u64,
    observables: &crate::types::StateObservables,
) -> StepStats {
    let mut stats = StepStats {
        step,
        time,
        dt: solver_dt,
        e_ex: observables.exchange_energy,
        e_demag: observables.demag_energy,
        e_ext: observables.external_energy,
        e_ani: observables.anisotropy_energy,
        e_dmi: observables.dmi_energy,
        e_total: observables.total_energy,
        max_dm_dt: observables.max_dm_dt,
        max_rhs_norm_per_s: observables.max_dm_dt,
        max_h_eff: observables.max_h_eff,
        max_h_demag: observables.max_h_demag,
        max_torque_Apm: observables.max_torque_Apm,
        max_torque_T: observables.max_torque_Apm * crate::MU0,
        wall_time_ns,
        ..StepStats::default()
    };
    crate::scalar_metrics::apply_average_m_to_step_stats(&mut stats, &observables.magnetization);
    stats.per_object_scalars = observables.per_object_scalars.clone();
    stats
}

/// Lightweight version of `make_step_stats` that uses only the `StepReport`
/// scalars and the current magnetization vector, avoiding a full
/// `observe_state` (which recomputes all fields including demag).
fn make_step_stats_from_report(
    step: u64,
    time: f64,
    report: &fullmag_engine::StepReport,
    wall_time_ns: u64,
    magnetization: &[[f64; 3]],
) -> StepStats {
    let mut stats = StepStats {
        step,
        time,
        dt: report.dt_used,
        e_ex: report.exchange_energy_joules,
        e_demag: report.demag_energy_joules,
        e_ext: report.external_energy_joules,
        e_ani: report.anisotropy_energy_joules,
        e_dmi: report.dmi_energy_joules,
        e_total: report.total_energy_joules,
        max_dm_dt: report.max_rhs_amplitude,
        max_rhs_norm_per_s: report.max_rhs_amplitude,
        max_h_eff: report.max_effective_field_amplitude,
        max_h_demag: report.max_demag_field_amplitude,
        max_torque_Apm: report.max_torque_Apm,
        max_torque_T: report.max_torque_Apm * crate::MU0,
        wall_time_ns,
        ..StepStats::default()
    };
    crate::scalar_metrics::apply_average_m_to_step_stats(&mut stats, magnetization);
    stats
}

// ---------------------------------------------------------------------------
// InteractiveBackend trait implementations
// ---------------------------------------------------------------------------

use crate::interactive::backend::{BackendGeometry, InteractiveBackend};

impl InteractiveBackend for InteractiveFdmPreviewRuntime {
    fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        self.upload_magnetization(magnetization)
    }

    fn snapshot_preview(
        &mut self,
        request: &LivePreviewRequest,
    ) -> Result<LivePreviewField, RunError> {
        self.snapshot_preview(request)
    }

    fn snapshot_vector_fields(
        &mut self,
        quantities: &[&str],
        request: &LivePreviewRequest,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        self.snapshot_vector_fields(quantities, request)
    }

    fn snapshot_step_stats(&mut self) -> Result<StepStats, RunError> {
        self.snapshot_step_stats()
    }

    fn execution_provenance(&self) -> ExecutionProvenance {
        self.execution_provenance()
    }

    fn matches_problem(&self, problem: &ProblemIR) -> Result<bool, RunError> {
        let plan = fullmag_plan::plan(problem)?;
        let BackendPlanIR::Fdm(fdm) = &plan.backend_plan else {
            return Ok(false);
        };
        Ok(self.matches_plan(fdm))
    }

    fn matches_plan(&self, plan: &fullmag_ir::ExecutionPlanIR) -> Result<bool, RunError> {
        let BackendPlanIR::Fdm(fdm) = &plan.backend_plan else {
            return Ok(false);
        };
        Ok(self.matches_plan(fdm))
    }

    fn can_continue_with_plan(&self, plan: &fullmag_ir::ExecutionPlanIR) -> Result<bool, RunError> {
        let BackendPlanIR::Fdm(fdm) = &plan.backend_plan else {
            return Ok(false);
        };
        Ok(self.can_continue_with_plan(fdm))
    }

    fn geometry(&self) -> BackendGeometry {
        let grid = match &self.inner {
            InteractiveFdmPreviewRuntimeInner::Cpu(r) => r.original_grid,
            #[cfg(feature = "cuda")]
            InteractiveFdmPreviewRuntimeInner::Cuda(r) => r.original_grid,
        };
        BackendGeometry::Fdm { grid }
    }

    fn execute_streaming(
        &mut self,
        _problem: &ProblemIR,
        plan: &fullmag_ir::ExecutionPlanIR,
        until_seconds: f64,
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
        artifact_writer: Option<ArtifactPipelineSender>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<ExecutedRun, RunError> {
        let BackendPlanIR::Fdm(fdm) = &plan.backend_plan else {
            return Err(RunError {
                message: "InteractiveBackend(FDM)::execute_streaming requires FDM plan".into(),
            });
        };
        self.execute_with_live_preview_streaming(
            fdm,
            until_seconds,
            &plan.output_plan.outputs,
            fdm.grid.cells,
            field_every_n,
            display_selection,
            interrupt_requested,
            artifact_writer,
            on_step,
        )
    }
}

impl InteractiveBackend for InteractiveFemPreviewRuntime {
    fn set_solver_profile_config(
        &mut self,
        config: &crate::SolverProfileConfig,
    ) -> Result<(), RunError> {
        self.set_solver_profile_config(config)
    }

    fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        self.upload_magnetization(magnetization)
    }

    fn snapshot_preview(
        &mut self,
        request: &LivePreviewRequest,
    ) -> Result<LivePreviewField, RunError> {
        self.snapshot_preview(request)
    }

    fn snapshot_vector_fields(
        &mut self,
        quantities: &[&str],
        request: &LivePreviewRequest,
    ) -> Result<Vec<LivePreviewField>, RunError> {
        self.snapshot_vector_fields(quantities, request)
    }

    fn snapshot_step_stats(&mut self) -> Result<StepStats, RunError> {
        self.snapshot_step_stats()
    }

    fn execution_provenance(&self) -> ExecutionProvenance {
        self.execution_provenance()
    }

    fn matches_problem(&self, problem: &ProblemIR) -> Result<bool, RunError> {
        let plan = fullmag_plan::plan(problem)?;
        let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
            return Ok(false);
        };
        Ok(self.matches_plan(fem))
    }

    fn matches_plan(&self, plan: &fullmag_ir::ExecutionPlanIR) -> Result<bool, RunError> {
        let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
            return Ok(false);
        };
        Ok(self.matches_plan(fem))
    }

    fn can_continue_with_plan(&self, plan: &fullmag_ir::ExecutionPlanIR) -> Result<bool, RunError> {
        let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
            return Ok(false);
        };
        Ok(self.can_continue_with_plan(fem))
    }

    fn geometry(&self) -> BackendGeometry {
        let mesh = match &self.inner {
            InteractiveFemPreviewRuntimeInner::Cpu(r) => r.mesh.clone(),
            #[cfg(feature = "fem-gpu")]
            InteractiveFemPreviewRuntimeInner::Gpu(r) => r.mesh.clone(),
        };
        BackendGeometry::Fem { mesh }
    }

    fn execute_streaming(
        &mut self,
        _problem: &ProblemIR,
        plan: &fullmag_ir::ExecutionPlanIR,
        until_seconds: f64,
        field_every_n: u64,
        display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
        interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
        artifact_writer: Option<ArtifactPipelineSender>,
        on_step: &mut dyn FnMut(StepUpdate) -> StepAction,
    ) -> Result<ExecutedRun, RunError> {
        let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
            return Err(RunError {
                message: "InteractiveBackend(FEM)::execute_streaming requires FEM plan".into(),
            });
        };
        self.execute_with_live_preview_streaming(
            fem,
            until_seconds,
            &plan.output_plan.outputs,
            field_every_n,
            artifact_writer,
            display_selection,
            interrupt_requested,
            on_step,
        )
    }
}
