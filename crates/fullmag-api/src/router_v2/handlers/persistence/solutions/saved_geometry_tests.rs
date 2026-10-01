use super::*;

fn mixed_topology_fixture() -> fullmag_runner::FemMeshPayload {
    fullmag_runner::FemMeshPayload {
        mesh_name: "saved-geometry-mixed-test".to_string(),
        mesh_id: "saved-geometry-mixed-test".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 1.0],
            [1.0, 1.0, 1.0],
            [0.0, 1.0, 1.0],
        ],
        cells: fullmag_ir::FemConnectivityIR {
            types: vec![
                fullmag_ir::FemCellTypeIR::Tet4,
                fullmag_ir::FemCellTypeIR::Prism6,
                fullmag_ir::FemCellTypeIR::Pyramid5,
                fullmag_ir::FemCellTypeIR::Hex8,
            ],
            offsets: vec![0, 4, 10, 15, 23],
            nodes: vec![
                0, 1, 2, 4, 0, 1, 2, 4, 5, 6, 0, 1, 2, 3, 4, 0, 1, 2, 3, 4, 5, 6, 7,
            ],
            global_ordinals: vec![10, 11, 9_007_199_254_740_993, u64::MAX],
            mesh_parts: Vec::new(),
        },
        element_markers: vec![1, 2, 3, 4],
        facets: fullmag_ir::FemFacetConnectivityIR {
            types: vec![
                fullmag_ir::FemFacetTypeIR::Tri3,
                fullmag_ir::FemFacetTypeIR::Quad4,
                fullmag_ir::FemFacetTypeIR::Tri3,
            ],
            roles: vec![
                fullmag_ir::FemFacetRoleIR::Exterior,
                fullmag_ir::FemFacetRoleIR::MaterialInterface,
                fullmag_ir::FemFacetRoleIR::PeriodicSeam,
            ],
            offsets: vec![0, 3, 7, 10],
            nodes: vec![0, 1, 2, 0, 1, 5, 4, 4, 5, 6],
            global_ordinals: vec![20, 9_007_199_254_740_995, u64::MAX],
        },
        boundary_markers: vec![5, 6, 7],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: Some("shared_domain".to_string()),
        domain_frame: None,
        generation_id: Some("saved-geometry-mixed-test".to_string()),
        per_domain_quality: Default::default(),
        build_report: None,
    }
}

#[test]
fn fmsp_header_counts_and_padding_are_canonical() {
    let mask = [
        true, false, false, true, false, false, false, false, true, false,
    ];
    let body = encode_saved_support(&mask).expect("support fixture should encode");

    assert_eq!(&body[..4], b"FMSP");
    assert_eq!(
        u16::from_le_bytes(body[4..6].try_into().expect("version bytes")),
        FMSP_VERSION
    );
    assert_eq!(
        u16::from_le_bytes(body[6..8].try_into().expect("flags bytes")),
        FMSP_FLAGS
    );
    assert_eq!(
        u64::from_le_bytes(body[8..16].try_into().expect("node count bytes")),
        mask.len() as u64
    );
    assert_eq!(
        u64::from_le_bytes(body[16..24].try_into().expect("payload length bytes")),
        2
    );
    assert_eq!(&body[FMSP_HEADER_LEN..], &[0b0000_1001, 0b0000_0001]);

    let used_bits = (mask.len() % 8) as u32;
    let unused_mask = !((1_u8 << used_bits) - 1);
    assert_eq!(body.last().copied().unwrap() & unused_mask, 0);
    assert_eq!(sha256_hex(&body), support_binary_identity(&mask).unwrap().1);
}

