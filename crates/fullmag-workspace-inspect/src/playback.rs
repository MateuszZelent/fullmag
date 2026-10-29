//! Read-only access to explicitly published saved-result playback arrays.
//!
//! `playback.json` is the only discovery marker. This module reads bounded
//! manifests and Zarr metadata when listing playback, and reads one bounded
//! array chunk only when the caller requests a frame.

use std::collections::HashSet;
use std::fs::{self, File, Metadata};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use fullmag_session::solution_field_geometry::{
    parse_saved_fem_p1_geometry, SavedFemP1FieldGeometry, SavedFieldGeometryRef,
    FEM_P1_GEOMETRY_SCHEMA, MAX_FEM_P1_GEOMETRY_BYTES,
};

pub const SAVED_PLAYBACK_SCHEMA: &str = "fullmag.saved_playback.v1";
const PLAYBACK_FILE: &str = "playback.json";
const MAX_PLAYBACK_BYTES: u64 = 16 * 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 1024 * 1024;
const MAX_STAGES: usize = 64;
const MAX_FRAMES: usize = 100_000;
const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
const F64_BYTES: usize = std::mem::size_of::<f64>();

/// The small JSON read model for a completed saved-result playback.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct SavedPlaybackResource {
    pub schema: String,
    /// SHA-256 identity of the sidecar and all playback array metadata.
    pub revision: String,
    pub name: String,
    /// Optional publication context, for example why run provenance is absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grid_cells_xyz: Option<[usize; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell_size_m: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_m: Option<[f64; 3]>,
    /// Canonical FEM P1 mesh metadata. The heavy mesh and active-node mask
    /// remain behind the revision-pinned binary geometry endpoint.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_mesh: Option<SavedPlaybackFemMesh>,
    pub stages: Vec<SavedPlaybackStage>,
}

/// Bounded, JSON-only metadata for a saved FEM P1 playback mesh.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct SavedPlaybackFemMesh {
    pub node_count: usize,
    pub cell_count: usize,
    pub facet_count: usize,
    pub geometry_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topology_byte_length: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topology_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub support_byte_length: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub support_sha256: Option<String>,
}

/// The parsed canonical geometry associated with a playback descriptor.
///
/// This is intentionally not serialized as part of [`SavedPlaybackResource`];
/// API callers use it to derive the existing FMMT/FMSP binary payloads without
/// putting mesh arrays on the JSON control plane.
#[derive(Debug, Clone)]
pub struct SavedPlaybackInspection {
    pub resource: SavedPlaybackResource,
    pub fem_geometry: Option<SavedFemP1FieldGeometry>,
}

/// One stage in a saved playback resource.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct SavedPlaybackStage {
    pub stage_id: String,
    pub frame_count: usize,
    pub times_s: Vec<f64>,
    pub quantity_ids: Vec<String>,
}

/// Failures from a saved-playback read, kept typed for API status mapping.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlaybackError {
    /// The registered result, selected stage, frame, or required file is gone.
    NotFound(&'static str),
    /// This result has no supported playback descriptor.
    Unsupported(&'static str),
    /// A sidecar, array, path, or frame violates the saved-playback contract.
    Invalid(String),
    /// The caller supplied a revision that no longer identifies this source.
    StaleRevision,
    /// A source changed while it was being read.
    SourceChanged,
    /// A filesystem operation failed for a reason other than a missing path.
    Io(&'static str),
}

impl std::fmt::Display for PlaybackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(what) => write!(f, "saved playback {what} was not found"),
            Self::Unsupported(what) => write!(f, "saved playback is unsupported: {what}"),
            Self::Invalid(message) => write!(f, "invalid saved playback: {message}"),
            Self::StaleRevision => f.write_str("saved playback revision is stale"),
            Self::SourceChanged => f.write_str("saved playback source changed during the read"),
            Self::Io(what) => write!(f, "could not read saved playback {what}"),
        }
    }
}

impl std::error::Error for PlaybackError {}

#[derive(Debug, Deserialize)]
struct PlaybackSidecar {
    schema: String,
    complete: bool,
    name: String,
    #[serde(default)]
    source_note: Option<String>,
    #[serde(default)]
    grid_cells_xyz: Option<[usize; 3]>,
    #[serde(default)]
    cell_size_m: Option<[f64; 3]>,
    #[serde(default)]
    origin_m: Option<[f64; 3]>,
    #[serde(default)]
    fem_mesh: Option<PlaybackFemMeshSidecar>,
    stages: Vec<PlaybackSidecarStage>,
}

#[derive(Debug, Deserialize)]
struct PlaybackFemMeshSidecar {
    geometry_path: String,
    geometry_sha256: String,
}

