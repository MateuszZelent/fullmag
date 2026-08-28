use fullmag_ir::{
    compute_mixed_certificate_evidence,
    validate_mixed_layer_topology_certificate_and_compute_evidence, FemCellMeshPartIR,
    FemCellTypeIR, FemConnectivityIR, FemFacetConnectivityIR, FemFacetRoleIR, FemFacetTypeIR,
    MeshIR, MeshPeriodicBoundaryPairIR, MeshPeriodicNodePairIR, MixedCertificateEvidenceV1,
    MixedLayerTopologyCertificateV1IR,
};
use numpy::{PyReadonlyArray1, PyReadonlyArray2, PyUntypedArrayMethods};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::PyDict;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::Instant;

#[cfg(test)]
use std::cell::Cell;

const CERTIFIER_ALGORITHM_ID: &str = "fullmag.mixed-certificate.rust-rayon.v1";
const CERTIFICATE_RESULT_SCHEMA: &str = "fullmag.mixed-certificate-native-result.v1";
const CERTIFICATE_JSON_MAX_BYTES: usize = 1024 * 1024;
const PREFLIGHT_RESULT_SCHEMA: &str = "fullmag.mixed-preflight-native-result.v1";
const CELL_TOPOLOGY_CODES: [(&str, u8, FemCellTypeIR); 4] = [
    ("tet4", 1, FemCellTypeIR::Tet4),
    ("prism6", 2, FemCellTypeIR::Prism6),
    ("pyramid5", 3, FemCellTypeIR::Pyramid5),
    ("hex8", 4, FemCellTypeIR::Hex8),
];
const FACET_TOPOLOGY_CODES: [(&str, u8, FemFacetTypeIR); 2] = [
    ("tri3", 11, FemFacetTypeIR::Tri3),
    ("quad4", 12, FemFacetTypeIR::Quad4),
];

#[derive(Debug, Deserialize)]
struct CellRegionMetadata {
    id: i64,
    marker: i64,
    mesh_part: String,
}

#[derive(Debug, Deserialize)]
struct TypedMeshMetadata {
    #[serde(default = "default_mesh_name")]
    mesh_name: String,
    cell_regions: Vec<CellRegionMetadata>,
    facet_roles_by_marker: BTreeMap<String, String>,
    #[serde(default)]
    periodic_boundary_pairs: Vec<MeshPeriodicBoundaryPairIR>,
    #[serde(default)]
    periodic_node_pairs: Vec<MeshPeriodicNodePairIR>,
}

fn default_mesh_name() -> String {
    "mixed-mesh".to_string()
}

#[derive(Clone, Copy)]
struct TypedMeshSlices<'a> {
    node_ids: &'a [i64],
    node_coordinates: &'a [f64],
    node_coordinate_shape: [usize; 2],
    cell_global_ordinals: &'a [i64],
    cell_topology_codes: &'a [u8],
    cell_region_ids: &'a [i64],
    cell_offsets: &'a [i64],
    cell_connectivity: &'a [i64],
    facet_global_ordinals: &'a [i64],
    facet_topology_codes: &'a [u8],
    facet_marker_ids: &'a [i64],
    facet_offsets: &'a [i64],
    facet_connectivity: &'a [i64],
}

