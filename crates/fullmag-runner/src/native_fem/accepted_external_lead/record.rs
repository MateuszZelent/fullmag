#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
use super::AcceptedExternalLeadRequest;
use super::{
    ExternalLeadBoundary, ExternalLeadBranch, ExternalLeadQuadraturePolicy, OPERATOR, SCHEMA, SCOPE,
};
#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
use crate::native_fem::accepted_terminal_charge::validate_record_inputs;
use crate::native_fem::accepted_terminal_charge::{
    record::{decode_accepted_terminal_charge_record, Reader},
    require, AcceptedTerminalChargeRecord,
};
use crate::types::RunError;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

#[derive(Debug)]
pub(crate) struct ExternalLeadComponentLedger {
    pub id: u64,
    pub currents_a: [f64; 3],
}
#[derive(Debug)]
pub(crate) struct ExternalLeadElementLedger {
    pub vertex_ids: [u64; 4],
    pub flux_sum_a: f64,
    pub absolute_flux_sum_a: f64,
}
#[derive(Debug)]
pub(crate) struct ExternalLeadFaceLedger {
    pub vertex_ids: [u64; 3],
    pub side_count: u64,
    pub rt0_to_canonical_weight: f64,
    pub canonical_flux_a: f64,
    pub outward_a: [f64; 2],
    pub canonical_jump_a: f64,
}
#[derive(Debug)]
pub(crate) struct ExternalLeadSourceRecord {
    pub canonical_range: Range<usize>,
    pub closure_revision: String,
    pub device_vertex_ids: Vec<u64>,
    pub lead_vertex_ids: Vec<u64>,
    pub boundary_faces: Vec<ExternalLeadBoundary>,
    pub branches: Vec<ExternalLeadBranch>,
    pub branch_h1_rt0_a: Vec<[f64; 2]>,
    pub components: Vec<ExternalLeadComponentLedger>,
    pub elements: Vec<ExternalLeadElementLedger>,
    pub faces: Vec<ExternalLeadFaceLedger>,
    // Terminal/interface measurements are checked exactly against retained charge rows.
    pub scaled_kkt_residual: f64,
    pub correction_norm_mw: f64,
}
#[derive(Debug)]
pub(crate) struct ExternalLeadTargetQuadratureDiagnostics {
    pub estimated_error_apm: f64,
    pub tolerance_apm: f64,
    pub roundoff_indicator_apm: f64,
    pub final_leaf_count: u64,
    pub kernel_evaluations: u64,
    pub ledger_leaf_visits: u64,
}
#[derive(Debug)]
pub(crate) struct ExternalLeadGlobalQuadratureDiagnostics {
    pub quadrature_scope: String,
    pub estimated_error_policy: String,
    pub roundoff_indicator_policy: String,
    pub maximum_final_leaves_per_target: u64,
    pub maximum_kernel_evaluations: u64,
    pub maximum_ledger_leaf_visits: u64,
    pub targets: Vec<ExternalLeadTargetQuadratureDiagnostics>,
    pub kernel_evaluations: u64,
    pub ledger_leaf_visits: u64,
}
#[derive(Debug)]
pub(crate) struct ExternalLeadFieldRecord {
    pub canonical_range: Range<usize>,
    pub quadrature_operator_version: String,
    pub quadrature: ExternalLeadQuadraturePolicy,
    pub targets_m: Vec<[f64; 3]>,
    pub relative_scale_floor_apm: f64,
    pub unconverged_pair_count: u64,
    // Legacy archives have no global-target diagnostic contract.
    pub global_quadrature: Option<ExternalLeadGlobalQuadratureDiagnostics>,
}

#[derive(Debug)]
pub(crate) struct AcceptedExternalLeadBundle {
    pub canonical_payload: Vec<u8>,
    pub content_sha256: String,
    pub charge: AcceptedTerminalChargeRecord,
    pub source_content_sha256: String,
    pub field_content_sha256: String,
    pub h_xyz_apm: Vec<[f64; 3]>,
    pub source_target_pairs: u64,
    pub refined_pairs: u64,
    pub maximum_pair_error_apm: f64,
    pub source: ExternalLeadSourceRecord,
    pub field: ExternalLeadFieldRecord,
}

fn hash(payload: &[u8], expected: &str) -> Result<(), RunError> {
    require(
        !payload.is_empty()
            && payload.len() <= super::MAX_PAYLOAD_BYTES
            && expected.len() == 64
            && expected
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            && format!("{:x}", Sha256::digest(payload)) == expected,
        "external lead canonical hash/bound mismatch",
    )
}

fn target_error_fits(error: f64, roundoff: f64, tolerance: f64) -> bool {
    // FastTwoSum retains the residual when the rounded sum lies on the gate.
    let larger = error.max(roundoff);
    let smaller = error.min(roundoff);
    let sum = larger + smaller;
    let residual = smaller - (sum - larger);
    sum < tolerance || (sum == tolerance && residual <= 0.0)
}

fn ids<const N: usize>(r: &mut Reader<'_>, name: &str) -> Result<[u64; N], RunError> {
    let mut result = [0; N];
    for id in &mut result {
        *id = r.integer(name)?;
    }
    Ok(result)
}

fn key<const N: usize>(mut ids: [u64; N]) -> [u64; N] {
    ids.sort_unstable();
    ids
}

fn current_gate(measured: f64, requested: f64) -> Result<(), RunError> {
    let gate = 1e-18 + 1e-8 * requested.abs();
    require(
        gate.is_finite() && (measured - requested).abs() <= gate,
        "external lead signed current gate failed",
    )
}