#[derive(Debug, Deserialize)]
struct PlaybackSidecarStage {
    stage_id: String,
    array_path: String,
    times_s: Vec<f64>,
    quantity_ids: Vec<String>,
    /// Required for FEM because a flat 3*N payload is ambiguous without an
    /// explicit node-major/component-major declaration.
    #[serde(default)]
    field_layout: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FemFieldLayout {
    AosNodeMajor,
    SoaComponentMajor,
}

impl FemFieldLayout {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "aos_node_major" => Some(Self::AosNodeMajor),
            "soa_component_major" => Some(Self::SoaComponentMajor),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
struct ArrayMetadata {
    frame_count: usize,
    frame_bytes: usize,
    dimension_separator: char,
    chunk_rank: usize,
    fem_layout: Option<FemFieldLayout>,
    node_count: usize,
}

#[derive(Debug, Clone)]
struct LoadedStage {
    resource: SavedPlaybackStage,
    array_path: PathBuf,
    metadata: ArrayMetadata,
}

#[derive(Debug)]
struct LoadedPlayback {
    resource: SavedPlaybackResource,
    stages: Vec<LoadedStage>,
    fem_geometry: Option<SavedFemP1FieldGeometry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileIdentity {
    length: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

/// Read and validate the playback manifest and all referenced Zarr metadata.
/// No field chunks are opened by this function.
pub fn read_playback(root: &Path) -> Result<SavedPlaybackResource, PlaybackError> {
    Ok(load_playback(root)?.resource)
}

/// Probe only the bounded playback descriptor used for result-folder
/// discovery. This deliberately does not open FEM geometry, Zarr metadata,
/// stage manifests, or field chunks; explicit playback metadata/frame/geometry
/// requests still perform the complete validation in [`read_playback`].
pub(crate) fn probe_playback(root: &Path) -> Result<(), PlaybackError> {
    let root = canonical_root(root)?;
    let _ = read_playback_sidecar_at(&root)?;
    Ok(())
}

/// Read playback metadata together with its already-validated canonical FEM
/// geometry. The geometry is kept out of the serialized resource so callers
/// can derive binary topology/support payloads without a second unpinned read.
pub fn read_playback_with_geometry(
    root: &Path,
) -> Result<SavedPlaybackInspection, PlaybackError> {
    let loaded = load_playback(root)?;
    Ok(SavedPlaybackInspection {
        resource: loaded.resource,
        fem_geometry: loaded.fem_geometry,
    })
}

/// Read the revision-pinned canonical FEM geometry for a playback descriptor.
/// The descriptor and geometry are validated again after the read, so callers
/// never receive a body assembled from a folder that changed mid-request.
pub fn read_playback_geometry(
    root: &Path,
    revision: &str,
) -> Result<SavedFemP1FieldGeometry, PlaybackError> {
    let root = canonical_root(root)?;
    let before = load_playback_at(&root)?;
    if before.resource.revision != revision {
        return Err(PlaybackError::StaleRevision);
    }
    let geometry = before
        .fem_geometry
        .ok_or(PlaybackError::Unsupported("playback has no FEM mesh geometry"))?;
    match load_playback_at(&root) {
        Ok(after) if after.resource.revision == before.resource.revision => Ok(geometry),
        _ => Err(PlaybackError::SourceChanged),
    }
}

/// Read one complete little-endian f64 AoS frame after checking its manifest
/// revision both before and after reading the selected chunk.
pub fn read_playback_frame(
    root: &Path,
    stage_id: &str,
    frame_index: usize,
    revision: &str,
) -> Result<Vec<u8>, PlaybackError> {
    let root = canonical_root(root)?;
    let before = load_playback_at(&root)?;
    if before.resource.revision != revision {
        return Err(PlaybackError::StaleRevision);
    }
    let stage = before
        .stages
        .iter()
        .find(|stage| stage.resource.stage_id == stage_id)
        .ok_or(PlaybackError::NotFound("stage"))?;
    if frame_index >= stage.metadata.frame_count {
        return Err(PlaybackError::NotFound("frame"));
    }

    let chunk_name = match (stage.metadata.dimension_separator, stage.metadata.chunk_rank) {
        ('.', 2) => format!("{frame_index}.0"),
        ('/', 2) => format!("{frame_index}/0"),
        ('.', 3) => format!("{frame_index}.0.0"),
        ('/', 3) => format!("{frame_index}/0/0"),
        _ => unreachable!("validated Zarr separator and chunk rank"),
    };
    let chunk_path = stage.array_path.join(chunk_name);
    let bytes = read_exact_binary(&root, &chunk_path, stage.metadata.frame_bytes)?;
    validate_frame_values(&bytes)?;
    let bytes = normalize_frame_layout(bytes, &stage.metadata)?;

    // Re-read the sidecar and every .zarray after the payload read. Any
    // failure here means the selected source could not be proven stable.
    match load_playback_at(&root) {
        Ok(after) if after.resource.revision == before.resource.revision => Ok(bytes),
        _ => Err(PlaybackError::SourceChanged),
    }
}

fn normalize_frame_layout(
    bytes: Vec<u8>,
    metadata: &ArrayMetadata,
) -> Result<Vec<u8>, PlaybackError> {
    let Some(layout) = metadata.fem_layout else {
        return Ok(bytes);
    };
    if layout == FemFieldLayout::AosNodeMajor {
        return Ok(bytes);
    }
    let node_count = metadata.node_count;
    let expected_values = node_count
        .checked_mul(3)
        .ok_or_else(|| PlaybackError::Invalid("FEM vector length overflows".into()))?;
    let expected_bytes = expected_values
        .checked_mul(F64_BYTES)
        .ok_or_else(|| PlaybackError::Invalid("FEM frame byte length overflows".into()))?;
    if bytes.len() != expected_bytes {
        return Err(PlaybackError::Invalid(
            "FEM frame has an unexpected component-major length".into(),
        ));
    }
    let mut normalized = vec![0_u8; bytes.len()];
    for node in 0..node_count {
        for component in 0..3 {
            let source = (component * node_count + node) * F64_BYTES;
            let target = (node * 3 + component) * F64_BYTES;
            normalized[target..target + F64_BYTES]
                .copy_from_slice(&bytes[source..source + F64_BYTES]);
        }
    }
    Ok(normalized)
}

fn canonical_root(root: &Path) -> Result<PathBuf, PlaybackError> {
    let canonical = fs::canonicalize(root).map_err(|error| map_io(error, "result folder"))?;
    let metadata = fs::metadata(&canonical).map_err(|error| map_io(error, "result folder"))?;
    if !metadata.is_dir() {
        return Err(PlaybackError::Invalid(
            "the selected result is not a folder".into(),
        ));
    }
    Ok(canonical)
}

fn load_playback(root: &Path) -> Result<LoadedPlayback, PlaybackError> {
    let root = canonical_root(root)?;
    load_playback_at(&root)
}

fn load_playback_at(root: &Path) -> Result<LoadedPlayback, PlaybackError> {
    let (sidecar_bytes, sidecar) = read_playback_sidecar_at(root)?;

    let mut hasher = Sha256::new();
    hash_revision_entry(&mut hasher, PLAYBACK_FILE, &sidecar_bytes);
    let (fem_geometry, fem_mesh) = if let Some(fem_mesh) = sidecar.fem_mesh.as_ref() {
        let geometry_path = parse_geometry_path(&fem_mesh.geometry_path)?;
        let (geometry_bytes, _) =
            read_file_bounded(root, &geometry_path, MAX_FEM_P1_GEOMETRY_BYTES)?;
        hash_revision_entry(
            &mut hasher,
            &format!("{}/geometry", fem_mesh.geometry_path),
            &geometry_bytes,
        );
        hash_revision_entry(
            &mut hasher,
            &format!("{}/geometry_sha256", fem_mesh.geometry_path),
            fem_mesh.geometry_sha256.as_bytes(),
        );
        let geometry_reference = SavedFieldGeometryRef {
            schema_id: FEM_P1_GEOMETRY_SCHEMA.to_string(),
            object_ref: fem_mesh.geometry_sha256.clone(),
            byte_length: geometry_bytes.len() as u64,
        };
        let geometry = parse_saved_fem_p1_geometry(&geometry_bytes, &geometry_reference)
            .map_err(|error| {
                PlaybackError::Invalid(format!("FEM geometry is not canonical: {error}"))
            })?;
        (
            Some(geometry.clone()),
            Some(SavedPlaybackFemMesh {
                node_count: geometry.mesh.nodes.len(),
                cell_count: geometry.mesh.cell_count(),
                facet_count: geometry.mesh.facet_count(),
                geometry_sha256: fem_mesh.geometry_sha256.clone(),
                topology_byte_length: None,
                topology_sha256: None,
                support_byte_length: None,
                support_sha256: None,
            }),
        )
    } else {
        (None, None)
    };

    let cell_count = sidecar
        .grid_cells_xyz
        .as_ref()
        .map(|grid| {
            grid.iter()
                .try_fold(1_usize, |total, value| total.checked_mul(*value))
                .filter(|count| *count > 0)
                .ok_or_else(|| PlaybackError::Invalid("grid cell count is zero or overflows".into()))
        })
        .transpose()?
        .unwrap_or_else(|| fem_geometry.as_ref().map_or(0, |geometry| geometry.mesh.nodes.len()));
    if cell_count == 0 {
        return Err(PlaybackError::Invalid(
            "playback vector layout has no cells or FEM nodes".into(),
        ));
    }
    let scalar_count = cell_count
        .checked_mul(3)
        .ok_or_else(|| PlaybackError::Invalid("vector length overflows".into()))?;
    let frame_bytes = scalar_count
        .checked_mul(F64_BYTES)
        .filter(|bytes| *bytes <= MAX_FRAME_BYTES)
        .ok_or_else(|| PlaybackError::Invalid("frame exceeds the 64 MiB limit".into()))?;

    let mut stage_ids = HashSet::with_capacity(sidecar.stages.len());
    let mut resource_stages = Vec::with_capacity(sidecar.stages.len());
    let mut loaded_stages = Vec::with_capacity(sidecar.stages.len());

    for stage in sidecar.stages {
        if !stage_ids.insert(stage.stage_id.clone()) {
            return Err(PlaybackError::Invalid("stage ids must be unique".into()));
        }
        let array_path = parse_array_path(&stage.array_path, fem_geometry.is_some())?;
        let (zarray_bytes, _) =
            read_file_bounded(root, &array_path.join(".zarray"), MAX_METADATA_BYTES)?;
        let metadata = parse_array_metadata(
            &zarray_bytes,
            stage.times_s.len(),
            fem_geometry
                .as_ref()
                .map(|geometry| geometry.mesh.nodes.len())
                .unwrap_or(cell_count),
            frame_bytes,
            stage.field_layout.as_deref(),
        )?;
        hash_revision_entry(
            &mut hasher,
            &format!("{}/.zarray", stage.array_path),
            &zarray_bytes,
        );

        let attrs_path = array_path.join(".zattrs");
        match read_file_bounded(root, &attrs_path, MAX_METADATA_BYTES) {
            Ok((bytes, _)) => {
                validate_array_attributes(&bytes, &metadata)?;
                hash_revision_entry(
                    &mut hasher,
                    &format!("{}/.zattrs", stage.array_path),
                    &bytes,
                );
            }
            Err(PlaybackError::NotFound(_)) => {
                hash_revision_entry(
                    &mut hasher,
                    &format!("{}/.zattrs", stage.array_path),
                    b"absent",
                );
            }
            Err(error) => return Err(error),
        }

        let stage_manifest = stage_manifest_path(&array_path)?;
        match read_file_bounded(root, &stage_manifest, MAX_METADATA_BYTES) {
            Ok((bytes, _)) => {
                // Native FEM `fields/m.zarr` stores an adjacent root-level
                // manifest, which is provenance rather than the stage
                // manifest used by the legacy `.../fields/m` layout.
                if array_path.file_name().and_then(|name| name.to_str()) != Some("m.zarr") {
                    validate_stage_manifest(&bytes)?;
                }
                hash_revision_entry(
                    &mut hasher,
                    &format!("{}", stage_manifest.display()),
                    &bytes,
                );
            }
            Err(PlaybackError::NotFound(_)) => {
                hash_revision_entry(
                    &mut hasher,
                    &format!("{}", stage_manifest.display()),
                    b"absent",
                );
            }
            Err(error) => return Err(error),
        }

        let resource = SavedPlaybackStage {
            stage_id: stage.stage_id,
            frame_count: stage.times_s.len(),
            times_s: stage.times_s,
            quantity_ids: stage.quantity_ids,
        };
        resource_stages.push(resource.clone());
        loaded_stages.push(LoadedStage {
            resource,
            array_path,
            metadata,
        });
    }

    let revision = format!("{:x}", hasher.finalize());
    Ok(LoadedPlayback {
        resource: SavedPlaybackResource {
            schema: SAVED_PLAYBACK_SCHEMA.to_string(),
            revision,
            name: sidecar.name,
            source_note: sidecar.source_note,
            grid_cells_xyz: sidecar.grid_cells_xyz,
            cell_size_m: sidecar.cell_size_m,
            origin_m: sidecar.origin_m,
            fem_mesh,
            stages: resource_stages,
        },
        stages: loaded_stages,
        fem_geometry,
    })
}

fn read_playback_sidecar_at(
    root: &Path,
) -> Result<(Vec<u8>, PlaybackSidecar), PlaybackError> {
    let (sidecar_bytes, _) =
        match read_file_bounded(root, Path::new(PLAYBACK_FILE), MAX_PLAYBACK_BYTES) {
            Err(PlaybackError::NotFound(_)) => {
                return Err(PlaybackError::Unsupported("playback.json is missing"));
            }
            other => other?,
        };
    let sidecar: PlaybackSidecar = serde_json::from_slice(&sidecar_bytes)
        .map_err(|_| PlaybackError::Invalid("playback.json is malformed".into()))?;
    if sidecar.schema != SAVED_PLAYBACK_SCHEMA {
        return Err(PlaybackError::Unsupported(
            "playback schema is not supported",
        ));
    }
    validate_sidecar(&sidecar)?;
    Ok((sidecar_bytes, sidecar))
}

fn validate_sidecar(sidecar: &PlaybackSidecar) -> Result<(), PlaybackError> {
    if !sidecar.complete {
        return Err(PlaybackError::Invalid(
            "playback.json must declare the supported schema and complete=true".into(),
        ));
    }
    if sidecar.name.trim().is_empty() || sidecar.name.len() > 4096 {
        return Err(PlaybackError::Invalid("name is empty or too long".into()));
    }
    if sidecar
        .source_note
        .as_ref()
        .is_some_and(|note| note.chars().count() > 4096)
    {
        return Err(PlaybackError::Invalid(
            "source_note exceeds 4096 characters".into(),
        ));
    }
    if sidecar.stages.is_empty() || sidecar.stages.len() > MAX_STAGES {
        return Err(PlaybackError::Invalid(
            "stage count must be between 1 and 64".into(),
        ));
    }
    let has_grid = sidecar.grid_cells_xyz.is_some()
        || sidecar.cell_size_m.is_some()
        || sidecar.origin_m.is_some();
    let has_fem = sidecar.fem_mesh.is_some();
    match (has_grid, has_fem) {
        (true, true) => {
            return Err(PlaybackError::Invalid(
                "playback cannot mix regular-grid and FEM mesh descriptors".into(),
            ));
        }
        (false, false) => {
            return Err(PlaybackError::Invalid(
                "playback must declare either a complete regular grid or FEM mesh".into(),
            ));
        }
        _ => {}
    }
    if has_grid {
        let Some(grid_cells_xyz) = sidecar.grid_cells_xyz else {
            return Err(PlaybackError::Invalid(
                "FDM playback requires grid_cells_xyz, cell_size_m, and origin_m".into(),
            ));
        };
        let Some(cell_size_m) = sidecar.cell_size_m else {
            return Err(PlaybackError::Invalid(
                "FDM playback requires grid_cells_xyz, cell_size_m, and origin_m".into(),
            ));
        };
        let Some(origin_m) = sidecar.origin_m else {
            return Err(PlaybackError::Invalid(
                "FDM playback requires grid_cells_xyz, cell_size_m, and origin_m".into(),
            ));
        };
        if grid_cells_xyz.contains(&0) {
            return Err(PlaybackError::Invalid(
                "grid dimensions must be positive".into(),
            ));
        }
        if cell_size_m
            .iter()
            .any(|value| !value.is_finite() || *value <= 0.0)
            || origin_m.iter().any(|value| !value.is_finite())
        {
            return Err(PlaybackError::Invalid(
                "cell sizes must be finite and positive and origins finite".into(),
            ));
        }
    } else {
        let Some(fem_mesh) = sidecar.fem_mesh.as_ref() else {
            unreachable!("has_fem was checked above")
        };
        if fem_mesh.geometry_path.trim().is_empty()
            || fem_mesh.geometry_path.len() > 4096
            || fem_mesh.geometry_path.contains('\\')
            || fem_mesh.geometry_path.contains('\0')
        {
            return Err(PlaybackError::Invalid(
                "FEM geometry_path must be a bounded relative path".into(),
            ));
        }
        if fem_mesh.geometry_sha256.len() != 64
            || !fem_mesh
                .geometry_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(PlaybackError::Invalid(
                "FEM geometry_sha256 must be a lowercase SHA-256 digest".into(),
            ));
        }
        parse_geometry_path(&fem_mesh.geometry_path)?;
    }
    let mut total_frames = 0_usize;
    let mut stage_ids = HashSet::with_capacity(sidecar.stages.len());
    for stage in &sidecar.stages {
        parse_array_path(&stage.array_path, has_fem)?;
        if stage.stage_id.trim().is_empty()
            || stage.stage_id.len() > 256
            || stage.stage_id.chars().any(char::is_control)
            || !stage_ids.insert(stage.stage_id.as_str())
        {
            return Err(PlaybackError::Invalid(
                "stage ids must be non-empty, unique, and at most 256 bytes".into(),
            ));
        }
        if stage.quantity_ids.len() != 1 || stage.quantity_ids[0] != "m" {
            return Err(PlaybackError::Invalid(
                "each playback stage must expose exactly the m quantity".into(),
            ));
        }
        match (has_fem, stage.field_layout.as_deref()) {
            (true, Some(layout)) if FemFieldLayout::parse(layout).is_some() => {}
            (true, _) => {
                return Err(PlaybackError::Invalid(
                    "FEM stages must declare field_layout as aos_node_major or soa_component_major".into(),
                ));
            }
            (false, None) => {}
            (false, Some(_)) => {
                return Err(PlaybackError::Invalid(
                    "FDM stages must not declare a FEM field_layout".into(),
                ));
            }
        }
        if stage.times_s.is_empty()
            || stage.times_s.iter().any(|value| !value.is_finite())
            || stage.times_s.windows(2).any(|pair| pair[1] <= pair[0])
        {
            return Err(PlaybackError::Invalid(
                "stage times must be finite and strictly increasing".into(),
            ));
        }
        total_frames = total_frames
            .checked_add(stage.times_s.len())
            .filter(|count| *count <= MAX_FRAMES)
            .ok_or_else(|| PlaybackError::Invalid("playback exceeds 100000 frames".into()))?;
    }
    Ok(())
}

fn parse_array_path(raw: &str, fem: bool) -> Result<PathBuf, PlaybackError> {
    if raw.is_empty() || raw.contains('\\') || raw.contains('\0') {
        return Err(PlaybackError::Invalid(
            "array_path must be a relative fields/m path".into(),
        ));
    }
    let path = Path::new(raw);
    let mut parsed = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(name) => parsed.push(name),
            _ => {
                return Err(PlaybackError::Invalid(
                    "array_path cannot contain root, dot, or parent components".into(),
                ))
            }
        }
    }
    let components: Vec<_> = parsed.components().collect();
    let fields_component = components.get(components.len().saturating_sub(2));
    let array_component = components.last();
    let valid_array_name = array_component.is_some_and(|name| {
        name.as_os_str() == "m" || (fem && name.as_os_str() == "m.zarr")
    });
    if components.len() < 2
        || fields_component.is_none_or(|name| name.as_os_str() != "fields")
        || !valid_array_name
    {
        return Err(PlaybackError::Invalid(
            "array_path must point to a Zarr fields/m array (or FEM fields/m.zarr)".into(),
        ));
    }
    Ok(parsed)
}

fn parse_geometry_path(raw: &str) -> Result<PathBuf, PlaybackError> {
    if raw.is_empty() || raw.len() > 4096 || raw.contains('\\') || raw.contains('\0') {
        return Err(PlaybackError::Invalid(
            "geometry_path must be a bounded relative path".into(),
        ));
    }
    let path = Path::new(raw);
    let mut parsed = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(name) => parsed.push(name),
            _ => {
                return Err(PlaybackError::Invalid(
                    "geometry_path cannot contain root, dot, or parent components".into(),
                ))
            }
        }
    }
    if parsed.as_os_str().is_empty() {
        return Err(PlaybackError::Invalid(
            "geometry_path must not be empty".into(),
        ));
    }
    Ok(parsed)
}

