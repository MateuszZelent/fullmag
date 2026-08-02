use super::*;
use fullmag_ir::{
    AirBoxConfigIR, ExchangeBoundaryCondition, ExecutionPrecision, FemMeshPartIR, FemMeshPartRole,
    FemMeshPartSelector, FemObjectSegmentIR, FemPlanIR, IntegratorChoice, MaterialIR, MeshIR,
    RelaxationAlgorithmIR, RelaxationControlIR,
};

fn make_test_plan(enable_demag: bool) -> FemPlanIR {
    FemPlanIR {
        mesh_name: "unit_tet".to_string(),
        mesh_source: Some("meshes/unit_tet.msh".to_string()),
        mesh: MeshIR {
            mesh_name: "unit_tet".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
            element_markers: vec![1],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
            boundary_markers: vec![1],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
        },
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        mesh_build_report: None,
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 1.0,
        initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
        material: MaterialIR {
            name: "Py".to_string(),
            saturation_magnetisation: 800e3,
            exchange_stiffness: 13e-12,
            damping: 0.5,
            uniaxial_anisotropy: None,
            anisotropy_axis: None,
            uniaxial_anisotropy_k2: None,
            cubic_anisotropy_kc1: None,
            cubic_anisotropy_kc2: None,
            cubic_anisotropy_kc3: None,
            cubic_anisotropy_axis1: None,
            cubic_anisotropy_axis2: None,
            ms_field: None,
            a_field: None,
            alpha_field: None,
            ku_field: None,
            ku2_field: None,
            kc1_field: None,
            kc2_field: None,
            kc3_field: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            dind_field: None,
            dbulk_field: None,
        },
        region_materials: Vec::new(),
        enable_exchange: true,
        enable_demag,
        external_field: None,
        current_modules: vec![],
        spin_transport_plans: vec![],
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator: IntegratorChoice::Heun,
        fixed_timestep: Some(1e-13),
        adaptive_timestep: None,
        field_refresh: None,
        relaxation: None,
        demag_realization: None,
        air_box_config: None,
        interfacial_dmi: None,
        bulk_dmi: None,
        dind_field: None,
        dbulk_field: None,
        temperature: None,
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
        magnetoelastic: None,
        mechanics: None,
        demag_solver_policy: None,
        thermal_seed_config: None,
        oersted_realization: None,
        gpu_device_index: None,
        mfem_device_string: None,
        dmi_interface_normal: None,
        use_consistent_mass: None,
    }
}

fn add_periodic_pair(plan: &mut FemPlanIR) {
    plan.mesh.periodic_boundary_pairs = vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
        pair_id: "x_periodic".to_string(),
        source_marker: None,
        destination_marker: None,
        marker_a: 1,
        marker_b: 1,
        translation: Some([1.0, 0.0, 0.0]),
        tolerance: Some(1e-12),
        axis_hint: None,
        orientation: None,
        pairing_policy: None,
    }];
    plan.mesh.periodic_node_pairs = vec![fullmag_ir::MeshPeriodicNodePairIR {
        pair_id: "x_periodic".to_string(),
        node_a: 0,
        node_b: 1,
    }];
}

#[test]
fn reference_runner_accepts_exchange_only_static_periodic_mesh_pairs() {
    let mut plan = make_test_plan(false);
    plan.initial_magnetization[1] = [0.0, 1.0, 0.0];
    add_periodic_pair(&mut plan);

    let (_problem, state) =
        build_problem_and_state(&plan).expect("exchange-only static PBC should build");
    assert_eq!(state.magnetization()[0], state.magnetization()[1]);
}

#[test]
fn reference_runner_rejects_periodic_demag_mesh_pairs() {
    let mut plan = make_test_plan(true);
    add_periodic_pair(&mut plan);

    let err = build_problem_and_state(&plan)
        .expect_err("reference FEM runner must reject unreduced periodic demag");
    assert!(
        err.message.contains("periodic_node_pairs")
            && err.message.contains("demag/DMI/per-node drive terms"),
        "unexpected error: {}",
        err.message
    );
}

