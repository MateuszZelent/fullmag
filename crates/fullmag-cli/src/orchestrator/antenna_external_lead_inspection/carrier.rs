//! Read-model mesh/initial-state planning, never an executable source problem.
use anyhow::{bail, Context, Result};
use fullmag_ir::{
    BackendPlanIR, BackendTarget, DynamicsIR, EnergyTermIR, ExecutionPlanIR,
    MaterialParameterNameIR, ProblemIR, RequestedTransportExecutionIR,
    ResolvedAntennaExternalLeadCurrentInputIR, SamplingIR, StudyIR,
};
use fullmag_plan::{plan_antenna_field_solve_execution, AntennaFieldSolveExecutionPlan};

const CARRIER_NOTE: &str = "antenna_external_lead_inspection_carrier_only:no_llg_execution";

fn snapshot_material_parameter(parameter: MaterialParameterNameIR) -> bool {
    matches!(
        parameter,
        MaterialParameterNameIR::Ms | MaterialParameterNameIR::Aex | MaterialParameterNameIR::Alpha
    )
}

fn snapshot_problem(problem: &ProblemIR) -> ProblemIR {
    let mut carrier = problem.clone();
    // ProblemIR requires an interaction; this neutral scaffold is not a drive.
    carrier.energy_terms = vec![EnergyTermIR::Zeeman { b: [0.0; 3] }];
    carrier
        .material_parameter_fields
        .retain(|assignment| snapshot_material_parameter(assignment.parameter));
    for region in &mut carrier.object_regions {
        region
            .material_overrides
            .retain(|assignment| snapshot_material_parameter(assignment.parameter));
    }
    for material in &mut carrier.materials {
        material.uniaxial_anisotropy = None;
        material.uniaxial_anisotropy_k2 = None;
        material.anisotropy_axis = None;
        material.cubic_anisotropy_kc1 = None;
        material.cubic_anisotropy_kc2 = None;
        material.cubic_anisotropy_kc3 = None;
        material.cubic_anisotropy_axis1 = None;
        material.cubic_anisotropy_axis2 = None;
        material.ku_field = None;
        material.ku2_field = None;
        material.kc1_field = None;
        material.kc2_field = None;
        material.kc3_field = None;
        material.interfacial_dmi = None;
        material.bulk_dmi = None;
        material.dind_field = None;
        material.dbulk_field = None;
    }
    carrier.couplings.clear();
    carrier.planar_monitors.clear();
    carrier.magnetization_constraints.clear();
    carrier.current_modules.clear();
    carrier.field_drives.clear();
    carrier.antenna_port_modes.clear();
    carrier.antenna_field_solve_stages.clear();
    carrier.antenna_target_projections.clear();
    carrier.solved_antenna_drives.clear();
    carrier.antenna_spectrum_requests.clear();
    carrier.excitation_analysis = None;
    carrier.spin_torque_modules.clear();
    carrier.spin_transport_modules.clear();
    carrier.current_density = None;
    carrier.stt_degree = None;
    carrier.stt_beta = None;
    carrier.stt_spin_polarization = None;
    carrier.stt_lambda = None;
    carrier.stt_epsilon_prime = None;
    carrier.stt_thickness = None;
    carrier.stt_fixed_layer_position = None;
    carrier.temperature = None;
    carrier.elastic_materials.clear();
    carrier.elastic_bodies.clear();
    carrier.magnetostriction_laws.clear();
    carrier.mechanical_bcs.clear();
    carrier.mechanical_loads.clear();
    carrier.physics_graph = None;
    for magnet in &mut carrier.magnets {
        magnet.absorbing_boundary = None;
    }
    // Existing canonical planning vocabulary only. No integrator is initialized
    // or advanced by this helper; these controls serve the session snapshot plan.
    carrier.study = StudyIR::TimeEvolution {
        dynamics: DynamicsIR::Llg {
            gyromagnetic_ratio: 2.211e5,
            integrator: "heun".into(),
            fixed_timestep: Some(1e-13),
            adaptive_timestep: None,
            field_refresh: None,
            mechanics: None,
        },
        sampling: SamplingIR {
            outputs: vec![],
            table_autosave: None,
            stage_autosave: None,
        },
    };
    carrier
}

