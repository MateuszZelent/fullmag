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
use fullmag_ir::{ComputeResourcesIR, ExecutionDevice, MaterializedExecutionRequestIR, ProblemIR};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

use super::study_lowering::{lower_study_plan, StudyExecutionPlan, StudyLoweringError};

pub const STUDY_PROBLEM_CATALOG_SCHEMA_V1: &str = "study_problem_catalog.v1";
pub const STUDY_PROBLEM_CATALOG_SCHEMA: &str = "study_problem_catalog.v2";
pub const STUDY_PROBLEM_CATALOG_SCHEMA_V3: &str = "study_problem_catalog.v3";
pub const CAPTURED_STUDY_INPUT_IDENTITY_SCHEMA_V1: &str = "captured_study_input.v1";

/// Immutable identity for one fully captured, already-bound ProblemIR.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CapturedStudyInputIdentity {
    pub source_id: String,
    pub schema: String,
    pub problem_sha256: String,
}

/// Stable references derived from one exact captured ProblemIR.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedStudyInputReferences {
    pub model: StudyModelReference,
    pub solver_config: StudySolverConfigReference,
    pub discretization: StudyDiscretizationReference,
    pub identity: CapturedStudyInputIdentity,
}

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    execution_materialization: Option<MaterializedExecutionRequestIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    captured_input_identity: Option<CapturedStudyInputIdentity>,
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
            execution_materialization: None,
            captured_input_identity: None,
        }
    }

    /// Capture a profile snapshot produced by the application resolver.
    /// Catalog validation binds it to this step and its effective ProblemIR;
    /// the application replays it before accepting or loading a run.
    pub fn from_materialized_step(
        step: &StudyStep,
        problem: ProblemIR,
        execution_materialization: MaterializedExecutionRequestIR,
    ) -> Self {
        let mut entry = Self::from_step(step, problem);
        entry.execution_materialization = Some(execution_materialization);
        entry
    }

    /// Capture an already-bound ProblemIR and its profile materialization as
    /// an immutable v3 catalog input.
    pub fn from_captured_materialized_step(
        step: &StudyStep,
        problem: ProblemIR,
        execution_materialization: MaterializedExecutionRequestIR,
        identity: CapturedStudyInputIdentity,
    ) -> Result<Self, StudyCatalogError> {
        let mut entry = Self::from_materialized_step(step, problem, execution_materialization);
        entry.captured_input_identity = Some(identity);
        entry.validate_captured_input_identity(STUDY_PROBLEM_CATALOG_SCHEMA_V3)?;
        entry.validate_execution_materialization(STUDY_PROBLEM_CATALOG_SCHEMA_V3)?;
        if let Err(reasons) = entry.problem.validate() {
            return Err(StudyCatalogError::InvalidProblem {
                step_id: entry.step_id.clone(),
                reasons,
            });
        }
        Ok(entry)
    }

    pub fn step_id(&self) -> &str {
        &self.step_id
    }

    pub fn problem(&self) -> &ProblemIR {
        &self.problem
    }

    pub fn execution_materialization(&self) -> Option<&MaterializedExecutionRequestIR> {
        self.execution_materialization.as_ref()
    }

    pub fn captured_input_identity(&self) -> Option<&CapturedStudyInputIdentity> {
        self.captured_input_identity.as_ref()
    }

    fn validate_captured_input_identity(&self, schema: &str) -> Result<(), StudyCatalogError> {
        let mismatch = |reason: &str| {
            StudyCatalogError::Contract(format!(
                "study step `{}` captured input identity: {reason}",
                self.step_id
            ))
        };
        let Some(identity) = &self.captured_input_identity else {
            return if schema == STUDY_PROBLEM_CATALOG_SCHEMA_V3 {
                Err(mismatch(
                    "v3 requires a captured input identity for every step",
                ))
            } else {
                Ok(())
            };
        };
        if schema != STUDY_PROBLEM_CATALOG_SCHEMA_V3 {
            return Err(mismatch("v1/v2 cannot carry captured input identity"));
        }
        if identity.schema != CAPTURED_STUDY_INPUT_IDENTITY_SCHEMA_V1 {
            return Err(mismatch("unsupported captured input identity schema"));
        }

        let references = capture_study_input_references(&identity.source_id, &self.problem)?;
        if references.identity != *identity {
            return Err(mismatch("ProblemIR bytes differ from the captured digest"));
        }
        ensure_reference(
            &self.step_id,
            "captured_model",
            &self.model,
            &references.model,
        )?;
        ensure_reference(
            &self.step_id,
            "captured_solver_config",
            &self.solver_config,
            &references.solver_config,
        )?;
        ensure_reference(
            &self.step_id,
            "captured_discretization",
            &self.discretization,
            &references.discretization,
        )?;
        Ok(())
    }

    fn validate_execution_materialization(&self, schema: &str) -> Result<(), StudyCatalogError> {
        let mismatch = |reason: &str| {
            StudyCatalogError::Contract(format!(
                "study step `{}` execution materialization: {reason}",
                self.step_id
            ))
        };
        let Some(snapshot) = &self.execution_materialization else {
            return match schema {
                STUDY_PROBLEM_CATALOG_SCHEMA_V1 => Ok(()),
                STUDY_PROBLEM_CATALOG_SCHEMA_V3 => Err(mismatch(
                    "v3 requires a pinned profile snapshot for every step",
                )),
                _ => Err(mismatch(
                    "v2 requires a pinned profile snapshot for every step",
                )),
            };
        };
        if schema == STUDY_PROBLEM_CATALOG_SCHEMA_V1 {
            return Err(mismatch("v1 cannot carry v2 execution provenance"));
        }
        if schema != STUDY_PROBLEM_CATALOG_SCHEMA && schema != STUDY_PROBLEM_CATALOG_SCHEMA_V3 {
            return Err(mismatch(
                "unsupported catalog schema for execution provenance",
            ));
        }
        snapshot
            .validate_shape()
            .map_err(|reason| mismatch(&reason))?;
        let profile = snapshot
            .profile
            .as_ref()
            .ok_or_else(|| mismatch("profile snapshot is missing"))?;
        profile.validate().map_err(|reason| mismatch(&reason))?;
        let profile_sha256 = profile
            .canonical_sha256()
            .map_err(|reason| mismatch(&reason))?;
        if snapshot.profile_sha256.as_deref() != Some(profile_sha256.as_str()) {
            return Err(mismatch("profile content differs from its pinned hash"));
        }
        if profile.profile_id != self.execution_profile.profile_id
            || profile.version != self.execution_profile.version
        {
            return Err(mismatch(
                "profile id/version differs from the step reference",
            ));
        }
        let requested = &snapshot.requested;
        if requested.backend != self.problem.backend_policy.requested_backend
            || requested.precision != self.problem.backend_policy.execution_precision
            || requested.mode != self.problem.validation_profile.execution_mode
        {
            return Err(mismatch(
                "backend/precision/mode differs from immutable ProblemIR",
            ));
        }
        let selection = self
            .problem
            .problem_meta
            .runtime_metadata
            .get("runtime_selection");
        let device = match selection {
            None => ExecutionDevice::Auto,
            Some(value) => {
                let object = value
                    .as_object()
                    .ok_or_else(|| mismatch("runtime_selection must be an object"))?;
                match object.get("device").and_then(serde_json::Value::as_str) {
                    None if !object.contains_key("device") => ExecutionDevice::Auto,
                    Some("auto") => ExecutionDevice::Auto,
                    Some("cpu") => ExecutionDevice::Cpu,
                    Some("gpu" | "cuda") => ExecutionDevice::Gpu,
                    _ => return Err(mismatch("runtime_selection.device is invalid")),
                }
            }
        };
        if requested.device != device {
            return Err(mismatch("device differs from immutable ProblemIR"));
        }
        let resources = ComputeResourcesIR::from_problem(&self.problem)
            .map_err(|reason| mismatch(&reason))?
            .ok_or_else(|| mismatch("ProblemIR has no materialized compute_resources"))?;
        if requested.resources != resources {
            return Err(mismatch("resources differ from immutable ProblemIR"));
        }
        Ok(())
    }
}

