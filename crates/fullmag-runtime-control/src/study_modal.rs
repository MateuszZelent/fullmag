//! Independent owner and semantic validation at accepted modal publication.
use anyhow::{bail, Result};
use fullmag_application::{ModalEigenBundle, TaskClaim};
use fullmag_authoring::{StudyPortDataKind, StudyPrimitiveStageKind, StudyStep, StudyStepKind};

pub fn is_modal_step(step: &StudyStep) -> bool {
    matches!(
        step.kind,
        StudyStepKind::Primitive {
            stage_kind: StudyPrimitiveStageKind::Eigenmodes
        }
    )
}
pub fn bundle_budget(claim: &TaskClaim) -> usize {
    usize::try_from(claim.lease.budget.storage_bytes)
        .unwrap_or(usize::MAX)
        .min(fullmag_application::MODAL_EIGEN_BUNDLE_MAX_BYTES)
}
/// Durable publication and completion both recheck the exact expected owner.
/// The framing codec alone must not authenticate a producer to another task.
pub fn validate_bundle(
    bytes: &[u8],
    claim: &TaskClaim,
    step: &StudyStep,
) -> Result<ModalEigenBundle> {
    if !is_modal_step(step)
        || step.outputs.len() != 1
        || step.outputs[0].port_id != fullmag_application::MODAL_EIGEN_OUTPUT_PORT
        || step.outputs[0].data_kind != StudyPortDataKind::Artifact
    {
        bail!("modal accepted output differs from its declared eigenmodes contract");
    }
    let bundle = fullmag_application::decode_modal_eigen_bundle(bytes, bundle_budget(claim))?;
    if bundle.run_id != claim.run_id.as_str() || bundle.stage_id != step.step_id {
        bail!("modal accepted generation belongs to another run or stage");
    }
    fullmag_runner::validate_modal_artifact_closure(&bundle.payloads)?;
    Ok(bundle)
}
