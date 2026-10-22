//! Independently verify retained named-field preimages against the published carriers.
use super::closed_loop_v2::ClosedLoopAcceptedSourceInputV2;
use crate::types::RunError;
use fullmag_ir::ConservativeCurrentClosureIR;
use num_bigint::BigInt;
use num_rational::BigRational;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

const MAX_CELLS: usize = 1_048_576;
const MAX_VERTICES: usize = 4 * MAX_CELLS;
fn invalid(reason: &str) -> RunError {
    RunError { message: format!("closed-loop identity refused: {reason}") }
}
fn require(ok: bool, reason: &str) -> Result<(), RunError> {
    if ok { Ok(()) } else { Err(invalid(reason)) }
}
fn digest_bytes(value: &str) -> Result<[u8; 32], RunError> {
    let value = value.strip_prefix("sha256:").unwrap_or(value);
    require(value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "invalid SHA-256")?;
    let mut out = [0; 32];
    for (i, pair) in value.as_bytes().chunks_exact(2).enumerate() {
        let nibble = |b: u8| if b <= b'9' { b - b'0' } else { b - b'a' + 10 };
        out[i] = (nibble(pair[0]) << 4) | nibble(pair[1]);
    }
    Ok(out)
}
// Physics binary64 values are encoded with add_u64(value.to_bits()), preserving signed zero.
pub(crate) struct NamedFieldsBuilder { pub(crate) payload: Vec<u8> }
impl NamedFieldsBuilder {
    pub(crate) fn new(schema: &str) -> Self {
        let mut out=Self { payload:Vec::new() }; out.add_string("schema",schema); out
    }
    pub(crate) fn add_bytes(&mut self,name:&str,value:&[u8]) { self.add_field(name,3,value); }
    pub(crate) fn add_string(&mut self,name:&str,value:&str) { self.add_field(name,1,value.as_bytes()); }
    pub(crate) fn add_u64(&mut self,name:&str,value:u64) { self.add_field(name,2,&value.to_be_bytes()); }
    fn add_field(&mut self,name:&str,tag:u8,value:&[u8]) {
        self.payload.extend_from_slice(&(name.len() as u64).to_be_bytes());
        self.payload.extend_from_slice(name.as_bytes()); self.payload.push(tag);
        self.payload.extend_from_slice(&(value.len() as u64).to_be_bytes()); self.payload.extend_from_slice(value);
    }
    pub(crate) fn sha256_hex(&self)->String { format!("{:x}",Sha256::digest(&self.payload)) }
}
struct Fields<'a> { bytes: &'a [u8], offset: usize }
impl<'a> Fields<'a> {
    fn new(bytes: &'a [u8], expected: &str, schema: &str) -> Result<Self, RunError> {
        require(digest_bytes(expected)? == Sha256::digest(bytes).as_slice(), "preimage digest mismatch")?;
        let mut out = Self { bytes, offset: 0 };
        out.expect_string("schema", schema)?;
        Ok(out)
    }
    fn take(&mut self, count: usize) -> Result<&'a [u8], RunError> {
        let end = self.offset.checked_add(count).ok_or_else(|| invalid("preimage length overflow"))?;
        let out = self.bytes.get(self.offset..end).ok_or_else(|| invalid("truncated preimage"))?;
        self.offset = end; Ok(out)
    }
    fn raw_u64(&mut self) -> Result<u64, RunError> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().map_err(|_| invalid("integer framing"))?))
    }
    fn field(&mut self, name: &str, tag: u8) -> Result<&'a [u8], RunError> {
        let length = usize::try_from(self.raw_u64()?).map_err(|_| invalid("name length overflow"))?;
        require(length == name.len() && self.take(length)? == name.as_bytes(), "field name/order mismatch")?;
        require(self.take(1)? == [tag], "field type mismatch")?;
        let length = usize::try_from(self.raw_u64()?).map_err(|_| invalid("value length overflow"))?;
        self.take(length)
    }
    fn string(&mut self, name: &str, empty: bool) -> Result<&'a str, RunError> {
        let bytes = self.field(name, 1)?;
        require(bytes.len() < 256 && (empty || !bytes.is_empty()) && !bytes.contains(&0), "string bound/encoding")?;
        std::str::from_utf8(bytes).map_err(|_| invalid("invalid UTF-8"))
    }
    fn expect_string(&mut self, name: &str, expected: &str) -> Result<(), RunError> {
        require(self.string(name, false)? == expected, "string binding mismatch")
    }
    fn u64(&mut self, name: &str) -> Result<u64, RunError> {
        let bytes = self.field(name, 2)?;
        Ok(u64::from_be_bytes(bytes.try_into().map_err(|_| invalid("u64 payload size"))?))
    }
    fn expect_u64(&mut self, name: &str, expected: u64) -> Result<(), RunError> {
        require(self.u64(name)? == expected, "integer binding mismatch")
    }
    fn count(&mut self, name: &str, maximum: usize) -> Result<usize, RunError> {
        let count = usize::try_from(self.u64(name)?).map_err(|_| invalid("count overflow"))?;
        require(count > 0 && count <= maximum, "count outside carrier bound")?; Ok(count)
    }
    fn scalar(&mut self, name: &str) -> Result<f64, RunError> {
        let value = f64::from_bits(self.u64(name)?);
        require(value.is_finite(), "nonfinite preimage scalar")?; Ok(value)
    }
    fn expect_scalar(&mut self, name: &str, expected: f64) -> Result<(), RunError> {
        require(expected.is_finite() && self.u64(name)? == expected.to_bits(), "binary64 binding mismatch")
    }
    fn nested(&mut self, name: &str, expected: &str) -> Result<(), RunError> {
        require(self.field(name, 3)? == digest_bytes(expected)?, "nested identity mismatch")
    }
    fn finish(self) -> Result<(), RunError> { require(self.offset == self.bytes.len(), "trailing preimage fields") }
}
fn verify_mesh(fields: &mut Fields<'_>, source: &ClosedLoopAcceptedSourceInputV2, potential: bool) -> Result<(), RunError> {
    fields.expect_u64("vertex_count", source.stable_vertex_ids.len() as u64)?;
    for (i, id) in source.stable_vertex_ids.iter().enumerate() {
        fields.expect_u64("vertex_id", *id)?;
        for (axis, name) in ["vertex_x_bits", "vertex_y_bits", "vertex_z_bits"].iter().enumerate() {
            fields.expect_scalar(name, source.vertex_xyz_m[i][axis])?;
        }
        if potential { fields.expect_scalar("potential_v_bits", source.electric_potential_v[i])?; }
    }
    fields.expect_u64("element_count", source.cells.len() as u64)?;
    for (i, cell) in source.cells.iter().enumerate() {
        require(cell.source_element_index == i as u64, "cell ordinal/order mismatch")?;
        for (local, name) in ["cell_vertex_0_id", "cell_vertex_1_id", "cell_vertex_2_id", "cell_vertex_3_id"].iter().enumerate() {
            fields.expect_u64(name, cell.vertex_ids[local])?;
        }
        require(source.conductivity_spm[i] > 0.0, "nonpositive conductivity")?;
        fields.expect_scalar("conductivity_spm_bits", source.conductivity_spm[i])?;
    }
    Ok(())
}
fn le_string(out: &mut Vec<u8>, value: &str) {
    out.extend_from_slice(&(value.len() as u64).to_le_bytes()); out.extend_from_slice(value.as_bytes());
}
fn key(fields: &mut Fields<'_>, names: [&str; 3]) -> Result<[u64; 3], RunError> {
    Ok([fields.u64(names[0])?, fields.u64(names[1])?, fields.u64(names[2])?])
}
fn sorted(key: [u64; 3]) -> [u64; 3] { let mut out = key; out.sort_unstable(); out }
fn subtract(a: [f64; 3], b: [f64; 3]) -> [f64; 3] { [a[0]-b[0], a[1]-b[1], a[2]-b[2]] }
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] { [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]] }
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 { a[0]*b[0]+a[1]*b[1]+a[2]*b[2] }
fn compensated_sum(values: impl Iterator<Item=f64>) -> Result<f64, RunError> {
    let (mut sum, mut correction) = (0.0_f64, 0.0_f64);
    for value in values {
        require(value.is_finite(), "nonfinite flux")?;
        let next = sum + value;
        correction += if sum.abs() >= value.abs() { (sum-next)+value } else { (value-next)+sum };
        sum = next;
    }
    let out = sum + correction; require(out.is_finite(), "flux sum overflow")?; Ok(out)
}

