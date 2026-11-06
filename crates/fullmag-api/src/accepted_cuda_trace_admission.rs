//! Immutable, explicit CUDA activity tracing; separate from phase sampling.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

pub(crate) const PARAMETER: &str = "cuda_trace";
pub(crate) const SCHEMA: &str = "accepted_cuda_trace.v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Config {
    pub(crate) schema_version: String,
    pub(crate) max_bytes: u64,
    pub(crate) max_duration_ms: u32,
}

pub(crate) fn config(parameters: &serde_json::Value) -> Result<Option<Config>> {
    let Some(value) = parameters.get(PARAMETER) else { return Ok(None); };
    let config: Config = serde_json::from_value(value.clone())?;
    if config.schema_version != SCHEMA || !(4096..=536870912).contains(&config.max_bytes)
        || !(1..=120000).contains(&config.max_duration_ms) {
        bail!("CUDA trace requires accepted_cuda_trace.v1 and bounded byte/time limits");
    }
    Ok(Some(config))
}

pub(crate) fn request_digest(value: &serde_json::Value) -> Result<String> {
    config(&serde_json::json!({PARAMETER: value}))?;
    Ok(fullmag_session::canonical_json_sha256(value))
}

/// Reserve the admitted trace cap plus a bounded receipt before any solver I/O.
pub(crate) fn output_storage_budget(config: Option<&Config>, lease_bytes: u64) -> Result<u64> {
    let Some(config) = config else { return Ok(lease_bytes); };
    let reservation = config.max_bytes.checked_add(1024 * 1024)
        .ok_or_else(|| anyhow::anyhow!("CUDA trace storage reservation overflow"))?;
    lease_bytes.checked_sub(reservation).filter(|remaining| *remaining > 0)
        .ok_or_else(|| anyhow::anyhow!("CUDA trace and its receipt exceed the accepted storage lease"))
}

pub(crate) fn validate_problem(problem: &fullmag_ir::ProblemIR) -> Result<()> {
    super::validate_fem_profile_problem(problem)?;
    let metadata = &problem.problem_meta.runtime_metadata;
    // A managed override describes execution, not the user's explicit request.
    if metadata.get("runtime_selection").and_then(|v| v.get("device")).and_then(|v| v.as_str()) != Some("gpu") {
        bail!("CUDA trace requires an explicit authored FEM GPU request");
    }
    if let Some(resolved) = metadata.get("runtime_device_override") {
        if resolved.get("device").and_then(|v| v.as_str()) != Some("gpu")
            || resolved.get("fallback_reason").is_some() {
            bail!("CUDA trace cannot profile a device fallback");
        }
    }
    Ok(())
}

