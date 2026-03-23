//! Execution planning: lowers `ProblemIR` into backend-specific `ExecutionPlanIR`.
//!
//! Phase 1 scope: only `Box + Exchange + fdm/strict` is a legal executable path.
//! Everything else is rejected with an honest error.

use fullmag_ir::{
    BackendPlanIR, BackendTarget, CommonPlanMeta, DiscretizationHintsIR,
    ExchangeBoundaryCondition, ExecutionMode, ExecutionPlanIR, FdmPlanIR, GeometryEntryIR,
    GridDimensions, InitialMagnetizationIR, IntegratorChoice, OutputPlanIR, ProblemIR,
    ProvenancePlanIR, IR_VERSION,
};
use std::fmt;

#[derive(Debug)]
pub struct PlanError {
    pub reasons: Vec<String>,
}

impl fmt::Display for PlanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for reason in &self.reasons {
            writeln!(f, "  - {}", reason)?;
        }
        Ok(())
    }
}

impl std::error::Error for PlanError {}

/// Plans a `ProblemIR` into an `ExecutionPlanIR`.
///
/// Phase 1 only supports: Box geometry + Exchange + fdm/strict + Heun.
/// Returns a detailed error for anything outside this subset.
pub fn plan(problem: &ProblemIR) -> Result<ExecutionPlanIR, PlanError> {
    // 1. Validate IR first
    if let Err(validation_errors) = problem.validate() {
        return Err(PlanError {
            reasons: validation_errors,
        });
    }

    let mut errors = Vec::new();

    // 2. Check backend target
    let resolved_backend = match problem.backend_policy.requested_backend {
        BackendTarget::Fdm => BackendTarget::Fdm,
        BackendTarget::Auto => BackendTarget::Fdm, // default to FDM in Phase 1
        other => {
            errors.push(format!(
                "backend '{}' is not executable in Phase 1; only 'fdm' is supported",
                other.as_str()
            ));
            BackendTarget::Fdm
        }
    };

    // 3. Check execution mode
    if problem.validation_profile.execution_mode != ExecutionMode::Strict {
        errors.push("only execution_mode='strict' is executable in Phase 1".to_string());
    }

    // 4. Check energy terms — only Exchange is executable
    if problem.energy_terms.len() != 1 {
        errors.push(format!(
            "Phase 1 supports exactly one energy term (Exchange), found {}",
            problem.energy_terms.len()
        ));
    }
    for term in &problem.energy_terms {
        if !matches!(term, fullmag_ir::EnergyTermIR::Exchange) {
            errors.push(format!(
                "energy term '{:?}' is semantic-only in Phase 1; only Exchange is executable",
                term
            ));
        }
    }

    // 5. Check geometry — only Box is executable
    if problem.geometry.entries.len() != 1 {
        errors.push(format!(
            "Phase 1 supports exactly one geometry entry, found {}",
            problem.geometry.entries.len()
        ));
    }
    let geometry = &problem.geometry.entries[0];
    let box_size = match geometry {
        GeometryEntryIR::Box { size, .. } => *size,
        other => {
            errors.push(format!(
                "geometry '{}' is not executable in Phase 1; only Box is supported",
                other.name()
            ));
            [1.0, 1.0, 1.0] // placeholder
        }
    };

    // 6. Check FDM hints exist
    let cell_size = match &problem.backend_policy.discretization_hints {
        Some(DiscretizationHintsIR {
            fdm: Some(fdm), ..
        }) => fdm.cell,
        _ => {
            errors.push(
                "FDM discretization hints (cell size) are required for Phase 1 execution"
                    .to_string(),
            );
            [1e-9, 1e-9, 1e-9] // placeholder
        }
    };

    // 7. Check only one magnet
    if problem.magnets.len() != 1 {
        errors.push(format!(
            "Phase 1 supports exactly one magnet, found {}",
            problem.magnets.len()
        ));
    }

    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    // ---- lowering: Box → grid ----
    let grid_cells = [
        (box_size[0] / cell_size[0]).round().max(1.0) as u32,
        (box_size[1] / cell_size[1]).round().max(1.0) as u32,
        (box_size[2] / cell_size[2]).round().max(1.0) as u32,
    ];

    let magnet = &problem.magnets[0];
    let material = problem
        .materials
        .iter()
        .find(|m| m.name == magnet.material)
        .expect("validation should have caught missing material");

    let initial_magnetization = match &magnet.initial_magnetization {
        Some(InitialMagnetizationIR::Uniform { value }) => {
            let n = (grid_cells[0] * grid_cells[1] * grid_cells[2]) as usize;
            vec![*value; n]
        }
        Some(InitialMagnetizationIR::RandomSeeded { seed }) => {
            generate_random_unit_vectors(
                *seed,
                (grid_cells[0] * grid_cells[1] * grid_cells[2]) as usize,
            )
        }
        Some(InitialMagnetizationIR::SampledField { values }) => values.clone(),
        None => {
            let n = (grid_cells[0] * grid_cells[1] * grid_cells[2]) as usize;
            vec![[1.0, 0.0, 0.0]; n]
        }
    };

    // Check integrator
    let integrator = match &problem.dynamics {
        fullmag_ir::DynamicsIR::Llg { integrator, .. } => {
            if integrator == "heun" {
                IntegratorChoice::Heun
            } else {
                return Err(PlanError {
                    reasons: vec![format!(
                        "integrator '{}' is not supported in Phase 1; only 'heun' is available",
                        integrator
                    )],
                });
            }
        }
    };

    let fixed_timestep = match &problem.dynamics {
        fullmag_ir::DynamicsIR::Llg { fixed_timestep, .. } => *fixed_timestep,
    };

    let fdm_plan = FdmPlanIR {
        grid: GridDimensions { cells: grid_cells },
        cell_size,
        region_mask: vec![0; (grid_cells[0] * grid_cells[1] * grid_cells[2]) as usize],
        initial_magnetization,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        integrator,
        fixed_timestep,
    };

    Ok(ExecutionPlanIR {
        common: CommonPlanMeta {
            ir_version: IR_VERSION.to_string(),
            requested_backend: problem.backend_policy.requested_backend,
            resolved_backend,
            execution_mode: problem.validation_profile.execution_mode,
        },
        backend_plan: BackendPlanIR::Fdm(fdm_plan),
        output_plan: OutputPlanIR {
            outputs: problem.sampling.outputs.clone(),
        },
        provenance: ProvenancePlanIR {
            notes: vec![
                "Phase 1 reference FDM planner".to_string(),
                format!("Box geometry lowered to {}x{}x{} grid", grid_cells[0], grid_cells[1], grid_cells[2]),
            ],
        },
    })
}

