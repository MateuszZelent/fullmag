use fullmag_ir::{
    compute_mixed_certificate_evidence, validate_mesh_for_execution,
    validate_mixed_layer_topology_certificate_against_mesh, validate_mixed_mesh_semantics,
    FemConnectivityIR, MeshIR, MeshValidationError, MeshValidationPolicy,
    MixedCertificateEvidenceV1, MixedLayerTopologyCertificateV1IR,
};
use rayon::ThreadPoolBuilder;
use serde_json::Value;

const GOLDEN: &str =
    include_str!("fixtures/mixed_layer_topology_certificate_v1_python_golden.json");
const LAYER_GOLDENS: [&str; 3] = [
    include_str!("fixtures/mixed_layer_topology_certificate_v1_layers_2_python_golden.json"),
    include_str!("fixtures/mixed_layer_topology_certificate_v1_layers_3_python_golden.json"),
    include_str!("fixtures/mixed_layer_topology_certificate_v1_layers_4_python_golden.json"),
];

fn golden() -> Value {
    serde_json::from_str(GOLDEN).expect("frozen Python golden is valid JSON")
}

fn golden_mesh() -> MeshIR {
    serde_json::from_value(golden()["mesh"].clone()).expect("golden mesh is valid MeshIR")
}

fn golden_certificate() -> MixedLayerTopologyCertificateV1IR {
    serde_json::from_value(golden()["certificate"].clone()).expect("golden certificate is valid IR")
}

fn assert_close(actual: f64, expected: f64, relative: f64, absolute: f64) {
    let tolerance = absolute.max(relative * actual.abs().max(expected.abs()));
    assert!(
        (actual - expected).abs() <= tolerance,
        "actual={actual:.17e} expected={expected:.17e} tolerance={tolerance:.17e}"
    );
}

fn compute_with_threads(mesh: &MeshIR, threads: usize) -> MixedCertificateEvidenceV1 {
    ThreadPoolBuilder::new()
        .num_threads(threads)
        .build()
        .expect("dedicated Rayon pool builds")
        .install(|| compute_mixed_certificate_evidence(mesh))
        .expect("golden mesh computes certificate evidence")
}

fn compute_error_with_threads(mesh: &MeshIR, threads: usize) -> MeshValidationError {
    ThreadPoolBuilder::new()
        .num_threads(threads)
        .build()
        .expect("dedicated Rayon pool builds")
        .install(|| compute_mixed_certificate_evidence(mesh))
        .expect_err("malformed mixed mesh must reject")
}

fn assert_structural_preflight_error(mesh: MeshIR, expected: &str) {
    let expected = vec![format!(
        "mixed certificate requires a valid executable mesh: {expected}"
    )];
    let compute = std::panic::catch_unwind(|| compute_mixed_certificate_evidence(&mesh))
        .expect("public compute must not panic on malformed connectivity");
    assert_eq!(compute, Err(expected.clone()));

    let certificate = golden_certificate();
    let validate = std::panic::catch_unwind(|| {
        validate_mixed_layer_topology_certificate_against_mesh(&mesh, &certificate)
    })
    .expect("public validator must not panic on malformed connectivity");
    assert_eq!(validate, Err(expected));
}

fn assert_canonical_strict_geometry_error(mesh: MeshIR) {
    let strict_errors =
        validate_mesh_for_execution(&mesh).expect_err("mutated mesh must fail strict validation");
    let expected = vec![format!(
        "mixed certificate requires a valid executable mesh: {}",
        strict_errors.join("; ")
    )];

    assert_eq!(
        compute_mixed_certificate_evidence(&mesh),
        Err(expected.clone())
    );
    assert_eq!(
        validate_mixed_layer_topology_certificate_against_mesh(&mesh, &golden_certificate()),
        Err(expected)
    );
}

fn assert_public_error_type(_: Result<MixedCertificateEvidenceV1, MeshValidationError>) {}

fn resign(certificate: &mut MixedLayerTopologyCertificateV1IR, mesh: &MeshIR) {
    certificate.topology_fingerprint = mesh
        .mixed_topology_fingerprint_for_version(&certificate.topology_fingerprint_version)
        .expect("mutated topology has a supported fingerprint version");
}

