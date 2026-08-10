use std::collections::VecDeque;
use std::ffi::CString;
use std::mem::{size_of, zeroed};
use std::os::raw::c_char;

use fullmag_engine::{CellSize, GridShape};
use fullmag_fdm_sys as ffi;
use fullmag_ir::{
    ChargePotentialGaugeIR, ResolvedChargeBoundaryConditionIR, ResolvedFdmSpinTransportIR,
    ResolvedFdmStructuredCurrentClosureIR, ResolvedSpinBoundaryConditionIR,
    ResolvedSpinInterfaceLawIR, StructuredBoundaryFaceIR,
};
use sha2::{Digest, Sha256};

use super::spin_transport::{
    stable_transport_interface_id, FdmChargeFaceCurrentSnapshot, FdmChargeInterfaceSnapshot,
    FdmOerstedClosureProvenanceSnapshot, FdmSpinFaceCurrentSnapshot,
    FdmSpinInterfaceFluxSnapshot, FdmSpinReactionChannelsSnapshot,
    FdmSpinTransportModuleSnapshot, FdmSpinTransportTelemetry,
    FdmStructuredCurrentSourceCutSnapshot,
};
use crate::types::RunError;

const CHARGE_API: &str = "fullmag.fdm.cpu.charge.v1";
const CHARGE_OPERATOR: &str = "fv_charge_harmonic_v1";
const CHARGE_SOURCE_CUT_OPERATOR: &str = "fv_charge_harmonic_source_cut_v1";
const CHARGE_INTERFACE_OPERATOR: &str = "fv_charge_mixing_series_trace.v1";
const CHARGE_SOLVER: &str = "fdm_charge_cg_matrix_free_v1";
const CHARGE_RESIDUAL: &str = "charge_balance_integrated_l2.v1";
const SPIN_API: &str = "fullmag.fdm.cpu.steady_spin.v1";
const SPIN_FORMULA: &str = "transport_constitutive.one_way.fullmag.v1";
const SPIN_OPERATOR: &str = "fv_spin_upwind_v1";
const ELECTRIC_RECONSTRUCTION: &str = "fdm_exact_face_current_electric_reconstruction.v1";
const SPIN_SOLVER: &str = "fdm_spin_block_gmres_matrix_free_reference_v1";
const SPIN_RESIDUAL: &str = "transport_balance_integrated_l2.v1";
const SPIN_LOCAL_RESIDUAL: &str = "transport_balance_local_fv.v1";
const INTERFACE_VERSION: &str = "magnetoelectronic.fullmag.v2";
const TORQUE_OPERATOR: &str = "fdm_transport_torque_cell_surface_balance.v1";
const RUNTIME_OWNER: &str = "fdm_cpu_native_transport_m1_v1";
const CONVERGENCE_REASON: &str = "converged_true_residual_and_balance";
const OERSTED_OPERATOR: &str = "fdm_oersted_cell_integrated_open.v1";
const OERSTED_API: &str = "fullmag.fdm.cpu.oersted_fft_open.v1";
const OERSTED_FORMULA: &str = "current_transport.fullmag.v1";
const OERSTED_RECONSTRUCTION: &str = "fdm_face_to_cell_current.v1";
const OERSTED_REALIZATION: &str = "oersted_fdm_fft_open.v1";
const OERSTED_ENGINE: &str = "fdm_oersted_fft_open_v1";
const OERSTED_CERTIFICATE: &str = "global_closed_current_certificate.v1";
const INACTIVE_COMPONENT_LABEL: u64 = u64::MAX;

fn run_error(message: impl Into<String>) -> RunError {
    RunError {
        message: message.into(),
    }
}

fn fixed_text(
    value: &str,
) -> Result<[c_char; ffi::FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY], RunError> {
    if value.as_bytes().contains(&0)
        || value.len() >= ffi::FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY
    {
        return Err(run_error(
            "native transport version identifier does not fit the C ABI",
        ));
    }
    let mut result = [0; ffi::FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY];
    for (target, source) in result.iter_mut().zip(value.as_bytes()) {
        *target = *source as c_char;
    }
    Ok(result)
}

fn read_text(value: &[c_char]) -> Result<String, RunError> {
    let terminator = value
        .iter()
        .position(|item| *item == 0)
        .ok_or_else(|| run_error("native transport returned a non-terminated text field"))?;
    let bytes = value[..terminator]
        .iter()
        .map(|item| *item as u8)
        .collect::<Vec<_>>();
    String::from_utf8(bytes)
        .map_err(|_| run_error("native transport returned a non-UTF-8 text field"))
}

fn validate_version_text(label: &str, value: &[c_char], expected: &str) -> Result<(), RunError> {
    let actual = read_text(value)?;
    if actual != expected {
        return Err(run_error(format!(
            "native transport {label} version mismatch: expected '{expected}', got '{actual}'"
        )));
    }
    Ok(())
}

fn error_message(value: &[c_char]) -> String {
    let length = value
        .iter()
        .position(|item| *item == 0)
        .unwrap_or(value.len());
    String::from_utf8_lossy(
        &value[..length]
            .iter()
            .map(|item| *item as u8)
            .collect::<Vec<_>>(),
    )
    .into_owned()
}

#[derive(Default)]
struct CanonicalBytes(Vec<u8>);

impl CanonicalBytes {
    fn u8(&mut self, value: u8) {
        self.0.push(value);
    }

    fn u64(&mut self, value: u64) {
        self.0.extend_from_slice(&value.to_be_bytes());
    }

    fn f64(&mut self, value: f64) {
        self.u64(value.to_bits());
    }

    fn boolean(&mut self, value: bool) {
        self.u8(u8::from(value));
    }

    fn text(&mut self, value: &str) {
        self.u64(value.len() as u64);
        self.0.extend_from_slice(value.as_bytes());
    }

    fn bytes(&mut self, values: &[u8]) {
        self.u64(values.len() as u64);
        self.0.extend_from_slice(values);
    }

    fn f64_vector(&mut self, values: &[f64]) {
        self.u64(values.len() as u64);
        for value in values {
            self.f64(*value);
        }
    }

    fn u64_vector(&mut self, values: &[u64]) {
        self.u64(values.len() as u64);
        for value in values {
            self.u64(*value);
        }
    }

    fn i8_vector(&mut self, values: &[i8]) {
        self.u64(values.len() as u64);
        for value in values {
            self.u8(*value as u8);
        }
    }
}

fn canonical_digest(bytes: CanonicalBytes) -> String {
    let digest = Sha256::digest(bytes.0);
    let mut result = String::with_capacity(71);
    result.push_str("sha256:");
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut result, "{byte:02x}").expect("writing to String cannot fail");
    }
    result
}

fn c_string(label: &str, value: &str) -> Result<CString, RunError> {
    CString::new(value).map_err(|_| run_error(format!("native Oersted {label} contains NUL")))
}

fn cell_coordinates(grid: GridShape, cell: u64) -> Result<[usize; 3], RunError> {
    let cell = usize::try_from(cell)
        .map_err(|_| run_error("native Oersted cell index exceeds usize"))?;
    let cells = grid
        .nx
        .checked_mul(grid.ny)
        .and_then(|value| value.checked_mul(grid.nz))
        .ok_or_else(|| run_error("native Oersted grid cell count overflows usize"))?;
    if cell >= cells {
        return Err(run_error("native Oersted source-cut cell is outside the grid"));
    }
    let x = cell % grid.nx;
    let yz = cell / grid.nx;
    Ok([x, yz % grid.ny, yz / grid.ny])
}

fn cell_index(grid: GridShape, x: usize, y: usize, z: usize) -> usize {
    (z * grid.ny + y) * grid.nx + x
}

fn x_face_index(grid: GridShape, x: usize, y: usize, z: usize) -> usize {
    (z * grid.ny + y) * (grid.nx + 1) + x
}

fn y_face_index(grid: GridShape, x: usize, y: usize, z: usize) -> usize {
    (z * (grid.ny + 1) + y) * grid.nx + x
}

fn z_face_index(grid: GridShape, x: usize, y: usize, z: usize) -> usize {
    (z * grid.ny + y) * grid.nx + x
}

fn component_labels(grid: GridShape, mask: &[u8]) -> Result<(Vec<u64>, usize), RunError> {
    let cells = grid
        .nx
        .checked_mul(grid.ny)
        .and_then(|value| value.checked_mul(grid.nz))
        .ok_or_else(|| run_error("native Oersted grid cell count overflows usize"))?;
    if mask.len() != cells {
        return Err(run_error("native Oersted conductor mask shape mismatch"));
    }
    let mut labels = vec![INACTIVE_COMPONENT_LABEL; cells];
    let mut component_count = 0;
    for seed in 0..cells {
        if mask[seed] == 0 || labels[seed] != INACTIVE_COMPONENT_LABEL {
            continue;
        }
        component_count += 1;
        let label = seed as u64;
        labels[seed] = label;
        let mut pending = VecDeque::from([seed]);
        while let Some(current) = pending.pop_front() {
            let x = current % grid.nx;
            let yz = current / grid.nx;
            let y = yz % grid.ny;
            let z = yz / grid.ny;
            for (axis, extent) in [(0, grid.nx), (1, grid.ny), (2, grid.nz)] {
                for direction in [-1isize, 1] {
                    let coordinate = [x, y, z][axis] as isize + direction;
                    if coordinate < 0 || coordinate >= extent as isize {
                        continue;
                    }
                    let mut next = [x, y, z];
                    next[axis] = coordinate as usize;
                    let next = cell_index(grid, next[0], next[1], next[2]);
                    if mask[next] != 0 && labels[next] == INACTIVE_COMPONENT_LABEL {
                        labels[next] = label;
                        pending.push_back(next);
                    }
                }
            }
        }
    }
    Ok((labels, component_count))
}

fn validate_f64_buffer(
    label: &str,
    raw: &ffi::fullmag_fdm_cpu_f64_buffer_v1,
    values: &[f64],
) -> Result<(), RunError> {
    let expected = u64_len(values.len(), label)?;
    if raw.data != values.as_ptr().cast_mut() || raw.capacity != expected || raw.length != expected
    {
        return Err(run_error(format!(
            "native transport {label} pointer/capacity/length contract failed"
        )));
    }
    if values.iter().any(|value| !value.is_finite()) {
        return Err(run_error(format!(
            "native transport {label} contains a non-finite value"
        )));
    }
    Ok(())
}

fn validate_record_buffer<T>(
    label: &str,
    data: *mut T,
    capacity: u64,
    length: u64,
    values: &[T],
) -> Result<(), RunError> {
    let expected = u64_len(values.len(), label)?;
    if data != values.as_ptr().cast_mut() || capacity != expected || length != expected {
        return Err(run_error(format!(
            "native transport {label} pointer/capacity/length contract failed"
        )));
    }
    Ok(())
}

fn finite(values: impl IntoIterator<Item = f64>) -> bool {
    values.into_iter().all(f64::is_finite)
}

