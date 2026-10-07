//! One owned modeled-domain V/RT0/H bundle, not a complete closed circuit.

#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
use super::accepted_terminal_charge::require;
#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
use super::accepted_terminal_charge::{
    input_text, result_text, with_packed_charge_request, AcceptedTerminalChargeRequest,
};
#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
use crate::types::RunError;
#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
use fullmag_fem_sys as ffi;
#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
use std::collections::{BTreeMap, BTreeSet};
#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
use std::ffi::CString;

mod record;
#[cfg(all(test, any(feature = "fem-native", feature = "fem-gpu")))]
pub(crate) use record::inspection_test_bundle;
#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
pub(crate) use record::validate_bundle_request;
pub(crate) use record::{decode_owned_bundle, AcceptedExternalLeadBundle};
#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
mod input;
#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
pub(crate) use input::with_materialized_external_lead_request;

pub(crate) const MAX_PAYLOAD_BYTES: usize = 128 << 20;
#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
const _: () =
    assert!(MAX_PAYLOAD_BYTES == ffi::FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_MAX_PAYLOAD_BYTES);

const SCHEMA: &str = "accepted_external_lead_bundle.ordered.v1";
const OPERATOR: &str = "fem_accepted_external_lead_bundle.v1";
const SCOPE: &str = "external_electrode_truncation";

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ExternalLeadBoundary {
    pub vertex_ids: [u64; 3],
    pub role: u32,
    pub circuit_id: String,
}

#[derive(Debug, Clone)]
pub(crate) struct ExternalLeadBranch {
    pub id: String,
    pub interface_pair_ids: Vec<String>,
    pub requested_device_outward_current_a: f64,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ExternalLeadQuadraturePolicy {
    pub base_quadrature_order: i32,
    pub maximum_subdivision_depth: i32,
    pub absolute_tolerance_apm: f64,
    pub relative_tolerance: f64,
    pub maximum_source_target_pairs: u64,
}

#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
pub(crate) struct AcceptedExternalLeadRequest<'a> {
    pub charge: AcceptedTerminalChargeRequest<'a>,
    pub closure_revision: &'a str,
    pub device_vertex_ids: &'a [u64],
    pub lead_vertex_ids: &'a [u64],
    pub boundary_faces: &'a [ExternalLeadBoundary],
    pub branches: &'a [ExternalLeadBranch],
    pub targets_m: &'a [[f64; 3]],
    pub quadrature: ExternalLeadQuadraturePolicy,
}

