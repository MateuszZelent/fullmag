use fullmag_ir::{
    AirBoxConfigIR, ExecutionMode, FemDomainMeshAssetIR, FemDomainMeshModeIR,
    FemDomainRegionMarkerIR, FemMeshPartIR, FemMeshPartRole, FemMeshPartSelector,
    FemObjectSegmentIR, InitialMagnetizationIR, MeshIR, MeshQualityIR, ProblemIR,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use crate::magnetization_textures::{sample_preset_texture, TextureSamplePoint};
use crate::util::{generate_random_unit_vectors, study_universe_metadata, StudyUniverseMetadata};

pub(crate) const AIR_OBJECT_SEGMENT_ID: &str = "__air__";
pub(crate) const AIR_REGION_MARKER: u32 = 0;
pub(crate) const OUTER_BOUNDARY_MARKER: u32 = 99;
pub(crate) const MAG_AIR_INTERFACE_MARKER: u32 = 10;

// FEM-014 fix: centralised air-box heuristic defaults.
// All magic numbers for the air-box are gathered in one place so they can be
// reviewed, overridden via AirBoxPolicyIR, and traced in run metadata.
/// Default mesh grading factor for air-box elements.
const AIRBOX_DEFAULT_GRADING: f64 = 1.4;
/// Preferred boundary marker value for the air-box outer surface.
const AIRBOX_DEFAULT_BOUNDARY_MARKER: u32 = OUTER_BOUNDARY_MARKER;
/// Default air-box shape.
const AIRBOX_DEFAULT_SHAPE: &str = "bbox";
/// Default Robin beta mode (dipole approximation).
const AIRBOX_DEFAULT_ROBIN_BETA_MODE: &str = "dipole";
/// Default Robin beta factor.
const AIRBOX_DEFAULT_ROBIN_BETA_FACTOR: f64 = 2.0;

static MAG_TEXTURE_SAMPLE_LOG_KEYS: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();

fn texture_vector_log_key(values: &[f64]) -> String {
    values
        .iter()
        .map(|value| format!("{value:.17e}"))
        .collect::<Vec<_>>()
        .join(",")
}

fn preset_texture_sample_log_key(
    magnet_name: &str,
    mesh_name: &str,
    n_nodes: usize,
    preset_kind: &str,
    preset_params: &BTreeMap<String, Value>,
    mapping: &fullmag_ir::TextureMappingIR,
    texture_transform: &fullmag_ir::TextureTransform3DIR,
) -> String {
    format!(
        "{}|{}|{}|{}|{:?}|{}/{}/{}|T:{}|R:{}|S:{}|P:{}",
        magnet_name,
        mesh_name,
        n_nodes,
        preset_kind,
        preset_params,
        mapping.space,
        mapping.projection,
        mapping.clamp_mode,
        texture_vector_log_key(&texture_transform.translation),
        texture_vector_log_key(&texture_transform.rotation_quat),
        texture_vector_log_key(&texture_transform.scale),
        texture_vector_log_key(&texture_transform.pivot)
    )
}

fn should_log_preset_texture_sample_once(key: String) -> bool {
    let log_keys = MAG_TEXTURE_SAMPLE_LOG_KEYS.get_or_init(|| Mutex::new(BTreeSet::new()));
    match log_keys.lock() {
        Ok(mut seen) => seen.insert(key),
        Err(_) => true,
    }
}

pub(crate) fn mesh_has_air_elements(mesh: &MeshIR) -> bool {
    mesh.element_markers
        .iter()
        .any(|&marker| marker == AIR_REGION_MARKER)
}

pub(crate) fn resolved_domain_mesh_mode(mesh: &MeshIR) -> FemDomainMeshModeIR {
    if mesh_has_air_elements(mesh) {
        FemDomainMeshModeIR::SharedDomainMeshWithAir
    } else {
        FemDomainMeshModeIR::MergedMagneticMesh
    }
}

pub(crate) fn build_mesh_parts_from_segments(
    mesh: &MeshIR,
    object_segments: &[FemObjectSegmentIR],
    _domain_mesh_mode: FemDomainMeshModeIR,
) -> Vec<FemMeshPartIR> {
    object_segments
        .iter()
        .map(|segment| {
            let role = if segment.object_id == AIR_OBJECT_SEGMENT_ID {
                FemMeshPartRole::Air
            } else {
                FemMeshPartRole::MagneticObject
            };
            let node_indices = if role == FemMeshPartRole::Air {
                explicit_node_indices_for_segment(mesh, segment)
            } else {
                Vec::new()
            };
            let bounds = if node_indices.is_empty() {
                compute_segment_bounds(mesh, segment)
            } else {
                mesh_bounds_from_node_indices(mesh, &node_indices)
            };
            let part_identity = segment
                .geometry_id
                .as_deref()
                .unwrap_or(segment.object_id.as_str());
            let label = if role == FemMeshPartRole::Air {
                "Airbox".to_string()
            } else {
                part_identity.to_string()
            };
            FemMeshPartIR {
                id: format!("part:{part_identity}"),
                label,
                role: role.clone(),
                object_id: match role {
                    FemMeshPartRole::MagneticObject => Some(segment.object_id.clone()),
                    _ => None,
                },
                geometry_id: segment.geometry_id.clone(),
                material_id: None,
                element_selector: FemMeshPartSelector::ElementRange {
                    start: segment.element_start,
                    count: segment.element_count,
                },
                boundary_face_selector: FemMeshPartSelector::BoundaryFaceRange {
                    start: segment.boundary_face_start,
                    count: segment.boundary_face_count,
                },
                node_selector: FemMeshPartSelector::NodeRange {
                    start: segment.node_start,
                    count: segment.node_count,
                },
                boundary_face_indices: Vec::new(),
                node_indices,
                surface_faces: Vec::new(),
                bounds_min: bounds.map(|(min, _)| min),
                bounds_max: bounds.map(|(_, max)| max),
                parent_id: None,
            }
        })
        .collect()
}

pub(crate) fn compute_segment_bounds(
    mesh: &MeshIR,
    segment: &FemObjectSegmentIR,
) -> Option<([f64; 3], [f64; 3])> {
    let start = segment.node_start as usize;
    let end = start + segment.node_count as usize;
    if start >= end || end > mesh.nodes.len() {
        return None;
    }

    let mut min = mesh.nodes[start];
    let mut max = mesh.nodes[start];
    for node in &mesh.nodes[start..end] {
        for axis in 0..3 {
            min[axis] = min[axis].min(node[axis]);
            max[axis] = max[axis].max(node[axis]);
        }
    }
    Some((min, max))
}

fn collect_element_node_indices(mesh: &MeshIR, element_start: u32, element_count: u32) -> Vec<u32> {
    let start = element_start as usize;
    let end = start
        .saturating_add(element_count as usize)
        .min(mesh.elements.len());
    if start >= end {
        return Vec::new();
    }

    let mut unique = BTreeSet::new();
    for element in &mesh.elements[start..end] {
        unique.insert(element[0]);
        unique.insert(element[1]);
        unique.insert(element[2]);
        unique.insert(element[3]);
    }
    unique.into_iter().collect()
}

fn node_indices_match_range(node_indices: &[u32], start: u32, count: u32) -> bool {
    if node_indices.len() != count as usize {
        return false;
    }
    node_indices
        .iter()
        .enumerate()
        .all(|(offset, index)| *index == start + offset as u32)
}

fn explicit_node_indices_for_segment(mesh: &MeshIR, segment: &FemObjectSegmentIR) -> Vec<u32> {
    let node_indices =
        collect_element_node_indices(mesh, segment.element_start, segment.element_count);
    if node_indices_match_range(&node_indices, segment.node_start, segment.node_count) {
        Vec::new()
    } else {
        node_indices
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedFemDomainMeshAsset {
    pub mesh: MeshIR,
    pub mesh_source: Option<String>,
    pub object_segments: Vec<FemObjectSegmentIR>,
    pub mesh_parts: Vec<FemMeshPartIR>,
}

#[derive(Debug, Clone)]
pub(crate) struct MagnetPlanningEntry {
    pub magnet_name: String,
    pub geometry_name: String,
    pub initial_magnetization: Option<InitialMagnetizationIR>,
}

pub(crate) fn initial_vectors_for_magnet(
    magnet_name: &str,
    mesh_name: &str,
    initial: Option<&InitialMagnetizationIR>,
    n_nodes: usize,
    sample_points_world: Option<&[[f64; 3]]>,
    sample_points_object: Option<&[[f64; 3]]>,
) -> Result<Vec<[f64; 3]>, String> {
    Ok(match initial {
        Some(InitialMagnetizationIR::Uniform { value }) => vec![*value; n_nodes],
        Some(InitialMagnetizationIR::RandomSeeded { seed }) => {
            generate_random_unit_vectors(*seed, n_nodes)
        }
        Some(InitialMagnetizationIR::SampledField { values }) => {
            if values.len() != n_nodes {
                return Err(format!(
                    "magnet '{}' sampled_field has {} vectors, but FEM mesh '{}' has {} nodes",
                    magnet_name,
                    values.len(),
                    mesh_name,
                    n_nodes
                ));
            }
            values.clone()
        }
        Some(InitialMagnetizationIR::PresetTexture {
            preset_kind,
            preset_params,
            mapping,
            texture_transform,
        }) => {
            let log_key = preset_texture_sample_log_key(
                magnet_name,
                mesh_name,
                n_nodes,
                preset_kind,
                preset_params,
                mapping,
                texture_transform,
            );
            if should_log_preset_texture_sample_once(log_key) {
                eprintln!(
                    "[fullmag-plan][mag-texture] sampling preset '{}' for magnet '{}' on mesh '{}' (nodes={}) mapping=({}/{}/{}) T=[{:+.3e},{:+.3e},{:+.3e}]m S=[{:+.3e},{:+.3e},{:+.3e}]",
                    preset_kind,
                    magnet_name,
                    mesh_name,
                    n_nodes,
                    mapping.space,
                    mapping.projection,
                    mapping.clamp_mode,
                    texture_transform.translation[0],
                    texture_transform.translation[1],
                    texture_transform.translation[2],
                    texture_transform.scale[0],
                    texture_transform.scale[1],
                    texture_transform.scale[2],
                );
            }
            let world = sample_points_world.ok_or_else(|| {
                format!(
                    "magnet '{}' uses preset_texture '{}' but planner was not given sample points for mesh '{}'",
                    magnet_name, preset_kind, mesh_name
                )
            })?;
            if world.len() != n_nodes {
                return Err(format!(
                    "magnet '{}' preset_texture '{}' expected {} sample points for mesh '{}', got {}",
                    magnet_name,
                    preset_kind,
                    n_nodes,
                    mesh_name,
                    world.len()
                ));
            }
            let object = sample_points_object.unwrap_or(world);
            if object.len() != n_nodes {
                return Err(format!(
                    "magnet '{}' preset_texture '{}' expected {} object-space points for mesh '{}', got {}",
                    magnet_name,
                    preset_kind,
                    n_nodes,
                    mesh_name,
                    object.len()
                ));
            }
            let points = world
                .iter()
                .zip(object.iter())
                .map(|(w, o)| TextureSamplePoint {
                    position_world: *w,
                    position_object: *o,
                    active: true,
                })
                .collect::<Vec<_>>();
            sample_preset_texture(
                preset_kind,
                &preset_params,
                mapping,
                texture_transform,
                &points,
            )?
        }
        None => vec![[1.0, 0.0, 0.0]; n_nodes],
    })
}

fn tet_faces(element: &[u32; 4]) -> [[u32; 3]; 4] {
    [
        [element[0], element[1], element[3]],
        [element[1], element[2], element[3]],
        [element[2], element[0], element[3]],
        [element[0], element[2], element[1]],
    ]
}

fn sorted_face_key(face: [u32; 3]) -> (u32, u32, u32) {
    let mut nodes = [face[0], face[1], face[2]];
    nodes.sort_unstable();
    (nodes[0], nodes[1], nodes[2])
}

fn canonical_coordinate_bits(value: f64) -> u64 {
    if value == 0.0 {
        0.0f64.to_bits()
    } else {
        value.to_bits()
    }
}

fn coordinate_key(point: [f64; 3]) -> [u64; 3] {
    [
        canonical_coordinate_bits(point[0]),
        canonical_coordinate_bits(point[1]),
        canonical_coordinate_bits(point[2]),
    ]
}

pub(crate) fn load_fem_domain_mesh_asset(asset: &FemDomainMeshAssetIR) -> Result<MeshIR, String> {
    match (&asset.mesh, &asset.mesh_source) {
        (Some(mesh), _) => Ok(mesh.clone()),
        (None, Some(source)) => load_mesh_from_source(source),
        (None, None) => {
            Err("fem_domain_mesh_asset requires an inline mesh or mesh_source".to_string())
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct SharedDomainAnalysis {
    pub node_owner: Vec<u32>,
    pub face_owner: BTreeMap<(u32, u32, u32), u32>,
    pub ordered_regions: Vec<SharedDomainRegionEntry>,
    pub shared_interface_nodes: Vec<(u32, Vec<u32>)>,
    pub interface_faces: Vec<SharedInterfaceFace>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SharedDomainRegionEntry {
    pub object_id: String,
    pub geometry_id: String,
    pub marker: u32,
}

#[derive(Debug, Clone)]
pub(crate) struct SharedInterfaceFace {
    pub face: [u32; 3],
    pub markers: Vec<u32>,
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn analyze_shared_domain_mesh(
    mesh: &MeshIR,
    region_markers: &[FemDomainRegionMarkerIR],
) -> Result<SharedDomainAnalysis, String> {
    let ordered_regions = region_markers
        .iter()
        .map(|region| SharedDomainRegionEntry {
            object_id: region.geometry_name.clone(),
            geometry_id: region.geometry_name.clone(),
            marker: region.marker,
        })
        .collect::<Vec<_>>();
    analyze_shared_domain_mesh_with_entries(mesh, ordered_regions)
}

fn analyze_shared_domain_mesh_with_entries(
    mesh: &MeshIR,
    ordered_regions: Vec<SharedDomainRegionEntry>,
) -> Result<SharedDomainAnalysis, String> {
    if ordered_regions.is_empty() {
        return Err(
            "fem_domain_mesh_asset.region_markers must describe at least one magnetic region"
                .to_string(),
        );
    }

    let marker_to_object = ordered_regions
        .iter()
        .map(|entry| (entry.marker, entry.object_id.clone()))
        .collect::<BTreeMap<_, _>>();

    for &marker in &mesh.element_markers {
        if marker != AIR_REGION_MARKER && !marker_to_object.contains_key(&marker) {
            return Err(format!(
                "shared-domain FEM mesh '{}' uses magnetic element marker {} without a region_markers entry",
                mesh.mesh_name, marker
            ));
        }
    }

    let mut node_marker_sets = vec![BTreeSet::<u32>::new(); mesh.nodes.len()];
    for (element_index, element) in mesh.elements.iter().enumerate() {
        let marker = mesh.element_markers[element_index];
        if marker == AIR_REGION_MARKER {
            continue;
        }
        for &node in element {
            if let Some(slot) = node_marker_sets.get_mut(node as usize) {
                slot.insert(marker);
            }
        }
    }

    let mut node_owner = vec![0u32; mesh.nodes.len()];
    let mut shared_interface_nodes: Vec<(u32, Vec<u32>)> = Vec::new();
    for (node_index, markers) in node_marker_sets.iter().enumerate() {
        if markers.is_empty() {
            continue;
        }
        node_owner[node_index] = *markers.iter().next().expect("non-empty set");
        if markers.len() > 1 {
            shared_interface_nodes.push((node_index as u32, markers.iter().copied().collect()));
        }
    }

    let mut face_markers = BTreeMap::<(u32, u32, u32), BTreeSet<u32>>::new();
    let mut all_face_markers = BTreeMap::<(u32, u32, u32), BTreeSet<u32>>::new();
    let mut representative_faces = BTreeMap::<(u32, u32, u32), [u32; 3]>::new();
    for (element_index, element) in mesh.elements.iter().enumerate() {
        let marker = mesh.element_markers[element_index];
        for face in tet_faces(element) {
            let key = sorted_face_key(face);
            all_face_markers.entry(key).or_default().insert(marker);
            representative_faces.entry(key).or_insert(face);
            if marker == AIR_REGION_MARKER {
                continue;
            }
            face_markers.entry(key).or_default().insert(marker);
        }
    }

    let mut face_owner = BTreeMap::<(u32, u32, u32), u32>::new();
    for (face_key, markers) in &face_markers {
        if markers.len() <= 1 {
            face_owner.insert(*face_key, markers.iter().copied().next().unwrap_or(0));
            continue;
        }
        face_owner.insert(*face_key, u32::MAX);
    }

    let interface_faces = all_face_markers
        .iter()
        .filter_map(|(face_key, markers)| {
            if markers.len() <= 1 {
                return None;
            }
            let mut ordered = markers.iter().copied().collect::<Vec<_>>();
            ordered.sort_unstable();
            representative_faces
                .get(face_key)
                .copied()
                .map(|face| SharedInterfaceFace {
                    face,
                    markers: ordered,
                })
        })
        .collect::<Vec<_>>();

    Ok(SharedDomainAnalysis {
        node_owner,
        face_owner,
        ordered_regions,
        shared_interface_nodes,
        interface_faces,
    })
}

pub(crate) fn validate_packing_constraints(
    analysis: &SharedDomainAnalysis,
    mesh_name: &str,
    solver_supports_conformal: bool,
) -> Result<(), String> {
    if !solver_supports_conformal && !analysis.shared_interface_nodes.is_empty() {
        return Err(format!(
            "shared-domain FEM mesh '{}' currently requires disjoint node ownership; {} interface nodes detected. This will be supported in a future release.",
            mesh_name,
            analysis.shared_interface_nodes.len()
        ));
    }
    Ok(())
}

fn mesh_bounds_from_node_indices(
    mesh: &MeshIR,
    node_indices: &[u32],
) -> Option<([f64; 3], [f64; 3])> {
    bounds_from_points(
        node_indices
            .iter()
            .filter_map(|index| mesh.nodes.get(*index as usize)),
    )
}

fn collect_boundary_face_node_indices(mesh: &MeshIR, boundary_face_indices: &[u32]) -> Vec<u32> {
    let mut unique = BTreeSet::new();
    for face_index in boundary_face_indices {
        let Some(face) = mesh.boundary_faces.get(*face_index as usize) else {
            continue;
        };
        unique.insert(face[0]);
        unique.insert(face[1]);
        unique.insert(face[2]);
    }
    unique.into_iter().collect()
}

pub(crate) fn pack_mesh_by_analysis(
    mesh: &MeshIR,
    analysis: &SharedDomainAnalysis,
) -> Result<(MeshIR, Vec<FemObjectSegmentIR>, Vec<FemMeshPartIR>), String> {
    let ordered_regions = &analysis.ordered_regions;
    let shared_markers_by_node = analysis
        .shared_interface_nodes
        .iter()
        .map(|(node_index, markers)| (*node_index as usize, markers.clone()))
        .collect::<BTreeMap<_, _>>();

    let mut reordered_nodes = Vec::with_capacity(mesh.nodes.len());
    let mut node_start_by_marker = BTreeMap::new();
    let mut node_count_by_marker = BTreeMap::new();
    let mut node_map_by_object = BTreeMap::<String, BTreeMap<usize, u32>>::new();
    let mut coordinate_map_by_object = BTreeMap::<String, BTreeMap<[u64; 3], u32>>::new();
    for entry in ordered_regions {
        let marker = entry.marker;
        node_start_by_marker.insert(marker, reordered_nodes.len() as u32);
        let object_node_map = node_map_by_object
            .entry(entry.object_id.clone())
            .or_default();
        let object_coordinate_map = coordinate_map_by_object
            .entry(entry.object_id.clone())
            .or_default();
        for (node_index, owner) in analysis.node_owner.iter().enumerate() {
            let shared_with_marker = shared_markers_by_node
                .get(&node_index)
                .map(|markers| markers.contains(&marker))
                .unwrap_or(false);
            if (*owner == marker || shared_with_marker)
                && !object_node_map.contains_key(&node_index)
            {
                let key = coordinate_key(mesh.nodes[node_index]);
                if let Some(existing_index) = object_coordinate_map.get(&key) {
                    object_node_map.insert(node_index, *existing_index);
                } else {
                    let new_index = reordered_nodes.len() as u32;
                    object_node_map.insert(node_index, new_index);
                    object_coordinate_map.insert(key, new_index);
                    reordered_nodes.push(mesh.nodes[node_index]);
                }
            }
        }
        let start = *node_start_by_marker
            .get(&marker)
            .expect("node_start inserted above");
        node_count_by_marker.insert(marker, reordered_nodes.len() as u32 - start);
    }
    let node_map_by_marker = ordered_regions
        .iter()
        .map(|entry| {
            (
                entry.marker,
                node_map_by_object
                    .get(&entry.object_id)
                    .cloned()
                    .unwrap_or_default(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut air_node_map = BTreeMap::<usize, u32>::new();
    for (node_index, owner) in analysis.node_owner.iter().enumerate() {
        if *owner == AIR_REGION_MARKER {
            air_node_map.insert(node_index, reordered_nodes.len() as u32);
            reordered_nodes.push(mesh.nodes[node_index]);
        }
    }

    let remap_node = |old_index: u32, owner_marker: u32| -> Result<u32, String> {
        let old_index = old_index as usize;
        if owner_marker == AIR_REGION_MARKER {
            if let Some(new_index) = air_node_map.get(&old_index) {
                return Ok(*new_index);
            }
            let fallback_marker = *analysis.node_owner.get(old_index).ok_or_else(|| {
                format!(
                    "shared-domain FEM mesh '{}' references node {} outside node_owner bounds",
                    mesh.mesh_name, old_index
                )
            })?;
            return node_map_by_marker
                .get(&fallback_marker)
                .and_then(|mapping| mapping.get(&old_index))
                .copied()
                .ok_or_else(|| {
                    format!(
                        "shared-domain FEM mesh '{}' is missing a magnetic remap for air-adjacent node {}",
                        mesh.mesh_name, old_index
                    )
                });
        }
        node_map_by_marker
            .get(&owner_marker)
            .and_then(|mapping| mapping.get(&old_index))
            .copied()
            .ok_or_else(|| {
                format!(
                    "shared-domain FEM mesh '{}' is missing a remap for node {} in marker {}",
                    mesh.mesh_name, old_index, owner_marker
                )
            })
    };

    let mut reordered_elements = Vec::with_capacity(mesh.elements.len());
    let mut reordered_markers = Vec::with_capacity(mesh.element_markers.len());
    let mut element_start_by_marker = BTreeMap::new();
    let mut element_count_by_marker = BTreeMap::new();
    for entry in ordered_regions {
        let marker = entry.marker;
        element_start_by_marker.insert(marker, reordered_elements.len() as u32);
        for (element_index, element) in mesh.elements.iter().enumerate() {
            if mesh.element_markers[element_index] != marker {
                continue;
            }
            reordered_elements.push([
                remap_node(element[0], marker)?,
                remap_node(element[1], marker)?,
                remap_node(element[2], marker)?,
                remap_node(element[3], marker)?,
            ]);
            reordered_markers.push(marker);
        }
        let start = *element_start_by_marker
            .get(&marker)
            .expect("element_start inserted above");
        element_count_by_marker.insert(marker, reordered_elements.len() as u32 - start);
    }
    for (element_index, element) in mesh.elements.iter().enumerate() {
        if mesh.element_markers[element_index] != 0 {
            continue;
        }
        reordered_elements.push([
            remap_node(element[0], 0)?,
            remap_node(element[1], 0)?,
            remap_node(element[2], 0)?,
            remap_node(element[3], 0)?,
        ]);
        reordered_markers.push(0);
    }

    let mut reordered_boundary_faces = Vec::with_capacity(mesh.boundary_faces.len());
    let mut reordered_boundary_markers = Vec::with_capacity(mesh.boundary_markers.len());
    let mut boundary_start_by_marker = BTreeMap::new();
    let mut boundary_count_by_marker = BTreeMap::new();
    for entry in ordered_regions {
        let marker = entry.marker;
        boundary_start_by_marker.insert(marker, reordered_boundary_faces.len() as u32);
        for (face_index, face) in mesh.boundary_faces.iter().enumerate() {
            let owner = analysis
                .face_owner
                .get(&sorted_face_key(*face))
                .copied()
                .unwrap_or(0);
            if owner != marker {
                continue;
            }
            reordered_boundary_faces.push([
                remap_node(face[0], marker)?,
                remap_node(face[1], marker)?,
                remap_node(face[2], marker)?,
            ]);
            reordered_boundary_markers.push(mesh.boundary_markers[face_index]);
        }
        let start = *boundary_start_by_marker
            .get(&marker)
            .expect("boundary_start inserted above");
        boundary_count_by_marker.insert(marker, reordered_boundary_faces.len() as u32 - start);
    }
    for (face_index, face) in mesh.boundary_faces.iter().enumerate() {
        let owner = analysis
            .face_owner
            .get(&sorted_face_key(*face))
            .copied()
            .unwrap_or(0);
        if owner != AIR_REGION_MARKER {
            continue;
        }
        reordered_boundary_faces.push([
            remap_node(face[0], 0)?,
            remap_node(face[1], 0)?,
            remap_node(face[2], 0)?,
        ]);
        reordered_boundary_markers.push(mesh.boundary_markers[face_index]);
    }

    let mut reordered_periodic_node_pairs = Vec::with_capacity(mesh.periodic_node_pairs.len());
    for (pair_index, pair) in mesh.periodic_node_pairs.iter().enumerate() {
        let owner_a = *analysis
            .node_owner
            .get(pair.node_a as usize)
            .ok_or_else(|| {
                format!(
                    "shared-domain FEM mesh '{}' periodic node pair {} references node {} outside node_owner bounds",
                    mesh.mesh_name, pair_index, pair.node_a
                )
            })?;
        let owner_b = *analysis
            .node_owner
            .get(pair.node_b as usize)
            .ok_or_else(|| {
                format!(
                    "shared-domain FEM mesh '{}' periodic node pair {} references node {} outside node_owner bounds",
                    mesh.mesh_name, pair_index, pair.node_b
                )
            })?;
        reordered_periodic_node_pairs.push(fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: pair.pair_id.clone(),
            node_a: remap_node(pair.node_a, owner_a)?,
            node_b: remap_node(pair.node_b, owner_b)?,
        });
    }

    let mut object_segments = ordered_regions
        .iter()
        .map(|entry| FemObjectSegmentIR {
            object_id: entry.object_id.clone(),
            geometry_id: Some(entry.geometry_id.clone()),
            node_start: *node_start_by_marker.get(&entry.marker).unwrap_or(&0),
            node_count: *node_count_by_marker.get(&entry.marker).unwrap_or(&0),
            element_start: *element_start_by_marker.get(&entry.marker).unwrap_or(&0),
            element_count: *element_count_by_marker.get(&entry.marker).unwrap_or(&0),
            boundary_face_start: *boundary_start_by_marker.get(&entry.marker).unwrap_or(&0),
            boundary_face_count: *boundary_count_by_marker.get(&entry.marker).unwrap_or(&0),
        })
        .collect::<Vec<_>>();
    let air_node_start = ordered_regions
        .last()
        .and_then(|entry| {
            node_start_by_marker
                .get(&entry.marker)
                .zip(node_count_by_marker.get(&entry.marker))
                .map(|(start, count)| start + count)
        })
        .unwrap_or(0);
    let air_element_start = ordered_regions
        .last()
        .and_then(|entry| {
            element_start_by_marker
                .get(&entry.marker)
                .zip(element_count_by_marker.get(&entry.marker))
                .map(|(start, count)| start + count)
        })
        .unwrap_or(0);
    let air_boundary_face_start = ordered_regions
        .last()
        .and_then(|entry| {
            boundary_start_by_marker
                .get(&entry.marker)
                .zip(boundary_count_by_marker.get(&entry.marker))
                .map(|(start, count)| start + count)
        })
        .unwrap_or(0);
    let air_node_count = reordered_nodes.len() as u32 - air_node_start;
    let air_element_count = reordered_elements.len() as u32 - air_element_start;
    let air_boundary_face_count = reordered_boundary_faces.len() as u32 - air_boundary_face_start;
    if air_node_count > 0 || air_element_count > 0 || air_boundary_face_count > 0 {
        object_segments.push(FemObjectSegmentIR {
            object_id: AIR_OBJECT_SEGMENT_ID.to_string(),
            geometry_id: None,
            node_start: air_node_start,
            node_count: air_node_count,
            element_start: air_element_start,
            element_count: air_element_count,
            boundary_face_start: air_boundary_face_start,
            boundary_face_count: air_boundary_face_count,
        });
    }

    let reordered_mesh = MeshIR {
        mesh_name: mesh.mesh_name.clone(),
        nodes: reordered_nodes,
        elements: reordered_elements,
        element_markers: reordered_markers,
        boundary_faces: reordered_boundary_faces,
        boundary_markers: reordered_boundary_markers,
        periodic_boundary_pairs: mesh.periodic_boundary_pairs.clone(),
        periodic_node_pairs: reordered_periodic_node_pairs,
        // Marker values are preserved during reorder — carry the quality map through.
        per_domain_quality: mesh.per_domain_quality.clone(),
    };
    reordered_mesh.validate().map_err(|errors| {
        format!(
            "shared-domain FEM mesh '{}' is invalid after segmentation: {}",
            mesh.mesh_name,
            errors.join("; ")
        )
    })?;
    let mut mesh_parts = build_mesh_parts_from_segments(
        &reordered_mesh,
        &object_segments,
        FemDomainMeshModeIR::SharedDomainMeshWithAir,
    );
    for (segment, part) in object_segments.iter().zip(mesh_parts.iter_mut()) {
        if part.role != FemMeshPartRole::MagneticObject {
            continue;
        }
        let node_indices = explicit_node_indices_for_segment(&reordered_mesh, segment);
        if node_indices.is_empty() {
            continue;
        }
        part.bounds_min =
            mesh_bounds_from_node_indices(&reordered_mesh, &node_indices).map(|(min, _)| min);
        part.bounds_max =
            mesh_bounds_from_node_indices(&reordered_mesh, &node_indices).map(|(_, max)| max);
        part.node_indices = node_indices;
    }

    let (outer_boundary_marker, _marker_source) = select_airbox_boundary_marker(&reordered_mesh);
    let outer_boundary_face_indices = reordered_mesh
        .boundary_markers
        .iter()
        .enumerate()
        .filter_map(|(index, marker)| (*marker == outer_boundary_marker).then_some(index as u32))
        .collect::<Vec<_>>();
    if !outer_boundary_face_indices.is_empty() {
        let node_indices =
            collect_boundary_face_node_indices(&reordered_mesh, &outer_boundary_face_indices);
        let bounds = mesh_bounds_from_node_indices(&reordered_mesh, &node_indices);
        mesh_parts.push(FemMeshPartIR {
            id: "part:outer_boundary".to_string(),
            label: "Outer Boundary".to_string(),
            role: FemMeshPartRole::OuterBoundary,
            object_id: None,
            geometry_id: None,
            material_id: None,
            element_selector: FemMeshPartSelector::ElementRange { start: 0, count: 0 },
            boundary_face_selector: FemMeshPartSelector::BoundaryFaceRange { start: 0, count: 0 },
            node_selector: FemMeshPartSelector::NodeRange { start: 0, count: 0 },
            boundary_face_indices: outer_boundary_face_indices,
            node_indices,
            surface_faces: Vec::new(),
            bounds_min: bounds.map(|(min, _)| min),
            bounds_max: bounds.map(|(_, max)| max),
            parent_id: Some(format!("part:{}", AIR_OBJECT_SEGMENT_ID)),
        });
    }

    let marker_to_label = analysis
        .ordered_regions
        .iter()
        .map(|entry| (entry.marker, entry.geometry_id.clone()))
        .collect::<BTreeMap<_, _>>();
    let marker_to_object_id = analysis
        .ordered_regions
        .iter()
        .map(|entry| (entry.marker, entry.object_id.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut interface_surface_faces = BTreeMap::<(u32, u32), Vec<[u32; 3]>>::new();
    let mut interface_node_sets = BTreeMap::<(u32, u32), BTreeSet<u32>>::new();
    for interface_face in &analysis.interface_faces {
        if interface_face.markers.len() < 2 {
            continue;
        }
        let mut pair = [interface_face.markers[0], interface_face.markers[1]];
        pair.sort_unstable();
        let pair_key = (pair[0], pair[1]);
        let preferred_marker = pair
            .iter()
            .copied()
            .find(|marker| *marker != AIR_REGION_MARKER)
            .unwrap_or(pair[0]);
        let remapped_face = [
            remap_node(interface_face.face[0], preferred_marker)?,
            remap_node(interface_face.face[1], preferred_marker)?,
            remap_node(interface_face.face[2], preferred_marker)?,
        ];
        interface_surface_faces
            .entry(pair_key)
            .or_default()
            .push(remapped_face);
        let node_set = interface_node_sets.entry(pair_key).or_default();
        node_set.insert(remapped_face[0]);
        node_set.insert(remapped_face[1]);
        node_set.insert(remapped_face[2]);
    }

    for ((left_marker, right_marker), surface_faces) in interface_surface_faces {
        if surface_faces.is_empty() {
            continue;
        }
        let left_label = if left_marker == AIR_REGION_MARKER {
            "Air".to_string()
        } else {
            marker_to_label
                .get(&left_marker)
                .cloned()
                .unwrap_or_else(|| format!("marker_{left_marker}"))
        };
        let right_label = if right_marker == AIR_REGION_MARKER {
            "Air".to_string()
        } else {
            marker_to_label
                .get(&right_marker)
                .cloned()
                .unwrap_or_else(|| format!("marker_{right_marker}"))
        };
        let node_indices = interface_node_sets
            .remove(&(left_marker, right_marker))
            .map(|set| set.into_iter().collect::<Vec<_>>())
            .unwrap_or_default();
        let bounds = mesh_bounds_from_node_indices(&reordered_mesh, &node_indices);
        let owning_object_id =
            interface_air_magnetic_owner_id(left_marker, right_marker, &marker_to_object_id);
        mesh_parts.push(FemMeshPartIR {
            id: format!("part:interface:{left_marker}:{right_marker}"),
            label: format!("{left_label} ↔ {right_label}"),
            role: FemMeshPartRole::Interface,
            object_id: owning_object_id.clone(),
            geometry_id: owning_object_id.clone(),
            material_id: None,
            element_selector: FemMeshPartSelector::ElementRange { start: 0, count: 0 },
            boundary_face_selector: FemMeshPartSelector::BoundaryFaceRange { start: 0, count: 0 },
            node_selector: FemMeshPartSelector::NodeRange { start: 0, count: 0 },
            boundary_face_indices: Vec::new(),
            node_indices,
            surface_faces,
            bounds_min: bounds.map(|(min, _)| min),
            bounds_max: bounds.map(|(_, max)| max),
            parent_id: owning_object_id.map(|object_id| format!("part:{object_id}")),
        });
    }

    Ok((reordered_mesh, object_segments, mesh_parts))
}

fn interface_air_magnetic_owner_id(
    left_marker: u32,
    right_marker: u32,
    marker_to_label: &BTreeMap<u32, String>,
) -> Option<String> {
    if left_marker != AIR_REGION_MARKER && right_marker != AIR_REGION_MARKER {
        let left_owner = marker_to_label.get(&left_marker)?;
        let right_owner = marker_to_label.get(&right_marker)?;
        if left_owner == right_owner {
            return Some(left_owner.clone());
        }
        return None;
    }
    let magnetic_marker = match (
        left_marker == AIR_REGION_MARKER,
        right_marker == AIR_REGION_MARKER,
    ) {
        (true, false) => right_marker,
        (false, true) => left_marker,
        _ => return None,
    };
    marker_to_label.get(&magnetic_marker).cloned()
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn reorder_shared_domain_mesh(
    mesh: &MeshIR,
    region_markers: &[FemDomainRegionMarkerIR],
    solver_supports_conformal: bool,
) -> Result<(MeshIR, Vec<FemObjectSegmentIR>, Vec<FemMeshPartIR>), String> {
    let analysis = analyze_shared_domain_mesh(mesh, region_markers)?;
    validate_packing_constraints(&analysis, &mesh.mesh_name, solver_supports_conformal)?;
    pack_mesh_by_analysis(mesh, &analysis)
}

fn shared_domain_region_entries_for_problem(
    mesh: &MeshIR,
    problem: &ProblemIR,
    asset: &FemDomainMeshAssetIR,
) -> Vec<SharedDomainRegionEntry> {
    let object_id_for_geometry = |geometry_name: &str| {
        problem
            .regions
            .iter()
            .find(|region| region.geometry == geometry_name)
            .and_then(|region| {
                problem
                    .magnets
                    .iter()
                    .find(|magnet| magnet.region == region.name)
            })
            .map(|magnet| magnet.name.clone())
            .unwrap_or_else(|| geometry_name.to_string())
    };
    let mut entries = asset
        .region_markers
        .iter()
        .map(|region| SharedDomainRegionEntry {
            object_id: object_id_for_geometry(&region.geometry_name),
            geometry_id: region.geometry_name.clone(),
            marker: region.marker,
        })
        .collect::<Vec<_>>();

    let mesh_markers = mesh
        .element_markers
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    for marker in &asset.object_region_markers {
        if !mesh_markers.contains(&marker.marker) {
            continue;
        }
        let Some(region) = problem.object_regions.iter().find(|region| {
            region.enabled
                && (marker.geometry_name == region.region_id || marker.geometry_name == region.name)
        }) else {
            continue;
        };
        entries.push(SharedDomainRegionEntry {
            object_id: region.owner_object.clone(),
            geometry_id: marker.geometry_name.clone(),
            marker: marker.marker,
        });
    }
    entries
}

pub(crate) fn resolve_fem_domain_mesh_asset(
    problem: &ProblemIR,
    solver_supports_conformal: bool,
) -> Result<Option<ResolvedFemDomainMeshAsset>, String> {
    let Some(asset) = problem
        .geometry_assets
        .as_ref()
        .and_then(|assets| assets.fem_domain_mesh_asset.as_ref())
    else {
        return Ok(None);
    };
    let mesh = load_fem_domain_mesh_asset(asset)?;
    let region_entries = shared_domain_region_entries_for_problem(&mesh, problem, asset);
    let analysis = analyze_shared_domain_mesh_with_entries(&mesh, region_entries)?;
    validate_packing_constraints(&analysis, &mesh.mesh_name, solver_supports_conformal)?;
    let (mesh, object_segments, mesh_parts) = pack_mesh_by_analysis(&mesh, &analysis)?;
    Ok(Some(ResolvedFemDomainMeshAsset {
        mesh,
        mesh_source: asset.mesh_source.clone(),
        object_segments,
        mesh_parts,
    }))
}

pub(crate) fn bounds_from_points<'a, I>(points: I) -> Option<([f64; 3], [f64; 3])>
where
    I: IntoIterator<Item = &'a [f64; 3]>,
{
    let mut iter = points.into_iter();
    let first = iter.next()?;
    let mut mins = *first;
    let mut maxs = *first;
    for point in iter {
        for axis in 0..3 {
            mins[axis] = mins[axis].min(point[axis]);
            maxs[axis] = maxs[axis].max(point[axis]);
        }
    }
    Some((mins, maxs))
}

pub(crate) fn mesh_bounds(mesh: &MeshIR) -> Option<([f64; 3], [f64; 3])> {
    bounds_from_points(mesh.nodes.iter())
}

pub(crate) fn magnetic_bounds(mesh: &MeshIR) -> Option<([f64; 3], [f64; 3])> {
    if mesh.nodes.is_empty() {
        return None;
    }
    if mesh.elements.is_empty() {
        return mesh_bounds(mesh);
    }

    let use_markers = mesh.element_markers.len() == mesh.elements.len();
    let mut used_nodes = vec![false; mesh.nodes.len()];
    let mut has_magnetic_elements = false;

    for (element_index, element) in mesh.elements.iter().enumerate() {
        let is_magnetic = if use_markers {
            mesh.element_markers[element_index] != 0
        } else {
            true
        };
        if !is_magnetic {
            continue;
        }
        has_magnetic_elements = true;
        for &node_index in element {
            if let Some(slot) = used_nodes.get_mut(node_index as usize) {
                *slot = true;
            }
        }
    }

    if !has_magnetic_elements {
        return None;
    }

    bounds_from_points(mesh.nodes.iter().enumerate().filter_map(|(index, point)| {
        used_nodes
            .get(index)
            .copied()
            .unwrap_or(false)
            .then_some(point)
    }))
}

fn extent_from_bounds(bounds: ([f64; 3], [f64; 3])) -> [f64; 3] {
    let (mins, maxs) = bounds;
    [
        (maxs[0] - mins[0]).max(0.0),
        (maxs[1] - mins[1]).max(0.0),
        (maxs[2] - mins[2]).max(0.0),
    ]
}

fn select_airbox_boundary_marker(mesh: &MeshIR) -> (u32, &'static str) {
    if mesh
        .boundary_markers
        .iter()
        .any(|&marker| marker == AIRBOX_DEFAULT_BOUNDARY_MARKER)
    {
        (AIRBOX_DEFAULT_BOUNDARY_MARKER, "mesh_marker_99")
    } else {
        let max = mesh
            .boundary_markers
            .iter()
            .copied()
            .filter(|&marker| marker > 0 && marker != MAG_AIR_INTERFACE_MARKER)
            .max();
        match max {
            Some(m) => (m, "mesh_max_marker"),
            None => (AIRBOX_DEFAULT_BOUNDARY_MARKER, "fallback_99"),
        }
    }
}

fn derive_air_box_factor(mesh: &MeshIR, study_universe: Option<&StudyUniverseMetadata>) -> f64 {
    let Some(magnetic) = magnetic_bounds(mesh) else {
        return 0.0;
    };
    let magnetic_extent = extent_from_bounds(magnetic);

    let factor_from_extent = |candidate: [f64; 3]| -> Option<f64> {
        let mut factor: f64 = 0.0;
        let mut saw_axis = false;
        for axis in 0..3 {
            let magnetic_axis = magnetic_extent[axis];
            if magnetic_axis <= 0.0 {
                continue;
            }
            factor = factor.max(candidate[axis] / magnetic_axis);
            saw_axis = true;
        }
        saw_axis.then_some(factor)
    };

    if let Some(universe) = study_universe {
        if universe.mode == "manual" {
            if let Some(size) = universe.size {
                if let Some(factor) = factor_from_extent(size) {
                    return factor.max(0.0);
                }
            }
        }

        if universe.padding.iter().any(|component| *component > 0.0) {
            let padded = [
                magnetic_extent[0] + 2.0 * universe.padding[0],
                magnetic_extent[1] + 2.0 * universe.padding[1],
                magnetic_extent[2] + 2.0 * universe.padding[2],
            ];
            if let Some(factor) = factor_from_extent(padded) {
                return factor.max(0.0);
            }
        }
    }

    let Some(full_mesh_bounds) = mesh_bounds(mesh) else {
        return 0.0;
    };
    factor_from_extent(extent_from_bounds(full_mesh_bounds))
        .unwrap_or(0.0)
        .max(0.0)
}

pub(crate) fn build_air_box_config(
    problem: &ProblemIR,
    mesh: &MeshIR,
    resolved_demag_realization: Option<fullmag_ir::ResolvedFemDemagIR>,
) -> Result<Option<AirBoxConfigIR>, String> {
    if !mesh_has_air_elements(mesh) {
        return Ok(None);
    }

    let bc_kind = match resolved_demag_realization {
        Some(fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet) => "dirichlet",
        Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin) => "robin",
        // Non-airbox models (BEM/FK/FMM) don't need an air-box config.
        Some(r) if !r.requires_airbox() => return Ok(None),
        _ => return Ok(None),
    };

    let policy = problem.air_box_policy.as_ref();

    let study_universe = study_universe_metadata(problem);
    let factor = derive_air_box_factor(mesh, study_universe.as_ref());
    let factor_source = if study_universe.is_some() {
        "study_universe"
    } else {
        "mesh_auto"
    };

    let explicit_policy_marker = policy.and_then(|p| p.boundary_marker);
    let (boundary_marker, boundary_marker_source): (u32, &'static str) = if let Some(marker) =
        explicit_policy_marker
    {
        if !mesh.boundary_markers.iter().any(|&value| value == marker) {
            return Err(format!(
                    "air_box_policy.boundary_marker={} is not present in mesh '{}' boundary markers; provide a marker that exists on outer air-box faces",
                    marker,
                    mesh.mesh_name
                ));
        }
        (marker, "user_policy")
    } else if problem.validation_profile.execution_mode == ExecutionMode::Strict {
        // In strict mode, allow auto-detection only when the well-known
        // boundary marker 99 is explicitly present (set by the mesh
        // generator for the outer air-box surface). Any other heuristic
        // is rejected — the user must provide an explicit policy marker.
        let (detected_marker, detected_source) = select_airbox_boundary_marker(mesh);
        if detected_source == "mesh_marker_99" {
            (detected_marker, detected_source)
        } else {
            return Err(
                "strict execution mode requires an explicit air_box_policy.boundary_marker for FEM air-box demag; planner no longer guesses boundary markers".to_string()
            );
        }
    } else {
        select_airbox_boundary_marker(mesh)
    };

    let grading = policy
        .and_then(|p| p.grading)
        .unwrap_or(AIRBOX_DEFAULT_GRADING);
    let shape = policy
        .and_then(|p| p.shape.clone())
        .unwrap_or_else(|| AIRBOX_DEFAULT_SHAPE.to_string());

    let robin_beta_mode = if bc_kind == "robin" {
        Some(
            policy
                .and_then(|p| p.robin_beta_mode.clone())
                .unwrap_or_else(|| AIRBOX_DEFAULT_ROBIN_BETA_MODE.to_string()),
        )
    } else {
        None
    };
    let robin_beta_factor = if bc_kind == "robin" {
        Some(
            policy
                .and_then(|p| p.robin_beta_factor)
                .unwrap_or(AIRBOX_DEFAULT_ROBIN_BETA_FACTOR),
        )
    } else {
        None
    };

    Ok(Some(AirBoxConfigIR {
        factor,
        grading,
        boundary_marker,
        bc_kind: Some(bc_kind.to_string()),
        robin_beta_mode,
        robin_beta_factor,
        shape: Some(shape),
        factor_source: Some(factor_source.to_string()),
        boundary_marker_source: Some(boundary_marker_source.to_string()),
    }))
}

pub(crate) fn study_universe_planner_note(
    problem: &ProblemIR,
    _mesh: &MeshIR,
    _resolved_demag_realization: Option<fullmag_ir::ResolvedFemDemagIR>,
    air_box_config: Option<&AirBoxConfigIR>,
) -> Option<String> {
    let study_universe = study_universe_metadata(problem)?;
    if let Some(config) = air_box_config {
        let airbox_hmax_note = study_universe
            .airbox_hmax
            .map(|value| format!(", airbox_hmax={value:.3e}"))
            .unwrap_or_default();
        return Some(format!(
            "study_universe lowered to FEM air-box configuration (mode={}, center=[{:.3e}, {:.3e}, {:.3e}], factor={:.3}, boundary_marker={}{})",
            study_universe.mode,
            study_universe.center[0],
            study_universe.center[1],
            study_universe.center[2],
            config.factor,
            config.boundary_marker,
            airbox_hmax_note,
        ));
    }

    if problem.magnets.len() > 1 {
        return Some(
            "study_universe metadata present, but this planner-only FEM path still requires a materialized shared-domain mesh asset to carry the air-box into the solver; interactive/runtime materialization normally attaches that conformal domain mesh before execution"
                .to_string(),
        );
    }

    Some(
        "study_universe metadata present, but the selected FEM mesh has no air elements; solver domain remains magnetic until a shared-domain air-box mesh asset is materialized or attached"
            .to_string(),
    )
}

pub(crate) fn load_mesh_from_source(source: &str) -> Result<MeshIR, String> {
    let path = Path::new(source);
    let suffix = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    match suffix.as_str() {
        "json" => {
            let payload = fs::read_to_string(path)
                .map_err(|err| format!("failed to read FEM mesh_source '{}': {}", source, err))?;
            let mesh: MeshIR = serde_json::from_str(&payload)
                .map_err(|err| format!("failed to parse FEM mesh_source '{}': {}", source, err))?;
            mesh.validate().map_err(|errors| {
                format!(
                    "mesh_source '{}' is invalid: {}",
                    source,
                    errors.join("; ")
                )
            })?;
            Ok(mesh)
        }
        other => Err(format!(
            "unsupported FEM mesh_source format '{}'; current lazy FEM planner supports only .json mesh assets",
            if other.is_empty() { "<none>" } else { other }
        )),
    }
}

pub(crate) fn compatible_fem_material(
    a: &fullmag_ir::MaterialIR,
    b: &fullmag_ir::MaterialIR,
) -> bool {
    a.saturation_magnetisation == b.saturation_magnetisation
        && a.exchange_stiffness == b.exchange_stiffness
        && a.damping == b.damping
        && a.uniaxial_anisotropy == b.uniaxial_anisotropy
        && a.anisotropy_axis == b.anisotropy_axis
}

fn merged_fem_element_markers(mesh: &MeshIR) -> Result<Vec<u32>, String> {
    let has_marker_one = mesh.element_markers.iter().any(|&marker| marker == 1);
    if has_marker_one {
        return Ok(mesh.element_markers.clone());
    }

    let distinct = mesh
        .element_markers
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    if distinct.len() <= 1 {
        return Ok(vec![1; mesh.element_markers.len()]);
    }

    Err(format!(
        "mesh '{}' does not mark magnetic elements with marker=1 and uses multiple element markers {:?}; current multi-body FEM merge baseline cannot infer magnetic ownership safely",
        mesh.mesh_name,
        distinct
    ))
}

pub(crate) fn merge_fem_meshes(
    meshes: &[(String, MeshIR)],
) -> Result<(MeshIR, Vec<FemObjectSegmentIR>), String> {
    if meshes.is_empty() {
        return Err("cannot merge zero FEM meshes".to_string());
    }
    if meshes.len() == 1 {
        let mesh = meshes[0].1.clone();
        let segment = FemObjectSegmentIR {
            object_id: meshes[0].0.clone(),
            geometry_id: Some(meshes[0].0.clone()),
            node_start: 0,
            node_count: mesh.nodes.len() as u32,
            element_start: 0,
            element_count: mesh.elements.len() as u32,
            boundary_face_start: 0,
            boundary_face_count: mesh.boundary_faces.len() as u32,
        };
        return Ok((mesh, vec![segment]));
    }

    let merged_name = meshes
        .iter()
        .map(|(magnet_name, _)| magnet_name.as_str())
        .collect::<Vec<_>>()
        .join("__");

    let mut nodes = Vec::new();
    let mut elements = Vec::new();
    let mut element_markers = Vec::new();
    let mut boundary_faces = Vec::new();
    let mut boundary_markers = Vec::new();
    let mut object_segments = Vec::with_capacity(meshes.len());

    let mut node_offset = 0u32;
    for (object_id, mesh) in meshes {
        let node_start = node_offset;
        let element_start = elements.len() as u32;
        let boundary_face_start = boundary_faces.len() as u32;
        let remapped_markers = merged_fem_element_markers(mesh)?;
        nodes.extend(mesh.nodes.iter().copied());
        elements.extend(mesh.elements.iter().map(|element| {
            [
                element[0] + node_offset,
                element[1] + node_offset,
                element[2] + node_offset,
                element[3] + node_offset,
            ]
        }));
        element_markers.extend(remapped_markers);
        boundary_faces.extend(mesh.boundary_faces.iter().map(|face| {
            [
                face[0] + node_offset,
                face[1] + node_offset,
                face[2] + node_offset,
            ]
        }));
        boundary_markers.extend(mesh.boundary_markers.iter().copied());
        object_segments.push(FemObjectSegmentIR {
            object_id: object_id.clone(),
            geometry_id: Some(object_id.clone()),
            node_start,
            node_count: mesh.nodes.len() as u32,
            element_start,
            element_count: mesh.elements.len() as u32,
            boundary_face_start,
            boundary_face_count: mesh.boundary_faces.len() as u32,
        });
        node_offset += mesh.nodes.len() as u32;
    }

    // Carry forward per-domain quality from each sub-mesh.  The element
    // markers of individual meshes are remapped to 1 by merged_fem_element_markers,
    // so we re-key per_domain_quality entries under marker=1.  When multiple
    // sub-meshes each have a marker=1 quality entry we keep only the first one
    // (a best-effort heuristic — the downstream consumer can recompute if needed).
    let mut merged_quality: HashMap<u32, MeshQualityIR> = HashMap::new();
    for (_object_id, mesh) in meshes {
        for (marker, quality) in &mesh.per_domain_quality {
            // After merge, all non-zero markers are normalised to 1.
            let target_key = if *marker == AIR_REGION_MARKER { 0 } else { 1 };
            merged_quality
                .entry(target_key)
                .or_insert_with(|| quality.clone());
        }
    }

    let merged = MeshIR {
        mesh_name: format!("multibody_{merged_name}"),
        nodes,
        elements,
        element_markers,
        boundary_faces,
        boundary_markers,
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: merged_quality,
    };
    merged.validate().map_err(|errors| {
        format!(
            "merged multi-body FEM mesh is invalid: {}",
            errors.join("; ")
        )
    })?;
    Ok((merged, object_segments))
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{TextureMappingIR, TextureTransform3DIR};

    #[test]
    fn preset_texture_sampling_log_key_tracks_mesh_and_texture_identity() {
        let mapping = TextureMappingIR::default();
        let transform = TextureTransform3DIR::default();
        let mut params = BTreeMap::new();
        params.insert("radius".to_string(), serde_json::json!(3.0e-7));

        let key = preset_texture_sample_log_key(
            "arch_waveguide",
            "study_domain",
            9500,
            "neel_skyrmion",
            &params,
            &mapping,
            &transform,
        );
        assert_eq!(
            key,
            preset_texture_sample_log_key(
                "arch_waveguide",
                "study_domain",
                9500,
                "neel_skyrmion",
                &params,
                &mapping,
                &transform,
            )
        );
        assert_ne!(
            key,
            preset_texture_sample_log_key(
                "arch_waveguide",
                "study_domain",
                9501,
                "neel_skyrmion",
                &params,
                &mapping,
                &transform,
            )
        );

        let once_key = format!("preset-texture-log-dedup-test-{}", std::process::id());
        assert!(should_log_preset_texture_sample_once(once_key.clone()));
        assert!(!should_log_preset_texture_sample_once(once_key));
    }
}
