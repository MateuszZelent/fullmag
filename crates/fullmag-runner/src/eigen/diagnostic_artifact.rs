//! Typed projection for the user-requested eigen diagnostics artifact.
//!
//! This module only publishes solver and tracker values already carried by
//! typed result objects.  It does not calculate substitute diagnostics.

use crate::eigen::output_selection::EigenDiagnosticsRequest;
use crate::eigen::types::{
    SingleKModeResult, TrackedBranch, TrackingScoreSource,
};
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub(crate) struct EigenDiagnosticModeRecord {
    pub(crate) sample_index: usize,
    pub(crate) raw_mode_index: usize,
    pub(crate) branch_id: Option<usize>,
    pub(crate) residual_absolute_l2: Option<f64>,
    pub(crate) residual_relative_l2: Option<f64>,
    pub(crate) residual_linf: Option<f64>,
    pub(crate) tangent_leakage_mean_abs: Option<f64>,
    pub(crate) tangent_leakage_max_abs: Option<f64>,
    pub(crate) tangent_leakage_weighted_relative_l2: Option<f64>,
}

#[derive(Debug, Clone)]
pub(crate) struct EigenMassOrthogonalityRow {
    pub(crate) lhs_mode_index: usize,
    pub(crate) rhs_mode_index: usize,
    pub(crate) mass_inner_product: f64,
}

#[derive(Debug, Clone)]
pub(crate) struct EigenDiagnosticSampleRecord {
    pub(crate) sample_index: usize,
    pub(crate) computed_mode_count: usize,
    pub(crate) modes: Vec<EigenDiagnosticModeRecord>,
    /// Only populated after validating the producer's canonical mass-inner-product rows.
    pub(crate) mass_orthogonality: Option<Vec<EigenMassOrthogonalityRow>>,
}

impl EigenDiagnosticSampleRecord {
    pub(crate) fn from_result_sample(
        sample: &crate::eigen::types::SingleKSolveResult,
        mass_orthogonality: Option<Vec<EigenMassOrthogonalityRow>>,
    ) -> Self {
        Self {
            sample_index: sample.sample.sample_index,
            computed_mode_count: sample.modes.len(),
            modes: sample
                .modes
                .iter()
                .map(|mode| EigenDiagnosticModeRecord::from_mode(sample.sample.sample_index, mode))
                .collect(),
            mass_orthogonality,
        }
    }
}

impl EigenDiagnosticModeRecord {
    pub(crate) fn from_mode(sample_index: usize, mode: &SingleKModeResult) -> Self {
        Self {
            sample_index,
            raw_mode_index: mode.raw_mode_index,
            branch_id: mode.branch_id,
            residual_absolute_l2: mode.residual_norm,
            residual_relative_l2: mode.residual_relative_l2,
            residual_linf: mode.residual_linf,
            tangent_leakage_mean_abs: mode.tangent_leakage_mean_abs,
            tangent_leakage_max_abs: mode.tangent_leakage_max_abs,
            tangent_leakage_weighted_relative_l2: mode.tangent_leakage_weighted_relative_l2,
        }
    }
}

