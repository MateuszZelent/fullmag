//! Mesh-backed realized-region membership endpoints.

use std::collections::BTreeSet;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use fullmag_authoring::{SceneDocument, SceneObject};
use fullmag_runner::{FemMeshPartPayload, FemMeshPayload};

use crate::error::ApiError;
use crate::schemas::mesh::MeshRegionMembershipResource;
use crate::types::AppState;

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/mesh-region-membership/{region_id}",
    params(
        ("region_id" = String, Path, description = "Authored or realized region id")
    ),
    responses(
        (status = 200, description = "Mesh-backed realized-region membership indices", body = MeshRegionMembershipResource),
        (status = 404, description = "No active mesh or mesh-backed membership for the region"),
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

    let parts = mesh_region_membership_parts(scene, mesh, &region_id);
    if parts.is_empty() {
        return Err(ApiError::not_found(format!(
            "mesh region membership '{region_id}' not found"
        )));
    }

    let mut mesh_part_ids = Vec::new();
    let mut element_indices = Vec::new();
    let mut node_indices = Vec::new();
    let mut boundary_face_indices = Vec::new();

    for part in parts {
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

    Ok(Json(MeshRegionMembershipResource {
        mesh_id: mesh.mesh_id.clone(),
        mesh_revision: snapshot.mesh_revision,
        region_id,
        source: "mesh_parts".to_string(),
        mesh_part_ids,
        element_indices,
        node_indices,
        boundary_face_indices,
    }))
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
