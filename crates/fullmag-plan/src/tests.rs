use super::*;

#[test]
fn fem_domain_full_sampled_field_copies_by_global_node_indices() {
    let mesh = MeshIR {
        mesh_name: "shared".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [3.0, 0.0, 0.0],
            [4.0, 0.0, 0.0],
        ],
        elements: vec![[0, 1, 2, 3]],
        element_markers: vec![1],
        boundary_faces: vec![[0, 1, 2]],
        boundary_markers: vec![1],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };
    let segment = fullmag_ir::FemObjectSegmentIR {
        object_id: "free_geom".to_string(),
        geometry_id: Some("free_geom".to_string()),
        node_start: 0,
        node_count: 2,
        element_start: 0,
        element_count: 1,
        boundary_face_start: 0,
        boundary_face_count: 1,
    };
    let mesh_parts = vec![fullmag_ir::FemMeshPartIR {
        id: "part:free".to_string(),
        label: "free".to_string(),
        role: fullmag_ir::FemMeshPartRole::MagneticObject,
        object_id: Some("free_geom".to_string()),
        geometry_id: Some("free_geom".to_string()),
        material_id: None,
        element_selector: fullmag_ir::FemMeshPartSelector::ElementRange { start: 0, count: 1 },
        boundary_face_selector: fullmag_ir::FemMeshPartSelector::BoundaryFaceRange {
            start: 0,
            count: 1,
        },
        node_selector: fullmag_ir::FemMeshPartSelector::NodeRange { start: 0, count: 2 },
        boundary_face_indices: Vec::new(),
        node_indices: vec![3, 1],
        surface_faces: Vec::new(),
        bounds_min: None,
        bounds_max: None,
        parent_id: None,
    }];
    let entry = crate::mesh::MagnetPlanningEntry {
        magnet_name: "free".to_string(),
        geometry_name: "free_geom".to_string(),
        initial_magnetization: Some(InitialMagnetizationIR::SampledField {
            values: vec![
                [0.0, 10.0, 100.0],
                [1.0, 11.0, 101.0],
                [2.0, 12.0, 102.0],
                [3.0, 13.0, 103.0],
                [4.0, 14.0, 104.0],
            ],
        }),
    };
    let mut target = vec![[0.0, 0.0, 0.0]; mesh.nodes.len()];

    crate::fem::assign_domain_initial_for_segment(
        &mut target,
        &mesh,
        &mesh_parts,
        &segment,
        &entry,
    )
    .expect("full-domain sampled field should copy by global indices");

    assert_eq!(target[3], [3.0, 13.0, 103.0]);
    assert_eq!(target[1], [1.0, 11.0, 101.0]);
    assert_eq!(target[0], [0.0, 10.0, 100.0]);
    assert_eq!(target[2], [2.0, 12.0, 102.0]);
    assert_eq!(target[4], [0.0, 0.0, 0.0]);
}

#[test]
fn fem_domain_preset_texture_samples_final_mesh_node_order() {
    let mesh = MeshIR {
        mesh_name: "shared".to_string(),
        nodes: vec![
            [0.0, 1.0, 0.0],
            [10.0, 10.0, 0.0],
            [1.0, 0.0, 0.0],
            [20.0, 20.0, 0.0],
        ],
        elements: vec![[0, 1, 2, 3]],
        element_markers: vec![1],
        boundary_faces: vec![[0, 1, 2]],
        boundary_markers: vec![1],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };
    let segment = fullmag_ir::FemObjectSegmentIR {
        object_id: "free_geom".to_string(),
        geometry_id: Some("free_geom".to_string()),
        node_start: 0,
        node_count: 2,
        element_start: 0,
        element_count: 1,
        boundary_face_start: 0,
        boundary_face_count: 1,
    };
    let mesh_parts = vec![fullmag_ir::FemMeshPartIR {
        id: "part:free".to_string(),
        label: "free".to_string(),
        role: fullmag_ir::FemMeshPartRole::MagneticObject,
        object_id: Some("free_geom".to_string()),
        geometry_id: Some("free_geom".to_string()),
        material_id: None,
        element_selector: fullmag_ir::FemMeshPartSelector::ElementRange { start: 0, count: 1 },
        boundary_face_selector: fullmag_ir::FemMeshPartSelector::BoundaryFaceRange {
            start: 0,
            count: 1,
        },
        node_selector: fullmag_ir::FemMeshPartSelector::NodeRange { start: 0, count: 2 },
        boundary_face_indices: Vec::new(),
        node_indices: vec![2, 0],
        surface_faces: Vec::new(),
        bounds_min: None,
        bounds_max: None,
        parent_id: None,
    }];
    let entry = crate::mesh::MagnetPlanningEntry {
        magnet_name: "free".to_string(),
        geometry_name: "free_geom".to_string(),
        initial_magnetization: Some(InitialMagnetizationIR::PresetTexture {
            preset_kind: "vortex".to_string(),
            preset_params: std::collections::BTreeMap::from([
                ("circulation".to_string(), serde_json::json!(1)),
                ("core_polarity".to_string(), serde_json::json!(1)),
                ("core_radius".to_string(), serde_json::json!(1e-12)),
            ]),
            mapping: fullmag_ir::TextureMappingIR::default(),
            texture_transform: fullmag_ir::TextureTransform3DIR::default(),
        }),
    };
    let mut target = vec![[0.0, 0.0, 0.0]; mesh.nodes.len()];

    crate::fem::assign_domain_initial_for_segment(
        &mut target,
        &mesh,
        &mesh_parts,
        &segment,
        &entry,
    )
    .expect("preset texture should sample final mesh nodes");

    assert!(target[2][0].abs() <= 1e-12);
    assert!((target[2][1] - 1.0).abs() <= 1e-12);
    assert!((target[0][0] + 1.0).abs() <= 1e-12);
    assert!(target[0][1].abs() <= 1e-12);
    assert!(
        target[1].iter().map(|v| v * v).sum::<f64>() > 0.99,
        "element-neighbor node 1 must receive an initial texture value"
    );
    assert!(
        target[3].iter().map(|v| v * v).sum::<f64>() > 0.99,
        "element-neighbor node 3 must receive an initial texture value"
    );
}

#[test]
fn mesh_parts_from_shared_domain_produces_air_and_magnetic() {
    let mesh = MeshIR {
        mesh_name: "shared".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [2.0, 0.0, 0.0],
            [2.0, 1.0, 0.0],
            [2.0, 0.0, 1.0],
            [3.0, 0.0, 0.0],
        ],
        elements: vec![[0, 1, 2, 3], [4, 5, 6, 7]],
        element_markers: vec![1, 0],
        boundary_faces: vec![[0, 1, 2], [4, 5, 6]],
        boundary_markers: vec![1, 99],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };
    let object_segments = vec![
        fullmag_ir::FemObjectSegmentIR {
            object_id: "flower".to_string(),
            geometry_id: Some("flower_geom".to_string()),
            node_start: 0,
            node_count: 4,
            element_start: 0,
            element_count: 1,
            boundary_face_start: 0,
            boundary_face_count: 1,
        },
        fullmag_ir::FemObjectSegmentIR {
            object_id: crate::mesh::AIR_OBJECT_SEGMENT_ID.to_string(),
            geometry_id: None,
            node_start: 4,
            node_count: 4,
            element_start: 1,
            element_count: 1,
            boundary_face_start: 1,
            boundary_face_count: 1,
        },
    ];

    let parts = crate::mesh::build_mesh_parts_from_segments(
        &mesh,
        &object_segments,
        fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir,
    );

    assert_eq!(parts.len(), 2);
    assert_eq!(parts[0].role, fullmag_ir::FemMeshPartRole::MagneticObject);
    assert_eq!(parts[0].object_id.as_deref(), Some("flower"));
    assert_eq!(parts[1].role, fullmag_ir::FemMeshPartRole::Air);
    assert_eq!(parts[1].object_id, None);
}

#[test]
fn mesh_part_node_indices_cover_air_elements_with_shared_interface_nodes() {
    let mesh = MeshIR {
        mesh_name: "shared_air_interface".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
        ],
        elements: vec![[0, 1, 2, 3], [0, 1, 2, 4]],
        element_markers: vec![1, 0],
        boundary_faces: vec![[0, 1, 3], [0, 1, 4]],
        boundary_markers: vec![10, 99],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };
    let object_segments = vec![
        fullmag_ir::FemObjectSegmentIR {
            object_id: "flower".to_string(),
            geometry_id: Some("flower_geom".to_string()),
            node_start: 0,
            node_count: 4,
            element_start: 0,
            element_count: 1,
            boundary_face_start: 0,
            boundary_face_count: 1,
        },
        fullmag_ir::FemObjectSegmentIR {
            object_id: crate::mesh::AIR_OBJECT_SEGMENT_ID.to_string(),
            geometry_id: None,
            node_start: 4,
            node_count: 1,
            element_start: 1,
            element_count: 1,
            boundary_face_start: 1,
            boundary_face_count: 1,
        },
    ];

    let parts = crate::mesh::build_mesh_parts_from_segments(
        &mesh,
        &object_segments,
        fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir,
    );

    let air_part = parts
        .iter()
        .find(|part| part.role == fullmag_ir::FemMeshPartRole::Air)
        .expect("airbox part should exist");
    assert_eq!(air_part.node_indices, vec![0, 1, 2, 4]);
    assert_eq!(air_part.bounds_min, Some([0.0, 0.0, -1.0]));
    assert_eq!(air_part.bounds_max, Some([1.0, 1.0, 0.0]));
}

#[test]
fn mesh_parts_from_merged_magnetic_has_no_air() {
    let mesh = MeshIR {
        mesh_name: "merged".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ],
        elements: vec![[0, 1, 2, 3]],
        element_markers: vec![1],
        boundary_faces: vec![[0, 1, 2]],
        boundary_markers: vec![1],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };
    let object_segments = vec![fullmag_ir::FemObjectSegmentIR {
        object_id: "flower".to_string(),
        geometry_id: Some("flower_geom".to_string()),
        node_start: 0,
        node_count: 4,
        element_start: 0,
        element_count: 1,
        boundary_face_start: 0,
        boundary_face_count: 1,
    }];

    let parts = crate::mesh::build_mesh_parts_from_segments(
        &mesh,
        &object_segments,
        fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
    );

    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0].role, fullmag_ir::FemMeshPartRole::MagneticObject);
    assert!(parts
        .iter()
        .all(|part| part.role != fullmag_ir::FemMeshPartRole::Air));
}

#[test]
fn mesh_parts_bounds_are_correct() {
    let mesh = MeshIR {
        mesh_name: "bounds".to_string(),
        nodes: vec![
            [-1.0, 2.0, 3.0],
            [4.0, -5.0, 6.0],
            [0.5, 1.5, -2.5],
            [9.0, 9.0, 9.0],
        ],
        elements: vec![[0, 1, 2, 3]],
        element_markers: vec![1],
        boundary_faces: vec![[0, 1, 2]],
        boundary_markers: vec![1],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };
    let object_segments = vec![fullmag_ir::FemObjectSegmentIR {
        object_id: "sample".to_string(),
        geometry_id: Some("sample_geom".to_string()),
        node_start: 0,
        node_count: 3,
        element_start: 0,
        element_count: 1,
        boundary_face_start: 0,
        boundary_face_count: 1,
    }];

    let parts = crate::mesh::build_mesh_parts_from_segments(
        &mesh,
        &object_segments,
        fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
    );

    assert_eq!(parts[0].bounds_min, Some([-1.0, -5.0, -2.5]));
    assert_eq!(parts[0].bounds_max, Some([4.0, 2.0, 6.0]));
}

#[test]
fn analyze_detects_interface_between_touching_markers() {
    let mesh = MeshIR {
        mesh_name: "touching".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
        ],
        elements: vec![[0, 1, 2, 3], [0, 1, 2, 4]],
        element_markers: vec![1, 2],
        boundary_faces: vec![[0, 1, 3], [0, 1, 4]],
        boundary_markers: vec![10, 20],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };
    let analysis = crate::mesh::analyze_shared_domain_mesh(
        &mesh,
        &[
            fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "left".to_string(),
                marker: 1,
            },
            fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "right".to_string(),
                marker: 2,
            },
        ],
    )
    .expect("analysis should succeed for touching markers");

    assert_eq!(
        analysis.ordered_regions,
        vec![("left".to_string(), 1), ("right".to_string(), 2)]
    );
    assert_eq!(analysis.shared_interface_nodes.len(), 3);
    assert!(analysis
        .shared_interface_nodes
        .iter()
        .all(|(_node, owners)| owners == &vec![1, 2]));
}

#[test]
fn reorder_shared_domain_mesh_materializes_interface_and_outer_boundary_parts() {
    let mesh = MeshIR {
        mesh_name: "shared_with_air".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
        ],
        elements: vec![[0, 1, 2, 3], [0, 1, 2, 4]],
        element_markers: vec![1, 0],
        boundary_faces: vec![
            [0, 1, 3],
            [0, 2, 3],
            [1, 2, 3],
            [0, 1, 4],
            [0, 2, 4],
            [1, 2, 4],
        ],
        boundary_markers: vec![10, 10, 10, 99, 99, 99],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };

    let (_reordered, _segments, parts) = crate::mesh::reorder_shared_domain_mesh(
        &mesh,
        &[fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "flower".to_string(),
            marker: 1,
        }],
        true,
    )
    .expect("shared-domain reorder should succeed");

    let interface_part = parts
        .iter()
        .find(|part| part.role == fullmag_ir::FemMeshPartRole::Interface)
        .expect("expected a materialized interface part");
    assert_eq!(interface_part.label, "Air ↔ flower");
    assert!(!interface_part.node_indices.is_empty());
    assert_eq!(interface_part.surface_faces.len(), 1);
    assert!(interface_part.bounds_min.is_some());

    let boundary_part = parts
        .iter()
        .find(|part| part.role == fullmag_ir::FemMeshPartRole::OuterBoundary)
        .expect("expected a materialized outer-boundary part");
    assert_eq!(boundary_part.parent_id.as_deref(), Some("part:__air__"));
    assert_eq!(boundary_part.boundary_face_indices.len(), 3);
    assert!(!boundary_part.node_indices.is_empty());
    assert!(boundary_part.bounds_max.is_some());
}

#[test]
fn analyze_classifies_air_nodes() {
    let mesh = MeshIR {
        mesh_name: "air".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [3.0, 0.0, 0.0],
            [4.0, 0.0, 0.0],
            [3.0, 1.0, 0.0],
            [3.0, 0.0, 1.0],
        ],
        elements: vec![[0, 1, 2, 3], [4, 5, 6, 7]],
        element_markers: vec![1, 0],
        boundary_faces: vec![[0, 1, 2], [4, 5, 6]],
        boundary_markers: vec![10, 99],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };
    let analysis = crate::mesh::analyze_shared_domain_mesh(
        &mesh,
        &[fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "flower".to_string(),
            marker: 1,
        }],
    )
    .expect("analysis should succeed");

    assert_eq!(&analysis.node_owner[..4], &[1, 1, 1, 1]);
    assert_eq!(&analysis.node_owner[4..], &[0, 0, 0, 0]);
}

#[test]
fn validate_rejects_shared_nodes_for_now() {
    let mesh = MeshIR {
        mesh_name: "touching".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
        ],
        elements: vec![[0, 1, 2, 3], [0, 1, 2, 4]],
        element_markers: vec![1, 2],
        boundary_faces: vec![[0, 1, 3], [0, 1, 4]],
        boundary_markers: vec![10, 20],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };
    let analysis = crate::mesh::analyze_shared_domain_mesh(
        &mesh,
        &[
            fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "left".to_string(),
                marker: 1,
            },
            fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "right".to_string(),
                marker: 2,
            },
        ],
    )
    .expect("analysis should succeed");

    let error = crate::mesh::validate_packing_constraints(&analysis, &mesh.mesh_name, false)
        .expect_err("shared nodes should still be rejected");
    assert!(error.contains("disjoint node ownership"));
}

#[test]
fn validate_accepts_shared_nodes_when_solver_supports_conformal() {
    let mesh = MeshIR {
        mesh_name: "touching".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
        ],
        elements: vec![[0, 1, 2, 3], [0, 1, 2, 4]],
        element_markers: vec![1, 2],
        boundary_faces: vec![[0, 1, 3], [0, 1, 4]],
        boundary_markers: vec![10, 20],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };
    let analysis = crate::mesh::analyze_shared_domain_mesh(
        &mesh,
        &[
            fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "left".to_string(),
                marker: 1,
            },
            fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "right".to_string(),
                marker: 2,
            },
        ],
    )
    .expect("analysis should succeed");

    crate::mesh::validate_packing_constraints(&analysis, &mesh.mesh_name, true)
        .expect("conformal-native path should accept shared interface nodes");
}

