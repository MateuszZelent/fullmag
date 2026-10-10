//! Process boundary for one independent FEM eigen `k` point.
//!
//! MFEM/PETSc/SLEPc state is deliberately created and destroyed inside the
//! child process.  The request contains only serializable plan data and an
//! immutable equilibrium-artifact reference; a native context or a Rust
//! relaxation handoff never crosses this boundary.

use super::eigen_execution_resolution::resolve_fem_eigen_execution_resolution;
use crate::fem_eigen;
use crate::types::{AuxiliaryArtifact, RunError};
use fullmag_ir::{
    EquilibriumSourceIR, FemEigenExecutionResolutionIR, FemEigenPlanIR, OutputIR,
    ParallelExecutionPolicyIR,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::Instant;

pub const EIGEN_K_WORKER_PROTOCOL_V1: &str = "fullmag.eigen_k_worker.v1";
pub const EIGEN_K_WORKER_PROTOCOL_V2: &str = "fullmag.eigen_k_worker.v2";
pub(crate) const EIGEN_K_WORKER_HANDSHAKE_V1: &str = "fullmag.eigen_k_worker.handshake.v1";

/// Parent/child identity binding written beside each private request.
///
/// The request itself is deliberately kept compatible with the canonical
/// `eigen_k_pool` producer.  This sidecar is the process-boundary part of
/// that request: it pins the exact sibling executable and build identity and
/// is checked again by the child before any native state is created.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EigenKWorkerHandshakeV1 {
    pub protocol: String,
    pub request_index: usize,
    pub sample_index: usize,
    pub executable_sha256: String,
    pub build_identity: serde_json::Value,
    pub expected_plan_sha256: String,
    pub expected_equilibrium_artifact_sha256: String,
}

/// Thread budget resolved by the parent admission controller for one child.
/// The requested value stays visible so a run cannot silently turn a user
/// policy into a different execution contract.  The resolved value is always
/// bounded by the allocation/host cap before it reaches the native runtime.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EigenKWorkerThreadBudgetV1 {
    pub requested_threads: u32,
    pub resolved_threads: u32,
    pub cap_reason: String,
    pub allocation_cpu_cores: f64,
    pub host_cpu_cores: u32,
}

/// JSON request consumed by the hidden `__eigen-k-worker` CLI command.
///
/// `plan.equilibrium` must point at a certified v7/v8 artifact.  This is an
/// intentional trust boundary: a child can reload and independently verify
/// the artifact, while a private `AcceptedFemRelaxStageHandoff` cannot be
/// serialized or forged by a caller.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EigenKWorkerRequestV1 {
    pub protocol: String,
    pub plan: FemEigenPlanIR,
    pub outputs: Vec<OutputIR>,
    pub execution: FemEigenExecutionResolutionIR,
    pub parallel_policy: ParallelExecutionPolicyIR,
    pub thread_budget: EigenKWorkerThreadBudgetV1,
    pub sample_index: usize,
    pub k_vector: [f64; 3],
    pub expected_plan_sha256: String,
    pub expected_equilibrium_artifact_sha256: String,
    pub artifact_dir: PathBuf,
    pub response_path: PathBuf,
    #[serde(default)]
    pub cancel_path: Option<PathBuf>,
}

