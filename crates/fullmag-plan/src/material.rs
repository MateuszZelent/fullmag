use fullmag_expr::CompiledFunction;
use fullmag_ir::{
    GeometryEntryIR, MaterialFieldLocationIR, MaterialFieldPlan, MaterialFieldSourceKind,
    MaterialParameterFieldIR, MaterialParameterNameIR, ProblemIR, RegionFrameIR, RegionShapeIR,
};
use std::collections::BTreeSet;

use crate::region_conflict::{resolve_region_conflict, RegionConflictCandidate};

fn geometry_translation(entry: &GeometryEntryIR) -> [f64; 3] {
    match entry {
        GeometryEntryIR::Translate { base, by, .. } => {
            let nested = geometry_translation(base);
            [nested[0] + by[0], nested[1] + by[1], nested[2] + by[2]]
        }
        _ => [0.0, 0.0, 0.0],
    }
}

pub(crate) fn object_translation(problem: &ProblemIR, magnet_name: &str) -> [f64; 3] {
    let Some(magnet) = problem
        .magnets
        .iter()
        .find(|magnet| magnet.name == magnet_name)
    else {
        return [0.0, 0.0, 0.0];
    };
    let Some(region) = problem
        .regions
        .iter()
        .find(|region| region.name == magnet.region)
    else {
        return [0.0, 0.0, 0.0];
    };
    problem
        .geometry
        .entries
        .iter()
        .find(|entry| entry.name() == region.geometry)
        .map(geometry_translation)
        .unwrap_or([0.0, 0.0, 0.0])
}

fn signed_distance_to_region_shape(point: [f64; 3], shape: &RegionShapeIR) -> Result<f64, String> {
    match shape {
        RegionShapeIR::Box { size, center } => {
            let q = [
                (point[0] - center[0]).abs() - size[0] * 0.5,
                (point[1] - center[1]).abs() - size[1] * 0.5,
                (point[2] - center[2]).abs() - size[2] * 0.5,
            ];
            let outside = [q[0].max(0.0), q[1].max(0.0), q[2].max(0.0)];
            let outside_dist =
                (outside[0] * outside[0] + outside[1] * outside[1] + outside[2] * outside[2])
                    .sqrt();
            let inside_dist = q[0].max(q[1]).max(q[2]).min(0.0);
            Ok(outside_dist + inside_dist)
        }
        RegionShapeIR::Sphere { radius, center } => {
            let dx = point[0] - center[0];
            let dy = point[1] - center[1];
            let dz = point[2] - center[2];
            Ok((dx * dx + dy * dy + dz * dz).sqrt() - radius)
        }
        RegionShapeIR::Cylinder {
            radius,
            height,
            center,
            axis,
        } => {
            let axis_norm = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
            if axis_norm <= 0.0 {
                return Err("cylinder region axis must be non-zero".to_string());
            }
            let unit = [
                axis[0] / axis_norm,
                axis[1] / axis_norm,
                axis[2] / axis_norm,
            ];
            let rel = [
                point[0] - center[0],
                point[1] - center[1],
                point[2] - center[2],
            ];
            let axial = rel[0] * unit[0] + rel[1] * unit[1] + rel[2] * unit[2];
            let radial = [
                rel[0] - axial * unit[0],
                rel[1] - axial * unit[1],
                rel[2] - axial * unit[2],
            ];
            let radial_distance =
                (radial[0] * radial[0] + radial[1] * radial[1] + radial[2] * radial[2]).sqrt();
            let q = [radial_distance - radius, axial.abs() - height * 0.5];
            let outside = [q[0].max(0.0), q[1].max(0.0)];
            let outside_dist = (outside[0] * outside[0] + outside[1] * outside[1]).sqrt();
            let inside_dist = q[0].max(q[1]).min(0.0);
            Ok(outside_dist + inside_dist)
        }
        RegionShapeIR::Csg { .. } => Err(
            "FDM/FEM object region materialization does not yet support CSG region shapes"
                .to_string(),
        ),
    }
}

