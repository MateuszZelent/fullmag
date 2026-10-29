//! Explicit accepted-operation diagnostics; never part of the scientific output bundle.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use super::accepted_worker_execution_receipt::WorkerExecutionReceiptIdentity;

pub(crate) const PARAMETER: &str = "solver_profile";
const SCHEMA: &str = "accepted_solver_profile.v1";
const RECEIPT_SCHEMA: &str = "worker_operation_profile.v1";
const RECEIPT: &str = "worker_operation_profile.v1.json";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema_version: String,
    config: fullmag_runner::SolverProfileConfig,
}

pub(crate) fn config(parameters: &serde_json::Value) -> Result<Option<fullmag_runner::SolverProfileConfig>> {
    let Some(value) = parameters.get(PARAMETER) else { return Ok(None); };
    let object = value.get("config").and_then(serde_json::Value::as_object)
        .context("accepted solver profile requires a config object")?;
    const KEYS: &[&str] = &["enabled", "sample_every", "sample_interval_wall_ms", "max_samples", "emit_engine_log", "persist_artifact"];
    if object.keys().any(|key| !KEYS.contains(&key.as_str())) {
        bail!("accepted solver profile contains an unknown config key");
    }
    let request: Request = serde_json::from_value(value.clone())?;
    if request.schema_version != SCHEMA { bail!("unsupported accepted solver profile schema"); }
    let config = request.config.normalized();
    if config.enabled && config.emit_engine_log {
        bail!("accepted solver profiling does not yet support emit_engine_log=true");
    }
    if config.enabled && !config.persist_artifact {
        bail!("accepted solver profiling requires explicit persist_artifact=true");
    }
    Ok(config.enabled.then_some(config))
}

pub(crate) fn parameter(configuration: fullmag_runner::SolverProfileConfig) -> Result<serde_json::Value> {
    let value = serde_json::to_value(Request { schema_version: SCHEMA.into(), config: configuration })?;
    let mut parameters = serde_json::Map::new();
    parameters.insert(PARAMETER.into(), value.clone());
    config(&serde_json::Value::Object(parameters))?;
    Ok(value)
}

/// Validate before RunIntent acceptance, for live and headless admission alike.
pub(crate) fn validate_study_profile(parameters: &serde_json::Value,
    study: &fullmag_authoring::StudyPlan,
) -> Result<Option<fullmag_runner::SolverProfileConfig>> {
    if parameters.get(PARAMETER).is_none() { return Ok(None); }
    let configuration = config(parameters)?;
    let mut enabled = study.steps.iter().filter(|step| step.enabled).peekable();
    if enabled.peek().is_none() || !enabled.all(|step| matches!(&step.kind,
        fullmag_authoring::StudyStepKind::ClosedLoopInspection { .. })) {
        bail!("the solver_profile parameter is supported only for closed-loop inspection, including explicit disabled configuration; omit the parameter for LLG, FEM Run/Relax or external-lead stages");
    }
    Ok(configuration)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    schema_version: String,
    identity: WorkerExecutionReceiptIdentity,
    config_sha256: String,
    profile: fullmag_runner::SolverProfileSnapshot,
}

fn digest(config: &fullmag_runner::SolverProfileConfig) -> Result<String> {
    Ok(fullmag_session::canonical_json_sha256(&serde_json::to_value(config)?))
}

pub(crate) fn persist(attempt: &Path, identity: &WorkerExecutionReceiptIdentity,
    profile: &fullmag_runner::SolverProfileState) -> Result<()> {
    if !profile.config().enabled { return Ok(()); }
    if !profile.config().persist_artifact { bail!("accepted operation profile has no persistence grant"); }
    let snapshot = profile.snapshot();
    validate_snapshot(&snapshot)?;
    crate::accepted_study_worker::write_immutable_attempt_receipt(attempt, RECEIPT, &Receipt {
        schema_version: RECEIPT_SCHEMA.into(), identity: identity.clone(),
        config_sha256: digest(profile.config())?, profile: snapshot,
    })
}

fn validate_snapshot(profile: &fullmag_runner::SolverProfileSnapshot) -> Result<()> {
    if !profile.config.enabled || !profile.config.persist_artifact
        || profile.config != profile.config.clone().normalized()
        || !profile.latest_samples.is_empty() || profile.operation_samples.len() > profile.config.max_samples
        || profile.operation_samples.len() != 1 {
        bail!("accepted operation profile has an invalid bounded sample shape");
    }
    for sample in &profile.operation_samples {
        if sample.sequence != 0 { bail!("accepted operation profile has another sample sequence"); }
        sample.validate().map_err(anyhow::Error::msg)?;
    }
    Ok(())
}

