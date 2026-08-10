//! Exact physics-graph execution observations.
//!
//! This module joins completed runtime evidence with stable identities already
//! present in `ProblemIR` and the resolved backend plan.  It never maps a
//! kind-only observation to a graph module.

use std::collections::BTreeSet;

use fullmag_ir::{BackendPlanIR, EnergyTermIR, SpinTorqueModuleIR};

use crate::types::{ExecutedRun, ExecutionProvenance, RunError};

#[derive(Debug, Clone, Default)]
pub(crate) struct PhysicsGraphExecutionContext {
    energy_module_ids: Vec<String>,
    workflow_module_ids: Vec<String>,
    #[cfg(feature = "fem-gpu")]
    steady_transport_module_ids: Vec<String>,
}

impl PhysicsGraphExecutionContext {
    pub(crate) fn from_problem_and_plan(
        problem: &fullmag_ir::ProblemIR,
        plan: &fullmag_ir::ExecutionPlanIR,
    ) -> Result<Self, RunError> {
        Self::from_problem_and_backend_plan(problem, &plan.backend_plan)
    }

    pub(crate) fn from_problem_and_backend_plan(
        problem: &fullmag_ir::ProblemIR,
        backend_plan: &BackendPlanIR,
    ) -> Result<Self, RunError> {
        if problem.physics_graph.is_none() {
            return Ok(Self::default());
        }
        let mut energy = BTreeSet::new();
        let mut workflow = BTreeSet::new();
        #[cfg(feature = "fem-gpu")]
        let mut steady_transport = BTreeSet::new();
        match backend_plan {
            BackendPlanIR::Fdm(fdm) => {
                if fdm.zhang_li_formula_version.is_some()
                    || fdm.slonczewski_formula_version.is_some()
                    || fdm.sot_formula_version.is_some()
                {
                    append_authored_spin_torque_ids(problem, &mut workflow)?;
                }
                append_field_drive_ids(problem, &fdm.field_drives, &mut energy)?;
                for basis in &fdm.regional_field_drive_bases {
                    if graph_module_enabled(problem, &basis.drive.id, Some("regional_field_drive"))?
                    {
                        energy.insert(basis.drive.id.clone());
                    }
                }
                append_transport_plan_ids(problem, &fdm.spin_transport_plans, &mut workflow)?;
                if fdm.has_oersted_cylinder || fdm.oersted_field_xyz.is_some() {
                    append_oersted_ids(problem, None, &mut energy)?;
                }
            }
            BackendPlanIR::Fem(fem) => {
                if fem.spin_torque_contract.is_some() {
                    append_authored_spin_torque_ids(problem, &mut workflow)?;
                }
                append_field_drive_ids(problem, &fem.field_drives, &mut energy)?;
                #[cfg(feature = "fem-gpu")]
                append_transport_plan_ids(
                    problem,
                    &fem.spin_transport_plans,
                    &mut steady_transport,
                )?;
                if fem.has_oersted_cylinder || fem.oersted_field_xyz.is_some() {
                    append_oersted_ids(problem, None, &mut energy)?;
                }
            }
            BackendPlanIR::FdmMultilayer(_)
            | BackendPlanIR::FemEigen(_)
            | BackendPlanIR::FemFrequencyResponse(_) => {}
        }
        workflow.extend(energy.iter().cloned());
        Ok(Self {
            energy_module_ids: energy.into_iter().collect(),
            workflow_module_ids: workflow.into_iter().collect(),
            #[cfg(feature = "fem-gpu")]
            steady_transport_module_ids: steady_transport.into_iter().collect(),
        })
    }

    pub(crate) fn observe_workflow(&self, provenance: &mut ExecutionProvenance) {
        merge_observed_module_ids(provenance, &self.workflow_module_ids);
    }

    pub(crate) fn observe_energy_evaluation(&self, provenance: &mut ExecutionProvenance) {
        merge_observed_module_ids(provenance, &self.energy_module_ids);
    }

    #[cfg(feature = "fem-gpu")]
    pub(crate) fn observe_steady_transport(&self, provenance: &mut ExecutionProvenance) {
        merge_observed_module_ids(provenance, &self.steady_transport_module_ids);
    }

