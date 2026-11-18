//! Read-only STL source surfaces before meshing, on the existing binary plane.
use crate::{
    error::ApiError,
    schemas::imported_surface::{ImportedSourceSurfaceQuery, ImportedSourceSurfaceResource},
    types::{AppState, CurrentLiveRequestContext},
};
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    response::Response,
    Json,
};
use fullmag_authoring::{ImportedStlParameters, ImportedTriangleSurface};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
};

struct LoadedSurface {
    descriptor: ImportedSourceSurfaceResource,
    surface: ImportedTriangleSurface,
}

fn read_surface(
    source: &FsPath,
    allowed_roots: &[PathBuf],
    object_id: String,
    scene_revision: u64,
    parameters: ImportedStlParameters,
    expected_digest: Option<String>,
) -> Result<LoadedSurface, ApiError> {
    let bytes = crate::imported_geometry_sources::capture_stl_source(
        source,
        allowed_roots,
        expected_digest.as_deref(),
    )?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let mut surface =
        fullmag_authoring::parse_stl_surface(&bytes).map_err(ApiError::bad_request)?;
    for point in &mut surface.positions {
        for axis in 0..3 {
            let original = point[axis];
            point[axis] *= parameters.scale[axis];
            if !point[axis].is_finite() || (original != 0.0 && point[axis] == 0.0) {
                return Err(ApiError::bad_request(
                    "STL scaled source coordinates are not finite",
                ));
            }
        }
    }
    for axis in 0..3 {
        surface.bounds_min[axis] *= parameters.scale[axis];
        surface.bounds_max[axis] *= parameters.scale[axis];
        if !(surface.bounds_max[axis] - surface.bounds_min[axis]).is_finite() {
            return Err(ApiError::bad_request(
                "STL scaled bounds are not representable",
            ));
        }
    }
    let identity = format!(
        "{:x}",
        Sha256::digest(format!("{object_id}:{digest}:{:?}", parameters.scale).as_bytes())
    );
    let descriptor = ImportedSourceSurfaceResource {
        purpose: "authoring_source_surface".into(),
        object_id,
        scene_revision,
        surface_id: format!("stl-source-{identity}"),
        source_sha256: digest,
        coordinate_frame: "object_local".into(),
        coordinate_unit: "m".into(),
        scale_to_metres: parameters.scale,
        node_count: surface.positions.len(),
        triangle_count: surface.triangle_indices.len(),
        bounds_min: surface.bounds_min,
        bounds_max: surface.bounds_max,
        solver_eligible: false,
        topology_format: "FMMT/2".into(),
    };
    Ok(LoadedSurface {
        descriptor,
        surface,
    })
}

async fn load_current_surface(
    state: &Arc<AppState>,
    object_id: &str,
) -> Result<(CurrentLiveRequestContext, LoadedSurface), ApiError> {
    let context = crate::capture_current_live_read_context(state).await?;
    let (scene, script_path) = {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no current workspace"))?;
        crate::ensure_current_live_request_context(snapshot, &context, context.session_epoch)?;
        (
            snapshot
                .scene_document
                .clone()
                .ok_or_else(|| ApiError::not_found("no materialized authoring scene"))?,
            snapshot.session.script_path.clone(),
        )
    };
    let object = scene
        .objects
        .iter()
        .find(|object| object.id == object_id)
        .ok_or_else(|| ApiError::not_found("authoring object is unavailable"))?;
    if object.geometry.geometry_kind != "ImportedGeometry" {
        return Err(ApiError::bad_request(
            "source surface requires ImportedGeometry",
        ));
    }
    let parameters = fullmag_authoring::imported_stl_parameters(&object.geometry.geometry_params)
        .map_err(ApiError::bad_request)?;
    let expected_digest = match &object.geometry.source_asset {
        Some(reference) => {
            reference.validate().map_err(ApiError::bad_request)?;
            Some(reference.content_sha256.clone())
        }
        None => None,
    };
    let source = PathBuf::from(&parameters.source);
    let base = crate::imported_geometry_sources::script_asset_root(
        &script_path,
        &state.current_workspace_root,
    );
    let source = if source.is_absolute() {
        source
    } else {
        base.join(source)
    };
    let roots = vec![
        state.repo_root.clone(),
        state.current_workspace_root.clone(),
        PathBuf::from("/user-data"),
    ];
    let object_id = object_id.to_string();
    let loaded = tokio::task::spawn_blocking(move || {
        read_surface(
            &source,
            &roots,
            object_id,
            scene.revision,
            parameters,
            expected_digest,
        )
    })
    .await
    .map_err(|error| ApiError::internal(format!("STL source capture task failed: {error}")))??;
    validate_current_surface(state, &context, loaded.descriptor.scene_revision).await?;
    Ok((context, loaded))
}

async fn validate_current_surface(
    state: &AppState,
    context: &CurrentLiveRequestContext,
    revision: u64,
) -> Result<(), ApiError> {
    let current = state.current_live_state.read().await;
    let snapshot = current
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no current workspace"))?;
    crate::ensure_current_live_request_context(
        snapshot,
        context,
        state
            .current_live_session_epoch
            .load(std::sync::atomic::Ordering::Acquire),
    )?;
    if snapshot.scene_document.as_ref().map(|scene| scene.revision) != Some(revision) {
        return Err(ApiError::conflict(
            "authoring scene changed during STL surface capture",
        ));
    }
    Ok(())
}

