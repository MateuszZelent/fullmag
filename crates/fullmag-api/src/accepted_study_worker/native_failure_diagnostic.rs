//! Bounded, failure-only native diagnostics for one accepted worker attempt.
//!
//! The runner's `RunError` deliberately remains a small, string-shaped
//! protocol type. Native backend diagnostics are therefore available at this
//! worker seam before the supervisor applies its public failure-message
//! bound. This module projects only the identity and window-failure fields
//! needed for diagnosis; it never persists the native payload verbatim.

use anyhow::{bail, Context, Result};
use fullmag_runtime_control::AcceptedWorkerStep;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::Path;

pub(crate) const NATIVE_FAILURE_DIAGNOSTIC_FILE: &str = "native_failure_diagnostic.v1.json";
const NATIVE_FAILURE_DIAGNOSTIC_SCHEMA: &str = "fullmag.accepted_native_failure_diagnostic.v1";
const NATIVE_FAILURE_DIAGNOSTIC_SCOPE: &str = "diagnostic_only";

// The native window certificate itself is a fixed-size result field today,
// but keep a lower independent bound here so a future backend cannot turn a
// failure sidecar into an unbounded artifact. The fallback projection below
// still keeps the first failed subwindow when this bound is exceeded.
const MAX_WINDOW_CERTIFICATE_BYTES: usize = 16 * 1024;
const MAX_NATIVE_DIAGNOSTICS_BYTES: usize = 1024 * 1024;
const MAX_FAILURE_DIAGNOSTIC_BYTES: usize = 64 * 1024;
const MAX_PROJECTED_STRING_BYTES: usize = 512;

