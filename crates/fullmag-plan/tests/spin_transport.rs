use fullmag_ir::{
    AxisBoundary, BackendPlanIR, BackendTarget, ChargeBoundaryIR, CurrentModuleIR, ExecutionDevice,
    ExecutionMode, ExecutionPrecision, FdmCpuTransportRealizationIR, FdmDemagPeriodicityIR,
    FdmPeriodicityIR, GeometryEntryIR, InitialMagnetizationIR, ObjectRegionIR, ProblemIR,
    RegionFrameIR, RegionIR, RegionRefIR, RegionShapeIR, SpinBoundaryIR, SpinInterfaceIR,
    SpinTransportModuleIR, SurfaceRefIR,
};
use serde_json::{json, Value};

fn racetrack_problem() -> ProblemIR {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../tests/standard_problems/transport/racetrack_m1_v1/fixture.v1.json"
    ))
    .expect("racetrack fixture must be valid JSON");
    let lowering = fixture
        .get("normalized_problem_ir_contract")
        .and_then(|value| value.get("expected_lowering"))
        .expect("fixture must contain typed expected_lowering");
    let mut problem: ProblemIR =
        serde_json::from_value(lowering.clone()).expect("fixture lowering must parse");

    problem.problem_meta.runtime_metadata.insert(
        "runtime_selection".into(),
        json!({
            "backend": "fdm",
            "device": "cpu",
            "gpu_count": 0,
            "device_index": null,
            "cpu_threads": null,
            "execution_mode": "strict",
            "execution_precision": "double"
        }),
    );
    problem.spin_transport_modules[0].requested_execution.device = ExecutionDevice::Cpu;
    problem.spin_transport_modules[0].solver.engine = "auto".into();
    problem
}

fn fdm_plan(problem: &ProblemIR) -> fullmag_ir::FdmPlanIR {
    let plan = fullmag_plan::plan(problem).expect("racetrack transport problem must plan");
    match plan.backend_plan {
        BackendPlanIR::Fdm(plan) => plan,
        other => panic!("expected FDM plan, got {other:?}"),
    }
}

fn surface(object_id: &str, surface_id: &str, orientation: [f64; 3]) -> SurfaceRefIR {
    SurfaceRefIR {
        object_id: object_id.into(),
        surface_id: surface_id.into(),
        orientation,
    }
}

fn set_native_m1(problem: &mut ProblemIR) {
    problem.spin_transport_modules[0].solver.engine = "native_m1_v1".into();
    problem.spin_transport_modules[0]
        .requested_execution
        .execution_mode = fullmag_ir::ExecutionMode::Strict;
    problem.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Strict;
}

fn public_fdm_gpu_m1_problem() -> ProblemIR {
    let mut problem = racetrack_problem();
    problem.backend_policy.requested_backend = BackendTarget::Fdm;
    problem.backend_policy.execution_precision = ExecutionPrecision::Double;
    problem.validation_profile.execution_mode = ExecutionMode::Strict;
    problem.problem_meta.runtime_metadata.insert(
        "runtime_selection".into(),
        json!({
            "backend": "fdm",
            "device": "gpu",
            "gpu_count": 1,
            "device_index": 0,
            "cpu_threads": null,
            "execution_mode": "strict",
            "execution_precision": "double"
        }),
    );
    problem.spin_transport_modules[0]
        .requested_execution
        .discretization = BackendTarget::Fdm;
    problem.spin_transport_modules[0].requested_execution.device = ExecutionDevice::Gpu;
    problem.spin_transport_modules[0]
        .requested_execution
        .precision = ExecutionPrecision::Double;
    problem.spin_transport_modules[0]
        .requested_execution
        .execution_mode = ExecutionMode::Strict;
    problem.spin_transport_modules[0].solver.engine = "native_m1_v1".into();
    problem
}

fn assert_public_fdm_gpu_m1_rejected(
    problem: &ProblemIR,
    case: &str,
    expected_reason: &str,
    requires_explicit_no_fallback: bool,
) {
    let error = match fullmag_plan::plan(problem) {
        Ok(_) => panic!("public FDM GPU M1 case '{case}' must fail closed"),
        Err(error) => error,
    };
    let reasons = error.reasons.join("; ");
    assert!(
        reasons.contains(expected_reason),
        "public FDM GPU M1 case '{case}' must report {expected_reason:?}, got {reasons:?}"
    );
    if requires_explicit_no_fallback {
        assert!(
            reasons.contains("fdm_gpu_m1_scope_rejected") && reasons.contains("fallback=none"),
            "public FDM GPU M1 case '{case}' must reject the bounded lane without fallback: {reasons:?}"
        );
    }
}

fn runtime_selection_mut(problem: &mut ProblemIR) -> &mut serde_json::Map<String, Value> {
    problem
        .problem_meta
        .runtime_metadata
        .get_mut("runtime_selection")
        .and_then(Value::as_object_mut)
        .expect("runtime selection object")
}