/// Sampling support and spacing in metres supplied by the discretization.
#[derive(Clone, Copy)]
pub(crate) enum MaterialSampling<'a> {
    Cells { spacing: f64, active_mask: Option<&'a [bool]> },
    Nodes { spacings: &'a [f64] },
}

impl<'a> MaterialSampling<'a> {
    fn spacing_at(self, index: usize) -> f64 {
        match self {
            Self::Cells { spacing, .. } => spacing,
            Self::Nodes { spacings } => spacings[index],
        }
    }

    fn active_mask(self) -> Option<&'a [bool]> {
        match self {
            Self::Cells { active_mask, .. } => active_mask,
            Self::Nodes { .. } => None,
        }
    }
}

/// Local nodal sampling length, independent of coordinate axes and other bodies.
pub(crate) fn fem_node_spacings(mesh: &fullmag_ir::MeshIR) -> Vec<f64> {
    let mut spacings = vec![f64::INFINITY; mesh.nodes.len()];
    for ordinal in 0..mesh.cell_count() {
        let Some(nodes) = mesh.cells.item_nodes(ordinal) else {
            continue;
        };
        for (offset, &a) in nodes.iter().enumerate() {
            for &b in &nodes[offset + 1..] {
                let (Some(pa), Some(pb)) = (mesh.nodes.get(a as usize), mesh.nodes.get(b as usize))
                else {
                    continue;
                };
                let distance = (pa[0] - pb[0]).hypot(pa[1] - pb[1]).hypot(pa[2] - pb[2]);
                if distance.is_finite() && distance > 0.0 {
                    spacings[a as usize] = spacings[a as usize].min(distance);
                    spacings[b as usize] = spacings[b as usize].min(distance);
                }
            }
        }
    }
    spacings
}