fn stage_manifest_path(array_path: &Path) -> Result<PathBuf, PlaybackError> {
    let stage_dir = array_path
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| PlaybackError::Invalid("array_path has no stage directory".into()))?;
    Ok(stage_dir.join("manifest.json"))
}

fn parse_array_metadata(
    bytes: &[u8],
    expected_frames: usize,
    expected_nodes: usize,
    expected_bytes: usize,
    field_layout: Option<&str>,
) -> Result<ArrayMetadata, PlaybackError> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| PlaybackError::Invalid("Zarr .zarray metadata is malformed".into()))?;
    let invalid = || PlaybackError::Invalid("Zarr .zarray metadata does not match playback".into());
    if value.get("zarr_format").and_then(Value::as_u64) != Some(2)
        || value.get("dtype").and_then(Value::as_str) != Some("<f8")
        || value.get("order").and_then(Value::as_str) != Some("C")
        || value.get("compressor") != Some(&Value::Null)
    {
        return Err(invalid());
    }
    let filters_are_empty = match value.get("filters") {
        Some(Value::Null) => true,
        Some(Value::Array(values)) => values.is_empty(),
        _ => false,
    };
    if !filters_are_empty {
        return Err(invalid());
    }
    let shape = value
        .get("shape")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let chunks = value
        .get("chunks")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let fem_layout = field_layout.and_then(FemFieldLayout::parse);
    if field_layout.is_some() && fem_layout.is_none() {
        return Err(invalid());
    }
    let scalar_count = expected_nodes.checked_mul(3).ok_or_else(invalid)?;
    let chunk_rank = match fem_layout {
        None => {
            if shape.len() != 2
                || chunks.len() != 2
                || json_usize(&shape[0]) != Some(expected_frames)
                || json_usize(&shape[1]) != Some(scalar_count)
                || json_usize(&chunks[0]) != Some(1)
                || json_usize(&chunks[1]) != Some(scalar_count)
            {
                return Err(invalid());
            }
            2
        }
        Some(FemFieldLayout::AosNodeMajor) => {
            if shape.len() != 2
                || chunks.len() != 2
                || json_usize(&shape[0]) != Some(expected_frames)
                || json_usize(&shape[1]) != Some(scalar_count)
                || json_usize(&chunks[0]) != Some(1)
                || json_usize(&chunks[1]) != Some(scalar_count)
            {
                return Err(invalid());
            }
            2
        }
        Some(FemFieldLayout::SoaComponentMajor) => {
            let flat = shape.len() == 2
                && chunks.len() == 2
                && json_usize(&shape[0]) == Some(expected_frames)
                && json_usize(&shape[1]) == Some(scalar_count)
                && json_usize(&chunks[0]) == Some(1)
                && json_usize(&chunks[1]) == Some(scalar_count);
            let rank3 = shape.len() == 3
                && chunks.len() == 3
                && json_usize(&shape[0]) == Some(expected_frames)
                && json_usize(&shape[1]) == Some(3)
                && json_usize(&shape[2]) == Some(expected_nodes)
                && json_usize(&chunks[0]) == Some(1)
                && json_usize(&chunks[1]) == Some(3)
                && json_usize(&chunks[2]) == Some(expected_nodes);
            if !flat && !rank3 {
                return Err(invalid());
            }
            shape.len()
        }
    };
    if scalar_count.checked_mul(F64_BYTES) != Some(expected_bytes) {
        return Err(invalid());
    }
    let dimension_separator = match value.get("dimension_separator") {
        None => '.',
        Some(Value::String(separator)) if separator == "." => '.',
        Some(Value::String(separator)) if separator == "/" => '/',
        _ => return Err(invalid()),
    };
    Ok(ArrayMetadata {
        frame_count: expected_frames,
        frame_bytes: expected_bytes,
        dimension_separator,
        chunk_rank,
        fem_layout,
        node_count: expected_nodes,
    })
}

