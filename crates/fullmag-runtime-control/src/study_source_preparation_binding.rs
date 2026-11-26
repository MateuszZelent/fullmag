//! Immutable source-asset binding only. The caller supplies an independently authenticated projection.
use anyhow::{bail, Context, Result};
use fullmag_antenna_artifacts::source_preparation::{AntennaSourcePreparationAssetDocument,
    MAX_ANTENNA_SOURCE_PREPARATION_ASSET_BYTES};
use fullmag_ir::{AntennaFieldSolveStageIR, ConservativeCurrentSourceIR, CurrentModuleIR, ProblemIR};
use fullmag_session::SessionStore;

/// Read exact accepted CAS bytes; neither this asset nor its hashes authorize a current source.
pub fn load_retained_source_preparation_binding(
    store: &SessionStore, accepted: &crate::AcceptedRunSnapshot, problem: &ProblemIR,
    stage: &AntennaFieldSolveStageIR, authentic: &AntennaSourcePreparationAssetDocument,
) -> Result<AntennaSourcePreparationAssetDocument> {
    let reference = stage.retained_source_preparation.as_ref().context("retained preparation asset reference absent")?;
    validate_reference(accepted, reference)?;
    let bytes = store.cas().get_bounded(&reference.content_sha256, MAX_ANTENNA_SOURCE_PREPARATION_ASSET_BYTES as u64)?
        .context("accepted retained preparation asset CAS absent")?;
    let document = AntennaSourcePreparationAssetDocument::decode(&bytes)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    validate_retained_source_preparation_binding(accepted, problem, stage, &document, authentic)?;
    Ok(document)
}

fn validate_reference(accepted: &crate::AcceptedRunSnapshot, reference: &fullmag_ir::AntennaSourcePreparationAssetRefIR) -> Result<()> {
    let errors = reference.validation_errors("retained_source_preparation");
    if !errors.is_empty() { bail!("{}", errors.join("; ")); }
    if accepted.intent.run_id != accepted.specification.run_id.as_str() {
        bail!("retained preparation accepted run identity differs");
    }
    let mut assets = accepted.specification.immutable_assets.iter().filter(|asset| asset.asset_id == reference.asset_id);
    let asset = assets.next().context("retained preparation asset is absent from immutable RunSpec")?;
    if assets.next().is_some() || asset.content_sha256 != reference.content_sha256
        || accepted.intent.asset_object_refs.get(&reference.asset_id) != Some(&reference.content_sha256) {
        bail!("retained preparation asset differs from exact immutable input closure");
    }
    Ok(())
}

/// Both documents must already come from their respective authenticated byte readers.
/// Pure agreement is not a substitute for the parent's full physical verification.
pub fn validate_retained_source_preparation_binding(
    accepted: &crate::AcceptedRunSnapshot, problem: &ProblemIR, stage: &AntennaFieldSolveStageIR,
    asset: &AntennaSourcePreparationAssetDocument, authentic: &AntennaSourcePreparationAssetDocument,
) -> Result<()> {
    let reference = stage.retained_source_preparation.as_ref().context("retained preparation asset reference absent")?;
    validate_reference(accepted, reference)?;
    asset.validate().map_err(|error| anyhow::anyhow!(error.to_string()))?;
    authentic.validate().map_err(|error| anyhow::anyhow!(error.to_string()))?;
    // Compact canonical bytes preserve distinctions such as -0.0 versus +0.0
    // that floating-point PartialEq alone would erase from historical identity.
    // Both validated documents are bounded by the existing 8 MiB input limit.
    if serde_json::to_vec(asset)? != serde_json::to_vec(authentic)? {
        bail!("retained preparation asset differs from independently authenticated parent inputs");
    }
    if asset.parent_owner.project_id != accepted.specification.snapshot.project_id.as_str()
        || !stage.retained_current_source.as_ref().is_some_and(|source| asset.parent_owner.matches_source(source)) {
        bail!("retained preparation source differs from its exact parent/project locator");
    }
    let definition = problem.current_modules.iter().find_map(|module| match module {
        CurrentModuleIR::CurrentTransport { name, definition: Some(definition), .. }
            if name == &stage.current_transport_id => Some(definition),
        _ => None,
    }).context("retained preparation current transport absent")?;
    let Some(ConservativeCurrentSourceIR::RetainedPreparationAsset(source)) = definition.conservative_current_source.as_ref()
        else { bail!("retained preparation requires its distinct authored source kind"); };
    if &source.preparation_asset != reference || source.historical_prepared_source != asset.prepared_source
        || source.historical_preparation != asset.source_preparation
        || source.object_id != stage.source_object_id {
        bail!("retained preparation authored source differs from the authenticated frozen inputs");
    }
    let geometry = fullmag_ir::geometry_name_for_physics_object_v03(problem, &source.object_id)
        .map_err(|errors| anyhow::anyhow!(errors.join("; ")))?;
    if geometry != source.geometry_id { bail!("retained preparation source geometry differs from its object"); }
    let mut meshes = problem.geometry_assets.as_ref().context("retained preparation geometry assets absent")?
        .fem_mesh_assets.iter().filter(|entry| entry.geometry_name == geometry);
    let mesh = meshes.next().context("retained preparation frozen conductor mesh absent")?;
    if meshes.next().is_some() || mesh.mesh.as_ref() != Some(&asset.source_mesh) || mesh.mesh_source.is_some()
        || serde_json::to_vec(mesh.mesh.as_ref().context("retained preparation inline mesh absent")?)?
            != serde_json::to_vec(&asset.source_mesh)? {
        bail!("retained preparation requires the exact inline frozen conductor mesh without a secondary path");
    }
    Ok(())
}