pub(crate) fn build_eigen_diagnostics_v2(
    solver_model: &str,
    solver_model_scope: &str,
    samples: &[EigenDiagnosticSampleRecord],
    branches: &[TrackedBranch],
    request: EigenDiagnosticsRequest,
    requested_mode_count: Option<usize>,
    transport_metadata: Option<&Value>,
) -> Value {
    let mode_count = samples
        .iter()
        .map(|sample| sample.computed_mode_count)
        .sum::<usize>();
    let residual_records = samples
        .iter()
        .flat_map(|sample| sample.modes.iter())
        .map(|mode| {
            json!({
                "sample_index": mode.sample_index,
                "sample_id": sample_id(mode.sample_index),
                "raw_mode_index": mode.raw_mode_index,
                "mode_id": mode_id(mode.sample_index, mode.raw_mode_index),
                "branch_id": mode.branch_id,
                "residual_absolute_l2": finite_nonnegative(mode.residual_absolute_l2),
                "residual_relative_l2": finite_nonnegative(mode.residual_relative_l2),
                "residual_linf": finite_nonnegative(mode.residual_linf),
            })
        })
        .collect::<Vec<_>>();
    let residual_count = samples
        .iter()
        .flat_map(|sample| sample.modes.iter())
        .map(|mode| {
            (if finite_nonnegative(mode.residual_absolute_l2).is_some() {
                1
            } else {
                0
            }) + (if finite_nonnegative(mode.residual_relative_l2).is_some() {
                1
            } else {
                0
            }) + (if finite_nonnegative(mode.residual_linf).is_some() {
                1
            } else {
                0
            })
        })
        .sum::<usize>();
    let residual_data = (!residual_records.is_empty()).then(|| {
        json!({
            "mode_count": mode_count,
            "records": residual_records,
        })
    });
    let residuals = diagnostic_section(
        request.include_residuals,
        data_state(
            residual_data,
            residual_count,
            mode_count.saturating_mul(3),
            "solver_residual_metrics_not_reported",
        ),
    );

    let leakage_records = samples
        .iter()
        .flat_map(|sample| sample.modes.iter())
        .map(|mode| {
            json!({
                "sample_index": mode.sample_index,
                "sample_id": sample_id(mode.sample_index),
                "raw_mode_index": mode.raw_mode_index,
                "mode_id": mode_id(mode.sample_index, mode.raw_mode_index),
                "branch_id": mode.branch_id,
                "mean_abs": finite_nonnegative(mode.tangent_leakage_mean_abs),
                "max_abs": finite_nonnegative(mode.tangent_leakage_max_abs),
                "weighted_relative_l2": finite_nonnegative(mode.tangent_leakage_weighted_relative_l2),
            })
        })
        .collect::<Vec<_>>();
    let leakage_count = samples
        .iter()
        .flat_map(|sample| sample.modes.iter())
        .map(|mode| {
            (if finite_nonnegative(mode.tangent_leakage_mean_abs).is_some() {
                1
            } else {
                0
            }) + (if finite_nonnegative(mode.tangent_leakage_max_abs).is_some() {
                1
            } else {
                0
            }) + (if finite_nonnegative(mode.tangent_leakage_weighted_relative_l2).is_some() {
                1
            } else {
                0
            })
        })
        .sum::<usize>();
    let leakage_data = (!leakage_records.is_empty()).then(|| {
        json!({
            "mode_count": mode_count,
            "records": leakage_records,
        })
    });
    let tangent_leakage = diagnostic_section(
        request.include_tangent_leakage,
        data_state(
            leakage_data,
            leakage_count,
            mode_count.saturating_mul(3),
            "tangent_leakage_metrics_not_reported",
        ),
    );

    let tracking_records = tracking_records(branches);
    let tracking_has_predecessor = branches.iter().any(|branch| {
        branch.points.iter().any(|point| {
            point
                .tracking_edge
                .as_ref()
                .is_some_and(|edge| edge.previous_sample_index.is_some())
        })
    });
    let tracking_data = (!tracking_records.is_empty() && tracking_has_predecessor).then(|| {
        json!({
            "branch_count": branches.len(),
            "records": tracking_records,
        })
    });
    let tracking = diagnostic_section(
        request.include_tracking,
        if tracking_data.is_some() {
            ("available", true, tracking_data, None)
        } else if samples.len() <= 1 {
            ("not_applicable", false, None, Some("single_sample_has_no_tracking_edges"))
        } else {
            ("unavailable", false, None, Some("branch_tracking_records_not_available"))
        },
    );

    let overlap_records = overlap_records(branches);
    let overlap_data = (!overlap_records.is_empty()).then(|| {
        json!({
            "metric_scope": "measured_tracking_edges",
            "records": overlap_records,
        })
    });
    let overlaps = diagnostic_section(
        request.include_overlaps,
        if overlap_data.is_some() {
            ("available", true, overlap_data, None)
        } else if samples.len() <= 1 {
            ("not_applicable", false, None, Some("single_sample_has_no_predecessor"))
        } else {
            ("unavailable", false, None, Some("no_measured_modal_overlap_edges"))
        },
    );

    let (orthogonality_records, orthogonality_sample_count) = mass_orthogonality_records(samples);
    let orthogonality_data = (!orthogonality_records.is_empty()).then(|| {
        json!({
            "definition": "mass_inner_product = u_i^T M u_j",
            "records": orthogonality_records,
        })
    });
    let orthogonality = diagnostic_section(
        request.include_orthogonality,
        if orthogonality_data.is_some() {
            let partial = orthogonality_sample_count < samples.len();
            (
                if partial { "partial" } else { "available" },
                true,
                orthogonality_data,
                partial.then_some("mass_orthogonality_missing_for_some_samples"),
            )
        } else {
            (
                "unavailable",
                false,
                None,
                Some("solver_mass_orthogonality_not_reported"),
            )
        },
    );

    let mut artifact = json!({
        "schema_version": "eigen_diagnostics.v2",
        "solver_model": solver_model,
        "solver_model_scope": solver_model_scope,
        "sample_count": samples.len(),
        "mode_count": mode_count,
        "dispersion": {
            "sample_count": samples.len(),
            "mode_count": mode_count,
            "mode_count_requested": requested_mode_count,
        },
        "tracking": tracking,
        "residuals": residuals,
        "overlaps": overlaps,
        "tangent_leakage": tangent_leakage,
        "orthogonality": orthogonality,
    });

    if let Some(metadata) = transport_metadata.and_then(Value::as_object) {
        if let Some(root) = artifact.as_object_mut() {
            for key in [
                "basis_transport_policy",
                "floquet_tangent_frame_max_mismatch",
                "floquet_tangent_transport_max_nonunitarity",
                "demag_kind",
                "solver_adapter",
                "execution_lane",
                "solver_family",
                "resolved_solver_family",
                "spectral_transform",
                "production_solver_available",
                "production_cpu_rejection_reason",
                "production_cpu_rejection_scope",
                "sample_execution_provenance",
                "sample_execution_provenance_status",
            ] {
                if let Some(value) = metadata.get(key) {
                    root.insert(key.to_string(), value.clone());
                }
            }
        }
    }
    artifact
}

