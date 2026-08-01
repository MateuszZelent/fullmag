#[allow(unused_imports)]
use crate::{
    validate_mesh_for_execution, FemDomainMeshModeIR, FemLinearSolverPolicy, MeshIR, MeshQualityIR,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};

// Private spatial helper functions (only used by types in this module)
fn vec3_from_value(value: &Value) -> Option<[f64; 3]> {
    let array = value.as_array()?;
    if array.len() != 3 {
        return None;
    }
    Some([array[0].as_f64()?, array[1].as_f64()?, array[2].as_f64()?])
}

#[cfg(test)]
mod mesh_asset_validation_tests {
    use super::*;

    fn qualified_mixed_mesh() -> MeshIR {
        let nodes = vec![
            [-1.0, -1.0, -1.0],
            [1.0, -1.0, -1.0],
            [1.0, 1.0, -1.0],
            [-1.0, 1.0, -1.0],
            [-1.0, -1.0, 1.0],
            [1.0, -1.0, 1.0],
            [1.0, 1.0, 1.0],
            [-1.0, 1.0, 1.0],
            [2.0, 0.0, 0.0],
            [-2.0, 0.0, 0.0],
            [0.0, 2.0, 0.0],
            [0.0, -2.0, 0.0],
            [0.0, 0.0, 2.0],
            [0.0, 0.0, -2.0],
            [2.0, 0.0, -2.0],
            [-2.0, -2.0, -2.0],
            [2.0, 2.0, -2.0],
            [2.0, -2.0, 2.0],
            [-2.0, 1.0, 1.0],
            [-2.0, -2.0, -2.0],
            [2.0, 2.0, -2.0],
            [2.0, -2.0, 2.0],
            [-2.0, 1.0, 1.0],
            [-2.0, -2.0, -2.0],
            [2.0, 2.0, -2.0],
            [2.0, -2.0, 2.0],
            [-2.0, 0.875, 0.875],
        ];
        let cells = vec![
            (
                crate::FemCellTypeIR::Prism6,
                vec![0, 1, 2, 4, 5, 6],
                crate::FemCellMeshPartIR::Magnetic,
                1,
            ),
            (
                crate::FemCellTypeIR::Prism6,
                vec![0, 2, 3, 4, 6, 7],
                crate::FemCellMeshPartIR::Magnetic,
                1,
            ),
            (
                crate::FemCellTypeIR::Pyramid5,
                vec![1, 2, 6, 5, 8],
                crate::FemCellMeshPartIR::TransitionAir,
                0,
            ),
            (
                crate::FemCellTypeIR::Pyramid5,
                vec![0, 4, 7, 3, 9],
                crate::FemCellMeshPartIR::TransitionAir,
                0,
            ),
            (
                crate::FemCellTypeIR::Pyramid5,
                vec![2, 3, 7, 6, 10],
                crate::FemCellMeshPartIR::TransitionAir,
                0,
            ),
            (
                crate::FemCellTypeIR::Pyramid5,
                vec![0, 1, 5, 4, 11],
                crate::FemCellMeshPartIR::TransitionAir,
                0,
            ),
            (
                crate::FemCellTypeIR::Tet4,
                vec![4, 5, 6, 12],
                crate::FemCellMeshPartIR::TransitionAir,
                0,
            ),
            (
                crate::FemCellTypeIR::Tet4,
                vec![4, 6, 7, 12],
                crate::FemCellMeshPartIR::TransitionAir,
                0,
            ),
            (
                crate::FemCellTypeIR::Tet4,
                vec![0, 2, 1, 13],
                crate::FemCellMeshPartIR::TransitionAir,
                0,
            ),
            (
                crate::FemCellTypeIR::Tet4,
                vec![0, 3, 2, 13],
                crate::FemCellMeshPartIR::TransitionAir,
                0,
            ),
            (
                crate::FemCellTypeIR::Tet4,
                vec![1, 2, 8, 14],
                crate::FemCellMeshPartIR::FarAir,
                0,
            ),
            (
                crate::FemCellTypeIR::Tet4,
                vec![15, 17, 16, 18],
                crate::FemCellMeshPartIR::FarAir,
                0,
            ),
            (
                crate::FemCellTypeIR::Tet4,
                vec![19, 21, 20, 22],
                crate::FemCellMeshPartIR::FarAir,
                0,
            ),
            (
                crate::FemCellTypeIR::Tet4,
                vec![23, 25, 24, 26],
                crate::FemCellMeshPartIR::FarAir,
                0,
            ),
        ];
        let mut cell_offsets = vec![0];
        let mut cell_nodes = Vec::new();
        for (_, nodes, _, _) in &cells {
            cell_nodes.extend(nodes);
            cell_offsets.push(cell_nodes.len() as u32);
        }
        let mut mesh = MeshIR {
            mesh_name: "mixed-certificate".to_string(),
            nodes,
            cells: crate::FemConnectivityIR {
                types: cells.iter().map(|(family, _, _, _)| *family).collect(),
                offsets: cell_offsets,
                nodes: cell_nodes,
                global_ordinals: (0..cells.len() as u64).collect(),
                mesh_parts: cells.iter().map(|(_, _, part, _)| *part).collect(),
            },
            element_markers: cells.iter().map(|(_, _, _, marker)| *marker).collect(),
            facets: crate::FemFacetConnectivityIR::empty(),
            boundary_markers: Vec::new(),
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: HashMap::new(),
        };
        let adjacency = mixed_face_adjacency(&mesh).unwrap();
        let mut facet_offsets = vec![0];
        let mut facet_nodes = Vec::new();
        let mut facet_types = Vec::new();
        let mut facet_roles = Vec::new();
        let mut boundary_markers = Vec::new();
        for (face, owners) in adjacency {
            let role = if owners.len() == 1 {
                Some((crate::FemFacetRoleIR::Exterior, 3))
            } else if owners.len() == 2 && owners[0].1 != owners[1].1 {
                Some((crate::FemFacetRoleIR::MaterialInterface, 2))
            } else {
                None
            };
            if let Some((role, marker)) = role {
                facet_types.push(if face.len() == 3 {
                    crate::FemFacetTypeIR::Tri3
                } else {
                    crate::FemFacetTypeIR::Quad4
                });
                facet_roles.push(role);
                facet_nodes.extend(face);
                facet_offsets.push(facet_nodes.len() as u32);
                boundary_markers.push(marker);
            }
        }
        mesh.facets = crate::FemFacetConnectivityIR {
            global_ordinals: (0..facet_types.len() as u64).collect(),
            types: facet_types,
            roles: facet_roles,
            offsets: facet_offsets,
            nodes: facet_nodes,
        };
        mesh.boundary_markers = boundary_markers;
        mesh
    }

