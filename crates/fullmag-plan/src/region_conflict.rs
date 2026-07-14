use fullmag_ir::RegionConflictPolicyIR;

/// A deterministic candidate presented to the canonical region conflict resolver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RegionConflictCandidate {
    pub region_id: String,
    pub priority: i32,
    pub policy: RegionConflictPolicyIR,
}

/// The resolved winner and the complete candidate set used to derive it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RegionConflictResolution {
    pub winner_region_id: String,
    pub policy: RegionConflictPolicyIR,
    pub candidates: Vec<String>,
}

/// Resolve ownership for one spatial point/cell.
///
/// Priority is a declared ordering, but an equal-priority tie is never broken
/// by region-id ordering. A metric-specific policy such as
/// `min_mesh_size_wins` must be handled by its owning resolver and therefore
/// cannot silently select a material/mask winner here.
pub(crate) fn resolve_region_conflict(
    candidates: &[RegionConflictCandidate],
) -> Result<RegionConflictResolution, String> {
    if candidates.is_empty() {
        return Err("region overlap resolver received no candidates".to_string());
    }

    let mut ordered = candidates.to_vec();
    ordered.sort_by(|left, right| left.region_id.cmp(&right.region_id));
    let max_priority = ordered
        .iter()
        .map(|candidate| candidate.priority)
        .max()
        .expect("non-empty candidates have a maximum priority");
    let winners = ordered
        .iter()
        .filter(|candidate| candidate.priority == max_priority)
        .collect::<Vec<_>>();
    let candidate_ids = ordered
        .iter()
        .map(|candidate| candidate.region_id.clone())
        .collect::<Vec<_>>();

    if winners.len() > 1 {
        let policy = winners[0].policy;
        let same_policy = winners.iter().all(|candidate| candidate.policy == policy);
        let reason = if !same_policy {
            "conflicting policies"
        } else {
            match policy {
                RegionConflictPolicyIR::Error => "policy=error",
                RegionConflictPolicyIR::HigherPriorityWins => {
                    "higher_priority_wins cannot resolve equal priority"
                }
                RegionConflictPolicyIR::MinMeshSizeWins => {
                    "min_mesh_size_wins requires a mesh-size resolver"
                }
            }
        };
        return Err(format!(
            "overlapping object regions [{}] have equal priority {}: {}",
            candidate_ids.join(", "),
            max_priority,
            reason
        ));
    }

    let winner = winners[0];
    Ok(RegionConflictResolution {
        winner_region_id: winner.region_id.clone(),
        policy: winner.policy,
        candidates: candidate_ids,
    })
}