pub(crate) fn sample_transport_metadata(
    sample_index: usize,
    solver_model: &str,
    diagnostics: Option<&Value>,
    transport_geometry: Option<&Value>,
) -> Value {
    let source = sample_native_diagnostics(diagnostics, sample_index);
    let mut metadata = json!({
        "sample_index": sample_index,
        "solver_model": solver_model,
        "diagnostics_available": source.is_some(),
    });
    if let Some(object) = metadata.as_object_mut() {
        for key in [
            "basis_transport_policy",
            "floquet_tangent_frame_max_mismatch",
            "floquet_tangent_transport_max_nonunitarity",
            "demag_kind",
            "solver_adapter",
            "execution_lane",
            "solver_family",
            "resolved_solver_family",
            "spectral_transform",
            "production_solver_available",
            "production_cpu_rejection_reason",
            "production_cpu_rejection_scope",
        ] {
            let sample_value = source.and_then(|value| value.get(key));
            let value = if sample_value.is_some() {
                sample_value.cloned().unwrap_or(Value::Null)
            } else if source.is_some()
                && matches!(
                key,
                "basis_transport_policy"
                    | "floquet_tangent_frame_max_mismatch"
                    | "floquet_tangent_transport_max_nonunitarity"
            )
            {
                transport_geometry
                    .and_then(|geometry| geometry.get(key))
                    .cloned()
                    .unwrap_or(Value::Null)
            } else {
                Value::Null
            };
            object.insert(
                key.to_string(),
                value,
            );
        }
    }
    metadata
}

pub(crate) fn common_transport_metadata(
    solver_model: &str,
    solver_model_scope: &str,
    samples: &[Value],
) -> Value {
    let keys = [
        "basis_transport_policy",
        "floquet_tangent_frame_max_mismatch",
        "floquet_tangent_transport_max_nonunitarity",
        "demag_kind",
        "solver_adapter",
        "execution_lane",
        "solver_family",
        "resolved_solver_family",
        "spectral_transform",
        "production_solver_available",
        "production_cpu_rejection_reason",
        "production_cpu_rejection_scope",
    ];
    let mut common = serde_json::Map::new();
    let mut mixed = false;
    let mut partial = false;
    let mut has_any_diagnostics = false;
    let mut all_diagnostics = !samples.is_empty();
    for sample in samples {
        let available = sample
            .get("diagnostics_available")
            .and_then(Value::as_bool)
            == Some(true);
        has_any_diagnostics |= available;
        all_diagnostics &= available;
    }
    for key in keys {
        let values = samples
            .iter()
            .map(|sample| sample.get(key).filter(|value| !value.is_null()))
            .collect::<Vec<_>>();
        let mut unique = values.iter().filter_map(|value| *value).collect::<Vec<_>>();
        unique.dedup_by(|lhs, rhs| *lhs == *rhs);
        mixed |= unique.len() > 1;
        let present = values.iter().filter(|value| value.is_some()).count();
        partial |= present > 0 && present < samples.len();
        common.insert(
            key.to_string(),
            if !samples.is_empty() && present == samples.len() && unique.len() == 1 {
                (*unique[0]).clone()
            } else {
                Value::Null
            },
        );
    }
    let status = if !has_any_diagnostics {
        "missing"
    } else if mixed {
        "mixed"
    } else if !all_diagnostics || partial {
        "partial"
    } else {
        "homogeneous"
    };
    common.insert("solver_model".to_string(), json!(solver_model));
    common.insert("solver_model_scope".to_string(), json!(solver_model_scope));
    common.insert("sample_execution_provenance".to_string(), json!(samples));
    common.insert("sample_execution_provenance_status".to_string(), json!(status));
    Value::Object(common)
}

