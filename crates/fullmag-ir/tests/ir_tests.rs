use fullmag_ir::*;
use std::collections::{BTreeMap, HashMap};

#[test]
fn bootstrap_example_round_trips_as_json() {
    let ir = ProblemIR::bootstrap_example();
    let json = serde_json::to_string_pretty(&ir).expect("bootstrap example should serialize");
    let decoded: ProblemIR =
        serde_json::from_str(&json).expect("bootstrap example should deserialize");
    assert_eq!(decoded.problem_meta.script_language, "python");
    assert_eq!(decoded.ir_version, IR_VERSION);
    assert_eq!(
        decoded.validation_profile.execution_mode,
        ExecutionMode::Strict
    );
    // Verify Box geometry round-trips
    match &decoded.geometry.entries[0] {
        GeometryEntryIR::Box { name, size } => {
            assert_eq!(name, "strip");
            assert_eq!(size, &[200e-9, 20e-9, 6e-9]);
        }
        other => panic!("expected Box geometry, got {:?}", other),
    }
    // Verify RandomSeeded m0 round-trips
    match &decoded.magnets[0].initial_magnetization {
        Some(InitialMagnetizationIR::RandomSeeded { seed }) => {
            assert_eq!(*seed, 42);
        }
        other => panic!("expected RandomSeeded m0, got {:?}", other),
    }
}

#[test]
fn current_ir_version_is_supported_for_read() {
    assert!(is_supported_ir_version_for_read(CURRENT_IR_VERSION));
    assert!(!requires_ir_migration(CURRENT_IR_VERSION));
}

#[test]
fn magnetostatic_bc_floquet_airbox_round_trips_as_snake_case_json() {
    let json = serde_json::to_string(&MagnetostaticBoundaryConditionIR::FloquetAirbox)
        .expect("floquet_airbox magnetostatic BC should serialize");
    assert_eq!(json, "\"floquet_airbox\"");

    let decoded: MagnetostaticBoundaryConditionIR =
        serde_json::from_str(&json).expect("floquet_airbox magnetostatic BC should deserialize");
    assert_eq!(decoded, MagnetostaticBoundaryConditionIR::FloquetAirbox);
}

#[test]
fn previous_public_ir_version_is_supported_for_read_and_requires_migration() {
    assert!(is_supported_ir_version_for_read(PREVIOUS_PUBLIC_IR_VERSION));
    assert!(requires_ir_migration(PREVIOUS_PUBLIC_IR_VERSION));
}

#[test]
fn problem_ir_deserialize_migrates_previous_public_version() {
    let mut value = serde_json::to_value(ProblemIR::bootstrap_example())
        .expect("bootstrap ProblemIR should serialize");
    value["ir_version"] = serde_json::json!(PREVIOUS_PUBLIC_IR_VERSION);
    value["problem_meta"]["script_api_version"] = serde_json::json!(PREVIOUS_PUBLIC_IR_VERSION);
    value["problem_meta"]["serializer_version"] = serde_json::json!(PREVIOUS_PUBLIC_IR_VERSION);

    let decoded: ProblemIR =
        serde_json::from_value(value).expect("previous public IR should deserialize");

    assert_eq!(decoded.ir_version, CURRENT_IR_VERSION);
    assert_eq!(decoded.problem_meta.script_api_version, CURRENT_IR_VERSION);
    assert_eq!(decoded.problem_meta.serializer_version, CURRENT_IR_VERSION);
    assert!(decoded.validate().is_ok());
}

#[test]
fn previous_public_ir_golden_fixture_migrates_to_current() {
    let fixture = include_str!("../../../tests/golden/problem_ir/bootstrap_v0_1_read_compat.json");
    let decoded: ProblemIR =
        serde_json::from_str(fixture).expect("golden v0.1.0 fixture should migrate");

    assert_eq!(decoded.ir_version, CURRENT_IR_VERSION);
    assert_eq!(decoded.problem_meta.script_api_version, CURRENT_IR_VERSION);
    assert_eq!(decoded.problem_meta.serializer_version, CURRENT_IR_VERSION);
    assert!(decoded.validate().is_ok());
}

#[test]
fn unsupported_ir_version_is_rejected() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.ir_version = "0.0.1".to_string();
    let errors = ir
        .validate()
        .expect_err("unsupported ir_version must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("is not supported for read")));
}

#[test]
fn bootstrap_example_validates() {
    let ir = ProblemIR::bootstrap_example();
    assert!(ir.validate().is_ok());
}

#[test]
fn hysteresis_validation_accepts_field_unit_provenance() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::Hysteresis {
        field_min_mT: Some(-100.0),
        field_max_mT: Some(100.0),
        field_step_mT: Some(10.0),
        field_values_mT: None,
        field_unit_provenance: Some(FieldUnitProvenanceIR {
            authored_quantity: "mu0_h".to_string(),
            authored_unit: "mT".to_string(),
            canonical_quantity: "h_ext".to_string(),
            canonical_unit: "A/m".to_string(),
            display_unit: "mT".to_string(),
            mu0_h_per_m: 1.256_637_061_435_917_2e-6,
        }),
        direction: None,
        orientation: Some(FieldOrientationIR::Preset {
            preset_name: "oop_positive".to_string(),
        }),
        measurement_axis: MeasurementAxisIR::field_axis(),
        angular_family: None,
        initial_protocol: "positive_saturation".to_string(),
        initial_state_ref: None,
        saturation: None,
        branch_mode: "major_loop".to_string(),
        settle_pipeline: None,
        storage: None,
        field_schedule: None,
        schedule_refinements: None,
        adaptive_refinement: None,
        minor_loops: None,
        sampling: SamplingIR {
            outputs: vec![OutputIR::Scalar {
                name: "mz".to_string(),
                every_seconds: 1.0e-12,
            }],
            table_autosave: None,
        },
    };

    ir.validate()
        .expect("canonical hysteresis field unit provenance should validate");
}

#[test]
fn hysteresis_validation_rejects_invalid_field_unit_provenance() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::Hysteresis {
        field_min_mT: Some(-100.0),
        field_max_mT: Some(100.0),
        field_step_mT: Some(10.0),
        field_values_mT: None,
        field_unit_provenance: Some(FieldUnitProvenanceIR {
            authored_quantity: "b_ext".to_string(),
            authored_unit: "T".to_string(),
            canonical_quantity: "b_ext".to_string(),
            canonical_unit: "T".to_string(),
            display_unit: "T".to_string(),
            mu0_h_per_m: 1.0,
        }),
        direction: None,
        orientation: Some(FieldOrientationIR::Preset {
            preset_name: "oop_positive".to_string(),
        }),
        measurement_axis: MeasurementAxisIR::field_axis(),
        angular_family: None,
        initial_protocol: "positive_saturation".to_string(),
        initial_state_ref: None,
        saturation: None,
        branch_mode: "major_loop".to_string(),
        settle_pipeline: None,
        storage: None,
        field_schedule: None,
        schedule_refinements: None,
        adaptive_refinement: None,
        minor_loops: None,
        sampling: SamplingIR {
            outputs: vec![OutputIR::Scalar {
                name: "mz".to_string(),
                every_seconds: 1.0e-12,
            }],
            table_autosave: None,
        },
    };

    let errors = ir
        .validate()
        .expect_err("invalid hysteresis field unit provenance must fail validation");

    for expected in [
        "field_unit_provenance.authored_quantity is unsupported",
        "field_unit_provenance.authored_unit is unsupported",
        "field_unit_provenance.canonical_quantity is unsupported",
        "field_unit_provenance.canonical_unit is unsupported",
        "field_unit_provenance.display_unit is unsupported",
        "field_unit_provenance.mu0_h_per_m must match vacuum permeability",
    ] {
        assert!(
            errors.iter().any(|error| error.contains(expected)),
            "missing validation error containing {expected:?}; errors: {errors:?}"
        );
    }
}

#[test]
fn hysteresis_validation_rejects_invalid_piecewise_schedule() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::Hysteresis {
        field_min_mT: None,
        field_max_mT: None,
        field_step_mT: None,
        field_values_mT: None,
        field_unit_provenance: None,
        direction: None,
        orientation: Some(FieldOrientationIR::Preset {
            preset_name: "oop_positive".to_string(),
        }),
        measurement_axis: MeasurementAxisIR::field_axis(),
        angular_family: None,
        initial_protocol: "positive_saturation".to_string(),
        initial_state_ref: None,
        saturation: None,
        branch_mode: "major_loop".to_string(),
        settle_pipeline: None,
        storage: None,
        field_schedule: Some(FieldScheduleIR {
            segments: vec![FieldSegmentIR {
                segment_id: "negative_step".to_string(),
                start: 100.0,
                stop: 0.0,
                step: -5.0,
                label: "negative_step".to_string(),
                endpoint_policy: "include_stop".to_string(),
                reason: "test".to_string(),
            }],
        }),
        schedule_refinements: None,
        adaptive_refinement: None,
        minor_loops: None,
        sampling: SamplingIR {
            outputs: vec![OutputIR::Scalar {
                name: "mz".to_string(),
                every_seconds: 1.0e-12,
            }],
            table_autosave: None,
        },
    };

    let errors = ir
        .validate()
        .expect_err("bad piecewise schedule must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("field_schedule.segments[0].step must be positive")));
}

#[test]
fn hysteresis_validation_rejects_overlapping_dense_windows_without_priority() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::Hysteresis {
        field_min_mT: Some(-100.0),
        field_max_mT: Some(100.0),
        field_step_mT: Some(10.0),
        field_values_mT: None,
        field_unit_provenance: None,
        direction: None,
        orientation: Some(FieldOrientationIR::Preset {
            preset_name: "oop_positive".to_string(),
        }),
        measurement_axis: MeasurementAxisIR::field_axis(),
        angular_family: None,
        initial_protocol: "positive_saturation".to_string(),
        initial_state_ref: None,
        saturation: None,
        branch_mode: "major_loop".to_string(),
        settle_pipeline: None,
        storage: None,
        field_schedule: None,
        schedule_refinements: Some(vec![
            FieldWindowIR {
                center_mT: 0.0,
                half_width_mT: 10.0,
                step_mT: 1.0,
                reason: "remanence".to_string(),
                priority: None,
            },
            FieldWindowIR {
                center_mT: 5.0,
                half_width_mT: 10.0,
                step_mT: 0.5,
                reason: "coercivity".to_string(),
                priority: None,
            },
        ]),
        adaptive_refinement: None,
        minor_loops: None,
        sampling: SamplingIR {
            outputs: vec![OutputIR::Scalar {
                name: "mz".to_string(),
                every_seconds: 1.0e-12,
            }],
            table_autosave: None,
        },
    };

    let errors = ir
        .validate()
        .expect_err("overlapping dense windows without priority must fail validation");
    assert!(errors.iter().any(|error| {
        error.contains("schedule_refinements[1] overlaps schedule_refinements[0]")
    }));
}

#[test]
fn hysteresis_validation_accepts_major_with_minor_loops_branch_mode() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::Hysteresis {
        field_min_mT: Some(-100.0),
        field_max_mT: Some(100.0),
        field_step_mT: Some(10.0),
        field_values_mT: None,
        field_unit_provenance: None,
        direction: None,
        orientation: Some(FieldOrientationIR::Preset {
            preset_name: "oop_positive".to_string(),
        }),
        measurement_axis: MeasurementAxisIR::field_axis(),
        angular_family: None,
        initial_protocol: "positive_saturation".to_string(),
        initial_state_ref: None,
        saturation: None,
        branch_mode: "major_with_minor_loops".to_string(),
        settle_pipeline: None,
        storage: None,
        field_schedule: None,
        schedule_refinements: None,
        adaptive_refinement: None,
        minor_loops: Some(vec![MinorLoopIR {
            reversal_mT: 25.0,
            return_mT: -25.0,
            intermediate_fields_mT: Vec::new(),
            continuation_policy: "branch_only".to_string(),
        }]),
        sampling: SamplingIR {
            outputs: vec![OutputIR::Field {
                name: "m".to_string(),
                every_seconds: 1e-12,
            }],
            table_autosave: None,
        },
    };

    if let Err(errors) = ir.validate() {
        panic!("major_with_minor_loops should validate, got errors: {errors:?}");
    }
}

#[test]
fn hysteresis_minor_loop_defaults_continuation_policy_to_branch_only() {
    let minor_loop: MinorLoopIR = serde_json::from_value(serde_json::json!({
        "reversal_mT": 25.0,
        "return_mT": -25.0
    }))
    .expect("minor loop without continuation_policy should deserialize");

    assert_eq!(minor_loop.continuation_policy, "branch_only");
}

#[test]
fn hysteresis_validation_accepts_replace_parent_minor_loop_continuation_policy() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::Hysteresis {
        field_min_mT: Some(-100.0),
        field_max_mT: Some(100.0),
        field_step_mT: Some(10.0),
        field_values_mT: None,
        field_unit_provenance: None,
        direction: None,
        orientation: None,
        measurement_axis: MeasurementAxisIR::field_axis(),
        angular_family: None,
        initial_protocol: "as_authored".to_string(),
        initial_state_ref: None,
        saturation: None,
        branch_mode: "major_with_minor_loops".to_string(),
        settle_pipeline: None,
        storage: None,
        field_schedule: None,
        schedule_refinements: None,
        adaptive_refinement: None,
        minor_loops: Some(vec![MinorLoopIR {
            reversal_mT: 25.0,
            return_mT: -25.0,
            intermediate_fields_mT: Vec::new(),
            continuation_policy: "replace_parent".to_string(),
        }]),
        sampling: SamplingIR {
            outputs: vec![OutputIR::Scalar {
                name: "mz".to_string(),
                every_seconds: 1.0e-12,
            }],
            table_autosave: None,
        },
    };

    if let Err(errors) = ir.validate() {
        panic!("replace_parent minor-loop continuation policy should validate, got {errors:?}");
    }
}

