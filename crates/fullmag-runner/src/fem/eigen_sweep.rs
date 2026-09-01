use super::eigen_digest::is_sha256_digest;
use super::eigen_output::{json_artifact, mode_metadata_path, published_artifact_sha256};
use crate::types::AuxiliaryArtifact;
use crate::types::ExecutedRun;
use crate::types::RunError;
use crate::types::RunStatus;
use fullmag_engine::Vector3;
use fullmag_engine::MU0;
use fullmag_ir::EquilibriumSourceIR;
use fullmag_ir::FemEigenPlanIR;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub(super) fn bias_field_sweep_requested(plan: &FemEigenPlanIR) -> bool {
    !plan.bias_field_samples.is_empty()
}

pub(super) fn validate_bias_field_samples(
    plan: &FemEigenPlanIR,
) -> Result<&[fullmag_ir::FemEigenBiasFieldSamplePlanIR], RunError> {
    if plan.bias_field_samples.is_empty() {
        return Err(RunError {
            message: "FEM bias-field sweep requires at least one bias_field_samples entry"
                .to_string(),
        });
    }
    for (position, sample) in plan.bias_field_samples.iter().enumerate() {
        if sample.sample_index as usize != position {
            return Err(RunError {
                message: format!(
                    "FEM bias-field sweep sample index {} is not the declared position {}",
                    sample.sample_index, position
                ),
            });
        }
        if sample.equilibrium_policy == fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::RelaxEach
            && sample.continuation_seed
                == fullmag_ir::BiasFieldSweepContinuationSeedIR::PreviousAcceptedEquilibrium
        {
            return Err(RunError {
                message: format!(
                    concat!(
                        "FEM bias-field sweep sample {} uses ",
                        "continuation_seed=previous_accepted_equilibrium with ",
                        "equilibrium_policy=relax_each; use initial_state",
                    ),
                    sample.sample_index,
                ),
            });
        }
        if sample
            .field_a_per_m
            .iter()
            .any(|component| !component.is_finite())
        {
            return Err(RunError {
                message: format!(
                    "FEM bias-field sweep sample {} requires finite field_a_per_m components",
                    sample.sample_index
                ),
            });
        }
    }
    Ok(&plan.bias_field_samples)
}

pub(super) fn prepare_bias_field_sample_plan(
    plan: &FemEigenPlanIR,
    sample: &fullmag_ir::FemEigenBiasFieldSamplePlanIR,
    base_initial_magnetization: &[Vector3],
    previous_accepted_magnetization: Option<&[Vector3]>,
) -> Result<FemEigenPlanIR, RunError> {
    let expected_len = plan.mesh.nodes.len();
    if base_initial_magnetization.len() != expected_len {
        return Err(RunError {
            message: format!(
                "FEM bias-field sweep initial magnetization has {} nodes; expected {}",
                base_initial_magnetization.len(),
                expected_len
            ),
        });
    }
    if base_initial_magnetization
        .iter()
        .flatten()
        .any(|component| !component.is_finite())
    {
        return Err(RunError {
            message: "FEM bias-field sweep initial magnetization contains non-finite values"
                .to_string(),
        });
    }

    let starting_magnetization = match sample.equilibrium_policy {
        fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::RelaxEach => {
            // Each sample is a separate relaxation experiment.  A prior
            // sample must never leak into this policy.
            base_initial_magnetization.to_vec()
        }
        fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::Continuation => {
            if let Some(previous) = previous_accepted_magnetization {
                // Once an accepted sample exists, continuation always uses
                // that accepted state regardless of the bootstrap seed.
                previous.to_vec()
            } else {
                match sample.continuation_seed {
                    // The first sample has no prior accepted state.  The
                    // declared initial state is therefore the deterministic
                    // bootstrap for either valid seed; subsequent samples
                    // use the accepted state above.
                    fullmag_ir::BiasFieldSweepContinuationSeedIR::InitialState
                    | fullmag_ir::BiasFieldSweepContinuationSeedIR::PreviousAcceptedEquilibrium => {
                        base_initial_magnetization.to_vec()
                    }
                }
            }
        }
    };
    if starting_magnetization.len() != expected_len {
        return Err(RunError {
            message: format!(
                "FEM bias-field sweep continuation magnetization has {} nodes; expected {}",
                starting_magnetization.len(),
                expected_len
            ),
        });
    }
    if starting_magnetization
        .iter()
        .flatten()
        .any(|component| !component.is_finite())
    {
        return Err(RunError {
            message: "FEM bias-field sweep continuation magnetization contains non-finite values"
                .to_string(),
        });
    }

    let mut sample_plan = plan.clone();
    sample_plan.external_field = Some(sample.field_a_per_m);
    // The outer BiasFieldSweepIR has already selected this one physical
    // target.  Keep the delegated solve as a single-sample plan so the
    // per-sample relaxation/eigen handoff cannot recursively re-enter the
    // sweep dispatcher or carry the postsolve oracle into the modal lane.
    sample_plan.bias_field_samples.clear();
    sample_plan.k0_kittel_validation = None;
    // Both declared policies solve an accepted equilibrium at the current
    // field.  `continuation_seed` selects only the first continuation seed;
    // once a previous accepted state exists it is always the next seed.
    sample_plan.equilibrium = EquilibriumSourceIR::RelaxedInitialState;
    sample_plan.equilibrium_magnetization = starting_magnetization;
    Ok(sample_plan)
}