const STATUS_CAPTURED: &str = "captured";
const STATUS_PROJECTED: &str = "projected";
const STATUS_CORRUPT: &str = "corrupt";
const STATUS_MISSING: &str = "missing";
const STATUS_OVERSIZED: &str = "oversized";
const STATUS_TRUNCATED: &str = "truncated";
const STATUS_UNAVAILABLE: &str = "unavailable";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct NativeFailureDiagnosticIdentity {
    run_id: String,
    task_id: String,
    step_id: String,
    attempt_id: String,
    ownership_epoch: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
struct NativeFailureDiagnosticSidecar {
    schema_version: String,
    scope: String,
    run_id: String,
    task_id: String,
    step_id: String,
    attempt_id: String,
    ownership_epoch: u64,
    native_payload_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_payload_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    diagnostics_schema_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    native_stop_reason: Option<String>,
    window_certificate_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    window_certificate: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    first_failed_subwindow: Option<Value>,
}

/// Persist a bounded native failure projection in the exact private epoch
/// directory already reserved for this worker attempt.
///
/// This helper is intentionally best-effort at its call sites: a diagnostic
/// write failure must never replace or alter the original solver error. The
/// immutable receipt writer provides create-new semantics and fsyncs both the
/// file and its containing attempt directory.
pub(crate) fn persist_native_failure_diagnostic(
    attempt_output_dir: &Path,
    step: &AcceptedWorkerStep,
    error_message: &str,
) -> Result<()> {
    let identity = NativeFailureDiagnosticIdentity {
        run_id: step.claim.run_id.as_str().to_owned(),
        task_id: step.claim.task_id.as_str().to_owned(),
        step_id: step.step_id.clone(),
        attempt_id: step.claim.attempt_id.as_str().to_owned(),
        ownership_epoch: step.claim.ownership_epoch.value(),
    };
    let sidecar = project_failure(identity, error_message);
    write_bounded_sidecar(attempt_output_dir, &sidecar)
}

fn write_bounded_sidecar(
    attempt_output_dir: &Path,
    sidecar: &NativeFailureDiagnosticSidecar,
) -> Result<()> {
    let bytes = serialize_bounded_sidecar(sidecar)?;
    if bytes.len() > MAX_FAILURE_DIAGNOSTIC_BYTES {
        bail!("native failure diagnostic sidecar exceeds its byte bound");
    }
    // The receipt writer serializes its argument. Persist the bounded
    // projection, including its fallback, rather than the original object.
    let bounded: NativeFailureDiagnosticSidecar = serde_json::from_slice(&bytes)
        .context("decode validated bounded native failure projection")?;
    super::write_immutable_attempt_receipt(
        attempt_output_dir,
        NATIVE_FAILURE_DIAGNOSTIC_FILE,
        &bounded,
    )
    .context("persist bounded native failure diagnostic sidecar")
}

fn project_failure(
    identity: NativeFailureDiagnosticIdentity,
    error_message: &str,
) -> NativeFailureDiagnosticSidecar {
    let parsed = parse_native_diagnostics(error_message);
    let mut sidecar = NativeFailureDiagnosticSidecar {
        schema_version: NATIVE_FAILURE_DIAGNOSTIC_SCHEMA.into(),
        scope: NATIVE_FAILURE_DIAGNOSTIC_SCOPE.into(),
        run_id: identity.run_id,
        task_id: identity.task_id,
        step_id: identity.step_id,
        attempt_id: identity.attempt_id,
        ownership_epoch: identity.ownership_epoch,
        native_payload_status: parsed.status.into(),
        native_payload_error: parsed.error.map(str::to_owned),
        diagnostics_schema_version: None,
        native_reason: None,
        native_stop_reason: None,
        window_certificate_status: STATUS_UNAVAILABLE.into(),
        window_certificate: None,
        first_failed_subwindow: None,
    };

    let Some(diagnostics) = parsed.value else {
        return sidecar;
    };

    sidecar.diagnostics_schema_version = bounded_string_field(&diagnostics, &["schema_version"]);
    sidecar.native_reason =
        bounded_string_field(&diagnostics, &["reason", "native_reason", "failure_reason"]);
    sidecar.native_stop_reason = bounded_string_field(
        &diagnostics,
        &["stop_reason", "native_stop_reason", "eps_stop_reason"],
    );
    sidecar.first_failed_subwindow = first_failed_subwindow_projection(&diagnostics);

    if let Some(certificate) = diagnostics
        .get("window_certificate")
        .filter(|value| !value.is_null())
    {
        let certificate_bytes = serde_json::to_vec(certificate).unwrap_or_default();
        if certificate_bytes.len() <= MAX_WINDOW_CERTIFICATE_BYTES {
            let projected = project_window_certificate(certificate);
            sidecar.window_certificate_status =
                if certificate.get("truncated").and_then(Value::as_bool) == Some(true) {
                    STATUS_TRUNCATED.into()
                } else if &projected != certificate {
                    STATUS_PROJECTED.into()
                } else {
                    STATUS_CAPTURED.into()
                };
            sidecar.window_certificate = Some(projected);
        } else {
            sidecar.window_certificate_status = STATUS_TRUNCATED.into();
        }
    }

    sidecar
}

// Deliberately retain certificate telemetry, not arbitrary native payloads.
// Frequency/rank lists are bounded metadata, distinct from spatial eigenvectors.
fn project_window_certificate(certificate: &Value) -> Value {
    let mut result = Map::new();
    for key in [
        "schema_version",
        "status",
        "spectrum_scope",
        "window_complete",
        "method",
        "krylov_subspace_policy",
        "requested_min_hz",
        "requested_max_hz",
        "requested_mode_count",
        "requested_nev",
        "requested_ncv",
        "refined_requested_mode_count",
        "refined_nev",
        "refined_ncv",
        "discovered_mode_count",
        "accepted_mode_count",
        "min_subspace_overlap",
        "subspace_overlap_threshold",
        "perturbation_result",
        "base_schedule_summary_ref",
        "refinement_schedule_summary_ref",
        "stop_reason",
        "truncated",
    ] {
        if let Some(value) = certificate.get(key).and_then(bounded_scalar) {
            result.insert(key.into(), value);
        }
    }
    for (key, fields) in [
        ("count_certificate", &["status", "method", "count"][..]),
        (
            "search_stability",
            &["status", "requested_cluster_limit_covered"][..],
        ),
        (
            "base_schedule",
            &[
                "state",
                "planned_subwindow_count",
                "completed_subwindow_count",
                "failed_subwindow_count",
                "cancelled",
                "first_shift_hz",
                "last_shift_hz",
            ][..],
        ),
        (
            "refinement_schedule",
            &[
                "state",
                "planned_subwindow_count",
                "completed_subwindow_count",
                "failed_subwindow_count",
                "cancelled",
                "first_shift_hz",
                "last_shift_hz",
            ][..],
        ),
        ("coverage_margins_hz", &["lower", "upper"][..]),
    ] {
        if let Some(object) = certificate.get(key).and_then(Value::as_object) {
            let projected = fields
                .iter()
                .filter_map(|name| {
                    object
                        .get(*name)
                        .and_then(bounded_scalar)
                        .map(|v| ((*name).into(), v))
                })
                .collect::<Map<String, Value>>();
            result.insert(key.into(), Value::Object(projected));
        }
    }
    for key in ["accepted_cluster_frequencies_hz", "cluster_ranks"] {
        if let Some(array) = certificate.get(key).and_then(Value::as_array) {
            if array.iter().all(Value::is_number) {
                result.insert(key.into(), Value::Array(array.clone()));
            }
        }
    }
    Value::Object(result)
}

fn serialize_bounded_sidecar(sidecar: &NativeFailureDiagnosticSidecar) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec_pretty(sidecar)
        .context("serialize native failure diagnostic sidecar")?;
    if bytes.len() <= MAX_FAILURE_DIAGNOSTIC_BYTES {
        return Ok(bytes);
    }

    // Keep the identity and first-failure projection even when an unusual
    // certificate contains too much scalar telemetry. Never trim the JSON
    // text itself; replace only the optional certificate field.
    let mut fallback = sidecar.clone();
    fallback.window_certificate = None;
    fallback.window_certificate_status = STATUS_TRUNCATED.into();
    let fallback_bytes = serde_json::to_vec_pretty(&fallback)
        .context("serialize truncated native failure diagnostic sidecar")?;
    if fallback_bytes.len() > MAX_FAILURE_DIAGNOSTIC_BYTES {
        bail!("native failure diagnostic projection exceeds its byte bound");
    }
    Ok(fallback_bytes)
}