fn validate_charge_result(
    raw: &ffi::fullmag_fdm_cpu_charge_result_v1,
    potential: &[f64],
    current_x: &[f64],
    current_y: &[f64],
    current_z: &[f64],
    current_cell_xyz: &[f64],
    observations: &[ffi::fullmag_fdm_cpu_charge_interface_observation_v1],
    interfaces: &[ffi::fullmag_fdm_cpu_transport_interface_v1],
    expected_operator: &str,
) -> Result<(), RunError> {
    if raw.abi_version != ffi::FULLMAG_FDM_CPU_TRANSPORT_ABI_V1
        || raw.struct_size != size_of::<ffi::fullmag_fdm_cpu_charge_result_v1>() as u32
        || raw.reserved_flags != 0
        || raw.status != ffi::FULLMAG_FDM_CPU_TRANSPORT_OK
        || raw.reserved0 != 0
    {
        return Err(run_error(
            "native charge result header/status contract failed",
        ));
    }
    validate_f64_buffer("charge potential", &raw.potential_v, potential)?;
    validate_f64_buffer("charge x-face Jc", &raw.jc_x_a_per_m2, current_x)?;
    validate_f64_buffer("charge y-face Jc", &raw.jc_y_a_per_m2, current_y)?;
    validate_f64_buffer("charge z-face Jc", &raw.jc_z_a_per_m2, current_z)?;
    validate_f64_buffer(
        "charge cell-centered Jc",
        &raw.jc_cell_xyz_a_per_m2,
        current_cell_xyz,
    )?;
    validate_record_buffer(
        "charge observations",
        raw.interface_observations.data,
        raw.interface_observations.capacity,
        raw.interface_observations.length,
        observations,
    )?;
    let expected = interfaces
        .iter()
        .filter(|interface| {
            interface.kind == ffi::FULLMAG_FDM_CPU_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2
        })
        .collect::<Vec<_>>();
    if expected.len() != observations.len() {
        return Err(run_error("native charge observation count is incomplete"));
    }
    let mut ids = std::collections::BTreeSet::new();
    for (observation, interface) in observations.iter().zip(&expected) {
        if observation.interface_id == 0
            || !ids.insert(observation.interface_id)
            || observation.interface_id != interface.interface_id
            || observation.axis != interface.axis
            || observation.reserved != 0
            || observation.negative_cell != interface.negative_cell
            || observation.positive_cell != interface.positive_cell
            || observation.from_cell != interface.from_cell
            || observation.to_cell != interface.to_cell
            || observation.g_up_s_per_m2 != interface.g_up_s_per_m2
            || observation.g_down_s_per_m2 != interface.g_down_s_per_m2
            || !finite([
                observation.from_potential_trace_v,
                observation.to_potential_trace_v,
                observation.delta_potential_trace_v,
                observation.from_to_current_density_a_per_m2,
                observation.global_face_current_density_a_per_m2,
            ])
        {
            return Err(run_error(
                "native charge interface identity/value contract failed",
            ));
        }
    }
    validate_version_text("charge API", &raw.api_version, CHARGE_API)?;
    validate_version_text("charge operator", &raw.operator_version, expected_operator)?;
    validate_version_text(
        "charge interface operator",
        &raw.interface_operator_version,
        if expected.is_empty() {
            ""
        } else {
            CHARGE_INTERFACE_OPERATOR
        },
    )?;
    validate_version_text("charge solver", &raw.solver_version, CHARGE_SOLVER)?;
    validate_version_text("charge residual", &raw.residual_version, CHARGE_RESIDUAL)?;
    validate_version_text("charge runtime owner", &raw.runtime_owner, RUNTIME_OWNER)?;
    if raw.accepted_snapshot.is_null()
        || raw.accepted_snapshot_identity == 0
        || usize::try_from(raw.iterations).is_err()
        || !finite(
            [
                raw.algebraic_residual_l2_a_per_m3,
                raw.recomputed_algebraic_residual_l2_a_per_m3,
                raw.physical_balance_integrated_l2_a,
                raw.max_cell_current_imbalance_a,
                raw.max_abs_divergence_a_per_m3,
                raw.net_boundary_current_a,
            ]
            .into_iter()
            .chain(raw.boundary_outward_current_a),
        )
    {
        return Err(run_error(
            "native charge diagnostics/ownership/provenance contract failed",
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_spin_result(
    raw: &ffi::fullmag_fdm_cpu_steady_spin_result_v1,
    spin_potential: &[f64],
    qx: &[f64],
    qy: &[f64],
    qz: &[f64],
    qcell: &[f64],
    reaction_spin_flip: &[f64],
    reaction_exchange: &[f64],
    reaction_dephasing: &[f64],
    reaction_total: &[f64],
    torque: &[f64],
    observations: &[ffi::fullmag_fdm_cpu_spin_interface_observation_v1],
    interfaces: &[ffi::fullmag_fdm_cpu_transport_interface_v1],
) -> Result<(), RunError> {
    if raw.abi_version != ffi::FULLMAG_FDM_CPU_TRANSPORT_ABI_V1
        || raw.struct_size != size_of::<ffi::fullmag_fdm_cpu_steady_spin_result_v1>() as u32
        || raw.reserved_flags != 0
        || raw.status != ffi::FULLMAG_FDM_CPU_TRANSPORT_OK
        || raw.reserved0 != 0
    {
        return Err(run_error(
            "native spin result header/status contract failed",
        ));
    }
    for (label, buffer, values) in [
        ("spin potential", &raw.spin_potential_xyz_v, spin_potential),
        ("spin x-face Q", &raw.q_x_xyz_a_per_m2, qx),
        ("spin y-face Q", &raw.q_y_xyz_a_per_m2, qy),
        ("spin z-face Q", &raw.q_z_xyz_a_per_m2, qz),
        ("spin cell-centered Q", &raw.q_cell_ia_a_per_m2, qcell),
        (
            "spin-flip reaction",
            &raw.reaction_spin_flip_xyz_a_per_m3,
            reaction_spin_flip,
        ),
        (
            "exchange reaction",
            &raw.reaction_exchange_xyz_a_per_m3,
            reaction_exchange,
        ),
        (
            "dephasing reaction",
            &raw.reaction_dephasing_xyz_a_per_m3,
            reaction_dephasing,
        ),
        (
            "total reaction",
            &raw.reaction_total_xyz_a_per_m3,
            reaction_total,
        ),
        ("transport torque", &raw.transport_torque_xyz_per_s, torque),
    ] {
        validate_f64_buffer(label, buffer, values)?;
    }
    for index in 0..reaction_total.len() {
        if reaction_total[index]
            != reaction_spin_flip[index] + reaction_exchange[index] + reaction_dephasing[index]
        {
            return Err(run_error(
                "native spin total reaction does not equal its published channels",
            ));
        }
    }
    validate_record_buffer(
        "spin observations",
        raw.interface_observations.data,
        raw.interface_observations.capacity,
        raw.interface_observations.length,
        observations,
    )?;
    if observations.len() != interfaces.len() {
        return Err(run_error("native spin observation count is incomplete"));
    }
    let mut ids = std::collections::BTreeSet::new();
    for (observation, interface) in observations.iter().zip(interfaces) {
        let values = observation
            .incoming_longitudinal_a_per_m2
            .into_iter()
            .chain(observation.backflow_longitudinal_a_per_m2)
            .chain(observation.absorbed_transverse_a_per_m2)
            .chain(observation.negative_cell_flux_positive_axis_a_per_m2)
            .chain(observation.positive_cell_flux_positive_axis_a_per_m2)
            .chain(observation.from_side_outgoing_a_per_m2)
            .chain(observation.to_side_transmitted_a_per_m2);
        if observation.interface_id == 0
            || !ids.insert(observation.interface_id)
            || observation.interface_id != interface.interface_id
            || observation.axis != interface.axis
            || observation.reserved != 0
            || observation.negative_cell != interface.negative_cell
            || observation.positive_cell != interface.positive_cell
            || observation.from_cell != interface.from_cell
            || observation.to_cell != interface.to_cell
            || !finite(values)
        {
            return Err(run_error(
                "native spin interface identity/value contract failed",
            ));
        }
    }
    for (label, value, expected) in [
        ("spin API", raw.api_version.as_slice(), SPIN_API),
        ("spin formula", raw.formula_version.as_slice(), SPIN_FORMULA),
        (
            "spin operator",
            raw.operator_version.as_slice(),
            SPIN_OPERATOR,
        ),
        (
            "spin electric reconstruction",
            raw.electric_reconstruction_version.as_slice(),
            ELECTRIC_RECONSTRUCTION,
        ),
        ("spin solver", raw.solver_version.as_slice(), SPIN_SOLVER),
        (
            "spin residual",
            raw.residual_version.as_slice(),
            SPIN_RESIDUAL,
        ),
        (
            "spin local residual",
            raw.local_residual_version.as_slice(),
            SPIN_LOCAL_RESIDUAL,
        ),
        (
            "spin interface",
            raw.interface_version.as_slice(),
            INTERFACE_VERSION,
        ),
        (
            "spin torque operator",
            raw.torque_operator_version.as_slice(),
            TORQUE_OPERATOR,
        ),
        (
            "spin runtime owner",
            raw.runtime_owner.as_slice(),
            RUNTIME_OWNER,
        ),
        (
            "spin convergence reason",
            raw.convergence_reason.as_slice(),
            CONVERGENCE_REASON,
        ),
    ] {
        validate_version_text(label, value, expected)?;
    }
    if usize::try_from(raw.iterations).is_err()
        || raw.gmres_restart != 40
        || !finite(
            [
                raw.initial_rhs_integrated_l2_a,
                raw.recursive_residual_integrated_l2_a,
                raw.recomputed_balance_integrated_l2_a,
                raw.balance_tolerance_integrated_l2_a,
                raw.relative_global_balance,
                raw.max_abs_residual_a_per_m3,
            ]
            .into_iter()
            .chain(raw.boundary_outward_current_a)
            .chain(raw.global_balance_closure_a),
        )
    {
        return Err(run_error(
            "native spin diagnostics/provenance contract failed",
        ));
    }
    Ok(())
}

fn u64_len(value: usize, label: &str) -> Result<u64, RunError> {
    u64::try_from(value).map_err(|_| run_error(format!("native transport {label} exceeds u64")))
}

fn checked_product(values: &[usize], label: &str) -> Result<usize, RunError> {
    values.iter().try_fold(1_usize, |product, value| {
        product
            .checked_mul(*value)
            .ok_or_else(|| run_error(format!("native transport {label} overflows usize")))
    })
}

#[derive(Debug, Clone, Copy)]
struct NativeBufferLengths {
    cells: usize,
    x_faces: usize,
    y_faces: usize,
    z_faces: usize,
    cell_xyz: usize,
    cell_tensor: usize,
    x_face_xyz: usize,
    y_face_xyz: usize,
    z_face_xyz: usize,
}

fn native_buffer_lengths(nx: usize, ny: usize, nz: usize) -> Result<NativeBufferLengths, RunError> {
    let nx_faces = nx
        .checked_add(1)
        .ok_or_else(|| run_error("native transport x face dimension overflows usize"))?;
    let ny_faces = ny
        .checked_add(1)
        .ok_or_else(|| run_error("native transport y face dimension overflows usize"))?;
    let nz_faces = nz
        .checked_add(1)
        .ok_or_else(|| run_error("native transport z face dimension overflows usize"))?;
    let cells = checked_product(&[nx, ny, nz], "cell count")?;
    let x_faces = checked_product(&[nx_faces, ny, nz], "x face count")?;
    let y_faces = checked_product(&[nx, ny_faces, nz], "y face count")?;
    let z_faces = checked_product(&[nx, ny, nz_faces], "z face count")?;
    let lengths = NativeBufferLengths {
        cells,
        x_faces,
        y_faces,
        z_faces,
        cell_xyz: checked_product(&[cells, 3], "cell vector length")?,
        cell_tensor: checked_product(&[cells, 9], "cell tensor length")?,
        x_face_xyz: checked_product(&[x_faces, 3], "x face vector length")?,
        y_face_xyz: checked_product(&[y_faces, 3], "y face vector length")?,
        z_face_xyz: checked_product(&[z_faces, 3], "z face vector length")?,
    };
    for (value, label) in [
        (lengths.cells, "cell count"),
        (lengths.x_faces, "x face count"),
        (lengths.y_faces, "y face count"),
        (lengths.z_faces, "z face count"),
        (lengths.cell_xyz, "cell vector length"),
        (lengths.cell_tensor, "cell tensor length"),
        (lengths.x_face_xyz, "x face vector length"),
        (lengths.y_face_xyz, "y face vector length"),
        (lengths.z_face_xyz, "z face vector length"),
    ] {
        u64_len(value, label)?;
    }
    Ok(lengths)
}

fn f64_buffer(values: &mut Vec<f64>) -> Result<ffi::fullmag_fdm_cpu_f64_buffer_v1, RunError> {
    Ok(ffi::fullmag_fdm_cpu_f64_buffer_v1 {
        data: values.as_mut_ptr(),
        capacity: u64_len(values.len(), "f64 buffer capacity")?,
        length: 0,
    })
}

fn face_slot(face: StructuredBoundaryFaceIR) -> usize {
    match face {
        StructuredBoundaryFaceIR::XMin => 0,
        StructuredBoundaryFaceIR::XMax => 1,
        StructuredBoundaryFaceIR::YMin => 2,
        StructuredBoundaryFaceIR::YMax => 3,
        StructuredBoundaryFaceIR::ZMin => 4,
        StructuredBoundaryFaceIR::ZMax => 5,
    }
}

fn interface_records(
    descriptor: &ResolvedFdmSpinTransportIR,
    magnetization: &[[f64; 3]],
) -> Result<Vec<ffi::fullmag_fdm_cpu_transport_interface_v1>, RunError> {
    let records = descriptor
        .interfaces
        .iter()
        .map(|interface| {
            let (kind, g_up, g_down, g_r, g_i) = match &interface.law {
                ResolvedSpinInterfaceLawIR::Transparent => (
                    ffi::FULLMAG_FDM_CPU_SPIN_INTERFACE_TRANSPARENT,
                    0.0,
                    0.0,
                    0.0,
                    0.0,
                ),
                ResolvedSpinInterfaceLawIR::MixingConductance {
                    g_up_spm2,
                    g_down_spm2,
                    g_r_spm2,
                    g_i_spm2,
                    g_sml_spm2,
                    spin_memory_loss,
                    ..
                } => {
                    if *g_sml_spm2 != 0.0 || spin_memory_loss.is_some() {
                        return Err(run_error(
                            "native_m1_v1 rejects SML and cannot degrade it to mixing",
                        ));
                    }
                    (
                        ffi::FULLMAG_FDM_CPU_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2,
                        *g_up_spm2,
                        *g_down_spm2,
                        *g_r_spm2,
                        *g_i_spm2,
                    )
                }
            };
            let to = usize::try_from(interface.to_cell)
                .map_err(|_| run_error("native interface cell index exceeds usize"))?;
            let interface_m = magnetization.get(to).copied().ok_or_else(|| {
                run_error("native interface ferromagnet cell is outside magnetization")
            })?;
            Ok(ffi::fullmag_fdm_cpu_transport_interface_v1 {
                interface_id: stable_transport_interface_id(
                    &interface.source_id,
                    interface.face.axis,
                    interface.face.negative_cell,
                    interface.face.positive_cell,
                    interface.from_cell,
                    interface.to_cell,
                ),
                axis: u32::from(interface.face.axis),
                kind,
                negative_cell: interface.face.negative_cell,
                positive_cell: interface.face.positive_cell,
                from_cell: interface.from_cell,
                to_cell: interface.to_cell,
                g_up_s_per_m2: g_up,
                g_down_s_per_m2: g_down,
                g_r_s_per_m2: g_r,
                g_i_s_per_m2: g_i,
                magnetization: interface_m,
            })
        })
        .collect::<Result<Vec<_>, RunError>>()?;
    let cell_count = u64_len(magnetization.len(), "interface cell count")?;
    let mut ids = std::collections::BTreeSet::new();
    for record in &records {
        let expected_kind = matches!(
            record.kind,
            ffi::FULLMAG_FDM_CPU_SPIN_INTERFACE_TRANSPARENT
                | ffi::FULLMAG_FDM_CPU_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2
        );
        let orientation_is_integral = (record.from_cell == record.negative_cell
            && record.to_cell == record.positive_cell)
            || (record.from_cell == record.positive_cell && record.to_cell == record.negative_cell);
        if record.interface_id == 0
            || !ids.insert(record.interface_id)
            || record.axis > 2
            || !expected_kind
            || record.negative_cell >= cell_count
            || record.positive_cell >= cell_count
            || record.negative_cell == record.positive_cell
            || !orientation_is_integral
            || !finite(
                [
                    record.g_up_s_per_m2,
                    record.g_down_s_per_m2,
                    record.g_r_s_per_m2,
                    record.g_i_s_per_m2,
                ]
                .into_iter()
                .chain(record.magnetization),
            )
        {
            return Err(run_error(
                "native interface id/enum/index/orientation/value contract failed",
            ));
        }
    }
    Ok(records)
}

fn unique_descriptor_interface<'a>(
    descriptor: &'a ResolvedFdmSpinTransportIR,
    interface_id: u64,
    axis: u32,
    negative_cell: u64,
    positive_cell: u64,
    from_cell: u64,
    to_cell: u64,
) -> Result<&'a fullmag_ir::ResolvedSpinInterfaceFaceIR, RunError> {
    if axis > 2 {
        return Err(run_error(
            "native interface observation axis is outside x/y/z",
        ));
    }
    let axis_u8 = u8::try_from(axis)
        .map_err(|_| run_error("native interface observation axis exceeds u8"))?;
    let mut matches = descriptor.interfaces.iter().filter(|interface| {
        interface.face.axis == axis_u8
            && interface.face.negative_cell == negative_cell
            && interface.face.positive_cell == positive_cell
            && interface.from_cell == from_cell
            && interface.to_cell == to_cell
            && stable_transport_interface_id(
                &interface.source_id,
                interface.face.axis,
                interface.face.negative_cell,
                interface.face.positive_cell,
                interface.from_cell,
                interface.to_cell,
            ) == interface_id
    });
    let matched = matches
        .next()
        .ok_or_else(|| run_error("native interface observation has no authored topology match"))?;
    if matches.next().is_some() {
        return Err(run_error(
            "native interface observation has duplicate authored topology matches",
        ));
    }
    Ok(matched)
}

struct NativeCharge {
    raw: ffi::fullmag_fdm_cpu_charge_result_v1,
    potential: Vec<f64>,
    current_x: Vec<f64>,
    current_y: Vec<f64>,
    current_z: Vec<f64>,
    current_cell_xyz: Vec<f64>,
    interface_observations: Vec<ffi::fullmag_fdm_cpu_charge_interface_observation_v1>,
}

impl Drop for NativeCharge {
    fn drop(&mut self) {
        // SAFETY: `raw` is the unique result owning the C++ snapshot handle.
        unsafe { ffi::fullmag_fdm_cpu_charge_result_destroy_v1(&mut self.raw) };
    }
}

fn solve_charge(
    grid: GridShape,
    cell_size: CellSize,
    descriptor: &ResolvedFdmSpinTransportIR,
    multiplier: f64,
    interfaces: &[ffi::fullmag_fdm_cpu_transport_interface_v1],
) -> Result<NativeCharge, RunError> {
    if !multiplier.is_finite() {
        return Err(run_error("native current-source envelope is non-finite"));
    }
    let lengths = native_buffer_lengths(grid.nx, grid.ny, grid.nz)?;
    let mut boundaries = [ffi::fullmag_fdm_cpu_charge_boundary_v1 {
        kind: ffi::FULLMAG_FDM_CPU_CHARGE_BC_UNSET,
        reserved: 0,
        value: 0.0,
    }; 6];
    for boundary in &descriptor.charge_boundaries {
        boundaries[face_slot(boundary.face)] = match boundary.condition {
            ResolvedChargeBoundaryConditionIR::Voltage { potential_v } => {
                ffi::fullmag_fdm_cpu_charge_boundary_v1 {
                    kind: ffi::FULLMAG_FDM_CPU_CHARGE_BC_VOLTAGE,
                    reserved: 0,
                    value: potential_v * multiplier,
                }
            }
            ResolvedChargeBoundaryConditionIR::OutwardNormalCurrentDensity { .. } => {
                ffi::fullmag_fdm_cpu_charge_boundary_v1 {
                    kind: ffi::FULLMAG_FDM_CPU_CHARGE_BC_SPECIFIED_OUTWARD_CURRENT_DENSITY,
                    reserved: 0,
                    value: 0.0,
                }
            }
            ResolvedChargeBoundaryConditionIR::Insulating => {
                ffi::fullmag_fdm_cpu_charge_boundary_v1 {
                    kind: ffi::FULLMAG_FDM_CPU_CHARGE_BC_INSULATING,
                    reserved: 0,
                    value: 0.0,
                }
            }
        };
    }
    if boundaries
        .iter()
        .any(|boundary| boundary.kind == ffi::FULLMAG_FDM_CPU_CHARGE_BC_UNSET)
    {
        return Err(run_error("native charge boundary coverage is incomplete"));
    }
    let specified_faces = descriptor
        .specified_current_faces
        .iter()
        .map(|face| ffi::fullmag_fdm_cpu_specified_current_face_v1 {
            axis: u32::from(face.axis),
            outward_normal_sign: i32::from(face.outward_normal_sign),
            face_index: face.face_index,
            adjacent_cell: face.adjacent_cell,
            area_m2: face.area_m2,
            outward_current_density_a_per_m2: face.outward_current_density_apm2 * multiplier,
        })
        .collect::<Vec<_>>();
    let active = descriptor
        .charge_active_cells
        .iter()
        .map(|active| u8::from(*active))
        .collect::<Vec<_>>();
    let potential_jump_faces = descriptor
        .structured_current_closure
        .as_ref()
        .map(|closure| {
            closure
                .source_cuts
                .iter()
                .enumerate()
                .flat_map(|(source_cut_index, cut)| {
                    cut.faces.iter().map(move |face| {
                        Ok(ffi::fullmag_fdm_cpu_impressed_potential_jump_face_v1 {
                            source_cut_index: u64_len(source_cut_index, "source-cut index")?,
                            axis: u32::from(face.axis),
                            normal_sign: i32::from(cut.normal_sign),
                            negative_cell: face.negative_cell,
                            positive_cell: face.positive_cell,
                            potential_jump_v: cut.potential_jump_v * multiplier,
                        })
                    })
                })
                .collect::<Result<Vec<_>, RunError>>()
        })
        .transpose()?
        .unwrap_or_default();
    let charge_operator = if potential_jump_faces.is_empty() {
        CHARGE_OPERATOR
    } else {
        CHARGE_SOURCE_CUT_OPERATOR
    };
    let request = ffi::fullmag_fdm_cpu_charge_request_v1 {
        abi_version: ffi::FULLMAG_FDM_CPU_TRANSPORT_ABI_V1,
        struct_size: size_of::<ffi::fullmag_fdm_cpu_charge_request_v1>() as u32,
        reserved_flags: 0,
        grid: ffi::fullmag_fdm_cpu_transport_grid_v1 {
            nx: u64_len(grid.nx, "grid nx")?,
            ny: u64_len(grid.ny, "grid ny")?,
            nz: u64_len(grid.nz, "grid nz")?,
            dx_m: cell_size.dx,
            dy_m: cell_size.dy,
            dz_m: cell_size.dz,
        },
        device: ffi::FULLMAG_FDM_CPU_TRANSPORT_DEVICE_CPU,
        precision: ffi::FULLMAG_FDM_CPU_TRANSPORT_PRECISION_F64,
        conductivity_s_per_m: descriptor.charge_conductivity_spm.as_ptr(),
        conductivity_len: u64_len(
            descriptor.charge_conductivity_spm.len(),
            "conductivity length",
        )?,
        active_cells: active.as_ptr(),
        active_cells_len: u64_len(active.len(), "charge active mask length")?,
        boundaries,
        specified_current_faces: specified_faces.as_ptr(),
        specified_current_face_count: u64_len(
            specified_faces.len(),
            "specified-current face count",
        )?,
        interfaces: interfaces.as_ptr(),
        interface_count: u64_len(interfaces.len(), "charge interface count")?,
        gauge: match descriptor.charge_gauge {
            ChargePotentialGaugeIR::DirichletReference => ffi::FULLMAG_FDM_CPU_CHARGE_GAUGE_NONE,
            ChargePotentialGaugeIR::ZeroMean => ffi::FULLMAG_FDM_CPU_CHARGE_GAUGE_ZERO_MEAN,
        },
        reserved0: 0,
        relative_tolerance: descriptor.charge_solver.linear.relative_tolerance,
        absolute_tolerance_a_per_m3: descriptor.charge_solver.linear.absolute_tolerance,
        max_iterations: u64::from(descriptor.charge_solver.linear.max_iterations),
        api_version: fixed_text(CHARGE_API)?,
        operator_version: fixed_text(charge_operator)?,
        solver_version: fixed_text(CHARGE_SOLVER)?,
        residual_version: fixed_text(CHARGE_RESIDUAL)?,
        impressed_potential_jump_faces: potential_jump_faces.as_ptr(),
        impressed_potential_jump_face_count: u64_len(
            potential_jump_faces.len(),
            "impressed potential jump face count",
        )?,
    };
    let mut potential = vec![0.0; lengths.cells];
    let mut current_x = vec![0.0; lengths.x_faces];
    let mut current_y = vec![0.0; lengths.y_faces];
    let mut current_z = vec![0.0; lengths.z_faces];
    let mut current_cell_xyz = vec![0.0; lengths.cell_xyz];
    let mixing_count = interfaces
        .iter()
        .filter(|interface| {
            interface.kind == ffi::FULLMAG_FDM_CPU_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2
        })
        .count();
    let mut interface_observations = vec![
        // SAFETY: all-zero is a valid value for this plain C observation record.
        unsafe { zeroed::<ffi::fullmag_fdm_cpu_charge_interface_observation_v1>() };
        mixing_count
    ];
    // SAFETY: all-zero is valid for this plain C result before buffer descriptors are installed.
    let mut raw = unsafe { zeroed::<ffi::fullmag_fdm_cpu_charge_result_v1>() };
    raw.abi_version = ffi::FULLMAG_FDM_CPU_TRANSPORT_ABI_V1;
    raw.struct_size = size_of::<ffi::fullmag_fdm_cpu_charge_result_v1>() as u32;
    raw.potential_v = f64_buffer(&mut potential)?;
    raw.jc_x_a_per_m2 = f64_buffer(&mut current_x)?;
    raw.jc_y_a_per_m2 = f64_buffer(&mut current_y)?;
    raw.jc_z_a_per_m2 = f64_buffer(&mut current_z)?;
    raw.jc_cell_xyz_a_per_m2 = f64_buffer(&mut current_cell_xyz)?;
    raw.interface_observations = ffi::fullmag_fdm_cpu_charge_interface_observation_buffer_v1 {
        data: interface_observations.as_mut_ptr(),
        capacity: u64_len(interface_observations.len(), "charge observation capacity")?,
        length: 0,
    };
    // SAFETY: request inputs and caller-owned result buffers remain alive for the call.
    let status = unsafe { ffi::fullmag_fdm_cpu_charge_solve_v1(&request, &mut raw) };
    if status != ffi::FULLMAG_FDM_CPU_TRANSPORT_OK {
        return Err(run_error(format!(
            "native M1 charge solve failed ({status}): {}",
            error_message(&raw.error_message)
        )));
    }
    let charge = NativeCharge {
        raw,
        potential,
        current_x,
        current_y,
        current_z,
        current_cell_xyz,
        interface_observations,
    };
    validate_charge_result(
        &charge.raw,
        &charge.potential,
        &charge.current_x,
        &charge.current_y,
        &charge.current_z,
        &charge.current_cell_xyz,
        &charge.interface_observations,
        interfaces,
        charge_operator,
    )?;
    Ok(charge)
}

struct RuntimeSourceCut {
    stable_id: String,
    component_label: u64,
    ordered_internal_face_ids: Vec<u64>,
    ordered_normals: Vec<i8>,
    drive_id: String,
    drive_kind: String,
    drive_value: f64,
    drive_si_unit: String,
    revision: u64,
    digest: String,
}

struct NativeOersted {
    field_apm: Vec<[f64; 3]>,
    provenance: FdmOerstedClosureProvenanceSnapshot,
}

fn append_runtime_source_cut(bytes: &mut CanonicalBytes, source_cut: &RuntimeSourceCut) {
    bytes.text(&source_cut.stable_id);
    bytes.u64(source_cut.component_label);
    bytes.u64_vector(&source_cut.ordered_internal_face_ids);
    bytes.i8_vector(&source_cut.ordered_normals);
    bytes.text(&source_cut.drive_id);
    bytes.text(&source_cut.drive_kind);
    bytes.f64(source_cut.drive_value);
    bytes.text(&source_cut.drive_si_unit);
    bytes.u64(source_cut.revision);
}

fn source_cut_digest(source_cut: &RuntimeSourceCut) -> String {
    let mut bytes = CanonicalBytes::default();
    bytes.text("fdm_oersted_source_cut.v1");
    append_runtime_source_cut(&mut bytes, source_cut);
    canonical_digest(bytes)
}

fn flat_internal_face(
    grid: GridShape,
    axis: u8,
    negative_cell: u64,
    positive_cell: u64,
    charge: &NativeCharge,
) -> Result<(u64, f64), RunError> {
    let negative = cell_coordinates(grid, negative_cell)?;
    let positive = cell_coordinates(grid, positive_cell)?;
    let x_count = (grid.nx + 1)
        .checked_mul(grid.ny)
        .and_then(|value| value.checked_mul(grid.nz))
        .ok_or_else(|| run_error("native Oersted x-face count overflows usize"))?;
    let y_count = grid
        .nx
        .checked_mul(grid.ny + 1)
        .and_then(|value| value.checked_mul(grid.nz))
        .ok_or_else(|| run_error("native Oersted y-face count overflows usize"))?;
    let (flat, density) = match axis {
        0 if positive == [negative[0] + 1, negative[1], negative[2]] => {
            let local = x_face_index(
                grid,
                positive[0],
                negative[1],
                negative[2],
            );
            (local, charge.current_x[local])
        }
        1 if positive == [negative[0], negative[1] + 1, negative[2]] => {
            let local = y_face_index(
                grid,
                negative[0],
                positive[1],
                negative[2],
            );
            (x_count + local, charge.current_y[local])
        }
        2 if positive == [negative[0], negative[1], negative[2] + 1] => {
            let local = z_face_index(
                grid,
                negative[0],
                negative[1],
                positive[2],
            );
            (x_count + y_count + local, charge.current_z[local])
        }
        _ => {
            return Err(run_error(
                "native Oersted source-cut face is not a positive-axis internal neighbor",
            ));
        }
    };
    Ok((u64_len(flat, "flat Oersted face index")?, density))
}

fn solve_public_oersted(
    grid: GridShape,
    cell_size: CellSize,
    descriptor: &ResolvedFdmSpinTransportIR,
    closure: &ResolvedFdmStructuredCurrentClosureIR,
    source_identity: &str,
    charge: &NativeCharge,
    multiplier: f64,
    state_revision: u64,
    stage_time_s: f64,
) -> Result<NativeOersted, RunError> {
    let grid_shape = [
        u32::try_from(grid.nx).map_err(|_| run_error("native Oersted nx exceeds u32"))?,
        u32::try_from(grid.ny).map_err(|_| run_error("native Oersted ny exceeds u32"))?,
        u32::try_from(grid.nz).map_err(|_| run_error("native Oersted nz exceeds u32"))?,
    ];
    if closure.schema_version != "structured_current_closure.v1"
        || closure.grid_shape != grid_shape
        || closure.cell_size_m != [cell_size.dx, cell_size.dy, cell_size.dz]
    {
        return Err(run_error(
            "native Oersted resolved structured-current closure is stale for the active grid",
        ));
    }
    if !stage_time_s.is_finite() || !multiplier.is_finite() {
        return Err(run_error(
            "native Oersted source evaluation time or multiplier is non-finite",
        ));
    }
    let conductor_mask = descriptor
        .charge_active_cells
        .iter()
        .map(|active| u8::from(*active))
        .collect::<Vec<_>>();
    let target_mask = descriptor
        .saturation_magnetization_apm
        .iter()
        .map(|value| u8::from(*value > 0.0))
        .collect::<Vec<_>>();
    let (labels, component_count) = component_labels(grid, &conductor_mask)?;
    let mut component_ids = Vec::with_capacity(component_count);
    for label in &labels {
        if *label != INACTIVE_COMPONENT_LABEL && !component_ids.contains(label) {
            component_ids.push(*label);
        }
    }
    let mut driven_components = vec![false; component_count];
    let component_slot = |label: u64| {
        component_ids
            .iter()
            .position(|candidate| *candidate == label)
            .ok_or_else(|| run_error("native Oersted active component label is missing"))
    };
    let mut inspect_face = |density: f64,
                            negative: Option<usize>,
                            positive: Option<usize>|
     -> Result<(), RunError> {
        if !density.is_finite() {
            return Err(run_error("native Oersted face current contains a non-finite value"));
        }
        if density == 0.0 {
            return Ok(());
        }
        let negative_active = negative.is_some_and(|cell| conductor_mask[cell] != 0);
        let positive_active = positive.is_some_and(|cell| conductor_mask[cell] != 0);
        if !(negative_active && positive_active) {
            return Err(run_error(
                "native Oersted face current leaks across the conductor or union-grid boundary",
            ));
        }
        let negative = negative.expect("negative active face side exists");
        let positive = positive.expect("positive active face side exists");
        if labels[negative] != labels[positive] {
            return Err(run_error(
                "native Oersted nonzero face current crosses disconnected components",
            ));
        }
        driven_components[component_slot(labels[negative])?] = true;
        Ok(())
    };
    for z in 0..grid.nz {
        for y in 0..grid.ny {
            for x in 0..=grid.nx {
                inspect_face(
                    charge.current_x[x_face_index(grid, x, y, z)],
                    (x > 0).then(|| cell_index(grid, x - 1, y, z)),
                    (x < grid.nx).then(|| cell_index(grid, x, y, z)),
                )?;
            }
        }
    }
    for z in 0..grid.nz {
        for y in 0..=grid.ny {
            for x in 0..grid.nx {
                inspect_face(
                    charge.current_y[y_face_index(grid, x, y, z)],
                    (y > 0).then(|| cell_index(grid, x, y - 1, z)),
                    (y < grid.ny).then(|| cell_index(grid, x, y, z)),
                )?;
            }
        }
    }
    for z in 0..=grid.nz {
        for y in 0..grid.ny {
            for x in 0..grid.nx {
                inspect_face(
                    charge.current_z[z_face_index(grid, x, y, z)],
                    (z > 0).then(|| cell_index(grid, x, y, z - 1)),
                    (z < grid.nz).then(|| cell_index(grid, x, y, z)),
                )?;
            }
        }
    }

    let mut measured_max_abs_divergence = 0.0_f64;
    let mut divergence_scale = 0.0_f64;
    for z in 0..grid.nz {
        for y in 0..grid.ny {
            for x in 0..grid.nx {
                let cell = cell_index(grid, x, y, z);
                if conductor_mask[cell] == 0 {
                    continue;
                }
                let terms = [
                    (charge.current_x[x_face_index(grid, x + 1, y, z)]
                        - charge.current_x[x_face_index(grid, x, y, z)])
                        / cell_size.dx,
                    (charge.current_y[y_face_index(grid, x, y + 1, z)]
                        - charge.current_y[y_face_index(grid, x, y, z)])
                        / cell_size.dy,
                    (charge.current_z[z_face_index(grid, x, y, z + 1)]
                        - charge.current_z[z_face_index(grid, x, y, z)])
                        / cell_size.dz,
                ];
                let divergence = terms[0] + terms[1] + terms[2];
                measured_max_abs_divergence = measured_max_abs_divergence.max(divergence.abs());
                divergence_scale = divergence_scale.max(
                    terms[0].abs() + terms[1].abs() + terms[2].abs(),
                );
            }
        }
    }
    let roundoff_divergence = 128.0 * f64::EPSILON * divergence_scale.max(1.0);
    let divergence_tolerance = descriptor
        .charge_solver
        .linear
        .absolute_tolerance
        .max(roundoff_divergence);
    if measured_max_abs_divergence > divergence_tolerance {
        return Err(run_error(format!(
            "native Oersted closure certificate rejected charge divergence {} A/m^3 above {} A/m^3",
            measured_max_abs_divergence, divergence_tolerance
        )));
    }
    let revision = state_revision.max(1);
    let mut source_cuts = Vec::new();
    for cut in &closure.source_cuts {
        let first_face = cut
            .faces
            .first()
            .ok_or_else(|| run_error("native Oersted resolved source_cut has no faces"))?;
        let first_cell = usize::try_from(first_face.negative_cell)
            .map_err(|_| run_error("native Oersted source-cut cell exceeds usize"))?;
        let component_label = *labels
            .get(first_cell)
            .ok_or_else(|| run_error("native Oersted source-cut cell is outside the grid"))?;
        let slot = component_slot(component_label)?;
        if !driven_components[slot] {
            continue;
        }
        let mut face_ids = Vec::with_capacity(cut.faces.len() * 2);
        let mut normals = Vec::with_capacity(cut.faces.len() * 2);
        for face in &cut.faces {
            let (flat_id, density) = flat_internal_face(
                grid,
                face.axis,
                face.negative_cell,
                face.positive_cell,
                charge,
            )?;
            if density == 0.0 {
                return Err(run_error(format!(
                    "native Oersted source_cut '{}' contains a zero-current face",
                    cut.source_cut_id
                )));
            }
            face_ids.extend_from_slice(&[flat_id, flat_id]);
            normals.extend_from_slice(&[cut.normal_sign, -cut.normal_sign]);
        }
        let mut runtime_cut = RuntimeSourceCut {
            stable_id: cut.source_cut_id.clone(),
            component_label,
            ordered_internal_face_ids: face_ids,
            ordered_normals: normals,
            drive_id: cut.drive_id.clone(),
            drive_kind: "impressed_potential_jump.v1".into(),
            drive_value: cut.potential_jump_v * multiplier,
            drive_si_unit: "V".into(),
            revision,
            digest: String::new(),
        };
        if !runtime_cut.drive_value.is_finite() || runtime_cut.drive_value == 0.0 {
            return Err(run_error(format!(
                "native Oersted driven source_cut '{}' has an invalid evaluated drive",
                cut.source_cut_id
            )));
        }
        runtime_cut.digest = source_cut_digest(&runtime_cut);
        source_cuts.push(runtime_cut);
    }
    let driven_count = driven_components.iter().filter(|driven| **driven).count();
    if source_cuts.len() != driven_count {
        return Err(run_error(format!(
            "native Oersted requires one resolved source_cut per driven component (expected {driven_count}, got {})",
            source_cuts.len()
        )));
    }

    let mut geometry_bytes = CanonicalBytes::default();
    geometry_bytes.text("fdm_oersted_union_grid_geometry.v1");
    geometry_bytes.u64(grid.nx as u64);
    geometry_bytes.u64(grid.ny as u64);
    geometry_bytes.u64(grid.nz as u64);
    geometry_bytes.f64(cell_size.dx);
    geometry_bytes.f64(cell_size.dy);
    geometry_bytes.f64(cell_size.dz);
    for coordinate in closure.origin_m {
        geometry_bytes.f64(coordinate);
    }
    for _ in 0..3 {
        geometry_bytes.u64(u64::from(ffi::FULLMAG_FDM_CPU_OERSTED_BOUNDARY_OPEN));
    }
    let geometry_digest = canonical_digest(geometry_bytes);
    let mask_digest = |mask: &[u8]| {
        let mut bytes = CanonicalBytes::default();
        bytes.text("fdm_oersted_boolean_mask.v1");
        bytes.bytes(mask);
        canonical_digest(bytes)
    };
    let conductor_mask_digest = mask_digest(&conductor_mask);
    let target_mask_digest = mask_digest(&target_mask);
    let mut face_bytes = CanonicalBytes::default();
    face_bytes.text("fdm_oriented_face_current_density.v1");
    face_bytes.f64_vector(&charge.current_x);
    face_bytes.f64_vector(&charge.current_y);
    face_bytes.f64_vector(&charge.current_z);
    let face_current_digest = canonical_digest(face_bytes);
    let measured_component_exterior_current_a = vec![0.0; component_count];
    let exterior_current_tolerance = 128.0
        * f64::EPSILON
        * charge
            .current_x
            .iter()
            .chain(&charge.current_y)
            .chain(&charge.current_z)
            .fold(1.0_f64, |scale, value| scale.max(value.abs()))
        * (cell_size.dx * cell_size.dy)
            .max(cell_size.dx * cell_size.dz)
            .max(cell_size.dy * cell_size.dz);
    let mut certificate_bytes = CanonicalBytes::default();
    certificate_bytes.text("fdm_global_closed_current_certificate_payload.v1");
    certificate_bytes.text(OERSTED_CERTIFICATE);
    certificate_bytes.u64(u64::from(
        ffi::FULLMAG_FDM_CPU_OERSTED_CLOSURE_CLOSED_GEOMETRY,
    ));
    certificate_bytes.u64(revision);
    certificate_bytes.text(&geometry_digest);
    certificate_bytes.u64(revision);
    certificate_bytes.text(&conductor_mask_digest);
    certificate_bytes.u64(revision);
    certificate_bytes.text(&face_current_digest);
    certificate_bytes.u64_vector(&labels);
    certificate_bytes.u64(component_count as u64);
    for passed in [true, true, true, true] {
        certificate_bytes.boolean(passed);
    }
    certificate_bytes.f64(divergence_tolerance);
    certificate_bytes.f64(exterior_current_tolerance);
    certificate_bytes.f64(measured_max_abs_divergence);
    certificate_bytes.f64_vector(&measured_component_exterior_current_a);
    certificate_bytes.u64(source_cuts.len() as u64);
    for source_cut in &source_cuts {
        append_runtime_source_cut(&mut certificate_bytes, source_cut);
        certificate_bytes.text(&source_cut.digest);
    }
    certificate_bytes.text("");
    certificate_bytes.text("");
    let certificate_digest = canonical_digest(certificate_bytes);
    let mut envelope_bytes = CanonicalBytes::default();
    envelope_bytes.text("fdm_current_envelope_evaluation.v1");
    envelope_bytes.text(source_identity);
    envelope_bytes.text(&closure.closure_id);
    envelope_bytes.u64(revision);
    envelope_bytes.u64(revision);
    envelope_bytes.f64(stage_time_s);
    envelope_bytes.f64(multiplier);
    let envelope_digest = canonical_digest(envelope_bytes);
    let mut trusted_bytes = CanonicalBytes::default();
    trusted_bytes.text("fdm_oersted_trusted_immutable_snapshot.v1");
    trusted_bytes.u64(revision);
    trusted_bytes.text(&geometry_digest);
    trusted_bytes.u64(revision);
    trusted_bytes.text(&conductor_mask_digest);
    trusted_bytes.u64(revision);
    trusted_bytes.text(&target_mask_digest);
    trusted_bytes.u64(revision);
    trusted_bytes.text(&face_current_digest);
    trusted_bytes.text(&certificate_digest);
    trusted_bytes.u64(revision);
    trusted_bytes.text(source_identity);
    trusted_bytes.u64(revision);
    trusted_bytes.text(&envelope_digest);
    trusted_bytes.u64(revision);
    trusted_bytes.f64(stage_time_s);
    trusted_bytes.f64(multiplier);
    let trusted_snapshot_digest = canonical_digest(trusted_bytes);

    struct SourceCutStrings {
        stable_id: CString,
        drive_id: CString,
        drive_kind: CString,
        drive_si_unit: CString,
        digest: CString,
    }
    let source_cut_strings = source_cuts
        .iter()
        .map(|cut| {
            Ok(SourceCutStrings {
                stable_id: c_string("source-cut id", &cut.stable_id)?,
                drive_id: c_string("drive id", &cut.drive_id)?,
                drive_kind: c_string("drive kind", &cut.drive_kind)?,
                drive_si_unit: c_string("drive unit", &cut.drive_si_unit)?,
                digest: c_string("source-cut digest", &cut.digest)?,
            })
        })
        .collect::<Result<Vec<_>, RunError>>()?;
    let ffi_source_cuts = source_cuts
        .iter()
        .zip(&source_cut_strings)
        .map(|(cut, strings)| ffi::fullmag_fdm_cpu_oersted_source_cut_v1 {
            stable_id: strings.stable_id.as_ptr(),
            component_label: cut.component_label,
            ordered_internal_face_ids: ffi::fullmag_fdm_cpu_oersted_const_u64_buffer_v1 {
                data: cut.ordered_internal_face_ids.as_ptr(),
                length: cut.ordered_internal_face_ids.len() as u64,
            },
            ordered_normals: ffi::fullmag_fdm_cpu_oersted_const_i8_buffer_v1 {
                data: cut.ordered_normals.as_ptr(),
                length: cut.ordered_normals.len() as u64,
            },
            drive_id: strings.drive_id.as_ptr(),
            drive_kind: strings.drive_kind.as_ptr(),
            drive_value: cut.drive_value,
            drive_si_unit: strings.drive_si_unit.as_ptr(),
            revision: cut.revision,
            digest: strings.digest.as_ptr(),
        })
        .collect::<Vec<_>>();
    let certificate_version = c_string("certificate version", OERSTED_CERTIFICATE)?;
    let certificate_digest_c = c_string("certificate digest", &certificate_digest)?;
    let geometry_digest_c = c_string("geometry digest", &geometry_digest)?;
    let conductor_mask_digest_c = c_string("conductor-mask digest", &conductor_mask_digest)?;
    let face_current_digest_c = c_string("face-current digest", &face_current_digest)?;
    let empty = c_string("empty certification field", "")?;
    let certificate = ffi::fullmag_fdm_cpu_oersted_certificate_v1 {
        abi_version: ffi::FULLMAG_FDM_CPU_OERSTED_ABI_V1,
        struct_size: size_of::<ffi::fullmag_fdm_cpu_oersted_certificate_v1>() as u32,
        reserved_flags: 0,
        closure_kind: ffi::FULLMAG_FDM_CPU_OERSTED_CLOSURE_CLOSED_GEOMETRY,
        global_continuity_passed: 1,
        exterior_flux_passed: 1,
        component_flux_passed: 1,
        return_path_complete: 1,
        reserved0: 0,
        revision,
        version: certificate_version.as_ptr(),
        digest: certificate_digest_c.as_ptr(),
        geometry_digest: geometry_digest_c.as_ptr(),
        conductor_mask_revision: revision,
        conductor_mask_digest: conductor_mask_digest_c.as_ptr(),
        face_current_revision: revision,
        face_current_digest: face_current_digest_c.as_ptr(),
        component_labels: ffi::fullmag_fdm_cpu_oersted_const_u64_buffer_v1 {
            data: labels.as_ptr(),
            length: labels.len() as u64,
        },
        component_count: component_count as u64,
        divergence_tolerance_a_per_m3: divergence_tolerance,
        exterior_current_tolerance_a: exterior_current_tolerance,
        measured_max_abs_divergence_a_per_m3: measured_max_abs_divergence,
        measured_component_exterior_current_a:
            ffi::fullmag_fdm_cpu_oersted_const_f64_buffer_v1 {
                data: measured_component_exterior_current_a.as_ptr(),
                length: measured_component_exterior_current_a.len() as u64,
            },
        source_cuts: ffi_source_cuts.as_ptr(),
        source_cut_count: ffi_source_cuts.len() as u64,
        imported_certification_method: empty.as_ptr(),
        imported_field_digest: empty.as_ptr(),
    };
    let target_mask_digest_c = c_string("target-mask digest", &target_mask_digest)?;
    let source_identity_c = c_string("source identity", source_identity)?;
    let envelope_digest_c = c_string("envelope digest", &envelope_digest)?;
    let trusted_snapshot_digest_c =
        c_string("trusted-snapshot digest", &trusted_snapshot_digest)?;
    let request = ffi::fullmag_fdm_cpu_oersted_request_v1 {
        abi_version: ffi::FULLMAG_FDM_CPU_OERSTED_ABI_V1,
        struct_size: size_of::<ffi::fullmag_fdm_cpu_oersted_request_v1>() as u32,
        reserved_flags: 0,
        grid: ffi::fullmag_fdm_cpu_transport_grid_v1 {
            nx: grid.nx as u64,
            ny: grid.ny as u64,
            nz: grid.nz as u64,
            dx_m: cell_size.dx,
            dy_m: cell_size.dy,
            dz_m: cell_size.dz,
        },
        origin_m: closure.origin_m,
        boundaries: [ffi::FULLMAG_FDM_CPU_OERSTED_BOUNDARY_OPEN; 3],
        reserved0: 0,
        conductor_mask: conductor_mask.as_ptr(),
        conductor_mask_len: conductor_mask.len() as u64,
        target_mask: target_mask.as_ptr(),
        target_mask_len: target_mask.len() as u64,
        jc_x_a_per_m2: ffi::fullmag_fdm_cpu_oersted_const_f64_buffer_v1 {
            data: charge.current_x.as_ptr(),
            length: charge.current_x.len() as u64,
        },
        jc_y_a_per_m2: ffi::fullmag_fdm_cpu_oersted_const_f64_buffer_v1 {
            data: charge.current_y.as_ptr(),
            length: charge.current_y.len() as u64,
        },
        jc_z_a_per_m2: ffi::fullmag_fdm_cpu_oersted_const_f64_buffer_v1 {
            data: charge.current_z.as_ptr(),
            length: charge.current_z.len() as u64,
        },
        geometry_revision: revision,
        geometry_digest: geometry_digest_c.as_ptr(),
        conductor_mask_revision: revision,
        conductor_mask_digest: conductor_mask_digest_c.as_ptr(),
        target_mask_revision: revision,
        target_mask_digest: target_mask_digest_c.as_ptr(),
        face_current_revision: revision,
        face_current_digest: face_current_digest_c.as_ptr(),
        source_identity: source_identity_c.as_ptr(),
        envelope_revision: revision,
        envelope_digest: envelope_digest_c.as_ptr(),
        stage_identity: revision,
        evaluation_time_s: stage_time_s,
        evaluated_envelope_multiplier: multiplier,
        trusted_snapshot_revision: revision,
        trusted_snapshot_digest: trusted_snapshot_digest_c.as_ptr(),
        certificate: &certificate,
    };
    let mut field = vec![0.0; target_mask.len() * 3];
    // SAFETY: all-zero is valid before the caller-owned output buffer is installed.
    let mut result = unsafe { zeroed::<ffi::fullmag_fdm_cpu_oersted_result_v1>() };
    result.abi_version = ffi::FULLMAG_FDM_CPU_OERSTED_ABI_V1;
    result.struct_size = size_of::<ffi::fullmag_fdm_cpu_oersted_result_v1>() as u32;
    result.field_xyz_a_per_m = ffi::fullmag_fdm_cpu_f64_buffer_v1 {
        data: field.as_mut_ptr(),
        capacity: field.len() as u64,
        length: 0,
    };
    // SAFETY: every request pointer and caller-owned output remains alive for the call.
    let status = unsafe { ffi::fullmag_fdm_cpu_oersted_solve_v1(&request, &mut result) };
    if status != ffi::FULLMAG_FDM_CPU_OERSTED_OK {
        return Err(run_error(format!(
            "native M1 public Oersted solve failed ({status}): {}",
            error_message(&result.error_message)
        )));
    }
    if result.status != ffi::FULLMAG_FDM_CPU_OERSTED_OK
        || result.reserved_flags != 0
        || result.field_xyz_a_per_m.data != field.as_mut_ptr()
        || result.field_xyz_a_per_m.capacity != field.len() as u64
        || result.field_xyz_a_per_m.length != field.len() as u64
        || result.face_current_revision != revision
        || result.certificate_revision != revision
        || result.trusted_snapshot_revision != revision
        || result.envelope_revision != revision
        || result.stage_identity != revision
        || result.evaluation_time_s.to_bits() != stage_time_s.to_bits()
        || result.evaluated_envelope_multiplier.to_bits() != multiplier.to_bits()
    {
        return Err(run_error("native M1 public Oersted result identity contract failed"));
    }
    for (label, actual, expected) in [
        ("API", &result.api_version[..], OERSTED_API),
        ("formula", &result.formula_version[..], OERSTED_FORMULA),
        (
            "reconstruction",
            &result.reconstruction_version[..],
            OERSTED_RECONSTRUCTION,
        ),
        ("operator", &result.operator_version[..], OERSTED_OPERATOR),
        (
            "realization",
            &result.realization_version[..],
            OERSTED_REALIZATION,
        ),
        ("engine", &result.engine_version[..], OERSTED_ENGINE),
        (
            "certificate",
            &result.certificate_version[..],
            OERSTED_CERTIFICATE,
        ),
    ] {
        validate_version_text(&format!("Oersted {label}"), actual, expected)?;
    }
    for (label, actual, expected) in [
        (
            "face-current digest",
            &result.face_current_digest[..],
            face_current_digest.as_str(),
        ),
        (
            "certificate digest",
            &result.certificate_digest[..],
            certificate_digest.as_str(),
        ),
        (
            "trusted-snapshot digest",
            &result.trusted_snapshot_digest[..],
            trusted_snapshot_digest.as_str(),
        ),
        (
            "source identity",
            &result.source_identity[..],
            source_identity,
        ),
    ] {
        validate_version_text(&format!("Oersted {label}"), actual, expected)?;
    }
    if field.iter().any(|value| !value.is_finite()) {
        return Err(run_error("native M1 public Oersted field contains a non-finite value"));
    }
    Ok(NativeOersted {
        field_apm: field
            .chunks_exact(3)
            .map(|value| [value[0], value[1], value[2]])
            .collect(),
        provenance: FdmOerstedClosureProvenanceSnapshot {
            api_version: OERSTED_API.into(),
            formula_version: OERSTED_FORMULA.into(),
            reconstruction_version: OERSTED_RECONSTRUCTION.into(),
            operator_version: OERSTED_OPERATOR.into(),
            realization_version: OERSTED_REALIZATION.into(),
            engine_version: OERSTED_ENGINE.into(),
            certificate_version: OERSTED_CERTIFICATE.into(),
            closure_kind: "closed_geometry".into(),
            source_identity: source_identity.into(),
            revision,
            geometry_digest,
            conductor_mask_digest,
            target_mask_digest,
            face_current_digest,
            certificate_digest,
            envelope_digest,
            trusted_snapshot_digest,
            divergence_tolerance_apm3: divergence_tolerance,
            measured_max_abs_divergence_apm3: measured_max_abs_divergence,
            exterior_current_tolerance_a: exterior_current_tolerance,
            measured_component_exterior_current_a,
            source_cuts: source_cuts
                .into_iter()
                .map(|cut| FdmStructuredCurrentSourceCutSnapshot {
                    source_cut_id: cut.stable_id,
                    component_label: cut.component_label,
                    ordered_internal_face_ids: cut.ordered_internal_face_ids,
                    ordered_normals: cut.ordered_normals,
                    drive_id: cut.drive_id,
                    drive_kind: cut.drive_kind,
                    drive_value_v: cut.drive_value,
                    revision: cut.revision,
                    digest: cut.digest,
                })
                .collect(),
        },
    })
}

fn missing_public_fdm_closure_error(
    grid: GridShape,
    cell_size: CellSize,
    descriptor: &ResolvedFdmSpinTransportIR,
    charge: &NativeCharge,
    multiplier: f64,
    state_revision: u64,
    stage_time_s: f64,
) -> RunError {
    let conductor_mask = descriptor
        .charge_active_cells
        .iter()
        .map(|active| u8::from(*active))
        .collect::<Vec<_>>();
    let target_mask = descriptor
        .saturation_magnetization_apm
        .iter()
        .map(|value| u8::from(*value > 0.0))
        .collect::<Vec<_>>();
    // SAFETY: all-zero is a valid prefix for this plain append-only C request.
    let mut request = unsafe { zeroed::<ffi::fullmag_fdm_cpu_oersted_request_v1>() };
    request.abi_version = ffi::FULLMAG_FDM_CPU_OERSTED_ABI_V1;
    request.struct_size = size_of::<ffi::fullmag_fdm_cpu_oersted_request_v1>() as u32;
    request.grid = ffi::fullmag_fdm_cpu_transport_grid_v1 {
        nx: grid.nx as u64,
        ny: grid.ny as u64,
        nz: grid.nz as u64,
        dx_m: cell_size.dx,
        dy_m: cell_size.dy,
        dz_m: cell_size.dz,
    };
    request.boundaries = [ffi::FULLMAG_FDM_CPU_OERSTED_BOUNDARY_OPEN; 3];
    request.conductor_mask = conductor_mask.as_ptr();
    request.conductor_mask_len = conductor_mask.len() as u64;
    request.target_mask = target_mask.as_ptr();
    request.target_mask_len = target_mask.len() as u64;
    request.jc_x_a_per_m2 = ffi::fullmag_fdm_cpu_oersted_const_f64_buffer_v1 {
        data: charge.current_x.as_ptr(),
        length: charge.current_x.len() as u64,
    };
    request.jc_y_a_per_m2 = ffi::fullmag_fdm_cpu_oersted_const_f64_buffer_v1 {
        data: charge.current_y.as_ptr(),
        length: charge.current_y.len() as u64,
    };
    request.jc_z_a_per_m2 = ffi::fullmag_fdm_cpu_oersted_const_f64_buffer_v1 {
        data: charge.current_z.as_ptr(),
        length: charge.current_z.len() as u64,
    };
    request.face_current_revision = state_revision.max(1);
    request.envelope_revision = state_revision.max(1);
    request.stage_identity = state_revision.max(1);
    request.evaluation_time_s = stage_time_s;
    request.evaluated_envelope_multiplier = multiplier;
    request.trusted_snapshot_revision = state_revision.max(1);
    request.certificate = std::ptr::null();

    let mut field = vec![0.0; target_mask.len() * 3];
    // SAFETY: all-zero is valid before the output descriptor is installed.
    let mut result = unsafe { zeroed::<ffi::fullmag_fdm_cpu_oersted_result_v1>() };
    result.abi_version = ffi::FULLMAG_FDM_CPU_OERSTED_ABI_V1;
    result.struct_size = size_of::<ffi::fullmag_fdm_cpu_oersted_result_v1>() as u32;
    result.field_xyz_a_per_m = ffi::fullmag_fdm_cpu_f64_buffer_v1 {
        data: field.as_mut_ptr(),
        capacity: field.len() as u64,
        length: 0,
    };
    // SAFETY: accepted face-current and mask buffers remain alive for the call.
    let status = unsafe { ffi::fullmag_fdm_cpu_oersted_solve_v1(&request, &mut result) };
    let message = error_message(&result.error_message);
    if status != ffi::FULLMAG_FDM_CPU_OERSTED_ERR_MISSING_CERTIFICATE {
        return run_error(format!(
            "native M1 Oersted ABI did not fail closed for a missing certificate: status={status}, message='{message}'"
        ));
    }
    run_error(format!(
        "native M1 solved-current Oersted requires global_closed_current_certificate.v1, but public FDM ProblemIR has no closure/source-cut descriptor; accepted raw face-current was not published as H_oe. operator={OERSTED_OPERATOR}, realization={OERSTED_REALIZATION}, engine={OERSTED_ENGINE}, native_status={status}: {message}"
    ))
}

pub(super) fn solve_native_m1_snapshot(
    grid: GridShape,
    cell_size: CellSize,
    resolved: &fullmag_ir::ResolvedSpinTransportPlanIR,
    descriptor: &ResolvedFdmSpinTransportIR,
    magnetization: &[[f64; 3]],
    multiplier: f64,
    state_revision: u64,
    stage_time_s: f64,
) -> Result<FdmSpinTransportModuleSnapshot, RunError> {
    // SAFETY: this availability call has no inputs and is always exported by the CPU library.
    if unsafe { ffi::fullmag_fdm_cpu_transport_is_available_v1() } != 1 {
        return Err(run_error(
            "native_m1_v1 was planned but the CPU transport ABI is unavailable; fallback is forbidden",
        ));
    }
    if descriptor.spin_solver.engine != "native_m1_v1" || descriptor.charge_solver.engine != "cg" {
        return Err(run_error(
            "native_m1_v1 requires explicit native spin and CG charge engine selection",
        ));
    }
    let lengths = native_buffer_lengths(grid.nx, grid.ny, grid.nz)?;
    let interfaces = interface_records(descriptor, magnetization)?;
    let charge = solve_charge(grid, cell_size, descriptor, multiplier, &interfaces)?;
    let spin_active = descriptor
        .spin_active_cells
        .iter()
        .map(|active| u8::from(*active))
        .collect::<Vec<_>>();
    let torque_targets = descriptor
        .torque_target_cells
        .iter()
        .map(|active| u8::from(*active))
        .collect::<Vec<_>>();
    let magnetization_xyz = magnetization.iter().flatten().copied().collect::<Vec<_>>();
    let reactions = descriptor
        .reactions
        .iter()
        .map(|reaction| ffi::fullmag_fdm_cpu_spin_reaction_lengths_v1 {
            spin_flip_m: reaction.spin_flip_m.unwrap_or(0.0),
            exchange_m: reaction.exchange_m.unwrap_or(0.0),
            dephasing_m: reaction.dephasing_m.unwrap_or(0.0),
        })
        .collect::<Vec<_>>();
    let mut boundaries = [ffi::fullmag_fdm_cpu_spin_boundary_v1 {
        kind: ffi::FULLMAG_FDM_CPU_SPIN_BC_UNSET,
        reserved: 0,
        potential_v: [0.0; 3],
    }; 6];
    for boundary in &descriptor.spin_boundaries {
        boundaries[face_slot(boundary.face)] = match boundary.condition {
            ResolvedSpinBoundaryConditionIR::SpinInsulating => {
                ffi::fullmag_fdm_cpu_spin_boundary_v1 {
                    kind: ffi::FULLMAG_FDM_CPU_SPIN_BC_INSULATING,
                    reserved: 0,
                    potential_v: [0.0; 3],
                }
            }
            ResolvedSpinBoundaryConditionIR::SpinSink => ffi::fullmag_fdm_cpu_spin_boundary_v1 {
                kind: ffi::FULLMAG_FDM_CPU_SPIN_BC_SINK,
                reserved: 0,
                potential_v: [0.0; 3],
            },
            ResolvedSpinBoundaryConditionIR::SpecifiedPotential { value_v } => {
                ffi::fullmag_fdm_cpu_spin_boundary_v1 {
                    kind: ffi::FULLMAG_FDM_CPU_SPIN_BC_SPECIFIED_POTENTIAL,
                    reserved: 0,
                    potential_v: value_v,
                }
            }
            ResolvedSpinBoundaryConditionIR::SpecifiedOutwardFlux { .. } => {
                return Err(run_error(
                    "native_m1_v1 does not support specified spin flux; fallback is forbidden",
                ));
            }
            ResolvedSpinBoundaryConditionIR::PeriodicSpin => {
                return Err(run_error(
                    "native_m1_v1 does not support periodic spin boundaries; fallback is forbidden",
                ));
            }
        };
    }
    if boundaries
        .iter()
        .any(|boundary| boundary.kind == ffi::FULLMAG_FDM_CPU_SPIN_BC_UNSET)
    {
        return Err(run_error("native spin boundary coverage is incomplete"));
    }
    let request = ffi::fullmag_fdm_cpu_steady_spin_request_v1 {
        abi_version: ffi::FULLMAG_FDM_CPU_TRANSPORT_ABI_V1,
        struct_size: size_of::<ffi::fullmag_fdm_cpu_steady_spin_request_v1>() as u32,
        reserved_flags: 0,
        grid: ffi::fullmag_fdm_cpu_transport_grid_v1 {
            nx: u64_len(grid.nx, "grid nx")?,
            ny: u64_len(grid.ny, "grid ny")?,
            nz: u64_len(grid.nz, "grid nz")?,
            dx_m: cell_size.dx,
            dy_m: cell_size.dy,
            dz_m: cell_size.dz,
        },
        device: ffi::FULLMAG_FDM_CPU_TRANSPORT_DEVICE_CPU,
        precision: ffi::FULLMAG_FDM_CPU_TRANSPORT_PRECISION_F64,
        spin_conductivity_s_per_m: descriptor.spin_conductivity_spm.as_ptr(),
        spin_conductivity_len: u64_len(
            descriptor.spin_conductivity_spm.len(),
            "spin conductivity length",
        )?,
        polarization: descriptor.polarization_p.as_ptr(),
        polarization_len: u64_len(descriptor.polarization_p.len(), "polarization length")?,
        spin_hall_angle: descriptor.theta_sh.as_ptr(),
        spin_hall_angle_len: u64_len(descriptor.theta_sh.len(), "spin Hall angle length")?,
        magnetization_xyz: magnetization_xyz.as_ptr(),
        magnetization_xyz_len: u64_len(magnetization_xyz.len(), "magnetization vector length")?,
        reactions: reactions.as_ptr(),
        reaction_count: u64_len(reactions.len(), "reaction count")?,
        active_cells: spin_active.as_ptr(),
        active_cells_len: u64_len(spin_active.len(), "spin active mask length")?,
        region_ids: descriptor.region_ids.as_ptr(),
        region_id_count: u64_len(descriptor.region_ids.len(), "region id count")?,
        boundaries,
        interfaces: interfaces.as_ptr(),
        interface_count: u64_len(interfaces.len(), "spin interface count")?,
        torque_target_cells: torque_targets.as_ptr(),
        torque_target_cells_len: u64_len(torque_targets.len(), "torque target length")?,
        saturation_magnetization_a_per_m: descriptor.saturation_magnetization_apm.as_ptr(),
        saturation_magnetization_len: u64_len(
            descriptor.saturation_magnetization_apm.len(),
            "saturation magnetization length",
        )?,
        gamma_e_rad_per_s_t: descriptor.gamma_e_rad_per_s_t,
        relative_tolerance: descriptor.spin_solver.linear.relative_tolerance,
        absolute_tolerance_a: descriptor.spin_solver.linear.absolute_tolerance,
        local_relative_tolerance: descriptor.spin_solver.linear.relative_tolerance,
        local_absolute_tolerance_a_per_m3: 1.0e-6,
        max_iterations: u64::from(descriptor.spin_solver.linear.max_iterations),
        gmres_restart: 40,
        api_version: fixed_text(SPIN_API)?,
        formula_version: fixed_text(SPIN_FORMULA)?,
        operator_version: fixed_text(SPIN_OPERATOR)?,
        electric_reconstruction_version: fixed_text(ELECTRIC_RECONSTRUCTION)?,
        solver_version: fixed_text(SPIN_SOLVER)?,
        residual_version: fixed_text(SPIN_RESIDUAL)?,
        local_residual_version: fixed_text(SPIN_LOCAL_RESIDUAL)?,
        interface_version: fixed_text(INTERFACE_VERSION)?,
        torque_operator_version: fixed_text(TORQUE_OPERATOR)?,
    };
    let mut spin_potential = vec![0.0; lengths.cell_xyz];
    let mut qx = vec![0.0; lengths.x_face_xyz];
    let mut qy = vec![0.0; lengths.y_face_xyz];
    let mut qz = vec![0.0; lengths.z_face_xyz];
    let mut qcell = vec![0.0; lengths.cell_tensor];
    let mut reaction_spin_flip = vec![0.0; lengths.cell_xyz];
    let mut reaction_exchange = vec![0.0; lengths.cell_xyz];
    let mut reaction_dephasing = vec![0.0; lengths.cell_xyz];
    let mut reaction_total = vec![0.0; lengths.cell_xyz];
    let mut torque = vec![0.0; lengths.cell_xyz];
    let mut interface_observations = vec![
        // SAFETY: all-zero is valid for this plain C observation record.
        unsafe { zeroed::<ffi::fullmag_fdm_cpu_spin_interface_observation_v1>() };
        interfaces.len()
    ];
    // SAFETY: all-zero is valid for this plain C result before buffers are installed.
    let mut raw = unsafe { zeroed::<ffi::fullmag_fdm_cpu_steady_spin_result_v1>() };
    raw.abi_version = ffi::FULLMAG_FDM_CPU_TRANSPORT_ABI_V1;
    raw.struct_size = size_of::<ffi::fullmag_fdm_cpu_steady_spin_result_v1>() as u32;
    raw.spin_potential_xyz_v = f64_buffer(&mut spin_potential)?;
    raw.q_x_xyz_a_per_m2 = f64_buffer(&mut qx)?;
    raw.q_y_xyz_a_per_m2 = f64_buffer(&mut qy)?;
    raw.q_z_xyz_a_per_m2 = f64_buffer(&mut qz)?;
    raw.q_cell_ia_a_per_m2 = f64_buffer(&mut qcell)?;
    raw.reaction_spin_flip_xyz_a_per_m3 = f64_buffer(&mut reaction_spin_flip)?;
    raw.reaction_exchange_xyz_a_per_m3 = f64_buffer(&mut reaction_exchange)?;
    raw.reaction_dephasing_xyz_a_per_m3 = f64_buffer(&mut reaction_dephasing)?;
    raw.reaction_total_xyz_a_per_m3 = f64_buffer(&mut reaction_total)?;
    raw.transport_torque_xyz_per_s = f64_buffer(&mut torque)?;
    raw.interface_observations = ffi::fullmag_fdm_cpu_spin_interface_observation_buffer_v1 {
        data: interface_observations.as_mut_ptr(),
        capacity: u64_len(interface_observations.len(), "spin observation capacity")?,
        length: 0,
    };
    // SAFETY: all request inputs, charge ownership, and caller-owned outputs live through the call.
    let status =
        unsafe { ffi::fullmag_fdm_cpu_steady_spin_solve_v1(&request, &charge.raw, &mut raw) };
    if status != ffi::FULLMAG_FDM_CPU_TRANSPORT_OK {
        return Err(run_error(format!(
            "native M1 spin solve failed ({status}): {}",
            error_message(&raw.error_message)
        )));
    }
    validate_spin_result(
        &raw,
        &spin_potential,
        &qx,
        &qy,
        &qz,
        &qcell,
        &reaction_spin_flip,
        &reaction_exchange,
        &reaction_dephasing,
        &reaction_total,
        &torque,
        &interface_observations,
        &interfaces,
    )?;
    let current_density_apm2 = charge
        .current_cell_xyz
        .chunks_exact(3)
        .map(|value| [value[0], value[1], value[2]])
        .collect::<Vec<_>>();
    let spin_potential_volts = spin_potential
        .chunks_exact(3)
        .map(|value| [value[0], value[1], value[2]])
        .collect::<Vec<_>>();
    let spin_current_tensor_apm2 = qcell
        .chunks_exact(9)
        .map(|value| {
            [
                value[0], value[1], value[2], value[3], value[4], value[5], value[6], value[7],
                value[8],
            ]
        })
        .collect::<Vec<_>>();
    let transport_torque_per_s = torque
        .chunks_exact(3)
        .map(|value| [value[0], value[1], value[2]])
        .collect::<Vec<_>>();
    let charge_interface_observations = charge
        .interface_observations
        .iter()
        .map(|observation| {
            let interface = unique_descriptor_interface(
                descriptor,
                observation.interface_id,
                observation.axis,
                observation.negative_cell,
                observation.positive_cell,
                observation.from_cell,
                observation.to_cell,
            )?;
            Ok(FdmChargeInterfaceSnapshot {
                source_id: interface.source_id.clone(),
                stable_interface_id: observation.interface_id,
                axis: u8::try_from(observation.axis)
                    .map_err(|_| run_error("native charge interface axis exceeds u8"))?,
                negative_cell: observation.negative_cell,
                positive_cell: observation.positive_cell,
                from_cell: observation.from_cell,
                to_cell: observation.to_cell,
                potential_unit: "V".into(),
                current_density_unit: "A/m^2".into(),
                orientation: "from_cell_to_to_cell_and_positive_coordinate_axis".into(),
                g_up_spm2: observation.g_up_s_per_m2,
                g_down_spm2: observation.g_down_s_per_m2,
                from_potential_trace_v: observation.from_potential_trace_v,
                to_potential_trace_v: observation.to_potential_trace_v,
                delta_potential_trace_v: observation.delta_potential_trace_v,
                from_to_current_density_apm2: observation.from_to_current_density_a_per_m2,
                global_face_current_density_apm2: observation.global_face_current_density_a_per_m2,
            })
        })
        .collect::<Result<Vec<_>, RunError>>()?;
    let reaction_vectors = |values: &[f64]| {
        values
            .chunks_exact(3)
            .map(|value| [value[0], value[1], value[2]])
            .collect::<Vec<_>>()
    };
    let spin_reaction_channels = FdmSpinReactionChannelsSnapshot {
        unit: "A/m^3".into(),
        component_order: "spin_xyz".into(),
        spin_flip_apm3: reaction_vectors(&reaction_spin_flip),
        exchange_apm3: reaction_vectors(&reaction_exchange),
        dephasing_apm3: reaction_vectors(&reaction_dephasing),
        total_apm3: reaction_vectors(&reaction_total),
    };
    let interface_fluxes = interface_observations
        .iter()
        .map(|observation| {
            let interface = unique_descriptor_interface(
                descriptor,
                observation.interface_id,
                observation.axis,
                observation.negative_cell,
                observation.positive_cell,
                observation.from_cell,
                observation.to_cell,
            )?;
            Ok(FdmSpinInterfaceFluxSnapshot {
                stable_interface_id: observation.interface_id,
                source_id: interface.source_id.clone(),
                axis: u8::try_from(observation.axis)
                    .map_err(|_| run_error("native interface axis exceeds u8"))?,
                negative_cell: observation.negative_cell,
                positive_cell: observation.positive_cell,
                from_cell: observation.from_cell,
                to_cell: observation.to_cell,
                current_density_unit: "A/m^2".into(),
                orientation: "positive_coordinate_axis".into(),
                incoming_longitudinal_apm2: observation.incoming_longitudinal_a_per_m2,
                backflow_longitudinal_apm2: observation.backflow_longitudinal_a_per_m2,
                absorbed_transverse_apm2: observation.absorbed_transverse_a_per_m2,
                spin_memory_loss_apm2: [0.0; 3],
                sml_reservoir: None,
                negative_cell_flux_positive_axis_apm2: observation
                    .negative_cell_flux_positive_axis_a_per_m2,
                positive_cell_flux_positive_axis_apm2: observation
                    .positive_cell_flux_positive_axis_a_per_m2,
                from_side_outgoing_apm2: observation.from_side_outgoing_a_per_m2,
                to_side_transmitted_apm2: observation.to_side_transmitted_a_per_m2,
            })
        })
        .collect::<Result<Vec<_>, RunError>>()?;
    let (oersted_field_apm, oersted_closure_provenance) = if descriptor.oersted_source_bound {
        let closure = descriptor.structured_current_closure.as_ref().ok_or_else(|| {
            missing_public_fdm_closure_error(
                grid,
                cell_size,
                descriptor,
                &charge,
                multiplier,
                state_revision,
                stage_time_s,
            )
        })?;
        let solved = solve_public_oersted(
            grid,
            cell_size,
            descriptor,
            closure,
            &resolved.current_source_id,
            &charge,
            multiplier,
            state_revision,
            stage_time_s,
        )?;
        (Some(solved.field_apm), Some(solved.provenance))
    } else {
        (None, None)
    };
    let initial = raw.initial_rhs_integrated_l2_a;
    let final_residual = raw.recomputed_balance_integrated_l2_a;
    let scaled = if initial > 0.0 {
        final_residual / initial
    } else {
        final_residual
    };
    Ok(FdmSpinTransportModuleSnapshot {
        module_id: resolved.module_id.clone(),
        current_source_id: resolved.current_source_id.clone(),
        runtime_owner: RUNTIME_OWNER.into(),
        transport_realization: "native_m1_v1".into(),
        fallback_used: false,
        potential_volts: charge.potential.clone(),
        current_density_apm2,
        charge_face_current: Some(FdmChargeFaceCurrentSnapshot {
            unit: "A/m^2".into(),
            orientation: "positive_coordinate_axis".into(),
            x_apm2: charge.current_x.clone(),
            y_apm2: charge.current_y.clone(),
            z_apm2: charge.current_z.clone(),
        }),
        charge_interface_observations,
        spin_potential_volts,
        spin_current_tensor_apm2,
        spin_face_current: Some(FdmSpinFaceCurrentSnapshot {
            unit: "A/m^2".into(),
            component_order: "spin_xyz".into(),
            orientation: "positive_coordinate_axis".into(),
            x_apm2: qx
                .chunks_exact(3)
                .map(|value| [value[0], value[1], value[2]])
                .collect(),
            y_apm2: qy
                .chunks_exact(3)
                .map(|value| [value[0], value[1], value[2]])
                .collect(),
            z_apm2: qz
                .chunks_exact(3)
                .map(|value| [value[0], value[1], value[2]])
                .collect(),
        }),
        spin_reaction_channels: Some(spin_reaction_channels),
        interface_fluxes,
        transport_torque_per_s,
        oersted_field_apm,
        oersted_closure_provenance,
        telemetry: FdmSpinTransportTelemetry {
            charge_iterations: charge.raw.iterations as usize,
            charge_residual_l2: charge.raw.recomputed_algebraic_residual_l2_a_per_m3,
            charge_net_boundary_current_a: charge.raw.net_boundary_current_a,
            charge_max_abs_divergence_a_per_m3: charge.raw.max_abs_divergence_a_per_m3,
            spin_iterations: raw.iterations as usize,
            spin_initial_residual_l2: initial,
            spin_final_residual_l2: final_residual,
            spin_scaled_residual: scaled,
            spin_relative_balance_closure: raw.relative_global_balance,
            convergence_reason: read_text(&raw.convergence_reason)?,
            preconditioner: "native_block_jacobi_local_reaction_inverse_v1".into(),
            nonlinear_iterations: None,
            coupled_linear_iterations: None,
            preconditioner_applications: None,
            scaled_charge_residual: None,
            relative_charge_current_update: None,
            relative_spin_potential_update: None,
            transport_outer_error_ratio: None,
            charge_balance_relative: None,
            spin_balance_relative: None,
            warm_start_used: None,
        },
        constitutive_version: resolved.constitutive_version.clone(),
        charge_operator_version: read_text(&charge.raw.operator_version)?,
        spin_operator_version: read_text(&raw.operator_version)?,
        torque_formula_version: descriptor.torque_formula_version.clone(),
        evaluated_envelope_multiplier: multiplier,
        state_revision,
        operator_revision: charge.raw.accepted_snapshot_identity,
    })
}

#[cfg(test)]
mod overflow_tests {
    use super::*;

    struct ChargeValidatorFixture {
        raw: ffi::fullmag_fdm_cpu_charge_result_v1,
        potential: Vec<f64>,
        current_x: Vec<f64>,
        current_y: Vec<f64>,
        current_z: Vec<f64>,
        current_cell: Vec<f64>,
        observations: Vec<ffi::fullmag_fdm_cpu_charge_interface_observation_v1>,
        interfaces: Vec<ffi::fullmag_fdm_cpu_transport_interface_v1>,
    }

    impl ChargeValidatorFixture {
        fn new() -> Self {
            let interface = ffi::fullmag_fdm_cpu_transport_interface_v1 {
                interface_id: 11,
                axis: 0,
                kind: ffi::FULLMAG_FDM_CPU_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2,
                negative_cell: 0,
                positive_cell: 1,
                from_cell: 0,
                to_cell: 1,
                g_up_s_per_m2: 2.0,
                g_down_s_per_m2: 3.0,
                g_r_s_per_m2: 4.0,
                g_i_s_per_m2: 5.0,
                magnetization: [0.0, 0.0, 1.0],
            };
            let observation = ffi::fullmag_fdm_cpu_charge_interface_observation_v1 {
                interface_id: 11,
                axis: 0,
                reserved: 0,
                negative_cell: 0,
                positive_cell: 1,
                from_cell: 0,
                to_cell: 1,
                g_up_s_per_m2: 2.0,
                g_down_s_per_m2: 3.0,
                from_potential_trace_v: 0.5,
                to_potential_trace_v: 0.25,
                delta_potential_trace_v: 0.25,
                from_to_current_density_a_per_m2: 0.75,
                global_face_current_density_a_per_m2: 0.75,
            };
            let mut fixture = Self {
                raw: unsafe { std::mem::zeroed() },
                potential: vec![1.0],
                current_x: vec![2.0],
                current_y: vec![3.0],
                current_z: vec![4.0],
                current_cell: vec![5.0],
                observations: vec![observation],
                interfaces: vec![interface],
            };
            fixture.raw.abi_version = ffi::FULLMAG_FDM_CPU_TRANSPORT_ABI_V1;
            fixture.raw.struct_size = size_of::<ffi::fullmag_fdm_cpu_charge_result_v1>() as u32;
            fixture.raw.status = ffi::FULLMAG_FDM_CPU_TRANSPORT_OK;
            fixture.raw.potential_v = exact_buffer(&mut fixture.potential);
            fixture.raw.jc_x_a_per_m2 = exact_buffer(&mut fixture.current_x);
            fixture.raw.jc_y_a_per_m2 = exact_buffer(&mut fixture.current_y);
            fixture.raw.jc_z_a_per_m2 = exact_buffer(&mut fixture.current_z);
            fixture.raw.jc_cell_xyz_a_per_m2 = exact_buffer(&mut fixture.current_cell);
            fixture.raw.interface_observations =
                ffi::fullmag_fdm_cpu_charge_interface_observation_buffer_v1 {
                    data: fixture.observations.as_mut_ptr(),
                    capacity: 1,
                    length: 1,
                };
            fixture.raw.accepted_snapshot_identity = 7;
            fixture.raw.accepted_snapshot = 1_usize as *mut _;
            fixture.raw.api_version = fixed_text(CHARGE_API).expect("charge API");
            fixture.raw.operator_version = fixed_text(CHARGE_OPERATOR).expect("charge operator");
            fixture.raw.interface_operator_version =
                fixed_text(CHARGE_INTERFACE_OPERATOR).expect("charge interface operator");
            fixture.raw.solver_version = fixed_text(CHARGE_SOLVER).expect("charge solver");
            fixture.raw.residual_version = fixed_text(CHARGE_RESIDUAL).expect("charge residual");
            fixture.raw.runtime_owner = fixed_text(RUNTIME_OWNER).expect("runtime owner");
            fixture
        }

        fn validate(&self) -> Result<(), RunError> {
            validate_charge_result(
                &self.raw,
                &self.potential,
                &self.current_x,
                &self.current_y,
                &self.current_z,
                &self.current_cell,
                &self.observations,
                &self.interfaces,
                CHARGE_OPERATOR,
            )
        }
    }

    struct SpinValidatorFixture {
        raw: ffi::fullmag_fdm_cpu_steady_spin_result_v1,
        channels: [Vec<f64>; 10],
        observations: Vec<ffi::fullmag_fdm_cpu_spin_interface_observation_v1>,
        interfaces: Vec<ffi::fullmag_fdm_cpu_transport_interface_v1>,
    }

    impl SpinValidatorFixture {
        fn new() -> Self {
            let interface = ChargeValidatorFixture::new().interfaces[0];
            let observation = ffi::fullmag_fdm_cpu_spin_interface_observation_v1 {
                interface_id: 11,
                axis: 0,
                reserved: 0,
                negative_cell: 0,
                positive_cell: 1,
                from_cell: 0,
                to_cell: 1,
                incoming_longitudinal_a_per_m2: [1.0; 3],
                backflow_longitudinal_a_per_m2: [2.0; 3],
                absorbed_transverse_a_per_m2: [3.0; 3],
                negative_cell_flux_positive_axis_a_per_m2: [4.0; 3],
                positive_cell_flux_positive_axis_a_per_m2: [5.0; 3],
                from_side_outgoing_a_per_m2: [6.0; 3],
                to_side_transmitted_a_per_m2: [7.0; 3],
            };
            let mut fixture = Self {
                raw: unsafe { std::mem::zeroed() },
                channels: std::array::from_fn(|index| {
                    if index == 8 {
                        vec![6.0]
                    } else if index >= 5 {
                        vec![(index - 4) as f64]
                    } else {
                        vec![index as f64 + 1.0]
                    }
                }),
                observations: vec![observation],
                interfaces: vec![interface],
            };
            fixture.raw.abi_version = ffi::FULLMAG_FDM_CPU_TRANSPORT_ABI_V1;
            fixture.raw.struct_size =
                size_of::<ffi::fullmag_fdm_cpu_steady_spin_result_v1>() as u32;
            fixture.raw.status = ffi::FULLMAG_FDM_CPU_TRANSPORT_OK;
            fixture.raw.spin_potential_xyz_v = exact_buffer(&mut fixture.channels[0]);
            fixture.raw.q_x_xyz_a_per_m2 = exact_buffer(&mut fixture.channels[1]);
            fixture.raw.q_y_xyz_a_per_m2 = exact_buffer(&mut fixture.channels[2]);
            fixture.raw.q_z_xyz_a_per_m2 = exact_buffer(&mut fixture.channels[3]);
            fixture.raw.q_cell_ia_a_per_m2 = exact_buffer(&mut fixture.channels[4]);
            fixture.raw.reaction_spin_flip_xyz_a_per_m3 = exact_buffer(&mut fixture.channels[5]);
            fixture.raw.reaction_exchange_xyz_a_per_m3 = exact_buffer(&mut fixture.channels[6]);
            fixture.raw.reaction_dephasing_xyz_a_per_m3 = exact_buffer(&mut fixture.channels[7]);
            fixture.raw.reaction_total_xyz_a_per_m3 = exact_buffer(&mut fixture.channels[8]);
            fixture.raw.transport_torque_xyz_per_s = exact_buffer(&mut fixture.channels[9]);
            fixture.raw.interface_observations =
                ffi::fullmag_fdm_cpu_spin_interface_observation_buffer_v1 {
                    data: fixture.observations.as_mut_ptr(),
                    capacity: 1,
                    length: 1,
                };
            fixture.raw.gmres_restart = 40;
            fixture.raw.api_version = fixed_text(SPIN_API).expect("spin API");
            fixture.raw.formula_version = fixed_text(SPIN_FORMULA).expect("spin formula");
            fixture.raw.operator_version = fixed_text(SPIN_OPERATOR).expect("spin operator");
            fixture.raw.electric_reconstruction_version =
                fixed_text(ELECTRIC_RECONSTRUCTION).expect("electric reconstruction");
            fixture.raw.solver_version = fixed_text(SPIN_SOLVER).expect("spin solver");
            fixture.raw.residual_version = fixed_text(SPIN_RESIDUAL).expect("spin residual");
            fixture.raw.local_residual_version =
                fixed_text(SPIN_LOCAL_RESIDUAL).expect("local residual");
            fixture.raw.interface_version = fixed_text(INTERFACE_VERSION).expect("interface");
            fixture.raw.torque_operator_version =
                fixed_text(TORQUE_OPERATOR).expect("torque operator");
            fixture.raw.runtime_owner = fixed_text(RUNTIME_OWNER).expect("runtime owner");
            fixture.raw.convergence_reason =
                fixed_text(CONVERGENCE_REASON).expect("convergence reason");
            fixture
        }

        fn validate(&self) -> Result<(), RunError> {
            validate_spin_result(
                &self.raw,
                &self.channels[0],
                &self.channels[1],
                &self.channels[2],
                &self.channels[3],
                &self.channels[4],
                &self.channels[5],
                &self.channels[6],
                &self.channels[7],
                &self.channels[8],
                &self.channels[9],
                &self.observations,
                &self.interfaces,
            )
        }
    }

    fn exact_buffer(values: &mut Vec<f64>) -> ffi::fullmag_fdm_cpu_f64_buffer_v1 {
        ffi::fullmag_fdm_cpu_f64_buffer_v1 {
            data: values.as_mut_ptr(),
            capacity: values.len() as u64,
            length: values.len() as u64,
        }
    }

    #[test]
    fn native_m1_v1_charge_validator_rejects_every_owned_result_contract_mutation() {
        ChargeValidatorFixture::new()
            .validate()
            .expect("controlled charge result must be valid");
        macro_rules! reject {
            ($body:expr, $label:literal) => {{
                let mut fixture = ChargeValidatorFixture::new();
                $body(&mut fixture);
                assert!(fixture.validate().is_err(), $label);
            }};
        }
        reject!(
            |f: &mut ChargeValidatorFixture| f.raw.abi_version = 0,
            "ABI"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.raw.struct_size = 0,
            "size"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.raw.reserved_flags = 1,
            "reserved flags"
        );
        reject!(|f: &mut ChargeValidatorFixture| f.raw.status = -1, "status");
        reject!(
            |f: &mut ChargeValidatorFixture| f.raw.reserved0 = 1,
            "reserved0"
        );

        macro_rules! reject_buffer {
            ($field:ident, $values:ident) => {{
                reject!(
                    |f: &mut ChargeValidatorFixture| f.raw.$field.data = std::ptr::null_mut(),
                    "buffer pointer"
                );
                reject!(
                    |f: &mut ChargeValidatorFixture| f.raw.$field.capacity = 0,
                    "buffer capacity"
                );
                reject!(
                    |f: &mut ChargeValidatorFixture| f.raw.$field.length = 0,
                    "buffer length"
                );
                reject!(
                    |f: &mut ChargeValidatorFixture| f.$values[0] = f64::NAN,
                    "buffer NaN"
                );
            }};
        }
        reject_buffer!(potential_v, potential);
        reject_buffer!(jc_x_a_per_m2, current_x);
        reject_buffer!(jc_y_a_per_m2, current_y);
        reject_buffer!(jc_z_a_per_m2, current_z);
        reject_buffer!(jc_cell_xyz_a_per_m2, current_cell);
        reject!(
            |f: &mut ChargeValidatorFixture| f.raw.interface_observations.data =
                std::ptr::null_mut(),
            "observation pointer"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.raw.interface_observations.capacity = 0,
            "observation capacity"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.raw.interface_observations.length = 0,
            "observation length"
        );

        reject!(
            |f: &mut ChargeValidatorFixture| f.observations[0].interface_id = 0,
            "observation id"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.observations[0].axis = 3,
            "observation axis"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.observations[0].reserved = 1,
            "observation reserved"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.observations[0].negative_cell = 9,
            "negative cell"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.observations[0].positive_cell = 9,
            "positive cell"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.observations[0].from_cell = 9,
            "from cell"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.observations[0].to_cell = 9,
            "to cell"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.observations[0].g_up_s_per_m2 = 9.0,
            "G up"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.observations[0].g_down_s_per_m2 = 9.0,
            "G down"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.observations[0].from_potential_trace_v = f64::NAN,
            "from trace"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.observations[0].to_potential_trace_v = f64::NAN,
            "to trace"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.observations[0].delta_potential_trace_v = f64::NAN,
            "delta trace"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.observations[0].from_to_current_density_a_per_m2 =
                f64::NAN,
            "from-to Jc"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.observations[0]
                .global_face_current_density_a_per_m2 = f64::NAN,
            "global Jc"
        );

        reject!(
            |f: &mut ChargeValidatorFixture| f.raw.api_version = fixed_text("bad").unwrap(),
            "API version"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.raw.operator_version = fixed_text("bad").unwrap(),
            "operator version"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.raw.interface_operator_version =
                fixed_text("bad").unwrap(),
            "interface version"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.raw.solver_version = fixed_text("bad").unwrap(),
            "solver version"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.raw.residual_version = fixed_text("bad").unwrap(),
            "residual version"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.raw.runtime_owner = fixed_text("bad").unwrap(),
            "runtime owner"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.raw.accepted_snapshot = std::ptr::null_mut(),
            "snapshot pointer"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.raw.accepted_snapshot_identity = 0,
            "snapshot identity"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.raw.algebraic_residual_l2_a_per_m3 = f64::NAN,
            "algebraic residual"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.raw.recomputed_algebraic_residual_l2_a_per_m3 =
                f64::NAN,
            "recomputed residual"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.raw.physical_balance_integrated_l2_a = f64::NAN,
            "physical balance"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.raw.max_cell_current_imbalance_a = f64::NAN,
            "cell imbalance"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.raw.max_abs_divergence_a_per_m3 = f64::NAN,
            "divergence"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.raw.boundary_outward_current_a[5] = f64::NAN,
            "boundary diagnostic"
        );
        reject!(
            |f: &mut ChargeValidatorFixture| f.raw.net_boundary_current_a = f64::NAN,
            "net boundary diagnostic"
        );
    }

    #[test]
    fn native_m1_v1_spin_validator_rejects_every_owned_result_contract_mutation() {
        SpinValidatorFixture::new()
            .validate()
            .expect("controlled spin result must be valid");
        macro_rules! reject {
            ($body:expr, $label:literal) => {{
                let mut fixture = SpinValidatorFixture::new();
                $body(&mut fixture);
                assert!(fixture.validate().is_err(), $label);
            }};
        }
        reject!(|f: &mut SpinValidatorFixture| f.raw.abi_version = 0, "ABI");
        reject!(|f: &mut SpinValidatorFixture| f.raw.struct_size = 0, "size");
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.reserved_flags = 1,
            "reserved flags"
        );
        reject!(|f: &mut SpinValidatorFixture| f.raw.status = -1, "status");
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.reserved0 = 1,
            "reserved0"
        );
        macro_rules! reject_buffer {
            ($field:ident, $index:literal) => {{
                reject!(
                    |f: &mut SpinValidatorFixture| f.raw.$field.data = std::ptr::null_mut(),
                    "buffer pointer"
                );
                reject!(
                    |f: &mut SpinValidatorFixture| f.raw.$field.capacity = 0,
                    "buffer capacity"
                );
                reject!(
                    |f: &mut SpinValidatorFixture| f.raw.$field.length = 0,
                    "buffer length"
                );
                reject!(
                    |f: &mut SpinValidatorFixture| f.channels[$index][0] = f64::NAN,
                    "buffer NaN"
                );
            }};
        }
        reject_buffer!(spin_potential_xyz_v, 0);
        reject_buffer!(q_x_xyz_a_per_m2, 1);
        reject_buffer!(q_y_xyz_a_per_m2, 2);
        reject_buffer!(q_z_xyz_a_per_m2, 3);
        reject_buffer!(q_cell_ia_a_per_m2, 4);
        reject_buffer!(reaction_spin_flip_xyz_a_per_m3, 5);
        reject_buffer!(reaction_exchange_xyz_a_per_m3, 6);
        reject_buffer!(reaction_dephasing_xyz_a_per_m3, 7);
        reject_buffer!(reaction_total_xyz_a_per_m3, 8);
        reject_buffer!(transport_torque_xyz_per_s, 9);
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.interface_observations.data = std::ptr::null_mut(),
            "observation pointer"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.interface_observations.capacity = 0,
            "observation capacity"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.interface_observations.length = 0,
            "observation length"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.observations[0].interface_id = 0,
            "observation id"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.observations[0].axis = 3,
            "observation axis"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.observations[0].reserved = 1,
            "observation reserved"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.observations[0].negative_cell = 9,
            "negative cell"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.observations[0].positive_cell = 9,
            "positive cell"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.observations[0].from_cell = 9,
            "from cell"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.observations[0].to_cell = 9,
            "to cell"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.observations[0].incoming_longitudinal_a_per_m2[0] =
                f64::NAN,
            "incoming payload"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.observations[0].backflow_longitudinal_a_per_m2[0] =
                f64::NAN,
            "backflow payload"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.observations[0].absorbed_transverse_a_per_m2[0] =
                f64::NAN,
            "transverse payload"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.observations[0]
                .negative_cell_flux_positive_axis_a_per_m2[0] =
                f64::NAN,
            "negative flux"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.observations[0]
                .positive_cell_flux_positive_axis_a_per_m2[0] =
                f64::NAN,
            "positive flux"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.observations[0].from_side_outgoing_a_per_m2[0] =
                f64::NAN,
            "from flux"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.observations[0].to_side_transmitted_a_per_m2[0] =
                f64::NAN,
            "to flux"
        );

        reject!(
            |f: &mut SpinValidatorFixture| f.raw.api_version = fixed_text("bad").unwrap(),
            "API version"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.formula_version = fixed_text("bad").unwrap(),
            "formula version"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.operator_version = fixed_text("bad").unwrap(),
            "operator version"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.electric_reconstruction_version =
                fixed_text("bad").unwrap(),
            "electric version"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.solver_version = fixed_text("bad").unwrap(),
            "solver version"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.residual_version = fixed_text("bad").unwrap(),
            "residual version"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.local_residual_version =
                fixed_text("bad").unwrap(),
            "local residual version"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.interface_version = fixed_text("bad").unwrap(),
            "interface version"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.torque_operator_version =
                fixed_text("bad").unwrap(),
            "torque version"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.runtime_owner = fixed_text("bad").unwrap(),
            "runtime owner"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.convergence_reason = fixed_text("bad").unwrap(),
            "convergence reason"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.gmres_restart = 39,
            "GMRES restart"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.initial_rhs_integrated_l2_a = f64::NAN,
            "initial residual"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.recursive_residual_integrated_l2_a = f64::NAN,
            "recursive residual"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.recomputed_balance_integrated_l2_a = f64::NAN,
            "recomputed balance"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.balance_tolerance_integrated_l2_a = f64::NAN,
            "balance tolerance"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.relative_global_balance = f64::NAN,
            "relative balance"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.max_abs_residual_a_per_m3 = f64::NAN,
            "max residual"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.boundary_outward_current_a[17] = f64::NAN,
            "boundary diagnostic"
        );
        reject!(
            |f: &mut SpinValidatorFixture| f.raw.global_balance_closure_a[2] = f64::NAN,
            "closure diagnostic"
        );
    }

    #[test]
    fn native_m1_v1_checked_lengths_reject_component_overflow_without_allocation() {
        let error = native_buffer_lengths(usize::MAX / 3 + 1, 1, 1)
            .expect_err("cell and face component products must be checked");
        assert!(error.message.contains("vector length"));
        assert!(error.message.contains("overflows usize"));
    }

    #[test]
    fn native_m1_v1_checked_lengths_reject_face_dimension_overflow_without_allocation() {
        let error = native_buffer_lengths(usize::MAX, 1, 1)
            .expect_err("face dimension increment must be checked");
        assert!(error.message.contains("x face dimension overflows usize"));
    }

    #[test]
    fn native_m1_v1_adapter_rejects_each_output_channel_pointer_capacity_length_and_nan() {
        let channels = [
            "charge potential",
            "charge x-face Jc",
            "charge y-face Jc",
            "charge z-face Jc",
            "charge cell-centered Jc",
            "spin potential",
            "spin x-face Q",
            "spin y-face Q",
            "spin z-face Q",
            "spin cell-centered Q",
            "spin-flip reaction",
            "exchange reaction",
            "dephasing reaction",
            "total reaction",
            "transport torque",
        ];
        for channel in channels {
            let mut values = vec![1.0];
            let mut raw = f64_buffer(&mut values).expect("synthetic buffer");
            raw.length = raw.capacity;
            validate_f64_buffer(channel, &raw, &values).expect("baseline buffer contract");

            raw.length = 0;
            assert!(
                validate_f64_buffer(channel, &raw, &values).is_err(),
                "{channel} length"
            );
            raw.length = 1;
            raw.capacity = 0;
            assert!(
                validate_f64_buffer(channel, &raw, &values).is_err(),
                "{channel} capacity"
            );
            raw.capacity = 1;
            let expected_pointer = raw.data;
            raw.data = std::ptr::null_mut();
            assert!(
                validate_f64_buffer(channel, &raw, &values).is_err(),
                "{channel} pointer"
            );
            raw.data = expected_pointer;
            values[0] = f64::NAN;
            assert!(
                validate_f64_buffer(channel, &raw, &values).is_err(),
                "{channel} NaN"
            );
        }
        for channel in ["charge observations", "spin observations"] {
            let values = vec![0_u8];
            let pointer = values.as_ptr().cast_mut();
            validate_record_buffer(channel, pointer, 1, 1, &values)
                .expect("baseline observation buffer");
            assert!(validate_record_buffer(channel, std::ptr::null_mut(), 1, 1, &values).is_err());
            assert!(validate_record_buffer(channel, pointer, 0, 1, &values).is_err());
            assert!(validate_record_buffer(channel, pointer, 1, 0, &values).is_err());
        }
    }

    #[test]
    fn native_m1_v1_adapter_rejects_each_charge_spin_and_observation_version_mutation() {
        let versions = [
            ("charge API", CHARGE_API),
            ("charge operator", CHARGE_OPERATOR),
            ("charge interface", CHARGE_INTERFACE_OPERATOR),
            ("charge solver", CHARGE_SOLVER),
            ("charge residual", CHARGE_RESIDUAL),
            ("spin API", SPIN_API),
            ("spin formula", SPIN_FORMULA),
            ("spin operator", SPIN_OPERATOR),
            ("electric reconstruction", ELECTRIC_RECONSTRUCTION),
            ("spin solver", SPIN_SOLVER),
            ("spin residual", SPIN_RESIDUAL),
            ("spin local residual", SPIN_LOCAL_RESIDUAL),
            ("interface", INTERFACE_VERSION),
            ("torque", TORQUE_OPERATOR),
            ("runtime owner", RUNTIME_OWNER),
            ("convergence", CONVERGENCE_REASON),
        ];
        for (label, expected) in versions {
            let baseline = fixed_text(expected).expect("baseline version");
            validate_version_text(label, &baseline, expected).expect("baseline version contract");
            let mutated = fixed_text("mutated.invalid.v0").expect("mutated version");
            assert!(
                validate_version_text(label, &mutated, expected).is_err(),
                "{label} mutation"
            );
        }
    }
}
