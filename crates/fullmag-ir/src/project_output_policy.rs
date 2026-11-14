//! Pure output policy materialization shared by authoring and runtime adapters.
//! This does not check writer availability, reserve paths, or perform I/O.
//! Runtime owners must enforce supported formats before execution.

use crate::{
    AutosaveFormatIR, AutosaveLayoutIR, FieldAutosaveIR, OutputDataFormatIR, OutputIR, ProblemIR,
    SamplingIR, StageAutosaveIR, StudyKindIR,
};

/// Resolve the primary field/table writer for a project output format.
///
/// Existing stage policies retain their schema and cadence, with a project
/// table policy inherited only when the stage policy does not define one. A
/// conflicting primary format is an error. New defaults are produced only
/// for time-evolution and relaxation studies; this function does not validate
/// those defaults against a complete study or mutate the supplied sampling.
pub fn resolve_project_stage_autosave_policy(
    kind: StudyKindIR,
    sampling: &SamplingIR,
    data_format: OutputDataFormatIR,
    until_seconds: f64,
) -> Result<Option<StageAutosaveIR>, String> {
    let format = match data_format {
        OutputDataFormatIR::Zarr => AutosaveFormatIR::Zarr,
        OutputDataFormatIR::Hdf5 => AutosaveFormatIR::Hdf5,
    };
    if let Some(explicit) = &sampling.stage_autosave {
        let mut policy = explicit.clone();
        if policy.format != format {
            return Err(
                "project data_format conflicts with the explicit stage autosave format".into(),
            );
        }
        if policy.table.is_none() {
            policy.table = sampling.table_autosave.clone();
        }
        return Ok(Some(policy));
    }
    // Modal and hysteresis studies keep their dedicated existing output
    // contracts. This owner does not invent an LLG sampling clock for them.
    if !matches!(kind, StudyKindIR::TimeEvolution | StudyKindIR::Relaxation) {
        return Ok(None);
    }
    let relaxation = matches!(kind, StudyKindIR::Relaxation);
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
            quantity: "m".into(),
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
    Ok(Some(policy))
}

