use crate::types::RunError;
use fullmag_fem_sys as ffi;
use fullmag_ir::MeshIR;
use serde_json::Value;
use std::ffi::{CStr, CString};
use std::ptr;

const CONSTITUTIVE_VERSION: &str = "transport_constitutive.one_way.fullmag.v1";
const OPERATOR_VERSION: &str = "fem_charge_spin_conforming_h1_p1.transparent.v1";
const PHYSICAL_RESIDUAL_VERSION: &str = "transport_balance_integrated_l2.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeFemSteadyTransportExecution {
    CpuDouble,
    GpuDouble,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeFemSteadyTransportInterface {
    TransparentConformingH1,
    MixingBrokenH1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeFemSteadyTransportGauge {
    BoundaryReference,
    ZeroMeanPotential,
}

#[derive(Debug, Clone)]
pub(crate) struct NativeFemSteadyTransportRequest {
    pub mesh: MeshIR,
    pub execution: NativeFemSteadyTransportExecution,
    pub interface: NativeFemSteadyTransportInterface,
    pub gauge: NativeFemSteadyTransportGauge,
    pub constitutive_version: String,
    pub operator_version: String,
    pub physical_residual_version: String,
    pub charge_conductivity_spm_per_element: Vec<f64>,
    pub magnetization: Vec<[f64; 3]>,
    pub sigma_s_spm: f64,
    pub polarization_p: f64,
    pub theta_sh: f64,
    pub lambda_sf_m: f64,
    pub lambda_j_m: Option<f64>,
    pub lambda_phi_m: Option<f64>,
    pub gamma_e_per_ts: f64,
    pub saturation_magnetization_apm: f64,
    pub relative_tolerance: f64,
    pub absolute_tolerance: f64,
    pub maximum_iterations: u32,
    pub charge_dirichlet: Vec<(u32, f64)>,
    pub spin_dirichlet: Vec<(u32, [f64; 3])>,
}

#[derive(Debug, Clone)]
pub(crate) struct NativeFemSteadyTransportResult {
    pub electric_potential_v: Vec<f64>,
    pub charge_current_density_xyz_apm2: Vec<[f64; 3]>,
    pub spin_potential_xyz_v: Vec<[f64; 3]>,
    pub spin_current_tensor_row_major_qia_apm2: Vec<[f64; 9]>,
    pub torque_xyz_per_s: Vec<[f64; 3]>,
    pub charge_iterations: u32,
    pub charge_relative_residual: f64,
    pub net_boundary_current_a: f64,
    pub current_density_volume_average_apm2: [f64; 3],
    pub spin_iterations: u32,
    pub spin_relative_residual: f64,
    pub boundary_spin_flux_a: [f64; 3],
    pub reaction_integral_a: [f64; 3],
    pub angular_momentum_balance_apm2: [f64; 3],
    pub torque_volume_average_per_s: [f64; 3],
    pub torque_l2_per_s: f64,
    pub diagnostics: Value,
    pub constitutive_version: String,
    pub operator_version: String,
    pub physical_residual_version: String,
    pub resolved_execution: String,
    pub resolved_interface: String,
}

struct FlatBuffers {
    nodes: Vec<f64>,
    elements: Vec<u32>,
    boundary_faces: Vec<u32>,
    magnetization: Vec<f64>,
    charge_attributes: Vec<u32>,
    charge_values: Vec<f64>,
    spin_attributes: Vec<u32>,
    spin_values: Vec<f64>,
}

fn preflight(request: &NativeFemSteadyTransportRequest) -> Result<(), RunError> {
    if request.execution != NativeFemSteadyTransportExecution::CpuDouble {
        return Err(RunError {
            message: "FEM steady spin transport GPU is unavailable; strict requests fail before provenance".to_string(),
        });
    }
    if request.interface != NativeFemSteadyTransportInterface::TransparentConformingH1 {
        return Err(RunError {
            message: "FEM mixing/SML transport requires the unavailable broken-H1 mortar realization and fails before provenance".to_string(),
        });
    }
    if request.constitutive_version != CONSTITUTIVE_VERSION
        || request.operator_version != OPERATOR_VERSION
        || request.physical_residual_version != PHYSICAL_RESIDUAL_VERSION
    {
        return Err(RunError {
            message: "unsupported FEM steady transport constitutive/operator/residual version"
                .to_string(),
        });
    }
    if !request.mesh.periodic_boundary_pairs.is_empty()
        || !request.mesh.periodic_node_pairs.is_empty()
    {
        return Err(RunError {
            message: "PeriodicSpin is unsupported by the FEM conforming-H1 M1 runtime".to_string(),
        });
    }
    if request.mesh.elements.len() != request.charge_conductivity_spm_per_element.len() {
        return Err(RunError {
            message: "FEM steady transport requires one charge conductivity per tetrahedron"
                .to_string(),
        });
    }
    if request.mesh.nodes.len() != request.magnetization.len() {
        return Err(RunError {
            message: "FEM steady transport magnetization length must equal mesh node count"
                .to_string(),
        });
    }
    if request.mesh.boundary_faces.len() != request.mesh.boundary_markers.len() {
        return Err(RunError {
            message: "FEM steady transport boundary face/marker counts differ".to_string(),
        });
    }
    if request.gauge == NativeFemSteadyTransportGauge::BoundaryReference
        && request.charge_dirichlet.is_empty()
    {
        return Err(RunError {
            message: "boundary-reference charge gauge requires at least one voltage electrode"
                .to_string(),
        });
    }
    if request.gauge == NativeFemSteadyTransportGauge::ZeroMeanPotential
        && !request.charge_dirichlet.is_empty()
    {
        return Err(RunError {
            message: "zero-mean charge gauge conflicts with voltage electrodes".to_string(),
        });
    }
    if request.absolute_tolerance != 0.0 {
        return Err(RunError {
            message: "FEM M1 steady transport currently requires absolute_tolerance=0".to_string(),
        });
    }
    Ok(())
}

fn flatten(request: &NativeFemSteadyTransportRequest) -> FlatBuffers {
    FlatBuffers {
        nodes: request.mesh.nodes.iter().flatten().copied().collect(),
        elements: request.mesh.elements.iter().flatten().copied().collect(),
        boundary_faces: request
            .mesh
            .boundary_faces
            .iter()
            .flatten()
            .copied()
            .collect(),
        magnetization: request.magnetization.iter().flatten().copied().collect(),
        charge_attributes: request
            .charge_dirichlet
            .iter()
            .map(|entry| entry.0)
            .collect(),
        charge_values: request
            .charge_dirichlet
            .iter()
            .map(|entry| entry.1)
            .collect(),
        spin_attributes: request.spin_dirichlet.iter().map(|entry| entry.0).collect(),
        spin_values: request
            .spin_dirichlet
            .iter()
            .flat_map(|entry| entry.1)
            .collect(),
    }
}

fn const_ptr<T>(values: &[T]) -> *const T {
    if values.is_empty() {
        ptr::null()
    } else {
        values.as_ptr()
    }
}

fn chars(chars: &[std::os::raw::c_char]) -> String {
    unsafe { CStr::from_ptr(chars.as_ptr()) }
        .to_string_lossy()
        .into_owned()
}

fn triples(values: Vec<f64>) -> Vec<[f64; 3]> {
    values
        .chunks_exact(3)
        .map(|chunk| [chunk[0], chunk[1], chunk[2]])
        .collect()
}

fn tensors(values: Vec<f64>) -> Vec<[f64; 9]> {
    values
        .chunks_exact(9)
        .map(|chunk| {
            let mut tensor = [0.0; 9];
            tensor.copy_from_slice(chunk);
            tensor
        })
        .collect()
}

pub(crate) fn solve_native_fem_steady_transport(
    request: &NativeFemSteadyTransportRequest,
) -> Result<NativeFemSteadyTransportResult, RunError> {
    preflight(request)?;
    let flat = flatten(request);
    let constitutive =
        CString::new(request.constitutive_version.as_str()).map_err(|_| RunError {
            message: "FEM steady transport constitutive_version contains NUL".to_string(),
        })?;
    let operator = CString::new(request.operator_version.as_str()).map_err(|_| RunError {
        message: "FEM steady transport operator_version contains NUL".to_string(),
    })?;
    let residual =
        CString::new(request.physical_residual_version.as_str()).map_err(|_| RunError {
            message: "FEM steady transport physical_residual_version contains NUL".to_string(),
        })?;

    let node_count = request.mesh.nodes.len();
    let mut electric_potential = vec![0.0; node_count];
    let mut charge_current = vec![0.0; 3 * node_count];
    let mut spin_potential = vec![0.0; 3 * node_count];
    let mut spin_current = vec![0.0; 9 * node_count];
    let mut torque = vec![0.0; 3 * node_count];

    let ffi_request = ffi::fullmag_fem_steady_transport_request_v1 {
        abi_version: ffi::FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION,
        reserved_flags: 0,
        struct_size: std::mem::size_of::<ffi::fullmag_fem_steady_transport_request_v1>() as u64,
        execution_lane: ffi::fullmag_fem_steady_transport_execution_lane::FULLMAG_FEM_STEADY_TRANSPORT_CPU_DOUBLE,
        interface_model: ffi::fullmag_fem_steady_transport_interface_model::FULLMAG_FEM_STEADY_TRANSPORT_TRANSPARENT_CONFORMING_H1,
        charge_gauge: match request.gauge {
            NativeFemSteadyTransportGauge::BoundaryReference => ffi::fullmag_fem_steady_transport_charge_gauge::FULLMAG_FEM_STEADY_TRANSPORT_BOUNDARY_REFERENCE,
            NativeFemSteadyTransportGauge::ZeroMeanPotential => ffi::fullmag_fem_steady_transport_charge_gauge::FULLMAG_FEM_STEADY_TRANSPORT_ZERO_MEAN_POTENTIAL,
        },
        constitutive_version: constitutive.as_ptr(),
        operator_version: operator.as_ptr(),
        physical_residual_version: residual.as_ptr(),
        mesh: ffi::fullmag_fem_mesh_desc {
            nodes_xyz: const_ptr(&flat.nodes),
            n_nodes: node_count as u32,
            elements: const_ptr(&flat.elements),
            n_elements: request.mesh.elements.len() as u32,
            element_markers: const_ptr(&request.mesh.element_markers),
            boundary_faces: const_ptr(&flat.boundary_faces),
            n_boundary_faces: request.mesh.boundary_faces.len() as u32,
            boundary_markers: const_ptr(&request.mesh.boundary_markers),
            periodic_node_pairs: ptr::null(),
            n_periodic_node_pairs: 0,
            periodic_boundary_pair_markers: ptr::null(),
            periodic_boundary_pair_count: 0,
        },
        charge_conductivity_spm_per_element: const_ptr(&request.charge_conductivity_spm_per_element),
        charge_conductivity_spm_per_element_len: request.charge_conductivity_spm_per_element.len() as u64,
        magnetization_xyz: const_ptr(&flat.magnetization),
        magnetization_xyz_len: flat.magnetization.len() as u64,
        sigma_s_spm: request.sigma_s_spm,
        polarization_p: request.polarization_p,
        theta_sh: request.theta_sh,
        lambda_sf_m: request.lambda_sf_m,
        has_lambda_j: i32::from(request.lambda_j_m.is_some()),
        lambda_j_m: request.lambda_j_m.unwrap_or(0.0),
        has_lambda_phi: i32::from(request.lambda_phi_m.is_some()),
        lambda_phi_m: request.lambda_phi_m.unwrap_or(0.0),
        gamma_e_per_ts: request.gamma_e_per_ts,
        saturation_magnetization_apm: request.saturation_magnetization_apm,
        relative_tolerance: request.relative_tolerance,
        absolute_tolerance: request.absolute_tolerance,
        maximum_iterations: request.maximum_iterations,
        charge_dirichlet_boundary_attributes: const_ptr(&flat.charge_attributes),
        charge_dirichlet_values_v: const_ptr(&flat.charge_values),
        charge_dirichlet_count: flat.charge_attributes.len() as u64,
        spin_dirichlet_boundary_attributes: const_ptr(&flat.spin_attributes),
        spin_dirichlet_values_v: const_ptr(&flat.spin_values),
        spin_dirichlet_count: flat.spin_attributes.len() as u64,
    };
    let mut ffi_result = ffi::fullmag_fem_steady_transport_result_v1 {
        abi_version: ffi::FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION,
        reserved_flags: 0,
        struct_size: std::mem::size_of::<ffi::fullmag_fem_steady_transport_result_v1>() as u64,
        electric_potential_v: electric_potential.as_mut_ptr(),
        electric_potential_v_len: electric_potential.len() as u64,
        charge_current_density_xyz_apm2: charge_current.as_mut_ptr(),
        charge_current_density_xyz_apm2_len: charge_current.len() as u64,
        spin_potential_xyz_v: spin_potential.as_mut_ptr(),
        spin_potential_xyz_v_len: spin_potential.len() as u64,
        spin_current_tensor_row_major_qia_apm2: spin_current.as_mut_ptr(),
        spin_current_tensor_row_major_qia_apm2_len: spin_current.len() as u64,
        torque_xyz_per_s: torque.as_mut_ptr(),
        torque_xyz_len: torque.len() as u64,
        charge_converged: 0,
        charge_iterations: 0,
        charge_relative_residual: f64::NAN,
        net_boundary_current_a: f64::NAN,
        current_density_volume_average_apm2: [f64::NAN; 3],
        spin_converged: 0,
        spin_iterations: 0,
        spin_relative_residual: f64::NAN,
        boundary_spin_flux_a: [f64::NAN; 3],
        reaction_integral_a: [f64::NAN; 3],
        angular_momentum_balance_apm2: [f64::NAN; 3],
        torque_volume_average_per_s: [f64::NAN; 3],
        torque_l2_per_s: f64::NAN,
        error_message: [0; 256],
        diagnostics_json: [0; 1024],
    };

    let status =
        unsafe { ffi::fullmag_fem_solve_steady_transport_v1(&ffi_request, &mut ffi_result) };
    if status != ffi::FULLMAG_FEM_OK {
        return Err(RunError {
            message: chars(&ffi_result.error_message),
        });
    }
    if ffi_result.charge_converged == 0 || ffi_result.spin_converged == 0 {
        return Err(RunError {
            message: "native FEM steady transport returned success without converged solves"
                .to_string(),
        });
    }
    let diagnostics_text = chars(&ffi_result.diagnostics_json);
    let diagnostics = serde_json::from_str(&diagnostics_text).map_err(|error| RunError {
        message: format!("invalid native FEM steady transport diagnostics JSON: {error}"),
    })?;

    Ok(NativeFemSteadyTransportResult {
        electric_potential_v: electric_potential,
        charge_current_density_xyz_apm2: triples(charge_current),
        spin_potential_xyz_v: triples(spin_potential),
        spin_current_tensor_row_major_qia_apm2: tensors(spin_current),
        torque_xyz_per_s: triples(torque),
        charge_iterations: ffi_result.charge_iterations,
        charge_relative_residual: ffi_result.charge_relative_residual,
        net_boundary_current_a: ffi_result.net_boundary_current_a,
        current_density_volume_average_apm2: ffi_result.current_density_volume_average_apm2,
        spin_iterations: ffi_result.spin_iterations,
        spin_relative_residual: ffi_result.spin_relative_residual,
        boundary_spin_flux_a: ffi_result.boundary_spin_flux_a,
        reaction_integral_a: ffi_result.reaction_integral_a,
        angular_momentum_balance_apm2: ffi_result.angular_momentum_balance_apm2,
        torque_volume_average_per_s: ffi_result.torque_volume_average_per_s,
        torque_l2_per_s: ffi_result.torque_l2_per_s,
        diagnostics,
        constitutive_version: request.constitutive_version.clone(),
        operator_version: request.operator_version.clone(),
        physical_residual_version: request.physical_residual_version.clone(),
        resolved_execution: "fem_cpu_double".to_string(),
        resolved_interface: "transparent_conforming_h1".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn request() -> NativeFemSteadyTransportRequest {
        NativeFemSteadyTransportRequest {
            mesh: MeshIR {
                mesh_name: "tet".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                elements: vec![[0, 1, 2, 3]],
                element_markers: vec![1],
                boundary_faces: vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
                boundary_markers: vec![1, 1, 1, 1],
                periodic_boundary_pairs: vec![],
                periodic_node_pairs: vec![],
                per_domain_quality: HashMap::new(),
            },
            execution: NativeFemSteadyTransportExecution::CpuDouble,
            interface: NativeFemSteadyTransportInterface::TransparentConformingH1,
            gauge: NativeFemSteadyTransportGauge::BoundaryReference,
            constitutive_version: CONSTITUTIVE_VERSION.to_string(),
            operator_version: OPERATOR_VERSION.to_string(),
            physical_residual_version: PHYSICAL_RESIDUAL_VERSION.to_string(),
            charge_conductivity_spm_per_element: vec![4.0],
            magnetization: vec![[0.0, 0.0, 1.0]; 4],
            sigma_s_spm: 5.0,
            polarization_p: 0.2,
            theta_sh: 0.1,
            lambda_sf_m: 0.5,
            lambda_j_m: Some(0.4),
            lambda_phi_m: Some(0.6),
            gamma_e_per_ts: 1.760_859_630_23e11,
            saturation_magnetization_apm: 8.0e5,
            relative_tolerance: 1.0e-10,
            absolute_tolerance: 0.0,
            maximum_iterations: 500,
            charge_dirichlet: vec![(1, 1.0)],
            spin_dirichlet: vec![],
        }
    }

    #[test]
    fn preflight_rejects_gpu_and_mixing_before_native_call() {
        let mut gpu = request();
        gpu.execution = NativeFemSteadyTransportExecution::GpuDouble;
        assert!(preflight(&gpu)
            .unwrap_err()
            .message
            .contains("before provenance"));

        let mut mixing = request();
        mixing.interface = NativeFemSteadyTransportInterface::MixingBrokenH1;
        assert!(preflight(&mixing)
            .unwrap_err()
            .message
            .contains("broken-H1"));
    }

    #[test]
    fn flatten_preserves_row_major_mesh_and_qia_input_order() {
        let flat = flatten(&request());
        assert_eq!(
            flat.nodes,
            vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
        );
        assert_eq!(flat.elements, vec![0, 1, 2, 3]);
        assert_eq!(
            flat.magnetization,
            vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0]
        );
    }
}
