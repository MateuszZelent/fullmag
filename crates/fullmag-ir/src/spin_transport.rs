use crate::{ExecutionDevice, ExecutionMode, ExecutionPrecision, MeshIR, RegionRefIR};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

fn is_zero_f64(value: &f64) -> bool {
    *value == 0.0
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TransportCouplingIR {
    #[default]
    OneWay,
    Bidirectional,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SurfaceRefIR {
    pub object_id: String,
    pub surface_id: String,
    pub orientation: [f64; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpinMemoryLossReservoirIR {
    #[serde(rename = "g_n_Spm2")]
    pub g_n_spm2: f64,
    #[serde(rename = "g_f_Spm2")]
    pub g_f_spm2: f64,
    #[serde(rename = "g_lattice_Spm2")]
    pub g_lattice_spm2: f64,
    pub formula_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChargeTransportDefinitionIR {
    pub domain: Vec<RegionRefIR>,
    pub materials: Vec<ChargeTransportMaterialAssignmentIR>,
    pub boundaries: Vec<ChargeBoundaryIR>,
    pub gauge: ChargePotentialGaugeIR,
    pub solver: ChargeSolverPolicyIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conservative_current_view: Option<ResolvedFemConservativeCurrentViewIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conservative_current_source: Option<ConservativeCurrentSourceIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured_current_closure: Option<StructuredCurrentClosureIR>,
}

pub const CONSERVATIVE_CURRENT_SOURCE_SCHEMA_VERSION: &str = "conservative_current_source.v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CurrentSourceInterfacePairIR {
    pub id: String,
    pub device_face_vertex_ids: [u64; 3],
    pub lead_face_vertex_ids: [u64; 3],
    pub vertex_pairs: [[u64; 2]; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CurrentSourceOuterTerminalIR {
    pub id: String,
    pub boundary_face_vertex_ids: Vec<[u64; 3]>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CurrentSourceTerminalObservationIR {
    pub id: String,
    pub object_id: String,
    pub interface_pair_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CurrentSourceDriveIR {
    pub id: String,
    pub port_mode_ref: String,
    pub outer_terminal_currents_a: BTreeMap<String, f64>,
}

/// Authored current-driven input, not an accepted field or closed-loop certificate.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ConservativeCurrentSourceIR {
    ExternalLeadCurrent {
        schema_version: String,
        revision: String,
        device_stable_vertex_ids: Vec<u64>,
        #[serde(deserialize_with = "deserialize_current_source_lead_mesh")]
        lead_mesh: MeshIR,
        lead_stable_vertex_ids: Vec<u64>,
        lead_conductivity_spm_per_element: Vec<f64>,
        interface_pairs: Vec<CurrentSourceInterfacePairIR>,
        outer_terminals: Vec<CurrentSourceOuterTerminalIR>,
        terminal_observations: Vec<CurrentSourceTerminalObservationIR>,
        drives: Vec<CurrentSourceDriveIR>,
    },
}

fn deserialize_current_source_lead_mesh<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<MeshIR, D::Error> {
    use serde::de::Error;
    let value = serde_json::Value::deserialize(deserializer)?;
    let check = |value: &serde_json::Value, allowed: &[&str]| -> Result<(), D::Error> {
        let object = value
            .as_object()
            .ok_or_else(|| D::Error::custom("source lead mesh metadata must be an object"))?;
        if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
            return Err(D::Error::custom(format!(
                "unknown current-source lead mesh field '{key}'"
            )));
        }
        Ok(())
    };
    check(
        &value,
        &[
            "mesh_name",
            "nodes",
            "cells",
            "facets",
            "element_markers",
            "boundary_markers",
            "periodic_boundary_pairs",
            "periodic_node_pairs",
            "per_domain_quality",
        ],
    )?;
    if let Some(cells) = value.get("cells") {
        check(
            cells,
            &["types", "offsets", "nodes", "global_ordinals", "mesh_parts"],
        )?;
    }
    if let Some(facets) = value.get("facets") {
        check(
            facets,
            &["types", "roles", "offsets", "nodes", "global_ordinals"],
        )?;
    }
    if let Some(quality) = value.get("per_domain_quality") {
        for metrics in quality
            .as_object()
            .ok_or_else(|| D::Error::custom("source lead mesh quality must be an object"))?
            .values()
        {
            check(
                metrics,
                &[
                    "n_elements",
                    "sicn_min",
                    "sicn_max",
                    "sicn_mean",
                    "sicn_p5",
                    "sicn_histogram",
                    "gamma_min",
                    "gamma_mean",
                    "gamma_histogram",
                    "volume_min",
                    "volume_max",
                    "volume_mean",
                    "volume_std",
                    "avg_quality",
                ],
            )?;
        }
    }
    serde_json::from_value(value).map_err(D::Error::custom)
}

impl ConservativeCurrentSourceIR {
    pub fn terminal_observations(&self) -> &[CurrentSourceTerminalObservationIR] {
        match self {
            Self::ExternalLeadCurrent {
                terminal_observations,
                ..
            } => terminal_observations,
        }
    }

    pub fn validation_errors(&self, path: &str) -> Vec<String> {
        let Self::ExternalLeadCurrent {
            schema_version,
            revision,
            device_stable_vertex_ids,
            lead_mesh,
            lead_stable_vertex_ids,
            lead_conductivity_spm_per_element,
            interface_pairs,
            outer_terminals,
            terminal_observations,
            drives,
        } = self;
        let mut errors = Vec::new();
        let text =
            |value: &str| !value.trim().is_empty() && value.len() <= 4096 && !value.contains('\0');
        let canonical = |face: &[u64; 3]| face[0] > 0 && face[0] < face[1] && face[1] < face[2];
        const ELEMENT_LIMIT: usize = 1 << 20;
        const LIMIT: usize = 4 * ELEMENT_LIMIT;
        if [
            device_stable_vertex_ids.len(),
            lead_stable_vertex_ids.len(),
            lead_mesh.nodes.len(),
            lead_mesh.cell_count(),
            lead_mesh.facet_count(),
            lead_conductivity_spm_per_element.len(),
            interface_pairs.len(),
            outer_terminals.len(),
            terminal_observations.len(),
            drives.len(),
        ]
        .iter()
        .any(|count| *count > LIMIT)
            || outer_terminals
                .iter()
                .try_fold(0usize, |n, t| {
                    n.checked_add(t.boundary_face_vertex_ids.len())
                })
                .is_none_or(|n| n > LIMIT)
            || terminal_observations
                .iter()
                .try_fold(0usize, |n, t| n.checked_add(t.interface_pair_ids.len()))
                .is_none_or(|n| n > LIMIT)
            || drives
                .iter()
                .try_fold(0usize, |n, d| {
                    n.checked_add(d.outer_terminal_currents_a.len())
                })
                .is_none_or(|n| n > LIMIT)
        {
            return vec![format!("{path} exceeds bounded source input support")];
        }
        if schema_version != CONSERVATIVE_CURRENT_SOURCE_SCHEMA_VERSION || !text(revision) {
            errors.push(format!(
                "{path} requires the supported schema_version and bounded nonempty revision"
            ));
        }
        let device: BTreeSet<_> = device_stable_vertex_ids.iter().copied().collect();
        let lead: BTreeSet<_> = lead_stable_vertex_ids.iter().copied().collect();
        if device.is_empty()
            || lead.is_empty()
            || device.contains(&0)
            || lead.contains(&0)
            || device.len() != device_stable_vertex_ids.len()
            || lead.len() != lead_stable_vertex_ids.len()
            || !device.is_disjoint(&lead)
            || lead.len() != lead_mesh.nodes.len()
        {
            errors.push(format!("{path} requires unique positive disjoint device/lead stable IDs with complete lead node coverage"));
        }
        if let Err(mesh_errors) = lead_mesh.validate() {
            errors.extend(
                mesh_errors
                    .into_iter()
                    .map(|error| format!("{path}.lead_mesh: {error}")),
            );
        }
        if lead_mesh
            .element_markers
            .iter()
            .chain(&lead_mesh.boundary_markers)
            .any(|marker| *marker == 0 || *marker > i32::MAX as u32)
        {
            errors.push(format!(
                "{path}.lead_mesh markers must be positive signed-32-bit values"
            ));
        }
        let elements = lead_mesh.require_tet4_elements();
        let facets = lead_mesh.require_tri3_boundary_faces();
        if elements.is_err()
            || facets.is_err()
            || lead_mesh.cell_count() == 0
            || lead_mesh.cell_count() > ELEMENT_LIMIT
            || lead_mesh.nodes.len() > 4 * lead_mesh.cell_count()
            || lead_mesh.facet_count() > 4 * lead_mesh.cell_count()
            || lead_mesh
                .facets
                .roles
                .iter()
                .any(|role| *role != crate::FemFacetRoleIR::Exterior)
            || !lead_mesh.periodic_boundary_pairs.is_empty()
            || !lead_mesh.periodic_node_pairs.is_empty()
        {
            errors.push(format!("{path}.lead_mesh requires nonempty tet4 cells, tri3 exterior facets and no periodic relations"));
        }
        if lead_conductivity_spm_per_element.len() != lead_mesh.cell_count()
            || lead_conductivity_spm_per_element
                .iter()
                .any(|sigma| !sigma.is_finite() || *sigma <= 0.0)
        {
            errors.push(format!("{path}.lead_conductivity_spm_per_element must cover every lead cell with finite sigma>0"));
        }
        let mut incidence = BTreeMap::<[u64; 3], usize>::new();
        if lead_mesh
            .nodes
            .iter()
            .flatten()
            .any(|coordinate| !coordinate.is_finite())
        {
            errors.push(format!("{path}.lead_mesh nodes must be finite"));
        }
        if let Ok(elements) = elements {
            for tet in elements {
                if let Some(points) = tet
                    .iter()
                    .map(|local| lead_mesh.nodes.get(*local as usize))
                    .collect::<Option<Vec<_>>>()
                {
                    let mut edges = [[0.0; 3]; 3];
                    for i in 0..3 {
                        for j in 0..3 {
                            edges[i][j] = points[i + 1][j] - points[0][j];
                        }
                    }
                    let scale = edges
                        .iter()
                        .flatten()
                        .fold(0.0_f64, |maximum, value| maximum.max(value.abs()));
                    if scale.is_finite() && scale > 0.0 {
                        for edge in &mut edges {
                            for value in edge {
                                *value /= scale;
                            }
                        }
                    }
                    let [a, b, c] = edges;
                    let det = a[0] * (b[1] * c[2] - b[2] * c[1])
                        - a[1] * (b[0] * c[2] - b[2] * c[0])
                        + a[2] * (b[0] * c[1] - b[1] * c[0]);
                    if !scale.is_finite() || scale == 0.0 || !det.is_finite() || det <= 0.0 {
                        errors.push(format!("{path}.lead_mesh requires finite nondegenerate positively oriented tet4 cells"));
                    }
                }
                let ids = tet.map(|local| lead_stable_vertex_ids.get(local as usize).copied());
                if let [Some(a), Some(b), Some(c), Some(d)] = ids {
                    for mut face in [[a, b, c], [a, b, d], [a, c, d], [b, c, d]] {
                        face.sort_unstable();
                        *incidence.entry(face).or_default() += 1;
                    }
                }
            }
        }
        let exterior: BTreeSet<_> = incidence
            .iter()
            .filter(|(_, count)| **count == 1)
            .map(|(face, _)| *face)
            .collect();
        let mut declared = BTreeSet::new();
        if let Ok(facets) = facets {
            for face in facets {
                let ids = face.map(|local| lead_stable_vertex_ids.get(local as usize).copied());
                if let [Some(a), Some(b), Some(c)] = ids {
                    let mut key = [a, b, c];
                    key.sort_unstable();
                    if !declared.insert(key) {
                        errors.push(format!("{path}.lead_mesh has duplicate boundary faces"));
                    }
                }
            }
        }
        if declared != exterior || incidence.values().any(|count| *count > 2) {
            errors.push(format!(
                "{path}.lead_mesh facets must exactly cover its manifold exterior"
            ));
        }
        let mut pairs = BTreeMap::new();
        let mut used_device_faces = BTreeSet::new();
        let mut used_lead_faces = BTreeSet::new();
        let mut trace_vertices = BTreeSet::new();
        for pair in interface_pairs {
            let left: BTreeSet<_> = pair.vertex_pairs.iter().map(|pair| pair[0]).collect();
            let right: BTreeSet<_> = pair.vertex_pairs.iter().map(|pair| pair[1]).collect();
            if !text(&pair.id)
                || pairs.insert(pair.id.as_str(), pair).is_some()
                || !canonical(&pair.device_face_vertex_ids)
                || !canonical(&pair.lead_face_vertex_ids)
                || !pair
                    .device_face_vertex_ids
                    .iter()
                    .all(|id| device.contains(id))
                || !pair.lead_face_vertex_ids.iter().all(|id| lead.contains(id))
                || !exterior.contains(&pair.lead_face_vertex_ids)
                || !used_device_faces.insert(pair.device_face_vertex_ids)
                || !used_lead_faces.insert(pair.lead_face_vertex_ids)
                || left != pair.device_face_vertex_ids.into_iter().collect()
                || right != pair.lead_face_vertex_ids.into_iter().collect()
            {
                errors.push(format!("{path}.interface_pairs requires unique IDs/exterior faces and an exact device-to-lead vertex bijection"));
            }
            trace_vertices.extend(pair.lead_face_vertex_ids);
        }
        if pairs.is_empty() {
            errors.push(format!("{path}.interface_pairs must not be empty"));
        }
        let mut terminal_ids = BTreeSet::new();
        let mut terminal_vertex_owner = BTreeMap::new();
        for terminal in outer_terminals {
            if !text(&terminal.id)
                || !terminal_ids.insert(terminal.id.as_str())
                || terminal.boundary_face_vertex_ids.is_empty()
            {
                errors.push(format!(
                    "{path}.outer_terminals requires unique bounded IDs and nonempty face groups"
                ));
            }
            for face in &terminal.boundary_face_vertex_ids {
                if !canonical(face) || !exterior.contains(face) || !used_lead_faces.insert(*face) {
                    errors.push(format!("{path}.outer_terminals has unknown, duplicate or interface-overlapping exterior face"));
                }
                for vertex in face {
                    let previous = terminal_vertex_owner.insert(*vertex, terminal.id.as_str());
                    if trace_vertices.contains(vertex)
                        || previous.is_some_and(|owner| owner != terminal.id)
                    {
                        errors.push(format!(
                            "{path}.outer_terminals has shared electrode/trace essential vertices"
                        ));
                    }
                }
            }
        }
        if outer_terminals.len() < 2 {
            errors.push(format!(
                "{path}.outer_terminals requires at least two terminals"
            ));
        }
        for face in &exterior {
            if face
                .iter()
                .all(|vertex| terminal_vertex_owner.contains_key(vertex))
            {
                let owners: BTreeSet<_> = face
                    .iter()
                    .map(|vertex| terminal_vertex_owner[vertex])
                    .collect();
                if owners.len() != 1 || !used_lead_faces.contains(face) {
                    errors.push(format!("{path}.outer_terminals must be closed under essential face ownership; separator faces require a free P1 vertex"));
                }
            }
        }
        let mut observations = BTreeSet::new();
        let mut observed_pairs = BTreeSet::new();
        let mut observation_vertex_owner = BTreeMap::new();
        for observation in terminal_observations {
            if !text(&observation.id)
                || !text(&observation.object_id)
                || !observations.insert(observation.id.as_str())
                || observation.interface_pair_ids.is_empty()
            {
                errors.push(format!("{path}.terminal_observations requires unique bounded IDs, object_id and nonempty pair groups"));
            }
            for id in &observation.interface_pair_ids {
                if !observed_pairs.insert(id.as_str()) || !pairs.contains_key(id.as_str()) {
                    errors.push(format!(
                        "{path}.terminal_observations has unknown or repeated interface pair"
                    ));
                }
                if let Some(pair) = pairs.get(id.as_str()) {
                    for vertex in pair.device_face_vertex_ids {
                        let previous =
                            observation_vertex_owner.insert(vertex, observation.id.as_str());
                        if previous.is_some_and(|owner| owner != observation.id) {
                            errors.push(format!(
                                "{path}.terminal_observations shares device reaction vertices"
                            ));
                        }
                    }
                }
            }
        }
        if observed_pairs != pairs.keys().copied().collect() {
            errors.push(format!(
                "{path}.terminal_observations must partition every interface pair"
            ));
        }
        let mut drive_ids = BTreeSet::new();
        let mut port_ids = BTreeSet::new();
        for drive in drives {
            if !text(&drive.id)
                || !text(&drive.port_mode_ref)
                || !drive_ids.insert(drive.id.as_str())
                || !port_ids.insert(drive.port_mode_ref.as_str())
                || drive
                    .outer_terminal_currents_a
                    .keys()
                    .map(String::as_str)
                    .collect::<BTreeSet<_>>()
                    != terminal_ids
                || drive
                    .outer_terminal_currents_a
                    .values()
                    .any(|current| !current.is_finite())
            {
                errors.push(format!("{path}.drives requires unique IDs/port refs and finite signed currents for exactly every outer terminal"));
            }
        }
        if drives.is_empty() {
            errors.push(format!("{path}.drives must not be empty"));
        }
        errors
    }
}

#[cfg(test)]
pub(crate) mod current_source_tests {
    use super::*;

    pub(crate) fn fixture() -> ConservativeCurrentSourceIR {
        let corners = [
            [0., 0., 0.],
            [1., 0., 0.],
            [1., 1., 0.],
            [0., 1., 0.],
            [0., 0., 1.],
            [1., 0., 1.],
            [1., 1., 1.],
            [0., 1., 1.],
        ];
        let cells = [
            [0, 1, 2, 6],
            [0, 2, 3, 6],
            [0, 3, 7, 6],
            [0, 7, 4, 6],
            [0, 4, 5, 6],
            [0, 5, 1, 6],
        ];
        let nodes = [-1., 1.]
            .into_iter()
            .flat_map(|x| corners.map(|[a, b, c]| [a + x, b, c]))
            .collect();
        let elements: Vec<_> = [0, 8]
            .into_iter()
            .flat_map(|offset| cells.map(|tet| tet.map(|vertex| vertex + offset)))
            .collect();
        let mut counts = BTreeMap::new();
        for [a, b, c, d] in &elements {
            for mut face in [[*a, *b, *c], [*a, *b, *d], [*a, *c, *d], [*b, *c, *d]] {
                face.sort_unstable();
                *counts.entry(face).or_insert(0) += 1;
            }
        }
        let faces: Vec<_> = counts
            .into_iter()
            .filter(|(_, count)| *count == 1)
            .map(|(face, _)| face)
            .collect();
        let lead_mesh = MeshIR::from_legacy_tet4(
            "explicit-leads".into(),
            nodes,
            elements,
            vec![1; 12],
            faces.clone(),
            vec![1; faces.len()],
            vec![],
            vec![],
            Default::default(),
        );
        let interface_pairs = [
            ([1, 2, 3], [102, 103, 107]),
            ([1, 3, 4], [102, 106, 107]),
            ([5, 6, 7], [109, 112, 116]),
            ([5, 7, 8], [109, 113, 116]),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (device, lead))| CurrentSourceInterfacePairIR {
            id: format!("pair-{index}"),
            device_face_vertex_ids: device,
            lead_face_vertex_ids: lead,
            vertex_pairs: std::array::from_fn(|i| [device[i], lead[i]]),
        })
        .collect();
        ConservativeCurrentSourceIR::ExternalLeadCurrent {
            schema_version: CONSERVATIVE_CURRENT_SOURCE_SCHEMA_VERSION.into(),
            revision: "authored-v1".into(),
            device_stable_vertex_ids: (1..=8).collect(),
            lead_mesh,
            lead_stable_vertex_ids: (101..=116).collect(),
            lead_conductivity_spm_per_element: vec![4.; 12],
            interface_pairs,
            outer_terminals: vec![
                CurrentSourceOuterTerminalIR {
                    id: "left".into(),
                    boundary_face_vertex_ids: vec![[101, 104, 108], [101, 105, 108]],
                },
                CurrentSourceOuterTerminalIR {
                    id: "right".into(),
                    boundary_face_vertex_ids: vec![[110, 111, 115], [110, 114, 115]],
                },
            ],
            terminal_observations: vec![
                CurrentSourceTerminalObservationIR {
                    id: "in".into(),
                    object_id: "body".into(),
                    interface_pair_ids: vec!["pair-0".into(), "pair-1".into()],
                },
                CurrentSourceTerminalObservationIR {
                    id: "out".into(),
                    object_id: "body".into(),
                    interface_pair_ids: vec!["pair-2".into(), "pair-3".into()],
                },
            ],
            drives: vec![CurrentSourceDriveIR {
                id: "drive".into(),
                port_mode_ref: "port".into(),
                outer_terminal_currents_a: BTreeMap::from([
                    ("left".into(), -1.),
                    ("right".into(), 1.),
                ]),
            }],
        }
    }

    #[test]
    fn current_source_roundtrip_preserves_explicit_maps_and_signed_zero_drives() {
        let mut source = fixture();
        assert!(source.validation_errors("source").is_empty());
        let ConservativeCurrentSourceIR::ExternalLeadCurrent { drives, .. } = &mut source;
        drives.push(CurrentSourceDriveIR {
            id: "zero".into(),
            port_mode_ref: "zero-port".into(),
            outer_terminal_currents_a: BTreeMap::from([("left".into(), 0.), ("right".into(), 0.)]),
        });
        let bytes = serde_json::to_vec(&source).unwrap();
        let decoded: ConservativeCurrentSourceIR = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(source, decoded);
        assert!(decoded.validation_errors("source").is_empty());
    }

    #[test]
    fn flat_current_module_retains_source_and_rejects_malformed_source_payloads() {
        let flat = serde_json::json!({
            "kind":"current_transport","name":"transport","model":"ohmic_poisson","coupling":"one_way",
            "domain":[{"object_id":"body"}],"materials":[{"region":{"object_id":"body"},"material":{"sigma_Spm":4.}}],
            "boundaries":[],"gauge":"terminal_reference","solver":{"engine":"cg","linear":{"relative_tolerance":1e-10,"absolute_tolerance":0.,"max_iterations":100},"operator_version":"fem_charge_conforming_h1_p1.transparent.v1","physical_residual_version":"charge_balance_integrated_l2.v1"},
            "conservative_current_source":fixture()
        });
        let module: crate::CurrentModuleIR = serde_json::from_value(flat.clone()).unwrap();
        let crate::CurrentModuleIR::CurrentTransport {
            definition: Some(definition),
            ..
        } = &module
        else {
            panic!("flattened source definition disappeared")
        };
        assert_eq!(definition.conservative_current_source, Some(fixture()));
        let encoded = serde_json::to_value(&module).unwrap();
        assert_eq!(
            encoded["conservative_current_source"],
            flat["conservative_current_source"]
        );
        assert!(encoded.get("definition").is_none());
        let mut unknown = flat.clone();
        unknown["conservative_current_source"]["invented_pin"] = serde_json::json!("fake-sha");
        assert!(serde_json::from_value::<crate::CurrentModuleIR>(unknown).is_err());
        for malformed in [serde_json::json!(1), serde_json::json!([])] {
            let mut value = flat.clone();
            value["conservative_current_source"] = malformed;
            assert!(serde_json::from_value::<crate::CurrentModuleIR>(value).is_err());
        }
        let mut missing = flat;
        missing.as_object_mut().unwrap().remove("domain");
        assert!(serde_json::from_value::<crate::CurrentModuleIR>(missing).is_err());
        for model in ["prescribed_density", "ohmic_poisson"] {
            let legacy = serde_json::json!({
                "kind":"current_transport", "name":"legacy", "model":model
            });
            for explicit_null in [false, true] {
                let mut value = legacy.clone();
                if explicit_null {
                    value["conservative_current_source"] = serde_json::Value::Null;
                }
                let module: crate::CurrentModuleIR = serde_json::from_value(value).unwrap();
                assert!(matches!(
                    module,
                    crate::CurrentModuleIR::CurrentTransport {
                        definition: None,
                        ..
                    }
                ));
            }
        }
    }

    #[test]
    fn current_source_rejects_unknown_fields_maps_and_essential_aliases() {
        for path in [
            vec!["unexpected"],
            vec!["lead_mesh", "unexpected"],
            vec!["lead_mesh", "cells", "unexpected"],
            vec!["interface_pairs", "0", "unexpected"],
        ] {
            let mut value = serde_json::to_value(fixture()).unwrap();
            let mut cursor = &mut value;
            for key in &path[..path.len() - 1] {
                cursor = if *key == "0" {
                    &mut cursor[0]
                } else {
                    &mut cursor[*key]
                };
            }
            cursor[path[path.len() - 1]] = serde_json::json!(true);
            assert!(serde_json::from_value::<ConservativeCurrentSourceIR>(value).is_err());
        }
        for mutation in 0..11 {
            let mut source = fixture();
            let ConservativeCurrentSourceIR::ExternalLeadCurrent {
                schema_version,
                interface_pairs,
                outer_terminals,
                terminal_observations,
                drives,
                lead_conductivity_spm_per_element,
                lead_mesh,
                ..
            } = &mut source;
            match mutation {
                0 => *schema_version = "foreign".into(),
                1 => interface_pairs[0].vertex_pairs[1] = interface_pairs[0].vertex_pairs[0],
                2 => {
                    outer_terminals[0].boundary_face_vertex_ids[0] =
                        interface_pairs[0].lead_face_vertex_ids
                }
                3 => terminal_observations[1]
                    .interface_pair_ids
                    .push("pair-0".into()),
                4 => {
                    drives[0].outer_terminal_currents_a.remove("left");
                }
                5 => lead_conductivity_spm_per_element[0] = f64::INFINITY,
                6 => drives[0]
                    .outer_terminal_currents_a
                    .insert("foreign".into(), 0.)
                    .map(|_| ())
                    .unwrap_or(()),
                7 => lead_mesh.facets.roles[0] = crate::FemFacetRoleIR::MaterialInterface,
                8 => lead_mesh.nodes[0] = lead_mesh.nodes[1],
                9 => lead_mesh.element_markers[0] = 0,
                _ => lead_mesh.boundary_markers[0] = u32::MAX,
            }
            assert!(
                !source.validation_errors("source").is_empty(),
                "mutation {mutation}"
            );
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StructuredCutAxisIR {
    X,
    Y,
    Z,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StructuredCutNormalIR {
    PositiveAxis,
    NegativeAxis,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StructuredCutPlaneIR {
    pub axis: StructuredCutAxisIR,
    pub offset_m: f64,
    pub normal: StructuredCutNormalIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImpressedPotentialJumpIR {
    pub schema_version: String,
    pub drive_id: String,
    #[serde(rename = "potential_jump_V")]
    pub potential_jump_v: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StructuredCurrentDriveIR {
    ImpressedPotentialJump(ImpressedPotentialJumpIR),
}

impl StructuredCurrentDriveIR {
    pub fn impressed_potential_jump(&self) -> &ImpressedPotentialJumpIR {
        match self {
            Self::ImpressedPotentialJump(drive) => drive,
        }
    }

    pub fn impressed_potential_jump_mut(&mut self) -> &mut ImpressedPotentialJumpIR {
        match self {
            Self::ImpressedPotentialJump(drive) => drive,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StructuredCurrentSourceCutIR {
    pub source_cut_id: String,
    pub circuit_id: String,
    pub region: RegionRefIR,
    pub plane: StructuredCutPlaneIR,
    pub drive: StructuredCurrentDriveIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StructuredCurrentClosureIR {
    ClosedGeometry {
        schema_version: String,
        closure_id: String,
        source_cuts: Vec<StructuredCurrentSourceCutIR>,
    },
}

impl StructuredCurrentClosureIR {
    pub fn validation_errors(&self, path: &str) -> Vec<String> {
        let mut errors = Vec::new();
        let Self::ClosedGeometry {
            schema_version,
            closure_id,
            source_cuts,
        } = self;
        if schema_version != "structured_current_closure.v1" {
            errors.push(format!(
                "{path}.structured_current_closure.schema_version must be 'structured_current_closure.v1'"
            ));
        }
        if closure_id.trim().is_empty() {
            errors.push(format!(
                "{path}.structured_current_closure.closure_id must not be empty"
            ));
        }
        if source_cuts.is_empty() {
            errors.push(format!(
                "{path}.structured_current_closure.source_cuts must not be empty"
            ));
        }
        let mut cut_ids = BTreeSet::new();
        let mut circuit_ids = BTreeSet::new();
        let mut drive_ids = BTreeSet::new();
        for (index, cut) in source_cuts.iter().enumerate() {
            let cut_path = format!("{path}.structured_current_closure.source_cuts[{index}]");
            if cut.source_cut_id.trim().is_empty() {
                errors.push(format!("{cut_path}.source_cut_id must not be empty"));
            } else if !cut_ids.insert(cut.source_cut_id.as_str()) {
                errors.push(format!("{cut_path}.source_cut_id must be unique"));
            }
            if cut.circuit_id.trim().is_empty() {
                errors.push(format!("{cut_path}.circuit_id must not be empty"));
            } else if !circuit_ids.insert(cut.circuit_id.as_str()) {
                errors.push(format!(
                    "{cut_path}.circuit_id must identify exactly one source cut"
                ));
            }
            if cut.region.object_id.trim().is_empty() {
                errors.push(format!("{cut_path}.region.object_id must not be empty"));
            }
            if cut
                .region
                .region_id
                .as_ref()
                .is_some_and(|region_id| region_id.trim().is_empty())
            {
                errors.push(format!("{cut_path}.region.region_id must not be empty"));
            }
            if !cut.plane.offset_m.is_finite() {
                errors.push(format!("{cut_path}.plane.offset_m must be finite"));
            }
            let drive = cut.drive.impressed_potential_jump();
            if drive.schema_version != "impressed_potential_jump.v1" {
                errors.push(format!(
                    "{cut_path}.drive.schema_version must be 'impressed_potential_jump.v1'"
                ));
            }
            if drive.drive_id.trim().is_empty() {
                errors.push(format!("{cut_path}.drive.drive_id must not be empty"));
            } else if !drive_ids.insert(drive.drive_id.as_str()) {
                errors.push(format!("{cut_path}.drive.drive_id must be unique"));
            }
            if !drive.potential_jump_v.is_finite() || drive.potential_jump_v == 0.0 {
                errors.push(format!(
                    "{cut_path}.drive.potential_jump_V must be finite and non-zero"
                ));
            }
        }
        errors
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChargeTransportMaterialAssignmentIR {
    pub region: RegionRefIR,
    pub material: ChargeTransportMaterialIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChargeTransportMaterialIR {
    #[serde(rename = "sigma_Spm")]
    pub sigma_spm: f64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "sigma_parallel_Spm"
    )]
    pub sigma_parallel_spm: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "sigma_perpendicular_Spm"
    )]
    pub sigma_perpendicular_spm: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "sigma_AHE_Spm"
    )]
    pub sigma_ahe_spm: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ChargeBoundaryIR {
    EquipotentialCurrentTerminal {
        id: String,
        surfaces: Vec<SurfaceRefIR>,
    },
    VoltageElectrode {
        id: String,
        surfaces: Vec<SurfaceRefIR>,
        #[serde(rename = "potential_V")]
        potential_v: f64,
    },
    NormalCurrentElectrode {
        id: String,
        surfaces: Vec<SurfaceRefIR>,
        #[serde(rename = "outward_current_density_Apm2")]
        outward_current_density_apm2: f64,
    },
    Insulating {
        id: String,
        surfaces: Vec<SurfaceRefIR>,
    },
}

impl ChargeBoundaryIR {
    pub fn id(&self) -> &str {
        match self {
            Self::EquipotentialCurrentTerminal { id, .. }
            | Self::VoltageElectrode { id, .. }
            | Self::NormalCurrentElectrode { id, .. }
            | Self::Insulating { id, .. } => id,
        }
    }

    pub fn surfaces(&self) -> &[SurfaceRefIR] {
        match self {
            Self::EquipotentialCurrentTerminal { surfaces, .. }
            | Self::VoltageElectrode { surfaces, .. }
            | Self::NormalCurrentElectrode { surfaces, .. }
            | Self::Insulating { surfaces, .. } => surfaces,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChargePotentialGaugeIR {
    DirichletReference,
    ZeroMean,
    TerminalReference,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChargeSolverPolicyIR {
    pub engine: String,
    pub linear: LinearTransportSolverPolicyIR,
    pub physical_residual_version: String,
    pub operator_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpinTransportModuleIR {
    pub schema_version: String,
    pub id: String,
    pub current_source_id: String,
    pub mode: SpinTransportModeIR,
    pub domain: Vec<RegionRefIR>,
    pub materials: Vec<SpinTransportMaterialAssignmentIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub interfaces: Vec<SpinInterfaceIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub boundaries: Vec<SpinBoundaryIR>,
    pub solver: SpinSolverPolicyIR,
    pub requested_execution: RequestedTransportExecutionIR,
    pub constitutive_version: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpinTransportModeIR {
    Steady,
    Transient,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CoupledSpinIntegratorIR {
    CoupledImexArk2,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpinTransportMaterialAssignmentIR {
    pub region: RegionRefIR,
    pub material: SpinTransportMaterialIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpinTransportMaterialIR {
    #[serde(rename = "sigma_s_Spm")]
    pub sigma_s_spm: f64,
    pub polarization_p: f64,
    pub theta_sh: f64,
    pub lambda_sf_m: f64,
    pub lambda_j_m: ReactionLengthIR,
    pub lambda_phi_m: ReactionLengthIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "spin_capacitance_As_per_V_m3")]
    pub spin_capacitance_as_per_v_m3: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capacitance_formula_version: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        rename = "density_of_states_per_spin_Jinv_m3"
    )]
    pub density_of_states_per_spin_j_inv_m3: Option<f64>,
}

impl SpinTransportMaterialIR {
    pub fn resolved_spin_capacitance_as_per_v_m3(&self) -> Option<f64> {
        self.spin_capacitance_as_per_v_m3.or_else(|| {
            self.density_of_states_per_spin_j_inv_m3
                .map(crate::spin_capacitance_from_density_of_states)
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum ReactionLengthIR {
    Enabled(f64),
    Disabled(DisabledReactionIR),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum DisabledReactionIR {
    #[serde(rename = "disabled")]
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SpinInterfaceIR {
    Transparent {
        id: String,
        side_a: RegionRefIR,
        side_b: RegionRefIR,
        normal_a_to_b: [f64; 3],
    },
    MixingConductance {
        id: String,
        normal_to_ferromagnet: [f64; 3],
        normal_side: RegionRefIR,
        ferromagnet_side: RegionRefIR,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        normal_surface: Option<SurfaceRefIR>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ferromagnet_surface: Option<SurfaceRefIR>,
        #[serde(rename = "g_up_Spm2")]
        g_up_spm2: f64,
        #[serde(rename = "g_down_Spm2")]
        g_down_spm2: f64,
        #[serde(rename = "g_r_Spm2")]
        g_r_spm2: f64,
        #[serde(rename = "g_i_Spm2")]
        g_i_spm2: f64,
        #[serde(default, skip_serializing_if = "is_zero_f64", rename = "g_sml_Spm2")]
        g_sml_spm2: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        spin_memory_loss: Option<SpinMemoryLossReservoirIR>,
        absorption: String,
        formula_version: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SpinBoundaryIR {
    SpinInsulating {
        id: String,
        surfaces: Vec<SurfaceRefIR>,
    },
    SpinSink {
        id: String,
        surfaces: Vec<SurfaceRefIR>,
    },
    SpecifiedSpinPotential {
        id: String,
        surfaces: Vec<SurfaceRefIR>,
        #[serde(rename = "spin_potential_V")]
        spin_potential_v: [f64; 3],
    },
    SpecifiedSpinFlux {
        id: String,
        surfaces: Vec<SurfaceRefIR>,
        #[serde(rename = "normal_spin_flux_Apm2")]
        normal_spin_flux_apm2: [f64; 3],
    },
    PeriodicSpin {
        id: String,
        minus_surface: SurfaceRefIR,
        plus_surface: SurfaceRefIR,
        translation_m: [f64; 3],
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LinearTransportSolverPolicyIR {
    pub relative_tolerance: f64,
    pub absolute_tolerance: f64,
    pub max_iterations: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpinSolverPolicyIR {
    pub engine: String,
    pub linear: LinearTransportSolverPolicyIR,
    pub physical_residual_version: String,
    pub operator_version: String,
    pub default_external_boundary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reciprocal_nonlinear: Option<ReciprocalNonlinearSolverPolicyIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReciprocalNonlinearSolverPolicyIR {
    pub gmres_restart: u32,
    pub max_picard_iterations: u32,
    pub relative_update_tolerance: f64,
    pub eta_transport: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RequestedTransportExecutionIR {
    pub discretization: crate::BackendTarget,
    pub device: ExecutionDevice,
    pub precision: ExecutionPrecision,
    pub execution_mode: ExecutionMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedSpinTransportPlanIR {
    pub module_id: String,
    pub current_source_id: String,
    pub resolved_coupling: TransportCouplingIR,
    pub requested_execution: RequestedTransportExecutionIR,
    pub resolved_discretization: crate::BackendTarget,
    pub resolved_device: ExecutionDevice,
    pub resolved_precision: ExecutionPrecision,
    pub resolved_execution_mode: ExecutionMode,
    pub constitutive_version: String,
    pub operator_version: String,
    pub physical_residual_version: String,
    pub capabilities: Vec<String>,
    pub inserted_default_boundaries: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fdm_cpu_double: Option<ResolvedFdmSpinTransportIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fdm_gpu_double: Option<ResolvedFdmSpinTransportIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fdm_cpu_double_reciprocal: Option<ResolvedFdmCoupledSpinTransportIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fdm_cpu_double_transient: Option<ResolvedFdmTransientSpinTransportIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fem_cpu_double: Option<ResolvedFemSpinTransportIR>,
}

/// Resolved standalone charge solve.  This remains separate from
/// `ResolvedSpinTransportPlanIR`: an Ohmic conductor does not imply spin
/// transport and must not manufacture a synthetic spin module.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedChargeTransportPlanIR {
    pub module_id: String,
    pub resolved_coupling: TransportCouplingIR,
    pub requested_execution: RequestedTransportExecutionIR,
    pub resolved_discretization: crate::BackendTarget,
    pub resolved_device: ExecutionDevice,
    pub resolved_precision: ExecutionPrecision,
    pub resolved_execution_mode: ExecutionMode,
    pub operator_version: String,
    pub physical_residual_version: String,
    pub capabilities: Vec<String>,
    pub inserted_default_boundaries: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub antenna_field_solution_request: Option<crate::ResolvedAntennaFieldSolutionRequestIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fem_cpu_double: Option<ResolvedFemChargeTransportIR>,
}

/// Complete FEM CPU/double descriptor for a one-way Ohmic charge solve.
/// Numerical current fields remain runtime-owned; this descriptor pins the
/// domain, coefficients, boundary partition and optional conservative view.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedFemChargeTransportIR {
    pub descriptor_schema: String,
    pub charge_definition: ChargeTransportDefinitionIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_envelope: Option<crate::TimeEnvelopeIR>,
    pub charge_domain: ResolvedFemTransportDomainIR,
    pub charge_insulating_boundaries: Vec<ResolvedFemBoundaryMarkerSetIR>,
    pub charge_driven_boundaries: Vec<ResolvedFemBoundaryMarkerSetIR>,
    pub charge_conductivity_spm_per_element: Vec<f64>,
    pub charge_gauge: ChargePotentialGaugeIR,
    pub charge_solver: ChargeSolverPolicyIR,
    pub charge_dirichlet: Vec<(u32, f64)>,
    pub resolved_charge_engine: String,
    pub stage_coupling: String,
    pub capability_status: String,
    pub implementation_state: String,
    pub validation_state: String,
    pub validation_scope: String,
    #[serde(default)]
    pub oersted_source_bound: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conservative_current_view: Option<ResolvedFemConservativeCurrentViewIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedFemSpinTransportIR {
    pub descriptor_schema: String,
    pub charge_definition: ChargeTransportDefinitionIR,
    /// Authored charge-source envelope copied from the owning current module.
    /// It is evaluated at every native stage; it is not a solver tolerance or
    /// a post-hoc field scaling.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_envelope: Option<crate::TimeEnvelopeIR>,
    pub charge_domain: ResolvedFemTransportDomainIR,
    pub spin_domain: ResolvedFemTransportDomainIR,
    pub charge_insulating_boundaries: Vec<ResolvedFemBoundaryMarkerSetIR>,
    pub spin_insulating_boundaries: Vec<ResolvedFemBoundaryMarkerSetIR>,
    pub interfaces: Vec<ResolvedFemTransportInterfaceIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub torque_target: Option<ResolvedFemTorqueTargetIR>,
    pub charge_conductivity_spm_per_element: Vec<f64>,
    pub charge_gauge: ChargePotentialGaugeIR,
    pub charge_solver: ChargeSolverPolicyIR,
    pub charge_dirichlet: Vec<(u32, f64)>,
    pub spin_dirichlet: Vec<(u32, [f64; 3])>,
    #[serde(rename = "sigma_s_Spm")]
    pub sigma_s_spm: f64,
    /// Present only for the bounded reciprocal FEM M2 reference lane.  The
    /// native FEM ABI currently accepts one uniform anisotropic charge tensor
    /// over the conforming solve domain; elementwise `sigma_spm` remains in
    /// `charge_conductivity_spm_per_element`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reciprocal_material: Option<ResolvedReciprocalMaterialIR>,
    pub polarization_p: f64,
    pub theta_sh: f64,
    pub lambda_sf_m: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lambda_j_m: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lambda_phi_m: Option<f64>,
    pub saturation_magnetization_apm: f64,
    pub gamma_e_rad_per_s_t: f64,
    pub spin_solver: SpinSolverPolicyIR,
    pub resolved_charge_engine: String,
    pub resolved_spin_engine: String,
    pub interface_law: String,
    pub interface_realization: String,
    pub stage_coupling: String,
    pub capability_status: String,
    pub implementation_state: String,
    pub validation_state: String,
    pub validation_scope: String,
    /// The named steady charge solution is consumed by a bounded FEM
    /// midpoint-Biot--Savart Oersted realization.  This is deliberately a
    /// descriptor bit rather than a copied current field: the runtime must
    /// solve charge first and derive the magnetic field from that result.
    #[serde(default)]
    pub oersted_source_bound: bool,
    /// Optional closure-aware solved-current request.  `None` is the legacy
    /// H1/P1 nodal reference lane; it must never be interpreted as an RT0
    /// view by the runner.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conservative_current_view: Option<ResolvedFemConservativeCurrentViewIR>,
}

/// Stable identity pinned to one accepted/stage charge solve.  These values
/// are semantic inputs to the native RT0 adapter and are deliberately kept in
/// the resolved plan rather than reconstructed by the runner.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConservativeCurrentIdentityIR {
    pub source_module_id: String,
    pub source_state_revision: String,
    pub source_field_digest: String,
    pub conductivity_digest: String,
    pub mesh_revision: String,
    pub topology_revision: String,
    pub geometry_digest: String,
    pub envelope_revision: String,
    pub envelope_digest: String,
    pub evaluated_envelope_multiplier: f64,
    pub evaluation_time_s: f64,
    pub stage_identity: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConservativeCurrentPinsIR {
    pub required_source_state_revision: String,
    pub required_source_field_digest: String,
    pub required_mesh_revision: String,
    pub required_topology_revision: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConservativeCurrentBoundaryRoleIR {
    InsulatingOuter,
    SourceCut,
    ClosureInterface,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConservativeCurrentBoundaryFaceIR {
    pub face_vertex_ids: [u64; 3],
    pub role: ConservativeCurrentBoundaryRoleIR,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub circuit_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConservativeCurrentSourceCutFacePairIR {
    pub minus_face_vertex_ids: [u64; 3],
    pub plus_face_vertex_ids: [u64; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConservativeCurrentSourceCutIR {
    pub id: String,
    pub translation_m: [f64; 3],
    pub potential_drop_v: f64,
    pub face_pairs: Vec<ConservativeCurrentSourceCutFacePairIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConservativeCurrentClosureIR {
    ClosedGeometry {
        operator_version: String,
        revision: String,
        digest: String,
        source_cuts: Vec<ConservativeCurrentSourceCutIR>,
    },
    ExternalLead {
        operator_version: String,
        revision: String,
        digest: String,
        drive_id: String,
        outer_electrode_potential_drop_v: f64,
        lead_mesh: MeshIR,
        lead_conductivity_spm_per_element: Vec<f64>,
        lead_stable_vertex_ids: Vec<u64>,
        interface_pairs: Vec<([u64; 3], [u64; 3])>,
        minus_outer_electrode_face_vertex_ids: Vec<[u64; 3]>,
        plus_outer_electrode_face_vertex_ids: Vec<[u64; 3]>,
        lead_conductivity_digest: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedFemConservativeCurrentViewIR {
    pub stable_vertex_ids: Vec<u64>,
    pub boundary_faces: Vec<ConservativeCurrentBoundaryFaceIR>,
    pub identity: ConservativeCurrentIdentityIR,
    pub pins: ConservativeCurrentPinsIR,
    pub closure: ConservativeCurrentClosureIR,
    pub algebraic_relative_tolerance: f64,
    pub physical_relative_gate: f64,
    pub physical_absolute_gate_a: f64,
    #[serde(default)]
    pub reference_mpi_gather_broadcast: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedFemTransportDomainIR {
    pub regions: Vec<RegionRefIR>,
    pub element_mask: Vec<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolvedFemBoundaryMarkerSetIR {
    pub id: String,
    pub boundary_attributes: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedFemTransportInterfaceIR {
    pub id: String,
    pub side_a: RegionRefIR,
    pub side_b: RegionRefIR,
    pub normal_a_to_b: [f64; 3],
    pub law: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedFemTorqueTargetIR {
    pub torque_module_id: String,
    pub target: RegionRefIR,
    pub element_mask: Vec<bool>,
    pub formula_version: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum StructuredBoundaryFaceIR {
    XMin,
    XMax,
    YMin,
    YMax,
    ZMin,
    ZMax,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StructuredInternalFaceIR {
    pub axis: u8,
    pub negative_cell: u64,
    pub positive_cell: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolvedChargeBoundaryConditionIR {
    Voltage {
        #[serde(rename = "potential_V")]
        potential_v: f64,
    },
    OutwardNormalCurrentDensity {
        #[serde(rename = "current_density_Apm2")]
        current_density_apm2: f64,
    },
    Insulating,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedChargeBoundaryFaceIR {
    pub source_id: String,
    pub face: StructuredBoundaryFaceIR,
    pub condition: ResolvedChargeBoundaryConditionIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedSpecifiedCurrentFaceIR {
    pub source_id: String,
    pub axis: u8,
    pub face_index: u64,
    pub adjacent_cell: u64,
    pub outward_normal_sign: i8,
    pub area_m2: f64,
    #[serde(rename = "outward_current_density_Apm2")]
    pub outward_current_density_apm2: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedFdmStructuredCurrentSourceCutIR {
    pub source_cut_id: String,
    pub circuit_id: String,
    pub drive_id: String,
    pub region: RegionRefIR,
    pub axis: u8,
    pub plane_face_index: u32,
    pub normal_sign: i8,
    pub component_label: u32,
    #[serde(rename = "potential_jump_V")]
    pub potential_jump_v: f64,
    pub faces: Vec<StructuredInternalFaceIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedFdmStructuredCurrentClosureIR {
    pub schema_version: String,
    pub closure_id: String,
    pub descriptor_sha256: String,
    pub grid_shape: [u32; 3],
    pub origin_m: [f64; 3],
    pub cell_size_m: [f64; 3],
    pub active_mask_sha256: String,
    pub topology_sha256: String,
    pub component_labels: Vec<u32>,
    pub source_cuts: Vec<ResolvedFdmStructuredCurrentSourceCutIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolvedSpinBoundaryConditionIR {
    SpinInsulating,
    SpinSink,
    SpecifiedPotential {
        #[serde(rename = "value_V")]
        value_v: [f64; 3],
    },
    SpecifiedOutwardFlux {
        #[serde(rename = "value_Apm2")]
        value_apm2: [f64; 3],
    },
    PeriodicSpin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedSpinBoundaryFaceIR {
    pub source_id: String,
    pub face: StructuredBoundaryFaceIR,
    pub condition: ResolvedSpinBoundaryConditionIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolvedSpinInterfaceLawIR {
    Transparent,
    MixingConductance {
        #[serde(rename = "g_up_Spm2")]
        g_up_spm2: f64,
        #[serde(rename = "g_down_Spm2")]
        g_down_spm2: f64,
        #[serde(rename = "g_r_Spm2")]
        g_r_spm2: f64,
        #[serde(rename = "g_i_Spm2")]
        g_i_spm2: f64,
        #[serde(default, skip_serializing_if = "is_zero_f64", rename = "g_sml_Spm2")]
        g_sml_spm2: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        spin_memory_loss: Option<SpinMemoryLossReservoirIR>,
        formula_version: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedSpinInterfaceFaceIR {
    pub source_id: String,
    pub face: StructuredInternalFaceIR,
    pub from_cell: u64,
    pub to_cell: u64,
    pub law: ResolvedSpinInterfaceLawIR,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct ResolvedSpinReactionLengthsIR {
    pub spin_flip_m: Option<f64>,
    pub exchange_m: Option<f64>,
    pub dephasing_m: Option<f64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum FdmCpuTransportRealizationIR {
    #[default]
    RustReferenceV1,
    NativeM1V1,
}

/// Bounded standalone charge-only realization for the native FDM CUDA lane.
///
/// This is resolved execution data, not a second authoring contract: the
/// public source remains `CurrentTransport(ohmic_poisson)` and the planner
/// materializes its structured-grid cells, coefficients, and boundary faces.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedFdmGpuChargeTransportIR {
    pub descriptor_schema: String,
    pub descriptor_revision: u64,
    pub source_revision: u64,
    pub implementation_version: String,
    pub validation_state: String,
    pub descriptor_sha256: String,
    pub module_id: String,
    pub requested_execution: RequestedTransportExecutionIR,
    pub resolved_discretization: crate::BackendTarget,
    pub resolved_device: ExecutionDevice,
    pub resolved_precision: ExecutionPrecision,
    pub resolved_execution_mode: ExecutionMode,
    pub capabilities: Vec<String>,
    pub charge_active_cells: Vec<bool>,
    #[serde(rename = "charge_conductivity_Spm")]
    pub charge_conductivity_spm: Vec<f64>,
    pub charge_boundaries: Vec<ResolvedChargeBoundaryFaceIR>,
    pub charge_gauge: ChargePotentialGaugeIR,
    pub charge_solver: ChargeSolverPolicyIR,
    pub region_ids: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedFdmTorqueTargetMaskIR {
    pub torque_module_id: String,
    pub target: RegionRefIR,
    pub active_mask: Vec<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedFdmSpinTransportIR {
    pub descriptor_schema: String,
    #[serde(default)]
    pub realization: FdmCpuTransportRealizationIR,
    /// Global validation/execution profile enclosing this resolved module.
    /// Missing legacy data defaults to `extended`, so strict native lanes fail closed.
    #[serde(default = "default_transport_enclosing_execution_mode")]
    pub enclosing_execution_mode: ExecutionMode,
    /// Authored dimensionless charge-source multiplier evaluated at each FDM
    /// transport stage.  `None` means the source is constant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_envelope: Option<crate::TimeEnvelopeIR>,
    /// Union of the authored charge-transport domain on the resolved common grid.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transport_active_mask: Vec<bool>,
    /// Cells that carry magnetization dynamics on the resolved common grid.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub magnetic_active_mask: Vec<bool>,
    pub charge_active_cells: Vec<bool>,
    #[serde(rename = "charge_conductivity_Spm")]
    pub charge_conductivity_spm: Vec<f64>,
    pub charge_boundaries: Vec<ResolvedChargeBoundaryFaceIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub specified_current_faces: Vec<ResolvedSpecifiedCurrentFaceIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub structured_current_closure: Option<ResolvedFdmStructuredCurrentClosureIR>,
    pub charge_gauge: ChargePotentialGaugeIR,
    pub charge_solver: ChargeSolverPolicyIR,
    pub spin_active_cells: Vec<bool>,
    #[serde(rename = "spin_conductivity_Spm")]
    pub spin_conductivity_spm: Vec<f64>,
    pub polarization_p: Vec<f64>,
    pub theta_sh: Vec<f64>,
    pub reactions: Vec<ResolvedSpinReactionLengthsIR>,
    pub region_ids: Vec<u32>,
    pub spin_boundaries: Vec<ResolvedSpinBoundaryFaceIR>,
    pub interfaces: Vec<ResolvedSpinInterfaceFaceIR>,
    /// Per-consumer torque targets retained separately from the aggregate legacy mask.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub torque_target_masks: Vec<ResolvedFdmTorqueTargetMaskIR>,
    pub torque_target_cells: Vec<bool>,
    #[serde(rename = "saturation_magnetization_Apm")]
    pub saturation_magnetization_apm: Vec<f64>,
    #[serde(rename = "gamma_e_rad_per_s_T")]
    pub gamma_e_rad_per_s_t: f64,
    pub spin_solver: SpinSolverPolicyIR,
    pub torque_formula_version: Option<String>,
    pub oersted_source_bound: bool,
}

fn default_transport_enclosing_execution_mode() -> ExecutionMode {
    ExecutionMode::Extended
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedFdmTransientSpinTransportIR {
    pub descriptor_schema: String,
    pub steady_operator: ResolvedFdmSpinTransportIR,
    #[serde(rename = "spin_capacitance_As_per_V_m3")]
    pub spin_capacitance_as_per_v_m3: Vec<f64>,
    pub capacitance_formula_versions: Vec<String>,
    pub transient_formula_version: String,
    pub integrator: CoupledSpinIntegratorIR,
    pub integrator_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedReciprocalMaterialIR {
    #[serde(rename = "sigma_Spm")]
    pub sigma_spm: f64,
    #[serde(rename = "sigma_spin_Spm")]
    pub sigma_spin_spm: f64,
    #[serde(rename = "sigma_parallel_Spm")]
    pub sigma_parallel_spm: f64,
    #[serde(rename = "sigma_perpendicular_Spm")]
    pub sigma_perpendicular_spm: f64,
    #[serde(rename = "sigma_AHE_Spm")]
    pub sigma_ahe_spm: f64,
    pub polarization_p: f64,
    pub theta_sh: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedFdmCoupledSpinTransportIR {
    pub descriptor_schema: String,
    /// Authored charge-source envelope evaluated at each coupled transport
    /// stage.  It scales only prescribed charge drives; the reciprocal
    /// constitutive solve still uses the stage magnetization to determine
    /// `J_c(m_stage)` and the resulting spin torque.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_envelope: Option<crate::TimeEnvelopeIR>,
    pub active_cells: Vec<bool>,
    pub reciprocal_materials: Vec<ResolvedReciprocalMaterialIR>,
    pub reactions: Vec<ResolvedSpinReactionLengthsIR>,
    pub region_ids: Vec<u32>,
    pub charge_boundaries: Vec<ResolvedChargeBoundaryFaceIR>,
    pub spin_boundaries: Vec<ResolvedSpinBoundaryFaceIR>,
    pub interfaces: Vec<ResolvedSpinInterfaceFaceIR>,
    pub torque_target_cells: Vec<bool>,
    #[serde(rename = "saturation_magnetization_Apm")]
    pub saturation_magnetization_apm: Vec<f64>,
    #[serde(rename = "gamma_e_rad_per_s_T")]
    pub gamma_e_rad_per_s_t: f64,
    pub linear_solver: LinearTransportSolverPolicyIR,
    pub nonlinear_solver: ReciprocalNonlinearSolverPolicyIR,
    pub operator_version: String,
    pub physical_residual_version: String,
    pub constitutive_version: String,
    pub torque_formula_version: Option<String>,
    pub oersted_source_bound: bool,
}
