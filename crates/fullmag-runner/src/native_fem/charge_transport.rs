use crate::types::{AuxiliaryArtifact, FieldSnapshot, RunError, TransportExecutionProvenance};
use crate::AntennaFieldStageStatus;
use fullmag_fem_sys as ffi;
use fullmag_ir::{
    AntennaFieldSolvePlanIR, ChargePotentialGaugeIR, ExecutionDevice, ExecutionMode,
    ExecutionPrecision, FemPlanIR, MeshIR, OerstedRealization, ResolvedChargeTransportPlanIR,
    ResolvedFemChargeTransportIR, ResolvedFemTransportDomainIR, TransportCouplingIR,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::ffi::{CStr, CString};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};

use super::steady_transport::{
    solve_native_fem_steady_transport_rt0, NativeFemSteadyTransportBundle,
    NativeFemSteadyTransportConstitutiveModel, NativeFemSteadyTransportExecution,
    NativeFemSteadyTransportGauge, NativeFemSteadyTransportInterface,
    NativeFemSteadyTransportOerstedMethod, NativeFemSteadyTransportRequest,
};
use crate::antenna_field_solution::{
    build_antenna_field_solution_artifacts, AntennaFieldBasisInput, AntennaFieldSolutionInput,
};

const CONSTITUTIVE_VERSION: &str = "transport_constitutive.one_way.fullmag.v1";
const OPERATOR_VERSION: &str = "fem_charge_conforming_h1_p1.transparent.v1";
const PHYSICAL_RESIDUAL_VERSION: &str = "charge_balance_integrated_l2.v1";

#[derive(Debug, Clone)]
struct NativeFemChargeTransportRequest {
    mesh: fullmag_ir::MeshIR,
    gauge: NativeFemSteadyTransportGauge,
    conductivity_spm_per_element: Vec<f64>,
    relative_tolerance: f64,
    absolute_tolerance: f64,
    maximum_iterations: u32,
    charge_dirichlet: Vec<(u32, f64)>,
    prescribed_terminal_currents: Option<Vec<(Vec<u32>, f64)>>,
}

#[derive(Debug, Clone)]
struct NativeFemChargeTransportResult {
    electric_potential_v: Vec<f64>,
    charge_current_density_xyz_apm2: Vec<[f64; 3]>,
    charge_iterations: u32,
    charge_relative_residual: f64,
    net_boundary_current_a: f64,
    current_density_volume_average_apm2: [f64; 3],
    dirichlet_boundary_currents_a: Vec<f64>,
    resolved_charge_dirichlet: Vec<(u32, f64)>,
    measured_terminal_currents_a: Vec<f64>,
    terminal_voltages_v: Vec<f64>,
    gauge_terminal_indices: Vec<u32>,
    diagnostics: Value,
}

struct PreparedChargeTransport<'a> {
    resolved: &'a ResolvedChargeTransportPlanIR,
    descriptor: &'a ResolvedFemChargeTransportIR,
    request: NativeFemChargeTransportRequest,
    provenance: TransportExecutionProvenance,
}

pub(crate) fn execute_native_fem_charge_transport_plans(
    plan: &FemPlanIR,
) -> Result<Option<NativeFemSteadyTransportBundle>, RunError> {
    execute_native_fem_charge_transport(
        &plan.mesh,
        &plan.charge_transport_plans,
        plan.oersted_realization,
        &plan.mesh.nodes,
        None,
        None,
        None,
    )
}

pub(crate) fn execute_native_fem_antenna_field_solve_plan_interruptible(
    plan: &AntennaFieldSolvePlanIR,
    interrupt_requested: Option<&AtomicBool>,
    progress: Option<
        &mut dyn FnMut(AntennaFieldStageStatus, Option<String>) -> Result<(), RunError>,
    >,
) -> Result<Option<NativeFemSteadyTransportBundle>, RunError> {
    execute_native_fem_charge_transport(
        &plan.conductor.mesh,
        &plan.conductor.charge_transport_plans,
        Some(plan.conductor.oersted_realization),
        &plan.field_sampling.positions_xyz_m,
        Some(plan),
        interrupt_requested,
        progress,
    )
}

fn ensure_antenna_not_cancelled(
    interrupt_requested: Option<&AtomicBool>,
    boundary: &str,
) -> Result<(), RunError> {
    if interrupt_requested.is_some_and(|signal| signal.load(Ordering::Acquire)) {
        return Err(RunError {
            message: format!("antenna field solve cancelled at {boundary}: interrupt_requested"),
        });
    }
    Ok(())
}

fn resolve_antenna_sample_topology(
    cells: &fullmag_ir::FemConnectivityIR,
) -> Result<Option<Vec<[u32; 4]>>, RunError> {
    if cells.is_empty() {
        // Keep deserialization compatibility for pre-topology point-only
        // assets. New plans are rejected by the planner before reaching this
        // lane and publish identity_coordinates_v1 explicitly.
        return Ok(None);
    }
    cells
        .require_tet4()
        .map(Some)
        .map_err(|error| RunError {
            message: format!(
                "unsupported antenna field-sampling topology: tet4 P1 connectivity is required; mixed/non-tet topology cannot be downgraded to identity sampling ({error})"
            ),
        })
}