    fn mixed_certificate_asset_value() -> Value {
        let mesh = qualified_mixed_mesh();
        let fingerprint = mesh.topology_fingerprint_v6();
        let mut certificate: Value = serde_json::from_str(
            r#"{
                "schema_version":"mixed_layer_topology_certificate.v1",
                "certificate_status":"accepted",
                "requested_sweep_direction":"z","resolved_sweep_direction":"z",
                "requested_layer_count":1,"realized_layer_count":1,
                "magnetic_plane_coordinates_m":[0.0,1.0],"plane_tolerance_m":1e-12,
                "transition_shell_thickness_m":1.0,"transition_shell_interface_tri3_count":1,
                "interface_marker":2,"outer_boundary_marker":3,
                "magnetic_bounds_min_m":[0.0,0.0,0.0],"magnetic_bounds_max_m":[1.0,1.0,1.0],
                "airbox_bounds_min_m":[-1.0,-1.0,-1.0],"airbox_bounds_max_m":[2.0,2.0,2.0],
                "magnetic_bounds_relative_error":0.0,"airbox_bounds_relative_error":0.0,
                "cell_family_counts_by_marker":{"0":{"pyramid5":1,"tet4":1},"1":{"prism6":1}},
                "cell_family_counts_by_part":{"magnetic":{"prism6":1},"transition_air":{"pyramid5":1},"far_air":{"tet4":1}},
                "facet_family_counts_by_role_marker":{"exterior:3":{"quad4":2,"tri3":1},"material_interface:2":{"tri3":1}},
                "jacobian_minima_m3_by_family":{"prism6":1.0,"pyramid5":1.0,"tet4":1.0},
                "quality_metric":"tetra_decomposition_scaled_jacobian.v1",
                "scaled_jacobian_minima_by_family":{"prism6":1.0,"pyramid5":1.0,"tet4":1.0},
                "scaled_jacobian_p05_by_family":{"prism6":1.0,"pyramid5":1.0,"tet4":1.0},
                "magnetic_volume_m3":1.0,"expected_magnetic_volume_m3":1.0,
                "magnetic_relative_volume_error":0.0,"air_volume_m3":1.0,
                "shared_domain_volume_m3":2.0,"expected_shared_domain_volume_m3":2.0,
                "shared_domain_relative_volume_error":0.0,"marker_coverage_complete":true,
                "nonconforming_face_count":0,"orphan_face_count":0,"nonmanifold_face_count":0,
                "coincident_interface_face_count":0,"topology_fingerprint_version":"v2",
                "topology_fingerprint":"placeholder","gmsh_version":"4.15.2",
                "strategy":"shared_geo_extrusion_partitioned_pyramid_tet.v2",
                "effective_gmsh_thread_count":1,
                "deterministic_inputs":{
                    "algorithm_2d":6,"algorithm_3d":1,"element_order":1,
                    "gmsh_version":"4.15.2","random_factor":0.0,"thread_count":1,
                    "transition_partition":"cartesian_3x3x3_minus_magnetic_center",
                    "transition_volume_count":26,
                    "pyramid_apex_optimizer":"bounded_per_apex_outward_scale_line_search",
                    "pyramid_apex_scale_step":0.001,"pyramid_apex_scale_max":1.25,
                    "scaled_jacobian_p05_min":0.1
                },"fallbacks_triggered":[]
            }"#,
        )
        .unwrap();
        let mut by_marker = BTreeMap::<String, BTreeMap<String, u64>>::new();
        let mut by_part = BTreeMap::<String, BTreeMap<String, u64>>::new();
        for ordinal in 0..mesh.cells.types.len() {
            let family = match mesh.cells.types[ordinal] {
                crate::FemCellTypeIR::Tet4 => "tet4",
                crate::FemCellTypeIR::Prism6 => "prism6",
                crate::FemCellTypeIR::Pyramid5 => "pyramid5",
                crate::FemCellTypeIR::Hex8 => "hex8",
            };
            let part = match mesh.cells.mesh_parts[ordinal] {
                crate::FemCellMeshPartIR::Magnetic => "magnetic",
                crate::FemCellMeshPartIR::TransitionAir => "transition_air",
                crate::FemCellMeshPartIR::FarAir => "far_air",
            };
            *by_marker
                .entry(mesh.element_markers[ordinal].to_string())
                .or_default()
                .entry(family.to_string())
                .or_default() += 1;
            *by_part
                .entry(part.to_string())
                .or_default()
                .entry(family.to_string())
                .or_default() += 1;
        }
        let mut by_facet = BTreeMap::<String, BTreeMap<String, u64>>::new();
        for ordinal in 0..mesh.facets.types.len() {
            let family = match mesh.facets.types[ordinal] {
                crate::FemFacetTypeIR::Tri3 => "tri3",
                crate::FemFacetTypeIR::Quad4 => "quad4",
            };
            let role = match mesh.facets.roles[ordinal] {
                crate::FemFacetRoleIR::Exterior => "exterior",
                crate::FemFacetRoleIR::MaterialInterface => "material_interface",
                crate::FemFacetRoleIR::PeriodicSeam => "periodic_seam",
            };
            *by_facet
                .entry(format!("{role}:{}", mesh.boundary_markers[ordinal]))
                .or_default()
                .entry(family.to_string())
                .or_default() += 1;
        }
        certificate["magnetic_bounds_min_m"] = serde_json::json!([-1.0, -1.0, -1.0]);
        certificate["magnetic_bounds_max_m"] = serde_json::json!([1.0, 1.0, 1.0]);
        certificate["airbox_bounds_min_m"] = serde_json::json!([-2.0, -2.0, -2.0]);
        certificate["airbox_bounds_max_m"] = serde_json::json!([2.0, 2.0, 2.0]);
        certificate["cell_family_counts_by_marker"] = serde_json::to_value(by_marker).unwrap();
        certificate["cell_family_counts_by_part"] = serde_json::to_value(by_part).unwrap();
        certificate["facet_family_counts_by_role_marker"] = serde_json::to_value(by_facet).unwrap();
        certificate["topology_fingerprint"] = serde_json::json!(fingerprint);
        let template: MixedLayerTopologyCertificateV1IR =
            serde_json::from_value(certificate.clone()).unwrap();
        let evidence = recompute_mixed_certificate_evidence(&template, &mesh).unwrap();
        certificate["magnetic_plane_coordinates_m"] = serde_json::json!(evidence.planes);
        certificate["plane_tolerance_m"] = serde_json::json!(evidence.plane_tolerance);
        certificate["transition_shell_thickness_m"] = serde_json::json!(evidence.shell_thickness);
        certificate["transition_shell_interface_tri3_count"] =
            serde_json::json!(evidence.shell_face_count);
        certificate["jacobian_minima_m3_by_family"] = serde_json::json!(evidence.jacobian_minima);
        certificate["scaled_jacobian_minima_by_family"] = serde_json::json!(evidence.scaled_minima);
        certificate["scaled_jacobian_p05_by_family"] = serde_json::json!(evidence.scaled_p05);
        certificate["magnetic_volume_m3"] = serde_json::json!(evidence.magnetic_volume);
        certificate["expected_magnetic_volume_m3"] =
            serde_json::json!(evidence.expected_magnetic_volume);
        certificate["magnetic_relative_volume_error"] = serde_json::json!(((evidence
            .magnetic_volume
            - evidence.expected_magnetic_volume)
            / evidence.expected_magnetic_volume)
            .abs());
        certificate["air_volume_m3"] = serde_json::json!(evidence.air_volume);
        certificate["shared_domain_volume_m3"] = serde_json::json!(evidence.shared_volume);
        certificate["expected_shared_domain_volume_m3"] =
            serde_json::json!(evidence.expected_shared_volume);
        certificate["shared_domain_relative_volume_error"] =
            serde_json::json!(((evidence.shared_volume - evidence.expected_shared_volume)
                / evidence.expected_shared_volume)
                .abs());
        certificate["magnetic_bounds_relative_error"] =
            serde_json::json!(evidence.magnetic_bounds_error);
        certificate["airbox_bounds_relative_error"] =
            serde_json::json!(evidence.airbox_bounds_error);
        certificate["nonconforming_face_count"] = serde_json::json!(evidence.nonconforming);
        certificate["orphan_face_count"] = serde_json::json!(evidence.orphan);
        certificate["nonmanifold_face_count"] = serde_json::json!(evidence.nonmanifold);
        certificate["coincident_interface_face_count"] =
            serde_json::json!(evidence.coincident_interface);
        let report = serde_json::json!({
                "build_mode": "shared_domain",
                "fallbacks_triggered": [],
                "effective_airbox_hmax": null,
                "effective_per_object_targets": {},
                "region_markers": [],
                "object_region_markers": [],
                "used_size_field_kinds": [],
                "size_fields_realized": [],
                "operation_statuses": [],
                "thin_film_diagnostics": [],
                "magnetic_submesh_signatures": [],
                "selector_resolution": [],
                "orphan_entities": [],
                "rejected_element_types": [],
                "degraded": false,
                "authored_regions_count": null,
                "realized_regions_count": null,
                "mixed_layer_topology_certificate": certificate
        });
        serde_json::json!({
            "mesh": mesh,
            "region_markers": [],
            "object_region_markers": [],
            "build_report": report
            }
        )
    }

    fn frozen_python_mixed_golden() -> Value {
        serde_json::from_str(include_str!(
            "../tests/fixtures/mixed_layer_topology_certificate_v1_python_golden.json"
        ))
        .unwrap()
    }

    fn frozen_python_mixed_mesh() -> MeshIR {
        serde_json::from_value(frozen_python_mixed_golden()["mesh"].clone()).unwrap()
    }

    fn frozen_python_mixed_asset_value() -> Value {
        let golden = frozen_python_mixed_golden();
        serde_json::json!({
            "mesh": golden["mesh"],
            "region_markers": [],
            "object_region_markers": [],
            "build_report": {
                "build_mode": "shared_domain",
                "fallbacks_triggered": [],
                "effective_airbox_hmax": null,
                "effective_per_object_targets": {},
                "region_markers": [],
                "object_region_markers": [],
                "used_size_field_kinds": [],
                "size_fields_realized": [],
                "operation_statuses": [],
                "thin_film_diagnostics": [],
                "magnetic_submesh_signatures": [],
                "selector_resolution": [],
                "orphan_entities": [],
                "rejected_element_types": [],
                "degraded": false,
                "authored_regions_count": null,
                "realized_regions_count": null,
                "mixed_layer_topology_certificate": golden["certificate"]
            }
        })
    }

    fn mixed_topology_provenance_value(fingerprint: &str) -> Value {
        serde_json::json!({
            "requested_topology": "mixed_p1",
            "resolved_topology": "mixed_p1",
            "accepted_certificate_fingerprint": fingerprint,
            "requested_device": "auto",
            "precision": "double",
            "capability_status": "unsupported"
        })
    }

    #[test]
    fn frozen_python_mixed_golden_pins_every_evidence_family() {
        let golden = frozen_python_mixed_golden();
        assert_eq!(
            golden["generator"],
            serde_json::json!(
                "packages/fullmag-py fullmag.meshing._gmsh_types._recompute_mixed_certificate_evidence"
            )
        );
        let evidence = &golden["expected_evidence"];
        assert_eq!(
            evidence["magnetic_plane_coordinates_m"],
            serde_json::json!([-1, 1])
        );
        assert_eq!(evidence["plane_tolerance_m"], serde_json::json!(2.0e-8));
        assert_eq!(
            evidence["transition_shell_thickness_m"],
            serde_json::json!(1)
        );
        assert_eq!(
            evidence["transition_shell_interface_tri3_count"],
            serde_json::json!(1)
        );
        assert_eq!(
            evidence["cell_family_counts_by_marker"],
            serde_json::json!({"0":{"pyramid5":4,"tet4":8},"1":{"prism6":2}})
        );
        assert_eq!(
            evidence["cell_family_counts_by_part"],
            serde_json::json!({
                "far_air":{"tet4":4},
                "magnetic":{"prism6":2},
                "transition_air":{"pyramid5":4,"tet4":4}
            })
        );
        assert_eq!(
            evidence["facet_family_counts_by_role_marker"],
            serde_json::json!({
                "exterior:3":{"tri3":38},
                "material_interface:2":{"quad4":4,"tri3":4}
            })
        );
        assert_eq!(
            evidence["jacobian_minima_m3_by_family"],
            serde_json::json!({
                "prism6":3.999999999999999,
                "pyramid5":0.20779754131836622,
                "tet4":4
            })
        );
        assert_eq!(
            evidence["scaled_jacobian_minima_by_family"],
            serde_json::json!({
                "prism6":0.4082482904638629,
                "pyramid5":0.40824829046386296,
                "tet4":0.40824829046386296
            })
        );
        assert_eq!(
            evidence["scaled_jacobian_p05_by_family"],
            serde_json::json!({
                "prism6":0.4311862178478971,
                "pyramid5":0.40824829046386296,
                "tet4":0.40824829046386296
            })
        );
        assert_eq!(
            evidence["magnetic_volume_m3"],
            serde_json::json!(7.999999999999998)
        );
        assert_eq!(evidence["air_volume_m3"], serde_json::json!(56));
        assert_eq!(evidence["shared_domain_volume_m3"], serde_json::json!(64));
        assert_eq!(
            evidence["expected_magnetic_volume_m3"],
            serde_json::json!(8)
        );
        assert_eq!(
            evidence["expected_shared_domain_volume_m3"],
            serde_json::json!(64)
        );
        assert_eq!(
            evidence["magnetic_relative_volume_error"],
            serde_json::json!(2.220446049250313e-16)
        );
        assert_eq!(
            evidence["shared_domain_relative_volume_error"],
            serde_json::json!(0)
        );
        assert_eq!(
            evidence["magnetic_bounds_relative_error"],
            serde_json::json!(0)
        );
        assert_eq!(
            evidence["airbox_bounds_relative_error"],
            serde_json::json!(0)
        );
        assert_eq!(
            evidence["marker_coverage_complete"],
            serde_json::json!(true)
        );
        assert_eq!(evidence["nonconforming_face_count"], serde_json::json!(0));
        assert_eq!(evidence["orphan_face_count"], serde_json::json!(0));
        assert_eq!(evidence["nonmanifold_face_count"], serde_json::json!(0));
        assert_eq!(
            evidence["coincident_interface_face_count"],
            serde_json::json!(0)
        );

        let asset: FemDomainMeshAssetIR =
            serde_json::from_value(frozen_python_mixed_asset_value()).unwrap();
        assert_eq!(asset.validate(), Ok(()));
    }

    #[test]
    fn frozen_python_mixed_golden_detects_independent_conformity_mutations() {
        let count = |mesh: &MeshIR| {
            let adjacency = mixed_face_adjacency(mesh).unwrap();
            mixed_conformity_counts(mesh, &adjacency, 2.0e-8, 2, 3).unwrap()
        };

        let mut orphan = frozen_python_mixed_mesh();
        orphan.facets.types.push(crate::FemFacetTypeIR::Tri3);
        orphan.facets.roles.push(crate::FemFacetRoleIR::Exterior);
        orphan.facets.nodes.extend([0, 8, 10]);
        orphan.facets.offsets.push(orphan.facets.nodes.len() as u32);
        orphan
            .facets
            .global_ordinals
            .push(orphan.facets.global_ordinals.len() as u64);
        orphan.boundary_markers.push(3);
        assert_eq!(count(&orphan).1, 1, "orphan mutation was not detected");

        let mut nonmanifold = frozen_python_mixed_mesh();
        let duplicate_nodes = nonmanifold.cells.item_nodes(10).unwrap().to_vec();
        nonmanifold.cells.types.push(crate::FemCellTypeIR::Tet4);
        nonmanifold.cells.nodes.extend(duplicate_nodes);
        nonmanifold
            .cells
            .offsets
            .push(nonmanifold.cells.nodes.len() as u32);
        nonmanifold
            .cells
            .global_ordinals
            .push(nonmanifold.cells.global_ordinals.len() as u64);
        nonmanifold
            .cells
            .mesh_parts
            .push(crate::FemCellMeshPartIR::FarAir);
        nonmanifold.element_markers.push(0);
        assert!(
            count(&nonmanifold).2 > 0,
            "nonmanifold mutation was not detected"
        );

        let mut coincident = frozen_python_mixed_mesh();
        let interface = coincident
            .facets
            .roles
            .iter()
            .position(|role| *role == crate::FemFacetRoleIR::MaterialInterface)
            .unwrap();
        let duplicate_nodes = coincident.facets.item_nodes(interface).unwrap().to_vec();
        coincident
            .facets
            .types
            .push(coincident.facets.types[interface]);
        coincident
            .facets
            .roles
            .push(crate::FemFacetRoleIR::MaterialInterface);
        coincident.facets.nodes.extend(duplicate_nodes);
        coincident
            .facets
            .offsets
            .push(coincident.facets.nodes.len() as u32);
        coincident
            .facets
            .global_ordinals
            .push(coincident.facets.global_ordinals.len() as u64);
        coincident.boundary_markers.push(2);
        assert!(
            count(&coincident).3 > 0,
            "coincident mutation was not detected"
        );

        let mut same_side = frozen_python_mixed_mesh();
        same_side.nodes[14] = [2.0, 0.0, 2.0];
        assert!(
            count(&same_side).0 > 0,
            "same-side mutation was not detected"
        );
    }

    #[test]
    fn mixed_explicit_role_counts_preserve_duplicate_face_semantics() {
        let face = vec![1, 4, 9];
        let other = vec![2, 5, 10];
        let counts = mixed_explicit_role_counts(&[
            (face.clone(), crate::FemFacetRoleIR::Exterior),
            (face.clone(), crate::FemFacetRoleIR::Exterior),
            (face.clone(), crate::FemFacetRoleIR::MaterialInterface),
            (other.clone(), crate::FemFacetRoleIR::PeriodicSeam),
        ]);

        assert_eq!(counts[&face].explicit, 3);
        assert_eq!(counts[&face].exterior, 2);
        assert_eq!(counts[&face].interface, 1);
        assert_eq!(counts[&other].explicit, 1);
        assert_eq!(counts[&other].exterior, 0);
        assert_eq!(counts[&other].interface, 0);
    }

    #[test]
    fn mixed_cross_language_evidence_accepts_only_machine_epsilon_drift() {
        assert!(dimensionless_float_close(
            8.074_798_210_422_18e-8,
            8.074_798_214_634_024e-8,
        ));
        assert!(dimensionless_float_close(
            1.880_790_961_315_66e-15,
            2.507_721_281_754_213e-16,
        ));
        assert!(!dimensionless_float_close(
            8.074_798_210_422_18e-8,
            8.084_798_210_422_18e-8,
        ));
        assert!(!dimensionless_float_close(0.0, 1.0e-12));
    }

    #[test]
    fn mixed_relative_volume_evidence_allows_cross_language_rounding_only() {
        assert!(!dimensionless_float_close(0.0, 1.0e-12));
        assert!(mixed_relative_volume_error_close(0.0, 1.0e-12));
        assert!(!mixed_relative_volume_error_close(0.0, 1.0e-9));
    }

    #[test]
    fn mixed_certificate_is_typed_preserved_and_bound_to_the_exact_mesh() {
        let value = mixed_certificate_asset_value();
        let asset: FemDomainMeshAssetIR = serde_json::from_value(value).unwrap();
        assert_eq!(
            serde_json::to_value(&asset).unwrap()["build_report"]
                ["mixed_layer_topology_certificate"]["schema_version"],
            serde_json::json!("mixed_layer_topology_certificate.v1")
        );
        assert!(asset.validate().is_ok());

        let mut stale = serde_json::to_value(&asset).unwrap();
        stale["build_report"]["mixed_layer_topology_certificate"]["topology_fingerprint"] =
            serde_json::json!(format!("sha256:{}", "0".repeat(64)));
        let stale: FemDomainMeshAssetIR = serde_json::from_value(stale).unwrap();
        assert!(stale.validate().is_err());
    }

    #[test]
    fn mixed_build_report_serializes_explicit_empty_orphan_entities() {
        let asset: FemDomainMeshAssetIR =
            serde_json::from_value(mixed_certificate_asset_value()).unwrap();
        let serialized = serde_json::to_value(asset).unwrap();

        assert_eq!(
            serialized["build_report"]["orphan_entities"],
            serde_json::json!([]),
        );
    }

    #[test]
    fn mixed_certificate_v3_validates_full_asset_and_unknown_v4_fails_closed() {
        let mut payload = mixed_certificate_asset_value();
        let mesh: MeshIR = serde_json::from_value(payload["mesh"].clone()).unwrap();
        let fingerprint = mesh.mixed_topology_fingerprint_v3().unwrap();
        let certificate = &mut payload["build_report"]["mixed_layer_topology_certificate"];
        certificate["topology_fingerprint_version"] = serde_json::json!("v3");
        certificate["topology_fingerprint"] = serde_json::json!(fingerprint);
        let asset: FemDomainMeshAssetIR = serde_json::from_value(payload.clone()).unwrap();
        assert!(asset.validate().is_ok());

        payload["build_report"]["mixed_layer_topology_certificate"]
            ["topology_fingerprint_version"] = serde_json::json!("v4");
        let unknown: FemDomainMeshAssetIR = serde_json::from_value(payload).unwrap();
        let errors = unknown.validate().expect_err("unknown v4 must fail closed");
        assert!(errors.iter().any(|error| error.contains("v2 or v3")));
    }

    #[test]
    fn mixed_certificate_rejects_wrong_schema_status_and_fallbacks() {
        for (field, value) in [
            (
                "schema_version",
                serde_json::json!("mixed_layer_topology_certificate.v0"),
            ),
            ("certificate_status", serde_json::json!("rejected")),
            (
                "fallbacks_triggered",
                serde_json::json!(["tetrahedral_fallback"]),
            ),
        ] {
            let mut payload = mixed_certificate_asset_value();
            payload["build_report"]["mixed_layer_topology_certificate"][field] = value;
            let asset: FemDomainMeshAssetIR = serde_json::from_value(payload).unwrap();
            assert!(asset.validate().is_err(), "{field} must fail closed");
        }
    }

    #[test]
    fn mixed_certificate_rejects_invalid_numeric_and_structural_evidence() {
        for (field, value) in [
            ("plane_tolerance_m", serde_json::json!(-1.0)),
            ("magnetic_volume_m3", serde_json::json!(-1.0)),
            ("marker_coverage_complete", serde_json::json!(false)),
            ("nonconforming_face_count", serde_json::json!(1)),
            (
                "scaled_jacobian_p05_by_family",
                serde_json::json!({"prism6": 0.09, "pyramid5": 1.0, "tet4": 1.0}),
            ),
            (
                "cell_family_counts_by_part",
                serde_json::json!({
                    "magnetic": {"prism6": 1},
                    "transition_air": {"pyramid5": 1},
                    "far_air": {"prism6": 1}
                }),
            ),
            ("deterministic_inputs", serde_json::json!({})),
        ] {
            let mut payload = mixed_certificate_asset_value();
            payload["build_report"]["mixed_layer_topology_certificate"][field] = value;
            let asset: FemDomainMeshAssetIR = serde_json::from_value(payload).unwrap();
            assert!(asset.validate().is_err(), "{field} must fail closed");
        }

        let mut asset: FemDomainMeshAssetIR =
            serde_json::from_value(mixed_certificate_asset_value()).unwrap();
        asset
            .build_report
            .as_mut()
            .unwrap()
            .mixed_layer_topology_certificate
            .as_mut()
            .unwrap()
            .jacobian_minima_m3_by_family
            .insert("prism6".to_string(), f64::NAN);
        assert!(
            asset.validate().is_err(),
            "non-finite Jacobian must fail closed"
        );
    }

    #[test]
    fn mixed_certificate_rejects_semantically_tampered_recomputable_evidence() {
        let cases = [
            (
                "magnetic planes",
                "magnetic_plane_coordinates_m",
                serde_json::json!([0.0, 0.5]),
            ),
            (
                "plane tolerance",
                "plane_tolerance_m",
                serde_json::json!(1.0e-7),
            ),
            (
                "magnetic bounds",
                "magnetic_bounds_max_m",
                serde_json::json!([2.0, 1.0, 1.0]),
            ),
            (
                "airbox bounds",
                "airbox_bounds_min_m",
                serde_json::json!([-1.5, -2.0, -2.0]),
            ),
            (
                "Jacobian minimum",
                "jacobian_minima_m3_by_family",
                serde_json::json!({"prism6":0.5,"pyramid5":0.5,"tet4":0.5}),
            ),
            (
                "scaled Jacobian minimum",
                "scaled_jacobian_minima_by_family",
                serde_json::json!({"prism6":0.5,"pyramid5":1.0,"tet4":1.0}),
            ),
            (
                "scaled Jacobian p05",
                "scaled_jacobian_p05_by_family",
                serde_json::json!({"prism6":0.5,"pyramid5":1.0,"tet4":1.0}),
            ),
        ];
        for (name, field, value) in cases {
            let mut payload = mixed_certificate_asset_value();
            payload["build_report"]["mixed_layer_topology_certificate"][field] = value;
            let asset: FemDomainMeshAssetIR = serde_json::from_value(payload).unwrap();
            assert!(asset.validate().is_err(), "{name} must be recomputed");
        }

        let mut payload = mixed_certificate_asset_value();
        let certificate = &mut payload["build_report"]["mixed_layer_topology_certificate"];
        certificate["magnetic_volume_m3"] = serde_json::json!(7.2);
        certificate["expected_magnetic_volume_m3"] = serde_json::json!(7.2);
        certificate["air_volume_m3"] = serde_json::json!(56.8);
        let asset: FemDomainMeshAssetIR = serde_json::from_value(payload).unwrap();
        assert!(
            asset.validate().is_err(),
            "self-consistent false volume claims must be recomputed"
        );

        let mut payload = mixed_certificate_asset_value();
        let certificate = &mut payload["build_report"]["mixed_layer_topology_certificate"];
        certificate["cell_family_counts_by_marker"]["1"]["prism6"] = serde_json::json!(3);
        certificate["cell_family_counts_by_part"]["magnetic"]["prism6"] = serde_json::json!(3);
        let asset: FemDomainMeshAssetIR = serde_json::from_value(payload).unwrap();
        assert!(
            asset.validate().is_err(),
            "internally consistent false cell counts must be recomputed"
        );
    }

    #[test]
    fn public_mixed_certificate_validator_rejects_false_evidence_with_current_fingerprint() {
        let asset: FemDomainMeshAssetIR =
            serde_json::from_value(mixed_certificate_asset_value()).unwrap();
        let mesh = asset.mesh.as_ref().expect("fixture carries an inline mesh");
        let mut certificate = asset
            .build_report
            .as_ref()
            .and_then(|report| report.mixed_layer_topology_certificate.clone())
            .expect("fixture carries an accepted certificate");
        assert_eq!(
            certificate.topology_fingerprint,
            mesh.topology_fingerprint_v6(),
            "fixture fingerprint must already bind to the tested mesh"
        );
        certificate.magnetic_volume_m3 = 7.2;
        certificate.expected_magnetic_volume_m3 = 7.2;
        certificate.air_volume_m3 = 56.8;

        let errors = validate_mixed_layer_topology_certificate_against_mesh(&certificate, mesh)
            .expect_err("self-consistent false evidence must be recomputed from the mesh");

        assert!(
            errors.join("; ").contains("recomputed evidence is stale"),
            "{errors:?}"
        );
    }

    #[test]
    fn mixed_topology_provenance_requires_a_mixed_certificate() {
        let mut payload = mixed_certificate_asset_value();
        let certificate_fingerprint = payload["build_report"]["mixed_layer_topology_certificate"]
            ["topology_fingerprint"]
            .as_str()
            .unwrap()
            .to_string();
        payload["build_report"]["mixed_topology_provenance"] =
            mixed_topology_provenance_value(&certificate_fingerprint);
        payload["build_report"]
            .as_object_mut()
            .unwrap()
            .remove("mixed_layer_topology_certificate");
        let asset: FemDomainMeshAssetIR = serde_json::from_value(payload).unwrap();

        let errors = asset
            .validate()
            .expect_err("provenance without a certificate must reject");

        assert!(
            errors
                .join("; ")
                .contains("mixed topology provenance requires a mixed layer topology certificate"),
            "{errors:?}"
        );
    }

    #[test]
    fn mixed_topology_provenance_rejects_stale_accepted_fingerprint() {
        let mut payload = mixed_certificate_asset_value();
        payload["build_report"]["mixed_topology_provenance"] =
            mixed_topology_provenance_value(&format!("sha256:{}", "0".repeat(64)));
        let asset: FemDomainMeshAssetIR = serde_json::from_value(payload).unwrap();

        let errors = asset
            .validate()
            .expect_err("provenance fingerprint must bind to certificate and mesh");

        assert!(
            errors
                .join("; ")
                .contains("mixed topology provenance accepted certificate fingerprint is stale"),
            "{errors:?}"
        );
    }

    #[test]
    fn mixed_topology_provenance_rejects_unproved_public_capability_status() {
        for status in ["source_visible", "production_executable", "validated"] {
            let mut payload = mixed_certificate_asset_value();
            let fingerprint = payload["build_report"]["mixed_layer_topology_certificate"]
                ["topology_fingerprint"]
                .as_str()
                .unwrap()
                .to_string();
            let mut provenance = mixed_topology_provenance_value(&fingerprint);
            provenance["capability_status"] = serde_json::json!(status);
            payload["build_report"]["mixed_topology_provenance"] = provenance;
            let asset: FemDomainMeshAssetIR = serde_json::from_value(payload).unwrap();

            let errors = asset
                .validate()
                .expect_err("unproved mixed-P1 capability promotion must reject");

            assert!(
                errors
                    .join("; ")
                    .contains("capability_status must be unsupported or implemented"),
                "status={status}: {errors:?}"
            );
        }
    }

    #[test]
    fn mixed_topology_provenance_accepts_implemented_operator_precursor_round_trip() {
        let mut payload = mixed_certificate_asset_value();
        let fingerprint = payload["build_report"]["mixed_layer_topology_certificate"]
            ["topology_fingerprint"]
            .as_str()
            .unwrap()
            .to_string();
        let mut provenance = mixed_topology_provenance_value(&fingerprint);
        provenance["capability_status"] = serde_json::json!("implemented");
        payload["build_report"]["mixed_topology_provenance"] = provenance;

        let asset: FemDomainMeshAssetIR = serde_json::from_value(payload).unwrap();
        asset
            .validate()
            .expect("implemented is the bounded mixed-P1 operator precursor status");

        let encoded = serde_json::to_value(&asset).expect("asset must serialize");
        let round_trip: FemDomainMeshAssetIR =
            serde_json::from_value(encoded).expect("asset must deserialize");
        round_trip
            .validate()
            .expect("implemented precursor provenance must remain valid after round trip");
        assert_eq!(
            round_trip
                .build_report
                .and_then(|report| report.mixed_topology_provenance)
                .expect("round trip must retain mixed provenance")
                .capability_status,
            crate::FemMixedTopologyCapabilityStatusIR::Implemented,
        );
    }

    #[test]
    fn tetrahedral_mesh_rejects_mixed_topology_provenance() {
        let mesh = MeshIR::from_legacy_tet4(
            "tetrahedral".to_string(),
            vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            vec![[0, 1, 2, 3]],
            vec![1],
            vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
            vec![1, 1, 1, 1],
            Vec::new(),
            Vec::new(),
            HashMap::new(),
        );
        validate_mesh_for_execution(&mesh).expect("tetrahedral control mesh must be valid");
        let fingerprint = mesh.topology_fingerprint_v6();
        let asset: FemDomainMeshAssetIR = serde_json::from_value(serde_json::json!({
            "mesh": mesh,
            "build_report": {
                "build_mode": "test",
                "mixed_topology_provenance": mixed_topology_provenance_value(&fingerprint)
            }
        }))
        .unwrap();

        let errors = asset
            .validate()
            .expect_err("tetrahedral mesh must not carry mixed topology provenance");

        assert!(
            errors
                .join("; ")
                .contains("mixed topology provenance requires an actual mixed topology mesh"),
            "{errors:?}"
        );
    }

    fn resign_mesh_and_facet_counts(payload: &mut Value, mesh: &MeshIR) {
        let certificate = &mut payload["build_report"]["mixed_layer_topology_certificate"];
        certificate["topology_fingerprint"] = serde_json::json!(mesh.topology_fingerprint_v6());
        let mut by_facet = BTreeMap::<String, BTreeMap<String, u64>>::new();
        for ordinal in 0..mesh.facets.types.len() {
            let family = match mesh.facets.types[ordinal] {
                crate::FemFacetTypeIR::Tri3 => "tri3",
                crate::FemFacetTypeIR::Quad4 => "quad4",
            };
            let role = match mesh.facets.roles[ordinal] {
                crate::FemFacetRoleIR::Exterior => "exterior",
                crate::FemFacetRoleIR::MaterialInterface => "material_interface",
                crate::FemFacetRoleIR::PeriodicSeam => "periodic_seam",
            };
            *by_facet
                .entry(format!("{role}:{}", mesh.boundary_markers[ordinal]))
                .or_default()
                .entry(family.to_string())
                .or_default() += 1;
        }
        certificate["facet_family_counts_by_role_marker"] = serde_json::to_value(by_facet).unwrap();
        payload["mesh"] = serde_json::to_value(mesh).unwrap();
    }

    #[test]
    fn mixed_certificate_rejects_unbound_pyramid_base_and_nonconforming_facets() {
        let mut payload = mixed_certificate_asset_value();
        let mut mesh: MeshIR = serde_json::from_value(payload["mesh"].clone()).unwrap();
        let mut first_pyramid_base = mesh.cells.item_nodes(2).unwrap()[0..4].to_vec();
        first_pyramid_base.sort_unstable();
        let base_facet = (0..mesh.facets.len())
            .find(|ordinal| {
                let mut nodes = mesh.facets.item_nodes(*ordinal).unwrap().to_vec();
                nodes.sort_unstable();
                nodes == first_pyramid_base
            })
            .unwrap();
        mesh.facets.roles[base_facet] = crate::FemFacetRoleIR::Exterior;
        mesh.boundary_markers[base_facet] = 3;
        resign_mesh_and_facet_counts(&mut payload, &mesh);
        let asset: FemDomainMeshAssetIR = serde_json::from_value(payload).unwrap();
        assert!(
            asset.validate().is_err(),
            "a resigned topology with an unbound pyramid base must fail closed"
        );

        let mut payload = mixed_certificate_asset_value();
        let mut mesh: MeshIR = serde_json::from_value(payload["mesh"].clone()).unwrap();
        let exterior = mesh
            .facets
            .roles
            .iter()
            .position(|role| *role == crate::FemFacetRoleIR::Exterior)
            .unwrap();
        let duplicate_nodes = mesh.facets.item_nodes(exterior).unwrap().to_vec();
        mesh.facets.types.push(mesh.facets.types[exterior]);
        mesh.facets.roles.push(crate::FemFacetRoleIR::Exterior);
        mesh.facets.nodes.extend(duplicate_nodes);
        mesh.facets.offsets.push(mesh.facets.nodes.len() as u32);
        mesh.facets
            .global_ordinals
            .push(mesh.facets.global_ordinals.len() as u64);
        mesh.boundary_markers.push(3);
        resign_mesh_and_facet_counts(&mut payload, &mesh);
        let asset: FemDomainMeshAssetIR = serde_json::from_value(payload).unwrap();
        assert!(
            asset.validate().is_err(),
            "a resigned topology with duplicate exterior evidence must fail conformity"
        );
    }

    #[test]
    fn mixed_interface_quantization_preserves_python_integer_identity_beyond_i64() {
        let scale = 1.0;
        assert_ne!(
            mixed_coordinate_key([1.0e20, 0.0, 0.0], scale).unwrap(),
            mixed_coordinate_key([2.0e20, 0.0, 0.0], scale).unwrap(),
            "distinct Python rounded integers above i64::MAX must not saturate to one key"
        );
        assert_ne!(
            mixed_coordinate_key([-1.0e20, 0.0, 0.0], scale).unwrap(),
            mixed_coordinate_key([-2.0e20, 0.0, 0.0], scale).unwrap(),
            "distinct Python rounded integers below i64::MIN must not saturate to one key"
        );
        assert_eq!(
            mixed_coordinate_key([-0.0, 1.0, -1.0], scale).unwrap(),
            mixed_coordinate_key([0.0, 1.0, -1.0], scale).unwrap(),
            "Python integer zero has no signed-zero identity"
        );
        assert!(
            mixed_coordinate_key([f64::MAX, 0.0, 0.0], f64::MIN_POSITIVE).is_err(),
            "Python rejects rounding infinity, so overflow must fail closed"
        );
    }

    #[test]
    fn conflicting_mesh_and_build_report_certificate_copies_fail_deserialization() {
        let mut payload = mixed_certificate_asset_value();
        let mut conflicting = payload["build_report"]["mixed_layer_topology_certificate"].clone();
        conflicting["certificate_status"] = serde_json::json!("rejected");
        payload["mesh"]["mixed_layer_topology_certificate"] = conflicting;

        assert!(serde_json::from_value::<FemDomainMeshAssetIR>(payload).is_err());
    }

    fn inverted_mesh() -> MeshIR {
        MeshIR {
            mesh_name: "inverted".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            cells: crate::FemConnectivityIR::from_tet4(vec![[0, 1, 3, 2]]),
            element_markers: vec![1],
            facets: crate::FemFacetConnectivityIR::empty(),
            boundary_markers: Vec::new(),
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: HashMap::new(),
        }
    }

    #[test]
    fn fem_mesh_asset_requires_strict_mesh_validation() {
        let asset = FemMeshAssetIR {
            geometry_name: "body".to_string(),
            mesh_source: None,
            mesh: Some(inverted_mesh()),
        };

        let errors = asset
            .validate()
            .expect_err("inverted inline mesh must fail");
        assert!(errors
            .iter()
            .any(|error| error.contains("negative tetra orientation")));
    }
}