fn refresh_evidence(
    certificate: &mut MixedLayerTopologyCertificateV1IR,
    mesh: &MeshIR,
) -> MixedCertificateEvidenceV1 {
    let evidence = compute_mixed_certificate_evidence(mesh)
        .expect("the mutation remains executable and produces evidence");
    let mut certificate_value =
        serde_json::to_value(&*certificate).expect("certificate serializes");
    let evidence_value = serde_json::to_value(&evidence).expect("evidence serializes");
    for (field, value) in evidence_value
        .as_object()
        .expect("evidence is a JSON object")
    {
        certificate_value[field] = value.clone();
    }
    *certificate =
        serde_json::from_value(certificate_value).expect("refreshed certificate deserializes");
    resign(certificate, mesh);
    evidence
}

fn reorder_cells(mesh: &MeshIR, order: &[usize]) -> MeshIR {
    let mut reordered = mesh.clone();
    let mut offsets = vec![0];
    let mut nodes = Vec::new();
    for &ordinal in order {
        nodes.extend_from_slice(
            mesh.cells
                .item_nodes(ordinal)
                .expect("source fixture has valid cell CSR"),
        );
        offsets.push(nodes.len() as u32);
    }
    reordered.cells = FemConnectivityIR {
        types: order
            .iter()
            .map(|&ordinal| mesh.cells.types[ordinal])
            .collect(),
        offsets,
        nodes,
        global_ordinals: order
            .iter()
            .map(|&ordinal| mesh.cells.global_ordinals[ordinal])
            .collect(),
        mesh_parts: order
            .iter()
            .map(|&ordinal| mesh.cells.mesh_parts[ordinal])
            .collect(),
    };
    reordered.element_markers = order
        .iter()
        .map(|&ordinal| mesh.element_markers[ordinal])
        .collect();
    reordered
}

#[test]
fn computes_python_golden_evidence() {
    assert_public_error_type(compute_mixed_certificate_evidence(&golden_mesh()));
    let expected = golden()["expected_evidence"].clone();
    let evidence = compute_with_threads(&golden_mesh(), 4);
    let actual = serde_json::to_value(&evidence).expect("evidence serializes");

    for field in [
        "transition_shell_interface_tri3_count",
        "cell_family_counts_by_marker",
        "cell_family_counts_by_part",
        "facet_family_counts_by_role_marker",
        "marker_coverage_complete",
        "nonconforming_face_count",
        "orphan_face_count",
        "nonmanifold_face_count",
        "coincident_interface_face_count",
    ] {
        assert_eq!(actual[field], expected[field], "field {field}");
    }
    for (actual_plane, expected_plane) in actual["magnetic_plane_coordinates_m"]
        .as_array()
        .unwrap()
        .iter()
        .zip(expected["magnetic_plane_coordinates_m"].as_array().unwrap())
    {
        assert_close(
            actual_plane.as_f64().unwrap(),
            expected_plane.as_f64().unwrap(),
            1.0e-12,
            1.0e-30,
        );
    }
    for field in [
        "plane_tolerance_m",
        "transition_shell_thickness_m",
        "magnetic_volume_m3",
        "expected_magnetic_volume_m3",
        "air_volume_m3",
        "shared_domain_volume_m3",
        "expected_shared_domain_volume_m3",
        "magnetic_bounds_relative_error",
        "airbox_bounds_relative_error",
    ] {
        assert_close(
            actual[field].as_f64().unwrap(),
            expected[field].as_f64().unwrap(),
            1.0e-12,
            1.0e-30,
        );
    }
    for field in [
        "magnetic_relative_volume_error",
        "shared_domain_relative_volume_error",
    ] {
        assert_close(
            actual[field].as_f64().unwrap(),
            expected[field].as_f64().unwrap(),
            1.0e-12,
            16.0 * f64::EPSILON,
        );
    }
    for field in [
        "jacobian_minima_m3_by_family",
        "scaled_jacobian_minima_by_family",
        "scaled_jacobian_p05_by_family",
    ] {
        for (family, expected_value) in expected[field].as_object().unwrap() {
            let absolute = if field == "jacobian_minima_m3_by_family" {
                1.0e-30
            } else {
                16.0 * f64::EPSILON
            };
            assert_close(
                actual[field][family].as_f64().unwrap(),
                expected_value.as_f64().unwrap(),
                1.0e-12,
                absolute,
            );
        }
    }

    for fixture in LAYER_GOLDENS {
        let fixture: Value = serde_json::from_str(fixture).expect("layer golden is valid JSON");
        let mesh: MeshIR =
            serde_json::from_value(fixture["mesh"].clone()).expect("layer golden mesh is valid");
        let certificate: MixedLayerTopologyCertificateV1IR =
            serde_json::from_value(fixture["certificate"].clone())
                .expect("layer golden certificate is valid");
        validate_mixed_layer_topology_certificate_against_mesh(&mesh, &certificate)
            .expect("layer golden certificate matches recomputed evidence");
    }

    let mesh = golden_mesh();
    let mut stale_counts = golden_certificate();
    *stale_counts
        .cell_family_counts_by_marker
        .get_mut("0")
        .unwrap()
        .get_mut("tet4")
        .unwrap() += 1;
    assert_eq!(
        validate_mixed_layer_topology_certificate_against_mesh(&mesh, &stale_counts),
        Err(vec![
            "mixed layer topology certificate marker and part cell counts disagree".to_string(),
            "mixed certificate cell/facet counts disagree with the mesh".to_string()
        ])
    );
}

