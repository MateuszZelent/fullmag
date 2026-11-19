//! Signed closed-loop field publication. Raw inspection is not scientific qualification.
use super::closed_loop_field_evidence::{ClosedLoopFieldEvidence, ClosedLoopFieldSnapshot};
use super::{AntennaFieldSolutionSignatures, AntennaSampleCarrier};
use crate::types::{AuxiliaryArtifact, RunError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) const SCHEMA: &str = "antenna_field_solution.v2";
const MAX_CELLS: usize = 1_048_576;
const MAX_VERTICES: usize = 4 * MAX_CELLS;
const CERTIFICATE_LIMIT: usize = 128 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ClosedLoopSourceMetadataV2 {
    pub prepared_execution_digest: String,
    pub accepted_charge_field_digest: String,
    pub accepted_source_state_digest: String,
    pub view_identity_digest: String,
    pub current_balance_certificate_digest: String,
    pub digest_encoding: String,
    pub periodic_operator_version: String,
    pub closure_operator_version: String,
    pub conservative_current_operator_version: String,
    pub weak_reaction_ledger_version: String,
    pub sampling_policy: String,
    pub source_current_orientation: String,
    pub source_current_a: f64,
    pub source_absolute_flux_a: f64,
    pub potential_jump_v: f64,
    pub measured_potential_jump_v: f64,
    pub gauge_mean_v: f64,
    pub charge_relative_residual: f64,
    pub max_paired_weak_flux_mismatch_a: f64,
    pub terminal_observation_currents: BTreeMap<String, f64>,
}