    #[cfg(test)]
    pub(crate) fn from_exact_ids_for_test(
        module_ids: impl IntoIterator<Item = &'static str>,
    ) -> Self {
        let module_ids = module_ids
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>();
        Self {
            energy_module_ids: module_ids.clone(),
            workflow_module_ids: module_ids,
            #[cfg(feature = "fem-gpu")]
            steady_transport_module_ids: Vec::new(),
        }
    }
}

fn merge_observed_module_ids(provenance: &mut ExecutionProvenance, module_ids: &[String]) {
    let mut observed = provenance
        .executed_physics_module_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    observed.extend(module_ids.iter().cloned());
    provenance.executed_physics_module_ids = observed.into_iter().collect();
}

pub(crate) fn attach_executed_module_ids(
    problem: &fullmag_ir::ProblemIR,
    executed: &mut ExecutedRun,
) -> Result<(), RunError> {
    validate_executed_module_ids(problem, &mut executed.provenance)
}

pub(crate) fn validate_executed_module_ids(
    problem: &fullmag_ir::ProblemIR,
    provenance: &mut ExecutionProvenance,
) -> Result<(), RunError> {
    if problem.physics_graph.is_none() {
        provenance.executed_physics_module_ids.clear();
        return Ok(());
    }

    let observed = provenance
        .executed_physics_module_ids
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    for module_id in &observed {
        if !graph_module_enabled(problem, module_id, None)? {
            return Err(RunError {
                message: format!(
                    "physics_graph execution observation references non-executable module ID '{module_id}'"
                ),
            });
        }
    }
    provenance.executed_physics_module_ids = observed.into_iter().collect();
    Ok(())
}

fn append_authored_spin_torque_ids(
    problem: &fullmag_ir::ProblemIR,
    observed: &mut BTreeSet<String>,
) -> Result<(), RunError> {
    for module in &problem.spin_torque_modules {
        let module_id = match module {
            SpinTorqueModuleIR::Slonczewski { id, .. } | SpinTorqueModuleIR::ZhangLi { id, .. } => {
                id.as_deref()
            }
            SpinTorqueModuleIR::DriftDiffusionSpinTorque { id, .. }
            | SpinTorqueModuleIR::PrescribedSot { id, .. } => Some(id.as_str()),
            SpinTorqueModuleIR::InterfaceCpp { .. }
            | SpinTorqueModuleIR::DriftDiffusion { .. }
            | SpinTorqueModuleIR::SpinOrbitTorque { .. } => None,
        };
        let Some(module_id) = module_id else {
            continue;
        };
        if graph_module_enabled(problem, module_id, Some("spin_torque"))? {
            observed.insert(module_id.to_string());
        }
    }
    Ok(())
}

fn append_field_drive_ids(
    problem: &fullmag_ir::ProblemIR,
    drives: &[fullmag_ir::RegionalFieldDriveIR],
    observed: &mut BTreeSet<String>,
) -> Result<(), RunError> {
    for drive in drives {
        if graph_module_enabled(problem, &drive.id, Some("regional_field_drive"))? {
            observed.insert(drive.id.clone());
        }
    }
    Ok(())
}

