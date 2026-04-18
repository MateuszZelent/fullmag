use fullmag_ir::{CurrentModuleIR, CurrentTransportModelIR, ProblemIR};

use crate::error::PlanError;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ResolvedCurrentTransport {
    pub name: String,
    pub current_density: [f64; 3],
    pub solve_region: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CurrentTransportExecutableLane {
    Fdm,
    Fem,
}

pub(crate) fn has_antenna_field_source(problem: &ProblemIR) -> bool {
    problem
        .current_modules
        .iter()
        .any(|module| matches!(module, CurrentModuleIR::AntennaFieldSource { .. }))
}

pub(crate) fn resolve_current_transports(
    problem: &ProblemIR,
    lane: CurrentTransportExecutableLane,
) -> Result<Vec<ResolvedCurrentTransport>, PlanError> {
    let mut resolved = Vec::new();
    let mut reasons = Vec::new();

    for (index, module) in problem.current_modules.iter().enumerate() {
        match module {
            CurrentModuleIR::AntennaFieldSource { .. } => {
                if lane == CurrentTransportExecutableLane::Fdm {
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
                ..
            } => match current_density {
                Some(current_density) => resolved.push(ResolvedCurrentTransport {
                    name: name.clone(),
                    current_density: *current_density,
                    solve_region: solve_region.clone(),
                }),
                None => reasons.push(format!(
                    "current_modules[{index}] current_transport prescribed_density requires current_density"
                )),
            },
            CurrentModuleIR::CurrentTransport {
                model: CurrentTransportModelIR::OhmicPoisson,
                ..
            } => reasons.push(format!(
                "current_modules[{index}] current_transport(ohmic_poisson) is semantic_only on the current public {} path",
                match lane {
                    CurrentTransportExecutableLane::Fdm => "FDM",
                    CurrentTransportExecutableLane::Fem => "FEM",
                }
            )),
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
            });

        let resolved =
            resolve_current_transports(&problem, CurrentTransportExecutableLane::Fdm).unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].name, "drive");
        assert_eq!(resolved[0].current_density, [0.0, 0.0, 5e10]);
        assert_eq!(resolved[0].solve_region, None);
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
            });

        let resolved =
            resolve_current_transports(&problem, CurrentTransportExecutableLane::Fem).unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].name, "drive");
    }
}