#[test]
fn resolves_bounded_public_fdm_gpu_m1_spin_transport() {
    let problem = public_fdm_gpu_m1_problem();
    let plan = fdm_plan(&problem);
    let resolved = plan
        .spin_transport_plans
        .first()
        .expect("bounded GPU M1 spin plan");

    assert_eq!(
        resolved.requested_execution.discretization,
        BackendTarget::Fdm
    );
    assert_eq!(resolved.requested_execution.device, ExecutionDevice::Gpu);
    assert_eq!(
        resolved.requested_execution.precision,
        ExecutionPrecision::Double
    );
    assert_eq!(
        resolved.requested_execution.execution_mode,
        ExecutionMode::Strict
    );
    assert_eq!(resolved.resolved_discretization, BackendTarget::Fdm);
    assert_eq!(resolved.resolved_device, ExecutionDevice::Gpu);
    assert_eq!(resolved.resolved_precision, ExecutionPrecision::Double);
    assert!(resolved.fdm_cpu_double.is_none());
    assert!(resolved.fdm_cpu_double_reciprocal.is_none());
    assert!(resolved.fdm_cpu_double_transient.is_none());
    let descriptor = resolved
        .fdm_gpu_double
        .as_ref()
        .expect("bounded GPU FP64 spin descriptor");
    assert_eq!(
        descriptor.realization,
        FdmCpuTransportRealizationIR::NativeM1V1
    );
    assert_eq!(descriptor.enclosing_execution_mode, ExecutionMode::Strict);
    assert!(!descriptor.interfaces.is_empty());
    assert_eq!(descriptor.torque_target_masks.len(), 1);
    assert!(!descriptor.oersted_source_bound);
    assert!(plan.fdm_gpu_charge_transports.is_empty());
}

#[test]
fn public_fdm_gpu_m1_rejects_every_unqualified_extension_without_fallback() {
    let mut cases = Vec::<(&str, ProblemIR, &str, bool)>::new();

    let mut module_auto = public_fdm_gpu_m1_problem();
    module_auto.spin_transport_modules[0]
        .requested_execution
        .device = ExecutionDevice::Auto;
    cases.push((
        "module device auto",
        module_auto,
        "execution.device=not_explicit_gpu",
        true,
    ));

    let mut module_cpu = public_fdm_gpu_m1_problem();
    module_cpu.spin_transport_modules[0]
        .requested_execution
        .device = ExecutionDevice::Cpu;
    cases.push((
        "module device cpu",
        module_cpu,
        "execution.device=not_explicit_gpu",
        true,
    ));

    let mut runtime_cpu = public_fdm_gpu_m1_problem();
    runtime_cpu.problem_meta.runtime_metadata.insert(
        "runtime_selection".into(),
        json!({
            "backend": "fdm",
            "device": "cpu",
            "gpu_count": 0,
            "device_index": null,
            "cpu_threads": null,
            "execution_mode": "strict",
            "execution_precision": "double"
        }),
    );
    cases.push((
        "runtime device cpu",
        runtime_cpu,
        "runtime_selection.device=not_explicit_gpu",
        true,
    ));

    let mut runtime_auto = public_fdm_gpu_m1_problem();
    runtime_selection_mut(&mut runtime_auto).insert("device".into(), json!("auto"));
    cases.push((
        "runtime device auto",
        runtime_auto,
        "runtime_selection.device=not_explicit_gpu",
        true,
    ));

    let mut single = public_fdm_gpu_m1_problem();
    single.backend_policy.execution_precision = ExecutionPrecision::Single;
    single.spin_transport_modules[0]
        .requested_execution
        .precision = ExecutionPrecision::Single;
    runtime_selection_mut(&mut single).insert("execution_precision".into(), json!("single"));
    cases.push((
        "single precision",
        single,
        "supports precision=double only",
        false,
    ));

    let mut extended = public_fdm_gpu_m1_problem();
    extended.validation_profile.execution_mode = ExecutionMode::Extended;
    extended.spin_transport_modules[0]
        .requested_execution
        .execution_mode = ExecutionMode::Extended;
    runtime_selection_mut(&mut extended).insert("execution_mode".into(), json!("extended"));
    cases.push((
        "extended execution",
        extended,
        "execution.mode=not_strict",
        true,
    ));

    let mut reciprocal = public_fdm_gpu_m1_problem();
    let CurrentModuleIR::CurrentTransport {
        model,
        coupling,
        definition: Some(charge),
        ..
    } = &mut reciprocal.current_modules[0]
    else {
        panic!("racetrack current transport")
    };
    *model = fullmag_ir::CurrentTransportModelIR::MagnetoresistivePoisson;
    *coupling = fullmag_ir::TransportCouplingIR::Bidirectional;
    for assignment in &mut charge.materials {
        let sigma = assignment.material.sigma_spm;
        assignment.material.sigma_parallel_spm = Some(1.2 * sigma);
        assignment.material.sigma_perpendicular_spm = Some(sigma);
        assignment.material.sigma_ahe_spm = Some(0.0);
    }
    charge.solver.engine = "block_gmres".into();
    charge.solver.operator_version = "fdm_coupled_charge_spin_fv_block_gmres.v1".into();
    charge.solver.physical_residual_version = "transport_balance_integrated_l2.v1".into();
    reciprocal.spin_transport_modules[0].constitutive_version =
        "transport_constitutive.reciprocal.fullmag.v1".into();
    reciprocal.spin_transport_modules[0].solver.operator_version =
        "fdm_coupled_charge_spin_fv_block_gmres.v1".into();
    reciprocal.spin_transport_modules[0]
        .solver
        .reciprocal_nonlinear = Some(fullmag_ir::ReciprocalNonlinearSolverPolicyIR {
        gmres_restart: 40,
        max_picard_iterations: 4,
        relative_update_tolerance: 1.0e-9,
        eta_transport: 0.25,
    });
    cases.push((
        "M2 inverse SHE",
        reciprocal,
        "physics=not_steady_one_way_m1",
        true,
    ));

    let mut transient = public_fdm_gpu_m1_problem();
    transient.spin_transport_modules[0].mode = fullmag_ir::SpinTransportModeIR::Transient;
    for assignment in &mut transient.spin_transport_modules[0].materials {
        assignment.material.spin_capacitance_as_per_v_m3 = Some(2.5);
        assignment.material.capacitance_formula_version =
            Some("dos_isotropic_nonmagnetic.fullmag.v1".into());
    }
    let fullmag_ir::StudyIR::TimeEvolution { dynamics, .. } = &mut transient.study else {
        panic!("racetrack time evolution")
    };
    let fullmag_ir::DynamicsIR::Llg { integrator, .. } = dynamics;
    *integrator = "coupled_imex_ark2".into();
    cases.push((
        "M3 transient",
        transient,
        "physics=not_steady_one_way_m1",
        true,
    ));

    let mut periodic = public_fdm_gpu_m1_problem();
    periodic.pbc = Some(FdmPeriodicityIR {
        axes: [
            AxisBoundary::Periodic,
            AxisBoundary::Open,
            AxisBoundary::Open,
        ],
        demag: FdmDemagPeriodicityIR::TruncatedImages,
        image_counts: Some([1, 0, 0]),
    });
    cases.push((
        "periodic boundary",
        periodic,
        "periodic_transport=unsupported",
        true,
    ));

    let mut thermal = public_fdm_gpu_m1_problem();
    thermal.temperature = Some(300.0);
    thermal
        .energy_terms
        .push(fullmag_ir::EnergyTermIR::ThermalNoise {
            temperature: 300.0,
            seed: Some(7),
        });
    cases.push(("thermal noise", thermal, "thermal_noise=unsupported", true));

    let mut oersted = public_fdm_gpu_m1_problem();
    oersted
        .energy_terms
        .push(fullmag_ir::EnergyTermIR::OerstedField {
            id: None,
            model: fullmag_ir::OerstedFieldModelIR::FromCurrentSolution,
            source: "charge".into(),
        });
    cases.push((
        "Oersted coupling",
        oersted,
        "oersted_coupling=unsupported",
        true,
    ));

    let mut missing_mixing = public_fdm_gpu_m1_problem();
    missing_mixing.spin_transport_modules[0].interfaces.clear();
    cases.push((
        "missing mixing interface",
        missing_mixing,
        "mixing_interface=requires_exactly_one_family",
        true,
    ));

    let mut automatic_solver = public_fdm_gpu_m1_problem();
    automatic_solver.spin_transport_modules[0].solver.engine = "auto".into();
    cases.push((
        "automatic solver",
        automatic_solver,
        "spin_solver=not_native_m1_v1",
        true,
    ));

    let mut auto_backend = public_fdm_gpu_m1_problem();
    auto_backend.backend_policy.requested_backend = BackendTarget::Auto;
    auto_backend.spin_transport_modules[0]
        .requested_execution
        .discretization = BackendTarget::Auto;
    runtime_selection_mut(&mut auto_backend).insert("backend".into(), json!("auto"));
    cases.push((
        "automatic backend",
        auto_backend,
        "execution.discretization=not_explicit_fdm",
        true,
    ));

    for (case, problem, expected_reason, requires_explicit_no_fallback) in cases {
        assert_public_fdm_gpu_m1_rejected(
            &problem,
            case,
            expected_reason,
            requires_explicit_no_fallback,
        );
    }
}

