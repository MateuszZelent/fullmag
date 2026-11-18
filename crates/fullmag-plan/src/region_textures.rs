use fullmag_ir::{
    BackendPlanIR, ExecutionPlanIR, FdmRegionLegendEntryIR, InitialMagnetizationIR, ProblemIR,
    RegionConflictPolicyIR, RegionRefIR,
};
use std::collections::BTreeSet;

use crate::PlanError;

use crate::magnetization_textures::TextureSamplePoint;
use crate::magnetization_textures_v2::sample_preset_texture_versioned;
use crate::region_conflict::{resolve_region_conflict, RegionConflictCandidate};
use crate::selection::geometry::{contains_point, GeometryPredicate};
use crate::util::generate_random_unit_vectors;

/// A region candidate projected onto a backend's discrete magnetic domain.
///
/// `owner_mask` is deliberately independent of the texture transform. A translated
/// or rotated texture can change which part of its analytic profile is visible, but
/// it can never acquire ownership of a degree of freedom outside the owning region.
pub(crate) struct RegionTextureCandidate<'a> {
    pub region_id: &'a str,
    pub priority: i32,
    pub owner_mask: &'a [bool],
    pub predicate: &'a GeometryPredicate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RegionTextureOwnership {
    pub winners: Vec<Option<usize>>,
    pub matched_counts: Vec<usize>,
    pub winner_counts: Vec<usize>,
}