fn execute_native_fem_charge_transport(
    mesh: &MeshIR,
    charge_transport_plans: &[ResolvedChargeTransportPlanIR],
    oersted_realization: Option<OerstedRealization>,
    field_sample_positions_xyz_m: &[[f64; 3]],
    antenna_plan: Option<&AntennaFieldSolvePlanIR>,
    interrupt_requested: Option<&AtomicBool>,
    mut progress: Option<
        &mut dyn FnMut(AntennaFieldStageStatus, Option<String>) -> Result<(), RunError>,
    >,
) -> Result<Option<NativeFemSteadyTransportBundle>, RunError> {
    if charge_transport_plans.is_empty() {
        return Ok(None);
    }
    if field_sample_positions_xyz_m.is_empty()
        || field_sample_positions_xyz_m
            .iter()
            .flatten()
            .any(|component| !component.is_finite())
    {
        return Err(RunError {
            message: "FEM charge/Oersted execution requires finite field-sampling positions".into(),
        });
    }
    ensure_antenna_not_cancelled(interrupt_requested, "before_preflight")?;
    let antenna_sample_tet4_cells = match antenna_plan {
        Some(plan) => Some(resolve_antenna_sample_topology(&plan.field_sampling.cells)?),
        None => None,
    };
    let prepared = preflight_charge_transport_plans(mesh, charge_transport_plans)?;
    let method = match oersted_realization {
        Some(fullmag_ir::OerstedRealization::FemVectorPotential) => {
            NativeFemSteadyTransportOerstedMethod::FemVectorPotential
        }
        _ => NativeFemSteadyTransportOerstedMethod::DirectTetraQuadrature,
    };
    if method == NativeFemSteadyTransportOerstedMethod::DirectTetraQuadrature {
        let oersted_evaluation_count = prepared
            .iter()
            .filter(|prepared| prepared.descriptor.oersted_source_bound)
            .count();
        super::steady_transport::preflight_direct_oersted_pair_budget_for_evaluations(
            mesh.cell_count(),
            field_sample_positions_xyz_m.len(),
            oersted_evaluation_count,
        )?;
    }
    ensure_antenna_not_cancelled(interrupt_requested, "after_preflight")?;
    if antenna_plan.is_some() {
        if let Some(progress) = progress.as_deref_mut() {
            progress(
                AntennaFieldStageStatus::Meshing,
                Some("reused conductor and field-sampling meshes resolved by planner".into()),
            )?;
        }
    }
    let mut records = Vec::with_capacity(prepared.len());
    let mut snapshots = Vec::new();
    let mut provenance = Vec::with_capacity(prepared.len());
    let mut aggregate_oersted = None;
    let mut antenna_artifacts = Vec::new();

    for prepared in prepared {
        ensure_antenna_not_cancelled(interrupt_requested, "before_charge_transport")?;
        if let Some(progress) = progress.as_deref_mut() {
            progress(AntennaFieldStageStatus::SolvingCurrent, None)?;
        }
        let result = solve_native_fem_charge_transport(&prepared.request)?;
        ensure_antenna_not_cancelled(interrupt_requested, "after_charge_transport")?;
        let mut module_provenance = prepared.provenance;
        let mut rt0_record = None;
        let mut oersted_record = None;
        if let Some(view) = prepared.descriptor.conservative_current_view.as_ref() {
            let compatibility_request =
                charge_request_for_rt0(&prepared.request, &result.resolved_charge_dirichlet);
            let targets = match method {
                NativeFemSteadyTransportOerstedMethod::DirectTetraQuadrature => {
                    Some(field_sample_positions_xyz_m)
                }
                NativeFemSteadyTransportOerstedMethod::FemVectorPotential => Some(&[][..]),
            };
            ensure_antenna_not_cancelled(interrupt_requested, "before_rt0_oersted")?;
            if let Some(progress) = progress.as_deref_mut() {
                progress(AntennaFieldStageStatus::EvaluatingField, None)?;
            }
            // This calls only the RT0/Oersted ABI. The historical request
            // prefix contains spin slots, but no spin equation is executed.
            let rt0 = solve_native_fem_steady_transport_rt0(
                &compatibility_request,
                view,
                method,
                targets,
            )?;
            ensure_antenna_not_cancelled(interrupt_requested, "after_rt0_oersted")?;
            module_provenance.conservative_current_view_identity_digest =
                Some(rt0.view_identity_digest.clone());
            module_provenance.conservative_current_balance_certificate_digest =
                Some(rt0.balance_certificate_digest.clone());
            rt0_record = Some(serde_json::json!({
                "source_kind": "fem_conservative_current_rt0_view.v1",
                "operator_version": rt0.operator_version,
                "fe_space": rt0.fe_space,
                "flux_unit": rt0.flux_unit,
                "rt0_dof_values": rt0.rt0_dof_values,
                "canonical_face_records": rt0.canonical_face_records.iter().map(|(ids, flux)| serde_json::json!({"face_vertex_ids": ids, "flux_a": flux})).collect::<Vec<_>>(),
                "max_element_divergence_a": rt0.max_element_divergence_a,
                "max_internal_face_jump_a": rt0.max_internal_face_jump_a,
                "net_outer_flux_a": rt0.net_outer_flux_a,
                "electrode_balance_relative": rt0.electrode_balance_relative,
                "max_closure_interface_mismatch_a": rt0.max_closure_interface_mismatch_a,
                "scaled_kkt_residual": rt0.scaled_kkt_residual,
                "correction_norm_mw": rt0.correction_norm_mw,
                "canonical_face_digest": rt0.canonical_face_digest,
                "balance_certificate_digest": rt0.balance_certificate_digest,
                "view_identity_digest": rt0.view_identity_digest,
                "diagnostics": rt0.diagnostics,
            }));
            if prepared.descriptor.oersted_source_bound {
                let field = rt0.oersted_h_xyz_apm.ok_or_else(|| RunError {
                    message: format!(
                        "FEM charge-only source '{}' published no Oersted field",
                        prepared.resolved.module_id
                    ),
                })?;
                validate_oersted_field(&field, field_sample_positions_xyz_m.len())?;
                add_flat_field(
                    aggregate_oersted.get_or_insert_with(|| vec![0.0; field.len()]),
                    &field,
                )?;
                let source_kind = match method {
                    NativeFemSteadyTransportOerstedMethod::DirectTetraQuadrature => {
                        "fem_conservative_current_rt0_view.v1"
                    }
                    NativeFemSteadyTransportOerstedMethod::FemVectorPotential => {
                        "fem_conservative_current_rt0_vector_potential.v1"
                    }
                };
                let field_sha256 = sha256_f64_slice(&field);
                if let Some(request) = prepared.resolved.antenna_field_solution_request.as_ref() {
                    let antenna_plan = antenna_plan.ok_or_else(|| RunError {
                        message: "an antenna field-solution request may execute only through the dedicated AntennaFieldSolve plan".into(),
                    })?;
                    let signatures = crate::antenna_field_solution_signatures(antenna_plan)?;
                    let asset_id =
                        crate::antenna_stage::antenna_field_solution_asset_id(&signatures);
                    if !rt0.electrode_balance_relative.is_finite()
                        || rt0.electrode_balance_relative > 1.0e-8
                    {
                        return Err(RunError {
                            message: format!(
                                "antenna port '{}' lacks a qualifying RT0 electrode-balance certificate: relative imbalance={:.17e}",
                                request.port_mode_id, rt0.electrode_balance_relative
                            ),
                        });
                    }
                    let measured_positive_terminal_current_a = if let Some(targets) =
                        prepared.request.prescribed_terminal_currents.as_ref()
                    {
                        measured_prescribed_port_current(
                            request,
                            targets,
                            &result.measured_terminal_currents_a,
                        )?
                    } else {
                        measured_port_current(
                            request,
                            &prepared.descriptor.charge_driven_boundaries,
                            &prepared.request.charge_dirichlet,
                            &result.dirichlet_boundary_currents_a,
                        )?
                    };
                    antenna_artifacts.extend(build_antenna_field_solution_artifacts(
                        &AntennaFieldSolutionInput {
                            asset_id,
                            solution_id: request.solution_id.clone(),
                            source_object_id: request.source_object_id.clone(),
                            current_transport_id: prepared.resolved.module_id.clone(),
                            stage_id: request.stage_id.clone(),
                            geometry_revision: request.geometry_revision.clone(),
                            material_revision: request.material_revision.clone(),
                            mesh_digest: request.mesh_digest.clone(),
                            requested_execution: request.requested_execution.clone(),
                            resolved_execution: request.resolved_execution.clone(),
                            gauge_policy: match prepared.descriptor.charge_gauge {
                                ChargePotentialGaugeIR::DirichletReference => "dirichlet_reference",
                                ChargePotentialGaugeIR::ZeroMean => "zero_mean",
                                ChargePotentialGaugeIR::TerminalReference => "terminal_reference",
                            }
                            .into(),
                            solver_policy: serde_json::to_value(&prepared.descriptor.charge_solver)
                                .map_err(|error| RunError {
                                    message: format!(
                                        "serialize antenna charge solver policy: {error}"
                                    ),
                                })?,
                            signatures,
                            conductor_positions_xyz_m: mesh.nodes.clone(),
                            sample_positions_xyz_m: field_sample_positions_xyz_m.to_vec(),
                            sample_carrier: crate::antenna_field_solution::AntennaSampleCarrier {
                                domain: antenna_plan.field_sampling.domain.clone(),
                                carrier_kind: antenna_plan.field_sampling.carrier_kind.clone(),
                                location: antenna_plan.field_sampling.location.clone(),
                                topology_digest: antenna_plan.field_sampling.topology_digest.clone(),
                            },
                            sample_tet4_cells: antenna_sample_tet4_cells.clone().flatten(),
                            bases: vec![AntennaFieldBasisInput {
                                port_mode_id: request.port_mode_id.clone(),
                                measured_positive_terminal_current_a,
                                electric_potential_v: result.electric_potential_v.clone(),
                                current_density_xyz_apm2: result
                                    .charge_current_density_xyz_apm2
                                    .clone(),
                                magnetic_field_xyz_apm: triples(field.clone()),
                                current_balance_certificate_digest: rt0
                                    .balance_certificate_digest
                                    .clone(),
                                quadrature_diagnostics: rt0
                                    .oersted_diagnostics
                                    .clone()
                                    .unwrap_or(serde_json::Value::Null),
                                oersted_operator_version: rt0.oersted_operator_version.clone()
                                    .ok_or_else(|| RunError { message: "antenna solve lacks native Oersted operator identity".into() })?,
                                direct_quadrature_snapshot: rt0.oersted_quadrature_snapshot.clone(),
                            }],
                        },
                    )?);
                }
                module_provenance.oersted_source_kind = Some(source_kind.into());
                module_provenance.oersted_field_sha256 = Some(field_sha256.clone());
                oersted_record = Some(serde_json::json!({
                    "source_kind": source_kind,
                    "realization": match method {
                        NativeFemSteadyTransportOerstedMethod::DirectTetraQuadrature => "direct_tetra_quadrature",
                        NativeFemSteadyTransportOerstedMethod::FemVectorPotential => "fem_vector_potential_hcurl_h1",
                    },
                    "location": "node",
                    "component_order": "xyz",
                    "field_xyz": field,
                    "field_sha256": field_sha256,
                    "operator_version": rt0.oersted_operator_version,
                    "source_view_identity_digest": rt0.oersted_source_view_identity_digest,
                    "source_target_pairs": rt0.oersted_source_target_pairs,
                    "refined_pairs": rt0.oersted_refined_pairs,
                    "unconverged_pair_count": rt0.oersted_unconverged_pair_count,
                    "maximum_pair_error_apm": rt0.oersted_maximum_pair_error_apm,
                    "diagnostics": rt0.oersted_diagnostics,
                }));
            }
        } else if prepared.descriptor.oersted_source_bound {
            return Err(RunError {
                message: format!(
                    "FEM charge-only Oersted source '{}' lacks conservative_current_view",
                    prepared.resolved.module_id
                ),
            });
        }

        snapshots.extend(charge_field_snapshots(
            prepared.resolved,
            &result,
            snapshots.len() as u64 + 1,
        )?);
        records.push(serde_json::json!({
            "module_id": prepared.resolved.module_id,
            "requested_execution": prepared.resolved.requested_execution,
            "resolved_execution": {
                "discretization": prepared.resolved.resolved_discretization,
                "device": prepared.resolved.resolved_device,
                "precision": prepared.resolved.resolved_precision,
                "execution_mode": prepared.resolved.resolved_execution_mode,
            },
            "capabilities": prepared.resolved.capabilities,
            "inserted_default_boundaries": prepared.resolved.inserted_default_boundaries,
            "descriptor": prepared.descriptor,
            "conservative_current_rt0": rt0_record,
            "oersted": oersted_record,
            "result": {
                "electric_potential_v": result.electric_potential_v,
                "charge_current_density_xyz_apm2": result.charge_current_density_xyz_apm2,
                "charge_iterations": result.charge_iterations,
                "charge_relative_residual": result.charge_relative_residual,
                "net_boundary_current_a": result.net_boundary_current_a,
                "current_density_volume_average_apm2": result.current_density_volume_average_apm2,
                "dirichlet_boundary_currents_a": result.dirichlet_boundary_currents_a,
                "resolved_charge_dirichlet": result.resolved_charge_dirichlet,
                "requested_terminal_currents_a": prepared.request.prescribed_terminal_currents,
                "measured_terminal_currents_a": result.measured_terminal_currents_a,
                "terminal_voltages_v": result.terminal_voltages_v,
                "gauge_terminal_indices": result.gauge_terminal_indices,
                "diagnostics": result.diagnostics,
            }
        }));
        provenance.push(module_provenance);
    }

    ensure_antenna_not_cancelled(interrupt_requested, "before_artifact_materialization")?;

    let bytes = serde_json::to_vec_pretty(&serde_json::json!({
        "schema": "fullmag.fem.charge_transport.v1",
        "location": "node",
        "component_order": "xyz",
        "modules": records,
        "aggregate_oersted": aggregate_oersted.as_ref().map(|field| serde_json::json!({
            "field_xyz": field,
            "field_sha256": sha256_f64_slice(field),
            "unit": "A/m",
        })),
    }))
    .map_err(|error| RunError {
        message: format!("serialize FEM charge-only artifact: {error}"),
    })?;
    let mut artifacts = vec![AuxiliaryArtifact {
        relative_path: "transport/fem_charge_transport.json".into(),
        bytes,
    }];
    artifacts.extend(antenna_artifacts);
    Ok(Some(NativeFemSteadyTransportBundle {
        artifacts,
        field_snapshots: snapshots,
        provenance,
        oersted_field_xyz: aggregate_oersted,
    }))
}

