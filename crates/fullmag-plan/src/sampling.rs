use fullmag_ir::{
    AutosaveFormatIR, AutosaveLayoutIR, OutputIR, ProblemIR, SamplingPeriodPolicyIR,
    StageAutosaveIR, StudyIR, TimeDependenceIR, AUTO_SINC_NYQUIST_GUARD_FACTOR,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::PlanError;

pub const SAMPLING_RESOLUTION_SCHEMA_VERSION: &str = "sampling_resolution.v1";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResolvedAutosaveClock {
    PhysicalTime,
    AcceptedStep,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedStageAutosave {
    pub stage_id: String,
    pub target: String,
    pub layout: AutosaveLayoutIR,
    pub format: AutosaveFormatIR,
    pub table_quantities: Vec<String>,
    pub field_quantities: Vec<String>,
    pub mesh_identity: String,
    pub component_count: u8,
    pub clock: ResolvedAutosaveClock,
    pub requested: StageAutosaveIR,
}

impl ResolvedStageAutosave {
    pub fn from_problem(
        problem: &ProblemIR,
        stage_id: impl Into<String>,
        mesh_identity: impl Into<String>,
        component_count: u8,
    ) -> Option<Self> {
        let requested = problem.study.sampling().stage_autosave.clone()?;
        let mut field_quantities = requested
            .fields
            .iter()
            .map(|field| field.quantity.clone())
            .collect::<Vec<_>>();
        field_quantities.sort();
        Some(Self {
            stage_id: stage_id.into(),
            target: requested.target.clone(),
            layout: requested.layout,
            format: requested.format,
            table_quantities: requested
                .table
                .as_ref()
                .map(|table| table.quantities.clone())
                .unwrap_or_default(),
            field_quantities,
            mesh_identity: mesh_identity.into(),
            component_count,
            clock: if matches!(problem.study, StudyIR::Relaxation { .. }) {
                ResolvedAutosaveClock::AcceptedStep
            } else {
                ResolvedAutosaveClock::PhysicalTime
            },
            requested,
        })
    }
}

pub fn validate_continuous_autosave_targets(
    stages: &[ResolvedStageAutosave],
) -> Result<(), PlanError> {
    let mut targets: BTreeMap<&str, &ResolvedStageAutosave> = BTreeMap::new();
    let mut reasons = Vec::new();
    for stage in stages {
        if stage.layout == AutosaveLayoutIR::Separate {
            continue;
        }
        let Some(first) = targets.get(stage.target.as_str()).copied() else {
            targets.insert(stage.target.as_str(), stage);
            continue;
        };
        let prefix = format!(
            "continuous autosave target '{}' conflicts between stages '{}' and '{}'",
            stage.target, first.stage_id, stage.stage_id
        );
        if first.format != stage.format {
            reasons.push(format!("{prefix}: format differs"));
        }
        if first.table_quantities != stage.table_quantities {
            reasons.push(format!("{prefix}: table schema differs"));
        }
        if first.field_quantities != stage.field_quantities {
            reasons.push(format!("{prefix}: field set differs"));
        }
        if first.mesh_identity != stage.mesh_identity {
            reasons.push(format!("{prefix}: mesh identity differs"));
        }
        if first.component_count != stage.component_count {
            reasons.push(format!("{prefix}: component count differs"));
        }
    }
    if reasons.is_empty() {
        Ok(())
    } else {
        Err(PlanError { reasons })
    }
}

pub fn validate_stage_autosave_capabilities(
    stages: &[ResolvedStageAutosave],
    hdf5_available: bool,
) -> Result<(), PlanError> {
    let reasons = stages
        .iter()
        .filter(|stage| stage.format == AutosaveFormatIR::Hdf5 && !hdf5_available)
        .map(|stage| {
            format!(
                "stage '{}' requests HDF5 autosave, but capability 'stage_autosave_hdf5' is unavailable",
                stage.stage_id
            )
        })
        .collect::<Vec<_>>();
    if reasons.is_empty() {
        Ok(())
    } else {
        Err(PlanError { reasons })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SamplingResolutionIR {
    pub schema_version: String,
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
        .stage_autosave
        .as_ref()
        .and_then(|policy| {
            policy
                .table
                .as_ref()
                .and_then(|table| table.sample_period_policy.clone())
                .or_else(|| {
                    policy
                        .fields
                        .iter()
                        .find_map(|field| field.sample_period_policy.clone())
                })
        })
        .or_else(|| {
            sampling
                .table_autosave
                .as_ref()
                .and_then(|table| table.sample_period_policy.clone())
        })
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
    sampling.stage_autosave.as_ref().is_some_and(|policy| {
        policy.table.as_ref().is_some_and(|table| {
            table.requests_auto_sinc_cutoff() && table.resolved_sample_period_s.is_none()
        }) || policy
            .fields
            .iter()
            .any(|field| field.sample_period_policy.is_some() && field.every_seconds.is_none())
    }) || sampling.table_autosave.as_ref().is_some_and(|table| {
        table.requests_auto_sinc_cutoff() && table.resolved_sample_period_s.is_none()
    }) || sampling
        .outputs
        .iter()
        .any(OutputIR::requests_auto_sinc_cutoff)
}

pub(crate) fn runtime_outputs(problem: &ProblemIR) -> Vec<OutputIR> {
    let mut outputs = problem.study.sampling().outputs.clone();
    if matches!(problem.study, StudyIR::TimeEvolution { .. }) {
        if let Some(policy) = &problem.study.sampling().stage_autosave {
            for field in &policy.fields {
                let Some(every_seconds) = field.every_seconds else {
                    continue;
                };
                let existing = outputs.iter_mut().find(|output| match output {
                    OutputIR::Field { name, .. }
                    | OutputIR::FieldResolvedAuto { name, .. }
                    | OutputIR::FieldAuto { name, .. } => name == &field.quantity,
                    _ => false,
                });
                if let Some(existing) = existing {
                    match existing {
                        OutputIR::Field {
                            every_seconds: existing,
                            ..
                        }
                        | OutputIR::FieldResolvedAuto {
                            every_seconds: existing,
                            ..
                        } => *existing = existing.min(every_seconds),
                        OutputIR::FieldAuto { .. } => {}
                        _ => unreachable!("field output was selected above"),
                    }
                } else {
                    outputs.push(OutputIR::Field {
                        name: field.quantity.clone(),
                        every_seconds,
                    });
                }
            }
        }
    }
    outputs
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
        schema_version: SAMPLING_RESOLUTION_SCHEMA_VERSION.to_string(),
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
    if let Some(policy) = sampling.stage_autosave.as_mut() {
        if let Some(table) = policy.table.as_mut() {
            if table.requests_auto_sinc_cutoff() {
                table.set_resolved_sample_period_s(sample_period_s);
            }
        }
        for field in &mut policy.fields {
            if field.sample_period_policy.is_some() {
                field.every_seconds = Some(sample_period_s);
                field.sample_period_policy = None;
            }
        }
    }
    if let Some(table) = sampling.table_autosave.as_mut() {
        if table.requests_auto_sinc_cutoff() {
            table.set_resolved_sample_period_s(sample_period_s);
        }
    }
    for output in &mut sampling.outputs {
        let resolved = match output {
            OutputIR::FieldAuto {
                name,
                sample_period_policy,
            } => Some(OutputIR::FieldResolvedAuto {
                name: name.clone(),
                every_seconds: sample_period_s,
                requested_policy: sample_period_policy.clone(),
            }),
            OutputIR::ScalarAuto {
                name,
                sample_period_policy,
            } => Some(OutputIR::ScalarResolvedAuto {
                name: name.clone(),
                every_seconds: sample_period_s,
                requested_policy: sample_period_policy.clone(),
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