pub(crate) fn canonical_mass_orthogonality_rows(
    diagnostics: Option<&Value>,
    sample_index: usize,
) -> Option<Vec<EigenMassOrthogonalityRow>> {
    let diagnostics = sample_native_diagnostics(diagnostics, sample_index)?;
    let rows = diagnostics.get("orthogonality")?.as_array()?;
    let parsed = rows
        .iter()
        .map(|row| {
            Some(EigenMassOrthogonalityRow {
                lhs_mode_index: row.get("lhs_mode_index")?.as_u64()? as usize,
                rhs_mode_index: row.get("rhs_mode_index")?.as_u64()? as usize,
                mass_inner_product: row.get("mass_inner_product")?.as_f64()?,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    parsed
        .iter()
        .all(|row| row.mass_inner_product.is_finite())
        .then_some(parsed)
}

fn sample_native_diagnostics<'a>(
    root: Option<&'a Value>,
    sample_index: usize,
) -> Option<&'a Value> {
    let root = root?;
    root.as_object()?;
    if let Some(entries) = root.get("sample_solver_diagnostics") {
        let entries = entries.as_array()?;
        let mut matching = entries.iter().filter(|entry| {
            entry.get("sample_index").and_then(Value::as_u64) == Some(sample_index as u64)
        });
        let selected = matching.next()?;
        if matching.next().is_some() {
            return None;
        }
        return selected.get("diagnostics").filter(|value| value.is_object());
    }
    Some(root)
}

fn data_state(
    data: Option<Value>,
    available_count: usize,
    expected_count: usize,
    unavailable_reason: &'static str,
) -> (&'static str, bool, Option<Value>, Option<&'static str>) {
    if available_count == 0 {
        ("unavailable", false, None, Some(unavailable_reason))
    } else if available_count < expected_count {
        ("partial", true, data, Some("some_requested_metrics_not_reported"))
    } else {
        ("available", true, data, None)
    }
}

fn diagnostic_section(
    requested: bool,
    state: (&'static str, bool, Option<Value>, Option<&'static str>),
) -> Value {
    if !requested {
        return json!({
            "status": "not_requested",
            "available": false,
            "data": null,
            "unavailable_reason": "disabled_by_request",
        });
    }
    let (status, available, data, reason) = state;
    json!({
        "status": status,
        "available": available,
        "data": data,
        "unavailable_reason": reason,
    })
}

fn tracking_records(branches: &[TrackedBranch]) -> Vec<Value> {
    branches
        .iter()
        .flat_map(|branch| {
            branch.points.iter().map(move |point| {
                let edge = point.tracking_edge.as_ref();
                json!({
                    "branch_id": branch.branch_id,
                    "sample_index": point.sample_index,
                    "sample_id": sample_id(point.sample_index),
                    "raw_mode_index": point.raw_mode_index,
                    "mode_id": mode_id(point.sample_index, point.raw_mode_index),
                    "tracking_confidence": finite_nonnegative(Some(point.tracking_confidence)),
                    "transition": edge.and_then(|edge| serde_json::to_value(edge.transition).ok()),
                    "score_source": edge.map(|edge| edge.score_source.as_str()),
                    "previous_sample_index": edge.and_then(|edge| edge.previous_sample_index),
                    "previous_raw_mode_index": edge.and_then(|edge| edge.previous_raw_mode_index),
                    "skipped_sample_count": edge.map(|edge| edge.skipped_sample_count),
                })
            })
        })
        .collect()
}

fn overlap_records(branches: &[TrackedBranch]) -> Vec<Value> {
    let mut records = Vec::new();
    for branch in branches {
        for point in &branch.points {
            let Some(edge) = point.tracking_edge.as_ref() else {
                continue;
            };
            if edge.previous_sample_index.is_none()
                || edge.previous_raw_mode_index.is_none()
                || !matches!(
                    edge.score_source,
                    TrackingScoreSource::ModalOverlapWeightedScore
                        | TrackingScoreSource::ModalOverlapUnweightedScore
                        | TrackingScoreSource::ModalSubspaceTransportScore
                )
            {
                continue;
            }
            let overlap = finite_unit_interval(point.overlap_prev);
            let subspace = edge.subspace.as_ref().and_then(|evidence| {
                let cosines = evidence
                    .principal_cosines
                    .iter()
                    .copied()
                    .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
                    .collect::<Vec<_>>();
                (!cosines.is_empty()).then(|| {
                    json!({
                        "previous_cluster": evidence.previous_cluster,
                        "current_cluster": evidence.current_cluster,
                        "branch_ids": evidence.branch_ids,
                        "previous_raw_mode_indices": evidence.previous_raw_mode_indices,
                        "current_raw_mode_indices": evidence.current_raw_mode_indices,
                        "principal_cosines": cosines,
                        "principal_minimum": finite_unit_interval(Some(evidence.principal_minimum)),
                    })
                })
            });
            if overlap.is_none() && subspace.is_none() {
                continue;
            }
            records.push(json!({
                "branch_id": branch.branch_id,
                "previous_sample_index": edge.previous_sample_index,
                "previous_sample_id": edge.previous_sample_index.map(sample_id),
                "previous_raw_mode_index": edge.previous_raw_mode_index,
                "previous_mode_id": edge.previous_sample_index.zip(edge.previous_raw_mode_index)
                    .map(|(sample, mode)| mode_id(sample, mode)),
                "sample_index": point.sample_index,
                "sample_id": sample_id(point.sample_index),
                "raw_mode_index": point.raw_mode_index,
                "mode_id": mode_id(point.sample_index, point.raw_mode_index),
                "metric": serde_json::to_value(edge.metric).ok(),
                "score_source": edge.score_source.as_str(),
                "overlap_prev": overlap,
                "subspace_evidence": subspace,
            }));
        }
    }
    records
}

fn mass_orthogonality_records(
    samples: &[EigenDiagnosticSampleRecord],
) -> (Vec<Value>, usize) {
    let mut sample_count = 0;
    let records = samples
        .iter()
        .flat_map(|sample| {
            let rows = sample.mass_orthogonality.as_ref();
            if rows.is_some_and(|rows| !rows.is_empty()) {
                sample_count += 1;
            }
            rows.into_iter().flatten().map(move |row| {
                json!({
                    "sample_index": sample.sample_index,
                    "sample_id": sample_id(sample.sample_index),
                    "lhs_mode_index": row.lhs_mode_index,
                    "rhs_mode_index": row.rhs_mode_index,
                    "mass_inner_product": row.mass_inner_product,
                })
            })
        })
        .collect();
    (records, sample_count)
}

fn finite_nonnegative(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite() && *value >= 0.0)
}

fn finite_unit_interval(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
}

fn sample_id(sample_index: usize) -> String {
    format!("sample-{sample_index:04}")
}

fn mode_id(sample_index: usize, raw_mode_index: usize) -> String {
    format!("sample-{sample_index:04}/mode-{raw_mode_index:04}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eigen::types::{
        TrackedBranchPoint, TrackingEdgeProvenance, TrackingMetricDefinition, TrackingTransition,
    };

    fn sample(sample_index: usize, modes: Vec<EigenDiagnosticModeRecord>) -> EigenDiagnosticSampleRecord {
        EigenDiagnosticSampleRecord {
            sample_index,
            computed_mode_count: modes.len(),
            modes,
            mass_orthogonality: None,
        }
    }

    fn mode(sample_index: usize, raw_mode_index: usize) -> EigenDiagnosticModeRecord {
        EigenDiagnosticModeRecord {
            sample_index,
            raw_mode_index,
            branch_id: Some(raw_mode_index),
            residual_absolute_l2: Some(0.0),
            residual_relative_l2: Some(1.0e-9),
            residual_linf: Some(2.0e-9),
            tangent_leakage_mean_abs: Some(0.0),
            tangent_leakage_max_abs: Some(0.0),
            tangent_leakage_weighted_relative_l2: Some(0.0),
        }
    }

    fn edge(
        score_source: TrackingScoreSource,
        previous_sample_index: Option<usize>,
        previous_raw_mode_index: Option<usize>,
    ) -> TrackingEdgeProvenance {
        TrackingEdgeProvenance {
            policy: fullmag_ir::ModeTrackingIR::default(),
            score_source,
            metric: TrackingMetricDefinition::ConsistentP1Tet4CartesianNodalEnvelope,
            transition: if previous_sample_index.is_some() {
                TrackingTransition::Pair
            } else {
                TrackingTransition::Seed
            },
            previous_sample_index,
            previous_raw_mode_index,
            skipped_sample_count: 0,
            subspace: None,
        }
    }

    #[test]
    fn all_false_request_keeps_counts_and_marks_every_section_not_requested() {
        let artifact = build_eigen_diagnostics_v2(
            "reference_scalar_tangent",
            "path_orchestrator",
            &[sample(4, vec![mode(4, 2)])],
            &[],
            EigenDiagnosticsRequest::default(),
            Some(8),
            None,
        );

        assert_eq!(artifact["sample_count"], 1);
        assert_eq!(artifact["mode_count"], 1);
        assert_eq!(artifact["dispersion"]["sample_count"], 1);
        assert_eq!(artifact["dispersion"]["mode_count"], 1);
        assert_eq!(artifact["dispersion"]["mode_count_requested"], 8);
        for key in ["tracking", "residuals", "overlaps", "tangent_leakage", "orthogonality"] {
            assert_eq!(artifact[key]["status"], "not_requested", "{key}");
            assert_eq!(artifact[key]["available"], false, "{key}");
            assert!(artifact[key]["data"].is_null(), "{key}");
        }
    }

    #[test]
    fn missing_nonfinite_and_negative_values_never_become_zero() {
        let invalid_mode = EigenDiagnosticModeRecord {
            sample_index: 0,
            raw_mode_index: 1,
            branch_id: None,
            residual_absolute_l2: Some(0.0),
            residual_relative_l2: Some(f64::NAN),
            residual_linf: None,
            tangent_leakage_mean_abs: None,
            tangent_leakage_max_abs: Some(-1.0),
            tangent_leakage_weighted_relative_l2: None,
        };
        let artifact = build_eigen_diagnostics_v2(
            "reference_scalar_tangent",
            "single_sample_solver",
            &[sample(0, vec![invalid_mode])],
            &[],
            EigenDiagnosticsRequest {
                include_tracking: false,
                include_residuals: true,
                include_overlaps: false,
                include_tangent_leakage: true,
                include_orthogonality: true,
            },
            Some(1),
            None,
        );

        assert_eq!(artifact["residuals"]["status"], "partial");
        assert_eq!(artifact["residuals"]["data"]["records"][0]["residual_absolute_l2"], 0.0);
        assert!(artifact["residuals"]["data"]["records"][0]["residual_relative_l2"].is_null());
        assert!(artifact["residuals"]["data"]["records"][0]["residual_linf"].is_null());
        assert_eq!(artifact["tangent_leakage"]["status"], "unavailable");
        assert!(artifact["tangent_leakage"]["data"].is_null());
        assert_eq!(artifact["orthogonality"]["status"], "unavailable");
        assert!(artifact["orthogonality"]["data"].is_null());
    }

    #[test]
    fn frequency_fallback_is_not_published_as_measured_overlap() {
        let first = TrackedBranchPoint {
            sample_index: 2,
            raw_mode_index: 4,
            frequency_real_hz: 1.0,
            frequency_imag_hz: 0.0,
            tracking_confidence: 1.0,
            overlap_prev: None,
            tracking_edge: Some(edge(TrackingScoreSource::Seed, None, None)),
        };
        let fallback = TrackedBranchPoint {
            sample_index: 7,
            raw_mode_index: 9,
            frequency_real_hz: 1.1,
            frequency_imag_hz: 0.0,
            tracking_confidence: 0.8,
            overlap_prev: Some(0.8),
            tracking_edge: Some(edge(
                TrackingScoreSource::FrequencyScoreFallback,
                Some(2),
                Some(4),
            )),
        };
        let branches = [TrackedBranch {
            branch_id: 0,
            label: Some("B0".to_string()),
            points: vec![first, fallback.clone()],
        }];
        let samples = [sample(2, vec![mode(2, 4)]), sample(7, vec![mode(7, 9)])];
        let request = EigenDiagnosticsRequest {
            include_tracking: false,
            include_residuals: false,
            include_overlaps: true,
            include_tangent_leakage: false,
            include_orthogonality: false,
        };
        let fallback_artifact = build_eigen_diagnostics_v2(
            "reference_scalar_tangent",
            "path_orchestrator",
            &samples,
            &branches,
            request,
            Some(2),
            None,
        );
        assert_eq!(fallback_artifact["tracking"]["status"], "not_requested");
        assert_eq!(fallback_artifact["overlaps"]["status"], "unavailable");
        assert!(fallback_artifact["overlaps"]["data"].is_null());

        let mut measured = fallback;
        measured.tracking_edge.as_mut().unwrap().score_source =
            TrackingScoreSource::ModalOverlapUnweightedScore;
        let measured_branches = [TrackedBranch {
            branch_id: 0,
            label: Some("B0".to_string()),
            points: vec![branches[0].points[0].clone(), measured],
        }];
        let measured_artifact = build_eigen_diagnostics_v2(
            "reference_scalar_tangent",
            "path_orchestrator",
            &samples,
            &measured_branches,
            request,
            Some(2),
            None,
        );
        assert_eq!(measured_artifact["overlaps"]["status"], "available");
        assert_eq!(
            measured_artifact["overlaps"]["data"]["records"][0]["previous_sample_index"],
            2
        );
        assert_eq!(
            measured_artifact["overlaps"]["data"]["records"][0]["overlap_prev"],
            0.8
        );
    }

    #[test]
    fn one_sample_seed_has_no_tracking_transition_or_measured_overlap() {
        let branch = TrackedBranch {
            branch_id: 0,
            label: Some("B0".to_string()),
            points: vec![TrackedBranchPoint {
                sample_index: 4,
                raw_mode_index: 2,
                frequency_real_hz: 1.0,
                frequency_imag_hz: 0.0,
                tracking_confidence: 1.0,
                overlap_prev: None,
                tracking_edge: Some(edge(TrackingScoreSource::Seed, None, None)),
            }],
        };
        let artifact = build_eigen_diagnostics_v2(
            "reference_scalar_tangent",
            "single_sample_solver",
            &[sample(4, vec![mode(4, 2)])],
            &[branch],
            EigenDiagnosticsRequest {
                include_tracking: true,
                include_residuals: false,
                include_overlaps: true,
                include_tangent_leakage: false,
                include_orthogonality: false,
            },
            Some(1),
            None,
        );

        assert_eq!(artifact["tracking"]["status"], "not_applicable");
        assert_eq!(artifact["tracking"]["available"], false);
        assert!(artifact["tracking"]["data"].is_null());
        assert_eq!(artifact["overlaps"]["status"], "not_applicable");
        assert_eq!(artifact["overlaps"]["available"], false);
        assert!(artifact["overlaps"]["data"].is_null());
    }

    #[test]
    fn mass_orthogonality_requires_the_selected_sample_and_canonical_rows() {
        let root = json!({
            "sample_solver_diagnostics": [
                { "sample_index": 2, "diagnostics": { "orthogonality": [
                    { "lhs_mode_index": 0, "rhs_mode_index": 0, "mass_inner_product": 1.0 }
                ] } },
                { "sample_index": 7, "diagnostics": { "orthogonality": [
                    { "lhs_mode_index": 1, "rhs_mode_index": 1, "mass_inner_product": 1.0 }
                ] } }
            ]
        });
        let selected = canonical_mass_orthogonality_rows(Some(&root), 7).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].lhs_mode_index, 1);
        assert!(canonical_mass_orthogonality_rows(Some(&root), 0).is_none());

        let unrecognized = json!({ "orthogonality": [{ "inner_product": 1.0 }] });
        assert!(canonical_mass_orthogonality_rows(Some(&unrecognized), 0).is_none());
    }
}