struct ParsedNativeDiagnostics {
    status: &'static str,
    error: Option<&'static str>,
    value: Option<Value>,
}

fn parse_native_diagnostics(message: &str) -> ParsedNativeDiagnostics {
    let markers = ["diagnostics_json=", "diagnostics_result_json="];
    let mut marker_seen = false;
    let mut malformed = false;

    for marker in markers {
        let Some(marker_offset) = message.find(marker) else {
            continue;
        };
        marker_seen = true;
        let suffix = &message[marker_offset + marker.len()..];
        let Some(object_offset) = suffix.find('{') else {
            malformed = true;
            continue;
        };
        let candidate = &suffix[object_offset..];
        if candidate.len() > MAX_NATIVE_DIAGNOSTICS_BYTES {
            return ParsedNativeDiagnostics {
                status: STATUS_OVERSIZED,
                error: Some("diagnostics_payload_exceeds_scan_bound"),
                value: None,
            };
        }
        let Some(end_offset) = balanced_json_object_end(candidate) else {
            malformed = true;
            continue;
        };
        let object_text = &candidate[..=end_offset];
        if let Some(value) = parse_json_object_or_escaped(object_text) {
            if value.is_object() {
                return ParsedNativeDiagnostics {
                    status: STATUS_CAPTURED,
                    error: None,
                    value: Some(value),
                };
            }
        }
        malformed = true;
    }

    if !marker_seen {
        ParsedNativeDiagnostics {
            status: STATUS_MISSING,
            error: Some("native_diagnostics_payload_missing"),
            value: None,
        }
    } else if malformed {
        ParsedNativeDiagnostics {
            status: STATUS_CORRUPT,
            error: Some("native_diagnostics_payload_invalid_json"),
            value: None,
        }
    } else {
        ParsedNativeDiagnostics {
            status: STATUS_CORRUPT,
            error: Some("native_diagnostics_payload_unavailable"),
            value: None,
        }
    }
}

fn parse_json_object_or_escaped(text: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str(text) {
        return Some(value);
    }

    // A few older adapters embedded a JSON string with escaped quotes rather
    // than the object itself. Decode exactly that wrapper, without applying
    // broad replacement to arbitrary native text.
    let wrapped = format!("\"{text}\"");
    let decoded = serde_json::from_str::<String>(&wrapped).ok()?;
    serde_json::from_str(&decoded).ok()
}

fn balanced_json_object_end(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut in_string = false;
    for (index, byte) in bytes.iter().copied().enumerate() {
        if byte == b'"' && !is_escaped(bytes, index) {
            in_string = !in_string;
            continue;
        }
        if in_string {
            continue;
        }
        match byte {
            b'{' => depth = depth.saturating_add(1),
            b'}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
    }
    None
}

fn is_escaped(bytes: &[u8], index: usize) -> bool {
    let mut slash_count = 0usize;
    let mut cursor = index;
    while cursor > 0 && bytes[cursor - 1] == b'\\' {
        slash_count += 1;
        cursor -= 1;
    }
    slash_count % 2 == 1
}

fn bounded_string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        let value = value.get(*key)?.as_str()?;
        (value.len() <= MAX_PROJECTED_STRING_BYTES).then(|| value.to_owned())
    })
}