#[test]
fn pack_duplicates_shared_interface_nodes_per_region() {
    let mesh = MeshIR {
        mesh_name: "touching".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
        ],
        elements: vec![[0, 1, 2, 3], [0, 1, 2, 4]],
        element_markers: vec![1, 2],
        boundary_faces: vec![[0, 1, 3], [0, 1, 4]],
        boundary_markers: vec![10, 20],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };
    let region_markers = vec![
        fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "left".to_string(),
            marker: 1,
        },
        fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "right".to_string(),
            marker: 2,
        },
    ];
    let analysis = crate::mesh::analyze_shared_domain_mesh(&mesh, &region_markers)
        .expect("analysis should succeed");

    let (packed, segments, mesh_parts) = crate::mesh::pack_mesh_by_analysis(&mesh, &analysis)
        .expect("packing should duplicate shared interface nodes");

    assert_eq!(packed.nodes.len(), 8);
    assert_eq!(packed.elements, vec![[0, 1, 2, 3], [4, 5, 6, 7]]);
    assert_eq!(segments.len(), 2);
    assert_eq!(segments[0].object_id, "left");
    assert_eq!(segments[0].node_count, 4);
    assert_eq!(segments[1].object_id, "right");
    assert_eq!(segments[1].node_count, 4);
    assert_eq!(packed.nodes[0], packed.nodes[4]);
    assert_eq!(packed.nodes[1], packed.nodes[5]);
    assert_eq!(packed.nodes[2], packed.nodes[6]);
    assert!(mesh_parts
        .iter()
        .any(|part| part.role == fullmag_ir::FemMeshPartRole::Interface));
}

#[test]
fn pack_produces_same_result_as_before() {
    let mesh = MeshIR {
        mesh_name: "shared_ok".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [3.0, 0.0, 0.0],
            [4.0, 0.0, 0.0],
            [3.0, 1.0, 0.0],
            [3.0, 0.0, 1.0],
            [8.0, 0.0, 0.0],
            [9.0, 0.0, 0.0],
            [8.0, 1.0, 0.0],
            [8.0, 0.0, 1.0],
        ],
        elements: vec![[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11]],
        element_markers: vec![1, 2, 0],
        boundary_faces: vec![[0, 1, 2], [4, 5, 6], [8, 9, 10]],
        boundary_markers: vec![10, 20, 99],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };
    let region_markers = vec![
        fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "left".to_string(),
            marker: 1,
        },
        fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "right".to_string(),
            marker: 2,
        },
    ];

    let analysis = crate::mesh::analyze_shared_domain_mesh(&mesh, &region_markers)
        .expect("analysis should succeed");
    crate::mesh::validate_packing_constraints(&analysis, &mesh.mesh_name, false)
        .expect("disjoint mesh should validate");
    let packed_via_analysis = crate::mesh::pack_mesh_by_analysis(&mesh, &analysis)
        .expect("packing via analysis should succeed");
    let packed_via_public = crate::mesh::reorder_shared_domain_mesh(&mesh, &region_markers, false)
        .expect("public reorder should succeed");

    assert_eq!(packed_via_analysis, packed_via_public);
}

#[test]
fn bootstrap_example_plans_successfully() {
    let ir = ProblemIR::bootstrap_example();
    let plan = plan(&ir).expect("bootstrap example should plan successfully");

    match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            // Box(200e-9, 20e-9, 6e-9) with cell(2e-9, 2e-9, 2e-9)
            assert_eq!(fdm.grid.cells, [100, 10, 3]);
            assert_eq!(fdm.cell_size, [2e-9, 2e-9, 2e-9]);
            assert_eq!(fdm.material.name, "Py");
            assert_eq!(fdm.material.exchange_stiffness, 13e-12);
            assert_eq!(fdm.gyromagnetic_ratio, 2.211e5);
            assert_eq!(fdm.precision, ExecutionPrecision::Double);
            assert_eq!(fdm.initial_magnetization.len(), (100 * 10 * 3) as usize);
        }
        _ => panic!("expected FDM plan"),
    }
}

#[test]
fn fdm_planner_rejects_spatial_material_fields_until_realization_exists() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.materials[0].ku_field = Some(vec![5.0e4; 8]);

    let err = plan(&ir).expect_err("FDM material field inputs must not be silently dropped");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("per-cell material fields")
                && reason.contains("ku_field")
                && reason.contains("FDM")
        }),
        "unexpected planner errors: {:?}",
        err.reasons
    );
}

#[test]
fn fdm_magnetoelastic_term_is_rejected_until_fdm_lane_exists() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.energy_terms = vec![fullmag_ir::EnergyTermIR::Magnetoelastic {
        magnet: "strip".to_string(),
        body: "solid".to_string(),
        law: "cubic".to_string(),
    }];
    ir.elastic_materials = vec![fullmag_ir::ElasticMaterialIR {
        name: "elastic".to_string(),
        c11: 2.0e11,
        c12: 1.2e11,
        c44: 8.0e10,
        density: 8700.0,
        mechanical_damping: None,
    }];
    ir.elastic_bodies = vec![fullmag_ir::ElasticBodyIR {
        name: "solid".to_string(),
        geometry: "strip".to_string(),
        elastic_material: "elastic".to_string(),
    }];
    ir.magnetostriction_laws = vec![fullmag_ir::MagnetostrictionLawIR::Cubic {
        name: "cubic".to_string(),
        b1: 1.0e6,
        b2: -2.0e6,
    }];
    ir.mechanical_loads = vec![fullmag_ir::MechanicalLoadIR::PrescribedStrain {
        strain: [1.0e-4, 0.0, 0.0, 0.0, 0.0, 0.0],
    }];

    let err = plan(&ir).expect_err("FDM Magnetoelastic should be rejected");
    assert!(err.reasons.iter().any(|r| r.contains("semantic-only")));
}

#[test]
fn imported_geometry_without_grid_asset_is_rejected() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.geometry.entries = vec![GeometryEntryIR::ImportedGeometry {
        name: "mesh".to_string(),
        source: "sample.step".to_string(),
        format: "step".to_string(),
        scale: fullmag_ir::ImportedGeometryScaleIR::Uniform(1.0),
    }];
    ir.regions[0].geometry = "mesh".to_string();

    let err = plan(&ir).expect_err("imported geometry should be rejected");
    assert!(err
        .reasons
        .iter()
        .any(|r| r.contains("requires a precomputed FDM grid asset")));
}

#[test]
fn imported_geometry_with_grid_asset_plans_successfully() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.geometry.entries = vec![GeometryEntryIR::ImportedGeometry {
        name: "mesh".to_string(),
        source: "sample.stl".to_string(),
        format: "stl".to_string(),
        scale: fullmag_ir::ImportedGeometryScaleIR::Uniform(1.0),
    }];
    ir.regions[0].geometry = "mesh".to_string();
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![fullmag_ir::FdmGridAssetIR {
            geometry_name: "mesh".to_string(),
            cells: [4, 2, 1],
            cell_size: [2e-9, 2e-9, 2e-9],
            origin: [-4e-9, -2e-9, -1e-9],
            active_mask: vec![true, true, true, true, false, false, false, false],
        }],
        fem_mesh_assets: vec![],
        fem_domain_mesh_asset: None,
    });

    let plan = plan(&ir).expect("imported geometry with grid asset should plan");
    match plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            assert_eq!(fdm.grid.cells, [4, 2, 1]);
            assert_eq!(fdm.active_mask.unwrap().len(), 8);
        }
        _ => panic!("expected FDM plan"),
    }
}

fn fem_shared_domain_ir_for_magnetoelastic() -> ProblemIR {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 5e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: None,
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![],
        fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [-2.0, -2.0, -2.0],
                    [2.0, -2.0, -2.0],
                    [-2.0, 2.0, -2.0],
                    [-2.0, -2.0, 2.0],
                ],
                elements: vec![[0, 1, 2, 3], [4, 5, 6, 7]],
                element_markers: vec![1, 0],
                boundary_faces: vec![[0, 1, 2], [4, 5, 6]],
                boundary_markers: vec![1, 99],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            build_report: None,
        }),
    });
    ir.elastic_materials = vec![fullmag_ir::ElasticMaterialIR {
        name: "elastic".to_string(),
        c11: 2.0e11,
        c12: 1.2e11,
        c44: 8.0e10,
        density: 8700.0,
        mechanical_damping: None,
    }];
    ir.elastic_bodies = vec![fullmag_ir::ElasticBodyIR {
        name: "solid".to_string(),
        geometry: "strip".to_string(),
        elastic_material: "elastic".to_string(),
    }];
    ir.magnetostriction_laws = vec![fullmag_ir::MagnetostrictionLawIR::Cubic {
        name: "cubic".to_string(),
        b1: 1.1e6,
        b2: -2.2e6,
    }];
    ir.mechanical_loads = vec![fullmag_ir::MechanicalLoadIR::PrescribedStrain {
        strain: [1.0e-4, 2.0e-4, 0.0, 3.0e-5, 0.0, 0.0],
    }];
    ir.energy_terms = vec![fullmag_ir::EnergyTermIR::Magnetoelastic {
        magnet: "strip".to_string(),
        body: "solid".to_string(),
        law: "cubic".to_string(),
    }];
    ir.study = fullmag_ir::StudyIR::TimeEvolution {
        dynamics: fullmag_ir::DynamicsIR::Llg {
            gyromagnetic_ratio: 2.211e5,
            integrator: "heun".to_string(),
            fixed_timestep: Some(1e-13),
            adaptive_timestep: None,
            field_refresh: None,
            mechanics: Some(fullmag_ir::MechanicsIR::PrescribedStrain),
        },
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            outputs: vec![
                fullmag_ir::OutputIR::Field {
                    name: "H_mel".to_string(),
                    every_seconds: 1e-12,
                },
                fullmag_ir::OutputIR::Scalar {
                    name: "E_mel".to_string(),
                    every_seconds: 1e-12,
                },
            ],
        },
    };
    ir
}

#[test]
fn fem_prescribed_strain_magnetoelastic_lowers_to_native_plan() {
    let ir = fem_shared_domain_ir_for_magnetoelastic();

    let planned = plan(&ir).expect("prescribed-strain FEM magnetoelastic should plan");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("expected FEM plan");
    };
    let mel = fem
        .magnetoelastic
        .expect("FemPlanIR should carry prescribed-strain magnetoelastic");
    assert_eq!(mel.b1, 1.1e6);
    assert_eq!(mel.b2, -2.2e6);
    assert_eq!(
        mel.prescribed_strain,
        Some([1.0e-4, 2.0e-4, 0.0, 3.0e-5, 0.0, 0.0])
    );
}

#[test]
fn fem_prescribed_strain_magnetoelastic_serializes_mechanics_contract() {
    let ir = fem_shared_domain_ir_for_magnetoelastic();

    let planned = plan(&ir).expect("prescribed-strain FEM magnetoelastic should plan");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("expected FEM plan");
    };
    let value = serde_json::to_value(&fem).expect("FemPlanIR should serialize");
    let mechanics = value
        .get("mechanics")
        .expect("FemPlanIR should carry a mechanics contract");

    assert_eq!(mechanics["mode"], "prescribed_strain");
    assert_eq!(mechanics["body"]["name"], "solid");
    assert_eq!(mechanics["elastic_material"]["name"], "elastic");
    assert_eq!(mechanics["magnetostriction_law"]["name"], "cubic");
    assert_eq!(
        mechanics["loads"],
        serde_json::json!([
            {
                "kind": "prescribed_strain",
                "strain": [1.0e-4, 2.0e-4, 0.0, 3.0e-5, 0.0, 0.0]
            }
        ])
    );
}

#[test]
fn fem_quasistatic_magnetoelastic_is_explicitly_rejected_until_mechanics_solver_exists() {
    let mut ir = fem_shared_domain_ir_for_magnetoelastic();
    ir.study = fullmag_ir::StudyIR::TimeEvolution {
        dynamics: fullmag_ir::DynamicsIR::Llg {
            gyromagnetic_ratio: 2.211e5,
            integrator: "heun".to_string(),
            fixed_timestep: Some(1e-13),
            adaptive_timestep: None,
            field_refresh: None,
            mechanics: Some(fullmag_ir::MechanicsIR::QuasistaticElasticity {
                max_picard_iterations: 2,
                picard_tolerance: 1e-6,
            }),
        },
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            outputs: vec![fullmag_ir::OutputIR::Field {
                name: "H_mel".to_string(),
                every_seconds: 1e-12,
            }],
        },
    };

    let err = plan(&ir).expect_err("quasistatic mechanics has no executable FEM solver yet");
    assert!(err
        .reasons
        .iter()
        .any(|reason| reason.contains("quasistatic magnetoelasticity is not executable yet")));
}

#[test]
fn fem_elastodynamic_magnetoelastic_is_explicitly_rejected_until_mechanics_solver_exists() {
    let mut ir = fem_shared_domain_ir_for_magnetoelastic();
    ir.study = fullmag_ir::StudyIR::TimeEvolution {
        dynamics: fullmag_ir::DynamicsIR::Llg {
            gyromagnetic_ratio: 2.211e5,
            integrator: "heun".to_string(),
            fixed_timestep: Some(1e-13),
            adaptive_timestep: None,
            field_refresh: None,
            mechanics: Some(fullmag_ir::MechanicsIR::Elastodynamics {
                mechanical_dt: Some(1e-13),
            }),
        },
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            outputs: vec![fullmag_ir::OutputIR::Field {
                name: "H_mel".to_string(),
                every_seconds: 1e-12,
            }],
        },
    };

    let err = plan(&ir).expect_err("elastodynamic mechanics has no executable FEM solver yet");
    assert!(err
        .reasons
        .iter()
        .any(|reason| reason.contains("elastodynamic magnetoelasticity is not executable yet")));
}

#[test]
fn fem_mechanics_observables_are_rejected_until_mechanics_solver_exists() {
    let mut ir = fem_shared_domain_ir_for_magnetoelastic();
    ir.study = fullmag_ir::StudyIR::TimeEvolution {
        dynamics: fullmag_ir::DynamicsIR::Llg {
            gyromagnetic_ratio: 2.211e5,
            integrator: "heun".to_string(),
            fixed_timestep: Some(1e-13),
            adaptive_timestep: None,
            field_refresh: None,
            mechanics: Some(fullmag_ir::MechanicsIR::PrescribedStrain),
        },
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            outputs: vec![
                fullmag_ir::OutputIR::Field {
                    name: "u".to_string(),
                    every_seconds: 1e-12,
                },
                fullmag_ir::OutputIR::Scalar {
                    name: "E_el".to_string(),
                    every_seconds: 1e-12,
                },
            ],
        },
    };

    let err = plan(&ir).expect_err("mechanics observables need an executable mechanics solver");
    assert!(err.reasons.iter().any(|reason| reason
        .contains("field output 'u' requires the quasistatic/elastodynamic mechanics solver")));
    assert!(err.reasons.iter().any(|reason| reason
        .contains("scalar output 'E_el' requires the quasistatic/elastodynamic mechanics solver")));
}

#[test]
fn fem_backend_with_mesh_asset_plans_successfully() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.air_box_policy = Some(fullmag_ir::AirBoxPolicyIR {
        boundary_marker: Some(99),
        ..Default::default()
    });
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 5e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: None,
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![],
        fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [-2.0, -2.0, -2.0],
                    [2.0, -2.0, -2.0],
                    [-2.0, 2.0, -2.0],
                    [-2.0, -2.0, 2.0],
                ],
                elements: vec![[0, 1, 2, 3], [4, 5, 6, 7]],
                element_markers: vec![1, 0],
                boundary_faces: vec![[0, 1, 2], [4, 5, 6]],
                boundary_markers: vec![1, 99],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            build_report: None,
        }),
    });
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::InterfacialDmi {
            d: 3.0e-3,
            interface_normal: Some([0.0, 0.0, 2.0]),
        },
    ];

    let plan = plan(&ir).expect("FEM mesh asset should produce a FemPlanIR");
    match plan.backend_plan {
        BackendPlanIR::Fem(fem) => {
            assert_eq!(fem.mesh.mesh_name, "strip");
            assert_eq!(fem.material.name, "Py");
            assert_eq!(fem.initial_magnetization.len(), 8);
            assert!(fem.enable_exchange);
            assert!(!fem.enable_demag);
            let magnetic_part = fem
                .mesh_parts
                .iter()
                .find(|part| part.role == fullmag_ir::FemMeshPartRole::MagneticObject)
                .expect("shared-domain mesh should include the magnetic object part");
            assert_eq!(magnetic_part.material_id.as_deref(), Some("Py"));
            assert_eq!(fem.interfacial_dmi, Some(3.0e-3));
            let normal = fem
                .dmi_interface_normal
                .expect("planner should propagate normalized iDMI interface_normal");
            assert!(normal[0].abs() <= 1e-12);
            assert!(normal[1].abs() <= 1e-12);
            assert!((normal[2] - 1.0).abs() <= 1e-12);
        }
        _ => panic!("expected FEM plan"),
    }
}

