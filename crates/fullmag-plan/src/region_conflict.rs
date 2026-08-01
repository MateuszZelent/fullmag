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

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(
        region_id: &str,
        priority: i32,
        policy: RegionConflictPolicyIR,
    ) -> RegionConflictCandidate {
        RegionConflictCandidate {
            region_id: region_id.to_string(),
            priority,
            policy,
        }
    }

    #[test]
    fn unique_highest_priority_wins_independently_of_input_order() {
        let result = resolve_region_conflict(&[
            candidate("region:z", 1, RegionConflictPolicyIR::Error),
            candidate("region:a", 3, RegionConflictPolicyIR::Error),
            candidate("region:m", 2, RegionConflictPolicyIR::Error),
        ])
        .expect("unique maximum priority must resolve");

        assert_eq!(result.winner_region_id, "region:a");
        assert_eq!(result.candidates, vec!["region:a", "region:m", "region:z"]);
    }

    #[test]
    fn equal_priority_error_policy_fails_closed() {
        let error = resolve_region_conflict(&[
            candidate("region:b", 4, RegionConflictPolicyIR::Error),
            candidate("region:a", 4, RegionConflictPolicyIR::Error),
        ])
        .expect_err("equal priority must not choose a hidden winner");

        assert!(error.contains("region:a, region:b"));
        assert!(error.contains("equal priority 4"));
        assert!(error.contains("policy=error"));
    }

    #[test]
    fn equal_priority_higher_priority_policy_does_not_recurse_into_id_order() {
        let error = resolve_region_conflict(&[
            candidate("region:b", 4, RegionConflictPolicyIR::HigherPriorityWins),
            candidate("region:a", 4, RegionConflictPolicyIR::HigherPriorityWins),
        ])
        .expect_err("higher_priority_wins cannot resolve an equal-priority tie");

        assert!(error.contains("higher_priority_wins cannot resolve equal priority"));
    }

    #[test]
    fn equal_priority_min_mesh_policy_requires_mesh_metric_owner() {
        let error = resolve_region_conflict(&[
            candidate("region:b", 4, RegionConflictPolicyIR::MinMeshSizeWins),
            candidate("region:a", 4, RegionConflictPolicyIR::MinMeshSizeWins),
        ])
        .expect_err("mesh-size policy needs a mesh-specific resolver");

        assert!(error.contains("min_mesh_size_wins requires a mesh-size resolver"));
    }

    #[test]
    fn equal_priority_conflicting_policies_fail_closed() {
        let error = resolve_region_conflict(&[
            candidate("region:b", 4, RegionConflictPolicyIR::Error),
            candidate("region:a", 4, RegionConflictPolicyIR::HigherPriorityWins),
        ])
        .expect_err("conflicting policies must not select a winner");

        assert!(error.contains("conflicting policies"));
    }
}
