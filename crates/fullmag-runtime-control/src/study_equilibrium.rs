//! Independent scientific validation of accepted Relax-to-Eigen CAS artifacts.
use anyhow::{bail, Result};
use fullmag_application::PreparationBinding;

pub fn handoff_budget(storage_bytes: u64) -> usize {
    usize::try_from(storage_bytes)
        .unwrap_or(usize::MAX)
        .min(fullmag_application::FEM_EQUILIBRIUM_HANDOFF_MAX_BYTES)
}

/// Transport closure is checked by the application codec. Producer/consumer
/// callers supply the exact immutable preparation belonging to the source task.
/// The native runner then replays the existing strict scientific certificate.
pub fn validate_handoff_bytes(
    bytes: &[u8],
    maximum: usize,
    expected_run_id: &str,
    expected_stage_id: &str,
    expected_preparation: &PreparationBinding,
) -> Result<fullmag_runner::ReplayedFemRelaxation> {
    let bundle = fullmag_application::decode_fem_equilibrium_handoff(bytes, maximum)?;
    if bundle.run_id != expected_run_id
        || bundle.stage_id != expected_stage_id
        || &bundle.preparation != expected_preparation
    {
        bail!("FEM equilibrium handoff differs from its exact source owner or preparation");
    }
    let members = bundle
        .members
        .into_iter()
        .map(|(path, member)| (path, member.bytes))
        .collect();
    fullmag_runner::replay_accepted_fem_relaxation(
        &members,
        expected_run_id,
        expected_stage_id,
        &bundle.execution_plan_fingerprint,
    )
    .map_err(Into::into)
}

/// Publication/completion rebind the bundle to the exact producing task receipt.
pub fn validate_handoff_publication(
    bytes: &[u8],
    store: &fullmag_session::SessionStore,
    accepted: &crate::AcceptedStudySnapshot,
    claim: &fullmag_application::TaskClaim,
    step: &fullmag_authoring::StudyStep,
) -> Result<fullmag_runner::ReplayedFemRelaxation> {
    if !matches!(
        step.kind,
        fullmag_authoring::StudyStepKind::Primitive {
            stage_kind: fullmag_authoring::StudyPrimitiveStageKind::Relax
        }
    ) {
        bail!("FEM equilibrium handoff must be produced by its declared Relax step");
    }
    let receipt = accepted.read_task_preparation_receipt(store, claim.task_id.as_str())?;
    let preparation = PreparationBinding::from_receipt(&receipt)?;
    validate_handoff_bytes(
        bytes,
        handoff_budget(claim.lease.budget.storage_bytes),
        claim.run_id.as_str(),
        &step.step_id,
        &preparation,
    )
}