fn append_transport_plan_ids(
    problem: &fullmag_ir::ProblemIR,
    plans: &[fullmag_ir::ResolvedSpinTransportPlanIR],
    observed: &mut BTreeSet<String>,
) -> Result<(), RunError> {
    for transport in plans {
        for (module_id, kind) in [
            (transport.module_id.as_str(), "spin_transport"),
            (transport.current_source_id.as_str(), "current_transport"),
        ] {
            if graph_module_enabled(problem, module_id, Some(kind))? {
                observed.insert(module_id.to_string());
            }
        }
        let interfaces = transport
            .fdm_cpu_double
            .as_ref()
            .map(|descriptor| descriptor.interfaces.as_slice())
            .or_else(|| {
                transport
                    .fdm_cpu_double_reciprocal
                    .as_ref()
                    .map(|descriptor| descriptor.interfaces.as_slice())
            })
            .or_else(|| {
                transport
                    .fdm_cpu_double_transient
                    .as_ref()
                    .map(|descriptor| descriptor.steady_operator.interfaces.as_slice())
            })
            .unwrap_or_default();
        for interface in interfaces {
            if graph_module_enabled(problem, &interface.source_id, Some("spin_interface"))? {
                observed.insert(interface.source_id.clone());
            }
        }
        for torque in &problem.spin_torque_modules {
            if let fullmag_ir::SpinTorqueModuleIR::DriftDiffusionSpinTorque {
                id, solve_id, ..
            } = torque
            {
                if solve_id == &transport.module_id
                    && graph_module_enabled(problem, id, Some("spin_torque"))?
                {
                    observed.insert(id.clone());
                }
            }
        }
        let fdm_oersted_source_bound = transport
            .fdm_cpu_double
            .as_ref()
            .is_some_and(|descriptor| descriptor.oersted_source_bound)
            || transport
                .fdm_cpu_double_reciprocal
                .as_ref()
                .is_some_and(|descriptor| descriptor.oersted_source_bound)
            || transport
                .fdm_cpu_double_transient
                .as_ref()
                .is_some_and(|descriptor| descriptor.steady_operator.oersted_source_bound);
        if fdm_oersted_source_bound {
            append_oersted_ids(problem, Some(&transport.current_source_id), observed)?;
        }
        if let Some(descriptor) = transport.fem_cpu_double.as_ref() {
            for interface in &descriptor.interfaces {
                if graph_module_enabled(problem, &interface.id, Some("spin_interface"))? {
                    observed.insert(interface.id.clone());
                }
            }
            if let Some(target) = descriptor.torque_target.as_ref() {
                if graph_module_enabled(problem, &target.torque_module_id, Some("spin_torque"))? {
                    observed.insert(target.torque_module_id.clone());
                }
            }
            if descriptor.oersted_source_bound {
                append_oersted_ids(problem, Some(&transport.current_source_id), observed)?;
            }
        }
    }
    Ok(())
}

fn append_oersted_ids(
    problem: &fullmag_ir::ProblemIR,
    current_source_id: Option<&str>,
    observed: &mut BTreeSet<String>,
) -> Result<(), RunError> {
    for term in &problem.energy_terms {
        let (module_id, source_matches) = match term {
            EnergyTermIR::OerstedCylinder { id, .. } => {
                (id.as_deref(), current_source_id.is_none())
            }
            EnergyTermIR::OerstedField { id, source, .. } => (
                id.as_deref(),
                current_source_id.is_none_or(|expected| source == expected),
            ),
            _ => continue,
        };
        let Some(module_id) = module_id.filter(|_| source_matches) else {
            continue;
        };
        if graph_module_enabled(problem, module_id, Some("oersted_field"))? {
            observed.insert(module_id.to_string());
        }
    }
    Ok(())
}

fn graph_module_enabled(
    problem: &fullmag_ir::ProblemIR,
    module_id: &str,
    expected_kind: Option<&str>,
) -> Result<bool, RunError> {
    let graph = problem
        .physics_graph
        .as_ref()
        .expect("physics graph presence checked by caller");
    let modules = graph
        .get("modules")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| RunError {
            message: "physics_graph execution observation requires a modules array".to_string(),
        })?;
    let module = modules
        .iter()
        .find(|module| module.get("id").and_then(serde_json::Value::as_str) == Some(module_id))
        .ok_or_else(|| RunError {
            message: format!(
                "physics_graph execution observation references unknown module ID '{module_id}'"
            ),
        })?;
    if let Some(expected_kind) = expected_kind {
        let actual_kind = module
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("<missing>");
        if actual_kind != expected_kind {
            return Err(RunError {
                message: format!(
                    "physics_graph execution observation module '{module_id}' has kind '{actual_kind}', expected '{expected_kind}'"
                ),
            });
        }
    }
    Ok(matches!(
        module.get("activation").and_then(serde_json::Value::as_str),
        Some("active" | "configured")
    ))
}
