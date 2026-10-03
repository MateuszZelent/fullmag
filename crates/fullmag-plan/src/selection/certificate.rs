use std::collections::{BTreeMap, BTreeSet};

use fullmag_ir::{
    canonical_selection_sha256, selection_is_state_dependent, CartesianComponentIR,
    ClosedIntervalIR, ComparisonOpIR, ConstraintActivationIR, EmptySelectionPolicyIR,
    FrozenReferencePolicyIR, FrozenSpinsIR, InactiveSelectionPolicyIR, ResolvedFrozenSpinsPlanIR,
    SelectionAuthoredFingerprintIR, SelectionCertificateIR, SelectionDefinitionIR, SelectionExprIR,
    SelectionFrameIR, SelectionMembershipPolicyIR, SelectionScalarExprIR,
    SelectionValidationContext, RESOLVED_FROZEN_SPINS_PLAN_SCHEMA_VERSION,
    SELECTION_CERTIFICATE_SCHEMA_VERSION, SELECTION_EXPR_SCHEMA_VERSION,
};
use sha2::{Digest, Sha256};

use super::geometry::{
    validate_affine_transform, world_point_in_frame, AffineTransform3, BoundaryMembership,
    GeometryPredicate, SelectionError,
};

pub const FDM_SELECTION_EVALUATOR_ID: &str = "selection.fdm_cell_center.v1";
pub const FEM_SELECTION_EVALUATOR_ID: &str = "selection.fem_true_dof.any_incident_magnetic.v1";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SelectionDofMembership {
    pub object_ids: Vec<String>,
    pub region_ids: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy)]
pub struct FrozenSpinsStateSnapshot<'a> {
    pub magnetization: &'a [[f64; 3]],
    pub revision: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct ResolvedFrozenSpinsReference<'a> {
    pub constraint_id: &'a str,
    pub values: &'a [[f64; 3]],
    pub source_state_revision: Option<u64>,
    pub topology_fingerprint: &'a str,
}

#[derive(Debug)]
pub struct FrozenSpinsCompileRequest<'a> {
    pub constraints: &'a [FrozenSpinsIR],
    pub selections: &'a [SelectionDefinitionIR],
    pub activation_stage_id: Option<&'a str>,
    pub object_transforms: &'a BTreeMap<String, AffineTransform3>,
    pub known_entities: &'a SelectionValidationContext,
    pub state_snapshot: Option<FrozenSpinsStateSnapshot<'a>>,
    pub resolved_references: &'a [ResolvedFrozenSpinsReference<'a>],
    pub expected_source_state_revision: Option<u64>,
    pub expected_grid_or_mesh_fingerprint: &'a str,
}

pub(crate) struct SelectionDomainView<'a> {
    pub points_m: &'a [[f64; 3]],
    pub active_mask: &'a [bool],
    pub memberships: &'a [SelectionDofMembership],
    pub topology_fingerprint: &'a str,
    pub evaluator_id: &'static str,
}