#[test]
fn fem_static_time_domain_plans_exchange_only_periodic_mesh_pairs() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 5e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: None,
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![],
        fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "periodic_strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [1.0, 1.0, 1.0],
                ],
                elements: vec![[0, 1, 2, 3], [1, 2, 3, 4]],
                element_markers: vec![1, 0],
                boundary_faces: vec![[0, 1, 2], [0, 1, 3], [1, 2, 4]],
                boundary_markers: vec![10, 11, 99],
                periodic_boundary_pairs: vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
                    pair_id: "x_periodic".to_string(),
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
                periodic_node_pairs: vec![fullmag_ir::MeshPeriodicNodePairIR {
                    pair_id: "x_periodic".to_string(),
                    node_a: 0,
                    node_b: 1,
                }],
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            build_report: None,
        }),
    });
    ir.energy_terms = vec![fullmag_ir::EnergyTermIR::Exchange];

    let planned = plan(&ir).expect("exchange-only FEM static PBC should plan");
    match planned.backend_plan {
        BackendPlanIR::Fem(fem) => {
            assert_eq!(fem.mesh.mesh_name, "periodic_strip");
            assert_eq!(fem.mesh.periodic_node_pairs.len(), 1);
            assert!(fem.enable_exchange);
            assert!(!fem.enable_demag);
        }
        other => panic!("expected FEM plan, got {:?}", other),
    }

    let mut demag_ir = ir.clone();
    demag_ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::default(),
        },
    ];
    let demag_planned =
        plan(&demag_ir).expect("periodic FEM static demag with open airbox should plan");
    match demag_planned.backend_plan {
        BackendPlanIR::Fem(fem) => {
            assert!(fem.enable_demag);
            assert_eq!(fem.mesh.periodic_node_pairs.len(), 1);
            assert!(fem.air_box_config.is_some());
        }
        other => panic!("expected FEM plan, got {:?}", other),
    }
}

#[test]
fn fem_backend_interfacial_dmi_defaults_interface_normal_to_z_in_strict_mode() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 5e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: None,
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![],
        fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [-2.0, -2.0, -2.0],
                    [2.0, -2.0, -2.0],
                    [-2.0, 2.0, -2.0],
                    [-2.0, -2.0, 2.0],
                ],
                elements: vec![[0, 1, 2, 3], [4, 5, 6, 7]],
                element_markers: vec![1, 0],
                boundary_faces: vec![[0, 1, 2], [4, 5, 6]],
                boundary_markers: vec![1, 99],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            build_report: None,
        }),
    });
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::InterfacialDmi {
            d: 3.0e-3,
            interface_normal: None,
        },
    ];

    let plan = plan(&ir).expect("strict FEM planning should default missing iDMI normal to +z");
    match plan.backend_plan {
        BackendPlanIR::Fem(fem) => {
            assert_eq!(fem.interfacial_dmi, Some(3.0e-3));
            assert_eq!(fem.dmi_interface_normal, Some([0.0, 0.0, 1.0]));
        }
        other => panic!("expected FEM plan, got {other:?}"),
    }
}

#[test]
fn fem_plan_serializes_mesh_parts() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 5e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: None,
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![],
        fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [-2.0, -2.0, -2.0],
                    [2.0, -2.0, -2.0],
                    [-2.0, 2.0, -2.0],
                    [-2.0, -2.0, 2.0],
                ],
                elements: vec![[0, 1, 2, 3], [4, 5, 6, 7]],
                element_markers: vec![1, 0],
                boundary_faces: vec![[0, 1, 2], [4, 5, 6]],
                boundary_markers: vec![1, 99],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            build_report: None,
        }),
    });

    let plan = plan(&ir).expect("FEM mesh asset should produce a FemPlanIR");
    let json =
        serde_json::to_value(&plan).expect("execution plan with mesh_parts should serialize");
    let mesh_parts = json
        .get("backend_plan")
        .and_then(|value| value.get("mesh_parts"))
        .and_then(serde_json::Value::as_array)
        .expect("FemPlanIR JSON should include mesh_parts");
    assert!(!mesh_parts.is_empty());
}

#[test]
fn fem_backend_with_air_elements_lowers_study_universe_to_air_box_config() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.air_box_policy = Some(fullmag_ir::AirBoxPolicyIR {
        boundary_marker: Some(99),
        ..Default::default()
    });
    ir.problem_meta.runtime_metadata.insert(
        "study_universe".to_string(),
        serde_json::json!({
            "mode": "manual",
            "size": [8.0, 6.0, 4.0],
            "center": [0.5, 0.25, -0.125],
        }),
    );
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::Auto,
        },
    ];
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 5e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: None,
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![],
        fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [-2.0, -2.0, -2.0],
                    [2.0, -2.0, -2.0],
                    [-2.0, 2.0, -2.0],
                    [-2.0, -2.0, 2.0],
                ],
                elements: vec![[0, 1, 2, 3], [4, 5, 6, 7]],
                element_markers: vec![1, 0],
                boundary_faces: vec![[0, 1, 2], [4, 5, 6]],
                boundary_markers: vec![1, 99],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            build_report: None,
        }),
    });

    let plan = plan(&ir).expect("FEM air-box mesh asset should produce an air-box config");
    match plan.backend_plan {
        BackendPlanIR::Fem(fem) => {
            assert_eq!(
                fem.demag_realization,
                Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin)
            );
            let air_box = fem
                .air_box_config
                .as_ref()
                .expect("shared-domain poisson demag should lower an air-box config");
            assert_eq!(air_box.boundary_marker, 99);
            assert_eq!(
                air_box.boundary_marker_source.as_deref(),
                Some("user_policy")
            );
        }
        _ => panic!("expected FEM plan"),
    }
    assert!(plan
        .provenance
        .notes
        .iter()
        .any(|note| note.contains("FEM air-box configuration")));
}

/// When marker 99 (the well-known gmsh convention) is present in boundary_markers,
/// strict mode should auto-detect it and succeed — it is not a guess.
#[test]
fn fem_backend_with_air_elements_accepts_marker_99_in_strict_mode() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.problem_meta.runtime_metadata.insert(
        "study_universe".to_string(),
        serde_json::json!({
            "mode": "manual",
            "size": [8.0, 6.0, 4.0],
            "center": [0.5, 0.25, -0.125],
        }),
    );
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::Auto,
        },
    ];
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 5e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: None,
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![],
        fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [-2.0, -2.0, -2.0],
                    [2.0, -2.0, -2.0],
                    [-2.0, 2.0, -2.0],
                    [-2.0, -2.0, 2.0],
                ],
                elements: vec![[0, 1, 2, 3], [4, 5, 6, 7]],
                element_markers: vec![1, 0],
                boundary_faces: vec![[0, 1, 2], [4, 5, 6]],
                boundary_markers: vec![1, 99],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            build_report: None,
        }),
    });

    let result = plan(&ir).expect(
        "strict mode should accept marker 99 (well-known gmsh convention) without explicit air_box_policy",
    );
    let fem = match &result.backend_plan {
        fullmag_ir::BackendPlanIR::Fem(fem) => fem,
        _ => panic!("expected FEM plan"),
    };
    let air_box = fem
        .air_box_config
        .as_ref()
        .expect("air_box_config should be present");
    assert_eq!(air_box.boundary_marker, 99);
    assert_eq!(
        air_box.boundary_marker_source.as_deref(),
        Some("mesh_marker_99")
    );
}

/// When marker 99 is NOT present and no explicit boundary_marker is set,
/// strict mode should still reject the plan.
#[test]
fn fem_backend_with_air_elements_rejects_unknown_boundary_marker_in_strict_mode() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.problem_meta.runtime_metadata.insert(
        "study_universe".to_string(),
        serde_json::json!({
            "mode": "manual",
            "size": [8.0, 6.0, 4.0],
            "center": [0.5, 0.25, -0.125],
        }),
    );
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::Auto,
        },
    ];
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 5e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: None,
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![],
        fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [-2.0, -2.0, -2.0],
                    [2.0, -2.0, -2.0],
                    [-2.0, 2.0, -2.0],
                    [-2.0, -2.0, 2.0],
                ],
                elements: vec![[0, 1, 2, 3], [4, 5, 6, 7]],
                element_markers: vec![1, 0],
                boundary_faces: vec![[0, 1, 2], [4, 5, 6]],
                boundary_markers: vec![1, 42],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            build_report: None,
        }),
    });

    let error = plan(&ir).expect_err(
        "strict FEM air-box planning should reject when marker 99 is absent and no explicit boundary_marker",
    );
    assert!(error.reasons.iter().any(|reason| {
        reason.contains("air_box_policy.boundary_marker")
            && reason.contains("strict execution mode")
    }));
}

#[test]
fn fem_backend_without_air_elements_rejects_missing_shared_airbox_mesh() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.problem_meta.runtime_metadata.insert(
        "study_universe".to_string(),
        serde_json::json!({
            "mode": "manual",
            "size": [8.0, 6.0, 4.0],
            "center": [0.0, 0.0, 0.0],
        }),
    );
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::Auto,
        },
    ];
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 5e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: None,
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![fullmag_ir::FemMeshAssetIR {
            geometry_name: "strip".to_string(),
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                elements: vec![[0, 1, 2, 3]],
                element_markers: vec![1],
                boundary_faces: vec![[0, 1, 2]],
                boundary_markers: vec![1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
        }],
        fem_domain_mesh_asset: None,
    });

    let err = plan(&ir).expect_err("FEM mesh without air elements must be rejected");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("FEM demag requires a conformal shared-domain mesh")
                && (reason.contains("Shared-domain FEM mesh")
                    || reason.contains("shared-domain FEM mesh")
                    || reason.contains("no air elements"))
        }),
        "unexpected planner reasons: {:?}",
        err.reasons
    );
}

#[test]
fn fem_backend_fredkin_koehler_demag_plans_on_body_only_mesh_without_airbox() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::FredkinKoehler,
        },
    ];
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 5e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: None,
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![fullmag_ir::FemMeshAssetIR {
            geometry_name: "strip".to_string(),
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip_body_only".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                elements: vec![[0, 1, 2, 3]],
                element_markers: vec![1],
                boundary_faces: vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
                boundary_markers: vec![1, 1, 1, 1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
        }],
        fem_domain_mesh_asset: None,
    });

    let planned = plan(&ir).expect("Fredkin-Koehler FEM/BEM demag should plan on a body-only mesh");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("expected FEM plan");
    };
    assert!(fem.enable_demag);
    assert_eq!(
        fem.demag_realization,
        Some(fullmag_ir::ResolvedFemDemagIR::FredkinKoehler)
    );
    assert_eq!(
        fem.domain_mesh_mode,
        fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh
    );
    assert!(
        fem.air_box_config.is_none(),
        "Fredkin-Koehler FEM/BEM demag must not materialize an airbox"
    );
}

#[test]
fn fem_backend_rejects_requested_shared_domain_without_air_elements() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.problem_meta.runtime_metadata.insert(
        "study_universe".to_string(),
        serde_json::json!({
            "mode": "manual",
            "size": [8.0, 6.0, 4.0],
            "center": [0.0, 0.0, 0.0],
        }),
    );
    ir.problem_meta.runtime_metadata.insert(
        "mesh_workflow".to_string(),
        serde_json::json!({
            "build_target": "domain",
            "domain_mesh_mode": "generated_shared_domain_mesh",
        }),
    );
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::Auto,
        },
    ];
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 5e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: None,
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![fullmag_ir::FemMeshAssetIR {
            geometry_name: "strip".to_string(),
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                elements: vec![[0, 1, 2, 3]],
                element_markers: vec![1],
                boundary_faces: vec![[0, 1, 2]],
                boundary_markers: vec![1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
        }],
        fem_domain_mesh_asset: None,
    });

    let error = plan(&ir).expect_err("shared-domain FEM without air should fail");
    assert!(error
        .reasons
        .iter()
        .any(|reason| reason.contains("shared-domain FEM")
            || reason.contains("study.build_domain_mesh()")));
}

#[test]
fn fem_backend_populates_domain_frame_and_domain_mesh_mode() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.problem_meta.runtime_metadata.insert(
        "domain_frame".to_string(),
        serde_json::json!({
            "declared_universe": {
                "mode": "manual",
                "size": [8.0, 6.0, 4.0],
                "center": [0.5, 0.25, -0.125],
            },
            "object_bounds_min": [0.0, 0.0, 0.0],
            "object_bounds_max": [1.0, 1.0, 1.0],
            "effective_extent": [8.0, 6.0, 4.0],
            "effective_center": [0.5, 0.25, -0.125],
            "effective_source": "declared_universe_manual",
        }),
    );
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 5e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: None,
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![fullmag_ir::FemMeshAssetIR {
            geometry_name: "strip".to_string(),
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                elements: vec![[0, 1, 2, 3]],
                element_markers: vec![1],
                boundary_faces: vec![[0, 1, 2]],
                boundary_markers: vec![1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
        }],
        fem_domain_mesh_asset: None,
    });

    let plan = plan(&ir).expect("FEM plan should populate domain_frame");
    match plan.backend_plan {
        BackendPlanIR::Fem(fem) => {
            assert_eq!(
                fem.domain_mesh_mode,
                fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh
            );
            let domain_frame = fem
                .domain_frame
                .expect("domain_frame should be carried into FemPlanIR");
            assert_eq!(
                domain_frame.effective_source.as_deref(),
                Some("declared_universe_manual")
            );
            assert_eq!(domain_frame.effective_extent, Some([8.0, 6.0, 4.0]));
            assert_eq!(domain_frame.mesh_bounds_min, Some([0.0, 0.0, 0.0]));
            assert_eq!(domain_frame.mesh_bounds_max, Some([1.0, 1.0, 1.0]));
        }
        _ => panic!("expected FEM plan"),
    }
}

#[test]
fn fem_backend_prefers_domain_frame_declared_universe_over_legacy_study_universe() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.problem_meta.runtime_metadata.insert(
        "domain_frame".to_string(),
        serde_json::json!({
            "declared_universe": {
                "mode": "manual",
                "size": [9.0, 7.0, 5.0],
                "center": [1.0, 2.0, 3.0],
                "airbox_hmax": 7.5,
                "airbox_hmin": 1.5,
            },
            "object_bounds_min": [0.0, 0.0, 0.0],
            "object_bounds_max": [1.0, 1.0, 1.0],
            "effective_extent": [9.0, 7.0, 5.0],
            "effective_center": [1.0, 2.0, 3.0],
            "effective_source": "declared_universe_manual",
        }),
    );
    ir.problem_meta.runtime_metadata.insert(
        "study_universe".to_string(),
        serde_json::json!({
            "mode": "manual",
            "size": [99.0, 99.0, 99.0],
            "center": [0.0, 0.0, 0.0],
            "airbox_hmax": 0.5,
            "airbox_hmin": 0.25,
        }),
    );
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 5e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: None,
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![fullmag_ir::FemMeshAssetIR {
            geometry_name: "strip".to_string(),
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                elements: vec![[0, 1, 2, 3]],
                element_markers: vec![1],
                boundary_faces: vec![[0, 1, 2]],
                boundary_markers: vec![1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
        }],
        fem_domain_mesh_asset: None,
    });

    let plan = plan(&ir).expect("FEM plan should respect declared_universe from domain_frame");
    match plan.backend_plan {
        BackendPlanIR::Fem(fem) => {
            let domain_frame = fem
                .domain_frame
                .expect("domain_frame should be carried into FemPlanIR");
            let declared_universe = domain_frame
                .declared_universe
                .expect("declared_universe should be preserved");
            assert_eq!(declared_universe.size, Some([9.0, 7.0, 5.0]));
            assert_eq!(declared_universe.center, Some([1.0, 2.0, 3.0]));
            assert_eq!(declared_universe.airbox_hmax, Some(7.5));
            assert_eq!(declared_universe.airbox_hmin, Some(1.5));
        }
        _ => panic!("expected FEM plan"),
    }
}

