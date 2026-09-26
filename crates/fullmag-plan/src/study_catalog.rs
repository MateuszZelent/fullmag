//! Immutable catalog boundary for executable study steps.
//!
//! A `StudyPlan` contains references, while the planner needs a complete
//! immutable `ProblemIR`.  This module is the explicit bridge between those
//! two contracts.  It intentionally has no `current` lookup or fallback: the
//! caller must provide one validated snapshot for every enabled step.

use fullmag_authoring::{
    StudyDiscretizationReference, StudyExecutionProfileReference, StudyModelReference, StudyPlan,
    StudySolverConfigReference, StudyStep,
};
use fullmag_ir::ProblemIR;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

use super::study_lowering::{lower_study_plan, StudyExecutionPlan, StudyLoweringError};

pub const STUDY_PROBLEM_CATALOG_SCHEMA: &str = "study_problem_catalog.v1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StudyCatalogError {
    Contract(String),
    MissingStep {
        step_id: String,
    },
    DuplicateStep {
        step_id: String,
    },
    ReferenceMismatch {
        step_id: String,
        field: String,
    },
    InvalidProblem {
        step_id: String,
        reasons: Vec<String>,
    },
}

impl std::fmt::Display for StudyCatalogError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Contract(message) => formatter.write_str(message),
            Self::MissingStep { step_id } => {
                write!(
                    formatter,
                    "study catalog has no snapshot for enabled step `{step_id}`"
                )
            }
            Self::DuplicateStep { step_id } => {
                write!(
                    formatter,
                    "study catalog contains duplicate step `{step_id}`"
                )
            }
            Self::ReferenceMismatch { step_id, field } => {
                write!(
                    formatter,
                    "study catalog reference `{field}` does not match step `{step_id}`"
                )
            }
            Self::InvalidProblem { step_id, reasons } => {
                write!(
                    formatter,
                    "ProblemIR snapshot for step `{step_id}` is invalid: {}",
                    reasons.join("; ")
                )
            }
        }
    }
}

impl std::error::Error for StudyCatalogError {}

/// One immutable planner input captured for a specific study step.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StudyProblemCatalogEntry {
    step_id: String,
    model: StudyModelReference,
    solver_config: StudySolverConfigReference,
    discretization: StudyDiscretizationReference,
    execution_profile: StudyExecutionProfileReference,
    problem: ProblemIR,
}

impl StudyProblemCatalogEntry {
    pub fn from_step(step: &StudyStep, problem: ProblemIR) -> Self {
        Self {
            step_id: step.step_id.clone(),
            model: step.model.clone(),
            solver_config: step.solver_config.clone(),
            discretization: step.discretization.clone(),
            execution_profile: step.execution_profile.clone(),
            problem,
        }
    }

    pub fn step_id(&self) -> &str {
        &self.step_id
    }

    pub fn problem(&self) -> &ProblemIR {
        &self.problem
    }
}

/// Versioned immutable snapshots used to lower one exact `StudyPlan`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StudyProblemCatalog {
    pub schema_version: String,
    pub study_id: String,
    pub study_revision: u64,
    pub study_plan_sha256: String,
    entries: Vec<StudyProblemCatalogEntry>,
}

impl StudyProblemCatalog {
    /// Build a catalog from snapshots explicitly resolved by the application
    /// or repository adapter.  The constructor rejects stale, incomplete or
    /// invalid entries before the planner sees them.
    pub fn from_entries(
        study: &StudyPlan,
        entries: Vec<StudyProblemCatalogEntry>,
    ) -> Result<Self, StudyCatalogError> {
        let catalog = Self {
            schema_version: STUDY_PROBLEM_CATALOG_SCHEMA.to_string(),
            study_id: study.study_id.clone(),
            study_revision: study.revision,
            study_plan_sha256: study
                .canonical_sha256()
                .map_err(|error| StudyCatalogError::Contract(error.to_string()))?,
            entries,
        };
        catalog.validate_for(study)?;
        Ok(catalog)
    }

    pub fn entries(&self) -> &[StudyProblemCatalogEntry] {
        &self.entries
    }