fn set_module_graph(problem: &mut ProblemIR, mut modules: Value) {
    let module_array = modules.as_array_mut().expect("test graph modules");
    let mut edges = Vec::new();
    for module in module_array
        .iter_mut()
        .filter(|module| module.get("kind").and_then(Value::as_str) == Some("spin_torque"))
    {
        let target_id = module
            .get("id")
            .and_then(Value::as_str)
            .expect("test torque id")
            .to_string();
        let Some(source_id) = module
            .get("depends_on")
            .and_then(Value::as_array)
            .and_then(|dependencies| dependencies.first())
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            continue;
        };
        let status = module
            .get("activation")
            .and_then(Value::as_str)
            .unwrap_or("inactive")
            .to_string();
        module["family_payload"] = serde_json::to_value(&problem.spin_torque_modules[0])
            .expect("serialize canonical graph torque");
        edges.push(json!({
            "kind": "spin_transport_to_torque",
            "source_id": source_id,
            "target_id": target_id,
            "status": status
        }));
    }
    problem.physics_graph = Some(json!({
        "schema_version": "physics_graph.v1",
        "scene_revision": 1,
        "modules": modules,
        "edges": edges
    }));
}

fn set_relaxation(problem: &mut ProblemIR) {
    problem.study = fullmag_ir::StudyIR::Relaxation {
        algorithm: fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped,
        dynamics: Some(problem.study.dynamics().clone()),
        stop: fullmag_ir::RelaxStopIR {
            torque_tolerance_apm: Some(1.0e-3),
            energy_tolerance_j: None,
            max_steps: Some(250),
            max_relaxation_time_s: None,
        },
        sampling: problem.study.sampling().clone(),
    };
}