fn json_usize(value: &Value) -> Option<usize> {
    usize::try_from(value.as_u64()?).ok()
}

fn validate_stage_manifest(bytes: &[u8]) -> Result<(), PlaybackError> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| PlaybackError::Invalid("stage manifest is malformed".into()))?;
    if value.get("complete").and_then(Value::as_bool) != Some(true) {
        return Err(PlaybackError::Invalid(
            "an adjacent stage manifest must declare complete=true".into(),
        ));
    }
    Ok(())
}

fn validate_array_attributes(
    bytes: &[u8],
    metadata: &ArrayMetadata,
) -> Result<(), PlaybackError> {
    if metadata.fem_layout.is_none() {
        return Ok(());
    }
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|_| PlaybackError::Invalid("Zarr .zattrs metadata is malformed".into()))?;
    let Some(object) = value.as_object() else {
        return Err(PlaybackError::Invalid(
            "Zarr .zattrs metadata must be an object".into(),
        ));
    };
    let expected_layout = match metadata.fem_layout {
        Some(FemFieldLayout::AosNodeMajor) => "aos_node_major",
        Some(FemFieldLayout::SoaComponentMajor) => "soa_component_major",
        None => return Ok(()),
    };
    if let Some(layout) = object.get("storage_layout") {
        if layout.as_str() != Some(expected_layout) {
            return Err(PlaybackError::Invalid(
                "FEM .zattrs storage_layout contradicts playback field_layout".into(),
            ));
        }
    }
    if let Some(location) = object.get("location") {
        if location.as_str() != Some("node") {
            return Err(PlaybackError::Invalid(
                "FEM .zattrs location must be node".into(),
            ));
        }
    }
    if let Some(scope) = object.get("scope") {
        if scope.as_str() != Some("full") {
            return Err(PlaybackError::Invalid(
                "FEM .zattrs scope must be full".into(),
            ));
        }
    }
    if let Some(observable) = object.get("observable") {
        if observable.as_str() != Some("m") {
            return Err(PlaybackError::Invalid(
                "FEM .zattrs observable must be m".into(),
            ));
        }
    }
    if let Some(component_count) = object.get("component_count") {
        if component_count.as_u64() != Some(3) {
            return Err(PlaybackError::Invalid(
                "FEM .zattrs component_count must be 3".into(),
            ));
        }
    }
    if let Some(component_order) = object.get("component_order") {
        let valid = component_order
            .as_array()
            .map(|values| {
                values.len() == 3
                    && values[0].as_str() == Some("x")
                    && values[1].as_str() == Some("y")
                    && values[2].as_str() == Some("z")
            })
            .unwrap_or(false);
        if !valid {
            return Err(PlaybackError::Invalid(
                "FEM .zattrs component_order must be [x,y,z]".into(),
            ));
        }
    }
    if let Some(axes) = object.get("axes") {
        let axes = axes.as_array().ok_or_else(|| {
            PlaybackError::Invalid("FEM .zattrs axes must be an array".into())
        })?;
        if axes.len() != metadata.chunk_rank || axes.first().and_then(Value::as_str) != Some("sample") {
            return Err(PlaybackError::Invalid(
                "FEM .zattrs axes do not match the Zarr rank".into(),
            ));
        }
        if metadata.chunk_rank == 3 {
            let valid_component_axis = axes.get(1).and_then(Value::as_str) == Some("component");
            // The native writer historically called the full nodal carrier
            // axis `cell`; with location=node and canonical FEM geometry this
            // is an accepted transport alias, not a cell-located field.
            let carrier_axis = axes.get(2).and_then(Value::as_str);
            let valid_carrier_axis = matches!(carrier_axis, Some("node") | Some("cell"));
            let legacy_cell_axis_has_nodal_location = carrier_axis != Some("cell")
                || object.get("location").and_then(Value::as_str) == Some("node");
            if !valid_component_axis
                || !valid_carrier_axis
                || !legacy_cell_axis_has_nodal_location
            {
                return Err(PlaybackError::Invalid(
                    "FEM rank-3 .zattrs axes must be [sample,component,node|cell]".into(),
                ));
            }
        }
    }
    Ok(())
}

