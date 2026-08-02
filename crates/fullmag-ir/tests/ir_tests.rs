use fullmag_ir::*;
use std::collections::{BTreeMap, HashMap};

#[test]
fn planar_monitor_operators_round_trip_with_canonical_snake_case() {
    let fixtures = [
        serde_json::json!({"kind": "plane_sample"}),
        serde_json::json!({"kind": "slab_average", "thickness_m": 5e-9}),
        serde_json::json!({
            "kind": "depth_projection",
            "reduction": "mean_occupied",
            "empty_policy": "exclude_empty"
        }),
        serde_json::json!({
            "kind": "surface_projection",
            "boundary": {"kind": "object_boundary"},
            "visibility_policy": "frontmost"
        }),
    ];

    for fixture in fixtures {
        let operator: PlanarOperatorIR = serde_json::from_value(fixture.clone()).unwrap();
        assert_eq!(serde_json::to_value(operator).unwrap(), fixture);
    }
}

#[test]
fn planar_monitor_previous_payload_defaults_to_no_monitors() {
    let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
    value.as_object_mut().unwrap().remove("planar_monitors");

    let parsed: ProblemIR = serde_json::from_value(value).unwrap();

    assert!(parsed.planar_monitors.is_empty());
}

#[test]
fn planar_monitor_validation_accepts_physical_targets_and_all_operators() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.planar_monitors = vec![
        PlanarMonitorIR {
            id: "plane".into(),
            name: "Plane".into(),
            target: MonitorTargetIR::MagneticDomain,
            frame: PlanarFrameIR::axis_preset(
                PlanarFramePresetIR::Xy,
                0.0,
                PlanarExtentIR::TargetBounds { padding_m: 0.0 },
            ),
            operator: PlanarOperatorIR::PlaneSample,
        },
        PlanarMonitorIR {
            id: "slab".into(),
            name: "Slab".into(),
            target: MonitorTargetIR::Object {
                object_id: "strip".into(),
            },
            frame: PlanarFrameIR::axis_preset(
                PlanarFramePresetIR::Yz,
                0.0,
                PlanarExtentIR::MagneticDomain { padding_m: 0.0 },
            ),
            operator: PlanarOperatorIR::SlabAverage { thickness_m: 5e-9 },
        },
        PlanarMonitorIR {
            id: "depth".into(),
            name: "Depth".into(),
            target: MonitorTargetIR::Domain,
            frame: PlanarFrameIR::axis_preset(
                PlanarFramePresetIR::Xz,
                0.0,
                PlanarExtentIR::Universe { padding_m: 1e-9 },
            ),
            operator: PlanarOperatorIR::DepthProjection {
                reduction: PlanarReductionIR::MeanOccupied,
                empty_policy: EmptyPolicyIR::ExcludeEmpty,
            },
        },
        PlanarMonitorIR {
            id: "surface".into(),
            name: "Surface".into(),
            target: MonitorTargetIR::Object {
                object_id: "strip".into(),
            },
            frame: PlanarFrameIR {
                origin_m: [0.0; 3],
                u_axis: [2.0_f64.sqrt().recip(), -2.0_f64.sqrt().recip(), 0.0],
                v_axis: [
                    6.0_f64.sqrt().recip(),
                    6.0_f64.sqrt().recip(),
                    -2.0 * 6.0_f64.sqrt().recip(),
                ],
                normal: [3.0_f64.sqrt().recip(); 3],
                preset: None,
                normalization_version: "planar_frame_v1".into(),
                extent: PlanarExtentIR::Explicit {
                    u_min_m: -1e-7,
                    u_max_m: 1e-7,
                    v_min_m: -5e-8,
                    v_max_m: 5e-8,
                },
            },
            operator: PlanarOperatorIR::SurfaceProjection {
                boundary: SurfaceBoundarySelectorIR::ObjectBoundary,
                visibility_policy: SurfaceVisibilityPolicyIR::Frontmost,
            },
        },
    ];

    ir.validate().expect("valid planar monitors");
}

#[test]
fn planar_monitor_validation_rejects_invalid_values_and_duplicates() {
    let mut ir = ProblemIR::bootstrap_example();
    let invalid = PlanarMonitorIR {
        id: "duplicate".into(),
        name: "Duplicate".into(),
        target: MonitorTargetIR::Region {
            object_id: "strip".into(),
            region_id: "missing".into(),
        },
        frame: PlanarFrameIR {
            origin_m: [f64::NAN, 0.0, 0.0],
            u_axis: [1.0, 0.0, 0.0],
            v_axis: [0.0, 1.0, 0.0],
            normal: [0.0, 0.0, 1.0],
            preset: None,
            normalization_version: "planar_frame_v1".into(),
            extent: PlanarExtentIR::Explicit {
                u_min_m: 1.0,
                u_max_m: 0.0,
                v_min_m: -1.0,
                v_max_m: 1.0,
            },
        },
        operator: PlanarOperatorIR::SlabAverage { thickness_m: 0.0 },
    };
    ir.planar_monitors = vec![invalid.clone(), invalid];

    let errors = ir.validate().expect_err("invalid monitors must fail");
    let joined = errors.join("\n");
    assert!(joined.contains("id must be non-empty and unique"));
    assert!(joined.contains("name must be non-empty and unique"));
    assert!(joined.contains("origin_m must be finite"));
    assert!(joined.contains("u_min_m < u_max_m"));
    assert!(joined.contains("thickness_m must be finite and > 0"));
    assert!(joined.contains("target region 'strip/missing' does not exist"));
}

#[test]
fn planar_monitor_wire_contract_rejects_runtime_only_targets() {
    for kind in ["mesh_part", "airbox"] {
        let value = serde_json::json!({
            "id": "invalid",
            "name": "Invalid",
            "target": {"kind": kind, "part_id": "part-1"},
            "frame": {
                "origin_m": [0.0, 0.0, 0.0],
                "u_axis": [1.0, 0.0, 0.0],
                "v_axis": [0.0, 1.0, 0.0],
                "normal": [0.0, 0.0, 1.0],
                "preset": "xy",
                "normalization_version": "planar_frame_v1",
                "extent": {"kind": "target_bounds", "padding_m": 0.0}
            },
            "operator": {"kind": "plane_sample"}
        });

        assert!(serde_json::from_value::<PlanarMonitorIR>(value).is_err());
    }
}

#[test]
fn sampling_policy_round_trips_legacy_explicit_and_auto_sinc() {
    let legacy: TableAutosaveIR = serde_json::from_value(serde_json::json!({
        "kind": "table_autosave",
        "table_id": "default",
        "sample_period_s": 2e-12,
        "quantities": ["t", "mx"]
    }))
    .unwrap();
    assert_eq!(legacy.explicit_sample_period_s(), Some(2e-12));
    assert_eq!(
        serde_json::to_value(&legacy).unwrap()["sample_period_s"],
        serde_json::json!(2e-12)
    );

    let automatic: TableAutosaveIR = serde_json::from_value(serde_json::json!({
        "kind": "table_autosave",
        "table_id": "default",
        "sample_period_policy": {
            "kind": "auto_sinc_cutoff",
            "nyquist_guard_factor": 1.3
        },
        "quantities": ["t", "mx"]
    }))
    .unwrap();
    assert!(automatic.requests_auto_sinc_cutoff());
    assert_eq!(
        serde_json::to_value(automatic).unwrap()["sample_period_policy"]["kind"],
        "auto_sinc_cutoff"
    );
}

#[test]
fn table_autosave_step_cadence_round_trips_and_rejects_time_ambiguity() {
    let step_cadence: TableAutosaveIR = serde_json::from_value(serde_json::json!({
        "kind": "table_autosave",
        "table_id": "default",
        "every_steps": 10,
        "quantities": ["step", "mx"]
    }))
    .unwrap();
    let mut ir = ProblemIR::bootstrap_example();
    let sampling = ir.study.sampling().clone();
    ir.study = StudyIR::Relaxation {
        algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
        dynamics: None,
        stop: RelaxStopIR {
            torque_tolerance_apm: None,
            energy_tolerance_j: None,
            max_steps: Some(100),
            max_relaxation_time_s: None,
        },
        sampling,
    };
    ir.study.sampling_mut().table_autosave = Some(step_cadence.clone());
    ir.validate()
        .expect("accepted-step table cadence must be valid authoring intent");
    assert_eq!(
        serde_json::to_value(&step_cadence).unwrap()["every_steps"],
        serde_json::json!(10)
    );

    let ambiguous: TableAutosaveIR = serde_json::from_value(serde_json::json!({
        "kind": "table_autosave",
        "table_id": "default",
        "sample_period_s": 1e-12,
        "every_steps": 10,
        "quantities": ["step", "mx"]
    }))
    .unwrap();
    ir.study.sampling_mut().table_autosave = Some(ambiguous);
    let errors = ir
        .validate()
        .expect_err("time and accepted-step table cadence are mutually exclusive");
    assert!(errors
        .iter()
        .any(|error| error.contains("cadence state is ambiguous")));

    let mut time_evolution = ProblemIR::bootstrap_example();
    time_evolution.study.sampling_mut().table_autosave = Some(step_cadence);
    let errors = time_evolution
        .validate()
        .expect_err("accepted-step cadence must not be accepted by time evolution");
    assert!(errors
        .iter()
        .any(|error| error.contains("only valid for relaxation studies")));
}

#[test]
fn stage_autosave_serde_preserves_formats_layouts_and_clock_kinds() {
    let continuous: StageAutosaveIR = serde_json::from_value(serde_json::json!({
        "kind": "stage_autosave",
        "target": "main",
        "layout": "continuous",
        "format": "zarr",
        "table": {
            "kind": "table_autosave",
            "table_id": "default",
            "every_steps": 10,
            "quantities": ["step", "mx"]
        },
        "fields": [{
            "kind": "field_autosave",
            "quantity": "m",
            "every_steps": 20
        }]
    }))
    .expect("accepted-step autosave policy should deserialize");
    assert_eq!(continuous.layout, AutosaveLayoutIR::Continuous);
    assert_eq!(continuous.format, AutosaveFormatIR::Zarr);
    assert_eq!(continuous.fields[0].accepted_step_cadence(), Some(20));

    for format in ["hdf5", "txt"] {
        let policy: StageAutosaveIR = serde_json::from_value(serde_json::json!({
            "kind": "stage_autosave",
            "target": "run-output",
            "layout": "separate",
            "format": format,
            "table": {
                "kind": "table_autosave",
                "table_id": "default",
                "sample_period_s": 1e-12,
                "quantities": ["step", "t", "mx"]
            },
            "fields": []
        }))
        .expect("time-clock autosave policy should deserialize");
        assert_eq!(policy.layout, AutosaveLayoutIR::Separate);
        assert_eq!(serde_json::to_value(policy).unwrap()["format"], format);
    }
}

#[test]
fn stage_autosave_validation_accepts_matching_relax_and_run_clocks() {
    let mut relax = ProblemIR::bootstrap_example();
    let sampling = relax.study.sampling().clone();
    relax.study = StudyIR::Relaxation {
        algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
        dynamics: None,
        stop: RelaxStopIR {
            torque_tolerance_apm: None,
            energy_tolerance_j: None,
            max_steps: Some(100),
            max_relaxation_time_s: None,
        },
        sampling,
    };
    relax.study.sampling_mut().stage_autosave = Some(
        serde_json::from_value(serde_json::json!({
            "kind": "stage_autosave",
            "target": "main",
            "layout": "continuous",
            "format": "zarr",
            "table": {"every_steps": 10, "quantities": ["step", "mx"]},
            "fields": [{"quantity": "m", "every_steps": 20}]
        }))
        .unwrap(),
    );
    relax
        .validate()
        .expect("Relax accepted-step policy is valid");

    let mut run = ProblemIR::bootstrap_example();
    run.study.sampling_mut().stage_autosave = Some(
        serde_json::from_value(serde_json::json!({
            "kind": "stage_autosave",
            "target": "main",
            "layout": "continuous",
            "format": "hdf5",
            "table": {"sample_period_s": 1e-12, "quantities": ["step", "t"]},
            "fields": [{"quantity": "m", "every_seconds": 2e-12}]
        }))
        .unwrap(),
    );
    run.validate().expect("Run physical-time policy is valid");
}

#[test]
fn stage_autosave_validation_rejects_txt_fields_duplicates_and_unsafe_target() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study.sampling_mut().stage_autosave = Some(
        serde_json::from_value(serde_json::json!({
            "kind": "stage_autosave",
            "target": "../escape",
            "layout": "continuous",
            "format": "txt",
            "table": {
                "sample_period_s": 1e-12,
                "quantities": ["step", "step"]
            },
            "fields": [
                {"quantity": "m", "every_seconds": 1e-12},
                {"quantity": "m", "every_seconds": 2e-12}
            ]
        }))
        .unwrap(),
    );
    let errors = ir
        .validate()
        .expect_err("invalid storage policy must fail closed");
    for expected in [
        "target must start",
        "txt format supports scalar tables only",
        "duplicate quantity 'step'",
        "duplicate field quantity 'm'",
    ] {
        assert!(
            errors.iter().any(|error| error.contains(expected)),
            "missing {expected:?} in {errors:?}"
        );
    }
}

