use super::*;

fn object_region(region_id: &str, name: &str) -> fullmag_ir::ObjectRegionIR {
    fullmag_ir::ObjectRegionIR {
        region_id: region_id.to_string(),
        owner_object: "strip".to_string(),
        name: name.to_string(),
        shape: fullmag_ir::RegionShapeIR::Box {
            size: [2.0, 2.0, 2.0],
            center: [0.0, 0.0, 0.0],
        },
        frame: fullmag_ir::RegionFrameIR::Object,
        enabled: true,
        priority: 10,
        mesh_policy: None,
        material_overrides: Vec::new(),
        texture_override: None,
        material_transition: None,
        realization_policy: fullmag_ir::RegionRealizationPolicyIR::Inherit,
    }
}

fn tet_mesh(name: &str, offset: [f64; 3]) -> fullmag_ir::MeshIR {
    let shift = |point: [f64; 3]| {
        [
            point[0] + offset[0],
            point[1] + offset[1],
            point[2] + offset[2],
        ]
    };
    fullmag_ir::MeshIR {
        mesh_name: name.to_string(),
        nodes: vec![
            shift([0.0, 0.0, 0.0]),
            shift([1.0, 0.0, 0.0]),
            shift([0.0, 1.0, 0.0]),
            shift([0.0, 0.0, 1.0]),
        ],
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
        element_markers: vec![1],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
        boundary_markers: vec![1],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    }
}

fn disconnected_tets_mesh() -> fullmag_ir::MeshIR {
    let mut nodes = Vec::new();
    for offset in [[0.0, 0.0, 0.0], [3.0, 0.0, 0.0], [6.0, 0.0, 0.0]] {
        nodes.extend([
            [offset[0], offset[1], offset[2]],
            [offset[0] + 1.0, offset[1], offset[2]],
            [offset[0], offset[1] + 1.0, offset[2]],
            [offset[0], offset[1], offset[2] + 1.0],
        ]);
    }
    fullmag_ir::MeshIR {
        mesh_name: "three-disconnected-regions".to_string(),
        nodes,
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![
            [0, 1, 2, 3],
            [4, 5, 6, 7],
            [8, 9, 10, 11],
        ]),
        element_markers: vec![1, 2, 3],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![
            [0, 1, 2],
            [4, 5, 6],
            [8, 9, 10],
        ]),
        boundary_markers: vec![10, 20, 30],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    }
}

fn touching_tets_mesh(
    element_markers: [u32; 2],
    include_material_interface: bool,
) -> fullmag_ir::MeshIR {
    let mut boundary_faces = vec![
        [3, 0, 1],
        [3, 1, 2],
        [3, 2, 0],
        [4, 0, 2],
        [4, 2, 1],
        [4, 1, 0],
    ];
    if include_material_interface {
        boundary_faces.insert(0, [0, 1, 2]);
    }
    let mut facets = fullmag_ir::FemFacetConnectivityIR::from_tri3(boundary_faces);
    let boundary_markers = if include_material_interface {
        facets.roles[0] = fullmag_ir::FemFacetRoleIR::MaterialInterface;
        vec![99, 10, 10, 10, 10, 10, 10]
    } else {
        vec![10; 6]
    };
    fullmag_ir::MeshIR {
        mesh_name: "touching-conformal-regions".to_string(),
        nodes: vec![
            [1e-9, 0.0, 0.0],
            [1e-9, 1e-9, 0.0],
            [1e-9, 0.0, 1e-9],
            [0.0, 0.0, 0.0],
            [2e-9, 0.0, 0.0],
        ],
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[3, 0, 1, 2], [4, 0, 2, 1]]),
        element_markers: element_markers.to_vec(),
        facets,
        boundary_markers,
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    }
}

fn distinct_owner_tets_mesh() -> fullmag_ir::MeshIR {
    fullmag_ir::MeshIR {
        mesh_name: "disjoint-magnetic-owners".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1e-9, 0.0, 0.0],
            [0.0, 1e-9, 0.0],
            [0.0, 0.0, 1e-9],
            [3e-9, 0.0, 0.0],
            [4e-9, 0.0, 0.0],
            [3e-9, 1e-9, 0.0],
            [3e-9, 0.0, 1e-9],
        ],
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
        element_markers: vec![1, 2],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![
            [0, 1, 2],
            [0, 1, 3],
            [0, 2, 3],
            [1, 2, 3],
            [4, 5, 6],
            [4, 5, 7],
            [4, 6, 7],
            [5, 6, 7],
        ]),
        boundary_markers: vec![1; 8],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    }
}