fn make_box_demag_plan() -> FemPlanIR {
    FemPlanIR {
        mesh_name: "box_40x20x10_coarse".to_string(),
        mesh_source: Some("examples/assets/box_40x20x10_coarse.mesh.json".to_string()),
        mesh: MeshIR {
            mesh_name: "box_40x20x10_coarse".to_string(),
            nodes: vec![
                [-20e-9, -10e-9, -5e-9],
                [20e-9, -10e-9, -5e-9],
                [20e-9, 10e-9, -5e-9],
                [-20e-9, 10e-9, -5e-9],
                [-20e-9, -10e-9, 5e-9],
                [20e-9, -10e-9, 5e-9],
                [20e-9, 10e-9, 5e-9],
                [-20e-9, 10e-9, 5e-9],
            ],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![
                [0, 1, 2, 6],
                [0, 2, 3, 6],
                [0, 3, 7, 6],
                [0, 7, 4, 6],
                [0, 4, 5, 6],
                [0, 5, 1, 6],
            ]),
            element_markers: vec![1; 6],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![
                [0, 1, 2],
                [0, 1, 5],
                [1, 2, 6],
                [0, 2, 3],
                [2, 3, 6],
                [0, 3, 7],
                [3, 6, 7],
                [0, 4, 7],
                [4, 6, 7],
                [0, 4, 5],
                [4, 5, 6],
                [1, 5, 6],
            ]),
            boundary_markers: vec![1; 12],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
        },
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        mesh_build_report: None,
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 10e-9,
        initial_magnetization: vec![[0.0, 0.0, 1.0]; 8],
        material: MaterialIR {
            name: "Py".to_string(),
            saturation_magnetisation: 800e3,
            exchange_stiffness: 13e-12,
            damping: 0.5,
            uniaxial_anisotropy: None,
            anisotropy_axis: None,
            uniaxial_anisotropy_k2: None,
            cubic_anisotropy_kc1: None,
            cubic_anisotropy_kc2: None,
            cubic_anisotropy_kc3: None,
            cubic_anisotropy_axis1: None,
            cubic_anisotropy_axis2: None,
            ms_field: None,
            a_field: None,
            alpha_field: None,
            ku_field: None,
            ku2_field: None,
            kc1_field: None,
            kc2_field: None,
            kc3_field: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            dind_field: None,
            dbulk_field: None,
        },
        region_materials: Vec::new(),
        enable_exchange: true,
        enable_demag: true,
        external_field: None,
        current_modules: vec![],
        spin_transport_plans: vec![],
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator: IntegratorChoice::Heun,
        fixed_timestep: Some(1e-13),
        adaptive_timestep: None,
        field_refresh: None,
        relaxation: None,
        demag_realization: None,
        air_box_config: None,
        interfacial_dmi: None,
        bulk_dmi: None,
        dind_field: None,
        dbulk_field: None,
        temperature: None,
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
        magnetoelastic: None,
        mechanics: None,
        demag_solver_policy: None,
        thermal_seed_config: None,
        oersted_realization: None,
        gpu_device_index: None,
        mfem_device_string: None,
        dmi_interface_normal: None,
        use_consistent_mass: None,
    }
}

fn structured_node_index(i: usize, j: usize, k: usize, divisions: usize) -> usize {
    let stride = divisions + 1;
    k * stride * stride + j * stride + i
}

fn collect_boundary_faces(elements: &[[u32; 4]]) -> Vec<[u32; 3]> {
    let mut counts = std::collections::BTreeMap::<[u32; 3], usize>::new();
    for element in elements {
        let [a, b, c, d] = *element;
        for mut face in [[a, b, c], [a, b, d], [a, c, d], [b, c, d]] {
            face.sort_unstable();
            *counts.entry(face).or_default() += 1;
        }
    }
    counts
        .into_iter()
        .filter_map(|(face, count)| (count == 1).then_some(face))
        .collect()
}

