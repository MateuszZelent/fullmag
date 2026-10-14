//! Multi-k orchestrator for the current reference FEM eigen kernel.
//!
//! The intent is simple:
//! 1. expand `KSamplingIR` into concrete samples,
//! 2. call the existing single-k solver for each sample,
//! 3. run overlap-based branch tracking,
//! 4. write path / branch / mode artifacts.
//!
//! This file does *not* replace the physics kernel. It wraps it. The current
//! scalar-projected operator can keep living where it is until the full
//! tangent-plane LLG assembly is ready.

use crate::eigen::artifacts::{
    write_branch_bundle_with_sample_namespace,
    write_frequency_domain_eigen_manifest_with_outputs,
    write_mode_bundle, write_path_bundle_with_sample_namespace, FrequencyDomainArtifactIdentity,
};
use crate::eigen::path::expand_k_sampling;
use crate::eigen::output_selection::eigen_diagnostics_request;
use crate::eigen::tracking::track_branches;
use crate::eigen::types::{
    DispersionAnalyticReferenceContext, KSampleDescriptor, PathSolveOutcome, PathSolveResult,
    SingleKSolveOutcome, SingleKSolveResult,
};
use crate::types::{RunError, StepAction};
use fullmag_ir::{FemEigenPlanIR, ModeTrackingIR, OutputIR};
use std::path::Path;

pub trait SingleKSolver {
    fn solve_single_k(
        &self,
        plan: &FemEigenPlanIR,
        outputs: &[OutputIR],
        sample: &KSampleDescriptor,
    ) -> Result<SingleKSolveResult, RunError>;
}

pub(crate) trait ControlledSingleKSolver {
    fn solve_single_k_controlled(
        &self,
        plan: &FemEigenPlanIR,
        outputs: &[OutputIR],
        sample: &KSampleDescriptor,
    ) -> Result<SingleKSolveOutcome, RunError>;
}

impl<S: SingleKSolver> ControlledSingleKSolver for S {
    fn solve_single_k_controlled(
        &self,
        plan: &FemEigenPlanIR,
        outputs: &[OutputIR],
        sample: &KSampleDescriptor,
    ) -> Result<SingleKSolveOutcome, RunError> {
        self.solve_single_k(plan, outputs, sample)
            .map(SingleKSolveOutcome::Completed)
    }
}

pub fn run_path_or_single<S: SingleKSolver>(
    solver: &S,
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    output_dir: Option<&Path>,
    artifact_identity: Option<&FrequencyDomainArtifactIdentity>,
    mode_tracking: Option<&ModeTrackingIR>,
) -> Result<PathSolveResult, RunError> {
    match run_path_or_single_controlled(
        solver,
        plan,
        outputs,
        output_dir,
        artifact_identity,
        mode_tracking,
    )? {
        PathSolveOutcome::Completed(result) => Ok(result),
        PathSolveOutcome::Interrupted { .. } => Err(RunError {
            message: "single-k k-path solve was interrupted by runtime control".into(),
        }),
    }
}