#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
fn preflight(request: &AcceptedExternalLeadRequest<'_>) -> Result<(), RunError> {
    let n = request.charge.mesh.nodes.len();
    request.charge.mesh.validate().map_err(|errors| RunError {
        message: format!("invalid external lead charge mesh: {}", errors.join("; ")),
    })?;
    request
        .charge
        .mesh
        .cells
        .require_tet4()
        .map_err(|error| RunError {
            message: error.to_string(),
        })?;
    require(
        n == request.charge.stable_vertex_ids.len()
            && request.charge.mesh.cell_count()
                == request.charge.conductivity_spm_per_element.len(),
        "external lead charge identity/material cardinality mismatch",
    )?;
    require(
        !request.device_vertex_ids.is_empty()
            && !request.lead_vertex_ids.is_empty()
            && request
                .device_vertex_ids
                .len()
                .checked_add(request.lead_vertex_ids.len())
                == Some(n),
        "external lead partition cardinality differs from charge mesh",
    )?;
    let partition = request
        .device_vertex_ids
        .iter()
        .chain(request.lead_vertex_ids)
        .copied()
        .collect::<BTreeSet<_>>();
    require(
        partition.len() == n
            && partition == request.charge.stable_vertex_ids.iter().copied().collect(),
        "external lead partition is repeated or foreign",
    )?;
    require(
        !request.branches.is_empty()
            && request.branches.len() <= request.charge.interfaces.len()
            && request.boundary_faces.len() <= request.charge.mesh.facets.types.len(),
        "external lead controls exceed charge support",
    )?;
    let p = request.quadrature;
    let pairs = request
        .charge
        .mesh
        .cell_count()
        .checked_mul(request.targets_m.len());
    require(
        (2..=16).contains(&p.base_quadrature_order)
            && (0..=6).contains(&p.maximum_subdivision_depth)
            && p.absolute_tolerance_apm.is_finite()
            && p.absolute_tolerance_apm >= 0.0
            && p.relative_tolerance.is_finite()
            && p.relative_tolerance >= 0.0
            && (1..=1_000_000).contains(&p.maximum_source_target_pairs)
            && pairs.is_some_and(|pairs| pairs as u64 <= p.maximum_source_target_pairs)
            && request
                .targets_m
                .iter()
                .flatten()
                .all(|value| value.is_finite()),
        "external lead field policy/targets exceed bounded support",
    )?;
    let ids = request
        .charge
        .interfaces
        .iter()
        .map(|pair| pair.id.as_str())
        .collect::<BTreeSet<_>>();
    let mut used = BTreeSet::new();
    let mut branches = BTreeSet::new();
    for branch in request.branches {
        require(
            branches.insert(branch.id.as_str())
                && !branch.interface_pair_ids.is_empty()
                && branch.requested_device_outward_current_a.is_finite()
                && branch
                    .interface_pair_ids
                    .iter()
                    .all(|id| ids.contains(id.as_str()) && used.insert(id.as_str())),
            "external lead branches repeat/invent interfaces or contain invalid current",
        )?;
    }
    require(used == ids, "external lead branches omit charge interfaces")?;
    let device = request
        .device_vertex_ids
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    let lead = request
        .lead_vertex_ids
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    let cells = request
        .charge
        .mesh
        .cells
        .require_tet4()
        .map_err(|error| RunError {
            message: error.to_string(),
        })?;
    for cell in cells {
        let ids = cell.map(|local| request.charge.stable_vertex_ids[local as usize]);
        require(
            ids.iter().all(|id| device.contains(id)) || ids.iter().all(|id| lead.contains(id)),
            "external partition splits a tetrahedron",
        )?;
    }
    let mut expected_roles = BTreeMap::new();
    let mut trace_vertices = BTreeSet::new();
    let mut electrode_vertices = BTreeMap::new();
    for pair in request.charge.interfaces {
        require(
            pair.first_face_vertex_ids
                .iter()
                .all(|id| device.contains(id))
                && pair
                    .second_face_vertex_ids
                    .iter()
                    .all(|id| lead.contains(id)),
            "external interface is not first=device second=lead",
        )?;
        for face in [pair.first_face_vertex_ids, pair.second_face_vertex_ids] {
            require(
                expected_roles.insert(face, (3, pair.id.as_str())).is_none(),
                "external interface face is multiply assigned",
            )?;
            trace_vertices.extend(face);
        }
    }
    for terminal in request.charge.terminals {
        for face in &terminal.boundary_face_vertex_ids {
            require(
                face.iter().all(|id| lead.contains(id))
                    && expected_roles
                        .insert(*face, (2, terminal.id.as_str()))
                        .is_none(),
                "external electrode face overlaps interface or device",
            )?;
            for id in face {
                require(
                    !trace_vertices.contains(id)
                        && electrode_vertices
                            .get(id)
                            .is_none_or(|old| *old == terminal.id.as_str()),
                    "external electrode P1 DOF overlaps a trace or another terminal",
                )?;
                electrode_vertices.insert(*id, terminal.id.as_str());
            }
        }
    }
    let by_interface = request
        .charge
        .interfaces
        .iter()
        .map(|pair| (pair.id.as_str(), pair))
        .collect::<BTreeMap<_, _>>();
    let mut observed_vertices = BTreeSet::new();
    for branch in request.branches {
        let vertices = branch
            .interface_pair_ids
            .iter()
            .flat_map(|id| by_interface[id.as_str()].first_face_vertex_ids)
            .collect::<BTreeSet<_>>();
        require(
            vertices.into_iter().all(|id| observed_vertices.insert(id)),
            "external branches share P1 reaction DOFs",
        )?;
    }
    for face in request.boundary_faces {
        require(
            face.vertex_ids[0] < face.vertex_ids[1]
                && face.vertex_ids[1] < face.vertex_ids[2]
                && ((face.role == 1 && face.circuit_id.is_empty())
                    || ((face.role == 2 || face.role == 3) && !face.circuit_id.is_empty())),
            "external lead boundary role/circuit/key is invalid",
        )?;
        require(
            expected_roles
                .get(&face.vertex_ids)
                .copied()
                .unwrap_or((1, ""))
                == (face.role, face.circuit_id.as_str()),
            "external boundary roles differ from charge groups",
        )?;
    }
    Ok(())
}

