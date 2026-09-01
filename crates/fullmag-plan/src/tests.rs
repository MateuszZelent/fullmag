use super::*;
use crate::geometry::{
    cell_for_magnet, fdm_default_cell, ir_to_shape, shape_local_bounds, voxelize_shape,
};
use std::collections::BTreeMap;

#[test]
fn multilayer_pair_kernel_footprint_counts_every_abi_v2_pair_payload() {
    assert_eq!(
        checked_multilayer_pair_kernel_footprint([4, 5, 6], 3)
            .expect("small ABI v2 tensor footprint should be representable"),
        829_440
    );
}

mod frozen_spins_selection_compiler_tests {
    use std::{collections::BTreeMap, sync::OnceLock};

    use fullmag_ir::{
        BoundaryMembershipIR, ConstraintActivationIR, EmptySelectionPolicyIR,
        FrozenReferencePolicyIR, FrozenSpinsIR, GeometryPredicateIR, InactiveSelectionPolicyIR,
        ResolvedFrozenSpinsPlanIR, SelectionDefinitionIR, SelectionExprIR, SelectionFrameIR,
        SelectionMembershipPolicyIR, SelectionSamplingIR, SelectionValidationContext,
        FROZEN_SPINS_SCHEMA_VERSION, SELECTION_EXPR_SCHEMA_VERSION,
    };

    use crate::{
        compile_fdm_frozen_spins, compile_fem_frozen_spins, AffineTransform3, FdmFrozenSpinsDomain,
        FemIncidentElement, FemTrueDofDomain, FrozenSpinsCompileRequest, FrozenSpinsStateSnapshot,
        ResolvedFrozenSpinsReference, SelectionDofMembership,
    };

    fn constraint(id: &str, selector: SelectionExprIR) -> FrozenSpinsIR {
        FrozenSpinsIR {
            schema_version: FROZEN_SPINS_SCHEMA_VERSION.to_string(),
            id: id.to_string(),
            name: id.to_string(),
            enabled: true,
            selector,
            reference: FrozenReferencePolicyIR::CaptureCurrentAtActivation {},
            membership: SelectionMembershipPolicyIR::Static {},
            activation: ConstraintActivationIR::AllStages {},
            empty_selection: EmptySelectionPolicyIR::Error,
            inactive_selection: InactiveSelectionPolicyIR::WarnAndIntersect,
        }
    }

    fn membership(objects: &[&str], regions: &[(&str, &str)]) -> SelectionDofMembership {
        SelectionDofMembership {
            object_ids: objects.iter().map(|value| (*value).to_string()).collect(),
            region_ids: regions
                .iter()
                .map(|(object, region)| ((*object).to_string(), (*region).to_string()))
                .collect(),
        }
    }

    fn known_entities() -> &'static SelectionValidationContext {
        static KNOWN: OnceLock<SelectionValidationContext> = OnceLock::new();
        KNOWN.get_or_init(|| {
            SelectionValidationContext::new(
                ["magnet", "a", "b"],
                [
                    ("magnet", "left"),
                    ("magnet", "overlap"),
                    ("magnet", "right"),
                    ("b", "rim"),
                ],
            )
        })
    }

    fn compile_selector_error_code(
        selector: SelectionExprIR,
        selections: &[SelectionDefinitionIR],
    ) -> String {
        compile_selector_error_code_with_membership(
            selector,
            selections,
            SelectionMembershipPolicyIR::Static {},
        )
    }

    fn compile_selector_error_code_with_membership(
        selector: SelectionExprIR,
        selections: &[SelectionDefinitionIR],
        membership_policy: SelectionMembershipPolicyIR,
    ) -> String {
        let mut authored_constraint = constraint("selection", selector);
        authored_constraint.membership = membership_policy;
        let constraints = [authored_constraint];
        let memberships = [membership(&["magnet"], &[])];
        let active_mask = [true];
        let domain = FdmFrozenSpinsDomain {
            origin_m: [0.0; 3],
            counts: [1, 1, 1],
            cell_m: [1.0; 3],
            active_mask: &active_mask,
            memberships: &memberships,
            grid_fingerprint: "fdm-grid-v1",
        };
        let values = [[1.0, 0.0, 0.0]];
        let references = [ResolvedFrozenSpinsReference {
            constraint_id: "selection",
            values: &values,
            source_state_revision: Some(1),
            topology_fingerprint: "fdm-grid-v1",
        }];
        let transforms = BTreeMap::new();
        let request = FrozenSpinsCompileRequest {
            constraints: &constraints,
            selections,
            activation_stage_id: None,
            object_transforms: &transforms,
            known_entities: known_entities(),
            state_snapshot: None,
            resolved_references: &references,
            expected_source_state_revision: Some(1),
            expected_grid_or_mesh_fingerprint: "fdm-grid-v1",
        };
        compile_fdm_frozen_spins(&domain, &request)
            .expect_err("invalid selector must fail closed")
            .code()
            .to_string()
    }

    #[test]
    fn frozen_spins_fdm_exact_mask_intersects_inactive_cells_and_unions_overlaps() {
        let constraints = vec![
            constraint(
                "left",
                SelectionExprIR::InRegion {
                    object_id: "magnet".to_string(),
                    region_id: "left".to_string(),
                },
            ),
            constraint(
                "overlap",
                SelectionExprIR::InRegion {
                    object_id: "magnet".to_string(),
                    region_id: "overlap".to_string(),
                },
            ),
        ];
        let memberships = vec![
            membership(&["magnet"], &[("magnet", "left"), ("magnet", "overlap")]),
            membership(&["magnet"], &[("magnet", "overlap")]),
            membership(&["magnet"], &[("magnet", "right")]),
        ];
        let active_mask = vec![true, false, true];
        let domain = FdmFrozenSpinsDomain {
            origin_m: [0.0, 0.0, 0.0],
            counts: [3, 1, 1],
            cell_m: [1.0, 1.0, 1.0],
            active_mask: &active_mask,
            memberships: &memberships,
            grid_fingerprint: "fdm-grid-v1",
        };
        let current = vec![[1.0, 0.0, 0.0]; 3];
        let references = vec![
            ResolvedFrozenSpinsReference {
                constraint_id: "left",
                values: &current,
                source_state_revision: Some(7),
                topology_fingerprint: "fdm-grid-v1",
            },
            ResolvedFrozenSpinsReference {
                constraint_id: "overlap",
                values: &current,
                source_state_revision: Some(7),
                topology_fingerprint: "fdm-grid-v1",
            },
        ];
        let transforms = BTreeMap::<String, AffineTransform3>::new();
        let request = FrozenSpinsCompileRequest {
            constraints: &constraints,
            selections: &[],
            activation_stage_id: None,
            object_transforms: &transforms,
            known_entities: known_entities(),
            state_snapshot: None,
            resolved_references: &references,
            expected_source_state_revision: Some(7),
            expected_grid_or_mesh_fingerprint: "fdm-grid-v1",
        };

        let resolved = compile_fdm_frozen_spins(&domain, &request).unwrap();

        assert_eq!(resolved.frozen_mask, vec![true, false, false]);
        assert_eq!(resolved.frozen_dof_count, 1);
        assert_eq!(resolved.free_dof_count, 1);
        assert_eq!(resolved.source_state_revision, Some(7));
        assert_eq!(resolved.certificate.raw_candidate_dof_count, 2);
        assert_eq!(resolved.certificate.inactive_candidate_dof_count, 1);
        assert_eq!(resolved.certificate.bounds_m, Some([[0.5, 0.5, 0.5]; 2]));
        assert_eq!(resolved.mask_sha256.len(), 64);
        assert_eq!(resolved.certificate.mask_sha256, resolved.mask_sha256);
        assert_eq!(resolved.certificate.resolved_reference_sha256.len(), 64);
        assert_eq!(resolved.certificate.authored_fingerprints.len(), 2);
        assert!(resolved
            .certificate
            .authored_fingerprints
            .iter()
            .all(|fingerprint| fingerprint.selector_sha256.len() == 64));
        assert_eq!(
            compile_fdm_frozen_spins(&domain, &request).unwrap(),
            resolved,
            "same authored input, topology, revision, and references must be deterministic"
        );
        resolved.validate_against_active_mask(&active_mask).unwrap();
    }

    #[test]
    fn frozen_spins_overlap_compares_resolved_values_not_authored_reference_policy() {
        let mut constraints = vec![
            constraint("first", SelectionExprIR::AllMagnetic {}),
            constraint("second", SelectionExprIR::AllMagnetic {}),
        ];
        constraints[0].reference = FrozenReferencePolicyIR::InitialState {};
        constraints[1].reference = FrozenReferencePolicyIR::ExplicitFieldAsset {
            asset_id: "different-policy".to_string(),
        };
        let memberships = vec![membership(&["magnet"], &[])];
        let active_mask = vec![true];
        let domain = FdmFrozenSpinsDomain {
            origin_m: [0.0; 3],
            counts: [1, 1, 1],
            cell_m: [1.0; 3],
            active_mask: &active_mask,
            memberships: &memberships,
            grid_fingerprint: "fdm-grid-v1",
        };
        let first = [[1.0, 0.0, 0.0]];
        let second = [[0.0, 1.0, 0.0]];
        let references = vec![
            ResolvedFrozenSpinsReference {
                constraint_id: "first",
                values: &first,
                source_state_revision: None,
                topology_fingerprint: "fdm-grid-v1",
            },
            ResolvedFrozenSpinsReference {
                constraint_id: "second",
                values: &second,
                source_state_revision: None,
                topology_fingerprint: "fdm-grid-v1",
            },
        ];
        let transforms = BTreeMap::new();
        let request = FrozenSpinsCompileRequest {
            constraints: &constraints,
            selections: &[],
            activation_stage_id: None,
            object_transforms: &transforms,
            known_entities: known_entities(),
            state_snapshot: None,
            resolved_references: &references,
            expected_source_state_revision: None,
            expected_grid_or_mesh_fingerprint: "fdm-grid-v1",
        };

        let error = compile_fdm_frozen_spins(&domain, &request).unwrap_err();

        assert_eq!(error.code(), "frozen_reference_conflict");
        let message = error.to_string();
        assert!(message.contains("first"));
        assert!(message.contains("second"));
        assert!(message.contains("conflict_count=1"));
        assert!(message.contains("sample_dof_indices=[0]"));
    }

    #[test]
    fn frozen_spins_overlap_allows_different_policies_with_equal_resolved_values() {
        let mut constraints = vec![
            constraint("initial", SelectionExprIR::AllMagnetic {}),
            constraint("asset", SelectionExprIR::AllMagnetic {}),
        ];
        constraints[0].reference = FrozenReferencePolicyIR::InitialState {};
        constraints[1].reference = FrozenReferencePolicyIR::ExplicitFieldAsset {
            asset_id: "reference-field".to_string(),
        };
        let memberships = [membership(&["magnet"], &[])];
        let active_mask = [true];
        let domain = FdmFrozenSpinsDomain {
            origin_m: [0.0; 3],
            counts: [1, 1, 1],
            cell_m: [1.0; 3],
            active_mask: &active_mask,
            memberships: &memberships,
            grid_fingerprint: "fdm-grid-v1",
        };
        let values = [[1.0, 0.0, 0.0]];
        let references = [
            ResolvedFrozenSpinsReference {
                constraint_id: "initial",
                values: &values,
                source_state_revision: None,
                topology_fingerprint: "fdm-grid-v1",
            },
            ResolvedFrozenSpinsReference {
                constraint_id: "asset",
                values: &values,
                source_state_revision: None,
                topology_fingerprint: "fdm-grid-v1",
            },
        ];
        let transforms = BTreeMap::new();
        let request = FrozenSpinsCompileRequest {
            constraints: &constraints,
            selections: &[],
            activation_stage_id: None,
            object_transforms: &transforms,
            known_entities: known_entities(),
            state_snapshot: None,
            resolved_references: &references,
            expected_source_state_revision: None,
            expected_grid_or_mesh_fingerprint: "fdm-grid-v1",
        };

        let resolved = compile_fdm_frozen_spins(&domain, &request)
            .expect("resolved values, not authored policies, govern overlap legality");

        assert_eq!(resolved.frozen_mask, vec![true]);
        assert_eq!(resolved.constraint_ids, vec!["initial", "asset"]);
    }

    #[test]
    fn frozen_spins_capture_rejects_mixed_reference_revisions_before_publication() {
        let constraints = vec![
            constraint("first", SelectionExprIR::AllMagnetic {}),
            constraint("second", SelectionExprIR::AllMagnetic {}),
        ];
        let memberships = vec![membership(&["magnet"], &[])];
        let active_mask = vec![true];
        let domain = FdmFrozenSpinsDomain {
            origin_m: [0.0; 3],
            counts: [1, 1, 1],
            cell_m: [1.0; 3],
            active_mask: &active_mask,
            memberships: &memberships,
            grid_fingerprint: "fdm-grid-v1",
        };
        let captured = [[1.0, 0.0, 0.0]];
        let references = [
            ResolvedFrozenSpinsReference {
                constraint_id: "first",
                values: &captured,
                source_state_revision: Some(7),
                topology_fingerprint: "fdm-grid-v1",
            },
            ResolvedFrozenSpinsReference {
                constraint_id: "second",
                values: &captured,
                source_state_revision: Some(8),
                topology_fingerprint: "fdm-grid-v1",
            },
        ];
        let transforms = BTreeMap::new();
        let request = FrozenSpinsCompileRequest {
            constraints: &constraints,
            selections: &[],
            activation_stage_id: None,
            object_transforms: &transforms,
            known_entities: known_entities(),
            state_snapshot: None,
            resolved_references: &references,
            expected_source_state_revision: Some(7),
            expected_grid_or_mesh_fingerprint: "fdm-grid-v1",
        };

        let error = compile_fdm_frozen_spins(&domain, &request)
            .expect_err("mixed capture revisions must reject the whole activation");

        assert_eq!(error.code(), "selection_stale_revision");
    }

    #[test]
    fn frozen_spins_canonical_hash_preserves_typed_selector_errors() {
        let invalid_geometry = SelectionExprIR::InsideGeometry {
            geometry: GeometryPredicateIR::Box {
                center_m: [0.0; 3],
                size_m: [0.0, 1.0, 1.0],
            },
            frame: SelectionFrameIR::World {},
            sampling: SelectionSamplingIR::DofPoint {},
            boundary: BoundaryMembershipIR::default(),
        };
        assert_eq!(
            compile_selector_error_code(invalid_geometry, &[]),
            "selection_invalid_geometry"
        );

        let imported = SelectionExprIR::InsideGeometry {
            geometry: GeometryPredicateIR::ImportedSolid {
                asset_id: "mesh.stl".to_string(),
            },
            frame: SelectionFrameIR::World {},
            sampling: SelectionSamplingIR::DofPoint {},
            boundary: BoundaryMembershipIR::default(),
        };
        assert_eq!(
            compile_selector_error_code(imported, &[]),
            "selection_imported_solid_unqualified"
        );

        let cycle = vec![
            SelectionDefinitionIR {
                schema_version: SELECTION_EXPR_SCHEMA_VERSION.to_string(),
                id: "a".to_string(),
                name: None,
                expression: SelectionExprIR::Ref {
                    selection_id: "b".to_string(),
                },
            },
            SelectionDefinitionIR {
                schema_version: SELECTION_EXPR_SCHEMA_VERSION.to_string(),
                id: "b".to_string(),
                name: None,
                expression: SelectionExprIR::Ref {
                    selection_id: "a".to_string(),
                },
            },
        ];
        assert_eq!(
            compile_selector_error_code(
                SelectionExprIR::Ref {
                    selection_id: "a".to_string(),
                },
                &cycle,
            ),
            "selection_reference_cycle"
        );

        let mut too_deep = SelectionExprIR::AllMagnetic {};
        for _ in 0..65 {
            too_deep = SelectionExprIR::Not {
                expression: Box::new(too_deep),
            };
        }
        assert_eq!(
            compile_selector_error_code(too_deep, &[]),
            "selection_complexity_exceeded"
        );

        assert_eq!(
            compile_selector_error_code(
                SelectionExprIR::Ref {
                    selection_id: "missing".to_string(),
                },
                &[],
            ),
            "selection_unknown_reference"
        );

        assert_eq!(
            compile_selector_error_code(
                SelectionExprIR::Between {
                    value: fullmag_ir::SelectionScalarExprIR::Constant { value: 0.0 },
                    lower: f64::NAN,
                    upper: 1.0,
                    closed: fullmag_ir::ClosedIntervalIR::Both,
                },
                &[],
            ),
            "selection_invalid_constant"
        );

        let invalid_boundary = SelectionExprIR::InsideGeometry {
            geometry: GeometryPredicateIR::Sphere {
                center_m: [0.0; 3],
                radius_m: 1.0,
            },
            frame: SelectionFrameIR::World {},
            sampling: SelectionSamplingIR::DofPoint {},
            boundary: BoundaryMembershipIR::Inclusive {
                absolute_tolerance_m: -1.0,
                relative_tolerance: 0.0,
            },
        };
        assert_eq!(
            compile_selector_error_code(invalid_boundary, &[]),
            "selection_invalid_boundary"
        );

        let invalid_axis = SelectionExprIR::Compare {
            lhs: fullmag_ir::SelectionScalarExprIR::MagnetizationDot {
                axis: [2.0, 0.0, 0.0],
            },
            op: fullmag_ir::ComparisonOpIR::Gt,
            rhs: fullmag_ir::SelectionScalarExprIR::Constant { value: 0.0 },
            tolerance: fullmag_ir::ComparisonToleranceIR::default(),
        };
        assert_eq!(
            compile_selector_error_code_with_membership(
                invalid_axis,
                &[],
                SelectionMembershipPolicyIR::SnapshotAtActivation {},
            ),
            "selection_invalid_axis"
        );
    }

    #[test]
    fn frozen_spins_compare_rejects_nonzero_ignored_tolerance() {
        let selector = SelectionExprIR::Compare {
            lhs: fullmag_ir::SelectionScalarExprIR::Coordinate {
                component: fullmag_ir::CartesianComponentIR::X,
                frame: SelectionFrameIR::World {},
            },
            op: fullmag_ir::ComparisonOpIR::Gt,
            rhs: fullmag_ir::SelectionScalarExprIR::Constant { value: 0.0 },
            tolerance: fullmag_ir::ComparisonToleranceIR {
                atol: 1.0e-9,
                rtol: 0.0,
            },
        };

        assert_eq!(
            compile_selector_error_code(selector, &[]),
            "selection_compare_tolerance_unsupported"
        );
    }

    #[test]
    fn frozen_spins_zero_dof_rejects_singular_geometry_and_coordinate_frames() {
        let selectors = [
            SelectionExprIR::InsideGeometry {
                geometry: GeometryPredicateIR::Sphere {
                    center_m: [0.0; 3],
                    radius_m: 1.0,
                },
                frame: SelectionFrameIR::Object {
                    object_id: "magnet".to_string(),
                },
                sampling: SelectionSamplingIR::DofPoint {},
                boundary: BoundaryMembershipIR::default(),
            },
            SelectionExprIR::Compare {
                lhs: fullmag_ir::SelectionScalarExprIR::Coordinate {
                    component: fullmag_ir::CartesianComponentIR::X,
                    frame: SelectionFrameIR::Object {
                        object_id: "magnet".to_string(),
                    },
                },
                op: fullmag_ir::ComparisonOpIR::Gt,
                rhs: fullmag_ir::SelectionScalarExprIR::Constant { value: 0.0 },
                tolerance: Default::default(),
            },
        ];
        let transforms = BTreeMap::from([(
            "magnet".to_string(),
            AffineTransform3 {
                scale: [1.0, 0.0, 1.0],
                ..AffineTransform3::identity()
            },
        )]);
        let points = Vec::<[f64; 3]>::new();
        let incidents = Vec::<Vec<FemIncidentElement>>::new();
        let domain = FemTrueDofDomain {
            fe_order: 2,
            true_dof_points_m: &points,
            incident_elements: &incidents,
            mesh_fingerprint: "fem-mesh-v1",
        };
        let values = Vec::<[f64; 3]>::new();

        for (index, selector) in selectors.into_iter().enumerate() {
            let mut frozen = constraint("singular", selector);
            frozen.empty_selection = EmptySelectionPolicyIR::AllowNoop;
            let constraints = [frozen];
            let references = [ResolvedFrozenSpinsReference {
                constraint_id: "singular",
                values: &values,
                source_state_revision: Some(1),
                topology_fingerprint: "fem-mesh-v1",
            }];
            let request = FrozenSpinsCompileRequest {
                constraints: &constraints,
                selections: &[],
                activation_stage_id: None,
                object_transforms: &transforms,
                known_entities: known_entities(),
                state_snapshot: None,
                resolved_references: &references,
                expected_source_state_revision: Some(1),
                expected_grid_or_mesh_fingerprint: "fem-mesh-v1",
            };

            let error = compile_fem_frozen_spins(&domain, &request)
                .expect_err("singular frame must fail before an empty mask loop");
            assert_eq!(error.code(), "selection_singular_transform", "case {index}");
        }
    }

    #[test]
    fn frozen_spins_known_zero_dof_region_uses_empty_selection_policy() {
        let mut frozen = constraint(
            "empty-region",
            SelectionExprIR::InRegion {
                object_id: "magnet".to_string(),
                region_id: "authored-but-empty".to_string(),
            },
        );
        frozen.empty_selection = EmptySelectionPolicyIR::AllowNoop;
        let constraints = [frozen];
        let memberships = [membership(&["magnet"], &[])];
        let active_mask = [true];
        let domain = FdmFrozenSpinsDomain {
            origin_m: [0.0; 3],
            counts: [1, 1, 1],
            cell_m: [1.0; 3],
            active_mask: &active_mask,
            memberships: &memberships,
            grid_fingerprint: "fdm-grid-v1",
        };
        let values = [[1.0, 0.0, 0.0]];
        let references = [ResolvedFrozenSpinsReference {
            constraint_id: "empty-region",
            values: &values,
            source_state_revision: Some(1),
            topology_fingerprint: "fdm-grid-v1",
        }];
        let transforms = BTreeMap::new();
        let known_entities =
            SelectionValidationContext::new(["magnet"], [("magnet", "authored-but-empty")]);
        let request = FrozenSpinsCompileRequest {
            constraints: &constraints,
            selections: &[],
            activation_stage_id: None,
            object_transforms: &transforms,
            known_entities: &known_entities,
            state_snapshot: None,
            resolved_references: &references,
            expected_source_state_revision: Some(1),
            expected_grid_or_mesh_fingerprint: "fdm-grid-v1",
        };

        let resolved = compile_fdm_frozen_spins(&domain, &request)
            .expect("known region without realized DOFs is a valid no-op");

        assert_eq!(resolved.frozen_mask, vec![false]);
        assert_eq!(resolved.frozen_dof_count, 0);
        assert_eq!(resolved.free_dof_count, 1);
    }

    #[test]
    fn frozen_spins_state_membership_requires_current_matching_snapshot_revision() {
        let mut state_constraint = constraint(
            "positive_x",
            SelectionExprIR::Compare {
                lhs: fullmag_ir::SelectionScalarExprIR::MagnetizationComponent {
                    component: fullmag_ir::CartesianComponentIR::X,
                },
                op: fullmag_ir::ComparisonOpIR::Gt,
                rhs: fullmag_ir::SelectionScalarExprIR::Constant { value: 0.0 },
                tolerance: Default::default(),
            },
        );
        state_constraint.membership = SelectionMembershipPolicyIR::SnapshotAtActivation {};
        let constraints = vec![state_constraint];
        let memberships = vec![membership(&["magnet"], &[])];
        let active_mask = vec![true];
        let state = [[1.0, 0.0, 0.0]];
        let domain = FdmFrozenSpinsDomain {
            origin_m: [0.0; 3],
            counts: [1, 1, 1],
            cell_m: [1.0; 3],
            active_mask: &active_mask,
            memberships: &memberships,
            grid_fingerprint: "fdm-grid-v1",
        };
        let references = [ResolvedFrozenSpinsReference {
            constraint_id: "positive_x",
            values: &state,
            source_state_revision: Some(9),
            topology_fingerprint: "fdm-grid-v1",
        }];
        let transforms = BTreeMap::new();
        let request = FrozenSpinsCompileRequest {
            constraints: &constraints,
            selections: &[],
            activation_stage_id: None,
            object_transforms: &transforms,
            known_entities: known_entities(),
            state_snapshot: Some(FrozenSpinsStateSnapshot {
                magnetization: &state,
                revision: 8,
            }),
            resolved_references: &references,
            expected_source_state_revision: Some(9),
            expected_grid_or_mesh_fingerprint: "fdm-grid-v1",
        };

        let error = compile_fdm_frozen_spins(&domain, &request).unwrap_err();

        assert_eq!(error.code(), "selection_stale_revision");
    }

    #[test]
    fn frozen_spins_state_snapshot_materializes_exact_mask_at_matching_revision() {
        let mut state_constraint = constraint(
            "positive_x",
            SelectionExprIR::Compare {
                lhs: fullmag_ir::SelectionScalarExprIR::MagnetizationComponent {
                    component: fullmag_ir::CartesianComponentIR::X,
                },
                op: fullmag_ir::ComparisonOpIR::Gt,
                rhs: fullmag_ir::SelectionScalarExprIR::Constant { value: 0.0 },
                tolerance: Default::default(),
            },
        );
        state_constraint.membership = SelectionMembershipPolicyIR::SnapshotAtActivation {};
        let constraints = vec![state_constraint];
        let memberships = vec![membership(&["magnet"], &[]); 2];
        let active_mask = vec![true, true];
        let state = [[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0]];
        let domain = FdmFrozenSpinsDomain {
            origin_m: [0.0; 3],
            counts: [2, 1, 1],
            cell_m: [1.0; 3],
            active_mask: &active_mask,
            memberships: &memberships,
            grid_fingerprint: "fdm-grid-v1",
        };
        let references = [ResolvedFrozenSpinsReference {
            constraint_id: "positive_x",
            values: &state,
            source_state_revision: Some(9),
            topology_fingerprint: "fdm-grid-v1",
        }];
        let transforms = BTreeMap::new();
        let request = FrozenSpinsCompileRequest {
            constraints: &constraints,
            selections: &[],
            activation_stage_id: None,
            object_transforms: &transforms,
            known_entities: known_entities(),
            state_snapshot: Some(FrozenSpinsStateSnapshot {
                magnetization: &state,
                revision: 9,
            }),
            resolved_references: &references,
            expected_source_state_revision: Some(9),
            expected_grid_or_mesh_fingerprint: "fdm-grid-v1",
        };

        let resolved = compile_fdm_frozen_spins(&domain, &request).unwrap();

        assert_eq!(resolved.frozen_mask, vec![true, false]);
        assert_eq!(resolved.source_state_revision, Some(9));
    }

    #[test]
    fn frozen_spins_inside_geometry_adapts_canonical_ir_in_object_frame() {
        let constraints = vec![constraint(
            "object_box",
            SelectionExprIR::InsideGeometry {
                geometry: GeometryPredicateIR::Box {
                    center_m: [0.0; 3],
                    size_m: [1.0; 3],
                },
                frame: SelectionFrameIR::Object {
                    object_id: "magnet".to_string(),
                },
                sampling: SelectionSamplingIR::DofPoint {},
                boundary: BoundaryMembershipIR::default(),
            },
        )];
        let memberships = vec![membership(&["magnet"], &[])];
        let active_mask = vec![true];
        let values = [[1.0, 0.0, 0.0]];
        let domain = FdmFrozenSpinsDomain {
            origin_m: [10.0, 0.0, 0.0],
            counts: [1, 1, 1],
            cell_m: [1.0; 3],
            active_mask: &active_mask,
            memberships: &memberships,
            grid_fingerprint: "fdm-grid-v1",
        };
        let references = [ResolvedFrozenSpinsReference {
            constraint_id: "object_box",
            values: &values,
            source_state_revision: Some(1),
            topology_fingerprint: "fdm-grid-v1",
        }];
        let transforms = BTreeMap::from([(
            "magnet".to_string(),
            AffineTransform3 {
                translation_m: [10.0, 0.0, 0.0],
                ..AffineTransform3::identity()
            },
        )]);
        let request = FrozenSpinsCompileRequest {
            constraints: &constraints,
            selections: &[],
            activation_stage_id: None,
            object_transforms: &transforms,
            known_entities: known_entities(),
            state_snapshot: None,
            resolved_references: &references,
            expected_source_state_revision: Some(1),
            expected_grid_or_mesh_fingerprint: "fdm-grid-v1",
        };

        let resolved = compile_fdm_frozen_spins(&domain, &request).unwrap();

        assert_eq!(resolved.frozen_mask, vec![true]);
        assert_eq!(
            resolved.certificate.evaluator_id,
            "selection.fdm_cell_center.v1"
        );
    }

    #[test]
    fn frozen_spins_topology_mismatch_fails_before_mask_materialization() {
        let constraints = vec![constraint("all", SelectionExprIR::AllMagnetic {})];
        let memberships = vec![membership(&["magnet"], &[])];
        let active_mask = vec![true];
        let values = [[1.0, 0.0, 0.0]];
        let references = [ResolvedFrozenSpinsReference {
            constraint_id: "all",
            values: &values,
            source_state_revision: Some(1),
            topology_fingerprint: "old-grid",
        }];
        let domain = FdmFrozenSpinsDomain {
            origin_m: [0.0; 3],
            counts: [1, 1, 1],
            cell_m: [1.0; 3],
            active_mask: &active_mask,
            memberships: &memberships,
            grid_fingerprint: "new-grid",
        };
        let transforms = BTreeMap::new();
        let request = FrozenSpinsCompileRequest {
            constraints: &constraints,
            selections: &[],
            activation_stage_id: None,
            object_transforms: &transforms,
            known_entities: known_entities(),
            state_snapshot: None,
            resolved_references: &references,
            expected_source_state_revision: Some(1),
            expected_grid_or_mesh_fingerprint: "old-grid",
        };

        let error = compile_fdm_frozen_spins(&domain, &request).unwrap_err();

        assert_eq!(error.code(), "selection_topology_mismatch");
    }

    #[test]
    fn frozen_spins_fdm_topology_and_size_fail_before_point_materialization() {
        use crate::selection::{
            fdm_point_materialization_count, reset_fdm_point_materialization_count,
        };

        let constraints = vec![constraint("all", SelectionExprIR::AllMagnetic {})];
        let memberships = vec![membership(&["magnet"], &[])];
        let active_mask = vec![true];
        let values = [[1.0, 0.0, 0.0]];
        let references = [ResolvedFrozenSpinsReference {
            constraint_id: "all",
            values: &values,
            source_state_revision: Some(1),
            topology_fingerprint: "expected-grid",
        }];
        let transforms = BTreeMap::new();
        let request = FrozenSpinsCompileRequest {
            constraints: &constraints,
            selections: &[],
            activation_stage_id: None,
            object_transforms: &transforms,
            known_entities: known_entities(),
            state_snapshot: None,
            resolved_references: &references,
            expected_source_state_revision: Some(1),
            expected_grid_or_mesh_fingerprint: "expected-grid",
        };

        reset_fdm_point_materialization_count();
        let topology_domain = FdmFrozenSpinsDomain {
            origin_m: [0.0; 3],
            counts: [1, 1, 1],
            cell_m: [1.0; 3],
            active_mask: &active_mask,
            memberships: &memberships,
            grid_fingerprint: "different-grid",
        };
        let error = compile_fdm_frozen_spins(&topology_domain, &request).unwrap_err();
        assert_eq!(error.code(), "selection_topology_mismatch");
        assert_eq!(fdm_point_materialization_count(), 0);

        let size_domain = FdmFrozenSpinsDomain {
            origin_m: [0.0; 3],
            counts: [2, 1, 1],
            cell_m: [1.0; 3],
            active_mask: &active_mask,
            memberships: &memberships,
            grid_fingerprint: "expected-grid",
        };
        let error = compile_fdm_frozen_spins(&size_domain, &request).unwrap_err();
        assert_eq!(error.code(), "selection_domain_size_mismatch");
        assert_eq!(fdm_point_materialization_count(), 0);
    }

    #[test]
    fn frozen_spins_fem_p1_p2_use_any_incident_magnetic_true_dof_policy() {
        let constraints = vec![constraint(
            "object_a",
            SelectionExprIR::InObject {
                object_id: "a".to_string(),
            },
        )];
        let points = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [3.0, 0.0, 0.0],
            [4.0, 0.0, 0.0],
        ];
        let incidents = vec![
            vec![FemIncidentElement::magnetic("a", &[])],
            vec![
                FemIncidentElement::magnetic("a", &[]),
                FemIncidentElement::air(),
            ],
            vec![FemIncidentElement::air()],
            vec![FemIncidentElement::magnetic("b", &["rim"])],
            vec![
                FemIncidentElement::magnetic("a", &[]),
                FemIncidentElement::magnetic("b", &[]),
            ],
        ];
        let reference_values = vec![[1.0, 0.0, 0.0]; points.len()];
        let references = [ResolvedFrozenSpinsReference {
            constraint_id: "object_a",
            values: &reference_values,
            source_state_revision: Some(4),
            topology_fingerprint: "fem-mesh-v1",
        }];
        let transforms = BTreeMap::new();
        let request = FrozenSpinsCompileRequest {
            constraints: &constraints,
            selections: &[],
            activation_stage_id: None,
            object_transforms: &transforms,
            known_entities: known_entities(),
            state_snapshot: None,
            resolved_references: &references,
            expected_source_state_revision: Some(4),
            expected_grid_or_mesh_fingerprint: "fem-mesh-v1",
        };

        for fe_order in [1, 2] {
            let domain = FemTrueDofDomain {
                fe_order,
                true_dof_points_m: &points,
                incident_elements: &incidents,
                mesh_fingerprint: "fem-mesh-v1",
            };
            let resolved = compile_fem_frozen_spins(&domain, &request).unwrap();
            assert_eq!(
                resolved.frozen_mask,
                vec![true, true, false, false, true],
                "P{fe_order} true-DOF mask"
            );
            assert_eq!(resolved.frozen_dof_count, 3);
            assert_eq!(resolved.free_dof_count, 1);
        }
    }

    #[test]
    fn frozen_spins_fem_p2_edge_and_face_true_dofs_preserve_incident_membership() {
        // Q2 hexahedral Lagrange nodes are the tensor product of the local
        // shape-function abscissae {0, 1/2, 1}. Build global true DOFs by
        // deduplicating those nodes across adjacent element topology.
        let elements = [
            ([0_i32, 0, 0], Some("a")),
            ([1_i32, 0, 0], Some("b")),
            ([0_i32, 1, 0], None),
        ];
        let mut topology = BTreeMap::<[i32; 3], Vec<FemIncidentElement>>::new();
        for (origin, object_id) in elements {
            for local_z in 0..=2 {
                for local_y in 0..=2 {
                    for local_x in 0..=2 {
                        let key = [
                            2 * origin[0] + local_x,
                            2 * origin[1] + local_y,
                            2 * origin[2] + local_z,
                        ];
                        topology.entry(key).or_default().push(match object_id {
                            Some(object_id) => FemIncidentElement::magnetic(object_id, &[]),
                            None => FemIncidentElement::air(),
                        });
                    }
                }
            }
        }
        let (points, incidents): (Vec<_>, Vec<_>) = topology
            .into_iter()
            .map(|(key, incident)| (key.map(|value| f64::from(value) * 0.5), incident))
            .unzip();
        let constraints = vec![constraint(
            "object_a",
            SelectionExprIR::InObject {
                object_id: "a".to_string(),
            },
        )];
        let values = vec![[1.0, 0.0, 0.0]; points.len()];
        let references = [ResolvedFrozenSpinsReference {
            constraint_id: "object_a",
            values: &values,
            source_state_revision: Some(4),
            topology_fingerprint: "fem-p2-mesh-v1",
        }];
        let transforms = BTreeMap::new();
        let request = FrozenSpinsCompileRequest {
            constraints: &constraints,
            selections: &[],
            activation_stage_id: None,
            object_transforms: &transforms,
            known_entities: known_entities(),
            state_snapshot: None,
            resolved_references: &references,
            expected_source_state_revision: Some(4),
            expected_grid_or_mesh_fingerprint: "fem-p2-mesh-v1",
        };
        let domain = FemTrueDofDomain {
            fe_order: 2,
            true_dof_points_m: &points,
            incident_elements: &incidents,
            mesh_fingerprint: "fem-p2-mesh-v1",
        };

        let resolved = compile_fem_frozen_spins(&domain, &request).unwrap();

        let expected_mask: Vec<_> = points
            .iter()
            .map(|point| {
                point
                    .iter()
                    .all(|coordinate| (0.0..=1.0).contains(coordinate))
            })
            .collect();
        assert_eq!(resolved.frozen_mask, expected_mask);
        assert_eq!(resolved.frozen_dof_count, 27);
        assert_eq!(resolved.free_dof_count, 18);

        let selected_at = |point: [f64; 3]| {
            let index = points
                .iter()
                .position(|candidate| *candidate == point)
                .expect("Q2 topology must contain requested shape-function carrier");
            resolved.frozen_mask[index]
        };
        assert!(selected_at([0.5, 0.0, 0.0])); // Q2 edge, object a only
        assert!(selected_at([1.0, 0.5, 0.5])); // Q2 face, magnetic a/b
        assert!(selected_at([0.5, 1.0, 0.5])); // Q2 face, magnetic a/air
        assert!(!selected_at([1.5, 0.0, 0.0])); // Q2 edge, object b only
        assert!(!selected_at([0.0, 1.5, 0.0])); // Q2 edge, air only
    }

    #[test]
    fn frozen_spins_fem_topology_mismatch_fails_before_membership_materialization() {
        use crate::selection::{
            fem_membership_materialization_count, reset_fem_membership_materialization_count,
        };

        let constraints = vec![constraint("all", SelectionExprIR::AllMagnetic {})];
        let points = [[0.0, 0.0, 0.0]];
        let incidents = [vec![FemIncidentElement::magnetic("magnet", &[])]];
        let values = [[1.0, 0.0, 0.0]];
        let references = [ResolvedFrozenSpinsReference {
            constraint_id: "all",
            values: &values,
            source_state_revision: Some(1),
            topology_fingerprint: "expected-mesh",
        }];
        let transforms = BTreeMap::new();
        let request = FrozenSpinsCompileRequest {
            constraints: &constraints,
            selections: &[],
            activation_stage_id: None,
            object_transforms: &transforms,
            known_entities: known_entities(),
            state_snapshot: None,
            resolved_references: &references,
            expected_source_state_revision: Some(1),
            expected_grid_or_mesh_fingerprint: "expected-mesh",
        };
        let domain = FemTrueDofDomain {
            fe_order: 2,
            true_dof_points_m: &points,
            incident_elements: &incidents,
            mesh_fingerprint: "stale-mesh",
        };

        reset_fem_membership_materialization_count();
        let error = compile_fem_frozen_spins(&domain, &request).unwrap_err();

        assert_eq!(error.code(), "selection_topology_mismatch");
        assert_eq!(fem_membership_materialization_count(), 0);
    }

    #[test]
    fn frozen_spins_adapter_covers_world_object_affine_and_composite_geometry() {
        let object_selector = SelectionExprIR::InsideGeometry {
            geometry: GeometryPredicateIR::Ellipsoid {
                center_m: [1.0, 0.0, 0.0],
                radii_m: [0.3; 3],
            },
            frame: SelectionFrameIR::Object {
                object_id: "magnet".to_string(),
            },
            sampling: SelectionSamplingIR::DofPoint {},
            boundary: BoundaryMembershipIR::default(),
        };
        let world_selector = SelectionExprIR::InsideGeometry {
            geometry: GeometryPredicateIR::Complement {
                geometry: Box::new(GeometryPredicateIR::Xor {
                    a: Box::new(GeometryPredicateIR::Ellipsoid {
                        center_m: [11.0, 0.0, 0.0],
                        radii_m: [0.3; 3],
                    }),
                    b: Box::new(GeometryPredicateIR::Sphere {
                        center_m: [13.0, 0.0, 0.0],
                        radius_m: 0.3,
                    }),
                }),
                domain: Box::new(GeometryPredicateIR::Box {
                    center_m: [12.0, 0.0, 0.0],
                    size_m: [3.0, 1.0, 1.0],
                }),
            },
            frame: SelectionFrameIR::World {},
            sampling: SelectionSamplingIR::DofPoint {},
            boundary: BoundaryMembershipIR::default(),
        };
        let constraints = vec![
            constraint("object-affine", object_selector),
            constraint("world-composite", world_selector),
        ];
        let memberships = vec![membership(&["magnet"], &[]); 3];
        let active_mask = vec![true; 3];
        let domain = FdmFrozenSpinsDomain {
            origin_m: [10.5, -0.5, -0.5],
            counts: [3, 1, 1],
            cell_m: [1.0; 3],
            active_mask: &active_mask,
            memberships: &memberships,
            grid_fingerprint: "fdm-affine-v1",
        };
        let values = vec![[1.0, 0.0, 0.0]; 3];
        let references = [
            ResolvedFrozenSpinsReference {
                constraint_id: "object-affine",
                values: &values,
                source_state_revision: Some(2),
                topology_fingerprint: "fdm-affine-v1",
            },
            ResolvedFrozenSpinsReference {
                constraint_id: "world-composite",
                values: &values,
                source_state_revision: Some(2),
                topology_fingerprint: "fdm-affine-v1",
            },
        ];
        let transforms = BTreeMap::from([(
            "magnet".to_string(),
            AffineTransform3 {
                translation_m: [10.0, 0.0, 0.0],
                rotation_xyzw: [
                    0.0,
                    0.0,
                    std::f64::consts::FRAC_1_SQRT_2,
                    std::f64::consts::FRAC_1_SQRT_2,
                ],
                scale: [2.0, 0.5, 1.0],
                pivot_m: [1.0, 0.0, 0.0],
            },
        )]);
        let request = FrozenSpinsCompileRequest {
            constraints: &constraints,
            selections: &[],
            activation_stage_id: None,
            object_transforms: &transforms,
            known_entities: known_entities(),
            state_snapshot: None,
            resolved_references: &references,
            expected_source_state_revision: Some(2),
            expected_grid_or_mesh_fingerprint: "fdm-affine-v1",
        };

        let resolved = compile_fdm_frozen_spins(&domain, &request).unwrap();

        assert_eq!(resolved.frozen_mask, vec![true, true, false]);
    }

    #[test]
    fn frozen_spins_public_adapter_materializes_direct_affine_ir_in_world_and_object_frames() {
        let direct_affine = |translation_m| GeometryPredicateIR::Affine {
            geometry: Box::new(GeometryPredicateIR::Sphere {
                center_m: [0.0; 3],
                radius_m: 0.2,
            }),
            translation_m,
            rotation_xyzw: [
                0.0,
                0.0,
                std::f64::consts::FRAC_1_SQRT_2,
                std::f64::consts::FRAC_1_SQRT_2,
            ],
            scale: [2.0, 0.5, 1.0],
            pivot_m: [0.25, 0.25, 0.0],
        };
        let constraints = vec![
            constraint(
                "world-direct-affine",
                SelectionExprIR::InsideGeometry {
                    geometry: direct_affine([0.125, 0.75, 0.5]),
                    frame: SelectionFrameIR::World {},
                    sampling: SelectionSamplingIR::DofPoint {},
                    boundary: BoundaryMembershipIR::default(),
                },
            ),
            constraint(
                "object-direct-affine",
                SelectionExprIR::InsideGeometry {
                    geometry: direct_affine([0.0, 0.0, 0.5]),
                    frame: SelectionFrameIR::Object {
                        object_id: "magnet".to_string(),
                    },
                    sampling: SelectionSamplingIR::DofPoint {},
                    boundary: BoundaryMembershipIR::default(),
                },
            ),
        ];
        let memberships = vec![membership(&["magnet"], &[]); 3];
        let active_mask = vec![true; 3];
        let domain = FdmFrozenSpinsDomain {
            origin_m: [0.0; 3],
            counts: [3, 1, 1],
            cell_m: [1.0; 3],
            active_mask: &active_mask,
            memberships: &memberships,
            grid_fingerprint: "fdm-direct-affine-v1",
        };
        let values = vec![[1.0, 0.0, 0.0]; 3];
        let references = [
            ResolvedFrozenSpinsReference {
                constraint_id: "world-direct-affine",
                values: &values,
                source_state_revision: Some(2),
                topology_fingerprint: "fdm-direct-affine-v1",
            },
            ResolvedFrozenSpinsReference {
                constraint_id: "object-direct-affine",
                values: &values,
                source_state_revision: Some(2),
                topology_fingerprint: "fdm-direct-affine-v1",
            },
        ];
        let transforms = BTreeMap::from([(
            "magnet".to_string(),
            AffineTransform3 {
                translation_m: [1.0, 0.0, 0.0],
                rotation_xyzw: [
                    0.0,
                    0.0,
                    std::f64::consts::FRAC_1_SQRT_2,
                    std::f64::consts::FRAC_1_SQRT_2,
                ],
                scale: [2.0, 0.5, 1.0],
                pivot_m: [0.25, 0.25, 0.0],
            },
        )]);
        let request = FrozenSpinsCompileRequest {
            constraints: &constraints,
            selections: &[],
            activation_stage_id: None,
            object_transforms: &transforms,
            known_entities: known_entities(),
            state_snapshot: None,
            resolved_references: &references,
            expected_source_state_revision: Some(2),
            expected_grid_or_mesh_fingerprint: "fdm-direct-affine-v1",
        };

        let resolved = compile_fdm_frozen_spins(&domain, &request).unwrap();

        assert_eq!(resolved.frozen_mask, vec![true, true, false]);

        for (constraint_index, expected_mask) in
            [(0, vec![true, false, false]), (1, vec![false, true, false])]
        {
            let one_constraint = [constraints[constraint_index].clone()];
            let one_reference = [references[constraint_index]];
            let one_request = FrozenSpinsCompileRequest {
                constraints: &one_constraint,
                selections: &[],
                activation_stage_id: None,
                object_transforms: &transforms,
                known_entities: known_entities(),
                state_snapshot: None,
                resolved_references: &one_reference,
                expected_source_state_revision: Some(2),
                expected_grid_or_mesh_fingerprint: "fdm-direct-affine-v1",
            };
            assert_eq!(
                compile_fdm_frozen_spins(&domain, &one_request)
                    .unwrap()
                    .frozen_mask,
                expected_mask
            );
        }
    }

    #[test]
    fn frozen_spins_all_active_dofs_frozen_is_a_finite_counted_noop_plan() {
        let constraints = vec![constraint("all", SelectionExprIR::AllMagnetic {})];
        let memberships = vec![membership(&["magnet"], &[]); 2];
        let active_mask = vec![true, true];
        let values = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let domain = FdmFrozenSpinsDomain {
            origin_m: [0.0; 3],
            counts: [2, 1, 1],
            cell_m: [1.0; 3],
            active_mask: &active_mask,
            memberships: &memberships,
            grid_fingerprint: "fdm-grid-v1",
        };
        let references = [ResolvedFrozenSpinsReference {
            constraint_id: "all",
            values: &values,
            source_state_revision: Some(3),
            topology_fingerprint: "fdm-grid-v1",
        }];
        let transforms = BTreeMap::new();
        let request = FrozenSpinsCompileRequest {
            constraints: &constraints,
            selections: &[],
            activation_stage_id: None,
            object_transforms: &transforms,
            known_entities: known_entities(),
            state_snapshot: None,
            resolved_references: &references,
            expected_source_state_revision: Some(3),
            expected_grid_or_mesh_fingerprint: "fdm-grid-v1",
        };

        let ResolvedFrozenSpinsPlanIR {
            frozen_dof_count,
            free_dof_count,
            all_active_dofs_frozen,
            ..
        } = compile_fdm_frozen_spins(&domain, &request).unwrap();

        assert_eq!(frozen_dof_count, 2);
        assert_eq!(free_dof_count, 0);
        assert!(all_active_dofs_frozen);
    }
}

#[test]
fn multilayer_pair_kernel_footprint_exposes_l_squared_cost_beyond_shift_telemetry() {
    let abi_v2_bytes = checked_multilayer_pair_kernel_footprint([262_144, 1, 1], 8)
        .expect("ABI v2 tensor footprint should be representable");
    let shift_only_bytes = 2_097_152_u64 * 6 * 16 * 15;

    assert_eq!(abi_v2_bytes, 12 * 1024 * 1024 * 1024);
    assert!(shift_only_bytes < FDM_GRID_MAX_BYTES);
    assert!(abi_v2_bytes > FDM_GRID_MAX_BYTES);
}

#[test]
fn multilayer_pair_kernel_footprint_rejects_pair_count_above_abi_v2_u32_limit() {
    let error = checked_multilayer_pair_kernel_footprint([1, 1, 1], 65_536)
        .expect_err("ABI v2 must reject L squared above its u32 pair-count limit");
    assert!(error
        .reasons
        .iter()
        .any(|reason| reason.contains("u32 limit")));
}

#[test]
fn multilayer_pair_kernel_footprint_rejects_padded_and_byte_overflow() {
    let padded_error = checked_multilayer_pair_kernel_footprint([u32::MAX, u32::MAX, 1], 1)
        .expect_err("padded cell product must not wrap");
    assert!(padded_error
        .reasons
        .iter()
        .any(|reason| reason.contains("padded cell count overflow")));

    let bytes_error = checked_multilayer_pair_kernel_footprint([u32::MAX, 1, 1], 65_535)
        .expect_err("ABI v2 byte product must not wrap");
    assert!(bytes_error
        .reasons
        .iter()
        .any(|reason| reason.contains("payload byte overflow")));
}

fn resolved_stage_autosave(
    stage_id: &str,
    format: AutosaveFormatIR,
    layout: AutosaveLayoutIR,
    clock: ResolvedAutosaveClock,
) -> ResolvedStageAutosave {
    ResolvedStageAutosave {
        stage_id: stage_id.into(),
        target: "main".into(),
        layout,
        format,
        table_quantities: vec!["step".into(), "mx".into()],
        field_quantities: vec!["m".into()],
        mesh_identity: "mesh-v1".into(),
        component_count: 3,
        clock,
        requested: serde_json::from_value(serde_json::json!({
            "target": "main",
            "layout": layout,
            "format": format,
            "table": {"every_steps": 10, "quantities": ["step", "mx"]},
            "fields": [{"quantity": "m", "every_steps": 10}]
        }))
        .unwrap(),
    }
}

#[test]
fn stage_autosave_planning_accepts_relax_and_run_in_one_continuous_target() {
    let relax = resolved_stage_autosave(
        "relax",
        AutosaveFormatIR::Zarr,
        AutosaveLayoutIR::Continuous,
        ResolvedAutosaveClock::AcceptedStep,
    );
    let mut run = relax.clone();
    run.stage_id = "run".into();
    run.clock = ResolvedAutosaveClock::PhysicalTime;

    validate_continuous_autosave_targets(&[relax, run])
        .expect("stage indexes preserve each clock kind without schema drift");
}

#[test]
fn stage_autosave_planning_reports_every_continuous_schema_conflict() {
    let baseline = resolved_stage_autosave(
        "first",
        AutosaveFormatIR::Zarr,
        AutosaveLayoutIR::Continuous,
        ResolvedAutosaveClock::AcceptedStep,
    );
    let mut conflicting = baseline.clone();
    conflicting.stage_id = "second".into();
    conflicting.format = AutosaveFormatIR::Hdf5;
    conflicting.table_quantities = vec!["step".into(), "my".into()];
    conflicting.field_quantities = vec!["H_demag".into()];
    conflicting.mesh_identity = "mesh-v2".into();
    conflicting.component_count = 1;

    let error = validate_continuous_autosave_targets(&[baseline, conflicting])
        .expect_err("continuous schema drift must fail closed");
    for expected in [
        "format differs",
        "table schema differs",
        "field set differs",
        "mesh identity differs",
        "component count differs",
    ] {
        assert!(
            error.reasons.iter().any(|reason| reason.contains(expected)),
            "missing {expected:?} in {:?}",
            error.reasons
        );
    }
}

#[test]
fn stage_autosave_planning_keeps_separate_targets_independent() {
    let first = resolved_stage_autosave(
        "first",
        AutosaveFormatIR::Zarr,
        AutosaveLayoutIR::Separate,
        ResolvedAutosaveClock::AcceptedStep,
    );
    let mut second = first.clone();
    second.stage_id = "second".into();
    second.format = AutosaveFormatIR::Txt;
    second.table_quantities = vec!["step".into()];
    second.field_quantities.clear();

    validate_continuous_autosave_targets(&[first, second])
        .expect("separate layouts do not share a schema registry");
}

#[test]
fn stage_autosave_hdf5_capability_fails_closed_when_unavailable() {
    let stage = resolved_stage_autosave(
        "run",
        AutosaveFormatIR::Hdf5,
        AutosaveLayoutIR::Continuous,
        ResolvedAutosaveClock::PhysicalTime,
    );
    let error = validate_stage_autosave_capabilities(&[stage.clone()], false)
        .expect_err("missing HDF5 capability must fail closed");
    assert!(error.reasons[0].contains("stage_autosave_hdf5"));
    validate_stage_autosave_capabilities(&[stage], true)
        .expect("available HDF5 capability should accept the stage");
}

#[test]
fn run_stage_autosave_fields_are_added_to_runtime_outputs_without_duplicates() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.study.sampling_mut().outputs = vec![OutputIR::Field {
        name: "m".into(),
        every_seconds: 5e-12,
    }];
    problem.study.sampling_mut().stage_autosave = Some(
        serde_json::from_value(serde_json::json!({
            "kind": "stage_autosave",
            "target": "main",
            "layout": "continuous",
            "format": "zarr",
            "fields": [{"quantity": "m", "every_seconds": 2e-12}]
        }))
        .unwrap(),
    );
    let outputs = crate::sampling::runtime_outputs(&problem);
    assert_eq!(
        outputs
            .iter()
            .filter(|output| matches!(output, OutputIR::Field { name, .. } if name == "m"))
            .count(),
        1
    );
    assert!(matches!(
        outputs.as_slice(),
        [OutputIR::Field {
            name,
            every_seconds
        }] if name == "m" && *every_seconds == 2e-12
    ));
}

fn auto_sampling_problem(cutoffs_hz: &[f64], active_stage_id: Option<&str>) -> ProblemIR {
    let mut problem = ProblemIR::bootstrap_example();
    if let Some(stage_id) = active_stage_id {
        problem
            .problem_meta
            .runtime_metadata
            .insert("active_stage_id".into(), serde_json::json!(stage_id));
    }
    problem.study.sampling_mut().table_autosave = Some(TableAutosaveIR {
        kind: "table_autosave".into(),
        table_id: "default".into(),
        sample_period_s: None,
        sample_period_policy: Some(SamplingPeriodPolicyIR::AutoSincCutoff {
            nyquist_guard_factor: AUTO_SINC_NYQUIST_GUARD_FACTOR,
        }),
        resolved_sample_period_s: None,
        every_steps: None,
        quantities: vec!["t".into(), "my".into()],
        expressions: vec![],
    });
    problem.study.sampling_mut().outputs = vec![
        OutputIR::FieldAuto {
            name: "m".into(),
            sample_period_policy: SamplingPeriodPolicyIR::AutoSincCutoff {
                nyquist_guard_factor: AUTO_SINC_NYQUIST_GUARD_FACTOR,
            },
        },
        OutputIR::ScalarAuto {
            name: "E_total".into(),
            sample_period_policy: SamplingPeriodPolicyIR::AutoSincCutoff {
                nyquist_guard_factor: AUTO_SINC_NYQUIST_GUARD_FACTOR,
            },
        },
    ];
    problem.field_drives = cutoffs_hz
        .iter()
        .enumerate()
        .map(|(index, cutoff_hz)| RegionalFieldDriveIR {
            id: format!("drive-{}", index + 1),
            name: format!("Drive {}", index + 1),
            kind: FieldDriveKindIR::Regional,
            enabled: true,
            target: FieldTargetIR::Global {},
            amplitude_b_t: 1.0e-3,
            direction: [0.0, 1.0, 0.0],
            spatial_profile: FieldSpatialProfileIR::Uniform {},
            waveform: TimeDependenceIR::SincPulse {
                cutoff_hz: *cutoff_hz,
                t0: 50.0e-12,
                amplitude: 1.0,
            },
            time_origin: FieldTimeOriginIR::StageLocal,
            activation: DriveActivationIR::StageIds {
                stage_ids: vec!["excite".into()],
            },
            migration: None,
        })
        .collect();
    problem
}

#[test]
fn auto_sampling_uses_maximum_active_sinc_cutoff_with_guard() {
    let mut problem = auto_sampling_problem(&[3.0e9, 5.0e9], Some("excite"));
    let resolution = resolve_auto_sampling_for_stage(&mut problem)
        .expect("automatic sampling should resolve")
        .expect("automatic policy should produce provenance");

    assert_eq!(resolution.maximum_cutoff_hz, 5.0e9);
    assert_eq!(resolution.target_nyquist_hz, 6.5e9);
    assert_eq!(resolution.sampling_frequency_hz, 13.0e9);
    assert!((resolution.sample_period_s - 1.0 / 13.0e9).abs() < 1e-24);
    assert_eq!(resolution.source_drive_ids, ["drive-1", "drive-2"]);
    assert_eq!(resolution.target_stage_id, "excite");
    assert_eq!(resolution.schema_version, "sampling_resolution.v1");

    let sampling = problem.study.sampling();
    assert_eq!(
        sampling
            .table_autosave
            .as_ref()
            .and_then(|table| table.resolved_sample_period_s),
        Some(1.0 / 13.0e9)
    );
    assert!(matches!(
        sampling.outputs.as_slice(),
        [OutputIR::FieldResolvedAuto { every_seconds: field_period, .. }, OutputIR::ScalarResolvedAuto { every_seconds: scalar_period, .. }]
            if *field_period == 1.0 / 13.0e9 && *scalar_period == 1.0 / 13.0e9
    ));
    assert_eq!(
        problem.problem_meta.runtime_metadata["sampling_resolution"],
        serde_json::to_value(&resolution).expect("resolution must serialize")
    );
}

#[test]
fn auto_sampling_accepts_all_time_evolution_drive_for_anonymous_run_stage() {
    let mut problem = auto_sampling_problem(&[3.0e9], Some("run-1"));
    problem.field_drives[0].activation = DriveActivationIR::AllTimeEvolution {};

    let resolution = resolve_auto_sampling_for_stage(&mut problem)
        .expect("all-time-evolution drive must be active for an anonymous Run stage")
        .expect("automatic policy should produce provenance");

    assert_eq!(resolution.maximum_cutoff_hz, 3.0e9);
    assert_eq!(resolution.source_drive_ids, ["drive-1"]);
    assert_eq!(resolution.target_stage_id, "run-1");
}

#[test]
fn auto_sampling_filters_disabled_inactive_and_non_sinc_drives() {
    let mut problem = auto_sampling_problem(&[3.0e9, 5.0e9], Some("excite"));
    problem.field_drives[0].enabled = false;
    problem.field_drives[1].activation = DriveActivationIR::StageIds {
        stage_ids: vec!["other".into()],
    };
    let mut constant = problem.field_drives[0].clone();
    constant.id = "constant".into();
    constant.enabled = true;
    constant.activation = DriveActivationIR::StageIds {
        stage_ids: vec!["excite".into()],
    };
    constant.waveform = TimeDependenceIR::Constant;
    problem.field_drives.push(constant);

    let error = resolve_auto_sampling_for_stage(&mut problem)
        .expect_err("automatic sampling must fail without an applicable active sinc drive");
    assert!(error
        .reasons
        .iter()
        .any(|reason| { reason.contains("active sinc") && reason.contains("excite") }));
}

#[test]
fn auto_sampling_rejects_standalone_time_evolution_without_stage_context() {
    let mut problem = auto_sampling_problem(&[5.0e9], None);
    let error = resolve_auto_sampling_for_stage(&mut problem)
        .expect_err("standalone automatic sampling must fail closed");
    assert!(error.reasons.iter().any(|reason| {
        reason.contains("active_stage_id") && reason.contains("automatic sampling")
    }));
}

#[test]
fn explicit_sampling_does_not_require_a_stage_or_drive() {
    let mut problem = ProblemIR::bootstrap_example();
    let before = problem.clone();
    assert_eq!(resolve_auto_sampling_for_stage(&mut problem).unwrap(), None);
    assert_eq!(problem, before);
}

#[test]
fn fem_top_surface_selector_resolves_bbox_faces() {
    let mesh = MeshIR {
        mesh_name: "box".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 1.0],
            [0.0, 1.0, 1.0],
        ],
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
        element_markers: vec![1],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [3, 4, 5]]),
        boundary_markers: vec![10, 20],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };
    let mesh_parts = vec![fullmag_ir::FemMeshPartIR {
        id: "part:film".to_string(),
        label: "film".to_string(),
        role: fullmag_ir::FemMeshPartRole::MagneticObject,
        object_id: Some("film".to_string()),
        geometry_id: Some("film".to_string()),
        material_id: None,
        element_selector: fullmag_ir::FemMeshPartSelector::ElementRange { start: 0, count: 1 },
        boundary_face_selector: fullmag_ir::FemMeshPartSelector::BoundaryFaceRange {
            start: 0,
            count: 2,
        },
        node_selector: fullmag_ir::FemMeshPartSelector::NodeRange { start: 0, count: 6 },
        boundary_face_indices: Vec::new(),
        node_indices: Vec::new(),
        facet_global_ordinals: Vec::new(),
        bounds_min: Some([0.0, 0.0, 0.0]),
        bounds_max: Some([1.0, 1.0, 1.0]),
        parent_id: None,
    }];

    let resolved = resolve_fem_surface_selector(&mesh, &mesh_parts, "film", "top", None)
        .expect("top selector should resolve");

    assert_eq!(resolved.selector, "top");
    assert_eq!(resolved.boundary_face_indices, vec![1]);
    assert_eq!(resolved.facet_global_ordinals, vec![1]);
    assert_eq!(resolved.node_indices, vec![3, 4, 5]);
    assert!((resolved.area - 0.5).abs() < 1e-12);
}

#[test]
fn fem_surface_selector_rejects_unknown_bbox_face() {
    let mesh = MeshIR {
        mesh_name: "box".to_string(),
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
    };

    let error = resolve_fem_surface_selector(&mesh, &[], "film", "named_face", None)
        .expect_err("v1 must reject named faces");

    assert!(error.contains("named_face"));
    assert!(error.contains("top/bottom/left/right/front/back"));
}

#[test]
fn shared_domain_segmentation_remaps_periodic_node_pairs() {
    let mesh = MeshIR {
        mesh_name: "periodic_shared_domain".to_string(),
        nodes: vec![
            [10.0, 0.0, 0.0],
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [10.0, 1.0, 0.0],
            [10.0, 0.0, 1.0],
            [11.0, 1.0, 1.0],
            [0.0, 0.0, 1.0],
        ],
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 4, 5, 6], [1, 2, 3, 7]]),
        element_markers: vec![0, 1],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[1, 2, 3], [0, 4, 5]]),
        boundary_markers: vec![11, 99],
        periodic_boundary_pairs: vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "x_faces".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 11,
            marker_b: 12,
            translation: Some([1.0, 0.0, 0.0]),
            tolerance: Some(1e-12),
            axis_hint: None,
            orientation: None,
            pairing_policy: None,
        }],
        periodic_node_pairs: vec![fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "x_faces".to_string(),
            node_a: 1,
            node_b: 2,
        }],
        per_domain_quality: std::collections::HashMap::new(),
    };
    let analysis = crate::mesh::analyze_shared_domain_mesh(
        &mesh,
        &[fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "film".to_string(),
            marker: 1,
        }],
    )
    .expect("shared-domain mesh should analyze");

    let (packed, _, _) = crate::mesh::pack_mesh_by_analysis(&mesh, &analysis)
        .expect("periodic pairs should remap during packing");

    assert_eq!(packed.periodic_node_pairs.len(), 1);
    assert_eq!(packed.periodic_node_pairs[0].node_a, 0);
    assert_eq!(packed.periodic_node_pairs[0].node_b, 1);
    packed
        .validate()
        .expect("remapped periodic node pair should satisfy translation residual");
}

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
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
        element_markers: vec![1],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
        facet_global_ordinals: Vec::new(),
        bounds_min: None,
        bounds_max: None,
        parent_id: None,
    }];
    let entry = crate::mesh::MagnetPlanningEntry {
        magnet_name: "free".to_string(),
        geometry_name: "free_geom".to_string(),
        object_translation: [0.0, 0.0, 0.0],
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
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
        element_markers: vec![1],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
        facet_global_ordinals: Vec::new(),
        bounds_min: None,
        bounds_max: None,
        parent_id: None,
    }];
    let entry = crate::mesh::MagnetPlanningEntry {
        magnet_name: "free".to_string(),
        geometry_name: "free_geom".to_string(),
        object_translation: [0.0, 0.0, 0.0],
        initial_magnetization: Some(InitialMagnetizationIR::PresetTexture {
            preset_kind: "vortex".to_string(),
            preset_version: 1,
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
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
        element_markers: vec![1, 0],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [4, 5, 6]]),
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
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [0, 2, 1, 4]]),
        element_markers: vec![1, 0],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 3], [0, 1, 4]]),
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
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
        element_markers: vec![1],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
        element_markers: vec![1],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [0, 2, 1, 4]]),
        element_markers: vec![1, 2],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 3], [0, 1, 4]]),
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
        vec![
            crate::mesh::SharedDomainRegionEntry {
                object_id: "left".to_string(),
                geometry_id: "left".to_string(),
                marker: 1,
            },
            crate::mesh::SharedDomainRegionEntry {
                object_id: "right".to_string(),
                geometry_id: "right".to_string(),
                marker: 2,
            },
        ]
    );
    assert_eq!(analysis.shared_interface_nodes.len(), 3);
    assert!(analysis
        .shared_interface_nodes
        .iter()
        .all(|(_node, owners)| owners == &vec![1, 2]));
}

#[test]
fn reorder_shared_domain_mesh_materializes_interface_and_outer_boundary_parts() {
    let mut mesh = MeshIR {
        mesh_name: "shared_with_air".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
        ],
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [0, 2, 1, 4]]),
        element_markers: vec![1, 0],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![
            [0, 1, 3],
            [0, 2, 3],
            [1, 2, 3],
            [0, 1, 4],
            [0, 2, 4],
            [1, 2, 4],
            [0, 1, 2],
        ]),
        boundary_markers: vec![10, 10, 10, 99, 99, 99, 77],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };
    mesh.facets.roles[6] = fullmag_ir::FemFacetRoleIR::MaterialInterface;

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
    assert_eq!(interface_part.object_id.as_deref(), Some("flower"));
    assert_eq!(interface_part.geometry_id.as_deref(), Some("flower"));
    assert_eq!(interface_part.parent_id.as_deref(), Some("part:flower"));
    assert!(!interface_part.node_indices.is_empty());
    assert_eq!(interface_part.facet_global_ordinals.len(), 1);
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
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
        element_markers: vec![1, 0],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [4, 5, 6]]),
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
fn pack_mixed_topology_keeps_each_type_connectivity_role_and_marker_together() {
    let mesh = MeshIR {
        mesh_name: "mixed_pack".to_string(),
        nodes: vec![
            [3.0, 0.0, 0.0],
            [4.0, 0.0, 0.0],
            [3.0, 1.0, 0.0],
            [3.0, 0.0, 1.0],
            [4.0, 0.0, 1.0],
            [3.0, 1.0, 1.0],
            [6.0, 0.0, 0.0],
            [7.0, 0.0, 0.0],
            [7.0, 1.0, 0.0],
            [6.0, 1.0, 0.0],
            [6.5, 0.5, 1.0],
            [9.0, 0.0, 0.0],
            [10.0, 0.0, 0.0],
            [9.0, 1.0, 0.0],
            [9.0, 0.0, 1.0],
        ],
        cells: fullmag_ir::FemConnectivityIR {
            types: vec![
                fullmag_ir::FemCellTypeIR::Prism6,
                fullmag_ir::FemCellTypeIR::Pyramid5,
                fullmag_ir::FemCellTypeIR::Tet4,
            ],
            offsets: vec![0, 6, 11, 15],
            nodes: vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
            global_ordinals: vec![91, 12, 44],
            mesh_parts: vec![
                fullmag_ir::FemCellMeshPartIR::Magnetic,
                fullmag_ir::FemCellMeshPartIR::TransitionAir,
                fullmag_ir::FemCellMeshPartIR::FarAir,
            ],
        },
        element_markers: vec![2, 1, 0],
        facets: fullmag_ir::FemFacetConnectivityIR {
            types: vec![
                fullmag_ir::FemFacetTypeIR::Quad4,
                fullmag_ir::FemFacetTypeIR::Quad4,
                fullmag_ir::FemFacetTypeIR::Tri3,
            ],
            roles: vec![
                fullmag_ir::FemFacetRoleIR::Exterior,
                fullmag_ir::FemFacetRoleIR::MaterialInterface,
                fullmag_ir::FemFacetRoleIR::Exterior,
            ],
            offsets: vec![0, 4, 8, 11],
            nodes: vec![0, 1, 4, 3, 6, 9, 8, 7, 11, 13, 12],
            global_ordinals: vec![90, 11, 45],
        },
        boundary_markers: vec![20, 10, 99],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };
    let analysis = crate::mesh::analyze_shared_domain_mesh(
        &mesh,
        &[
            fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "pyramid".to_string(),
                marker: 1,
            },
            fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "prism".to_string(),
                marker: 2,
            },
        ],
    )
    .expect("mixed analysis should succeed");

    let (packed, segments, _) =
        crate::mesh::pack_mesh_by_analysis(&mesh, &analysis).expect("mixed packing should succeed");

    assert_eq!(
        packed.cells.types,
        vec![
            fullmag_ir::FemCellTypeIR::Pyramid5,
            fullmag_ir::FemCellTypeIR::Prism6,
            fullmag_ir::FemCellTypeIR::Tet4,
        ]
    );
    assert_eq!(packed.element_markers, vec![1, 2, 0]);
    assert_eq!(packed.cells.global_ordinals, vec![12, 91, 44]);
    assert_eq!(
        packed.cells.mesh_parts,
        vec![
            fullmag_ir::FemCellMeshPartIR::TransitionAir,
            fullmag_ir::FemCellMeshPartIR::Magnetic,
            fullmag_ir::FemCellMeshPartIR::FarAir,
        ]
    );
    assert_eq!(packed.cells.offsets, vec![0, 5, 11, 15]);
    assert_eq!(
        packed.facets.types,
        vec![
            fullmag_ir::FemFacetTypeIR::Quad4,
            fullmag_ir::FemFacetTypeIR::Quad4,
            fullmag_ir::FemFacetTypeIR::Tri3,
        ]
    );
    assert_eq!(
        packed.facets.roles,
        vec![
            fullmag_ir::FemFacetRoleIR::MaterialInterface,
            fullmag_ir::FemFacetRoleIR::Exterior,
            fullmag_ir::FemFacetRoleIR::Exterior,
        ]
    );
    assert_eq!(packed.boundary_markers, vec![10, 20, 99]);
    assert_eq!(packed.facets.global_ordinals, vec![11, 90, 45]);
    assert_eq!(segments[0].element_start, 0);
    assert_eq!(segments[1].element_start, 1);
}

fn adjacent_hex_interface_mesh(right_marker: u32) -> MeshIR {
    MeshIR {
        mesh_name: format!("hex_interface_{right_marker}"),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 1.0],
            [1.0, 1.0, 1.0],
            [0.0, 1.0, 1.0],
            [2.0, 0.0, 0.0],
            [2.0, 1.0, 0.0],
            [2.0, 0.0, 1.0],
            [2.0, 1.0, 1.0],
        ],
        cells: fullmag_ir::FemConnectivityIR {
            types: vec![
                fullmag_ir::FemCellTypeIR::Hex8,
                fullmag_ir::FemCellTypeIR::Hex8,
            ],
            offsets: vec![0, 8, 16],
            nodes: vec![0, 1, 2, 3, 4, 5, 6, 7, 1, 8, 9, 2, 5, 10, 11, 6],
            global_ordinals: vec![501, 902],
            mesh_parts: Vec::new(),
        },
        element_markers: vec![1, right_marker],
        facets: fullmag_ir::FemFacetConnectivityIR {
            types: vec![fullmag_ir::FemFacetTypeIR::Quad4],
            roles: vec![fullmag_ir::FemFacetRoleIR::MaterialInterface],
            offsets: vec![0, 4],
            nodes: vec![1, 2, 6, 5],
            global_ordinals: vec![700],
        },
        boundary_markers: vec![27],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    }
}

#[test]
fn packing_preserves_magnetic_magnetic_quad_interface_once() {
    let mesh = adjacent_hex_interface_mesh(2);
    let analysis = crate::mesh::analyze_shared_domain_mesh(
        &mesh,
        &[
            fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "left".into(),
                marker: 1,
            },
            fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "right".into(),
                marker: 2,
            },
        ],
    )
    .unwrap();
    let (packed, _, parts) = crate::mesh::pack_mesh_by_analysis(&mesh, &analysis).unwrap();
    assert_eq!(packed.facets.types, vec![fullmag_ir::FemFacetTypeIR::Quad4]);
    assert_eq!(
        packed.facets.roles,
        vec![fullmag_ir::FemFacetRoleIR::MaterialInterface]
    );
    assert_eq!(packed.facets.global_ordinals, vec![700]);
    let interface = parts
        .iter()
        .find(|part| part.role == fullmag_ir::FemMeshPartRole::Interface)
        .unwrap();
    assert_eq!(interface.boundary_face_indices, vec![0]);
}

#[test]
fn packing_preserves_air_magnetic_quad_interface_once() {
    let mesh = adjacent_hex_interface_mesh(0);
    let analysis = crate::mesh::analyze_shared_domain_mesh(
        &mesh,
        &[fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "film".into(),
            marker: 1,
        }],
    )
    .unwrap();
    let (packed, _, parts) = crate::mesh::pack_mesh_by_analysis(&mesh, &analysis).unwrap();
    assert_eq!(packed.facets.types, vec![fullmag_ir::FemFacetTypeIR::Quad4]);
    assert_eq!(packed.facets.global_ordinals, vec![700]);
    let interface = parts
        .iter()
        .find(|part| part.role == fullmag_ir::FemMeshPartRole::Interface)
        .unwrap();
    assert_eq!(interface.boundary_face_indices, vec![0]);
    assert_eq!(interface.object_id.as_deref(), Some("film"));
}

#[test]
fn mixed_mesh_part_slice_retains_global_ordinals_and_variable_arity() {
    let mesh = MeshIR {
        mesh_name: "mixed_slice".to_string(),
        nodes: vec![[0.0, 0.0, 0.0]; 15],
        cells: fullmag_ir::FemConnectivityIR {
            types: vec![
                fullmag_ir::FemCellTypeIR::Prism6,
                fullmag_ir::FemCellTypeIR::Tet4,
                fullmag_ir::FemCellTypeIR::Pyramid5,
            ],
            offsets: vec![0, 6, 10, 15],
            nodes: (0..15).collect(),
            global_ordinals: vec![80, 12, 44],
            mesh_parts: vec![fullmag_ir::FemCellMeshPartIR::TransitionAir],
        },
        element_markers: vec![1, 0, 0],
        facets: fullmag_ir::FemFacetConnectivityIR::empty(),
        boundary_markers: Vec::new(),
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };
    let segment = fullmag_ir::FemObjectSegmentIR {
        object_id: "__air__".to_string(),
        geometry_id: None,
        node_start: 6,
        node_count: 9,
        element_start: 1,
        element_count: 2,
        boundary_face_start: 0,
        boundary_face_count: 0,
    };
    let parts = crate::mesh::build_mesh_parts_from_segments(
        &mesh,
        std::slice::from_ref(&segment),
        fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir,
    );
    let part = &parts[0];
    let fullmag_ir::FemMeshPartSelector::ElementRange { start, count } = part.element_selector
    else {
        panic!("mesh part should retain an element range")
    };
    let sliced = mesh
        .cells
        .iter()
        .skip(start as usize)
        .take(count as usize)
        .collect::<Vec<_>>();
    assert_eq!(
        sliced
            .iter()
            .map(|cell| cell.global_ordinal)
            .collect::<Vec<_>>(),
        vec![12, 44]
    );
    assert_eq!(
        sliced.iter().map(|cell| cell.cell_type).collect::<Vec<_>>(),
        vec![
            fullmag_ir::FemCellTypeIR::Tet4,
            fullmag_ir::FemCellTypeIR::Pyramid5,
        ]
    );
    assert_eq!(sliced[0].nodes, &[6, 7, 8, 9]);
    assert_eq!(sliced[1].nodes, &[10, 11, 12, 13, 14]);
    assert!(part.node_indices.is_empty());
    assert_eq!(
        part.node_selector,
        fullmag_ir::FemMeshPartSelector::NodeRange { start: 6, count: 9 }
    );
}

#[test]
fn merge_mixed_meshes_preserves_input_order_and_typed_offsets() {
    let prism = MeshIR {
        mesh_name: "prism".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 1.0],
            [0.0, 1.0, 1.0],
        ],
        cells: fullmag_ir::FemConnectivityIR {
            types: vec![fullmag_ir::FemCellTypeIR::Prism6],
            offsets: vec![0, 6],
            nodes: vec![0, 1, 2, 3, 4, 5],
            global_ordinals: vec![40],
            mesh_parts: vec![fullmag_ir::FemCellMeshPartIR::Magnetic],
        },
        element_markers: vec![1],
        facets: fullmag_ir::FemFacetConnectivityIR {
            types: vec![fullmag_ir::FemFacetTypeIR::Quad4],
            roles: vec![fullmag_ir::FemFacetRoleIR::Exterior],
            offsets: vec![0, 4],
            nodes: vec![0, 1, 4, 3],
            global_ordinals: vec![70],
        },
        boundary_markers: vec![3],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };
    let pyramid = MeshIR {
        mesh_name: "pyramid".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.5, 0.5, 1.0],
        ],
        cells: fullmag_ir::FemConnectivityIR {
            types: vec![fullmag_ir::FemCellTypeIR::Pyramid5],
            offsets: vec![0, 5],
            nodes: vec![0, 1, 2, 3, 4],
            global_ordinals: vec![40],
            mesh_parts: vec![fullmag_ir::FemCellMeshPartIR::TransitionAir],
        },
        element_markers: vec![1],
        facets: fullmag_ir::FemFacetConnectivityIR {
            types: vec![fullmag_ir::FemFacetTypeIR::Tri3],
            roles: vec![fullmag_ir::FemFacetRoleIR::MaterialInterface],
            offsets: vec![0, 3],
            nodes: vec![0, 1, 4],
            global_ordinals: vec![70],
        },
        boundary_markers: vec![4],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };

    let (merged, segments) = crate::mesh::merge_fem_meshes(&[
        ("left".to_string(), prism),
        ("right".to_string(), pyramid),
    ])
    .expect("mixed merge should succeed");

    assert_eq!(
        merged.cells.types,
        vec![
            fullmag_ir::FemCellTypeIR::Prism6,
            fullmag_ir::FemCellTypeIR::Pyramid5,
        ]
    );
    assert_eq!(merged.cells.offsets, vec![0, 6, 11]);
    assert_eq!(merged.cells.global_ordinals, vec![0, 1]);
    assert_eq!(
        merged.cells.mesh_parts,
        vec![
            fullmag_ir::FemCellMeshPartIR::Magnetic,
            fullmag_ir::FemCellMeshPartIR::TransitionAir,
        ]
    );
    assert_eq!(merged.cells.item_nodes(0), Some(&[0, 1, 2, 3, 4, 5][..]));
    assert_eq!(merged.cells.item_nodes(1), Some(&[6, 7, 8, 9, 10][..]));
    assert_eq!(
        merged.facets.types,
        vec![
            fullmag_ir::FemFacetTypeIR::Quad4,
            fullmag_ir::FemFacetTypeIR::Tri3,
        ]
    );
    assert_eq!(
        merged.facets.roles,
        vec![
            fullmag_ir::FemFacetRoleIR::Exterior,
            fullmag_ir::FemFacetRoleIR::MaterialInterface,
        ]
    );
    assert_eq!(merged.boundary_markers, vec![3, 4]);
    assert_eq!(merged.facets.global_ordinals, vec![0, 1]);
    assert_eq!(segments[0].element_start, 0);
    assert_eq!(segments[1].element_start, 1);
    assert_eq!(segments[1].node_start, 6);
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
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [0, 2, 1, 4]]),
        element_markers: vec![1, 2],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 3], [0, 1, 4]]),
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
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [0, 2, 1, 4]]),
        element_markers: vec![1, 2],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 3], [0, 1, 4]]),
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
    let mut mesh = MeshIR {
        mesh_name: "touching".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
        ],
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [0, 2, 1, 4]]),
        element_markers: vec![1, 2],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![
            [0, 1, 3],
            [0, 1, 4],
            [0, 1, 2],
        ]),
        boundary_markers: vec![10, 20, 30],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };
    mesh.facets.roles[2] = fullmag_ir::FemFacetRoleIR::MaterialInterface;
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
    assert_eq!(
        packed.require_tet4_elements().unwrap(),
        vec![[0, 1, 2, 3], [4, 6, 5, 7]]
    );
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
fn pack_preserves_shared_interface_nodes_within_one_object() {
    let mut mesh = MeshIR {
        mesh_name: "object_with_region".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
        ],
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [0, 2, 1, 4]]),
        element_markers: vec![1, 2],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
        boundary_markers: vec![10],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };
    mesh.facets.roles[0] = fullmag_ir::FemFacetRoleIR::MaterialInterface;
    let analysis = crate::mesh::SharedDomainAnalysis {
        node_owner: vec![1, 1, 1, 1, 2],
        face_owner: [([0, 1, 2].to_vec(), 1)].into_iter().collect(),
        ordered_regions: vec![
            crate::mesh::SharedDomainRegionEntry {
                object_id: "body".to_string(),
                geometry_id: "body_geom".to_string(),
                marker: 1,
            },
            crate::mesh::SharedDomainRegionEntry {
                object_id: "body".to_string(),
                geometry_id: "body:refinement".to_string(),
                marker: 2,
            },
        ],
        shared_interface_nodes: vec![(0, vec![1, 2]), (1, vec![1, 2]), (2, vec![1, 2])],
        interface_faces: vec![crate::mesh::SharedInterfaceFace {
            facet_global_ordinal: 0,
            facet_type: fullmag_ir::FemFacetTypeIR::Tri3,
            markers: vec![1, 2],
        }],
    };

    let (packed, segments, mesh_parts) = crate::mesh::pack_mesh_by_analysis(&mesh, &analysis)
        .expect("packing should preserve one H1 field within an object");

    assert_eq!(packed.nodes.len(), 5);
    assert_eq!(
        packed.require_tet4_elements().unwrap(),
        vec![[0, 1, 2, 3], [0, 2, 1, 4]]
    );
    assert_eq!(segments.len(), 2);
    assert_eq!(segments[0].object_id, "body");
    assert_eq!(segments[1].object_id, "body");
    let region_part = mesh_parts
        .iter()
        .find(|part| part.geometry_id.as_deref() == Some("body:refinement"))
        .expect("region mesh part should exist");
    assert_eq!(region_part.node_indices, vec![0, 1, 2, 4]);
    let interface_part = mesh_parts
        .iter()
        .find(|part| part.id == "part:interface:1:2")
        .expect("same-object interface mesh part should exist");
    assert_eq!(interface_part.object_id.as_deref(), Some("body"));
    assert_eq!(interface_part.parent_id.as_deref(), Some("part:body"));

    let entry = crate::mesh::MagnetPlanningEntry {
        magnet_name: "body".to_string(),
        geometry_name: "body_geom".to_string(),
        object_translation: [0.0, 0.0, 0.0],
        initial_magnetization: Some(InitialMagnetizationIR::RandomSeeded { seed: 17 }),
    };
    let expected = crate::mesh::initial_vectors_for_magnet(
        "body",
        &packed.mesh_name,
        entry.initial_magnetization.as_ref(),
        packed.nodes.len(),
        Some(&packed.nodes),
        Some(&packed.nodes),
    )
    .expect("whole-object initial texture should sample");
    let mut actual = vec![[0.0, 0.0, 0.0]; packed.nodes.len()];
    crate::fem::assign_domain_initial_for_segments(
        &mut actual,
        &packed,
        &mesh_parts,
        &segments.iter().collect::<Vec<_>>(),
        &entry,
    )
    .expect("segmented object initial texture should sample once");
    assert_eq!(actual, expected);

    let textured_entry = crate::mesh::MagnetPlanningEntry {
        magnet_name: "body".to_string(),
        geometry_name: "body_geom".to_string(),
        object_translation: [0.0, 0.0, 0.0],
        initial_magnetization: Some(InitialMagnetizationIR::PresetTexture {
            preset_version: 1,
            preset_kind: "neel_skyrmion".to_string(),
            preset_params: std::collections::BTreeMap::from([
                ("core_polarity".to_string(), serde_json::json!(1)),
                ("chirality".to_string(), serde_json::json!(1)),
                ("plane".to_string(), serde_json::json!("xy")),
                ("radius".to_string(), serde_json::json!(0.75)),
                ("wall_width".to_string(), serde_json::json!(0.2)),
            ]),
            mapping: fullmag_ir::TextureMappingIR::default(),
            texture_transform: fullmag_ir::TextureTransform3DIR::default(),
        }),
    };
    let expected_texture = crate::mesh::initial_vectors_for_magnet(
        "body",
        &packed.mesh_name,
        textured_entry.initial_magnetization.as_ref(),
        packed.nodes.len(),
        Some(&packed.nodes),
        Some(&packed.nodes),
    )
    .expect("whole-object preset texture should sample");
    let mut actual_texture = vec![[0.0, 0.0, 0.0]; packed.nodes.len()];
    crate::fem::assign_domain_initial_for_segments(
        &mut actual_texture,
        &packed,
        &mesh_parts,
        &segments.iter().collect::<Vec<_>>(),
        &textured_entry,
    )
    .expect("segmented object preset texture should sample once");
    assert_eq!(actual_texture, expected_texture);
}

#[test]
fn pack_merges_coincident_interface_nodes_within_one_object() {
    let mesh = MeshIR {
        mesh_name: "object_region_with_duplicated_interface_nodes".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, -1.0],
        ],
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 6, 5, 7]]),
        element_markers: vec![1, 2],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(Vec::new()),
        boundary_markers: Vec::new(),
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };
    let analysis = crate::mesh::SharedDomainAnalysis {
        node_owner: vec![1, 1, 1, 1, 2, 2, 2, 2],
        face_owner: std::collections::BTreeMap::new(),
        ordered_regions: vec![
            crate::mesh::SharedDomainRegionEntry {
                object_id: "body".to_string(),
                geometry_id: "body_geom".to_string(),
                marker: 1,
            },
            crate::mesh::SharedDomainRegionEntry {
                object_id: "body".to_string(),
                geometry_id: "body:refinement".to_string(),
                marker: 2,
            },
        ],
        shared_interface_nodes: Vec::new(),
        interface_faces: Vec::new(),
    };

    let (packed, segments, mesh_parts) = crate::mesh::pack_mesh_by_analysis(&mesh, &analysis)
        .expect("same-object coincident region nodes should merge");

    assert_eq!(packed.nodes.len(), 5);
    assert_eq!(
        packed.require_tet4_elements().unwrap(),
        vec![[0, 1, 2, 3], [0, 2, 1, 4]]
    );
    assert_eq!(segments.len(), 2);
    assert_eq!(segments[0].object_id, "body");
    assert_eq!(segments[1].object_id, "body");
    let region_part = mesh_parts
        .iter()
        .find(|part| part.geometry_id.as_deref() == Some("body:refinement"))
        .expect("region mesh part should exist");
    assert_eq!(region_part.node_indices, vec![0, 1, 2, 4]);
}

#[test]
fn fem_plan_maps_geometry_and_object_region_to_one_continuous_object() {
    let mut ir = fem_minimal_test_ir();
    ir.geometry.entries[0] = GeometryEntryIR::Box {
        name: "strip_geom".to_string(),
        size: [1.0, 1.0, 1.0],
    };
    ir.regions[0].geometry = "strip_geom".to_string();
    ir.object_regions.push(fullmag_ir::ObjectRegionIR {
        region_id: "strip:refinement".to_string(),
        owner_object: "strip".to_string(),
        name: "refinement".to_string(),
        shape: fullmag_ir::RegionShapeIR::Box {
            size: [0.5, 0.5, 0.5],
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
    });
    let domain_asset = ir
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .expect("FEM domain asset should exist");
    domain_asset.mesh = Some(MeshIR {
        mesh_name: "strip_with_refinement".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
        ],
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [0, 2, 1, 4]]),
        element_markers: vec![1, 2],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(Vec::new()),
        boundary_markers: Vec::new(),
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    });
    domain_asset.region_markers[0].geometry_name = "strip_geom".to_string();
    domain_asset
        .object_region_markers
        .push(fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "strip:refinement".to_string(),
            marker: 2,
        });

    let planned = plan(&ir).expect("mesh-only region should preserve one continuous FEM object");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("expected FEM plan");
    };

    assert_eq!(fem.mesh.nodes.len(), 5);
    assert_eq!(
        fem.mesh.require_tet4_elements().unwrap(),
        vec![[0, 1, 2, 3], [0, 2, 1, 4]]
    );
    assert_eq!(fem.initial_magnetization.len(), 5);
    assert_eq!(fem.object_segments.len(), 2);
    assert!(fem
        .object_segments
        .iter()
        .all(|segment| segment.object_id == "strip"));
    assert!(
        fem.ms_element_field.is_none(),
        "mesh-only object region must not introduce a discontinuous Ms element field"
    );
    assert!(
        fem.a_element_field.is_none(),
        "mesh-only object region must not introduce a discontinuous Aex element field"
    );
    assert!(
        fem.material.ms_field.is_none(),
        "mesh-only object region must not introduce a nodal Ms field"
    );
    assert!(
        fem.material.a_field.is_none(),
        "mesh-only object region must not introduce a nodal Aex field"
    );
    assert!(
        fem.region_materials.is_empty(),
        "mesh-only object region must not create a separate FEM region material"
    );
}

#[test]
fn fem_inherited_mesh_policy_region_does_not_change_physics_contract() {
    let mut ir = fem_minimal_test_ir();
    let baseline_plan = plan(&ir).expect("baseline FEM plan should succeed");
    let BackendPlanIR::Fem(baseline_fem) = baseline_plan.backend_plan else {
        panic!("expected baseline FEM plan");
    };

    ir.object_regions.push(fullmag_ir::ObjectRegionIR {
        region_id: "strip:local_refinement".to_string(),
        owner_object: "strip".to_string(),
        name: "local_refinement".to_string(),
        shape: fullmag_ir::RegionShapeIR::Cylinder {
            radius: 0.25,
            height: 1.0,
            center: [0.0, 0.0, 0.0],
            axis: [0.0, 0.0, 1.0],
        },
        frame: fullmag_ir::RegionFrameIR::Object,
        enabled: true,
        priority: 10,
        mesh_policy: Some(fullmag_ir::RegionMeshPolicyIR {
            maximum_element_size: Some(0.1),
            minimum_element_size: Some(0.05),
            transition_distance: Some(0.5),
            order: Some(1),
        }),
        material_overrides: Vec::new(),
        texture_override: None,
        material_transition: None,
        realization_policy: fullmag_ir::RegionRealizationPolicyIR::Inherit,
    });

    let planned = plan(&ir).expect("inherited mesh-only region should plan");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("expected FEM plan");
    };

    assert_eq!(
        fem.object_segments
            .iter()
            .filter(|segment| segment.object_id == "strip")
            .count(),
        1,
        "inherited mesh-only region must not become a separate magnetic segment"
    );
    assert!(
        fem.region_materials.is_empty(),
        "single-object inherited mesh-only region must not create region_materials"
    );
    assert!(
        fem.ms_element_field.is_none() && fem.a_element_field.is_none(),
        "inherited mesh-only region must not create discontinuous element coefficient fields"
    );
    assert!(
        fem.material.ms_field.is_none()
            && fem.material.a_field.is_none()
            && fem.material.alpha_field.is_none(),
        "inherited mesh-only region must not create nodal material fields"
    );
    assert!(
        fem.initial_magnetization == baseline_fem.initial_magnetization,
        "inherited mesh-only region must preserve the parent initial texture"
    );
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
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![
            [0, 1, 2, 3],
            [4, 5, 6, 7],
            [8, 9, 10, 11],
        ]),
        element_markers: vec![1, 2, 0],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![
            [0, 1, 2],
            [4, 5, 6],
            [8, 9, 10],
        ]),
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

fn fdm_fft_policy_problem(fft_backend: &str) -> ProblemIR {
    let mut ir = ProblemIR::bootstrap_example();
    ir.energy_terms.push(fullmag_ir::EnergyTermIR::Demag {
        realization: fullmag_ir::RequestedFemDemagIR::default(),
    });
    let fdm = ir
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .expect("bootstrap FDM hints");
    fdm.demag = Some(fullmag_ir::FdmDemagHintsIR {
        strategy: "single_grid".to_string(),
        mode: "three_d".to_string(),
        fft_backend: fft_backend.to_string(),
        common_cells: None,
        common_cells_xy: None,
        common_cell_size: None,
    });
    ir
}

#[test]
fn fdm_fft_request_reaches_the_executable_plan_without_resolution_drift() {
    let planned = plan(&fdm_fft_policy_problem("rustfft"))
        .expect("qualified RustFFT request should plan for CPU FDM");
    let BackendPlanIR::Fdm(fdm) = planned.backend_plan else {
        panic!("expected single-grid FDM plan");
    };

    assert_eq!(
        fdm.fft.as_ref().map(|fft| fft.requested_backend.as_str()),
        Some("rustfft")
    );
}

#[test]
fn fdm_fft_planner_rejects_unavailable_vendor_backend() {
    let error = plan(&fdm_fft_policy_problem("fftw"))
        .expect_err("unavailable FFTW request must fail before runtime dispatch");

    assert!(error.reasons.iter().any(|reason| {
        reason.contains("fdm.demag.fft_backend='fftw'")
            && reason.contains("not available in this build")
    }));
}

#[test]
fn fdm_fft_planner_rejects_explicit_device_mismatches() {
    for (backend, device) in [("rustfft", "gpu"), ("cufft", "cpu")] {
        let mut ir = fdm_fft_policy_problem(backend);
        ir.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            serde_json::json!({"device": device}),
        );

        let error = plan(&ir).expect_err("FFT backend/device mismatch must fail in the planner");
        assert!(error.reasons.iter().any(|reason| {
            reason.contains(&format!("fdm.demag.fft_backend='{backend}'"))
                && reason.contains("incompatible")
        }));
    }
}

#[test]
fn fdm_plan_materializes_frozen_spins_from_problem_ir() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.magnets[0].object_id = Some("strip-object".to_string());
    ir.magnetization_constraints
        .push(MagnetizationConstraintIR::FrozenSpins(FrozenSpinsIR {
            schema_version: FROZEN_SPINS_SCHEMA_VERSION.to_string(),
            id: "pin-strip".to_string(),
            name: "Pinned strip".to_string(),
            enabled: true,
            selector: SelectionExprIR::InObject {
                object_id: "strip-object".to_string(),
            },
            reference: FrozenReferencePolicyIR::CaptureCurrentAtActivation {},
            membership: SelectionMembershipPolicyIR::Static {},
            activation: ConstraintActivationIR::AllStages {},
            empty_selection: EmptySelectionPolicyIR::Error,
            inactive_selection: InactiveSelectionPolicyIR::WarnAndIntersect,
        }));

    let plan = plan(&ir).expect("canonical FDM lowering must materialize frozen spins");
    let BackendPlanIR::Fdm(fdm) = plan.backend_plan else {
        panic!("expected FDM plan");
    };
    let frozen = fdm
        .frozen_spins
        .expect("FDM plan must carry the resolved frozen-spin certificate");
    assert_eq!(frozen.constraint_ids, vec!["pin-strip"]);
    assert_eq!(frozen.frozen_mask.len(), fdm.initial_magnetization.len());
    assert_eq!(frozen.frozen_dof_count, frozen.active_dof_count);
    assert_eq!(frozen.free_dof_count, 0);
    assert!(frozen.all_active_dofs_frozen);
    assert_eq!(
        frozen.grid_or_mesh_fingerprint,
        fdm.grid_certificate
            .as_ref()
            .expect("FDM plan must carry grid certificate")
            .grid_fingerprint
    );
    assert!(frozen
        .certificate
        .warnings
        .iter()
        .any(|warning| warning.starts_with("frozen_reference_deferred:")));
}

#[test]
fn fdm_plan_preserves_signed_uniaxial_easy_plane_anisotropy() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.materials[0].uniaxial_anisotropy = Some(-0.5e6);

    let plan = plan(&ir).expect("signed Ku1 material must remain plannable");
    let BackendPlanIR::Fdm(fdm) = plan.backend_plan else {
        panic!("expected FDM plan");
    };
    assert_eq!(fdm.material.uniaxial_anisotropy_ku1, Some(-0.5e6));
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

fn default_test_object_region() -> fullmag_ir::ObjectRegionIR {
    fullmag_ir::ObjectRegionIR {
        region_id: "strip:core".to_string(),
        owner_object: "strip".to_string(),
        name: "core".to_string(),
        shape: fullmag_ir::RegionShapeIR::Cylinder {
            radius: 20e-9,
            height: 6e-9,
            center: [0.0, 0.0, 0.0],
            axis: [0.0, 0.0, 1.0],
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

fn test_box_region(
    region_id: &str,
    name: &str,
    center: [f64; 3],
    priority: i32,
) -> fullmag_ir::ObjectRegionIR {
    fullmag_ir::ObjectRegionIR {
        region_id: region_id.to_string(),
        owner_object: "strip".to_string(),
        name: name.to_string(),
        shape: fullmag_ir::RegionShapeIR::Box {
            size: [100e-9, 20e-9, 6e-9],
            center,
        },
        frame: fullmag_ir::RegionFrameIR::Object,
        enabled: true,
        priority,
        mesh_policy: None,
        material_overrides: Vec::new(),
        texture_override: None,
        material_transition: None,
        realization_policy: fullmag_ir::RegionRealizationPolicyIR::Inherit,
    }
}

#[test]
fn object_region_mesh_policy_blocks_until_runtime_materialization_exists() {
    let mut ir = ProblemIR::bootstrap_example();
    let mut region = default_test_object_region();
    region.mesh_policy = Some(fullmag_ir::RegionMeshPolicyIR {
        maximum_element_size: Some(1.0e-9),
        minimum_element_size: Some(0.5e-9),
        transition_distance: Some(20.0e-9),
        order: Some(1),
    });
    ir.object_regions.push(region);

    let err = plan(&ir).expect_err("region mesh policy must not be silently dropped");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("object region mesh_policy")
                && reason.contains("backend='fdm'")
                && reason.contains("must not silently ignore region mesh controls")
        }),
        "unexpected planner errors: {:?}",
        err.reasons
    );
}

#[test]
fn csg_region_mesh_policy_rejected_for_fem() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    let mut region = default_test_object_region();
    region.shape = fullmag_ir::RegionShapeIR::Csg {
        expression: std::boxed::Box::new(fullmag_ir::GeometryEntryIR::Box {
            name: "csg_part".to_string(),
            size: [10e-9, 10e-9, 6e-9],
        }),
    };
    region.mesh_policy = Some(fullmag_ir::RegionMeshPolicyIR {
        maximum_element_size: Some(1.0e-9),
        minimum_element_size: Some(0.5e-9),
        transition_distance: Some(20.0e-9),
        order: Some(1),
    });
    ir.object_regions.push(region);

    let err = plan(&ir).expect_err("CSG region mesh policy must be blocked for FEM");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("has CSG shape, which is not supported for mesh_policy")
                && reason.contains("CSG region mesh policies are not implemented")
        }),
        "unexpected planner errors: {:?}",
        err.reasons
    );
}

#[test]
fn unsupported_object_region_material_override_still_blocks_planning() {
    let mut ir = ProblemIR::bootstrap_example();
    let mut region = default_test_object_region();
    region.material_overrides = vec![fullmag_ir::RegionMaterialOverrideIR {
        parameter: fullmag_ir::MaterialParameterNameIR::Ku1,
        value: fullmag_ir::MaterialParameterFieldIR::Constant {
            value: serde_json::json!(5.0e4),
            unit: Some("J/m^3".to_string()),
        },
        priority: 10,
        conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
    }];
    ir.object_regions.push(region);

    let err = plan(&ir).expect_err("region material overrides must not be silently dropped");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("object region material_overrides")
                && reason.contains("backend='fdm'")
                && reason.contains("must not silently ignore region material overrides")
        }),
        "unexpected planner errors: {:?}",
        err.reasons
    );
}

#[test]
fn fdm_object_region_material_overrides_materialize_to_cell_fields() {
    let mut ir = ProblemIR::bootstrap_example();
    let mut region = default_test_object_region();
    region.material_overrides = vec![fullmag_ir::RegionMaterialOverrideIR {
        parameter: fullmag_ir::MaterialParameterNameIR::Ms,
        value: fullmag_ir::MaterialParameterFieldIR::Constant {
            value: serde_json::json!(750e3),
            unit: Some("A/m".to_string()),
        },
        priority: 10,
        conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
    }];
    let region_id = region.region_id.clone();
    ir.object_regions.push(region);

    let plan = plan(&ir).expect("FDM should materialize supported region material overrides");
    assert_eq!(plan.common.material_field_plans.len(), 1);
    assert_eq!(
        plan.common.material_field_plans[0].parameter,
        fullmag_ir::MaterialParameterNameIR::Ms
    );
    assert!(
        plan.common.material_field_plans[0].requires_sampling,
        "smooth region transition must require sampling even for constant overrides"
    );
    assert!(
        plan.common.material_field_plans[0].requires_mesh_revision,
        "mesh_relative region transition must depend on the mesh revision"
    );
    let fullmag_ir::BackendPlanIR::Fdm(fdm) = plan.backend_plan else {
        panic!("expected FDM plan");
    };
    let legend = &fdm
        .grid_certificate
        .as_ref()
        .expect("FDM plan should carry a grid certificate")
        .region_legend;
    assert!(
        fdm.grid_certificate
            .as_ref()
            .expect("FDM plan should carry a grid certificate")
            .object_ids
            .iter()
            .any(|object_id| object_id == &legend[0].object_id),
        "grid certificate must bind the realized single-grid object identity"
    );
    let round_tripped: fullmag_ir::FdmPlanIR =
        serde_json::from_value(serde_json::to_value(&fdm).expect("FDM plan should serialize"))
            .expect("FDM plan should deserialize");
    round_tripped
        .grid_certificate
        .as_ref()
        .expect("round-tripped plan should retain the grid certificate")
        .validate_against_masks(
            round_tripped.active_mask.as_deref(),
            &round_tripped.region_mask,
        )
        .expect("serialized execution-plan membership must retain its certificate identity");
    assert_eq!(legend.len(), 1);
    assert_eq!(legend[0].numeric_id, 1);
    assert_eq!(legend[0].region_id, region_id);
    assert!(fdm
        .grid_certificate
        .as_ref()
        .and_then(|certificate| certificate.region_legend_fingerprint.as_deref())
        .is_some_and(|value| value.starts_with("sha256:")));
    let ms_field = fdm
        .material
        .ms_field
        .expect("region Ms override must produce a non-uniform Ms field");
    assert!(
        ms_field.iter().any(|value| (*value - 750e3).abs() <= 1e-12),
        "region cells should receive the override value"
    );
    assert!(
        ms_field.iter().any(|value| (*value - 800e3).abs() <= 1e-12),
        "parent cells should keep the base material value"
    );
}

#[test]
fn fdm_cuda_region_material_fields_fail_in_planner_before_native_start() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda", "device_index": 0}),
    );
    let mut region = default_test_object_region();
    region.material_overrides = vec![fullmag_ir::RegionMaterialOverrideIR {
        parameter: fullmag_ir::MaterialParameterNameIR::Ms,
        value: fullmag_ir::MaterialParameterFieldIR::Constant {
            value: serde_json::json!(750e3),
            unit: Some("A/m".to_string()),
        },
        priority: 10,
        conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
    }];
    ir.object_regions.push(region);

    let error = plan(&ir).expect_err("CUDA region material fields must fail before native start");
    assert!(
        error.reasons.iter().any(|reason| {
            reason.contains("fdm_cuda_region_material_fields_unsupported")
                && reason.contains("cellwise material fields")
        }),
        "unexpected planner errors: {:?}",
        error.reasons
    );
}

#[test]
fn fdm_cuda_absorbing_boundary_fails_in_planner_before_native_start() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda", "device_index": 0}),
    );
    ir.magnets[0].absorbing_boundary = Some(fullmag_ir::AbsorbingBoundaryLayerIR {
        total_width_m: 4.0e-7,
        ramp_width_m: 3.0e-7,
        max_damping: 0.5,
        faces: vec![fullmag_ir::AbsorbingBoundaryFaceIR::XPlus],
        profile: fullmag_ir::AbsorbingBoundaryProfileIR::Smootherstep,
        frame: fullmag_ir::AbsorbingBoundaryFrameIR::Object,
    });

    let error = plan(&ir).expect_err("CUDA absorbing boundary must fail before native start");
    assert!(error.reasons.iter().any(|reason| {
        reason.contains("fdm_cuda_absorbing_boundary_unsupported")
            && reason.contains("cellwise damping fields")
    }));
}

#[test]
fn disabled_object_region_policies_do_not_block_executable_planning() {
    let mut ir = ProblemIR::bootstrap_example();
    let mut region = default_test_object_region();
    region.enabled = false;
    region.mesh_policy = Some(fullmag_ir::RegionMeshPolicyIR {
        maximum_element_size: Some(1.0e-9),
        minimum_element_size: Some(0.5e-9),
        transition_distance: Some(20.0e-9),
        order: Some(1),
    });
    region.material_overrides = vec![fullmag_ir::RegionMaterialOverrideIR {
        parameter: fullmag_ir::MaterialParameterNameIR::Ms,
        value: fullmag_ir::MaterialParameterFieldIR::Constant {
            value: serde_json::json!(750e3),
            unit: Some("A/m".to_string()),
        },
        priority: 10,
        conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
    }];
    region.realization_policy = fullmag_ir::RegionRealizationPolicyIR::Conformal;
    ir.object_regions.push(region);

    plan(&ir).expect("disabled object region policies must not affect executable planning");
}

#[test]
fn disabled_object_region_material_parameter_fields_do_not_block_planning() {
    let mut ir = ProblemIR::bootstrap_example();
    let mut region = default_test_object_region();
    region.enabled = false;
    ir.object_regions.push(region);
    ir.material_parameter_fields
        .push(fullmag_ir::MaterialParameterAssignmentIR {
            assignment_id: "disabled_region_ms".to_string(),
            owner_object: "strip".to_string(),
            region_id: Some("strip:core".to_string()),
            parameter: fullmag_ir::MaterialParameterNameIR::Ms,
            value: fullmag_ir::MaterialParameterFieldIR::Constant {
                value: serde_json::json!(750e3),
                unit: Some("A/m".to_string()),
            },
            priority: 10,
            conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
        });

    plan(&ir).expect("material fields scoped to disabled regions must be runtime-inert");
}

#[test]
fn fdm_region_texture_override_updates_initial_magnetization_inside_region_only() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.magnets[0].initial_magnetization = Some(InitialMagnetizationIR::Uniform {
        value: [1.0, 0.0, 0.0],
    });
    let mut region = fullmag_ir::ObjectRegionIR {
        shape: fullmag_ir::RegionShapeIR::Box {
            size: [100e-9, 20e-9, 6e-9],
            center: [-50e-9, 0.0, 0.0],
        },
        ..default_test_object_region()
    };
    region.texture_override = Some(fullmag_ir::RegionTextureOverrideIR {
        initial_magnetization: fullmag_ir::InitialMagnetizationIR::Uniform {
            value: [0.0, 0.0, 1.0],
        },
    });
    ir.object_regions.push(region);

    let plan = plan(&ir).expect("FDM should materialize region texture overrides");
    let fullmag_ir::BackendPlanIR::Fdm(fdm) = plan.backend_plan else {
        panic!("expected FDM plan");
    };

    let mut region_cells = 0usize;
    let mut base_cells = 0usize;
    for (index, region_index) in fdm.region_mask.iter().enumerate() {
        if *region_index == 1 {
            region_cells += 1;
            assert_eq!(fdm.initial_magnetization[index], [0.0, 0.0, 1.0]);
        } else {
            base_cells += 1;
            assert_eq!(fdm.initial_magnetization[index], [1.0, 0.0, 0.0]);
        }
    }
    assert!(
        region_cells > 0,
        "region should cover at least one FDM cell"
    );
    assert!(base_cells > 0, "region should not cover the whole FDM grid");
}

#[test]
fn disabled_fdm_region_does_not_materialize_mask_or_texture_override() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.magnets[0].initial_magnetization = Some(InitialMagnetizationIR::Uniform {
        value: [1.0, 0.0, 0.0],
    });
    let mut region = fullmag_ir::ObjectRegionIR {
        enabled: false,
        shape: fullmag_ir::RegionShapeIR::Box {
            size: [100e-9, 20e-9, 6e-9],
            center: [-50e-9, 0.0, 0.0],
        },
        ..default_test_object_region()
    };
    region.texture_override = Some(fullmag_ir::RegionTextureOverrideIR {
        initial_magnetization: fullmag_ir::InitialMagnetizationIR::Uniform {
            value: [0.0, 0.0, 1.0],
        },
    });
    ir.object_regions.push(region);

    let plan = plan(&ir).expect("disabled FDM region should be runtime-inert");
    let fullmag_ir::BackendPlanIR::Fdm(fdm) = plan.backend_plan else {
        panic!("expected FDM plan");
    };

    assert!(
        fdm.region_mask.iter().all(|region| *region == 0),
        "disabled region must not allocate a FDM region mask id"
    );
    assert!(
        fdm.initial_magnetization
            .iter()
            .all(|value| *value == [1.0, 0.0, 0.0]),
        "disabled region texture override must not modify initial magnetization"
    );
}

#[test]
fn fem_region_texture_override_materializes_on_selected_nodes_only() {
    let baseline_ir = fem_minimal_test_ir();
    let baseline_plan = plan(&baseline_ir).expect("baseline FEM plan should succeed");
    let fullmag_ir::BackendPlanIR::Fem(baseline_fem) = baseline_plan.backend_plan else {
        panic!("expected baseline FEM plan");
    };

    let mut ir = baseline_ir;
    let mut region = default_test_object_region();
    region.texture_override = Some(fullmag_ir::RegionTextureOverrideIR {
        initial_magnetization: fullmag_ir::InitialMagnetizationIR::Uniform {
            value: [0.0, 0.0, 1.0],
        },
    });
    ir.object_regions.push(region);

    let plan = plan(&ir).expect("FEM should materialize region texture overrides");
    let fullmag_ir::BackendPlanIR::Fem(fem) = plan.backend_plan else {
        panic!("expected FEM plan");
    };

    let changed_indices = fem
        .initial_magnetization
        .iter()
        .zip(&baseline_fem.initial_magnetization)
        .enumerate()
        .filter_map(|(index, (actual, baseline))| (actual != baseline).then_some(index))
        .collect::<Vec<_>>();
    assert_eq!(changed_indices, vec![0]);
    assert_eq!(fem.initial_magnetization[0], [0.0, 0.0, 1.0]);
    assert_eq!(
        &fem.initial_magnetization[1..],
        &baseline_fem.initial_magnetization[1..],
        "nodes outside the winning region must preserve the base texture"
    );
}

#[test]
fn object_region_explicit_realization_policy_blocks_until_runtime_materialization_exists() {
    let mut ir = ProblemIR::bootstrap_example();
    let mut region = default_test_object_region();
    region.realization_policy = fullmag_ir::RegionRealizationPolicyIR::Conformal;
    ir.object_regions.push(region);

    let err = plan(&ir).expect_err("region realization policy must not be silently pretended");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("object region realization_policy")
                && reason.contains("backend='fdm'")
                && reason.contains("must not silently pretend")
        }),
        "unexpected planner errors: {:?}",
        err.reasons
    );
}

#[test]
fn fdm_region_region_explicit_exchange_lowers_to_region_mask_and_pair_override() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda", "device_index": 0}),
    );
    ir.object_regions
        .push(test_box_region("strip:left", "left", [-50e-9, 0.0, 0.0], 1));
    ir.object_regions.push(test_box_region(
        "strip:right",
        "right",
        [50e-9, 0.0, 0.0],
        2,
    ));
    ir.couplings.push(CouplingIR {
        coupling_id: "left_right_exchange".to_string(),
        kind: CouplingKindIR::Exchange,
        source: CouplingEndpointIR::Region {
            object: "strip".to_string(),
            region_id: "strip:left".to_string(),
        },
        target: CouplingEndpointIR::Region {
            object: "strip".to_string(),
            region_id: "strip:right".to_string(),
        },
        enabled: true,
        parameters: CouplingParametersIR::Exchange {
            mode: ExchangeCouplingModeIR::Explicit,
            scale: None,
            inter_exchange: Some(4.0e-12),
        },
        capability_policy: CouplingCapabilityPolicyIR::RequireRuntime,
    });

    let plan = plan(&ir).expect("region-region explicit exchange should be executable for FDM");
    let fullmag_ir::BackendPlanIR::Fdm(fdm) = plan.backend_plan else {
        panic!("expected FDM plan");
    };
    assert!(fdm.region_mask.iter().any(|region| *region == 1));
    assert!(fdm.region_mask.iter().any(|region| *region == 2));
    assert_eq!(fdm.inter_region_exchange, vec![(1, 2, 4.0e-12)]);
}

#[test]
fn fdm_region_region_explicit_exchange_blocks_on_cpu_reference() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.object_regions
        .push(test_box_region("strip:left", "left", [-50e-9, 0.0, 0.0], 1));
    ir.object_regions.push(test_box_region(
        "strip:right",
        "right",
        [50e-9, 0.0, 0.0],
        2,
    ));
    ir.couplings.push(CouplingIR {
        coupling_id: "left_right_exchange".to_string(),
        kind: CouplingKindIR::Exchange,
        source: CouplingEndpointIR::Region {
            object: "strip".to_string(),
            region_id: "strip:left".to_string(),
        },
        target: CouplingEndpointIR::Region {
            object: "strip".to_string(),
            region_id: "strip:right".to_string(),
        },
        enabled: true,
        parameters: CouplingParametersIR::Exchange {
            mode: ExchangeCouplingModeIR::Explicit,
            scale: None,
            inter_exchange: Some(4.0e-12),
        },
        capability_policy: CouplingCapabilityPolicyIR::RequireRuntime,
    });

    let err = plan(&ir).expect_err("CPU reference must not ignore explicit region exchange");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("left_right_exchange")
                && reason.contains("requires runtime support")
                && reason.contains("must not silently drop authored coupling intent")
        }),
        "unexpected planner errors: {:?}",
        err.reasons
    );
}

#[test]
fn fdm_equal_priority_overlapping_regions_fail_closed_without_hidden_region_id_tie_break() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.object_regions.push(test_box_region(
        "strip:overlap_a",
        "overlap_a",
        [-50e-9, 0.0, 0.0],
        10,
    ));
    ir.object_regions.push(test_box_region(
        "strip:overlap_b",
        "overlap_b",
        [-50e-9, 0.0, 0.0],
        10,
    ));

    let err = plan(&ir).expect_err(
        "equal-priority overlapping regions must not be resolved by lexicographic region id",
    );
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("overlapping object regions")
                && reason.contains("strip:overlap_a")
                && reason.contains("strip:overlap_b")
                && reason.contains("equal priority")
        }),
        "unexpected planner errors: {:?}",
        err.reasons
    );
}

#[test]
fn intra_object_region_exchange_defaults_harmonic_mean() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.object_regions
        .push(test_box_region("strip:left", "left", [-50e-9, 0.0, 0.0], 1));
    ir.object_regions.push(test_box_region(
        "strip:right",
        "right",
        [50e-9, 0.0, 0.0],
        2,
    ));

    let plan = plan(&ir).expect("intra-object region exchange should plan for FDM");
    let fullmag_ir::BackendPlanIR::Fdm(fdm) = plan.backend_plan else {
        panic!("expected FDM plan");
    };
    assert!(fdm.region_mask.iter().any(|region| *region == 1));
    assert!(fdm.region_mask.iter().any(|region| *region == 2));
    assert!(
        fdm.inter_region_exchange.is_empty(),
        "FDM plan should carry no zero/free-surface override; native runtime resolves empty overrides with exchange_pair_default=HARMONIC_MEAN"
    );
}

#[test]
fn pure_inherited_region_preserves_parent_material_and_continuous_exchange() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.object_regions.push(default_test_object_region());

    let plan = plan(&ir).expect("pure inherited object region should remain plannable");
    let fullmag_ir::BackendPlanIR::Fdm(fdm) = plan.backend_plan else {
        panic!("expected FDM plan");
    };
    assert!(
        fdm.region_mask.iter().any(|region| *region == 1),
        "authored region may be materialized as a selector mask"
    );
    assert_eq!(
        fdm.inter_region_exchange,
        Vec::<(u32, u32, f64)>::new(),
        "a region that only inherits parent properties must not create an explicit free-surface or material-interface exchange override"
    );
    assert_eq!(
        fdm.material.exchange_stiffness, ir.materials[0].exchange_stiffness,
        "pure region must keep the parent exchange stiffness; continuity is resolved by the native harmonic default"
    );
    assert_eq!(
        fdm.material.saturation_magnetisation, ir.materials[0].saturation_magnetisation,
        "pure region must keep the parent saturation magnetization"
    );
}

#[test]
fn exchange_scale_zero_disables_interface_exchange() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda", "device_index": 0}),
    );
    ir.object_regions
        .push(test_box_region("strip:left", "left", [-50e-9, 0.0, 0.0], 1));
    ir.object_regions.push(test_box_region(
        "strip:right",
        "right",
        [50e-9, 0.0, 0.0],
        2,
    ));
    ir.couplings.push(CouplingIR {
        coupling_id: "left_right_disabled_exchange".to_string(),
        kind: CouplingKindIR::Exchange,
        source: CouplingEndpointIR::Region {
            object: "strip".to_string(),
            region_id: "strip:left".to_string(),
        },
        target: CouplingEndpointIR::Region {
            object: "strip".to_string(),
            region_id: "strip:right".to_string(),
        },
        enabled: true,
        parameters: CouplingParametersIR::Exchange {
            mode: ExchangeCouplingModeIR::Disabled,
            scale: Some(0.0),
            inter_exchange: None,
        },
        capability_policy: CouplingCapabilityPolicyIR::RequireRuntime,
    });

    let plan = plan(&ir).expect("disabled region exchange override should plan for FDM");
    let fullmag_ir::BackendPlanIR::Fdm(fdm) = plan.backend_plan else {
        panic!("expected FDM plan");
    };
    assert_eq!(fdm.inter_region_exchange, vec![(1, 2, 0.0)]);
}

#[test]
fn explicit_exchange_coupling_blocks_until_runtime_materialization_exists() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.couplings.push(CouplingIR {
        coupling_id: "strip_self_exchange".to_string(),
        kind: CouplingKindIR::Exchange,
        source: CouplingEndpointIR::Surface {
            object: "strip".to_string(),
            selector: "top".to_string(),
        },
        target: CouplingEndpointIR::Surface {
            object: "strip".to_string(),
            selector: "bottom".to_string(),
        },
        enabled: true,
        parameters: CouplingParametersIR::Exchange {
            mode: ExchangeCouplingModeIR::HarmonicMean,
            scale: Some(0.5),
            inter_exchange: None,
        },
        capability_policy: CouplingCapabilityPolicyIR::RequireRuntime,
    });

    let err = plan(&ir).expect_err("explicit coupling must not be silently dropped");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("strip_self_exchange")
                && reason.contains("requires runtime support")
                && reason.contains("must not silently drop authored coupling intent")
        }),
        "unexpected planner errors: {:?}",
        err.reasons
    );
}

#[test]
fn authored_only_coupling_blocks_strict_executable_planning() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.couplings.push(CouplingIR {
        coupling_id: "strip_authored_note".to_string(),
        kind: CouplingKindIR::Exchange,
        source: CouplingEndpointIR::Surface {
            object: "strip".to_string(),
            selector: "top".to_string(),
        },
        target: CouplingEndpointIR::Surface {
            object: "strip".to_string(),
            selector: "bottom".to_string(),
        },
        enabled: true,
        parameters: CouplingParametersIR::Exchange {
            mode: ExchangeCouplingModeIR::Disabled,
            scale: Some(0.0),
            inter_exchange: None,
        },
        capability_policy: CouplingCapabilityPolicyIR::AuthoredOnly,
    });

    let err = plan(&ir).expect_err("authored-only coupling must not enter executable planning");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("strip_authored_note")
                && reason.contains("authored_only")
                && reason.contains("strict executable planning")
        }),
        "unexpected planner errors: {:?}",
        err.reasons
    );
}

#[test]
fn disabled_coupling_does_not_block_executable_planning() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.couplings.push(CouplingIR {
        coupling_id: "strip_disabled_exchange".to_string(),
        kind: CouplingKindIR::Exchange,
        source: CouplingEndpointIR::Surface {
            object: "strip".to_string(),
            selector: "top".to_string(),
        },
        target: CouplingEndpointIR::Surface {
            object: "strip".to_string(),
            selector: "bottom".to_string(),
        },
        enabled: false,
        parameters: CouplingParametersIR::Exchange {
            mode: ExchangeCouplingModeIR::HarmonicMean,
            scale: Some(1.0),
            inter_exchange: None,
        },
        capability_policy: CouplingCapabilityPolicyIR::RequireRuntime,
    });

    plan(&ir).expect("disabled coupling must not affect executable planning");
}

#[test]
fn rkky_unsupported_blocks_runtime_plan() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.couplings.push(CouplingIR {
        coupling_id: "strip_rkky".to_string(),
        kind: CouplingKindIR::Rkky,
        source: CouplingEndpointIR::Surface {
            object: "strip".to_string(),
            selector: "top".to_string(),
        },
        target: CouplingEndpointIR::Surface {
            object: "strip".to_string(),
            selector: "bottom".to_string(),
        },
        enabled: true,
        parameters: CouplingParametersIR::Rkky { j1: -0.3e-3 },
        capability_policy: CouplingCapabilityPolicyIR::RequireRuntime,
    });

    let err = plan(&ir).expect_err("unsupported RKKY must block runtime planning");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("strip_rkky")
                && reason.contains("requires runtime support")
                && reason.contains("must not silently drop authored coupling intent")
        }),
        "unexpected planner errors: {:?}",
        err.reasons
    );
}

#[test]
fn interlayer_exchange_unsupported_blocks_runtime_plan_with_public_kind() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.couplings.push(CouplingIR {
        coupling_id: "strip_interlayer".to_string(),
        kind: CouplingKindIR::InterlayerExchange,
        source: CouplingEndpointIR::Surface {
            object: "strip".to_string(),
            selector: "top".to_string(),
        },
        target: CouplingEndpointIR::Surface {
            object: "strip".to_string(),
            selector: "bottom".to_string(),
        },
        enabled: true,
        parameters: CouplingParametersIR::InterlayerExchange {
            j1: -0.3e-3,
            j2: Some(0.0),
        },
        capability_policy: CouplingCapabilityPolicyIR::RequireRuntime,
    });

    let err = plan(&ir).expect_err("unsupported interlayer exchange must block runtime planning");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("strip_interlayer")
                && reason.contains("interlayer_exchange")
                && reason.contains("requires runtime support")
                && reason.contains("must not silently drop authored coupling intent")
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
            projection_policy: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
                element_markers: vec![1, 0],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [4, 5, 6]]),
                boundary_markers: vec![1, 99],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            object_region_markers: Vec::new(),
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
            stage_autosave: None,
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
            stage_autosave: None,
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
            stage_autosave: None,
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
            stage_autosave: None,
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
    assert!(err.reasons.iter().any(|reason| {
        reason.contains("field output 'u' requires the quasistatic/elastodynamic mechanics solver")
    }));
    assert!(err.reasons.iter().any(|reason| {
        reason.contains(
            "scalar output 'E_el' requires the quasistatic/elastodynamic mechanics solver",
        )
    }));
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
            projection_policy: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
                element_markers: vec![1, 0],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [4, 5, 6]]),
                boundary_markers: vec![1, 99],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            object_region_markers: Vec::new(),
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
            projection_policy: None,
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
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [1.0, 0.0, 0.0],
                    [1.0, 1.0, 0.0],
                    [1.0, 0.0, 1.0],
                    [-2.0, -2.0, -2.0],
                    [2.0, -2.0, -2.0],
                    [-2.0, 2.0, -2.0],
                    [-2.0, -2.0, 2.0],
                ],
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![
                    [0, 1, 2, 3],
                    [3, 5, 4, 0],
                    [6, 7, 8, 9],
                ]),
                element_markers: vec![1, 1, 0],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [3, 5, 4]]),
                boundary_markers: vec![10, 11],
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
                periodic_node_pairs: vec![
                    fullmag_ir::MeshPeriodicNodePairIR {
                        pair_id: "x_periodic".to_string(),
                        node_a: 0,
                        node_b: 3,
                    },
                    fullmag_ir::MeshPeriodicNodePairIR {
                        pair_id: "x_periodic".to_string(),
                        node_a: 1,
                        node_b: 4,
                    },
                    fullmag_ir::MeshPeriodicNodePairIR {
                        pair_id: "x_periodic".to_string(),
                        node_a: 2,
                        node_b: 5,
                    },
                ],
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            object_region_markers: Vec::new(),
            build_report: None,
        }),
    });
    if let Some(mesh) = ir
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .and_then(|asset| asset.mesh.as_mut())
    {
        complete_test_airbox_boundaries(mesh);
    }
    ir.energy_terms = vec![fullmag_ir::EnergyTermIR::Exchange];

    let err = plan(&ir)
        .expect_err("periodic FEM mesh pairs must not enable static PBC without ProblemIR.pbc");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("mesh.periodic_node_pairs require ProblemIR.pbc")
                && reason.contains("physical PBC intent")
        }),
        "unexpected missing-ProblemIR.pbc rejection reasons: {:?}",
        err.reasons
    );

    ir.pbc = Some(fullmag_ir::FdmPeriodicityIR {
        axes: [
            fullmag_ir::AxisBoundary::Periodic,
            fullmag_ir::AxisBoundary::Open,
            fullmag_ir::AxisBoundary::Open,
        ],
        demag: fullmag_ir::FdmDemagPeriodicityIR::Open,
        image_counts: None,
    });

    let planned = plan(&ir).expect("exchange-only FEM static PBC should plan");
    match planned.backend_plan {
        BackendPlanIR::Fem(fem) => {
            assert_eq!(fem.mesh.mesh_name, "periodic_strip");
            assert_eq!(fem.mesh.periodic_node_pairs.len(), 3);
            assert!(fem.enable_exchange);
            assert!(!fem.enable_demag);
        }
        other => panic!("expected FEM plan, got {:?}", other),
    }

    let mut z_pbc_with_x_mesh = ir.clone();
    z_pbc_with_x_mesh.pbc = Some(fullmag_ir::FdmPeriodicityIR {
        axes: [
            fullmag_ir::AxisBoundary::Open,
            fullmag_ir::AxisBoundary::Open,
            fullmag_ir::AxisBoundary::Periodic,
        ],
        demag: fullmag_ir::FdmDemagPeriodicityIR::Open,
        image_counts: None,
    });
    let err = plan(&z_pbc_with_x_mesh).expect_err(
        "FEM static PBC must reject meshes whose periodic axes do not match ProblemIR.pbc",
    );
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("mesh periodic axes")
                && reason.contains("ProblemIR.pbc axes")
                && reason.contains("z")
        }),
        "unexpected z-PBC axis mismatch rejection reasons: {:?}",
        err.reasons
    );

    let mut demag_ir = ir.clone();
    demag_ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::default(),
        },
    ];
    let sampling = match &mut demag_ir.study {
        fullmag_ir::StudyIR::TimeEvolution { sampling, .. }
        | fullmag_ir::StudyIR::Relaxation { sampling, .. }
        | fullmag_ir::StudyIR::Eigenmodes { sampling, .. }
        | fullmag_ir::StudyIR::FrequencyResponse { sampling, .. }
        | fullmag_ir::StudyIR::Hysteresis { sampling, .. } => sampling,
    };
    sampling.outputs.push(fullmag_ir::OutputIR::Field {
        name: "demag_phi".to_string(),
        every_seconds: 1.0e-13,
    });
    let err = plan(&demag_ir)
        .expect_err("periodic FEM static demag must require explicit periodic-airbox PBC");
    assert!(
        err.reasons
            .iter()
            .any(|reason| { reason.contains("ProblemIR.pbc.demag='periodic_airbox_k0'") }),
        "unexpected non-explicit demag PBC rejection reasons: {:?}",
        err.reasons
    );
    demag_ir
        .pbc
        .as_mut()
        .expect("demag fixture should carry PBC intent")
        .demag = fullmag_ir::FdmDemagPeriodicityIR::PeriodicAirboxK0;
    let demag_planned =
        plan(&demag_ir).expect("periodic FEM static demag with periodic-airbox PBC should plan");
    assert!(
        demag_planned.provenance.notes.iter().any(|note| note
            .contains("periodic mesh certificate: schema=periodic_mesh_certificate.v6")
            && note.contains("topology=sha256:")
            && note.contains("magnetic_classes=3")
            && note.contains("scalar_classes=3")),
        "periodic certificate identity was not preserved in planner provenance: {:?}",
        demag_planned.provenance.notes
    );
    match &demag_planned.backend_plan {
        BackendPlanIR::Fem(fem) => {
            assert!(fem.enable_demag);
            assert_eq!(fem.mesh.periodic_node_pairs.len(), 3);
            assert!(fem.air_box_config.is_some());
        }
        other => panic!("expected FEM plan, got {:?}", other),
    }

    let mut z_demag_ir = demag_ir.clone();
    z_demag_ir.pbc = Some(fullmag_ir::FdmPeriodicityIR {
        axes: [
            fullmag_ir::AxisBoundary::Open,
            fullmag_ir::AxisBoundary::Open,
            fullmag_ir::AxisBoundary::Periodic,
        ],
        demag: fullmag_ir::FdmDemagPeriodicityIR::PeriodicAirboxK0,
        image_counts: None,
    });
    let mesh = z_demag_ir
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .and_then(|asset| asset.mesh.as_mut())
        .expect("test problem should carry an inline FEM domain mesh");
    for point in &mut mesh.nodes {
        *point = [point[2], point[1], point[0]];
    }
    let mut elements = mesh.require_tet4_elements().unwrap();
    for element in &mut elements {
        element.swap(1, 2);
    }
    mesh.set_tet4_cells(elements);
    mesh.periodic_boundary_pairs = vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
        pair_id: "z_periodic".to_string(),
        source_marker: None,
        destination_marker: None,
        marker_a: 10,
        marker_b: 11,
        translation: Some([0.0, 0.0, 1.0]),
        tolerance: Some(1e-12),
        axis_hint: Some("z".to_string()),
        orientation: None,
        pairing_policy: None,
    }];
    mesh.periodic_node_pairs = vec![
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "z_periodic".to_string(),
            node_a: 0,
            node_b: 3,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "z_periodic".to_string(),
            node_a: 1,
            node_b: 4,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "z_periodic".to_string(),
            node_a: 2,
            node_b: 5,
        },
    ];
    let z_demag_planned =
        plan(&z_demag_ir).expect("single-axis z FEM demag PBC with open x/y airbox should plan");
    match z_demag_planned.backend_plan {
        BackendPlanIR::Fem(fem) => {
            assert!(fem.enable_demag);
            assert_eq!(fem.mesh.periodic_boundary_pairs.len(), 1);
            assert_eq!(fem.mesh.periodic_boundary_pairs[0].pair_id, "z_periodic");
            assert!(fem.air_box_config.is_some());
        }
        other => panic!("expected FEM plan, got {:?}", other),
    }

    let mut missing_boundary_pairs = demag_ir.clone();
    missing_boundary_pairs
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .and_then(|asset| asset.mesh.as_mut())
        .expect("test problem should carry an inline FEM domain mesh")
        .periodic_boundary_pairs
        .clear();
    let err = plan(&missing_boundary_pairs)
        .expect_err("periodic FEM demag without boundary-pair metadata should reject");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("mesh.periodic_boundary_pairs")
                || reason.contains("references unknown pair_id 'x_periodic'")
        }),
        "unexpected missing-boundary-pairs rejection reasons: {:?}",
        err.reasons
    );

    let mut missing_air = demag_ir.clone();
    let mesh = missing_air
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .and_then(|asset| asset.mesh.as_mut())
        .expect("test problem should carry an inline FEM domain mesh");
    mesh.element_markers = vec![1; mesh.cell_count()];
    let err = plan(&missing_air).expect_err("periodic FEM demag without air should reject");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("Shared-domain FEM") && reason.contains("no air region")
        }),
        "unexpected missing-air rejection reasons: {:?}",
        err.reasons
    );

    let mut fully_periodic = demag_ir.clone();
    let mesh = fully_periodic
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .and_then(|asset| asset.mesh.as_mut())
        .expect("test problem should carry an inline FEM domain mesh");
    fully_periodic.pbc = Some(fullmag_ir::FdmPeriodicityIR {
        axes: [
            fullmag_ir::AxisBoundary::Periodic,
            fullmag_ir::AxisBoundary::Periodic,
            fullmag_ir::AxisBoundary::Periodic,
        ],
        demag: fullmag_ir::FdmDemagPeriodicityIR::PeriodicAirboxK0,
        image_counts: None,
    });
    mesh.periodic_boundary_pairs.extend([
        fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "y_periodic".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 12,
            marker_b: 13,
            translation: Some([0.0, 1.0, 0.0]),
            tolerance: Some(1e-12),
            axis_hint: Some("y".to_string()),
            orientation: None,
            pairing_policy: None,
        },
        fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "z_periodic".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 14,
            marker_b: 15,
            translation: Some([0.0, 0.0, 1.0]),
            tolerance: Some(1e-12),
            axis_hint: Some("z".to_string()),
            orientation: None,
            pairing_policy: None,
        },
    ]);
    let err = plan(&fully_periodic).expect_err("fully periodic 3D FEM demag should reject");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("fully periodic 3D FEM demag")
                && reason.contains("at least one open axis")
        }),
        "unexpected fully-periodic rejection reasons: {:?}",
        err.reasons
    );
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
            projection_policy: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
                element_markers: vec![1, 0],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [4, 5, 6]]),
                boundary_markers: vec![1, 99],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            object_region_markers: Vec::new(),
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
            projection_policy: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
                element_markers: vec![1, 0],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [4, 5, 6]]),
                boundary_markers: vec![1, 99],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            object_region_markers: Vec::new(),
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

fn certified_airbox_test_mesh(outer_marker: u32) -> fullmag_ir::MeshIR {
    fullmag_ir::MeshIR {
        mesh_name: "strip".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 1.0],
        ],
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [1, 2, 3, 4]]),
        element_markers: vec![1, 0],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![
            [0, 1, 2],
            [0, 1, 3],
            [0, 2, 3],
            [1, 2, 4],
            [1, 3, 4],
            [2, 3, 4],
            [1, 2, 3],
        ]),
        boundary_markers: vec![1, 1, 1, outer_marker, outer_marker, outer_marker, 10],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    }
}

fn complete_test_airbox_boundaries(mesh: &mut fullmag_ir::MeshIR) {
    use std::collections::BTreeMap;

    let mut topology: BTreeMap<[u32; 3], Vec<bool>> = BTreeMap::new();
    for (index, element) in mesh.require_tet4_elements().unwrap().iter().enumerate() {
        let is_air = mesh.element_markers.get(index).copied().unwrap_or(1) == 0;
        for mut face in [
            [element[0], element[1], element[2]],
            [element[0], element[1], element[3]],
            [element[0], element[2], element[3]],
            [element[1], element[2], element[3]],
        ] {
            face.sort_unstable();
            topology.entry(face).or_default().push(is_air);
        }
    }
    let existing = mesh
        .require_tri3_boundary_faces()
        .unwrap()
        .iter()
        .map(|face| {
            let mut key = *face;
            key.sort_unstable();
            key
        })
        .collect::<std::collections::BTreeSet<_>>();
    let mut next_marker = mesh
        .boundary_markers
        .iter()
        .copied()
        .max()
        .unwrap_or(0)
        .saturating_add(1);
    let outer_marker = if mesh.boundary_markers.contains(&99) {
        99
    } else {
        let marker = next_marker;
        next_marker = next_marker.saturating_add(1);
        marker
    };
    let magnetic_marker = next_marker;
    next_marker = next_marker.saturating_add(1);
    let interface_marker = next_marker;
    for (face, adjacent) in topology {
        if existing.contains(&face) {
            continue;
        }
        let marker = match adjacent.as_slice() {
            [is_air] if *is_air => outer_marker,
            [is_air] if !*is_air => magnetic_marker,
            [first, second] if first != second => interface_marker,
            _ => continue,
        };
        mesh.push_tri3_facet(face).unwrap();
        mesh.boundary_markers.push(marker);
    }
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
            projection_policy: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
                element_markers: vec![1, 0],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [4, 5, 6]]),
                boundary_markers: vec![1, 99],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            object_region_markers: Vec::new(),
            build_report: None,
        }),
    });

    let mesh = ir
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .and_then(|asset| asset.mesh.as_mut())
        .expect("airbox fixture mesh");
    mesh.extend_tri3_facets([
        [0, 1, 3],
        [0, 2, 3],
        [1, 2, 3],
        [4, 5, 7],
        [4, 6, 7],
        [5, 6, 7],
    ])
    .unwrap();
    mesh.boundary_markers.extend([1, 1, 1, 99, 99, 99]);
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

/// A complete airbox certifies the outer marker independently of its numeric ID.
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
            projection_policy: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
                element_markers: vec![1, 0],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [4, 5, 6]]),
                boundary_markers: vec![1, 99],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            object_region_markers: Vec::new(),
            build_report: None,
        }),
    });

    let mesh = ir
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .and_then(|asset| asset.mesh.as_mut())
        .expect("airbox fixture mesh");
    mesh.extend_tri3_facets([
        [0, 1, 3],
        [0, 2, 3],
        [1, 2, 3],
        [4, 5, 7],
        [4, 6, 7],
        [5, 6, 7],
    ])
    .unwrap();
    mesh.boundary_markers.extend([1, 1, 1, 99, 99, 99]);
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
        Some("certified_gamma_out")
    );
}

/// An un-certified marker must be rejected even when the mesh contains air.
#[test]
fn fem_backend_with_air_elements_rejects_unknown_boundary_marker_in_strict_mode() {
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
            projection_policy: None,
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
            mesh: Some(certified_airbox_test_mesh(42)),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            object_region_markers: Vec::new(),
            build_report: None,
        }),
    });

    let error = plan(&ir).expect_err(
        "strict FEM air-box planning should reject when marker 99 is absent and no explicit boundary_marker",
    );
    assert!(error
        .reasons
        .iter()
        .any(|reason| reason.contains("Gamma_out") || reason.contains("certified")));
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
            projection_policy: None,
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
                    [-2.0, -2.0, -2.0],
                    [2.0, -2.0, -2.0],
                    [-2.0, 2.0, -2.0],
                    [-2.0, -2.0, 2.0],
                ],
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
                element_markers: vec![1, 0],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [4, 5, 6]]),
                boundary_markers: vec![10, 99],
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
            projection_policy: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                element_markers: vec![1],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![
                    [0, 2, 1],
                    [0, 1, 3],
                    [0, 3, 2],
                    [1, 2, 3],
                ]),
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
            projection_policy: None,
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
                    [-2.0, -2.0, -2.0],
                    [2.0, -2.0, -2.0],
                    [-2.0, 2.0, -2.0],
                    [-2.0, -2.0, 2.0],
                ],
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
                element_markers: vec![1, 0],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [4, 5, 6]]),
                boundary_markers: vec![10, 99],
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
            projection_policy: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                element_markers: vec![1],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
            projection_policy: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                element_markers: vec![1],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
            projection_policy: None,
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
            assert_eq!(fem.mesh.cell_count(), 1);
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
            projection_policy: None,
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
            object_id: None,
            name: "free".to_string(),
            region: "free".to_string(),
            material: "Py".to_string(),
            initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                value: [1.0, 0.0, 0.0],
            }),
            absorbing_boundary: None,
        },
        fullmag_ir::MagnetIR {
            object_id: None,
            name: "ref".to_string(),
            region: "ref".to_string(),
            material: "Py".to_string(),
            initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                value: [0.0, 1.0, 0.0],
            }),
            absorbing_boundary: None,
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
                    cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                    element_markers: vec![1],
                    facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
                    cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                    element_markers: vec![1],
                    facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
            assert_eq!(fem.mesh.cell_count(), 2);
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
fn fem_backend_multibody_rejects_incompatible_cubic_anisotropy_axes() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.materials[0].cubic_anisotropy_kc1 = Some(1.0e5);
    ir.materials[0].cubic_anisotropy_axis1 = Some([1.0, 0.0, 0.0]);
    ir.materials[0].cubic_anisotropy_axis2 = Some([0.0, 1.0, 0.0]);
    ir.materials.push(fullmag_ir::MaterialIR {
        name: "Co".to_string(),
        saturation_magnetisation: 1.1e6,
        exchange_stiffness: 20e-12,
        damping: 0.02,
        uniaxial_anisotropy: None,
        anisotropy_axis: None,
        uniaxial_anisotropy_k2: None,
        cubic_anisotropy_kc1: Some(1.0e5),
        cubic_anisotropy_kc2: None,
        cubic_anisotropy_kc3: None,
        cubic_anisotropy_axis1: Some([0.0, 1.0, 0.0]),
        cubic_anisotropy_axis2: Some([1.0, 0.0, 0.0]),
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
        object_id: None,
        name: "second".to_string(),
        region: "second".to_string(),
        material: "Co".to_string(),
        initial_magnetization: Some(InitialMagnetizationIR::Uniform {
            value: [0.0, 1.0, 0.0],
        }),
        absorbing_boundary: None,
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
                    cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                    element_markers: vec![1],
                    facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
                    cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                    element_markers: vec![1],
                    facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
                    boundary_markers: vec![1],
                    periodic_boundary_pairs: Vec::new(),
                    periodic_node_pairs: Vec::new(),
                    per_domain_quality: std::collections::HashMap::new(),
                }),
            },
        ],
        fem_domain_mesh_asset: None,
    });

    let error = plan(&ir).expect_err(
        "multi-body FEM must reject cubic anisotropy with incompatible crystallographic axes",
    );
    assert!(error
        .reasons
        .iter()
        .any(|reason| reason.contains("shared anisotropy axes/material-law shape")));
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                element_markers: vec![1],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
        object_id: None,
        name: "second".to_string(),
        region: "second".to_string(),
        material: "Co".to_string(),
        initial_magnetization: Some(InitialMagnetizationIR::Uniform {
            value: [0.0, 1.0, 0.0],
        }),
        absorbing_boundary: None,
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
                    cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                    element_markers: vec![1],
                    facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
                    cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                    element_markers: vec![1],
                    facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
fn fem_plan_promotes_active_anisotropy_axis_material_for_heterogeneous_regions() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda", "device_index": 0}),
    );
    ir.materials[0].uniaxial_anisotropy = Some(0.0);
    ir.materials[0].anisotropy_axis = Some([0.0, 1.0, 0.0]);
    ir.materials.push(fullmag_ir::MaterialIR {
        name: "CoFeB".to_string(),
        saturation_magnetisation: 1.1e6,
        exchange_stiffness: 15e-12,
        damping: 0.1,
        uniaxial_anisotropy: Some(1.0e6),
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
        interfacial_dmi: None,
        bulk_dmi: None,
        dind_field: None,
        dbulk_field: None,
    });
    ir.geometry.entries.push(GeometryEntryIR::Box {
        name: "cofeb_top_ring".to_string(),
        size: [1.0, 1.0, 1.0],
    });
    ir.regions.push(fullmag_ir::RegionIR {
        name: "cofeb_top_ring".to_string(),
        geometry: "cofeb_top_ring".to_string(),
    });
    ir.magnets.push(fullmag_ir::MagnetIR {
        object_id: None,
        name: "cofeb_top_ring".to_string(),
        region: "cofeb_top_ring".to_string(),
        material: "CoFeB".to_string(),
        initial_magnetization: Some(InitialMagnetizationIR::Uniform {
            value: [0.0, 1.0, 0.0],
        }),
        absorbing_boundary: None,
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
                    cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                    element_markers: vec![1],
                    facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
                    boundary_markers: vec![1],
                    periodic_boundary_pairs: Vec::new(),
                    periodic_node_pairs: Vec::new(),
                    per_domain_quality: std::collections::HashMap::new(),
                }),
            },
            fullmag_ir::FemMeshAssetIR {
                geometry_name: "cofeb_top_ring".to_string(),
                mesh_source: None,
                mesh: Some(fullmag_ir::MeshIR {
                    mesh_name: "cofeb_top_ring".to_string(),
                    nodes: vec![
                        [0.0, 0.0, 2.0],
                        [1.0, 0.0, 2.0],
                        [0.0, 1.0, 2.0],
                        [0.0, 0.0, 3.0],
                    ],
                    cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                    element_markers: vec![1],
                    facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
                    boundary_markers: vec![1],
                    periodic_boundary_pairs: Vec::new(),
                    periodic_node_pairs: Vec::new(),
                    per_domain_quality: std::collections::HashMap::new(),
                }),
            },
        ],
        fem_domain_mesh_asset: None,
    });

    let planned = plan(&ir).expect(
        "active anisotropy in a later region must not be blocked by an inactive first material",
    );
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("expected FEM plan");
    };

    assert_eq!(fem.region_materials.len(), 2);
    assert_eq!(fem.region_materials[0].object_id, "strip");
    assert_eq!(fem.region_materials[1].object_id, "cofeb_top_ring");
    assert!(fem.material.ms_field.is_some());
    assert!(fem.material.a_field.is_some());
    assert!(fem.material.alpha_field.is_some());
    assert_eq!(fem.material.anisotropy_axis, Some([0.0, 0.0, 1.0]));
    assert_eq!(
        fem.anisotropy_axis_field
            .as_ref()
            .map(|values| values.as_slice()),
        Some(
            [
                [0.0, 1.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [0.0, 0.0, 1.0],
                [0.0, 0.0, 1.0],
                [0.0, 0.0, 1.0],
            ]
            .as_slice(),
        )
    );
    assert_eq!(
        fem.material
            .ku_field
            .as_ref()
            .map(|values| values.as_slice()),
        Some([0.0, 0.0, 0.0, 0.0, 1.0e6, 1.0e6, 1.0e6, 1.0e6].as_slice())
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
        object_id: None,
        name: "second".to_string(),
        region: "second".to_string(),
        material: "Py".to_string(),
        initial_magnetization: Some(InitialMagnetizationIR::Uniform {
            value: [0.0, 1.0, 0.0],
        }),
        absorbing_boundary: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [0, 2, 1, 4]]),
                element_markers: vec![1, 2],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 3], [0, 1, 4]]),
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
            object_region_markers: Vec::new(),
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
            object_id: None,
            name: magnet_name.clone(),
            region: magnet_name.clone(),
            material: "Py".to_string(),
            initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                value: [0.0, 0.0, 1.0],
            }),
            absorbing_boundary: None,
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
        [0, 7, 8, 2],
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(elements),
                element_markers,
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
            object_region_markers: Vec::new(),
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
            stage_autosave: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                element_markers: vec![1],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
                boundary_markers: vec![1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            object_region_markers: Vec::new(),
            build_report: None,
        }),
    });
}

#[test]
fn fem_exchange_stiffness_rejects_unsafe_fixed_step_in_strict_mode() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    attach_unit_fem_domain_mesh(&mut ir);
    let mesh = ir
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .and_then(|asset| asset.mesh.as_mut())
        .expect("unit FEM domain mesh");
    for node in &mut mesh.nodes {
        for coordinate in node {
            *coordinate *= 1.0e-9;
        }
    }
    if let fullmag_ir::StudyIR::TimeEvolution {
        dynamics: fullmag_ir::DynamicsIR::Llg { fixed_timestep, .. },
        ..
    } = &mut ir.study
    {
        *fixed_timestep = Some(1.0e-12);
    } else {
        panic!("bootstrap example must use LLG time evolution");
    }

    let error = plan(&ir).expect_err("strict FEM planning must reject an unsafe fixed step");
    assert!(error.reasons.iter().any(|reason| {
        reason.contains("FEM-CPU-NUM-002")
            && reason.contains("exceeds conservative exchange limit")
            && reason.contains("execution_mode='strict'")
    }));
}

#[test]
fn fem_exchange_stiffness_warns_for_unsafe_fixed_step_in_extended_mode() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Extended;
    attach_unit_fem_domain_mesh(&mut ir);
    let mesh = ir
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .and_then(|asset| asset.mesh.as_mut())
        .expect("unit FEM domain mesh");
    for node in &mut mesh.nodes {
        for coordinate in node {
            *coordinate *= 1.0e-9;
        }
    }
    if let fullmag_ir::StudyIR::TimeEvolution {
        dynamics: fullmag_ir::DynamicsIR::Llg { fixed_timestep, .. },
        ..
    } = &mut ir.study
    {
        *fixed_timestep = Some(1.0e-12);
    } else {
        panic!("bootstrap example must use LLG time evolution");
    }

    let planned = plan(&ir).expect("extended FEM planning should retain an explicit warning");
    assert!(planned.provenance.notes.iter().any(|note| {
        note.contains("FEM-CPU-NUM-002 stiffness warning")
            && note.contains("admitted only in execution_mode='extended'")
    }));
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
            stage_autosave: None,
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
            stage_autosave: None,
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
            stage_autosave: None,
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
        dynamics: Some(ir.study.dynamics().clone()),
        stop: fullmag_ir::RelaxStopIR {
            torque_tolerance_apm: Some(1e-3),
            energy_tolerance_j: Some(1e-12),
            max_steps: Some(250),
            max_relaxation_time_s: None,
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

fn fem_demag_relaxation_policy_ir(algorithm: fullmag_ir::RelaxationAlgorithmIR) -> ProblemIR {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Extended;
    attach_unit_fem_domain_mesh(&mut ir);
    ir.energy_terms.push(fullmag_ir::EnergyTermIR::Demag {
        realization: fullmag_ir::RequestedFemDemagIR::FredkinKoehler,
    });
    ir.study = fullmag_ir::StudyIR::Relaxation {
        algorithm,
        dynamics: (algorithm == fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped)
            .then(|| ir.study.dynamics().clone()),
        stop: fullmag_ir::RelaxStopIR {
            torque_tolerance_apm: Some(1e-3),
            energy_tolerance_j: None,
            max_steps: Some(10),
            max_relaxation_time_s: None,
        },
        sampling: ir.study.sampling().clone(),
    };
    ir
}

#[test]
fn fem_demag_direct_minimizer_resolves_missing_solver_policy_to_armijo_accuracy() {
    for algorithm in [
        fullmag_ir::RelaxationAlgorithmIR::NonlinearCg,
        fullmag_ir::RelaxationAlgorithmIR::TangentPlaneImplicit,
    ] {
        let planned = plan(&fem_demag_relaxation_policy_ir(algorithm))
            .expect("missing FEM demag policy must resolve for a direct minimizer");
        let BackendPlanIR::Fem(fem) = planned.backend_plan else {
            panic!("expected FEM plan");
        };
        let policy = fem
            .demag_solver_policy
            .expect("direct minimizer must carry its resolved demag policy");
        assert_eq!(policy.rtol, 1.0e-12, "algorithm={algorithm:?}");
        assert!(planned.provenance.notes.iter().any(|note| {
            note.contains("requested=default") && note.contains("resolved_rtol=1.000000e-12")
        }));
    }
}

#[test]
fn fem_demag_projected_gradient_bb_resolves_strict_armijo_policy() {
    let planned = plan(&fem_demag_relaxation_policy_ir(
        fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
    ))
    .expect("FEM PG-BB with qualified demag must plan successfully");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("expected FEM plan");
    };
    assert_eq!(
        fem.demag_solver_policy.expect("resolved demag policy").rtol,
        1.0e-12
    );
    assert!(planned.provenance.notes.iter().any(|note| {
        note.contains("projected_gradient_bb") && note.contains("resolved_rtol=1.000000e-12")
    }));
}

#[test]
fn fem_demag_direct_minimizer_rejects_explicit_solver_policy_too_loose_for_armijo() {
    let mut ir = fem_demag_relaxation_policy_ir(fullmag_ir::RelaxationAlgorithmIR::NonlinearCg);
    ir.backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fem.as_mut())
        .expect("FEM hints")
        .demag_solver_policy = Some(fullmag_ir::FemLinearSolverPolicy {
        rtol: 1.0e-8,
        ..Default::default()
    });

    let error = plan(&ir).expect_err("loose explicit demag policy must fail before runtime");
    assert!(error.reasons.iter().any(|reason| {
        reason.contains("nonlinear_cg")
            && reason.contains("demag_solver_policy.rtol")
            && reason.contains("1e-12")
            && reason.contains("strict Armijo")
    }));
}

#[test]
fn fem_demag_llg_keeps_global_missing_and_explicit_solver_policy_semantics() {
    let missing = plan(&fem_demag_relaxation_policy_ir(
        fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped,
    ))
    .expect("LLG FEM demag default remains valid");
    let BackendPlanIR::Fem(missing_fem) = missing.backend_plan else {
        panic!("expected FEM plan");
    };
    assert!(missing_fem.demag_solver_policy.is_none());

    let mut explicit_ir =
        fem_demag_relaxation_policy_ir(fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped);
    explicit_ir
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fem.as_mut())
        .expect("FEM hints")
        .demag_solver_policy = Some(fullmag_ir::FemLinearSolverPolicy::default());
    let explicit = plan(&explicit_ir).expect("explicit global LLG demag policy remains valid");
    let BackendPlanIR::Fem(explicit_fem) = explicit.backend_plan else {
        panic!("expected FEM plan");
    };
    assert_eq!(
        explicit_fem
            .demag_solver_policy
            .expect("explicit policy")
            .rtol,
        1.0e-8
    );
}

#[test]
fn projected_gradient_bb_is_now_plannable() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = fullmag_ir::StudyIR::Relaxation {
        algorithm: fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
        dynamics: None,
        stop: fullmag_ir::RelaxStopIR {
            torque_tolerance_apm: Some(1e-3),
            energy_tolerance_j: None,
            max_steps: Some(250),
            max_relaxation_time_s: None,
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
        dynamics: None,
        stop: fullmag_ir::RelaxStopIR {
            torque_tolerance_apm: Some(1e-3),
            energy_tolerance_j: None,
            max_steps: Some(250),
            max_relaxation_time_s: None,
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
fn direct_minimizer_rejects_relaxation_time_stop_budget() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = fullmag_ir::StudyIR::Relaxation {
        algorithm: fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
        dynamics: None,
        stop: fullmag_ir::RelaxStopIR {
            torque_tolerance_apm: Some(1e-3),
            energy_tolerance_j: None,
            max_steps: Some(250),
            max_relaxation_time_s: Some(1e-9),
        },
        sampling: ir.study.sampling().clone(),
    };

    let err = plan(&ir).expect_err("direct minimizers do not advance physical time");
    assert!(err.reasons.iter().any(|reason| {
        reason.contains("projected_gradient_bb")
            && reason.contains("direct minimizer")
            && reason.contains("max_relaxation_time_s")
    }));
}

#[test]
fn direct_minimizer_rejects_dynamics_and_relaxation_time() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = fullmag_ir::StudyIR::Relaxation {
        algorithm: fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
        dynamics: Some(ir.study.dynamics().clone()),
        stop: fullmag_ir::RelaxStopIR {
            torque_tolerance_apm: Some(1e-3),
            energy_tolerance_j: None,
            max_steps: Some(250),
            max_relaxation_time_s: Some(1e-9),
        },
        sampling: ir.study.sampling().clone(),
    };

    let err = plan(&ir).expect_err("direct minimizers reject LLG dynamics and time budgets");
    assert!(
        err.reasons
            .iter()
            .any(|reason| reason.contains("dynamics") && reason.contains("direct minimizer")),
        "missing direct-minimizer dynamics rejection: {:?}",
        err.reasons
    );
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("max_relaxation_time_s") && reason.contains("direct minimizer")
        }),
        "missing direct-minimizer relaxation-time rejection: {:?}",
        err.reasons
    );
}

#[test]
fn direct_minimizer_resolves_no_integrator() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = fullmag_ir::StudyIR::Relaxation {
        algorithm: fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
        dynamics: None,
        stop: fullmag_ir::RelaxStopIR {
            torque_tolerance_apm: Some(1e-3),
            energy_tolerance_j: None,
            max_steps: Some(250),
            max_relaxation_time_s: None,
        },
        sampling: ir.study.sampling().clone(),
    };

    let mut errors = Vec::new();
    let planned = validate::planned_study_controls(&ir, BackendTarget::Fdm, &mut errors);
    assert!(errors.is_empty(), "unexpected planner errors: {errors:?}");
    assert_eq!(planned.integrator, None);
    assert_eq!(planned.fixed_timestep, None);
    assert_eq!(planned.adaptive_timestep, None);
}

#[test]
fn direct_minimizer_final_plan_has_no_integrator() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = fullmag_ir::StudyIR::Relaxation {
        algorithm: fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
        dynamics: None,
        stop: fullmag_ir::RelaxStopIR {
            torque_tolerance_apm: Some(1e-3),
            energy_tolerance_j: None,
            max_steps: Some(250),
            max_relaxation_time_s: None,
        },
        sampling: ir.study.sampling().clone(),
    };

    let planned = plan(&ir).expect("direct minimizer should plan");
    let BackendPlanIR::Fdm(fdm) = planned.backend_plan else {
        panic!("expected FDM plan");
    };
    let serialized = serde_json::to_value(fdm).expect("FDM plan should serialize");
    assert!(
        serialized
            .get("integrator")
            .is_none_or(serde_json::Value::is_null),
        "direct-minimizer final plans must not manufacture an integrator: {serialized}"
    );
}

#[test]
fn relaxation_rejects_zhang_li_slonczewski_sot_and_thermal() {
    let relaxation = |ir: &mut ProblemIR| {
        ir.study = fullmag_ir::StudyIR::Relaxation {
            algorithm: fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped,
            dynamics: Some(ir.study.dynamics().clone()),
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1e-3),
                energy_tolerance_j: None,
                max_steps: Some(250),
                max_relaxation_time_s: None,
            },
            sampling: ir.study.sampling().clone(),
        };
    };

    let cases = vec![
        (
            fullmag_ir::SpinTorqueModuleIR::ZhangLi {
                schema_version: None,
                id: None,
                target: None,
                formula_version: "zhang_li.legacy_fullmag.v0".to_string(),
                operator_version: None,
                current_density: Some([1e10, 0.0, 0.0]),
                current_source: None,
                degree: 0.5,
                beta: 0.1,
                lande_g: None,
            },
            "zhang_li",
        ),
        (
            fullmag_ir::SpinTorqueModuleIR::Slonczewski {
                schema_version: None,
                id: None,
                target: None,
                formula_version: "slonczewski.legacy_fullmag.v0".to_string(),
                current_density: Some([0.0, 0.0, 1e10]),
                current_source: None,
                degree: 0.5,
                spin_polarization: [0.0, 0.0, 1.0],
                stack_normal: None,
                lambda_asymmetry: 1.0,
                epsilon_prime: 0.0,
                free_layer_thickness_m: Some(1e-9),
                fixed_layer_position: Some("top".to_string()),
                realization: None,
            },
            "slonczewski",
        ),
        (
            fullmag_ir::SpinTorqueModuleIR::PrescribedSot {
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
            },
            "prescribed_sot",
        ),
    ];
    for (module, expected) in cases {
        let mut ir = ProblemIR::bootstrap_example();
        relaxation(&mut ir);
        ir.spin_torque_modules = vec![module];
        let err = plan(&ir).expect_err("direct torque must be rejected during relaxation");
        assert!(
            err.reasons
                .iter()
                .any(|reason| reason.contains(expected)
                    && reason.contains("conservative equilibrium")),
            "missing {expected} relaxation diagnostic: {:?}",
            err.reasons
        );
    }

    let mut thermal = ProblemIR::bootstrap_example();
    relaxation(&mut thermal);
    thermal.temperature = Some(300.0);
    let err = plan(&thermal).expect_err("thermal relaxation must be rejected");
    assert!(err.reasons.iter().any(|reason| {
        reason.contains("thermal noise") && reason.contains("conservative equilibrium")
    }));
}

#[test]
fn fem_canonical_zhang_li_plan_preserves_identity_and_target_masks() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    attach_unit_fem_domain_mesh(&mut ir);
    ir.spin_torque_modules = vec![fullmag_ir::SpinTorqueModuleIR::ZhangLi {
        schema_version: Some("zhang_li_torque.v1".to_string()),
        id: Some("cip".to_string()),
        target: Some(fullmag_ir::RegionRefIR {
            object_id: "strip".to_string(),
            region_id: None,
        }),
        formula_version: "zhang_li.fullmag.v1".to_string(),
        operator_version: Some("zl_central_reference_v1".to_string()),
        current_density: Some([-1e11, 0.0, 0.0]),
        current_source: None,
        degree: 0.4,
        beta: 0.02,
        lande_g: Some(1.9),
    }];

    let planned = plan(&ir).expect("canonical FEM Zhang-Li should plan");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("expected FEM plan");
    };
    let contract = fem
        .spin_torque_contract
        .expect("versioned FEM STT contract");
    assert_eq!(contract.formula_version, "zhang_li.fullmag.v1");
    assert_eq!(
        contract.operator_version.as_deref(),
        Some("zl_central_reference_v1")
    );
    assert_eq!(contract.lande_g, Some(1.9));
    assert_eq!(
        contract
            .target
            .as_ref()
            .map(|target| target.object_id.as_str()),
        Some("strip")
    );
    assert!(contract
        .active_node_mask
        .as_ref()
        .is_some_and(|mask| !mask.is_empty() && mask.iter().all(|selected| *selected)));
    assert!(contract
        .active_element_mask
        .as_ref()
        .is_some_and(|mask| !mask.is_empty() && mask.iter().all(|selected| *selected)));
}

#[test]
fn fem_prescribed_sot_gpu_plan_materializes_constant_envelope() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    attach_unit_fem_domain_mesh(&mut ir);
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda", "device_index": 0}),
    );
    ir.spin_torque_modules = vec![fullmag_ir::SpinTorqueModuleIR::PrescribedSot {
        schema_version: "prescribed_sot.v1".to_string(),
        id: "sot_gpu".to_string(),
        target: Some(fullmag_ir::RegionRefIR {
            object_id: "strip".to_string(),
            region_id: None,
        }),
        formula: fullmag_ir::PrescribedSotFormulaIR::FullmagV1 {
            drive: fullmag_ir::PrescribedSotV1DriveIR::SignedScalar {
                current_density_apm2: 1.0e11,
                sigma_hat: [0.0, 1.0, 0.0],
                envelope: None,
            },
            xi_dl: 0.12,
            xi_fl: -0.02,
            free_layer_thickness_m: 1.5e-9,
        },
    }];

    let planned = crate::fem::plan_fem(&ir, BackendTarget::Fem)
        .expect("FEM GPU prescribed SOT should use the qualified native reference slice");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("expected FEM plan");
    };
    let contract = fem
        .spin_torque_contract
        .expect("versioned FEM GPU SOT contract");
    assert_eq!(contract.formula_version, "prescribed_sot.fullmag.v1");
    assert_eq!(
        contract.sot_envelope, None,
        "an omitted envelope is the canonical unit constant"
    );
}

#[test]
fn fem_stage_time_prescribed_sot_plans_and_fdm_rejects_it() {
    let mut fem_ir = ProblemIR::bootstrap_example();
    fem_ir.backend_policy.requested_backend = BackendTarget::Fem;
    attach_unit_fem_domain_mesh(&mut fem_ir);
    fem_ir.spin_torque_modules = vec![fullmag_ir::SpinTorqueModuleIR::PrescribedSot {
        schema_version: "prescribed_sot.v1".to_string(),
        id: "sot_stage".to_string(),
        target: Some(fullmag_ir::RegionRefIR {
            object_id: "strip".to_string(),
            region_id: None,
        }),
        formula: fullmag_ir::PrescribedSotFormulaIR::FullmagV1 {
            drive: fullmag_ir::PrescribedSotV1DriveIR::SignedScalar {
                current_density_apm2: 1.0e11,
                sigma_hat: [0.0, 1.0, 0.0],
                envelope: Some(fullmag_ir::TimeEnvelopeIR::Sinusoidal {
                    amplitude: 0.5,
                    frequency_hz: 1.0e12,
                    phase_rad: 0.0,
                    offset: 1.0,
                }),
            },
            xi_dl: 0.12,
            xi_fl: -0.02,
            free_layer_thickness_m: 1.5e-9,
        },
    }];

    let planned = crate::fem::plan_fem(&fem_ir, BackendTarget::Fem)
        .expect("FEM should admit the bounded stage-time SOT descriptor");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("expected FEM plan");
    };
    assert!(matches!(
        fem.spin_torque_contract
            .and_then(|contract| contract.sot_envelope),
        Some(fullmag_ir::TimeEnvelopeIR::Sinusoidal { .. })
    ));

    let mut fdm_ir = fem_ir;
    fdm_ir.backend_policy.requested_backend = BackendTarget::Fdm;
    let error = plan(&fdm_ir).expect_err("FDM must remain fail-closed for stage-time SOT");
    assert!(
        error.reasons.iter().any(|reason| {
            reason.contains("non-constant TimeEnvelope") && reason.contains("stage_time_execution")
        }),
        "unexpected FDM stage-time SOT reasons: {:?}",
        error.reasons
    );
}

#[test]
fn fem_prescribed_sot_cpu_plan_materializes_signed_fields_and_target_mask() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    attach_unit_fem_domain_mesh(&mut ir);
    ir.spin_torque_modules = vec![fullmag_ir::SpinTorqueModuleIR::PrescribedSot {
        schema_version: "prescribed_sot.v1".to_string(),
        id: "sot_cpu".to_string(),
        target: Some(fullmag_ir::RegionRefIR {
            object_id: "strip".to_string(),
            region_id: None,
        }),
        formula: fullmag_ir::PrescribedSotFormulaIR::FullmagV1 {
            drive: fullmag_ir::PrescribedSotV1DriveIR::SignedScalar {
                current_density_apm2: -1.0e11,
                sigma_hat: [0.0, 2.0, 0.0],
                envelope: Some(fullmag_ir::TimeEnvelopeIR::Constant { value: 0.25 }),
            },
            xi_dl: 0.12,
            xi_fl: -0.02,
            free_layer_thickness_m: 1.5e-9,
        },
    }];

    let planned = plan(&ir).expect("canonical FEM CPU SOT should plan");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("expected FEM plan");
    };
    let contract = fem
        .spin_torque_contract
        .expect("versioned FEM SOT contract");
    assert_eq!(contract.formula_version, "prescribed_sot.fullmag.v1");
    assert_eq!(contract.sot_current_density, Some(-1.0e11));
    assert_eq!(contract.sot_xi_dl, Some(0.12));
    assert_eq!(contract.sot_xi_fl, Some(-0.02));
    assert_eq!(contract.sot_thickness, Some(1.5e-9));
    assert_eq!(contract.sot_sigma, Some([0.0, 1.0, 0.0]));
    assert_eq!(
        contract.sot_envelope,
        Some(fullmag_ir::TimeEnvelopeIR::Constant { value: 0.25 })
    );
    assert!(contract.sot_drive.is_some());
    assert!(contract
        .active_node_mask
        .as_ref()
        .is_some_and(|mask| !mask.is_empty() && mask.iter().any(|selected| *selected)));
}

#[test]
fn fdm_mumax3_zhang_li_plan_preserves_identity_and_operator() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fdm;
    ir.spin_torque_modules = vec![fullmag_ir::SpinTorqueModuleIR::ZhangLi {
        schema_version: Some("zhang_li_torque.v1".to_string()),
        id: Some("sp5_zhang_li".to_string()),
        target: Some(fullmag_ir::RegionRefIR {
            object_id: "strip".to_string(),
            region_id: None,
        }),
        formula_version: "zhang_li.mumax3.v1".to_string(),
        operator_version: Some("zl_mumax3_central_v1".to_string()),
        current_density: Some([1e12, 0.0, 0.0]),
        current_source: None,
        degree: 1.0,
        beta: 0.05,
        lande_g: Some(2.0),
    }];

    let planned = plan(&ir).expect("MuMax3 Zhang-Li FDM plan should be executable");
    let BackendPlanIR::Fdm(fdm) = planned.backend_plan else {
        panic!("expected FDM plan");
    };
    assert_eq!(
        fdm.zhang_li_formula_version.as_deref(),
        Some("zhang_li.mumax3.v1")
    );
    assert_eq!(
        fdm.zhang_li_operator_version.as_deref(),
        Some("zl_mumax3_central_v1")
    );
    assert_eq!(fdm.zhang_li_lande_g, Some(2.0));
    assert_eq!(
        fdm.zhang_li_target
            .as_ref()
            .map(|target| target.object_id.as_str()),
        Some("strip")
    );
}

#[test]
fn fdm_canonical_fullmag_zhang_li_fails_closed_instead_of_using_legacy_stencil() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fdm;
    ir.spin_torque_modules = vec![fullmag_ir::SpinTorqueModuleIR::ZhangLi {
        schema_version: Some("zhang_li_torque.v1".to_string()),
        id: Some("canonical_cip".to_string()),
        target: Some(fullmag_ir::RegionRefIR {
            object_id: "strip".to_string(),
            region_id: None,
        }),
        formula_version: "zhang_li.fullmag.v1".to_string(),
        operator_version: Some("zl_central_reference_v1".to_string()),
        current_density: Some([1e12, 0.0, 0.0]),
        current_source: None,
        degree: 1.0,
        beta: 0.05,
        lande_g: Some(2.0),
    }];

    let err = plan(&ir).expect_err("FDM must not silently substitute the legacy stencil");
    assert!(err.reasons.iter().any(|reason| {
        reason.contains("zhang_li.fullmag.v1") && reason.contains("not executable on FDM")
    }));
}

#[test]
fn relaxation_rejects_time_dependent_and_unpaired_oersted_sources() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = fullmag_ir::StudyIR::Relaxation {
        algorithm: fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped,
        dynamics: Some(ir.study.dynamics().clone()),
        stop: fullmag_ir::RelaxStopIR {
            torque_tolerance_apm: Some(1e-3),
            energy_tolerance_j: None,
            max_steps: Some(250),
            max_relaxation_time_s: None,
        },
        sampling: ir.study.sampling().clone(),
    };
    ir.energy_terms.push(EnergyTermIR::OerstedCylinder {
        id: None,
        current: 1.0,
        radius: 5e-9,
        center: [0.0, 0.0, 0.0],
        axis: [0.0, 0.0, 1.0],
        time_dependence: Some(fullmag_ir::TimeDependenceIR::Sinusoidal {
            frequency_hz: 1e9,
            phase_rad: 0.0,
            offset: 0.0,
        }),
    });

    let err = plan(&ir).expect_err("relaxation must reject time-dependent and unpaired Oersted");
    assert!(err.reasons.iter().any(|reason| {
        reason.contains("time-dependent Oersted") && reason.contains("conservative equilibrium")
    }));
    assert!(err
        .reasons
        .iter()
        .any(|reason| { reason.contains("Oersted") && reason.contains("field-energy parity") }));
}

#[test]
fn strict_planner_rejects_tpi_and_extended_cpu_marks_development() {
    let mut strict = ProblemIR::bootstrap_example();
    strict.backend_policy.requested_backend = BackendTarget::Fem;
    attach_unit_fem_domain_mesh(&mut strict);
    strict.study = fullmag_ir::StudyIR::Relaxation {
        algorithm: fullmag_ir::RelaxationAlgorithmIR::TangentPlaneImplicit,
        dynamics: None,
        stop: fullmag_ir::RelaxStopIR {
            torque_tolerance_apm: Some(1e-3),
            energy_tolerance_j: None,
            max_steps: Some(250),
            max_relaxation_time_s: None,
        },
        sampling: strict.study.sampling().clone(),
    };
    let err = plan(&strict).expect_err("strict TPI planning must reject development capability");
    assert!(err.reasons.iter().any(|reason| {
        reason.contains("tangent_plane_implicit")
            && reason.contains("development-only")
            && reason.contains("strict")
    }));

    let mut extended = strict.clone();
    extended.backend_policy.requested_backend = BackendTarget::Auto;
    extended.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Extended;
    let planned = plan(&extended).expect("extended automatic TPI should resolve to CPU/MFEM");
    assert_eq!(planned.common.requested_backend, BackendTarget::Auto);
    assert_eq!(planned.common.resolved_backend, BackendTarget::Fem);
    assert!(planned.provenance.notes.iter().any(|note| {
        note.contains("tangent_plane_implicit")
            && note.contains("development")
            && note.contains("CPU/MFEM")
    }));

    extended.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "gpu"}),
    );
    let err = plan(&extended).expect_err("forced GPU TPI must reject");
    assert!(err.reasons.iter().any(|reason| {
        reason.contains("tangent_plane_implicit")
            && reason.contains("GPU")
            && reason.contains("unsupported")
    }));
}

#[test]
fn tangent_plane_implicit_is_now_plannable_for_fem() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Extended;
    attach_unit_fem_domain_mesh(&mut ir);
    ir.study = fullmag_ir::StudyIR::Relaxation {
        algorithm: fullmag_ir::RelaxationAlgorithmIR::TangentPlaneImplicit,
        dynamics: None,
        stop: fullmag_ir::RelaxStopIR {
            torque_tolerance_apm: Some(1e-3),
            energy_tolerance_j: None,
            max_steps: Some(250),
            max_relaxation_time_s: None,
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
        dynamics: None,
        stop: fullmag_ir::RelaxStopIR {
            torque_tolerance_apm: Some(1e-3),
            energy_tolerance_j: None,
            max_steps: Some(250),
            max_relaxation_time_s: None,
        },
        sampling: ir.study.sampling().clone(),
    };

    let err = plan(&ir).expect_err("tangent_plane_implicit should be FEM-only");
    assert!(err.reasons.iter().any(|reason| {
        reason.contains("tangent_plane_implicit")
            && reason.contains("FEM-only")
            && reason.contains("backend='fem'")
            && reason.contains("extended")
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
            projection_policy: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
                element_markers: vec![1, 0],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [4, 5, 6]]),
                boundary_markers: vec![1, 99],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            object_region_markers: Vec::new(),
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
            projection_policy: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
                element_markers: vec![1, 0],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [4, 5, 6]]),
                boundary_markers: vec![1, 99],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            object_region_markers: Vec::new(),
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
            object_id: None,
            name: "free".to_string(),
            region: "free_region".to_string(),
            material: "Py".to_string(),
            initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                value: [1.0, 0.0, 0.0],
            }),
            absorbing_boundary: None,
        },
        fullmag_ir::MagnetIR {
            object_id: None,
            name: "ref".to_string(),
            region: "ref_region".to_string(),
            material: "Py".to_string(),
            initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                value: [0.0, 1.0, 0.0],
            }),
            absorbing_boundary: None,
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
                fft_backend: "auto".to_string(),
                common_cells: None,
                common_cells_xy: None,
                common_cell_size: None,
            }),
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
            projection_policy: None,
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
            object_id: None,
            name: "free".to_string(),
            region: "free_region".to_string(),
            material: "Py".to_string(),
            initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                value: [1.0, 0.0, 0.0],
            }),
            absorbing_boundary: None,
        },
        fullmag_ir::MagnetIR {
            object_id: None,
            name: "ref".to_string(),
            region: "ref_region".to_string(),
            material: "Py".to_string(),
            initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                value: [0.0, 1.0, 0.0],
            }),
            absorbing_boundary: None,
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
                fft_backend: "auto".to_string(),
                common_cells: None,
                common_cells_xy: None,
                common_cell_size: None,
            }),
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
            projection_policy: None,
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
            object_id: None,
            name: "free".to_string(),
            region: "free_region".to_string(),
            material: "Py".to_string(),
            initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                value: [1.0, 0.0, 0.0],
            }),
            absorbing_boundary: None,
        },
        fullmag_ir::MagnetIR {
            object_id: None,
            name: "ref".to_string(),
            region: "ref_region".to_string(),
            material: "Py".to_string(),
            initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                value: [0.0, 1.0, 0.0],
            }),
            absorbing_boundary: None,
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
                fft_backend: "auto".to_string(),
                common_cells: None,
                common_cells_xy: None,
                common_cell_size: None,
            }),
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
            projection_policy: None,
        }),
        fem: None,
        hybrid: None,
    });
    ir
}

#[test]
fn multilayer_fdm_lowers_frozen_spins_in_native_layer_order() {
    let mut ir = stacked_two_body_multilayer_problem();
    ir.magnets[0].object_id = Some("free".to_string());
    ir.magnets[1].object_id = Some("ref".to_string());
    ir.magnetization_constraints
        .push(MagnetizationConstraintIR::FrozenSpins(FrozenSpinsIR {
            schema_version: FROZEN_SPINS_SCHEMA_VERSION.to_string(),
            id: "pin-stack".to_string(),
            name: "Pinned stack".to_string(),
            enabled: true,
            selector: SelectionExprIR::InObject {
                object_id: "free".to_string(),
            },
            reference: FrozenReferencePolicyIR::CaptureCurrentAtActivation {},
            membership: SelectionMembershipPolicyIR::Static {},
            activation: ConstraintActivationIR::AllStages {},
            empty_selection: EmptySelectionPolicyIR::Error,
            inactive_selection: InactiveSelectionPolicyIR::WarnAndIntersect,
        }));

    let execution = plan(&ir).expect("multilayer Frozen Spins must lower");
    let BackendPlanIR::FdmMultilayer(multilayer) = execution.backend_plan else {
        panic!("expected multilayer FDM plan");
    };
    let frozen = multilayer
        .frozen_spins
        .expect("multilayer plan must carry the resolved mask");
    let first_layer_len = multilayer.layers[0].initial_magnetization.len();
    assert_eq!(frozen.frozen_mask.len(), 2 * first_layer_len);
    assert!(frozen.frozen_mask[..first_layer_len]
        .iter()
        .all(|value| *value));
    assert!(frozen.frozen_mask[first_layer_len..]
        .iter()
        .all(|value| !*value));
    assert_eq!(frozen.frozen_dof_count as usize, first_layer_len);
}

#[test]
fn regular_three_layer_planner_uses_deduplicated_cpu_catalog_memory() {
    let mut ir = stacked_two_body_multilayer_problem();
    ir.geometry.entries.push(GeometryEntryIR::Translate {
        name: "third_geom".to_string(),
        base: std::boxed::Box::new(GeometryEntryIR::Box {
            name: "third_base".to_string(),
            size: [40e-9, 20e-9, 2e-9],
        }),
        by: [0.0, 0.0, 8e-9],
    });
    ir.regions.push(fullmag_ir::RegionIR {
        name: "third_region".to_string(),
        geometry: "third_geom".to_string(),
    });
    ir.magnets.push(fullmag_ir::MagnetIR {
        object_id: None,
        name: "third".to_string(),
        region: "third_region".to_string(),
        material: "Py".to_string(),
        initial_magnetization: Some(InitialMagnetizationIR::Uniform {
            value: [1.0, 0.0, 0.0],
        }),
        absorbing_boundary: None,
    });

    let planned = plan(&ir).expect("regular three-layer CPU stack should plan");
    let BackendPlanIR::FdmMultilayer(multilayer) = planned.backend_plan else {
        panic!("regular three-layer fixture must resolve to multilayer FDM");
    };

    assert_eq!(multilayer.common_cells, [20, 10, 1]);
    assert_eq!(multilayer.planner_summary.estimated_pair_kernels, 9);
    assert_eq!(multilayer.planner_summary.estimated_unique_kernels, 5);
    assert_eq!(multilayer.planner_summary.estimated_kernel_bytes, 384_108);
    assert_eq!(
        multilayer.planner_summary.estimated_kernel_bytes,
        5 * 40 * 20 * 6 * 16 + 9 * 12
    );
}

#[test]
fn fdm_common_cell_size_resolves_heterogeneous_native_grids_without_rounding() {
    let mut ir = stacked_two_body_multilayer_problem();
    for (entry, z) in ir.geometry.entries.iter_mut().zip([0.0, 20e-9]) {
        let GeometryEntryIR::Translate { base, by, .. } = entry else {
            panic!("fixture geometry must be translated boxes");
        };
        let GeometryEntryIR::Box { size, .. } = base.as_mut() else {
            panic!("fixture geometry base must be a box");
        };
        *size = [100e-9, 50e-9, 10e-9];
        *by = [0.0, 0.0, z];
    }
    let fdm = ir
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .expect("fixture must provide FDM hints");
    fdm.cell = [0.0; 3];
    fdm.default_cell = None;
    fdm.per_magnet = Some(std::collections::BTreeMap::from([
        (
            "free".to_string(),
            fullmag_ir::FdmGridHintsIR {
                cell: [2e-9, 2e-9, 10e-9],
            },
        ),
        (
            "ref".to_string(),
            fullmag_ir::FdmGridHintsIR {
                cell: [5e-9, 5e-9, 10e-9],
            },
        ),
    ]));
    fdm.demag = Some(fullmag_ir::FdmDemagHintsIR {
        strategy: "auto".to_string(),
        mode: "auto".to_string(),
        fft_backend: "auto".to_string(),
        common_cells: None,
        common_cells_xy: None,
        common_cell_size: Some([2e-9, 2e-9, 2.5e-9]),
    });

    let planned = plan(&ir).expect("requested common cell size should plan");
    let BackendPlanIR::FdmMultilayer(multilayer) = planned.backend_plan else {
        panic!("heterogeneous magnetic objects must use multilayer convolution");
    };

    assert_eq!(multilayer.common_cells, [50, 25, 4]);
    assert_eq!(
        multilayer.requested_common_cell_size,
        Some([2e-9, 2e-9, 2.5e-9])
    );
    assert_eq!(multilayer.mode, "three_d");
    assert!(multilayer
        .layers
        .iter()
        .all(|layer| { layer.convolution_cell_size == [2e-9, 2e-9, 2.5e-9] }));
    assert!(multilayer
        .layers
        .iter()
        .any(|layer| layer.transfer_kind == "push_pull"));
}

fn eight_layer_multilayer_problem_for_kernel_budget() -> ProblemIR {
    let mut ir = stacked_two_body_multilayer_problem();
    for index in 2..8 {
        let name = format!("layer_{index}");
        let geometry_name = format!("{name}_geom");
        let region_name = format!("{name}_region");
        ir.geometry.entries.push(GeometryEntryIR::Translate {
            name: geometry_name.clone(),
            base: std::boxed::Box::new(GeometryEntryIR::Box {
                name: format!("{name}_base"),
                size: [40e-9, 20e-9, 2e-9],
            }),
            by: [0.0, 0.0, index as f64 * 4e-9],
        });
        ir.regions.push(fullmag_ir::RegionIR {
            name: region_name.clone(),
            geometry: geometry_name,
        });
        ir.magnets.push(fullmag_ir::MagnetIR {
            object_id: None,
            name,
            region: region_name,
            material: "Py".to_string(),
            initial_magnetization: Some(InitialMagnetizationIR::Uniform {
                value: [1.0, 0.0, 0.0],
            }),
            absorbing_boundary: None,
        });
    }
    let fdm = ir
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .expect("stacked fixture must provide FDM hints");
    fdm.demag = Some(fullmag_ir::FdmDemagHintsIR {
        strategy: "multilayer_convolution".to_string(),
        mode: "three_d".to_string(),
        fft_backend: "auto".to_string(),
        common_cells: Some([262_144, 1, 1]),
        common_cells_xy: None,
        common_cell_size: None,
    });
    ir
}

fn three_layer_catalog_problem(thicknesses_m: [f64; 3]) -> ProblemIR {
    let mut ir = stacked_two_body_multilayer_problem();
    ir.geometry.entries.push(GeometryEntryIR::Translate {
        name: "layer_2_geom".to_string(),
        base: std::boxed::Box::new(GeometryEntryIR::Box {
            name: "layer_2_base".to_string(),
            size: [40e-9, 20e-9, thicknesses_m[2]],
        }),
        by: [0.0, 0.0, 16e-9],
    });
    ir.regions.push(fullmag_ir::RegionIR {
        name: "layer_2_region".to_string(),
        geometry: "layer_2_geom".to_string(),
    });
    ir.magnets.push(fullmag_ir::MagnetIR {
        object_id: None,
        name: "layer_2".to_string(),
        region: "layer_2_region".to_string(),
        material: "Py".to_string(),
        initial_magnetization: Some(InitialMagnetizationIR::Uniform {
            value: [0.0, 0.0, 1.0],
        }),
        absorbing_boundary: None,
    });
    for (entry, (z, thickness)) in ir
        .geometry
        .entries
        .iter_mut()
        .zip([0.0, 8e-9, 16e-9].into_iter().zip(thicknesses_m))
    {
        let GeometryEntryIR::Translate { base, by, .. } = entry else {
            panic!("catalog fixture geometry must be translated");
        };
        let GeometryEntryIR::Box { size, .. } = base.as_mut() else {
            panic!("catalog fixture base must be a box");
        };
        size[2] = thickness;
        by[2] = z;
    }
    let fdm = ir
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .expect("catalog fixture must provide FDM hints");
    fdm.default_cell = None;
    fdm.per_magnet = Some(BTreeMap::from([
        (
            "free".to_string(),
            fullmag_ir::FdmGridHintsIR {
                cell: [2e-9, 2e-9, thicknesses_m[0]],
            },
        ),
        (
            "ref".to_string(),
            fullmag_ir::FdmGridHintsIR {
                cell: [2e-9, 2e-9, thicknesses_m[1]],
            },
        ),
        (
            "layer_2".to_string(),
            fullmag_ir::FdmGridHintsIR {
                cell: [2e-9, 2e-9, thicknesses_m[2]],
            },
        ),
    ]));
    fdm.demag = Some(fullmag_ir::FdmDemagHintsIR {
        strategy: "multilayer_convolution".to_string(),
        mode: "two_d_stack".to_string(),
        fft_backend: "auto".to_string(),
        common_cells: None,
        common_cells_xy: Some([20, 10]),
        common_cell_size: None,
    });
    ir
}

#[test]
fn multilayer_planner_regular_three_layer_catalog_matches_runtime_count() {
    let planned = plan(&three_layer_catalog_problem([2e-9, 2e-9, 2e-9]))
        .expect("regular three-layer catalog should plan");
    let BackendPlanIR::FdmMultilayer(multilayer) = planned.backend_plan else {
        panic!("regular fixture must produce a multilayer plan");
    };
    assert_eq!(multilayer.planner_summary.estimated_unique_kernels, 5);
    assert_eq!(multilayer.planner_summary.estimated_pair_kernels, 9);
}

#[test]
fn multilayer_planner_unequal_three_layer_catalog_matches_runtime_count() {
    let planned = plan(&three_layer_catalog_problem([2e-9, 3e-9, 4e-9]))
        .expect("unequal three-layer catalog should plan");
    let BackendPlanIR::FdmMultilayer(multilayer) = planned.backend_plan else {
        panic!("unequal fixture must produce a multilayer plan");
    };
    assert_eq!(multilayer.planner_summary.estimated_unique_kernels, 9);
    assert_eq!(multilayer.planner_summary.estimated_pair_kernels, 9);
}

#[test]
fn multilayer_cpu_planner_admits_deduplicated_catalog_below_memory_budget() {
    let planned = plan(&eight_layer_multilayer_problem_for_kernel_budget())
        .expect("CPU FP64 must admit the deduplicated catalog rather than the ABI v2 pair payload");
    let BackendPlanIR::FdmMultilayer(multilayer) = planned.backend_plan else {
        panic!("eight-layer fixture must produce a multilayer plan");
    };
    assert_eq!(multilayer.planner_summary.estimated_unique_kernels, 15);
    assert!(multilayer.planner_summary.estimated_kernel_bytes < FDM_GRID_MAX_BYTES);
}

#[test]
fn multilayer_cuda_planner_retains_abi_v2_pair_payload_memory_budget() {
    let mut ir = eight_layer_multilayer_problem_for_kernel_budget();
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda", "device_index": 0}),
    );
    let error = plan(&ir)
        .expect_err("full CUDA ABI v2 pair payload must fail planner admission before allocation");
    assert!(error.reasons.iter().any(|reason| {
        reason.contains("multilayer_convolution aggregate memory budget exceeded")
            && reason.contains("admission_model=cuda_abi_v2_pair_payload")
    }));
}

#[test]
fn multilayer_planner_rejects_abi_v2_pair_payload_above_memory_budget() {
    let mut ir = eight_layer_multilayer_problem_for_kernel_budget();
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda", "device_index": 0}),
    );
    let error = plan(&ir)
        .expect_err("full ABI v2 pair payload must fail planner admission before allocation");
    assert!(error.reasons.iter().any(|reason| reason
        .contains("admission_model=cuda_abi_v2_pair_payload")
        && reason.contains("multilayer_convolution aggregate memory budget exceeded")
        && reason.contains("kernel_bytes=12884902656")
        && reason.contains("estimated_bytes=12952421120")));
}

#[test]
fn multilayer_planner_skips_inactive_demag_kernel_payload_admission() {
    let mut ir = eight_layer_multilayer_problem_for_kernel_budget();
    ir.energy_terms
        .retain(|term| !matches!(term, fullmag_ir::EnergyTermIR::Demag { .. }));

    let planned =
        plan(&ir).expect("inactive demag must not admit the potential ABI v2 pair-kernel payload");
    let BackendPlanIR::FdmMultilayer(multilayer) = planned.backend_plan else {
        panic!("eight-layer fixture must produce a multilayer plan");
    };
    assert!(!multilayer.enable_demag);
    assert_eq!(multilayer.planner_summary.estimated_kernel_bytes, 0);
}

fn stacked_two_body_multilayer_problem_with_dmi() -> ProblemIR {
    let mut ir = stacked_two_body_multilayer_problem();
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::InterfacialDmi {
            d: 1.5e-3,
            interface_normal: None,
        },
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::Auto,
        },
    ];
    ir
}

fn cuda_three_d_identity_multilayer_problem() -> ProblemIR {
    let mut ir = stacked_two_body_multilayer_problem();
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda", "device_index": 0}),
    );
    let fdm = ir
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .expect("stacked fixture must provide FDM hints");
    fdm.demag = Some(fullmag_ir::FdmDemagHintsIR {
        strategy: "multilayer_convolution".to_string(),
        mode: "three_d".to_string(),
        fft_backend: "auto".to_string(),
        common_cells: Some([20, 10, 1]),
        common_cells_xy: None,
        common_cell_size: None,
    });
    ir
}

fn assert_cuda_multilayer_rejects_reason(ir: &ProblemIR, reason_code: &str) {
    let error = plan(ir).expect_err("unqualified CUDA multilayer operator must fail closed");
    assert!(
        error
            .reasons
            .iter()
            .any(|reason| reason.contains(reason_code)),
        "missing reason code {reason_code}: {:?}",
        error.reasons
    );
}

fn cuda_unqualified_multilayer_operator_cases() -> Vec<(ProblemIR, &'static str)> {
    let mut cases = Vec::new();

    let mut two_d_stack = cuda_three_d_identity_multilayer_problem();
    two_d_stack
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .and_then(|fdm| fdm.demag.as_mut())
        .expect("CUDA fixture must provide demag hints")
        .mode = "two_d_stack".to_string();
    let demag = two_d_stack
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .and_then(|fdm| fdm.demag.as_mut())
        .expect("CUDA fixture must provide demag hints");
    demag.common_cells = None;
    demag.common_cells_xy = Some([20, 10]);
    cases.push((two_d_stack, "fdm_cuda_multilayer_two_d_stack_unqualified"));

    let mut push_pull = cuda_three_d_identity_multilayer_problem();
    let GeometryEntryIR::Translate { base, .. } = &mut push_pull.geometry.entries[1] else {
        panic!("stacked fixture reference geometry must be translated");
    };
    let GeometryEntryIR::Box { size, .. } = base.as_mut() else {
        panic!("stacked fixture reference geometry must be a box");
    };
    size[0] = 20e-9;
    cases.push((push_pull, "fdm_cuda_multilayer_push_pull_unqualified"));

    let mut heterogeneous_hz = cuda_three_d_identity_multilayer_problem();
    let fdm = heterogeneous_hz
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .expect("CUDA fixture must provide FDM hints");
    fdm.per_magnet = Some(BTreeMap::from([
        (
            "free".to_string(),
            fullmag_ir::FdmGridHintsIR {
                cell: [2e-9, 2e-9, 2e-9],
            },
        ),
        (
            "ref".to_string(),
            fullmag_ir::FdmGridHintsIR {
                cell: [2e-9, 2e-9, 1e-9],
            },
        ),
    ]));
    cases.push((
        heterogeneous_hz,
        "fdm_cuda_multilayer_heterogeneous_native_hz_unqualified",
    ));

    let mut xy_offset = cuda_three_d_identity_multilayer_problem();
    let GeometryEntryIR::Translate { by, .. } = &mut xy_offset.geometry.entries[1] else {
        panic!("stacked fixture reference geometry must be translated");
    };
    by[0] = 10e-9;
    cases.push((xy_offset, "fdm_cuda_multilayer_xy_offset_unqualified"));

    cases
}

#[test]
fn cuda_multilayer_containment_rejects_each_unqualified_operator_class() {
    for (ir, reason_code) in cuda_unqualified_multilayer_operator_cases() {
        assert_cuda_multilayer_rejects_reason(&ir, reason_code);
    }
}

#[test]
fn forced_cuda_multilayer_without_demag_allows_unqualified_demag_operator_classes() {
    for (mut ir, reason_code) in cuda_unqualified_multilayer_operator_cases() {
        ir.energy_terms
            .retain(|term| !matches!(term, fullmag_ir::EnergyTermIR::Demag { .. }));
        let planned = plan(&ir).unwrap_or_else(|error| {
            panic!(
                "inactive demag must not reject CUDA multilayer class {reason_code}: {:?}",
                error.reasons
            )
        });
        let BackendPlanIR::FdmMultilayer(multilayer) = planned.backend_plan else {
            panic!("forced CUDA multi-body fixture must remain a multilayer plan");
        };
        assert!(!multilayer.enable_demag);
    }
}

#[test]
fn cuda_multilayer_containment_reason_codes_have_stable_order_when_classes_overlap() {
    let planned = plan(&cuda_three_d_identity_multilayer_problem())
        .expect("qualified CUDA fixture must produce multilayer layers");
    let BackendPlanIR::FdmMultilayer(mut multilayer) = planned.backend_plan else {
        panic!("qualified CUDA fixture must produce a multilayer plan");
    };
    multilayer.layers[0].transfer_kind = "push_pull".to_string();
    multilayer.layers[1].native_cell_size[2] = 1e-9;
    multilayer.layers[1].native_origin[0] += 2e-9;

    assert_eq!(
        fdm_multilayer_cuda_containment_reason_codes(true, "two_d_stack", &multilayer.layers),
        vec![
            FDM_CUDA_MULTILAYER_TWO_D_STACK_UNQUALIFIED,
            FDM_CUDA_MULTILAYER_PUSH_PULL_UNQUALIFIED,
            FDM_CUDA_MULTILAYER_HETEROGENEOUS_NATIVE_HZ_UNQUALIFIED,
            FDM_CUDA_MULTILAYER_XY_OFFSET_UNQUALIFIED,
        ]
    );
}

#[test]
fn cuda_multilayer_containment_exact_center_accepts_canonical_centered_extents() {
    let mut ir = cuda_three_d_identity_multilayer_problem();
    ir.problem_meta.runtime_metadata.remove("runtime_selection");
    let GeometryEntryIR::Translate { base, .. } = &mut ir.geometry.entries[1] else {
        panic!("stacked fixture reference geometry must be translated");
    };
    let GeometryEntryIR::Box { size, .. } = base.as_mut() else {
        panic!("stacked fixture reference geometry must be a box");
    };
    size[0] = 20e-9;

    let planned = plan(&ir).expect("CPU fixture must expose planner-resolved layer descriptors");
    let BackendPlanIR::FdmMultilayer(multilayer) = planned.backend_plan else {
        panic!("multi-body fixture must produce a multilayer plan");
    };
    assert_eq!(
        fdm_multilayer_cuda_containment_reason_codes(true, "three_d", &multilayer.layers),
        vec![FDM_CUDA_MULTILAYER_PUSH_PULL_UNQUALIFIED]
    );
}

#[test]
fn cpu_multilayer_preserves_two_d_push_pull_heterogeneous_hz_and_xy_offset() {
    let mut cases = Vec::new();

    let mut two_d_stack = cuda_three_d_identity_multilayer_problem();
    let demag = two_d_stack
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .and_then(|fdm| fdm.demag.as_mut())
        .expect("CUDA fixture must provide demag hints");
    demag.mode = "two_d_stack".to_string();
    demag.common_cells = None;
    demag.common_cells_xy = Some([20, 10]);
    cases.push(two_d_stack);

    let mut push_pull = cuda_three_d_identity_multilayer_problem();
    let GeometryEntryIR::Translate { base, .. } = &mut push_pull.geometry.entries[1] else {
        panic!("stacked fixture reference geometry must be translated");
    };
    let GeometryEntryIR::Box { size, .. } = base.as_mut() else {
        panic!("stacked fixture reference geometry must be a box");
    };
    size[0] = 20e-9;
    cases.push(push_pull);

    let mut heterogeneous_hz = cuda_three_d_identity_multilayer_problem();
    heterogeneous_hz
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .expect("CUDA fixture must provide FDM hints")
        .per_magnet = Some(BTreeMap::from([
        (
            "free".to_string(),
            fullmag_ir::FdmGridHintsIR {
                cell: [2e-9, 2e-9, 2e-9],
            },
        ),
        (
            "ref".to_string(),
            fullmag_ir::FdmGridHintsIR {
                cell: [2e-9, 2e-9, 1e-9],
            },
        ),
    ]));
    cases.push(heterogeneous_hz);

    let mut xy_offset = cuda_three_d_identity_multilayer_problem();
    let GeometryEntryIR::Translate { by, .. } = &mut xy_offset.geometry.entries[1] else {
        panic!("stacked fixture reference geometry must be translated");
    };
    by[0] = 10e-9;
    cases.push(xy_offset);

    for mut ir in cases {
        ir.problem_meta.runtime_metadata.remove("runtime_selection");
        plan(&ir).expect("CPU multilayer containment scope must remain executable");
    }
}

#[test]
fn explicit_single_layer_multilayer_strategy_uses_multilayer_plan() {
    let mut ir = ProblemIR::bootstrap_example();
    let fdm = ir
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .expect("bootstrap example must provide FDM hints");
    fdm.demag = Some(fullmag_ir::FdmDemagHintsIR {
        strategy: "multilayer_convolution".to_string(),
        mode: "auto".to_string(),
        fft_backend: "auto".to_string(),
        common_cells: None,
        common_cells_xy: None,
        common_cell_size: None,
    });

    let planned = plan(&ir).expect("explicit multilayer strategy must be executable for L=1");
    let BackendPlanIR::FdmMultilayer(multilayer) = planned.backend_plan else {
        panic!("explicit multilayer strategy must lower through FdmMultilayerPlanIR");
    };
    assert_eq!(multilayer.layers.len(), 1);
    assert_eq!(
        multilayer.planner_summary.requested_strategy,
        "multilayer_convolution"
    );
}

#[test]
fn multilayer_planner_accepts_exactly_neutral_boundary_intent() {
    for boundary_correction in [None, Some("none".to_string())] {
        let mut ir = stacked_two_body_multilayer_problem();
        let fdm = ir
            .backend_policy
            .discretization_hints
            .as_mut()
            .and_then(|hints| hints.fdm.as_mut())
            .expect("stacked fixture must provide FDM hints");
        fdm.boundary_correction = boundary_correction;
        fdm.boundary_phi_floor = None;
        fdm.boundary_delta_min = None;

        plan(&ir).expect("neutral boundary intent must remain executable for multilayer FDM");
    }
}

#[test]
fn multilayer_planner_rejects_every_non_neutral_boundary_intent() {
    let cases = [
        ("boundary_correction=volume", Some("volume"), None, None),
        ("boundary_correction=full", Some("full"), None, None),
        ("boundary_phi_floor=0", None, Some(0.0), None),
        ("boundary_phi_floor=positive", None, Some(0.1), None),
        ("boundary_delta_min=0", None, None, Some(0.0)),
        ("boundary_delta_min=positive", None, None, Some(1.0e-12)),
    ];

    for (case_name, boundary_correction, boundary_phi_floor, boundary_delta_min) in cases {
        for explicit_single_layer in [false, true] {
            let mut ir = if explicit_single_layer {
                let mut ir = ProblemIR::bootstrap_example();
                ir.backend_policy
                    .discretization_hints
                    .as_mut()
                    .and_then(|hints| hints.fdm.as_mut())
                    .expect("bootstrap example must provide FDM hints")
                    .demag = Some(fullmag_ir::FdmDemagHintsIR {
                    strategy: "multilayer_convolution".to_string(),
                    mode: "auto".to_string(),
                    fft_backend: "auto".to_string(),
                    common_cells: None,
                    common_cells_xy: None,
                    common_cell_size: None,
                });
                ir
            } else {
                stacked_two_body_multilayer_problem()
            };
            let fdm = ir
                .backend_policy
                .discretization_hints
                .as_mut()
                .and_then(|hints| hints.fdm.as_mut())
                .expect("multilayer fixture must provide FDM hints");
            fdm.boundary_correction = boundary_correction.map(str::to_string);
            fdm.boundary_phi_floor = boundary_phi_floor;
            fdm.boundary_delta_min = boundary_delta_min;

            let error = plan(&ir).expect_err(
                "multilayer FDM must reject boundary intent that its plan cannot preserve",
            );
            assert!(
                error.reasons.iter().any(|reason| {
                    reason.contains("boundary intent") && reason.contains("FdmMultilayerPlanIR")
                }),
                "case={case_name} explicit_single_layer={explicit_single_layer} errors={:?}",
                error.reasons
            );
        }
    }
}

#[test]
fn multilayer_planner_resolves_common_grid_modes_without_overriding_explicit_mode() {
    let mut common_cells_auto = stacked_two_body_multilayer_problem();
    let fdm = common_cells_auto
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .expect("stacked fixture must provide FDM hints");
    fdm.demag = Some(fullmag_ir::FdmDemagHintsIR {
        strategy: "multilayer_convolution".to_string(),
        mode: "auto".to_string(),
        fft_backend: "auto".to_string(),
        common_cells: Some([20, 10, 1]),
        common_cells_xy: None,
        common_cell_size: None,
    });
    let planned = plan(&common_cells_auto).expect("common_cells auto mode should resolve");
    let BackendPlanIR::FdmMultilayer(multilayer) = planned.backend_plan else {
        panic!("expected multilayer plan");
    };
    assert_eq!(multilayer.planner_summary.requested_mode, "auto");
    assert_eq!(multilayer.planner_summary.resolved_mode, "three_d");
    assert_eq!(multilayer.mode, "three_d");

    let mut common_cells_xy_auto = stacked_two_body_multilayer_problem();
    let fdm = common_cells_xy_auto
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .expect("stacked fixture must provide FDM hints");
    fdm.demag = Some(fullmag_ir::FdmDemagHintsIR {
        strategy: "multilayer_convolution".to_string(),
        mode: "auto".to_string(),
        fft_backend: "auto".to_string(),
        common_cells: None,
        common_cells_xy: Some([20, 10]),
        common_cell_size: None,
    });
    let planned = plan(&common_cells_xy_auto).expect("common_cells_xy auto mode should resolve");
    let BackendPlanIR::FdmMultilayer(multilayer) = planned.backend_plan else {
        panic!("expected multilayer plan");
    };
    assert_eq!(multilayer.planner_summary.requested_mode, "auto");
    assert_eq!(multilayer.planner_summary.resolved_mode, "two_d_stack");
    assert_eq!(multilayer.common_cells[2], 1);

    let mut conflict = stacked_two_body_multilayer_problem();
    let fdm = conflict
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .expect("stacked fixture must provide FDM hints");
    fdm.demag = Some(fullmag_ir::FdmDemagHintsIR {
        strategy: "multilayer_convolution".to_string(),
        mode: "two_d_stack".to_string(),
        fft_backend: "auto".to_string(),
        common_cells: Some([20, 10, 1]),
        common_cells_xy: None,
        common_cell_size: None,
    });
    let error = plan(&conflict).expect_err("common_cells must reject explicit two_d_stack");
    assert!(error
        .reasons
        .iter()
        .any(|reason| reason.contains("common_cells") && reason.contains("two_d_stack")));
}

#[test]
fn multilayer_planner_records_stable_layer_identity_and_transfer_kind() {
    let planned =
        plan(&stacked_two_body_multilayer_problem()).expect("stacked fixture should plan");
    let BackendPlanIR::FdmMultilayer(multilayer) = planned.backend_plan else {
        panic!("expected multilayer plan");
    };
    assert_eq!(multilayer.layers[0].layer_id, "layer:free");
    assert_eq!(multilayer.layers[0].object_id, "free");
    assert_eq!(multilayer.layers[1].layer_id, "layer:ref");
    assert_eq!(multilayer.layers[1].object_id, "ref");
    for layer in &multilayer.layers {
        assert!(matches!(
            layer.transfer_kind.as_str(),
            "identity" | "push_pull" | "unsupported"
        ));
        assert_eq!(layer.native_grid[2], 1);
        assert_eq!(layer.convolution_grid[2], 1);
    }
}

#[test]
fn two_d_stack_fails_closed_for_native_thickness_without_moment_preserving_average() {
    let mut ir = stacked_two_body_multilayer_problem();
    let fdm = ir
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .expect("stacked fixture must provide FDM hints");
    fdm.default_cell = Some([2e-9, 2e-9, 1e-9]);
    fdm.cell = [2e-9, 2e-9, 1e-9];
    fdm.demag = Some(fullmag_ir::FdmDemagHintsIR {
        strategy: "multilayer_convolution".to_string(),
        mode: "two_d_stack".to_string(),
        fft_backend: "auto".to_string(),
        common_cells: None,
        common_cells_xy: Some([20, 10]),
        common_cell_size: None,
    });
    let error = plan(&ir).expect_err("2D mode must not copy a native z slice");
    assert!(error
        .reasons
        .iter()
        .any(|reason| { reason.contains("moment_preserving") || reason.contains("two_d_stack") }));
}

#[test]
fn staged_multilayer_reaches_rk4_and_rejects_rk45() {
    let mut cpu = stacked_two_body_multilayer_problem();
    let fullmag_ir::StudyIR::TimeEvolution { dynamics, .. } = &mut cpu.study else {
        panic!("bootstrap study should be time evolution");
    };
    let fullmag_ir::DynamicsIR::Llg { integrator, .. } = dynamics;
    *integrator = "rk4".to_string();
    let planned = plan(&cpu).expect("staged CPU multilayer must reach RK4");
    let BackendPlanIR::FdmMultilayer(multilayer) = planned.backend_plan else {
        panic!("expected multilayer plan");
    };
    assert_eq!(multilayer.integrator, IntegratorChoice::Rk4);

    let mut cuda = cpu;
    let mut second_material = cuda.materials[0].clone();
    second_material.name = "Py2".to_string();
    second_material.damping = 0.02;
    cuda.materials.push(second_material);
    cuda.magnets[1].material = "Py2".to_string();
    cuda.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda"}),
    );
    let fullmag_ir::StudyIR::TimeEvolution { dynamics, .. } = &mut cuda.study else {
        panic!("bootstrap study should be time evolution");
    };
    let fullmag_ir::DynamicsIR::Llg { integrator, .. } = dynamics;
    *integrator = "rk45".to_string();
    let err = plan(&cuda).expect_err("non-native staged CUDA multilayer rejects RK45");
    assert!(err.reasons.iter().any(|reason| {
        reason.contains("staged") && reason.contains("CUDA") && reason.contains("rk23")
    }));
}

#[test]
fn staged_multilayer_rejects_abm3() {
    let mut ir = stacked_two_body_multilayer_problem();
    let fullmag_ir::StudyIR::TimeEvolution { dynamics, .. } = &mut ir.study else {
        panic!("bootstrap study should be time evolution");
    };
    let fullmag_ir::DynamicsIR::Llg { integrator, .. } = dynamics;
    *integrator = "abm3".to_string();

    let err = plan(&ir).expect_err("staged CPU multilayer must reject ABM3");
    assert!(err.reasons.iter().any(|reason| {
        reason.contains("staged CPU") && reason.contains("abm3") && reason.contains("rk23")
    }));
}

#[test]
fn staged_multilayer_rejects_adaptive_rk23() {
    let mut ir = stacked_two_body_multilayer_problem();
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cpu"}),
    );
    let fullmag_ir::StudyIR::TimeEvolution { dynamics, .. } = &mut ir.study else {
        panic!("bootstrap study should be time evolution");
    };
    let fullmag_ir::DynamicsIR::Llg {
        integrator,
        fixed_timestep,
        adaptive_timestep,
        ..
    } = dynamics;
    *integrator = "rk23".to_string();
    *fixed_timestep = None;
    *adaptive_timestep = Some(fullmag_ir::AdaptiveTimeStepIR {
        tolerance_mode: fullmag_ir::AdaptiveToleranceModeIR::Advanced,
        atol: 1.0e-6,
        rtol: 1.0e-4,
        dt_initial: Some(1.0e-13),
        dt_min: 1.0e-16,
        dt_max: Some(1.0e-11),
        safety: 0.9,
        growth_limit: 2.0,
        shrink_limit: 0.2,
        max_spin_rotation: None,
        norm_tolerance: None,
    });

    let err = plan(&ir).expect_err("staged CPU multilayer must reject adaptive RK23");
    assert!(err
        .reasons
        .iter()
        .any(|reason| reason.contains("multilayer") && reason.contains("adaptive_timestep")));
}

#[test]
fn staged_multilayer_rejects_adaptive_rk23_max_error_convenience() {
    let mut ir = stacked_two_body_multilayer_problem();
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cpu"}),
    );
    let fullmag_ir::StudyIR::TimeEvolution { dynamics, .. } = &mut ir.study else {
        unreachable!()
    };
    let fullmag_ir::DynamicsIR::Llg {
        integrator,
        fixed_timestep,
        adaptive_timestep,
        ..
    } = dynamics;
    *integrator = "rk23".to_string();
    *fixed_timestep = None;
    *adaptive_timestep = Some(fullmag_ir::AdaptiveTimeStepIR {
        tolerance_mode: fullmag_ir::AdaptiveToleranceModeIR::MaxError,
        atol: 1e-6,
        rtol: 0.0,
        dt_initial: Some(1e-15),
        dt_min: 1e-16,
        dt_max: Some(1e-14),
        safety: 0.9,
        growth_limit: 2.0,
        shrink_limit: 0.2,
        max_spin_rotation: None,
        norm_tolerance: None,
    });
    let err = plan(&ir).expect_err("staged CPU multilayer must reject max-error RK23");
    assert!(err
        .reasons
        .iter()
        .any(|reason| reason.contains("multilayer") && reason.contains("adaptive_timestep")));
}

fn set_adaptive_rk45(problem: &mut ProblemIR, mode: fullmag_ir::AdaptiveToleranceModeIR) {
    let dynamics = match &mut problem.study {
        fullmag_ir::StudyIR::TimeEvolution { dynamics, .. }
        | fullmag_ir::StudyIR::Eigenmodes { dynamics, .. }
        | fullmag_ir::StudyIR::FrequencyResponse { dynamics, .. } => dynamics,
        fullmag_ir::StudyIR::Relaxation {
            dynamics: Some(dynamics),
            ..
        } => dynamics,
        _ => panic!("fixture must have dynamics"),
    };
    let fullmag_ir::DynamicsIR::Llg {
        integrator,
        fixed_timestep,
        adaptive_timestep,
        ..
    } = dynamics;
    *integrator = "rk45".to_string();
    *fixed_timestep = None;
    *adaptive_timestep = Some(fullmag_ir::AdaptiveTimeStepIR {
        tolerance_mode: mode,
        atol: 1e-6,
        rtol: 1e-4,
        dt_initial: Some(1e-15),
        dt_min: 1e-16,
        dt_max: Some(1e-14),
        safety: 0.9,
        growth_limit: 2.0,
        shrink_limit: 0.2,
        max_spin_rotation: None,
        norm_tolerance: None,
    });
}

#[test]
fn adaptive_fdm_requires_explicit_cpu_and_rejects_auto_or_cuda_routes() {
    for device in [None, Some("auto")] {
        let mut ir = ProblemIR::bootstrap_example();
        set_adaptive_rk45(&mut ir, fullmag_ir::AdaptiveToleranceModeIR::Advanced);
        if let Some(device) = device {
            ir.problem_meta.runtime_metadata.insert(
                "runtime_selection".into(),
                serde_json::json!({"device": device}),
            );
        }
        let err = plan(&ir).expect_err("automatic adaptive FDM route must fail");
        assert!(err
            .reasons
            .iter()
            .any(|reason| reason.contains("requires explicit") && reason.contains("device='cpu'")));
    }
    let mut cpu = ProblemIR::bootstrap_example();
    set_adaptive_rk45(&mut cpu, fullmag_ir::AdaptiveToleranceModeIR::Advanced);
    cpu.problem_meta.runtime_metadata.insert(
        "runtime_selection".into(),
        serde_json::json!({"device": "cpu"}),
    );
    plan(&cpu).expect("explicit CPU adaptive FDM should remain legal");
    for device in ["cuda", "gpu"] {
        let mut cuda = ProblemIR::bootstrap_example();
        set_adaptive_rk45(&mut cuda, fullmag_ir::AdaptiveToleranceModeIR::Advanced);
        cuda.problem_meta.runtime_metadata.insert(
            "runtime_selection".into(),
            serde_json::json!({"device": device}),
        );
        plan(&cuda).expect("single-grid FDM CUDA adaptive has an executable v2 timestep identity");
    }
}

#[test]
fn adaptive_fdm_geometry_guards_are_cuda_only_and_preserved() {
    let mut cuda = ProblemIR::bootstrap_example();
    set_adaptive_rk45(&mut cuda, fullmag_ir::AdaptiveToleranceModeIR::Advanced);
    cuda.problem_meta.runtime_metadata.insert(
        "runtime_selection".into(),
        serde_json::json!({"device": "cuda"}),
    );
    let fullmag_ir::StudyIR::TimeEvolution { dynamics, .. } = &mut cuda.study else {
        unreachable!()
    };
    let fullmag_ir::DynamicsIR::Llg {
        adaptive_timestep, ..
    } = dynamics;
    let adaptive = adaptive_timestep.as_mut().expect("adaptive policy");
    adaptive.max_spin_rotation = Some(0.2);
    adaptive.norm_tolerance = Some(1.0e-6);
    let planned = plan(&cuda).expect("CUDA FDM must preserve enforced geometry guards");
    let BackendPlanIR::Fdm(fdm_plan) = planned.backend_plan else {
        panic!("bootstrap CUDA fixture must produce a single-grid FDM plan");
    };
    let resolved = fdm_plan.adaptive_timestep.expect("planned adaptive policy");
    assert_eq!(resolved.max_spin_rotation, Some(0.2));
    assert_eq!(resolved.norm_tolerance, Some(1.0e-6));

    cuda.problem_meta.runtime_metadata.insert(
        "runtime_selection".into(),
        serde_json::json!({"device": "cpu"}),
    );
    let error = plan(&cuda).expect_err("CPU FDM must reject CUDA-only geometry guards");
    assert!(error.reasons.iter().any(|reason| {
        reason.contains("max_spin_rotation") && reason.contains("unsupported by CPU FDM")
    }));
    assert!(error.reasons.iter().any(|reason| {
        reason.contains("norm_tolerance") && reason.contains("unsupported by CPU FDM")
    }));
}

#[test]
fn adaptive_fdm_rejects_brown_thermal_noise_until_sde_replay_is_qualified() {
    let mut ir = ProblemIR::bootstrap_example();
    set_adaptive_rk45(&mut ir, fullmag_ir::AdaptiveToleranceModeIR::Advanced);
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".into(),
        serde_json::json!({"device": "cpu"}),
    );
    ir.temperature = Some(300.0);

    let err = plan(&ir).expect_err("adaptive Brown dynamics must fail closed");
    assert!(err.reasons.iter().any(|reason| {
        reason.contains("adaptive_timestep")
            && reason.contains("Brown thermal noise")
            && reason.contains("fixed-step Heun")
    }));
}

fn select_fixed_step_abm3(ir: &mut ProblemIR) {
    let StudyIR::TimeEvolution { dynamics, .. } = &mut ir.study else {
        panic!("ABM3 test requires time evolution");
    };
    let DynamicsIR::Llg {
        integrator,
        fixed_timestep,
        adaptive_timestep,
        ..
    } = dynamics;
    *integrator = "abm3".to_string();
    *fixed_timestep = Some(1.0e-15);
    *adaptive_timestep = None;
}

#[test]
fn fixed_step_abm3_rejects_brown_thermal_noise_until_replay_is_qualified() {
    let mut ir = ProblemIR::bootstrap_example();
    select_fixed_step_abm3(&mut ir);
    ir.temperature = Some(300.0);

    let error = plan(&ir).expect_err("ABM3 Brown dynamics must fail closed");
    assert!(error.reasons.iter().any(|reason| {
        reason.contains("ABM3")
            && reason.contains("Brown thermal noise")
            && reason.contains("fixed-step Heun")
    }));
}

#[test]
fn fixed_step_abm3_lowers_frozen_spins_for_combined_checkpoint_execution() {
    let mut ir = ProblemIR::bootstrap_example();
    select_fixed_step_abm3(&mut ir);
    ir.magnets[0].object_id = Some("strip-object".to_string());
    ir.magnetization_constraints
        .push(MagnetizationConstraintIR::FrozenSpins(FrozenSpinsIR {
            schema_version: FROZEN_SPINS_SCHEMA_VERSION.to_string(),
            id: "pin-strip".to_string(),
            name: "Pinned strip".to_string(),
            enabled: true,
            selector: SelectionExprIR::InObject {
                object_id: "strip-object".to_string(),
            },
            reference: FrozenReferencePolicyIR::CaptureCurrentAtActivation {},
            membership: SelectionMembershipPolicyIR::Static {},
            activation: ConstraintActivationIR::AllStages {},
            empty_selection: EmptySelectionPolicyIR::Error,
            inactive_selection: InactiveSelectionPolicyIR::WarnAndIntersect,
        }));

    let execution =
        plan(&ir).expect("ABM3 Frozen Spins must lower after combined checkpoint support");
    let BackendPlanIR::Fdm(fdm) = execution.backend_plan else {
        panic!("expected single-grid FDM plan");
    };
    assert_eq!(fdm.integrator, Some(IntegratorChoice::Abm3));
    let frozen = fdm
        .frozen_spins
        .expect("planner must retain the resolved Frozen Spins carrier");
    assert_eq!(frozen.constraint_ids, vec!["pin-strip"]);
    assert!(frozen.all_active_dofs_frozen);
}

#[test]
fn fem_adaptive_modes_and_geometry_guards_reach_native_plan_controls() {
    for zero_field in ["atol", "rtol"] {
        let mut ir = ProblemIR::bootstrap_example();
        ir.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fem;
        set_adaptive_rk45(&mut ir, fullmag_ir::AdaptiveToleranceModeIR::Advanced);
        let fullmag_ir::StudyIR::TimeEvolution { dynamics, .. } = &mut ir.study else {
            unreachable!()
        };
        let fullmag_ir::DynamicsIR::Llg {
            adaptive_timestep, ..
        } = dynamics;
        let adaptive = adaptive_timestep.as_mut().unwrap();
        if zero_field == "atol" {
            adaptive.atol = 0.0;
        } else {
            adaptive.rtol = 0.0;
        }
        adaptive.safety = 1.0;
        adaptive.max_spin_rotation = Some(0.2);
        adaptive.norm_tolerance = Some(1.0e-3);
        let mut errors = Vec::new();
        let controls = validate::planned_study_controls(&ir, BackendTarget::Fem, &mut errors);
        assert!(errors.is_empty(), "{zero_field}: {errors:?}");
        let resolved = controls.adaptive_timestep.expect("adaptive controls");
        assert_eq!(resolved.max_spin_rotation, Some(0.2));
        assert_eq!(resolved.norm_tolerance, Some(1.0e-3));
    }

    let mut max_error = ProblemIR::bootstrap_example();
    max_error.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fem;
    set_adaptive_rk45(
        &mut max_error,
        fullmag_ir::AdaptiveToleranceModeIR::MaxError,
    );
    let fullmag_ir::StudyIR::TimeEvolution { dynamics, .. } = &mut max_error.study else {
        unreachable!()
    };
    let fullmag_ir::DynamicsIR::Llg {
        adaptive_timestep, ..
    } = dynamics;
    let adaptive = adaptive_timestep.as_mut().expect("adaptive policy");
    adaptive.rtol = 0.0;
    let mut errors = Vec::new();
    validate::planned_study_controls(&max_error, BackendTarget::Fem, &mut errors);
    assert!(errors.is_empty(), "maximum-error FEM controls: {errors:?}");
}

#[test]
fn native_cuda_three_d_identity_multilayer_keeps_supported_non_heun_integrators() {
    let mut ir = cuda_three_d_identity_multilayer_problem();
    let fullmag_ir::StudyIR::TimeEvolution { dynamics, .. } = &mut ir.study else {
        panic!("bootstrap study should be time evolution");
    };
    let fullmag_ir::DynamicsIR::Llg { integrator, .. } = dynamics;
    *integrator = "rk4".to_string();
    let planned = plan(&ir).expect("native CUDA multilayer v2 supports three_d identity RK4");
    let BackendPlanIR::FdmMultilayer(plan) = planned.backend_plan else {
        panic!("expected multilayer plan");
    };
    assert_eq!(plan.integrator, IntegratorChoice::Rk4);
}

#[test]
fn native_stacked_cuda_shape_does_not_admit_abi_v2_pair_payload() {
    let mut ir = cuda_three_d_identity_multilayer_problem();
    ir.backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .and_then(|fdm| fdm.demag.as_mut())
        .expect("CUDA fixture must provide demag hints")
        .strategy = "auto".to_string();
    let fullmag_ir::StudyIR::TimeEvolution { dynamics, .. } = &mut ir.study else {
        panic!("bootstrap study should be time evolution");
    };
    let fullmag_ir::DynamicsIR::Llg { integrator, .. } = dynamics;
    *integrator = "rk4".to_string();

    let planned = plan(&ir).expect("RK4 auto stack must resolve to native single-grid CUDA");
    let BackendPlanIR::FdmMultilayer(plan) = planned.backend_plan else {
        panic!("expected multilayer plan");
    };
    assert_eq!(plan.integrator, IntegratorChoice::Rk4);
    assert_eq!(plan.planner_summary.estimated_pair_kernels, 0);
    assert_eq!(plan.planner_summary.estimated_unique_kernels, 0);
    assert_eq!(plan.planner_summary.estimated_kernel_bytes, 0);
    assert!(plan
        .planner_summary
        .warnings
        .iter()
        .all(|warning| !warning.contains("cuda_abi_v2_l_squared_pair_payload")));
}

#[test]
fn device_resident_d07_shape_retains_abi_v2_pair_payload_admission() {
    let mut ir = cuda_three_d_identity_multilayer_problem();
    ir.backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .and_then(|fdm| fdm.demag.as_mut())
        .expect("CUDA fixture must provide demag hints")
        .strategy = "auto".to_string();

    let planned = plan(&ir).expect("FP64 Heun auto stack must resolve to D-07 ABI v2");
    let BackendPlanIR::FdmMultilayer(plan) = planned.backend_plan else {
        panic!("expected multilayer plan");
    };
    assert_eq!(plan.integrator, IntegratorChoice::Heun);
    assert_eq!(plan.planner_summary.estimated_pair_kernels, 4);
    assert!(plan.planner_summary.estimated_unique_kernels > 0);
    assert!(plan.planner_summary.estimated_kernel_bytes > 0);
    assert!(plan
        .planner_summary
        .warnings
        .iter()
        .any(|warning| warning.contains("cuda_abi_v2_l_squared_pair_payload")));
}

#[test]
fn checked_multilayer_aggregate_memory_accepts_exact_boundary_and_rejects_next_byte() {
    assert_eq!(
        crate::checked_multilayer_aggregate_memory_bytes(crate::FDM_GRID_MAX_BYTES - 2, 1, 1,)
            .expect("exact aggregate boundary"),
        crate::FDM_GRID_MAX_BYTES
    );
    let error =
        crate::checked_multilayer_aggregate_memory_bytes(crate::FDM_GRID_MAX_BYTES - 1, 1, 1)
            .expect_err("one byte above aggregate boundary must fail");
    assert!(error
        .reasons
        .iter()
        .any(|reason| reason.contains("aggregate memory budget exceeded")));

    let overflow = crate::checked_multilayer_aggregate_memory_bytes(u64::MAX, 1, 0)
        .expect_err("aggregate addition overflow must fail closed");
    assert!(overflow
        .reasons
        .iter()
        .any(|reason| reason.contains("aggregate memory overflow")));
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
fn multilayer_planner_materializes_region_membership_and_linear_ms_per_layer() {
    let mut ir = stacked_two_body_multilayer_problem();
    let mut region = fullmag_ir::ObjectRegionIR {
        owner_object: "free".to_string(),
        region_id: "free:core".to_string(),
        ..default_test_object_region()
    };
    region.shape = fullmag_ir::RegionShapeIR::Box {
        size: [20e-9, 20e-9, 2e-9],
        center: [0.0, 0.0, 0.0],
    };
    ir.object_regions.push(region);
    ir.material_parameter_fields
        .push(fullmag_ir::MaterialParameterAssignmentIR {
            assignment_id: "free_linear_ms".to_string(),
            owner_object: "free".to_string(),
            region_id: None,
            parameter: fullmag_ir::MaterialParameterNameIR::Ms,
            value: fullmag_ir::MaterialParameterFieldIR::Linear {
                base: 800e3,
                gradient: [1e12, 0.0, 0.0],
                frame: fullmag_ir::RegionFrameIR::Object,
                unit: Some("A/m".to_string()),
            },
            priority: 10,
            conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
        });
    for (assignment_id, parameter, base, gradient, unit) in [
        (
            "free_linear_aex",
            fullmag_ir::MaterialParameterNameIR::Aex,
            13e-12,
            1e-4,
            "J/m",
        ),
        (
            "free_linear_alpha",
            fullmag_ir::MaterialParameterNameIR::Alpha,
            0.1,
            1e-5,
            "1",
        ),
    ] {
        ir.material_parameter_fields
            .push(fullmag_ir::MaterialParameterAssignmentIR {
                assignment_id: assignment_id.to_string(),
                owner_object: "free".to_string(),
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
            });
    }

    let planned = plan(&ir).expect("multilayer regions and linear Ms must lower per layer");
    let BackendPlanIR::FdmMultilayer(multilayer) = planned.backend_plan else {
        panic!("expected multilayer FDM plan");
    };
    let free = multilayer
        .layers
        .iter()
        .find(|layer| layer.object_id == "free")
        .expect("free layer");
    assert_eq!(free.native_region_mask.as_ref().map(Vec::len), Some(200));
    let legend = free.native_region_legend.as_ref().expect("region legend");
    assert_eq!(legend.len(), 1);
    assert_eq!(legend[0].numeric_id, 1);
    assert_eq!(legend[0].object_id, "free");
    assert_eq!(legend[0].region_id, "free:core");
    let ms_field = free.material.ms_field.as_ref().expect("linear Ms field");
    assert_eq!(ms_field.len(), 200);
    assert_ne!(ms_field[0], ms_field[19]);
    let a_field = free
        .material
        .a_field
        .as_ref()
        .expect("sub-absolute-tolerance Aex gradient must remain non-uniform");
    assert_eq!(a_field.len(), 200);
    assert_ne!(a_field[0], a_field[19]);
    let alpha_field = free
        .material
        .alpha_field
        .as_ref()
        .expect("sub-absolute-tolerance Alpha gradient must remain non-uniform");
    assert_eq!(alpha_field.len(), 200);
    assert_ne!(alpha_field[0], alpha_field[19]);
    assert!(planned.common.material_field_plans.iter().any(|field| {
        field.object_id == "free" && field.parameter == fullmag_ir::MaterialParameterNameIR::Ms
    }));
}

#[test]
fn forced_cuda_multilayer_rejects_cellwise_material_fields_with_layer_identity() {
    for (parameter, field_name, base, gradient, unit) in [
        (
            fullmag_ir::MaterialParameterNameIR::Ms,
            "ms_field",
            800e3,
            1e12,
            "A/m",
        ),
        (
            fullmag_ir::MaterialParameterNameIR::Aex,
            "a_field",
            13e-12,
            1e-4,
            "J/m",
        ),
        (
            fullmag_ir::MaterialParameterNameIR::Alpha,
            "alpha_field",
            0.1,
            1e-5,
            "1",
        ),
    ] {
        let mut ir = stacked_two_body_multilayer_problem();
        ir.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            serde_json::json!({"device": "cuda"}),
        );
        ir.material_parameter_fields
            .push(fullmag_ir::MaterialParameterAssignmentIR {
                assignment_id: format!("free_linear_{field_name}"),
                owner_object: "free".to_string(),
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
            });

        let error = plan(&ir).expect_err("forced CUDA must reject cellwise material fields");
        let diagnostic = error.reasons.join("\n");
        for expected in [
            "fdm_cuda_multilayer_material_field_unqualified",
            field_name,
            "layer:free",
            "free",
        ] {
            assert!(
                diagnostic.contains(expected),
                "missing {expected:?} in planner diagnostic: {diagnostic}"
            );
        }
    }
}

#[test]
fn forced_cuda_explicit_single_magnet_multilayer_uses_multilayer_material_field_reason() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda"}),
    );
    ir.backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .expect("bootstrap fixture must provide FDM hints")
        .demag = Some(fullmag_ir::FdmDemagHintsIR {
        strategy: "multilayer_convolution".to_string(),
        mode: "three_d".to_string(),
        fft_backend: "auto".to_string(),
        common_cells: None,
        common_cells_xy: None,
        common_cell_size: None,
    });
    ir.material_parameter_fields
        .push(fullmag_ir::MaterialParameterAssignmentIR {
            assignment_id: "strip_linear_ms".to_string(),
            owner_object: "strip".to_string(),
            region_id: None,
            parameter: fullmag_ir::MaterialParameterNameIR::Ms,
            value: fullmag_ir::MaterialParameterFieldIR::Linear {
                base: 800e3,
                gradient: [1e9, 0.0, 0.0],
                frame: fullmag_ir::RegionFrameIR::Object,
                unit: Some("A/m".to_string()),
            },
            priority: 10,
            conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
        });

    let error = plan(&ir).expect_err("explicit multilayer CUDA must reject cellwise Ms");
    let diagnostic = error.reasons.join("\n");
    for expected in [
        "fdm_cuda_multilayer_material_field_unqualified",
        "ms_field",
        "layer:strip",
        "object 'strip'",
    ] {
        assert!(
            diagnostic.contains(expected),
            "missing {expected:?} in planner diagnostic: {diagnostic}"
        );
    }
}

#[test]
fn multilayer_planner_materializes_translated_object_frame_region_membership() {
    let mut ir = stacked_two_body_multilayer_problem();
    let GeometryEntryIR::Translate { by, .. } = &mut ir.geometry.entries[0] else {
        panic!("fixture free geometry must be translated");
    };
    *by = [30e-9, 0.0, 0.0];
    let mut region = fullmag_ir::ObjectRegionIR {
        owner_object: "free".to_string(),
        region_id: "free:translated_core".to_string(),
        ..default_test_object_region()
    };
    region.shape = fullmag_ir::RegionShapeIR::Box {
        size: [20e-9, 20e-9, 2e-9],
        center: [0.0, 0.0, 0.0],
    };
    ir.object_regions.push(region);

    let planned = plan(&ir).expect("object-frame region must follow its translated owner");
    let BackendPlanIR::FdmMultilayer(multilayer) = planned.backend_plan else {
        panic!("expected multilayer FDM plan");
    };
    let free = multilayer
        .layers
        .iter()
        .find(|layer| layer.object_id == "free")
        .expect("free layer");
    assert!(free
        .native_region_mask
        .as_deref()
        .is_some_and(|mask| mask.iter().any(|numeric_id| *numeric_id == 1)));
    assert!(free.native_region_legend.as_deref().is_some_and(|legend| {
        legend.iter().any(|entry| {
            entry.numeric_id == 1
                && entry.object_id == "free"
                && entry.region_id == "free:translated_core"
        })
    }));
}

#[test]
fn multilayer_planner_allows_coplanar_bodies_with_disjoint_xy_projections() {
    let mut ir = stacked_two_body_multilayer_problem();
    let GeometryEntryIR::Translate { by, .. } = &mut ir.geometry.entries[1] else {
        panic!("fixture reference geometry must be translated");
    };
    *by = [50e-9, 0.0, 0.0];

    plan(&ir).expect("disjoint XY bodies may share their z interval");
}

#[test]
fn multilayer_planner_allows_diagonally_disjoint_cylinders_with_overlapping_aabbs() {
    let mut ir = stacked_two_body_multilayer_problem();
    ir.geometry.entries = vec![
        GeometryEntryIR::Translate {
            name: "free_geom".to_string(),
            base: std::boxed::Box::new(GeometryEntryIR::Cylinder {
                name: "free_base".to_string(),
                radius: 10e-9,
                height: 2e-9,
                axis: [0.0, 0.0, 1.0],
            }),
            by: [0.0, 0.0, 0.0],
        },
        GeometryEntryIR::Translate {
            name: "ref_geom".to_string(),
            base: std::boxed::Box::new(GeometryEntryIR::Cylinder {
                name: "ref_base".to_string(),
                radius: 10e-9,
                height: 2e-9,
                axis: [0.0, 0.0, 1.0],
            }),
            by: [15e-9, 15e-9, 0.0],
        },
    ];

    plan(&ir).expect("diagonally disjoint cylinders may share their z interval");
}

#[test]
fn multilayer_planner_rejects_positive_xy_and_z_volume_overlap() {
    let mut ir = stacked_two_body_multilayer_problem();
    let GeometryEntryIR::Translate { by, .. } = &mut ir.geometry.entries[1] else {
        panic!("fixture reference geometry must be translated");
    };
    *by = [10e-9, 0.0, 0.0];

    let err = plan(&ir).expect_err("positive physical volume overlap must fail closed");
    assert!(err
        .reasons
        .iter()
        .any(|reason| reason.contains("overlapping bodies")));
}

#[test]
fn multilayer_planner_rejects_translated_sphere_box_volume_overlap() {
    let mut ir = stacked_two_body_multilayer_problem();
    ir.geometry.entries = vec![
        GeometryEntryIR::Translate {
            name: "free_geom".to_string(),
            base: std::boxed::Box::new(GeometryEntryIR::Sphere {
                name: "free_sphere".to_string(),
                radius: 8e-9,
            }),
            by: [0.0, 0.0, 0.0],
        },
        GeometryEntryIR::Translate {
            name: "ref_geom".to_string(),
            base: std::boxed::Box::new(GeometryEntryIR::Box {
                name: "ref_box".to_string(),
                size: [20e-9, 20e-9, 2e-9],
            }),
            by: [2e-9, 0.0, 0.0],
        },
    ];

    let err = plan(&ir).expect_err("translated sphere and box volume overlap must fail closed");
    assert!(err
        .reasons
        .iter()
        .any(|reason| reason.contains("overlapping bodies")));
}

#[test]
fn multilayer_planner_fails_closed_for_csg_body_overlap() {
    let mut ir = stacked_two_body_multilayer_problem();
    ir.geometry.entries[0] = GeometryEntryIR::Difference {
        name: "free_geom".to_string(),
        base: std::boxed::Box::new(GeometryEntryIR::Box {
            name: "free_base".to_string(),
            size: [40e-9, 20e-9, 2e-9],
        }),
        tool: std::boxed::Box::new(GeometryEntryIR::Cylinder {
            name: "free_hole".to_string(),
            radius: 2e-9,
            height: 2e-9,
            axis: [0.0, 0.0, 1.0],
        }),
    };
    let GeometryEntryIR::Translate { by, .. } = &mut ir.geometry.entries[1] else {
        panic!("fixture reference geometry must be translated");
    };
    *by = [0.0, 0.0, 0.0];

    let err = plan(&ir).expect_err("CSG overlap must not be guessed from a bounding box");
    assert!(err
        .reasons
        .iter()
        .any(|reason| reason.contains("cannot safely classify overlap")));
}

#[test]
fn multilayer_planner_materializes_supported_csg_region_and_rejects_unsupported_coupling() {
    let mut region_problem = stacked_two_body_multilayer_problem();
    let mut region = default_test_object_region();
    region.owner_object = "free".to_string();
    region.region_id = "free:csg".to_string();
    region.shape = fullmag_ir::RegionShapeIR::Csg {
        expression: std::boxed::Box::new(GeometryEntryIR::Box {
            name: "unsupported_region_shape".to_string(),
            size: [10e-9, 10e-9, 2e-9],
        }),
    };
    region_problem.object_regions.push(region);
    let region_plan = plan(&region_problem).expect("supported CSG region must materialize");
    let BackendPlanIR::FdmMultilayer(multilayer) = region_plan.backend_plan else {
        panic!("expected multilayer FDM plan");
    };
    let free = multilayer
        .layers
        .iter()
        .find(|layer| layer.object_id == "free")
        .expect("free layer");
    assert!(free
        .native_region_mask
        .as_deref()
        .is_some_and(|mask| { mask.iter().any(|numeric_id| *numeric_id == 1) }));
    assert!(free.native_region_legend.as_deref().is_some_and(|legend| {
        legend
            .iter()
            .any(|entry| entry.region_id == "free:csg" && entry.numeric_id == 1)
    }));

    let mut coupling_problem = stacked_two_body_multilayer_problem();
    coupling_problem.couplings.push(fullmag_ir::CouplingIR {
        coupling_id: "free-ref-exchange".to_string(),
        kind: fullmag_ir::CouplingKindIR::Exchange,
        enabled: true,
        source: fullmag_ir::CouplingEndpointIR::Object {
            object: "free".to_string(),
        },
        target: fullmag_ir::CouplingEndpointIR::Object {
            object: "ref".to_string(),
        },
        parameters: fullmag_ir::CouplingParametersIR::Exchange {
            mode: fullmag_ir::ExchangeCouplingModeIR::Explicit,
            scale: None,
            inter_exchange: Some(1e-12),
        },
        capability_policy: fullmag_ir::CouplingCapabilityPolicyIR::RequireRuntime,
    });
    let coupling_error = plan(&coupling_problem).expect_err("unsupported coupling must fail");
    assert!(coupling_error
        .reasons
        .iter()
        .any(|reason| reason.contains("coupling")));
}

#[test]
fn multilayer_planner_ignores_disabled_object_regions() {
    let mut ir = stacked_two_body_multilayer_problem();
    let mut region = default_test_object_region();
    region.owner_object = "free".to_string();
    region.region_id = "free:r1".to_string();
    region.enabled = false;
    ir.object_regions.push(region);

    plan(&ir).expect("disabled object regions must not affect multilayer FDM planning");
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
        id: None,
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
fn multilayer_planner_rejects_field_drives_until_plan_owns_them() {
    let mut ir = stacked_two_body_multilayer_problem();
    ir.field_drives.push(RegionalFieldDriveIR {
        id: "multilayer-drive".to_string(),
        name: "Multilayer drive".to_string(),
        kind: FieldDriveKindIR::Regional,
        enabled: true,
        target: FieldTargetIR::Global {},
        amplitude_b_t: 1.0e-3,
        direction: [0.0, 1.0, 0.0],
        spatial_profile: FieldSpatialProfileIR::Uniform {},
        waveform: TimeDependenceIR::Constant,
        time_origin: FieldTimeOriginIR::StageLocal,
        activation: DriveActivationIR::AllTimeEvolution {},
        migration: None,
    });

    let error = plan(&ir).expect_err("multilayer FDM must not drop an authored field drive");

    assert!(
        error.reasons.iter().any(
            |reason| reason.contains("RegionalFieldDrive") && reason.contains("multilayer FDM")
        ),
        "unexpected planner errors: {:?}",
        error.reasons
    );
}

#[test]
fn stacked_two_body_problem_lowers_to_multilayer_plan() {
    let mut ir = stacked_two_body_multilayer_problem_with_dmi();
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda"}),
    );
    let fdm = ir
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .expect("stacked fixture must provide FDM hints");
    fdm.demag = Some(fullmag_ir::FdmDemagHintsIR {
        strategy: "multilayer_convolution".to_string(),
        mode: "three_d".to_string(),
        fft_backend: "auto".to_string(),
        common_cells: Some([20, 10, 1]),
        common_cells_xy: None,
        common_cell_size: None,
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
            assert_eq!(multilayer.bulk_dmi, None);
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
    let explicit_error = plan(&ir).expect_err(
        "explicit multilayer_convolution must not use the native single-grid fast path",
    );
    assert!(explicit_error
        .reasons
        .iter()
        .any(|reason| { reason.contains("staged CUDA") && reason.contains("rk45") }));

    ir.backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .and_then(|fdm| fdm.demag.as_mut())
        .expect("stacked fixture must provide demag hints")
        .strategy = "auto".to_string();
    let auto_plan = plan(&ir).expect("auto strategy preserves the legal native CUDA fast path");
    let BackendPlanIR::FdmMultilayer(multilayer) = auto_plan.backend_plan else {
        panic!("expected FDM multilayer plan");
    };
    assert_eq!(multilayer.integrator, fullmag_ir::IntegratorChoice::Rk45);

    ir.backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .and_then(|fdm| fdm.demag.as_mut())
        .expect("stacked fixture must provide demag hints")
        .strategy = "multilayer_convolution".to_string();

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
    let staged = plan(&ir).expect("heterogeneous-material CUDA multilayer RK23 should lower");
    match staged.backend_plan {
        BackendPlanIR::FdmMultilayer(multilayer) => {
            assert_eq!(multilayer.integrator, fullmag_ir::IntegratorChoice::Rk23);
        }
        other => panic!("expected FDM multilayer plan, got {other:?}"),
    }
}

#[test]
fn multilayer_planner_materializes_xy_offset_in_common_scratch_transfer() {
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
            object_id: None,
            name: "free".to_string(),
            region: "free_region".to_string(),
            material: "Py".to_string(),
            initial_magnetization: None,
            absorbing_boundary: None,
        },
        fullmag_ir::MagnetIR {
            object_id: None,
            name: "ref".to_string(),
            region: "ref_region".to_string(),
            material: "Py".to_string(),
            initial_magnetization: None,
            absorbing_boundary: None,
        },
    ];
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::Auto,
        },
    ];

    let planned =
        plan(&ir).expect("XY-offset multilayer geometry should lower to scratch transfer");
    let BackendPlanIR::FdmMultilayer(multilayer) = planned.backend_plan else {
        panic!("expected FDM multilayer plan");
    };
    assert_eq!(multilayer.common_cells, [25, 10, 1]);
    for (actual, expected) in multilayer.layers[0]
        .convolution_origin
        .into_iter()
        .zip([-20e-9, -10e-9, -1e-9])
    {
        assert!((actual - expected).abs() < 1e-24);
    }
    for (actual, expected) in multilayer.layers[1]
        .convolution_origin
        .into_iter()
        .zip([-20e-9, -10e-9, 3e-9])
    {
        assert!((actual - expected).abs() < 1e-24);
    }
    assert!(multilayer
        .layers
        .iter()
        .all(|layer| layer.transfer_kind == "push_pull"));
    assert!(multilayer
        .planner_summary
        .warnings
        .iter()
        .any(|warning| warning.contains("xy_geometry_uses_common_scratch_transfer")));
}

#[test]
fn multilayer_planner_lowers_distinct_xy_extents_and_centers() {
    let mut ir = stacked_two_body_multilayer_problem();
    let GeometryEntryIR::Translate { base, by, .. } = &mut ir.geometry.entries[1] else {
        panic!("stacked fixture reference geometry must be translated");
    };
    let GeometryEntryIR::Box { size, .. } = base.as_mut() else {
        panic!("stacked fixture reference geometry must be a box");
    };
    *size = [20e-9, 10e-9, 2e-9];
    *by = [10e-9, 5e-9, 4e-9];

    let planned = plan(&ir).expect(
        "planner must lower distinct XY extents/centers into a multilayer descriptor before runtime qualification",
    );
    let BackendPlanIR::FdmMultilayer(multilayer) = planned.backend_plan else {
        panic!("expected FDM multilayer plan");
    };
    assert_ne!(
        multilayer.layers[0].native_grid,
        multilayer.layers[1].native_grid
    );
    assert_ne!(
        multilayer.layers[0].native_origin,
        multilayer.layers[1].native_origin
    );
}

#[test]
fn xy_transfer_does_not_promote_native_cuda_integrator_lane() {
    let mut ir = stacked_two_body_multilayer_problem();
    let GeometryEntryIR::Translate { by, .. } = &mut ir.geometry.entries[1] else {
        panic!("stacked fixture reference geometry must be translated");
    };
    by[0] = 10e-9;
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda", "device_index": 0}),
    );
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

    let error = plan(&ir).expect_err(
        "native CUDA multilayer must remain fail-closed when XY transfer descriptors are required",
    );
    assert!(error.reasons.iter().any(|reason| {
        reason.contains("staged CUDA multilayer FDM runner supports only")
            && reason.contains("rk45")
    }));
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
            projection_policy: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                element_markers: vec![1],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
        bias_field_sweep: None,
        normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
        damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            stage_autosave: None,
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
    let dispersion_validation = serde_json::json!({
        "kind": "thin_film_de_bv_low_k",
        "analytic_model": "kalinikos_slab_n0",
        "film_thickness_m": 80.0e-9,
        "equilibrium_magnetization": [1.0, 0.0, 0.0],
        "film_normal": [0.0, 0.0, 1.0],
        "max_k_rad_per_m": 3.0e6,
        "max_relative_error": 0.10,
        "frequency_window_hz": {
            "min": 0.0,
            "max": 5.0e9
        },
        "scenarios": [
            {
                "geometry": "backward_volume",
                "branch_id": "branch_0",
                "sample_indices": [0, 1, 2]
            },
            {
                "geometry": "damon_eshbach",
                "branch_id": "branch_0",
                "sample_indices": [0, 3, 4]
            }
        ]
    });
    ir.problem_meta.runtime_metadata.insert(
        "dispersion_validation".to_string(),
        dispersion_validation.clone(),
    );

    let planned = plan(&ir).expect("FEM eigen mesh asset should produce a FemEigenPlanIR");
    match planned.backend_plan {
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
            let planned_validation = serde_json::to_value(&fem.dispersion_validation)
                .expect("dispersion_validation should serialize");
            assert_eq!(planned_validation, serde_json::json!(dispersion_validation));
        }
        other => panic!("expected FEM eigen plan, got {other:?}"),
    }

    let mut invalid = ir;
    invalid.problem_meta.runtime_metadata.insert(
        "dispersion_validation".to_string(),
        serde_json::json!({
            "kind": "thin_film_de_bv_low_k",
            "analytic_model": "kalinikos_slab_n0",
            "film_thickness_m": 80.0e-9,
            "equilibrium_magnetization": [1.0, 0.0, 0.0],
            "film_normal": [0.0, 0.0, 1.0],
            "max_k_rad_per_m": 4.0e6,
            "frequency_window_hz": {
                "min": 0.0,
                "max": 5.0e9
            },
            "scenarios": [
                {
                    "geometry": "backward_volume",
                    "branch_id": "branch_0",
                    "sample_indices": [0, 1, 2]
                },
                {
                    "geometry": "damon_eshbach",
                    "branch_id": "branch_0",
                    "sample_indices": [0, 3, 4]
                }
            ]
        }),
    );
    let err =
        plan(&invalid).expect_err("FEM eigen dispersion validation must reject broad k range");
    assert!(err
        .reasons
        .iter()
        .any(|reason| reason.contains("max_k_rad_per_m")));
}

#[test]
fn fem_eigen_carries_k0_kittel_validation_from_runtime_metadata() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: Vec::new(),
        fem_mesh_assets: vec![fullmag_ir::FemMeshAssetIR {
            geometry_name: "strip".to_string(),
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "uniform_layer".to_string(),
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
            }),
        }],
        fem_domain_mesh_asset: None,
    });
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Zeeman { b: [0.1, 0.0, 0.0] },
    ];
    ir.study = fullmag_ir::StudyIR::Eigenmodes {
        dynamics: ir.study.dynamics().clone(),
        operator: fullmag_ir::EigenOperatorConfigIR {
            kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 1,
        target: fullmag_ir::EigenTargetIR::Lowest,
        equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
        k_sampling: Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        }),
        bias_field_sweep: None,
        normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
        damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            stage_autosave: None,
            outputs: vec![fullmag_ir::OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            }],
        },
        mode_tracking: None,
    };
    let k0_kittel_validation = serde_json::json!({
        "kind": "k0_kittel_field_sweep",
        "model": "thin_film_in_plane",
        "field_units": "A_per_m",
        "relative_tolerance": 0.05,
        "material": {
            "effective_magnetisation": 800000.0
        },
        "samples": [
            {"sample_index": 0, "bias_field": [40000.0, 0.0, 0.0]},
            {"sample_index": 1, "bias_field": [80000.0, 0.0, 0.0]},
            {"sample_index": 2, "bias_field": [120000.0, 0.0, 0.0]}
        ]
    });
    ir.problem_meta.runtime_metadata.insert(
        "k0_kittel_validation".to_string(),
        k0_kittel_validation.clone(),
    );

    let planned = plan(&ir).expect("FEM eigen plan should carry k0 Kittel validation");
    match planned.backend_plan {
        BackendPlanIR::FemEigen(fem) => {
            let planned_validation = serde_json::to_value(&fem.k0_kittel_validation)
                .expect("k0_kittel_validation should serialize");
            assert_eq!(planned_validation, serde_json::json!(k0_kittel_validation));
        }
        other => panic!("expected FEM eigen plan, got {other:?}"),
    }

    let mut invalid = ir;
    invalid.problem_meta.runtime_metadata.insert(
        "k0_kittel_validation".to_string(),
        serde_json::json!({
            "kind": "k0_kittel_field_sweep",
            "model": "macrospin_larmor",
            "field_units": "A_per_m",
            "relative_tolerance": 0.05,
            "samples": [
                {"sample_index": 0, "bias_field": [40000.0, 0.0, 0.0]},
                {"sample_index": 1, "bias_field": [80000.0, 0.0, 0.0]}
            ]
        }),
    );
    let err =
        plan(&invalid).expect_err("FEM eigen k0 Kittel validation must require three samples");
    assert!(err
        .reasons
        .iter()
        .any(|reason| reason.contains("k0_kittel_validation.samples")));

    let mut unsupported_demag_kind = invalid;
    unsupported_demag_kind.problem_meta.runtime_metadata.insert(
        "k0_kittel_validation".to_string(),
        serde_json::json!({
            "kind": "k0_kittel_field_sweep",
            "case_id": "K0-3",
            "demag_kind": "unvalidated_airbox",
            "model": "thin_film_in_plane",
            "field_units": "A_per_m",
            "relative_tolerance": 0.02,
            "material": {
                "effective_magnetisation": 800000.0
            },
            "samples": [
                {"sample_index": 0, "bias_field": [40000.0, 0.0, 0.0]},
                {"sample_index": 1, "bias_field": [80000.0, 0.0, 0.0]},
                {"sample_index": 2, "bias_field": [120000.0, 0.0, 0.0]}
            ]
        }),
    );
    let err = plan(&unsupported_demag_kind).expect_err("unknown K0 Kittel demag_kind must fail");
    assert!(err
        .reasons
        .iter()
        .any(|reason| reason.contains("demag_kind") && reason.contains("periodic_airbox_k0")));
}

#[test]
fn fem_eigen_allows_k0_kittel_synthetic_demag_factor_floquet_path() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: Vec::new(),
        fem_mesh_assets: Vec::new(),
        fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "uniform_layer".to_string(),
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
                element_markers: vec![1, 0],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [4, 5, 6]]),
                boundary_markers: vec![10, 99],
                periodic_boundary_pairs: vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
                    pair_id: "x_faces".to_string(),
                    source_marker: None,
                    destination_marker: None,
                    marker_a: 10,
                    marker_b: 11,
                    translation: Some([1.0, 0.0, 0.0]),
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
            object_region_markers: Vec::new(),
            build_report: None,
        }),
    });
    if let Some(mesh) = ir
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .and_then(|asset| asset.mesh.as_mut())
    {
        complete_test_airbox_boundaries(mesh);
    }
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::default(),
        },
        fullmag_ir::EnergyTermIR::Zeeman {
            b: [0.02, 0.0, 0.0],
        },
    ];
    ir.problem_meta.runtime_metadata.insert(
        "k0_kittel_validation".to_string(),
        serde_json::json!({
            "kind": "k0_kittel_field_sweep",
            "case_id": "K0-3",
            "demag_kind": "synthetic_demag_factor",
            "model": "thin_film_in_plane",
            "field_units": "A_per_m",
            "relative_tolerance": 0.02,
            "material": {
                "effective_magnetisation": 800000.0
            },
            "samples": [
                {"sample_index": 0, "bias_field": [15915.494309189535, 0.0, 0.0]},
                {"sample_index": 1, "bias_field": [39788.735772973836, 0.0, 0.0]},
                {"sample_index": 2, "bias_field": [79577.47154594767, 0.0, 0.0]}
            ]
        }),
    );
    ir.study = fullmag_ir::StudyIR::Eigenmodes {
        dynamics: ir.study.dynamics().clone(),
        operator: fullmag_ir::EigenOperatorConfigIR {
            kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
            include_demag: true,
        },
        count: 1,
        target: fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 100.0e6,
            frequency_max_hz: 25.0e9,
        },
        equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
        k_sampling: Some(fullmag_ir::KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR {
                    label: Some("H20mT".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("H100mT".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![2],
            closed: false,
        }),
        bias_field_sweep: None,
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
        magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            stage_autosave: None,
            outputs: vec![fullmag_ir::OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            }],
        },
        mode_tracking: None,
    };

    let planned = plan(&ir).expect("K0-3 synthetic demag-factor Floquet field sweep is k=0");
    match planned.backend_plan {
        BackendPlanIR::FemEigen(fem) => {
            assert!(fem.operator.include_demag);
            assert_eq!(
                fem.k0_kittel_validation
                    .as_ref()
                    .and_then(|validation| validation.demag_kind.as_deref()),
                Some("synthetic_demag_factor")
            );
        }
        other => panic!("expected FEM eigen plan, got {other:?}"),
    }
}

fn k0_periodic_airbox_fem_eigen_ir() -> ProblemIR {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: Vec::new(),
        fem_mesh_assets: Vec::new(),
        fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "uniform_layer_airbox".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [2.0, 0.0, 0.0],
                    [3.0, 0.0, 0.0],
                    [2.0, 1.0, 0.0],
                    [2.0, 0.0, 1.0],
                ],
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
                element_markers: vec![1, 0],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [4, 5, 6]]),
                boundary_markers: vec![10, 99],
                periodic_boundary_pairs: vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
                    pair_id: "x_faces".to_string(),
                    source_marker: None,
                    destination_marker: None,
                    marker_a: 10,
                    marker_b: 11,
                    translation: Some([1.0, 0.0, 0.0]),
                    tolerance: None,
                    axis_hint: None,
                    orientation: None,
                    pairing_policy: None,
                }],
                periodic_node_pairs: vec![
                    fullmag_ir::MeshPeriodicNodePairIR {
                        pair_id: "x_faces".to_string(),
                        node_a: 0,
                        node_b: 1,
                    },
                    fullmag_ir::MeshPeriodicNodePairIR {
                        pair_id: "x_faces".to_string(),
                        node_a: 4,
                        node_b: 5,
                    },
                ],
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            object_region_markers: Vec::new(),
            build_report: None,
        }),
    });
    if let Some(mesh) = ir
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .and_then(|asset| asset.mesh.as_mut())
    {
        complete_test_airbox_boundaries(mesh);
    }
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::default(),
        },
        fullmag_ir::EnergyTermIR::Zeeman {
            b: [0.02, 0.0, 0.0],
        },
    ];
    ir.problem_meta.runtime_metadata.insert(
        "k0_kittel_validation".to_string(),
        serde_json::json!({
            "kind": "k0_kittel_field_sweep",
            "case_id": "K0-3",
            "demag_kind": "periodic_airbox_k0",
            "model": "thin_film_in_plane",
            "field_units": "A_per_m",
            "relative_tolerance": 0.02,
            "material": {
                "effective_magnetisation": 800000.0
            },
            "samples": [
                {"sample_index": 0, "bias_field": [15915.494309189535, 0.0, 0.0]},
                {"sample_index": 1, "bias_field": [39788.735772973836, 0.0, 0.0]},
                {"sample_index": 2, "bias_field": [79577.47154594767, 0.0, 0.0]}
            ]
        }),
    );
    ir.study = fullmag_ir::StudyIR::Eigenmodes {
        dynamics: ir.study.dynamics().clone(),
        operator: fullmag_ir::EigenOperatorConfigIR {
            kind: fullmag_ir::EigenOperatorIR::Full2x2,
            include_demag: true,
        },
        count: 1,
        target: fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 100.0e6,
            frequency_max_hz: 25.0e9,
        },
        equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
        k_sampling: Some(fullmag_ir::KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR {
                    label: Some("H20mT".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("H100mT".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![2],
            closed: false,
        }),
        bias_field_sweep: None,
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
        magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            stage_autosave: None,
            outputs: vec![fullmag_ir::OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            }],
        },
        mode_tracking: None,
    };

    ir.pbc = Some(fullmag_ir::FdmPeriodicityIR {
        axes: [
            fullmag_ir::AxisBoundary::Periodic,
            fullmag_ir::AxisBoundary::Periodic,
            fullmag_ir::AxisBoundary::Open,
        ],
        demag: fullmag_ir::FdmDemagPeriodicityIR::PeriodicAirboxK0,
        image_counts: None,
    });
    let fullmag_ir::StudyIR::Eigenmodes {
        k_sampling,
        magnetostatic_bc,
        ..
    } = &mut ir.study
    else {
        unreachable!("fixture must remain an eigenmode study")
    };
    *k_sampling = Some(fullmag_ir::KSamplingIR::Single {
        k_vector: [0.0, 0.0, 0.0],
    });
    *magnetostatic_bc = fullmag_ir::MagnetostaticBoundaryConditionIR::PeriodicAirboxK0;
    ir
}

#[test]
fn fem_eigen_allows_k0_kittel_periodic_airbox_shared_domain_path() {
    let ir = k0_periodic_airbox_fem_eigen_ir();
    let planned = plan(&ir).expect("K0-3 periodic_airbox_k0 should plan with shared-domain airbox");
    match planned.backend_plan {
        BackendPlanIR::FemEigen(fem) => {
            assert_eq!(
                fem.k0_kittel_validation
                    .as_ref()
                    .and_then(|validation| validation.demag_kind.as_deref()),
                Some("periodic_airbox_k0")
            );
            assert_eq!(
                fem.domain_mesh_mode,
                fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir
            );
            assert!(fem.enable_demag);
        }
        other => panic!("expected FEM eigen plan, got {other:?}"),
    }
}

#[test]
fn fem_eigen_bias_field_sweep_plans_declared_samples_with_resolved_execution() {
    let mut encoded = serde_json::to_value(k0_periodic_airbox_fem_eigen_ir())
        .expect("bounded K0 fixture serializes");
    encoded["problem_meta"]["runtime_metadata"]
        .as_object_mut()
        .expect("fixture runtime metadata should be an object")
        .remove("k0_kittel_validation");
    encoded["materials"][0]["damping"] = serde_json::json!(0.0);
    encoded["study"]["bias_field_sweep"] = serde_json::json!({
        "samples_a_per_m": [[12500.0, 0.0, 0.0], [25000.0, 0.0, 0.0]],
        "equilibrium_policy": "continuation",
        "ordering": "declared",
        "continuation_seed": "previous_accepted_equilibrium"
    });
    let ir: ProblemIR = serde_json::from_value(encoded).expect("bias sweep IR deserializes");

    let planned = plan(&ir).expect("legal K0 bias sweep plans before CPU/GPU resolution");
    let value = serde_json::to_value(planned).expect("planned sweep serializes");
    assert_eq!(
        value["backend_plan"]["bias_field_samples"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        value["backend_plan"]["bias_field_samples"][0]["sample_index"],
        0
    );
    assert_eq!(
        value["backend_plan"]["bias_field_samples"][1]["field_a_per_m"],
        serde_json::json!([25000.0, 0.0, 0.0])
    );
    assert_eq!(
        value["provenance"]["fem_eigen_execution_resolution"]["resolved_device"],
        "cpu"
    );
}

#[test]
fn fem_eigen_bias_field_sweep_kittel_metadata_requires_sample_field_mapping() {
    let mut encoded = serde_json::to_value(k0_periodic_airbox_fem_eigen_ir())
        .expect("bounded K0 fixture serializes");
    encoded["materials"][0]["damping"] = serde_json::json!(0.0);
    encoded["study"]["bias_field_sweep"] = serde_json::json!({
        "samples_a_per_m": [
            [15915.494309189535, 0.0, 0.0],
            [39788.735772973836, 0.0, 0.0],
            [79577.47154594767, 0.0, 0.0]
        ],
        "equilibrium_policy": "continuation",
        "ordering": "declared",
        "continuation_seed": "previous_accepted_equilibrium"
    });

    let mut field_mismatch = encoded.clone();
    field_mismatch["problem_meta"]["runtime_metadata"]["k0_kittel_validation"]["samples"][1]
        ["bias_field"] = serde_json::json!([41_000.0, 0.0, 0.0]);
    let ir: ProblemIR = serde_json::from_value(field_mismatch).unwrap();
    let error = plan(&ir).expect_err("mismatched oracle field must fail closed");
    assert!(error
        .reasons
        .iter()
        .any(|reason| { reason.contains("eigenmodes.bias_field_sweep_kittel_field_mismatch") }));

    let mut index_mismatch = encoded;
    index_mismatch["problem_meta"]["runtime_metadata"]["k0_kittel_validation"]["samples"][2]
        ["sample_index"] = serde_json::json!(7);
    let ir: ProblemIR = serde_json::from_value(index_mismatch).unwrap();
    let error = plan(&ir).expect_err("mismatched oracle sample index must fail closed");
    assert!(error.reasons.iter().any(|reason| {
        reason.contains("eigenmodes.bias_field_sweep_kittel_sample_index_mismatch")
    }));
}

#[test]
fn fem_eigen_bias_field_sweep_rejects_relax_each_previous_seed() {
    let mut encoded = serde_json::to_value(k0_periodic_airbox_fem_eigen_ir())
        .expect("bounded K0 fixture serializes");
    encoded["materials"][0]["damping"] = serde_json::json!(0.0);
    encoded["problem_meta"]["runtime_metadata"]
        .as_object_mut()
        .expect("fixture runtime metadata should be an object")
        .remove("k0_kittel_validation");
    encoded["study"]["bias_field_sweep"] = serde_json::json!({
        "samples_a_per_m": [[12500.0, 0.0, 0.0]],
        "equilibrium_policy": "relax_each",
        "ordering": "declared",
        "continuation_seed": "previous_accepted_equilibrium"
    });
    let ir: ProblemIR = serde_json::from_value(encoded).unwrap();
    let error = plan(&ir).expect_err("relax_each must not ignore continuation seed");
    assert!(error.reasons.iter().any(|reason| {
        reason.contains("eigenmodes.bias_field_sweep_relax_each_requires_initial_state_seed")
    }));
}

#[test]
fn fdm_eigenmodes_remain_explicitly_not_executable() {
    let mut encoded = serde_json::to_value(k0_periodic_airbox_fem_eigen_ir()).unwrap();
    encoded["study"]["bias_field_sweep"] = serde_json::json!({
        "samples_a_per_m": [[12500.0, 0.0, 0.0]],
        "equilibrium_policy": "relax_each",
        "ordering": "declared",
        "continuation_seed": "initial_state"
    });
    let mut ir: ProblemIR = serde_json::from_value(encoded).unwrap();
    ir.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fdm;

    let error = plan(&ir).expect_err("FDM bias-field sweep must fail closed");
    assert!(error.reasons.iter().any(|reason| {
        reason == "eigenmodes.bias_field_sweep_requires_fem_backend; fallback=none"
    }));
}

#[test]
fn fem_eigen_bias_field_samples_bind_cpu_and_gpu_execution() {
    for device in ["cpu", "gpu"] {
        let mut encoded = serde_json::to_value(k0_periodic_airbox_fem_eigen_ir()).unwrap();
        encoded["study"]["bias_field_sweep"] = serde_json::json!({
            "samples_a_per_m": [[12500.0, 0.0, 0.0], [25000.0, 0.0, 0.0]],
            "equilibrium_policy": "relax_each",
            "ordering": "declared",
            "continuation_seed": "initial_state"
        });
        let mut ir: ProblemIR = serde_json::from_value(encoded).unwrap();
        ir.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            serde_json::json!({"device": device, "precision": "double"}),
        );
        let value = serde_json::to_value(plan(&ir).unwrap()).unwrap();
        for sample in value["backend_plan"]["bias_field_samples"]
            .as_array()
            .unwrap()
        {
            assert_eq!(sample["execution"]["requested_device"], device);
            assert_eq!(sample["execution"]["resolved_device"], device);
            assert_eq!(sample["execution"]["requested_precision"], "double");
            assert_eq!(sample["execution"]["resolved_precision"], "double");
        }
    }
}

fn planned_k0_eigen_execution_resolution(
    requested_device: &str,
    runtime_override: Option<&str>,
) -> serde_json::Value {
    let mut ir = k0_periodic_airbox_fem_eigen_ir();
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": requested_device, "precision": "double"}),
    );
    if let Some(device) = runtime_override {
        ir.problem_meta.runtime_metadata.insert(
            "runtime_device_override".to_string(),
            serde_json::json!({"device": device, "source": "managed_launcher"}),
        );
    }
    let planned = plan(&ir).expect("bounded K0 periodic-airbox execution must plan");
    serde_json::to_value(
        planned
            .provenance
            .fem_eigen_execution_resolution
            .expect("bounded K0 plan must publish typed execution resolution"),
    )
    .expect("FEM eigen execution resolution must serialize")
}

#[test]
fn fem_eigen_k0_execution_resolution_selects_exact_cpu_and_gpu_engines() {
    for (device, engine, reason) in [
        (
            "cpu",
            "k0_poisson_airbox_cpu_schur_slepc",
            "fem_eigen.k0_periodic_airbox.explicit_cpu",
        ),
        (
            "gpu",
            "gpu_modal_device_krylov",
            "fem_eigen.k0_periodic_airbox.explicit_gpu",
        ),
    ] {
        let resolution = planned_k0_eigen_execution_resolution(device, None);
        assert_eq!(resolution["requested_device"], device);
        assert_eq!(resolution["resolved_device"], device);
        assert_eq!(resolution["requested_precision"], "double");
        assert_eq!(resolution["resolved_precision"], "double");
        assert_eq!(resolution["requested_engine"], "auto");
        assert_eq!(resolution["resolved_engine"], engine);
        assert_eq!(resolution["fallback_used"], false);
        assert!(resolution.get("fallback_reason").is_none());
        assert_eq!(resolution["selection_reason"], reason);
    }
}

#[test]
fn fem_eigen_k0_kittel_validation_resolves_execution_when_study_bc_is_open() {
    let mut ir = k0_periodic_airbox_fem_eigen_ir();
    let fullmag_ir::StudyIR::Eigenmodes {
        magnetostatic_bc, ..
    } = &mut ir.study
    else {
        unreachable!("fixture must remain an eigenmode study")
    };
    *magnetostatic_bc = fullmag_ir::MagnetostaticBoundaryConditionIR::Open;

    let planned = plan(&ir)
        .expect("K0-3 validation metadata must bind the periodic-airbox execution contract");
    let resolution = serde_json::to_value(
        planned
            .provenance
            .fem_eigen_execution_resolution
            .expect("K0-3 validation must publish typed execution resolution"),
    )
    .expect("K0-3 execution resolution must serialize");

    assert_eq!(resolution["requested_device"], "auto");
    assert_eq!(resolution["resolved_device"], "cpu");
    assert_eq!(
        resolution["resolved_engine"],
        "k0_poisson_airbox_cpu_schur_slepc"
    );
    assert_eq!(
        resolution["selection_reason"],
        "fem_eigen.k0_periodic_airbox.auto_default_cpu"
    );
}

#[test]
fn fem_eigen_k0_auto_uses_managed_runtime_selection_without_marking_fallback() {
    for (device, engine, reason) in [
        (
            "cpu",
            "k0_poisson_airbox_cpu_schur_slepc",
            "fem_eigen.k0_periodic_airbox.auto_runtime_cpu",
        ),
        (
            "gpu",
            "gpu_modal_device_krylov",
            "fem_eigen.k0_periodic_airbox.auto_runtime_gpu",
        ),
    ] {
        let resolution = planned_k0_eigen_execution_resolution("auto", Some(device));
        assert_eq!(resolution["requested_device"], "auto");
        assert_eq!(resolution["resolved_device"], device);
        assert_eq!(resolution["resolved_engine"], engine);
        assert_eq!(resolution["fallback_used"], false);
        assert!(resolution.get("fallback_reason").is_none());
        assert_eq!(resolution["selection_reason"], reason);
    }
}

#[test]
fn fem_eigen_k0_auto_records_identical_physics_cpu_fallback() {
    let mut ir = k0_periodic_airbox_fem_eigen_ir();
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "auto", "precision": "double"}),
    );
    ir.problem_meta.runtime_metadata.insert(
        "runtime_device_override".to_string(),
        serde_json::json!({
            "device": "cpu",
            "source": "managed_launcher",
            "fallback_reason": "gpu_modal_device_krylov_unavailable",
        }),
    );

    let planned = plan(&ir)
        .expect("auto may fall back to the CPU engine only for the identical K0 physical contract");
    let resolution = serde_json::to_value(
        planned
            .provenance
            .fem_eigen_execution_resolution
            .expect("K0 fallback must publish typed execution resolution"),
    )
    .expect("K0 fallback resolution must serialize");

    assert_eq!(resolution["requested_device"], "auto");
    assert_eq!(resolution["resolved_device"], "cpu");
    assert_eq!(
        resolution["resolved_engine"],
        "k0_poisson_airbox_cpu_schur_slepc"
    );
    assert_eq!(resolution["fallback_used"], true);
    assert_eq!(
        resolution["fallback_reason"],
        "gpu_modal_device_krylov_unavailable"
    );
    assert_eq!(
        resolution["selection_reason"],
        "fem_eigen.k0_periodic_airbox.auto_gpu_unavailable_cpu_fallback"
    );
}

#[test]
fn fem_eigen_k0_strict_gpu_ignores_conflicting_cpu_override_without_fallback() {
    let mut ir = k0_periodic_airbox_fem_eigen_ir();
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "gpu", "precision": "double"}),
    );
    ir.problem_meta.runtime_metadata.insert(
        "runtime_device_override".to_string(),
        serde_json::json!({
            "device": "cpu",
            "source": "managed_launcher",
            "fallback_reason": "gpu_modal_device_krylov_unavailable",
        }),
    );
    let planned = plan(&ir).expect("strict GPU intent must ignore CPU fallback metadata");
    let resolution = serde_json::to_value(
        planned
            .provenance
            .fem_eigen_execution_resolution
            .expect("strict GPU K0 plan must publish execution resolution"),
    )
    .expect("strict GPU K0 resolution must serialize");
    assert_eq!(resolution["requested_device"], "gpu");
    assert_eq!(resolution["resolved_device"], "gpu");
    assert_eq!(resolution["resolved_engine"], "gpu_modal_device_krylov");
    assert_eq!(resolution["fallback_used"], false);
    assert!(resolution.get("fallback_reason").is_none());
}

#[test]
fn fem_eigen_k0_auto_without_runtime_override_resolves_deterministically_to_cpu() {
    let resolution = planned_k0_eigen_execution_resolution("auto", None);
    assert_eq!(resolution["requested_device"], "auto");
    assert_eq!(resolution["resolved_device"], "cpu");
    assert_eq!(
        resolution["resolved_engine"],
        "k0_poisson_airbox_cpu_schur_slepc"
    );
    assert_eq!(
        resolution["selection_reason"],
        "fem_eigen.k0_periodic_airbox.auto_default_cpu"
    );
    assert_eq!(resolution["fallback_used"], false);
}

#[test]
fn fem_eigen_k0_rejects_non_strict_execution_without_fallback() {
    let mut ir = k0_periodic_airbox_fem_eigen_ir();
    ir.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Extended;
    let error = plan(&ir).expect_err("bounded K0 production engines require strict mode");
    assert!(error.reasons.iter().any(|reason| {
        reason.contains("fem_eigen.k0_periodic_airbox_requires_strict_execution_mode")
            && reason.contains("fallback=none")
    }));
}

#[test]
fn fem_eigen_k0_rejects_illegal_precision_and_nonzero_k_before_engine_resolution() {
    let mut single = k0_periodic_airbox_fem_eigen_ir();
    single.backend_policy.execution_precision = ExecutionPrecision::Single;
    let single_error = plan(&single).expect_err("K0 periodic-airbox single precision is illegal");
    assert!(single_error.reasons.iter().any(|reason| {
        reason.contains("eigenmodes.k0_periodic_airbox_requires_double_precision")
    }));

    let mut nonzero_k = k0_periodic_airbox_fem_eigen_ir();
    let fullmag_ir::StudyIR::Eigenmodes { k_sampling, .. } = &mut nonzero_k.study else {
        unreachable!("fixture must remain an eigenmode study")
    };
    *k_sampling = Some(fullmag_ir::KSamplingIR::Single {
        k_vector: [1.0, 0.0, 0.0],
    });
    let k_error = plan(&nonzero_k).expect_err("K0 engine must reject nonzero-k intent");
    assert!(k_error
        .reasons
        .iter()
        .any(|reason| reason.contains("eigenmodes.k0_periodic_airbox_requires_exact_zero_k")));
}

#[test]
fn fem_eigen_k0_plan_deserializes_without_optional_execution_resolution() {
    let mut ir = k0_periodic_airbox_fem_eigen_ir();
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cpu", "precision": "double"}),
    );
    let planned = plan(&ir).expect("bounded K0 CPU plan must serialize");
    let mut encoded = serde_json::to_value(planned.provenance).expect("plan provenance serializes");
    encoded
        .as_object_mut()
        .expect("plan provenance serializes as an object")
        .remove("fem_eigen_execution_resolution");
    let legacy: fullmag_ir::ProvenancePlanIR =
        serde_json::from_value(encoded).expect("legacy plan without provenance deserializes");
    assert!(legacy.fem_eigen_execution_resolution.is_none());
}

#[test]
fn object_object_exchange_without_coupling_defaults_none() {
    let ir = stacked_two_body_multilayer_problem();
    assert!(
        ir.couplings.is_empty(),
        "separate objects must not synthesize authored coupling intent"
    );

    let planned = plan(&ir).expect("stacked two-body problem should lower");
    let BackendPlanIR::FdmMultilayer(multilayer) = planned.backend_plan else {
        panic!("expected FDM multilayer plan");
    };
    assert!(multilayer.enable_exchange);
    assert_eq!(multilayer.layers.len(), 2);
    assert_eq!(multilayer.layers[0].material.name, "Py");
    assert_eq!(multilayer.layers[1].material.name, "Py");

    let serialized =
        serde_json::to_value(&multilayer).expect("FdmMultilayerPlanIR should serialize");
    assert!(
        serialized.get("inter_region_exchange").is_none(),
        "object-object exchange must remain a free surface unless a coupling is explicit"
    );
    assert!(
        serialized.get("couplings").is_none(),
        "planner must not synthesize hidden object-object couplings"
    );
    assert!(serialized.get("rkky").is_none());
    assert!(serialized.get("interlayer_exchange").is_none());
}

#[test]
fn fem_eigen_shared_domain_region_samples_equilibrium_once_per_object() {
    let mut ir = fem_minimal_test_ir();
    ir.magnets[0].initial_magnetization = Some(InitialMagnetizationIR::RandomSeeded { seed: 17 });
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![],
        fem_mesh_assets: vec![],
        fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
            mesh_source: None,
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip_with_region".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [1.0, 1.0, 1.0],
                ],
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [0, 1, 2, 4]]),
                element_markers: vec![1, 2],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 3], [1, 2, 4]]),
                boundary_markers: vec![10, 10],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            object_region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip:refinement".to_string(),
                marker: 2,
            }],
            build_report: None,
        }),
    });
    ir.object_regions.push(fullmag_ir::ObjectRegionIR {
        region_id: "strip:refinement".to_string(),
        owner_object: "strip".to_string(),
        name: "refinement".to_string(),
        shape: fullmag_ir::RegionShapeIR::Box {
            size: [0.5, 0.5, 0.5],
            center: [0.0, 0.0, 0.0],
        },
        frame: fullmag_ir::RegionFrameIR::Object,
        priority: 0,
        enabled: true,
        mesh_policy: None,
        material_overrides: Vec::new(),
        texture_override: None,
        material_transition: None,
        realization_policy: fullmag_ir::RegionRealizationPolicyIR::Conformal,
    });
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
        bias_field_sweep: None,
        normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
        damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            stage_autosave: None,
            outputs: vec![fullmag_ir::OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            }],
        },
        mode_tracking: None,
    };

    let planned = plan(&ir).expect("shared-domain region FEM eigen planning should succeed");
    let BackendPlanIR::FemEigen(fem) = planned.backend_plan else {
        panic!("expected FEM eigen plan");
    };
    let expected = crate::mesh::initial_vectors_for_magnet(
        "strip",
        &fem.mesh.mesh_name,
        ir.magnets[0].initial_magnetization.as_ref(),
        fem.mesh.nodes.len(),
        Some(&fem.mesh.nodes),
        Some(&fem.mesh.nodes),
    )
    .expect("whole-object equilibrium should sample");

    assert_eq!(fem.object_segments.len(), 2);
    assert_eq!(fem.object_segments[0].object_id, "strip");
    assert_eq!(fem.object_segments[1].object_id, "strip");
    assert_eq!(fem.equilibrium_magnetization, expected);
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
            projection_policy: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                element_markers: vec![1],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
        bias_field_sweep: None,
        normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
        damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            stage_autosave: None,
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
            projection_policy: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
                element_markers: vec![1, 0],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [4, 5, 6]]),
                boundary_markers: vec![10, 99],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            object_region_markers: Vec::new(),
            build_report: None,
        }),
    });
    if let Some(mesh) = ir
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .and_then(|asset| asset.mesh.as_mut())
    {
        complete_test_airbox_boundaries(mesh);
    }
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
        bias_field_sweep: None,
        normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
        damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            stage_autosave: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                element_markers: vec![1],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
        bias_field_sweep: None,
        normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
        damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Legacy(
            fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
        ),
        magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            stage_autosave: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                element_markers: vec![1],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
        bias_field_sweep: None,
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
        magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            stage_autosave: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                element_markers: vec![1],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
        bias_field_sweep: None,
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
        magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            stage_autosave: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
                element_markers: vec![1, 0],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [4, 5, 6]]),
                boundary_markers: vec![10, 11],
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
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            object_region_markers: Vec::new(),
            build_report: None,
        }),
    });
    if let Some(mesh) = ir
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .and_then(|asset| asset.mesh.as_mut())
    {
        complete_test_airbox_boundaries(mesh);
    }
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
        bias_field_sweep: None,
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
        magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            stage_autosave: None,
            outputs: vec![fullmag_ir::OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            }],
        },
        mode_tracking: None,
    };

    let err = plan(&ir).expect_err("Floquet FEM eigen with dynamic demag is unsupported");
    assert!(err.reasons.iter().any(|reason| {
        reason.contains("dynamic demag for Floquet periodic FEM is not implemented yet")
    }));

    ir.problem_meta.runtime_metadata.insert(
        "dispersion_validation".to_string(),
        serde_json::json!({
            "kind": "thin_film_de_bv_low_k",
            "analytic_model": "kalinikos_slab_n0",
            "film_thickness_m": 80.0e-9,
            "equilibrium_magnetization": [1.0, 0.0, 0.0],
            "film_normal": [0.0, 0.0, 1.0],
            "max_k_rad_per_m": 2.0e6,
            "frequency_window_hz": {
                "min": 0.0,
                "max": 5.0e9
            },
            "max_relative_error": 0.08,
            "scenarios": [
                {
                    "geometry": "backward_volume",
                    "branch_id": "branch_0",
                    "sample_indices": [0, 1, 2]
                },
                {
                    "geometry": "damon_eshbach",
                    "branch_id": "branch_0",
                    "sample_indices": [3, 4, 5]
                }
            ]
        }),
    );
    if let fullmag_ir::StudyIR::Eigenmodes { k_sampling, .. } = &mut ir.study {
        *k_sampling = Some(fullmag_ir::KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("BV".to_string()),
                    k_vector: [2.0e6, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("DE".to_string()),
                    k_vector: [0.0, 2.0e6, 0.0],
                },
            ],
            samples_per_segment: vec![2, 1, 2],
            closed: false,
        });
    }
    let planned =
        plan(&ir).expect("low-k DE/BV analytic reference should bypass Floquet-demag guard");
    match planned.backend_plan {
        BackendPlanIR::FemEigen(fem) => {
            assert!(fem.operator.include_demag);
            assert!(fem.dispersion_validation.is_some());
        }
        other => panic!("expected FEM eigen plan, got {other:?}"),
    }
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                element_markers: vec![1],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
        bias_field_sweep: None,
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
        magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            stage_autosave: None,
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
fn fem_frequency_response_with_mesh_asset_plans_successfully() {
    let ir = fem_frequency_response_mesh_asset_problem();

    let planned = plan(&ir).expect("FEM frequency response mesh asset should plan");
    match planned.backend_plan {
        BackendPlanIR::FemFrequencyResponse(fem) => {
            assert_eq!(fem.mesh_name, "strip");
            assert_eq!(fem.frequencies_hz.values_hz, vec![1.0e9, 2.0e9]);
            assert_eq!(fem.excitation.field_au_per_m, [0.0, 0.0, 1.0]);
            assert_eq!(fem.excitation.phase_rad, 0.375);
            assert!(fem.enable_exchange);
            assert!(!fem.enable_demag);
            assert_eq!(
                fem.operator.kind,
                fullmag_ir::EigenOperatorIR::LinearizedLlg
            );
        }
        other => panic!("expected FemFrequencyResponse plan, got {other:?}"),
    }
}

#[test]
fn fem_frequency_response_carries_m5_equilibrium_provenance_from_runtime_metadata() {
    let mut ir = fem_frequency_response_mesh_asset_problem();
    ir.problem_meta.runtime_metadata.insert(
        "frequency_response_m5_equilibrium_provenance".to_string(),
        serde_json::json!({
            "schema_version": "fem_frequency_domain_equilibrium_provenance.v1",
            "acceptance_gate": "M5_static_pbc_demag_equilibrium",
            "accepted": true,
            "source_kind": "m5_static_pbc_demag_equilibrium",
            "source_artifact_root": ".fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/artifacts",
            "equilibrium_field_path": "m_final.json",
            "seam_diagnostics_path": "diagnostics/fem_static_pbc_demag_seams.v1.json",
            "z_padding_report_path": "reports/z_padding_validation.v1.json",
            "supercell_report_path": "reports/supercell_validation.v1.json",
            "magnetostatic_bc": "periodic_airbox_k0",
            "pbc_axes": ["x", "y"],
        }),
    );

    let planned =
        plan(&ir).expect("FEM frequency response with M5 equilibrium provenance should plan");
    match planned.backend_plan {
        BackendPlanIR::FemFrequencyResponse(fem) => {
            let provenance = fem
                .equilibrium_provenance
                .expect("M5 equilibrium provenance should be preserved in the backend plan");
            assert_eq!(
                provenance.schema_version,
                "fem_frequency_domain_equilibrium_provenance.v1"
            );
            assert_eq!(
                provenance.acceptance_gate,
                "M5_static_pbc_demag_equilibrium"
            );
            assert!(provenance.accepted);
            assert_eq!(provenance.source_kind, "m5_static_pbc_demag_equilibrium");
            assert_eq!(provenance.magnetostatic_bc, "periodic_airbox_k0");
            assert_eq!(provenance.pbc_axes, vec!["x".to_string(), "y".to_string()]);
        }
        other => panic!("expected FemFrequencyResponse plan, got {other:?}"),
    }
}

#[test]
fn fem_frequency_response_carries_solver_policy_into_backend_plan() {
    let mut ir = fem_frequency_response_mesh_asset_problem();
    if let fullmag_ir::StudyIR::FrequencyResponse { solver_policy, .. } = &mut ir.study {
        *solver_policy = Some(fullmag_ir::FrequencyResponseSolverPolicyIR {
            method: Some(fullmag_ir::FrequencyResponseSolverMethodIR::SchurReduced),
            preconditioner: Some(fullmag_ir::FrequencyResponsePreconditionerIR::BlockJacobi),
            rtol: Some(1.0e-2),
            max_iterations: Some(128),
            restart_iterations: Some(32),
        });
    }

    let planned = plan(&ir).expect("FEM frequency response with solver policy should plan");
    match planned.backend_plan {
        BackendPlanIR::FemFrequencyResponse(fem) => {
            let policy = fem
                .solver_policy
                .expect("frequency-response solver policy should be preserved");
            assert_eq!(policy.rtol, Some(1.0e-2));
            assert_eq!(
                policy.method,
                Some(fullmag_ir::FrequencyResponseSolverMethodIR::SchurReduced)
            );
            assert_eq!(
                policy.preconditioner,
                Some(fullmag_ir::FrequencyResponsePreconditionerIR::BlockJacobi)
            );
            assert_eq!(policy.max_iterations, Some(128));
            assert_eq!(policy.restart_iterations, Some(32));
        }
        other => panic!("expected FemFrequencyResponse plan, got {other:?}"),
    }
}

#[test]
fn fem_frequency_response_rejects_unsupported_production_slice_cases() {
    let mut demag = fem_frequency_response_mesh_asset_problem();
    demag.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::FredkinKoehler,
        },
    ];
    if let fullmag_ir::StudyIR::FrequencyResponse { operator, .. } = &mut demag.study {
        operator.include_demag = true;
    }
    let planned = plan(&demag).expect("CPU frequency-response demag should plan");
    match planned.backend_plan {
        BackendPlanIR::FemFrequencyResponse(fem) => {
            assert!(fem.enable_demag);
            assert_eq!(
                fem.demag_realization,
                Some(fullmag_ir::ResolvedFemDemagIR::FredkinKoehler)
            );
            assert_eq!(fem.requested_device, fullmag_ir::ExecutionDevice::Cpu);
        }
        other => panic!("expected FemFrequencyResponse plan, got {other:?}"),
    }

    let mut gpu_demag = demag.clone();
    gpu_demag.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "gpu", "precision": "double"}),
    );
    let planned = plan(&gpu_demag).expect("GPU frequency-response demag should plan");
    match planned.backend_plan {
        BackendPlanIR::FemFrequencyResponse(fem) => {
            assert!(fem.enable_demag);
            assert_eq!(
                fem.demag_realization,
                Some(fullmag_ir::ResolvedFemDemagIR::FredkinKoehler)
            );
            assert_eq!(fem.requested_device, fullmag_ir::ExecutionDevice::Gpu);
        }
        other => panic!("expected FemFrequencyResponse plan, got {other:?}"),
    }

    let mut shared_domain = fem_frequency_response_mesh_asset_problem();
    let geometry_assets = shared_domain
        .geometry_assets
        .as_mut()
        .expect("test problem should carry FEM mesh assets");
    let mut domain_mesh = geometry_assets
        .fem_mesh_assets
        .first()
        .and_then(|asset| asset.mesh.as_ref())
        .expect("test problem should carry an inline FEM mesh")
        .clone();
    domain_mesh.nodes.extend([
        [-2.0, -2.0, -2.0],
        [2.0, -2.0, -2.0],
        [-2.0, 2.0, -2.0],
        [-2.0, -2.0, 2.0],
    ]);
    domain_mesh.push_tet4_cell([4, 5, 6, 7]).unwrap();
    domain_mesh.element_markers.push(0);
    geometry_assets.fem_domain_mesh_asset = Some(fullmag_ir::FemDomainMeshAssetIR {
        mesh_source: None,
        mesh: Some(domain_mesh),
        region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "strip".to_string(),
            marker: 1,
        }],
        object_region_markers: Vec::new(),
        build_report: None,
    });
    let planned = plan(&shared_domain)
        .expect("CPU no-demag shared-domain response should plan as a magnetic slice");
    match planned.backend_plan {
        BackendPlanIR::FemFrequencyResponse(fem) => {
            assert_eq!(fem.requested_device, fullmag_ir::ExecutionDevice::Cpu);
            assert_eq!(
                fem.domain_mesh_mode,
                fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir
            );
            assert!(!fem.enable_demag);
        }
        other => panic!("expected FemFrequencyResponse plan, got {other:?}"),
    }

    let mut gpu_shared_domain_no_demag = shared_domain.clone();
    gpu_shared_domain_no_demag
        .problem_meta
        .runtime_metadata
        .insert(
            "runtime_selection".to_string(),
            serde_json::json!({"device": "gpu", "precision": "double"}),
        );
    let planned = plan(&gpu_shared_domain_no_demag)
        .expect("explicit GPU no-demag shared-domain response should plan as a magnetic slice");
    match planned.backend_plan {
        BackendPlanIR::FemFrequencyResponse(fem) => {
            assert_eq!(fem.requested_device, fullmag_ir::ExecutionDevice::Gpu);
            assert_eq!(
                fem.domain_mesh_mode,
                fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir
            );
            assert!(!fem.enable_demag);
            assert_eq!(
                fem.magnetostatic_bc,
                fullmag_ir::MagnetostaticBoundaryConditionIR::Open
            );
        }
        other => panic!("expected FemFrequencyResponse plan, got {other:?}"),
    }

    let mut nonzero_k = fem_frequency_response_mesh_asset_problem();
    if let fullmag_ir::StudyIR::FrequencyResponse { k_sampling, .. } = &mut nonzero_k.study {
        *k_sampling = Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [1.0e6, 0.0, 0.0],
        });
    }
    let err = plan(&nonzero_k).expect_err("nonzero-k response should be gated");
    assert!(err.reasons.iter().any(|reason| {
        reason.contains("supported frequency-domain slices")
            && reason
                .contains("nonzero-k Floquet/Bloch driven response requires spin_wave_bc=floquet")
    }));

    let mut periodic_without_pairs = fem_frequency_response_mesh_asset_problem();
    if let fullmag_ir::StudyIR::FrequencyResponse { spin_wave_bc, .. } =
        &mut periodic_without_pairs.study
    {
        *spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
    }
    let err = plan(&periodic_without_pairs)
        .expect_err("periodic response without mesh pairs should gate");
    assert!(
        err.reasons
            .iter()
            .any(|reason| reason.contains("mesh.periodic_node_pairs")),
        "unexpected periodic-without-pairs rejection reasons: {:?}",
        err.reasons
    );

    let mut periodic = fem_frequency_response_mesh_asset_problem();
    let periodic_mesh = periodic
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_mesh_assets.first_mut())
        .and_then(|asset| asset.mesh.as_mut())
        .expect("test problem should carry an inline FEM mesh");
    periodic_mesh.periodic_boundary_pairs = vec![
        fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "x_faces".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 1,
            marker_b: 2,
            translation: Some([1.0, 0.0, 0.0]),
            tolerance: Some(1.0e-12),
            axis_hint: None,
            orientation: None,
            pairing_policy: None,
        },
        fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "y_faces".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 3,
            marker_b: 4,
            translation: Some([0.0, 1.0, 0.0]),
            tolerance: Some(1.0e-12),
            axis_hint: None,
            orientation: None,
            pairing_policy: None,
        },
    ];
    periodic_mesh.periodic_node_pairs = vec![
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "x_faces".to_string(),
            node_a: 0,
            node_b: 1,
        },
        fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "y_faces".to_string(),
            node_a: 0,
            node_b: 2,
        },
    ];
    if let fullmag_ir::StudyIR::FrequencyResponse {
        spin_wave_bc,
        k_sampling,
        ..
    } = &mut periodic.study
    {
        *spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: None,
                pair_ids: vec!["x_faces".to_string(), "y_faces".to_string()],
                phase_convention: fullmag_ir::PhaseConventionIR::ExpMinusIKDotDeltaR,
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        *k_sampling = Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [1.0e6, 0.0, 0.0],
        });
    }
    periodic.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "gpu", "precision": "double"}),
    );
    let planned =
        plan(&periodic).expect("nonzero-k Floquet no-demag response should plan for GPU execution");
    match planned.backend_plan {
        BackendPlanIR::FemFrequencyResponse(fem) => {
            assert_eq!(
                fem.spin_wave_bc.kind(),
                fullmag_ir::SpinWaveBoundaryKindIR::Floquet
            );
            assert!(
                fem.periodic_constraint_sets.iter().any(|constraint| {
                    constraint.unknown_family
                        == fullmag_ir::PeriodicUnknownFamilyIR::MagnetizationDynamic
                        && matches!(
                            constraint.phase_policy,
                            fullmag_ir::PeriodicPhasePolicyIR::BlochPhase { .. }
                        )
                }),
                "nonzero-k Floquet response should carry Bloch dynamic-magnetization constraints: {:?}",
                fem.periodic_constraint_sets
            );
        }
        other => panic!("expected FemFrequencyResponse plan, got {other:?}"),
    }

    let mut cpu_periodic = periodic.clone();
    cpu_periodic.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cpu", "precision": "double"}),
    );
    let cpu_planned = plan(&cpu_periodic)
        .expect("nonzero-k Floquet no-demag response should plan for CPU execution");
    match cpu_planned.backend_plan {
        BackendPlanIR::FemFrequencyResponse(fem) => {
            assert_eq!(fem.requested_device, fullmag_ir::ExecutionDevice::Cpu);
            assert_eq!(
                fem.spin_wave_bc.kind(),
                fullmag_ir::SpinWaveBoundaryKindIR::Floquet
            );
            assert!(
                fem.periodic_constraint_sets.iter().any(|constraint| {
                    constraint.unknown_family
                        == fullmag_ir::PeriodicUnknownFamilyIR::MagnetizationDynamic
                        && matches!(
                            constraint.phase_policy,
                            fullmag_ir::PeriodicPhasePolicyIR::BlochPhase { .. }
                        )
                }),
                "CPU nonzero-k Floquet response should carry Bloch dynamic-magnetization constraints: {:?}",
                fem.periodic_constraint_sets
            );
        }
        other => panic!("expected CPU FemFrequencyResponse plan, got {other:?}"),
    }

    let mut floquet_demag = periodic.clone();
    floquet_demag.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::PoissonRobin,
        },
    ];
    if let fullmag_ir::StudyIR::FrequencyResponse { operator, .. } = &mut floquet_demag.study {
        operator.include_demag = true;
    }
    let err = plan(&floquet_demag)
        .expect_err("nonzero-k Floquet dynamic-demag response requires a gated demag-k model");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("Floquet/Bloch dynamic demag")
                && reason.contains("magnetostatic_bc=floquet_airbox")
        }),
        "unexpected Floquet dynamic-demag rejection reasons: {:?}",
        err.reasons
    );

    let mut floquet_airbox_demag = fem_frequency_response_periodic_airbox_domain_problem();
    if let fullmag_ir::StudyIR::FrequencyResponse {
        spin_wave_bc,
        k_sampling,
        magnetostatic_bc,
        ..
    } = &mut floquet_airbox_demag.study
    {
        *spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: None,
                pair_ids: vec!["x_faces".to_string()],
                phase_convention: fullmag_ir::PhaseConventionIR::ExpMinusIKDotDeltaR,
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        *k_sampling = Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [1.0e6, 0.0, 0.0],
        });
        *magnetostatic_bc = fullmag_ir::MagnetostaticBoundaryConditionIR::FloquetAirbox;
    }
    let err = plan(&floquet_airbox_demag)
        .expect_err("floquet_airbox remains gated until the demag-k operator exists");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("magnetostatic_bc=floquet_airbox")
                && reason.contains("demag-k operator is not implemented")
        }),
        "unexpected Floquet airbox rejection reasons: {:?}",
        err.reasons
    );

    floquet_airbox_demag.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "gpu", "precision": "double"}),
    );
    let planned = plan(&floquet_airbox_demag)
        .expect("forced-GPU floquet_airbox should reach the native unavailable artifact boundary");
    match planned.backend_plan {
        BackendPlanIR::FemFrequencyResponse(fem) => {
            assert_eq!(
                fem.spin_wave_bc.kind(),
                fullmag_ir::SpinWaveBoundaryKindIR::Floquet
            );
            assert_eq!(
                fem.magnetostatic_bc,
                fullmag_ir::MagnetostaticBoundaryConditionIR::FloquetAirbox
            );
            assert!(
                fem.periodic_constraint_sets.iter().any(|constraint| {
                    constraint.unknown_family
                        == fullmag_ir::PeriodicUnknownFamilyIR::MagnetizationDynamic
                        && matches!(
                            constraint.phase_policy,
                            fullmag_ir::PeriodicPhasePolicyIR::BlochPhase { .. }
                        )
                }),
                "forced-GPU floquet_airbox should retain delta_m Bloch constraints: {:?}",
                fem.periodic_constraint_sets
            );
            assert!(
                fem.periodic_constraint_sets.iter().any(|constraint| {
                    constraint.unknown_family
                        == fullmag_ir::PeriodicUnknownFamilyIR::MagnetostaticPotentialDynamic
                        && matches!(
                            constraint.phase_policy,
                            fullmag_ir::PeriodicPhasePolicyIR::BlochPhase { .. }
                        )
                }),
                "forced-GPU floquet_airbox should retain delta_phi Bloch constraints: {:?}",
                fem.periodic_constraint_sets
            );
        }
        other => panic!("expected FemFrequencyResponse plan, got {other:?}"),
    }

    if let fullmag_ir::StudyIR::FrequencyResponse {
        spin_wave_bc,
        k_sampling,
        ..
    } = &mut periodic.study
    {
        *spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: None,
                pair_ids: vec!["x_faces".to_string(), "y_faces".to_string()],
                phase_convention: fullmag_ir::PhaseConventionIR::ExpMinusIKDotDeltaR,
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        *k_sampling = Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        });
    }
    let planned = plan(&periodic).expect("k=0 Floquet response should plan as static-periodic");
    match planned.backend_plan {
        BackendPlanIR::FemFrequencyResponse(fem) => {
            assert_eq!(
                fem.spin_wave_bc.kind(),
                fullmag_ir::SpinWaveBoundaryKindIR::Periodic
            );
            assert_eq!(fem.spin_wave_bc.boundary_pair_ids(), ["x_faces", "y_faces"]);
            assert!(
                fem.periodic_constraint_sets.iter().any(|constraint| {
                    constraint.unknown_family
                        == fullmag_ir::PeriodicUnknownFamilyIR::MagnetizationDynamic
                        && constraint.phase_policy == fullmag_ir::PeriodicPhasePolicyIR::ZeroPhase
                        && constraint.pair_ids == ["x_faces".to_string(), "y_faces".to_string()]
                }),
                "k=0 Floquet alias should plan zero-phase magnetic periodic constraints: {:?}",
                fem.periodic_constraint_sets
            );
        }
        other => panic!("expected FemFrequencyResponse plan, got {other:?}"),
    }
    if let fullmag_ir::StudyIR::FrequencyResponse {
        spin_wave_bc,
        k_sampling,
        ..
    } = &mut periodic.study
    {
        *spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        *k_sampling = Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        });
    }
    let planned = plan(&periodic).expect("static-periodic k=0 driven response should plan");
    match planned.backend_plan {
        BackendPlanIR::FemFrequencyResponse(mut fem) => {
            assert_eq!(fem.mesh.periodic_node_pairs.len(), 2);
            assert_eq!(
                fem.spin_wave_bc.kind(),
                fullmag_ir::SpinWaveBoundaryKindIR::Periodic
            );
            fem.spin_wave_bc = fullmag_ir::SpinWaveBoundaryConditionIR::Config(
                fullmag_ir::SpinWaveBoundaryConfigIR {
                    kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                    boundary_pair_id: None,
                    pair_ids: vec!["x_faces".to_string(), "y_faces".to_string()],
                    phase_convention: fullmag_ir::PhaseConventionIR::ExpMinusIKDotDeltaR,
                    surface_anisotropy_ks: None,
                    surface_anisotropy_axis: None,
                },
            );
            fem.k_sampling = Some(fullmag_ir::KSamplingIR::Single {
                k_vector: [1.0e6, 0.0, 0.0],
            });
            let constraint_sets = crate::fem::frequency_response_periodic_constraint_sets(&fem);
            let bloch_constraint = constraint_sets
                .iter()
                .find(|constraint| {
                    constraint.unknown_family
                        == fullmag_ir::PeriodicUnknownFamilyIR::MagnetizationDynamic
                        && matches!(
                            constraint.phase_policy,
                            fullmag_ir::PeriodicPhasePolicyIR::BlochPhase { .. }
                        )
                })
                .expect("Floquet response should emit a dynamic-magnetization Bloch constraint");
            assert_eq!(
                bloch_constraint.unknown_family,
                fullmag_ir::PeriodicUnknownFamilyIR::MagnetizationDynamic
            );
            let phase_loop = bloch_constraint
                .phase_loop_diagnostics
                .as_ref()
                .expect("Floquet constraint set should carry phase-loop diagnostics");
            assert_eq!(phase_loop.checked_loop_count, 1);
            assert!(phase_loop.max_phase_loop_residual_rad < 1.0e-12);
            match &bloch_constraint.phase_policy {
                fullmag_ir::PeriodicPhasePolicyIR::BlochPhase {
                    phase_convention,
                    k_vector_rad_per_m,
                    real_imag_mixing,
                } => {
                    assert_eq!(
                        *phase_convention,
                        fullmag_ir::PhaseConventionIR::ExpMinusIKDotDeltaR
                    );
                    assert_eq!(*k_vector_rad_per_m, [1.0e6, 0.0, 0.0]);
                    assert!(*real_imag_mixing);
                }
                other => panic!("expected BlochPhase periodic phase policy, got {other:?}"),
            }
        }
        other => panic!("expected FemFrequencyResponse plan, got {other:?}"),
    }

    let mut floquet = periodic;
    if let fullmag_ir::StudyIR::FrequencyResponse { spin_wave_bc, .. } = &mut floquet.study {
        *spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
    }
    let planned = plan(&floquet).expect("gamma Floquet driven response should alias to Periodic");
    match planned.backend_plan {
        BackendPlanIR::FemFrequencyResponse(fem) => {
            assert_eq!(
                fem.spin_wave_bc.kind(),
                fullmag_ir::SpinWaveBoundaryKindIR::Periodic
            );
            assert_eq!(fem.spin_wave_bc.boundary_pair_ids(), ["x_faces"]);
            assert!(
                fem.periodic_constraint_sets.iter().any(|constraint| {
                    constraint.unknown_family
                        == fullmag_ir::PeriodicUnknownFamilyIR::MagnetizationDynamic
                        && constraint.phase_policy == fullmag_ir::PeriodicPhasePolicyIR::ZeroPhase
                        && constraint.pair_ids == ["x_faces".to_string()]
                }),
                "gamma Floquet alias should plan zero-phase x-face constraints: {:?}",
                fem.periodic_constraint_sets
            );
        }
        other => panic!("expected FemFrequencyResponse plan, got {other:?}"),
    }
}

#[test]
fn fem_frequency_response_periodic_airbox_magnetostatic_bc_requires_periodic_gamma_slice() {
    let mut free_bc = fem_frequency_response_mesh_asset_problem();
    if let fullmag_ir::StudyIR::FrequencyResponse {
        operator,
        magnetostatic_bc,
        ..
    } = &mut free_bc.study
    {
        operator.include_demag = true;
        *magnetostatic_bc = fullmag_ir::MagnetostaticBoundaryConditionIR::PeriodicAirboxK0;
    }
    free_bc.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::PoissonRobin,
        },
    ];
    let err = plan(&free_bc).expect_err("periodic-airbox magnetostatics require periodic m");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("magnetostatic_bc=periodic_airbox_k0")
                && reason.contains("spin_wave_bc=periodic")
        }),
        "unexpected free-bc rejection reasons: {:?}",
        err.reasons
    );

    let mut nonzero_k = free_bc.clone();
    if let fullmag_ir::StudyIR::FrequencyResponse {
        spin_wave_bc,
        k_sampling,
        ..
    } = &mut nonzero_k.study
    {
        *spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        *k_sampling = Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [1.0e6, 0.0, 0.0],
        });
    }
    let err = plan(&nonzero_k).expect_err("periodic-airbox k0 magnetostatics require gamma k");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("magnetostatic_bc=periodic_airbox_k0") && reason.contains("k=0")
        }),
        "unexpected nonzero-k rejection reasons: {:?}",
        err.reasons
    );
}

#[test]
fn fem_frequency_response_preserves_periodic_airbox_bc_through_eigen_proxy() {
    let ir = fem_frequency_response_periodic_airbox_domain_problem();
    let planned = plan(&ir).expect("periodic-airbox response must lower through its eigen proxy");
    match planned.backend_plan {
        BackendPlanIR::FemFrequencyResponse(fem) => assert_eq!(
            fem.magnetostatic_bc,
            fullmag_ir::MagnetostaticBoundaryConditionIR::PeriodicAirboxK0
        ),
        other => panic!("expected FemFrequencyResponse plan, got {other:?}"),
    }
}

#[test]
fn fem_frequency_response_periodic_airbox_plans_separate_periodic_constraint_sets() {
    let ir = fem_frequency_response_periodic_airbox_domain_problem();

    let planned = plan(&ir).expect("periodic-airbox k=0 response should lower to a P3 plan");
    match planned.backend_plan {
        BackendPlanIR::FemFrequencyResponse(fem) => {
            assert_eq!(
                fem.periodic_constraint_sets,
                vec![
                    fullmag_ir::PeriodicConstraintSetIR {
                        unknown_family: fullmag_ir::PeriodicUnknownFamilyIR::MagnetizationDynamic,
                        domain_scope: fullmag_ir::PeriodicDomainScopeIR::MagneticDomain,
                        pair_ids: vec!["x_faces".to_string()],
                        phase_policy: fullmag_ir::PeriodicPhasePolicyIR::ZeroPhase,
                        phase_loop_diagnostics: None,
                    },
                    fullmag_ir::PeriodicConstraintSetIR {
                        unknown_family:
                            fullmag_ir::PeriodicUnknownFamilyIR::MagnetostaticPotentialDynamic,
                        domain_scope: fullmag_ir::PeriodicDomainScopeIR::MagnetostaticDomainWithAir,
                        pair_ids: vec!["x_faces".to_string()],
                        phase_policy: fullmag_ir::PeriodicPhasePolicyIR::ZeroPhase,
                        phase_loop_diagnostics: None,
                    },
                ]
            );
        }
        other => panic!("expected FemFrequencyResponse plan, got {other:?}"),
    }
}

#[test]
fn fem_frequency_response_preserves_generated_frozen_domain_mesh_workflow_mode() {
    let mut ir = fem_frequency_response_periodic_airbox_domain_problem();
    ir.problem_meta.runtime_metadata.insert(
        "mesh_workflow".to_string(),
        serde_json::json!({
            "build_target": "domain",
            "domain_mesh_mode": "generated_frozen_magnetic_submesh",
        }),
    );

    let planned = plan(&ir).expect("periodic-airbox response should preserve mesh workflow");
    match planned.backend_plan {
        BackendPlanIR::FemFrequencyResponse(fem) => {
            assert_eq!(
                fem.domain_mesh_workflow_mode.as_deref(),
                Some("generated_frozen_magnetic_submesh")
            );
        }
        other => panic!("expected FemFrequencyResponse plan, got {other:?}"),
    }
}

#[test]
fn fem_frequency_response_floquet_airbox_plans_delta_phi_bloch_constraint_set() {
    let ir = fem_frequency_response_periodic_airbox_domain_problem();

    let planned = plan(&ir).expect("periodic-airbox k=0 response should lower to a P3 plan");
    match planned.backend_plan {
        BackendPlanIR::FemFrequencyResponse(mut fem) => {
            fem.spin_wave_bc = fullmag_ir::SpinWaveBoundaryConditionIR::Config(
                fullmag_ir::SpinWaveBoundaryConfigIR {
                    kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                    boundary_pair_id: None,
                    pair_ids: vec!["x_faces".to_string()],
                    phase_convention: fullmag_ir::PhaseConventionIR::ExpMinusIKDotDeltaR,
                    surface_anisotropy_ks: None,
                    surface_anisotropy_axis: None,
                },
            );
            fem.k_sampling = Some(fullmag_ir::KSamplingIR::Single {
                k_vector: [1.0e6, 0.0, 0.0],
            });
            fem.magnetostatic_bc = fullmag_ir::MagnetostaticBoundaryConditionIR::FloquetAirbox;

            let constraint_sets = crate::fem::frequency_response_periodic_constraint_sets(&fem);
            let delta_phi_constraint = constraint_sets
                .iter()
                .find(|constraint| {
                    constraint.unknown_family
                        == fullmag_ir::PeriodicUnknownFamilyIR::MagnetostaticPotentialDynamic
                        && constraint.domain_scope
                            == fullmag_ir::PeriodicDomainScopeIR::MagnetostaticDomainWithAir
                })
                .expect(
                    "floquet_airbox should emit a dynamic magnetostatic-potential Bloch constraint",
                );

            assert_eq!(delta_phi_constraint.pair_ids, vec!["x_faces".to_string()]);
            match &delta_phi_constraint.phase_policy {
                fullmag_ir::PeriodicPhasePolicyIR::BlochPhase {
                    phase_convention,
                    k_vector_rad_per_m,
                    real_imag_mixing,
                } => {
                    assert_eq!(
                        *phase_convention,
                        fullmag_ir::PhaseConventionIR::ExpMinusIKDotDeltaR
                    );
                    assert_eq!(*k_vector_rad_per_m, [1.0e6, 0.0, 0.0]);
                    assert!(*real_imag_mixing);
                }
                other => panic!("expected BlochPhase periodic phase policy, got {other:?}"),
            }
        }
        other => panic!("expected FemFrequencyResponse plan, got {other:?}"),
    }
}

fn fem_frequency_response_mesh_asset_problem() -> ProblemIR {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fem;
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                element_markers: vec![1],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
                boundary_markers: vec![1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
        }],
        fem_domain_mesh_asset: None,
    });
    ir.energy_terms = vec![fullmag_ir::EnergyTermIR::Exchange];
    ir.study = fullmag_ir::StudyIR::FrequencyResponse {
        dynamics: ir.study.dynamics().clone(),
        operator: fullmag_ir::EigenOperatorConfigIR {
            kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
        k_sampling: Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        }),
        normalization: fullmag_ir::FrequencyResponseNormalizationIR::UnitL2,
        damping_policy: fullmag_ir::EigenDampingPolicyIR::Include,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
        excitation: fullmag_ir::FrequencyExcitationIR {
            field_au_per_m: [0.0, 0.0, 1.0],
            phase_rad: 0.375,
        },
        frequencies_hz: fullmag_ir::FrequencySweepIR {
            values_hz: vec![1.0e9, 2.0e9],
        },
        solver_policy: None,
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            stage_autosave: None,
            outputs: vec![fullmag_ir::OutputIR::FrequencyResponseOutput {
                observable: fullmag_ir::FrequencyResponseOutputIR::SusceptibilityTensor,
            }],
        },
    };
    ir
}

fn fem_frequency_response_periodic_airbox_domain_problem() -> ProblemIR {
    let mut ir = fem_frequency_response_mesh_asset_problem();
    let geometry_assets = ir
        .geometry_assets
        .as_mut()
        .expect("test problem should carry geometry assets");
    geometry_assets.fem_mesh_assets.clear();
    geometry_assets.fem_domain_mesh_asset = Some(fullmag_ir::FemDomainMeshAssetIR {
        mesh_source: None,
        mesh: Some(fullmag_ir::MeshIR {
            mesh_name: "periodic_airbox_strip".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [-1.0, -1.0, -1.0],
                [2.0, -1.0, -1.0],
                [-1.0, 2.0, -1.0],
                [-1.0, -1.0, 2.0],
            ],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
            element_markers: vec![1, 0],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![
                [0, 1, 2],
                [1, 2, 3],
                [4, 5, 6],
            ]),
            boundary_markers: vec![10, 11, 99],
            periodic_boundary_pairs: vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
                pair_id: "x_faces".to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: 10,
                marker_b: 11,
                translation: Some([1.0, 0.0, 0.0]),
                tolerance: Some(1.0e-12),
                axis_hint: Some("x".to_string()),
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
        object_region_markers: Vec::new(),
        build_report: None,
    });
    if let Some(mesh) = geometry_assets
        .fem_domain_mesh_asset
        .as_mut()
        .and_then(|asset| asset.mesh.as_mut())
    {
        complete_test_airbox_boundaries(mesh);
    }
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Demag {
            realization: fullmag_ir::RequestedFemDemagIR::PoissonRobin,
        },
    ];
    if let fullmag_ir::StudyIR::FrequencyResponse {
        operator,
        spin_wave_bc,
        magnetostatic_bc,
        ..
    } = &mut ir.study
    {
        operator.include_demag = true;
        *spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        *magnetostatic_bc = fullmag_ir::MagnetostaticBoundaryConditionIR::PeriodicAirboxK0;
    }
    ir
}

#[test]
fn fdm_frequency_response_remains_explicitly_not_executable() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fdm;
    ir.study = fullmag_ir::StudyIR::FrequencyResponse {
        dynamics: ir.study.dynamics().clone(),
        operator: fullmag_ir::EigenOperatorConfigIR {
            kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
        k_sampling: Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        }),
        normalization: fullmag_ir::FrequencyResponseNormalizationIR::UnitL2,
        damping_policy: fullmag_ir::EigenDampingPolicyIR::Include,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
        excitation: fullmag_ir::FrequencyExcitationIR {
            field_au_per_m: [0.0, 0.0, 1.0],
            phase_rad: 0.0,
        },
        frequencies_hz: fullmag_ir::FrequencySweepIR {
            values_hz: vec![1.0e9, 2.0e9],
        },
        solver_policy: None,
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            stage_autosave: None,
            outputs: vec![fullmag_ir::OutputIR::FrequencyResponseOutput {
                observable: fullmag_ir::FrequencyResponseOutputIR::SusceptibilityTensor,
            }],
        },
    };

    let err = plan(&ir).expect_err("FDM frequency response is not executable");
    assert!(err.reasons.iter().any(|reason| {
        reason.contains("StudyIR::FrequencyResponse is not executable on backend='fdm'")
            && reason.contains("dense validation frequency-response path")
    }));
}

#[test]
fn frequency_response_planner_controls_do_not_validate_time_integrator_settings() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fem;
    let dynamics = fullmag_ir::DynamicsIR::Llg {
        gyromagnetic_ratio: 2.211e5,
        integrator: "heun".to_string(),
        fixed_timestep: Some(1.0e-13),
        adaptive_timestep: Some(fullmag_ir::AdaptiveTimeStepIR {
            tolerance_mode: fullmag_ir::AdaptiveToleranceModeIR::Advanced,
            atol: 1.0e-6,
            rtol: 1.0e-6,
            dt_initial: Some(1.0e-13),
            dt_min: 1.0e-18,
            dt_max: Some(1.0e-12),
            safety: 0.9,
            growth_limit: 2.0,
            shrink_limit: 0.2,
            max_spin_rotation: None,
            norm_tolerance: None,
        }),
        field_refresh: None,
        mechanics: None,
    };
    ir.study = fullmag_ir::StudyIR::FrequencyResponse {
        dynamics,
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
        magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
        excitation: fullmag_ir::FrequencyExcitationIR {
            field_au_per_m: [0.0, 0.0, 1.0],
            phase_rad: 0.0,
        },
        frequencies_hz: fullmag_ir::FrequencySweepIR {
            values_hz: vec![1.0e9, 2.0e9],
        },
        solver_policy: None,
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            stage_autosave: None,
            outputs: vec![fullmag_ir::OutputIR::FrequencyResponseOutput {
                observable: fullmag_ir::FrequencyResponseOutputIR::SusceptibilityTensor,
            }],
        },
    };

    let mut errors = Vec::new();
    let controls = validate::planned_study_controls(&ir, BackendTarget::Fem, &mut errors);

    assert!(
        errors.is_empty(),
        "frequency response is a direct harmonic solve and must not fail planner controls on time-integrator-only settings: {errors:?}"
    );
    assert!(
        controls.integrator.is_none(),
        "frequency response is a direct harmonic solve and must not resolve a time integrator"
    );
}

#[test]
fn frequency_response_planner_controls_ignore_invalid_time_integrator_alias() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fem;
    let dynamics = fullmag_ir::DynamicsIR::Llg {
        gyromagnetic_ratio: 2.211e5,
        integrator: "not-a-time-integrator-for-frequency-response".to_string(),
        fixed_timestep: None,
        adaptive_timestep: None,
        field_refresh: None,
        mechanics: None,
    };
    ir.study = fullmag_ir::StudyIR::FrequencyResponse {
        dynamics,
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
        magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
        excitation: fullmag_ir::FrequencyExcitationIR {
            field_au_per_m: [0.0, 0.0, 1.0],
            phase_rad: 0.0,
        },
        frequencies_hz: fullmag_ir::FrequencySweepIR {
            values_hz: vec![1.0e9],
        },
        solver_policy: None,
        sampling: fullmag_ir::SamplingIR {
            table_autosave: None,
            stage_autosave: None,
            outputs: vec![fullmag_ir::OutputIR::FrequencyResponseOutput {
                observable: fullmag_ir::FrequencyResponseOutputIR::SusceptibilityTensor,
            }],
        },
    };

    let mut errors = Vec::new();
    let controls = validate::planned_study_controls(&ir, BackendTarget::Fem, &mut errors);

    assert!(
        errors.is_empty(),
        "frequency response planner controls must ignore time-integrator-only aliases: {errors:?}"
    );
    assert!(
        controls.integrator.is_none(),
        "frequency response must keep time integrator non-applicable even when an invalid alias is present"
    );
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
            projection_policy: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                element_markers: vec![1],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
            projection_policy: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                element_markers: vec![1],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
                element_markers: vec![1, 0],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [4, 5, 6]]),
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
            object_region_markers: Vec::new(),
            build_report: None,
        }),
    });
    if let Some(mesh) = ir
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .and_then(|asset| asset.mesh.as_mut())
    {
        complete_test_airbox_boundaries(mesh);
    }

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
        object_id: None,
        name: "second".to_string(),
        region: "second".to_string(),
        material: "Py".to_string(), // same as the first body
        initial_magnetization: Some(InitialMagnetizationIR::Uniform {
            value: [0.0, 1.0, 0.0],
        }),
        absorbing_boundary: None,
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
                    cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                    element_markers: vec![1],
                    facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
                    cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                    element_markers: vec![1],
                    facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
        element_markers: vec![1, 0],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [4, 5, 6]]),
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
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
        element_markers: vec![1],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
        cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
        element_markers: vec![1],
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
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
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
            element_markers: vec![1],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
            boundary_markers: vec![1],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
        }),
        region_markers: vec![],
        object_region_markers: Vec::new(),
        build_report: Some(fullmag_ir::FemSharedDomainBuildReportIR {
            build_mode: "component_aware".to_string(),
            fallbacks_triggered: Some(vec![]),
            effective_airbox_target: None,
            effective_airbox_hmax: Some(100e-9),
            effective_per_object_targets: std::collections::HashMap::new(),
            region_markers: vec![],
            object_region_markers: vec![],
            used_size_field_kinds: vec!["ComponentVolumeConstant".to_string()],
            size_fields_realized: vec![],
            operation_statuses: vec![],
            thin_film_diagnostics: vec![],
            degraded: false,
            authored_regions_count: None,
            realized_regions_count: None,
            magnetic_submesh_signatures: Vec::new(),
            selector_resolution: Vec::new(),
            orphan_entities: Vec::new(),
            rejected_element_types: Vec::new(),
            mixed_layer_topology_certificate: None,
            mixed_topology_provenance: None,
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
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
            element_markers: vec![1],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
            boundary_markers: vec![1],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
        }),
        region_markers: vec![],
        object_region_markers: Vec::new(),
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
        axis: [0.0, 0.0, 1.0],
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
            projection_policy: None,
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
fn fdm_projected_rk_policy_is_resolved_into_backend_plan() {
    let mut ir = ProblemIR::bootstrap_example();
    let fdm = ir
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .expect("bootstrap example must provide FDM hints");
    fdm.projection_policy = Some(fullmag_ir::FdmProjectionPolicyIR::UnitSphere);

    let planned = plan(&ir).expect("explicit projected-RK policy should be plannable");
    let BackendPlanIR::Fdm(fdm_plan) = planned.backend_plan else {
        panic!("bootstrap example should resolve to an FDM plan");
    };
    assert_eq!(
        fdm_plan.projection_policy,
        Some(fullmag_ir::FdmProjectionPolicyIR::UnitSphere)
    );
}

#[test]
fn fdm_boundary_correction_rejects_geometry_without_supported_sdf() {
    for tier in ["volume", "full"] {
        let mut ir = ProblemIR::bootstrap_example();
        ir.geometry.entries = vec![GeometryEntryIR::Box {
            name: "box".to_string(),
            size: [100e-9, 50e-9, 10e-9],
        }];
        ir.regions[0].geometry = "box".to_string();
        ir.backend_policy.discretization_hints = Some(DiscretizationHintsIR {
            fdm: Some(fullmag_ir::FdmHintsIR {
                cell: [2e-9, 2e-9, 2e-9],
                default_cell: None,
                per_magnet: None,
                demag: None,
                boundary_correction: Some(tier.to_string()),
                boundary_phi_floor: None,
                boundary_delta_min: None,
                projection_policy: None,
            }),
            fem: None,
            hybrid: None,
        });

        let error = plan(&ir).expect_err("unsupported boundary SDF must fail closed");
        assert!(
            error
                .reasons
                .iter()
                .any(|reason| reason.contains("boundary_correction")
                    && reason.contains("does not have a supported SDF")),
            "tier={tier}, reasons={:?}",
            error.reasons
        );
    }
}

#[test]
fn fdm_translated_difference_keeps_boundary_sdf_realization() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.geometry.entries = vec![GeometryEntryIR::Difference {
        name: "ring".to_string(),
        base: Box::new(GeometryEntryIR::Cylinder {
            name: "outer".to_string(),
            radius: 50e-9,
            height: 6e-9,
            axis: [0.0, 0.0, 1.0],
        }),
        tool: Box::new(GeometryEntryIR::Translate {
            name: "offset_hole".to_string(),
            base: Box::new(GeometryEntryIR::Cylinder {
                name: "inner".to_string(),
                radius: 15e-9,
                height: 2e-9,
                axis: [0.0, 0.0, 1.0],
            }),
            by: [20e-9, 0.0, 0.0],
        }),
    }];
    ir.regions[0].geometry = "ring".to_string();
    ir.backend_policy.discretization_hints = Some(DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 2e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: Some("full".to_string()),
            boundary_phi_floor: None,
            boundary_delta_min: None,
            projection_policy: None,
        }),
        fem: None,
        hybrid: None,
    });

    let plan = plan(&ir).expect("translated CSG with boundary correction should plan");
    let BackendPlanIR::Fdm(fdm) = plan.backend_plan else {
        panic!("expected FDM plan");
    };
    assert!(
        fdm.boundary_geometry.is_some(),
        "translated finite-cylinder CSG must retain a boundary SDF"
    );
}

#[test]
fn fdm_translated_base_boundary_sdf_matches_active_mask_coordinates() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.geometry.entries = vec![GeometryEntryIR::Translate {
        name: "shifted_pillar".to_string(),
        base: Box::new(GeometryEntryIR::Cylinder {
            name: "pillar".to_string(),
            radius: 20e-9,
            height: 4e-9,
            axis: [0.0, 0.0, 1.0],
        }),
        by: [20e-9, 0.0, 0.0],
    }];
    ir.regions[0].geometry = "shifted_pillar".to_string();
    ir.backend_policy.discretization_hints = Some(DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [10e-9, 10e-9, 2e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: Some("full".to_string()),
            boundary_phi_floor: None,
            boundary_delta_min: None,
            projection_policy: None,
        }),
        fem: None,
        hybrid: None,
    });

    let plan = plan(&ir).expect("translated base with boundary correction should plan");
    let BackendPlanIR::Fdm(fdm) = plan.backend_plan else {
        panic!("expected FDM plan");
    };
    assert_eq!(fdm.origin_m, [0.0, -20e-9, -2e-9]);
    let serialized = serde_json::to_value(&fdm).expect("FDM plan should serialize");
    assert_eq!(
        serialized["origin_m"],
        serde_json::json!([0.0, -20e-9, -2e-9])
    );
    let boundary = fdm
        .boundary_geometry
        .expect("translated base must retain SDF");
    let active_mask = fdm
        .active_mask
        .expect("cylinder should have an active mask");
    let active_index = active_mask
        .iter()
        .position(|active| *active)
        .expect("translated cylinder should contain active cells");
    assert!(
        boundary.volume_fraction[active_index] > 0.0,
        "boundary volume fraction must be non-zero wherever translated active mask is set"
    );
}

#[test]
fn fdm_translated_single_grid_asset_matches_multilayer_origin() {
    let mut ir = ProblemIR::bootstrap_example();
    let translation = [30e-9, -10e-9, 4e-9];
    ir.geometry.entries = vec![GeometryEntryIR::Translate {
        name: "shifted_asset".to_string(),
        base: Box::new(GeometryEntryIR::Box {
            name: "asset_base".to_string(),
            size: [4e-9, 4e-9, 2e-9],
        }),
        by: translation,
    }];
    ir.regions[0].geometry = "shifted_asset".to_string();
    // FdmGridAssetIR origins are Cartesian/world-space coordinates.  The
    // translated geometry is already materialized before planner lowering.
    let asset_origin = [28e-9, -12e-9, 3e-9];
    ir.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: vec![fullmag_ir::FdmGridAssetIR {
            geometry_name: "shifted_asset".to_string(),
            cells: [2, 2, 1],
            cell_size: [2e-9, 2e-9, 2e-9],
            origin: asset_origin,
            active_mask: vec![true, true, true, false],
        }],
        fem_mesh_assets: vec![],
        fem_domain_mesh_asset: None,
    });

    let planned = plan(&ir).expect("translated single-grid asset should plan");
    let BackendPlanIR::Fdm(single) = planned.backend_plan else {
        panic!("expected single-grid FDM plan");
    };
    assert_eq!(single.origin_m, asset_origin);
    let first_active_cell: [f64; 3] =
        std::array::from_fn(|axis| single.origin_m[axis] + 0.5 * single.cell_size[axis]);
    for (actual, expected) in first_active_cell.into_iter().zip([29e-9, -11e-9, 4e-9]) {
        assert!((actual - expected).abs() < 1e-21);
    }
    assert!(single.active_mask.as_ref().expect("asset mask")[0]);
    assert!(!single.active_mask.as_ref().expect("asset mask")[3]);
}

#[test]
fn cylinder_axis_controls_oriented_bounds_and_containment() {
    let cylinder = GeometryEntryIR::Cylinder {
        name: "oriented".to_string(),
        radius: 1.0,
        height: 4.0,
        axis: [1.0, 0.0, 0.0],
    };
    let shape = ir_to_shape(&cylinder).expect("cylinder should lower");
    let predicate = shape.compile().expect("cylinder should compile");
    let (min, max) = shape_local_bounds(&shape).expect("cylinder bounds should be analytic");
    assert_eq!(min, [-2.0, -1.0, -1.0]);
    assert_eq!(max, [2.0, 1.0, 1.0]);
    assert!(predicate.contains([1.5, 0.0, 0.0]).unwrap());
    assert!(!predicate.contains([0.0, 1.1, 0.0]).unwrap());

    let y_axis = GeometryEntryIR::Cylinder {
        name: "y_axis".to_string(),
        radius: 1.0,
        height: 4.0,
        axis: [0.0, 1.0, 0.0],
    };
    let y_shape = ir_to_shape(&y_axis).expect("y-axis cylinder should lower");
    let y_predicate = y_shape.compile().expect("y-axis cylinder should compile");
    let (y_min, y_max) = shape_local_bounds(&y_shape).expect("y-axis bounds should be analytic");
    assert_eq!(y_min, [-1.0, -2.0, -1.0]);
    assert_eq!(y_max, [1.0, 2.0, 1.0]);
    assert!(y_predicate.contains([0.0, 1.5, 0.0]).unwrap());
    assert!(!y_predicate.contains([1.1, 0.0, 0.0]).unwrap());

    let diagonal = GeometryEntryIR::Cylinder {
        name: "diagonal".to_string(),
        radius: 1.0,
        height: 4.0,
        axis: [1.0, 1.0, 1.0],
    };
    let diagonal_shape = ir_to_shape(&diagonal).expect("diagonal cylinder should lower");
    let diagonal_predicate = diagonal_shape
        .compile()
        .expect("diagonal cylinder should compile");
    let (diagonal_min, diagonal_max) =
        shape_local_bounds(&diagonal_shape).expect("diagonal bounds should be analytic");
    let extent = (1.0_f64 * (1.0_f64 - 1.0_f64 / 3.0_f64)
        + 4.0_f64 * 4.0_f64 / 4.0_f64 * (1.0_f64 / 3.0_f64))
        .sqrt();
    for component in diagonal_min.iter().chain(diagonal_max.iter()) {
        assert!((component.abs() - extent).abs() < 1e-12);
    }
    assert!(diagonal_predicate.contains([1.0, 1.0, 1.0]).unwrap());
    assert!(!diagonal_predicate.contains([2.0, -2.0, 0.0]).unwrap());
}

#[test]
fn cylinder_axis_lowering_rejects_zero_and_nonfinite_axes() {
    for axis in [[0.0, 0.0, 0.0], [f64::NAN, 0.0, 1.0]] {
        let cylinder = GeometryEntryIR::Cylinder {
            name: "invalid_axis".to_string(),
            radius: 1.0,
            height: 2.0,
            axis,
        };
        let error = ir_to_shape(&cylinder).expect_err("invalid cylinder axis must fail closed");
        assert!(error.contains("cylinder axis"));
    }
}

#[test]
fn cylinder_axis_lowering_accepts_huge_finite_axis() {
    let cylinder = GeometryEntryIR::Cylinder {
        name: "huge_axis".to_string(),
        radius: 1.0,
        height: 4.0,
        axis: [1.0e308, 1.0e308, 0.0],
    };

    let shape = ir_to_shape(&cylinder).expect("huge finite cylinder axis must normalize");
    let predicate = shape.compile().expect("huge finite cylinder must compile");

    assert!(predicate.contains([1.0, 1.0, 0.0]).unwrap());
    assert!(!predicate.contains([1.0, -1.0, 0.0]).unwrap());
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
fn fdm_pbc_demag_resolution_matrix_is_lane_independent() {
    let axes = [
        [AxisBoundary::Open, AxisBoundary::Open, AxisBoundary::Open],
        [
            AxisBoundary::Periodic,
            AxisBoundary::Open,
            AxisBoundary::Open,
        ],
        [
            AxisBoundary::Periodic,
            AxisBoundary::Periodic,
            AxisBoundary::Open,
        ],
        [
            AxisBoundary::Periodic,
            AxisBoundary::Periodic,
            AxisBoundary::Periodic,
        ],
    ];
    for device in [None, Some("cuda")] {
        for axis_set in axes {
            for demag in [
                FdmDemagPeriodicityIR::Open,
                FdmDemagPeriodicityIR::TruncatedImages,
            ] {
                let mut ir = ProblemIR::bootstrap_example();
                ir.energy_terms.push(EnergyTermIR::Demag {
                    realization: fullmag_ir::RequestedFemDemagIR::Auto,
                });
                if let Some(device) = device {
                    ir.problem_meta.runtime_metadata.insert(
                        "runtime_selection".to_string(),
                        serde_json::json!({"device": device, "device_index": 0}),
                    );
                }
                ir.pbc = Some(FdmPeriodicityIR {
                    axes: axis_set,
                    demag,
                    image_counts: Some([4, 4, 4]),
                });
                let result = plan(&ir);
                let has_periodic_axis = axis_set.iter().any(|axis| *axis == AxisBoundary::Periodic);
                if demag == FdmDemagPeriodicityIR::Open && has_periodic_axis {
                    let error = result.expect_err("periodic + open demag must fail closed");
                    assert!(
                        error.reasons.iter().any(|reason| {
                            reason.contains(
                                "FDM periodic demag requires pbc.demag='truncated_images'",
                            )
                        }),
                        "unexpected rejection for device={device:?}, axes={axis_set:?}: {:?}",
                        error.reasons
                    );
                } else {
                    let plan = result.expect("legal FDM PBC matrix case should plan");
                    assert!(matches!(plan.backend_plan, BackendPlanIR::Fdm(_)));
                }
            }
        }
    }
}

#[test]
fn fdm_cuda_fp32_periodic_exchange_is_capability_gated_until_parity() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.execution_precision = ExecutionPrecision::Single;
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

    let error = plan(&ir).expect_err("unqualified CUDA FP32 periodic exchange must fail closed");
    assert!(error.reasons.iter().any(|reason| {
        reason.contains("single")
            && reason.contains("periodic axes")
            && reason.contains("FP32 seam exchange parity")
    }));
}

#[test]
fn fdm_cuda_fp32_subcell_boundary_is_capability_gated_until_field_energy_parity() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.geometry.entries = vec![GeometryEntryIR::Cylinder {
        name: "disk".to_string(),
        radius: 50e-9,
        height: 6e-9,
        axis: [0.0, 0.0, 1.0],
    }];
    ir.regions[0].geometry = "disk".to_string();
    ir.backend_policy.execution_precision = ExecutionPrecision::Single;
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda", "device_index": 0}),
    );
    ir.backend_policy.discretization_hints = Some(DiscretizationHintsIR {
        fdm: Some(fullmag_ir::FdmHintsIR {
            cell: [2e-9, 2e-9, 2e-9],
            default_cell: None,
            per_magnet: None,
            demag: None,
            boundary_correction: Some("full".to_string()),
            boundary_phi_floor: None,
            boundary_delta_min: None,
            projection_policy: None,
        }),
        fem: None,
        hybrid: None,
    });

    let error = plan(&ir).expect_err("unqualified CUDA FP32 T0/T1 must fail closed");
    assert!(error.reasons.iter().any(|reason| {
        reason.contains("execution_precision='single'")
            && reason.contains("boundary_correction='full'")
            && reason.contains("FP32 sub-cell field/energy parity")
    }));
}

#[test]
fn fdm_multilayer_periodic_axes_fail_closed_until_kernel_parity() {
    let mut ir = stacked_two_body_multilayer_problem();
    ir.pbc = Some(FdmPeriodicityIR {
        axes: [
            AxisBoundary::Periodic,
            AxisBoundary::Open,
            AxisBoundary::Open,
        ],
        demag: FdmDemagPeriodicityIR::TruncatedImages,
        image_counts: Some([2, 0, 0]),
    });

    let error = plan(&ir).expect_err("multilayer periodic kernels must fail closed");
    assert!(error.reasons.iter().any(|reason| {
        reason.contains("multilayer periodic axes") && reason.contains("self/shifted demag kernels")
    }));
}

#[test]
fn fdm_periodic_boundary_correction_fails_closed_until_seam_parity() {
    for correction in ["volume", "full"] {
        let mut ir = ProblemIR::bootstrap_example();
        let fdm = ir
            .backend_policy
            .discretization_hints
            .as_mut()
            .and_then(|hints| hints.fdm.as_mut())
            .expect("bootstrap must carry FDM hints");
        fdm.boundary_correction = Some(correction.to_string());
        ir.pbc = Some(FdmPeriodicityIR {
            axes: [
                AxisBoundary::Periodic,
                AxisBoundary::Open,
                AxisBoundary::Open,
            ],
            demag: FdmDemagPeriodicityIR::Open,
            image_counts: None,
        });

        let error = plan(&ir).expect_err("periodic T0/T1 must fail closed");
        assert!(error.reasons.iter().any(|reason| {
            reason.contains("boundary_correction")
                && reason.contains(correction)
                && reason.contains("seam-aware T0/T1 exchange parity")
        }));
    }
}

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
            let resolved = fdm
                .resolved_periodic_images
                .as_ref()
                .expect("planner must persist resolved periodic workspace cost");
            assert_eq!(resolved.resolved_image_counts, [4, 4, 0]);
            assert_eq!(resolved.padded_counts[0], u64::from(fdm.grid.cells[0]));
            assert_eq!(resolved.padded_counts[1], u64::from(fdm.grid.cells[1]));
            assert_eq!(resolved.padded_counts[2], u64::from(fdm.grid.cells[2]) * 2);
        }
        _ => panic!("expected FDM plan"),
    }
}

#[test]
fn fdm_rejects_fem_periodic_airbox_pbc_demag() {
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
        demag: FdmDemagPeriodicityIR::PeriodicAirboxK0,
        image_counts: None,
    });

    let err = plan(&ir).expect_err("FDM must reject FEM periodic-airbox demag PBC");
    assert!(
        err.reasons
            .iter()
            .any(|reason| reason.contains("pbc.demag='periodic_airbox_k0'")),
        "unexpected FDM periodic-airbox rejection reasons: {:?}",
        err.reasons
    );
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
            assert!(
                fdm.resolved_periodic_images.is_some(),
                "CUDA plan must carry the same resolved workspace contract"
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
            AxisBoundary::Periodic,
            AxisBoundary::Periodic,
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
fn fdm_bulk_dmi_rejects_open_boundaries_until_natural_boundary_is_qualified() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.energy_terms.push(EnergyTermIR::BulkDmi { d: 1.0e-3 });

    let error = plan(&ir)
        .expect_err("open-boundary BulkDmi must not plan without its natural boundary condition");
    assert!(
        error.reasons.iter().any(|reason| {
            reason.contains("BulkDmi")
                && reason.contains("natural exchange+DMI free-surface boundary condition")
        }),
        "unexpected planner errors: {:?}",
        error.reasons
    );
}

#[test]
fn fdm_interfacial_dmi_rejects_non_z_interface_normal_instead_of_ignoring_it() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.energy_terms.push(EnergyTermIR::InterfacialDmi {
        d: 1.0e-3,
        interface_normal: Some([1.0, 0.0, 0.0]),
    });

    let error = plan(&ir).expect_err("FDM must not silently discard an unsupported iDMI normal");
    assert!(
        error.reasons.iter().any(|reason| {
            reason.contains("InterfacialDmi.interface_normal")
                && reason.contains("+z interface normal")
        }),
        "unexpected planner errors: {:?}",
        error.reasons
    );
}

#[test]
fn fdm_rejects_spatial_dmi_material_fields_before_the_native_abi() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.materials[0].dind_field = Some(vec![1.0e-3; 8]);

    let error = plan(&ir).expect_err("FDM must reject material DMI fields it cannot materialize");
    assert!(
        error
            .reasons
            .iter()
            .any(|reason| reason.contains("dind_field") && reason.contains("not executable")),
        "unexpected planner errors: {:?}",
        error.reasons
    );
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
        coupling: TransportCouplingIR::OneWay,
        time_envelope: None,
        definition: None,
    });
    ir.energy_terms.push(EnergyTermIR::OerstedField {
        id: None,
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

#[test]
fn fdm_prescribed_zeeman_mask_antenna_plans_with_extra_geometry() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.geometry.entries.push(GeometryEntryIR::Translate {
        name: "antenna_box".to_string(),
        base: Box::new(GeometryEntryIR::Box {
            name: "antenna_box_base".to_string(),
            size: [50e-9, 1.0e-6, 10e-9],
        }),
        by: [0.0, 0.0, 0.0],
    });
    ir.current_modules
        .push(CurrentModuleIR::AntennaFieldSource {
            name: "center_microstrip".to_string(),
            model: AntennaFieldSourceModelIR::PrescribedZeemanMask,
            solver: None,
            antenna: None,
            drive: None,
            air_box_factor: None,
            object: Some("antenna_box".to_string()),
            field: Some(AntennaFieldIR {
                amplitude_b_t: 1.0e-3,
                direction: [0.0, 1.0, 0.0],
            }),
            spatial_profile: Some(AntennaSpatialProfileIR::Uniform),
            waveform: Some(TimeDependenceIR::SincPulse {
                cutoff_hz: 20.0e9,
                t0: 0.0,
                amplitude: 1.0,
            }),
        });
    let output = OutputIR::Field {
        name: "H_ant".to_string(),
        every_seconds: 1.0e-12,
    };
    match &mut ir.study {
        StudyIR::TimeEvolution { sampling, .. }
        | StudyIR::Relaxation { sampling, .. }
        | StudyIR::Eigenmodes { sampling, .. }
        | StudyIR::FrequencyResponse { sampling, .. }
        | StudyIR::Hysteresis { sampling, .. } => sampling.outputs.push(output),
    }

    let plan = plan(&ir).expect("prescribed Zeeman antenna mask should plan");
    match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            assert_eq!(fdm.antenna_zeeman_masks.len(), 1);
            let mask = &fdm.antenna_zeeman_masks[0];
            assert_eq!(mask.source, "center_microstrip");
            assert_eq!(mask.object, "antenna_box");
            assert_eq!(mask.field_xyz.len(), fdm.initial_magnetization.len());
            assert!(mask.field_xyz.iter().any(|value| *value != [0.0, 0.0, 0.0]));
            assert!(matches!(
                mask.waveform,
                Some(TimeDependenceIR::SincPulse { .. })
            ));
        }
        _ => panic!("expected FDM plan"),
    }
}

#[test]
fn fdm_regional_field_drive_is_carried_as_canonical_plan_input() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.field_drives.push(RegionalFieldDriveIR {
        id: "pulse".to_string(),
        name: "Pulse".to_string(),
        kind: FieldDriveKindIR::Regional,
        enabled: true,
        target: FieldTargetIR::Global {},
        amplitude_b_t: 1.0e-3,
        direction: [0.0, 1.0, 0.0],
        spatial_profile: FieldSpatialProfileIR::Uniform {},
        waveform: TimeDependenceIR::SincPulse {
            cutoff_hz: 20.0e9,
            t0: 50.0e-12,
            amplitude: 1.0,
        },
        time_origin: FieldTimeOriginIR::StageLocal,
        activation: DriveActivationIR::AllTimeEvolution {},
        migration: None,
    });
    match &mut ir.study {
        StudyIR::TimeEvolution { sampling, .. }
        | StudyIR::Relaxation { sampling, .. }
        | StudyIR::Eigenmodes { sampling, .. }
        | StudyIR::FrequencyResponse { sampling, .. }
        | StudyIR::Hysteresis { sampling, .. } => {
            sampling.outputs.push(OutputIR::Field {
                name: "H_drive".into(),
                every_seconds: 1e-12,
            });
            sampling.outputs.push(OutputIR::Scalar {
                name: "E_drive".into(),
                every_seconds: 1e-12,
            });
        }
    }

    let execution = plan(&ir).expect("canonical regional drive should plan on FDM");
    match execution.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            assert_eq!(fdm.field_drives, ir.field_drives);
            assert!(fdm.antenna_zeeman_masks.is_empty());
            assert_eq!(fdm.regional_field_drive_bases.len(), 1);
            let expected_h = 1.0e-3 / crate::util::MU0;
            for value in &fdm.regional_field_drive_bases[0].field_xyz {
                assert_eq!(*value, [0.0, expected_h, 0.0]);
            }
        }
        other => panic!("expected FDM plan, got {other:?}"),
    }
}

#[test]
fn fdm_regional_field_drive_activation_is_resolved_for_active_stage() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.problem_meta.runtime_metadata.insert(
        "study_pipeline".into(),
        serde_json::json!({"version":"study_pipeline.v1","nodes":[
            {"id":"relax","enabled":true}, {"id":"excite","enabled":true}
        ]}),
    );
    ir.problem_meta
        .runtime_metadata
        .insert("active_stage_id".into(), serde_json::json!("relax"));
    ir.problem_meta
        .runtime_metadata
        .insert("stage_start_time_s".into(), serde_json::json!(2e-12));
    ir.field_drives.push(RegionalFieldDriveIR {
        id: "excite-only".into(),
        name: "Excite only".into(),
        kind: FieldDriveKindIR::Regional,
        enabled: true,
        target: FieldTargetIR::Global {},
        amplitude_b_t: 1e-3,
        direction: [0.0, 1.0, 0.0],
        spatial_profile: FieldSpatialProfileIR::Uniform {},
        waveform: TimeDependenceIR::Constant,
        time_origin: FieldTimeOriginIR::StageLocal,
        activation: DriveActivationIR::StageIds {
            stage_ids: vec!["excite".into()],
        },
        migration: None,
    });
    let relaxed = plan(&ir).expect("inactive drive should plan");
    let BackendPlanIR::Fdm(relaxed) = relaxed.backend_plan else {
        panic!("expected FDM")
    };
    assert!(relaxed.field_drives.is_empty());
    assert!(relaxed.regional_field_drive_bases.is_empty());
    assert_eq!(relaxed.time_stage.active_stage_id.as_deref(), Some("relax"));
    assert_eq!(relaxed.time_stage.start_time_s, 2e-12);

    ir.problem_meta
        .runtime_metadata
        .insert("active_stage_id".into(), serde_json::json!("excite"));
    let excited = plan(&ir).expect("active drive should plan");
    let BackendPlanIR::Fdm(excited) = excited.backend_plan else {
        panic!("expected FDM")
    };
    assert_eq!(excited.field_drives.len(), 1);
    assert_eq!(excited.regional_field_drive_bases.len(), 1);
}

#[test]
fn all_time_evolution_drive_is_planned_only_for_time_evolution() {
    let mut ir = ProblemIR::bootstrap_example();
    let time_evolution = ir.study.clone();
    let sampling = ir.study.sampling().clone();
    ir.study = StudyIR::Relaxation {
        algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
        dynamics: None,
        stop: RelaxStopIR {
            torque_tolerance_apm: None,
            energy_tolerance_j: None,
            max_steps: Some(2),
            max_relaxation_time_s: None,
        },
        sampling,
    };
    ir.field_drives.push(RegionalFieldDriveIR {
        id: "time-evolution-only".into(),
        name: "Time evolution only".into(),
        kind: FieldDriveKindIR::Regional,
        enabled: true,
        target: FieldTargetIR::Global {},
        amplitude_b_t: 1e-3,
        direction: [0.0, 1.0, 0.0],
        spatial_profile: FieldSpatialProfileIR::Uniform {},
        waveform: TimeDependenceIR::Constant,
        time_origin: FieldTimeOriginIR::StageLocal,
        activation: DriveActivationIR::AllTimeEvolution {},
        migration: None,
    });

    let relaxed = plan(&ir).expect("inactive drive should not invalidate relaxation");
    let BackendPlanIR::Fdm(relaxed) = relaxed.backend_plan else {
        panic!("expected FDM plan");
    };
    assert!(relaxed.field_drives.is_empty());
    assert!(relaxed.regional_field_drive_bases.is_empty());

    ir.study = time_evolution;
    let evolved = plan(&ir).expect("drive should be active during time evolution");
    let BackendPlanIR::Fdm(evolved) = evolved.backend_plan else {
        panic!("expected FDM plan");
    };
    assert_eq!(evolved.field_drives.len(), 1);
    assert_eq!(evolved.regional_field_drive_bases.len(), 1);
}

#[test]
fn fdm_regional_field_drive_rejects_abm3_without_exact_stage_time_contract() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.field_drives.push(RegionalFieldDriveIR {
        id: "pulse".into(),
        name: "Pulse".into(),
        kind: FieldDriveKindIR::Regional,
        enabled: true,
        target: FieldTargetIR::Global {},
        amplitude_b_t: 1e-3,
        direction: [0.0, 1.0, 0.0],
        spatial_profile: FieldSpatialProfileIR::Uniform {},
        waveform: TimeDependenceIR::SincPulse {
            cutoff_hz: 20e9,
            t0: 50e-12,
            amplitude: 1.0,
        },
        time_origin: FieldTimeOriginIR::StageLocal,
        activation: DriveActivationIR::AllTimeEvolution {},
        migration: None,
    });
    if let StudyIR::TimeEvolution {
        dynamics: DynamicsIR::Llg { integrator, .. },
        ..
    } = &mut ir.study
    {
        *integrator = "abm3".to_string();
    }

    let error = plan(&ir).expect_err("ABM3 drive must fail before runtime");
    assert!(error
        .reasons
        .iter()
        .any(|reason| reason.contains("ABM3") && reason.contains("RegionalFieldDrive")));
}

#[test]
fn fdm_cuda_regional_field_drive_fails_closed() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cuda", "device_index": 0}),
    );
    ir.field_drives.push(RegionalFieldDriveIR {
        id: "drive".into(),
        name: "Drive".into(),
        kind: FieldDriveKindIR::Regional,
        enabled: true,
        target: FieldTargetIR::Global {},
        amplitude_b_t: 1e-3,
        direction: [0.0, 1.0, 0.0],
        spatial_profile: FieldSpatialProfileIR::Uniform {},
        waveform: TimeDependenceIR::Constant,
        time_origin: FieldTimeOriginIR::StageLocal,
        activation: DriveActivationIR::AllTimeEvolution {},
        migration: None,
    });
    let error = plan(&ir).expect_err("CUDA FDM must not silently ignore field drives");
    assert!(error
        .reasons
        .iter()
        .any(|reason| { reason.contains("fdm_cuda_regional_field_drive_unsupported") }));
}

fn fem_minimal_test_ir() -> ProblemIR {
    let mut ir = ProblemIR::bootstrap_example();
    ir.backend_policy.requested_backend = BackendTarget::Fem;
    ir.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: None,
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
                ],
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                element_markers: vec![1],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
                boundary_markers: vec![1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            object_region_markers: Vec::new(),
            build_report: None,
        }),
    });
    ir
}

fn valid_mixed_certificate_asset_for_version(
    fingerprint_version: &str,
) -> fullmag_ir::FemDomainMeshAssetIR {
    use fullmag_ir::{
        FemCellMeshPartIR, FemCellTypeIR, FemConnectivityIR, FemFacetConnectivityIR,
        FemFacetRoleIR, FemFacetTypeIR, MeshIR,
    };

    let cells = vec![
        (
            FemCellTypeIR::Prism6,
            vec![0, 1, 2, 4, 5, 6],
            FemCellMeshPartIR::Magnetic,
            1,
        ),
        (
            FemCellTypeIR::Prism6,
            vec![0, 2, 3, 4, 6, 7],
            FemCellMeshPartIR::Magnetic,
            1,
        ),
        (
            FemCellTypeIR::Pyramid5,
            vec![1, 2, 6, 5, 8],
            FemCellMeshPartIR::TransitionAir,
            0,
        ),
        (
            FemCellTypeIR::Pyramid5,
            vec![0, 4, 7, 3, 9],
            FemCellMeshPartIR::TransitionAir,
            0,
        ),
        (
            FemCellTypeIR::Pyramid5,
            vec![2, 3, 7, 6, 10],
            FemCellMeshPartIR::TransitionAir,
            0,
        ),
        (
            FemCellTypeIR::Pyramid5,
            vec![0, 1, 5, 4, 11],
            FemCellMeshPartIR::TransitionAir,
            0,
        ),
        (
            FemCellTypeIR::Tet4,
            vec![4, 5, 6, 12],
            FemCellMeshPartIR::TransitionAir,
            0,
        ),
        (
            FemCellTypeIR::Tet4,
            vec![4, 6, 7, 12],
            FemCellMeshPartIR::TransitionAir,
            0,
        ),
        (
            FemCellTypeIR::Tet4,
            vec![0, 2, 1, 13],
            FemCellMeshPartIR::TransitionAir,
            0,
        ),
        (
            FemCellTypeIR::Tet4,
            vec![0, 3, 2, 13],
            FemCellMeshPartIR::TransitionAir,
            0,
        ),
        (
            FemCellTypeIR::Tet4,
            vec![1, 2, 8, 14],
            FemCellMeshPartIR::FarAir,
            0,
        ),
        (
            FemCellTypeIR::Tet4,
            vec![15, 17, 16, 18],
            FemCellMeshPartIR::FarAir,
            0,
        ),
        (
            FemCellTypeIR::Tet4,
            vec![19, 21, 20, 22],
            FemCellMeshPartIR::FarAir,
            0,
        ),
        (
            FemCellTypeIR::Tet4,
            vec![23, 25, 24, 26],
            FemCellMeshPartIR::FarAir,
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
        mesh_name: "mixed-certified-reorder".to_string(),
        nodes: vec![
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
        ],
        cells: FemConnectivityIR {
            types: cells.iter().map(|cell| cell.0).collect(),
            offsets: cell_offsets,
            nodes: cell_nodes,
            global_ordinals: (0..cells.len() as u64).collect(),
            mesh_parts: cells.iter().map(|cell| cell.2).collect(),
        },
        element_markers: cells.iter().map(|cell| cell.3).collect(),
        facets: FemFacetConnectivityIR::empty(),
        boundary_markers: Vec::new(),
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };
    let local_faces: &[&[&[usize]]] = &[
        &[&[0, 2, 1], &[0, 1, 3], &[1, 2, 3], &[2, 0, 3]],
        &[
            &[0, 2, 1],
            &[3, 4, 5],
            &[0, 1, 4, 3],
            &[1, 2, 5, 4],
            &[2, 0, 3, 5],
        ],
        &[
            &[0, 3, 2, 1],
            &[0, 1, 4],
            &[1, 2, 4],
            &[2, 3, 4],
            &[3, 0, 4],
        ],
        &[
            &[0, 3, 2, 1],
            &[4, 5, 6, 7],
            &[0, 1, 5, 4],
            &[1, 2, 6, 5],
            &[2, 3, 7, 6],
            &[3, 0, 4, 7],
        ],
    ];
    let mut adjacency = BTreeMap::<Vec<u32>, Vec<(usize, u32)>>::new();
    for (ordinal, cell_type) in mesh.cells.types.iter().enumerate() {
        let family = match cell_type {
            FemCellTypeIR::Tet4 => local_faces[0],
            FemCellTypeIR::Prism6 => local_faces[1],
            FemCellTypeIR::Pyramid5 => local_faces[2],
            FemCellTypeIR::Hex8 => local_faces[3],
        };
        let nodes = mesh.cells.item_nodes(ordinal).unwrap();
        for face in family {
            let mut key = face.iter().map(|index| nodes[*index]).collect::<Vec<_>>();
            key.sort_unstable();
            adjacency
                .entry(key)
                .or_default()
                .push((ordinal, mesh.element_markers[ordinal]));
        }
    }
    let mut offsets = vec![0];
    for (face, owners) in adjacency {
        let role_marker = if owners.len() == 1 {
            Some((FemFacetRoleIR::Exterior, 3))
        } else if owners.len() == 2 && owners[0].1 != owners[1].1 {
            Some((FemFacetRoleIR::MaterialInterface, 2))
        } else {
            None
        };
        if let Some((role, marker)) = role_marker {
            mesh.facets.types.push(if face.len() == 3 {
                FemFacetTypeIR::Tri3
            } else {
                FemFacetTypeIR::Quad4
            });
            mesh.facets.roles.push(role);
            mesh.facets.nodes.extend(face);
            offsets.push(mesh.facets.nodes.len() as u32);
            mesh.boundary_markers.push(marker);
        }
    }
    mesh.facets.offsets = offsets;
    mesh.facets.global_ordinals = (0..mesh.facets.types.len() as u64).collect();
    let fingerprint = mesh
        .mixed_topology_fingerprint_for_version(fingerprint_version)
        .unwrap();
    let mut certificate: serde_json::Value = serde_json::from_str(
        r#"{
            "schema_version":"mixed_layer_topology_certificate.v1","certificate_status":"accepted",
            "requested_sweep_direction":"z","resolved_sweep_direction":"z",
            "requested_layer_count":1,"realized_layer_count":1,
            "magnetic_plane_coordinates_m":[-1.0,1.0],"plane_tolerance_m":2.0e-8,
            "transition_shell_thickness_m":1.0,"transition_shell_interface_tri3_count":1,
            "interface_marker":2,"outer_boundary_marker":3,
            "magnetic_bounds_min_m":[-1.0,-1.0,-1.0],"magnetic_bounds_max_m":[1.0,1.0,1.0],
            "airbox_bounds_min_m":[-2.0,-2.0,-2.0],"airbox_bounds_max_m":[2.0,2.0,2.0],
            "magnetic_bounds_relative_error":0.0,"airbox_bounds_relative_error":0.0,
            "cell_family_counts_by_marker":{"0":{"pyramid5":4,"tet4":8},"1":{"prism6":2}},
            "cell_family_counts_by_part":{"far_air":{"tet4":4},"magnetic":{"prism6":2},"transition_air":{"pyramid5":4,"tet4":4}},
            "facet_family_counts_by_role_marker":{"exterior:3":{"tri3":38},"material_interface:2":{"quad4":4,"tri3":4}},
            "jacobian_minima_m3_by_family":{"prism6":3.999999999999999,"pyramid5":0.20779754131836622,"tet4":4.0},
            "quality_metric":"tetra_decomposition_scaled_jacobian.v1",
            "scaled_jacobian_minima_by_family":{"prism6":0.4082482904638629,"pyramid5":0.40824829046386296,"tet4":0.40824829046386296},
            "scaled_jacobian_p05_by_family":{"prism6":0.4311862178478971,"pyramid5":0.40824829046386296,"tet4":0.40824829046386296},
            "magnetic_volume_m3":8.0,"expected_magnetic_volume_m3":8.0,
            "magnetic_relative_volume_error":0.0,"air_volume_m3":56.0,
            "shared_domain_volume_m3":64.0,"expected_shared_domain_volume_m3":64.0,
            "shared_domain_relative_volume_error":0.0,"marker_coverage_complete":true,
            "nonconforming_face_count":0,"orphan_face_count":0,"nonmanifold_face_count":0,
            "coincident_interface_face_count":0,"topology_fingerprint_version":"v3",
            "topology_fingerprint":"placeholder","gmsh_version":"4.15.2",
            "strategy":"shared_geo_extrusion_partitioned_pyramid_tet.v2","effective_gmsh_thread_count":1,
            "deterministic_inputs":{"algorithm_2d":6,"algorithm_3d":1,"element_order":1,"gmsh_version":"4.15.2","random_factor":0.0,"thread_count":1,"transition_partition":"cartesian_3x3x3_minus_magnetic_center","transition_volume_count":26,"pyramid_apex_optimizer":"bounded_per_apex_outward_scale_line_search","pyramid_apex_scale_step":0.001,"pyramid_apex_scale_max":1.25,"scaled_jacobian_p05_min":0.1},
            "fallbacks_triggered":[]
        }"#,
    )
    .unwrap();
    certificate["topology_fingerprint_version"] = serde_json::json!(fingerprint_version);
    certificate["topology_fingerprint"] = serde_json::json!(fingerprint);
    let certificate = serde_json::from_value(certificate).unwrap();
    let region_markers = vec![fullmag_ir::FemDomainRegionMarkerIR {
        geometry_name: "strip".to_string(),
        marker: 1,
    }];
    fullmag_ir::FemDomainMeshAssetIR {
        mesh_source: None,
        mesh: Some(mesh),
        region_markers: region_markers.clone(),
        object_region_markers: Vec::new(),
        build_report: Some(fullmag_ir::FemSharedDomainBuildReportIR {
            build_mode: "shared_domain".to_string(),
            fallbacks_triggered: Some(Vec::new()),
            effective_airbox_target: None,
            effective_airbox_hmax: None,
            effective_per_object_targets: std::collections::HashMap::new(),
            region_markers,
            object_region_markers: Vec::new(),
            used_size_field_kinds: Vec::new(),
            size_fields_realized: Vec::new(),
            operation_statuses: Vec::new(),
            thin_film_diagnostics: Vec::new(),
            magnetic_submesh_signatures: Vec::new(),
            selector_resolution: Vec::new(),
            orphan_entities: Vec::new(),
            rejected_element_types: Vec::new(),
            degraded: false,
            authored_regions_count: Some(1),
            realized_regions_count: Some(1),
            mixed_layer_topology_certificate: Some(certificate),
            mixed_topology_provenance: None,
        }),
    }
}

fn valid_mixed_certificate_asset() -> fullmag_ir::FemDomainMeshAssetIR {
    valid_mixed_certificate_asset_for_version("v3")
}

fn python_mixed_certificate_asset_for_layers(layer_count: u32) -> fullmag_ir::FemDomainMeshAssetIR {
    let payload: serde_json::Value = serde_json::from_str(match layer_count {
        2 => include_str!(
            "../../fullmag-ir/tests/fixtures/mixed_layer_topology_certificate_v1_layers_2_python_golden.json"
        ),
        3 => include_str!(
            "../../fullmag-ir/tests/fixtures/mixed_layer_topology_certificate_v1_layers_3_python_golden.json"
        ),
        4 => include_str!(
            "../../fullmag-ir/tests/fixtures/mixed_layer_topology_certificate_v1_layers_4_python_golden.json"
        ),
        _ => panic!("layered Python fixture exists only for layer counts 2 through 4"),
    })
    .expect("layered mixed topology fixture must be valid JSON");
    let mesh: fullmag_ir::MeshIR = serde_json::from_value(payload["mesh"].clone())
        .expect("layered mixed topology mesh must deserialize");
    let certificate: fullmag_ir::MixedLayerTopologyCertificateV1IR =
        serde_json::from_value(payload["certificate"].clone())
            .expect("layered mixed topology certificate must deserialize");
    let region_markers = vec![fullmag_ir::FemDomainRegionMarkerIR {
        geometry_name: "strip".to_string(),
        marker: 1,
    }];
    fullmag_ir::FemDomainMeshAssetIR {
        mesh_source: None,
        mesh: Some(mesh),
        region_markers: region_markers.clone(),
        object_region_markers: Vec::new(),
        build_report: Some(fullmag_ir::FemSharedDomainBuildReportIR {
            build_mode: "shared_domain".to_string(),
            fallbacks_triggered: Some(Vec::new()),
            effective_airbox_target: None,
            effective_airbox_hmax: None,
            effective_per_object_targets: std::collections::HashMap::new(),
            region_markers,
            object_region_markers: Vec::new(),
            used_size_field_kinds: Vec::new(),
            size_fields_realized: Vec::new(),
            operation_statuses: Vec::new(),
            thin_film_diagnostics: Vec::new(),
            magnetic_submesh_signatures: Vec::new(),
            selector_resolution: Vec::new(),
            orphan_entities: Vec::new(),
            rejected_element_types: Vec::new(),
            degraded: false,
            authored_regions_count: Some(1),
            realized_regions_count: Some(1),
            mixed_layer_topology_certificate: Some(certificate),
            mixed_topology_provenance: None,
        }),
    }
}

fn mixed_cpu_relaxation_ir(
    algorithm: fullmag_ir::RelaxationAlgorithmIR,
    demag_realization: fullmag_ir::RequestedFemDemagIR,
) -> ProblemIR {
    let mut ir = fem_minimal_test_ir();
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "cpu"}),
    );
    let dynamics = ir.study.dynamics().clone();
    let sampling = ir.study.sampling().clone();
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Demag {
            realization: demag_realization,
        },
    ];
    ir.study = fullmag_ir::StudyIR::Relaxation {
        algorithm,
        dynamics: (algorithm == fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped)
            .then_some(dynamics),
        stop: fullmag_ir::RelaxStopIR {
            torque_tolerance_apm: Some(1.0e-4),
            energy_tolerance_j: None,
            max_steps: Some(16),
            max_relaxation_time_s: None,
        },
        sampling,
    };
    ir.geometry_assets
        .as_mut()
        .expect("geometry assets")
        .fem_domain_mesh_asset = Some(valid_mixed_certificate_asset());
    ir
}

#[test]
fn fem_planner_accepts_certified_mixed_p1_cpu_double_and_rebinds_packed_certificate() {
    for (algorithm, demag_realization) in [
        (
            fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
            fullmag_ir::RequestedFemDemagIR::PoissonRobin,
        ),
        (
            fullmag_ir::RelaxationAlgorithmIR::NonlinearCg,
            fullmag_ir::RequestedFemDemagIR::PoissonDirichlet,
        ),
        (
            fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped,
            fullmag_ir::RequestedFemDemagIR::PoissonRobin,
        ),
        (
            fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
            fullmag_ir::RequestedFemDemagIR::Auto,
        ),
    ] {
        let ir = mixed_cpu_relaxation_ir(algorithm, demag_realization);
        let asset = ir
            .geometry_assets
            .as_ref()
            .and_then(|assets| assets.fem_domain_mesh_asset.as_ref())
            .expect("mixed fixture must carry a domain asset");
        asset
            .validate()
            .expect("mixed certificate fixture must be valid");
        let source_mesh = asset
            .mesh
            .as_ref()
            .expect("fixture must carry an inline mesh");
        let source_fingerprint = source_mesh.mixed_topology_fingerprint_v3().unwrap();
        let analysis = crate::mesh::analyze_shared_domain_mesh(source_mesh, &asset.region_markers)
            .expect("valid mixed fixture must be analyzable");
        let (packed_mesh, _, _) = crate::mesh::pack_mesh_by_analysis(source_mesh, &analysis)
            .expect("valid mixed fixture must be packable");
        assert_ne!(
            source_mesh.topology_fingerprint_v6(),
            packed_mesh.topology_fingerprint_v6()
        );
        ir.validate()
            .expect("problem with valid mixed certificate must pass IR validation");

        let planned = plan(&ir).expect("qualified mixed P1 CPU relaxation must plan");
        let BackendPlanIR::Fem(fem) = planned.backend_plan else {
            panic!("qualified mixed P1 relaxation must resolve to FEM");
        };
        if demag_realization == fullmag_ir::RequestedFemDemagIR::Auto {
            assert_eq!(
                fem.demag_realization,
                Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin),
                "mixed P1 auto demag must preserve requested intent and resolve to Poisson Robin",
            );
        }
        let final_fingerprint = fem.mesh.mixed_topology_fingerprint_v3().unwrap();
        assert_ne!(source_fingerprint, final_fingerprint);
        let report = fem
            .mesh_build_report
            .expect("qualified mixed P1 plan must preserve its build report");
        assert_eq!(report.fallbacks_triggered.as_deref(), Some([].as_slice()));
        assert!(!report.degraded);
        let certificate = report
            .mixed_layer_topology_certificate
            .expect("qualified mixed P1 plan must carry a final certificate");
        assert_eq!(certificate.topology_fingerprint, final_fingerprint);
        fullmag_ir::validate_mixed_layer_topology_certificate_against_mesh(&fem.mesh, &certificate)
            .expect("rebound certificate must validate against the final packed mesh");
        let provenance = report
            .mixed_topology_provenance
            .expect("qualified mixed P1 plan must bind requested and resolved intent");
        assert_eq!(
            provenance.requested_topology,
            fullmag_ir::FemMeshTopologyFamilyIR::MixedP1
        );
        assert_eq!(
            provenance.resolved_topology,
            fullmag_ir::FemMeshTopologyFamilyIR::MixedP1
        );
        assert_eq!(
            provenance.accepted_certificate_fingerprint,
            final_fingerprint
        );
        assert_eq!(
            provenance.requested_device,
            fullmag_ir::ExecutionDevice::Cpu
        );
        assert_eq!(
            provenance.capability_status,
            fullmag_ir::FemMixedTopologyCapabilityStatusIR::Implemented
        );
        assert_eq!(
            source_fingerprint,
            ir.geometry_assets
                .as_ref()
                .and_then(|assets| assets.fem_domain_mesh_asset.as_ref())
                .and_then(|asset| asset.mesh.as_ref())
                .as_ref()
                .expect("source asset remains present")
                .mixed_topology_fingerprint_v3()
                .unwrap(),
            "planning must pack a clone and never mutate the certified source asset",
        );
    }
}

#[test]
fn fem_planner_accepts_certified_cpu_and_gpu_exact_layer_matrix() {
    for device in ["cpu", "gpu"] {
        for layer_count in [1, 2, 3] {
            let mut ir = mixed_cpu_relaxation_ir(
                fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
                fullmag_ir::RequestedFemDemagIR::PoissonRobin,
            );
            ir.problem_meta.runtime_metadata.insert(
                "runtime_selection".to_string(),
                serde_json::json!({"device": device, "precision": "double"}),
            );
            let asset = if layer_count == 1 {
                valid_mixed_certificate_asset()
            } else {
                python_mixed_certificate_asset_for_layers(layer_count)
            };
            asset
                .validate()
                .expect("certified stacked prism fixture must bind to its certificate");
            ir.geometry_assets
                .as_mut()
                .expect("geometry assets")
                .fem_domain_mesh_asset = Some(asset);

            let planned = plan(&ir).unwrap_or_else(|error| {
                panic!(
                    "qualified {device} exact layer {layer_count} mixed P1 relaxation must plan: {error:?}"
                )
            });
            let BackendPlanIR::Fem(fem) = planned.backend_plan else {
                panic!("qualified mixed P1 relaxation must resolve to FEM");
            };
            let certificate = fem
                .mesh_build_report
                .as_ref()
                .and_then(|report| report.mixed_layer_topology_certificate.as_ref())
                .expect("qualified multi-layer plan must retain its certificate");
            assert_eq!(certificate.requested_layer_count, layer_count);
            assert_eq!(certificate.realized_layer_count, layer_count);
            assert_eq!(
                certificate.magnetic_plane_coordinates_m.len(),
                layer_count as usize + 1
            );
            assert_eq!(
                fem.mesh
                    .cells
                    .types
                    .iter()
                    .filter(|family| **family == fullmag_ir::FemCellTypeIR::Prism6)
                    .count(),
                2 * layer_count as usize,
                "fixture must contain genuine stacked prism topology",
            );
            fullmag_ir::validate_mixed_layer_topology_certificate_against_mesh(
                &fem.mesh,
                certificate,
            )
            .expect("packed multi-layer certificate must remain bound to the mesh");
            let provenance = fem
                .mesh_build_report
                .as_ref()
                .and_then(|report| report.mixed_topology_provenance.as_ref())
                .expect("qualified matrix entry must retain topology provenance");
            assert_eq!(
                provenance.requested_device,
                if device == "cpu" {
                    fullmag_ir::ExecutionDevice::Cpu
                } else {
                    fullmag_ir::ExecutionDevice::Gpu
                },
            );
        }
    }
}

#[test]
fn fem_planner_rejects_correctly_bound_exact_four_layer_cpu_and_gpu_before_backend() {
    for device in ["cpu", "gpu"] {
        let mut ir = mixed_cpu_relaxation_ir(
            fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
            fullmag_ir::RequestedFemDemagIR::PoissonRobin,
        );
        ir.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            serde_json::json!({"device": device, "precision": "double"}),
        );
        let asset = python_mixed_certificate_asset_for_layers(4);
        asset
            .validate()
            .expect("the L=4 rejection fixture must be correctly certificate-bound");
        ir.geometry_assets
            .as_mut()
            .expect("geometry assets")
            .fem_domain_mesh_asset = Some(asset);

        let reason = plan(&ir)
            .expect_err("exact L=4 must reject before backend selection")
            .reasons
            .join("\n");
        assert!(reason.contains("fem_mixed_p1_scope_rejected"), "{reason}");
        assert!(reason.contains("exact_1_to_3_layers"), "{reason}");
        assert!(reason.contains("fallback=none"), "{reason}");
    }
}

#[test]
fn fem_planner_accepts_certified_mixed_p1_gpu_double_and_binds_gpu_provenance() {
    let mut ir = mixed_cpu_relaxation_ir(
        fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
        fullmag_ir::RequestedFemDemagIR::PoissonRobin,
    );
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "gpu", "precision": "double"}),
    );

    let planned = plan(&ir).expect("qualified mixed P1 GPU relaxation must plan");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("qualified mixed P1 GPU relaxation must resolve to FEM")
    };
    let report = fem
        .mesh_build_report
        .as_ref()
        .expect("qualified mixed P1 GPU plan must preserve its build report");
    let certificate = report
        .mixed_layer_topology_certificate
        .as_ref()
        .expect("qualified mixed P1 GPU plan must carry its accepted certificate");
    let provenance = report
        .mixed_topology_provenance
        .as_ref()
        .expect("qualified mixed P1 GPU plan must bind mixed-topology provenance");

    assert_eq!(
        provenance.requested_device,
        fullmag_ir::ExecutionDevice::Gpu
    );
    assert_eq!(
        provenance.accepted_certificate_fingerprint,
        certificate.topology_fingerprint
    );
    assert_eq!(
        provenance.capability_status,
        fullmag_ir::FemMixedTopologyCapabilityStatusIR::Implemented
    );
}

#[test]
fn fem_planner_accepts_uniform_uniaxial_anisotropy_on_certified_mixed_p1() {
    for device in ["cpu", "gpu"] {
        let mut ir = mixed_cpu_relaxation_ir(
            fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
            fullmag_ir::RequestedFemDemagIR::PoissonRobin,
        );
        ir.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            serde_json::json!({"device": device, "precision": "double"}),
        );
        ir.materials[0].uniaxial_anisotropy = Some(1.0e5);
        ir.materials[0].uniaxial_anisotropy_k2 = Some(2.0e4);
        ir.materials[0].anisotropy_axis = Some([0.0, 0.0, 1.0]);
        let node_count = ir
            .geometry_assets
            .as_ref()
            .and_then(|assets| assets.fem_domain_mesh_asset.as_ref())
            .and_then(|asset| asset.mesh.as_ref())
            .expect("mixed fixture must carry an inline mesh")
            .nodes
            .len();
        ir.materials[0].ku_field = Some(vec![1.0e5; node_count]);
        ir.materials[0].ku2_field = Some(vec![2.0e4; node_count]);
        ir.materials[0].cubic_anisotropy_kc1 = Some(3.0e4);
        ir.materials[0].cubic_anisotropy_kc2 = Some(4.0e3);
        ir.materials[0].cubic_anisotropy_kc3 = Some(5.0e2);
        ir.materials[0].cubic_anisotropy_axis1 = Some([1.0, 0.0, 0.0]);
        ir.materials[0].cubic_anisotropy_axis2 = Some([0.0, 1.0, 0.0]);
        ir.materials[0].kc1_field = Some(vec![3.0e4; node_count]);
        ir.materials[0].kc2_field = Some(vec![4.0e3; node_count]);
        ir.materials[0].kc3_field = Some(vec![5.0e2; node_count]);

        let planned = plan(&ir).unwrap_or_else(|error| {
            panic!("uniform uniaxial anisotropy must plan on mixed P1 {device}: {error:?}")
        });
        let BackendPlanIR::Fem(fem) = planned.backend_plan else {
            panic!("qualified mixed P1 anisotropy must resolve to FEM")
        };
        assert_eq!(fem.material.uniaxial_anisotropy, Some(1.0e5));
        assert_eq!(fem.material.uniaxial_anisotropy_k2, Some(2.0e4));
        assert_eq!(fem.material.anisotropy_axis, Some([0.0, 0.0, 1.0]));
    }
}

#[test]
fn fem_planner_accepts_cpu_dmi_terms_and_nodal_d_fields_on_certified_mixed_p1() {
    let mut ir = mixed_cpu_relaxation_ir(
        fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
        fullmag_ir::RequestedFemDemagIR::Auto,
    );
    let node_count = ir
        .geometry_assets
        .as_ref()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_ref())
        .and_then(|asset| asset.mesh.as_ref())
        .expect("mixed fixture must carry an inline mesh")
        .nodes
        .len();
    ir.energy_terms.extend([
        fullmag_ir::EnergyTermIR::InterfacialDmi {
            d: 2.0e-3,
            interface_normal: None,
        },
        fullmag_ir::EnergyTermIR::BulkDmi { d: 3.0e-3 },
    ]);
    ir.materials[0].interfacial_dmi = Some(2.0e-3);
    ir.materials[0].bulk_dmi = Some(3.0e-3);
    ir.materials[0].dind_field = Some(vec![2.0e-3; node_count]);
    ir.materials[0].dbulk_field = Some(vec![3.0e-3; node_count]);

    let planned = plan(&ir).expect("mixed P1 CPU DMI must plan");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("mixed P1 CPU DMI must resolve to FEM")
    };
    assert_eq!(fem.interfacial_dmi, Some(2.0e-3));
    assert_eq!(fem.bulk_dmi, Some(3.0e-3));
}

#[test]
fn fem_planner_rejects_gpu_dmi_with_stable_mixed_p1_predicate() {
    let mut ir = mixed_cpu_relaxation_ir(
        fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
        fullmag_ir::RequestedFemDemagIR::Auto,
    );
    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "gpu", "precision": "double"}),
    );
    ir.energy_terms
        .push(fullmag_ir::EnergyTermIR::BulkDmi { d: 3.0e-3 });

    let reason = plan(&ir)
        .expect_err("mixed P1 GPU DMI must reject before CUDA startup")
        .reasons
        .join("\n");
    assert!(
        reason.contains("failed_predicates=[gpu_dmi_kernel_not_mixed_p1]"),
        "{reason}"
    );
    assert!(reason.contains("gpu_dmi_kernel_not_mixed_p1"), "{reason}");
    assert!(reason.contains("fallback=none"), "{reason}");
}

#[test]
fn fem_planner_preserves_legacy_v2_when_rebinding_packed_certificate() {
    let mut ir = mixed_cpu_relaxation_ir(
        fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
        fullmag_ir::RequestedFemDemagIR::PoissonRobin,
    );
    ir.geometry_assets.as_mut().unwrap().fem_domain_mesh_asset =
        Some(valid_mixed_certificate_asset_for_version("v2"));

    let planned = plan(&ir).expect("legacy v2 mixed certificate must remain plannable");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("mixed relaxation must resolve to FEM")
    };
    let certificate = fem
        .mesh_build_report
        .as_ref()
        .and_then(|report| report.mixed_layer_topology_certificate.as_ref())
        .expect("packed plan must retain a certificate");
    assert_eq!(certificate.topology_fingerprint_version, "v2");
    assert_eq!(
        certificate.topology_fingerprint,
        fem.mesh.topology_fingerprint_v6()
    );
}

#[test]
fn fem_planner_uses_managed_cpu_and_gpu_overrides_without_erasing_authored_device_request() {
    for (device, expected) in [
        ("cpu", fullmag_ir::ExecutionDevice::Cpu),
        ("gpu", fullmag_ir::ExecutionDevice::Gpu),
    ] {
        let mut ir = mixed_cpu_relaxation_ir(
            fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
            fullmag_ir::RequestedFemDemagIR::PoissonRobin,
        );
        ir.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            serde_json::json!({"device": "auto", "precision": "double"}),
        );
        ir.problem_meta.runtime_metadata.insert(
            "runtime_device_override".to_string(),
            serde_json::json!({"device": device, "source": "managed_launcher"}),
        );

        let planned = plan(&ir).expect("managed override must feed the effective plan request");
        let BackendPlanIR::Fem(fem) = planned.backend_plan else {
            panic!("mixed relaxation must resolve to FEM")
        };
        let provenance = fem
            .mesh_build_report
            .as_ref()
            .and_then(|report| report.mixed_topology_provenance.as_ref())
            .expect("mixed plan must bind effective execution provenance");
        assert_eq!(
            ir.problem_meta.runtime_metadata["runtime_selection"]["device"], "auto",
            "planning must not rewrite authored script intent",
        );
        assert_eq!(
            ir.problem_meta.runtime_metadata["runtime_device_override"]["source"],
            "managed_launcher",
        );
        assert_eq!(
            provenance.requested_device, expected,
            "plan provenance must bind the effective launcher request for {device}",
        );
    }
}

#[test]
fn fem_planner_rejects_valid_mixed_certificate_when_build_report_is_degraded() {
    for case in ["report_fallback", "degraded"] {
        let mut ir = mixed_cpu_relaxation_ir(
            fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
            fullmag_ir::RequestedFemDemagIR::PoissonRobin,
        );
        {
            let report = ir
                .geometry_assets
                .as_mut()
                .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
                .and_then(|asset| asset.build_report.as_mut())
                .expect("mixed fixture must carry a build report");
            match case {
                "report_fallback" => {
                    report.fallbacks_triggered =
                        Some(vec!["mesh_size_field_simplified".to_string()]);
                }
                "degraded" => report.degraded = true,
                _ => unreachable!(),
            }
        }
        let report = ir
            .geometry_assets
            .as_ref()
            .and_then(|assets| assets.fem_domain_mesh_asset.as_ref())
            .and_then(|asset| asset.build_report.as_ref())
            .expect("mixed fixture must carry a build report");
        let certificate = report
            .mixed_layer_topology_certificate
            .as_ref()
            .expect("mixed fixture must retain a valid certificate");
        let mesh = ir
            .geometry_assets
            .as_ref()
            .and_then(|assets| assets.fem_domain_mesh_asset.as_ref())
            .and_then(|asset| asset.mesh.as_ref())
            .expect("mixed fixture must retain its source mesh");
        fullmag_ir::validate_mixed_layer_topology_certificate_against_mesh(mesh, certificate)
            .expect("the regression must isolate enclosing build-report state");

        let error = plan(&ir).expect_err("strict mixed planning must reject a degraded report");
        assert!(
            error
                .reasons
                .iter()
                .any(|reason| reason.contains("fem_mixed_p1_build_report_rejected")),
            "case={case}: {:?}",
            error.reasons
        );
    }
}

#[test]
fn fem_planner_rejects_every_mixed_p1_execution_tuple_outside_bounded_strict_sp4_scope() {
    for case in [
        "backend_auto",
        "device_auto",
        "single",
        "extended",
        "time_evolution",
        "missing_exchange",
        "ms_field",
        "fem_bem",
        "high_order",
        "non_box",
        "pbc",
    ] {
        let mut ir = mixed_cpu_relaxation_ir(
            fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
            fullmag_ir::RequestedFemDemagIR::PoissonRobin,
        );
        match case {
            "backend_auto" => ir.backend_policy.requested_backend = BackendTarget::Auto,
            "device_auto" => {
                ir.problem_meta.runtime_metadata.insert(
                    "runtime_selection".to_string(),
                    serde_json::json!({"device": "auto"}),
                );
            }
            "single" => {
                ir.backend_policy.execution_precision = fullmag_ir::ExecutionPrecision::Single;
            }
            "extended" => {
                ir.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Extended;
            }
            "time_evolution" => {
                ir.study = ProblemIR::bootstrap_example().study;
            }
            "missing_exchange" => {
                ir.energy_terms
                    .retain(|term| !matches!(term, fullmag_ir::EnergyTermIR::Exchange));
            }
            "ms_field" => ir.materials[0].ms_field = Some(vec![8.0e5; 8]),
            "fem_bem" => {
                ir.energy_terms = vec![
                    fullmag_ir::EnergyTermIR::Exchange,
                    fullmag_ir::EnergyTermIR::Demag {
                        realization: fullmag_ir::RequestedFemDemagIR::FredkinKoehler,
                    },
                ];
            }
            "high_order" => {
                ir.backend_policy
                    .discretization_hints
                    .as_mut()
                    .and_then(|hints| hints.fem.as_mut())
                    .expect("mixed fixture has FEM hints")
                    .order = 2;
            }
            "non_box" => {
                ir.geometry.entries = vec![fullmag_ir::GeometryEntryIR::Cylinder {
                    name: "strip".to_string(),
                    radius: 10e-9,
                    height: 6e-9,
                    axis: [0.0, 0.0, 1.0],
                }];
            }
            "pbc" => {
                ir.pbc = Some(fullmag_ir::FdmPeriodicityIR {
                    axes: [
                        fullmag_ir::AxisBoundary::Periodic,
                        fullmag_ir::AxisBoundary::Open,
                        fullmag_ir::AxisBoundary::Open,
                    ],
                    demag: fullmag_ir::FdmDemagPeriodicityIR::PeriodicAirboxK0,
                    image_counts: None,
                });
            }
            _ => unreachable!(),
        }

        let reason = plan(&ir)
            .expect_err("unsupported mixed P1 tuple must fail closed")
            .reasons
            .join("\n");
        assert!(
            reason.contains("fem_mixed_p1_scope_rejected"),
            "case={case}: {reason}"
        );
        assert!(reason.contains("fallback=none"), "case={case}: {reason}");
    }
}

#[test]
fn fem_planner_reports_every_failed_mixed_p1_scope_predicate() {
    let mut ir = mixed_cpu_relaxation_ir(
        fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
        fullmag_ir::RequestedFemDemagIR::PoissonRobin,
    );
    ir.energy_terms
        .retain(|term| !matches!(term, fullmag_ir::EnergyTermIR::Exchange));
    ir.materials[0].ms_field = Some(vec![8.0e5; 8]);

    let reason = plan(&ir)
        .expect_err("mixed P1 must report every failed scope predicate")
        .reasons
        .join("\n");

    assert!(reason.contains("fem_mixed_p1_scope_rejected"), "{reason}");
    assert!(reason.contains("missing_exchange"), "{reason}");
    assert!(
        reason.contains("auto_or_poisson_open_boundary_order_one"),
        "{reason}"
    );
    assert!(
        reason.contains("unsupported_material_field_or_dmi"),
        "{reason}"
    );
}

#[test]
fn fem_planner_rejects_uncertified_mixed_topology_before_backend_startup() {
    let mut ir = fem_minimal_test_ir();
    let mut asset = valid_mixed_certificate_asset();
    asset
        .build_report
        .as_mut()
        .expect("fixture build report")
        .mixed_layer_topology_certificate = None;
    ir.geometry_assets.as_mut().unwrap().fem_domain_mesh_asset = Some(asset);
    ir.validate()
        .expect("typed mixed topology without a certificate is valid IR intent");

    let error = plan(&ir).expect_err("uncertified mixed topology must fail closed in planning");
    let reason = error.reasons.join("\n");
    assert!(
        reason.contains("fem_mixed_p1_certificate_required"),
        "{reason}"
    );
    assert!(reason.contains("prism6"), "{reason}");
    assert!(reason.contains("pyramid5"), "{reason}");
    assert!(reason.contains("fallback=none"), "{reason}");
}

#[test]
fn fem_planner_rejects_uncertified_mixed_per_object_asset_before_backend_startup() {
    let mut ir = fem_minimal_test_ir();
    let mesh = valid_mixed_certificate_asset()
        .mesh
        .expect("fixture carries inline mixed mesh");
    let assets = ir.geometry_assets.as_mut().expect("geometry assets");
    assets.fem_domain_mesh_asset = None;
    assets.fem_mesh_assets = vec![fullmag_ir::FemMeshAssetIR {
        geometry_name: "strip".to_string(),
        mesh_source: None,
        mesh: Some(mesh),
    }];
    ir.validate()
        .expect("typed per-object mixed topology is valid IR intent");

    let reason = plan(&ir)
        .expect_err("per-object mixed topology must not bypass the shared-domain guard")
        .reasons
        .join("\n");
    assert!(
        reason.contains("fem_mixed_p1_certificate_required"),
        "{reason}"
    );
    assert!(reason.contains("prism6"), "{reason}");
    assert!(reason.contains("pyramid5"), "{reason}");
}

#[test]
fn fem_planner_rejects_auto_mixed_p1_requested_device_without_fallback() {
    for device in ["auto"] {
        let mut ir = mixed_cpu_relaxation_ir(
            fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
            fullmag_ir::RequestedFemDemagIR::PoissonRobin,
        );
        ir.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            serde_json::json!({"device": device}),
        );

        let reason = plan(&ir)
            .expect_err("automatic mixed P1 execution must fail closed")
            .reasons
            .join("\n");
        assert!(
            reason.contains("fem_mixed_p1_scope_rejected"),
            "device={device}: {reason}"
        );
        assert!(
            reason.contains(&format!("requested_device={device}")),
            "device={device}: {reason}"
        );
        assert!(reason.contains("fallback=none"), "{reason}");
    }
}

#[test]
fn auto_backend_rejects_mixed_fem_topology_for_all_modes_and_devices() {
    let fdm_hint = ProblemIR::bootstrap_example()
        .backend_policy
        .discretization_hints
        .and_then(|hints| hints.fdm)
        .expect("bootstrap fixture carries an FDM hint");

    for mode in [
        fullmag_ir::ExecutionMode::Strict,
        fullmag_ir::ExecutionMode::Extended,
    ] {
        for device in ["cpu", "gpu", "auto"] {
            let mut ir = mixed_cpu_relaxation_ir(
                fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
                fullmag_ir::RequestedFemDemagIR::PoissonRobin,
            );
            ir.backend_policy.requested_backend = BackendTarget::Auto;
            ir.backend_policy
                .discretization_hints
                .as_mut()
                .expect("FEM fixture carries discretization hints")
                .fdm = Some(fdm_hint.clone());
            ir.validation_profile.execution_mode = mode;
            ir.problem_meta.runtime_metadata.insert(
                "runtime_selection".to_string(),
                serde_json::json!({"device": device}),
            );
            let reason = plan(&ir)
                .expect_err("backend=auto must not route mixed FEM topology into FDM")
                .reasons
                .join("\n");
            assert!(
                reason.contains("fem_mixed_p1_scope_rejected"),
                "mode={mode:?}, device={device}: {reason}"
            );
            assert!(
                reason.contains(&format!("requested_device={device}")),
                "mode={mode:?}, device={device}: {reason}"
            );
            assert!(reason.contains("fallback=none"), "{reason}");
        }
    }
}

#[test]
fn fem_planner_does_not_mislabel_hex8_as_qualified_mixed_p1() {
    let mut mesh = fem_minimal_test_ir()
        .geometry_assets
        .and_then(|assets| assets.fem_domain_mesh_asset)
        .and_then(|asset| asset.mesh)
        .expect("baseline FEM mesh");
    mesh.cells.types = vec![fullmag_ir::FemCellTypeIR::Hex8];
    mesh.facets.types = vec![fullmag_ir::FemFacetTypeIR::Quad4];

    let reason =
        crate::mesh::reject_unsupported_mixed_topology(&fem_minimal_test_ir(), &mesh, None)
            .expect_err("hex8 must remain fail-closed without mixed-P1 diagnostics");
    assert!(reason.contains("fem_typed_topology_unsupported_before_backend"));
    assert!(!reason.contains("mesh.transition.pyramid_tet"));
}

#[test]
fn legacy_tetrahedral_plan_remains_compatible_without_mixed_topology_provenance() {
    let plan = plan(&fem_minimal_test_ir()).expect("tetrahedral FEM baseline must plan");
    let encoded = serde_json::to_value(&plan).expect("plan serializes");
    let decoded: ExecutionPlanIR =
        serde_json::from_value(encoded).expect("legacy-compatible plan deserializes");
    let BackendPlanIR::Fem(fem) = decoded.backend_plan else {
        panic!("expected FEM plan");
    };
    assert!(fem.mesh_build_report.is_none());
}

#[test]
fn fem_planner_elementwise_material_legality_distinguishes_a_from_ms() {
    let planned = plan(&fem_minimal_test_ir()).expect("baseline FEM plan must be legal");
    let BackendPlanIR::Fem(base) = planned.backend_plan else {
        panic!("expected FEM plan");
    };

    struct Case {
        name: &'static str,
        include_ms: bool,
        include_a: bool,
        gpu: bool,
        configure: fn(&mut FemPlanIR),
        expected: Option<(&'static str, &'static str, &'static str)>,
    }

    let cases = [
        Case {
            name: "CPU Ms Zeeman",
            include_ms: true,
            include_a: false,
            gpu: false,
            configure: |fem| fem.external_field = Some([1.0, 0.0, 0.0]),
            expected: None,
        },
        Case {
            name: "CPU Ms demag",
            include_ms: true,
            include_a: false,
            gpu: false,
            configure: |fem| fem.enable_demag = true,
            expected: None,
        },
        Case {
            name: "CPU Ms missing consistent mass",
            include_ms: true,
            include_a: false,
            gpu: false,
            configure: |fem| fem.use_consistent_mass = None,
            expected: Some(("Ms_element_field", "lumped-mass exchange projection", "cpu")),
        },
        Case {
            name: "CPU Ms Zeeman-only",
            include_ms: true,
            include_a: false,
            gpu: false,
            configure: |fem| {
                fem.enable_exchange = false;
                fem.external_field = Some([1.0, 0.0, 0.0]);
            },
            expected: Some(("Ms_element_field", "exchange-disabled plan", "cpu")),
        },
        Case {
            name: "CPU Ms demag-only",
            include_ms: true,
            include_a: false,
            gpu: false,
            configure: |fem| {
                fem.enable_exchange = false;
                fem.enable_demag = true;
            },
            expected: Some(("Ms_element_field", "exchange-disabled plan", "cpu")),
        },
        Case {
            name: "CPU Ms uniaxial anisotropy",
            include_ms: true,
            include_a: false,
            gpu: false,
            configure: |fem| fem.material.uniaxial_anisotropy = Some(1.0e5),
            expected: Some(("Ms_element_field", "uniaxial anisotropy", "cpu")),
        },
        Case {
            name: "CPU Ms cubic anisotropy",
            include_ms: true,
            include_a: false,
            gpu: false,
            configure: |fem| fem.material.cubic_anisotropy_kc1 = Some(1.0e5),
            expected: Some(("Ms_element_field", "cubic anisotropy", "cpu")),
        },
        Case {
            name: "CPU Ms interfacial DMI",
            include_ms: true,
            include_a: false,
            gpu: false,
            configure: |fem| fem.interfacial_dmi = Some(1.0e-3),
            expected: Some(("Ms_element_field", "interfacial DMI", "cpu")),
        },
        Case {
            name: "CPU Ms bulk DMI",
            include_ms: true,
            include_a: false,
            gpu: false,
            configure: |fem| fem.bulk_dmi = Some(1.0e-3),
            expected: Some(("Ms_element_field", "bulk DMI", "cpu")),
        },
        Case {
            name: "CPU Ms thermal Brown",
            include_ms: true,
            include_a: false,
            gpu: false,
            configure: |fem| fem.temperature = Some(300.0),
            expected: Some(("Ms_element_field", "thermal Brown interaction", "cpu")),
        },
        Case {
            name: "CPU Ms Zhang-Li STT",
            include_ms: true,
            include_a: false,
            gpu: false,
            configure: |fem| {
                fem.current_density = Some([1.0e11, 0.0, 0.0]);
                fem.stt_degree = Some(0.5);
            },
            expected: Some(("Ms_element_field", "Zhang-Li STT", "cpu")),
        },
        Case {
            name: "CPU Ms Slonczewski STT",
            include_ms: true,
            include_a: false,
            gpu: false,
            configure: |fem| {
                fem.current_density = Some([1.0e11, 0.0, 0.0]);
                fem.stt_degree = Some(0.5);
                fem.stt_spin_polarization = Some([0.0, 0.0, 1.0]);
                fem.stt_lambda = Some(1.0);
            },
            expected: Some(("Ms_element_field", "Slonczewski STT", "cpu")),
        },
        Case {
            name: "CPU Ms Oersted",
            include_ms: true,
            include_a: false,
            gpu: false,
            configure: |fem| fem.has_oersted_cylinder = true,
            expected: Some(("Ms_element_field", "Oersted interaction", "cpu")),
        },
        Case {
            name: "CPU Ms magnetoelastic",
            include_ms: true,
            include_a: false,
            gpu: false,
            configure: |fem| {
                fem.magnetoelastic = Some(fullmag_ir::FemMagnetoelasticPlanIR {
                    b1: 1.0e6,
                    b2: 0.0,
                    prescribed_strain: Some([0.0; 6]),
                });
            },
            expected: Some(("Ms_element_field", "magnetoelastic interaction", "cpu")),
        },
        Case {
            name: "CPU Ms lifecycle fallback",
            include_ms: true,
            include_a: false,
            gpu: false,
            configure: |fem| fem.enable_exchange = false,
            expected: Some(("Ms_element_field", "exchange-disabled plan", "cpu")),
        },
        Case {
            name: "GPU Ms upload precedes active owners",
            include_ms: true,
            include_a: false,
            gpu: true,
            configure: |fem| {
                fem.external_field = Some([1.0, 0.0, 0.0]);
                fem.enable_demag = true;
            },
            expected: Some(("Ms_element_field", "GPU material-state upload", "gpu")),
        },
        Case {
            name: "CPU A Zeeman",
            include_ms: false,
            include_a: true,
            gpu: false,
            configure: |fem| fem.external_field = Some([1.0, 0.0, 0.0]),
            expected: None,
        },
        Case {
            name: "CPU A exchange-disabled",
            include_ms: false,
            include_a: true,
            gpu: false,
            configure: |fem| fem.enable_exchange = false,
            expected: Some(("A_element_field", "exchange-disabled plan", "cpu")),
        },
        Case {
            name: "GPU A",
            include_ms: false,
            include_a: true,
            gpu: true,
            configure: |_| {},
            expected: Some(("A_element_field", "GPU material-state upload", "gpu")),
        },
        Case {
            name: "CPU Ms reusable handle",
            include_ms: true,
            include_a: false,
            gpu: false,
            configure: |_| {},
            expected: None,
        },
        Case {
            name: "CPU Ms relaxation metric",
            include_ms: true,
            include_a: false,
            gpu: false,
            configure: |fem| {
                fem.relaxation = Some(fullmag_ir::RelaxationControlIR {
                    algorithm: fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
                    stop: fullmag_ir::RelaxStopIR {
                        torque_tolerance_apm: Some(1e-3),
                        energy_tolerance_j: None,
                        max_steps: Some(1),
                        max_relaxation_time_s: None,
                    },
                })
            },
            expected: Some((
                "Ms_element_field",
                "native FEM relaxation algorithms",
                "cpu",
            )),
        },
    ];

    for case in cases {
        let mut fem = base.clone();
        fem.ms_element_field = case.include_ms.then_some(vec![0.8e6]);
        fem.a_element_field = case.include_a.then_some(vec![13e-12]);
        fem.use_consistent_mass = case.include_ms.then_some(true);
        (case.configure)(&mut fem);

        match (
            case.expected,
            crate::fem::elementwise_material_legality_error(&fem, case.gpu),
        ) {
            (None, None) => {}
            (Some((field, term, device)), Some(error)) => {
                assert!(
                    error.contains(field)
                        && error.contains(term)
                        && error.contains(&format!("resolved device '{device}'")),
                    "{} returned unexpected planner error: {error}",
                    case.name
                );
                if field == "Ms_element_field" {
                    assert_eq!(
                        error,
                        format!(
                            "Ms_element_field is unsupported for {term} on resolved device '{device}': this owner does not consume the common element/quadrature material accessor"
                        ),
                        "{} must preserve the native elementwise-Ms diagnostic convention",
                        case.name
                    );
                }
            }
            (expected, actual) => panic!(
                "{} expected planner legality {:?}, got {:?}",
                case.name, expected, actual
            ),
        }
    }
}

#[test]
fn fdm_linear_ms_field_plans_cell_sampling() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.material_parameter_fields
        .push(fullmag_ir::MaterialParameterAssignmentIR {
            assignment_id: "linear_ms".to_string(),
            owner_object: "strip".to_string(),
            region_id: None,
            parameter: fullmag_ir::MaterialParameterNameIR::Ms,
            value: fullmag_ir::MaterialParameterFieldIR::Linear {
                base: 800e3,
                gradient: [1e9, 0.0, 0.0],
                frame: fullmag_ir::RegionFrameIR::Object,
                unit: Some("A/m".to_string()),
            },
            priority: 10,
            conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
        });

    let planned = plan(&ir).expect("FDM planning with linear Ms should succeed");

    assert!(planned.common.material_field_plans.iter().any(|p| {
        p.parameter == fullmag_ir::MaterialParameterNameIR::Ms
            && p.source_kind == fullmag_ir::MaterialFieldSourceKind::Gradient
            && p.realization_location == fullmag_ir::MaterialFieldLocationIR::Cell
            && p.requires_sampling
    }));

    let BackendPlanIR::Fdm(fdm_plan) = &planned.backend_plan else {
        panic!("expected FDM plan");
    };
    let ms_field = fdm_plan
        .material
        .ms_field
        .as_ref()
        .expect("expected ms_field to be populated");
    assert_eq!(ms_field.len(), 3000); // 100 * 10 * 3
    assert!(ms_field[0] != ms_field[2999]);
}

#[test]
fn fem_linear_ms_field_plans_coefficient_sampling() {
    let mut ir = fem_minimal_test_ir();
    ir.material_parameter_fields
        .push(fullmag_ir::MaterialParameterAssignmentIR {
            assignment_id: "linear_ms".to_string(),
            owner_object: "strip".to_string(),
            region_id: None,
            parameter: fullmag_ir::MaterialParameterNameIR::Ms,
            value: fullmag_ir::MaterialParameterFieldIR::Linear {
                base: 800e3,
                gradient: [1e9, 0.0, 0.0],
                frame: fullmag_ir::RegionFrameIR::Object,
                unit: Some("A/m".to_string()),
            },
            priority: 10,
            conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
        });

    let planned = plan(&ir).expect("FEM planning with linear Ms should succeed");

    assert!(planned.common.material_field_plans.iter().any(|p| {
        p.parameter == fullmag_ir::MaterialParameterNameIR::Ms
            && p.source_kind == fullmag_ir::MaterialFieldSourceKind::Gradient
            && p.realization_location == fullmag_ir::MaterialFieldLocationIR::Node
            && p.requires_sampling
    }));

    let BackendPlanIR::Fem(fem_plan) = &planned.backend_plan else {
        panic!("expected FEM plan");
    };
    let ms_field = fem_plan
        .material
        .ms_field
        .as_ref()
        .expect("expected ms_field to be populated");
    assert_eq!(ms_field.len(), 4); // 4 nodes
    assert_eq!(ms_field[0], 800e3);
    assert_eq!(ms_field[1], 800e3 + 1e9);
}

#[test]
fn fem_cpu_exchange_preserves_nodal_ms_and_conformal_element_a_payloads() {
    let mut ir = fem_minimal_test_ir();
    ir.materials[0].exchange_stiffness = 8e-12;
    ir.material_parameter_fields
        .push(fullmag_ir::MaterialParameterAssignmentIR {
            assignment_id: "linear_ms".to_string(),
            owner_object: "strip".to_string(),
            region_id: None,
            parameter: fullmag_ir::MaterialParameterNameIR::Ms,
            value: fullmag_ir::MaterialParameterFieldIR::Linear {
                base: 800e3,
                gradient: [1e9, 0.0, 0.0],
                frame: fullmag_ir::RegionFrameIR::Object,
                unit: Some("A/m".to_string()),
            },
            priority: 10,
            conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
        });
    ir.object_regions.push(fullmag_ir::ObjectRegionIR {
        region_id: "strip:conformal_aex".to_string(),
        owner_object: "strip".to_string(),
        name: "conformal_aex".to_string(),
        shape: fullmag_ir::RegionShapeIR::Box {
            size: [0.2, 0.2, 0.2],
            center: [0.0, 0.0, 0.0],
        },
        frame: fullmag_ir::RegionFrameIR::Object,
        enabled: true,
        priority: 20,
        mesh_policy: None,
        material_overrides: vec![fullmag_ir::RegionMaterialOverrideIR {
            parameter: fullmag_ir::MaterialParameterNameIR::Aex,
            value: fullmag_ir::MaterialParameterFieldIR::Constant {
                value: serde_json::json!(13e-12),
                unit: Some("J/m".to_string()),
            },
            priority: 20,
            conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
        }],
        texture_override: None,
        material_transition: Some(fullmag_ir::MaterialTransitionSpecIR::Sharp),
        realization_policy: fullmag_ir::RegionRealizationPolicyIR::Conformal,
    });
    if let Some(assets) = ir.geometry_assets.as_mut() {
        if let Some(domain_asset) = assets.fem_domain_mesh_asset.as_mut() {
            if let Some(mesh) = domain_asset.mesh.as_mut() {
                mesh.nodes.push([0.0, 0.0, -1.0]);
                mesh.set_tet4_cells(vec![[0, 2, 1, 4], [0, 1, 2, 3]]);
                mesh.element_markers = vec![1, 2];
                mesh.set_tri3_facets(vec![[0, 1, 3], [0, 2, 4]]);
                mesh.boundary_markers = vec![1, 2];
            }
            domain_asset
                .object_region_markers
                .push(fullmag_ir::FemDomainRegionMarkerIR {
                    geometry_name: "strip:conformal_aex".to_string(),
                    marker: 2,
                });
        }
    }

    let planned = plan(&ir)
        .expect("CPU exchange must accept distinct nodal Ms and conformal element A realizations");
    let BackendPlanIR::Fem(fem_plan) = planned.backend_plan else {
        panic!("expected FEM plan");
    };
    assert_eq!(
        fem_plan.material.ms_field.as_deref(),
        Some(&[800e3, 800e3 + 1e9, 800e3, 800e3, 800e3][..]),
        "the nodal P1 Ms payload must survive planning"
    );
    assert_eq!(
        fem_plan.a_element_field.as_deref(),
        Some(&[8e-12, 13e-12][..]),
        "the conformal DG0 A payload must survive planning"
    );
}

#[test]
fn fem_cpu_exchange_and_zeeman_plan_preserves_conformal_dg0_ms() {
    let mut ir = fem_minimal_test_ir();
    ir.materials[0].saturation_magnetisation = 0.7e6;
    ir.energy_terms = vec![
        fullmag_ir::EnergyTermIR::Exchange,
        fullmag_ir::EnergyTermIR::Zeeman {
            b: [0.02, 0.0, 0.0],
        },
    ];
    ir.object_regions.push(fullmag_ir::ObjectRegionIR {
        region_id: "strip:conformal_ms".to_string(),
        owner_object: "strip".to_string(),
        name: "conformal_ms".to_string(),
        shape: fullmag_ir::RegionShapeIR::Box {
            size: [0.2, 0.2, 0.2],
            center: [0.0, 0.0, 0.0],
        },
        frame: fullmag_ir::RegionFrameIR::Object,
        enabled: true,
        priority: 20,
        mesh_policy: None,
        material_overrides: vec![fullmag_ir::RegionMaterialOverrideIR {
            parameter: fullmag_ir::MaterialParameterNameIR::Ms,
            value: fullmag_ir::MaterialParameterFieldIR::Constant {
                value: serde_json::json!(1.1e6),
                unit: Some("A/m".to_string()),
            },
            priority: 20,
            conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
        }],
        texture_override: None,
        material_transition: Some(fullmag_ir::MaterialTransitionSpecIR::Sharp),
        realization_policy: fullmag_ir::RegionRealizationPolicyIR::Conformal,
    });
    let domain_asset = ir
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .expect("inline FEM domain asset");
    let mesh = domain_asset.mesh.as_mut().expect("inline FEM mesh");
    mesh.nodes.push([0.0, 0.0, -1.0]);
    mesh.set_tet4_cells(vec![[0, 2, 1, 4], [0, 1, 2, 3]]);
    mesh.element_markers = vec![1, 2];
    mesh.set_tri3_facets(vec![[0, 1, 3], [0, 2, 4]]);
    mesh.boundary_markers = vec![1, 2];
    domain_asset
        .object_region_markers
        .push(fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "strip:conformal_ms".to_string(),
            marker: 2,
        });
    ir.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Strict;

    let planned = plan(&ir).expect(
        "canonical CPU planner must admit conformal DG0 Ms for the qualified exchange+Zeeman owner set",
    );
    let BackendPlanIR::Fem(fem_plan) = planned.backend_plan else {
        panic!("expected FEM plan");
    };
    assert!(fem_plan.material.ms_field.is_none());
    assert_eq!(
        fem_plan.ms_element_field.as_deref(),
        Some(&[0.7e6, 1.1e6][..])
    );
    assert!(fem_plan.enable_exchange);
    assert_eq!(
        fem_plan.use_consistent_mass,
        Some(true),
        "canonical conformal DG0 Ms planning must select consistent-mass exchange"
    );
    assert_eq!(
        fem_plan.external_field,
        Some([0.02 / crate::util::MU0, 0.0, 0.0])
    );
}

#[test]
fn fem_object_frame_material_field_uses_owner_translation() {
    let mut ir = fem_minimal_test_ir();
    ir.geometry.entries = vec![fullmag_ir::GeometryEntryIR::Translate {
        name: "strip_geom".to_string(),
        base: Box::new(fullmag_ir::GeometryEntryIR::Box {
            name: "strip_base".to_string(),
            size: [1.0, 1.0, 1.0],
        }),
        by: [10.0, 0.0, 0.0],
    }];
    ir.regions = vec![fullmag_ir::RegionIR {
        name: "strip_region".to_string(),
        geometry: "strip_geom".to_string(),
    }];
    ir.magnets[0].region = "strip_region".to_string();
    if let Some(assets) = ir.geometry_assets.as_mut() {
        let domain_asset = assets
            .fem_domain_mesh_asset
            .as_mut()
            .expect("expected shared FEM domain asset");
        domain_asset.region_markers[0].geometry_name = "strip_geom".to_string();
        let mesh = domain_asset.mesh.as_mut().expect("expected inline mesh");
        mesh.nodes = vec![
            [10.0, 0.0, 0.0],
            [11.0, 0.0, 0.0],
            [10.0, 1.0, 0.0],
            [10.0, 0.0, 1.0],
        ];
    }
    ir.material_parameter_fields
        .push(fullmag_ir::MaterialParameterAssignmentIR {
            assignment_id: "translated_linear_ms".to_string(),
            owner_object: "strip".to_string(),
            region_id: None,
            parameter: fullmag_ir::MaterialParameterNameIR::Ms,
            value: fullmag_ir::MaterialParameterFieldIR::Linear {
                base: 800e3,
                gradient: [1e9, 0.0, 0.0],
                frame: fullmag_ir::RegionFrameIR::Object,
                unit: Some("A/m".to_string()),
            },
            priority: 10,
            conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
        });

    let planned = plan(&ir).expect("translated object-frame field should plan");
    let BackendPlanIR::Fem(fem_plan) = &planned.backend_plan else {
        panic!("expected FEM plan");
    };
    let ms_field = fem_plan
        .material
        .ms_field
        .as_ref()
        .expect("expected translated Ms field");
    assert_eq!(ms_field[0], 800e3);
    assert_eq!(ms_field[1], 800e3 + 1e9);
}

#[test]
fn fem_sampled_ms_must_remain_positive_on_every_node() {
    let mut ir = fem_minimal_test_ir();
    ir.material_parameter_fields
        .push(fullmag_ir::MaterialParameterAssignmentIR {
            assignment_id: "invalid_linear_ms".to_string(),
            owner_object: "strip".to_string(),
            region_id: None,
            parameter: fullmag_ir::MaterialParameterNameIR::Ms,
            value: fullmag_ir::MaterialParameterFieldIR::Linear {
                base: 1.0,
                gradient: [-2.0, 0.0, 0.0],
                frame: fullmag_ir::RegionFrameIR::Object,
                unit: Some("A/m".to_string()),
            },
            priority: 10,
            conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
        });

    let err = plan(&ir).expect_err("sampled Ms <= 0 must block FEM planning");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("resolved region-owned material parameter Ms")
                && reason.contains("invalid value")
        }),
        "unexpected planner errors: {:?}",
        err.reasons
    );
}

#[test]
fn fem_sharp_assignment_requires_conformal_in_strict() {
    let mut ir = fem_minimal_test_ir();
    ir.object_regions.push(fullmag_ir::ObjectRegionIR {
        region_id: "strip:assigned_defect".to_string(),
        owner_object: "strip".to_string(),
        name: "assigned_defect".to_string(),
        shape: fullmag_ir::RegionShapeIR::Box {
            size: [0.2, 0.2, 0.2],
            center: [0.5, 0.5, 0.5],
        },
        frame: fullmag_ir::RegionFrameIR::Object,
        enabled: true,
        priority: 20,
        mesh_policy: None,
        material_overrides: Vec::new(),
        texture_override: None,
        material_transition: Some(fullmag_ir::MaterialTransitionSpecIR::Sharp),
        realization_policy: fullmag_ir::RegionRealizationPolicyIR::Inherit,
    });
    ir.material_parameter_fields
        .push(fullmag_ir::MaterialParameterAssignmentIR {
            assignment_id: "assigned_aex".to_string(),
            owner_object: "strip".to_string(),
            region_id: Some("strip:assigned_defect".to_string()),
            parameter: fullmag_ir::MaterialParameterNameIR::Aex,
            value: fullmag_ir::MaterialParameterFieldIR::Constant {
                value: serde_json::json!(5e-12),
                unit: Some("J/m".to_string()),
            },
            priority: 20,
            conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
        });
    ir.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Strict;

    let err = plan(&ir)
        .expect_err("sharp region-scoped assignment must require conformal FEM realization");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("sharp parameter override for Aex/Ms")
                && reason.contains("strip:assigned_defect")
        }),
        "unexpected planner errors: {:?}",
        err.reasons
    );
}

#[test]
fn fem_default_region_ms_transition_does_not_require_conformal_boundary() {
    let mut ir = fem_minimal_test_ir();
    ir.object_regions.push(fullmag_ir::ObjectRegionIR {
        region_id: "strip:smooth_defect".to_string(),
        owner_object: "strip".to_string(),
        name: "smooth_defect".to_string(),
        shape: fullmag_ir::RegionShapeIR::Box {
            size: [0.2, 0.2, 0.2],
            center: [0.5, 0.5, 0.5],
        },
        frame: fullmag_ir::RegionFrameIR::Object,
        enabled: true,
        priority: 20,
        mesh_policy: None,
        material_overrides: vec![fullmag_ir::RegionMaterialOverrideIR {
            parameter: fullmag_ir::MaterialParameterNameIR::Ms,
            value: fullmag_ir::MaterialParameterFieldIR::Constant {
                value: serde_json::json!(700e3),
                unit: Some("A/m".to_string()),
            },
            priority: 20,
            conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
        }],
        texture_override: None,
        material_transition: None,
        realization_policy: fullmag_ir::RegionRealizationPolicyIR::Inherit,
    });
    ir.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Strict;

    let planned =
        plan(&ir).expect("default smooth Ms transition must not require a conformal FEM boundary");
    let ms_plan = planned
        .common
        .material_field_plans
        .iter()
        .find(|plan| plan.parameter == fullmag_ir::MaterialParameterNameIR::Ms)
        .expect("smooth region Ms override must produce a material field plan");
    assert!(
        ms_plan.requires_sampling,
        "smooth region Ms override must be realized by sampling"
    );
    assert!(
        ms_plan.requires_mesh_revision,
        "mesh_relative smooth region Ms override must depend on the mesh revision"
    );
}

#[test]
fn fem_equal_priority_overlapping_ms_overrides_block_planning() {
    let mut ir = fem_minimal_test_ir();
    for (region_id, value) in [
        ("strip:defect_a", serde_json::json!(700e3)),
        ("strip:defect_b", serde_json::json!(750e3)),
    ] {
        ir.object_regions.push(fullmag_ir::ObjectRegionIR {
            region_id: region_id.to_string(),
            owner_object: "strip".to_string(),
            name: region_id.rsplit(':').next().unwrap().to_string(),
            shape: fullmag_ir::RegionShapeIR::Sphere {
                radius: 2.0,
                center: [0.0, 0.0, 0.0],
            },
            frame: fullmag_ir::RegionFrameIR::Object,
            enabled: true,
            priority: 20,
            mesh_policy: None,
            material_overrides: vec![fullmag_ir::RegionMaterialOverrideIR {
                parameter: fullmag_ir::MaterialParameterNameIR::Ms,
                value: fullmag_ir::MaterialParameterFieldIR::Constant {
                    value,
                    unit: Some("A/m".to_string()),
                },
                priority: 20,
                conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
            }],
            texture_override: None,
            material_transition: None,
            realization_policy: fullmag_ir::RegionRealizationPolicyIR::Inherit,
        });
    }

    let err = plan(&ir).expect_err("equal-priority overlapping Ms overrides must block planning");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("region-owned material parameter conflict")
                && reason.contains("overlapping regions assign different values for Ms")
                && reason.contains("priority 20")
        }),
        "unexpected planner errors: {:?}",
        err.reasons
    );
}

#[test]
fn fem_sharp_aex_region_requires_conformal_in_strict() {
    let mut ir = fem_minimal_test_ir();
    let region = fullmag_ir::ObjectRegionIR {
        region_id: "strip:defect".to_string(),
        owner_object: "strip".to_string(),
        name: "defect".to_string(),
        shape: fullmag_ir::RegionShapeIR::Sphere {
            radius: 0.1,
            center: [0.5, 0.5, 0.5],
        },
        frame: fullmag_ir::RegionFrameIR::Object,
        enabled: true,
        priority: 20,
        mesh_policy: None,
        material_overrides: vec![
            fullmag_ir::RegionMaterialOverrideIR {
                parameter: fullmag_ir::MaterialParameterNameIR::Aex,
                value: fullmag_ir::MaterialParameterFieldIR::Constant {
                    value: serde_json::json!(5e-12),
                    unit: Some("J/m".to_string()),
                },
                priority: 20,
                conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
            },
            fullmag_ir::RegionMaterialOverrideIR {
                parameter: fullmag_ir::MaterialParameterNameIR::Ms,
                value: fullmag_ir::MaterialParameterFieldIR::Constant {
                    value: serde_json::json!(700e3),
                    unit: Some("A/m".to_string()),
                },
                priority: 20,
                conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
            },
        ],
        texture_override: None,
        material_transition: Some(fullmag_ir::MaterialTransitionSpecIR::Sharp),
        realization_policy: fullmag_ir::RegionRealizationPolicyIR::Inherit,
    };
    ir.object_regions.push(region);
    ir.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Strict;

    let err =
        plan(&ir).expect_err("sharp Aex override in non-conformal region must fail in strict mode");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("sharp parameter override for Aex/Ms in region 'strip:defect' requires a conformal boundary (domain marker) in strict mode")
        }),
        "unexpected planner errors: {:?}",
        err.reasons
    );
}

#[test]
fn fem_sharp_conformal_ms_and_aex_use_exclusive_cpu_dg0_realizations() {
    let mut ir = fem_minimal_test_ir();
    ir.materials[0].saturation_magnetisation = 0.7e6;
    ir.materials[0].exchange_stiffness = 8e-12;
    let region = fullmag_ir::ObjectRegionIR {
        region_id: "strip:conformal_defect".to_string(),
        owner_object: "strip".to_string(),
        name: "conformal_defect".to_string(),
        shape: fullmag_ir::RegionShapeIR::Box {
            size: [0.2, 0.2, 0.2],
            center: [0.0, 0.0, 0.0],
        },
        frame: fullmag_ir::RegionFrameIR::Object,
        enabled: true,
        priority: 20,
        mesh_policy: None,
        material_overrides: vec![
            fullmag_ir::RegionMaterialOverrideIR {
                parameter: fullmag_ir::MaterialParameterNameIR::Aex,
                value: fullmag_ir::MaterialParameterFieldIR::Constant {
                    value: serde_json::json!(13e-12),
                    unit: Some("J/m".to_string()),
                },
                priority: 20,
                conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
            },
            fullmag_ir::RegionMaterialOverrideIR {
                parameter: fullmag_ir::MaterialParameterNameIR::Ms,
                value: fullmag_ir::MaterialParameterFieldIR::Constant {
                    value: serde_json::json!(1.1e6),
                    unit: Some("A/m".to_string()),
                },
                priority: 20,
                conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
            },
        ],
        texture_override: None,
        material_transition: Some(fullmag_ir::MaterialTransitionSpecIR::Sharp),
        realization_policy: fullmag_ir::RegionRealizationPolicyIR::Conformal,
    };
    ir.object_regions.push(region);
    if let Some(assets) = ir.geometry_assets.as_mut() {
        if let Some(domain_asset) = assets.fem_domain_mesh_asset.as_mut() {
            if let Some(mesh) = domain_asset.mesh.as_mut() {
                mesh.nodes = vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [0.0, 0.0, -1.0],
                ];
                // The two region markers meet at the shared face (0, 1, 2).
                mesh.set_tet4_cells(vec![[0, 2, 1, 4], [0, 1, 2, 3]]);
                mesh.element_markers = vec![1, 2];
                mesh.set_tri3_facets(vec![[0, 1, 3], [0, 2, 4]]);
                mesh.boundary_markers = vec![1, 2];
            }
            domain_asset
                .object_region_markers
                .push(fullmag_ir::FemDomainRegionMarkerIR {
                    geometry_name: "strip:conformal_defect".to_string(),
                    marker: 2,
                });
        }
    }
    ir.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Strict;

    let planned = plan(&ir).expect("conformal CPU Ms/Aex must remain exclusively DG0");
    let BackendPlanIR::Fem(fem) = planned.backend_plan else {
        panic!("expected FEM plan");
    };
    assert!(fem.material.ms_field.is_none());
    assert!(fem.material.a_field.is_none());
    assert_eq!(fem.ms_element_field.as_deref(), Some(&[0.7e6, 1.1e6][..]));
    assert_eq!(fem.a_element_field.as_deref(), Some(&[8e-12, 13e-12][..]));

    ir.problem_meta.runtime_metadata.insert(
        "runtime_selection".to_string(),
        serde_json::json!({"device": "gpu"}),
    );
    let err = plan(&ir).expect_err("GPU requests must still fail closed for DG0 material upload");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("Ms_element_field") && reason.contains("GPU material-state upload")
        }),
        "unexpected planner errors: {:?}",
        err.reasons
    );
}

#[test]
fn fem_planner_rejects_conflicting_nodal_and_element_coefficient_realizations() {
    for (parameter, nodal_location, element_location, value, unit) in [
        (
            fullmag_ir::MaterialParameterNameIR::Ms,
            "material.ms_field",
            "ms_element_field",
            serde_json::json!(1.1e6),
            "A/m",
        ),
        (
            fullmag_ir::MaterialParameterNameIR::Aex,
            "material.a_field",
            "a_element_field",
            serde_json::json!(8e-12),
            "J/m",
        ),
    ] {
        let mut ir = fem_minimal_test_ir();
        let parameter_name = match parameter {
            fullmag_ir::MaterialParameterNameIR::Ms => "Ms",
            fullmag_ir::MaterialParameterNameIR::Aex => "A",
            _ => unreachable!("this test only covers Ms and Aex"),
        };
        let (nodal_base, nodal_gradient) = match parameter {
            fullmag_ir::MaterialParameterNameIR::Ms => (800e3, 1e9),
            fullmag_ir::MaterialParameterNameIR::Aex => (13e-12, 1e-12),
            _ => unreachable!("this test only covers Ms and Aex"),
        };
        ir.material_parameter_fields
            .push(fullmag_ir::MaterialParameterAssignmentIR {
                assignment_id: format!("nodal_{parameter_name}"),
                owner_object: "strip".to_string(),
                region_id: None,
                parameter,
                value: fullmag_ir::MaterialParameterFieldIR::Linear {
                    base: nodal_base,
                    gradient: [nodal_gradient, 0.0, 0.0],
                    frame: fullmag_ir::RegionFrameIR::Object,
                    unit: Some(unit.to_string()),
                },
                priority: 10,
                conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
            });
        ir.object_regions.push(fullmag_ir::ObjectRegionIR {
            region_id: format!("strip:sharp_{parameter_name}"),
            owner_object: "strip".to_string(),
            name: format!("sharp_{parameter_name}"),
            shape: fullmag_ir::RegionShapeIR::Box {
                size: [0.2, 0.2, 0.2],
                center: [0.0, 0.0, 0.0],
            },
            frame: fullmag_ir::RegionFrameIR::Object,
            enabled: true,
            priority: 20,
            mesh_policy: None,
            material_overrides: vec![fullmag_ir::RegionMaterialOverrideIR {
                parameter,
                value: fullmag_ir::MaterialParameterFieldIR::Constant {
                    value,
                    unit: Some(unit.to_string()),
                },
                priority: 20,
                conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
            }],
            texture_override: None,
            material_transition: Some(fullmag_ir::MaterialTransitionSpecIR::Sharp),
            realization_policy: fullmag_ir::RegionRealizationPolicyIR::Conformal,
        });
        let domain_asset = ir
            .geometry_assets
            .as_mut()
            .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
            .expect("conflicting-realization test needs an inline domain mesh");
        let mesh = domain_asset
            .mesh
            .as_mut()
            .expect("conflicting-realization test mesh is inline");
        mesh.nodes.push([0.0, 0.0, -1.0]);
        mesh.push_tet4_cell([0, 2, 1, 4]).unwrap();
        mesh.element_markers.push(2);
        mesh.push_tri3_facet([0, 2, 4]).unwrap();
        mesh.boundary_markers.push(2);
        domain_asset
            .object_region_markers
            .push(fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: format!("strip:sharp_{parameter_name}"),
                marker: 2,
            });
        ir.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Strict;

        let error = plan(&ir).expect_err(
            "a nodal P1 and element DG0 payload for one FEM coefficient must be rejected",
        );
        assert!(
            error.reasons.iter().any(|reason| {
                reason.contains(parameter_name)
                    && reason.contains(nodal_location)
                    && reason.contains(element_location)
            }),
            "{parameter_name} conflict must name the coefficient and both locations: {:?}",
            error.reasons
        );
    }
}

#[test]
fn fem_cpu_relaxation_rejects_conflicting_nodal_and_element_ms_before_native_create() {
    let mut ir = fem_minimal_test_ir();
    ir.materials.push(fullmag_ir::MaterialIR {
        name: "Co".to_string(),
        saturation_magnetisation: 1.1e6,
        exchange_stiffness: 13e-12,
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
        object_id: None,
        name: "second".to_string(),
        region: "second".to_string(),
        material: "Co".to_string(),
        initial_magnetization: None,
        absorbing_boundary: None,
    });
    ir.object_regions.push(fullmag_ir::ObjectRegionIR {
        region_id: "second:conformal_material".to_string(),
        owner_object: "second".to_string(),
        name: "conformal_material".to_string(),
        shape: fullmag_ir::RegionShapeIR::Box {
            size: [1.0, 1.0, 1.0],
            center: [0.0, 0.0, 0.0],
        },
        frame: fullmag_ir::RegionFrameIR::Object,
        enabled: true,
        priority: 1,
        mesh_policy: None,
        material_overrides: vec![
            fullmag_ir::RegionMaterialOverrideIR {
                parameter: fullmag_ir::MaterialParameterNameIR::Ms,
                value: fullmag_ir::MaterialParameterFieldIR::Constant {
                    value: serde_json::json!(1.2e6),
                    unit: Some("A/m".to_string()),
                },
                priority: 1,
                conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
            },
            fullmag_ir::RegionMaterialOverrideIR {
                parameter: fullmag_ir::MaterialParameterNameIR::Aex,
                value: fullmag_ir::MaterialParameterFieldIR::Constant {
                    value: serde_json::json!(15e-12),
                    unit: Some("J/m".to_string()),
                },
                priority: 1,
                conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
            },
        ],
        texture_override: None,
        material_transition: Some(fullmag_ir::MaterialTransitionSpecIR::Sharp),
        realization_policy: fullmag_ir::RegionRealizationPolicyIR::Conformal,
    });
    let domain_asset = ir
        .geometry_assets
        .as_mut()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_mut())
        .expect("shared-domain test needs an inline mesh");
    let mesh = domain_asset
        .mesh
        .as_mut()
        .expect("shared-domain mesh is inline");
    mesh.nodes.extend([
        [0.0, 0.0, 2.0],
        [1.0, 0.0, 2.0],
        [0.0, 1.0, 2.0],
        [0.0, 0.0, 3.0],
        [0.0, 0.0, 4.0],
        [1.0, 0.0, 4.0],
        [0.0, 1.0, 4.0],
        [0.0, 0.0, 5.0],
    ]);
    mesh.push_tet4_cell([4, 5, 6, 7]).unwrap();
    mesh.element_markers.push(2);
    mesh.push_tri3_facet([4, 5, 6]).unwrap();
    mesh.boundary_markers.push(2);
    mesh.push_tet4_cell([8, 9, 10, 11]).unwrap();
    mesh.element_markers.push(3);
    mesh.push_tri3_facet([8, 9, 10]).unwrap();
    mesh.boundary_markers.push(3);
    domain_asset
        .region_markers
        .push(fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "second".to_string(),
            marker: 2,
        });
    domain_asset
        .object_region_markers
        .push(fullmag_ir::FemDomainRegionMarkerIR {
            geometry_name: "second:conformal_material".to_string(),
            marker: 3,
        });
    ir.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Strict;

    ir.study = fullmag_ir::StudyIR::Relaxation {
        algorithm: fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
        dynamics: None,
        stop: fullmag_ir::RelaxStopIR {
            torque_tolerance_apm: Some(1e-3),
            energy_tolerance_j: None,
            max_steps: Some(1),
            max_relaxation_time_s: None,
        },
        sampling: ir.study.sampling().clone(),
    };
    let error = plan(&ir)
        .expect_err("public CPU relaxation payload must reject conflicting Ms realizations");
    assert!(
        error.reasons.iter().any(|reason| {
            reason.contains("Ms")
                && reason.contains("material.ms_field")
                && reason.contains("ms_element_field")
        }),
        "unexpected planner errors: {:?}",
        error.reasons
    );
}

#[test]
fn fem_sharp_aex_conformal_marker_metadata_without_mesh_domain_still_blocks() {
    let mut ir = fem_minimal_test_ir();
    ir.object_regions.push(fullmag_ir::ObjectRegionIR {
        region_id: "strip:fake_conformal_defect".to_string(),
        owner_object: "strip".to_string(),
        name: "fake_conformal_defect".to_string(),
        shape: fullmag_ir::RegionShapeIR::Box {
            size: [0.2, 0.2, 0.2],
            center: [0.0, 0.0, 0.0],
        },
        frame: fullmag_ir::RegionFrameIR::Object,
        enabled: true,
        priority: 20,
        mesh_policy: None,
        material_overrides: vec![fullmag_ir::RegionMaterialOverrideIR {
            parameter: fullmag_ir::MaterialParameterNameIR::Aex,
            value: fullmag_ir::MaterialParameterFieldIR::Constant {
                value: serde_json::json!(5e-12),
                unit: Some("J/m".to_string()),
            },
            priority: 20,
            conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
        }],
        texture_override: None,
        material_transition: Some(fullmag_ir::MaterialTransitionSpecIR::Sharp),
        realization_policy: fullmag_ir::RegionRealizationPolicyIR::Conformal,
    });
    if let Some(assets) = ir.geometry_assets.as_mut() {
        if let Some(domain_asset) = assets.fem_domain_mesh_asset.as_mut() {
            domain_asset
                .object_region_markers
                .push(fullmag_ir::FemDomainRegionMarkerIR {
                    geometry_name: "strip:fake_conformal_defect".to_string(),
                    marker: 2,
                });
        }
    }
    ir.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Strict;

    let err = plan(&ir)
        .expect_err("metadata-only object_region_marker must not satisfy strict conformal policy");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("sharp parameter override for Aex/Ms")
                && reason.contains("requires a conformal boundary")
        }),
        "unexpected planner errors: {:?}",
        err.reasons
    );
}

#[test]
fn fem_sharp_aex_region_requires_project_policy_in_extended_without_conformal_marker() {
    let mut ir = fem_minimal_test_ir();
    let region = fullmag_ir::ObjectRegionIR {
        region_id: "strip:defect".to_string(),
        owner_object: "strip".to_string(),
        name: "defect".to_string(),
        shape: fullmag_ir::RegionShapeIR::Sphere {
            radius: 0.1,
            center: [0.5, 0.5, 0.5],
        },
        frame: fullmag_ir::RegionFrameIR::Object,
        enabled: true,
        priority: 20,
        mesh_policy: None,
        material_overrides: vec![fullmag_ir::RegionMaterialOverrideIR {
            parameter: fullmag_ir::MaterialParameterNameIR::Aex,
            value: fullmag_ir::MaterialParameterFieldIR::Constant {
                value: serde_json::json!(5e-12),
                unit: Some("J/m".to_string()),
            },
            priority: 20,
            conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
        }],
        texture_override: None,
        material_transition: Some(fullmag_ir::MaterialTransitionSpecIR::Sharp),
        realization_policy: fullmag_ir::RegionRealizationPolicyIR::Inherit,
    };
    ir.object_regions.push(region);
    ir.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Extended;

    let err = plan(&ir)
        .expect_err("extended FEM projection must require explicit realization_policy='project'");
    assert!(
        err.reasons.iter().any(|reason| {
            reason.contains("requires conformal boundary")
                && reason.contains("to allow projection, set realization_policy='project'")
        }),
        "unexpected planner errors: {:?}",
        err.reasons
    );
}

#[test]
fn fem_sharp_aex_region_allows_projection_in_extended_with_warning() {
    let mut ir = fem_minimal_test_ir();
    let region = fullmag_ir::ObjectRegionIR {
        region_id: "strip:defect".to_string(),
        owner_object: "strip".to_string(),
        name: "defect".to_string(),
        shape: fullmag_ir::RegionShapeIR::Sphere {
            radius: 0.1,
            center: [0.5, 0.5, 0.5],
        },
        frame: fullmag_ir::RegionFrameIR::Object,
        enabled: true,
        priority: 20,
        mesh_policy: None,
        material_overrides: vec![fullmag_ir::RegionMaterialOverrideIR {
            parameter: fullmag_ir::MaterialParameterNameIR::Aex,
            value: fullmag_ir::MaterialParameterFieldIR::Constant {
                value: serde_json::json!(5e-12),
                unit: Some("J/m".to_string()),
            },
            priority: 20,
            conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
        }],
        texture_override: None,
        material_transition: Some(fullmag_ir::MaterialTransitionSpecIR::Sharp),
        realization_policy: fullmag_ir::RegionRealizationPolicyIR::Project,
    };
    ir.object_regions.push(region);
    ir.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Extended;

    let planned = plan(&ir).expect("sharp Aex override in non-conformal region must be allowed in extended mode with project policy");

    let aex_plan = planned
        .common
        .material_field_plans
        .iter()
        .find(|p| p.parameter == fullmag_ir::MaterialParameterNameIR::Aex)
        .expect("expected material field plan for Aex");
    assert!(
        aex_plan.warnings.iter().any(|warning| {
            warning.contains("sharp parameter override for Aex")
                && warning.contains("in region 'strip:defect' requires conformal boundary, but no domain marker was found in the mesh; projected approximation will be used")
        }),
        "expected projection warning in Aex plan, got warnings: {:?}",
        aex_plan.warnings
    );
    assert_eq!(
        aex_plan.realization_method.as_deref(),
        Some("projected_nodal_sampling")
    );
    let statistics = aex_plan
        .statistics
        .as_ref()
        .expect("projected nodal field must expose realization statistics");
    assert_eq!(statistics.sample_count, 4);
    assert!(
        planned
            .provenance
            .notes
            .iter()
            .any(|note| { note.contains("projected approximation will be used") }),
        "projection warning must be preserved in execution provenance: {:?}",
        planned.provenance.notes
    );
}

#[test]
fn fem_sharp_aex_project_policy_with_real_marker_still_uses_projection_warning() {
    let mut ir = fem_minimal_test_ir();
    let region = fullmag_ir::ObjectRegionIR {
        region_id: "strip:projected_conformal_defect".to_string(),
        owner_object: "strip".to_string(),
        name: "projected_conformal_defect".to_string(),
        shape: fullmag_ir::RegionShapeIR::Box {
            size: [0.2, 0.2, 0.2],
            center: [0.0, 0.0, 0.0],
        },
        frame: fullmag_ir::RegionFrameIR::Object,
        enabled: true,
        priority: 20,
        mesh_policy: None,
        material_overrides: vec![fullmag_ir::RegionMaterialOverrideIR {
            parameter: fullmag_ir::MaterialParameterNameIR::Aex,
            value: fullmag_ir::MaterialParameterFieldIR::Constant {
                value: serde_json::json!(5e-12),
                unit: Some("J/m".to_string()),
            },
            priority: 20,
            conflict_policy: fullmag_ir::RegionConflictPolicyIR::Error,
        }],
        texture_override: None,
        material_transition: Some(fullmag_ir::MaterialTransitionSpecIR::Sharp),
        realization_policy: fullmag_ir::RegionRealizationPolicyIR::Project,
    };
    ir.object_regions.push(region);
    if let Some(assets) = ir.geometry_assets.as_mut() {
        if let Some(domain_asset) = assets.fem_domain_mesh_asset.as_mut() {
            if let Some(mesh) = domain_asset.mesh.as_mut() {
                mesh.nodes = vec![
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [1.0, 1.0, 1.0],
                    [0.0, 0.0, 0.0],
                    [0.05, 0.0, 0.0],
                    [0.0, 0.05, 0.0],
                    [0.0, 0.0, 0.05],
                ];
                mesh.set_tet4_cells(vec![[0, 1, 2, 3], [4, 5, 6, 7]]);
                mesh.element_markers = vec![1, 2];
                mesh.set_tri3_facets(vec![[0, 1, 2], [4, 5, 6]]);
                mesh.boundary_markers = vec![1, 2];
            }
            domain_asset
                .object_region_markers
                .push(fullmag_ir::FemDomainRegionMarkerIR {
                    geometry_name: "strip:projected_conformal_defect".to_string(),
                    marker: 2,
                });
        }
    }
    ir.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Extended;

    let planned = plan(&ir).expect(
        "explicit Project policy must be allowed in extended mode even when a real marker exists",
    );
    let aex_plan = planned
        .common
        .material_field_plans
        .iter()
        .find(|p| p.parameter == fullmag_ir::MaterialParameterNameIR::Aex)
        .expect("expected material field plan for Aex");
    assert_eq!(
        aex_plan.realization_method.as_deref(),
        Some("projected_nodal_sampling")
    );
    assert!(
        aex_plan.warnings.iter().any(|warning| {
            warning.contains("explicit project policy was requested despite an available conformal domain marker")
                && warning.contains("projected approximation will be used")
        }),
        "expected explicit-project warning, got warnings: {:?}",
        aex_plan.warnings
    );
    assert!(
        !aex_plan
            .warnings
            .iter()
            .any(|warning| warning.contains("no domain marker was found")),
        "projected conformal-marker warning must not claim that the marker is missing: {:?}",
        aex_plan.warnings
    );
    assert!(
        planned.provenance.notes.iter().any(|note| {
            note.contains("explicit project policy was requested despite an available conformal domain marker")
        }),
        "explicit-project warning must be preserved in execution provenance: {:?}",
        planned.provenance.notes
    );
}

fn minimal_hysteresis_study() -> StudyIR {
    StudyIR::Hysteresis {
        field_min_mT: Some(-10.0),
        field_max_mT: Some(10.0),
        field_step_mT: Some(10.0),
        field_values_mT: None,
        direction: Some([0.0, 0.0, 1.0]),
        orientation: Some(fullmag_ir::FieldOrientationIR::Preset {
            preset_name: "oop_positive".to_string(),
        }),
        measurement_axis: fullmag_ir::MeasurementAxisIR::field_axis(),
        angular_family: None,
        initial_protocol: "as_authored".to_string(),
        initial_state_ref: None,
        saturation: None,
        branch_mode: "major_loop".to_string(),
        settle_pipeline: Some(fullmag_ir::SettlePipelineIR::Sequence {
            steps: vec![fullmag_ir::SettleStepIR::Relax {
                method: "llg_overdamped".to_string(),
                alpha: 1.0,
                torque_tolerance: 1.0e-5,
                max_steps: 25,
                applies_to: None,
                stop_criteria: None,
                timestep_s: None,
                max_pseudotime_s: None,
                max_physical_time_s: None,
                on_non_convergence: "continue_with_warning".to_string(),
                retry_timestep_scale: None,
                retry_max_attempts: None,
            }],
        }),
        storage: Some(fullmag_ir::HysteresisStorageIR {
            scalar_history: true,
            magnetization: "none".to_string(),
            every_n: 1,
            key_events: false,
            key_event_threshold_dm: 0.02,
        }),
        field_schedule: None,
        field_unit_provenance: None,
        schedule_refinements: None,
        adaptive_refinement: None,
        minor_loops: None,
        sampling: SamplingIR {
            table_autosave: None,
            stage_autosave: None,
            outputs: vec![OutputIR::Scalar {
                name: "mx".to_string(),
                every_seconds: 1.0e-12,
            }],
        },
    }
}

#[test]
fn hysteresis_fdm_study_plans_as_canonical_hysteresis_workflow() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = minimal_hysteresis_study();

    let planned = plan(&ir).expect("canonical FDM hysteresis stage should plan");

    match planned.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            assert!(
                fdm.relaxation.is_none(),
                "hysteresis settle pipeline must remain owned by the hysteresis workflow, not lowered as a global relaxation control"
            );
            assert!(
                fdm.external_field.is_none(),
                "per-point hysteresis fields must be injected by the hysteresis runtime, not frozen in the base FDM plan"
            );
        }
        other => panic!("expected FDM plan for bootstrap hysteresis study, got {other:?}"),
    }
}

#[test]
fn hysteresis_fem_study_plans_as_canonical_hysteresis_workflow() {
    let mut ir = fem_minimal_test_ir();
    ir.study = minimal_hysteresis_study();

    let planned = plan(&ir).expect("canonical FEM hysteresis stage should plan");

    match planned.backend_plan {
        BackendPlanIR::Fem(fem) => {
            assert!(
                fem.relaxation.is_none(),
                "hysteresis settle pipeline must remain owned by the hysteresis workflow, not lowered as a global FEM relaxation control"
            );
            assert!(
                fem.external_field.is_none(),
                "per-point hysteresis fields must be injected by the hysteresis runtime, not frozen in the base FEM plan"
            );
        }
        other => panic!("expected FEM plan for FEM hysteresis study, got {other:?}"),
    }
}

#[test]
fn hysteresis_planner_reports_ir_validation_errors() {
    let mut ir = ProblemIR::bootstrap_example();
    ir.study = minimal_hysteresis_study();
    if let StudyIR::Hysteresis { field_step_mT, .. } = &mut ir.study {
        *field_step_mT = Some(0.0);
    }

    let error = plan(&ir).expect_err("zero hysteresis field step must fail planning");

    assert!(
        error
            .reasons
            .iter()
            .any(|reason| reason.contains("field_step_mT must not be zero")),
        "planner must surface hysteresis IR validation errors, got {:?}",
        error.reasons
    );
}

#[test]
fn fdm_grid_count_overflow_is_rejected() {
    let counts = [u32::MAX, u32::MAX, 2];
    let error = crate::geometry::checked_fdm_grid_cost(counts, 1)
        .expect_err("grid cell-count multiplication must reject u64 overflow");

    assert!(error
        .reasons
        .iter()
        .any(|reason| reason.contains("fdm_grid_count_overflow")));
    assert!(error
        .reasons
        .iter()
        .any(|reason| { reason.contains("4294967295") && reason.contains("requested_counts") }));
}

#[test]
fn fdm_grid_memory_budget_is_rejected() {
    let counts = [1_000, 1_000, 1_000];
    let error = crate::geometry::checked_fdm_grid_cost(counts, 16)
        .expect_err("grid allocation must reject a cost above the lane budget");

    assert!(error
        .reasons
        .iter()
        .any(|reason| reason.contains("fdm_grid_memory_budget_exceeded")));
    assert!(error
        .reasons
        .iter()
        .any(|reason| { reason.contains("1000") && reason.contains("requested_counts") }));
}

#[test]
fn fdm_per_magnet_cells_resolve_without_hidden_fallback() {
    let mut per_magnet = BTreeMap::new();
    per_magnet.insert(
        "left".to_string(),
        fullmag_ir::FdmGridHintsIR {
            cell: [1e-9, 2e-9, 3e-9],
        },
    );
    per_magnet.insert(
        "right".to_string(),
        fullmag_ir::FdmGridHintsIR {
            cell: [2e-9, 2e-9, 3e-9],
        },
    );
    let hints = fullmag_ir::FdmHintsIR {
        cell: [0.0; 3],
        default_cell: None,
        per_magnet: Some(per_magnet),
        demag: None,
        boundary_correction: None,
        boundary_phi_floor: None,
        boundary_delta_min: None,
        projection_policy: None,
    };

    assert_eq!(cell_for_magnet(&hints, "left").unwrap(), [1e-9, 2e-9, 3e-9]);
    assert!(cell_for_magnet(&hints, "missing")
        .unwrap_err()
        .contains("missing"));
    assert!(fdm_default_cell(&hints).is_err());
}

#[test]
fn fdm_single_grid_plan_uses_per_magnet_cell_without_default() {
    let mut ir = ProblemIR::bootstrap_example();
    let magnet_name = ir.magnets[0].name.clone();
    let mut per_magnet = BTreeMap::new();
    per_magnet.insert(
        magnet_name,
        fullmag_ir::FdmGridHintsIR {
            cell: [1e-9, 2e-9, 3e-9],
        },
    );
    let fdm = ir
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .expect("bootstrap must carry FDM hints");
    fdm.cell = [0.0; 3];
    fdm.default_cell = None;
    fdm.per_magnet = Some(per_magnet);

    let planned = plan(&ir).expect("single-grid per-magnet cell should plan");
    match planned.backend_plan {
        BackendPlanIR::Fdm(single) => {
            assert_eq!(single.cell_size, [1e-9, 2e-9, 3e-9]);
        }
        other => panic!("expected FDM single-grid plan, got {other:?}"),
    }
}

#[test]
fn fdm_multilayer_plan_resolves_complete_per_magnet_map_without_default() {
    let mut ir = stacked_two_body_multilayer_problem();
    let mut per_magnet = BTreeMap::new();
    for magnet in &ir.magnets {
        per_magnet.insert(
            magnet.name.clone(),
            fullmag_ir::FdmGridHintsIR {
                cell: [2e-9, 2e-9, 2e-9],
            },
        );
    }
    let fdm = ir
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .expect("stacked fixture must carry FDM hints");
    fdm.cell = [0.0; 3];
    fdm.default_cell = None;
    fdm.per_magnet = Some(per_magnet);

    let planned = plan(&ir).expect("complete per-magnet map should plan");
    match planned.backend_plan {
        BackendPlanIR::FdmMultilayer(multilayer) => {
            assert_eq!(multilayer.layers.len(), 2);
            assert!(multilayer
                .layers
                .iter()
                .all(|layer| layer.native_cell_size == [2e-9, 2e-9, 2e-9]));
        }
        other => panic!("expected FDM multilayer plan, got {other:?}"),
    }
}

#[test]
fn fdm_multilayer_plan_rejects_missing_or_conflicting_per_magnet_cells() {
    let mut missing = stacked_two_body_multilayer_problem();
    let mut only_free = BTreeMap::new();
    only_free.insert(
        "free".to_string(),
        fullmag_ir::FdmGridHintsIR {
            cell: [2e-9, 2e-9, 2e-9],
        },
    );
    let fdm = missing
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .expect("stacked fixture must carry FDM hints");
    fdm.cell = [0.0; 3];
    fdm.default_cell = None;
    fdm.per_magnet = Some(only_free);
    let error = plan(&missing).expect_err("missing layer override must fail closed");
    assert!(
        error
            .reasons
            .iter()
            .any(|reason| { reason.contains("ref") && reason.contains("missing cell override") }),
        "unexpected reasons: {:?}",
        error.reasons
    );

    let mut conflicting = stacked_two_body_multilayer_problem();
    let mut per_magnet = BTreeMap::new();
    per_magnet.insert(
        "free".to_string(),
        fullmag_ir::FdmGridHintsIR {
            cell: [1e-9, 2e-9, 2e-9],
        },
    );
    per_magnet.insert(
        "ref".to_string(),
        fullmag_ir::FdmGridHintsIR {
            cell: [2e-9, 2e-9, 2e-9],
        },
    );
    let fdm = conflicting
        .backend_policy
        .discretization_hints
        .as_mut()
        .and_then(|hints| hints.fdm.as_mut())
        .expect("stacked fixture must carry FDM hints");
    fdm.cell = [0.0; 3];
    fdm.default_cell = None;
    fdm.per_magnet = Some(per_magnet);
    let error = plan(&conflicting).expect_err("conflicting native cells must fail closed");
    assert!(error.reasons.iter().any(|reason| {
        reason.contains("requires default_cell when per_magnet cell overrides differ")
    }));
}

#[test]
fn fdm_difference_preserves_translated_operand_and_finite_height() {
    let base = fullmag_ir::GeometryEntryIR::Box {
        name: "base".to_string(),
        size: [4.0, 4.0, 4.0],
    };
    let tool = fullmag_ir::GeometryEntryIR::Translate {
        name: "tool".to_string(),
        base: Box::new(fullmag_ir::GeometryEntryIR::Cylinder {
            name: "tool_base".to_string(),
            radius: 1.0,
            height: 2.0,
            axis: [0.0, 0.0, 1.0],
        }),
        by: [1.0, 0.0, 0.0],
    };
    let shape = ir_to_shape(&fullmag_ir::GeometryEntryIR::Difference {
        name: "difference".to_string(),
        base: Box::new(base.clone()),
        tool: Box::new(tool),
    })
    .expect("difference should lower");
    let mut errors = Vec::new();
    let (_size, mask, cells, origin) = voxelize_shape(&shape, [1.0; 3], &mut errors);
    assert!(
        errors.is_empty(),
        "unexpected voxelization errors: {errors:?}"
    );
    assert_eq!(cells, [4, 4, 4]);
    assert_eq!(origin, [-2.0, -2.0, -2.0]);
    let mask = mask.expect("bounded CSG should produce a mask");
    let removed: Vec<usize> = mask
        .iter()
        .enumerate()
        .filter_map(|(index, active)| (!active).then_some(index))
        .collect();
    assert_eq!(
        removed,
        vec![22, 23, 26, 27, 38, 39, 42, 43],
        "translated cylinder must only cut its x/y footprint and finite z span"
    );

    let box_tool = fullmag_ir::GeometryEntryIR::Translate {
        name: "box_tool".to_string(),
        base: Box::new(fullmag_ir::GeometryEntryIR::Box {
            name: "box_tool_base".to_string(),
            size: [2.0, 2.0, 2.0],
        }),
        by: [1.0, 0.0, 0.0],
    };
    let box_shape = ir_to_shape(&fullmag_ir::GeometryEntryIR::Difference {
        name: "box_difference".to_string(),
        base: Box::new(base),
        tool: Box::new(box_tool),
    })
    .expect("box difference should lower");
    let mut box_errors = Vec::new();
    let (_, box_mask, _, _) = voxelize_shape(&box_shape, [1.0; 3], &mut box_errors);
    assert!(
        box_errors.is_empty(),
        "unexpected box CSG errors: {box_errors:?}"
    );
    let box_removed: Vec<usize> = box_mask
        .expect("bounded CSG should produce a mask")
        .iter()
        .enumerate()
        .filter_map(|(index, active)| (!active).then_some(index))
        .collect();
    assert_eq!(
        box_removed, removed,
        "translated box and cylinder fixtures must share the canonical active-cell fingerprint"
    );
}