pub(crate) fn run_path_or_single_controlled<S: ControlledSingleKSolver>(
    solver: &S,
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    output_dir: Option<&Path>,
    artifact_identity: Option<&FrequencyDomainArtifactIdentity>,
    mode_tracking: Option<&ModeTrackingIR>,
) -> Result<PathSolveOutcome, RunError> {
    let sample_descriptors =
        expand_k_sampling(plan.k_sampling.as_ref()).map_err(|message| RunError { message })?;
    if sample_descriptors.is_empty() {
        return Err(RunError {
            message: "expanded k-sampling produced zero samples".to_string(),
        });
    }

    let outcome = solve_path_samples(
        solver,
        plan,
        outputs,
        &sample_descriptors,
        sample_descriptors.len(),
        mode_tracking,
    )?;

    let validated_artifact_identity = if output_dir.is_some() {
        let artifact_identity = artifact_identity.ok_or_else(|| RunError {
            message: "frequency-domain artifact output requires exact session, run, stage, and runtime identity".to_string(),
        })?;
        artifact_identity.validate().map_err(|error| RunError {
            message: format!("invalid frequency-domain artifact identity: {error}"),
        })?;
        Some(artifact_identity)
    } else {
        None
    };

    if let (
        Some(output_dir),
        Some(artifact_identity),
        PathSolveOutcome::Completed(result),
    ) = (output_dir, validated_artifact_identity, &outcome)
    {
        let has_public_spectral_output = outputs.iter().any(|output| {
            matches!(
                output,
                OutputIR::EigenSpectrum { .. }
                    | OutputIR::EigenMode { .. }
                    | OutputIR::DispersionCurve { .. }
            )
        });
        let diagnostics_only =
            eigen_diagnostics_request(outputs).is_some() && !has_public_spectral_output;
        if !diagnostics_only {
            write_path_bundle_with_sample_namespace(
                output_dir,
                &result,
                !plan.bias_field_samples.is_empty(),
            )
            .map_err(|error| RunError {
                message: format!("failed to write path bundle: {error}"),
            })?;
            write_branch_bundle_with_sample_namespace(
                output_dir,
                &result,
                !plan.bias_field_samples.is_empty(),
            )
            .map_err(|error| RunError {
                message: format!("failed to write branch bundle: {error}"),
            })?;
            write_mode_bundle(output_dir, &result).map_err(|error| RunError {
                message: format!("failed to write mode bundle: {error}"),
            })?;
        }
        write_frequency_domain_eigen_manifest_with_outputs(
            output_dir,
            &result,
            artifact_identity,
            outputs,
            Some(plan.count as usize),
            Some(plan),
        )
        .map_err(|error| RunError {
            message: format!("failed to write frequency-domain eigen manifest: {error}"),
        })?;
    }

    Ok(outcome)
}

/// Aggregate only a contiguous planned k-sampling prefix, as used after a
/// controlled adaptive-pool interruption. The full plan remains authoritative
/// for selectors and provenance; no sample or mode is synthesized here.
pub(crate) fn run_path_prefix_or_single<S: SingleKSolver>(
    solver: &S,
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    accepted_prefix_len: usize,
    mode_tracking: Option<&ModeTrackingIR>,
) -> Result<PathSolveResult, RunError> {
    match run_path_prefix_or_single_controlled(
        solver,
        plan,
        outputs,
        accepted_prefix_len,
        mode_tracking,
    )? {
        PathSolveOutcome::Completed(result) => Ok(result),
        PathSolveOutcome::Interrupted { .. } => Err(RunError {
            message: "accepted k-path prefix was interrupted during reconstruction".into(),
        }),
    }
}

pub(crate) fn run_path_prefix_or_single_controlled<S: ControlledSingleKSolver>(
    solver: &S,
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    accepted_prefix_len: usize,
    mode_tracking: Option<&ModeTrackingIR>,
) -> Result<PathSolveOutcome, RunError> {
    let planned_samples =
        expand_k_sampling(plan.k_sampling.as_ref()).map_err(|message| RunError { message })?;
    if accepted_prefix_len == 0 || accepted_prefix_len > planned_samples.len() {
        return Err(RunError {
            message: format!(
                "adaptive interrupted k-path prefix length {accepted_prefix_len} is outside the planned sample range 1..={}",
                planned_samples.len()
            ),
        });
    }
    solve_path_samples(
        solver,
        plan,
        outputs,
        &planned_samples[..accepted_prefix_len],
        planned_samples.len(),
        mode_tracking,
    )
}