pub(super) fn validate_bias_field_sweep_oracle_contract(
    plan: &FemEigenPlanIR,
) -> Result<(), RunError> {
    let Some(validation) = plan.k0_kittel_validation.as_ref() else {
        return Ok(());
    };
    let physical_k0_kittel = validation.kind == "k0_kittel_field_sweep"
        && validation.case_id.as_deref() == Some("K0-3")
        && validation.demag_kind.as_deref() == Some("periodic_airbox_k0");
    if !physical_k0_kittel {
        return Err(RunError {
            message: concat!(
                "bias_field_sweep_kittel_postsolve_oracle_unavailable: physical bias-field ",
                "sweeps cannot claim Kittel validation until a per-sample postsolve adapter ",
                "publishes pass/fail artifacts",
            )
            .to_string(),
        });
    }
    if validation.samples.len() != plan.bias_field_samples.len() {
        return Err(RunError {
            message: format!(
                "bias_field_sweep_kittel_sample_count_mismatch: validation declares {} samples but physical sweep declares {}",
                validation.samples.len(),
                plan.bias_field_samples.len()
            ),
        });
    }
    for (position, sample) in plan.bias_field_samples.iter().enumerate() {
        let Some(reference) = validation
            .samples
            .iter()
            .find(|reference| reference.sample_index as usize == position)
        else {
            return Err(RunError {
                message: format!(
                    "bias_field_sweep_kittel_sample_missing: validation has no sample {}",
                    position
                ),
            });
        };
        let mismatch = reference
            .bias_field
            .iter()
            .zip(sample.field_a_per_m.iter())
            .map(|(expected, actual)| (expected - actual).abs())
            .fold(0.0_f64, f64::max);
        if !(mismatch.is_finite() && mismatch <= 1.0e-9) {
            return Err(RunError {
                message: format!(
                    "bias_field_sweep_kittel_field_mismatch: physical sample {} differs from the declared Kittel oracle",
                    position
                ),
            });
        }
    }
    Ok(())
}

pub(super) fn bias_field_sample_is_complete(status: RunStatus) -> bool {
    status == RunStatus::Completed
}

fn patch_bias_field_sweep_json_artifact(
    run: &mut ExecutedRun,
    relative_path: &str,
    sweep_metadata: &serde_json::Value,
) -> Result<(), RunError> {
    let Some(artifact) = run
        .auxiliary_artifacts
        .iter_mut()
        .find(|artifact| artifact.relative_path == relative_path)
    else {
        return Ok(());
    };
    let mut value = parse_sweep_artifact(artifact, relative_path)?;
    let object = value.as_object_mut().ok_or_else(|| RunError {
        message: format!("bias-field sweep partial artifact {relative_path} must be a JSON object"),
    })?;
    object.insert("status".to_string(), serde_json::json!("interrupted"));
    object.insert("complete".to_string(), serde_json::json!(false));
    object.insert("field_sweep".to_string(), sweep_metadata.clone());
    for key in ["diagnostics", "solver_diagnostics"] {
        if let Some(nested) = object
            .get_mut(key)
            .and_then(serde_json::Value::as_object_mut)
        {
            nested.insert("status".to_string(), serde_json::json!("interrupted"));
            nested.insert("complete".to_string(), serde_json::json!(false));
            nested.insert("field_sweep".to_string(), sweep_metadata.clone());
        }
    }
    artifact.bytes = serde_json::to_vec_pretty(&value).map_err(|error| RunError {
        message: format!(
            "failed to serialize bias-field sweep partial artifact {relative_path}: {error}"
        ),
    })?;
    Ok(())
}

pub(super) fn preserve_interrupted_bias_field_sweep_run(
    mut run: ExecutedRun,
    requested_sample_count: usize,
    completed_sample_count: usize,
    interrupted_sample_index: u32,
    equilibrium_policy: fullmag_ir::BiasFieldSweepEquilibriumPolicyIR,
    continuation_seed: fullmag_ir::BiasFieldSweepContinuationSeedIR,
) -> Result<ExecutedRun, RunError> {
    let sweep_metadata = serde_json::json!({
        "kind": "bias_field_sweep",
        "source": "bias_field_samples",
        "status": "interrupted",
        "complete": false,
        "requested_sample_count": requested_sample_count,
        "completed_sample_count": completed_sample_count,
        "interrupted_sample_index": interrupted_sample_index,
        "run_status": run_status_label(run.result.status),
        "subsequent_samples_executed": false,
        "equilibrium_policy": bias_field_equilibrium_policy_label(equilibrium_policy),
        "continuation_seed": bias_field_continuation_seed_label(continuation_seed),
        "continuation_seed_scope": "first_sample_bootstrap",
    });
    let partial = serde_json::json!({
        "schema_version": "fem_k0_modal_partial.v1",
        "status": "interrupted",
        "complete": false,
        "stop_reason": "cancel_requested",
        "field_sweep": sweep_metadata.clone(),
    });
    if let Some(artifact) = run
        .auxiliary_artifacts
        .iter_mut()
        .find(|artifact| artifact.relative_path == "eigen/partial.v1.json")
    {
        let mut value = parse_sweep_artifact(artifact, "eigen/partial.v1.json")?;
        let object = value.as_object_mut().ok_or_else(|| RunError {
            message: "bias-field sweep eigen/partial.v1.json must be a JSON object".to_string(),
        })?;
        object.insert("status".to_string(), serde_json::json!("interrupted"));
        object.insert("complete".to_string(), serde_json::json!(false));
        object.insert("field_sweep".to_string(), sweep_metadata.clone());
        artifact.bytes = serde_json::to_vec_pretty(&value).map_err(|error| RunError {
            message: format!("failed to serialize bias-field sweep eigen/partial.v1.json: {error}"),
        })?;
    } else {
        run.auxiliary_artifacts
            .push(json_artifact("eigen/partial.v1.json", &partial)?);
    }
    for path in [
        "eigen/spectrum.v2.json",
        "eigen/spectrum.json",
        "eigen/branches.v2.json",
        "eigen/diagnostics/solver.v1.json",
        "eigen/metadata/eigen_summary.json",
        "frequency_domain/manifest.v1.json",
    ] {
        patch_bias_field_sweep_json_artifact(&mut run, path, &sweep_metadata)?;
    }
    Ok(run)
}