#[test]
fn transport_domain_drives_common_grid_while_llg_stays_on_magnetic_cells() {
    let problem = racetrack_problem();
    let plan = fdm_plan(&problem);

    assert_eq!(plan.origin_m, [0.0, 0.0, 0.0]);
    assert_eq!(plan.grid.cells, [256, 64, 4]);
    assert_eq!(plan.cell_size, [2.0e-9, 2.0e-9, 1.0e-9]);
    assert_eq!(
        plan.grid_certificate
            .as_ref()
            .unwrap()
            .object_ids
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec!["fm", "hm"]
    );

    let magnetic = plan.active_mask.as_ref().expect("magnetic mask");
    assert_eq!(magnetic.len(), 65_536);
    assert_eq!(magnetic.iter().filter(|active| **active).count(), 16_384);
    assert!(magnetic[..49_152].iter().all(|active| !active));
    assert!(magnetic[49_152..].iter().all(|active| *active));

    let descriptor = plan.spin_transport_plans[0]
        .fdm_cpu_double
        .as_ref()
        .expect("CPU transport descriptor");
    assert_eq!(descriptor.transport_active_mask.len(), 65_536);
    assert!(descriptor
        .transport_active_mask
        .iter()
        .all(|active| *active));
    assert_eq!(descriptor.magnetic_active_mask, *magnetic);
    assert_eq!(descriptor.torque_target_masks.len(), 1);
    assert_eq!(descriptor.torque_target_masks[0].active_mask, *magnetic);
    assert_eq!(descriptor.torque_target_masks[0].target.object_id, "fm");
    assert!(descriptor
        .saturation_magnetization_apm
        .iter()
        .zip(magnetic)
        .all(|(ms, active)| if *active { *ms > 0.0 } else { *ms == 0.0 }));

    let mut wire = serde_json::to_value(descriptor).expect("resolved descriptor serialization");
    assert_eq!(
        wire["transport_active_mask"].as_array().unwrap().len(),
        65_536
    );
    assert_eq!(
        wire["magnetic_active_mask"].as_array().unwrap().len(),
        65_536
    );
    assert_eq!(wire["torque_target_masks"][0]["target"]["object_id"], "fm");
    let object = wire.as_object_mut().unwrap();
    object.remove("transport_active_mask");
    object.remove("magnetic_active_mask");
    object.remove("torque_target_masks");
    let legacy: fullmag_ir::ResolvedFdmSpinTransportIR =
        serde_json::from_value(wire).expect("legacy descriptor must remain readable");
    assert!(legacy.transport_active_mask.is_empty());
    assert!(legacy.magnetic_active_mask.is_empty());
    assert!(legacy.torque_target_masks.is_empty());
}

#[test]
fn zero_current_preserves_transport_domain_module() {
    let problem = racetrack_problem();
    let CurrentModuleIR::CurrentTransport { definition, .. } = &problem.current_modules[0] else {
        panic!("expected current transport")
    };
    assert!(definition
        .as_ref()
        .expect("charge definition")
        .boundaries
        .iter()
        .all(|boundary| match boundary {
            fullmag_ir::ChargeBoundaryIR::NormalCurrentElectrode {
                outward_current_density_apm2,
                ..
            } => *outward_current_density_apm2 == 0.0,
            _ => true,
        }));

    let plan = fdm_plan(&problem);
    assert_eq!(plan.spin_transport_plans.len(), 1);
    let descriptor = plan.spin_transport_plans[0]
        .fdm_cpu_double
        .as_ref()
        .unwrap();
    assert!(descriptor
        .transport_active_mask
        .iter()
        .any(|active| *active));
    assert!(descriptor.torque_target_masks[0]
        .active_mask
        .iter()
        .any(|active| *active));
}

#[test]
fn transport_domain_must_cover_the_magnetic_domain() {
    let mut problem = racetrack_problem();
    let CurrentModuleIR::CurrentTransport { definition, .. } = &mut problem.current_modules[0]
    else {
        panic!("expected current transport")
    };
    let definition = definition.as_mut().expect("charge definition");
    definition.domain.retain(|region| region.object_id == "hm");
    definition
        .materials
        .retain(|assignment| assignment.region.object_id == "hm");
    let SpinTransportModuleIR {
        domain, materials, ..
    } = &mut problem.spin_transport_modules[0];
    domain.retain(|region| region.object_id == "hm");
    materials.retain(|assignment| assignment.region.object_id == "hm");

    let error = fullmag_plan::plan(&problem).expect_err("uncovered magnetic domain must fail");
    assert!(
        error.reasons.iter().any(|reason| {
            reason.contains("magnetic") && reason.contains("transport") && reason.contains("subset")
        }),
        "unexpected errors: {:?}",
        error.reasons
    );
}

#[test]
fn nonmagnetic_object_region_drives_transport_bounds_and_mask() {
    let mut problem = racetrack_problem();
    let hm_geometry = problem
        .geometry
        .entries
        .iter_mut()
        .find(|entry| entry.name() == "hm")
        .expect("HM geometry");
    let GeometryEntryIR::Translate { base, by, .. } = hm_geometry else {
        panic!("expected translated HM box")
    };
    let GeometryEntryIR::Box { size, .. } = base.as_mut() else {
        panic!("expected HM box")
    };
    size[0] = 768.0e-9;
    by[0] = 384.0e-9;

    let hm_region = RegionRefIR {
        object_id: "hm".into(),
        region_id: Some("hm:transport-left".into()),
    };
    problem.object_regions.push(ObjectRegionIR {
        region_id: "hm:transport-left".into(),
        owner_object: "hm".into(),
        name: "transport-left".into(),
        shape: RegionShapeIR::Box {
            size: [256.0e-9, 128.0e-9, 3.0e-9],
            center: [-256.0e-9, 0.0, 0.0],
        },
        frame: RegionFrameIR::Object,
        enabled: true,
        priority: 0,
        mesh_policy: None,
        material_overrides: Vec::new(),
        texture_override: None,
        realization_policy: fullmag_ir::RegionRealizationPolicyIR::Inherit,
        material_transition: None,
    });

    let CurrentModuleIR::CurrentTransport { definition, .. } = &mut problem.current_modules[0]
    else {
        panic!("expected current transport")
    };
    let definition = definition.as_mut().expect("charge definition");
    *definition
        .domain
        .iter_mut()
        .find(|region| region.object_id == "hm")
        .expect("HM charge domain") = hm_region.clone();
    definition
        .materials
        .iter_mut()
        .find(|assignment| assignment.region.object_id == "hm")
        .expect("HM charge material")
        .region = hm_region.clone();

    let spin = &mut problem.spin_transport_modules[0];
    *spin
        .domain
        .iter_mut()
        .find(|region| region.object_id == "hm")
        .expect("HM spin domain") = hm_region.clone();
    spin.materials
        .iter_mut()
        .find(|assignment| assignment.region.object_id == "hm")
        .expect("HM spin material")
        .region = hm_region.clone();
    let SpinInterfaceIR::MixingConductance { normal_side, .. } = &mut spin.interfaces[0] else {
        panic!("expected mixing interface")
    };
    *normal_side = hm_region;

    let plan = fdm_plan(&problem);
    assert_eq!(plan.origin_m, [0.0, 0.0, 0.0]);
    assert_eq!(plan.grid.cells, [256, 64, 4]);
    assert_eq!(
        plan.grid_certificate.as_ref().unwrap().object_ids,
        vec!["fm".to_string(), "hm".to_string()]
    );
    let descriptor = plan.spin_transport_plans[0]
        .fdm_cpu_double
        .as_ref()
        .expect("CPU transport descriptor");
    assert_eq!(
        descriptor
            .transport_active_mask
            .iter()
            .filter(|active| **active)
            .count(),
        40_960
    );
    let nx = plan.grid.cells[0] as usize;
    let ny = plan.grid.cells[1] as usize;
    assert!(descriptor.transport_active_mask[127]);
    assert!(!descriptor.transport_active_mask[128]);
    assert!(descriptor.transport_active_mask[3 * nx * ny + 128]);
}

