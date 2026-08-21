//! Independent revision semantics for authored object-region realizations.
//!
//! The scene revision is an authoring journal revision.  It must not be used as
//! the identity of a realized mesh, region membership mask, material field, or
//! initial-state field.  This module provides the backend-neutral classifier
//! used by those consumers to derive the smallest invalidation set.

use crate::{SceneDocument, SceneObject, SceneObjectRegion};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Revisions of the independent region-realization products.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegionRealizationRevisions {
    pub topology: u64,
    pub membership: u64,
    pub coefficients: u64,
    pub initial_state: u64,
}

/// The products affected by one authoring transition.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegionRealizationImpact {
    pub topology: bool,
    pub membership: bool,
    pub coefficients: bool,
    pub initial_state: bool,
}

impl RegionRealizationImpact {
    pub const fn is_empty(self) -> bool {
        !self.topology && !self.membership && !self.coefficients && !self.initial_state
    }
}

impl RegionRealizationRevisions {
    /// Advance only the revisions whose products changed.
    pub fn advance(self, impact: RegionRealizationImpact) -> Self {
        Self {
            topology: self.topology.saturating_add(u64::from(impact.topology)),
            membership: self.membership.saturating_add(u64::from(impact.membership)),
            coefficients: self
                .coefficients
                .saturating_add(u64::from(impact.coefficients)),
            initial_state: self
                .initial_state
                .saturating_add(u64::from(impact.initial_state)),
        }
    }
}

/// Classify a scene transition without using the scene journal revision.
///
/// Name/label/editor-only changes are intentionally ignored.  Region geometry
/// changes affect membership, while mesh policy/realization policy changes
/// affect topology.  Material and texture changes are kept on separate lanes.
pub fn classify_region_realization_impact(
    before: &SceneDocument,
    after: &SceneDocument,
) -> RegionRealizationImpact {
    let mut impact = RegionRealizationImpact::default();

    if before.universe != after.universe
        || before.study.universe_mesh != after.study.universe_mesh
        || before.study.shared_domain_mesh != after.study.shared_domain_mesh
        || before.study.mesh_defaults != after.study.mesh_defaults
        || before.study.mesh_interfaces != after.study.mesh_interfaces
    {
        impact.topology = true;
    }

    if before.materials != after.materials {
        impact.coefficients = true;
    }
    if before.magnetization_assets != after.magnetization_assets {
        impact.initial_state = true;
    }
    if before.couplings != after.couplings {
        impact.coefficients = true;
    }

    let before_objects = objects_by_id(&before.objects);
    let after_objects = objects_by_id(&after.objects);
    if before_objects.len() != after_objects.len() || before_objects.keys().ne(after_objects.keys())
    {
        // An object is a complete realized product, so adding/removing one
        // invalidates every product lane exactly once.
        return RegionRealizationImpact {
            topology: true,
            membership: true,
            coefficients: true,
            initial_state: true,
        };
    }

    for object_id in before_objects.keys() {
        let before_object = before_objects[object_id];
        let after_object = after_objects[object_id];
        classify_object_transition(before_object, after_object, &mut impact);
    }

    impact
}

fn objects_by_id(objects: &[SceneObject]) -> BTreeMap<&str, &SceneObject> {
    objects
        .iter()
        .map(|object| (object.id.as_str(), object))
        .collect()
}