#[test]
fn stage_autosave_validation_rejects_study_clock_mismatches() {
    let mut run = ProblemIR::bootstrap_example();
    run.study.sampling_mut().stage_autosave = Some(
        serde_json::from_value(serde_json::json!({
            "target": "main",
            "layout": "continuous",
            "format": "zarr",
            "table": {"every_steps": 10, "quantities": ["step"]},
            "fields": [{"quantity": "m", "every_steps": 10}]
        }))
        .unwrap(),
    );
    let errors = run
        .validate()
        .expect_err("Run must reject accepted-step cadence");
    assert!(errors
        .iter()
        .any(|error| error.contains("only valid for relaxation")));

    let mut relax = ProblemIR::bootstrap_example();
    let sampling = relax.study.sampling().clone();
    relax.study = StudyIR::Relaxation {
        algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
        dynamics: None,
        stop: RelaxStopIR {
            torque_tolerance_apm: None,
            energy_tolerance_j: None,
            max_steps: Some(100),
            max_relaxation_time_s: None,
        },
        sampling,
    };
    relax.study.sampling_mut().stage_autosave = Some(
        serde_json::from_value(serde_json::json!({
            "target": "main",
            "layout": "continuous",
            "format": "zarr",
            "fields": [{"quantity": "m", "every_seconds": 1e-12}]
        }))
        .unwrap(),
    );
    let errors = relax
        .validate()
        .expect_err("Relax must reject physical-time cadence");
    assert!(errors
        .iter()
        .any(|error| error.contains("must use every_steps")));
}

#[test]
fn sampling_policy_round_trips_automatic_field_and_scalar_outputs() {
    for (kind, expected_name) in [("field_auto", "m"), ("scalar_auto", "mx")] {
        let output: OutputIR = serde_json::from_value(serde_json::json!({
            "kind": kind,
            "name": expected_name,
            "sample_period_policy": {
                "kind": "auto_sinc_cutoff",
                "nyquist_guard_factor": 1.3
            }
        }))
        .unwrap();

        assert_eq!(output.periodic_name(), Some(expected_name));
        assert!(output.requests_auto_sinc_cutoff());
        match kind {
            "field_auto" => assert!(matches!(output, OutputIR::FieldAuto { .. })),
            "scalar_auto" => assert!(matches!(output, OutputIR::ScalarAuto { .. })),
            _ => unreachable!(),
        }
    }
}

#[test]
fn sampling_policy_validation_accepts_unresolved_and_resolved_auto_intent() {
    let mut ir = ProblemIR::bootstrap_example();
    let table = TableAutosaveIR {
        kind: "table_autosave".into(),
        table_id: "default".into(),
        sample_period_s: None,
        sample_period_policy: Some(SamplingPeriodPolicyIR::AutoSincCutoff {
            nyquist_guard_factor: AUTO_SINC_NYQUIST_GUARD_FACTOR,
        }),
        resolved_sample_period_s: None,
        every_steps: None,
        quantities: vec!["t".into(), "mx".into()],
        expressions: Vec::new(),
    };
    ir.study.sampling_mut().table_autosave = Some(table);
    ir.validate()
        .expect("unresolved automatic sampling is valid authoring intent");

    let table = ir.study.sampling_mut().table_autosave.as_mut().unwrap();
    table.set_resolved_sample_period_s(2e-12);
    assert_eq!(table.sample_period_s, None);
    assert_eq!(table.resolved_sample_period_s, Some(2e-12));
    assert_eq!(table.explicit_sample_period_s(), None);
    ir.validate()
        .expect("resolved automatic sampling remains valid automatic intent");
}

#[test]
fn sampling_policy_rejects_unmarked_numeric_and_auto_authoring_state() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study.sampling_mut().table_autosave = Some(
        serde_json::from_value(serde_json::json!({
            "kind": "table_autosave",
            "table_id": "default",
            "sample_period_s": 2e-12,
            "sample_period_policy": {
                "kind": "auto_sinc_cutoff",
                "nyquist_guard_factor": 1.3
            },
            "quantities": ["t", "mx"]
        }))
        .unwrap(),
    );
    let errors = ir
        .validate()
        .expect_err("authoring payload must not combine explicit and automatic cadence");
    assert!(errors
        .iter()
        .any(|error| error.contains("cadence state is ambiguous")));
}

#[test]
fn sampling_policy_validation_rejects_invalid_explicit_table_periods() {
    for period in [0.0, -1e-12, f64::NAN, f64::INFINITY] {
        let mut ir = ProblemIR::bootstrap_example();
        ir.study.sampling_mut().table_autosave = Some(TableAutosaveIR {
            kind: "table_autosave".into(),
            table_id: "default".into(),
            sample_period_s: Some(period),
            sample_period_policy: None,
            resolved_sample_period_s: None,
            every_steps: None,
            quantities: vec!["t".into()],
            expressions: Vec::new(),
        });
        let errors = ir
            .validate()
            .expect_err("explicit table cadence must be finite and positive");
        assert!(errors
            .iter()
            .any(|error| error.contains("sample_period_s must be finite and positive")));
    }
}

#[test]
fn sampling_policy_preserves_legacy_numeric_field_serialization() {
    let output = OutputIR::Field {
        name: "m".into(),
        every_seconds: 2e-12,
    };
    assert_eq!(
        serde_json::to_value(output).unwrap(),
        serde_json::json!({
            "kind": "field", "name": "m", "every_seconds": 2e-12
        })
    );
}

#[test]
fn resolved_auto_output_preserves_policy_and_validates_resolved_period() {
    let output = OutputIR::FieldResolvedAuto {
        name: "m".into(),
        every_seconds: 2e-12,
        requested_policy: SamplingPeriodPolicyIR::AutoSincCutoff {
            nyquist_guard_factor: AUTO_SINC_NYQUIST_GUARD_FACTOR,
        },
    };
    assert_eq!(
        serde_json::to_value(&output).unwrap(),
        serde_json::json!({
            "kind": "field_resolved_auto",
            "name": "m",
            "every_seconds": 2e-12,
            "requested_policy": {
                "kind": "auto_sinc_cutoff",
                "nyquist_guard_factor": 1.3
            }
        })
    );

    let mut ir = ProblemIR::bootstrap_example();
    ir.study.sampling_mut().outputs = vec![OutputIR::ScalarResolvedAuto {
        name: "mx".into(),
        every_seconds: f64::NAN,
        requested_policy: SamplingPeriodPolicyIR::AutoSincCutoff {
            nyquist_guard_factor: 1.2,
        },
    }];
    let errors = ir
        .validate()
        .expect_err("resolved auto output must retain valid policy and cadence");
    assert!(errors
        .iter()
        .any(|error| error.contains("nyquist_guard_factor must be exactly 1.3")));
    assert!(errors
        .iter()
        .any(|error| error.contains("finite positive every_seconds")));
}

#[test]
fn sampling_policy_validation_rejects_missing_mode_and_noncanonical_values() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study.sampling_mut().table_autosave = Some(TableAutosaveIR {
        kind: "table_autosave".into(),
        table_id: "default".into(),
        sample_period_s: None,
        sample_period_policy: None,
        resolved_sample_period_s: None,
        every_steps: None,
        quantities: vec!["t".into()],
        expressions: Vec::new(),
    });
    let errors = ir
        .validate()
        .expect_err("table autosave must request an explicit or automatic mode");
    assert!(errors
        .iter()
        .any(|error| error.contains("requires sample_period_s")));

    ir.study.sampling_mut().table_autosave = None;
    ir.study.sampling_mut().outputs = vec![OutputIR::FieldAuto {
        name: "m".into(),
        sample_period_policy: SamplingPeriodPolicyIR::AutoSincCutoff {
            nyquist_guard_factor: 1.2,
        },
    }];
    let errors = ir
        .validate()
        .expect_err("automatic sampling must use the canonical guard factor");
    assert!(errors
        .iter()
        .any(|error| error.contains("nyquist_guard_factor must be exactly 1.3")));

    ir.study.sampling_mut().outputs = vec![OutputIR::Scalar {
        name: "mx".into(),
        every_seconds: f64::NAN,
    }];
    let errors = ir
        .validate()
        .expect_err("explicit sampling periods must be finite");
    assert!(errors
        .iter()
        .any(|error| error.contains("finite positive every_seconds")));
}

