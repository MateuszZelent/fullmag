//! Presentation of a pinned sampling domain, separate from the current source.
use fullmag_ir::{
    AntennaFieldOnlyPlanIR, BackendPlanIR, ExecutionPlanIR, FieldTargetIR, ProblemIR,
};
use fullmag_runner::{FemMeshPartPayload, FemMeshPayload};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

use crate::error::ApiError;

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::conflict_with_code("accepted_preparation_sampling_mesh_invalid", message)
}

pub(super) fn pinned_global_mesh(
    problem: &ProblemIR,
    execution: &ExecutionPlanIR,
) -> Result<Option<FemMeshPayload>, ApiError> {
    let BackendPlanIR::AntennaFieldOnly(plan) = &execution.backend_plan else {
        return Ok(None);
    };
    if !matches!(plan.field_sampling.domain, FieldTargetIR::Global {}) {
        return Ok(None);
    }
    let asset = problem
        .geometry_assets
        .as_ref()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_ref())
        .ok_or_else(|| invalid("pinned Global sampling domain is missing"))?;
    // Accepted catalogs must own the mesh. Never reopen a mutable mesh_source
    // during publication of an immutable accepted run.
    let mesh = asset
        .mesh
        .as_ref()
        .ok_or_else(|| invalid("pinned Global sampling domain has no inline mesh"))?;
    let digest = format!(
        "sha256:{:x}",
        Sha256::digest(
            serde_json::to_vec(mesh)
                .map_err(|error| invalid(format!("cannot hash sampling mesh: {error}")))?
        )
    );
    if plan.field_sampling.carrier_kind != "fem_domain_mesh_asset"
        || plan.field_sampling.location != "node"
        || plan.field_sampling.topology_digest != digest
        || plan.field_sampling.positions_xyz_m != mesh.nodes
        || plan.field_sampling.cells != mesh.cells
    {
        return Err(invalid(
            "pinned Global mesh differs from the accepted sampling carrier",
        ));
    }
    fullmag_ir::validate_mesh_for_execution(mesh).map_err(|errors| invalid(errors.join("; ")))?;
    let tetrahedra = mesh.cells.require_tet4().map_err(invalid)?;
    if mesh.element_markers.len() != tetrahedra.len() {
        return Err(invalid("Global mesh markers do not cover every cell"));
    }
    // Payload parts use contiguous ranges. Keep every owned marker run in
    // sampling order rather than repacking the Global topology.
    let owners = domain_owners(problem, plan, asset)?;
    let mut facets_by_nodes = BTreeMap::<[u32; 3], Vec<u32>>::new();
    for index in 0..mesh.facets.len() {
        let Some(face) = mesh.facets.item_nodes(index) else {
            continue;
        };
        let Ok(mut face) = <[u32; 3]>::try_from(face) else {
            continue;
        };
        face.sort_unstable();
        facets_by_nodes.entry(face).or_default().push(index as u32);
    }
    let mut mesh_parts = Vec::new();
    let mut start = 0;
    while start < tetrahedra.len() {
        let marker = mesh.element_markers[start];
        let mut end = start + 1;
        while end < tetrahedra.len() && mesh.element_markers[end] == marker {
            end += 1;
        }
        let is_air = marker == 0;
        let owner = if is_air {
            None
        } else {
            Some(owners.get(&marker).ok_or_else(|| {
                invalid(format!(
                    "Global marker {marker} has no pinned object ownership"
                ))
            })?)
        };
        let mut nodes = BTreeSet::new();
        let mut faces = BTreeSet::new();
        for tet in &tetrahedra[start..end] {
            nodes.extend(tet.iter().copied());
            for indices in [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]] {
                let mut face = [tet[indices[0]], tet[indices[1]], tet[indices[2]]];
                face.sort_unstable();
                faces.insert(face);
            }
        }
        let boundary_face_indices = faces
            .iter()
            .filter_map(|face| facets_by_nodes.get(face))
            .flatten()
            .copied()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let node_indices = nodes.into_iter().collect::<Vec<_>>();
        let mut min = [f64::INFINITY; 3];
        let mut max = [f64::NEG_INFINITY; 3];
        for &node in &node_indices {
            for axis in 0..3 {
                min[axis] = min[axis].min(mesh.nodes[node as usize][axis]);
                max[axis] = max[axis].max(mesh.nodes[node as usize][axis]);
            }
        }
        mesh_parts.push(FemMeshPartPayload {
            id: format!("domain:{marker}:{start}"),
            label: owner
                .map(|(id, _, _)| id.clone())
                .unwrap_or_else(|| "Airbox".into()),
            role: owner
                .map(|(_, _, role)| role.clone())
                .unwrap_or_else(|| "air".into()),
            object_id: owner.map(|(id, _, _)| id.clone()),
            geometry_id: owner.map(|(_, geometry, _)| geometry.clone()),
            material_id: None,
            element_start: start as u32,
            element_count: (end - start) as u32,
            boundary_face_start: 0,
            boundary_face_count: boundary_face_indices.len() as u32,
            facet_global_ordinals: boundary_face_indices
                .iter()
                .map(|&i| mesh.facets.global_ordinals[i as usize])
                .collect(),
            boundary_face_indices,
            node_start: 0,
            node_count: node_indices.len() as u32,
            node_indices,
            bounds_min: Some(min),
            bounds_max: Some(max),
        });
        start = end;
    }
    let generation = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(asset)
                .map_err(|error| invalid(format!("cannot hash domain asset: {error}")))?
        )
    );
    Ok(Some(FemMeshPayload {
        mesh_name: mesh.mesh_name.clone(),
        mesh_id: format!("{}:{generation}", mesh.mesh_name),
        nodes: mesh.nodes.clone(),
        cells: mesh.cells.clone(),
        element_markers: mesh.element_markers.clone(),
        facets: mesh.facets.clone(),
        boundary_markers: mesh.boundary_markers.clone(),
        periodic_boundary_pairs: mesh.periodic_boundary_pairs.clone(),
        periodic_node_pairs: mesh.periodic_node_pairs.clone(),
        object_segments: Vec::new(),
        mesh_parts,
        domain_mesh_mode: mesh
            .element_markers
            .contains(&0)
            .then(|| "shared_domain_mesh_with_air".into()),
        domain_frame: problem
            .problem_meta
            .runtime_metadata
            .get("domain_frame")
            .cloned()
            .and_then(|value| serde_json::from_value::<fullmag_ir::DomainFrameIR>(value).ok())
            .and_then(fullmag_ir::DomainFrameIR::finalized),
        generation_id: Some(generation),
        per_domain_quality: mesh
            .per_domain_quality
            .iter()
            .map(|(marker, quality)| (*marker, quality.into()))
            .collect(),
        build_report: asset.build_report.clone(),
    }))
}

