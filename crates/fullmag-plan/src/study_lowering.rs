//! Lowering boundary from the typed authoring study contract to the planner.
//!
//! The study contract contains references, not mutable model state. A caller
//! must resolve each reference to an immutable `ProblemIR` snapshot explicitly;
//! this module then invokes the canonical planner and preserves requested /
//! resolved backend provenance for every executable step.

use fullmag_authoring::{
    StudyAcceptancePolicy, StudyAcquisitionPolicy, StudyContractError,
    StudyDiscretizationReference, StudyExecutionProfileReference, StudyInputPort,
    StudyModelReference, StudyOutputPort, StudyPlan, StudySolverConfigReference, StudyStep,
    StudyStepKind,
};
use fullmag_ir::{ExecutionPlanIR, ProblemIR};
use serde::{Deserialize, Serialize};

use super::plan as lower_problem_plan;

pub const STUDY_EXECUTION_PLAN_SCHEMA_V1: &str = "study_execution_plan.v1";
pub const STUDY_EXECUTION_PLAN_SCHEMA: &str = "study_execution_plan.v2";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StudyLoweringError {
    Contract(String),
    Resolver {
        step_id: String,
        reason: String,
    },
    Planner {
        step_id: String,
        reasons: Vec<String>,
    },
    Dependency {
        step_id: String,
        reason: String,
    },
}

impl std::fmt::Display for StudyLoweringError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Contract(message) => formatter.write_str(message),
            Self::Resolver { step_id, reason } => {
                write!(
                    formatter,
                    "study step `{step_id}` reference resolution failed: {reason}"
                )
            }
            Self::Planner { step_id, reasons } => {
                write!(
                    formatter,
                    "study step `{step_id}` planning failed: {}",
                    reasons.join("; ")
                )
            }
            Self::Dependency { step_id, reason } => {
                write!(
                    formatter,
                    "study step `{step_id}` dependency is not executable: {reason}"
                )
            }
        }
    }
}

impl std::error::Error for StudyLoweringError {}