fn build_structured_shared_domain_airbox_mesh() -> MeshIR {
    let box_size_m = [6.0, 6.0, 6.0];
    let divisions = 3usize;
    let dx = box_size_m[0] / divisions as f64;
    let dy = box_size_m[1] / divisions as f64;
    let dz = box_size_m[2] / divisions as f64;

    let mut nodes = Vec::with_capacity((divisions + 1).pow(3));
    for k in 0..=divisions {
        let z = -0.5 * box_size_m[2] + k as f64 * dz;
        for j in 0..=divisions {
            let y = -0.5 * box_size_m[1] + j as f64 * dy;
            for i in 0..=divisions {
                let x = -0.5 * box_size_m[0] + i as f64 * dx;
                nodes.push([x, y, z]);
            }
        }
    }

    let mut elements = Vec::with_capacity(divisions * divisions * divisions * 6);
    for k in 0..divisions {
        for j in 0..divisions {
            for i in 0..divisions {
                let n0 = structured_node_index(i, j, k, divisions) as u32;
                let n1 = structured_node_index(i + 1, j, k, divisions) as u32;
                let n2 = structured_node_index(i + 1, j + 1, k, divisions) as u32;
                let n3 = structured_node_index(i, j + 1, k, divisions) as u32;
                let n4 = structured_node_index(i, j, k + 1, divisions) as u32;
                let n5 = structured_node_index(i + 1, j, k + 1, divisions) as u32;
                let n6 = structured_node_index(i + 1, j + 1, k + 1, divisions) as u32;
                let n7 = structured_node_index(i, j + 1, k + 1, divisions) as u32;
                elements.extend_from_slice(&[
                    [n0, n1, n2, n6],
                    [n0, n2, n3, n6],
                    [n0, n3, n7, n6],
                    [n0, n7, n4, n6],
                    [n0, n4, n5, n6],
                    [n0, n5, n1, n6],
                ]);
            }
        }
    }

    let mut element_markers = vec![0u32; elements.len()];
    for (element_index, element) in elements.iter().enumerate() {
        let centroid = element.iter().fold([0.0; 3], |acc, node| {
            let coord = nodes[*node as usize];
            [acc[0] + coord[0], acc[1] + coord[1], acc[2] + coord[2]]
        });
        let centroid = [centroid[0] * 0.25, centroid[1] * 0.25, centroid[2] * 0.25];
        if centroid[0] < -1.0 && centroid[1] < -1.0 && centroid[2] < -1.0 {
            element_markers[element_index] = 1;
        }
    }

    let boundary_faces = collect_boundary_faces(&elements);
    let boundary_markers = vec![99u32; boundary_faces.len()];
    MeshIR {
        mesh_name: "shared_domain_airbox_structured".to_string(),
        nodes,
        elements,
        element_markers,
        boundary_faces,
        boundary_markers,
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    }
}

fn make_shared_domain_airbox_demag_plan() -> FemPlanIR {
    let mesh = build_structured_shared_domain_airbox_mesh();
    FemPlanIR {
        mesh_name: mesh.mesh_name.clone(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir,
        domain_frame: None,
        fe_order: 1,
        hmax: 10e-9,
        initial_magnetization: vec![[0.0, 0.0, 1.0]; 64],
        material: MaterialIR {
            name: "Py".to_string(),
            saturation_magnetisation: 800e3,
            exchange_stiffness: 13e-12,
            damping: 0.5,
            uniaxial_anisotropy: None,
            anisotropy_axis: None,
            uniaxial_anisotropy_k2: None,
            cubic_anisotropy_kc1: None,
            cubic_anisotropy_kc2: None,
            cubic_anisotropy_kc3: None,
            cubic_anisotropy_axis1: None,
            cubic_anisotropy_axis2: None,
            ms_field: None,
            a_field: None,
            alpha_field: None,
            ku_field: None,
            ku2_field: None,
            kc1_field: None,
            kc2_field: None,
            kc3_field: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            dind_field: None,
            dbulk_field: None,
        },
        region_materials: Vec::new(),
        enable_exchange: true,
        enable_demag: true,
        external_field: None,
        current_modules: vec![],
        spin_transport_plans: vec![],
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator: IntegratorChoice::Heun,
        fixed_timestep: Some(1e-13),
        adaptive_timestep: None,
        field_refresh: None,
        relaxation: None,
        demag_realization: Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin),
        air_box_config: Some(AirBoxConfigIR {
            factor: 1.5,
            grading: 1.0,
            boundary_marker: 99,
            bc_kind: Some("dirichlet".to_string()),
            robin_beta_mode: None,
            robin_beta_factor: None,
            shape: Some("bbox".to_string()),
            factor_source: None,
            boundary_marker_source: None,
        }),
        interfacial_dmi: None,
        bulk_dmi: None,
        dind_field: None,
        dbulk_field: None,
        temperature: None,
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
        magnetoelastic: None,
        mechanics: None,
        demag_solver_policy: None,
        thermal_seed_config: None,
        oersted_realization: None,
        gpu_device_index: None,
        mfem_device_string: None,
        dmi_interface_normal: None,
        use_consistent_mass: None,
    }
}