fn absorber_layer(
    frame: fullmag_ir::AbsorbingBoundaryFrameIR,
) -> fullmag_ir::AbsorbingBoundaryLayerIR {
    fullmag_ir::AbsorbingBoundaryLayerIR {
        total_width_m: 0.75e-9,
        ramp_width_m: 0.75e-9,
        max_damping: 0.4,
        faces: vec![fullmag_ir::AbsorbingBoundaryFaceIR::XPlus],
        profile: fullmag_ir::AbsorbingBoundaryProfileIR::Linear,
        frame,
    }
}

fn set_stable_fem_test_timestep(problem: &mut ProblemIR) {
    let fullmag_ir::StudyIR::TimeEvolution { dynamics, .. } = &mut problem.study else {
        panic!("absorber regression uses a time-evolution study");
    };
    let fullmag_ir::DynamicsIR::Llg { fixed_timestep, .. } = dynamics;
    *fixed_timestep = Some(1e-15);
}

fn conformal_absorber_problem(
    split_regions: bool,
    reverse_segments: bool,
    frame: fullmag_ir::AbsorbingBoundaryFrameIR,
) -> ProblemIR {
    let mut ir = fem_minimal_test_ir();
    ir.energy_terms = vec![fullmag_ir::EnergyTermIR::Exchange];
    ir.magnets[0].absorbing_boundary = Some(absorber_layer(frame));
    set_stable_fem_test_timestep(&mut ir);
    ir.problem_meta.runtime_metadata.remove("study_universe");

    let domain_asset = ir
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .expect("minimal fixture has a shared-domain asset");
    if split_regions {
        let mut left = object_region("strip:left", "left");
        left.realization_policy = fullmag_ir::RegionRealizationPolicyIR::Conformal;
        let mut right = object_region("strip:right", "right");
        right.realization_policy = fullmag_ir::RegionRealizationPolicyIR::Conformal;
        ir.object_regions.extend([left, right]);

        domain_asset.mesh = Some(touching_tets_mesh([2, 3], true));
        domain_asset.object_region_markers = vec![
            fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip:left".to_string(),
                marker: 2,
            },
            fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip:right".to_string(),
                marker: 3,
            },
        ];
        if reverse_segments {
            domain_asset.object_region_markers.reverse();
        }
    } else {
        domain_asset.mesh = Some(touching_tets_mesh([1, 1], false));
        domain_asset.object_region_markers.clear();
    }
    ir
}

fn distinct_owner_absorber_problem(
    frame: fullmag_ir::AbsorbingBoundaryFrameIR,
) -> ProblemIR {
    let mut ir = fem_minimal_test_ir();
    ir.energy_terms = vec![fullmag_ir::EnergyTermIR::Exchange];
    ir.magnets[0].absorbing_boundary = Some(absorber_layer(frame));
    set_stable_fem_test_timestep(&mut ir);
    ir.problem_meta.runtime_metadata.remove("study_universe");
    ir.geometry.entries.push(fullmag_ir::GeometryEntryIR::Box {
        name: "second".to_string(),
        size: [1.0, 1.0, 1.0],
    });
    ir.regions.push(fullmag_ir::RegionIR {
        name: "second".to_string(),
        geometry: "second".to_string(),
    });
    let second_material = ir.magnets[0].material.clone();
    ir.magnets.push(fullmag_ir::MagnetIR {
        object_id: None,
        name: "second".to_string(),
        region: "second".to_string(),
        material: second_material,
        initial_magnetization: Some(fullmag_ir::InitialMagnetizationIR::Uniform {
            value: [0.0, 1.0, 0.0],
        }),
        absorbing_boundary: Some(absorber_layer(frame)),
    });
    let domain_asset = ir
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .expect("minimal fixture has a shared-domain asset");
    domain_asset.mesh = Some(distinct_owner_tets_mesh());
    domain_asset.region_markers = vec![
        fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "strip".to_string(),
            marker: 1,
        },
        fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "second".to_string(),
            marker: 2,
        },
    ];
    ir
}