fn read_file_bounded(
    root: &Path,
    relative: &Path,
    limit: u64,
) -> Result<(Vec<u8>, FileIdentity), PlaybackError> {
    let path = resolve_existing(root, relative)?;
    let before = file_identity(&fs::metadata(&path).map_err(|error| map_io(error, "metadata"))?);
    if before.length > limit {
        return Err(PlaybackError::Invalid(
            "metadata file exceeds its size limit".into(),
        ));
    }
    let mut file = File::open(&path).map_err(|error| map_io(error, "metadata"))?;
    let opened = file.metadata().map_err(|error| map_io(error, "metadata"))?;
    if !same_identity(&before, &file_identity(&opened)) {
        return Err(PlaybackError::SourceChanged);
    }
    let mut bytes = Vec::with_capacity(before.length as usize);
    file.by_ref()
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| map_io(error, "metadata"))?;
    if bytes.len() as u64 > limit {
        return Err(PlaybackError::Invalid(
            "metadata file exceeds its size limit".into(),
        ));
    }
    let after = file.metadata().map_err(|error| map_io(error, "metadata"))?;
    let path_after = resolve_existing(root, relative)?;
    let path_identity =
        file_identity(&fs::metadata(path_after).map_err(|error| map_io(error, "metadata"))?);
    if !same_identity(&before, &file_identity(&after))
        || !same_identity(&before, &path_identity)
        || bytes.len() as u64 != before.length
    {
        return Err(PlaybackError::SourceChanged);
    }
    Ok((bytes, before))
}

