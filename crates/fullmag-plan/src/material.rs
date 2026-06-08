use fullmag_ir::{
    GeometryEntryIR, MaterialFieldLocationIR, MaterialFieldPlan, MaterialFieldSourceKind,
    MaterialParameterFieldIR, MaterialParameterNameIR, ProblemIR, RegionFrameIR, RegionShapeIR,
};

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

pub(crate) fn point_in_region_shape(
    point: [f64; 3],
    shape: &RegionShapeIR,
) -> Result<bool, String> {
    match shape {
        RegionShapeIR::Box { size, center } => Ok((0..3).all(|axis| {
            let half = size[axis] * 0.5;
            point[axis] >= center[axis] - half && point[axis] <= center[axis] + half
        })),
        RegionShapeIR::Sphere { radius, center } => {
            let dx = point[0] - center[0];
            let dy = point[1] - center[1];
            let dz = point[2] - center[2];
            Ok(dx * dx + dy * dy + dz * dz <= radius * radius)
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
            if axial.abs() > height * 0.5 {
                return Ok(false);
            }
            let radial = [
                rel[0] - axial * unit[0],
                rel[1] - axial * unit[1],
                rel[2] - axial * unit[2],
            ];
            Ok(
                radial[0] * radial[0] + radial[1] * radial[1] + radial[2] * radial[2]
                    <= radius * radius,
            )
        }
        RegionShapeIR::Csg { .. } => Err(
            "FDM/FEM object region materialization does not yet support CSG region shapes"
                .to_string(),
        ),
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
    // Gather active object regions for this owner
    let enabled_regions = problem
        .object_regions
        .iter()
        .filter(|r| r.enabled && r.owner_object == owner_object_id)
        .collect::<Vec<_>>();

    let mut overrides = Vec::new();
    for region in &enabled_regions {
        for material_override in &region.material_overrides {
            if material_override.parameter == parameter {
                overrides.push((
                    Some(region.region_id.as_str()),
                    material_override.priority,
                    &material_override.value,
                    Some(&region.shape),
                    region.frame,
                ));
            }
        }
    }

    // Material parameter fields matching owner and parameter
    for field in &problem.material_parameter_fields {
        if field.owner_object == owner_object_id && field.parameter == parameter {
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
                    region.map(|r| &r.shape),
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

    let mut resolved_values = Vec::with_capacity(points.len());
    for &point in points {
        let mut active_at_point = Vec::new();
        for &(region_id, priority, value, shape_opt, frame) in &overrides {
            let applies = if let Some(shape) = shape_opt {
                let coords = match frame {
                    RegionFrameIR::World => point,
                    RegionFrameIR::Object => [
                        point[0] - object_translation[0],
                        point[1] - object_translation[1],
                        point[2] - object_translation[2],
                    ],
                };
                point_in_region_shape(coords, shape)?
            } else {
                true
            };
            if applies {
                active_at_point.push((region_id, priority, value));
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
                evaluated_values.push((entry.0, val));
            }

            let first_val = evaluated_values[0].1;
            for &(_, val) in &evaluated_values[1..] {
                if (val - first_val).abs() > 1e-12 {
                    return Err(format!(
                        "region-owned material parameter conflict: overlapping regions assign different values for {:?} at priority {} (values: {} vs {})",
                        parameter, max_priority, first_val, val
                    ));
                }
            }
            validate_resolved_parameter_value(parameter, first_val)?;
            resolved_values.push(first_val);
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

            for r in &enabled_regions {
                for o in &r.material_overrides {
                    if o.parameter == param {
                        if !matches!(o.value, MaterialParameterFieldIR::Constant { .. }) {
                            source_kind = MaterialFieldSourceKind::Gradient;
                            requires_sampling = true;
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
                }
            }

            plans.push(MaterialFieldPlan {
                object_id: owner_id.to_string(),
                parameter: param,
                source_kind,
                realization_location: location,
                requires_sampling,
                requires_mesh_revision: false,
                warnings: Vec::new(),
                realization_method: None,
                statistics: None,
            });
        }
    }
    plans
}