#[test]
fn fmmt_preflight_matches_shared_serializer_for_mixed_topology() {
    let mesh = mixed_topology_fixture();
    let estimated = estimated_fmmt_v2_len(&mesh).expect("mixed topology length should fit");
    let body = crate::field_store::serialize_fem_mesh_topology_binary_v2(&mesh)
        .expect("shared FMMT serializer should accept the mixed fixture");

    assert_eq!(estimated, body.len());
    assert_eq!(&body[..4], b"FMMT");
    assert_eq!(body[4], 2);
    assert_eq!(
        u32::from_le_bytes(body[8..12].try_into().expect("node count bytes")),
        mesh.nodes.len() as u32
    );
    assert_eq!(
        u32::from_le_bytes(body[12..16].try_into().expect("cell count bytes")),
        mesh.cells.types.len() as u32
    );
    assert_eq!(
        u32::from_le_bytes(body[16..20].try_into().expect("facet count bytes")),
        mesh.facets.types.len() as u32
    );
}

#[test]
fn strong_etag_changes_when_serialized_body_hash_changes() {
    let body = crate::field_store::serialize_fem_mesh_topology_binary_v2(&mixed_topology_fixture())
        .expect("shared FMMT serializer should accept the mixed fixture");
    let first_hash = sha256_hex(&body);
    let first_etag = saved_geometry_binary_etag("pinned-scope", "topology-fmmt-v2", &first_hash);

    let mut changed_body = body.clone();
    changed_body[64] ^= 1;
    let changed_hash = sha256_hex(&changed_body);
    let changed_etag =
        saved_geometry_binary_etag("pinned-scope", "topology-fmmt-v2", &changed_hash);

    assert_ne!(first_hash, changed_hash);
    assert_ne!(first_etag, changed_etag);
    assert_eq!(
        first_etag,
        saved_geometry_binary_etag("pinned-scope", "topology-fmmt-v2", &first_hash)
    );
}

#[test]
fn binary_query_requires_three_canonical_roots() {
    let hash = "a".repeat(64);
    let query = SavedFieldGeometryBinaryQuery {
        expected_dataset_manifest_object_ref: hash.clone(),
        expected_geometry_manifest_object_ref: hash.clone(),
        expected_geometry_object_ref: hash,
        max_response_bytes: "1024".to_string(),
    };

    assert!(
        validate_binary_request("member", "dataset", &query, MAX_BINARY_RESPONSE_BYTES).is_ok()
    );

    for field in [
        "expected_dataset_manifest_object_ref",
        "expected_geometry_manifest_object_ref",
        "expected_geometry_object_ref",
    ] {
        let invalid = match field {
            "expected_dataset_manifest_object_ref" => SavedFieldGeometryBinaryQuery {
                expected_dataset_manifest_object_ref: "not-a-hash".to_string(),
                expected_geometry_manifest_object_ref: query
                    .expected_geometry_manifest_object_ref
                    .clone(),
                expected_geometry_object_ref: query.expected_geometry_object_ref.clone(),
                max_response_bytes: query.max_response_bytes.clone(),
            },
            "expected_geometry_manifest_object_ref" => SavedFieldGeometryBinaryQuery {
                expected_dataset_manifest_object_ref: query
                    .expected_dataset_manifest_object_ref
                    .clone(),
                expected_geometry_manifest_object_ref: "not-a-hash".to_string(),
                expected_geometry_object_ref: query.expected_geometry_object_ref.clone(),
                max_response_bytes: query.max_response_bytes.clone(),
            },
            "expected_geometry_object_ref" => SavedFieldGeometryBinaryQuery {
                expected_dataset_manifest_object_ref: query
                    .expected_dataset_manifest_object_ref
                    .clone(),
                expected_geometry_manifest_object_ref: query
                    .expected_geometry_manifest_object_ref
                    .clone(),
                expected_geometry_object_ref: "not-a-hash".to_string(),
                max_response_bytes: query.max_response_bytes.clone(),
            },
            _ => unreachable!(),
        };
        assert!(
            validate_binary_request("member", "dataset", &invalid, MAX_BINARY_RESPONSE_BYTES)
                .is_err()
        );
    }
}
