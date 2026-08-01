use super::*;

#[test]
fn native_fem_disables_precession_for_llg_overdamped_relaxation() {
    let mut plan = make_test_plan();
    assert!(native_fem_precession_enabled(&plan));

    plan.relaxation = Some(RelaxationControlIR {
        algorithm: RelaxationAlgorithmIR::LlgOverdamped,
        stop: RelaxStopIR {
            torque_tolerance_apm: None,
            energy_tolerance_j: None,
            max_steps: None,
            max_pseudotime_s: None,
            max_physical_time_s: None,
        },
    });
    assert!(!native_fem_precession_enabled(&plan));

    plan.relaxation = Some(RelaxationControlIR {
        algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
        stop: RelaxStopIR {
            torque_tolerance_apm: None,
            energy_tolerance_j: None,
            max_steps: None,
            max_pseudotime_s: None,
            max_physical_time_s: None,
        },
    });
    assert!(native_fem_precession_enabled(&plan));
}

#[test]
fn native_fem_ffi_plan_carries_precession_mode() {
    let source = include_str!("../../native_fem.rs");
    let plan_desc_start = source
        .find("let mut plan_desc = ffi::fullmag_fem_plan_desc")
        .expect("native FEM FFI plan desc literal");
    let plan_desc_body = &source[plan_desc_start..];
    let plan_desc_end = plan_desc_body
        .find("        // Build adaptive config if present")
        .expect("native FEM FFI plan desc end");
    let plan_desc_body = &plan_desc_body[..plan_desc_end];
    assert!(
        plan_desc_body.contains("has_precession_enabled: 1"),
        "native FEM FFI plan must explicitly set the precession mode field"
    );
    assert!(
        plan_desc_body.contains("precession_enabled: if native_fem_precession_enabled(plan)"),
        "native FEM FFI plan must lower llg_overdamped into the native precession flag"
    );
}

#[test]
fn native_fem_accepts_periodic_dmi_pairs_in_native_context() {
    let mut plan = make_test_plan();
    plan.interfacial_dmi = Some(1.0e-3);
    plan.mesh.periodic_boundary_pairs = vec![MeshPeriodicBoundaryPairIR {
        pair_id: "x_periodic".to_string(),
        source_marker: Some("x_min".to_string()),
        destination_marker: Some("x_max".to_string()),
        marker_a: 1,
        marker_b: 2,
        translation: Some([1.0, 0.0, 0.0]),
        tolerance: Some(1e-12),
        axis_hint: Some("x".to_string()),
        orientation: None,
        pairing_policy: None,
    }];
    plan.mesh.periodic_node_pairs = vec![MeshPeriodicNodePairIR {
        pair_id: "x_periodic".to_string(),
        node_a: 0,
        node_b: 1,
    }];

    if let Err(err) = NativeFemBackend::create(&plan) {
        if !is_gpu_available() && (err.message.contains("MFEM") || err.message.contains("scaffold"))
        {
            return;
        }
        panic!(
            "native FEM time-domain should accept periodic DMI pairs with class projection: {}",
            err.message
        );
    }
}

#[test]
fn native_fem_cpu_dmi_step_exposes_fields_and_energy_when_mfem_stack_is_available() {
    let mut plan = make_test_plan();
    plan.mfem_device_string = Some("cpu".to_string());
    plan.initial_magnetization = vec![
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [0.5773502691896258, 0.5773502691896258, 0.5773502691896258],
    ];
    plan.interfacial_dmi = Some(1.0e-3);
    plan.dmi_interface_normal = Some([0.0, 0.0, 1.0]);
    plan.bulk_dmi = Some(2.0e-3);

    let mut backend = match NativeFemBackend::create(&plan) {
        Ok(backend) => backend,
        Err(err) => {
            if err.message.contains("MFEM") || err.message.contains("scaffold") {
                eprintln!("skipping native FEM CPU DMI runtime test: {}", err.message);
                return;
            }
            panic!("native FEM CPU DMI create: {}", err.message);
        }
    };

    let stats = backend.step(1e-13).expect("native FEM CPU DMI step");
    assert!(stats.e_dmi.is_finite(), "DMI energy must be finite");
    assert!(
        stats.e_dmi.abs() > 0.0,
        "non-uniform magnetization with active DMI should report non-zero DMI energy"
    );

    let h_dmi = backend
        .copy_h_dmi(plan.mesh.nodes.len())
        .expect("copy interfacial DMI field");
    let h_bulk_dmi = backend
        .copy_h_dmi_bulk(plan.mesh.nodes.len())
        .expect("copy bulk DMI field");
    assert!(
        h_dmi
            .iter()
            .flatten()
            .any(|component| component.abs() > 0.0),
        "active interfacial DMI should expose a non-zero H_dmi field"
    );
    assert!(
        h_bulk_dmi
            .iter()
            .flatten()
            .any(|component| component.abs() > 0.0),
        "active bulk DMI should expose a non-zero H_dmi_bulk field"
    );
}

