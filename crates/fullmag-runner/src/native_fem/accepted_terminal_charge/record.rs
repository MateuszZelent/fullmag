use super::{require, sorted, AcceptedChargeInterface, DIGEST_SCHEMA, OPERATOR_VERSION};
use crate::types::RunError;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug)]
pub(crate) struct AcceptedChargeVertex {
    pub id: u64,
    pub xyz_m: [f64; 3],
    pub potential_v: f64,
    pub reaction_a: f64,
    pub component_id: u64,
}
#[derive(Debug)]
pub(crate) struct AcceptedChargeElement {
    pub attribute: u64,
    pub vertex_ids: [u64; 4],
    pub conductivity_spm: f64,
}
#[derive(Debug)]
pub(crate) struct AcceptedChargeBoundary {
    pub attribute: u64,
    pub vertex_ids: [u64; 3],
}
#[derive(Debug)]
pub(crate) struct AcceptedChargeFace {
    pub vertex_ids: [u64; 3],
    pub first_element: i64,
    pub second_element: i64,
    pub signed_rt0_dof: i64,
}
#[derive(Debug)]
pub(crate) struct AcceptedChargeTerminalResult {
    pub id: String,
    pub faces: Vec<[u64; 3]>,
    pub requested_current_a: f64,
    pub h1_current_a: f64,
    pub h1_residual_a: f64,
    pub rt0_current_a: f64,
    pub rt0_residual_a: f64,
    pub voltage_v: f64,
    pub component_id: u64,
}
#[derive(Debug)]
pub(crate) struct AcceptedChargeInterfaceResult {
    pub authored: AcceptedChargeInterface,
    pub first_current_a: f64,
    pub second_current_a: f64,
    pub mismatch_a: f64,
}
#[derive(Debug)]
pub(crate) struct AcceptedChargeComponent {
    pub id: u64,
    pub relative_residual: f64,
}
#[derive(Debug)]
pub(crate) struct AcceptedChargeOmission {
    pub constraint_id: String,
    pub reason: u64,
    pub residual_a: f64,
    pub anchor_vertex_ids: [u64; 4],
}
#[derive(Debug)]
pub(crate) struct AcceptedTerminalChargeRecord {
    pub canonical_payload: Vec<u8>,
    pub content_sha256: String,
    pub policy: [f64; 3],
    pub maximum_iterations: u64,
    pub stable_vertex_version: String,
    pub vertices: Vec<AcceptedChargeVertex>,
    pub elements: Vec<AcceptedChargeElement>,
    pub boundary: Vec<AcceptedChargeBoundary>,
    pub faces: Vec<AcceptedChargeFace>,
    pub rt0_flux_a: Vec<f64>,
    pub terminals: Vec<AcceptedChargeTerminalResult>,
    pub interfaces: Vec<AcceptedChargeInterfaceResult>,
    pub constraint_rows: u64,
    pub constraint_rank: u64,
    pub references: BTreeMap<u64, String>,
    pub components: Vec<AcceptedChargeComponent>,
    pub gauges: Vec<u64>,
    pub omitted_rows: Vec<AcceptedChargeOmission>,
}