#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
pub(crate) fn solve_accepted_external_lead_field(
    request: &AcceptedExternalLeadRequest<'_>,
) -> Result<AcceptedExternalLeadBundle, RunError> {
    preflight(request)?;
    let revision = input_text(request.closure_revision)?;
    let circuit_ids = request
        .boundary_faces
        .iter()
        .map(|face| {
            if face.circuit_id.is_empty() {
                Ok(CString::default())
            } else {
                input_text(&face.circuit_id)
            }
        })
        .collect::<Result<Vec<_>, RunError>>()?;
    let boundary_faces = request
        .boundary_faces
        .iter()
        .zip(&circuit_ids)
        .map(
            |(face, circuit)| ffi::fullmag_fem_accepted_external_lead_boundary_v1 {
                vertex_ids: face.vertex_ids,
                role: face.role,
                reserved: 0,
                circuit_id: circuit.as_ptr(),
            },
        )
        .collect::<Vec<_>>();
    let branch_ids = request
        .branches
        .iter()
        .map(|branch| input_text(&branch.id))
        .collect::<Result<Vec<_>, _>>()?;
    let pair_ids = request
        .branches
        .iter()
        .map(|branch| {
            branch
                .interface_pair_ids
                .iter()
                .map(|id| input_text(id))
                .collect::<Result<Vec<_>, _>>()
        })
        .collect::<Result<Vec<_>, _>>()?;
    let pair_pointers = pair_ids
        .iter()
        .map(|ids| ids.iter().map(|id| id.as_ptr()).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    let branches = request
        .branches
        .iter()
        .enumerate()
        .map(
            |(i, branch)| ffi::fullmag_fem_accepted_external_lead_branch_v1 {
                id: branch_ids[i].as_ptr(),
                interface_pair_ids: pair_pointers[i].as_ptr(),
                interface_pair_count: pair_pointers[i].len() as u64,
                requested_device_outward_current_a: branch.requested_device_outward_current_a,
            },
        )
        .collect::<Vec<_>>();
    let targets = request
        .targets_m
        .iter()
        .flatten()
        .copied()
        .collect::<Vec<_>>();
    with_packed_charge_request(&request.charge, |charge| {
        let p = request.quadrature;
        let input = ffi::fullmag_fem_accepted_external_lead_request_v1 {
            abi_version: ffi::FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_ABI_VERSION,
            reserved_flags: 0,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_accepted_external_lead_request_v1>()
                as u64,
            charge: *charge,
            closure_revision: revision.as_ptr(),
            device_vertex_ids: request.device_vertex_ids.as_ptr(),
            device_vertex_count: request.device_vertex_ids.len() as u64,
            lead_vertex_ids: request.lead_vertex_ids.as_ptr(),
            lead_vertex_count: request.lead_vertex_ids.len() as u64,
            boundary_faces: super::optional_slice_ptr(&boundary_faces),
            boundary_face_count: boundary_faces.len() as u64,
            branches: branches.as_ptr(),
            branch_count: branches.len() as u64,
            target_xyz_m: super::optional_slice_ptr(&targets),
            target_count: request.targets_m.len() as u64,
            base_quadrature_order: p.base_quadrature_order,
            maximum_subdivision_depth: p.maximum_subdivision_depth,
            absolute_tolerance_apm: p.absolute_tolerance_apm,
            relative_tolerance: p.relative_tolerance,
            maximum_source_target_pairs: p.maximum_source_target_pairs,
        };
        let mut payload = Vec::new();
        payload
            .try_reserve_exact(ffi::FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_MAX_PAYLOAD_BYTES)
            .map_err(|_| RunError {
                message: "cannot reserve accepted external lead bundle".into(),
            })?;
        payload.resize(ffi::FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_MAX_PAYLOAD_BYTES, 0);
        let mut output = ffi::fullmag_fem_accepted_external_lead_result_v1 {
            abi_version: input.abi_version,
            reserved_flags: 0,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_accepted_external_lead_result_v1>()
                as u64,
            canonical_payload: payload.as_mut_ptr(),
            canonical_payload_capacity: payload.len() as u64,
            canonical_payload_len: 0,
            digest_schema: [0; 96],
            operator_version: [0; 96],
            layout_fingerprint: [0; 96],
            content_sha256: [0; 65],
            error_message: [0; 256],
        };
        // SAFETY: the nested charge pack and every closure/target buffer outlive this single call.
        let status =
            unsafe { ffi::fullmag_fem_solve_accepted_external_lead_field_v1(&input, &mut output) };
        require(
            output.abi_version == input.abi_version
                && output.reserved_flags == 0
                && output.struct_size == std::mem::size_of_val(&output) as u64
                && output.canonical_payload == payload.as_mut_ptr()
                && output.canonical_payload_capacity == payload.len() as u64,
            "native external lead result modified caller-owned buffer/header",
        )?;
        if status != ffi::FULLMAG_FEM_OK {
            require(
                output.canonical_payload_len == 0
                    && output.content_sha256[0] == 0
                    && output.digest_schema[0] == 0
                    && output.operator_version[0] == 0
                    && output.layout_fingerprint[0] == 0,
                "failed external lead solve published acceptance metadata",
            )?;
            return Err(RunError {
                message: format!(
                    "accepted external lead failed ({status}): {}",
                    result_text(&output.error_message)?
                ),
            });
        }
        require(
            result_text(&output.digest_schema)? == SCHEMA
                && result_text(&output.operator_version)? == OPERATOR
                && result_text(&output.layout_fingerprint)?
                    == ffi::FULLMAG_FEM_ACCEPTED_EXTERNAL_LEAD_LAYOUT_FINGERPRINT
                && output.error_message[0] == 0
                && output.canonical_payload_len > 0
                && output.canonical_payload_len <= payload.len() as u64,
            "native external lead schema/layout/length mismatch",
        )?;
        payload.truncate(output.canonical_payload_len as usize);
        record::decode_bundle(payload, &result_text(&output.content_sha256)?, request)
    })
}
