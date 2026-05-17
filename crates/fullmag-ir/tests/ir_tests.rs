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
                degraded: false,
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
        "degraded": false
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