#[test]
fn hysteresis_validation_accepts_minor_loop_intermediate_fields() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::Hysteresis {
        field_min_mT: Some(-100.0),
        field_max_mT: Some(100.0),
        field_step_mT: Some(10.0),
        field_values_mT: None,
        field_unit_provenance: None,
        direction: None,
        orientation: None,
        measurement_axis: MeasurementAxisIR::field_axis(),
        angular_family: None,
        initial_protocol: "as_authored".to_string(),
        initial_state_ref: None,
        saturation: None,
        branch_mode: "major_with_minor_loops".to_string(),
        settle_pipeline: None,
        storage: None,
        field_schedule: None,
        schedule_refinements: None,
        adaptive_refinement: None,
        minor_loops: Some(vec![MinorLoopIR {
            reversal_mT: 50.0,
            return_mT: -50.0,
            intermediate_fields_mT: vec![0.0],
            continuation_policy: "branch_only".to_string(),
        }]),
        sampling: SamplingIR {
            outputs: vec![OutputIR::Scalar {
                name: "mz".to_string(),
                every_seconds: 1.0e-12,
            }],
            table_autosave: None,
        },
    };

    if let Err(errors) = ir.validate() {
        panic!("minor-loop intermediate fields should validate, got {errors:?}");
    }
}

#[test]
fn hysteresis_validation_rejects_duplicate_minor_loop_intermediate_boundary() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::Hysteresis {
        field_min_mT: Some(-100.0),
        field_max_mT: Some(100.0),
        field_step_mT: Some(10.0),
        field_values_mT: None,
        field_unit_provenance: None,
        direction: None,
        orientation: None,
        measurement_axis: MeasurementAxisIR::field_axis(),
        angular_family: None,
        initial_protocol: "as_authored".to_string(),
        initial_state_ref: None,
        saturation: None,
        branch_mode: "major_with_minor_loops".to_string(),
        settle_pipeline: None,
        storage: None,
        field_schedule: None,
        schedule_refinements: None,
        adaptive_refinement: None,
        minor_loops: Some(vec![MinorLoopIR {
            reversal_mT: 50.0,
            return_mT: -50.0,
            intermediate_fields_mT: vec![50.0],
            continuation_policy: "branch_only".to_string(),
        }]),
        sampling: SamplingIR {
            outputs: vec![OutputIR::Scalar {
                name: "mz".to_string(),
                every_seconds: 1.0e-12,
            }],
            table_autosave: None,
        },
    };

    let errors = ir
        .validate()
        .expect_err("duplicate minor-loop intermediate boundary must fail validation");
    assert!(
        errors.iter().any(|error| error.contains(
            "study.stages[].hysteresis.minor_loops[0] intermediate_fields_mT must not repeat adjacent fields"
        )),
        "expected intermediate field validation error, got {errors:?}"
    );
}

#[test]
fn hysteresis_validation_rejects_unknown_minor_loop_continuation_policy() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::Hysteresis {
        field_min_mT: Some(-100.0),
        field_max_mT: Some(100.0),
        field_step_mT: Some(10.0),
        field_values_mT: None,
        field_unit_provenance: None,
        direction: None,
        orientation: None,
        measurement_axis: MeasurementAxisIR::field_axis(),
        angular_family: None,
        initial_protocol: "as_authored".to_string(),
        initial_state_ref: None,
        saturation: None,
        branch_mode: "major_with_minor_loops".to_string(),
        settle_pipeline: None,
        storage: None,
        field_schedule: None,
        schedule_refinements: None,
        adaptive_refinement: None,
        minor_loops: Some(vec![MinorLoopIR {
            reversal_mT: 25.0,
            return_mT: -25.0,
            intermediate_fields_mT: Vec::new(),
            continuation_policy: "teleport_parent".to_string(),
        }]),
        sampling: SamplingIR {
            outputs: vec![OutputIR::Scalar {
                name: "mz".to_string(),
                every_seconds: 1.0e-12,
            }],
            table_autosave: None,
        },
    };

    let errors = ir
        .validate()
        .expect_err("unknown minor-loop continuation policy must fail validation");
    assert!(
        errors.iter().any(|error| error.contains(
            "study.stages[].hysteresis.minor_loops[0] continuation_policy must be one of"
        )),
        "expected continuation policy validation error, got {errors:?}"
    );
}

#[test]
fn hysteresis_validation_rejects_run_next_algorithm_without_next_step() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::Hysteresis {
        field_min_mT: Some(-100.0),
        field_max_mT: Some(100.0),
        field_step_mT: Some(10.0),
        field_values_mT: None,
        field_unit_provenance: None,
        direction: None,
        orientation: Some(FieldOrientationIR::Preset {
            preset_name: "oop_positive".to_string(),
        }),
        measurement_axis: MeasurementAxisIR::field_axis(),
        angular_family: None,
        initial_protocol: "positive_saturation".to_string(),
        initial_state_ref: None,
        saturation: None,
        branch_mode: "major_loop".to_string(),
        settle_pipeline: Some(SettlePipelineIR::Sequence {
            steps: vec![SettleStepIR::Minimize {
                method: "projected_gradient_bb".to_string(),
                torque_tolerance: 5e-5,
                energy_tolerance: 1e-20,
                max_steps: 2000,
                applies_to: None,
                stop_criteria: None,
                timestep_s: None,
                max_pseudotime_s: None,
                max_physical_time_s: None,
                on_non_convergence: "run_next_algorithm".to_string(),
                retry_timestep_scale: None,
                retry_max_attempts: None,
            }],
        }),
        storage: None,
        field_schedule: None,
        schedule_refinements: None,
        adaptive_refinement: None,
        minor_loops: None,
        sampling: SamplingIR {
            outputs: vec![OutputIR::Scalar {
                name: "mz".to_string(),
                every_seconds: 1.0e-12,
            }],
            table_autosave: None,
        },
    };

    let errors = ir
        .validate()
        .expect_err("run_next_algorithm without a following step must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("run_next_algorithm requires a following step")));
}

#[test]
fn hysteresis_validation_rejects_run_next_algorithm_tree_without_fallback_branch() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::Hysteresis {
        field_min_mT: Some(-100.0),
        field_max_mT: Some(100.0),
        field_step_mT: Some(10.0),
        field_values_mT: None,
        field_unit_provenance: None,
        direction: None,
        orientation: Some(FieldOrientationIR::Preset {
            preset_name: "oop_positive".to_string(),
        }),
        measurement_axis: MeasurementAxisIR::field_axis(),
        angular_family: None,
        initial_protocol: "positive_saturation".to_string(),
        initial_state_ref: None,
        saturation: None,
        branch_mode: "major_loop".to_string(),
        settle_pipeline: Some(SettlePipelineIR::Tree {
            default: SettleStepIR::Minimize {
                method: "projected_gradient_bb".to_string(),
                torque_tolerance: 5e-5,
                energy_tolerance: 1e-20,
                max_steps: 2000,
                applies_to: None,
                stop_criteria: None,
                timestep_s: None,
                max_pseudotime_s: None,
                max_physical_time_s: None,
                on_non_convergence: "run_next_algorithm".to_string(),
                retry_timestep_scale: None,
                retry_max_attempts: None,
            },
            branches: vec![],
        }),
        storage: None,
        field_schedule: None,
        schedule_refinements: None,
        adaptive_refinement: None,
        minor_loops: None,
        sampling: SamplingIR {
            outputs: vec![OutputIR::Scalar {
                name: "mz".to_string(),
                every_seconds: 1.0e-12,
            }],
            table_autosave: None,
        },
    };

    let errors = ir
        .validate()
        .expect_err("run_next_algorithm tree without fallback branch must fail validation");
    assert!(
        errors
            .iter()
            .any(|error| error
                .contains("run_next_algorithm requires a non_converged fallback branch"))
    );
}

#[test]
fn hysteresis_validation_rejects_retry_with_smaller_dt_without_scale() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::Hysteresis {
        field_min_mT: Some(-100.0),
        field_max_mT: Some(100.0),
        field_step_mT: Some(10.0),
        field_values_mT: None,
        field_unit_provenance: None,
        direction: None,
        orientation: Some(FieldOrientationIR::Preset {
            preset_name: "oop_positive".to_string(),
        }),
        measurement_axis: MeasurementAxisIR::field_axis(),
        angular_family: None,
        initial_protocol: "positive_saturation".to_string(),
        initial_state_ref: None,
        saturation: None,
        branch_mode: "major_loop".to_string(),
        settle_pipeline: Some(SettlePipelineIR::Sequence {
            steps: vec![SettleStepIR::Relax {
                method: "llg_overdamped".to_string(),
                alpha: 1.0,
                torque_tolerance: 1e-5,
                max_steps: 100,
                applies_to: None,
                stop_criteria: None,
                timestep_s: None,
                max_pseudotime_s: None,
                max_physical_time_s: None,
                on_non_convergence: "retry_with_smaller_dt".to_string(),
                retry_timestep_scale: None,
                retry_max_attempts: Some(1),
            }],
        }),
        storage: None,
        field_schedule: None,
        schedule_refinements: None,
        adaptive_refinement: None,
        minor_loops: None,
        sampling: SamplingIR {
            outputs: vec![OutputIR::Scalar {
                name: "mz".to_string(),
                every_seconds: 1.0e-12,
            }],
            table_autosave: None,
        },
    };

    let errors = ir
        .validate()
        .expect_err("retry_with_smaller_dt without scale must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("retry_with_smaller_dt requires retry_timestep_scale")));
}

#[test]
fn hysteresis_validation_rejects_invalid_settle_step_selection_contract() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::Hysteresis {
        field_min_mT: Some(-100.0),
        field_max_mT: Some(100.0),
        field_step_mT: Some(10.0),
        field_values_mT: None,
        field_unit_provenance: None,
        direction: None,
        orientation: Some(FieldOrientationIR::Preset {
            preset_name: "oop_positive".to_string(),
        }),
        measurement_axis: MeasurementAxisIR::field_axis(),
        angular_family: None,
        initial_protocol: "positive_saturation".to_string(),
        initial_state_ref: None,
        saturation: None,
        branch_mode: "major_loop".to_string(),
        settle_pipeline: Some(SettlePipelineIR::Sequence {
            steps: vec![SettleStepIR::Relax {
                method: "llg_overdamped".to_string(),
                alpha: 1.0,
                torque_tolerance: 1e-5,
                max_steps: 100,
                applies_to: Some(serde_json::json!("branch_id")),
                stop_criteria: Some(serde_json::json!({
                    "kind": "any_of",
                    "criteria": ["torque_below", "unknown_stop"]
                })),
                timestep_s: None,
                max_pseudotime_s: None,
                max_physical_time_s: None,
                on_non_convergence: "continue_with_warning".to_string(),
                retry_timestep_scale: None,
                retry_max_attempts: None,
            }],
        }),
        storage: None,
        field_schedule: None,
        schedule_refinements: None,
        adaptive_refinement: None,
        minor_loops: None,
        sampling: SamplingIR {
            outputs: vec![OutputIR::Scalar {
                name: "mz".to_string(),
                every_seconds: 1.0e-12,
            }],
            table_autosave: None,
        },
    };

    let errors = ir
        .validate()
        .expect_err("invalid settle step selection contract must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("settle_pipeline.steps[0].applies_to")));
    assert!(errors
        .iter()
        .any(|error| error.contains("settle_pipeline.steps[0].stop_criteria")));
}

#[test]
fn hysteresis_validation_rejects_direct_minimizer_physical_time_budget() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::Hysteresis {
        field_min_mT: Some(-100.0),
        field_max_mT: Some(100.0),
        field_step_mT: Some(10.0),
        field_values_mT: None,
        field_unit_provenance: None,
        direction: None,
        orientation: Some(FieldOrientationIR::Preset {
            preset_name: "oop_positive".to_string(),
        }),
        measurement_axis: MeasurementAxisIR::field_axis(),
        angular_family: None,
        initial_protocol: "positive_saturation".to_string(),
        initial_state_ref: None,
        saturation: None,
        branch_mode: "major_loop".to_string(),
        settle_pipeline: Some(SettlePipelineIR::Sequence {
            steps: vec![SettleStepIR::Minimize {
                method: "projected_gradient_bb".to_string(),
                torque_tolerance: 5e-5,
                energy_tolerance: 1e-20,
                max_steps: 100,
                applies_to: None,
                stop_criteria: None,
                timestep_s: None,
                max_pseudotime_s: None,
                max_physical_time_s: Some(1e-9),
                on_non_convergence: "continue_with_warning".to_string(),
                retry_timestep_scale: None,
                retry_max_attempts: None,
            }],
        }),
        storage: None,
        field_schedule: None,
        schedule_refinements: None,
        adaptive_refinement: None,
        minor_loops: None,
        sampling: SamplingIR {
            outputs: vec![OutputIR::Scalar {
                name: "mz".to_string(),
                every_seconds: 1.0e-12,
            }],
            table_autosave: None,
        },
    };

    let errors = ir
        .validate()
        .expect_err("direct minimizer settle steps must reject physical time");
    assert!(errors.iter().any(|error| {
        error.contains("settle_pipeline.steps[0].max_physical_time_s")
            && error.contains("projected_gradient_bb")
            && error.contains("direct minimizer")
            && error.contains("max_pseudotime_s")
            && error.contains("llg_overdamped")
    }));
}

#[test]
fn hysteresis_validation_rejects_dynamics_settle_stop_criteria() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::Hysteresis {
        field_min_mT: Some(-100.0),
        field_max_mT: Some(100.0),
        field_step_mT: Some(10.0),
        field_values_mT: None,
        field_unit_provenance: None,
        direction: None,
        orientation: Some(FieldOrientationIR::Preset {
            preset_name: "oop_positive".to_string(),
        }),
        measurement_axis: MeasurementAxisIR::field_axis(),
        angular_family: None,
        initial_protocol: "positive_saturation".to_string(),
        initial_state_ref: None,
        saturation: None,
        branch_mode: "major_loop".to_string(),
        settle_pipeline: Some(SettlePipelineIR::Sequence {
            steps: vec![SettleStepIR::DynamicsSettle {
                method: "heun_dynamics_settle".to_string(),
                damping: 1.0,
                max_steps: 100,
                applies_to: None,
                stop_criteria: Some(serde_json::json!("torque_below")),
                timestep_s: None,
                max_pseudotime_s: None,
                max_physical_time_s: None,
                on_non_convergence: "continue_with_warning".to_string(),
                retry_timestep_scale: None,
                retry_max_attempts: None,
            }],
        }),
        storage: None,
        field_schedule: None,
        schedule_refinements: None,
        adaptive_refinement: None,
        minor_loops: None,
        sampling: SamplingIR {
            outputs: vec![OutputIR::Scalar {
                name: "mz".to_string(),
                every_seconds: 1.0e-12,
            }],
            table_autosave: None,
        },
    };

    let errors = ir
        .validate()
        .expect_err("dynamics-settle stop_criteria must not be accepted when ignored");
    assert!(errors.iter().any(|error| {
        error.contains("settle_pipeline.steps[0].stop_criteria")
            && error.contains("DynamicsSettle")
            && error.contains("duration-based")
    }));
}