#[test]
fn execution_plans_carry_regional_field_drives_without_legacy_aliasing() {
    fn fdm_drives(plan: &FdmPlanIR) -> &[RegionalFieldDriveIR] {
        &plan.field_drives
    }
    fn fem_drives(plan: &FemPlanIR) -> &[RegionalFieldDriveIR] {
        &plan.field_drives
    }

    let fdm = FdmPlanIR::default();
    assert!(fdm_drives(&fdm).is_empty());
    let _fem_contract: fn(&FemPlanIR) -> &[RegionalFieldDriveIR] = fem_drives;
}

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
fn steady_spin_transport_round_trips_as_top_level_typed_ir() {
    let mut value = problem_ir_value_with_version(CURRENT_IR_VERSION);
    value["current_modules"] = serde_json::json!([{
        "kind": "current_transport", "name": "charge",
        "model": "ohmic_poisson", "coupling": "one_way",
        "domain": [{"object_id": "strip"}],
        "materials": [{"region": {"object_id": "strip"},
            "material": {"sigma_Spm": 4.0e6}}],
        "boundaries": [
            {"kind": "voltage_electrode", "id": "ground", "surfaces": [
                {"object_id": "strip", "surface_id": "x_min", "orientation": [-1.0, 0.0, 0.0]}
            ], "potential_V": 0.0},
            {"kind": "voltage_electrode", "id": "drive", "surfaces": [
                {"object_id": "strip", "surface_id": "x_max", "orientation": [1.0, 0.0, 0.0]}
            ], "potential_V": 0.1}
        ],
        "gauge": "dirichlet_reference",
        "solver": {"engine": "cg", "linear": {"relative_tolerance": 1.0e-10,
            "absolute_tolerance": 0.0, "max_iterations": 1000},
            "physical_residual_version": "charge_balance_integrated_l2.v1",
            "operator_version": "fv_charge_harmonic_v1"}
    }]);
    value["spin_transport_modules"] = serde_json::json!([{
        "schema_version": "spin_transport.v1", "id": "spin_solve",
        "current_source_id": "charge", "mode": "steady",
        "domain": [{"object_id": "strip"}],
        "materials": [{"region": {"object_id": "strip"}, "material": {
            "sigma_s_Spm": 5.0e6, "polarization_p": 0.4, "theta_sh": 0.1,
            "lambda_sf_m": 5.0e-9, "lambda_j_m": 1.0e-9,
            "lambda_phi_m": "disabled"
        }}],
        "interfaces": [{
            "kind": "mixing_conductance", "id": "nf",
            "normal_to_ferromagnet": [1.0, 0.0, 0.0],
            "normal_side": {"object_id": "strip"},
            "ferromagnet_side": {"object_id": "strip"},
            "g_up_Spm2": 1.0, "g_down_Spm2": 1.0,
            "g_r_Spm2": 1.0, "g_i_Spm2": 0.0,
            "spin_memory_loss": {
                "g_n_Spm2": 1.0, "g_f_Spm2": 2.0,
                "g_lattice_Spm2": 3.0,
                "formula_version": "sml_reservoir.fullmag.v2"
            },
            "absorption": "full_absorption",
            "formula_version": "magnetoelectronic.fullmag.v2"
        }], "boundaries": [],
        "solver": {"engine": "auto", "linear": {"relative_tolerance": 1.0e-8,
            "absolute_tolerance": 0.0, "max_iterations": 500},
            "physical_residual_version": "transport_balance_integrated_l2.v1",
            "operator_version": "fv_spin_upwind_v1",
            "default_external_boundary": "spin_insulating"},
        "requested_execution": {"discretization": "fdm", "device": "cpu",
            "precision": "double", "execution_mode": "strict"},
        "constitutive_version": "transport_constitutive.one_way.fullmag.v1"
    }]);
    value["spin_torque_modules"] = serde_json::json!([{
        "kind": "drift_diffusion_spin_torque",
        "schema_version": "drift_diffusion_spin_torque.v1", "id": "tr",
        "solve_id": "spin_solve", "target": {"object_id": "strip"},
        "formula_version": "transport_torque_angular_momentum.fullmag.v1"
    }]);

    let decoded: ProblemIR = serde_json::from_value(value).expect("typed M1 IR should decode");
    decoded.validate().expect("typed M1 IR should validate");
    assert_eq!(decoded.spin_transport_modules.len(), 1);
    let encoded = serde_json::to_value(decoded).expect("typed M1 IR should encode");
    assert_eq!(
        encoded["current_modules"][0]["gauge"],
        "dirichlet_reference"
    );
    assert_eq!(
        encoded["current_modules"][0]["boundaries"][1]["potential_V"],
        0.1
    );
    assert_eq!(encoded["spin_transport_modules"][0]["mode"], "steady");
    assert!(encoded["spin_transport_modules"][0]
        .get("coupling")
        .is_none());

    let mut transient_value = encoded;
    transient_value["spin_transport_modules"][0]["mode"] = serde_json::json!("transient");
    transient_value["spin_transport_modules"][0]["materials"][0]["material"]
        ["density_of_states_per_spin_Jinv_m3"] = serde_json::json!(2.0);
    transient_value["spin_transport_modules"][0]["materials"][0]["material"]
        ["capacitance_formula_version"] =
            serde_json::json!("dos_isotropic_nonmagnetic.fullmag.v1");
    let transient: ProblemIR =
        serde_json::from_value(transient_value.clone()).expect("transient M3 IR should decode");
    let mut transient = transient;
    let StudyIR::TimeEvolution { dynamics, .. } = &mut transient.study else {
        panic!("typed transport fixture must be time evolution")
    };
    let DynamicsIR::Llg { integrator, .. } = dynamics;
    *integrator = "coupled_imex_ark2".to_string();
    transient
        .validate()
        .expect("transient M3 IR with the coupled integrator should validate semantically");
    assert_eq!(
        transient.spin_transport_modules[0].materials[0]
            .material
            .density_of_states_per_spin_j_inv_m3,
        Some(2.0)
    );
    let mut inconsistent = transient.clone();
    inconsistent.spin_transport_modules[0].materials[0]
        .material
        .spin_capacitance_as_per_v_m3 = Some(1.0);
    assert!(inconsistent
        .validate()
        .unwrap_err()
        .iter()
        .any(|error| error.contains("must equal e^2 times density_of_states")));

    let mut unsupported_capacitance = transient.clone();
    unsupported_capacitance.spin_transport_modules[0].materials[0]
        .material
        .capacitance_formula_version = Some("dos_constant.fullmag.v1".to_string());
    assert!(unsupported_capacitance
        .validate()
        .unwrap_err()
        .iter()
        .any(|error| error.contains("unsupported capacitance_formula_version")));

    let mut unsupported_sml = transient.clone();
    if let SpinInterfaceIR::MixingConductance { formula_version, .. } =
        &mut unsupported_sml.spin_transport_modules[0].interfaces[0]
    {
        *formula_version = "magnetoelectronic.fullmag.v1".to_string();
    }
    assert!(unsupported_sml
        .validate()
        .unwrap_err()
        .iter()
        .any(|error| error.contains("magnetoelectronic.fullmag.v2")));

    let mut explicit_transient = transient.clone();
    let StudyIR::TimeEvolution { dynamics, .. } = &mut explicit_transient.study else {
        unreachable!()
    };
    let DynamicsIR::Llg { integrator, .. } = dynamics;
    *integrator = "rk45".to_string();
    assert!(explicit_transient
        .validate()
        .unwrap_err()
        .iter()
        .any(|error| error.contains("transient spin requires llg.integrator='coupled_imex_ark2'")));

    let mut steady_coupled = transient.clone();
    steady_coupled.spin_transport_modules[0].mode = SpinTransportModeIR::Steady;
    assert!(steady_coupled
        .validate()
        .unwrap_err()
        .iter()
        .any(|error| error.contains("steady spin rejects llg.integrator='coupled_imex_ark2'")));

    let mut transient_value = serde_json::to_value(transient).unwrap();
    transient_value["spin_transport_modules"][0]["materials"][0]["material"]
        .as_object_mut()
        .unwrap()
        .remove("density_of_states_per_spin_Jinv_m3");
    let invalid: ProblemIR = serde_json::from_value(transient_value).unwrap();
    assert!(invalid
        .validate()
        .unwrap_err()
        .iter()
        .any(|error| error.contains("capacitance_formula_version requires spin capacitance")));
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

fn problem_ir_value_with_version(version: &str) -> serde_json::Value {
    let mut value = serde_json::to_value(ProblemIR::bootstrap_example())
        .expect("bootstrap ProblemIR should serialize");
    value["ir_version"] = serde_json::json!(version);
    value["problem_meta"]["script_api_version"] = serde_json::json!(version);
    value["problem_meta"]["serializer_version"] = serde_json::json!(version);
    value
}

#[test]
fn prescribed_sot_migrates_0_2_inline_scalar_without_losing_sign_or_zero_sigma() {
    let mut value = problem_ir_value_with_version("0.2.0");
    value["spin_torque_modules"] = serde_json::json!([{
        "kind": "spin_orbit_torque",
        "charge_current_density_a_per_m2": -5.0e10,
        "damping_like_efficiency": 0.12,
        "field_like_efficiency": -0.03,
        "spin_polarization": [0.0, 0.0, 0.0],
        "ferromagnet_thickness_m": 1.5e-9
    }]);

    let decoded: ProblemIR = serde_json::from_value(value).expect("0.2 SOT should migrate");
    let canonical = serde_json::to_value(decoded).expect("migrated SOT should serialize");
    let sot = &canonical["spin_torque_modules"][0];
    assert_eq!(canonical["ir_version"], "0.3.0");
    assert_eq!(sot["kind"], "prescribed_sot");
    assert_eq!(sot["schema_version"], "prescribed_sot.v1");
    assert_eq!(sot["id"], "legacy_prescribed_sot_0");
    assert_eq!(sot.get("target"), Some(&serde_json::Value::Null));
    assert_eq!(sot["formula_version"], "prescribed_sot.legacy_fullmag.v0");
    assert_eq!(sot["drive"]["kind"], "legacy_scalar_magnitude");
    assert_eq!(sot["drive"]["raw_charge_current_density_Apm2"], -5.0e10);
    assert_eq!(
        sot["raw_spin_polarization"],
        serde_json::json!([0.0, 0.0, 0.0])
    );
    assert_eq!(sot["compatibility_origin"]["source_ir_version"], "0.2.0");
    assert_eq!(
        sot["compatibility_origin"]["authored_kind"],
        "spin_orbit_torque"
    );
}

#[test]
fn prescribed_sot_migrates_0_2_current_source_to_legacy_norm_drive() {
    let mut value = problem_ir_value_with_version("0.2.0");
    value["spin_torque_modules"] = serde_json::json!([{
        "kind": "spin_orbit_torque",
        "current_source": "charge",
        "damping_like_efficiency": 0.12,
        "field_like_efficiency": 0.03,
        "spin_polarization": [0.0, 2.0, 0.0],
        "ferromagnet_thickness_m": 1.5e-9
    }]);

    let decoded: ProblemIR = serde_json::from_value(value).expect("0.2 source SOT should migrate");
    let canonical = serde_json::to_value(decoded).expect("migrated SOT should serialize");
    let sot = &canonical["spin_torque_modules"][0];
    assert_eq!(sot["drive"]["kind"], "legacy_current_source_norm");
    assert_eq!(sot["drive"]["current_source_id"], "charge");
    assert_eq!(
        sot["raw_spin_polarization"],
        serde_json::json!([0.0, 2.0, 0.0])
    );
}

#[test]
fn explicit_0_1_migration_chain_preserves_cylinder_axis_and_reaches_0_3() {
    let mut value = problem_ir_value_with_version("0.1.0");
    value["geometry"]["entries"] = serde_json::json!([{
        "kind": "cylinder", "name": "legacy", "radius": 1.0, "height": 2.0
    }]);
    value["spin_torque_modules"] = serde_json::json!([{
        "kind": "spin_orbit_torque",
        "charge_current_density_a_per_m2": 1.0,
        "damping_like_efficiency": 0.1,
        "field_like_efficiency": 0.0,
        "spin_polarization": [0.0, 1.0, 0.0],
        "ferromagnet_thickness_m": 1.0e-9
    }]);

    assert!(migrate_problem_ir_json_value(&mut value).expect("explicit chain should migrate"));
    assert_eq!(value["ir_version"], "0.3.0");
    assert_eq!(
        value["geometry"]["entries"][0]["axis"],
        serde_json::json!([0.0, 0.0, 1.0])
    );
    assert_eq!(value["spin_torque_modules"][0]["kind"], "prescribed_sot");
}

#[test]
fn standard_reader_rejects_0_1_without_explicit_chain() {
    let value = problem_ir_value_with_version("0.1.0");
    let error = serde_json::from_value::<ProblemIR>(value)
        .expect_err("standard reader must not silently chain 0.1.0");
    assert!(error.to_string().contains("not supported for direct read"));
}

#[test]
fn canonical_prescribed_sot_v1_round_trips_signed_scalar() {
    let mut value = problem_ir_value_with_version("0.3.0");
    value["spin_torque_modules"] = serde_json::json!([{
        "kind": "prescribed_sot",
        "schema_version": "prescribed_sot.v1",
        "id": "sot",
        "target": {"object_id": "strip"},
        "formula_version": "prescribed_sot.fullmag.v1",
        "drive": {"kind": "signed_scalar", "current_density_Apm2": -5.0e10,
                  "sigma_hat": [0.0, 2.0, 0.0],
                  "envelope": {"kind": "piecewise_linear",
                               "points": [{"time_s": 0.0, "value": 0.0},
                                          {"time_s": 1.0e-9, "value": 1.0}]}},
        "xi_dl": 0.12,
        "xi_fl": -0.03,
        "free_layer_thickness_m": 1.5e-9
    }]);

    let decoded: ProblemIR =
        serde_json::from_value(value.clone()).expect("canonical v1 should decode");
    assert!(decoded.validate().is_ok());
    let encoded = serde_json::to_value(decoded).expect("canonical v1 should encode");
    assert_eq!(encoded["spin_torque_modules"], value["spin_torque_modules"]);
}

#[test]
fn prescribed_sot_time_envelope_round_trips_every_canonical_variant() {
    let envelopes = vec![
        serde_json::json!({"kind": "constant", "value": 0.5}),
        serde_json::json!({"kind": "sinusoidal", "amplitude": 2.0,
            "frequency_hz": 0.0, "phase_rad": 0.25, "offset": -0.5}),
        serde_json::json!({"kind": "pulse", "amplitude": 3.0,
            "t_on_s": 1.0e-12, "t_off_s": 2.0e-12}),
        serde_json::json!({"kind": "piecewise_linear", "points": [
            {"time_s": 0.0, "value": 0.0}, {"time_s": 1.0e-9, "value": 1.0}]}),
        serde_json::json!({"kind": "sinc", "amplitude": 1.5,
            "center_s": 2.0e-9, "bandwidth_hz": 3.0e9, "offset": 0.1}),
        serde_json::json!({"kind": "tabulated", "artifact_ref": "artifact://drive.csv",
            "interpolation": "previous", "extrapolation": "hold", "bandwidth_hz": 1.0e9}),
    ];

    for envelope in envelopes {
        let mut value = problem_ir_value_with_version("0.3.0");
        value["spin_torque_modules"] = serde_json::json!([{
            "kind": "prescribed_sot", "schema_version": "prescribed_sot.v1", "id": "sot",
            "target": {"object_id": "strip"}, "formula_version": "prescribed_sot.fullmag.v1",
            "drive": {"kind": "signed_scalar", "current_density_Apm2": 1.0,
                      "sigma_hat": [0.0, 2.0, 0.0], "envelope": envelope},
            "xi_dl": 0.1, "xi_fl": 0.0, "free_layer_thickness_m": 1.0e-9
        }]);
        let decoded: ProblemIR = serde_json::from_value(value.clone())
            .expect("canonical TimeEnvelopeIR variant should decode");
        assert!(decoded.validate().is_ok());
        let encoded = serde_json::to_value(decoded).expect("TimeEnvelopeIR should encode");
        assert_eq!(encoded["spin_torque_modules"], value["spin_torque_modules"]);
    }
}

#[test]
fn prescribed_sot_tabulated_envelope_serializes_canonical_defaults() {
    let mut value = problem_ir_value_with_version("0.3.0");
    value["spin_torque_modules"] = serde_json::json!([{
        "kind": "prescribed_sot", "schema_version": "prescribed_sot.v1", "id": "sot",
        "target": {"object_id": "strip"}, "formula_version": "prescribed_sot.fullmag.v1",
        "drive": {"kind": "signed_scalar", "current_density_Apm2": 1.0,
                  "sigma_hat": [0.0, 2.0, 0.0],
                  "envelope": {"kind": "tabulated", "artifact_ref": "artifact://drive.csv"}},
        "xi_dl": 0.1, "xi_fl": 0.0, "free_layer_thickness_m": 1.0e-9
    }]);
    let decoded: ProblemIR = serde_json::from_value(value).expect("defaults should decode");
    assert!(decoded.validate().is_ok());
    let encoded = serde_json::to_value(decoded).expect("defaults should encode");
    let envelope = &encoded["spin_torque_modules"][0]["drive"]["envelope"];
    assert_eq!(envelope["interpolation"], "linear");
    assert_eq!(envelope["extrapolation"], "error");
}

#[test]
fn prescribed_sot_time_envelope_rejects_invalid_boundaries() {
    let invalid = [
        (
            serde_json::json!({"kind": "sinusoidal", "amplitude": 1.0,
            "frequency_hz": -1.0, "phase_rad": 0.0, "offset": 0.0}),
            "frequency_hz",
        ),
        (
            serde_json::json!({"kind": "pulse", "amplitude": 1.0,
            "t_on_s": 1.0, "t_off_s": 1.0}),
            "t_off_s",
        ),
        (
            serde_json::json!({"kind": "piecewise_linear", "points": [
            {"time_s": 1.0, "value": 0.0}, {"time_s": 0.0, "value": 1.0}]}),
            "strictly increasing",
        ),
        (
            serde_json::json!({"kind": "sinc", "amplitude": 1.0,
            "center_s": 0.0, "bandwidth_hz": 0.0, "offset": 0.0}),
            "bandwidth_hz",
        ),
        (
            serde_json::json!({"kind": "tabulated", "artifact_ref": "",
            "interpolation": "linear", "extrapolation": "error"}),
            "artifact_ref",
        ),
        (
            serde_json::json!({"kind": "tabulated", "artifact_ref": "artifact://drive.csv",
            "interpolation": "linear", "extrapolation": "error", "bandwidth_hz": 0.0}),
            "bandwidth_hz",
        ),
    ];

    for (envelope, expected) in invalid {
        let mut value = problem_ir_value_with_version("0.3.0");
        value["spin_torque_modules"] = serde_json::json!([{
            "kind": "prescribed_sot", "schema_version": "prescribed_sot.v1", "id": "sot",
            "target": {"object_id": "strip"}, "formula_version": "prescribed_sot.fullmag.v1",
            "drive": {"kind": "signed_scalar", "current_density_Apm2": 1.0,
                      "sigma_hat": [0.0, 2.0, 0.0], "envelope": envelope},
            "xi_dl": 0.1, "xi_fl": 0.0, "free_layer_thickness_m": 1.0e-9
        }]);
        let decoded: ProblemIR =
            serde_json::from_value(value).expect("invalid value shape should decode");
        let errors = decoded
            .validate()
            .expect_err("invalid envelope must fail validation");
        assert!(
            errors.iter().any(|error| error.contains(expected)),
            "missing {expected}: {errors:?}"
        );
    }

    for envelope in [
        serde_json::json!({"kind": "tabulated", "artifact_ref": "a",
            "interpolation": "cubic", "extrapolation": "error"}),
        serde_json::json!({"kind": "tabulated", "artifact_ref": "a",
            "interpolation": "linear", "extrapolation": "periodic"}),
        serde_json::json!({"kind": "constant", "value": 1.0,
            "unknown_backend_field": true}),
    ] {
        let mut value = problem_ir_value_with_version("0.3.0");
        value["spin_torque_modules"] = serde_json::json!([{
            "kind": "prescribed_sot", "schema_version": "prescribed_sot.v1", "id": "sot",
            "target": {"object_id": "strip"}, "formula_version": "prescribed_sot.fullmag.v1",
            "drive": {"kind": "signed_scalar", "current_density_Apm2": 1.0,
                      "sigma_hat": [0.0, 2.0, 0.0], "envelope": envelope},
            "xi_dl": 0.1, "xi_fl": 0.0, "free_layer_thickness_m": 1.0e-9
        }]);
        assert!(serde_json::from_value::<ProblemIR>(value).is_err());
    }
}

#[test]
fn canonical_0_3_rejects_deprecated_spin_orbit_torque_wire_kind() {
    let mut value = problem_ir_value_with_version("0.3.0");
    value["spin_torque_modules"] = serde_json::json!([{
        "kind": "spin_orbit_torque",
        "charge_current_density_a_per_m2": 1.0,
        "damping_like_efficiency": 0.1,
        "field_like_efficiency": 0.0,
        "spin_polarization": [0.0, 1.0, 0.0],
        "ferromagnet_thickness_m": 1.0e-9
    }]);
    assert!(serde_json::from_value::<ProblemIR>(value).is_err());

    let legacy = SpinTorqueModuleIR::SpinOrbitTorque {
        charge_current_density_a_per_m2: Some(1.0),
        current_source: None,
        damping_like_efficiency: 0.1,
        field_like_efficiency: 0.0,
        spin_polarization: [0.0, 1.0, 0.0],
        ferromagnet_thickness_m: 1.0e-9,
    };
    assert!(serde_json::to_value(legacy).is_err());
}

#[test]
fn canonical_prescribed_sot_v1_rejects_invalid_axes_and_nonfinite_signed_input() {
    let mut zero_sigma = problem_ir_value_with_version("0.3.0");
    zero_sigma["spin_torque_modules"] = serde_json::json!([{
        "kind": "prescribed_sot", "schema_version": "prescribed_sot.v1", "id": "sot",
        "target": {"object_id": "strip"},
        "formula_version": "prescribed_sot.fullmag.v1",
        "drive": {"kind": "signed_scalar", "current_density_Apm2": 1.0,
                  "sigma_hat": [0.0, 0.0, 0.0]},
        "xi_dl": 0.1, "xi_fl": 0.0, "free_layer_thickness_m": 1.0e-9
    }]);
    let decoded: ProblemIR = serde_json::from_value(zero_sigma).expect("shape should decode");
    let errors = decoded
        .validate()
        .expect_err("zero v1 sigma must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("sigma_hat") && error.contains("epsilon_axis")));

    let mut parallel_axes = problem_ir_value_with_version("0.3.0");
    parallel_axes["spin_torque_modules"] = serde_json::json!([{
        "kind": "prescribed_sot", "schema_version": "prescribed_sot.v1", "id": "sot",
        "target": {"object_id": "strip"},
        "formula_version": "prescribed_sot.fullmag.v1",
        "drive": {"kind": "vector_current_source", "current_source_id": "charge",
                  "drive_direction": [1.0, 0.0, 0.0], "interface_normal": [1.0, 0.0, 0.0]},
        "xi_dl": 0.1, "xi_fl": 0.0, "free_layer_thickness_m": 1.0e-9
    }]);
    let decoded: ProblemIR = serde_json::from_value(parallel_axes).expect("shape should decode");
    let errors = decoded
        .validate()
        .expect_err("parallel v1 axes must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("interface_normal") && error.contains("parallel")));

    let mut nonfinite = ProblemIR::bootstrap_example();
    nonfinite.spin_torque_modules = vec![SpinTorqueModuleIR::PrescribedSot {
        schema_version: "prescribed_sot.v1".to_string(),
        id: "sot".to_string(),
        target: Some(RegionRefIR {
            object_id: "strip".to_string(),
            region_id: None,
        }),
        formula: PrescribedSotFormulaIR::FullmagV1 {
            drive: PrescribedSotV1DriveIR::SignedScalar {
                current_density_apm2: f64::NAN,
                sigma_hat: [0.0, 1.0, 0.0],
                envelope: None,
            },
            xi_dl: 0.1,
            xi_fl: 0.0,
            free_layer_thickness_m: 1.0e-9,
        },
    }];
    let errors = nonfinite
        .validate()
        .expect_err("nonfinite signed v1 current must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("current_density_Apm2") && error.contains("finite")));

    let mut near_zero = ProblemIR::bootstrap_example();
    near_zero.spin_torque_modules = vec![SpinTorqueModuleIR::PrescribedSot {
        schema_version: "prescribed_sot.v1".to_string(),
        id: "sot".to_string(),
        target: Some(RegionRefIR {
            object_id: "strip".to_string(),
            region_id: None,
        }),
        formula: PrescribedSotFormulaIR::FullmagV1 {
            drive: PrescribedSotV1DriveIR::SignedScalar {
                current_density_apm2: 1.0,
                sigma_hat: [1.0e-13, 0.0, 0.0],
                envelope: None,
            },
            xi_dl: 0.1,
            xi_fl: 0.0,
            free_layer_thickness_m: 1.0e-9,
        },
    }];
    let errors = near_zero
        .validate()
        .expect_err("near-zero v1 axis must fail epsilon_axis validation");
    assert!(errors.iter().any(|error| error.contains("epsilon_axis")));
}

#[test]
fn prescribed_sot_v1_rejects_invalid_signed_scalar_envelope() {
    let mut value = problem_ir_value_with_version("0.3.0");
    value["spin_torque_modules"] = serde_json::json!([{
        "kind": "prescribed_sot", "schema_version": "prescribed_sot.v1", "id": "sot",
        "target": {"object_id": "strip"}, "formula_version": "prescribed_sot.fullmag.v1",
        "drive": {"kind": "signed_scalar", "current_density_Apm2": 1.0,
                  "sigma_hat": [0.0, 2.0, 0.0],
                  "envelope": {"kind": "piecewise_linear", "points": [
                      {"time_s": 1.0, "value": 0.0}, {"time_s": 0.0, "value": 1.0}]}},
        "xi_dl": 0.1, "xi_fl": 0.0, "free_layer_thickness_m": 1.0e-9
    }]);
    let decoded: ProblemIR = serde_json::from_value(value).expect("envelope shape should decode");
    let errors = decoded
        .validate()
        .expect_err("non-monotone envelope must fail");
    assert!(errors
        .iter()
        .any(|error| error.contains("envelope") && error.contains("strictly increasing")));
}

#[test]
fn prescribed_sot_time_envelope_rejects_nonfinite_numbers_in_every_variant() {
    let envelopes = vec![
        TimeEnvelopeIR::Constant { value: f64::NAN },
        TimeEnvelopeIR::Sinusoidal {
            amplitude: f64::NAN,
            frequency_hz: 0.0,
            phase_rad: 0.0,
            offset: 0.0,
        },
        TimeEnvelopeIR::Pulse {
            amplitude: 1.0,
            t_on_s: f64::NAN,
            t_off_s: 1.0,
        },
        TimeEnvelopeIR::PiecewiseLinear {
            points: vec![TimeEnvelopePointIR {
                time_s: 0.0,
                value: f64::NAN,
            }],
        },
        TimeEnvelopeIR::Sinc {
            amplitude: 1.0,
            center_s: f64::NAN,
            bandwidth_hz: 1.0,
            offset: 0.0,
        },
        TimeEnvelopeIR::Tabulated {
            artifact_ref: "artifact://drive.csv".to_string(),
            interpolation: TimeEnvelopeInterpolationIR::Linear,
            extrapolation: TimeEnvelopeExtrapolationIR::Error,
            bandwidth_hz: Some(f64::NAN),
        },
    ];

    for envelope in envelopes {
        let mut problem = ProblemIR::bootstrap_example();
        problem.spin_torque_modules = vec![SpinTorqueModuleIR::PrescribedSot {
            schema_version: "prescribed_sot.v1".to_string(),
            id: "sot".to_string(),
            target: Some(RegionRefIR {
                object_id: "strip".to_string(),
                region_id: None,
            }),
            formula: PrescribedSotFormulaIR::FullmagV1 {
                drive: PrescribedSotV1DriveIR::SignedScalar {
                    current_density_apm2: 1.0,
                    sigma_hat: [0.0, 2.0, 0.0],
                    envelope: Some(envelope),
                },
                xi_dl: 0.1,
                xi_fl: 0.0,
                free_layer_thickness_m: 1.0e-9,
            },
        }];
        let errors = problem
            .validate()
            .expect_err("nonfinite envelope value must fail validation");
        assert!(
            errors.iter().any(|error| error.contains("finite")),
            "{errors:?}"
        );
    }
}

#[test]
fn prescribed_sot_v1_accepts_nonunit_vector_source_axes_and_rejects_near_parallel_axes() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.current_modules = vec![CurrentModuleIR::CurrentTransport {
        name: "charge".to_string(),
        model: CurrentTransportModelIR::PrescribedDensity,
        current_density: Some([1.0, 0.0, 0.0]),
        solve_region: None,
        conductivity_s_per_m: None,
        coupling: TransportCouplingIR::OneWay,
        definition: None,
    }];
    let module = |drive_direction, interface_normal| SpinTorqueModuleIR::PrescribedSot {
        schema_version: "prescribed_sot.v1".to_string(),
        id: "sot".to_string(),
        target: Some(RegionRefIR {
            object_id: "strip".to_string(),
            region_id: None,
        }),
        formula: PrescribedSotFormulaIR::FullmagV1 {
            drive: PrescribedSotV1DriveIR::VectorCurrentSource {
                current_source_id: "charge".to_string(),
                drive_direction,
                interface_normal,
            },
            xi_dl: 0.1,
            xi_fl: 0.0,
            free_layer_thickness_m: 1.0e-9,
        },
    };

    problem.spin_torque_modules = vec![module([2.0, 0.0, 0.0], [0.0, 3.0, 0.0])];
    assert!(problem.validate().is_ok());

    problem.spin_torque_modules = vec![module([2.0, 0.0, 0.0], [4.0, 1.0e-13, 0.0])];
    let errors = problem
        .validate()
        .expect_err("near-parallel normalized axes must fail epsilon_axis validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("parallel") && error.contains("epsilon_axis")));
}

#[test]
fn prescribed_sot_legacy_v0_rejects_missing_or_forged_migration_origin() {
    let mut value = problem_ir_value_with_version("0.3.0");
    value["spin_torque_modules"] = serde_json::json!([{
        "kind": "prescribed_sot", "schema_version": "prescribed_sot.v1", "id": "legacy",
        "formula_version": "prescribed_sot.legacy_fullmag.v0",
        "drive": {"kind": "legacy_scalar_magnitude", "raw_charge_current_density_Apm2": -1.0},
        "raw_spin_polarization": [0.0, 0.0, 0.0],
        "xi_dl": 0.1, "xi_fl": 0.0, "free_layer_thickness_m": 1.0e-9
    }]);
    assert!(serde_json::from_value::<ProblemIR>(value.clone()).is_err());

    value["spin_torque_modules"][0]["compatibility_origin"] = serde_json::json!({
        "source_ir_version": "0.3.0", "authored_kind": "prescribed_sot"
    });
    let decoded: ProblemIR =
        serde_json::from_value(value).expect("shape with origin should decode");
    let errors = decoded
        .validate()
        .expect_err("forged legacy origin must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("compatibility_origin")));
}

#[test]
fn migrated_legacy_current_source_must_resolve_to_current_transport() {
    let mut value = problem_ir_value_with_version("0.2.0");
    value["spin_torque_modules"] = serde_json::json!([{
        "kind": "spin_orbit_torque", "current_source": "missing_charge",
        "damping_like_efficiency": 0.1, "field_like_efficiency": 0.0,
        "spin_polarization": [0.0, 1.0, 0.0], "ferromagnet_thickness_m": 1.0e-9
    }]);
    let decoded: ProblemIR = serde_json::from_value(value).expect("legacy source should migrate");
    let errors = decoded
        .validate()
        .expect_err("missing migrated source must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("current_source_id") && error.contains("current_transport")));
}

#[test]
fn prescribed_sot_rejects_duplicate_module_ids_and_unsupported_ir_version() {
    let module = serde_json::json!({
        "kind": "prescribed_sot", "schema_version": "prescribed_sot.v1", "id": "duplicate",
        "target": {"object_id": "strip"}, "formula_version": "prescribed_sot.fullmag.v1",
        "drive": {"kind": "signed_scalar", "current_density_Apm2": 1.0,
                  "sigma_hat": [0.0, 1.0, 0.0]},
        "xi_dl": 0.1, "xi_fl": 0.0, "free_layer_thickness_m": 1.0e-9
    });
    let mut value = problem_ir_value_with_version("0.3.0");
    value["spin_torque_modules"] = serde_json::json!([module.clone(), module]);
    let decoded: ProblemIR = serde_json::from_value(value).expect("duplicate ids should decode");
    let errors = decoded
        .validate()
        .expect_err("duplicate ids must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("duplicate") && error.contains("id")));

    let unsupported = problem_ir_value_with_version("9.9.9");
    let error = serde_json::from_value::<ProblemIR>(unsupported)
        .expect_err("unsupported IR version must fail closed");
    assert!(error.to_string().contains("not supported"));
}

#[test]
fn prescribed_sot_rejects_unknown_formula_fields() {
    let mut value = problem_ir_value_with_version("0.3.0");
    value["spin_torque_modules"] = serde_json::json!([{
        "kind": "prescribed_sot", "schema_version": "prescribed_sot.v1", "id": "sot",
        "target": {"object_id": "strip"}, "formula_version": "prescribed_sot.fullmag.v1",
        "drive": {"kind": "signed_scalar", "current_density_Apm2": 1.0,
                  "sigma_hat": [0.0, 1.0, 0.0]},
        "xi_dl": 0.1, "xi_fl": 0.0, "free_layer_thickness_m": 1.0e-9,
        "backend_default": "must_not_be_ignored"
    }]);

    let error = serde_json::from_value::<ProblemIR>(value)
        .expect_err("unknown prescribed-SOT formula fields must fail closed");
    assert!(error.to_string().contains("unknown field"));
}

#[test]
fn current_v0_3_adaptive_payload_without_tolerance_mode_fails_deserialization() {
    let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
    value["study"]["dynamics"]["integrator"] = serde_json::json!("rk45");
    value["study"]["dynamics"]["fixed_timestep"] = serde_json::Value::Null;
    value["study"]["dynamics"]["adaptive_timestep"] = serde_json::json!({
        "atol":1e-6,"rtol":0.0,"dt_min":1e-16,"dt_max":1e-14,
        "safety":0.9,"growth_limit":2.0,"shrink_limit":0.2
    });
    let error = serde_json::from_value::<ProblemIR>(value)
        .expect_err("current IR must require explicit mode");
    assert!(error.to_string().contains("tolerance_mode"));
}

#[test]
fn v0_2_adaptive_payload_migrates_mode_shape_aware() {
    let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
    value["ir_version"] = serde_json::json!(PREVIOUS_PUBLIC_IR_VERSION);
    value["problem_meta"]["script_api_version"] = serde_json::json!(PREVIOUS_PUBLIC_IR_VERSION);
    value["problem_meta"]["serializer_version"] = serde_json::json!(PREVIOUS_PUBLIC_IR_VERSION);
    value["study"]["dynamics"]["integrator"] = serde_json::json!("rk45");
    value["study"]["dynamics"]["fixed_timestep"] = serde_json::Value::Null;
    value["study"]["dynamics"]["adaptive_timestep"] = serde_json::json!({
        "atol":1e-6,"rtol":0.0,"dt_min":1e-16,"dt_max":1e-14,
        "safety":0.9,"growth_limit":2.0,"shrink_limit":0.2
    });
    value["problem_meta"]["runtime_metadata"]["adaptive_timestep"] =
        serde_json::json!({"opaque":true});
    let decoded: ProblemIR = serde_json::from_value(value).unwrap();
    let encoded = serde_json::to_value(decoded).unwrap();
    assert_eq!(
        encoded["study"]["dynamics"]["adaptive_timestep"]["tolerance_mode"],
        "advanced"
    );
    assert!(
        encoded["problem_meta"]["runtime_metadata"]["adaptive_timestep"]
            .get("tolerance_mode")
            .is_none()
    );
}

#[test]
fn migration_rejects_mixed_supported_versions() {
    let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
    value["ir_version"] = serde_json::json!(PREVIOUS_PUBLIC_IR_VERSION);
    value["problem_meta"]["script_api_version"] = serde_json::json!(LEGACY_PUBLIC_IR_VERSION);
    let error = serde_json::from_value::<ProblemIR>(value).expect_err("mixed versions must fail");
    assert!(error.to_string().contains("conflicts"));
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
fn historical_0_1_cylinder_without_axis_migrates_through_explicit_chain() {
    let mut value = serde_json::to_value(ProblemIR::bootstrap_example())
        .expect("bootstrap ProblemIR should serialize");
    value["ir_version"] = serde_json::json!("0.1.0");
    value["problem_meta"]["script_api_version"] = serde_json::json!("0.1.0");
    value["problem_meta"]["serializer_version"] = serde_json::json!("0.1.0");
    value["geometry"]["entries"] = serde_json::json!([{
        "kind": "cylinder",
        "name": "legacy",
        "radius": 1.0,
        "height": 2.0
    }]);

    migrate_problem_ir_json_value(&mut value).expect("explicit chain should migrate 0.1.0");
    let decoded: ProblemIR =
        serde_json::from_value(value).expect("migrated cylinder should deserialize");
    match &decoded.geometry.entries[0] {
        GeometryEntryIR::Cylinder { axis, .. } => assert_eq!(*axis, [0.0, 0.0, 1.0]),
        other => panic!("expected migrated cylinder, got {other:?}"),
    }
}

#[test]
fn legacy_migration_adds_axes_to_nested_geometry_and_region_csg() {
    let mut value = serde_json::json!({
        "ir_version": "0.1.0",
        "geometry": {"entries": [{
            "kind": "translate", "name": "translated", "by": [0.0, 0.0, 0.0],
            "base": {"kind": "difference", "name": "difference",
                "base": {"kind": "cylinder", "name": "base", "radius": 1.0, "height": 2.0},
                "tool": {"kind": "cylinder", "name": "tool", "radius": 0.5, "height": 1.0}}
        }]},
        "object_regions": [{"shape": {"kind": "csg", "expression":
            {"kind": "cylinder", "name": "region", "radius": 1.0, "height": 2.0}}}]
    });

    migrate_problem_ir_json_value(&mut value).expect("legacy payload should migrate");
    assert_eq!(
        value["geometry"]["entries"][0]["base"]["base"]["axis"],
        serde_json::json!([0.0, 0.0, 1.0])
    );
    assert_eq!(
        value["geometry"]["entries"][0]["base"]["tool"]["axis"],
        serde_json::json!([0.0, 0.0, 1.0])
    );
    assert_eq!(
        value["object_regions"][0]["shape"]["expression"]["axis"],
        serde_json::json!([0.0, 0.0, 1.0])
    );
}

#[test]
fn previous_public_ir_golden_fixture_migrates_to_current() {
    let fixture = include_str!("../../../tests/golden/problem_ir/bootstrap_v0_1_read_compat.json");
    let mut value: serde_json::Value =
        serde_json::from_str(fixture).expect("golden v0.1.0 fixture should parse");
    migrate_problem_ir_json_value(&mut value).expect("golden fixture should explicitly migrate");
    let decoded: ProblemIR = serde_json::from_value(value)
        .expect("explicitly migrated golden v0.1.0 fixture should deserialize");

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
fn fdm_demag_hints_reject_removed_single_grid_fallback_switch() {
    let legacy = serde_json::json!({
        "strategy": "auto",
        "mode": "auto",
        "allow_single_grid_fallback": true,
    });

    let error = serde_json::from_value::<FdmDemagHintsIR>(legacy)
        .expect_err("removed FDM demag fallback must not deserialize as a no-op");
    assert!(error.to_string().contains("allow_single_grid_fallback"));
}

#[test]
fn material_only_anisotropy_round_trips_and_validates() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.energy_terms.clear();
    problem.materials[0].uniaxial_anisotropy = Some(0.5e6);
    problem.materials[0].anisotropy_axis = Some([0.0, 0.0, 1.0]);

    let encoded = serde_json::to_value(&problem).expect("serialize material anisotropy");
    let decoded: ProblemIR =
        serde_json::from_value(encoded).expect("deserialize material anisotropy");
    assert!(decoded.validate().is_ok());
}

#[test]
fn regional_field_drive_exact_wire_round_trips() {
    let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
    value["field_drives"] = serde_json::json!([{
        "id": "drive-pulse",
        "name": "Gamma sinc pulse",
        "kind": "regional",
        "enabled": true,
        "target": {"kind": "global"},
        "amplitude_B_T": 0.001,
        "direction": [0.0, 1.0, 0.0],
        "spatial_profile": {"kind": "geometry_mask", "object_id": "strip", "envelope": {
            "kind": "sinc", "axis": [1.0, 0.0, 0.0], "period_m": 2.0e-7,
            "center_m": 0.0, "width_m": 4.0e-7, "window": "hann"
        }},
        "waveform": {"kind": "sinc_pulse", "cutoff_hz": 2.0e10, "t0": 1.0e-10, "amplitude": 1.0},
        "time_origin": "stage_local",
        "activation": {"kind": "stage_ids", "stage_ids": ["excite_gamma"]}
    }]);

    let decoded: ProblemIR = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(decoded.field_drives.len(), 1);
    assert_eq!(decoded.field_drives[0].id, "drive-pulse");
    let encoded = serde_json::to_value(decoded).unwrap();
    assert_eq!(encoded["field_drives"], value["field_drives"]);
}

#[test]
fn regional_field_drive_unknown_fields_are_rejected() {
    let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
    value["field_drives"] = serde_json::json!([{
        "id": "drive", "name": "Drive", "kind": "regional", "enabled": true,
        "target": {"kind": "global", "unexpected": 1},
        "amplitude_B_T": 0.001, "direction": [0.0, 1.0, 0.0],
        "spatial_profile": {"kind": "uniform"},
        "waveform": {"kind": "constant"}, "time_origin": "stage_local",
        "activation": {"kind": "all_time_evolution"}
    }]);
    assert!(serde_json::from_value::<ProblemIR>(value).is_err());
}

#[test]
fn regional_field_drive_validation_is_fail_closed() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.field_drives.push(RegionalFieldDriveIR {
        id: "bad".into(),
        name: "Bad".into(),
        kind: FieldDriveKindIR::Regional,
        enabled: true,
        target: FieldTargetIR::Object {
            object_id: "missing".into(),
        },
        amplitude_b_t: -1.0,
        direction: [0.0, 0.0, 0.0],
        spatial_profile: FieldSpatialProfileIR::Uniform {},
        waveform: TimeDependenceIR::SincPulse {
            cutoff_hz: 0.0,
            t0: -1.0,
            amplitude: 1.0,
        },
        time_origin: FieldTimeOriginIR::StageLocal,
        activation: DriveActivationIR::StageIds {
            stage_ids: vec!["missing-stage".into()],
        },
        migration: None,
    });
    let errors = ir.validate().expect_err("invalid regional drive must fail");
    for needle in [
        "amplitude_B_T",
        "direction",
        "target object",
        "cutoff_hz",
        "t0",
    ] {
        assert!(
            errors.iter().any(|error| error.contains(needle)),
            "missing {needle}: {errors:?}"
        );
    }
}

#[test]
fn regional_field_drive_rejects_non_finite_waveform_frequencies() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.field_drives.push(RegionalFieldDriveIR {
        id: "bad-waveform".into(),
        name: "Bad waveform".into(),
        kind: FieldDriveKindIR::Regional,
        enabled: true,
        target: FieldTargetIR::Global {},
        amplitude_b_t: 1e-3,
        direction: [0.0, 1.0, 0.0],
        spatial_profile: FieldSpatialProfileIR::Uniform {},
        waveform: TimeDependenceIR::Sinusoidal {
            frequency_hz: f64::NAN,
            phase_rad: 0.0,
            offset: 0.0,
        },
        time_origin: FieldTimeOriginIR::StageLocal,
        activation: DriveActivationIR::AllTimeEvolution {},
        migration: None,
    });

    let errors = ir
        .validate()
        .expect_err("non-finite sinusoidal frequency must fail validation");
    assert!(errors.iter().any(|error| error.contains("frequency_hz")));

    ir.field_drives[0].waveform = TimeDependenceIR::SincPulse {
        cutoff_hz: f64::NAN,
        t0: 0.0,
        amplitude: 1.0,
    };
    let errors = ir
        .validate()
        .expect_err("non-finite sinc cutoff must fail validation");
    assert!(errors.iter().any(|error| error.contains("cutoff_hz")));
}

#[test]
fn active_stage_id_controls_minimizer_drive_validation() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.problem_meta.runtime_metadata.insert(
        "study_pipeline".into(),
        serde_json::json!({"version":"study_pipeline.v1","nodes":[
            {"id":"relax","enabled":true}, {"id":"excite","enabled":true}
        ]}),
    );
    ir.problem_meta
        .runtime_metadata
        .insert("active_stage_id".into(), serde_json::json!("relax"));
    let sampling = ir.study.sampling().clone();
    ir.study = StudyIR::Relaxation {
        algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
        dynamics: None,
        stop: RelaxStopIR {
            torque_tolerance_apm: None,
            energy_tolerance_j: None,
            max_steps: Some(2),
            max_relaxation_time_s: None,
        },
        sampling,
    };
    ir.field_drives.push(RegionalFieldDriveIR {
        id: "excite-only".into(),
        name: "Excite only".into(),
        kind: FieldDriveKindIR::Regional,
        enabled: true,
        target: FieldTargetIR::Global {},
        amplitude_b_t: 1e-3,
        direction: [0.0, 1.0, 0.0],
        spatial_profile: FieldSpatialProfileIR::Uniform {},
        waveform: TimeDependenceIR::SincPulse {
            cutoff_hz: 20e9,
            t0: 50e-12,
            amplitude: 1.0,
        },
        time_origin: FieldTimeOriginIR::StageLocal,
        activation: DriveActivationIR::StageIds {
            stage_ids: vec!["excite".into()],
        },
        migration: None,
    });
    ir.validate()
        .expect("inactive dynamic drive must not invalidate relaxation stage");
    ir.problem_meta
        .runtime_metadata
        .insert("active_stage_id".into(), serde_json::json!("missing"));
    let errors = ir
        .validate()
        .expect_err("unknown active stage must fail closed");
    assert!(errors
        .iter()
        .any(|error| error.contains("active_stage_id") && error.contains("missing")));
}

#[test]
fn all_time_evolution_drive_is_inactive_during_relaxation() {
    let mut ir = ProblemIR::bootstrap_example();
    let sampling = ir.study.sampling().clone();
    ir.study = StudyIR::Relaxation {
        algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
        dynamics: None,
        stop: RelaxStopIR {
            torque_tolerance_apm: None,
            energy_tolerance_j: None,
            max_steps: Some(2),
            max_relaxation_time_s: None,
        },
        sampling,
    };
    ir.field_drives.push(RegionalFieldDriveIR {
        id: "time-evolution-only".into(),
        name: "Time evolution only".into(),
        kind: FieldDriveKindIR::Regional,
        enabled: true,
        target: FieldTargetIR::Global {},
        amplitude_b_t: 1e-3,
        direction: [0.0, 1.0, 0.0],
        spatial_profile: FieldSpatialProfileIR::Uniform {},
        waveform: TimeDependenceIR::SincPulse {
            cutoff_hz: 20e9,
            t0: 50e-12,
            amplitude: 1.0,
        },
        time_origin: FieldTimeOriginIR::StageLocal,
        activation: DriveActivationIR::AllTimeEvolution {},
        migration: None,
    });

    ir.validate()
        .expect("all_time_evolution drive must be inactive during relaxation");
}

#[test]
fn spin_wave_analysis_request_is_validated_against_source_locality() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.field_drives.push(RegionalFieldDriveIR {
        id: "gamma".into(),
        name: "Gamma".into(),
        kind: FieldDriveKindIR::Regional,
        enabled: true,
        target: FieldTargetIR::Global {},
        amplitude_b_t: 1e-3,
        direction: [0.0, 1.0, 0.0],
        spatial_profile: FieldSpatialProfileIR::Uniform {},
        waveform: TimeDependenceIR::SincPulse {
            cutoff_hz: 20e9,
            t0: 50e-12,
            amplitude: 1.0,
        },
        time_origin: FieldTimeOriginIR::StageLocal,
        activation: DriveActivationIR::AllTimeEvolution {},
        migration: None,
    });
    ir.problem_meta.runtime_metadata.insert("spin_wave_response".into(), serde_json::json!({
        "schema_version":"spin_wave_response.request.v1", "analysis":"gamma", "response_component":"my"
    }));
    ir.validate()
        .expect("global uniform source is valid for gamma analysis");
    ir.problem_meta.runtime_metadata.insert("spin_wave_response".into(), serde_json::json!({
        "schema_version":"spin_wave_response.request.v1", "analysis":"finite_k", "response_component":"my", "probe_count":2
    }));
    let errors = ir
        .validate()
        .expect_err("finite-k must reject global source and too few probes");
    assert!(errors.iter().any(|error| error.contains("probe_count")));
    assert!(errors.iter().any(|error| error.contains("localized")));
}

#[test]
fn direct_minimizer_rejects_dynamics_and_relaxation_time() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::Relaxation {
        algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
        dynamics: Some(ir.study.dynamics().clone()),
        stop: RelaxStopIR {
            torque_tolerance_apm: Some(1e-4),
            energy_tolerance_j: None,
            max_steps: Some(50_000),
            max_relaxation_time_s: Some(1e-9),
        },
        sampling: ir.study.sampling().clone(),
    };

    let errors = ir
        .validate()
        .expect_err("direct minimizers reject LLG dynamics and seconds-valued time budgets");
    assert!(errors
        .iter()
        .any(|error| error.contains("direct minimizer") && error.contains("dynamics=None")));
    assert!(errors.iter().any(|error| {
        error.contains("direct minimizer") && error.contains("max_relaxation_time_s")
    }));
}

#[test]
fn llg_relaxation_requires_dynamics() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = StudyIR::Relaxation {
        algorithm: RelaxationAlgorithmIR::LlgOverdamped,
        dynamics: None,
        stop: RelaxStopIR {
            torque_tolerance_apm: Some(1e-4),
            energy_tolerance_j: None,
            max_steps: Some(50_000),
            max_relaxation_time_s: None,
        },
        sampling: ir.study.sampling().clone(),
    };

    let errors = ir
        .validate()
        .expect_err("LLG relaxation requires explicit LLG dynamics");
    assert!(errors
        .iter()
        .any(|error| { error.contains("llg_overdamped") && error.contains("requires dynamics") }));
}

#[test]
fn legacy_relaxation_time_alias_deserializes_canonically() {
    let stop: RelaxStopIR = serde_json::from_value(serde_json::json!({
        "torque_tolerance_apm": 1e-4,
        "max_steps": 50_000,
        "max_physical_time_s": 1e-9
    }))
    .expect("legacy relaxation time alias should deserialize");
    assert_eq!(stop.max_relaxation_time_s, Some(1e-9));

    let serialized = serde_json::to_value(stop).expect("canonical stop should serialize");
    assert_eq!(serialized["max_relaxation_time_s"], serde_json::json!(1e-9));
    assert!(serialized.get("max_physical_time_s").is_none());
    assert!(serialized.get("max_pseudotime_s").is_none());
}

#[test]
fn conflicting_relaxation_time_aliases_are_rejected() {
    let error = serde_json::from_value::<RelaxStopIR>(serde_json::json!({
        "max_relaxation_time_s": 1e-9,
        "max_physical_time_s": 2e-9
    }))
    .expect_err("canonical and legacy relaxation times must not conflict");
    assert!(error.to_string().contains("conflicts"));
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
            stage_autosave: None,
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
            stage_autosave: None,
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
            stage_autosave: None,
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
            stage_autosave: None,
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
            stage_autosave: None,
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
            stage_autosave: None,
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
            stage_autosave: None,
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
            stage_autosave: None,
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
            stage_autosave: None,
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
            stage_autosave: None,
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
            stage_autosave: None,
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
            stage_autosave: None,
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
            stage_autosave: None,
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
            stage_autosave: None,
        },
    };

    let errors = ir
        .validate()
        .expect_err("direct minimizer settle steps must reject physical time");
    assert!(errors.iter().any(|error| {
        error.contains("settle_pipeline.steps[0].max_physical_time_s")
            && error.contains("projected_gradient_bb")
            && error.contains("direct minimizer")
            && error.contains("max_steps")
    }));

    let StudyIR::Hysteresis {
        settle_pipeline: Some(SettlePipelineIR::Sequence { steps }),
        ..
    } = &mut ir.study
    else {
        panic!("expected hysteresis settle pipeline");
    };
    let SettleStepIR::Minimize {
        max_pseudotime_s,
        max_physical_time_s,
        ..
    } = &mut steps[0]
    else {
        panic!("expected minimize settle step");
    };
    *max_pseudotime_s = Some(1e-9);
    *max_physical_time_s = None;
    let errors = ir
        .validate()
        .expect_err("direct minimizer settle steps must reject legacy pseudotime");
    assert!(errors.iter().any(|error| {
        error.contains("settle_pipeline.steps[0].max_pseudotime_s")
            && error.contains("projected_gradient_bb")
            && error.contains("direct minimizer")
    }));

    let StudyIR::Hysteresis {
        settle_pipeline: Some(SettlePipelineIR::Sequence { steps }),
        ..
    } = &mut ir.study
    else {
        unreachable!();
    };
    let SettleStepIR::Minimize {
        max_pseudotime_s,
        max_physical_time_s,
        ..
    } = &mut steps[0]
    else {
        unreachable!();
    };
    *max_pseudotime_s = Some(1e-9);
    *max_physical_time_s = Some(2e-9);
    let errors = ir
        .validate()
        .expect_err("conflicting legacy settle time aliases must reject deterministically");
    assert!(errors.iter().any(|error| {
        error.contains("max_pseudotime_s")
            && error.contains("max_physical_time_s")
            && error.contains("conflict")
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
            stage_autosave: None,
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
            stage_autosave: None,
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
            stage_autosave: None,
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
            stage_autosave: None,
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
            stage_autosave: None,
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
            stage_autosave: None,
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
fn material_uniaxial_anisotropy_accepts_signed_constants_and_rejects_nan() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.materials[0].uniaxial_anisotropy = Some(-0.5e6);
    ir.materials[0].uniaxial_anisotropy_k2 = Some(-0.1e6);
    assert!(ir.validate().is_ok());

    ir.materials[0].uniaxial_anisotropy = Some(f64::NAN);
    let errors = ir
        .validate()
        .expect_err("non-finite uniaxial anisotropy must fail validation");
    assert!(errors.iter().any(|error| {
        error.contains("materials[0].uniaxial_anisotropy") && error.contains("value must be finite")
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

fn valid_adaptive_problem() -> ProblemIR {
    let mut ir = ProblemIR::bootstrap_example();
    let sampling = ir.study.sampling().clone();
    ir.study = StudyIR::TimeEvolution {
        dynamics: serde_json::from_value(serde_json::json!({
            "kind": "llg",
            "gyromagnetic_ratio": 2.211e5,
            "integrator": "rk45",
            "fixed_timestep": null,
            "adaptive_timestep": {
                "tolerance_mode": "max_error",
                "atol": 1e-6,
                "rtol": 0.0,
                "dt_initial": 1e-15,
                "dt_min": 1e-16,
                "dt_max": 1e-14,
                "safety": 0.9,
                "growth_limit": 2.0,
                "shrink_limit": 0.2
            }
        }))
        .unwrap(),
        sampling,
    };
    ir
}

#[test]
fn adaptive_policy_round_trips_explicit_mode() {
    let ir = valid_adaptive_problem();
    ir.validate().unwrap();
    assert_eq!(
        serde_json::to_value(ir).unwrap()["study"]["dynamics"]["adaptive_timestep"]
            ["tolerance_mode"],
        "max_error"
    );
}

#[test]
fn adaptive_validation_rejects_every_nonfinite_scalar() {
    for field in [
        "atol",
        "rtol",
        "dt_initial",
        "dt_min",
        "dt_max",
        "safety",
        "growth_limit",
        "shrink_limit",
        "max_spin_rotation",
        "norm_tolerance",
    ] {
        let mut ir = valid_adaptive_problem();
        let StudyIR::TimeEvolution { dynamics, .. } = &mut ir.study else {
            unreachable!()
        };
        let DynamicsIR::Llg {
            adaptive_timestep, ..
        } = dynamics;
        let adaptive = adaptive_timestep.as_mut().unwrap();
        match field {
            "atol" => adaptive.atol = f64::NAN,
            "rtol" => adaptive.rtol = f64::INFINITY,
            "dt_initial" => adaptive.dt_initial = Some(f64::NAN),
            "dt_min" => adaptive.dt_min = f64::NEG_INFINITY,
            "dt_max" => adaptive.dt_max = Some(f64::INFINITY),
            "safety" => adaptive.safety = f64::NAN,
            "growth_limit" => adaptive.growth_limit = f64::INFINITY,
            "shrink_limit" => adaptive.shrink_limit = f64::NEG_INFINITY,
            "max_spin_rotation" => adaptive.max_spin_rotation = Some(f64::NAN),
            "norm_tolerance" => adaptive.norm_tolerance = Some(f64::INFINITY),
            _ => unreachable!(),
        }
        let errors = ir.validate().expect_err("nonfinite must fail");
        assert!(
            errors.iter().any(|error| error.contains(field)),
            "{field}: {errors:?}"
        );
    }
}

#[test]
fn runtime_selection_validation_is_global() {
    for (selection, expected) in [
        (serde_json::json!("gpu"), "must be an object"),
        (serde_json::json!({"device": 1}), "device must be a string"),
        (serde_json::json!({"device": "quantum"}), "quantum"),
    ] {
        let mut ir = ProblemIR::bootstrap_example();
        ir.problem_meta
            .runtime_metadata
            .insert("runtime_selection".into(), selection);
        let errors = ir.validate().expect_err("invalid selection must fail");
        assert!(errors.iter().any(|error| error.contains(expected)));
    }
}

#[test]
fn runtime_selection_accepts_null_optional_integer_fields() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".into(),
        serde_json::json!({
            "device": "gpu",
            "gpu_count": 1,
            "device_index": null,
            "cpu_threads": null,
            "execution_precision": "double"
        }),
    );

    ir.validate()
        .expect("null optional runtime-selection integers mean unspecified");
}

#[test]
fn runtime_selection_rejects_unimplemented_multi_gpu_requests() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".into(),
        serde_json::json!({
            "device": "cuda",
            "gpu_count": 2,
            "execution_precision": "double"
        }),
    );

    let errors = ir
        .validate()
        .expect_err("multi-GPU must fail until an execution realization exists");
    assert!(errors.iter().any(|error| {
        error.contains("gpu_count=2") && error.contains("multi-GPU execution is not implemented")
    }));
}

#[test]
fn managed_runtime_device_override_has_a_separate_validated_identity() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.problem_meta.runtime_metadata.insert(
        "runtime_selection".into(),
        serde_json::json!({"device": "auto", "execution_precision": "double"}),
    );
    problem.problem_meta.runtime_metadata.insert(
        "runtime_device_override".into(),
        serde_json::json!({"device": "cpu", "source": "managed_launcher"}),
    );
    problem
        .validate()
        .expect("a typed managed launcher override must preserve valid authored intent");

    for invalid in [
        serde_json::json!({"device": "auto", "source": "managed_launcher"}),
        serde_json::json!({"device": "cpu", "source": "unknown"}),
        serde_json::json!("cpu"),
    ] {
        let mut rejected = problem.clone();
        rejected
            .problem_meta
            .runtime_metadata
            .insert("runtime_device_override".into(), invalid);
        let errors = rejected
            .validate()
            .expect_err("malformed launcher override must fail IR validation");
        assert!(
            errors
                .iter()
                .any(|error| error.contains("runtime_device_override")),
            "{errors:?}",
        );
    }
}

#[test]
fn coupled_imex_ark2_round_trips_as_canonical_llg_integrator() {
    let mut ir = ProblemIR::bootstrap_example();
    let StudyIR::TimeEvolution { dynamics, .. } = &mut ir.study else {
        panic!("bootstrap example must use time evolution")
    };
    let DynamicsIR::Llg { integrator, .. } = dynamics;
    *integrator = "coupled_imex_ark2".to_string();

    let encoded = serde_json::to_value(&ir).expect("ProblemIR serialization");
    assert_eq!(
        encoded["study"]["dynamics"]["integrator"],
        "coupled_imex_ark2"
    );
    let decoded: ProblemIR = serde_json::from_value(encoded).expect("ProblemIR round-trip");
    let StudyIR::TimeEvolution { dynamics, .. } = decoded.study else {
        panic!("round-trip must preserve time evolution")
    };
    let DynamicsIR::Llg { integrator, .. } = dynamics;
    assert_eq!(integrator, "coupled_imex_ark2");
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
        axis: [0.0, 0.0, 1.0],
    };

    let errors = ir
        .validate()
        .expect_err("negative cylinder radius must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("cylinder geometry 'strip' radius must be positive")));
}

#[test]
fn cylinder_axis_is_serialized_and_validated() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.geometry.entries[0] = GeometryEntryIR::Cylinder {
        name: "tilted".to_string(),
        radius: 5e-9,
        height: 10e-9,
        axis: [1.0, 1.0, 1.0],
    };
    let value = serde_json::to_value(&ir).expect("cylinder should serialize");
    assert_eq!(
        value["geometry"]["entries"][0]["axis"],
        serde_json::json!([1.0, 1.0, 1.0])
    );

    let mut invalid = ir.clone();
    if let GeometryEntryIR::Cylinder { axis, .. } = &mut invalid.geometry.entries[0] {
        *axis = [0.0, 0.0, 0.0];
    }
    let errors = invalid
        .validate()
        .expect_err("zero cylinder axis must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("cylinder geometry 'tilted' axis must be non-zero")));
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
            integrator: Some(IntegratorChoice::Heun),
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
            integrator_resolution: None,
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
            stage_autosave: None,
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
fn unsampled_time_evolution_is_valid_but_eigenmodes_require_outputs() {
    let mut time_ir = ProblemIR::bootstrap_example();
    time_ir.study.sampling_mut().outputs.clear();
    time_ir
        .validate()
        .expect("time evolution without periodic outputs must remain valid");

    let mut eigen_ir = ProblemIR::bootstrap_example();
    let dynamics = eigen_ir.study.dynamics().clone();
    eigen_ir.study = StudyIR::Eigenmodes {
        dynamics,
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 4,
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
            stage_autosave: None,
            outputs: vec![],
        },
        mode_tracking: None,
    };

    let errors = eigen_ir
        .validate()
        .expect_err("eigenmodes without outputs must fail validation");
    assert!(errors
        .iter()
        .any(|error| error.contains("spectral study requires at least one output")));
}

#[test]
fn eigenmodes_k0_kittel_validation_runtime_metadata_deserializes_to_typed_ir() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.problem_meta.runtime_metadata.insert(
        "k0_kittel_validation".to_string(),
        serde_json::json!({
            "kind": "k0_kittel_field_sweep",
            "model": "thin_film_in_plane",
            "field_units": "A_per_m",
            "relative_tolerance": 0.05,
            "material": {
                "effective_magnetisation": 800000.0
            },
            "samples": [
                {"sample_index": 0, "bias_field": [15915.494309189535, 0.0, 0.0]},
                {"sample_index": 1, "bias_field": [39788.73577297384, 0.0, 0.0]},
                {"sample_index": 2, "bias_field": [79577.47154594767, 0.0, 0.0]}
            ]
        }),
    );
    let dynamics = ir.study.dynamics().clone();
    ir.study = StudyIR::Eigenmodes {
        dynamics,
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::Full2x2,
            include_demag: true,
        },
        count: 1,
        target: EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0e6,
            frequency_max_hz: 5.0e9,
        },
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: Some(KSamplingIR::Path {
            points: vec![
                KPointIR {
                    label: Some("B20mT".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                KPointIR {
                    label: Some("B100mT".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![2],
            closed: false,
        }),
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        spin_wave_bc: SpinWaveBoundaryConditionIR::default(),
        sampling: SamplingIR {
            table_autosave: None,
            stage_autosave: None,
            outputs: vec![OutputIR::EigenSpectrum {
                quantity: "frequency_hz".to_string(),
            }],
        },
        mode_tracking: None,
    };

    let metadata = ir
        .problem_meta
        .runtime_metadata
        .get("k0_kittel_validation")
        .expect("runtime metadata should include k0 Kittel validation")
        .clone();
    let validation: FemEigenK0KittelValidationIR = serde_json::from_value(metadata)
        .expect("k0 Kittel validation metadata should deserialize into typed IR");
    assert_eq!(validation.kind, "k0_kittel_field_sweep");
    assert_eq!(validation.model, "thin_film_in_plane");
    assert_eq!(validation.samples.len(), 3);
    assert_eq!(validation.material.effective_magnetisation, Some(800000.0));
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
            stage_autosave: None,
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
            stage_autosave: None,
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
            method: Some(FrequencyResponseSolverMethodIR::GpuOperatorHostKrylov),
            preconditioner: Some(FrequencyResponsePreconditionerIR::BlockJacobi),
            rtol: Some(1.0e-2),
            max_iterations: Some(128),
            restart_iterations: Some(32),
        }),
        sampling: SamplingIR {
            table_autosave: None,
            stage_autosave: None,
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
            let solver_policy = solver_policy
                .as_ref()
                .expect("solver policy should round-trip");
            assert_eq!(solver_policy.max_iterations, Some(128));
            assert_eq!(
                solver_policy.method,
                Some(FrequencyResponseSolverMethodIR::GpuOperatorHostKrylov)
            );
            assert_eq!(
                solver_policy.preconditioner,
                Some(FrequencyResponsePreconditionerIR::BlockJacobi)
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
            stage_autosave: None,
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
            stage_autosave: None,
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
            stage_autosave: None,
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
        cells: FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
        element_markers: vec![1],
        facets: FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [0, 1, 3]]),
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
        cells: FemConnectivityIR::from_tet4(vec![[0, 1, 2, 4], [3, 5, 6, 7]]),
        element_markers: vec![1, 1],
        facets: FemFacetConnectivityIR::from_tri3(vec![[0, 2, 4], [1, 3, 5], [2, 4, 6], [3, 5, 7]]),
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
        cells: FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
        element_markers: vec![1],
        facets: FemFacetConnectivityIR::from_tri3(vec![[0, 2, 3], [1, 2, 3]]),
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
        cells: FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
        element_markers: vec![1],
        facets: FemFacetConnectivityIR::from_tri3(vec![[0, 2, 3], [1, 2, 3]]),
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
                fallbacks_triggered: Some(Vec::new()),
                effective_airbox_target: None,
                effective_airbox_hmax: Some(8e-9),
                effective_per_object_targets: HashMap::new(),
                region_markers: Vec::new(),
                object_region_markers: Vec::new(),
                used_size_field_kinds: vec!["curvature".to_string()],
                size_fields_realized: Vec::new(),
                operation_statuses: Vec::new(),
                thin_film_diagnostics: Vec::new(),
                magnetic_submesh_signatures: Vec::new(),
                selector_resolution: Vec::new(),
                orphan_entities: Vec::new(),
                rejected_element_types: Vec::new(),
                degraded: false,
                authored_regions_count: None,
                realized_regions_count: None,
                mixed_layer_topology_certificate: None,
                mixed_topology_provenance: None,
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
fn shared_domain_build_report_preserves_fallback_publication_presence() {
    let omitted: FemSharedDomainBuildReportIR = serde_json::from_value(serde_json::json!({
        "build_mode": "component_aware"
    }))
    .expect("build report without fallback evidence should deserialize");
    assert_eq!(omitted.fallbacks_triggered, None);
    assert!(serde_json::to_value(&omitted)
        .expect("build report should serialize")
        .get("fallbacks_triggered")
        .is_none());

    let explicit_empty: FemSharedDomainBuildReportIR = serde_json::from_value(serde_json::json!({
        "build_mode": "component_aware",
        "fallbacks_triggered": []
    }))
    .expect("build report with strict fallback evidence should deserialize");
    assert_eq!(explicit_empty.fallbacks_triggered, Some(Vec::new()));
    assert_eq!(
        serde_json::to_value(&explicit_empty).expect("build report should serialize")
            ["fallbacks_triggered"],
        serde_json::json!([])
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
            stage_autosave: None,
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
        schema_version: None,
        id: None,
        target: None,
        formula_version: "zhang_li.legacy_fullmag.v0".to_string(),
        operator_version: None,
        current_density: None,
        current_source: Some("drive".to_string()),
        degree: 0.4,
        beta: 0.02,
        lande_g: None,
    }];

    let errors = ir
        .validate()
        .expect_err("missing current transport source must fail validation");
    assert!(errors.iter().any(|error| {
        error.contains("current_source 'drive' must reference a current_transport module")
    }));
}

#[test]
fn canonical_mumax3_zhang_li_requires_source_g_factor() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.spin_torque_modules = vec![SpinTorqueModuleIR::ZhangLi {
        schema_version: Some("zhang_li_torque.v1".to_string()),
        id: Some("cip".to_string()),
        target: Some(fullmag_ir::RegionRefIR {
            object_id: "strip".to_string(),
            region_id: None,
        }),
        formula_version: "zhang_li.mumax3.v1".to_string(),
        operator_version: Some("zl_mumax3_central_v1".to_string()),
        current_density: Some([1e11, 0.0, 0.0]),
        current_source: None,
        degree: 0.4,
        beta: 0.02,
        lande_g: Some(1.9),
    }];

    let errors = ir
        .validate()
        .expect_err("MuMax3-compatible Zhang-Li must reject non-source g");
    assert!(errors.iter().any(|error| {
        error.contains("zhang_li.mumax3.v1") && error.contains("lande_g=2.0")
    }));
}

#[test]
fn canonical_slonczewski_requires_oriented_versioned_thin_layer_realization() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.spin_torque_modules = vec![SpinTorqueModuleIR::Slonczewski {
        schema_version: Some("slonczewski_torque.v1".to_string()),
        id: Some("cpp".to_string()),
        target: Some(fullmag_ir::RegionRefIR {
            object_id: "strip".to_string(),
            region_id: None,
        }),
        formula_version: "slonczewski.fullmag.v2".to_string(),
        current_density: Some([0.0, 0.0, -5e10]),
        current_source: None,
        degree: 0.4,
        spin_polarization: [0.0, 1.0, 0.0],
        stack_normal: Some([0.0, 0.0, 1.0]),
        lambda_asymmetry: 1.2,
        epsilon_prime: 0.0,
        free_layer_thickness_m: Some(1.5e-9),
        fixed_layer_position: None,
        realization: Some(fullmag_ir::SlonczewskiRealizationIR::ThinLayerHomogenized {
            realization_version: "slonczewski_thin_layer_homogenized.v1".to_string(),
        }),
    }];
    ir.validate()
        .unwrap_or_else(|errors| panic!("canonical Slonczewski should validate: {errors:?}"));
    let json = serde_json::to_string(&ir).unwrap();
    let restored: ProblemIR = serde_json::from_str(&json).unwrap();
    assert_eq!(restored.spin_torque_modules, ir.spin_torque_modules);
}

