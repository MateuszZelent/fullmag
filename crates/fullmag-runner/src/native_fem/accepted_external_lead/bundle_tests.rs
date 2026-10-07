use super::*;
use crate::native_fem::accepted_external_lead::{
    ExternalLeadBoundary, ExternalLeadBranch, ExternalLeadQuadraturePolicy,
};
use crate::native_fem::accepted_terminal_charge::{
    AcceptedChargeInterface, AcceptedChargeTerminal, AcceptedTerminalChargeRequest,
};
use fullmag_ir::MeshIR;

// Independent scientific codec fixture; it does not claim a native solve ran.
#[derive(Default)]
struct Bytes(Vec<u8>);
impl Bytes {
    fn field(&mut self, name: &str, tag: u8, value: &[u8]) {
        self.0.extend_from_slice(&(name.len() as u64).to_be_bytes());
        self.0.extend_from_slice(name.as_bytes());
        self.0.push(tag);
        self.0
            .extend_from_slice(&(value.len() as u64).to_be_bytes());
        self.0.extend_from_slice(value);
    }
    fn text(&mut self, name: &str, value: &str) {
        self.field(name, 1, value.as_bytes());
    }
    fn integer(&mut self, name: &str, value: u64) {
        self.field(name, 2, &value.to_be_bytes());
    }
    fn real(&mut self, name: &str, value: f64) {
        let canonical = if value == 0.0 { 0.0 } else { value };
        self.field(name, 4, &canonical.to_bits().to_be_bytes());
    }
    fn ids(&mut self, name: &str, ids: &[u64]) {
        for id in ids {
            self.integer(name, *id);
        }
    }
}