fn validate_antenna_terminal_mapping(
    request: &fullmag_ir::ResolvedAntennaFieldSolutionRequestIR,
    driven_boundaries: &[fullmag_ir::ResolvedFemBoundaryMarkerSetIR],
    charge_dirichlet: &[(u32, f64)],
) -> Result<(), RunError> {
    let mut dirichlet_attributes = std::collections::BTreeSet::new();
    for (attribute, _) in charge_dirichlet {
        if !dirichlet_attributes.insert(*attribute) {
            return Err(RunError {
                message: format!(
                    "antenna port '{}' repeats native Dirichlet boundary attribute {}",
                    request.port_mode_id, attribute
                ),
            });
        }
    }
    let mut terminal_ids = std::collections::BTreeSet::new();
    let mut terminal_by_attribute = std::collections::BTreeMap::new();
    let legacy_voltage_terminals = !charge_dirichlet.is_empty();
    for boundary in driven_boundaries {
        if !terminal_ids.insert(boundary.id.as_str()) {
            return Err(RunError {
                message: format!(
                    "antenna port '{}' repeats terminal id '{}'",
                    request.port_mode_id, boundary.id
                ),
            });
        }
        for attribute in &boundary.boundary_attributes {
            if legacy_voltage_terminals && !dirichlet_attributes.contains(attribute) {
                return Err(RunError {
                    message: format!(
                        "antenna terminal '{}' is not present in the native Dirichlet solve",
                        boundary.id
                    ),
                });
            }
            if let Some(other_terminal) = terminal_by_attribute.insert(*attribute, &boundary.id) {
                return Err(RunError {
                    message: format!(
                        "antenna port '{}' assigns boundary attribute {} to both '{}' and '{}'",
                        request.port_mode_id, attribute, other_terminal, boundary.id
                    ),
                });
            }
        }
    }
    for attribute in &dirichlet_attributes {
        if !terminal_by_attribute.contains_key(attribute) {
            return Err(RunError {
                message: format!(
                    "antenna port '{}' leaves native Dirichlet boundary attribute {} outside all current-driven terminals",
                    request.port_mode_id, attribute
                ),
            });
        }
    }
    for branch in &request.branches {
        for terminal_id in [
            &branch.inlet_terminal_boundary_id,
            &branch.outlet_terminal_boundary_id,
        ] {
            if !terminal_ids.contains(terminal_id.as_str()) {
                return Err(RunError {
                    message: format!(
                        "antenna port '{}' references unresolved terminal '{}'",
                        request.port_mode_id, terminal_id
                    ),
                });
            }
        }
    }
    Ok(())
}

fn requested_antenna_terminal_currents(
    request: &fullmag_ir::ResolvedAntennaFieldSolutionRequestIR,
    driven_boundaries: &[fullmag_ir::ResolvedFemBoundaryMarkerSetIR],
    charge_dirichlet: &[(u32, f64)],
) -> Result<Vec<(Vec<u32>, f64)>, RunError> {
    validate_antenna_terminal_mapping(request, driven_boundaries, charge_dirichlet)?;
    let mut currents = std::collections::BTreeMap::<&str, f64>::new();
    for boundary in driven_boundaries {
        currents.insert(&boundary.id, 0.0);
    }
    for branch in &request.branches {
        if !branch.signed_weight.is_finite() || branch.signed_weight == 0.0 {
            return Err(RunError {
                message: format!(
                    "antenna port '{}' contains a zero or non-finite branch weight",
                    request.port_mode_id
                ),
            });
        }
        *currents
            .get_mut(branch.inlet_terminal_boundary_id.as_str())
            .expect("terminal mapping validated") -= branch.signed_weight;
        *currents
            .get_mut(branch.outlet_terminal_boundary_id.as_str())
            .expect("terminal mapping validated") += branch.signed_weight;
    }
    driven_boundaries
        .iter()
        .map(|boundary| {
            let current = currents[boundary.id.as_str()];
            if boundary.boundary_attributes.is_empty() || !current.is_finite() {
                return Err(RunError {
                    message: format!(
                        "antenna terminal '{}' has no boundary attributes or a non-finite requested current",
                        boundary.id
                    ),
                });
            }
            Ok((boundary.boundary_attributes.clone(), current))
        })
        .collect()
}

fn measured_prescribed_port_current(
    request: &fullmag_ir::ResolvedAntennaFieldSolutionRequestIR,
    targets: &[(Vec<u32>, f64)],
    measured_currents_a: &[f64],
) -> Result<f64, RunError> {
    if targets.len() != measured_currents_a.len() || targets.is_empty() {
        return Err(RunError {
            message: "antenna terminal-current certificate length mismatch".into(),
        });
    }
    for ((_, expected), measured) in targets.iter().zip(measured_currents_a) {
        if !measured.is_finite() || (measured - expected).abs() > 1.0e-18 + 1.0e-8 * expected.abs()
        {
            return Err(RunError {
                message: format!(
                    "antenna port '{}' signed terminal-current certificate failed: expected={expected:.17e} A, measured={measured:.17e} A",
                    request.port_mode_id
                ),
            });
        }
    }
    Ok(1.0)
}