#[test]
fn uniform_fem_relaxation_produces_near_zero_exchange_energy() {
    let plan = make_test_plan(false);
    let result =
        execute_reference_fem(&plan, 1e-12, &[], None, None).expect("FEM run should succeed");
    assert_eq!(result.result.status, RunStatus::Completed);
    assert!(!result.result.steps.is_empty());
    for step in &result.result.steps {
        assert!(
            step.e_ex.abs() < 1e-24,
            "uniform FEM state should have near-zero exchange energy"
        );
    }
}

#[test]
fn demag_outputs_are_nonzero_when_enabled() {
    let plan = make_box_demag_plan();
    let result =
        execute_reference_fem(&plan, 1e-12, &[], None, None).expect("FEM demag run should succeed");
    assert_eq!(result.result.status, RunStatus::Completed);
    let last = result.result.steps.last().expect("at least one step");
    assert!(last.e_demag >= 0.0);
    assert!(last.max_h_demag > 0.0);
}

#[test]
fn dmi_terms_are_supported_in_fem_baseline() {
    let mut plan = make_test_plan(false);
    plan.interfacial_dmi = Some(3e-3);
    plan.bulk_dmi = Some(2e-3);
    plan.dmi_interface_normal = Some([1.0, 0.0, 0.0]);
    plan.initial_magnetization = vec![
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [1.0, 0.0, 0.0],
    ];

    let result =
        execute_reference_fem(&plan, 1e-12, &[], None, None).expect("FEM DMI run should succeed");
    assert_eq!(result.result.status, RunStatus::Completed);
    let last = result.result.steps.last().expect("at least one step");
    assert!(
        last.max_h_eff > 1e-6,
        "DMI terms should contribute to H_eff, got {}",
        last.max_h_eff
    );
}

#[test]
fn fem_snapshot_vector_cache_contains_nonzero_demag_related_fields() {
    let plan = make_box_demag_plan();
    let fields = snapshot_vector_fields(
        &plan,
        &["H_ex", "H_demag", "H_eff"],
        &crate::LivePreviewRequest::default(),
    )
    .expect("FEM preview cache snapshot should succeed");

    assert_eq!(fields.len(), 3);
    let h_demag = fields
        .iter()
        .find(|field| field.quantity == "H_demag")
        .expect("H_demag preview should be present");
    let h_eff = fields
        .iter()
        .find(|field| field.quantity == "H_eff")
        .expect("H_eff preview should be present");
    assert_eq!(h_demag.spatial_kind, "mesh");
    assert_eq!(h_eff.spatial_kind, "mesh");
    assert!(
        h_demag
            .vector_field_values
            .iter()
            .any(|value| value.abs() > 0.0),
        "expected FEM cached H_demag preview to contain nonzero values"
    );
    assert!(
        h_eff
            .vector_field_values
            .iter()
            .any(|value| value.abs() > 0.0),
        "expected FEM cached H_eff preview to contain nonzero values"
    );
}

#[test]
fn fem_airbox_plan_uses_airbox_demag_operator_in_reference_runner() {
    let plan = make_shared_domain_airbox_demag_plan();
    let (_problem, _state) = build_problem_and_state(&plan)
        .expect("shared-domain FEM airbox problem should build in reference runner");
    let provenance = execution_provenance(&plan).unwrap();

    assert_eq!(
        provenance.demag_operator_kind.as_deref(),
        Some("fem_poisson_robin"),
    );

    let fields = snapshot_vector_fields(&plan, &["H_demag"], &crate::LivePreviewRequest::default())
        .expect("shared-domain FEM demag preview should succeed");
    let h_demag = fields
        .iter()
        .find(|field| field.quantity == "H_demag")
        .expect("H_demag preview should be present");
    assert_eq!(h_demag.quantity_domain, "full_domain");
    assert_eq!(h_demag.vector_field_values.len(), plan.mesh.nodes.len() * 3);
}