#[test]
fn unrelated_unsupported_geometry_does_not_enter_transport_grid() {
    let mut problem = racetrack_problem();
    problem.geometry.entries.extend([
        GeometryEntryIR::Sphere {
            name: "unrelated-sphere".into(),
            radius: 10.0e-9,
        },
        GeometryEntryIR::Union {
            name: "unrelated-union".into(),
            a: Box::new(GeometryEntryIR::Box {
                name: "unrelated-union-a".into(),
                size: [10.0e-9; 3],
            }),
            b: Box::new(GeometryEntryIR::Box {
                name: "unrelated-union-b".into(),
                size: [10.0e-9; 3],
            }),
        },
        GeometryEntryIR::Intersection {
            name: "unrelated-intersection".into(),
            a: Box::new(GeometryEntryIR::Box {
                name: "unrelated-intersection-a".into(),
                size: [10.0e-9; 3],
            }),
            b: Box::new(GeometryEntryIR::Box {
                name: "unrelated-intersection-b".into(),
                size: [5.0e-9; 3],
            }),
        },
    ]);
    problem.regions.push(RegionIR {
        name: "unrelated-alias".into(),
        geometry: "unrelated-sphere".into(),
    });

    let plan = fdm_plan(&problem);
    assert_eq!(plan.grid.cells, [256, 64, 4]);
    assert_eq!(
        plan.grid_certificate.as_ref().unwrap().object_ids,
        vec!["fm".to_string(), "hm".to_string()]
    );
}

#[test]
fn independent_charge_solve_is_not_suppressed_by_spin_transport() {
    let mut problem = racetrack_problem();
    let mut independent = problem.current_modules[0].clone();
    let CurrentModuleIR::CurrentTransport { name, .. } = &mut independent else {
        panic!("expected current transport")
    };
    *name = "independent-charge".into();
    problem.current_modules.push(independent);

    let error = fullmag_plan::plan(&problem)
        .expect_err("independent charge solve must plan or fail explicitly");
    assert!(
        error.reasons.iter().any(|reason| {
            reason.contains("fdm_gpu_charge_scope_rejected")
                && reason.contains("charge_only_requires_no_spin_transport_or_torque_modules")
                && reason.contains("fallback=none")
        }),
        "unexpected errors: {:?}",
        error.reasons
    );
    assert!(
        error
            .reasons
            .iter()
            .all(|reason| !reason.contains("found 2")),
        "the spin-bound charge source must not be counted as standalone: {:?}",
        error.reasons
    );
}

#[test]
fn hm_and_fm_current_surfaces_materialize_only_their_owned_face_cells() {
    let mut problem = racetrack_problem();
    set_native_m1(&mut problem);
    let CurrentModuleIR::CurrentTransport { definition, .. } = &mut problem.current_modules[0]
    else {
        panic!("expected current transport")
    };
    let definition = definition.as_mut().expect("charge definition");
    definition.boundaries[0] = ChargeBoundaryIR::NormalCurrentElectrode {
        id: "hm_x_minus".into(),
        surfaces: vec![surface("hm", "x-", [-1.0, 0.0, 0.0])],
        outward_current_density_apm2: 1.0e12,
    };
    definition.boundaries[1] = ChargeBoundaryIR::NormalCurrentElectrode {
        id: "hm_x_plus".into(),
        surfaces: vec![surface("hm", "x+", [1.0, 0.0, 0.0])],
        outward_current_density_apm2: -1.0e12,
    };

    let plan = fdm_plan(&problem);
    let descriptor = plan.spin_transport_plans[0]
        .fdm_cpu_double
        .as_ref()
        .expect("native M1 descriptor");
    assert_eq!(descriptor.specified_current_faces.len(), 2 * 64 * 3);
    let plane = 256_u64 * 64;
    assert!(descriptor
        .specified_current_faces
        .iter()
        .all(|face| face.adjacent_cell < 3 * plane));
}

#[test]
fn hm_only_nonzero_voltage_on_shared_global_face_fails_closed() {
    let mut problem = racetrack_problem();
    let CurrentModuleIR::CurrentTransport { definition, .. } = &mut problem.current_modules[0]
    else {
        panic!("expected current transport")
    };
    let definition = definition.as_mut().expect("charge definition");
    definition.gauge = fullmag_ir::ChargePotentialGaugeIR::DirichletReference;
    definition.boundaries[0] = ChargeBoundaryIR::VoltageElectrode {
        id: "hm_voltage".into(),
        surfaces: vec![surface("hm", "x-", [-1.0, 0.0, 0.0])],
        potential_v: 0.1,
    };

    let error = fullmag_plan::plan(&problem).expect_err("partial voltage face must fail closed");
    assert!(
        error.reasons.iter().any(|reason| {
            reason.contains("hm_voltage")
                && reason.contains("partially owned")
                && reason.contains("x")
        }),
        "unexpected errors: {:?}",
        error.reasons
    );
}

