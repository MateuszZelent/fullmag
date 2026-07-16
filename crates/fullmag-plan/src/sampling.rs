use fullmag_ir::{
    OutputIR, ProblemIR, SamplingPeriodPolicyIR, StudyIR, TimeDependenceIR,
    AUTO_SINC_NYQUIST_GUARD_FACTOR,
};
use serde::{Deserialize, Serialize};

use crate::PlanError;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SamplingResolutionIR {
    pub requested_policy: SamplingPeriodPolicyIR,
    pub sample_period_s: f64,
    pub maximum_cutoff_hz: f64,
    pub nyquist_guard_factor: f64,
    pub target_nyquist_hz: f64,
    pub sampling_frequency_hz: f64,
    pub source_drive_ids: Vec<String>,
    pub target_stage_id: String,
}

fn auto_policy(problem: &ProblemIR) -> Option<SamplingPeriodPolicyIR> {
    let sampling = problem.study.sampling();
    sampling
        .table_autosave
        .as_ref()
        .and_then(|table| table.sample_period_policy.clone())
        .or_else(|| {
            sampling.outputs.iter().find_map(|output| match output {
                OutputIR::FieldAuto {
                    sample_period_policy,
                    ..
                }
                | OutputIR::ScalarAuto {
                    sample_period_policy,
                    ..
                } => Some(sample_period_policy.clone()),
                _ => None,
            })
        })
}

pub(crate) fn has_unresolved_auto_sampling(problem: &ProblemIR) -> bool {
    let sampling = problem.study.sampling();
    sampling.table_autosave.as_ref().is_some_and(|table| {
        table.requests_auto_sinc_cutoff() && table.resolved_sample_period_s.is_none()
    }) || sampling
        .outputs
        .iter()
        .any(OutputIR::requests_auto_sinc_cutoff)
}

pub fn resolve_auto_sampling_for_stage(
    problem: &mut ProblemIR,
) -> Result<Option<SamplingResolutionIR>, PlanError> {
    let Some(requested_policy) = auto_policy(problem) else {
        return Ok(None);
    };
    if !matches!(problem.study, StudyIR::TimeEvolution { .. }) {
        return Err(PlanError {
            reasons: vec![
                "automatic sampling from a sinc cutoff is valid only for a time-evolution Run stage"
                    .into(),
            ],
        });
    }

    let target_stage_id = crate::util::active_stage_id(problem)
        .filter(|stage_id| !stage_id.trim().is_empty())
        .ok_or_else(|| PlanError {
            reasons: vec![
                "automatic sampling requires runtime_metadata.active_stage_id so the active Run and its applicable sinc drives are unambiguous"
                    .into(),
            ],
        })?
        .to_owned();

    let nyquist_guard_factor = match requested_policy {
        SamplingPeriodPolicyIR::AutoSincCutoff {
            nyquist_guard_factor,
        } => nyquist_guard_factor,
    };
    if nyquist_guard_factor != AUTO_SINC_NYQUIST_GUARD_FACTOR {
        return Err(PlanError {
            reasons: vec![format!(
                "automatic sampling nyquist_guard_factor must be exactly {AUTO_SINC_NYQUIST_GUARD_FACTOR}"
            )],
        });
    }

    let mut source_drive_ids = Vec::new();
    let mut maximum_cutoff_hz: Option<f64> = None;
    for drive in problem
        .field_drives
        .iter()
        .filter(|drive| crate::util::field_drive_is_active(drive, problem))
    {
        let TimeDependenceIR::SincPulse { cutoff_hz, .. } = drive.waveform else {
            continue;
        };
        if !cutoff_hz.is_finite() || cutoff_hz <= 0.0 {
            return Err(PlanError {
                reasons: vec![format!(
                    "active sinc drive '{}' requires a finite positive cutoff_hz for automatic sampling",
                    drive.id
                )],
            });
        }
        source_drive_ids.push(drive.id.clone());
        maximum_cutoff_hz = Some(
            maximum_cutoff_hz
                .map(|maximum| maximum.max(cutoff_hz))
                .unwrap_or(cutoff_hz),
        );
    }
    let Some(maximum_cutoff_hz) = maximum_cutoff_hz else {
        return Err(PlanError {
            reasons: vec![format!(
                "automatic sampling for Run stage '{target_stage_id}' requires at least one enabled active sinc drive with a finite positive cutoff_hz"
            )],
        });
    };

    let target_nyquist_hz = nyquist_guard_factor * maximum_cutoff_hz;
    let sampling_frequency_hz = 2.0 * target_nyquist_hz;
    let sample_period_s = 1.0 / sampling_frequency_hz;
    let resolution = SamplingResolutionIR {
        requested_policy: requested_policy.clone(),
        sample_period_s,
        maximum_cutoff_hz,
        nyquist_guard_factor,
        target_nyquist_hz,
        sampling_frequency_hz,
        source_drive_ids,
        target_stage_id,
    };

    let sampling = problem.study.sampling_mut();
    if let Some(table) = sampling.table_autosave.as_mut() {
        if table.requests_auto_sinc_cutoff() {
            table.set_resolved_sample_period_s(sample_period_s);
        }
    }
    for output in &mut sampling.outputs {
        let resolved = match output {
            OutputIR::FieldAuto { name, .. } => Some(OutputIR::Field {
                name: name.clone(),
                every_seconds: sample_period_s,
            }),
            OutputIR::ScalarAuto { name, .. } => Some(OutputIR::Scalar {
                name: name.clone(),
                every_seconds: sample_period_s,
            }),
            _ => None,
        };
        if let Some(resolved) = resolved {
            *output = resolved;
        }
    }
    problem.problem_meta.runtime_metadata.insert(
        "sampling_resolution".into(),
        serde_json::to_value(&resolution).map_err(|error| PlanError {
            reasons: vec![format!(
                "failed to serialize automatic sampling resolution provenance: {error}"
            )],
        })?,
    );

    Ok(Some(resolution))
}
