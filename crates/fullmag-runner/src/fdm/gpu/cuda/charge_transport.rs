//! Bounded public orchestration for the native FDM GPU M1 charge solver.
//!
//! Numerical ownership stays in `backends/fdm`. This module only validates the
//! first public charge-only lane, translates it to the frozen ABI, and owns the
//! native context/snapshot lifecycle.

use fullmag_fdm_sys::gpu_transport_abi_v1 as ffi;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::mem::size_of;

const REQUIRED_FEATURES: u64 = ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_STRICT_RESIDENCY
    | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_DETERMINISTIC_REDUCTIONS
    | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE
    | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GpuChargeBoundaryKind {
    Voltage,
    ExactCurrentDensity,
    Insulating,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GpuChargeGauge {
    BoundaryReferencePerComponent,
    ZeroMeanPerFreeComponent,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct GpuChargeCell {
    pub active: bool,
    pub conductor: bool,
    pub material_index: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct GpuChargeMaterial {
    pub material_index: u32,
    pub conductivity_s_per_m: f64,
    pub material_revision: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct GpuChargeBoundaryFace {
    pub kind: GpuChargeBoundaryKind,
    pub axis: u32,
    pub side: i32,
    pub outward_sign: i32,
    pub adjacent_cell: u64,
    pub canonical_face_index: u64,
    pub area_m2: f64,
    pub value: f64,
    pub source_id: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct GpuChargeTransportInput {
    pub device_ordinal: i32,
    pub grid: [u64; 3],
    pub cell_size: [f64; 3],
    pub descriptor_revision: u64,
    pub source_revision: u64,
    pub descriptor_digest: [u8; 32],
    pub cells: Vec<GpuChargeCell>,
    pub materials: Vec<GpuChargeMaterial>,
    pub boundary_faces: Vec<GpuChargeBoundaryFace>,
    pub gauge: GpuChargeGauge,
    pub attempt_id: u64,
    pub stage_id: u64,
    pub relative_tolerance: f64,
    pub max_iterations: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct GpuChargeTransportOutput {
    pub potential_v: Vec<f64>,
    /// Oriented face-current density, ordered x faces, then y faces, then z faces.
    pub oriented_face_current_density_a_per_m2: Vec<f64>,
    pub device_uuid: [u8; 16],
    pub compute_capability: [u32; 2],
    pub cuda_runtime: u32,
    pub cuda_driver: u32,
    pub build_digest: [u8; 32],
    pub supported_features: u64,
    pub iterations: u64,
    pub algebraic_residual: f64,
    pub physical_residual: f64,
    pub component_balance: f64,
    pub electrode_balance: f64,
    pub transfer_count: u64,
    pub transfer_bytes: u64,
    pub peak_bytes: u64,
    pub candidate_digest: [u8; 32],
    pub snapshot_content_digest: [u8; 32],
    pub convergence_digest: [u8; 32],
    pub accepted_sequence: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GpuChargeTransportError {
    pub operation: &'static str,
    pub status: Option<u32>,
    pub message: String,
}

impl GpuChargeTransportError {
    fn validation(message: impl Into<String>) -> Self {
        Self {
            operation: "validate public FDM GPU charge transport",
            status: None,
            message: message.into(),
        }
    }

    fn abi(operation: &'static str, status: u32) -> Self {
        Self {
            operation,
            status: Some(status),
            message: format!("native FDM GPU transport ABI returned status {status}"),
        }
    }
}

impl fmt::Display for GpuChargeTransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.operation, self.message)
    }
}

impl std::error::Error for GpuChargeTransportError {}

pub(crate) fn validate_input(
    input: &GpuChargeTransportInput,
) -> Result<(), GpuChargeTransportError> {
    if input.device_ordinal < 0 {
        return Err(GpuChargeTransportError::validation(
            "the public charge-only lane requires an explicit CUDA device ordinal",
        ));
    }
    if input.gauge != GpuChargeGauge::BoundaryReferencePerComponent {
        return Err(GpuChargeTransportError::validation(
            "the first public FDM GPU charge lane supports only boundary-reference-per-component gauge; zero-mean remains native-only",
        ));
    }
    if input.grid.contains(&0) {
        return Err(GpuChargeTransportError::validation(
            "grid dimensions must be positive",
        ));
    }
    let cell_count = checked_cell_count(input.grid)?;
    if input.cells.len() != cell_count {
        return Err(GpuChargeTransportError::validation(format!(
            "charge cell record count {} does not match grid cell count {cell_count}",
            input.cells.len()
        )));
    }
    if input
        .cell_size
        .iter()
        .any(|spacing| !spacing.is_finite() || *spacing <= 0.0)
    {
        return Err(GpuChargeTransportError::validation(
            "cell sizes must be finite and positive in metres",
        ));
    }
    if input.descriptor_revision == 0 || input.source_revision == 0 {
        return Err(GpuChargeTransportError::validation(
            "descriptor and source revisions must be non-zero",
        ));
    }
    if input.descriptor_digest == [0; 32] {
        return Err(GpuChargeTransportError::validation(
            "descriptor digest must be populated",
        ));
    }
    if input.attempt_id == 0 || input.stage_id == 0 {
        return Err(GpuChargeTransportError::validation(
            "attempt and stage identifiers must be non-zero",
        ));
    }
    if !input.relative_tolerance.is_finite() || input.relative_tolerance <= 0.0 {
        return Err(GpuChargeTransportError::validation(
            "relative tolerance must be finite and positive",
        ));
    }
    if input.max_iterations == 0 {
        return Err(GpuChargeTransportError::validation(
            "maximum iteration count must be positive",
        ));
    }
    validate_materials_and_cells(input)?;
    validate_boundary_faces(input, cell_count)?;
    checked_face_count(input.grid)?;
    Ok(())
}

fn validate_materials_and_cells(
    input: &GpuChargeTransportInput,
) -> Result<(), GpuChargeTransportError> {
    if input.materials.is_empty() {
        return Err(GpuChargeTransportError::validation(
            "at least one conducting material is required",
        ));
    }
    let mut material_ids = BTreeSet::new();
    for material in &input.materials {
        if material.material_index == 0
            || !material_ids.insert(material.material_index)
            || !material.conductivity_s_per_m.is_finite()
            || material.conductivity_s_per_m <= 0.0
            || material.material_revision == 0
        {
            return Err(GpuChargeTransportError::validation(
                "charge materials require unique non-zero ids, positive finite conductivity, and non-zero revision",
            ));
        }
    }
    for cell in &input.cells {
        if cell.active != cell.conductor {
            return Err(GpuChargeTransportError::validation(
                "the bounded charge-only lane requires active and conductor masks to agree",
            ));
        }
        if cell.conductor && !material_ids.contains(&cell.material_index) {
            return Err(GpuChargeTransportError::validation(format!(
                "conducting cell references unknown material {}",
                cell.material_index
            )));
        }
        if !cell.conductor && cell.material_index != 0 {
            return Err(GpuChargeTransportError::validation(
                "non-conducting cells must use material index zero",
            ));
        }
    }
    if !input.cells.iter().any(|cell| cell.conductor) {
        return Err(GpuChargeTransportError::validation(
            "at least one conducting cell is required",
        ));
    }
    Ok(())
}

fn validate_boundary_faces(
    input: &GpuChargeTransportInput,
    cell_count: usize,
) -> Result<(), GpuChargeTransportError> {
    let mut voltage_sources = BTreeSet::new();
    let mut canonical_faces = BTreeSet::new();
    for face in &input.boundary_faces {
        if face.axis > 2
            || !matches!(face.side, -1 | 1)
            || face.outward_sign != face.side
            || face.adjacent_cell >= cell_count as u64
            || !face.area_m2.is_finite()
            || face.area_m2 <= 0.0
            || !face.value.is_finite()
            || !canonical_faces.insert(face.canonical_face_index)
        {
            return Err(GpuChargeTransportError::validation(
                "boundary faces require valid orientation, adjacent cell, unique canonical index, finite area, and finite value",
            ));
        }
        match face.kind {
            GpuChargeBoundaryKind::Voltage => {
                if face.source_id == 0 {
                    return Err(GpuChargeTransportError::validation(
                        "voltage electrodes require non-zero source ids",
                    ));
                }
                voltage_sources.insert(face.source_id);
            }
            GpuChargeBoundaryKind::Insulating => {
                if face.value != 0.0 {
                    return Err(GpuChargeTransportError::validation(
                        "insulating faces must carry zero boundary value",
                    ));
                }
            }
            GpuChargeBoundaryKind::ExactCurrentDensity => {
                return Err(GpuChargeTransportError::validation(
                    "the first public FDM GPU charge lane supports only two voltage electrodes and insulating walls",
                ));
            }
        }
    }
    if voltage_sources.len() != 2 {
        return Err(GpuChargeTransportError::validation(format!(
            "the bounded public charge lane requires exactly two voltage electrode source ids, found {}",
            voltage_sources.len()
        )));
    }
    Ok(())
}

fn checked_cell_count(grid: [u64; 3]) -> Result<usize, GpuChargeTransportError> {
    grid.into_iter()
        .try_fold(1_u64, u64::checked_mul)
        .and_then(|count| usize::try_from(count).ok())
        .ok_or_else(|| GpuChargeTransportError::validation("grid cell count overflows usize"))
}

fn checked_face_count(grid: [u64; 3]) -> Result<usize, GpuChargeTransportError> {
    let [nx, ny, nz] = grid;
    let x = nx
        .checked_add(1)
        .and_then(|value| value.checked_mul(ny))
        .and_then(|value| value.checked_mul(nz));
    let y = ny
        .checked_add(1)
        .and_then(|value| value.checked_mul(nx))
        .and_then(|value| value.checked_mul(nz));
    let z = nz
        .checked_add(1)
        .and_then(|value| value.checked_mul(nx))
        .and_then(|value| value.checked_mul(ny));
    x.and_then(|value| y.and_then(|other| value.checked_add(other)))
        .and_then(|value| z.and_then(|other| value.checked_add(other)))
        .and_then(|count| usize::try_from(count).ok())
        .ok_or_else(|| GpuChargeTransportError::validation("oriented face count overflows usize"))
}

pub(crate) fn input_from_resolved(
    plan: &fullmag_ir::FdmPlanIR,
    descriptor: &fullmag_ir::ResolvedFdmGpuChargeTransportIR,
    device_ordinal: i32,
) -> Result<GpuChargeTransportInput, GpuChargeTransportError> {
    if descriptor.descriptor_schema != "fullmag.fdm.gpu_charge_transport_descriptor.v1" {
        return Err(GpuChargeTransportError::validation(format!(
            "unsupported resolved charge descriptor schema '{}'",
            descriptor.descriptor_schema
        )));
    }
    if descriptor.descriptor_revision == 0
        || descriptor.source_revision == 0
        || descriptor.implementation_version != "fullmag_fdm_gpu_charge_abi_v1"
        || descriptor.validation_state != "source_contract_only"
        || descriptor.requested_execution.discretization != fullmag_ir::BackendTarget::Fdm
        || descriptor.requested_execution.device != fullmag_ir::ExecutionDevice::Gpu
        || descriptor.requested_execution.precision != fullmag_ir::ExecutionPrecision::Double
        || descriptor.requested_execution.execution_mode != fullmag_ir::ExecutionMode::Strict
        || descriptor.resolved_discretization != fullmag_ir::BackendTarget::Fdm
        || descriptor.resolved_device != fullmag_ir::ExecutionDevice::Gpu
        || descriptor.resolved_precision != fullmag_ir::ExecutionPrecision::Double
        || descriptor.resolved_execution_mode != fullmag_ir::ExecutionMode::Strict
    {
        return Err(GpuChargeTransportError::validation(
            "resolved charge descriptor contradicts the bounded FDM/GPU/double/strict ABI lane",
        ));
    }
    if descriptor.charge_gauge != fullmag_ir::ChargePotentialGaugeIR::DirichletReference {
        return Err(GpuChargeTransportError::validation(
            "the public FDM GPU runner rejects zero-mean gauge before native execution",
        ));
    }
    if descriptor.charge_active_cells.len() != descriptor.charge_conductivity_spm.len()
        || descriptor.charge_active_cells.len() != descriptor.region_ids.len()
    {
        return Err(GpuChargeTransportError::validation(
            "resolved charge masks, conductivity, and region ids disagree in length",
        ));
    }

    let mut conductivity_materials = BTreeMap::<u64, u32>::new();
    let mut materials = Vec::new();
    let mut cells = Vec::with_capacity(descriptor.charge_active_cells.len());
    for (active, conductivity) in descriptor
        .charge_active_cells
        .iter()
        .copied()
        .zip(descriptor.charge_conductivity_spm.iter().copied())
    {
        if !active {
            cells.push(GpuChargeCell {
                active: false,
                conductor: false,
                material_index: 0,
            });
            continue;
        }
        if !conductivity.is_finite() || conductivity <= 0.0 {
            return Err(GpuChargeTransportError::validation(
                "resolved active charge cells require positive finite conductivity",
            ));
        }
        let next_id = u32::try_from(materials.len() + 1).map_err(|_| {
            GpuChargeTransportError::validation("charge material count exceeds u32")
        })?;
        let material_index = *conductivity_materials
            .entry(conductivity.to_bits())
            .or_insert_with(|| {
                materials.push(GpuChargeMaterial {
                    material_index: next_id,
                    conductivity_s_per_m: conductivity,
                    material_revision: 1,
                });
                next_id
            });
        cells.push(GpuChargeCell {
            active: true,
            conductor: true,
            material_index,
        });
    }

    let grid = plan.grid.cells.map(u64::from);
    let boundary_faces = expand_resolved_boundaries(
        &descriptor.charge_boundaries,
        &descriptor.charge_active_cells,
        grid,
        plan.cell_size,
    )?;
    let descriptor_payload = serde_json::to_vec(&(
        descriptor.descriptor_schema.as_str(),
        descriptor.descriptor_revision,
        descriptor.source_revision,
        descriptor.implementation_version.as_str(),
        descriptor.module_id.as_str(),
        &descriptor.charge_active_cells,
        &descriptor.charge_conductivity_spm,
        &descriptor.charge_boundaries,
        descriptor.charge_gauge,
        &descriptor.charge_solver,
        &descriptor.region_ids,
    ))
    .map_err(|error| {
        GpuChargeTransportError::validation(format!(
            "failed to serialize resolved charge descriptor identity: {error}"
        ))
    })?;
    let computed_digest: [u8; 32] = Sha256::digest(descriptor_payload).into();
    let descriptor_digest = parse_sha256(&descriptor.descriptor_sha256)?;
    if descriptor_digest != computed_digest {
        return Err(GpuChargeTransportError::validation(
            "resolved charge descriptor SHA-256 does not match its canonical payload",
        ));
    }

    let input = GpuChargeTransportInput {
        device_ordinal,
        grid,
        cell_size: plan.cell_size,
        descriptor_revision: descriptor.descriptor_revision,
        source_revision: descriptor.source_revision,
        descriptor_digest,
        cells,
        materials,
        boundary_faces,
        gauge: GpuChargeGauge::BoundaryReferencePerComponent,
        attempt_id: 1,
        stage_id: 1,
        relative_tolerance: descriptor.charge_solver.linear.relative_tolerance,
        max_iterations: u64::from(descriptor.charge_solver.linear.max_iterations),
    };
    validate_input(&input)?;
    Ok(input)
}

fn parse_sha256(value: &str) -> Result<[u8; 32], GpuChargeTransportError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(GpuChargeTransportError::validation(
            "resolved charge descriptor digest must use the sha256:<64 hex> form",
        ));
    };
    if hex.len() != 64 {
        return Err(GpuChargeTransportError::validation(
            "resolved charge descriptor SHA-256 must contain exactly 64 hex digits",
        ));
    }
    let mut digest = [0_u8; 32];
    for (index, byte) in digest.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).map_err(|_| {
            GpuChargeTransportError::validation(
                "resolved charge descriptor SHA-256 contains non-hex characters",
            )
        })?;
    }
    Ok(digest)
}

