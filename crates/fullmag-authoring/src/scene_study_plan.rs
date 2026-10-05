use crate::study_contract::migrate_run_duration;
use crate::{
    validate_scene_document_for_authoring, SceneDocument, StudyAcceptancePolicy,
    StudyAcquisitionPolicy, StudyContractError, StudyPlan, StudyPlanMigrationDefaults,
    StudyPrimitiveStageKind, StudyStep, StudyStepKind,
};
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

    if let Some(pipeline) = scene
        .study
        .study_pipeline
        .as_ref()
        .filter(|pipeline| !pipeline.nodes.is_empty())
    {
        return StudyPlan::from_pipeline(study_id, revision, pipeline, defaults);
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

        steps.push(StudyStep {
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
            outputs: Vec::new(),
            acceptance: StudyAcceptancePolicy::Any,
            acquisition: StudyAcquisitionPolicy::Exclusive,
            legacy_payload: Some(payload),
        });
    }

    let plan = StudyPlan {
        schema_version: crate::STUDY_PLAN_SCHEMA_VERSION.to_string(),
        study_id,
        revision,
        source_pipeline_version: None,
        steps,
    };
    plan.validate()?;
    Ok(plan)
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