/// V2 separates all-candidate tracking outputs from the public per-sample
/// selector used to generate physical-potential sidecars.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EigenKWorkerRequestV2 {
    pub protocol: String,
    pub plan: FemEigenPlanIR,
    pub outputs: Vec<OutputIR>,
    pub publication_outputs: Vec<OutputIR>,
    pub sample_label: Option<String>,
    pub execution: FemEigenExecutionResolutionIR,
    pub parallel_policy: ParallelExecutionPolicyIR,
    pub thread_budget: EigenKWorkerThreadBudgetV1,
    pub sample_index: usize,
    pub k_vector: [f64; 3],
    pub expected_plan_sha256: String,
    pub expected_equilibrium_artifact_sha256: String,
    pub artifact_dir: PathBuf,
    pub response_path: PathBuf,
    #[serde(default)]
    pub cancel_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EigenKWorkerArtifactV1 {
    pub relative_path: String,
    pub path: PathBuf,
    pub byte_len: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EigenKWorkerRunV1 {
    pub status: crate::types::RunStatus,
    pub final_magnetization: Vec<[f64; 3]>,
    pub plan_sha256: String,
    pub equilibrium_artifact_sha256: String,
    pub thread_budget: EigenKWorkerThreadBudgetV1,
    pub artifacts: Vec<EigenKWorkerArtifactV1>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EigenKWorkerResponseV1 {
    pub protocol: String,
    pub sample_index: usize,
    pub worker_request_index: usize,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_executable_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_build_identity: Option<serde_json::Value>,
    /// Terminal cost measured immediately before publishing the response.
    /// CPU is the execution-interval average `(user+system) / wall_time`,
    /// not an instantaneous peak; RSS is the process `ru_maxrss` high-water mark. It is independent of the parent's
    /// periodic /proc samples and is required for adaptive calibration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_peak: Option<crate::adaptive_resources::WorkerPeak>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<EigenKWorkerRunV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl EigenKWorkerRequestV1 {
    pub fn validate(&self) -> Result<(), RunError> {
        if self.protocol != EIGEN_K_WORKER_PROTOCOL_V1 {
            return Err(RunError {
                message: format!(
                    "eigen k worker protocol mismatch: expected {EIGEN_K_WORKER_PROTOCOL_V1}, got {}",
                    self.protocol
                ),
            });
        }
        if self.k_vector.iter().any(|value| !value.is_finite()) {
            return Err(RunError {
                message: "eigen k worker k_vector must be finite".to_string(),
            });
        }
        self.parallel_policy
            .validate()
            .map_err(|message| RunError { message })?;
        if !matches!(
            self.parallel_policy.mode,
            fullmag_ir::ParallelExecutionModeIR::Adaptive
                | fullmag_ir::ParallelExecutionModeIR::Serial
        ) {
            return Err(RunError {
                message: "eigen k worker requires serial or adaptive parallel_execution policy"
                    .into(),
            });
        }
        let budget = &self.thread_budget;
        let parent_admission_pending = budget.cap_reason == "parent_admission_pending";
        if budget.requested_threads != self.parallel_policy.threads_per_worker
            || budget.resolved_threads == 0
            || budget.resolved_threads > budget.requested_threads
            || budget.cap_reason.trim().is_empty()
            || !budget.allocation_cpu_cores.is_finite()
            || budget.allocation_cpu_cores <= 0.0
            || budget.host_cpu_cores == 0
            || (parent_admission_pending && budget.resolved_threads != 1)
        {
            return Err(RunError {
                message: "eigen k worker has an invalid resolved thread budget".into(),
            });
        }
        let host_threads = std::thread::available_parallelism()
            .map(|value| value.get())
            .unwrap_or(1);
        if !parent_admission_pending
            && usize::try_from(budget.resolved_threads).unwrap_or(usize::MAX) > host_threads
        {
            return Err(RunError {
                message: format!(
                    "eigen k worker resolved thread budget {} exceeds host parallelism {}",
                    budget.resolved_threads, host_threads
                ),
            });
        }
        if !is_sha256_digest(&self.expected_plan_sha256)
            || !is_sha256_digest(&self.expected_equilibrium_artifact_sha256)
        {
            return Err(RunError {
                message: "eigen k worker requires sha256-bound plan and equilibrium inputs".into(),
            });
        }
        if self.plan.bias_field_samples.len() != 0 {
            return Err(RunError {
                message: "adaptive eigen k worker rejects bias_field_samples; continuation remains serial"
                    .to_string(),
            });
        }
        if !matches!(self.plan.equilibrium, EquilibriumSourceIR::Artifact { .. }) {
            return Err(RunError {
                message: "adaptive eigen k worker requires an immutable certified equilibrium Artifact; relaxation handoffs are process-local"
                    .to_string(),
            });
        }
        if self.artifact_dir.as_os_str().is_empty() || self.response_path.as_os_str().is_empty() {
            return Err(RunError {
                message: "eigen k worker requires non-empty artifact and response paths".into(),
            });
        }
        if self
            .plan
            .mesh
            .nodes
            .iter()
            .flat_map(|node| node.iter())
            .any(|value| !value.is_finite())
        {
            return Err(RunError {
                message: "eigen k worker plan contains non-finite mesh coordinates".into(),
            });
        }
        Ok(())
    }
}

impl EigenKWorkerRequestV2 {
    pub fn validate(&self) -> Result<(), RunError> {
        if self.protocol != EIGEN_K_WORKER_PROTOCOL_V2 {
            return Err(RunError {
                message: format!(
                    "eigen k worker protocol mismatch: expected {EIGEN_K_WORKER_PROTOCOL_V2}, got {}",
                    self.protocol
                ),
            });
        }
        let legacy = self.clone().into_v1();
        legacy.validate()?;
        crate::eigen::output_selection::validate_eigen_spectrum_quantities(
            &self.publication_outputs,
        )
        .map_err(|error| RunError {
            message: format!("invalid eigen publication selector: {error}"),
        })
    }

    fn potential_publication(&self) -> super::eigen_path::EigenPathPotentialPublication {
        super::eigen_path::EigenPathPotentialPublication {
            outputs: self.publication_outputs.clone(),
            sample_index: self.sample_index,
            sample_label: self.sample_label.clone(),
        }
    }

    fn into_v1(self) -> EigenKWorkerRequestV1 {
        EigenKWorkerRequestV1 {
            protocol: EIGEN_K_WORKER_PROTOCOL_V1.to_string(),
            plan: self.plan,
            outputs: self.outputs,
            execution: self.execution,
            parallel_policy: self.parallel_policy,
            thread_budget: self.thread_budget,
            sample_index: self.sample_index,
            k_vector: self.k_vector,
            expected_plan_sha256: self.expected_plan_sha256,
            expected_equilibrium_artifact_sha256: self.expected_equilibrium_artifact_sha256,
            artifact_dir: self.artifact_dir,
            response_path: self.response_path,
            cancel_path: self.cancel_path,
        }
    }
}

fn is_sha256_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes);
    format!("sha256:{:x}", digest.finalize())
}

pub(crate) fn executable_sha256(path: &Path) -> Result<String, RunError> {
    let bytes = fs::read(path).map_err(|error| RunError {
        message: format!("read worker executable for identity: {error}"),
    })?;
    Ok(sha256_bytes(&bytes))
}

pub(crate) fn build_identity_json() -> serde_json::Value {
    let identity = fullmag_build_info::identity();
    serde_json::json!({
        "built_at_utc": identity.built_at_utc,
        "git_commit": identity.git_commit,
        "worktree_state": identity.worktree_state,
        "source_snapshot_sha256": identity.source_snapshot_sha256,
    })
}

fn current_worker_identity() -> Result<(String, serde_json::Value), RunError> {
    let executable = std::env::current_exe()
        .map_err(|error| RunError {
            message: format!("resolve current eigen worker executable: {error}"),
        })?
        .canonicalize()
        .map_err(|error| RunError {
            message: format!("canonicalize current eigen worker executable: {error}"),
        })?;
    Ok((executable_sha256(&executable)?, build_identity_json()))
}

#[cfg(unix)]
#[derive(Debug)]
struct TerminalMeasurementStart {
    usage: libc::rusage,
    started_at: Instant,
}