pub(crate) fn compile_domain_frozen_spins(
    domain: SelectionDomainView<'_>,
    request: &FrozenSpinsCompileRequest<'_>,
) -> Result<ResolvedFrozenSpinsPlanIR, SelectionError> {
    validate_domain(&domain, request)?;
    let active_constraints: Vec<_> = request
        .constraints
        .iter()
        .filter(|constraint| constraint.enabled && active_in_stage(constraint, request))
        .collect();
    let definitions: BTreeMap<_, _> = request
        .selections
        .iter()
        .map(|definition| (definition.id.as_str(), &definition.expression))
        .collect();
    let references = reference_map(request.resolved_references)?;
    let mut prepared_constraints = Vec::with_capacity(active_constraints.len());
    for constraint in active_constraints {
        let state_dependent =
            selection_is_state_dependent(&constraint.selector, request.selections);
        if matches!(
            constraint.membership,
            SelectionMembershipPolicyIR::Static {}
        ) && state_dependent
        {
            return Err(SelectionError::new(
                "frozen_membership_static_state_dependent",
                format!(
                    "constraint '{}' uses static membership with a state-dependent selector",
                    constraint.id
                ),
            ));
        }
        let reference = references.get(constraint.id.as_str()).ok_or_else(|| {
            SelectionError::new(
                "frozen_reference_missing",
                format!(
                    "constraint '{}' has no resolved reference input",
                    constraint.id
                ),
            )
        })?;
        validate_reference(reference, constraint, &domain, request)?;
        let authored_fingerprint = authored_selector_sha256(constraint, request.selections)?;
        let mut geometry_cache = BTreeMap::new();
        prepare_expression_realization(
            &constraint.selector,
            &domain,
            request,
            &definitions,
            &mut BTreeSet::new(),
            &mut geometry_cache,
        )?;
        prepared_constraints.push((
            constraint,
            *reference,
            authored_fingerprint,
            state_dependent,
            geometry_cache,
        ));
    }
    let state_required =
        prepared_constraints
            .iter()
            .any(|(constraint, _, _, state_dependent, _)| {
                *state_dependent
                    || matches!(
                        constraint.membership,
                        SelectionMembershipPolicyIR::SnapshotAtActivation {}
                    )
            });
    validate_state_snapshot(domain.points_m.len(), state_required, request)?;

    let mut warnings = Vec::new();
    if prepared_constraints
        .iter()
        .any(|(constraint, reference, _, _, _)| {
            matches!(
                constraint.reference,
                FrozenReferencePolicyIR::CaptureCurrentAtActivation {}
            ) && reference.source_state_revision.is_none()
                && request.expected_source_state_revision.is_none()
        })
    {
        warnings.push(
            "frozen_reference_deferred: capture_current_at_activation is recaptured atomically by the runtime at stage activation; plan-time values are used only for deterministic overlap validation"
                .to_string(),
        );
    }
    if request.state_snapshot.is_some_and(|snapshot| {
        snapshot
            .magnetization
            .iter()
            .flatten()
            .any(|value| value.is_nan())
    }) {
        warnings.push(
            "selection_state_nan: NaN scalar samples evaluate to false during snapshot membership"
                .to_string(),
        );
    }

    let mut frozen_mask = vec![false; domain.points_m.len()];
    let mut resolved_reference = vec![None; domain.points_m.len()];
    let mut resolved_reference_owner = vec![None::<String>; domain.points_m.len()];
    let mut raw_union = vec![false; domain.points_m.len()];
    let mut inactive_union = vec![false; domain.points_m.len()];
    let mut authored_fingerprints = Vec::with_capacity(prepared_constraints.len());
    let mut constraint_ids = Vec::with_capacity(prepared_constraints.len());

    for (constraint, reference, authored_fingerprint, _, geometry_cache) in prepared_constraints {
        let mut visiting = BTreeSet::new();
        let raw_mask = (0..domain.points_m.len())
            .map(|index| {
                evaluate_expression(
                    &constraint.selector,
                    index,
                    &domain,
                    request,
                    &definitions,
                    &mut visiting,
                    &geometry_cache,
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        let inactive_count = raw_mask
            .iter()
            .zip(domain.active_mask)
            .filter(|(selected, active)| **selected && !**active)
            .count();
        if inactive_count > 0 {
            match constraint.inactive_selection {
                InactiveSelectionPolicyIR::Error => {
                    return Err(SelectionError::new(
                        "selection_inactive_intersection",
                        format!(
                            "constraint '{}' selects {inactive_count} DOFs outside the active magnetic domain",
                            constraint.id
                        ),
                    ));
                }
                InactiveSelectionPolicyIR::WarnAndIntersect => warnings.push(format!(
                    "selection_inactive_intersection: constraint '{}' intersected {inactive_count} inactive candidate DOFs",
                    constraint.id
                )),
            }
        }
        let selected_mask: Vec<_> = raw_mask
            .iter()
            .zip(domain.active_mask)
            .map(|(selected, active)| *selected && *active)
            .collect();
        if !selected_mask.iter().any(|selected| *selected)
            && constraint.empty_selection == EmptySelectionPolicyIR::Error
        {
            return Err(SelectionError::new(
                "selection_empty",
                format!(
                    "constraint '{}' selects no active magnetic DOFs",
                    constraint.id
                ),
            ));
        }

        for index in 0..domain.points_m.len() {
            raw_union[index] |= raw_mask[index];
            inactive_union[index] |= raw_mask[index] && !domain.active_mask[index];
            if !selected_mask[index] {
                continue;
            }
            let candidate_reference = reference.values[index];
            if let Some(existing) = resolved_reference[index] {
                if !vector_bits_equal(existing, candidate_reference) {
                    let conflict_indices: Vec<_> = selected_mask
                        .iter()
                        .enumerate()
                        .filter_map(|(candidate_index, selected)| {
                            let existing = resolved_reference[candidate_index]?;
                            (*selected
                                && !vector_bits_equal(existing, reference.values[candidate_index]))
                            .then_some(candidate_index)
                        })
                        .collect();
                    let existing_ids: BTreeSet<_> = conflict_indices
                        .iter()
                        .filter_map(|candidate_index| {
                            resolved_reference_owner[*candidate_index].as_deref()
                        })
                        .collect();
                    let max_difference = conflict_indices
                        .iter()
                        .flat_map(|candidate_index| {
                            resolved_reference[*candidate_index]
                                .expect("conflict requires an existing reference")
                                .into_iter()
                                .zip(reference.values[*candidate_index])
                                .map(|(left, right)| (left - right).abs())
                        })
                        .fold(0.0_f64, f64::max);
                    let samples: Vec<_> = conflict_indices.iter().copied().take(8).collect();
                    return Err(SelectionError::new(
                        "frozen_reference_conflict",
                        format!(
                            "constraint '{}' conflicts with constraints {:?}; conflict_count={} sample_dof_indices={samples:?} max_difference={max_difference:e}",
                            constraint.id,
                            existing_ids,
                            conflict_indices.len(),
                        ),
                    ));
                }
            } else {
                resolved_reference[index] = Some(candidate_reference);
                resolved_reference_owner[index] = Some(constraint.id.clone());
            }
            frozen_mask[index] = true;
        }

        authored_fingerprints.push(SelectionAuthoredFingerprintIR {
            constraint_id: constraint.id.clone(),
            selector_sha256: authored_fingerprint,
        });
        constraint_ids.push(constraint.id.clone());
    }

    let frozen_dof_count = frozen_mask.iter().filter(|selected| **selected).count() as u64;
    let active_dof_count = domain.active_mask.iter().filter(|active| **active).count() as u64;
    let free_dof_count = active_dof_count - frozen_dof_count;
    let mask_sha256 = mask_sha256(&frozen_mask);
    let resolved_reference_sha256 = reference_sha256(&frozen_mask, &resolved_reference);
    let source_state_revision = request
        .state_snapshot
        .map(|snapshot| snapshot.revision)
        .or(request.expected_source_state_revision);
    let bounds_m = selected_bounds(&domain, &frozen_mask);
    let certificate = SelectionCertificateIR {
        schema_version: SELECTION_CERTIFICATE_SCHEMA_VERSION.to_string(),
        evaluator_id: domain.evaluator_id.to_string(),
        constraint_ids: constraint_ids.clone(),
        authored_fingerprints,
        raw_candidate_dof_count: raw_union.iter().filter(|selected| **selected).count() as u64,
        inactive_candidate_dof_count: inactive_union.iter().filter(|selected| **selected).count()
            as u64,
        active_dof_count,
        frozen_dof_count,
        free_dof_count,
        bounds_m,
        grid_or_mesh_fingerprint: domain.topology_fingerprint.to_string(),
        source_state_revision,
        mask_sha256: mask_sha256.clone(),
        resolved_reference_sha256,
        warnings,
    };
    let plan = ResolvedFrozenSpinsPlanIR {
        schema_version: RESOLVED_FROZEN_SPINS_PLAN_SCHEMA_VERSION.to_string(),
        constraint_ids,
        frozen_mask,
        active_dof_count,
        frozen_dof_count,
        free_dof_count,
        mask_sha256,
        grid_or_mesh_fingerprint: domain.topology_fingerprint.to_string(),
        source_state_revision,
        all_active_dofs_frozen: active_dof_count > 0 && free_dof_count == 0,
        certificate,
    };
    plan.validate_intrinsic()
        .map_err(|message| SelectionError::new("resolved_frozen_spins_invalid", message))?;
    plan.validate_against_active_mask(domain.active_mask)
        .map_err(|message| {
            SelectionError::new("selection_resolved_mask_outside_active_domain", message)
        })?;
    Ok(plan)
}

fn validate_domain(
    domain: &SelectionDomainView<'_>,
    request: &FrozenSpinsCompileRequest<'_>,
) -> Result<(), SelectionError> {
    let len = domain.points_m.len();
    if domain.active_mask.len() != len || domain.memberships.len() != len {
        return Err(SelectionError::new(
            "selection_domain_size_mismatch",
            format!(
                "point count {len}, active mask length {}, and membership length {} must match",
                domain.active_mask.len(),
                domain.memberships.len()
            ),
        ));
    }
    if domain
        .points_m
        .iter()
        .flatten()
        .any(|value| !value.is_finite())
    {
        return Err(SelectionError::new(
            "selection_invalid_geometry",
            "selection DOF points must contain finite world coordinates",
        ));
    }
    if domain.topology_fingerprint.is_empty()
        || domain.topology_fingerprint != request.expected_grid_or_mesh_fingerprint
    {
        return Err(SelectionError::new(
            "selection_topology_mismatch",
            format!(
                "resolved topology '{}' does not match expected topology '{}'",
                domain.topology_fingerprint, request.expected_grid_or_mesh_fingerprint
            ),
        ));
    }
    Ok(())
}

fn validate_state_snapshot(
    dof_count: usize,
    required: bool,
    request: &FrozenSpinsCompileRequest<'_>,
) -> Result<(), SelectionError> {
    let Some(snapshot) = request.state_snapshot else {
        if required {
            return Err(SelectionError::new(
                "selection_stale_revision",
                "snapshot membership requires a state snapshot and source revision",
            ));
        }
        return Ok(());
    };
    if snapshot.magnetization.len() != dof_count {
        return Err(SelectionError::new(
            "selection_state_size_mismatch",
            format!(
                "state snapshot length {} does not match DOF count {dof_count}",
                snapshot.magnetization.len()
            ),
        ));
    }
    if snapshot
        .magnetization
        .iter()
        .flatten()
        .any(|value| value.is_infinite())
    {
        return Err(SelectionError::new(
            "selection_invalid_state",
            "state snapshot contains infinite magnetization",
        ));
    }
    let expected = request.expected_source_state_revision.ok_or_else(|| {
        SelectionError::new(
            "selection_stale_revision",
            "snapshot membership requires an expected source state revision",
        )
    })?;
    if snapshot.revision != expected {
        return Err(SelectionError::new(
            "selection_stale_revision",
            format!(
                "state snapshot revision {} does not match expected revision {expected}",
                snapshot.revision
            ),
        ));
    }
    Ok(())
}

fn reference_map<'a>(
    references: &'a [ResolvedFrozenSpinsReference<'a>],
) -> Result<BTreeMap<&'a str, &'a ResolvedFrozenSpinsReference<'a>>, SelectionError> {
    let mut by_id = BTreeMap::new();
    for reference in references {
        if by_id.insert(reference.constraint_id, reference).is_some() {
            return Err(SelectionError::new(
                "frozen_reference_duplicate",
                format!(
                    "constraint '{}' has more than one resolved reference input",
                    reference.constraint_id
                ),
            ));
        }
    }
    Ok(by_id)
}