pub(super) fn execute_bias_field_sweep_with_executor<F>(
    plan: &FemEigenPlanIR,
    mut execute_sample: F,
) -> Result<ExecutedRun, RunError>
where
    F: FnMut(&FemEigenPlanIR, usize) -> Result<ExecutedRun, RunError>,
{
    validate_bias_field_sweep_oracle_contract(plan)?;
    let samples = validate_bias_field_samples(plan)?;
    let base_initial_magnetization = plan.equilibrium_magnetization.clone();
    let mut previous_accepted_magnetization: Option<Vec<Vector3>> = None;

    let mut runs = Vec::with_capacity(samples.len());
    for (sample_position, sample) in samples.iter().enumerate() {
        let sample_plan = prepare_bias_field_sample_plan(
            plan,
            sample,
            &base_initial_magnetization,
            previous_accepted_magnetization.as_deref(),
        )?;
        let run = match execute_sample(&sample_plan, sample_position) {
            Ok(run) => run,
            Err(error) if runs.is_empty() => return Err(error),
            Err(error) => {
                return finalize_failed_bias_field_sweep(
                    runs,
                    samples.len(),
                    sample.equilibrium_policy,
                    sample.continuation_seed,
                    error,
                );
            }
        };
        if !bias_field_sample_is_complete(run.result.status) {
            runs.push(run);
            return merge_bias_field_sweep_runs(
                runs,
                samples.len(),
                sample.equilibrium_policy,
                sample.continuation_seed,
            );
        }
        if run.result.final_magnetization.len() != base_initial_magnetization.len()
            || run
                .result
                .final_magnetization
                .iter()
                .flatten()
                .any(|component| !component.is_finite())
        {
            let error = RunError {
                message: format!(
                    "FEM bias-field sweep sample {} did not produce a finite accepted equilibrium",
                    sample.sample_index
                ),
            };
            if runs.is_empty() {
                return Err(error);
            }
            return finalize_failed_bias_field_sweep(
                runs,
                samples.len(),
                sample.equilibrium_policy,
                sample.continuation_seed,
                error,
            );
        }
        previous_accepted_magnetization = Some(run.result.final_magnetization.clone());
        runs.push(run);
    }
    let first_sample = samples.first().ok_or_else(|| RunError {
        message: "bias-field sweep produced no declared samples".to_string(),
    })?;
    let mut merged = merge_bias_field_sweep_runs(
        runs,
        samples.len(),
        first_sample.equilibrium_policy,
        first_sample.continuation_seed,
    )?;
    append_physical_k0_kittel_artifacts(plan, &mut merged)?;
    Ok(merged)
}

fn append_physical_k0_kittel_artifacts(
    plan: &FemEigenPlanIR,
    run: &mut ExecutedRun,
) -> Result<(), RunError> {
    let Some(validation) = plan.k0_kittel_validation.as_ref() else {
        return Ok(());
    };
    if validation.kind != "k0_kittel_field_sweep"
        || validation.case_id.as_deref() != Some("K0-3")
        || validation.demag_kind.as_deref() != Some("periodic_airbox_k0")
    {
        return Ok(());
    }
    let parse = |path: &str| -> Result<serde_json::Value, RunError> {
        let artifact = run
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == path)
            .ok_or_else(|| RunError {
                message: format!("physical Kittel adapter is missing {path}"),
            })?;
        serde_json::from_slice(&artifact.bytes).map_err(|error| RunError {
            message: format!("physical Kittel adapter cannot parse {path}: {error}"),
        })
    };
    let spectrum = parse("eigen/spectrum.v2.json")?;
    let branches = parse("eigen/branches.v2.json")?;
    let diagnostics = parse("eigen/diagnostics/solver.v1.json")?;
    let airbox_size_m = physical_k0_airbox_size_m(plan)?;
    let generated =
        crate::eigen::artifacts::k0_kittel_validation_auxiliary_artifacts_from_bias_field_sweep(
            validation,
            &spectrum,
            &branches,
            &diagnostics,
            &run.auxiliary_artifacts,
            plan.hmax,
            airbox_size_m,
        )
        .map_err(|error| RunError {
            message: format!("physical Kittel postsolve adapter failed: {error}"),
        })?;
    run.auxiliary_artifacts.extend(generated);
    patch_physical_k0_kittel_manifest(run, validation)?;
    Ok(())
}

fn physical_k0_airbox_size_m(plan: &FemEigenPlanIR) -> Result<f64, RunError> {
    let factor = plan
        .air_box_config
        .as_ref()
        .map(|config| config.factor)
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| RunError {
            message: "physical Kittel adapter requires positive air_box_config.factor".to_string(),
        })?;
    let mut min_corner = [f64::INFINITY; 3];
    let mut max_corner = [f64::NEG_INFINITY; 3];
    for node in &plan.mesh.nodes {
        for axis in 0..3 {
            min_corner[axis] = min_corner[axis].min(node[axis]);
            max_corner[axis] = max_corner[axis].max(node[axis]);
        }
    }
    let max_extent = (0..3)
        .map(|axis| max_corner[axis] - min_corner[axis])
        .filter(|extent| extent.is_finite() && *extent > 0.0)
        .fold(0.0_f64, f64::max);
    if !(max_extent.is_finite() && max_extent > 0.0) {
        return Err(RunError {
            message: "physical Kittel adapter requires positive mesh extent".to_string(),
        });
    }
    Ok(max_extent * factor)
}

fn patch_physical_k0_kittel_manifest(
    run: &mut ExecutedRun,
    validation: &fullmag_ir::FemEigenK0KittelValidationIR,
) -> Result<(), RunError> {
    let Some(artifact) = run
        .auxiliary_artifacts
        .iter_mut()
        .find(|artifact| artifact.relative_path == "frequency_domain/manifest.v1.json")
    else {
        return Err(RunError {
            message: "physical Kittel adapter is missing frequency_domain/manifest.v1.json"
                .to_string(),
        });
    };
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&artifact.bytes).map_err(|error| RunError {
            message: format!(
                "physical Kittel adapter cannot parse frequency-domain manifest: {error}"
            ),
        })?;
    if let Some(object) = manifest.as_object_mut() {
        let index = object
            .entry("artifacts")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or_else(|| RunError {
                message: "frequency-domain manifest artifacts index is not an object".to_string(),
            })?;
        index.insert(
            "fmr_kittel_fit_v1_path".to_string(),
            serde_json::json!("fmr/kittel_fit.v1.json"),
        );
        index.insert(
            "kittel_validation_summary_path".to_string(),
            serde_json::json!("validation/kittel_k0_pbc/summary.v1.json"),
        );
        let validation_object = object
            .entry("validation")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .ok_or_else(|| RunError {
                message: "frequency-domain manifest validation index is not an object".to_string(),
            })?;
        validation_object.insert(
            "k0_kittel_validation".to_string(),
            serde_json::to_value(validation).map_err(|error| RunError {
                message: format!("failed to serialize Kittel validation metadata: {error}"),
            })?,
        );
        validation_object.insert(
            "k0_kittel_summary_path".to_string(),
            serde_json::json!("validation/kittel_k0_pbc/summary.v1.json"),
        );
    }
    artifact.bytes = serde_json::to_vec_pretty(&manifest).map_err(|error| RunError {
        message: format!("failed to serialize physical Kittel frequency-domain manifest: {error}"),
    })?;
    Ok(())
}

