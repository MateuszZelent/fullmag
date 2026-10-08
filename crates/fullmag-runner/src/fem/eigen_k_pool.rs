//! Preparation and execution bridge for independent FEM eigen-k workers.

use crate::dispatch::FemEngine;
use crate::eigen::SingleKSolveResult;
use crate::fem::eigen_execution_resolution::{FemEigenExecutionLane, PlannedFemEigenExecution};
use crate::fem::eigen_reduction::build_reduction_map;
use crate::fem_eigen;
use crate::types::{AuxiliaryArtifact, LiveParallelExecutionTelemetry, RunError, StepAction};
use fullmag_engine::fem::MeshTopology;
use fullmag_ir::{FemEigenPlanIR, OutputIR, ParallelExecutionModeIR, ParallelExecutionPolicyIR};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub(super) struct PrecomputedSingleK {
    pub(super) result: SingleKSolveResult,
    pub(super) mode_artifacts: Vec<AuxiliaryArtifact>,
    pub(super) final_magnetization: Vec<[f64; 3]>,
}

pub(super) enum ProcessPoolPreparation {
    Ready {
        precomputed: HashMap<usize, PrecomputedSingleK>,
        report: crate::eigen::k_process_pool::ProcessPoolReportV1,
    },
    Interrupted(super::eigen_path::InterruptedSingleK),
}

fn parallel_admission_progress(
    event: &crate::eigen::k_process_pool::ProcessAdmissionEventV1,
    policy: &ParallelExecutionPolicyIR,
    requested_modes: usize,
    resolved_workers: Option<usize>,
    terminal: bool,
) -> fem_eigen::FemEigenProgress {
    let snapshot = event.snapshot.as_ref();
    let worker_peak = event.worker_peak.as_ref();
    let to_u32 = |value: usize| u32::try_from(value).unwrap_or(u32::MAX);
    fem_eigen::FemEigenProgress {
        phase: "admitting_eigen_k_workers",
        requested_modes,
        parallel_execution: Some(LiveParallelExecutionTelemetry {
            sampled_at_unix_ms: u64::try_from(event.at_unix_ms).unwrap_or(u64::MAX),
            active_workers: to_u32(event.active_workers),
            admission_desired_workers: to_u32(event.desired_workers),
            admission_worker_limit: policy.max_workers,
            admission_pending_samples: to_u32(event.pending_samples),
            resolved_workers: resolved_workers.map(to_u32),
            cpu_target_percent: policy.max_cpu_percent,
            memory_target_percent: policy.max_memory_percent,
            memory_reserve_bytes: policy.memory_reserve_bytes,
            cpu_target_kind: event.cpu_target_kind.clone(),
            cpu_busy_percent: snapshot.map(|value| value.cpu_busy_percent),
            allocated_cpu_cores: snapshot.map(|value| value.allocated_cpu_cores),
            cpu_available_cores: snapshot.map(|value| value.cpu_available_cores),
            memory_limit_bytes: snapshot.map(|value| value.memory_limit_bytes),
            memory_available_bytes: snapshot.map(|value| value.memory_available_bytes),
            worker_peak_cpu_cores: worker_peak.map(|value| value.cpu_cores),
            worker_peak_rss_bytes: worker_peak.map(|value| value.rss_bytes),
            admission_reason: event.reason.clone(),
            terminal,
        }),
        ..Default::default()
    }
}