fn read_exact_binary(
    root: &Path,
    relative: &Path,
    expected_bytes: usize,
) -> Result<Vec<u8>, PlaybackError> {
    let path = resolve_existing(root, relative)?;
    let before = file_identity(&fs::metadata(&path).map_err(|error| map_io(error, "frame"))?);
    if before.length != expected_bytes as u64 {
        return Err(PlaybackError::Invalid(
            "frame chunk has a length different from 3*N f64 values".into(),
        ));
    }
    let mut file = File::open(&path).map_err(|error| map_io(error, "frame"))?;
    let opened = file.metadata().map_err(|error| map_io(error, "frame"))?;
    if !same_identity(&before, &file_identity(&opened)) {
        return Err(PlaybackError::SourceChanged);
    }
    let mut bytes = Vec::with_capacity(expected_bytes);
    file.by_ref()
        .take((expected_bytes as u64).saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| map_io(error, "frame"))?;
    let after = file.metadata().map_err(|error| map_io(error, "frame"))?;
    let path_after = resolve_existing(root, relative)?;
    let path_identity =
        file_identity(&fs::metadata(path_after).map_err(|error| map_io(error, "frame"))?);
    if bytes.len() != expected_bytes
        || !same_identity(&before, &file_identity(&after))
        || !same_identity(&before, &path_identity)
    {
        return Err(PlaybackError::SourceChanged);
    }
    Ok(bytes)
}

fn resolve_existing(root: &Path, relative: &Path) -> Result<PathBuf, PlaybackError> {
    let mut current = root.to_path_buf();
    let components: Vec<_> = relative.components().collect();
    if components.is_empty() {
        return Err(PlaybackError::Invalid("empty relative path".into()));
    }
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err(PlaybackError::Invalid(
                "metadata path must be relative and contain no dot or parent components".into(),
            ));
        };
        current.push(name);
        let metadata = fs::symlink_metadata(&current).map_err(|error| map_io(error, "file"))?;
        if metadata.file_type().is_symlink() {
            return Err(PlaybackError::Invalid(
                "playback paths cannot contain symbolic links".into(),
            ));
        }
        if index + 1 < components.len() && !metadata.is_dir() {
            return Err(PlaybackError::Invalid(
                "a playback path component is not a directory".into(),
            ));
        }
    }
    let canonical = fs::canonicalize(&current).map_err(|error| map_io(error, "file"))?;
    if !canonical.starts_with(root) || canonical == root {
        return Err(PlaybackError::Invalid(
            "playback file escaped the selected result folder".into(),
        ));
    }
    let metadata = fs::symlink_metadata(&current).map_err(|error| map_io(error, "file"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(PlaybackError::Invalid(
            "playback metadata and chunks must be regular files".into(),
        ));
    }
    Ok(canonical)
}

fn validate_frame_values(bytes: &[u8]) -> Result<(), PlaybackError> {
    if bytes.len() % F64_BYTES != 0 {
        return Err(PlaybackError::Invalid(
            "frame chunk is not an f64 sequence".into(),
        ));
    }
    if bytes.chunks_exact(F64_BYTES).any(|chunk| {
        let raw: [u8; F64_BYTES] = chunk.try_into().expect("chunks_exact yields eight bytes");
        !f64::from_le_bytes(raw).is_finite()
    }) {
        return Err(PlaybackError::Invalid(
            "frame contains a non-finite value".into(),
        ));
    }
    Ok(())
}