#[test]
fn hysteresis_validation_rejects_invalid_public_contract_values() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::Hysteresis {
        field_min_mT: Some(f64::NAN),
        field_max_mT: Some(100.0),
        field_step_mT: Some(10.0),
        field_values_mT: Some(vec![0.0, f64::INFINITY]),
        field_unit_provenance: None,
        direction: Some([0.0, f64::NAN, 1.0]),
        orientation: Some(FieldOrientationIR::Global {
            vector: [0.0, 0.0, 0.0],
        }),
        measurement_axis: MeasurementAxisIR::Named("sideways".to_string()),
        angular_family: None,
        initial_protocol: "mystery".to_string(),
        initial_state_ref: None,
        saturation: Some(SaturationProbeIR {
            mode: "".to_string(),
            max_field_mT: f64::NAN,
            susceptibility_threshold: -1.0,
            transverse_threshold: 0.0,
            on_failure: "pretend_saturated".to_string(),
        }),
        branch_mode: "minor_loop".to_string(),
        settle_pipeline: Some(SettlePipelineIR::Sequence {
            steps: vec![SettleStepIR::Relax {
                method: "".to_string(),
                alpha: 1.0,
                torque_tolerance: 1e-5,
                max_steps: 1,
                applies_to: None,
                stop_criteria: None,
                timestep_s: Some(0.0),
                max_pseudotime_s: Some(f64::NAN),
                max_physical_time_s: Some(-1.0),
                on_non_convergence: "continue_with_warning".to_string(),
                retry_timestep_scale: None,
                retry_max_attempts: None,
            }],
        }),
        storage: Some(HysteresisStorageIR {
            scalar_history: true,
            magnetization: "selected".to_string(),
            every_n: 0,
            key_events: true,
            key_event_threshold_dm: f64::NAN,
        }),
        field_schedule: None,
        schedule_refinements: None,
        adaptive_refinement: None,
        minor_loops: Some(vec![MinorLoopIR {
            reversal_mT: 10.0,
            return_mT: 10.0,
            intermediate_fields_mT: Vec::new(),
            continuation_policy: "branch_only".to_string(),
        }]),
        sampling: SamplingIR {
            outputs: vec![OutputIR::Scalar {
                name: "mz".to_string(),
                every_seconds: 1.0e-12,
            }],
            table_autosave: None,
        },
    };

    let errors = ir
        .validate()
        .expect_err("invalid hysteresis contract values must fail validation");

    for expected in [
        "field_min_mT must be finite",
        "field_values_mT[1] must be finite",
        "direction must contain finite values",
        "orientation global vector must not be zero",
        "measurement_axis is unsupported",
        "initial_protocol is unsupported",
        "saturation.mode must not be empty",
        "saturation.max_field_mT must be finite and positive",
        "saturation.on_failure is unsupported",
        "branch_mode is unsupported",
        "settle_pipeline.steps[0].method must not be empty",
        "settle_pipeline.steps[0].timestep_s must be finite and positive",
        "settle_pipeline.steps[0].max_pseudotime_s must be finite and positive",
        "settle_pipeline.steps[0].max_physical_time_s must be finite and positive",
        "storage.every_n must be positive",
        "storage.key_event_threshold_dm must be finite and positive",
        "minor_loops[0] reversal_mT and return_mT must differ",
    ] {
        assert!(
            errors.iter().any(|error| error.contains(expected)),
            "missing validation error containing {expected:?}; errors: {errors:?}"
        );
    }
}

#[test]
fn hysteresis_validation_accepts_custom_measurement_axis_vector() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::Hysteresis {
        field_min_mT: Some(-100.0),
        field_max_mT: Some(100.0),
        field_step_mT: Some(10.0),
        field_values_mT: None,
        field_unit_provenance: None,
        direction: None,
        orientation: Some(FieldOrientationIR::Sample {
            theta: 90.0,
            phi: 35.0,
        }),
        measurement_axis: MeasurementAxisIR::Custom {
            kind: "custom".to_string(),
            vector: [0.0, 3.0, 4.0],
        },
        angular_family: None,
        initial_protocol: "positive_saturation".to_string(),
        initial_state_ref: None,
        saturation: None,
        branch_mode: "major_loop".to_string(),
        settle_pipeline: None,
        storage: None,
        field_schedule: None,
        schedule_refinements: None,
        adaptive_refinement: None,
        minor_loops: None,
        sampling: SamplingIR {
            outputs: vec![OutputIR::Scalar {
                name: "mz".to_string(),
                every_seconds: 1.0e-12,
            }],
            table_autosave: None,
        },
    };

    ir.validate()
        .expect("custom hysteresis measurement axis vector should validate");
}

#[test]
fn hysteresis_validation_accepts_checkpoint_with_initial_state_ref() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::Hysteresis {
        field_min_mT: Some(-100.0),
        field_max_mT: Some(100.0),
        field_step_mT: Some(10.0),
        field_values_mT: None,
        field_unit_provenance: None,
        direction: None,
        orientation: Some(FieldOrientationIR::Sample {
            theta: 0.0,
            phi: 0.0,
        }),
        measurement_axis: MeasurementAxisIR::field_axis(),
        angular_family: None,
        initial_protocol: "checkpoint".to_string(),
        initial_state_ref: Some("hysteresis_snapshots/hysteresis_point_003/m.json".to_string()),
        saturation: None,
        branch_mode: "major_loop".to_string(),
        settle_pipeline: None,
        storage: None,
        field_schedule: None,
        schedule_refinements: None,
        adaptive_refinement: None,
        minor_loops: None,
        sampling: SamplingIR {
            outputs: vec![OutputIR::Scalar {
                name: "mz".to_string(),
                every_seconds: 1.0e-12,
            }],
            table_autosave: None,
        },
    };

    ir.validate()
        .expect("checkpoint hysteresis start with initial_state_ref should validate");
}

#[test]
fn hysteresis_validation_rejects_checkpoint_without_initial_state_ref() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::Hysteresis {
        field_min_mT: Some(-100.0),
        field_max_mT: Some(100.0),
        field_step_mT: Some(10.0),
        field_values_mT: None,
        field_unit_provenance: None,
        direction: None,
        orientation: Some(FieldOrientationIR::Sample {
            theta: 0.0,
            phi: 0.0,
        }),
        measurement_axis: MeasurementAxisIR::field_axis(),
        angular_family: None,
        initial_protocol: "checkpoint".to_string(),
        initial_state_ref: None,
        saturation: None,
        branch_mode: "major_loop".to_string(),
        settle_pipeline: None,
        storage: None,
        field_schedule: None,
        schedule_refinements: None,
        adaptive_refinement: None,
        minor_loops: None,
        sampling: SamplingIR {
            outputs: vec![],
            table_autosave: None,
        },
    };

    let errors = ir
        .validate()
        .expect_err("checkpoint hysteresis start without initial_state_ref must fail");
    assert!(errors.iter().any(|error| {
        error.contains("initial_state_ref is required when initial_protocol is checkpoint")
    }));
}

#[test]
fn hysteresis_validation_rejects_zero_custom_measurement_axis_vector() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::Hysteresis {
        field_min_mT: Some(-100.0),
        field_max_mT: Some(100.0),
        field_step_mT: Some(10.0),
        field_values_mT: None,
        field_unit_provenance: None,
        direction: None,
        orientation: Some(FieldOrientationIR::Sample {
            theta: 90.0,
            phi: 35.0,
        }),
        measurement_axis: MeasurementAxisIR::Custom {
            kind: "custom".to_string(),
            vector: [0.0, 0.0, 0.0],
        },
        angular_family: None,
        initial_protocol: "positive_saturation".to_string(),
        initial_state_ref: None,
        saturation: None,
        branch_mode: "major_loop".to_string(),
        settle_pipeline: None,
        storage: None,
        field_schedule: None,
        schedule_refinements: None,
        adaptive_refinement: None,
        minor_loops: None,
        sampling: SamplingIR {
            outputs: vec![],
            table_autosave: None,
        },
    };

    let errors = ir
        .validate()
        .expect_err("zero custom hysteresis measurement axis vector must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("measurement_axis custom vector must not be zero")));
}

#[test]
fn region_owned_ir_defaults_are_empty_for_legacy_payloads() {
    let ir = ProblemIR::bootstrap_example();
    let json = serde_json::to_string(&ir).expect("bootstrap should serialize");
    let decoded: ProblemIR = serde_json::from_str(&json).expect("bootstrap should deserialize");

    assert!(decoded.object_regions.is_empty());
    assert!(decoded.material_parameter_fields.is_empty());
    assert!(decoded.couplings.is_empty());
}

#[test]
fn fem_domain_mesh_asset_rejects_object_region_marker_id_collisions() {
    let asset = FemDomainMeshAssetIR {
        mesh_source: Some("domain.json".to_string()),
        mesh: None,
        region_markers: vec![FemDomainRegionMarkerIR {
            geometry_name: "film".to_string(),
            marker: 1,
        }],
        object_region_markers: vec![FemDomainRegionMarkerIR {
            geometry_name: "film:core".to_string(),
            marker: 1,
        }],
        build_report: None,
    };

    let errors = asset
        .validate()
        .expect_err("object-region markers must not collide with object markers");
    assert!(errors.iter().any(|error| {
        error.contains("object_region_markers marker 1 duplicates a region_markers marker")
    }));
}

#[test]
fn object_region_without_overrides_is_continuous_with_parent_object() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.object_regions.push(ObjectRegionIR {
        region_id: "reg_strip_core".to_string(),
        owner_object: "strip".to_string(),
        name: "core".to_string(),
        shape: RegionShapeIR::Box {
            size: [10e-9, 10e-9, 6e-9],
            center: [0.0, 0.0, 0.0],
        },
        frame: RegionFrameIR::Object,
        enabled: true,
        priority: 0,
        mesh_policy: None,
        material_overrides: Vec::new(),
        texture_override: None,
        material_transition: None,
        realization_policy: RegionRealizationPolicyIR::Inherit,
    });

    assert!(ir.validate().is_ok());
    assert!(
        ir.material_parameter_fields.is_empty(),
        "a region that only identifies a sub-volume must inherit parent material parameters"
    );
    assert!(
        ir.couplings.is_empty(),
        "a region inside one object must not imply an object-object or RKKY coupling"
    );
}

#[test]
fn object_region_material_field_and_coupling_validate() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.object_regions.push(ObjectRegionIR {
        region_id: "reg_strip_core".to_string(),
        owner_object: "strip".to_string(),
        name: "core".to_string(),
        shape: RegionShapeIR::Cylinder {
            radius: 20e-9,
            height: 6e-9,
            center: [0.0, 0.0, 0.0],
            axis: [0.0, 0.0, 1.0],
        },
        frame: RegionFrameIR::Object,
        enabled: true,
        priority: 10,
        mesh_policy: Some(RegionMeshPolicyIR {
            maximum_element_size: Some(1e-9),
            minimum_element_size: Some(1e-9),
            transition_distance: Some(80e-9),
            order: Some(1),
        }),
        material_overrides: vec![RegionMaterialOverrideIR {
            parameter: MaterialParameterNameIR::Ms,
            value: MaterialParameterFieldIR::Constant {
                value: serde_json::json!(750e3),
                unit: Some("A/m".to_string()),
            },
            priority: 10,
            conflict_policy: RegionConflictPolicyIR::Error,
        }],
        texture_override: None,
        material_transition: None,
        realization_policy: RegionRealizationPolicyIR::Inherit,
    });
    ir.material_parameter_fields
        .push(MaterialParameterAssignmentIR {
            assignment_id: "ms_gradient".to_string(),
            owner_object: "strip".to_string(),
            region_id: None,
            parameter: MaterialParameterNameIR::Ms,
            value: MaterialParameterFieldIR::Linear {
                base: 800e3,
                gradient: [0.0, 1.0e11, 0.0],
                frame: RegionFrameIR::Object,
                unit: Some("A/m".to_string()),
            },
            priority: 0,
            conflict_policy: RegionConflictPolicyIR::Error,
        });
    ir.couplings.push(CouplingIR {
        coupling_id: "strip_surface_exchange".to_string(),
        kind: CouplingKindIR::Exchange,
        source: CouplingEndpointIR::Surface {
            object: "strip".to_string(),
            selector: "top".to_string(),
        },
        target: CouplingEndpointIR::Surface {
            object: "strip".to_string(),
            selector: "bottom".to_string(),
        },
        enabled: true,
        parameters: CouplingParametersIR::Exchange {
            mode: ExchangeCouplingModeIR::HarmonicMean,
            scale: Some(0.5),
            inter_exchange: None,
        },
        capability_policy: CouplingCapabilityPolicyIR::RequireRuntime,
    });

    assert!(ir.validate().is_ok());
}

#[test]
fn object_region_ms_zero_is_rejected() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.object_regions.push(ObjectRegionIR {
        region_id: "reg_zero_ms".to_string(),
        owner_object: "strip".to_string(),
        name: "zero_ms".to_string(),
        shape: RegionShapeIR::Box {
            size: [10e-9, 10e-9, 6e-9],
            center: [0.0, 0.0, 0.0],
        },
        frame: RegionFrameIR::Object,
        enabled: true,
        priority: 0,
        mesh_policy: None,
        material_overrides: vec![RegionMaterialOverrideIR {
            parameter: MaterialParameterNameIR::Ms,
            value: MaterialParameterFieldIR::Constant {
                value: serde_json::json!(0.0),
                unit: Some("A/m".to_string()),
            },
            priority: 0,
            conflict_policy: RegionConflictPolicyIR::Error,
        }],
        texture_override: None,
        material_transition: None,
        realization_policy: RegionRealizationPolicyIR::Inherit,
    });

    let errors = ir
        .validate()
        .expect_err("Ms=0 inside an active object must be rejected");
    assert!(errors.iter().any(|error| error.contains("Ms must be > 0")));
}