#[test]
fn native_fem_gpu_dmi_step_exposes_fields_and_energy_when_cuda_is_available() {
    if !is_gpu_available() {
        eprintln!("skipping native FEM GPU DMI runtime test: CUDA/MFEM GPU runtime unavailable");
        return;
    }

    let mut plan = make_test_plan();
    plan.mfem_device_string = Some("cuda".to_string());
    plan.initial_magnetization = vec![
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [0.5773502691896258, 0.5773502691896258, 0.5773502691896258],
    ];
    plan.interfacial_dmi = Some(1.0e-3);
    plan.dmi_interface_normal = Some([0.0, 0.0, 1.0]);
    plan.bulk_dmi = Some(2.0e-3);

    let mut backend = NativeFemBackend::create(&plan).expect("native FEM GPU DMI create");
    let stats = backend.step(1e-13).expect("native FEM GPU DMI step");
    assert!(stats.e_dmi.is_finite(), "GPU DMI energy must be finite");
    assert!(
        stats.e_dmi.abs() > 0.0,
        "non-uniform magnetization with active GPU DMI should report non-zero DMI energy"
    );

    let h_dmi = backend
        .copy_h_dmi(plan.mesh.nodes.len())
        .expect("copy GPU interfacial DMI field");
    let h_bulk_dmi = backend
        .copy_h_dmi_bulk(plan.mesh.nodes.len())
        .expect("copy GPU bulk DMI field");
    assert!(
        h_dmi
            .iter()
            .flatten()
            .any(|component| component.abs() > 0.0),
        "active GPU interfacial DMI should expose a non-zero H_dmi field"
    );
    assert!(
        h_bulk_dmi
            .iter()
            .flatten()
            .any(|component| component.abs() > 0.0),
        "active GPU bulk DMI should expose a non-zero H_dmi_bulk field"
    );
}

#[test]
fn native_fem_rejects_periodic_incompatible_per_node_material_class() {
    let mut plan = make_test_plan();
    plan.mesh.periodic_boundary_pairs = vec![MeshPeriodicBoundaryPairIR {
        pair_id: "x_periodic".to_string(),
        source_marker: Some("x_min".to_string()),
        destination_marker: Some("x_max".to_string()),
        marker_a: 1,
        marker_b: 2,
        translation: Some([1.0, 0.0, 0.0]),
        tolerance: Some(1e-12),
        axis_hint: Some("x".to_string()),
        orientation: None,
        pairing_policy: None,
    }];
    plan.mesh.periodic_node_pairs = vec![MeshPeriodicNodePairIR {
        pair_id: "x_periodic".to_string(),
        node_a: 0,
        node_b: 1,
    }];
    plan.material.ms_field = Some(vec![800e3, 700e3, 800e3, 800e3]);

    let err = match NativeFemBackend::create(&plan) {
        Ok(_) => panic!("native FEM must reject incompatible periodic material classes"),
        Err(err) => err,
    };
    assert!(
        err.message.contains("Ms_field") && err.message.contains("periodic node class"),
        "unexpected material-class rejection message: {}",
        err.message
    );
}