fn planned_fem_alpha_by_point(
    problem: &ProblemIR,
) -> (f64, std::collections::BTreeMap<[u64; 3], u64>) {
    let planned = plan(problem).expect("absorbing-boundary FEM case should plan");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("expected FEM plan");
    };
    let alpha = fem
        .material
        .alpha_field
        .as_ref()
        .expect("absorbing boundary should materialize an alpha field");
    assert_eq!(alpha.len(), fem.mesh.nodes.len());
    let values_by_point = fem
        .mesh
        .nodes
        .iter()
        .zip(alpha)
        .map(|(point, value)| {
            (
                [
                    point[0].to_bits(),
                    point[1].to_bits(),
                    point[2].to_bits(),
                ],
                value.to_bits(),
            )
        })
        .collect();
    (fem.material.damping, values_by_point)
}

#[test]
fn fem_multibody_cubic_frame_contract_rejects_divergence_and_promotes_single_active_frame() {
    let mut ir = fem_minimal_test_ir();
    ir.energy_terms = vec![fullmag_ir::EnergyTermIR::Exchange];
    let kc1 = 1.0e5;
    let inverse_sqrt_two = std::f64::consts::FRAC_1_SQRT_2;
    ir.materials[0].cubic_anisotropy_kc1 = Some(kc1);
    ir.materials[0].cubic_anisotropy_axis1 = Some([1.0, 0.0, 0.0]);
    ir.materials[0].cubic_anisotropy_axis2 = Some([0.0, 1.0, 0.0]);
    let mut rotated = ir.materials[0].clone();
    rotated.name = "Py_rotated".to_string();
    rotated.cubic_anisotropy_axis1 = Some([inverse_sqrt_two, inverse_sqrt_two, 0.0]);
    rotated.cubic_anisotropy_axis2 = Some([-inverse_sqrt_two, inverse_sqrt_two, 0.0]);
    assert_eq!(
        ir.materials[0].saturation_magnetisation,
        rotated.saturation_magnetisation
    );
    assert_eq!(
        ir.materials[0].exchange_stiffness,
        rotated.exchange_stiffness
    );
    assert_eq!(ir.materials[0].damping, rotated.damping);
    assert_eq!(
        ir.materials[0].uniaxial_anisotropy,
        rotated.uniaxial_anisotropy
    );
    assert_eq!(rotated.cubic_anisotropy_kc1, Some(kc1));
    ir.materials.push(rotated);

    // For m=x, E_c1=Kc1*sum(m_i^2*m_j^2) is 0 in the first frame
    // and Kc1/4 in the 45-degree frame. The rotation is not an axis swap.
    let m = [1.0, 0.0, 0.0];
    let cubic_energy = |axis1: [f64; 3], axis2: [f64; 3]| {
        let m1 = m[0] * axis1[0] + m[1] * axis1[1] + m[2] * axis1[2];
        let m2 = m[0] * axis2[0] + m[1] * axis2[1] + m[2] * axis2[2];
        let m3 = m[0] * 0.0 + m[1] * 0.0 + m[2] * 1.0;
        kc1 * (m1 * m1 * m2 * m2 + m2 * m2 * m3 * m3 + m1 * m1 * m3 * m3)
    };
    assert_eq!(cubic_energy([1.0, 0.0, 0.0], [0.0, 1.0, 0.0]), 0.0);
    assert!(
        (cubic_energy(
            [inverse_sqrt_two, inverse_sqrt_two, 0.0],
            [-inverse_sqrt_two, inverse_sqrt_two, 0.0]
        ) - kc1 / 4.0)
            .abs()
            < 64.0 * f64::EPSILON * kc1
    );

    ir.geometry.entries.push(fullmag_ir::GeometryEntryIR::Box {
        name: "second".to_string(),
        size: [1.0, 1.0, 1.0],
    });
    ir.regions.push(fullmag_ir::RegionIR {
        name: "second".to_string(),
        geometry: "second".to_string(),
    });
    ir.magnets.push(fullmag_ir::MagnetIR {
        object_id: None,
        name: "second".to_string(),
        region: "second".to_string(),
        material: "Py_rotated".to_string(),
        initial_magnetization: Some(fullmag_ir::InitialMagnetizationIR::Uniform { value: m }),
        absorbing_boundary: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: Vec::new(),
        fem_mesh_assets: vec![
            fullmag_ir::FemMeshAssetIR {
                geometry_name: "strip".to_string(),
                mesh_source: None,
                mesh: Some(tet_mesh("strip", [0.0, 0.0, 0.0])),
            },
            fullmag_ir::FemMeshAssetIR {
                geometry_name: "second".to_string(),
                mesh_source: None,
                mesh: Some(tet_mesh("second", [0.0, 0.0, 3.0])),
            },
        ],
        fem_domain_mesh_asset: None,
    });

    let error = plan(&ir).expect_err("different active cubic frames have no per-object FEM ABI");
    assert!(error
        .reasons
        .iter()
        .any(|reason| { reason.contains("shared anisotropy axes/material-law shape") }));

    let mut field_divergence = ir.clone();
    field_divergence.materials[1].cubic_anisotropy_kc1 = None;
    field_divergence.materials[1].kc1_field = Some(vec![kc1; 4]);
    let field_error = plan(&field_divergence)
        .expect_err("an active nodal cubic field must keep the candidate frame guard active");
    assert!(field_error
        .reasons
        .iter()
        .any(|reason| { reason.contains("shared anisotropy axes/material-law shape") }));

    // When only the second object activates cubic anisotropy, its frame must
    // become the global template. Keep the first object's distinct Ku value
    // in the per-node field while promoting that template.
    let mut promoted = ir;
    promoted.materials[0].cubic_anisotropy_kc1 = None;
    promoted.materials[0].uniaxial_anisotropy = Some(7.0e4);
    promoted.materials[0].anisotropy_axis = Some([0.0, 0.0, 1.0]);
    promoted.materials[1].uniaxial_anisotropy = None;
    promoted.materials[1].anisotropy_axis = Some([0.0, 0.0, 1.0]);
    let planned = plan(&promoted).expect("the sole active cubic frame can be promoted");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("expected FEM plan");
    };
    assert_eq!(
        fem.material.cubic_anisotropy_axis1,
        Some([inverse_sqrt_two, inverse_sqrt_two, 0.0])
    );
    assert_eq!(
        fem.material.ku_field.as_deref(),
        Some(&[7.0e4, 7.0e4, 7.0e4, 7.0e4, 0.0, 0.0, 0.0, 0.0][..]),
        "template promotion must preserve the first object's uniaxial field"
    );
}