#[test]
fn object_region_texture_override_initial_magnetization_is_validated() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.object_regions.push(ObjectRegionIR {
        region_id: "reg_bad_texture".to_string(),
        owner_object: "strip".to_string(),
        name: "bad_texture".to_string(),
        shape: RegionShapeIR::Box {
            size: [10e-9, 10e-9, 6e-9],
            center: [0.0, 0.0, 0.0],
        },
        frame: RegionFrameIR::Object,
        enabled: true,
        priority: 0,
        mesh_policy: None,
        material_overrides: Vec::new(),
        texture_override: Some(RegionTextureOverrideIR {
            initial_magnetization: InitialMagnetizationIR::PresetTexture {
                preset_kind: "".to_string(),
                preset_params: Default::default(),
                mapping: Default::default(),
                texture_transform: Default::default(),
            },
        }),
        material_transition: None,
        realization_policy: RegionRealizationPolicyIR::Inherit,
    });

    let errors = ir
        .validate()
        .expect_err("region texture override initial magnetization must be validated");
    assert!(errors.iter().any(|error| {
        error.contains("object_regions[0].texture_override.initial_magnetization")
            && error.contains("preset_texture preset_kind must not be empty")
    }));
}

#[test]
fn object_region_material_transition_round_trips() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.object_regions.push(ObjectRegionIR {
        region_id: "reg_soft_transition".to_string(),
        owner_object: "strip".to_string(),
        name: "soft_transition".to_string(),
        shape: RegionShapeIR::Box {
            size: [10e-9, 10e-9, 6e-9],
            center: [0.0, 0.0, 0.0],
        },
        frame: RegionFrameIR::Object,
        enabled: true,
        priority: 0,
        mesh_policy: None,
        material_overrides: Vec::new(),
        texture_override: None,
        material_transition: Some(MaterialTransitionSpecIR::MeshRelative {
            cells: 3,
            scope: MaterialTransitionScopeIR::Boundary,
        }),
        realization_policy: RegionRealizationPolicyIR::Inherit,
    });

    let json = serde_json::to_string(&ir).expect("ProblemIR should serialize");
    assert!(json.contains(r#""kind":"mesh_relative""#));
    assert!(json.contains(r#""cells":3"#));
    assert!(json.contains(r#""scope":"boundary""#));
    let decoded: ProblemIR = serde_json::from_str(&json).expect("ProblemIR should deserialize");
    assert_eq!(
        decoded.object_regions[0].material_transition,
        Some(MaterialTransitionSpecIR::MeshRelative {
            cells: 3,
            scope: MaterialTransitionScopeIR::Boundary,
        })
    );
    decoded
        .validate()
        .expect("valid transition must pass IR validation");
}

#[test]
fn object_region_material_transition_invalid_widths_are_rejected() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.object_regions.push(ObjectRegionIR {
        region_id: "reg_bad_transition".to_string(),
        owner_object: "strip".to_string(),
        name: "bad_transition".to_string(),
        shape: RegionShapeIR::Box {
            size: [10e-9, 10e-9, 6e-9],
            center: [0.0, 0.0, 0.0],
        },
        frame: RegionFrameIR::Object,
        enabled: true,
        priority: 0,
        mesh_policy: None,
        material_overrides: Vec::new(),
        texture_override: None,
        material_transition: Some(MaterialTransitionSpecIR::MeshRelative {
            cells: 0,
            scope: MaterialTransitionScopeIR::Boundary,
        }),
        realization_policy: RegionRealizationPolicyIR::Inherit,
    });
    ir.object_regions.push(ObjectRegionIR {
        region_id: "reg_bad_metric_transition".to_string(),
        owner_object: "strip".to_string(),
        name: "bad_metric_transition".to_string(),
        shape: RegionShapeIR::Box {
            size: [10e-9, 10e-9, 6e-9],
            center: [0.0, 0.0, 0.0],
        },
        frame: RegionFrameIR::Object,
        enabled: true,
        priority: 0,
        mesh_policy: None,
        material_overrides: Vec::new(),
        texture_override: None,
        material_transition: Some(MaterialTransitionSpecIR::Metric {
            width: -1e-9,
            scope: MaterialTransitionScopeIR::Inside,
        }),
        realization_policy: RegionRealizationPolicyIR::Inherit,
    });

    let errors = ir
        .validate()
        .expect_err("invalid material transition widths must fail validation");
    assert!(errors.iter().any(|error| {
        error.contains("object_regions[0].material_transition.cells must be >= 1")
    }));
    assert!(errors.iter().any(|error| {
        error.contains("object_regions[1].material_transition.width must be finite and > 0")
    }));
}

#[test]
fn saturation_probe_defaults_on_failure_for_existing_ir_payloads() {
    let probe: SaturationProbeIR = serde_json::from_value(serde_json::json!({
        "mode": "auto",
        "max_field_mT": 300.0,
        "susceptibility_threshold": 0.001,
        "transverse_threshold": 0.01
    }))
    .expect("legacy saturation probe payload should deserialize");

    assert_eq!(probe.on_failure, "continue_with_warning");
}

#[test]
fn base_material_invalid_scalars_are_rejected() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.materials[0].saturation_magnetisation = 0.0;
    ir.materials[0].exchange_stiffness = -1.0e-12;
    ir.materials[0].damping = -0.1;

    let errors = ir
        .validate()
        .expect_err("invalid base material scalars must be rejected");
    assert!(errors.iter().any(|error| {
        error.contains("materials[0].saturation_magnetisation") && error.contains("Ms must be > 0")
    }));
    assert!(errors.iter().any(|error| {
        error.contains("materials[0].exchange_stiffness") && error.contains("Aex must be >= 0")
    }));
    assert!(errors.iter().any(|error| {
        error.contains("materials[0].damping") && error.contains("Alpha must be >= 0")
    }));
}

#[test]
fn equal_priority_region_material_assignments_are_rejected() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.object_regions.push(ObjectRegionIR {
        region_id: "reg_core".to_string(),
        owner_object: "strip".to_string(),
        name: "core".to_string(),
        shape: RegionShapeIR::Box {
            size: [10e-9, 10e-9, 6e-9],
            center: [0.0, 0.0, 0.0],
        },
        frame: RegionFrameIR::Object,
        enabled: true,
        priority: 0,
        mesh_policy: None,
        material_overrides: Vec::new(),
        texture_override: None,
        material_transition: None,
        realization_policy: RegionRealizationPolicyIR::Inherit,
    });
    for (index, value) in [760e3, 780e3].into_iter().enumerate() {
        ir.material_parameter_fields
            .push(MaterialParameterAssignmentIR {
                assignment_id: format!("core_ms_{index}"),
                owner_object: "strip".to_string(),
                region_id: Some("reg_core".to_string()),
                parameter: MaterialParameterNameIR::Ms,
                value: MaterialParameterFieldIR::Constant {
                    value: serde_json::json!(value),
                    unit: Some("A/m".to_string()),
                },
                priority: 10,
                conflict_policy: RegionConflictPolicyIR::Error,
            });
    }

    let errors = ir
        .validate()
        .expect_err("equal-priority assignments on the same region must conflict");
    assert!(errors.iter().any(|error| error.contains(
        "region-owned material parameter conflict: material_parameter_fields[0] and material_parameter_fields[1]"
    )));
}

#[test]
fn object_wide_and_region_material_assignment_same_priority_is_rejected() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.object_regions.push(ObjectRegionIR {
        region_id: "reg_core".to_string(),
        owner_object: "strip".to_string(),
        name: "core".to_string(),
        shape: RegionShapeIR::Box {
            size: [10e-9, 10e-9, 6e-9],
            center: [0.0, 0.0, 0.0],
        },
        frame: RegionFrameIR::Object,
        enabled: true,
        priority: 0,
        mesh_policy: None,
        material_overrides: vec![RegionMaterialOverrideIR {
            parameter: MaterialParameterNameIR::Ms,
            value: MaterialParameterFieldIR::Constant {
                value: serde_json::json!(760e3),
                unit: Some("A/m".to_string()),
            },
            priority: 10,
            conflict_policy: RegionConflictPolicyIR::Error,
        }],
        texture_override: None,
        material_transition: None,
        realization_policy: RegionRealizationPolicyIR::Inherit,
    });
    ir.material_parameter_fields
        .push(MaterialParameterAssignmentIR {
            assignment_id: "object_ms".to_string(),
            owner_object: "strip".to_string(),
            region_id: None,
            parameter: MaterialParameterNameIR::Ms,
            value: MaterialParameterFieldIR::Constant {
                value: serde_json::json!(800e3),
                unit: Some("A/m".to_string()),
            },
            priority: 10,
            conflict_policy: RegionConflictPolicyIR::Error,
        });

    let errors = ir
        .validate()
        .expect_err("equal-priority object-wide and region assignments must conflict");
    assert!(errors.iter().any(|error| error
        .contains("object_regions[0].material_overrides[0] and material_parameter_fields[0]")));
}

#[test]
fn disabled_region_material_assignments_do_not_conflict() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.object_regions.push(ObjectRegionIR {
        region_id: "reg_core".to_string(),
        owner_object: "strip".to_string(),
        name: "core".to_string(),
        shape: RegionShapeIR::Box {
            size: [10e-9, 10e-9, 6e-9],
            center: [0.0, 0.0, 0.0],
        },
        frame: RegionFrameIR::Object,
        enabled: false,
        priority: 0,
        mesh_policy: None,
        material_overrides: vec![RegionMaterialOverrideIR {
            parameter: MaterialParameterNameIR::Ms,
            value: MaterialParameterFieldIR::Constant {
                value: serde_json::json!(760e3),
                unit: Some("A/m".to_string()),
            },
            priority: 10,
            conflict_policy: RegionConflictPolicyIR::Error,
        }],
        texture_override: None,
        material_transition: None,
        realization_policy: RegionRealizationPolicyIR::Inherit,
    });
    ir.material_parameter_fields
        .push(MaterialParameterAssignmentIR {
            assignment_id: "disabled_region_ms".to_string(),
            owner_object: "strip".to_string(),
            region_id: Some("reg_core".to_string()),
            parameter: MaterialParameterNameIR::Ms,
            value: MaterialParameterFieldIR::Constant {
                value: serde_json::json!(780e3),
                unit: Some("A/m".to_string()),
            },
            priority: 10,
            conflict_policy: RegionConflictPolicyIR::Error,
        });
    ir.material_parameter_fields
        .push(MaterialParameterAssignmentIR {
            assignment_id: "object_ms".to_string(),
            owner_object: "strip".to_string(),
            region_id: None,
            parameter: MaterialParameterNameIR::Ms,
            value: MaterialParameterFieldIR::Constant {
                value: serde_json::json!(800e3),
                unit: Some("A/m".to_string()),
            },
            priority: 10,
            conflict_policy: RegionConflictPolicyIR::Error,
        });

    ir.validate()
        .expect("disabled region assignments must not create active conflicts");
}

#[test]
fn region_material_assignment_must_match_region_owner() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.geometry.entries.push(GeometryEntryIR::Box {
        name: "other".to_string(),
        size: [20e-9, 20e-9, 6e-9],
    });
    ir.object_regions.push(ObjectRegionIR {
        region_id: "reg_core".to_string(),
        owner_object: "strip".to_string(),
        name: "core".to_string(),
        shape: RegionShapeIR::Box {
            size: [10e-9, 10e-9, 6e-9],
            center: [0.0, 0.0, 0.0],
        },
        frame: RegionFrameIR::Object,
        enabled: true,
        priority: 0,
        mesh_policy: None,
        material_overrides: Vec::new(),
        texture_override: None,
        material_transition: None,
        realization_policy: RegionRealizationPolicyIR::Inherit,
    });
    ir.material_parameter_fields
        .push(MaterialParameterAssignmentIR {
            assignment_id: "other_ms".to_string(),
            owner_object: "other".to_string(),
            region_id: Some("reg_core".to_string()),
            parameter: MaterialParameterNameIR::Ms,
            value: MaterialParameterFieldIR::Constant {
                value: serde_json::json!(760e3),
                unit: Some("A/m".to_string()),
            },
            priority: 10,
            conflict_policy: RegionConflictPolicyIR::Error,
        });

    let errors = ir
        .validate()
        .expect_err("assignment region owner must match assignment owner");
    assert!(errors.iter().any(|error| error.contains(
        "material_parameter_fields[0] region_id 'reg_core' belongs to a different owner than 'other'"
    )));
}

#[test]
fn coupling_region_endpoint_must_match_region_owner() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.geometry.entries.push(GeometryEntryIR::Box {
        name: "other".to_string(),
        size: [20e-9, 20e-9, 6e-9],
    });
    ir.object_regions.push(ObjectRegionIR {
        region_id: "reg_core".to_string(),
        owner_object: "strip".to_string(),
        name: "core".to_string(),
        shape: RegionShapeIR::Box {
            size: [10e-9, 10e-9, 6e-9],
            center: [0.0, 0.0, 0.0],
        },
        frame: RegionFrameIR::Object,
        enabled: true,
        priority: 0,
        mesh_policy: None,
        material_overrides: Vec::new(),
        texture_override: None,
        material_transition: None,
        realization_policy: RegionRealizationPolicyIR::Inherit,
    });
    ir.couplings.push(CouplingIR {
        coupling_id: "bad_region_endpoint".to_string(),
        kind: CouplingKindIR::Exchange,
        source: CouplingEndpointIR::Region {
            object: "other".to_string(),
            region_id: "reg_core".to_string(),
        },
        target: CouplingEndpointIR::Object {
            object: "strip".to_string(),
        },
        enabled: true,
        parameters: CouplingParametersIR::Exchange {
            mode: ExchangeCouplingModeIR::HarmonicMean,
            scale: Some(1.0),
            inter_exchange: None,
        },
        capability_policy: CouplingCapabilityPolicyIR::RequireRuntime,
    });

    let errors = ir
        .validate()
        .expect_err("coupling region endpoint owner must match region owner");
    assert!(errors.iter().any(|error| error.contains(
        "couplings[0].source.region_id 'reg_core' belongs to a different owner than 'other'"
    )));
}

#[test]
fn coupling_region_endpoint_validates_when_region_owner_matches() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.object_regions.push(ObjectRegionIR {
        region_id: "reg_core".to_string(),
        owner_object: "strip".to_string(),
        name: "core".to_string(),
        shape: RegionShapeIR::Box {
            size: [10e-9, 10e-9, 6e-9],
            center: [0.0, 0.0, 0.0],
        },
        frame: RegionFrameIR::Object,
        enabled: true,
        priority: 0,
        mesh_policy: None,
        material_overrides: Vec::new(),
        texture_override: None,
        material_transition: None,
        realization_policy: RegionRealizationPolicyIR::Inherit,
    });
    ir.couplings.push(CouplingIR {
        coupling_id: "region_endpoint".to_string(),
        kind: CouplingKindIR::Exchange,
        source: CouplingEndpointIR::Region {
            object: "strip".to_string(),
            region_id: "reg_core".to_string(),
        },
        target: CouplingEndpointIR::Object {
            object: "strip".to_string(),
        },
        enabled: true,
        parameters: CouplingParametersIR::Exchange {
            mode: ExchangeCouplingModeIR::HarmonicMean,
            scale: Some(1.0),
            inter_exchange: None,
        },
        capability_policy: CouplingCapabilityPolicyIR::RequireRuntime,
    });

    assert!(ir.validate().is_ok());
}

