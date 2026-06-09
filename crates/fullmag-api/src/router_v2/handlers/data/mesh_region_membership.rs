//! Mesh-backed realized-region membership endpoints.

use std::collections::BTreeSet;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use fullmag_authoring::{
    SceneDocument, SceneObject, SceneObjectRegion, SceneRegionFrame, SceneRegionShape,
};
use fullmag_runner::{FemMeshObjectSegment, FemMeshPartPayload, FemMeshPayload};

use crate::error::ApiError;
use crate::schemas::mesh::{MeshRegionMembershipListResource, MeshRegionMembershipResource};
use crate::types::AppState;

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/mesh-region-membership/{region_id}",
    params(
        ("region_id" = String, Path, description = "Authored or realized region id")
    ),
    responses(
        (status = 200, description = "Realized-region membership indices from FEM mesh parts, object segments, or geometry projection", body = MeshRegionMembershipResource),
        (status = 404, description = "No active mesh or membership for the region"),
    ),
    tag = "data"
)]
pub async fn get_mesh_region_membership(
    State(state): State<Arc<AppState>>,
    Path(region_id): Path<String>,
) -> Result<Json<MeshRegionMembershipResource>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let mesh = snapshot
        .fem_mesh
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active FEM mesh"))?;
    let scene = snapshot
        .scene_document
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active scene document"))?;

    build_mesh_region_membership(scene, mesh, snapshot.mesh_revision, &region_id)
        .map(Json)
        .ok_or_else(|| {
            ApiError::not_found(format!("mesh region membership '{region_id}' not found"))
        })
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/mesh-region-memberships",
    responses(
        (status = 200, description = "Available realized-region memberships for enabled authored object regions in the current FEM mesh", body = MeshRegionMembershipListResource),
        (status = 404, description = "No active mesh or scene document"),
    ),
    tag = "data"
)]
pub async fn get_mesh_region_memberships(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MeshRegionMembershipListResource>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let mesh = snapshot
        .fem_mesh
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active FEM mesh"))?;
    let scene = snapshot
        .scene_document
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active scene document"))?;

    let mut memberships = Vec::new();
    let mut unresolved_region_ids = Vec::new();
    for region_id in enabled_authored_region_ids(scene) {
        if let Some(membership) =
            build_mesh_region_membership(scene, mesh, snapshot.mesh_revision, &region_id)
        {
            memberships.push(membership);
        } else {
            unresolved_region_ids.push(region_id);
        }
    }

    Ok(Json(MeshRegionMembershipListResource {
        mesh_id: mesh.mesh_id.clone(),
        mesh_revision: snapshot.mesh_revision,
        memberships,
        unresolved_region_ids,
    }))
}

fn build_mesh_region_membership(
    scene: &SceneDocument,
    mesh: &FemMeshPayload,
    mesh_revision: u64,
    region_id: &str,
) -> Option<MeshRegionMembershipResource> {
    let parts = mesh_region_membership_parts(scene, mesh, region_id);
    let segments = if parts.is_empty() {
        mesh_region_membership_segments(scene, mesh, region_id)
    } else {
        Vec::new()
    };
    let projection = if parts.is_empty() && segments.is_empty() {
        mesh_region_membership_geometry_projection(scene, mesh, region_id)
    } else {
        None
    };
    if parts.is_empty() && segments.is_empty() && projection.is_none() {
        return None;
    }

    let mut mesh_part_ids = Vec::new();
    let mut element_indices = Vec::new();
    let mut node_indices = Vec::new();
    let mut boundary_face_indices = Vec::new();

    for part in &parts {
        mesh_part_ids.push(part.id.clone());
        push_unique_range(&mut element_indices, part.element_start, part.element_count);
        if part.node_indices.is_empty() {
            push_unique_range(&mut node_indices, part.node_start, part.node_count);
        } else {
            push_unique_values(&mut node_indices, &part.node_indices);
        }
        if part.boundary_face_indices.is_empty() {
            push_unique_range(
                &mut boundary_face_indices,
                part.boundary_face_start,
                part.boundary_face_count,
            );
        } else {
            push_unique_values(&mut boundary_face_indices, &part.boundary_face_indices);
        }
    }
    for segment in &segments {
        push_unique_range(
            &mut element_indices,
            segment.element_start,
            segment.element_count,
        );
        push_unique_range(&mut node_indices, segment.node_start, segment.node_count);
        push_unique_range(
            &mut boundary_face_indices,
            segment.boundary_face_start,
            segment.boundary_face_count,
        );
    }
    if let Some(projection) = &projection {
        push_unique_values(&mut element_indices, &projection.element_indices);
        push_unique_values(&mut node_indices, &projection.node_indices);
        push_unique_values(
            &mut boundary_face_indices,
            &projection.boundary_face_indices,
        );
    }

    Some(MeshRegionMembershipResource {
        mesh_id: mesh.mesh_id.clone(),
        mesh_revision,
        region_id: region_id.to_string(),
        source: if projection.is_some() {
            "geometry_projection"
        } else if parts.is_empty() {
            "object_segments"
        } else {
            "mesh_parts"
        }
        .to_string(),
        realization_method: projection
            .is_some()
            .then(|| "shape_centroid_geometry_projection_v1".to_string()),
        realization_warnings: if projection.is_some() {
            vec![
                "geometry_projection uses node and centroid membership; it is not a conformal mesh part"
                    .to_string(),
            ]
        } else {
            Vec::new()
        },
        mesh_part_ids,
        element_indices,
        node_indices,
        boundary_face_indices,
    })
}

