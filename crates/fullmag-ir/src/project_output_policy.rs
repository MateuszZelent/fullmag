//! Pure output policy materialization shared by authoring and runtime adapters.
//! This does not check writer availability, reserve paths, or perform I/O.
//! Runtime owners must enforce supported formats before execution.

use crate::{
    AutosaveFormatIR, AutosaveLayoutIR, FieldAutosaveIR, OutputDataFormatIR, OutputIR, ProblemIR,
    StageAutosaveIR, StudyIR,
};

/// Add the primary field/table writer before planning. Explicit stage policies
/// retain their schema and cadence; a conflicting primary format is an error.
pub fn configure_project_autosave_policy(
    problem: &mut ProblemIR,
    data_format: OutputDataFormatIR,
    until_seconds: f64,
) -> Result<(), String> {
    let format = match data_format {
        OutputDataFormatIR::Zarr => AutosaveFormatIR::Zarr,
        OutputDataFormatIR::Hdf5 => AutosaveFormatIR::Hdf5,
    };
    if problem.study.sampling().stage_autosave.is_some() {
        let sampling = problem.study.sampling_mut();
        let policy = sampling
            .stage_autosave
            .as_mut()
            .expect("existing stage policy");
        if policy.format != format {
            return Err(
                "project data_format conflicts with the explicit stage autosave format".into(),
            );
        }
        if policy.table.is_none() {
            policy.table = sampling.table_autosave.clone();
        }
        return Ok(());
    }
    // Modal and hysteresis studies keep their dedicated existing output
    // contracts. This owner does not invent an LLG sampling clock for them.
    if !matches!(
        problem.study,
        StudyIR::TimeEvolution { .. } | StudyIR::Relaxation { .. }
    ) {
        return Ok(());
    }
    let relaxation = matches!(problem.study, StudyIR::Relaxation { .. });
    let sampling = problem.study.sampling();
    let mut fields = Vec::new();
    if !relaxation {
        for output in &sampling.outputs {
            let (name, period, policy) = match output {
                OutputIR::Field {
                    name,
                    every_seconds,
                }
                | OutputIR::FieldResolvedAuto {
                    name,
                    every_seconds,
                    ..
                } => (name, Some(*every_seconds), None),
                OutputIR::FieldAuto {
                    name,
                    sample_period_policy,
                } => (name, None, Some(sample_period_policy.clone())),
                _ => continue,
            };
            if fields
                .iter()
                .any(|field: &FieldAutosaveIR| &field.quantity == name)
            {
                continue;
            }
            fields.push(FieldAutosaveIR {
                kind: "field_autosave".into(),
                quantity: name.clone(),
                every_seconds: period,
                sample_period_policy: policy,
                every_steps: None,
            });
        }
    }
    if fields.is_empty() {
        if !relaxation && (!until_seconds.is_finite() || until_seconds <= 0.0) {
            return Err(
                "primary time-domain output requires a finite positive run duration".into(),
            );
        }
        fields.push(FieldAutosaveIR {
            kind: "field_autosave".into(),
            quantity: "magnetization".into(),
            every_seconds: (!relaxation).then_some(until_seconds),
            sample_period_policy: None,
            every_steps: relaxation.then_some(100),
        });
    }
    let table = sampling.table_autosave.clone();
    let policy = StageAutosaveIR {
        kind: "stage_autosave".into(),
        target: "results".into(),
        layout: AutosaveLayoutIR::Separate,
        format,
        table,
        fields,
    };
    policy
        .validate_for_study(&problem.study)
        .map_err(|errors| errors.join("; "))?;
    problem.study.sampling_mut().stage_autosave = Some(policy);
    Ok(())
}
