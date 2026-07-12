use fullmag_ir::{
    GeometryEntryIR, MaterialFieldLocationIR, MaterialFieldPlan, MaterialFieldSourceKind,
    MaterialParameterFieldIR, MaterialParameterNameIR, ProblemIR, RegionFrameIR, RegionShapeIR,
};
use std::collections::BTreeSet;

fn geometry_translation(entry: &GeometryEntryIR) -> [f64; 3] {
    match entry {
        GeometryEntryIR::Translate { base, by, .. } => {
            let nested = geometry_translation(base);
            [nested[0] + by[0], nested[1] + by[1], nested[2] + by[2]]
        }
        _ => [0.0, 0.0, 0.0],
    }
}

pub(crate) fn object_translation(problem: &ProblemIR, object_id: &str) -> [f64; 3] {
    let Some(magnet) = problem
        .magnets
        .iter()
        .find(|magnet| magnet.name == object_id)
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

fn characteristic_point_spacing(points: &[[f64; 3]]) -> Option<f64> {
    let mut best = f64::INFINITY;
    for axis in 0..3 {
        let mut coords = points.iter().map(|point| point[axis]).collect::<Vec<_>>();
        coords.sort_by(f64::total_cmp);
        for pair in coords.windows(2) {
            let delta = (pair[1] - pair[0]).abs();
            if delta > 0.0 && delta < best {
                best = delta;
            }
        }
    }
    best.is_finite().then_some(best)
}

fn smoothstep01(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn transition_weight(
    distance: f64,
    transition: crate::material_transition::ResolvedMaterialTransition,
    point_spacing: Option<f64>,
) -> f64 {
    use crate::material_transition::ResolvedMaterialTransition;

    let width = match transition {
        ResolvedMaterialTransition::None | ResolvedMaterialTransition::Sharp => {
            return (distance <= 0.0) as u8 as f64;
        }
        ResolvedMaterialTransition::Metric { width, .. } => width,
        ResolvedMaterialTransition::MeshRelative { cells, .. } => {
            point_spacing.unwrap_or(0.0) * f64::from(cells)
        }
    };
    if width <= 0.0 {
        return (distance <= 0.0) as u8 as f64;
    }

    let scope = match transition {
        ResolvedMaterialTransition::MeshRelative { scope, .. }
        | ResolvedMaterialTransition::Metric { scope, .. } => scope,
        ResolvedMaterialTransition::Sharp | ResolvedMaterialTransition::None => unreachable!(),
    };
    match scope {
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
    }
}

pub(crate) fn evaluate_parameter_field(
    field: &MaterialParameterFieldIR,
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
            let coords = match frame {
                RegionFrameIR::World => world_point,
                RegionFrameIR::Object => [
                    world_point[0] - object_translation[0],
                    world_point[1] - object_translation[1],
                    world_point[2] - object_translation[2],
                ],
            };
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
            let coords = match frame {
                RegionFrameIR::World => world_point,
                RegionFrameIR::Object => [
                    world_point[0] - object_translation[0],
                    world_point[1] - object_translation[1],
                    world_point[2] - object_translation[2],
                ],
            };
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
    }
}

pub(crate) fn resolve_spatial_parameter(
    problem: &ProblemIR,
    owner_object_id: &str,
    parameter: MaterialParameterNameIR,
    base_value: f64,
    points: &[[f64; 3]],
    object_translation: [f64; 3],
) -> Result<Vec<f64>, String> {
    resolve_spatial_parameter_excluding_regions(
        problem,
        owner_object_id,
        parameter,
        base_value,
        points,
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
    object_translation: [f64; 3],
    excluded_region_ids: &BTreeSet<String>,
) -> Result<Vec<f64>, String> {
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
                ));
            }
        }
    }

    // Sort overrides/assignments by priority desc, then by region_id to keep sort stable
    overrides.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

    if overrides.is_empty() {
        return Ok(vec![base_value; points.len()]);
    }

    let point_spacing = characteristic_point_spacing(points);
    let mut resolved_values = Vec::with_capacity(points.len());
    for &point in points {
        let mut active_at_point = Vec::new();
        for &(region_id, priority, value, region_opt, frame) in &overrides {
            let weight = if let Some(region) = region_opt {
                let coords = match frame {
                    RegionFrameIR::World => point,
                    RegionFrameIR::Object => [
                        point[0] - object_translation[0],
                        point[1] - object_translation[1],
                        point[2] - object_translation[2],
                    ],
                };
                let distance = signed_distance_to_region_shape(coords, &region.shape)?;
                let transition =
                    crate::material_transition::resolved_region_transition(region, parameter);
                transition_weight(distance, transition, point_spacing)
            } else {
                1.0
            };
            if weight > 0.0 {
                active_at_point.push((region_id, priority, value, weight));
            }
        }

        if active_at_point.is_empty() {
            resolved_values.push(base_value);
        } else {
            let max_priority = active_at_point[0].1;
            let highest_priority_entries = active_at_point
                .iter()
                .filter(|entry| entry.1 == max_priority)
                .collect::<Vec<_>>();

            let mut evaluated_values = Vec::new();
            for entry in &highest_priority_entries {
                let val = evaluate_parameter_field(entry.2, point, object_translation)?;
                evaluated_values.push((entry.0, val, entry.3));
            }

            let first_val = evaluated_values[0].1;
            let first_weight = evaluated_values[0].2;
            for &(_, val, weight) in &evaluated_values[1..] {
                if (val - first_val).abs() > 1e-12 {
                    return Err(format!(
                        "region-owned material parameter conflict: overlapping regions assign different values for {:?} at priority {} (values: {} vs {})",
                        parameter, max_priority, first_val, val
                    ));
                }
                if (weight - first_weight).abs() > 1e-12 {
                    return Err(format!(
                        "region-owned material parameter conflict: overlapping regions assign different transition weights for {:?} at priority {}",
                        parameter, max_priority
                    ));
                }
            }
            validate_resolved_parameter_value(parameter, first_val)?;
            resolved_values.push(base_value + first_weight * (first_val - base_value));
        }
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