#[test]
fn fem_backend_with_mesh_source_json_plans_successfully() {
    let mesh_path = std::env::temp_dir().join(format!(
        "fullmag-plan-test-mesh-{}.json",
        std::process::id()
    ));
    let mesh_json = serde_json::json!({
        "mesh_name": "strip",
        "nodes": [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0]
        ],
        "elements": [[0, 1, 2, 3]],
        "element_markers": [1],
        "boundary_faces": [[0, 1, 2]],
        "boundary_markers": [1]
    });
    std::fs::write(&mesh_path, serde_json::to_string(&mesh_json).unwrap()).unwrap();

    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 5e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: Some(mesh_path.display().to_string()),
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![fullmag_ir::FemMeshAssetIR {
            geometry_name: "strip".to_string(),
            mesh_source: Some(mesh_path.display().to_string()),
            mesh: None,
        }],
        fem_domain_mesh_asset: None,
    });

    let plan = plan(&ir).expect("FEM mesh_source JSON should produce a FemPlanIR");
    match plan.backend_plan {
        BackendPlanIR::Fem(fem) => {
            assert_eq!(fem.mesh.mesh_name, "strip");
            assert_eq!(fem.mesh.nodes.len(), 4);
            assert_eq!(fem.mesh.elements.len(), 1);
        }
        _ => panic!("expected FEM plan"),
    }

    let _ = std::fs::remove_file(mesh_path);
}

#[test]
fn fem_backend_multibody_merges_disjoint_mesh_assets() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 2e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: None,
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry.entries = vec![
        GeometryEntryIR::Box {
            name: "free_geom".to_string(),
            size: [2.0, 1.0, 1.0],
        },
        GeometryEntryIR::Box {
            name: "ref_geom".to_string(),
            size: [2.0, 1.0, 1.0],
        },
    ];
    ir.regions = vec![
        fullmag_ir::RegionIR {
            name: "free".to_string(),
            geometry: "free_geom".to_string(),
        },
        fullmag_ir::RegionIR {
            name: "ref".to_string(),
            geometry: "ref_geom".to_string(),
        },
    ];
    ir.magnets = vec![
        fullmag_ir::MagnetIR {
            name: "free".to_string(),
            region: "free".to_string(),
            material: "Py".to_string(),
            initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                value: [1.0, 0.0, 0.0],
            }),
        },
        fullmag_ir::MagnetIR {
            name: "ref".to_string(),
            region: "ref".to_string(),
            material: "Py".to_string(),
            initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                value: [0.0, 1.0, 0.0],
            }),
        },
    ];
    ir.energy_terms = vec![fullmag_ir::EnergyTermIR::Exchange];
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![
            fullmag_ir::FemMeshAssetIR {
                geometry_name: "free_geom".to_string(),
                mesh_source: None,
                mesh: Some(fullmag_ir::MeshIR {
                    mesh_name: "free".to_string(),
                    nodes: vec![
                        [0.0, 0.0, 0.0],
                        [1.0, 0.0, 0.0],
                        [0.0, 1.0, 0.0],
                        [0.0, 0.0, 1.0],
                    ],
                    elements: vec![[0, 1, 2, 3]],
                    element_markers: vec![1],
                    boundary_faces: vec![[0, 1, 2]],
                    boundary_markers: vec![1],
                    periodic_boundary_pairs: Vec::new(),
                    periodic_node_pairs: Vec::new(),
                    per_domain_quality: std::collections::HashMap::new(),
                }),
            },
            fullmag_ir::FemMeshAssetIR {
                geometry_name: "ref_geom".to_string(),
                mesh_source: None,
                mesh: Some(fullmag_ir::MeshIR {
                    mesh_name: "ref".to_string(),
                    nodes: vec![
                        [0.0, 0.0, 2.0],
                        [1.0, 0.0, 2.0],
                        [0.0, 1.0, 2.0],
                        [0.0, 0.0, 3.0],
                    ],
                    elements: vec![[0, 1, 2, 3]],
                    element_markers: vec![1],
                    boundary_faces: vec![[0, 1, 2]],
                    boundary_markers: vec![1],
                    periodic_boundary_pairs: Vec::new(),
                    periodic_node_pairs: Vec::new(),
                    per_domain_quality: std::collections::HashMap::new(),
                }),
            },
        ],
        fem_domain_mesh_asset: None,
    });

    let plan = plan(&ir).expect("multi-body FEM should plan successfully");
    match plan.backend_plan {
        BackendPlanIR::Fem(fem) => {
            assert_eq!(fem.mesh.nodes.len(), 8);
            assert_eq!(fem.mesh.elements.len(), 2);
            assert_eq!(fem.initial_magnetization.len(), 8);
            assert_eq!(fem.object_segments.len(), 2);
            assert_eq!(fem.object_segments[0].object_id, "free");
            assert_eq!(
                fem.object_segments[0].geometry_id.as_deref(),
                Some("free_geom")
            );
            assert_eq!(fem.object_segments[0].node_start, 0);
            assert_eq!(fem.object_segments[0].node_count, 4);
            assert_eq!(fem.object_segments[0].element_start, 0);
            assert_eq!(fem.object_segments[0].element_count, 1);
            assert_eq!(fem.object_segments[0].boundary_face_start, 0);
            assert_eq!(fem.object_segments[0].boundary_face_count, 1);
            assert_eq!(fem.object_segments[1].object_id, "ref");
            assert_eq!(
                fem.object_segments[1].geometry_id.as_deref(),
                Some("ref_geom")
            );
            assert_eq!(fem.object_segments[1].node_start, 4);
            assert_eq!(fem.object_segments[1].node_count, 4);
            assert_eq!(fem.object_segments[1].element_start, 1);
            assert_eq!(fem.object_segments[1].element_count, 1);
            assert_eq!(fem.object_segments[1].boundary_face_start, 1);
            assert_eq!(fem.object_segments[1].boundary_face_count, 1);
            assert!(fem.enable_exchange);
            assert!(!fem.enable_demag);
        }
        _ => panic!("expected FEM plan"),
    }
}

#[test]
fn fem_backend_multibody_rejects_incompatible_material_law() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.materials.push(fullmag_ir::MaterialIR {
        name: "Co".to_string(),
        saturation_magnetisation: 1.1e6,
        exchange_stiffness: 20e-12,
        damping: 0.02,
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
    });
    ir.geometry.entries.push(GeometryEntryIR::Box {
        name: "second".to_string(),
        size: [1.0, 1.0, 1.0],
    });
    ir.regions.push(fullmag_ir::RegionIR {
        name: "second".to_string(),
        geometry: "second".to_string(),
    });
    ir.magnets.push(fullmag_ir::MagnetIR {
        name: "second".to_string(),
        region: "second".to_string(),
        material: "Co".to_string(),
        initial_magnetization: Some(InitialMagnetizationIR::Uniform {
            value: [0.0, 1.0, 0.0],
        }),
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![
            fullmag_ir::FemMeshAssetIR {
                geometry_name: "strip".to_string(),
                mesh_source: None,
                mesh: Some(fullmag_ir::MeshIR {
                    mesh_name: "strip".to_string(),
                    nodes: vec![
                        [0.0, 0.0, 0.0],
                        [1.0, 0.0, 0.0],
                        [0.0, 1.0, 0.0],
                        [0.0, 0.0, 1.0],
                    ],
                    elements: vec![[0, 1, 2, 3]],
                    element_markers: vec![1],
                    boundary_faces: vec![[0, 1, 2]],
                    boundary_markers: vec![1],
                    periodic_boundary_pairs: Vec::new(),
                    periodic_node_pairs: Vec::new(),
                    per_domain_quality: std::collections::HashMap::new(),
                }),
            },
            fullmag_ir::FemMeshAssetIR {
                geometry_name: "second".to_string(),
                mesh_source: None,
                mesh: Some(fullmag_ir::MeshIR {
                    mesh_name: "second".to_string(),
                    nodes: vec![
                        [0.0, 0.0, 2.0],
                        [1.0, 0.0, 2.0],
                        [0.0, 1.0, 2.0],
                        [0.0, 0.0, 3.0],
                    ],
                    elements: vec![[0, 1, 2, 3]],
                    element_markers: vec![1],
                    boundary_faces: vec![[0, 1, 2]],
                    boundary_markers: vec![1],
                    periodic_boundary_pairs: Vec::new(),
                    periodic_node_pairs: Vec::new(),
                    per_domain_quality: std::collections::HashMap::new(),
                }),
            },
        ],
        fem_domain_mesh_asset: None,
    });

    let error = plan(&ir).expect_err("heterogeneous multi-body FEM materials should fail on CPU");
    assert!(error
        .reasons
        .iter()
        .any(|reason| reason.contains("native GPU FEM path")));
}

#[test]
fn fem_plan_rejects_invalid_cubic_anisotropy_axes() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.energy_terms = vec![EnergyTermIR::Exchange];
    ir.materials[0].cubic_anisotropy_kc1 = Some(-1.0e5);
    ir.materials[0].cubic_anisotropy_axis1 = Some([1.0, 0.0, 0.0]);
    ir.materials[0].cubic_anisotropy_axis2 = Some([2.0, 0.0, 0.0]);
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![fullmag_ir::FemMeshAssetIR {
            geometry_name: "strip".to_string(),
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                elements: vec![[0, 1, 2, 3]],
                element_markers: vec![1],
                boundary_faces: vec![[0, 1, 2]],
                boundary_markers: vec![1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
        }],
        fem_domain_mesh_asset: None,
    });

    let err = plan(&ir).expect_err("parallel cubic axes must fail FEM planning");

    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains(
                "cubic anisotropy axes must be finite, normalized and mutually orthogonal",
            )
        }),
        "unexpected FEM planning errors: {:?}",
        err.reasons
    );
}

#[test]
fn fem_plan_heterogeneous_materials_populates_region_materials_for_cuda() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda", "device_index": 0}),
    );
    ir.materials.push(fullmag_ir::MaterialIR {
        name: "Co".to_string(),
        saturation_magnetisation: 1.1e6,
        exchange_stiffness: 20e-12,
        damping: 0.02,
        uniaxial_anisotropy: Some(5.0e4),
        anisotropy_axis: Some([0.0, 0.0, 1.0]),
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
        interfacial_dmi: Some(2.0e-3),
        bulk_dmi: Some(-1.5e-3),
        dind_field: None,
        dbulk_field: None,
    });
    ir.materials[0].uniaxial_anisotropy = Some(2.5e4);
    ir.materials[0].damping = 0.5;
    ir.materials[0].anisotropy_axis = Some([0.0, 0.0, 1.0]);
    ir.materials[0].interfacial_dmi = Some(1.0e-3);
    ir.materials[0].bulk_dmi = Some(-0.5e-3);
    ir.geometry.entries.push(GeometryEntryIR::Box {
        name: "second".to_string(),
        size: [1.0, 1.0, 1.0],
    });
    ir.regions.push(fullmag_ir::RegionIR {
        name: "second".to_string(),
        geometry: "second".to_string(),
    });
    ir.magnets.push(fullmag_ir::MagnetIR {
        name: "second".to_string(),
        region: "second".to_string(),
        material: "Co".to_string(),
        initial_magnetization: Some(InitialMagnetizationIR::Uniform {
            value: [0.0, 1.0, 0.0],
        }),
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![
            fullmag_ir::FemMeshAssetIR {
                geometry_name: "strip".to_string(),
                mesh_source: None,
                mesh: Some(fullmag_ir::MeshIR {
                    mesh_name: "strip".to_string(),
                    nodes: vec![
                        [0.0, 0.0, 0.0],
                        [1.0, 0.0, 0.0],
                        [0.0, 1.0, 0.0],
                        [0.0, 0.0, 1.0],
                    ],
                    elements: vec![[0, 1, 2, 3]],
                    element_markers: vec![1],
                    boundary_faces: vec![[0, 1, 2]],
                    boundary_markers: vec![1],
                    periodic_boundary_pairs: Vec::new(),
                    periodic_node_pairs: Vec::new(),
                    per_domain_quality: std::collections::HashMap::new(),
                }),
            },
            fullmag_ir::FemMeshAssetIR {
                geometry_name: "second".to_string(),
                mesh_source: None,
                mesh: Some(fullmag_ir::MeshIR {
                    mesh_name: "second".to_string(),
                    nodes: vec![
                        [0.0, 0.0, 2.0],
                        [1.0, 0.0, 2.0],
                        [0.0, 1.0, 2.0],
                        [0.0, 0.0, 3.0],
                    ],
                    elements: vec![[0, 1, 2, 3]],
                    element_markers: vec![1],
                    boundary_faces: vec![[0, 1, 2]],
                    boundary_markers: vec![1],
                    periodic_boundary_pairs: Vec::new(),
                    periodic_node_pairs: Vec::new(),
                    per_domain_quality: std::collections::HashMap::new(),
                }),
            },
        ],
        fem_domain_mesh_asset: None,
    });

    let planned = plan(&ir).expect("heterogeneous FEM should plan on CUDA");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("expected FEM plan");
    };

    assert_eq!(fem.region_materials.len(), 2);
    assert_eq!(fem.region_materials[0].object_id, "strip");
    assert_eq!(fem.region_materials[1].object_id, "second");
    assert_eq!(fem.mesh_parts.len(), 2);
    assert_eq!(fem.mesh_parts[0].material_id.as_deref(), Some("Py"));
    assert_eq!(fem.mesh_parts[1].material_id.as_deref(), Some("Co"));
    assert!(fem.material.ms_field.is_some());
    assert_eq!(fem.interfacial_dmi, Some(1.0e-3));
    assert_eq!(fem.bulk_dmi, Some(-0.5e-3));
    assert_eq!(
        fem.dind_field.as_ref().map(|values| values.as_slice()),
        Some([1.0e-3, 1.0e-3, 1.0e-3, 1.0e-3, 2.0e-3, 2.0e-3, 2.0e-3, 2.0e-3].as_slice())
    );
    assert_eq!(
        fem.dbulk_field.as_ref().map(|values| values.as_slice()),
        Some([-0.5e-3, -0.5e-3, -0.5e-3, -0.5e-3, -1.5e-3, -1.5e-3, -1.5e-3, -1.5e-3].as_slice())
    );
}

#[test]
fn fem_plan_conformal_shared_domain_duplicates_interface_nodes_for_cuda() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda", "device_index": 0}),
    );
    ir.geometry.entries.push(GeometryEntryIR::Box {
        name: "second".to_string(),
        size: [1.0, 1.0, 1.0],
    });
    ir.regions.push(fullmag_ir::RegionIR {
        name: "second".to_string(),
        geometry: "second".to_string(),
    });
    ir.magnets.push(fullmag_ir::MagnetIR {
        name: "second".to_string(),
        region: "second".to_string(),
        material: "Py".to_string(),
        initial_magnetization: Some(InitialMagnetizationIR::Uniform {
            value: [0.0, 1.0, 0.0],
        }),
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![],
        fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "touching".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [0.0, 0.0, -1.0],
                ],
                elements: vec![[0, 1, 2, 3], [0, 1, 2, 4]],
                element_markers: vec![1, 2],
                boundary_faces: vec![[0, 1, 3], [0, 1, 4]],
                boundary_markers: vec![10, 20],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![
                fullmag_ir::FemDomainRegionMarkerIR {
                    geometry_name: "strip".to_string(),
                    marker: 1,
                },
                fullmag_ir::FemDomainRegionMarkerIR {
                    geometry_name: "second".to_string(),
                    marker: 2,
                },
            ],
            build_report: None,
        }),
    });
    ir.energy_terms = vec![fullmag_ir::EnergyTermIR::Exchange];

    let planned = plan(&ir).expect("CUDA FEM should accept conformal shared-domain meshes");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("expected FEM plan");
    };

    assert_eq!(fem.mesh.nodes.len(), 8);
    assert_eq!(fem.object_segments.len(), 2);
    assert_eq!(fem.object_segments[0].object_id, "strip");
    assert_eq!(fem.object_segments[0].node_count, 4);
    assert_eq!(fem.object_segments[1].object_id, "second");
    assert_eq!(fem.object_segments[1].node_count, 4);
}

