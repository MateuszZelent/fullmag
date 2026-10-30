//! Bounded read-only browser for exported result folders.
//!
//! The folder on disk is authoritative.  This reader does not consult the
//! active mesh, the in-memory artifact list, or a solver.  Zarr metadata is
//! visible even when an array's payload is compressed or otherwise outside the
//! small, explicitly supported little-endian f64 subset.

use crate::playback::SavedPlaybackResource;
use crate::results_fs::{PinnedDirectory, open_directory, open_regular};
use fullmag_session::saved_fem_nodal::{
    FEM_NODAL_OBJECT_DIRECTORY, SavedFemNodalArrayBinding, SavedFemP1MeshGeometry,
    object_relative_path as fem_nodal_object_relative_path,
};
use fullmag_session::solution_field_geometry::SavedFieldGeometryRef;
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsStr;
use std::fs::{self, Metadata};
use std::io::Read;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_DEPTH: usize = 32;
const MAX_ENTRIES: usize = 50_000;
const MAX_PATH_BYTES: usize = 16 * 1024;
const SCAN_ENTRY_METADATA_BYTES: u64 = 64;
const MAX_JSON_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
const MAX_SAMPLE_BYTES: usize = 64 * 1024 * 1024;
const MAX_COORDINATES: usize = 4096;
const DEFAULT_LIMIT: usize = 200;
const MAX_LIMIT: usize = 1000;
const F64_BYTES: usize = std::mem::size_of::<f64>();

const MAX_METADATA_TOTAL: u64 = 32 * 1024 * 1024;
const MAX_READ_DURATION: Duration = Duration::from_secs(3);
thread_local! {
    static READ_BUDGET: RefCell<Option<(Instant, u64)>> = const { RefCell::new(None) };
}

struct ReadBudget {
    owner: bool,
}

impl ReadBudget {
    fn begin() -> Self {
        let owner = READ_BUDGET.with(|budget| {
            let mut budget = budget.borrow_mut();
            if budget.is_some() {
                false
            } else {
                *budget = Some((Instant::now(), 0));
                true
            }
        });
        Self { owner }
    }
}

impl Drop for ReadBudget {
    fn drop(&mut self) {
        if self.owner {
            READ_BUDGET.with(|budget| {
                budget.replace(None);
            });
        }
    }
}

/// Guard a complete results/playback metadata request with one aggregate
/// byte/time budget. Nested readers join the active budget instead of
/// replacing or resetting it.
pub struct ResultsReadBudget {
    _inner: ReadBudget,
    _not_send: PhantomData<Rc<()>>,
}

impl ResultsReadBudget {
    pub fn begin() -> Self {
        Self {
            _inner: ReadBudget::begin(),
            _not_send: PhantomData,
        }
    }
}

/// Run a bounded results read under one shared metadata budget.
pub fn with_results_read_budget<T>(
    operation: impl FnOnce() -> Result<T, ResultsError>,
) -> Result<T, ResultsError> {
    let _budget = ResultsReadBudget::begin();
    operation()
}

/// Charge bytes read by sibling playback metadata readers against the active
/// results budget. Calls are intentionally a no-op only when no outer bounded
/// request exists (for example a standalone playback endpoint).
pub(crate) fn charge_metadata(bytes: u64) -> Result<(), ResultsError> {
    READ_BUDGET.with(|budget| {
        let mut budget = budget.borrow_mut();
        if let Some((start, total)) = budget.as_mut() {
            let proposed = total.saturating_add(bytes);
            if proposed > MAX_METADATA_TOTAL || start.elapsed() > MAX_READ_DURATION {
                return Err(ResultsError::TooLarge(
                    "result metadata exceeds its aggregate byte/time budget".into(),
                ));
            }
            *total = proposed;
        }
        Ok(())
    })
}

/// Namespace from which the provider resolved a result root.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub enum WorkspaceResultsSource {
    WorkspaceItem,
    Current,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub enum WorkspaceResultsStatus {
    Ready,
    Empty,
    Partial,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub enum WorkspaceResultEntryKind {
    Directory,
    ZarrGroup,
    ZarrArray,
    File,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub enum WorkspaceResultEntryStatus {
    Ready,
    MetadataOnly,
    Unsupported,
    Unreadable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub enum WorkspaceResultCoordinateKind {
    PhysicalTime,
    AcceptedStep,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub enum WorkspaceResultGeometryKind {
    Fdm,
    FemP1,
    Unknown,
}

/// Geometry is emitted only when persisted producer metadata gives an
/// unambiguous mapping from values to cells/nodes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct WorkspaceResultGeometry {
    pub kind: WorkspaceResultGeometryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cells_xyz: Option<[usize; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell_size_m: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_m: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topology_array_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playback_geometry_sha256: Option<String>,
    /// Exact saved-playback FEM descriptor metadata. Binary lengths and
    /// hashes are filled by the HTTP adapter after it reuses the canonical
    /// FMMT/FMSP encoders; the reader never guesses them from node counts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_mesh: Option<crate::playback::SavedPlaybackFemMesh>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Strictly validated mesh and active support for one saved FEM nodal array.
///
/// This records the producer's saved H1/P1 declaration. It does not prove the
/// native solver's degree-of-freedom mapping.
#[derive(Debug, Clone, PartialEq)]
pub struct ResultsFemNodalGeometry {
    pub binding: SavedFemNodalArrayBinding,
    pub mesh: SavedFemP1MeshGeometry,
    pub active_node_mask: Vec<bool>,
    pub geometry_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct WorkspaceResultSampleCoordinate {
    pub sample_index: usize,
    pub kind: WorkspaceResultCoordinateKind,
    /// Physical-time coordinates are finite f64 values.  Accepted solver
    /// steps may exceed the exact integer range of f64, so callers must use
    /// `accepted_step` when `value` is absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    /// Decimal spelling of an accepted step, retained without an f64 round
    /// trip.  This is present for accepted-step coordinates.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accepted_step: Option<String>,
}

/// Public array metadata.  The `revision` belongs on the array response so
/// every subsequent sample read can be pinned to this exact source snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct WorkspaceResultArray {
    pub id: String,
    pub path: String,
    pub revision: String,
    pub shape: Vec<u64>,
    pub chunks: Vec<u64>,
    pub dtype: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantity_id: Option<String>,
    /// Ordered quantity/column identifiers declared by the producer. Older
    /// array responses may omit this field; deserialization keeps them
    /// compatible by treating the omission as an empty list.
    #[serde(default)]
    pub quantity_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_layout: Option<String>,
    pub sample_count: usize,
    pub coordinates: Vec<WorkspaceResultSampleCoordinate>,
    pub can_read_values: bool,
    pub can_visualize_3d: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geometry: Option<WorkspaceResultGeometry>,
}

/// One catalog entry. Array metadata stays behind the array endpoint; payload
/// chunks are addressed through the bounded sample endpoint so a large folder
/// catalog remains cheap while ordinary files outside arrays stay visible.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct WorkspaceResultEntry {
    pub id: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub name: String,
    pub kind: WorkspaceResultEntryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub array_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    pub status: WorkspaceResultEntryStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
pub struct WorkspaceResultsCatalog {
    pub schema: String,
    pub revision: String,
    pub resource_binding: WorkspaceResultsSource,
    pub root_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub status: WorkspaceResultsStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub can_read_values: bool,
    pub can_visualize_3d: bool,
    pub entries: Vec<WorkspaceResultEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub total_count: usize,
    pub truncated: bool,
}

/// Bounded source-declared f64LE sample.  HTTP adapters publish the bytes and
/// put the shape/layout in headers, keeping the control plane JSON-free of
/// potentially millions of scalar values.
#[derive(Debug, Clone, PartialEq)]
pub struct WorkspaceResultSample {
    pub array_id: String,
    pub revision: String,
    pub sample_index: usize,
    pub shape: Vec<u64>,
    pub dtype: String,
    pub layout: Option<String>,
    pub coordinate: Option<WorkspaceResultSampleCoordinate>,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkspaceResultEntryPayload {
    pub entry: WorkspaceResultEntry,
    pub revision: String,
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResultsError {
    NotFound(String),
    Invalid(String),
    Unsupported(String),
    StaleRevision,
    SourceChanged,
    Io(String),
    TooLarge(String),
    Link(String),
    RunMismatch { expected: String, actual: String },
    Cursor(String),
}

impl std::fmt::Display for ResultsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(what) => write!(f, "result entry not found: {what}"),
            Self::Invalid(message) => write!(f, "invalid result folder: {message}"),
            Self::Unsupported(what) => write!(f, "result values are unsupported: {what}"),
            Self::StaleRevision => f.write_str("result revision is stale"),
            Self::SourceChanged => f.write_str("result source changed during the read"),
            Self::Io(message) => write!(f, "could not read result folder: {message}"),
            Self::TooLarge(message) => write!(f, "result payload is too large: {message}"),
            Self::Link(message) => write!(f, "result folder contains an unsafe link: {message}"),
            Self::RunMismatch { expected, actual } => write!(
                f,
                "result run id mismatch: expected {expected}, found {actual}"
            ),
            Self::Cursor(message) => write!(f, "invalid result cursor: {message}"),
        }
    }
}

impl std::error::Error for ResultsError {}

/// Read one bounded page of the actual result-folder hierarchy.
pub fn read_results_catalog(
    root: &Path,
    cursor: Option<&str>,
    limit: usize,
    expected_run_id: Option<&str>,
    resource_binding: WorkspaceResultsSource,
) -> Result<WorkspaceResultsCatalog, ResultsError> {
    let _read_budget = ReadBudget::begin();
    let (cursor_revision, offset) = parse_cursor(cursor)?;
    let limit = if limit == 0 {
        DEFAULT_LIMIT
    } else {
        limit.min(MAX_LIMIT)
    };
    let scan = scan_root(root)?;
    if let Some(revision) = cursor_revision {
        ensure_expected_revision(&scan.revision, revision)?;
    }
    let run_id = read_and_validate_run_id(root, expected_run_id)?;
    let geometry = read_geometry_context(root, false)?;
    let public_entries = scan
        .entries
        .iter()
        .filter(|entry| !is_internal_geometry_path(&entry.relative))
        .collect::<Vec<_>>();
    let total_count = public_entries.len();
    let end = offset.saturating_add(limit).min(total_count);
    let mut entries = public_entries
        .iter()
        .skip(offset)
        .take(limit)
        .map(|entry| entry_to_public(root, entry, &scan, geometry.as_ref()))
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    let can_read_values = entries
        .iter()
        .any(|entry| entry.status == WorkspaceResultEntryStatus::Ready && entry.array_id.is_some());
    let can_visualize_3d = entries.iter().any(|entry| {
        entry.status == WorkspaceResultEntryStatus::Ready
            && entry.array_id.is_some()
            && entry.reason.is_none()
    });
    let partial = entries.iter().any(|entry| {
        matches!(
            entry.status,
            WorkspaceResultEntryStatus::Unsupported | WorkspaceResultEntryStatus::Unreadable
        )
    });
    let next_cursor = (end < total_count).then(|| format!("{}:{end}", scan.revision));
    let page = entries;
    let revision = scan.revision.clone();
    ensure_unchanged(root, &revision)?;
    Ok(WorkspaceResultsCatalog {
        schema: "fullmag.results-catalog.v1".into(),
        revision,
        resource_binding,
        root_label: root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| root.display().to_string()),
        run_id,
        status: if total_count == 0 {
            WorkspaceResultsStatus::Empty
        } else if partial {
            WorkspaceResultsStatus::Partial
        } else {
            WorkspaceResultsStatus::Ready
        },
        reason: partial.then(|| "one or more entries are metadata-only or unsupported".into()),
        can_read_values,
        can_visualize_3d,
        entries: page,
        next_cursor,
        total_count,
        truncated: total_count > end,
    })
}

/// Read metadata for one opaque array id, pinned to a catalog revision.
pub fn read_results_array(
    root: &Path,
    array_id: &str,
    revision: &str,
    expected_run_id: Option<&str>,
) -> Result<WorkspaceResultArray, ResultsError> {
    let _read_budget = ReadBudget::begin();
    let scan = scan_root(root)?;
    ensure_expected_revision(&scan.revision, revision)?;
    let _ = read_and_validate_run_id(root, expected_run_id)?;
    let entry = find_array(&scan, array_id)?;
    let metadata = parse_array_metadata_for_root(root, &entry.path, scan.root_policy)?;
    let geometry = if metadata.attrs.get("fem_nodal_binding").is_some() {
        None
    } else {
        read_geometry_context(root, true)?
    };
    let result = array_to_public_with_metadata(root, entry, geometry.as_ref(), revision, metadata)?;
    ensure_unchanged(root, revision)?;
    Ok(result)
}

/// Read the saved FEM P1 mesh and support mask bound to one results array.
///
/// The immutable objects are loaded only for this selected-array request. A
/// present but malformed binding is an error; only a missing key returns
/// `Ok(None)` so adapters can retain legacy behavior for older folders.
pub fn read_results_fem_nodal_geometry(
    root: &Path,
    array_id: &str,
    revision: &str,
    expected_run_id: Option<&str>,
) -> Result<Option<ResultsFemNodalGeometry>, ResultsError> {
    let _read_budget = ReadBudget::begin();
    let scan = scan_root(root)?;
    ensure_expected_revision(&scan.revision, revision)?;
    let entry = find_array(&scan, array_id)?;
    let result = (|| {
        let _ = read_and_validate_run_id(root, expected_run_id)?;
        let metadata = parse_array_metadata_for_root(root, &entry.path, scan.root_policy)?;
        let Some(binding_value) = metadata.attrs.get("fem_nodal_binding") else {
            return Ok(None);
        };
        let binding: SavedFemNodalArrayBinding = serde_json::from_value(binding_value.clone())
            .map_err(|error| {
                ResultsError::Invalid(format!("invalid FEM nodal array binding: {error}"))
            })?;
        binding.validate().map_err(|error| {
            ResultsError::Invalid(format!("invalid FEM nodal array binding: {error}"))
        })?;
        let store_relative = validate_fem_nodal_array_binding(entry, &metadata, &binding)?;
        // Accepted output leaves contain target.zarr stores. Bind geometry to
        // the exact store that owns this stages/... array, never the outer
        // browser folder or a sibling store with the same quantity name.
        if !store_relative.as_os_str().is_empty()
            && read_json(&root.join(&store_relative).join(".zgroup"))?
                .get("zarr_format").and_then(Value::as_u64) != Some(2)
        {
            return Err(ResultsError::Invalid("FEM nodal array has no owning Zarr v2 store".into()));
        }
        let mut root_directory = open_directory(root).map_err(|error| match error.kind() {
            std::io::ErrorKind::InvalidInput => {
                ResultsError::Link("cannot safely pin FEM nodal results root".into())
            }
            _ => ResultsError::Io(format!("cannot pin FEM nodal results root: {error}")),
        })?;
        for component in store_relative.components() {
            let std::path::Component::Normal(name) = component else {
                return Err(ResultsError::Invalid("invalid FEM nodal store path".into()));
            };
            root_directory = root_directory.open_child_directory(name)
                .map_err(|error| fem_geometry_open_error("owning Zarr store", error))?;
        }
        let objects = root_directory
            .open_child_directory(OsStr::new(FEM_NODAL_OBJECT_DIRECTORY))
            .map_err(|error| fem_geometry_open_error(FEM_NODAL_OBJECT_DIRECTORY, error))?;
        let mesh_name = fem_nodal_object_name(&binding.mesh)?;
        let semantics_name = fem_nodal_object_name(&binding.semantics)?;
        let mesh_bytes =
            read_pinned_fem_geometry_object(&objects, &mesh_name, binding.mesh.byte_length)?;
        let semantics_bytes = read_pinned_fem_geometry_object(
            &objects,
            &semantics_name,
            binding.semantics.byte_length,
        )?;
        let (mesh, semantics) = binding
            .parse_payloads(&mesh_bytes, &semantics_bytes)
            .map_err(|error| {
                ResultsError::Invalid(format!(
                    "FEM nodal geometry objects do not match their binding: {error}"
                ))
            })?;
        let binding_bytes = serde_json::to_vec(&binding).map_err(|error| {
            ResultsError::Invalid(format!(
                "cannot serialize validated FEM nodal binding: {error}"
            ))
        })?;
        let geometry_sha256 = hex_bytes(&Sha256::digest(binding_bytes));
        Ok(Some(ResultsFemNodalGeometry {
            binding,
            mesh,
            active_node_mask: semantics.active_node_mask,
            geometry_sha256,
        }))
    })();
    // Re-scan even on parse/read errors so a concurrent replacement is
    // reported as a changed snapshot instead of a misleading bad-payload
    // diagnosis. The immutable CAS entries participate in this revision.
    ensure_unchanged(root, revision)?;
    result
}

/// Read one complete, source-declared f64LE sample from an uncompressed Zarr
/// array whose first chunk dimension is one.
pub fn read_results_sample(
    root: &Path,
    array_id: &str,
    sample_index: usize,
    revision: &str,
    expected_run_id: Option<&str>,
) -> Result<WorkspaceResultSample, ResultsError> {
    let _read_budget = ReadBudget::begin();
    let scan = scan_root(root)?;
    ensure_expected_revision(&scan.revision, revision)?;
    let _ = read_and_validate_run_id(root, expected_run_id)?;
    let entry = find_array(&scan, array_id)?;
    let metadata = parse_array_metadata_for_root(root, &entry.path, scan.root_policy)?;
    let geometry = if metadata.attrs.get("fem_nodal_binding").is_some() {
        None
    } else {
        read_geometry_context(root, true)?
    };
    let array =
        array_to_public_with_metadata(root, entry, geometry.as_ref(), revision, metadata.clone())?;
    if !array.can_read_values {
        return Err(ResultsError::Unsupported(array.reason.unwrap_or_else(
            || "array is not an uncompressed little-endian f64 array".into(),
        )));
    }
    let sample_count = usize::try_from(metadata.shape[0])
        .map_err(|_| ResultsError::TooLarge("sample count exceeds usize".into()))?;
    if sample_index >= sample_count {
        return Err(ResultsError::NotFound(format!("sample {sample_index}")));
    }
    let chunk_path = chunk_path(&entry.path, &metadata, sample_index)?;
    let expected = sample_byte_length(&metadata)?;
    let bytes = read_exact_payload(&chunk_path, expected)?;
    validate_finite_f64(&bytes)?;
    ensure_unchanged(root, revision)?;
    Ok(WorkspaceResultSample {
        array_id: array.id,
        revision: revision.to_string(),
        sample_index,
        shape: metadata.shape[1..].to_vec(),
        dtype: "f64le".into(),
        layout: array.field_layout,
        coordinate: array
            .coordinates
            .iter()
            .find(|coordinate| coordinate.sample_index == sample_index)
            .cloned(),
        bytes,
    })
}

/// Read a bounded file/JSON/CSV preview by opaque entry id.
pub fn read_results_entry(
    root: &Path,
    entry_id: &str,
    revision: &str,
    expected_run_id: Option<&str>,
) -> Result<WorkspaceResultEntryPayload, ResultsError> {
    let _read_budget = ReadBudget::begin();
    let scan = scan_root(root)?;
    ensure_expected_revision(&scan.revision, revision)?;
    let _ = read_and_validate_run_id(root, expected_run_id)?;
    let entry = scan
        .entries
        .iter()
        .find(|entry| !is_internal_geometry_path(&entry.relative) && entry.entry_id() == entry_id)
        .ok_or_else(|| ResultsError::NotFound(entry_id.to_string()))?;
    if !matches!(entry.kind, RawKind::File) {
        return Err(ResultsError::Unsupported(
            "directories and arrays are metadata-only entries".into(),
        ));
    }
    let geometry = read_geometry_context(root, false)?;
    let public = entry_to_public(root, entry, &scan, geometry.as_ref())?;
    let mime_type = public
        .mime_type
        .clone()
        .unwrap_or_else(|| "application/octet-stream".into());
    let textual = mime_type.starts_with("text/") || mime_type.contains("json");
    let length = entry.size;
    let (bytes, truncated) = if length > MAX_TEXT_BYTES as u64 {
        if !textual {
            return Err(ResultsError::TooLarge(format!("file is {length} bytes")));
        }
        (read_prefix(&entry.path, MAX_TEXT_BYTES)?, true)
    } else {
        (
            read_exact_payload(
                &entry.path,
                usize::try_from(length)
                    .map_err(|_| ResultsError::TooLarge(entry.path.display().to_string()))?,
            )?,
            false,
        )
    };
    ensure_unchanged(root, revision)?;
    Ok(WorkspaceResultEntryPayload {
        entry: public,
        revision: revision.to_string(),
        bytes,
        mime_type,
        truncated,
    })
}

/// Resolve the canonical playback revision for one exact FEM result array.
///
/// The result-folder revision is deliberately separate from the playback
/// descriptor revision.  Callers must present the former to bind the array,
/// then use the returned latter when reading the canonical FMMT/FMSP geometry.
pub fn locate_results_fem_playback_revision(
    root: &Path,
    array_id: &str,
    revision: &str,
    expected_run_id: Option<&str>,
) -> Result<String, ResultsError> {
    let _read_budget = ReadBudget::begin();
    let scan = scan_root(root)?;
    ensure_expected_revision(&scan.revision, revision)?;
    let _ = read_and_validate_run_id(root, expected_run_id)?;
    let entry = find_array(&scan, array_id)?;
    let context = read_geometry_context(root, true)?.ok_or_else(|| {
        ResultsError::Unsupported("result array has no validated FEM playback descriptor".into())
    })?;
    let array = array_to_public(root, entry, Some(&context), revision, scan.root_policy)?;
    let geometry = array.geometry.as_ref().ok_or_else(|| {
        ResultsError::Unsupported("result array has no exact FEM geometry binding".into())
    })?;
    if !array.can_visualize_3d
        || geometry.kind != WorkspaceResultGeometryKind::FemP1
        || geometry.playback_geometry_sha256.is_none()
    {
        return Err(ResultsError::Unsupported(
            "result array is not an exact FEM playback vector".into(),
        ));
    }
    ensure_unchanged(root, revision)?;
    Ok(context.playback.revision)
}

/// Re-check the result-folder revision after a secondary payload read (for
/// example canonical FEM topology/support encoding).
pub fn ensure_results_revision(
    root: &Path,
    revision: &str,
    expected_run_id: Option<&str>,
) -> Result<(), ResultsError> {
    let _read_budget = ReadBudget::begin();
    let scan = scan_root(root)?;
    ensure_expected_revision(&scan.revision, revision)?;
    let _ = read_and_validate_run_id(root, expected_run_id)?;
    Ok(())
}

// ── bounded source scan ────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RawKind {
    Directory,
    ZarrGroup,
    Array,
    File,
}

#[derive(Debug, Clone)]
struct RawEntry {
    relative: PathBuf,
    path: PathBuf,
    kind: RawKind,
    size: u64,
    modified: Option<SystemTime>,
}

impl RawEntry {
    fn entry_id(&self) -> String {
        opaque_id("entry", &self.relative)
    }

    fn array_id(&self) -> String {
        opaque_id("array", &self.relative)
    }
}

#[derive(Debug)]
struct Scan {
    entries: Vec<RawEntry>,
    revision: String,
    root_policy: ResultsRootPolicy,
}

fn scan_root(root: &Path) -> Result<Scan, ResultsError> {
    let pinned = open_directory(root)
        .map_err(|error| ResultsError::Link(format!("cannot pin results directory: {error}")))?;
    let mut entries = Vec::new();
    walk_directory(&pinned, Path::new(""), 0, &mut entries)?;
    entries.sort_by(|left, right| left.relative.cmp(&right.relative));
    let arrays = entries
        .iter()
        .filter(|entry| {
            entry
                .relative
                .file_name()
                .is_some_and(|name| name == ".zarray")
        })
        .filter_map(|entry| entry.relative.parent().map(Path::to_path_buf))
        .collect::<BTreeSet<_>>();
    let groups = entries
        .iter()
        .filter(|entry| {
            entry
                .relative
                .file_name()
                .is_some_and(|name| name == ".zgroup")
        })
        .filter_map(|entry| entry.relative.parent().map(Path::to_path_buf))
        .collect::<BTreeSet<_>>();
    for entry in &mut entries {
        charge_metadata(0)?;
        if matches!(entry.kind, RawKind::Directory) {
            if arrays.contains(&entry.relative) {
                entry.kind = RawKind::Array;
            } else if groups.contains(&entry.relative) {
                entry.kind = RawKind::ZarrGroup;
            }
        }
    }
    let revision = revision_of(&entries)?;
    let root_policy = read_results_root_policy(root)?;
    Ok(Scan { entries, revision, root_policy })
}

fn walk_directory(
    directory: &PinnedDirectory,
    relative: &Path,
    depth: usize,
    entries: &mut Vec<RawEntry>,
) -> Result<(), ResultsError> {
    if depth > MAX_DEPTH {
        return Err(ResultsError::TooLarge(format!(
            "folder depth exceeds {MAX_DEPTH}"
        )));
    }
    if let Some(zarray) = array_metadata_entry(directory, relative, ".zarray")? {
        // A validated Zarr array is a logical boundary. Its payload chunks
        // are addressed by sample index and are intentionally not inventoried
        // as individual files; only bounded metadata and the explicit sample
        // coordinate sidecar participate in the folder catalog. The parent
        // array directory remains in the revision. Payload file metadata is
        // fingerprinted separately, so in-place updates also invalidate the
        // snapshot without exposing a tree entry for every binary chunk.
        let mut metadata_entries = vec![zarray];
        for name in [".zattrs", "samples.csv", ".fullmag-samples.json"] {
            if let Some(entry) = array_metadata_entry(directory, relative, name)? {
                metadata_entries.push(entry);
            }
        }
        entries.extend(metadata_entries);
        return Ok(());
    }
    let mut children = Vec::new();
    let remaining = MAX_ENTRIES.saturating_sub(entries.len());
    let read_dir = directory.read_dir().map_err(|error| {
        ResultsError::Io(format!("{}: {error}", directory.logical_path().display()))
    })?;
    for child in read_dir {
        let child = child.map_err(|error| {
            ResultsError::Io(format!("{}: {error}", directory.logical_path().display()))
        })?;
        let name = child.file_name();
        let child_relative = relative.join(&name);
        charge_scan_path(&child_relative)?;
        children.push(child);
        if children.len() > remaining {
            return Err(ResultsError::TooLarge(format!(
                "folder exceeds {MAX_ENTRIES} entries"
            )));
        }
    }
    children.sort_by_key(|entry| entry.file_name());
    for child in children {
        charge_metadata(SCAN_ENTRY_METADATA_BYTES)?;
        if entries.len() >= MAX_ENTRIES {
            return Err(ResultsError::TooLarge(format!(
                "folder exceeds {MAX_ENTRIES} entries"
            )));
        }
        let name = child.file_name();
        let child_relative = relative.join(&name);
        let child_path = directory.logical_path().join(&name);
        let metadata = child
            .metadata()
            .map_err(|error| ResultsError::Io(error.to_string()))?;
        reject_reparse(&child_path, &metadata)?;
        if !metadata.is_dir() && !metadata.is_file() {
            return Err(ResultsError::Unsupported(
                "results contain a non-regular file".into(),
            ));
        }
        let kind = if metadata.is_dir() {
            RawKind::Directory
        } else {
            RawKind::File
        };
        entries.push(RawEntry {
            relative: child_relative.clone(),
            path: child_path.clone(),
            kind,
            size: metadata.len(),
            modified: metadata.modified().ok(),
        });
        if metadata.is_dir() {
            let pinned = directory
                .open_child_directory(&name)
                .map_err(|_error| {
                    #[cfg(test)]
                    eprintln!(
                        "results SourceChanged: directory open failed path={} error={} raw_os_error={:?}",
                        child_path.display(),
                        _error,
                        _error.raw_os_error()
                    );
                    ResultsError::SourceChanged
                })?;
            walk_directory(&pinned, &child_relative, depth + 1, entries)?;
        }
    }
    Ok(())
}

fn array_metadata_entry(
    directory: &PinnedDirectory,
    relative: &Path,
    name: &str,
) -> Result<Option<RawEntry>, ResultsError> {
    let child_relative = relative.join(name);
    charge_scan_path(&child_relative)?;
    let file = match directory.open_child_regular(std::ffi::OsStr::new(name)) {
        Ok(file) => file,
        // This is a classification probe: ordinary directories have no Zarr marker.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => {
            return Err(ResultsError::Link(child_relative.display().to_string()))
        }
        Err(error) => return Err(ResultsError::Io(error.to_string())),
    };
    let metadata = file
        .metadata()
        .map_err(|error| ResultsError::Io(error.to_string()))?;
    charge_metadata(SCAN_ENTRY_METADATA_BYTES)?;
    Ok(Some(RawEntry {
        relative: child_relative,
        path: directory.logical_path().join(name),
        kind: RawKind::File,
        size: metadata.len(),
        modified: metadata.modified().ok(),
    }))
}

fn charge_scan_path(path: &Path) -> Result<(), ResultsError> {
    let length = path.to_string_lossy().len();
    if length > MAX_PATH_BYTES {
        return Err(ResultsError::TooLarge(format!(
            "result path exceeds {MAX_PATH_BYTES} bytes"
        )));
    }
    charge_metadata(length as u64 + SCAN_ENTRY_METADATA_BYTES)
}

fn symlink_metadata(path: &Path) -> Result<Metadata, ResultsError> {
    fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ResultsError::NotFound(path.display().to_string())
        } else {
            ResultsError::Io(format!("{}: {error}", path.display()))
        }
    })
}