#[derive(Debug, Serialize)]
struct NativeCertificateResult {
    schema_version: &'static str,
    evidence: MixedCertificateEvidenceV1,
    topology_fingerprint_v3: String,
    certificate_payload_sha256: Option<String>,
    algorithm_id: &'static str,
    rayon_threads: usize,
    elapsed_ns: u64,
    validated_claimed_certificate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct NativeMeshCounts {
    nodes: usize,
    cells: usize,
    facets: usize,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreflightExpected {
    counts: NativeMeshCounts,
    topology_fingerprint_v3: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreflightEnvelope {
    metadata: TypedMeshMetadata,
    expected: PreflightExpected,
}

#[derive(Debug, Serialize)]
struct NativePreflightResult {
    schema_version: &'static str,
    counts: NativeMeshCounts,
    topology_fingerprint_v3: String,
    elapsed_ns: u64,
}

fn decode_cell_topology_code(code: u8) -> Result<FemCellTypeIR, String> {
    CELL_TOPOLOGY_CODES
        .iter()
        .find_map(|(_, candidate, cell_type)| (*candidate == code).then_some(*cell_type))
        .ok_or_else(|| format!("unknown cell topology code {code}"))
}

fn decode_facet_topology_code(code: u8) -> Result<FemFacetTypeIR, String> {
    FACET_TOPOLOGY_CODES
        .iter()
        .find_map(|(_, candidate, facet_type)| (*candidate == code).then_some(*facet_type))
        .ok_or_else(|| format!("unknown facet topology code {code}"))
}

#[pyfunction]
pub(crate) fn mixed_mesh_topology_codes_json() -> PyResult<String> {
    let cells = CELL_TOPOLOGY_CODES
        .iter()
        .map(|(name, code, _)| (*name, *code))
        .collect::<BTreeMap<_, _>>();
    let facets = FACET_TOPOLOGY_CODES
        .iter()
        .map(|(name, code, _)| (*name, *code))
        .collect::<BTreeMap<_, _>>();
    serde_json::to_string(&serde_json::json!({"cells": cells, "facets": facets}))
        .map_err(|error| PyValueError::new_err(error.to_string()))
}

fn parse_mesh_part(value: &str) -> Result<FemCellMeshPartIR, String> {
    match value {
        "magnetic" => Ok(FemCellMeshPartIR::Magnetic),
        "transition_air" => Ok(FemCellMeshPartIR::TransitionAir),
        "far_air" => Ok(FemCellMeshPartIR::FarAir),
        other => Err(format!("unknown cell mesh part {other}")),
    }
}

fn parse_facet_role(value: &str) -> Result<FemFacetRoleIR, String> {
    match value {
        "exterior" => Ok(FemFacetRoleIR::Exterior),
        "material_interface" => Ok(FemFacetRoleIR::MaterialInterface),
        "periodic_seam" => Ok(FemFacetRoleIR::PeriodicSeam),
        other => Err(format!("unknown facet role {other}")),
    }
}

fn validate_csr_offsets(
    label: &str,
    item_count: usize,
    offsets: &[i64],
    connectivity_len: usize,
) -> Result<Vec<u32>, String> {
    if offsets.len() != item_count + 1 {
        return Err(format!(
            "{label} CSR offsets length {} does not match item count {} plus one",
            offsets.len(),
            item_count
        ));
    }
    if offsets.first().copied() != Some(0) {
        return Err(format!("{label} CSR offsets must start at zero"));
    }
    if offsets.windows(2).any(|pair| pair[0] > pair[1]) {
        return Err(format!("{label} CSR offsets must be nondecreasing"));
    }
    let terminal = *offsets.last().unwrap_or(&-1);
    if terminal < 0 || terminal as usize != connectivity_len {
        return Err(format!(
            "{label} CSR terminal offset {terminal} does not match connectivity length {connectivity_len}"
        ));
    }
    offsets
        .iter()
        .map(|value| {
            u32::try_from(*value)
                .map_err(|_| format!("{label} CSR offset {value} is outside u32 range"))
        })
        .collect()
}

fn copy_global_ordinals(label: &str, values: &[i64]) -> Result<Vec<u64>, String> {
    let copied = values
        .iter()
        .map(|value| {
            u64::try_from(*value)
                .map_err(|_| format!("{label} global ordinal {value} must be non-negative"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if copied.iter().copied().collect::<BTreeSet<_>>().len() != copied.len() {
        return Err(format!("{label} global ordinals must be unique"));
    }
    Ok(copied)
}

enum NodeIdLookup {
    Dense { node_count: u32 },
    Sparse(BTreeMap<i64, u32>),
}

fn build_node_id_lookup(node_ids: &[i64]) -> Result<NodeIdLookup, String> {
    let node_count =
        u32::try_from(node_ids.len()).map_err(|_| "node count exceeds u32 range".to_string())?;
    if node_ids
        .iter()
        .copied()
        .enumerate()
        .all(|(index, node_id)| node_id == index as i64)
    {
        return Ok(NodeIdLookup::Dense { node_count });
    }

    let mut node_index = BTreeMap::new();
    for (index, node_id) in node_ids.iter().copied().enumerate() {
        if node_id < 0 {
            return Err(format!("node id {node_id} must be non-negative"));
        }
        let local = u32::try_from(index).expect("node count was checked above");
        if node_index.insert(node_id, local).is_some() {
            return Err(format!("node id {node_id} is duplicated"));
        }
    }
    Ok(NodeIdLookup::Sparse(node_index))
}

fn copy_connectivity(
    label: &str,
    values: &[i64],
    node_lookup: &NodeIdLookup,
) -> Result<Vec<u32>, String> {
    values
        .iter()
        .map(|node_id| {
            let local = match node_lookup {
                NodeIdLookup::Dense { node_count } => u32::try_from(*node_id)
                    .ok()
                    .filter(|node_id| node_id < node_count),
                NodeIdLookup::Sparse(node_index) => node_index.get(node_id).copied(),
            };
            local
                .ok_or_else(|| format!("{label} connectivity references unknown node id {node_id}"))
        })
        .collect()
}

fn build_mesh(input: TypedMeshSlices<'_>, metadata: TypedMeshMetadata) -> Result<MeshIR, String> {
    if input.node_coordinate_shape != [input.node_ids.len(), 3] {
        return Err(format!(
            "node_coordinates shape {:?} must be [{}, 3]",
            input.node_coordinate_shape,
            input.node_ids.len()
        ));
    }
    if input.node_coordinates.len() != input.node_ids.len() * 3 {
        return Err("node_coordinates storage length does not match shape [N, 3]".to_string());
    }
    if input
        .node_coordinates
        .iter()
        .any(|value| !value.is_finite())
    {
        return Err("node_coordinates must contain only finite values".to_string());
    }
    let node_lookup = build_node_id_lookup(input.node_ids)?;
    let nodes = input
        .node_coordinates
        .chunks_exact(3)
        .map(|row| [row[0], row[1], row[2]])
        .collect::<Vec<_>>();

    let cell_count = input.cell_topology_codes.len();
    if input.cell_global_ordinals.len() != cell_count || input.cell_region_ids.len() != cell_count {
        return Err(
            "cell ordinals, topology codes, and region ids must have equal length".to_string(),
        );
    }
    let cell_offsets = validate_csr_offsets(
        "cell",
        cell_count,
        input.cell_offsets,
        input.cell_connectivity.len(),
    )?;
    let cell_types = input
        .cell_topology_codes
        .iter()
        .map(|code| decode_cell_topology_code(*code))
        .collect::<Result<Vec<_>, _>>()?;
    for (index, cell_type) in cell_types.iter().enumerate() {
        let arity = cell_offsets[index + 1] - cell_offsets[index];
        if arity as usize != cell_type.arity() {
            return Err(format!(
                "cell {index} topology {cell_type:?} requires arity {} but CSR provides {arity}",
                cell_type.arity()
            ));
        }
    }
    let region_definitions = metadata
        .cell_regions
        .iter()
        .map(|region| {
            let marker = u32::try_from(region.marker)
                .map_err(|_| format!("cell marker {} is outside u32 range", region.marker))?;
            Ok((region.id, (marker, parse_mesh_part(&region.mesh_part)?)))
        })
        .collect::<Result<BTreeMap<_, _>, String>>()?;
    if region_definitions.len() != metadata.cell_regions.len() {
        return Err("cell region metadata ids must be unique".to_string());
    }
    let mut element_markers = Vec::with_capacity(cell_count);
    let mut mesh_parts = Vec::with_capacity(cell_count);
    for region_id in input.cell_region_ids {
        let (marker, part) = region_definitions
            .get(region_id)
            .copied()
            .ok_or_else(|| format!("cell region id {region_id} has no metadata definition"))?;
        element_markers.push(marker);
        mesh_parts.push(part);
    }
    let cells = FemConnectivityIR {
        types: cell_types,
        offsets: cell_offsets,
        nodes: copy_connectivity("cell", input.cell_connectivity, &node_lookup)?,
        global_ordinals: copy_global_ordinals("cell", input.cell_global_ordinals)?,
        mesh_parts,
    };

    let facet_count = input.facet_topology_codes.len();
    if input.facet_global_ordinals.len() != facet_count
        || input.facet_marker_ids.len() != facet_count
    {
        return Err(
            "facet ordinals, topology codes, and marker ids must have equal length".to_string(),
        );
    }
    let facet_offsets = validate_csr_offsets(
        "facet",
        facet_count,
        input.facet_offsets,
        input.facet_connectivity.len(),
    )?;
    let facet_types = input
        .facet_topology_codes
        .iter()
        .map(|code| decode_facet_topology_code(*code))
        .collect::<Result<Vec<_>, _>>()?;
    for (index, facet_type) in facet_types.iter().enumerate() {
        let arity = facet_offsets[index + 1] - facet_offsets[index];
        if arity as usize != facet_type.arity() {
            return Err(format!(
                "facet {index} topology {facet_type:?} requires arity {} but CSR provides {arity}",
                facet_type.arity()
            ));
        }
    }
    let boundary_markers = input
        .facet_marker_ids
        .iter()
        .map(|marker| {
            u32::try_from(*marker)
                .map_err(|_| format!("facet marker {marker} is outside u32 range"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let facet_roles = input
        .facet_marker_ids
        .iter()
        .map(|marker| {
            metadata
                .facet_roles_by_marker
                .get(&marker.to_string())
                .ok_or_else(|| format!("facet marker {marker} has no role metadata"))
                .and_then(|role| parse_facet_role(role))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let facets = FemFacetConnectivityIR {
        types: facet_types,
        roles: facet_roles,
        offsets: facet_offsets,
        nodes: copy_connectivity("facet", input.facet_connectivity, &node_lookup)?,
        global_ordinals: copy_global_ordinals("facet", input.facet_global_ordinals)?,
    };

    let mesh = MeshIR {
        mesh_name: metadata.mesh_name,
        nodes,
        cells,
        element_markers,
        facets,
        boundary_markers,
        periodic_boundary_pairs: metadata.periodic_boundary_pairs,
        periodic_node_pairs: metadata.periodic_node_pairs,
        per_domain_quality: HashMap::new(),
    };
    Ok(mesh)
}

fn canonicalize_certificate_json_with_python(py: Python<'_>, payload: &str) -> PyResult<String> {
    let json = py.import("json")?;
    let parsed = json.call_method1("loads", (payload,))?;
    let kwargs = PyDict::new(py);
    kwargs.set_item("sort_keys", true)?;
    kwargs.set_item("separators", (",", ":"))?;
    kwargs.set_item("allow_nan", false)?;
    json.call_method("dumps", (parsed,), Some(&kwargs))?
        .extract()
}

fn enforce_certificate_json_size(payload: &str) -> Result<(), String> {
    if payload.len() > CERTIFICATE_JSON_MAX_BYTES {
        return Err(format!(
            "mixed certificate JSON exceeds {CERTIFICATE_JSON_MAX_BYTES}-byte limit"
        ));
    }
    Ok(())
}

fn prepare_certificate_json_with<F>(
    payload: &str,
    mut canonicalize: F,
) -> PyResult<(MixedLayerTopologyCertificateV1IR, String)>
where
    F: FnMut(&str) -> PyResult<String>,
{
    enforce_certificate_json_size(payload).map_err(PyValueError::new_err)?;
    let canonical_input = canonicalize(payload)?;
    let certificate: MixedLayerTopologyCertificateV1IR = serde_json::from_str(&canonical_input)
        .map_err(|error| {
            PyValueError::new_err(format!("invalid mixed certificate JSON: {error}"))
        })?;
    certificate
        .validate()
        .map_err(|errors| PyValueError::new_err(errors.join("; ")))?;
    let typed_projection = serde_json::to_string(&certificate).map_err(|error| {
        PyValueError::new_err(format!("invalid mixed certificate JSON: {error}"))
    })?;
    let canonical_typed_projection = canonicalize(&typed_projection)?;
    Ok((certificate, canonical_typed_projection))
}

fn canonical_certificate_digest(canonical_json: &str) -> String {
    let digest = Sha256::digest(canonical_json.as_bytes());
    format!("sha256:{digest:x}")
}

#[cfg(test)]
thread_local! {
    static CERTIFICATE_ENGINE_PROBE_CALLS: Cell<usize> = const { Cell::new(0) };
}

#[cfg(test)]
fn record_certificate_engine_call() {
    CERTIFICATE_ENGINE_PROBE_CALLS.with(|calls| calls.set(calls.get() + 1));
}

#[cfg(not(test))]
fn record_certificate_engine_call() {}

#[cfg(test)]
fn reset_certificate_engine_probe() {
    CERTIFICATE_ENGINE_PROBE_CALLS.with(|calls| calls.set(0));
}

#[cfg(test)]
fn certificate_engine_probe_calls() -> usize {
    CERTIFICATE_ENGINE_PROBE_CALLS.with(Cell::get)
}

fn run_certificate(
    mesh: MeshIR,
    certificate: Option<MixedLayerTopologyCertificateV1IR>,
    canonical_certificate_json: Option<String>,
) -> Result<NativeCertificateResult, String> {
    let started = Instant::now();
    let certificate_payload_sha256 = canonical_certificate_json
        .as_deref()
        .map(canonical_certificate_digest);
    let (evidence, topology_fingerprint_v3, validated) = match certificate {
        Some(certificate) => {
            if certificate.topology_fingerprint_version != "v3" {
                return Err(
                    "native mixed mesh certifier requires topology fingerprint v3".to_string(),
                );
            }
            record_certificate_engine_call();
            let evidence =
                validate_mixed_layer_topology_certificate_and_compute_evidence(&mesh, &certificate)
                    .map_err(|errors| errors.join("; "))?;
            (evidence, certificate.topology_fingerprint, true)
        }
        None => {
            record_certificate_engine_call();
            let evidence =
                compute_mixed_certificate_evidence(&mesh).map_err(|errors| errors.join("; "))?;
            let fingerprint = mesh.mixed_topology_fingerprint_v3()?;
            (evidence, fingerprint, false)
        }
    };
    Ok(NativeCertificateResult {
        schema_version: CERTIFICATE_RESULT_SCHEMA,
        evidence,
        topology_fingerprint_v3,
        certificate_payload_sha256,
        algorithm_id: CERTIFIER_ALGORITHM_ID,
        rayon_threads: rayon::current_num_threads(),
        elapsed_ns: started.elapsed().as_nanos().min(u64::MAX as u128) as u64,
        validated_claimed_certificate: validated,
    })
}

fn run_preflight(
    mesh: MeshIR,
    expected: PreflightExpected,
) -> Result<NativePreflightResult, String> {
    let started = Instant::now();
    mesh.validate().map_err(|errors| errors.join("; "))?;
    let counts = NativeMeshCounts {
        nodes: mesh.nodes.len(),
        cells: mesh.cells.len(),
        facets: mesh.facets.len(),
    };
    if counts != expected.counts {
        return Err(format!(
            "mixed mesh preflight counts are stale: expected {:?}, actual {:?}",
            expected.counts, counts
        ));
    }
    let topology_fingerprint_v3 = mesh.mixed_topology_fingerprint_v3()?;
    if topology_fingerprint_v3 != expected.topology_fingerprint_v3 {
        return Err("mixed mesh preflight topology fingerprint is stale".to_string());
    }
    Ok(NativePreflightResult {
        schema_version: PREFLIGHT_RESULT_SCHEMA,
        counts,
        topology_fingerprint_v3,
        elapsed_ns: started.elapsed().as_nanos().min(u64::MAX as u128) as u64,
    })
}

fn contiguous_slice_1<'a, T: numpy::Element>(
    array: &'a PyReadonlyArray1<'_, T>,
    name: &str,
) -> PyResult<&'a [T]> {
    array
        .as_slice()
        .map_err(|_| PyValueError::new_err(format!("{name} must be C-contiguous")))
}

fn contiguous_slice_2<'a, T: numpy::Element>(
    array: &'a PyReadonlyArray2<'_, T>,
    name: &str,
) -> PyResult<&'a [T]> {
    array
        .as_slice()
        .map_err(|_| PyValueError::new_err(format!("{name} must be C-contiguous")))
}

#[allow(clippy::too_many_arguments)]
fn parse_typed_mesh(
    node_ids: &PyReadonlyArray1<'_, i64>,
    node_coordinates: &PyReadonlyArray2<'_, f64>,
    cell_global_ordinals: &PyReadonlyArray1<'_, i64>,
    cell_topology_codes: &PyReadonlyArray1<'_, u8>,
    cell_region_ids: &PyReadonlyArray1<'_, i64>,
    cell_offsets: &PyReadonlyArray1<'_, i64>,
    cell_connectivity: &PyReadonlyArray1<'_, i64>,
    facet_global_ordinals: &PyReadonlyArray1<'_, i64>,
    facet_topology_codes: &PyReadonlyArray1<'_, u8>,
    facet_marker_ids: &PyReadonlyArray1<'_, i64>,
    facet_offsets: &PyReadonlyArray1<'_, i64>,
    facet_connectivity: &PyReadonlyArray1<'_, i64>,
    metadata: TypedMeshMetadata,
) -> PyResult<MeshIR> {
    let shape = node_coordinates.shape();
    let coordinate_shape = match shape {
        [rows, columns] => [*rows, *columns],
        _ => {
            return Err(PyValueError::new_err(
                "node_coordinates must have exactly two dimensions",
            ))
        }
    };
    let input = TypedMeshSlices {
        node_ids: contiguous_slice_1(node_ids, "node_ids")?,
        node_coordinates: contiguous_slice_2(node_coordinates, "node_coordinates")?,
        node_coordinate_shape: coordinate_shape,
        cell_global_ordinals: contiguous_slice_1(cell_global_ordinals, "cell_global_ordinals")?,
        cell_topology_codes: contiguous_slice_1(cell_topology_codes, "cell_topology_codes")?,
        cell_region_ids: contiguous_slice_1(cell_region_ids, "cell_region_ids")?,
        cell_offsets: contiguous_slice_1(cell_offsets, "cell_offsets")?,
        cell_connectivity: contiguous_slice_1(cell_connectivity, "cell_connectivity")?,
        facet_global_ordinals: contiguous_slice_1(facet_global_ordinals, "facet_global_ordinals")?,
        facet_topology_codes: contiguous_slice_1(facet_topology_codes, "facet_topology_codes")?,
        facet_marker_ids: contiguous_slice_1(facet_marker_ids, "facet_marker_ids")?,
        facet_offsets: contiguous_slice_1(facet_offsets, "facet_offsets")?,
        facet_connectivity: contiguous_slice_1(facet_connectivity, "facet_connectivity")?,
    };
    build_mesh(input, metadata).map_err(PyValueError::new_err)
}

fn detach_native_compute<T, F>(py: Python<'_>, operation: F) -> T
where
    T: pyo3::marker::Ungil,
    F: pyo3::marker::Ungil + FnOnce() -> T,
{
    py.detach(operation)
}

#[pyfunction]
#[pyo3(signature = (
    node_ids,
    node_coordinates,
    cell_global_ordinals,
    cell_topology_codes,
    cell_region_ids,
    cell_offsets,
    cell_connectivity,
    facet_global_ordinals,
    facet_topology_codes,
    facet_marker_ids,
    facet_offsets,
    facet_connectivity,
    metadata_json,
    certificate_json=None
))]
#[allow(clippy::too_many_arguments)]
pub(crate) fn certify_mixed_mesh_arrays(
    py: Python<'_>,
    node_ids: PyReadonlyArray1<'_, i64>,
    node_coordinates: PyReadonlyArray2<'_, f64>,
    cell_global_ordinals: PyReadonlyArray1<'_, i64>,
    cell_topology_codes: PyReadonlyArray1<'_, u8>,
    cell_region_ids: PyReadonlyArray1<'_, i64>,
    cell_offsets: PyReadonlyArray1<'_, i64>,
    cell_connectivity: PyReadonlyArray1<'_, i64>,
    facet_global_ordinals: PyReadonlyArray1<'_, i64>,
    facet_topology_codes: PyReadonlyArray1<'_, u8>,
    facet_marker_ids: PyReadonlyArray1<'_, i64>,
    facet_offsets: PyReadonlyArray1<'_, i64>,
    facet_connectivity: PyReadonlyArray1<'_, i64>,
    metadata_json: &str,
    certificate_json: Option<&str>,
) -> PyResult<String> {
    let metadata: TypedMeshMetadata = serde_json::from_str(metadata_json).map_err(|error| {
        PyValueError::new_err(format!("invalid mixed mesh metadata JSON: {error}"))
    })?;
    let mesh = parse_typed_mesh(
        &node_ids,
        &node_coordinates,
        &cell_global_ordinals,
        &cell_topology_codes,
        &cell_region_ids,
        &cell_offsets,
        &cell_connectivity,
        &facet_global_ordinals,
        &facet_topology_codes,
        &facet_marker_ids,
        &facet_offsets,
        &facet_connectivity,
        metadata,
    )?;
    let certificate_and_canonical_json = certificate_json
        .map(|payload| {
            prepare_certificate_json_with(payload, |candidate| {
                canonicalize_certificate_json_with_python(py, candidate)
            })
        })
        .transpose()?;
    let (certificate, canonical_certificate_json) = match certificate_and_canonical_json {
        Some((certificate, canonical_json)) => (Some(certificate), Some(canonical_json)),
        None => (None, None),
    };
    let result = detach_native_compute(py, move || {
        run_certificate(mesh, certificate, canonical_certificate_json)
    })
    .map_err(PyValueError::new_err)?;
    serde_json::to_string(&result).map_err(|error| PyValueError::new_err(error.to_string()))
}

#[pyfunction]
#[pyo3(signature = (
    node_ids,
    node_coordinates,
    cell_global_ordinals,
    cell_topology_codes,
    cell_region_ids,
    cell_offsets,
    cell_connectivity,
    facet_global_ordinals,
    facet_topology_codes,
    facet_marker_ids,
    facet_offsets,
    facet_connectivity,
    expected_json
))]
#[allow(clippy::too_many_arguments)]
pub(crate) fn preflight_mixed_mesh_arrays(
    py: Python<'_>,
    node_ids: PyReadonlyArray1<'_, i64>,
    node_coordinates: PyReadonlyArray2<'_, f64>,
    cell_global_ordinals: PyReadonlyArray1<'_, i64>,
    cell_topology_codes: PyReadonlyArray1<'_, u8>,
    cell_region_ids: PyReadonlyArray1<'_, i64>,
    cell_offsets: PyReadonlyArray1<'_, i64>,
    cell_connectivity: PyReadonlyArray1<'_, i64>,
    facet_global_ordinals: PyReadonlyArray1<'_, i64>,
    facet_topology_codes: PyReadonlyArray1<'_, u8>,
    facet_marker_ids: PyReadonlyArray1<'_, i64>,
    facet_offsets: PyReadonlyArray1<'_, i64>,
    facet_connectivity: PyReadonlyArray1<'_, i64>,
    expected_json: &str,
) -> PyResult<String> {
    let envelope: PreflightEnvelope = serde_json::from_str(expected_json).map_err(|error| {
        PyValueError::new_err(format!("invalid preflight expected JSON: {error}"))
    })?;
    let mesh = parse_typed_mesh(
        &node_ids,
        &node_coordinates,
        &cell_global_ordinals,
        &cell_topology_codes,
        &cell_region_ids,
        &cell_offsets,
        &cell_connectivity,
        &facet_global_ordinals,
        &facet_topology_codes,
        &facet_marker_ids,
        &facet_offsets,
        &facet_connectivity,
        envelope.metadata,
    )?;
    let result = detach_native_compute(py, move || run_preflight(mesh, envelope.expected))
        .map_err(PyValueError::new_err)?;
    serde_json::to_string(&result).map_err(|error| PyValueError::new_err(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};
    use std::thread;

    #[test]
    fn bridge_topology_codes_map_to_canonical_mesh_ir_types() {
        assert_eq!(decode_cell_topology_code(1).unwrap(), FemCellTypeIR::Tet4);
        assert_eq!(decode_cell_topology_code(2).unwrap(), FemCellTypeIR::Prism6);
        assert_eq!(
            decode_cell_topology_code(3).unwrap(),
            FemCellTypeIR::Pyramid5
        );
        assert_eq!(decode_cell_topology_code(4).unwrap(), FemCellTypeIR::Hex8);
        assert_eq!(
            decode_facet_topology_code(11).unwrap(),
            FemFacetTypeIR::Tri3
        );
        assert_eq!(
            decode_facet_topology_code(12).unwrap(),
            FemFacetTypeIR::Quad4
        );
        assert_eq!(
            decode_cell_topology_code(255).unwrap_err(),
            "unknown cell topology code 255"
        );
        assert_eq!(
            decode_facet_topology_code(255).unwrap_err(),
            "unknown facet topology code 255"
        );
    }

    #[test]
    fn csr_conversion_rejects_out_of_range_terminal_offset() {
        assert_eq!(
            validate_csr_offsets("cell", 1, &[0, 5], 4).unwrap_err(),
            "cell CSR terminal offset 5 does not match connectivity length 4"
        );
    }

    #[test]
    fn certificate_json_size_limit_counts_utf8_bytes() {
        let at_limit = "é".repeat(CERTIFICATE_JSON_MAX_BYTES / 2);
        assert_eq!(at_limit.chars().count(), CERTIFICATE_JSON_MAX_BYTES / 2);
        assert_eq!(at_limit.len(), CERTIFICATE_JSON_MAX_BYTES);
        assert_eq!(enforce_certificate_json_size(&at_limit), Ok(()));
        assert_eq!(
            enforce_certificate_json_size(&(at_limit + "a")),
            Err("mixed certificate JSON exceeds 1048576-byte limit".to_string())
        );
    }

    #[test]
    fn oversized_certificate_is_rejected_before_python_parse() {
        Python::initialize();
        Python::attach(|_py| {
            let parser_calls = Cell::new(0);
            let payload = " ".repeat(CERTIFICATE_JSON_MAX_BYTES + 1);

            let error = prepare_certificate_json_with(&payload, |_| {
                parser_calls.set(parser_calls.get() + 1);
                unreachable!("oversized certificate must be rejected before Python parse")
            })
            .unwrap_err();

            assert_eq!(
                error.to_string(),
                "ValueError: mixed certificate JSON exceeds 1048576-byte limit"
            );
            assert_eq!(parser_calls.get(), 0);
        });
    }

    #[test]
    fn dense_node_ids_use_identity_lookup_without_a_map() {
        let lookup = build_node_id_lookup(&[0, 1, 2, 3]).unwrap();

        assert!(matches!(&lookup, NodeIdLookup::Dense { node_count: 4 }));
        assert_eq!(
            copy_connectivity("cell", &[3, 0, 2, 1], &lookup).unwrap(),
            vec![3, 0, 2, 1]
        );
    }

    #[test]
    fn arbitrary_node_ids_use_fallback_lookup_and_reject_unknown_ids() {
        let lookup = build_node_id_lookup(&[10, 30, 20, 40]).unwrap();

        assert!(matches!(&lookup, NodeIdLookup::Sparse(_)));
        assert_eq!(
            copy_connectivity("cell", &[40, 10, 20, 30], &lookup).unwrap(),
            vec![3, 0, 2, 1]
        );
        assert_eq!(
            copy_connectivity("cell", &[99], &lookup).unwrap_err(),
            "cell connectivity references unknown node id 99"
        );
    }

    #[test]
    fn production_preflight_does_not_call_certificate_engine() {
        let mesh = MeshIR {
            mesh_name: "preflight-probe".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            cells: FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
            element_markers: vec![1],
            facets: FemFacetConnectivityIR::empty(),
            boundary_markers: Vec::new(),
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: HashMap::new(),
        };
        let expected = PreflightExpected {
            counts: NativeMeshCounts {
                nodes: 4,
                cells: 1,
                facets: 0,
            },
            topology_fingerprint_v3: mesh.mixed_topology_fingerprint_v3().unwrap(),
        };
        reset_certificate_engine_probe();

        let result = run_preflight(mesh, expected).unwrap();

        assert_eq!(result.counts.cells, 1);
        assert_eq!(certificate_engine_probe_calls(), 0);
    }

    #[test]
    fn production_preflight_rejects_invalid_mesh_structure() {
        let mut mesh = MeshIR {
            mesh_name: "invalid-preflight".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            cells: FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
            element_markers: vec![1],
            facets: FemFacetConnectivityIR::empty(),
            boundary_markers: Vec::new(),
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: HashMap::new(),
        };
        mesh.element_markers.clear();
        let expected = PreflightExpected {
            counts: NativeMeshCounts {
                nodes: 4,
                cells: 1,
                facets: 0,
            },
            topology_fingerprint_v3: mesh.mixed_topology_fingerprint_v3().unwrap(),
        };

        let error = run_preflight(mesh, expected).unwrap_err();

        assert!(error.contains("mesh.element_markers length must match mesh.cells length"));
    }

    #[test]
    fn production_detach_seam_releases_gil_for_one_controlled_compute() {
        Python::initialize();
        let active = Arc::new(AtomicBool::new(false));
        let observed_active = Arc::new(AtomicBool::new(false));
        let progress = Arc::new(AtomicUsize::new(0));
        let ready = Arc::new(Barrier::new(2));
        let worker_active = Arc::clone(&active);
        let worker_observed_active = Arc::clone(&observed_active);
        let worker_progress = Arc::clone(&progress);
        let worker_ready = Arc::clone(&ready);
        let worker = thread::spawn(move || {
            worker_ready.wait();
            while !worker_active.load(Ordering::Acquire) {
                thread::yield_now();
            }
            worker_observed_active.store(true, Ordering::Release);
            Python::attach(|_| {
                // A non-detached caller releases the GIL only after clearing
                // `active`; re-checking here makes that mutation observable.
                while worker_active.load(Ordering::Acquire) {
                    worker_progress.fetch_add(1, Ordering::Relaxed);
                }
            });
        });

        ready.wait();
        Python::attach(|py| {
            detach_native_compute(py, || {
                active.store(true, Ordering::Release);
                while !observed_active.load(Ordering::Acquire) {
                    thread::yield_now();
                }
                let mut digest = [0_u8; 32];
                for ordinal in 0_u64..200_000 {
                    let mut hasher = Sha256::new();
                    hasher.update(digest);
                    hasher.update(ordinal.to_le_bytes());
                    digest.copy_from_slice(&hasher.finalize());
                }
                active.store(false, Ordering::Release);
                digest
            });
        });
        worker.join().unwrap();

        assert!(progress.load(Ordering::Relaxed) > 0);
    }
}