fn classify_object_transition(
    before: &SceneObject,
    after: &SceneObject,
    impact: &mut RegionRealizationImpact,
) {
    if before.geometry != after.geometry
        || before.transform != after.transform
        || before.object_mesh != after.object_mesh
        || before.mesh_override != after.mesh_override
    {
        impact.topology = true;
    }

    if before.material_ref != after.material_ref
        || before.material_parameter_fields != after.material_parameter_fields
        || before.physics_stack != after.physics_stack
    {
        impact.coefficients = true;
    }
    if before.magnetization_ref != after.magnetization_ref {
        impact.initial_state = true;
    }
    if before.region_overrides != after.region_overrides {
        // Region overrides are consumed by geometry realization when they
        // select an initial magnetization/texture for an authored region.
        // They do not alter FEM topology or FDM membership.
        impact.initial_state = true;
    }

    let before_regions = regions_by_id(&before.regions);
    let after_regions = regions_by_id(&after.regions);
    if before_regions.len() != after_regions.len() || before_regions.keys().ne(after_regions.keys())
    {
        // Region identity changes alter marker assignment and every realized
        // field that depends on that assignment.  Keep the old products
        // inspectable, but never present them as current.
        impact.topology = true;
        impact.membership = true;
        impact.coefficients = true;
        impact.initial_state = true;
    } else if before
        .regions
        .iter()
        .map(|region| region.region_id.as_str())
        .ne(after.regions.iter().map(|region| region.region_id.as_str()))
    {
        // Reorder is semantically relevant for priority/conflict resolution.
        impact.topology = true;
        impact.membership = true;
        impact.coefficients = true;
        impact.initial_state = true;
    }

    for region_id in before_regions.keys() {
        let Some(after_region) = after_regions.get(region_id) else {
            continue;
        };
        classify_region_transition(before_regions[region_id], after_region, impact);
    }
}

fn regions_by_id(regions: &[SceneObjectRegion]) -> BTreeMap<&str, &SceneObjectRegion> {
    regions
        .iter()
        .map(|region| (region.region_id.as_str(), region))
        .collect()
}

