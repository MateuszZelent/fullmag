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
use std::collections::BTreeSet;

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
    fn captured_source_id_rejects_empty_long_and_whitespace_values() {
        let problem = ProblemIR::bootstrap_example();
        for source_id in ["", "source with spaces", "line\nbreak"] {
            assert!(capture_study_input_references(source_id, &problem).is_err());
        }
        assert!(capture_study_input_references(&"x".repeat(257), &problem).is_err());
    }
}