fn first_failed_subwindow_projection(value: &Value) -> Option<Value> {
    let entries = ["executed_subwindows", "subwindows", "window_subwindows"]
        .iter()
        .find_map(|key| value.get(*key).and_then(Value::as_array))?;
    let entry = entries.iter().find(|entry| is_failed_subwindow(entry))?;
    let source = entry.as_object()?;
    let mut projection = Map::new();
    for key in [
        "pass",
        "subwindow_index",
        "index",
        "unsupported_reason",
        "linear_iterations_total",
        "eps_solve_error_available",
        "eps_converged_reason",
        "eps_nev",
        "eps_ncv",
        "eps_mpd",
        "eps_normalized_absolute_tolerance",
        "eps_normalized_absolute_residual_max",
        "ksp_converged_reason",
        "ksp_last_iterations",
        "ksp_last_rhs_norm",
        "ksp_last_true_residual_available",
        "ksp_last_true_residual_norm",
        "ksp_last_true_relative_residual",
        "shift_frequency_hz",
        "status",
        "solve_succeeded",
        "stop_reason",
        "reason",
        "failure_reason",
        "converged_eigenpair_count",
        "requested_nev",
        "requested_ncv",
        "eps_reason_available",
        "slepc_converged_reason_code",
        "outer_iterations",
        "eps_solve_error_code_available",
        "eps_solve_error_code",
        "slepc_process_quarantined",
        "operator_context_invalidated",
        "eps_lifetime_unsafe",
        "window_complete",
        "candidate_mode_count",
        "accepted_mode_count",
        "raw_ritz_in_window_count",
        "action_residual_evaluated_count",
        "action_residual_evaluation_failed_count",
        "q_vector_extraction_failed_count",
        "full_vector_reconstruction_failed_count",
        "full_vector_nonfinite_count",
        "reconstructed_mode_count",
        "full_residual_evaluation_failed_count",
        "full_residual_rejected_count",
        "full_residual_accepted_count",
        "local_accepted_mode_count",
        "certified_spectral_guard_count",
        "rejection_stage_count",
        "retry_count",
        "requested_mode_count",
        "result_truncated_at_requested_count",
        "raw_ritz_pool_saturated",
        "accepted_candidate_pool_saturated",
        "candidate_pool_saturated",
        "split_spectrum_exhausted",
        "request_limit_reached",
        "nev_limit_reached",
        "lower_edge_covered",
        "upper_edge_covered",
        "rejection_stage_clean",
        "local_coverage_certified",
        "coverage_deferred_to_refinement",
        "coverage_failure_at_limit",
        "local_frequency_min_hz",
        "local_frequency_max_hz",
        "required_local_coverage_radius_hz",
        "selected_coverage_radius_hz",
        "selected_frequency_min_hz",
        "selected_frequency_max_hz",
        "elapsed_seconds",
    ] {
        if let Some(value) = source.get(key).and_then(bounded_scalar) {
            projection.insert(key.into(), value);
        }
    }
    if let Some(probe) = source.get("shifted_ksp_failure_probe") {
        let keys = [
            "schema_version",
            "scope",
            "eps_dimension_semantics",
            "eps_attempt_number",
            "eps_dimension_arguments_available",
            "eps_nev_argument",
            "eps_ncv_argument",
            "callback_observation_available",
            "callback_count",
            "callback_count_scope",
            "last_callback_iteration",
            "last_recursive_residual_available",
            "last_recursive_residual_norm",
            "last_default_reason_available",
            "last_default_reason",
            "last_reason_after_gate_available",
            "last_reason_after_gate",
            "true_probe_attempt_count",
            "true_probe_attempt_count_scope",
            "true_probe_count",
            "true_probe_count_scope",
            "true_probe_measurement_failure_count",
            "true_probe_auxiliary_measurement_failure_count",
        ];
        if let Some(mut projected) = project_scalar_diagnostic_fields(probe, &keys) {
            if let Some(mut last) = probe.get("last_true_probe").and_then(|last| {
                project_scalar_diagnostic_fields(
                    last,
                    &[
                        "available",
                        "callback_ordinal",
                        "iteration",
                        "recursive_residual_available",
                        "recursive_residual_norm",
                        "default_reason_available",
                        "default_reason",
                        "build_solution_reason_available",
                        "build_solution_reason",
                        "reason_after_gate_available",
                        "reason_after_gate",
                        "solution_l2_norm_available",
                        "solution_l2_norm_source",
                        "solution_l2_norm",
                        "shifted_operator_action_l2_norm_available",
                        "shifted_operator_action_l2_norm_source",
                        "shifted_operator_action_l2_norm",
                        "rhs_l2_norm",
                        "true_residual_l2_norm",
                        "rtol",
                        "atol",
                        "threshold_l2_norm",
                        "tolerance_ratio_available",
                        "true_residual_to_threshold_ratio",
                    ],
                )
            }) {
                if let Some(candidate) = probe
                    .get("last_true_probe")
                    .and_then(|source| source.get("candidate_operator_diagnostic"))
                    .and_then(project_candidate_operator_diagnostic)
                {
                    last.insert(
                        "candidate_operator_diagnostic".into(),
                        Value::Object(candidate),
                    );
                }
                projected.insert("last_true_probe".into(), Value::Object(last));
            }
            projection.insert("shifted_ksp_failure_probe".into(), Value::Object(projected));
        }
    }
    (!projection.is_empty()).then(|| Value::Object(projection))
}