#[test]
fn fem_region_id_precedes_a_colliding_display_name() {
    let mut ir = fem_minimal_test_ir();
    ir.object_regions.push(object_region("A:core", "core"));
    ir.object_regions.push(object_region("B:core", "A:core"));

    let resolved = crate::mesh::resolve_object_region_marker(&ir, "A:core")
        .expect("an exact region ID must resolve despite an alias collision")
        .expect("the canonical region ID should be present");
    assert_eq!(resolved.region_id, "A:core");
}

#[test]
fn fem_conformal_classification_uses_canonical_id_and_rejects_ambiguous_aliases() {
    let mut ir = fem_minimal_test_ir();
    let mut region_a = object_region("A:core", "core");
    region_a.realization_policy = fullmag_ir::RegionRealizationPolicyIR::Conformal;
    let mut region_b = object_region("B:core", "A:core");
    region_b.realization_policy = fullmag_ir::RegionRealizationPolicyIR::Conformal;
    ir.object_regions.extend([region_a, region_b]);
    ir.geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .expect("minimal fixture has a shared-domain asset")
        .object_region_markers
        .push(fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "A:core".to_string(),
            marker: 1,
        });

    let region_a = ir
        .object_regions
        .iter()
        .find(|region| region.region_id == "A:core")
        .expect("region A exists");
    let region_b = ir
        .object_regions
        .iter()
        .find(|region| region.region_id == "B:core")
        .expect("region B exists");
    assert!(crate::validate::region_is_conformal(&ir, region_a));
    assert!(
        !crate::validate::region_is_conformal(&ir, region_b),
        "the display alias must not steal a canonical ID marker"
    );

    let mut ambiguous = fem_minimal_test_ir();
    let mut first = object_region("strip:first", "shared");
    first.realization_policy = fullmag_ir::RegionRealizationPolicyIR::Conformal;
    let mut second = object_region("strip:second", "shared");
    second.realization_policy = fullmag_ir::RegionRealizationPolicyIR::Conformal;
    ambiguous.object_regions.extend([first, second]);
    ambiguous
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .expect("minimal fixture has a shared-domain asset")
        .object_region_markers
        .push(fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "shared".to_string(),
            marker: 1,
        });
    assert!(ambiguous
        .object_regions
        .iter()
        .all(|region| !crate::validate::region_is_conformal(&ambiguous, region)));
}