#[test]
fn baseline_provenance_defaults_implicit_demag_to_fem_poisson() {
    let plan = make_test_plan(true);
    let provenance = execution_provenance(&plan).unwrap();

    assert_eq!(provenance.execution_engine, "fem_cpu_baseline_internal");
    assert_eq!(provenance.requested_demag_realization, None);
    assert_eq!(
        provenance.resolved_demag_realization.as_deref(),
        Some("fem_poisson")
    );
    assert_eq!(
        provenance.demag_operator_kind.as_deref(),
        Some("fem_poisson")
    );
}

#[test]
fn fem_per_object_scalars_uses_mesh_part_node_indices_for_shared_nodes() {
    let segment = FemObjectSegmentIR {
        object_id: "body".to_string(),
        geometry_id: Some("body".to_string()),
        node_start: 0,
        node_count: 3,
        element_start: 0,
        element_count: 1,
        boundary_face_start: 0,
        boundary_face_count: 1,
    };
    let mesh_part = FemMeshPartIR {
        id: "body".to_string(),
        label: "body".to_string(),
        role: FemMeshPartRole::MagneticObject,
        object_id: Some("body".to_string()),
        geometry_id: Some("body".to_string()),
        material_id: None,
        element_selector: FemMeshPartSelector::ElementRange { start: 0, count: 1 },
        boundary_face_selector: FemMeshPartSelector::BoundaryFaceRange { start: 0, count: 1 },
        node_selector: FemMeshPartSelector::NodeRange { start: 0, count: 3 },
        boundary_face_indices: Vec::new(),
        node_indices: vec![1, 3, 5],
        facet_global_ordinals: Vec::new(),
        bounds_min: None,
        bounds_max: None,
        parent_id: None,
    };
    let stats = StepStats {
        e_total: 100.0,
        ..StepStats::default()
    };
    let magnetization = vec![
        [10.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [20.0, 0.0, 0.0],
        [3.0, 0.0, 0.0],
        [30.0, 0.0, 0.0],
        [5.0, 0.0, 0.0],
    ];

    let per_object = fem_per_object_scalars(&[segment], &[mesh_part], &magnetization, &stats);

    assert_eq!(per_object["body"]["mx"], 3.0);
}

#[test]
fn fem_callback_emits_live_updates() {
    let plan = make_test_plan(true);
    let mut seen = 0usize;
    let mut on_step = |update: StepUpdate| -> StepAction {
        seen += 1;
        assert_eq!(update.grid, [0, 0, 0]);
        StepAction::Continue
    };
    let result = execute_reference_fem(
        &plan,
        5e-13,
        &[],
        Some(LiveStepConsumer {
            grid: [0, 0, 0],
            field_every_n: 2,
            initial_snapshot: false,
            display_selection: None,
            interrupt_requested: None,
            on_step: &mut on_step,
        }),
        None,
    )
    .expect("callback FEM run should succeed");

    assert_eq!(result.result.status, RunStatus::Completed);
    assert!(seen > 0, "expected at least one live FEM callback update");
}

#[test]
fn llg_overdamped_relaxation_stops_before_time_limit_on_uniform_fem_state() {
    let plan = FemPlanIR {
        relaxation: Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::LlgOverdamped,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-6),
                energy_tolerance_j: None,
                max_steps: Some(1000),
                max_pseudotime_s: None,
                max_physical_time_s: None,
            },
        }),
        ..make_test_plan(false)
    };

    let executed = execute_reference_fem(&plan, 1e-9, &[], None, None)
        .expect("FEM relaxation run should succeed");

    assert!(executed.result.steps.len() <= 2);
    let final_time = executed.result.steps.last().expect("final stats").time;
    assert!(
        final_time < 1e-9,
        "FEM relaxation should stop early, got final_time={final_time}"
    );
}
