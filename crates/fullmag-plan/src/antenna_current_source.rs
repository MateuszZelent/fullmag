//! Checked mesh-exact input materialization; public execution remains gated.
use crate::PlanError;
use fullmag_ir::antenna_current_source::*;
use fullmag_ir::{
    AntennaFieldModelIR, AntennaFieldSamplingPlanIR, AntennaFieldSolveStageIR,
    AntennaOerstedRealizationIR, AntennaPortModeIR, ChargePotentialGaugeIR,
    ChargeTransportDefinitionIR, ConservativeCurrentSourceIR, CurrentSourceOuterTerminalIR,
    FemConnectivityIR, FemFacetConnectivityIR, FemFacetRoleIR, FemObjectSegmentIR, MeshIR,
};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

const MAX_ELEMENTS: usize = 1 << 20;
const MAX_PAIRS: u64 = fullmag_ir::ANTENNA_DIRECT_OERSTED_MAX_SOURCE_TARGET_PAIRS;
const MAX_PIN_BYTES: usize = 128 << 20;

fn fail(message: impl Into<String>) -> PlanError {
    PlanError {
        reasons: vec![message.into()],
    }
}
fn require(ok: bool, message: &str) -> Result<(), PlanError> {
    if ok {
        Ok(())
    } else {
        Err(fail(message))
    }
}
fn text(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 4096 && !value.contains('\0')
}
fn finite_mesh(mesh: &MeshIR) -> Result<(), PlanError> {
    require(
        mesh.nodes.iter().flatten().all(|x| x.is_finite()),
        "current source mesh coordinates must be finite",
    )?;
    for q in mesh.per_domain_quality.values() {
        require(
            [
                q.sicn_min,
                q.sicn_max,
                q.sicn_mean,
                q.sicn_p5,
                q.gamma_min,
                q.gamma_mean,
                q.volume_min,
                q.volume_max,
                q.volume_mean,
                q.volume_std,
                q.avg_quality,
            ]
            .iter()
            .all(|x| x.is_finite()),
            "current source quality metadata must be finite before JSON hashing",
        )?;
    }
    Ok(())
}