pub(super) fn execute_bias_field_sweep_with_planned_execution<F>(
    plan: &FemEigenPlanIR,
    resolution: &fullmag_ir::FemEigenExecutionResolutionIR,
    executor: F,
) -> Result<ExecutedRun, RunError>
where
    F: FnMut(&FemEigenPlanIR, usize) -> Result<ExecutedRun, RunError>,
{
    super::eigen_execution_resolution::validate_bias_field_sample_execution_resolutions(
        plan, resolution,
    )?;
    execute_bias_field_sweep_with_executor(plan, executor)
}

fn native_field_sweep_status(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Completed => "complete",
        RunStatus::Cancelled | RunStatus::Paused => "interrupted",
        RunStatus::Failed => "corrupt",
    }
}

fn native_field_sweep_stop_reason(status: RunStatus) -> Option<&'static str> {
    match status {
        RunStatus::Completed => None,
        RunStatus::Cancelled => Some("cancel_requested"),
        RunStatus::Paused => Some("pause_requested"),
        RunStatus::Failed => Some("failed"),
    }
}

fn required_string_from_json(
    value: &serde_json::Value,
    key: &str,
    context: &str,
) -> Result<String, RunError> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| RunError {
            message: format!("native field sweep requires {context}.{key}"),
        })
}

fn required_sha256_from_json(
    value: &serde_json::Value,
    key: &str,
    context: &str,
) -> Result<String, RunError> {
    let digest = required_string_from_json(value, key, context)?;
    if !is_sha256_digest(&digest) {
        return Err(RunError {
            message: format!("native field sweep requires {context}.{key} as sha256:<hex>"),
        });
    }
    Ok(digest)
}

fn native_field_sweep_execution(diagnostics: &serde_json::Value, key: &str) -> serde_json::Value {
    let mut execution = diagnostics.get(key).cloned().unwrap_or_else(|| {
        serde_json::json!({
            "backend": "fem",
            "device": "not_provided",
            "precision": "not_provided",
            "execution_mode": "modal",
            "engine": "not_provided",
            "implementation_id": null,
            "status": "source_artifact",
            "fallback_used": null,
            "fallback_reason": null,
        })
    });
    if let Some(object) = execution.as_object_mut() {
        let execution_mode_present = object
            .get("execution_mode")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| !value.is_empty());
        if !execution_mode_present {
            object.insert("execution_mode".to_string(), serde_json::json!("strict"));
        }
        let status_present = object
            .get("status")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| !value.is_empty());
        if !status_present {
            let status = if key == "requested_execution" {
                "requested"
            } else {
                "source_artifact"
            };
            object.insert("status".to_string(), serde_json::json!(status));
        }
    }
    execution
}

