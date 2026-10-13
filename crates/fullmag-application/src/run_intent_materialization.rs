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
    let snapshot = ProjectSnapshot::from_envelope(definition)?;
    study.validate_for_execution()?;
    catalog.validate_for(study)?;
    for entry in catalog.entries() {
        if let Some(execution) = entry.execution_materialization() {
            crate::validate_execution_materialization(execution)
                .map_err(anyhow::Error::msg)
                .with_context(|| {
                    format!("study step `{}` execution materialization", entry.step_id())
                })?;
        }
    }
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
    let study_reference = StudyReference {
        study_id: StudyId::parse(study.study_id.clone())?,
        plan_version: study.schema_version.clone(),
        plan_sha256: study.canonical_sha256()?,
    };
    let catalog_digest = fullmag_ir::canonical_ir_json_sha256(&serde_json::to_value(catalog)?)?;
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
    Ok(intent)
}

#[cfg(test)]
#[path = "run_intent_materialization_tests.rs"]
mod tests;
