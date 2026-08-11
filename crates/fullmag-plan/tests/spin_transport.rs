use fullmag_ir::{
    BackendPlanIR, CurrentModuleIR, ExecutionDevice, ProblemIR, SpinTransportModuleIR,
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