pub(super) fn native_field_sweep_content_digest(
    artifact: &serde_json::Value,
) -> Result<String, RunError> {
    let mut normalized = artifact.clone();
    let object = normalized.as_object_mut().ok_or_else(|| RunError {
        message: "native field sweep artifact must be a JSON object".to_string(),
    })?;
    object.insert(
        "revision".to_string(),
        serde_json::Value::String(String::new()),
    );
    object.insert(
        "content_sha256".to_string(),
        serde_json::Value::String(String::new()),
    );
    let bytes = serde_json::to_vec(&normalized).map_err(|error| RunError {
        message: format!("failed to serialize native field sweep digest envelope: {error}"),
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

pub(super) fn build_native_field_sweep_artifact(
    spectrum: &serde_json::Value,
    branches: &serde_json::Value,
    diagnostics: &serde_json::Value,
    artifacts: &[AuxiliaryArtifact],
    requested_sample_count: usize,
    sweep_status: RunStatus,
    sweep_stop_reason: Option<&str>,
) -> Result<serde_json::Value, RunError> {
    let spectrum_revision = published_artifact_sha256(artifacts, "eigen/spectrum.v2.json")?;
    let branches_revision = published_artifact_sha256(artifacts, "eigen/branches.v2.json")?;
    let samples = spectrum
        .get("samples")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| RunError {
            message: "native field sweep requires spectrum.samples".to_string(),
        })?;
    let mut branch_ids_by_mode = BTreeMap::<(u64, u64), u64>::new();
    for branch in branches
        .get("branches")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| RunError {
            message: "native field sweep requires branches.branches".to_string(),
        })?
    {
        let branch_id = branch
            .get("branch_id")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| RunError {
                message: "native field sweep requires integer branch_id".to_string(),
            })?;
        for point in branch
            .get("points")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| RunError {
                message: "native field sweep requires branch points".to_string(),
            })?
        {
            let sample_index = point
                .get("sample_index")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| RunError {
                    message: "native field sweep requires branch point sample_index".to_string(),
                })?;
            let raw_mode_index = point
                .get("raw_mode_index")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| RunError {
                    message: "native field sweep requires branch point raw_mode_index".to_string(),
                })?;
            if branch_ids_by_mode
                .insert((sample_index, raw_mode_index), branch_id)
                .is_some()
            {
                return Err(RunError {
                    message: "native field sweep rejects duplicate branch point mapping"
                        .to_string(),
                });
            }
        }
    }
    let status = native_field_sweep_status(sweep_status);
    let mut output_samples = Vec::with_capacity(samples.len());
    for sample in samples {
        let sample_index = sample
            .get("sample_index")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| RunError {
                message: "native field sweep requires spectrum sample_index".to_string(),
            })?;
        let field = sample
            .get("external_field_a_per_m")
            .and_then(serde_json::Value::as_array)
            .filter(|values| values.len() == 3)
            .ok_or_else(|| RunError {
                message: format!("native field sweep sample {sample_index} has no physical external_field_a_per_m"),
            })?;
        let mut bias_field_a_per_m = [0.0; 3];
        for (component_index, value) in field.iter().enumerate() {
            bias_field_a_per_m[component_index] = value.as_f64().filter(|value| value.is_finite()).ok_or_else(|| RunError {
                message: format!("native field sweep sample {sample_index} has non-finite external_field_a_per_m"),
            })?;
        }
        let topology = serde_json::json!({
            "mesh_id": required_string_from_json(sample, "mesh_id", "spectrum sample")?,
            "topology_revision": required_string_from_json(sample, "topology_revision", "spectrum sample")?,
            "indexing": "sample_index_then_raw_mode_index",
            "sample_axis": "sample_id",
            "mode_axis": "mode_id",
            "node_count": serde_json::Value::Null,
        });
        let sample_id = format!("bias-field-sample-{sample_index:04}");
        let sample_status = sample
            .get("status")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("complete");
        let sample_stop_reason =
            sample
                .get("stop_reason")
                .cloned()
                .unwrap_or(if sample_status == "complete" {
                    serde_json::Value::Null
                } else {
                    serde_json::json!(sweep_stop_reason.unwrap_or("incomplete"))
                });
        let modes = sample
            .get("modes")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| RunError {
                message: format!("native field sweep sample {sample_index} requires modes"),
            })?;
        let mut output_modes = Vec::new();
        let mut branch_ids = Vec::new();
        for mode in modes {
            let raw_mode_index = mode
                .get("raw_mode_index")
                .or_else(|| mode.get("index"))
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| RunError {
                    message: format!(
                        "native field sweep sample {sample_index} requires raw_mode_index"
                    ),
                })?;
            let Some(mode_field_id) = mode
                .get("mode_field_id")
                .and_then(serde_json::Value::as_str)
            else {
                continue;
            };
            let mode_field_resource_key =
                required_string_from_json(mode, "mode_field_resource_key", "spectrum mode")?;
            let branch_id = branch_ids_by_mode
                .get(&(sample_index, raw_mode_index))
                .copied()
                .ok_or_else(|| RunError {
                    message: format!("native field sweep sample {sample_index} mode {raw_mode_index} has no branch mapping"),
                })?;
            if !branch_ids.contains(&branch_id) {
                branch_ids.push(branch_id);
            }
            output_modes.push(serde_json::json!({
                "sample_id": sample_id,
                "mode_id": format!("sample-{sample_index:04}/mode-{raw_mode_index:04}"),
                "raw_mode_index": raw_mode_index,
                "branch_id": branch_id,
                "frequency_hz": mode.get("frequency_hz").cloned().unwrap_or(serde_json::Value::Null),
                "angular_frequency_rad_per_s": mode.get("angular_frequency_rad_per_s").cloned().unwrap_or(serde_json::Value::Null),
                "mode_artifact_path": mode_metadata_path(sample_index as usize, raw_mode_index),
                "mode_field_id": mode_field_id,
                "mode_field_resource_key": mode_field_resource_key,
                "residual_relative_l2": mode.get("residual_relative_l2").cloned().unwrap_or(serde_json::Value::Null),
                "source_revision": spectrum_revision,
                "status": sample_status,
            }));
        }
        let first_mode = modes.first().ok_or_else(|| RunError {
            message: format!("native field sweep sample {sample_index} has no modes"),
        })?;
        output_samples.push(serde_json::json!({
            "sample_id": sample_id,
            "sample_index": sample_index,
            "scan_axis": {
                "kind": "bias_field",
                "coordinate": "bias_field_a_per_m",
                "unit": "A/m",
                "display_conversions": [{"name": "mu0_h", "unit": "T", "scale": MU0}],
            },
            "bias_field_a_per_m": bias_field_a_per_m,
            "bias_field_mu0_t": bias_field_a_per_m.map(|value| value * MU0),
            "equilibrium_artifact_sha256": required_sha256_from_json(first_mode, "equilibrium_artifact_sha256", "spectrum mode")?,
            "linearization_state_sha256": required_sha256_from_json(first_mode, "linearization_state_sha256", "spectrum mode")?,
            "operator_input_signature_sha256": required_sha256_from_json(first_mode, "operator_input_signature_sha256", "spectrum mode")?,
            "topology": topology,
            "branch_ids": branch_ids,
            "modes": output_modes,
            "status": sample_status,
            "stop_reason": sample_stop_reason,
        }));
    }
    let topology = output_samples
        .first()
        .and_then(|sample| sample.get("topology"))
        .cloned()
        .unwrap_or_else(|| {
            serde_json::json!({
                "mesh_id": "topology:not_provided",
                "topology_revision": "topology:not_provided",
                "indexing": "sample_index_then_raw_mode_index",
                "sample_axis": "sample_id",
                "mode_axis": "mode_id",
                "node_count": null,
            })
        });
    let completed_sample_count = output_samples
        .iter()
        .filter(|sample| sample.get("status") == Some(&serde_json::json!("complete")))
        .count();
    let complete = sweep_status == RunStatus::Completed
        && completed_sample_count == requested_sample_count
        && output_samples.len() == requested_sample_count;
    let mut artifact = serde_json::json!({
        "schema_version": "eigen/field_sweep.v1",
        "artifact_id": "analysis:eigen:field-sweep",
        "source": {"kind": "modal_eigensolve", "artifact": "eigen/spectrum.v2.json", "revision": spectrum_revision},
        "source_revision": spectrum_revision,
        "run_id": "run:current",
        "stage_id": "stage:eigenmodes",
        "scope_id": "scope:bias-field",
        "runtime_id": "runtime:native-fem",
        "revision": "",
        "content_sha256": "",
        "status": status,
        "complete": complete,
        "interrupted": status == "interrupted",
        "stop_reason": if complete { serde_json::Value::Null } else { serde_json::json!(sweep_stop_reason.unwrap_or("incomplete")) },
        "requested_sample_count": requested_sample_count,
        "completed_sample_count": completed_sample_count,
        "scan_axis": {"kind": "bias_field", "coordinate": "bias_field_a_per_m", "unit": "A/m", "display_conversions": [{"name": "mu0_h", "unit": "T", "scale": MU0}]},
        "units": {"frequency": "Hz", "angular_frequency": "rad/s", "bias_field": "A/m", "bias_field_display": "mu0 H (T)", "response_amplitude": null, "linewidth": null, "q_factor": null, "covariance": null},
        "topology": topology,
        "requested_execution": native_field_sweep_execution(diagnostics, "requested_execution"),
        "resolved_execution": native_field_sweep_execution(diagnostics, "resolved_execution"),
        "samples": output_samples,
        "cross_artifact_refs": [
            {"relation": "source_spectrum", "artifact": "eigen/spectrum.v2.json", "revision": spectrum_revision},
            {"relation": "source_branches", "artifact": "eigen/branches.v2.json", "revision": branches_revision},
        ],
    });
    let content_digest = native_field_sweep_content_digest(&artifact)?;
    let object = artifact.as_object_mut().ok_or_else(|| RunError {
        message: "native field sweep artifact must be a JSON object".to_string(),
    })?;
    object.insert("revision".to_string(), serde_json::json!(content_digest));
    object.insert(
        "content_sha256".to_string(),
        serde_json::json!(content_digest),
    );
    Ok(artifact)
}

