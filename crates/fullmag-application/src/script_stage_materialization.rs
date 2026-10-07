//! Canonical script-stage data materialization shared by CLI and preview.
//! Profile binding belongs to the caller/application resolver. The injected
//! output policy configures writers only; it must not perform I/O or spawn work.
//! This producer preserves legacy stage semantics and does not create a typed
//! StudyPlan, state dependencies, host allocation, or execution readiness.

use crate::script_stage_contract::{
    ResolvedScriptStage, ResolvedScriptStageAction, ScriptExecutionConfig,
    ScriptExecutionStageAction, StageTransitionKind, StageTransitionMetadata,
    StageTransitionReason, StateTransferOperatorKind, StudyPipelineDocument, StudyPipelineNode,
};
use anyhow::{bail, Context, Result};
use fullmag_ir::{
    OutputDataFormatIR, OutputIR, OutputStorageIR, ProblemIR, RegionalFieldDriveIR, TableAutosaveIR,
};
use serde_json::Value;
use std::collections::BTreeMap;

pub fn resolve_script_until_seconds(
    ir: &ProblemIR,
    default_until_seconds: Option<f64>,
) -> Result<f64> {
    if let Some(until_seconds) = default_until_seconds {
        return Ok(until_seconds);
    }

    match &ir.study {
        fullmag_ir::StudyIR::Relaxation { dynamics, stop, .. } => {
            Ok(resolve_relaxation_until_seconds(dynamics, stop))
        }
        fullmag_ir::StudyIR::TimeEvolution { .. } => bail!(
            "no stop time provided. Define DEFAULT_UNTIL in the script for time-evolution runs"
        ),
        fullmag_ir::StudyIR::Eigenmodes { .. } => Ok(0.0),
        fullmag_ir::StudyIR::FrequencyResponse { .. } => Ok(0.0),
        fullmag_ir::StudyIR::Hysteresis { .. } => Ok(0.0),
    }
}

#[doc(hidden)]
pub fn resolve_relaxation_until_seconds(
    dynamics: &Option<fullmag_ir::DynamicsIR>,
    stop: &fullmag_ir::RelaxStopIR,
) -> f64 {
    if let Some(until_seconds) = stop.max_relaxation_time_s {
        return until_seconds;
    }
    let _ = dynamics;
    f64::INFINITY
}

#[cfg(test)]
mod canonical_relaxation_time_tests {
    use super::*;

    #[test]
    fn max_steps_does_not_synthesize_a_time_budget() {
        let dynamics = Some(fullmag_ir::DynamicsIR::Llg {
            gyromagnetic_ratio: 2.211e5,
            integrator: "heun".to_string(),
            fixed_timestep: Some(1.0e-13),
            adaptive_timestep: None,
            field_refresh: None,
            mechanics: None,
        });
        let stop = fullmag_ir::RelaxStopIR {
            torque_tolerance_apm: Some(1.0e-4),
            energy_tolerance_j: None,
            max_steps: Some(10),
            max_relaxation_time_s: None,
        };

        assert_eq!(
            resolve_relaxation_until_seconds(&dynamics, &stop),
            f64::INFINITY
        );
    }

    #[test]
    fn preview_stage_budget_accumulates_and_preflights_sweeps() {
        let mut budget = Some(StageExpansionBudget::new(256));
        record_stage_count(&mut budget, 255).unwrap();

        let error = preflight_sweep_expansion(budget.as_ref(), 2, 1).unwrap_err();
        assert!(error.to_string().contains("preview limit of 256 stages"));
        assert_eq!(budget.unwrap().materialized_stages, 255);
    }

    #[test]
    fn preview_sweep_count_checks_multiplication_overflow() {
        let budget = StageExpansionBudget::new(usize::MAX);

        let error = preflight_sweep_expansion_for_len(Some(&budget), usize::MAX, 2).unwrap_err();
        assert!(error.to_string().contains("stage count overflowed"));
    }

    fn pipeline_config(nodes: Vec<StudyPipelineNode>) -> ScriptExecutionConfig {
        ScriptExecutionConfig {
            ir: ProblemIR::bootstrap_example(),
            shared_geometry_assets: None,
            default_until_seconds: None,
            study_pipeline: Some(StudyPipelineDocument {
                version: "study_pipeline.v1".to_string(),
                nodes,
            }),
            stages: Vec::new(),
        }
    }

    fn relax_primitive(id: &str) -> StudyPipelineNode {
        StudyPipelineNode::Primitive {
            id: id.to_string(),
            label: id.to_string(),
            enabled: true,
            notes: None,
            source: None,
            stage_kind: "relax".to_string(),
            payload: BTreeMap::new(),
        }
    }

    #[test]
    fn preview_budget_counts_stages_across_nested_enabled_groups() {
        let nodes = vec![StudyPipelineNode::Group {
            id: "outer".to_string(),
            label: "outer".to_string(),
            enabled: true,
            notes: None,
            source: None,
            collapsed: false,
            children: vec![
                relax_primitive("first"),
                StudyPipelineNode::Group {
                    id: "inner".to_string(),
                    label: "inner".to_string(),
                    enabled: true,
                    notes: None,
                    source: None,
                    collapsed: false,
                    children: vec![relax_primitive("second")],
                },
            ],
        }];
        let stages = materialize_script_stages_with_output_policy_bounded(
            pipeline_config(nodes.clone()),
            fullmag_ir::configure_project_autosave_policy,
            2,
        )
        .unwrap();
        assert_eq!(stages.len(), 2);

        let error = materialize_script_stages_with_output_policy_bounded(
            pipeline_config(nodes),
            fullmag_ir::configure_project_autosave_policy,
            1,
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("preview limit of 1 stages"));
    }

    #[test]
    fn disabled_group_does_not_consume_preview_stage_budget() {
        let nodes = vec![
            StudyPipelineNode::Group {
                id: "disabled".to_string(),
                label: "disabled".to_string(),
                enabled: false,
                notes: None,
                source: None,
                collapsed: false,
                children: vec![StudyPipelineNode::Macro {
                    id: "unsupported".to_string(),
                    label: "unsupported".to_string(),
                    enabled: true,
                    notes: None,
                    source: None,
                    macro_kind: "unsupported".to_string(),
                    config: BTreeMap::new(),
                }],
            },
            relax_primitive("enabled"),
        ];
        let stages = materialize_script_stages_with_output_policy_bounded(
            pipeline_config(nodes),
            fullmag_ir::configure_project_autosave_policy,
            1,
        )
        .unwrap();
        assert_eq!(stages.len(), 1);
    }
}

pub type StageOutputPolicy =
    fn(&mut ProblemIR, OutputDataFormatIR, f64) -> std::result::Result<(), String>;

pub fn materialize_script_stages_with_output_policy(
    config: ScriptExecutionConfig,
    output_policy: StageOutputPolicy,
) -> Result<Vec<ResolvedScriptStage>> {
    materialize_script_stages_with_stage_limit(config, output_policy, None)
}

pub fn materialize_script_stages_with_output_policy_bounded(
    config: ScriptExecutionConfig,
    output_policy: StageOutputPolicy,
    max_stages: usize,
) -> Result<Vec<ResolvedScriptStage>> {
    materialize_script_stages_with_stage_limit(config, output_policy, Some(max_stages))
}

#[derive(Debug, Clone, Copy)]
struct StageExpansionBudget {
    max_stages: usize,
    materialized_stages: usize,
}

impl StageExpansionBudget {
    fn new(max_stages: usize) -> Self {
        Self {
            max_stages,
            materialized_stages: 0,
        }
    }

    fn ensure_capacity(&self, additional: usize) -> Result<()> {
        let required = self
            .materialized_stages
            .checked_add(additional)
            .context("script stage expansion count overflowed")?;
        if required > self.max_stages {
            bail!(
                "script stage materialization exceeds the preview limit of {} stages",
                self.max_stages
            );
        }
        Ok(())
    }

    fn record(&mut self, count: usize) -> Result<()> {
        self.ensure_capacity(count)?;
        self.materialized_stages += count;
        Ok(())
    }
}

fn preflight_sweep_expansion(
    budget: Option<&StageExpansionBudget>,
    point_count: u64,
    stages_per_point: usize,
) -> Result<Option<usize>> {
    let Some(budget) = budget else {
        return Ok(None);
    };
    let point_count = usize::try_from(point_count)
        .context("script sweep point count does not fit in memory address space")?;
    preflight_sweep_expansion_for_len(Some(budget), point_count, stages_per_point)
}

fn preflight_sweep_expansion_for_len(
    budget: Option<&StageExpansionBudget>,
    point_count: usize,
    stages_per_point: usize,
) -> Result<Option<usize>> {
    let Some(budget) = budget else {
        return Ok(None);
    };
    let required = point_count
        .checked_mul(stages_per_point)
        .context("script sweep stage count overflowed")?;
    budget.ensure_capacity(required)?;
    Ok(Some(required))
}

fn ensure_stage_capacity(budget: Option<&StageExpansionBudget>, additional: usize) -> Result<()> {
    if let Some(budget) = budget {
        budget.ensure_capacity(additional)?;
    }
    Ok(())
}

fn record_stage_count(budget: &mut Option<StageExpansionBudget>, count: usize) -> Result<()> {
    if let Some(budget) = budget {
        budget.record(count)?;
    }
    Ok(())
}

fn materialize_script_stages_with_stage_limit(
    config: ScriptExecutionConfig,
    output_policy: StageOutputPolicy,
    max_stages: Option<usize>,
) -> Result<Vec<ResolvedScriptStage>> {
    let mut expansion_budget = max_stages.map(StageExpansionBudget::new);
    let ScriptExecutionConfig {
        mut ir,
        shared_geometry_assets,
        default_until_seconds,
        study_pipeline,
        stages,
    } = config;

    ensure_stage_capacity(expansion_budget.as_ref(), stages.len())?;
    if stages.is_empty() {
        ensure_stage_capacity(expansion_budget.as_ref(), 1)?;
    }

    if ir.geometry_assets.is_none() {
        ir.geometry_assets = shared_geometry_assets.clone();
    }

    let output_storage = ir
        .problem_meta
        .runtime_metadata
        .get("output_storage")
        .cloned()
        .map(|value| {
            serde_json::from_value::<OutputStorageIR>(value)
                .context("invalid output_storage metadata")
        })
        .transpose()?;
    if stages.is_empty() {
        if let Some(document) = study_pipeline {
            let mut materialized = materialize_study_pipeline(
                &document,
                &ir,
                default_until_seconds,
                &mut expansion_budget,
            )?;
            for stage in &mut materialized {
                configure_stage_output_storage(stage, output_storage.as_ref(), output_policy)?;
            }
            // An authored empty/all-disabled pipeline must not start a legacy solver.
            return Ok(annotate_stage_transitions(materialized));
        }
        ensure_stage_capacity(expansion_budget.as_ref(), 1)?;
        let entrypoint_kind = ir.problem_meta.entrypoint_kind.clone();
        let entrypoint_kind = if entrypoint_kind.is_empty() {
            "direct_script".to_string()
        } else {
            entrypoint_kind
        };
        let until_seconds = if entrypoint_kind == "flat_workspace" {
            0.0
        } else {
            resolve_script_until_seconds(&ir, default_until_seconds)?
        };
        let mut stage = ResolvedScriptStage::solver(ir, until_seconds, entrypoint_kind);
        configure_stage_output_storage(&mut stage, output_storage.as_ref(), output_policy)?;
        resolve_stage_auto_sampling(&mut stage)?;
        return Ok(vec![stage]);
    }

    let mut materialized = Vec::with_capacity(stages.len());
    let mut device_override: Option<String> = None;
    for mut stage in stages {
        if stage.ir.geometry_assets.is_none() {
            stage.ir.geometry_assets = shared_geometry_assets.clone();
        }
        if let Some(device) = device_override.as_deref() {
            set_runtime_selection_device(&mut stage.ir, device);
        }
        normalize_stage_sampling(&mut stage.ir);
        if let Some(action) = stage.action {
            if let ScriptExecutionStageAction::ChangeDevice { device } = &action {
                set_runtime_selection_device(&mut stage.ir, device);
                device_override = Some(device.clone());
            }
            materialized.push(resolve_explicit_stage_action(
                stage.ir,
                stage.entrypoint_kind,
                action,
            )?);
        } else {
            let until_seconds =
                resolve_script_until_seconds(&stage.ir, stage.default_until_seconds)?;
            let mut resolved =
                ResolvedScriptStage::solver(stage.ir, until_seconds, stage.entrypoint_kind);
            configure_stage_output_storage(&mut resolved, output_storage.as_ref(), output_policy)?;
            resolve_stage_auto_sampling(&mut resolved)?;
            materialized.push(resolved);
        }
    }
    Ok(annotate_stage_transitions(materialized))
}

fn configure_stage_output_storage(
    stage: &mut ResolvedScriptStage,
    storage: Option<&OutputStorageIR>,
    output_policy: StageOutputPolicy,
) -> Result<()> {
    let Some(storage) = storage else {
        return Ok(());
    };
    if stage.action.is_some() || stage.entrypoint_kind == "flat_workspace" {
        return Ok(());
    }
    output_policy(&mut stage.ir, storage.data_format, stage.until_seconds)
        .map_err(|message| anyhow::anyhow!(message))
}

fn resolve_stage_auto_sampling(stage: &mut ResolvedScriptStage) -> Result<()> {
    if stage.action.is_none() && matches!(stage.ir.study, fullmag_ir::StudyIR::TimeEvolution { .. })
    {
        fullmag_plan::resolve_auto_sampling_for_stage(&mut stage.ir)
            .map_err(|error| anyhow::anyhow!(error.to_string().trim().to_owned()))?;
    }
    Ok(())
}

fn annotate_stage_transitions(mut stages: Vec<ResolvedScriptStage>) -> Vec<ResolvedScriptStage> {
    let transitions = (0..stages.len())
        .map(|index| {
            if index == 0 {
                None
            } else {
                Some(classify_stage_transition(
                    &stages[index - 1],
                    &stages[index],
                ))
            }
        })
        .collect::<Vec<_>>();
    for (stage, transition) in stages.iter_mut().zip(transitions.into_iter()) {
        stage.incoming_transition = transition;
    }
    stages
}

fn classify_stage_transition(
    previous: &ResolvedScriptStage,
    current: &ResolvedScriptStage,
) -> StageTransitionMetadata {
    if let Some(action) = current.action.as_ref() {
        return classify_action_stage_transition(action);
    }
    if requested_device(&previous.ir) != requested_device(&current.ir) {
        return StageTransitionMetadata::boundary(
            StageTransitionKind::BackendTransfer,
            StageTransitionReason::DeviceChange,
            Some(StateTransferOperatorKind::IdentityCopy),
        );
    }
    if previous.ir.backend_policy.requested_backend != current.ir.backend_policy.requested_backend {
        return StageTransitionMetadata::boundary(
            StageTransitionKind::BackendTransfer,
            StageTransitionReason::BackendChange,
            None,
        );
    }
    if same_runtime_state_topology(&previous.ir, &current.ir) {
        return StageTransitionMetadata::continue_in_place();
    }
    StageTransitionMetadata::unsupported(StageTransitionReason::IncompatibleImplicitState)
}