#[test]
fn active_coupling_cannot_target_disabled_region() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.object_regions.push(ObjectRegionIR {
        region_id: "reg_core".to_string(),
        owner_object: "strip".to_string(),
        name: "core".to_string(),
        shape: RegionShapeIR::Box {
            size: [10e-9, 10e-9, 6e-9],
            center: [0.0, 0.0, 0.0],
        },
        frame: RegionFrameIR::Object,
        enabled: false,
        priority: 0,
        mesh_policy: None,
        material_overrides: Vec::new(),
        texture_override: None,
        material_transition: None,
        realization_policy: RegionRealizationPolicyIR::Inherit,
    });
    ir.couplings.push(CouplingIR {
        coupling_id: "disabled_region_endpoint".to_string(),
        kind: CouplingKindIR::Exchange,
        source: CouplingEndpointIR::Region {
            object: "strip".to_string(),
            region_id: "reg_core".to_string(),
        },
        target: CouplingEndpointIR::Object {
            object: "strip".to_string(),
        },
        enabled: true,
        parameters: CouplingParametersIR::Exchange {
            mode: ExchangeCouplingModeIR::HarmonicMean,
            scale: Some(1.0),
            inter_exchange: None,
        },
        capability_policy: CouplingCapabilityPolicyIR::RequireRuntime,
    });

    let errors = ir
        .validate()
        .expect_err("active coupling endpoint must not reference disabled region");
    assert!(errors.iter().any(|error| {
        error.contains("couplings[0].source.region_id 'reg_core' references disabled object_region")
    }));

    ir.couplings[0].enabled = false;
    ir.validate()
        .expect("disabled coupling may keep a reference to disabled authored region");
}

#[test]
fn object_object_exchange_default_is_no_coupling_in_ir() {
    let ir = ProblemIR::bootstrap_example();

    assert!(ir.couplings.is_empty());
    assert!(ir.validate().is_ok());
}

#[test]
fn coupling_surface_selector_rejects_named_faces_in_v1() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.couplings.push(CouplingIR {
        coupling_id: "unsupported_surface".to_string(),
        kind: CouplingKindIR::Exchange,
        source: CouplingEndpointIR::Surface {
            object: "strip".to_string(),
            selector: "named_face".to_string(),
        },
        target: CouplingEndpointIR::Surface {
            object: "strip".to_string(),
            selector: "bottom".to_string(),
        },
        enabled: true,
        parameters: CouplingParametersIR::Exchange {
            mode: ExchangeCouplingModeIR::Disabled,
            scale: Some(0.0),
            inter_exchange: None,
        },
        capability_policy: CouplingCapabilityPolicyIR::RequireRuntime,
    });

    let errors = ir
        .validate()
        .expect_err("v1 must reject unsupported named surface selectors");
    assert!(errors.iter().any(|error| {
        error.contains("named_face") && error.contains("top/bottom/left/right/front/back")
    }));
}

#[test]
fn rkky_requires_surface_endpoints_and_airbox_is_rejected() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.couplings.push(CouplingIR {
        coupling_id: "bad_rkky".to_string(),
        kind: CouplingKindIR::Rkky,
        source: CouplingEndpointIR::Object {
            object: "strip".to_string(),
        },
        target: CouplingEndpointIR::Surface {
            object: "airbox".to_string(),
            selector: "top".to_string(),
        },
        enabled: true,
        parameters: CouplingParametersIR::Rkky { j1: -0.3e-3 },
        capability_policy: CouplingCapabilityPolicyIR::RequireRuntime,
    });

    let errors = ir
        .validate()
        .expect_err("invalid RKKY endpoints must be rejected");
    assert!(errors
        .iter()
        .any(|error| error.contains("endpoints must be surfaces")));
    assert!(errors
        .iter()
        .any(|error| error.contains("must be magnetic, not airbox")));
}

fn add_valid_magnetoelastic_semantics(ir: &mut ProblemIR) {
    ir.elastic_materials = vec![ElasticMaterialIR {
        name: "elastic".to_string(),
        c11: 2.0e11,
        c12: 1.2e11,
        c44: 8.0e10,
        density: 8700.0,
        mechanical_damping: None,
    }];
    ir.elastic_bodies = vec![ElasticBodyIR {
        name: "solid".to_string(),
        geometry: "strip".to_string(),
        elastic_material: "elastic".to_string(),
    }];
    ir.magnetostriction_laws = vec![MagnetostrictionLawIR::Cubic {
        name: "cubic".to_string(),
        b1: 1.0e6,
        b2: -2.0e6,
    }];
    ir.mechanical_loads = vec![MechanicalLoadIR::PrescribedStrain {
        strain: [1.0e-4, 0.0, 0.0, 0.0, 0.0, 0.0],
    }];
    ir.energy_terms.push(EnergyTermIR::Magnetoelastic {
        magnet: "strip".to_string(),
        body: "solid".to_string(),
        law: "cubic".to_string(),
    });
}

#[test]
fn magnetoelastic_references_validate_when_semantics_are_complete() {
    let mut ir = ProblemIR::bootstrap_example();
    add_valid_magnetoelastic_semantics(&mut ir);

    assert!(ir.validate().is_ok());
}

#[test]
fn magnetoelastic_references_are_validated() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.energy_terms.push(EnergyTermIR::Magnetoelastic {
        magnet: "missing_magnet".to_string(),
        body: "missing_body".to_string(),
        law: "missing_law".to_string(),
    });

    let errors = ir
        .validate()
        .expect_err("invalid magnetoelastic references must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("references unknown magnet 'missing_magnet'")));
    assert!(errors
        .iter()
        .any(|error| error.contains("references unknown elastic body 'missing_body'")));
    assert!(errors
        .iter()
        .any(|error| error.contains("references unknown magnetostriction law 'missing_law'")));
}

#[test]
fn mechanics_requires_magnetoelastic_energy_term() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::TimeEvolution {
        dynamics: DynamicsIR::Llg {
            gyromagnetic_ratio: 2.211e5,
            integrator: "heun".to_string(),
            fixed_timestep: Some(1e-13),
            adaptive_timestep: None,
            field_refresh: None,
            mechanics: Some(MechanicsIR::QuasistaticElasticity {
                max_picard_iterations: 2,
                picard_tolerance: 1e-6,
            }),
        },
        sampling: ir.study.sampling().clone(),
    };

    let errors = ir
        .validate()
        .expect_err("mechanics without Magnetoelastic must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("llg.mechanics requires a Magnetoelastic energy term")));
}

#[test]
fn hybrid_mode_requires_hybrid_backend() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.validation_profile.execution_mode = ExecutionMode::Hybrid;

    let errors = ir
        .validate()
        .expect_err("hybrid mode without hybrid backend must fail");
    assert!(
        errors
            .iter()
            .any(|error| error
                .contains("execution_mode='hybrid' requires requested_backend='hybrid'"))
    );
}

#[test]
fn planning_with_backend_override_produces_summary() {
    let ir = ProblemIR::bootstrap_example();

    let plan = ir
        .plan_for(Some(BackendTarget::Fem))
        .expect("planning for FEM should succeed");

    assert_eq!(plan.requested_backend, BackendTarget::Fem);
    assert_eq!(plan.resolved_backend, BackendTarget::Fem);
    assert_eq!(plan.execution_mode, ExecutionMode::Strict);
}

#[test]
fn llg_requires_supported_integrator() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::TimeEvolution {
        dynamics: DynamicsIR::Llg {
            gyromagnetic_ratio: 2.211e5,
            integrator: "bogus".to_string(),
            fixed_timestep: None,
            adaptive_timestep: None,
            field_refresh: None,
            mechanics: None,
        },
        sampling: ir.study.sampling().clone(),
    };

    let errors = ir
        .validate()
        .expect_err("unsupported llg integrator must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("llg.integrator must be one of")));
}

#[test]
fn random_seeded_initial_magnetization_must_be_positive() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.magnets[0].initial_magnetization = Some(InitialMagnetizationIR::RandomSeeded { seed: 0 });

    let errors = ir
        .validate()
        .expect_err("zero random seed must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("random_seeded seed must be positive")));
}

#[test]
fn random_initial_magnetization_alias_deserializes_to_seeded_variant() {
    let json = r#"{"kind":"random","seed":7}"#;
    let decoded: InitialMagnetizationIR =
        serde_json::from_str(json).expect("random alias should deserialize");
    assert_eq!(decoded, InitialMagnetizationIR::RandomSeeded { seed: 7 });
}

#[test]
fn sampled_field_initial_magnetization_must_not_be_empty() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.magnets[0].initial_magnetization =
        Some(InitialMagnetizationIR::SampledField { values: vec![] });

    let errors = ir
        .validate()
        .expect_err("empty sampled field must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("sampled_field values must not be empty")));
}

#[test]
fn preset_texture_initial_magnetization_requires_preset_kind() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.magnets[0].initial_magnetization = Some(InitialMagnetizationIR::PresetTexture {
        preset_kind: String::new(),
        preset_params: BTreeMap::new(),
        mapping: TextureMappingIR::default(),
        texture_transform: TextureTransform3DIR::default(),
    });

    let errors = ir
        .validate()
        .expect_err("empty preset_kind must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("preset_texture preset_kind must not be empty")));
}

#[test]
fn analytic_geometry_must_have_positive_dimensions() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.geometry.entries[0] = GeometryEntryIR::Cylinder {
        name: "strip".to_string(),
        radius: -1.0,
        height: 5e-9,
    };

    let errors = ir
        .validate()
        .expect_err("negative cylinder radius must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("cylinder geometry 'strip' radius must be positive")));
}

#[test]
fn waveguide_geometry_round_trips_through_serde() {
    let sin = GeometryEntryIR::SinWaveguide {
        name: "sinus".to_string(),
        length: 400e-9,
        width: 40e-9,
        height: 10e-9,
        period: 100e-9,
        amplitude: 20e-9,
        phase: 0.25,
        z0: -5e-9,
    };
    let arch = GeometryEntryIR::ArchWaveguide {
        name: "arch".to_string(),
        length: 400e-9,
        width: 40e-9,
        height: 10e-9,
        arch_height: -80e-9,
        z0: 10e-9,
    };

    let sin_json = serde_json::to_string(&sin).expect("sin waveguide should serialize");
    let arch_json = serde_json::to_string(&arch).expect("arch waveguide should serialize");

    let sin_decoded: GeometryEntryIR =
        serde_json::from_str(&sin_json).expect("sin waveguide should deserialize");
    let arch_decoded: GeometryEntryIR =
        serde_json::from_str(&arch_json).expect("arch waveguide should deserialize");

    assert_eq!(sin_decoded, sin);
    assert_eq!(arch_decoded, arch);
}

#[test]
fn waveguide_geometry_validates_finite_and_positive_fields() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.geometry.entries[0] = GeometryEntryIR::SinWaveguide {
        name: "sinus".to_string(),
        length: 400e-9,
        width: 40e-9,
        height: 10e-9,
        period: 0.0,
        amplitude: f64::NAN,
        phase: 0.0,
        z0: 0.0,
    };

    let errors = ir
        .validate()
        .expect_err("invalid sin waveguide must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("sin_waveguide geometry 'sinus' period must be positive")));
    assert!(errors
        .iter()
        .any(|error| error.contains("sin_waveguide geometry 'sinus' amplitude must be finite")));

    ir.geometry.entries[0] = GeometryEntryIR::ArchWaveguide {
        name: "arch".to_string(),
        length: 400e-9,
        width: 40e-9,
        height: 10e-9,
        arch_height: f64::INFINITY,
        z0: 0.0,
    };

    let errors = ir
        .validate()
        .expect_err("invalid arch waveguide must fail validation");
    assert!(errors.iter().any(|error| {
        error.contains("arch_waveguide geometry 'arch' arch_height must be finite")
    }));
}

#[test]
fn execution_plan_ir_serializes() {
    let plan = ExecutionPlanIR {
        common: CommonPlanMeta {
            ir_version: IR_VERSION.to_string(),
            requested_backend: BackendTarget::Auto,
            resolved_backend: BackendTarget::Fdm,
            execution_mode: ExecutionMode::Strict,
            material_field_plans: Vec::new(),
        },
        backend_plan: BackendPlanIR::Fdm(FdmPlanIR {
            grid: GridDimensions {
                cells: [100, 10, 3],
            },
            cell_size: [2e-9, 2e-9, 2e-9],
            region_mask: vec![0, 0, 1],
            active_mask: None,
            initial_magnetization: vec![[1.0, 0.0, 0.0]],
            material: FdmMaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.02,
                ms_field: None,
                a_field: None,
                alpha_field: None,
                uniaxial_anisotropy_ku1: None,
                uniaxial_anisotropy_ku2: None,
                anisotropy_axis: None,
                cubic_anisotropy_kc1: None,
                cubic_anisotropy_kc2: None,
                cubic_anisotropy_kc3: None,
                cubic_anisotropy_axis1: None,
                cubic_anisotropy_axis2: None,
            },
            enable_exchange: true,
            enable_demag: false,
            external_field: None,
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(1e-13),
            adaptive_timestep: None,
            relaxation: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
            boundary_geometry: None,
            inter_region_exchange: vec![],
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            stt_thickness: None,
            stt_fixed_layer_position: None,
            has_oersted_cylinder: false,
            oersted_current: None,
            oersted_radius: None,
            oersted_center: None,
            oersted_axis: None,
            oersted_field_xyz: None,
            oersted_time_dep_kind: 0,
            oersted_time_dep_freq: 0.0,
            oersted_time_dep_phase: 0.0,
            oersted_time_dep_offset: 0.0,
            oersted_time_dep_t_on: 0.0,
            oersted_time_dep_t_off: 0.0,
            oersted_realization: None,
            temperature: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            ..Default::default()
        }),
        output_plan: OutputPlanIR {
            outputs: vec![OutputIR::Field {
                name: "m".to_string(),
                every_seconds: 1e-12,
            }],
        },
        provenance: ProvenancePlanIR {
            notes: vec!["planner stub".to_string()],
        },
    };

    let encoded = serde_json::to_string(&plan).expect("execution plan should serialize");
    let decoded: ExecutionPlanIR =
        serde_json::from_str(&encoded).expect("execution plan should deserialize");
    assert_eq!(decoded, plan);
}