#[test]
fn hm_only_nonzero_spin_flux_on_shared_global_face_fails_closed() {
    let mut problem = racetrack_problem();
    let SpinBoundaryIR::SpinInsulating { surfaces, .. } =
        &mut problem.spin_transport_modules[0].boundaries[0]
    else {
        panic!("expected fixture insulating boundary")
    };
    surfaces.retain(|surface| !(surface.object_id == "hm" && surface.surface_id == "x-"));
    problem.spin_transport_modules[0]
        .boundaries
        .push(SpinBoundaryIR::SpecifiedSpinFlux {
            id: "hm_spin_flux".into(),
            surfaces: vec![surface("hm", "x-", [-1.0, 0.0, 0.0])],
            normal_spin_flux_apm2: [1.0, 0.0, 0.0],
        });

    let error = fullmag_plan::plan(&problem).expect_err("partial spin face must fail closed");
    assert!(
        error.reasons.iter().any(|reason| {
            reason.contains("hm_spin_flux")
                && reason.contains("partially owned")
                && reason.contains("x")
        }),
        "unexpected errors: {:?}",
        error.reasons
    );
}

#[test]
fn zero_boundary_on_owner_without_face_cells_is_a_noop_but_nonzero_fails() {
    let mut zero = racetrack_problem();
    let CurrentModuleIR::CurrentTransport { definition, .. } = &mut zero.current_modules[0] else {
        panic!("expected current transport")
    };
    definition
        .as_mut()
        .expect("charge definition")
        .boundaries
        .push(ChargeBoundaryIR::NormalCurrentElectrode {
            id: "fm_bottom_zero".into(),
            surfaces: vec![surface("fm", "z-", [0.0, 0.0, -1.0])],
            outward_current_density_apm2: 0.0,
        });
    fdm_plan(&zero);

    let mut nonzero = zero;
    let CurrentModuleIR::CurrentTransport { definition, .. } = &mut nonzero.current_modules[0]
    else {
        panic!("expected current transport")
    };
    let ChargeBoundaryIR::NormalCurrentElectrode {
        outward_current_density_apm2,
        ..
    } = definition
        .as_mut()
        .expect("charge definition")
        .boundaries
        .last_mut()
        .expect("extra boundary")
    else {
        panic!("expected current boundary")
    };
    *outward_current_density_apm2 = 1.0;
    let error = fullmag_plan::plan(&nonzero)
        .expect_err("nonzero boundary without owned face cells must fail closed");
    assert!(
        error.reasons.iter().any(|reason| {
            reason.contains("fm_bottom_zero") && reason.contains("no active owned FDM face cells")
        }),
        "unexpected errors: {:?}",
        error.reasons
    );
}

#[test]
fn neutral_spin_boundaries_without_owned_face_cells_use_default_insulating_faces() {
    let no_owned_cells = surface("fm", "z-", [0.0, 0.0, -1.0]);
    let neutral_boundaries = [
        SpinBoundaryIR::SpinInsulating {
            id: "noop_insulating".into(),
            surfaces: vec![no_owned_cells.clone()],
        },
        SpinBoundaryIR::SpecifiedSpinFlux {
            id: "noop_zero_flux".into(),
            surfaces: vec![no_owned_cells.clone()],
            normal_spin_flux_apm2: [0.0; 3],
        },
        SpinBoundaryIR::SpecifiedSpinPotential {
            id: "noop_zero_potential".into(),
            surfaces: vec![no_owned_cells],
            spin_potential_v: [0.0; 3],
        },
    ];

    for boundary in neutral_boundaries {
        let mut problem = racetrack_problem();
        problem.spin_transport_modules[0].boundaries = vec![boundary];
        let plan = fdm_plan(&problem);
        let descriptor = plan.spin_transport_plans[0]
            .fdm_cpu_double
            .as_ref()
            .expect("CPU transport descriptor");
        assert_eq!(descriptor.spin_boundaries.len(), 6);
        assert!(descriptor.spin_boundaries.iter().all(|boundary| {
            boundary.source_id == "default:spin_insulating"
                && boundary.condition == fullmag_ir::ResolvedSpinBoundaryConditionIR::SpinInsulating
        }));
    }
}

#[test]
fn nonzero_spin_boundary_without_owned_face_cells_fails_closed() {
    let mut problem = racetrack_problem();
    problem.spin_transport_modules[0].boundaries = vec![SpinBoundaryIR::SpecifiedSpinFlux {
        id: "fm_bottom_nonzero_flux".into(),
        surfaces: vec![surface("fm", "z-", [0.0, 0.0, -1.0])],
        normal_spin_flux_apm2: [1.0, 0.0, 0.0],
    }];

    let error = fullmag_plan::plan(&problem)
        .expect_err("nonzero spin boundary without owned face cells must fail closed");
    assert!(
        error.reasons.iter().any(|reason| {
            reason.contains("fm_bottom_nonzero_flux")
                && reason.contains("no active owned FDM face cells")
        }),
        "unexpected errors: {:?}",
        error.reasons
    );
}