fn project_candidate_operator_diagnostic(value: &Value) -> Option<Map<String, Value>> {
    project_scalar_diagnostic_fields(
        value,
        &[
            "schema_version",
            "requested",
            "measurement_scope",
            "diagnostic_mode",
            "sparse_workspace_budget_bytes",
            "sparse_workspace_estimated_bytes",
            "sparse_workspace_observed_bytes",
            "sparse_workspace_postsetup_estimated_bytes",
            "memory_admission_source",
            "exact_shifted_matrix_comparison_reason",
            "memory_admission_status",
            "memory_admission_reason",
            "status",
            "reason",
            "workspace_available",
            "sample_available",
            "callback_ordinal",
            "iteration",
            "production_phi_rhs_l2_norm_available",
            "production_phi_rhs_l2_norm",
            "production_phi_l2_norm_available",
            "production_phi_l2_norm",
            "production_poisson_residual_l2_norm_available",
            "production_poisson_residual_l2_norm",
            "production_poisson_relative_residual_available",
            "production_poisson_relative_residual",
            "production_vs_isolated_replay_available",
            "production_vs_isolated_replay_relative_defect",
            "isolated_repeatability_available",
            "isolated_repeatability_relative_defect",
            "isolated_additivity_available",
            "isolated_additivity_relative_defect",
            "exact_shifted_matrix_comparison_available",
            "exact_shifted_matrix_relative_defect",
            "preconditioner_normalization_scale",
            "measurement_failure_count",
            "last_error_code",
        ],
    )
}

fn project_scalar_diagnostic_fields(value: &Value, keys: &[&str]) -> Option<Map<String, Value>> {
    let source = value.as_object()?;
    let mut projection = Map::new();
    for key in keys {
        if let Some(value) = source.get(*key).and_then(bounded_scalar) {
            projection.insert((*key).into(), value);
        }
    }
    (!projection.is_empty()).then_some(projection)
}

fn is_failed_subwindow(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    match object.get("status").and_then(Value::as_str) {
        Some("failed" | "solve_error" | "diagnostics_truncated") => true,
        // A successful solve may truthfully describe incomplete spectral
        // coverage. Its stop-reason text must not relabel it as a failed solve.
        Some("ok" | "completed" | "converged") => false,
        _ => object.get("solve_succeeded").and_then(Value::as_bool) == Some(false),
    }
}