#[cfg(not(unix))]
#[derive(Debug)]
struct TerminalMeasurementStart {
    started_at: Instant,
}

#[cfg(unix)]
fn read_self_usage() -> Result<libc::rusage, RunError> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    if result != 0 {
        return Err(RunError {
            message: format!(
                "read terminal eigen worker resource usage: {}",
                std::io::Error::last_os_error()
            ),
        });
    }
    Ok(unsafe { usage.assume_init() })
}

#[cfg(unix)]
fn timeval_seconds(value: libc::timeval) -> f64 {
    value.tv_sec as f64 + value.tv_usec as f64 * 1e-6
}

fn terminal_measurement_start() -> Result<TerminalMeasurementStart, RunError> {
    #[cfg(unix)]
    {
        return Ok(TerminalMeasurementStart {
            usage: read_self_usage()?,
            started_at: Instant::now(),
        });
    }
    #[cfg(not(unix))]
    {
        Err(RunError {
            message: "terminal eigen worker resource usage requires a Unix getrusage runtime"
                .into(),
        })
    }
}

fn terminal_measurement_finish(
    start: &TerminalMeasurementStart,
) -> Result<crate::adaptive_resources::WorkerPeak, RunError> {
    #[cfg(unix)]
    {
        let end = read_self_usage()?;
        let wall_seconds = start.started_at.elapsed().as_secs_f64();
        let cpu_seconds = (timeval_seconds(end.ru_utime) + timeval_seconds(end.ru_stime)
            - timeval_seconds(start.usage.ru_utime)
            - timeval_seconds(start.usage.ru_stime))
        .max(0.0);
        if !wall_seconds.is_finite() || wall_seconds <= 0.0 || !cpu_seconds.is_finite() {
            return Err(RunError {
                message: "terminal eigen worker resource interval is invalid".into(),
            });
        }
        #[cfg(target_os = "linux")]
        let rss_bytes = u64::try_from(end.ru_maxrss)
            .ok()
            .and_then(|value| value.checked_mul(1024))
            .unwrap_or(0);
        #[cfg(not(target_os = "linux"))]
        let rss_bytes = u64::try_from(end.ru_maxrss).unwrap_or(0);
        let cpu_cores = cpu_seconds / wall_seconds;
        if !cpu_cores.is_finite() || cpu_cores <= 0.0 || rss_bytes == 0 {
            return Err(RunError {
                message: "terminal eigen worker resource usage is zero or non-finite".into(),
            });
        }
        return Ok(crate::adaptive_resources::WorkerPeak {
            cpu_cores,
            rss_bytes,
        });
    }
    #[cfg(not(unix))]
    {
        let _ = start;
        Err(RunError {
            message: "terminal eigen worker resource usage requires a Unix getrusage runtime"
                .into(),
        })
    }
}

/// Hash semantic plan JSON with recursively sorted object keys. Array order and
/// scalar representations are preserved; HashMap iteration order is not part of
/// the identity. Sort explicitly so serde_json's preserve_order feature cannot
/// change the parent/child digest contract. The executable/build handshake pins
/// both processes to this same implementation without changing the wire schema.
pub(crate) fn plan_sha256(plan: &FemEigenPlanIR) -> Result<String, RunError> {
    let encode = || -> Result<Vec<u8>, serde_json::Error> {
        let value = serde_json::to_value(plan)?;
        let mut encoded = Vec::new();
        write_canonical_plan_json(&value, &mut encoded)?;
        Ok(encoded)
    };
    let encoded = encode().map_err(|error| RunError {
        message: format!("serialize worker plan digest: {error}"),
    })?;
    Ok(sha256_bytes(&encoded))
}

fn write_canonical_plan_json(
    value: &serde_json::Value,
    encoded: &mut Vec<u8>,
) -> Result<(), serde_json::Error> {
    match value {
        serde_json::Value::Object(object) => {
            encoded.push(b'{');
            let mut entries: Vec<_> = object.iter().collect();
            entries.sort_unstable_by(|(left, _), (right, _)| left.cmp(right));
            for (index, (key, child)) in entries.into_iter().enumerate() {
                if index != 0 {
                    encoded.push(b',');
                }
                serde_json::to_writer(&mut *encoded, key)?;
                encoded.push(b':');
                write_canonical_plan_json(child, encoded)?;
            }
            encoded.push(b'}');
        }
        serde_json::Value::Array(items) => {
            encoded.push(b'[');
            for (index, child) in items.iter().enumerate() {
                if index != 0 {
                    encoded.push(b',');
                }
                write_canonical_plan_json(child, encoded)?;
            }
            encoded.push(b']');
        }
        _ => serde_json::to_writer(encoded, value)?,
    }
    Ok(())
}

fn validate_input_digests(
    actual_plan: &str,
    expected_plan: &str,
    actual_equilibrium: &str,
    expected_equilibrium: &str,
) -> Result<(), RunError> {
    if actual_plan != expected_plan || actual_equilibrium != expected_equilibrium {
        return Err(RunError {
            message: format!(
                "eigen k worker input digest mismatch: actual_plan_sha256={actual_plan} \
                 expected_plan_sha256={expected_plan} \
                 actual_equilibrium_artifact_sha256={actual_equilibrium} \
                 expected_equilibrium_artifact_sha256={expected_equilibrium}"
            ),
        });
    }
    Ok(())
}

pub(crate) fn equilibrium_artifact_sha256(plan: &FemEigenPlanIR) -> Result<String, RunError> {
    let EquilibriumSourceIR::Artifact { path } = &plan.equilibrium else {
        return Err(RunError {
            message: "worker equilibrium digest requires EquilibriumSourceIR::Artifact".into(),
        });
    };
    let bytes = fs::read(path).map_err(|error| RunError {
        message: format!("read worker equilibrium artifact for digest: {error}"),
    })?;
    Ok(sha256_bytes(&bytes))
}

