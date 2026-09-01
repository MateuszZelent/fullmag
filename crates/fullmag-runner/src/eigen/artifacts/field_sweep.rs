use super::common::*;
use crate::eigen::types::PathSolveResult;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldSweepAxisArtifact {
    pub kind: String,
    pub coordinate: String,
    pub unit: String,
    pub display_conversions: Vec<FieldSweepDisplayConversion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldSweepDisplayConversion {
    pub name: String,
    pub unit: String,
    pub scale: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrequencyDomainFieldSweepModeArtifact {
    pub sample_id: String,
    pub mode_id: String,
    pub raw_mode_index: usize,
    pub branch_id: Option<usize>,
    pub frequency_hz: f64,
    pub angular_frequency_rad_per_s: f64,
    pub mode_artifact_path: String,
    pub mode_field_id: String,
    pub mode_field_resource_key: String,
    pub residual_relative_l2: Option<f64>,
    pub source_revision: String,
    pub status: ServerArtifactStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrequencyDomainFieldSweepSampleArtifact {
    pub sample_id: String,
    pub sample_index: Option<usize>,
    pub scan_axis: FieldSweepAxisArtifact,
    pub bias_field_a_per_m: [f64; 3],
    pub bias_field_mu0_t: [f64; 3],
    pub equilibrium_artifact_sha256: Option<String>,
    pub linearization_state_sha256: Option<String>,
    pub operator_input_signature_sha256: Option<String>,
    pub topology: ServerArtifactTopology,
    pub branch_ids: Vec<usize>,
    pub modes: Vec<FrequencyDomainFieldSweepModeArtifact>,
    pub status: ServerArtifactStatus,
    pub stop_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrequencyDomainFieldSweepArtifact {
    pub schema_version: &'static str,
    pub artifact_id: String,
    pub source: ServerArtifactSource,
    pub source_revision: String,
    pub run_id: String,
    pub stage_id: String,
    pub scope_id: String,
    pub runtime_id: String,
    pub revision: String,
    pub content_sha256: String,
    pub status: ServerArtifactStatus,
    pub complete: bool,
    pub interrupted: bool,
    pub stop_reason: Option<String>,
    pub requested_sample_count: usize,
    pub completed_sample_count: usize,
    pub scan_axis: FieldSweepAxisArtifact,
    pub units: ServerArtifactUnits,
    pub topology: ServerArtifactTopology,
    pub requested_execution: ServerArtifactExecution,
    pub resolved_execution: ServerArtifactExecution,
    pub samples: Vec<FrequencyDomainFieldSweepSampleArtifact>,
    pub cross_artifact_refs: Vec<ServerArtifactReference>,
}

fn field_sweep_axis() -> FieldSweepAxisArtifact {
    FieldSweepAxisArtifact {
        kind: "bias_field".to_string(),
        coordinate: "bias_field_a_per_m".to_string(),
        unit: "A/m".to_string(),
        display_conversions: vec![FieldSweepDisplayConversion {
            name: "mu0_H".to_string(),
            unit: "T".to_string(),
            scale: crate::MU0,
        }],
    }
}

/// Build the physical bias-field scan artifact from per-sample solver
/// provenance.  Kittel validation metadata is deliberately not consulted as
/// an input source; when native diagnostics do not declare a field, no scan is
/// emitted instead of inventing one from an oracle configuration.
pub fn build_frequency_domain_field_sweep_artifact(
    result: &PathSolveResult,
) -> std::io::Result<Option<FrequencyDomainFieldSweepArtifact>> {
    if result.samples.is_empty() {
        return Ok(None);
    }
    let mut samples = Vec::with_capacity(result.samples.len());
    for sample in &result.samples {
        let diagnostics = sample_native_solver_diagnostics(sample);
        let Some(bias_field_a_per_m) = diagnostic_field_a_per_m(diagnostics) else {
            return Ok(None);
        };
        let topology = topology_from_diagnostics(diagnostics);
        let mut status = diagnostic_status(diagnostics, sample.modes.len());
        let mode_values_valid = sample.modes.iter().all(|mode| {
            mode.frequency_real_hz.is_finite()
                && mode.frequency_real_hz >= 0.0
                && mode.frequency_imag_hz.is_finite()
                && mode.angular_frequency_rad_per_s.is_finite()
                && mode
                    .residual_norm
                    .map(|value| value.is_finite() && value >= 0.0)
                    .unwrap_or(true)
        });
        if !mode_values_valid {
            status = ServerArtifactStatus::Corrupt;
        }
        let branch_ids = sample
            .modes
            .iter()
            .filter_map(|mode| mode.branch_id)
            .collect::<Vec<_>>();
        let sample_id = format!("bias-field-sample-{:04}", sample.sample.sample_index);
        let modes = sample
            .modes
            .iter()
            .map(|mode| FrequencyDomainFieldSweepModeArtifact {
                sample_id: sample_id.clone(),
                mode_id: format!(
                    "sample-{:04}/mode-{:04}",
                    sample.sample.sample_index, mode.raw_mode_index
                ),
                raw_mode_index: mode.raw_mode_index,
                branch_id: mode.branch_id,
                frequency_hz: mode.frequency_real_hz,
                angular_frequency_rad_per_s: mode.angular_frequency_rad_per_s,
                mode_artifact_path: format!(
                    "eigen/modes/sample_{:04}/mode_{:04}.json",
                    sample.sample.sample_index, mode.raw_mode_index
                ),
                mode_field_id: eigen_mode_field_id(sample.sample.sample_index, mode.raw_mode_index),
                mode_field_resource_key: eigen_mode_field_resource_key(&eigen_mode_field_id(
                    sample.sample.sample_index,
                    mode.raw_mode_index,
                )),
                residual_relative_l2: mode.residual_norm,
                source_revision: result_source_revision(result),
                status,
            })
            .collect::<Vec<_>>();
        let stop_reason = diagnostic_string_any(diagnostics, &["stop_reason", "failure_reason"]);
        samples.push(FrequencyDomainFieldSweepSampleArtifact {
            sample_id,
            sample_index: Some(sample.sample.sample_index),
            scan_axis: field_sweep_axis(),
            bias_field_a_per_m,
            bias_field_mu0_t: bias_field_a_per_m.map(|value| value * crate::MU0),
            equilibrium_artifact_sha256: diagnostic_string_any(
                diagnostics,
                &["equilibrium_artifact_sha256", "equilibrium_content_sha256"],
            ),
            linearization_state_sha256: diagnostic_string_any(
                diagnostics,
                &["linearization_state_sha256", "linearization_content_sha256"],
            ),
            operator_input_signature_sha256: diagnostic_string_any(
                diagnostics,
                &["operator_input_signature_sha256"],
            ),
            topology,
            branch_ids,
            modes,
            status,
            stop_reason,
        });
    }
    let mut status = combine_status(samples.iter().map(|sample| sample.status));
    let topology_consistent = samples.windows(2).all(|window| {
        window[0].topology.mesh_id == window[1].topology.mesh_id
            && window[0].topology.topology_revision == window[1].topology.topology_revision
    });
    if !topology_consistent && status == ServerArtifactStatus::Complete {
        status = ServerArtifactStatus::Partial;
    }
    let requested_sample_count = result
        .samples
        .iter()
        .filter_map(|sample| {
            let diagnostics = sample_native_solver_diagnostics(sample)?;
            diagnostics
                .get("field_sweep")
                .and_then(|value| value.get("requested_sample_count"))
                .or_else(|| diagnostics.get("requested_sample_count"))
                .and_then(serde_json::Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
        })
        .max()
        .unwrap_or(samples.len())
        .max(samples.len());
    let completed_sample_count = samples
        .iter()
        .filter(|sample| sample.status == ServerArtifactStatus::Complete)
        .count();
    let complete = status == ServerArtifactStatus::Complete
        && completed_sample_count == requested_sample_count
        && samples.iter().all(|sample| {
            sample.equilibrium_artifact_sha256.is_some()
                && sample.linearization_state_sha256.is_some()
                && sample.operator_input_signature_sha256.is_some()
                && sample.status == ServerArtifactStatus::Complete
        });
    let status = if status == ServerArtifactStatus::Complete && !complete {
        ServerArtifactStatus::Partial
    } else {
        status
    };
    let (requested_execution, resolved_execution, runtime_id) =
        server_execution_from_modal_result(result);
    let source_revision = result_source_revision(result);
    let mut artifact = FrequencyDomainFieldSweepArtifact {
        schema_version: "eigen/field_sweep.v1",
        artifact_id: "analysis:eigen:field-sweep".to_string(),
        source: ServerArtifactSource {
            kind: "modal_eigensolve".to_string(),
            artifact: "eigen/spectrum.v2.json".to_string(),
            revision: source_revision.clone(),
        },
        source_revision: source_revision.clone(),
        run_id: "run:current".to_string(),
        stage_id: "stage:eigenmodes".to_string(),
        scope_id: "scope:bias-field".to_string(),
        runtime_id,
        revision: String::new(),
        content_sha256: String::new(),
        status,
        complete,
        interrupted: status == ServerArtifactStatus::Interrupted,
        stop_reason: samples.iter().find_map(|sample| sample.stop_reason.clone()),
        requested_sample_count,
        completed_sample_count,
        scan_axis: field_sweep_axis(),
        units: server_artifact_units_modal(),
        topology: if topology_consistent {
            samples
                .first()
                .map(|sample| sample.topology.clone())
                .unwrap_or_else(empty_server_topology)
        } else {
            ServerArtifactTopology {
                mesh_id: "topology:inconsistent".to_string(),
                topology_revision: "topology:inconsistent".to_string(),
                ..empty_server_topology()
            }
        },
        requested_execution,
        resolved_execution,
        samples,
        cross_artifact_refs: vec![ServerArtifactReference {
            relation: "source_spectrum".to_string(),
            artifact: "eigen/spectrum.v2.json".to_string(),
            revision: result_source_revision(result),
        }],
    };
    artifact.content_sha256 = canonical_artifact_digest(&artifact);
    artifact.revision = artifact.content_sha256.clone();
    Ok(Some(artifact))
}

pub fn write_frequency_domain_field_sweep_artifact(
    base_dir: &Path,
    result: &PathSolveResult,
) -> std::io::Result<bool> {
    let Some(mut artifact) = build_frequency_domain_field_sweep_artifact(result)? else {
        return Ok(false);
    };
    let spectrum_path = base_dir.join("eigen").join("spectrum.v2.json");
    let branches_path = base_dir.join("eigen").join("branches.v2.json");
    let spectrum_revision = sha256_prefixed(&fs::read(&spectrum_path)?);
    let branches_revision = sha256_prefixed(&fs::read(&branches_path)?);
    artifact.source.revision = spectrum_revision.clone();
    artifact.source_revision = spectrum_revision.clone();
    for sample in &mut artifact.samples {
        for mode in &mut sample.modes {
            mode.source_revision = spectrum_revision.clone();
        }
    }
    artifact.cross_artifact_refs = vec![
        ServerArtifactReference {
            relation: "source_spectrum".to_string(),
            artifact: "eigen/spectrum.v2.json".to_string(),
            revision: spectrum_revision,
        },
        ServerArtifactReference {
            relation: "source_branches".to_string(),
            artifact: "eigen/branches.v2.json".to_string(),
            revision: branches_revision,
        },
    ];
    artifact.content_sha256 = canonical_artifact_digest(&artifact);
    artifact.revision = artifact.content_sha256.clone();
    let path = base_dir.join("eigen").join("field_sweep.v1.json");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    write_json_atomic(&path, &artifact)?;
    Ok(true)
}