fn classify_region_transition(
    before: &SceneObjectRegion,
    after: &SceneObjectRegion,
    impact: &mut RegionRealizationImpact,
) {
    if before.shape != after.shape
        || before.frame != after.frame
        || before.enabled != after.enabled
        || before.priority != after.priority
    {
        impact.membership = true;
        impact.coefficients = true;
        impact.initial_state = true;
    }
    if before.mesh_policy != after.mesh_policy
        || before.realization_policy != after.realization_policy
    {
        impact.topology = true;
    }
    if before.material_overrides != after.material_overrides
        || before.material_transition != after.material_transition
    {
        impact.coefficients = true;
    }
    if before.texture_override != after.texture_override {
        impact.initial_state = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        SceneInitialMagnetization, SceneObjectRegion, SceneRegionFrame, SceneRegionOverride,
        SceneRegionRealizationPolicy, SceneRegionShape, SceneTextureOverride,
    };
    use serde_json::json;

    fn scene() -> SceneDocument {
        serde_json::from_value(json!({
            "objects": [{
                "id": "film",
                "name": "Film",
                "geometry": {"geometry_kind": "box"},
                "material_ref": "mat",
                "regions": [{
                    "region_id": "film:core",
                    "owner_object": "film",
                    "name": "Core",
                    "shape": {"kind": "box", "size": [1.0, 1.0, 1.0], "center": [0.0, 0.0, 0.0]}
                }]
            }]
        }))
        .expect("minimal scene fixture must deserialize")
    }

    #[test]
    fn metadata_only_transition_does_not_advance_realization_lanes() {
        let mut after = scene();
        after.objects[0].name = "Renamed".to_string();
        assert_eq!(
            classify_region_realization_impact(&scene(), &after),
            RegionRealizationImpact::default()
        );

        let mut region_name = scene();
        region_name.objects[0].regions[0].name = "Renamed core".to_string();
        assert!(classify_region_realization_impact(&scene(), &region_name).is_empty());
    }

    #[test]
    fn frozen_spins_authoring_does_not_advance_region_realization_lanes() {
        let before = scene();
        let mut after = before.clone();
        after.magnetization_constraints = serde_json::from_value(json!([{
            "kind": "frozen_spins",
            "schema_version": "frozen_spins.v1",
            "id": "pin-core",
            "name": "Pinned core",
            "enabled": true,
            "selector": {"kind": "in_object", "object_id": "film"},
            "reference": {"kind": "capture_current_at_activation"},
            "membership": {"kind": "static"},
            "activation": {"kind": "all_stages"},
            "empty_selection": "error",
            "inactive_selection": "warn_and_intersect"
        }]))
        .expect("frozen-spins constraint fixture");

        assert_eq!(
            classify_region_realization_impact(&before, &after),
            RegionRealizationImpact::default()
        );
    }

    #[test]
    fn each_region_product_has_an_independent_lane() {
        let before = scene();

        let mut membership = before.clone();
        membership.objects[0].regions[0].enabled = false;
        assert_eq!(
            classify_region_realization_impact(&before, &membership),
            RegionRealizationImpact {
                membership: true,
                coefficients: true,
                initial_state: true,
                ..Default::default()
            }
        );

        let mut coefficients = before.clone();
        coefficients.objects[0].material_ref = "mat-2".to_string();
        assert_eq!(
            classify_region_realization_impact(&before, &coefficients),
            RegionRealizationImpact {
                coefficients: true,
                ..Default::default()
            }
        );

        let mut initial_state = before.clone();
        initial_state.objects[0].magnetization_ref = Some("texture-2".to_string());
        assert_eq!(
            classify_region_realization_impact(&before, &initial_state),
            RegionRealizationImpact {
                initial_state: true,
                ..Default::default()
            }
        );

        let mut region_override = before.clone();
        region_override.objects[0].region_overrides.insert(
            "film:core".to_string(),
            SceneRegionOverride {
                magnetization_ref: Some("texture-region".to_string()),
            },
        );
        assert_eq!(
            classify_region_realization_impact(&before, &region_override),
            RegionRealizationImpact {
                initial_state: true,
                ..Default::default()
            }
        );

        let mut texture = before.clone();
        texture.objects[0].regions[0].texture_override = Some(SceneTextureOverride {
            initial_magnetization: SceneInitialMagnetization::Uniform {
                value: [0.0, 1.0, 0.0],
            },
        });
        assert_eq!(
            classify_region_realization_impact(&before, &texture),
            RegionRealizationImpact {
                initial_state: true,
                ..Default::default()
            }
        );

        let mut topology = before.clone();
        topology.objects[0].geometry.geometry_kind = "cylinder".to_string();
        assert_eq!(
            classify_region_realization_impact(&before, &topology),
            RegionRealizationImpact {
                topology: true,
                ..Default::default()
            }
        );
    }

    #[test]
    fn region_shape_frame_priority_and_realization_policy_have_explicit_lanes() {
        let before = scene();

        let mut membership = before.clone();
        membership.objects[0].regions[0].shape = SceneRegionShape::Sphere {
            radius: 0.25,
            center: [0.0, 0.0, 0.0],
        };
        membership.objects[0].regions[0].frame = SceneRegionFrame::World;
        membership.objects[0].regions[0].priority = 10;
        assert_eq!(
            classify_region_realization_impact(&before, &membership),
            RegionRealizationImpact {
                membership: true,
                coefficients: true,
                initial_state: true,
                ..Default::default()
            }
        );

        let mut topology = before.clone();
        topology.objects[0].regions[0].realization_policy = SceneRegionRealizationPolicy::Conformal;
        assert_eq!(
            classify_region_realization_impact(&before, &topology),
            RegionRealizationImpact {
                topology: true,
                ..Default::default()
            }
        );

        let mut reordered = before.clone();
        reordered.objects[0].regions.push(SceneObjectRegion {
            region_id: "film:aux".to_string(),
            owner_object: "film".to_string(),
            name: "Aux".to_string(),
            shape: SceneRegionShape::Box {
                center: [0.0, 0.0, 0.0],
                size: [0.5, 0.5, 0.5],
            },
            frame: SceneRegionFrame::Object,
            enabled: true,
            priority: 2,
            mesh_policy: None,
            material_overrides: Vec::new(),
            texture_override: None,
            material_transition: None,
            realization_policy: SceneRegionRealizationPolicy::Project,
        });
        let mut swapped = reordered.clone();
        swapped.objects[0].regions.swap(0, 1);
        assert_eq!(
            classify_region_realization_impact(&reordered, &swapped),
            RegionRealizationImpact {
                topology: true,
                membership: true,
                coefficients: true,
                initial_state: true,
            }
        );
    }

    #[test]
    fn revisions_advance_monotonically_without_scene_revision_aliasing() {
        let revisions = RegionRealizationRevisions {
            topology: 41,
            membership: 7,
            coefficients: 12,
            initial_state: 3,
        };
        let next = revisions.advance(RegionRealizationImpact {
            membership: true,
            initial_state: true,
            ..Default::default()
        });
        assert_eq!(next.topology, 41);
        assert_eq!(next.membership, 8);
        assert_eq!(next.coefficients, 12);
        assert_eq!(next.initial_state, 4);
    }
}