/// Generate deterministic random unit vectors from a seed.
pub fn generate_random_unit_vectors(seed: u64, count: usize) -> Vec<[f64; 3]> {
    // Simple xorshift64-based PRNG for deterministic random unit vectors.
    let mut state = seed;
    let mut vectors = Vec::with_capacity(count);

    for _ in 0..count {
        // Generate 3 random f64 in [-1, 1]
        let mut components = [0.0f64; 3];
        loop {
            for c in &mut components {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                *c = (state as f64 / u64::MAX as f64) * 2.0 - 1.0;
            }
            let norm = (components[0] * components[0]
                + components[1] * components[1]
                + components[2] * components[2])
                .sqrt();
            if norm > 1e-10 {
                components[0] /= norm;
                components[1] /= norm;
                components[2] /= norm;
                break;
            }
        }
        vectors.push(components);
    }
    vectors
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_example_plans_successfully() {
        let ir = ProblemIR::bootstrap_example();
        let plan = plan(&ir).expect("bootstrap example should plan successfully");

        match &plan.backend_plan {
            BackendPlanIR::Fdm(fdm) => {
                // Box(200e-9, 20e-9, 5e-9) with cell(2e-9, 2e-9, 5e-9)
                assert_eq!(fdm.grid.cells, [100, 10, 1]);
                assert_eq!(fdm.cell_size, [2e-9, 2e-9, 5e-9]);
                assert_eq!(
                    fdm.initial_magnetization.len(),
                    (100 * 10 * 1) as usize
                );
            }
            _ => panic!("expected FDM plan"),
        }
    }

    #[test]
    fn non_exchange_term_is_rejected() {
        let mut ir = ProblemIR::bootstrap_example();
        ir.energy_terms = vec![fullmag_ir::EnergyTermIR::Demag];

        let err = plan(&ir).expect_err("demag should be rejected");
        assert!(err.reasons.iter().any(|r| r.contains("semantic-only")));
    }

    #[test]
    fn imported_geometry_is_rejected() {
        let mut ir = ProblemIR::bootstrap_example();
        ir.geometry.entries = vec![GeometryEntryIR::ImportedGeometry {
            name: "mesh".to_string(),
            source: "sample.step".to_string(),
            format: "step".to_string(),
        }];
        ir.regions[0].geometry = "mesh".to_string();

        let err = plan(&ir).expect_err("imported geometry should be rejected");
        assert!(err.reasons.iter().any(|r| r.contains("not executable")));
    }

    #[test]
    fn random_seeded_generates_correct_count() {
        let vectors = generate_random_unit_vectors(42, 100);
        assert_eq!(vectors.len(), 100);
        for v in &vectors {
            let norm = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
            assert!((norm - 1.0).abs() < 1e-10, "vector not unit: norm={}", norm);
        }
    }
}