struct Fixture {
    mesh: MeshIR,
    stable: Vec<u64>,
    sigma: Vec<f64>,
    terminals: Vec<AcceptedChargeTerminal>,
    interfaces: Vec<AcceptedChargeInterface>,
    boundary: Vec<ExternalLeadBoundary>,
    branches: Vec<ExternalLeadBranch>,
    device: Vec<u64>,
    lead: Vec<u64>,
    targets: Vec<[f64; 3]>,
    elements: Vec<[u64; 4]>,
    faces: BTreeMap<[u64; 3], Vec<usize>>,
    reactions: BTreeMap<u64, f64>,
}
impl Fixture {
    fn new() -> Self {
        let local = [
            [0, 1, 2, 6],
            [0, 2, 3, 6],
            [0, 3, 7, 6],
            [0, 7, 4, 6],
            [0, 4, 5, 6],
            [0, 5, 1, 6],
        ];
        let mut nodes = Vec::new();
        let mut cells = Vec::new();
        let mut stable = Vec::new();
        for (cube, (x, base)) in [(0., 1u64), (-1., 101), (1., 201)].into_iter().enumerate() {
            nodes.extend([
                [x, 0., 0.],
                [x + 1., 0., 0.],
                [x + 1., 1., 0.],
                [x, 1., 0.],
                [x, 0., 1.],
                [x + 1., 0., 1.],
                [x + 1., 1., 1.],
                [x, 1., 1.],
            ]);
            stable.extend(base..base + 8);
            cells.extend(local.map(|cell| cell.map(|node| node + 8 * cube as u32)));
        }
        let elements = cells
            .iter()
            .map(|cell| cell.map(|node| stable[node as usize]))
            .collect::<Vec<_>>();
        let mut faces = BTreeMap::<[u64; 3], Vec<usize>>::new();
        for (element, ids) in elements.iter().enumerate() {
            for opposite in 0..4 {
                let face = key(std::array::from_fn(|i| {
                    ids[if i < opposite { i } else { i + 1 }]
                }));
                faces.entry(face).or_default().push(element);
            }
        }
        let xyz = stable
            .iter()
            .copied()
            .zip(nodes.iter().copied())
            .collect::<BTreeMap<_, _>>();
        let exterior = faces
            .iter()
            .filter(|(_, owners)| owners.len() == 1)
            .map(|(key, _)| *key)
            .collect::<Vec<_>>();
        let at_x = |face: &[u64; 3], x: f64| face.iter().all(|id| xyz[id][0] == x);
        let on_cube =
            |face: &[u64; 3], lo: u64, hi: u64| face.iter().all(|id| (*id >= lo) && (*id < hi));
        let terminals = vec![
            AcceptedChargeTerminal {
                id: "ground".into(),
                boundary_face_vertex_ids: exterior
                    .iter()
                    .filter(|face| on_cube(face, 101, 109) && at_x(face, -1.))
                    .copied()
                    .collect(),
                requested_outward_current_a: -1.,
            },
            AcceptedChargeTerminal {
                id: "drain".into(),
                boundary_face_vertex_ids: exterior
                    .iter()
                    .filter(|face| on_cube(face, 201, 209) && at_x(face, 2.))
                    .copied()
                    .collect(),
                requested_outward_current_a: 1.,
            },
        ];
        let mut interfaces = Vec::new();
        for (x, lo, hi) in [(0., 101, 109), (1., 201, 209)] {
            for first in exterior
                .iter()
                .filter(|face| on_cube(face, 1, 9) && at_x(face, x))
            {
                let second = *exterior
                    .iter()
                    .find(|face| {
                        on_cube(face, lo, hi)
                            && face
                                .iter()
                                .all(|id| first.iter().any(|first| xyz[first] == xyz[id]))
                    })
                    .unwrap();
                let vertex_pairs = first.map(|id| {
                    [
                        id,
                        *second
                            .iter()
                            .find(|second| xyz[second] == xyz[&id])
                            .unwrap(),
                    ]
                });
                interfaces.push(AcceptedChargeInterface {
                    id: format!("join-{}-{}", x as i32, interfaces.len()),
                    first_face_vertex_ids: *first,
                    second_face_vertex_ids: second,
                    vertex_pairs,
                });
            }
        }
        let boundary = exterior
            .iter()
            .map(|face| {
                let interface = interfaces.iter().find(|pair| {
                    pair.first_face_vertex_ids == *face || pair.second_face_vertex_ids == *face
                });
                let terminal = terminals
                    .iter()
                    .find(|terminal| terminal.boundary_face_vertex_ids.contains(face));
                let (role, circuit_id) = if let Some(pair) = interface {
                    (3, pair.id.clone())
                } else if let Some(t) = terminal {
                    (2, t.id.clone())
                } else {
                    (1, String::new())
                };
                ExternalLeadBoundary {
                    vertex_ids: *face,
                    role,
                    circuit_id,
                }
            })
            .collect();
        let branches = [("left", 0., -1.), ("right", 1., 1.)]
            .into_iter()
            .map(|(id, x, current)| ExternalLeadBranch {
                id: id.into(),
                interface_pair_ids: interfaces
                    .iter()
                    .filter(|pair| at_x(&pair.first_face_vertex_ids, x))
                    .map(|pair| pair.id.clone())
                    .collect(),
                requested_device_outward_current_a: current,
            })
            .collect();
        let local_by_id = stable
            .iter()
            .enumerate()
            .map(|(local, id)| (*id, local as u32))
            .collect::<BTreeMap<_, _>>();
        let boundary_local = exterior
            .iter()
            .map(|face| face.map(|id| local_by_id[&id]))
            .collect::<Vec<_>>();
        let mesh = MeshIR::from_legacy_tet4(
            "three-cube-codec".into(),
            nodes,
            cells,
            vec![1; 18],
            boundary_local,
            vec![1; 36],
            vec![],
            vec![],
            Default::default(),
        );
        let mut reactions = stable
            .iter()
            .map(|id| (*id, Sum::default()))
            .collect::<BTreeMap<_, _>>();
        for face in &exterior {
            let a = xyz[&face[0]];
            let b = xyz[&face[1]];
            let c = xyz[&face[2]];
            let canonical = 0.5 * ((b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]));
            let flux = canonical * outward_sign(*face, elements[faces[face][0]], &xyz).unwrap();
            for id in face {
                reactions.get_mut(id).unwrap().add(-flux / 3.);
            }
        }
        Self {
            mesh,
            stable,
            sigma: vec![1.; 18],
            terminals,
            interfaces,
            boundary,
            branches,
            device: (1..9).rev().collect(),
            lead: (101..109).chain(201..209).rev().collect(),
            targets: vec![[3., 0.5, 0.5]],
            elements,
            faces,
            reactions: reactions
                .into_iter()
                .map(|(id, sum)| (id, sum.total()))
                .collect(),
        }
    }
    fn request(&self) -> AcceptedExternalLeadRequest<'_> {
        AcceptedExternalLeadRequest {charge:AcceptedTerminalChargeRequest {mesh:&self.mesh,
            execution_lane:fullmag_fem_sys::fullmag_fem_steady_transport_execution_lane::FULLMAG_FEM_STEADY_TRANSPORT_CPU_DOUBLE,
            stable_vertex_version:"stable_mesh_vertex_u64.v1",stable_vertex_ids:&self.stable,conductivity_spm_per_element:&self.sigma,terminals:&self.terminals,interfaces:&self.interfaces,
            absolute_jump_tolerance_v:1e-12,relative_jump_tolerance:1e-12,algebraic_relative_tolerance:1e-12,maximum_iterations:1000},
            closure_revision:"closure-r1",device_vertex_ids:&self.device,lead_vertex_ids:&self.lead,boundary_faces:&self.boundary,branches:&self.branches,targets_m:&self.targets,
            quadrature:ExternalLeadQuadraturePolicy {base_quadrature_order:4,maximum_subdivision_depth:6,absolute_tolerance_apm:1e-6,relative_tolerance:1e-5,maximum_source_target_pairs:1000}}
    }
    fn canonical(&self, face: [u64; 3]) -> f64 {
        let xyz = self
            .stable
            .iter()
            .copied()
            .zip(self.mesh.nodes.iter().copied())
            .collect::<BTreeMap<_, _>>();
        let [a, b, c] = face.map(|id| xyz[&id]);
        0.5 * ((b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]))
    }
    fn outward(&self, face: [u64; 3], element: usize) -> f64 {
        let xyz = self
            .stable
            .iter()
            .copied()
            .zip(self.mesh.nodes.iter().copied())
            .collect::<BTreeMap<_, _>>();
        self.canonical(face) * outward_sign(face, self.elements[element], &xyz).unwrap()
    }
    fn charge(&self) -> Vec<u8> {
        let mut b = Bytes::default();
        b.text("schema", "accepted_terminal_charge_source.ordered.v1");
        b.text("operator", "fem_accepted_terminal_charge_source.v1");
        for name in [
            "absolute_jump_tolerance_v",
            "relative_jump_tolerance",
            "algebraic_relative_tolerance",
        ] {
            b.real(name, 1e-12);
        }
        b.integer("maximum_iterations", 1000);
        b.integer("vertices", 24);
        b.text("stable_vertex_version", "stable_mesh_vertex_u64.v1");
        for (id, xyz) in self.stable.iter().zip(&self.mesh.nodes) {
            b.integer("vertex_id", *id);
            for v in xyz {
                b.real("xyz_m", *v);
            }
            b.real("potential_v", -(xyz[0] + 1.));
            b.real("reaction_a", self.reactions[id]);
            b.integer("vertex_component_id", 101);
        }
        b.integer("elements", 18);
        for ids in &self.elements {
            b.integer("attribute", 1);
            b.ids("vertex_id", ids);
            b.real("conductivity_spm", 1.);
        }
        b.integer("boundary", 36);
        for face in &self.boundary {
            b.integer("attribute", 1);
            b.ids("vertex_id", &face.vertex_ids);
        }
        b.integer("faces", self.faces.len() as u64);
        for (i, (face, owners)) in self.faces.iter().enumerate() {
            b.ids("vertex_id", face);
            b.integer("first_element", owners[0] as u64);
            b.integer(
                "second_element",
                owners.get(1).map_or(u64::MAX, |e| *e as u64),
            );
            b.integer("signed_rt0_dof", i as u64);
        }
        b.integer("rt0", self.faces.len() as u64);
        for face in self.faces.keys() {
            b.real("rt0_flux_a", self.canonical(*face) / 2.);
        }
        b.integer("terminals", 2);
        for terminal in &self.terminals {
            b.text("terminal_id", &terminal.id);
            b.integer("terminal_faces", 2);
            for face in &terminal.boundary_face_vertex_ids {
                b.ids("vertex_id", face);
            }
            for name in ["requested_current_a", "h1_current_a", "rt0_current_a"] {
                if name == "rt0_current_a" {
                    b.real("h1_residual_a", 0.);
                }
                b.real(name, terminal.requested_outward_current_a);
            }
            b.real("rt0_residual_a", 0.);
            b.real(
                "terminal_voltage_v",
                if terminal.id == "ground" { 0. } else { -3. },
            );
            b.integer("terminal_component_id", 101);
        }
        b.integer("references", 1);
        b.text("terminal_id", "ground");
        b.integer("component_id", 101);
        b.integer("components", 1);
        b.integer("component_id", 101);
        b.real("component_relative_residual", 0.);
        b.integer("gauges", 0);
        b.integer("interfaces", self.interfaces.len() as u64);
        for pair in &self.interfaces {
            b.text("interface_id", &pair.id);
            b.ids("vertex_id", &pair.first_face_vertex_ids);
            b.ids("vertex_id", &pair.second_face_vertex_ids);
            for ids in pair.vertex_pairs {
                b.ids("vertex_id", &ids);
            }
            b.real(
                "first_current_a",
                self.outward(
                    pair.first_face_vertex_ids,
                    self.faces[&pair.first_face_vertex_ids][0],
                ),
            );
            b.real(
                "second_current_a",
                self.outward(
                    pair.second_face_vertex_ids,
                    self.faces[&pair.second_face_vertex_ids][0],
                ),
            );
            b.real("interface_mismatch_a", 0.);
        }
        b.integer("rows_before", 24);
        b.integer("rank", 23);
        b.integer("omitted", 1);
        b.text("constraint_id", "terminal-current:ground");
        b.integer("omission_reason", 2);
        b.real("omitted_residual_a", 0.);
        b.ids("vertex_id", &[0; 4]);
        b.0
    }
    fn source(&self, charge_sha: &str) -> Vec<u8> {
        let mut b = Bytes::default();
        b.text("schema", "accepted_external_lead_current_source.ordered.v2");
        b.text(
            "operator_version",
            "fem_accepted_external_lead_current_source.v2",
        );
        b.text("field_scope", SCOPE);
        b.text("charge_content_digest", charge_sha);
        b.text("closure_revision", "closure-r1");
        b.real("absolute_current_gate_a", 1e-18);
        b.real("local_relative_gate", 1e-10);
        b.real("requested_current_relative_gate", 1e-8);
        b.integer("device_vertex_count", 8);
        b.ids("device_vertex_id", &(1..9).collect::<Vec<_>>());
        b.integer("lead_vertex_count", 16);
        b.ids(
            "lead_vertex_id",
            &(101..109).chain(201..209).collect::<Vec<_>>(),
        );
        b.integer("boundary_count", 36);
        for face in &self.boundary {
            b.ids("boundary_vertex_id", &face.vertex_ids);
            b.integer("boundary_role", face.role as u64);
            b.text("boundary_circuit_id", &face.circuit_id);
        }
        b.integer("branch_count", 2);
        for branch in &self.branches {
            b.text("branch_id", &branch.id);
            b.integer("branch_pair_count", 2);
            let mut pairs = branch.interface_pair_ids.clone();
            pairs.sort();
            for id in pairs {
                b.text("branch_pair_id", &id);
            }
            for name in ["branch_requested_a", "branch_h1_a", "branch_rt0_a"] {
                b.real(name, branch.requested_device_outward_current_a);
            }
        }
        b.integer("component_count", 1);
        b.integer("component_id", 1);
        for name in [
            "component_requested_sum_a",
            "component_h1_sum_a",
            "component_rt0_sum_a",
        ] {
            b.real(name, 0.);
        }
        let elements = self
            .elements
            .iter()
            .map(|ids| key(*ids))
            .collect::<BTreeSet<_>>();
        b.integer("element_count", 18);
        for ids in elements {
            b.ids("element_vertex_id", &ids);
            let element = self.elements.iter().position(|e| key(*e) == ids).unwrap();
            let values = self
                .faces
                .iter()
                .filter(|(_, owners)| owners.contains(&element))
                .map(|(face, _)| self.outward(*face, element))
                .collect::<Vec<_>>();
            b.real("element_flux_sum_a", Sum::of(values.iter().copied()));
            b.real(
                "element_absolute_flux_sum_a",
                Sum::of(values.iter().map(|v| v.abs())),
            );
        }
        b.integer("face_count", self.faces.len() as u64);
        for (face, owners) in &self.faces {
            b.ids("face_vertex_id", face);
            b.integer("face_side_count", owners.len() as u64);
            b.real("face_rt0_to_canonical_weight", 2.);
            b.real("face_canonical_flux_a", self.canonical(*face));
            let mut owners = owners.clone();
            owners.sort_by_key(|e| key(self.elements[*e]));
            b.real("face_first_outward_a", self.outward(*face, owners[0]));
            b.real(
                "face_second_outward_a",
                owners.get(1).map_or(0., |e| self.outward(*face, *e)),
            );
            b.real("face_canonical_jump_a", 0.);
        }
        b.integer("terminal_count", 2);
        for terminal in &self.terminals {
            b.text("terminal_id", &terminal.id);
            for name in ["terminal_requested_a", "terminal_h1_a", "terminal_rt0_a"] {
                b.real(name, terminal.requested_outward_current_a);
            }
        }
        b.integer("interface_count", self.interfaces.len() as u64);
        for pair in &self.interfaces {
            b.text("interface_id", &pair.id);
            b.real(
                "interface_first_outward_a",
                self.outward(
                    pair.first_face_vertex_ids,
                    self.faces[&pair.first_face_vertex_ids][0],
                ),
            );
            b.real(
                "interface_second_outward_a",
                self.outward(
                    pair.second_face_vertex_ids,
                    self.faces[&pair.second_face_vertex_ids][0],
                ),
            );
            b.real("interface_mismatch_a", 0.);
        }
        b.integer("constraint_rows", 24);
        b.integer("constraint_rank", 23);
        b.real("scaled_kkt_residual", 0.);
        b.real("correction_norm_mw", 0.);
        b.0
    }
    fn field(&self, charge_sha: &str, source_sha: &str) -> Vec<u8> {
        self.field_version(
            charge_sha,
            source_sha,
            fullmag_ir::ANTENNA_DIRECT_OERSTED_OPERATOR_VERSION,
        )
    }
    fn field_version(&self, charge_sha: &str, source_sha: &str, version: &str) -> Vec<u8> {
        let global = version == "fem_oersted_direct_tetra_quadrature.v3";
        let mut b = Bytes::default();
        b.text(
            "schema",
            if global {
                "accepted_external_lead_field.ordered.v2"
            } else {
                "accepted_external_lead_field.ordered.v1"
            },
        );
        b.text(
            "operator_version",
            if global {
                "fem_accepted_external_lead_field.v2"
            } else {
                "fem_accepted_external_lead_field.v1"
            },
        );
        b.text("quadrature_operator_version", version);
        b.text("field_scope", SCOPE);
        b.text("accepted_external_source_digest", source_sha);
        b.text("charge_content_digest", charge_sha);
        b.integer("base_quadrature_order", 4);
        b.integer("maximum_subdivision_depth", 6);
        b.real("absolute_tolerance_apm", 1e-6);
        b.real("relative_tolerance", 1e-5);
        b.real("relative_scale_floor_apm", if global { 0. } else { 1. });
        b.integer("maximum_source_target_pairs", 1000);
        if global {
            b.text("quadrature_scope", "global_target");
            b.text("estimated_error_policy", "sum_final_leaf_l2_difference.v1");
            b.text(
                "roundoff_indicator_policy",
                "weighted_terms_binary64_epsilon.v1",
            );
            b.integer("maximum_final_leaves_per_target", 1_000_000);
            b.integer("maximum_kernel_evaluations", 100_000_000);
            b.integer("maximum_ledger_leaf_visits", 100_000_000);
        }
        b.integer("target_count", self.targets.len() as u64);
        for target in &self.targets {
            for v in target {
                b.real("target_coordinate_m", *v);
            }
            for _ in 0..3 {
                b.real("h_component_apm", 0.);
            }
            if global {
                b.real("target_estimated_error_apm", 0.);
                b.real("target_tolerance_apm", 1e-6);
                b.real("target_roundoff_indicator_apm", 0.);
                b.integer("target_final_leaf_count", 18);
                b.integer("target_kernel_evaluations", 36);
                b.integer("target_ledger_leaf_visits", 18);
            }
        }
        b.integer("source_target_pairs", 18 * self.targets.len() as u64);
        b.integer("refined_pairs", 0);
        b.integer("unconverged_pair_count", 0);
        b.real("maximum_pair_error_apm", 0.);
        if global {
            b.integer("kernel_evaluations", 36 * self.targets.len() as u64);
            b.integer("ledger_leaf_visits", 18 * self.targets.len() as u64);
        }
        b.0
    }
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn bundle(charge: &[u8], source: &[u8], field: &[u8]) -> Vec<u8> {
    let mut b = Bytes::default();
    b.text("schema", SCHEMA);
    b.text("operator_version", OPERATOR);
    b.text("field_scope", SCOPE);
    for (s, n, bytes) in [
        ("charge_content_sha256", "charge_record", charge),
        ("source_content_sha256", "source_record", source),
        ("field_content_sha256", "field_record", field),
    ] {
        b.text(s, &digest(bytes));
        b.field(n, 3, bytes);
    }
    b.0
}

