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
        realization_policy: fullmag_ir::RegionRealizationPolicyIR::Conformal,
    }
}

fn touching_tets_mesh() -> fullmag_ir::MeshIR {
    let mut facets = fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![
        [0, 1, 2],
        [3, 0, 1],
        [3, 1, 2],
        [3, 2, 0],
        [4, 0, 2],
        [4, 2, 1],
        [4, 1, 0],
        [5, 6, 7],
        [5, 6, 8],
        [6, 7, 8],
        [7, 5, 8],
    ]);
    facets.roles[0] = fullmag_ir::FemFacetRoleIR::MaterialInterface;
    fullmag_ir::MeshIR {
        mesh_name: "two-markers-one-owner".to_string(),
        nodes: vec![
            [1e-9, 0.0, 0.0],
            [1e-9, 1e-9, 0.0],
            [1e-9, 0.0, 1e-9],
            [0.0, 0.0, 0.0],
            [2e-9, 0.0, 0.0],
            [5e-9, 0.0, 0.0],
            [6e-9, 0.0, 0.0],
            [5e-9, 1e-9, 0.0],
            [5e-9, 0.0, 1e-9],
        ],
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![
            [3, 0, 1, 2],
            [4, 0, 2, 1],
            [5, 6, 7, 8],
        ]),
        element_markers: vec![2, 3, 4],
        facets,
        boundary_markers: vec![99, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    }
}

fn conformal_torque_problem(reverse_markers: bool) -> ProblemIR {
    let mut ir = fem_minimal_test_ir();
    ir.energy_terms = vec![fullmag_ir::EnergyTermIR::Exchange];
    ir.object_regions.extend([
        object_region("strip:left", "left"),
        object_region("strip:right", "right"),
    ]);
    ir.geometry.entries.push(fullmag_ir::GeometryEntryIR::Box {
        name: "other_geom".to_string(),
        size: [2e-9, 2e-9, 2e-9],
    });
    ir.regions.push(fullmag_ir::RegionIR {
        name: "other".to_string(),
        geometry: "other_geom".to_string(),
    });
    let mut other_magnet = ir.magnets[0].clone();
    other_magnet.object_id = Some("other".to_string());
    other_magnet.name = "other".to_string();
    other_magnet.region = "other".to_string();
    ir.magnets.push(other_magnet);
    if let fullmag_ir::StudyIR::TimeEvolution {
        dynamics: fullmag_ir::DynamicsIR::Llg { fixed_timestep, .. },
        ..
    } = &mut ir.study
    {
        *fixed_timestep = Some(1e-15);
    }
    ir.problem_meta.runtime_metadata.remove("study_universe");

    let asset = ir
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .expect("minimal test problem has a FEM domain mesh asset");
    asset.mesh = Some(touching_tets_mesh());
    asset.region_markers = vec![fullmag_ir::FemDomainRegionMarkerIR {
        geometry_name: "other_geom".to_string(),
        marker: 4,
    }];
    asset.object_region_markers = vec![
        fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "strip:left".to_string(),
            marker: 2,
        },
        fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "strip:right".to_string(),
            marker: 3,
        },
    ];
    if reverse_markers {
        asset.object_region_markers.reverse();
    }
    ir.spin_torque_modules = vec![fullmag_ir::SpinTorqueModuleIR::ZhangLi {
        schema_version: Some("zhang_li_torque.v1".to_string()),
        id: Some("cip".to_string()),
        target: Some(fullmag_ir::RegionRefIR {
            object_id: "strip".to_string(),
            region_id: None,
        }),
        formula_version: "zhang_li.fullmag.v1".to_string(),
        operator_version: Some("zl_central_reference_v1".to_string()),
        current_density: Some([1e10, 0.0, 0.0]),
        current_source: None,
        degree: 0.4,
        beta: 0.02,
        lande_g: Some(1.9),
    }];
    ir
}

#[test]
fn fem_torque_object_target_mask_covers_conformal_regions_per_owner_and_order() {
    for is_sot in [false, true] {
        for reverse_markers in [false, true] {
            let mut ir = conformal_torque_problem(reverse_markers);
            if is_sot {
                ir.spin_torque_modules = vec![fullmag_ir::SpinTorqueModuleIR::PrescribedSot {
                    schema_version: "prescribed_sot.v1".to_string(),
                    id: "sot".to_string(),
                    target: Some(fullmag_ir::RegionRefIR {
                        object_id: "strip".to_string(),
                        region_id: None,
                    }),
                    formula: fullmag_ir::PrescribedSotFormulaIR::FullmagV1 {
                        drive: fullmag_ir::PrescribedSotV1DriveIR::SignedScalar {
                            current_density_apm2: 1e10,
                            sigma_hat: [0.0, 1.0, 0.0],
                            envelope: None,
                        },
                        xi_dl: 0.1,
                        xi_fl: 0.0,
                        free_layer_thickness_m: 1e-9,
                    },
                }];
            }

            let planned = plan(&ir).expect("conformal owner target should plan");
            let BackendPlanIR::Fem(fem) = planned.backend_plan else {
                panic!("expected FEM plan");
            };
            let contract = fem.spin_torque_contract.expect("FEM torque contract");
            let node_mask = contract.active_node_mask.expect("torque node mask");
            assert_eq!(node_mask.len(), fem.mesh.nodes.len());
            assert_eq!(fem.mesh.nodes.len(), 9);
            for (point, selected) in fem.mesh.nodes.iter().zip(&node_mask) {
                if point[0] < 3e-9 {
                    assert!(
                        *selected,
                        "sot={is_sot} reverse_markers={reverse_markers} missed target node {point:?}"
                    );
                } else {
                    assert!(
                        !*selected,
                        "sot={is_sot} reverse_markers={reverse_markers} leaked to other owner node {point:?}"
                    );
                }
            }
            if is_sot {
                assert!(contract.active_element_mask.is_none());
            } else {
                let element_mask = contract.active_element_mask.expect("STT element mask");
                assert_eq!(element_mask.len(), fem.mesh.element_markers.len());
                for (marker, selected) in fem.mesh.element_markers.iter().zip(element_mask) {
                    assert_eq!(selected, *marker != 4, "STT marker {marker}");
                }
            }
        }
    }
}