fn reject_reparse(path: &Path, metadata: &Metadata) -> Result<(), ResultsError> {
    if metadata.file_type().is_symlink() {
        return Err(ResultsError::Link(path.display().to_string()));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(ResultsError::Link(path.display().to_string()));
        }
    }
    Ok(())
}

/// Fingerprint payload metadata independently of logical Explorer entries.
/// Never read chunk contents here. Hashes are sorted to make the revision
/// independent of filesystem enumeration order; the shared read budget bounds
/// both the traversal and the accumulated fixed-size hashes.
fn array_payload_revision(directory: &PinnedDirectory) -> Result<Vec<[u8; 32]>, ResultsError> {
    fn visit(
        directory: &PinnedDirectory,
        relative: &Path,
        depth: usize,
        hashes: &mut Vec<[u8; 32]>,
    ) -> Result<(), ResultsError> {
        if depth > MAX_DEPTH {
            return Err(ResultsError::TooLarge(
                "array chunk directory depth exceeds limit".into(),
            ));
        }
        for child in directory
            .read_dir()
            .map_err(|error| ResultsError::Io(error.to_string()))?
        {
            let child = child.map_err(|error| ResultsError::Io(error.to_string()))?;
            let name = child.file_name();
            let relative = relative.join(&name);
            charge_scan_path(&relative)?;
            charge_metadata(SCAN_ENTRY_METADATA_BYTES + 32)?;
            let metadata = child
                .metadata()
                .map_err(|error| ResultsError::Io(error.to_string()))?;
            reject_reparse(&relative, &metadata)?;
            if !metadata.is_file() && !metadata.is_dir() {
                return Err(ResultsError::Unsupported(
                    "array contains a non-regular chunk".into(),
                ));
            }
            let mut hash = Sha256::new();
            hash.update(relative.to_string_lossy().replace('\\', "/").as_bytes());
            hash.update([0, u8::from(metadata.is_dir())]);
            hash.update(metadata.len().to_le_bytes());
            if let Ok(modified) = metadata.modified() {
                if let Ok(duration) = modified.duration_since(UNIX_EPOCH) {
                    hash.update(duration.as_secs().to_le_bytes());
                    hash.update(duration.subsec_nanos().to_le_bytes());
                }
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                hash.update(metadata.dev().to_le_bytes());
                hash.update(metadata.ino().to_le_bytes());
                hash.update(metadata.ctime().to_le_bytes());
                hash.update(metadata.ctime_nsec().to_le_bytes());
            }
            hashes.push(hash.finalize().into());
            if metadata.is_dir() {
                let pinned = directory
                    .open_child_directory(&name)
                    .map_err(|_error| {
                        #[cfg(test)]
                        eprintln!(
                            "results SourceChanged: array payload directory open failed path={} error={} raw_os_error={:?}",
                            directory.logical_path().join(&name).display(),
                            _error,
                            _error.raw_os_error()
                        );
                        ResultsError::SourceChanged
                    })?;
                visit(&pinned, &relative, depth + 1, hashes)?;
            }
        }
        Ok(())
    }
    let mut hashes = Vec::new();
    visit(directory, Path::new(""), 0, &mut hashes)?;
    hashes.sort_unstable();
    Ok(hashes)
}

fn revision_of(entries: &[RawEntry]) -> Result<String, ResultsError> {
    let mut hasher = Sha256::new();
    for entry in entries {
        charge_scan_path(&entry.relative)?;
        hasher.update(
            entry
                .relative
                .to_string_lossy()
                .replace('\\', "/")
                .as_bytes(),
        );
        hasher.update([0]);
        hasher.update([match entry.kind {
            RawKind::Directory => b'd',
            RawKind::ZarrGroup => b'g',
            RawKind::Array => b'a',
            RawKind::File => b'f',
        }]);
        hasher.update(entry.size.to_le_bytes());
        if let Some(modified) = entry.modified {
            if let Ok(duration) = modified.duration_since(UNIX_EPOCH) {
                hasher.update(duration.as_secs().to_le_bytes());
                hasher.update(duration.subsec_nanos().to_le_bytes());
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if let Ok(metadata) = fs::symlink_metadata(&entry.path) {
                hasher.update(metadata.dev().to_le_bytes());
                hasher.update(metadata.ino().to_le_bytes());
            }
        }
        if matches!(entry.kind, RawKind::Array) {
            let directory = open_directory(&entry.path).map_err(|_error| {
                #[cfg(test)]
                eprintln!(
                    "results SourceChanged: array directory reopen failed path={} error={} raw_os_error={:?}",
                    entry.path.display(),
                    _error,
                    _error.raw_os_error()
                );
                ResultsError::SourceChanged
            })?;
            for digest in array_payload_revision(&directory)? {
                hasher.update(digest);
            }
        }
        if matches!(entry.kind, RawKind::File) && is_revision_metadata_path(&entry.relative) {
            if entry.size > MAX_JSON_BYTES {
                return Err(ResultsError::TooLarge(format!(
                    "critical result metadata exceeds {} bytes: {}",
                    MAX_JSON_BYTES,
                    entry.relative.display()
                )));
            }
            charge_metadata(entry.size)?;
            let bytes = read_exact_payload(
                &entry.path,
                usize::try_from(entry.size)
                    .map_err(|_| ResultsError::TooLarge(entry.relative.display().to_string()))?,
            )?;
            let digest = Sha256::digest(&bytes);
            hasher.update([b'c']);
            hasher.update((bytes.len() as u64).to_le_bytes());
            hasher.update(digest);
        }
    }
    Ok(format!("sha256:{}", hex_bytes(&hasher.finalize())))
}

fn is_revision_metadata_path(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    matches!(
        name,
        ".zarray"
            | ".zattrs"
            | ".zgroup"
            | "playback.json"
            | "fullmag-run.json"
            | "run.json"
            | "run_manifest.json"
            | "metadata.json"
            | "output-storage.json"
            | "manifest.json"
            | "samples.csv"
            | ".fullmag-samples.json"
            | "index.jsonl"
    )
}

fn ensure_unchanged(root: &Path, revision: &str) -> Result<(), ResultsError> {
    let after = scan_root(root)?.revision;
    if after == revision {
        Ok(())
    } else {
        #[cfg(test)]
        eprintln!(
            "results SourceChanged: revision drift root={} expected={} actual={}",
            root.display(),
            revision,
            after
        );
        Err(ResultsError::SourceChanged)
    }
}

fn ensure_expected_revision(actual: &str, expected: &str) -> Result<(), ResultsError> {
    if actual == expected {
        Ok(())
    } else {
        Err(ResultsError::StaleRevision)
    }
}

fn parse_cursor(cursor: Option<&str>) -> Result<(Option<&str>, usize), ResultsError> {
    let Some(cursor) = cursor.filter(|value| !value.is_empty()) else {
        return Ok((None, 0));
    };
    let (revision, offset) = cursor
        .rsplit_once(':')
        .ok_or_else(|| ResultsError::Cursor("expected a revision-pinned cursor".into()))?;
    let hash = revision
        .strip_prefix("sha256:")
        .ok_or_else(|| ResultsError::Cursor("invalid cursor revision".into()))?;
    if hash.len() != 64
        || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        || offset.len() > 12
        || offset.is_empty()
        || !offset.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(ResultsError::Cursor(
            "invalid revision-pinned cursor".into(),
        ));
    }
    Ok((
        Some(revision),
        offset
            .parse()
            .map_err(|_| ResultsError::Cursor("offset is out of range".into()))?,
    ))
}

fn opaque_id(prefix: &str, relative: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(relative.to_string_lossy().replace('\\', "/").as_bytes());
    format!("{prefix}:{}", hex_bytes(&hasher.finalize()))
}

fn hex_bytes(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push(HEX[(byte >> 4) as usize] as char);
        text.push(HEX[(byte & 0x0f) as usize] as char);
    }
    text
}

// ── catalog entries and Zarr arrays ────────────────────────────────────────

fn entry_to_public(
    root: &Path,
    entry: &RawEntry,
    scan: &Scan,
    geometry: Option<&GeometryContext>,
) -> Result<WorkspaceResultEntry, ResultsError> {
    charge_metadata(0)?;
    let name = entry
        .relative
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let parent_id = entry
        .relative
        .parent()
        .and_then(|parent| (!parent.as_os_str().is_empty()).then(|| opaque_id("entry", parent)));
    let path = relative_display(&entry.relative);
    let (kind, array_id, status, reason, format, mime_type) = match entry.kind {
        RawKind::Directory => (
            WorkspaceResultEntryKind::Directory,
            None,
            WorkspaceResultEntryStatus::Ready,
            None,
            Some("directory".into()),
            None,
        ),
        RawKind::ZarrGroup => (
            WorkspaceResultEntryKind::ZarrGroup,
            None,
            WorkspaceResultEntryStatus::Ready,
            None,
            Some("zarr_v2".into()),
            Some("application/json; charset=utf-8".into()),
        ),
        RawKind::Array => match array_to_public(root, entry, geometry, "catalog-metadata-only", scan.root_policy) {
            Ok(array) => (
                WorkspaceResultEntryKind::ZarrArray,
                Some(array.id),
                if array.can_read_values {
                    WorkspaceResultEntryStatus::Ready
                } else {
                    WorkspaceResultEntryStatus::MetadataOnly
                },
                array.reason,
                Some("zarr_v2".into()),
                Some("application/json; charset=utf-8".into()),
            ),
            Err(error) => (
                WorkspaceResultEntryKind::ZarrArray,
                Some(entry.array_id()),
                match error {
                    ResultsError::Unsupported(_) => WorkspaceResultEntryStatus::MetadataOnly,
                    _ => WorkspaceResultEntryStatus::Unreadable,
                },
                Some(error.to_string()),
                Some("zarr_v2".into()),
                Some("application/json; charset=utf-8".into()),
            ),
        },
        RawKind::File => (
            WorkspaceResultEntryKind::File,
            None,
            if is_zarr_chunk(&entry.relative) {
                WorkspaceResultEntryStatus::MetadataOnly
            } else {
                WorkspaceResultEntryStatus::Ready
            },
            None,
            file_format(&entry.relative),
            Some(mime_type(&entry.relative)),
        ),
    };
    let _ = scan;
    Ok(WorkspaceResultEntry {
        id: entry.entry_id(),
        path,
        parent_id,
        name,
        kind,
        size_bytes: (!matches!(
            entry.kind,
            RawKind::Directory | RawKind::ZarrGroup | RawKind::Array
        ))
        .then_some(entry.size),
        array_id,
        mime_type,
        format,
        status,
        reason,
    })
}

fn find_array<'a>(scan: &'a Scan, array_id: &str) -> Result<&'a RawEntry, ResultsError> {
    scan.entries
        .iter()
        .find(|entry| {
            matches!(entry.kind, RawKind::Array)
                && !is_internal_geometry_path(&entry.relative)
                && entry.array_id() == array_id
        })
        .ok_or_else(|| ResultsError::NotFound(format!("array {array_id}")))
}

fn is_internal_geometry_path(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(component, std::path::Component::Normal(name)
            if name == OsStr::new(FEM_NODAL_OBJECT_DIRECTORY))
    })
}