pub(crate) fn inspection_test_bundle() -> Vec<u8> {
    let f = Fixture::new();
    let charge = f.charge();
    let source = f.source(&digest(&charge));
    let field = f.field(&digest(&charge), &digest(&source));
    bundle(&charge, &source, &field)
}
fn mutate(bytes: &mut [u8], name: &str, occurrence: usize, replacement: &[u8]) {
    let mut position = 0;
    let mut seen = 0;
    loop {
        let size = u64::from_be_bytes(bytes[position..position + 8].try_into().unwrap()) as usize;
        position += 8;
        let matches = &bytes[position..position + size] == name.as_bytes();
        position += size + 1;
        let length = u64::from_be_bytes(bytes[position..position + 8].try_into().unwrap()) as usize;
        position += 8;
        if matches {
            if seen == occurrence {
                assert_eq!(length, replacement.len());
                bytes[position..position + length].copy_from_slice(replacement);
                return;
            }
            seen += 1;
        }
        position += length;
    }
}

// Analytic zero-current fixture: retain geometry/policy/weight maps while setting
// every physical current and potential to canonical zero, not a native solve.
fn zero_current_record(bytes: &mut [u8]) {
    let mut position = 0;
    while position < bytes.len() {
        let size = u64::from_be_bytes(bytes[position..position + 8].try_into().unwrap()) as usize;
        position += 8;
        let name = std::str::from_utf8(&bytes[position..position + size]).unwrap();
        let zero = (name.ends_with("_a") && name != "absolute_current_gate_a")
            || name == "potential_v"
            || name == "terminal_voltage_v";
        position += size;
        let tag = bytes[position];
        position += 1;
        let length = u64::from_be_bytes(bytes[position..position + 8].try_into().unwrap()) as usize;
        position += 8;
        if zero {
            assert_eq!((tag, length), (4, 8));
            bytes[position..position + length].copy_from_slice(&0f64.to_bits().to_be_bytes());
        }
        position += length;
    }
}

