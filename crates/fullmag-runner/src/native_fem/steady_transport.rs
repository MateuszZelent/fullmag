use crate::types::{AuxiliaryArtifact, FieldSnapshot, RunError, TransportExecutionProvenance};
use fullmag_fem_sys as ffi;
use fullmag_ir::{
    ConservativeCurrentBoundaryRoleIR, ConservativeCurrentClosureIR, FemCellTypeIR, FemPlanIR,
    MeshIR, ResolvedFemConservativeCurrentViewIR,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::ffi::{CStr, CString};
use std::f64::consts::PI;
use std::ptr;

const CONSTITUTIVE_VERSION: &str = "transport_constitutive.one_way.fullmag.v1";
const OPERATOR_VERSION: &str = "fem_charge_spin_conforming_h1_p1.transparent.v1";
const M2_CONSTITUTIVE_VERSION: &str = "transport_constitutive.reciprocal.fullmag.v1";
const M2_OPERATOR_VERSION: &str = "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1";
const PHYSICAL_RESIDUAL_VERSION: &str = "transport_balance_integrated_l2.v1";

mod descriptor;
mod provenance;
mod publication;
mod stage_cache;

use descriptor::preflight_transport_plans;
use publication::transport_field_snapshots;
use stage_cache::{
    validate_plan as validate_stage_cache_plan, SteadySourceStageCoordinator,
    STEADY_SOURCE_CACHE_POLICY,
};

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

#[derive(Debug, Clone)]
pub(crate) struct NativeFemSteadyTransportRt0Result {
    pub rt0_dof_values: Vec<f64>,
    pub canonical_face_records: Vec<([u64; 3], f64)>,
    pub max_element_divergence_a: f64,
    pub max_internal_face_jump_a: f64,
    pub net_outer_flux_a: f64,
    pub electrode_balance_relative: f64,
    pub max_closure_interface_mismatch_a: f64,
    pub scaled_kkt_residual: f64,
    pub correction_norm_mw: f64,
    pub operator_version: String,
    pub fe_space: String,
    pub flux_unit: String,
    pub canonical_face_digest: String,
    pub balance_certificate_digest: String,
    pub view_identity_digest: String,
    pub diagnostics: Value,
    pub oersted_h_xyz_apm: Option<Vec<f64>>,
    pub oersted_operator_version: Option<String>,
    pub oersted_source_view_identity_digest: Option<String>,
    pub oersted_source_target_pairs: Option<u64>,
    pub oersted_refined_pairs: Option<u64>,
    pub oersted_unconverged_pair_count: Option<u64>,
    pub oersted_maximum_pair_error_apm: Option<f64>,
    pub oersted_diagnostics: Option<Value>,
}

pub(crate) struct NativeFemSteadyTransportBundle {
    pub artifacts: Vec<AuxiliaryArtifact>,
    pub field_snapshots: Vec<FieldSnapshot>,
    pub provenance: Vec<TransportExecutionProvenance>,
    /// Optional field derived from the solved FEM charge current.  This is
    /// kept outside `FemPlanIR` until charge has converged, so a stale or
    /// prescribed current cannot be mistaken for the solved source.
    pub oersted_field_xyz: Option<Vec<f64>>,
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
    let mut oersted_field_xyz: Option<Vec<f64>> = None;
    let mut aggregate_oersted_source_kinds = Vec::new();
    let mut steady_source_stages = SteadySourceStageCoordinator::default();
    for prepared in prepared {
        let resolved = prepared.resolved;
        let stage_cache_key = validate_stage_cache_plan(resolved)?;
        let oersted_targets = resolved
            .fem_cpu_double
            .as_ref()
            .filter(|descriptor| descriptor.oersted_source_bound)
            .map(|_| plan.mesh.nodes.as_slice());
        let rt0_view = if let Some(view) = resolved
            .fem_cpu_double
            .as_ref()
            .and_then(|descriptor| descriptor.conservative_current_view.as_ref())
        {
            Some(solve_native_fem_steady_transport_rt0(
                &prepared.request,
                view,
                oersted_targets,
            )?)
        } else {
            None
        };
        let result = solve_native_fem_steady_transport(&prepared.request)?;
        let mut transport_provenance = prepared.provenance;
        let mut module_oersted_field_xyz = None;
        if let Some(rt0) = rt0_view.as_ref() {
            transport_provenance.conservative_current_view_identity_digest =
                Some(rt0.view_identity_digest.clone());
            transport_provenance.conservative_current_balance_certificate_digest =
                Some(rt0.balance_certificate_digest.clone());
            if let Some(key) = stage_cache_key.as_ref() {
                steady_source_stages.begin_attempt()?;
                let initial_observation = steady_source_stages
                    .observe_stage(key, &rt0.view_identity_digest)?;
                if initial_observation == stage_cache::CacheObservation::Miss {
                    steady_source_stages.publish_solve(
                        key.clone(),
                        rt0.view_identity_digest.clone(),
                    )?;
                }
                // Bind the first RHS explicitly. A future native stage
                // callback must repeat this identity check before reusing the
                // immutable source; a changed key cannot cross the boundary.
                let observation = steady_source_stages
                    .observe_stage(key, &rt0.view_identity_digest)?;
                steady_source_stages.accept_attempt()?;
                transport_provenance.stage_cache_policy =
                    Some(STEADY_SOURCE_CACHE_POLICY.into());
                transport_provenance.stage_cache_key_digest = Some(key.digest());
                transport_provenance.stage_cache_last_observation =
                    Some(format!("{observation:?}").to_ascii_lowercase());
                transport_provenance.stage_cache_hit_count =
                    Some(steady_source_stages.cache().hits());
                transport_provenance.stage_cache_miss_count =
                    Some(steady_source_stages.cache().misses());
                transport_provenance.stage_cache_invalidation_count =
                    Some(steady_source_stages.cache().invalidations());
            }
        }
        if let Some(descriptor) = resolved.fem_cpu_double.as_ref() {
            if descriptor.oersted_source_bound {
                if let Some(rt0) = rt0_view.as_ref() {
                    let field = rt0.oersted_h_xyz_apm.as_ref().ok_or_else(|| RunError {
                        message: format!(
                            "FEM conservative RT0 source '{}' did not publish OE-F1 field (view_identity_digest={})",
                            resolved.current_source_id, rt0.view_identity_digest
                        ),
                    })?;
                    if field.len() != plan.mesh.nodes.len() * 3 {
                        return Err(RunError {
                            message: format!(
                                "FEM OE-F1 field length {} does not match {} target mesh nodes",
                                field.len(),
                                plan.mesh.nodes.len()
                            ),
                        });
                    }
                    if field.iter().any(|value| !value.is_finite()) {
                        return Err(RunError {
                            message: "FEM OE-F1 field contains a non-finite value".into(),
                        });
                    }
                    let field_sha256 = sha256_f64_slice(field);
                    transport_provenance.oersted_source_kind =
                        Some("fem_conservative_current_rt0_view.v1".into());
                    transport_provenance.oersted_field_sha256 = Some(field_sha256);
                    module_oersted_field_xyz = Some(field.clone());
                    aggregate_oersted_source_kinds.push(
                        "fem_conservative_current_rt0_view.v1".to_string(),
                    );
                    add_flat_field(
                        oersted_field_xyz.get_or_insert_with(|| vec![0.0; field.len()]),
                        field,
                    )?;
                } else {
                    let field = solved_current_midpoint_biot_savart_field(
                        &plan.mesh,
                        &descriptor.charge_domain.element_mask,
                        &result.charge_current_density_xyz_apm2,
                    )?;
                    let field_sha256 = sha256_f64_slice(&field);
                    let current_sha256 = sha256_vec3_slice(&result.charge_current_density_xyz_apm2);
                    let mesh_source_sha256 = sha256_mesh_source(
                        &plan.mesh,
                        &descriptor.charge_domain.element_mask,
                    )?;
                    transport_provenance.oersted_source_kind =
                        Some("solved_current_h1_nodal_midpoint_reference".into());
                    transport_provenance.oersted_source_current_sha256 = Some(current_sha256);
                    transport_provenance.oersted_mesh_source_sha256 = Some(mesh_source_sha256);
                    transport_provenance.oersted_field_sha256 = Some(field_sha256);
                    module_oersted_field_xyz = Some(field.clone());
                    aggregate_oersted_source_kinds.push(
                        "solved_current_h1_nodal_midpoint_reference".to_string(),
                    );
                    add_flat_field(
                        oersted_field_xyz.get_or_insert_with(|| vec![0.0; field.len()]),
                        &field,
                    )?;
                }
            }
        }
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
            "stage_cache": stage_cache_key.as_ref().map(|key| serde_json::json!({
                "policy": STEADY_SOURCE_CACHE_POLICY,
                "key_digest": key.digest(),
                "rhs_reuse": "same immutable source view for every magnetic RHS",
                "rejected_step": "does_not_publish",
                "final_refresh": "required_if_key_changes",
                "hit_count": steady_source_stages.cache().hits(),
                "miss_count": steady_source_stages.cache().misses(),
                "invalidation_count": steady_source_stages.cache().invalidations(),
            })),
            "oersted": module_oersted_field_xyz.as_ref().map(|field| {
                let direct_rt0 = rt0_view.as_ref().is_some_and(|view| {
                    view.oersted_h_xyz_apm.is_some()
                });
                serde_json::json!({
                    "source_kind": if direct_rt0 {
                        "fem_conservative_current_rt0_view.v1"
                    } else {
                        "solved_current_h1_nodal_midpoint_reference"
                    },
                    "realization": if direct_rt0 {
                        "direct_tetra_quadrature"
                    } else {
                        "biot_savart_midpoint"
                    },
                    "location": "node",
                    "component_order": "xyz",
                    "field_xyz": field,
                    "field_sha256": sha256_f64_slice(field),
                    "source_current_sha256": transport_provenance.oersted_source_current_sha256.clone(),
                    "mesh_source_sha256": transport_provenance.oersted_mesh_source_sha256.clone(),
                    "operator_version": rt0_view.as_ref().and_then(|view| view.oersted_operator_version.clone()),
                    "source_view_identity_digest": rt0_view.as_ref().and_then(|view| view.oersted_source_view_identity_digest.clone()),
                    "source_target_pairs": rt0_view.as_ref().and_then(|view| view.oersted_source_target_pairs),
                    "refined_pairs": rt0_view.as_ref().and_then(|view| view.oersted_refined_pairs),
                    "unconverged_pair_count": rt0_view.as_ref().and_then(|view| view.oersted_unconverged_pair_count),
                    "maximum_pair_error_apm": rt0_view.as_ref().and_then(|view| view.oersted_maximum_pair_error_apm),
                    "diagnostics": rt0_view.as_ref().and_then(|view| view.oersted_diagnostics.clone()),
                })
            }),
            "conservative_current_rt0": rt0_view.as_ref().map(|view| {
                serde_json::json!({
                    "source_kind": "fem_conservative_current_rt0_view.v1",
                    "operator_version": view.operator_version,
                    "fe_space": view.fe_space,
                    "flux_unit": view.flux_unit,
                    "rt0_dof_values": view.rt0_dof_values,
                    "canonical_face_records": view.canonical_face_records.iter().map(|(ids, flux)| serde_json::json!({"face_vertex_ids": ids, "flux_a": flux})).collect::<Vec<_>>(),
                    "max_element_divergence_a": view.max_element_divergence_a,
                    "max_internal_face_jump_a": view.max_internal_face_jump_a,
                    "net_outer_flux_a": view.net_outer_flux_a,
                    "electrode_balance_relative": view.electrode_balance_relative,
                    "max_closure_interface_mismatch_a": view.max_closure_interface_mismatch_a,
                    "scaled_kkt_residual": view.scaled_kkt_residual,
                    "correction_norm_mw": view.correction_norm_mw,
                    "canonical_face_digest": view.canonical_face_digest,
                    "balance_certificate_digest": view.balance_certificate_digest,
                    "view_identity_digest": view.view_identity_digest,
                    "diagnostics": view.diagnostics,
                })
            }),
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
        provenance.push(transport_provenance);
    }
    let aggregate_oersted = oersted_field_xyz.as_ref().map(|field| {
        let direct_rt0 = aggregate_oersted_source_kinds.iter().all(|kind| {
            kind == "fem_conservative_current_rt0_view.v1"
        });
        let mixed_sources = aggregate_oersted_source_kinds
            .iter()
            .any(|kind| kind != aggregate_oersted_source_kinds.first().unwrap_or(kind));
        serde_json::json!({
            "source_kind": if mixed_sources {
                "mixed"
            } else if direct_rt0 {
                "fem_conservative_current_rt0_view.v1"
            } else {
                "solved_current_h1_nodal_midpoint_reference"
            },
            "realization": if mixed_sources {
                "mixed"
            } else if direct_rt0 {
                "direct_tetra_quadrature"
            } else {
                "biot_savart_midpoint"
            },
            "location": "node",
            "component_order": "xyz",
            "field_xyz": field,
            "field_sha256": sha256_f64_slice(field),
            "source_kinds": aggregate_oersted_source_kinds,
        })
    });
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({
        "schema": "fullmag.fem.steady_spin_transport.v2",
        "component_order": "row_major_Q_ia",
        "flow_axes": ["x", "y", "z"],
        "spin_axes": ["x", "y", "z"],
        "location": "node",
        "modules": records,
        "oersted": aggregate_oersted,
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
        oersted_field_xyz,
    }))
}