fn provenance_string(value:&Value,name:&str,expected:&str)->Result<(),RunError> {
    require(value.get(name).and_then(Value::as_str)==Some(expected),"provenance string binding")
}
fn provenance_number(value:&Value,name:&str,expected:f64)->Result<(),RunError> {
    require(expected.is_finite() && value.get(name).and_then(Value::as_f64).is_some_and(|v|v.to_bits()==expected.to_bits()),"provenance scalar binding")
}
fn provenance_integer(value:&Value,name:&str,expected:u64)->Result<(),RunError> {
    require(value.get(name).and_then(Value::as_u64)==Some(expected),"provenance integer binding")
}
// Split the existing 128-epsilon pair budget between the two samples.
// Exact dyadic arithmetic prevents a large constant component from corrupting
// a shared slope inferred from the difference of rounded samples.
fn verify_rt0_sample_affinity(points: &[[f64; 3]; 4], currents: &[f64; 12]) -> Result<(), RunError> {
    let zero = BigRational::from_integer(BigInt::from(0));
    let budget = BigRational::new(BigInt::from(64), BigInt::from(1) << 52_usize);
    let mut coordinates: [[BigRational; 3]; 4] =
        std::array::from_fn(|_| std::array::from_fn(|_| zero.clone()));
    let mut samples: [[BigRational; 3]; 4] =
        std::array::from_fn(|_| std::array::from_fn(|_| zero.clone()));
    let mut errors: [[BigRational; 3]; 4] =
        std::array::from_fn(|_| std::array::from_fn(|_| zero.clone()));
    for local in 0..4 {
        for axis in 0..3 {
            coordinates[local][axis] = BigRational::from_float(points[local][axis])
                .ok_or_else(|| invalid("nonfinite RT0 sample coordinate"))?;
            let sample = BigRational::from_float(currents[3 * local + axis])
                .ok_or_else(|| invalid("nonfinite RT0 current sample"))?;
            let magnitude = if sample < zero { -sample.clone() } else { sample.clone() };
            errors[local][axis] = &budget * magnitude;
            samples[local][axis] = sample;
        }
    }
    let mut slope_interval: Option<(BigRational, BigRational)> = None;
    for axis in 0..3 {
        for first in 0..4 {
            for second in 0..first {
                let distance = &coordinates[first][axis] - &coordinates[second][axis];
                let delta = &samples[first][axis] - &samples[second][axis];
                let width = &errors[first][axis] + &errors[second][axis];
                if distance == zero {
                    require(delta >= -width.clone() && delta <= width,
                        "J samples are not one affine RT0 field")?;
                    continue;
                }
                let mut lower = (&delta - &width) / &distance;
                let mut upper = (&delta + &width) / &distance;
                if lower > upper { std::mem::swap(&mut lower, &mut upper); }
                if let Some((minimum, maximum)) = slope_interval.as_mut() {
                    if lower > *minimum { *minimum = lower; }
                    if upper < *maximum { *maximum = upper; }
                    require(*minimum <= *maximum, "J samples are not one affine RT0 field")?;
                } else {
                    slope_interval = Some((lower, upper));
                }
            }
        }
    }
    require(slope_interval.is_some(), "RT0 interpolation pivot")
}