fn validate_fem_nodal_array_binding(
    entry: &RawEntry,
    metadata: &ArrayMetadata,
    binding: &SavedFemNodalArrayBinding,
) -> Result<PathBuf, ResultsError> {
    let invalid = |detail: &str| {
        ResultsError::Invalid(format!(
            "FEM nodal binding does not match its Zarr array: {detail}"
        ))
    };
    let binding_path = Path::new(&binding.array_path);
    let store_relative = entry.relative.ancestors().nth(binding_path.components().count())
        .ok_or_else(|| invalid("array_path is outside the owning store"))?.to_path_buf();
    if store_relative.join(binding_path) != entry.relative {
        return Err(invalid("array_path differs from the owning array path"));
    }

    let quantity = binding.quantity_id.as_str();
    let quantity_keys = ["quantity", "quantity_id", "observable"];
    let mut found_quantity = false;
    for key in quantity_keys {
        if let Some(value) = metadata.attrs.get(key) {
            found_quantity = true;
            if value.as_str() != Some(quantity) {
                return Err(invalid("quantity metadata is missing or contradictory"));
            }
        }
    }
    if !found_quantity
        || metadata.quantity_id.as_deref() != Some(quantity)
        || metadata.quantity_ids.len() != 1
        || metadata.quantity_ids.first().map(String::as_str) != Some(quantity)
    {
        return Err(invalid(
            "quantity metadata does not bind exactly one quantity",
        ));
    }

    if metadata.attrs.get("unit").and_then(Value::as_str) != Some(binding.unit.as_str()) {
        return Err(invalid("unit differs from the bound field semantics"));
    }

    let layout = binding.field_layout.as_str();
    let layout_keys = ["field_layout", "storage_layout", "layout"];
    let mut found_layout = false;
    for key in layout_keys {
        if let Some(value) = metadata.attrs.get(key) {
            found_layout = true;
            if value.as_str() != Some(layout) {
                return Err(invalid("layout metadata is missing or contradictory"));
            }
        }
    }
    if !found_layout {
        return Err(invalid("explicit field layout is missing"));
    }

    if let Some(value) = metadata.attrs.get("component_count") {
        let component_count = value.as_u64().and_then(|value| usize::try_from(value).ok());
        if component_count != Some(binding.component_count) {
            return Err(invalid("component_count differs from the bound field"));
        }
    }
    if metadata
        .component_count
        .is_some_and(|count| count != binding.component_count)
    {
        return Err(invalid("component_count differs from the bound field"));
    }

    let width = binding
        .node_count
        .checked_mul(binding.component_count)
        .ok_or_else(|| invalid("node_count times component_count overflows"))?;
    let width = u64::try_from(width).map_err(|_| invalid("field width exceeds u64"))?;
    if metadata.shape.len() != 2
        || metadata.shape[1] != width
        || metadata.chunks.len() != 2
        || metadata.chunks[0] != 1
        || metadata.chunks[1] != width
        || metadata.dimension_order.len() != 2
        || metadata.dimension_order[0] != "sample"
        || metadata.dimension_order[1] != "value"
    {
        return Err(invalid(
            "shape, chunks, or dimension_order differ from the flattened nodal field",
        ));
    }
    Ok(store_relative)
}

fn fem_nodal_object_name(
    reference: &SavedFieldGeometryRef,
) -> Result<std::ffi::OsString, ResultsError> {
    let relative = fem_nodal_object_relative_path(reference).map_err(|error| {
        ResultsError::Invalid(format!("invalid FEM geometry reference: {error}"))
    })?;
    let path = Path::new(&relative);
    if path.parent() != Some(Path::new(FEM_NODAL_OBJECT_DIRECTORY)) {
        return Err(ResultsError::Invalid(
            "FEM geometry reference is outside its immutable object directory".into(),
        ));
    }
    path.file_name()
        .map(std::ffi::OsStr::to_os_string)
        .ok_or_else(|| ResultsError::Invalid("FEM geometry reference has no object name".into()))
}

fn fem_geometry_open_error(name: &str, error: std::io::Error) -> ResultsError {
    if error.kind() == std::io::ErrorKind::NotFound {
        return ResultsError::Invalid(format!("referenced FEM geometry object is missing: {name}"));
    }
    let is_symlink = {
        #[cfg(unix)]
        {
            error.raw_os_error() == Some(libc::ELOOP)
        }
        #[cfg(not(unix))]
        {
            false
        }
    };
    if error.kind() == std::io::ErrorKind::InvalidInput || is_symlink {
        return ResultsError::Link(format!("unsafe FEM geometry object path: {name}"));
    }
    ResultsError::Io(format!("cannot open FEM geometry object {name}: {error}"))
}

#[derive(Debug, Clone)]
struct ArrayMetadata {
    shape: Vec<u64>,
    chunks: Vec<u64>,
    dtype: String,
    order: Option<String>,
    compressor: Option<String>,
    filters_present: bool,
    dimension_separator: Option<String>,
    dimension_order: Vec<String>,
    quantity_id: Option<String>,
    quantity_ids: Vec<String>,
    unit: Option<String>,
    field_layout: Option<String>,
    component_count: Option<usize>,
    attrs: Value,
    published_coordinates: Option<Vec<WorkspaceResultSampleCoordinate>>,
}

const SAMPLE_PUBLICATION_SCHEMA: &str = "fullmag.zarr.sample_publication.v1";
const SAMPLE_PUBLICATION_FILE: &str = ".fullmag-samples.json";
const SAMPLE_COORDINATE_HEADER: &str = "sample,physical_time_s,accepted_step";
const ACCEPTED_RESULTS_PUBLICATION_SCHEMA: &str = "fullmag.accepted_results_publication.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ResultsRootPolicy {
    require_sample_publication: bool,
}

fn read_results_root_policy(root: &Path) -> Result<ResultsRootPolicy, ResultsError> {
    let descriptor = match read_json(&root.join("run.json")) {
        Ok(value) => value,
        Err(ResultsError::NotFound(_)) => {
            return Ok(ResultsRootPolicy {
                require_sample_publication: false,
            });
        }
        Err(error) => return Err(error),
    };
    let Some(publication) = descriptor.get("publication") else {
        if !descriptor.is_object() {
            return Err(ResultsError::Invalid(
                "results run.json must be an object".into(),
            ));
        }
        return Ok(ResultsRootPolicy {
            require_sample_publication: false,
        });
    };
    if publication.get("schema").and_then(Value::as_str)
        != Some(ACCEPTED_RESULTS_PUBLICATION_SCHEMA)
        || publication.get("sample_policy").and_then(Value::as_str)
            != Some(SAMPLE_PUBLICATION_SCHEMA)
    {
        return Err(ResultsError::Invalid(
            "unsupported or malformed accepted-results publication policy".into(),
        ));
    }
    Ok(ResultsRootPolicy {
        require_sample_publication: true,
    })
}

fn parse_array_metadata_for_root(
    root: &Path,
    directory: &Path,
    policy: ResultsRootPolicy,
) -> Result<ArrayMetadata, ResultsError> {
    let metadata = parse_array_metadata(directory)?;
    if policy.require_sample_publication && metadata.published_coordinates.is_none() {
        let relative = directory
            .strip_prefix(root)
            .map(relative_display)
            .unwrap_or_else(|_| "array outside results root".into());
        return Err(ResultsError::Invalid(format!(
            "incremental results array is missing a valid sample-publication watermark: {relative}"
        )));
    }
    Ok(metadata)
}

/// New autosave arrays expose only a committed prefix. An absent policy is the
/// legacy contract, but an orphan marker or an unknown policy fails closed.
fn read_sample_publication(
    directory: &Path,
    attrs: &Value,
    shape: &mut [u64],
) -> Result<Option<Vec<WorkspaceResultSampleCoordinate>>, ResultsError> {
    let publication = match read_json(&directory.join(SAMPLE_PUBLICATION_FILE)) {
        Ok(value) => Some(value),
        Err(ResultsError::NotFound(_)) => None,
        Err(error) => return Err(error),
    };
    let policy = attrs.get("sample_publication");
    if policy.is_none() && publication.is_none() {
        return Ok(None);
    }
    let invalid = || ResultsError::Invalid("invalid Zarr sample publication".into());
    if policy.and_then(Value::as_str) != Some(SAMPLE_PUBLICATION_SCHEMA) {
        return Err(invalid());
    }
    let publication = publication.ok_or_else(invalid)?;
    if publication.get("schema_version").and_then(Value::as_str) != Some(SAMPLE_PUBLICATION_SCHEMA)
    {
        return Err(invalid());
    }
    let count = publication
        .get("committed_samples")
        .and_then(Value::as_u64)
        .ok_or_else(invalid)?;
    let length = publication
        .get("coordinate_bytes")
        .and_then(Value::as_u64)
        .ok_or_else(invalid)?;
    if count > shape[0] || length < (SAMPLE_COORDINATE_HEADER.len() + 1) as u64 {
        return Err(invalid());
    }
    if length > MAX_JSON_BYTES {
        return Err(ResultsError::TooLarge(
            "published coordinate prefix exceeds metadata budget".into(),
        ));
    }
    charge_metadata(length)?;
    let length = usize::try_from(length).map_err(|_| invalid())?;
    let bytes = read_prefix(&directory.join("samples.csv"), length)?;
    if bytes.len() != length || bytes.last() != Some(&b'\n') {
        return Err(invalid());
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| invalid())?;
    let mut lines = text.lines();
    if lines.next() != Some(SAMPLE_COORDINATE_HEADER) {
        return Err(invalid());
    }
    let mut coordinates = Vec::new();
    let mut rows = 0_u64;
    for line in lines {
        let mut columns = line.split(',');
        let index = columns
            .next()
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(invalid)?;
        let time = columns.next().ok_or_else(invalid)?;
        let step = columns.next().ok_or_else(invalid)?;
        if columns.next().is_some() || index != rows || rows >= count {
            return Err(invalid());
        }
        let index = usize::try_from(index).map_err(|_| invalid())?;
        let coordinate = if !time.is_empty() && step.is_empty() {
            let value = time
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite())
                .ok_or_else(invalid)?;
            WorkspaceResultSampleCoordinate {
                sample_index: index,
                kind: WorkspaceResultCoordinateKind::PhysicalTime,
                value: Some(value),
                accepted_step: None,
            }
        } else if time.is_empty() && !step.is_empty() {
            accepted_step_coordinate(
                index,
                step.parse::<u64>().map_err(|_| invalid())?.to_string(),
            )
        } else {
            return Err(invalid());
        };
        if coordinates.len() < MAX_COORDINATES {
            coordinates.push(coordinate);
        }
        rows += 1;
    }
    if rows != count {
        return Err(invalid());
    }
    shape[0] = count;
    Ok(Some(coordinates))
}

fn parse_array_metadata(directory: &Path) -> Result<ArrayMetadata, ResultsError> {
    let zarray = read_json(&directory.join(".zarray"))?;
    let mut shape = json_u64_vec(zarray.get("shape"), "shape")?;
    let chunks = json_u64_vec(zarray.get("chunks"), "chunks")?;
    if shape.is_empty() || shape.len() != chunks.len() || chunks.iter().any(|chunk| *chunk == 0) {
        return Err(ResultsError::Invalid(format!(
            "invalid Zarr shape/chunks in {}",
            directory.display()
        )));
    }
    let dtype = zarray
        .get("dtype")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ResultsError::Invalid(format!("Zarr dtype is missing in {}", directory.display()))
        })?
        .to_string();
    let compressor = zarray.get("compressor").and_then(|value| {
        (!value.is_null())
            .then(|| serde_json::to_string(value).unwrap_or_else(|_| "compressed".into()))
    });
    let filters_present = zarray.get("filters").is_some_and(|value| !value.is_null());
    let dimension_separator = zarray
        .get("dimension_separator")
        .and_then(Value::as_str)
        .or_else(|| zarray.get("dimension-separator").and_then(Value::as_str))
        .map(str::to_string);
    let order = zarray
        .get("order")
        .and_then(Value::as_str)
        .map(str::to_string);
    // Malformed attributes cannot silently downgrade a publication-aware array
    // to the legacy shape-only contract.
    let attrs = match read_json(&directory.join(".zattrs")) {
        Ok(attrs) => attrs,
        Err(ResultsError::NotFound(_)) => Value::Null,
        Err(error) => return Err(error),
    };
    let published_coordinates = read_sample_publication(directory, &attrs, &mut shape)?;
    let dimension_order = match attrs.get("dimension_order") {
        None => Vec::new(),
        Some(value) => {
            let values = value.as_array().ok_or_else(|| {
                ResultsError::Invalid(format!(
                    "Zarr dimension_order must be a non-empty array of non-empty strings in {}",
                    directory.display()
                ))
            })?;
            if values.is_empty() {
                return Err(ResultsError::Invalid(format!(
                    "Zarr dimension_order must be a non-empty array of non-empty strings in {}",
                    directory.display()
                )));
            }
            values
                .iter()
                .map(|value| {
                    let dimension = value.as_str().ok_or_else(|| {
                        ResultsError::Invalid(format!(
                            "Zarr dimension_order must be a non-empty array of non-empty strings in {}",
                            directory.display()
                        ))
                    })?;
                    if dimension.trim().is_empty() {
                        return Err(ResultsError::Invalid(format!(
                            "Zarr dimension_order must be a non-empty array of non-empty strings in {}",
                            directory.display()
                        )));
                    }
                    Ok(dimension.to_string())
                })
                .collect::<Result<Vec<_>, ResultsError>>()?
        }
    };
    let mut quantity_id = attrs
        .get("quantity")
        .or_else(|| attrs.get("quantity_id"))
        .or_else(|| attrs.get("observable"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut quantity_ids = match attrs.get("quantities") {
        None => Vec::new(),
        Some(value) => {
            let values = value.as_array().ok_or_else(|| {
                ResultsError::Invalid(format!(
                    "Zarr quantities must be a non-empty array of non-empty strings in {}",
                    directory.display()
                ))
            })?;
            if values.is_empty() {
                return Err(ResultsError::Invalid(format!(
                    "Zarr quantities must be a non-empty array of non-empty strings in {}",
                    directory.display()
                )));
            }
            values
                .iter()
                .map(|value| {
                    let quantity = value.as_str().ok_or_else(|| {
                        ResultsError::Invalid(format!(
                            "Zarr quantities must be a non-empty array of non-empty strings in {}",
                            directory.display()
                        ))
                    })?;
                    if quantity.trim().is_empty() {
                        return Err(ResultsError::Invalid(format!(
                            "Zarr quantities must be a non-empty array of non-empty strings in {}",
                            directory.display()
                        )));
                    }
                    Ok(quantity.to_string())
                })
                .collect::<Result<Vec<_>, ResultsError>>()?
        }
    };
    let quantity_axes = dimension_order
        .iter()
        .enumerate()
        .filter_map(|(index, dimension)| (dimension == "quantity").then_some(index))
        .collect::<Vec<_>>();
    if !quantity_axes.is_empty() {
        let quantity_axis = quantity_axes[0];
        if quantity_axes.len() != 1
            || dimension_order.len() != shape.len()
            || dimension_order.first().map(String::as_str) != Some("sample")
            || quantity_axis == 0
            || quantity_axis >= shape.len()
        {
            return Err(ResultsError::Invalid(format!(
                "Zarr quantity axis must be a non-zero axis after sample and match shape rank in {}",
                directory.display()
            )));
        }
        if !quantity_ids.is_empty()
            && usize::try_from(shape[quantity_axis]).ok() != Some(quantity_ids.len())
        {
            return Err(ResultsError::Invalid(format!(
                "Zarr quantity label count does not match the quantity axis in {}",
                directory.display()
            )));
        }
    }
    if quantity_ids.is_empty() {
        if let Some(quantity_id) = quantity_id.as_ref() {
            quantity_ids.push(quantity_id.clone());
        }
    }
    if quantity_id.is_none() {
        quantity_id = quantity_ids.first().cloned();
    }
    let field_layout = attrs
        .get("storage_layout")
        .and_then(Value::as_str)
        .or_else(|| attrs.get("layout").and_then(Value::as_str))
        .or_else(|| attrs.get("field_layout").and_then(Value::as_str))
        .map(str::to_string);
    let component_count = attrs
        .get("component_count")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok());
    Ok(ArrayMetadata {
        shape,
        chunks,
        dtype,
        order,
        compressor,
        filters_present,
        dimension_separator,
        dimension_order,
        quantity_id,
        quantity_ids,
        unit: attrs
            .get("unit")
            .and_then(Value::as_str)
            .map(str::to_string),
        field_layout,
        component_count,
        attrs,
        published_coordinates,
    })
}

fn array_to_public(
    root: &Path,
    entry: &RawEntry,
    geometry: Option<&GeometryContext>,
    revision: &str,
    policy: ResultsRootPolicy,
) -> Result<WorkspaceResultArray, ResultsError> {
    let metadata = parse_array_metadata_for_root(root, &entry.path, policy)?;
    array_to_public_with_metadata(root, entry, geometry, revision, metadata)
}

fn array_to_public_with_metadata(
    root: &Path,
    entry: &RawEntry,
    geometry: Option<&GeometryContext>,
    revision: &str,
    mut metadata: ArrayMetadata,
) -> Result<WorkspaceResultArray, ResultsError> {
    let has_fem_nodal_binding = metadata.attrs.get("fem_nodal_binding").is_some();
    let sample_count = usize::try_from(metadata.shape[0])
        .map_err(|_| ResultsError::TooLarge("sample count exceeds usize".into()))?;
    let descriptor_stage = if has_fem_nodal_binding {
        None
    } else {
        geometry.and_then(|context| playback_stage(context, entry))
    };
    // The legacy playback sidecar is itself the producer declaration for the
    // exact m array.  Older FDM folders have no .zattrs, so retain that
    // explicit identity without inferring it from a vector length.
    if descriptor_stage.is_some() && metadata.quantity_id.is_none() {
        metadata.quantity_id = Some("m".into());
        metadata.quantity_ids = vec!["m".into()];
    }
    if descriptor_stage.is_some() && metadata.component_count.is_none() {
        metadata.component_count = Some(3);
    }
    // Stage autosave Zarr predates the native artifact writer and only stores
    // `quantity` plus `dimension_order`. The component count below comes
    // from the stable quantity schema, never from a vector length or the
    // active mesh. Native arrays carry their explicit layout declaration in
    // `.zattrs` or in the FEM playback stage descriptor; never infer AoS from
    // a `fields` path or vector quantity.
    if metadata.component_count.is_none() {
        metadata.component_count = if metadata
            .dimension_order
            .iter()
            .any(|dimension| dimension == "quantity")
        {
            (!metadata.quantity_ids.is_empty()).then_some(metadata.quantity_ids.len())
        } else {
            metadata
                .quantity_id
                .as_deref()
                .and_then(known_quantity_components)
        };
    }
    if metadata.field_layout.is_none() {
        if let Some(layout) = descriptor_stage.and_then(|stage| stage.field_layout.as_deref()) {
            metadata.field_layout = Some(layout.to_string());
        } else if let (Some(context), Some(stage)) = (geometry, descriptor_stage) {
            // Older FDM playback descriptors predate `field_layout`.  The
            // descriptor still binds this exact array path and its validated
            // rank-2 shape to the cell grid, which is sufficient to carry the
            // legacy AoS contract into the public metadata.  Do not apply the
            // fallback to arbitrary fields/* arrays or to FEM descriptors.
            if !context.fem_descriptor_declared
                && playback_fdm_geometry(context, stage, &metadata).is_some()
            {
                metadata.field_layout = Some("aos_node_major".into());
            }
        }
    }
    let coordinates = if revision == "catalog-metadata-only" {
        Vec::new()
    } else if let Some(coordinates) = metadata.published_coordinates.as_ref() {
        coordinates.clone()
    } else if let Some(stage) = descriptor_stage.filter(|stage| stage.frame_count == sample_count) {
        // A completed playback descriptor binds physical times to this exact
        // array. The older continuous index may count different fields in one
        // sequence, which is not a field-local sample index.
        stage
            .times_s
            .iter()
            .copied()
            .take(MAX_COORDINATES)
            .enumerate()
            .map(|(sample_index, time)| WorkspaceResultSampleCoordinate {
                sample_index,
                kind: WorkspaceResultCoordinateKind::PhysicalTime,
                value: Some(time),
                accepted_step: None,
            })
            .collect()
    } else {
        read_sample_coordinates(root, &entry.relative, sample_count)?
    };
    let value_capable = is_supported_f64(&metadata) && sample_byte_length(&metadata).is_ok();
    let mut reason = None;
    if !value_capable {
        reason = Some(if metadata.compressor.is_some() {
            "compressed Zarr arrays are metadata-only".into()
        } else if metadata.filters_present {
            "filtered Zarr arrays are metadata-only".into()
        } else if !is_supported_f64(&metadata) {
            format!(
                "dtype/order/chunk layout is not supported for bounded f64 reads ({})",
                metadata.dtype
            )
        } else {
            "sample payload exceeds the bounded read limit".into()
        });
    }
    let array_geometry = if has_fem_nodal_binding {
        // The array's immutable FEM binding is authoritative. Catalog/detail
        // projection stays lazy; the selected-resource adapter must validate
        // both CAS objects before exposing geometry. Never reinterpret a bad
        // or not-yet-loaded binding as an older FDM or FEM declaration.
        if reason.is_none() {
            reason = Some("FEM nodal geometry binding requires strict validation".into());
        }
        None
    } else {
        geometry_for_array(root, entry, &metadata, geometry)
    };
    let known_field_layout = metadata.component_count == Some(1)
        || (metadata.component_count == Some(3)
            && matches!(
                metadata.field_layout.as_deref(),
                Some("aos_node_major" | "soa_component_major")
            ));
    let can_visualize_3d = value_capable
        && known_field_layout
        && array_geometry.as_ref().is_some_and(|geometry| {
            !matches!(geometry.kind, WorkspaceResultGeometryKind::Unknown)
                && geometry.reason.is_none()
        });
    if !known_field_layout && reason.is_none() {
        reason = Some("array has no supported explicit scalar/vector storage layout".into());
    }
    if !can_visualize_3d && reason.is_none() {
        reason = Some("array has no explicit persisted 3-D geometry mapping".into());
    }
    Ok(WorkspaceResultArray {
        id: entry.array_id(),
        path: relative_display(&entry.relative),
        revision: revision.to_string(),
        shape: metadata.shape.clone(),
        chunks: metadata.chunks.clone(),
        dtype: metadata.dtype,
        quantity_id: metadata.quantity_id,
        quantity_ids: metadata.quantity_ids,
        unit: metadata.unit,
        component_count: metadata.component_count,
        field_layout: metadata.field_layout,
        sample_count,
        coordinates,
        can_read_values: value_capable,
        can_visualize_3d,
        reason,
        geometry: array_geometry,
    })
}