fn validate_reference(
    reference: &ResolvedFrozenSpinsReference<'_>,
    constraint: &FrozenSpinsIR,
    domain: &SelectionDomainView<'_>,
    request: &FrozenSpinsCompileRequest<'_>,
) -> Result<(), SelectionError> {
    if reference.values.len() != domain.points_m.len() {
        return Err(SelectionError::new(
            "frozen_reference_size_mismatch",
            format!(
                "constraint '{}' reference length {} does not match DOF count {}",
                constraint.id,
                reference.values.len(),
                domain.points_m.len()
            ),
        ));
    }
    if reference
        .values
        .iter()
        .flatten()
        .any(|value| !value.is_finite())
    {
        return Err(SelectionError::new(
            "frozen_reference_invalid",
            format!("constraint '{}' reference must be finite", constraint.id),
        ));
    }
    if reference.topology_fingerprint != domain.topology_fingerprint
        || reference.topology_fingerprint != request.expected_grid_or_mesh_fingerprint
    {
        return Err(SelectionError::new(
            "selection_topology_mismatch",
            format!(
                "constraint '{}' reference topology '{}' does not match resolved topology '{}'",
                constraint.id, reference.topology_fingerprint, domain.topology_fingerprint
            ),
        ));
    }
    if matches!(
        constraint.reference,
        FrozenReferencePolicyIR::CaptureCurrentAtActivation {}
    ) {
        match (
            request.expected_source_state_revision,
            reference.source_state_revision,
        ) {
            (Some(expected), Some(captured)) => {
                if captured != expected
                    || request
                        .state_snapshot
                        .is_some_and(|snapshot| snapshot.revision != captured)
                {
                    return Err(SelectionError::new(
                        "selection_stale_revision",
                        format!(
                            "constraint '{}' captured revision {captured} does not match activation revision {expected}",
                            constraint.id
                        ),
                    ));
                }
            }
            (None, None) => {
                // The runtime owns the atomic capture when no state snapshot
                // is available during static ProblemIR planning.
            }
            _ => {
                return Err(SelectionError::new(
                    "selection_stale_revision",
                    format!(
                        "constraint '{}' capture-current reference has an incomplete source revision",
                        constraint.id
                    ),
                ));
            }
        }
    }
    Ok(())
}