fn smoothstep01(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn transition_weight(
    distance: f64,
    transition: crate::material_transition::ResolvedMaterialTransition,
    point_spacing: f64,
) -> Result<f64, String> {
    use crate::material_transition::ResolvedMaterialTransition;

    let width = match transition {
        ResolvedMaterialTransition::None | ResolvedMaterialTransition::Sharp => {
            return Ok((distance <= 0.0) as u8 as f64);
        }
        ResolvedMaterialTransition::Metric { width, .. } => width,
        ResolvedMaterialTransition::MeshRelative { cells, .. } => {
            if !point_spacing.is_finite() || point_spacing <= 0.0 {
                return Err("mesh_relative material transition requires a finite positive local mesh spacing".to_string());
            }
            point_spacing * f64::from(cells)
        }
    };
    if !width.is_finite() || width <= 0.0 {
        return Err("material transition requires a finite positive width".to_string());
    }

    let scope = match transition {
        ResolvedMaterialTransition::MeshRelative { scope, .. }
        | ResolvedMaterialTransition::Metric { scope, .. } => scope,
        ResolvedMaterialTransition::Sharp | ResolvedMaterialTransition::None => unreachable!(),
    };
    Ok(match scope {
        fullmag_ir::MaterialTransitionScopeIR::Boundary => {
            1.0 - smoothstep01((distance + 0.5 * width) / width)
        }
        fullmag_ir::MaterialTransitionScopeIR::Inside => {
            if distance >= 0.0 {
                0.0
            } else {
                1.0 - smoothstep01((distance + width) / width)
            }
        }
        fullmag_ir::MaterialTransitionScopeIR::Outside => {
            if distance <= 0.0 {
                1.0
            } else {
                1.0 - smoothstep01(distance / width)
            }
        }
    })
}

fn frame_coordinates(
    frame: RegionFrameIR,
    world_point: [f64; 3],
    object_translation: [f64; 3],
) -> [f64; 3] {
    match frame {
        RegionFrameIR::World => world_point,
        RegionFrameIR::Object => [
            world_point[0] - object_translation[0],
            world_point[1] - object_translation[1],
            world_point[2] - object_translation[2],
        ],
    }
}

/// Value of an authored field at one sample point. `compiled` is the equation
/// of a `function` field, compiled once per resolution by
/// `MaterialParameterFieldIR::compile_function`; other kinds ignore it.
pub(crate) fn evaluate_parameter_field(
    field: &MaterialParameterFieldIR,
    compiled: Option<&CompiledFunction>,
    world_point: [f64; 3],
    object_translation: [f64; 3],
) -> Result<f64, String> {
    match field {
        MaterialParameterFieldIR::Constant { value, .. } => {
            if let Some(f) = value.as_f64() {
                Ok(f)
            } else if let Some(i) = value.as_i64() {
                Ok(i as f64)
            } else {
                Err(format!(
                    "invalid constant parameter field value: {:?}",
                    value
                ))
            }
        }
        MaterialParameterFieldIR::Linear {
            base,
            gradient,
            frame,
            ..
        } => {
            let coords = frame_coordinates(*frame, world_point, object_translation);
            Ok(*base + gradient[0] * coords[0] + gradient[1] * coords[1] + gradient[2] * coords[2])
        }
        MaterialParameterFieldIR::Radial {
            center,
            radius,
            inside,
            outside,
            frame,
            ..
        } => {
            let coords = frame_coordinates(*frame, world_point, object_translation);
            let dx = coords[0] - center[0];
            let dy = coords[1] - center[1];
            let dz = coords[2] - center[2];
            let dist = (dx * dx + dy * dy + dz * dz).sqrt();
            if dist <= *radius {
                Ok(*inside)
            } else {
                Ok(*outside)
            }
        }
        MaterialParameterFieldIR::Sampled { .. } => Err(
            "sampled parameter field kind is not yet supported for pointwise resolution"
                .to_string(),
        ),
        MaterialParameterFieldIR::Function { frame, .. } => {
            let compiled = compiled.ok_or_else(|| {
                "function parameter field was not compiled before sampling".to_string()
            })?;
            Ok(compiled.eval_field(frame_coordinates(*frame, world_point, object_translation)))
        }
    }
}

pub(crate) fn resolve_spatial_parameter(
    problem: &ProblemIR,
    owner_object_id: &str,
    parameter: MaterialParameterNameIR,
    base_value: f64,
    points: &[[f64; 3]],
    sampling: MaterialSampling<'_>,
    object_translation: [f64; 3],
) -> Result<Vec<f64>, String> {
    resolve_spatial_parameter_excluding_regions(
        problem,
        owner_object_id,
        parameter,
        base_value,
        points,
        sampling,
        object_translation,
        &BTreeSet::new(),
    )
}

pub(crate) fn resolve_spatial_parameter_excluding_regions(
    problem: &ProblemIR,
    owner_object_id: &str,
    parameter: MaterialParameterNameIR,
    base_value: f64,
    points: &[[f64; 3]],
    sampling: MaterialSampling<'_>,
    object_translation: [f64; 3],
    excluded_region_ids: &BTreeSet<String>,
) -> Result<Vec<f64>, String> {
    if let MaterialSampling::Nodes { spacings } = sampling {
        if spacings.len() != points.len() {
            return Err("material sampling spacing count must match sample points".to_string());
        }
    }
    // Solvers identify a magnet by its name; region ownership uses its immutable ID.
    let owner_object_id = problem.magnets.iter().find(|magnet| magnet.name == owner_object_id)
        .and_then(|magnet| magnet.object_id.as_deref()).unwrap_or(owner_object_id);
    // Gather active object regions for this owner
    let enabled_regions = problem
        .object_regions
        .iter()
        .filter(|r| r.enabled && r.owner_object == owner_object_id)
        .collect::<Vec<_>>();

    let mut overrides = Vec::new();
    for region in &enabled_regions {
        if excluded_region_ids.contains(&region.region_id) {
            continue;
        }
        for material_override in &region.material_overrides {
            if material_override.parameter == parameter {
                overrides.push((
                    Some(region.region_id.as_str()),
                    material_override.priority,
                    &material_override.value,
                    Some(*region),
                    region.frame,
                    material_override.conflict_policy,
                    format!("region:{}", region.region_id),
                ));
            }
        }
    }

    // Material parameter fields matching owner and parameter
    for field in &problem.material_parameter_fields {
        if field.owner_object == owner_object_id && field.parameter == parameter {
            if field
                .region_id
                .as_ref()
                .is_some_and(|region_id| excluded_region_ids.contains(region_id))
            {
                continue;
            }
            let active = if let Some(region_id) = field.region_id.as_deref() {
                enabled_regions.iter().any(|r| r.region_id == region_id)
            } else {
                true
            };
            if active {
                let region = field
                    .region_id
                    .as_ref()
                    .and_then(|rid| enabled_regions.iter().find(|r| &r.region_id == rid));
                overrides.push((
                    field.region_id.as_deref(),
                    field.priority,
                    &field.value,
                    region.copied(),
                    region.map(|r| r.frame).unwrap_or(RegionFrameIR::Object),
                    field.conflict_policy,
                    format!("assignment:{}", field.assignment_id),
                ));
            }
        }
    }

    // Sort overrides/assignments by priority desc, then by region_id to keep sort stable
    overrides.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    // Equations of `function` fields, compiled once and evaluated at every point.
    let compiled_functions = overrides
        .iter()
        .map(|(_, _, value, _, _, _, source_id)| {
            value
                .compile_function(parameter)
                .transpose()
                .map_err(|error| format!("{source_id}: {error}"))
        })
        .collect::<Result<Vec<_>, String>>()?;

    // A sharp transition, or none, needs only membership, which CSG regions
    // provide without a signed distance. Compile those predicates once.
    let membership_predicates = overrides
        .iter()
        .map(|&(_, _, _, region_opt, ..)| {
            let Some(region) = region_opt else {
                return Ok(None);
            };
            let RegionShapeIR::Csg { expression } = &region.shape else {
                return Ok(None);
            };
            match crate::material_transition::resolved_region_transition(region, parameter) {
                crate::material_transition::ResolvedMaterialTransition::None
                | crate::material_transition::ResolvedMaterialTransition::Sharp => {
                    crate::selection::geometry::GeometryPredicate::from_geometry_entry(
                        expression,
                        crate::selection::geometry::AffineTransform3::identity(),
                        crate::selection::geometry::BoundaryMembership::inclusive(),
                    )
                    .map(Some)
                    .map_err(|err| err.to_string())
                }
                _ => Ok(None),
            }
        })
        .collect::<Result<Vec<_>, String>>()?;

    let mut resolved_values = if overrides.is_empty() {
        vec![base_value; points.len()]
    } else {
        let mut resolved_values = Vec::with_capacity(points.len());
        for (point_index, &point) in points.iter().enumerate() {
            let mut active_at_point = Vec::new();
            for (
                override_index,
                &(region_id, priority, value, region_opt, frame, policy, ref source_id),
            ) in overrides.iter().enumerate()
            {
                let weight = if let Some(region) = region_opt {
                    let coords = match frame {
                        RegionFrameIR::World => point,
                        RegionFrameIR::Object => [
                            point[0] - object_translation[0],
                            point[1] - object_translation[1],
                            point[2] - object_translation[2],
                        ],
                    };
                    let transition =
                        crate::material_transition::resolved_region_transition(region, parameter);
                    let distance = match &membership_predicates[override_index] {
                        Some(predicate) => {
                            if predicate.contains(coords).map_err(|err| err.to_string())? {
                                -1.0
                            } else {
                                1.0
                            }
                        }
                        None => signed_distance_to_region_shape(coords, &region.shape)?,
                    };
                    transition_weight(distance, transition, sampling.spacing_at(point_index))?
                } else {
                    1.0
                };
                if weight > 0.0 {
                    active_at_point.push((
                        region_id,
                        priority,
                        value,
                        weight,
                        policy,
                        source_id.to_string(),
                        compiled_functions[override_index].as_ref(),
                    ));
                }
            }

            if active_at_point.is_empty() {
                resolved_values.push(base_value);
            } else {
                let candidates = active_at_point
                    .iter()
                    .map(|entry| RegionConflictCandidate {
                        region_id: entry.5.clone(),
                        priority: entry.1,
                        policy: entry.4,
                    })
                    .collect::<Vec<_>>();
                let resolution = resolve_region_conflict(&candidates).map_err(|reason| {
                    format!(
                        "region-owned material parameter conflict: overlapping regions assign different values for {:?}; {reason}",
                        parameter,
                    )
                })?;
                if resolution.policy == fullmag_ir::RegionConflictPolicyIR::MinMeshSizeWins {
                    return Err(format!(
                        "region-owned material parameter conflict: overlapping regions assign different values for {:?}; min_mesh_size_wins is only valid for mesh-size ownership",
                        parameter
                    ));
                }
                let selected = active_at_point
                    .iter()
                    .find(|entry| entry.5.as_str() == resolution.winner_region_id.as_str())
                    .expect("resolver winner must be one of the active candidates");
                let value =
                    evaluate_parameter_field(selected.2, selected.6, point, object_translation)?;
                validate_resolved_parameter_value(parameter, value).map_err(|error| {
                    if matches!(selected.2, MaterialParameterFieldIR::Function { .. }) {
                        // The equation decides where a value leaves the range.
                        format!(
                            "{error} (function field {} at world point {point:?} m)",
                            selected.5
                        )
                    } else {
                        error
                    }
                })?;
                resolved_values.push(base_value + selected.3 * (value - base_value));
            }
        }
        resolved_values
    };
    if parameter == MaterialParameterNameIR::Alpha {
        apply_absorbing_boundary_layer(
            problem,
            owner_object_id,
            &mut resolved_values,
            points,
            sampling.active_mask(),
            object_translation,
        )?;
    }
    Ok(resolved_values)
}

fn validate_resolved_parameter_value(
    parameter: MaterialParameterNameIR,
    value: f64,
) -> Result<(), String> {
    if !value.is_finite() {
        return Err(format!(
            "resolved region-owned material parameter {:?} must be finite",
            parameter
        ));
    }
    let valid = match parameter {
        MaterialParameterNameIR::Ms => value > 0.0,
        MaterialParameterNameIR::Aex | MaterialParameterNameIR::Alpha => value >= 0.0,
        _ => true,
    };
    if valid {
        Ok(())
    } else {
        Err(format!(
            "resolved region-owned material parameter {:?} has invalid value {}",
            parameter, value
        ))
    }
}

fn universe_bounds(problem: &ProblemIR) -> Option<[f64; 6]> {
    let universe = problem
        .problem_meta
        .runtime_metadata
        .get("study_universe")?
        .as_object()?;
    let size = universe.get("size")?.as_array()?;
    let center = universe.get("center")?.as_array()?;
    let size = [
        size.first()?.as_f64()?,
        size.get(1)?.as_f64()?,
        size.get(2)?.as_f64()?,
    ];
    let center = [
        center.first()?.as_f64()?,
        center.get(1)?.as_f64()?,
        center.get(2)?.as_f64()?,
    ];
    if !size.iter().all(|value| value.is_finite() && *value > 0.0)
        || !center.iter().all(|value| value.is_finite())
    {
        return None;
    }
    Some([
        center[0] - 0.5 * size[0],
        center[1] - 0.5 * size[1],
        center[2] - 0.5 * size[2],
        center[0] + 0.5 * size[0],
        center[1] + 0.5 * size[1],
        center[2] + 0.5 * size[2],
    ])
}

#[path = "spatial_absorber.rs"]
mod spatial_absorber;
use spatial_absorber::apply_absorbing_boundary_layer;
pub use spatial_absorber::validate_absorbing_region_boundary;

pub(crate) fn build_material_field_plans(
    problem: &ProblemIR,
    owner_id: &str,
    location: MaterialFieldLocationIR,
) -> Vec<MaterialFieldPlan> {
    let mut plans = Vec::new();
    let parameters = [
        MaterialParameterNameIR::Ms,
        MaterialParameterNameIR::Aex,
        MaterialParameterNameIR::Alpha,
    ];

    let enabled_regions = problem
        .object_regions
        .iter()
        .filter(|r| r.enabled && r.owner_object == owner_id)
        .collect::<Vec<_>>();

    for param in parameters {
        let has_overrides = enabled_regions
            .iter()
            .any(|r| r.material_overrides.iter().any(|o| o.parameter == param));
        let has_assignments = problem
            .material_parameter_fields
            .iter()
            .any(|f| f.owner_object == owner_id && f.parameter == param);

        if has_overrides || has_assignments {
            let mut source_kind = MaterialFieldSourceKind::Override;
            let mut requires_sampling = false;
            let mut requires_mesh_revision = false;

            for r in &enabled_regions {
                for o in &r.material_overrides {
                    if o.parameter == param {
                        if !matches!(o.value, MaterialParameterFieldIR::Constant { .. }) {
                            source_kind = MaterialFieldSourceKind::Gradient;
                            requires_sampling = true;
                        }
                        match crate::material_transition::resolved_region_transition(r, param) {
                            crate::material_transition::ResolvedMaterialTransition::MeshRelative {
                                ..
                            } => {
                                requires_sampling = true;
                                requires_mesh_revision = true;
                            }
                            crate::material_transition::ResolvedMaterialTransition::Metric {
                                ..
                            } => {
                                requires_sampling = true;
                            }
                            crate::material_transition::ResolvedMaterialTransition::Sharp
                            | crate::material_transition::ResolvedMaterialTransition::None => {}
                        }
                    }
                }
            }
            for f in &problem.material_parameter_fields {
                if f.owner_object == owner_id && f.parameter == param {
                    if !matches!(f.value, MaterialParameterFieldIR::Constant { .. }) {
                        source_kind = MaterialFieldSourceKind::Gradient;
                        requires_sampling = true;
                    }
                    if let Some(region_id) = f.region_id.as_deref() {
                        if let Some(region) = enabled_regions
                            .iter()
                            .find(|region| region.region_id == region_id)
                        {
                            match crate::material_transition::resolved_region_transition(
                                region, param,
                            ) {
                                crate::material_transition::ResolvedMaterialTransition::MeshRelative {
                                    ..
                                } => {
                                    requires_sampling = true;
                                    requires_mesh_revision = true;
                                }
                                crate::material_transition::ResolvedMaterialTransition::Metric {
                                    ..
                                } => {
                                    requires_sampling = true;
                                }
                                crate::material_transition::ResolvedMaterialTransition::Sharp
                                | crate::material_transition::ResolvedMaterialTransition::None => {}
                            }
                        }
                    }
                }
            }

            plans.push(MaterialFieldPlan {
                object_id: owner_id.to_string(),
                parameter: param,
                source_kind,
                realization_location: location,
                requires_sampling,
                requires_mesh_revision,
                warnings: Vec::new(),
                realization_method: None,
                statistics: None,
            });
        }
    }
    plans
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{AbsorbingBoundaryFaceIR, AbsorbingBoundaryFrameIR, AbsorbingBoundaryLayerIR, AbsorbingBoundaryProfileIR};

    fn layer(profile: AbsorbingBoundaryProfileIR) -> AbsorbingBoundaryLayerIR {
        AbsorbingBoundaryLayerIR {
            total_width_m: 4.0,
            ramp_width_m: 2.0,
            max_damping: 0.5,
            faces: vec![AbsorbingBoundaryFaceIR::XPlus],
            profile,
            frame: AbsorbingBoundaryFrameIR::Object,
            expression: None,
        }
    }

    #[test]
    fn absorbing_boundary_uses_smootherstep_and_adds_to_base_alpha() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.magnets[0].absorbing_boundary =
            Some(layer(AbsorbingBoundaryProfileIR::Smootherstep).into());
        let points = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [3.0, 0.0, 0.0],
            [4.0, 0.0, 0.0],
        ];
        let values = resolve_spatial_parameter(
            &problem,
            "strip",
            MaterialParameterNameIR::Alpha,
            0.1,
            &points,
            MaterialSampling::Cells { spacing: 1.0, active_mask: None },
            [0.0, 0.0, 0.0],
        )
        .expect("alpha profile should resolve");
        assert_eq!(values[0], 0.1);
        assert!((values[1] - 0.35).abs() < 1e-12);
        assert!((values[2] - 0.6).abs() < 1e-12);
        assert!((values[3] - 0.6).abs() < 1e-12);
    }

    #[test]
    fn absorbing_boundary_profiles_materialize_ramp_and_plateau() {
        use AbsorbingBoundaryProfileIR::{Custom, Logarithmic, Tanh};

        let points = [
            [0.0, 0.0, 0.0],
            [6.0, 0.0, 0.0],
            [7.0, 0.0, 0.0],
            [9.0, 0.0, 0.0],
            [10.0, 0.0, 0.0],
        ];
        let mut problem = ProblemIR::bootstrap_example();
        for (profile, expression, midpoint) in [
            (Logarithmic, None, 5.5_f64.ln() / 10.0_f64.ln()),
            (Tanh, None, 0.5),
            (Custom, Some("u**3"), 0.125),
        ] {
            let mut config = layer(profile);
            config.expression = expression.map(str::to_string);
            problem.magnets[0].absorbing_boundary = Some(config.into());
            let mut values = [0.1; 5];
            apply_absorbing_boundary_layer(&problem, "strip", &mut values, &points, None, [0.0; 3])
                .expect("profile should materialize");
            assert_eq!(values[0], 0.1);
            assert_eq!(values[1], 0.1);
            assert!((values[2] - (0.1 + 0.5 * midpoint)).abs() < 1e-12);
            assert_eq!(values[3..], [0.6, 0.6]);
        }
    }

    #[test]
    fn absorbing_boundary_checks_unprobed_sample_during_materialization() {
        let mut problem = ProblemIR::bootstrap_example();
        let mut config = layer(AbsorbingBoundaryProfileIR::Custom);
        // A dyadic pole lies exactly between the validation samples.
        config.expression = Some("u*(u-0.009765625)/(u-0.009765625)".into());
        config.compile_profile().expect("probe should pass");
        config.total_width_m = 1.0;
        config.ramp_width_m = 1.0;
        config.faces = vec![AbsorbingBoundaryFaceIR::XMinus];
        problem.magnets[0].absorbing_boundary = Some(config.into());
        let mut values = [0.1; 2];
        let points = [[0.0, 0.0, 0.0], [507.0 / 512.0, 0.0, 0.0]];
        let error = apply_absorbing_boundary_layer(&problem, "strip", &mut values, &points, None, [0.0; 3])
            .unwrap_err();
        assert!(error.contains("expression is undefined"));
    }

    fn alpha_function_assignment(
        frame: &str,
        outputs: &str,
    ) -> fullmag_ir::MaterialParameterAssignmentIR {
        serde_json::from_value(serde_json::json!({
            "assignment_id": "strip:object:alpha", "owner_object": "strip", "parameter": "alpha",
            "value": {"kind": "function", "frame": frame, "function": {
                "expression_version": "field_expr.v1",
                "parameters": [{"name": "a0", "value": 0.02}, {"name": "g", "value": 0.01}],
                "outputs": [outputs]}}
        }))
        .unwrap()
    }

    #[test]
    fn function_field_is_sampled_in_its_frame_at_cells_and_nodes() {
        let points = [[0.0, 0.0, 0.0], [1.0, 2.0, 0.0], [3.0, 0.0, 1.0]];
        let translation = [1.0, -1.0, 0.0];
        for (frame, origin) in [("object", translation), ("world", [0.0; 3])] {
            let mut problem = ProblemIR::bootstrap_example();
            problem
                .material_parameter_fields
                .push(alpha_function_assignment(frame, "a0 + g*x + g*y**2"));
            let expected: Vec<f64> = points
                .iter()
                .map(|p| {
                    let (x, y) = (p[0] - origin[0], p[1] - origin[1]);
                    0.02 + 0.01 * x + 0.01 * y.powf(2.0)
                })
                .collect();
            for sampling in [
                MaterialSampling::Cells { spacing: 1.0, active_mask: None },
                MaterialSampling::Nodes { spacings: &[1.0; 3] },
            ] {
                let values = resolve_spatial_parameter(
                    &problem,
                    "strip",
                    MaterialParameterNameIR::Alpha,
                    0.5,
                    &points,
                    sampling,
                    translation,
                )
                .expect("function alpha should resolve");
                // The field replaces the base value through `base + w (value - base)`.
                for (value, expected) in values.iter().zip(&expected) {
                    assert!((value - expected).abs() < 1e-15, "frame {frame}: {value} {expected}");
                }
            }
        }
    }

    #[test]
    fn absorbing_boundary_adds_on_top_of_a_function_field() {
        let mut problem = ProblemIR::bootstrap_example();
        problem
            .material_parameter_fields
            .push(alpha_function_assignment("object", "a0 + g*x"));
        problem.magnets[0].absorbing_boundary =
            Some(layer(AbsorbingBoundaryProfileIR::Smootherstep).into());
        let points = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [3.0, 0.0, 0.0], [4.0, 0.0, 0.0]];
        let values = resolve_spatial_parameter(
            &problem,
            "strip",
            MaterialParameterNameIR::Alpha,
            0.1,
            &points,
            MaterialSampling::Cells { spacing: 1.0, active_mask: None },
            [0.0; 3],
        )
        .unwrap();
        // Increments of the smootherstep layer from the test above: 0, 0.25, 0.5, 0.5.
        for (index, added) in [0.0, 0.25, 0.5, 0.5].into_iter().enumerate() {
            let field = 0.02 + 0.01 * points[index][0];
            assert!((values[index] - (field + added)).abs() < 1e-12, "{index}: {}", values[index]);
        }
    }

    #[test]
    fn function_field_values_are_checked_against_the_parameter_range() {
        let mut problem = ProblemIR::bootstrap_example();
        problem
            .material_parameter_fields
            .push(alpha_function_assignment("object", "a0 - g*x"));
        let error = resolve_spatial_parameter(
            &problem,
            "strip",
            MaterialParameterNameIR::Alpha,
            0.1,
            &[[1.0, 0.0, 0.0], [3.0, 0.0, 0.0]],
            MaterialSampling::Cells { spacing: 1.0, active_mask: None },
            [0.0; 3],
        )
        .unwrap_err();
        assert!(
            error.contains("Alpha has invalid value")
                && error.contains("function field assignment:strip:object:alpha")
                && error.contains("[3.0, 0.0, 0.0]"),
            "{error}"
        );

        let mut problem = ProblemIR::bootstrap_example();
        problem
            .material_parameter_fields
            .push(alpha_function_assignment("object", "a0 + 1/(x - 1)"));
        let error = resolve_spatial_parameter(
            &problem,
            "strip",
            MaterialParameterNameIR::Alpha,
            0.1,
            &[[1.0, 0.0, 0.0]],
            MaterialSampling::Cells { spacing: 1.0, active_mask: None },
            [0.0; 3],
        )
        .unwrap_err();
        assert!(error.contains("must be finite"), "{error}");
    }

    #[test]
    fn absorbing_boundary_combines_faces_by_maximum() {
        let mut problem = ProblemIR::bootstrap_example();
        let mut config = layer(AbsorbingBoundaryProfileIR::Linear);
        config.faces = vec![
            AbsorbingBoundaryFaceIR::XPlus,
            AbsorbingBoundaryFaceIR::YPlus,
        ];
        problem.magnets[0].absorbing_boundary = Some(config.into());
        let points = vec![[4.0, 4.0, 0.0]];
        let values = resolve_spatial_parameter(
            &problem,
            "strip",
            MaterialParameterNameIR::Alpha,
            0.1,
            &points,
            MaterialSampling::Cells { spacing: 1.0, active_mask: None },
            [0.0, 0.0, 0.0],
        )
        .expect("corner profile should resolve");
        assert!((values[0] - 0.6).abs() < 1e-12);
    }
}

#[cfg(test)]
#[path = "material_audit_tests.rs"]
mod material_audit_tests;