#[test]
fn canonical_slonczewski_rejects_nonfinite_scalar_coefficients() {
    for (name, lambda_asymmetry, epsilon_prime, free_layer_thickness_m) in [
        ("lambda_asymmetry", f64::NAN, 0.0, Some(1.5e-9)),
        ("epsilon_prime", 1.2, f64::INFINITY, Some(1.5e-9)),
        ("free_layer_thickness_m", 1.2, 0.0, Some(f64::NAN)),
    ] {
        let mut ir = ProblemIR::bootstrap_example();
        ir.spin_torque_modules = vec![SpinTorqueModuleIR::Slonczewski {
            schema_version: Some("slonczewski_torque.v1".to_string()),
            id: Some("cpp".to_string()),
            target: Some(fullmag_ir::RegionRefIR {
                object_id: "strip".to_string(),
                region_id: None,
            }),
            formula_version: "slonczewski.fullmag.v2".to_string(),
            current_density: Some([0.0, 0.0, -5e10]),
            current_source: None,
            degree: 0.4,
            spin_polarization: [0.0, 1.0, 0.0],
            stack_normal: Some([0.0, 0.0, 1.0]),
            lambda_asymmetry,
            epsilon_prime,
            free_layer_thickness_m,
            fixed_layer_position: None,
            realization: Some(fullmag_ir::SlonczewskiRealizationIR::ThinLayerHomogenized {
                realization_version: "slonczewski_thin_layer_homogenized.v1".to_string(),
            }),
        }];

        let errors = ir
            .validate()
            .expect_err("nonfinite canonical Slonczewski coefficient must fail validation");
        assert!(
            errors.iter().any(|error| error.contains(name)),
            "missing {name} diagnostic in {errors:?}"
        );
    }
}

