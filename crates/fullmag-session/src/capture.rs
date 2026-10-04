//! Checkpoint capture — extracts a logical snapshot from the runner's live state.
//!
//! The capture module bridges the gap between the runner's in-memory state
//! (which may hold GPU pointers, FFT tensors, etc.) and the serializable
//! checkpoint format used by the `SessionStore`.

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::store::SessionStore;
use crate::types::*;

// ── Capture request / response ─────────────────────────────────────────

/// Request to capture a checkpoint from the current runtime state.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureRequest {
    pub run_id: String,
    pub profile: SaveProfile,
    /// Which fields to capture beyond the mandatory primary state.
    pub field_policy: FieldCapturePolicy,
}

/// The result of a capture operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureResult {
    pub checkpoint: FmsCheckpoint,
    pub common_state: CommonSolverState,
    /// Backend-specific payload, if captured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend_state: Option<BackendStatePayload>,
}

// ── Snapshot trait ──────────────────────────────────────────────────────

/// Trait that a runtime must implement to support checkpoint capture.
///
/// Implementors extract the minimal state needed for serialization.
/// GPU backends must download device memory to host before returning.
pub trait CheckpointSnapshotProvider {
    /// Current simulation step.
    fn step(&self) -> u64;
    /// Current simulation time in seconds.
    fn time_s(&self) -> f64;
    /// Current time step.
    fn dt(&self) -> f64;
    /// Current energy components.
    fn energies(&self) -> SolverEnergies;
    /// Magnetization vector — `Vec<[f64; 3]>`, one entry per cell/node.
    fn magnetization(&self) -> Result<Vec<[f64; 3]>>;
    /// Additional named fields to capture (exchange field, demag field, etc.)
    /// Returns pairs of `(name, data)`.
    fn auxiliary_fields(&self, policy: FieldCapturePolicy) -> Result<Vec<(String, Vec<[f64; 3]>)>>;
    /// Backend-specific restart payload (integrator state, RNG state, etc.)
    fn backend_state_payload(&self) -> Result<Option<BackendStatePayload>>;
    /// Compatibility fingerprints for restore matching.
    fn compatibility(&self) -> CheckpointCompatibility;
}

// ── Capture logic ──────────────────────────────────────────────────────

/// Capture a checkpoint from a snapshot provider and persist it to the store.
pub fn capture_checkpoint(
    store: &SessionStore,
    provider: &dyn CheckpointSnapshotProvider,
    request: &CaptureRequest,
) -> Result<CaptureResult> {
    // Keep the native writer lease across every CAS/document mutation.  A
    // checkpoint is one graph publication; per-file nested leases alone would
    // allow GC to observe the descriptor before its payload edges exist.
    let _lease = store.write_transaction()?;
    let step = provider.step();
    let time_s = provider.time_s();
    let dt = provider.dt();

    // 1. Store magnetization.
    let m = provider.magnetization()?;
    let m_hash = store.store_magnetization(&m)?;

    // 2. Create common state.
    let common_state = CommonSolverState {
        step,
        time_s,
        dt,
        energies: provider.energies(),
        magnetization_ref: Some(m_hash.clone()),
    };

    // 3. Build checkpoint.
    let mut checkpoint = FmsCheckpoint::new(&request.run_id, step, time_s, dt);
    checkpoint.compatibility = provider.compatibility();

    // 4. Store primary field ref.
    let m_descriptor = TensorDescriptor::new_f64(
        "magnetization",
        vec![m.len(), 3],
        vec!["node".into(), "c".into()],
    );
    let m_bytes = m
        .len()
        .checked_mul(3)
        .and_then(|elements| elements.checked_mul(std::mem::size_of::<f64>()))
        .ok_or_else(|| anyhow::anyhow!("magnetization payload size overflow"))?;
    let mut m_descriptor = m_descriptor;
    m_descriptor.chunks.push(TensorChunk {
        object_ref: m_hash.clone(),
        offset: 0,
        length: m_bytes,
        sha256: Some(m_hash.clone()),
    });
    let m_desc_hash = store.cas().put_json(&m_descriptor)?;
    checkpoint.field_refs.push(FieldRef {
        name: "magnetization".into(),
        role: FieldRole::Primary,
        tensor_descriptor_ref: m_desc_hash,
    });

    // 5. Auxiliary fields.
    let aux = provider.auxiliary_fields(request.field_policy)?;
    for (name, data) in &aux {
        let hash = store.store_magnetization(data)?;
        let desc =
            TensorDescriptor::new_f64(&name, vec![data.len(), 3], vec!["node".into(), "c".into()]);
        let aux_bytes = data
            .len()
            .checked_mul(3)
            .and_then(|elements| elements.checked_mul(std::mem::size_of::<f64>()))
            .ok_or_else(|| anyhow::anyhow!("auxiliary field payload size overflow"))?;
        let mut desc = desc;
        desc.chunks.push(TensorChunk {
            object_ref: hash.clone(),
            offset: 0,
            length: aux_bytes,
            sha256: Some(hash.clone()),
        });
        let desc_hash = store.cas().put_json(&desc)?;
        checkpoint.field_refs.push(FieldRef {
            name: name.clone(),
            role: FieldRole::ResumeAux,
            tensor_descriptor_ref: desc_hash,
        });
    }

    // 6. Backend state.
    let backend_state =
        if request.profile != SaveProfile::Compact && request.profile != SaveProfile::Solved {
            provider.backend_state_payload()?
        } else {
            None
        };

    if let Some(ref bsp) = backend_state {
        let bsp_json = serde_json::to_vec_pretty(bsp)?;
        let bsp_path = format!(
            "runs/{}/checkpoints/{}/backend_state.json",
            checkpoint.run_id, checkpoint.checkpoint_id
        );
        store.write_checkpoint_payload(&checkpoint, "backend_state.json", &bsp_json)?;
        checkpoint.backend_state_ref = Some(bsp_path);
    }

    // 7. Persist to store.
    store.commit_checkpoint(&checkpoint, &common_state)?;

    Ok(CaptureResult {
        checkpoint,
        common_state,
        backend_state,
    })
}