fn bounded_scalar(value: &Value) -> Option<Value> {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => Some(value.clone()),
        Value::String(value) if value.len() <= MAX_PROJECTED_STRING_BYTES => {
            Some(Value::String(value.clone()))
        }
        Value::Array(_) | Value::Object(_) | Value::String(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> NativeFailureDiagnosticIdentity {
        NativeFailureDiagnosticIdentity {
            run_id: "run-sidecar".into(),
            task_id: "task-eigen".into(),
            step_id: "step-eigenmodes".into(),
            attempt_id: "attempt-7".into(),
            ownership_epoch: 11,
        }
    }

    fn failure_message(certificate: Value) -> String {
        let json = serde_json::json!({
            "schema_version": "poisson_airbox_modal_eigen_schur_slepc.v1",
            "status": "solve_error",
            "reason": "frequency_window_subwindow_failed",
            "stop_reason": "frequency_window_subwindow_failed",
            "window_certificate": certificate,
            "subwindows": [{
                "pass": "base",
                "subwindow_index": 3,
                "shift_frequency_hz": 9.25e9,
                "status": "failed",
                "solve_succeeded": false,
                "stop_reason": "slepc_diverged",
                "raw_ritz_in_window_count": 12,
                "full_residual_rejected_count": 12,
                "full_residual_accepted_count": 0,
                "local_coverage_certified": false,
                "coverage_failure_at_limit": true,
                "accepted_frequencies_hz": [9.0e9, 9.1e9]
            }]
        });
        format!("native modal failure (diagnostics_json={json})")
    }

    #[test]
    fn cpu_subwindows_preserve_certificate_reason_and_first_failed_projection() {
        let sidecar = project_failure(
            identity(),
            &failure_message(serde_json::json!({
                "schema_version": "poisson_airbox_frequency_window_certificate.v2",
                "status": "failed",
                "window_complete": false,
                "stop_reason": "frequency_window_subwindow_failed"
            })),
        );

        assert_eq!(sidecar.scope, NATIVE_FAILURE_DIAGNOSTIC_SCOPE);
        assert_eq!(sidecar.native_payload_status, STATUS_CAPTURED);
        assert_eq!(
            sidecar.native_reason.as_deref(),
            Some("frequency_window_subwindow_failed")
        );
        assert_eq!(
            sidecar.native_stop_reason.as_deref(),
            Some("frequency_window_subwindow_failed")
        );
        assert_eq!(sidecar.window_certificate_status, STATUS_CAPTURED);
        assert_eq!(
            sidecar
                .window_certificate
                .as_ref()
                .and_then(|value| value.get("status"))
                .and_then(Value::as_str),
            Some("failed")
        );
        assert_eq!(
            sidecar
                .first_failed_subwindow
                .as_ref()
                .and_then(|value| value.get("subwindow_index"))
                .and_then(Value::as_u64),
            Some(3)
        );
        let failed = sidecar.first_failed_subwindow.as_ref().unwrap();
        assert_eq!(failed["raw_ritz_in_window_count"], 12);
        assert_eq!(failed["full_residual_rejected_count"], 12);
        assert_eq!(failed["full_residual_accepted_count"], 0);
        assert_eq!(failed["local_coverage_certified"], false);
        assert_eq!(failed["coverage_failure_at_limit"], true);
        assert_eq!(sidecar.run_id, "run-sidecar");
        assert_eq!(sidecar.task_id, "task-eigen");
        assert_eq!(sidecar.attempt_id, "attempt-7");
        assert_eq!(sidecar.ownership_epoch, 11);
        let encoded = serde_json::to_string(&sidecar).unwrap();
        assert!(!encoded.contains("accepted_frequencies_hz"));
        assert!(!encoded.contains("lease_token"));
    }

    #[test]
    fn corrupt_native_json_is_explicitly_unavailable() {
        let sidecar = project_failure(identity(), "native failure (diagnostics_json={broken)");

        assert_eq!(sidecar.native_payload_status, STATUS_CORRUPT);
        assert_eq!(
            sidecar.native_payload_error.as_deref(),
            Some("native_diagnostics_payload_invalid_json")
        );
        assert_eq!(sidecar.window_certificate_status, STATUS_UNAVAILABLE);
        assert!(sidecar.window_certificate.is_none());
        assert!(sidecar.first_failed_subwindow.is_none());
    }

    #[test]
    fn oversized_certificate_is_truncated_but_keeps_first_failed_subwindow() {
        let large = "x".repeat(MAX_WINDOW_CERTIFICATE_BYTES + 1);
        let sidecar = project_failure(
            identity(),
            &failure_message(serde_json::json!({ "large": large })),
        );

        assert_eq!(sidecar.native_payload_status, STATUS_CAPTURED);
        assert_eq!(sidecar.window_certificate_status, STATUS_TRUNCATED);
        assert!(sidecar.window_certificate.is_none());
        assert_eq!(
            sidecar
                .first_failed_subwindow
                .as_ref()
                .and_then(|value| value.get("stop_reason"))
                .and_then(Value::as_str),
            Some("slepc_diverged")
        );
        assert!(serialize_bounded_sidecar(&sidecar).unwrap().len() <= MAX_FAILURE_DIAGNOSTIC_BYTES);
    }

    #[test]
    fn oversized_native_payload_is_explicitly_unavailable() {
        let large = "x".repeat(MAX_NATIVE_DIAGNOSTICS_BYTES);
        let sidecar = project_failure(
            identity(),
            &format!("native modal failure (diagnostics_json={{\"large\":\"{large}\"}})"),
        );

        assert_eq!(sidecar.native_payload_status, STATUS_OVERSIZED);
        assert_eq!(
            sidecar.native_payload_error.as_deref(),
            Some("diagnostics_payload_exceeds_scan_bound")
        );
        assert_eq!(sidecar.window_certificate_status, STATUS_UNAVAILABLE);
        assert!(sidecar.window_certificate.is_none());
    }

    #[test]
    fn missing_native_payload_keeps_identity_and_unavailable_scope() {
        let sidecar = project_failure(identity(), "runner failed before native diagnostics");

        assert_eq!(sidecar.native_payload_status, STATUS_MISSING);
        assert_eq!(sidecar.window_certificate_status, STATUS_UNAVAILABLE);
        assert!(sidecar.native_reason.is_none());
        assert_eq!(sidecar.run_id, "run-sidecar");
        assert_eq!(sidecar.step_id, "step-eigenmodes");
    }

    #[test]
    fn actual_sidecar_write_uses_bounded_fallback_and_is_immutable() {
        // A valid scalar rank-list is compact enough, while pretty indentation
        // exceeds the whole-file bound. Exercise the bytes actually written.
        let certificate = serde_json::json!({"cluster_ranks": vec![1; 7800]});
        assert!(serde_json::to_vec(&certificate).unwrap().len() <= MAX_WINDOW_CERTIFICATE_BYTES);
        let sidecar = project_failure(identity(), &failure_message(certificate));
        assert!(serde_json::to_vec_pretty(&sidecar).unwrap().len() > MAX_FAILURE_DIAGNOSTIC_BYTES);
        let directory = tempfile::tempdir().unwrap();
        write_bounded_sidecar(directory.path(), &sidecar).unwrap();
        let path = directory.path().join(NATIVE_FAILURE_DIAGNOSTIC_FILE);
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.len() <= MAX_FAILURE_DIAGNOSTIC_BYTES);
        let saved: NativeFailureDiagnosticSidecar = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(saved.window_certificate_status, STATUS_TRUNCATED);
        assert!(saved.window_certificate.is_none());
        assert_eq!(saved.run_id, "run-sidecar");
        assert_eq!(saved.attempt_id, "attempt-7");
        assert_eq!(saved.ownership_epoch, 11);
        assert!(saved.first_failed_subwindow.is_some());
        assert!(write_bounded_sidecar(directory.path(), &sidecar).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn floquet_solve_error_preserves_bounded_shifted_ksp_diagnostics() {
        let value = serde_json::json!({"subwindows": [
            {"status":"converged", "index":0, "unsupported_reason":"none"},
            {"status":"solve_error", "index":1,
             "unsupported_reason":"floquet_slepc_solve_failed",
             "eps_solve_error_available":true, "eps_solve_error_code":91,
             "ksp_converged_reason":-3, "raw_vectors":[1,2,3],
             "shifted_ksp_failure_probe": {
                 "schema_version":"shifted_ksp_failure_probe.v1",
                 "scope":"internal_shifted_linear_system_not_original_descriptor",
                 "callback_count":12, "raw_vectors":[4,5,6],
                 "last_true_probe": {"available":true,"rtol":1e-11,
                    "true_residual_l2_norm":0.1,"rhs_l2_norm":1.0,
                    "tolerance_ratio_available":true,"true_residual_to_threshold_ratio":10.0,
                 "candidate_operator_diagnostic": {
                     "schema_version":"floquet_candidate_operator_diagnostic.v1",
                     "requested":true, "status":"available", "sample_available":true,
                     "diagnostic_mode":"sparse_replay", "sparse_workspace_budget_bytes":67108864,
                     "sparse_workspace_estimated_bytes":4096, "sparse_workspace_observed_bytes":null,
                     "memory_admission_status":"estimated", "memory_admission_reason":"observed_pending",
                     "production_vs_isolated_replay_available":true,
                     "production_vs_isolated_replay_relative_defect":0.25,
                     "isolated_repeatability_available":true,
                     "isolated_repeatability_relative_defect":0.0,
                     "raw_vectors":[10,11,12], "live_pc_observation":{"raw_matrix":[[1,2]]}
                 },
                    "raw_vectors":[7,8,9]}
             }}
        ]});
        let failure = first_failed_subwindow_projection(&value).unwrap();
        assert_eq!(failure["status"], "solve_error");
        assert_eq!(failure["index"], 1);
        assert_eq!(failure["unsupported_reason"], "floquet_slepc_solve_failed");
        assert_eq!(failure["eps_solve_error_code"], 91);
        assert_eq!(failure["ksp_converged_reason"], -3);
        assert_eq!(failure["shifted_ksp_failure_probe"]["callback_count"], 12);
        assert_eq!(
            failure["shifted_ksp_failure_probe"]["last_true_probe"]["rtol"],
            1e-11
        );
        assert_eq!(
            failure["shifted_ksp_failure_probe"]["last_true_probe"]
                ["true_residual_to_threshold_ratio"],
            10.0
        );
        let operator = &failure["shifted_ksp_failure_probe"]["last_true_probe"]
            ["candidate_operator_diagnostic"];
        assert_eq!(
            operator["schema_version"],
            "floquet_candidate_operator_diagnostic.v1"
        );
        assert_eq!(
            operator["production_vs_isolated_replay_relative_defect"],
            0.25
        );
        assert_eq!(operator["isolated_repeatability_relative_defect"], 0.0);
        assert_eq!(operator["diagnostic_mode"], "sparse_replay");
        assert_eq!(operator["sparse_workspace_estimated_bytes"], 4096);
        assert!(operator
            .as_object()
            .unwrap()
            .contains_key("sparse_workspace_observed_bytes"));
        assert!(operator["sparse_workspace_observed_bytes"].is_null());
        assert!(failure["shifted_ksp_failure_probe"]
            .get("candidate_operator_diagnostic")
            .is_none());
        assert!(operator.get("raw_vectors").is_none());
        assert!(operator.get("live_pc_observation").is_none());
        assert!(failure.get("raw_vectors").is_none());
        assert!(failure["shifted_ksp_failure_probe"]
            .get("raw_vectors")
            .is_none());
        assert!(failure["shifted_ksp_failure_probe"]["last_true_probe"]
            .get("raw_vectors")
            .is_none());
    }

    #[test]
    fn subwindow_projection_uses_producer_status_and_keeps_hard_failure_codes() {
        let value = serde_json::json!({"executed_subwindows": [
            {"status":"ok", "subwindow_index":0, "stop_reason":"selected_window_not_certified"},
            {"status":"failed", "subwindow_index":1, "stop_reason":"slepc_error",
             "eps_solve_error_code_available":true, "eps_solve_error_code":91,
             "slepc_process_quarantined":false, "operator_context_invalidated":false,
             "eps_lifetime_unsafe":false, "raw_vectors":[1,2,3]}
        ]});
        let failure = first_failed_subwindow_projection(&value).unwrap();
        assert_eq!(failure["subwindow_index"], 1);
        assert_eq!(failure["eps_solve_error_code"], 91);
        assert_eq!(failure["slepc_process_quarantined"], false);
        assert!(failure.get("raw_vectors").is_none());
        assert_eq!(
            first_failed_subwindow_projection(&serde_json::json!({
                "executed_subwindows":[{"status":"diagnostics_truncated"}]
            }))
            .unwrap()["status"],
            "diagnostics_truncated"
        );
    }

    #[test]
    fn certificate_allowlist_keeps_frequency_metadata_and_excludes_private_payloads() {
        let sidecar = project_failure(
            identity(),
            &failure_message(serde_json::json!({
                "schema_version":"poisson_airbox_frequency_window_certificate.v2",
                "status":"failed", "accepted_cluster_frequencies_hz":[9.25e9],
                "cluster_ranks":[1], "raw_vectors":[[1,2,3]],
                "operators":{"matrix":[[4,5]]}, "environment":{"key":"do-not-save"},
                "lease_token":"do-not-save", "count_certificate":{"status":"not_performed", "lease_token":"do-not-save"}
            })),
        );
        assert_eq!(sidecar.window_certificate_status, STATUS_PROJECTED);
        let certificate = sidecar.window_certificate.as_ref().unwrap();
        assert_eq!(certificate["accepted_cluster_frequencies_hz"][0], 9.25e9);
        assert_eq!(certificate["cluster_ranks"][0], 1);
        let bytes = serde_json::to_string(&sidecar).unwrap();
        for forbidden in [
            "raw_vectors",
            "operators",
            "environment",
            "lease_token",
            "do-not-save",
        ] {
            assert!(!bytes.contains(forbidden), "{forbidden}");
        }
    }
}