    /// Check that this catalog is still bound to the exact study bytes and
    /// contains exactly the enabled executable steps.
    pub fn validate_for(&self, study: &StudyPlan) -> Result<(), StudyCatalogError> {
        study
            .validate_for_execution()
            .map_err(|error| StudyCatalogError::Contract(error.to_string()))?;
        if self.schema_version != STUDY_PROBLEM_CATALOG_SCHEMA {
            return Err(StudyCatalogError::Contract(format!(
                "schema_version must be {STUDY_PROBLEM_CATALOG_SCHEMA}"
            )));
        }
        let expected_digest = study
            .canonical_sha256()
            .map_err(|error| StudyCatalogError::Contract(error.to_string()))?;
        if self.study_id != study.study_id
            || self.study_revision != study.revision
            || self.study_plan_sha256 != expected_digest
        {
            return Err(StudyCatalogError::Contract(
                "study problem catalog is bound to a different study revision or digest".into(),
            ));
        }

        let steps = study
            .steps
            .iter()
            .map(|step| (step.step_id.as_str(), step))
            .collect::<std::collections::BTreeMap<_, _>>();
        let mut seen = BTreeSet::new();
        for entry in &self.entries {
            if !seen.insert(entry.step_id.as_str()) {
                return Err(StudyCatalogError::DuplicateStep {
                    step_id: entry.step_id.clone(),
                });
            }
            let step = steps.get(entry.step_id.as_str()).ok_or_else(|| {
                StudyCatalogError::Contract(format!(
                    "catalog entry `{}` does not exist in the study",
                    entry.step_id
                ))
            })?;
            if !step.enabled {
                return Err(StudyCatalogError::Contract(format!(
                    "disabled step `{}` must not have a ProblemIR snapshot",
                    entry.step_id
                )));
            }
            ensure_reference(&entry.step_id, "model", &entry.model, &step.model)?;
            ensure_reference(
                &entry.step_id,
                "solver_config",
                &entry.solver_config,
                &step.solver_config,
            )?;
            ensure_reference(
                &entry.step_id,
                "discretization",
                &entry.discretization,
                &step.discretization,
            )?;
            ensure_reference(
                &entry.step_id,
                "execution_profile",
                &entry.execution_profile,
                &step.execution_profile,
            )?;
            if let Err(reasons) = entry.problem.validate() {
                return Err(StudyCatalogError::InvalidProblem {
                    step_id: entry.step_id.clone(),
                    reasons,
                });
            }
        }

        for step in study.steps.iter().filter(|step| step.enabled) {
            if !seen.contains(step.step_id.as_str()) {
                return Err(StudyCatalogError::MissingStep {
                    step_id: step.step_id.clone(),
                });
            }
        }
        Ok(())
    }

    pub fn resolve_problem(&self, step: &StudyStep) -> Result<ProblemIR, StudyCatalogError> {
        let entry = self
            .entries
            .iter()
            .find(|entry| entry.step_id == step.step_id)
            .ok_or_else(|| StudyCatalogError::MissingStep {
                step_id: step.step_id.clone(),
            })?;
        ensure_reference(&entry.step_id, "model", &entry.model, &step.model)?;
        ensure_reference(
            &entry.step_id,
            "solver_config",
            &entry.solver_config,
            &step.solver_config,
        )?;
        ensure_reference(
            &entry.step_id,
            "discretization",
            &entry.discretization,
            &step.discretization,
        )?;
        ensure_reference(
            &entry.step_id,
            "execution_profile",
            &entry.execution_profile,
            &step.execution_profile,
        )?;
        Ok(entry.problem.clone())
    }
}

/// Lower a study exclusively from an already validated immutable catalog.
pub fn lower_study_plan_with_catalog(
    study: &StudyPlan,
    catalog: &StudyProblemCatalog,
) -> Result<StudyExecutionPlan, StudyLoweringError> {
    catalog
        .validate_for(study)
        .map_err(|error| StudyLoweringError::Contract(error.to_string()))?;
    lower_study_plan(study, |step| catalog.resolve_problem(step))
}

fn ensure_reference<T: PartialEq>(
    step_id: &str,
    field: &str,
    actual: &T,
    expected: &T,
) -> Result<(), StudyCatalogError> {
    if actual == expected {
        Ok(())
    } else {
        Err(StudyCatalogError::ReferenceMismatch {
            step_id: step_id.to_string(),
            field: field.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_authoring::{
        PrimitiveStageNode, StudyPipelineDocument, StudyPipelineNode, StudyPipelineNodeSource,
        StudyPlanMigrationDefaults, StudyPrimitiveStageKind, StudySolverConfigReference,
    };
    use serde_json::json;

    fn study() -> StudyPlan {
        StudyPlan::from_pipeline(
            "study:catalog",
            3,
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
    fn catalog_binds_exact_study_and_lowers_through_canonical_planner() {
        let study = study();
        let catalog = StudyProblemCatalog::from_entries(
            &study,
            vec![StudyProblemCatalogEntry::from_step(
                &study.steps[0],
                ProblemIR::bootstrap_example(),
            )],
        )
        .unwrap();
        let lowered = lower_study_plan_with_catalog(&study, &catalog).unwrap();
        assert_eq!(lowered.study_plan_sha256, study.canonical_sha256().unwrap());
        assert!(lowered.steps[0].execution_plan.is_some());
    }

    #[test]
    fn catalog_rejects_missing_enabled_snapshot() {
        let study = study();
        let error = StudyProblemCatalog::from_entries(&study, Vec::new()).unwrap_err();
        assert!(matches!(error, StudyCatalogError::MissingStep { .. }));
    }
}