fn zero_current_bundle(f: &Fixture) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let mut charge = f.charge();
    zero_current_record(&mut charge);
    let mut source = f.source(&digest(&charge));
    zero_current_record(&mut source);
    let field = f.field(&digest(&charge), &digest(&source));
    (charge, source, field)
}

#[test]
fn exact_bundle_retains_charge_maps_and_request_bound_h() {
    let f = Fixture::new();
    let charge = f.charge();
    let source = f.source(&digest(&charge));
    let field = f.field(&digest(&charge), &digest(&source));
    let bytes = bundle(&charge, &source, &field);
    let decoded = decode_bundle(bytes.clone(), &digest(&bytes), &f.request()).unwrap();
    assert_eq!(decoded.canonical_payload, bytes);
    assert_eq!(decoded.charge.vertices.len(), 24);
    assert_eq!(decoded.charge.vertices[0].component_id, 101);
    assert_eq!(decoded.charge.constraint_rows, 24);
    assert_eq!(decoded.charge.constraint_rank, 23);
    assert_eq!(decoded.h_xyz_apm, [[0.; 3]]);
    assert!(decoded.charge.rt0_flux_a.iter().any(|q| *q != 0.));
    assert_eq!(decoded.charge.references[&101], "ground");
    assert_eq!(decoded.charge.components[0].id, 101);
    assert_eq!(decoded.charge.components[0].relative_residual, 0.0);
    assert!(decoded.charge.gauges.is_empty());
    assert_eq!(
        decoded.charge.omitted_rows[0].constraint_id,
        "terminal-current:ground"
    );
    assert_eq!(decoded.charge.omitted_rows[0].reason, 2);
    assert_eq!(decoded.charge.omitted_rows[0].residual_a, 0.0);
    assert_eq!(decoded.charge.omitted_rows[0].anchor_vertex_ids, [0; 4]);
}
#[test]
fn rehashed_signed_rt0_flip_is_rejected_against_cached_physical_ledger() {
    let f = Fixture::new();
    let mut charge = f.charge();
    let source = f.source(&digest(&charge));
    let field = f.field(&digest(&charge), &digest(&source));
    let baseline = bundle(&charge, &source, &field);
    assert!(decode_bundle(baseline.clone(), &digest(&baseline), &f.request()).is_ok());
    let occurrence = f
        .faces
        .keys()
        .position(|face| f.canonical(*face) != 0.)
        .unwrap();
    let q = f.canonical(*f.faces.keys().nth(occurrence).unwrap()) / 2.;
    mutate(
        &mut charge,
        "rt0_flux_a",
        occurrence,
        &(-q).to_bits().to_be_bytes(),
    );
    let source = f.source(&digest(&charge));
    let field = f.field(&digest(&charge), &digest(&source));
    let changed = bundle(&charge, &source, &field);
    assert!(decode_bundle(changed.clone(), &digest(&changed), &f.request()).is_err());
}
#[test]
fn rehashed_nested_corruption_does_not_bypass_source_or_field_binding() {
    let f = Fixture::new();
    let charge = f.charge();
    let source = f.source(&digest(&charge));
    let baseline = bundle(
        &charge,
        &source,
        &f.field(&digest(&charge), &digest(&source)),
    );
    assert!(decode_bundle(baseline.clone(), &digest(&baseline), &f.request()).is_ok());
    for (name, value) in [
        ("constraint_rank", 1u64.to_be_bytes()),
        ("face_rt0_to_canonical_weight", 0f64.to_bits().to_be_bytes()),
        (
            "element_absolute_flux_sum_a",
            1e6f64.to_bits().to_be_bytes(),
        ),
        ("face_first_outward_a", 1e6f64.to_bits().to_be_bytes()),
    ] {
        let mut changed = source.clone();
        mutate(&mut changed, name, 0, &value);
        let field = f.field(&digest(&charge), &digest(&changed));
        let bytes = bundle(&charge, &changed, &field);
        assert!(
            decode_bundle(bytes.clone(), &digest(&bytes), &f.request()).is_err(),
            "accepted {name}"
        );
    }
    let mut invented_charge = charge.clone();
    mutate(&mut invented_charge, "rows_before", 0, &25u64.to_be_bytes());
    mutate(&mut invented_charge, "rank", 0, &24u64.to_be_bytes());
    let mut invented_source = f.source(&digest(&invented_charge));
    mutate(
        &mut invented_source,
        "constraint_rows",
        0,
        &25u64.to_be_bytes(),
    );
    mutate(
        &mut invented_source,
        "constraint_rank",
        0,
        &24u64.to_be_bytes(),
    );
    let invented_field = f.field(&digest(&invented_charge), &digest(&invented_source));
    let invented = bundle(&invented_charge, &invented_source, &invented_field);
    assert!(decode_bundle(invented.clone(), &digest(&invented), &f.request()).is_err());
    let field = f.field(&digest(&charge), &digest(&source));
    for (name, value) in [
        ("target_coordinate_m", 9f64.to_bits().to_be_bytes()),
        ("relative_scale_floor_apm", 1f64.to_bits().to_be_bytes()),
        ("source_target_pairs", 19u64.to_be_bytes()),
        ("unconverged_pair_count", 1u64.to_be_bytes()),
        ("h_component_apm", f64::NAN.to_bits().to_be_bytes()),
    ] {
        let mut changed = field.clone();
        mutate(&mut changed, name, 0, &value);
        let bytes = bundle(&charge, &source, &changed);
        assert!(
            decode_bundle(bytes.clone(), &digest(&bytes), &f.request()).is_err(),
            "accepted {name}"
        );
    }
    let bytes = bundle(&charge, &source, &field);
    assert!(decode_bundle(bytes.clone(), &"0".repeat(64), &f.request()).is_err());
    let mut trailing = bytes;
    trailing.push(0);
    assert!(decode_bundle(trailing.clone(), &digest(&trailing), &f.request()).is_err());
}
#[test]
fn compensated_current_sum_preserves_cancellation_residue() {
    assert_eq!(Sum::of([1., 2f64.powi(-54), -1.]), 2f64.powi(-54));
}