pub(super) fn merge_bias_field_sweep_runs(
    runs: Vec<ExecutedRun>,
    sample_count: usize,
    equilibrium_policy: fullmag_ir::BiasFieldSweepEquilibriumPolicyIR,
    continuation_seed: fullmag_ir::BiasFieldSweepContinuationSeedIR,
) -> Result<ExecutedRun, RunError> {
    merge_bias_field_sweep_runs_with_terminal(
        runs,
        sample_count,
        equilibrium_policy,
        continuation_seed,
        None,
    )
}

pub(super) fn finalize_failed_bias_field_sweep(
    runs: Vec<ExecutedRun>,
    sample_count: usize,
    equilibrium_policy: fullmag_ir::BiasFieldSweepEquilibriumPolicyIR,
    continuation_seed: fullmag_ir::BiasFieldSweepContinuationSeedIR,
    error: RunError,
) -> Result<ExecutedRun, RunError> {
    if error.message.trim().is_empty() {
        return Err(error);
    }
    merge_bias_field_sweep_runs_with_terminal(
        runs,
        sample_count,
        equilibrium_policy,
        continuation_seed,
        Some((RunStatus::Failed, error.message)),
    )
}

fn merge_bias_field_sweep_runs_with_terminal(
    runs: Vec<ExecutedRun>,
    sample_count: usize,
    equilibrium_policy: fullmag_ir::BiasFieldSweepEquilibriumPolicyIR,
    continuation_seed: fullmag_ir::BiasFieldSweepContinuationSeedIR,
    terminal: Option<(RunStatus, String)>,
) -> Result<ExecutedRun, RunError> {
    let mut runs = runs.into_iter();
    let first_run = runs.next().ok_or_else(|| RunError {
        message: "bias-field sweep produced no sample runs".to_string(),
    })?;
    let mut all_runs = Vec::with_capacity(sample_count.max(1));
    all_runs.push(first_run);
    all_runs.extend(runs);
    let inferred_sweep_status = all_runs
        .iter()
        .find_map(|run| (run.result.status != RunStatus::Completed).then_some(run.result.status))
        .unwrap_or(RunStatus::Completed);
    let sweep_status = terminal
        .as_ref()
        .map(|(status, _)| *status)
        .unwrap_or(inferred_sweep_status);
    let sweep_complete = sweep_status == RunStatus::Completed
        && all_runs
            .iter()
            .all(|run| run.result.status == RunStatus::Completed);
    let sweep_status_label = run_status_label(sweep_status);
    let artifact_status_label = native_field_sweep_status(sweep_status);
    let sweep_stop_reason = terminal
        .as_ref()
        .map(|(_, stop_reason)| stop_reason.as_str())
        .or_else(|| native_field_sweep_stop_reason(sweep_status));
    let completed_sample_count = all_runs
        .iter()
        .filter(|run| run.result.status == RunStatus::Completed)
        .count();

    let mut spectrum_samples = Vec::new();
    let mut branch_points = BTreeMap::<u64, Vec<serde_json::Value>>::new();
    let mut branch_templates = BTreeMap::<u64, serde_json::Value>::new();
    let mut summary_modes = Vec::new();
    let mut sample_solver_diagnostics = Vec::new();
    let mut summary_template = None;
    let mut solver_diagnostics_template = None;
    let mut manifest_template = None;
    let mut artifacts = Vec::new();
    let mut artifact_paths = std::collections::BTreeSet::new();

    for run in &all_runs {
        let include_completed_sample = run.result.status == RunStatus::Completed;
        for artifact in &run.auxiliary_artifacts {
            match artifact.relative_path.as_str() {
                "eigen/spectrum.v2.json" => {
                    let spectrum = parse_sweep_artifact(artifact, "eigen/spectrum.v2.json")?;
                    if include_completed_sample {
                        if let Some(samples) = spectrum.get("samples").and_then(|v| v.as_array()) {
                            spectrum_samples.extend(samples.iter().cloned().map(|mut sample| {
                                if let Some(object) = sample.as_object_mut() {
                                    object.insert(
                                        "status".to_string(),
                                        serde_json::json!("complete"),
                                    );
                                    object
                                        .insert("stop_reason".to_string(), serde_json::Value::Null);
                                }
                                sample
                            }));
                        }
                    }
                }
                "eigen/branches.v2.json" => {
                    let branches = parse_sweep_artifact(artifact, "eigen/branches.v2.json")?;
                    if include_completed_sample {
                        if let Some(entries) = branches.get("branches").and_then(|v| v.as_array()) {
                            for branch in entries {
                                let branch_id = branch
                                    .get("branch_id")
                                    .and_then(serde_json::Value::as_u64)
                                    .unwrap_or(0);
                                branch_templates
                                    .entry(branch_id)
                                    .or_insert_with(|| branch.clone());
                                if let Some(points) =
                                    branch.get("points").and_then(|v| v.as_array())
                                {
                                    branch_points
                                        .entry(branch_id)
                                        .or_default()
                                        .extend(points.iter().cloned());
                                }
                            }
                        }
                    }
                }
                "eigen/metadata/eigen_summary.json" => {
                    let summary =
                        parse_sweep_artifact(artifact, "eigen/metadata/eigen_summary.json")?;
                    if summary_template.is_none() {
                        summary_template = Some(summary.clone());
                    }
                    if include_completed_sample {
                        if let Some(modes) = summary.get("modes").and_then(|v| v.as_array()) {
                            summary_modes.extend(modes.iter().cloned());
                        }
                    }
                    if let Some(diagnostics) = summary.get("solver_diagnostics") {
                        sample_solver_diagnostics.push(serde_json::json!({
                            "sample_index": sample_solver_diagnostics.len(),
                            "diagnostics": diagnostics,
                        }));
                    }
                }
                "eigen/diagnostics/solver.v1.json" => {
                    if solver_diagnostics_template.is_none() {
                        solver_diagnostics_template = Some(parse_sweep_artifact(
                            artifact,
                            "eigen/diagnostics/solver.v1.json",
                        )?);
                    }
                }
                "frequency_domain/manifest.v1.json" => {
                    if manifest_template.is_none() {
                        manifest_template = Some(parse_sweep_artifact(
                            artifact,
                            "frequency_domain/manifest.v1.json",
                        )?);
                    }
                }
                "eigen/spectrum.json"
                | "eigen/dispersion.csv"
                | "eigen/dispersion/branch_table.csv" => {}
                _ => {
                    if !include_completed_sample
                        && (artifact.relative_path.starts_with("eigen/modes/")
                            || artifact.relative_path.starts_with("eigen/mode_fields"))
                    {
                        continue;
                    }
                    if artifact_paths.insert(artifact.relative_path.clone()) {
                        artifacts.push(artifact.clone());
                    }
                }
            }
        }
    }

    spectrum_samples.sort_by_key(|sample| {
        sample
            .get("sample_index")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0)
    });
    let published_mode_count = spectrum_samples
        .iter()
        .filter_map(|sample| sample.get("modes").and_then(|v| v.as_array()))
        .map(Vec::len)
        .max()
        .unwrap_or(0);

    let mut branches = Vec::new();
    for (branch_id, template) in branch_templates {
        let mut branch = template;
        if let Some(object) = branch.as_object_mut() {
            let mut points = branch_points.remove(&branch_id).unwrap_or_default();
            points.sort_by_key(|point| {
                point
                    .get("sample_index")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0)
            });
            object.insert("points".to_string(), serde_json::Value::Array(points));
        }
        branches.push(branch);
    }
    branches.sort_by_key(|branch| {
        branch
            .get("branch_id")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0)
    });

    let spectrum = serde_json::json!({
        "schema_version": "eigen_spectrum.v2",
        "solver_model": summary_template
            .as_ref()
            .and_then(|value| value.get("solver_kind"))
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        "sample_count": spectrum_samples.len(),
        "mode_count": published_mode_count,
        "status": sweep_status_label,
        "complete": sweep_complete,
        "samples": spectrum_samples,
    });

    let mut summary = summary_template.ok_or_else(|| RunError {
        message: "bias-field sweep is missing eigen_summary.json".to_string(),
    })?;
    let mut diagnostics = solver_diagnostics_template
        .or_else(|| summary.get("solver_diagnostics").cloned())
        .ok_or_else(|| RunError {
            message: "bias-field sweep is missing solver diagnostics".to_string(),
        })?;
    if let Some(object) = diagnostics.as_object_mut() {
        object.insert("sample_count".to_string(), serde_json::json!(sample_count));
        object.insert(
            "mode_count".to_string(),
            serde_json::json!(published_mode_count),
        );
        object.insert(
            "sample_solver_diagnostics".to_string(),
            serde_json::Value::Array(sample_solver_diagnostics),
        );
        object.insert(
            "field_sweep".to_string(),
            serde_json::json!({
                "kind": "bias_field_sweep",
                "source": "bias_field_samples",
                "postsolve_oracle": "none",
                "sample_count": sample_count,
                "requested_sample_count": sample_count,
                "completed_sample_count": completed_sample_count,
                "status": artifact_status_label,
                "run_status": sweep_status_label,
                "stop_reason": sweep_stop_reason,
                "complete": sweep_complete,
                "independent_solves": true,
                "equilibrium_policy": bias_field_equilibrium_policy_label(equilibrium_policy),
                "continuation_seed": bias_field_continuation_seed_label(continuation_seed),
                "continuation_seed_scope": "first_sample_bootstrap",
            }),
        );
        object.insert(
            "status".to_string(),
            serde_json::json!(artifact_status_label),
        );
        object.insert("complete".to_string(), serde_json::json!(sweep_complete));
    }
    if let Some(object) = summary.as_object_mut() {
        object.insert(
            "mode_count".to_string(),
            serde_json::json!(summary_modes.len()),
        );
        object.insert("modes".to_string(), serde_json::Value::Array(summary_modes));
        object.insert("solver_diagnostics".to_string(), diagnostics.clone());
        object.insert("sample_count".to_string(), serde_json::json!(sample_count));
        object.insert(
            "status".to_string(),
            serde_json::json!(artifact_status_label),
        );
        object.insert("complete".to_string(), serde_json::json!(sweep_complete));
    }

    artifacts.push(json_artifact("eigen/spectrum.v2.json", &spectrum)?);
    artifacts.push(json_artifact("eigen/spectrum.json", &summary)?);
    artifacts.push(json_artifact(
        "eigen/metadata/eigen_summary.json",
        &summary,
    )?);
    artifacts.push(json_artifact(
        "eigen/diagnostics/solver.v1.json",
        &diagnostics,
    )?);
    let branches_payload = serde_json::json!({
        "schema_version": "eigen_branches.v2",
        "solver_model": summary["solver_kind"],
        "tracking_score_source": "seed_only",
        "modal_overlap_available": false,
        "branches": branches,
        "diagnostics": {
            "tracking_score_source": "seed_only",
            "modal_overlap_available": false,
            "status": sweep_status_label,
            "complete": sweep_complete,
        },
    });
    artifacts.push(json_artifact("eigen/branches.v2.json", &branches_payload)?);
    let field_sweep = build_native_field_sweep_artifact(
        &spectrum,
        &branches_payload,
        &diagnostics,
        &artifacts,
        sample_count,
        sweep_status,
        sweep_stop_reason,
    )?;
    artifacts.push(json_artifact("eigen/field_sweep.v1.json", &field_sweep)?);

    let mut manifest = update_sweep_manifest(
        manifest_template.ok_or_else(|| RunError {
            message: "bias-field sweep is missing frequency-domain manifest".to_string(),
        })?,
        &artifacts,
        &diagnostics,
        sample_count,
    )?;
    if let Some(artifact_index) = manifest
        .get_mut("artifacts")
        .and_then(serde_json::Value::as_object_mut)
    {
        artifact_index.insert(
            "field_sweep_v1_path".to_string(),
            serde_json::json!("eigen/field_sweep.v1.json"),
        );
    }
    if let Some(resources) = manifest
        .get_mut("resources")
        .and_then(serde_json::Value::as_object_mut)
    {
        resources.insert(
            "field_sweep_resource_key".to_string(),
            serde_json::json!(
                "/v2/sessions/current/analysis/frequency-domain/eigen/field-sweep.v1"
            ),
        );
    }
    artifacts.push(json_artifact(
        "frequency_domain/manifest.v1.json",
        &manifest,
    )?);

    let mut dispersion = String::from(
        "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,line_width_hz,residual_norm,overlap_score,tracking_score_source,mode_field_id,mode_field_resource_key\n",
    );
    for sample in spectrum["samples"].as_array().into_iter().flatten() {
        let sample_index = sample["sample_index"].as_u64().unwrap_or(0);
        let path_s = sample["path_s"].as_f64().unwrap_or(0.0);
        let label = sample["label"].as_str().unwrap_or("");
        let k = sample["k_vector"].as_array();
        let kx = k
            .and_then(|v| v.first())
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let ky = k
            .and_then(|v| v.get(1))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let kz = k
            .and_then(|v| v.get(2))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        for mode in sample["modes"].as_array().into_iter().flatten() {
            let raw_mode_index = mode["raw_mode_index"].as_u64().unwrap_or(0);
            dispersion.push_str(&format!(
                "{sample_index},{path_s:.16e},{kx:.16e},{ky:.16e},{kz:.16e},{label},{raw_mode_index},{},{:.16e},{:.16e},{},{},{},seed,{},{}\n",
                mode["branch_id"].as_u64().unwrap_or(raw_mode_index),
                mode["frequency_hz"].as_f64().unwrap_or(0.0),
                mode["angular_frequency_rad_per_s"].as_f64().unwrap_or(0.0),
                mode["frequency_imag_hz"].as_f64().map(|v| 2.0 * v).unwrap_or(0.0),
                mode["residual_norm"].as_f64().unwrap_or(0.0),
                "",
                mode["mode_field_id"].as_str().unwrap_or(""),
                mode["mode_field_resource_key"].as_str().unwrap_or(""),
            ));
        }
    }
    let dispersion_bytes = dispersion.into_bytes();
    artifacts.push(AuxiliaryArtifact {
        relative_path: "eigen/dispersion.csv".to_string(),
        bytes: dispersion_bytes.clone(),
    });
    artifacts.push(AuxiliaryArtifact {
        relative_path: "eigen/dispersion/branch_table.csv".to_string(),
        bytes: dispersion_bytes,
    });

    let mut result = all_runs.last().cloned().ok_or_else(|| RunError {
        message: "bias-field sweep lost its final sample".to_string(),
    })?;
    if result.result.status != sweep_status {
        result.result.status = sweep_status;
        result.result.completion = Some(crate::relaxation::resolve_stage_completion(
            sweep_status,
            None,
            crate::relaxation::RelaxationCompletionMetrics::default(),
        ));
    }
    result.initial_magnetization = all_runs
        .first()
        .map(|run| run.initial_magnetization.clone())
        .unwrap_or_default();
    result.result.steps = all_runs
        .iter()
        .flat_map(|run| run.result.steps.clone())
        .collect();
    result.auxiliary_artifacts = artifacts;
    Ok(result)
}

