//! One owned current-driven charge record, without a closure/H attestation.

use crate::types::RunError;
#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
use fullmag_fem_sys as ffi;
#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
use fullmag_ir::{FemFacetRoleIR, MeshIR};
#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
use std::collections::{BTreeMap, BTreeSet};
#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
use std::ffi::CString;

pub(super) mod record;
pub(crate) use record::AcceptedTerminalChargeRecord;

pub(crate) const MAX_PAYLOAD_BYTES: usize = 128 << 20;
#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
const _: () =
    assert!(MAX_PAYLOAD_BYTES == ffi::FULLMAG_FEM_ACCEPTED_TERMINAL_CHARGE_MAX_PAYLOAD_BYTES);
pub(crate) const DIGEST_SCHEMA: &str = "accepted_terminal_charge_source.ordered.v1";
pub(crate) const OPERATOR_VERSION: &str = "fem_accepted_terminal_charge_source.v1";

#[derive(Debug, Clone)]
pub(crate) struct AcceptedChargeTerminal {
    pub id: String,
    pub boundary_face_vertex_ids: Vec<[u64; 3]>,
    pub requested_outward_current_a: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AcceptedChargeInterface {
    pub id: String,
    pub first_face_vertex_ids: [u64; 3],
    pub second_face_vertex_ids: [u64; 3],
    pub vertex_pairs: [[u64; 2]; 3],
}

#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
pub(crate) struct AcceptedTerminalChargeRequest<'a> {
    pub mesh: &'a MeshIR,
    pub execution_lane: ffi::fullmag_fem_steady_transport_execution_lane,
    pub stable_vertex_version: &'a str,
    pub stable_vertex_ids: &'a [u64],
    pub conductivity_spm_per_element: &'a [f64],
    pub terminals: &'a [AcceptedChargeTerminal],
    pub interfaces: &'a [AcceptedChargeInterface],
    pub absolute_jump_tolerance_v: f64,
    pub relative_jump_tolerance: f64,
    pub algebraic_relative_tolerance: f64,
    pub maximum_iterations: u32,
}

pub(super) fn require(condition: bool, message: &str) -> Result<(), RunError> {
    if condition {
        Ok(())
    } else {
        Err(RunError {
            message: format!("accepted terminal charge: {message}"),
        })
    }
}

#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
pub(super) fn input_text(value: &str) -> Result<CString, RunError> {
    require(
        !value.is_empty() && value.len() <= 4096,
        "input ID/version exceeds its text bound",
    )?;
    CString::new(value).map_err(|_| RunError {
        message: "accepted terminal charge: input text contains NUL".into(),
    })
}

#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
pub(super) fn result_text(value: &[std::ffi::c_char]) -> Result<String, RunError> {
    let end = value
        .iter()
        .position(|byte| *byte == 0)
        .ok_or_else(|| RunError {
            message: "accepted terminal charge: unterminated result metadata".into(),
        })?;
    String::from_utf8(value[..end].iter().map(|byte| *byte as u8).collect()).map_err(|_| RunError {
        message: "accepted terminal charge: result metadata is not UTF-8".into(),
    })
}

#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
pub(crate) fn solve_accepted_terminal_charge(
    request: &AcceptedTerminalChargeRequest<'_>,
) -> Result<AcceptedTerminalChargeRecord, RunError> {
    with_packed_charge_request(request, |input| solve_packed_charge(request, input))
}