#[test]
fn fem_ambiguous_display_alias_fails_closed_in_domain_mesh_resolution() {
    let mut ir = fem_minimal_test_ir();
    let mut first = object_region("strip:first", "shared");
    first.realization_policy = fullmag_ir::RegionRealizationPolicyIR::Conformal;
    let mut second = object_region("strip:second", "shared");
    second.realization_policy = fullmag_ir::RegionRealizationPolicyIR::Conformal;
    ir.object_regions.extend([first, second]);
    ir.geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .expect("minimal fixture has a shared-domain asset")
        .object_region_markers
        .push(fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "shared".to_string(),
            marker: 1,
        });

    let error = crate::mesh::resolve_fem_domain_mesh_asset(&ir, true)
        .expect_err("a display alias shared by multiple regions must be rejected");
    assert!(error.contains("ambiguous"), "unexpected error: {error}");
}

#[test]
fn fem_conformal_dg0_marker_id_collision_does_not_apply_another_regions_override() {
    let mut ir = fem_minimal_test_ir();
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Zeeman {
            b: [0.02, 0.0, 0.0],
        },
    ];
    let base_ms = ir.materials[0].saturation_magnetisation;
    let mut region_a = object_region("A:core", "core");
    region_a.realization_policy = fullmag_ir::RegionRealizationPolicyIR::Conformal;
    let mut region_b = object_region("B:rim", "A:core");
    region_b.realization_policy = fullmag_ir::RegionRealizationPolicyIR::Conformal;
    region_b.material_transition = Some(fullmag_ir::MaterialTransitionSpecIR::Sharp);
    region_b.material_overrides = vec![fullmag_ir::RegionMaterialOverrideIR {
        parameter: fullmag_ir::MaterialParameterNameIR::Ms,
        value: fullmag_ir::MaterialParameterFieldIR::Constant {
            value: serde_json::json!(1.1e6),
            unit: Some("A/m".to_string()),
        },
        priority: 20,
        conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
    }];
    ir.object_regions.extend([region_a, region_b]);
    let domain_asset = ir
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .expect("minimal fixture has a shared-domain asset");
    domain_asset.mesh = Some(disconnected_tets_mesh());
    domain_asset.region_markers = vec![fullmag_ir::FemDomainRegionMarkerIR {
        geometry_name: "strip".to_string(),
        marker: 1,
    }];
    domain_asset.object_region_markers = vec![
        fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "A:core".to_string(),
            marker: 2,
        },
        fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "B:rim".to_string(),
            marker: 3,
        },
    ];
    ir.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Strict;

    assert!(ir
        .object_regions
        .iter()
        .all(|region| region.owner_object == "strip"));
    assert_eq!(ir.materials[0].saturation_magnetisation, base_ms);
    let planned = plan(&ir).expect("canonical marker IDs should preserve both region identities");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("expected FEM plan");
    };
    assert_eq!(
        fem.ms_element_field.as_deref(),
        Some(&[base_ms, base_ms, 1.1e6][..]),
        "B's sharp DG0 Ms must not be selected by A's colliding display alias"
    );
}