fn parse_sweep_artifact(
    artifact: &AuxiliaryArtifact,
    path: &str,
) -> Result<serde_json::Value, RunError> {
    serde_json::from_slice(&artifact.bytes).map_err(|error| RunError {
        message: format!("failed to parse {path} while merging bias-field sweep: {error}"),
    })
}

pub(super) fn run_status_label(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Completed => "completed",
        RunStatus::Failed => "failed",
        RunStatus::Cancelled => "cancelled",
        RunStatus::Paused => "paused",
    }
}

fn bias_field_equilibrium_policy_label(
    policy: fullmag_ir::BiasFieldSweepEquilibriumPolicyIR,
) -> &'static str {
    match policy {
        fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::RelaxEach => "relax_each",
        fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::Continuation => "continuation",
    }
}

fn bias_field_continuation_seed_label(
    seed: fullmag_ir::BiasFieldSweepContinuationSeedIR,
) -> &'static str {
    match seed {
        fullmag_ir::BiasFieldSweepContinuationSeedIR::PreviousAcceptedEquilibrium => {
            "previous_accepted_equilibrium"
        }
        fullmag_ir::BiasFieldSweepContinuationSeedIR::InitialState => "initial_state",
    }
}

fn update_sweep_manifest(
    mut manifest: serde_json::Value,
    artifacts: &[AuxiliaryArtifact],
    diagnostics: &serde_json::Value,
    sample_count: usize,
) -> Result<serde_json::Value, RunError> {
    let mode_metadata_paths: Vec<String> = artifacts
        .iter()
        .filter(|artifact| {
            artifact.relative_path.starts_with("eigen/modes/sample_")
                && artifact.relative_path.ends_with(".json")
        })
        .map(|artifact| artifact.relative_path.clone())
        .collect();
    let mode_field_resources: Vec<String> = artifacts
        .iter()
        .filter_map(|artifact| {
            if !artifact.relative_path.starts_with("eigen/modes/sample_") {
                return None;
            }
            let metadata = serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok()?;
            let sample_index = metadata.get("sample_index").and_then(|value| value.as_u64())?;
            let raw_mode_index = metadata
                .get("raw_mode_index")
                .and_then(|value| value.as_u64())?;
            // `mode_field_resources` is the analysis metadata endpoint, not
            // the data-field vector endpoint carried by mode_field_resource_key.
            Some(format!(
                "/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/{sample_index}/{raw_mode_index}/meta"
            ))
        })
        .collect();
    if let Some(object) = manifest.as_object_mut() {
        object.insert("sample_count".to_string(), serde_json::json!(sample_count));
        object.insert(
            "diagnostics".to_string(),
            serde_json::json!({
                "tracking_score_source": "seed_only",
                "modal_overlap_available": false,
            }),
        );
        if let Some(artifacts_object) = object
            .get_mut("artifacts")
            .and_then(serde_json::Value::as_object_mut)
        {
            artifacts_object.insert(
                "mode_metadata_paths".to_string(),
                serde_json::json!(mode_metadata_paths),
            );
        }
        if let Some(resources_object) = object
            .get_mut("resources")
            .and_then(serde_json::Value::as_object_mut)
        {
            resources_object.insert(
                "mode_field_resources".to_string(),
                serde_json::json!(mode_field_resources),
            );
        }
        if let Some(diagnostics_object) = diagnostics.as_object() {
            for key in [
                "sample_count",
                "field_sweep",
                "mode_count",
                "status",
                "complete",
            ] {
                if let Some(value) = diagnostics_object.get(key) {
                    object.insert(key.to_string(), value.clone());
                }
            }
        }
    }
    Ok(manifest)
}