#[test]
fn native_fem_accepts_fredkin_koehler_demag_at_runner_boundary() {
    let mut plan = make_test_plan();
    plan.enable_exchange = false;
    plan.enable_demag = true;
    plan.mfem_device_string = Some("cpu".to_string());
    plan.demag_realization = Some(fullmag_ir::ResolvedFemDemagIR::FredkinKoehler);
    plan.air_box_config = None;
    plan.domain_mesh_mode = fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh;
    plan.mesh
        .set_tri3_facets(vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]]);
    plan.mesh.boundary_markers = vec![1, 1, 1, 1];

    if let Err(err) = NativeFemBackend::create_with_initial_effective_field(&plan, false) {
        assert!(
            !err.message.contains("not yet implemented")
                && !err.message.contains("air-box demag requires"),
            "runner must route Fredkin-Koehler demag to the native FEM/BEM backend, got: {}",
            err.message
        );
        if !is_gpu_available() && (err.message.contains("MFEM") || err.message.contains("scaffold"))
        {
            return;
        }
        panic!(
            "unexpected native FEM Fredkin-Koehler create error: {}",
            err.message
        );
    }
}

#[test]
fn gpu_state_info_maps_residency_and_allocation_from_ffi() {
    let info = NativeFemGpuStateInfo::from_ffi(ffi::fullmag_fem_gpu_state_info {
        allocated: 1,
        node_count: 4,
        dof_len: 12,
        stage_count: 2,
        device_bytes: 8192,
        reduction_workspace_bytes: 64,
        source_of_truth:
            ffi::fullmag_fem_data_residency::FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH,
    });

    assert!(info.allocated);
    assert_eq!(info.node_count, 4);
    assert_eq!(info.dof_len, 12);
    assert_eq!(info.stage_count, 2);
    assert_eq!(info.device_bytes, 8192);
    assert_eq!(info.reduction_workspace_bytes, 64);
    assert_eq!(info.source_of_truth.as_str(), "device_source_of_truth");
}

#[test]
fn gpu_rk_plan_info_maps_exchange_only_gate_from_ffi() {
    let mut reason = [0; 256];
    let raw = b"requires CUDA\0";
    for (dst, src) in reason.iter_mut().zip(raw.iter().copied()) {
        *dst = src as std::os::raw::c_char;
    }
    let mut exchange_operator_mode = [0; 64];
    let raw_mode = b"unsupported\0";
    for (dst, src) in exchange_operator_mode
        .iter_mut()
        .zip(raw_mode.iter().copied())
    {
        *dst = src as std::os::raw::c_char;
    }
    let mut demag_operator_mode = [0; 64];
    let raw_demag = b"device_hypre_poisson\0";
    for (dst, src) in demag_operator_mode
        .iter_mut()
        .zip(raw_demag.iter().copied())
    {
        *dst = src as std::os::raw::c_char;
    }
    let mut hypre_execution_policy = [0; 32];
    let raw_policy = b"device\0";
    for (dst, src) in hypre_execution_policy
        .iter_mut()
        .zip(raw_policy.iter().copied())
    {
        *dst = src as std::os::raw::c_char;
    }
    let mut demag_residency = [0; 32];
    let raw_residency = b"device\0";
    for (dst, src) in demag_residency
        .iter_mut()
        .zip(raw_residency.iter().copied())
    {
        *dst = src as std::os::raw::c_char;
    }

    let info = NativeFemGpuRkPlanInfo::from_ffi(ffi::fullmag_fem_gpu_rk_plan_info {
        exchange_only_enabled: 1,
        stage_count: 4,
        uses_cuda_kernels: 1,
        allows_exchange_host_sync: 1,
        stage_exchange_device_resident: 0,
        uses_gpu_poisson: 1,
        exchange_operator_mode,
        demag_operator_mode,
        hypre_execution_policy,
        demag_residency,
        reason,
    });

    assert!(info.exchange_only_enabled);
    assert_eq!(info.stage_count, 4);
    assert!(info.uses_cuda_kernels);
    assert!(info.allows_exchange_host_sync);
    assert!(!info.stage_exchange_device_resident);
    assert!(info.uses_gpu_poisson);
    assert_eq!(info.exchange_operator_mode, "unsupported");
    assert_eq!(info.demag_operator_mode, "device_hypre_poisson");
    assert_eq!(info.hypre_execution_policy, "device");
    assert_eq!(info.demag_residency, "device");
    assert_eq!(info.reason, "requires CUDA");
}