fn hash_revision_entry(hasher: &mut Sha256, name: &str, bytes: &[u8]) {
    hasher.update((name.len() as u64).to_le_bytes());
    hasher.update(name.as_bytes());
    hasher.update((bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}

fn file_identity(metadata: &Metadata) -> FileIdentity {
    FileIdentity {
        length: metadata.len(),
        modified: metadata.modified().ok(),
        #[cfg(unix)]
        device: {
            use std::os::unix::fs::MetadataExt;
            metadata.dev()
        },
        #[cfg(unix)]
        inode: {
            use std::os::unix::fs::MetadataExt;
            metadata.ino()
        },
    }
}

fn same_identity(left: &FileIdentity, right: &FileIdentity) -> bool {
    left == right
}

fn map_io(error: std::io::Error, what: &'static str) -> PlaybackError {
    if error.kind() == std::io::ErrorKind::NotFound {
        PlaybackError::NotFound(what)
    } else {
        PlaybackError::Io(what)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use serde_json::{json, Value};

    use super::{
        normalize_frame_layout, parse_array_path, probe_playback, read_playback,
        read_playback_frame, ArrayMetadata, FemFieldLayout, PlaybackError, F64_BYTES,
        SAVED_PLAYBACK_SCHEMA,
    };

    fn sidecar(stages: Value) -> Value {
        json!({
            "schema": SAVED_PLAYBACK_SCHEMA,
            "complete": true,
            "name": "saved result",
            "grid_cells_xyz": [2, 1, 1],
            "cell_size_m": [1.0e-9, 1.0e-9, 1.0e-9],
            "origin_m": [0.0, 0.0, 0.0],
            "stages": stages,
        })
    }

    fn stage(stage_id: &str, array_path: &str, times_s: &[f64]) -> Value {
        json!({
            "stage_id": stage_id,
            "array_path": array_path,
            "times_s": times_s,
            "quantity_ids": ["m"],
        })
    }

    fn write_array(root: &Path, array_path: &str, frame_count: usize, values: &[f64]) {
        let array = root.join(array_path);
        fs::create_dir_all(&array).unwrap();
        fs::write(
            array.join(".zarray"),
            json!({
                "zarr_format": 2,
                "shape": [frame_count, 6],
                "chunks": [1, 6],
                "dtype": "<f8",
                "compressor": null,
                "fill_value": null,
                "order": "C",
                "filters": null,
                "dimension_separator": ".",
            })
            .to_string(),
        )
        .unwrap();
        if !values.is_empty() {
            let mut bytes = Vec::with_capacity(values.len() * 8);
            for value in values {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            fs::write(array.join("0.0"), bytes).unwrap();
        }
    }

    fn write_sidecar(root: &Path, value: Value) {
        fs::create_dir_all(root).unwrap();
        fs::write(root.join("playback.json"), value.to_string()).unwrap();
    }

    fn fem_descriptor(geometry_path: &str) -> Value {
        json!({
            "schema": SAVED_PLAYBACK_SCHEMA,
            "complete": true,
            "name": "saved FEM result",
            "fem_mesh": {
                "geometry_path": geometry_path,
                "geometry_sha256": "a".repeat(64),
            },
            "stages": [{
                "stage_id": "relax",
                "array_path": "fields/m.zarr",
                "times_s": [0.0],
                "quantity_ids": ["m"],
                "field_layout": "soa_component_major",
            }],
        })
    }

    #[test]
    fn reads_multi_stage_metadata_and_exact_little_endian_frames() {
        let root = tempfile::tempdir().unwrap();
        let first_path = "stages/relax/fields/m";
        let second_path = "artifacts/fields/m";
        write_array(root.path(), first_path, 2, &[1., 2., 3., 4., 5., 6.]);
        write_array(root.path(), second_path, 1, &[7., 8., 9., 10., 11., 12.]);
        fs::write(
            root.path().join("stages/relax/manifest.json"),
            r#"{"complete":true}"#,
        )
        .unwrap();
        let mut descriptor = sidecar(json!([
            stage("relax", first_path, &[0.0, 1.0]),
            stage("final", second_path, &[0.0]),
        ]));
        descriptor["source_note"] = json!("Recovered fields; native publication did not finish.");
        write_sidecar(root.path(), descriptor);

        let manifest = read_playback(root.path()).unwrap();
        assert_eq!(manifest.schema, SAVED_PLAYBACK_SCHEMA);
        assert_eq!(
            manifest.source_note.as_deref(),
            Some("Recovered fields; native publication did not finish.")
        );
        assert_eq!(manifest.grid_cells_xyz, Some([2, 1, 1]));
        assert_eq!(manifest.stages.len(), 2);
        assert_eq!(manifest.stages[0].frame_count, 2);
        assert_eq!(manifest.stages[1].stage_id, "final");
        assert!(serde_json::to_value(&manifest).unwrap()["stages"][0]
            .get("array_path")
            .is_none());
        let bytes = read_playback_frame(root.path(), "relax", 0, &manifest.revision).unwrap();
        assert_eq!(bytes.len(), 6 * 8);
        assert_eq!(f64::from_le_bytes(bytes[0..8].try_into().unwrap()), 1.0);
        assert_eq!(f64::from_le_bytes(bytes[40..48].try_into().unwrap()), 6.0);
    }

    #[test]
    fn rejects_stale_revisions_and_missing_chunks() {
        let root = tempfile::tempdir().unwrap();
        let array = "artifacts/fields/m";
        write_array(root.path(), array, 1, &[]);
        write_sidecar(root.path(), sidecar(json!([stage("final", array, &[0.0])])));
        let manifest = read_playback(root.path()).unwrap();
        assert_eq!(
            read_playback_frame(root.path(), "final", 0, "stale"),
            Err(PlaybackError::StaleRevision)
        );
        assert!(matches!(
            read_playback_frame(root.path(), "final", 0, &manifest.revision),
            Err(PlaybackError::NotFound(_))
        ));
    }

    #[test]
    fn rejects_a_revision_after_zarr_metadata_changes() {
        let root = tempfile::tempdir().unwrap();
        let array = "artifacts/fields/m";
        write_array(root.path(), array, 1, &[1., 2., 3., 4., 5., 6.]);
        write_sidecar(root.path(), sidecar(json!([stage("final", array, &[0.0])])));
        let manifest = read_playback(root.path()).unwrap();
        let zarray_path = root.path().join(array).join(".zarray");
        let mut metadata: Value = serde_json::from_slice(&fs::read(&zarray_path).unwrap()).unwrap();
        metadata["fill_value"] = json!(0.0);
        fs::write(&zarray_path, metadata.to_string()).unwrap();
        assert_eq!(
            read_playback_frame(root.path(), "final", 0, &manifest.revision),
            Err(PlaybackError::StaleRevision)
        );
    }

    #[test]
    fn rejects_path_traversal_and_malformed_or_incomplete_sidecars() {
        let root = tempfile::tempdir().unwrap();
        write_sidecar(
            root.path(),
            sidecar(json!([stage("escape", "../outside/fields/m", &[0.0])])),
        );
        assert!(matches!(
            read_playback(root.path()),
            Err(PlaybackError::Invalid(_))
        ));

        fs::write(root.path().join("playback.json"), b"{not json").unwrap();
        assert!(matches!(
            read_playback(root.path()),
            Err(PlaybackError::Invalid(_))
        ));

        let mut incomplete = sidecar(json!([]));
        incomplete["complete"] = json!(false);
        write_sidecar(root.path(), incomplete);
        assert!(matches!(
            read_playback(root.path()),
            Err(PlaybackError::Invalid(_))
        ));
    }

    #[test]
    fn rejects_oversize_sidecars_and_non_finite_frame_values() {
        let root = tempfile::tempdir().unwrap();
        let too_large = vec![b' '; 16 * 1024 * 1024 + 1];
        fs::write(root.path().join("playback.json"), too_large).unwrap();
        assert!(matches!(
            read_playback(root.path()),
            Err(PlaybackError::Invalid(_))
        ));

        let array = "artifacts/fields/m";
        write_array(root.path(), array, 1, &[f64::NAN, 2., 3., 4., 5., 6.]);
        write_sidecar(root.path(), sidecar(json!([stage("final", array, &[0.0])])));
        let manifest = read_playback(root.path()).unwrap();
        assert!(matches!(
            read_playback_frame(root.path(), "final", 0, &manifest.revision),
            Err(PlaybackError::Invalid(_))
        ));
    }

    #[test]
    fn recognizes_only_a_valid_playback_descriptor_at_the_result_root() {
        let root = tempfile::tempdir().unwrap();
        let array = "artifacts/fields/m";
        write_array(root.path(), array, 1, &[1., 2., 3., 4., 5., 6.]);
        write_sidecar(root.path(), sidecar(json!([stage("final", array, &[0.0])])));
        assert!(crate::is_result_dir(root.path()));

        let other = tempfile::tempdir().unwrap();
        fs::create_dir_all(other.path().join("nested")).unwrap();
        fs::write(
            other.path().join("nested/playback.json"),
            sidecar(json!([])).to_string(),
        )
        .unwrap();
        assert!(!crate::is_result_dir(other.path()));
    }

    #[test]
    fn discovery_probe_accepts_fem_without_opening_geometry() {
        let root = tempfile::tempdir().unwrap();
        write_sidecar(root.path(), fem_descriptor("geometry.json"));

        // Discovery is intentionally descriptor-only: the geometry can be
        // absent or unreadable until an explicit playback request qualifies it.
        assert!(probe_playback(root.path()).is_ok());
        assert!(crate::is_result_dir(root.path()));
        assert!(matches!(
            read_playback(root.path()),
            Err(PlaybackError::NotFound(_))
        ));

        fs::write(root.path().join("geometry.json"), b"not canonical geometry").unwrap();
        assert!(probe_playback(root.path()).is_ok());
        assert!(crate::is_result_dir(root.path()));
        assert!(matches!(
            read_playback(root.path()),
            Err(PlaybackError::Invalid(_))
        ));
    }

    #[test]
    fn discovery_probe_rejects_malformed_incomplete_schema_and_unsafe_descriptors() {
        let malformed = tempfile::tempdir().unwrap();
        fs::write(malformed.path().join("playback.json"), b"{not json").unwrap();
        assert!(probe_playback(malformed.path()).is_err());
        assert!(!crate::is_result_dir(malformed.path()));

        let variants = [
            {
                let mut value = fem_descriptor("geometry.json");
                value["complete"] = json!(false);
                value
            },
            {
                let mut value = fem_descriptor("geometry.json");
                value["schema"] = json!("other.schema");
                value
            },
            fem_descriptor("../geometry.json"),
        ];
        for descriptor in variants {
            let root = tempfile::tempdir().unwrap();
            write_sidecar(root.path(), descriptor);
            assert!(probe_playback(root.path()).is_err());
            assert!(!crate::is_result_dir(root.path()));
        }
    }

    #[test]
    fn fem_native_paths_and_component_major_frames_are_unambiguous() {
        assert!(parse_array_path("fields/m.zarr", true).is_ok());
        assert!(parse_array_path("fields/m", true).is_ok());
        assert!(parse_array_path("artifacts/fields/m", false).is_ok());
        assert!(parse_array_path("fields/m.zarr", false).is_err());
        assert!(parse_array_path("../fields/m.zarr", true).is_err());

        let metadata = ArrayMetadata {
            frame_count: 1,
            frame_bytes: 4 * 3 * F64_BYTES,
            dimension_separator: '.',
            chunk_rank: 3,
            fem_layout: Some(FemFieldLayout::SoaComponentMajor),
            node_count: 4,
        };
        let values = [
            1.0_f64, 2.0, 3.0, 4.0, // x
            11.0, 12.0, 13.0, 14.0, // y
            21.0, 22.0, 23.0, 24.0, // z
        ];
        let mut bytes = Vec::with_capacity(values.len() * F64_BYTES);
        for value in values {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        let normalized = normalize_frame_layout(bytes, &metadata).unwrap();
        let normalized = normalized
            .chunks_exact(F64_BYTES)
            .map(|chunk| f64::from_le_bytes(chunk.try_into().unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(
            normalized,
            vec![1.0, 11.0, 21.0, 2.0, 12.0, 22.0, 3.0, 13.0, 23.0, 4.0, 14.0, 24.0]
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_array_metadata() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write_array(outside.path(), "fields/m", 1, &[1., 2., 3., 4., 5., 6.]);
        fs::create_dir_all(root.path().join("stages")).unwrap();
        symlink(outside.path(), root.path().join("stages/linked")).unwrap();
        write_sidecar(
            root.path(),
            sidecar(json!([stage("linked", "stages/linked/fields/m", &[0.0])])),
        );
        assert!(matches!(
            read_playback(root.path()),
            Err(PlaybackError::Invalid(_))
        ));
    }
}