pub(crate) fn validate_plan(problem: &fullmag_ir::ProblemIR, plan: &fullmag_ir::ExecutionPlanIR) -> Result<()> {
    validate_problem(problem)?;
    super::validate_fem_profile_plan(problem, plan)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> serde_json::Value {
        json!({"schema_version": SCHEMA, "max_bytes": 67108864, "max_duration_ms": 60000})
    }

    #[test]
    fn trace_reserves_storage_without_spending_the_solver_output_budget_twice() {
        let config = config(&json!({PARAMETER: request()})).unwrap().unwrap();
        assert_eq!(output_storage_budget(None, 32 * 1024 * 1024).unwrap(), 32 * 1024 * 1024);
        assert!(output_storage_budget(Some(&config), 32 * 1024 * 1024).is_err());
        assert!(output_storage_budget(Some(&config), 65 * 1024 * 1024).is_err());
        assert_eq!(output_storage_budget(Some(&config), 128 * 1024 * 1024).unwrap(), 63 * 1024 * 1024);
    }

    #[test]
    fn largest_trace_budget_is_admitted_and_fully_reserved() {
        for max_bytes in [67108864_u64, 134217728, 268435456, 536870912] {
            let mut value = request();
            value["max_bytes"] = json!(max_bytes);
            let admitted = config(&json!({PARAMETER: value})).unwrap().unwrap();
            assert_eq!(admitted.max_bytes, max_bytes);
            assert!(output_storage_budget(Some(&admitted), max_bytes + 1024 * 1024).is_err());
            assert_eq!(output_storage_budget(Some(&admitted), 1024 * 1024 * 1024).unwrap(),
                       1024 * 1024 * 1024 - max_bytes - 1024 * 1024);
        }
    }

    #[test]
    fn absence_is_off_and_the_request_is_strict_and_bounded() {
        assert!(config(&json!({})).unwrap().is_none());
        let value = request();
        assert_eq!(request_digest(&value).unwrap(), fullmag_session::canonical_json_sha256(&value));
        for (key, bad) in [("max_bytes", json!(true)), ("max_bytes", json!(4095)),
            ("max_bytes", json!(536870913)), ("max_duration_ms", json!(0)),
            ("max_duration_ms", json!(120001)), ("max_duration_ms", json!(1.5)),
            ("schema_version", json!("future")), ("enabled", json!(true))] {
            let mut changed = value.clone(); changed[key] = bad;
            assert!(request_digest(&changed).is_err(), "{key}: {changed}");
        }
        assert!(config(&json!({PARAMETER: null})).is_err());
        let mut changed = value.clone(); changed["max_duration_ms"] = json!(30000);
        assert_ne!(request_digest(&value).unwrap(), request_digest(&changed).unwrap());
    }

    fn fixture(device: &str) -> (fullmag_authoring::StudyPlan, fullmag_plan::StudyProblemCatalog) {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/runtime/accepted-fem-preparation-run-v2.json")).unwrap();
        let study: fullmag_authoring::StudyPlan = serde_json::from_value(fixture["study_plan"].clone()).unwrap();
        let catalog: fullmag_plan::StudyProblemCatalog = serde_json::from_value(fixture["study_problem_catalog"].clone()).unwrap();
        let mut problem = catalog.entries()[0].problem().clone();
        problem.problem_meta.runtime_metadata.insert("runtime_selection".into(), json!({"device": device}));
        let catalog = fullmag_plan::StudyProblemCatalog::from_entries(&study, vec![
            fullmag_plan::StudyProblemCatalogEntry::from_step(&study.steps[0], problem)]).unwrap();
        (study, catalog)
    }

    #[test]
    fn trace_only_checks_explicit_gpu_without_enabling_phase_sampling() {
        for device in ["cpu", "auto", "gpu"] {
            let (study, catalog) = fixture(device);
            let result = super::super::validate_study_profile(&json!({PARAMETER: request()}), &study, &catalog);
            if device == "gpu" { assert!(result.unwrap().is_none()); }
            else { assert!(result.is_err(), "{device}"); }
        }
    }

    #[test]
    fn managed_gpu_override_cannot_turn_auto_into_explicit_trace_intent() {
        let (study, catalog) = fixture("auto");
        let mut problem = catalog.entries()[0].problem().clone();
        problem.problem_meta.runtime_metadata.insert("runtime_device_override".into(),
            json!({"device": "gpu", "source": "managed_launcher"}));
        assert!(validate_problem(&problem).is_err());
        let catalog = fullmag_plan::StudyProblemCatalog::from_entries(&study, vec![
            fullmag_plan::StudyProblemCatalogEntry::from_step(&study.steps[0], problem)]).unwrap();
        assert!(super::super::validate_study_profile(&json!({PARAMETER: request()}), &study, &catalog).is_err());
    }

    #[test]
    fn trace_does_not_enlarge_native_physics_or_stage_support() {
        let (study, catalog) = fixture("gpu");
        for dimension in ["fdm", "single", "extended", "p2", "fallback"] {
            let mut problem = catalog.entries()[0].problem().clone();
            match dimension {
                "fdm" => problem.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fdm,
                "single" => problem.backend_policy.execution_precision = fullmag_ir::ExecutionPrecision::Single,
                "extended" => problem.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Extended,
                "p2" => problem.backend_policy.discretization_hints.as_mut().unwrap().fem.as_mut().unwrap().order = 2,
                _ => { problem.problem_meta.runtime_metadata.insert("runtime_device_override".into(),
                    json!({"device": "cpu", "source": "managed_launcher", "fallback_reason": "test"})); }
            }
            assert!(validate_problem(&problem).is_err(), "{dimension}");
        }
        let mut unsupported = study.clone();
        unsupported.steps[0].kind = fullmag_authoring::StudyStepKind::Unsupported {
            unsupported_kind: "future".into(), payload: json!({}) };
        assert!(super::super::validate_study_profile(&json!({PARAMETER: request()}), &unsupported, &catalog).is_err());
    }
}