#[test]
fn canonical_slonczewski_interface_flux_does_not_require_bulk_thickness() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.spin_torque_modules = vec![SpinTorqueModuleIR::Slonczewski {
        schema_version: Some("slonczewski_torque.v1".to_string()),
        id: Some("cpp-interface".to_string()),
        target: Some(fullmag_ir::RegionRefIR {
            object_id: "strip".to_string(),
            region_id: None,
        }),
        formula_version: "slonczewski.fullmag.v2".to_string(),
        current_density: Some([0.0, 0.0, -5e10]),
        current_source: None,
        degree: 0.4,
        spin_polarization: [0.0, 1.0, 0.0],
        stack_normal: Some([0.0, 0.0, 1.0]),
        lambda_asymmetry: 1.2,
        epsilon_prime: 0.0,
        free_layer_thickness_m: None,
        fixed_layer_position: None,
        realization: Some(fullmag_ir::SlonczewskiRealizationIR::InterfaceFlux {
            interface_id: "fixed-to-free".to_string(),
            realization_version: "slonczewski_interface_flux.v1".to_string(),
        }),
    }];

    ir.validate().unwrap_or_else(|errors| {
        panic!("surface Slonczewski realization must not invent bulk thickness: {errors:?}")
    });
}

#[test]
fn canonical_zhang_li_identity_survives_problem_ir_roundtrip() {
    let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
    value["spin_torque_modules"] = serde_json::json!([{
        "kind": "zhang_li",
        "schema_version": "zhang_li_torque.v1",
        "id": "cip",
        "target": {"object_id": "strip"},
        "formula_version": "zhang_li.fullmag.v1",
        "operator_version": "zl_central_reference_v1",
        "current_density": [5e10, 0.0, 0.0],
        "degree": 0.4,
        "beta": 0.02,
        "lande_g": 2.0
    }]);

    let ir: ProblemIR = serde_json::from_value(value).expect("canonical Zhang-Li wire shape");
    ir.validate()
        .unwrap_or_else(|errors| panic!("canonical Zhang-Li should validate: {errors:?}"));
    let roundtrip = serde_json::to_value(ir).unwrap();
    let torque = &roundtrip["spin_torque_modules"][0];
    assert_eq!(torque["schema_version"], "zhang_li_torque.v1");
    assert_eq!(torque["id"], "cip");
    assert_eq!(torque["target"]["object_id"], "strip");
    assert_eq!(torque["formula_version"], "zhang_li.fullmag.v1");
    assert_eq!(torque["operator_version"], "zl_central_reference_v1");
    assert_eq!(torque["lande_g"], 2.0);
}