fn safe_relative_artifact_path(relative_path: &str) -> Result<PathBuf, RunError> {
    let path = Path::new(relative_path);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(RunError {
            message: format!("worker artifact path escapes namespace: {relative_path}"),
        });
    }
    Ok(path.to_path_buf())
}

fn stage_artifacts(
    artifact_dir: &Path,
    artifacts: Vec<AuxiliaryArtifact>,
) -> Result<Vec<EigenKWorkerArtifactV1>, RunError> {
    fs::create_dir_all(artifact_dir).map_err(|error| RunError {
        message: format!("create eigen k worker artifact namespace: {error}"),
    })?;
    let mut references = Vec::with_capacity(artifacts.len());
    for artifact in artifacts {
        let relative = safe_relative_artifact_path(&artifact.relative_path)?;
        let destination = artifact_dir.join(&relative);
        if !destination.starts_with(artifact_dir) {
            return Err(RunError {
                message: format!("worker artifact destination escapes namespace: {destination:?}"),
            });
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| RunError {
                message: format!("create worker artifact parent: {error}"),
            })?;
        }
        let temporary = destination.with_extension(format!("tmp-{}", std::process::id()));
        fs::write(&temporary, &artifact.bytes).map_err(|error| RunError {
            message: format!("write worker artifact {}: {error}", artifact.relative_path),
        })?;
        fs::rename(&temporary, &destination).map_err(|error| RunError {
            message: format!(
                "publish worker artifact {}: {error}",
                artifact.relative_path
            ),
        })?;
        let mut digest = Sha256::new();
        digest.update(&artifact.bytes);
        references.push(EigenKWorkerArtifactV1 {
            relative_path: artifact.relative_path,
            path: destination,
            byte_len: artifact.bytes.len() as u64,
            sha256: format!("sha256:{:x}", digest.finalize()),
        });
    }
    Ok(references)
}

fn worker_index_from_namespace(namespace: &Path) -> Result<usize, RunError> {
    let name = namespace
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| RunError {
            message: "eigen k worker namespace has no valid directory name".into(),
        })?;
    let suffix = name.strip_prefix("worker-").ok_or_else(|| RunError {
        message: format!("eigen k worker namespace is not private: {namespace:?}"),
    })?;
    if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(RunError {
            message: format!("eigen k worker namespace has invalid request index: {namespace:?}"),
        });
    }
    suffix.parse::<usize>().map_err(|error| RunError {
        message: format!("parse eigen k worker request index: {error}"),
    })
}

fn canonical_namespace_for_response(response_path: &Path) -> Result<(PathBuf, usize), RunError> {
    if !response_path.is_absolute() {
        return Err(RunError {
            message: "eigen k worker response path must be absolute".into(),
        });
    }
    let parent = response_path.parent().ok_or_else(|| RunError {
        message: "eigen k worker response path has no namespace".into(),
    })?;
    let namespace = fs::canonicalize(parent).map_err(|error| RunError {
        message: format!("canonicalize eigen k worker namespace: {error}"),
    })?;
    let response_name = response_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| RunError {
            message: "eigen k worker response path has no valid file name".into(),
        })?;
    if response_name != "response.json" {
        return Err(RunError {
            message: format!("eigen k worker response must be response.json: {response_path:?}"),
        });
    }
    let index = worker_index_from_namespace(&namespace)?;
    Ok((namespace, index))
}

fn require_namespace_path(
    namespace: &Path,
    path: &Path,
    expected_name: &str,
    directory: bool,
) -> Result<PathBuf, RunError> {
    if !path.is_absolute() {
        return Err(RunError {
            message: format!("eigen k worker {expected_name} path must be absolute"),
        });
    }
    let parent = path.parent().ok_or_else(|| RunError {
        message: format!("eigen k worker {expected_name} path has no parent"),
    })?;
    let canonical_parent = fs::canonicalize(parent).map_err(|error| RunError {
        message: format!("canonicalize eigen k worker {expected_name} parent: {error}"),
    })?;
    if canonical_parent != namespace {
        return Err(RunError {
            message: format!("eigen k worker {expected_name} path escapes private namespace"),
        });
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| RunError {
            message: format!("eigen k worker {expected_name} path has no valid name"),
        })?;
    if name != expected_name {
        return Err(RunError {
            message: format!("eigen k worker path must be {expected_name}"),
        });
    }
    if directory {
        let canonical = fs::canonicalize(path).map_err(|error| RunError {
            message: format!("canonicalize eigen k worker artifacts: {error}"),
        })?;
        if !canonical.is_dir() || canonical != namespace.join(expected_name) {
            return Err(RunError {
                message: "eigen k worker artifacts are outside the private namespace".into(),
            });
        }
        Ok(canonical)
    } else if path.exists() {
        let canonical = fs::canonicalize(path).map_err(|error| RunError {
            message: format!("canonicalize eigen k worker {expected_name}: {error}"),
        })?;
        if canonical.parent() != Some(namespace) {
            return Err(RunError {
                message: format!("eigen k worker {expected_name} escapes private namespace"),
            });
        }
        Ok(canonical)
    } else {
        Ok(namespace.join(expected_name))
    }
}