#[test]
fn fem_plan_four_body_shared_domain_populates_region_materials_on_cuda() {
    // Reproducer for: "ambiguous FEM magnetic region contract: mesh uses
    // multiple non-zero element markers {1, 2, 3, 4} without region_materials"
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda", "device_index": 0}),
    );

    // Add 3 more bodies (bootstrap already has 1)
    for idx in 1..4u32 {
        let geom_name = format!("nanoflower_{idx}_geom");
        let magnet_name = format!("nanoflower_{idx}");
        ir.geometry.entries.push(GeometryEntryIR::Box {
            name: geom_name.clone(),
            size: [1.0, 1.0, 1.0],
        });
        ir.regions.push(fullmag_ir::RegionIR {
            name: magnet_name.clone(),
            geometry: geom_name.clone(),
        });
        ir.magnets.push(fullmag_ir::MagnetIR {
            name: magnet_name.clone(),
            region: magnet_name.clone(),
            material: "Py".to_string(),
            initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                value: [0.0, 0.0, 1.0],
            }),
        });
    }

    // Rename the bootstrap body for consistency
    ir.geometry.entries[0] = GeometryEntryIR::Box {
        name: "nanoflower_0_geom".to_string(),
        size: [1.0, 1.0, 1.0],
    };
    ir.regions[0] = fullmag_ir::RegionIR {
        name: "strip".to_string(),
        geometry: "nanoflower_0_geom".to_string(),
    };
    ir.magnets[0].initial_magnetization = Some(InitialMagnetizationIR::Uniform {
        value: [0.0, 0.0, 1.0],
    });

    // Build a shared-domain mesh with 4 bodies + air
    // 5 tets: 4 magnetic (markers 1,2,3,4) + 1 air (marker 0)
    let nodes = vec![
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [2.0, 0.0, 0.0],
        [0.0, 2.0, 0.0],
        [0.0, 0.0, 2.0],
        [3.0, 0.0, 0.0],
        [0.0, 0.0, -1.0],
    ];
    let elements = vec![
        [0, 1, 2, 3],
        [0, 4, 2, 3],
        [0, 1, 5, 3],
        [0, 1, 2, 6],
        [0, 7, 2, 8],
    ];
    let element_markers = vec![1, 2, 3, 4, 0];

    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![],
        fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "study_domain".to_string(),
                nodes,
                elements,
                element_markers,
                boundary_faces: vec![[0, 1, 2]],
                boundary_markers: vec![1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![
                fullmag_ir::FemDomainRegionMarkerIR {
                    geometry_name: "nanoflower_0_geom".to_string(),
                    marker: 1,
                },
                fullmag_ir::FemDomainRegionMarkerIR {
                    geometry_name: "nanoflower_1_geom".to_string(),
                    marker: 2,
                },
                fullmag_ir::FemDomainRegionMarkerIR {
                    geometry_name: "nanoflower_2_geom".to_string(),
                    marker: 3,
                },
                fullmag_ir::FemDomainRegionMarkerIR {
                    geometry_name: "nanoflower_3_geom".to_string(),
                    marker: 4,
                },
            ],
            build_report: None,
        }),
    });
    ir.energy_terms = vec![fullmag_ir::EnergyTermIR::Exchange];

    let planned = plan(&ir).expect("4-body shared-domain FEM should plan on CUDA");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("expected FEM plan");
    };

    // Must have 4 object segments + implicit air
    assert!(
        fem.object_segments.len() >= 4,
        "expected >=4 object_segments, got {}",
        fem.object_segments.len()
    );
    // Must have region_materials so the runner knows which markers are magnetic
    assert_eq!(
        fem.region_materials.len(),
        4,
        "expected 4 region_materials, got {}: {:?}",
        fem.region_materials.len(),
        fem.region_materials
    );
}

#[test]
fn random_seeded_generates_correct_count() {
    let vectors = generate_random_unit_vectors(42, 100);
    assert_eq!(vectors.len(), 100);
    for v in &vectors {
        let norm = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        assert!((norm - 1.0).abs() < 1e-10, "vector not unit: norm={}", norm);
    }
}

#[test]
fn inactive_term_output_is_rejected_for_execution() {
    let mut ir = ProblemIR::bootstrap_example();
    let mut outputs = ir.study.sampling().outputs.clone();
    outputs.push(OutputIR::Field {
        name: "H_demag".to_string(),
        every_seconds: 1e-12,
    });
    ir.study = fullmag_ir::StudyIR::TimeEvolution {
        dynamics: ir.study.dynamics().clone(),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            outputs,
        },
    };

    let err = plan(&ir).expect_err("output requiring inactive term should be rejected");
    assert!(err
        .reasons
        .iter()
        .any(|reason| reason.contains("requires Demag()")));
}

fn attach_unit_fem_domain_mesh(ir: &mut ProblemIR) {
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![],
        fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                elements: vec![[0, 1, 2, 3]],
                element_markers: vec![1],
                boundary_faces: vec![[0, 1, 2]],
                boundary_markers: vec![1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            build_report: None,
        }),
    });
}

#[test]
fn fem_dmi_field_outputs_require_matching_dmi_terms() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    attach_unit_fem_domain_mesh(&mut ir);
    ir.study = fullmag_ir::StudyIR::TimeEvolution {
        dynamics: ir.study.dynamics().clone(),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            outputs: vec![
                OutputIR::Field {
                    name: "H_dmi".to_string(),
                    every_seconds: 1e-12,
                },
                OutputIR::Field {
                    name: "H_dmi_bulk".to_string(),
                    every_seconds: 1e-12,
                },
            ],
        },
    };

    let err = plan(&ir).expect_err("DMI field outputs require active DMI terms");
    assert!(err
        .reasons
        .iter()
        .any(|reason| reason.contains("field output 'H_dmi' requires InterfacialDmi")));
    assert!(err
        .reasons
        .iter()
        .any(|reason| reason.contains("field output 'H_dmi_bulk' requires BulkDmi")));
}

#[test]
fn fem_bulk_dmi_field_output_plans_when_bulk_dmi_is_active() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    attach_unit_fem_domain_mesh(&mut ir);
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::BulkDmi { d: 2.0e-3 },
    ];
    ir.study = fullmag_ir::StudyIR::TimeEvolution {
        dynamics: ir.study.dynamics().clone(),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            outputs: vec![OutputIR::Field {
                name: "H_dmi_bulk".to_string(),
                every_seconds: 1e-12,
            }],
        },
    };

    let planned = plan(&ir).expect("active bulk DMI should allow H_dmi_bulk field output");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("expected FEM plan");
    };
    assert_eq!(fem.bulk_dmi, Some(2.0e-3));
}

#[test]
fn fem_material_dmi_constants_lower_to_native_plan() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    attach_unit_fem_domain_mesh(&mut ir);
    ir.materials[0].interfacial_dmi = Some(-1.5e-3);
    ir.materials[0].bulk_dmi = Some(2.5e-3);
    ir.study = fullmag_ir::StudyIR::TimeEvolution {
        dynamics: ir.study.dynamics().clone(),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            outputs: vec![
                OutputIR::Field {
                    name: "H_dmi".to_string(),
                    every_seconds: 1e-12,
                },
                OutputIR::Field {
                    name: "H_dmi_bulk".to_string(),
                    every_seconds: 1e-12,
                },
            ],
        },
    };

    let planned = plan(&ir).expect("material DMI constants should lower into FEM plan");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("expected FEM plan");
    };
    assert_eq!(fem.interfacial_dmi, Some(-1.5e-3));
    assert_eq!(fem.dmi_interface_normal, Some([0.0, 0.0, 1.0]));
    assert_eq!(fem.bulk_dmi, Some(2.5e-3));
}

#[test]
fn llg_overdamped_relaxation_lowers_to_relaxation_control() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = fullmag_ir::StudyIR::Relaxation {
        algorithm: fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped,
        dynamics: ir.study.dynamics().clone(),
        stop: fullmag_ir::RelaxStopIR {
            torque_tolerance_apm: Some(1e-3),
            energy_tolerance_j: Some(1e-12),
            max_steps: Some(250),
            max_pseudotime_s: None,
            max_physical_time_s: None,
        },
        sampling: ir.study.sampling().clone(),
    };

    let plan = plan(&ir).expect("llg_overdamped relaxation should be plannable");
    match plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            let control = fdm.relaxation.expect("relaxation control");
            assert_eq!(
                control.algorithm,
                fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped
            );
            assert_eq!(control.stop.max_steps, Some(250));
            assert_eq!(control.stop.energy_tolerance_j, Some(1e-12));
        }
        _ => panic!("expected FDM plan"),
    }
}

#[test]
fn projected_gradient_bb_is_now_plannable() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = fullmag_ir::StudyIR::Relaxation {
        algorithm: fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
        dynamics: ir.study.dynamics().clone(),
        stop: fullmag_ir::RelaxStopIR {
            torque_tolerance_apm: Some(1e-3),
            energy_tolerance_j: None,
            max_steps: Some(250),
            max_pseudotime_s: None,
            max_physical_time_s: None,
        },
        sampling: ir.study.sampling().clone(),
    };

    let plan = plan(&ir).expect("projected_gradient_bb should now plan successfully");
    match plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            let control = fdm.relaxation.expect("relaxation control");
            assert_eq!(
                control.algorithm,
                fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb
            );
        }
        _ => panic!("expected FDM plan"),
    }
}

#[test]
fn nonlinear_cg_is_now_plannable() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = fullmag_ir::StudyIR::Relaxation {
        algorithm: fullmag_ir::RelaxationAlgorithmIR::NonlinearCg,
        dynamics: ir.study.dynamics().clone(),
        stop: fullmag_ir::RelaxStopIR {
            torque_tolerance_apm: Some(1e-3),
            energy_tolerance_j: None,
            max_steps: Some(250),
            max_pseudotime_s: None,
            max_physical_time_s: None,
        },
        sampling: ir.study.sampling().clone(),
    };

    let plan = plan(&ir).expect("nonlinear_cg should now plan successfully");
    match plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            let control = fdm.relaxation.expect("relaxation control");
            assert_eq!(
                control.algorithm,
                fullmag_ir::RelaxationAlgorithmIR::NonlinearCg
            );
        }
        _ => panic!("expected FDM plan"),
    }
}

#[test]
fn tangent_plane_implicit_is_now_plannable_for_fem() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    attach_unit_fem_domain_mesh(&mut ir);
    ir.study = fullmag_ir::StudyIR::Relaxation {
        algorithm: fullmag_ir::RelaxationAlgorithmIR::TangentPlaneImplicit,
        dynamics: ir.study.dynamics().clone(),
        stop: fullmag_ir::RelaxStopIR {
            torque_tolerance_apm: Some(1e-3),
            energy_tolerance_j: None,
            max_steps: Some(250),
            max_pseudotime_s: None,
            max_physical_time_s: None,
        },
        sampling: ir.study.sampling().clone(),
    };

    let plan = plan(&ir).expect("tangent_plane_implicit should now plan on FEM");
    match plan.backend_plan {
        BackendPlanIR::Fem(fem) => {
            let control = fem.relaxation.expect("relaxation control");
            assert_eq!(
                control.algorithm,
                fullmag_ir::RelaxationAlgorithmIR::TangentPlaneImplicit
            );
            assert_eq!(control.stop.max_steps, Some(250));
        }
        _ => panic!("expected FEM plan"),
    }
}

#[test]
fn tangent_plane_implicit_is_rejected_for_fdm() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = fullmag_ir::StudyIR::Relaxation {
        algorithm: fullmag_ir::RelaxationAlgorithmIR::TangentPlaneImplicit,
        dynamics: ir.study.dynamics().clone(),
        stop: fullmag_ir::RelaxStopIR {
            torque_tolerance_apm: Some(1e-3),
            energy_tolerance_j: None,
            max_steps: Some(250),
            max_pseudotime_s: None,
            max_physical_time_s: None,
        },
        sampling: ir.study.sampling().clone(),
    };

    let err = plan(&ir).expect_err("tangent_plane_implicit should be FEM-only");
    assert!(err.reasons.iter().any(|reason| {
        reason.contains("tangent_plane_implicit")
            && reason.contains("FEM-only")
            && reason.contains("backend='fem'")
            && reason.contains("under development")
            && reason.contains("not production-qualified")
    }));
}

#[test]
fn single_precision_is_rejected_for_phase_one_cpu_execution() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 5e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: None,
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![],
        fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [-2.0, -2.0, -2.0],
                    [2.0, -2.0, -2.0],
                    [-2.0, 2.0, -2.0],
                    [-2.0, -2.0, 2.0],
                ],
                elements: vec![[0, 1, 2, 3], [4, 5, 6, 7]],
                element_markers: vec![1, 0],
                boundary_faces: vec![[0, 1, 2], [4, 5, 6]],
                boundary_markers: vec![1, 99],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            build_report: None,
        }),
    });
    ir.energy_terms = vec![fullmag_ir::EnergyTermIR::Exchange];
    ir.backend_policy.execution_precision = ExecutionPrecision::Single;

    let err = crate::fem::plan_fem(&ir, BackendTarget::Fem)
        .expect_err("single precision should not be executable on FEM CPU path");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("execution_precision='single'")
                && reason.contains("CPU path")
                && reason.contains("supports only 'double'")
        }),
        "unexpected FEM CPU reasons: {:?}",
        err.reasons
    );
}

#[test]
fn single_precision_is_rejected_with_gpu_specific_reason_when_cuda_device_requested() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 5e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: None,
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![],
        fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [-2.0, -2.0, -2.0],
                    [2.0, -2.0, -2.0],
                    [-2.0, 2.0, -2.0],
                    [-2.0, -2.0, 2.0],
                ],
                elements: vec![[0, 1, 2, 3], [4, 5, 6, 7]],
                element_markers: vec![1, 0],
                boundary_faces: vec![[0, 1, 2], [4, 5, 6]],
                boundary_markers: vec![1, 99],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            build_report: None,
        }),
    });
    ir.energy_terms = vec![fullmag_ir::EnergyTermIR::Exchange];
    ir.backend_policy.execution_precision = ExecutionPrecision::Single;
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda", "device_index": 0}),
    );

    let err = crate::fem::plan_fem(&ir, BackendTarget::Fem)
        .expect_err("single precision should be rejected honestly on FEM GPU");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("execution_precision='single'")
                && reason.contains("GPU path")
                && reason.contains("single-precision CUDA kernels are not yet implemented")
        }),
        "unexpected FEM GPU reasons: {:?}",
        err.reasons
    );
}

#[test]
fn multilayer_single_precision_is_rejected_without_cuda_device_request() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.geometry.entries = vec![
        GeometryEntryIR::Translate {
            name: "free_geom".to_string(),
            base: std::boxed::Box::new(GeometryEntryIR::Box {
                name: "free_base".to_string(),
                size: [40e-9, 20e-9, 2e-9],
            }),
            by: [0.0, 0.0, 0.0],
        },
        GeometryEntryIR::Translate {
            name: "ref_geom".to_string(),
            base: std::boxed::Box::new(GeometryEntryIR::Box {
                name: "ref_base".to_string(),
                size: [40e-9, 20e-9, 2e-9],
            }),
            by: [0.0, 0.0, 4e-9],
        },
    ];
    ir.regions = vec![
        fullmag_ir::RegionIR {
            name: "free_region".to_string(),
            geometry: "free_geom".to_string(),
        },
        fullmag_ir::RegionIR {
            name: "ref_region".to_string(),
            geometry: "ref_geom".to_string(),
        },
    ];
    ir.magnets = vec![
        fullmag_ir::MagnetIR {
            name: "free".to_string(),
            region: "free_region".to_string(),
            material: "Py".to_string(),
            initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                value: [1.0, 0.0, 0.0],
            }),
        },
        fullmag_ir::MagnetIR {
            name: "ref".to_string(),
            region: "ref_region".to_string(),
            material: "Py".to_string(),
            initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                value: [0.0, 1.0, 0.0],
            }),
        },
    ];
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::Auto,
        },
    ];
    ir.backend_policy.execution_precision = ExecutionPrecision::Single;
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 2e-9],
            default_cell: Some([2e-9, 2e-9, 2e-9]),
            per_magnet: None,
            demag: Some(fullmag_ir::FdmDemagHintsIR {
                strategy: "multilayer_convolution".to_string(),
                mode: "two_d_stack".to_string(),
                allow_single_grid_fallback: false,
                common_cells: None,
                common_cells_xy: None,
            }),
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: None,
        hybrid: None,
    });

    let err = plan(&ir).expect_err("multilayer single precision should be rejected on CPU");
    assert!(err.reasons.iter().any(|reason| {
        reason.contains("execution_precision='single'")
            && reason.contains("CPU reference multilayer FDM runner")
    }));
}