fn stage_relax_bootstrap_certificates(
    process_root: &Path,
    artifacts: &[AuxiliaryArtifact],
) -> Result<PathBuf, RunError> {
    let bootstrap_root = process_root.join("bootstrap");
    fs::create_dir_all(&bootstrap_root).map_err(|error| RunError {
        message: format!("create adaptive eigen bootstrap root: {error}"),
    })?;
    let mut staged = HashMap::<String, PathBuf>::new();
    for artifact in artifacts
        .iter()
        .filter(|artifact| artifact.relative_path.starts_with("eigen/metadata/"))
    {
        let relative = Path::new(&artifact.relative_path);
        if relative.is_absolute()
            || relative.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir
                        | std::path::Component::RootDir
                        | std::path::Component::Prefix(_)
                )
            })
        {
            return Err(RunError {
                message: format!(
                    "adaptive eigen bootstrap artifact path escapes namespace: {}",
                    artifact.relative_path
                ),
            });
        }
        let destination = bootstrap_root.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| RunError {
                message: format!("create adaptive eigen bootstrap artifact parent: {error}"),
            })?;
        }
        if destination.exists() {
            let existing = fs::read(&destination).map_err(|error| RunError {
                message: format!("read existing adaptive eigen bootstrap artifact: {error}"),
            })?;
            if existing != artifact.bytes {
                return Err(RunError {
                    message: format!(
                        "adaptive eigen bootstrap artifact would overwrite different bytes: {}",
                        artifact.relative_path
                    ),
                });
            }
        } else {
            let temporary = destination.with_extension(format!("tmp-{}", std::process::id()));
            fs::write(&temporary, &artifact.bytes).map_err(|error| RunError {
                message: format!("write adaptive eigen bootstrap artifact: {error}"),
            })?;
            fs::rename(&temporary, &destination).map_err(|error| RunError {
                message: format!("publish adaptive eigen bootstrap artifact: {error}"),
            })?;
        }
        staged.insert(artifact.relative_path.clone(), destination);
    }

    let mut equilibrium_candidates = staged
        .iter()
        .filter(|(relative, _)| {
            relative.ends_with("equilibrium_artifact.v7.json")
                || relative.ends_with("equilibrium_artifact.v8.json")
        })
        .collect::<Vec<_>>();
    equilibrium_candidates.sort_by_key(|(relative, _)| relative.len());
    let (equilibrium_relative, equilibrium_path) = equilibrium_candidates
        .first()
        .map(|(relative, path)| ((*relative).clone(), (*path).clone()))
        .ok_or_else(|| RunError {
            message: "Relax→Eigen bootstrap did not publish equilibrium_artifact.v7/v8".into(),
        })?;
    let equilibrium_value: Value =
        serde_json::from_slice(&fs::read(&equilibrium_path).map_err(|error| RunError {
            message: format!("read staged adaptive eigen equilibrium artifact: {error}"),
        })?)
        .map_err(|error| RunError {
            message: format!("parse staged adaptive eigen equilibrium artifact: {error}"),
        })?;
    let schema = equilibrium_value
        .get("schema_version")
        .and_then(Value::as_str)
        .ok_or_else(|| RunError {
            message: "adaptive eigen bootstrap equilibrium artifact has no schema_version".into(),
        })?;
    let state_name = match schema {
        "equilibrium_artifact.v7" => "linearization_state.v6.json",
        "equilibrium_artifact.v8" => "linearization_state.v7.json",
        _ => {
            return Err(RunError {
                message: format!(
                    "unsupported adaptive eigen bootstrap equilibrium schema {schema}"
                ),
            })
        }
    };
    let equilibrium_parent = Path::new(&equilibrium_relative)
        .parent()
        .ok_or_else(|| RunError {
            message: "adaptive eigen bootstrap equilibrium artifact has no parent path".into(),
        })?;
    let state_relative = equilibrium_parent
        .join(state_name)
        .to_string_lossy()
        .replace('\\', "/");
    let state_path = staged.get(&state_relative).ok_or_else(|| RunError {
        message: format!("adaptive eigen bootstrap is missing schema-matched {state_name} sidecar"),
    })?;
    let state_value: Value =
        serde_json::from_slice(&fs::read(state_path).map_err(|error| RunError {
            message: format!("read staged adaptive eigen linearization state: {error}"),
        })?)
        .map_err(|error| RunError {
            message: format!("parse staged adaptive eigen linearization state: {error}"),
        })?;
    let expected_state_schema = if schema == "equilibrium_artifact.v8" {
        "LinearizationState.v7"
    } else {
        "LinearizationState.v6"
    };
    if state_value.get("schema_version").and_then(Value::as_str) != Some(expected_state_schema) {
        return Err(RunError {
            message: format!(
                "adaptive eigen bootstrap sidecar schema mismatch: expected {expected_state_schema}"
            ),
        });
    }
    Ok(equilibrium_path)
}