#[utoipa::path(get, path = "/v2/sessions/current/model/objects/{object_id}/source-surface",
    params(("object_id" = String, Path)), responses((status = 200, body = ImportedSourceSurfaceResource),
    (status = 404, description = "Source or object unavailable"), (status = 409, description = "Source or scene changed")), tag = "model")]
pub async fn get_imported_source_surface(
    State(state): State<Arc<AppState>>,
    Path(object_id): Path<String>,
) -> Result<Json<ImportedSourceSurfaceResource>, ApiError> {
    let (_, loaded) = load_current_surface(&state, &object_id).await?;
    Ok(Json(loaded.descriptor))
}

#[utoipa::path(get, path = "/v2/sessions/current/model/objects/{object_id}/source-surface/topology",
    params(("object_id" = String, Path), ("scene_revision" = u64, Query), ("source_sha256" = String, Query)),
    responses((status = 200, description = "Source-only FMMT v2: zero cells, triangular facets", content_type = "application/octet-stream"),
    (status = 206, description = "Binary range"), (status = 304, description = "Not modified"),
    (status = 409, description = "Stale scene or source")), tag = "model")]
pub async fn get_imported_source_surface_topology(
    State(state): State<Arc<AppState>>,
    Path(object_id): Path<String>,
    Query(query): Query<ImportedSourceSurfaceQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (context, loaded) = load_current_surface(&state, &object_id).await?;
    if query.scene_revision != loaded.descriptor.scene_revision
        || query.source_sha256 != loaded.descriptor.source_sha256
    {
        return Err(ApiError::conflict(
            "STL surface request refers to a stale scene or source",
        ));
    }
    let etag =
        crate::router_v2::handlers::shared::stable_strong_etag(&loaded.descriptor.surface_id);
    let mesh = source_surface_payload(loaded);
    let response = crate::router_v2::handlers::shared::conditional_fem_topology_response(
        &state, &headers, &etag, &mesh,
    )
    .map_err(ApiError::conflict)?;
    validate_current_surface(&state, &context, query.scene_revision).await?;
    Ok(response)
}

fn source_surface_payload(loaded: LoadedSurface) -> fullmag_runner::FemMeshPayload {
    let count = loaded.surface.triangle_indices.len();
    fullmag_runner::FemMeshPayload {
        mesh_name: "authoring_source_surface".into(),
        mesh_id: loaded.descriptor.surface_id,
        nodes: loaded.surface.positions,
        cells: fullmag_ir::FemConnectivityIR {
            types: vec![],
            offsets: vec![0],
            nodes: vec![],
            global_ordinals: vec![],
            mesh_parts: vec![],
        },
        element_markers: vec![],
        facets: fullmag_ir::FemFacetConnectivityIR {
            types: vec![fullmag_ir::FemFacetTypeIR::Tri3; count],
            // In this dedicated resource Exterior means a source-surface face;
            // it makes no material-interface or volume-domain assertion.
            roles: vec![fullmag_ir::FemFacetRoleIR::Exterior; count],
            offsets: (0..=count).map(|index| (3 * index) as u32).collect(),
            nodes: loaded
                .surface
                .triangle_indices
                .into_iter()
                .flatten()
                .collect(),
            global_ordinals: (0..count as u64).collect(),
        },
        boundary_markers: vec![],
        periodic_boundary_pairs: vec![],
        periodic_node_pairs: vec![],
        object_segments: vec![],
        mesh_parts: vec![],
        domain_mesh_mode: None,
        domain_frame: None,
        generation_id: None,
        per_domain_quality: HashMap::new(),
        build_report: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRIANGLE: &[u8] = b"solid face\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 2 0 0\nvertex 0 3 0\nendloop\nendfacet\nendsolid face\n";

    #[test]
    fn source_surface_has_si_bounds_and_no_solver_cells() {
        let root =
            std::env::temp_dir().join(format!("fullmag-source-surface-{}", crate::uuid_v4_hex()));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("face.stl");
        std::fs::write(&source, TRIANGLE).unwrap();
        let parameters = fullmag_authoring::imported_stl_parameters(&serde_json::json!({
            "source": "face.stl", "units": "um"
        }))
        .unwrap();
        let digest = format!("{:x}", Sha256::digest(TRIANGLE));
        let loaded = read_surface(
            &source,
            &[root.clone()],
            "body".into(),
            7,
            parameters.clone(),
            Some(digest.clone()),
        )
        .unwrap();
        assert_eq!(loaded.descriptor.purpose, "authoring_source_surface");
        assert_eq!(loaded.descriptor.bounds_max, [2e-6, 3e-6, 0.0]);
        assert!(!loaded.descriptor.solver_eligible);
        let mesh = source_surface_payload(loaded);
        assert!(mesh.cells.types.is_empty());
        assert_eq!(mesh.cells.offsets, vec![0]);
        assert_eq!(mesh.facets.nodes.len(), 3);
        let binary = crate::field_store::serialize_fem_mesh_topology_binary_v2(&mesh).unwrap();
        assert_eq!(&binary[..4], b"FMMT");
        assert!(read_surface(
            &source,
            &[root.clone()],
            "body".into(),
            7,
            parameters.clone(),
            Some("0".repeat(64))
        )
        .is_err());
        assert!(read_surface(
            &source,
            &[root.join("unrelated")],
            "body".into(),
            7,
            parameters,
            Some(digest)
        )
        .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