#[test]
fn legacy_quadrature_archives_retain_versions_but_cannot_bind_current_request() {
    assert_eq!(
        fullmag_ir::ANTENNA_DIRECT_OERSTED_OPERATOR_VERSION,
        "fem_oersted_direct_tetra_quadrature.v3"
    );
    let f = Fixture::new();
    let charge = f.charge();
    let source = f.source(&digest(&charge));
    for version in [
        "fem_oersted_direct_tetra_quadrature.v1",
        "fem_oersted_direct_tetra_quadrature.v2",
    ] {
        let field = f.field_version(&digest(&charge), &digest(&source), version);
        let bytes = bundle(&charge, &source, &field);
        let owned = decode_owned_bundle(bytes.clone(), &digest(&bytes)).unwrap();
        assert_eq!(owned.field.quadrature_operator_version, version);
        assert_eq!(owned.field.relative_scale_floor_apm, 1.0);
        assert!(owned.field.global_quadrature.is_none());
        assert_eq!(
            &owned.canonical_payload[owned.field.canonical_range.clone()],
            field
        );
        assert!(validate_bundle_request(&owned, &f.request()).is_err());
        assert!(decode_bundle(bytes.clone(), &digest(&bytes), &f.request()).is_err());
    }
}

#[test]
fn owned_field_rejects_mixed_or_future_version_contracts() {
    let f = Fixture::new();
    let charge = f.charge();
    let source = f.source(&digest(&charge));
    for version in [
        "fem_oersted_direct_tetra_quadrature.v1",
        "fem_oersted_direct_tetra_quadrature.v2",
        "fem_oersted_direct_tetra_quadrature.v3",
    ] {
        let field = f.field_version(&digest(&charge), &digest(&source), version);
        let global = version.ends_with("v3");
        for (name, replacement) in [
            (
                "schema",
                if global {
                    "accepted_external_lead_field.ordered.v1"
                } else {
                    "accepted_external_lead_field.ordered.v2"
                },
            ),
            (
                "operator_version",
                if global {
                    "fem_accepted_external_lead_field.v1"
                } else {
                    "fem_accepted_external_lead_field.v2"
                },
            ),
            (
                "quadrature_operator_version",
                if global {
                    "fem_oersted_direct_tetra_quadrature.v2"
                } else {
                    "fem_oersted_direct_tetra_quadrature.v3"
                },
            ),
            (
                "quadrature_operator_version",
                "fem_oersted_direct_tetra_quadrature.v4",
            ),
        ] {
            let mut changed = field.clone();
            mutate(&mut changed, name, 0, replacement.as_bytes());
            let bytes = bundle(&charge, &source, &changed);
            assert!(
                decode_owned_bundle(bytes.clone(), &digest(&bytes)).is_err(),
                "accepted mixed {version}/{name}/{replacement}"
            );
        }
        let mut changed = field;
        mutate(
            &mut changed,
            "relative_scale_floor_apm",
            0,
            &(if global { 1f64 } else { 0f64 }).to_bits().to_be_bytes(),
        );
        let bytes = bundle(&charge, &source, &changed);
        assert!(decode_owned_bundle(bytes.clone(), &digest(&bytes)).is_err());
    }
}

#[test]
fn global_target_diagnostics_retain_exact_policies_and_ordered_counts() {
    let mut f = Fixture::new();
    f.targets.push([3., 4., 5.]);
    for targets in [2, 0] {
        f.targets.truncate(targets);
        let charge = f.charge();
        let source = f.source(&digest(&charge));
        let field = f.field(&digest(&charge), &digest(&source));
        let bytes = bundle(&charge, &source, &field);
        let owned = decode_bundle(bytes.clone(), &digest(&bytes), &f.request()).unwrap();
        let global = owned.field.global_quadrature.as_ref().unwrap();
        assert_eq!(
            owned.field.quadrature_operator_version,
            "fem_oersted_direct_tetra_quadrature.v3"
        );
        assert_eq!(owned.field.relative_scale_floor_apm, 0.0);
        assert_eq!(global.quadrature_scope, "global_target");
        assert_eq!(
            global.estimated_error_policy,
            "sum_final_leaf_l2_difference.v1"
        );
        assert_eq!(
            global.roundoff_indicator_policy,
            "weighted_terms_binary64_epsilon.v1"
        );
        assert_eq!(global.maximum_final_leaves_per_target, 1_000_000);
        assert_eq!(global.maximum_kernel_evaluations, 100_000_000);
        assert_eq!(global.maximum_ledger_leaf_visits, 100_000_000);
        assert_eq!(global.targets.len(), targets);
        assert_eq!(global.kernel_evaluations, 36 * targets as u64);
        assert_eq!(global.ledger_leaf_visits, 18 * targets as u64);
        for target in &global.targets {
            assert_eq!(target.estimated_error_apm, 0.0);
            assert_eq!(target.roundoff_indicator_apm, 0.0);
            assert_eq!(target.tolerance_apm, 1e-6);
            assert_eq!(target.final_leaf_count, 18);
            assert_eq!(target.kernel_evaluations, 36);
            assert_eq!(target.ledger_leaf_visits, 18);
        }
    }
}