pub(crate) fn load(attempt: &Path, expected: &WorkerExecutionReceiptIdentity,
    config: &fullmag_runner::SolverProfileConfig) -> Result<Option<fullmag_runner::SolverProfileSnapshot>> {
    let Some(receipt): Option<Receipt> = crate::accepted_study_worker::read_attempt_receipt(attempt, RECEIPT)? else { return Ok(None); };
    if receipt.schema_version != RECEIPT_SCHEMA || !receipt.identity.matches_same_attempt(expected)
        || receipt.config_sha256 != digest(config)? || receipt.profile.config != *config {
        bail!("accepted operation profile differs from its immutable attempt or configuration");
    }
    validate_snapshot(&receipt.profile)?;
    Ok(Some(receipt.profile))
}

/// Read only exact catalog-owned attempts. No active-lease check is required for terminal diagnostics.
pub(crate) fn load_projection(store: &fullmag_session::SessionStore,
    specification: &fullmag_application::RunSpecification,
    tasks: &[fullmag_session::FmsTaskCatalogEntry],
) -> Result<Option<fullmag_runner::SolverProfileSnapshot>> {
    let Some(config) = config(&specification.parameters)? else { return Ok(None); };
    let accepted = fullmag_runtime_control::load_accepted_study_snapshot(
        store, &specification.run_id, &specification.snapshot.project_id)?;
    let journal = store.read_coordinator_journal(specification.run_id.as_str())?;
    let mut latest = None;
    for step in &accepted.lowered.steps {
        let task_id = fullmag_session::task_id_for_study_step(specification.run_id.as_str(), &step.step_id)?;
        let Some(task) = tasks.iter().find(|task| task.task_id == task_id) else { continue; };
        let (Some(attempt), Some(epoch)) = (task.attempt_id.as_deref(), task.ownership_epoch) else { continue; };
        for entry in journal.iter().filter(|entry| entry.task_id == task_id
            && entry.attempt_id == attempt && entry.ownership_epoch == epoch) {
            let transition: fullmag_application::CoordinatorTransition = serde_json::from_value(entry.payload.clone())?;
            let fullmag_application::CoordinatorMessage::Command(start) = &transition.message else { continue; };
            if !matches!(start.command, fullmag_application::WorkerCommand::Start) { continue; }
            let claim = &transition.checkpoint.claim;
            if claim.run_id != specification.run_id || claim.task_id.as_str() != task_id
                || claim.attempt_id.as_str() != attempt || claim.ownership_epoch.value() != epoch
                || !start.claim.matches_claim(claim) {
                bail!("operation profile Start does not match the current catalog attempt");
            }
            let plan = step.execution_plan.as_ref().context("operation profile has no accepted plan")?;
            let identity = super::accepted_worker_execution_receipt::worker_execution_identity_from_plan(
                start, claim, plan, "default")?;
            let path = match crate::accepted_study_worker::existing_private_attempt_output_dir(store, claim) {
                Ok(path) => path,
                Err(error) if error.chain().any(|cause| cause.downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound)) => continue,
                Err(error) => return Err(error),
            };
            if let Some(profile) = load(&path, &identity, &config)? { latest = Some(profile); }
        }
    }
    Ok(latest)
}


#[cfg(test)]
mod tests {
    use super::*;
    fn request(config: serde_json::Value) -> serde_json::Value {
        serde_json::json!({"solver_profile": {"schema_version": SCHEMA, "config": config}})
    }
    #[test]
    fn absent_and_explicit_disabled_remain_off() {
        assert!(config(&serde_json::json!({})).unwrap().is_none());
        assert!(config(&request(serde_json::json!({"enabled": false}))).unwrap().is_none());
    }
    #[test]
    fn accepted_profile_requires_explicit_persistence_and_known_fields() {
        assert!(config(&request(serde_json::json!({"enabled": true}))).is_err());
        assert!(config(&request(serde_json::json!({"enabled": true, "persist_artifact": true, "unknown": 1}))).is_err());
        let mut unknown = request(serde_json::json!({"enabled": true, "persist_artifact": true}));
        unknown["solver_profile"]["unknown"] = serde_json::json!(1);
        assert!(config(&unknown).is_err());
        unknown["solver_profile"].as_object_mut().unwrap().remove("unknown");
        unknown["solver_profile"]["schema_version"] = serde_json::json!("accepted_solver_profile.v2");
        assert!(config(&unknown).is_err());
        assert!(config(&request(serde_json::json!({"enabled": true, "persist_artifact": true, "emit_engine_log": true}))).is_err());
    }
    #[test]
    fn accepted_profile_reuses_existing_normalization() {
        let config = config(&request(serde_json::json!({"enabled": true, "persist_artifact": true,
            "sample_every": 0, "max_samples": 999999}))).unwrap().unwrap();
        assert_eq!(config.sample_every, 1);
        assert_eq!(config.max_samples, 4096);
        let mut parameters = serde_json::Map::new();
        parameters.insert(PARAMETER.into(), parameter(config.clone()).unwrap());
        assert_eq!(super::config(&serde_json::Value::Object(parameters)).unwrap(), Some(config));
    }
}