fn active_in_stage(constraint: &FrozenSpinsIR, request: &FrozenSpinsCompileRequest<'_>) -> bool {
    match &constraint.activation {
        ConstraintActivationIR::AllStages {} => true,
        ConstraintActivationIR::StageIds { stage_ids } => request
            .activation_stage_id
            .is_some_and(|stage_id| stage_ids.iter().any(|candidate| candidate == stage_id)),
    }
}

fn prepare_expression_realization(
    expression: &SelectionExprIR,
    domain: &SelectionDomainView<'_>,
    request: &FrozenSpinsCompileRequest<'_>,
    definitions: &BTreeMap<&str, &SelectionExprIR>,
    visiting: &mut BTreeSet<String>,
    geometry_cache: &mut BTreeMap<usize, GeometryPredicate>,
) -> Result<(), SelectionError> {
    match expression {
        SelectionExprIR::InsideGeometry {
            geometry,
            frame,
            boundary,
            ..
        } => {
            let transform = frame_transform(frame, request)?;
            geometry_cache.insert(
                expression as *const SelectionExprIR as usize,
                GeometryPredicate::from_ir(
                    geometry,
                    transform,
                    BoundaryMembership::from_ir(*boundary),
                )?,
            );
        }
        SelectionExprIR::Compare {
            lhs,
            rhs,
            tolerance,
            ..
        } => {
            if !tolerance.is_exact() {
                return Err(SelectionError::new(
                    "selection_compare_tolerance_unsupported",
                    "selection Compare tolerance must be exactly zero; use Approx for tolerant equality",
                ));
            }
            validate_scalar_realization(lhs, request)?;
            validate_scalar_realization(rhs, request)?;
        }
        SelectionExprIR::Approx {
            value: lhs,
            target: rhs,
            ..
        } => {
            validate_scalar_realization(lhs, request)?;
            validate_scalar_realization(rhs, request)?;
        }
        SelectionExprIR::Between { value, .. } => {
            validate_scalar_realization(value, request)?;
        }
        SelectionExprIR::And { expressions }
        | SelectionExprIR::Or { expressions }
        | SelectionExprIR::Xor { expressions } => {
            for child in expressions {
                prepare_expression_realization(
                    child,
                    domain,
                    request,
                    definitions,
                    visiting,
                    geometry_cache,
                )?;
            }
        }
        SelectionExprIR::Not { expression } => prepare_expression_realization(
            expression,
            domain,
            request,
            definitions,
            visiting,
            geometry_cache,
        )?,
        SelectionExprIR::Ref { selection_id } => {
            if !visiting.insert(selection_id.clone()) {
                return Err(SelectionError::new(
                    "selection_reference_cycle",
                    format!("selection reference cycle at '{selection_id}'"),
                ));
            }
            let resolved = definitions.get(selection_id.as_str()).ok_or_else(|| {
                SelectionError::new(
                    "selection_unknown_reference",
                    format!("selection '{selection_id}' does not exist"),
                )
            })?;
            let result = prepare_expression_realization(
                resolved,
                domain,
                request,
                definitions,
                visiting,
                geometry_cache,
            );
            visiting.remove(selection_id);
            result?;
        }
        SelectionExprIR::InObject { object_id } => {
            if !request.known_entities.object_ids.contains(object_id) {
                return Err(SelectionError::new(
                    "selection_unknown_object",
                    format!("selection references unknown object '{object_id}'"),
                ));
            }
        }
        SelectionExprIR::InRegion {
            object_id,
            region_id,
        } => {
            if !request.known_entities.object_ids.contains(object_id) {
                return Err(SelectionError::new(
                    "selection_unknown_object",
                    format!("selection references unknown object '{object_id}'"),
                ));
            }
            if !request
                .known_entities
                .region_ids
                .contains(&(object_id.clone(), region_id.clone()))
            {
                return Err(SelectionError::new(
                    "selection_unknown_region",
                    format!(
                        "selection references unknown region '{region_id}' in object '{object_id}'"
                    ),
                ));
            }
        }
        SelectionExprIR::AllMagnetic {} => {}
    }
    Ok(())
}