fn classify_action_stage_transition(action: &ResolvedScriptStageAction) -> StageTransitionMetadata {
    match action {
        ResolvedScriptStageAction::AntennaFieldSolve { .. } => StageTransitionMetadata::boundary(
            StageTransitionKind::AntennaFieldSolve,
            StageTransitionReason::AntennaFieldSolve,
            None,
        ),
        ResolvedScriptStageAction::SaveState { .. } => StageTransitionMetadata::boundary(
            StageTransitionKind::SaveCheckpoint,
            StageTransitionReason::UserExport,
            None,
        ),
        ResolvedScriptStageAction::LoadState { .. } => StageTransitionMetadata::boundary(
            StageTransitionKind::LoadState,
            StageTransitionReason::CheckpointLoad,
            Some(StateTransferOperatorKind::CheckpointLoad),
        ),
        ResolvedScriptStageAction::Export { .. } => StageTransitionMetadata::boundary(
            StageTransitionKind::ExportOnly,
            StageTransitionReason::UserExport,
            None,
        ),
        ResolvedScriptStageAction::ChangeDevice { .. } => StageTransitionMetadata::boundary(
            StageTransitionKind::BackendTransfer,
            StageTransitionReason::DeviceChange,
            Some(StateTransferOperatorKind::IdentityCopy),
        ),
        ResolvedScriptStageAction::AddFieldDrive { .. }
        | ResolvedScriptStageAction::RemoveFieldDrive { .. }
        | ResolvedScriptStageAction::TableAutosave { .. }
        | ResolvedScriptStageAction::Autosave { .. }
        | ResolvedScriptStageAction::FftResponse { .. }
        | ResolvedScriptStageAction::SetTransportCurrent { .. }
        | ResolvedScriptStageAction::SetSpinTorqueEnabled { .. } => {
            StageTransitionMetadata::continue_in_place()
        }
    }
}

fn same_runtime_state_topology(previous: &ProblemIR, current: &ProblemIR) -> bool {
    previous.backend_policy.requested_backend == current.backend_policy.requested_backend
        && previous.backend_policy.execution_precision == current.backend_policy.execution_precision
        && previous.backend_policy.discretization_hints
            == current.backend_policy.discretization_hints
        && previous.geometry == current.geometry
        && previous.geometry_assets == current.geometry_assets
        && previous.regions == current.regions
        && same_material_topology(&previous.materials, &current.materials)
        && same_magnet_topology(&previous.magnets, &current.magnets)
        && previous.current_modules == current.current_modules
        && previous.spin_torque_modules == current.spin_torque_modules
        && previous.elastic_materials == current.elastic_materials
        && previous.elastic_bodies == current.elastic_bodies
        && previous.magnetostriction_laws == current.magnetostriction_laws
        && previous.mechanical_bcs == current.mechanical_bcs
        && previous.mechanical_loads == current.mechanical_loads
        && previous.air_box_policy == current.air_box_policy
        && previous.pbc == current.pbc
        && previous.mesh_semantics == current.mesh_semantics
}

#[doc(hidden)]
pub fn requested_device(ir: &ProblemIR) -> String {
    ir.problem_meta
        .runtime_metadata
        .get("runtime_selection")
        .and_then(Value::as_object)
        .and_then(|selection| selection.get("device"))
        .and_then(Value::as_str)
        .unwrap_or("auto")
        .to_string()
}

fn same_material_topology(
    previous: &[fullmag_ir::MaterialIR],
    current: &[fullmag_ir::MaterialIR],
) -> bool {
    previous.len() == current.len()
        && previous
            .iter()
            .zip(current.iter())
            .all(|(p, c)| p.name == c.name)
}

fn same_magnet_topology(
    previous: &[fullmag_ir::MagnetIR],
    current: &[fullmag_ir::MagnetIR],
) -> bool {
    previous.len() == current.len()
        && previous
            .iter()
            .zip(current.iter())
            .all(|(previous, current)| {
                previous.name == current.name
                    && previous.region == current.region
                    && previous.material == current.material
            })
}

fn resolve_explicit_stage_action(
    mut ir: ProblemIR,
    entrypoint_kind: String,
    action: ScriptExecutionStageAction,
) -> Result<ResolvedScriptStage> {
    let (entrypoint_fallback, resolved_action) = match action {
        ScriptExecutionStageAction::AntennaFieldSolve {
            stage_id,
            port_mode_id,
            port_mode_ids,
        } => {
            let selected_port_mode_id = match (port_mode_id, port_mode_ids.as_slice()) {
                (Some(value), []) if !value.trim().is_empty() => value,
                (None, [value]) if !value.trim().is_empty() => value.clone(),
                (Some(_), []) => {
                    bail!("antenna_field_solve action port_mode_id must be a non-empty string")
                }
                (None, []) => {
                    bail!(
                        "antenna_field_solve action requires port_mode_id or exactly one port_mode_ids entry"
                    )
                }
                (_, values) => {
                    bail!(
                        "antenna_field_solve action resolves exactly one port mode; received {} entries",
                        values.len()
                    )
                }
            };
            let plan =
                fullmag_plan::plan_antenna_field_solve(&ir, &stage_id, &selected_port_mode_id)
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            (
                "study_pipeline_antenna_field_solve",
                ResolvedScriptStageAction::AntennaFieldSolve {
                    stage_id,
                    port_mode_id: selected_port_mode_id,
                    plan,
                },
            )
        }
        ScriptExecutionStageAction::SaveState {
            artifact_name,
            format,
            dataset,
        } => (
            "study_pipeline_save_state",
            ResolvedScriptStageAction::SaveState {
                artifact_name,
                format,
                dataset,
            },
        ),
        ScriptExecutionStageAction::LoadState {
            artifact_name,
            state_path,
            format,
            dataset,
            sample_index,
        } => (
            "study_pipeline_load_state",
            ResolvedScriptStageAction::LoadState {
                artifact_name,
                state_path,
                format,
                dataset,
                sample_index,
            },
        ),
        ScriptExecutionStageAction::Export {
            artifact_name,
            quantity,
            format,
            dataset,
        } => (
            "study_pipeline_export",
            ResolvedScriptStageAction::Export {
                artifact_name,
                quantity,
                format,
                dataset,
            },
        ),
        ScriptExecutionStageAction::ChangeDevice { device } => (
            "study_pipeline_change_device",
            ResolvedScriptStageAction::ChangeDevice { device },
        ),
        ScriptExecutionStageAction::AddFieldDrive { drive } => {
            ensure_field_drive_can_be_added(&ir, &drive)?;
            ir.field_drives.push(drive.clone());
            (
                "study_pipeline_add_field_drive",
                ResolvedScriptStageAction::AddFieldDrive { drive },
            )
        }
        ScriptExecutionStageAction::RemoveFieldDrive { drive_id } => {
            remove_field_drive(&mut ir, &drive_id)?;
            (
                "study_pipeline_remove_field_drive",
                ResolvedScriptStageAction::RemoveFieldDrive { drive_id },
            )
        }
        ScriptExecutionStageAction::TableAutosave {
            enabled,
            table_autosave,
        } => {
            if enabled && table_autosave.is_none() {
                bail!("enabled table_autosave action requires table_autosave payload");
            }
            ir.study.sampling_mut().table_autosave = if enabled {
                table_autosave.clone()
            } else {
                None
            };
            (
                "study_pipeline_table_autosave",
                ResolvedScriptStageAction::TableAutosave {
                    enabled,
                    table_autosave,
                },
            )
        }
        ScriptExecutionStageAction::Autosave {
            enabled,
            quantity,
            output,
        } => {
            if enabled {
                let configured = output
                    .as_ref()
                    .context("enabled autosave action requires output payload")?;
                let name = time_output_name(configured)
                    .context("autosave action supports field, scalar, or snapshot outputs")?;
                let outputs = &mut ir.study.sampling_mut().outputs;
                outputs.retain(|candidate| time_output_name(candidate) != Some(name));
                outputs.push(configured.clone());
            } else if let Some(quantity) = quantity.as_deref() {
                ir.study
                    .sampling_mut()
                    .outputs
                    .retain(|candidate| time_output_name(candidate) != Some(quantity));
            } else {
                ir.study.sampling_mut().outputs.clear();
            }
            (
                "study_pipeline_autosave",
                ResolvedScriptStageAction::Autosave {
                    enabled,
                    quantity,
                    output,
                },
            )
        }
        ScriptExecutionStageAction::FftResponse { enabled, request } => {
            if enabled {
                let request = request
                    .as_ref()
                    .filter(|value| value.is_object())
                    .context("enabled fft_response action requires object request")?;
                ir.problem_meta
                    .runtime_metadata
                    .insert("spin_wave_response".to_string(), request.clone());
            } else {
                ir.problem_meta
                    .runtime_metadata
                    .remove("spin_wave_response");
            }
            (
                "study_pipeline_fft_response",
                ResolvedScriptStageAction::FftResponse { enabled, request },
            )
        }
        ScriptExecutionStageAction::SetTransportCurrent {
            module_id,
            terminal_outward_current_density_apm2,
        } => {
            let payload = BTreeMap::from([
                ("module_id".to_string(), Value::String(module_id.clone())),
                (
                    "terminal_outward_current_density_Apm2".to_string(),
                    serde_json::to_value(&terminal_outward_current_density_apm2)
                        .context("failed to encode set_transport_current payload")?,
                ),
            ]);
            apply_pipeline_set_transport_current(&mut ir, &payload)?;
            (
                "study_pipeline_set_transport_current",
                ResolvedScriptStageAction::SetTransportCurrent {
                    module_id,
                    terminal_outward_current_density_apm2,
                },
            )
        }
        ScriptExecutionStageAction::SetSpinTorqueEnabled { module_id, enabled } => {
            let payload = BTreeMap::from([
                ("module_id".to_string(), Value::String(module_id.clone())),
                ("enabled".to_string(), Value::Bool(enabled)),
            ]);
            apply_pipeline_set_spin_torque_enabled(&mut ir, &payload)?;
            (
                "study_pipeline_set_spin_torque_enabled",
                ResolvedScriptStageAction::SetSpinTorqueEnabled { module_id, enabled },
            )
        }
    };
    let entrypoint = if entrypoint_kind.trim().is_empty() {
        entrypoint_fallback.to_string()
    } else {
        entrypoint_kind
    };
    Ok(ResolvedScriptStage::synthetic(
        ir,
        entrypoint,
        resolved_action,
    ))
}

fn materialize_study_pipeline(
    document: &StudyPipelineDocument,
    base_ir: &ProblemIR,
    default_until_seconds: Option<f64>,
    expansion_budget: &mut Option<StageExpansionBudget>,
) -> Result<Vec<ResolvedScriptStage>> {
    if document.version != "study_pipeline.v1" {
        bail!(
            "unsupported study pipeline version '{}' while materializing script stages",
            document.version
        );
    }
    let mut stages = Vec::new();
    let mut current_ir = base_ir.clone();
    current_ir.problem_meta.runtime_metadata.insert(
        "study_pipeline".to_string(),
        serde_json::to_value(document).context("failed to preserve study pipeline provenance")?,
    );
    walk_study_pipeline_nodes(
        &document.nodes,
        &mut current_ir,
        default_until_seconds,
        &mut stages,
        expansion_budget,
    )?;
    Ok(stages)
}

fn walk_study_pipeline_nodes(
    nodes: &[StudyPipelineNode],
    current_ir: &mut ProblemIR,
    default_until_seconds: Option<f64>,
    out: &mut Vec<ResolvedScriptStage>,
    expansion_budget: &mut Option<StageExpansionBudget>,
) -> Result<()> {
    for node in nodes {
        match node {
            StudyPipelineNode::Primitive {
                id,
                enabled,
                stage_kind,
                payload,
                label,
                ..
            } => {
                if !enabled {
                    continue;
                }
                if let Some(mut stage) = materialize_pipeline_primitive(
                    current_ir,
                    stage_kind,
                    payload,
                    default_until_seconds,
                )
                .with_context(|| format!("failed to materialize study pipeline node '{label}'"))?
                {
                    stage
                        .ir
                        .problem_meta
                        .runtime_metadata
                        .insert("active_stage_id".to_string(), Value::String(id.clone()));
                    resolve_stage_auto_sampling(&mut stage)?;
                    ensure_stage_capacity(expansion_budget.as_ref(), 1)?;
                    record_stage_count(expansion_budget, 1)?;
                    out.push(stage);
                }
            }
            StudyPipelineNode::Macro {
                id,
                enabled,
                macro_kind,
                label,
                config,
                ..
            } => {
                if !enabled {
                    continue;
                }
                let mut stages = materialize_pipeline_macro(
                    current_ir,
                    macro_kind,
                    config,
                    default_until_seconds,
                    expansion_budget.as_ref(),
                )
                .with_context(|| format!("failed to materialize study pipeline node '{label}'"))?;
                for stage in &mut stages {
                    stage
                        .ir
                        .problem_meta
                        .runtime_metadata
                        .insert("active_stage_id".to_string(), Value::String(id.clone()));
                    resolve_stage_auto_sampling(stage)?;
                }
                record_stage_count(expansion_budget, stages.len())?;
                out.extend(stages);
            }
            StudyPipelineNode::Group {
                enabled, children, ..
            } => {
                if !enabled {
                    continue;
                }
                walk_study_pipeline_nodes(
                    children,
                    current_ir,
                    default_until_seconds,
                    out,
                    expansion_budget,
                )?;
            }
        }
    }
    Ok(())
}

fn materialize_pipeline_primitive(
    current_ir: &mut ProblemIR,
    stage_kind: &str,
    payload: &BTreeMap<String, Value>,
    default_until_seconds: Option<f64>,
) -> Result<Option<ResolvedScriptStage>> {
    let normalized_kind = stage_kind.trim().to_ascii_lowercase();
    match normalized_kind.as_str() {
        "antenna_field_solve" => {
            materialize_pipeline_antenna_field_solve(current_ir, payload).map(Some)
        }
        "run" => {
            validate_pipeline_run_primitive_payload(payload)?;
            materialize_pipeline_run(current_ir, payload, default_until_seconds).map(Some)
        }
        "relax" => materialize_pipeline_relax(current_ir, payload).map(Some),
        "eigenmodes" => materialize_pipeline_eigenmodes(current_ir, payload).map(Some),
        "frequency_response" => {
            materialize_pipeline_frequency_response(current_ir, payload).map(Some)
        }
        "set_field" => {
            apply_pipeline_set_field(current_ir, payload)?;
            Ok(None)
        }
        "set_current" => {
            apply_pipeline_set_current(current_ir, payload)?;
            Ok(None)
        }
        "set_transport_current" => {
            apply_pipeline_set_transport_current(current_ir, payload)?;
            Ok(None)
        }
        "set_spin_torque_enabled" => {
            apply_pipeline_set_spin_torque_enabled(current_ir, payload)?;
            Ok(None)
        }
        "save_state" => materialize_pipeline_save_state(current_ir, payload).map(Some),
        "load_state" => materialize_pipeline_load_state(current_ir, payload).map(Some),
        "export" => materialize_pipeline_export(current_ir, payload).map(Some),
        "change_device" => materialize_pipeline_change_device(current_ir, payload).map(Some),
        "add_field_drive" => materialize_pipeline_add_field_drive(current_ir, payload).map(Some),
        "remove_field_drive" => {
            materialize_pipeline_remove_field_drive(current_ir, payload).map(Some)
        }
        "table_autosave" => materialize_pipeline_table_autosave(current_ir, payload).map(Some),
        "autosave" => materialize_pipeline_autosave(current_ir, payload).map(Some),
        "fft_response" => materialize_pipeline_fft_response(current_ir, payload).map(Some),
        other => bail!(
            "study pipeline primitive stage '{}' is not yet executable by the runtime; materialize it into explicit stages first",
            other
        ),
    }
}