pub(crate) fn plan_carrier(
    problem: &ProblemIR,
    input: &ResolvedAntennaExternalLeadCurrentInputIR,
    requested: &RequestedTransportExecutionIR,
    output: &str,
) -> Result<ExecutionPlanIR> {
    // Re-resolve the unsanitized authored problem first. Clearing physics must
    // never turn a stale or otherwise rejected source into an accepted input.
    match plan_antenna_field_solve_execution(problem, &input.stage.id, &input.port.id)
        .context("re-resolving external-lead inspection before carrier planning")?
    {
        AntennaFieldSolveExecutionPlan::ExternalLeadInspection {
            input: resolved,
            requested_execution,
            output_id,
        } if &resolved == input && &requested_execution == requested && output_id == output => {}
        _ => bail!("external-lead inspection carrier differs from the actual selected input, execution or output"),
    }
    let carrier = snapshot_problem(problem);
    let mut plan = fullmag_plan::plan(&carrier)
        .context("planning external-lead inspection mesh/initial-state carrier")?;
    if plan.common.requested_backend != BackendTarget::Fem
        || plan.common.resolved_backend != BackendTarget::Fem
        || !matches!(&plan.backend_plan, BackendPlanIR::Fem(_))
    {
        bail!("external-lead inspection carrier requires the existing FEM mesh/material planner without fallback");
    }
    plan.provenance.notes.push(CARRIER_NOTE.into());
    plan.provenance.notes.push("inspection carrier has no solver realization; dedicated source realization is FEM CPU/double, requested execution remains separate".into());
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn carrier_sanitization_preserves_authored_mesh_material_and_initial_state() {
        let mut original = ProblemIR::bootstrap_example();
        original.current_density = Some([1.0, 2.0, 3.0]);
        original.stt_degree = Some(0.5);
        original.stt_beta = Some(0.1);
        original.stt_spin_polarization = Some([1.0, 0.0, 0.0]);
        original.stt_lambda = Some(1.0);
        original.stt_epsilon_prime = Some(0.01);
        original.stt_thickness = Some(1e-9);
        original.stt_fixed_layer_position = Some("top".into());
        original.temperature = Some(300.0);
        original.physics_graph = Some(serde_json::json!({"sentinel": "must not execute"}));
        let before = serde_json::to_value(&original).unwrap();
        let carrier = snapshot_problem(&original);
        assert_eq!(serde_json::to_value(&original).unwrap(), before);
        assert_eq!(carrier.geometry, original.geometry);
        assert_eq!(carrier.geometry_assets, original.geometry_assets);
        assert_eq!(carrier.mesh_semantics, original.mesh_semantics);
        assert_eq!(carrier.materials, original.materials);
        assert_eq!(
            carrier.material_parameter_fields,
            original.material_parameter_fields
        );
        assert_eq!(carrier.regions, original.regions);
        assert_eq!(carrier.object_regions, original.object_regions);
        assert_eq!(carrier.magnets, original.magnets);
        assert_eq!(carrier.backend_policy, original.backend_policy);
        assert_eq!(
            carrier.energy_terms,
            vec![EnergyTermIR::Zeeman { b: [0.0; 3] }]
        );
        assert!(carrier.current_density.is_none());
        assert!(carrier.stt_degree.is_none() && carrier.stt_beta.is_none());
        assert!(carrier.stt_spin_polarization.is_none() && carrier.stt_lambda.is_none());
        assert!(carrier.stt_epsilon_prime.is_none() && carrier.stt_thickness.is_none());
        assert!(carrier.stt_fixed_layer_position.is_none() && carrier.temperature.is_none());
        assert!(carrier.physics_graph.is_none());
    }

    #[test]
    fn carrier_sampling_is_snapshot_only_and_sanitization_is_idempotent() {
        let original = ProblemIR::bootstrap_example();
        let carrier = snapshot_problem(&original);
        assert_eq!(snapshot_problem(&carrier), carrier);
        let StudyIR::TimeEvolution { dynamics, sampling } = &carrier.study else {
            panic!("carrier must use the canonical snapshot planning family");
        };
        let DynamicsIR::Llg {
            adaptive_timestep,
            field_refresh,
            mechanics,
            ..
        } = dynamics;
        assert!(adaptive_timestep.is_none() && field_refresh.is_none() && mechanics.is_none());
        assert!(sampling.outputs.is_empty());
        assert!(sampling.table_autosave.is_none() && sampling.stage_autosave.is_none());
        assert!(carrier.current_modules.is_empty() && carrier.field_drives.is_empty());
        assert!(
            carrier.spin_torque_modules.is_empty() && carrier.spin_transport_modules.is_empty()
        );
        assert!(
            carrier.antenna_port_modes.is_empty() && carrier.antenna_field_solve_stages.is_empty()
        );
        assert!(
            carrier.antenna_target_projections.is_empty()
                && carrier.solved_antenna_drives.is_empty()
        );
        assert!(
            carrier.antenna_spectrum_requests.is_empty() && carrier.excitation_analysis.is_none()
        );
        assert!(carrier.elastic_bodies.is_empty() && carrier.mechanical_loads.is_empty());
        assert!(carrier.validate().is_ok());
    }

    #[test]
    fn carrier_strips_material_physics_without_losing_snapshot_scalars() {
        use fullmag_ir::{
            MaterialParameterAssignmentIR, MaterialParameterFieldIR, RegionConflictPolicyIR,
        };
        let mut original = ProblemIR::bootstrap_example();
        original.materials[0].uniaxial_anisotropy = Some(400.0);
        original.materials[0].cubic_anisotropy_kc1 = Some(200.0);
        original.materials[0].interfacial_dmi = Some(1e-3);
        original.materials[0].bulk_dmi = Some(2e-3);
        original.materials[0].ku_field = Some(vec![500.0]);
        original.materials[0].dind_field = Some(vec![1e-3]);
        original.materials[0].ms_field = Some(vec![800e3]);
        for (id, parameter, value) in [
            ("ms", MaterialParameterNameIR::Ms, 800e3),
            ("ku", MaterialParameterNameIR::Ku1, 400.0),
        ] {
            original
                .material_parameter_fields
                .push(MaterialParameterAssignmentIR {
                    assignment_id: id.into(),
                    owner_object: "strip".into(),
                    region_id: None,
                    parameter,
                    value: MaterialParameterFieldIR::Constant {
                        value: serde_json::json!(value),
                        unit: None,
                    },
                    priority: 0,
                    conflict_policy: RegionConflictPolicyIR::Error,
                });
        }
        let before = original.clone();
        let carrier = snapshot_problem(&original);
        assert_eq!(original, before);
        let material = &carrier.materials[0];
        assert_eq!(
            material.saturation_magnetisation,
            original.materials[0].saturation_magnetisation
        );
        assert_eq!(
            material.exchange_stiffness,
            original.materials[0].exchange_stiffness
        );
        assert_eq!(material.damping, original.materials[0].damping);
        assert_eq!(material.ms_field, original.materials[0].ms_field);
        assert!(material.uniaxial_anisotropy.is_none() && material.cubic_anisotropy_kc1.is_none());
        assert!(material.interfacial_dmi.is_none() && material.bulk_dmi.is_none());
        assert!(material.ku_field.is_none() && material.dind_field.is_none());
        assert_eq!(carrier.material_parameter_fields.len(), 1);
        assert_eq!(
            carrier.material_parameter_fields[0].parameter,
            MaterialParameterNameIR::Ms
        );
    }
}