#[test]
fn multilayer_single_precision_is_accepted_when_cuda_device_requested() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.geometry.entries = vec![
        GeometryEntryIR::Translate {
            name: "free_geom".to_string(),
            base: std::boxed::Box::new(GeometryEntryIR::Box {
                name: "free_base".to_string(),
                size: [40e-9, 20e-9, 2e-9],
            }),
            by: [0.0, 0.0, 0.0],
        },
        GeometryEntryIR::Translate {
            name: "ref_geom".to_string(),
            base: std::boxed::Box::new(GeometryEntryIR::Box {
                name: "ref_base".to_string(),
                size: [40e-9, 20e-9, 2e-9],
            }),
            by: [0.0, 0.0, 4e-9],
        },
    ];
    ir.regions = vec![
        fullmag_ir::RegionIR {
            name: "free_region".to_string(),
            geometry: "free_geom".to_string(),
        },
        fullmag_ir::RegionIR {
            name: "ref_region".to_string(),
            geometry: "ref_geom".to_string(),
        },
    ];
    ir.magnets = vec![
        fullmag_ir::MagnetIR {
            name: "free".to_string(),
            region: "free_region".to_string(),
            material: "Py".to_string(),
            initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                value: [1.0, 0.0, 0.0],
            }),
        },
        fullmag_ir::MagnetIR {
            name: "ref".to_string(),
            region: "ref_region".to_string(),
            material: "Py".to_string(),
            initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                value: [0.0, 1.0, 0.0],
            }),
        },
    ];
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::Auto,
        },
    ];
    ir.backend_policy.execution_precision = ExecutionPrecision::Single;
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda", "device_index": 0}),
    );
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 2e-9],
            default_cell: Some([2e-9, 2e-9, 2e-9]),
            per_magnet: None,
            demag: Some(fullmag_ir::FdmDemagHintsIR {
                strategy: "multilayer_convolution".to_string(),
                mode: "two_d_stack".to_string(),
                allow_single_grid_fallback: false,
                common_cells: None,
                common_cells_xy: None,
            }),
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: None,
        hybrid: None,
    });

    let result = plan(&ir);
    assert!(
        result.is_ok()
            || !result
                .as_ref()
                .unwrap_err()
                .reasons
                .iter()
                .any(|reason| reason.contains("execution_precision='single'")),
        "planner should not reject multilayer single precision when CUDA device is requested"
    );
}

fn stacked_two_body_multilayer_problem() -> ProblemIR {
    let mut ir = ProblemIR::bootstrap_example();
    ir.geometry.entries = vec![
        GeometryEntryIR::Translate {
            name: "free_geom".to_string(),
            base: std::boxed::Box::new(GeometryEntryIR::Box {
                name: "free_base".to_string(),
                size: [40e-9, 20e-9, 2e-9],
            }),
            by: [0.0, 0.0, 0.0],
        },
        GeometryEntryIR::Translate {
            name: "ref_geom".to_string(),
            base: std::boxed::Box::new(GeometryEntryIR::Box {
                name: "ref_base".to_string(),
                size: [40e-9, 20e-9, 2e-9],
            }),
            by: [0.0, 0.0, 4e-9],
        },
    ];
    ir.regions = vec![
        fullmag_ir::RegionIR {
            name: "free_region".to_string(),
            geometry: "free_geom".to_string(),
        },
        fullmag_ir::RegionIR {
            name: "ref_region".to_string(),
            geometry: "ref_geom".to_string(),
        },
    ];
    ir.magnets = vec![
        fullmag_ir::MagnetIR {
            name: "free".to_string(),
            region: "free_region".to_string(),
            material: "Py".to_string(),
            initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                value: [1.0, 0.0, 0.0],
            }),
        },
        fullmag_ir::MagnetIR {
            name: "ref".to_string(),
            region: "ref_region".to_string(),
            material: "Py".to_string(),
            initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                value: [0.0, 1.0, 0.0],
            }),
        },
    ];
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::Auto,
        },
    ];
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 2e-9],
            default_cell: Some([2e-9, 2e-9, 2e-9]),
            per_magnet: None,
            demag: Some(fullmag_ir::FdmDemagHintsIR {
                strategy: "multilayer_convolution".to_string(),
                mode: "two_d_stack".to_string(),
                allow_single_grid_fallback: false,
                common_cells: None,
                common_cells_xy: None,
            }),
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: None,
        hybrid: None,
    });
    ir
}

#[test]
fn multilayer_planner_rejects_thermal_noise_until_rhs_coverage_exists() {
    let mut ir = stacked_two_body_multilayer_problem();
    ir.temperature = Some(300.0);

    let err = plan(&ir).expect_err("multilayer thermal noise must not be silently ignored");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("thermal_noise") && reason.contains("multilayer FDM")
        }),
        "unexpected planner errors: {:?}",
        err.reasons
    );
}

#[test]
fn multilayer_planner_rejects_spatial_material_fields_until_rhs_coverage_exists() {
    let mut ir = stacked_two_body_multilayer_problem();
    ir.materials[0].kc1_field = Some(vec![1.0e4; 4]);

    let err = plan(&ir).expect_err("multilayer material fields must not be silently ignored");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("per-cell material fields")
                && reason.contains("kc1_field")
                && reason.contains("multilayer FDM")
        }),
        "unexpected planner errors: {:?}",
        err.reasons
    );
}

#[test]
fn multilayer_planner_rejects_legacy_stt_until_rhs_coverage_exists() {
    let mut ir = stacked_two_body_multilayer_problem();
    ir.current_density = Some([1.0e12, 0.0, 0.0]);
    ir.stt_degree = Some(0.4);
    ir.stt_beta = Some(0.1);

    let err = plan(&ir).expect_err("multilayer STT must not be silently ignored");
    assert!(
        err.reasons
            .iter()
            .any(|reason| reason.contains("spin_torque") && reason.contains("multilayer FDM")),
        "unexpected planner errors: {:?}",
        err.reasons
    );
}

#[test]
fn multilayer_planner_rejects_oersted_until_rhs_coverage_exists() {
    let mut ir = stacked_two_body_multilayer_problem();
    ir.energy_terms.push(EnergyTermIR::OerstedCylinder {
        current: 1.5e-3,
        radius: 20e-9,
        center: [20e-9, 10e-9, 0.0],
        axis: [0.0, 0.0, 1.0],
        time_dependence: None,
    });

    let err = plan(&ir).expect_err("multilayer Oersted must not be silently ignored");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("Oersted")
                && reason.contains("multilayer FDM")
                && reason.contains("RHS coverage")
        }),
        "unexpected planner errors: {:?}",
        err.reasons
    );
    assert!(
        !err.reasons
            .iter()
            .any(|reason| reason.contains("semantic-only")),
        "Oersted rejection must use an explicit executable-coverage diagnostic: {:?}",
        err.reasons
    );
}

#[test]
fn stacked_two_body_problem_lowers_to_multilayer_plan() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.geometry.entries = vec![
        GeometryEntryIR::Translate {
            name: "free_geom".to_string(),
            base: std::boxed::Box::new(GeometryEntryIR::Box {
                name: "free_base".to_string(),
                size: [40e-9, 20e-9, 2e-9],
            }),
            by: [0.0, 0.0, 0.0],
        },
        GeometryEntryIR::Translate {
            name: "ref_geom".to_string(),
            base: std::boxed::Box::new(GeometryEntryIR::Box {
                name: "ref_base".to_string(),
                size: [40e-9, 20e-9, 2e-9],
            }),
            by: [0.0, 0.0, 4e-9],
        },
    ];
    ir.regions = vec![
        fullmag_ir::RegionIR {
            name: "free_region".to_string(),
            geometry: "free_geom".to_string(),
        },
        fullmag_ir::RegionIR {
            name: "ref_region".to_string(),
            geometry: "ref_geom".to_string(),
        },
    ];
    ir.magnets = vec![
        fullmag_ir::MagnetIR {
            name: "free".to_string(),
            region: "free_region".to_string(),
            material: "Py".to_string(),
            initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                value: [1.0, 0.0, 0.0],
            }),
        },
        fullmag_ir::MagnetIR {
            name: "ref".to_string(),
            region: "ref_region".to_string(),
            material: "Py".to_string(),
            initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                value: [0.0, 1.0, 0.0],
            }),
        },
    ];
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::InterfacialDmi {
            d: 1.5e-3,
            interface_normal: None,
        },
        fullmag_ir::EnergyTermIR::BulkDmi { d: 2.5e-3 },
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::Auto,
        },
    ];
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 2e-9],
            default_cell: Some([2e-9, 2e-9, 2e-9]),
            per_magnet: None,
            demag: Some(fullmag_ir::FdmDemagHintsIR {
                strategy: "multilayer_convolution".to_string(),
                mode: "two_d_stack".to_string(),
                allow_single_grid_fallback: false,
                common_cells: None,
                common_cells_xy: None,
            }),
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: None,
        hybrid: None,
    });
    if let fullmag_ir::StudyIR::TimeEvolution {
        dynamics:
            fullmag_ir::DynamicsIR::Llg {
                integrator,
                fixed_timestep,
                ..
            },
        ..
    } = &mut ir.study
    {
        *integrator = "rk4".to_string();
        *fixed_timestep = Some(2e-13);
    }

    let planned = plan(&ir).expect("stacked two-body problem should lower");
    match planned.backend_plan {
        BackendPlanIR::FdmMultilayer(multilayer) => {
            assert_eq!(multilayer.layers.len(), 2);
            assert_eq!(multilayer.integrator, fullmag_ir::IntegratorChoice::Rk4);
            assert_eq!(multilayer.fixed_timestep, Some(2e-13));
            assert_eq!(multilayer.common_cells, [20, 10, 1]);
            for (actual, expected) in multilayer.layers[0]
                .native_origin
                .iter()
                .zip([-20e-9, -10e-9, -1e-9].iter())
            {
                assert!((actual - expected).abs() < 1e-18);
            }
            for (actual, expected) in multilayer.layers[1]
                .native_origin
                .iter()
                .zip([-20e-9, -10e-9, 3e-9].iter())
            {
                assert!((actual - expected).abs() < 1e-18);
            }
            assert_eq!(
                multilayer.planner_summary.selected_strategy,
                "multilayer_convolution"
            );
            assert_eq!(multilayer.interfacial_dmi, Some(1.5e-3));
            assert_eq!(multilayer.bulk_dmi, Some(2.5e-3));
        }
        other => panic!("expected FDM multilayer plan, got {other:?}"),
    }

    if let fullmag_ir::StudyIR::TimeEvolution {
        dynamics:
            fullmag_ir::DynamicsIR::Llg {
                integrator,
                fixed_timestep,
                ..
            },
        ..
    } = &mut ir.study
    {
        *integrator = "rk45".to_string();
        *fixed_timestep = Some(1e-13);
    }
    let cpu_plan = plan(&ir).expect("fixed-step CPU multilayer RK45 should lower");
    match cpu_plan.backend_plan {
        BackendPlanIR::FdmMultilayer(multilayer) => {
            assert_eq!(multilayer.integrator, fullmag_ir::IntegratorChoice::Rk45);
        }
        other => panic!("expected FDM multilayer plan, got {other:?}"),
    }

    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({ "device": "cuda" }),
    );
    let cuda_plan = plan(&ir).expect("native-stacked CUDA multilayer RK45 should lower");
    match cuda_plan.backend_plan {
        BackendPlanIR::FdmMultilayer(multilayer) => {
            assert_eq!(multilayer.integrator, fullmag_ir::IntegratorChoice::Rk45);
        }
        other => panic!("expected FDM multilayer plan, got {other:?}"),
    }

    ir.materials.push(fullmag_ir::MaterialIR {
        name: "CoFeB".to_string(),
        saturation_magnetisation: 1.1e6,
        exchange_stiffness: 20e-12,
        damping: 0.03,
        ..ir.materials[0].clone()
    });
    ir.magnets[1].material = "CoFeB".to_string();
    if let fullmag_ir::StudyIR::TimeEvolution {
        dynamics:
            fullmag_ir::DynamicsIR::Llg {
                integrator,
                fixed_timestep,
                ..
            },
        ..
    } = &mut ir.study
    {
        *integrator = "rk23".to_string();
        *fixed_timestep = Some(1e-13);
    }
    let staged_rk23 =
        plan(&ir).expect("heterogeneous CUDA multilayer fixed-step RK23 should lower");
    match staged_rk23.backend_plan {
        BackendPlanIR::FdmMultilayer(multilayer) => {
            assert_eq!(multilayer.integrator, fullmag_ir::IntegratorChoice::Rk23);
            assert_eq!(multilayer.fixed_timestep, Some(1e-13));
        }
        other => panic!("expected FDM multilayer plan, got {other:?}"),
    }
    if let fullmag_ir::StudyIR::TimeEvolution {
        dynamics: fullmag_ir::DynamicsIR::Llg { integrator, .. },
        ..
    } = &mut ir.study
    {
        *integrator = "rk45".to_string();
    }
    let err = plan(&ir).expect_err("heterogeneous CUDA multilayer RK45 should remain unsupported");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("staged v2") && reason.contains("'heun', 'rk4', and fixed-step 'rk23'")
        }),
        "unexpected planner errors: {:?}",
        err.reasons
    );
}

#[test]
fn multilayer_planner_rejects_xy_offset() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.geometry.entries = vec![
        GeometryEntryIR::Translate {
            name: "free_geom".to_string(),
            base: std::boxed::Box::new(GeometryEntryIR::Box {
                name: "free_base".to_string(),
                size: [40e-9, 20e-9, 2e-9],
            }),
            by: [0.0, 0.0, 0.0],
        },
        GeometryEntryIR::Translate {
            name: "ref_geom".to_string(),
            base: std::boxed::Box::new(GeometryEntryIR::Box {
                name: "ref_base".to_string(),
                size: [40e-9, 20e-9, 2e-9],
            }),
            by: [10e-9, 0.0, 4e-9],
        },
    ];
    ir.regions = vec![
        fullmag_ir::RegionIR {
            name: "free_region".to_string(),
            geometry: "free_geom".to_string(),
        },
        fullmag_ir::RegionIR {
            name: "ref_region".to_string(),
            geometry: "ref_geom".to_string(),
        },
    ];
    ir.magnets = vec![
        fullmag_ir::MagnetIR {
            name: "free".to_string(),
            region: "free_region".to_string(),
            material: "Py".to_string(),
            initial_magnetization: None,
        },
        fullmag_ir::MagnetIR {
            name: "ref".to_string(),
            region: "ref_region".to_string(),
            material: "Py".to_string(),
            initial_magnetization: None,
        },
    ];
    ir.energy_terms = vec![fullmag_ir::EnergyTermIR::Demag {
        realization: fullmag_ir::RequestedFemDemagIR::Auto,
    }];

    let err = plan(&ir).expect_err("XY-offset multilayer problem should be rejected");
    assert!(err
        .reasons
        .iter()
        .any(|reason| reason.contains("share the same XY center")));
}

#[test]
fn fem_eigen_backend_with_mesh_asset_plans_successfully() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 5e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: Some("meshes/unit_tet.msh".to_string()),
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![fullmag_ir::FemMeshAssetIR {
            geometry_name: "strip".to_string(),
            mesh_source: Some("meshes/unit_tet.msh".to_string()),
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                elements: vec![[0, 1, 2, 3]],
                element_markers: vec![1],
                boundary_faces: vec![[0, 1, 2]],
                boundary_markers: vec![1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
        }],
        fem_domain_mesh_asset: None,
    });
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::InterfacialDmi {
            d: 2.5e-3,
            interface_normal: Some([0.0, 3.0, 4.0]),
        },
    ];
    ir.study = fullmag_ir::StudyIR::Eigenmodes {
        dynamics: ir.study.dynamics().clone(),
        operator: fullmag_ir::EigenOperatorConfigIR {
            kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 5,
        target: fullmag_ir::EigenTargetIR::Lowest,
        equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
        k_sampling: Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        }),
        normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
        damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            outputs: vec![
                fullmag_ir::OutputIR::EigenSpectrum {
                    quantity: "eigenfrequency".to_string(),
                },
                fullmag_ir::OutputIR::EigenMode {
                    field: "mode".to_string(),
                    indices: vec![0, 1],
                },
            ],
        },
        mode_tracking: None,
    };

    let plan = plan(&ir).expect("FEM eigen mesh asset should produce a FemEigenPlanIR");
    match plan.backend_plan {
        BackendPlanIR::FemEigen(fem) => {
            assert_eq!(fem.mesh.mesh_name, "strip");
            assert_eq!(fem.mesh.nodes.len(), 4);
            assert_eq!(fem.count, 5);
            assert_eq!(fem.target, fullmag_ir::EigenTargetIR::Lowest);
            assert!(fem.enable_exchange);
            assert!(!fem.enable_demag);
            assert_eq!(fem.normalization, fullmag_ir::EigenNormalizationIR::UnitL2);
            assert_eq!(fem.interfacial_dmi, Some(2.5e-3));
            let normal = fem
                .dmi_interface_normal
                .expect("planner should propagate normalized iDMI interface_normal");
            assert!(normal[0].abs() <= 1e-12);
            assert!((normal[1] - 0.6).abs() <= 1e-12);
            assert!((normal[2] - 0.8).abs() <= 1e-12);
        }
        other => panic!("expected FEM eigen plan, got {other:?}"),
    }
}