fn validate_request_namespace(
    request_path: Option<&Path>,
    request: &EigenKWorkerRequestV1,
) -> Result<(PathBuf, usize), RunError> {
    let (namespace, index) = canonical_namespace_for_response(&request.response_path)?;
    if let Some(request_path) = request_path {
        if !request_path.is_absolute() {
            return Err(RunError {
                message: "eigen k worker request path must be absolute".into(),
            });
        }
        let canonical_request = fs::canonicalize(request_path).map_err(|error| RunError {
            message: format!("canonicalize eigen k worker request: {error}"),
        })?;
        if canonical_request.parent() != Some(namespace.as_path())
            || canonical_request
                .file_name()
                .and_then(|value| value.to_str())
                != Some("request.json")
        {
            return Err(RunError {
                message: "eigen k worker request escapes its private namespace".into(),
            });
        }
    }
    let _ = require_namespace_path(&namespace, &request.artifact_dir, "artifacts", true)?;
    let _ = require_namespace_path(&namespace, &request.response_path, "response.json", false)?;
    if let Some(cancel_path) = request.cancel_path.as_ref() {
        let _ = require_namespace_path(&namespace, cancel_path, "cancel.flag", false)?;
    }
    Ok((namespace, index))
}

fn response_for_error(request: &EigenKWorkerRequestV1, error: RunError) -> EigenKWorkerResponseV1 {
    let worker_request_index = request
        .response_path
        .parent()
        .and_then(|path| worker_index_from_namespace(path).ok())
        .unwrap_or(usize::MAX);
    EigenKWorkerResponseV1 {
        protocol: EIGEN_K_WORKER_PROTOCOL_V1.to_string(),
        sample_index: request.sample_index,
        worker_request_index,
        ok: false,
        worker_executable_sha256: None,
        worker_build_identity: None,
        terminal_peak: None,
        run: None,
        error: Some(error.message),
    }
}

fn validate_handshake(
    namespace: &Path,
    request: &EigenKWorkerRequestV1,
    request_index: usize,
) -> Result<(), RunError> {
    let handshake_path = namespace.join("handshake.json");
    let bytes = fs::read(&handshake_path).map_err(|error| RunError {
        message: format!("read eigen k worker handshake: {error}"),
    })?;
    let handshake: EigenKWorkerHandshakeV1 =
        serde_json::from_slice(&bytes).map_err(|error| RunError {
            message: format!("parse eigen k worker handshake: {error}"),
        })?;
    if handshake.protocol != EIGEN_K_WORKER_HANDSHAKE_V1
        || handshake.request_index != request_index
        || handshake.sample_index != request.sample_index
        || handshake.expected_plan_sha256 != request.expected_plan_sha256
        || handshake.expected_equilibrium_artifact_sha256
            != request.expected_equilibrium_artifact_sha256
        || !is_sha256_digest(&handshake.executable_sha256)
    {
        return Err(RunError {
            message: "eigen k worker handshake does not match its request".into(),
        });
    }
    let (actual_executable_sha256, actual_build_identity) = current_worker_identity()?;
    if handshake.executable_sha256 != actual_executable_sha256
        || handshake.build_identity != actual_build_identity
    {
        return Err(RunError {
            message: "eigen k worker executable/build identity does not match its parent handshake"
                .into(),
        });
    }
    Ok(())
}

pub(crate) fn worker_thread_environment(
    budget: &EigenKWorkerThreadBudgetV1,
) -> Vec<(&'static str, String)> {
    let value = budget.resolved_threads.to_string();
    let mut environment: Vec<_> = [
        "FULLMAG_CPU_THREADS",
        "OMP_NUM_THREADS",
        "OMP_THREAD_LIMIT",
        "RAYON_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "MKL_NUM_THREADS",
        "BLIS_NUM_THREADS",
        "VECLIB_MAXIMUM_THREADS",
        "NUMEXPR_NUM_THREADS",
    ]
    .into_iter()
    .map(|name| (name, value.clone()))
    .collect();
    environment.push(("OMP_DYNAMIC", "FALSE".into()));
    environment.push(("MKL_DYNAMIC", "FALSE".into()));
    environment
}

fn apply_thread_budget(budget: &EigenKWorkerThreadBudgetV1) -> Result<(), RunError> {
    // The parent supplies these before exec so library initialization sees
    // the same budget. Reapply in the private child before native execution.
    for (name, value) in worker_thread_environment(budget) {
        std::env::set_var(name, value);
    }
    Ok(())
}

/// Execute one process request.  The caller owns process spawning and writes
/// the returned response atomically to `request.response_path`.
pub(crate) fn execute_request(request: EigenKWorkerRequestV1) -> EigenKWorkerResponseV1 {
    execute_request_internal(request, None)
}

fn execute_request_v2(request: EigenKWorkerRequestV2) -> EigenKWorkerResponseV1 {
    if let Err(error) = request.validate() {
        let mut response = response_for_error(&request.clone().into_v1(), error);
        response.protocol = EIGEN_K_WORKER_PROTOCOL_V2.to_string();
        return response;
    }
    let publication = request.potential_publication();
    let mut response = execute_request_internal(request.into_v1(), Some(publication));
    response.protocol = EIGEN_K_WORKER_PROTOCOL_V2.to_string();
    response
}