#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
pub(super) fn with_packed_charge_request<T>(
    request: &AcceptedTerminalChargeRequest<'_>,
    consume: impl FnOnce(&ffi::fullmag_fem_accepted_terminal_charge_request_v1) -> Result<T, RunError>,
) -> Result<T, RunError> {
    // No ordinal or coordinate-derived identity fallback is permitted here.
    require(
        request.mesh.cell_count() > 0
            && request.mesh.cell_count() <= 1 << 20
            && !request.mesh.nodes.is_empty()
            && request.mesh.nodes.len() <= 4 * request.mesh.cell_count(),
        "mesh exceeds bounded tetrahedral support",
    )?;
    let facets = request.mesh.facets.types.len();
    require(
        facets > 0
            && facets <= 4 * request.mesh.cell_count()
            && !request.terminals.is_empty()
            && request.terminals.len() <= facets
            && request.interfaces.len() <= facets / 2,
        "facet/control counts exceed bounded support",
    )?;
    let face_count = request
        .terminals
        .iter()
        .try_fold(0usize, |count, terminal| {
            count.checked_add(terminal.boundary_face_vertex_ids.len())
        });
    require(
        face_count.is_some_and(|count| count <= facets)
            && request.terminals.iter().all(|terminal| {
                !terminal.boundary_face_vertex_ids.is_empty()
                    && terminal.requested_outward_current_a.is_finite()
            }),
        "terminal face support or signed current is invalid",
    )?;
    request.mesh.validate().map_err(|errors| RunError {
        message: format!(
            "accepted terminal charge: invalid request mesh: {}",
            errors.join("; ")
        ),
    })?;
    request
        .mesh
        .cells
        .require_tet4()
        .map_err(|error| RunError {
            message: format!("accepted terminal charge: {error}"),
        })?;
    require(
        request.stable_vertex_version == "stable_mesh_vertex_u64.v1"
            && request.stable_vertex_ids.len() == request.mesh.nodes.len()
            && request.stable_vertex_ids.iter().all(|id| *id != 0)
            && request
                .stable_vertex_ids
                .iter()
                .copied()
                .collect::<BTreeSet<_>>()
                .len()
                == request.stable_vertex_ids.len(),
        "stable vertex identity must be authored, complete, nonzero and unique",
    )?;
    require(
        request.conductivity_spm_per_element.len() == request.mesh.cell_count()
            && request
                .conductivity_spm_per_element
                .iter()
                .all(|sigma| sigma.is_finite() && *sigma > 0.0),
        "conductivity must be finite and positive on every element",
    )?;
    let packed_mesh = super::PackedNativeMesh::new(request.mesh);
    let stable_version = input_text(request.stable_vertex_version)?;
    let terminal_ids = request
        .terminals
        .iter()
        .map(|terminal| input_text(&terminal.id))
        .collect::<Result<Vec<_>, _>>()?;
    let terminal_faces = request
        .terminals
        .iter()
        .map(|terminal| {
            terminal
                .boundary_face_vertex_ids
                .iter()
                .flatten()
                .copied()
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let terminals = request
        .terminals
        .iter()
        .enumerate()
        .map(
            |(index, terminal)| ffi::fullmag_fem_accepted_terminal_charge_terminal_v1 {
                id: terminal_ids[index].as_ptr(),
                boundary_face_vertex_ids: super::optional_slice_ptr(&terminal_faces[index]),
                face_count: terminal.boundary_face_vertex_ids.len() as u64,
                requested_outward_current_a: terminal.requested_outward_current_a,
            },
        )
        .collect::<Vec<_>>();
    let interface_ids = request
        .interfaces
        .iter()
        .map(|pair| input_text(&pair.id))
        .collect::<Result<Vec<_>, _>>()?;
    let interfaces = request
        .interfaces
        .iter()
        .enumerate()
        .map(
            |(index, pair)| ffi::fullmag_fem_accepted_terminal_charge_interface_v1 {
                id: interface_ids[index].as_ptr(),
                first_face_vertex_ids: pair.first_face_vertex_ids,
                second_face_vertex_ids: pair.second_face_vertex_ids,
                vertex_pairs: pair.vertex_pairs,
            },
        )
        .collect::<Vec<_>>();
    let input = ffi::fullmag_fem_accepted_terminal_charge_request_v1 {
        abi_version: ffi::FULLMAG_FEM_ACCEPTED_TERMINAL_CHARGE_ABI_VERSION,
        reserved_flags: 0,
        struct_size: std::mem::size_of::<ffi::fullmag_fem_accepted_terminal_charge_request_v1>()
            as u64,
        execution_lane: request.execution_lane,
        reserved_execution: 0,
        mesh: packed_mesh.descriptor(request.mesh),
        stable_vertex_identities:
            ffi::fullmag_fem_steady_transport_rt0_stable_vertex_identities_v1 {
                version: stable_version.as_ptr(),
                local_to_stable_vertex_ids: request.stable_vertex_ids.as_ptr(),
                local_to_stable_vertex_ids_len: request.stable_vertex_ids.len() as u64,
            },
        conductivity_spm_per_element: request.conductivity_spm_per_element.as_ptr(),
        conductivity_spm_per_element_len: request.conductivity_spm_per_element.len() as u64,
        terminals: super::optional_slice_ptr(&terminals),
        terminal_count: terminals.len() as u64,
        interfaces: super::optional_slice_ptr(&interfaces),
        interface_count: interfaces.len() as u64,
        absolute_jump_tolerance_v: request.absolute_jump_tolerance_v,
        relative_jump_tolerance: request.relative_jump_tolerance,
        algebraic_relative_tolerance: request.algebraic_relative_tolerance,
        maximum_iterations: request.maximum_iterations,
        reserved_solver: 0,
    };
    consume(&input)
}

#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
fn solve_packed_charge(
    request: &AcceptedTerminalChargeRequest<'_>,
    input: &ffi::fullmag_fem_accepted_terminal_charge_request_v1,
) -> Result<AcceptedTerminalChargeRecord, RunError> {
    // One call, not a capacity-probe solve followed by another solve.
    let mut payload = Vec::new();
    payload
        .try_reserve_exact(ffi::FULLMAG_FEM_ACCEPTED_TERMINAL_CHARGE_MAX_PAYLOAD_BYTES)
        .map_err(|_| RunError {
            message: "accepted terminal charge: cannot reserve bounded record buffer".into(),
        })?;
    payload.resize(
        ffi::FULLMAG_FEM_ACCEPTED_TERMINAL_CHARGE_MAX_PAYLOAD_BYTES,
        0u8,
    );
    let mut output = ffi::fullmag_fem_accepted_terminal_charge_result_v1 {
        abi_version: ffi::FULLMAG_FEM_ACCEPTED_TERMINAL_CHARGE_ABI_VERSION,
        reserved_flags: 0,
        struct_size: std::mem::size_of::<ffi::fullmag_fem_accepted_terminal_charge_result_v1>()
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
    // SAFETY: all pointers refer to live, sized buffers retained through the call.
    let status = unsafe { ffi::fullmag_fem_solve_accepted_terminal_charge_v1(input, &mut output) };
    require(
        output.abi_version == input.abi_version
            && output.reserved_flags == 0
            && output.struct_size == std::mem::size_of_val(&output) as u64
            && output.canonical_payload == payload.as_mut_ptr()
            && output.canonical_payload_capacity == payload.len() as u64,
        "native result changed its caller-owned header/buffer",
    )?;
    if status != ffi::FULLMAG_FEM_OK {
        require(
            output.canonical_payload_len == 0
                && output.digest_schema[0] == 0
                && output.operator_version[0] == 0
                && output.layout_fingerprint[0] == 0
                && output.content_sha256[0] == 0,
            "failed native solve published acceptance metadata",
        )?;
        return Err(RunError {
            message: format!(
                "accepted terminal charge failed ({status}): {}",
                result_text(&output.error_message)?
            ),
        });
    }
    require(
        result_text(&output.digest_schema)? == DIGEST_SCHEMA
            && result_text(&output.operator_version)? == OPERATOR_VERSION
            && result_text(&output.layout_fingerprint)?
                == ffi::FULLMAG_FEM_ACCEPTED_TERMINAL_CHARGE_LAYOUT_FINGERPRINT
            && output.error_message[0] == 0,
        "native result schema/operator/layout mismatch",
    )?;
    require(
        output.canonical_payload_len > 0 && output.canonical_payload_len <= payload.len() as u64,
        "native result record length is outside its caller buffer",
    )?;
    payload.truncate(output.canonical_payload_len as usize);
    let record = record::decode_accepted_terminal_charge_record(
        payload,
        &result_text(&output.content_sha256)?,
    )?;
    validate_record_inputs(&record, request)?;
    Ok(record)
}

fn sorted<const N: usize>(mut values: [u64; N]) -> [u64; N] {
    values.sort_unstable();
    values
}

#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
pub(super) fn validate_record_inputs(
    record: &AcceptedTerminalChargeRecord,
    request: &AcceptedTerminalChargeRequest<'_>,
) -> Result<(), RunError> {
    require(
        record.stable_vertex_version == request.stable_vertex_version
            && record.vertices.len() == request.mesh.nodes.len()
            && record.policy
                == [
                    request.absolute_jump_tolerance_v,
                    request.relative_jump_tolerance,
                    request.algebraic_relative_tolerance,
                ]
            && record.maximum_iterations == request.maximum_iterations as u64,
        "owned record identity/policy differs from request",
    )?;
    for (index, vertex) in record.vertices.iter().enumerate() {
        require(
            vertex.id == request.stable_vertex_ids[index]
                && vertex.xyz_m == request.mesh.nodes[index],
            "owned vertex map differs from request",
        )?;
    }
    let cells = request
        .mesh
        .cells
        .require_tet4()
        .map_err(|error| RunError {
            message: error.to_string(),
        })?;
    require(
        cells.len() == record.elements.len(),
        "owned element count differs from request",
    )?;
    for (index, element) in record.elements.iter().enumerate() {
        let key = cells[index].map(|local| request.stable_vertex_ids[local as usize]);
        let attribute = if request.mesh.element_markers.is_empty() {
            index as u64 + 1
        } else {
            request.mesh.element_markers[index] as u64
        };
        require(
            sorted(element.vertex_ids) == sorted(key)
                && element.attribute == attribute
                && element.conductivity_spm == request.conductivity_spm_per_element[index],
            "owned material/element map differs from request",
        )?;
    }
    let mut boundaries = BTreeMap::new();
    for (index, role) in request.mesh.facets.roles.iter().enumerate() {
        if *role != FemFacetRoleIR::Exterior {
            continue;
        }
        let begin = request.mesh.facets.offsets[index] as usize;
        let end = request.mesh.facets.offsets[index + 1] as usize;
        require(end - begin == 3, "request boundary is not tri3")?;
        let key = std::array::from_fn::<_, 3, _>(|corner| {
            request.stable_vertex_ids[request.mesh.facets.nodes[begin + corner] as usize]
        });
        require(
            boundaries
                .insert(sorted(key), request.mesh.boundary_markers[index] as u64)
                .is_none(),
            "repeated request boundary",
        )?;
    }
    require(
        boundaries.len() == record.boundary.len()
            && record
                .boundary
                .iter()
                .all(|face| boundaries.get(&sorted(face.vertex_ids)) == Some(&face.attribute)),
        "owned boundary map differs from request",
    )?;
    require(
        record.terminals.len() == request.terminals.len()
            && record.interfaces.len() == request.interfaces.len(),
        "owned control counts differ from request",
    )?;
    for (terminal, authored) in record.terminals.iter().zip(request.terminals) {
        require(
            terminal.id == authored.id
                && terminal.faces == authored.boundary_face_vertex_ids
                && terminal.requested_current_a == authored.requested_outward_current_a,
            "owned signed terminal control differs from request",
        )?;
    }
    for (interface, authored) in record.interfaces.iter().zip(request.interfaces) {
        require(
            interface.authored == *authored,
            "owned typed interface differs from request",
        )?;
    }
    Ok(())
}
