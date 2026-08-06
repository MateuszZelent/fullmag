//! Mesh-backed realized-region membership endpoints.

use std::collections::BTreeSet;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::Json;
use fullmag_authoring::{
    SceneDocument, SceneObject, SceneObjectRegion, SceneRegionFrame, SceneRegionShape,
};
use fullmag_runner::{FemMeshObjectSegment, FemMeshPartPayload, FemMeshPayload};

use crate::error::ApiError;
use crate::schemas::mesh::{
    MeshRegionMembershipListResource, MeshRegionMembershipResource, MeshUnresolvedRegionResource,
};
use crate::types::AppState;

#[derive(Debug, serde::Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct MeshRegionMembershipQuery {
    /// Canonical owner object ID. Required when multiple objects expose the
    /// same authored region ID.
    pub owner_object_id: Option<String>,
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/mesh-region-membership/{region_id}",
    params(
        ("region_id" = String, Path, description = "Authored or realized region id"),
        MeshRegionMembershipQuery
    ),
    responses(
        (status = 200, description = "Realized-region membership indices from FEM mesh parts, object segments, or geometry projection", body = MeshRegionMembershipResource),
        (status = 404, description = "No active mesh or membership for the region"),
        (status = 409, description = "Region ID is ambiguous without owner_object_id"),
    ),
    tag = "data"
)]
pub async fn get_mesh_region_membership(
    State(state): State<Arc<AppState>>,
    Path(region_id): Path<String>,
    Query(query): Query<MeshRegionMembershipQuery>,
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

    let owner_object_id = resolve_mesh_region_owner(
        scene,
        &region_id,
        query.owner_object_id.as_deref(),
    )?;
    build_mesh_region_membership_for_owner(
        scene,
        mesh,
        snapshot.mesh_revision,
        snapshot.region_realization_revisions.membership,
        &owner_object_id,
        &region_id,
    )
    .map(Json)
    .ok_or_else(|| ApiError::not_found(format!("mesh region membership '{region_id}' not found")))
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
    let mut unresolved_regions = Vec::new();
    for (owner_object_id, region_id) in enabled_authored_region_keys(scene) {
        if let Some(membership) = build_mesh_region_membership_for_owner(
            scene,
            mesh,
            snapshot.mesh_revision,
            snapshot.region_realization_revisions.membership,
            &owner_object_id,
            &region_id,
        ) {
            memberships.push(membership);
        } else {
            unresolved_regions.push(MeshUnresolvedRegionResource {
                owner_object_id,
                region_id,
            });
        }
    }

    Ok(Json(MeshRegionMembershipListResource {
        mesh_id: mesh.mesh_id.clone(),
        mesh_revision: snapshot.mesh_revision,
        memberships,
        unresolved_regions,
    }))
}

pub(crate) fn build_mesh_region_membership(
    scene: &SceneDocument,
    mesh: &FemMeshPayload,
    mesh_revision: u64,
    region_membership_revision: u64,
    region_id: &str,
) -> Option<MeshRegionMembershipResource> {
    let owner_object_id = resolve_mesh_region_owner(scene, region_id, None).ok()?;
    build_mesh_region_membership_for_owner(
        scene,
        mesh,
        mesh_revision,
        region_membership_revision,
        &owner_object_id,
        region_id,
    )
}