struct GeometryProjectionMembership {
    element_indices: Vec<u32>,
    node_indices: Vec<u32>,
    boundary_face_indices: Vec<u32>,
}

fn mesh_region_membership_parts<'a>(
    scene: &SceneDocument,
    mesh: &'a FemMeshPayload,
    region_id: &str,
) -> Vec<&'a FemMeshPartPayload> {
    for object in &scene.objects {
        if object_region_matches(object, region_id) {
            return mesh
                .mesh_parts
                .iter()
                .filter(|part| {
                    part.object_id
                        .as_deref()
                        .map(|id| object_ids_match(id, &object.id))
                        .unwrap_or(false)
                })
                .collect();
        }

        if let Some(region) = object.regions.iter().find(|region| {
            region.enabled
                && (region.region_id == region_id
                    || region.name == region_id
                    || region_geometry_aliases(&region.region_id, &region.name).contains(region_id))
        }) {
            let geometry_aliases = region_geometry_aliases(&region.region_id, &region.name);
            return mesh
                .mesh_parts
                .iter()
                .filter(|part| {
                    part.object_id
                        .as_deref()
                        .map(|id| object_ids_match(id, &object.id))
                        .unwrap_or(false)
                        && part
                            .geometry_id
                            .as_deref()
                            .map(|geometry_id| geometry_aliases.contains(geometry_id))
                            .unwrap_or(false)
                })
                .collect();
        }
    }

    Vec::new()
}

fn mesh_region_membership_segments<'a>(
    scene: &SceneDocument,
    mesh: &'a FemMeshPayload,
    region_id: &str,
) -> Vec<&'a FemMeshObjectSegment> {
    for object in &scene.objects {
        if object_region_matches(object, region_id) {
            return mesh
                .object_segments
                .iter()
                .filter(|segment| object_ids_match(&segment.object_id, &object.id))
                .collect();
        }

        if let Some(region) = object.regions.iter().find(|region| {
            region.enabled
                && (region.region_id == region_id
                    || region.name == region_id
                    || region_geometry_aliases(&region.region_id, &region.name).contains(region_id))
        }) {
            let geometry_aliases = region_geometry_aliases(&region.region_id, &region.name);
            return mesh
                .object_segments
                .iter()
                .filter(|segment| {
                    object_ids_match(&segment.object_id, &object.id)
                        && segment
                            .geometry_id
                            .as_deref()
                            .map(|geometry_id| geometry_aliases.contains(geometry_id))
                            .unwrap_or(false)
                })
                .collect();
        }
    }

    Vec::new()
}

fn mesh_region_membership_geometry_projection(
    scene: &SceneDocument,
    mesh: &FemMeshPayload,
    region_id: &str,
) -> Option<GeometryProjectionMembership> {
    let (object, region) = find_enabled_object_region(scene, region_id)?;
    if matches!(region.shape, SceneRegionShape::Csg { .. }) {
        return None;
    }
    if matches!(region.frame, SceneRegionFrame::Object)
        && (!is_identity_quat(object.transform.rotation_quat)
            || !is_unit_scale(object.transform.scale))
    {
        return None;
    }

    let mut membership = GeometryProjectionMembership {
        element_indices: Vec::new(),
        node_indices: Vec::new(),
        boundary_face_indices: Vec::new(),
    };

    for (index, node) in mesh.nodes.iter().enumerate() {
        if point_in_region_shape(region_sample_point(*node, object, region), &region.shape) {
            push_unique(&mut membership.node_indices, index as u32);
        }
    }
    for (index, element) in mesh.elements.iter().enumerate() {
        let Some(centroid) = tetra_centroid(mesh, element) else {
            continue;
        };
        if point_in_region_shape(region_sample_point(centroid, object, region), &region.shape) {
            push_unique(&mut membership.element_indices, index as u32);
        }
    }
    for (index, face) in mesh.boundary_faces.iter().enumerate() {
        let Some(centroid) = triangle_centroid(mesh, face) else {
            continue;
        };
        if point_in_region_shape(region_sample_point(centroid, object, region), &region.shape) {
            push_unique(&mut membership.boundary_face_indices, index as u32);
        }
    }

    (!membership.element_indices.is_empty()
        || !membership.node_indices.is_empty()
        || !membership.boundary_face_indices.is_empty())
    .then_some(membership)
}

fn find_enabled_object_region<'a>(
    scene: &'a SceneDocument,
    region_id: &str,
) -> Option<(&'a SceneObject, &'a SceneObjectRegion)> {
    scene.objects.iter().find_map(|object| {
        object.regions.iter().find_map(|region| {
            (region.enabled
                && (region.region_id == region_id
                    || region.name == region_id
                    || region_geometry_aliases(&region.region_id, &region.name)
                        .contains(region_id)))
            .then_some((object, region))
        })
    })
}