fn execute_request_internal(
    mut request: EigenKWorkerRequestV1,
    potential_publication: Option<super::eigen_path::EigenPathPotentialPublication>,
) -> EigenKWorkerResponseV1 {
    if let Err(error) = request.validate() {
        return response_for_error(&request, error);
    }
    if let Err(error) = validate_request_namespace(None, &request) {
        return response_for_error(&request, error);
    }
    if let Err(error) = apply_thread_budget(&request.thread_budget) {
        return response_for_error(&request, error);
    }
    let terminal_measurement = match terminal_measurement_start() {
        Ok(start) => Some(start),
        Err(error)
            if request.parallel_policy.mode == fullmag_ir::ParallelExecutionModeIR::Adaptive =>
        {
            return response_for_error(&request, error);
        }
        Err(_) => None,
    };
    request.plan.k_sampling = Some(fullmag_ir::KSamplingIR::Single {
        k_vector: request.k_vector,
    });

    let actual_plan_sha256 = match plan_sha256(&request.plan) {
        Ok(value) => value,
        Err(error) => return response_for_error(&request, error),
    };
    let actual_equilibrium_artifact_sha256 = match equilibrium_artifact_sha256(&request.plan) {
        Ok(value) => value,
        Err(error) => return response_for_error(&request, error),
    };
    if let Err(error) = validate_input_digests(
        &actual_plan_sha256,
        &request.expected_plan_sha256,
        &actual_equilibrium_artifact_sha256,
        &request.expected_equilibrium_artifact_sha256,
    ) {
        return response_for_error(&request, error);
    }

    let execution =
        match resolve_fem_eigen_execution_resolution(&request.plan, Some(&request.execution)) {
            Ok(Some(execution)) => execution,
            Ok(None) => {
                return response_for_error(
                    &request,
                    RunError {
                        message:
                            "eigen k worker requires an exact materialized FEM execution resolution"
                                .into(),
                    },
                )
            }
            Err(error) => return response_for_error(&request, error),
        };
    if execution.lane() != super::eigen_execution_resolution::FemEigenExecutionLane::Cpu {
        return response_for_error(
            &request,
            RunError {
                message:
                    "adaptive eigen k worker currently supports FEM CPU only; GPU remains serial"
                        .into(),
            },
        );
    }

    let cancel_path = request.cancel_path.clone();
    let mut cancel = move |_event: fem_eigen::FemEigenProgress| {
        if cancel_path.as_ref().is_some_and(|path| path.exists()) {
            crate::types::StepAction::Stop
        } else {
            crate::types::StepAction::Continue
        }
    };
    let run_result = if let Some(publication) = potential_publication.as_ref() {
        crate::fem::eigen_execution::execute_fem_eigen_path_single_k(
            execution,
            &request.plan,
            &request.outputs,
            publication,
            Some(&mut cancel),
            request.sample_index,
            Some(request.sample_index),
            None,
            None,
        )
    } else {
        fem_eigen::execute_planned_fem_eigen_with_handoff_and_progress(
            execution,
            &request.plan,
            &request.outputs,
            None,
            Some(&mut cancel),
            request.sample_index,
            Some(request.sample_index),
        )
    };
    let run = match run_result {
        Ok(run) => run,
        Err(error) => return response_for_error(&request, error),
    };
    let artifacts = match stage_artifacts(&request.artifact_dir, run.auxiliary_artifacts) {
        Ok(artifacts) => artifacts,
        Err(error) => return response_for_error(&request, error),
    };
    let (worker_executable_sha256, worker_build_identity) = match current_worker_identity() {
        Ok(identity) => identity,
        Err(error) => return response_for_error(&request, error),
    };
    let terminal_peak = match terminal_measurement
        .as_ref()
        .map(terminal_measurement_finish)
        .transpose()
    {
        Ok(peak) => peak,
        Err(error)
            if request.parallel_policy.mode == fullmag_ir::ParallelExecutionModeIR::Adaptive =>
        {
            return response_for_error(&request, error);
        }
        Err(_) => None,
    };
    let worker_request_index = match request
        .response_path
        .parent()
        .ok_or_else(|| RunError {
            message: "eigen k worker response path has no namespace".into(),
        })
        .and_then(worker_index_from_namespace)
    {
        Ok(index) => index,
        Err(error) => return response_for_error(&request, error),
    };
    EigenKWorkerResponseV1 {
        protocol: EIGEN_K_WORKER_PROTOCOL_V1.to_string(),
        sample_index: request.sample_index,
        worker_request_index,
        ok: true,
        worker_executable_sha256: Some(worker_executable_sha256),
        worker_build_identity: Some(worker_build_identity),
        terminal_peak,
        run: Some(EigenKWorkerRunV1 {
            status: run.result.status,
            final_magnetization: run.result.final_magnetization,
            plan_sha256: actual_plan_sha256,
            equilibrium_artifact_sha256: actual_equilibrium_artifact_sha256,
            thread_budget: request.thread_budget,
            artifacts,
        }),
        error: None,
    }
}

