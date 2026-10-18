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
pub const STUDY_EXECUTION_PLAN_SCHEMA_V2: &str = "study_execution_plan.v2";
pub const STUDY_EXECUTION_PLAN_SCHEMA: &str = "study_execution_plan.v3";
pub const STUDY_EXECUTION_PLAN_SCHEMA_V4: &str = "study_execution_plan.v4";

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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub completion_dependencies: Vec<String>,
    pub outputs: Vec<StudyOutputPort>,
    pub acceptance: StudyAcceptancePolicy,
    pub acquisition: StudyAcquisitionPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_plan: Option<ExecutionPlanIR>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StudyExecutionPlan {
    pub schema_version: String,
    pub study_id: String,
    pub study_revision: u64,
    pub study_plan_sha256: String,
    pub topological_order: Vec<String>,
    pub steps: Vec<StudyStepExecutionPlan>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StudyExecutionPlanWire {
    schema_version: String,
    study_id: String,
    study_revision: u64,
    study_plan_sha256: String,
    topological_order: Vec<String>,
    steps: Vec<serde_json::Value>,
}

impl Serialize for StudyExecutionPlan {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let v3 = matches!(self.schema_version.as_str(), STUDY_EXECUTION_PLAN_SCHEMA | STUDY_EXECUTION_PLAN_SCHEMA_V4);
        let mut steps = Vec::with_capacity(self.steps.len());
        for step in &self.steps {
            if self.schema_version != STUDY_EXECUTION_PLAN_SCHEMA_V4 && matches!(step.kind, StudyStepKind::ClosedLoopInspection { .. }) {
                return Err(serde::ser::Error::custom("closed-loop operation requires study_execution_plan.v4"));
            }
            if !v3 && !step.completion_dependencies.is_empty() {
                return Err(serde::ser::Error::custom(
                    "completion dependencies require study_execution_plan.v3",
                ));
            }
            let mut value = serde_json::to_value(step).map_err(serde::ser::Error::custom)?;
            if v3 {
                value
                    .as_object_mut()
                    .expect("lowered step serializes as object")
                    .insert(
                        "completion_dependencies".into(),
                        serde_json::to_value(&step.completion_dependencies)
                            .map_err(serde::ser::Error::custom)?,
                    );
            }
            steps.push(value);
        }
        StudyExecutionPlanWire {
            schema_version: self.schema_version.clone(),
            study_id: self.study_id.clone(),
            study_revision: self.study_revision,
            study_plan_sha256: self.study_plan_sha256.clone(),
            topological_order: self.topological_order.clone(),
            steps,
        }
        .serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for StudyExecutionPlan {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let wire = StudyExecutionPlanWire::deserialize(deserializer)?;
        let v3 = matches!(wire.schema_version.as_str(), STUDY_EXECUTION_PLAN_SCHEMA | STUDY_EXECUTION_PLAN_SCHEMA_V4);
        if !v3
            && wire.schema_version != STUDY_EXECUTION_PLAN_SCHEMA_V1
            && wire.schema_version != STUDY_EXECUTION_PLAN_SCHEMA_V2
        {
            return Err(D::Error::custom("unsupported study execution plan schema"));
        }
        let mut steps = Vec::with_capacity(wire.steps.len());
        for value in wire.steps {
            if wire.schema_version != STUDY_EXECUTION_PLAN_SCHEMA_V4 && value.pointer("/kind/kind").and_then(serde_json::Value::as_str) == Some("closed_loop_inspection") {
                return Err(D::Error::custom("closed-loop operation requires study_execution_plan.v4"));
            }
            let field = value.get("completion_dependencies");
            if (v3 && !field.is_some_and(serde_json::Value::is_array)) || (!v3 && field.is_some()) {
                return Err(D::Error::custom("completion_dependencies must be present as an array only in study_execution_plan.v3"));
            }
            steps.push(serde_json::from_value(value).map_err(D::Error::custom)?);
        }
        Ok(Self {
            schema_version: wire.schema_version,
            study_id: wire.study_id,
            study_revision: wire.study_revision,
            study_plan_sha256: wire.study_plan_sha256,
            topological_order: wire.topological_order,
            steps,
        })
    }
}

impl StudyExecutionPlan {
    pub fn validate(&self) -> Result<(), StudyLoweringError> {
        let is_legacy_v1 = self.schema_version == STUDY_EXECUTION_PLAN_SCHEMA_V1;
        if !is_legacy_v1
            && self.schema_version != STUDY_EXECUTION_PLAN_SCHEMA_V2
            && self.schema_version != STUDY_EXECUTION_PLAN_SCHEMA
            && self.schema_version != STUDY_EXECUTION_PLAN_SCHEMA_V4
        {
            return Err(StudyLoweringError::Contract(format!(
                "schema_version must be {STUDY_EXECUTION_PLAN_SCHEMA_V1}, {STUDY_EXECUTION_PLAN_SCHEMA_V2} or {STUDY_EXECUTION_PLAN_SCHEMA}"
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
        let positions = self
            .steps
            .iter()
            .enumerate()
            .map(|(index, step)| (step.step_id.as_str(), index))
            .collect::<std::collections::BTreeMap<_, _>>();
        if positions.len() != self.steps.len() {
            return Err(StudyLoweringError::Contract(
                "duplicate lowered step ID".into(),
            ));
        }
        for (index, step) in self.steps.iter().enumerate() {
            if self.topological_order.get(index) != Some(&step.step_id) {
                return Err(StudyLoweringError::Contract(
                    "topological_order does not match lowered step order".into(),
                ));
            }
            if !matches!(self.schema_version.as_str(), STUDY_EXECUTION_PLAN_SCHEMA | STUDY_EXECUTION_PLAN_SCHEMA_V4)
                && !step.completion_dependencies.is_empty()
            {
                return Err(StudyLoweringError::Contract(
                    "completion dependencies require study_execution_plan.v3".into(),
                ));
            }
            let mut completion_ids = std::collections::BTreeSet::new();
            for dependency in &step.completion_dependencies {
                if !completion_ids.insert(dependency) {
                    return Err(StudyLoweringError::Contract(
                        "duplicate completion dependency".into(),
                    ));
                }
            }
            let group_edges = match &step.kind {
                StudyStepKind::Group { child_step_ids } => child_step_ids.as_slice(),
                _ => &[],
            };
            let input_edges = step.inputs.iter().filter_map(|input| match &input.source {
                fullmag_authoring::StudyInputSource::StepOutput { step_id, .. } => Some(step_id),
                _ => None,
            });
            for dependency in step
                .completion_dependencies
                .iter()
                .chain(group_edges.iter())
                .chain(input_edges)
            {
                let position = positions.get(dependency.as_str()).ok_or_else(|| {
                    StudyLoweringError::Contract("unknown lowered dependency".into())
                })?;
                if *position >= index {
                    return Err(StudyLoweringError::Contract(
                        "lowered union DAG violates topological order".into(),
                    ));
                }
                if step.enabled
                    && step.completion_dependencies.contains(dependency)
                    && !self.steps[*position].enabled
                {
                    return Err(StudyLoweringError::Contract(
                        "enabled completion dependency targets a disabled step".into(),
                    ));
                }
            }
            if let StudyStepKind::ClosedLoopInspection { stage_id, port_mode_id, .. } = &step.kind {
                if self.schema_version != STUDY_EXECUTION_PLAN_SCHEMA_V4 || step.until_seconds.is_some() || !step.inputs.is_empty() {
                    return Err(StudyLoweringError::Contract("closed-loop operation requires v4 without horizon or state ports".into()));
                }
                if step.enabled && !matches!(step.execution_plan.as_ref().map(|p| &p.backend_plan), Some(fullmag_ir::BackendPlanIR::AntennaFieldOnly(p)) if &p.stage_id == stage_id && &p.port_mode_id == port_mode_id) {
                    return Err(StudyLoweringError::Contract("closed-loop operation lacks its exact field-only carrier".into()));
                }
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
            if let StudyStepKind::ClosedLoopInspection { stage_id, port_mode_id, output_id } = &step.kind {
                validate_closed_loop_operation(&problem, stage_id, port_mode_id, output_id)?;
            }
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
            completion_dependencies: step.completion_dependencies.clone(),
            outputs: step.outputs.clone(),
            acceptance: step.acceptance.clone(),
            acquisition: step.acquisition,
            execution_plan,
        });
    }

    let result = StudyExecutionPlan {
        schema_version: if study.schema_version == fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION_V4 {
            STUDY_EXECUTION_PLAN_SCHEMA_V4
        } else if study.schema_version == fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION {
            STUDY_EXECUTION_PLAN_SCHEMA
        } else {
            STUDY_EXECUTION_PLAN_SCHEMA_V2
        }
        .into(),
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

/// Replan the typed physical operation; a carrier alone cannot choose inspection vs basis.
pub fn validate_closed_loop_operation(problem: &ProblemIR, stage_id: &str, port_mode_id: &str, output_id: &str) -> Result<crate::AntennaFieldSolveExecutionPlan, StudyLoweringError> {
    if !matches!(problem.study, fullmag_ir::StudyIR::FieldOnly { .. }) {
        return Err(StudyLoweringError::Contract("closed-loop inspection requires FieldOnly without magnetic state".into()));
    }
    let carrier = lower_problem_plan(problem).map_err(|error| StudyLoweringError::Planner { step_id: stage_id.into(), reasons: error.reasons })?;
    if !matches!(&carrier.backend_plan, fullmag_ir::BackendPlanIR::AntennaFieldOnly(plan) if plan.stage_id == stage_id && plan.port_mode_id == port_mode_id) {
        return Err(StudyLoweringError::Contract("closed-loop operation differs from its selected field-only carrier".into()));
    }
    let operation = crate::plan_antenna_field_solve_execution(problem, stage_id, port_mode_id).map_err(|error| StudyLoweringError::Planner { step_id: stage_id.into(), reasons: error.reasons })?;
    if !matches!(&operation, crate::AntennaFieldSolveExecutionPlan::ClosedLoopInspection { output_id: selected, .. } if selected == output_id) {
        return Err(StudyLoweringError::Contract("closed-loop operation cannot select external-lead or qualified basis".into()));
    }
    Ok(operation)
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
        assert_eq!(lowered.schema_version, STUDY_EXECUTION_PLAN_SCHEMA_V2);
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
            "schema_version": fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION_V2,
            "study_id": "study:unsupported",
            "revision": 1,
            "steps": [{
                "step_id": "step:future",
                "label": "Future",
                "kind": {"kind": "future_solver"},
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

    fn completion_study() -> StudyPlan {
        let mut plan = study();
        plan.schema_version = fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION.into();
        let mut next = plan.steps[0].clone();
        next.step_id = "next".into();
        next.completion_dependencies = vec![plan.steps[0].step_id.clone()];
        plan.steps.push(next);
        plan
    }

    #[test]
    fn completion_lowering_preserves_edges_and_v3_wire() {
        let study = completion_study();
        let lowered = lower_study_plan(&study, |_| {
            Ok::<_, &'static str>(ProblemIR::bootstrap_example())
        })
        .unwrap();
        assert_eq!(lowered.schema_version, STUDY_EXECUTION_PLAN_SCHEMA);
        assert_eq!(lowered.steps[1].completion_dependencies, vec!["step:run"]);
        let wire = serde_json::to_value(&lowered).unwrap();
        assert_eq!(wire["steps"][0]["completion_dependencies"], json!([]));
        assert_eq!(
            serde_json::from_value::<StudyExecutionPlan>(wire).unwrap(),
            lowered
        );
        let mut changed = study;
        changed.steps[1].completion_dependencies.clear();
        assert_ne!(
            changed.canonical_sha256().unwrap(),
            lowered.study_plan_sha256
        );
    }

    #[test]
    fn completion_lowered_wire_refuses_legacy_presence_and_v3_missing_null() {
        let legacy = lower_study_plan(&study(), |_| {
            Ok::<_, &'static str>(ProblemIR::bootstrap_example())
        })
        .unwrap();
        let wire = serde_json::to_value(&legacy).unwrap();
        assert!(wire["steps"][0].get("completion_dependencies").is_none());
        for version in [
            STUDY_EXECUTION_PLAN_SCHEMA_V1,
            STUDY_EXECUTION_PLAN_SCHEMA_V2,
        ] {
            for dependency in [json!([]), json!(null), json!(["source"])] {
                let mut invalid = wire.clone();
                invalid["schema_version"] = json!(version);
                invalid["steps"][0]["completion_dependencies"] = dependency;
                assert!(serde_json::from_value::<StudyExecutionPlan>(invalid).is_err());
            }
        }
        let lowered = lower_study_plan(&completion_study(), |_| {
            Ok::<_, &'static str>(ProblemIR::bootstrap_example())
        })
        .unwrap();
        let wire = serde_json::to_value(lowered).unwrap();
        let mut missing = wire.clone();
        missing["steps"][0]
            .as_object_mut()
            .unwrap()
            .remove("completion_dependencies");
        assert!(serde_json::from_value::<StudyExecutionPlan>(missing).is_err());
        let mut null = wire;
        null["steps"][0]["completion_dependencies"] = json!(null);
        assert!(serde_json::from_value::<StudyExecutionPlan>(null).is_err());
    }

    #[test]
    fn completion_lowered_validation_rejects_reordered_duplicate_and_unknown_edges() {
        let original = lower_study_plan(&completion_study(), |_| {
            Ok::<_, &'static str>(ProblemIR::bootstrap_example())
        })
        .unwrap();
        let mut invalid = original.clone();
        invalid.steps[0].completion_dependencies = vec!["next".into()];
        assert!(invalid.validate().is_err());
        let mut invalid = original.clone();
        invalid.steps[1]
            .completion_dependencies
            .push("step:run".into());
        assert!(invalid.validate().is_err());
        let mut invalid = original.clone();
        invalid.steps[1].completion_dependencies = vec!["missing".into()];
        assert!(invalid.validate().is_err());
        let mut invalid = original;
        invalid.steps[0].enabled = false;
        invalid.steps[0].status = StudyStepLoweringStatus::Disabled;
        invalid.steps[0].execution_plan = None;
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn completion_disabled_source_blocks_before_resolver() {
        let mut study = completion_study();
        study.steps[0].enabled = false;
        let mut calls = 0;
        assert!(lower_study_plan(&study, |_| {
            calls += 1;
            Ok::<_, &'static str>(ProblemIR::bootstrap_example())
        })
        .is_err());
        assert_eq!(calls, 0);
    }
    #[test]
    fn inspection_cannot_lower_through_time_evolution_placeholder() {
        let mut study=study();study.schema_version=fullmag_authoring::STUDY_PLAN_SCHEMA_VERSION_V4.into();
        study.steps[0].until_seconds=None;
        study.steps[0].kind=StudyStepKind::ClosedLoopInspection{stage_id:"stage".into(),port_mode_id:"port".into(),output_id:"output".into()};
        study.steps[0].outputs=vec![fullmag_authoring::StudyOutputPort{port_id:"inspection".into(),data_kind:fullmag_authoring::StudyPortDataKind::Artifact}];
        assert!(lower_study_plan(&study, |_|Ok::<_,&'static str>(ProblemIR::bootstrap_example())).is_err());
    }
    #[test]
    fn legacy_lowered_wire_refuses_closed_loop_operation_kind() {
        let lowered=lower_study_plan(&study(), |_|Ok::<_,&'static str>(ProblemIR::bootstrap_example())).unwrap();
        let mut value=serde_json::to_value(lowered).unwrap();
        value["steps"][0]["kind"]=serde_json::json!({"kind":"closed_loop_inspection","stage_id":"stage","port_mode_id":"port","output_id":"output"});
        assert!(serde_json::from_value::<StudyExecutionPlan>(value).is_err());
    }

}
