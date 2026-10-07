use fullmag_ir::{
    AntennaConductorFemPlanIR, AntennaFieldSolveStageIR, AntennaOerstedRealizationIR,
    AntennaPortModeIR, OerstedRealization, ProblemIR, ProblemIRV04,
    ResolvedAntennaFieldSolutionRequestIR, ResolvedAntennaPortBranchIR,
};
use sha2::{Digest, Sha256};

use crate::PlanError;

fn sha256_json(value: &impl serde::Serialize) -> Result<String, PlanError> {
    let bytes = serde_json::to_vec(value).map_err(|error| PlanError {
        reasons: vec![format!("serialize antenna composition signature: {error}")],
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

/// Bind one active antenna field-solve stage and one port mode to the
/// already-resolved charge-only FEM plan. Pipeline orchestration invokes this
/// once per independent port basis; the numerical owners remain
/// CurrentTransport, ConservativeCurrentView, and Oersted.
pub fn bind_antenna_field_solve(
    problem: &ProblemIRV04,
    stage_id: &str,
    port_mode_id: &str,
    plan: &mut AntennaConductorFemPlanIR,
) -> Result<(), PlanError> {
    problem
        .validate()
        .map_err(|reasons| PlanError { reasons })?;
    let stage = problem
        .antenna_field_solve_stages
        .iter()
        .find(|stage| stage.id == stage_id)
        .ok_or_else(|| PlanError {
            reasons: vec![format!(
                "antenna field-solve stage '{stage_id}' does not exist"
            )],
        })?;
    if !stage.port_mode_ids.iter().any(|id| id == port_mode_id) {
        return Err(PlanError {
            reasons: vec![format!(
                "antenna field-solve stage '{stage_id}' does not include port mode '{port_mode_id}'"
            )],
        });
    }
    let port = problem
        .antenna_port_modes
        .iter()
        .find(|port| port.id == port_mode_id)
        .ok_or_else(|| PlanError {
            reasons: vec![format!("antenna port mode '{port_mode_id}' does not exist")],
        })?;
    if port.source_object_id != stage.source_object_id
        || port.current_transport_id != stage.current_transport_id
    {
        return Err(PlanError {
            reasons: vec![format!(
                "antenna port mode '{port_mode_id}' is not bound to stage '{stage_id}' source and CurrentTransport"
            )],
        });
    }
    bind_resolved_antenna_field_solve(stage, port, plan)
}

/// Bind one explicitly selected public 0.3 antenna field-solve stage.
///
/// This function is intentionally separate from [`crate::plan`]. A normal
/// relaxation or time-evolution plan must never start a hidden antenna solve;
/// pipeline orchestration calls this function only for the dedicated
/// precomputation stage.
pub fn bind_antenna_field_solve_v03(
    problem: &ProblemIR,
    stage_id: &str,
    port_mode_id: &str,
    plan: &mut AntennaConductorFemPlanIR,
) -> Result<(), PlanError> {
    problem
        .validate()
        .map_err(|reasons| PlanError { reasons })?;
    let stage = problem
        .antenna_field_solve_stages
        .iter()
        .find(|stage| stage.id == stage_id)
        .ok_or_else(|| PlanError {
            reasons: vec![format!(
                "antenna field-solve stage '{stage_id}' does not exist"
            )],
        })?;
    if stage.port_mode_ids.len() != 1 {
        return Err(PlanError {
            reasons: vec![format!(
                "antenna field-solve stage '{stage_id}' resolves {} port modes, but one execution plan can publish exactly one independently normalized port basis; execute one dedicated stage per port mode",
                stage.port_mode_ids.len()
            )],
        });
    }
    if stage.port_mode_ids[0] != port_mode_id {
        return Err(PlanError {
            reasons: vec![format!(
                "antenna field-solve stage '{stage_id}' does not select port mode '{port_mode_id}'"
            )],
        });
    }
    let port = problem
        .antenna_port_modes
        .iter()
        .find(|port| port.id == port_mode_id)
        .ok_or_else(|| PlanError {
            reasons: vec![format!("antenna port mode '{port_mode_id}' does not exist")],
        })?;
    if port.source_object_id != stage.source_object_id
        || port.current_transport_id != stage.current_transport_id
    {
        return Err(PlanError {
            reasons: vec![format!(
                "antenna port mode '{port_mode_id}' is not bound to stage '{stage_id}' source and CurrentTransport"
            )],
        });
    }
    bind_resolved_antenna_field_solve(stage, port, plan)
}

fn bind_resolved_antenna_field_solve(
    stage: &AntennaFieldSolveStageIR,
    port: &AntennaPortModeIR,
    plan: &mut AntennaConductorFemPlanIR,
) -> Result<(), PlanError> {
    let stage_id = stage.id.as_str();
    let outputs = stage
        .outputs
        .iter()
        .filter(|output| output.quantity == "H_ant_basis")
        .collect::<Vec<_>>();
    if outputs.len() != 1 {
        return Err(PlanError {
            reasons: vec![format!(
                "antenna field-solve stage '{stage_id}' requires exactly one H_ant_basis output"
            )],
        });
    }
    let expected_oersted = match stage.oersted_realization {
        AntennaOerstedRealizationIR::DirectTetraQuadrature => {
            OerstedRealization::BiotSavartMidpoint
        }
        AntennaOerstedRealizationIR::VectorPotentialSolver => {
            OerstedRealization::FemVectorPotential
        }
    };
    if plan.oersted_realization != expected_oersted {
        return Err(PlanError {
            reasons: vec![format!(
                "antenna field-solve stage '{stage_id}' conflicts with the resolved Oersted realization"
            )],
        });
    }
    let mesh_digest = sha256_json(&plan.mesh)?;
    let geometry_revision = sha256_json(&serde_json::json!({
        "schema": "antenna_conductor_geometry_revision.v1",
        "mesh": plan.mesh,
        "object_segments": plan.object_segments,
        "mesh_parts": plan.mesh_parts,
    }))?;
    let charge = plan
        .charge_transport_plans
        .iter_mut()
        .find(|charge| charge.module_id == stage.current_transport_id)
        .ok_or_else(|| PlanError {
            reasons: vec![format!(
                "antenna field-solve stage '{stage_id}' has no resolved charge-only CurrentTransport '{}'",
                stage.current_transport_id
            )],
        })?;
    if charge.antenna_field_solution_request.is_some() {
        return Err(PlanError {
            reasons: vec![format!(
                "antenna field-solve stage '{stage_id}' conflicts with another basis request already bound to CurrentTransport '{}'",
                stage.current_transport_id
            )],
        });
    }
    let descriptor = charge.fem_cpu_double.as_mut().ok_or_else(|| PlanError {
        reasons: vec![format!(
            "antenna field-solve stage '{stage_id}' requires a FEM CPU/double charge descriptor"
        )],
    })?;
    if descriptor.charge_definition.conservative_current_source.is_some() {
        return Err(PlanError {
            reasons: vec![format!(
                "antenna field-solve stage '{stage_id}' conservative_current_source requires the current-driven owned-bundle producer; legacy terminal-boundary binding is forbidden"
            )],
        });
    }
    if descriptor.conservative_current_view.is_none() {
        return Err(PlanError {
            reasons: vec![format!(
                "antenna field-solve stage '{stage_id}' requires ConservativeCurrentView"
            )],
        });
    }
    let material_revision = sha256_json(&serde_json::json!({
        "schema": "antenna_charge_material_revision.v1",
        "conductivity_spm_per_element": descriptor.charge_conductivity_spm_per_element,
    }))?;
    descriptor.oersted_source_bound = true;
    descriptor.stage_coupling = "fem_charge_then_oersted_once.v1".into();
    if !charge
        .capabilities
        .iter()
        .any(|value| value == "antenna.field_basis.per_ampere")
    {
        charge
            .capabilities
            .push("antenna.field_basis.per_ampere".into());
    }
    charge.antenna_field_solution_request = Some(ResolvedAntennaFieldSolutionRequestIR {
        solution_id: outputs[0].id.clone(),
        stage_id: stage.id.clone(),
        source_object_id: stage.source_object_id.clone(),
        port_mode_id: port.id.clone(),
        branches: port
            .branches
            .iter()
            .map(|branch| ResolvedAntennaPortBranchIR {
                id: branch.id.clone(),
                inlet_terminal_boundary_id: branch.inlet_terminal_ref.clone(),
                outlet_terminal_boundary_id: branch.outlet_terminal_ref.clone(),
                signed_weight: branch.signed_weight,
            })
            .collect(),
        geometry_revision,
        material_revision,
        mesh_digest,
        requested_execution: serde_json::to_value(&charge.requested_execution).map_err(
            |error| PlanError {
                reasons: vec![format!("serialize requested antenna execution: {error}")],
            },
        )?,
        resolved_execution: serde_json::json!({
            "discretization": charge.resolved_discretization,
            "device": charge.resolved_device,
            "precision": charge.resolved_precision,
            "execution_mode": charge.resolved_execution_mode,
        }),
    });
    Ok(())
}