fn stable_source_id(source_id: &str) -> u64 {
    let digest = Sha256::digest(source_id.as_bytes());
    u64::from_le_bytes(
        digest[..8]
            .try_into()
            .expect("SHA-256 prefix has eight bytes"),
    )
}

fn expand_resolved_boundaries(
    boundaries: &[fullmag_ir::ResolvedChargeBoundaryFaceIR],
    active_cells: &[bool],
    grid: [u64; 3],
    cell_size: [f64; 3],
) -> Result<Vec<GpuChargeBoundaryFace>, GpuChargeTransportError> {
    let [nx, ny, nz] = grid;
    let expected_cells = checked_cell_count(grid)?;
    if active_cells.len() != expected_cells {
        return Err(GpuChargeTransportError::validation(
            "resolved charge active mask does not match the FDM grid",
        ));
    }
    let x_face_count = nx
        .checked_add(1)
        .and_then(|value| value.checked_mul(ny))
        .and_then(|value| value.checked_mul(nz))
        .ok_or_else(|| GpuChargeTransportError::validation("x-face count overflows u64"))?;
    let y_face_count =
        nx.checked_mul(ny.checked_add(1).ok_or_else(|| {
            GpuChargeTransportError::validation("y-face dimension overflows u64")
        })?)
        .and_then(|value| value.checked_mul(nz))
        .ok_or_else(|| GpuChargeTransportError::validation("y-face count overflows u64"))?;
    let mut expanded = Vec::new();

    for boundary in boundaries {
        use fullmag_ir::{
            ResolvedChargeBoundaryConditionIR as Condition, StructuredBoundaryFaceIR,
        };
        let (axis, side) = match boundary.face {
            StructuredBoundaryFaceIR::XMin => (0_u32, -1_i32),
            StructuredBoundaryFaceIR::XMax => (0, 1),
            StructuredBoundaryFaceIR::YMin => (1, -1),
            StructuredBoundaryFaceIR::YMax => (1, 1),
            StructuredBoundaryFaceIR::ZMin => (2, -1),
            StructuredBoundaryFaceIR::ZMax => (2, 1),
        };
        let (kind, value) = match boundary.condition {
            Condition::Voltage { potential_v } => (GpuChargeBoundaryKind::Voltage, potential_v),
            Condition::OutwardNormalCurrentDensity {
                current_density_apm2,
            } => (
                GpuChargeBoundaryKind::ExactCurrentDensity,
                current_density_apm2,
            ),
            Condition::Insulating => (GpuChargeBoundaryKind::Insulating, 0.0),
        };
        let source_id = stable_source_id(&boundary.source_id);
        if source_id == 0 {
            return Err(GpuChargeTransportError::validation(
                "resolved charge boundary source id hashed to the reserved zero value",
            ));
        }

        for z in 0..nz {
            for y in 0..ny {
                for x in 0..nx {
                    let on_face = match boundary.face {
                        StructuredBoundaryFaceIR::XMin => x == 0,
                        StructuredBoundaryFaceIR::XMax => x + 1 == nx,
                        StructuredBoundaryFaceIR::YMin => y == 0,
                        StructuredBoundaryFaceIR::YMax => y + 1 == ny,
                        StructuredBoundaryFaceIR::ZMin => z == 0,
                        StructuredBoundaryFaceIR::ZMax => z + 1 == nz,
                    };
                    if !on_face {
                        continue;
                    }
                    let adjacent_cell = x + nx * (y + ny * z);
                    if !active_cells[adjacent_cell as usize] {
                        continue;
                    }
                    let canonical_face_index = match boundary.face {
                        StructuredBoundaryFaceIR::XMin => (nx + 1) * (y + ny * z),
                        StructuredBoundaryFaceIR::XMax => nx + (nx + 1) * (y + ny * z),
                        StructuredBoundaryFaceIR::YMin => x_face_count + x + nx * ((ny + 1) * z),
                        StructuredBoundaryFaceIR::YMax => {
                            x_face_count + x + nx * (ny + (ny + 1) * z)
                        }
                        StructuredBoundaryFaceIR::ZMin => x_face_count + y_face_count + x + nx * y,
                        StructuredBoundaryFaceIR::ZMax => {
                            x_face_count + y_face_count + x + nx * (y + ny * nz)
                        }
                    };
                    let area_m2 = match axis {
                        0 => cell_size[1] * cell_size[2],
                        1 => cell_size[0] * cell_size[2],
                        _ => cell_size[0] * cell_size[1],
                    };
                    expanded.push(GpuChargeBoundaryFace {
                        kind,
                        axis,
                        side,
                        outward_sign: side,
                        adjacent_cell,
                        canonical_face_index,
                        area_m2,
                        value,
                        source_id,
                    });
                }
            }
        }
    }
    Ok(expanded)
}