#[test]
fn native_semantic_preflight_rejects_wrong_interface_marker() {
    let mesh = golden_mesh();
    validate_mixed_mesh_semantics(&mesh).expect("golden mesh semantic contract is valid");

    let mut mutated = mesh;
    let interface_facet = mutated
        .facets
        .roles
        .iter()
        .position(|role| matches!(role, fullmag_ir::FemFacetRoleIR::MaterialInterface))
        .expect("golden mesh has a material interface facet");
    mutated.boundary_markers[interface_facet] += 1;
    let errors = validate_mixed_mesh_semantics(&mutated)
        .expect_err("wrong interface marker must fail native semantic preflight");
    assert!(errors
        .iter()
        .any(|error| error.contains("material-interface marker")));
}

#[test]
fn rejects_non_manifold_face() {
    let mut mesh = golden_mesh();
    let duplicate = mesh.cells.item_nodes(6).unwrap().to_vec();
    mesh.cells.types.push(mesh.cells.types[6]);
    mesh.cells.nodes.extend(duplicate);
    mesh.cells.offsets.push(mesh.cells.nodes.len() as u32);
    mesh.cells
        .global_ordinals
        .push(mesh.cells.global_ordinals.iter().max().unwrap() + 1);
    mesh.cells.mesh_parts.push(mesh.cells.mesh_parts[6]);
    mesh.element_markers.push(mesh.element_markers[6]);
    mesh.nodes.push([-2.0 - 1.0 / 24.0, 0.0, 0.0]);
    let mut certificate = golden_certificate();
    certificate.airbox_bounds_min_m[0] = -2.0 - 1.0 / 24.0;
    let evidence = refresh_evidence(&mut certificate, &mesh);

    assert_eq!(evidence.nonmanifold_face_count, 2);

    assert_eq!(
        validate_mixed_layer_topology_certificate_against_mesh(&mesh, &certificate),
        Err(vec![
            "mixed layer topology certificate conformity or marker coverage is invalid".to_string()
        ])
    );
}

#[test]
fn rejects_same_side_two_owner_face() {
    let mut mesh = golden_mesh();
    mesh.nodes[14] = [2.0, 0.0, 2.0];
    let tet10_start = mesh.cells.offsets[10] as usize;
    mesh.cells.nodes.swap(tet10_start, tet10_start + 1);
    let mut certificate = golden_certificate();
    let evidence = refresh_evidence(&mut certificate, &mesh);

    assert_eq!(evidence.nonconforming_face_count, 1);
    assert_eq!(evidence.nonmanifold_face_count, 0);
    assert_eq!(evidence.orphan_face_count, 0);
    assert_eq!(evidence.coincident_interface_face_count, 0);

    assert_eq!(
        validate_mixed_layer_topology_certificate_against_mesh(&mesh, &certificate),
        Err(vec![
            "mixed layer topology certificate conformity or marker coverage is invalid".to_string()
        ])
    );
}

#[test]
fn rejects_inverted_order_two_jacobian_sample() {
    let mut mesh = golden_mesh();
    let prism_nodes = mesh.cells.item_nodes(0).unwrap().to_vec();
    let inverted = [
        [1.0, 1.0, -1.0],
        [1.0, 0.0, -1.0],
        [0.0, 1.0, -1.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 1.0],
        [0.0, 1.0, 1.0],
    ];
    for (node, point) in prism_nodes.into_iter().zip(inverted) {
        mesh.nodes[node as usize] = point;
    }

    let error = compute_mixed_certificate_evidence(&mesh)
        .expect_err("a negative order-2 prism Jacobian must reject");
    assert!(
        error
            .iter()
            .any(|message| message.contains("negative Prism6 Jacobian")),
        "{error:?}"
    );
}