/// Recursive key ordering also works when serde_json's preserve_order is enabled.
fn canonical_json(value: &Value, bytes: &mut Vec<u8>) -> Result<(), PlanError> {
    match value {
        Value::Object(map) => {
            bytes.push(b'{');
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort_unstable();
            for (i, key) in keys.into_iter().enumerate() {
                if i != 0 {
                    bytes.push(b',');
                }
                bytes.extend(serde_json::to_vec(key).map_err(|e| fail(e.to_string()))?);
                bytes.push(b':');
                canonical_json(&map[key], bytes)?;
            }
            bytes.push(b'}');
        }
        Value::Array(items) => {
            bytes.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i != 0 {
                    bytes.push(b',');
                }
                canonical_json(item, bytes)?;
            }
            bytes.push(b']');
        }
        _ => bytes.extend(serde_json::to_vec(value).map_err(|e| fail(e.to_string()))?),
    }
    Ok(())
}
fn pin(value: &impl Serialize) -> Result<String, PlanError> {
    // Count without allocating the large Value or canonical preimage first.
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0 = self
                .0
                .checked_add(data.len())
                .filter(|n| *n <= MAX_PIN_BYTES)
                .ok_or_else(|| std::io::Error::other("current source input pin exceeds 128 MiB"))?;
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(Counter(0), value).map_err(|e| fail(e.to_string()))?;
    let value = serde_json::to_value(value).map_err(|e| fail(e.to_string()))?;
    let mut bytes = Vec::new();
    canonical_json(&value, &mut bytes)?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

struct Topology {
    tets: Vec<[u32; 4]>,
    exterior: BTreeMap<[u64; 3], (usize, u32)>,
    interior_element_pairs: Vec<[usize; 2]>,
}
fn key(ids: [u64; 3]) -> [u64; 3] {
    let mut ids = ids;
    ids.sort_unstable();
    ids
}
fn determinant(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> f64 {
    a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
        + a[2] * (b[0] * c[1] - b[1] * c[0])
}
fn side(points: [[f64; 3]; 4]) -> Result<f64, PlanError> {
    let mut edges = [[0.; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            edges[i][j] = points[i + 1][j] - points[0][j];
        }
    }
    let scale = edges.iter().flatten().fold(0.0_f64, |s, x| s.max(x.abs()));
    require(
        scale.is_finite() && scale > 0.,
        "current source has invalid tetrahedral geometry scale",
    )?;
    for e in &mut edges {
        for x in e {
            *x /= scale;
        }
    }
    let d = determinant(edges[0], edges[1], edges[2]);
    require(
        d.is_finite() && d != 0.,
        "current source has degenerate tetrahedral geometry",
    )?;
    Ok(d)
}
fn topology(mesh: &MeshIR, ids: &[u64]) -> Result<Topology, PlanError> {
    require(
        mesh.cell_count() > 0
            && mesh.cell_count() <= MAX_ELEMENTS
            && mesh.nodes.len() <= 4 * mesh.cell_count()
            && mesh.facet_count() <= 4 * mesh.cell_count()
            && mesh.cells.nodes.len() == 4 * mesh.cell_count()
            && mesh.cells.offsets.len() == mesh.cell_count() + 1
            && mesh.facets.nodes.len() == 3 * mesh.facet_count()
            && mesh.facets.offsets.len() == mesh.facet_count() + 1,
        "current source mesh exceeds bounded native Tet4 support",
    )?;
    finite_mesh(mesh)?;
    mesh.validate().map_err(|e| fail(e.join("; ")))?;
    require(
        ids.len() == mesh.nodes.len()
            && ids.iter().all(|id| *id > 0)
            && ids.iter().copied().collect::<BTreeSet<_>>().len() == ids.len(),
        "current source stable IDs must cover actual nodes uniquely",
    )?;
    require(
        mesh.periodic_boundary_pairs.is_empty()
            && mesh.periodic_node_pairs.is_empty()
            && mesh
                .facets
                .roles
                .iter()
                .all(|r| *r == FemFacetRoleIR::Exterior),
        "current source requires exterior-only facets and no periodic relations",
    )?;
    require(
        mesh.element_markers
            .iter()
            .chain(&mesh.boundary_markers)
            .all(|m| *m > 0 && *m <= i32::MAX as u32),
        "current source markers must be positive signed-32-bit values",
    )?;
    let tets = mesh.require_tet4_elements().map_err(fail)?;
    let mut faces = BTreeMap::<[u64; 3], Vec<(usize, u32)>>::new();
    let mut used = vec![false; ids.len()];
    for (e, tet) in tets.iter().enumerate() {
        require(
            side(tet.map(|v| mesh.nodes[v as usize]))? > 0.,
            "current source requires positively oriented Tet4 cells",
        )?;
        for v in tet {
            used[*v as usize] = true;
        }
        for omitted in 0..4 {
            let vertices: Vec<_> = tet
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != omitted)
                .map(|(_, v)| ids[*v as usize])
                .collect();
            let incidence = faces
                .entry(key([vertices[0], vertices[1], vertices[2]]))
                .or_default();
            incidence.push((e, tet[omitted]));
            require(
                incidence.len() <= 2,
                "current source has nonmanifold tetrahedral face incidence",
            )?;
        }
    }
    require(
        used.iter().all(|used| *used),
        "current source contains unused vertices",
    )?;
    let id_to_node: BTreeMap<_, _> = ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    let mut interior_element_pairs = Vec::new();
    for (face, adjacent) in &faces {
        if adjacent.len() == 2 {
            let a = face.map(|id| mesh.nodes[id_to_node[&id]]);
            let s0 = side([a[0], a[1], a[2], mesh.nodes[adjacent[0].1 as usize]])?;
            let s1 = side([a[0], a[1], a[2], mesh.nodes[adjacent[1].1 as usize]])?;
            require(
                s0.is_sign_positive() != s1.is_sign_positive(),
                "current source adjacent tetrahedra lie on the same face side",
            )?;
            interior_element_pairs.push([adjacent[0].0, adjacent[1].0]);
        }
    }
    let exterior: BTreeMap<_, _> = faces
        .into_iter()
        .filter(|(_, a)| a.len() == 1)
        .map(|(f, a)| (f, a[0]))
        .collect();
    let declared = mesh.require_tri3_boundary_faces().map_err(fail)?;
    let declared_keys: BTreeSet<_> = declared
        .iter()
        .map(|f| key(f.map(|v| ids[v as usize])))
        .collect();
    require(
        declared_keys.len() == declared.len()
            && declared_keys == exterior.keys().copied().collect(),
        "current source facets must exactly cover actual manifold exterior",
    )?;
    Ok(Topology {
        tets,
        exterior,
        interior_element_pairs,
    })
}

fn ranges(start: u32, count: u32, length: usize) -> Result<std::ops::Range<usize>, PlanError> {
    let end = start
        .checked_add(count)
        .ok_or_else(|| fail("current source ownership range overflow"))? as usize;
    require(
        count > 0 && end <= length,
        "current source ownership range is empty or foreign",
    )?;
    Ok(start as usize..end)
}
fn owners(
    mesh: &MeshIR,
    topology: &Topology,
    ids: &[u64],
    segments: &[FemObjectSegmentIR],
    definition: &ChargeTransportDefinitionIR,
) -> Result<(Vec<String>, Vec<f64>), PlanError> {
    let mut node_owner = vec![None; mesh.nodes.len()];
    let mut element_owner = vec![None; mesh.cell_count()];
    let mut face_owner = vec![None; mesh.facet_count()];
    let mut objects = BTreeSet::new();
    for s in segments {
        require(
            text(&s.object_id) && objects.insert(s.object_id.as_str()),
            "current source requires unique immutable object segment IDs",
        )?;
        for (indices, owner) in [
            (
                ranges(s.node_start, s.node_count, node_owner.len())?,
                &mut node_owner,
            ),
            (
                ranges(s.element_start, s.element_count, element_owner.len())?,
                &mut element_owner,
            ),
            (
                ranges(
                    s.boundary_face_start,
                    s.boundary_face_count,
                    face_owner.len(),
                )?,
                &mut face_owner,
            ),
        ] {
            for i in indices {
                require(
                    owner[i].replace(s.object_id.clone()).is_none(),
                    "current source has overlapping object ownership",
                )?;
            }
        }
    }
    require(
        node_owner
            .iter()
            .chain(&element_owner)
            .chain(&face_owner)
            .all(Option::is_some),
        "current source requires complete exact vertex/element/facet ownership",
    )?;
    let domain: BTreeSet<_> = definition
        .domain
        .iter()
        .map(|r| r.object_id.as_str())
        .collect();
    require(
        domain == objects
            && domain.len() == definition.domain.len()
            && definition.domain.iter().all(|r| r.region_id.is_none()),
        "current source domain must exactly match whole immutable object segments",
    )?;
    let mut materials = BTreeMap::new();
    for a in &definition.materials {
        let m = &a.material;
        require(
            a.region.region_id.is_none()
                && objects.contains(a.region.object_id.as_str())
                && m.sigma_spm.is_finite()
                && m.sigma_spm > 0.
                && m.sigma_parallel_spm.is_none()
                && m.sigma_perpendicular_spm.is_none()
                && m.sigma_ahe_spm.is_none()
                && materials
                    .insert(a.region.object_id.as_str(), m.sigma_spm)
                    .is_none(),
            "current source requires exactly one finite positive scalar material per object",
        )?;
    }
    require(
        materials.len() == objects.len(),
        "current source materials do not completely cover device objects",
    )?;
    let element_owner: Vec<_> = element_owner.into_iter().map(Option::unwrap).collect();
    for (e, tet) in topology.tets.iter().enumerate() {
        require(
            tet.iter()
                .all(|v| node_owner[*v as usize].as_ref() == Some(&element_owner[e])),
            "current source tetrahedron crosses immutable object ownership",
        )?;
    }
    for (i, facet) in mesh
        .require_tri3_boundary_faces()
        .map_err(fail)?
        .iter()
        .enumerate()
    {
        let e = topology.exterior[&key(facet.map(|v| ids[v as usize]))].0;
        require(
            face_owner[i].as_ref() == Some(&element_owner[e]),
            "current source boundary face has wrong immutable object owner",
        )?;
    }
    let sigma = element_owner
        .iter()
        .map(|id| materials[id.as_str()])
        .collect();
    Ok((element_owner, sigma))
}

fn append_mesh(device: &MeshIR, lead: &MeshIR) -> Result<MeshIR, PlanError> {
    let ne = device
        .cell_count()
        .checked_add(lead.cell_count())
        .ok_or_else(|| fail("combined element count overflows"))?;
    let nv = device
        .nodes
        .len()
        .checked_add(lead.nodes.len())
        .ok_or_else(|| fail("combined vertex count overflows"))?;
    let nf = device
        .facet_count()
        .checked_add(lead.facet_count())
        .ok_or_else(|| fail("combined facet count overflows"))?;
    require(
        ne <= MAX_ELEMENTS && nv <= 4 * ne && nf <= 4 * ne,
        "combined current source exceeds bounded native support",
    )?;
    let offset =
        u32::try_from(device.nodes.len()).map_err(|_| fail("combined node offset overflows"))?;
    let mut cells = device.require_tet4_elements().map_err(fail)?;
    for tet in lead.require_tet4_elements().map_err(fail)? {
        let mut mapped = [0; 4];
        for i in 0..4 {
            mapped[i] = tet[i]
                .checked_add(offset)
                .ok_or_else(|| fail("combined cell connectivity overflows"))?;
        }
        cells.push(mapped);
    }
    let mut faces = device.require_tri3_boundary_faces().map_err(fail)?;
    for face in lead.require_tri3_boundary_faces().map_err(fail)? {
        let mut mapped = [0; 3];
        for i in 0..3 {
            mapped[i] = face[i]
                .checked_add(offset)
                .ok_or_else(|| fail("combined facet connectivity overflows"))?;
        }
        faces.push(mapped);
    }
    Ok(MeshIR {
        mesh_name: "antenna-current-source-combined".into(),
        nodes: device.nodes.iter().chain(&lead.nodes).copied().collect(),
        cells: FemConnectivityIR::from_tet4(cells),
        element_markers: device
            .element_markers
            .iter()
            .chain(&lead.element_markers)
            .copied()
            .collect(),
        facets: FemFacetConnectivityIR::from_tri3(faces),
        boundary_markers: device
            .boundary_markers
            .iter()
            .chain(&lead.boundary_markers)
            .copied()
            .collect(),
        periodic_boundary_pairs: vec![],
        periodic_node_pairs: vec![],
        per_domain_quality: Default::default(),
    })
}

fn validate_terminal_face_closure(
    exterior: impl IntoIterator<Item = [u64; 3]>,
    terminals: &[CurrentSourceOuterTerminalIR],
) -> Result<(), PlanError> {
    let mut requested_faces = BTreeMap::new();
    let mut essential_vertices = BTreeMap::new();
    for (terminal, definition) in terminals.iter().enumerate() {
        for face in &definition.boundary_face_vertex_ids {
            require(
                requested_faces.insert(*face, terminal).is_none(),
                "outer terminal repeats an essential boundary face",
            )?;
            for vertex in face {
                let previous = essential_vertices.insert(*vertex, terminal);
                require(
                    previous.is_none_or(|owner| owner == terminal),
                    "outer terminals share an essential P1 vertex",
                )?;
            }
        }
    }
    // Affine conforming Tet4/P1 has one scalar DOF per actual vertex.
    for face in exterior {
        let [Some(a), Some(b), Some(c)] = face.map(|v| essential_vertices.get(&v).copied()) else {
            continue;
        };
        require(
            a == b && b == c,
            "electrode separator face has no free P1 vertex",
        )?;
        require(
            requested_faces.get(&face) == Some(&a),
            "outer terminal face list is not closed under its essential P1 vertices",
        )?;
    }
    Ok(())
}

fn validate_independent_terminal_control_budget(
    terminal_counts: impl IntoIterator<Item = usize>,
) -> Result<(), PlanError> {
    let count = terminal_counts
        .into_iter()
        .try_fold(0usize, |sum, terminals| {
            let nonreference = terminals
                .checked_sub(1)
                .ok_or_else(|| fail("terminal component has no reference electrode"))?;
            sum.checked_add(nonreference)
                .ok_or_else(|| fail("independent terminal control count overflows"))
        })?;
    require(
        count <= 64,
        "current source exceeds 64 independent terminal controls",
    )
}

struct UnionFind(Vec<usize>);
impl UnionFind {
    fn root(&mut self, mut i: usize) -> usize {
        while self.0[i] != i {
            self.0[i] = self.0[self.0[i]];
            i = self.0[i];
        }
        i
    }
    fn join(&mut self, a: usize, b: usize) {
        let a = self.root(a);
        let b = self.root(b);
        if a != b {
            self.0[b] = a;
        }
    }
}

fn validate_physical_p1_component_bijection(
    device: &Topology,
    lead: &Topology,
    interfaces: &[fullmag_ir::CurrentSourceInterfacePairIR],
    device_vertex_count: usize,
    p1_roots: &[usize],
) -> Result<(), PlanError> {
    let element_count = device
        .tets
        .len()
        .checked_add(lead.tets.len())
        .ok_or_else(|| fail("physical component element count overflows"))?;
    require(
        element_count > 0 && element_count <= MAX_ELEMENTS,
        "physical component graph exceeds bounded native support",
    )?;
    let mut physical = UnionFind((0..element_count).collect());
    for [a, b] in &device.interior_element_pairs {
        physical.join(*a, *b);
    }
    for [a, b] in &lead.interior_element_pairs {
        let a = device
            .tets
            .len()
            .checked_add(*a)
            .ok_or_else(|| fail("physical lead element offset overflows"))?;
        let b = device
            .tets
            .len()
            .checked_add(*b)
            .ok_or_else(|| fail("physical lead element offset overflows"))?;
        physical.join(a, b);
    }
    for pair in interfaces {
        let a = device.exterior[&pair.device_face_vertex_ids].0;
        let b = device
            .tets
            .len()
            .checked_add(lead.exterior[&pair.lead_face_vertex_ids].0)
            .ok_or_else(|| fail("physical interface element offset overflows"))?;
        physical.join(a, b);
    }
    let mut physical_to_p1 = BTreeMap::new();
    let mut p1_to_physical = BTreeMap::new();
    for (element, tet) in device.tets.iter().chain(&lead.tets).enumerate() {
        let physical_root = physical.root(element);
        let offset = if element < device.tets.len() {
            0
        } else {
            device_vertex_count
        };
        for vertex in tet {
            let global = offset
                .checked_add(*vertex as usize)
                .ok_or_else(|| fail("physical/P1 vertex offset overflows"))?;
            let p1_root = *p1_roots
                .get(global)
                .ok_or_else(|| fail("physical/P1 component mapping has foreign vertex"))?;
            let old_p1 = physical_to_p1.insert(physical_root, p1_root);
            let old_physical = p1_to_physical.insert(p1_root, physical_root);
            require(old_p1.is_none_or(|old| old == p1_root)
                && old_physical.is_none_or(|old| old == physical_root),
                "physical/P1 component correspondence is not bijective; vertex or edge contact cannot short volumes")?;
        }
    }
    Ok(())
}
#[derive(Default)]
struct Sum {
    value: f64,
    correction: f64,
}
impl Sum {
    fn add(&mut self, x: f64) -> Result<(), PlanError> {
        let sum = self.value + x;
        let delta = if self.value.abs() >= x.abs() {
            (self.value - sum) + x
        } else {
            (x - sum) + self.value
        };
        self.correction += delta;
        self.value = sum;
        require(
            self.value.is_finite() && self.correction.is_finite(),
            "current source component current accumulation overflows",
        )
    }
    fn total(&self) -> Result<f64, PlanError> {
        let value = self.value + self.correction;
        require(
            value.is_finite(),
            "current source component current accumulation overflows",
        )?;
        Ok(value)
    }
}

pub fn materialize_antenna_external_lead_current_input(
    device_mesh: &MeshIR,
    object_segments: &[FemObjectSegmentIR],
    definition: &ChargeTransportDefinitionIR,
    stage: &AntennaFieldSolveStageIR,
    port: &AntennaPortModeIR,
    field_sampling: &AntennaFieldSamplingPlanIR,
) -> Result<ResolvedAntennaExternalLeadCurrentInputIR, PlanError> {
    require(
        device_mesh.cell_count() > 0
            && device_mesh.cell_count() <= MAX_ELEMENTS
            && object_segments.len() <= device_mesh.cell_count()
            && definition.domain.len() <= device_mesh.cell_count()
            && definition.materials.len() <= device_mesh.cell_count(),
        "current source ownership/material counts exceed bounded device support",
    )?;
    require(
        stage.oersted_realization == AntennaOerstedRealizationIR::DirectTetraQuadrature,
        "current-driven source vector potential is unsupported; direct fallback is forbidden",
    )?;
    require(
        stage
            .conservative_current_view_ref
            .as_deref()
            .is_none_or(text),
        "current source stage conservative_current_view_ref must be non-empty when present",
    )?;
    require(text(&stage.id) && text(&port.id) && stage.source_object_id == port.source_object_id
        && text(&stage.current_transport_id) && stage.current_transport_id == port.current_transport_id
        && stage.port_mode_ids == [port.id.clone()] && port.schema_version == "antenna_port_mode.v2"
        && stage.model == AntennaFieldModelIR::QuasistaticConductionBiotSavart3d
        && stage.conductor_mesh_policy == "authored_shared_domain" && stage.solver_policy == "production_default"
        && port.normalization_current_a == 1., "current source requires matching single stage/port and authored_shared_domain direct 1 A basis")?;
    require(
        definition.boundaries.is_empty()
            && definition.conservative_current_view.is_none()
            && definition.structured_current_closure.is_none()
            && definition.gauge == ChargePotentialGaugeIR::TerminalReference,
        "current source cannot mix legacy boundary/view/closure or nonterminal gauge",
    )?;
    let s = &definition.solver;
    require(
        s.engine == "cg"
            && s.operator_version == "fem_charge_conforming_h1_p1.transparent.v1"
            && s.physical_residual_version == "charge_balance_integrated_l2.v1"
            && s.linear.relative_tolerance.is_finite()
            && s.linear.relative_tolerance > 0.
            && s.linear.relative_tolerance < 1.
            && s.linear.absolute_tolerance == 0.
            && s.linear.max_iterations > 0
            && s.linear.max_iterations <= i32::MAX as u32,
        "current source requires supported finite conforming H1 CG solver policy",
    )?;
    let source = definition
        .conservative_current_source
        .as_ref()
        .ok_or_else(|| fail("current source input is absent"))?;
    let ConservativeCurrentSourceIR::ExternalLeadCurrent {
        device_stable_vertex_ids: device_ids,
        lead_mesh,
        lead_stable_vertex_ids: lead_ids,
        lead_conductivity_spm_per_element: lead_sigma,
        interface_pairs,
        outer_terminals,
        terminal_observations,
        drives,
        ..
    } = source;
    require(
        lead_mesh.cells.nodes.len() <= 4 * MAX_ELEMENTS
            && lead_mesh.facets.nodes.len() <= 12 * MAX_ELEMENTS,
        "current source lead CSR storage exceeds bounded native support",
    )?;
    let errors = source.validation_errors("conservative_current_source");
    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }
    let dt = topology(device_mesh, device_ids)?;
    let lt = topology(lead_mesh, lead_ids)?;
    let (element_owners, mut sigma) =
        owners(device_mesh, &dt, device_ids, object_segments, definition)?;
    require(
        object_segments
            .iter()
            .any(|s| s.object_id == port.source_object_id),
        "port source object is not an actual conductor owner",
    )?;
    let matches: Vec<_> = drives
        .iter()
        .filter(|d| d.port_mode_ref == port.id)
        .collect();
    require(
        matches.len() == 1,
        "current source selected port requires exactly one explicit drive",
    )?;
    let drive = matches[0];
    let device_index: BTreeMap<_, _> = device_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (*id, i))
        .collect();
    let lead_index: BTreeMap<_, _> = lead_ids
        .iter()
        .enumerate()
        .map(|(i, id)| (*id, i))
        .collect();
    let mut roles = BTreeMap::<[u64; 3], (AntennaCurrentBoundaryRoleIR, String)>::new();
    for pair in interface_pairs {
        let a = dt
            .exterior
            .get(&pair.device_face_vertex_ids)
            .ok_or_else(|| fail("interface device face is not actual exterior"))?;
        let b = lt
            .exterior
            .get(&pair.lead_face_vertex_ids)
            .ok_or_else(|| fail("interface lead face is not actual exterior"))?;
        for [v, w] in pair.vertex_pairs {
            require(
                device_mesh.nodes[device_index[&v]] == lead_mesh.nodes[lead_index[&w]],
                "interface explicit vertex map is not exactly coincident",
            )?;
        }
        let face = pair
            .device_face_vertex_ids
            .map(|v| device_mesh.nodes[device_index[&v]]);
        let sa = side([face[0], face[1], face[2], device_mesh.nodes[a.1 as usize]])?;
        let sb = side([face[0], face[1], face[2], lead_mesh.nodes[b.1 as usize]])?;
        require(
            sa.is_sign_positive() != sb.is_sign_positive(),
            "interface explicit map does not have opposite outward sides",
        )?;
        for face in [pair.device_face_vertex_ids, pair.lead_face_vertex_ids] {
            require(
                roles
                    .insert(
                        face,
                        (
                            AntennaCurrentBoundaryRoleIR::DeviceLeadInterface,
                            pair.id.clone(),
                        ),
                    )
                    .is_none(),
                "interface repeats a physical boundary face",
            )?;
        }
    }
    validate_terminal_face_closure(lt.exterior.keys().copied(), outer_terminals)?;
    let combined = append_mesh(device_mesh, lead_mesh)?;
    let ids: Vec<_> = device_ids.iter().chain(lead_ids).copied().collect();
    let mut uf = UnionFind((0..ids.len()).collect());
    for tet in &dt.tets {
        for v in &tet[1..] {
            uf.join(tet[0] as usize, *v as usize);
        }
    }
    for tet in &lt.tets {
        for v in &tet[1..] {
            uf.join(
                device_ids.len() + tet[0] as usize,
                device_ids.len() + *v as usize,
            );
        }
    }
    for pair in interface_pairs {
        for [a, b] in pair.vertex_pairs {
            uf.join(device_index[&a], device_ids.len() + lead_index[&b]);
        }
    }
    let roots: Vec<_> = (0..ids.len()).map(|i| uf.root(i)).collect();
    validate_physical_p1_component_bijection(&dt, &lt, interface_pairs, device_ids.len(), &roots)?;
    let mut minimum = BTreeMap::new();
    let mut support = BTreeMap::<usize, (bool, bool, usize, Sum, Sum)>::new();
    for (i, root) in roots.iter().enumerate() {
        minimum
            .entry(*root)
            .and_modify(|m: &mut u64| *m = (*m).min(ids[i]))
            .or_insert(ids[i]);
        let entry = support.entry(*root).or_default();
        if i < device_ids.len() {
            entry.0 = true;
        } else {
            entry.1 = true;
        }
    }
    let component_ids: Vec<_> = roots.iter().map(|r| minimum[r]).collect();
    let mut terminals = Vec::new();
    for terminal in outer_terminals {
        let current = drive.outer_terminal_currents_a[&terminal.id];
        let roots_for_terminal: BTreeSet<_> = terminal
            .boundary_face_vertex_ids
            .iter()
            .flatten()
            .map(|v| roots[device_ids.len() + lead_index[v]])
            .collect();
        require(
            roots_for_terminal.len() == 1,
            "outer terminal spans electrical components",
        )?;
        let root = *roots_for_terminal.first().unwrap();
        let entry = support.get_mut(&root).unwrap();
        entry.2 = entry
            .2
            .checked_add(1)
            .ok_or_else(|| fail("component terminal count overflows"))?;
        entry.3.add(current)?;
        entry.4.add(current.abs())?;
        for face in &terminal.boundary_face_vertex_ids {
            require(
                roles
                    .insert(
                        *face,
                        (
                            AntennaCurrentBoundaryRoleIR::OuterElectrode,
                            terminal.id.clone(),
                        ),
                    )
                    .is_none(),
                "outer terminal boundary role overlaps an interface",
            )?;
        }
        terminals.push(AntennaOuterTerminalCurrentInputIR {
            id: terminal.id.clone(),
            boundary_face_vertex_ids: terminal.boundary_face_vertex_ids.clone(),
            requested_outward_current_a: current,
            electrical_component_id: minimum[&root],
        });
    }
    for entry in support.values() {
        require(entry.0 && entry.1 && entry.2 >= 2, "each source electrical component requires device, lead and at least two outer terminals")?;
        require(
            entry.3.total()?.abs() <= 1e-18 + 1e-10 * entry.4.total()?,
            "signed outer current imbalance in an electrical component",
        )?;
    }
    validate_independent_terminal_control_budget(support.values().map(|entry| entry.2))?;
    let observations_by_id: BTreeMap<_, _> = terminal_observations
        .iter()
        .map(|o| (o.id.as_str(), o))
        .collect();
    let pairs_by_id: BTreeMap<_, _> = interface_pairs.iter().map(|p| (p.id.as_str(), p)).collect();
    let mut used_observations = BTreeSet::new();
    let mut branch_ids = BTreeSet::new();
    let mut observations = Vec::new();
    require(
        !port.branches.is_empty() && port.branches.len() <= terminal_observations.len() / 2,
        "current source port branch count must fit explicit observation support",
    )?;
    let mut weight_sum = Sum::default();
    let mut positive_weight = Sum::default();
    let mut negative = false;
    for branch in &port.branches {
        require(
            text(&branch.id)
                && branch_ids.insert(branch.id.as_str())
                && branch.signed_weight.is_finite()
                && branch.signed_weight != 0.,
            "current source port requires unique branches with finite nonzero signed weights",
        )?;
        weight_sum.add(branch.signed_weight)?;
        if branch.signed_weight > 0. {
            positive_weight.add(branch.signed_weight)?;
        } else {
            negative = true;
        }
        let inlet = observations_by_id
            .get(branch.inlet_terminal_ref.as_str())
            .ok_or_else(|| fail("current source port references unknown observation"))?;
        let outlet = observations_by_id
            .get(branch.outlet_terminal_ref.as_str())
            .ok_or_else(|| fail("current source port references unknown observation"))?;
        require(inlet.object_id == outlet.object_id && (branch.signed_weight < 0. || inlet.object_id == port.source_object_id), "port observation endpoints must belong to the same object; positive branch must observe source object")?;
        for (id, endpoint, sign) in [
            (
                &branch.inlet_terminal_ref,
                AntennaCurrentObservationEndpointIR::Inlet,
                -1.,
            ),
            (
                &branch.outlet_terminal_ref,
                AntennaCurrentObservationEndpointIR::Outlet,
                1.,
            ),
        ] {
            require(
                used_observations.insert(id.as_str()),
                "current source port repeats an observation endpoint",
            )?;
            let observation = observations_by_id
                .get(id.as_str())
                .ok_or_else(|| fail("current source port references unknown observation"))?;
            let mut components = BTreeSet::new();
            for pair_id in &observation.interface_pair_ids {
                let pair = pairs_by_id[pair_id.as_str()];
                let element = dt.exterior[&pair.device_face_vertex_ids].0;
                require(
                    element_owners[element] == observation.object_id,
                    "observation interface has wrong immutable object owner",
                )?;
                components.insert(component_ids[device_index[&pair.device_face_vertex_ids[0]]]);
            }
            require(
                components.len() == 1,
                "observation spans electrical components",
            )?;
            observations.push(AntennaCurrentObservationInputIR {
                id: observation.id.clone(),
                object_id: observation.object_id.clone(),
                port_branch_id: branch.id.clone(),
                endpoint,
                interface_pair_ids: observation.interface_pair_ids.clone(),
                requested_device_outward_current_a: sign * branch.signed_weight,
                electrical_component_id: *components.first().unwrap(),
            });
        }
    }
    require(
        used_observations == observations_by_id.keys().copied().collect(),
        "selected port must cover every source observation exactly once",
    )?;
    require(
        negative
            && weight_sum.total()?.abs() <= 1e-12
            && (positive_weight.total()? - 1.).abs() <= 1e-12,
        "port weights must have positive sum one and total sum zero",
    )?;
    for face in dt.exterior.keys().chain(lt.exterior.keys()) {
        roles
            .entry(*face)
            .or_insert((AntennaCurrentBoundaryRoleIR::Insulating, String::new()));
    }
    let boundary_roles: Vec<_> = roles
        .into_iter()
        .map(
            |(vertex_ids, (role, circuit_id))| AntennaCurrentBoundaryInputIR {
                vertex_ids,
                role,
                circuit_id,
            },
        )
        .collect();
    require(
        field_sampling.domain == stage.field_sampling_domain
            && text(&field_sampling.carrier_kind)
            && field_sampling.location == "node"
            && field_sampling
                .topology_digest
                .strip_prefix("sha256:")
                .is_some_and(|hash| {
                    hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_hexdigit())
                })
            && !field_sampling.positions_xyz_m.is_empty()
            && field_sampling
                .positions_xyz_m
                .iter()
                .flatten()
                .all(|x| x.is_finite()),
        "current source requires finite matching actual field sampling carrier",
    )?;
    let pairs = u64::try_from(combined.cell_count())
        .ok()
        .and_then(|n| {
            u64::try_from(field_sampling.positions_xyz_m.len())
                .ok()
                .and_then(|t| n.checked_mul(t))
        })
        .ok_or_else(|| fail("combined source/target pair count overflows"))?;
    require(pairs <= MAX_PAIRS, "combined current source/target pair budget exceeded; no vector-potential fallback is available")?;
    let cells = &field_sampling.cells;
    require(
        !cells.is_empty() && cells.len() <= MAX_ELEMENTS && cells.nodes.len() <= 4 * cells.len(),
        "current source field sampling requires nonempty bounded Tet4 connectivity",
    )?;
    for tet in cells.require_tet4().map_err(fail)? {
        require(
            tet.iter()
                .all(|v| (*v as usize) < field_sampling.positions_xyz_m.len()),
            "current source field sampling connectivity has out-of-bounds vertices",
        )?;
        require(
            side(tet.map(|v| field_sampling.positions_xyz_m[v as usize]))? > 0.,
            "current source field sampling requires positively oriented Tet4 geometry",
        )?;
    }
    let policy = AntennaDirectFieldInputPolicyIR {
        policy_version: fullmag_ir::antenna_current_source::ANTENNA_EXTERNAL_LEAD_DIRECT_POLICY_VERSION.into(),
        base_quadrature_order: fullmag_ir::ANTENNA_DIRECT_OERSTED_BASE_QUADRATURE_ORDER,
        maximum_subdivision_depth: fullmag_ir::ANTENNA_DIRECT_OERSTED_MAX_SUBDIVISION_DEPTH,
        absolute_tolerance_apm: fullmag_ir::ANTENNA_DIRECT_OERSTED_ABSOLUTE_TOLERANCE_APM,
        relative_tolerance: fullmag_ir::ANTENNA_DIRECT_OERSTED_RELATIVE_TOLERANCE,
        maximum_source_target_pairs: MAX_PAIRS,
        source_target_pairs: pairs,
        relative_scale_floor_apm: 0.,
    };
    sigma.extend(lead_sigma);
    let mut pins = AntennaCurrentInputPinsIR {
        schema_version: "antenna_current_input_pins.canonical_json.v1".into(),
        authored_source_sha256: pin(source)?,
        device_mesh_ownership_sha256: pin(&(device_mesh, object_segments))?,
        selected_control_sha256: pin(&(stage, port, drive, &observations))?,
        combined_mesh_material_sha256: pin(&(&combined, &ids, &sigma, &boundary_roles))?,
        solver_sampling_sha256: pin(&(s, &policy, field_sampling))?,
        materialized_input_sha256: String::new(),
    };
    pins.materialized_input_sha256 = pin(&(
        &pins.schema_version,
        definition,
        device_mesh,
        object_segments,
        stage,
        port,
        drive,
        &combined,
        &ids,
        &sigma,
        &boundary_roles,
        &observations,
        &component_ids,
        &policy,
        field_sampling,
    ))?;
    Ok(ResolvedAntennaExternalLeadCurrentInputIR {
        schema_version: ANTENNA_EXTERNAL_LEAD_CURRENT_INPUT_SCHEMA.into(), field_scope: "external_electrode_truncation".into(),
        stage: stage.clone(), port: port.clone(), authored_definition: definition.clone(), original_device_mesh: device_mesh.clone(), device_object_segments: object_segments.to_vec(), selected_drive: drive.clone(), combined_mesh: combined,
        combined_stable_vertex_ids: ids, device_stable_vertex_ids: device_ids.clone(), lead_stable_vertex_ids: lead_ids.clone(), conductivity_spm_per_element: sigma, device_element_count: device_mesh.cell_count() as u32,
        combined_runtime_ordinal_policy: "concatenated_device_then_lead.v1; original ordinals, mesh parts and quality retained only in original inputs".into(),
        interfaces: interface_pairs.clone(), outer_terminals: terminals, boundary_roles, observations, electrical_component_ids_per_vertex: component_ids,
        solver: s.clone(), direct_field_policy: policy, field_sampling: field_sampling.clone(), pins,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        AntennaFieldModelIR, AntennaPortBranchV2IR, ChargeSolverPolicyIR,
        ChargeTransportMaterialAssignmentIR, ChargeTransportMaterialIR, CurrentSourceDriveIR,
        CurrentSourceInterfacePairIR, CurrentSourceOuterTerminalIR,
        CurrentSourceTerminalObservationIR, FieldTargetIR, LinearTransportSolverPolicyIR,
        MeshQualityIR, RegionRefIR,
    };
    struct Fixture {
        device: MeshIR,
        segments: Vec<FemObjectSegmentIR>,
        definition: ChargeTransportDefinitionIR,
        stage: AntennaFieldSolveStageIR,
        port: AntennaPortModeIR,
        sampling: AntennaFieldSamplingPlanIR,
    }
    impl Fixture {
        fn resolve(&self) -> Result<ResolvedAntennaExternalLeadCurrentInputIR, PlanError> {
            materialize_antenna_external_lead_current_input(
                &self.device,
                &self.segments,
                &self.definition,
                &self.stage,
                &self.port,
                &self.sampling,
            )
        }
        fn source(&mut self) -> &mut ConservativeCurrentSourceIR {
            self.definition
                .conservative_current_source
                .as_mut()
                .unwrap()
        }
    }
    fn mesh(blocks: &[[f64; 3]], marker: u32) -> MeshIR {
        let mut nodes = Vec::new();
        let mut cells = Vec::new();
        for [x, y, z] in blocks {
            let offset = nodes.len() as u32;
            for k in 0..3 {
                for j in 0..3 {
                    for i in 0..3 {
                        nodes.push([x + i as f64 / 2., y + j as f64 / 2., z + k as f64 / 2.]);
                    }
                }
            }
            let vertex = |i: u32, j: u32, k: u32| offset + i + 3 * j + 9 * k;
            for k in 0..2 {
                for j in 0..2 {
                    for i in 0..2 {
                        let c = [
                            vertex(i, j, k),
                            vertex(i + 1, j, k),
                            vertex(i + 1, j + 1, k),
                            vertex(i, j + 1, k),
                            vertex(i, j, k + 1),
                            vertex(i + 1, j, k + 1),
                            vertex(i + 1, j + 1, k + 1),
                            vertex(i, j + 1, k + 1),
                        ];
                        for tet in [
                            [0, 1, 2, 6],
                            [0, 2, 3, 6],
                            [0, 3, 7, 6],
                            [0, 7, 4, 6],
                            [0, 4, 5, 6],
                            [0, 5, 1, 6],
                        ] {
                            cells.push(tet.map(|v| c[v]));
                        }
                    }
                }
            }
        }
        let mut incidence = BTreeMap::new();
        for [a, b, c, d] in &cells {
            for mut f in [[*a, *b, *c], [*a, *b, *d], [*a, *c, *d], [*b, *c, *d]] {
                f.sort_unstable();
                *incidence.entry(f).or_insert(0) += 1;
            }
        }
        let faces: Vec<_> = incidence
            .into_iter()
            .filter(|(_, n)| *n == 1)
            .map(|(f, _)| f)
            .collect();
        MeshIR::from_legacy_tet4(
            "fixture".into(),
            nodes,
            cells.clone(),
            vec![marker; cells.len()],
            faces.clone(),
            vec![marker + 1; faces.len()],
            vec![],
            vec![],
            Default::default(),
        )
    }
    fn plane(mesh: &MeshIR, ids: &[u64], x: f64, y: f64) -> Vec<[u64; 3]> {
        mesh.require_tri3_boundary_faces()
            .unwrap()
            .into_iter()
            .filter(|f| {
                f.iter().all(|v| {
                    mesh.nodes[*v as usize][0] == x
                        && (y..=y + 1.).contains(&mesh.nodes[*v as usize][1])
                })
            })
            .map(|f| key(f.map(|v| ids[v as usize])))
            .collect()
    }
    fn fixture() -> Fixture {
        let device = mesh(&[[0., 0., 0.], [0., 2., 0.]], 7);
        let lead = mesh(
            &[[-1., 0., 0.], [1., 0., 0.], [-1., 2., 0.], [1., 2., 0.]],
            19,
        );
        let device_ids: Vec<_> = (0..device.nodes.len()).map(|i| 500 - i as u64).collect();
        let lead_ids: Vec<_> = (0..lead.nodes.len()).map(|i| 1000 + i as u64).collect();
        let device_index: BTreeMap<_, _> = device_ids
            .iter()
            .enumerate()
            .map(|(i, id)| (*id, i))
            .collect();
        let lead_index: BTreeMap<_, _> = lead_ids
            .iter()
            .enumerate()
            .map(|(i, id)| (*id, i))
            .collect();
        let mut interfaces = Vec::new();
        let mut observations = Vec::new();
        let mut terminals = Vec::new();
        let mut currents = BTreeMap::new();
        for (circuit, object, y, direction) in [
            ("signal", "signal-object", 0., 1.),
            ("return", "return-object", 2., -1.),
        ] {
            for (end, x, outer_x, sign) in [("in", 0., -1., -1.), ("out", 1., 2., 1.)] {
                let mut pair_ids = Vec::new();
                for face in plane(&device, &device_ids, x, y) {
                    let target = plane(&lead, &lead_ids, x, y)
                        .into_iter()
                        .find(|lead_face| {
                            face.iter().all(|v| {
                                lead_face.iter().any(|w| {
                                    device.nodes[device_index[v]] == lead.nodes[lead_index[w]]
                                })
                            })
                        })
                        .unwrap();
                    let mut pairs = [[0; 2]; 3];
                    for (i, v) in face.iter().enumerate() {
                        let w = target
                            .iter()
                            .find(|w| device.nodes[device_index[v]] == lead.nodes[lead_index[*w]])
                            .unwrap();
                        pairs[i] = [*v, *w];
                    }
                    let id = format!("{circuit}-{end}-{}", pair_ids.len());
                    pair_ids.push(id.clone());
                    interfaces.push(CurrentSourceInterfacePairIR {
                        id,
                        device_face_vertex_ids: face,
                        lead_face_vertex_ids: target,
                        vertex_pairs: pairs,
                    });
                }
                observations.push(CurrentSourceTerminalObservationIR {
                    id: format!("{circuit}-{end}"),
                    object_id: object.into(),
                    interface_pair_ids: pair_ids,
                });
                let id = format!("outer-{circuit}-{end}");
                terminals.push(CurrentSourceOuterTerminalIR {
                    id: id.clone(),
                    boundary_face_vertex_ids: plane(&lead, &lead_ids, outer_x, y),
                });
                currents.insert(id, sign * direction);
            }
        }
        let source = ConservativeCurrentSourceIR::ExternalLeadCurrent {
            schema_version: "conservative_current_source.v1".into(),
            revision: "fixture-revision".into(),
            device_stable_vertex_ids: device_ids,
            lead_mesh: lead.clone(),
            lead_stable_vertex_ids: lead_ids,
            lead_conductivity_spm_per_element: vec![8.; lead.cell_count()],
            interface_pairs: interfaces,
            outer_terminals: terminals,
            terminal_observations: observations,
            drives: vec![CurrentSourceDriveIR {
                id: "drive".into(),
                port_mode_ref: "port".into(),
                outer_terminal_currents_a: currents,
            }],
        };
        let domain: Vec<_> = ["signal-object", "return-object"]
            .into_iter()
            .map(|id| RegionRefIR {
                object_id: id.into(),
                region_id: None,
            })
            .collect();
        let definition = ChargeTransportDefinitionIR {
            materials: domain
                .iter()
                .map(|r| ChargeTransportMaterialAssignmentIR {
                    region: r.clone(),
                    material: ChargeTransportMaterialIR {
                        sigma_spm: 4.,
                        sigma_parallel_spm: None,
                        sigma_perpendicular_spm: None,
                        sigma_ahe_spm: None,
                    },
                })
                .collect(),
            domain,
            boundaries: vec![],
            gauge: ChargePotentialGaugeIR::TerminalReference,
            solver: ChargeSolverPolicyIR {
                engine: "cg".into(),
                linear: LinearTransportSolverPolicyIR {
                    relative_tolerance: 1e-10,
                    absolute_tolerance: 0.,
                    max_iterations: 1000,
                },
                physical_residual_version: "charge_balance_integrated_l2.v1".into(),
                operator_version: "fem_charge_conforming_h1_p1.transparent.v1".into(),
            },
            conservative_current_source: Some(source),
            conservative_current_view: None,
            structured_current_closure: None,
        };
        let segments = ["signal-object", "return-object"]
            .into_iter()
            .enumerate()
            .map(|(i, id)| FemObjectSegmentIR {
                object_id: id.into(),
                geometry_id: Some("same-presentation-geometry".into()),
                node_start: (i * 27) as u32,
                node_count: 27,
                element_start: (i * 48) as u32,
                element_count: 48,
                boundary_face_start: (i * 48) as u32,
                boundary_face_count: 48,
            })
            .collect();
        let port = AntennaPortModeIR {
            schema_version: "antenna_port_mode.v2".into(),
            id: "port".into(),
            source_object_id: "signal-object".into(),
            current_transport_id: "transport".into(),
            normalization_current_a: 1.,
            branches: [("signal", 1.), ("return", -1.)]
                .into_iter()
                .map(|(id, w)| AntennaPortBranchV2IR {
                    id: id.into(),
                    inlet_terminal_ref: format!("{id}-in"),
                    outlet_terminal_ref: format!("{id}-out"),
                    signed_weight: w,
                })
                .collect(),
        };
        let stage = AntennaFieldSolveStageIR {
            id: "stage".into(),
            source_object_id: port.source_object_id.clone(),
            current_transport_id: port.current_transport_id.clone(),
            port_mode_ids: vec![port.id.clone()],
            conservative_current_view_ref: None,
            model: AntennaFieldModelIR::QuasistaticConductionBiotSavart3d,
            oersted_realization: AntennaOerstedRealizationIR::DirectTetraQuadrature,
            conductor_mesh_policy: "authored_shared_domain".into(),
            field_sampling_domain: FieldTargetIR::Global {},
            target_refs: vec![],
            solver_policy: "production_default".into(),
            outputs: vec![],
        };
        let sampling = AntennaFieldSamplingPlanIR {
            domain: FieldTargetIR::Global {},
            carrier_kind: "fem_mesh".into(),
            location: "node".into(),
            topology_digest: format!("sha256:{}", "a".repeat(64)),
            positions_xyz_m: vec![[0., 0., 2.], [1., 0., 2.], [0., 1., 2.], [0., 0., 3.]],
            cells: FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
        };
        Fixture {
            device,
            segments,
            definition,
            stage,
            port,
            sampling,
        }
    }
    fn rejected(f: &Fixture, fragment: &str) {
        let error = f.resolve().unwrap_err().to_string();
        assert!(error.contains(fragment), "{error}");
    }
    fn branch_geometry(name: &str, y: f64) -> fullmag_ir::GeometryEntryIR {
        fullmag_ir::GeometryEntryIR::Translate {
            name: name.into(),
            base: Box::new(fullmag_ir::GeometryEntryIR::Box {
                name: format!("{name}-box"),
                size: [1., 1., 1.],
            }),
            by: [0.5, y + 0.5, 0.5],
        }
    }
    fn public_inspection_fixture() -> (fullmag_ir::ProblemIR, Fixture) {
        let mut f = fixture();
        let region = RegionRefIR {
            object_id: "device-object".into(),
            region_id: None,
        };
        f.definition.domain = vec![region.clone()];
        f.definition.materials.truncate(1);
        f.definition.materials[0].region = region;
        let ConservativeCurrentSourceIR::ExternalLeadCurrent {
            terminal_observations,
            ..
        } = f.source();
        for observation in terminal_observations {
            observation.object_id = "device-object".into();
        }
        f.port.source_object_id = "device-object".into();
        f.stage.source_object_id = "device-object".into();
        f.stage.field_sampling_domain = FieldTargetIR::Object {
            object_id: "device-object".into(),
        };
        f.stage.outputs = vec![fullmag_ir::AntennaNamedOutputIR {
            id: "inspection-output".into(),
            quantity: "H_ant_basis".into(),
        }];
        f.segments = vec![FemObjectSegmentIR {
            object_id: "device-object".into(),
            geometry_id: Some("strip".into()),
            node_start: 0,
            node_count: f.device.nodes.len() as u32,
            element_start: 0,
            element_count: f.device.cell_count() as u32,
            boundary_face_start: 0,
            boundary_face_count: f.device.facet_count() as u32,
        }];
        f.sampling = AntennaFieldSamplingPlanIR {
            domain: f.stage.field_sampling_domain.clone(),
            carrier_kind: "fem_mesh_asset:strip".into(),
            location: "node".into(),
            topology_digest: format!(
                "sha256:{:x}",
                Sha256::digest(serde_json::to_vec(&f.device).unwrap())
            ),
            positions_xyz_m: f.device.nodes.clone(),
            cells: f.device.cells.clone(),
        };
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.geometry.entries = vec![fullmag_ir::GeometryEntryIR::Union {
            name: "strip".into(),
            a: Box::new(branch_geometry("signal", 0.)),
            b: Box::new(branch_geometry("return", 2.)),
        }];
        problem.magnets[0].object_id = Some("device-object".into());
        problem.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fem;
        problem.current_modules = vec![fullmag_ir::CurrentModuleIR::CurrentTransport {
            name: "transport".into(),
            model: fullmag_ir::CurrentTransportModelIR::OhmicPoisson,
            current_density: None,
            solve_region: None,
            conductivity_s_per_m: None,
            coupling: fullmag_ir::TransportCouplingIR::OneWay,
            time_envelope: None,
            definition: Some(f.definition.clone()),
        }];
        problem.antenna_port_modes = vec![f.port.clone()];
        problem.antenna_field_solve_stages = vec![f.stage.clone()];
        problem.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
            fem_mesh_assets: vec![fullmag_ir::FemMeshAssetIR {
                geometry_name: "strip".into(),
                mesh_source: None,
                mesh: Some(f.device.clone()),
            }],
            ..Default::default()
        });
        assert!(problem.validate().is_ok(), "{:?}", problem.validate());
        (problem, f)
    }
    fn reject_public_inspection(problem: &fullmag_ir::ProblemIR, fragment: &str) {
        assert!(problem.validate().is_ok(), "{:?}", problem.validate());
        let error = crate::plan_antenna_field_solve_execution(problem, "stage", "port")
            .unwrap_err()
            .to_string();
        assert!(error.contains(fragment), "{error}");
    }
    #[test]
    fn inspection_execution_preserves_original_disconnected_device_and_requested_intent() {
        let (mut problem, f) = public_inspection_fixture();
        let expected = f.resolve().unwrap();
        for (device, requested_device) in [
            ("auto", fullmag_ir::ExecutionDevice::Auto),
            ("cpu", fullmag_ir::ExecutionDevice::Cpu),
        ] {
            problem.problem_meta.runtime_metadata.insert(
                "runtime_selection".into(),
                serde_json::json!({"device": device}),
            );
            let crate::AntennaFieldSolveExecutionPlan::ExternalLeadInspection {
                input,
                requested_execution,
                output_id,
            } = crate::plan_antenna_field_solve_execution(&problem, "stage", "port").unwrap()
            else {
                panic!("current-driven source was incorrectly promoted to a legacy basis");
            };
            assert_eq!(input, expected);
            assert_eq!(input.original_device_mesh, f.device);
            assert_eq!(input.device_object_segments, f.segments);
            assert_eq!(
                input
                    .electrical_component_ids_per_vertex
                    .iter()
                    .copied()
                    .collect::<BTreeSet<_>>()
                    .len(),
                2
            );
            assert_eq!(output_id, "inspection-output");
            assert_eq!(requested_execution.device, requested_device);
            assert_eq!(
                requested_execution.discretization,
                fullmag_ir::BackendTarget::Fem
            );
            assert_eq!(
                requested_execution.precision,
                fullmag_ir::ExecutionPrecision::Double
            );
            assert_eq!(
                requested_execution.execution_mode,
                fullmag_ir::ExecutionMode::Strict
            );
            let legacy_error = crate::plan_antenna_field_solve(&problem, "stage", "port")
                .unwrap_err()
                .to_string();
            assert!(
                legacy_error.contains("source_not_qualified"),
                "{legacy_error}"
            );
        }
    }
    #[test]
    fn inspection_execution_refuses_gpu_single_and_extended_without_fallback() {
        let (problem, _) = public_inspection_fixture();
        crate::plan_antenna_field_solve_execution(&problem, "stage", "port").unwrap();
        let mut gpu = problem.clone();
        gpu.problem_meta.runtime_metadata.insert(
            "runtime_selection".into(),
            serde_json::json!({"device": "gpu"}),
        );
        reject_public_inspection(&gpu, "forced device cannot fall back to CPU");
        let mut single = problem.clone();
        single.backend_policy.execution_precision = fullmag_ir::ExecutionPrecision::Single;
        reject_public_inspection(&single, "explicit FEM strict/double input lane");
        let mut extended = problem;
        extended.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Extended;
        reject_public_inspection(&extended, "explicit FEM strict/double input lane");
    }
    #[test]
    fn inspection_execution_refuses_multi_object_before_loading_or_remapping_meshes() {
        let (mut problem, _) = public_inspection_fixture();
        crate::plan_antenna_field_solve_execution(&problem, "stage", "port").unwrap();
        problem.geometry.entries = vec![
            branch_geometry("strip", 0.),
            branch_geometry("return-object", 2.),
        ];
        problem.magnets[0].object_id = Some("signal-object".into());
        problem.antenna_port_modes[0].source_object_id = "signal-object".into();
        problem.antenna_field_solve_stages[0].source_object_id = "signal-object".into();
        problem.antenna_field_solve_stages[0].field_sampling_domain = FieldTargetIR::Object {
            object_id: "signal-object".into(),
        };
        let fullmag_ir::CurrentModuleIR::CurrentTransport {
            definition: Some(definition),
            ..
        } = &mut problem.current_modules[0]
        else {
            unreachable!()
        };
        definition.domain = ["signal-object", "return-object"]
            .map(|id| RegionRefIR {
                object_id: id.into(),
                region_id: None,
            })
            .to_vec();
        let material = definition.materials[0].material.clone();
        definition.materials = definition
            .domain
            .iter()
            .map(|region| ChargeTransportMaterialAssignmentIR {
                region: region.clone(),
                material: material.clone(),
            })
            .collect();
        let ConservativeCurrentSourceIR::ExternalLeadCurrent {
            terminal_observations,
            ..
        } = definition.conservative_current_source.as_mut().unwrap();
        for observation in terminal_observations {
            observation.object_id = if observation.id.starts_with("signal-") {
                "signal-object"
            } else {
                "return-object"
            }
            .into();
        }
        // No asset can be loaded: the ownership refusal must precede mesh handling.
        problem.geometry_assets = None;
        reject_public_inspection(&problem, "multi-object merge remaps markers and ordinals");
    }
    #[test]
    fn inspection_execution_refuses_referenced_projection_and_source_spectrum() {
        let (problem, _) = public_inspection_fixture();
        crate::plan_antenna_field_solve_execution(&problem, "stage", "port").unwrap();
        let solution = fullmag_ir::AntennaSolutionRefIR::StageOutput(
            fullmag_ir::AntennaStageOutputRefIR::StageOutput {
                stage_id: "stage".into(),
                output_id: "inspection-output".into(),
            },
        );
        let target = FieldTargetIR::Object {
            object_id: "device-object".into(),
        };
        let mut projection = problem.clone();
        projection
            .antenna_target_projections
            .push(fullmag_ir::AntennaTargetProjectionRefIR {
                id: "projection".into(),
                solution: solution.clone(),
                target: target.clone(),
                output_id: "projected-H".into(),
            });
        reject_public_inspection(&projection, "source_not_qualified");
        let mut spectrum = problem;
        spectrum
            .antenna_spectrum_requests
            .push(fullmag_ir::AntennaSpectrumRequestIR {
                id: "spectrum".into(),
                solution_ref: solution,
                port_mode_id: Some("port".into()),
                target,
                transform: fullmag_ir::AntennaSpectrumTransformIR::SpatialFft,
                sampling_plane: fullmag_ir::AntennaSpectrumSamplingPlaneIR {
                    origin_m: [0., 0., 0.],
                    axis_u: [1., 0., 0.],
                    axis_v: [0., 1., 0.],
                    extent_u_m: 1.,
                    extent_v_m: 1.,
                    sample_count_u: 2,
                    sample_count_v: 2,
                    interpolation: "fem_element".into(),
                    outside_policy: fullmag_ir::AntennaSpectrumOutsidePolicyIR::Zero,
                },
                window: fullmag_ir::AntennaSpectrumWindowIR::Rectangular,
                normalization: fullmag_ir::AntennaSpectrumNormalizationIR::IntegralSi,
                nonuniform_k_grid: None,
                component: "x".into(),
                equilibrium_ref: None,
                mode_basis_ref: None,
                output_id: "source-spectrum".into(),
            });
        reject_public_inspection(&spectrum, "source_not_qualified");
    }
    #[test]
    fn materialized_input_preserves_real_ids_markers_and_signed_observations() {
        let f = fixture();
        let input = f.resolve().unwrap();
        assert_eq!(input.original_device_mesh, f.device);
        assert_eq!(
            &input.combined_stable_vertex_ids[..54],
            &(0..54).map(|i| 500 - i).collect::<Vec<u64>>()
        );
        assert!(input.combined_mesh.element_markers[..96]
            .iter()
            .all(|m| *m == 7));
        assert!(input.combined_mesh.element_markers[96..]
            .iter()
            .all(|m| *m == 19));
        assert!(input.conductivity_spm_per_element[..96]
            .iter()
            .all(|s| *s == 4.));
        assert!(input.conductivity_spm_per_element[96..]
            .iter()
            .all(|s| *s == 8.));
        assert_eq!(
            input
                .observations
                .iter()
                .map(|o| o.requested_device_outward_current_a)
                .collect::<Vec<_>>(),
            vec![-1., 1., 1., -1.]
        );
        assert_eq!(
            input
                .outer_terminals
                .iter()
                .map(|o| o.requested_outward_current_a)
                .collect::<Vec<_>>(),
            vec![-1., 1., 1., -1.]
        );
        assert_eq!(
            input.boundary_roles.len(),
            input.combined_mesh.facet_count()
        );
        assert_eq!(
            input
                .electrical_component_ids_per_vertex
                .iter()
                .copied()
                .collect::<BTreeSet<_>>()
                .len(),
            2
        );
        assert!(input.combined_mesh.per_domain_quality.is_empty());
        assert_eq!(
            input.direct_field_policy.policy_version,
            fullmag_ir::antenna_current_source::ANTENNA_EXTERNAL_LEAD_DIRECT_POLICY_VERSION
        );
        assert_eq!(input.direct_field_policy.source_target_pairs, 1152);
    }
    #[test]
    fn materialization_accepts_absent_or_historical_selector_and_rejects_blank() {
        let absent = fixture().resolve().unwrap();

        let mut historical = fixture();
        historical.stage.conservative_current_view_ref = Some("legacy:view".into());
        let historical = historical.resolve().unwrap();
        assert_eq!(
            historical.stage.conservative_current_view_ref.as_deref(),
            Some("legacy:view")
        );
        assert_ne!(
            absent.pins.selected_control_sha256,
            historical.pins.selected_control_sha256
        );

        let mut blank = fixture();
        blank.stage.conservative_current_view_ref = Some("  ".into());
        rejected(&blank, "conservative_current_view_ref must be non-empty");
    }
    #[test]
    fn materialization_rejects_wrong_object_ownership_and_missing_observations() {
        let mut f = fixture();
        let ConservativeCurrentSourceIR::ExternalLeadCurrent {
            terminal_observations,
            ..
        } = f.source();
        terminal_observations[0].object_id = "return-object".into();
        terminal_observations[1].object_id = "return-object".into();
        f.port.branches[0].signed_weight = -1.;
        rejected(&f, "wrong immutable object owner");
        let mut f = fixture();
        f.port.branches.pop();
        rejected(&f, "cover every source observation");
        let mut f = fixture();
        f.segments[0].element_count = 47;
        rejected(&f, "complete exact");
        let mut f = fixture();
        f.segments[0].node_start = 1;
        rejected(&f, "overlapping object ownership");
    }
    #[test]
    fn component_balance_does_not_accept_global_cancellation() {
        let mut f = fixture();
        let ConservativeCurrentSourceIR::ExternalLeadCurrent { drives, .. } = f.source();
        *drives[0]
            .outer_terminal_currents_a
            .get_mut("outer-signal-in")
            .unwrap() += 0.25;
        *drives[0]
            .outer_terminal_currents_a
            .get_mut("outer-return-in")
            .unwrap() -= 0.25;
        assert_eq!(
            drives[0].outer_terminal_currents_a.values().sum::<f64>(),
            0.
        );
        rejected(&f, "imbalance in an electrical component");
    }
    fn quality() -> MeshQualityIR {
        MeshQualityIR {
            n_elements: 48,
            sicn_min: 1.,
            sicn_max: 1.,
            sicn_mean: 1.,
            sicn_p5: 1.,
            sicn_histogram: vec![],
            gamma_min: 1.,
            gamma_mean: 1.,
            gamma_histogram: vec![],
            volume_min: 1.,
            volume_max: 1.,
            volume_mean: 1.,
            volume_std: 0.,
            avg_quality: 1.,
        }
    }
    #[test]
    fn input_pins_are_deterministic_and_bind_actual_inputs_not_outputs() {
        let mut f = fixture();
        f.device.per_domain_quality.insert(7, quality());
        f.device.per_domain_quality.insert(8, quality());
        let initial = f.resolve().unwrap();
        f.device.per_domain_quality.clear();
        f.device.per_domain_quality.insert(8, quality());
        f.device.per_domain_quality.insert(7, quality());
        assert_eq!(initial.pins, f.resolve().unwrap().pins);
        for mutation in 0..8 {
            let mut f = fixture();
            match mutation {
                0 => f.definition.materials[0].material.sigma_spm = 5.,
                1 => f.definition.solver.linear.max_iterations += 1,
                2 => f.sampling.positions_xyz_m[0][2] += 0.25,
                3 => {
                    let ConservativeCurrentSourceIR::ExternalLeadCurrent { drives, .. } =
                        f.source();
                    for i in drives[0].outer_terminal_currents_a.values_mut() {
                        *i = -*i;
                    }
                }
                4 => {
                    let ConservativeCurrentSourceIR::ExternalLeadCurrent { lead_mesh, .. } =
                        f.source();
                    lead_mesh.element_markers[0] += 1;
                }
                5 => {
                    for node in &mut f.device.nodes {
                        node[1] += 0.125;
                    }
                    let ConservativeCurrentSourceIR::ExternalLeadCurrent { lead_mesh, .. } =
                        f.source();
                    for node in &mut lead_mesh.nodes {
                        node[1] += 0.125;
                    }
                }
                6 => {
                    let ConservativeCurrentSourceIR::ExternalLeadCurrent {
                        device_stable_vertex_ids,
                        interface_pairs,
                        ..
                    } = f.source();
                    let old = device_stable_vertex_ids[0];
                    device_stable_vertex_ids[0] = 2000;
                    for p in interface_pairs {
                        for v in &mut p.device_face_vertex_ids {
                            if *v == old {
                                *v = 2000;
                            }
                        }
                        p.device_face_vertex_ids.sort_unstable();
                        for v in &mut p.vertex_pairs {
                            if v[0] == old {
                                v[0] = 2000;
                            }
                        }
                    }
                }
                _ => {
                    let ConservativeCurrentSourceIR::ExternalLeadCurrent {
                        interface_pairs,
                        terminal_observations,
                        ..
                    } = f.source();
                    interface_pairs[0].id = "renamed-interface".into();
                    terminal_observations[0].interface_pair_ids[0] = "renamed-interface".into();
                }
            }
            assert_ne!(
                fixture().resolve().unwrap().pins.materialized_input_sha256,
                f.resolve().unwrap().pins.materialized_input_sha256
            );
        }
        f.device.per_domain_quality.get_mut(&7).unwrap().volume_std = f64::NAN;
        rejected(&f, "quality metadata must be finite");
    }
    #[test]
    fn unsupported_vector_potential_and_combined_pair_budget_fail_closed() {
        let mut f = fixture();
        f.stage.oersted_realization = AntennaOerstedRealizationIR::VectorPotentialSolver;
        rejected(&f, "direct fallback is forbidden");
        let mut f = fixture();
        f.sampling.positions_xyz_m = vec![[0.5, 0.5, 2.]; 3473];
        rejected(&f, "combined current source/target pair budget exceeded");
        let mut f = fixture();
        let ConservativeCurrentSourceIR::ExternalLeadCurrent {
            interface_pairs, ..
        } = f.source();
        interface_pairs[0].vertex_pairs.swap(0, 1);
        // Reordering a bijection does not alter geometry, but is retained in authored identity.
        assert_ne!(
            fixture().resolve().unwrap().pins.authored_source_sha256,
            f.resolve().unwrap().pins.authored_source_sha256
        );
        let ConservativeCurrentSourceIR::ExternalLeadCurrent {
            interface_pairs, ..
        } = f.source();
        interface_pairs[0].vertex_pairs[0].swap(0, 1);
        rejected(&f, "bijection");
    }
    #[test]
    fn malformed_sampling_and_unrepresentable_solver_policy_are_refused() {
        let mut f = fixture();
        f.sampling.location = "banana".into();
        rejected(&f, "matching actual field sampling carrier");
        let mut f = fixture();
        f.sampling.cells = FemConnectivityIR::empty();
        rejected(&f, "nonempty bounded Tet4");
        let mut f = fixture();
        f.sampling.cells.nodes[0] = 999;
        rejected(&f, "out-of-bounds vertices");
        let mut f = fixture();
        f.sampling.cells.offsets[1] = 3;
        assert!(f.resolve().is_err());
        let mut f = fixture();
        f.sampling.positions_xyz_m[3] = f.sampling.positions_xyz_m[0];
        rejected(&f, "degenerate tetrahedral geometry");
        let mut f = fixture();
        f.definition.solver.linear.absolute_tolerance = 1e-12;
        rejected(&f, "H1 CG solver policy");
        let mut f = fixture();
        f.stage.solver_policy = "direct".into();
        rejected(&f, "matching single stage/port");
    }
    #[test]
    fn explicit_interfaces_must_match_actual_exterior_and_geometry() {
        let mut f = fixture();
        let ConservativeCurrentSourceIR::ExternalLeadCurrent { lead_mesh, .. } = f.source();
        for node in &mut lead_mesh.nodes {
            node[0] += 0.125;
        }
        rejected(&f, "not exactly coincident");
        let mut f = fixture();
        // Leave stable IDs unchanged and assign a real interior triangle to a physical pair.
        let interior = [500, 496, 487];
        let ConservativeCurrentSourceIR::ExternalLeadCurrent {
            interface_pairs, ..
        } = f.source();
        interface_pairs[0].device_face_vertex_ids = key(interior);
        for (i, id) in key(interior).into_iter().enumerate() {
            interface_pairs[0].vertex_pairs[i][0] = id;
        }
        rejected(&f, "device face is not actual exterior");
    }
    #[test]
    fn terminal_adapter_limits_match_native_iteration_and_control_bounds() {
        let mut f = fixture();
        f.definition.solver.linear.max_iterations = i32::MAX as u32;
        assert_eq!(
            f.resolve().unwrap().solver.linear.max_iterations,
            i32::MAX as u32
        );
        f.definition.solver.linear.max_iterations += 1;
        rejected(&f, "H1 CG solver policy");
        assert!(validate_independent_terminal_control_budget([65]).is_ok());
        assert!(validate_independent_terminal_control_budget([33, 33]).is_ok());
        for counts in [vec![66], vec![34, 33]] {
            assert!(validate_independent_terminal_control_budget(counts)
                .unwrap_err()
                .to_string()
                .contains("64 independent terminal controls"));
        }
        assert!(
            validate_independent_terminal_control_budget([usize::MAX, 3])
                .unwrap_err()
                .to_string()
                .contains("control count overflows")
        );
        // Zero drive does not bypass topology's independent-control limit.
        let ConservativeCurrentSourceIR::ExternalLeadCurrent { drives, .. } = f.source();
        for current in drives[0].outer_terminal_currents_a.values_mut() {
            *current = 0.;
        }
        f.definition.solver.linear.max_iterations = 1000;
        assert!(f.resolve().is_ok());
    }

    #[test]
    fn terminal_face_closure_checks_actual_exterior_and_keeps_free_vertices() {
        let f = fixture();
        let ConservativeCurrentSourceIR::ExternalLeadCurrent {
            lead_mesh,
            lead_stable_vertex_ids,
            outer_terminals,
            ..
        } = f.definition.conservative_current_source.as_ref().unwrap();
        let actual = topology(lead_mesh, lead_stable_vertex_ids).unwrap();
        assert!(
            validate_terminal_face_closure(actual.exterior.keys().copied(), outer_terminals)
                .is_ok()
        );
        assert!(f.resolve().is_ok());
        let mut incomplete = outer_terminals.clone();
        let faces = &incomplete[0].boundary_face_vertex_ids;
        let omitted = faces
            .iter()
            .enumerate()
            .position(|(i, face)| {
                face.iter().all(|v| {
                    faces
                        .iter()
                        .enumerate()
                        .any(|(j, other)| i != j && other.contains(v))
                })
            })
            .unwrap();
        incomplete[0].boundary_face_vertex_ids.remove(omitted);
        let error = validate_terminal_face_closure(actual.exterior.keys().copied(), &incomplete)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("not closed under its essential P1 vertices"),
            "{error}"
        );

        // A real nx=1 cube has no free side vertices between its two plane electrodes.
        let nodes = vec![
            [0., 0., 0.],
            [1., 0., 0.],
            [1., 1., 0.],
            [0., 1., 0.],
            [0., 0., 1.],
            [1., 0., 1.],
            [1., 1., 1.],
            [0., 1., 1.],
        ];
        let cells = vec![
            [0, 1, 2, 6],
            [0, 2, 3, 6],
            [0, 3, 7, 6],
            [0, 7, 4, 6],
            [0, 4, 5, 6],
            [0, 5, 1, 6],
        ];
        let mut incidence = BTreeMap::new();
        for [a, b, c, d] in &cells {
            for mut face in [[*a, *b, *c], [*a, *b, *d], [*a, *c, *d], [*b, *c, *d]] {
                face.sort_unstable();
                *incidence.entry(face).or_insert(0) += 1;
            }
        }
        let faces: Vec<_> = incidence
            .into_iter()
            .filter(|(_, n)| *n == 1)
            .map(|(f, _)| f)
            .collect();
        let cube = MeshIR::from_legacy_tet4(
            "separator".into(),
            nodes,
            cells,
            vec![1; 6],
            faces.clone(),
            vec![1; faces.len()],
            vec![],
            vec![],
            Default::default(),
        );
        let ids: Vec<_> = (101..109).collect();
        let actual = topology(&cube, &ids).unwrap();
        let terminals: Vec<_> = [0., 1.]
            .into_iter()
            .enumerate()
            .map(|(i, x)| CurrentSourceOuterTerminalIR {
                id: format!("terminal-{i}"),
                boundary_face_vertex_ids: plane(&cube, &ids, x, 0.),
            })
            .collect();
        let error = validate_terminal_face_closure(actual.exterior.keys().copied(), &terminals)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("separator face has no free P1 vertex"),
            "{error}"
        );
    }
    #[test]
    fn physical_components_refuse_point_and_edge_only_p1_connections() {
        // Positive reference first: all real device/lead interfaces preserve the bijection.
        assert!(fixture().resolve().is_ok());
        let empty_lead = Topology {
            tets: vec![],
            exterior: BTreeMap::new(),
            interior_element_pairs: vec![],
        };
        for edge_contact in [false, true] {
            let mut nodes = vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]];
            let second = if edge_contact {
                nodes.extend([[0., -1., 0.], [0., 0., -1.]]);
                [0, 1, 4, 5]
            } else {
                nodes.extend([[-1., 0., 0.], [0., -1., 0.], [0., 0., -1.]]);
                [0, 5, 4, 6]
            };
            let cells = vec![[0, 1, 2, 3], second];
            // Their interiors lie in opposite y/z half-spaces; intersection is only the
            // authored shared x edge, or only the origin for the point-contact fixture.
            assert!(cells[0]
                .iter()
                .all(|v| nodes[*v as usize][1] >= 0. && nodes[*v as usize][2] >= 0.));
            assert!(cells[1]
                .iter()
                .all(|v| nodes[*v as usize][1] <= 0. && nodes[*v as usize][2] <= 0.));
            assert_eq!(
                cells[0].iter().filter(|v| cells[1].contains(v)).count(),
                if edge_contact { 2 } else { 1 }
            );
            let mut incidence = BTreeMap::new();
            for [a, b, c, d] in &cells {
                for mut face in [[*a, *b, *c], [*a, *b, *d], [*a, *c, *d], [*b, *c, *d]] {
                    face.sort_unstable();
                    *incidence.entry(face).or_insert(0) += 1;
                }
            }
            assert!(incidence.values().all(|count| *count == 1));
            let faces: Vec<_> = incidence.into_keys().collect();
            let ids: Vec<_> = (0..nodes.len()).map(|i| 101 + i as u64).collect();
            let mesh = MeshIR::from_legacy_tet4(
                "point-or-edge-only".into(),
                nodes,
                cells,
                vec![1; 2],
                faces.clone(),
                vec![1; faces.len()],
                vec![],
                vec![],
                Default::default(),
            );
            let actual = topology(&mesh, &ids).unwrap();
            assert_eq!(actual.exterior.len(), 8);
            assert!(actual.interior_element_pairs.is_empty());
            let mut p1 = UnionFind((0..ids.len()).collect());
            for tet in &actual.tets {
                for v in &tet[1..] {
                    p1.join(tet[0] as usize, *v as usize);
                }
            }
            let roots: Vec<_> = (0..ids.len()).map(|i| p1.root(i)).collect();
            assert_eq!(roots.iter().copied().collect::<BTreeSet<_>>().len(), 1);
            let error = validate_physical_p1_component_bijection(
                &actual,
                &empty_lead,
                &[],
                ids.len(),
                &roots,
            )
            .unwrap_err()
            .to_string();
            assert!(
                error.contains("physical/P1 component correspondence is not bijective"),
                "{error}"
            );
        }
    }
}