pub(crate) fn reconstruct_cell_centered_current(
    grid: [u64; 3],
    oriented_faces: &[f64],
) -> Result<Vec<[f64; 3]>, GpuChargeTransportError> {
    let [nx, ny, nz] = grid;
    if oriented_faces.len() != checked_face_count(grid)? {
        return Err(GpuChargeTransportError::validation(
            "oriented face-current payload length does not match the FDM grid",
        ));
    }
    let x_count = ((nx + 1) * ny * nz) as usize;
    let y_count = (nx * (ny + 1) * nz) as usize;
    let mut result = Vec::with_capacity(checked_cell_count(grid)?);
    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                let fx0 = (x + (nx + 1) * (y + ny * z)) as usize;
                let fx1 = fx0 + 1;
                let fy0 = x_count + (x + nx * (y + (ny + 1) * z)) as usize;
                let fy1 = fy0 + nx as usize;
                let fz0 = x_count + y_count + (x + nx * (y + ny * z)) as usize;
                let fz1 = fz0 + (nx * ny) as usize;
                result.push([
                    0.5 * (oriented_faces[fx0] + oriented_faces[fx1]),
                    0.5 * (oriented_faces[fy0] + oriented_faces[fy1]),
                    0.5 * (oriented_faces[fz0] + oriented_faces[fz1]),
                ]);
            }
        }
    }
    Ok(result)
}