// Names, tags and lengths are parsed independently of the native encoder.
pub(in crate::native_fem) struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}
impl<'a> Reader<'a> {
    pub(in crate::native_fem) fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }
    pub(in crate::native_fem) fn finish(&self) -> Result<(), RunError> {
        require(
            self.position == self.bytes.len(),
            "trailing canonical bytes",
        )
    }
    pub(in crate::native_fem) fn position(&self) -> usize {
        self.position
    }
    fn take(&mut self, count: usize) -> Result<&'a [u8], RunError> {
        require(
            count <= self.bytes.len() - self.position,
            "truncated canonical record",
        )?;
        let begin = self.position;
        self.position += count;
        Ok(&self.bytes[begin..self.position])
    }
    fn word(&mut self) -> Result<u64, RunError> {
        let mut bytes = [0; 8];
        bytes.copy_from_slice(self.take(8)?);
        Ok(u64::from_be_bytes(bytes))
    }
    pub(in crate::native_fem) fn field(
        &mut self,
        name: &str,
        tag: u8,
    ) -> Result<&'a [u8], RunError> {
        require(
            self.word()? == name.len() as u64,
            "canonical field name length mismatch",
        )?;
        require(
            self.take(name.len())? == name.as_bytes() && self.take(1)?[0] == tag,
            "canonical field name/type mismatch",
        )?;
        let length = self.word()?;
        require(
            length <= (self.bytes.len() - self.position) as u64,
            "canonical field length exceeds remaining bytes",
        )?;
        self.take(length as usize)
    }
    pub(in crate::native_fem) fn integer(&mut self, name: &str) -> Result<u64, RunError> {
        let value = self.field(name, 2)?;
        require(value.len() == 8, "canonical integer is not u64")?;
        let mut bytes = [0; 8];
        bytes.copy_from_slice(value);
        Ok(u64::from_be_bytes(bytes))
    }
    pub(in crate::native_fem) fn real(&mut self, name: &str) -> Result<f64, RunError> {
        let value = self.field(name, 4)?;
        require(value.len() == 8, "canonical real is not binary64")?;
        let mut bytes = [0; 8];
        bytes.copy_from_slice(value);
        let bits = u64::from_be_bytes(bytes);
        let value = f64::from_bits(bits);
        require(
            value.is_finite() && bits != (1u64 << 63),
            "nonfinite/noncanonical binary64",
        )?;
        Ok(value)
    }
    pub(in crate::native_fem) fn text(&mut self, name: &str) -> Result<String, RunError> {
        self.text_value(name, false)
    }
    pub(in crate::native_fem) fn text_allow_empty(
        &mut self,
        name: &str,
    ) -> Result<String, RunError> {
        self.text_value(name, true)
    }
    fn text_value(&mut self, name: &str, allow_empty: bool) -> Result<String, RunError> {
        let value = self.field(name, 1)?;
        // Constraint IDs include a native prefix around a bounded authored ID.
        let maximum = if name == "constraint_id" { 8192 } else { 4096 };
        require(
            (allow_empty || !value.is_empty()) && value.len() <= maximum && !value.contains(&0),
            "canonical text exceeds its bound or contains NUL",
        )?;
        std::str::from_utf8(value)
            .map(str::to_owned)
            .map_err(|_| RunError {
                message: "accepted terminal charge: canonical text is not UTF-8".into(),
            })
    }
    pub(in crate::native_fem) fn count(
        &mut self,
        name: &str,
        maximum: usize,
        nonzero: bool,
    ) -> Result<usize, RunError> {
        let count = self.integer(name)?;
        require(
            count <= maximum as u64
                && (!nonzero || count > 0)
                && count <= ((self.bytes.len() - self.position) / 17) as u64,
            "canonical count exceeds support or remaining payload",
        )?;
        Ok(count as usize)
    }
    fn ids<const N: usize>(&mut self) -> Result<[u64; N], RunError> {
        let mut ids = [0; N];
        for id in &mut ids {
            *id = self.integer("vertex_id")?;
        }
        Ok(ids)
    }
}