#[test]
fn slonczewski_fixed_layer_position_accepts_top_and_bottom() {
    for position in ["top", "bottom"] {
        let mut ir = ProblemIR::bootstrap_example();
        ir.spin_torque_modules = vec![SpinTorqueModuleIR::Slonczewski {
            schema_version: None,
            id: None,
            target: None,
            formula_version: "slonczewski.legacy_fullmag.v0".to_string(),
            current_density: Some([0.0, 0.0, 5e10]),
            current_source: None,
            degree: 0.4,
            spin_polarization: [0.0, 0.0, 1.0],
            stack_normal: None,
            lambda_asymmetry: 1.2,
            epsilon_prime: 0.0,
            free_layer_thickness_m: Some(1.5e-9),
            fixed_layer_position: Some(position.to_string()),
            realization: None,
        }];

        ir.validate()
            .unwrap_or_else(|errors| panic!("{position} should validate, got {errors:?}"));
    }
}

#[test]
fn slonczewski_rejects_invalid_fixed_layer_position() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.spin_torque_modules = vec![SpinTorqueModuleIR::Slonczewski {
        schema_version: None,
        id: None,
        target: None,
        formula_version: "slonczewski.legacy_fullmag.v0".to_string(),
        current_density: Some([0.0, 0.0, 5e10]),
        current_source: None,
        degree: 0.4,
        spin_polarization: [0.0, 0.0, 1.0],
        stack_normal: None,
        lambda_asymmetry: 1.2,
        epsilon_prime: 0.0,
        free_layer_thickness_m: Some(1.5e-9),
        fixed_layer_position: Some("side".to_string()),
        realization: None,
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
        schema_version: None,
        id: None,
        target: None,
        formula_version: "slonczewski.legacy_fullmag.v0".to_string(),
        current_density: Some([0.0, 0.0, 5e10]),
        current_source: None,
        degree: 0.4,
        spin_polarization: [0.0, 0.0, 1.0],
        stack_normal: None,
        lambda_asymmetry: 1.2,
        epsilon_prime: 0.0,
        free_layer_thickness_m: Some(0.0),
        fixed_layer_position: Some("top".to_string()),
        realization: None,
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
        coupling: TransportCouplingIR::OneWay,
        definition: None,
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
        coupling: TransportCouplingIR::OneWay,
        definition: None,
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

fn mixed_topology_mesh() -> MeshIR {
    MeshIR {
        mesh_name: "mixed".into(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 1.0],
            [0.0, 1.0, 1.0],
            [1.0, 1.0, 0.0],
            [1.0, 1.0, 1.0],
        ],
        cells: FemConnectivityIR {
            types: vec![
                FemCellTypeIR::Prism6,
                FemCellTypeIR::Pyramid5,
                FemCellTypeIR::Tet4,
            ],
            offsets: vec![0, 6, 11, 15],
            nodes: vec![0, 1, 2, 3, 4, 5, 0, 1, 6, 2, 7, 0, 1, 2, 3],
            global_ordinals: vec![41, 7, 99],
            mesh_parts: Vec::new(),
        },
        element_markers: vec![11, 12, 13],
        facets: FemFacetConnectivityIR {
            types: vec![FemFacetTypeIR::Tri3, FemFacetTypeIR::Quad4],
            roles: vec![FemFacetRoleIR::Exterior, FemFacetRoleIR::MaterialInterface],
            offsets: vec![0, 3, 7],
            nodes: vec![0, 1, 2, 0, 1, 4, 3],
            global_ordinals: vec![88, 12],
        },
        boundary_markers: vec![21, 22],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: HashMap::new(),
    }
}

#[test]
fn fem_topology_enum_wire_strings_are_canonical() {
    let cases = [
        (serde_json::to_value(FemCellTypeIR::Tet4).unwrap(), "tet4"),
        (
            serde_json::to_value(FemCellTypeIR::Prism6).unwrap(),
            "prism6",
        ),
        (
            serde_json::to_value(FemCellTypeIR::Pyramid5).unwrap(),
            "pyramid5",
        ),
        (serde_json::to_value(FemCellTypeIR::Hex8).unwrap(), "hex8"),
        (serde_json::to_value(FemFacetTypeIR::Tri3).unwrap(), "tri3"),
        (
            serde_json::to_value(FemFacetTypeIR::Quad4).unwrap(),
            "quad4",
        ),
        (
            serde_json::to_value(FemFacetRoleIR::Exterior).unwrap(),
            "exterior",
        ),
        (
            serde_json::to_value(FemFacetRoleIR::MaterialInterface).unwrap(),
            "material_interface",
        ),
        (
            serde_json::to_value(FemFacetRoleIR::PeriodicSeam).unwrap(),
            "periodic_seam",
        ),
    ];
    for (actual, expected) in cases {
        assert_eq!(actual, serde_json::Value::String(expected.into()));
    }
}

#[test]
fn mixed_mesh_serde_round_trip_is_v2_only() {
    let mesh = mixed_topology_mesh();
    mesh.validate().expect("valid mixed topology");
    let value = serde_json::to_value(&mesh).unwrap();
    assert!(value.get("cells").is_some());
    assert!(value.get("facets").is_some());
    assert!(value.get("elements").is_none());
    assert!(value.get("boundary_faces").is_none());
    assert_eq!(
        value["cells"]["global_ordinals"],
        serde_json::json!([41, 7, 99])
    );
    assert_eq!(
        value["facets"]["global_ordinals"],
        serde_json::json!([88, 12])
    );
    assert_eq!(serde_json::from_value::<MeshIR>(value).unwrap(), mesh);
}

#[test]
fn topology_fingerprint_binds_cell_and_facet_global_ordinals() {
    let mesh = mixed_topology_mesh();
    let baseline = mesh.topology_fingerprint_v6();
    let mut changed_cell = mesh.clone();
    changed_cell.cells.global_ordinals[0] += 1_000;
    assert_ne!(changed_cell.topology_fingerprint_v6(), baseline);
    let mut changed_facet = mesh;
    changed_facet.facets.global_ordinals[0] += 1_000;
    assert_ne!(changed_facet.topology_fingerprint_v6(), baseline);
}

#[test]
fn legacy_tet_mesh_normalizes_and_dual_truth_rejects() {
    let legacy = serde_json::json!({
        "mesh_name": "legacy",
        "nodes": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        "elements": [[0, 1, 2, 3]],
        "element_markers": [7],
        "boundary_faces": [[0, 1, 2]],
        "boundary_markers": [9]
    });
    let mesh: MeshIR = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(mesh.cells.types, vec![FemCellTypeIR::Tet4]);
    assert_eq!(mesh.cells.offsets, vec![0, 4]);
    assert_eq!(mesh.facets.roles, vec![FemFacetRoleIR::Exterior]);
    assert_eq!(mesh.cells.global_ordinals, vec![0]);
    assert_eq!(mesh.facets.global_ordinals, vec![0]);
    let canonical = serde_json::to_value(mesh).unwrap();
    assert!(canonical.get("elements").is_none());
    assert!(canonical.get("boundary_faces").is_none());

    let mut dual = legacy;
    dual.as_object_mut().unwrap().insert(
        "cells".into(),
        serde_json::json!({"types": ["tet4"], "offsets": [0, 4], "nodes": [0, 1, 2, 3]}),
    );
    dual.as_object_mut().unwrap().insert(
        "facets".into(),
        serde_json::json!({"types": ["tri3"], "roles": ["exterior"], "offsets": [0, 3], "nodes": [0, 1, 2]}),
    );
    let error = serde_json::from_value::<MeshIR>(dual).unwrap_err();
    assert!(error.to_string().contains("both legacy and v2 topology"));
}

#[test]
fn mixed_mesh_validation_rejects_each_csr_invariant_and_periodicity() {
    let mutations: Vec<(&str, Box<dyn Fn(&mut MeshIR)>)> = vec![
        (
            "cell offsets",
            Box::new(|mesh| mesh.cells.offsets = vec![0, 6, 5, 15]),
        ),
        ("cell arity", Box::new(|mesh| mesh.cells.offsets[1] = 5)),
        ("cell index", Box::new(|mesh| mesh.cells.nodes[0] = 99)),
        (
            "cell duplicate",
            Box::new(|mesh| mesh.cells.nodes[1] = mesh.cells.nodes[0]),
        ),
        (
            "cell markers",
            Box::new(|mesh| mesh.element_markers.pop().map(|_| ()).unwrap()),
        ),
        (
            "cell global ordinals",
            Box::new(|mesh| mesh.cells.global_ordinals[1] = mesh.cells.global_ordinals[0]),
        ),
        (
            "facet offsets",
            Box::new(|mesh| mesh.facets.offsets = vec![0, 4, 7]),
        ),
        ("facet arity", Box::new(|mesh| mesh.facets.offsets[1] = 2)),
        ("facet index", Box::new(|mesh| mesh.facets.nodes[0] = 99)),
        (
            "facet duplicate",
            Box::new(|mesh| mesh.facets.nodes[1] = mesh.facets.nodes[0]),
        ),
        (
            "facet roles",
            Box::new(|mesh| mesh.facets.roles.pop().map(|_| ()).unwrap()),
        ),
        (
            "facet markers",
            Box::new(|mesh| mesh.boundary_markers.pop().map(|_| ()).unwrap()),
        ),
        (
            "facet global ordinals",
            Box::new(|mesh| mesh.facets.global_ordinals[1] = mesh.facets.global_ordinals[0]),
        ),
    ];
    for (label, mutate) in mutations {
        let mut mesh = mixed_topology_mesh();
        mutate(&mut mesh);
        assert!(mesh.validate().is_err(), "{label} mutation must reject");
    }

    let mut periodic = mixed_topology_mesh();
    periodic
        .periodic_boundary_pairs
        .push(MeshPeriodicBoundaryPairIR {
            pair_id: "x".into(),
            source_marker: None,
            destination_marker: None,
            marker_a: 21,
            marker_b: 22,
            axis_hint: Some("x".into()),
            translation: Some([1.0, 0.0, 0.0]),
            tolerance: Some(1e-9),
            orientation: None,
            pairing_policy: None,
        });
    let errors = periodic.validate().unwrap_err().join("\n");
    assert!(errors.contains("mixed topology"));
    assert!(errors.contains("periodic"));
}

#[test]
fn fixed_family_extractors_reject_malformed_csr_instead_of_shortening_output() {
    let mut mesh = MeshIR::from_legacy_tet4(
        "strict-extractors".into(),
        vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ],
        vec![[0, 1, 2, 3]],
        vec![7],
        vec![[0, 1, 2]],
        vec![9],
        Vec::new(),
        Vec::new(),
        HashMap::new(),
    );

    mesh.cells.global_ordinals.clear();
    assert!(mesh
        .require_tet4_elements()
        .unwrap_err()
        .contains("global_ordinals"));

    mesh = MeshIR::from_legacy_tet4(
        "strict-extractors".into(),
        mesh.nodes.clone(),
        vec![[0, 1, 2, 3]],
        vec![7],
        vec![[0, 1, 2]],
        vec![9],
        Vec::new(),
        Vec::new(),
        HashMap::new(),
    );
    mesh.element_markers.clear();
    assert!(mesh
        .require_tet4_elements()
        .unwrap_err()
        .contains("element_markers"));

    mesh = MeshIR::from_legacy_tet4(
        "strict-extractors".into(),
        mesh.nodes.clone(),
        vec![[0, 1, 2, 3]],
        vec![7],
        vec![[0, 1, 2]],
        vec![9],
        Vec::new(),
        Vec::new(),
        HashMap::new(),
    );
    mesh.facets.roles.clear();
    assert!(mesh
        .require_tri3_boundary_faces()
        .unwrap_err()
        .contains("roles"));

    mesh.facets = FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]);
    mesh.facets.offsets.pop();
    assert!(mesh
        .require_tri3_boundary_faces()
        .unwrap_err()
        .contains("offsets"));

    mesh.facets = FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]);
    mesh.boundary_markers.clear();
    assert!(mesh
        .require_tri3_boundary_faces()
        .unwrap_err()
        .contains("boundary_markers"));
}