fn normalized_bounds_pair(bounds_min: ([f64; 3], [f64; 3])) -> Option<([f64; 3], [f64; 3])> {
    let (bounds_min, bounds_max) = bounds_min;
    let normalized_min = [
        bounds_min[0].min(bounds_max[0]),
        bounds_min[1].min(bounds_max[1]),
        bounds_min[2].min(bounds_max[2]),
    ];
    let normalized_max = [
        bounds_min[0].max(bounds_max[0]),
        bounds_min[1].max(bounds_max[1]),
        bounds_min[2].max(bounds_max[2]),
    ];
    if normalized_max
        .iter()
        .zip(normalized_min.iter())
        .any(|(max_value, min_value)| *max_value - *min_value <= 0.0)
    {
        return None;
    }
    Some((normalized_min, normalized_max))
}

fn option_bounds_pair(
    bounds_min: Option<[f64; 3]>,
    bounds_max: Option<[f64; 3]>,
) -> Option<([f64; 3], [f64; 3])> {
    normalized_bounds_pair((bounds_min?, bounds_max?))
}

fn bounds_extent(bounds_min: [f64; 3], bounds_max: [f64; 3]) -> [f64; 3] {
    [
        bounds_max[0] - bounds_min[0],
        bounds_max[1] - bounds_min[1],
        bounds_max[2] - bounds_min[2],
    ]
}