fn json_u64_vec(value: Option<&Value>, field: &str) -> Result<Vec<u64>, ResultsError> {
    value
        .and_then(Value::as_array)
        .ok_or_else(|| ResultsError::Invalid(format!("Zarr {field} must be an array")))?
        .iter()
        .map(|value| {
            value.as_u64().ok_or_else(|| {
                ResultsError::Invalid(format!("Zarr {field} contains a non-integer"))
            })
        })
        .collect()
}

fn is_supported_f64(metadata: &ArrayMetadata) -> bool {
    matches!(metadata.dtype.as_str(), "<f8" | "|f8" | "f8" | "float64")
        && metadata.compressor.is_none()
        && !metadata.filters_present
        && metadata
            .order
            .as_deref()
            .map_or(true, |order| order.eq_ignore_ascii_case("C"))
        && metadata
            .dimension_separator
            .as_deref()
            .map_or(true, |separator| separator == "." || separator == "/")
        // A sample read is one source chunk.  Every non-sample dimension must
        // therefore be covered by that chunk; partial chunks would silently
        // return only the first tile of a logical sample.
        && metadata.chunks.len() == metadata.shape.len()
        && metadata
            .chunks
            .iter()
            .zip(&metadata.shape)
            .skip(1)
            .all(|(chunk, shape)| chunk == shape)
        && metadata.chunks.first() == Some(&1)
}

fn sample_byte_length(metadata: &ArrayMetadata) -> Result<usize, ResultsError> {
    let values = metadata
        .shape
        .iter()
        .skip(1)
        .try_fold(1usize, |product, dimension| {
            let dimension = usize::try_from(*dimension)
                .map_err(|_| ResultsError::TooLarge("array dimension exceeds usize".into()))?;
            product
                .checked_mul(dimension)
                .ok_or_else(|| ResultsError::TooLarge("array sample shape overflows".into()))
        })?;
    let bytes = values
        .checked_mul(F64_BYTES)
        .ok_or_else(|| ResultsError::TooLarge("array sample byte length overflows".into()))?;
    if bytes > MAX_SAMPLE_BYTES {
        return Err(ResultsError::TooLarge(format!("sample is {bytes} bytes")));
    }
    Ok(bytes)
}

fn chunk_path(
    directory: &Path,
    metadata: &ArrayMetadata,
    sample_index: usize,
) -> Result<PathBuf, ResultsError> {
    let separator = match metadata.dimension_separator.as_deref() {
        Some("/") => '/',
        Some(".") | None => '.',
        Some(other) => {
            return Err(ResultsError::Unsupported(format!(
                "Zarr dimension separator {other}"
            )))
        }
    };
    let mut indices = vec![sample_index.to_string()];
    indices.extend(
        std::iter::repeat_with(|| "0".to_string()).take(metadata.shape.len().saturating_sub(1)),
    );
    let chunk_name = if separator == '.' {
        indices.join(".")
    } else {
        indices.join("/")
    };
    Ok(directory.join(chunk_name))
}

fn read_exact_payload(path: &Path, expected: usize) -> Result<Vec<u8>, ResultsError> {
    if expected > MAX_SAMPLE_BYTES {
        return Err(ResultsError::TooLarge(
            "payload exceeds its byte budget".into(),
        ));
    }
    let file = open_regular(path).map_err(|_error| {
        #[cfg(test)]
        eprintln!(
            "results SourceChanged: payload open failed path={} error={} raw_os_error={:?}",
            path.display(),
            _error,
            _error.raw_os_error()
        );
        ResultsError::SourceChanged
    })?;
    let before = file
        .metadata()
        .map_err(|error| ResultsError::Io(error.to_string()))?;
    let path_before = open_regular(path)
        .map_err(|_error| {
            #[cfg(test)]
            eprintln!(
                "results SourceChanged: payload identity-before reopen failed path={} error={} raw_os_error={:?}",
                path.display(),
                _error,
                _error.raw_os_error()
            );
            ResultsError::SourceChanged
        })?
        .metadata()
        .map_err(|error| ResultsError::Io(error.to_string()))?;
    if !same_file_identity(&before, &path_before) {
        #[cfg(test)]
        eprintln!(
            "results SourceChanged: payload identity-before mismatch path={} opened_len={} path_len={}",
            path.display(),
            before.len(),
            path_before.len()
        );
        return Err(ResultsError::SourceChanged);
    }
    if before.len() != expected as u64 {
        #[cfg(test)]
        eprintln!(
            "results SourceChanged: payload length mismatch path={} expected={} actual={}",
            path.display(),
            expected,
            before.len()
        );
        return Err(ResultsError::SourceChanged);
    }
    let mut bytes = Vec::with_capacity(expected.min(1024 * 1024));
    let mut bounded = file.take(expected.saturating_add(1) as u64);
    bounded
        .read_to_end(&mut bytes)
        .map_err(|error| ResultsError::Io(error.to_string()))?;
    let after = bounded
        .get_ref()
        .metadata()
        .map_err(|error| ResultsError::Io(error.to_string()))?;
    let path_after = open_regular(path)
        .map_err(|_error| {
            #[cfg(test)]
            eprintln!(
                "results SourceChanged: payload identity-after reopen failed path={} error={} raw_os_error={:?}",
                path.display(),
                _error,
                _error.raw_os_error()
            );
            ResultsError::SourceChanged
        })?
        .metadata()
        .map_err(|error| ResultsError::Io(error.to_string()))?;
    if bytes.len() != expected
        || !same_file_identity(&before, &after)
        || !same_file_identity(&path_before, &path_after)
    {
        #[cfg(test)]
        eprintln!(
            "results SourceChanged: payload verification failed path={} expected_bytes={} actual_bytes={} opened_identity_matches={} path_identity_matches={}",
            path.display(),
            expected,
            bytes.len(),
            same_file_identity(&before, &after),
            same_file_identity(&path_before, &path_after)
        );
        return Err(ResultsError::SourceChanged);
    }
    Ok(bytes)
}

fn read_pinned_fem_geometry_object(
    directory: &PinnedDirectory,
    name: &OsStr,
    expected_length: u64,
) -> Result<Vec<u8>, ResultsError> {
    charge_metadata(expected_length)?;
    let expected = usize::try_from(expected_length)
        .map_err(|_| ResultsError::TooLarge("FEM geometry object length exceeds usize".into()))?;
    let display_name = name.to_string_lossy();
    let file = directory
        .open_child_regular(name)
        .map_err(|error| fem_geometry_open_error(&display_name, error))?;
    let before = file
        .metadata()
        .map_err(|error| ResultsError::Io(error.to_string()))?;
    if !before.is_file() {
        return Err(ResultsError::Link(format!(
            "FEM geometry object is not a regular file: {display_name}"
        )));
    }
    if before.len() != expected_length {
        return Err(ResultsError::Invalid(format!(
            "FEM geometry object length differs from its reference: {display_name}"
        )));
    }
    let path_before = directory
        .open_child_regular(name)
        .map_err(|_| ResultsError::SourceChanged)?
        .metadata()
        .map_err(|error| ResultsError::Io(error.to_string()))?;
    if !same_file_identity(&before, &path_before) {
        return Err(ResultsError::SourceChanged);
    }

    let mut bytes = Vec::with_capacity(expected.min(1024 * 1024));
    let mut bounded = file.take(expected.saturating_add(1) as u64);
    bounded
        .read_to_end(&mut bytes)
        .map_err(|error| ResultsError::Io(error.to_string()))?;
    let after = bounded
        .get_ref()
        .metadata()
        .map_err(|error| ResultsError::Io(error.to_string()))?;
    let path_after = directory
        .open_child_regular(name)
        .map_err(|_| ResultsError::SourceChanged)?
        .metadata()
        .map_err(|error| ResultsError::Io(error.to_string()))?;
    if bytes.len() != expected
        || !same_file_identity(&before, &after)
        || !same_file_identity(&path_before, &path_after)
    {
        return Err(ResultsError::SourceChanged);
    }
    Ok(bytes)
}

fn read_prefix(path: &Path, limit: usize) -> Result<Vec<u8>, ResultsError> {
    let file = open_regular(path).map_err(|_| ResultsError::SourceChanged)?;
    let before = file
        .metadata()
        .map_err(|error| ResultsError::Io(error.to_string()))?;
    let path_before = open_regular(path)
        .map_err(|_| ResultsError::SourceChanged)?
        .metadata()
        .map_err(|error| ResultsError::Io(error.to_string()))?;
    if !same_file_identity(&before, &path_before) {
        return Err(ResultsError::SourceChanged);
    }
    let mut bytes = Vec::with_capacity(limit.min(1024 * 1024));
    let mut bounded = file.take(limit as u64);
    bounded
        .read_to_end(&mut bytes)
        .map_err(|error| ResultsError::Io(error.to_string()))?;
    let after = bounded
        .get_ref()
        .metadata()
        .map_err(|error| ResultsError::Io(error.to_string()))?;
    let path_after = open_regular(path)
        .map_err(|_| ResultsError::SourceChanged)?
        .metadata()
        .map_err(|error| ResultsError::Io(error.to_string()))?;
    if !same_file_identity(&before, &after) || !same_file_identity(&path_before, &path_after) {
        return Err(ResultsError::SourceChanged);
    }
    Ok(bytes)
}

fn same_file_identity(left: &Metadata, right: &Metadata) -> bool {
    if left.len() != right.len() || left.modified().ok() != right.modified().ok() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        return left.dev() == right.dev() && left.ino() == right.ino();
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn validate_finite_f64(bytes: &[u8]) -> Result<(), ResultsError> {
    if bytes.len() % F64_BYTES != 0 {
        return Err(ResultsError::Invalid("f64 payload is not aligned".into()));
    }
    for chunk in bytes.chunks_exact(F64_BYTES) {
        let value = f64::from_le_bytes(chunk.try_into().expect("chunks_exact has eight bytes"));
        if !value.is_finite() {
            return Err(ResultsError::Invalid(
                "f64 payload contains a non-finite value".into(),
            ));
        }
    }
    Ok(())
}

fn is_zarr_chunk(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.contains('.')
                && name
                    .chars()
                    .all(|character| character.is_ascii_digit() || character == '.')
        })
}

fn relative_display(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if text.is_empty() {
        ".".into()
    } else {
        text
    }
}

fn file_format(path: &Path) -> Option<String> {
    if is_zarr_chunk(path) {
        return Some("zarr_chunk".into());
    }
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
}

fn mime_type(path: &Path) -> String {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("json") | Some("jsonl") => "application/json; charset=utf-8".into(),
        Some("csv") => "text/csv; charset=utf-8".into(),
        Some("txt") | Some("log") | Some("md") => "text/plain; charset=utf-8".into(),
        Some("yaml") | Some("yml") => "application/yaml; charset=utf-8".into(),
        _ => "application/octet-stream".into(),
    }
}

fn known_quantity_components(quantity: &str) -> Option<usize> {
    match quantity.to_ascii_lowercase().as_str() {
        "m" | "h_eff" | "h_demag" | "h_ext" | "h_ani" | "h_dmi" | "h_dmi_rotated" => Some(3),
        "eden_total" | "e_ex" | "e_demag" | "e_ext" | "e_ani" | "e_dmi" | "e_rotated_dmi"
        | "temperature" => Some(1),
        _ => None,
    }
}

// ── coordinates and persisted geometry ─────────────────────────────────────

fn read_sample_coordinates(
    root: &Path,
    relative_array: &Path,
    sample_count: usize,
) -> Result<Vec<WorkspaceResultSampleCoordinate>, ResultsError> {
    let mut coordinates = BTreeMap::<usize, WorkspaceResultSampleCoordinate>::new();
    let array_path = root.join(relative_array);
    if let Ok(csv) = read_optional_text(&array_path.join("samples.csv")) {
        parse_samples_csv(&csv, &mut coordinates, sample_count)?;
    }
    let mut ancestor = array_path.as_path();
    while let Some(parent) = ancestor.parent() {
        let index_path = parent.join("continuous/index.jsonl");
        if let Ok(jsonl) = read_optional_text(&index_path) {
            let store_relative = parent.strip_prefix(root).unwrap_or(Path::new(""));
            let relative_to_store = relative_array
                .strip_prefix(store_relative)
                .unwrap_or(relative_array);
            parse_continuous_index(&jsonl, relative_to_store, &mut coordinates, sample_count)?;
        }
        if parent == root {
            break;
        }
        ancestor = parent;
    }
    Ok(coordinates.into_values().take(MAX_COORDINATES).collect())
}

fn read_optional_text(path: &Path) -> Result<String, ResultsError> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(ResultsError::Io(format!("{}: {error}", path.display()))),
    };
    if metadata.len() > MAX_JSON_BYTES {
        return Err(ResultsError::TooLarge(path.display().to_string()));
    }
    charge_metadata(metadata.len())?;
    let bytes = read_exact_payload(
        path,
        usize::try_from(metadata.len())
            .map_err(|_| ResultsError::TooLarge(path.display().to_string()))?,
    )?;
    String::from_utf8(bytes)
        .map_err(|_| ResultsError::Invalid(format!("{} is not UTF-8", path.display())))
}

fn parse_samples_csv(
    text: &str,
    coordinates: &mut BTreeMap<usize, WorkspaceResultSampleCoordinate>,
    sample_count: usize,
) -> Result<(), ResultsError> {
    let mut lines = text.lines();
    let header = lines.next().unwrap_or_default();
    let columns = header.split(',').map(str::trim).collect::<Vec<_>>();
    let sample_col = columns.iter().position(|column| *column == "sample");
    let step_col = columns
        .iter()
        .position(|column| *column == "step" || *column == "accepted_step");
    let time_col = columns
        .iter()
        .position(|column| *column == "time" || *column == "physical_time_s");
    let Some(sample_col) = sample_col else {
        return Ok(());
    };
    for line in lines.take(MAX_COORDINATES) {
        let values = line.split(',').map(str::trim).collect::<Vec<_>>();
        let Some(index) = values
            .get(sample_col)
            .and_then(|value| value.parse::<usize>().ok())
        else {
            continue;
        };
        if index >= sample_count {
            continue;
        }
        if let Some(column) = time_col {
            if let Some(value) = values
                .get(column)
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| value.is_finite())
            {
                coordinates.insert(
                    index,
                    WorkspaceResultSampleCoordinate {
                        sample_index: index,
                        kind: WorkspaceResultCoordinateKind::PhysicalTime,
                        value: Some(value),
                        accepted_step: None,
                    },
                );
                continue;
            }
        }
        if let Some(column) = step_col {
            if let Some(value) = values.get(column).and_then(|value| accepted_step(value)) {
                coordinates.insert(index, accepted_step_coordinate(index, value));
            }
        }
    }
    Ok(())
}

fn parse_continuous_index(
    text: &str,
    relative_array: &Path,
    coordinates: &mut BTreeMap<usize, WorkspaceResultSampleCoordinate>,
    sample_count: usize,
) -> Result<(), ResultsError> {
    let array_text = relative_display(relative_array)
        .trim_end_matches('/')
        .to_string();
    for line in text.lines().take(MAX_COORDINATES * 2) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let payload_ref = value
            .get("payload_ref")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(index) = value
            .get("stage_sample_index")
            .and_then(Value::as_u64)
            .and_then(|index| usize::try_from(index).ok())
        else {
            continue;
        };
        // The continuous index is global to a target, while each stage array
        // is local.  Bind a coordinate only when its producer-declared
        // stage-local sample index names this exact array chunk.
        if payload_ref != format!("{array_text}/{index}") {
            continue;
        }
        if index >= sample_count {
            continue;
        }
        let coordinate = value.get("coordinate").unwrap_or(&Value::Null);
        let kind = coordinate.get("kind").and_then(Value::as_str);
        let parsed = match kind {
            Some("physical_time") => coordinate
                .get("time_s")
                .or_else(|| coordinate.get("physical_time_s"))
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
                .map(|value| WorkspaceResultSampleCoordinate {
                    sample_index: index,
                    kind: WorkspaceResultCoordinateKind::PhysicalTime,
                    value: Some(value),
                    accepted_step: None,
                }),
            Some("accepted_step") => coordinate
                .get("accepted_step")
                .and_then(accepted_step_value)
                .map(|value| accepted_step_coordinate(index, value)),
            _ => None,
        };
        if let Some(parsed) = parsed {
            coordinates.insert(index, parsed);
        }
    }
    Ok(())
}

fn accepted_step(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value.parse::<u64>().is_ok())
    .then(|| value.to_string())
}

fn accepted_step_value(value: &Value) -> Option<String> {
    match value {
        Value::Number(number) => number.as_u64().map(|value| value.to_string()),
        Value::String(value) => accepted_step(value),
        _ => None,
    }
}

fn accepted_step_coordinate(
    sample_index: usize,
    accepted_step: String,
) -> WorkspaceResultSampleCoordinate {
    // Keep the legacy numeric hint only inside the exact f64 integer range;
    // the decimal string is authoritative for larger accepted-step values.
    let value = accepted_step
        .parse::<u64>()
        .ok()
        .filter(|value| *value <= (1_u64 << 53))
        .map(|value| value as f64);
    WorkspaceResultSampleCoordinate {
        sample_index,
        kind: WorkspaceResultCoordinateKind::AcceptedStep,
        value,
        accepted_step: Some(accepted_step),
    }
}

fn geometry_from_value(
    value: &Value,
    component_count: Option<usize>,
) -> Option<WorkspaceResultGeometry> {
    let backend = value
        .get("backend")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if backend == "fdm" || backend == "finite_difference" {
        let cells = value
            .get("grid_cells")
            .or_else(|| value.get("cells_xyz"))
            .or_else(|| value.get("grid"))
            .and_then(parse_usize_xyz);
        let cell_size = value
            .get("cell_size_m")
            .or_else(|| value.get("cell_size"))
            .and_then(parse_f64_xyz);
        let origin = value
            .get("origin_m")
            .or_else(|| value.get("origin"))
            .and_then(parse_f64_xyz);
        if let (Some(cells_xyz), Some(cell_size_m), Some(origin_m)) = (cells, cell_size, origin) {
            if cells_xyz.contains(&0)
                || cell_size_m
                    .iter()
                    .any(|value| !value.is_finite() || *value <= 0.0)
                || origin_m.iter().any(|value| !value.is_finite())
            {
                return None;
            }
            let cell_count = cells_xyz
                .into_iter()
                .try_fold(1usize, |product, dimension| product.checked_mul(dimension))?;
            return Some(WorkspaceResultGeometry {
                kind: WorkspaceResultGeometryKind::Fdm,
                cells_xyz: Some(cells_xyz),
                cell_size_m: Some(cell_size_m),
                origin_m: Some(origin_m),
                component_count: component_count.or_else(|| {
                    value
                        .get("component_count")
                        .and_then(Value::as_u64)
                        .and_then(|value| usize::try_from(value).ok())
                }),
                node_count: None,
                cell_count: Some(cell_count),
                topology_array_id: None,
                playback_geometry_sha256: None,
                fem_mesh: None,
                reason: None,
            });
        }
    }
    None
}

#[derive(Debug, Clone)]
struct PlaybackStageContext {
    array_path: String,
    frame_count: usize,
    times_s: Vec<f64>,
    quantity_ids: Vec<String>,
    field_layout: Option<String>,
}

#[derive(Debug, Clone)]
struct GeometryContext {
    playback: SavedPlaybackResource,
    stages: Vec<PlaybackStageContext>,
    fem_descriptor_declared: bool,
}