fn measured_port_current(
    request: &fullmag_ir::ResolvedAntennaFieldSolutionRequestIR,
    driven_boundaries: &[fullmag_ir::ResolvedFemBoundaryMarkerSetIR],
    charge_dirichlet: &[(u32, f64)],
    boundary_currents_a: &[f64],
) -> Result<f64, RunError> {
    if charge_dirichlet.len() != boundary_currents_a.len() {
        return Err(RunError {
            message: "antenna terminal-current result does not match Dirichlet ordering".into(),
        });
    }
    validate_antenna_terminal_mapping(request, driven_boundaries, charge_dirichlet)?;
    let current_by_attribute = charge_dirichlet
        .iter()
        .zip(boundary_currents_a)
        .map(|((attribute, _), current)| (*attribute, *current))
        .collect::<std::collections::BTreeMap<_, _>>();
    let boundary_current = |terminal_id: &str| -> Result<f64, RunError> {
        let boundary = driven_boundaries
            .iter()
            .find(|boundary| boundary.id == terminal_id)
            .ok_or_else(|| RunError {
                message: format!(
                    "antenna port '{}' references unresolved terminal '{}'",
                    request.port_mode_id, terminal_id
                ),
            })?;
        boundary
            .boundary_attributes
            .iter()
            .map(|attribute| current_by_attribute.get(attribute).copied())
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| RunError {
                message: format!(
                    "antenna terminal '{}' is not present in the native Dirichlet solve",
                    terminal_id
                ),
            })
            .map(|currents| currents.into_iter().sum::<f64>())
    };

    let mut branch_currents = Vec::with_capacity(request.branches.len());
    for branch in &request.branches {
        if !branch.signed_weight.is_finite() || branch.signed_weight == 0.0 {
            return Err(RunError {
                message: format!(
                    "antenna port '{}' contains a zero or non-finite branch weight",
                    request.port_mode_id
                ),
            });
        }
        let inlet_current = boundary_current(&branch.inlet_terminal_boundary_id)?;
        let outlet_current = boundary_current(&branch.outlet_terminal_boundary_id)?;
        let pair_scale = inlet_current.abs().max(outlet_current.abs()).max(1.0e-30);
        if !inlet_current.is_finite()
            || !outlet_current.is_finite()
            || (inlet_current + outlet_current).abs() / pair_scale > 1.0e-8
        {
            return Err(RunError {
                message: format!(
                    "antenna port '{}' branch '{}' has unbalanced inlet/outlet currents: inlet={inlet_current:.17e} A, outlet={outlet_current:.17e} A",
                    request.port_mode_id, branch.id
                ),
            });
        }
        // The weak terminal current is the outward flux. The outlet is therefore
        // the single canonical positive orientation for a branch; the inlet
        // is used only to certify local current balance.
        branch_currents.push((branch.signed_weight, outlet_current));
    }
    let positive_weight = branch_currents
        .iter()
        .filter(|(weight, _)| *weight > 0.0)
        .map(|(weight, _)| *weight)
        .sum::<f64>();
    let negative_weight = branch_currents
        .iter()
        .filter(|(weight, _)| *weight < 0.0)
        .map(|(weight, _)| *weight)
        .sum::<f64>();
    if positive_weight <= 0.0
        || negative_weight >= 0.0
        || (positive_weight + negative_weight).abs() > 1.0e-12
    {
        return Err(RunError {
            message: format!(
                "antenna port '{}' branch weights are not balanced: positive={positive_weight:.17e}, negative={negative_weight:.17e}",
                request.port_mode_id,
            ),
        });
    }

    let reference_current = branch_currents
        .iter()
        .find(|(weight, _)| *weight > 0.0)
        .map(|(weight, current)| *current / *weight)
        .unwrap_or(f64::NAN);
    let normalized_currents = branch_currents
        .iter()
        .map(|(weight, current)| *current / *weight)
        .collect::<Vec<_>>();
    let scale = reference_current.abs().max(1.0e-30);
    if !reference_current.is_finite() || reference_current <= 1.0e-30 {
        return Err(RunError {
            message: format!(
                "antenna port '{}' terminal currents are zero, reversed, or unbalanced",
                request.port_mode_id
            ),
        });
    }
    for (normalized_current, (weight, _)) in normalized_currents.iter().zip(&branch_currents) {
        if !normalized_current.is_finite()
            || (*normalized_current - reference_current).abs() / scale > 1.0e-6
        {
            return Err(RunError {
                message: format!(
                    "antenna port '{}' terminal-current split disagrees with signed branch weights: measured_current={normalized_current:.17e} A, reference_current={reference_current:.17e} A, signed_weight={weight:.17e}",
                    request.port_mode_id,
                ),
            });
        }
    }
    Ok(reference_current)
}

fn preflight_charge_transport_plans<'a>(
    mesh: &MeshIR,
    charge_transport_plans: &'a [ResolvedChargeTransportPlanIR],
) -> Result<Vec<PreparedChargeTransport<'a>>, RunError> {
    let mut prepared = Vec::with_capacity(charge_transport_plans.len());
    for resolved in charge_transport_plans {
        let descriptor = resolved.fem_cpu_double.as_ref().ok_or_else(|| RunError {
            message: format!(
                "FEM charge transport '{}' lacks fem_cpu_double descriptor",
                resolved.module_id
            ),
        })?;
        validate_resolved_descriptor(mesh, resolved, descriptor)?;
        let gauge = match descriptor.charge_gauge {
            ChargePotentialGaugeIR::DirichletReference => {
                NativeFemSteadyTransportGauge::BoundaryReference
            }
            ChargePotentialGaugeIR::ZeroMean => NativeFemSteadyTransportGauge::ZeroMeanPotential,
            ChargePotentialGaugeIR::TerminalReference => {
                NativeFemSteadyTransportGauge::BoundaryReference
            }
        };
        prepared.push(PreparedChargeTransport {
            resolved,
            descriptor,
            request: NativeFemChargeTransportRequest {
                mesh: mesh.clone(),
                gauge,
                conductivity_spm_per_element: descriptor
                    .charge_conductivity_spm_per_element
                    .clone(),
                relative_tolerance: descriptor.charge_solver.linear.relative_tolerance,
                absolute_tolerance: descriptor.charge_solver.linear.absolute_tolerance,
                maximum_iterations: descriptor.charge_solver.linear.max_iterations,
                charge_dirichlet: descriptor.charge_dirichlet.clone(),
                prescribed_terminal_currents: resolved
                    .antenna_field_solution_request
                    .as_ref()
                    .map(|request| {
                        requested_antenna_terminal_currents(
                            request,
                            &descriptor.charge_driven_boundaries,
                            &descriptor.charge_dirichlet,
                        )
                    })
                    .transpose()?,
            },
            provenance: charge_transport_provenance(resolved, descriptor, mesh.cell_count()),
        });
    }
    Ok(prepared)
}