#[test]
fn fdm_grid_asset_must_not_be_empty() {
    let asset = FdmGridAssetIR {
        geometry_name: "mesh".to_string(),
        cells: [2, 2, 1],
        cell_size: [5e-9, 5e-9, 5e-9],
        origin: [0.0, 0.0, 0.0],
        active_mask: vec![false, false, false, false],
    };

    let errors = asset
        .validate()
        .expect_err("empty active mask must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("must contain at least one active cell")));
}

#[test]
fn eigenmodes_with_spectrum_and_mode_outputs_validate() {
    let mut ir = ProblemIR::bootstrap_example();
    let dynamics = ir.study.dynamics().clone();
    ir.study = StudyIR::Eigenmodes {
        dynamics,
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 6,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: Some(KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        }),
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        spin_wave_bc: SpinWaveBoundaryConditionIR::default(),
        sampling: SamplingIR {
            table_autosave: None,
            outputs: vec![
                OutputIR::EigenSpectrum {
                    quantity: "eigenfrequency".to_string(),
                },
                OutputIR::EigenMode {
                    field: "mode".to_string(),
                    indices: vec![0, 1],
                },
            ],
        },
        mode_tracking: None,
    };

    assert!(ir.validate().is_ok());
}

#[test]
fn eigenmodes_closed_k_path_sample_count_and_segment_length_validate() {
    assert_eq!(
        (KSamplingIR::Path {
            points: vec![
                KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                KPointIR {
                    label: Some("X".to_string()),
                    k_vector: [2.0e7, 0.0, 0.0],
                },
                KPointIR {
                    label: Some("M".to_string()),
                    k_vector: [2.0e7, 2.0e7, 0.0],
                },
            ],
            samples_per_segment: vec![2, 3],
            closed: false,
        })
        .sample_count_hint(),
        6,
        "open path sampling must match runtime expansion: sum(samples_per_segment)+1"
    );
    let sampling = KSamplingIR::Path {
        points: vec![
            KPointIR {
                label: Some("G".to_string()),
                k_vector: [0.0, 0.0, 0.0],
            },
            KPointIR {
                label: Some("X".to_string()),
                k_vector: [2.0e7, 0.0, 0.0],
            },
            KPointIR {
                label: Some("M".to_string()),
                k_vector: [2.0e7, 2.0e7, 0.0],
            },
        ],
        samples_per_segment: vec![2, 3, 4],
        closed: true,
    };
    assert_eq!(
        sampling.sample_count_hint(),
        10,
        "closed path sampling must match runtime expansion: sum(samples_per_segment)+1"
    );

    let mut ir = ProblemIR::bootstrap_example();
    let dynamics = ir.study.dynamics().clone();
    ir.study = StudyIR::Eigenmodes {
        dynamics,
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::Full2x2,
            include_demag: false,
        },
        count: 2,
        target: EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0e9,
            frequency_max_hz: 3.0e9,
        },
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: Some(sampling),
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        spin_wave_bc: SpinWaveBoundaryConditionIR::default(),
        sampling: SamplingIR {
            table_autosave: None,
            outputs: vec![
                OutputIR::EigenSpectrum {
                    quantity: "frequency_hz".to_string(),
                },
                OutputIR::DispersionCurve {
                    name: "dispersion".to_string(),
                },
            ],
        },
        mode_tracking: None,
    };

    ir.validate()
        .expect("closed eigenmode k-path with one segment count per control point should validate");
}

#[test]
fn eigenmodes_rejects_closed_k_path_with_open_segment_count() {
    let mut ir = ProblemIR::bootstrap_example();
    let dynamics = ir.study.dynamics().clone();
    ir.study = StudyIR::Eigenmodes {
        dynamics,
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::Full2x2,
            include_demag: false,
        },
        count: 2,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: Some(KSamplingIR::Path {
            points: vec![
                KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                KPointIR {
                    label: Some("X".to_string()),
                    k_vector: [2.0e7, 0.0, 0.0],
                },
                KPointIR {
                    label: Some("M".to_string()),
                    k_vector: [2.0e7, 2.0e7, 0.0],
                },
            ],
            samples_per_segment: vec![2, 3],
            closed: true,
        }),
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        spin_wave_bc: SpinWaveBoundaryConditionIR::default(),
        sampling: SamplingIR {
            table_autosave: None,
            outputs: vec![OutputIR::EigenSpectrum {
                quantity: "frequency_hz".to_string(),
            }],
        },
        mode_tracking: None,
    };

    let errors = ir
        .validate()
        .expect_err("closed k-path must require a sample count for the closing segment");
    assert!(
        errors.iter().any(|error| error
            .contains("eigenmodes.k_sampling.path expected 3 samples_per_segment entries, got 2")),
        "expected closed segment-count diagnostic, got {errors:?}"
    );
}

#[test]
fn frequency_response_round_trips_as_first_class_study() {
    let mut ir = ProblemIR::bootstrap_example();
    let dynamics = ir.study.dynamics().clone();
    ir.study = StudyIR::FrequencyResponse {
        dynamics,
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: true,
        },
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: Some(KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        }),
        normalization: FrequencyResponseNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Include,
        spin_wave_bc: SpinWaveBoundaryConditionIR::default(),
        magnetostatic_bc: MagnetostaticBoundaryConditionIR::default(),
        excitation: FrequencyExcitationIR {
            field_au_per_m: [0.0, 0.0, 1.0],
            phase_rad: 0.0,
        },
        frequencies_hz: FrequencySweepIR {
            values_hz: vec![1.0e9, 2.0e9],
        },
        solver_policy: Some(FrequencyResponseSolverPolicyIR {
            rtol: Some(1.0e-2),
            max_iterations: Some(128),
            restart_iterations: Some(32),
        }),
        sampling: SamplingIR {
            table_autosave: None,
            outputs: vec![OutputIR::EigenSpectrum {
                quantity: "susceptibility".to_string(),
            }],
        },
    };

    ir.validate()
        .expect("frequency response should be accepted as semantic IR");
    let encoded = serde_json::to_string(&ir).expect("frequency response should serialize");
    let decoded: ProblemIR =
        serde_json::from_str(&encoded).expect("frequency response should deserialize");

    match decoded.study {
        StudyIR::FrequencyResponse {
            excitation,
            frequencies_hz,
            solver_policy,
            ..
        } => {
            assert_eq!(excitation.field_au_per_m, [0.0, 0.0, 1.0]);
            assert_eq!(frequencies_hz.values_hz, vec![1.0e9, 2.0e9]);
            assert_eq!(
                solver_policy
                    .expect("solver policy should round-trip")
                    .max_iterations,
                Some(128)
            );
        }
        other => panic!("expected frequency_response study, got {other:?}"),
    }
}

#[test]
fn frequency_response_does_not_validate_time_integrator_alias() {
    let mut ir = ProblemIR::bootstrap_example();
    let mut dynamics = ir.study.dynamics().clone();
    let DynamicsIR::Llg { integrator, .. } = &mut dynamics;
    *integrator = "not-used-by-direct-frequency-response".to_string();
    ir.study = StudyIR::FrequencyResponse {
        dynamics,
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: true,
        },
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: Some(KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        }),
        normalization: FrequencyResponseNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Include,
        spin_wave_bc: SpinWaveBoundaryConditionIR::default(),
        magnetostatic_bc: MagnetostaticBoundaryConditionIR::default(),
        excitation: FrequencyExcitationIR {
            field_au_per_m: [0.0, 0.0, 1.0],
            phase_rad: 0.0,
        },
        frequencies_hz: FrequencySweepIR {
            values_hz: vec![1.0e9],
        },
        solver_policy: None,
        sampling: SamplingIR {
            table_autosave: None,
            outputs: vec![OutputIR::FrequencyResponseOutput {
                observable: FrequencyResponseOutputIR::SusceptibilityTensor,
            }],
        },
    };

    ir.validate().expect(
        "frequency_response is a direct harmonic solve and must not validate time-integrator aliases",
    );
}

#[test]
fn frequency_response_rejects_non_finite_excitation_phase() {
    let mut ir = ProblemIR::bootstrap_example();
    let dynamics = ir.study.dynamics().clone();
    ir.study = StudyIR::FrequencyResponse {
        dynamics,
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: true,
        },
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: Some(KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        }),
        normalization: FrequencyResponseNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Include,
        spin_wave_bc: SpinWaveBoundaryConditionIR::default(),
        magnetostatic_bc: MagnetostaticBoundaryConditionIR::default(),
        excitation: FrequencyExcitationIR {
            field_au_per_m: [0.0, 0.0, 1.0],
            phase_rad: f64::NAN,
        },
        frequencies_hz: FrequencySweepIR {
            values_hz: vec![1.0e9],
        },
        solver_policy: None,
        sampling: SamplingIR {
            table_autosave: None,
            outputs: vec![OutputIR::FrequencyResponseOutput {
                observable: FrequencyResponseOutputIR::SusceptibilityTensor,
            }],
        },
    };

    let err = ir
        .validate()
        .expect_err("non-finite frequency response phase should be rejected");
    assert!(
        err.iter()
            .any(|message| message.contains("frequency_response.excitation.phase_rad")),
        "expected phase diagnostic, got {err:?}"
    );
}

#[test]
fn frequency_response_output_is_first_class_sampling_request() {
    let mut ir = ProblemIR::bootstrap_example();
    let dynamics = ir.study.dynamics().clone();
    ir.study = StudyIR::FrequencyResponse {
        dynamics,
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: true,
        },
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: None,
        normalization: FrequencyResponseNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Include,
        spin_wave_bc: SpinWaveBoundaryConditionIR::default(),
        magnetostatic_bc: MagnetostaticBoundaryConditionIR::default(),
        excitation: FrequencyExcitationIR {
            field_au_per_m: [0.0, 0.0, 1.0],
            phase_rad: 0.0,
        },
        frequencies_hz: FrequencySweepIR {
            values_hz: vec![1.0e9],
        },
        solver_policy: None,
        sampling: SamplingIR {
            table_autosave: None,
            outputs: vec![OutputIR::FrequencyResponseOutput {
                observable: FrequencyResponseOutputIR::SusceptibilityTensor,
            }],
        },
    };

    ir.validate()
        .expect("frequency response output should be accepted as semantic IR");
    let encoded = serde_json::to_value(&ir.study).expect("study should serialize");
    assert_eq!(
        encoded["sampling"]["outputs"][0],
        serde_json::json!({
            "kind": "frequency_response_output",
            "observable": "susceptibility_tensor"
        })
    );
}

#[test]
fn frequency_response_normalization_has_response_specific_contract_type() {
    let encoded = serde_json::to_string(&FrequencyResponseNormalizationIR::UnitL2)
        .expect("normalization should serialize");
    assert_eq!(encoded, "\"unit_l2\"");
    assert_ne!(
        std::any::TypeId::of::<FrequencyResponseNormalizationIR>(),
        std::any::TypeId::of::<EigenNormalizationIR>(),
        "FrequencyResponseNormalizationIR must be distinct from EigenNormalizationIR",
    );
}

#[test]
fn frequency_response_observable_contract_uses_snake_case_names() {
    let encoded = serde_json::to_string(&ResponseObservableIR::SusceptibilityTensor)
        .expect("observable should serialize");
    assert_eq!(encoded, "\"susceptibility_tensor\"");

    let decoded: FrequencyResponseOutputIR =
        serde_json::from_str("\"absorbed_power_density\"").expect("observable should deserialize");
    assert_eq!(decoded, ResponseObservableIR::AbsorbedPowerDensity);
}

#[test]
fn frequency_response_uses_distinct_public_contract_types() {
    assert_ne!(
        std::any::TypeId::of::<FrequencyExcitationIR>(),
        std::any::TypeId::of::<DynamicFieldIR>(),
        "FrequencyExcitationIR must be a distinct public response contract, not a plain alias",
    );
    assert_ne!(
        std::any::TypeId::of::<FrequencySweepIR>(),
        std::any::TypeId::of::<SweepIR>(),
        "FrequencySweepIR must be a distinct public response contract, not a plain alias",
    );
}

#[test]
fn frequency_response_contract_has_own_public_module() {
    let excitation = fullmag_ir::frequency_response_contract::FrequencyExcitationIR {
        field_au_per_m: [0.0, 1.0, 2.0],
        phase_rad: 0.25,
    };
    let sweep = fullmag_ir::frequency_response_contract::FrequencySweepIR {
        values_hz: vec![1.0e9],
    };
    assert_eq!(
        serde_json::to_value(excitation).expect("excitation should serialize"),
        serde_json::json!({"field_au_per_m": [0.0, 1.0, 2.0], "phase_rad": 0.25})
    );
    assert_eq!(
        serde_json::to_value(sweep).expect("sweep should serialize"),
        serde_json::json!({"values_hz": [1.0e9]})
    );
}

#[test]
fn spin_wave_boundary_condition_accepts_legacy_and_structured_forms() {
    let legacy: SpinWaveBoundaryConditionIR =
        serde_json::from_str("\"periodic\"").expect("legacy spin-wave BC should deserialize");
    assert_eq!(legacy.kind(), SpinWaveBoundaryKindIR::Periodic);
    assert_eq!(legacy.boundary_pair_id(), None);

    let structured: SpinWaveBoundaryConditionIR = serde_json::from_str(
        r#"{
            "kind": "floquet",
            "boundary_pair_id": "x_faces",
            "surface_anisotropy_ks": 0.002,
            "surface_anisotropy_axis": [0.0, 0.0, 1.0]
        }"#,
    )
    .expect("structured spin-wave BC should deserialize");
    assert_eq!(structured.kind(), SpinWaveBoundaryKindIR::Floquet);
    assert_eq!(structured.boundary_pair_id(), Some("x_faces"));
    assert_eq!(structured.surface_anisotropy_ks(), Some(0.002));
    assert_eq!(structured.surface_anisotropy_axis(), Some([0.0, 0.0, 1.0]));

    let pair_ids: SpinWaveBoundaryConditionIR = serde_json::from_str(
        r#"{
            "kind": "floquet",
            "pair_ids": ["x_faces", "y_faces"]
        }"#,
    )
    .expect("pair_ids spin-wave BC should deserialize");
    assert_eq!(pair_ids.kind(), SpinWaveBoundaryKindIR::Floquet);
    assert_eq!(pair_ids.boundary_pair_id(), Some("x_faces"));
    assert_eq!(pair_ids.boundary_pair_ids(), vec!["x_faces", "y_faces"]);
    assert_eq!(
        pair_ids.phase_convention(),
        PhaseConventionIR::ExpMinusIKDotDeltaR
    );
}