impl From<StudyContractError> for StudyLoweringError {
    fn from(error: StudyContractError) -> Self {
        Self::Contract(error.to_string())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum StudyStepLoweringStatus {
    Planned,
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StudyStepExecutionPlan {
    pub step_id: String,
    pub label: String,
    pub enabled: bool,
    pub status: StudyStepLoweringStatus,
    pub kind: StudyStepKind,
    pub model: StudyModelReference,
    pub solver_config: StudySolverConfigReference,
    pub discretization: StudyDiscretizationReference,
    pub execution_profile: StudyExecutionProfileReference,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until_seconds: Option<f64>,
    pub inputs: Vec<StudyInputPort>,
    pub outputs: Vec<StudyOutputPort>,
    pub acceptance: StudyAcceptancePolicy,
    pub acquisition: StudyAcquisitionPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_plan: Option<ExecutionPlanIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StudyExecutionPlan {
    pub schema_version: String,
    pub study_id: String,
    pub study_revision: u64,
    pub study_plan_sha256: String,
    pub topological_order: Vec<String>,
    pub steps: Vec<StudyStepExecutionPlan>,
}

impl StudyExecutionPlan {
    pub fn validate(&self) -> Result<(), StudyLoweringError> {
        let is_legacy_v1 = self.schema_version == STUDY_EXECUTION_PLAN_SCHEMA_V1;
        if !is_legacy_v1 && self.schema_version != STUDY_EXECUTION_PLAN_SCHEMA {
            return Err(StudyLoweringError::Contract(format!(
                "schema_version must be {STUDY_EXECUTION_PLAN_SCHEMA_V1} or {STUDY_EXECUTION_PLAN_SCHEMA}"
            )));
        }
        if self.study_id.trim().is_empty() || self.study_plan_sha256.len() != 64 {
            return Err(StudyLoweringError::Contract(
                "study execution plan identity is incomplete".into(),
            ));
        }
        if self.topological_order.len() != self.steps.len() {
            return Err(StudyLoweringError::Contract(
                "topological_order must contain every lowered step exactly once".into(),
            ));
        }
        for (index, step) in self.steps.iter().enumerate() {
            if self.topological_order.get(index) != Some(&step.step_id) {
                return Err(StudyLoweringError::Contract(
                    "topological_order does not match lowered step order".into(),
                ));
            }
            match step.status {
                StudyStepLoweringStatus::Planned if step.execution_plan.is_none() => {
                    return Err(StudyLoweringError::Contract(format!(
                        "planned step `{}` has no execution plan",
                        step.step_id
                    )));
                }
                StudyStepLoweringStatus::Disabled if step.execution_plan.is_some() => {
                    return Err(StudyLoweringError::Contract(format!(
                        "disabled step `{}` carries an execution plan",
                        step.step_id
                    )));
                }
                _ => {}
            }
            if let Some(until_seconds) = step.until_seconds {
                if !until_seconds.is_finite() || until_seconds <= 0.0 {
                    return Err(StudyLoweringError::Contract(format!(
                        "study step `{}` until_seconds must be finite and greater than zero",
                        step.step_id
                    )));
                }
                if is_legacy_v1 {
                    return Err(StudyLoweringError::Contract(
                        "until_seconds requires study_execution_plan.v2".into(),
                    ));
                }
            }
        }
        Ok(())
    }
}

/// Resolve each immutable study step and lower it through the canonical
/// `fullmag_plan::plan` entry point.
///
/// The resolver is deliberately supplied by the application/catalog layer.
/// It must not read a mutable `current` pointer or fill missing references
/// from UI state. Macro and group steps are accepted only when the resolver
/// explicitly materializes a `ProblemIR`; unsupported kinds are rejected by
/// `StudyPlan::validate_for_execution` before the resolver is called.
pub fn lower_study_plan<F, E>(
    study: &StudyPlan,
    mut resolve_problem: F,
) -> Result<StudyExecutionPlan, StudyLoweringError>
where
    F: FnMut(&StudyStep) -> Result<ProblemIR, E>,
    E: std::fmt::Display,
{
    study.validate_for_execution()?;
    let topological_order = study.topological_order()?;
    let steps_by_id = study
        .steps
        .iter()
        .map(|step| (step.step_id.as_str(), step))
        .collect::<std::collections::BTreeMap<_, _>>();
    let disabled_steps = study
        .steps
        .iter()
        .filter(|step| !step.enabled)
        .map(|step| step.step_id.as_str())
        .collect::<std::collections::BTreeSet<_>>();

    let mut lowered_steps = Vec::with_capacity(topological_order.len());
    for step_id in &topological_order {
        let step = steps_by_id.get(step_id.as_str()).ok_or_else(|| {
            StudyLoweringError::Contract(format!("topological step `{step_id}` is missing"))
        })?;
        for input in &step.inputs {
            if let fullmag_authoring::StudyInputSource::StepOutput {
                step_id: source_step,
                ..
            } = &input.source
            {
                if disabled_steps.contains(source_step.as_str()) {
                    return Err(StudyLoweringError::Dependency {
                        step_id: step.step_id.clone(),
                        reason: format!(
                            "input `{}` references disabled step `{source_step}`",
                            input.port_id
                        ),
                    });
                }
            }
        }

        let execution_plan = if !step.enabled {
            None
        } else {
            let problem = resolve_problem(step).map_err(|error| StudyLoweringError::Resolver {
                step_id: step.step_id.clone(),
                reason: error.to_string(),
            })?;
            if matches!(problem.study, fullmag_ir::StudyIR::TimeEvolution { .. })
                && step.until_seconds.is_none()
            {
                return Err(StudyLoweringError::Contract(format!(
                    "time-evolution step `{}` requires an accepted positive until_seconds in study_plan.v2",
                    step.step_id
                )));
            }
            Some(
                lower_problem_plan(&problem).map_err(|error| StudyLoweringError::Planner {
                    step_id: step.step_id.clone(),
                    reasons: error.reasons,
                })?,
            )
        };

        lowered_steps.push(StudyStepExecutionPlan {
            step_id: step.step_id.clone(),
            label: step.label.clone(),
            enabled: step.enabled,
            status: if step.enabled {
                StudyStepLoweringStatus::Planned
            } else {
                StudyStepLoweringStatus::Disabled
            },
            kind: step.kind.clone(),
            model: step.model.clone(),
            solver_config: step.solver_config.clone(),
            discretization: step.discretization.clone(),
            execution_profile: step.execution_profile.clone(),
            until_seconds: step.until_seconds,
            inputs: step.inputs.clone(),
            outputs: step.outputs.clone(),
            acceptance: step.acceptance.clone(),
            acquisition: step.acquisition,
            execution_plan,
        });
    }

    let result = StudyExecutionPlan {
        schema_version: STUDY_EXECUTION_PLAN_SCHEMA.into(),
        study_id: study.study_id.clone(),
        study_revision: study.revision,
        study_plan_sha256: study.canonical_sha256().map_err(|error| {
            StudyLoweringError::Contract(format!("study plan fingerprint failed: {error}"))
        })?,
        topological_order,
        steps: lowered_steps,
    };
    result.validate()?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_authoring::{
        PrimitiveStageNode, StudyPipelineDocument, StudyPipelineNode, StudyPipelineNodeSource,
        StudyPlanMigrationDefaults, StudyPrimitiveStageKind,
    };
    use serde_json::json;

    fn study() -> StudyPlan {
        StudyPlan::from_pipeline(
            "study:lowering",
            4,
            &StudyPipelineDocument {
                version: "study_pipeline.v2".into(),
                nodes: vec![StudyPipelineNode::Primitive(PrimitiveStageNode {
                    id: "step:run".into(),
                    label: "Run".into(),
                    enabled: true,
                    notes: None,
                    source: Some(StudyPipelineNodeSource::UiAuthored),
                    stage_kind: StudyPrimitiveStageKind::Run,
                    payload: [("until_seconds".into(), json!("1e-9"))]
                        .into_iter()
                        .collect(),
                })],
            },
            &StudyPlanMigrationDefaults {
                model: StudyModelReference {
                    model_id: "model:one".into(),
                    version: "v1".into(),
                },
                solver_config: StudySolverConfigReference {
                    preset_id: "solver:default".into(),
                    version: "v1".into(),
                },
                discretization: StudyDiscretizationReference {
                    recipe_id: "mesh:default".into(),
                    version: "v1".into(),
                },
                execution_profile: StudyExecutionProfileReference {
                    profile_id: "exec:auto".into(),
                    version: "v1".into(),
                },
            },
        )
        .unwrap()
    }

    #[test]
    fn lowers_resolved_problem_through_canonical_planner() {
        let study = study();
        let lowered = lower_study_plan(&study, |_| {
            Ok::<_, &'static str>(ProblemIR::bootstrap_example())
        })
        .expect("bootstrap problem should lower");
        assert_eq!(lowered.schema_version, STUDY_EXECUTION_PLAN_SCHEMA);
        assert_eq!(lowered.topological_order, vec!["step:run"]);
        assert!(matches!(
            lowered.steps[0].status,
            StudyStepLoweringStatus::Planned
        ));
        assert!(lowered.steps[0].execution_plan.is_some());
        assert_eq!(lowered.steps[0].until_seconds, Some(1e-9));
        lowered.validate().unwrap();
    }

    #[test]
    fn time_evolution_requires_accepted_run_duration_before_lowering() {
        let mut study = study();
        study.steps[0].until_seconds = None;
        let error = lower_study_plan(&study, |_| {
            Ok::<_, &'static str>(ProblemIR::bootstrap_example())
        })
        .expect_err("time evolution must not invent an end time");
        assert!(error
            .to_string()
            .contains("requires an accepted positive until_seconds"));
    }

    #[test]
    fn unsupported_step_is_blocked_before_reference_resolution() {
        let study: StudyPlan = serde_json::from_value(json!({
            "schema_version": fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION,
            "study_id": "study:unsupported",
            "revision": 1,
            "steps": [{
                "step_id": "step:future",
                "label": "Future",
                "kind": "future_solver",
                "model": {"model_id": "model:one", "version": "v1"},
                "solver_config": {"preset_id": "solver:default", "version": "v1"},
                "discretization": {"recipe_id": "mesh:default", "version": "v1"},
                "execution_profile": {"profile_id": "exec:auto", "version": "v1"},
                "acceptance": {"kind": "any"},
                "acquisition": "exclusive"
            }]
        }))
        .unwrap();
        let mut resolver_called = false;
        let result = lower_study_plan(&study, |_| {
            resolver_called = true;
            Ok::<_, &'static str>(ProblemIR::bootstrap_example())
        });
        assert!(matches!(result, Err(StudyLoweringError::Contract(_))));
        assert!(!resolver_called);
    }
}