/// Determine the restore class by comparing a checkpoint's compatibility
/// with the current runtime capabilities.
pub fn determine_restore_class(
    checkpoint: &CheckpointCompatibility,
    current: &CheckpointCompatibility,
) -> RestoreClass {
    fn same_present(left: &Option<String>, right: &Option<String>) -> bool {
        matches!(
            (left.as_deref(), right.as_deref()),
            (Some(left), Some(right)) if !left.trim().is_empty() && left == right
        )
    }

    let same_logical_state = same_present(&checkpoint.problem_hash, &current.problem_hash)
        && same_present(&checkpoint.plan_hash, &current.plan_hash)
        && same_present(
            &checkpoint.state_schema_version,
            &current.state_schema_version,
        )
        && same_present(&checkpoint.study_kind, &current.study_kind)
        && same_present(
            &checkpoint.discretization_signature,
            &current.discretization_signature,
        )
        && same_present(
            &checkpoint.field_layout_signature,
            &current.field_layout_signature,
        );

    // Exact resume requires complete physical/state identity plus the same
    // runtime realization. Missing fields never compare as compatible.
    if same_logical_state
        && same_present(&checkpoint.restart_abi, &current.restart_abi)
        && same_present(&checkpoint.engine_id, &current.engine_id)
        && same_present(&checkpoint.runtime_family, &current.runtime_family)
        && same_present(&checkpoint.precision, &current.precision)
    {
        return RestoreClass::ExactResume;
    }

    // Logical resume retains the same physical problem, plan and state layout,
    // while allowing a different runtime realization.
    if same_logical_state {
        return RestoreClass::LogicalResume;
    }

    // A typed discretization and field layout can still seed a new run. The
    // caller must perform its own target-shape validation before importing.
    if checkpoint
        .discretization_signature
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
        && checkpoint
            .field_layout_signature
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
    {
        return RestoreClass::InitialConditionImport;
    }

    RestoreClass::ConfigOnly
}

#[cfg(test)]
mod tests {
    use super::determine_restore_class;
    use crate::{CheckpointCompatibility, RestoreClass};

    fn complete_compatibility() -> CheckpointCompatibility {
        CheckpointCompatibility {
            restart_abi: Some("fullmag.fdm.cpu.coupled-m3.v1".into()),
            problem_hash: Some(
                "problem:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .into(),
            ),
            plan_hash: Some(
                "plan:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                    .into(),
            ),
            state_schema_version: Some("fullmag.checkpoint.v1".into()),
            engine_id: Some("fdm_cpu_reference".into()),
            runtime_family: Some("fdm_cpu_reference".into()),
            precision: Some("double".into()),
            study_kind: Some("fdm_coupled_m3".into()),
            discretization_signature: Some("mesh:7;vectors:2".into()),
            field_layout_signature: Some("magnetization:2x3".into()),
        }
    }

    #[test]
    fn empty_compatibility_is_config_only() {
        assert_eq!(
            determine_restore_class(
                &CheckpointCompatibility::default(),
                &CheckpointCompatibility::default(),
            ),
            RestoreClass::ConfigOnly
        );
    }

    #[test]
    fn exact_resume_requires_every_compatibility_identity() {
        let complete = complete_compatibility();
        assert_eq!(
            determine_restore_class(&complete, &complete),
            RestoreClass::ExactResume
        );

        let mut missing_problem = complete.clone();
        missing_problem.problem_hash = None;
        assert_ne!(
            determine_restore_class(&missing_problem, &missing_problem),
            RestoreClass::ExactResume
        );

        let mut missing_state_schema = complete.clone();
        missing_state_schema.state_schema_version = None;
        assert_ne!(
            determine_restore_class(&missing_state_schema, &missing_state_schema),
            RestoreClass::ExactResume
        );

        let mut changed_engine = complete.clone();
        changed_engine.engine_id = Some("other-engine".into());
        assert_eq!(
            determine_restore_class(&complete, &changed_engine),
            RestoreClass::LogicalResume
        );
    }

    #[test]
    fn logical_resume_requires_matching_physics_plan_and_layout() {
        let checkpoint = complete_compatibility();
        let mut current = checkpoint.clone();
        current.restart_abi = Some("fullmag.fdm.gpu.v1".into());
        current.runtime_family = Some("fdm_cuda".into());
        current.engine_id = Some("cuda_fdm".into());
        assert_eq!(
            determine_restore_class(&checkpoint, &current),
            RestoreClass::LogicalResume
        );

        current.plan_hash = Some(
            "plan:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".into(),
        );
        assert_eq!(
            determine_restore_class(&checkpoint, &current),
            RestoreClass::InitialConditionImport
        );
    }
}