fn prefix<T>(required_features: u64) -> ffi::gpu_prefix_v1 {
    ffi::gpu_prefix_v1 {
        abi_version: ffi::FULLMAG_FDM_GPU_TRANSPORT_ABI_V1,
        struct_version: 1,
        struct_size: size_of::<T>() as u32,
        reserved_flags: 0,
        required_features,
        reserved0: 0,
    }
}

fn host_view<T>(
    values: &[T],
    element_type: u32,
    component_order: u32,
) -> Result<ffi::fullmag_fdm_gpu_transport_buffer_view_v1, GpuChargeTransportError> {
    let bytes = values
        .len()
        .checked_mul(size_of::<T>())
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| GpuChargeTransportError::validation("buffer byte length overflows u64"))?;
    Ok(ffi::fullmag_fdm_gpu_transport_buffer_view_v1 {
        prefix: prefix::<ffi::fullmag_fdm_gpu_transport_buffer_view_v1>(0),
        address: values.as_ptr() as u64,
        element_count: values.len() as u64,
        byte_stride: size_of::<T>() as u64,
        byte_length: bytes,
        element_type,
        pointer_space: ffi::FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_READ_ONLY,
        component_order,
        reserved1: 0,
    })
}

fn host_destination_view(
    values: &mut [f64],
    component_order: u32,
) -> Result<ffi::fullmag_fdm_gpu_transport_buffer_view_v1, GpuChargeTransportError> {
    let mut view = host_view(
        values,
        ffi::FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_F64,
        component_order,
    )?;
    view.address = values.as_mut_ptr() as u64;
    view.pointer_space = ffi::FULLMAG_FDM_GPU_TRANSPORT_POINTER_SPACE_HOST_WRITE_ONLY;
    Ok(view)
}

trait TransportAbi {
    fn context_create(
        &mut self,
        request: &ffi::fullmag_fdm_gpu_transport_context_create_request_v1,
        result: &mut ffi::fullmag_fdm_gpu_transport_context_create_result_v1,
    ) -> u32;
    fn context_destroy(&mut self, context: ffi::fullmag_fdm_gpu_transport_context_handle_v1)
        -> u32;
    fn static_upload(
        &mut self,
        context: ffi::fullmag_fdm_gpu_transport_context_handle_v1,
        descriptor: &ffi::fullmag_fdm_gpu_transport_static_descriptor_v1,
    ) -> u32;
    fn solve_charge(
        &mut self,
        request: &ffi::fullmag_fdm_gpu_charge_solve_request_v1,
        result: &mut ffi::fullmag_fdm_gpu_charge_solve_result_v1,
    ) -> u32;
    fn accept_snapshot(
        &mut self,
        context: ffi::fullmag_fdm_gpu_transport_context_handle_v1,
        provisional_generation: u64,
        result: &mut ffi::fullmag_fdm_gpu_charge_snapshot_info_v1,
    ) -> u32;
    fn readback(&mut self, request: &ffi::fullmag_fdm_gpu_transport_artifact_request_v1) -> u32;
    fn snapshot_destroy(&mut self, snapshot: ffi::fullmag_fdm_gpu_charge_snapshot_handle_v1)
        -> u32;
}

struct ContextSession<'a, A: TransportAbi> {
    abi: &'a mut A,
    context: Option<ffi::fullmag_fdm_gpu_transport_context_handle_v1>,
    snapshot: Option<ffi::fullmag_fdm_gpu_charge_snapshot_handle_v1>,
}