#[test]
fn periodic_constraint_set_accepts_bloch_phase_policy() {
    let constraint: PeriodicConstraintSetIR = serde_json::from_str(
        r#"{
            "unknown_family": "magnetization_dynamic",
            "domain_scope": "magnetic_domain",
            "pair_ids": ["x_faces"],
            "phase_policy": {
                "bloch_phase": {
                    "phase_convention": "exp_minus_i_k_dot_delta_r",
                    "k_vector_rad_per_m": [1000000.0, 0.0, 0.0],
                    "real_imag_mixing": true
                }
            }
        }"#,
    )
    .expect("Bloch phase constraint set should deserialize");

    assert_eq!(
        constraint.unknown_family,
        PeriodicUnknownFamilyIR::MagnetizationDynamic
    );
    match constraint.phase_policy {
        PeriodicPhasePolicyIR::BlochPhase {
            phase_convention,
            k_vector_rad_per_m,
            real_imag_mixing,
        } => {
            assert_eq!(phase_convention, PhaseConventionIR::ExpMinusIKDotDeltaR);
            assert_eq!(k_vector_rad_per_m, [1.0e6, 0.0, 0.0]);
            assert!(real_imag_mixing);
        }
        other => panic!("expected BlochPhase policy, got {other:?}"),
    }
}

#[test]
fn mesh_periodic_pair_validation_allows_shared_boundary_marker_pairs() {
    let mesh = MeshIR {
        mesh_name: "box".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ],
        elements: vec![[0, 1, 2, 3]],
        element_markers: vec![1],
        boundary_faces: vec![[0, 1, 2], [0, 1, 3]],
        boundary_markers: vec![99, 99],
        periodic_boundary_pairs: vec![MeshPeriodicBoundaryPairIR {
            pair_id: "x_faces".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 99,
            marker_b: 99,
            translation: None,
            tolerance: None,
            axis_hint: None,
            orientation: None,
            pairing_policy: None,
        }],
        periodic_node_pairs: vec![MeshPeriodicNodePairIR {
            pair_id: "x_faces".to_string(),
            node_a: 0,
            node_b: 1,
        }],
        per_domain_quality: HashMap::new(),
    };

    assert!(mesh.validate().is_ok());
}

#[test]
fn mesh_periodic_pair_validation_allows_fragmented_boundary_pairs_with_same_pair_id() {
    let mesh = MeshIR {
        mesh_name: "fragmented_periodic_box".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 1.0],
            [0.0, 1.0, 1.0],
            [1.0, 1.0, 1.0],
        ],
        elements: vec![[0, 1, 2, 4], [3, 5, 6, 7]],
        element_markers: vec![1, 1],
        boundary_faces: vec![[0, 2, 4], [1, 3, 5], [2, 4, 6], [3, 5, 7]],
        boundary_markers: vec![10, 11, 12, 13],
        periodic_boundary_pairs: vec![
            MeshPeriodicBoundaryPairIR {
                pair_id: "x_faces".to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: 10,
                marker_b: 11,
                translation: Some([1.0, 0.0, 0.0]),
                tolerance: Some(1e-12),
                axis_hint: Some("x".to_string()),
                orientation: None,
                pairing_policy: None,
            },
            MeshPeriodicBoundaryPairIR {
                pair_id: "x_faces".to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: 12,
                marker_b: 13,
                translation: Some([1.0, 0.0, 0.0]),
                tolerance: Some(1e-12),
                axis_hint: Some("x".to_string()),
                orientation: None,
                pairing_policy: None,
            },
        ],
        periodic_node_pairs: vec![
            MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 0,
                node_b: 1,
            },
            MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 2,
                node_b: 3,
            },
            MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 4,
                node_b: 5,
            },
            MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 6,
                node_b: 7,
            },
        ],
        per_domain_quality: HashMap::new(),
    };

    assert!(mesh.validate().is_ok());
}

#[test]
fn mesh_periodic_boundary_pair_accepts_documented_marker_form() {
    let pair: MeshPeriodicBoundaryPairIR = serde_json::from_value(serde_json::json!({
        "pair_id": "x_periodic",
        "source_marker": "x_min",
        "destination_marker": "x_max",
        "translation": [1.0e-6, 0.0, 0.0],
        "tolerance_m": 1.0e-12,
        "axis_hint": "x",
        "orientation": "source_to_destination",
        "pairing_policy": "node_nearest_within_tolerance"
    }))
    .expect("documented periodic boundary pair form should deserialize");

    assert_eq!(pair.pair_id, "x_periodic");
    assert_eq!(pair.source_marker.as_deref(), Some("x_min"));
    assert_eq!(pair.destination_marker.as_deref(), Some("x_max"));
    assert_eq!(pair.marker_a, 0);
    assert_eq!(pair.marker_b, 0);
    assert_eq!(pair.translation, Some([1.0e-6, 0.0, 0.0]));
    assert_eq!(pair.tolerance, Some(1.0e-12));
    assert_eq!(pair.axis_hint.as_deref(), Some("x"));
    assert_eq!(pair.orientation.as_deref(), Some("source_to_destination"));
    assert_eq!(
        pair.pairing_policy.as_deref(),
        Some("node_nearest_within_tolerance")
    );
}

#[test]
fn mesh_periodic_pair_validation_rejects_bad_translation_residual() {
    let mesh = MeshIR {
        mesh_name: "box".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ],
        elements: vec![[0, 1, 2, 3]],
        element_markers: vec![1],
        boundary_faces: vec![[0, 2, 3], [1, 2, 3]],
        boundary_markers: vec![10, 11],
        periodic_boundary_pairs: vec![MeshPeriodicBoundaryPairIR {
            pair_id: "x_faces".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 10,
            marker_b: 11,
            translation: Some([1.0, 0.0, 0.0]),
            tolerance: Some(1e-12),
            axis_hint: None,
            orientation: None,
            pairing_policy: None,
        }],
        periodic_node_pairs: vec![MeshPeriodicNodePairIR {
            pair_id: "x_faces".to_string(),
            node_a: 0,
            node_b: 1,
        }],
        per_domain_quality: HashMap::new(),
    };

    let errors = mesh
        .validate()
        .expect_err("periodic node pair residual should exceed tolerance");
    assert!(errors
        .iter()
        .any(|error| error.contains("residual") && error.contains("exceeds tolerance")));
}

#[test]
fn mesh_periodic_pair_validation_rejects_duplicate_destination_nodes() {
    let mesh = MeshIR {
        mesh_name: "box".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ],
        elements: vec![[0, 1, 2, 3]],
        element_markers: vec![1],
        boundary_faces: vec![[0, 2, 3], [1, 2, 3]],
        boundary_markers: vec![10, 11],
        periodic_boundary_pairs: vec![MeshPeriodicBoundaryPairIR {
            pair_id: "x_faces".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 10,
            marker_b: 11,
            translation: Some([1.0, 0.0, 0.0]),
            tolerance: Some(1e-12),
            axis_hint: None,
            orientation: None,
            pairing_policy: None,
        }],
        periodic_node_pairs: vec![
            MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 0,
                node_b: 1,
            },
            MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 2,
                node_b: 1,
            },
        ],
        per_domain_quality: HashMap::new(),
    };

    let errors = mesh
        .validate()
        .expect_err("duplicate periodic destination node should be rejected");
    assert!(errors
        .iter()
        .any(|error| error.contains("duplicates destination node 1") && error.contains("x_faces")));
}

#[test]
fn mesh_semantics_validation_rejects_duplicate_object_ids() {
    let semantics = MeshSemanticsIR {
        universe_mesh_config: Some(UniverseMeshConfigIR {
            mode: "auto".to_string(),
            size: Some([1.0, 1.0, 1.0]),
            center: None,
            padding: None,
            airbox_hmax: Some(10e-9),
            airbox_hmin: Some(2e-9),
        }),
        per_object_mesh_configs: vec![
            PerObjectMeshConfigIR {
                object_id: "body".to_string(),
                marker: Some(1),
                hmax: Some(2e-9),
                interface_hmax: None,
                transition_distance: None,
                source: "study_default".to_string(),
            },
            PerObjectMeshConfigIR {
                object_id: "body".to_string(),
                marker: Some(2),
                hmax: Some(1e-9),
                interface_hmax: None,
                transition_distance: None,
                source: "local_override".to_string(),
            },
        ],
        solver_mesh: Some(SolverMeshArtifactRefIR {
            mesh_name: "solver-domain".to_string(),
            mesh_source: None,
            domain_mesh_mode: FemDomainMeshModeIR::SharedDomainMeshWithAir,
            generation_id: Some("g-42".to_string()),
            build_report: None,
        }),
    };
    let errors = semantics
        .validate()
        .expect_err("duplicate object ids should fail mesh semantics validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("duplicated object_id 'body'")));
}

#[test]
fn declared_universe_accepts_scene_box_as_manual_airbox() {
    let value = serde_json::json!({
        "mode": "box",
        "size": [3.2e-6, 2.4e-6, 3.0e-7],
        "center": [0.0, 0.0, 0.0],
        "padding": [0.0, 0.0, 0.0],
        "airbox_hmax": 2.0e-7,
        "airbox_hmin": 2.0e-8,
        "airbox_growth_rate": 2.5,
        "airbox_grading": "geometric"
    });

    let universe = DeclaredUniverseIR::from_study_universe_value(&value)
        .expect("scene universe should lower to declared universe");

    assert_eq!(universe.mode, "manual");
    assert_eq!(universe.size, Some([3.2e-6, 2.4e-6, 3.0e-7]));
    assert_eq!(universe.airbox_hmax, Some(2.0e-7));
    assert_eq!(universe.airbox_hmin, Some(2.0e-8));
    assert_eq!(universe.airbox_growth_rate, Some(2.5));
    assert_eq!(universe.airbox_grading.as_deref(), Some("geometric"));
}

#[test]
fn problem_ir_validation_accepts_valid_mesh_semantics() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.mesh_semantics = Some(MeshSemanticsIR {
        universe_mesh_config: Some(UniverseMeshConfigIR {
            mode: "auto".to_string(),
            size: Some([200e-9, 20e-9, 6e-9]),
            center: None,
            padding: Some([20e-9, 20e-9, 20e-9]),
            airbox_hmax: Some(8e-9),
            airbox_hmin: Some(2e-9),
        }),
        per_object_mesh_configs: vec![PerObjectMeshConfigIR {
            object_id: "strip".to_string(),
            marker: Some(1),
            hmax: Some(2e-9),
            interface_hmax: Some(1e-9),
            transition_distance: Some(5e-9),
            source: "study_default".to_string(),
        }],
        solver_mesh: Some(SolverMeshArtifactRefIR {
            mesh_name: "strip-shared-domain".to_string(),
            mesh_source: Some("artifact://mesh/strip-shared-domain".to_string()),
            domain_mesh_mode: FemDomainMeshModeIR::SharedDomainMeshWithAir,
            generation_id: Some("mesh-gen-1".to_string()),
            build_report: Some(FemSharedDomainBuildReportIR {
                build_mode: "shared_domain".to_string(),
                fallbacks_triggered: Vec::new(),
                effective_airbox_target: None,
                effective_airbox_hmax: Some(8e-9),
                effective_per_object_targets: HashMap::new(),
                region_markers: Vec::new(),
                used_size_field_kinds: vec!["curvature".to_string()],
                size_fields_realized: Vec::new(),
                operation_statuses: Vec::new(),
                thin_film_diagnostics: Vec::new(),
                magnetic_submesh_signatures: Vec::new(),
                degraded: false,
                authored_regions_count: None,
                realized_regions_count: None,
            }),
        }),
    });

    assert!(ir.validate().is_ok());
}

#[test]
fn shared_domain_build_report_preserves_full_mesh_v2_fields() {
    let payload = serde_json::json!({
        "build_mode": "component_aware",
        "fallbacks_triggered": [],
        "effective_airbox_target": {
            "hmax": 180e-9,
            "hmin": 8e-9,
            "growth_rate": 1.65
        },
        "effective_airbox_hmax": 180e-9,
        "effective_per_object_targets": {
            "arch_waveguide": {
                "marker": 1,
                "hmax": 6e-9,
                "interface_hmax": 3e-9,
                "interface_thickness": 8e-9,
                "transition_distance": 12e-9,
                "transition_distance_requested": 12e-9,
                "transition_distance_effective": 12e-9,
                "transition_realization": "explicit",
                "transition_growth": 1.22,
                "edge_hmax": 1.8e-9,
                "edge_thickness": 12e-9,
                "corner_hmax": 1.6e-9,
                "corner_extent": 5e-9,
                "source": "per_geometry"
            }
        },
        "region_markers": [{"geometry_name": "arch_waveguide", "marker": 1}],
        "used_size_field_kinds": [
            "ComponentVolumeConstant",
            "SurfaceDistanceThreshold",
            "EdgeDistanceThreshold"
        ],
        "size_fields_realized": [{
            "kind": "EdgeDistanceThreshold",
            "status": "applied"
        }],
        "operation_statuses": [{
            "kind": "boundary_layer",
            "scope": "global",
            "requested": true,
            "status": "ignored",
            "reason": "no explicit boundary-layer target surfaces or curves were provided",
            "details": {"experimental": true}
        }],
        "thin_film_diagnostics": [{
            "geometry_name": "arch_waveguide",
            "scope": "arch_waveguide",
            "is_thin_film": true,
            "thickness": 2e-9,
            "requested_layers": 1,
            "estimated_layers_from_hmax": 1,
            "actual_method": "layered_surface_tetrahedral",
            "warnings": ["requested through-thickness layer count is below 4"]
        }],
        "magnetic_submesh_signatures": [{
            "geometry_name": "arch_waveguide",
            "marker": 1,
            "node_count": 708,
            "tetra_count": 1941,
            "edge_count": 3355,
            "coordinate_quantization_m": 1e-12,
            "digest": "44067a65a859016cea21ecf2d902837ea7322183d996d420de0ec0d942d29642"
        }],
        "degraded": false,
        "authored_regions_count": 3,
        "realized_regions_count": 2
    });

    let report: FemSharedDomainBuildReportIR =
        serde_json::from_value(payload).expect("full mesh v2 report should deserialize");
    let target = report
        .effective_per_object_targets
        .get("arch_waveguide")
        .expect("arch target should be preserved");
    assert_eq!(target.edge_hmax, Some(1.8e-9));
    assert_eq!(target.edge_thickness, Some(12e-9));
    assert_eq!(target.interface_thickness, Some(8e-9));
    assert_eq!(target.transition_realization.as_deref(), Some("explicit"));
    assert_eq!(report.operation_statuses[0].status, "ignored");
    assert_eq!(
        report.thin_film_diagnostics[0].actual_method.as_deref(),
        Some("layered_surface_tetrahedral")
    );
    assert_eq!(report.authored_regions_count, Some(3));
    assert_eq!(report.realized_regions_count, Some(2));
    assert_eq!(report.magnetic_submesh_signatures[0].node_count, 708);
    assert_eq!(
        report.magnetic_submesh_signatures[0].digest.as_deref(),
        Some("44067a65a859016cea21ecf2d902837ea7322183d996d420de0ec0d942d29642")
    );

    let round_trip = serde_json::to_value(&report).expect("full mesh v2 report should serialize");
    assert_eq!(
        round_trip["effective_per_object_targets"]["arch_waveguide"]["edge_maximum_element_size"],
        1.8e-9
    );
    assert_eq!(
        round_trip["effective_airbox_target"]["maximum_element_size"],
        180e-9
    );
    assert_eq!(
        round_trip["thin_film_diagnostics"][0]["estimated_layers_from_maximum_element_size"],
        1
    );
    assert_eq!(round_trip["operation_statuses"][0]["status"], "ignored");
    assert_eq!(
        round_trip["thin_film_diagnostics"][0]["warnings"][0],
        "requested through-thickness layer count is below 4"
    );
    assert_eq!(round_trip["authored_regions_count"], 3);
    assert_eq!(round_trip["realized_regions_count"], 2);
    assert_eq!(
        round_trip["magnetic_submesh_signatures"][0]["digest"],
        "44067a65a859016cea21ecf2d902837ea7322183d996d420de0ec0d942d29642"
    );
}