const MAX_PLAYBACK_STAGES: usize = 64;
const MAX_PLAYBACK_FRAMES: usize = 100_000;

/// Read the explicit playback descriptor. Catalog reads use only this bounded
/// sidecar projection; selected-array reads may additionally load the
/// validated FEM geometry. Array paths are retained so an unrelated m-shaped
/// array cannot inherit a result's grid or FEM mesh by node-count coincidence.
fn read_geometry_context(
    root: &Path,
    load_fem_geometry: bool,
) -> Result<Option<GeometryContext>, ResultsError> {
    // Pin the result root before the playback reader canonicalizes any
    // descriptor paths.  The playback module performs its own bounded
    // validation; this guard ensures the results adapter never treats a
    // symlinked result root as a trusted geometry source.
    let _pinned = open_directory(root)
        .map_err(|error| ResultsError::Link(format!("cannot pin playback root: {error}")))?;
    let descriptor = match read_json(&root.join("playback.json")) {
        Ok(value) => value,
        Err(ResultsError::NotFound(_)) => return Ok(None),
        Err(error) => return Err(error),
    };
    if descriptor.get("schema").and_then(Value::as_str) != Some("fullmag.saved_playback.v1")
        || descriptor.get("complete").and_then(Value::as_bool) != Some(true)
    {
        return Ok(None);
    }
    let fem_descriptor_declared = descriptor
        .get("fem_mesh")
        .is_some_and(|value| !value.is_null());
    // FDM playback has a complete canonical validator in the playback
    // reader.  Use its validated resource and stage data as the context
    // projection so malformed legacy descriptors remain metadata-only rather
    // than turning a catalog request into an invalid-descriptor error.
    let validated_fdm = if !fem_descriptor_declared {
        match crate::read_playback_with_geometry(root) {
            Ok(inspection) => Some(inspection.resource),
            Err(_) => return Ok(None),
        }
    } else {
        None
    };
    let stages = if let Some(playback) = validated_fdm.as_ref() {
        let Some(stage_values) = descriptor.get("stages").and_then(Value::as_array) else {
            return Ok(None);
        };
        if stage_values.len() != playback.stages.len() {
            return Ok(None);
        }
        stage_values
            .iter()
            .zip(&playback.stages)
            .map(|(stage, validated)| {
                let Some(array_path) = stage.get("array_path").and_then(Value::as_str) else {
                    return None;
                };
                Some(PlaybackStageContext {
                    array_path: array_path.to_string(),
                    frame_count: validated.frame_count,
                    times_s: validated.times_s.clone(),
                    quantity_ids: validated.quantity_ids.clone(),
                    field_layout: None,
                })
            })
            .collect::<Option<Vec<_>>>()
    } else {
        let stage_values = descriptor
            .get("stages")
            .and_then(Value::as_array)
            .ok_or_else(|| ResultsError::Invalid("saved playback stages are missing".into()))?;
        if stage_values.len() > MAX_PLAYBACK_STAGES {
            return Err(ResultsError::TooLarge(
                "saved playback contains too many stages".into(),
            ));
        }
        let mut stages = Vec::with_capacity(stage_values.len());
        for stage in stage_values {
            let array_path = stage
                .get("array_path")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    ResultsError::Invalid("saved playback array path is missing".into())
                })?;
            let times = stage
                .get("times_s")
                .and_then(Value::as_array)
                .ok_or_else(|| ResultsError::Invalid("saved playback times are missing".into()))?;
            if times.len() > MAX_PLAYBACK_FRAMES {
                return Err(ResultsError::TooLarge(
                    "saved playback contains too many frames".into(),
                ));
            }
            if times.is_empty()
                || times
                    .iter()
                    .any(|time| !time.as_f64().is_some_and(|time| time.is_finite()))
            {
                return Err(ResultsError::Invalid(
                    "saved playback times are invalid".into(),
                ));
            }
            let quantity_ids = stage
                .get("quantity_ids")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    ResultsError::Invalid("saved playback quantities are missing".into())
                })?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>();
            if quantity_ids.is_empty() {
                return Err(ResultsError::Invalid(
                    "saved playback quantities are empty".into(),
                ));
            }
            stages.push(PlaybackStageContext {
                array_path: array_path.to_string(),
                frame_count: times.len(),
                times_s: times.iter().filter_map(Value::as_f64).collect(),
                quantity_ids,
                field_layout: stage
                    .get("field_layout")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            });
        }
        Some(stages)
    };
    let Some(stages) = stages else {
        return Ok(None);
    };
    if stages.is_empty() {
        return Ok(None);
    }

    let lightweight = SavedPlaybackResource {
        schema: descriptor
            .get("schema")
            .and_then(Value::as_str)
            .unwrap_or("fullmag.saved_playback.v1")
            .to_string(),
        revision: descriptor
            .get("revision")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        name: descriptor
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("saved playback")
            .to_string(),
        source_note: descriptor
            .get("source_note")
            .and_then(Value::as_str)
            .map(str::to_string),
        grid_cells_xyz: descriptor.get("grid_cells_xyz").and_then(parse_usize_xyz),
        cell_size_m: descriptor.get("cell_size_m").and_then(parse_f64_xyz),
        origin_m: descriptor.get("origin_m").and_then(parse_f64_xyz),
        fem_mesh: None,
        stages: Vec::new(),
    };
    let playback = if let Some(playback) = validated_fdm {
        playback
    } else if load_fem_geometry {
        // Geometry is selected only after the exact array has been requested.
        // A bounded preflight in the playback reader may reject an oversized
        // mesh; retain the lightweight descriptor so the array remains
        // metadata-only instead of failing the metadata endpoint.
        match crate::read_playback_with_geometry(root) {
            Ok(inspection) => inspection.resource,
            Err(_) => lightweight,
        }
    } else {
        lightweight
    };
    Ok(Some(GeometryContext {
        playback,
        stages,
        fem_descriptor_declared,
    }))
}

fn playback_stage<'a>(
    context: &'a GeometryContext,
    entry: &RawEntry,
) -> Option<&'a PlaybackStageContext> {
    let path = relative_display(&entry.relative);
    context.stages.iter().find(|stage| stage.array_path == path)
}

fn playback_fdm_geometry(
    context: &GeometryContext,
    stage: &PlaybackStageContext,
    metadata: &ArrayMetadata,
) -> Option<WorkspaceResultGeometry> {
    let cells_xyz = context.playback.grid_cells_xyz?;
    let cell_size_m = context.playback.cell_size_m?;
    let origin_m = context.playback.origin_m?;
    if cells_xyz.contains(&0)
        || cell_size_m
            .iter()
            .any(|value| !value.is_finite() || *value <= 0.0)
        || origin_m.iter().any(|value| !value.is_finite())
        || stage.frame_count == 0
        || !stage.quantity_ids.iter().any(|quantity| quantity == "m")
        || metadata.quantity_id.as_deref() != Some("m")
        || metadata.component_count != Some(3)
        || stage.field_layout.is_some()
    {
        return None;
    }
    let cell_count = cells_xyz
        .into_iter()
        .try_fold(1usize, |product, dimension| product.checked_mul(dimension))?;
    let scalar_count = cell_count.checked_mul(3)?;
    let expected_shape = [stage.frame_count as u64, scalar_count as u64];
    let expected_chunks = [1, scalar_count as u64];
    if metadata.shape.as_slice() != expected_shape || metadata.chunks.as_slice() != expected_chunks
    {
        return None;
    }
    Some(WorkspaceResultGeometry {
        kind: WorkspaceResultGeometryKind::Fdm,
        cells_xyz: Some(cells_xyz),
        cell_size_m: Some(cell_size_m),
        origin_m: Some(origin_m),
        component_count: Some(3),
        node_count: None,
        cell_count: Some(cell_count),
        topology_array_id: None,
        playback_geometry_sha256: None,
        fem_mesh: None,
        reason: None,
    })
}

fn playback_fem_geometry(
    context: &GeometryContext,
    stage: &PlaybackStageContext,
    metadata: &ArrayMetadata,
) -> Option<WorkspaceResultGeometry> {
    let mesh = context.playback.fem_mesh.as_ref()?;
    if metadata.quantity_id.as_deref() != Some("m") || metadata.component_count != Some(3) {
        return None;
    }
    let field_layout = stage.field_layout.as_deref()?;
    let scalar_count = mesh.node_count.checked_mul(3)?;
    let flat_shape = [stage.frame_count as u64, scalar_count as u64];
    let flat_chunks = [1, scalar_count as u64];
    let rank3_shape = [stage.frame_count as u64, 3, mesh.node_count as u64];
    let rank3_chunks = [1, 3, mesh.node_count as u64];
    let compatible = match field_layout {
        "aos_node_major" => {
            metadata.shape.as_slice() == flat_shape && metadata.chunks.as_slice() == flat_chunks
        }
        "soa_component_major" => {
            (metadata.shape.as_slice() == flat_shape && metadata.chunks.as_slice() == flat_chunks)
                || (metadata.shape.as_slice() == rank3_shape
                    && metadata.chunks.as_slice() == rank3_chunks)
        }
        _ => false,
    };
    if !compatible {
        return None;
    }
    if metadata
        .field_layout
        .as_deref()
        .is_some_and(|layout| layout != field_layout)
    {
        return None;
    }
    Some(WorkspaceResultGeometry {
        kind: WorkspaceResultGeometryKind::FemP1,
        cells_xyz: None,
        cell_size_m: None,
        origin_m: None,
        component_count: Some(3),
        node_count: Some(mesh.node_count),
        cell_count: Some(mesh.cell_count),
        topology_array_id: None,
        playback_geometry_sha256: Some(mesh.geometry_sha256.clone()),
        fem_mesh: Some(mesh.clone()),
        reason: None,
    })
}

fn geometry_for_array(
    _root: &Path,
    entry: &RawEntry,
    metadata: &ArrayMetadata,
    context: Option<&GeometryContext>,
) -> Option<WorkspaceResultGeometry> {
    // A validated FEM playback descriptor is authoritative for its exact
    // stage path. Do not let an unrelated or stale FDM-shaped `.zattrs`
    // object override the canonical mesh/hash binding.
    if let Some(context) = context {
        if context.fem_descriptor_declared {
            if let Some(stage) = playback_stage(context, entry) {
                return context
                    .playback
                    .fem_mesh
                    .as_ref()
                    .and_then(|_| playback_fem_geometry(context, stage, metadata));
            }
            return None;
        }
    }
    let attr_geometry = geometry_from_value(&metadata.attrs, metadata.component_count)
        .or_else(|| {
            metadata
                .attrs
                .get("field_geometry")
                .and_then(|value| geometry_from_value(value, metadata.component_count))
        })
        .or_else(|| {
            metadata
                .attrs
                .pointer("/provenance/field_geometry")
                .and_then(|value| geometry_from_value(value, metadata.component_count))
        });
    if let Some(mut geometry) = attr_geometry {
        if matches!(geometry.kind, WorkspaceResultGeometryKind::Fdm) {
            let cell_count = geometry.cell_count.unwrap_or(0);
            let component_count = geometry.component_count.or(metadata.component_count);
            let compatible = match (metadata.shape.as_slice(), component_count) {
                ([_, components, cells], Some(component_count)) => {
                    usize::try_from(*components).ok() == Some(component_count)
                        && usize::try_from(*cells).ok() == Some(cell_count)
                }
                ([_, values], Some(component_count)) => {
                    usize::try_from(*values).ok()
                        == Some(component_count.saturating_mul(cell_count))
                }
                _ => false,
            };
            if compatible {
                geometry.component_count = component_count;
                return Some(geometry);
            }
            return Some(WorkspaceResultGeometry {
                kind: WorkspaceResultGeometryKind::Unknown,
                reason: Some("persisted FDM geometry does not match this array shape".into()),
                ..geometry
            });
        }
    }
    let Some(context) = context else {
        return None;
    };
    let Some(stage) = playback_stage(context, entry) else {
        return None;
    };
    if context.playback.fem_mesh.is_some() {
        playback_fem_geometry(context, stage, metadata)
    } else {
        playback_fdm_geometry(context, stage, metadata)
    }
}

fn parse_usize_xyz(value: &Value) -> Option<[usize; 3]> {
    let values = value.as_array()?;
    let [x, y, z] = values.as_slice() else {
        return None;
    };
    Some([
        usize::try_from(x.as_u64()?).ok()?,
        usize::try_from(y.as_u64()?).ok()?,
        usize::try_from(z.as_u64()?).ok()?,
    ])
}

fn parse_f64_xyz(value: &Value) -> Option<[f64; 3]> {
    let values = value.as_array()?;
    let [x, y, z] = values.as_slice() else {
        return None;
    };
    Some([x.as_f64()?, y.as_f64()?, z.as_f64()?])
}

// ── bounded JSON/run identity helpers ──────────────────────────────────────

fn read_json(path: &Path) -> Result<Value, ResultsError> {
    let metadata = symlink_metadata(path)?;
    reject_reparse(path, &metadata)?;
    if metadata.len() > MAX_JSON_BYTES {
        return Err(ResultsError::TooLarge(path.display().to_string()));
    }
    charge_metadata(metadata.len())?;
    let bytes = read_exact_payload(
        path,
        usize::try_from(metadata.len())
            .map_err(|_| ResultsError::TooLarge(path.display().to_string()))?,
    )?;
    serde_json::from_slice(&bytes)
        .map_err(|error| ResultsError::Invalid(format!("{}: {error}", path.display())))
}