fn verify_owned_geometry(source: &ClosedLoopAcceptedSourceInputV2,
    by_id: &BTreeMap<u64,usize>, faces: &BTreeMap<[u64;3],f64>, owners: &BTreeMap<[u64;3],Vec<usize>>,
    cut_pairs: &[([u64;3],[u64;3])]) -> Result<(),RunError> {
    let mut edge_scale=0.0_f64;
    for cell in &source.cells {
        for local in 1..4 { for axis in 0..3 { edge_scale=edge_scale.max((cell.vertex_xyz_m[3*local+axis]-cell.vertex_xyz_m[axis]).abs()); } }
    }
    require(edge_scale.is_finite() && edge_scale>0.0,"invalid volume gauge scale")?;
    let mut volumes=Vec::new(); let mut weighted=Vec::new();
    for cell in &source.cells {
        let points=cell.vertex_ids.map(|id| source.vertex_xyz_m[by_id[&id]]);
        let edges=[subtract(points[1],points[0]),subtract(points[2],points[0]),subtract(points[3],points[0])].map(|e| e.map(|v| v/edge_scale));
        let volume=dot(edges[0],cross(edges[1],edges[2]));
        require(volume.is_finite() && volume>0.0,"nonpositive Tet4 volume")?;
        volumes.push(volume); weighted.push(volume*compensated_sum(cell.vertex_ids.iter().map(|id| source.electric_potential_v[by_id[id]]*0.25))?);
        for axis in 0..3 {
            let center=compensated_sum(points.iter().map(|v| v[axis]*0.25))?;
            let xyz_scale=points.iter().fold(0.0_f64,|a,v| a.max(v[axis].abs()));
            require(cell.center_xyz_m[axis].is_finite() && (center-cell.center_xyz_m[axis]).abs()<=128.0*f64::EPSILON*xyz_scale,"sampled center geometry mismatch")?;
            let mean=compensated_sum((0..4).map(|local|cell.vertex_current_xyz_apm2[3*local+axis]*0.25))?;
            let j_scale=(0..4).fold(0.0_f64,|a,local|a.max(cell.vertex_current_xyz_apm2[3*local+axis].abs()));
            require(cell.center_current_xyz_apm2[axis].is_finite() && (mean-cell.center_current_xyz_apm2[axis]).abs()<=128.0*f64::EPSILON*j_scale,"cell-local J interpolation mismatch")?;
        }
        verify_rt0_sample_affinity(&points, &cell.vertex_current_xyz_apm2)?;
        let mut outward_fluxes=Vec::new();
        for opposite in 0..4 {
            let mut ids=cell.vertex_ids.iter().enumerate().filter_map(|(i,id)|(i!=opposite).then_some(*id)).collect::<Vec<_>>(); ids.sort_unstable();
            let face=[ids[0],ids[1],ids[2]]; let xyz=face.map(|id|source.vertex_xyz_m[by_id[&id]]);
            let normal=cross(subtract(xyz[1],xyz[0]),subtract(xyz[2],xyz[0]));
            let orientation=dot(normal,subtract(points[opposite],xyz[0]));
            require(orientation.is_finite() && orientation!=0.0,"degenerate face orientation")?;
            let mut current=[0.0;3]; let mut term_scale=0.0;
            for axis in 0..3 {
                current[axis]=compensated_sum(face.iter().map(|id| {
                    let local=cell.vertex_ids.iter().position(|other|other==id).unwrap();
                    cell.vertex_current_xyz_apm2[3*local+axis]/3.0
                }))?;
                term_scale+=normal[axis].abs()*current[axis].abs()*0.5;
            }
            let sampled=dot(normal,current)*0.5;
            let actual=*faces.get(&face).ok_or_else(||invalid("missing canonical face sample"))?;
            require(sampled.is_finite() && term_scale.is_finite() && (sampled-actual).abs()<=1e-18+1e-10*term_scale.max(actual.abs()),"J trace/canonical flux mismatch")?;
            outward_fluxes.push(actual*if orientation<0.0 {1.0} else {-1.0});
        }
        let balance=compensated_sum(outward_fluxes.iter().copied())?;
        let scale=compensated_sum(outward_fluxes.iter().map(|v|v.abs()))?;
        require(balance.abs()<=1e-18+1e-10*scale,"cell current divergence gate")?;
    }
    let mean=compensated_sum(weighted.into_iter())?/compensated_sum(volumes.into_iter())?;
    let potential_scale=source.electric_potential_v.iter().fold(0.0_f64,|a,v|a.max(v.abs()));
    let gauge_gate=1e-12+128.0*f64::EPSILON*potential_scale;
    require(mean.is_finite() && mean.abs()<=gauge_gate && (mean-source.metadata.gauge_mean_v).abs()<=gauge_gate,"owned volume zero-mean gauge")?;
    let mut minus_fluxes=Vec::new();
    for (minus,_) in cut_pairs {
        let ordinals=owners.get(minus).ok_or_else(||invalid("source cut owner absent"))?;
        require(ordinals.len()==1,"source cut is not a boundary")?;
        let owner=&source.cells[ordinals[0]];
        let opposite=*owner.vertex_ids.iter().find(|id|!minus.contains(id)).ok_or_else(||invalid("source opposite absent"))?;
        let xyz=minus.map(|id|source.vertex_xyz_m[by_id[&id]]);
        let normal=cross(subtract(xyz[1],xyz[0]),subtract(xyz[2],xyz[0]));
        let orientation=dot(normal,subtract(source.vertex_xyz_m[by_id[&opposite]],xyz[0]));
        require(orientation.is_finite() && orientation!=0.0,"source cut orientation")?;
        minus_fluxes.push(faces[minus]*if orientation<0.0 {1.0} else {-1.0});
    }
    let scale=compensated_sum(minus_fluxes.iter().map(|v|v.abs()))?;
    let current=compensated_sum(minus_fluxes.into_iter())?;
    let gate=128.0*f64::EPSILON*scale;
    require((source.metadata.source_current_a-current).abs()<=gate && (source.metadata.source_absolute_flux_a-scale).abs()<=gate,"signed source current/absolute flux mismatch")?;
    Ok(())
}