#[derive(Debug, Clone)]
pub(crate) struct ClosedLoopCurrentCellV2 {
    pub source_element_index: u64,
    pub vertex_ids: [u64; 4],
    pub vertex_xyz_m: [f64; 12],
    pub vertex_current_xyz_apm2: [f64; 12],
    pub center_xyz_m: [f64; 3],
    pub center_current_xyz_apm2: [f64; 3],
}
#[derive(Debug, Clone)]
pub(crate) struct ClosedLoopWeakReactionV2 {
    pub minus_vertex_id: u64,
    pub plus_vertex_id: u64,
    pub minus_reaction_a: f64,
    pub plus_reaction_a: f64,
}
#[derive(Debug, Clone)]
pub(crate) struct ClosedLoopAcceptedSourceInputV2 {
    pub metadata: ClosedLoopSourceMetadataV2,
    pub stable_vertex_ids: Vec<u64>,
    pub vertex_xyz_m: Vec<[f64; 3]>,
    pub electric_potential_v: Vec<f64>,
    pub conductivity_spm: Vec<f64>,
    pub cells: Vec<ClosedLoopCurrentCellV2>,
    pub canonical_face_records: Vec<([u64; 3], f64)>,
    pub paired_weak_reactions: Vec<ClosedLoopWeakReactionV2>,
    pub prepared_execution_preimage: Vec<u8>,
    pub accepted_charge_field_preimage: Vec<u8>,
    pub accepted_source_state_preimage: Vec<u8>,
    pub canonical_balance_certificate: Vec<u8>,
    /// Exact serialized already-hashed authored input body from the admitted planner.
    pub authored_input_json: Vec<u8>,
}
#[derive(Debug, Clone)]
pub(crate) struct ClosedLoopFieldSolutionInputV2 {
    pub asset_id: String,
    pub solution_id: String,
    pub source_object_id: String,
    pub current_transport_id: String,
    pub stage_id: String,
    pub port_mode_id: String,
    /// Exact prepared labels: source_revision, object_id, geometry_id, source_module_id,
    /// mesh_digest, authored_input_digest, materials_digest; preserve requested_execution.
    /// These values come from the admitted execution owner, not authored accepted pins.
    pub requested_intent: Value,
    /// Exact prepared mesh/topology/envelope revisions and envelope_digest; stage_identity,
    /// evaluation_time_s, evaluated_envelope_multiplier, execution_lane=1, charge_gauge=2,
    /// maximum_iterations, stable_vertex_id_version and the preregistered charge/RT0 gates.
    /// The neutral identity verifier matches these scalars and labels against retained bytes.
    pub resolved_execution: Value,
    pub full_closure: Value,
    pub signatures: AntennaFieldSolutionSignatures,
    pub source: ClosedLoopAcceptedSourceInputV2,
    pub sample_carrier: AntennaSampleCarrier,
    pub sample_positions_xyz_m: Vec<[f64; 3]>,
    pub sample_cells: Vec<[u32; 4]>,
    pub field_snapshot: ClosedLoopFieldSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PayloadRefV2 {
    path: String,
    sha256: String,
    byte_length: usize,
    layout: String,
    unit: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestV2 {
    schema_version: String,
    status: String,
    content_digest: String,
    asset_id: String,
    solution_id: String,
    source_object_id: String,
    current_transport_id: String,
    stage_id: String,
    port_mode_id: String,
    requested_intent: Value,
    resolved_execution: Value,
    full_closure: Value,
    signatures: AntennaFieldSolutionSignatures,
    source: ClosedLoopSourceMetadataV2,
    sample_carrier: AntennaSampleCarrier,
    vertex_count: usize,
    cell_count: usize,
    face_count: usize,
    weak_reaction_count: usize,
    target_count: usize,
    sample_cell_count: usize,
    signed_normalization_a: f64,
    scale_per_a: f64,
    direct_evidence_schema: String,
    payloads: BTreeMap<String, PayloadRefV2>,
}
pub(crate) fn invalid(reason: &str) -> RunError {
    RunError {
        message: format!("closed-loop field v2: {reason}"),
    }
}
pub(crate) fn is_digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub(crate) fn normalization_scale(current: f64, absolute_flux: f64) -> Result<f64, RunError> {
    let gate = 100.0 * (1.0e-18 + 1.0e-10 * absolute_flux);
    let scale = 1.0 / current;
    if !current.is_finite()
        || !absolute_flux.is_finite()
        || absolute_flux < 0.0
        || !gate.is_finite()
        || current.abs() <= gate
        || !scale.is_finite()
    {
        return Err(invalid("normalization_not_resolvable"));
    }
    Ok(scale)
}
/// No scientific receipt schema has been approved for this source family.
pub(crate) fn require_qualified(_manifest: &[u8]) -> Result<(), RunError> {
    Err(invalid(
        "source_not_qualified: closed-loop v2 scientific receipt is not available",
    ))
}
/// One framed identity shared by the live writer and cold reader.
pub(crate) fn field_signature(
    source_digest: &str,
    carrier: &AntennaSampleCarrier,
    positions: &[[f64; 3]],
    cells: &[[u32; 4]],
    evidence: &ClosedLoopFieldEvidence,
) -> Result<String, RunError> {
    if !is_digest(source_digest) || positions.is_empty() || positions.len() > 1_000_000 {
        return Err(invalid("field signature source digest or target bound"));
    }
    validate_sampling_mesh(carrier, positions, cells)?;
    let mut source = [0u8; 32];
    let nibble = |b: u8| if b <= b'9' { b - b'0' } else { b - b'a' + 10 };
    for (i, pair) in source_digest.as_bytes().chunks_exact(2).enumerate() {
        source[i] = (nibble(pair[0]) << 4) | nibble(pair[1]);
    }
    let carrier_bytes =
        serde_json::to_vec(carrier).map_err(|_| invalid("field signature carrier encoding"))?;
    let evidence_bytes = evidence.encode()?;
    let mut hash = Sha256::new();
    hash.update(b"antenna_closed_loop_native_field.v2");
    for bytes in [source.as_slice(), carrier_bytes.as_slice()] {
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    let position_bytes = positions
        .len()
        .checked_mul(24)
        .ok_or_else(|| invalid("field signature position length"))?;
    hash.update((position_bytes as u64).to_le_bytes());
    for position in positions {
        for value in position {
            if !value.is_finite() {
                return Err(invalid("field signature nonfinite target"));
            }
            hash.update(value.to_le_bytes());
        }
    }
    hash.update(((cells.len() * 16) as u64).to_le_bytes());
    for index in cells.iter().flatten() {
        hash.update(index.to_le_bytes());
    }
    hash.update((evidence_bytes.len() as u64).to_le_bytes());
    hash.update(&evidence_bytes);
    Ok(format!("sha256:{:x}", hash.finalize()))
}
fn validate_sampling_mesh(
    carrier: &AntennaSampleCarrier,
    positions: &[[f64; 3]],
    cells: &[[u32; 4]],
) -> Result<(), RunError> {
    super::validate_sample_carrier(Some(carrier))?;
    if carrier.location != "node"
        || !(carrier.carrier_kind == "fem_domain_mesh_asset"
            || carrier.carrier_kind.strip_prefix("fem_mesh_asset:").is_some_and(|id| !id.is_empty()))
        || positions.is_empty() || positions.len() > 1_000_000
        || positions.iter().flatten().any(|v| !v.is_finite())
        || cells.is_empty() || cells.len() > MAX_CELLS
    {
        return Err(invalid("sampling carrier requires bounded nonempty FEM Tet4 mesh"));
    }
    for cell in cells {
        if cell.iter().any(|i| *i as usize >= positions.len()) {
            return Err(invalid("sampling Tet4 index out of bounds"));
        }
        let a = positions[cell[0] as usize];
        let edges = [cell[1], cell[2], cell[3]].map(|i| {
            std::array::from_fn::<_, 3, _>(|j| positions[i as usize][j] - a[j])
        });
        let scale = edges.iter().flatten().fold(0.0_f64, |s, v| s.max(v.abs()));
        if !scale.is_finite() || scale == 0.0 {
            return Err(invalid("sampling Tet4 invalid extent"));
        }
        let [b, c, d] = edges.map(|e| e.map(|v| v / scale));
        let determinant = b[0] * (c[1]*d[2] - c[2]*d[1])
            - b[1] * (c[0]*d[2] - c[2]*d[0])
            + b[2] * (c[0]*d[1] - c[1]*d[0]);
        if !determinant.is_finite() || determinant <= 0.0 {
            return Err(invalid("sampling Tet4 nonpositive oriented volume"));
        }
    }
    Ok(())
}
fn sampling_cells(bytes: &[u8]) -> Result<Vec<[u32; 4]>, RunError> {
    if bytes.is_empty() || bytes.len() % 16 != 0 || bytes.len() / 16 > MAX_CELLS {
        return Err(invalid("sampling Tet4 payload length"));
    }
    Ok(bytes.chunks_exact(16).map(|cell| {
        std::array::from_fn(|i| u32::from_le_bytes(cell[i*4..i*4+4].try_into().unwrap()))
    }).collect())
}
fn identifier(s: &str) -> Result<(), RunError> {
    if s.is_empty() || s.len() > 255 || s.contains('\0') {
        return Err(invalid("empty or unbounded identifier"));
    }
    Ok(())
}
fn path_identifier(s: &str) -> Result<(), RunError> {
    identifier(s)?;
    if s.contains("..")
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
    {
        return Err(invalid("unsafe artifact identifier"));
    }
    Ok(())
}
fn floats(values: impl IntoIterator<Item = f64>, scale: f64) -> Result<Vec<u8>, RunError> {
    let values = values.into_iter();
    let (minimum, _) = values.size_hint();
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(
            minimum
                .checked_mul(8)
                .ok_or_else(|| invalid("float size overflow"))?,
        )
        .map_err(|_| invalid("float allocation"))?;
    for value in values {
        let scaled = value * scale;
        if !value.is_finite() || !scaled.is_finite() {
            return Err(invalid("nonfinite or normalization overflow"));
        }
        bytes.extend_from_slice(&scaled.to_le_bytes());
    }
    Ok(bytes)
}
fn metadata_valid(m: &ManifestV2) -> Result<(), RunError> {
    for s in [
        &m.asset_id,
        &m.solution_id,
        &m.source_object_id,
        &m.current_transport_id,
        &m.stage_id,
        &m.port_mode_id,
    ] {
        identifier(s)?;
    }
    path_identifier(&m.solution_id)?;
    if m.schema_version != SCHEMA
        || m.status != "inspection_only"
        || !matches!(m.direct_evidence_schema.as_str(), super::direct_quadrature_v2::SCHEMA | super::surface_rt0_evidence_v1::SCHEMA)
        || !super::signatures_are_valid(&m.signatures)
        || m.signatures.current_solution_signature
            != format!("sha256:{}", m.source.accepted_source_state_digest)
        || !m.signatures.target_projection_signatures.is_empty()
        || m.signatures.dependency_signatures.is_some()
        || m.vertex_count == 0
        || m.vertex_count > MAX_VERTICES
        || m.cell_count == 0
        || m.cell_count > MAX_CELLS
        || m.face_count == 0
        || m.face_count > 4 * m.cell_count
        || m.weak_reaction_count == 0
        || m.weak_reaction_count > m.vertex_count
        || m.target_count == 0
        || m.target_count > 1_000_000
        || m.sample_cell_count == 0
        || m.sample_cell_count > MAX_CELLS
        || [&m.requested_intent, &m.resolved_execution, &m.full_closure]
            .iter()
            .any(|v| !v.is_object() || v.as_object().unwrap().is_empty())
        || m.signed_normalization_a.to_bits() != m.source.source_current_a.to_bits()
        || m.scale_per_a.to_bits()
            != normalization_scale(m.source.source_current_a, m.source.source_absolute_flux_a)?
                .to_bits()
    {
        return Err(invalid("manifest metadata, status, scope, counts or scale"));
    }
    super::validate_sample_carrier(Some(&m.sample_carrier))?;
    Ok(())
}
fn source_valid(s: &ClosedLoopAcceptedSourceInputV2) -> Result<(), RunError> {
    let n = s.stable_vertex_ids.len();
    let c = s.cells.len();
    if n == 0
        || n > MAX_VERTICES
        || c == 0
        || c > MAX_CELLS
        || s.vertex_xyz_m.len() != n
        || s.electric_potential_v.len() != n
        || s.conductivity_spm.len() != c
        || s.conductivity_spm
            .iter()
            .any(|v| !v.is_finite() || *v <= 0.0)
        || s.canonical_face_records.is_empty()
        || s.canonical_face_records.len() > 4 * c
        || s.paired_weak_reactions.is_empty()
        || s.paired_weak_reactions.len() > n
        || s.authored_input_json.is_empty()
        || s.authored_input_json.len() > 512 * 1024 * 1024
        || s.canonical_balance_certificate.is_empty()
        || s.canonical_balance_certificate.len() > CERTIFICATE_LIMIT
    {
        return Err(invalid("source counts or certificate bound"));
    }
    let vertices = s
        .stable_vertex_ids
        .iter()
        .copied()
        .zip(&s.vertex_xyz_m)
        .collect::<BTreeMap<_, _>>();
    if vertices.len() != n {
        return Err(invalid("duplicate stable IDs"));
    }
    for (i, cell) in s.cells.iter().enumerate() {
        if cell.source_element_index != i as u64
            || cell.vertex_ids.iter().collect::<BTreeSet<_>>().len() != 4
        {
            return Err(invalid("cell ordinal or connectivity"));
        }
        for k in 0..4 {
            let xyz = vertices
                .get(&cell.vertex_ids[k])
                .ok_or_else(|| invalid("foreign cell ID"))?;
            for a in 0..3 {
                if xyz[a].to_bits() != cell.vertex_xyz_m[3 * k + a].to_bits() {
                    return Err(invalid("cell xyz binding"));
                }
            }
        }
    }
    for d in [
        &s.metadata.prepared_execution_digest,
        &s.metadata.accepted_charge_field_digest,
        &s.metadata.accepted_source_state_digest,
        &s.metadata.view_identity_digest,
        &s.metadata.current_balance_certificate_digest,
    ] {
        if !is_digest(d) {
            return Err(invalid("source digest"));
        }
    }
    if super::sha256(&s.canonical_balance_certificate)
        != s.metadata.current_balance_certificate_digest
    {
        return Err(invalid("certificate digest"));
    }
    Ok(())
}
fn insert_payload(
    m: &mut ManifestV2,
    artifacts: &mut Vec<AuxiliaryArtifact>,
    name: &str,
    bytes: Vec<u8>,
    layout: &str,
    unit: &str,
) {
    let path = format!("antenna/field_solutions/{}/{}.bin", m.solution_id, name);
    m.payloads.insert(
        name.into(),
        PayloadRefV2 {
            path: path.clone(),
            sha256: super::sha256(&bytes),
            byte_length: bytes.len(),
            layout: layout.into(),
            unit: unit.into(),
        },
    );
    artifacts.push(AuxiliaryArtifact {
        relative_path: path,
        bytes,
    });
}
fn copy_bytes(bytes: &[u8]) -> Result<Vec<u8>, RunError> {
    let mut out = Vec::new();
    out.try_reserve_exact(bytes.len())
        .map_err(|_| invalid("retained evidence allocation"))?;
    out.extend_from_slice(bytes);
    Ok(out)
}
fn records(s: &ClosedLoopAcceptedSourceInputV2) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>), RunError> {
    let mut cells = Vec::new();
    let mut faces = Vec::new();
    let mut weak = Vec::new();
    cells
        .try_reserve_exact(
            s.cells
                .len()
                .checked_mul(280)
                .ok_or_else(|| invalid("cell bytes overflow"))?,
        )
        .map_err(|_| invalid("cell allocation"))?;
    faces
        .try_reserve_exact(
            s.canonical_face_records
                .len()
                .checked_mul(32)
                .ok_or_else(|| invalid("face bytes overflow"))?,
        )
        .map_err(|_| invalid("face allocation"))?;
    weak.try_reserve_exact(
        s.paired_weak_reactions
            .len()
            .checked_mul(32)
            .ok_or_else(|| invalid("weak bytes overflow"))?,
    )
    .map_err(|_| invalid("weak allocation"))?;
    for c in &s.cells {
        cells.extend_from_slice(&c.source_element_index.to_le_bytes());
        for id in c.vertex_ids {
            cells.extend_from_slice(&id.to_le_bytes());
        }
        cells.extend(floats(
            c.vertex_xyz_m
                .into_iter()
                .chain(c.vertex_current_xyz_apm2)
                .chain(c.center_xyz_m)
                .chain(c.center_current_xyz_apm2),
            1.0,
        )?);
    }
    for (ids, flux) in &s.canonical_face_records {
        for id in ids {
            faces.extend_from_slice(&id.to_le_bytes());
        }
        faces.extend(floats([*flux], 1.0)?);
    }
    for w in &s.paired_weak_reactions {
        weak.extend_from_slice(&w.minus_vertex_id.to_le_bytes());
        weak.extend_from_slice(&w.plus_vertex_id.to_le_bytes());
        weak.extend(floats([w.minus_reaction_a, w.plus_reaction_a], 1.0)?);
    }
    Ok((cells, faces, weak))
}
pub(crate) fn build(
    input: &ClosedLoopFieldSolutionInputV2,
) -> Result<Vec<AuxiliaryArtifact>, RunError> {
    source_valid(&input.source)?;
    super::closed_loop_identity_v2::verify(
        &input.source,
        &input.requested_intent,
        &input.resolved_execution,
        &input.full_closure,
        &input.source_object_id,
        &input.current_transport_id,
        &input.stage_id,
        &input.port_mode_id,
        &input.solution_id,
    )?;
    let s = &input.source;
    let scale = normalization_scale(
        s.metadata.source_current_a,
        s.metadata.source_absolute_flux_a,
    )?;
    let evidence = ClosedLoopFieldEvidence::new(input.field_snapshot.clone(), &s.metadata)?;
    evidence.verify_policy_binding(&input.requested_intent, &input.resolved_execution)?;
    if input.signatures.field_solution_signature
        != field_signature(
            &s.metadata.accepted_source_state_digest,
            &input.sample_carrier,
            &input.sample_positions_xyz_m,
            &input.sample_cells,
            &evidence,
        )?
    {
        return Err(invalid(
            "field signature differs from retained source, carrier or evidence",
        ));
    }
    let mut m = ManifestV2 {
        schema_version: SCHEMA.into(),
        status: "inspection_only".into(),
        content_digest: String::new(),
        asset_id: input.asset_id.clone(),
        solution_id: input.solution_id.clone(),
        source_object_id: input.source_object_id.clone(),
        current_transport_id: input.current_transport_id.clone(),
        stage_id: input.stage_id.clone(),
        port_mode_id: input.port_mode_id.clone(),
        requested_intent: input.requested_intent.clone(),
        resolved_execution: input.resolved_execution.clone(),
        full_closure: input.full_closure.clone(),
        signatures: input.signatures.clone(),
        source: s.metadata.clone(),
        sample_carrier: input.sample_carrier.clone(),
        vertex_count: s.stable_vertex_ids.len(),
        cell_count: s.cells.len(),
        face_count: s.canonical_face_records.len(),
        weak_reaction_count: s.paired_weak_reactions.len(),
        target_count: input.sample_positions_xyz_m.len(),
        sample_cell_count: input.sample_cells.len(),
        signed_normalization_a: s.metadata.source_current_a,
        scale_per_a: scale,
        direct_evidence_schema: evidence.schema().into(),
        payloads: BTreeMap::new(),
    };
    metadata_valid(&m)?;
    let mut artifacts = Vec::new();
    let ids = s
        .stable_vertex_ids
        .iter()
        .flat_map(|id| id.to_le_bytes())
        .collect();
    insert_payload(
        &mut m,
        &mut artifacts,
        "stable_vertex_ids",
        ids,
        "node_u64_le",
        "1",
    );
    insert_payload(&mut m, &mut artifacts, "sample_cells",
        input.sample_cells.iter().flatten().flat_map(|i| i.to_le_bytes()).collect(),
        "sample_tet4_u32_le", "1");
    for (name, values, layout, unit) in [
        (
            "vertex_xyz",
            s.vertex_xyz_m.iter().flatten().copied().collect::<Vec<_>>(),
            "node_xyz_f64_le",
            "m",
        ),
        (
            "sample_xyz",
            input
                .sample_positions_xyz_m
                .iter()
                .flatten()
                .copied()
                .collect(),
            "sample_xyz_f64_le",
            "m",
        ),
        (
            "conductivity",
            s.conductivity_spm.clone(),
            "cell_f64_le",
            "S/m",
        ),
    ] {
        insert_payload(
            &mut m,
            &mut artifacts,
            name,
            floats(values, 1.0)?,
            layout,
            unit,
        );
    }
    let raw_h = evidence.raw_h();
    let per_h = raw_h
        .iter()
        .map(|h| h.map(|v| v * scale))
        .collect::<Vec<_>>();
    evidence.verify_source_binding(&s.metadata, s.cells.len(), input.sample_positions_xyz_m.len())?;
    evidence.verify_binding(&input.sample_positions_xyz_m, &raw_h, &per_h)?;
    for (name, values, layout, raw_unit, per_unit) in [
        (
            "v",
            s.electric_potential_v.clone(),
            "node_f64_le",
            "V",
            "V/A",
        ),
        (
            "j_center",
            s.cells
                .iter()
                .flat_map(|c| c.center_current_xyz_apm2)
                .collect(),
            "cell_xyz_f64_le",
            "A/m^2",
            "1/m^2",
        ),
        (
            "j_local",
            s.cells
                .iter()
                .flat_map(|c| c.vertex_current_xyz_apm2)
                .collect(),
            "cell_local4_xyz_f64_le",
            "A/m^2",
            "1/m^2",
        ),
        (
            "h",
            raw_h.iter().flatten().copied().collect(),
            "sample_xyz_f64_le",
            "A/m",
            "1/m",
        ),
    ] {
        insert_payload(
            &mut m,
            &mut artifacts,
            &format!("{name}_raw"),
            floats(values.iter().copied(), 1.0)?,
            layout,
            raw_unit,
        );
        insert_payload(
            &mut m,
            &mut artifacts,
            &format!("{name}_per_a"),
            floats(values, scale)?,
            layout,
            per_unit,
        );
    }
    let (cells, faces, weak) = records(s)?;
    for (name, bytes, layout, unit) in [
        ("cells", cells, "closed_loop_cell280_le", "SI"),
        ("faces", faces, "face_u64x3_f64_le", "A"),
        ("weak", weak, "paired_u64x2_f64x2_le", "A"),
        (
            "prepared_preimage",
            copy_bytes(&s.prepared_execution_preimage)?,
            "canonical_named_fields_be_bits.v2",
            "1",
        ),
        (
            "charge_preimage",
            copy_bytes(&s.accepted_charge_field_preimage)?,
            "canonical_named_fields_be_bits.v2",
            "1",
        ),
        (
            "source_preimage",
            copy_bytes(&s.accepted_source_state_preimage)?,
            "canonical_named_fields_be_bits.v2",
            "1",
        ),
        (
            "authoring_receipt",
            copy_bytes(&s.authored_input_json)?,
            "utf8_json_input.v1",
            "1",
        ),
        (
            "certificate",
            copy_bytes(&s.canonical_balance_certificate)?,
            "canonical_balance_certificate.v1",
            "1",
        ),
        (
            "direct_evidence",
            evidence.encode()?,
            evidence.schema(),
            "SI",
        ),
    ] {
        insert_payload(&mut m, &mut artifacts, name, bytes, layout, unit);
    }
    let mut value = serde_json::to_value(&m).map_err(|_| invalid("manifest serialization"))?;
    value.as_object_mut().unwrap().remove("content_digest");
    let bytes = serde_json::to_vec(&value).map_err(|_| invalid("manifest digest serialization"))?;
    value["content_digest"] = Value::String(format!("sha256:{}", super::sha256(&bytes)));
    let bytes = serde_json::to_vec(&value).map_err(|_| invalid("manifest serialization"))?;
    if bytes.len() > super::ANTENNA_FIELD_MANIFEST_MAX_BYTES {
        return Err(invalid("manifest size bound"));
    }
    verify(&bytes, &artifacts, true)?;
    artifacts.push(AuxiliaryArtifact {
        relative_path: format!(
            "antenna/field_solutions/{}/manifest.v2.json",
            input.solution_id
        ),
        bytes,
    });
    Ok(artifacts)
}

pub(crate) fn is_v2(bytes: &[u8]) -> bool {
    if bytes.len() > super::ANTENNA_FIELD_MANIFEST_MAX_BYTES {
        return false;
    }
    serde_json::from_slice::<crate::artifact_json::UnambiguousJson>(bytes)
        .ok()
        .and_then(|v| {
            v.0.get("schema_version")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .is_some_and(|s| s == SCHEMA)
}
fn parse(bytes: &[u8]) -> Result<ManifestV2, RunError> {
    if bytes.len() > super::ANTENNA_FIELD_MANIFEST_MAX_BYTES {
        return Err(invalid("manifest bound"));
    }
    let crate::artifact_json::UnambiguousJson(mut value) =
        serde_json::from_slice(bytes).map_err(|_| invalid("ambiguous manifest JSON"))?;
    let digest = value
        .as_object_mut()
        .and_then(|v| v.remove("content_digest"))
        .and_then(|v| v.as_str().map(str::to_owned))
        .ok_or_else(|| invalid("manifest digest missing"))?;
    if digest
        != format!(
            "sha256:{}",
            super::sha256(&serde_json::to_vec(&value).map_err(|_| invalid("manifest encoding"))?)
        )
    {
        return Err(invalid("manifest digest mismatch"));
    }
    value["content_digest"] = Value::String(digest);
    let m: ManifestV2 =
        serde_json::from_value(value).map_err(|_| invalid("manifest shape or unknown fields"))?;
    metadata_valid(&m)?;
    Ok(m)
}
fn expected(m: &ManifestV2) -> Vec<(&'static str, usize, &'static str, &'static str)> {
    vec![
        ("stable_vertex_ids", m.vertex_count * 8, "node_u64_le", "1"),
        ("vertex_xyz", m.vertex_count * 24, "node_xyz_f64_le", "m"),
        ("sample_xyz", m.target_count * 24, "sample_xyz_f64_le", "m"),
        ("sample_cells", m.sample_cell_count * 16, "sample_tet4_u32_le", "1"),
        ("conductivity", m.cell_count * 8, "cell_f64_le", "S/m"),
        ("v_raw", m.vertex_count * 8, "node_f64_le", "V"),
        ("v_per_a", m.vertex_count * 8, "node_f64_le", "V/A"),
        (
            "j_center_raw",
            m.cell_count * 24,
            "cell_xyz_f64_le",
            "A/m^2",
        ),
        (
            "j_center_per_a",
            m.cell_count * 24,
            "cell_xyz_f64_le",
            "1/m^2",
        ),
        (
            "j_local_raw",
            m.cell_count * 96,
            "cell_local4_xyz_f64_le",
            "A/m^2",
        ),
        (
            "j_local_per_a",
            m.cell_count * 96,
            "cell_local4_xyz_f64_le",
            "1/m^2",
        ),
        ("h_raw", m.target_count * 24, "sample_xyz_f64_le", "A/m"),
        ("h_per_a", m.target_count * 24, "sample_xyz_f64_le", "1/m"),
        ("cells", m.cell_count * 280, "closed_loop_cell280_le", "SI"),
        ("faces", m.face_count * 32, "face_u64x3_f64_le", "A"),
        (
            "weak",
            m.weak_reaction_count * 32,
            "paired_u64x2_f64x2_le",
            "A",
        ),
        (
            "prepared_preimage",
            0,
            "canonical_named_fields_be_bits.v2",
            "1",
        ),
        (
            "charge_preimage",
            0,
            "canonical_named_fields_be_bits.v2",
            "1",
        ),
        (
            "source_preimage",
            0,
            "canonical_named_fields_be_bits.v2",
            "1",
        ),
        ("certificate", 0, "canonical_balance_certificate.v1", "1"),
        ("authoring_receipt", 0, "utf8_json_input.v1", "1"),
        (
            "direct_evidence",
            if m.direct_evidence_schema == super::direct_quadrature_v2::SCHEMA { 296 + m.target_count * 96 } else { 0 },
            if m.direct_evidence_schema == super::direct_quadrature_v2::SCHEMA { super::direct_quadrature_v2::SCHEMA } else { super::surface_rt0_evidence_v1::SCHEMA },
            "SI",
        ),
    ]
}
pub(crate) fn payload_lengths(bytes: &[u8]) -> Result<BTreeMap<String, usize>, RunError> {
    let m = parse(bytes)?;
    let mut result = BTreeMap::new();
    let fields = expected(&m);
    if fields.len() != m.payloads.len() {
        return Err(invalid("payload closure incomplete"));
    }
    for (name, length, layout, unit) in fields {
        let p = m
            .payloads
            .get(name)
            .ok_or_else(|| invalid("required payload missing"))?;
        if p.path != format!("antenna/field_solutions/{}/{}.bin", m.solution_id, name)
            || !is_digest(&p.sha256)
            || p.byte_length == 0
            || p.byte_length > 512 * 1024 * 1024
            || (length != 0 && length != p.byte_length)
            || p.layout != layout
            || p.unit != unit
            || (name == "certificate" && p.byte_length > CERTIFICATE_LIMIT)
            || result.insert(p.path.clone(), p.byte_length).is_some()
        {
            return Err(invalid("payload path, format, length or read bound"));
        }
    }
    Ok(result)
}
fn u64_at(b: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(b[offset..offset + 8].try_into().unwrap())
}
fn f64_at(b: &[u8], offset: usize) -> f64 {
    f64::from_bits(u64_at(b, offset))
}
fn reals(b: &[u8]) -> Result<Vec<f64>, RunError> {
    let mut result = Vec::new();
    result
        .try_reserve_exact(b.len() / 8)
        .map_err(|_| invalid("decode allocation"))?;
    for p in b.chunks_exact(8) {
        let v = f64::from_le_bytes(p.try_into().unwrap());
        if !v.is_finite() {
            return Err(invalid("nonfinite binary payload"));
        }
        result.push(v);
    }
    Ok(result)
}
fn xyz(b: &[u8]) -> Result<Vec<[f64; 3]>, RunError> {
    Ok(reals(b)?
        .chunks_exact(3)
        .map(|p| [p[0], p[1], p[2]])
        .collect())
}
fn equal(raw: impl IntoIterator<Item = f64>, bytes: &[u8], scale: f64) -> Result<(), RunError> {
    let values = reals(bytes)?;
    let raw = raw.into_iter().collect::<Vec<_>>();
    if raw.len() != values.len() {
        return Err(invalid("normalization carrier count"));
    }
    let mut count = 0;
    for (a, b) in raw.into_iter().zip(&values) {
        count += 1;
        let v = a * scale;
        if !a.is_finite() || !v.is_finite() || v.to_bits() != b.to_bits() {
            return Err(invalid("raw or signed per-A bit binding"));
        }
    }
    if count != values.len() {
        return Err(invalid("normalization carrier count"));
    }
    Ok(())
}
pub(crate) fn verify(
    bytes: &[u8],
    artifacts: &[AuxiliaryArtifact],
    exact: bool,
) -> Result<(), RunError> {
    let lengths = payload_lengths(bytes)?;
    let m = parse(bytes)?;
    let mut provided = BTreeMap::new();
    for a in artifacts {
        if provided
            .insert(a.relative_path.as_str(), a.bytes.as_slice())
            .is_some()
        {
            return Err(invalid("duplicate payload path"));
        }
    }
    if exact && provided.len() != lengths.len() {
        return Err(invalid("unexpected payload"));
    }
    let mut data = BTreeMap::new();
    for (name, p) in &m.payloads {
        let b = *provided
            .get(p.path.as_str())
            .ok_or_else(|| invalid("payload absent"))?;
        if b.len() != p.byte_length || super::sha256(b) != p.sha256 {
            return Err(invalid("payload length or hash mismatch"));
        }
        data.insert(name.as_str(), b);
    }
    let get = |key: &str| *data.get(key).expect("complete payload closure");
    let mut cells = Vec::new();
    cells
        .try_reserve_exact(m.cell_count)
        .map_err(|_| invalid("cell decode allocation"))?;
    for b in get("cells").chunks_exact(280) {
        let mut ids = [0u64; 4];
        let mut positions = [0f64; 12];
        let mut current = [0f64; 12];
        for k in 0..4 {
            ids[k] = u64_at(b, 8 + 8 * k);
        }
        for k in 0..12 {
            positions[k] = f64_at(b, 40 + 8 * k);
            current[k] = f64_at(b, 136 + 8 * k);
        }
        cells.push(ClosedLoopCurrentCellV2 {
            source_element_index: u64_at(b, 0),
            vertex_ids: ids,
            vertex_xyz_m: positions,
            vertex_current_xyz_apm2: current,
            center_xyz_m: [f64_at(b, 232), f64_at(b, 240), f64_at(b, 248)],
            center_current_xyz_apm2: [f64_at(b, 256), f64_at(b, 264), f64_at(b, 272)],
        });
    }
    let source = ClosedLoopAcceptedSourceInputV2 {
        metadata: m.source.clone(),
        stable_vertex_ids: get("stable_vertex_ids")
            .chunks_exact(8)
            .map(|b| u64_at(b, 0))
            .collect(),
        vertex_xyz_m: xyz(get("vertex_xyz"))?,
        electric_potential_v: reals(get("v_raw"))?,
        conductivity_spm: reals(get("conductivity"))?,
        cells,
        canonical_face_records: get("faces")
            .chunks_exact(32)
            .map(|b| ([u64_at(b, 0), u64_at(b, 8), u64_at(b, 16)], f64_at(b, 24)))
            .collect(),
        paired_weak_reactions: get("weak")
            .chunks_exact(32)
            .map(|b| ClosedLoopWeakReactionV2 {
                minus_vertex_id: u64_at(b, 0),
                plus_vertex_id: u64_at(b, 8),
                minus_reaction_a: f64_at(b, 16),
                plus_reaction_a: f64_at(b, 24),
            })
            .collect(),
        prepared_execution_preimage: copy_bytes(get("prepared_preimage"))?,
        accepted_charge_field_preimage: copy_bytes(get("charge_preimage"))?,
        accepted_source_state_preimage: copy_bytes(get("source_preimage"))?,
        canonical_balance_certificate: copy_bytes(get("certificate"))?,
        authored_input_json: copy_bytes(get("authoring_receipt"))?,
    };
    source_valid(&source)?;
    super::closed_loop_identity_v2::verify(
        &source,
        &m.requested_intent,
        &m.resolved_execution,
        &m.full_closure,
        &m.source_object_id,
        &m.current_transport_id,
        &m.stage_id,
        &m.port_mode_id,
        &m.solution_id,
    )?;
    for (name, values) in [
        ("v", source.electric_potential_v.clone()),
        (
            "j_center",
            source
                .cells
                .iter()
                .flat_map(|c| c.center_current_xyz_apm2)
                .collect(),
        ),
        (
            "j_local",
            source
                .cells
                .iter()
                .flat_map(|c| c.vertex_current_xyz_apm2)
                .collect(),
        ),
        ("h", reals(get("h_raw"))?),
    ] {
        equal(values.iter().copied(), get(&format!("{name}_raw")), 1.0)?;
        equal(values, get(&format!("{name}_per_a")), m.scale_per_a)?;
    }
    let evidence = ClosedLoopFieldEvidence::decode(&m.direct_evidence_schema, get("direct_evidence"))?;
    evidence.verify_policy_binding(&m.requested_intent, &m.resolved_execution)?;
    evidence.verify_source_binding(&m.source, m.cell_count, m.target_count)?;
    if m.signatures.field_solution_signature
        != field_signature(
            &m.source.accepted_source_state_digest,
            &m.sample_carrier,
            &xyz(get("sample_xyz"))?,
            &sampling_cells(get("sample_cells"))?,
            &evidence,
        )?
    {
        return Err(invalid("cold field signature mismatch"));
    }
    evidence.verify_binding(
        &xyz(get("sample_xyz"))?,
        &xyz(get("h_raw"))?,
        &xyz(get("h_per_a"))?,
    )?;
    Ok(())
}

#[cfg(test)]
mod sampling_topology_tests {
    use super::*;
    #[test]
    fn retained_sampling_tet4_rejects_malformed_topology() {
        let carrier = AntennaSampleCarrier { domain: fullmag_ir::FieldTargetIR::Global {},
            carrier_kind: "fem_domain_mesh_asset".into(), location: "node".into(),
            topology_digest: format!("sha256:{}", "00".repeat(32)) };
        let xyz = [[0.0,0.0,0.0], [1.0,0.0,0.0], [0.0,1.0,0.0], [0.0,0.0,1.0]];
        assert!(validate_sampling_mesh(&carrier, &xyz, &[[0,1,2,3]]).is_ok());
        for cell in [[0,1,2,4], [0,1,2,2], [0,2,1,3]] {
            assert!(validate_sampling_mesh(&carrier, &xyz, &[cell]).is_err());
        }
        assert!(validate_sampling_mesh(&carrier, &xyz, &[]).is_err());
        let mut nonfinite = xyz;
        nonfinite[1][0] = f64::NAN;
        assert!(validate_sampling_mesh(&carrier, &nonfinite, &[[0,1,2,3]]).is_err());
        let bytes: Vec<_> = [0u32,1,2,3].into_iter().flat_map(u32::to_le_bytes).collect();
        assert_eq!(sampling_cells(&bytes).unwrap(), vec![[0,1,2,3]]);
        assert!(sampling_cells(&bytes[..15]).is_err());
        assert!(sampling_cells(&[]).is_err());
    }
}
