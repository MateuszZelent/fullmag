use fullmag_ir::{
    AntennaFieldSourceModelIR, CurrentModuleIR, CurrentTransportModelIR, ProblemIR, TimeEnvelopeIR,
};

use crate::error::PlanError;
use crate::physics_graph::physics_module_execution_enabled;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ResolvedCurrentTransport {
    pub name: String,
    pub current_density: [f64; 3],
    pub solve_region: Option<String>,
    pub time_envelope: Option<TimeEnvelopeIR>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CurrentTransportExecutableLane {
    Fdm,
    Fem,
}

pub(crate) fn has_mqs_antenna_field_source(problem: &ProblemIR) -> bool {
    problem.current_modules.iter().any(|module| {
        matches!(
            module,
            CurrentModuleIR::AntennaFieldSource {
                model: AntennaFieldSourceModelIR::Mqs2p5dAz,
                ..
            }
        )
    })
}

pub(crate) fn resolve_current_transports(
    problem: &ProblemIR,
    lane: CurrentTransportExecutableLane,
) -> Result<Vec<ResolvedCurrentTransport>, PlanError> {
    let mut resolved = Vec::new();
    let mut reasons = Vec::new();

    for (index, module) in problem.current_modules.iter().enumerate() {
        if let CurrentModuleIR::CurrentTransport { name, .. } = module {
            match physics_module_execution_enabled(problem, "current_transport", name) {
                Ok(Some(false)) => continue,
                Ok(Some(true) | None) => {}
                Err(graph_reasons) => {
                    reasons.extend(graph_reasons);
                    continue;
                }
            }
        }
        match module {
            CurrentModuleIR::AntennaFieldSource { model, .. } => {
                if lane == CurrentTransportExecutableLane::Fdm
                    && *model == AntennaFieldSourceModelIR::Mqs2p5dAz
                {
                    reasons.push(format!(
                        "current_modules[{index}] antenna_field_source is not executable on the current FDM time-domain path"
                    ));
                }
            }
            CurrentModuleIR::CurrentTransport {
                name,
                model: CurrentTransportModelIR::PrescribedDensity,
                current_density,
                solve_region,
                time_envelope,
                ..
            } => match current_density {
                Some(current_density) => resolved.push(ResolvedCurrentTransport {
                    name: name.clone(),
                    current_density: *current_density,
                    solve_region: solve_region.clone(),
                    time_envelope: time_envelope.clone(),
                }),
                None => reasons.push(format!(
                    "current_modules[{index}] current_transport prescribed_density requires current_density"
                )),
            },
            CurrentModuleIR::CurrentTransport {
                name,
                model:
                    CurrentTransportModelIR::OhmicPoisson
                    | CurrentTransportModelIR::MagnetoresistivePoisson,
                ..
            } => {
                if lane == CurrentTransportExecutableLane::Fem
                    && !problem
                        .spin_transport_modules
                        .iter()
                        .any(|module| module.current_source_id == *name)
                {
                    reasons.push(format!(
                        "current_modules[{index}] current_transport(ohmic_poisson) requires a bound FEM spin_transport module on the M1 lane"
                    ));
                }
                // M1 materializes the complete charge solve together with its
                // owning spin-transport plan. It deliberately does not
                // masquerade as a prescribed uniform-current source.
            }
        }
    }

    if reasons.is_empty() {
        Ok(resolved)
    } else {
        Err(PlanError { reasons })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{CurrentModuleIR, CurrentTransportModelIR};

    #[test]
    fn resolves_prescribed_density_for_fdm() {
        let mut problem = ProblemIR::bootstrap_example();
        problem
            .current_modules
            .push(CurrentModuleIR::CurrentTransport {
                name: "drive".to_string(),
                model: CurrentTransportModelIR::PrescribedDensity,
                current_density: Some([0.0, 0.0, 5e10]),
                solve_region: None,
                conductivity_s_per_m: None,
                coupling: fullmag_ir::TransportCouplingIR::OneWay,
                time_envelope: None,
                definition: None,
            });

        let resolved =
            resolve_current_transports(&problem, CurrentTransportExecutableLane::Fdm).unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].name, "drive");
        assert_eq!(resolved[0].current_density, [0.0, 0.0, 5e10]);
        assert_eq!(resolved[0].solve_region, None);
    }

    #[test]
    fn inactive_graph_module_filters_nonzero_current_payload() {
        let mut problem = ProblemIR::bootstrap_example();
        problem
            .current_modules
            .push(CurrentModuleIR::CurrentTransport {
                name: "drive".to_string(),
                model: CurrentTransportModelIR::PrescribedDensity,
                current_density: Some([0.0, 0.0, 5e10]),
                solve_region: None,
                conductivity_s_per_m: None,
                coupling: fullmag_ir::TransportCouplingIR::OneWay,
                time_envelope: None,
                definition: None,
            });
        problem.physics_graph = Some(serde_json::json!({
            "schema_version": "physics_graph.v1",
            "scene_revision": 1,
            "modules": [{
                "id": "drive",
                "kind": "current_transport",
                "applies_to": [{"kind": "global"}],
                "solve_domain": [],
                "depends_on": [],
                "activation": "inactive"
            }],
            "edges": []
        }));

        let resolved = resolve_current_transports(&problem, CurrentTransportExecutableLane::Fdm)
            .expect("inactive graph payload is omitted");
        assert!(resolved.is_empty());
    }

    #[test]
    fn allows_prescribed_density_on_fem_lane() {
        let mut problem = ProblemIR::bootstrap_example();
        problem
            .current_modules
            .push(CurrentModuleIR::CurrentTransport {
                name: "drive".to_string(),
                model: CurrentTransportModelIR::PrescribedDensity,
                current_density: Some([0.0, 0.0, 5e10]),
                solve_region: None,
                conductivity_s_per_m: None,
                coupling: fullmag_ir::TransportCouplingIR::OneWay,
                time_envelope: None,
                definition: None,
            });

        let resolved =
            resolve_current_transports(&problem, CurrentTransportExecutableLane::Fem).unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].name, "drive");
    }
}