pub(crate) fn decode_accepted_terminal_charge_record(
    payload: Vec<u8>,
    expected_sha256: &str,
) -> Result<AcceptedTerminalChargeRecord, RunError> {
    require(
        !payload.is_empty() && payload.len() <= super::MAX_PAYLOAD_BYTES,
        "canonical record exceeds payload bound",
    )?;
    require(
        expected_sha256.len() == 64
            && expected_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            && format!("{:x}", Sha256::digest(&payload)) == expected_sha256,
        "canonical record SHA-256 mismatch",
    )?;
    let mut reader = Reader {
        bytes: &payload,
        position: 0,
    };
    require(
        reader.text("schema")? == DIGEST_SCHEMA && reader.text("operator")? == OPERATOR_VERSION,
        "canonical schema/operator mismatch",
    )?;
    let policy = [
        reader.real("absolute_jump_tolerance_v")?,
        reader.real("relative_jump_tolerance")?,
        reader.real("algebraic_relative_tolerance")?,
    ];
    let maximum_iterations = reader.integer("maximum_iterations")?;
    require(
        policy[0] >= 0.0
            && policy[1] >= 0.0
            && policy[2] > 0.0
            && policy[2] < 1.0
            && maximum_iterations > 0
            && maximum_iterations <= i32::MAX as u64,
        "canonical solver policy is invalid",
    )?;
    let nv = reader.count("vertices", 4 << 20, true)?;
    let stable_vertex_version = reader.text("stable_vertex_version")?;
    require(
        stable_vertex_version == "stable_mesh_vertex_u64.v1",
        "unknown stable vertex identity version",
    )?;
    let mut vertices = Vec::new();
    let mut by_id = BTreeMap::new();
    for index in 0..nv {
        let vertex = AcceptedChargeVertex {
            id: reader.integer("vertex_id")?,
            xyz_m: [
                reader.real("xyz_m")?,
                reader.real("xyz_m")?,
                reader.real("xyz_m")?,
            ],
            potential_v: reader.real("potential_v")?,
            reaction_a: reader.real("reaction_a")?,
            component_id: reader.integer("vertex_component_id")?,
        };
        require(
            vertex.id != 0 && by_id.insert(vertex.id, index).is_none(),
            "canonical vertex IDs are zero or repeated",
        )?;
        vertices.push(vertex);
    }
    let ne = reader.count("elements", 1 << 20, true)?;
    require(
        nv <= 4 * ne,
        "canonical vertex count exceeds tetrahedral support",
    )?;
    let mut elements = Vec::new();
    let mut element_keys = BTreeSet::new();
    let mut incidence = BTreeMap::<[u64; 3], Vec<usize>>::new();
    for element_index in 0..ne {
        let element = AcceptedChargeElement {
            attribute: reader.integer("attribute")?,
            vertex_ids: reader.ids()?,
            conductivity_spm: reader.real("conductivity_spm")?,
        };
        let key = sorted(element.vertex_ids);
        require(
            element.attribute > 0
                && element.attribute <= i32::MAX as u64
                && element.conductivity_spm > 0.0
                && key.windows(2).all(|pair| pair[0] < pair[1])
                && key.iter().all(|id| by_id.contains_key(id))
                && element_keys.insert(key),
            "canonical tetrahedron/material map is invalid",
        )?;
        for opposite in 0..4 {
            let mut face = [0; 3];
            let mut corner = 0;
            for (index, id) in key.iter().enumerate() {
                if index != opposite {
                    face[corner] = *id;
                    corner += 1;
                }
            }
            let neighbours = incidence.entry(face).or_default();
            neighbours.push(element_index);
            require(
                neighbours.len() <= 2,
                "canonical tetrahedral face is nonmanifold",
            )?;
        }
        elements.push(element);
    }
    let nb = reader.count("boundary", 4 * ne, true)?;
    let mut boundary = Vec::new();
    let mut boundary_keys = BTreeSet::new();
    for _ in 0..nb {
        let face = AcceptedChargeBoundary {
            attribute: reader.integer("attribute")?,
            vertex_ids: reader.ids()?,
        };
        let key = sorted(face.vertex_ids);
        require(
            face.attribute > 0
                && face.attribute <= i32::MAX as u64
                && incidence.get(&key).is_some_and(|owners| owners.len() == 1)
                && boundary_keys.insert(key),
            "canonical boundary does not identify a unique actual exterior face",
        )?;
        boundary.push(face);
    }
    require(
        incidence
            .iter()
            .all(|(key, owners)| owners.len() == 2 || boundary_keys.contains(key)),
        "canonical exterior boundary is incomplete",
    )?;
    let nf = reader.count("faces", 4 * ne, true)?;
    require(
        nf == incidence.len(),
        "canonical face count differs from tetrahedral incidence",
    )?;
    let mut faces = Vec::new();
    let mut face_keys = BTreeSet::new();
    let mut dofs = BTreeSet::new();
    for _ in 0..nf {
        let face = AcceptedChargeFace {
            vertex_ids: reader.ids()?,
            first_element: reader.integer("first_element")? as i64,
            second_element: reader.integer("second_element")? as i64,
            signed_rt0_dof: reader.integer("signed_rt0_dof")? as i64,
        };
        let key = sorted(face.vertex_ids);
        require(
            face_keys.insert(key) && incidence.contains_key(&key),
            "canonical face is repeated or absent from tetrahedral incidence",
        )?;
        let owners = &incidence[&key];
        require(
            face.first_element >= 0
                && face.first_element < ne as i64
                && owners.contains(&(face.first_element as usize))
                && ((owners.len() == 1 && face.second_element == -1)
                    || (owners.len() == 2
                        && face.second_element >= 0
                        && face.second_element < ne as i64
                        && face.second_element != face.first_element
                        && owners.contains(&(face.second_element as usize)))),
            "canonical face adjacency differs from element map",
        )?;
        // MFEM encodes a negatively oriented DOF as -1-index, not -index.
        let dof = if face.signed_rt0_dof < 0 {
            -(face.signed_rt0_dof as i128) - 1
        } else {
            face.signed_rt0_dof as i128
        };
        require(
            dof < nf as i128 && dofs.insert(dof),
            "canonical RT0 face-to-DOF map is not a bijection",
        )?;
        faces.push(face);
    }
    let nr = reader.count("rt0", nf, true)?;
    require(nr == nf, "canonical RT0 cardinality differs from its faces")?;
    let mut rt0_flux_a = Vec::new();
    for _ in 0..nr {
        rt0_flux_a.push(reader.real("rt0_flux_a")?);
    }
    let nt = reader.count("terminals", nb, true)?;
    let mut terminals = Vec::new();
    let mut terminal_ids = BTreeSet::new();
    let mut terminal_reference_index = BTreeMap::new();
    let mut terminal_faces = BTreeSet::new();
    for _ in 0..nt {
        let id = reader.text("terminal_id")?;
        require(
            terminal_ids.insert(id.clone()),
            "canonical terminal ID is repeated",
        )?;
        let count = reader.count("terminal_faces", nb - terminal_faces.len(), true)?;
        let mut keys = Vec::new();
        for _ in 0..count {
            let key: [u64; 3] = reader.ids()?;
            require(
                key[0] < key[1]
                    && key[1] < key[2]
                    && boundary_keys.contains(&key)
                    && terminal_faces.insert(key),
                "canonical terminal faces are not disjoint exterior keys",
            )?;
            keys.push(key);
        }
        let terminal = AcceptedChargeTerminalResult {
            id,
            faces: keys,
            requested_current_a: reader.real("requested_current_a")?,
            h1_current_a: reader.real("h1_current_a")?,
            h1_residual_a: reader.real("h1_residual_a")?,
            rt0_current_a: reader.real("rt0_current_a")?,
            rt0_residual_a: reader.real("rt0_residual_a")?,
            voltage_v: reader.real("terminal_voltage_v")?,
            component_id: reader.integer("terminal_component_id")?,
        };
        let gate = 1e-18 + 1e-8 * terminal.requested_current_a.abs();
        require(
            (terminal.h1_current_a - terminal.requested_current_a).abs() <= gate
                && (terminal.rt0_current_a - terminal.requested_current_a).abs() <= gate
                && terminal.h1_residual_a.abs() <= gate
                && (terminal.h1_residual_a
                    - (terminal.h1_current_a - terminal.requested_current_a))
                    .abs()
                    <= gate
                && (terminal.rt0_residual_a - (terminal.rt0_current_a - terminal.h1_current_a))
                    .abs()
                    <= gate,
            "canonical terminal currents failed their signed gate",
        )?;
        for id in terminal.faces.iter().flatten() {
            let vertex = &vertices[by_id[id]];
            let voltage_gate = policy[0]
                + policy[1].max(100.0 * policy[2])
                    * vertex.potential_v.abs().max(terminal.voltage_v.abs());
            require(
                voltage_gate.is_finite()
                    && vertex.component_id == terminal.component_id
                    && (vertex.potential_v - terminal.voltage_v).abs() <= voltage_gate,
                "canonical terminal voltage/component differs from its vertices",
            )?;
        }
        terminal_reference_index.insert(
            terminal.id.clone(),
            (terminal.component_id, terminal.voltage_v),
        );
        terminals.push(terminal);
    }
    let nref = reader.count("references", nt, true)?;
    let mut references = BTreeMap::new();
    for _ in 0..nref {
        let id = reader.text("terminal_id")?;
        let component = reader.integer("component_id")?;
        require(
            references.insert(component, id.clone()).is_none()
                && terminal_reference_index.get(&id).is_some_and(
                    |(terminal_component, voltage)| {
                        *terminal_component == component && voltage.abs() <= policy[0]
                    },
                ),
            "canonical terminal reference is missing, repeated or not zero",
        )?;
    }
    require(
        terminals
            .iter()
            .all(|terminal| references.contains_key(&terminal.component_id)),
        "canonical driven component lacks a terminal reference",
    )?;
    let nc = reader.count("components", nv, true)?;
    let mut components = BTreeSet::new();
    let mut component_records = Vec::new();
    for _ in 0..nc {
        let id = reader.integer("component_id")?;
        let residual = reader.real("component_relative_residual")?;
        require(
            by_id.contains_key(&id)
                && components.insert(id)
                && residual >= 0.0
                && residual <= policy[2],
            "canonical component/residual is invalid",
        )?;
        component_records.push(AcceptedChargeComponent {
            id,
            relative_residual: residual,
        });
    }
    require(
        vertices
            .iter()
            .map(|vertex| vertex.component_id)
            .collect::<BTreeSet<_>>()
            == components,
        "canonical component map is incomplete",
    )?;
    let ng = reader.count("gauges", nc, false)?;
    let mut gauges = BTreeSet::new();
    let mut gauge_records = Vec::new();
    for _ in 0..ng {
        let id = reader.integer("vertex_id")?;
        require(
            by_id.contains_key(&id)
                && gauges.insert(id)
                && vertices[by_id[&id]].potential_v.abs() <= policy[0],
            "canonical gauge is invalid",
        )?;
        gauge_records.push(id);
    }
    let ni = reader.count("interfaces", nb / 2, false)?;
    let mut interfaces = Vec::new();
    let mut interface_ids = BTreeSet::new();
    let mut interface_faces = BTreeSet::new();
    for _ in 0..ni {
        let id = reader.text("interface_id")?;
        let first: [u64; 3] = reader.ids()?;
        let second: [u64; 3] = reader.ids()?;
        let vertex_pairs = [reader.ids::<2>()?, reader.ids::<2>()?, reader.ids::<2>()?];
        require(
            interface_ids.insert(id.clone())
                && first[0] < first[1]
                && first[1] < first[2]
                && second[0] < second[1]
                && second[1] < second[2]
                && [first, second].iter().all(|face| {
                    boundary_keys.contains(face)
                        && !terminal_faces.contains(face)
                        && interface_faces.insert(*face)
                }),
            "canonical interface face identity is invalid",
        )?;
        require(
            sorted(vertex_pairs.map(|pair| pair[0])) == first
                && sorted(vertex_pairs.map(|pair| pair[1])) == second
                && vertex_pairs
                    .iter()
                    .all(|pair| vertices[by_id[&pair[0]]].xyz_m == vertices[by_id[&pair[1]]].xyz_m),
            "canonical typed interface is not an exact coincident bijection",
        )?;
        let interface = AcceptedChargeInterfaceResult {
            authored: AcceptedChargeInterface {
                id,
                first_face_vertex_ids: first,
                second_face_vertex_ids: second,
                vertex_pairs,
            },
            first_current_a: reader.real("first_current_a")?,
            second_current_a: reader.real("second_current_a")?,
            mismatch_a: reader.real("interface_mismatch_a")?,
        };
        let gate = 1e-18
            + 1e-8
                * interface
                    .first_current_a
                    .abs()
                    .max(interface.second_current_a.abs());
        require(
            (interface.first_current_a + interface.second_current_a).abs() <= gate
                && interface.mismatch_a.abs() <= gate
                && (interface.mismatch_a
                    - (interface.first_current_a + interface.second_current_a))
                    .abs()
                    <= gate,
            "canonical interface current mismatch",
        )?;
        interfaces.push(interface);
    }
    let rows = reader.integer("rows_before")?;
    let rank = reader.integer("rank")?;
    require(
        rows <= 1 << 20 && rank > 0 && rank <= rows && rank <= nf as u64,
        "canonical rank certificate exceeds support",
    )?;
    let omitted = reader.count("omitted", rows as usize, false)?;
    require(
        rank + omitted as u64 == rows,
        "canonical omitted-row cardinality mismatch",
    )?;
    let mut omitted_ids = BTreeSet::new();
    let mut omitted_rows = Vec::new();
    for _ in 0..omitted {
        let id = reader.text("constraint_id")?;
        let reason = reader.integer("omission_reason")?;
        let residual = reader.real("omitted_residual_a")?;
        let anchor: [u64; 4] = reader.ids()?;
        require(
            omitted_ids.insert(id.clone())
                && (reason == 1 || reason == 2)
                && ((reason == 2 && anchor == [0; 4])
                    || (reason == 1 && element_keys.contains(&anchor))),
            "canonical omitted-row identity/reason/anchor is invalid",
        )?;
        omitted_rows.push(AcceptedChargeOmission {
            constraint_id: id,
            reason,
            residual_a: residual,
            anchor_vertex_ids: anchor,
        });
    }
    require(
        reader.position == payload.len(),
        "trailing bytes after canonical accepted record",
    )?;
    Ok(AcceptedTerminalChargeRecord {
        canonical_payload: payload,
        content_sha256: expected_sha256.into(),
        policy,
        maximum_iterations,
        stable_vertex_version,
        vertices,
        elements,
        boundary,
        faces,
        rt0_flux_a,
        terminals,
        interfaces,
        constraint_rows: rows,
        constraint_rank: rank,
        references,
        components: component_records,
        gauges: gauge_records,
        omitted_rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Synthetic codec fixture, not an assertion that a native solve ran.
    struct Fixture(Vec<u8>);
    impl Fixture {
        fn field(&mut self, name: &str, tag: u8, bytes: &[u8]) {
            self.0.extend_from_slice(&(name.len() as u64).to_be_bytes());
            self.0.extend_from_slice(name.as_bytes());
            self.0.push(tag);
            self.0
                .extend_from_slice(&(bytes.len() as u64).to_be_bytes());
            self.0.extend_from_slice(bytes);
        }
        fn text(&mut self, name: &str, value: &str) {
            self.field(name, 1, value.as_bytes());
        }
        fn integer(&mut self, name: &str, value: u64) {
            self.field(name, 2, &value.to_be_bytes());
        }
        fn real(&mut self, name: &str, value: f64) {
            self.field(name, 4, &value.to_bits().to_be_bytes());
        }
        fn ids(&mut self, ids: &[u64]) {
            for id in ids {
                self.integer("vertex_id", *id);
            }
        }
    }
    fn zero_current_tetrahedron_payload() -> Vec<u8> {
        let mut f = Fixture(Vec::new());
        f.text("schema", DIGEST_SCHEMA);
        f.text("operator", OPERATOR_VERSION);
        for name in [
            "absolute_jump_tolerance_v",
            "relative_jump_tolerance",
            "algebraic_relative_tolerance",
        ] {
            f.real(name, 1e-12);
        }
        f.integer("maximum_iterations", 1000);
        f.integer("vertices", 4);
        f.text("stable_vertex_version", "stable_mesh_vertex_u64.v1");
        for (id, position) in [
            (11, [0.0, 0.0, 0.0]),
            (22, [1.0, 0.0, 0.0]),
            (33, [0.0, 1.0, 0.0]),
            (44, [0.0, 0.0, 1.0]),
        ] {
            f.integer("vertex_id", id);
            for xyz in position {
                f.real("xyz_m", xyz);
            }
            f.real("potential_v", 0.0);
            f.real("reaction_a", 0.0);
            f.integer("vertex_component_id", 11);
        }
        f.integer("elements", 1);
        f.integer("attribute", 7);
        f.ids(&[11, 22, 33, 44]);
        f.real("conductivity_spm", 4.0);
        let faces = [[11, 22, 33], [11, 22, 44], [11, 33, 44], [22, 33, 44]];
        f.integer("boundary", 4);
        for face in faces {
            f.integer("attribute", 1);
            f.ids(&face);
        }
        f.integer("faces", 4);
        for (index, face) in faces.iter().enumerate() {
            f.ids(face);
            f.integer("first_element", 0);
            f.integer("second_element", u64::MAX);
            f.integer("signed_rt0_dof", index as u64);
        }
        f.integer("rt0", 4);
        for _ in 0..4 {
            f.real("rt0_flux_a", 0.0);
        }
        f.integer("terminals", 1);
        f.text("terminal_id", "ground");
        f.integer("terminal_faces", 1);
        f.ids(&faces[0]);
        for name in [
            "requested_current_a",
            "h1_current_a",
            "h1_residual_a",
            "rt0_current_a",
            "rt0_residual_a",
            "terminal_voltage_v",
        ] {
            f.real(name, 0.0);
        }
        f.integer("terminal_component_id", 11);
        f.integer("references", 1);
        f.text("terminal_id", "ground");
        f.integer("component_id", 11);
        f.integer("components", 1);
        f.integer("component_id", 11);
        f.real("component_relative_residual", 0.0);
        f.integer("gauges", 0);
        f.integer("interfaces", 0);
        f.integer("rows_before", 5);
        f.integer("rank", 4);
        f.integer("omitted", 1);
        f.text("constraint_id", "divergence:11:22:33:44");
        f.integer("omission_reason", 1);
        f.real("omitted_residual_a", 0.0);
        f.ids(&[11, 22, 33, 44]);
        f.0
    }
    fn mutate_field(payload: &mut [u8], name: &str, occurrence: usize, replacement: &[u8]) {
        let mut position = 0;
        let mut seen = 0;
        while position < payload.len() {
            let name_len =
                u64::from_be_bytes(payload[position..position + 8].try_into().unwrap()) as usize;
            position += 8;
            let matches = &payload[position..position + name_len] == name.as_bytes();
            position += name_len + 1;
            let length =
                u64::from_be_bytes(payload[position..position + 8].try_into().unwrap()) as usize;
            position += 8;
            if matches {
                if seen == occurrence {
                    assert_eq!(length, replacement.len());
                    payload[position..position + length].copy_from_slice(replacement);
                    return;
                }
                seen += 1;
            }
            position += length;
        }
        panic!("fixture field missing: {name}/{occurrence}");
    }
    fn decode(payload: Vec<u8>) -> Result<AcceptedTerminalChargeRecord, RunError> {
        let hash = format!("{:x}", Sha256::digest(&payload));
        decode_accepted_terminal_charge_record(payload, &hash)
    }
    #[test]
    fn exact_hash_record_is_owned_and_decodes_all_maps() {
        let payload = zero_current_tetrahedron_payload();
        let record = decode(payload.clone()).unwrap();
        assert_eq!(record.canonical_payload, payload);
        assert_eq!(
            record
                .vertices
                .iter()
                .map(|vertex| vertex.id)
                .collect::<Vec<_>>(),
            [11, 22, 33, 44]
        );
        assert_eq!(record.elements[0].conductivity_spm, 4.0);
        assert_eq!(record.boundary.len(), 4);
        assert_eq!(record.faces.len(), 4);
        assert_eq!(record.rt0_flux_a, [0.0; 4]);
        assert_eq!(record.terminals[0].id, "ground");
        assert_eq!(record.references[&11], "ground");
        assert_eq!(record.components[0].id, 11);
        assert_eq!(record.components[0].relative_residual, 0.0);
        assert!(record.gauges.is_empty());
        assert_eq!(
            record.omitted_rows[0].constraint_id,
            "divergence:11:22:33:44"
        );
        assert_eq!(record.omitted_rows[0].reason, 1);
        assert_eq!(record.omitted_rows[0].residual_a, 0.0);
        assert_eq!(record.omitted_rows[0].anchor_vertex_ids, [11, 22, 33, 44]);
        assert_eq!(
            record.content_sha256,
            format!("{:x}", Sha256::digest(&record.canonical_payload))
        );
    }
    #[test]
    fn stale_noncanonical_and_trailing_hash_records_are_rejected() {
        let payload = zero_current_tetrahedron_payload();
        let hash = format!("{:x}", Sha256::digest(&payload));
        for digest in [
            String::new(),
            "00".repeat(32),
            hash.to_uppercase(),
            format!("sha256:{hash}"),
        ] {
            assert!(decode_accepted_terminal_charge_record(payload.clone(), &digest).is_err());
        }
        let mut changed = payload.clone();
        changed[0] ^= 1;
        assert!(decode_accepted_terminal_charge_record(changed, &hash).is_err());
        let mut trailing = payload.clone();
        trailing.push(0);
        assert!(decode(trailing).is_err());
        let mut truncated = payload;
        truncated.pop();
        assert!(decode(truncated).is_err());
    }
    #[test]
    fn self_consistent_hash_does_not_bypass_structural_or_current_gates() {
        let fixture = zero_current_tetrahedron_payload();
        for (name, occurrence, value) in [
            ("vertices", 0, u64::MAX),
            ("vertex_id", 0, 0),
            ("vertex_id", 1, 11),
            ("first_element", 0, 1),
            ("second_element", 0, 0),
            ("signed_rt0_dof", 1, 0),
            ("terminal_component_id", 0, 22),
            ("omission_reason", 0, 3),
            ("rank", 0, 5),
        ] {
            let mut payload = fixture.clone();
            mutate_field(&mut payload, name, occurrence, &value.to_be_bytes());
            assert!(
                decode(payload).is_err(),
                "accepted corrupted {name}/{occurrence}"
            );
        }
        for (name, value) in [
            ("conductivity_spm", -1.0f64),
            ("xyz_m", f64::NAN),
            ("potential_v", f64::INFINITY),
            ("reaction_a", -0.0),
            ("requested_current_a", 1.0),
            ("component_relative_residual", 1e-6),
            ("algebraic_relative_tolerance", 0.0),
        ] {
            let mut payload = fixture.clone();
            mutate_field(&mut payload, name, 0, &value.to_bits().to_be_bytes());
            assert!(decode(payload).is_err(), "accepted corrupted {name}");
        }
        for text in [b"\0round".as_slice(), b"\xffround".as_slice()] {
            let mut payload = fixture.clone();
            mutate_field(&mut payload, "terminal_id", 0, text);
            assert!(decode(payload).is_err());
        }
    }
}
