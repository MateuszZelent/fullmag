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
        let desc_hash = store.cas().put_json(&desc)?;
        checkpoint.field_refs.push(FieldRef {
            name: name.clone(),
            role: FieldRole::ResumeAux,
            tensor_descriptor_ref: desc_hash,
        });
        // Store the actual data blob with the hash as part of a separate ref pointing
        // to the CAS object via the descriptor.
        let _ = hash; // Hash is already stored; descriptor refs it conceptually.
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
        store.write_document(&bsp_path, &bsp_json)?;
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
    // Exact resume requires all fingerprints to match.
    if checkpoint.restart_abi.is_some()
        && checkpoint.restart_abi == current.restart_abi
        && checkpoint.plan_hash.is_some()
        && checkpoint.plan_hash == current.plan_hash
        && checkpoint.discretization_signature == current.discretization_signature
        && checkpoint.precision == current.precision
        && checkpoint.field_layout_signature == current.field_layout_signature
    {
        return RestoreClass::ExactResume;
    }

    // Logical resume: same study kind and discretization, possibly different runtime.
    if checkpoint.study_kind == current.study_kind
        && checkpoint.discretization_signature == current.discretization_signature
    {
        return RestoreClass::LogicalResume;
    }

    // If there's magnetization, we can at least import it as initial condition.
    if checkpoint.discretization_signature.is_some() {
        return RestoreClass::InitialConditionImport;
    }

    RestoreClass::ConfigOnly
}
