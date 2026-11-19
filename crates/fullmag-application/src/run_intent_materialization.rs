//! Prepare immutable submission identity from already compiled authoring inputs.
//! No session, admission, host resolution, filesystem access or solver execution.

use std::collections::BTreeMap;

use anyhow::{Context, Result};
use fullmag_authoring::StudyPlan;
use fullmag_plan::{StudyProblemCatalog, StudyStepLoweringStatus};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    ImmutableAssetReference, ProjectEnvelope, ProjectSnapshot, RequestedExecution, RunDependency,
    RunId, RunIntent, RunSpecification, StudyId, StudyReference,
};

/// Explicit authored values, not a second RunSpec or a persisted document.
/// A retry retains the same run_id and idempotency_key; neither is inferred.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RunIntentAuthoring {
    pub run_id: RunId,
    pub idempotency_key: String,
    pub parameters: Value,
    pub seeds: BTreeMap<String, u64>,
    pub dependencies: Vec<RunDependency>,
    pub scheduling_priority: i32,
    pub requested_execution: RequestedExecution,
}

/// A validated, immutable handoff from final accepted-study materialization
/// to durable RunIntent preparation. Its borrowed inputs cannot be changed
/// while its canonical Study, planner result, and catalog bytes are consumed.
///
/// This type intentionally does not implement Serialize or Deserialize and
/// keeps all fields private. Construct it with
/// [`prepare_run_intent_materialization`].
pub struct PreparedRunIntentMaterialization<'a> {
    definition: &'a ProjectEnvelope,
    study: &'a StudyPlan,
    catalog: &'a StudyProblemCatalog,
    intent: RunIntent,
    execution_plan: fullmag_plan::StudyExecutionPlan,
    study_bytes: Vec<u8>,
    catalog_bytes: Vec<u8>,
}

impl<'a> PreparedRunIntentMaterialization<'a> {
    /// Consume the materialization as typed input for the API persistence
    /// adapter. Only the validating constructor can produce this value.
    pub fn into_parts(
        self,
    ) -> (
        RunIntent,
        &'a ProjectEnvelope,
        &'a StudyPlan,
        &'a StudyProblemCatalog,
        fullmag_plan::StudyExecutionPlan,
        Vec<u8>,
        Vec<u8>,
    ) {
        (
            self.intent,
            self.definition,
            self.study,
            self.catalog,
            self.execution_plan,
            self.study_bytes,
            self.catalog_bytes,
        )
    }

    fn into_intent(self) -> RunIntent {
        self.intent
    }
}

/// Compile the final submission identity without publishing it. Study/ProblemIR
/// compilation and profile lookup precede this boundary. Durable Submit must
/// still validate published profiles and validate_requested_execution against
/// the lowered plan before its first store mutation; this is not readiness.
pub fn materialize_run_intent(
    definition: &ProjectEnvelope,
    study: &StudyPlan,
    catalog: &StudyProblemCatalog,
    authored: RunIntentAuthoring,
    asset_paths: &BTreeMap<String, String>,
) -> Result<RunIntent> {
    prepare_run_intent_materialization(definition, study, catalog, authored, asset_paths)
        .map(|prepared| prepared.into_intent())
}

/// Validate the final immutable accepted inputs and retain the expensive
/// planner and canonical-catalog results for the persistence boundary.
pub fn prepare_run_intent_materialization<'a>(
    definition: &'a ProjectEnvelope,
    study: &'a StudyPlan,
    catalog: &'a StudyProblemCatalog,
    authored: RunIntentAuthoring,
    asset_paths: &BTreeMap<String, String>,
) -> Result<PreparedRunIntentMaterialization<'a>> {
    let snapshot = ProjectSnapshot::from_envelope(definition)?;
    study.validate_for_execution()?;
    for entry in catalog.entries() {
        if let Some(execution) = entry.execution_materialization() {
            crate::validate_execution_materialization(execution)
                .map_err(anyhow::Error::msg)
                .with_context(|| {
                    format!("study step `{}` execution materialization", entry.step_id())
                })?;
        }
    }
    // The canonical lowerer owns the first full catalog validation.
    let planned = fullmag_plan::lower_study_plan_with_catalog(study, catalog)?;
    for step in planned
        .steps
        .iter()
        .filter(|step| step.status == StudyStepLoweringStatus::Planned)
    {
        let entry = catalog
            .entries()
            .iter()
            .find(|entry| entry.step_id() == step.step_id)
            .with_context(|| {
                format!(
                    "planned study step `{}` has no captured input",
                    step.step_id
                )
            })?;
        authored
            .requested_execution
            .for_problem(entry.problem())
            .with_context(|| format!("study step `{}` requested execution", step.step_id))?;
    }
    let study_bytes = study.canonical_json_bytes()?;
    let study_sha256 = format!("{:x}", Sha256::digest(&study_bytes));
    let study_reference = StudyReference {
        study_id: StudyId::parse(study.study_id.clone())?,
        plan_version: study.schema_version.clone(),
        plan_sha256: study_sha256,
    };
    let catalog_value = serde_json::to_value(catalog)?;
    let catalog_bytes = fullmag_ir::canonical_ir_json_bytes(&catalog_value)?;
    let catalog_digest = format!("{:x}", Sha256::digest(&catalog_bytes));
    let mut specification = RunSpecification::new(
        snapshot,
        study_reference,
        catalog_digest,
        authored.parameters,
        authored.requested_execution,
    );
    specification.run_id = authored.run_id;
    specification.seeds = authored.seeds;
    specification.dependencies = authored.dependencies;
    specification.scheduling_priority = authored.scheduling_priority;
    for (asset_id, path) in asset_paths {
        let asset = definition
            .assets
            .iter()
            .find(|asset| asset.path() == path)
            .with_context(|| {
                format!("immutable asset `{asset_id}` path `{path}` is absent from project")
            })?;
        specification
            .immutable_assets
            .push(ImmutableAssetReference {
                asset_id: asset_id.clone(),
                content_sha256: format!("{:x}", Sha256::digest(asset.bytes())),
            });
    }
    let intent = RunIntent::new(authored.idempotency_key, specification);
    intent.validate()?;
    Ok(PreparedRunIntentMaterialization {
        definition,
        study,
        catalog,
        intent,
        execution_plan: planned,
        study_bytes,
        catalog_bytes,
    })
}

#[cfg(test)]
#[path = "run_intent_materialization_tests.rs"]
mod tests;