fn validate_scalar_realization(
    expression: &SelectionScalarExprIR,
    request: &FrozenSpinsCompileRequest<'_>,
) -> Result<(), SelectionError> {
    match expression {
        SelectionScalarExprIR::Coordinate { frame, .. } => {
            frame_transform(frame, request)?;
        }
        SelectionScalarExprIR::Abs { value } => validate_scalar_realization(value, request)?,
        SelectionScalarExprIR::Constant { .. }
        | SelectionScalarExprIR::MagnetizationComponent { .. }
        | SelectionScalarExprIR::MagnetizationNorm {}
        | SelectionScalarExprIR::MagnetizationDot { .. } => {}
    }
    Ok(())
}

fn evaluate_expression(
    expression: &SelectionExprIR,
    index: usize,
    domain: &SelectionDomainView<'_>,
    request: &FrozenSpinsCompileRequest<'_>,
    definitions: &BTreeMap<&str, &SelectionExprIR>,
    visiting: &mut BTreeSet<String>,
    geometry_cache: &BTreeMap<usize, GeometryPredicate>,
) -> Result<bool, SelectionError> {
    let membership = &domain.memberships[index];
    match expression {
        SelectionExprIR::AllMagnetic {} => Ok(domain.active_mask[index]),
        SelectionExprIR::InObject { object_id } => Ok(membership
            .object_ids
            .iter()
            .any(|candidate| candidate == object_id)),
        SelectionExprIR::InRegion {
            object_id,
            region_id,
        } => Ok(membership
            .region_ids
            .iter()
            .any(|(candidate_object, candidate_region)| {
                candidate_object == object_id && candidate_region == region_id
            })),
        SelectionExprIR::InsideGeometry { .. } => {
            let cache_key = expression as *const SelectionExprIR as usize;
            geometry_cache
                .get(&cache_key)
                .ok_or_else(|| {
                    SelectionError::new(
                        "selection_invalid_geometry",
                        "geometry predicate was not prepared before materialization",
                    )
                })?
                .contains(domain.points_m[index])
        }
        SelectionExprIR::Compare { lhs, op, rhs, .. } => {
            let left = evaluate_scalar(lhs, index, domain, request)?;
            let right = evaluate_scalar(rhs, index, domain, request)?;
            if left.is_nan() || right.is_nan() {
                return Ok(false);
            }
            Ok(match op {
                ComparisonOpIR::Lt => left < right,
                ComparisonOpIR::Le => left <= right,
                ComparisonOpIR::Gt => left > right,
                ComparisonOpIR::Ge => left >= right,
            })
        }
        SelectionExprIR::Approx {
            value,
            target,
            atol,
            rtol,
        } => {
            let value = evaluate_scalar(value, index, domain, request)?;
            let target = evaluate_scalar(target, index, domain, request)?;
            Ok(value.is_finite()
                && target.is_finite()
                && (value - target).abs() <= *atol + *rtol * value.abs().max(target.abs()))
        }
        SelectionExprIR::Between {
            value,
            lower,
            upper,
            closed,
        } => {
            let value = evaluate_scalar(value, index, domain, request)?;
            if value.is_nan() {
                return Ok(false);
            }
            Ok(match closed {
                ClosedIntervalIR::None => *lower < value && value < *upper,
                ClosedIntervalIR::Left => *lower <= value && value < *upper,
                ClosedIntervalIR::Right => *lower < value && value <= *upper,
                ClosedIntervalIR::Both => *lower <= value && value <= *upper,
            })
        }
        SelectionExprIR::And { expressions } => {
            for child in expressions {
                if !evaluate_expression(
                    child,
                    index,
                    domain,
                    request,
                    definitions,
                    visiting,
                    geometry_cache,
                )? {
                    return Ok(false);
                }
            }
            Ok(true)
        }
        SelectionExprIR::Or { expressions } => {
            for child in expressions {
                if evaluate_expression(
                    child,
                    index,
                    domain,
                    request,
                    definitions,
                    visiting,
                    geometry_cache,
                )? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        SelectionExprIR::Xor { expressions } => {
            let mut parity = false;
            for child in expressions {
                parity ^= evaluate_expression(
                    child,
                    index,
                    domain,
                    request,
                    definitions,
                    visiting,
                    geometry_cache,
                )?;
            }
            Ok(parity)
        }
        SelectionExprIR::Not { expression } => Ok(domain.active_mask[index]
            && !evaluate_expression(
                expression,
                index,
                domain,
                request,
                definitions,
                visiting,
                geometry_cache,
            )?),
        SelectionExprIR::Ref { selection_id } => {
            if !visiting.insert(selection_id.clone()) {
                return Err(SelectionError::new(
                    "selection_reference_cycle",
                    format!("selection reference cycle at '{selection_id}'"),
                ));
            }
            let resolved = definitions.get(selection_id.as_str()).ok_or_else(|| {
                SelectionError::new(
                    "selection_unknown_reference",
                    format!("selection '{selection_id}' does not exist"),
                )
            })?;
            let result = evaluate_expression(
                resolved,
                index,
                domain,
                request,
                definitions,
                visiting,
                geometry_cache,
            );
            visiting.remove(selection_id);
            result
        }
    }
}

fn evaluate_scalar(
    expression: &SelectionScalarExprIR,
    index: usize,
    domain: &SelectionDomainView<'_>,
    request: &FrozenSpinsCompileRequest<'_>,
) -> Result<f64, SelectionError> {
    match expression {
        SelectionScalarExprIR::Constant { value } => Ok(*value),
        SelectionScalarExprIR::Coordinate { component, frame } => {
            let point =
                world_point_in_frame(domain.points_m[index], frame_transform(frame, request)?)?;
            Ok(point[component_index(*component)])
        }
        SelectionScalarExprIR::MagnetizationComponent { component } => {
            Ok(state_value(request, index)?[component_index(*component)])
        }
        SelectionScalarExprIR::MagnetizationNorm {} => {
            let value = state_value(request, index)?;
            Ok(value
                .iter()
                .map(|component| component * component)
                .sum::<f64>()
                .sqrt())
        }
        SelectionScalarExprIR::MagnetizationDot { axis } => {
            let value = state_value(request, index)?;
            Ok(value
                .iter()
                .zip(axis)
                .map(|(left, right)| left * right)
                .sum())
        }
        SelectionScalarExprIR::Abs { value } => {
            Ok(evaluate_scalar(value, index, domain, request)?.abs())
        }
    }
}

fn state_value(
    request: &FrozenSpinsCompileRequest<'_>,
    index: usize,
) -> Result<[f64; 3], SelectionError> {
    request
        .state_snapshot
        .and_then(|snapshot| snapshot.magnetization.get(index).copied())
        .ok_or_else(|| {
            SelectionError::new(
                "selection_stale_revision",
                "state-dependent selection has no current snapshot value",
            )
        })
}

fn frame_transform(
    frame: &SelectionFrameIR,
    request: &FrozenSpinsCompileRequest<'_>,
) -> Result<AffineTransform3, SelectionError> {
    let transform = match frame {
        SelectionFrameIR::World {} => Ok(AffineTransform3::identity()),
        SelectionFrameIR::Object { object_id } => request
            .object_transforms
            .get(object_id)
            .copied()
            .ok_or_else(|| {
                SelectionError::new(
                    "selection_unknown_object",
                    format!("object frame references unknown object '{object_id}'"),
                )
            }),
    }?;
    validate_affine_transform(transform)?;
    Ok(transform)
}

fn component_index(component: CartesianComponentIR) -> usize {
    match component {
        CartesianComponentIR::X => 0,
        CartesianComponentIR::Y => 1,
        CartesianComponentIR::Z => 2,
    }
}

fn authored_selector_sha256(
    constraint: &FrozenSpinsIR,
    definitions: &[SelectionDefinitionIR],
) -> Result<String, SelectionError> {
    if let SelectionExprIR::Ref { selection_id } = &constraint.selector {
        return canonical_selection_sha256(selection_id, definitions)
            .map_err(|message| canonical_validation_error(message, "selection_unknown_reference"));
    }
    let root_id = format!("__frozen_spins_root__:{}", constraint.id);
    if definitions
        .iter()
        .any(|definition| definition.id == root_id)
    {
        return Err(SelectionError::new(
            "selection_duplicate_id",
            format!("reserved compiler selection id '{root_id}' is already authored"),
        ));
    }
    let mut graph = definitions.to_vec();
    graph.push(SelectionDefinitionIR {
        schema_version: SELECTION_EXPR_SCHEMA_VERSION.to_string(),
        id: root_id.clone(),
        name: None,
        expression: constraint.selector.clone(),
    });
    canonical_selection_sha256(&root_id, &graph)
        .map_err(|message| canonical_validation_error(message, "selection_invalid"))
}

fn canonical_validation_error(message: String, fallback_code: &'static str) -> SelectionError {
    let code = message
        .lines()
        .filter_map(|line| line.split_once(':').map(|(prefix, _)| prefix.trim()))
        .find(|prefix| prefix.starts_with("selection_"))
        .map(str::to_string)
        .unwrap_or_else(|| fallback_code.to_string());
    SelectionError::new(code, message)
}

fn selected_bounds(domain: &SelectionDomainView<'_>, mask: &[bool]) -> Option<[[f64; 3]; 2]> {
    let mut bounds = [[f64::INFINITY; 3], [f64::NEG_INFINITY; 3]];
    let mut any = false;
    for (point, selected) in domain.points_m.iter().zip(mask) {
        if !selected {
            continue;
        }
        any = true;
        for axis in 0..3 {
            bounds[0][axis] = bounds[0][axis].min(point[axis]);
            bounds[1][axis] = bounds[1][axis].max(point[axis]);
        }
    }
    any.then_some(bounds)
}

fn mask_sha256(mask: &[bool]) -> String {
    let mut hash = Sha256::new();
    hash.update((mask.len() as u64).to_le_bytes());
    hash.update(
        mask.iter()
            .map(|value| u8::from(*value))
            .collect::<Vec<_>>(),
    );
    format!("{:x}", hash.finalize())
}

fn reference_sha256(mask: &[bool], reference: &[Option<[f64; 3]>]) -> String {
    let mut hash = Sha256::new();
    hash.update((mask.len() as u64).to_le_bytes());
    for (selected, value) in mask.iter().zip(reference) {
        hash.update([u8::from(*selected)]);
        if let Some(value) = value {
            for component in value {
                hash.update(component.to_bits().to_le_bytes());
            }
        }
    }
    format!("{:x}", hash.finalize())
}

fn vector_bits_equal(left: [f64; 3], right: [f64; 3]) -> bool {
    left.iter()
        .zip(right)
        .all(|(left, right)| left.to_bits() == right.to_bits())
}