fn validate_resolved_descriptor(
    mesh: &MeshIR,
    resolved: &ResolvedChargeTransportPlanIR,
    descriptor: &ResolvedFemChargeTransportIR,
) -> Result<(), RunError> {
    if descriptor.charge_definition.conservative_current_source.is_some() {
        return Err(RunError {
            message: format!(
                "FEM charge transport '{}' conservative_current_source requires a current-driven owned-bundle request; legacy native charge execution is forbidden",
                resolved.module_id
            ),
        });
    }
    let boundaries_valid = descriptor
        .charge_insulating_boundaries
        .iter()
        .flat_map(|set| set.boundary_attributes.iter().copied())
        .chain(
            descriptor
                .charge_driven_boundaries
                .iter()
                .flat_map(|set| set.boundary_attributes.iter().copied()),
        )
        .chain(
            descriptor
                .charge_dirichlet
                .iter()
                .map(|(attribute, _)| *attribute),
        )
        .all(|attribute| attribute != 0 && mesh.boundary_markers.contains(&attribute));
    let expected_stage = if descriptor.oersted_source_bound {
        "fem_charge_then_oersted_once.v1"
    } else {
        "fem_charge_once.v1"
    };
    let contradictory = resolved.resolved_coupling != TransportCouplingIR::OneWay
        || !matches!(
            resolved.requested_execution.discretization,
            fullmag_ir::BackendTarget::Fem | fullmag_ir::BackendTarget::Auto
        )
        || !matches!(
            resolved.requested_execution.device,
            ExecutionDevice::Cpu | ExecutionDevice::Auto
        )
        || resolved.requested_execution.precision != ExecutionPrecision::Double
        || resolved.requested_execution.execution_mode != ExecutionMode::Strict
        || resolved.resolved_discretization != fullmag_ir::BackendTarget::Fem
        || resolved.resolved_device != ExecutionDevice::Cpu
        || resolved.resolved_precision != ExecutionPrecision::Double
        || resolved.resolved_execution_mode != ExecutionMode::Strict
        || resolved.operator_version != OPERATOR_VERSION
        || resolved.physical_residual_version != PHYSICAL_RESIDUAL_VERSION
        || descriptor.descriptor_schema != "fullmag.fem.charge_transport_descriptor.v1"
        || descriptor.time_envelope.is_some()
        || descriptor.charge_definition.gauge != descriptor.charge_gauge
        || descriptor.charge_definition.solver != descriptor.charge_solver
        || descriptor.charge_definition.domain != descriptor.charge_domain.regions
        || descriptor.charge_domain.element_mask.len() != mesh.cell_count()
        || descriptor
            .charge_domain
            .element_mask
            .iter()
            .any(|selected| !selected)
        || descriptor.charge_conductivity_spm_per_element.len() != mesh.cell_count()
        || descriptor
            .charge_conductivity_spm_per_element
            .iter()
            .any(|sigma| !sigma.is_finite() || *sigma <= 0.0)
        || descriptor.charge_solver.operator_version != OPERATOR_VERSION
        || descriptor.charge_solver.physical_residual_version != PHYSICAL_RESIDUAL_VERSION
        || !matches!(descriptor.charge_solver.engine.as_str(), "auto" | "cg")
        || descriptor.charge_solver.linear.absolute_tolerance != 0.0
        || descriptor.resolved_charge_engine != "cg"
        || descriptor.stage_coupling != expected_stage
        || !boundaries_valid
        || (descriptor.charge_gauge == ChargePotentialGaugeIR::TerminalReference
            && (resolved.antenna_field_solution_request.is_none()
                || !descriptor.charge_dirichlet.is_empty()))
        || (resolved.antenna_field_solution_request.is_some()
            && descriptor.charge_dirichlet.is_empty()
            && descriptor.charge_gauge != ChargePotentialGaugeIR::TerminalReference)
        || (descriptor.charge_gauge == ChargePotentialGaugeIR::DirichletReference
            && descriptor.charge_dirichlet.is_empty())
        || (descriptor.charge_gauge == ChargePotentialGaugeIR::ZeroMean
            && !descriptor.charge_dirichlet.is_empty());
    if contradictory {
        return Err(RunError {
            message: format!(
                "FEM charge transport '{}' has an unsupported or contradictory descriptor",
                resolved.module_id
            ),
        });
    }
    if descriptor.oersted_source_bound && descriptor.conservative_current_view.is_none() {
        return Err(RunError {
            message: format!(
                "FEM charge transport '{}' binds Oersted without conservative_current_view",
                resolved.module_id
            ),
        });
    }
    if resolved.antenna_field_solution_request.is_some()
        && (!descriptor.oersted_source_bound || descriptor.conservative_current_view.is_none())
    {
        return Err(RunError {
            message: format!(
                "FEM antenna field solution '{}' requires a bound Oersted source and conservative_current_view",
                resolved.module_id
            ),
        });
    }
    if let Some(request) = resolved.antenna_field_solution_request.as_ref() {
        requested_antenna_terminal_currents(
            request,
            &descriptor.charge_driven_boundaries,
            &descriptor.charge_dirichlet,
        )?;
    }
    Ok(())
}

