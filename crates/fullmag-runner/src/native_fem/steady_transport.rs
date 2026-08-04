use crate::types::{AuxiliaryArtifact, FieldSnapshot, RunError, TransportExecutionProvenance};
use fullmag_fem_sys as ffi;
use fullmag_ir::{FemPlanIR, MeshIR};
use serde_json::Value;
use std::ffi::{CStr, CString};
use std::ptr;

const CONSTITUTIVE_VERSION: &str = "transport_constitutive.one_way.fullmag.v1";
const OPERATOR_VERSION: &str = "fem_charge_spin_conforming_h1_p1.transparent.v1";
const M2_CONSTITUTIVE_VERSION: &str = "transport_constitutive.reciprocal.fullmag.v1";
const M2_OPERATOR_VERSION: &str = "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1";
const PHYSICAL_RESIDUAL_VERSION: &str = "transport_balance_integrated_l2.v1";

mod descriptor;
mod provenance;
mod publication;

use descriptor::preflight_transport_plans;
use publication::transport_field_snapshots;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeFemSteadyTransportExecution {
    CpuDouble,
    /// Representable for fail-closed preflight testing, but unavailable in M1.
    #[allow(dead_code)]
    GpuDouble,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeFemSteadyTransportConstitutiveModel {
    OneWay,
    ReciprocalM2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeFemSteadyTransportInterface {
    TransparentConformingH1,
    /// Representable for fail-closed preflight testing, but unavailable in M1.
    #[allow(dead_code)]
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
    pub constitutive_model: NativeFemSteadyTransportConstitutiveModel,
    pub constitutive_version: String,
    pub operator_version: String,
    pub physical_residual_version: String,
    pub charge_conductivity_spm_per_element: Vec<f64>,
    pub magnetization: Vec<[f64; 3]>,
    pub sigma_s_spm: f64,
    pub sigma_parallel_spm: Option<f64>,
    pub sigma_perpendicular_spm: Option<f64>,
    pub sigma_ahe_spm: Option<f64>,
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

pub(crate) struct NativeFemSteadyTransportBundle {
    pub artifacts: Vec<AuxiliaryArtifact>,
    pub field_snapshots: Vec<FieldSnapshot>,
    pub provenance: Vec<TransportExecutionProvenance>,
}

pub(crate) fn execute_native_fem_steady_transport_plans(
    plan: &FemPlanIR,
) -> Result<Option<NativeFemSteadyTransportBundle>, RunError> {
    if plan.spin_transport_plans.is_empty() {
        return Ok(None);
    }
    let prepared = preflight_transport_plans(plan)?;
    let mut records = Vec::with_capacity(plan.spin_transport_plans.len());
    let mut provenance = Vec::with_capacity(plan.spin_transport_plans.len());
    let mut field_snapshots = Vec::new();
    for prepared in prepared {
        let resolved = prepared.resolved;
        let result = solve_native_fem_steady_transport(&prepared.request)?;
        field_snapshots.extend(transport_field_snapshots(
            resolved,
            &result,
            field_snapshots.len() as u64 + 1,
        )?);
        records.push(serde_json::json!({
            "module_id": resolved.module_id,
            "current_source_id": resolved.current_source_id,
            "requested_execution": resolved.requested_execution,
            "resolved_execution": {
                "discretization": resolved.resolved_discretization,
                "device": resolved.resolved_device,
                "precision": resolved.resolved_precision,
            },
            "capabilities": resolved.capabilities,
            "inserted_default_boundaries": resolved.inserted_default_boundaries,
            "descriptor": resolved.fem_cpu_double,
            "result": {
                "electric_potential_v": result.electric_potential_v,
                "charge_current_density_xyz_apm2": result.charge_current_density_xyz_apm2,
                "spin_potential_xyz_v": result.spin_potential_xyz_v,
                "spin_current_tensor_row_major_qia_apm2": result.spin_current_tensor_row_major_qia_apm2,
                "torque_xyz_per_s": result.torque_xyz_per_s,
                "charge_iterations": result.charge_iterations,
                "charge_relative_residual": result.charge_relative_residual,
                "net_boundary_current_a": result.net_boundary_current_a,
                "current_density_volume_average_apm2": result.current_density_volume_average_apm2,
                "spin_iterations": result.spin_iterations,
                "spin_relative_residual": result.spin_relative_residual,
                "boundary_spin_flux_a": result.boundary_spin_flux_a,
                "reaction_integral_a": result.reaction_integral_a,
                "angular_momentum_balance_apm2": result.angular_momentum_balance_apm2,
                "torque_volume_average_per_s": result.torque_volume_average_per_s,
                "torque_l2_per_s": result.torque_l2_per_s,
                "diagnostics": result.diagnostics,
                "constitutive_version": result.constitutive_version,
                "operator_version": result.operator_version,
                "physical_residual_version": result.physical_residual_version,
                "resolved_execution": result.resolved_execution,
                "resolved_interface": result.resolved_interface,
            }
        }));
        provenance.push(prepared.provenance);
    }
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({
        "schema": "fullmag.fem.steady_spin_transport.v1",
        "component_order": "row_major_Q_ia",
        "flow_axes": ["x", "y", "z"],
        "spin_axes": ["x", "y", "z"],
        "location": "node",
        "modules": records,
    }))
    .map_err(|error| RunError {
        message: format!("serialize FEM steady transport artifact: {error}"),
    })?;
    let artifacts = vec![AuxiliaryArtifact {
        relative_path: "transport/fem_steady_spin_transport.json".into(),
        bytes,
    }];
    Ok(Some(NativeFemSteadyTransportBundle {
        artifacts,
        field_snapshots,
        provenance,
    }))
}

struct FlatBuffers {
    mesh: super::PackedNativeMesh,
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
    let expected_versions = match request.constitutive_model {
        NativeFemSteadyTransportConstitutiveModel::OneWay => {
            (CONSTITUTIVE_VERSION, OPERATOR_VERSION)
        }
        NativeFemSteadyTransportConstitutiveModel::ReciprocalM2 => {
            (M2_CONSTITUTIVE_VERSION, M2_OPERATOR_VERSION)
        }
    };
    if request.constitutive_version != expected_versions.0
        || request.operator_version != expected_versions.1
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
    if request.mesh.element_markers.len() != request.mesh.cell_count() {
        return Err(RunError {
            message: format!(
                "FEM steady transport element marker count {} differs from element count {}",
                request.mesh.element_markers.len(),
                request.mesh.cell_count()
            ),
        });
    }
    if request.mesh.cell_count() != request.charge_conductivity_spm_per_element.len() {
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
    if request.mesh.facet_count() != request.mesh.boundary_markers.len() {
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
    if request.constitutive_model == NativeFemSteadyTransportConstitutiveModel::ReciprocalM2
        && request.gauge != NativeFemSteadyTransportGauge::BoundaryReference
    {
        return Err(RunError {
            message: "reciprocal FEM M2 requires a Dirichlet charge reference".to_string(),
        });
    }
    if request.absolute_tolerance != 0.0 {
        return Err(RunError {
            message: "FEM steady transport currently requires absolute_tolerance=0".to_string(),
        });
    }
    match request.constitutive_model {
        NativeFemSteadyTransportConstitutiveModel::OneWay => {
            if request.sigma_parallel_spm.is_some()
                || request.sigma_perpendicular_spm.is_some()
                || request.sigma_ahe_spm.is_some()
            {
                return Err(RunError {
                    message: "one-way FEM transport must not carry reciprocal charge coefficients"
                        .to_string(),
                });
            }
        }
        NativeFemSteadyTransportConstitutiveModel::ReciprocalM2 => {
            let (Some(sigma_parallel), Some(sigma_perpendicular), Some(sigma_ahe)) = (
                request.sigma_parallel_spm,
                request.sigma_perpendicular_spm,
                request.sigma_ahe_spm,
            ) else {
                return Err(RunError {
                    message: "reciprocal FEM M2 requires sigma_parallel, sigma_perpendicular, and sigma_AHE"
                        .to_string(),
                });
            };
            if !sigma_parallel.is_finite()
                || sigma_parallel <= 0.0
                || !sigma_perpendicular.is_finite()
                || sigma_perpendicular <= 0.0
                || !sigma_ahe.is_finite()
            {
                return Err(RunError {
                    message: "reciprocal FEM M2 charge coefficients must be finite with positive symmetric conductivities"
                        .to_string(),
                });
            }
            let minimum = sigma_parallel.min(sigma_perpendicular);
            for sigma in &request.charge_conductivity_spm_per_element {
                if minimum * request.sigma_s_spm
                    - request.polarization_p * request.polarization_p * sigma * sigma
                    <= 0.0
                {
                    return Err(RunError {
                        message: "reciprocal FEM M2 material violates the positive Schur complement"
                            .to_string(),
                    });
                }
            }
        }
    }
    Ok(())
}

fn flatten(request: &NativeFemSteadyTransportRequest) -> FlatBuffers {
    FlatBuffers {
        mesh: super::PackedNativeMesh::new(&request.mesh),
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

    let base_request = ffi::fullmag_fem_steady_transport_request_v1 {
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
        mesh: flat.mesh.descriptor(&request.mesh),
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

    let status = match request.constitutive_model {
        NativeFemSteadyTransportConstitutiveModel::OneWay => unsafe {
            ffi::fullmag_fem_solve_steady_transport_v1(&base_request, &mut ffi_result)
        },
        NativeFemSteadyTransportConstitutiveModel::ReciprocalM2 => {
            let m2_request = ffi::fullmag_fem_steady_transport_m2_request_v1 {
                base: base_request,
                sigma_parallel_spm: request
                    .sigma_parallel_spm
                    .expect("M2 preflight validates sigma_parallel_spm"),
                sigma_perpendicular_spm: request
                    .sigma_perpendicular_spm
                    .expect("M2 preflight validates sigma_perpendicular_spm"),
                sigma_ahe_spm: request
                    .sigma_ahe_spm
                    .expect("M2 preflight validates sigma_ahe_spm"),
            };
            unsafe {
                ffi::fullmag_fem_solve_steady_transport_m2_v1(&m2_request, &mut ffi_result)
            }
        }
    };
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
    use super::descriptor::materialize_native_fem_steady_transport_request;
    use super::provenance::transport_provenance;
    use super::*;
    use fullmag_ir::{
        BackendTarget, ChargePotentialGaugeIR, ChargeSolverPolicyIR, ExecutionDevice,
        ExecutionMode, ExecutionPrecision, FdmPlanIR, GridDimensions,
        LinearTransportSolverPolicyIR, RequestedTransportExecutionIR,
        ReciprocalNonlinearSolverPolicyIR, ResolvedFdmCoupledSpinTransportIR,
        ResolvedChargeBoundaryConditionIR, ResolvedChargeBoundaryFaceIR,
        ResolvedFdmSpinTransportIR, ResolvedFemSpinTransportIR, ResolvedSpinBoundaryConditionIR,
        ResolvedSpinBoundaryFaceIR, ResolvedSpinReactionLengthsIR, ResolvedSpinTransportPlanIR,
        ResolvedReciprocalMaterialIR, SpinSolverPolicyIR, StructuredBoundaryFaceIR,
        TransportCouplingIR,
    };
    use std::collections::HashMap;

    fn request() -> NativeFemSteadyTransportRequest {
        NativeFemSteadyTransportRequest {
            mesh: MeshIR::from_legacy_tet4(
                "tet".to_string(),
                vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                vec![[0, 1, 2, 3]],
                vec![1],
                vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
                vec![1, 1, 1, 1],
                vec![],
                vec![],
                HashMap::new(),
            ),
            execution: NativeFemSteadyTransportExecution::CpuDouble,
            interface: NativeFemSteadyTransportInterface::TransparentConformingH1,
            gauge: NativeFemSteadyTransportGauge::BoundaryReference,
            constitutive_model: NativeFemSteadyTransportConstitutiveModel::OneWay,
            constitutive_version: CONSTITUTIVE_VERSION.to_string(),
            operator_version: OPERATOR_VERSION.to_string(),
            physical_residual_version: PHYSICAL_RESIDUAL_VERSION.to_string(),
            charge_conductivity_spm_per_element: vec![4.0],
            magnetization: vec![[0.0, 0.0, 1.0]; 4],
            sigma_s_spm: 5.0,
            sigma_parallel_spm: None,
            sigma_perpendicular_spm: None,
            sigma_ahe_spm: None,
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

    pub(crate) fn resolved_plan() -> ResolvedSpinTransportPlanIR {
        let charge_solver = ChargeSolverPolicyIR {
            engine: "cg".into(),
            linear: LinearTransportSolverPolicyIR {
                relative_tolerance: 1.0e-10,
                absolute_tolerance: 0.0,
                max_iterations: 500,
            },
            physical_residual_version: "charge_balance_integrated_l2.v1".into(),
            operator_version: "fem_charge_conforming_h1_p1.transparent.v1".into(),
        };
        let spin_solver = SpinSolverPolicyIR {
            engine: "gmres".into(),
            linear: LinearTransportSolverPolicyIR {
                relative_tolerance: 1.0e-10,
                absolute_tolerance: 0.0,
                max_iterations: 500,
            },
            physical_residual_version: PHYSICAL_RESIDUAL_VERSION.into(),
            operator_version: OPERATOR_VERSION.into(),
            default_external_boundary: "spin_insulating".into(),
            reciprocal_nonlinear: None,
        };
        let region = fullmag_ir::RegionRefIR {
            object_id: "strip".into(),
            region_id: None,
        };
        let charge_definition = fullmag_ir::ChargeTransportDefinitionIR {
            domain: vec![region.clone()],
            materials: vec![fullmag_ir::ChargeTransportMaterialAssignmentIR {
                region: region.clone(),
                material: fullmag_ir::ChargeTransportMaterialIR {
                    sigma_spm: 4.0,
                    sigma_parallel_spm: None,
                    sigma_perpendicular_spm: None,
                    sigma_ahe_spm: None,
                },
            }],
            boundaries: vec![],
            gauge: ChargePotentialGaugeIR::DirichletReference,
            solver: charge_solver.clone(),
        };
        ResolvedSpinTransportPlanIR {
            module_id: "spin".into(),
            current_source_id: "charge".into(),
            resolved_coupling: TransportCouplingIR::OneWay,
            requested_execution: RequestedTransportExecutionIR {
                discretization: BackendTarget::Auto,
                device: ExecutionDevice::Auto,
                precision: ExecutionPrecision::Double,
                execution_mode: ExecutionMode::Strict,
            },
            resolved_discretization: BackendTarget::Fem,
            resolved_device: ExecutionDevice::Cpu,
            resolved_precision: ExecutionPrecision::Double,
            constitutive_version: CONSTITUTIVE_VERSION.into(),
            operator_version: OPERATOR_VERSION.into(),
            physical_residual_version: PHYSICAL_RESIDUAL_VERSION.into(),
            capabilities: vec![
                "transport.charge.ohmic".into(),
                "transport.spin.steady_drift_diffusion".into(),
                "transport.spin.direct_she".into(),
                "transport.coupling.one_way".into(),
            ],
            inserted_default_boundaries: vec!["all_unassigned_external_surfaces".into()],
            fdm_cpu_double: None,
            fdm_cpu_double_reciprocal: None,
            fdm_cpu_double_transient: None,
            fem_cpu_double: Some(ResolvedFemSpinTransportIR {
                descriptor_schema: "fullmag.fem.spin_transport_descriptor.v1".into(),
                charge_definition,
                charge_domain: fullmag_ir::ResolvedFemTransportDomainIR {
                    regions: vec![region.clone()],
                    element_mask: vec![true],
                },
                spin_domain: fullmag_ir::ResolvedFemTransportDomainIR {
                    regions: vec![region],
                    element_mask: vec![true],
                },
                charge_insulating_boundaries: vec![],
                spin_insulating_boundaries: vec![fullmag_ir::ResolvedFemBoundaryMarkerSetIR {
                    id: "default:spin_insulating".into(),
                    boundary_attributes: vec![1],
                }],
                interfaces: vec![],
                torque_target: None,
                charge_conductivity_spm_per_element: vec![4.0],
                charge_gauge: ChargePotentialGaugeIR::DirichletReference,
                charge_solver,
                charge_dirichlet: vec![(1, 1.0)],
                spin_dirichlet: vec![],
                sigma_s_spm: 5.0,
                reciprocal_material: None,
                polarization_p: 0.2,
                theta_sh: 0.1,
                lambda_sf_m: 0.5,
                lambda_j_m: Some(0.4),
                lambda_phi_m: Some(0.6),
                saturation_magnetization_apm: 8.0e5,
                gamma_e_rad_per_s_t: 1.760_859_630_23e11,
                spin_solver,
                resolved_charge_engine: "cg".into(),
                resolved_spin_engine: "gmres".into(),
                interface_law: "transparent".into(),
                interface_realization: "transparent_conforming_h1".into(),
                stage_coupling: "none".into(),
                capability_status: "reference_executable".into(),
                implementation_state: "executable".into(),
                validation_state: "algebra_validated".into(),
                validation_scope: "fem_cpu_double_conforming_h1_p1_transparent_m1".into(),
            }),
        }
    }

    fn resolved_m2_plan() -> ResolvedSpinTransportPlanIR {
        let mut plan = resolved_plan();
        plan.resolved_coupling = TransportCouplingIR::Bidirectional;
        plan.constitutive_version = M2_CONSTITUTIVE_VERSION.into();
        plan.operator_version = M2_OPERATOR_VERSION.into();
        plan.capabilities = vec![
            "transport.charge.magnetoresistive".into(),
            "transport.spin.steady_drift_diffusion".into(),
            "transport.spin.direct_she".into(),
            "transport.spin.inverse_she".into(),
            "transport.coupling.bidirectional".into(),
        ];
        let descriptor = plan.fem_cpu_double.as_mut().expect("FEM descriptor");
        descriptor.descriptor_schema = "fullmag.fem.spin_transport_descriptor.m2.v1".into();
        descriptor.charge_definition.materials[0]
            .material
            .sigma_parallel_spm = Some(4.4);
        descriptor.charge_definition.materials[0]
            .material
            .sigma_perpendicular_spm = Some(4.0);
        descriptor.charge_definition.materials[0]
            .material
            .sigma_ahe_spm = Some(0.2);
        descriptor.charge_definition.solver.engine = "block_gmres".into();
        descriptor.charge_definition.solver.operator_version = M2_OPERATOR_VERSION.into();
        descriptor.charge_definition.solver.physical_residual_version =
            PHYSICAL_RESIDUAL_VERSION.into();
        descriptor.charge_solver = descriptor.charge_definition.solver.clone();
        descriptor.reciprocal_material = Some(fullmag_ir::ResolvedReciprocalMaterialIR {
            sigma_spm: 4.0,
            sigma_spin_spm: 5.0,
            sigma_parallel_spm: 4.4,
            sigma_perpendicular_spm: 4.0,
            sigma_ahe_spm: 0.2,
            polarization_p: 0.2,
            theta_sh: 0.1,
        });
        descriptor.spin_solver.operator_version = M2_OPERATOR_VERSION.into();
        descriptor.resolved_charge_engine = "gmres".into();
        descriptor.validation_scope = "fem_cpu_double_conforming_h1_p1_reciprocal_m2".into();
        plan
    }

    fn common_direct_she_fdm_plan(nz: usize) -> FdmPlanIR {
        let cells = nz;
        let descriptor = ResolvedFdmSpinTransportIR {
            descriptor_schema: "fullmag.fdm.spin_transport_descriptor.v1".into(),
            charge_active_cells: vec![true; cells],
            charge_conductivity_spm: vec![3.0; cells],
            charge_boundaries: vec![
                ResolvedChargeBoundaryFaceIR {
                    source_id: "x_min".into(),
                    face: StructuredBoundaryFaceIR::XMin,
                    condition: ResolvedChargeBoundaryConditionIR::Voltage { potential_v: 0.5 },
                },
                ResolvedChargeBoundaryFaceIR {
                    source_id: "x_max".into(),
                    face: StructuredBoundaryFaceIR::XMax,
                    condition: ResolvedChargeBoundaryConditionIR::Voltage { potential_v: -0.5 },
                },
                ResolvedChargeBoundaryFaceIR {
                    source_id: "y_min".into(),
                    face: StructuredBoundaryFaceIR::YMin,
                    condition: ResolvedChargeBoundaryConditionIR::Insulating,
                },
                ResolvedChargeBoundaryFaceIR {
                    source_id: "y_max".into(),
                    face: StructuredBoundaryFaceIR::YMax,
                    condition: ResolvedChargeBoundaryConditionIR::Insulating,
                },
                ResolvedChargeBoundaryFaceIR {
                    source_id: "z_min".into(),
                    face: StructuredBoundaryFaceIR::ZMin,
                    condition: ResolvedChargeBoundaryConditionIR::Insulating,
                },
                ResolvedChargeBoundaryFaceIR {
                    source_id: "z_max".into(),
                    face: StructuredBoundaryFaceIR::ZMax,
                    condition: ResolvedChargeBoundaryConditionIR::Insulating,
                },
            ],
            charge_gauge: ChargePotentialGaugeIR::DirichletReference,
            charge_solver: ChargeSolverPolicyIR {
                engine: "cg".into(),
                linear: LinearTransportSolverPolicyIR {
                    relative_tolerance: 1.0e-11,
                    absolute_tolerance: 1.0e-14,
                    max_iterations: 2000,
                },
                physical_residual_version: "charge_balance_integrated_l2.v1".into(),
                operator_version: "fv_charge_harmonic_v1".into(),
            },
            spin_active_cells: vec![true; cells],
            spin_conductivity_spm: vec![2.0; cells],
            polarization_p: vec![0.0; cells],
            theta_sh: vec![0.1; cells],
            reactions: vec![
                ResolvedSpinReactionLengthsIR {
                    spin_flip_m: Some(0.2),
                    exchange_m: None,
                    dephasing_m: None,
                };
                cells
            ],
            region_ids: vec![0; cells],
            spin_boundaries: vec![
                ResolvedSpinBoundaryFaceIR {
                    source_id: "spin_x_min".into(),
                    face: StructuredBoundaryFaceIR::XMin,
                    condition: ResolvedSpinBoundaryConditionIR::SpinInsulating,
                },
                ResolvedSpinBoundaryFaceIR {
                    source_id: "spin_x_max".into(),
                    face: StructuredBoundaryFaceIR::XMax,
                    condition: ResolvedSpinBoundaryConditionIR::SpinInsulating,
                },
                ResolvedSpinBoundaryFaceIR {
                    source_id: "spin_y_min".into(),
                    face: StructuredBoundaryFaceIR::YMin,
                    condition: ResolvedSpinBoundaryConditionIR::SpinInsulating,
                },
                ResolvedSpinBoundaryFaceIR {
                    source_id: "spin_y_max".into(),
                    face: StructuredBoundaryFaceIR::YMax,
                    condition: ResolvedSpinBoundaryConditionIR::SpinInsulating,
                },
                ResolvedSpinBoundaryFaceIR {
                    source_id: "spin_z_min".into(),
                    face: StructuredBoundaryFaceIR::ZMin,
                    condition: ResolvedSpinBoundaryConditionIR::SpinInsulating,
                },
                ResolvedSpinBoundaryFaceIR {
                    source_id: "spin_z_max".into(),
                    face: StructuredBoundaryFaceIR::ZMax,
                    condition: ResolvedSpinBoundaryConditionIR::SpinInsulating,
                },
            ],
            interfaces: vec![],
            torque_target_cells: vec![false; cells],
            saturation_magnetization_apm: vec![8.0e5; cells],
            gamma_e_rad_per_s_t: 1.760_859_630_23e11,
            spin_solver: SpinSolverPolicyIR {
                engine: "gmres".into(),
                linear: LinearTransportSolverPolicyIR {
                    relative_tolerance: 1.0e-11,
                    absolute_tolerance: 1.0e-14,
                    max_iterations: 2000,
                },
                physical_residual_version: PHYSICAL_RESIDUAL_VERSION.into(),
                operator_version: "fv_spin_upwind_v1".into(),
                default_external_boundary: "spin_insulating".into(),
                reciprocal_nonlinear: None,
            },
            torque_formula_version: None,
            oersted_source_bound: false,
        };
        FdmPlanIR {
            grid: GridDimensions {
                cells: [1, 1, nz as u32],
            },
            cell_size: [1.0, 0.1, 1.0 / nz as f64],
            active_mask: Some(vec![true; cells]),
            initial_magnetization: vec![[0.0, 0.0, 1.0]; cells],
            spin_transport_plans: vec![ResolvedSpinTransportPlanIR {
                module_id: "spin".into(),
                current_source_id: "charge".into(),
                resolved_coupling: TransportCouplingIR::OneWay,
                requested_execution: RequestedTransportExecutionIR {
                    discretization: BackendTarget::Fdm,
                    device: ExecutionDevice::Cpu,
                    precision: ExecutionPrecision::Double,
                    execution_mode: ExecutionMode::Strict,
                },
                resolved_discretization: BackendTarget::Fdm,
                resolved_device: ExecutionDevice::Cpu,
                resolved_precision: ExecutionPrecision::Double,
                constitutive_version: "transport_constitutive.one_way.fullmag.v1".into(),
                operator_version: "fv_spin_upwind_v1".into(),
                physical_residual_version: PHYSICAL_RESIDUAL_VERSION.into(),
                capabilities: vec!["transport.spin.direct_she".into()],
                inserted_default_boundaries: vec![],
                fdm_cpu_double: Some(descriptor),
                fdm_cpu_double_reciprocal: None,
                fdm_cpu_double_transient: None,
                fem_cpu_double: None,
            }],
            ..FdmPlanIR::default()
        }
    }

    fn common_direct_she_fem_mesh(nz: usize) -> MeshIR {
        let node = |x: usize, y: usize, z: usize| -> u32 { (z * 4 + y * 2 + x) as u32 };
        let mut nodes = Vec::with_capacity((nz + 1) * 4);
        for z in 0..=nz {
            for y in 0..=1 {
                for x in 0..=1 {
                    nodes.push([x as f64, 0.1 * y as f64, z as f64 / nz as f64]);
                }
            }
        }
        let mut elements = Vec::with_capacity(nz * 6);
        let mut element_markers = Vec::with_capacity(nz * 6);
        let mut boundary_faces = Vec::with_capacity(nz * 8 + 4);
        let mut boundary_markers = Vec::with_capacity(nz * 8 + 4);
        for z in 0..nz {
            let a = node(0, 0, z);
            let b = node(1, 0, z);
            let c = node(1, 1, z);
            let d = node(0, 1, z);
            let e = node(0, 0, z + 1);
            let f = node(1, 0, z + 1);
            let g = node(1, 1, z + 1);
            let h = node(0, 1, z + 1);
            elements.extend([
                [a, b, c, g],
                [a, c, d, g],
                [a, d, h, g],
                [a, h, e, g],
                [a, e, f, g],
                [a, f, b, g],
            ]);
            element_markers.extend((0..6).map(|_| 1));

            let mut add_face = |face: [u32; 3], marker: u32| {
                boundary_faces.push(face);
                boundary_markers.push(marker);
            };
            if z == 0 {
                add_face([a, b, c], 3);
                add_face([a, c, d], 3);
            }
            if z + 1 == nz {
                add_face([e, f, g], 3);
                add_face([e, g, h], 3);
            }
            add_face([a, d, h], 1);
            add_face([a, h, e], 1);
            add_face([b, c, g], 2);
            add_face([b, g, f], 2);
            add_face([a, e, f], 3);
            add_face([a, f, b], 3);
            add_face([c, d, g], 3);
            add_face([d, h, g], 3);
        }
        MeshIR::from_legacy_tet4(
            "direct-she-common-limit".into(),
            nodes,
            elements,
            element_markers,
            boundary_faces,
            boundary_markers,
            vec![],
            vec![],
            HashMap::new(),
        )
    }

    fn common_reciprocal_m2_fdm_plan(nz: usize) -> FdmPlanIR {
        let cells = nz;
        let descriptor = ResolvedFdmCoupledSpinTransportIR {
            descriptor_schema: "fullmag.fdm.coupled_spin_transport_descriptor.v1".into(),
            active_cells: vec![true; cells],
            reciprocal_materials: vec![ResolvedReciprocalMaterialIR {
                sigma_spm: 4.0,
                sigma_spin_spm: 5.0,
                sigma_parallel_spm: 6.0,
                sigma_perpendicular_spm: 3.0,
                sigma_ahe_spm: 0.0,
                polarization_p: 0.25,
                theta_sh: 0.0,
            }; cells],
            reactions: vec![
                ResolvedSpinReactionLengthsIR {
                    spin_flip_m: Some(0.3),
                    exchange_m: None,
                    dephasing_m: None,
                };
                cells
            ],
            region_ids: vec![0; cells],
            charge_boundaries: vec![
                ResolvedChargeBoundaryFaceIR {
                    source_id: "z_min".into(),
                    face: StructuredBoundaryFaceIR::ZMin,
                    condition: ResolvedChargeBoundaryConditionIR::Voltage { potential_v: 1.0 },
                },
                ResolvedChargeBoundaryFaceIR {
                    source_id: "z_max".into(),
                    face: StructuredBoundaryFaceIR::ZMax,
                    condition: ResolvedChargeBoundaryConditionIR::Voltage { potential_v: 0.0 },
                },
                ResolvedChargeBoundaryFaceIR {
                    source_id: "x_min".into(),
                    face: StructuredBoundaryFaceIR::XMin,
                    condition: ResolvedChargeBoundaryConditionIR::Insulating,
                },
                ResolvedChargeBoundaryFaceIR {
                    source_id: "x_max".into(),
                    face: StructuredBoundaryFaceIR::XMax,
                    condition: ResolvedChargeBoundaryConditionIR::Insulating,
                },
                ResolvedChargeBoundaryFaceIR {
                    source_id: "y_min".into(),
                    face: StructuredBoundaryFaceIR::YMin,
                    condition: ResolvedChargeBoundaryConditionIR::Insulating,
                },
                ResolvedChargeBoundaryFaceIR {
                    source_id: "y_max".into(),
                    face: StructuredBoundaryFaceIR::YMax,
                    condition: ResolvedChargeBoundaryConditionIR::Insulating,
                },
            ],
            spin_boundaries: vec![
                ResolvedSpinBoundaryFaceIR {
                    source_id: "z_min".into(),
                    face: StructuredBoundaryFaceIR::ZMin,
                    condition: ResolvedSpinBoundaryConditionIR::SpecifiedPotential {
                        value_v: [0.0, 0.0, 0.2],
                    },
                },
                ResolvedSpinBoundaryFaceIR {
                    source_id: "z_max".into(),
                    face: StructuredBoundaryFaceIR::ZMax,
                    condition: ResolvedSpinBoundaryConditionIR::SpecifiedPotential {
                        value_v: [0.0, 0.0, 0.0],
                    },
                },
                ResolvedSpinBoundaryFaceIR {
                    source_id: "x_min".into(),
                    face: StructuredBoundaryFaceIR::XMin,
                    condition: ResolvedSpinBoundaryConditionIR::SpinInsulating,
                },
                ResolvedSpinBoundaryFaceIR {
                    source_id: "x_max".into(),
                    face: StructuredBoundaryFaceIR::XMax,
                    condition: ResolvedSpinBoundaryConditionIR::SpinInsulating,
                },
                ResolvedSpinBoundaryFaceIR {
                    source_id: "y_min".into(),
                    face: StructuredBoundaryFaceIR::YMin,
                    condition: ResolvedSpinBoundaryConditionIR::SpinInsulating,
                },
                ResolvedSpinBoundaryFaceIR {
                    source_id: "y_max".into(),
                    face: StructuredBoundaryFaceIR::YMax,
                    condition: ResolvedSpinBoundaryConditionIR::SpinInsulating,
                },
            ],
            interfaces: vec![],
            torque_target_cells: vec![false; cells],
            saturation_magnetization_apm: vec![8.0e5; cells],
            gamma_e_rad_per_s_t: 1.760_859_630_23e11,
            linear_solver: LinearTransportSolverPolicyIR {
                relative_tolerance: 1.0e-11,
                absolute_tolerance: 1.0e-14,
                max_iterations: 2_000,
            },
            nonlinear_solver: ReciprocalNonlinearSolverPolicyIR {
                gmres_restart: 40,
                max_picard_iterations: 4,
                relative_update_tolerance: 1.0e-9,
                eta_transport: 0.25,
            },
            operator_version: "fdm_coupled_charge_spin_fv_block_gmres.v1".into(),
            physical_residual_version: PHYSICAL_RESIDUAL_VERSION.into(),
            constitutive_version: M2_CONSTITUTIVE_VERSION.into(),
            torque_formula_version: None,
            oersted_source_bound: false,
        };
        FdmPlanIR {
            grid: GridDimensions {
                cells: [1, 1, nz as u32],
            },
            cell_size: [1.0, 0.1, 1.0 / nz as f64],
            active_mask: Some(vec![true; cells]),
            initial_magnetization: vec![[0.0, 0.0, 1.0]; cells],
            spin_transport_plans: vec![ResolvedSpinTransportPlanIR {
                module_id: "spin".into(),
                current_source_id: "charge".into(),
                resolved_coupling: TransportCouplingIR::Bidirectional,
                requested_execution: RequestedTransportExecutionIR {
                    discretization: BackendTarget::Fdm,
                    device: ExecutionDevice::Cpu,
                    precision: ExecutionPrecision::Double,
                    execution_mode: ExecutionMode::Strict,
                },
                resolved_discretization: BackendTarget::Fdm,
                resolved_device: ExecutionDevice::Cpu,
                resolved_precision: ExecutionPrecision::Double,
                constitutive_version: M2_CONSTITUTIVE_VERSION.into(),
                operator_version: "fdm_coupled_charge_spin_fv_block_gmres.v1".into(),
                physical_residual_version: PHYSICAL_RESIDUAL_VERSION.into(),
                capabilities: vec![
                    "transport.charge.magnetoresistive".into(),
                    "transport.spin.steady_drift_diffusion".into(),
                    "transport.coupling.bidirectional".into(),
                ],
                inserted_default_boundaries: vec![],
                fdm_cpu_double: None,
                fdm_cpu_double_reciprocal: Some(descriptor),
                fdm_cpu_double_transient: None,
                fem_cpu_double: None,
            }],
            ..FdmPlanIR::default()
        }
    }

    fn common_reciprocal_m2_fem_mesh(nz: usize) -> MeshIR {
        let node = |x: usize, y: usize, z: usize| -> u32 { (z * 4 + y * 2 + x) as u32 };
        let mut nodes = Vec::with_capacity((nz + 1) * 4);
        for z in 0..=nz {
            for y in 0..=1 {
                for x in 0..=1 {
                    nodes.push([x as f64, 0.1 * y as f64, z as f64 / nz as f64]);
                }
            }
        }
        let mut elements = Vec::with_capacity(nz * 6);
        let mut element_markers = Vec::with_capacity(nz * 6);
        let mut boundary_faces = Vec::with_capacity(nz * 8 + 4);
        let mut boundary_markers = Vec::with_capacity(nz * 8 + 4);
        for z in 0..nz {
            let a = node(0, 0, z);
            let b = node(1, 0, z);
            let c = node(1, 1, z);
            let d = node(0, 1, z);
            let e = node(0, 0, z + 1);
            let f = node(1, 0, z + 1);
            let g = node(1, 1, z + 1);
            let h = node(0, 1, z + 1);
            elements.extend([
                [a, b, c, g],
                [a, c, d, g],
                [a, d, h, g],
                [a, h, e, g],
                [a, e, f, g],
                [a, f, b, g],
            ]);
            element_markers.extend((0..6).map(|_| 1));

            let mut add_face = |face: [u32; 3], marker: u32| {
                boundary_faces.push(face);
                boundary_markers.push(marker);
            };
            if z == 0 {
                add_face([a, b, c], 1);
                add_face([a, c, d], 1);
            }
            if z + 1 == nz {
                add_face([e, f, g], 2);
                add_face([e, g, h], 2);
            }
            add_face([a, d, h], 3);
            add_face([a, h, e], 3);
            add_face([b, c, g], 3);
            add_face([b, g, f], 3);
            add_face([a, e, f], 3);
            add_face([a, f, b], 3);
            add_face([c, d, g], 3);
            add_face([d, h, g], 3);
        }
        MeshIR::from_legacy_tet4(
            "reciprocal-m2-common-limit".into(),
            nodes,
            elements,
            element_markers,
            boundary_faces,
            boundary_markers,
            vec![],
            vec![],
            HashMap::new(),
        )
    }

    #[test]
    fn reciprocal_m2_common_si_limit_matches_fdm_and_fem_reference_profiles() {
        if !crate::native_fem::is_cpu_available() {
            eprintln!(
                "skipping reciprocal M2 FDM↔FEM common-limit test: native FEM CPU unavailable"
            );
            return;
        }

        const SIGMA_SPM: f64 = 4.0;
        const SIGMA_SPIN_SPM: f64 = 5.0;
        const SIGMA_PARALLEL_SPM: f64 = 6.0;
        const SIGMA_PERPENDICULAR_SPM: f64 = 3.0;
        const POLARIZATION: f64 = 0.25;
        const LAMBDA_SF_M: f64 = 0.3;
        const SPIN_Z_MIN_V: f64 = 0.2;
        let mut resolution_errors = Vec::new();

        for nz in [8usize, 16, 32] {
            let fdm_plan = common_reciprocal_m2_fdm_plan(nz);
            let mut fdm_workflow =
                crate::fdm::cpu::spin_transport::FdmSpinTransportWorkflow::from_plan(&fdm_plan)
                    .expect("FDM reciprocal M2 common-limit workflow construction")
                    .expect("FDM reciprocal M2 common-limit workflow");
            let fdm_evaluation = fdm_workflow
                .evaluate_stage(&fdm_plan.initial_magnetization, 0.0)
                .expect("FDM reciprocal M2 common-limit solve");
            let fdm_module = &fdm_evaluation.modules[0];

            let fem_mesh = common_reciprocal_m2_fem_mesh(nz);
            let fem_request = NativeFemSteadyTransportRequest {
                mesh: fem_mesh.clone(),
                execution: NativeFemSteadyTransportExecution::CpuDouble,
                interface: NativeFemSteadyTransportInterface::TransparentConformingH1,
                gauge: NativeFemSteadyTransportGauge::BoundaryReference,
                constitutive_model: NativeFemSteadyTransportConstitutiveModel::ReciprocalM2,
                constitutive_version: M2_CONSTITUTIVE_VERSION.into(),
                operator_version: M2_OPERATOR_VERSION.into(),
                physical_residual_version: PHYSICAL_RESIDUAL_VERSION.into(),
                charge_conductivity_spm_per_element: vec![SIGMA_SPM; fem_mesh.cell_count()],
                magnetization: vec![[0.0, 0.0, 1.0]; fem_mesh.nodes.len()],
                sigma_s_spm: SIGMA_SPIN_SPM,
                sigma_parallel_spm: Some(SIGMA_PARALLEL_SPM),
                sigma_perpendicular_spm: Some(SIGMA_PERPENDICULAR_SPM),
                sigma_ahe_spm: Some(0.0),
                polarization_p: POLARIZATION,
                theta_sh: 0.0,
                lambda_sf_m: LAMBDA_SF_M,
                lambda_j_m: None,
                lambda_phi_m: None,
                gamma_e_per_ts: 1.760_859_630_23e11,
                saturation_magnetization_apm: 8.0e5,
                relative_tolerance: 1.0e-11,
                absolute_tolerance: 0.0,
                maximum_iterations: 2_000,
                charge_dirichlet: vec![(1, 1.0), (2, 0.0)],
                spin_dirichlet: vec![(1, [0.0, 0.0, SPIN_Z_MIN_V]), (2, [0.0, 0.0, 0.0])],
            };
            let fem_result = solve_native_fem_steady_transport(&fem_request)
                .expect("FEM reciprocal M2 common-limit solve");

            let plane_average = |values: &[[f64; 3]], plane: usize, component: usize| -> f64 {
                let start = plane * 4;
                values[start..start + 4]
                    .iter()
                    .map(|value| value[component])
                    .sum::<f64>()
                    / 4.0
            };
            let scalar_plane_average = |values: &[f64], plane: usize| -> f64 {
                let start = plane * 4;
                values[start..start + 4].iter().sum::<f64>() / 4.0
            };

            assert!(
                fdm_module.telemetry.spin_scaled_residual < 1.0e-10,
                "FDM reciprocal M2 spin residual is too large at Nz={nz}: {}",
                fdm_module.telemetry.spin_scaled_residual
            );
            assert!(
                fdm_module
                    .telemetry
                    .charge_balance_relative
                    .unwrap_or(f64::INFINITY)
                    < 1.0e-10,
                "FDM reciprocal M2 charge balance is too large at Nz={nz}: {:?}",
                fdm_module.telemetry.charge_balance_relative
            );
            assert!(
                fem_result.charge_relative_residual < 1.0e-10
                    && fem_result.spin_relative_residual < 1.0e-10,
                "FEM reciprocal M2 residual is too large at Nz={nz}: charge={}, spin={}",
                fem_result.charge_relative_residual,
                fem_result.spin_relative_residual
            );

            let mut max_potential_difference: f64 = 0.0;
            let mut max_spin_difference: f64 = 0.0;
            for z in 0..nz {
                let fem_potential = 0.5
                    * (scalar_plane_average(&fem_result.electric_potential_v, z)
                        + scalar_plane_average(&fem_result.electric_potential_v, z + 1));
                let fem_spin = 0.5
                    * (plane_average(&fem_result.spin_potential_xyz_v, z, 2)
                        + plane_average(&fem_result.spin_potential_xyz_v, z + 1, 2));
                max_potential_difference = max_potential_difference
                    .max((fdm_module.potential_volts[z] - fem_potential).abs());
                max_spin_difference = max_spin_difference
                    .max((fdm_module.spin_potential_volts[z][2] - fem_spin).abs());
            }
            eprintln!(
                "M2 reciprocal common SI Nz={nz}: potential={max_potential_difference:e}, spin={max_spin_difference:e}"
            );
            resolution_errors.push((nz, max_potential_difference, max_spin_difference));
        }

        for pair in resolution_errors.windows(2) {
            assert!(
                pair[1].1 < pair[0].1 && pair[1].2 < pair[0].2,
                "reciprocal M2 FDM↔FEM profiles must converge under Nz refinement: coarse={:?}, fine={:?}",
                pair[0],
                pair[1]
            );
        }
        assert!(
            resolution_errors.last().unwrap().1 < 1.0e-2
                && resolution_errors.last().unwrap().2 < 1.0e-2,
            "reciprocal M2 FDM↔FEM common-limit envelope is too large at fine Nz: {:?}",
            resolution_errors.last().unwrap()
        );
    }

    #[test]
    fn direct_she_common_si_limit_matches_fdm_and_fem_reference_profiles() {
        if !crate::native_fem::is_cpu_available() {
            eprintln!(
                "skipping M1 direct-SHE FDM↔FEM common-limit test: native FEM CPU unavailable"
            );
            return;
        }

        const LENGTH_M: f64 = 1.0;
        const SIGMA_SPM: f64 = 3.0;
        const SIGMA_SPIN_SPM: f64 = 2.0;
        const THETA_SH: f64 = 0.1;
        const LAMBDA_SF_M: f64 = 0.2;
        const ELECTRIC_FIELD_V_PER_M: f64 = 1.0;

        let amplitude = 2.0 * THETA_SH * SIGMA_SPM * ELECTRIC_FIELD_V_PER_M * LAMBDA_SF_M
            / (SIGMA_SPIN_SPM * (0.5 * LENGTH_M / LAMBDA_SF_M).cosh());
        let mut resolution_errors = Vec::new();
        for nz in [8usize, 16, 32] {
            let fdm_plan = common_direct_she_fdm_plan(nz);
            let mut fdm_workflow =
                crate::fdm::cpu::spin_transport::FdmSpinTransportWorkflow::from_plan(&fdm_plan)
                    .expect("FDM common-limit workflow construction")
                    .expect("FDM common-limit workflow");
            let fdm_evaluation = fdm_workflow
                .evaluate_stage(&fdm_plan.initial_magnetization, 0.0)
                .expect("FDM direct-SHE common-limit solve");
            let fdm_module = &fdm_evaluation.modules[0];

            let fem_mesh = common_direct_she_fem_mesh(nz);
            let fem_request = NativeFemSteadyTransportRequest {
                mesh: fem_mesh.clone(),
                execution: NativeFemSteadyTransportExecution::CpuDouble,
                interface: NativeFemSteadyTransportInterface::TransparentConformingH1,
                gauge: NativeFemSteadyTransportGauge::BoundaryReference,
                constitutive_model: NativeFemSteadyTransportConstitutiveModel::OneWay,
                constitutive_version: CONSTITUTIVE_VERSION.into(),
                operator_version: OPERATOR_VERSION.into(),
                physical_residual_version: PHYSICAL_RESIDUAL_VERSION.into(),
                charge_conductivity_spm_per_element: vec![SIGMA_SPM; fem_mesh.cell_count()],
                magnetization: vec![[0.0, 0.0, 1.0]; fem_mesh.nodes.len()],
                sigma_s_spm: SIGMA_SPIN_SPM,
                sigma_parallel_spm: None,
                sigma_perpendicular_spm: None,
                sigma_ahe_spm: None,
                polarization_p: 0.0,
                theta_sh: THETA_SH,
                lambda_sf_m: LAMBDA_SF_M,
                lambda_j_m: None,
                lambda_phi_m: None,
                gamma_e_per_ts: 1.760_859_630_23e11,
                saturation_magnetization_apm: 8.0e5,
                relative_tolerance: 1.0e-11,
                absolute_tolerance: 0.0,
                maximum_iterations: 2000,
                charge_dirichlet: vec![(1, 0.5), (2, -0.5)],
                spin_dirichlet: vec![],
            };
            let fem_result = solve_native_fem_steady_transport(&fem_request)
                .expect("FEM direct-SHE common-limit solve");

            let plane_nodes = 4usize;
            let fem_plane_average = |plane: usize| -> f64 {
                let start = plane * plane_nodes;
                fem_result.spin_potential_xyz_v[start..start + plane_nodes]
                    .iter()
                    .map(|value| value[1])
                    .sum::<f64>()
                    / plane_nodes as f64
            };

            assert!(
                (fem_result.current_density_volume_average_apm2[0]
                    - SIGMA_SPM * ELECTRIC_FIELD_V_PER_M)
                    .abs()
                    < 1.0e-9,
                "FEM common-limit charge current has wrong SI value at Nz={nz}: {:?}",
                fem_result.current_density_volume_average_apm2
            );
            assert!(
                fdm_module.telemetry.spin_scaled_residual < 1.0e-10,
                "FDM common-limit spin residual is too large at Nz={nz}: {}",
                fdm_module.telemetry.spin_scaled_residual
            );
            assert!(
                fem_result.spin_relative_residual < 1.0e-10,
                "FEM common-limit spin residual is too large at Nz={nz}: {}",
                fem_result.spin_relative_residual
            );

            let mut max_relative_profile_difference: f64 = 0.0;
            let mut max_fdm_oracle_error: f64 = 0.0;
            let mut max_fem_oracle_error: f64 = 0.0;
            let dz = LENGTH_M / nz as f64;
            for z in 0..nz {
                let coordinate = (z as f64 + 0.5) * dz - 0.5 * LENGTH_M;
                let expected = amplitude * (coordinate / LAMBDA_SF_M).sinh();
                let fdm_value = fdm_module.spin_potential_volts[z][1];
                let fem_value = 0.5 * (fem_plane_average(z) + fem_plane_average(z + 1));
                max_fdm_oracle_error = max_fdm_oracle_error.max((fdm_value - expected).abs());
                max_fem_oracle_error = max_fem_oracle_error.max((fem_value - expected).abs());
                let scale = expected
                    .abs()
                    .max(fdm_value.abs())
                    .max(fem_value.abs())
                    .max(1.0e-12);
                max_relative_profile_difference =
                    max_relative_profile_difference.max((fdm_value - fem_value).abs() / scale);
            }

            assert!(
                max_fdm_oracle_error < 2.0e-3 && max_fem_oracle_error < 2.0e-3,
                "common direct-SHE profiles miss the shared sinh oracle at Nz={nz}: FDM={max_fdm_oracle_error:e}, FEM={max_fem_oracle_error:e}"
            );
            assert!(
                max_relative_profile_difference < 5.0e-2,
                "FDM and FEM direct-SHE profiles differ beyond the common-limit envelope at Nz={nz}: {max_relative_profile_difference:e}"
            );
            assert!(
                fdm_module.spin_potential_volts[nz - 1][1] > 0.0 && fem_plane_average(nz) > 0.0,
                "common direct-SHE sign convention is not positive at the upper z face for Nz={nz}"
            );
            eprintln!(
                "M1 direct-SHE Nz={nz}: FDM oracle={max_fdm_oracle_error:e}, FEM oracle={max_fem_oracle_error:e}, cross={max_relative_profile_difference:e}"
            );
            resolution_errors.push((nz, max_fdm_oracle_error, max_fem_oracle_error));
        }

        for pair in resolution_errors.windows(2) {
            assert!(
                pair[1].1 < pair[0].1 && pair[1].2 < pair[0].2,
                "M1 direct-SHE profiles must converge under Nz refinement: coarse={:?}, fine={:?}",
                pair[0],
                pair[1]
            );
        }
    }

    #[test]
    #[cfg(feature = "fem-gpu")]
    fn native_m2_solver_publishes_reciprocal_diagnostics() {
        if !crate::native_fem::is_cpu_available() {
            eprintln!("skipping native FEM M2 runtime test: CPU MFEM stack unavailable");
            return;
        }
        let mut m2 = request();
        m2.constitutive_model = NativeFemSteadyTransportConstitutiveModel::ReciprocalM2;
        m2.constitutive_version = M2_CONSTITUTIVE_VERSION.into();
        m2.operator_version = M2_OPERATOR_VERSION.into();
        m2.sigma_parallel_spm = Some(4.0);
        m2.sigma_perpendicular_spm = Some(4.0);
        m2.sigma_ahe_spm = Some(0.0);
        m2.spin_dirichlet = vec![(1, [0.0, 0.0, 0.0])];
        let result = solve_native_fem_steady_transport(&m2)
            .expect("native FEM M2 request should execute");
        assert_eq!(
            result.diagnostics["constitutive_model"],
            serde_json::json!("reciprocal_m2")
        );
        assert_eq!(result.constitutive_version, M2_CONSTITUTIVE_VERSION);
        assert_eq!(result.operator_version, M2_OPERATOR_VERSION);
    }

    #[test]
    fn preflight_rejects_short_and_long_element_marker_vectors_before_ffi() {
        for markers in [vec![], vec![1, 1]] {
            let mut malformed = request();
            malformed.mesh.element_markers = markers;

            let error = preflight(&malformed)
                .expect_err("element marker count mismatch must fail before FFI");
            assert!(
                error.message.contains("element marker count"),
                "{}",
                error.message
            );
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
            flat.mesh.nodes_xyz,
            vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
        );
        assert_eq!(flat.mesh.cell_types, vec![ffi::FULLMAG_FEM_CELL_TET4]);
        assert_eq!(
            flat.magnetization,
            vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0]
        );
    }

    #[test]
    fn canonical_descriptor_materializes_exact_solver_policy_and_provenance() {
        let fixture = request();
        let resolved = resolved_plan();
        let mapped = materialize_native_fem_steady_transport_request(
            &fixture.mesh,
            &fixture.magnetization,
            &resolved,
        )
        .expect("canonical native request");
        assert_eq!(mapped.charge_conductivity_spm_per_element, [4.0]);
        assert_eq!(mapped.relative_tolerance, 1.0e-10);
        assert_eq!(mapped.maximum_iterations, 500);
        assert_eq!(mapped.charge_dirichlet, [(1, 1.0)]);
        let provenance = transport_provenance(&resolved).expect("transport provenance");
        assert_eq!(provenance.requested_discretization, "auto");
        assert_eq!(provenance.requested_device, "auto");
        assert_eq!(provenance.resolved_discretization, "fem");
        assert_eq!(provenance.resolved_device, "cpu");
        assert_eq!(provenance.resolved_execution_mode, "strict");
        assert_eq!(provenance.runtime_family, "fullmag_fem");
        assert_eq!(provenance.runtime_id, "fullmag_fem_managed");
        assert_eq!(provenance.engine_id, "fem_cpu_native");
        assert_eq!(provenance.charge_solver_engine, "cg");
        assert_eq!(provenance.spin_solver_engine, "gmres");
        assert_eq!(provenance.capability_status, "reference_executable");
        assert_eq!(provenance.implementation_state, "executable");
        assert_eq!(provenance.validation_state, "algebra_validated");
        assert_eq!(
            provenance.validation_scope,
            "fem_cpu_double_conforming_h1_p1_transparent_m1"
        );
        assert_eq!(
            provenance.inserted_default_boundaries,
            ["all_unassigned_external_surfaces"]
        );
        assert!(provenance.fallback.is_none());
        assert!(provenance.degradation.is_none());
        assert_eq!(provenance.stage_coupling, "none");
    }

    #[test]
    fn canonical_m2_descriptor_materializes_reciprocal_ffi_request() {
        let fixture = request();
        let resolved = resolved_m2_plan();
        let mapped = materialize_native_fem_steady_transport_request(
            &fixture.mesh,
            &fixture.magnetization,
            &resolved,
        )
        .expect("canonical native M2 request");
        assert_eq!(
            mapped.constitutive_model,
            NativeFemSteadyTransportConstitutiveModel::ReciprocalM2
        );
        assert_eq!(mapped.constitutive_version, M2_CONSTITUTIVE_VERSION);
        assert_eq!(mapped.operator_version, M2_OPERATOR_VERSION);
        assert_eq!(mapped.sigma_parallel_spm, Some(4.4));
        assert_eq!(mapped.sigma_perpendicular_spm, Some(4.0));
        assert_eq!(mapped.sigma_ahe_spm, Some(0.2));
        preflight(&mapped).expect("bounded M2 request preflight");
    }

    #[test]
    fn canonical_current_source_duplicates_and_mutations_fail_preflight() {
        let resolved = resolved_plan();
        let descriptor = resolved.fem_cpu_double.as_ref().unwrap();
        let source = fullmag_ir::CurrentModuleIR::CurrentTransport {
            name: resolved.current_source_id.clone(),
            model: fullmag_ir::CurrentTransportModelIR::OhmicPoisson,
            current_density: None,
            solve_region: None,
            conductivity_s_per_m: None,
            coupling: TransportCouplingIR::OneWay,
            definition: Some(descriptor.charge_definition.clone()),
        };
        descriptor::validate_bound_current_source_modules(
            &[source.clone(), source.clone()],
            &resolved,
        )
        .expect_err("duplicate canonical source must fail before native execution");

        let mut mutated = source;
        let fullmag_ir::CurrentModuleIR::CurrentTransport {
            definition: Some(definition),
            ..
        } = &mut mutated
        else {
            unreachable!()
        };
        definition.solver.linear.max_iterations += 1;
        descriptor::validate_bound_current_source_modules(&[mutated], &resolved)
            .expect_err("mutated canonical source must fail before native execution");
    }

    #[test]
    fn multiple_transport_modules_fail_before_native_execution() {
        let mut plan = crate::dispatch::test_tiny_fem_plan();
        let first = resolved_plan();
        let mut second = first.clone();
        second.module_id = "spin-2".into();
        second.current_source_id = "charge-2".into();
        let source = |resolved: &ResolvedSpinTransportPlanIR| {
            let descriptor = resolved.fem_cpu_double.as_ref().expect("FEM descriptor");
            fullmag_ir::CurrentModuleIR::CurrentTransport {
                name: resolved.current_source_id.clone(),
                model: fullmag_ir::CurrentTransportModelIR::OhmicPoisson,
                current_density: None,
                solve_region: None,
                conductivity_s_per_m: None,
                coupling: TransportCouplingIR::OneWay,
                definition: Some(descriptor.charge_definition.clone()),
            }
        };
        plan.current_modules = vec![source(&first), source(&second)];
        plan.spin_transport_plans = vec![first, second];

        let error = match descriptor::preflight_transport_plans(&plan) {
            Ok(_) => panic!("quantity-scoped M1 publication must reject multiple modules"),
            Err(error) => error,
        };
        assert!(
            error.message.contains("exactly one module"),
            "{}",
            error.message
        );
    }

    #[test]
    fn contradictory_resolved_descriptor_fails_before_native_call() {
        let fixture = request();
        let mut resolved = resolved_plan();
        resolved
            .fem_cpu_double
            .as_mut()
            .expect("FEM descriptor")
            .stage_coupling = "llg_stage".into();
        let error = materialize_native_fem_steady_transport_request(
            &fixture.mesh,
            &fixture.magnetization,
            &resolved,
        )
        .expect_err("unproven stage coupling must fail closed");
        assert!(error.message.contains("contradictory resolved descriptor"));
    }

    #[test]
    fn resolved_descriptor_mesh_masks_and_boundary_attributes_fail_closed() {
        assert_descriptor_contradiction("charge mask must cover the native mesh", |plan| {
            plan.fem_cpu_double
                .as_mut()
                .unwrap()
                .charge_domain
                .element_mask[0] = false;
        });
        assert_descriptor_contradiction("spin mask must match the native mesh", |plan| {
            plan.fem_cpu_double
                .as_mut()
                .unwrap()
                .spin_domain
                .element_mask
                .clear();
        });
        assert_descriptor_contradiction("conductivity must match the native mesh", |plan| {
            plan.fem_cpu_double
                .as_mut()
                .unwrap()
                .charge_conductivity_spm_per_element
                .push(4.0);
        });
        assert_descriptor_contradiction(
            "boundary attributes must exist on the native mesh",
            |plan| {
                plan.fem_cpu_double.as_mut().unwrap().charge_dirichlet = vec![(99, 1.0)];
            },
        );
        assert_descriptor_contradiction("torque target must select native mesh elements", |plan| {
            let descriptor = plan.fem_cpu_double.as_mut().unwrap();
            descriptor.torque_target = Some(fullmag_ir::ResolvedFemTorqueTargetIR {
                torque_module_id: "torque".into(),
                target: descriptor.charge_domain.regions[0].clone(),
                element_mask: vec![false],
                formula_version: "drift_diffusion.fullmag.v1".into(),
            });
        });
    }

    fn assert_descriptor_contradiction(
        label: &str,
        mutate: impl FnOnce(&mut ResolvedSpinTransportPlanIR),
    ) {
        let fixture = request();
        let mut resolved = resolved_plan();
        mutate(&mut resolved);
        let error = materialize_native_fem_steady_transport_request(
            &fixture.mesh,
            &fixture.magnetization,
            &resolved,
        )
        .unwrap_err();
        assert!(
            error.message.contains("contradictory resolved descriptor"),
            "{label}: {}",
            error.message
        );
    }

    #[test]
    fn resolved_descriptor_mutations_fail_closed_by_contradiction_class() {
        assert_descriptor_contradiction("reciprocal descriptor/coupling", |plan| {
            plan.resolved_coupling = TransportCouplingIR::Bidirectional;
        });
        assert_descriptor_contradiction("top level constitutive version", |plan| {
            plan.constitutive_version = "transport_constitutive.reciprocal.fullmag.v1".into();
        });
        assert_descriptor_contradiction("embedded spin operator version", |plan| {
            plan.fem_cpu_double
                .as_mut()
                .unwrap()
                .spin_solver
                .operator_version = "other".into();
        });
        assert_descriptor_contradiction("embedded spin residual version", |plan| {
            plan.fem_cpu_double
                .as_mut()
                .unwrap()
                .spin_solver
                .physical_residual_version = "other".into();
        });
        assert_descriptor_contradiction("interface law", |plan| {
            plan.fem_cpu_double.as_mut().unwrap().interface_law = "mixing".into();
        });
        assert_descriptor_contradiction("incompatible shared solver policy", |plan| {
            plan.fem_cpu_double
                .as_mut()
                .unwrap()
                .charge_solver
                .linear
                .max_iterations = 1;
        });
        assert_descriptor_contradiction("execution mode", |plan| {
            plan.requested_execution.execution_mode = ExecutionMode::Extended;
        });
    }

    #[test]
    fn native_result_publishes_canonical_transport_quantity_fields() {
        let resolved = resolved_plan();
        let result = NativeFemSteadyTransportResult {
            electric_potential_v: vec![1.0, 2.0],
            charge_current_density_xyz_apm2: vec![[3.0, 4.0, 5.0]; 2],
            spin_potential_xyz_v: vec![[6.0, 7.0, 8.0]; 2],
            spin_current_tensor_row_major_qia_apm2: vec![[9.0; 9]; 2],
            torque_xyz_per_s: vec![[10.0, 11.0, 12.0]; 2],
            charge_iterations: 1,
            charge_relative_residual: 0.0,
            net_boundary_current_a: 0.0,
            current_density_volume_average_apm2: [0.0; 3],
            spin_iterations: 1,
            spin_relative_residual: 0.0,
            boundary_spin_flux_a: [0.0; 3],
            reaction_integral_a: [0.0; 3],
            angular_momentum_balance_apm2: [0.0; 3],
            torque_volume_average_per_s: [0.0; 3],
            torque_l2_per_s: 0.0,
            diagnostics: serde_json::json!({}),
            constitutive_version: CONSTITUTIVE_VERSION.into(),
            operator_version: OPERATOR_VERSION.into(),
            physical_residual_version: PHYSICAL_RESIDUAL_VERSION.into(),
            resolved_execution: "fem_cpu_double".into(),
            resolved_interface: "transparent_conforming_h1".into(),
        };

        let fields = transport_field_snapshots(&resolved, &result, 1).expect("quantity fields");
        assert_eq!(
            fields
                .iter()
                .map(|field| field.name.as_str())
                .collect::<Vec<_>>(),
            [
                "V_electric",
                "J_charge",
                "spin_potential",
                "spin_current_tensor",
                "torque_stt",
            ]
        );
        assert_eq!(fields[0].component_count, 1);
        assert_eq!(fields[1].component_count, 3);
        assert_eq!(fields[3].component_count, 9);
        assert_eq!(fields[3].component_order, "row_major_Q_ia");
        assert!(fields.iter().all(|field| field.location == "node"));
        assert_eq!(
            fields
                .iter()
                .map(|field| field.revision)
                .collect::<Vec<_>>(),
            [1, 2, 3, 4, 5]
        );
        assert!(fields
            .iter()
            .all(|field| field.scope == "transport_module:spin:full_solve_domain"));
    }
}

#[cfg(test)]
pub(crate) use tests::resolved_plan as test_resolved_plan;