fn materialize_pipeline_antenna_field_solve(
    current_ir: &mut ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<ResolvedScriptStage> {
    let unsupported = payload
        .keys()
        .filter(|key| {
            !matches!(
                key.as_str(),
                "kind" | "stage_id" | "port_mode_id" | "port_mode_ids" | "entrypoint_kind"
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    if !unsupported.is_empty() {
        bail!(
            "antenna_field_solve accepts only stage_id, port_mode_id(s), and entrypoint_kind; unsupported payload keys: {}",
            unsupported.join(", ")
        );
    }
    let stage_id = payload
        .get("stage_id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|value| !value.trim().is_empty())
        .context("antenna_field_solve requires non-empty string payload.stage_id")?;
    let port_mode_id = if let Some(value) = payload.get("port_mode_id") {
        value
            .as_str()
            .map(str::to_owned)
            .filter(|value| !value.trim().is_empty())
            .context("antenna_field_solve payload.port_mode_id must be a non-empty string")?
    } else {
        let values = payload
            .get("port_mode_ids")
            .and_then(Value::as_array)
            .context(
                "antenna_field_solve requires payload.port_mode_id or payload.port_mode_ids",
            )?;
        if values.len() != 1 {
            bail!(
                "antenna_field_solve resolves exactly one port mode per executable stage; payload.port_mode_ids contains {} entries",
                values.len()
            );
        }
        values[0]
            .as_str()
            .map(str::to_owned)
            .filter(|value| !value.trim().is_empty())
            .context("antenna_field_solve payload.port_mode_ids[0] must be a non-empty string")?
    };
    let plan = fullmag_plan::plan_antenna_field_solve(current_ir, &stage_id, &port_mode_id)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let entrypoint_kind = payload_string(payload, "entrypoint_kind")
        .unwrap_or_else(|| "study_pipeline_antenna_field_solve".to_string());
    current_ir.problem_meta.entrypoint_kind = entrypoint_kind.clone();
    Ok(ResolvedScriptStage::synthetic(
        current_ir.clone(),
        entrypoint_kind,
        ResolvedScriptStageAction::AntennaFieldSolve {
            stage_id,
            port_mode_id,
            plan,
        },
    ))
}

fn materialize_pipeline_add_field_drive(
    current_ir: &mut ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<ResolvedScriptStage> {
    let drive_value = payload
        .get("drive")
        .cloned()
        .context("study pipeline add_field_drive requires payload.drive")?;
    let drive: RegionalFieldDriveIR = serde_json::from_value(drive_value)
        .context("study pipeline add_field_drive payload.drive is invalid")?;
    ensure_field_drive_can_be_added(current_ir, &drive)?;
    current_ir.field_drives.push(drive.clone());
    let entrypoint_kind = payload_string(payload, "entrypoint_kind")
        .unwrap_or_else(|| "study_pipeline_add_field_drive".to_string());
    current_ir.problem_meta.entrypoint_kind = entrypoint_kind.clone();
    Ok(ResolvedScriptStage::synthetic(
        current_ir.clone(),
        entrypoint_kind,
        ResolvedScriptStageAction::AddFieldDrive { drive },
    ))
}

fn materialize_pipeline_remove_field_drive(
    current_ir: &mut ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<ResolvedScriptStage> {
    let drive_id = payload
        .get("drive_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .context("study pipeline remove_field_drive requires string payload.drive_id")?;
    remove_field_drive(current_ir, &drive_id)?;
    let entrypoint_kind = payload_string(payload, "entrypoint_kind")
        .unwrap_or_else(|| "study_pipeline_remove_field_drive".to_string());
    current_ir.problem_meta.entrypoint_kind = entrypoint_kind.clone();
    Ok(ResolvedScriptStage::synthetic(
        current_ir.clone(),
        entrypoint_kind,
        ResolvedScriptStageAction::RemoveFieldDrive { drive_id },
    ))
}

fn materialize_pipeline_table_autosave(
    current_ir: &mut ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<ResolvedScriptStage> {
    let enabled = payload
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let table_autosave = if enabled {
        let value = payload
            .get("table_autosave")
            .cloned()
            .context("enabled table_autosave stage requires payload.table_autosave")?;
        let table: TableAutosaveIR = serde_json::from_value(value)
            .context("table_autosave stage payload.table_autosave is invalid")?;
        let explicit_is_valid = table
            .sample_period_s
            .is_some_and(|period| period.is_finite() && period > 0.0);
        if !explicit_is_valid && !table.requests_auto_sinc_cutoff() {
            bail!("table_autosave requires a positive finite sample_period_s or the auto_sinc_cutoff policy");
        }
        if table.quantities.is_empty() {
            bail!("table_autosave quantities must not be empty");
        }
        Some(table)
    } else {
        None
    };
    current_ir.study.sampling_mut().table_autosave = table_autosave.clone();
    let entrypoint_kind = payload_string(payload, "entrypoint_kind")
        .unwrap_or_else(|| "study_pipeline_table_autosave".to_string());
    current_ir.problem_meta.entrypoint_kind = entrypoint_kind.clone();
    Ok(ResolvedScriptStage::synthetic(
        current_ir.clone(),
        entrypoint_kind,
        ResolvedScriptStageAction::TableAutosave {
            enabled,
            table_autosave,
        },
    ))
}

fn materialize_pipeline_autosave(
    current_ir: &mut ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<ResolvedScriptStage> {
    let enabled = payload
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let quantity = payload_string(payload, "quantity");
    let output = if enabled {
        let value = payload
            .get("output")
            .cloned()
            .context("enabled autosave stage requires payload.output")?;
        let output: OutputIR =
            serde_json::from_value(value).context("autosave stage payload.output is invalid")?;
        let name = time_output_name(&output)
            .context("autosave stage supports field, scalar, or snapshot outputs")?;
        if quantity.as_deref().is_some_and(|quantity| quantity != name) {
            bail!("autosave quantity must match payload.output name");
        }
        let outputs = &mut current_ir.study.sampling_mut().outputs;
        outputs.retain(|candidate| time_output_name(candidate) != Some(name));
        outputs.push(output.clone());
        Some(output)
    } else {
        let outputs = &mut current_ir.study.sampling_mut().outputs;
        if let Some(quantity) = quantity.as_deref() {
            outputs.retain(|candidate| time_output_name(candidate) != Some(quantity));
        } else {
            outputs.clear();
        }
        None
    };
    let entrypoint_kind = payload_string(payload, "entrypoint_kind")
        .unwrap_or_else(|| "study_pipeline_autosave".to_string());
    current_ir.problem_meta.entrypoint_kind = entrypoint_kind.clone();
    Ok(ResolvedScriptStage::synthetic(
        current_ir.clone(),
        entrypoint_kind,
        ResolvedScriptStageAction::Autosave {
            enabled,
            quantity,
            output,
        },
    ))
}

fn materialize_pipeline_fft_response(
    current_ir: &mut ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<ResolvedScriptStage> {
    let enabled = payload
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let request = if enabled {
        let request = payload
            .get("request")
            .cloned()
            .context("enabled fft_response stage requires payload.request")?;
        if !request.is_object() {
            bail!("fft_response payload.request must be an object");
        }
        current_ir
            .problem_meta
            .runtime_metadata
            .insert("spin_wave_response".to_string(), request.clone());
        Some(request)
    } else {
        current_ir
            .problem_meta
            .runtime_metadata
            .remove("spin_wave_response");
        None
    };
    let entrypoint_kind = payload_string(payload, "entrypoint_kind")
        .unwrap_or_else(|| "study_pipeline_fft_response".to_string());
    current_ir.problem_meta.entrypoint_kind = entrypoint_kind.clone();
    Ok(ResolvedScriptStage::synthetic(
        current_ir.clone(),
        entrypoint_kind,
        ResolvedScriptStageAction::FftResponse { enabled, request },
    ))
}

fn time_output_name(output: &OutputIR) -> Option<&str> {
    match output {
        OutputIR::Field { name, .. }
        | OutputIR::FieldAuto { name, .. }
        | OutputIR::FieldResolvedAuto { name, .. }
        | OutputIR::Scalar { name, .. }
        | OutputIR::ScalarAuto { name, .. }
        | OutputIR::ScalarResolvedAuto { name, .. } => Some(name),
        OutputIR::Snapshot { field, .. } => Some(field),
        _ => None,
    }
}

fn ensure_field_drive_can_be_added(ir: &ProblemIR, drive: &RegionalFieldDriveIR) -> Result<()> {
    if ir
        .field_drives
        .iter()
        .any(|existing| existing.id == drive.id)
    {
        bail!(
            "study pipeline field drive id '{}' already exists",
            drive.id
        );
    }
    if ir
        .field_drives
        .iter()
        .any(|existing| existing.name == drive.name)
    {
        bail!(
            "study pipeline field drive name '{}' already exists",
            drive.name
        );
    }
    Ok(())
}

fn remove_field_drive(ir: &mut ProblemIR, drive_id: &str) -> Result<()> {
    if drive_id.trim().is_empty() {
        bail!("study pipeline remove_field_drive drive_id must be non-empty");
    }
    let Some(index) = ir
        .field_drives
        .iter()
        .position(|drive| drive.id == drive_id)
    else {
        bail!(
            "study pipeline field drive id '{}' does not exist",
            drive_id
        );
    };
    ir.field_drives.remove(index);
    Ok(())
}

fn materialize_pipeline_macro(
    current_ir: &mut ProblemIR,
    macro_kind: &str,
    config: &BTreeMap<String, Value>,
    default_until_seconds: Option<f64>,
    expansion_budget: Option<&StageExpansionBudget>,
) -> Result<Vec<ResolvedScriptStage>> {
    let normalized_kind = macro_kind.trim().to_ascii_lowercase();
    match normalized_kind.as_str() {
        "relax_run" => {
            ensure_stage_capacity(expansion_budget, 2)?;
            let mut stages = Vec::with_capacity(2);
            let mut relax_payload = config.clone();
            relax_payload.insert(
                "entrypoint_kind".to_string(),
                Value::String("study_pipeline_relax_run_relax".to_string()),
            );
            stages.push(materialize_pipeline_relax(current_ir, &relax_payload)?);

            let mut run_payload = config.clone();
            run_payload.insert(
                "entrypoint_kind".to_string(),
                Value::String("study_pipeline_relax_run_run".to_string()),
            );
            if let Some(until_seconds) =
                payload_f64(config, "run_until_seconds")?.or(default_until_seconds)
            {
                run_payload.insert(
                    "until_seconds".to_string(),
                    Value::String(until_seconds.to_string()),
                );
            }
            stages.push(materialize_pipeline_run(
                current_ir,
                &run_payload,
                default_until_seconds,
            )?);
            Ok(stages)
        }
        "relax_eigenmodes" => {
            ensure_stage_capacity(expansion_budget, 2)?;
            let mut stages = Vec::with_capacity(2);
            let mut relax_payload = config.clone();
            relax_payload.insert(
                "entrypoint_kind".to_string(),
                Value::String("study_pipeline_relax_eigenmodes_relax".to_string()),
            );
            stages.push(materialize_pipeline_relax(current_ir, &relax_payload)?);

            let mut eigen_payload = config.clone();
            eigen_payload.insert(
                "entrypoint_kind".to_string(),
                Value::String("study_pipeline_relax_eigenmodes_eigenmodes".to_string()),
            );
            stages.push(materialize_pipeline_eigenmodes(current_ir, &eigen_payload)?);
            Ok(stages)
        }
        "field_sweep_relax" | "field_sweep_relax_snapshot" => materialize_pipeline_field_sweep(
            current_ir,
            config,
            default_until_seconds,
            normalized_kind.as_str(),
            expansion_budget,
        ),
        "hysteresis_loop" => {
            materialize_pipeline_hysteresis_branch(
                current_ir,
                config,
                default_until_seconds,
                expansion_budget,
            )
        }
        "parameter_sweep" => {
            materialize_pipeline_parameter_sweep(
                current_ir,
                config,
                default_until_seconds,
                expansion_budget,
            )
        }
        other => bail!(
            "study pipeline macro '{}' is not yet executable by the runtime fallback; materialize it into explicit stages first",
            other
        ),
    }
}

fn time_domain_sampling_from(base: &fullmag_ir::SamplingIR) -> fullmag_ir::SamplingIR {
    let outputs: Vec<fullmag_ir::OutputIR> = base
        .outputs
        .iter()
        .filter(|output| {
            matches!(
                output,
                fullmag_ir::OutputIR::Field { .. }
                    | fullmag_ir::OutputIR::FieldAuto { .. }
                    | fullmag_ir::OutputIR::FieldResolvedAuto { .. }
                    | fullmag_ir::OutputIR::Scalar { .. }
                    | fullmag_ir::OutputIR::ScalarAuto { .. }
                    | fullmag_ir::OutputIR::ScalarResolvedAuto { .. }
                    | fullmag_ir::OutputIR::Snapshot { .. }
            )
        })
        .cloned()
        .collect();
    fullmag_ir::SamplingIR {
        table_autosave: base.table_autosave.clone(),
        stage_autosave: base.stage_autosave.clone(),
        outputs,
    }
}

fn eigen_sampling_from(base: &fullmag_ir::SamplingIR, mode_count: u32) -> fullmag_ir::SamplingIR {
    let mut outputs: Vec<fullmag_ir::OutputIR> = base
        .outputs
        .iter()
        .filter(|output| {
            matches!(
                output,
                fullmag_ir::OutputIR::EigenSpectrum { .. }
                    | fullmag_ir::OutputIR::EigenMode { .. }
                    | fullmag_ir::OutputIR::DispersionCurve { .. }
            )
        })
        .cloned()
        .collect();
    for output in &mut outputs {
        if let fullmag_ir::OutputIR::EigenMode { indices, .. } = output {
            indices.retain(|index| *index < mode_count);
        }
    }
    outputs.retain(|output| {
        !matches!(
            output,
            fullmag_ir::OutputIR::EigenMode { indices, .. } if indices.is_empty()
        )
    });
    if !outputs.iter().any(|output| {
        matches!(
            output,
            fullmag_ir::OutputIR::EigenSpectrum { .. } | fullmag_ir::OutputIR::EigenMode { .. }
        )
    }) {
        outputs.push(fullmag_ir::OutputIR::EigenSpectrum {
            quantity: "spectrum".to_string(),
        });
    }
    fullmag_ir::SamplingIR {
        table_autosave: base.table_autosave.clone(),
        stage_autosave: None,
        outputs,
    }
}

fn frequency_response_sampling_from(base: &fullmag_ir::SamplingIR) -> fullmag_ir::SamplingIR {
    fullmag_ir::SamplingIR {
        table_autosave: base.table_autosave.clone(),
        stage_autosave: None,
        outputs: base
            .outputs
            .iter()
            .filter(|output| {
                matches!(
                    output,
                    fullmag_ir::OutputIR::FrequencyResponseOutput { .. }
                        | fullmag_ir::OutputIR::EigenSpectrum { .. }
                        | fullmag_ir::OutputIR::EigenMode { .. }
                        | fullmag_ir::OutputIR::DispersionCurve { .. }
                )
            })
            .cloned()
            .collect(),
    }
}

fn normalize_stage_sampling(ir: &mut ProblemIR) {
    match &mut ir.study {
        fullmag_ir::StudyIR::TimeEvolution { sampling, .. }
        | fullmag_ir::StudyIR::Relaxation { sampling, .. }
        | fullmag_ir::StudyIR::Hysteresis { sampling, .. } => {
            *sampling = time_domain_sampling_from(sampling);
        }
        fullmag_ir::StudyIR::Eigenmodes {
            sampling, count, ..
        } => {
            *sampling = eigen_sampling_from(sampling, *count);
        }
        fullmag_ir::StudyIR::FrequencyResponse { sampling, .. } => {
            *sampling = frequency_response_sampling_from(sampling);
        }
    }
}

#[doc(hidden)]
pub fn required_study_dynamics(
    study: &fullmag_ir::StudyIR,
    context: &str,
) -> Result<fullmag_ir::DynamicsIR> {
    study
        .optional_dynamics()
        .cloned()
        .with_context(|| format!("{context} requires explicit LLG dynamics"))
}

fn payload_field_is_set(payload: &BTreeMap<String, Value>, field: &str) -> bool {
    payload.get(field).is_some_and(|value| match value {
        Value::Null => false,
        Value::String(value) => !value.trim().is_empty(),
        _ => true,
    })
}

fn reject_direct_minimizer_llg_payload(
    algorithm: fullmag_ir::RelaxationAlgorithmIR,
    payload: &BTreeMap<String, Value>,
) -> Result<()> {
    if algorithm == fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped {
        return Ok(());
    }
    let rejected = ["integrator", "fixed_timestep", "max_error", "relax_alpha"]
        .into_iter()
        .filter(|field| payload_field_is_set(payload, field))
        .collect::<Vec<_>>();
    if !rejected.is_empty() {
        bail!(
            "relaxation algorithm '{}' is a direct minimizer and rejects LLG-only controls: {}",
            algorithm.as_str(),
            rejected.join(", ")
        );
    }
    Ok(())
}

fn materialize_pipeline_run(
    base_ir: &ProblemIR,
    payload: &BTreeMap<String, Value>,
    default_until_seconds: Option<f64>,
) -> Result<ResolvedScriptStage> {
    let mut ir = base_ir.clone();
    let dynamics = required_study_dynamics(&ir.study, "run pipeline stage")?;
    let sampling = time_domain_sampling_from(ir.study.sampling());
    let entrypoint_kind = payload_string(payload, "entrypoint_kind")
        .unwrap_or_else(|| "study_pipeline_run".to_string());
    ir.problem_meta.entrypoint_kind = entrypoint_kind.clone();
    ir.study = fullmag_ir::StudyIR::TimeEvolution { dynamics, sampling };
    attach_stage_autosave_from_payload(&mut ir, payload, "run")?;
    let until_seconds = resolve_script_until_seconds(
        &ir,
        payload_f64(payload, "until_seconds")?.or(default_until_seconds),
    )?;
    if until_seconds <= 0.0 {
        bail!("run study pipeline stage requires a positive until_seconds value");
    }
    Ok(ResolvedScriptStage::solver(
        ir,
        until_seconds,
        entrypoint_kind,
    ))
}

fn validate_pipeline_run_primitive_payload(payload: &BTreeMap<String, Value>) -> Result<()> {
    let unsupported = payload
        .keys()
        .filter(|key| {
            !matches!(
                key.as_str(),
                "entrypoint_kind"
                    | "kind"
                    | "stage_id"
                    | "until_seconds"
                    | "output_every_seconds"
                    | "autosave"
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    if !unsupported.is_empty() {
        bail!(
            "run pipeline stage accepts only until_seconds; configure solver, table_autosave, autosave, and fft_response independently (unsupported: {})",
            unsupported.join(", ")
        );
    }
    Ok(())
}

#[doc(hidden)]
pub fn materialize_pipeline_relax(
    base_ir: &ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<ResolvedScriptStage> {
    let mut ir = base_ir.clone();
    let mut sampling = time_domain_sampling_from(ir.study.sampling());
    if let Some(value) = payload.get("table_autosave") {
        let table: TableAutosaveIR = serde_json::from_value(value.clone())
            .context("relax stage table_autosave is invalid")?;
        if table.accepted_step_cadence().is_none() {
            bail!("relax stage table_autosave must use a positive every_steps cadence");
        }
        if table.quantities.is_empty() {
            bail!("relax stage table_autosave quantities must not be empty");
        }
        sampling.table_autosave = Some(table);
    }
    let entrypoint_kind = payload_string(payload, "entrypoint_kind")
        .unwrap_or_else(|| "study_pipeline_relax".to_string());
    ir.problem_meta.entrypoint_kind = entrypoint_kind.clone();
    let algorithm = payload_relaxation_algorithm(payload)?
        .unwrap_or(fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped);
    reject_direct_minimizer_llg_payload(algorithm, payload)?;
    let dynamics = if algorithm == fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped {
        let mut dynamics = required_study_dynamics(&ir.study, "LLG relaxation pipeline stage")?;
        apply_dynamics_overrides(&mut dynamics, payload)?;
        Some(dynamics)
    } else {
        None
    };
    ir.study = fullmag_ir::StudyIR::Relaxation {
        algorithm,
        dynamics,
        stop: payload_relax_stop(payload, true)?,
        sampling,
    };
    attach_stage_autosave_from_payload(&mut ir, payload, "relax")?;
    let until_seconds = resolve_script_until_seconds(&ir, None)?;
    Ok(ResolvedScriptStage::solver(
        ir,
        until_seconds,
        entrypoint_kind,
    ))
}

fn attach_stage_autosave_from_payload(
    ir: &mut ProblemIR,
    payload: &BTreeMap<String, Value>,
    stage_kind: &str,
) -> Result<()> {
    let Some(value) = payload.get("autosave") else {
        ir.study.sampling_mut().stage_autosave = None;
        return Ok(());
    };
    let policy: fullmag_ir::StageAutosaveIR = serde_json::from_value(value.clone())
        .with_context(|| format!("{stage_kind} stage autosave payload is invalid"))?;
    policy.validate_for_study(&ir.study).map_err(|errors| {
        anyhow::anyhow!(
            "{stage_kind} stage autosave validation failed: {}",
            errors.join("; ")
        )
    })?;
    ir.study.sampling_mut().stage_autosave = Some(policy);
    Ok(())
}

#[doc(hidden)]
pub fn materialize_pipeline_eigenmodes(
    base_ir: &ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<ResolvedScriptStage> {
    let mut ir = base_ir.clone();
    let mut dynamics = required_study_dynamics(&ir.study, "eigenmodes pipeline stage")?;
    apply_dynamics_overrides(&mut dynamics, payload)?;
    let sampling = ir.study.sampling().clone();
    let entrypoint_kind = payload_string(payload, "entrypoint_kind")
        .unwrap_or_else(|| "study_pipeline_eigenmodes".to_string());
    let current_eigen = match &base_ir.study {
        fullmag_ir::StudyIR::Eigenmodes {
            operator,
            count,
            target,
            equilibrium,
            k_sampling,
            normalization,
            damping_policy,
            spin_wave_bc,
            ..
        } => Some((
            operator.clone(),
            *count,
            target.clone(),
            equilibrium.clone(),
            k_sampling.clone(),
            *normalization,
            *damping_policy,
            spin_wave_bc.clone(),
        )),
        _ => None,
    };
    let default_count = current_eigen
        .as_ref()
        .map(|current| current.1)
        .unwrap_or(10);
    let default_target = current_eigen
        .as_ref()
        .map(|current| current.2.clone())
        .unwrap_or(fullmag_ir::EigenTargetIR::Lowest);
    let default_equilibrium = current_eigen
        .as_ref()
        .map(|current| current.3.clone())
        .unwrap_or(fullmag_ir::EquilibriumSourceIR::RelaxedInitialState);
    let default_normalization = current_eigen
        .as_ref()
        .map(|current| current.5)
        .unwrap_or(fullmag_ir::EigenNormalizationIR::UnitL2);
    let default_damping_policy = current_eigen
        .as_ref()
        .map(|current| current.6)
        .unwrap_or(fullmag_ir::EigenDampingPolicyIR::Ignore);
    let default_spin_wave_bc = current_eigen
        .as_ref()
        .map(|current| current.7.clone())
        .unwrap_or_default();
    let bias_field_sweep = match &base_ir.study {
        fullmag_ir::StudyIR::Eigenmodes {
            bias_field_sweep, ..
        } => bias_field_sweep.clone(),
        _ => None,
    };
    let default_magnetostatic_bc = match &base_ir.study {
        fullmag_ir::StudyIR::Eigenmodes {
            magnetostatic_bc, ..
        } => *magnetostatic_bc,
        _ => fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
    };
    let count = payload_u32(payload, "eigen_count")?.unwrap_or(default_count);
    let include_demag = payload_bool(payload, "eigen_include_demag")?.unwrap_or_else(|| {
        current_eigen
            .as_ref()
            .map(|current| current.0.include_demag)
            .unwrap_or(true)
    });

    ir.problem_meta.entrypoint_kind = entrypoint_kind.clone();
    ir.study = fullmag_ir::StudyIR::Eigenmodes {
        dynamics,
        operator: fullmag_ir::EigenOperatorConfigIR {
            kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
            include_demag,
        },
        count,
        target: payload_eigen_target(payload, default_target)?,
        equilibrium: payload_equilibrium_source(payload, default_equilibrium)?,
        k_sampling: payload_k_sampling(
            payload,
            current_eigen.as_ref().and_then(|current| current.4.clone()),
        )?,
        bias_field_sweep,
        normalization: payload_eigen_normalization(payload)?.unwrap_or(default_normalization),
        damping_policy: payload_eigen_damping_policy(payload)?.unwrap_or(default_damping_policy),
        spin_wave_bc: payload_spin_wave_bc(payload)?.unwrap_or(default_spin_wave_bc),
        magnetostatic_bc: default_magnetostatic_bc,
        sampling: eigen_sampling_from(&sampling, count),
        mode_tracking: None,
    };

    Ok(ResolvedScriptStage::solver(ir, 0.0, entrypoint_kind))
}

fn materialize_pipeline_frequency_response(
    base_ir: &ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<ResolvedScriptStage> {
    let mut ir = base_ir.clone();
    let mut dynamics = required_study_dynamics(&ir.study, "frequency-response pipeline stage")?;
    apply_dynamics_overrides(&mut dynamics, payload)?;
    let sampling = ir.study.sampling().clone();
    let entrypoint_kind = payload_string(payload, "entrypoint_kind")
        .unwrap_or_else(|| "study_pipeline_frequency_response".to_string());
    let current_frequency = match &base_ir.study {
        fullmag_ir::StudyIR::FrequencyResponse {
            operator,
            equilibrium,
            k_sampling,
            normalization,
            damping_policy,
            spin_wave_bc,
            excitation,
            frequencies_hz,
            ..
        } => Some((
            operator.clone(),
            equilibrium.clone(),
            k_sampling.clone(),
            *normalization,
            *damping_policy,
            spin_wave_bc.clone(),
            excitation.clone(),
            frequencies_hz.clone(),
        )),
        _ => None,
    };
    let include_demag = payload_bool(payload, "frequency_include_demag")?.unwrap_or_else(|| {
        current_frequency
            .as_ref()
            .map(|current| current.0.include_demag)
            .unwrap_or(true)
    });
    let default_equilibrium = current_frequency
        .as_ref()
        .map(|current| current.1.clone())
        .unwrap_or(fullmag_ir::EquilibriumSourceIR::Provided);
    let default_k_sampling = current_frequency
        .as_ref()
        .and_then(|current| current.2.clone());
    let default_normalization = current_frequency
        .as_ref()
        .map(|current| current.3)
        .unwrap_or(fullmag_ir::FrequencyResponseNormalizationIR::UnitL2);
    let default_damping_policy = current_frequency
        .as_ref()
        .map(|current| current.4)
        .unwrap_or(fullmag_ir::EigenDampingPolicyIR::Ignore);
    let default_spin_wave_bc = current_frequency
        .as_ref()
        .map(|current| current.5.clone())
        .unwrap_or_default();
    let default_magnetostatic_bc = match &base_ir.study {
        fullmag_ir::StudyIR::FrequencyResponse {
            magnetostatic_bc, ..
        } => *magnetostatic_bc,
        _ => fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
    };
    let default_excitation = current_frequency
        .as_ref()
        .map(|current| current.6.field_au_per_m)
        .unwrap_or([0.0, 0.0, 1.0]);
    let default_excitation_phase_rad = current_frequency
        .as_ref()
        .map(|current| current.6.phase_rad)
        .unwrap_or(0.0);
    let default_frequencies = current_frequency
        .as_ref()
        .map(|current| current.7.values_hz.clone())
        .unwrap_or_else(|| vec![1.0e9]);
    let default_solver_policy = match &base_ir.study {
        fullmag_ir::StudyIR::FrequencyResponse { solver_policy, .. } => solver_policy.clone(),
        _ => None,
    };

    let frequencies_hz =
        payload_f64_array(payload, "frequency_values_hz")?.unwrap_or(default_frequencies);
    if frequencies_hz.is_empty()
        || frequencies_hz
            .iter()
            .any(|value| !value.is_finite() || *value <= 0.0)
    {
        bail!("study pipeline frequency_response stage requires positive frequency_values_hz");
    }
    let excitation_phase_rad = payload_f64(payload, "frequency_excitation_phase_rad")?
        .unwrap_or(default_excitation_phase_rad);
    if !excitation_phase_rad.is_finite() {
        bail!("study pipeline frequency_response stage requires finite frequency_excitation_phase_rad");
    }

    let frequency_payload = frequency_payload_as_eigen_payload(payload);
    ir.problem_meta.entrypoint_kind = entrypoint_kind.clone();
    ir.study = fullmag_ir::StudyIR::FrequencyResponse {
        dynamics,
        operator: fullmag_ir::EigenOperatorConfigIR {
            kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
            include_demag,
        },
        equilibrium: payload_equilibrium_source(&frequency_payload, default_equilibrium)?,
        k_sampling: payload_k_sampling(&frequency_payload, default_k_sampling)?,
        normalization: payload_frequency_normalization(payload)?.unwrap_or(default_normalization),
        damping_policy: payload_eigen_damping_policy(&frequency_payload)?
            .unwrap_or(default_damping_policy),
        spin_wave_bc: payload_spin_wave_bc(&frequency_payload)?.unwrap_or(default_spin_wave_bc),
        magnetostatic_bc: payload_frequency_magnetostatic_bc(payload)?
            .unwrap_or(default_magnetostatic_bc),
        excitation: fullmag_ir::FrequencyExcitationIR {
            field_au_per_m: payload_vec3(
                payload,
                "frequency_excitation_field_au_per_m",
                default_excitation,
            )?,
            phase_rad: excitation_phase_rad,
        },
        frequencies_hz: fullmag_ir::FrequencySweepIR {
            values_hz: frequencies_hz,
        },
        solver_policy: payload_frequency_solver_policy(payload, default_solver_policy)?,
        sampling: fullmag_ir::SamplingIR {
            table_autosave: sampling.table_autosave,
            stage_autosave: None,
            outputs: vec![fullmag_ir::OutputIR::FrequencyResponseOutput {
                observable: payload_frequency_observable(payload)?,
            }],
        },
    };

    Ok(ResolvedScriptStage::solver(ir, 0.0, entrypoint_kind))
}

fn frequency_payload_as_eigen_payload(
    payload: &BTreeMap<String, Value>,
) -> BTreeMap<String, Value> {
    let mut mapped = payload.clone();
    for (frequency_key, eigen_key) in [
        ("frequency_equilibrium_source", "eigen_equilibrium_source"),
        (
            "frequency_equilibrium_artifact",
            "eigen_equilibrium_artifact",
        ),
        ("frequency_damping_policy", "eigen_damping_policy"),
        ("frequency_k_vector", "eigen_k_vector"),
        ("frequency_spin_wave_bc", "eigen_spin_wave_bc"),
        ("frequency_spin_wave_bc_config", "eigen_spin_wave_bc_config"),
    ] {
        if let Some(value) = payload.get(frequency_key) {
            mapped.insert(eigen_key.to_string(), value.clone());
        }
    }
    mapped
}

fn materialize_pipeline_save_state(
    base_ir: &ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<ResolvedScriptStage> {
    let mut ir = base_ir.clone();
    let entrypoint_kind = payload_string(payload, "entrypoint_kind")
        .unwrap_or_else(|| "study_pipeline_save_state".to_string());
    let artifact_name =
        payload_string(payload, "artifact_name").unwrap_or_else(|| "state_snapshot".to_string());
    ir.problem_meta.entrypoint_kind = entrypoint_kind.clone();
    Ok(ResolvedScriptStage::synthetic(
        ir,
        entrypoint_kind,
        ResolvedScriptStageAction::SaveState {
            artifact_name,
            format: payload_string(payload, "format"),
            dataset: payload_string(payload, "dataset"),
        },
    ))
}

fn materialize_pipeline_load_state(
    base_ir: &ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<ResolvedScriptStage> {
    let mut ir = base_ir.clone();
    let entrypoint_kind = payload_string(payload, "entrypoint_kind")
        .unwrap_or_else(|| "study_pipeline_load_state".to_string());
    ir.problem_meta.entrypoint_kind = entrypoint_kind.clone();
    Ok(ResolvedScriptStage::synthetic(
        ir,
        entrypoint_kind,
        ResolvedScriptStageAction::LoadState {
            artifact_name: payload_string(payload, "artifact_name"),
            state_path: payload_string(payload, "state_path"),
            format: payload_string(payload, "format"),
            dataset: payload_string(payload, "dataset"),
            sample_index: payload_i64(payload, "sample_index")?,
        },
    ))
}

fn materialize_pipeline_export(
    base_ir: &ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<ResolvedScriptStage> {
    let mut ir = base_ir.clone();
    let entrypoint_kind = payload_string(payload, "entrypoint_kind")
        .unwrap_or_else(|| "study_pipeline_export".to_string());
    ir.problem_meta.entrypoint_kind = entrypoint_kind.clone();
    Ok(ResolvedScriptStage::synthetic(
        ir,
        entrypoint_kind,
        ResolvedScriptStageAction::Export {
            artifact_name: payload_string(payload, "artifact_name"),
            quantity: payload_string(payload, "quantity")
                .unwrap_or_else(|| "magnetization".to_string()),
            format: payload_string(payload, "format").unwrap_or_else(|| "json".to_string()),
            dataset: payload_string(payload, "dataset"),
        },
    ))
}

fn materialize_pipeline_change_device(
    current_ir: &mut ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<ResolvedScriptStage> {
    let device = normalize_pipeline_device(
        payload_string(payload, "device")
            .unwrap_or_else(|| "auto".to_string())
            .as_str(),
    )?;
    set_runtime_selection_device(current_ir, &device);
    let entrypoint_kind = payload_string(payload, "entrypoint_kind")
        .unwrap_or_else(|| "study_pipeline_change_device".to_string());
    current_ir.problem_meta.entrypoint_kind = entrypoint_kind.clone();
    Ok(ResolvedScriptStage::synthetic(
        current_ir.clone(),
        entrypoint_kind,
        ResolvedScriptStageAction::ChangeDevice { device },
    ))
}

fn materialize_pipeline_field_sweep(
    current_ir: &mut ProblemIR,
    config: &BTreeMap<String, Value>,
    default_until_seconds: Option<f64>,
    macro_kind: &str,
    expansion_budget: Option<&StageExpansionBudget>,
) -> Result<Vec<ResolvedScriptStage>> {
    let start_mt = payload_f64(config, "start_mT")?.unwrap_or(-100.0);
    let stop_mt = payload_f64(config, "stop_mT")?.unwrap_or(100.0);
    let steps = payload_u64(config, "steps")?.unwrap_or(if macro_kind == "hysteresis_loop" {
        21
    } else {
        11
    });
    let relax_each = payload_bool(config, "relax_each")?.unwrap_or(true);
    let save_point_state = payload_bool(config, "save_point_state")?
        .unwrap_or(macro_kind == "field_sweep_relax_snapshot");
    let save_format = payload_string(config, "save_format");
    let save_dataset = payload_string(config, "save_dataset");
    let axis = payload_axis(config, "axis", [0.0, 0.0, 1.0])?;
    let settle_until_seconds = payload_f64(config, "settle_until_seconds")?
        .or(default_until_seconds)
        .unwrap_or(1e-12);

    if steps == 0 {
        bail!("study pipeline {macro_kind} requires steps >= 1");
    }
    if settle_until_seconds <= 0.0 {
        bail!("study pipeline {macro_kind} requires a positive settle_until_seconds");
    }

    let stage_multiplier = 1usize
        .checked_add(usize::from(relax_each))
        .and_then(|value| value.checked_add(usize::from(save_point_state)))
        .context("script sweep stage multiplier overflowed")?;
    let planned_stage_capacity =
        preflight_sweep_expansion(expansion_budget, steps, stage_multiplier)?;
    let sweep_values_mt = linear_sweep_values(start_mt, stop_mt, steps)?;
    let stage_capacity =
        planned_stage_capacity.unwrap_or_else(|| sweep_values_mt.len() * stage_multiplier);
    let mut stages = Vec::with_capacity(stage_capacity);

    for (point_index, amplitude_mt) in sweep_values_mt.iter().enumerate() {
        let field_t = scaled_axis(axis, *amplitude_mt * 1e-3);
        apply_pipeline_external_field(current_ir, field_t);

        let mut point_ir = current_ir.clone();
        apply_pipeline_external_field(&mut point_ir, field_t);

        let mut run_payload = config.clone();
        run_payload.insert(
            "entrypoint_kind".to_string(),
            Value::String(format!(
                "study_pipeline_{}_point_{:03}_run",
                macro_kind,
                point_index + 1
            )),
        );
        run_payload.insert(
            "until_seconds".to_string(),
            Value::String(settle_until_seconds.to_string()),
        );
        stages.push(materialize_pipeline_run(
            &point_ir,
            &run_payload,
            Some(settle_until_seconds),
        )?);

        if relax_each {
            let mut relax_payload = config.clone();
            relax_payload.insert(
                "entrypoint_kind".to_string(),
                Value::String(format!(
                    "study_pipeline_{}_point_{:03}_relax",
                    macro_kind,
                    point_index + 1
                )),
            );
            stages.push(materialize_pipeline_relax(&point_ir, &relax_payload)?);
        }

        if save_point_state {
            let mut save_payload = BTreeMap::<String, Value>::new();
            save_payload.insert(
                "entrypoint_kind".to_string(),
                Value::String(format!(
                    "study_pipeline_{}_point_{:03}_save_state",
                    macro_kind,
                    point_index + 1
                )),
            );
            save_payload.insert(
                "artifact_name".to_string(),
                Value::String(format!("{}_point_{:03}", macro_kind, point_index + 1)),
            );
            if let Some(format) = save_format.as_ref() {
                save_payload.insert("format".to_string(), Value::String(format.clone()));
            }
            if let Some(dataset) = save_dataset.as_ref() {
                save_payload.insert("dataset".to_string(), Value::String(dataset.clone()));
            }
            stages.push(materialize_pipeline_save_state(&point_ir, &save_payload)?);
        }
    }

    Ok(stages)
}

fn hysteresis_settle_stop(
    config: &BTreeMap<String, Value>,
    default_until_seconds: Option<f64>,
) -> Result<fullmag_ir::RelaxStopIR> {
    let mut settle_payload = match config.get("settle") {
        Some(Value::Object(map)) => map
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<BTreeMap<_, _>>(),
        Some(Value::Null) | None => BTreeMap::new(),
        Some(_) => {
            bail!("study pipeline hysteresis_loop expects config.settle to be an object")
        }
    };

    for key in [
        "torque_tolerance_apm",
        "torque_tolerance",
        "energy_tolerance_j",
        "energy_tolerance",
        "max_steps",
        "max_relaxation_time_s",
        "max_pseudotime_s",
        "max_physical_time_s",
    ] {
        if !settle_payload.contains_key(key) {
            if let Some(value) = config.get(key) {
                settle_payload.insert(key.to_string(), value.clone());
            }
        }
    }
    if !settle_payload.contains_key("max_physical_time_s") {
        if let Some(settle_until_seconds) =
            payload_f64(config, "settle_until_seconds")?.or(default_until_seconds)
        {
            settle_payload.insert(
                "max_physical_time_s".to_string(),
                Value::String(settle_until_seconds.to_string()),
            );
        }
    }

    payload_relax_stop(&settle_payload, true)
}

fn inject_relax_stop_payload(
    payload: &mut BTreeMap<String, Value>,
    stop: &fullmag_ir::RelaxStopIR,
) {
    if let Some(value) = stop.torque_tolerance_apm {
        payload.insert(
            "torque_tolerance_apm".to_string(),
            Value::String(value.to_string()),
        );
    }
    if let Some(value) = stop.energy_tolerance_j {
        payload.insert(
            "energy_tolerance_j".to_string(),
            Value::String(value.to_string()),
        );
    }
    if let Some(value) = stop.max_steps {
        payload.insert("max_steps".to_string(), Value::String(value.to_string()));
    }
    if let Some(value) = stop.max_relaxation_time_s {
        payload.insert(
            "max_relaxation_time_s".to_string(),
            Value::String(value.to_string()),
        );
    }
}

fn materialize_pipeline_hysteresis_branch(
    current_ir: &mut ProblemIR,
    config: &BTreeMap<String, Value>,
    default_until_seconds: Option<f64>,
    expansion_budget: Option<&StageExpansionBudget>,
) -> Result<Vec<ResolvedScriptStage>> {
    let quantity = payload_string(config, "quantity").unwrap_or_else(|| "b_ext".to_string());
    if quantity != "b_ext" && quantity != "external_field" {
        bail!(
            "study pipeline hysteresis_loop currently supports only quantity='b_ext', got '{}'",
            quantity
        );
    }

    let axis = if config.contains_key("direction") {
        payload_axis(config, "direction", [0.0, 0.0, 1.0])?
    } else {
        payload_axis(config, "axis", [0.0, 0.0, 1.0])?
    };
    let save_point_state = payload_bool(config, "save_state")?
        .or(payload_bool(config, "save_point_state")?)
        .unwrap_or(false);
    let save_format = payload_string(config, "save_format");
    let save_dataset = payload_string(config, "save_dataset");
    let settle_stop = hysteresis_settle_stop(config, default_until_seconds)?;

    let stage_multiplier = 1usize
        .checked_add(usize::from(save_point_state))
        .context("script sweep stage multiplier overflowed")?;
    let explicit_values_t = if expansion_budget.is_none() {
        payload_f64_array(config, "field_values_t")?
    } else {
        None
    };
    let explicit_values_count = if let Some(values) = explicit_values_t.as_ref() {
        Some(values.len())
    } else if expansion_budget.is_some() {
        payload_f64_array_point_count(config, "field_values_t")?
    } else {
        None
    };
    let (sweep_values_t, planned_stage_capacity) = if let Some(explicit_values_t) =
        explicit_values_t
    {
        if explicit_values_t.is_empty() {
            bail!("study pipeline hysteresis_loop requires field_values_t to be non-empty");
        }
        let planned_capacity = preflight_sweep_expansion_for_len(
            expansion_budget,
            explicit_values_t.len(),
            stage_multiplier,
        )?;
        (explicit_values_t, planned_capacity)
    } else if let Some(point_count) = explicit_values_count {
        let planned_capacity =
            preflight_sweep_expansion_for_len(expansion_budget, point_count, stage_multiplier)?;
        let explicit_values_t = payload_f64_array(config, "field_values_t")?.ok_or_else(|| {
            anyhow::anyhow!("study pipeline hysteresis_loop requires field_values_t values")
        })?;
        if explicit_values_t.is_empty() {
            bail!("study pipeline hysteresis_loop requires field_values_t to be non-empty");
        }
        (explicit_values_t, planned_capacity)
    } else {
        let start_mt = payload_f64(config, "start_mT")?.unwrap_or(-100.0);
        let stop_mt = payload_f64(config, "stop_mT")?.unwrap_or(100.0);
        let steps = payload_u64(config, "steps")?.unwrap_or(21);
        if steps == 0 {
            bail!("study pipeline hysteresis_loop requires steps >= 1");
        }
        let planned_capacity =
            preflight_sweep_expansion(expansion_budget, steps, stage_multiplier)?;
        let values = linear_sweep_values(start_mt, stop_mt, steps)?
            .into_iter()
            .map(|value_mt| value_mt * 1e-3)
            .collect::<Vec<_>>();
        (values, planned_capacity)
    };

    let stage_capacity =
        planned_stage_capacity.unwrap_or_else(|| sweep_values_t.len() * stage_multiplier);
    let mut stages = Vec::with_capacity(stage_capacity);
    for (point_index, amplitude_t) in sweep_values_t.iter().enumerate() {
        let field_t = scaled_axis(axis, *amplitude_t);
        apply_pipeline_external_field(current_ir, field_t);

        let mut point_ir = current_ir.clone();
        apply_pipeline_external_field(&mut point_ir, field_t);

        let mut relax_payload = config.clone();
        relax_payload.insert(
            "entrypoint_kind".to_string(),
            Value::String(format!(
                "study_pipeline_hysteresis_branch_point_{:03}_relax",
                point_index + 1
            )),
        );
        inject_relax_stop_payload(&mut relax_payload, &settle_stop);
        stages.push(materialize_pipeline_relax(&point_ir, &relax_payload)?);

        if save_point_state {
            let mut save_payload = BTreeMap::<String, Value>::new();
            save_payload.insert(
                "entrypoint_kind".to_string(),
                Value::String(format!(
                    "study_pipeline_hysteresis_branch_point_{:03}_save_state",
                    point_index + 1
                )),
            );
            save_payload.insert(
                "artifact_name".to_string(),
                Value::String(format!("hysteresis_branch_point_{:03}", point_index + 1)),
            );
            if let Some(format) = save_format.as_ref() {
                save_payload.insert("format".to_string(), Value::String(format.clone()));
            }
            if let Some(dataset) = save_dataset.as_ref() {
                save_payload.insert("dataset".to_string(), Value::String(dataset.clone()));
            }
            stages.push(materialize_pipeline_save_state(&point_ir, &save_payload)?);
        }
    }

    Ok(stages)
}

#[derive(Debug, Clone, Copy)]
struct ParameterSweepSolvePattern {
    run_each: bool,
    relax_each: bool,
}

fn parameter_sweep_solve_pattern(
    config: &BTreeMap<String, Value>,
) -> Result<ParameterSweepSolvePattern> {
    let solve_kind = payload_string(config, "solve_kind")
        .unwrap_or_else(|| "run_relax".to_string())
        .trim()
        .to_ascii_lowercase();
    let pattern = match solve_kind.as_str() {
        "run" => ParameterSweepSolvePattern {
            run_each: true,
            relax_each: false,
        },
        "relax" => ParameterSweepSolvePattern {
            run_each: false,
            relax_each: true,
        },
        "run_relax" | "relax_run" => ParameterSweepSolvePattern {
            run_each: true,
            relax_each: true,
        },
        other => {
            bail!(
                "parameter_sweep solve_kind '{}' is not supported; use run, relax, or run_relax",
                other
            )
        }
    };
    Ok(pattern)
}

fn materialize_pipeline_parameter_sweep(
    current_ir: &mut ProblemIR,
    config: &BTreeMap<String, Value>,
    default_until_seconds: Option<f64>,
    expansion_budget: Option<&StageExpansionBudget>,
) -> Result<Vec<ResolvedScriptStage>> {
    let parameter = payload_string(config, "parameter")
        .or_else(|| payload_string(config, "quantity"))
        .unwrap_or_else(|| "b_ext".to_string())
        .trim()
        .to_ascii_lowercase();
    let axis = payload_axis(config, "axis", [0.0, 0.0, 1.0])?;
    let steps = payload_u64(config, "steps")?.unwrap_or(11);
    if steps == 0 {
        bail!("parameter_sweep requires steps >= 1");
    }

    let is_field_parameter = matches!(
        parameter.as_str(),
        "b_ext" | "external_field" | "zeeman_b" | "field" | "field_mt"
    );
    let is_current_parameter = matches!(
        parameter.as_str(),
        "current_density" | "j" | "j_ext" | "current"
    );
    if !is_field_parameter && !is_current_parameter {
        bail!(
            "parameter_sweep parameter '{}' is not supported yet; supported parameters: b_ext, current_density",
            parameter
        );
    }

    let start_raw = payload_f64(config, "start_value")?
        .or(payload_f64(config, "start")?)
        .or(payload_f64(config, "start_mT")?)
        .unwrap_or(if is_field_parameter { -100.0 } else { 0.0 });
    let stop_raw = payload_f64(config, "stop_value")?
        .or(payload_f64(config, "stop")?)
        .or(payload_f64(config, "stop_mT")?)
        .unwrap_or(if is_field_parameter { 100.0 } else { 1e10 });
    let unbounded_values_raw = if expansion_budget.is_none() {
        Some(linear_sweep_values(start_raw, stop_raw, steps)?)
    } else {
        None
    };
    let solve_pattern = parameter_sweep_solve_pattern(config)?;
    let save_point_state = payload_bool(config, "save_point_state")?.unwrap_or(false);
    let save_format = payload_string(config, "save_format");
    let save_dataset = payload_string(config, "save_dataset");

    let run_until_seconds = payload_f64(config, "run_until_seconds")?
        .or(payload_f64(config, "settle_until_seconds")?)
        .or(default_until_seconds)
        .unwrap_or(1e-12);
    if solve_pattern.run_each && run_until_seconds <= 0.0 {
        bail!("parameter_sweep requires positive run_until_seconds when solve_kind includes run");
    }

    let stage_multiplier = usize::from(solve_pattern.run_each)
        + usize::from(solve_pattern.relax_each)
        + usize::from(save_point_state);
    let stage_multiplier = stage_multiplier.max(1);
    let planned_stage_capacity =
        preflight_sweep_expansion(expansion_budget, steps, stage_multiplier)?;
    let values_raw = match unbounded_values_raw {
        Some(values) => values,
        None => linear_sweep_values(start_raw, stop_raw, steps)?,
    };
    let values_si = if is_field_parameter {
        values_raw
            .iter()
            .map(|value| value * 1e-3)
            .collect::<Vec<_>>()
    } else {
        values_raw
    };
    let stage_capacity =
        planned_stage_capacity.unwrap_or_else(|| values_si.len() * stage_multiplier);
    let mut stages = Vec::with_capacity(stage_capacity);
    for (point_index, value_si) in values_si.iter().enumerate() {
        if is_field_parameter {
            apply_pipeline_external_field(current_ir, scaled_axis(axis, *value_si));
        } else {
            current_ir.current_density = Some(scaled_axis(axis, *value_si));
        }

        let mut point_ir = current_ir.clone();
        if is_field_parameter {
            apply_pipeline_external_field(&mut point_ir, scaled_axis(axis, *value_si));
        } else {
            point_ir.current_density = Some(scaled_axis(axis, *value_si));
        }

        if solve_pattern.run_each {
            let mut run_payload = config.clone();
            run_payload.insert(
                "entrypoint_kind".to_string(),
                Value::String(format!(
                    "study_pipeline_parameter_sweep_point_{:03}_run",
                    point_index + 1
                )),
            );
            run_payload.insert(
                "until_seconds".to_string(),
                Value::String(run_until_seconds.to_string()),
            );
            stages.push(materialize_pipeline_run(
                &point_ir,
                &run_payload,
                Some(run_until_seconds),
            )?);
        }

        if solve_pattern.relax_each {
            let mut relax_payload = config.clone();
            relax_payload.insert(
                "entrypoint_kind".to_string(),
                Value::String(format!(
                    "study_pipeline_parameter_sweep_point_{:03}_relax",
                    point_index + 1
                )),
            );
            stages.push(materialize_pipeline_relax(&point_ir, &relax_payload)?);
        }

        if save_point_state {
            let mut save_payload = BTreeMap::<String, Value>::new();
            save_payload.insert(
                "entrypoint_kind".to_string(),
                Value::String(format!(
                    "study_pipeline_parameter_sweep_point_{:03}_save_state",
                    point_index + 1
                )),
            );
            save_payload.insert(
                "artifact_name".to_string(),
                Value::String(format!("parameter_sweep_point_{:03}", point_index + 1)),
            );
            if let Some(format) = save_format.as_ref() {
                save_payload.insert("format".to_string(), Value::String(format.clone()));
            }
            if let Some(dataset) = save_dataset.as_ref() {
                save_payload.insert("dataset".to_string(), Value::String(dataset.clone()));
            }
            stages.push(materialize_pipeline_save_state(&point_ir, &save_payload)?);
        }
    }
    Ok(stages)
}

fn apply_dynamics_overrides(
    dynamics: &mut fullmag_ir::DynamicsIR,
    payload: &BTreeMap<String, Value>,
) -> Result<()> {
    match dynamics {
        fullmag_ir::DynamicsIR::Llg {
            integrator,
            fixed_timestep,
            ..
        } => {
            let integrator_override = payload_string(payload, "integrator");
            if let Some(value) = integrator_override.as_ref() {
                *integrator = value.clone();
            }
            if payload.contains_key("fixed_timestep") {
                *fixed_timestep = payload_f64(payload, "fixed_timestep")?;
            } else if matches!(integrator_override.as_deref(), Some("rk45" | "rk23")) {
                *fixed_timestep = None;
            }
        }
    }
    Ok(())
}

fn payload_string(payload: &BTreeMap<String, Value>, key: &str) -> Option<String> {
    match payload.get(key) {
        Some(Value::String(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Some(Value::Number(value)) => Some(value.to_string()),
        Some(Value::Bool(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn normalize_pipeline_device(device: &str) -> Result<String> {
    let normalized = device.trim().to_ascii_lowercase();
    if matches!(normalized.as_str(), "auto" | "cpu" | "gpu" | "cuda") {
        return Ok(normalized);
    }
    if let Some(index) = normalized.strip_prefix("cuda:") {
        if !index.is_empty() && index.chars().all(|ch| ch.is_ascii_digit()) {
            return Ok(normalized);
        }
    }
    bail!("change_device requires device 'auto', 'cpu', 'gpu', 'cuda', or 'cuda:<index>'");
}

#[doc(hidden)]
pub fn set_runtime_selection_device(ir: &mut ProblemIR, device: &str) {
    let mut runtime_selection = ir
        .problem_meta
        .runtime_metadata
        .get("runtime_selection")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let (device_label, device_index) = if let Some(index) = device.strip_prefix("cuda:") {
        (
            "cuda".to_string(),
            index.parse::<i64>().ok().map(Value::from),
        )
    } else {
        (device.to_string(), None)
    };

    runtime_selection.insert("device".to_string(), Value::String(device_label.clone()));
    runtime_selection.insert("explicit_selection".to_string(), Value::Bool(true));

    if device_label == "cpu" || device_label == "auto" {
        runtime_selection.insert("gpu_count".to_string(), Value::from(0));
        runtime_selection.remove("device_index");
    } else {
        runtime_selection.insert("gpu_count".to_string(), Value::from(1));
        if let Some(index) = device_index {
            runtime_selection.insert("device_index".to_string(), index);
        } else {
            runtime_selection.remove("device_index");
        }
    }

    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        Value::Object(runtime_selection),
    );
}

fn payload_f64(payload: &BTreeMap<String, Value>, key: &str) -> Result<Option<f64>> {
    let Some(raw_value) = payload.get(key) else {
        return Ok(None);
    };
    match raw_value {
        Value::Null => Ok(None),
        Value::String(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            trimmed
                .parse::<f64>()
                .with_context(|| format!("invalid floating-point value for payload field '{key}'"))
                .map(Some)
        }
        Value::Number(value) => value
            .as_f64()
            .map(Some)
            .ok_or_else(|| anyhow::anyhow!("invalid numeric value for payload field '{key}'")),
        _ => bail!("payload field '{key}' must be a number or numeric string"),
    }
}

fn payload_u64(payload: &BTreeMap<String, Value>, key: &str) -> Result<Option<u64>> {
    let Some(raw_value) = payload.get(key) else {
        return Ok(None);
    };
    match raw_value {
        Value::Null => Ok(None),
        Value::String(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            trimmed
                .parse::<u64>()
                .with_context(|| format!("invalid integer value for payload field '{key}'"))
                .map(Some)
        }
        Value::Number(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| anyhow::anyhow!("invalid integer value for payload field '{key}'")),
        _ => bail!("payload field '{key}' must be an integer or integer string"),
    }
}

fn payload_u32(payload: &BTreeMap<String, Value>, key: &str) -> Result<Option<u32>> {
    payload_u64(payload, key)?.map_or(Ok(None), |value| {
        u32::try_from(value)
            .with_context(|| format!("payload field '{key}' does not fit into u32"))
            .map(Some)
    })
}

fn payload_i64(payload: &BTreeMap<String, Value>, key: &str) -> Result<Option<i64>> {
    let Some(raw_value) = payload.get(key) else {
        return Ok(None);
    };
    match raw_value {
        Value::Null => Ok(None),
        Value::String(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            trimmed
                .parse::<i64>()
                .with_context(|| format!("invalid integer value for payload field '{key}'"))
                .map(Some)
        }
        Value::Number(value) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| anyhow::anyhow!("invalid integer value for payload field '{key}'")),
        _ => bail!("payload field '{key}' must be an integer or integer string"),
    }
}

fn payload_bool(payload: &BTreeMap<String, Value>, key: &str) -> Result<Option<bool>> {
    let Some(raw_value) = payload.get(key) else {
        return Ok(None);
    };
    match raw_value {
        Value::Null => Ok(None),
        Value::Bool(value) => Ok(Some(*value)),
        Value::String(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            match trimmed {
                "true" => Ok(Some(true)),
                "false" => Ok(Some(false)),
                _ => bail!("payload field '{key}' must be a boolean or 'true'/'false' string"),
            }
        }
        _ => bail!("payload field '{key}' must be a boolean"),
    }
}

fn payload_f64_array(payload: &BTreeMap<String, Value>, key: &str) -> Result<Option<Vec<f64>>> {
    let Some(raw_value) = payload.get(key) else {
        return Ok(None);
    };
    match raw_value {
        Value::Null => Ok(None),
        Value::Array(values) => {
            let mut parsed = Vec::with_capacity(values.len());
            for (index, value) in values.iter().enumerate() {
                let component = match value {
                    Value::Number(number) => number.as_f64().ok_or_else(|| {
                        anyhow::anyhow!(
                            "invalid numeric component at payload field '{key}[{index}]'"
                        )
                    })?,
                    Value::String(text) => text.trim().parse::<f64>().with_context(|| {
                        format!(
                            "invalid floating-point component at payload field '{key}[{index}]'"
                        )
                    })?,
                    _ => {
                        bail!(
                            "payload field '{key}' must contain numeric values (array index {index})"
                        )
                    }
                };
                parsed.push(component);
            }
            Ok(Some(parsed))
        }
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            trimmed
                .split(',')
                .map(|component| {
                    component.trim().parse::<f64>().with_context(|| {
                        format!(
                            "invalid floating-point component in comma-separated payload field '{key}'"
                        )
                    })
                })
                .collect::<Result<Vec<_>>>()
                .map(Some)
        }
        _ => bail!("payload field '{key}' must be an array or comma-separated string"),
    }
}

fn payload_f64_array_point_count(
    payload: &BTreeMap<String, Value>,
    key: &str,
) -> Result<Option<usize>> {
    let Some(raw_value) = payload.get(key) else {
        return Ok(None);
    };
    match raw_value {
        Value::Null => Ok(None),
        Value::Array(values) => Ok(Some(values.len())),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed.split(',').count()))
            }
        }
        _ => bail!("payload field '{key}' must be an array or comma-separated string"),
    }
}

fn payload_vec3(
    payload: &BTreeMap<String, Value>,
    key: &str,
    default: [f64; 3],
) -> Result<[f64; 3]> {
    let Some(values) = payload_f64_array(payload, key)? else {
        return Ok(default);
    };
    if values.len() != 3 {
        bail!("payload field '{key}' must contain exactly 3 vector components");
    }
    if values.iter().any(|value| !value.is_finite()) {
        bail!("payload field '{key}' must contain finite vector components");
    }
    Ok([values[0], values[1], values[2]])
}

fn payload_relaxation_algorithm(
    payload: &BTreeMap<String, Value>,
) -> Result<Option<fullmag_ir::RelaxationAlgorithmIR>> {
    match payload_string(payload, "relax_algorithm") {
        Some(value) => serde_json::from_value(Value::String(value))
            .context("invalid relax_algorithm in study pipeline payload")
            .map(Some),
        None => Ok(None),
    }
}

fn payload_relax_stop(
    payload: &BTreeMap<String, Value>,
    apply_legacy_defaults: bool,
) -> Result<fullmag_ir::RelaxStopIR> {
    let torque_tolerance_apm =
        payload_f64(payload, "torque_tolerance_apm")?.or(payload_f64(payload, "torque_tolerance")?);
    let energy_tolerance_j =
        payload_f64(payload, "energy_tolerance_j")?.or(payload_f64(payload, "energy_tolerance")?);
    let max_steps = payload_u64(payload, "max_steps")?;
    let max_relaxation_time_s = payload_f64(payload, "max_relaxation_time_s")?;
    let max_pseudotime_s = payload_f64(payload, "max_pseudotime_s")?;
    let max_physical_time_s = payload_f64(payload, "max_physical_time_s")?;
    if max_relaxation_time_s.is_some()
        && (max_pseudotime_s.is_some() || max_physical_time_s.is_some())
    {
        bail!("max_relaxation_time_s conflicts with legacy max_pseudotime_s/max_physical_time_s");
    }
    if max_pseudotime_s.is_some()
        && max_physical_time_s.is_some()
        && max_pseudotime_s != max_physical_time_s
    {
        bail!("legacy max_pseudotime_s and max_physical_time_s conflict");
    }

    let any_explicit = torque_tolerance_apm.is_some()
        || energy_tolerance_j.is_some()
        || max_steps.is_some()
        || max_relaxation_time_s.is_some()
        || max_pseudotime_s.is_some()
        || max_physical_time_s.is_some();

    Ok(fullmag_ir::RelaxStopIR {
        torque_tolerance_apm: if apply_legacy_defaults && !any_explicit {
            Some(1e-4)
        } else {
            torque_tolerance_apm
        },
        energy_tolerance_j,
        max_steps: if apply_legacy_defaults && !any_explicit {
            Some(50_000)
        } else {
            max_steps
        },
        max_relaxation_time_s: max_relaxation_time_s
            .or(max_physical_time_s)
            .or(max_pseudotime_s),
    })
}

fn payload_eigen_target(
    payload: &BTreeMap<String, Value>,
    default_target: fullmag_ir::EigenTargetIR,
) -> Result<fullmag_ir::EigenTargetIR> {
    let target_kind =
        payload_string(payload, "eigen_target").unwrap_or_else(|| match default_target {
            fullmag_ir::EigenTargetIR::Lowest => "lowest".to_string(),
            fullmag_ir::EigenTargetIR::Nearest { .. } => "nearest".to_string(),
            fullmag_ir::EigenTargetIR::FrequencyWindow { .. } => "frequency_window".to_string(),
        });
    match target_kind.as_str() {
        "lowest" => Ok(fullmag_ir::EigenTargetIR::Lowest),
        "nearest" => {
            let default_frequency = match default_target {
                fullmag_ir::EigenTargetIR::Nearest { frequency_hz } => Some(frequency_hz),
                fullmag_ir::EigenTargetIR::Lowest
                | fullmag_ir::EigenTargetIR::FrequencyWindow { .. } => None,
            };
            let frequency_hz = payload_f64(payload, "eigen_target_frequency")?
                .or(default_frequency)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "study pipeline eigenmodes stage with eigen_target='nearest' requires eigen_target_frequency"
                    )
                })?;
            Ok(fullmag_ir::EigenTargetIR::Nearest { frequency_hz })
        }
        "frequency_window" => {
            let (default_min, default_max) = match default_target {
                fullmag_ir::EigenTargetIR::FrequencyWindow {
                    frequency_min_hz,
                    frequency_max_hz,
                } => (Some(frequency_min_hz), Some(frequency_max_hz)),
                _ => (None, None),
            };
            let frequency_min_hz = payload_f64(payload, "eigen_frequency_min")?
                .or(payload_f64(payload, "frequency_min")?)
                .or(default_min)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "study pipeline eigenmodes stage with eigen_target='frequency_window' requires eigen_frequency_min"
                    )
                })?;
            let frequency_max_hz = payload_f64(payload, "eigen_frequency_max")?
                .or(payload_f64(payload, "frequency_max")?)
                .or(default_max)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "study pipeline eigenmodes stage with eigen_target='frequency_window' requires eigen_frequency_max"
                    )
                })?;
            Ok(fullmag_ir::EigenTargetIR::FrequencyWindow {
                frequency_min_hz,
                frequency_max_hz,
            })
        }
        other => bail!("unsupported eigen_target value '{other}'"),
    }
}

fn payload_equilibrium_source(
    payload: &BTreeMap<String, Value>,
    default_equilibrium: fullmag_ir::EquilibriumSourceIR,
) -> Result<fullmag_ir::EquilibriumSourceIR> {
    let default_label = match &default_equilibrium {
        fullmag_ir::EquilibriumSourceIR::Provided => "provided",
        fullmag_ir::EquilibriumSourceIR::RelaxedInitialState => "relax",
        fullmag_ir::EquilibriumSourceIR::Artifact { .. } => "artifact",
    };
    let source = payload_string(payload, "eigen_equilibrium_source")
        .unwrap_or_else(|| default_label.to_string());
    match source.as_str() {
        "provided" => Ok(fullmag_ir::EquilibriumSourceIR::Provided),
        "relax" => Ok(fullmag_ir::EquilibriumSourceIR::RelaxedInitialState),
        "artifact" => {
            let path = payload_string(payload, "eigen_equilibrium_artifact").or_else(|| {
                match default_equilibrium {
                    fullmag_ir::EquilibriumSourceIR::Artifact { path } => Some(path),
                    _ => None,
                }
            });
            let path = path.ok_or_else(|| {
                anyhow::anyhow!(
                    "study pipeline eigenmodes stage with equilibrium_source='artifact' requires eigen_equilibrium_artifact"
                )
            })?;
            Ok(fullmag_ir::EquilibriumSourceIR::Artifact { path })
        }
        other => bail!("unsupported eigen_equilibrium_source value '{other}'"),
    }
}

fn payload_eigen_normalization(
    payload: &BTreeMap<String, Value>,
) -> Result<Option<fullmag_ir::EigenNormalizationIR>> {
    match payload_string(payload, "eigen_normalization") {
        Some(value) => serde_json::from_value(Value::String(value))
            .context("invalid eigen_normalization in study pipeline payload")
            .map(Some),
        None => Ok(None),
    }
}

fn payload_eigen_damping_policy(
    payload: &BTreeMap<String, Value>,
) -> Result<Option<fullmag_ir::EigenDampingPolicyIR>> {
    match payload_string(payload, "eigen_damping_policy") {
        Some(value) => serde_json::from_value(Value::String(value))
            .context("invalid eigen_damping_policy in study pipeline payload")
            .map(Some),
        None => Ok(None),
    }
}

fn payload_frequency_normalization(
    payload: &BTreeMap<String, Value>,
) -> Result<Option<fullmag_ir::FrequencyResponseNormalizationIR>> {
    match payload_string(payload, "frequency_normalization") {
        Some(value) => serde_json::from_value(Value::String(value))
            .context("invalid frequency_normalization in study pipeline payload")
            .map(Some),
        None => Ok(None),
    }
}

fn payload_frequency_observable(
    payload: &BTreeMap<String, Value>,
) -> Result<fullmag_ir::FrequencyResponseOutputIR> {
    let value = payload_string(payload, "frequency_observable")
        .unwrap_or_else(|| "susceptibility_tensor".to_string());
    serde_json::from_value(Value::String(value))
        .context("invalid frequency_observable in study pipeline payload")
}

fn payload_k_sampling(
    payload: &BTreeMap<String, Value>,
    default_sampling: Option<fullmag_ir::KSamplingIR>,
) -> Result<Option<fullmag_ir::KSamplingIR>> {
    let parsed = match payload.get("eigen_k_vector") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                let values: Vec<f64> = trimmed
                    .split(',')
                    .map(|component| {
                        component.trim().parse::<f64>().with_context(|| {
                            "invalid eigen_k_vector component in study pipeline payload"
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
                if values.len() != 3 {
                    bail!("eigen_k_vector must contain exactly 3 comma-separated values");
                }
                Some([values[0], values[1], values[2]])
            }
        }
        Some(Value::Array(values)) => {
            if values.len() != 3 {
                bail!("eigen_k_vector array must contain exactly 3 entries");
            }
            Some([
                values[0]
                    .as_f64()
                    .ok_or_else(|| anyhow::anyhow!("invalid eigen_k_vector[0] value"))?,
                values[1]
                    .as_f64()
                    .ok_or_else(|| anyhow::anyhow!("invalid eigen_k_vector[1] value"))?,
                values[2]
                    .as_f64()
                    .ok_or_else(|| anyhow::anyhow!("invalid eigen_k_vector[2] value"))?,
            ])
        }
        _ => bail!("eigen_k_vector must be a comma-separated string or 3-element array"),
    };
    Ok(match parsed {
        Some(k_vector) => Some(fullmag_ir::KSamplingIR::Single { k_vector }),
        None => default_sampling,
    })
}

fn payload_spin_wave_bc(
    payload: &BTreeMap<String, Value>,
) -> Result<Option<fullmag_ir::SpinWaveBoundaryConditionIR>> {
    if let Some(config) = payload.get("eigen_spin_wave_bc_config") {
        if matches!(config, Value::Null) {
            return Ok(None);
        }
        return serde_json::from_value(config.clone())
            .context("invalid eigen_spin_wave_bc_config in study pipeline payload")
            .map(Some);
    }
    match payload_string(payload, "eigen_spin_wave_bc") {
        Some(value) => serde_json::from_value(Value::String(value))
            .context("invalid eigen_spin_wave_bc in study pipeline payload")
            .map(Some),
        None => Ok(None),
    }
}

fn payload_frequency_magnetostatic_bc(
    payload: &BTreeMap<String, Value>,
) -> Result<Option<fullmag_ir::MagnetostaticBoundaryConditionIR>> {
    match payload_string(payload, "frequency_magnetostatic_bc") {
        Some(value) => serde_json::from_value(Value::String(value))
            .context("invalid frequency_magnetostatic_bc in study pipeline payload")
            .map(Some),
        None => Ok(None),
    }
}

fn payload_frequency_solver_policy(
    payload: &BTreeMap<String, Value>,
    default: Option<fullmag_ir::FrequencyResponseSolverPolicyIR>,
) -> Result<Option<fullmag_ir::FrequencyResponseSolverPolicyIR>> {
    let method = match payload_string(payload, "frequency_solver_method") {
        Some(value) => Some(
            serde_json::from_value(Value::String(value))
                .context("invalid frequency_solver_method in study pipeline payload")?,
        ),
        None => None,
    };
    let preconditioner = match payload_string(payload, "frequency_solver_preconditioner") {
        Some(value) => Some(
            serde_json::from_value(Value::String(value))
                .context("invalid frequency_solver_preconditioner in study pipeline payload")?,
        ),
        None => None,
    };
    let rtol = payload_f64(payload, "frequency_solver_rtol")?;
    let max_iterations = payload_u64(payload, "frequency_solver_max_iterations")?;
    let restart_iterations = payload_u64(payload, "frequency_solver_restart_iterations")?;
    if method.is_none()
        && preconditioner.is_none()
        && rtol.is_none()
        && max_iterations.is_none()
        && restart_iterations.is_none()
    {
        return Ok(default);
    }
    if let Some(rtol) = rtol {
        if !rtol.is_finite() || rtol <= 0.0 {
            bail!("frequency_solver_rtol must be finite and positive");
        }
    }
    if matches!(max_iterations, Some(0)) {
        bail!("frequency_solver_max_iterations must be positive");
    }
    if matches!(restart_iterations, Some(0)) {
        bail!("frequency_solver_restart_iterations must be positive");
    }
    if let (Some(restart), Some(max)) = (restart_iterations, max_iterations) {
        if restart > max {
            bail!("frequency_solver_restart_iterations must be <= frequency_solver_max_iterations");
        }
    }
    Ok(Some(fullmag_ir::FrequencyResponseSolverPolicyIR {
        method,
        preconditioner,
        rtol,
        max_iterations,
        restart_iterations,
    }))
}

fn apply_pipeline_set_field(
    problem: &mut ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<()> {
    let axis = payload_axis(payload, "axis", [0.0, 0.0, 1.0])?;
    let field_mt = payload_f64(payload, "field_mT")?.unwrap_or(50.0);
    apply_pipeline_external_field(problem, scaled_axis(axis, field_mt * 1e-3));
    Ok(())
}

fn apply_pipeline_set_current(
    problem: &mut ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<()> {
    let axis = payload_axis(payload, "direction", [1.0, 0.0, 0.0])?;
    let current_density = payload_f64(payload, "current_density")?.unwrap_or(1e10);
    problem.current_density = Some(scaled_axis(axis, current_density));
    Ok(())
}

fn apply_pipeline_set_transport_current(
    problem: &mut ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<()> {
    let module_id = payload_string(payload, "module_id")
        .filter(|value| !value.trim().is_empty())
        .context("study pipeline set_transport_current requires payload.module_id")?;
    let raw_values = payload
        .get("terminal_outward_current_density_Apm2")
        .and_then(Value::as_object)
        .context(
            "study pipeline set_transport_current requires payload.terminal_outward_current_density_Apm2 object",
        )?;
    if raw_values.is_empty() {
        bail!("study pipeline set_transport_current terminal map must not be empty");
    }
    let mut values = BTreeMap::new();
    for (boundary_id, raw_value) in raw_values {
        if boundary_id.trim().is_empty() {
            bail!("study pipeline set_transport_current boundary ids must be non-empty");
        }
        let value = match raw_value {
            Value::Number(number) => number.as_f64(),
            Value::String(text) => text.trim().parse::<f64>().ok(),
            _ => None,
        }
        .with_context(|| {
            format!(
                "study pipeline set_transport_current boundary '{}' must carry a finite A/m^2 value",
                boundary_id
            )
        })?;
        if !value.is_finite() {
            bail!(
                "study pipeline set_transport_current boundary '{}' must carry a finite A/m^2 value",
                boundary_id
            );
        }
        values.insert(boundary_id.as_str(), value);
    }

    let matching: Vec<_> = problem
        .current_modules
        .iter()
        .enumerate()
        .filter_map(|(index, module)| match module {
            fullmag_ir::CurrentModuleIR::CurrentTransport { name, .. } if name == &module_id => {
                Some(index)
            }
            _ => None,
        })
        .collect();
    let [module_index] = matching.as_slice() else {
        bail!(
            "study pipeline set_transport_current module_id '{}' must identify exactly one CurrentTransport",
            module_id
        );
    };
    let fullmag_ir::CurrentModuleIR::CurrentTransport { definition, .. } =
        &mut problem.current_modules[*module_index]
    else {
        unreachable!("matching index must identify CurrentTransport");
    };
    let definition = definition
        .as_mut()
        .context("study pipeline set_transport_current requires a complete transport definition")?;
    let electrode_ids: std::collections::BTreeSet<_> = definition
        .boundaries
        .iter()
        .filter_map(|boundary| match boundary {
            fullmag_ir::ChargeBoundaryIR::NormalCurrentElectrode { id, .. } => Some(id.as_str()),
            _ => None,
        })
        .collect();
    let supplied_ids: std::collections::BTreeSet<_> = values.keys().copied().collect();
    if supplied_ids != electrode_ids {
        let missing: Vec<_> = electrode_ids.difference(&supplied_ids).copied().collect();
        let unexpected: Vec<_> = supplied_ids.difference(&electrode_ids).copied().collect();
        bail!(
            "study pipeline set_transport_current must cover exactly the normal-current electrodes; missing={:?}, unexpected={:?}",
            missing,
            unexpected
        );
    }
    for boundary in &mut definition.boundaries {
        if let fullmag_ir::ChargeBoundaryIR::NormalCurrentElectrode {
            id,
            outward_current_density_apm2,
            ..
        } = boundary
        {
            *outward_current_density_apm2 = values[id.as_str()];
        }
    }
    Ok(())
}

fn apply_pipeline_set_spin_torque_enabled(
    problem: &mut ProblemIR,
    payload: &BTreeMap<String, Value>,
) -> Result<()> {
    let module_id = payload_string(payload, "module_id")
        .filter(|value| !value.trim().is_empty())
        .context("study pipeline set_spin_torque_enabled requires payload.module_id")?;
    let enabled = payload
        .get("enabled")
        .and_then(Value::as_bool)
        .context("study pipeline set_spin_torque_enabled requires boolean payload.enabled")?;

    let typed_matches = problem
        .spin_torque_modules
        .iter()
        .filter(|module| match module {
            fullmag_ir::SpinTorqueModuleIR::Slonczewski { id, .. }
            | fullmag_ir::SpinTorqueModuleIR::ZhangLi { id, .. } => {
                id.as_deref() == Some(module_id.as_str())
            }
            fullmag_ir::SpinTorqueModuleIR::DriftDiffusionSpinTorque { id, .. }
            | fullmag_ir::SpinTorqueModuleIR::PrescribedSot { id, .. } => id == &module_id,
            fullmag_ir::SpinTorqueModuleIR::InterfaceCpp { .. }
            | fullmag_ir::SpinTorqueModuleIR::DriftDiffusion { .. }
            | fullmag_ir::SpinTorqueModuleIR::SpinOrbitTorque { .. } => false,
        })
        .count();
    if typed_matches != 1 {
        bail!(
            "study pipeline set_spin_torque_enabled module_id '{}' must identify exactly one typed spin torque module",
            module_id
        );
    }

    let graph = problem
        .physics_graph
        .as_mut()
        .and_then(Value::as_object_mut)
        .context("study pipeline set_spin_torque_enabled requires physics_graph.v1")?;
    if graph.get("schema_version").and_then(Value::as_str) != Some("physics_graph.v1") {
        bail!("study pipeline set_spin_torque_enabled requires physics_graph.v1");
    }
    let modules = graph
        .get_mut("modules")
        .and_then(Value::as_array_mut)
        .context("physics_graph.v1 modules must be an array")?;
    let matching_graph_indices: Vec<_> = modules
        .iter()
        .enumerate()
        .filter_map(|(index, module)| {
            (module.get("id").and_then(Value::as_str) == Some(module_id.as_str())
                && module.get("kind").and_then(Value::as_str) == Some("spin_torque"))
            .then_some(index)
        })
        .collect();
    let [module_index] = matching_graph_indices.as_slice() else {
        bail!(
            "study pipeline set_spin_torque_enabled module_id '{}' must identify exactly one physics_graph spin_torque module",
            module_id
        );
    };
    let activation = if enabled { "active" } else { "inactive" };
    modules[*module_index]
        .as_object_mut()
        .expect("matching graph module must be an object")
        .insert(
            "activation".to_string(),
            Value::String(activation.to_string()),
        );

    let edges = graph
        .get_mut("edges")
        .and_then(Value::as_array_mut)
        .context("physics_graph.v1 edges must be an array")?;
    for edge in edges {
        if edge.get("target_id").and_then(Value::as_str) == Some(module_id.as_str()) {
            edge.as_object_mut()
                .expect("physics graph edge must be an object")
                .insert("status".to_string(), Value::String(activation.to_string()));
        }
    }
    propagate_disabled_transport_pipeline(graph, &module_id)?;
    Ok(())
}

fn graph_module_is_active(module: &Value) -> bool {
    matches!(
        module.get("activation").and_then(Value::as_str),
        Some("active" | "configured")
    )
}

fn set_graph_module_activation(module: &mut Value, active: bool) {
    module
        .as_object_mut()
        .expect("physics graph module must be an object")
        .insert(
            "activation".to_string(),
            Value::String(if active { "active" } else { "inactive" }.to_string()),
        );
}

/// Propagate a stage-local torque action through its solved transport pipeline.
///
/// The typed torque node is the user-facing switch, but an inactive transport
/// consumer must not leave its upstream charge/spin solver executable during a
/// preparation stage.  Conversely, enabling the torque reactivates the same
/// source and transport nodes before the following run.  The graph remains
/// present for provenance in both cases.
#[doc(hidden)]
pub fn propagate_disabled_transport_pipeline(
    graph: &mut serde_json::Map<String, Value>,
    changed_torque_id: &str,
) -> Result<()> {
    let modules = graph
        .get("modules")
        .and_then(Value::as_array)
        .context("physics_graph.v1 modules must be an array")?;
    let snapshot = modules
        .iter()
        .map(|module| {
            (
                module
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                module
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                module
                    .get("depends_on")
                    .and_then(Value::as_array)
                    .map(|dependencies| {
                        dependencies
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default(),
                graph_module_is_active(module),
            )
        })
        .collect::<Vec<_>>();
    let changed = snapshot
        .iter()
        .find(|(id, kind, _, _)| id == changed_torque_id && kind == "spin_torque");
    let Some((_, _, changed_dependencies, _)) = changed else {
        return Ok(());
    };
    let affected_transport_ids = changed_dependencies
        .iter()
        .filter(|dependency| {
            snapshot
                .iter()
                .any(|(id, kind, _, _)| id == *dependency && kind == "spin_transport")
        })
        .cloned()
        .collect::<Vec<_>>();
    if affected_transport_ids.is_empty() {
        return Ok(());
    }

    let mut desired_transport = BTreeMap::new();
    let mut affected_sources = BTreeMap::<String, Vec<String>>::new();
    for transport_id in &affected_transport_ids {
        let consumers = snapshot
            .iter()
            .filter(|(_, kind, dependencies, _)| {
                kind == "spin_torque" && dependencies.iter().any(|id| id == transport_id)
            })
            .collect::<Vec<_>>();
        if consumers.is_empty() {
            continue;
        }
        desired_transport.insert(
            transport_id.clone(),
            consumers.iter().any(|(_, _, _, active)| *active),
        );
        if let Some((_, _, dependencies, _)) = snapshot
            .iter()
            .find(|(id, kind, _, _)| id == transport_id && kind == "spin_transport")
        {
            for source_id in dependencies {
                if snapshot
                    .iter()
                    .any(|(id, kind, _, _)| id == source_id && kind == "current_transport")
                {
                    affected_sources
                        .entry(source_id.clone())
                        .or_default()
                        .push(transport_id.clone());
                }
            }
        }
    }

    let mut desired_source = BTreeMap::new();
    for (source_id, transports) in &affected_sources {
        let active_dependent = snapshot.iter().any(|(id, kind, dependencies, active)| {
            id != source_id
                && dependencies
                    .iter()
                    .any(|dependency| dependency == source_id)
                && if kind == "spin_transport" {
                    transports
                        .iter()
                        .find_map(|transport_id| {
                            (id == transport_id).then(|| desired_transport[transport_id])
                        })
                        .unwrap_or(*active)
                } else {
                    *active
                }
        });
        desired_source.insert(source_id.clone(), active_dependent);
    }

    let modules = graph
        .get_mut("modules")
        .and_then(Value::as_array_mut)
        .context("physics_graph.v1 modules must be an array")?;
    for module in modules.iter_mut() {
        let id = module.get("id").and_then(Value::as_str).unwrap_or_default();
        let kind = module
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if let Some(active) = desired_source.get(id) {
            set_graph_module_activation(module, *active);
            continue;
        }
        if kind == "spin_transport" {
            if let Some(active) = desired_transport.get(id) {
                let source_active = module
                    .get("depends_on")
                    .and_then(Value::as_array)
                    .and_then(|dependencies| dependencies.first())
                    .and_then(Value::as_str)
                    .and_then(|source_id| desired_source.get(source_id))
                    .copied()
                    .unwrap_or(true);
                set_graph_module_activation(module, *active && source_active);
            }
        }
    }

    let module_status = modules
        .iter()
        .filter_map(|module| {
            Some((
                module.get("id")?.as_str()?.to_string(),
                graph_module_is_active(module),
            ))
        })
        .collect::<BTreeMap<_, _>>();
    for module in modules.iter_mut() {
        let kind = module
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(kind, "spin_interface" | "spin_torque" | "oersted_field") {
            continue;
        }
        let dependencies = module
            .get("depends_on")
            .and_then(Value::as_array)
            .map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>())
            .unwrap_or_default();
        if dependencies
            .iter()
            .any(|dependency| module_status.get(*dependency) == Some(&false))
        {
            set_graph_module_activation(module, false);
        } else if matches!(kind, "spin_interface" | "oersted_field") {
            set_graph_module_activation(module, true);
        }
    }

    let module_status = modules
        .iter()
        .filter_map(|module| {
            Some((
                module.get("id")?.as_str()?.to_string(),
                module
                    .get("activation")
                    .and_then(Value::as_str)
                    .unwrap_or("inactive")
                    .to_string(),
            ))
        })
        .collect::<BTreeMap<_, _>>();
    let edges = graph
        .get_mut("edges")
        .and_then(Value::as_array_mut)
        .context("physics_graph.v1 edges must be an array")?;
    for edge in edges {
        let Some(target_id) = edge.get("target_id").and_then(Value::as_str) else {
            continue;
        };
        let Some(status) = module_status.get(target_id) else {
            continue;
        };
        edge.as_object_mut()
            .expect("physics graph edge must be an object")
            .insert("status".to_string(), Value::String(status.clone()));
    }
    Ok(())
}

fn apply_pipeline_external_field(problem: &mut ProblemIR, field_t: [f64; 3]) {
    for term in &mut problem.energy_terms {
        if let fullmag_ir::EnergyTermIR::Zeeman { b } = term {
            *b = field_t;
            return;
        }
    }
    problem
        .energy_terms
        .push(fullmag_ir::EnergyTermIR::Zeeman { b: field_t });
}

fn payload_axis(
    payload: &BTreeMap<String, Value>,
    key: &str,
    default_axis: [f64; 3],
) -> Result<[f64; 3]> {
    let Some(raw_value) = payload.get(key) else {
        return Ok(default_axis);
    };
    match raw_value {
        Value::Null => Ok(default_axis),
        Value::String(value) => {
            if value.trim().is_empty() {
                Ok(default_axis)
            } else {
                parse_axis_spec(value, key)
            }
        }
        Value::Array(values) => {
            if values.len() != 3 {
                bail!("payload field '{key}' must contain exactly 3 axis components");
            }
            let axis = [
                values[0].as_f64().ok_or_else(|| {
                    anyhow::anyhow!("invalid axis component for payload field '{key}'")
                })?,
                values[1].as_f64().ok_or_else(|| {
                    anyhow::anyhow!("invalid axis component for payload field '{key}'")
                })?,
                values[2].as_f64().ok_or_else(|| {
                    anyhow::anyhow!("invalid axis component for payload field '{key}'")
                })?,
            ];
            normalize_axis(axis, key)
        }
        _ => bail!("payload field '{key}' must be an axis string or 3-element array"),
    }
}

fn parse_axis_spec(raw: &str, key: &str) -> Result<[f64; 3]> {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    let axis = match lower.as_str() {
        "x" | "+x" => Some([1.0, 0.0, 0.0]),
        "-x" => Some([-1.0, 0.0, 0.0]),
        "y" | "+y" => Some([0.0, 1.0, 0.0]),
        "-y" => Some([0.0, -1.0, 0.0]),
        "z" | "+z" => Some([0.0, 0.0, 1.0]),
        "-z" => Some([0.0, 0.0, -1.0]),
        _ => None,
    };
    if let Some(axis) = axis {
        return Ok(axis);
    }
    let values: Vec<f64> = trimmed
        .split(',')
        .map(|component| {
            component
                .trim()
                .parse::<f64>()
                .with_context(|| format!("invalid axis component in payload field '{key}'"))
        })
        .collect::<Result<Vec<_>>>()?;
    if values.len() != 3 {
        bail!("payload field '{key}' must be a named axis or 3 comma-separated values");
    }
    normalize_axis([values[0], values[1], values[2]], key)
}

fn normalize_axis(axis: [f64; 3], key: &str) -> Result<[f64; 3]> {
    let norm = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
    if norm <= f64::EPSILON {
        bail!("payload field '{key}' must not be the zero vector");
    }
    Ok([axis[0] / norm, axis[1] / norm, axis[2] / norm])
}

fn scaled_axis(axis: [f64; 3], magnitude: f64) -> [f64; 3] {
    [
        axis[0] * magnitude,
        axis[1] * magnitude,
        axis[2] * magnitude,
    ]
}

fn linear_sweep_values(start: f64, stop: f64, steps: u64) -> Result<Vec<f64>> {
    if steps == 0 {
        bail!("linear sweep requires at least one point");
    }
    if steps == 1 {
        return Ok(vec![start]);
    }
    let denominator = (steps - 1) as f64;
    Ok((0..steps)
        .map(|index| {
            let t = index as f64 / denominator;
            start + (stop - start) * t
        })
        .collect())
}