#[test]
fn fem_shared_face_between_distinct_magnetic_objects_is_rejected_before_packing() {
    let mut ir = fem_minimal_test_ir();
    ir.energy_terms = vec![fullmag_ir::EnergyTermIR::Exchange];
    ir.geometry.entries.push(fullmag_ir::GeometryEntryIR::Box {
        name: "second".to_string(),
        size: [1.0, 1.0, 1.0],
    });
    ir.regions.push(fullmag_ir::RegionIR {
        name: "second".to_string(),
        geometry: "second".to_string(),
    });
    ir.magnets.push(fullmag_ir::MagnetIR {
        object_id: None,
        name: "second".to_string(),
        region: "second".to_string(),
        material: ir.magnets[0].material.clone(),
        initial_magnetization: Some(fullmag_ir::InitialMagnetizationIR::Uniform {
            value: [0.0, 1.0, 0.0],
        }),
        absorbing_boundary: None,
    });
    let domain_asset = ir
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .expect("minimal fixture has a shared-domain asset");
    domain_asset.mesh = Some(fullmag_ir::MeshIR {
        mesh_name: "touching-magnets".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
        ],
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [0, 2, 1, 4]]),
        element_markers: vec![1, 2],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 3], [0, 1, 4]]),
        boundary_markers: vec![10, 20],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    });
    domain_asset.region_markers = vec![
        fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "strip".to_string(),
            marker: 1,
        },
        fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "second".to_string(),
            marker: 2,
        },
    ];
    domain_asset.object_region_markers.clear();

    let error =
        plan(&ir).expect_err("distinct object contact has no accepted facet/space contract");
    assert!(error
        .reasons
        .iter()
        .any(|reason| { reason.contains("fem_shared_domain_object_contact_unsupported") }));
}

#[test]
fn disabled_canonical_region_id_cannot_be_reinterpreted_as_an_enabled_alias() {
    let mut ir = ProblemIR::bootstrap_example();
    let mut disabled = object_region("strip:disabled", "disabled");
    disabled.enabled = false;
    let enabled = object_region("strip:enabled", "strip:disabled");
    ir.object_regions = vec![disabled, enabled];
    assert!(
        crate::mesh::resolve_object_region_marker(&ir, "strip:disabled")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        crate::mesh::resolve_object_region_marker(&ir, "strip:enabled")
            .unwrap()
            .unwrap()
            .region_id,
        "strip:enabled"
    );
}

#[test]
fn fem_absorber_uses_the_union_of_conformal_owner_segments() {
    for frame in [
        fullmag_ir::AbsorbingBoundaryFrameIR::Object,
        fullmag_ir::AbsorbingBoundaryFrameIR::Universe,
    ] {
        let (base_alpha, full_owner) =
            planned_fem_alpha_by_point(&conformal_absorber_problem(false, false, frame));
        let (_, left_then_right) =
            planned_fem_alpha_by_point(&conformal_absorber_problem(true, false, frame));
        let (_, right_then_left) =
            planned_fem_alpha_by_point(&conformal_absorber_problem(true, true, frame));

        assert_eq!(
            left_then_right, right_then_left,
            "segment order changed {frame:?} alpha samples"
        );
        assert_eq!(
            left_then_right, full_owner,
            "split conformal markers changed whole-owner {frame:?} bounds"
        );
        for interface_point in [
            [1e-9, 0.0, 0.0],
            [1e-9, 1e-9, 0.0],
            [1e-9, 0.0, 1e-9],
        ] {
            let key = interface_point.map(f64::to_bits);
            assert_eq!(
                left_then_right.get(&key).copied(),
                Some(base_alpha.to_bits()),
                "the shared interface is internal to the {frame:?} absorber owner"
            );
        }
        let outer_point = [2e-9, 0.0, 0.0].map(f64::to_bits);
        assert_eq!(
            left_then_right.get(&outer_point).copied(),
            Some((base_alpha + 0.4).to_bits()),
            "the actual x+ owner boundary should retain full damping"
        );
    }
}

#[test]
fn fem_absorber_bounds_remain_separate_for_distinct_owners() {
    for frame in [
        fullmag_ir::AbsorbingBoundaryFrameIR::Object,
        fullmag_ir::AbsorbingBoundaryFrameIR::Universe,
    ] {
        let (base_alpha, values) =
            planned_fem_alpha_by_point(&distinct_owner_absorber_problem(frame));
        for owner_boundary in [[1e-9, 0.0, 0.0], [4e-9, 0.0, 0.0]] {
            let key = owner_boundary.map(f64::to_bits);
            assert_eq!(
                values.get(&key).copied(),
                Some((base_alpha + 0.4).to_bits()),
                "each distinct owner needs its own {frame:?} x+ bounds"
            );
        }
    }
}