#[test]
fn rehashed_global_error_diagnostics_refuse_slack_and_bind_exact_published_h() {
    let f = Fixture::new();
    let charge = f.charge();
    let source = f.source(&digest(&charge));
    let field = f.field(&digest(&charge), &digest(&source));
    for (name, value) in [
        ("target_estimated_error_apm", 2e-6f64),
        ("target_roundoff_indicator_apm", 2e-6f64),
        ("target_estimated_error_apm", -1e-6f64),
        ("target_roundoff_indicator_apm", -1e-6f64),
        ("target_tolerance_apm", -1e-6f64),
        ("target_estimated_error_apm", f64::NAN),
        ("target_roundoff_indicator_apm", f64::INFINITY),
        ("target_tolerance_apm", f64::INFINITY),
        ("target_estimated_error_apm", -0f64),
        (
            "target_tolerance_apm",
            f64::from_bits(1e-6f64.to_bits() + 1),
        ),
        ("h_component_apm", 1f64),
    ] {
        let mut changed = field.clone();
        mutate(&mut changed, name, 0, &value.to_bits().to_be_bytes());
        let bytes = bundle(&charge, &source, &changed);
        assert!(
            decode_owned_bundle(bytes.clone(), &digest(&bytes)).is_err(),
            "accepted {name}={value:?}"
        );
    }
    let mut boundary = field.clone();
    mutate(
        &mut boundary,
        "target_estimated_error_apm",
        0,
        &1e-6f64.to_bits().to_be_bytes(),
    );
    let bytes = bundle(&charge, &source, &boundary);
    assert!(decode_owned_bundle(bytes.clone(), &digest(&bytes)).is_ok());
    // One binary64 ULP beyond the target budget is refused without epsilon slack.
    let mut sub_ulp = boundary.clone();
    mutate(
        &mut sub_ulp,
        "target_roundoff_indicator_apm",
        0,
        &f64::from_bits(1).to_bits().to_be_bytes(),
    );
    let bytes = bundle(&charge, &source, &sub_ulp);
    assert!(decode_owned_bundle(bytes.clone(), &digest(&bytes)).is_err());
    mutate(
        &mut boundary,
        "target_estimated_error_apm",
        0,
        &(1e-6f64.to_bits() + 1).to_be_bytes(),
    );
    let bytes = bundle(&charge, &source, &boundary);
    assert!(decode_owned_bundle(bytes.clone(), &digest(&bytes)).is_err());
    let mut split = field.clone();
    for name in [
        "target_estimated_error_apm",
        "target_roundoff_indicator_apm",
    ] {
        mutate(&mut split, name, 0, &6e-7f64.to_bits().to_be_bytes());
    }
    let bytes = bundle(&charge, &source, &split);
    assert!(decode_owned_bundle(bytes.clone(), &digest(&bytes)).is_err());
    let mut nonzero_h = field;
    for (i, h) in [3f64, 4., 12.].into_iter().enumerate() {
        mutate(
            &mut nonzero_h,
            "h_component_apm",
            i,
            &h.to_bits().to_be_bytes(),
        );
    }
    let tolerance = 1e-5f64.mul_add(3f64.hypot(4.).hypot(12.), 1e-6);
    mutate(
        &mut nonzero_h,
        "target_tolerance_apm",
        0,
        &tolerance.to_bits().to_be_bytes(),
    );
    let bytes = bundle(&charge, &source, &nonzero_h);
    assert!(decode_owned_bundle(bytes.clone(), &digest(&bytes)).is_ok());
}

#[test]
fn rehashed_global_work_limits_and_leaf_totals_are_enforced() {
    let f = Fixture::new();
    let charge = f.charge();
    let source = f.source(&digest(&charge));
    let field = f.field(&digest(&charge), &digest(&source));
    for (name, value) in [
        ("maximum_final_leaves_per_target", 1_000_001u64),
        ("maximum_kernel_evaluations", 100_000_001),
        ("maximum_ledger_leaf_visits", 100_000_001),
        ("target_final_leaf_count", 17),
        ("target_final_leaf_count", 19),
        ("target_final_leaf_count", 1_000_001),
        ("target_kernel_evaluations", 35),
        ("target_kernel_evaluations", 100_000_001),
        ("target_ledger_leaf_visits", 17),
        ("target_ledger_leaf_visits", 100_000_001),
        ("kernel_evaluations", 35),
        ("ledger_leaf_visits", 17),
        ("refined_pairs", 1),
    ] {
        let mut changed = field.clone();
        mutate(&mut changed, name, 0, &value.to_be_bytes());
        let bytes = bundle(&charge, &source, &changed);
        assert!(
            decode_owned_bundle(bytes.clone(), &digest(&bytes)).is_err(),
            "accepted {name}={value}"
        );
    }
    let mut refined = field;
    mutate(&mut refined, "refined_pairs", 0, &1u64.to_be_bytes());
    mutate(
        &mut refined,
        "target_final_leaf_count",
        0,
        &25u64.to_be_bytes(),
    );
    let bytes = bundle(&charge, &source, &refined);
    // Structural codec checks do not certify the adaptation history.
    assert!(decode_owned_bundle(bytes.clone(), &digest(&bytes)).is_ok());
    let mut two = Fixture::new();
    two.targets.push([3., 4., 5.]);
    let mut field = two.field(&digest(&charge), &digest(&source));
    for (target_name, total_name) in [
        ("target_kernel_evaluations", "kernel_evaluations"),
        ("target_ledger_leaf_visits", "ledger_leaf_visits"),
    ] {
        let mut changed = field.clone();
        for i in 0..2 {
            mutate(&mut changed, target_name, i, &60_000_000u64.to_be_bytes());
        }
        mutate(&mut changed, total_name, 0, &120_000_000u64.to_be_bytes());
        let bytes = bundle(&charge, &source, &changed);
        assert!(
            decode_owned_bundle(bytes.clone(), &digest(&bytes)).is_err(),
            "accepted aggregate {total_name} budget overflow"
        );
    }
    mutate(
        &mut field,
        "target_final_leaf_count",
        1,
        &19u64.to_be_bytes(),
    );
    let bytes = bundle(&charge, &source, &field);
    assert!(decode_owned_bundle(bytes.clone(), &digest(&bytes)).is_err());
}

#[test]
fn global_record_requires_exact_policy_tokens_and_complete_framing() {
    let f = Fixture::new();
    let charge = f.charge();
    let source = f.source(&digest(&charge));
    let field = f.field(&digest(&charge), &digest(&source));
    for (name, replacement) in [
        ("quadrature_scope", "Global_target"),
        ("estimated_error_policy", "sum_final_leaf_l2_difference.v2"),
        (
            "roundoff_indicator_policy",
            "weighted_terms_binary64_epsilon.v2",
        ),
    ] {
        let mut changed = field.clone();
        mutate(&mut changed, name, 0, replacement.as_bytes());
        let bytes = bundle(&charge, &source, &changed);
        assert!(decode_owned_bundle(bytes.clone(), &digest(&bytes)).is_err());
    }
    let truncated = &field[..field.len() - 1];
    let bytes = bundle(&charge, &source, truncated);
    assert!(decode_owned_bundle(bytes.clone(), &digest(&bytes)).is_err());
    let mut extra = field;
    extra.push(0);
    let bytes = bundle(&charge, &source, &extra);
    assert!(decode_owned_bundle(bytes.clone(), &digest(&bytes)).is_err());
}
#[test]
fn overlapping_electrode_trace_and_branch_dofs_are_rejected() {
    let mut f = Fixture::new();
    f.terminals[0].boundary_face_vertex_ids[0] = f.interfaces[0].second_face_vertex_ids;
    assert!(super::super::preflight(&f.request()).is_err());
    let mut f = Fixture::new();
    f.branches[1].interface_pair_ids = f.branches[0].interface_pair_ids.clone();
    assert!(super::super::preflight(&f.request()).is_err());
}