fn enabled_authored_region_ids(scene: &SceneDocument) -> Vec<String> {
    let mut ids = Vec::new();
    for object in &scene.objects {
        for region in &object.regions {
            if region.enabled && !region.region_id.is_empty() && !ids.contains(&region.region_id) {
                ids.push(region.region_id.clone());
            }
        }
    }
    ids
}

fn region_sample_point(
    world_point: [f64; 3],
    object: &SceneObject,
    region: &SceneObjectRegion,
) -> [f64; 3] {
    match region.frame {
        SceneRegionFrame::Object => [
            world_point[0] - object.transform.translation[0],
            world_point[1] - object.transform.translation[1],
            world_point[2] - object.transform.translation[2],
        ],
        SceneRegionFrame::World => world_point,
    }
}

fn is_identity_quat(value: [f64; 4]) -> bool {
    value[0].abs() <= 1e-12
        && value[1].abs() <= 1e-12
        && value[2].abs() <= 1e-12
        && (value[3] - 1.0).abs() <= 1e-12
}

fn is_unit_scale(value: [f64; 3]) -> bool {
    value
        .iter()
        .all(|component| (*component - 1.0).abs() <= 1e-12)
}

fn point_in_region_shape(point: [f64; 3], shape: &SceneRegionShape) -> bool {
    match shape {
        SceneRegionShape::Box { size, center } => (0..3).all(|axis| {
            let half = size[axis] * 0.5;
            point[axis] >= center[axis] - half && point[axis] <= center[axis] + half
        }),
        SceneRegionShape::Cylinder {
            radius,
            height,
            center,
            axis,
        } => {
            let norm = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
            if norm <= f64::EPSILON {
                return false;
            }
            let unit = [axis[0] / norm, axis[1] / norm, axis[2] / norm];
            let rel = [
                point[0] - center[0],
                point[1] - center[1],
                point[2] - center[2],
            ];
            let axial = rel[0] * unit[0] + rel[1] * unit[1] + rel[2] * unit[2];
            let radial_sq = rel[0] * rel[0] + rel[1] * rel[1] + rel[2] * rel[2] - axial * axial;
            axial.abs() <= height * 0.5 && radial_sq <= radius * radius
        }
        SceneRegionShape::Sphere { radius, center } => {
            let dx = point[0] - center[0];
            let dy = point[1] - center[1];
            let dz = point[2] - center[2];
            dx * dx + dy * dy + dz * dz <= radius * radius
        }
        SceneRegionShape::Csg { .. } => false,
    }
}

fn tetra_centroid(mesh: &FemMeshPayload, element: &[u32; 4]) -> Option<[f64; 3]> {
    let mut centroid = [0.0; 3];
    for node_index in element {
        let node = mesh.nodes.get(*node_index as usize)?;
        for axis in 0..3 {
            centroid[axis] += node[axis] * 0.25;
        }
    }
    Some(centroid)
}

fn triangle_centroid(mesh: &FemMeshPayload, face: &[u32; 3]) -> Option<[f64; 3]> {
    let mut centroid = [0.0; 3];
    for node_index in face {
        let node = mesh.nodes.get(*node_index as usize)?;
        for axis in 0..3 {
            centroid[axis] += node[axis] / 3.0;
        }
    }
    Some(centroid)
}

fn object_region_matches(object: &SceneObject, region_id: &str) -> bool {
    object.region_name.as_deref() == Some(region_id) || format!("region:{}", object.id) == region_id
}

fn object_ids_match(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let clean_a = a.strip_suffix("_geom").unwrap_or(a);
    let clean_b = b.strip_suffix("_geom").unwrap_or(b);
    clean_a == clean_b
}

fn region_geometry_aliases(region_id: &str, region_name: &str) -> BTreeSet<String> {
    let mut aliases = BTreeSet::new();
    push_region_geometry_aliases(&mut aliases, region_id);
    push_region_geometry_aliases(&mut aliases, region_name);
    aliases
}

fn push_region_geometry_aliases(aliases: &mut BTreeSet<String>, value: &str) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return;
    }
    aliases.insert(trimmed.to_string());
    if let Some(clean) = trimmed.strip_suffix("_geom") {
        aliases.insert(clean.to_string());
    } else {
        aliases.insert(format!("{trimmed}_geom"));
    }
    aliases.insert(trimmed.replace(':', "_"));
    aliases.insert(trimmed.replace(':', "%3A"));
}

fn push_unique_range(values: &mut Vec<u32>, start: u32, count: u32) {
    for value in start..start.saturating_add(count) {
        push_unique(values, value);
    }
}

fn push_unique_values(values: &mut Vec<u32>, incoming: &[u32]) {
    for value in incoming {
        push_unique(values, *value);
    }
}

fn push_unique(values: &mut Vec<u32>, value: u32) {
    if !values.contains(&value) {
        values.push(value);
    }
}