/// Add the primary field/table writer before planning. Explicit stage policies
/// retain their schema and cadence; a conflicting primary format is an error.
pub fn configure_project_autosave_policy(
    problem: &mut ProblemIR,
    data_format: OutputDataFormatIR,
    until_seconds: f64,
) -> Result<(), String> {
    let had_explicit_policy = problem.study.sampling().stage_autosave.is_some();
    let policy = resolve_project_stage_autosave_policy(
        problem.study.kind(),
        problem.study.sampling(),
        data_format,
        until_seconds,
    )?;

    // Preserve the old boundary: only newly generated defaults are validated
    // against the complete study. Existing explicit policies keep their prior
    // schema/cadence behavior and only undergo the resolver's format check.
    if !had_explicit_policy {
        if let Some(policy) = &policy {
            policy
                .validate_for_study(&problem.study)
                .map_err(|errors| errors.join("; "))?;
        }
    }
    problem.study.sampling_mut().stage_autosave = policy;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::StudyIR;

    #[test]
    fn default_relaxation_field_uses_canonical_quantity_and_step_cadence() {
        let mut problem = ProblemIR::bootstrap_example();
        let mut sampling = problem.study.sampling().clone();
        sampling.outputs.clear();
        sampling.table_autosave = None;
        sampling.stage_autosave = None;
        problem.study = StudyIR::Relaxation {
            algorithm: crate::RelaxationAlgorithmIR::LlgOverdamped,
            dynamics: None,
            stop: crate::RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: Some(10),
                max_relaxation_time_s: None,
            },
            sampling,
        };

        let resolved = resolve_project_stage_autosave_policy(
            problem.study.kind(),
            problem.study.sampling(),
            OutputDataFormatIR::Hdf5,
            4.0,
        )
        .expect("default relaxation output policy should resolve")
        .expect("relaxation should have a primary output policy");

        configure_project_autosave_policy(&mut problem, OutputDataFormatIR::Hdf5, 4.0)
            .expect("default relaxation output policy should be valid");

        let policy = problem
            .study
            .sampling()
            .stage_autosave
            .as_ref()
            .expect("default relaxation output policy should be installed");
        assert_eq!(policy, &resolved);
        assert_eq!(policy.format, AutosaveFormatIR::Hdf5);
        assert_eq!(policy.fields.len(), 1);
        assert_eq!(policy.fields[0].quantity, "m");
        assert_eq!(policy.fields[0].every_steps, Some(100));
        assert_eq!(policy.fields[0].every_seconds, None);
    }

    #[test]
    fn default_time_evolution_fallback_uses_canonical_quantity_and_run_duration() {
        let mut problem = ProblemIR::bootstrap_example();
        assert!(matches!(&problem.study, StudyIR::TimeEvolution { .. }));
        {
            let sampling = problem.study.sampling_mut();
            sampling.outputs.clear();
            sampling.table_autosave = None;
            sampling.stage_autosave = None;
        }
        let until_seconds = 2.5;

        configure_project_autosave_policy(&mut problem, OutputDataFormatIR::Zarr, until_seconds)
            .expect("default time-evolution output policy should be valid");

        let policy = problem
            .study
            .sampling()
            .stage_autosave
            .as_ref()
            .expect("default time-evolution output policy should be installed");
        assert_eq!(policy.kind, "stage_autosave");
        assert_eq!(policy.target, "results");
        assert_eq!(policy.layout, AutosaveLayoutIR::Separate);
        assert_eq!(policy.format, AutosaveFormatIR::Zarr);
        assert_eq!(policy.fields.len(), 1);
        assert_eq!(policy.fields[0].quantity, "m");
        assert_eq!(policy.fields[0].every_seconds, Some(until_seconds));
        assert_eq!(policy.fields[0].every_steps, None);
    }

    #[test]
    fn resolver_preserves_time_evolution_field_and_auto_cadences() {
        let mut problem = ProblemIR::bootstrap_example();
        let auto_policy = crate::SamplingPeriodPolicyIR::AutoSincCutoff {
            nyquist_guard_factor: crate::AUTO_SINC_NYQUIST_GUARD_FACTOR,
        };
        {
            let sampling = problem.study.sampling_mut();
            sampling.outputs = vec![
                OutputIR::FieldAuto {
                    name: "m".into(),
                    sample_period_policy: auto_policy.clone(),
                },
                OutputIR::FieldResolvedAuto {
                    name: "H_ex".into(),
                    every_seconds: 0.25,
                    requested_policy: auto_policy.clone(),
                },
            ];
            sampling.stage_autosave = None;
        }

        let policy = resolve_project_stage_autosave_policy(
            problem.study.kind(),
            problem.study.sampling(),
            OutputDataFormatIR::Zarr,
            4.0,
        )
        .expect("time-evolution output policy should resolve")
        .expect("time evolution should have a primary output policy");

        assert_eq!(policy.fields.len(), 2);
        assert_eq!(policy.fields[0].quantity, "m");
        assert_eq!(
            policy.fields[0].sample_period_policy,
            Some(auto_policy.clone())
        );
        assert_eq!(policy.fields[0].every_seconds, None);
        assert_eq!(policy.fields[1].quantity, "H_ex");
        assert_eq!(policy.fields[1].every_seconds, Some(0.25));
        assert_eq!(policy.fields[1].sample_period_policy, None);
    }

    #[test]
    fn explicit_policy_keeps_custom_schema_and_cadence_and_inherits_table() {
        let mut problem = ProblemIR::bootstrap_example();
        let inherited_table = crate::TableAutosaveIR {
            kind: "table_autosave".into(),
            table_id: "energy-history".into(),
            sample_period_s: Some(0.5),
            sample_period_policy: None,
            resolved_sample_period_s: None,
            every_steps: None,
            quantities: vec!["E_total".into()],
            expressions: Vec::new(),
        };
        let explicit = StageAutosaveIR {
            kind: "stage_autosave".into(),
            target: "custom-primary".into(),
            layout: AutosaveLayoutIR::Continuous,
            format: AutosaveFormatIR::Zarr,
            table: None,
            // This custom step cadence is intentionally invalid for time
            // evolution; the established explicit-policy path retains it.
            fields: vec![FieldAutosaveIR {
                kind: "field_autosave".into(),
                quantity: "m".into(),
                every_seconds: None,
                sample_period_policy: None,
                every_steps: Some(7),
            }],
        };
        {
            let sampling = problem.study.sampling_mut();
            sampling.table_autosave = Some(inherited_table.clone());
            sampling.stage_autosave = Some(explicit.clone());
        }

        let mut expected = explicit.clone();
        expected.table = Some(inherited_table.clone());
        let resolved = resolve_project_stage_autosave_policy(
            problem.study.kind(),
            problem.study.sampling(),
            OutputDataFormatIR::Zarr,
            4.0,
        )
        .expect("matching explicit policy should resolve");
        assert_eq!(resolved, Some(expected.clone()));
        assert!(expected.validate_for_study(&problem.study).is_err());

        configure_project_autosave_policy(&mut problem, OutputDataFormatIR::Zarr, 4.0)
            .expect("existing custom policy must not gain new validation");
        assert_eq!(problem.study.sampling().stage_autosave, Some(expected));
        assert_eq!(explicit.table, None, "resolver must not mutate its input");
    }

    #[test]
    fn explicit_policy_rejects_conflicting_format_without_mutating_sampling() {
        let mut problem = ProblemIR::bootstrap_example();
        let explicit = StageAutosaveIR {
            kind: "stage_autosave".into(),
            target: "custom-primary".into(),
            layout: AutosaveLayoutIR::Separate,
            format: AutosaveFormatIR::Hdf5,
            table: None,
            fields: vec![FieldAutosaveIR {
                kind: "field_autosave".into(),
                quantity: "m".into(),
                every_seconds: Some(1.0),
                sample_period_policy: None,
                every_steps: None,
            }],
        };
        problem.study.sampling_mut().stage_autosave = Some(explicit.clone());
        let sampling_before = problem.study.sampling().clone();

        let error = resolve_project_stage_autosave_policy(
            problem.study.kind(),
            problem.study.sampling(),
            OutputDataFormatIR::Zarr,
            4.0,
        )
        .expect_err("a conflicting explicit format must be rejected");
        assert_eq!(
            error,
            "project data_format conflicts with the explicit stage autosave format"
        );
        assert_eq!(problem.study.sampling(), &sampling_before);

        let wrapper_error =
            configure_project_autosave_policy(&mut problem, OutputDataFormatIR::Zarr, 4.0)
                .expect_err("wrapper must preserve the resolver's format conflict");
        assert_eq!(wrapper_error, error);
        assert_eq!(problem.study.sampling(), &sampling_before);
    }

    #[test]
    fn other_studies_do_not_receive_a_new_autosave_clock() {
        let mut problem = ProblemIR::bootstrap_example();
        let mut sampling = problem.study.sampling().clone();
        sampling.outputs.clear();
        sampling.table_autosave = None;
        sampling.stage_autosave = None;
        problem.study = StudyIR::FieldOnly { sampling };

        assert_eq!(
            resolve_project_stage_autosave_policy(
                crate::StudyKindIR::Eigenmodes,
                problem.study.sampling(),
                OutputDataFormatIR::Hdf5,
                f64::NAN,
            )
            .expect("non-primary study kind should resolve without a clock"),
            None
        );
        configure_project_autosave_policy(&mut problem, OutputDataFormatIR::Hdf5, f64::NAN)
            .expect("field-only studies must keep their existing output contract");
        assert_eq!(problem.study.sampling().stage_autosave, None);
    }
}