pub(super) fn prepare_process_pool_samples(
    execution: PlannedFemEigenExecution<'_>,
    plan: &FemEigenPlanIR,
    tracking_outputs: &[OutputIR],
    parallel_policy: &ParallelExecutionPolicyIR,
    process_root: Option<&Path>,
    checkpoint_root: Option<&Path>,
    source_relax_handoff: Option<&fem_eigen::AcceptedFemRelaxStageHandoff>,
    producer_identity: Option<&fem_eigen::FemRelaxationProducerStageIdentity>,
    progress: &mut Option<&mut fem_eigen::FemEigenProgressCallback<'_>>,
) -> Result<ProcessPoolPreparation, RunError> {
    if parallel_policy.mode != ParallelExecutionModeIR::Adaptive {
        return Err(RunError {
            message: "process pool preparation requires parallel_execution.mode=adaptive".into(),
        });
    }
    let process_root = process_root.ok_or_else(|| RunError {
        message: "adaptive FEM eigen path requires a managed process staging root".into(),
    })?;
    let resolution = execution.resolution().ok_or_else(|| RunError {
        message: "adaptive FEM eigen path requires an exact execution resolution".into(),
    })?;
    if execution.lane() != FemEigenExecutionLane::Cpu {
        return Err(RunError {
            message: "adaptive FEM eigen process pool supports CPU lane only; GPU remains serial"
                .into(),
        });
    }
    if !plan.bias_field_samples.is_empty() {
        return Err(RunError {
            message:
                "adaptive FEM eigen process pool rejects bias_field_samples; continuation remains serial"
                    .into(),
        });
    }
    let samples = crate::eigen::expand_k_sampling(plan.k_sampling.as_ref())
        .map_err(|message| RunError { message })?;
    if samples.is_empty() {
        return Err(RunError {
            message: "adaptive FEM eigen path expanded to zero samples".into(),
        });
    }
    if !matches!(
        plan.equilibrium,
        fullmag_ir::EquilibriumSourceIR::Artifact { .. }
    ) && source_relax_handoff.is_none()
    {
        return Err(RunError {
            message: "adaptive FEM eigen path requires an immutable certified equilibrium Artifact or a verified Relax→Eigen handoff for serial bootstrap".into(),
        });
    }
    let tracking_topology = MeshTopology::from_ir(&plan.mesh).map_err(|error| RunError {
        message: format!("adaptive eigen tracking mesh topology: {error}"),
    })?;
    let tracking_metric =
        super::eigen_path::eigen_path_consistent_tracking_metric(&tracking_topology, &plan.mesh)?;
    let mut precomputed = HashMap::with_capacity(samples.len());
    let mut worker_plan = plan.clone();
    let mut bootstrap_sample_index = None;
    if !matches!(
        plan.equilibrium,
        fullmag_ir::EquilibriumSourceIR::Artifact { .. }
    ) {
        let checkpoint_root = checkpoint_root.ok_or_else(|| RunError {
            message: "adaptive bootstrap has no preflighted raw checkpoint attempt".into(),
        })?;
        let handoff = source_relax_handoff.ok_or_else(|| RunError {
            message:
                "adaptive FEM eigen path cannot bootstrap Relax→Eigen without a verified handoff"
                    .into(),
        })?;
        let bootstrap_sample = samples.first().ok_or_else(|| RunError {
            message: "adaptive FEM eigen path has no sample for Relax→Eigen bootstrap".into(),
        })?;
        let bootstrap_point_plan =
            super::eigen_path::eigen_path_single_k_point_plan(plan, bootstrap_sample, false, None)?;
        let bootstrap_reduction = build_reduction_map(
            &tracking_topology,
            &bootstrap_point_plan.spin_wave_bc,
            bootstrap_point_plan.k_sampling.as_ref(),
        )?;
        let mut bootstrap_progress = |event: fem_eigen::FemEigenProgress| {
            progress
                .as_deref_mut()
                .map(|callback| callback(event))
                .unwrap_or(crate::types::StepAction::Continue)
        };
        let bootstrap_run = fem_eigen::execute_planned_fem_eigen_with_progress_and_stage_handoff_and_producer_identity(
            execution,
            &bootstrap_point_plan,
            tracking_outputs,
            &mut bootstrap_progress,
            handoff,
            bootstrap_sample.sample_index,
            Some(bootstrap_sample.sample_index),
            producer_identity,
        )?;
        // A pool failure must not discard the serial bootstrap's raw bytes.
        // Workers already persist their own raw response/artifact closure.
        match super::eigen_path::checkpoint_and_admit_single_k(
            Some(checkpoint_root),
            bootstrap_sample,
            &bootstrap_point_plan,
            &bootstrap_run,
        )? {
            super::eigen_path::SingleKCheckpointAdmission::Completed => {}
            super::eigen_path::SingleKCheckpointAdmission::Interrupted(interrupted) => {
                return Ok(ProcessPoolPreparation::Interrupted(interrupted));
            }
        }
        let bootstrap_magnetization = bootstrap_run.result.final_magnetization.clone();
        if bootstrap_magnetization.len() != plan.mesh.nodes.len()
            || bootstrap_magnetization
                .iter()
                .flatten()
                .any(|value| !value.is_finite())
        {
            return Err(RunError {
                message: "Relax→Eigen bootstrap did not produce a finite accepted equilibrium"
                    .into(),
            });
        }
        let equilibrium_path =
            stage_relax_bootstrap_certificates(process_root, &bootstrap_run.auxiliary_artifacts)?;
        worker_plan.equilibrium = fullmag_ir::EquilibriumSourceIR::Artifact {
            path: equilibrium_path.to_string_lossy().to_string(),
        };
        worker_plan.equilibrium_magnetization = bootstrap_magnetization.clone();
        let (bootstrap_result, mut bootstrap_mode_artifacts) =
            super::eigen_path::parse_worker_single_k_result(
                plan,
                &bootstrap_point_plan,
                tracking_outputs,
                bootstrap_sample,
                FemEngine::CpuNative,
                &bootstrap_run.auxiliary_artifacts,
                &tracking_topology,
                &bootstrap_reduction,
                &tracking_metric,
            )?;
        bootstrap_mode_artifacts.extend(bootstrap_run.auxiliary_artifacts.clone());
        precomputed.insert(
            bootstrap_sample.sample_index,
            PrecomputedSingleK {
                result: bootstrap_result,
                mode_artifacts: bootstrap_mode_artifacts,
                final_magnetization: bootstrap_magnetization,
            },
        );
        bootstrap_sample_index = Some(bootstrap_sample.sample_index);
    }
    let placeholder_root = process_root.join("requests");
    let worker_samples = samples
        .iter()
        .filter(|sample| Some(sample.sample_index) != bootstrap_sample_index)
        .collect::<Vec<_>>();
    if worker_samples.is_empty() {
        let report = crate::eigen::k_process_pool::ProcessPoolReportV1 {
            protocol: crate::fem::eigen_k_worker::EIGEN_K_WORKER_PROTOCOL_V1.to_string(),
            requested_mode: parallel_policy.mode,
            resolved_mode: "serial_bootstrap_only".into(),
            resolved_workers: 1,
            policy: parallel_policy.clone(),
            inputs: Vec::new(),
            thread_bindings: Vec::new(),
            cpu_observations: Vec::new(),
            worker_logs: Vec::new(),
            events: Vec::new(),
            events_truncated: false,
            telemetry_reason: Some(
                "single sample completed by verified Relax→Eigen bootstrap".into(),
            ),
        };
        return Ok(ProcessPoolPreparation::Ready {
            precomputed,
            report,
        });
    }
    let requests = worker_samples
        .iter()
        .map(|sample| {
            Ok(crate::fem::eigen_k_worker::EigenKWorkerRequestV1 {
                protocol: crate::fem::eigen_k_worker::EIGEN_K_WORKER_PROTOCOL_V1.to_string(),
                plan: super::eigen_path::eigen_path_single_k_point_plan(
                    &worker_plan,
                    sample,
                    false,
                    None,
                )?,
                outputs: tracking_outputs.to_vec(),
                execution: resolution.clone(),
                parallel_policy: parallel_policy.clone(),
                thread_budget: crate::fem::eigen_k_worker::EigenKWorkerThreadBudgetV1 {
                    requested_threads: parallel_policy.threads_per_worker,
                    resolved_threads: 1,
                    cap_reason: "parent_admission_pending".into(),
                    allocation_cpu_cores: 1.0,
                    host_cpu_cores: std::thread::available_parallelism()
                        .map(|value| value.get().min(u32::MAX as usize) as u32)
                        .unwrap_or(1),
                },
                sample_index: sample.sample_index,
                k_vector: sample.k_vector,
                expected_plan_sha256: String::new(),
                expected_equilibrium_artifact_sha256: String::new(),
                artifact_dir: placeholder_root.join(format!("sample-{}", sample.sample_index)),
                response_path: placeholder_root
                    .join(format!("sample-{}.response.json", sample.sample_index)),
                cancel_path: None,
            })
        })
        .collect::<Result<Vec<_>, RunError>>()?;
    let mut requests = requests;
    for request in &mut requests {
        request.expected_plan_sha256 = crate::fem::eigen_k_worker::plan_sha256(&request.plan)?;
        request.expected_equilibrium_artifact_sha256 =
            crate::fem::eigen_k_worker::equilibrium_artifact_sha256(&request.plan)?;
    }
    let pool = crate::eigen::k_process_pool::EigenKProcessPool::new(
        process_root.join("eigen-k-workers"),
        parallel_policy.clone(),
    )
    .map_err(|message| RunError { message })?;
    let cancellation = Arc::new(AtomicBool::new(false));
    let admission_stop_requested = Arc::new(AtomicBool::new(false));
    let mut last_admission_publish = None::<Instant>;
    let mut last_admission_reason = None::<String>;
    let admission_stop_for_callback = Arc::clone(&admission_stop_requested);
    let mut check_cancel = |event: Option<
        &crate::eigen::k_process_pool::ProcessAdmissionEventV1,
    >| {
        if admission_stop_for_callback.load(Ordering::Relaxed) {
            return true;
        }
        if let Some(event) = event {
            let reason_changed = last_admission_reason
                .as_deref()
                .is_none_or(|reason| reason != event.reason);
            let publish = reason_changed
                || last_admission_publish
                    .is_none_or(|published_at| published_at.elapsed() >= Duration::from_secs(1));
            if publish {
                let action = progress.as_deref_mut().map(|callback| {
                    callback(parallel_admission_progress(
                        event,
                        parallel_policy,
                        plan.count as usize,
                        None,
                        false,
                    ))
                });
                last_admission_publish = Some(Instant::now());
                last_admission_reason = Some(event.reason.clone());
                if matches!(action, Some(StepAction::Stop | StepAction::Pause)) {
                    admission_stop_for_callback.store(true, Ordering::Relaxed);
                }
            }
            return admission_stop_for_callback.load(Ordering::Relaxed);
        }
        progress.as_deref_mut().is_some_and(|callback| {
            matches!(
                callback(fem_eigen::FemEigenProgress {
                    phase: "admitting_eigen_k_workers",
                    requested_modes: plan.count as usize,
                    ..Default::default()
                }),
                StepAction::Stop | StepAction::Pause
            )
        })
    };
    let pool_result = pool
        .execute(&requests, cancellation, Some(&mut check_cancel))
        .map_err(|message| RunError { message })?;
    drop(check_cancel);
    if let Some(event) = pool_result.report.events.last() {
        if let Some(callback) = progress.as_deref_mut() {
            if matches!(
                callback(parallel_admission_progress(
                    event,
                    parallel_policy,
                    plan.count as usize,
                    Some(pool_result.report.resolved_workers),
                    true,
                )),
                StepAction::Stop | StepAction::Pause
            ) {
                return Err(RunError {
                    message: "adaptive FEM eigen process pool was interrupted by runtime control"
                        .into(),
                });
            }
        }
    }
    for response in pool_result.responses {
        let sample = samples
            .iter()
            .find(|sample| sample.sample_index == response.sample_index)
            .ok_or_else(|| RunError {
                message: format!(
                    "adaptive worker returned unknown sample_index {}",
                    response.sample_index
                ),
            })?;
        let run = response.run.as_ref().ok_or_else(|| RunError {
            message: response
                .error
                .clone()
                .unwrap_or_else(|| "adaptive worker returned no run payload".into()),
        })?;
        if !response.ok || !matches!(run.status, crate::types::RunStatus::Completed) {
            return Err(RunError {
                message: response.error.clone().unwrap_or_else(|| {
                    format!(
                        "adaptive worker sample {} did not complete",
                        sample.sample_index
                    )
                }),
            });
        }
        let request = requests
            .iter()
            .find(|request| request.sample_index == response.sample_index)
            .ok_or_else(|| RunError {
                message: format!(
                    "adaptive worker request disappeared for sample {}",
                    response.sample_index
                ),
            })?;
        if run.plan_sha256 != request.expected_plan_sha256
            || run.equilibrium_artifact_sha256 != request.expected_equilibrium_artifact_sha256
        {
            return Err(RunError {
                message: format!(
                    "adaptive worker input digest mismatch for sample {}",
                    response.sample_index
                ),
            });
        }
        if run.thread_budget.requested_threads != request.parallel_policy.threads_per_worker
            || run.thread_budget.resolved_threads == 0
            || run.thread_budget.resolved_threads > run.thread_budget.requested_threads
            || run.thread_budget.cap_reason.trim().is_empty()
            || !run.thread_budget.allocation_cpu_cores.is_finite()
            || run.thread_budget.allocation_cpu_cores <= 0.0
        {
            return Err(RunError {
                message: format!(
                    "adaptive worker sample {} returned an invalid thread budget",
                    sample.sample_index
                ),
            });
        }
        let artifacts = pool
            .load_artifacts(&response)
            .map_err(|message| RunError { message })?;
        let point_plan =
            super::eigen_path::eigen_path_single_k_point_plan(&worker_plan, sample, false, None)?;
        let tracking_reduction = build_reduction_map(
            &tracking_topology,
            &point_plan.spin_wave_bc,
            point_plan.k_sampling.as_ref(),
        )?;
        let (result, mode_artifacts) = super::eigen_path::parse_worker_single_k_result(
            plan,
            &point_plan,
            tracking_outputs,
            sample,
            FemEngine::CpuNative,
            &artifacts,
            &tracking_topology,
            &tracking_reduction,
            &tracking_metric,
        )?;
        if run.final_magnetization.len() != plan.mesh.nodes.len()
            || run
                .final_magnetization
                .iter()
                .flatten()
                .any(|value| !value.is_finite())
        {
            return Err(RunError {
                message: format!(
                    "adaptive worker sample {} returned an invalid final magnetization",
                    sample.sample_index
                ),
            });
        }
        // Artifact and run validation above borrow the response. Transfer the
        // already validated vector instead of keeping and cloning each payload.
        let final_magnetization = response
            .run
            .expect("worker run payload was validated above")
            .final_magnetization;
        if precomputed
            .insert(
                sample.sample_index,
                PrecomputedSingleK {
                    result,
                    mode_artifacts,
                    final_magnetization,
                },
            )
            .is_some()
        {
            return Err(RunError {
                message: format!("adaptive worker duplicated sample {}", sample.sample_index),
            });
        }
    }
    if precomputed.len() != samples.len() {
        return Err(RunError {
            message: format!(
                "adaptive worker returned {} of {} samples",
                precomputed.len(),
                samples.len()
            ),
        });
    }
    Ok(ProcessPoolPreparation::Ready {
        precomputed,
        report: pool_result.report,
    })
}