fn solve_path_samples<S: ControlledSingleKSolver>(
    solver: &S,
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    sample_descriptors: &[KSampleDescriptor],
    planned_sample_count: usize,
    mode_tracking: Option<&ModeTrackingIR>,
) -> Result<PathSolveOutcome, RunError> {
    if sample_descriptors.is_empty() {
        return Err(RunError {
            message: "single-k solve returned no samples".to_string(),
        });
    }

    let mut sample_results = Vec::with_capacity(sample_descriptors.len());
    let mut interrupted = None;
    for sample in sample_descriptors {
        match solver.solve_single_k_controlled(plan, outputs, sample)? {
            SingleKSolveOutcome::Completed(solved) => sample_results.push(solved),
            SingleKSolveOutcome::Interrupted(action @ (StepAction::Stop | StepAction::Pause)) => {
                interrupted = Some(action);
                break;
            }
            SingleKSolveOutcome::Interrupted(StepAction::Continue) => {
                return Err(RunError {
                    message: "single-k solver returned an interruption without a control action"
                        .into(),
                });
            }
        }
    }

    if sample_results.is_empty() {
        if let Some(action) = interrupted {
            return Ok(PathSolveOutcome::Interrupted {
                action,
                accepted_prefix: None,
            });
        }
        return Err(RunError {
            message: "single-k solve returned no samples".to_string(),
        });
    }

    let solver_model = sample_results
        .first()
        .map(|sample| sample.solver_model)
        .ok_or_else(|| RunError {
            message: "single-k solve returned no samples".to_string(),
        })?;
    if let Some(mixed) = sample_results
        .iter()
        .find(|sample| sample.solver_model != solver_model)
    {
        return Err(RunError {
            message: format!(
                "mixed single-k solver models in k-path aggregation are not supported: first={}, sample_{}={}",
                solver_model.as_str(),
                mixed.sample.sample_index,
                mixed.solver_model.as_str()
            ),
        });
    }
    let sample_note = if sample_results.len() == planned_sample_count {
        format!("{} sample(s) generated from k_sampling", sample_results.len())
    } else {
        format!(
            "{} of {} planned k-sampling samples accepted before controlled interruption",
            sample_results.len(),
            planned_sample_count
        )
    };
    let mut notes = vec![sample_note];
    for note in sample_results
        .iter()
        .flat_map(|sample| sample.solver_notes.iter())
    {
        if !notes.iter().any(|existing| existing == note) {
            notes.push(note.clone());
        }
    }

    let mut result = PathSolveResult {
        gamma0_rad_s_per_a_m: plan.gyromagnetic_ratio,
        samples: sample_results,
        branches: Vec::new(),
        solver_model,
        notes,
        include_demag: plan.operator.include_demag,
        dispersion_validation: plan.dispersion_validation.clone(),
        k0_kittel_validation: plan.k0_kittel_validation.clone(),
        solver_policy: plan.solver_policy.clone(),
        dispersion_analytic_reference: plan.dispersion_validation.as_ref().map(|_| {
            DispersionAnalyticReferenceContext {
                external_field: plan.external_field.unwrap_or([0.0, 0.0, 0.0]),
                exchange_stiffness: plan.material.exchange_stiffness,
                saturation_magnetisation: plan.material.saturation_magnetisation,
                gyromagnetic_ratio: plan.gyromagnetic_ratio,
            }
        }),
        k0_kittel_periodic_airbox_demag: None,
    };
    track_branches(&mut result, mode_tracking);
    Ok(match interrupted {
        Some(action) => PathSolveOutcome::Interrupted {
            action,
            accepted_prefix: Some(result),
        },
        None => PathSolveOutcome::Completed(result),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eigen::types::{EigenSolverModel, SingleKModeResult};
    use fullmag_ir::{
        EigenDampingPolicyIR, EigenNormalizationIR, EigenOperatorConfigIR, EigenOperatorIR,
        EigenTargetIR, EquilibriumSourceIR, ExchangeBoundaryCondition, ExecutionPrecision,
        FemDomainMeshModeIR, KSamplingIR, MaterialIR, MeshIR, SpinWaveBoundaryConditionIR,
    };
    use num_complex::Complex64;
    use serde_json::Value;
    use std::cell::Cell;
    use std::collections::HashMap;
    use std::path::PathBuf;

    struct TempDirGuard {
        path: PathBuf,
    }

    impl TempDirGuard {
        fn new(slug: &str) -> Self {
            let path = std::env::temp_dir()
                .join(format!("fullmag-runner-{slug}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("temp test dir should be created");
            Self { path }
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn artifact_identity() -> FrequencyDomainArtifactIdentity {
        FrequencyDomainArtifactIdentity::try_new(
            "session:test-orchestrator",
            "run:test-orchestrator",
            "stage:eigenmodes",
            "runtime:test-orchestrator",
        )
        .expect("test artifact identity should be valid")
    }

    struct FakeSolver;

    impl SingleKSolver for FakeSolver {
        fn solve_single_k(
            &self,
            _plan: &FemEigenPlanIR,
            _outputs: &[OutputIR],
            sample: &KSampleDescriptor,
        ) -> Result<SingleKSolveResult, RunError> {
            Ok(SingleKSolveResult {
                sample: sample.clone(),
                modes: vec![SingleKModeResult {
                    raw_mode_index: 2,
                    branch_id: None,
                    frequency_real_hz: 12.5e9,
                    frequency_imag_hz: -1.0e6,
                    angular_frequency_rad_per_s: std::f64::consts::TAU * 12.5e9,
                    eigenvalue_real: 0.0,
                    eigenvalue_imag: std::f64::consts::TAU * 12.5e9,
                    norm: 1.0,
                    mass_norm: Some(1.0),
                    max_amplitude: 1.0,
                    residual_relative_l2: Some(1.0e-8),
                    residual_norm: Some(1.0e-8),
                    residual_linf: Some(1.0e-9),
                    tangent_leakage_mean_abs: Some(1.0e-12),
                    tangent_leakage_max_abs: Some(2.0e-12),
                    tangent_leakage_weighted_relative_l2: Some(1.5e-12),
                    dominant_polarization: "linear".to_string(),
                    reduced_vector: Some(vec![Complex64::new(1.0, 0.0)]),
                    lifted_real: Some(vec![[1.0, 0.0, 0.0]]),
                    lifted_imag: Some(vec![[0.0, 1.0, 0.0]]),
                    amplitude: Some(vec![1.0]),
                    phase: Some(vec![0.0]),
                    node_mass_weights: None,
                    consistent_p1_metric: None,
                    component_participation:
                        crate::eigen::ModalParticipationObservable::unavailable_without_context(
                            "cpu",
                        ),
                }],
                relaxation_steps: 0,
                solver_model: EigenSolverModel::ReferenceScalarTangent,
                solver_notes: vec!["fake solver".to_string()],
                solver_diagnostics: Some(serde_json::json!({
                    "mesh_id": "mesh:orchestrator-test",
                    "mesh_generation_id": "mesh-generation:orchestrator-test",
                    "mesh_revision": 1,
                    "topology_fingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                })),
            })
        }
    }

    struct InterruptAtSample {
        sample_index: usize,
        calls: Cell<usize>,
        action: StepAction,
    }

    impl ControlledSingleKSolver for InterruptAtSample {
        fn solve_single_k_controlled(
            &self,
            plan: &FemEigenPlanIR,
            outputs: &[OutputIR],
            sample: &KSampleDescriptor,
        ) -> Result<SingleKSolveOutcome, RunError> {
            self.calls.set(self.calls.get() + 1);
            if sample.sample_index == self.sample_index {
                Ok(SingleKSolveOutcome::Interrupted(self.action))
            } else {
                FakeSolver
                    .solve_single_k(plan, outputs, sample)
                    .map(SingleKSolveOutcome::Completed)
            }
        }
    }

    #[test]
    fn controlled_k_path_retains_only_the_completed_sample_prefix() {
        let plan = minimal_plan(Some(KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("X".to_string()),
                    k_vector: [1.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("M".to_string()),
                    k_vector: [0.0, 1.0, 0.0],
                },
            ],
            samples_per_segment: vec![1, 1],
            closed: false,
        }));
        let solver = InterruptAtSample {
            sample_index: 1,
            calls: Cell::new(0),
            action: StepAction::Pause,
        };

        let outcome = run_path_or_single_controlled(&solver, &plan, &[], None, None, None)
            .expect("control interruption should be a typed path outcome");

        match outcome {
            PathSolveOutcome::Interrupted {
                action: StepAction::Pause,
                accepted_prefix: Some(prefix),
            } => {
                assert_eq!(prefix.samples.len(), 1);
                assert_eq!(prefix.samples[0].sample.sample_index, 0);
            }
            other => panic!("unexpected controlled path outcome: {other:?}"),
        }
        assert_eq!(solver.calls.get(), 2, "later samples must not be admitted");
    }

    fn minimal_plan(k_sampling: Option<KSamplingIR>) -> FemEigenPlanIR {
        let mesh = MeshIR {
            mesh_name: "unit-tet".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
            element_markers: vec![1],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(Vec::new()),
            boundary_markers: Vec::new(),
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: HashMap::new(),
        };
        FemEigenPlanIR {
            mesh_build_report: None,
            mesh_name: mesh.mesh_name.clone(),
            mesh_source: None,
            mesh,
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 1.0,
            equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            material: MaterialIR {
                name: "Permalloy".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.01,
                uniaxial_anisotropy: None,
                uniaxial_anisotropy_k2: None,
                anisotropy_axis: None,
                cubic_anisotropy_kc1: None,
                cubic_anisotropy_kc2: None,
                cubic_anisotropy_kc3: None,
                cubic_anisotropy_axis1: None,
                cubic_anisotropy_axis2: None,
                ms_field: None,
                a_field: None,
                alpha_field: None,
                ku_field: None,
                ku2_field: None,
                kc1_field: None,
                kc2_field: None,
                kc3_field: None,
                interfacial_dmi: None,
                bulk_dmi: None,
                dind_field: None,
                dbulk_field: None,
            },
            operator: EigenOperatorConfigIR {
                kind: EigenOperatorIR::LinearizedLlg,
                include_demag: false,
            },
            count: 1,
            target: EigenTargetIR::Lowest,
            equilibrium: EquilibriumSourceIR::Provided,
            k_sampling,
            bias_field_samples: Vec::new(),
            normalization: EigenNormalizationIR::UnitL2,
            damping_policy: EigenDampingPolicyIR::Ignore,
            enable_exchange: true,
            enable_demag: false,
            interfacial_dmi: None,
            dmi_interface_normal: None,
            bulk_dmi: None,
            external_field: None,
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            spin_wave_bc: SpinWaveBoundaryConditionIR::default(),
            demag_realization: None,
            air_box_config: None,
            mode_tracking: None,
            dispersion_validation: None,
            k0_kittel_validation: None,
            solver_policy: None,
        }
    }

    #[test]
    fn run_path_or_single_writes_frequency_domain_eigen_manifest() {
        let temp = TempDirGuard::new("orchestrator-eigen-manifest");
        let identity = artifact_identity();
        run_path_or_single(
            &FakeSolver,
            &minimal_plan(Some(KSamplingIR::Single {
                k_vector: [0.0, 0.0, 0.0],
            })),
            &[],
            Some(&temp.path),
            Some(&identity),
            None,
        )
        .expect("orchestrator should solve and write artifacts");

        let family_manifest: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("frequency_domain/manifest.v1.json"))
                .expect("frequency-domain eigen manifest should be written"),
        )
        .expect("frequency-domain eigen manifest should be valid JSON");

        assert_eq!(family_manifest["stage_kind"], "eigenmodes");
        assert_eq!(
            family_manifest["requested_execution"]["calculation_mode"],
            "free_modes"
        );
        assert_eq!(
            family_manifest["artifacts"]["mode_metadata_paths"][0],
            "eigen/modes/sample_0000/mode_0002.json"
        );
        assert_eq!(
            family_manifest["resources"]["mode_field_resources"],
            serde_json::json!([])
        );
        assert!(!family_manifest.to_string().contains("/v2/sessions/current"));
    }

    #[test]
    fn run_path_or_single_rejects_artifact_output_without_exact_identity() {
        let temp = TempDirGuard::new("orchestrator-missing-artifact-identity");
        let error = run_path_or_single(
            &FakeSolver,
            &minimal_plan(Some(KSamplingIR::Single {
                k_vector: [0.0, 0.0, 0.0],
            })),
            &[],
            Some(&temp.path),
            None,
            None,
        )
        .expect_err("persistent output without exact identity must fail closed");

        assert!(error
            .message
            .contains("requires exact session, run, stage, and runtime identity"));
        assert!(!temp.path.join("frequency_domain/manifest.v1.json").exists());
    }

    #[test]
    fn production_cpu_shift_invert_solver_model_uses_native_adapter_token() {
        assert_eq!(
            EigenSolverModel::ProductionCpuShiftInvert.as_str(),
            "slepc_multi_shift_invert_production_cpu_dense"
        );
    }

    struct SolverModelBySample {
        models: Vec<EigenSolverModel>,
    }

    impl SingleKSolver for SolverModelBySample {
        fn solve_single_k(
            &self,
            _plan: &FemEigenPlanIR,
            _outputs: &[OutputIR],
            sample: &KSampleDescriptor,
        ) -> Result<SingleKSolveResult, RunError> {
            Ok(SingleKSolveResult {
                sample: sample.clone(),
                modes: vec![SingleKModeResult {
                    raw_mode_index: 0,
                    branch_id: None,
                    frequency_real_hz: 12.5e9,
                    frequency_imag_hz: 0.0,
                    angular_frequency_rad_per_s: std::f64::consts::TAU * 12.5e9,
                    eigenvalue_real: 0.0,
                    eigenvalue_imag: std::f64::consts::TAU * 12.5e9,
                    norm: 1.0,
                    mass_norm: Some(1.0),
                    max_amplitude: 1.0,
                    residual_relative_l2: Some(1.0e-8),
                    residual_norm: Some(1.0e-8),
                    residual_linf: Some(1.0e-9),
                    tangent_leakage_mean_abs: Some(1.0e-12),
                    tangent_leakage_max_abs: Some(2.0e-12),
                    tangent_leakage_weighted_relative_l2: Some(1.5e-12),
                    dominant_polarization: "linear".to_string(),
                    reduced_vector: Some(vec![Complex64::new(1.0, 0.0)]),
                    lifted_real: Some(vec![[1.0, 0.0, 0.0]]),
                    lifted_imag: Some(vec![[0.0, 1.0, 0.0]]),
                    amplitude: Some(vec![1.0]),
                    phase: Some(vec![0.0]),
                    node_mass_weights: None,
                    consistent_p1_metric: None,
                    component_participation:
                        crate::eigen::ModalParticipationObservable::unavailable_without_context(
                            "cpu",
                        ),
                }],
                relaxation_steps: 0,
                solver_model: self.models[sample.sample_index],
                solver_notes: vec!["sample model fixture".to_string()],
                solver_diagnostics: None,
            })
        }
    }

    #[test]
    fn run_path_or_single_rejects_mixed_sample_solver_models() {
        let solver = SolverModelBySample {
            models: vec![
                EigenSolverModel::ProductionCpuShiftInvert,
                EigenSolverModel::ReferenceFull2x2Tangent,
            ],
        };
        let plan = minimal_plan(Some(KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("X".to_string()),
                    k_vector: [1.0e6, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![1],
            closed: false,
        }));

        let err = run_path_or_single(&solver, &plan, &[], None, None, None)
            .expect_err("mixed production/reference samples must not be aggregated");

        assert!(err.message.contains("mixed single-k solver models"));
        assert!(err
            .message
            .contains("slepc_multi_shift_invert_production_cpu_dense"));
        assert!(err.message.contains("reference_full_2x2_tangent"));
    }

    #[test]
    fn interrupted_path_aggregates_only_the_requested_planned_prefix() {
        let plan = minimal_plan(Some(KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("X".to_string()),
                    k_vector: [1.0e6, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![2],
            closed: false,
        }));
        let planned = expand_k_sampling(plan.k_sampling.as_ref()).unwrap();
        assert!(planned.len() > 1, "fixture must contain a future sample");

        let partial = run_path_prefix_or_single(&FakeSolver, &plan, &[], 1, None)
            .expect("one accepted sample should produce a real partial path");

        assert_eq!(partial.samples.len(), 1);
        assert_eq!(partial.samples[0].sample.sample_index, planned[0].sample_index);
        assert_eq!(partial.samples[0].modes.len(), 1);
        assert!(partial.notes[0].contains(&format!("1 of {} planned", planned.len())));
    }

    #[test]
    fn interrupted_path_rejects_an_empty_prefix_without_fabricating_samples() {
        let plan = minimal_plan(Some(KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("X".to_string()),
                    k_vector: [1.0e6, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![2],
            closed: false,
        }));

        let error = run_path_prefix_or_single(&FakeSolver, &plan, &[], 0, None)
            .expect_err("an empty accepted prefix has no path spectrum to publish");

        assert!(error.message.contains("prefix length 0"));
    }
}