/// Hidden CLI entry point.  The request and response are file based so the
/// normal startup banner cannot corrupt the machine-readable protocol.
pub fn run_request_file(request_path: &Path) -> Result<(), RunError> {
    let bytes = fs::read(request_path).map_err(|error| RunError {
        message: format!("read eigen k worker request: {error}"),
    })?;
    let envelope: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| RunError {
        message: format!("parse eigen k worker request: {error}"),
    })?;
    let protocol = envelope
        .get("protocol")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| RunError {
            message: "eigen k worker request has no protocol token".into(),
        })?;
    let is_v2 = protocol == EIGEN_K_WORKER_PROTOCOL_V2;
    let (request, request_v2) = match protocol {
        EIGEN_K_WORKER_PROTOCOL_V1 => (
            serde_json::from_slice::<EigenKWorkerRequestV1>(&bytes).map_err(|error| RunError {
                message: format!("parse eigen k worker v1 request: {error}"),
            })?,
            None,
        ),
        EIGEN_K_WORKER_PROTOCOL_V2 => {
            let request =
                serde_json::from_slice::<EigenKWorkerRequestV2>(&bytes).map_err(|error| {
                    RunError {
                        message: format!("parse eigen k worker v2 request: {error}"),
                    }
                })?;
            (request.clone().into_v1(), Some(request))
        }
        other => {
            return Err(RunError {
                message: format!("unsupported eigen k worker protocol {other}"),
            });
        }
    };
    let response_path = request.response_path.clone();
    let (namespace, request_index) = validate_request_namespace(Some(request_path), &request)?;
    let response = match validate_handshake(&namespace, &request, request_index) {
        Ok(()) => match request_v2 {
            Some(request_v2) => execute_request_v2(request_v2),
            None => execute_request(request),
        },
        Err(error) => {
            let mut response = response_for_error(&request, error);
            if is_v2 {
                response.protocol = EIGEN_K_WORKER_PROTOCOL_V2.to_string();
            }
            response
        }
    };
    let encoded = serde_json::to_vec_pretty(&response).map_err(|error| RunError {
        message: format!("encode eigen k worker response: {error}"),
    })?;
    let temporary = response_path.with_extension(format!("tmp-{}", std::process::id()));
    if let Some(parent) = response_path.parent() {
        fs::create_dir_all(parent).map_err(|error| RunError {
            message: format!("create eigen k worker response parent: {error}"),
        })?;
    }
    fs::write(&temporary, encoded).map_err(|error| RunError {
        message: format!("write eigen k worker response: {error}"),
    })?;
    fs::rename(&temporary, response_path).map_err(|error| RunError {
        message: format!("publish eigen k worker response: {error}"),
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mixed_domain_quality(n_elements: u32) -> fullmag_ir::MeshQualityIR {
        fullmag_ir::MeshQualityIR {
            n_elements,
            sicn_min: 0.04972165803390353,
            sicn_max: 0.8692633548993621,
            sicn_mean: 0.21182961426295854,
            sicn_p5: 0.058568572244461284,
            sicn_histogram: vec![1, 2, 3],
            gamma_min: 0.125,
            gamma_mean: 0.75,
            gamma_histogram: vec![3, 2, 1],
            volume_min: 1.3e-27,
            volume_max: 2.7e-25,
            volume_mean: 4.5e-26,
            volume_std: 7.1e-27,
            avg_quality: 0.5,
        }
    }

    fn worker_request(plan: FemEigenPlanIR) -> EigenKWorkerRequestV1 {
        EigenKWorkerRequestV1 {
            protocol: EIGEN_K_WORKER_PROTOCOL_V1.into(),
            expected_plan_sha256: plan_sha256(&plan).unwrap(),
            expected_equilibrium_artifact_sha256: format!("sha256:{}", "a".repeat(64)),
            plan,
            outputs: Vec::new(),
            execution: serde_json::from_value(serde_json::json!({
                "requested_device": "cpu", "resolved_device": "cpu",
                "requested_precision": "double", "resolved_precision": "double",
                "requested_engine": "auto",
                "resolved_engine": "floquet_airbox_cpu_schur_slepc",
                "fallback_used": false, "selection_reason": "worker digest fixture"
            }))
            .unwrap(),
            parallel_policy: ParallelExecutionPolicyIR::default(),
            thread_budget: EigenKWorkerThreadBudgetV1 {
                requested_threads: 1,
                resolved_threads: 1,
                cap_reason: "parent_admission_pending".into(),
                allocation_cpu_cores: 1.0,
                host_cpu_cores: 1,
            },
            sample_index: 1,
            k_vector: [0.0, -2.0e7, 0.0],
            artifact_dir: PathBuf::from("worker-artifacts"),
            response_path: PathBuf::from("worker-response.json"),
            cancel_path: None,
        }
    }

    fn worker_request_v2(
        plan: FemEigenPlanIR,
        outputs: Vec<OutputIR>,
        publication_outputs: Vec<OutputIR>,
        sample_label: Option<String>,
    ) -> EigenKWorkerRequestV2 {
        let base = worker_request(plan);
        EigenKWorkerRequestV2 {
            protocol: EIGEN_K_WORKER_PROTOCOL_V2.into(),
            plan: base.plan,
            outputs,
            publication_outputs,
            sample_label,
            execution: base.execution,
            parallel_policy: base.parallel_policy,
            thread_budget: base.thread_budget,
            sample_index: base.sample_index,
            k_vector: base.k_vector,
            expected_plan_sha256: base.expected_plan_sha256,
            expected_equilibrium_artifact_sha256: base.expected_equilibrium_artifact_sha256,
            artifact_dir: base.artifact_dir,
            response_path: base.response_path,
            cancel_path: base.cancel_path,
        }
    }

    #[test]
    fn canonical_json_sorts_nested_keys_and_preserves_arrays_and_scalars() {
        let input: serde_json::Value =
            serde_json::from_str(r#"{"z":[{"z":-0.0,"a":1.3e-11},3,2,1],"a":"quoted\"value"}"#)
                .unwrap();
        let mut encoded = Vec::new();
        write_canonical_plan_json(&input, &mut encoded).unwrap();
        assert_eq!(
            String::from_utf8(encoded).unwrap(),
            r#"{"a":"quoted\"value","z":[{"a":1.3e-11,"z":-0.0},3,2,1]}"#
        );
    }

    #[test]
    fn mixed_domain_plan_digest_survives_permuted_full_request_roundtrip() {
        let mut plan = crate::fem::eigen_tests::minimal_native_modal_plan();
        plan.k_sampling = Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [0.0, -2.0e7, 0.0],
        });
        plan.external_field = Some([79577.47154594767, 0.0, 0.0]);
        plan.equilibrium = EquilibriumSourceIR::Artifact {
            path: "equilibrium.v8.json".into(),
        };
        let air = mixed_domain_quality(28536);
        let film = mixed_domain_quality(1476);
        plan.mesh.per_domain_quality.insert(0, air.clone());
        plan.mesh.per_domain_quality.insert(1, film.clone());
        let request = worker_request(plan);
        let expected = request.expected_plan_sha256.clone();
        let encoded = serde_json::to_string(&request).unwrap();
        let original_map = serde_json::to_string(&request.plan.mesh.per_domain_quality).unwrap();
        for domains in [
            format!(
                "{{\"0\":{},\"1\":{}}}",
                serde_json::to_string(&air).unwrap(),
                serde_json::to_string(&film).unwrap()
            ),
            format!(
                "{{\"1\":{},\"0\":{}}}",
                serde_json::to_string(&film).unwrap(),
                serde_json::to_string(&air).unwrap()
            ),
        ] {
            let permuted = encoded.replace(
                &format!("\"per_domain_quality\":{original_map}"),
                &format!("\"per_domain_quality\":{domains}"),
            );
            assert!(permuted.contains(&format!("\"per_domain_quality\":{domains}")));
            let child: EigenKWorkerRequestV1 = serde_json::from_str(&permuted).unwrap();
            assert_eq!(child.plan, request.plan);
            assert_eq!(plan_sha256(&child.plan).unwrap(), expected);
            validate_input_digests(
                &plan_sha256(&child.plan).unwrap(),
                &expected,
                &child.expected_equilibrium_artifact_sha256,
                &request.expected_equilibrium_artifact_sha256,
            )
            .unwrap();
        }
        let mut reverse_insertion = request.plan.clone();
        reverse_insertion.mesh.per_domain_quality.clear();
        reverse_insertion.mesh.per_domain_quality.insert(1, film);
        reverse_insertion.mesh.per_domain_quality.insert(0, air);
        assert_eq!(plan_sha256(&reverse_insertion).unwrap(), expected);

        let mut changed = request.plan.clone();
        changed.material.exchange_stiffness *= 2.0;
        let changed_digest = plan_sha256(&changed).unwrap();
        assert_ne!(changed_digest, expected);
        let error = validate_input_digests(
            &changed_digest,
            &expected,
            &request.expected_equilibrium_artifact_sha256,
            &request.expected_equilibrium_artifact_sha256,
        )
        .unwrap_err();
        assert!(error
            .message
            .contains(&format!("actual_plan_sha256={changed_digest}")));
        assert!(error
            .message
            .contains(&format!("expected_plan_sha256={expected}")));
        assert!(error
            .message
            .contains("actual_equilibrium_artifact_sha256="));
        assert!(error
            .message
            .contains("expected_equilibrium_artifact_sha256="));
        assert!(
            validate_input_digests(&expected, &expected, "sha256:changed", "sha256:original")
                .is_err()
        );
    }

    #[test]
    fn v2_worker_request_keeps_tracking_and_publication_selectors_separate() {
        let mut plan = crate::fem::eigen_tests::minimal_native_modal_plan();
        plan.equilibrium = EquilibriumSourceIR::Artifact {
            path: "equilibrium.v8.json".into(),
        };
        let tracking = OutputIR::EigenMode {
            field: "mode".into(),
            all_modes: true,
            indices: vec![],
            branches: vec![],
            sample_selector: None,
        };
        let publication = OutputIR::EigenMode {
            field: "mode".into(),
            all_modes: false,
            indices: vec![1],
            branches: vec![],
            sample_selector: Some(fullmag_ir::SampleSelectorIR {
                sample_indices: vec![1],
                sample_labels: vec!["X".into()],
            }),
        };
        let request = worker_request_v2(
            plan,
            vec![tracking.clone()],
            vec![publication.clone()],
            Some("X".into()),
        );
        request.validate().unwrap();
        let mut invalid_protocol = request.clone();
        invalid_protocol.protocol = "unsupported-worker-version".into();
        let error_response = execute_request_v2(invalid_protocol);
        assert_eq!(error_response.protocol, EIGEN_K_WORKER_PROTOCOL_V2);
        assert!(!error_response.ok);
        let roundtrip: EigenKWorkerRequestV2 =
            serde_json::from_slice(&serde_json::to_vec(&request).unwrap()).unwrap();
        assert_eq!(roundtrip.outputs, vec![tracking]);
        assert_eq!(roundtrip.publication_outputs, vec![publication.clone()]);
        assert_eq!(roundtrip.sample_label.as_deref(), Some("X"));
        let selector = roundtrip.potential_publication();
        assert_eq!(selector.outputs, vec![publication.clone()]);
        assert_eq!(selector.sample_index, roundtrip.sample_index);
        assert_eq!(selector.sample_label.as_deref(), Some("X"));
        assert_eq!(
            selector.selected_mode_indices(2).unwrap(),
            std::collections::BTreeSet::from([1])
        );
        let branch = OutputIR::EigenMode {
            field: "mode".into(),
            all_modes: false,
            indices: vec![],
            branches: vec![7],
            sample_selector: None,
        };
        let branch_request = worker_request_v2(
            roundtrip.plan.clone(),
            roundtrip.outputs.clone(),
            vec![branch.clone()],
            Some("X".into()),
        );
        let branch_selector = branch_request.potential_publication();
        assert_eq!(
            branch_selector.selected_mode_indices(2).unwrap(),
            std::collections::BTreeSet::from([0, 1])
        );
        assert!(branch_selector.pretracking_mode_indices(2).unwrap().is_empty());

        let mixed_request = worker_request_v2(
            roundtrip.plan.clone(),
            roundtrip.outputs.clone(),
            vec![publication, branch],
            Some("X".into()),
        );
        let mixed_selector = mixed_request.potential_publication();
        assert_eq!(
            mixed_selector.pretracking_mode_indices(2).unwrap(),
            std::collections::BTreeSet::from([1])
        );

        let mut v1_with_v2_fields = serde_json::to_value(worker_request(
            crate::fem::eigen_tests::minimal_native_modal_plan(),
        ))
        .unwrap();
        v1_with_v2_fields["publication_outputs"] = serde_json::json!([]);
        v1_with_v2_fields["sample_label"] = serde_json::json!(null);
        assert!(serde_json::from_value::<EigenKWorkerRequestV1>(v1_with_v2_fields).is_err());
    }
}