fn bounds_center(bounds_min: [f64; 3], bounds_max: [f64; 3]) -> [f64; 3] {
    [
        0.5 * (bounds_min[0] + bounds_max[0]),
        0.5 * (bounds_min[1] + bounds_max[1]),
        0.5 * (bounds_min[2] + bounds_max[2]),
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FdmGridAssetIR {
    pub geometry_name: String,
    pub cells: [u32; 3],
    pub cell_size: [f64; 3],
    pub origin: [f64; 3],
    pub active_mask: Vec<bool>,
}

impl FdmGridAssetIR {
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();

        if self.geometry_name.trim().is_empty() {
            errors.push("fdm_grid_asset.geometry_name must not be empty".to_string());
        }
        for (axis, value) in ["x", "y", "z"].iter().zip(self.cells.iter()) {
            if *value == 0 {
                errors.push(format!("fdm_grid_asset.cells[{axis}] must be > 0"));
            }
        }
        for (axis, value) in ["x", "y", "z"].iter().zip(self.cell_size.iter()) {
            if *value <= 0.0 {
                errors.push(format!("fdm_grid_asset.cell_size[{axis}] must be positive"));
            }
        }

        let expected = self.cells[0] as usize * self.cells[1] as usize * self.cells[2] as usize;
        if self.active_mask.len() != expected {
            errors.push(format!(
                "fdm_grid_asset.active_mask length ({}) must match cells product ({expected})",
                self.active_mask.len()
            ));
        }
        if !self.active_mask.iter().any(|active| *active) {
            errors.push(
                "fdm_grid_asset.active_mask must contain at least one active cell".to_string(),
            );
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemMeshAssetIR {
    pub geometry_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh: Option<MeshIR>,
}

impl FemMeshAssetIR {
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();

        if self.geometry_name.trim().is_empty() {
            errors.push("fem_mesh_asset.geometry_name must not be empty".to_string());
        }
        if self.mesh.is_none() && self.mesh_source.is_none() {
            errors.push(
                "fem_mesh_asset must provide either an inline mesh or mesh_source".to_string(),
            );
        }
        if let Some(mesh) = &self.mesh {
            if let Err(mesh_errors) = validate_mesh_for_execution(mesh) {
                errors.extend(
                    mesh_errors
                        .into_iter()
                        .map(|error| format!("fem_mesh_asset.{}", error)),
                );
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemDomainRegionMarkerIR {
    pub geometry_name: String,
    pub marker: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct FemAirboxTargetIR {
    #[serde(
        rename = "maximum_element_size",
        alias = "hmax",
        skip_serializing_if = "Option::is_none"
    )]
    pub hmax: Option<f64>,
    #[serde(
        rename = "minimum_element_size",
        alias = "hmin",
        skip_serializing_if = "Option::is_none"
    )]
    pub hmin: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub growth_rate: Option<f64>,
}

/// Through-thickness sweep distribution for a single object.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SweepDistributionIR {
    /// Distribution kind: "uniform", "arithmetic", or "geometric".
    pub kind: String,
    /// Number of element layers through the sweep direction.
    pub num_layers: u32,
    /// Growth factor for arithmetic/geometric distributions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub growth_rate: Option<f64>,
}

/// Swept (through-thickness) mesh hints for a per-object mesh recipe.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SweptMeshHintsIR {
    /// Sweep direction: "auto", "x", "y", or "z".
    pub sweep_direction: String,
    /// Layer distribution through the sweep direction.
    pub distribution: SweepDistributionIR,
    /// Requested swept cell family: "prism" or "hex".
    #[serde(default = "default_swept_element_family")]
    pub element_family: String,
    /// Requested transition policy: "pyramid_to_tetrahedra" or "reject".
    #[serde(default = "default_swept_transition_policy")]
    pub transition_policy: String,
    /// Whether the realized mesh must preserve the exact requested layer count.
    #[serde(default)]
    pub exact_layer_count: bool,
}

fn default_swept_element_family() -> String {
    "prism".to_string()
}

fn default_swept_transition_policy() -> String {
    "reject".to_string()
}

/// Per-object mesh-size target as resolved by the Python meshing pipeline.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemPerObjectTargetIR {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker: Option<u32>,
    #[serde(
        rename = "maximum_element_size",
        alias = "hmax",
        skip_serializing_if = "Option::is_none"
    )]
    pub hmax: Option<f64>,
    #[serde(
        rename = "interface_maximum_element_size",
        alias = "interface_hmax",
        skip_serializing_if = "Option::is_none"
    )]
    pub interface_hmax: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interface_thickness: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition_distance: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition_distance_requested: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition_distance_effective: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition_realization: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition_growth: Option<f64>,
    #[serde(
        rename = "edge_maximum_element_size",
        alias = "edge_hmax",
        skip_serializing_if = "Option::is_none"
    )]
    pub edge_hmax: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edge_thickness: Option<f64>,
    #[serde(
        rename = "corner_maximum_element_size",
        alias = "corner_hmax",
        skip_serializing_if = "Option::is_none"
    )]
    pub corner_hmax: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub corner_extent: Option<f64>,
    #[serde(default)]
    pub source: String,
    /// Optional swept (through-thickness) mesh controls for this object.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swept: Option<SweptMeshHintsIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemMeshOperationStatusIR {
    pub kind: String,
    pub scope: String,
    pub requested: bool,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub details: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemThinFilmDiagnosticIR {
    pub geometry_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default)]
    pub is_thin_film: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thickness: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lateral_size: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aspect_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_layers: Option<u32>,
    #[serde(
        rename = "estimated_layers_from_maximum_element_size",
        alias = "estimated_layers_from_hmax",
        skip_serializing_if = "Option::is_none"
    )]
    pub estimated_layers_from_hmax: Option<u32>,
    #[serde(
        rename = "maximum_element_size_to_thickness_ratio",
        alias = "hmax_to_thickness_ratio",
        skip_serializing_if = "Option::is_none"
    )]
    pub hmax_to_thickness_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_method: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemMagneticSubmeshSignatureIR {
    pub geometry_name: String,
    pub marker: u32,
    pub node_count: u64,
    pub tetra_count: u64,
    pub edge_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coordinate_quantization_m: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
}

/// Fail-closed evidence for the qualified single-layer prism/pyramid/tet route.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MixedLayerTopologyCertificateV1IR {
    pub schema_version: String,
    pub certificate_status: String,
    pub requested_sweep_direction: String,
    pub resolved_sweep_direction: String,
    pub requested_layer_count: u32,
    pub realized_layer_count: u32,
    pub magnetic_plane_coordinates_m: Vec<f64>,
    pub plane_tolerance_m: f64,
    pub transition_shell_thickness_m: f64,
    pub transition_shell_interface_tri3_count: u64,
    pub interface_marker: u32,
    pub outer_boundary_marker: u32,
    pub magnetic_bounds_min_m: [f64; 3],
    pub magnetic_bounds_max_m: [f64; 3],
    pub airbox_bounds_min_m: [f64; 3],
    pub airbox_bounds_max_m: [f64; 3],
    pub magnetic_bounds_relative_error: f64,
    pub airbox_bounds_relative_error: f64,
    pub cell_family_counts_by_marker: BTreeMap<String, BTreeMap<String, u64>>,
    pub cell_family_counts_by_part: BTreeMap<String, BTreeMap<String, u64>>,
    pub facet_family_counts_by_role_marker: BTreeMap<String, BTreeMap<String, u64>>,
    pub jacobian_minima_m3_by_family: BTreeMap<String, f64>,
    pub quality_metric: String,
    pub scaled_jacobian_minima_by_family: BTreeMap<String, f64>,
    pub scaled_jacobian_p05_by_family: BTreeMap<String, f64>,
    pub magnetic_volume_m3: f64,
    pub expected_magnetic_volume_m3: f64,
    pub magnetic_relative_volume_error: f64,
    pub air_volume_m3: f64,
    pub shared_domain_volume_m3: f64,
    pub expected_shared_domain_volume_m3: f64,
    pub shared_domain_relative_volume_error: f64,
    pub marker_coverage_complete: bool,
    pub nonconforming_face_count: u64,
    pub orphan_face_count: u64,
    pub nonmanifold_face_count: u64,
    pub coincident_interface_face_count: u64,
    pub topology_fingerprint_version: String,
    pub topology_fingerprint: String,
    pub gmsh_version: String,
    pub strategy: String,
    pub effective_gmsh_thread_count: u32,
    pub deterministic_inputs: BTreeMap<String, Value>,
    #[serde(default)]
    pub fallbacks_triggered: Vec<String>,
}

impl MixedLayerTopologyCertificateV1IR {
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();
        if self.schema_version != "mixed_layer_topology_certificate.v1" {
            errors.push("mixed layer topology certificate schema_version must be mixed_layer_topology_certificate.v1".to_string());
        }
        if self.certificate_status != "accepted" {
            errors.push("mixed layer topology certificate status must be accepted".to_string());
        }
        if !matches!(self.requested_sweep_direction.as_str(), "x" | "y" | "z")
            || self.requested_sweep_direction != self.resolved_sweep_direction
        {
            errors.push(
                "mixed layer topology certificate sweep direction is invalid or changed"
                    .to_string(),
            );
        }
        if self.requested_layer_count == 0
            || self.requested_layer_count != self.realized_layer_count
            || self.magnetic_plane_coordinates_m.len() != self.realized_layer_count as usize + 1
        {
            errors.push(
                "mixed layer topology certificate layer count or planes are invalid".to_string(),
            );
        }
        if self
            .magnetic_plane_coordinates_m
            .iter()
            .any(|value| !value.is_finite())
            || self
                .magnetic_plane_coordinates_m
                .windows(2)
                .any(|pair| pair[1] <= pair[0])
        {
            errors.push(
                "mixed layer topology certificate magnetic planes must be finite and increasing"
                    .to_string(),
            );
        }
        for (name, value) in [
            ("plane_tolerance_m", self.plane_tolerance_m),
            (
                "transition_shell_thickness_m",
                self.transition_shell_thickness_m,
            ),
            ("magnetic_volume_m3", self.magnetic_volume_m3),
            (
                "expected_magnetic_volume_m3",
                self.expected_magnetic_volume_m3,
            ),
            ("air_volume_m3", self.air_volume_m3),
            ("shared_domain_volume_m3", self.shared_domain_volume_m3),
            (
                "expected_shared_domain_volume_m3",
                self.expected_shared_domain_volume_m3,
            ),
        ] {
            if !value.is_finite() || value <= 0.0 {
                errors.push(format!(
                    "mixed layer topology certificate {name} must be finite and positive"
                ));
            }
        }
        let relative_error = |actual: f64, expected: f64| {
            if actual.is_finite() && expected.is_finite() && expected > 0.0 {
                ((actual - expected) / expected).abs()
            } else {
                f64::INFINITY
            }
        };
        if relative_error(self.magnetic_volume_m3, self.expected_magnetic_volume_m3)
            > self.magnetic_relative_volume_error + 1.0e-15
            || relative_error(
                self.shared_domain_volume_m3,
                self.expected_shared_domain_volume_m3,
            ) > self.shared_domain_relative_volume_error + 1.0e-15
            || relative_error(
                self.magnetic_volume_m3 + self.air_volume_m3,
                self.shared_domain_volume_m3,
            ) > 1.0e-8
        {
            errors.push(
                "mixed layer topology certificate volume evidence is internally inconsistent"
                    .to_string(),
            );
        }
        if self.transition_shell_interface_tri3_count == 0
            || self.interface_marker == 0
            || self.outer_boundary_marker == 0
            || self.interface_marker == self.outer_boundary_marker
        {
            errors.push(
                "mixed layer topology certificate transition interface and markers are invalid"
                    .to_string(),
            );
        }
        for (name, minimum, maximum) in [
            (
                "magnetic",
                self.magnetic_bounds_min_m,
                self.magnetic_bounds_max_m,
            ),
            ("airbox", self.airbox_bounds_min_m, self.airbox_bounds_max_m),
        ] {
            if minimum
                .iter()
                .chain(maximum.iter())
                .any(|value| !value.is_finite())
                || minimum
                    .iter()
                    .zip(maximum.iter())
                    .any(|(left, right)| right <= left)
            {
                errors.push(format!(
                    "mixed layer topology certificate {name} bounds must be finite and increasing"
                ));
            }
        }
        for (name, value) in [
            (
                "magnetic_bounds_relative_error",
                self.magnetic_bounds_relative_error,
            ),
            (
                "airbox_bounds_relative_error",
                self.airbox_bounds_relative_error,
            ),
            (
                "magnetic_relative_volume_error",
                self.magnetic_relative_volume_error,
            ),
            (
                "shared_domain_relative_volume_error",
                self.shared_domain_relative_volume_error,
            ),
        ] {
            if !value.is_finite() || !(0.0..=1.0e-8).contains(&value) {
                errors.push(format!(
                    "mixed layer topology certificate {name} must be finite and <= 1e-8"
                ));
            }
        }
        if !self.marker_coverage_complete
            || self.nonconforming_face_count != 0
            || self.orphan_face_count != 0
            || self.nonmanifold_face_count != 0
            || self.coincident_interface_face_count != 0
        {
            errors.push(
                "mixed layer topology certificate conformity or marker coverage is invalid"
                    .to_string(),
            );
        }
        if !matches!(self.topology_fingerprint_version.as_str(), "v2" | "v3")
            || !is_sha256_fingerprint(&self.topology_fingerprint)
        {
            errors.push(
                "mixed layer topology certificate requires a valid v2 or v3 sha256 fingerprint"
                    .to_string(),
            );
        }
        if self.quality_metric != "tetra_decomposition_scaled_jacobian.v1" {
            errors
                .push("mixed layer topology certificate quality metric is unqualified".to_string());
        }
        if self.strategy != "shared_geo_extrusion_partitioned_pyramid_tet.v2" {
            errors.push("mixed layer topology certificate strategy is unqualified".to_string());
        }
        if self.gmsh_version != "4.15.2" {
            errors.push("mixed layer topology certificate Gmsh version is unqualified".to_string());
        }
        if self.effective_gmsh_thread_count != 1 {
            errors.push(
                "mixed layer topology certificate requires one effective Gmsh thread".to_string(),
            );
        }
        if !self.fallbacks_triggered.is_empty() {
            errors.push("mixed layer topology certificate must not contain fallbacks".to_string());
        }
        let expected_inputs: BTreeMap<String, Value> = serde_json::from_value(serde_json::json!({
            "algorithm_2d": 6,
            "algorithm_3d": 1,
            "element_order": 1,
            "gmsh_version": "4.15.2",
            "random_factor": 0.0,
            "thread_count": 1,
            "transition_partition": "cartesian_3x3x3_minus_magnetic_center",
            "transition_volume_count": 26,
            "pyramid_apex_optimizer": "bounded_per_apex_outward_scale_line_search",
            "pyramid_apex_scale_step": 0.001,
            "pyramid_apex_scale_max": 1.25,
            "scaled_jacobian_p05_min": 0.1
        }))
        .expect("qualified deterministic inputs are valid JSON");
        if self.deterministic_inputs != expected_inputs {
            errors.push(
                "mixed layer topology certificate deterministic inputs are stale".to_string(),
            );
        }