#[test]
fn fem_conformal_segments_materialize_fields_at_every_owner_node() {
    const MS_BASE: f64 = 700e3;
    const MS_GRADIENT: f64 = 1e14;
    const AEX_BASE: f64 = 9e-12;
    const AEX_GRADIENT: f64 = 1e-3;
    let linear_assignment = |assignment_id: &str,
                            parameter: fullmag_ir::MaterialParameterNameIR,
                            base: f64,
                            gradient: f64,
                            unit: &str| {
        fullmag_ir::MaterialParameterAssignmentIR {
            assignment_id: assignment_id.to_string(),
            owner_object: "strip".to_string(),
            region_id: None,
            parameter,
            value: fullmag_ir::MaterialParameterFieldIR::Linear {
                base,
                gradient: [gradient, 0.0, 0.0],
                frame: fullmag_ir::RegionFrameIR::Object,
                unit: Some(unit.to_string()),
            },
            priority: 10,
            conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
        }
    };

    for reverse_segments in [false, true] {
        let mut ir = conformal_absorber_problem(
            true,
            reverse_segments,
            fullmag_ir::AbsorbingBoundaryFrameIR::Object,
        );
        ir.material_parameter_fields = vec![
            linear_assignment(
                "owner_linear_ms",
                fullmag_ir::MaterialParameterNameIR::Ms,
                MS_BASE,
                MS_GRADIENT,
                "A/m",
            ),
            linear_assignment(
                "owner_linear_aex",
                fullmag_ir::MaterialParameterNameIR::Aex,
                AEX_BASE,
                AEX_GRADIENT,
                "J/m",
            ),
        ];

        let planned = plan(&ir).expect("conformal owner-wide fields should plan");
        let BackendPlanIR::Fem(fem) = planned.backend_plan else {
            panic!("expected FEM plan");
        };
        for field in &planned.common.material_field_plans {
            assert_eq!(field.realization_location, fullmag_ir::MaterialFieldLocationIR::Node);
            assert_eq!(field.statistics.as_ref().unwrap().sample_count, fem.mesh.nodes.len());
        }
        let ms = fem
            .material
            .ms_field
            .as_ref()
            .expect("owner-wide linear Ms must materialize at FEM nodes");
        let aex = fem
            .material
            .a_field
            .as_ref()
            .expect("owner-wide linear Aex must materialize at FEM nodes");
        assert_eq!(ms.len(), fem.mesh.nodes.len());
        assert_eq!(aex.len(), fem.mesh.nodes.len());

        for (index, point) in fem.mesh.nodes.iter().enumerate() {
            let expected_ms = MS_BASE + MS_GRADIENT * point[0];
            let expected_aex = AEX_BASE + AEX_GRADIENT * point[0];
            assert!(
                (ms[index] - expected_ms).abs() <= 1e-8,
                "reverse_segments={reverse_segments} node {index} x={} Ms={} expected={expected_ms}",
                point[0],
                ms[index]
            );
            assert!(
                (aex[index] - expected_aex).abs() <= 1e-25,
                "reverse_segments={reverse_segments} node {index} x={} Aex={} expected={expected_aex}",
                point[0],
                aex[index]
            );
        }

        for endpoint_x in [0.0, 2e-9] {
            let index = fem
                .mesh
                .nodes
                .iter()
                .position(|point| point[0] == endpoint_x)
                .expect("owner mesh contains both x endpoints");
            assert_ne!(ms[index], fem.material.saturation_magnetisation);
            assert_ne!(aex[index], fem.material.exchange_stiffness);
        }
    }
}