/// Resolve ownership from the pinned canonical object bindings and authored
/// modules. A presentation type never activates magnetization or transport.
fn domain_owners(
    problem: &ProblemIR,
    plan: &AntennaFieldOnlyPlanIR,
    asset: &fullmag_ir::FemDomainMeshAssetIR,
) -> Result<BTreeMap<u32, (String, String, String)>, ApiError> {
    let explicit = fullmag_ir::physics_object_geometry_bindings_v03(problem)
        .map_err(|errors| invalid(errors.join("; ")))?;
    let mut objects = explicit.unwrap_or_else(|| {
        problem
            .geometry
            .entries
            .iter()
            .map(|entry| (entry.name().to_owned(), entry.name().to_owned()))
            .collect()
    });
    let mut magnetic = BTreeSet::new();
    for magnet in &problem.magnets {
        let id = magnet.object_id.as_deref().unwrap_or(&magnet.name);
        let geometry = fullmag_ir::geometry_name_for_physics_object_v03(problem, id)
            .map_err(|errors| invalid(errors.join("; ")))?;
        // The canonical legacy adapter prefers an explicit magnetic owner to
        // the geometry-name alias. Auxiliary explicit owners were validated.
        objects.retain(|other, value| value.as_str() != geometry || other.as_str() == id);
        objects.insert(id.to_owned(), geometry.to_owned());
        magnetic.insert(id.to_owned());
    }
    let mut conducting = BTreeSet::from([plan.source_object_id.clone()]);
    for module in &problem.current_modules {
        if let fullmag_ir::CurrentModuleIR::CurrentTransport {
            definition: Some(definition),
            ..
        } = module
        {
            conducting.extend(
                definition
                    .domain
                    .iter()
                    .map(|region| region.object_id.clone()),
            );
        }
    }
    for id in &conducting {
        let geometry = fullmag_ir::geometry_name_for_physics_object_v03(problem, id)
            .map_err(|errors| invalid(errors.join("; ")))?;
        if let Some((other, _)) = objects.iter().find(|(other, value)| {
            value.as_str() == geometry
                && other.as_str() != id.as_str()
                && (magnetic.contains(*other) || other.as_str() != geometry)
        }) {
            return Err(invalid(format!(
                "transport object {id} conflicts with canonical owner {other}"
            )));
        }
        objects.retain(|other, value| value.as_str() != geometry || other == id);
        objects.insert(id.clone(), geometry.to_owned());
    }
    let role = |id: &str| {
        if magnetic.contains(id) {
            "magnetic_object"
        } else if conducting.contains(id) {
            "conductor"
        } else {
            "geometry"
        }
    };
    let mut owners = BTreeMap::new();
    for entry in asset
        .region_markers
        .iter()
        .chain(&asset.object_region_markers)
    {
        if entry.marker == 0 {
            continue;
        }
        let owner = problem
            .object_regions
            .iter()
            .find(|region| {
                region.enabled
                    && (entry.geometry_name == region.region_id
                        || entry.geometry_name == region.name)
            })
            .map(|region| region.owner_object.as_str())
            .or_else(|| {
                objects
                    .iter()
                    .find(|(_, geometry)| **geometry == entry.geometry_name)
                    .map(|(id, _)| id.as_str())
            })
            .ok_or_else(|| {
                invalid(format!(
                    "domain marker {} has no canonical owner",
                    entry.marker
                ))
            })?;
        if !objects.contains_key(owner) {
            return Err(invalid(format!(
                "domain marker {} refers to an unknown owner",
                entry.marker
            )));
        }
        let value = (
            owner.to_owned(),
            objects[owner].clone(),
            role(owner).to_owned(),
        );
        if let Some(previous) = owners.insert(entry.marker, value.clone()) {
            if previous != value {
                return Err(invalid(format!(
                    "domain marker {} has conflicting ownership",
                    entry.marker
                )));
            }
        }
    }
    Ok(owners)
}

pub(super) fn global_publication_binding(
    plan: &AntennaFieldOnlyPlanIR,
    mesh: &FemMeshPayload,
) -> serde_json::Value {
    serde_json::json!({"sampling_topology_digest": plan.field_sampling.topology_digest,
        "mesh_generation_id": mesh.generation_id, "mesh_name": mesh.mesh_name})
}