#[test]
fn fem_eigen_backend_interfacial_dmi_defaults_interface_normal_to_z_in_strict_mode() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 5e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: Some("meshes/unit_tet.msh".to_string()),
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![fullmag_ir::FemMeshAssetIR {
            geometry_name: "strip".to_string(),
            mesh_source: Some("meshes/unit_tet.msh".to_string()),
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                elements: vec![[0, 1, 2, 3]],
                element_markers: vec![1],
                boundary_faces: vec![[0, 1, 2]],
                boundary_markers: vec![1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
        }],
        fem_domain_mesh_asset: None,
    });
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::InterfacialDmi {
            d: 3.0e-3,
            interface_normal: None,
        },
    ];
    ir.study = fullmag_ir::StudyIR::Eigenmodes {
        dynamics: ir.study.dynamics().clone(),
        operator: fullmag_ir::EigenOperatorConfigIR {
            kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 5,
        target: fullmag_ir::EigenTargetIR::Lowest,
        equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
        k_sampling: Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        }),
        normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
        damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            outputs: vec![fullmag_ir::OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            }],
        },
        mode_tracking: None,
    };

    let plan =
        plan(&ir).expect("strict FEM eigen planning should default missing iDMI normal to +z");
    match plan.backend_plan {
        BackendPlanIR::FemEigen(fem) => {
            assert_eq!(fem.interfacial_dmi, Some(3.0e-3));
            assert_eq!(fem.dmi_interface_normal, Some([0.0, 0.0, 1.0]));
        }
        other => panic!("expected FEM eigen plan, got {other:?}"),
    }
}

#[test]
fn fem_eigen_auto_demag_resolves_to_poisson_robin_on_shared_domain_mesh_with_air() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 5e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: Some("meshes/unit_tet.msh".to_string()),
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![],
        fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
            mesh_source: Some("meshes/unit_tet.msh".to_string()),
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip_air".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [-2.0, -2.0, -2.0],
                    [2.0, -2.0, -2.0],
                    [-2.0, 2.0, -2.0],
                    [-2.0, -2.0, 2.0],
                ],
                elements: vec![[0, 1, 2, 3], [4, 5, 6, 7]],
                element_markers: vec![1, 0],
                boundary_faces: vec![[0, 1, 2], [4, 5, 6]],
                boundary_markers: vec![10, 99],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            build_report: None,
        }),
    });
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::Auto,
        },
    ];
    ir.study = fullmag_ir::StudyIR::Eigenmodes {
        dynamics: ir.study.dynamics().clone(),
        operator: fullmag_ir::EigenOperatorConfigIR {
            kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
            include_demag: true,
        },
        count: 3,
        target: fullmag_ir::EigenTargetIR::Lowest,
        equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
        k_sampling: None,
        normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
        damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            outputs: vec![fullmag_ir::OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            }],
        },
        mode_tracking: None,
    };

    let plan = plan(&ir).expect("shared-domain FEM eigen mesh should now plan");
    match plan.backend_plan {
        BackendPlanIR::FemEigen(fem) => {
            assert_eq!(
                fem.domain_mesh_mode,
                fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir
            );
            assert_eq!(
                fem.demag_realization,
                Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin)
            );
            assert_eq!(fem.object_segments.len(), 2);
            assert_eq!(fem.object_segments[0].object_id, "strip");
            assert_eq!(fem.object_segments[0].geometry_id.as_deref(), Some("strip"));
            assert_eq!(fem.object_segments[0].node_count, 4);
            assert_eq!(fem.object_segments[1].object_id, "__air__");
            assert_eq!(fem.object_segments[1].geometry_id, None);
            assert_eq!(fem.object_segments[1].node_count, 4);
            assert_eq!(fem.equilibrium_magnetization.len(), 8);
            let magnetic_start = fem.object_segments[0].node_start as usize;
            let magnetic_end = magnetic_start + fem.object_segments[0].node_count as usize;
            assert!(fem.equilibrium_magnetization[magnetic_start..magnetic_end]
                .iter()
                .all(|value| value.iter().any(|component| component.abs() > 0.0)));
            assert!(fem
                .equilibrium_magnetization
                .iter()
                .enumerate()
                .filter(|(index, _)| *index < magnetic_start || *index >= magnetic_end)
                .all(|(_, value)| *value == [0.0, 0.0, 0.0]));
        }
        other => panic!("expected FEM eigen plan, got {other:?}"),
    }
}

#[test]
fn fem_eigen_periodic_bc_requires_periodic_node_pairs() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: None,
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: Some("meshes/unit_tet.msh".to_string()),
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![fullmag_ir::FemMeshAssetIR {
            geometry_name: "strip".to_string(),
            mesh_source: Some("meshes/unit_tet.msh".to_string()),
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                elements: vec![[0, 1, 2, 3]],
                element_markers: vec![1],
                boundary_faces: vec![[0, 1, 2]],
                boundary_markers: vec![1],
                periodic_boundary_pairs: vec![],
                periodic_node_pairs: vec![],
                per_domain_quality: std::collections::HashMap::new(),
            }),
        }],
        fem_domain_mesh_asset: None,
    });
    ir.energy_terms = vec![fullmag_ir::EnergyTermIR::Exchange];
    ir.study = fullmag_ir::StudyIR::Eigenmodes {
        dynamics: ir.study.dynamics().clone(),
        operator: fullmag_ir::EigenOperatorConfigIR {
            kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 3,
        target: fullmag_ir::EigenTargetIR::Lowest,
        equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
        k_sampling: Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        }),
        normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
        damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Legacy(
            fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
        ),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            outputs: vec![fullmag_ir::OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            }],
        },
        mode_tracking: None,
    };

    let err = plan(&ir).expect_err("periodic FEM eigen without pairing metadata must fail");
    assert!(err
        .reasons
        .iter()
        .any(|reason| reason.contains("mesh.periodic_node_pairs")));
}

#[test]
fn fem_eigen_periodic_bc_with_pairs_plans_successfully() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: None,
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: Some("meshes/unit_tet.msh".to_string()),
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![fullmag_ir::FemMeshAssetIR {
            geometry_name: "strip".to_string(),
            mesh_source: Some("meshes/unit_tet.msh".to_string()),
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                elements: vec![[0, 1, 2, 3]],
                element_markers: vec![1],
                boundary_faces: vec![[0, 1, 2]],
                boundary_markers: vec![1],
                periodic_boundary_pairs: vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
                    pair_id: "x_faces".to_string(),
                    source_marker: None,
                    destination_marker: None,
                    marker_a: 10,
                    marker_b: 11,
                    translation: None,
                    tolerance: None,
                    axis_hint: None,
                    orientation: None,
                    pairing_policy: None,
                }],
                periodic_node_pairs: vec![fullmag_ir::MeshPeriodicNodePairIR {
                    pair_id: "x_faces".to_string(),
                    node_a: 0,
                    node_b: 1,
                }],
                per_domain_quality: std::collections::HashMap::new(),
            }),
        }],
        fem_domain_mesh_asset: None,
    });
    ir.energy_terms = vec![fullmag_ir::EnergyTermIR::Exchange];
    ir.study = fullmag_ir::StudyIR::Eigenmodes {
        dynamics: ir.study.dynamics().clone(),
        operator: fullmag_ir::EigenOperatorConfigIR {
            kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 3,
        target: fullmag_ir::EigenTargetIR::Lowest,
        equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
        k_sampling: Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        }),
        normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
        damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
            fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            },
        ),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            outputs: vec![fullmag_ir::OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            }],
        },
        mode_tracking: None,
    };

    let plan = plan(&ir).expect("periodic FEM eigen with pairing metadata should plan");
    assert!(matches!(plan.backend_plan, BackendPlanIR::FemEigen(_)));
}

#[test]
fn fem_eigen_floquet_bc_with_pairs_and_k_sampling_plans_successfully() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: None,
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: Some("meshes/unit_tet.msh".to_string()),
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![fullmag_ir::FemMeshAssetIR {
            geometry_name: "strip".to_string(),
            mesh_source: Some("meshes/unit_tet.msh".to_string()),
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                elements: vec![[0, 1, 2, 3]],
                element_markers: vec![1],
                boundary_faces: vec![[0, 1, 2]],
                boundary_markers: vec![1],
                periodic_boundary_pairs: vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
                    pair_id: "x_faces".to_string(),
                    source_marker: None,
                    destination_marker: None,
                    marker_a: 10,
                    marker_b: 11,
                    translation: None,
                    tolerance: None,
                    axis_hint: None,
                    orientation: None,
                    pairing_policy: None,
                }],
                periodic_node_pairs: vec![fullmag_ir::MeshPeriodicNodePairIR {
                    pair_id: "x_faces".to_string(),
                    node_a: 0,
                    node_b: 1,
                }],
                per_domain_quality: std::collections::HashMap::new(),
            }),
        }],
        fem_domain_mesh_asset: None,
    });
    ir.energy_terms = vec![fullmag_ir::EnergyTermIR::Exchange];
    ir.study = fullmag_ir::StudyIR::Eigenmodes {
        dynamics: ir.study.dynamics().clone(),
        operator: fullmag_ir::EigenOperatorConfigIR {
            kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 3,
        target: fullmag_ir::EigenTargetIR::Lowest,
        equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
        k_sampling: Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [1.0e7, 0.0, 0.0],
        }),
        normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
        damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
            fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            },
        ),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            outputs: vec![fullmag_ir::OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            }],
        },
        mode_tracking: None,
    };

    let plan =
        plan(&ir).expect("floquet FEM eigen with pairing metadata and k_sampling should plan");
    assert!(matches!(plan.backend_plan, BackendPlanIR::FemEigen(_)));
}

#[test]
fn fem_eigen_floquet_dynamic_demag_is_rejected() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: None,
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: Some("meshes/unit_tet.msh".to_string()),
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![],
        fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
            mesh_source: Some("meshes/unit_tet.msh".to_string()),
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip_air_periodic".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [-2.0, -2.0, -2.0],
                    [2.0, -2.0, -2.0],
                    [-2.0, 2.0, -2.0],
                    [-2.0, -2.0, 2.0],
                ],
                elements: vec![[0, 1, 2, 3], [4, 5, 6, 7]],
                element_markers: vec![1, 0],
                boundary_faces: vec![[0, 1, 2], [4, 5, 6]],
                boundary_markers: vec![10, 99],
                periodic_boundary_pairs: vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
                    pair_id: "x_faces".to_string(),
                    source_marker: None,
                    destination_marker: None,
                    marker_a: 10,
                    marker_b: 99,
                    translation: None,
                    tolerance: None,
                    axis_hint: None,
                    orientation: None,
                    pairing_policy: None,
                }],
                periodic_node_pairs: vec![fullmag_ir::MeshPeriodicNodePairIR {
                    pair_id: "x_faces".to_string(),
                    node_a: 0,
                    node_b: 1,
                }],
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            build_report: None,
        }),
    });
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::Auto,
        },
    ];
    ir.study = fullmag_ir::StudyIR::Eigenmodes {
        dynamics: ir.study.dynamics().clone(),
        operator: fullmag_ir::EigenOperatorConfigIR {
            kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
            include_demag: true,
        },
        count: 3,
        target: fullmag_ir::EigenTargetIR::Lowest,
        equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
        k_sampling: Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [1.0e7, 0.0, 0.0],
        }),
        normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
        damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
            fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            },
        ),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            outputs: vec![fullmag_ir::OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            }],
        },
        mode_tracking: None,
    };

    let err = plan(&ir).expect_err("Floquet FEM eigen with dynamic demag is unsupported");
    assert!(err
        .reasons
        .iter()
        .any(|reason| reason
            .contains("dynamic demag for Floquet periodic FEM is not implemented yet")));
}

#[test]
fn fem_eigen_surface_anisotropy_requires_positive_ks_and_axis() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: None,
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: Some("meshes/unit_tet.msh".to_string()),
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![fullmag_ir::FemMeshAssetIR {
            geometry_name: "strip".to_string(),
            mesh_source: Some("meshes/unit_tet.msh".to_string()),
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                elements: vec![[0, 1, 2, 3]],
                element_markers: vec![1],
                boundary_faces: vec![[0, 1, 2]],
                boundary_markers: vec![1],
                periodic_boundary_pairs: vec![],
                periodic_node_pairs: vec![],
                per_domain_quality: std::collections::HashMap::new(),
            }),
        }],
        fem_domain_mesh_asset: None,
    });
    ir.energy_terms = vec![fullmag_ir::EnergyTermIR::Exchange];
    ir.study = fullmag_ir::StudyIR::Eigenmodes {
        dynamics: ir.study.dynamics().clone(),
        operator: fullmag_ir::EigenOperatorConfigIR {
            kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 3,
        target: fullmag_ir::EigenTargetIR::Lowest,
        equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
        k_sampling: None,
        normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
        damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
            fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::SurfaceAnisotropy,
                boundary_pair_id: None,
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: Some(0.0),
                surface_anisotropy_axis: Some([0.0, 0.0, 0.0]),
            },
        ),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            outputs: vec![fullmag_ir::OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            }],
        },
        mode_tracking: None,
    };

    let err = plan(&ir).expect_err("invalid surface anisotropy config must fail planning");
    assert!(err
        .reasons
        .iter()
        .any(|reason| reason.contains("surface_anisotropy_ks > 0")));
    assert!(err
        .reasons
        .iter()
        .any(|reason| reason.contains("surface_anisotropy_axis")));
}

#[test]
fn frequency_response_is_first_class_ir_but_not_executable_yet() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fem;
    ir.study = fullmag_ir::StudyIR::FrequencyResponse {
        dynamics: ir.study.dynamics().clone(),
        operator: fullmag_ir::EigenOperatorConfigIR {
            kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
            include_demag: true,
        },
        equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
        k_sampling: Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        }),
        normalization: fullmag_ir::FrequencyResponseNormalizationIR::UnitL2,
        damping_policy: fullmag_ir::EigenDampingPolicyIR::Include,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        excitation: fullmag_ir::FrequencyExcitationIR {
            field_au_per_m: [0.0, 0.0, 1.0],
        },
        frequencies_hz: fullmag_ir::FrequencySweepIR {
            values_hz: vec![1.0e9, 2.0e9],
        },
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            outputs: vec![fullmag_ir::OutputIR::FrequencyResponseOutput {
                observable: fullmag_ir::FrequencyResponseOutputIR::SusceptibilityTensor,
            }],
        },
    };

    let err = plan(&ir).expect_err("frequency response execution is not implemented yet");
    assert!(err.reasons.iter().any(|reason| {
        reason.contains("StudyIR::FrequencyResponse is semantic-only")
            && reason.contains("not implemented yet")
    }));
}

// ---------------------------------------------------------------------------
// Commit 7 — acceptance tests for build contract invariants
// ---------------------------------------------------------------------------

#[test]
fn fem_plan_fails_when_shared_domain_requested_but_no_domain_mesh_asset() {
    // study_universe + mesh_workflow build_target=domain but no fem_domain_mesh_asset
    // → the Commit 4 invariant in plan_fem() should reject this.
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.problem_meta.runtime_metadata.insert(
        "study_universe".to_string(),
        serde_json::json!({
            "mode": "manual",
            "size": [8.0, 6.0, 4.0],
            "center": [0.0, 0.0, 0.0],
        }),
    );
    ir.problem_meta.runtime_metadata.insert(
        "mesh_workflow".to_string(),
        serde_json::json!({
            "build_target": "domain",
            "domain_mesh_mode": "generated_shared_domain_mesh",
        }),
    );
    ir.energy_terms = vec![fullmag_ir::EnergyTermIR::Exchange];
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 5e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: None,
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    // Per-object mesh but NO shared domain mesh asset
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![fullmag_ir::FemMeshAssetIR {
            geometry_name: "strip".to_string(),
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                elements: vec![[0, 1, 2, 3]],
                element_markers: vec![1],
                boundary_faces: vec![[0, 1, 2]],
                boundary_markers: vec![1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
        }],
        fem_domain_mesh_asset: None,
    });

    let error = plan(&ir)
        .expect_err("shared-domain mesh requested with no fem_domain_mesh_asset should fail");
    assert!(
        error.reasons.iter().any(|reason| {
            reason.contains("shared-domain FEM mesh")
                || reason.contains("study.build_domain_mesh()")
        }),
        "expected error to mention shared-domain or build_domain_mesh, got: {:?}",
        error.reasons,
    );
}