/// Resolve one winning region per discrete degree of freedom.
///
/// The same highest-priority-wins / equal-priority-fails-closed contract is used
/// by FDM region IDs and FEM nodal texture assignment.
pub(crate) fn resolve_region_texture_ownership(
    points_world: &[[f64; 3]],
    candidates: &[RegionTextureCandidate<'_>],
) -> Result<RegionTextureOwnership, String> {
    for candidate in candidates {
        if candidate.owner_mask.len() != points_world.len() {
            return Err(format!(
                "object_region '{}' owner mask length {} does not match point count {}",
                candidate.region_id,
                candidate.owner_mask.len(),
                points_world.len()
            ));
        }
    }

    let mut winners = vec![None; points_world.len()];
    let mut matched_counts = vec![0usize; candidates.len()];
    let mut winner_counts = vec![0usize; candidates.len()];

    for (point_index, point) in points_world.iter().copied().enumerate() {
        if point.iter().any(|component| !component.is_finite()) {
            return Err(format!(
                "region texture sample point {point_index} contains non-finite coordinates"
            ));
        }

        let mut matches = Vec::new();
        for (candidate_index, candidate) in candidates.iter().enumerate() {
            if !candidate.owner_mask[point_index] {
                continue;
            }
            let contains = contains_point(candidate.predicate, point)
                .map_err(|error| format!("object_region '{}': {error}", candidate.region_id))?;
            if contains {
                matched_counts[candidate_index] += 1;
                matches.push(candidate_index);
            }
        }
        if matches.is_empty() {
            continue;
        }

        let conflicts = matches
            .iter()
            .map(|index| RegionConflictCandidate {
                region_id: candidates[*index].region_id.to_string(),
                priority: candidates[*index].priority,
                policy: RegionConflictPolicyIR::Error,
            })
            .collect::<Vec<_>>();
        let resolution = resolve_region_conflict(&conflicts)?;
        let winner = matches
            .into_iter()
            .find(|index| candidates[*index].region_id == resolution.winner_region_id)
            .expect("region conflict resolver winner must be a candidate");
        winners[point_index] = Some(winner);
        winner_counts[winner] += 1;
    }

    Ok(RegionTextureOwnership {
        winners,
        matched_counts,
        winner_counts,
    })
}

/// Select the native degrees of freedom replaced by authored magnetization.
/// Layout identity and artifact validation belong to the caller.
pub fn study_magnetization_overlay_mask(
    problem: &ProblemIR,
    plan: &ExecutionPlanIR,
    scopes: &[RegionRefIR],
) -> Result<Vec<bool>, PlanError> {
    if scopes.is_empty() {
        return Err(overlay_error("initial-state overlay has no scopes"));
    }
    if let BackendPlanIR::Fem(fem) = &plan.backend_plan {
        if fem.fe_order != 1 {
            return Err(overlay_error("FEM magnetization overlay requires a P1 layout"));
        }
        return crate::fem::fem_study_magnetization_overlay_mask(problem, fem, scopes);
    }

    let mut enabled_scopes = Vec::new();
    for scope in scopes {
        if !problem.magnets.iter().any(|magnet| {
            magnet.object_id.as_deref().unwrap_or(&magnet.name) == scope.object_id
        }) {
            return Err(overlay_error(format!("unknown overlay object '{}'", scope.object_id)));
        }
        if let Some(region_id) = &scope.region_id {
            let region = problem.object_regions.iter().find(|region| {
                region.owner_object == scope.object_id && region.region_id == *region_id
            }).ok_or_else(|| overlay_error(format!(
                "unknown overlay region '{region_id}' on '{}'", scope.object_id
            )))?;
            if !region.enabled {
                continue;
            }
        }
        enabled_scopes.push(scope);
    }
    match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            if problem.magnets.len() != 1 {
                return Err(overlay_error("single-grid FDM overlay requires exactly one object"));
            }
            fdm_overlay_mask(
                &enabled_scopes,
                fdm.initial_magnetization.len(),
                fdm.active_mask.as_deref(),
                Some(&fdm.region_mask),
                fdm.grid_certificate.as_ref().map(|certificate| certificate.region_legend.as_slice()),
            )
        }
        BackendPlanIR::FdmMultilayer(fdm) => {
            for scope in &enabled_scopes {
                if fdm.layers.iter().filter(|layer| layer.object_id == scope.object_id).count() != 1 {
                    return Err(overlay_error(format!(
                        "overlay object '{}' has no unique native FDM layer", scope.object_id
                    )));
                }
            }
            let mut mask = Vec::new();
            for layer in &fdm.layers {
                let layer_scopes = enabled_scopes.iter().copied()
                    .filter(|scope| scope.object_id == layer.object_id)
                    .collect::<Vec<_>>();
                mask.extend(fdm_overlay_mask(
                    &layer_scopes,
                    layer.initial_magnetization.len(),
                    layer.native_active_mask.as_deref(),
                    layer.native_region_mask.as_deref(),
                    layer.native_region_legend.as_deref(),
                )?);
            }
            Ok(mask)
        }
        _ => Err(overlay_error("accepted backend does not support a magnetization overlay")),
    }
}

fn overlay_error(reason: impl Into<String>) -> PlanError {
    PlanError { reasons: vec![reason.into()] }
}

fn fdm_overlay_mask(
    scopes: &[&RegionRefIR],
    samples: usize,
    active_mask: Option<&[bool]>,
    region_mask: Option<&[u32]>,
    legend: Option<&[FdmRegionLegendEntryIR]>,
) -> Result<Vec<bool>, PlanError> {
    if scopes.is_empty() {
        return Ok(vec![false; samples]);
    }
    if active_mask.is_some_and(|mask| mask.len() != samples) {
        return Err(overlay_error("FDM overlay active mask differs from the native grid"));
    }
    let is_active = |index: usize| active_mask.map_or(true, |mask| mask[index]);
    if scopes.iter().any(|scope| scope.region_id.is_none()) {
        return Ok((0..samples).map(is_active).collect());
    }

    let region_mask = region_mask.filter(|mask| mask.len() == samples)
        .ok_or_else(|| overlay_error("FDM overlay has no matching native region mask"))?;
    let legend = legend.ok_or_else(|| overlay_error("FDM overlay has no native region legend"))?;
    let mut numeric_ids = BTreeSet::new();
    for scope in scopes {
        let mut matching = legend.iter().filter(|entry| {
            entry.object_id == scope.object_id && scope.region_id.as_deref() == Some(entry.region_id.as_str())
        });
        let entry = matching.next().filter(|_| matching.next().is_none()).ok_or_else(|| {
            overlay_error(format!("FDM overlay scope {scope:?} has no unique native region ID"))
        })?;
        numeric_ids.insert(entry.numeric_id);
    }
    Ok(region_mask.iter().enumerate().map(|(index, id)| {
        is_active(index) && numeric_ids.contains(id)
    }).collect())
}