#[derive(Default)]
struct Sum {
    value: f64,
    correction: f64,
}
impl Sum {
    fn add(&mut self, value: f64) {
        let next = self.value + value;
        self.correction += if self.value.abs() >= value.abs() {
            (self.value - next) + value
        } else {
            (value - next) + self.value
        };
        self.value = next;
    }
    fn total(&self) -> f64 {
        self.value + self.correction
    }
    fn of(values: impl IntoIterator<Item = f64>) -> f64 {
        let mut sum = Self::default();
        for value in values {
            sum.add(value);
        }
        sum.total()
    }
}

fn local_gate(actual: f64, expected: f64, scale: f64) -> Result<(), RunError> {
    let gate = 1e-18 + 1e-10 * scale;
    require(
        actual.is_finite()
            && expected.is_finite()
            && scale.is_finite()
            && scale >= 0.0
            && gate.is_finite()
            && (actual - expected).abs() <= gate,
        "external lead signed physical ledger mismatch",
    )
}

fn signed_face_gate(canonical: f64, weight: f64, q: f64, scale: f64) -> Result<(), RunError> {
    require(
        weight.is_finite() && weight != 0.0,
        "external lead RT0 canonical weight is zero/nonfinite",
    )?;
    local_gate(canonical, weight * q, scale)
}