fn solve_native_fem_charge_transport(
    request: &NativeFemChargeTransportRequest,
) -> Result<NativeFemChargeTransportResult, RunError> {
    let packed_mesh = super::PackedNativeMesh::new(&request.mesh);
    let attributes = request
        .charge_dirichlet
        .iter()
        .map(|entry| entry.0)
        .collect::<Vec<_>>();
    let values = request
        .charge_dirichlet
        .iter()
        .map(|entry| entry.1)
        .collect::<Vec<_>>();
    let constitutive = c_string(CONSTITUTIVE_VERSION, "constitutive_version")?;
    let operator = c_string(OPERATOR_VERSION, "operator_version")?;
    let residual = c_string(PHYSICAL_RESIDUAL_VERSION, "physical_residual_version")?;
    let mut potential = vec![0.0; request.mesh.nodes.len()];
    let mut current = vec![0.0; request.mesh.nodes.len() * 3];
    let request_ffi = ffi::fullmag_fem_charge_transport_request_v1 {
        abi_version: ffi::FULLMAG_FEM_CHARGE_TRANSPORT_ABI_VERSION,
        reserved_flags: 0,
        struct_size: std::mem::size_of::<ffi::fullmag_fem_charge_transport_request_v1>() as u64,
        execution_lane: ffi::fullmag_fem_steady_transport_execution_lane::FULLMAG_FEM_STEADY_TRANSPORT_CPU_DOUBLE,
        charge_gauge: match request.gauge {
            NativeFemSteadyTransportGauge::BoundaryReference => ffi::fullmag_fem_steady_transport_charge_gauge::FULLMAG_FEM_STEADY_TRANSPORT_BOUNDARY_REFERENCE,
            NativeFemSteadyTransportGauge::ZeroMeanPotential => ffi::fullmag_fem_steady_transport_charge_gauge::FULLMAG_FEM_STEADY_TRANSPORT_ZERO_MEAN_POTENTIAL,
        },
        constitutive_version: constitutive.as_ptr(),
        operator_version: operator.as_ptr(),
        physical_residual_version: residual.as_ptr(),
        mesh: packed_mesh.descriptor(&request.mesh),
        charge_conductivity_spm_per_element: const_ptr(&request.conductivity_spm_per_element),
        charge_conductivity_spm_per_element_len: request.conductivity_spm_per_element.len() as u64,
        relative_tolerance: request.relative_tolerance,
        absolute_tolerance: request.absolute_tolerance,
        maximum_iterations: request.maximum_iterations,
        dirichlet_boundary_attributes: const_ptr(&attributes),
        dirichlet_boundary_values_v: const_ptr(&values),
        dirichlet_boundary_count: attributes.len() as u64,
    };
    let result_v1 = ffi::fullmag_fem_charge_transport_result_v1 {
        abi_version: ffi::FULLMAG_FEM_CHARGE_TRANSPORT_ABI_VERSION,
        reserved_flags: 0,
        struct_size: std::mem::size_of::<ffi::fullmag_fem_charge_transport_result_v1>() as u64,
        electric_potential_v: potential.as_mut_ptr(),
        electric_potential_v_capacity: potential.len() as u64,
        electric_potential_v_len: 0,
        charge_current_density_xyz_apm2: current.as_mut_ptr(),
        charge_current_density_xyz_apm2_capacity: current.len() as u64,
        charge_current_density_xyz_apm2_len: 0,
        charge_converged: 0,
        charge_iterations: 0,
        charge_relative_residual: f64::NAN,
        net_boundary_current_a: f64::NAN,
        current_density_volume_average_apm2: [f64::NAN; 3],
        error_message: [0; 256],
        diagnostics_json: [0; 1024],
    };
    let (
        result,
        terminal_currents,
        resolved_charge_dirichlet,
        measured_terminal_currents_a,
        terminal_voltages_v,
        gauge_terminal_indices,
    ) = if let Some(targets) = request.prescribed_terminal_currents.as_ref() {
        let mut offsets = Vec::with_capacity(targets.len() + 1);
        let mut terminal_attributes = Vec::new();
        let mut requested_currents = Vec::with_capacity(targets.len());
        offsets.push(0);
        for (group, current_a) in targets {
            terminal_attributes.extend(group);
            offsets.push(terminal_attributes.len() as u64);
            requested_currents.push(*current_a);
        }
        let mut base = request_ffi;
        base.dirichlet_boundary_attributes = ptr::null();
        base.dirichlet_boundary_values_v = ptr::null();
        base.dirichlet_boundary_count = 0;
        let request_v3 = ffi::fullmag_fem_charge_transport_request_v3 {
            abi_version: ffi::FULLMAG_FEM_CHARGE_TERMINAL_CURRENT_ABI_VERSION,
            reserved_flags: 0,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_charge_transport_request_v3>() as u64,
            base,
            terminal_attribute_offsets: offsets.as_ptr(),
            terminal_attribute_offsets_len: offsets.len() as u64,
            terminal_boundary_attributes: terminal_attributes.as_ptr(),
            terminal_boundary_attributes_len: terminal_attributes.len() as u64,
            requested_outward_currents_a: requested_currents.as_ptr(),
            terminal_count: targets.len() as u64,
        };
        let mut voltages = vec![0.0; targets.len()];
        let mut measured = vec![0.0; targets.len()];
        let mut gauge_indices = vec![0; targets.len()];
        let mut result_v3 = ffi::fullmag_fem_charge_transport_result_v3 {
            abi_version: ffi::FULLMAG_FEM_CHARGE_TERMINAL_CURRENT_ABI_VERSION,
            reserved_flags: 0,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_charge_transport_result_v3>() as u64,
            base: result_v1,
            terminal_voltages_v: voltages.as_mut_ptr(),
            terminal_voltages_v_capacity: voltages.len() as u64,
            terminal_voltages_v_len: 0,
            measured_outward_currents_a: measured.as_mut_ptr(),
            measured_outward_currents_a_capacity: measured.len() as u64,
            measured_outward_currents_a_len: 0,
            gauge_terminal_indices: gauge_indices.as_mut_ptr(),
            gauge_terminal_indices_capacity: gauge_indices.len() as u64,
            gauge_terminal_indices_len: 0,
        };
        let status =
            unsafe { ffi::fullmag_fem_solve_charge_transport_v3(&request_v3, &mut result_v3) };
        if status != ffi::FULLMAG_FEM_OK {
            return Err(RunError {
                message: chars(&result_v3.base.error_message),
            });
        }
        if result_v3.terminal_voltages_v_len as usize != targets.len()
            || result_v3.measured_outward_currents_a_len as usize != targets.len()
            || result_v3.gauge_terminal_indices_len == 0
            || result_v3.gauge_terminal_indices_len as usize > targets.len()
            || voltages
                .iter()
                .chain(&measured)
                .any(|value| !value.is_finite())
        {
            return Err(RunError {
                message: "native FEM terminal-current solve returned malformed terminal output"
                    .into(),
            });
        }
        gauge_indices.truncate(result_v3.gauge_terminal_indices_len as usize);
        if gauge_indices
            .iter()
            .any(|index| *index as usize >= targets.len())
        {
            return Err(RunError {
                message: "native FEM terminal-current solve returned an invalid gauge index".into(),
            });
        }
        let resolved = targets
            .iter()
            .zip(&voltages)
            .flat_map(|((group, _), voltage)| {
                group.iter().map(move |attribute| (*attribute, *voltage))
            })
            .collect();
        (
            result_v3.base,
            Vec::new(),
            resolved,
            measured,
            voltages,
            gauge_indices,
        )
    } else {
        let mut terminal_currents = vec![0.0; attributes.len()];
        let mut result_v2 = ffi::fullmag_fem_charge_transport_result_v2 {
            base: result_v1,
            dirichlet_boundary_currents_a: terminal_currents.as_mut_ptr(),
            dirichlet_boundary_currents_a_capacity: terminal_currents.len() as u64,
            dirichlet_boundary_currents_a_len: 0,
        };
        let status =
            unsafe { ffi::fullmag_fem_solve_charge_transport_v2(&request_ffi, &mut result_v2) };
        if status != ffi::FULLMAG_FEM_OK {
            return Err(RunError {
                message: chars(&result_v2.base.error_message),
            });
        }
        if result_v2.dirichlet_boundary_currents_a_len as usize != terminal_currents.len()
            || terminal_currents.iter().any(|value| !value.is_finite())
        {
            return Err(RunError {
                message: "native FEM charge-only solve returned invalid terminal currents".into(),
            });
        }
        (
            result_v2.base,
            terminal_currents,
            request.charge_dirichlet.clone(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
        )
    };
    if result.charge_converged == 0
        || result.electric_potential_v_len as usize != potential.len()
        || result.charge_current_density_xyz_apm2_len as usize != current.len()
        || potential
            .iter()
            .chain(&current)
            .any(|value| !value.is_finite())
    {
        return Err(RunError {
            message: "native FEM charge-only solve returned invalid or unconverged output".into(),
        });
    }
    let diagnostics =
        serde_json::from_str(&chars(&result.diagnostics_json)).map_err(|error| RunError {
            message: format!("invalid native FEM charge-only diagnostics JSON: {error}"),
        })?;
    Ok(NativeFemChargeTransportResult {
        electric_potential_v: potential,
        charge_current_density_xyz_apm2: triples(current),
        charge_iterations: result.charge_iterations,
        charge_relative_residual: result.charge_relative_residual,
        net_boundary_current_a: result.net_boundary_current_a,
        current_density_volume_average_apm2: result.current_density_volume_average_apm2,
        dirichlet_boundary_currents_a: terminal_currents,
        resolved_charge_dirichlet,
        measured_terminal_currents_a,
        terminal_voltages_v,
        gauge_terminal_indices,
        diagnostics,
    })
}

fn charge_request_for_rt0(
    request: &NativeFemChargeTransportRequest,
    resolved_charge_dirichlet: &[(u32, f64)],
) -> NativeFemSteadyTransportRequest {
    NativeFemSteadyTransportRequest {
        mesh: request.mesh.clone(),
        execution: NativeFemSteadyTransportExecution::CpuDouble,
        interface: NativeFemSteadyTransportInterface::TransparentConformingH1,
        gauge: request.gauge,
        constitutive_model: NativeFemSteadyTransportConstitutiveModel::OneWay,
        constitutive_version: CONSTITUTIVE_VERSION.into(),
        operator_version: "fem_charge_spin_conforming_h1_p1.transparent.v1".into(),
        physical_residual_version: "transport_balance_integrated_l2.v1".into(),
        charge_conductivity_spm_per_element: request.conductivity_spm_per_element.clone(),
        magnetization: vec![[0.0, 0.0, 1.0]; request.mesh.nodes.len()],
        sigma_s_spm: 1.0,
        sigma_parallel_spm: None,
        sigma_perpendicular_spm: None,
        sigma_ahe_spm: None,
        polarization_p: 0.0,
        theta_sh: 0.0,
        lambda_sf_m: 1.0,
        lambda_j_m: None,
        lambda_phi_m: None,
        gamma_e_per_ts: 1.0,
        saturation_magnetization_apm: 1.0,
        relative_tolerance: request.relative_tolerance,
        absolute_tolerance: request.absolute_tolerance,
        maximum_iterations: request.maximum_iterations,
        charge_dirichlet: resolved_charge_dirichlet.to_vec(),
        spin_dirichlet: Vec::new(),
    }
}

fn charge_transport_provenance(
    resolved: &ResolvedChargeTransportPlanIR,
    descriptor: &ResolvedFemChargeTransportIR,
    element_count: usize,
) -> TransportExecutionProvenance {
    TransportExecutionProvenance {
        module_id: resolved.module_id.clone(),
        current_source_id: resolved.module_id.clone(),
        requested_discretization: format!("{:?}", resolved.requested_execution.discretization)
            .to_ascii_lowercase(),
        requested_device: format!("{:?}", resolved.requested_execution.device).to_ascii_lowercase(),
        requested_precision: format!("{:?}", resolved.requested_execution.precision)
            .to_ascii_lowercase(),
        requested_execution_mode: format!("{:?}", resolved.requested_execution.execution_mode)
            .to_ascii_lowercase(),
        resolved_discretization: "fem".into(),
        resolved_device: "cpu".into(),
        resolved_precision: "double".into(),
        resolved_execution_mode: "strict".into(),
        runtime_family: "fullmag_fem".into(),
        runtime_id: "fullmag_fem_managed".into(),
        engine_id: "fem_cpu_native_charge_only".into(),
        charge_solver_engine: descriptor.resolved_charge_engine.clone(),
        spin_solver_engine: "none".into(),
        constitutive_version: CONSTITUTIVE_VERSION.into(),
        operator_version: resolved.operator_version.clone(),
        physical_residual_version: resolved.physical_residual_version.clone(),
        charge_operator_version: Some(resolved.operator_version.clone()),
        spin_operator_version: None,
        interface_formula_versions: Vec::new(),
        torque_formula_version: None,
        interface_realization: "not_applicable_charge_only".into(),
        stage_coupling: descriptor.stage_coupling.clone(),
        capability_status: descriptor.capability_status.clone(),
        implementation_state: descriptor.implementation_state.clone(),
        validation_state: descriptor.validation_state.clone(),
        validation_scope: descriptor.validation_scope.clone(),
        inserted_default_boundaries: resolved.inserted_default_boundaries.clone(),
        charge_domain: descriptor.charge_domain.clone(),
        spin_domain: ResolvedFemTransportDomainIR {
            regions: Vec::new(),
            element_mask: vec![false; element_count],
        },
        charge_insulating_boundaries: descriptor.charge_insulating_boundaries.clone(),
        spin_insulating_boundaries: Vec::new(),
        interfaces: Vec::new(),
        torque_target: None,
        fdm_interfaces: Vec::new(),
        fdm_torque_target_cells: Vec::new(),
        fallback: None,
        degradation: None,
        oersted_source_kind: None,
        oersted_source_current_sha256: None,
        oersted_mesh_source_sha256: None,
        oersted_field_sha256: None,
        conservative_current_view_identity_digest: None,
        conservative_current_balance_certificate_digest: None,
        stage_cache_policy: Some("steady_charge_source_invariant.v1".into()),
        stage_cache_key_digest: None,
        stage_cache_last_observation: Some("precomputed_once".into()),
        stage_cache_hit_count: Some(0),
        stage_cache_miss_count: Some(1),
        stage_cache_invalidation_count: Some(0),
    }
}

fn charge_field_snapshots(
    resolved: &ResolvedChargeTransportPlanIR,
    result: &NativeFemChargeTransportResult,
    first_revision: u64,
) -> Result<Vec<FieldSnapshot>, RunError> {
    if first_revision == 0
        || result.charge_current_density_xyz_apm2.len() != result.electric_potential_v.len()
    {
        return Err(RunError {
            message: "native FEM charge-only outputs disagree on node count or revision".into(),
        });
    }
    let scope = format!("transport_module:{}:full_solve_domain", resolved.module_id);
    let fields = [
        (
            "V_electric",
            1,
            "scalar",
            result.electric_potential_v.clone(),
        ),
        (
            "J_charge",
            3,
            "xyz",
            result
                .charge_current_density_xyz_apm2
                .iter()
                .flatten()
                .copied()
                .collect(),
        ),
    ];
    fields
        .into_iter()
        .enumerate()
        .map(|(index, (id, n_comp, order, values))| {
            let spec = fullmag_quantities::quantity_spec(id).ok_or_else(|| RunError {
                message: format!("uncatalogued FEM charge quantity '{id}'"),
            })?;
            FieldSnapshot::new(
                id,
                0,
                0.0,
                0.0,
                n_comp,
                order,
                spec.location.as_str(),
                scope.clone(),
                first_revision + index as u64,
                values,
            )
            .map_err(|message| RunError { message })
        })
        .collect()
}

fn validate_oersted_field(field: &[f64], node_count: usize) -> Result<(), RunError> {
    if field.len() != node_count * 3 || field.iter().any(|value| !value.is_finite()) {
        return Err(RunError {
            message: "FEM charge-only Oersted field has invalid length or non-finite values".into(),
        });
    }
    Ok(())
}

fn add_flat_field(target: &mut [f64], contribution: &[f64]) -> Result<(), RunError> {
    if target.len() != contribution.len() {
        return Err(RunError {
            message: "FEM charge-only Oersted field lengths disagree".into(),
        });
    }
    for (target, contribution) in target.iter_mut().zip(contribution) {
        *target += contribution;
    }
    Ok(())
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
        message: format!("FEM charge-only {label} contains NUL"),
    })
}
fn triples(values: Vec<f64>) -> Vec<[f64; 3]> {
    values.chunks_exact(3).map(|v| [v[0], v[1], v[2]]).collect()
}
fn sha256_f64_slice(values: &[f64]) -> String {
    let mut h = Sha256::new();
    for value in values {
        h.update(value.to_le_bytes());
    }
    format!("sha256:{:x}", h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn port_request(
        branches: &[(&str, &str, f64)],
    ) -> fullmag_ir::ResolvedAntennaFieldSolutionRequestIR {
        fullmag_ir::ResolvedAntennaFieldSolutionRequestIR {
            solution_id: "solution".into(),
            stage_id: "stage".into(),
            source_object_id: "antenna".into(),
            port_mode_id: "port".into(),
            branches: branches
                .iter()
                .enumerate()
                .map(|(index, (inlet, outlet, signed_weight))| {
                    fullmag_ir::ResolvedAntennaPortBranchIR {
                        id: format!("branch_{index}"),
                        inlet_terminal_boundary_id: (*inlet).into(),
                        outlet_terminal_boundary_id: (*outlet).into(),
                        signed_weight: *signed_weight,
                    }
                })
                .collect(),
            geometry_revision: "geometry".into(),
            material_revision: "material".into(),
            mesh_digest: "mesh".into(),
            requested_execution: serde_json::json!({}),
            resolved_execution: serde_json::json!({}),
        }
    }

    fn driven_boundaries() -> Vec<fullmag_ir::ResolvedFemBoundaryMarkerSetIR> {
        vec![
            fullmag_ir::ResolvedFemBoundaryMarkerSetIR {
                id: "signal_in".into(),
                boundary_attributes: vec![11],
            },
            fullmag_ir::ResolvedFemBoundaryMarkerSetIR {
                id: "signal_out".into(),
                boundary_attributes: vec![12],
            },
            fullmag_ir::ResolvedFemBoundaryMarkerSetIR {
                id: "return_a_in".into(),
                boundary_attributes: vec![13],
            },
            fullmag_ir::ResolvedFemBoundaryMarkerSetIR {
                id: "return_a_out".into(),
                boundary_attributes: vec![14],
            },
            fullmag_ir::ResolvedFemBoundaryMarkerSetIR {
                id: "return_b_in".into(),
                boundary_attributes: vec![15],
            },
            fullmag_ir::ResolvedFemBoundaryMarkerSetIR {
                id: "return_b_out".into(),
                boundary_attributes: vec![16],
            },
        ]
    }

    #[test]
    fn antenna_port_requests_signed_terminal_fluxes() {
        let request = port_request(&[
            ("signal_in", "signal_out", 1.0),
            ("return_a_in", "return_a_out", -0.5),
            ("return_b_in", "return_b_out", -0.5),
        ]);
        let dirichlet = (11..=16)
            .map(|attribute| (attribute, 0.0))
            .collect::<Vec<_>>();
        let terminals =
            requested_antenna_terminal_currents(&request, &driven_boundaries(), &dirichlet)
                .expect("balanced port must produce signed outward terminal fluxes");
        assert_eq!(
            terminals,
            vec![
                (vec![11], -1.0),
                (vec![12], 1.0),
                (vec![13], 0.5),
                (vec![14], -0.5),
                (vec![15], 0.5),
                (vec![16], -0.5),
            ]
        );
        assert_eq!(
            measured_prescribed_port_current(
                &request,
                &terminals,
                &[-1.0, 1.0, 0.5, -0.5, 0.5, -0.5],
            )
            .expect("signed terminal currents agree with the one-ampere basis"),
            1.0
        );
        assert!(measured_prescribed_port_current(
            &request,
            &terminals,
            &[-1.0, 1.0, -0.5, 0.5, 0.5, -0.5],
        )
        .is_err());
    }

    #[test]
    fn antenna_port_rejects_reversed_sub_picoampere_return() {
        let request = port_request(&[
            ("signal_in", "signal_out", 1.0),
            ("return_a_in", "return_a_out", -1.0e-13),
            ("return_b_in", "return_b_out", -0.9999999999999),
        ]);
        let terminals = vec![
            (vec![11], -1.0),
            (vec![12], 1.0),
            (vec![13], 1.0e-13),
            (vec![14], -1.0e-13),
            (vec![15], 0.9999999999999),
            (vec![16], -0.9999999999999),
        ];
        assert!(measured_prescribed_port_current(
            &request,
            &terminals,
            &[
                -1.0,
                1.0,
                -1.0e-13,
                1.0e-13,
                0.9999999999999,
                -0.9999999999999,
            ],
        )
        .is_err());
    }

    #[test]
    fn antenna_port_current_requires_balance_and_authored_branch_split() {
        let request = port_request(&[
            ("signal_in", "signal_out", 1.0),
            ("return_a_in", "return_a_out", -0.5),
            ("return_b_in", "return_b_out", -0.5),
        ]);
        let charge_dirichlet = vec![
            (11, 1.0),
            (12, 1.0),
            (13, 0.0),
            (14, 0.0),
            (15, 0.0),
            (16, 0.0),
        ];
        let current = measured_port_current(
            &request,
            &driven_boundaries(),
            &charge_dirichlet,
            &[-2.0, 2.0, 1.0, -1.0, 1.0, -1.0],
        )
        .expect("balanced CPW terminal currents");
        assert_eq!(current, 2.0);

        let outlet_reference = measured_port_current(
            &request,
            &driven_boundaries(),
            &charge_dirichlet,
            &[-2.0, 2.00000001, 1.0, -1.0, 1.0, -1.0],
        )
        .expect("small terminal imbalance remains within the balance certificate");
        assert!((outlet_reference - 2.00000001).abs() < 1.0e-12);

        let split_error = measured_port_current(
            &request,
            &driven_boundaries(),
            &charge_dirichlet,
            &[-2.0, 2.0, 1.5, -1.5, 0.5, -0.5],
        )
        .unwrap_err();
        assert!(split_error.message.contains("branch weights"));

        let balance_error = measured_port_current(
            &request,
            &driven_boundaries(),
            &charge_dirichlet,
            &[-2.0, 2.0, 0.9, -0.9, 0.9, -0.8],
        )
        .unwrap_err();
        assert!(
            balance_error.message.contains("inlet/outlet")
                || balance_error.message.contains("unbalanced")
        );

        let orientation_error = measured_port_current(
            &request,
            &driven_boundaries(),
            &charge_dirichlet,
            &[2.0, -2.0, -1.0, 1.0, -1.0, 1.0],
        )
        .unwrap_err();
        assert!(orientation_error.message.contains("reversed"));
    }

    #[test]
    fn antenna_port_current_rejects_ambiguous_terminal_attributes() {
        let request = port_request(&[
            ("signal_in", "signal_out", 1.0),
            ("return_a_in", "return_a_out", -1.0),
        ]);
        let charge_dirichlet = vec![(11, 1.0), (12, 0.0), (13, 1.0), (14, 0.0)];
        let currents = [-1.0, 1.0, 1.0, -1.0];
        let mut boundaries = driven_boundaries();
        boundaries.truncate(4);

        let duplicate_dirichlet = vec![(11, 1.0), (11, 0.0), (13, 1.0), (14, 0.0)];
        let error = measured_port_current(&request, &boundaries, &duplicate_dirichlet, &currents)
            .unwrap_err();
        assert!(error
            .message
            .contains("repeats native Dirichlet boundary attribute 11"));

        boundaries[1].boundary_attributes = vec![11];
        let error =
            measured_port_current(&request, &boundaries, &charge_dirichlet, &currents).unwrap_err();
        assert!(error
            .message
            .contains("assigns boundary attribute 11 to both"));

        boundaries[1].boundary_attributes = vec![12];
        boundaries[1].id = "signal_in".into();
        let error =
            measured_port_current(&request, &boundaries, &charge_dirichlet, &currents).unwrap_err();
        assert!(error.message.contains("repeats terminal id 'signal_in'"));

        let mut boundaries = driven_boundaries();
        boundaries.truncate(4);
        let extra_dirichlet = vec![(11, 1.0), (12, 1.0), (13, 0.0), (14, 0.0), (99, 0.0)];
        let error = requested_antenna_terminal_currents(&request, &boundaries, &extra_dirichlet)
            .unwrap_err();
        assert!(error
            .message
            .contains("attribute 99 outside all current-driven terminals"));
    }

    #[test]
    fn charge_only_runtime_source_never_invokes_spin_solve() {
        let source = include_str!("charge_transport.rs");
        let production_source = source
            .split("#[cfg(test)]")
            .next()
            .expect("charge-only runtime source before its test module");
        assert!(production_source.contains("fullmag_fem_solve_charge_transport_v2"));
        assert!(production_source.contains("fullmag_fem_solve_charge_transport_v3"));
        assert!(!production_source.contains("ffi::fullmag_fem_solve_steady_transport_v1"));
        assert!(!production_source.contains("solve_native_fem_steady_transport(&"));
    }

    #[test]
    fn antenna_runtime_rejects_mixed_sampling_topology_instead_of_identity_downgrade() {
        let mut cells = fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]);
        cells.types[0] = fullmag_ir::FemCellTypeIR::Hex8;
        let error = resolve_antenna_sample_topology(&cells)
            .expect_err("mixed sampling topology must fail before native execution");
        assert!(error
            .message
            .contains("cannot be downgraded to identity sampling"));
    }

    #[test]
    fn antenna_runtime_keeps_empty_legacy_sampling_topology_as_explicit_identity_mode() {
        let cells = fullmag_ir::FemConnectivityIR::empty();
        assert_eq!(
            resolve_antenna_sample_topology(&cells).expect("empty legacy topology is readable"),
            None
        );
    }

    #[test]
    fn antenna_cancel_boundary_is_stable_and_non_destructive() {
        let signal = AtomicBool::new(true);
        let error = ensure_antenna_not_cancelled(Some(&signal), "after_rt0_oersted")
            .expect_err("requested cancellation must stop before publication");
        assert_eq!(
            error.message,
            "antenna field solve cancelled at after_rt0_oersted: interrupt_requested"
        );

        signal.store(false, Ordering::Release);
        ensure_antenna_not_cancelled(Some(&signal), "before_artifact_materialization")
            .expect("cleared cancellation must leave the boundary usable");
    }

    #[test]
    fn charge_only_runner_executes_native_affine_tetra_without_spin() {
        if !super::super::is_cpu_available() {
            eprintln!("skipping native FEM charge-only runner test: CPU MFEM unavailable");
            return;
        }
        let mut mesh = crate::dispatch::test_tiny_fem_plan().mesh;
        mesh.boundary_markers = vec![1, 1, 1, 2];
        let result = solve_native_fem_charge_transport(&NativeFemChargeTransportRequest {
            mesh,
            gauge: NativeFemSteadyTransportGauge::BoundaryReference,
            conductivity_spm_per_element: vec![2.0],
            relative_tolerance: 1.0e-12,
            absolute_tolerance: 0.0,
            maximum_iterations: 500,
            charge_dirichlet: vec![(1, 0.0), (2, 1.0)],
            prescribed_terminal_currents: None,
        })
        .expect("charge-only Rust runner must execute the standalone native charge ABI");

        assert_eq!(result.electric_potential_v.len(), 4);
        assert_eq!(result.charge_current_density_xyz_apm2.len(), 4);
        assert!(result.charge_relative_residual.is_finite());
        assert_eq!(result.dirichlet_boundary_currents_a.len(), 2);
        assert!(result.dirichlet_boundary_currents_a[0].abs() > 0.0);
        assert!(
            (result.dirichlet_boundary_currents_a[0] + result.dirichlet_boundary_currents_a[1])
                .abs()
                <= 1.0e-10
                    * result.dirichlet_boundary_currents_a[0]
                        .abs()
                        .max(result.dirichlet_boundary_currents_a[1].abs())
        );
        assert!(result
            .charge_current_density_xyz_apm2
            .iter()
            .flatten()
            .any(|value| value.abs() > 0.0));
    }
}