#[test]
fn owned_bundle_retains_exact_nested_bytes_and_physical_ledgers_without_request() {
    let f = Fixture::new();
    let charge = f.charge();
    let source = f.source(&digest(&charge));
    let field = f.field(&digest(&charge), &digest(&source));
    let bytes = bundle(&charge, &source, &field);
    let decoded = decode_owned_bundle(bytes.clone(), &digest(&bytes)).unwrap();
    assert_eq!(decoded.charge.canonical_payload, charge);
    assert_eq!(
        &decoded.canonical_payload[decoded.source.canonical_range.clone()],
        source
    );
    assert_eq!(
        &decoded.canonical_payload[decoded.field.canonical_range.clone()],
        field
    );
    assert_eq!(decoded.source_content_sha256, digest(&source));
    assert_eq!(decoded.field_content_sha256, digest(&field));
    assert_eq!(decoded.source.closure_revision, "closure-r1");
    assert_eq!(decoded.source.device_vertex_ids, (1..9).collect::<Vec<_>>());
    assert_eq!(
        decoded.source.lead_vertex_ids,
        (101..109).chain(201..209).collect::<Vec<_>>()
    );
    assert_eq!(decoded.source.boundary_faces, f.boundary);
    assert_eq!(decoded.source.branches[0].id, "left");
    for current in decoded.source.branch_h1_rt0_a[0] {
        current_gate(current, -1.0).unwrap();
    }
    assert_eq!(decoded.source.components[0].id, 1);
    assert_eq!(decoded.source.components[0].currents_a, [0.0; 3]);
    assert_eq!(decoded.source.elements.len(), 18);
    assert_eq!(decoded.source.faces.len(), f.faces.len());
    assert!(decoded
        .source
        .faces
        .iter()
        .any(|face| face.canonical_flux_a != 0.0));
    assert!(decoded
        .source
        .faces
        .iter()
        .all(|face| face.rt0_to_canonical_weight == 2.0));
    assert_eq!(decoded.field.targets_m, f.targets);
    assert_eq!(decoded.field.quadrature.base_quadrature_order, 4);
    assert_eq!(decoded.field.relative_scale_floor_apm, 0.0);
    assert_eq!(decoded.field.unconverged_pair_count, 0);
    assert_eq!(decoded.source.scaled_kkt_residual, 0.0);
    assert_eq!(decoded.source.correction_norm_mw, 0.0);
    assert!(validate_bundle_request(&decoded, &f.request()).is_ok());
}

#[test]
fn owned_integrity_accepts_changed_intent_but_real_request_binding_refuses_it() {
    let f = Fixture::new();
    let charge = f.charge();
    let source = f.source(&digest(&charge));
    let field = f.field(&digest(&charge), &digest(&source));
    let baseline = bundle(&charge, &source, &field);
    assert!(decode_bundle(baseline.clone(), &digest(&baseline), &f.request()).is_ok());
    // These finite changes do not claim that H was recomputed or independently qualified.
    for (name, replacement) in [
        ("target_coordinate_m", 9f64.to_bits().to_be_bytes()),
        ("absolute_tolerance_apm", 2e-6f64.to_bits().to_be_bytes()),
        ("base_quadrature_order", 6u64.to_be_bytes()),
    ] {
        let mut changed = field.clone();
        mutate(&mut changed, name, 0, &replacement);
        if name == "absolute_tolerance_apm" {
            mutate(&mut changed, "target_tolerance_apm", 0, &replacement);
        }
        let bytes = bundle(&charge, &source, &changed);
        let owned = decode_owned_bundle(bytes.clone(), &digest(&bytes)).unwrap();
        assert!(
            validate_bundle_request(&owned, &f.request()).is_err(),
            "accepted stale {name}"
        );
        assert!(decode_bundle(bytes.clone(), &digest(&bytes), &f.request()).is_err());
    }
    let mut changed_source = source;
    mutate(&mut changed_source, "closure_revision", 0, b"closure-r2");
    let changed_field = f.field(&digest(&charge), &digest(&changed_source));
    let bytes = bundle(&charge, &changed_source, &changed_field);
    let owned = decode_owned_bundle(bytes.clone(), &digest(&bytes)).unwrap();
    assert!(validate_bundle_request(&owned, &f.request()).is_err());
    let owned = decode_owned_bundle(baseline.clone(), &digest(&baseline)).unwrap();
    let mut stale = f.request();
    stale.charge.absolute_jump_tolerance_v = 2e-12;
    assert!(validate_bundle_request(&owned, &stale).is_err());
}

#[test]
fn owned_rehashed_source_corruption_and_degenerate_geometry_are_rejected() {
    let f = Fixture::new();
    let charge = f.charge();
    let source = f.source(&digest(&charge));
    let baseline = bundle(
        &charge,
        &source,
        &f.field(&digest(&charge), &digest(&source)),
    );
    assert!(decode_owned_bundle(baseline.clone(), &digest(&baseline)).is_ok());
    for (name, replacement) in [
        ("device_vertex_id", 101u64.to_be_bytes()),
        ("boundary_role", 2u64.to_be_bytes()),
        ("branch_pair_id", *b"join-0-1"),
        ("branch_requested_a", 2f64.to_bits().to_be_bytes()),
        ("component_id", 101u64.to_be_bytes()),
        ("face_rt0_to_canonical_weight", 0f64.to_bits().to_be_bytes()),
        ("face_first_outward_a", 1e6f64.to_bits().to_be_bytes()),
        (
            "element_absolute_flux_sum_a",
            1e6f64.to_bits().to_be_bytes(),
        ),
    ] {
        let mut changed = source.clone();
        mutate(&mut changed, name, 0, &replacement);
        let field = f.field(&digest(&charge), &digest(&changed));
        let bytes = bundle(&charge, &changed, &field);
        assert!(
            decode_owned_bundle(bytes.clone(), &digest(&bytes)).is_err(),
            "accepted {name}"
        );
    }
    let mut flattened_charge = charge;
    for i in 0..24 {
        mutate(
            &mut flattened_charge,
            "xyz_m",
            3 * i + 1,
            &0f64.to_bits().to_be_bytes(),
        );
    }
    let source = f.source(&digest(&flattened_charge));
    let field = f.field(&digest(&flattened_charge), &digest(&source));
    let bytes = bundle(&flattened_charge, &source, &field);
    assert!(decode_owned_bundle(bytes.clone(), &digest(&bytes)).is_err());
}