fn build_mesh_region_membership_for_owner(
    scene: &SceneDocument,
    mesh: &FemMeshPayload,
    mesh_revision: u64,
    region_membership_revision: u64,
    owner_object_id: &str,
    region_id: &str,
) -> Option<MeshRegionMembershipResource> {
    let parts = mesh_region_membership_parts(scene, mesh, owner_object_id, region_id);
    let segments = if parts.is_empty() {
        mesh_region_membership_segments(scene, mesh, owner_object_id, region_id)
    } else {
        Vec::new()
    };
    let projection = if parts.is_empty() && segments.is_empty() {
        mesh_region_membership_geometry_projection(scene, mesh, owner_object_id, region_id)
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

    let has_generation = mesh.generation_id.is_some();
    let has_marker_certificate = mesh.build_report.as_ref().is_some_and(|report| {
        !report.region_markers.is_empty() || !report.object_region_markers.is_empty()
    });
    let realized_current = projection.is_none() && has_generation && has_marker_certificate;
    let mut realization_warnings = if projection.is_some() {
        vec![
            "geometry_projection uses node and centroid membership; it is not a conformal mesh part"
                .to_string(),
        ]
    } else {
        Vec::new()
    };
    if projection.is_none() && !realized_current {
        realization_warnings.push(
            "realized membership lacks a current mesh generation and marker certificate"
                .to_string(),
        );
    }

    Some(MeshRegionMembershipResource {
        mesh_id: mesh.mesh_id.clone(),
        mesh_revision,
        topology_fingerprint: Some(fullmag_runner::fem_mesh_topology_fingerprint(mesh)),
        mesh_generation_id: mesh.generation_id.clone(),
        region_membership_revision,
        freshness: if projection.is_some() {
            "preview".to_string()
        } else if realized_current {
            "current".to_string()
        } else {
            "stale".to_string()
        },
        realization: if projection.is_some() {
            "analytic_preview".to_string()
        } else {
            "realized".to_string()
        },
        owner_object_id: owner_object_id.to_string(),
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
        realization_warnings,
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
    owner_object_id: &str,
    region_id: &str,
) -> Vec<&'a FemMeshPartPayload> {
    let Some(object) = scene
        .objects
        .iter()
        .find(|object| object_ids_match(&object.id, owner_object_id))
    else {
        return Vec::new();
    };
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

    if let Some(region) = find_matching_enabled_region(object, region_id) {
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

    Vec::new()
}

fn mesh_region_membership_segments<'a>(
    scene: &SceneDocument,
    mesh: &'a FemMeshPayload,
    owner_object_id: &str,
    region_id: &str,
) -> Vec<&'a FemMeshObjectSegment> {
    let Some(object) = scene
        .objects
        .iter()
        .find(|object| object_ids_match(&object.id, owner_object_id))
    else {
        return Vec::new();
    };
    if object_region_matches(object, region_id) {
        return mesh
            .object_segments
            .iter()
            .filter(|segment| object_ids_match(&segment.object_id, &object.id))
            .collect();
    }

    if let Some(region) = find_matching_enabled_region(object, region_id) {
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

    Vec::new()
}

fn mesh_region_membership_geometry_projection(
    scene: &SceneDocument,
    mesh: &FemMeshPayload,
    owner_object_id: &str,
    region_id: &str,
) -> Option<GeometryProjectionMembership> {
    let (object, region) = find_enabled_object_region(scene, owner_object_id, region_id)?;
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
    let elements = mesh.require_tet4_elements().ok()?;
    let boundary_faces = mesh.require_tri3_boundary_faces().ok()?;

    for (index, node) in mesh.nodes.iter().enumerate() {
        if point_in_region_shape(region_sample_point(*node, object, region), &region.shape) {
            push_unique(&mut membership.node_indices, index as u32);
        }
    }
    for (index, element) in elements.iter().enumerate() {
        let Some(centroid) = tetra_centroid(mesh, element) else {
            continue;
        };
        if point_in_region_shape(region_sample_point(centroid, object, region), &region.shape) {
            push_unique(&mut membership.element_indices, index as u32);
        }
    }
    for (index, face) in boundary_faces.iter().enumerate() {
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
    owner_object_id: &str,
    region_id: &str,
) -> Option<(&'a SceneObject, &'a SceneObjectRegion)> {
    let object = scene
        .objects
        .iter()
        .find(|object| object_ids_match(&object.id, owner_object_id))?;
    find_matching_enabled_region(object, region_id).map(|region| (object, region))
}

fn enabled_authored_region_keys(scene: &SceneDocument) -> Vec<(String, String)> {
    let mut keys = Vec::new();
    for object in &scene.objects {
        for region in &object.regions {
            let key = (object.id.clone(), region.region_id.clone());
            if region.enabled && !region.region_id.is_empty() && !keys.contains(&key) {
                keys.push(key);
            }
        }
    }
    keys
}

fn resolve_mesh_region_owner(
    scene: &SceneDocument,
    region_id: &str,
    requested_owner_object_id: Option<&str>,
) -> Result<String, ApiError> {
    if let Some(requested) = requested_owner_object_id {
        let object = scene
            .objects
            .iter()
            .find(|object| object_ids_match(&object.id, requested))
            .ok_or_else(|| ApiError::not_found(format!("scene object '{requested}' not found")))?;
        if object_region_matches(object, region_id)
            || find_matching_enabled_region(object, region_id).is_some()
        {
            return Ok(object.id.clone());
        }
        return Err(ApiError::not_found(format!(
            "mesh region membership '{requested}/{region_id}' not found"
        )));
    }

    let mut owners = scene
        .objects
        .iter()
        .filter(|object| {
            object_region_matches(object, region_id)
                || find_matching_enabled_region(object, region_id).is_some()
        })
        .map(|object| object.id.clone());
    let owner = owners.next().ok_or_else(|| {
        ApiError::not_found(format!("mesh region membership '{region_id}' not found"))
    })?;
    if owners.next().is_some() {
        return Err(ApiError::conflict(format!(
            "mesh region membership '{region_id}' is ambiguous; provide owner_object_id"
        )));
    }
    Ok(owner)
}

fn find_matching_enabled_region<'a>(
    object: &'a SceneObject,
    region_id: &str,
) -> Option<&'a SceneObjectRegion> {
    object.regions.iter().find(|region| {
        region.enabled
            && (region.region_id == region_id
                || region.name == region_id
                || region_geometry_aliases(&region.region_id, &region.name).contains(region_id))
    })
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
