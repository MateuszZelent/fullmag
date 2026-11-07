//! Explicit accepted operation/step diagnostics, separate from scientific output.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use super::accepted_worker_execution_receipt::WorkerExecutionReceiptIdentity;

#[path = "accepted_profile_admission.rs"]
mod admission;
pub(crate) use admission::{config, parameter, request_digest, validate_study_profile,
    validate_resolved_study_profile, validate_fem_profile_plan, cuda_trace, PARAMETER};
#[cfg(test)]
use admission::{configure_child, SCHEMA};

const RECEIPT_SCHEMA: &str = "worker_operation_profile.v1";
const RECEIPT: &str = "worker_operation_profile.v1.json";

#[path = "accepted_step_profile.rs"]
pub(crate) mod step_profile;

#[path = "accepted_cuda_trace.rs"]
pub(crate) mod cuda_capture;

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
    validate_resolved_study_profile(&specification.parameters, &accepted.study, &accepted.catalog, &accepted.lowered)?;
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
            let profile = if matches!(&plan.backend_plan, fullmag_ir::BackendPlanIR::Fem(_)) {
                step_profile::load(&path, &identity, &config)?
            } else { load(&path, &identity, &config)? };
            if let Some(profile) = profile { latest = Some(profile); }
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
    fn fem_fixture() -> (fullmag_authoring::StudyPlan, fullmag_plan::StudyProblemCatalog) {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/runtime/accepted-fem-preparation-run-v2.json")).unwrap();
        (serde_json::from_value(fixture["study_plan"].clone()).unwrap(),
            serde_json::from_value(fixture["study_problem_catalog"].clone()).unwrap())
    }
    #[test]
    fn exact_fem_run_catalog_admits_cpu_and_gpu_instrumentation() {
        let (study, catalog) = fem_fixture();
        let parameters = request(serde_json::json!({"enabled": true, "persist_artifact": true}));
        for device in ["cpu", "gpu"] {
            let mut problem = catalog.entries()[0].problem().clone();
            problem.problem_meta.runtime_metadata.insert("runtime_device_override".into(),
                serde_json::json!({"device": device, "source": "managed_launcher"}));
            let catalog = fullmag_plan::StudyProblemCatalog::from_entries(&study, vec![
                fullmag_plan::StudyProblemCatalogEntry::from_step(&study.steps[0], problem)]).unwrap();
            assert!(validate_study_profile(&parameters, &study, &catalog).unwrap().is_some());
        }
    }
    #[test]
    fn exact_fem_relax_catalog_is_supported_without_enlarging_other_stage_scope() {
        let (mut study, catalog) = fem_fixture();
        study.steps[0].kind = fullmag_authoring::StudyStepKind::Primitive {
            stage_kind: fullmag_authoring::StudyPrimitiveStageKind::Relax };
        study.steps[0].until_seconds = None;
        let mut problem = catalog.entries()[0].problem().clone();
        let fullmag_ir::StudyIR::TimeEvolution { dynamics, sampling } = problem.study else { panic!("FEM Run fixture"); };
        problem.study = fullmag_ir::StudyIR::Relaxation { algorithm: fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped,
            dynamics: Some(dynamics), sampling, stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1.0), energy_tolerance_j: None, max_steps: Some(10), max_relaxation_time_s: None } };
        let catalog = fullmag_plan::StudyProblemCatalog::from_entries(&study, vec![
            fullmag_plan::StudyProblemCatalogEntry::from_step(&study.steps[0], problem)]).unwrap();
        let parameters = request(serde_json::json!({"enabled": true, "persist_artifact": true}));
        assert!(validate_study_profile(&parameters, &study, &catalog).unwrap().is_some());
    }
    #[test]
    fn authored_fem_without_mesh_is_profile_admissible_but_not_a_resolved_execution() {
        let (study, catalog) = fem_fixture();
        let parameters = request(serde_json::json!({"enabled": true, "persist_artifact": true}));
        assert!(catalog.entries()[0].problem().geometry_assets.is_none());
        assert!(validate_study_profile(&parameters, &study, &catalog).unwrap().is_some());
        // The fixture is genuinely pre-preparation. Do not inject a structural
        // MeshIR or reinterpret its planning failure as an execution plan.
        let error = fullmag_plan::lower_study_plan_with_catalog(&study, &catalog).unwrap_err();
        assert!(error.to_string().contains("precomputed FEM mesh asset"));

        let mut fdm_problem = catalog.entries()[0].problem().clone();
        fdm_problem.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fdm;
        let fdm_catalog = fullmag_plan::StudyProblemCatalog::from_entries(&study, vec![
            fullmag_plan::StudyProblemCatalogEntry::from_step(&study.steps[0], fdm_problem)]).unwrap();
        let non_native = fullmag_plan::lower_study_plan_with_catalog(&study, &fdm_catalog).unwrap();
        assert!(validate_resolved_study_profile(&parameters, &study, &catalog, &non_native).is_err());
        let mut missing = non_native.clone(); missing.steps[0].execution_plan = None;
        assert!(validate_resolved_study_profile(&parameters, &study, &catalog, &missing).is_err());
        let mut foreign = non_native.clone(); foreign.study_revision += 1;
        assert!(validate_resolved_study_profile(&parameters, &study, &catalog, &foreign).is_err());
        let mut mislabeled = non_native;
        let plan = mislabeled.steps[0].execution_plan.as_mut().unwrap();
        plan.common.requested_backend = fullmag_ir::BackendTarget::Fem;
        plan.common.resolved_backend = fullmag_ir::BackendTarget::Fem;
        // A native label on an FDM payload cannot satisfy the native plan gate.
        assert!(validate_resolved_study_profile(&parameters, &study, &catalog, &mislabeled).is_err());
    }

    #[test]
    fn preparation_profile_admission_keeps_strict_double_and_p1_magnetization_guards() {
        let (study, catalog) = fem_fixture();
        let parameters = request(serde_json::json!({"enabled": true, "persist_artifact": true}));
        for dimension in ["precision", "mode", "magnetization_order"] {
            let mut problem = catalog.entries()[0].problem().clone();
            match dimension {
                "precision" => problem.backend_policy.execution_precision = fullmag_ir::ExecutionPrecision::Single,
                "mode" => problem.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Extended,
                _ => problem.backend_policy.discretization_hints.as_mut().unwrap().fem.as_mut().unwrap().order = 2,
            }
            let result = fullmag_plan::StudyProblemCatalog::from_entries(&study, vec![
                fullmag_plan::StudyProblemCatalogEntry::from_step(&study.steps[0], problem)]);
            // The catalog itself may already reject the unsupported lane;
            // otherwise the profile admission must do so before preparation.
            if let Ok(candidate) = result {
                assert!(validate_study_profile(&parameters, &study, &candidate).is_err(), "{dimension}");
            }
        }
    }

    #[test]
    fn explicit_disabled_fdm_and_unsupported_steps_still_refuse_before_acceptance() {
        let (study, catalog) = fem_fixture();
        let mut problem = catalog.entries()[0].problem().clone();
        problem.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fdm;
        let fdm = fullmag_plan::StudyProblemCatalog::from_entries(&study, vec![
            fullmag_plan::StudyProblemCatalogEntry::from_step(&study.steps[0], problem)]).unwrap();
        for enabled in [false, true] {
            let parameters = request(serde_json::json!({"enabled": enabled, "persist_artifact": true}));
            assert!(validate_study_profile(&parameters, &study, &fdm).is_err());
            let mut unsupported = study.clone();
            unsupported.steps[0].kind = fullmag_authoring::StudyStepKind::Unsupported {
                unsupported_kind: "future".into(), payload: serde_json::json!({}) };
            assert!(validate_study_profile(&parameters, &unsupported, &catalog).is_err());
        }
        assert!(validate_study_profile(&serde_json::json!({}), &study, &fdm).unwrap().is_none());
    }
    #[test]
    fn child_timer_environment_is_explicit_and_removes_ambient_values() {
        let mut command = std::process::Command::new("unused-worker");
        command.env("FULLMAG_FEM_STEP_PROFILE", "ambient");
        configure_child(&mut command, false);
        assert!(command.get_envs().any(|(key, value)| key == "FULLMAG_FEM_STEP_PROFILE" && value.is_none()));
        configure_child(&mut command, true);
        assert!(command.get_envs().any(|(key, value)| key == "FULLMAG_FEM_STEP_PROFILE" && value == Some(std::ffi::OsStr::new("1"))));
        configure_child(&mut command, false);
        assert!(command.get_envs().any(|(key, value)| key == "FULLMAG_FEM_STEP_PROFILE" && value.is_none()));
    }
    #[test]
    fn request_digest_binds_the_whole_immutable_wrapper() {
        let first = request(serde_json::json!({"enabled": true, "persist_artifact": true}));
        let mut other = first[PARAMETER].clone(); other["config"]["max_samples"] = serde_json::json!(128);
        assert_ne!(request_digest(&first[PARAMETER]).unwrap(), request_digest(&other).unwrap());
        assert_eq!(request_digest(&other).unwrap(), fullmag_session::canonical_json_sha256(&other));
    }

    #[test]
    fn closed_loop_operation_snapshot_contract_remains_separate_and_unchanged() {
        let config = config(&request(serde_json::json!({"enabled": true, "persist_artifact": true}))).unwrap().unwrap();
        let mut snapshot = fullmag_runner::SolverProfileState::new(config).snapshot();
        let phases = [
            ("antenna.surface.source_prepare", "Source preparation"),
            ("antenna.surface.exact_geometry", "Exact geometry"),
            ("antenna.surface.binary64", "Binary64 evaluation"),
            ("antenna.surface.precision80", "80-digit evaluation"),
            ("antenna.surface.precision120", "120-digit evaluation"),
            ("antenna.surface.consistency", "Consistency checks"),
            ("antenna.surface.reduction", "Reduction"),
            ("antenna.surface.serialization", "Serialization"),
            ("antenna.surface.unattributed", "Unattributed operation time"),
        ];
        snapshot.operation_samples.push(fullmag_runner::SolverProfileOperationSample {
            sequence: 0, operation_id: "antenna.closed_loop.inspect".into(),
            outcome: fullmag_runner::SolverProfileOperationOutcome::Completed,
            total_wall_time_ns: 10, native_operator_wall_ns: None, native_call_wall_ns: None,
            phases: std::array::from_fn(|index| fullmag_runner::SolverProfilePhaseSample {
                id: phases[index].0.into(), label: phases[index].1.into(),
                wall_time_ns: if index == 8 { 10 } else { 0 }, percent_of_total: if index == 8 { 100.0 } else { 0.0 },
            }), accounting_issue: false,
        });
        validate_snapshot(&snapshot).unwrap();
        snapshot.latest_samples.push(fullmag_runner::SolverProfileStepSample::from_step_stats(&fullmag_runner::StepStats::default()));
        assert!(validate_snapshot(&snapshot).is_err());
    }

}