/// Materialize an initial-magnetization descriptor on a strict selection mask.
///
/// Every returned vector outside `selected` is exactly zero. Callers additionally
/// merge only selected indices; this double containment prevents a translated or
/// rotated analytic texture from leaking into neighbouring regions.
pub(crate) fn sample_region_initial_on_mask(
    context: &str,
    initial: &InitialMagnetizationIR,
    points: &[TextureSamplePoint],
    selected: &[bool],
) -> Result<Vec<[f64; 3]>, String> {
    if points.len() != selected.len() {
        return Err(format!(
            "{context}: selection mask length {} does not match sample point count {}",
            selected.len(),
            points.len()
        ));
    }
    let active_selection = points
        .iter()
        .zip(selected)
        .map(|(point, selected)| point.active && *selected)
        .collect::<Vec<_>>();
    let selected_count = active_selection
        .iter()
        .filter(|selected| **selected)
        .count();
    if selected_count == 0 {
        return Ok(vec![[0.0, 0.0, 0.0]; points.len()]);
    }

    let masked_points = points
        .iter()
        .zip(&active_selection)
        .map(|(point, active)| TextureSamplePoint {
            position_world: point.position_world,
            position_object: point.position_object,
            active: *active,
        })
        .collect::<Vec<_>>();

    let values = match initial {
        InitialMagnetizationIR::Uniform { value } => active_selection
            .iter()
            .map(|active| if *active { *value } else { [0.0, 0.0, 0.0] })
            .collect(),
        InitialMagnetizationIR::RandomSeeded { seed } => {
            let mut values = generate_random_unit_vectors(*seed, points.len());
            for (value, active) in values.iter_mut().zip(&active_selection) {
                if !active {
                    *value = [0.0, 0.0, 0.0];
                }
            }
            values
        }
        InitialMagnetizationIR::SampledField { values } => {
            let mut resolved = vec![[0.0, 0.0, 0.0]; points.len()];
            if values.len() == points.len() {
                for (index, active) in active_selection.iter().copied().enumerate() {
                    if active {
                        resolved[index] = values[index];
                    }
                }
            } else if values.len() == selected_count {
                let mut source = values.iter().copied();
                for (index, active) in active_selection.iter().copied().enumerate() {
                    if active {
                        resolved[index] = source
                            .next()
                            .expect("selected-count validation guarantees a sampled value");
                    }
                }
            } else {
                return Err(format!(
                    "{context}: sampled field length {} must equal either the full domain size {} or selected region size {}",
                    values.len(),
                    points.len(),
                    selected_count
                ));
            }
            resolved
        }
        InitialMagnetizationIR::PresetTexture {
            preset_kind,
            preset_params,
            mapping,
            texture_transform,
            preset_version,
        } => sample_preset_texture_versioned(
            preset_kind,
            *preset_version,
            preset_params,
            mapping,
            texture_transform,
            &masked_points,
        )
        .map_err(|error| format!("{context}: {error}"))?,
    };

    if values.len() != points.len() {
        return Err(format!(
            "{context}: materialized vector length {} does not match sample point count {}",
            values.len(),
            points.len()
        ));
    }
    if values
        .iter()
        .zip(&active_selection)
        .any(|(value, active)| !active && *value != [0.0, 0.0, 0.0])
    {
        return Err(format!(
            "{context}: sampler returned a nonzero vector outside the selected region"
        ));
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use fullmag_ir::{
        RegionFrameIR, RegionRealizationPolicyIR, RegionShapeIR, RegionTextureOverrideIR,
        TextureMappingIR, TextureTransform3DIR,
    };

    use super::*;
    use crate::{AffineTransform3, BoundaryMembership};

    fn region(
        region_id: &str,
        priority: i32,
        center_x: f64,
        size_x: f64,
    ) -> fullmag_ir::ObjectRegionIR {
        fullmag_ir::ObjectRegionIR {
            region_id: region_id.to_string(),
            owner_object: "magnet".to_string(),
            name: region_id.to_string(),
            shape: RegionShapeIR::Box {
                size: [size_x, 2.0, 2.0],
                center: [center_x, 0.0, 0.0],
            },
            frame: RegionFrameIR::Object,
            enabled: true,
            priority,
            mesh_policy: None,
            material_overrides: Vec::new(),
            texture_override: Some(RegionTextureOverrideIR {
                initial_magnetization: InitialMagnetizationIR::Uniform {
                    value: [1.0, 0.0, 0.0],
                },
            }),
            realization_policy: RegionRealizationPolicyIR::Inherit,
            material_transition: None,
        }
    }

    #[test]
    fn translated_preset_is_strictly_clipped_to_the_selection_mask() {
        let points = vec![
            TextureSamplePoint {
                position_world: [1.0, 0.0, 0.0],
                position_object: [1.0, 0.0, 0.0],
                active: true,
            },
            TextureSamplePoint {
                position_world: [2.0, 0.0, 0.0],
                position_object: [2.0, 0.0, 0.0],
                active: true,
            },
        ];
        let mut params = BTreeMap::new();
        params.insert("core_radius".to_string(), serde_json::json!(0.25));
        params.insert("core_polarity".to_string(), serde_json::json!(1));
        params.insert("circulation".to_string(), serde_json::json!(1));
        params.insert("plane".to_string(), serde_json::json!("xy"));
        let initial = InitialMagnetizationIR::PresetTexture {
            preset_kind: "vortex".to_string(),
            preset_params: params,
            mapping: TextureMappingIR::default(),
            texture_transform: TextureTransform3DIR {
                translation: [1.0, 0.0, 0.0],
                ..TextureTransform3DIR::default()
            },
            preset_version: 2,
        };

        let values =
            sample_region_initial_on_mask("translated vortex", &initial, &points, &[true, false])
                .unwrap();

        assert!((values[0][2] - 1.0).abs() < 1.0e-12);
        assert_eq!(values[1], [0.0, 0.0, 0.0]);
    }

    #[test]
    fn ownership_uses_priority_but_never_broadens_beyond_the_owner_mask() {
        let low = region("low", 1, 0.0, 4.0);
        let high = region("high", 2, 0.0, 1.0);
        let low_predicate = GeometryPredicate::from_object_region(
            &low,
            AffineTransform3::identity(),
            BoundaryMembership::inclusive(),
        )
        .unwrap();
        let high_predicate = GeometryPredicate::from_object_region(
            &high,
            AffineTransform3::identity(),
            BoundaryMembership::inclusive(),
        )
        .unwrap();
        let points = [[0.0, 0.0, 0.0], [1.5, 0.0, 0.0], [0.0, 0.0, 0.0]];
        let low_owner = [true, true, false];
        let high_owner = [true, true, false];
        let candidates = [
            RegionTextureCandidate {
                region_id: "low",
                priority: 1,
                owner_mask: &low_owner,
                predicate: &low_predicate,
            },
            RegionTextureCandidate {
                region_id: "high",
                priority: 2,
                owner_mask: &high_owner,
                predicate: &high_predicate,
            },
        ];

        let ownership = resolve_region_texture_ownership(&points, &candidates).unwrap();

        assert_eq!(ownership.winners, vec![Some(1), Some(0), None]);
        assert_eq!(ownership.matched_counts, vec![2, 1]);
        assert_eq!(ownership.winner_counts, vec![1, 1]);
    }
}
