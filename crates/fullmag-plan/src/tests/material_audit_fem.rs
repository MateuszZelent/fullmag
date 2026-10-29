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