impl<A: TransportAbi> ContextSession<'_, A> {
    fn close(&mut self) -> Result<(), GpuChargeTransportError> {
        let mut first_error = None;
        if let Some(snapshot) = self.snapshot.take() {
            let status = self.abi.snapshot_destroy(snapshot);
            if status != ffi::FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK {
                first_error = Some(GpuChargeTransportError::abi(
                    "destroy accepted FDM GPU charge snapshot",
                    status,
                ));
            }
        }
        if let Some(context) = self.context.take() {
            let status = self.abi.context_destroy(context);
            if status != ffi::FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK && first_error.is_none() {
                first_error = Some(GpuChargeTransportError::abi(
                    "destroy FDM GPU charge context",
                    status,
                ));
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}

impl<A: TransportAbi> Drop for ContextSession<'_, A> {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

fn check_status(operation: &'static str, status: u32) -> Result<(), GpuChargeTransportError> {
    if status == ffi::FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK {
        Ok(())
    } else {
        Err(GpuChargeTransportError::abi(operation, status))
    }
}

fn materialize_cells(
    cells: &[GpuChargeCell],
) -> Vec<ffi::fullmag_fdm_gpu_transport_charge_cell_v1> {
    cells
        .iter()
        .map(|cell| ffi::fullmag_fdm_gpu_transport_charge_cell_v1 {
            prefix: prefix::<ffi::fullmag_fdm_gpu_transport_charge_cell_v1>(0),
            active: u32::from(cell.active),
            conductor: u32::from(cell.conductor),
            material_index: cell.material_index,
            reserved1: 0,
        })
        .collect()
}

fn materialize_materials(
    materials: &[GpuChargeMaterial],
) -> Vec<ffi::fullmag_fdm_gpu_transport_charge_material_v1> {
    materials
        .iter()
        .map(
            |material| ffi::fullmag_fdm_gpu_transport_charge_material_v1 {
                prefix: prefix::<ffi::fullmag_fdm_gpu_transport_charge_material_v1>(0),
                material_index: material.material_index,
                reserved1: 0,
                conductivity: material.conductivity_s_per_m,
                material_revision: material.material_revision,
            },
        )
        .collect()
}

fn materialize_faces(
    faces: &[GpuChargeBoundaryFace],
) -> Vec<ffi::fullmag_fdm_gpu_transport_charge_face_v1> {
    faces
        .iter()
        .map(|face| ffi::fullmag_fdm_gpu_transport_charge_face_v1 {
            prefix: prefix::<ffi::fullmag_fdm_gpu_transport_charge_face_v1>(0),
            kind: match face.kind {
                GpuChargeBoundaryKind::Voltage => {
                    ffi::FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_VOLTAGE
                }
                GpuChargeBoundaryKind::ExactCurrentDensity => {
                    ffi::FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_EXACT_DENSITY
                }
                GpuChargeBoundaryKind::Insulating => {
                    ffi::FULLMAG_FDM_GPU_TRANSPORT_CHARGE_BOUNDARY_INSULATING
                }
            },
            axis: face.axis,
            side: face.side,
            outward_sign: face.outward_sign,
            adjacent_cell: face.adjacent_cell,
            canonical_face_index: face.canonical_face_index,
            area: face.area_m2,
            value: face.value,
            source_id: face.source_id,
        })
        .collect()
}

fn execute_with_abi<A: TransportAbi>(
    abi: &mut A,
    input: &GpuChargeTransportInput,
) -> Result<GpuChargeTransportOutput, GpuChargeTransportError> {
    validate_input(input)?;
    let cell_count = checked_cell_count(input.grid)?;
    let face_count = checked_face_count(input.grid)?;
    let cells = materialize_cells(&input.cells);
    let materials = materialize_materials(&input.materials);
    let faces = materialize_faces(&input.boundary_faces);
    let formula = [ffi::fullmag_fdm_gpu_transport_charge_formula_ids_v1 {
        prefix: prefix::<ffi::fullmag_fdm_gpu_transport_charge_formula_ids_v1>(0),
        formula_id: ffi::FULLMAG_FDM_GPU_TRANSPORT_CHARGE_FORMULA_OHMIC_FV_V1,
        operator_id: ffi::FULLMAG_FDM_GPU_TRANSPORT_CHARGE_OPERATOR_CONSERVATIVE_FV_V1,
        engine_id: ffi::FULLMAG_FDM_GPU_TRANSPORT_CHARGE_ENGINE_CG_DEVICE_AMG_V1,
        residual_id: ffi::FULLMAG_FDM_GPU_TRANSPORT_CHARGE_RESIDUAL_FIXED_TREE_FP64_V1,
        operator_revision: input.descriptor_revision,
        reserved1: 0,
    }];
    let empty = [0_u8; 1];

    let cell_view = host_view(
        &cells,
        ffi::FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES,
        ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR,
    )?;
    let material_view = host_view(
        &materials,
        ffi::FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES,
        ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR,
    )?;
    let empty_view = host_view(
        &empty[..0],
        ffi::FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES,
        ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR,
    )?;
    let face_view = host_view(
        &faces,
        ffi::FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES,
        ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR,
    )?;
    let formula_view = host_view(
        &formula,
        ffi::FULLMAG_FDM_GPU_TRANSPORT_ELEMENT_TYPE_RAW_BYTES,
        ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR,
    )?;

    let create_request = ffi::fullmag_fdm_gpu_transport_context_create_request_v1 {
        prefix: prefix::<ffi::fullmag_fdm_gpu_transport_context_create_request_v1>(
            REQUIRED_FEATURES,
        ),
        device_uuid: [0; 16],
        device_ordinal: input.device_ordinal,
        precision: ffi::FULLMAG_FDM_GPU_TRANSPORT_PRECISION_DOUBLE,
        strict_residency: ffi::FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE,
        deterministic: ffi::FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE,
        allocator_limit: 0,
        workspace_limit: 0,
        stream_policy: ffi::FULLMAG_FDM_GPU_TRANSPORT_STREAM_POLICY_CONTEXT_OWNED_SINGLE_STREAM,
        reserved1: 0,
        requested_device_features: REQUIRED_FEATURES,
        reserved2: 0,
    };
    let mut created = ffi::fullmag_fdm_gpu_transport_context_create_result_v1 {
        prefix: prefix::<ffi::fullmag_fdm_gpu_transport_context_create_result_v1>(0),
        ..Default::default()
    };
    check_status(
        "create strict FP64 FDM GPU charge context",
        abi.context_create(&create_request, &mut created),
    )?;
    let mut session = ContextSession {
        abi,
        context: Some(created.context_handle),
        snapshot: None,
    };

    let body = (|| {
        if created.supported_features & REQUIRED_FEATURES != REQUIRED_FEATURES {
            return Err(GpuChargeTransportError::validation(format!(
                "CUDA transport context omitted required features: requested 0x{REQUIRED_FEATURES:x}, supported 0x{:x}",
                created.supported_features
            )));
        }
        let descriptor = ffi::fullmag_fdm_gpu_transport_static_descriptor_v1 {
            prefix: prefix::<ffi::fullmag_fdm_gpu_transport_static_descriptor_v1>(
                ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE,
            ),
            grid: input.grid,
            cell_size: input.cell_size,
            descriptor_revision: input.descriptor_revision,
            source_revision: input.source_revision,
            descriptor_digest: input.descriptor_digest,
            masks_view_ptr: (&cell_view as *const _) as u64,
            materials_view_ptr: (&material_view as *const _) as u64,
            interfaces_view_ptr: (&empty_view as *const _) as u64,
            charge_faces_view_ptr: (&face_view as *const _) as u64,
            spin_faces_view_ptr: (&empty_view as *const _) as u64,
            formula_ids_view_ptr: (&formula_view as *const _) as u64,
            reserved1: 0,
        };
        check_status(
            "upload FDM GPU charge descriptor",
            session
                .abi
                .static_upload(created.context_handle, &descriptor),
        )?;

        let solve_request = ffi::fullmag_fdm_gpu_charge_solve_request_v1 {
            prefix: prefix::<ffi::fullmag_fdm_gpu_charge_solve_request_v1>(0),
            context_handle: created.context_handle,
            solver_policy: ffi::FULLMAG_FDM_GPU_TRANSPORT_CHARGE_SOLVER_POLICY_CG_DEVICE_AMG_V1,
            gauge_policy:
                ffi::FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT,
            attempt_id: input.attempt_id,
            stage_id: input.stage_id,
            source_revision: input.source_revision,
            static_revision: input.descriptor_revision,
            relative_tolerance: input.relative_tolerance,
            max_iterations: input.max_iterations,
        };
        let mut solved = ffi::fullmag_fdm_gpu_charge_solve_result_v1 {
            prefix: prefix::<ffi::fullmag_fdm_gpu_charge_solve_result_v1>(0),
            ..Default::default()
        };
        check_status(
            "solve FDM GPU charge potential",
            session.abi.solve_charge(&solve_request, &mut solved),
        )?;
        if solved.reason != ffi::FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED {
            return Err(GpuChargeTransportError::validation(format!(
                "native charge solver returned non-converged reason {}",
                solved.reason
            )));
        }

        let mut snapshot = ffi::fullmag_fdm_gpu_charge_snapshot_info_v1 {
            prefix: prefix::<ffi::fullmag_fdm_gpu_charge_snapshot_info_v1>(0),
            ..Default::default()
        };
        check_status(
            "accept FDM GPU charge snapshot",
            session.abi.accept_snapshot(
                created.context_handle,
                solved.provisional_generation,
                &mut snapshot,
            ),
        )?;
        session.snapshot = Some(snapshot.snapshot_handle);

        let mut potential_v = vec![0.0; cell_count];
        let mut current = vec![0.0; face_count];
        readback_field(
            session.abi,
            created.context_handle,
            &snapshot,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_SCALAR,
            &mut potential_v,
        )?;
        readback_field(
            session.abi,
            created.context_handle,
            &snapshot,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_J_C,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_COMPONENT_ORDER_ORIENTED_FACE_XYZ,
            &mut current,
        )?;

        Ok(GpuChargeTransportOutput {
            potential_v,
            oriented_face_current_density_a_per_m2: current,
            device_uuid: created.device_uuid,
            compute_capability: [created.compute_major, created.compute_minor],
            cuda_runtime: created.cuda_runtime,
            cuda_driver: created.cuda_driver,
            build_digest: created.build_digest,
            supported_features: created.supported_features,
            iterations: solved.iterations,
            algebraic_residual: solved.algebraic_residual,
            physical_residual: solved.physical_residual,
            component_balance: solved.component_balance,
            electrode_balance: solved.electrode_balance,
            transfer_count: solved.transfer_count,
            transfer_bytes: solved.transfer_bytes,
            peak_bytes: solved.peak_bytes,
            candidate_digest: solved.candidate_digest,
            snapshot_content_digest: snapshot.snapshot_content_digest,
            convergence_digest: snapshot.convergence_digest,
            accepted_sequence: snapshot.accepted_sequence,
        })
    })();
    let cleanup = session.close();
    match (body, cleanup) {
        (Ok(output), Ok(())) => Ok(output),
        (Ok(_), Err(error)) => Err(error),
        (Err(error), _) => Err(error),
    }
}

fn readback_field<A: TransportAbi>(
    abi: &mut A,
    context: ffi::fullmag_fdm_gpu_transport_context_handle_v1,
    snapshot: &ffi::fullmag_fdm_gpu_charge_snapshot_info_v1,
    field_id: u32,
    component_order: u32,
    destination: &mut [f64],
) -> Result<(), GpuChargeTransportError> {
    let destination_view = host_destination_view(destination, component_order)?;
    let request = ffi::fullmag_fdm_gpu_transport_artifact_request_v1 {
        prefix: prefix::<ffi::fullmag_fdm_gpu_transport_artifact_request_v1>(
            ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_M1_CHARGE
                | ffi::FULLMAG_FDM_GPU_TRANSPORT_FEATURE_ARTIFACT_READBACK,
        ),
        context_handle: context,
        snapshot_handle: snapshot.snapshot_handle,
        field_id,
        cadence: ffi::FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_CADENCE_EXPLICIT_REQUEST,
        range_begin: 0,
        range_count: destination.len() as u64,
        destination_view_ptr: (&destination_view as *const _) as u64,
        expected_bytes: destination_view.byte_length,
        accepted_sequence: snapshot.accepted_sequence,
    };
    check_status(
        "read back accepted FDM GPU charge artifact",
        abi.readback(&request),
    )
}

#[cfg(feature = "cuda")]
struct NativeTransportAbi;

#[cfg(feature = "cuda")]
impl TransportAbi for NativeTransportAbi {
    fn context_create(
        &mut self,
        request: &ffi::fullmag_fdm_gpu_transport_context_create_request_v1,
        result: &mut ffi::fullmag_fdm_gpu_transport_context_create_result_v1,
    ) -> u32 {
        unsafe { ffi::fullmag_fdm_gpu_transport_context_create_v1(request, result) }
    }

    fn context_destroy(
        &mut self,
        context: ffi::fullmag_fdm_gpu_transport_context_handle_v1,
    ) -> u32 {
        unsafe { ffi::fullmag_fdm_gpu_transport_context_destroy_v1(context) }
    }

    fn static_upload(
        &mut self,
        context: ffi::fullmag_fdm_gpu_transport_context_handle_v1,
        descriptor: &ffi::fullmag_fdm_gpu_transport_static_descriptor_v1,
    ) -> u32 {
        unsafe { ffi::fullmag_fdm_gpu_transport_static_descriptor_upload_v1(context, descriptor) }
    }

    fn solve_charge(
        &mut self,
        request: &ffi::fullmag_fdm_gpu_charge_solve_request_v1,
        result: &mut ffi::fullmag_fdm_gpu_charge_solve_result_v1,
    ) -> u32 {
        unsafe { ffi::fullmag_fdm_gpu_transport_solve_charge_v1(request, result) }
    }

    fn accept_snapshot(
        &mut self,
        context: ffi::fullmag_fdm_gpu_transport_context_handle_v1,
        provisional_generation: u64,
        result: &mut ffi::fullmag_fdm_gpu_charge_snapshot_info_v1,
    ) -> u32 {
        unsafe {
            ffi::fullmag_fdm_gpu_transport_accept_charge_snapshot_v1(
                context,
                provisional_generation,
                result,
            )
        }
    }

    fn readback(&mut self, request: &ffi::fullmag_fdm_gpu_transport_artifact_request_v1) -> u32 {
        unsafe { ffi::fullmag_fdm_gpu_transport_readback_artifact_v1(request) }
    }

    fn snapshot_destroy(
        &mut self,
        snapshot: ffi::fullmag_fdm_gpu_charge_snapshot_handle_v1,
    ) -> u32 {
        unsafe { ffi::fullmag_fdm_gpu_charge_snapshot_destroy_v1(snapshot) }
    }
}

#[cfg(feature = "cuda")]
pub(crate) fn execute_gpu_charge_transport(
    input: &GpuChargeTransportInput,
) -> Result<GpuChargeTransportOutput, GpuChargeTransportError> {
    execute_with_abi(&mut NativeTransportAbi, input)
}

#[cfg(feature = "cuda")]
pub(crate) fn execute_public_gpu_charge_only(
    plan: &fullmag_ir::FdmPlanIR,
    artifact_writer: Option<crate::artifact_pipeline::ArtifactPipelineSender>,
) -> Result<crate::types::ExecutedRun, crate::types::RunError> {
    use crate::artifact_pipeline::ArtifactRecorder;
    use crate::types::{
        AuxiliaryArtifact, ChargeTransportExecutionProvenance, ExecutedRun, ExecutionProvenance,
        FieldSnapshot, RunError, RunResult, RunStatus,
    };

    let [descriptor] = plan.fdm_gpu_charge_transports.as_slice() else {
        return Err(RunError {
            message: format!(
                "public FDM GPU charge-only execution requires exactly one resolved descriptor, found {}",
                plan.fdm_gpu_charge_transports.len()
            ),
        });
    };
    let device_ordinal = std::env::var("FULLMAG_FDM_GPU_INDEX")
        .or_else(|_| std::env::var("FULLMAG_CUDA_DEVICE_INDEX"))
        .ok()
        .map(|value| {
            value.parse::<i32>().map_err(|_| RunError {
                message: format!("invalid explicit CUDA device ordinal '{value}'"),
            })
        })
        .transpose()?
        .unwrap_or(0);
    let input =
        input_from_resolved(plan, descriptor, device_ordinal).map_err(|error| RunError {
            message: error.to_string(),
        })?;
    let solved = execute_gpu_charge_transport(&input).map_err(|error| RunError {
        message: error.to_string(),
    })?;
    let cell_current = reconstruct_cell_centered_current(
        input.grid,
        &solved.oriented_face_current_density_a_per_m2,
    )
    .map_err(|error| RunError {
        message: error.to_string(),
    })?;

    let charge_provenance = ChargeTransportExecutionProvenance {
        schema_version: "fullmag.fdm.gpu_charge_execution.v1".to_string(),
        module_id: descriptor.module_id.clone(),
        requested_backend: "fdm".to_string(),
        requested_device: "gpu".to_string(),
        requested_precision: "double".to_string(),
        requested_execution_mode: "strict".to_string(),
        resolved_engine: "cuda_fdm_charge_only".to_string(),
        resolved_device: "gpu".to_string(),
        resolved_precision: "double".to_string(),
        gauge_policy: "boundary_reference_per_component".to_string(),
        solver_policy: "cg_device_amg_v1".to_string(),
        operator_version: "fv_charge_harmonic_v1".to_string(),
        allocator_limit_bytes: 0,
        workspace_limit_bytes: 0,
        fallbacks_triggered: Vec::new(),
        device_uuid: hex_bytes(&solved.device_uuid),
        compute_capability: format!(
            "{}.{}",
            solved.compute_capability[0], solved.compute_capability[1]
        ),
        cuda_runtime: solved.cuda_runtime,
        cuda_driver: solved.cuda_driver,
        build_digest: hex_bytes(&solved.build_digest),
        iterations: solved.iterations,
        algebraic_residual: solved.algebraic_residual,
        physical_residual: solved.physical_residual,
        component_balance: solved.component_balance,
        electrode_balance: solved.electrode_balance,
        transfer_count: solved.transfer_count,
        transfer_bytes: solved.transfer_bytes,
        peak_bytes: solved.peak_bytes,
        accepted_sequence: solved.accepted_sequence,
        candidate_digest: hex_bytes(&solved.candidate_digest),
        snapshot_content_digest: hex_bytes(&solved.snapshot_content_digest),
        convergence_digest: hex_bytes(&solved.convergence_digest),
    };
    let provenance = ExecutionProvenance {
        execution_engine: "cuda_fdm_charge_only".to_string(),
        precision: "double".to_string(),
        charge_transport: Some(charge_provenance.clone()),
        executed_physics_kinds: vec!["current_transport".to_string()],
        executed_physics_module_ids: vec![descriptor.module_id.clone()],
        compute_capability: Some(format!(
            "{}.{}",
            solved.compute_capability[0], solved.compute_capability[1]
        )),
        cuda_driver_version: i32::try_from(solved.cuda_driver).ok(),
        cuda_runtime_version: i32::try_from(solved.cuda_runtime).ok(),
        lossy_fallback_used: false,
        ..Default::default()
    };
    let mut artifacts = if let Some(writer) = artifact_writer {
        ArtifactRecorder::streaming(provenance.clone(), writer)
    } else {
        ArtifactRecorder::in_memory(provenance.clone())
    };
    let scope = format!("module:{}", descriptor.module_id);
    let revision = solved.accepted_sequence.max(1);
    artifacts.record_field_snapshot(
        FieldSnapshot::new(
            "V_electric",
            0,
            plan.time_stage.start_time_s,
            0.0,
            1,
            "scalar",
            "cell",
            &scope,
            revision,
            solved.potential_v.clone(),
        )
        .map_err(|message| RunError { message })?,
    )?;
    artifacts.record_field_snapshot(
        FieldSnapshot::new(
            "J_charge",
            0,
            plan.time_stage.start_time_s,
            0.0,
            3,
            "xyz",
            "cell",
            &scope,
            revision,
            FieldSnapshot::flatten_vec3(cell_current),
        )
        .map_err(|message| RunError { message })?,
    )?;
    let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();

    let auxiliary_artifact = AuxiliaryArtifact {
        relative_path: format!("transport/{}/fdm_gpu_charge_v1.json", descriptor.module_id),
        bytes: serde_json::to_vec_pretty(&serde_json::json!({
            "execution": charge_provenance,
            "supported_features": solved.supported_features,
        }))
        .map_err(|error| RunError {
            message: format!("serialize FDM GPU charge provenance: {error}"),
        })?,
    };
    let status = RunStatus::Completed;
    Ok(ExecutedRun {
        result: RunResult {
            status,
            steps: Vec::new(),
            final_magnetization: plan.initial_magnetization.clone(),
            completion: Some(crate::relaxation::resolve_stage_completion(
                status,
                None,
                crate::relaxation::RelaxationCompletionMetrics::default(),
            )),
        },
        initial_magnetization: plan.initial_magnetization.clone(),
        field_snapshots,
        field_snapshot_count,
        auxiliary_artifacts: vec![auxiliary_artifact],
        provenance,
    })
}

fn hex_bytes(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct MockAbi {
        calls: Vec<&'static str>,
        fail_on: Option<&'static str>,
        created_request: Option<ffi::fullmag_fdm_gpu_transport_context_create_request_v1>,
        solve_request: Option<ffi::fullmag_fdm_gpu_charge_solve_request_v1>,
    }

    impl MockAbi {
        fn status(&self, operation: &'static str) -> u32 {
            if self.fail_on == Some(operation) {
                11
            } else {
                ffi::FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK
            }
        }
    }

    impl TransportAbi for MockAbi {
        fn context_create(
            &mut self,
            request: &ffi::fullmag_fdm_gpu_transport_context_create_request_v1,
            result: &mut ffi::fullmag_fdm_gpu_transport_context_create_result_v1,
        ) -> u32 {
            self.calls.push("create");
            self.created_request = Some(*request);
            result.context_handle = ffi::fullmag_fdm_gpu_transport_context_handle_v1 {
                registry_cookie: 1,
                slot: 2,
                generation: 3,
                type_tag: 4,
            };
            result.device_uuid = [0x11; 16];
            result.compute_major = 8;
            result.compute_minor = 9;
            result.cuda_runtime = 12040;
            result.cuda_driver = 12080;
            result.build_digest = [0x22; 32];
            result.supported_features = REQUIRED_FEATURES;
            self.status("create")
        }

        fn context_destroy(
            &mut self,
            _context: ffi::fullmag_fdm_gpu_transport_context_handle_v1,
        ) -> u32 {
            self.calls.push("destroy_context");
            self.status("destroy_context")
        }

        fn static_upload(
            &mut self,
            _context: ffi::fullmag_fdm_gpu_transport_context_handle_v1,
            _descriptor: &ffi::fullmag_fdm_gpu_transport_static_descriptor_v1,
        ) -> u32 {
            self.calls.push("upload");
            self.status("upload")
        }

        fn solve_charge(
            &mut self,
            request: &ffi::fullmag_fdm_gpu_charge_solve_request_v1,
            result: &mut ffi::fullmag_fdm_gpu_charge_solve_result_v1,
        ) -> u32 {
            self.calls.push("solve");
            self.solve_request = Some(*request);
            result.provisional_generation = 7;
            result.iterations = 9;
            result.reason = ffi::FULLMAG_FDM_GPU_TRANSPORT_CONVERGENCE_CONVERGED;
            result.algebraic_residual = 1.0e-13;
            result.physical_residual = 2.0e-13;
            result.component_balance = 3.0e-13;
            result.electrode_balance = 4.0e-13;
            result.transfer_count = 5;
            result.transfer_bytes = 80;
            result.peak_bytes = 4096;
            result.candidate_digest = [0x33; 32];
            self.status("solve")
        }

        fn accept_snapshot(
            &mut self,
            context: ffi::fullmag_fdm_gpu_transport_context_handle_v1,
            _provisional_generation: u64,
            result: &mut ffi::fullmag_fdm_gpu_charge_snapshot_info_v1,
        ) -> u32 {
            self.calls.push("accept");
            result.context_handle = context;
            result.snapshot_handle = ffi::fullmag_fdm_gpu_charge_snapshot_handle_v1 {
                registry_cookie: 5,
                slot: 6,
                generation: 7,
                type_tag: 8,
            };
            result.accepted_sequence = 2;
            result.snapshot_content_digest = [0x44; 32];
            result.convergence_digest = [0x55; 32];
            self.status("accept")
        }

        fn readback(
            &mut self,
            request: &ffi::fullmag_fdm_gpu_transport_artifact_request_v1,
        ) -> u32 {
            let operation = if request.field_id == ffi::FULLMAG_FDM_GPU_TRANSPORT_ARTIFACT_FIELD_V {
                "read_v"
            } else {
                "read_j"
            };
            self.calls.push(operation);
            if self.status(operation) != ffi::FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK {
                return self.status(operation);
            }
            let view = unsafe {
                &*(request.destination_view_ptr
                    as *const ffi::fullmag_fdm_gpu_transport_buffer_view_v1)
            };
            let values = unsafe {
                std::slice::from_raw_parts_mut(
                    view.address as *mut f64,
                    view.element_count as usize,
                )
            };
            for (index, value) in values.iter_mut().enumerate() {
                *value = index as f64 + f64::from(request.field_id);
            }
            ffi::FULLMAG_FDM_GPU_TRANSPORT_ERROR_OK
        }

        fn snapshot_destroy(
            &mut self,
            _snapshot: ffi::fullmag_fdm_gpu_charge_snapshot_handle_v1,
        ) -> u32 {
            self.calls.push("destroy_snapshot");
            self.status("destroy_snapshot")
        }
    }

    #[test]
    fn bounded_public_contract_rejects_zero_mean_before_ffi() {
        let mut input = bounded_input();
        input.gauge = GpuChargeGauge::ZeroMeanPerFreeComponent;

        let error = validate_input(&input).expect_err("zero-mean must stay native-only");

        assert!(error.message.contains("boundary-reference"));
    }

    #[test]
    fn bounded_public_contract_requires_exactly_two_voltage_sources() {
        let mut input = bounded_input();
        input.boundary_faces[1].source_id = input.boundary_faces[0].source_id;

        let error = validate_input(&input).expect_err("one electrode id must fail");

        assert!(error.message.contains("exactly two voltage electrode"));
    }

    #[test]
    fn runner_uses_dynamic_budgets_strict_fp64_and_full_lifecycle() {
        let input = bounded_input();
        let mut abi = MockAbi::default();

        let output = execute_with_abi(&mut abi, &input).expect("bounded solve");

        assert_eq!(
            abi.calls,
            [
                "create",
                "upload",
                "solve",
                "accept",
                "read_v",
                "read_j",
                "destroy_snapshot",
                "destroy_context",
            ]
        );
        let create = abi.created_request.expect("create request");
        assert_eq!(
            create.precision,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_PRECISION_DOUBLE
        );
        assert_eq!(
            create.strict_residency,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE
        );
        assert_eq!(
            create.deterministic,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_BOOL_TRUE
        );
        assert_eq!(create.allocator_limit, 0);
        assert_eq!(create.workspace_limit, 0);
        assert_eq!(create.prefix.required_features, REQUIRED_FEATURES);
        assert_eq!(
            abi.solve_request.expect("solve request").gauge_policy,
            ffi::FULLMAG_FDM_GPU_TRANSPORT_GAUGE_POLICY_BOUNDARY_REFERENCE_PER_COMPONENT
        );
        assert_eq!(output.potential_v, [1.0, 2.0]);
        assert_eq!(output.oriented_face_current_density_a_per_m2.len(), 11);
        assert_eq!(output.accepted_sequence, 2);
    }

    #[test]
    fn runner_cleans_context_when_upload_fails() {
        let mut abi = MockAbi {
            fail_on: Some("upload"),
            ..Default::default()
        };

        let error = execute_with_abi(&mut abi, &bounded_input()).expect_err("upload must fail");

        assert_eq!(error.operation, "upload FDM GPU charge descriptor");
        assert_eq!(abi.calls, ["create", "upload", "destroy_context"]);
    }

    #[test]
    fn runner_cleans_snapshot_and_context_when_readback_fails() {
        let mut abi = MockAbi {
            fail_on: Some("read_j"),
            ..Default::default()
        };

        let error = execute_with_abi(&mut abi, &bounded_input()).expect_err("J readback must fail");

        assert_eq!(
            error.operation,
            "read back accepted FDM GPU charge artifact"
        );
        assert_eq!(
            abi.calls,
            [
                "create",
                "upload",
                "solve",
                "accept",
                "read_v",
                "read_j",
                "destroy_snapshot",
                "destroy_context",
            ]
        );
    }

    #[test]
    fn cell_centered_reconstruction_averages_the_two_oriented_faces_per_axis() {
        // grid 2x1x1: x faces [1, 3, 5], y faces [10, 14, 20, 24],
        // z faces [30, 34, 40, 44].
        let faces = vec![
            1.0, 3.0, 5.0, 10.0, 14.0, 20.0, 24.0, 30.0, 34.0, 40.0, 44.0,
        ];

        let reconstructed =
            reconstruct_cell_centered_current([2, 1, 1], &faces).expect("cell-centered current");

        assert_eq!(reconstructed, [[2.0, 15.0, 35.0], [4.0, 19.0, 39.0]]);
    }

    #[test]
    fn descriptor_digest_parser_is_strict_and_exact() {
        assert_eq!(
            parse_sha256(&format!("sha256:{}", "ab".repeat(32))).expect("valid digest"),
            [0xab; 32]
        );
        assert!(parse_sha256("").is_err());
        assert!(parse_sha256("sha256:ab").is_err());
        assert!(parse_sha256(&format!("sha256:{}g", "00".repeat(31))).is_err());
    }

    fn bounded_input() -> GpuChargeTransportInput {
        GpuChargeTransportInput {
            device_ordinal: 0,
            grid: [2, 1, 1],
            cell_size: [1.0e-9; 3],
            descriptor_revision: 1,
            source_revision: 1,
            descriptor_digest: [0x5a; 32],
            cells: vec![
                GpuChargeCell {
                    active: true,
                    conductor: true,
                    material_index: 1,
                },
                GpuChargeCell {
                    active: true,
                    conductor: true,
                    material_index: 1,
                },
            ],
            materials: vec![GpuChargeMaterial {
                material_index: 1,
                conductivity_s_per_m: 5.0e6,
                material_revision: 1,
            }],
            boundary_faces: vec![
                GpuChargeBoundaryFace {
                    kind: GpuChargeBoundaryKind::Voltage,
                    axis: 0,
                    side: -1,
                    outward_sign: -1,
                    adjacent_cell: 0,
                    canonical_face_index: 0,
                    area_m2: 1.0e-18,
                    value: 0.1,
                    source_id: 10,
                },
                GpuChargeBoundaryFace {
                    kind: GpuChargeBoundaryKind::Voltage,
                    axis: 0,
                    side: 1,
                    outward_sign: 1,
                    adjacent_cell: 1,
                    canonical_face_index: 2,
                    area_m2: 1.0e-18,
                    value: 0.0,
                    source_id: 11,
                },
            ],
            gauge: GpuChargeGauge::BoundaryReferencePerComponent,
            attempt_id: 1,
            stage_id: 1,
            relative_tolerance: 1.0e-12,
            max_iterations: 500,
        }
    }
}