#[test]
fn is_deterministic_for_one_two_four_and_eight_threads() {
    let mesh = golden_mesh();
    let expected = serde_json::to_vec(&compute_with_threads(&mesh, 1)).unwrap();
    for threads in [2, 4, 8] {
        for _ in 0..10 {
            assert_eq!(
                serde_json::to_vec(&compute_with_threads(&mesh, threads)).unwrap(),
                expected,
                "threads={threads}"
            );
        }
    }
}

#[test]
fn keeps_global_ordinal_order_after_parallel_collection() {
    let mesh = golden_mesh();
    let mut order = (0..mesh.cells.types.len()).collect::<Vec<_>>();
    order.reverse();
    let reordered = reorder_cells(&mesh, &order);

    assert_eq!(
        compute_with_threads(&reordered, 8),
        compute_with_threads(&mesh, 1)
    );
}

#[test]
fn percentile_uses_binary64_linear_interpolation() {
    let evidence = compute_with_threads(&golden_mesh(), 4);
    assert_close(
        evidence.scaled_jacobian_p05_by_family["prism6"],
        0.707_106_781_186_547_5,
        1.0e-12,
        16.0 * f64::EPSILON,
    );
}

#[test]
fn fixed_order_volume_sum_is_thread_count_independent() {
    let mesh = golden_mesh();
    let one = compute_with_threads(&mesh, 1);
    for threads in [2, 4, 8] {
        let evidence = compute_with_threads(&mesh, threads);
        assert_eq!(
            evidence.magnetic_volume_m3.to_bits(),
            one.magnetic_volume_m3.to_bits()
        );
        assert_eq!(
            evidence.shared_domain_volume_m3.to_bits(),
            one.shared_domain_volume_m3.to_bits()
        );
    }
}

#[test]
fn structural_preflight_rejects_short_prism_csr_without_panicking() {
    let mut mesh = golden_mesh();
    let removed = mesh.cells.offsets[1] as usize - 1;
    mesh.cells.nodes.remove(removed);
    for offset in &mut mesh.cells.offsets[1..] {
        *offset -= 1;
    }

    assert_structural_preflight_error(mesh, "mesh cell 0 has wrong arity 5; expected 6");
}

#[test]
fn structural_preflight_rejects_out_of_range_node_without_panicking() {
    let mut mesh = golden_mesh();
    mesh.cells.nodes[0] = mesh.nodes.len() as u32;

    assert_structural_preflight_error(mesh, "mesh cell 0 contains invalid node index");
}

#[test]
fn parallel_multi_error_selects_first_storage_ordinal_deterministically() {
    let mut mesh = golden_mesh();
    mesh.element_markers[1] = 0;
    mesh.element_markers[10] = 1;
    let expected = vec!["mixed certificate cell 1 has invalid mesh part/family/marker".to_string()];

    for threads in [1, 2, 4, 8] {
        for _ in 0..10 {
            assert_eq!(compute_error_with_threads(&mesh, threads), expected);
        }
    }
}

#[test]
fn public_entry_points_match_strict_non_finite_coordinate_error() {
    let mut mesh = golden_mesh();
    mesh.nodes[0][0] = f64::NAN;

    assert_canonical_strict_geometry_error(mesh);
}

#[test]
fn public_entry_points_match_strict_degenerate_jacobian_error() {
    let mut mesh = golden_mesh();
    let prism = mesh.cells.item_nodes(0).unwrap().to_vec();
    for (upper, lower) in prism[3..].iter().zip(&prism[..3]) {
        mesh.nodes[*upper as usize] = mesh.nodes[*lower as usize];
    }

    assert_canonical_strict_geometry_error(mesh);
}

#[test]
fn public_entry_points_match_strict_negative_orientation_error() {
    let mut mesh = golden_mesh();
    let tet_start = mesh.cells.offsets[10] as usize;
    mesh.cells.nodes.swap(tet_start, tet_start + 1);

    assert_canonical_strict_geometry_error(mesh);
}

#[test]
fn shared_geometry_owner_preserves_validate_strict_error_order() {
    let mut mesh = golden_mesh();
    mesh.element_markers.pop();
    mesh.nodes[0][0] = f64::NAN;

    assert_eq!(
        mesh.validate_strict(&MeshValidationPolicy::default()),
        Err(vec![
            "mesh.element_markers length must match mesh.cells length".to_string(),
            "mesh node 0 contains non-finite coordinates".to_string(),
            "mesh.element_markers must cover every FEM cell".to_string(),
        ])
    );
}
