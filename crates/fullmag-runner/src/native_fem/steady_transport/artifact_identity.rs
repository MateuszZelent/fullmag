//! Mandatory identities of the actual prepared solve, independent of caller-supplied IR files.
use super::{NativeFemSteadyTransportRequest, NativeFemSteadyTransportExecution,
    NativeFemSteadyTransportInterface, NativeFemSteadyTransportGauge,
    NativeFemSteadyTransportConstitutiveModel};
use crate::types::RunError;
use serde_json::{Value, json};

pub(super) fn tagged_json_digest(value: &Value) -> Result<String, RunError> {
    fullmag_ir::transport_identity::tagged_json_digest(value)
        .map_err(|message| RunError { message })
}

pub(super) fn actual_transport_identity(
    request: &NativeFemSteadyTransportRequest,
    module_id: &str,
    current_source_id: &str,
    descriptor: &Value,
    result: &Value,
) -> Result<Value, RunError> {
    let mesh_digest = request.mesh.mixed_topology_fingerprint_v3()
        .map_err(|message| RunError { message })?;
    let payload = json!({
        "module_id": module_id, "current_source_id": current_source_id,
        "mesh_name": request.mesh.mesh_name,
        "mesh_topology_sha256": mesh_digest,
        "node_carrier": "ordered_mesh_nodes_u32.v1",
        "node_count": request.mesh.nodes.len(),
        "cell_count": request.mesh.cell_count(),
        "execution": match request.execution { NativeFemSteadyTransportExecution::CpuDouble => "fem_cpu_double",
            NativeFemSteadyTransportExecution::GpuDouble => "fem_gpu_double" },
        "interface": match request.interface { NativeFemSteadyTransportInterface::TransparentConformingH1 => "transparent_conforming_h1",
            NativeFemSteadyTransportInterface::MixingBrokenH1 => "mixing_broken_h1" },
        "gauge": match request.gauge { NativeFemSteadyTransportGauge::BoundaryReference => "boundary_reference",
            NativeFemSteadyTransportGauge::ZeroMeanPotential => "zero_mean_potential" },
        "constitutive_model": match request.constitutive_model { NativeFemSteadyTransportConstitutiveModel::OneWay => "one_way",
            NativeFemSteadyTransportConstitutiveModel::ReciprocalM2 => "reciprocal_m2" },
        "constitutive_version": request.constitutive_version,
        "operator_version": request.operator_version,
        "physical_residual_version": request.physical_residual_version,
        "charge_conductivity_Spm_per_element": request.charge_conductivity_spm_per_element,
        "magnetization": request.magnetization,
        "sigma_s_Spm": request.sigma_s_spm,
        "sigma_parallel_Spm": request.sigma_parallel_spm,
        "sigma_perpendicular_Spm": request.sigma_perpendicular_spm,
        "sigma_ahe_Spm": request.sigma_ahe_spm,
        "polarization_p": request.polarization_p,
        "theta_sh": request.theta_sh,
        "lambda_sf_m": if request.lambda_sf_m == f64::INFINITY { json!("disabled") } else { json!(request.lambda_sf_m) },
        "lambda_j_m": request.lambda_j_m,
        "lambda_phi_m": request.lambda_phi_m,
        "gamma_e_per_Ts": request.gamma_e_per_ts,
        "saturation_magnetization_Apm": request.saturation_magnetization_apm,
        "relative_tolerance": request.relative_tolerance,
        "absolute_tolerance": request.absolute_tolerance,
        "maximum_iterations": request.maximum_iterations,
        "charge_dirichlet": request.charge_dirichlet,
        "spin_dirichlet": request.spin_dirichlet,
    });
    Ok(json!({
        "schema": "fullmag.fem.steady_transport_identity.v1",
        "digest_codec": "fullmag.transport_tagged_json.v1",
        "mesh_topology_codec": "fullmag.fem_mesh_topology_fingerprint.v3",
        "request": payload,
        "request_sha256": tagged_json_digest(&payload)?,
        "descriptor_sha256": tagged_json_digest(descriptor)?,
        "result_sha256": tagged_json_digest(result)?,
    }))
}