        let magnetic = self.cell_family_counts_by_part.get("magnetic");
        let transition = self.cell_family_counts_by_part.get("transition_air");
        let far = self.cell_family_counts_by_part.get("far_air");
        if self.cell_family_counts_by_part.len() != 3
            || magnetic.is_none_or(|counts| {
                counts.len() != 1 || counts.get("prism6").copied().unwrap_or(0) == 0
            })
            || transition.is_none_or(|counts| {
                counts.get("pyramid5").copied().unwrap_or(0) == 0
                    || counts
                        .keys()
                        .any(|family| !matches!(family.as_str(), "pyramid5" | "tet4"))
            })
            || far.is_none_or(|counts| {
                counts.len() != 1 || counts.get("tet4").copied().unwrap_or(0) == 0
            })
        {
            errors.push(
                "mixed layer topology certificate cell families by part are invalid".to_string(),
            );
        }
        if let (Some(magnetic), Some(transition), Some(far)) = (magnetic, transition, far) {
            let mut air = transition.clone();
            for (family, count) in far {
                *air.entry(family.clone()).or_default() += count;
            }
            if self.cell_family_counts_by_marker.len() != 2
                || self.cell_family_counts_by_marker.get("1") != Some(magnetic)
                || self.cell_family_counts_by_marker.get("0") != Some(&air)
            {
                errors.push(
                    "mixed layer topology certificate marker and part cell counts disagree"
                        .to_string(),
                );
            }
        }
        let families = self
            .cell_family_counts_by_part
            .values()
            .flat_map(|counts| counts.keys().cloned())
            .collect::<BTreeSet<_>>();
        for (name, values, minimum) in [
            (
                "jacobian_minima_m3_by_family",
                &self.jacobian_minima_m3_by_family,
                0.0,
            ),
            (
                "scaled_jacobian_minima_by_family",
                &self.scaled_jacobian_minima_by_family,
                0.0,
            ),
            (
                "scaled_jacobian_p05_by_family",
                &self.scaled_jacobian_p05_by_family,
                0.1,
            ),
        ] {
            if values.keys().cloned().collect::<BTreeSet<_>>() != families
                || values.values().any(|value| {
                    !value.is_finite() || *value < minimum || (minimum == 0.0 && *value == 0.0)
                })
            {
                errors.push(format!(
                    "mixed layer topology certificate {name} is incomplete or unqualified"
                ));
            }
        }
        let interface_key = format!("material_interface:{}", self.interface_marker);
        let outer_key = format!("exterior:{}", self.outer_boundary_marker);
        if !self
            .facet_family_counts_by_role_marker
            .get(&interface_key)
            .is_some_and(|counts| !counts.is_empty())
            || !self
                .facet_family_counts_by_role_marker
                .get(&outer_key)
                .is_some_and(|counts| !counts.is_empty())
        {
            errors.push(
                "mixed layer topology certificate facet family evidence is incomplete".to_string(),
            );
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

fn is_sha256_fingerprint(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn mixed_certificate_counts_match_mesh(
    certificate: &MixedLayerTopologyCertificateV1IR,
    mesh: &MeshIR,
) -> bool {
    if mesh.cells.mesh_parts.len() != mesh.cells.types.len() {
        return false;
    }
    let mut by_marker: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    let mut by_part: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    for ((cell_type, mesh_part), marker) in mesh
        .cells
        .types
        .iter()
        .zip(mesh.cells.mesh_parts.iter())
        .zip(mesh.element_markers.iter())
    {
        let family = match cell_type {
            crate::FemCellTypeIR::Tet4 => "tet4",
            crate::FemCellTypeIR::Prism6 => "prism6",
            crate::FemCellTypeIR::Pyramid5 => "pyramid5",
            crate::FemCellTypeIR::Hex8 => "hex8",
        };
        let part = match mesh_part {
            crate::FemCellMeshPartIR::Magnetic => "magnetic",
            crate::FemCellMeshPartIR::TransitionAir => "transition_air",
            crate::FemCellMeshPartIR::FarAir => "far_air",
        };
        *by_marker
            .entry(marker.to_string())
            .or_default()
            .entry(family.to_string())
            .or_default() += 1;
        *by_part
            .entry(part.to_string())
            .or_default()
            .entry(family.to_string())
            .or_default() += 1;
    }
    let mut by_facet: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    for ((facet_type, role), marker) in mesh
        .facets
        .types
        .iter()
        .zip(mesh.facets.roles.iter())
        .zip(mesh.boundary_markers.iter())
    {
        let family = match facet_type {
            crate::FemFacetTypeIR::Tri3 => "tri3",
            crate::FemFacetTypeIR::Quad4 => "quad4",
        };
        let role = match role {
            crate::FemFacetRoleIR::Exterior => "exterior",
            crate::FemFacetRoleIR::MaterialInterface => "material_interface",
            crate::FemFacetRoleIR::PeriodicSeam => "periodic_seam",
        };
        *by_facet
            .entry(format!("{role}:{marker}"))
            .or_default()
            .entry(family.to_string())
            .or_default() += 1;
    }
    certificate.cell_family_counts_by_marker == by_marker
        && certificate.cell_family_counts_by_part == by_part
        && certificate.facet_family_counts_by_role_marker == by_facet
}

#[derive(Debug)]
struct RecomputedMixedCertificateEvidence {
    planes: Vec<f64>,
    plane_tolerance: f64,
    shell_thickness: f64,
    shell_face_count: u64,
    jacobian_minima: BTreeMap<String, f64>,
    scaled_minima: BTreeMap<String, f64>,
    scaled_p05: BTreeMap<String, f64>,
    magnetic_volume: f64,
    expected_magnetic_volume: f64,
    air_volume: f64,
    shared_volume: f64,
    expected_shared_volume: f64,
    magnetic_bounds_error: f64,
    airbox_bounds_error: f64,
    nonconforming: u64,
    orphan: u64,
    nonmanifold: u64,
    coincident_interface: u64,
}

fn mixed_local_facets(cell_type: crate::FemCellTypeIR) -> &'static [&'static [usize]] {
    match cell_type {
        crate::FemCellTypeIR::Tet4 => &[&[0, 1, 2], &[0, 1, 3], &[0, 2, 3], &[1, 2, 3]],
        crate::FemCellTypeIR::Prism6 => &[
            &[0, 1, 2],
            &[3, 5, 4],
            &[0, 3, 4, 1],
            &[1, 4, 5, 2],
            &[2, 5, 3, 0],
        ],
        crate::FemCellTypeIR::Pyramid5 => &[
            &[0, 3, 2, 1],
            &[0, 1, 4],
            &[1, 2, 4],
            &[2, 3, 4],
            &[3, 0, 4],
        ],
        crate::FemCellTypeIR::Hex8 => &[
            &[0, 3, 2, 1],
            &[4, 5, 6, 7],
            &[0, 1, 5, 4],
            &[1, 2, 6, 5],
            &[2, 3, 7, 6],
            &[3, 0, 4, 7],
        ],
    }
}

fn sub3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm3(value: [f64; 3]) -> f64 {
    dot3(value, value).sqrt()
}

fn det3(columns: [[f64; 3]; 3]) -> f64 {
    dot3(columns[0], cross3(columns[1], columns[2]))
}

fn tet_det(points: &[[f64; 3]], indices: [usize; 4]) -> f64 {
    det3([
        sub3(points[indices[1]], points[indices[0]]),
        sub3(points[indices[2]], points[indices[0]]),
        sub3(points[indices[3]], points[indices[0]]),
    ])
}

fn mixed_tets(cell_type: crate::FemCellTypeIR) -> Result<&'static [[usize; 4]], String> {
    match cell_type {
        crate::FemCellTypeIR::Tet4 => Ok(&[[0, 1, 2, 3]]),
        crate::FemCellTypeIR::Prism6 => Ok(&[[0, 1, 2, 3], [1, 2, 3, 4], [2, 3, 4, 5]]),
        crate::FemCellTypeIR::Pyramid5 => Ok(&[[0, 1, 2, 4], [0, 2, 3, 4]]),
        crate::FemCellTypeIR::Hex8 => {
            Err("mixed certificate does not qualify hex8 cells".to_string())
        }
    }
}

fn mixed_cell_volume(cell_type: crate::FemCellTypeIR, points: &[[f64; 3]]) -> Result<f64, String> {
    Ok(mixed_tets(cell_type)?
        .iter()
        .map(|indices| tet_det(points, *indices).abs() / 6.0)
        .sum())
}

fn mixed_scaled_jacobians(
    cell_type: crate::FemCellTypeIR,
    points: &[[f64; 3]],
) -> Result<Vec<f64>, String> {
    Ok(mixed_tets(cell_type)?
        .iter()
        .map(|indices| {
            let columns = [
                sub3(points[indices[1]], points[indices[0]]),
                sub3(points[indices[2]], points[indices[0]]),
                sub3(points[indices[3]], points[indices[0]]),
            ];
            let denominator = columns.iter().copied().map(norm3).product::<f64>();
            if denominator == 0.0 {
                0.0
            } else {
                det3(columns).abs() / denominator
            }
        })
        .collect())
}

fn percentile_05(values: &mut [f64]) -> Option<f64> {
    values.sort_by(f64::total_cmp);
    let position = values.len().checked_sub(1)? as f64 * 0.05;
    let lower = position.floor() as usize;
    let upper = position.ceil() as usize;
    let weight = position - lower as f64;
    Some(values[lower] * (1.0 - weight) + values[upper] * weight)
}

fn float_close(left: f64, right: f64, relative: f64, absolute: f64) -> bool {
    (left - right).abs() <= absolute.max(relative * left.abs().max(right.abs()))
}

// NumPy/LAPACK determinant and reduction order can differ from the direct Rust
// arithmetic by a few ulps. This applies only to dimensionless certificate
// evidence; dimensional Jacobians and volumes retain their stricter checks.
const MIXED_DIMENSIONLESS_ABSOLUTE_TOLERANCE: f64 = f64::EPSILON * 16.0;
const MIXED_RELATIVE_VOLUME_ERROR_ABSOLUTE_TOLERANCE: f64 = 4.0e-12;

fn dimensionless_float_close(left: f64, right: f64) -> bool {
    float_close(left, right, 1.0e-12, MIXED_DIMENSIONLESS_ABSOLUTE_TOLERANCE)
}

fn mixed_relative_volume_error_close(left: f64, right: f64) -> bool {
    float_close(
        left,
        right,
        1.0e-12,
        MIXED_RELATIVE_VOLUME_ERROR_ABSOLUTE_TOLERANCE,
    )
}

fn bounds_for_nodes(
    mesh: &MeshIR,
    node_ids: &BTreeSet<u32>,
) -> Result<([f64; 3], [f64; 3]), String> {
    let first = node_ids
        .iter()
        .next()
        .and_then(|id| mesh.nodes.get(*id as usize))
        .ok_or_else(|| "mixed certificate requires non-empty valid node sets".to_string())?;
    let mut minimum = *first;
    let mut maximum = *first;
    for node_id in node_ids {
        let point = mesh
            .nodes
            .get(*node_id as usize)
            .ok_or_else(|| format!("mixed certificate references missing node {node_id}"))?;
        for axis in 0..3 {
            minimum[axis] = minimum[axis].min(point[axis]);
            maximum[axis] = maximum[axis].max(point[axis]);
        }
    }
    Ok((minimum, maximum))
}

fn bounds_relative_error(realized: ([f64; 3], [f64; 3]), authored: ([f64; 3], [f64; 3])) -> f64 {
    let scale = (0..3)
        .map(|axis| authored.1[axis] - authored.0[axis])
        .fold(0.0, f64::max);
    let residual = (0..3)
        .flat_map(|axis| {
            [
                (realized.0[axis] - authored.0[axis]).abs(),
                (realized.1[axis] - authored.1[axis]).abs(),
            ]
        })
        .fold(0.0, f64::max);
    residual / scale
}

fn mixed_face_adjacency(mesh: &MeshIR) -> Result<BTreeMap<Vec<u32>, Vec<(usize, u32)>>, String> {
    let mut adjacency = BTreeMap::<Vec<u32>, Vec<(usize, u32)>>::new();
    for (ordinal, cell_type) in mesh.cells.types.iter().copied().enumerate() {
        let nodes = mesh
            .cells
            .item_nodes(ordinal)
            .ok_or_else(|| format!("mixed certificate cell {ordinal} has invalid CSR"))?;
        let marker = *mesh
            .element_markers
            .get(ordinal)
            .ok_or_else(|| format!("mixed certificate cell {ordinal} is missing a marker"))?;
        for local_face in mixed_local_facets(cell_type) {
            let mut key = local_face
                .iter()
                .map(|index| nodes[*index])
                .collect::<Vec<_>>();
            key.sort_unstable();
            adjacency.entry(key).or_default().push((ordinal, marker));
        }
    }
    Ok(adjacency)
}

fn same_side_face_count(
    mesh: &MeshIR,
    adjacency: &BTreeMap<Vec<u32>, Vec<(usize, u32)>>,
    tolerance: f64,
) -> Result<u64, String> {
    let mut count = 0;
    for (face, owners) in adjacency.iter().filter(|(_, owners)| owners.len() == 2) {
        let coordinates =
            face.iter()
                .map(|node| {
                    mesh.nodes.get(*node as usize).copied().ok_or_else(|| {
                        format!("mixed certificate face references missing node {node}")
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
        let mut normal = None;
        'normal: for first in 1..coordinates.len() {
            for second in first + 1..coordinates.len() {
                let candidate = cross3(
                    sub3(coordinates[first], coordinates[0]),
                    sub3(coordinates[second], coordinates[0]),
                );
                let length = norm3(candidate);
                if length > 0.0 {
                    normal = Some([
                        candidate[0] / length,
                        candidate[1] / length,
                        candidate[2] / length,
                    ]);
                    break 'normal;
                }
            }
        }
        let Some(normal) = normal else {
            count += 1;
            continue;
        };
        let mut face_scale: f64 = 0.0;
        for left in 0..coordinates.len() {
            for right in left + 1..coordinates.len() {
                face_scale = face_scale.max(norm3(sub3(coordinates[right], coordinates[left])));
            }
        }
        let side_tolerance = tolerance.max(f64::EPSILON * face_scale.max(1.0e-30) * 64.0);
        let mut distances = Vec::with_capacity(2);
        for (owner, _) in owners {
            let owner_nodes = mesh
                .cells
                .item_nodes(*owner)
                .ok_or_else(|| format!("mixed certificate cell {owner} has invalid CSR"))?;
            let opposite = owner_nodes
                .iter()
                .filter(|node| !face.contains(node))
                .filter_map(|node| mesh.nodes.get(*node as usize))
                .collect::<Vec<_>>();
            if opposite.is_empty() {
                distances.push(0.0);
                continue;
            }
            let mut interior = [0.0; 3];
            for point in &opposite {
                for axis in 0..3 {
                    interior[axis] += point[axis];
                }
            }
            for value in &mut interior {
                *value /= opposite.len() as f64;
            }
            distances.push(dot3(sub3(interior, coordinates[0]), normal));
        }
        if distances[0].abs() > side_tolerance
            && distances[1].abs() > side_tolerance
            && distances[0] * distances[1] > 0.0
        {
            count += 1;
        }
    }
    Ok(count)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct MixedExplicitRoleCounts {
    explicit: usize,
    exterior: usize,
    interface: usize,
}

fn mixed_explicit_role_counts(
    faces: &[(Vec<u32>, crate::FemFacetRoleIR)],
) -> BTreeMap<Vec<u32>, MixedExplicitRoleCounts> {
    let mut counts = BTreeMap::<Vec<u32>, MixedExplicitRoleCounts>::new();
    for (key, role) in faces {
        let entry = counts.entry(key.clone()).or_default();
        entry.explicit += 1;
        match role {
            crate::FemFacetRoleIR::Exterior => entry.exterior += 1,
            crate::FemFacetRoleIR::MaterialInterface => entry.interface += 1,
            crate::FemFacetRoleIR::PeriodicSeam => {}
        }
    }
    counts
}

fn mixed_conformity_counts(
    mesh: &MeshIR,
    adjacency: &BTreeMap<Vec<u32>, Vec<(usize, u32)>>,
    tolerance: f64,
    interface_marker: u32,
    outer_marker: u32,
) -> Result<(u64, u64, u64, u64), String> {
    let explicit_faces = (0..mesh.facets.types.len())
        .map(|ordinal| {
            let mut key = mesh
                .facets
                .item_nodes(ordinal)
                .ok_or_else(|| format!("mixed certificate facet {ordinal} has invalid CSR"))?
                .to_vec();
            key.sort_unstable();
            Ok((key, mesh.facets.roles[ordinal]))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let explicit = mixed_explicit_role_counts(&explicit_faces);
    let mut orphan = 0u64;
    let mut nonconforming = 0u64;
    for (ordinal, (key, role)) in explicit_faces.iter().enumerate() {
        let owners = adjacency.get(key).map(Vec::as_slice).unwrap_or_default();
        if owners.is_empty() {
            orphan += 1;
            continue;
        }
        match role {
            crate::FemFacetRoleIR::Exterior => {
                if owners.len() != 1 || mesh.boundary_markers[ordinal] != outer_marker {
                    nonconforming += 1;
                }
            }
            crate::FemFacetRoleIR::MaterialInterface => {
                let markers = owners
                    .iter()
                    .map(|(_, marker)| *marker)
                    .collect::<BTreeSet<_>>();
                if owners.len() != 2
                    || markers != BTreeSet::from([0, 1])
                    || mesh.boundary_markers[ordinal] != interface_marker
                {
                    nonconforming += 1;
                }
            }
            crate::FemFacetRoleIR::PeriodicSeam => {}
        }
    }
    let nonmanifold = adjacency.values().filter(|owners| owners.len() > 2).count() as u64;
    nonconforming += same_side_face_count(mesh, adjacency, tolerance)?;
    for (key, owners) in adjacency {
        let role_counts = explicit.get(key).copied().unwrap_or_default();
        let exterior_count = role_counts.exterior;
        let interface_count = role_counts.interface;
        if owners.len() == 1 && exterior_count != 1 {
            nonconforming += 1;
        }
        if owners.len() == 2 && owners[0].1 != owners[1].1 && interface_count != 1 {
            nonconforming += 1;
        }
        if exterior_count > 1 {
            nonconforming += (exterior_count - 1) as u64;
        }
    }
    let duplicate_faces = explicit
        .values()
        .filter(|counts| counts.interface > 0)
        .map(|counts| counts.explicit.saturating_sub(1))
        .sum::<usize>() as u64;
    let interface_nodes = explicit
        .iter()
        .filter(|(_, counts)| counts.interface > 0)
        .flat_map(|(face, _)| face.iter().copied())
        .collect::<BTreeSet<_>>();
    let scale = tolerance.max(f64::EPSILON);
    let mut coordinate_keys = BTreeMap::<[u64; 3], u32>::new();
    let mut duplicate_nodes = 0u64;
    for node in interface_nodes {
        let point = mesh.nodes[node as usize];
        let key = mixed_coordinate_key(point, scale)?;
        if coordinate_keys
            .insert(key, node)
            .is_some_and(|prior| prior != node)
        {
            duplicate_nodes += 1;
        }
    }
    Ok((
        nonconforming,
        orphan,
        nonmanifold,
        duplicate_faces + duplicate_nodes,
    ))
}

fn mixed_coordinate_key(point: [f64; 3], scale: f64) -> Result<[u64; 3], String> {
    if !scale.is_finite() || scale <= 0.0 {
        return Err(
            "mixed certificate coordinate quantization requires a positive finite scale"
                .to_string(),
        );
    }
    let mut key = [0u64; 3];
    for axis in 0..3 {
        let quotient = point[axis] / scale;
        if !quotient.is_finite() {
            return Err(
                "mixed certificate coordinate quantization overflowed Python round semantics"
                    .to_string(),
            );
        }
        let rounded = quotient.round_ties_even();
        key[axis] = if rounded == 0.0 { 0.0 } else { rounded }.to_bits();
    }
    Ok(key)
}

fn recompute_mixed_certificate_evidence(
    certificate: &MixedLayerTopologyCertificateV1IR,
    mesh: &MeshIR,
) -> Result<RecomputedMixedCertificateEvidence, String> {
    validate_mesh_for_execution(mesh).map_err(|errors| {
        format!(
            "mixed certificate requires a valid executable mesh: {}",
            errors.join("; ")
        )
    })?;
    if mesh.cells.mesh_parts.len() != mesh.cells.types.len() {
        return Err("mixed certificate requires one mesh part per cell".to_string());
    }
    let mut magnetic_nodes = BTreeSet::new();
    let mut transition_nodes = BTreeSet::new();
    let mut volumes = Vec::with_capacity(mesh.cells.types.len());
    let mut jacobians = BTreeMap::<String, Vec<f64>>::new();
    let mut scaled = BTreeMap::<String, Vec<f64>>::new();
    for ordinal in 0..mesh.cells.types.len() {
        let cell_type = mesh.cells.types[ordinal];
        let part = mesh.cells.mesh_parts[ordinal];
        let marker = *mesh
            .element_markers
            .get(ordinal)
            .ok_or_else(|| format!("mixed certificate cell {ordinal} is missing a marker"))?;
        let legal = matches!(
            (part, cell_type, marker),
            (
                crate::FemCellMeshPartIR::Magnetic,
                crate::FemCellTypeIR::Prism6,
                1
            ) | (
                crate::FemCellMeshPartIR::TransitionAir,
                crate::FemCellTypeIR::Pyramid5 | crate::FemCellTypeIR::Tet4,
                0
            ) | (
                crate::FemCellMeshPartIR::FarAir,
                crate::FemCellTypeIR::Tet4,
                0
            )
        );
        if !legal {
            return Err(format!(
                "mixed certificate cell {ordinal} has invalid mesh part/family/marker"
            ));
        }
        let node_ids = mesh
            .cells
            .item_nodes(ordinal)
            .ok_or_else(|| format!("mixed certificate cell {ordinal} has invalid CSR"))?;
        match part {
            crate::FemCellMeshPartIR::Magnetic => magnetic_nodes.extend(node_ids),
            crate::FemCellMeshPartIR::TransitionAir => transition_nodes.extend(node_ids),
            crate::FemCellMeshPartIR::FarAir => {}
        }
        let points = node_ids
            .iter()
            .map(|node| {
                mesh.nodes.get(*node as usize).copied().ok_or_else(|| {
                    format!("mixed certificate cell {ordinal} references missing node {node}")
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        volumes.push(mixed_cell_volume(cell_type, &points)?);
        let family = match cell_type {
            crate::FemCellTypeIR::Tet4 => "tet4",
            crate::FemCellTypeIR::Prism6 => "prism6",
            crate::FemCellTypeIR::Pyramid5 => "pyramid5",
            crate::FemCellTypeIR::Hex8 => "hex8",
        };
        jacobians.entry(family.to_string()).or_default().extend(
            crate::mesh_hints::cell_jacobian_determinants(cell_type, &points),
        );
        scaled
            .entry(family.to_string())
            .or_default()
            .extend(mixed_scaled_jacobians(cell_type, &points)?);
    }
    if !mixed_certificate_counts_match_mesh(certificate, mesh) {
        return Err("mixed certificate cell/facet counts disagree with the mesh".to_string());
    }

    let interface_quads = mesh
        .facets
        .types
        .iter()
        .zip(&mesh.facets.roles)
        .enumerate()
        .filter_map(|(ordinal, (family, role))| {
            (*family == crate::FemFacetTypeIR::Quad4
                && *role == crate::FemFacetRoleIR::MaterialInterface
                && mesh.boundary_markers.get(ordinal) == Some(&certificate.interface_marker))
            .then(|| {
                let mut key = mesh.facets.item_nodes(ordinal).unwrap_or_default().to_vec();
                key.sort_unstable();
                key
            })
        })
        .collect::<BTreeSet<_>>();
    let pyramid_bases = mesh
        .cells
        .types
        .iter()
        .enumerate()
        .filter_map(|(ordinal, family)| {
            (*family == crate::FemCellTypeIR::Pyramid5).then(|| {
                let nodes = mesh.cells.item_nodes(ordinal).unwrap_or_default();
                let mut key = nodes.get(0..4).unwrap_or_default().to_vec();
                key.sort_unstable();
                key
            })
        })
        .collect::<BTreeSet<_>>();
    if pyramid_bases.is_empty() || !pyramid_bases.is_subset(&interface_quads) {
        return Err(format!("mixed certificate pyramid bases must be exact quad4 material-interface facets with marker {}", certificate.interface_marker));
    }

    let magnetic_bounds = bounds_for_nodes(mesh, &magnetic_nodes)?;
    let transition_bounds = bounds_for_nodes(mesh, &transition_nodes)?;
    let outer_bounds = bounds_for_nodes(mesh, &(0..mesh.nodes.len() as u32).collect())?;
    let magnetic_authored = (
        certificate.magnetic_bounds_min_m,
        certificate.magnetic_bounds_max_m,
    );
    let airbox_authored = (
        certificate.airbox_bounds_min_m,
        certificate.airbox_bounds_max_m,
    );
    let magnetic_bounds_error = bounds_relative_error(magnetic_bounds, magnetic_authored);
    let airbox_bounds_error = bounds_relative_error(outer_bounds, airbox_authored);
    if magnetic_bounds_error > 1.0e-8 || airbox_bounds_error > 1.0e-8 {
        return Err(
            "mixed certificate realized bounds do not match authored CAD bounds".to_string(),
        );
    }
    let shell_offsets = [
        magnetic_bounds.0[0] - transition_bounds.0[0],
        magnetic_bounds.0[1] - transition_bounds.0[1],
        magnetic_bounds.0[2] - transition_bounds.0[2],
        transition_bounds.1[0] - magnetic_bounds.1[0],
        transition_bounds.1[1] - magnetic_bounds.1[1],
        transition_bounds.1[2] - magnetic_bounds.1[2],
    ];
    let shell_thickness = shell_offsets.iter().sum::<f64>() / shell_offsets.len() as f64;
    if shell_offsets.iter().any(|value| {
        *value <= 0.0
            || (*value - shell_thickness).abs() > 1.0e-15 + 1.0e-10 * shell_thickness.abs()
    }) {
        return Err("mixed certificate transition shell thickness is not uniform".to_string());
    }

    let axis = match certificate.resolved_sweep_direction.as_str() {
        "x" => 0,
        "y" => 1,
        "z" => 2,
        _ => return Err("mixed certificate sweep direction is invalid".to_string()),
    };
    let mut coordinates = magnetic_nodes
        .iter()
        .map(|node| mesh.nodes[*node as usize][axis])
        .collect::<Vec<_>>();
    coordinates.sort_by(f64::total_cmp);
    let thickness = coordinates.last().unwrap() - coordinates.first().unwrap();
    let plane_tolerance = 1.0e-15_f64.max(1.0e-8 * thickness);
    let mut planes = Vec::<f64>::new();
    for value in coordinates {
        if planes
            .last()
            .is_none_or(|prior| (value - prior).abs() > plane_tolerance)
        {
            planes.push(value);
        }
    }

    let adjacency = mixed_face_adjacency(mesh)?;
    let shell_faces = adjacency
        .iter()
        .filter(|(_face, owners)| {
            owners.len() == 2
                && owners
                    .iter()
                    .map(|(ordinal, _)| mesh.cells.mesh_parts[*ordinal])
                    .collect::<BTreeSet<_>>()
                    == BTreeSet::from([
                        crate::FemCellMeshPartIR::TransitionAir,
                        crate::FemCellMeshPartIR::FarAir,
                    ])
        })
        .map(|(face, _)| face)
        .collect::<Vec<_>>();
    if shell_faces.is_empty() || shell_faces.iter().any(|face| face.len() != 3) {
        return Err("mixed certificate transition shell interface is not tri3".to_string());
    }
    let shell_face_count = shell_faces.len() as u64;

    let jacobian_minima = jacobians
        .into_iter()
        .map(|(family, values)| (family, values.into_iter().min_by(f64::total_cmp).unwrap()))
        .collect();
    let mut scaled_minima = BTreeMap::new();
    let mut scaled_p05 = BTreeMap::new();
    for (family, mut values) in scaled {
        scaled_minima.insert(
            family.clone(),
            values.iter().copied().min_by(f64::total_cmp).unwrap(),
        );
        scaled_p05.insert(family, percentile_05(&mut values).unwrap());
    }
    let magnetic_volume = volumes
        .iter()
        .zip(&mesh.cells.mesh_parts)
        .filter_map(|(volume, part)| {
            (*part == crate::FemCellMeshPartIR::Magnetic).then_some(*volume)
        })
        .sum::<f64>();
    let shared_volume = volumes.iter().sum::<f64>();
    let expected_magnetic_volume = (0..3)
        .map(|axis| magnetic_authored.1[axis] - magnetic_authored.0[axis])
        .product::<f64>();
    let expected_shared_volume = (0..3)
        .map(|axis| airbox_authored.1[axis] - airbox_authored.0[axis])
        .product::<f64>();
    let (nonconforming, orphan, nonmanifold, coincident_interface) = mixed_conformity_counts(
        mesh,
        &adjacency,
        plane_tolerance,
        certificate.interface_marker,
        certificate.outer_boundary_marker,
    )?;
    Ok(RecomputedMixedCertificateEvidence {
        planes,
        plane_tolerance,
        shell_thickness,
        shell_face_count,
        jacobian_minima,
        scaled_minima,
        scaled_p05,
        magnetic_volume,
        expected_magnetic_volume,
        air_volume: shared_volume - magnetic_volume,
        shared_volume,
        expected_shared_volume,
        magnetic_bounds_error,
        airbox_bounds_error,
        nonconforming,
        orphan,
        nonmanifold,
        coincident_interface,
    })
}

fn float_map_close(claimed: &BTreeMap<String, f64>, actual: &BTreeMap<String, f64>) -> bool {
    claimed.len() == actual.len()
        && claimed.iter().all(|(key, value)| {
            actual
                .get(key)
                .is_some_and(|actual| float_close(*value, *actual, 1.0e-12, 1.0e-30))
        })
}

fn dimensionless_float_map_close(
    claimed: &BTreeMap<String, f64>,
    actual: &BTreeMap<String, f64>,
) -> bool {
    claimed.len() == actual.len()
        && claimed.iter().all(|(key, value)| {
            actual
                .get(key)
                .is_some_and(|actual| dimensionless_float_close(*value, *actual))
        })
}

fn validate_mixed_certificate_evidence_against_mesh(
    certificate: &MixedLayerTopologyCertificateV1IR,
    mesh: &MeshIR,
) -> Result<(), Vec<String>> {
    let evidence =
        recompute_mixed_certificate_evidence(certificate, mesh).map_err(|error| vec![error])?;
    let mut stale = Vec::new();
    let plane_tolerance = certificate.plane_tolerance_m.max(evidence.plane_tolerance);
    if certificate.magnetic_plane_coordinates_m.len() != evidence.planes.len()
        || !certificate
            .magnetic_plane_coordinates_m
            .iter()
            .zip(&evidence.planes)
            .all(|(claimed, actual)| (claimed - actual).abs() <= plane_tolerance)
    {
        stale.push("magnetic_plane_coordinates_m");
    }
    macro_rules! float_field {
        ($claimed:expr, $actual:expr, $name:literal) => {
            if !float_close($claimed, $actual, 1.0e-12, 1.0e-30) {
                stale.push($name);
            }
        };
    }
    macro_rules! exact_field {
        ($claimed:expr, $actual:expr, $name:literal) => {
            if $claimed != $actual {
                stale.push($name);
            }
        };
    }
    float_field!(
        certificate.plane_tolerance_m,
        evidence.plane_tolerance,
        "plane_tolerance_m"
    );
    float_field!(
        certificate.transition_shell_thickness_m,
        evidence.shell_thickness,
        "transition_shell_thickness_m"
    );
    exact_field!(
        certificate.transition_shell_interface_tri3_count,
        evidence.shell_face_count,
        "transition_shell_interface_tri3_count"
    );
    if !float_map_close(
        &certificate.jacobian_minima_m3_by_family,
        &evidence.jacobian_minima,
    ) {
        stale.push("jacobian_minima_m3_by_family");
    }
    if !dimensionless_float_map_close(
        &certificate.scaled_jacobian_minima_by_family,
        &evidence.scaled_minima,
    ) {
        stale.push("scaled_jacobian_minima_by_family");
    }
    if !dimensionless_float_map_close(
        &certificate.scaled_jacobian_p05_by_family,
        &evidence.scaled_p05,
    ) {
        stale.push("scaled_jacobian_p05_by_family");
    }
    float_field!(
        certificate.magnetic_volume_m3,
        evidence.magnetic_volume,
        "magnetic_volume_m3"
    );
    float_field!(
        certificate.expected_magnetic_volume_m3,
        evidence.expected_magnetic_volume,
        "expected_magnetic_volume_m3"
    );
    let magnetic_relative_volume_error = ((evidence.magnetic_volume
        - evidence.expected_magnetic_volume)
        / evidence.expected_magnetic_volume)
        .abs();
    if !mixed_relative_volume_error_close(
        certificate.magnetic_relative_volume_error,
        magnetic_relative_volume_error,
    ) {
        stale.push("magnetic_relative_volume_error");
    }
    float_field!(
        certificate.air_volume_m3,
        evidence.air_volume,
        "air_volume_m3"
    );
    float_field!(
        certificate.shared_domain_volume_m3,
        evidence.shared_volume,
        "shared_domain_volume_m3"
    );
    float_field!(
        certificate.expected_shared_domain_volume_m3,
        evidence.expected_shared_volume,
        "expected_shared_domain_volume_m3"
    );
    let shared_domain_relative_volume_error = ((evidence.shared_volume
        - evidence.expected_shared_volume)
        / evidence.expected_shared_volume)
        .abs();
    if !mixed_relative_volume_error_close(
        certificate.shared_domain_relative_volume_error,
        shared_domain_relative_volume_error,
    ) {
        stale.push("shared_domain_relative_volume_error");
    }
    float_field!(
        certificate.magnetic_bounds_relative_error,
        evidence.magnetic_bounds_error,
        "magnetic_bounds_relative_error"
    );
    float_field!(
        certificate.airbox_bounds_relative_error,
        evidence.airbox_bounds_error,
        "airbox_bounds_relative_error"
    );
    exact_field!(
        certificate.marker_coverage_complete,
        true,
        "marker_coverage_complete"
    );
    exact_field!(
        certificate.nonconforming_face_count,
        evidence.nonconforming,
        "nonconforming_face_count"
    );
    exact_field!(
        certificate.orphan_face_count,
        evidence.orphan,
        "orphan_face_count"
    );
    exact_field!(
        certificate.nonmanifold_face_count,
        evidence.nonmanifold,
        "nonmanifold_face_count"
    );
    exact_field!(
        certificate.coincident_interface_face_count,
        evidence.coincident_interface,
        "coincident_interface_face_count"
    );
    if stale.is_empty() {
        Ok(())
    } else {
        Err(vec![format!(
            "mixed layer topology certificate recomputed evidence is stale: {}",
            stale.join(", ")
        )])
    }
}

/// Validate an accepted mixed-layer topology certificate against its exact mesh.
///
/// This is the canonical boundary for consumers that receive the certificate
/// separately from `FemDomainMeshAssetIR`: it validates the certificate schema
/// and status, binds its fingerprint to `mesh`, and recomputes mesh-derived
/// evidence rather than trusting internally consistent certificate claims.
pub fn validate_mixed_layer_topology_certificate_against_mesh(
    certificate: &MixedLayerTopologyCertificateV1IR,
    mesh: &MeshIR,
) -> Result<(), Vec<String>> {
    let mut errors = certificate.validate().err().unwrap_or_default();
    match mesh.mixed_topology_fingerprint_for_version(&certificate.topology_fingerprint_version) {
        Ok(fingerprint) if certificate.topology_fingerprint != fingerprint => {
            errors.push("mixed layer topology certificate fingerprint is stale".to_string());
        }
        Ok(_) => {
            if let Err(evidence_errors) =
                validate_mixed_certificate_evidence_against_mesh(certificate, mesh)
            {
                errors.extend(evidence_errors);
            }
        }
        Err(error) => errors.push(error),
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

fn mesh_has_mixed_topology(mesh: &MeshIR) -> bool {
    mesh.cells
        .types
        .iter()
        .any(|cell_type| *cell_type != crate::FemCellTypeIR::Tet4)
        || mesh
            .facets
            .types
            .iter()
            .any(|facet_type| *facet_type != crate::FemFacetTypeIR::Tri3)
}

/// Build report for a shared-domain FEM mesh, propagated from the Python
/// meshing pipeline so the planner / runner can inspect how the mesh was built.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemSharedDomainBuildReportIR {
    pub build_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallbacks_triggered: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_airbox_target: Option<FemAirboxTargetIR>,
    #[serde(
        rename = "effective_airbox_maximum_element_size",
        alias = "effective_airbox_hmax",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub effective_airbox_hmax: Option<f64>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub effective_per_object_targets: HashMap<String, FemPerObjectTargetIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub region_markers: Vec<FemDomainRegionMarkerIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub object_region_markers: Vec<FemDomainRegionMarkerIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub used_size_field_kinds: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub size_fields_realized: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub operation_statuses: Vec<FemMeshOperationStatusIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub thin_film_diagnostics: Vec<FemThinFilmDiagnosticIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub magnetic_submesh_signatures: Vec<FemMagneticSubmeshSignatureIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selector_resolution: Vec<Value>,
    #[serde(default)]
    pub orphan_entities: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rejected_element_types: Vec<Value>,
    /// ``true`` when the mesh was built via a degraded path (fallback, simplified
    /// size fields, or lost component identity).
    #[serde(default)]
    pub degraded: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authored_regions_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realized_regions_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mixed_layer_topology_certificate: Option<MixedLayerTopologyCertificateV1IR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mixed_topology_provenance: Option<crate::FemMixedTopologyProvenanceIR>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FemDomainMeshAssetIR {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh: Option<MeshIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub region_markers: Vec<FemDomainRegionMarkerIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub object_region_markers: Vec<FemDomainRegionMarkerIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_report: Option<FemSharedDomainBuildReportIR>,
}

impl<'de> Deserialize<'de> for FemDomainMeshAssetIR {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Wire {
            #[serde(default)]
            mesh_source: Option<String>,
            #[serde(default)]
            mesh: Option<Value>,
            #[serde(default)]
            region_markers: Vec<FemDomainRegionMarkerIR>,
            #[serde(default)]
            object_region_markers: Vec<FemDomainRegionMarkerIR>,
            #[serde(default)]
            build_report: Option<FemSharedDomainBuildReportIR>,
        }

        let wire = Wire::deserialize(deserializer)?;
        let mesh_level_certificate = wire
            .mesh
            .as_ref()
            .and_then(|mesh| mesh.get("mixed_layer_topology_certificate"))
            .filter(|value| !value.is_null())
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(serde::de::Error::custom)?;
        let mesh = wire
            .mesh
            .map(serde_json::from_value)
            .transpose()
            .map_err(serde::de::Error::custom)?;
        let mut build_report = wire.build_report;
        if let Some(mesh_certificate) = mesh_level_certificate {
            let report = build_report.as_mut().ok_or_else(|| {
                serde::de::Error::custom(
                    "mesh-level mixed certificate requires a shared-domain build report",
                )
            })?;
            match report.mixed_layer_topology_certificate.as_ref() {
                Some(report_certificate) if report_certificate != &mesh_certificate => {
                    return Err(serde::de::Error::custom(
                        "mesh-level and build-report mixed certificates conflict",
                    ));
                }
                Some(_) => {}
                None => report.mixed_layer_topology_certificate = Some(mesh_certificate),
            }
        }
        Ok(Self {
            mesh_source: wire.mesh_source,
            mesh,
            region_markers: wire.region_markers,
            object_region_markers: wire.object_region_markers,
            build_report,
        })
    }
}

impl FemDomainMeshAssetIR {
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();
        if self.mesh.is_none() && self.mesh_source.is_none() {
            errors.push(
                "fem_domain_mesh_asset must provide either an inline mesh or mesh_source"
                    .to_string(),
            );
        }
        if let Some(mesh) = &self.mesh {
            if let Err(mesh_errors) = validate_mesh_for_execution(mesh) {
                errors.extend(
                    mesh_errors
                        .into_iter()
                        .map(|error| format!("fem_domain_mesh_asset.{error}")),
                );
            }
        }
        if let Some(certificate) = self
            .build_report
            .as_ref()
            .and_then(|report| report.mixed_layer_topology_certificate.as_ref())
        {
            match &self.mesh {
                Some(mesh) => {
                    if let Err(certificate_errors) =
                        validate_mixed_layer_topology_certificate_against_mesh(certificate, mesh)
                    {
                        errors.extend(certificate_errors.into_iter().map(|error| {
                            format!("fem_domain_mesh_asset.build_report.{error}")
                        }));
                    }
                }
                None => errors.push("fem_domain_mesh_asset mixed layer topology certificate requires an inline mesh for fingerprint binding".to_string()),
            }
        }
        if let Some(provenance) = self
            .build_report
            .as_ref()
            .and_then(|report| report.mixed_topology_provenance.as_ref())
        {
            let certificate = self
                .build_report
                .as_ref()
                .and_then(|report| report.mixed_layer_topology_certificate.as_ref());
            let mut accepted_fingerprint_is_stale = false;
            match certificate {
                Some(certificate)
                    if provenance.accepted_certificate_fingerprint
                        != certificate.topology_fingerprint =>
                {
                    accepted_fingerprint_is_stale = true;
                }
                Some(_) => {}
                None => errors.push(
                    "fem_domain_mesh_asset mixed topology provenance requires a mixed layer topology certificate"
                        .to_string(),
                ),
            }
            match &self.mesh {
                Some(mesh) => {
                    if !mesh_has_mixed_topology(mesh) {
                        errors.push(
                            "fem_domain_mesh_asset mixed topology provenance requires an actual mixed topology mesh"
                                .to_string(),
                        );
                    }
                    if let Some(certificate) = certificate {
                        match mesh.mixed_topology_fingerprint_for_version(
                            &certificate.topology_fingerprint_version,
                        ) {
                            Ok(fingerprint)
                                if provenance.accepted_certificate_fingerprint != fingerprint =>
                            {
                                accepted_fingerprint_is_stale = true;
                            }
                            Ok(_) => {}
                            Err(error) => errors.push(error),
                        }
                    }
                }
                None => errors.push(
                    "fem_domain_mesh_asset mixed topology provenance requires an inline mixed topology mesh"
                        .to_string(),
                ),
            }
            if accepted_fingerprint_is_stale {
                errors.push(
                    "fem_domain_mesh_asset mixed topology provenance accepted certificate fingerprint is stale"
                        .to_string(),
                );
            }
            if provenance.requested_topology != crate::FemMeshTopologyFamilyIR::MixedP1
                || provenance.resolved_topology != crate::FemMeshTopologyFamilyIR::MixedP1
            {
                errors.push(
                    "fem_domain_mesh_asset mixed topology provenance requested and resolved topology must be mixed_p1"
                        .to_string(),
                );
            }
            if !matches!(
                provenance.capability_status,
                crate::FemMixedTopologyCapabilityStatusIR::Unsupported
                    | crate::FemMixedTopologyCapabilityStatusIR::Implemented
            ) {
                errors.push(
                    "fem_domain_mesh_asset mixed topology provenance capability_status must be unsupported or implemented until managed public runtime proof exists"
                        .to_string(),
                );
            }
        }
        let mut seen_markers = BTreeSet::new();
        let mut seen_geometries = BTreeSet::new();
        for region in &self.region_markers {
            if region.geometry_name.trim().is_empty() {
                errors.push(
                    "fem_domain_mesh_asset.region_markers geometry_name must not be empty"
                        .to_string(),
                );
            }
            if region.marker == 0 {
                errors.push("fem_domain_mesh_asset.region_markers markers must be > 0".to_string());
            }
            if !seen_markers.insert(region.marker) {
                errors.push(format!(
                    "fem_domain_mesh_asset.region_markers marker {} is duplicated",
                    region.marker
                ));
            }
            if !seen_geometries.insert(region.geometry_name.as_str()) {
                errors.push(format!(
                    "fem_domain_mesh_asset.region_markers geometry '{}' is duplicated",
                    region.geometry_name
                ));
            }
        }
        let mut seen_object_region_markers = BTreeSet::new();
        let mut seen_object_region_geometries = BTreeSet::new();
        for region in &self.object_region_markers {
            if region.geometry_name.trim().is_empty() {
                errors.push(
                    "fem_domain_mesh_asset.object_region_markers geometry_name must not be empty"
                        .to_string(),
                );
            }
            if region.marker == 0 {
                errors.push(
                    "fem_domain_mesh_asset.object_region_markers markers must be > 0".to_string(),
                );
            }
            if seen_markers.contains(&region.marker) {
                errors.push(format!(
                    "fem_domain_mesh_asset.object_region_markers marker {} duplicates a region_markers marker",
                    region.marker
                ));
            }
            if !seen_object_region_markers.insert(region.marker) {
                errors.push(format!(
                    "fem_domain_mesh_asset.object_region_markers marker {} is duplicated",
                    region.marker
                ));
            }
            if !seen_object_region_geometries.insert(region.geometry_name.as_str()) {
                errors.push(format!(
                    "fem_domain_mesh_asset.object_region_markers geometry '{}' is duplicated",
                    region.geometry_name
                ));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct GeometryAssetsIR {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fdm_grid_assets: Vec<FdmGridAssetIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fem_mesh_assets: Vec<FemMeshAssetIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fem_domain_mesh_asset: Option<FemDomainMeshAssetIR>,
}

impl GeometryAssetsIR {
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();
        for asset in &self.fdm_grid_assets {
            if let Err(asset_errors) = asset.validate() {
                errors.extend(
                    asset_errors
                        .into_iter()
                        .map(|error| format!("geometry_assets.{error}")),
                );
            }
        }
        for asset in &self.fem_mesh_assets {
            if let Err(asset_errors) = asset.validate() {
                errors.extend(
                    asset_errors
                        .into_iter()
                        .map(|error| format!("geometry_assets.{error}")),
                );
            }
        }
        if let Some(asset) = &self.fem_domain_mesh_asset {
            if let Err(asset_errors) = asset.validate() {
                errors.extend(
                    asset_errors
                        .into_iter()
                        .map(|error| format!("geometry_assets.{error}")),
                );
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeclaredUniverseIR {
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub center: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub padding: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub airbox_hmax: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub airbox_hmin: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub airbox_growth_rate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub airbox_grading: Option<String>,
}

impl Default for DeclaredUniverseIR {
    fn default() -> Self {
        Self {
            mode: "auto".to_string(),
            size: None,
            center: None,
            padding: None,
            airbox_hmax: None,
            airbox_hmin: None,
            airbox_growth_rate: None,
            airbox_grading: None,
        }
    }
}

impl DeclaredUniverseIR {
    pub fn from_study_universe_value(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        Some(Self {
            mode: match object
                .get("mode")
                .and_then(|candidate| candidate.as_str())
                .unwrap_or("auto")
            {
                "box" => "manual",
                other => other,
            }
            .to_string(),
            size: object.get("size").and_then(vec3_from_value),
            center: object.get("center").and_then(vec3_from_value),
            padding: object.get("padding").and_then(vec3_from_value),
            airbox_hmax: object
                .get("airbox_hmax")
                .and_then(|candidate| candidate.as_f64()),
            airbox_hmin: object
                .get("airbox_hmin")
                .and_then(|candidate| candidate.as_f64()),
            airbox_growth_rate: object
                .get("airbox_growth_rate")
                .and_then(|candidate| candidate.as_f64()),
            airbox_grading: object
                .get("airbox_grading")
                .and_then(|candidate| candidate.as_str())
                .map(str::to_string),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct UniverseMeshConfigIR {
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub center: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub padding: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub airbox_hmax: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub airbox_hmin: Option<f64>,
}

impl From<&DeclaredUniverseIR> for UniverseMeshConfigIR {
    fn from(value: &DeclaredUniverseIR) -> Self {
        Self {
            mode: value.mode.clone(),
            size: value.size,
            center: value.center,
            padding: value.padding,
            airbox_hmax: value.airbox_hmax,
            airbox_hmin: value.airbox_hmin,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PerObjectMeshConfigIR {
    pub object_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marker: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hmax: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interface_hmax: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_distance: Option<f64>,
    #[serde(default)]
    pub source: String,
}

impl PerObjectMeshConfigIR {
    pub fn from_effective_target(
        object_id: impl Into<String>,
        target: &FemPerObjectTargetIR,
    ) -> Self {
        Self {
            object_id: object_id.into(),
            marker: target.marker,
            hmax: target.hmax,
            interface_hmax: target.interface_hmax,
            transition_distance: target.transition_distance,
            source: target.source.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SolverMeshArtifactRefIR {
    pub mesh_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_source: Option<String>,
    pub domain_mesh_mode: FemDomainMeshModeIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_report: Option<FemSharedDomainBuildReportIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct MeshSemanticsIR {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub universe_mesh_config: Option<UniverseMeshConfigIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub per_object_mesh_configs: Vec<PerObjectMeshConfigIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub solver_mesh: Option<SolverMeshArtifactRefIR>,
}

impl MeshSemanticsIR {
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();

        if let Some(universe) = &self.universe_mesh_config {
            if universe.mode.trim().is_empty() {
                errors.push("universe_mesh_config.mode must not be empty".to_string());
            }
            if universe
                .size
                .is_some_and(|size| size.iter().any(|component| *component <= 0.0))
            {
                errors.push(
                    "universe_mesh_config.size components must be positive when provided"
                        .to_string(),
                );
            }
            if universe.airbox_hmax.is_some_and(|value| value <= 0.0) {
                errors.push("universe_mesh_config.airbox_hmax must be positive".to_string());
            }
            if universe.airbox_hmin.is_some_and(|value| value <= 0.0) {
                errors.push("universe_mesh_config.airbox_hmin must be positive".to_string());
            }
            if let (Some(hmin), Some(hmax)) = (universe.airbox_hmin, universe.airbox_hmax) {
                if hmin > hmax {
                    errors.push(
                        "universe_mesh_config.airbox_hmin must be <= airbox_hmax".to_string(),
                    );
                }
            }
        }

        let mut seen_object_ids: BTreeSet<&str> = BTreeSet::new();
        for object in &self.per_object_mesh_configs {
            if object.object_id.trim().is_empty() {
                errors.push("per_object_mesh_configs.object_id must not be empty".to_string());
            }
            if !seen_object_ids.insert(object.object_id.as_str()) {
                errors.push(format!(
                    "per_object_mesh_configs contains duplicated object_id '{}'",
                    object.object_id
                ));
            }
            if object.hmax.is_some_and(|value| value <= 0.0) {
                errors.push(format!(
                    "per_object_mesh_configs '{}' has non-positive hmax",
                    object.object_id
                ));
            }
            if object.interface_hmax.is_some_and(|value| value <= 0.0) {
                errors.push(format!(
                    "per_object_mesh_configs '{}' has non-positive interface_hmax",
                    object.object_id
                ));
            }
            if object.transition_distance.is_some_and(|value| value <= 0.0) {
                errors.push(format!(
                    "per_object_mesh_configs '{}' has non-positive transition_distance",
                    object.object_id
                ));
            }
        }

        if let Some(solver_mesh) = &self.solver_mesh {
            if solver_mesh.mesh_name.trim().is_empty() {
                errors.push("solver_mesh.mesh_name must not be empty".to_string());
            }
            if solver_mesh
                .mesh_source
                .as_ref()
                .is_some_and(|source| source.trim().is_empty())
            {
                errors.push("solver_mesh.mesh_source must not be empty when provided".to_string());
            }
            if solver_mesh
                .generation_id
                .as_ref()
                .is_some_and(|generation| generation.trim().is_empty())
            {
                errors
                    .push("solver_mesh.generation_id must not be empty when provided".to_string());
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct DomainFrameIR {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_universe: Option<DeclaredUniverseIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_bounds_min: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_bounds_max: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_bounds_min: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_bounds_max: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_extent: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_center: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_source: Option<String>,
}

impl DomainFrameIR {
    pub fn with_mesh_bounds(mut self, mesh_bounds: Option<([f64; 3], [f64; 3])>) -> Self {
        if let Some((bounds_min, bounds_max)) = mesh_bounds.and_then(normalized_bounds_pair) {
            self.mesh_bounds_min = Some(bounds_min);
            self.mesh_bounds_max = Some(bounds_max);
        }
        self
    }

    pub fn finalized(mut self) -> Option<Self> {
        let object_bounds = option_bounds_pair(self.object_bounds_min, self.object_bounds_max);
        let mesh_bounds = option_bounds_pair(self.mesh_bounds_min, self.mesh_bounds_max);
        let declared_universe = self.declared_universe.clone();

        if self.effective_extent.is_none() {
            if let Some(declared) = declared_universe.as_ref() {
                if declared.mode == "manual" {
                    if let Some(size) = declared.size {
                        self.effective_extent = Some(size);
                        self.effective_source
                            .get_or_insert_with(|| "declared_universe_manual".to_string());
                    }
                    if self.effective_center.is_none() {
                        self.effective_center = declared
                            .center
                            .or_else(|| {
                                object_bounds.map(|bounds| bounds_center(bounds.0, bounds.1))
                            })
                            .or_else(|| {
                                mesh_bounds.map(|bounds| bounds_center(bounds.0, bounds.1))
                            });
                    }
                } else {
                    let base_bounds = object_bounds.or(mesh_bounds);
                    if let Some((bounds_min, bounds_max)) = base_bounds {
                        let padding = declared.padding.unwrap_or([0.0, 0.0, 0.0]);
                        let base_extent = bounds_extent(bounds_min, bounds_max);
                        if padding.iter().any(|component| component.abs() > 0.0) {
                            self.effective_extent = Some([
                                base_extent[0] + 2.0 * padding[0],
                                base_extent[1] + 2.0 * padding[1],
                                base_extent[2] + 2.0 * padding[2],
                            ]);
                            self.effective_source.get_or_insert_with(|| {
                                "declared_universe_auto_padding".to_string()
                            });
                        } else {
                            self.effective_extent = Some(base_extent);
                            self.effective_source.get_or_insert_with(|| {
                                if object_bounds.is_some() {
                                    "object_union_bounds".to_string()
                                } else {
                                    "mesh_bounds".to_string()
                                }
                            });
                        }
                        if self.effective_center.is_none() {
                            self.effective_center = Some(bounds_center(bounds_min, bounds_max));
                        }
                    }
                }
            } else if let Some((bounds_min, bounds_max)) = object_bounds {
                self.effective_extent = Some(bounds_extent(bounds_min, bounds_max));
                self.effective_center = Some(bounds_center(bounds_min, bounds_max));
                self.effective_source
                    .get_or_insert_with(|| "object_union_bounds".to_string());
            } else if let Some((bounds_min, bounds_max)) = mesh_bounds {
                self.effective_extent = Some(bounds_extent(bounds_min, bounds_max));
                self.effective_center = Some(bounds_center(bounds_min, bounds_max));
                self.effective_source
                    .get_or_insert_with(|| "mesh_bounds".to_string());
            }
        }

        if self.declared_universe.is_none()
            && self.object_bounds_min.is_none()
            && self.object_bounds_max.is_none()
            && self.mesh_bounds_min.is_none()
            && self.mesh_bounds_max.is_none()
            && self.effective_extent.is_none()
            && self.effective_center.is_none()
            && self.effective_source.is_none()
        {
            None
        } else {
            Some(self)
        }
    }
}