fn sha256_f64_slice(values: &[f64]) -> String {
    let mut hasher = Sha256::new();
    for value in values {
        hasher.update(value.to_le_bytes());
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn sha256_vec3_slice(values: &[[f64; 3]]) -> String {
    let mut hasher = Sha256::new();
    for value in values {
        for component in value {
            hasher.update(component.to_le_bytes());
        }
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn sha256_mesh_source(mesh: &MeshIR, source_element_mask: &[bool]) -> Result<String, RunError> {
    let payload = serde_json::to_vec(&(
        &mesh.mesh_name,
        &mesh.nodes,
        &mesh.cells,
        &mesh.element_markers,
        &mesh.facets,
        &mesh.boundary_markers,
        source_element_mask,
    ))
    .map_err(|error| RunError {
        message: format!("serialize FEM Oersted mesh source identity: {error}"),
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(payload)))
}

fn add_flat_field(target: &mut [f64], source: &[f64]) -> Result<(), RunError> {
    if target.len() != source.len() {
        return Err(RunError {
            message: "FEM solved-current Oersted fields have inconsistent node counts".into(),
        });
    }
    for (left, right) in target.iter_mut().zip(source) {
        *left += *right;
    }
    Ok(())
}

/// Bounded FEM reference realization used by the current transport lane.
/// The charge solve publishes a nodal H1 current projection; this helper
/// averages that field over each active tet4 and evaluates a regularized
/// midpoint Biot--Savart quadrature at every mesh node.  It is intentionally
/// separate from the future conservative RT0/H(curl) OE-F1/OE-F2 lanes.
fn solved_current_midpoint_biot_savart_field(
    mesh: &MeshIR,
    source_element_mask: &[bool],
    nodal_current_density: &[[f64; 3]],
) -> Result<Vec<f64>, RunError> {
    if source_element_mask.len() != mesh.cell_count() {
        return Err(RunError {
            message: "FEM solved-current Oersted source mask does not match mesh elements".into(),
        });
    }
    if nodal_current_density.len() != mesh.nodes.len()
        || nodal_current_density
            .iter()
            .flatten()
            .any(|value| !value.is_finite())
    {
        return Err(RunError {
            message: "FEM solved-current Oersted nodal current is missing or non-finite".into(),
        });
    }

    let mut field = vec![0.0; mesh.nodes.len() * 3];
    let prefactor = 1.0 / (4.0 * PI);
    for (element_index, active) in source_element_mask.iter().copied().enumerate() {
        if !active {
            continue;
        }
        if mesh.cells.types.get(element_index) != Some(&FemCellTypeIR::Tet4) {
            return Err(RunError {
                message: format!(
                    "FEM solved-current midpoint Oersted requires tet4 source elements; element {element_index} is not tet4"
                ),
            });
        }
        let element = mesh.cells.item_nodes(element_index).ok_or_else(|| RunError {
            message: format!(
                "FEM solved-current midpoint Oersted referenced missing element {element_index}"
            ),
        })?;
        if element.len() != 4 {
            return Err(RunError {
                message: format!(
                    "FEM solved-current midpoint Oersted element {element_index} has {} nodes, expected 4",
                    element.len()
                ),
            });
        }
        let mut current = [0.0; 3];
        let mut centroid = [0.0; 3];
        for node in element {
            let node_index = *node as usize;
            let position = mesh.nodes.get(node_index).ok_or_else(|| RunError {
                message: format!(
                    "FEM solved-current midpoint Oersted element {element_index} references missing node {node}"
                ),
            })?;
            let current_node = nodal_current_density[node_index];
            for axis in 0..3 {
                current[axis] += current_node[axis] * 0.25;
                centroid[axis] += position[axis] * 0.25;
            }
        }
        let p0 = mesh.nodes[element[0] as usize];
        let p1 = mesh.nodes[element[1] as usize];
        let p2 = mesh.nodes[element[2] as usize];
        let p3 = mesh.nodes[element[3] as usize];
        let d1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
        let d2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
        let d3 = [p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]];
        let cross = [
            d2[1] * d3[2] - d2[2] * d3[1],
            d2[2] * d3[0] - d2[0] * d3[2],
            d2[0] * d3[1] - d2[1] * d3[0],
        ];
        let volume = (d1[0] * cross[0] + d1[1] * cross[1] + d1[2] * cross[2]).abs() / 6.0;
        if !volume.is_finite() || volume <= 0.0 {
            continue;
        }
        let regularization_radius = ((3.0 * volume) / (4.0 * PI)).cbrt();
        let regularization_sq = regularization_radius * regularization_radius;
        for (node_index, point) in mesh.nodes.iter().enumerate() {
            let displacement = [
                point[0] - centroid[0],
                point[1] - centroid[1],
                point[2] - centroid[2],
            ];
            let radius_sq = displacement.iter().map(|value| value * value).sum::<f64>();
            let denominator = (radius_sq + regularization_sq).powf(1.5).max(1.0e-30);
            let coefficient = prefactor * volume / denominator;
            let contribution = [
                coefficient * (current[1] * displacement[2] - current[2] * displacement[1]),
                coefficient * (current[2] * displacement[0] - current[0] * displacement[2]),
                coefficient * (current[0] * displacement[1] - current[1] * displacement[0]),
            ];
            let base = node_index * 3;
            for axis in 0..3 {
                field[base + axis] += contribution[axis];
            }
        }
    }
    Ok(field)
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

fn c_string(value: &str, label: &str) -> Result<CString, RunError> {
    CString::new(value).map_err(|_| RunError {
        message: format!("FEM RT0 {label} contains NUL"),
    })
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

/// Execute the append-only closure-aware FEM transport ABI.  This wrapper
/// owns every pointed-to buffer for the duration of the call and returns the
/// immutable RT0 view metadata.  When target points are supplied, the
/// append-only OE-F1 ABI evaluates direct Biot--Savart on that same view; it
/// never projects the legacy H1 current into RT0.
pub(crate) fn solve_native_fem_steady_transport_rt0(
    request: &NativeFemSteadyTransportRequest,
    view: &ResolvedFemConservativeCurrentViewIR,
    target_points: Option<&[[f64; 3]]>,
) -> Result<NativeFemSteadyTransportRt0Result, RunError> {
    // The legacy H1 preflight rejects periodic topology because its old ABI
    // cannot represent a source cut.  The RT0 extension carries that closure
    // explicitly, so only remove the legacy rejection while retaining every
    // other validation gate.
    let mut preflight_request = request.clone();
    if matches!(
        &view.closure,
        ConservativeCurrentClosureIR::ClosedGeometry { .. }
    ) {
        preflight_request.mesh.periodic_boundary_pairs.clear();
        preflight_request.mesh.periodic_node_pairs.clear();
    }
    preflight(&preflight_request)?;
    if request.constitutive_model != NativeFemSteadyTransportConstitutiveModel::OneWay {
        return Err(RunError {
            message: "public FEM RT0 solved-current lane currently accepts only one-way steady transport; reciprocal M2 remains fail-closed".into(),
        });
    }
    if request.mesh.nodes.len() != view.stable_vertex_ids.len() {
        return Err(RunError {
            message: "FEM RT0 stable vertex identity count differs from the resolved mesh".into(),
        });
    }
    let flat = flatten(request);
    let packed_mesh = super::PackedNativeMesh::new(&request.mesh);
    let constitutive = c_string(&request.constitutive_version, "constitutive_version")?;
    let operator = c_string(&request.operator_version, "operator_version")?;
    let residual = c_string(&request.physical_residual_version, "physical_residual_version")?;
    let base = ffi::fullmag_fem_steady_transport_request_v1 {
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
        mesh: packed_mesh.descriptor(&request.mesh),
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

    let c_identity_source_module_id = c_string(
        &view.identity.source_module_id, "source_module_id")?;
    let c_identity_source_state_revision = c_string(
        &view.identity.source_state_revision, "source_state_revision")?;
    let c_identity_source_field_digest = c_string(
        &view.identity.source_field_digest, "source_field_digest")?;
    let c_identity_conductivity_digest = c_string(
        &view.identity.conductivity_digest, "conductivity_digest")?;
    let c_identity_mesh_revision = c_string(&view.identity.mesh_revision, "mesh_revision")?;
    let c_identity_topology_revision = c_string(
        &view.identity.topology_revision, "topology_revision")?;
    let c_identity_geometry_digest = c_string(&view.identity.geometry_digest, "geometry_digest")?;
    let c_identity_envelope_revision = c_string(
        &view.identity.envelope_revision, "envelope_revision")?;
    let c_identity_envelope_digest = c_string(&view.identity.envelope_digest, "envelope_digest")?;
    let identity = ffi::fullmag_fem_steady_transport_rt0_identity_v1 {
        source_module_id: c_identity_source_module_id.as_ptr(),
        source_state_revision: c_identity_source_state_revision.as_ptr(),
        source_field_digest: c_identity_source_field_digest.as_ptr(),
        conductivity_digest: c_identity_conductivity_digest.as_ptr(),
        mesh_revision: c_identity_mesh_revision.as_ptr(),
        topology_revision: c_identity_topology_revision.as_ptr(),
        geometry_digest: c_identity_geometry_digest.as_ptr(),
        envelope_revision: c_identity_envelope_revision.as_ptr(),
        envelope_digest: c_identity_envelope_digest.as_ptr(),
        evaluated_envelope_multiplier: view.identity.evaluated_envelope_multiplier,
        evaluation_time_s: view.identity.evaluation_time_s,
        stage_identity: view.identity.stage_identity,
    };
    let pins_source_state_revision = c_string(
        &view.pins.required_source_state_revision, "required_source_state_revision")?;
    let pins_source_field_digest = c_string(
        &view.pins.required_source_field_digest, "required_source_field_digest")?;
    let pins_mesh_revision = c_string(&view.pins.required_mesh_revision, "required_mesh_revision")?;
    let pins_topology_revision = c_string(
        &view.pins.required_topology_revision, "required_topology_revision")?;
    let pins = ffi::fullmag_fem_steady_transport_rt0_identity_v1 {
        source_module_id: c_identity_source_module_id.as_ptr(),
        source_state_revision: pins_source_state_revision.as_ptr(),
        source_field_digest: pins_source_field_digest.as_ptr(),
        conductivity_digest: c_identity_conductivity_digest.as_ptr(),
        mesh_revision: pins_mesh_revision.as_ptr(),
        topology_revision: pins_topology_revision.as_ptr(),
        geometry_digest: c_identity_geometry_digest.as_ptr(),
        envelope_revision: c_identity_envelope_revision.as_ptr(),
        envelope_digest: c_identity_envelope_digest.as_ptr(),
        evaluated_envelope_multiplier: view.identity.evaluated_envelope_multiplier,
        evaluation_time_s: view.identity.evaluation_time_s,
        stage_identity: view.identity.stage_identity,
    };
    let stable_version = c_string("stable_mesh_vertex_u64.v1", "stable identity version")?;
    let stable_vertex_identities = ffi::fullmag_fem_steady_transport_rt0_stable_vertex_identities_v1 {
        version: stable_version.as_ptr(),
        local_to_stable_vertex_ids: const_ptr(&view.stable_vertex_ids),
        local_to_stable_vertex_ids_len: view.stable_vertex_ids.len() as u64,
    };

    let boundary_circuits = view
        .boundary_faces
        .iter()
        .map(|face| {
            face.circuit_id
                .as_deref()
                .map(|id| c_string(id, "boundary circuit_id"))
                .transpose()
        })
        .collect::<Result<Vec<Option<CString>>, _>>()?;
    let boundary_faces = view
        .boundary_faces
        .iter()
        .zip(boundary_circuits.iter())
        .map(|(face, circuit)| ffi::fullmag_fem_steady_transport_rt0_boundary_face_v1 {
            face_vertex_ids: face.face_vertex_ids,
            role: match face.role {
                ConservativeCurrentBoundaryRoleIR::InsulatingOuter => ffi::FULLMAG_FEM_STEADY_TRANSPORT_RT0_BOUNDARY_INSULATING_OUTER,
                ConservativeCurrentBoundaryRoleIR::SourceCut => ffi::FULLMAG_FEM_STEADY_TRANSPORT_RT0_BOUNDARY_SOURCE_CUT,
                ConservativeCurrentBoundaryRoleIR::ClosureInterface => ffi::FULLMAG_FEM_STEADY_TRANSPORT_RT0_BOUNDARY_CLOSURE_INTERFACE,
            },
            circuit_id: circuit.as_ref().map_or(ptr::null(), |value| value.as_ptr()),
        })
        .collect::<Vec<_>>();

    let mut closed_descriptor = None;
    let mut external_descriptor = None;
    let mut closed_source_cuts = Vec::new();
    let mut closed_source_cut_pairs = Vec::new();
    let mut closure_strings = Vec::new();
    let mut lead_packed = None;
    let mut lead_conductivity = Vec::new();
    let mut lead_stable_version = None;
    let mut lead_interface_pairs = Vec::new();
    let mut lead_minus_electrodes = Vec::new();
    let mut lead_plus_electrodes = Vec::new();

    let closure_kind = match &view.closure {
        ConservativeCurrentClosureIR::ClosedGeometry {
            operator_version,
            revision,
            digest,
            source_cuts,
        } => {
            closure_strings.reserve(3 + source_cuts.len());
            closure_strings.push(c_string(operator_version, "closure operator_version")?);
            closure_strings.push(c_string(revision, "closure revision")?);
            closure_strings.push(c_string(digest, "closure digest")?);
            for cut in source_cuts {
                let cut_id = c_string(&cut.id, "source cut id")?;
                let pairs = cut
                    .face_pairs
                    .iter()
                    .map(|pair| ffi::fullmag_fem_steady_transport_rt0_source_cut_face_pair_v1 {
                        minus_face_vertex_ids: pair.minus_face_vertex_ids,
                        plus_face_vertex_ids: pair.plus_face_vertex_ids,
                    })
                    .collect::<Vec<_>>();
                closed_source_cut_pairs.push(pairs);
                let pair_buffer = closed_source_cut_pairs.last().expect("just pushed");
                closed_source_cuts.push(ffi::fullmag_fem_steady_transport_rt0_source_cut_v1 {
                    id: cut_id.as_ptr(),
                    translation_m: cut.translation_m,
                    potential_drop_v: cut.potential_drop_v,
                    face_pairs: const_ptr(pair_buffer),
                    face_pair_count: pair_buffer.len() as u64,
                });
                closure_strings.push(cut_id);
            }
            let source_cut_closure = ffi::fullmag_fem_steady_transport_rt0_closed_geometry_closure_v1 {
                operator_version: closure_strings[0].as_ptr(),
                revision: closure_strings[1].as_ptr(),
                digest: closure_strings[2].as_ptr(),
                source_cuts: const_ptr(&closed_source_cuts),
                source_cut_count: closed_source_cuts.len() as u64,
            };
            closed_descriptor = Some(source_cut_closure);
            ffi::FULLMAG_FEM_STEADY_TRANSPORT_RT0_CLOSURE_CLOSED_GEOMETRY
        }
        ConservativeCurrentClosureIR::ExternalLead {
            operator_version,
            revision,
            digest,
            drive_id,
            outer_electrode_potential_drop_v,
            lead_mesh,
            lead_conductivity_spm_per_element,
            lead_stable_vertex_ids,
            interface_pairs,
            minus_outer_electrode_face_vertex_ids,
            plus_outer_electrode_face_vertex_ids,
            lead_conductivity_digest,
        } => {
            closure_strings.reserve(5);
            closure_strings.push(c_string(operator_version, "closure operator_version")?);
            closure_strings.push(c_string(revision, "closure revision")?);
            closure_strings.push(c_string(digest, "closure digest")?);
            closure_strings.push(c_string(drive_id, "drive_id")?);
            closure_strings.push(c_string(lead_conductivity_digest, "lead conductivity digest")?);
            lead_packed = Some(super::PackedNativeMesh::new(lead_mesh));
            lead_conductivity = lead_conductivity_spm_per_element.clone();
            let lead_version = c_string("stable_mesh_vertex_u64.v1", "lead identity version")?;
            lead_stable_version = Some(lead_version);
            lead_interface_pairs = interface_pairs
                .iter()
                .map(|(device, lead)| ffi::fullmag_fem_steady_transport_rt0_interface_pair_v1 {
                    transport_face_vertex_ids: *device,
                    lead_face_vertex_ids: *lead,
                })
                .collect();
            lead_minus_electrodes = minus_outer_electrode_face_vertex_ids
                .iter()
                .flatten()
                .copied()
                .collect();
            lead_plus_electrodes = plus_outer_electrode_face_vertex_ids
                .iter()
                .flatten()
                .copied()
                .collect();
            let lead_packed_ref = lead_packed.as_ref().expect("lead mesh packed");
            let lead_mesh_desc = lead_packed_ref.descriptor(lead_mesh);
            let lead_identity = ffi::fullmag_fem_steady_transport_rt0_stable_vertex_identities_v1 {
                version: lead_stable_version.as_ref().expect("lead identity").as_ptr(),
                local_to_stable_vertex_ids: const_ptr(lead_stable_vertex_ids),
                local_to_stable_vertex_ids_len: lead_stable_vertex_ids.len() as u64,
            };
            let lead = ffi::fullmag_fem_steady_transport_rt0_external_lead_closure_v1 {
                operator_version: closure_strings[0].as_ptr(),
                revision: closure_strings[1].as_ptr(),
                digest: closure_strings[2].as_ptr(),
                drive_id: closure_strings[3].as_ptr(),
                outer_electrode_potential_drop_v: *outer_electrode_potential_drop_v,
                lead_mesh: lead_mesh_desc,
                lead_conductivity_spm_per_element: const_ptr(&lead_conductivity),
                lead_conductivity_spm_per_element_len: lead_conductivity.len() as u64,
                lead_stable_vertex_identities: lead_identity,
                interface_pairs: const_ptr(&lead_interface_pairs),
                interface_pair_count: lead_interface_pairs.len() as u64,
                minus_outer_electrode_face_vertex_ids: const_ptr(&lead_minus_electrodes),
                minus_outer_electrode_face_count: (lead_minus_electrodes.len() / 3) as u64,
                plus_outer_electrode_face_vertex_ids: const_ptr(&lead_plus_electrodes),
                plus_outer_electrode_face_count: (lead_plus_electrodes.len() / 3) as u64,
                lead_conductivity_digest: closure_strings[4].as_ptr(),
            };
            external_descriptor = Some(lead);
            ffi::FULLMAG_FEM_STEADY_TRANSPORT_RT0_CLOSURE_EXTERNAL_LEAD
        }
    };

    let request_ffi = ffi::fullmag_fem_steady_transport_rt0_request_v1 {
        abi_version: ffi::FULLMAG_FEM_STEADY_TRANSPORT_RT0_ABI_VERSION,
        reserved_flags: 0,
        struct_size: std::mem::size_of::<ffi::fullmag_fem_steady_transport_rt0_request_v1>() as u64,
        base,
        closure_kind,
        reserved_closure: 0,
        identity,
        pins,
        stable_vertex_identities,
        boundary_faces: const_ptr(&boundary_faces),
        boundary_face_count: boundary_faces.len() as u64,
        closed_geometry: closed_descriptor
            .as_ref()
            .map_or(ptr::null(), |value| value),
        external_lead: external_descriptor
            .as_ref()
            .map_or(ptr::null(), |value| value),
        algebraic_relative_tolerance: view.algebraic_relative_tolerance,
        physical_relative_gate: view.physical_relative_gate,
        physical_absolute_gate_a: view.physical_absolute_gate_a,
        reference_mpi_gather_broadcast: i32::from(view.reference_mpi_gather_broadcast),
    };
    let capacity = request.mesh.cell_count().saturating_mul(4).max(1);
    let mut rt0_dof_values = vec![0.0; capacity];
    let mut canonical_face_records = vec![ffi::fullmag_fem_steady_transport_rt0_face_flux_record_v1 {
        face_vertex_ids: [0; 3],
        flux_a: f64::NAN,
    }; capacity];
    let mut result_ffi = ffi::fullmag_fem_steady_transport_rt0_result_v1 {
        abi_version: ffi::FULLMAG_FEM_STEADY_TRANSPORT_RT0_ABI_VERSION,
        reserved_flags: 0,
        struct_size: std::mem::size_of::<ffi::fullmag_fem_steady_transport_rt0_result_v1>() as u64,
        rt0_dof_values: rt0_dof_values.as_mut_ptr(),
        rt0_dof_values_capacity: rt0_dof_values.len() as u64,
        rt0_dof_values_len: 0,
        canonical_face_records: canonical_face_records.as_mut_ptr(),
        canonical_face_records_capacity: canonical_face_records.len() as u64,
        canonical_face_records_len: 0,
        converged: 0,
        max_element_divergence_a: f64::NAN,
        max_internal_face_jump_a: f64::NAN,
        net_outer_flux_a: f64::NAN,
        electrode_balance_relative: f64::NAN,
        max_closure_interface_mismatch_a: f64::NAN,
        scaled_kkt_residual: f64::NAN,
        correction_norm_mw: f64::NAN,
        operator_version: [0; 96],
        fe_space: [0; 32],
        flux_unit: [0; 16],
        canonical_face_digest: [0; 65],
        balance_certificate_digest: [0; 65],
        view_identity_digest: [0; 65],
        error_message: [0; 256],
        diagnostics_json: [0; 1024],
    };
    let mut oersted_result_ffi = None;
    let status = if let Some(target_points) = target_points {
        let target_points_xyz = target_points
            .iter()
            .flatten()
            .copied()
            .collect::<Vec<_>>();
        if target_points_xyz.iter().any(|value| !value.is_finite()) {
            return Err(RunError {
                message: "FEM OE-F1 target points contain a non-finite value".into(),
            });
        }
        let mut h_xyz_apm = vec![0.0; target_points_xyz.len()];
        let oersted_request = ffi::fullmag_fem_steady_transport_rt0_oersted_request_v1 {
            abi_version: ffi::FULLMAG_FEM_STEADY_TRANSPORT_RT0_OERSTED_ABI_VERSION,
            reserved_flags: 0,
            struct_size: std::mem::size_of::<
                ffi::fullmag_fem_steady_transport_rt0_oersted_request_v1,
            >() as u64,
            rt0: request_ffi,
            target_points_xyz: const_ptr(&target_points_xyz),
            target_points_xyz_len: target_points_xyz.len() as u64,
            base_quadrature_order: 4,
            maximum_subdivision_depth: 6,
            absolute_tolerance_apm: 1.0e-9,
            relative_tolerance: 1.0e-5,
            maximum_source_target_pairs: 1_000_000,
        };
        let mut outer_result = ffi::fullmag_fem_steady_transport_rt0_oersted_result_v1 {
            abi_version: ffi::FULLMAG_FEM_STEADY_TRANSPORT_RT0_OERSTED_ABI_VERSION,
            reserved_flags: 0,
            struct_size: std::mem::size_of::<
                ffi::fullmag_fem_steady_transport_rt0_oersted_result_v1,
            >() as u64,
            rt0: result_ffi,
            h_xyz_apm: h_xyz_apm.as_mut_ptr(),
            h_xyz_apm_capacity: h_xyz_apm.len() as u64,
            h_xyz_apm_len: 0,
            source_target_pairs: 0,
            refined_pairs: 0,
            unconverged_pair_count: 0,
            maximum_pair_error_apm: f64::NAN,
            operator_version: [0; 96],
            source_view_identity_digest: [0; 65],
            error_message: [0; 256],
            diagnostics_json: [0; 1024],
        };
        let status = unsafe {
            ffi::fullmag_fem_solve_steady_transport_rt0_oersted_v1(
                &oersted_request,
                &mut outer_result,
            )
        };
        result_ffi = outer_result.rt0;
        oersted_result_ffi = Some((outer_result, h_xyz_apm));
        status
    } else {
        unsafe {
            ffi::fullmag_fem_solve_steady_transport_rt0_v1(&request_ffi, &mut result_ffi)
        }
    };
    if status != ffi::FULLMAG_FEM_OK {
        let error_message = oersted_result_ffi
            .as_ref()
            .map(|(result, _)| chars(&result.error_message))
            .filter(|message| !message.is_empty())
            .unwrap_or_else(|| chars(&result_ffi.error_message));
        return Err(RunError {
            message: error_message,
        });
    }
    if result_ffi.converged == 0
        || result_ffi.rt0_dof_values_len > rt0_dof_values.len() as u64
        || result_ffi.canonical_face_records_len > canonical_face_records.len() as u64
    {
        return Err(RunError {
            message: "native FEM RT0 returned a non-converged or out-of-range result".into(),
        });
    }
    let diagnostics_text = chars(&result_ffi.diagnostics_json);
    let diagnostics = serde_json::from_str(&diagnostics_text).map_err(|error| RunError {
        message: format!("invalid native FEM RT0 diagnostics JSON: {error}"),
    })?;
    let finite = |label: &str, value: f64| -> Result<f64, RunError> {
        if value.is_finite() {
            Ok(value)
        } else {
            Err(RunError { message: format!("native FEM RT0 returned non-finite {label}") })
        }
    };
    let canonical_face_records = canonical_face_records
        .into_iter()
        .take(result_ffi.canonical_face_records_len as usize)
        .map(|record| (record.face_vertex_ids, record.flux_a))
        .collect();
    let oersted = if let Some((oersted_result, h_xyz_apm)) = oersted_result_ffi {
        if oersted_result.h_xyz_apm_len != h_xyz_apm.len() as u64
            || oersted_result.h_xyz_apm_len > oersted_result.h_xyz_apm_capacity
            || h_xyz_apm.iter().any(|value| !value.is_finite())
        {
            return Err(RunError {
                message: "native FEM OE-F1 returned an invalid H field buffer".into(),
            });
        }
        let source_view_identity_digest = chars(&oersted_result.source_view_identity_digest);
        if source_view_identity_digest != chars(&result_ffi.view_identity_digest) {
            return Err(RunError {
                message: "native FEM OE-F1 source view digest differs from the RT0 result".into(),
            });
        }
        let operator_version = chars(&oersted_result.operator_version);
        if operator_version != "fem_oersted_direct_tetra_quadrature.v1" {
            return Err(RunError {
                message: format!(
                    "native FEM OE-F1 returned unexpected operator version '{operator_version}'"
                ),
            });
        }
        let diagnostics_text = chars(&oersted_result.diagnostics_json);
        let diagnostics = serde_json::from_str(&diagnostics_text).map_err(|error| RunError {
            message: format!("invalid native FEM OE-F1 diagnostics JSON: {error}"),
        })?;
        if !oersted_result.maximum_pair_error_apm.is_finite() {
            return Err(RunError {
                message: "native FEM OE-F1 returned a non-finite pair error".into(),
            });
        }
        Some((
            h_xyz_apm,
            operator_version,
            source_view_identity_digest,
            oersted_result.source_target_pairs,
            oersted_result.refined_pairs,
            oersted_result.unconverged_pair_count,
            oersted_result.maximum_pair_error_apm,
            diagnostics,
        ))
    } else {
        None
    };
    Ok(NativeFemSteadyTransportRt0Result {
        rt0_dof_values: rt0_dof_values
            .into_iter()
            .take(result_ffi.rt0_dof_values_len as usize)
            .map(|value| finite("RT0 DOF", value))
            .collect::<Result<_, _>>()?,
        canonical_face_records,
        max_element_divergence_a: finite("element divergence", result_ffi.max_element_divergence_a)?,
        max_internal_face_jump_a: finite("internal face jump", result_ffi.max_internal_face_jump_a)?,
        net_outer_flux_a: finite("outer flux", result_ffi.net_outer_flux_a)?,
        electrode_balance_relative: finite("electrode balance", result_ffi.electrode_balance_relative)?,
        max_closure_interface_mismatch_a: finite("closure interface mismatch", result_ffi.max_closure_interface_mismatch_a)?,
        scaled_kkt_residual: finite("scaled KKT residual", result_ffi.scaled_kkt_residual)?,
        correction_norm_mw: finite("correction norm", result_ffi.correction_norm_mw)?,
        operator_version: chars(&result_ffi.operator_version),
        fe_space: chars(&result_ffi.fe_space),
        flux_unit: chars(&result_ffi.flux_unit),
        canonical_face_digest: chars(&result_ffi.canonical_face_digest),
        balance_certificate_digest: chars(&result_ffi.balance_certificate_digest),
        view_identity_digest: chars(&result_ffi.view_identity_digest),
        diagnostics,
        oersted_h_xyz_apm: oersted.as_ref().map(|value| value.0.clone()),
        oersted_operator_version: oersted.as_ref().map(|value| value.1.clone()),
        oersted_source_view_identity_digest: oersted.as_ref().map(|value| value.2.clone()),
        oersted_source_target_pairs: oersted.as_ref().map(|value| value.3),
        oersted_refined_pairs: oersted.as_ref().map(|value| value.4),
        oersted_unconverged_pair_count: oersted.as_ref().map(|value| value.5),
        oersted_maximum_pair_error_apm: oersted.as_ref().map(|value| value.6),
        oersted_diagnostics: oersted.map(|value| value.7),
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
            conservative_current_view: None,
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
                oersted_source_bound: false,
                conservative_current_view: None,
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

    fn common_reciprocal_m2_3d_fdm_plan(nxy: usize, nz: usize) -> FdmPlanIR {
        let mut plan = common_reciprocal_m2_fdm_plan(nz);
        let cells = nxy * nxy * nz;
        plan.grid.cells = [nxy as u32, nxy as u32, nz as u32];
        plan.cell_size = [1.0 / nxy as f64, 1.0 / nxy as f64, 1.0 / nz as f64];
        plan.active_mask = Some(vec![true; cells]);
        plan.initial_magnetization = vec![[1.0, 0.0, 0.0]; cells];

        let descriptor = plan.spin_transport_plans[0]
            .fdm_cpu_double_reciprocal
            .as_mut()
            .expect("reciprocal FDM descriptor");
        descriptor.active_cells = vec![true; cells];
        descriptor.reciprocal_materials = vec![ResolvedReciprocalMaterialIR {
            sigma_spm: 4.0,
            sigma_spin_spm: 5.0,
            sigma_parallel_spm: 6.0,
            sigma_perpendicular_spm: 3.0,
            sigma_ahe_spm: 0.2,
            polarization_p: 0.25,
            theta_sh: 0.1,
        }; cells];
        descriptor.reactions = vec![
            ResolvedSpinReactionLengthsIR {
                spin_flip_m: Some(0.3),
                exchange_m: None,
                dephasing_m: None,
            };
            cells
        ];
        descriptor.region_ids = vec![0; cells];
        descriptor.torque_target_cells = vec![false; cells];
        descriptor.saturation_magnetization_apm = vec![8.0e5; cells];
        descriptor.linear_solver.relative_tolerance = 1.0e-13;
        descriptor.linear_solver.absolute_tolerance = 1.0e-12;
        descriptor.nonlinear_solver.max_picard_iterations = 12;
        descriptor.nonlinear_solver.relative_update_tolerance = 1.0e-8;
        plan
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

    fn common_reciprocal_m2_3d_fem_mesh(nxy: usize, nz: usize) -> MeshIR {
        let nodes_per_plane = (nxy + 1) * (nxy + 1);
        let node = |x: usize, y: usize, z: usize| -> u32 {
            (z * nodes_per_plane + y * (nxy + 1) + x) as u32
        };
        let mut nodes = Vec::with_capacity((nz + 1) * nodes_per_plane);
        for z in 0..=nz {
            for y in 0..=nxy {
                for x in 0..=nxy {
                    nodes.push([
                        x as f64 / nxy as f64,
                        y as f64 / nxy as f64,
                        z as f64 / nz as f64,
                    ]);
                }
            }
        }
        let mut elements = Vec::with_capacity(nz * nxy * nxy * 6);
        let mut element_markers = Vec::with_capacity(nz * nxy * nxy * 6);
        let mut boundary_faces = Vec::new();
        let mut boundary_markers = Vec::new();
        for z in 0..nz {
            for y in 0..nxy {
                for x in 0..nxy {
                    let a = node(x, y, z);
                    let b = node(x + 1, y, z);
                    let c = node(x + 1, y + 1, z);
                    let d = node(x, y + 1, z);
                    let e = node(x, y, z + 1);
                    let f = node(x + 1, y, z + 1);
                    let g = node(x + 1, y + 1, z + 1);
                    let h = node(x, y + 1, z + 1);
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
                    if x == 0 {
                        add_face([a, d, h], 3);
                        add_face([a, h, e], 3);
                    }
                    if x + 1 == nxy {
                        add_face([b, c, g], 3);
                        add_face([b, g, f], 3);
                    }
                    if y == 0 {
                        add_face([a, e, f], 3);
                        add_face([a, f, b], 3);
                    }
                    if y + 1 == nxy {
                        add_face([c, d, g], 3);
                        add_face([d, h, g], 3);
                    }
                }
            }
        }
        MeshIR::from_legacy_tet4(
            "reciprocal-m2-3d-common-limit".into(),
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
    fn reciprocal_m2_3d_she_ishe_common_limit_matches_fdm_and_fem_profiles() {
        if !crate::native_fem::is_cpu_available() {
            eprintln!(
                "skipping reciprocal M2 3-D SHE/iSHE FDM↔FEM test: native FEM CPU unavailable"
            );
            return;
        }

        const SIGMA_SPM: f64 = 4.0;
        const SIGMA_SPIN_SPM: f64 = 5.0;
        const SIGMA_PARALLEL_SPM: f64 = 6.0;
        const SIGMA_PERPENDICULAR_SPM: f64 = 3.0;
        const SIGMA_AHE_SPM: f64 = 0.2;
        const POLARIZATION: f64 = 0.25;
        const THETA_SH: f64 = 0.1;
        const LAMBDA_SF_M: f64 = 0.3;
        let mut cross_errors = Vec::new();

        for (nxy, nz) in [(2usize, 4usize), (4, 8), (8, 16)] {
            let fdm_plan = common_reciprocal_m2_3d_fdm_plan(nxy, nz);
            let mut fdm_workflow = crate::fdm::cpu::spin_transport::FdmSpinTransportWorkflow::from_plan(
                &fdm_plan,
            )
            .expect("FDM reciprocal M2 3-D workflow construction")
            .expect("FDM reciprocal M2 3-D workflow");
            let fdm_evaluation = fdm_workflow
                .evaluate_stage(&fdm_plan.initial_magnetization, 0.0)
                .expect("FDM reciprocal M2 3-D solve");
            let fdm_module = &fdm_evaluation.modules[0];

            let fem_mesh = common_reciprocal_m2_3d_fem_mesh(nxy, nz);
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
                magnetization: vec![[1.0, 0.0, 0.0]; fem_mesh.nodes.len()],
                sigma_s_spm: SIGMA_SPIN_SPM,
                sigma_parallel_spm: Some(SIGMA_PARALLEL_SPM),
                sigma_perpendicular_spm: Some(SIGMA_PERPENDICULAR_SPM),
                sigma_ahe_spm: Some(SIGMA_AHE_SPM),
                polarization_p: POLARIZATION,
                theta_sh: THETA_SH,
                lambda_sf_m: LAMBDA_SF_M,
                lambda_j_m: None,
                lambda_phi_m: None,
                gamma_e_per_ts: 1.760_859_630_23e11,
                saturation_magnetization_apm: 8.0e5,
                relative_tolerance: 1.0e-10,
                absolute_tolerance: 0.0,
                maximum_iterations: 2_000,
                charge_dirichlet: vec![(1, 1.0), (2, 0.0)],
                spin_dirichlet: vec![(1, [0.0, 0.0, 0.2]), (2, [0.0, 0.0, 0.0])],
            };
            let fem_result = solve_native_fem_steady_transport(&fem_request)
                .expect("FEM reciprocal M2 3-D solve");

            let cells_per_plane = nxy * nxy;
            let nodes_per_plane = (nxy + 1) * (nxy + 1);
            let fdm_plane_average = |values: &[f64], plane: usize| -> f64 {
                let start = plane * cells_per_plane;
                values[start..start + cells_per_plane].iter().sum::<f64>()
                    / cells_per_plane as f64
            };
            let fdm_spin_plane_average = |plane: usize, component: usize| -> f64 {
                let start = plane * cells_per_plane;
                fdm_module.spin_potential_volts[start..start + cells_per_plane]
                    .iter()
                    .map(|value| value[component])
                    .sum::<f64>()
                    / cells_per_plane as f64
            };
            let fem_plane_average = |values: &[f64], plane: usize| -> f64 {
                let start = plane * nodes_per_plane;
                let weighted_sum = (0..=nxy)
                    .flat_map(|y| (0..=nxy).map(move |x| (x, y)))
                    .map(|(x, y)| {
                        let weight_x = if x == 0 || x == nxy { 1.0 } else { 2.0 };
                        let weight_y = if y == 0 || y == nxy { 1.0 } else { 2.0 };
                        weight_x * weight_y * values[start + y * (nxy + 1) + x]
                    })
                    .sum::<f64>();
                weighted_sum / (4.0 * nxy as f64 * nxy as f64)
            };
            let fem_spin_plane_average = |plane: usize, component: usize| -> f64 {
                let start = plane * nodes_per_plane;
                let weighted_sum = (0..=nxy)
                    .flat_map(|y| (0..=nxy).map(move |x| (x, y)))
                    .map(|(x, y)| {
                        let weight_x = if x == 0 || x == nxy { 1.0 } else { 2.0 };
                        let weight_y = if y == 0 || y == nxy { 1.0 } else { 2.0 };
                        weight_x
                            * weight_y
                            * fem_result.spin_potential_xyz_v
                                [start + y * (nxy + 1) + x][component]
                    })
                    .sum::<f64>();
                weighted_sum / (4.0 * nxy as f64 * nxy as f64)
            };

            assert!(
                fdm_module.telemetry.spin_scaled_residual < 1.0e-9,
                "FDM reciprocal M2 3-D spin residual is too large at nxy={nxy}, Nz={nz}: {}",
                fdm_module.telemetry.spin_scaled_residual
            );
            assert!(
                fdm_module
                    .telemetry
                    .charge_balance_relative
                    .unwrap_or(f64::INFINITY)
                    < 1.0e-9,
                "FDM reciprocal M2 3-D charge balance is too large at nxy={nxy}, Nz={nz}: {:?}",
                fdm_module.telemetry.charge_balance_relative
            );
            assert!(
                fem_result.charge_relative_residual < 1.0e-9
                    && fem_result.spin_relative_residual < 1.0e-9,
                "FEM reciprocal M2 3-D residual is too large at nxy={nxy}, Nz={nz}: charge={}, spin={}",
                fem_result.charge_relative_residual,
                fem_result.spin_relative_residual
            );

            let mut max_potential_difference: f64 = 0.0;
            let mut max_spin_difference: f64 = 0.0;
            for z in 0..nz {
                let fem_potential = 0.5
                    * (fem_plane_average(&fem_result.electric_potential_v, z)
                        + fem_plane_average(&fem_result.electric_potential_v, z + 1));
                max_potential_difference = max_potential_difference
                    .max((fdm_plane_average(&fdm_module.potential_volts, z) - fem_potential).abs());
                for component in 0..3 {
                    let fem_spin = 0.5
                        * (fem_spin_plane_average(z, component)
                            + fem_spin_plane_average(z + 1, component));
                    max_spin_difference = max_spin_difference.max(
                        (fdm_spin_plane_average(z, component) - fem_spin).abs(),
                    );
                }
            }
            eprintln!(
                "M2 reciprocal 3-D SHE/iSHE nxy={nxy}, Nz={nz}: potential={max_potential_difference:e}, spin={max_spin_difference:e}"
            );
            cross_errors.push((nxy, max_potential_difference, max_spin_difference));

            let transverse_spin = fdm_module
                .spin_potential_volts
                .iter()
                .map(|value| value[0].abs().max(value[1].abs()))
                .fold(0.0, f64::max);
            assert!(
                transverse_spin > 1.0e-8,
                "3-D reciprocal SHE/iSHE fixture did not produce a transverse spin response"
            );
        }

        for pair in cross_errors.windows(2) {
            assert!(
                pair[1].2 < pair[0].2,
                "3-D reciprocal M2 FDM↔FEM spin profiles must converge under h refinement: coarse={pair:?}"
            );
        }
        let fine = cross_errors.last().expect("3-D cross-backend sweep result");
        assert!(
            fine.1 < cross_errors[0].1 && fine.1 < cross_errors[1].1,
            "3-D reciprocal M2 charge profile did not reach a lower fine-grid cross-backend error: {cross_errors:?}"
        );
        assert!(
            fine.1 < 1.0e-3 && fine.2 < 5.0e-2,
            "3-D reciprocal M2 FDM↔FEM common-limit envelope is too large: {fine:?}"
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
        assert!(provenance.oersted_source_kind.is_none());
        assert!(provenance.oersted_source_current_sha256.is_none());
        assert!(provenance.oersted_mesh_source_sha256.is_none());
        assert!(provenance.oersted_field_sha256.is_none());
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

    #[test]
    fn solved_current_midpoint_biot_savart_is_finite_and_reverses_with_current() {
        let mesh = MeshIR::from_legacy_tet4(
            "tet".into(),
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
        );
        let current = vec![[1.0, 0.0, 0.0]; 4];
        let field = solved_current_midpoint_biot_savart_field(&mesh, &[true], &current)
            .expect("tet4 midpoint field");
        assert_eq!(field.len(), 12);
        assert!(field.iter().all(|value| value.is_finite()));
        assert!(field[7].abs() > 0.0);

        let reversed = solved_current_midpoint_biot_savart_field(
            &mesh,
            &[true],
            &current
                .iter()
                .map(|value| [-value[0], -value[1], -value[2]])
                .collect::<Vec<_>>(),
        )
        .expect("reversed tet4 midpoint field");
        for (left, right) in field.iter().zip(reversed) {
            assert!((left + right).abs() < 1.0e-14);
        }
    }

    #[test]
    fn solved_current_oersted_identity_digests_are_stable_and_source_bound() {
        let mesh = request().mesh;
        let current = vec![[1.0, -2.0, 3.0]; 4];
        let field = vec![0.25, -0.5, 0.75, 1.0, 2.0, 3.0];
        let current_digest = sha256_vec3_slice(&current);
        let field_digest = sha256_f64_slice(&field);
        assert_eq!(current_digest, sha256_vec3_slice(&current));
        assert_eq!(field_digest, sha256_f64_slice(&field));
        assert!(current_digest.starts_with("sha256:"));
        assert!(field_digest.starts_with("sha256:"));

        let active_digest = sha256_mesh_source(&mesh, &[true]).expect("active mesh digest");
        let inactive_digest = sha256_mesh_source(&mesh, &[false]).expect("inactive mesh digest");
        assert_ne!(active_digest, inactive_digest);
    }
}

#[cfg(test)]
pub(crate) use tests::resolved_plan as test_resolved_plan;
