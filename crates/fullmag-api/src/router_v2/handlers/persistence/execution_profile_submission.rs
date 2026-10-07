//! Bind new HTTP submissions to immutable versions in the accepted-run store.
//! Existing accepted inputs and legacy catalogs remain self-contained.

use fullmag_plan::StudyProblemCatalog;
use fullmag_session::{execution_profiles::ExecutionProfileCatalog, SessionStore};

use crate::error::ApiError;

pub(super) fn validate_published_profiles(
    store: &SessionStore,
    study: &fullmag_authoring::StudyPlan,
    catalog: &StudyProblemCatalog,
) -> Result<(), ApiError> {
    if !catalog
        .entries()
        .iter()
        .any(|entry| entry.execution_materialization().is_some())
    {
        return Ok(());
    }
    let profiles = store
        .read_execution_profile_catalog()
        .map_err(|error| ApiError::internal(format!("read execution profile catalog: {error}")))?;
    // Match the catalogue read resource: invalid persisted defaults are a
    // storage failure, not a conflict that editing the client's draft fixes.
    for entry in &profiles.entries {
        fullmag_application::materialize_execution_request(Some(entry.profile.clone()), vec![])
            .map_err(|error| {
                ApiError::internal(format!("saved execution profile is invalid: {error}"))
            })?;
    }
    catalog
        .validate_for(study)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let inputs = catalog
        .entries()
        .iter()
        .map(|entry| {
            Ok(fullmag_application::StudyStepExecutionInput {
                step_id: entry.step_id().into(),
                problem: entry.problem().clone(),
                layers: entry
                    .execution_materialization()
                    .ok_or_else(|| {
                        ApiError::bad_request("pinned execution materialization is missing")
                    })?
                    .layers
                    .clone(),
            })
        })
        .collect::<Result<Vec<_>, ApiError>>()?;
    let expected =
        fullmag_application::materialize_study_execution(study, inputs, |id, version| {
            profiles
                .entries
                .iter()
                .find(|entry| entry.profile.profile_id == id && entry.profile.version == version)
                .map(|entry| entry.profile.clone())
                .ok_or_else(|| {
                    format!(
                        "Publish execution profile {id}@{version} before submitting this study."
                    )
                })
        })
        .map_err(|error| {
            ApiError::conflict_with_code("execution_profile_reference_conflict", error)
        })?;
    let expected_by_id: std::collections::BTreeMap<_, _> = expected
        .entries()
        .iter()
        .map(|entry| (entry.step_id(), entry))
        .collect();
    for provided in catalog.entries() {
        // Input order may differ from canonical Study order.
        let materialized = expected_by_id
            .get(provided.step_id())
            .ok_or_else(|| ApiError::internal("materialized Study step is missing"))?;
        compare_snapshot(
            provided
                .execution_materialization()
                .expect("v2 validated above"),
            materialized
                .execution_materialization()
                .expect("application materialized above"),
        )?;
    }
    Ok(())
}

#[cfg(test)]
fn validate_snapshot(
    profiles: &ExecutionProfileCatalog,
    snapshot: &fullmag_ir::MaterializedExecutionRequestIR,
) -> Result<(), ApiError> {
    let pinned = snapshot
        .profile
        .as_ref()
        .ok_or_else(|| ApiError::bad_request("pinned execution profile is missing"))?;
    let materialized = fullmag_application::materialize_referenced_execution(
        &pinned.profile_id,
        &pinned.version,
        snapshot.layers.clone(),
        |profile_id, version| profiles.entries.iter()
            .find(|entry| entry.profile.profile_id == profile_id && entry.profile.version == version)
            .map(|entry| entry.profile.clone())
            .ok_or_else(|| format!("Publish execution profile {profile_id}@{version} before submitting this study.")),
    ).map_err(|error| ApiError::conflict_with_code("execution_profile_reference_conflict", error))?;
    compare_snapshot(snapshot, &materialized)
}

fn compare_snapshot(
    snapshot: &fullmag_ir::MaterializedExecutionRequestIR,
    materialized: &fullmag_ir::MaterializedExecutionRequestIR,
) -> Result<(), ApiError> {
    // Empty sparse blocks have the same canonical wire content as omission.
    let expected = serde_json::to_value(&materialized)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let provided =
        serde_json::to_value(snapshot).map_err(|error| ApiError::bad_request(error.to_string()))?;
    if provided != expected {
        return Err(ApiError::conflict_with_code(
            "execution_profile_snapshot_conflict",
            "Execution snapshot differs from the published profile and its explicit request layers. Refresh the profile and rebuild the submission.",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "execution_profile_submission_tests.rs"]
mod tests;