#[test]
fn fem_plan_succeeds_when_shared_domain_has_domain_mesh_asset() {
    // Same setup as above but WITH a fem_domain_mesh_asset → should succeed
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.air_box_policy = Some(fullmag_ir::AirBoxPolicyIR {
        boundary_marker: Some(99),
        ..Default::default()
    });
    ir.problem_meta.runtime_metadata.insert(
        "study_universe".to_string(),
        serde_json::json!({
            "mode": "manual",
            "size": [8.0, 6.0, 4.0],
            "center": [0.0, 0.0, 0.0],
        }),
    );
    ir.problem_meta.runtime_metadata.insert(
        "mesh_workflow".to_string(),
        serde_json::json!({
            "build_target": "domain",
            "domain_mesh_mode": "generated_shared_domain_mesh",
        }),
    );
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::Auto,
        },
    ];
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 5e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
        }),
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2e-9,
            mesh: None,
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![fullmag_ir::FemMeshAssetIR {
            geometry_name: "strip".to_string(),
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                elements: vec![[0, 1, 2, 3]],
                element_markers: vec![1],
                boundary_faces: vec![[0, 1, 2]],
                boundary_markers: vec![1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
        }],
        // Provide the shared domain mesh asset
        fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "shared_domain".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [-2.0, -2.0, -2.0],
                    [2.0, -2.0, -2.0],
                    [-2.0, 2.0, -2.0],
                    [-2.0, -2.0, 2.0],
                ],
                elements: vec![[0, 1, 2, 3], [4, 5, 6, 7]],
                element_markers: vec![1, 0],
                boundary_faces: vec![[0, 1, 2], [4, 5, 6]],
                boundary_markers: vec![1, 99],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                marker: 1,
                geometry_name: "strip".to_string(),
            }],
            mesh_source: None,
            build_report: None,
        }),
    });

    let result = plan(&ir);
    assert!(
        result.is_ok(),
        "plan should succeed when fem_domain_mesh_asset is provided, but got: {:?}",
        result.err(),
    );
    match result.unwrap().backend_plan {
        BackendPlanIR::Fem(fem) => {
            assert!(
                fem.mesh_parts.len() >= 2,
                "shared-domain should produce at least magnetic + air parts, got {}",
                fem.mesh_parts.len(),
            );
        }
        other => panic!("expected FEM plan, got {other:?}"),
    }
}

// ------------------------------------------------------------------
// Regression tests for audit findings (2026-04-08)
// ------------------------------------------------------------------

/// Homogeneous multi-body (same material) must still emit region_materials
/// so the runner can distinguish magnetic markers from air.
#[test]
fn fem_plan_homogeneous_multi_body_populates_region_materials() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda", "device_index": 0}),
    );

    // Add a second body with the SAME material (Py)
    ir.geometry.entries.push(GeometryEntryIR::Box {
        name: "second_geom".to_string(),
        size: [1.0, 1.0, 1.0],
    });
    ir.regions.push(fullmag_ir::RegionIR {
        name: "second".to_string(),
        geometry: "second_geom".to_string(),
    });
    ir.magnets.push(fullmag_ir::MagnetIR {
        name: "second".to_string(),
        region: "second".to_string(),
        material: "Py".to_string(), // same as the first body
        initial_magnetization: Some(InitialMagnetizationIR::Uniform {
            value: [0.0, 1.0, 0.0],
        }),
    });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![
            fullmag_ir::FemMeshAssetIR {
                geometry_name: "strip".to_string(),
                mesh_source: None,
                mesh: Some(fullmag_ir::MeshIR {
                    mesh_name: "strip".to_string(),
                    nodes: vec![
                        [0.0, 0.0, 0.0],
                        [1.0, 0.0, 0.0],
                        [0.0, 1.0, 0.0],
                        [0.0, 0.0, 1.0],
                    ],
                    elements: vec![[0, 1, 2, 3]],
                    element_markers: vec![1],
                    boundary_faces: vec![[0, 1, 2]],
                    boundary_markers: vec![1],
                    periodic_boundary_pairs: Vec::new(),
                    periodic_node_pairs: Vec::new(),
                    per_domain_quality: std::collections::HashMap::new(),
                }),
            },
            fullmag_ir::FemMeshAssetIR {
                geometry_name: "second_geom".to_string(),
                mesh_source: None,
                mesh: Some(fullmag_ir::MeshIR {
                    mesh_name: "second".to_string(),
                    nodes: vec![
                        [0.0, 0.0, 2.0],
                        [1.0, 0.0, 2.0],
                        [0.0, 1.0, 2.0],
                        [0.0, 0.0, 3.0],
                    ],
                    elements: vec![[0, 1, 2, 3]],
                    element_markers: vec![1],
                    boundary_faces: vec![[0, 1, 2]],
                    boundary_markers: vec![1],
                    periodic_boundary_pairs: Vec::new(),
                    periodic_node_pairs: Vec::new(),
                    per_domain_quality: std::collections::HashMap::new(),
                }),
            },
        ],
        fem_domain_mesh_asset: None,
    });

    let planned = plan(&ir).expect("homogeneous multi-body FEM should plan on CUDA");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("expected FEM plan");
    };
    // Even though material is the same, region_materials must be populated
    // for 2 magnetic bodies so the runner can distinguish them from air.
    assert_eq!(
        fem.region_materials.len(),
        2,
        "homogeneous multi-body must still emit region_materials, got {}: {:?}",
        fem.region_materials.len(),
        fem.region_materials,
    );
}

/// Reorder must preserve per_domain_quality from the original mesh.
#[test]
fn reorder_shared_domain_mesh_preserves_per_domain_quality() {
    let mut quality_map = std::collections::HashMap::new();
    quality_map.insert(
        1u32,
        fullmag_ir::MeshQualityIR {
            n_elements: 1,
            sicn_min: 0.5,
            sicn_max: 0.9,
            sicn_mean: 0.7,
            sicn_p5: 0.55,
            sicn_histogram: vec![],
            gamma_min: 0.4,
            gamma_mean: 0.6,
            gamma_histogram: vec![],
            volume_min: 1e-27,
            volume_max: 2e-27,
            volume_mean: 1.5e-27,
            volume_std: 0.5e-27,
            avg_quality: 0.7,
        },
    );

    let mesh = MeshIR {
        mesh_name: "quality_test".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [-2.0, -2.0, -2.0],
            [2.0, -2.0, -2.0],
            [-2.0, 2.0, -2.0],
            [-2.0, -2.0, 2.0],
        ],
        elements: vec![[0, 1, 2, 3], [4, 5, 6, 7]],
        element_markers: vec![1, 0],
        boundary_faces: vec![[0, 1, 2], [4, 5, 6]],
        boundary_markers: vec![1, 99],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: quality_map,
    };
    let region_markers = vec![FemDomainRegionMarkerIR {
        geometry_name: "obj".to_string(),
        marker: 1,
    }];

    let (reordered, _segments, _parts) =
        crate::mesh::reorder_shared_domain_mesh(&mesh, &region_markers, false)
            .expect("reorder should succeed");
    assert!(
        !reordered.per_domain_quality.is_empty(),
        "per_domain_quality must be preserved after reorder",
    );
    assert!(
        reordered.per_domain_quality.contains_key(&1),
        "quality for marker 1 must survive reorder",
    );
    assert_eq!(
        reordered.per_domain_quality[&1].sicn_mean, 0.7,
        "quality metrics must stay unchanged",
    );
}

/// Merge must carry forward per_domain_quality from sub-meshes.
#[test]
fn merge_multibody_mesh_preserves_per_domain_quality() {
    let mut q1 = std::collections::HashMap::new();
    q1.insert(
        1u32,
        fullmag_ir::MeshQualityIR {
            n_elements: 1,
            sicn_min: 0.5,
            sicn_max: 0.9,
            sicn_mean: 0.7,
            sicn_p5: 0.55,
            sicn_histogram: vec![],
            gamma_min: 0.4,
            gamma_mean: 0.6,
            gamma_histogram: vec![],
            volume_min: 1e-27,
            volume_max: 2e-27,
            volume_mean: 1.5e-27,
            volume_std: 0.5e-27,
            avg_quality: 0.7,
        },
    );

    let mesh_a = MeshIR {
        mesh_name: "a".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ],
        elements: vec![[0, 1, 2, 3]],
        element_markers: vec![1],
        boundary_faces: vec![[0, 1, 2]],
        boundary_markers: vec![1],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: q1,
    };
    let mesh_b = MeshIR {
        mesh_name: "b".to_string(),
        nodes: vec![
            [0.0, 0.0, 2.0],
            [1.0, 0.0, 2.0],
            [0.0, 1.0, 2.0],
            [0.0, 0.0, 3.0],
        ],
        elements: vec![[0, 1, 2, 3]],
        element_markers: vec![1],
        boundary_faces: vec![[0, 1, 2]],
        boundary_markers: vec![1],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };

    let meshes = vec![("obj_a".to_string(), mesh_a), ("obj_b".to_string(), mesh_b)];
    let (merged, _segments) = crate::mesh::merge_fem_meshes(&meshes).expect("merge should succeed");
    assert!(
        !merged.per_domain_quality.is_empty(),
        "per_domain_quality must be carried forward after merge",
    );
    assert!(
        merged.per_domain_quality.contains_key(&1),
        "quality for marker 1 must survive merge",
    );
}

/// FemDomainMeshAssetIR should accept an optional build_report field.
#[test]
fn fem_domain_mesh_asset_accepts_optional_build_report() {
    let asset = fullmag_ir::FemDomainMeshAssetIR {
        mesh_source: None,
        mesh: Some(fullmag_ir::MeshIR {
            mesh_name: "report_test".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            elements: vec![[0, 1, 2, 3]],
            element_markers: vec![1],
            boundary_faces: vec![[0, 1, 2]],
            boundary_markers: vec![1],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
        }),
        region_markers: vec![],
        build_report: Some(fullmag_ir::FemSharedDomainBuildReportIR {
            build_mode: "component_aware".to_string(),
            fallbacks_triggered: vec![],
            effective_airbox_target: None,
            effective_airbox_hmax: Some(100e-9),
            effective_per_object_targets: std::collections::HashMap::new(),
            region_markers: vec![],
            used_size_field_kinds: vec!["ComponentVolumeConstant".to_string()],
            size_fields_realized: vec![],
            operation_statuses: vec![],
            thin_film_diagnostics: vec![],
            degraded: false,
        }),
    };
    assert!(asset.validate().is_ok());
    assert!(asset.build_report.is_some());
    let report = asset.build_report.unwrap();
    assert_eq!(report.build_mode, "component_aware");
    assert!(!report.degraded);

    // Also verify None works
    let asset_no_report = fullmag_ir::FemDomainMeshAssetIR {
        mesh_source: None,
        mesh: Some(fullmag_ir::MeshIR {
            mesh_name: "no_report".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            elements: vec![[0, 1, 2, 3]],
            element_markers: vec![1],
            boundary_faces: vec![[0, 1, 2]],
            boundary_markers: vec![1],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
        }),
        region_markers: vec![],
        build_report: None,
    };
    assert!(asset_no_report.validate().is_ok());
    assert!(asset_no_report.build_report.is_none());
}

// ═══════════════════════════════════════════════════════════════════════════
// Boundary parameter passthrough regression tests
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn fdm_boundary_params_passthrough_phi_floor_and_delta_min() {
    let mut ir = ProblemIR::bootstrap_example();
    // Use a Cylinder geometry so boundary_correction SDF is available.
    ir.geometry.entries = vec![GeometryEntryIR::Cylinder {
        name: "disk".to_string(),
        radius: 50e-9,
        height: 6e-9,
    }];
    ir.regions[0].geometry = "disk".to_string();
    ir.backend_policy.discretization_hints = Some(DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 2e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: Some("full".to_string()),
            boundary_phi_floor: Some(0.1),
            boundary_delta_min: Some(0.5e-9),
        }),
        fem: None,
        hybrid: None,
    });
    let plan = plan(&ir).expect("cylinder with boundary params should plan successfully");
    match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            assert_eq!(
                fdm.boundary_correction.as_deref(),
                Some("full"),
                "boundary_correction should pass through"
            );
            assert_eq!(
                fdm.boundary_phi_floor,
                Some(0.1),
                "boundary_phi_floor must not be dropped by the planner"
            );
            assert_eq!(
                fdm.boundary_delta_min,
                Some(0.5e-9),
                "boundary_delta_min must not be dropped by the planner"
            );
            assert!(
                fdm.boundary_geometry.is_some(),
                "boundary_geometry should be computed for Cylinder"
            );
        }
        _ => panic!("expected FDM plan"),
    }
}

#[test]
fn fdm_boundary_params_none_when_not_set() {
    let ir = ProblemIR::bootstrap_example();
    let plan = plan(&ir).expect("bootstrap example should plan successfully");
    match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            assert!(fdm.boundary_phi_floor.is_none());
            assert!(fdm.boundary_delta_min.is_none());
            assert!(fdm.boundary_correction.is_none());
        }
        _ => panic!("expected FDM plan"),
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// FDM PBC planner regression tests
// ═══════════════════════════════════════════════════════════════════════════

#[test]
fn fdm_pbc_with_exchange_plans() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.pbc = Some(FdmPeriodicityIR {
        axes: [
            AxisBoundary::Periodic,
            AxisBoundary::Open,
            AxisBoundary::Open,
        ],
        demag: FdmDemagPeriodicityIR::Open,
        image_counts: None,
    });
    let plan = plan(&ir).expect("FDM + PBC + exchange should plan");
    match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => assert_eq!(fdm.periodicity, ir.pbc),
        _ => panic!("expected FDM plan"),
    }
}

#[test]
fn fdm_cpu_pbc_truncated_images_demag_plans() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.energy_terms.push(EnergyTermIR::Demag {
        realization: fullmag_ir::RequestedFemDemagIR::Auto,
    });
    ir.pbc = Some(FdmPeriodicityIR {
        axes: [
            AxisBoundary::Periodic,
            AxisBoundary::Periodic,
            AxisBoundary::Open,
        ],
        demag: FdmDemagPeriodicityIR::TruncatedImages,
        image_counts: Some([4, 4, 0]),
    });
    let plan = plan(&ir).expect("CPU FDM + PBC TruncatedImages demag should plan");
    match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            assert_eq!(
                fdm.periodicity.as_ref().and_then(|pbc| pbc.image_counts),
                Some([4, 4, 0])
            );
        }
        _ => panic!("expected FDM plan"),
    }
}

#[test]
fn fdm_cuda_pbc_truncated_images_demag_plans() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.energy_terms.push(EnergyTermIR::Demag {
        realization: fullmag_ir::RequestedFemDemagIR::Auto,
    });
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda", "device_index": 0}),
    );
    ir.pbc = Some(FdmPeriodicityIR {
        axes: [
            AxisBoundary::Periodic,
            AxisBoundary::Periodic,
            AxisBoundary::Open,
        ],
        demag: FdmDemagPeriodicityIR::TruncatedImages,
        image_counts: Some([4, 4, 0]),
    });
    let plan = plan(&ir).expect("CUDA FDM + PBC TruncatedImages demag should plan");
    match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            assert_eq!(
                fdm.periodicity.as_ref().and_then(|pbc| pbc.image_counts),
                Some([4, 4, 0])
            );
        }
        _ => panic!("expected FDM plan"),
    }
}

#[test]
fn fdm_cuda_pbc_dmi_plans() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.energy_terms.push(EnergyTermIR::BulkDmi { d: 1.0e-3 });
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda", "device_index": 0}),
    );
    ir.pbc = Some(FdmPeriodicityIR {
        axes: [
            AxisBoundary::Periodic,
            AxisBoundary::Open,
            AxisBoundary::Open,
        ],
        demag: FdmDemagPeriodicityIR::Open,
        image_counts: None,
    });

    let plan = plan(&ir).expect("CUDA FDM + PBC DMI should plan");
    match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => assert_eq!(fdm.periodicity, ir.pbc),
        _ => panic!("expected FDM plan"),
    }
}

#[test]
fn fdm_cuda_general_oersted_field_plans() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.geometry.entries[0] = GeometryEntryIR::Box {
        name: "wire".to_string(),
        size: [8e-9, 4e-9, 2e-9],
    };
    ir.regions[0].geometry = "wire".to_string();
    ir.current_modules.push(CurrentModuleIR::CurrentTransport {
        name: "drive".to_string(),
        model: CurrentTransportModelIR::PrescribedDensity,
        current_density: Some([1.0e10, 0.0, 0.0]),
        solve_region: Some("strip".to_string()),
        conductivity_s_per_m: None,
    });
    ir.energy_terms.push(EnergyTermIR::OerstedField {
        model: OerstedFieldModelIR::FromCurrentSolution,
        source: "drive".to_string(),
    });
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda", "device_index": 0}),
    );

    let plan = plan(&ir).expect("CUDA FDM generalized Oersted field should plan");
    match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            assert_eq!(
                fdm.oersted_realization,
                Some(OerstedRealization::BiotSavartMidpoint)
            );
            let field = fdm
                .oersted_field_xyz
                .as_ref()
                .expect("midpoint Oersted field should be lowered onto the FDM grid");
            assert_eq!(field.len(), fdm.initial_magnetization.len());
            assert!(field.iter().any(|value| *value != [0.0, 0.0, 0.0]));
        }
        _ => panic!("expected FDM plan"),
    }
}
