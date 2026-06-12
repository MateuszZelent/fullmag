use crate::eigen::solve_and_write_field_driven_response_sweep_bundle_with_interrupt;
use crate::types::{ExecutedRun, ExecutionProvenance, RunError, RunResult, RunStatus, StepStats};
use nalgebra::{DMatrix, DVector};
use num_complex::Complex64;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

pub(crate) fn execute_fem_frequency_response_validation(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
    output_dir: &Path,
    interrupt_requested: Option<&AtomicBool>,
) -> Result<ExecutedRun, RunError> {
    if plan.frequencies_hz.values_hz.is_empty() {
        return Err(RunError {
            message: "FEM frequency response requires at least one frequency point".to_string(),
        });
    }
    if plan
        .frequencies_hz
        .values_hz
        .iter()
        .any(|frequency| !frequency.is_finite() || *frequency <= 0.0)
    {
        return Err(RunError {
            message: "FEM frequency response frequencies must be finite and positive".to_string(),
        });
    }

    let dimension = plan.equilibrium_magnetization.len().max(1);
    let stiffness_scale = validation_stiffness_scale(plan);
    let damping_scale = plan
        .material
        .damping
        .is_finite()
        .then_some(plan.material.damping.abs().max(1.0e-6))
        .unwrap_or(1.0e-3);
    let template = crate::eigen::BlockRealHarmonicTemplate {
        stiffness: DMatrix::identity(dimension, dimension) * stiffness_scale,
        mass: DMatrix::identity(dimension, dimension),
        damping: Some(DMatrix::identity(dimension, dimension) * damping_scale),
    };
    let drive_norm = plan
        .excitation
        .field_au_per_m
        .iter()
        .map(|component| component * component)
        .sum::<f64>()
        .sqrt();
    if !drive_norm.is_finite() || drive_norm <= 0.0 {
        return Err(RunError {
            message: "FEM frequency response excitation field must be finite and non-zero"
                .to_string(),
        });
    }
    let field_excitation = DVector::from_element(dimension, Complex64::new(drive_norm, 0.0));
    let frequencies_rad_per_s = plan
        .frequencies_hz
        .values_hz
        .iter()
        .map(|frequency_hz| frequency_hz * 2.0 * std::f64::consts::PI)
        .collect::<Vec<_>>();

    let artifact = solve_and_write_field_driven_response_sweep_bundle_with_interrupt(
        output_dir,
        &template,
        &frequencies_rad_per_s,
        &field_excitation,
        |_completed_points| interrupt_requested.is_some_and(|flag| flag.load(Ordering::Relaxed)),
        "runner.dense_block_real_validation",
        "dense_block_real_lu",
        "gilbert_linear_validation",
        "fem_frequency_response_validation",
    )
    .map_err(|message| RunError { message })?;
    let interrupted = artifact.points.len() < plan.frequencies_hz.values_hz.len();

    Ok(ExecutedRun {
        result: RunResult {
            status: if interrupted {
                RunStatus::Cancelled
            } else {
                RunStatus::Completed
            },
            steps: vec![StepStats {
                step: artifact.points.len() as u64,
                time: 0.0,
                dt: 0.0,
                max_h_eff: drive_norm,
                ..StepStats::default()
            }],
            final_magnetization: plan.equilibrium_magnetization.clone(),
            completion: Some(crate::relaxation::infer_stage_completion(
                if interrupted {
                    RunStatus::Cancelled
                } else {
                    RunStatus::Completed
                },
                None,
                &[],
                0.0,
                0.0,
                false,
            )),
        },
        initial_magnetization: plan.equilibrium_magnetization.clone(),
        field_snapshots: Vec::new(),
        field_snapshot_count: 0,
        auxiliary_artifacts: Vec::new(),
        provenance: ExecutionProvenance {
            execution_engine: "runner.dense_block_real_validation".to_string(),
            precision: "double".to_string(),
            demag_operator_kind: plan
                .enable_demag
                .then(|| "frequency_domain_validation_demag_contract".to_string()),
            ..ExecutionProvenance::default()
        },
    })
}

fn validation_stiffness_scale(plan: &fullmag_ir::FemFrequencyResponsePlanIR) -> f64 {
    let mut scale = 1.0;
    if plan.enable_exchange {
        scale += 1.0;
    }
    if plan.enable_demag {
        scale += 0.5;
    }
    if plan.external_field.is_some() {
        scale += 0.25;
    }
    if plan.interfacial_dmi.is_some() || plan.bulk_dmi.is_some() {
        scale += 0.25;
    }
    scale
}