#[test]
fn inactive_transport_graph_does_not_expand_the_magnetic_grid() {
    let mut problem = racetrack_problem();
    set_module_graph(
        &mut problem,
        json!([
            {
                "id": "charge", "kind": "current_transport", "applies_to": [],
                "solve_domain": [], "depends_on": [], "activation": "inactive"
            },
            {
                "id": "spin", "kind": "spin_transport", "applies_to": [],
                "solve_domain": [], "depends_on": ["charge"], "activation": "inactive"
            },
            {
                "id": "transport_torque", "kind": "spin_torque", "applies_to": [],
                "solve_domain": [], "depends_on": ["spin"], "activation": "inactive"
            }
        ]),
    );

    let plan = fdm_plan(&problem);
    assert_eq!(plan.grid.cells, [256, 64, 1]);
    assert!(plan.spin_transport_plans.is_empty());
    assert!(plan.fdm_gpu_charge_transports.is_empty());
    assert_eq!(
        plan.grid_certificate.as_ref().unwrap().object_ids,
        vec!["fm".to_string()]
    );
}

#[test]
fn inactive_transport_torque_is_provenance_only_during_relaxation() {
    let mut problem = racetrack_problem();
    set_relaxation(&mut problem);
    set_module_graph(
        &mut problem,
        json!([
            {
                "id": "charge", "kind": "current_transport", "applies_to": [],
                "solve_domain": [], "depends_on": [], "activation": "inactive"
            },
            {
                "id": "spin", "kind": "spin_transport", "applies_to": [],
                "solve_domain": [], "depends_on": ["charge"], "activation": "inactive"
            },
            {
                "id": "transport_torque", "kind": "spin_torque", "applies_to": [],
                "solve_domain": [], "depends_on": ["spin"], "activation": "inactive"
            }
        ]),
    );

    fullmag_plan::plan(&problem)
        .expect("inactive transport torque must not invalidate conservative relaxation");
}

#[test]
fn active_transport_torque_is_rejected_during_relaxation() {
    let mut problem = racetrack_problem();
    set_relaxation(&mut problem);
    set_module_graph(
        &mut problem,
        json!([
            {
                "id": "charge", "kind": "current_transport", "applies_to": [],
                "solve_domain": [], "depends_on": [], "activation": "active"
            },
            {
                "id": "spin", "kind": "spin_transport", "applies_to": [],
                "solve_domain": [], "depends_on": ["charge"], "activation": "active"
            },
            {
                "id": "transport_torque", "kind": "spin_torque", "applies_to": [],
                "solve_domain": [], "depends_on": ["spin"], "activation": "active"
            }
        ]),
    );

    let error = fullmag_plan::plan(&problem)
        .expect_err("active transport torque must invalidate conservative relaxation");
    assert!(error.reasons.iter().any(|reason| {
        reason.contains("drift_diffusion_spin_torque")
            && reason.contains("conservative equilibrium")
    }));
}

#[test]
fn inactive_unrelated_charge_does_not_enter_the_reachable_common_grid() {
    let mut problem = racetrack_problem();
    let mut inactive = problem.current_modules[0].clone();
    let CurrentModuleIR::CurrentTransport {
        name, definition, ..
    } = &mut inactive
    else {
        panic!("expected current transport")
    };
    *name = "inactive-charge".into();
    let definition = definition.as_mut().expect("charge definition");
    definition.domain = vec![RegionRefIR {
        object_id: "unrelated-sphere".into(),
        region_id: None,
    }];
    definition.materials.truncate(1);
    definition.materials[0].region = definition.domain[0].clone();
    problem.current_modules.push(inactive);
    problem.geometry.entries.push(GeometryEntryIR::Sphere {
        name: "unrelated-sphere".into(),
        radius: 10.0e-9,
    });
    set_module_graph(
        &mut problem,
        json!([
            {
                "id": "charge", "kind": "current_transport", "applies_to": [],
                "solve_domain": [], "depends_on": [], "activation": "active"
            },
            {
                "id": "spin", "kind": "spin_transport", "applies_to": [],
                "solve_domain": [], "depends_on": ["charge"], "activation": "active"
            },
            {
                "id": "transport_torque", "kind": "spin_torque", "applies_to": [],
                "solve_domain": [], "depends_on": ["spin"], "activation": "active"
            },
            {
                "id": "inactive-charge", "kind": "current_transport", "applies_to": [],
                "solve_domain": [], "depends_on": [], "activation": "inactive"
            }
        ]),
    );

    let plan = fdm_plan(&problem);
    assert_eq!(plan.grid.cells, [256, 64, 4]);
    assert_eq!(
        plan.grid_certificate.as_ref().unwrap().object_ids,
        vec!["fm".to_string(), "hm".to_string()]
    );
}

#[test]
fn two_active_spin_sources_are_both_coupled_and_not_dropped_as_standalone_charge() {
    let mut problem = racetrack_problem();
    let mut charge_two = problem.current_modules[0].clone();
    let CurrentModuleIR::CurrentTransport { name, .. } = &mut charge_two else {
        panic!("expected current transport")
    };
    *name = "charge-two".into();
    problem.current_modules.push(charge_two);

    let mut spin_two = problem.spin_transport_modules[0].clone();
    spin_two.id = "spin-two".into();
    spin_two.current_source_id = "charge-two".into();
    spin_two.interfaces.clear();
    for assignment in &mut spin_two.materials {
        assignment.material.lambda_j_m =
            fullmag_ir::ReactionLengthIR::Disabled(fullmag_ir::DisabledReactionIR::Disabled);
        assignment.material.lambda_phi_m =
            fullmag_ir::ReactionLengthIR::Disabled(fullmag_ir::DisabledReactionIR::Disabled);
    }
    problem.spin_transport_modules.push(spin_two);

    let plan = fdm_plan(&problem);
    assert_eq!(plan.spin_transport_plans.len(), 2);
    assert!(plan.fdm_gpu_charge_transports.is_empty());
}