#[test]
fn problem_ir_validation_bubbles_mesh_semantics_errors_with_prefix() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.mesh_semantics = Some(MeshSemanticsIR {
        universe_mesh_config: Some(UniverseMeshConfigIR {
            mode: String::new(),
            size: Some([1.0, 1.0, 1.0]),
            center: None,
            padding: None,
            airbox_hmax: Some(-1.0),
            airbox_hmin: Some(-2.0),
        }),
        per_object_mesh_configs: vec![PerObjectMeshConfigIR {
            object_id: String::new(),
            marker: None,
            hmax: Some(0.0),
            interface_hmax: None,
            transition_distance: None,
            source: "broken".to_string(),
        }],
        solver_mesh: Some(SolverMeshArtifactRefIR {
            mesh_name: String::new(),
            mesh_source: Some("   ".to_string()),
            domain_mesh_mode: FemDomainMeshModeIR::MergedMagneticMesh,
            generation_id: Some(" ".to_string()),
            build_report: None,
        }),
    });

    let errors = ir
        .validate()
        .expect_err("invalid mesh semantics should fail ProblemIR validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("mesh_semantics.universe_mesh_config.mode")));
    assert!(errors
        .iter()
        .any(|error| error.contains("mesh_semantics.per_object_mesh_configs.object_id")));
    assert!(errors
        .iter()
        .any(|error| error.contains("mesh_semantics.solver_mesh.mesh_name")));
}

#[test]
fn eigenmodes_require_spectrum_or_mode_output() {
    let mut ir = ProblemIR::bootstrap_example();
    let dynamics = ir.study.dynamics().clone();
    ir.study = StudyIR::Eigenmodes {
        dynamics,
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 4,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: None,
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        spin_wave_bc: SpinWaveBoundaryConditionIR::default(),
        sampling: SamplingIR {
            table_autosave: None,
            outputs: vec![OutputIR::DispersionCurve {
                name: "dispersion".to_string(),
            }],
        },
        mode_tracking: None,
    };

    let errors = ir
        .validate()
        .expect_err("dispersion-only eigen study must fail validation");
    assert!(errors.iter().any(|error| {
        error.contains("eigenmodes study requires at least one eigen_spectrum or eigen_mode output")
    }));
}

#[test]
fn spin_torque_current_source_must_reference_current_transport() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.spin_torque_modules = vec![SpinTorqueModuleIR::ZhangLi {
        current_density: None,
        current_source: Some("drive".to_string()),
        degree: 0.4,
        beta: 0.02,
    }];

    let errors = ir
        .validate()
        .expect_err("missing current transport source must fail validation");
    assert!(errors.iter().any(|error| {
        error.contains("current_source 'drive' must reference a current_transport module")
    }));
}

#[test]
fn slonczewski_fixed_layer_position_accepts_top_and_bottom() {
    for position in ["top", "bottom"] {
        let mut ir = ProblemIR::bootstrap_example();
        ir.spin_torque_modules = vec![SpinTorqueModuleIR::Slonczewski {
            current_density: Some([0.0, 0.0, 5e10]),
            current_source: None,
            degree: 0.4,
            spin_polarization: [0.0, 0.0, 1.0],
            lambda_asymmetry: 1.2,
            epsilon_prime: 0.0,
            free_layer_thickness_m: Some(1.5e-9),
            fixed_layer_position: Some(position.to_string()),
        }];

        ir.validate()
            .unwrap_or_else(|errors| panic!("{position} should validate, got {errors:?}"));
    }
}

#[test]
fn slonczewski_rejects_invalid_fixed_layer_position() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.spin_torque_modules = vec![SpinTorqueModuleIR::Slonczewski {
        current_density: Some([0.0, 0.0, 5e10]),
        current_source: None,
        degree: 0.4,
        spin_polarization: [0.0, 0.0, 1.0],
        lambda_asymmetry: 1.2,
        epsilon_prime: 0.0,
        free_layer_thickness_m: Some(1.5e-9),
        fixed_layer_position: Some("side".to_string()),
    }];

    let errors = ir
        .validate()
        .expect_err("invalid fixed_layer_position must fail validation");
    assert!(errors
        .iter()
        .any(|error| { error.contains("fixed_layer_position must be 'top' or 'bottom'") }));
}

#[test]
fn slonczewski_rejects_non_positive_free_layer_thickness() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.spin_torque_modules = vec![SpinTorqueModuleIR::Slonczewski {
        current_density: Some([0.0, 0.0, 5e10]),
        current_source: None,
        degree: 0.4,
        spin_polarization: [0.0, 0.0, 1.0],
        lambda_asymmetry: 1.2,
        epsilon_prime: 0.0,
        free_layer_thickness_m: Some(0.0),
        fixed_layer_position: Some("top".to_string()),
    }];

    let errors = ir
        .validate()
        .expect_err("non-positive free layer thickness must fail validation");
    assert!(errors
        .iter()
        .any(|error| { error.contains("free_layer_thickness_m must be > 0") }));
}

#[test]
fn excitation_analysis_source_must_reference_antenna_module() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.current_modules.push(CurrentModuleIR::CurrentTransport {
        name: "drive".to_string(),
        model: CurrentTransportModelIR::PrescribedDensity,
        current_density: Some([0.0, 0.0, 5e10]),
        solve_region: None,
        conductivity_s_per_m: None,
    });
    ir.excitation_analysis = Some(ExcitationAnalysisIR {
        source: "drive".to_string(),
        method: "source_k_profile".to_string(),
        propagation_axis: [1.0, 0.0, 0.0],
        k_max_rad_per_m: None,
        samples: 256,
    });

    let errors = ir
        .validate()
        .expect_err("excitation analysis must stay antenna-only");
    assert!(errors
        .iter()
        .any(|error| { error.contains("must reference an antenna_field_source current module") }));
}

#[test]
fn prescribed_zeeman_mask_antenna_source_validates() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.current_modules
        .push(CurrentModuleIR::AntennaFieldSource {
            name: "center_drive".to_string(),
            model: AntennaFieldSourceModelIR::PrescribedZeemanMask,
            solver: None,
            antenna: None,
            drive: None,
            air_box_factor: None,
            object: Some("center_microstrip".to_string()),
            field: Some(AntennaFieldIR {
                amplitude_b_t: 1e-3,
                direction: [0.0, 0.0, 1.0],
            }),
            spatial_profile: Some(AntennaSpatialProfileIR::Uniform),
            waveform: Some(TimeDependenceIR::SincPulse {
                cutoff_hz: 20e9,
                t0: 50e-12,
                amplitude: 1.0,
            }),
        });

    ir.validate()
        .expect("prescribed zeeman mask antenna source should validate");
}

#[test]
fn prescribed_zeeman_mask_requires_field_and_object() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.current_modules
        .push(CurrentModuleIR::AntennaFieldSource {
            name: "center_drive".to_string(),
            model: AntennaFieldSourceModelIR::PrescribedZeemanMask,
            solver: None,
            antenna: None,
            drive: None,
            air_box_factor: None,
            object: None,
            field: None,
            spatial_profile: Some(AntennaSpatialProfileIR::Uniform),
            waveform: None,
        });

    let errors = ir
        .validate()
        .expect_err("prescribed zeeman mask without object and field must fail");
    assert!(errors
        .iter()
        .any(|error| { error.contains("prescribed_zeeman_mask requires object") }));
    assert!(errors
        .iter()
        .any(|error| { error.contains("prescribed_zeeman_mask requires field") }));
}

#[test]
fn oersted_field_source_must_reference_current_transport() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.energy_terms.push(EnergyTermIR::OerstedField {
        model: OerstedFieldModelIR::FromCurrentSolution,
        source: "drive".to_string(),
    });

    let errors = ir
        .validate()
        .expect_err("missing oersted current transport source must fail validation");
    assert!(errors.iter().any(|error| {
        error.contains("oersted_field source 'drive' must reference a current_transport module")
    }));
}

#[test]
fn validation_rejects_multiple_oersted_terms() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.current_modules.push(CurrentModuleIR::CurrentTransport {
        name: "drive".to_string(),
        model: CurrentTransportModelIR::PrescribedDensity,
        current_density: Some([0.0, 0.0, 5e10]),
        solve_region: Some("box".to_string()),
        conductivity_s_per_m: None,
    });
    ir.energy_terms = vec![
        EnergyTermIR::OerstedCylinder {
            current: 1.0,
            radius: 10e-9,
            center: [0.0, 0.0, 0.0],
            axis: [0.0, 0.0, 1.0],
            time_dependence: None,
        },
        EnergyTermIR::OerstedField {
            model: OerstedFieldModelIR::FromCurrentSolution,
            source: "drive".to_string(),
        },
    ];

    let errors = ir
        .validate()
        .expect_err("multiple oersted terms must fail validation");
    assert!(errors.iter().any(|error| {
        error.contains("at most one executable Oersted energy term is currently supported")
    }));
}

#[test]
fn validation_rejects_invalid_dmi_energy_terms() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.energy_terms = vec![
        EnergyTermIR::Exchange,
        EnergyTermIR::InterfacialDmi {
            d: f64::NAN,
            interface_normal: Some([0.0, 0.0, 1.0]),
        },
        EnergyTermIR::InterfacialDmi {
            d: 1.0e-3,
            interface_normal: Some([0.0, f64::INFINITY, 0.0]),
        },
        EnergyTermIR::InterfacialDmi {
            d: 1.0e-3,
            interface_normal: Some([0.0, 0.0, 0.0]),
        },
        EnergyTermIR::BulkDmi { d: f64::INFINITY },
    ];

    let errors = ir
        .validate()
        .expect_err("invalid DMI terms must fail validation");
    assert!(errors
        .iter()
        .any(|error| { error.contains("energy_terms[1] interfacial_dmi D must be finite") }));
    assert!(errors.iter().any(|error| {
        error
            .contains("energy_terms[2] interfacial_dmi interface_normal must contain finite values")
    }));
    assert!(errors.iter().any(|error| {
        error.contains("energy_terms[3] interfacial_dmi interface_normal must be non-zero")
    }));
    assert!(errors
        .iter()
        .any(|error| error.contains("energy_terms[4] bulk_dmi D must be finite")));
}

#[test]
fn validation_rejects_invalid_material_dmi_values() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.materials[0].interfacial_dmi = Some(f64::NAN);
    ir.materials[0].bulk_dmi = Some(f64::INFINITY);
    ir.materials[0].dind_field = Some(vec![1.0e-3, f64::NEG_INFINITY]);
    ir.materials[0].dbulk_field = Some(vec![2.0e-3, f64::NAN]);

    let errors = ir
        .validate()
        .expect_err("invalid material DMI values must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("material 'Py' interfacial_dmi must be finite")));
    assert!(errors
        .iter()
        .any(|error| error.contains("material 'Py' bulk_dmi must be finite")));
    assert!(errors
        .iter()
        .any(|error| error.contains("material 'Py' dind_field must contain finite values")));
    assert!(errors
        .iter()
        .any(|error| error.contains("material 'Py' dbulk_field must contain finite values")));
}

#[test]
fn preset_texture_accepts_preset_params_key() {
    let json = r#"{
        "kind": "preset_texture",
        "preset_kind": "uniform",
        "preset_params": { "direction": [0.0, 0.0, 0.99] }
    }"#;
    let decoded: InitialMagnetizationIR =
        serde_json::from_str(json).expect("preset_params key should deserialize");
    match decoded {
        InitialMagnetizationIR::PresetTexture { preset_params, .. } => {
            let dir = preset_params
                .get("direction")
                .expect("direction key must exist")
                .as_array()
                .expect("direction must be an array");
            assert!((dir[2].as_f64().unwrap() - 0.99).abs() < 1e-6);
        }
        other => panic!("expected PresetTexture, got {:?}", other),
    }
}

#[test]
fn preset_texture_backward_compat_params_alias() {
    let json = r#"{
        "kind": "preset_texture",
        "preset_kind": "uniform",
        "params": { "direction": [0.0, 1.0, 0.0] }
    }"#;
    let decoded: InitialMagnetizationIR =
        serde_json::from_str(json).expect("params alias should deserialize");
    match decoded {
        InitialMagnetizationIR::PresetTexture { preset_params, .. } => {
            let dir = preset_params
                .get("direction")
                .expect("direction key must exist")
                .as_array()
                .expect("direction must be an array");
            assert!((dir[1].as_f64().unwrap() - 1.0).abs() < 1e-6);
        }
        other => panic!("expected PresetTexture, got {:?}", other),
    }
}