fn outward_sign(
    face: [u64; 3],
    element: [u64; 4],
    xyz: &BTreeMap<u64, [f64; 3]>,
) -> Result<f64, RunError> {
    let opposite = element
        .iter()
        .find(|id| !face.contains(id))
        .ok_or_else(|| RunError {
            message: "face lacks an opposite tetrahedral vertex".into(),
        })?;
    let a = xyz[&face[0]];
    let difference = |b: [f64; 3]| [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let b = difference(xyz[&face[1]]);
    let c = difference(xyz[&face[2]]);
    let d = difference(xyz[opposite]);
    // Positive scaling prevents overflow/underflow of the orientation-only scalar triple.
    let scale = b
        .into_iter()
        .chain(c)
        .chain(d)
        .map(f64::abs)
        .fold(0.0, f64::max);
    require(
        scale.is_finite() && scale > 0.0,
        "degenerate canonical face geometry",
    )?;
    let b = b.map(|v| v / scale);
    let c = c.map(|v| v / scale);
    let d = d.map(|v| v / scale);
    let triple = Sum::of([
        (b[1] * c[2] - b[2] * c[1]) * d[0],
        (b[2] * c[0] - b[0] * c[2]) * d[1],
        (b[0] * c[1] - b[1] * c[0]) * d[2],
    ]);
    require(
        triple.is_finite() && triple != 0.0,
        "degenerate canonical face orientation",
    )?;
    Ok(if triple < 0.0 { 1.0 } else { -1.0 })
}

fn validate_source_topology(
    charge: &AcceptedTerminalChargeRecord,
    device_ids: &[u64],
    lead_ids: &[u64],
    boundary: &BTreeMap<[u64; 3], (u64, String)>,
) -> Result<(), RunError> {
    let device = device_ids.iter().copied().collect::<BTreeSet<_>>();
    let lead = lead_ids.iter().copied().collect::<BTreeSet<_>>();
    let by_id = charge
        .vertices
        .iter()
        .enumerate()
        .map(|(i, v)| (v.id, i))
        .collect::<BTreeMap<_, _>>();
    let mut parents = (0..charge.elements.len()).collect::<Vec<_>>();
    let mut ranks = vec![0u8; parents.len()];
    fn root(parents: &mut [usize], mut i: usize) -> usize {
        while parents[i] != i {
            parents[i] = parents[parents[i]];
            i = parents[i];
        }
        i
    }
    fn join(parents: &mut [usize], ranks: &mut [u8], a: usize, b: usize) {
        let mut a = root(parents, a);
        let mut b = root(parents, b);
        if a == b {
            return;
        }
        if ranks[a] < ranks[b] {
            std::mem::swap(&mut a, &mut b);
        }
        parents[b] = a;
        if ranks[a] == ranks[b] {
            ranks[a] += 1;
        }
    }
    let mut used = BTreeSet::new();
    for element in &charge.elements {
        require(
            element.vertex_ids.iter().all(|id| device.contains(id))
                || element.vertex_ids.iter().all(|id| lead.contains(id)),
            "external partition splits a tetrahedron",
        )?;
        for id in element.vertex_ids {
            used.insert(id);
        }
    }
    require(
        used.len() == charge.vertices.len(),
        "external source has unused charge vertices",
    )?;
    let mut boundary_elements = BTreeMap::new();
    for face in &charge.faces {
        if face.second_element >= 0 {
            join(
                &mut parents,
                &mut ranks,
                face.first_element as usize,
                face.second_element as usize,
            );
        } else {
            boundary_elements.insert(key(face.vertex_ids), face.first_element as usize);
        }
    }
    let mut expected_roles = BTreeMap::new();
    let mut trace = BTreeSet::new();
    let coordinates = charge
        .vertices
        .iter()
        .map(|v| (v.id, v.xyz_m))
        .collect::<BTreeMap<_, _>>();
    for pair in &charge.interfaces {
        require(
            pair.authored
                .first_face_vertex_ids
                .iter()
                .all(|id| device.contains(id))
                && pair
                    .authored
                    .second_face_vertex_ids
                    .iter()
                    .all(|id| lead.contains(id)),
            "external interface must be first=device second=lead",
        )?;
        for face in [
            pair.authored.first_face_vertex_ids,
            pair.authored.second_face_vertex_ids,
        ] {
            require(
                expected_roles
                    .insert(face, (3, pair.authored.id.as_str()))
                    .is_none(),
                "external interface face repeats",
            )?;
            trace.extend(face);
        }
        // Use ONE physical triangle ordering on both sides. Independent sorted
        // stable-ID orientations can disagree even for a valid coincident interface.
        let mut second_in_first_order = [0; 3];
        for (i, first_id) in pair.authored.first_face_vertex_ids.iter().enumerate() {
            second_in_first_order[i] = pair
                .authored
                .vertex_pairs
                .iter()
                .find(|mapping| mapping[0] == *first_id)
                .ok_or_else(|| RunError {
                    message: "external interface lacks its explicit vertex map".into(),
                })?[1];
        }
        let xyz = |id: u64| charge.vertices[by_id[&id]].xyz_m;
        require(
            pair.authored.first_face_vertex_ids.map(xyz) == second_in_first_order.map(xyz),
            "external interface mapped physical triangle is not coincident",
        )?;
        let first_sign = outward_sign(
            pair.authored.first_face_vertex_ids,
            charge.elements[boundary_elements[&pair.authored.first_face_vertex_ids]].vertex_ids,
            &coordinates,
        )?;
        let second_sign = outward_sign(
            second_in_first_order,
            charge.elements[boundary_elements[&pair.authored.second_face_vertex_ids]].vertex_ids,
            &coordinates,
        )?;
        require(
            first_sign == -second_sign,
            "external interface tetrahedra occupy the same physical triangle side",
        )?;
        join(
            &mut parents,
            &mut ranks,
            boundary_elements[&pair.authored.first_face_vertex_ids],
            boundary_elements[&pair.authored.second_face_vertex_ids],
        );
    }
    let mut electrode_vertices = BTreeMap::new();
    for terminal in &charge.terminals {
        for face in &terminal.faces {
            require(
                face.iter().all(|id| lead.contains(id))
                    && expected_roles
                        .insert(*face, (2, terminal.id.as_str()))
                        .is_none(),
                "external electrode overlaps device/interface",
            )?;
            for id in face {
                require(
                    !trace.contains(id)
                        && electrode_vertices
                            .get(id)
                            .is_none_or(|old| *old == terminal.id.as_str()),
                    "external electrode shares trace/terminal DOFs",
                )?;
                electrode_vertices.insert(*id, terminal.id.as_str());
            }
        }
    }
    for (face, (role, circuit)) in boundary {
        require(
            expected_roles.get(face).copied().unwrap_or((1, "")) == (*role, circuit.as_str()),
            "external roles differ from actual charge groups",
        )?;
    }
    let mut label_roots = BTreeMap::new();
    let mut root_labels = BTreeMap::new();
    let mut component_support = BTreeMap::<usize, (bool, bool, usize, usize)>::new();
    for (i, element) in charge.elements.iter().enumerate() {
        let r = root(&mut parents, i);
        for id in element.vertex_ids {
            let label = charge.vertices[by_id[&id]].component_id;
            require(
                label_roots.get(&label).is_none_or(|old| *old == r)
                    && root_labels.get(&r).is_none_or(|old| *old == label),
                "external H1 components differ from physical graph",
            )?;
            label_roots.insert(label, r);
            root_labels.insert(r, label);
        }
        let support = component_support.entry(r).or_default();
        support.0 |= device.contains(&element.vertex_ids[0]);
        support.1 |= lead.contains(&element.vertex_ids[0]);
    }
    for terminal in &charge.terminals {
        let r = label_roots[&terminal.component_id];
        require(
            terminal
                .faces
                .iter()
                .all(|face| root(&mut parents, boundary_elements[face]) == r),
            "external electrode spans physical components",
        )?;
        component_support.get_mut(&r).unwrap().3 += 1;
    }
    for pair in &charge.interfaces {
        let r = root(
            &mut parents,
            boundary_elements[&pair.authored.first_face_vertex_ids],
        );
        component_support.get_mut(&r).unwrap().2 += 1;
    }
    require(
        component_support
            .values()
            .all(|(device, lead, pairs, terminals)| {
                *device && *lead && *pairs > 0 && *terminals >= 2
            }),
        "external physical component lacks device/lead/interface/two electrodes",
    )
}

fn decode_source(
    payload: &[u8],
    charge: &AcceptedTerminalChargeRecord,
) -> Result<ExternalLeadSourceRecord, RunError> {
    let mut r = Reader::new(payload);
    require(
        r.text("schema")? == "accepted_external_lead_current_source.ordered.v2"
            && r.text("operator_version")? == "fem_accepted_external_lead_current_source.v2"
            && r.text("field_scope")? == SCOPE
            && r.text("charge_content_digest")? == charge.content_sha256,
        "external lead finalizer identity differs from charge",
    )?;
    let closure_revision = r.text("closure_revision")?;
    require(
        r.real("absolute_current_gate_a")? == 1e-18
            && r.real("local_relative_gate")? == 1e-10
            && r.real("requested_current_relative_gate")? == 1e-8,
        "unknown external lead physical policy",
    )?;
    let mut partition = BTreeSet::new();
    let mut partitions = Vec::new();
    for (count_name, id_name) in [
        ("device_vertex_count", "device_vertex_id"),
        ("lead_vertex_count", "lead_vertex_id"),
    ] {
        let count = r.count(count_name, charge.vertices.len(), true)?;
        let mut values = Vec::new();
        let mut previous = 0;
        for _ in 0..count {
            let id = r.integer(id_name)?;
            require(
                id > previous && partition.insert(id),
                "external lead partition order/identity mismatch",
            )?;
            previous = id;
            values.push(id);
        }
        partitions.push(values);
    }
    require(
        partition == charge.vertices.iter().map(|v| v.id).collect(),
        "external lead partition omits charge vertices",
    )?;
    let lead_vertex_ids = partitions.pop().unwrap();
    let device_vertex_ids = partitions.pop().unwrap();
    let count = r.count("boundary_count", charge.boundary.len(), true)?;
    require(
        count == charge.boundary.len(),
        "external lead boundary cardinality mismatch",
    )?;
    let actual_boundary = charge
        .boundary
        .iter()
        .map(|b| key(b.vertex_ids))
        .collect::<BTreeSet<_>>();
    let mut boundary_faces = Vec::new();
    let mut expected_boundary = BTreeMap::new();
    for expected in actual_boundary {
        let actual_key = ids::<3>(&mut r, "boundary_vertex_id")?;
        let role = r.integer("boundary_role")?;
        require(
            actual_key == expected,
            "external lead boundary key/order differs from charge",
        )?;
        let actual = r.text_allow_empty("boundary_circuit_id")?;
        require(
            (role == 1 && actual.is_empty()) || ((role == 2 || role == 3) && !actual.is_empty()),
            "external lead boundary circuit/role is invalid",
        )?;
        expected_boundary.insert(expected, (role, actual.clone()));
        boundary_faces.push(ExternalLeadBoundary {
            vertex_ids: expected,
            role: role as u32,
            circuit_id: actual,
        });
    }
    let count = r.count("branch_count", charge.interfaces.len(), true)?;
    let mut branches = Vec::new();
    let mut branch_h1_rt0_a = Vec::new();
    let mut branch_ids = BTreeSet::new();
    let mut used_pairs = BTreeSet::new();
    let mut observed_vertices = BTreeSet::new();
    let by_vertex = charge
        .vertices
        .iter()
        .map(|v| (v.id, v))
        .collect::<BTreeMap<_, _>>();
    let by_interface = charge
        .interfaces
        .iter()
        .map(|pair| (pair.authored.id.as_str(), pair))
        .collect::<BTreeMap<_, _>>();
    for _ in 0..count {
        let branch_id = r.text("branch_id")?;
        require(
            branch_ids.insert(branch_id.clone()),
            "external lead branch ID is repeated",
        )?;
        let count = r.count("branch_pair_count", charge.interfaces.len(), true)?;
        let mut interface_pair_ids = Vec::new();
        let mut rt0 = Sum::default();
        let mut vertices = BTreeSet::new();
        for _ in 0..count {
            let id = r.text("branch_pair_id")?;
            require(
                interface_pair_ids
                    .last()
                    .is_none_or(|previous: &String| previous < &id)
                    && used_pairs.insert(id.clone()),
                "external lead branch interface order/partition mismatch",
            )?;
            let pair = by_interface.get(id.as_str()).ok_or_else(|| RunError {
                message: "external lead branch has a foreign interface".into(),
            })?;
            rt0.add(pair.first_current_a);
            vertices.extend(pair.authored.first_face_vertex_ids);
            interface_pair_ids.push(id);
        }
        require(
            vertices.iter().all(|id| observed_vertices.insert(*id)),
            "external branches share reaction DOFs",
        )?;
        let h1 = -Sum::of(vertices.iter().map(|id| by_vertex[id].reaction_a));
        let requested = r.real("branch_requested_a")?;
        let actual_h1 = r.real("branch_h1_a")?;
        let actual_rt0 = r.real("branch_rt0_a")?;
        current_gate(actual_h1, requested)?;
        current_gate(actual_rt0, requested)?;
        current_gate(actual_h1, h1)?;
        current_gate(actual_rt0, rt0.total())?;
        branches.push(ExternalLeadBranch {
            id: branch_id,
            interface_pair_ids,
            requested_device_outward_current_a: requested,
        });
        branch_h1_rt0_a.push([actual_h1, actual_rt0]);
    }
    require(
        used_pairs.len() == charge.interfaces.len(),
        "external branches omit interfaces",
    )?;
    validate_source_topology(
        charge,
        &device_vertex_ids,
        &lead_vertex_ids,
        &expected_boundary,
    )?;
    let mut component_minima = BTreeMap::<u64, u64>::new();
    for vertex in &charge.vertices {
        component_minima
            .entry(vertex.component_id)
            .and_modify(|minimum| *minimum = (*minimum).min(vertex.id))
            .or_insert(vertex.id);
    }
    let components = component_minima
        .into_iter()
        .map(|(label, minimum)| (minimum, label))
        .collect::<BTreeMap<_, _>>();
    require(
        r.count("component_count", components.len(), true)? == components.len(),
        "external lead component count mismatch",
    )?;
    let mut component_records = Vec::new();
    let mut component_sums = BTreeMap::<u64, ([Sum; 3], Sum)>::new();
    for terminal in &charge.terminals {
        let row = component_sums.entry(terminal.component_id).or_default();
        let currents = [
            terminal.requested_current_a,
            terminal.h1_current_a,
            terminal.rt0_current_a,
        ];
        for (sum, current) in row.0.iter_mut().zip(currents) {
            sum.add(current);
        }
        row.1
            .add(currents.into_iter().map(f64::abs).fold(0.0, f64::max));
    }
    for (minimum, id) in components {
        require(
            r.integer("component_id")? == minimum,
            "external lead component identity mismatch",
        )?;
        let mut currents_a = [0.0; 3];
        let sums = &component_sums[&id];
        for (index, name) in [
            "component_requested_sum_a",
            "component_h1_sum_a",
            "component_rt0_sum_a",
        ]
        .into_iter()
        .enumerate()
        {
            let measured = r.real(name)?;
            let expected = sums.0[index].total();
            let scale = sums.1.total();
            let gate = 1e-18 + 1e-10 * scale;
            require(
                gate.is_finite() && measured.abs() <= gate && (measured - expected).abs() <= gate,
                "external lead component balance mismatch",
            )?;
            currents_a[index] = measured;
        }
        component_records.push(ExternalLeadComponentLedger {
            id: minimum,
            currents_a,
        });
    }
    require(
        r.count("element_count", charge.elements.len(), true)? == charge.elements.len(),
        "external lead element count mismatch",
    )?;
    let elements = charge
        .elements
        .iter()
        .map(|element| key(element.vertex_ids))
        .collect::<BTreeSet<_>>();
    let mut element_ledger = BTreeMap::new();
    let mut element_records = Vec::new();
    for element in elements {
        require(
            ids::<4>(&mut r, "element_vertex_id")? == element,
            "external lead physical element map mismatch",
        )?;
        let sum = r.real("element_flux_sum_a")?;
        let scale = r.real("element_absolute_flux_sum_a")?;
        element_ledger.insert(element, (sum, scale));
        element_records.push(ExternalLeadElementLedger {
            vertex_ids: element,
            flux_sum_a: sum,
            absolute_flux_sum_a: scale,
        });
        require(
            scale >= 0.0
                && (1e-18 + 1e-10 * scale).is_finite()
                && sum.abs() <= 1e-18 + 1e-10 * scale,
            "external lead physical element balance gate failed",
        )?;
    }
    require(
        r.count("face_count", charge.faces.len(), true)? == charge.faces.len(),
        "external lead physical face count mismatch",
    )?;
    let faces = charge
        .faces
        .iter()
        .map(|face| (key(face.vertex_ids), face))
        .collect::<BTreeMap<_, _>>();
    let xyz = charge
        .vertices
        .iter()
        .map(|v| (v.id, v.xyz_m))
        .collect::<BTreeMap<_, _>>();
    let mut element_aggregates = BTreeMap::<[u64; 4], (Sum, Sum)>::new();
    let mut boundary_outward = BTreeMap::new();
    let mut face_records = Vec::new();
    for (face_key, face) in faces {
        require(
            ids::<3>(&mut r, "face_vertex_id")? == face_key,
            "external lead physical face map mismatch",
        )?;
        let sides = r.integer("face_side_count")?;
        let weight = r.real("face_rt0_to_canonical_weight")?;
        require(
            sides == if face.second_element < 0 { 1 } else { 2 },
            "external lead physical face adjacency mismatch",
        )?;
        let canonical = r.real("face_canonical_flux_a")?;
        let first = r.real("face_first_outward_a")?;
        let second = r.real("face_second_outward_a")?;
        let jump = r.real("face_canonical_jump_a")?;
        face_records.push(ExternalLeadFaceLedger {
            vertex_ids: face_key,
            side_count: sides,
            rt0_to_canonical_weight: weight,
            canonical_flux_a: canonical,
            outward_a: [first, second],
            canonical_jump_a: jump,
        });
        let first_element = key(charge.elements[face.first_element as usize].vertex_ids);
        let second_element = (face.second_element >= 0)
            .then(|| key(charge.elements[face.second_element as usize].vertex_ids));
        let scale = second_element.map_or(element_ledger[&first_element].1, |second| {
            Sum::of([element_ledger[&first_element].1, element_ledger[&second].1])
        });
        let dof = if face.signed_rt0_dof < 0 {
            (-1i128 - face.signed_rt0_dof as i128) as usize
        } else {
            face.signed_rt0_dof as usize
        };
        signed_face_gate(canonical, weight, charge.rt0_flux_a[dof], scale)?;
        let swapped = second_element.is_some_and(|element| element < first_element);
        let actual_first = if swapped { second } else { first };
        let actual_second = if swapped { first } else { second };
        local_gate(
            actual_first,
            outward_sign(face_key, first_element, &xyz)? * canonical,
            scale,
        )?;
        if let Some(second_element) = second_element {
            require(
                outward_sign(face_key, first_element, &xyz)?
                    == -outward_sign(face_key, second_element, &xyz)?,
                "interior tetrahedra occupy the same face side",
            )?;
            local_gate(
                actual_second,
                outward_sign(face_key, second_element, &xyz)? * (canonical - jump),
                scale,
            )?;
            local_gate(jump, 0.0, scale)?;
            local_gate(Sum::of([actual_first, actual_second]), 0.0, scale)?;
            let row = element_aggregates.entry(second_element).or_default();
            row.0.add(actual_second);
            row.1.add(actual_second.abs());
        } else {
            require(
                second == 0.0 && jump == 0.0,
                "exterior face has a fictitious second side",
            )?;
            boundary_outward.insert(face_key, actual_first);
            if expected_boundary[&face_key].0 == 1 {
                local_gate(actual_first, 0.0, element_ledger[&first_element].1)?;
            }
        }
        let row = element_aggregates.entry(first_element).or_default();
        row.0.add(actual_first);
        row.1.add(actual_first.abs());
    }
    for (key, (sum, scale)) in &element_ledger {
        let aggregate = element_aggregates.get(key).ok_or_else(|| RunError {
            message: "element lacks actual face flux aggregation".into(),
        })?;
        local_gate(aggregate.0.total(), *sum, *scale)?;
        local_gate(aggregate.1.total(), *scale, *scale)?;
    }
    require(
        r.count("terminal_count", charge.terminals.len(), true)? == charge.terminals.len(),
        "external lead terminal count mismatch",
    )?;
    for terminal in &charge.terminals {
        require(
            r.text("terminal_id")? == terminal.id
                && r.real("terminal_requested_a")? == terminal.requested_current_a
                && r.real("terminal_h1_a")? == terminal.h1_current_a
                && r.real("terminal_rt0_a")? == terminal.rt0_current_a,
            "external lead terminal measurements differ from accepted charge",
        )?;
        let measured = Sum::of(terminal.faces.iter().map(|face| boundary_outward[face]));
        current_gate(measured, terminal.rt0_current_a)?;
        let vertices = terminal
            .faces
            .iter()
            .flatten()
            .copied()
            .collect::<BTreeSet<_>>();
        current_gate(
            -Sum::of(vertices.iter().map(|id| by_vertex[id].reaction_a)),
            terminal.h1_current_a,
        )?;
    }
    require(
        r.count("interface_count", charge.interfaces.len(), true)? == charge.interfaces.len(),
        "external lead interface count mismatch",
    )?;
    for pair in &charge.interfaces {
        require(
            r.text("interface_id")? == pair.authored.id
                && r.real("interface_first_outward_a")? == pair.first_current_a
                && r.real("interface_second_outward_a")? == pair.second_current_a
                && r.real("interface_mismatch_a")? == pair.mismatch_a,
            "external lead interface measurements differ from accepted charge",
        )?;
        let first = boundary_outward[&pair.authored.first_face_vertex_ids];
        let second = boundary_outward[&pair.authored.second_face_vertex_ids];
        let scale = first.abs() + second.abs();
        local_gate(first, pair.first_current_a, scale)?;
        local_gate(second, pair.second_current_a, scale)?;
        local_gate(Sum::of([first, second]), pair.mismatch_a, scale)?;
    }
    let expected_rows = charge
        .elements
        .len()
        .checked_add(charge.interfaces.len())
        .and_then(|rows| rows.checked_add(charge.terminals.len()));
    require(
        expected_rows.is_some_and(|rows| rows as u64 == charge.constraint_rows)
            && r.integer("constraint_rows")? == charge.constraint_rows
            && r.integer("constraint_rank")? == charge.constraint_rank,
        "external lead constraint ledger differs from accepted charge",
    )?;
    let residual = r.real("scaled_kkt_residual")?;
    let correction = r.real("correction_norm_mw")?;
    require(
        residual >= 0.0 && correction >= 0.0,
        "external lead projection diagnostics failed",
    )?;
    r.finish()?;
    Ok(ExternalLeadSourceRecord {
        canonical_range: 0..payload.len(),
        closure_revision,
        device_vertex_ids,
        lead_vertex_ids,
        boundary_faces,
        branches,
        branch_h1_rt0_a,
        components: component_records,
        elements: element_records,
        faces: face_records,
        scaled_kkt_residual: residual,
        correction_norm_mw: correction,
    })
}

pub(crate) fn decode_owned_bundle(
    payload: Vec<u8>,
    sha: &str,
) -> Result<AcceptedExternalLeadBundle, RunError> {
    hash(&payload, sha)?;
    let mut r = Reader::new(&payload);
    require(
        r.text("schema")? == SCHEMA
            && r.text("operator_version")? == OPERATOR
            && r.text("field_scope")? == SCOPE,
        "external lead bundle schema/operator/scope mismatch",
    )?;
    let charge_sha = r.text("charge_content_sha256")?;
    let charge_bytes = r.field("charge_record", 3)?;
    hash(charge_bytes, &charge_sha)?;
    let charge = decode_accepted_terminal_charge_record(charge_bytes.to_vec(), &charge_sha)?;
    let source_sha = r.text("source_content_sha256")?;
    let source_bytes = r.field("source_record", 3)?;
    hash(source_bytes, &source_sha)?;
    let mut source = decode_source(source_bytes, &charge)?;
    source.canonical_range = r.position() - source_bytes.len()..r.position();
    let field_sha = r.text("field_content_sha256")?;
    let field_bytes = r.field("field_record", 3)?;
    hash(field_bytes, &field_sha)?;
    let field_range = r.position() - field_bytes.len()..r.position();
    r.finish()?;
    let mut field = Reader::new(field_bytes);
    let field_schema = field.text("schema")?;
    let field_operator_version = field.text("operator_version")?;
    let quadrature_operator_version = field.text("quadrature_operator_version")?;
    let global_target = match (
        field_schema.as_str(),
        field_operator_version.as_str(),
        quadrature_operator_version.as_str(),
    ) {
        (
            "accepted_external_lead_field.ordered.v1",
            "fem_accepted_external_lead_field.v1",
            "fem_oersted_direct_tetra_quadrature.v1" | "fem_oersted_direct_tetra_quadrature.v2",
        ) => false,
        (
            "accepted_external_lead_field.ordered.v2",
            "fem_accepted_external_lead_field.v2",
            "fem_oersted_direct_tetra_quadrature.v3",
        ) => true,
        _ => {
            return Err(RunError {
                message: "external lead field schema/operator mismatch".into(),
            });
        }
    };
    require(
        field.text("field_scope")? == SCOPE
            && field.text("accepted_external_source_digest")? == source_sha
            && field.text("charge_content_digest")? == charge_sha,
        "external lead field source/operator mismatch",
    )?;
    let base_order = field.integer("base_quadrature_order")?;
    let maximum_depth = field.integer("maximum_subdivision_depth")?;
    let absolute_tolerance_apm = field.real("absolute_tolerance_apm")?;
    let relative_tolerance = field.real("relative_tolerance")?;
    let relative_scale_floor_apm = field.real("relative_scale_floor_apm")?;
    let maximum_source_target_pairs = field.integer("maximum_source_target_pairs")?;
    require(
        (2..=16).contains(&base_order)
            && maximum_depth <= 6
            && absolute_tolerance_apm >= 0.0
            && relative_tolerance >= 0.0
            && relative_scale_floor_apm == if global_target { 0.0 } else { 1.0 }
            && (1..=1_000_000).contains(&maximum_source_target_pairs),
        "external lead field policy exceeds bounded support",
    )?;
    let p = ExternalLeadQuadraturePolicy {
        base_quadrature_order: base_order as i32,
        maximum_subdivision_depth: maximum_depth as i32,
        absolute_tolerance_apm,
        relative_tolerance,
        maximum_source_target_pairs,
    };
    let mut global_quadrature = if global_target {
        let diagnostics = ExternalLeadGlobalQuadratureDiagnostics {
            quadrature_scope: field.text("quadrature_scope")?,
            estimated_error_policy: field.text("estimated_error_policy")?,
            roundoff_indicator_policy: field.text("roundoff_indicator_policy")?,
            maximum_final_leaves_per_target: field.integer("maximum_final_leaves_per_target")?,
            maximum_kernel_evaluations: field.integer("maximum_kernel_evaluations")?,
            maximum_ledger_leaf_visits: field.integer("maximum_ledger_leaf_visits")?,
            targets: Vec::new(),
            kernel_evaluations: 0,
            ledger_leaf_visits: 0,
        };
        require(
            diagnostics.quadrature_scope == "global_target"
                && diagnostics.estimated_error_policy == "sum_final_leaf_l2_difference.v1"
                && diagnostics.roundoff_indicator_policy == "weighted_terms_binary64_epsilon.v1"
                && diagnostics.maximum_final_leaves_per_target == 1_000_000
                && diagnostics.maximum_kernel_evaluations == 100_000_000
                && diagnostics.maximum_ledger_leaf_visits == 100_000_000,
            "external lead global quadrature policy exceeds bounded support",
        )?;
        Some(diagnostics)
    } else {
        None
    };
    let count = field.count(
        "target_count",
        (maximum_source_target_pairs as usize) / charge.elements.len(),
        false,
    )?;
    let mut targets_m = Vec::new();
    let mut h_xyz_apm = Vec::new();
    for _ in 0..count {
        targets_m.push([
            field.real("target_coordinate_m")?,
            field.real("target_coordinate_m")?,
            field.real("target_coordinate_m")?,
        ]);
        let h = [
            field.real("h_component_apm")?,
            field.real("h_component_apm")?,
            field.real("h_component_apm")?,
        ];
        h_xyz_apm.push(h);
        if let Some(global) = &mut global_quadrature {
            let target = ExternalLeadTargetQuadratureDiagnostics {
                estimated_error_apm: field.real("target_estimated_error_apm")?,
                tolerance_apm: field.real("target_tolerance_apm")?,
                roundoff_indicator_apm: field.real("target_roundoff_indicator_apm")?,
                final_leaf_count: field.integer("target_final_leaf_count")?,
                kernel_evaluations: field.integer("target_kernel_evaluations")?,
                ledger_leaf_visits: field.integer("target_ledger_leaf_visits")?,
            };
            let tolerance =
                relative_tolerance.mul_add(h[0].hypot(h[1]).hypot(h[2]), absolute_tolerance_apm);
            let source_count = charge.elements.len() as u64;
            require(
                tolerance.is_finite()
                    && target.estimated_error_apm >= 0.0
                    && target.roundoff_indicator_apm >= 0.0
                    && target.tolerance_apm >= 0.0
                    && target.tolerance_apm == tolerance
                    && target_error_fits(
                        target.estimated_error_apm,
                        target.roundoff_indicator_apm,
                        tolerance,
                    )
                    && (source_count..=global.maximum_final_leaves_per_target)
                        .contains(&target.final_leaf_count)
                    && (2 * source_count..=global.maximum_kernel_evaluations)
                        .contains(&target.kernel_evaluations)
                    && (source_count..=global.maximum_ledger_leaf_visits)
                        .contains(&target.ledger_leaf_visits),
                "external lead global target diagnostics/tolerance mismatch",
            )?;
            global.targets.push(target);
        }
    }
    let source_target_pairs = field.integer("source_target_pairs")?;
    let refined_pairs = field.integer("refined_pairs")?;
    let unconverged_pair_count = field.integer("unconverged_pair_count")?;
    require(
        unconverged_pair_count == 0,
        "external lead quadrature did not converge",
    )?;
    let maximum_pair_error_apm = field.real("maximum_pair_error_apm")?;
    // Each refinement replaces a tetrahedron by eight children, up to the recorded depth.
    let maximum_refinements_per_pair = (8u64.pow(maximum_depth as u32) - 1) / 7;
    require(
        charge
            .elements
            .len()
            .checked_mul(targets_m.len())
            .is_some_and(|n| n as u64 == source_target_pairs)
            && source_target_pairs <= p.maximum_source_target_pairs
            && refined_pairs <= source_target_pairs * maximum_refinements_per_pair
            && (source_target_pairs > 0 || maximum_pair_error_apm == 0.0)
            && maximum_pair_error_apm >= 0.0,
        "external lead quadrature diagnostics/cardinality mismatch",
    )?;
    if let Some(global) = &mut global_quadrature {
        global.kernel_evaluations = field.integer("kernel_evaluations")?;
        global.ledger_leaf_visits = field.integer("ledger_leaf_visits")?;
        let totals = global.targets.iter().try_fold([0u64; 3], |sum, target| {
            Some([
                sum[0].checked_add(target.final_leaf_count)?,
                sum[1].checked_add(target.kernel_evaluations)?,
                sum[2].checked_add(target.ledger_leaf_visits)?,
            ])
        });
        let expected_leaves = refined_pairs
            .checked_mul(7)
            .and_then(|n| source_target_pairs.checked_add(n));
        require(
            totals.is_some_and(|sum| {
                Some(sum[0]) == expected_leaves
                    && sum[1] == global.kernel_evaluations
                    && sum[2] == global.ledger_leaf_visits
            }) && global.kernel_evaluations <= global.maximum_kernel_evaluations
                && global.ledger_leaf_visits <= global.maximum_ledger_leaf_visits,
            "external lead global quadrature work/leaf totals mismatch",
        )?;
    }
    field.finish()?;
    Ok(AcceptedExternalLeadBundle {
        canonical_payload: payload,
        content_sha256: sha.into(),
        charge,
        source_content_sha256: source_sha,
        field_content_sha256: field_sha,
        h_xyz_apm,
        source_target_pairs,
        refined_pairs,
        maximum_pair_error_apm,
        source,
        field: ExternalLeadFieldRecord {
            canonical_range: field_range,
            quadrature_operator_version,
            quadrature: p,
            targets_m,
            relative_scale_floor_apm,
            unconverged_pair_count,
            global_quadrature,
        },
    })
}

// Intent binding is deliberately separate: no request is synthesized from a result.
#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
pub(crate) fn validate_bundle_request(
    bundle: &AcceptedExternalLeadBundle,
    request: &AcceptedExternalLeadRequest<'_>,
) -> Result<(), RunError> {
    super::preflight(request)?;
    bind_preflighted_request(bundle, request)
}

#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
fn bind_preflighted_request(
    bundle: &AcceptedExternalLeadBundle,
    request: &AcceptedExternalLeadRequest<'_>,
) -> Result<(), RunError> {
    validate_record_inputs(&bundle.charge, &request.charge)?;
    let source = &bundle.source;
    require(
        source.closure_revision == request.closure_revision
            && source
                .device_vertex_ids
                .iter()
                .copied()
                .collect::<BTreeSet<_>>()
                == request.device_vertex_ids.iter().copied().collect()
            && source
                .lead_vertex_ids
                .iter()
                .copied()
                .collect::<BTreeSet<_>>()
                == request.lead_vertex_ids.iter().copied().collect(),
        "external source closure/partitions differ from request",
    )?;
    let expected_boundary = request
        .boundary_faces
        .iter()
        .map(|b| (b.vertex_ids, (b.role, b.circuit_id.as_str())))
        .collect::<BTreeMap<_, _>>();
    require(
        expected_boundary.len() == request.boundary_faces.len()
            && expected_boundary.len() == source.boundary_faces.len()
            && source.boundary_faces.iter().all(|b| {
                expected_boundary.get(&b.vertex_ids) == Some(&(b.role, b.circuit_id.as_str()))
            }),
        "external boundary differs from request",
    )?;
    require(
        source.branches.len() == request.branches.len(),
        "external branch count differs from request",
    )?;
    for (actual, expected) in source.branches.iter().zip(request.branches) {
        let mut pairs = expected.interface_pair_ids.clone();
        pairs.sort_unstable();
        require(
            actual.id == expected.id
                && actual.interface_pair_ids == pairs
                && actual.requested_device_outward_current_a
                    == expected.requested_device_outward_current_a,
            "external branch differs from request",
        )?;
    }
    let p = bundle.field.quadrature;
    let expected = request.quadrature;
    require(
        bundle.field.quadrature_operator_version
            == fullmag_ir::ANTENNA_DIRECT_OERSTED_OPERATOR_VERSION
            && p.base_quadrature_order == expected.base_quadrature_order
            && p.maximum_subdivision_depth == expected.maximum_subdivision_depth
            && p.absolute_tolerance_apm == expected.absolute_tolerance_apm
            && p.relative_tolerance == expected.relative_tolerance
            && p.maximum_source_target_pairs == expected.maximum_source_target_pairs
            && bundle.field.targets_m == request.targets_m,
        "external field targets/policy differ from request",
    )
}

#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
pub(super) fn decode_bundle(
    payload: Vec<u8>,
    sha: &str,
    request: &AcceptedExternalLeadRequest<'_>,
) -> Result<AcceptedExternalLeadBundle, RunError> {
    super::preflight(request)?;
    let bundle = decode_owned_bundle(payload, sha)?;
    bind_preflighted_request(&bundle, request)?;
    Ok(bundle)
}

#[cfg(all(test, any(feature = "fem-native", feature = "fem-gpu")))]
#[path = "bundle_tests.rs"]
mod tests;

#[cfg(all(test, any(feature = "fem-native", feature = "fem-gpu")))]
pub(crate) use tests::inspection_test_bundle;

#[cfg(test)]
mod pure_codec_tests {
    use super::*;

    #[test]
    fn owned_codec_refuses_empty_or_unframed_bytes_without_a_native_request() {
        let empty_hash = format!("{:x}", Sha256::digest([]));
        assert!(decode_owned_bundle(Vec::new(), &empty_hash).is_err());
        let bytes = b"not a canonical bundle".to_vec();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        assert!(decode_owned_bundle(bytes, &hash).is_err());
    }
}