#[test]
fn standalone_region_scoped_fdm_gpu_charge_uses_the_legacy_region_lut_without_spin() {
    let mut problem = racetrack_problem();
    problem.spin_transport_modules.clear();
    problem.spin_torque_modules.clear();
    problem
        .geometry
        .entries
        .retain(|entry| entry.name() == "fm");
    problem.object_regions = vec![ObjectRegionIR {
        region_id: "fm:charge".into(),
        owner_object: "fm".into(),
        name: "charge".into(),
        shape: RegionShapeIR::Box {
            size: [512.0e-9, 128.0e-9, 1.0e-9],
            center: [0.0, 0.0, 0.0],
        },
        frame: RegionFrameIR::Object,
        enabled: true,
        priority: 0,
        mesh_policy: None,
        material_overrides: Vec::new(),
        texture_override: None,
        realization_policy: fullmag_ir::RegionRealizationPolicyIR::Inherit,
        material_transition: None,
    }];
    let region = RegionRefIR {
        object_id: "fm".into(),
        region_id: Some("fm:charge".into()),
    };
    let CurrentModuleIR::CurrentTransport { definition, .. } = &mut problem.current_modules[0]
    else {
        panic!("expected current transport")
    };
    let definition = definition.as_mut().expect("charge definition");
    definition.gauge = fullmag_ir::ChargePotentialGaugeIR::DirichletReference;
    definition.domain = vec![region.clone()];
    definition.materials.truncate(1);
    definition.materials[0].region = region;
    definition.boundaries = vec![
        ChargeBoundaryIR::VoltageElectrode {
            id: "left".into(),
            surfaces: vec![surface("fm", "x-", [-1.0, 0.0, 0.0])],
            potential_v: 0.0,
        },
        ChargeBoundaryIR::VoltageElectrode {
            id: "right".into(),
            surfaces: vec![surface("fm", "x+", [1.0, 0.0, 0.0])],
            potential_v: 0.1,
        },
        ChargeBoundaryIR::Insulating {
            id: "walls".into(),
            surfaces: vec![
                surface("fm", "y-", [0.0, -1.0, 0.0]),
                surface("fm", "y+", [0.0, 1.0, 0.0]),
                surface("fm", "z-", [0.0, 0.0, -1.0]),
                surface("fm", "z+", [0.0, 0.0, 1.0]),
            ],
        },
    ];
    problem.problem_meta.runtime_metadata.insert(
        "runtime_selection".into(),
        json!({"device": "cuda", "device_index": 0}),
    );

    let plan = fdm_plan(&problem);
    assert_eq!(plan.spin_transport_plans.len(), 0);
    assert_eq!(plan.fdm_gpu_charge_transports.len(), 1);
    assert!(plan.fdm_gpu_charge_transports[0]
        .charge_active_cells
        .iter()
        .all(|active| *active));
}

#[test]
fn magnet_alias_collision_with_a_different_geometry_fails_closed() {
    let mut problem = racetrack_problem();
    let magnetic = problem
        .geometry
        .entries
        .iter_mut()
        .find(|entry| entry.name() == "fm")
        .expect("FM geometry");
    match magnetic {
        GeometryEntryIR::Translate { name, .. } => *name = "fm-body".into(),
        other => panic!("expected translated FM geometry, got {other:?}"),
    }
    problem.regions[0].geometry = "fm-body".into();
    problem.geometry.entries.push(GeometryEntryIR::Box {
        name: "fm".into(),
        size: [1.0e-9; 3],
    });

    let error = fullmag_plan::plan(&problem).expect_err("ambiguous magnet alias must fail");
    assert!(
        error.reasons.iter().any(|reason| {
            reason.contains("ambiguous FDM object-to-geometry mapping")
                && reason.contains("fm")
                && reason.contains("fm-body")
        }),
        "unexpected errors: {:?}",
        error.reasons
    );
}

#[test]
fn magnet_alias_without_a_direct_geometry_id_resolves_to_its_region_geometry() {
    let mut problem = racetrack_problem();
    let magnetic = problem
        .geometry
        .entries
        .iter_mut()
        .find(|entry| entry.name() == "fm")
        .expect("FM geometry");
    match magnetic {
        GeometryEntryIR::Translate { name, .. } => *name = "fm-body".into(),
        other => panic!("expected translated FM geometry, got {other:?}"),
    }
    problem.regions[0].geometry = "fm-body".into();

    let plan = fdm_plan(&problem);
    assert_eq!(plan.grid.cells, [256, 64, 4]);
    assert_eq!(
        plan.grid_certificate.as_ref().unwrap().object_ids,
        vec!["fm".to_string(), "hm".to_string()]
    );
}

#[test]
fn sampled_field_must_match_the_expanded_common_grid_exactly() {
    let mut wrong = racetrack_problem();
    wrong.magnets[0].initial_magnetization = Some(InitialMagnetizationIR::SampledField {
        values: vec![[1.0, 0.0, 0.0]; 256 * 64],
    });
    let error = fullmag_plan::plan(&wrong)
        .expect_err("magnet-only sampled field must not be padded onto the common grid");
    assert!(
        error.reasons.iter().any(|reason| {
            reason.contains("sampled field length mismatch")
                && reason.contains("expected 65536")
                && reason.contains("actual 16384")
        }),
        "unexpected errors: {:?}",
        error.reasons
    );

    let mut exact = racetrack_problem();
    exact.magnets[0].initial_magnetization = Some(InitialMagnetizationIR::SampledField {
        values: vec![[1.0, 0.0, 0.0]; 256 * 64 * 4],
    });
    let plan = fdm_plan(&exact);
    assert_eq!(plan.initial_magnetization.len(), 65_536);
}