pub fn capture_study_input_references(
    source_id: &str,
    problem: &ProblemIR,
) -> Result<CapturedStudyInputReferences, StudyCatalogError> {
    if source_id.is_empty()
        || source_id.len() > 256
        || source_id
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(StudyCatalogError::Contract(
            "captured study input source_id must be nonempty, at most 256 UTF-8 bytes, and contain no whitespace or control characters".into(),
        ));
    }
    let value = serde_json::to_value(problem).map_err(|error| {
        StudyCatalogError::Contract(format!("captured ProblemIR serialization failed: {error}"))
    })?;
    let problem_sha256 = fullmag_ir::canonical_ir_json_sha256(&value).map_err(|error| {
        StudyCatalogError::Contract(format!(
            "captured ProblemIR canonicalization failed: {error}"
        ))
    })?;
    let version = format!("sha256:{problem_sha256}");

    Ok(CapturedStudyInputReferences {
        model: StudyModelReference {
            model_id: format!("captured-model:{source_id}"),
            version: version.clone(),
        },
        solver_config: StudySolverConfigReference {
            preset_id: format!("captured-solver:{source_id}"),
            version: version.clone(),
        },
        discretization: StudyDiscretizationReference {
            recipe_id: format!("captured-discretization:{source_id}"),
            version,
        },
        identity: CapturedStudyInputIdentity {
            source_id: source_id.to_string(),
            schema: CAPTURED_STUDY_INPUT_IDENTITY_SCHEMA_V1.to_string(),
            problem_sha256,
        },
    })
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
            schema_version: schema_version_for_entries(&entries).to_string(),
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

    /// Derive a case-local study and catalog with explicitly replaced
    /// ProblemIR snapshots. Captured references are recomputed from each
    /// replacement while the catalog schema and execution profile snapshots
    /// remain unchanged. Replaced v1/v2 entries require a stable source ID in
    /// `captured_source_ids`; v3 entries keep the source ID already captured.
    pub fn with_problem_replacements(
        &self,
        study: &StudyPlan,
        replacements: &BTreeMap<String, ProblemIR>,
        captured_source_ids: &BTreeMap<String, String>,
    ) -> Result<(StudyPlan, Self), StudyCatalogError> {
        self.validate_for(study)?;

        let step_indexes = study
            .steps
            .iter()
            .enumerate()
            .filter(|(_, step)| step.enabled)
            .map(|(index, step)| (step.step_id.clone(), index))
            .collect::<BTreeMap<_, _>>();
        for step_id in replacements.keys() {
            if !step_indexes.contains_key(step_id) {
                return Err(StudyCatalogError::Contract(format!(
                    "replacement step `{step_id}` is unknown or disabled in the study"
                )));
            }
        }
        for step_id in captured_source_ids.keys() {
            if !replacements.contains_key(step_id) {
                return Err(StudyCatalogError::Contract(format!(
                    "captured source_id was supplied without a ProblemIR replacement for step `{step_id}`"
                )));
            }
        }

        let mut derived_study = study.clone();
        let mut derived_catalog = self.clone();
        for (step_id, problem) in replacements {
            if let Err(reasons) = problem.validate() {
                return Err(StudyCatalogError::InvalidProblem {
                    step_id: step_id.clone(),
                    reasons,
                });
            }

            let entry_index = derived_catalog
                .entries
                .iter()
                .position(|entry| entry.step_id == *step_id)
                .ok_or_else(|| StudyCatalogError::MissingStep {
                    step_id: step_id.clone(),
                })?;
            let entry = &derived_catalog.entries[entry_index];
            let source_id = match &entry.captured_input_identity {
                Some(identity) => {
                    if let Some(provided_source_id) = captured_source_ids.get(step_id) {
                        if provided_source_id != &identity.source_id {
                            return Err(StudyCatalogError::Contract(format!(
                                "captured source_id for v3 step `{step_id}` must preserve the catalog identity"
                            )));
                        }
                    }
                    identity.source_id.clone()
                }
                None => captured_source_ids.get(step_id).cloned().ok_or_else(|| {
                    StudyCatalogError::Contract(format!(
                        "replacement for step `{step_id}` requires a stable captured source_id"
                    ))
                })?,
            };
            let references = capture_study_input_references(&source_id, problem)?;

            let study_step_index = step_indexes[step_id];
            let study_step = &mut derived_study.steps[study_step_index];
            study_step.model = references.model.clone();
            study_step.solver_config = references.solver_config.clone();
            study_step.discretization = references.discretization.clone();

            let entry = &mut derived_catalog.entries[entry_index];
            entry.model = references.model;
            entry.solver_config = references.solver_config;
            entry.discretization = references.discretization;
            entry.problem = problem.clone();
            if entry.captured_input_identity.is_some() {
                entry.captured_input_identity = Some(references.identity);
            }
        }

        derived_catalog.study_id = derived_study.study_id.clone();
        derived_catalog.study_revision = derived_study.revision;
        derived_catalog.study_plan_sha256 = derived_study
            .canonical_sha256()
            .map_err(|error| StudyCatalogError::Contract(error.to_string()))?;
        derived_catalog.validate_for(&derived_study)?;
        Ok((derived_study, derived_catalog))
    }

    /// Check that this catalog is still bound to the exact study bytes and
    /// contains exactly the enabled executable steps.
    pub fn validate_for(&self, study: &StudyPlan) -> Result<(), StudyCatalogError> {
        study
            .validate_for_execution()
            .map_err(|error| StudyCatalogError::Contract(error.to_string()))?;
        if self.schema_version != STUDY_PROBLEM_CATALOG_SCHEMA
            && self.schema_version != STUDY_PROBLEM_CATALOG_SCHEMA_V1
            && self.schema_version != STUDY_PROBLEM_CATALOG_SCHEMA_V3
        {
            return Err(StudyCatalogError::Contract(format!(
                "schema_version must be {STUDY_PROBLEM_CATALOG_SCHEMA_V1}, {STUDY_PROBLEM_CATALOG_SCHEMA}, or {STUDY_PROBLEM_CATALOG_SCHEMA_V3}"
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
            entry.validate_captured_input_identity(&self.schema_version)?;
            entry.validate_execution_materialization(&self.schema_version)?;
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
        if self.schema_version != STUDY_PROBLEM_CATALOG_SCHEMA_V1
            && self.schema_version != STUDY_PROBLEM_CATALOG_SCHEMA
            && self.schema_version != STUDY_PROBLEM_CATALOG_SCHEMA_V3
        {
            return Err(StudyCatalogError::Contract(format!(
                "unsupported study problem catalog schema `{}`",
                self.schema_version
            )));
        }
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
        entry.validate_captured_input_identity(&self.schema_version)?;
        if self.schema_version == STUDY_PROBLEM_CATALOG_SCHEMA_V3 {
            entry.validate_execution_materialization(&self.schema_version)?;
            if let Err(reasons) = entry.problem.validate() {
                return Err(StudyCatalogError::InvalidProblem {
                    step_id: entry.step_id.clone(),
                    reasons,
                });
            }
        }
        Ok(entry.problem.clone())
    }
}

fn schema_version_for_entries(entries: &[StudyProblemCatalogEntry]) -> &'static str {
    if entries
        .iter()
        .any(|entry| entry.captured_input_identity.is_some())
    {
        STUDY_PROBLEM_CATALOG_SCHEMA_V3
    } else if entries
        .iter()
        .any(|entry| entry.execution_materialization.is_some())
    {
        STUDY_PROBLEM_CATALOG_SCHEMA
    } else {
        STUDY_PROBLEM_CATALOG_SCHEMA_V1
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
    use fullmag_ir::{
        ComputeResourcesIR, ExecutionDevice, ExecutionProfileIR, ExecutionRequestIR,
        MaterializedExecutionRequestIR, EXECUTION_REQUEST_SCHEMA,
    };
    use serde_json::json;
    use std::collections::BTreeMap;

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

    fn captured_entry() -> StudyProblemCatalogEntry {
        let plan = study();
        let problem = ProblemIR::bootstrap_example();
        let references = capture_study_input_references("scene:document:42", &problem).unwrap();
        let mut entry = StudyProblemCatalogEntry::from_step(&plan.steps[0], problem);
        entry.model = references.model;
        entry.solver_config = references.solver_config;
        entry.discretization = references.discretization;
        entry.captured_input_identity = Some(references.identity);
        entry
    }

    fn materialized_problem() -> ProblemIR {
        let mut problem = ProblemIR::bootstrap_example();
        problem.problem_meta.runtime_metadata.insert(
            "compute_resources".into(),
            serde_json::to_value(ComputeResourcesIR::default()).unwrap(),
        );
        problem
    }

    fn materialization(
        step: &StudyStep,
        problem: &ProblemIR,
    ) -> MaterializedExecutionRequestIR {
        let profile = ExecutionProfileIR {
            profile_id: step.execution_profile.profile_id.clone(),
            version: step.execution_profile.version.clone(),
            ..ExecutionProfileIR::default()
        };
        MaterializedExecutionRequestIR {
            schema_version: EXECUTION_REQUEST_SCHEMA.into(),
            profile_sha256: Some(profile.canonical_sha256().unwrap()),
            profile: Some(profile),
            layers: Vec::new(),
            requested: ExecutionRequestIR {
                backend: problem.backend_policy.requested_backend,
                device: ExecutionDevice::Auto,
                precision: problem.backend_policy.execution_precision,
                mode: problem.validation_profile.execution_mode,
                resources: ComputeResourcesIR::from_problem(problem)
                    .unwrap()
                    .unwrap(),
            },
            origins: BTreeMap::new(),
        }
    }

    fn replacement_problem() -> ProblemIR {
        let mut problem = materialized_problem();
        problem.problem_meta.description = Some("Case-local replacement.".into());
        problem
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
        assert_eq!(catalog.schema_version, STUDY_PROBLEM_CATALOG_SCHEMA_V1);
        let legacy_value = serde_json::to_value(&catalog).unwrap();
        assert!(legacy_value["entries"][0]
            .get("execution_materialization")
            .is_none());
        assert!(legacy_value["entries"][0]
            .get("captured_input_identity")
            .is_none());
        let decoded: StudyProblemCatalog = serde_json::from_value(legacy_value.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), legacy_value);

        let mut unmaterialized_v2 = catalog;
        unmaterialized_v2.schema_version = STUDY_PROBLEM_CATALOG_SCHEMA.into();
        assert!(unmaterialized_v2
            .validate_for(&study)
            .unwrap_err()
            .to_string()
            .contains("v2 requires"));
    }

    #[test]
    fn catalog_rejects_missing_enabled_snapshot() {
        let study = study();
        let error = StudyProblemCatalog::from_entries(&study, Vec::new()).unwrap_err();
        assert!(matches!(error, StudyCatalogError::MissingStep { .. }));
    }

    #[test]
    fn captured_references_share_a_deterministic_complete_problem_digest() {
        let problem = ProblemIR::bootstrap_example();
        let first = capture_study_input_references("scene:document:42", &problem).unwrap();
        let second = capture_study_input_references("scene:document:42", &problem).unwrap();
        let version = format!("sha256:{}", first.identity.problem_sha256);

        assert_eq!(first, second);
        assert_eq!(
            first.identity.schema,
            CAPTURED_STUDY_INPUT_IDENTITY_SCHEMA_V1
        );
        assert_eq!(first.model.model_id, "captured-model:scene:document:42");
        assert_eq!(
            first.solver_config.preset_id,
            "captured-solver:scene:document:42"
        );
        assert_eq!(
            first.discretization.recipe_id,
            "captured-discretization:scene:document:42"
        );
        assert_eq!(first.model.version, version);
        assert_eq!(first.solver_config.version, version);
        assert_eq!(first.discretization.version, version);
    }

    #[test]
    fn captured_identity_rejects_a_selection_only_change() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/runtime/antenna-standalone-pipeline.json"
        )).unwrap();
        let mut problem: ProblemIR = serde_json::from_value(fixture["ir"].clone()).unwrap();
        let mut second = problem.antenna_field_solve_stages[0].clone();
        second.id = "second-definition".into();
        problem.antenna_field_solve_stages.push(second);
        let fullmag_ir::StudyIR::AntennaFieldSolve { selection, .. } = &mut problem.study else { unreachable!() };
        *selection = Some(fullmag_ir::AntennaFieldSolveSelectionIR { stage_id: "inspect_antenna".into(), port_mode_id: "port".into() });
        let references = capture_study_input_references("source", &problem).unwrap();
        let mut entry = StudyProblemCatalogEntry::from_step(&study().steps[0], problem);
        entry.model = references.model;
        entry.solver_config = references.solver_config;
        entry.discretization = references.discretization;
        entry.captured_input_identity = Some(references.identity.clone());
        entry.validate_captured_input_identity(STUDY_PROBLEM_CATALOG_SCHEMA_V3).unwrap();
        let before = serde_json::to_value(&entry.problem).unwrap();
        let fullmag_ir::StudyIR::AntennaFieldSolve { selection: Some(selection), .. } = &mut entry.problem.study else { unreachable!() };
        selection.stage_id = "second-definition".into();
        let changed = capture_study_input_references("source", &entry.problem).unwrap();
        assert_ne!(changed.identity.problem_sha256, references.identity.problem_sha256);
        let mut expected = before;
        expected["study"]["selection"]["stage_id"] = "second-definition".into();
        assert_eq!(serde_json::to_value(&entry.problem).unwrap(), expected);
        assert!(entry.validate_captured_input_identity(STUDY_PROBLEM_CATALOG_SCHEMA_V3)
            .unwrap_err().to_string().contains("ProblemIR bytes differ from the captured digest"));
    }

    #[test]
    fn captured_identity_rejects_changed_problem_bytes_identity_and_references() {
        let mut changed_problem = captured_entry();
        changed_problem
            .problem
            .problem_meta
            .entrypoint_kind
            .push_str("_changed");
        assert!(changed_problem
            .validate_captured_input_identity(STUDY_PROBLEM_CATALOG_SCHEMA_V3)
            .is_err());

        let mut changed_identity = captured_entry();
        changed_identity
            .captured_input_identity
            .as_mut()
            .unwrap()
            .problem_sha256 = "0".repeat(64);
        assert!(changed_identity
            .validate_captured_input_identity(STUDY_PROBLEM_CATALOG_SCHEMA_V3)
            .is_err());

        let mut changed_reference = captured_entry();
        changed_reference.model.version.push_str("-changed");
        assert!(changed_reference
            .validate_captured_input_identity(STUDY_PROBLEM_CATALOG_SCHEMA_V3)
            .is_err());
    }

    #[test]
    fn v3_requires_identity_and_identity_cannot_be_downgraded() {
        let plan = study();
        let legacy_entry =
            StudyProblemCatalogEntry::from_step(&plan.steps[0], ProblemIR::bootstrap_example());
        assert!(legacy_entry
            .validate_captured_input_identity(STUDY_PROBLEM_CATALOG_SCHEMA_V3)
            .is_err());

        let captured = captured_entry();
        assert!(captured
            .validate_captured_input_identity(STUDY_PROBLEM_CATALOG_SCHEMA_V3)
            .is_ok());
        assert!(captured
            .validate_captured_input_identity(STUDY_PROBLEM_CATALOG_SCHEMA)
            .is_err());
        assert!(captured
            .validate_captured_input_identity(STUDY_PROBLEM_CATALOG_SCHEMA_V1)
            .is_err());
        assert!(captured
            .validate_execution_materialization(STUDY_PROBLEM_CATALOG_SCHEMA_V3)
            .unwrap_err()
            .to_string()
            .contains("v3 requires a pinned profile snapshot"));

        assert_eq!(
            schema_version_for_entries(&[captured.clone(), legacy_entry]),
            STUDY_PROBLEM_CATALOG_SCHEMA_V3
        );
    }

    #[test]
    fn v1_problem_replacement_rebinds_references_and_preserves_untouched_entries() {
        let mut plan = study();
        let mut untouched_step = plan.steps[0].clone();
        untouched_step.step_id = "step:untouched".into();
        untouched_step.label = "Untouched".into();
        plan.steps.push(untouched_step);
        let original_problem = ProblemIR::bootstrap_example();
        let original_catalog = StudyProblemCatalog::from_entries(
            &plan,
            vec![
                StudyProblemCatalogEntry::from_step(
                    &plan.steps[0],
                    original_problem.clone(),
                ),
                StudyProblemCatalogEntry::from_step(
                    &plan.steps[1],
                    original_problem,
                ),
            ],
        )
        .unwrap();
        let untouched_entry = original_catalog.entries()[1].clone();
        let replacement = replacement_problem();
        let expected = capture_study_input_references("scene:case:1", &replacement).unwrap();
        let replacements = [("step:run".to_string(), replacement.clone())]
            .into_iter()
            .collect();

        let missing_source_id = original_catalog
            .with_problem_replacements(&plan, &replacements, &BTreeMap::new())
            .unwrap_err();
        assert!(missing_source_id
            .to_string()
            .contains("requires a stable captured source_id"));

        let captured_source_ids = [("step:run".to_string(), "scene:case:1".to_string())]
            .into_iter()
            .collect();
        let (derived_plan, derived_catalog) = original_catalog
            .with_problem_replacements(&plan, &replacements, &captured_source_ids)
            .unwrap();

        assert_eq!(derived_catalog.schema_version, STUDY_PROBLEM_CATALOG_SCHEMA_V1);
        assert_eq!(derived_plan.study_id, plan.study_id);
        assert_eq!(derived_plan.revision, plan.revision);
        assert_eq!(derived_plan.schema_version, plan.schema_version);
        assert_eq!(derived_plan.steps[0].model, expected.model);
        assert_eq!(derived_plan.steps[0].solver_config, expected.solver_config);
        assert_eq!(derived_plan.steps[0].discretization, expected.discretization);
        assert_eq!(derived_catalog.entries()[0].problem(), &replacement);
        assert_eq!(derived_catalog.entries()[0].model, expected.model);
        assert_eq!(derived_catalog.entries()[0].solver_config, expected.solver_config);
        assert_eq!(derived_catalog.entries()[0].discretization, expected.discretization);
        assert!(derived_catalog.entries()[0]
            .captured_input_identity()
            .is_none());
        assert_eq!(derived_catalog.entries()[1], untouched_entry);
        assert_eq!(derived_plan.steps[1], plan.steps[1]);
        assert_ne!(derived_catalog.study_plan_sha256, original_catalog.study_plan_sha256);
    }

    #[test]
    fn v2_problem_replacement_preserves_execution_materialization() {
        let plan = study();
        let original_problem = materialized_problem();
        let original_materialization = materialization(&plan.steps[0], &original_problem);
        let original_catalog = StudyProblemCatalog::from_entries(
            &plan,
            vec![StudyProblemCatalogEntry::from_materialized_step(
                &plan.steps[0],
                original_problem,
                original_materialization.clone(),
            )],
        )
        .unwrap();
        let replacement = replacement_problem();
        let expected = capture_study_input_references("scene:case:2", &replacement).unwrap();
        let replacements = [("step:run".to_string(), replacement.clone())]
            .into_iter()
            .collect();
        let captured_source_ids = [("step:run".to_string(), "scene:case:2".to_string())]
            .into_iter()
            .collect();

        let (derived_plan, derived_catalog) = original_catalog
            .with_problem_replacements(&plan, &replacements, &captured_source_ids)
            .unwrap();

        assert_eq!(derived_catalog.schema_version, STUDY_PROBLEM_CATALOG_SCHEMA);
        assert_eq!(derived_plan.steps[0].model, expected.model);
        assert_eq!(derived_plan.steps[0].solver_config, expected.solver_config);
        assert_eq!(derived_plan.steps[0].discretization, expected.discretization);
        assert_eq!(derived_catalog.entries()[0].problem(), &replacement);
        assert_eq!(
            derived_catalog.entries()[0].execution_materialization(),
            Some(&original_materialization)
        );
        assert!(derived_catalog.entries()[0]
            .captured_input_identity()
            .is_none());
    }

    #[test]
    fn v3_problem_replacement_preserves_source_id_and_recomputes_digest_references() {
        let mut plan = study();
        let source_problem = materialized_problem();
        let source_id = "scene:document:42";
        let source_references = capture_study_input_references(source_id, &source_problem).unwrap();
        plan.steps[0].model = source_references.model.clone();
        plan.steps[0].solver_config = source_references.solver_config.clone();
        plan.steps[0].discretization = source_references.discretization.clone();
        let original_materialization = materialization(&plan.steps[0], &source_problem);
        let entry = StudyProblemCatalogEntry::from_captured_materialized_step(
            &plan.steps[0],
            source_problem,
            original_materialization.clone(),
            source_references.identity,
        )
        .unwrap();
        let original_catalog = StudyProblemCatalog::from_entries(&plan, vec![entry]).unwrap();

        let replacement = replacement_problem();
        let expected = capture_study_input_references(source_id, &replacement).unwrap();
        let replacements = [("step:run".to_string(), replacement.clone())]
            .into_iter()
            .collect();
        let (derived_plan, derived_catalog) = original_catalog
            .with_problem_replacements(&plan, &replacements, &BTreeMap::new())
            .unwrap();

        let identity = derived_catalog.entries()[0]
            .captured_input_identity()
            .unwrap();
        assert_eq!(derived_catalog.schema_version, STUDY_PROBLEM_CATALOG_SCHEMA_V3);
        assert_eq!(identity.source_id, source_id);
        assert_eq!(identity, &expected.identity);
        assert_eq!(derived_plan.steps[0].model, expected.model);
        assert_eq!(derived_plan.steps[0].solver_config, expected.solver_config);
        assert_eq!(derived_plan.steps[0].discretization, expected.discretization);
        assert_eq!(derived_catalog.entries()[0].problem(), &replacement);
        assert_eq!(
            derived_catalog.entries()[0].execution_materialization(),
            Some(&original_materialization)
        );
        assert_ne!(
            identity.problem_sha256,
            original_catalog.entries()[0]
                .captured_input_identity()
                .unwrap()
                .problem_sha256
        );
    }

    #[test]
    fn problem_replacement_rejects_unknown_step_ids() {
        let plan = study();
        let catalog = StudyProblemCatalog::from_entries(
            &plan,
            vec![StudyProblemCatalogEntry::from_step(
                &plan.steps[0],
                ProblemIR::bootstrap_example(),
            )],
        )
        .unwrap();
        let replacements = [("step:missing".to_string(), replacement_problem())]
            .into_iter()
            .collect();

        let error = catalog
            .with_problem_replacements(&plan, &replacements, &BTreeMap::new())
            .unwrap_err();

        assert!(error
            .to_string()
            .contains("replacement step `step:missing` is unknown or disabled"));
    }

    #[test]
    fn captured_source_id_rejects_empty_long_and_whitespace_values() {
        let problem = ProblemIR::bootstrap_example();
        for source_id in ["", "source with spaces", "line\nbreak"] {
            assert!(capture_study_input_references(source_id, &problem).is_err());
        }
        assert!(capture_study_input_references(&"x".repeat(257), &problem).is_err());
    }
}
