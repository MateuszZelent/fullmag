//! Read-only retained DTQ binding shared by native evaluation and portable inspection.
//! Source authentication remains with the opaque parent reader; no FFI or solve occurs here.
use crate::antenna_field_solution::closed_loop_v2::{is_digest, normalization_scale, ClosedLoopSourceMetadataV2};
use crate::antenna_field_solution::direct_quadrature_v2::DirectQuadratureEvidenceV2;
use crate::types::RunError;

fn bad(message: &str) -> RunError {
    RunError { message: format!("retained RT0 source refused: {message}") }
}

pub(crate) fn validate_budget(budget: fullmag_ir::AntennaClosedLoopDirectBudgetIR) -> Result<(), RunError> {
    if !["production_default", "volume_inspection_v1"].into_iter()
        .filter_map(fullmag_ir::antenna_closed_loop_direct_budget)
        .any(|b| b.policy_version == budget.policy_version
            && b.maximum_source_target_pairs == budget.maximum_source_target_pairs
            && b.maximum_kernel_evaluations == budget.maximum_kernel_evaluations
            && b.maximum_ledger_leaf_visits == budget.maximum_ledger_leaf_visits)
    {
        return Err(bad("unknown or mixed retained direct policy"));
    }
    Ok(())
}

/// Numeric binding only. The caller must authenticate the full durable parent
/// before supplying this metadata; neither a digest nor this function grants ownership.
pub(crate) fn verify_retained_dtq_binding(
    evidence: &DirectQuadratureEvidenceV2,
    source: &ClosedLoopSourceMetadataV2,
    source_count: u64,
    points: &[[f64; 3]],
    raw: &[[f64; 3]],
    budget: fullmag_ir::AntennaClosedLoopDirectBudgetIR,
) -> Result<(), RunError> {
    validate_budget(budget)?;
    let snapshot = &evidence.snapshot;
    snapshot.validate_closed_loop()?;
    if !is_digest(&source.view_identity_digest)
        || !is_digest(&source.current_balance_certificate_digest)
        || snapshot.source_view_identity_digest != source.view_identity_digest
        || evidence.current_balance_certificate_digest != source.current_balance_certificate_digest
        || evidence.signed_normalization_a.to_bits() != source.source_current_a.to_bits()
        || evidence.source_absolute_flux_a.to_bits() != source.source_absolute_flux_a.to_bits()
        || evidence.scale_per_a.to_bits()
            != normalization_scale(source.source_current_a, source.source_absolute_flux_a)?.to_bits()
        || raw.len() != points.len()
        || source_count == 0
        || source_count.checked_mul(points.len() as u64) != Some(snapshot.source_target_pairs)
        || snapshot.maximum_source_target_pairs != budget.maximum_source_target_pairs
        || snapshot.maximum_kernel_evaluations != budget.maximum_kernel_evaluations
        || snapshot.maximum_ledger_leaf_visits != budget.maximum_ledger_leaf_visits
    {
        return Err(bad("retained direct source, normalization, count or policy binding"));
    }
    let per_a = raw.iter().map(|h| h.map(|v| v * evidence.scale_per_a)).collect::<Vec<_>>();
    evidence.verify_binding(points, raw, &per_a)
}