#[test]
fn owned_reader_rejects_rehashed_rt0_sign_and_invalid_field_diagnostics() {
    let f = Fixture::new();
    let mut charge = f.charge();
    let source = f.source(&digest(&charge));
    let field = f.field(&digest(&charge), &digest(&source));
    let baseline = bundle(&charge, &source, &field);
    assert!(decode_owned_bundle(baseline.clone(), &digest(&baseline)).is_ok());
    for (name, value) in [
        ("relative_scale_floor_apm", 1f64.to_bits().to_be_bytes()),
        ("source_target_pairs", 19u64.to_be_bytes()),
        ("refined_pairs", u64::MAX.to_be_bytes()),
        ("unconverged_pair_count", 1u64.to_be_bytes()),
        ("h_component_apm", f64::NAN.to_bits().to_be_bytes()),
    ] {
        let mut changed = field.clone();
        mutate(&mut changed, name, 0, &value);
        let bytes = bundle(&charge, &source, &changed);
        assert!(
            decode_owned_bundle(bytes.clone(), &digest(&bytes)).is_err(),
            "accepted {name}"
        );
    }
    let occurrence = f
        .faces
        .keys()
        .position(|face| f.canonical(*face) != 0.)
        .unwrap();
    let q = f.canonical(*f.faces.keys().nth(occurrence).unwrap()) / 2.;
    mutate(
        &mut charge,
        "rt0_flux_a",
        occurrence,
        &(-q).to_bits().to_be_bytes(),
    );
    let source = f.source(&digest(&charge));
    let field = f.field(&digest(&charge), &digest(&source));
    let bytes = bundle(&charge, &source, &field);
    assert!(decode_owned_bundle(bytes.clone(), &digest(&bytes)).is_err());
}

#[test]
fn owned_rehashed_physical_graph_refuses_split_h1_component_labels() {
    let f = Fixture::new();
    let mut charge = f.charge();
    let source = f.source(&digest(&charge));
    let baseline = bundle(
        &charge,
        &source,
        &f.field(&digest(&charge), &digest(&source)),
    );
    assert!(decode_owned_bundle(baseline.clone(), &digest(&baseline)).is_ok());
    // Charge framing alone can represent two labels; typed physical interfaces still
    // join these volumes into ONE face-connected external-source component.
    for i in 0..8 {
        mutate(&mut charge, "vertex_component_id", i, &1u64.to_be_bytes());
    }
    mutate(&mut charge, "components", 0, &2u64.to_be_bytes());
    let mut marker = Bytes::default();
    marker.integer("gauges", 0);
    let insertion = charge
        .windows(marker.0.len())
        .position(|bytes| bytes == marker.0.as_slice())
        .unwrap();
    let mut extra = Bytes::default();
    extra.integer("component_id", 1);
    extra.real("component_relative_residual", 0.0);
    drop(charge.splice(insertion..insertion, extra.0));
    assert!(decode_accepted_terminal_charge_record(charge.clone(), &digest(&charge)).is_ok());
    let source = f.source(&digest(&charge));
    let field = f.field(&digest(&charge), &digest(&source));
    let bytes = bundle(&charge, &source, &field);
    assert!(decode_owned_bundle(bytes.clone(), &digest(&bytes)).is_err());
}

#[test]
fn owned_zero_current_rehashed_same_side_interface_geometry_is_rejected() {
    let f = Fixture::new();
    let (mut charge, mut source, field) = zero_current_bundle(&f);
    let baseline = bundle(&charge, &source, &field);
    let owned = decode_owned_bundle(baseline.clone(), &digest(&baseline)).unwrap();
    assert!(owned.charge.rt0_flux_a.iter().all(|q| *q == 0.0));
    // Reflect the left lead through its x=0 trace. Coincident mapped trace
    // vertices stay unchanged, but both adjacent tets now occupy x>0.
    for (i, id) in f.stable.iter().enumerate() {
        if (101..109).contains(id) {
            let x = -f.mesh.nodes[i][0];
            let x = if x == 0.0 { 0.0 } else { x };
            mutate(&mut charge, "xyz_m", 3 * i, &x.to_bits().to_be_bytes());
        }
    }
    assert!(decode_accepted_terminal_charge_record(charge.clone(), &digest(&charge)).is_ok());
    mutate(
        &mut source,
        "charge_content_digest",
        0,
        digest(&charge).as_bytes(),
    );
    let field = f.field(&digest(&charge), &digest(&source));
    let changed = bundle(&charge, &source, &field);
    let error = decode_owned_bundle(changed.clone(), &digest(&changed)).unwrap_err();
    assert!(error.message.contains("same physical triangle side"));
}

#[test]
fn owned_zero_current_interface_accepts_reversed_stable_id_orientation() {
    let mut f = Fixture::new();
    let (charge, source, field) = zero_current_bundle(&f);
    let baseline = bundle(&charge, &source, &field);
    assert!(decode_owned_bundle(baseline.clone(), &digest(&baseline)).is_ok());
    let [a, b, _] = f.interfaces[0].second_face_vertex_ids;
    let remap = |id: u64| {
        if id == a {
            b
        } else if id == b {
            a
        } else {
            id
        }
    };
    for id in &mut f.stable {
        *id = remap(*id);
    }
    for id in &mut f.lead {
        *id = remap(*id);
    }
    for element in &mut f.elements {
        *element = element.map(remap);
    }
    f.faces = f
        .faces
        .into_iter()
        .map(|(face, owners)| (key(face.map(remap)), owners))
        .collect();
    for face in &mut f.boundary {
        face.vertex_ids = key(face.vertex_ids.map(remap));
    }
    f.boundary.sort_by_key(|face| face.vertex_ids);
    for terminal in &mut f.terminals {
        for face in &mut terminal.boundary_face_vertex_ids {
            *face = key(face.map(remap));
        }
        terminal.boundary_face_vertex_ids.sort_unstable();
    }
    for pair in &mut f.interfaces {
        pair.second_face_vertex_ids = key(pair.second_face_vertex_ids.map(remap));
        for mapping in &mut pair.vertex_pairs {
            mapping[1] = remap(mapping[1]);
        }
    }
    f.reactions = f
        .reactions
        .into_iter()
        .map(|(id, value)| (remap(id), value))
        .collect();
    // Sorting by remapped IDs reverses this triangle's physical ordering.
    let coordinates = f
        .stable
        .iter()
        .copied()
        .zip(f.mesh.nodes.iter().copied())
        .collect::<BTreeMap<_, _>>();
    let pair = &f.interfaces[0];
    let first_element = f.faces[&pair.first_face_vertex_ids][0];
    let second_element = f.faces[&pair.second_face_vertex_ids][0];
    assert_eq!(
        outward_sign(
            pair.first_face_vertex_ids,
            f.elements[first_element],
            &coordinates
        )
        .unwrap(),
        outward_sign(
            pair.second_face_vertex_ids,
            f.elements[second_element],
            &coordinates
        )
        .unwrap()
    );
    let (charge, source, field) = zero_current_bundle(&f);
    let bytes = bundle(&charge, &source, &field);
    assert!(decode_owned_bundle(bytes.clone(), &digest(&bytes)).is_ok());
}