#[test]
fn fem_material_field_metadata_tracks_resolved_element_coefficients() {
    use fullmag_ir::{MaterialFieldLocationIR, MaterialParameterNameIR as Parameter};

    for parameter in [Parameter::Aex, Parameter::Ms] {
        for reverse_segments in [false, true] {
            let mut ir = conformal_absorber_problem(
                true,
                reverse_segments,
                fullmag_ir::AbsorbingBoundaryFrameIR::Object,
            );
            ir.magnets[0].absorbing_boundary = None;
            let (base, unit) = match parameter {
                Parameter::Aex => (ir.materials[0].exchange_stiffness, "J/m"),
                Parameter::Ms => (ir.materials[0].saturation_magnetisation, "A/m"),
                _ => unreachable!(),
            };
            let region = &mut ir.object_regions[1];
            region.material_transition = Some(fullmag_ir::MaterialTransitionSpecIR::Sharp);
            region.material_overrides.push(fullmag_ir::RegionMaterialOverrideIR {
                parameter,
                value: fullmag_ir::MaterialParameterFieldIR::Constant {
                    value: serde_json::json!(2.0 * base),
                    unit: Some(unit.to_string()),
                },
                priority: 10,
                conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
            });
            region.material_overrides.push(fullmag_ir::RegionMaterialOverrideIR {
                parameter: Parameter::Alpha,
                value: fullmag_ir::MaterialParameterFieldIR::Constant {
                    value: serde_json::json!(0.03),
                    unit: Some("1".to_string()),
                },
                priority: 10,
                conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
            });

            let planned = plan(&ir).expect("conformal coefficient should be realized");
            let BackendPlanIR::Fem(fem) = &planned.backend_plan else {
                panic!("expected FEM plan");
            };
            let values = match parameter {
                Parameter::Aex => fem.a_element_field.as_deref(),
                Parameter::Ms => fem.ms_element_field.as_deref(),
                _ => unreachable!(),
            }.expect("sharp coefficient must remain elementwise");
            assert_eq!(values.len(), 2);
            assert!(values.contains(&base) && values.contains(&(2.0 * base)));

            let field = planned.common.material_field_plans.iter()
                .find(|field| field.parameter == parameter && field.object_id == "strip")
                .expect("resolved coefficient needs metadata for artifact publication");
            assert_eq!(field.realization_location, MaterialFieldLocationIR::Element);
            assert_eq!(field.realization_method.as_deref(), Some("conformal_domain_element_sampling"));
            let stats = field.statistics.as_ref().expect("resolved statistics");
            assert_eq!(stats.sample_count, values.len());
            assert_eq!(stats.min, base);
            assert_eq!(stats.max, 2.0 * base);
            assert!((stats.mean - 1.5 * base).abs() <= base.abs() * 1e-14);
            let alpha = planned.common.material_field_plans.iter()
                .find(|field| field.parameter == Parameter::Alpha)
                .expect("alpha metadata");
            assert_eq!(alpha.realization_location, MaterialFieldLocationIR::Node);
        }
    }
}

#[test]
fn fem_aex_field_uniformity_uses_relative_si_tolerance() {
    use fullmag_ir::{
        AbsorbingBoundaryFrameIR, MaterialParameterFieldIR, MaterialParameterNameIR,
        RegionConflictPolicyIR, RegionShapeIR,
    };

    let plan_with_aex = |base_aex: f64, region_aex: f64| {
        let mut ir = conformal_absorber_problem(false, false, AbsorbingBoundaryFrameIR::Object);
        ir.magnets[0].absorbing_boundary = None;
        ir.materials[0].exchange_stiffness = base_aex;

        let mut region = object_region("strip:low-aex", "low Aex");
        region.shape = RegionShapeIR::Box {
            size: [20e-9, 20e-9, 20e-9],
            center: [1e-9, 0.5e-9, 0.5e-9],
        };
        region.material_overrides.push(fullmag_ir::RegionMaterialOverrideIR {
            parameter: MaterialParameterNameIR::Aex,
            value: MaterialParameterFieldIR::Constant {
                value: serde_json::json!(region_aex),
                unit: Some("J/m".to_string()),
            },
            priority: 10,
            conflict_policy: RegionConflictPolicyIR::Error,
        });
        ir.object_regions.push(region);
        plan(&ir).expect("non-sharp regional Aex should plan")
    };

    for (base_aex, region_aex, case) in [
        (0.0, 5e-19, "zero baseline"),
        (5e-19, 1e-18, "small nonzero baseline"),
    ] {
        let planned = plan_with_aex(base_aex, region_aex);
        let BackendPlanIR::Fem(fem) = planned.backend_plan else {
            panic!("expected FEM plan");
        };
        let a_field = fem
            .material
            .a_field
            .as_ref()
            .unwrap_or_else(|| panic!("{case} regional Aex variation must remain nodal"));
        assert_eq!(a_field.len(), fem.mesh.nodes.len());
        assert!(
            a_field.iter().any(|value| *value > base_aex),
            "{case} regional Aex must differ from the base coefficient"
        );
    }

    let homogeneous = plan_with_aex(5e-19, 5e-19);
    let BackendPlanIR::Fem(fem) = homogeneous.backend_plan else {
        panic!("expected FEM plan");
    };
    assert!(
        fem.material.a_field.is_none(),
        "a homogeneous Aex field should keep using the scalar coefficient"
    );
}