fn read_and_validate_run_id(
    root: &Path,
    expected_run_id: Option<&str>,
) -> Result<Option<String>, ResultsError> {
    let mut actual_ids = BTreeSet::new();
    for path in [
        root.join("fullmag-run.json"),
        root.join("run_manifest.json"),
        root.join("metadata.json"),
        root.join("artifacts/metadata.json"),
        root.join("output-storage.json"),
    ] {
        let Ok(value) = read_json(&path) else {
            continue;
        };
        for actual in [
            value.get("run_id").and_then(Value::as_str),
            value.pointer("/resolved/run_id").and_then(Value::as_str),
        ]
        .into_iter()
        .flatten()
        .filter(|value| !value.is_empty())
        {
            actual_ids.insert(actual.to_string());
        }
    }
    if actual_ids.len() > 1 {
        return Err(ResultsError::RunMismatch {
            expected: expected_run_id
                .filter(|value| !value.is_empty())
                .unwrap_or("one durable run identity")
                .into(),
            actual: actual_ids.into_iter().collect::<Vec<_>>().join(","),
        });
    }
    let actual = actual_ids.into_iter().next();
    if let Some(expected) = expected_run_id.filter(|value| !value.is_empty()) {
        let Some(found) = actual.as_deref() else {
            return Err(ResultsError::Unsupported(
                "durable result run identity is missing".into(),
            ));
        };
        if expected != found {
            return Err(ResultsError::RunMismatch {
                expected: expected.into(),
                actual: found.into(),
            });
        }
    }
    Ok(actual)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::playback::SavedPlaybackFemMesh;
    use fullmag_ir::MeshIR;
    use fullmag_quantities::{fem_nodal_field::FemP1NodalFieldSemantics, QuantityId};
    use fullmag_session::saved_fem_nodal::{
        FEM_NODAL_ARRAY_BINDING_SCHEMA, FEM_P1_MESH_GEOMETRY_SCHEMA,
    };
    use fullmag_session::solution_field_geometry::SavedFieldGeometryRef;

    fn write_json(path: &Path, value: Value) {
        fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        fs::write(path, serde_json::to_vec(&value).expect("json")).expect("write");
    }

    fn write_array(root: &Path, relative: &str, values: &[f64], attrs: Value) {
        let directory = root.join(relative);
        write_json(
            &directory.join(".zarray"),
            serde_json::json!({
                "zarr_format": 2,
                "shape": [1, values.len()],
                "chunks": [1, values.len()],
                "dtype": "<f8",
                "compressor": null,
                "order": "C",
                "dimension_separator": "."
            }),
        );
        write_json(&directory.join(".zattrs"), attrs);
        let mut bytes = Vec::new();
        for value in values {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        fs::write(directory.join("0.0"), bytes).expect("chunk");
    }

    fn publish_test_prefix(directory: &Path, count: u64, coordinates: &str) {
        fs::write(directory.join("samples.csv"), coordinates).unwrap();
        write_json(
            &directory.join(SAMPLE_PUBLICATION_FILE),
            serde_json::json!({
                "schema_version": SAMPLE_PUBLICATION_SCHEMA,
                "committed_samples": count,
                "coordinate_bytes": coordinates.len(),
            }),
        );
    }

    fn saved_tet_mesh() -> MeshIR {
        MeshIR::from_legacy_tet4(
            "workspace-inspect-saved-nodal-tet".into(),
            vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
            vec![[0, 1, 2, 3]],
            vec![1],
            vec![[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]],
            vec![1; 4],
            vec![],
            vec![],
            Default::default(),
        )
    }

    fn saved_geometry_reference(schema_id: &str, bytes: &[u8]) -> SavedFieldGeometryRef {
        SavedFieldGeometryRef {
            schema_id: schema_id.into(),
            object_ref: hex_bytes(&Sha256::digest(bytes)),
            byte_length: bytes.len() as u64,
        }
    }

    fn write_fem_nodal_fixture(
        root: &Path,
        quantity: QuantityId,
        layout: fullmag_session::saved_fem_nodal::FemNodalStorageLayout,
    ) -> SavedFemNodalArrayBinding {
        use fullmag_session::saved_fem_nodal::{SavedFemNodalArrayBinding, SavedFemP1MeshGeometry};
        use fullmag_session::solution_field_geometry::SavedFieldRepresentationEvidence;

        let mesh = SavedFemP1MeshGeometry {
            schema_version: FEM_P1_MESH_GEOMETRY_SCHEMA.into(),
            coordinate_unit: "m".into(),
            representation_evidence: SavedFieldRepresentationEvidence::NotVerified,
            mesh: saved_tet_mesh(),
        };
        let active_node_mask = if quantity == QuantityId::M {
            vec![true, false, true, true]
        } else {
            vec![true; mesh.mesh.nodes.len()]
        };
        let semantics = FemP1NodalFieldSemantics::new(
            quantity,
            &mesh.mesh.topology_fingerprint_v6(),
            mesh.mesh.nodes.len(),
            active_node_mask,
        )
        .expect("canonical FEM nodal semantics");
        let mesh_bytes = serde_json::to_vec(&mesh).expect("mesh JSON");
        let semantics_bytes = serde_json::to_vec(&semantics).expect("semantics JSON");
        let binding = SavedFemNodalArrayBinding {
            schema_version: FEM_NODAL_ARRAY_BINDING_SCHEMA.into(),
            array_path: format!("stages/relax/fields/{}", quantity.as_str()),
            quantity_id: quantity,
            unit: semantics.descriptor.unit.clone(),
            component_count: if semantics.descriptor.tensor_rank == 0 {
                1
            } else {
                3
            },
            node_count: mesh.mesh.nodes.len(),
            cell_count: mesh.mesh.cells.len(),
            field_layout: layout,
            topology_fingerprint: mesh.mesh.topology_fingerprint_v6(),
            mesh: saved_geometry_reference(FEM_P1_MESH_GEOMETRY_SCHEMA, &mesh_bytes),
            semantics: saved_geometry_reference(
                fullmag_quantities::fem_nodal_field::FEM_P1_NODAL_FIELD_SEMANTICS_FORMAT,
                &semantics_bytes,
            ),
        };

        let object_directory = root.join(FEM_NODAL_OBJECT_DIRECTORY);
        fs::create_dir_all(&object_directory).expect("create immutable object directory");
        for (reference, bytes) in [
            (&binding.mesh, mesh_bytes),
            (&binding.semantics, semantics_bytes),
        ] {
            let relative = fem_nodal_object_relative_path(reference).expect("object path");
            let path = root.join(relative);
            fs::write(path, bytes).expect("write immutable geometry object");
        }

        let width = binding.node_count * binding.component_count;
        let attrs = serde_json::json!({
            "quantity": quantity.as_str(),
            "unit": binding.unit.as_str(),
            "storage_layout": layout.as_str(),
            "field_layout": layout.as_str(),
            "dimension_order": ["sample", "value"],
            "sample_publication": SAMPLE_PUBLICATION_SCHEMA,
            // The writer does not emit component_count; the canonical
            // quantity semantics and bound shape provide it.
            "fem_nodal_binding": serde_json::to_value(&binding).expect("binding JSON"),
        });
        let relative = binding.array_path.clone();
        let values = vec![1.0; width];
        write_array(root, &relative, &values, attrs);
        publish_test_prefix(
            &root.join(relative),
            1,
            &format!("{SAMPLE_COORDINATE_HEADER}\n0,0.0,\n"),
        );
        binding
    }

    fn fixture_array_id(root: &Path, binding: &SavedFemNodalArrayBinding) -> (String, String) {
        fixture_array_id_for_path(root, &binding.array_path)
    }

    fn fixture_array_id_for_path(root: &Path, array_path: &str) -> (String, String) {
        let catalog =
            read_results_catalog(root, None, 100, None, WorkspaceResultsSource::WorkspaceItem)
                .expect("catalog");
        let array_id = catalog
            .entries
            .iter()
            .find(|entry| entry.path == array_path)
            .and_then(|entry| entry.array_id.clone())
            .expect("bound Zarr array");
        (array_id, catalog.revision)
    }

    #[test]
    fn incremental_root_never_falls_back_to_legacy_array_visibility() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write_array(root, "m", &[1.0], serde_json::json!({}));
        // The same historical array remains readable without an incremental
        // declaration. Adding that declaration must not preserve this fallback.
        let legacy = read_results_catalog(root, None, 100, None, WorkspaceResultsSource::WorkspaceItem).unwrap();
        let id = legacy.entries.iter().find_map(|entry| entry.array_id.clone()).unwrap();
        assert!(read_results_sample(root, &id, 0, &legacy.revision, None).is_ok());
        write_json(&root.join("run.json"), serde_json::json!({"publication": {
            "schema": ACCEPTED_RESULTS_PUBLICATION_SCHEMA,
            "sample_policy": SAMPLE_PUBLICATION_SCHEMA
        }}));
        let current = read_results_catalog(root, None, 100, None, WorkspaceResultsSource::WorkspaceItem).unwrap();
        assert!(!current.can_read_values);
        assert!(matches!(read_results_array(root, &id, &current.revision, None), Err(ResultsError::Invalid(_))));
        assert!(matches!(read_results_sample(root, &id, 0, &current.revision, None), Err(ResultsError::Invalid(_))));
        assert!(matches!(read_results_fem_nodal_geometry(root, &id, &current.revision, None), Err(ResultsError::Invalid(_))));
        write_json(&root.join("m/.zattrs"), serde_json::json!({"sample_publication": SAMPLE_PUBLICATION_SCHEMA}));
        for count in [0, 1] {
            let csv = if count == 0 { format!("{SAMPLE_COORDINATE_HEADER}\n") }
                else { format!("{SAMPLE_COORDINATE_HEADER}\n0,0.25,\n") };
            publish_test_prefix(&root.join("m"), count, &csv);
            let catalog = read_results_catalog(root, None, 100, None, WorkspaceResultsSource::WorkspaceItem).unwrap();
            let array = read_results_array(root, &id, &catalog.revision, None).unwrap();
            assert_eq!(array.sample_count, count as usize);
            assert!(matches!(read_results_sample(root, &id, count as usize, &catalog.revision, None), Err(ResultsError::NotFound(_))));
            if count > 0 {
                assert_eq!(read_results_sample(root, &id, 0, &catalog.revision, None).unwrap().bytes, 1.0_f64.to_le_bytes());
            }
        }
    }

    #[test]
    fn root_policy_content_changes_invalidate_same_size_same_time_revisions() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write_array(root, "m", &[1.0], serde_json::json!({"sample_publication":SAMPLE_PUBLICATION_SCHEMA}));
        publish_test_prefix(&root.join("m"), 1, &format!("{SAMPLE_COORDINATE_HEADER}\n0,0,\n"));
        let descriptor = root.join("run.json");
        write_json(&descriptor, serde_json::json!({"publication": {
            "schema":ACCEPTED_RESULTS_PUBLICATION_SCHEMA, "sample_policy":SAMPLE_PUBLICATION_SCHEMA
        }}));
        let before = read_results_catalog(root, None, 100, None, WorkspaceResultsSource::WorkspaceItem).unwrap();
        let id = before.entries.iter().find_map(|entry| entry.array_id.clone()).unwrap();
        let metadata = fs::metadata(&descriptor).unwrap();
        let original = fs::read_to_string(&descriptor).unwrap();
        fs::write(&descriptor, original.replace("\"publication\"", "\"publicatioN\"")).unwrap();
        fs::OpenOptions::new().write(true).open(&descriptor).unwrap()
            .set_times(fs::FileTimes::new().set_modified(metadata.modified().unwrap())).unwrap();
        assert_eq!(fs::metadata(&descriptor).unwrap().len(), metadata.len());
        assert_eq!(fs::metadata(&descriptor).unwrap().modified().unwrap(), metadata.modified().unwrap());
        assert!(matches!(read_results_array(root, &id, &before.revision, None), Err(ResultsError::StaleRevision)));
    }

    #[test]
    fn malformed_root_publication_is_not_a_legacy_folder() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write_array(root, "m", &[1.0], serde_json::json!({}));
        for publication in [
            Value::Null,
            serde_json::json!({}),
            serde_json::json!({"schema":"future", "sample_policy":SAMPLE_PUBLICATION_SCHEMA}),
            serde_json::json!({"schema":ACCEPTED_RESULTS_PUBLICATION_SCHEMA, "sample_policy":"future"}),
        ] {
            write_json(&root.join("run.json"), serde_json::json!({"publication":publication}));
            assert!(matches!(read_results_catalog(root, None, 100, None, WorkspaceResultsSource::WorkspaceItem), Err(ResultsError::Invalid(_))));
        }
    }

    #[test]
    fn publication_hides_uncommitted_payload_and_coordinate_suffix() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write_array(
            root,
            "m",
            &[1.0],
            serde_json::json!({"sample_publication": SAMPLE_PUBLICATION_SCHEMA}),
        );
        let array_path = root.join("m");
        let header = format!("{SAMPLE_COORDINATE_HEADER}\n");
        publish_test_prefix(&array_path, 0, &header);
        // A crash after advancing shape and starting the payload cannot expose frame 0.
        fs::write(array_path.join("0.0"), [0_u8; 3]).unwrap();
        let catalog =
            read_results_catalog(root, None, 100, None, WorkspaceResultsSource::WorkspaceItem)
                .unwrap();
        let id = catalog
            .entries
            .iter()
            .find_map(|entry| entry.array_id.clone())
            .unwrap();
        let array = read_results_array(root, &id, &catalog.revision, None).unwrap();
        assert_eq!(array.sample_count, 0);
        assert!(matches!(
            read_results_sample(root, &id, 0, &catalog.revision, None),
            Err(ResultsError::NotFound(_))
        ));
        // Even a complete time row is unpublished until the marker is replaced.
        fs::write(
            array_path.join("samples.csv"),
            format!("{header}0,0.25,\n1,uncommitted"),
        )
        .unwrap();
        assert_eq!(parse_array_metadata(&array_path).unwrap().shape[0], 0);
        fs::write(array_path.join("0.0"), 1.0_f64.to_le_bytes()).unwrap();
        let committed = format!("{header}0,0.25,\n");
        publish_test_prefix(&array_path, 1, &committed);
        assert!(matches!(
            read_results_array(root, &id, &catalog.revision, None),
            Err(ResultsError::StaleRevision)
        ));
        let catalog =
            read_results_catalog(root, None, 100, None, WorkspaceResultsSource::WorkspaceItem)
                .unwrap();
        let sample = read_results_sample(root, &id, 0, &catalog.revision, None).unwrap();
        assert_eq!(sample.coordinate.unwrap().value, Some(0.25));
        assert_eq!(sample.bytes, 1.0_f64.to_le_bytes());
    }

    #[test]
    fn publication_rejects_missing_or_inconsistent_commit_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        write_array(
            root,
            "m",
            &[1.0],
            serde_json::json!({"sample_publication": SAMPLE_PUBLICATION_SCHEMA}),
        );
        let path = root.join("m");
        assert!(parse_array_metadata(&path).is_err());
        let header = format!("{SAMPLE_COORDINATE_HEADER}\n");
        for (count, suffix) in [
            (2, "0,0.1,\n1,0.2,\n"),
            (1, ""),
            (1, "1,0.1,\n"),
            (1, "0,NaN,\n"),
            (1, "0,0.1,3\n"),
            (1, "0,,1.5\n"),
            (1, "0,0.1,"),
        ] {
            publish_test_prefix(&path, count, &format!("{header}{suffix}"));
            assert!(
                parse_array_metadata(&path).is_err(),
                "count={count}, suffix={suffix:?}"
            );
        }
        publish_test_prefix(&path, 1, &format!("{header}0,,9007199254740993\n"));
        let metadata = parse_array_metadata(&path).unwrap();
        assert_eq!(
            metadata.published_coordinates.unwrap()[0]
                .accepted_step
                .as_deref(),
            Some("9007199254740993")
        );
        write_json(&path.join(".zattrs"), serde_json::json!({}));
        assert!(
            parse_array_metadata(&path).is_err(),
            "orphan marker must not downgrade to legacy"
        );
        write_json(
            &path.join(".zattrs"),
            serde_json::json!({"sample_publication":"future"}),
        );
        assert!(parse_array_metadata(&path).is_err());
        fs::write(path.join(".zattrs"), "{broken").unwrap();
        assert!(parse_array_metadata(&path).is_err());
    }

    #[test]
    fn catalog_lists_nested_groups_and_unknown_files() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path();
        fs::create_dir_all(root.join("analysis/modes")).expect("dirs");
        fs::write(root.join("analysis/modes/unknown.bin"), [1_u8, 2, 3]).expect("file");
        write_array(
            root,
            "fields/m",
            &[1.0, 2.0],
            serde_json::json!({"quantity":"m"}),
        );
        let catalog =
            read_results_catalog(root, None, 100, None, WorkspaceResultsSource::WorkspaceItem)
                .expect("catalog");
        assert!(catalog
            .entries
            .iter()
            .any(|entry| entry.path == "analysis/modes"
                && matches!(entry.kind, WorkspaceResultEntryKind::Directory)));
        assert!(catalog
            .entries
            .iter()
            .any(|entry| entry.path == "analysis/modes/unknown.bin"));
        assert!(catalog
            .entries
            .iter()
            .any(|entry| matches!(entry.kind, WorkspaceResultEntryKind::ZarrArray)));
    }

    #[test]
    fn reads_finite_f64_sample_and_declared_layout() {
        let temp = tempfile::tempdir().expect("temp");
        write_array(
            temp.path(),
            "fields/m",
            &[1.0, -2.5],
            serde_json::json!({"storage_layout":"soa_component_major", "component_count": 1}),
        );
        let catalog = read_results_catalog(
            temp.path(),
            None,
            100,
            None,
            WorkspaceResultsSource::WorkspaceItem,
        )
        .expect("catalog");
        let array_id = catalog
            .entries
            .iter()
            .find_map(|entry| entry.array_id.clone())
            .expect("array");
        let array = read_results_array(temp.path(), &array_id, &catalog.revision, None)
            .expect("array meta");
        assert_eq!(array.field_layout.as_deref(), Some("soa_component_major"));
        let sample = read_results_sample(temp.path(), &array.id, 0, &catalog.revision, None)
            .expect("sample");
        assert_eq!(sample.bytes.len(), 16);
        assert_eq!(
            f64::from_le_bytes(sample.bytes[8..16].try_into().expect("f64")),
            -2.5
        );
    }

    #[test]
    fn reads_continuous_coordinates() {
        let temp = tempfile::tempdir().expect("temp");
        let store = temp.path().join("data.zarr");
        write_array(
            &store,
            "stages/stage_0000_relax/fields/m",
            &[3.0],
            serde_json::json!({}),
        );
        fs::create_dir_all(store.join("continuous")).expect("continuous");
        fs::write(
            store.join("continuous/index.jsonl"),
            r#"{"target_sample_index":0,"stage_sample_index":0,"stage_id":"relax","coordinate":{"kind":"physical_time","time_s":1.25},"payload_ref":"stages/stage_0000_relax/fields/m/0"}
"#,
        )
        .expect("index");
        let catalog = read_results_catalog(
            temp.path(),
            None,
            100,
            None,
            WorkspaceResultsSource::WorkspaceItem,
        )
        .expect("catalog");
        let array_id = catalog
            .entries
            .iter()
            .find_map(|entry| entry.array_id.clone())
            .expect("array");
        let array = read_results_array(temp.path(), &array_id, &catalog.revision, None)
            .expect("array meta");
        assert_eq!(
            array.coordinates[0].kind,
            WorkspaceResultCoordinateKind::PhysicalTime
        );
        assert_eq!(array.coordinates[0].value, Some(1.25));
    }

    #[test]
    fn continuous_coordinates_bind_stage_samples_and_keep_large_steps_exact() {
        let temp = tempfile::tempdir().expect("temp");
        let store = temp.path().join("data.zarr");
        let table = store.join("stages/stage_0000_relax/table");
        write_json(
            &table.join(".zarray"),
            serde_json::json!({
                "zarr_format": 2,
                "shape": [1, 1],
                "chunks": [1, 1],
                "dtype": "<f8",
                "compressor": null,
                "order": "C",
                "dimension_separator": "."
            }),
        );
        write_json(
            &table.join(".zattrs"),
            serde_json::json!({"quantities":["mx"], "dimension_order":["sample","quantity"]}),
        );
        fs::write(table.join("0.0"), 0.25_f64.to_le_bytes()).expect("table sample");
        let array = store.join("stages/stage_0001_relax/fields/m");
        write_json(
            &array.join(".zarray"),
            serde_json::json!({
                "zarr_format": 2,
                "shape": [2, 1],
                "chunks": [1, 1],
                "dtype": "<f8",
                "compressor": null,
                "order": "C",
                "dimension_separator": "."
            }),
        );
        write_json(
            &array.join(".zattrs"),
            serde_json::json!({"observable":"m", "dimension_order":["sample","value"]}),
        );
        fs::write(array.join("0.0"), 1.0_f64.to_le_bytes()).expect("sample 0");
        fs::write(array.join("1.0"), 2.0_f64.to_le_bytes()).expect("sample 1");
        fs::create_dir_all(store.join("continuous")).expect("continuous");
        fs::write(
            store.join("continuous/index.jsonl"),
            format!(
                "{}\n{}\n{}\n{}\n",
                serde_json::json!({
                    "target_sample_index": 16,
                    "stage_sample_index": 0,
                    "coordinate": {"kind":"physical_time", "time_s": 0.25},
                    "payload_ref": "stages/stage_0000_relax/table/0"
                }),
                serde_json::json!({
                    "target_sample_index": 17,
                    "stage_sample_index": 0,
                    "coordinate": {"kind":"physical_time", "time_s": 0.5},
                    "payload_ref": "stages/stage_0001_relax/fields/m/0"
                }),
                serde_json::json!({
                    "target_sample_index": 18,
                    "stage_sample_index": 1,
                    "coordinate": {"kind":"accepted_step", "accepted_step": 9007199254740993_u64},
                    "payload_ref": "stages/stage_0001_relax/fields/m/1"
                }),
                // The global target index and a neighbouring payload must not
                // be allowed to masquerade as this stage's sample 0.
                serde_json::json!({
                    "target_sample_index": 0,
                    "stage_sample_index": 0,
                    "coordinate": {"kind":"physical_time", "time_s": 99.0},
                    "payload_ref": "stages/stage_0001_relax/fields/m/1"
                }),
            ),
        )
        .expect("index");
        let catalog = read_results_catalog(
            temp.path(),
            None,
            100,
            None,
            WorkspaceResultsSource::WorkspaceItem,
        )
        .expect("catalog");
        let field_id = catalog
            .entries
            .iter()
            .find(|entry| entry.path.ends_with("/fields/m"))
            .and_then(|entry| entry.array_id.clone())
            .expect("field array");
        let fields = read_results_array(temp.path(), &field_id, &catalog.revision, None)
            .expect("field array meta");
        assert_eq!(fields.coordinates.len(), 2);
        assert_eq!(fields.coordinates[0].sample_index, 0);
        assert_eq!(fields.coordinates[0].value, Some(0.5));
        assert_eq!(fields.coordinates[1].sample_index, 1);
        assert_eq!(
            fields.coordinates[1].accepted_step.as_deref(),
            Some("9007199254740993")
        );
        assert_eq!(fields.coordinates[1].value, None);
        let table_id = catalog
            .entries
            .iter()
            .find(|entry| entry.path.ends_with("/table"))
            .and_then(|entry| entry.array_id.clone())
            .expect("table array");
        let table = read_results_array(temp.path(), &table_id, &catalog.revision, None)
            .expect("table array meta");
        assert_eq!(table.coordinates[0].sample_index, 0);
        assert_eq!(table.coordinates[0].value, Some(0.25));
    }

    #[test]
    fn table_quantities_and_observable_fallbacks_describe_arrays() {
        let temp = tempfile::tempdir().expect("temp");
        let table = temp.path().join("stages/stage_0000_relax/table");
        write_json(
            &table.join(".zarray"),
            serde_json::json!({
                "zarr_format": 2,
                "shape": [1, 2],
                "chunks": [1, 2],
                "dtype": "<f8",
                "compressor": null,
                "order": "C",
                "dimension_separator": "."
            }),
        );
        write_json(
            &table.join(".zattrs"),
            serde_json::json!({"quantities":["mx","e_total"], "dimension_order":["sample","quantity"]}),
        );
        fs::write(
            table.join("0.0"),
            [0.1_f64.to_le_bytes(), 2.0_f64.to_le_bytes()].concat(),
        )
        .expect("table sample");
        write_array(
            temp.path(),
            "fields/m",
            &[1.0, 0.0, 0.0],
            serde_json::json!({"observable":"m", "dimension_order":["sample","value"]}),
        );
        write_array(
            temp.path(),
            "fields/temperature",
            &[300.0],
            serde_json::json!({"quantity":"temperature", "dimension_order":["sample","value"]}),
        );
        let catalog = read_results_catalog(
            temp.path(),
            None,
            100,
            None,
            WorkspaceResultsSource::WorkspaceItem,
        )
        .expect("catalog");
        let mut arrays = catalog
            .entries
            .iter()
            .filter_map(|entry| entry.array_id.clone())
            .map(|id| read_results_array(temp.path(), &id, &catalog.revision, None).unwrap())
            .collect::<Vec<_>>();
        arrays.sort_by(|left, right| left.path.cmp(&right.path));
        let table = arrays
            .iter()
            .find(|array| array.path.ends_with("/table"))
            .expect("table array");
        assert_eq!(table.quantity_id.as_deref(), Some("mx"));
        assert_eq!(table.quantity_ids, vec!["mx", "e_total"]);
        assert_eq!(table.component_count, Some(2));
        assert_eq!(table.field_layout, None);
        let field = arrays
            .iter()
            .find(|array| array.path == "fields/m")
            .expect("observable array");
        assert_eq!(field.quantity_id.as_deref(), Some("m"));
        assert_eq!(field.quantity_ids, vec!["m"]);
        assert_eq!(field.component_count, Some(3));
        let scalar = arrays
            .iter()
            .find(|array| array.path == "fields/temperature")
            .expect("scalar array");
        assert_eq!(scalar.quantity_id.as_deref(), Some("temperature"));
        assert_eq!(scalar.quantity_ids, vec!["temperature"]);
        assert_eq!(scalar.component_count, Some(1));

        let serialized = serde_json::to_value(table).expect("serialize table metadata");
        assert_eq!(
            serialized["quantity_ids"],
            serde_json::json!(["mx", "e_total"])
        );
        let legacy: WorkspaceResultArray = serde_json::from_value(serde_json::json!({
            "id": "legacy",
            "path": "table",
            "revision": "revision",
            "shape": [1, 2],
            "chunks": [1, 2],
            "dtype": "<f8",
            "quantity_id": "mx",
            "sample_count": 1,
            "coordinates": [],
            "can_read_values": true,
            "can_visualize_3d": false
        }))
        .expect("deserialize legacy array metadata");
        assert!(legacy.quantity_ids.is_empty());
    }

    #[test]
    fn malformed_table_quantity_labels_fail_closed_without_name_inference() {
        let temp = tempfile::tempdir().expect("temp");
        let table = temp.path().join("stages/stage_0000_relax/table");
        write_json(
            &table.join(".zarray"),
            serde_json::json!({
                "zarr_format": 2,
                "shape": [1, 2],
                "chunks": [1, 2],
                "dtype": "<f8",
                "compressor": null,
                "order": "C",
                "dimension_separator": "."
            }),
        );
        fs::write(
            table.join("0.0"),
            [0.1_f64.to_le_bytes(), 2.0_f64.to_le_bytes()].concat(),
        )
        .expect("table sample");

        let assert_invalid = |quantities: Value, dimensions: Value, message: &str| {
            write_json(
                &table.join(".zattrs"),
                serde_json::json!({
                    "quantities": quantities,
                    "dimension_order": dimensions
                }),
            );
            let catalog = read_results_catalog(
                temp.path(),
                None,
                100,
                None,
                WorkspaceResultsSource::WorkspaceItem,
            )
            .expect("catalog remains bounded");
            let table_id = catalog
                .entries
                .iter()
                .find(|entry| entry.path.ends_with("/table"))
                .and_then(|entry| entry.array_id.clone())
                .expect("table array");
            let error = read_results_array(temp.path(), &table_id, &catalog.revision, None)
                .expect_err("malformed table labels must not be projected");
            assert!(
                matches!(&error, ResultsError::Invalid(detail) if detail.contains(message)),
                "unexpected error: {error}"
            );
            assert!(matches!(
                read_results_sample(temp.path(), &table_id, 0, &catalog.revision, None),
                Err(ResultsError::Invalid(_))
            ));
        };

        assert_invalid(
            serde_json::json!(["mx", 42, "e_total"]),
            serde_json::json!(["sample", "quantity"]),
            "non-empty array of non-empty strings",
        );
        assert_invalid(
            serde_json::json!(["mx"]),
            serde_json::json!(["sample", "quantity"]),
            "quantity label count",
        );
        assert_invalid(
            serde_json::json!(["mx", ""]),
            serde_json::json!(["sample", "quantity"]),
            "non-empty array of non-empty strings",
        );
        assert_invalid(
            serde_json::json!(["mx", "e_total"]),
            serde_json::json!(["sample", 42, "quantity"]),
            "dimension_order must be a non-empty array of non-empty strings",
        );
        assert_invalid(
            serde_json::json!(["mx", "e_total"]),
            serde_json::json!(["quantity", "sample"]),
            "quantity axis must be a non-zero axis after sample",
        );
        assert_invalid(
            serde_json::json!(["mx", "e_total"]),
            serde_json::json!(["sample", "quantity", "value"]),
            "quantity axis must be a non-zero axis after sample",
        );
    }

    #[test]
    fn partial_non_sample_chunks_are_metadata_only() {
        let temp = tempfile::tempdir().expect("temp");
        let directory = temp.path().join("fields/partial");
        write_json(
            &directory.join(".zarray"),
            serde_json::json!({
                "zarr_format": 2,
                "shape": [1, 4],
                "chunks": [1, 2],
                "dtype": "<f8",
                "compressor": null,
                "order": "C",
                "dimension_separator": "."
            }),
        );
        write_json(&directory.join(".zattrs"), serde_json::json!({}));
        fs::write(
            directory.join("0.0"),
            [1.0_f64.to_le_bytes(), 2.0_f64.to_le_bytes()].concat(),
        )
        .expect("partial chunk");
        let catalog = read_results_catalog(
            temp.path(),
            None,
            100,
            None,
            WorkspaceResultsSource::WorkspaceItem,
        )
        .expect("catalog");
        let array_id = catalog
            .entries
            .iter()
            .find_map(|entry| entry.array_id.clone())
            .expect("array");
        let array = read_results_array(temp.path(), &array_id, &catalog.revision, None)
            .expect("array metadata");
        assert!(!array.can_read_values);
        assert!(matches!(
            read_results_sample(temp.path(), &array.id, 0, &catalog.revision, None),
            Err(ResultsError::Unsupported(_))
        ));
    }

    #[test]
    fn cursors_pin_revision_and_reject_invalid_or_stale_pages() {
        let temp = tempfile::tempdir().expect("temp");
        write_array(
            temp.path(),
            "fields/m",
            &[1.0, 0.0, 0.0],
            serde_json::json!({"quantity":"m"}),
        );
        fs::write(temp.path().join("notes.txt"), b"notes").expect("file");
        let first = read_results_catalog(
            temp.path(),
            None,
            1,
            None,
            WorkspaceResultsSource::WorkspaceItem,
        )
        .expect("first page");
        let cursor = first.next_cursor.clone().expect("next cursor");
        let second = read_results_catalog(
            temp.path(),
            Some(&cursor),
            1,
            None,
            WorkspaceResultsSource::WorkspaceItem,
        )
        .expect("second page");
        assert_eq!(second.revision, first.revision);
        assert_ne!(
            second.entries.first().map(|entry| &entry.path),
            first.entries.first().map(|entry| &entry.path)
        );

        fs::write(temp.path().join("notes.txt"), b"changed-content").expect("mutate");
        assert!(matches!(
            read_results_catalog(
                temp.path(),
                Some(&cursor),
                1,
                None,
                WorkspaceResultsSource::WorkspaceItem,
            ),
            Err(ResultsError::StaleRevision)
        ));
        assert!(matches!(
            read_results_catalog(
                temp.path(),
                Some("not-a-cursor"),
                1,
                None,
                WorkspaceResultsSource::WorkspaceItem,
            ),
            Err(ResultsError::Cursor(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn revision_hashes_critical_metadata_content_even_when_stat_is_unchanged() {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::MetadataExt;

        let temp = tempfile::tempdir().expect("temp");
        write_array(
            temp.path(),
            "fields/m",
            &[1.0],
            serde_json::json!({"quantity":"m"}),
        );
        let before = scan_root(temp.path()).expect("initial scan").revision;
        let attrs = temp.path().join("fields/m/.zattrs");
        let metadata = fs::metadata(&attrs).expect("attrs metadata");
        fs::write(&attrs, br#"{"quantity":"h"}"#).expect("rewrite same-size attrs");
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&attrs)
            .expect("reopen attrs");
        let times = [
            libc::timespec {
                tv_sec: metadata.atime(),
                tv_nsec: metadata.atime_nsec(),
            },
            libc::timespec {
                tv_sec: metadata.mtime(),
                tv_nsec: metadata.mtime_nsec(),
            },
        ];
        assert_eq!(
            unsafe { libc::futimens(file.as_raw_fd(), times.as_ptr()) },
            0
        );
        let after = scan_root(temp.path()).expect("changed scan").revision;
        assert_ne!(before, after);
    }

    #[test]
    fn scan_depth_and_aggregate_metadata_budgets_fail_closed() {
        let temp = tempfile::tempdir().expect("temp");
        let mut nested = temp.path().to_path_buf();
        for index in 0..=MAX_DEPTH {
            nested.push(format!("d{index}"));
            fs::create_dir(&nested).expect("nested directory");
        }
        assert!(matches!(
            read_results_catalog(
                temp.path(),
                None,
                100,
                None,
                WorkspaceResultsSource::WorkspaceItem,
            ),
            Err(ResultsError::TooLarge(_))
        ));

        fs::write(temp.path().join("marker"), b"x").expect("marker");
        let pinned = open_directory(temp.path()).expect("pinned root");
        let mut entries = (0..MAX_ENTRIES)
            .map(|index| RawEntry {
                relative: PathBuf::from(format!("existing-{index}")),
                path: temp.path().join(format!("existing-{index}")),
                kind: RawKind::File,
                size: 0,
                modified: None,
            })
            .collect::<Vec<_>>();
        assert!(matches!(
            walk_directory(&pinned, Path::new(""), 0, &mut entries),
            Err(ResultsError::TooLarge(_))
        ));

        let _budget = ReadBudget::begin();
        assert!(charge_metadata(MAX_METADATA_TOTAL).is_ok());
        assert!(matches!(charge_metadata(1), Err(ResultsError::TooLarge(_))));
        assert!(matches!(
            charge_scan_path(Path::new(&"x".repeat(MAX_PATH_BYTES + 1))),
            Err(ResultsError::TooLarge(_))
        ));
    }

    #[test]
    fn nested_results_budgets_do_not_reset_the_outer_charge() {
        let _outer = ResultsReadBudget::begin();
        assert!(charge_metadata(MAX_METADATA_TOTAL - 1).is_ok());
        {
            let _inner = ResultsReadBudget::begin();
            assert!(matches!(charge_metadata(2), Err(ResultsError::TooLarge(_))));
        }
        // The rejected inner charge consumes nothing, but the outer charge
        // must still be present: exactly one byte remains available.
        assert!(charge_metadata(1).is_ok());
        assert!(matches!(charge_metadata(1), Err(ResultsError::TooLarge(_))));
    }

    #[test]
    fn rejected_budget_charge_does_not_consume_bytes() {
        let _budget = ResultsReadBudget::begin();
        assert!(matches!(
            charge_metadata(MAX_METADATA_TOTAL + 1),
            Err(ResultsError::TooLarge(_))
        ));
        assert!(charge_metadata(1).is_ok());
    }

    #[test]
    fn raw_zarr_chunks_do_not_consume_catalog_entries_or_hide_sibling_arrays() {
        let temp = tempfile::tempdir().expect("temp");
        let array = temp.path().join("fields/large");
        write_json(
            &array.join(".zarray"),
            serde_json::json!({
                "zarr_format": 2,
                "shape": [1, 1],
                "chunks": [1, 1],
                "dtype": "<f8",
                "compressor": null,
                "filters": null,
                "order": "C",
                "dimension_separator": "."
            }),
        );
        for index in 0..=MAX_ENTRIES {
            fs::write(array.join(format!("{index}.0")), &[] as &[u8]).expect("raw chunk");
        }
        let slash_array = temp.path().join("fields/slash");
        write_json(
            &slash_array.join(".zarray"),
            serde_json::json!({
                "zarr_format": 2,
                "shape": [1, 1],
                "chunks": [1, 1],
                "dtype": "<f8",
                "compressor": null,
                "filters": null,
                "order": "C",
                "dimension_separator": "/"
            }),
        );
        fs::create_dir_all(slash_array.join("0")).expect("numeric chunk directory");
        fs::write(slash_array.join("0/0"), &[] as &[u8]).expect("numeric chunk");
        fs::create_dir_all(temp.path().join("exports")).expect("ordinary export directory");
        fs::write(temp.path().join("exports/README.txt"), b"array notes").expect("ordinary export");
        write_array(temp.path(), "fields/sibling", &[1.0], serde_json::json!({}));

        let scan = scan_root(temp.path()).expect("catalog remains bounded");
        assert!(scan
            .entries
            .iter()
            .any(|entry| entry.relative == Path::new("fields/large")));
        assert!(scan
            .entries
            .iter()
            .any(|entry| entry.relative == Path::new("fields/sibling")));
        assert!(scan
            .entries
            .iter()
            .any(|entry| entry.relative == Path::new("fields/slash")));
        assert!(scan
            .entries
            .iter()
            .any(|entry| entry.relative == Path::new("exports/README.txt")));
        assert!(!scan
            .entries
            .iter()
            .any(|entry| entry.relative == Path::new("fields/large/0.0")));
        assert!(!scan
            .entries
            .iter()
            .any(|entry| entry.relative == Path::new("fields/slash/0")));
    }

    #[test]
    fn catalog_keeps_fem_arrays_metadata_only_without_loading_mesh_geometry() {
        let temp = tempfile::tempdir().expect("temp");
        write_array(
            temp.path(),
            "stages/relax/fields/m",
            &[1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            serde_json::json!({
                "quantity": "m",
                "component_count": 3,
                "field_layout": "aos_node_major"
            }),
        );
        write_json(
            &temp.path().join("playback.json"),
            serde_json::json!({
                "schema": "fullmag.saved_playback.v1",
                "complete": true,
                "name": "FEM metadata-only",
                "fem_mesh": {
                    "geometry_path": "missing-geometry.json",
                    "geometry_sha256": "a".repeat(64)
                },
                "stages": [{
                    "stage_id": "relax",
                    "array_path": "stages/relax/fields/m",
                    "times_s": [0.0],
                    "quantity_ids": ["m"],
                    "field_layout": "aos_node_major"
                }]
            }),
        );
        let catalog = read_results_catalog(
            temp.path(),
            None,
            100,
            None,
            WorkspaceResultsSource::WorkspaceItem,
        )
        .expect("catalog metadata");
        let array = catalog
            .entries
            .iter()
            .find(|entry| entry.path == "stages/relax/fields/m")
            .expect("FEM array entry");
        assert!(!catalog.can_visualize_3d);
        assert!(array.reason.is_some());
    }

    #[test]
    fn invalid_fdm_playback_dimensions_disable_geometry_mapping() {
        let temp = tempfile::tempdir().expect("temp");
        write_array(
            temp.path(),
            "stages/relax/fields/m",
            &[1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            serde_json::json!({"quantity":"m"}),
        );
        write_json(
            &temp.path().join("playback.json"),
            serde_json::json!({
                "schema": "fullmag.saved_playback.v1",
                "complete": true,
                "name": "invalid FDM",
                "grid_cells_xyz": [0, 1, 1],
                "cell_size_m": [1.0, 1.0, 1.0],
                "origin_m": [0.0, 0.0, 0.0],
                "stages": [{
                    "stage_id": "relax",
                    "array_path": "stages/relax/fields/m",
                    "times_s": [0.0],
                    "quantity_ids": ["m"]
                }]
            }),
        );
        let catalog = read_results_catalog(
            temp.path(),
            None,
            100,
            None,
            WorkspaceResultsSource::WorkspaceItem,
        )
        .expect("metadata catalog");
        let array_id = catalog
            .entries
            .iter()
            .find_map(|entry| entry.array_id.clone())
            .expect("array");
        let array = read_results_array(temp.path(), &array_id, &catalog.revision, None)
            .expect("array metadata");
        assert!(!array.can_visualize_3d);
        assert!(array.geometry.is_none());
    }

    #[test]
    fn invalid_persisted_geometry_is_metadata_only() {
        let temp = tempfile::tempdir().expect("temp");
        write_array(
            temp.path(),
            "fields/m",
            &[1.0, 0.0, 0.0],
            serde_json::json!({
                "quantity": "m",
                "field_geometry": {
                    "backend": "fdm",
                    "grid_cells": [2, 1, 1],
                    "cell_size_m": [1.0, 1.0, 1.0],
                    "origin_m": [0.0, 0.0, 0.0]
                }
            }),
        );
        let catalog = read_results_catalog(
            temp.path(),
            None,
            100,
            None,
            WorkspaceResultsSource::WorkspaceItem,
        )
        .expect("catalog");
        let array_id = catalog
            .entries
            .iter()
            .find_map(|entry| entry.array_id.clone())
            .expect("array");
        let array = read_results_array(temp.path(), &array_id, &catalog.revision, None)
            .expect("array metadata");
        assert!(!array.can_visualize_3d);
        assert!(matches!(
            array.geometry.as_ref().map(|geometry| geometry.kind),
            Some(WorkspaceResultGeometryKind::Unknown)
        ));
        assert!(array
            .geometry
            .as_ref()
            .and_then(|geometry| geometry.reason.as_deref())
            .is_some_and(|reason| reason.contains("does not match")));
    }

    #[test]
    fn legacy_fdm_playback_geometry_requires_exact_array_path_and_shape() {
        let temp = tempfile::tempdir().expect("temp");
        let exact = temp.path().join("stages/relax/fields/m");
        write_json(
            &exact.join(".zarray"),
            serde_json::json!({
                "zarr_format": 2,
                "shape": [2, 6],
                "chunks": [1, 6],
                "dtype": "<f8",
                "compressor": null,
                "filters": null,
                "order": "C",
                "dimension_separator": "."
            }),
        );
        let frame = |values: [f64; 6]| {
            values
                .into_iter()
                .flat_map(|value| value.to_le_bytes())
                .collect::<Vec<_>>()
        };
        fs::write(exact.join("0.0"), frame([1.0, 0.0, 0.0, 0.0, 1.0, 0.0])).expect("frame 0");
        fs::write(exact.join("1.0"), frame([0.0, 0.0, 1.0, 1.0, 0.0, 0.0])).expect("frame 1");
        fs::write(
            temp.path().join("stages/relax/manifest.json"),
            br#"{"complete":true}"#,
        )
        .expect("stage manifest");
        write_array(
            temp.path(),
            "other/fields/m",
            &[1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            serde_json::json!({"quantity":"m"}),
        );
        write_json(
            &temp.path().join("playback.json"),
            serde_json::json!({
                "schema": "fullmag.saved_playback.v1",
                "complete": true,
                "name": "legacy FDM",
                "grid_cells_xyz": [2, 1, 1],
                "cell_size_m": [1.0, 1.0, 1.0],
                "origin_m": [0.0, 0.0, 0.0],
                "stages": [{
                    "stage_id": "relax",
                    "array_path": "stages/relax/fields/m",
                    "times_s": [0.0, 1.0],
                    "quantity_ids": ["m"]
                }]
            }),
        );
        let catalog = read_results_catalog(
            temp.path(),
            None,
            100,
            None,
            WorkspaceResultsSource::WorkspaceItem,
        )
        .expect("catalog");
        let exact_id = catalog
            .entries
            .iter()
            .find(|entry| entry.path == "stages/relax/fields/m")
            .and_then(|entry| entry.array_id.clone())
            .expect("exact playback array");
        let exact_array = read_results_array(temp.path(), &exact_id, &catalog.revision, None)
            .expect("exact playback metadata");
        assert!(exact_array.can_visualize_3d);
        assert_eq!(exact_array.coordinates.len(), 2);
        assert_eq!(exact_array.coordinates[0].value, Some(0.0));
        assert_eq!(exact_array.coordinates[1].value, Some(1.0));
        assert_eq!(exact_array.coordinates[1].sample_index, 1);
        assert_eq!(exact_array.field_layout.as_deref(), Some("aos_node_major"));
        assert_eq!(
            exact_array
                .geometry
                .as_ref()
                .and_then(|geometry| geometry.cells_xyz),
            Some([2, 1, 1])
        );

        let unrelated_id = catalog
            .entries
            .iter()
            .find(|entry| entry.path == "other/fields/m")
            .and_then(|entry| entry.array_id.clone())
            .expect("unrelated array");
        let unrelated = read_results_array(temp.path(), &unrelated_id, &catalog.revision, None)
            .expect("unrelated metadata");
        assert!(!unrelated.can_visualize_3d);
        assert!(unrelated.geometry.is_none());
        assert!(
            unrelated.coordinates.is_empty(),
            "unrelated fields cannot inherit playback times"
        );
    }

    #[test]
    fn compressed_legacy_fdm_descriptor_does_not_infer_unvalidated_geometry() {
        let temp = tempfile::tempdir().expect("temp");
        let exact = temp.path().join("stages/relax/fields/m");
        write_json(
            &exact.join(".zarray"),
            serde_json::json!({
                "zarr_format": 2,
                "shape": [2, 6],
                "chunks": [1, 6],
                "dtype": "<f8",
                "compressor": {"id": "zstd"},
                "filters": null,
                "order": "C",
                "dimension_separator": "."
            }),
        );
        write_json(
            &temp.path().join("playback.json"),
            serde_json::json!({
                "schema": "fullmag.saved_playback.v1",
                "complete": true,
                "name": "legacy FDM",
                "grid_cells_xyz": [2, 1, 1],
                "cell_size_m": [1.0, 1.0, 1.0],
                "origin_m": [0.0, 0.0, 0.0],
                "stages": [{
                    "stage_id": "relax",
                    "array_path": "stages/relax/fields/m",
                    "times_s": [0.0, 1.0],
                    "quantity_ids": ["m"]
                }]
            }),
        );

        let catalog = read_results_catalog(
            temp.path(),
            None,
            100,
            None,
            WorkspaceResultsSource::WorkspaceItem,
        )
        .expect("catalog");
        let array_id = catalog
            .entries
            .iter()
            .find(|entry| entry.path == "stages/relax/fields/m")
            .and_then(|entry| entry.array_id.clone())
            .expect("exact playback array");
        let array = read_results_array(temp.path(), &array_id, &catalog.revision, None)
            .expect("compressed playback metadata");

        // The canonical legacy playback validator cannot qualify compressed
        // arrays, so its descriptor must not authorize a layout or geometry.
        assert_eq!(array.field_layout, None);
        assert!(!array.can_read_values);
        assert!(!array.can_visualize_3d);
        assert!(array
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("compressed")));
        assert!(array.geometry.is_none());
        assert!(matches!(
            read_results_sample(temp.path(), &array.id, 0, &catalog.revision, None),
            Err(ResultsError::Unsupported(_))
        ));
    }

    #[test]
    fn fem_geometry_requires_exact_descriptor_binding_and_keeps_hash() {
        let context = GeometryContext {
            playback: SavedPlaybackResource {
                schema: "fullmag.saved_playback.v1".into(),
                revision: "revision".into(),
                name: "fem".into(),
                source_note: None,
                grid_cells_xyz: None,
                cell_size_m: None,
                origin_m: None,
                fem_mesh: Some(SavedPlaybackFemMesh {
                    node_count: 2,
                    cell_count: 1,
                    facet_count: 4,
                    geometry_sha256: "a".repeat(64),
                    topology_byte_length: None,
                    topology_sha256: None,
                    support_byte_length: None,
                    support_sha256: None,
                }),
                stages: Vec::new(),
            },
            stages: vec![PlaybackStageContext {
                array_path: "stages/relax/fields/m".into(),
                frame_count: 1,
                times_s: vec![0.0],
                quantity_ids: vec!["m".into()],
                field_layout: Some("aos_node_major".into()),
            }],
            fem_descriptor_declared: true,
        };
        let metadata = ArrayMetadata {
            shape: vec![1, 6],
            chunks: vec![1, 6],
            dtype: "<f8".into(),
            order: Some("C".into()),
            compressor: None,
            filters_present: false,
            dimension_separator: Some(".".into()),
            dimension_order: Vec::new(),
            quantity_id: Some("m".into()),
            quantity_ids: vec!["m".into()],
            unit: None,
            field_layout: Some("aos_node_major".into()),
            component_count: Some(3),
            attrs: Value::Null,
            published_coordinates: None,
        };
        let exact = RawEntry {
            relative: PathBuf::from("stages/relax/fields/m"),
            path: PathBuf::new(),
            kind: RawKind::Array,
            size: 0,
            modified: None,
        };
        let geometry = geometry_for_array(Path::new("/unused"), &exact, &metadata, Some(&context))
            .expect("bound FEM geometry");
        assert_eq!(geometry.kind, WorkspaceResultGeometryKind::FemP1);
        assert_eq!(
            geometry.playback_geometry_sha256.as_deref(),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
        assert_eq!(
            geometry.fem_mesh.as_ref().map(|mesh| mesh.node_count),
            Some(2)
        );
        assert_eq!(
            geometry
                .fem_mesh
                .as_ref()
                .map(|mesh| mesh.geometry_sha256.as_str()),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
        let unrelated = RawEntry {
            relative: PathBuf::from("other/fields/m"),
            ..exact.clone()
        };
        assert!(
            geometry_for_array(Path::new("/unused"), &unrelated, &metadata, Some(&context))
                .is_none()
        );
        let wrong_quantity = ArrayMetadata {
            quantity_id: Some("h_demag".into()),
            ..metadata
        };
        assert!(geometry_for_array(
            Path::new("/unused"),
            &exact,
            &wrong_quantity,
            Some(&context)
        )
        .is_none());
    }

    #[test]
    fn rejects_stale_revision_and_unsafe_links() {
        let temp = tempfile::tempdir().expect("temp");
        write_array(temp.path(), "fields/m", &[1.0], serde_json::json!({}));
        let catalog = read_results_catalog(
            temp.path(),
            None,
            100,
            None,
            WorkspaceResultsSource::WorkspaceItem,
        )
        .expect("catalog");
        fs::write(temp.path().join("fields/m/0.0"), 2_f64.to_le_bytes()).expect("mutate");
        let array_id = catalog
            .entries
            .iter()
            .find_map(|entry| entry.array_id.clone())
            .expect("array");
        assert!(matches!(
            read_results_sample(temp.path(), &array_id, 0, &catalog.revision, None),
            Err(ResultsError::StaleRevision)
        ));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(temp.path().join("fields"), temp.path().join("link"))
                .expect("symlink");
            assert!(matches!(
                read_results_catalog(
                    temp.path(),
                    None,
                    100,
                    None,
                    WorkspaceResultsSource::WorkspaceItem,
                ),
                Err(ResultsError::Link(_))
            ));
        }
    }

    #[test]
    fn compressed_array_is_metadata_only() {
        let temp = tempfile::tempdir().expect("temp");
        let directory = temp.path().join("fields/compressed");
        write_json(
            &directory.join(".zarray"),
            serde_json::json!({
                "shape":[1,1],"chunks":[1,1],"dtype":"<f8","compressor":{"id":"zstd"},"order":"C"
            }),
        );
        let catalog = read_results_catalog(
            temp.path(),
            None,
            100,
            None,
            WorkspaceResultsSource::WorkspaceItem,
        )
        .expect("catalog");
        let array_id = catalog
            .entries
            .iter()
            .find_map(|entry| entry.array_id.clone())
            .expect("array");
        let array =
            read_results_array(temp.path(), &array_id, &catalog.revision, None).expect("array");
        assert!(!array.can_read_values);
        assert!(matches!(
            read_results_sample(temp.path(), &array.id, 0, &catalog.revision, None),
            Err(ResultsError::Unsupported(_))
        ));
    }

    #[test]
    fn persisted_fdm_layout_and_known_vector_quantity_enable_3d() {
        let temp = tempfile::tempdir().expect("temp");
        write_json(
            &temp.path().join("metadata.json"),
            serde_json::json!({
                "artifact_layout": {
                    "backend": "fdm",
                    "origin_m": [0.0, 0.0, 0.0],
                    "grid_cells": [2, 1, 1],
                    "cell_size": [1.0, 1.0, 1.0]
                }
            }),
        );
        write_array(
            temp.path(),
            "fields/m",
            &[1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            serde_json::json!({
                "quantity":"m",
                "dimension_order":["sample","value"],
                "field_geometry": {
                    "backend": "fdm",
                    "grid_cells": [2, 1, 1],
                    "cell_size_m": [1.0, 1.0, 1.0],
                    "origin_m": [0.0, 0.0, 0.0]
                }
            }),
        );
        let catalog = read_results_catalog(
            temp.path(),
            None,
            100,
            None,
            WorkspaceResultsSource::Current,
        )
        .expect("catalog");
        let array_id = catalog
            .entries
            .iter()
            .find_map(|entry| entry.array_id.clone())
            .expect("array");
        let array =
            read_results_array(temp.path(), &array_id, &catalog.revision, None).expect("array");
        assert_eq!(array.component_count, Some(3));
        assert_eq!(array.field_layout, None);
        assert!(
            !array.can_visualize_3d,
            "geometry and vector length do not prove AoS versus SoA"
        );
        assert!(array
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("explicit")));
        let attrs_path = temp.path().join("fields/m/.zattrs");
        let mut attrs: Value = serde_json::from_slice(&fs::read(&attrs_path).unwrap()).unwrap();
        attrs["field_layout"] = serde_json::json!("aos_node_major");
        write_json(&attrs_path, attrs);
        let refreshed = read_results_catalog(
            temp.path(),
            None,
            100,
            None,
            WorkspaceResultsSource::Current,
        )
        .unwrap();
        let array = read_results_array(temp.path(), &array_id, &refreshed.revision, None).unwrap();
        assert_eq!(array.field_layout.as_deref(), Some("aos_node_major"));
        assert!(array.can_visualize_3d);
        assert_eq!(
            array
                .geometry
                .as_ref()
                .and_then(|geometry| geometry.cells_xyz),
            Some([2, 1, 1])
        );
    }

    #[test]
    fn run_identity_is_pinned_when_present() {
        let temp = tempfile::tempdir().expect("temp");
        write_json(
            &temp.path().join("fullmag-run.json"),
            serde_json::json!({"run_id":"run-a"}),
        );
        let catalog = read_results_catalog(
            temp.path(),
            None,
            100,
            Some("run-a"),
            WorkspaceResultsSource::Current,
        )
        .expect("catalog");
        assert_eq!(catalog.run_id.as_deref(), Some("run-a"));
        assert!(matches!(
            read_results_catalog(
                temp.path(),
                None,
                100,
                Some("run-b"),
                WorkspaceResultsSource::Current,
            ),
            Err(ResultsError::RunMismatch { .. })
        ));
        fs::remove_file(temp.path().join("fullmag-run.json")).expect("remove run marker");
        assert!(matches!(
            read_results_catalog(
                temp.path(),
                None,
                100,
                Some("run-a"),
                WorkspaceResultsSource::Current,
            ),
            Err(ResultsError::Unsupported(message))
                if message.contains("durable result run identity")
        ));
    }

    #[test]
    fn contradictory_durable_run_markers_are_rejected() {
        let temp = tempfile::tempdir().expect("temp");
        write_json(
            &temp.path().join("fullmag-run.json"),
            serde_json::json!({"run_id":"run-a"}),
        );
        write_json(
            &temp.path().join("output-storage.json"),
            serde_json::json!({"run_id":"run-b"}),
        );
        assert!(matches!(
            read_results_catalog(
                temp.path(),
                None,
                100,
                Some("run-a"),
                WorkspaceResultsSource::Current,
            ),
            Err(ResultsError::RunMismatch { actual, .. })
                if actual.contains("run-a") && actual.contains("run-b")
        ));
    }

    #[test]
    fn fem_nodal_reader_uses_the_nested_autosave_store_and_hides_its_objects() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let store = root.join("results_browser.zarr");
        write_json(&store.join(".zgroup"), serde_json::json!({"zarr_format":2}));
        let binding = write_fem_nodal_fixture(&store, QuantityId::HEff,
            fullmag_session::saved_fem_nodal::FemNodalStorageLayout::SoaComponentMajor);
        let array_path = format!("results_browser.zarr/{}", binding.array_path);
        let (id, revision) = fixture_array_id_for_path(root, &array_path);
        let geometry = read_results_fem_nodal_geometry(root, &id, &revision, None).unwrap().unwrap();
        assert_eq!(geometry.binding, binding);
        assert_eq!(geometry.active_node_mask, vec![true; 4]);
        let catalog = read_results_catalog(root, None, 100, None, WorkspaceResultsSource::WorkspaceItem).unwrap();
        assert!(!catalog.entries.iter().any(|entry| entry.path.contains(FEM_NODAL_OBJECT_DIRECTORY)));
        // A matching object in the outer folder must never replace a missing
        // object in the store named by the owning array's exact path.
        let relative = fem_nodal_object_relative_path(&binding.mesh).unwrap();
        fs::create_dir_all(root.join(FEM_NODAL_OBJECT_DIRECTORY)).unwrap();
        fs::copy(store.join(&relative), root.join(&relative)).unwrap();
        fs::remove_file(store.join(&relative)).unwrap();
        let (id, revision) = fixture_array_id_for_path(root, &array_path);
        assert!(matches!(read_results_fem_nodal_geometry(root, &id, &revision, None), Err(ResultsError::Invalid(_))));
    }

    #[test]
    fn fem_nodal_reader_accepts_bound_m_and_full_domain_h_eff() {
        for (quantity, layout, expected_mask) in [
            (
                QuantityId::M,
                fullmag_session::saved_fem_nodal::FemNodalStorageLayout::AosNodeMajor,
                vec![true, false, true, true],
            ),
            (
                QuantityId::HEff,
                fullmag_session::saved_fem_nodal::FemNodalStorageLayout::SoaComponentMajor,
                vec![true; 4],
            ),
        ] {
            let temp = tempfile::tempdir().expect("temp");
            let root = temp.path();
            let binding = write_fem_nodal_fixture(root, quantity, layout);
            write_json(
                &root.join("fullmag-run.json"),
                serde_json::json!({"run_id":"saved-nodal-run"}),
            );
            let (array_id, revision) = fixture_array_id(root, &binding);
            let geometry = read_results_fem_nodal_geometry(
                root,
                &array_id,
                &revision,
                Some("saved-nodal-run"),
            )
            .expect("read strict FEM geometry")
            .expect("binding present");
            assert_eq!(geometry.binding, binding);
            assert_eq!(geometry.active_node_mask, expected_mask);
            assert_eq!(geometry.mesh.mesh.nodes.len(), binding.node_count);
            assert_eq!(geometry.mesh.mesh.cells.len(), binding.cell_count);
            assert_eq!(geometry.binding.field_layout, layout);
            let binding_bytes = serde_json::to_vec(&binding).expect("binding JSON");
            assert_eq!(
                geometry.geometry_sha256,
                hex_bytes(&Sha256::digest(binding_bytes))
            );
        }
    }

    #[test]
    fn absent_binding_is_none_but_null_binding_is_invalid() {
        let temp = tempfile::tempdir().expect("temp");
        write_array(
            temp.path(),
            "stages/relax/fields/m",
            &[1.0; 12],
            serde_json::json!({
                "quantity":"m",
                "unit":"1",
                "field_layout":"aos_node_major",
                "dimension_order":["sample","value"]
            }),
        );
        let (array_id, revision) = fixture_array_id_for_path(temp.path(), "stages/relax/fields/m");
        assert!(
            read_results_fem_nodal_geometry(temp.path(), &array_id, &revision, None,)
                .expect("missing binding is legacy-compatible")
                .is_none()
        );

        let attrs_path = temp.path().join("stages/relax/fields/m/.zattrs");
        let mut attrs: Value = serde_json::from_slice(&fs::read(&attrs_path).unwrap()).unwrap();
        attrs["fem_nodal_binding"] = Value::Null;
        write_json(&attrs_path, attrs);
        let (_, null_revision) = fixture_array_id_for_path(temp.path(), "stages/relax/fields/m");
        assert!(matches!(
            read_results_fem_nodal_geometry(temp.path(), &array_id, &null_revision, None),
            Err(ResultsError::Invalid(_))
        ));
    }

    #[test]
    fn fem_nodal_binding_rejects_metadata_drift_in_unit_layout_component_path_and_shape() {
        fn assert_invalid(mutate: impl FnOnce(&Path, &mut Value)) {
            let temp = tempfile::tempdir().expect("temp");
            let root = temp.path();
            let binding = write_fem_nodal_fixture(
                root,
                QuantityId::M,
                fullmag_session::saved_fem_nodal::FemNodalStorageLayout::AosNodeMajor,
            );
            let attrs_path = root.join(&binding.array_path).join(".zattrs");
            let mut attrs: Value = serde_json::from_slice(&fs::read(&attrs_path).unwrap()).unwrap();
            mutate(root, &mut attrs);
            write_json(&attrs_path, attrs);
            let (array_id, revision) = fixture_array_id(root, &binding);
            assert!(matches!(
                read_results_fem_nodal_geometry(root, &array_id, &revision, None),
                Err(ResultsError::Invalid(_))
            ));
        }

        assert_invalid(|_, attrs| attrs["unit"] = serde_json::json!("A/m"));
        assert_invalid(|_, attrs| attrs["quantity"] = serde_json::json!("H_eff"));
        assert_invalid(|_, attrs| attrs["field_layout"] = serde_json::json!("soa_component_major"));
        assert_invalid(|_, attrs| attrs["component_count"] = serde_json::json!(1));
        assert_invalid(|_, attrs| attrs["fem_nodal_binding"]["node_count"] = serde_json::json!(5));
        assert_invalid(|_, attrs| {
            attrs["fem_nodal_binding"]["array_path"] = serde_json::json!("stages/other/fields/m")
        });
        assert_invalid(|_, attrs| attrs["fem_nodal_binding"]["cell_count"] = serde_json::json!(2));
        assert_invalid(|root, _| {
            let zarray_path = root.join("stages/relax/fields/m/.zarray");
            let mut zarray: Value =
                serde_json::from_slice(&fs::read(&zarray_path).unwrap()).unwrap();
            zarray["shape"][1] = serde_json::json!(11);
            zarray["chunks"][1] = serde_json::json!(11);
            write_json(&zarray_path, zarray);
        });
    }

    #[test]
    fn fem_nodal_reference_hashes_are_verified_for_both_objects() {
        for corrupt_mesh in [true, false] {
            let temp = tempfile::tempdir().expect("temp");
            let root = temp.path();
            let binding = write_fem_nodal_fixture(
                root,
                QuantityId::M,
                fullmag_session::saved_fem_nodal::FemNodalStorageLayout::AosNodeMajor,
            );
            let reference = if corrupt_mesh {
                &binding.mesh
            } else {
                &binding.semantics
            };
            let object_path = root
                .join(fem_nodal_object_relative_path(reference).expect("immutable object path"));
            let mut bytes = fs::read(&object_path).expect("object bytes");
            bytes[0] ^= 1;
            fs::write(object_path, bytes).expect("corrupt referenced object");
            let (array_id, revision) = fixture_array_id(root, &binding);
            assert!(matches!(
                read_results_fem_nodal_geometry(root, &array_id, &revision, None),
                Err(ResultsError::Invalid(_))
            ));
        }
    }

    #[test]
    fn fem_nodal_reference_lengths_are_verified_before_parsing() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path();
        let binding = write_fem_nodal_fixture(
            root,
            QuantityId::M,
            fullmag_session::saved_fem_nodal::FemNodalStorageLayout::AosNodeMajor,
        );
        let object_path =
            root.join(fem_nodal_object_relative_path(&binding.mesh).expect("mesh object path"));
        let mut bytes = fs::read(&object_path).expect("mesh object");
        bytes.pop();
        fs::write(object_path, bytes).expect("truncate mesh object");
        let (array_id, revision) = fixture_array_id(root, &binding);
        assert!(matches!(
            read_results_fem_nodal_geometry(root, &array_id, &revision, None),
            Err(ResultsError::Invalid(_))
        ));
    }

    #[test]
    fn fem_nodal_binding_never_falls_back_and_internal_objects_stay_hidden_but_revisioned() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path();
        let binding = write_fem_nodal_fixture(
            root,
            QuantityId::M,
            fullmag_session::saved_fem_nodal::FemNodalStorageLayout::AosNodeMajor,
        );
        let attrs_path = root.join(&binding.array_path).join(".zattrs");
        let mut attrs: Value = serde_json::from_slice(&fs::read(&attrs_path).unwrap()).unwrap();
        attrs["field_geometry"] = serde_json::json!({
            "backend":"fdm",
            "grid_cells":[4,1,1],
            "cell_size_m":[1.0,1.0,1.0],
            "origin_m":[0.0,0.0,0.0]
        });
        attrs["fem_nodal_binding"]["array_path"] = serde_json::json!("stages/other/fields/m");
        write_json(&attrs_path, attrs);

        let (array_id, revision) = fixture_array_id(root, &binding);
        let array = read_results_array(root, &array_id, &revision, None).expect("array metadata");
        assert!(array.geometry.is_none());
        assert!(!array.can_visualize_3d);
        assert!(array
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("FEM nodal geometry binding")));
        assert!(matches!(
            read_results_fem_nodal_geometry(root, &array_id, &revision, None),
            Err(ResultsError::Invalid(_))
        ));

        let catalog =
            read_results_catalog(root, None, 100, None, WorkspaceResultsSource::WorkspaceItem)
                .expect("catalog excludes internal geometry objects");
        assert!(catalog
            .entries
            .iter()
            .all(|entry| !entry.path.starts_with(FEM_NODAL_OBJECT_DIRECTORY)));
        let public_count = catalog.total_count;
        let internal_relative =
            PathBuf::from(fem_nodal_object_relative_path(&binding.mesh).expect("mesh object path"));
        let internal_id = opaque_id("entry", &internal_relative);
        assert!(matches!(
            read_results_entry(root, &internal_id, &catalog.revision, None),
            Err(ResultsError::NotFound(_))
        ));

        fs::write(
            root.join(FEM_NODAL_OBJECT_DIRECTORY).join("extra.json"),
            b"{}",
        )
        .expect("change internal geometry namespace");
        let updated =
            read_results_catalog(root, None, 100, None, WorkspaceResultsSource::WorkspaceItem)
                .expect("revised catalog");
        assert_ne!(updated.revision, catalog.revision);
        assert_eq!(updated.total_count, public_count);
        assert!(matches!(
            read_results_fem_nodal_geometry(root, &array_id, &catalog.revision, None),
            Err(ResultsError::StaleRevision)
        ));
    }

    #[test]
    #[cfg(unix)]
    fn fem_nodal_geometry_object_symlink_is_rejected() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path();
        let binding = write_fem_nodal_fixture(
            root,
            QuantityId::M,
            fullmag_session::saved_fem_nodal::FemNodalStorageLayout::AosNodeMajor,
        );
        let (array_id, revision) = fixture_array_id(root, &binding);
        let object_path =
            root.join(fem_nodal_object_relative_path(&binding.mesh).expect("mesh object path"));
        fs::remove_file(&object_path).expect("remove object");
        symlink("/etc/passwd", &object_path).expect("install symlink");
        assert!(matches!(
            read_results_fem_nodal_geometry(root, &array_id, &revision, None),
            Err(ResultsError::Link(_))
        ));
    }

    #[test]
    fn fem_nodal_geometry_references_obey_the_shared_metadata_budget() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path();
        let mut binding = write_fem_nodal_fixture(
            root,
            QuantityId::M,
            fullmag_session::saved_fem_nodal::FemNodalStorageLayout::AosNodeMajor,
        );
        binding.mesh.object_ref = "a".repeat(64);
        binding.mesh.byte_length = 33 * 1024 * 1024;
        let attrs_path = root.join(&binding.array_path).join(".zattrs");
        let mut attrs: Value = serde_json::from_slice(&fs::read(&attrs_path).unwrap()).unwrap();
        attrs["fem_nodal_binding"] =
            serde_json::to_value(&binding).expect("oversized reference JSON");
        write_json(&attrs_path, attrs);
        let (array_id, revision) = fixture_array_id(root, &binding);
        assert!(matches!(
            read_results_fem_nodal_geometry(root, &array_id, &revision, None),
            Err(ResultsError::TooLarge(_))
        ));
    }
}
