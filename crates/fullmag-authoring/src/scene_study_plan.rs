use crate::study_contract::{
    authored_stage_output_ports, migrate_run_duration, EQUILIBRIUM_HANDOFF_PORT_ID,
};
use crate::{
    validate_scene_document_for_authoring, SceneDocument, StudyAcceptancePolicy,
    StudyAcquisitionPolicy, StudyContractError, StudyInputPort, StudyInputSource, StudyOutputPort,
    StudyPlan, StudyPlanMigrationDefaults, StudyPortDataKind, StudyPrimitiveStageKind, StudyStep,
    StudyStepKind,
};
use fullmag_ir::BackendTarget;
use serde_json::Value;

/// Projects the authored study structure in a scene into the typed StudyPlan
/// contract. Runtime resolution and per-step ProblemIR production belong to
/// the application layer.
pub fn scene_document_to_study_plan(
    scene: &SceneDocument,
    study_id: impl Into<String>,
    revision: u64,
    defaults: &StudyPlanMigrationDefaults,
) -> Result<StudyPlan, StudyContractError> {
    validate_execution_profile_binding(scene, defaults)?;
    let fem_requested = scene_requests_fem(scene)?;

    if let Some(pipeline) = scene.study.study_pipeline.as_ref() {
        if pipeline.version != "study_pipeline.v1" {
            return Err(StudyContractError::Invalid(format!(
                "unsupported study pipeline version '{}'",
                pipeline.version
            )));
        }
        let mut plan = StudyPlan::from_pipeline(study_id, revision, pipeline, defaults)?;
        normalize_fem_eigen_relax_dependencies(&mut plan, fem_requested)?;
        plan.validate()?;
        return Ok(plan);
    }

    let study_id = study_id.into();
    let mut steps = Vec::with_capacity(scene.study.stages.len());
    for (index, stage) in scene.study.stages.iter().enumerate() {
        let payload = serde_json::to_value(stage).map_err(|error| {
            StudyContractError::Invalid(format!(
                "scene study stage {index} serialization failed: {error}"
            ))
        })?;
        let metadata = payload.as_object();
        let step_id = metadata
            .and_then(|value| value.get("stage_id"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("scene-stage-{index}"));
        let label = metadata
            .and_then(|value| value.get("label"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| stage.kind.clone());
        let enabled = match metadata.and_then(|value| value.get("enabled")) {
            None => true,
            Some(Value::Bool(enabled)) => *enabled,
            Some(_) => {
                return Err(StudyContractError::Invalid(format!(
                    "scene.study.stages[{index}].enabled must be a boolean when specified"
                )));
            }
        };
        let notes = metadata
            .and_then(|value| value.get("notes"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let source = match metadata.and_then(|value| value.get("source")) {
            None | Some(Value::Null) => None,
            Some(value) => Some(serde_json::from_value(value.clone()).map_err(|error| {
                StudyContractError::Invalid(format!(
                    "scene.study.stages[{index}].source is invalid: {error}"
                ))
            })?),
        };

        let (kind, until_seconds) = match serde_json::from_value::<StudyPrimitiveStageKind>(
            Value::String(stage.kind.clone()),
        ) {
            Ok(stage_kind) => {
                let until_seconds = if stage_kind == StudyPrimitiveStageKind::Run {
                    migrate_run_duration(Some(&payload))?
                } else {
                    None
                };
                (StudyStepKind::Primitive { stage_kind }, until_seconds)
            }
            Err(_) => (
                StudyStepKind::Unsupported {
                    unsupported_kind: stage.kind.clone(),
                    payload: payload.clone(),
                },
                None,
            ),
        };

        let outputs = authored_stage_output_ports(&kind);
        steps.push(StudyStep {
            completion_dependencies: Vec::new(),
            step_id,
            label,
            enabled,
            notes,
            source,
            kind,
            model: defaults.model.clone(),
            solver_config: defaults.solver_config.clone(),
            discretization: defaults.discretization.clone(),
            execution_profile: defaults.execution_profile.clone(),
            until_seconds,
            inputs: Vec::new(),
            outputs,
            acceptance: StudyAcceptancePolicy::Any,
            acquisition: StudyAcquisitionPolicy::Exclusive,
            legacy_payload: Some(payload),
        });
    }

    let mut plan = StudyPlan {
        schema_version: crate::STUDY_PLAN_SCHEMA_VERSION_V2.to_string(),
        study_id,
        revision,
        source_pipeline_version: None,
        steps,
    };
    normalize_fem_eigen_relax_dependencies(&mut plan, fem_requested)?;
    plan.validate()?;
    Ok(plan)
}

/// Resolve the public FEM `equilibrium_source="relax"` shorthand into the
/// typed StudyPlan edge used by scheduler and CAS resolution.
///
/// This is deliberately authoring-only: the FEM lane is selected from the
/// explicit SceneDocument execution intent, never from a resolved runtime
/// backend or from stage labels.  An existing typed handoff binding is
/// authoritative; only the shorthand with no binding performs the bounded
/// one-enabled-Relax lookup.
pub(crate) fn normalize_fem_eigen_relax_dependencies(
    plan: &mut StudyPlan,
    fem_requested: bool,
) -> Result<(), StudyContractError> {
    if !fem_requested {
        return Ok(());
    }

    let eigen_indices = plan
        .steps
        .iter()
        .enumerate()
        .filter_map(|(index, step)| {
            (step.enabled
                && matches!(
                    &step.kind,
                    StudyStepKind::Primitive {
                        stage_kind: StudyPrimitiveStageKind::Eigenmodes,
                    }
                ))
            .then_some(index)
        })
        .collect::<Vec<_>>();

    for eigen_index in eigen_indices {
        let explicit_input_index = plan.steps[eigen_index]
            .inputs
            .iter()
            .position(|input| input.port_id == EQUILIBRIUM_HANDOFF_PORT_ID);

        if let Some(input_index) = explicit_input_index {
            validate_explicit_equilibrium_binding(plan, eigen_index, input_index)?;
            continue;
        }

        if !eigen_requests_relax(&plan.steps[eigen_index])? {
            continue;
        }

        let relax_indices = plan
            .steps
            .iter()
            .enumerate()
            .filter_map(|(index, step)| {
                (step.enabled
                    && matches!(
                        &step.kind,
                        StudyStepKind::Primitive {
                            stage_kind: StudyPrimitiveStageKind::Relax,
                        }
                    ))
                .then_some(index)
            })
            .collect::<Vec<_>>();

        let Some(&relax_index) = relax_indices.first() else {
            return Err(StudyContractError::Invalid(format!(
                "FEM Eigen step `{}` requests equilibrium_source=relax but has no enabled Relax producer (found none); declare an explicit typed `{EQUILIBRIUM_HANDOFF_PORT_ID}` StepOutput or enable exactly one Relax step",
                plan.steps[eigen_index].step_id
            )));
        };
        if relax_indices.len() != 1 {
            return Err(StudyContractError::Invalid(format!(
                "FEM Eigen step `{}` requests equilibrium_source=relax but has an ambiguous enabled Relax producer (found {}); declare an explicit typed `{EQUILIBRIUM_HANDOFF_PORT_ID}` StepOutput",
                plan.steps[eigen_index].step_id,
                relax_indices.len()
            )));
        }

        let relax_step_id = plan.steps[relax_index].step_id.clone();
        let eigen_step_id = plan.steps[eigen_index].step_id.clone();
        ensure_relax_handoff_outputs(plan, relax_index, &eigen_step_id)?;
        plan.steps[eigen_index].inputs.push(StudyInputPort {
            port_id: EQUILIBRIUM_HANDOFF_PORT_ID.to_owned(),
            data_kind: StudyPortDataKind::Artifact,
            required: true,
            source: StudyInputSource::StepOutput {
                step_id: relax_step_id,
                port: EQUILIBRIUM_HANDOFF_PORT_ID.to_owned(),
                case_id: "default".to_owned(),
            },
        });
    }

    Ok(())
}

fn validate_explicit_equilibrium_binding(
    plan: &mut StudyPlan,
    eigen_index: usize,
    input_index: usize,
) -> Result<(), StudyContractError> {
    let eigen_step_id = plan.steps[eigen_index].step_id.clone();
    let input = plan.steps[eigen_index].inputs[input_index].clone();
    let StudyInputSource::StepOutput {
        step_id,
        port,
        case_id,
    } = input.source
    else {
        return Err(StudyContractError::Invalid(format!(
            "FEM Eigen step `{eigen_step_id}` has `{EQUILIBRIUM_HANDOFF_PORT_ID}` input without an explicit Relax StepOutput binding"
        )));
    };
    if input.data_kind != StudyPortDataKind::Artifact
        || !input.required
        || port != EQUILIBRIUM_HANDOFF_PORT_ID
        || case_id != "default"
    {
        return Err(StudyContractError::Invalid(format!(
            "FEM Eigen step `{eigen_step_id}` `{EQUILIBRIUM_HANDOFF_PORT_ID}` input must be required Artifact StepOutput port `{EQUILIBRIUM_HANDOFF_PORT_ID}` with case_id `default`"
        )));
    }

    let Some(relax_index) = plan.steps.iter().position(|step| step.step_id == step_id) else {
        return Err(StudyContractError::UnknownReference {
            from: eigen_step_id,
            to: step_id,
        });
    };
    let relax_step = &plan.steps[relax_index];
    if !relax_step.enabled
        || !matches!(
            &relax_step.kind,
            StudyStepKind::Primitive {
                stage_kind: StudyPrimitiveStageKind::Relax,
            }
        )
    {
        return Err(StudyContractError::Invalid(format!(
            "FEM Eigen step `{}` `{EQUILIBRIUM_HANDOFF_PORT_ID}` input must reference one enabled primitive Relax producer, got `{step_id}`",
            plan.steps[eigen_index].step_id
        )));
    }
    ensure_relax_handoff_outputs(plan, relax_index, &eigen_step_id)
}

fn ensure_relax_handoff_outputs(
    plan: &mut StudyPlan,
    relax_index: usize,
    eigen_step_id: &str,
) -> Result<(), StudyContractError> {
    let relax_step_id = plan.steps[relax_index].step_id.clone();
    let outputs = &mut plan.steps[relax_index].outputs;
    if outputs.is_empty() {
        *outputs = vec![
            StudyOutputPort {
                port_id: "final_state".to_owned(),
                data_kind: StudyPortDataKind::State,
            },
            StudyOutputPort {
                port_id: "total_energy".to_owned(),
                data_kind: StudyPortDataKind::Scalar,
            },
            StudyOutputPort {
                port_id: EQUILIBRIUM_HANDOFF_PORT_ID.to_owned(),
                data_kind: StudyPortDataKind::Artifact,
            },
        ];
        return Ok(());
    }

    for (port_id, data_kind) in [
        (EQUILIBRIUM_HANDOFF_PORT_ID, StudyPortDataKind::Artifact),
        ("final_state", StudyPortDataKind::State),
        ("total_energy", StudyPortDataKind::Scalar),
    ] {
        let Some(output) = outputs.iter().find(|output| output.port_id == port_id) else {
            return Err(StudyContractError::Invalid(format!(
                "FEM Relax producer `{relax_step_id}` has explicit custom outputs, but Eigen step `{eigen_step_id}` requires `{port_id}`; preserve the complete explicit output contract or remove the conflict"
            )));
        };
        if output.data_kind != data_kind {
            return Err(StudyContractError::PortMismatch {
                step: relax_step_id.clone(),
                port: port_id.to_owned(),
            });
        }
    }
    Ok(())
}

fn eigen_requests_relax(step: &StudyStep) -> Result<bool, StudyContractError> {
    let value = step
        .legacy_payload
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|payload| {
            ["eigen_equilibrium_source", "equilibrium_source"]
                .into_iter()
                .find_map(|key| {
                    payload.get(key).and_then(|value| match value {
                        Value::Null => None,
                        Value::String(text) if text.trim().is_empty() => None,
                        value => Some(value),
                    })
                })
        });
    match value {
        None => Ok(true),
        Some(Value::String(source)) => Ok(source.trim().eq_ignore_ascii_case("relax")),
        Some(_) => Err(StudyContractError::Invalid(format!(
            "FEM Eigen step `{}` equilibrium_source must be a string when specified",
            step.step_id
        ))),
    }
}

fn scene_requests_fem(scene: &SceneDocument) -> Result<bool, StudyContractError> {
    let requested_backend = scene.study.requested_backend.trim();
    if requested_backend.eq_ignore_ascii_case("fem") {
        return Ok(true);
    }
    if !requested_backend.is_empty() && !requested_backend.eq_ignore_ascii_case("auto") {
        return Ok(false);
    }

    if let Some(profile) = scene.study.execution_profile.as_ref() {
        let materialized = fullmag_ir::materialize_execution_request(
            Some(profile.clone()),
            scene.study.execution_layers.clone(),
        )
        .map_err(|error| {
            StudyContractError::Invalid(format!(
                "scene execution intent cannot determine FEM lane: {error}"
            ))
        })?;
        if materialized.requested.backend != BackendTarget::Auto {
            return Ok(materialized.requested.backend == BackendTarget::Fem);
        }
    }

    Ok(scene
        .study
        .backend
        .as_deref()
        .is_some_and(|backend| backend.trim().eq_ignore_ascii_case("fem")))
}

fn validate_execution_profile_binding(
    scene: &SceneDocument,
    defaults: &StudyPlanMigrationDefaults,
) -> Result<(), StudyContractError> {
    if scene.study.execution_profile.is_some() || !scene.study.execution_layers.is_empty() {
        validate_scene_document_for_authoring(scene).map_err(|error| {
            StudyContractError::Invalid(format!(
                "scene execution intent is invalid: {}",
                error.message
            ))
        })?;
    }

    if let Some(profile) = &scene.study.execution_profile {
        let reference = &defaults.execution_profile;
        if profile.profile_id != reference.profile_id || profile.version != reference.version {
            return Err(StudyContractError::Invalid(format!(
                "scene execution profile {}/{} does not match StudyPlan migration default {}/{}",
                profile.profile_id, profile.version, reference.profile_id, reference.version
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "scene_study_plan_tests.rs"]
mod tests;