pub(crate) fn verify(source: &ClosedLoopAcceptedSourceInputV2, requested_intent: &Value,
    resolved_execution: &Value, full_closure: &Value, source_object_id: &str,
    current_transport_id: &str, stage_id: &str, port_mode_id: &str, solution_id: &str) -> Result<(), RunError> {
    let m = &source.metadata;
    let n = source.stable_vertex_ids.len(); let cells = source.cells.len();
    require(n > 0 && n <= MAX_VERTICES && cells > 0 && cells <= MAX_CELLS &&
        source.vertex_xyz_m.len() == n && source.electric_potential_v.len() == n && source.conductivity_spm.len() == cells,
        "carrier count mismatch")?;
    require(requested_intent.as_object().is_some_and(|o|o.len()==8) && resolved_execution.as_object().is_some_and(|o|o.len()==16), "missing or foreign execution provenance fields")?;
    require(m.digest_encoding == "canonical_named_fields_be_bits.v2" &&
        m.periodic_operator_version == "fem_charge_h1_periodic_jump.v2" && m.closure_operator_version == "fem_closed_current_geometry.v2" &&
        m.conservative_current_operator_version == "fem_conservative_current_rt0_view.v1" &&
        m.sampling_policy == "cell_center_and_cell_local_vertices.v1" && m.source_current_orientation == "authored_minus_outward.v1" &&
        m.weak_reaction_ledger_version == "original_k_paired_vertex_reactions.v2", "unsupported operator/identity version")?;
    let by_id = source.stable_vertex_ids.iter().enumerate().map(|(i,id)| (*id,i)).collect::<BTreeMap<_,_>>();
    require(by_id.len() == n, "duplicate stable IDs")?;
    for cell in &source.cells {
        require(cell.vertex_ids.iter().copied().collect::<BTreeSet<_>>().len() == 4, "degenerate Tet4 IDs")?;
        for local in 0..4 {
            let index = *by_id.get(&cell.vertex_ids[local]).ok_or_else(|| invalid("cell vertex absent"))?;
            for axis in 0..3 {
                require(cell.vertex_xyz_m[3*local+axis].to_bits() == source.vertex_xyz_m[index][axis].to_bits(), "cell geometry/carrier mismatch")?;
            }
        }
    }
    let mut p = Fields::new(&source.prepared_execution_preimage, &m.prepared_execution_digest, "prepared_closed_loop_execution_input.v2")?;
    let mut labels = BTreeMap::new();
    for name in ["source_revision","object_id","geometry_id","source_module_id","mesh_revision","topology_revision","mesh_digest","authored_input_digest","materials_digest","closure_revision","closure_digest","envelope_revision","envelope_digest"] {
        labels.insert(name, p.string(name,false)?);
    }
    require(labels["object_id"] == source_object_id && labels["source_module_id"] == current_transport_id, "foreign source owner")?;
    let crate::artifact_json::UnambiguousJson(authored)=serde_json::from_slice(&source.authored_input_json).map_err(|_|invalid("ambiguous or malformed authoring receipt"))?;
    let authored_digest=fullmag_ir::transport_identity::tagged_json_digest(&authored).map_err(|_|invalid("invalid authored tagged identity"))?;
    require(digest_bytes(&authored_digest)?==digest_bytes(labels["authored_input_digest"])? && authored.get("schema").and_then(Value::as_str)==Some("antenna_coincident_prepared_input.v2"),"authored input identity mismatch")?;
    require(authored.get("object_id").and_then(Value::as_str)==Some(source_object_id) && authored.get("mesh_digest").and_then(Value::as_str)==Some(labels["mesh_digest"]) && authored.get("materials_digest").and_then(Value::as_str)==Some(labels["materials_digest"]),"authoring receipt source scope mismatch")?;
    require(authored.get("requested_execution").is_some() && requested_intent.get("requested_execution")==authored.get("requested_execution"),"requested execution differs from hashed authoring intent")?;
    for name in ["source_revision","object_id","geometry_id","source_module_id","mesh_digest","authored_input_digest","materials_digest"] { provenance_string(requested_intent,name,labels[name])?; }
    for name in ["mesh_revision","topology_revision","envelope_revision","envelope_digest"] { provenance_string(resolved_execution,name,labels[name])?; }
    let expected_envelope = super::closed_loop_execution::static_envelope_digest(current_transport_id, labels["source_revision"])?;
    require(labels["envelope_digest"] == expected_envelope && labels["envelope_revision"] == expected_envelope,
        "static envelope provenance mismatch")?;
    require(labels["mesh_revision"] == labels["mesh_digest"] && labels["topology_revision"] == labels["mesh_digest"],
        "static mesh revision provenance mismatch")?;
    let stage = p.u64("stage_identity")?; let time = p.scalar("evaluation_time_s_bits")?; let multiplier = p.scalar("evaluated_envelope_multiplier_bits")?;
    let stable_version = p.string("stable_vertex_id_version",false)?;
    require(stable_version=="stable_mesh_vertex_u64.v1","unsupported stable ID version")?;
    provenance_string(resolved_execution,"stable_vertex_id_version",stable_version)?;
    provenance_string(resolved_execution,"stage_identity",&stage.to_string())?;
    require(stage == super::closed_loop_execution::prepared_stage_identity(stage_id, port_mode_id, solution_id, labels["source_revision"])?
        && time.to_bits() == 0.0_f64.to_bits() && multiplier.to_bits() == 1.0_f64.to_bits(),
        "static stage/envelope binding mismatch")?;
    provenance_number(resolved_execution,"evaluation_time_s",time)?;
    provenance_number(resolved_execution,"evaluated_envelope_multiplier",multiplier)?;
    p.expect_string("periodic_operator_version", &m.periodic_operator_version)?; p.expect_string("closure_operator_version", &m.closure_operator_version)?;
    p.expect_u64("execution_lane",1)?; p.expect_u64("charge_gauge",2)?;
    provenance_integer(resolved_execution,"execution_lane",1)?; provenance_integer(resolved_execution,"charge_gauge",2)?;
    let iterations = p.u64("maximum_iterations")?; require(iterations > 0 && iterations <= i32::MAX as u64, "iteration budget")?;
    provenance_integer(resolved_execution,"maximum_iterations",iterations)?;
    for (name,value) in [("charge_relative_tolerance",1e-12),("charge_absolute_tolerance",0.0),("algebraic_relative_tolerance",1e-12),("physical_relative_gate",1e-10),("physical_absolute_gate_a",1e-18)] { provenance_number(resolved_execution,name,value)?; }
    p.expect_scalar("charge_relative_tolerance_bits",1e-12)?; p.expect_scalar("charge_absolute_tolerance_bits",0.0)?;
    p.expect_scalar("rt0_algebraic_tolerance_bits",1e-12)?; p.expect_scalar("physical_relative_gate_bits",1e-10)?; p.expect_scalar("physical_absolute_gate_a_bits",1e-18)?;
    verify_mesh(&mut p,source,false)?;
    let assignments = p.count("material_assignment_count", cells)?; let parts = p.count("material_part_count",cells)?;
    let mut coverage = BTreeMap::new(); let mut previous_part = "";
    for _ in 0..parts {
        let part = p.string("part_id",false)?; require(previous_part < part, "material part ordering")?; previous_part = part;
        require(p.u64("material_assignment_index")? < assignments as u64, "foreign material assignment")?;
        let count = p.count("part_element_count",cells)?; let mut previous = None;
        for _ in 0..count {
            let ordinal = p.u64("part_element_ordinal")?;
            require(ordinal < cells as u64 && previous.is_none_or(|old| old < ordinal) && coverage.insert(ordinal,part).is_none(), "material coverage/order")?;
            previous = Some(ordinal);
        }
    }
    require(coverage.len() == cells, "incomplete material coverage")?;
    let mut actual_faces = BTreeMap::<[u64;3], Vec<usize>>::new();
    for (i,cell) in source.cells.iter().enumerate() {
        for opposite in 0..4 {
            let face = cell.vertex_ids.iter().enumerate().filter_map(|(j,id)| (j != opposite).then_some(*id)).collect::<Vec<_>>();
            actual_faces.entry(sorted([face[0],face[1],face[2]])).or_default().push(i);
        }
    }
    require(source.cells.iter().flat_map(|c|c.vertex_ids).collect::<BTreeSet<_>>().len()==n,"unused source vertices")?;
    require(actual_faces.values().all(|owners| owners.len() <= 2), "nonmanifold current mesh")?;
    let boundary_count = actual_faces.values().filter(|owners| owners.len()==1).count();
    p.expect_u64("boundary_face_count",boundary_count as u64)?;
    let mut boundary = BTreeMap::new(); let mut previous_face = None;
    for _ in 0..boundary_count {
        let face = key(&mut p,["boundary_vertex_0_id","boundary_vertex_1_id","boundary_vertex_2_id"])?;
        require(face[0]<face[1] && face[1]<face[2] && previous_face.is_none_or(|old| old<face) && actual_faces.get(&face).is_some_and(|owners| owners.len()==1), "boundary face order/ownership")?;
        previous_face = Some(face); let role = p.u64("boundary_role")?; let circuit = p.string("boundary_circuit_id",true)?;
        require((role==1 && circuit.is_empty()) || (role==2 && !circuit.is_empty()), "unsupported boundary role")?;
        boundary.insert(face,(role,circuit));
    }
    p.expect_u64("source_cut_count",1)?; let cut_id = p.string("source_cut_id",false)?;
    for name in ["translation_x_bits","translation_y_bits","translation_z_bits"] { require(p.scalar(name)? == 0.0, "nonzero coincident translation")?; }
    p.expect_scalar("potential_drop_v_bits",m.potential_jump_v)?; require(m.potential_jump_v != 0.0,"zero potential jump")?;
    let pairs = p.count("source_pair_count",boundary_count/2)?;
    let mut cut_pairs = Vec::new(); let mut vertex_pairs = BTreeMap::new(); let mut reverse = BTreeSet::new(); let mut previous_pair = None;
    for _ in 0..pairs {
        let minus = key(&mut p,["minus_vertex_0_id","minus_vertex_1_id","minus_vertex_2_id"])?;
        let plus = key(&mut p,["plus_vertex_0_id","plus_vertex_1_id","plus_vertex_2_id"])?;
        require(minus[0]<minus[1] && minus[1]<minus[2] && plus[0]<plus[1] && plus[1]<plus[2] && previous_pair.is_none_or(|old| old<(minus,plus)), "cut pair order")?;
        previous_pair = Some((minus,plus));
        for face in [minus,plus] { require(boundary.get(&face)==Some(&(2,cut_id)), "cut boundary role mismatch")?; }
        for id in minus {
            let a = *by_id.get(&id).ok_or_else(|| invalid("minus trace ID absent"))?;
            let matches = plus.iter().filter(|other| by_id.get(other).is_some_and(|index| (0..3).all(|axis| source.vertex_xyz_m[a][axis].to_bits()==source.vertex_xyz_m[*index][axis].to_bits()))).copied().collect::<Vec<_>>();
            require(matches.len()==1 && matches[0]!=id, "noncoincident trace pairing")?;
            let other = matches[0];
            if let Some(old)=vertex_pairs.insert(id,other) { require(old==other,"inconsistent trace pairing")?; } else { require(reverse.insert(other),"nonbijective trace pairing")?; }
            let jump = source.electric_potential_v[by_id[&other]]-source.electric_potential_v[a];
            require(jump.is_finite() && (jump-m.potential_jump_v).abs()<=1e-12+128.0*f64::EPSILON*m.potential_jump_v.abs(), "potential jump mismatch")?;
        }
        cut_pairs.push((minus,plus));
    }
    require(vertex_pairs.keys().all(|id| !reverse.contains(id)) && boundary.values().filter(|(role,_)| *role==2).count()==2*pairs, "shorted/incomplete cut")?;
    let authored: ConservativeCurrentClosureIR = serde_json::from_value(full_closure.clone()).map_err(|_| invalid("missing typed full closure"))?;
    let ConservativeCurrentClosureIR::ClosedGeometry { operator_version, revision, digest, source_cuts } = authored else { return Err(invalid("foreign closure family")); };
    require(operator_version==m.closure_operator_version && revision==labels["closure_revision"] && digest==labels["closure_digest"] && source_cuts.len()==1, "closure identity mismatch")?;
    let cut = &source_cuts[0];
    require(cut.id==cut_id && cut.potential_drop_v.to_bits()==m.potential_jump_v.to_bits() && cut.translation_m.iter().all(|v| v.is_finite() && *v==0.0) && cut.face_pairs.len()==cut_pairs.len() && cut.face_pairs.iter().zip(&cut_pairs).all(|(a,b)| (a.minus_face_vertex_ids,a.plus_face_vertex_ids)==*b), "closure source cut mismatch")?;
    let observations = p.count("observation_count",boundary_count)?; let mut previous_observation = ""; let mut observed_faces = BTreeSet::new();
    require(observations==m.terminal_observation_currents.len(), "observation current count")?;
    let fluxes = source.canonical_face_records.iter().copied().collect::<BTreeMap<_,_>>();
    require(fluxes.len()==source.canonical_face_records.len() && fluxes.len()==actual_faces.len(), "canonical face coverage")?;
    for _ in 0..observations {
        let id = p.string("observation_id",false)?; require(previous_observation<id,"observation ordering")?; previous_observation=id;
        let part = p.string("observation_part_id",false)?; let selector=p.string("observation_selector",false)?;
        require(selector=="local_u_min" || selector=="local_u_max","observation selector")?; p.expect_string("normal_convention","outward_from_part")?;
        let count = p.count("observation_face_count",4*cells)?; let mut values=Vec::new(); let mut previous=None;
        for _ in 0..count {
            let face=key(&mut p,["observation_vertex_0_id","observation_vertex_1_id","observation_vertex_2_id"])?;
            let part_cell=p.u64("part_cell_ordinal")?; let bridge_cell=p.u64("bridge_cell_ordinal")?;
            require(face[0]<face[1] && face[0]<face[2] && face[1]!=face[2] && previous.is_none_or(|old| old<(face,part_cell,bridge_cell)),"observation face order")?; previous=Some((face,part_cell,bridge_cell));
            let face_key=sorted(face); let owners=actual_faces.get(&face_key).ok_or_else(|| invalid("observation face absent"))?;
            require(observed_faces.insert(face_key) && owners.len()==2 && owners.contains(&(part_cell as usize)) && owners.contains(&(bridge_cell as usize)) && part_cell!=bridge_cell && coverage.get(&part_cell)==Some(&part) && coverage.get(&bridge_cell)!=Some(&part),"observation part/bridge ownership")?;
            let points=face.map(|v| source.vertex_xyz_m[by_id[&v]]);
            let normal=cross(subtract(points[1],points[0]),subtract(points[2],points[0]));
            let opposite=*source.cells[part_cell as usize].vertex_ids.iter().find(|v| !face.contains(v)).ok_or_else(|| invalid("observation opposite absent"))?;
            require(dot(normal,subtract(source.vertex_xyz_m[by_id[&opposite]],points[0]))<0.0,"observation normal is not outward")?;
            let sign=if face[1]<face[2] {1.0} else {-1.0};
            values.push(*fluxes.get(&face_key).ok_or_else(|| invalid("observation flux absent"))?*sign);
        }
        let current=compensated_sum(values.into_iter())?; let actual=*m.terminal_observation_currents.get(id).ok_or_else(|| invalid("observation current absent"))?;
        require(actual.is_finite() && (actual-current).abs()<=1e-18+1e-10*actual.abs().max(current.abs()),"observation current mismatch")?;
    }
    p.finish()?;
    verify_owned_geometry(source,&by_id,&fluxes,&actual_faces,&cut_pairs)?;
    super::closed_loop_balance_v2::verify_balance_certificate(source,&cut_pairs,cut_id)?;
    let mut q=Fields::new(&source.accepted_charge_field_preimage,&m.accepted_charge_field_digest,"accepted_closed_loop_charge_field.v2")?;
    q.nested("prepared_execution_digest",&m.prepared_execution_digest)?; q.expect_string("periodic_operator_version",&m.periodic_operator_version)?; q.expect_string("stable_vertex_id_version",stable_version)?;
    verify_mesh(&mut q,source,true)?;
    for (name,value) in [("potential_drop_v_bits",m.potential_jump_v),("measured_potential_jump_v_bits",m.measured_potential_jump_v),("gauge_mean_v_bits",m.gauge_mean_v),("charge_relative_residual_bits",m.charge_relative_residual)] { q.expect_scalar(name,value)?; }
    require(m.charge_relative_residual>=0.0 && m.charge_relative_residual<=1e-12 && (m.measured_potential_jump_v-m.potential_jump_v).abs()<=1e-12+128.0*f64::EPSILON*m.potential_jump_v.abs(),"accepted charge gate")?; q.finish()?;
    let mut s=Fields::new(&source.accepted_source_state_preimage,&m.accepted_source_state_digest,"accepted_closed_loop_source_state.v2")?;
    s.nested("prepared_execution_digest",&m.prepared_execution_digest)?; s.nested("accepted_charge_field_digest",&m.accepted_charge_field_digest)?;
    s.expect_string("conservative_current_operator_version",&m.conservative_current_operator_version)?; s.expect_string("sampling_policy",&m.sampling_policy)?; s.expect_string("source_current_orientation",&m.source_current_orientation)?;
    s.expect_scalar("source_current_a_bits",m.source_current_a)?; s.expect_scalar("source_absolute_flux_a_bits",m.source_absolute_flux_a)?;
    require(m.source_absolute_flux_a>=m.source_current_a.abs(),"source absolute flux scale")?;
    s.expect_u64("canonical_face_count",source.canonical_face_records.len() as u64)?; let mut previous=None; let mut face_payload=Vec::new();
    for (face,flux) in &source.canonical_face_records {
        require(face[0]<face[1] && face[1]<face[2] && previous.is_none_or(|old| old<*face) && actual_faces.contains_key(face),"canonical face order/coverage")?; previous=Some(*face);
        for (i,name) in ["face_vertex_0_id","face_vertex_1_id","face_vertex_2_id"].iter().enumerate() { s.expect_u64(name,face[i])?; face_payload.extend_from_slice(&face[i].to_le_bytes()); }
        s.expect_scalar("flux_a_bits",*flux)?; face_payload.extend_from_slice(&(if *flux==0.0 {0.0} else {*flux}).to_le_bytes());
    }
    require(source.canonical_balance_certificate.len()<=128*1024*1024 && !source.canonical_balance_certificate.is_empty() && digest_bytes(&m.current_balance_certificate_digest)?==Sha256::digest(&source.canonical_balance_certificate).as_slice(),"balance certificate bytes/digest")?;
    require(s.field("canonical_balance_certificate",3)?==source.canonical_balance_certificate,"certificate source-state binding")?;
    s.expect_string("weak_reaction_ledger_version",&m.weak_reaction_ledger_version)?; s.expect_u64("paired_weak_reaction_count",source.paired_weak_reactions.len() as u64)?;
    require(source.paired_weak_reactions.len()==vertex_pairs.len(),"weak reaction coverage")?; let mut previous=None; let mut maximum=0.0_f64;
    for row in &source.paired_weak_reactions {
        require(previous.is_none_or(|old| old<(row.minus_vertex_id,row.plus_vertex_id)) && vertex_pairs.get(&row.minus_vertex_id)==Some(&row.plus_vertex_id),"weak reaction pairing/order")?; previous=Some((row.minus_vertex_id,row.plus_vertex_id));
        s.expect_u64("minus_vertex_id",row.minus_vertex_id)?; s.expect_u64("plus_vertex_id",row.plus_vertex_id)?; s.expect_scalar("minus_reaction_a_bits",row.minus_reaction_a)?; s.expect_scalar("plus_reaction_a_bits",row.plus_reaction_a)?;
        let mismatch=(row.minus_reaction_a+row.plus_reaction_a).abs(); let scale=row.minus_reaction_a.abs()+row.plus_reaction_a.abs();
        require(mismatch.is_finite() && scale.is_finite() && mismatch<=1e-18+1e-10*scale,"paired weak current gate")?; maximum=maximum.max(mismatch);
    }
    require(maximum.to_bits()==m.max_paired_weak_flux_mismatch_a.to_bits(),"weak maximum mismatch")?; s.expect_scalar("max_paired_weak_flux_mismatch_a_bits",maximum)?; s.expect_u64("sampled_cell_count",cells as u64)?;
    for cell in &source.cells {
        s.expect_u64("source_element_index",cell.source_element_index)?;
        for local in 0..4 {
            s.expect_u64("vertex_id",cell.vertex_ids[local])?;
            for (axis,name) in ["vertex_x_bits","vertex_y_bits","vertex_z_bits"].iter().enumerate() { s.expect_scalar(name,cell.vertex_xyz_m[3*local+axis])?; }
            for (axis,name) in ["current_x_apm2_bits","current_y_apm2_bits","current_z_apm2_bits"].iter().enumerate() { s.expect_scalar(name,cell.vertex_current_xyz_apm2[3*local+axis])?; }
        }
        for (axis,name) in ["center_x_bits","center_y_bits","center_z_bits"].iter().enumerate() { s.expect_scalar(name,cell.center_xyz_m[axis])?; }
        for (axis,name) in ["center_current_x_apm2_bits","center_current_y_apm2_bits","center_current_z_apm2_bits"].iter().enumerate() { s.expect_scalar(name,cell.center_current_xyz_apm2[axis])?; }
    }
    s.finish()?;
    let mut canonical=Vec::new(); le_string(&mut canonical,"fem_rt0_canonical_face_digest.v1"); le_string(&mut canonical,&m.conservative_current_operator_version); le_string(&mut canonical,"stable_vertex_lexicographic_normal.v1"); le_string(&mut canonical,labels["mesh_digest"]); canonical.extend_from_slice(&(source.canonical_face_records.len() as u64).to_le_bytes()); canonical.extend_from_slice(&Sha256::digest(&face_payload));
    let mut view=Vec::new(); le_string(&mut view,"fem_conservative_current_view_identity_digest.v1"); view.extend_from_slice(&Sha256::digest(&canonical));
    for value in [labels["source_module_id"],labels["source_revision"],m.accepted_charge_field_digest.as_str(),labels["mesh_revision"],labels["topology_revision"],labels["mesh_digest"],labels["closure_revision"],labels["closure_digest"],labels["envelope_revision"],labels["envelope_digest"]] { le_string(&mut view,value); }
    view.extend_from_slice(&(if multiplier==0.0 {0.0} else {multiplier}).to_le_bytes()); view.extend_from_slice(&(if time==0.0 {0.0} else {time}).to_le_bytes()); view.extend_from_slice(&stage.to_le_bytes()); view.extend_from_slice(&digest_bytes(&m.current_balance_certificate_digest)?);
    require(digest_bytes(&m.view_identity_digest)?==Sha256::digest(&view).as_slice(),"RT0 view identity mismatch")?;
    Ok(())
}

#[cfg(test)]
#[path = "closed_loop_identity_v2_affinity_tests.rs"]
mod affinity_tests;
