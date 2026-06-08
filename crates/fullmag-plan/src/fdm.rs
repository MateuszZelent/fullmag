use fullmag_ir::{
    BackendPlanIR, BackendTarget, CommonPlanMeta, DiscretizationHintsIR, EnergyTermIR,
    ExchangeBoundaryCondition, ExchangeCouplingModeIR, ExecutionPlanIR, ExecutionPrecision,
    FdmLayerPlanIR, FdmMaterialIR, FdmMultilayerPlanIR, FdmMultilayerSummaryIR, FdmPlanIR,
    GeometryEntryIR, GridDimensions, InitialMagnetizationIR, IntegratorChoice, OutputPlanIR,
    ProblemIR, ProvenancePlanIR, RegionFrameIR, RegionShapeIR, RelaxationAlgorithmIR,
    TimeDependenceIR, IR_VERSION,
};
use std::collections::{BTreeMap, BTreeSet};

use crate::current_transport::{resolve_current_transports, CurrentTransportExecutableLane};
use crate::error::PlanError;
use crate::geometry::{
    cell_for_magnet, extract_multilayer_geometry, fdm_default_cell, ir_to_shape,
    validate_realized_grid, voxelize_shape, GeometryShape, LoweredBody,
};
use crate::magnetization_textures::{sample_preset_texture, TextureSamplePoint};
use crate::oersted::{resolve_fdm_oersted_term, ResolvedOerstedTerm};
use crate::spin_torque::{
    resolve_legacy_spin_torque, resolve_sot_fields, SpinTorqueExecutableLane,
};
use crate::util::{generate_random_unit_vectors, runtime_requests_cuda, MU0, PLACEMENT_TOLERANCE};
use crate::validate::{
    planned_study_controls, validate_executable_outputs, validate_grid_asset_cell_size,
};

fn grid_sample_points(
    grid_cells: [u32; 3],
    cell_size: [f64; 3],
    origin: [f64; 3],
    active_mask: Option<&Vec<bool>>,
) -> Vec<TextureSamplePoint> {
    let nx = grid_cells[0] as usize;
    let ny = grid_cells[1] as usize;
    let nz = grid_cells[2] as usize;
    let mut points = Vec::with_capacity(nx * ny * nz);
    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                let idx = x + nx * (y + ny * z);
                let world = [
                    origin[0] + (x as f64 + 0.5) * cell_size[0],
                    origin[1] + (y as f64 + 0.5) * cell_size[1],
                    origin[2] + (z as f64 + 0.5) * cell_size[2],
                ];
                points.push(TextureSamplePoint {
                    position_world: world,
                    position_object: world,
                    active: active_mask.map(|mask| mask[idx]).unwrap_or(true),
                });
            }
        }
    }
    points
}

fn point_in_region_shape(point: [f64; 3], shape: &RegionShapeIR) -> Result<bool, String> {
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
            "FDM object region materialization does not yet support CSG region shapes".to_string(),
        ),
    }
}

fn materialize_object_region_mask(
    problem: &ProblemIR,
    owner_names: &[&str],
    grid_cells: [u32; 3],
    cell_size: [f64; 3],
    origin: [f64; 3],
    active_mask: Option<&Vec<bool>>,
    errors: &mut Vec<String>,
) -> (Vec<u32>, BTreeMap<String, u32>) {
    let n_cells = (grid_cells[0] * grid_cells[1] * grid_cells[2]) as usize;
    let mut mask = vec![0u32; n_cells];
    let mut regions = problem
        .object_regions
        .iter()
        .filter(|region| region.enabled && owner_names.contains(&region.owner_object.as_str()))
        .collect::<Vec<_>>();
    regions.sort_by_key(|region| (region.priority, region.region_id.as_str()));

    let mut region_ids = BTreeMap::new();
    for (index, region) in regions.iter().enumerate() {
        if region.frame != RegionFrameIR::Object {
            errors.push(format!(
                "object_region '{}' uses frame={:?}; FDM region mask materialization currently supports object frame only",
                region.region_id, region.frame
            ));
            continue;
        }
        let region_index = (index + 1) as u32;
        region_ids.insert(region.region_id.clone(), region_index);
        let mut assigned = 0usize;
        let points = grid_sample_points(grid_cells, cell_size, origin, active_mask);
        for (flat_index, point) in points.iter().enumerate() {
            if !point.active {
                continue;
            }
            match point_in_region_shape(point.position_object, &region.shape) {
                Ok(true) => {
                    mask[flat_index] = region_index;
                    assigned += 1;
                }
                Ok(false) => {}
                Err(message) => {
                    errors.push(format!("object_region '{}': {message}", region.region_id));
                    break;
                }
            }
        }
        if assigned == 0 {
            errors.push(format!(
                "object_region '{}' did not cover any active FDM cells",
                region.region_id
            ));
        }
    }

    (mask, region_ids)
}

fn materialize_region_exchange_couplings(
    problem: &ProblemIR,
    material_exchange: f64,
    region_index_by_id: &BTreeMap<String, u32>,
    errors: &mut Vec<String>,
) -> Vec<(u32, u32, f64)> {
    let mut overrides = Vec::new();
    for coupling in problem.couplings.iter().filter(|coupling| coupling.enabled) {
        let (
            fullmag_ir::CouplingEndpointIR::Region {
                region_id: source_id,
                ..
            },
            fullmag_ir::CouplingEndpointIR::Region {
                region_id: target_id,
                ..
            },
            fullmag_ir::CouplingParametersIR::Exchange {
                mode,
                scale,
                inter_exchange,
            },
        ) = (&coupling.source, &coupling.target, &coupling.parameters)
        else {
            continue;
        };
        let Some(&source_index) = region_index_by_id.get(source_id) else {
            errors.push(format!(
                "coupling '{}' references object_region '{}' that was not materialized in the FDM region mask",
                coupling.coupling_id, source_id
            ));
            continue;
        };
        let Some(&target_index) = region_index_by_id.get(target_id) else {
            errors.push(format!(
                "coupling '{}' references object_region '{}' that was not materialized in the FDM region mask",
                coupling.coupling_id, target_id
            ));
            continue;
        };
        let exchange = match mode {
            ExchangeCouplingModeIR::Explicit => {
                let Some(value) = inter_exchange else {
                    errors.push(format!(
                        "coupling '{}' uses explicit exchange mode but does not provide inter_exchange",
                        coupling.coupling_id
                    ));
                    continue;
                };
                *value
            }
            ExchangeCouplingModeIR::Disabled => 0.0,
            ExchangeCouplingModeIR::HarmonicMean => {
                let scale = scale.unwrap_or(1.0);
                if (scale - 1.0).abs() <= f64::EPSILON {
                    continue;
                }
                material_exchange * scale
            }
        };
        overrides.push((source_index, target_index, exchange));
    }
    overrides
}

fn apply_region_texture_overrides(
    problem: &ProblemIR,
    region_index_by_id: &BTreeMap<String, u32>,
    region_mask: &[u32],
    grid_cells: [u32; 3],
    cell_size: [f64; 3],
    origin: [f64; 3],
    active_mask: Option<&Vec<bool>>,
    initial_magnetization: &mut [[f64; 3]],
    errors: &mut Vec<String>,
) {
    let mut regions = problem
        .object_regions
        .iter()
        .filter(|region| region.enabled && region.texture_override.is_some())
        .collect::<Vec<_>>();
    regions.sort_by_key(|region| (region.priority, region.region_id.as_str()));

    let points = grid_sample_points(grid_cells, cell_size, origin, active_mask);
    for region in regions {
        let Some(&region_index) = region_index_by_id.get(&region.region_id) else {
            errors.push(format!(
                "object_region '{}' has texture_override but was not materialized in the FDM region mask",
                region.region_id
            ));
            continue;
        };
        let Some(texture_override) = region.texture_override.as_ref() else {
            continue;
        };
        let values = match &texture_override.initial_magnetization {
            InitialMagnetizationIR::Uniform { value } => vec![*value; initial_magnetization.len()],
            InitialMagnetizationIR::RandomSeeded { seed } => {
                generate_random_unit_vectors(*seed, initial_magnetization.len())
            }
            InitialMagnetizationIR::SampledField { values } => {
                if values.len() != initial_magnetization.len() {
                    errors.push(format!(
                        "object_region '{}' texture_override sampled field length {} does not match FDM cell count {}",
                        region.region_id,
                        values.len(),
                        initial_magnetization.len()
                    ));
                    continue;
                }
                values.clone()
            }
            InitialMagnetizationIR::PresetTexture {
                preset_kind,
                preset_params,
                mapping,
                texture_transform,
            } => match sample_preset_texture(
                preset_kind,
                preset_params,
                mapping,
                texture_transform,
                &points,
            ) {
                Ok(values) => values,
                Err(message) => {
                    errors.push(format!(
                        "object_region '{}' texture_override: {message}",
                        region.region_id
                    ));
                    continue;
                }
            },
        };
        for (index, value) in values.into_iter().enumerate() {
            if region_mask[index] == region_index {
                initial_magnetization[index] = value;
            }
        }
    }
}

pub(crate) fn plan_fdm(
    problem: &ProblemIR,
    resolved_backend: BackendTarget,
) -> Result<ExecutionPlanIR, PlanError> {
    let mut errors = Vec::new();

    let mut enable_exchange = false;
    let mut enable_demag = false;
    let mut external_field = None;
    let enable_oersted = problem.energy_terms.iter().any(|term| {
        matches!(
            term,
            EnergyTermIR::OerstedCylinder { .. } | EnergyTermIR::OerstedField { .. }
        )
    });
    for term in &problem.energy_terms {
        match term {
            EnergyTermIR::Exchange => {
                if enable_exchange {
                    errors.push("Exchange is declared more than once".to_string());
                }
                enable_exchange = true;
            }
            EnergyTermIR::Demag { .. } => {
                if enable_demag {
                    errors.push("Demag is declared more than once".to_string());
                }
                enable_demag = true;
            }
            EnergyTermIR::Zeeman { b } => {
                if external_field.is_some() {
                    errors.push("Zeeman is declared more than once".to_string());
                }
                external_field = Some([b[0] / MU0, b[1] / MU0, b[2] / MU0]);
            }
            // Terms handled in the post-plan mapping loop below:
            EnergyTermIR::OerstedCylinder { .. }
            | EnergyTermIR::OerstedField { .. }
            | EnergyTermIR::InterfacialDmi { .. }
            | EnergyTermIR::BulkDmi { .. } => {}
            other => {
                errors.push(format!(
                    "energy term '{:?}' is semantic-only in the current FDM executable path",
                    other
                ));
            }
        }
    }
    reject_fdm_spatial_material_fields(problem, "FDM", &mut errors);
    if !(enable_exchange || enable_demag || external_field.is_some()) {
        errors.push(
            "the current executable FDM path requires at least one of Exchange, Demag, or Zeeman"
                .to_string(),
        );
    }

    if problem.geometry.entries.len() != 1 {
        errors.push(format!(
            "Phase 1 supports exactly one geometry entry, found {}",
            problem.geometry.entries.len()
        ));
    }
    let geometry = &problem.geometry.entries[0];
    let shape = match ir_to_shape(geometry) {
        Ok(shape) => shape,
        Err(e) => {
            errors.push(e);
            return Err(PlanError { reasons: errors });
        }
    };

    let cell_size = match &problem.backend_policy.discretization_hints {
        Some(DiscretizationHintsIR { fdm: Some(fdm), .. }) => fdm.cell,
        _ => {
            errors.push(
                "FDM discretization hints (cell size) are required for Phase 1 execution"
                    .to_string(),
            );
            [1e-9, 1e-9, 1e-9]
        }
    };

    if problem.magnets.len() != 1 {
        errors.push(format!(
            "Phase 1 supports exactly one magnet, found {}",
            problem.magnets.len()
        ));
    }

    validate_executable_outputs(
        &problem.study.sampling().outputs,
        enable_exchange,
        enable_demag,
        external_field.is_some(),
        enable_oersted,
        problem.energy_terms.iter().any(|term| {
            matches!(
                term,
                EnergyTermIR::InterfacialDmi { .. } | EnergyTermIR::BulkDmi { .. }
            )
        }),
        false,
        false,
        false,
        false,
        &mut errors,
    );
    if problem.backend_policy.execution_precision != ExecutionPrecision::Double
        && !runtime_requests_cuda(problem)
    {
        errors.push(
            "execution_precision='single' requires a CUDA device; the CPU reference runner supports only 'double'"
                .to_string(),
        );
    }

    let provided_grid_asset = problem.geometry_assets.as_ref().and_then(|assets| {
        assets
            .fdm_grid_assets
            .iter()
            .find(|asset| asset.geometry_name == geometry.name())
    });

    let (bounding_size, active_mask, grid_cells, native_origin, used_precomputed_asset) =
        if let Some(asset) = provided_grid_asset {
            validate_grid_asset_cell_size(asset, cell_size, &mut errors);
            (
                [
                    asset.cells[0] as f64 * asset.cell_size[0],
                    asset.cells[1] as f64 * asset.cell_size[1],
                    asset.cells[2] as f64 * asset.cell_size[2],
                ],
                Some(asset.active_mask.clone()),
                asset.cells,
                asset.origin,
                true,
            )
        } else {
            let (bounding_size, active_mask, grid_cells, origin) =
                voxelize_shape(&shape, cell_size, &mut errors);
            (bounding_size, active_mask, grid_cells, origin, false)
        };

    if !used_precomputed_asset {
        validate_realized_grid(
            "geometry",
            bounding_size,
            grid_cells,
            cell_size,
            &mut errors,
        );
    }

    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    let current_transports =
        resolve_current_transports(problem, CurrentTransportExecutableLane::Fdm)?;
    let spin_torque =
        resolve_legacy_spin_torque(problem, SpinTorqueExecutableLane::Fdm, &current_transports)?;
    let sot = resolve_sot_fields(problem, &current_transports)?;

    let magnet = &problem.magnets[0];
    let material = problem
        .materials
        .iter()
        .find(|m| m.name == magnet.material)
        .expect("validation should have caught missing material");

    let n_cells = (grid_cells[0] * grid_cells[1] * grid_cells[2]) as usize;
    let mut initial_magnetization = match &magnet.initial_magnetization {
        Some(InitialMagnetizationIR::Uniform { value }) => {
            if let Some(ref mask) = active_mask {
                mask.iter()
                    .map(|&active| if active { *value } else { [0.0, 0.0, 0.0] })
                    .collect()
            } else {
                vec![*value; n_cells]
            }
        }
        Some(InitialMagnetizationIR::RandomSeeded { seed }) => {
            let mut vectors = generate_random_unit_vectors(*seed, n_cells);
            if let Some(ref mask) = active_mask {
                for (index, active) in mask.iter().enumerate() {
                    if !active {
                        vectors[index] = [0.0, 0.0, 0.0];
                    }
                }
            }
            vectors
        }
        Some(InitialMagnetizationIR::SampledField { values }) => values.clone(),
        Some(InitialMagnetizationIR::PresetTexture {
            preset_kind,
            preset_params,
            mapping,
            texture_transform,
        }) => {
            eprintln!(
                "[fullmag-plan][mag-texture] sampling preset '{}' for FDM magnet '{}' (cells={} active={}) mapping=({}/{}/{}) T=[{:+.3e},{:+.3e},{:+.3e}]m S=[{:+.3e},{:+.3e},{:+.3e}]",
                preset_kind,
                magnet.name,
                n_cells,
                active_mask
                    .as_ref()
                    .map(|mask| mask.iter().filter(|active| **active).count())
                    .unwrap_or(n_cells),
                mapping.space,
                mapping.projection,
                mapping.clamp_mode,
                texture_transform.translation[0],
                texture_transform.translation[1],
                texture_transform.translation[2],
                texture_transform.scale[0],
                texture_transform.scale[1],
                texture_transform.scale[2],
            );
            let points =
                grid_sample_points(grid_cells, cell_size, native_origin, active_mask.as_ref());
            match sample_preset_texture(
                preset_kind,
                &preset_params,
                mapping,
                texture_transform,
                &points,
            ) {
                Ok(values) => values,
                Err(message) => {
                    return Err(PlanError {
                        reasons: vec![format!("magnet '{}': {}", magnet.name, message)],
                    });
                }
            }
        }
        None => {
            if let Some(ref mask) = active_mask {
                mask.iter()
                    .map(|&active| {
                        if active {
                            [1.0, 0.0, 0.0]
                        } else {
                            [0.0, 0.0, 0.0]
                        }
                    })
                    .collect()
            } else {
                vec![[1.0, 0.0, 0.0]; n_cells]
            }
        }
    };

    let (
        integrator,
        fixed_timestep,
        gyromagnetic_ratio,
        relaxation,
        adaptive_timestep,
        field_refresh,
    ) = planned_study_controls(problem, resolved_backend, &mut errors);
    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    let active_count = active_mask
        .as_ref()
        .map(|mask| mask.iter().filter(|&&active| active).count())
        .unwrap_or(n_cells);
    let owner_names = [magnet.name.as_str(), geometry.name()];
    let (region_mask, region_index_by_id) = materialize_object_region_mask(
        problem,
        &owner_names,
        grid_cells,
        cell_size,
        native_origin,
        active_mask.as_ref(),
        &mut errors,
    );
    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }
    apply_region_texture_overrides(
        problem,
        &region_index_by_id,
        &region_mask,
        grid_cells,
        cell_size,
        native_origin,
        active_mask.as_ref(),
        &mut initial_magnetization,
        &mut errors,
    );
    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }
    let inter_region_exchange = materialize_region_exchange_couplings(
        problem,
        material.exchange_stiffness,
        &region_index_by_id,
        &mut errors,
    );
    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    let sample_points =
        grid_sample_points(grid_cells, cell_size, native_origin, active_mask.as_ref());
    let point_coords: Vec<[f64; 3]> = sample_points.iter().map(|p| p.position_world).collect();

    // Resolve Ms field
    let ms_field_resolved = crate::material::resolve_spatial_parameter(
        problem,
        magnet.name.as_str(),
        fullmag_ir::MaterialParameterNameIR::Ms,
        material.saturation_magnetisation,
        &point_coords,
        [0.0, 0.0, 0.0],
    );
    let ms_field_opt = match ms_field_resolved {
        Ok(v) => {
            let is_uniform = v
                .iter()
                .all(|&val| (val - material.saturation_magnetisation).abs() <= 1e-12);
            if is_uniform {
                None
            } else {
                Some(v)
            }
        }
        Err(e) => {
            errors.push(e);
            return Err(PlanError { reasons: errors });
        }
    };

    // Resolve Aex field
    let aex_field_resolved = crate::material::resolve_spatial_parameter(
        problem,
        magnet.name.as_str(),
        fullmag_ir::MaterialParameterNameIR::Aex,
        material.exchange_stiffness,
        &point_coords,
        [0.0, 0.0, 0.0],
    );
    let aex_field_opt = match aex_field_resolved {
        Ok(v) => {
            let is_uniform = v
                .iter()
                .all(|&val| (val - material.exchange_stiffness).abs() <= 1e-12);
            if is_uniform {
                None
            } else {
                Some(v)
            }
        }
        Err(e) => {
            errors.push(e);
            return Err(PlanError { reasons: errors });
        }
    };

    // Resolve alpha field
    let alpha_field_resolved = crate::material::resolve_spatial_parameter(
        problem,
        magnet.name.as_str(),
        fullmag_ir::MaterialParameterNameIR::Alpha,
        material.damping,
        &point_coords,
        [0.0, 0.0, 0.0],
    );
    let alpha_field_opt = match alpha_field_resolved {
        Ok(v) => {
            let is_uniform = v.iter().all(|&val| (val - material.damping).abs() <= 1e-12);
            if is_uniform {
                None
            } else {
                Some(v)
            }
        }
        Err(e) => {
            errors.push(e);
            return Err(PlanError { reasons: errors });
        }
    };

    let material_field_plans = crate::material::build_material_field_plans(
        problem,
        magnet.name.as_str(),
        fullmag_ir::MaterialFieldLocationIR::Cell,
    );

    let geometry_label = match &shape {
        GeometryShape::Box { .. } if used_precomputed_asset => format!(
            "Box geometry used precomputed FDM grid asset: {}x{}x{} cells",
            grid_cells[0], grid_cells[1], grid_cells[2]
        ),
        GeometryShape::Box { .. } => format!(
            "Box geometry lowered to {}x{}x{} grid",
            grid_cells[0], grid_cells[1], grid_cells[2]
        ),
        GeometryShape::Cylinder { radius, .. } if used_precomputed_asset => format!(
            "Cylinder (r={:.3e}) used precomputed FDM grid asset: {}x{}x{} cells, {}/{} active cells",
            radius, grid_cells[0], grid_cells[1], grid_cells[2], active_count, n_cells
        ),
        GeometryShape::Cylinder { radius, .. } => format!(
            "Cylinder (r={:.3e}) voxelized to {}x{}x{} grid, {}/{} active cells",
            radius, grid_cells[0], grid_cells[1], grid_cells[2], active_count, n_cells
        ),
        GeometryShape::SinWaveguide {
            period,
            amplitude,
            ..
        } => format!(
            "SinWaveguide (period={:.3e}, amplitude={:.3e}) voxelized to {}x{}x{} grid, {}/{} active cells",
            period, amplitude, grid_cells[0], grid_cells[1], grid_cells[2], active_count, n_cells
        ),
        GeometryShape::ArchWaveguide { arch_height, .. } => format!(
            "ArchWaveguide (arch_height={:.3e}) voxelized to {}x{}x{} grid, {}/{} active cells",
            arch_height, grid_cells[0], grid_cells[1], grid_cells[2], active_count, n_cells
        ),
        GeometryShape::Imported { format, .. } => format!(
            "Imported geometry ({format}) used precomputed FDM grid asset: {}x{}x{} cells, {}/{} active cells",
            grid_cells[0], grid_cells[1], grid_cells[2], active_count, n_cells
        ),
        GeometryShape::Difference { .. } => format!(
            "CSG Difference voxelized to {}x{}x{} grid, {}/{} active cells",
            grid_cells[0], grid_cells[1], grid_cells[2], active_count, n_cells
        ),
    };

    let realized_size = [
        grid_cells[0] as f64 * cell_size[0],
        grid_cells[1] as f64 * cell_size[1],
        grid_cells[2] as f64 * cell_size[2],
    ];

    let mut fdm_plan = FdmPlanIR {
        grid: GridDimensions { cells: grid_cells },
        cell_size,
        region_mask,
        active_mask: active_mask.clone(),
        initial_magnetization,
        material: FdmMaterialIR {
            name: material.name.clone(),
            saturation_magnetisation: material.saturation_magnetisation,
            exchange_stiffness: material.exchange_stiffness,
            damping: material.damping,
            ms_field: ms_field_opt,
            a_field: aex_field_opt,
            alpha_field: alpha_field_opt,
            uniaxial_anisotropy_ku1: material.uniaxial_anisotropy,
            uniaxial_anisotropy_ku2: material.uniaxial_anisotropy_k2,
            anisotropy_axis: material.anisotropy_axis,
            cubic_anisotropy_kc1: material.cubic_anisotropy_kc1,
            cubic_anisotropy_kc2: material.cubic_anisotropy_kc2,
            cubic_anisotropy_kc3: material.cubic_anisotropy_kc3,
            cubic_anisotropy_axis1: material.cubic_anisotropy_axis1,
            cubic_anisotropy_axis2: material.cubic_anisotropy_axis2,
        },
        enable_exchange,
        enable_demag,
        external_field,
        inter_region_exchange,
        gyromagnetic_ratio,
        precision: problem.backend_policy.execution_precision,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        periodicity: problem.pbc.clone(),
        integrator,
        fixed_timestep,
        adaptive_timestep,
        field_refresh,
        relaxation,
        boundary_correction: problem
            .backend_policy
            .discretization_hints
            .as_ref()
            .and_then(|h| h.fdm.as_ref())
            .and_then(|fdm| fdm.boundary_correction.clone()),
        boundary_phi_floor: problem
            .backend_policy
            .discretization_hints
            .as_ref()
            .and_then(|h| h.fdm.as_ref())
            .and_then(|fdm| fdm.boundary_phi_floor),
        boundary_delta_min: problem
            .backend_policy
            .discretization_hints
            .as_ref()
            .and_then(|h| h.fdm.as_ref())
            .and_then(|fdm| fdm.boundary_delta_min),
        boundary_geometry: None,
        current_density: spin_torque.current_density,
        stt_degree: spin_torque.stt_degree,
        stt_beta: spin_torque.stt_beta,
        stt_spin_polarization: spin_torque.stt_spin_polarization,
        stt_lambda: spin_torque.stt_lambda,
        stt_epsilon_prime: spin_torque.stt_epsilon_prime,
        stt_thickness: spin_torque.stt_thickness,
        stt_fixed_layer_position: spin_torque.stt_fixed_layer_position.clone(),
        has_oersted_cylinder: false,
        oersted_current: None,
        oersted_radius: None,
        oersted_center: None,
        oersted_axis: None,
        oersted_field_xyz: None,
        oersted_time_dep_kind: 0,
        oersted_time_dep_freq: 0.0,
        oersted_time_dep_phase: 0.0,
        oersted_time_dep_offset: 0.0,
        oersted_time_dep_t_on: 0.0,
        oersted_time_dep_t_off: 0.0,
        oersted_realization: None,
        temperature: problem.temperature,
        interfacial_dmi: None,
        bulk_dmi: None,
        dind_field: None,
        dbulk_field: None,
        mel_b1: None,
        mel_b2: None,
        mel_uniform_strain: None,
        sot_current_density: sot.current_density,
        sot_xi_dl: sot.xi_dl,
        sot_xi_fl: sot.xi_fl,
        sot_sigma: sot.sigma,
        sot_thickness: sot.thickness,
    };

    for (term_index, term) in problem.energy_terms.iter().enumerate() {
        if let Some(oersted) = resolve_fdm_oersted_term(
            problem,
            term_index,
            term,
            &current_transports,
            grid_cells,
            cell_size,
            active_mask.as_deref(),
        )? {
            match oersted {
                ResolvedOerstedTerm::Cylinder(oersted) => {
                    fdm_plan.has_oersted_cylinder = true;
                    fdm_plan.oersted_current = Some(oersted.current);
                    fdm_plan.oersted_radius = Some(oersted.radius);
                    fdm_plan.oersted_center = Some(oersted.center);
                    fdm_plan.oersted_axis = Some(oersted.axis);
                    fdm_plan.oersted_realization =
                        Some(fullmag_ir::OerstedRealization::InfiniteCylinder);
                    if let Some(td) = &oersted.time_dependence {
                        fdm_plan.has_oersted_cylinder = true;
                        match td {
                            TimeDependenceIR::Constant => {
                                fdm_plan.oersted_time_dep_kind = 0;
                            }
                            TimeDependenceIR::Sinusoidal {
                                frequency_hz,
                                phase_rad,
                                offset,
                            } => {
                                fdm_plan.oersted_time_dep_kind = 1;
                                fdm_plan.oersted_time_dep_freq = *frequency_hz;
                                fdm_plan.oersted_time_dep_phase = *phase_rad;
                                fdm_plan.oersted_time_dep_offset = *offset;
                            }
                            TimeDependenceIR::Pulse { t_on, t_off } => {
                                fdm_plan.oersted_time_dep_kind = 2;
                                fdm_plan.oersted_time_dep_t_on = *t_on;
                                fdm_plan.oersted_time_dep_t_off = *t_off;
                            }
                            TimeDependenceIR::PiecewiseLinear { .. } => {
                                return Err(PlanError {
                                    reasons: vec![
                                        "Oersted time dependence 'PiecewiseLinear' is not yet supported \
                                         by the FDM backend; use 'Constant', 'Sinusoidal', or 'Pulse' instead"
                                            .to_string(),
                                    ],
                                });
                            }
                        }
                    }
                }
                ResolvedOerstedTerm::Field(field) => {
                    fdm_plan.oersted_field_xyz = Some(
                        field
                            .field_xyz
                            .chunks_exact(3)
                            .map(|chunk| [chunk[0], chunk[1], chunk[2]])
                            .collect(),
                    );
                    fdm_plan.oersted_realization =
                        Some(fullmag_ir::OerstedRealization::BiotSavartMidpoint);
                }
            }
            continue;
        }

        match term {
            EnergyTermIR::InterfacialDmi { d, .. } => {
                fdm_plan.interfacial_dmi = Some(*d);
            }
            EnergyTermIR::BulkDmi { d } => {
                fdm_plan.bulk_dmi = Some(*d);
            }
            _ => {}
        }
    }

    if fdm_plan.boundary_correction.is_some()
        && fdm_plan.boundary_correction.as_deref() != Some("none")
    {
        let compute_delta = fdm_plan.boundary_correction.as_deref() == Some("full");
        // NOTE: Boundary-correction SDF is currently implemented only for:
        //   • Cylinder  (single disk/pillar)
        //   • Difference(Cylinder, Cylinder)  (ring / annulus)
        // For all other geometries the SDF cannot be built and
        // boundary_geometry remains `None`; the backend will run the
        // chosen correction level but without per-cell φ/δ data, which
        // means the correction has no geometric effect.
        let sdf_opt: Option<Box<dyn Fn(f64, f64, f64) -> f64>> = match &shape {
            GeometryShape::Cylinder { radius, .. } => {
                let cx = grid_cells[0] as f64 * cell_size[0] * 0.5;
                let cy = grid_cells[1] as f64 * cell_size[1] * 0.5;
                let r = *radius;
                Some(Box::new(move |x, y, _z| {
                    let dx = x - cx;
                    let dy = y - cy;
                    (dx * dx + dy * dy).sqrt() - r
                }))
            }
            GeometryShape::Difference { base, tool } => {
                let cx = grid_cells[0] as f64 * cell_size[0] * 0.5;
                let cy = grid_cells[1] as f64 * cell_size[1] * 0.5;
                if let (
                    GeometryShape::Cylinder { radius: base_r, .. },
                    GeometryShape::Cylinder { radius: tool_r, .. },
                ) = (base.as_ref(), tool.as_ref())
                {
                    let br = *base_r;
                    let tr = *tool_r;
                    Some(Box::new(move |x, y, _z| {
                        let dx = x - cx;
                        let dy = y - cy;
                        let d = (dx * dx + dy * dy).sqrt();
                        (d - br).max(-(d - tr))
                    }))
                } else {
                    None
                }
            }
            _ => None,
        };

        if let Some(sdf) = sdf_opt {
            fdm_plan.boundary_geometry = Some(crate::boundary_geometry::compute_boundary_geometry(
                &*sdf,
                grid_cells[0],
                grid_cells[1],
                grid_cells[2],
                cell_size[0],
                cell_size[1],
                cell_size[2],
                compute_delta,
            ));
        } else {
            eprintln!(
                "[fullmag-plan] WARNING: boundary_correction='{}' requested but SDF is not \
                 available for geometry shape {:?}; boundary_geometry will be None. \
                 Supported shapes: Cylinder, Difference(Cylinder, Cylinder).",
                fdm_plan.boundary_correction.as_deref().unwrap_or("?"),
                shape,
            );
        }
    }

    let study_note = if let Some(control) = fdm_plan.relaxation.as_ref() {
        format!(
            "study: relaxation algorithm={} torque_tolerance={} energy_tolerance={} max_steps={}",
            control.algorithm.as_str(),
            control
                .stop
                .torque_tolerance_apm
                .map(|value| format!("{value:.6e}"))
                .unwrap_or_else(|| "none".to_string()),
            control
                .stop
                .energy_tolerance_j
                .map(|value| format!("{value:.6e}"))
                .unwrap_or_else(|| "none".to_string()),
            control
                .stop
                .max_steps
                .map(|value| value.to_string())
                .unwrap_or_else(|| "none".to_string())
        )
    } else {
        "study: time_evolution".to_string()
    };

    Ok(ExecutionPlanIR {
        common: CommonPlanMeta {
            ir_version: IR_VERSION.to_string(),
            requested_backend: problem.backend_policy.requested_backend,
            resolved_backend,
            execution_mode: problem.validation_profile.execution_mode,
            material_field_plans,
        },
        backend_plan: BackendPlanIR::Fdm(fdm_plan),
        output_plan: OutputPlanIR {
            outputs: problem.study.sampling().outputs.clone(),
        },
        provenance: ProvenancePlanIR {
            notes: vec![
                "Phase 1 reference FDM planner".to_string(),
                geometry_label,
                format!(
                    "realized grid size: [{:.6e}, {:.6e}, {:.6e}] m",
                    realized_size[0], realized_size[1], realized_size[2]
                ),
                format!(
                    "active terms: exchange={}, demag={}, zeeman={}",
                    enable_exchange,
                    enable_demag,
                    external_field.is_some()
                ),
                study_note,
            ],
        },
    })
}

fn reject_fdm_spatial_material_fields(problem: &ProblemIR, lane: &str, errors: &mut Vec<String>) {
    let mut seen_materials = BTreeSet::new();
    for magnet in &problem.magnets {
        let Some(material) = problem
            .materials
            .iter()
            .find(|material| material.name == magnet.material)
        else {
            continue;
        };
        if !seen_materials.insert(material.name.as_str()) {
            continue;
        }
        let fields = fdm_spatial_material_field_names(material);
        if fields.is_empty() {
            continue;
        }
        errors.push(format!(
            "per-cell material fields ({}) on material '{}' are not executable in the current {lane} path; FDM planning currently carries uniform material constants only",
            fields.join(", "),
            material.name
        ));
    }
}

fn fdm_spatial_material_field_names(material: &fullmag_ir::MaterialIR) -> Vec<&'static str> {
    let mut fields = Vec::new();
    if material.ku_field.is_some() {
        fields.push("ku_field");
    }
    if material.ku2_field.is_some() {
        fields.push("ku2_field");
    }
    if material.kc1_field.is_some() {
        fields.push("kc1_field");
    }
    if material.kc2_field.is_some() {
        fields.push("kc2_field");
    }
    if material.kc3_field.is_some() {
        fields.push("kc3_field");
    }
    fields
}

fn fdm_multilayer_cuda_native_single_grid_eligible(layers: &[FdmLayerPlanIR]) -> bool {
    let Some(first_layer) = layers.first() else {
        return false;
    };
    let reference_material = &first_layer.material;
    let reference_cell_size = first_layer.native_cell_size;
    if layers.iter().any(|layer| {
        layer.material != *reference_material || layer.native_cell_size != reference_cell_size
    }) {
        return false;
    }

    let mut min_origin = first_layer.native_origin;
    let mut max_extent = [
        first_layer.native_origin[0] + first_layer.native_grid[0] as f64 * reference_cell_size[0],
        first_layer.native_origin[1] + first_layer.native_grid[1] as f64 * reference_cell_size[1],
        first_layer.native_origin[2] + first_layer.native_grid[2] as f64 * reference_cell_size[2],
    ];
    for layer in layers.iter().skip(1) {
        for axis in 0..3 {
            min_origin[axis] = min_origin[axis].min(layer.native_origin[axis]);
            max_extent[axis] = max_extent[axis].max(
                layer.native_origin[axis]
                    + layer.native_grid[axis] as f64 * reference_cell_size[axis],
            );
        }
    }

    let mut global_grid = [0usize; 3];
    for axis in 0..3 {
        let cells = (max_extent[axis] - min_origin[axis]) / reference_cell_size[axis];
        let rounded = cells.round();
        if (cells - rounded).abs() > 1e-6 || rounded < 1.0 {
            return false;
        }
        global_grid[axis] = rounded as usize;
    }
    let Some(total_cells) = global_grid
        .iter()
        .try_fold(1usize, |acc, cells| acc.checked_mul(*cells))
    else {
        return false;
    };
    let mut active_mask = vec![false; total_cells];

    for layer in layers {
        let native_grid = [
            layer.native_grid[0] as usize,
            layer.native_grid[1] as usize,
            layer.native_grid[2] as usize,
        ];
        let mut offset = [0usize; 3];
        for axis in 0..3 {
            let offset_cells =
                (layer.native_origin[axis] - min_origin[axis]) / reference_cell_size[axis];
            let rounded = offset_cells.round();
            if (offset_cells - rounded).abs() > 1e-6 || rounded < 0.0 {
                return false;
            }
            offset[axis] = rounded as usize;
        }
        for z in 0..native_grid[2] {
            for y in 0..native_grid[1] {
                for x in 0..native_grid[0] {
                    let local_index = z * native_grid[1] * native_grid[0] + y * native_grid[0] + x;
                    if layer
                        .native_active_mask
                        .as_ref()
                        .is_some_and(|mask| !mask[local_index])
                    {
                        continue;
                    }
                    let gx = offset[0] + x;
                    let gy = offset[1] + y;
                    let gz = offset[2] + z;
                    if gx >= global_grid[0] || gy >= global_grid[1] || gz >= global_grid[2] {
                        return false;
                    }
                    let global_index =
                        gz * global_grid[1] * global_grid[0] + gy * global_grid[0] + gx;
                    if active_mask[global_index] {
                        return false;
                    }
                    active_mask[global_index] = true;
                }
            }
        }
    }

    true
}

pub(crate) fn plan_fdm_multilayer(
    problem: &ProblemIR,
    resolved_backend: BackendTarget,
) -> Result<ExecutionPlanIR, PlanError> {
    let mut errors = Vec::new();

    let fdm_hints = match &problem.backend_policy.discretization_hints {
        Some(DiscretizationHintsIR { fdm: Some(fdm), .. }) => fdm,
        _ => {
            return Err(PlanError {
                reasons: vec![
                    "FDM discretization hints are required for the public multilayer FDM path"
                        .to_string(),
                ],
            })
        }
    };
    let demag_hints = fdm_hints.demag.as_ref();
    let requested_strategy = demag_hints
        .map(|policy| policy.strategy.as_str())
        .unwrap_or("auto");
    if requested_strategy == "single_grid" {
        errors.push(
            "multi-body FDM currently supports only the multilayer_convolution strategy; 'single_grid' for multiple magnets is not yet executable"
                .to_string(),
        );
    }
    if problem.temperature.unwrap_or(0.0) > 0.0 {
        errors.push(
            "thermal_noise is not executable in the current public multilayer FDM path; staged CPU/GPU multilayer RHS coverage is not implemented yet"
                .to_string(),
        );
    }
    if problem.object_regions.iter().any(|region| region.enabled) {
        errors.push(
            "object_regions are authored in ProblemIR but multilayer FDM + region-owned material/coupling is capability-gated out of scope for v1; planner must not silently ignore authored regions in the multilayer FDM path"
                .to_string(),
        );
    }
    reject_fdm_spatial_material_fields(problem, "multilayer FDM", &mut errors);
    if problem.current_density.is_some()
        || problem.stt_degree.is_some()
        || problem.stt_beta.is_some()
        || problem.stt_spin_polarization.is_some()
        || problem.stt_lambda.is_some()
        || problem.stt_epsilon_prime.is_some()
        || problem.stt_thickness.is_some()
        || problem.stt_fixed_layer_position.is_some()
        || !problem.spin_torque_modules.is_empty()
    {
        errors.push(
            "spin_torque is not executable in the current public multilayer FDM path; staged CPU/GPU multilayer RHS coverage is not implemented yet"
                .to_string(),
        );
    }

    let mut enable_exchange = false;
    let mut enable_demag = false;
    let mut external_field = None;
    let mut interfacial_dmi = None;
    let mut bulk_dmi = None;
    for term in &problem.energy_terms {
        match term {
            fullmag_ir::EnergyTermIR::Exchange => {
                if enable_exchange {
                    errors.push("Exchange is declared more than once".to_string());
                }
                enable_exchange = true;
            }
            fullmag_ir::EnergyTermIR::Demag { .. } => {
                if enable_demag {
                    errors.push("Demag is declared more than once".to_string());
                }
                enable_demag = true;
            }
            fullmag_ir::EnergyTermIR::Zeeman { b } => {
                if external_field.is_some() {
                    errors.push("Zeeman is declared more than once".to_string());
                }
                external_field = Some([b[0] / MU0, b[1] / MU0, b[2] / MU0]);
            }
            fullmag_ir::EnergyTermIR::InterfacialDmi { d, .. } => {
                if interfacial_dmi.is_some() {
                    errors.push("InterfacialDmi is declared more than once".to_string());
                }
                interfacial_dmi = Some(*d);
            }
            fullmag_ir::EnergyTermIR::BulkDmi { d } => {
                if bulk_dmi.is_some() {
                    errors.push("BulkDmi is declared more than once".to_string());
                }
                bulk_dmi = Some(*d);
            }
            fullmag_ir::EnergyTermIR::OerstedCylinder { .. }
            | fullmag_ir::EnergyTermIR::OerstedField { .. } => {
                errors.push(
                    "Oersted is not executable in the current public multilayer FDM path; staged CPU/GPU multilayer RHS coverage is not implemented yet"
                        .to_string(),
                );
            }
            other => {
                errors.push(format!(
                    "energy term '{:?}' is semantic-only in the current public multilayer FDM path",
                    other
                ));
            }
        }
    }
    if !(enable_exchange || enable_demag || external_field.is_some()) {
        errors.push(
            "the current executable multilayer FDM path requires at least one of Exchange, Demag, or Zeeman"
                .to_string(),
        );
    }
    validate_executable_outputs(
        &problem.study.sampling().outputs,
        enable_exchange,
        enable_demag,
        external_field.is_some(),
        problem.energy_terms.iter().any(|term| {
            matches!(
                term,
                EnergyTermIR::OerstedCylinder { .. } | EnergyTermIR::OerstedField { .. }
            )
        }),
        interfacial_dmi.is_some() || bulk_dmi.is_some(),
        false,
        false,
        false,
        false,
        &mut errors,
    );
    if problem.backend_policy.execution_precision != ExecutionPrecision::Double
        && !runtime_requests_cuda(problem)
    {
        errors.push(
            "execution_precision='single' requires a CUDA device; the CPU reference multilayer FDM runner supports only 'double'"
                .to_string(),
        );
    }

    let geometry_by_name: BTreeMap<&str, &GeometryEntryIR> = problem
        .geometry
        .entries
        .iter()
        .map(|entry| (entry.name(), entry))
        .collect();
    let region_to_geometry: BTreeMap<&str, &str> = problem
        .regions
        .iter()
        .map(|region| (region.name.as_str(), region.geometry.as_str()))
        .collect();

    let mut lowered_bodies = Vec::with_capacity(problem.magnets.len());
    for magnet in &problem.magnets {
        let Some(geometry_name) = region_to_geometry.get(magnet.region.as_str()).copied() else {
            errors.push(format!(
                "magnet '{}' references region '{}' with no geometry binding",
                magnet.name, magnet.region
            ));
            continue;
        };
        let Some(geometry_entry) = geometry_by_name.get(geometry_name).copied() else {
            errors.push(format!(
                "magnet '{}' references geometry '{}' which is missing from geometry.entries",
                magnet.name, geometry_name
            ));
            continue;
        };

        let placed = match extract_multilayer_geometry(geometry_entry) {
            Ok(placed) => placed,
            Err(message) => {
                errors.push(message);
                continue;
            }
        };

        let cell_size = cell_for_magnet(fdm_hints, magnet.name.as_str());
        let provided_grid_asset = problem.geometry_assets.as_ref().and_then(|assets| {
            assets
                .fdm_grid_assets
                .iter()
                .find(|asset| asset.geometry_name == geometry_name)
        });

        let (bounding_size, active_mask, grid_cells, native_origin) =
            if let Some(asset) = provided_grid_asset {
                validate_grid_asset_cell_size(asset, cell_size, &mut errors);
                let bbox = [
                    asset.cells[0] as f64 * asset.cell_size[0],
                    asset.cells[1] as f64 * asset.cell_size[1],
                    asset.cells[2] as f64 * asset.cell_size[2],
                ];
                let mut origin = asset.origin;
                for axis in 0..3 {
                    origin[axis] += placed.translation[axis];
                }
                (bbox, Some(asset.active_mask.clone()), asset.cells, origin)
            } else {
                let (bbox, mask, cells, local_origin) =
                    voxelize_shape(&placed.shape, cell_size, &mut errors);
                validate_realized_grid(
                    &format!("geometry '{}'", geometry_name),
                    bbox,
                    cells,
                    cell_size,
                    &mut errors,
                );
                let origin = [
                    placed.translation[0] + local_origin[0],
                    placed.translation[1] + local_origin[1],
                    placed.translation[2] + local_origin[2],
                ];
                (bbox, mask, cells, origin)
            };

        let Some(material) = problem
            .materials
            .iter()
            .find(|candidate| candidate.name == magnet.material)
        else {
            errors.push(format!(
                "magnet '{}' references missing material '{}'",
                magnet.name, magnet.material
            ));
            continue;
        };

        let n_cells = (grid_cells[0] * grid_cells[1] * grid_cells[2]) as usize;
        let initial_magnetization = match &magnet.initial_magnetization {
            Some(InitialMagnetizationIR::Uniform { value }) => {
                if let Some(ref mask) = active_mask {
                    mask.iter()
                        .map(|&active| if active { *value } else { [0.0, 0.0, 0.0] })
                        .collect()
                } else {
                    vec![*value; n_cells]
                }
            }
            Some(InitialMagnetizationIR::RandomSeeded { seed }) => {
                let mut vectors = generate_random_unit_vectors(*seed, n_cells);
                if let Some(ref mask) = active_mask {
                    for (index, active) in mask.iter().enumerate() {
                        if !active {
                            vectors[index] = [0.0, 0.0, 0.0];
                        }
                    }
                }
                vectors
            }
            Some(InitialMagnetizationIR::SampledField { values }) => {
                if values.len() != n_cells {
                    errors.push(format!(
                        "magnet '{}' sampled_field has {} vectors, but its realized native grid requires {} cells",
                        magnet.name,
                        values.len(),
                        n_cells
                    ));
                }
                values.clone()
            }
            Some(InitialMagnetizationIR::PresetTexture {
                preset_kind,
                preset_params,
                mapping,
                texture_transform,
            }) => {
                let points =
                    grid_sample_points(grid_cells, cell_size, native_origin, active_mask.as_ref());
                match sample_preset_texture(
                    preset_kind,
                    &preset_params,
                    mapping,
                    texture_transform,
                    &points,
                ) {
                    Ok(values) => values,
                    Err(message) => {
                        errors.push(format!("magnet '{}': {}", magnet.name, message));
                        vec![[0.0, 0.0, 0.0]; n_cells]
                    }
                }
            }
            None => {
                if let Some(ref mask) = active_mask {
                    mask.iter()
                        .map(|&active| {
                            if active {
                                [1.0, 0.0, 0.0]
                            } else {
                                [0.0, 0.0, 0.0]
                            }
                        })
                        .collect()
                } else {
                    vec![[1.0, 0.0, 0.0]; n_cells]
                }
            }
        };

        lowered_bodies.push(LoweredBody {
            magnet_name: magnet.name.clone(),
            bounding_size,
            native_grid: grid_cells,
            native_cell_size: cell_size,
            native_origin,
            native_active_mask: active_mask,
            initial_magnetization,
            material: FdmMaterialIR {
                name: material.name.clone(),
                saturation_magnetisation: material.saturation_magnetisation,
                exchange_stiffness: material.exchange_stiffness,
                damping: material.damping,
                ms_field: None,
                a_field: None,
                alpha_field: None,
                uniaxial_anisotropy_ku1: material.uniaxial_anisotropy,
                uniaxial_anisotropy_ku2: material.uniaxial_anisotropy_k2,
                anisotropy_axis: material.anisotropy_axis,
                cubic_anisotropy_kc1: material.cubic_anisotropy_kc1,
                cubic_anisotropy_kc2: material.cubic_anisotropy_kc2,
                cubic_anisotropy_kc3: material.cubic_anisotropy_kc3,
                cubic_anisotropy_axis1: material.cubic_anisotropy_axis1,
                cubic_anisotropy_axis2: material.cubic_anisotropy_axis2,
            },
        });
    }

    if lowered_bodies.len() != problem.magnets.len() {
        if errors.is_empty() {
            errors.push(
                "failed to realize all magnets into multilayer bodies; see previous planner errors"
                    .to_string(),
            );
        }
        return Err(PlanError { reasons: errors });
    }

    let reference_xy = [
        lowered_bodies[0].bounding_size[0],
        lowered_bodies[0].bounding_size[1],
    ];
    let reference_center_xy = [
        lowered_bodies[0].native_origin[0] + lowered_bodies[0].bounding_size[0] * 0.5,
        lowered_bodies[0].native_origin[1] + lowered_bodies[0].bounding_size[1] * 0.5,
    ];
    for body in lowered_bodies.iter().skip(1) {
        let center_xy = [
            body.native_origin[0] + body.bounding_size[0] * 0.5,
            body.native_origin[1] + body.bounding_size[1] * 0.5,
        ];
        for axis in 0..2 {
            if (body.bounding_size[axis] - reference_xy[axis]).abs()
                > PLACEMENT_TOLERANCE * reference_xy[axis].max(1.0)
            {
                errors.push(format!(
                    "multilayer_convolution currently requires identical XY extents; magnet '{}' realizes to [{:.6e}, {:.6e}] m while the reference layer uses [{:.6e}, {:.6e}] m",
                    body.magnet_name,
                    body.bounding_size[0],
                    body.bounding_size[1],
                    reference_xy[0],
                    reference_xy[1]
                ));
                break;
            }
            if (center_xy[axis] - reference_center_xy[axis]).abs()
                > PLACEMENT_TOLERANCE * reference_xy[axis].max(1.0)
            {
                errors.push(format!(
                    "multilayer_convolution currently requires all bodies to share the same XY center; magnet '{}' is offset in {}",
                    body.magnet_name,
                    ["x", "y"][axis]
                ));
                break;
            }
        }
    }

    let mut z_intervals = lowered_bodies
        .iter()
        .map(|body| {
            (
                body.magnet_name.as_str(),
                body.native_origin[2],
                body.native_origin[2] + body.bounding_size[2],
            )
        })
        .collect::<Vec<_>>();
    z_intervals.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    for pair in z_intervals.windows(2) {
        let previous = pair[0];
        let current = pair[1];
        if current.1 < previous.2 - PLACEMENT_TOLERANCE {
            errors.push(format!(
                "multilayer_convolution does not allow overlapping bodies in z; '{}' overlaps '{}'",
                current.0, previous.0
            ));
        }
    }

    let mut selected_mode = demag_hints
        .map(|policy| policy.mode.clone())
        .unwrap_or_else(|| "auto".to_string());
    if selected_mode == "auto" {
        selected_mode = if lowered_bodies.iter().all(|body| body.native_grid[2] == 1) {
            "two_d_stack".to_string()
        } else {
            "three_d".to_string()
        };
    }

    let max_native_z_cells = lowered_bodies
        .iter()
        .map(|body| body.native_grid[2])
        .max()
        .unwrap_or(1);
    let max_native_z_size = lowered_bodies
        .iter()
        .map(|body| body.bounding_size[2])
        .fold(0.0_f64, f64::max);
    let base_cell = fdm_default_cell(fdm_hints);
    let common_cells = if let Some(policy) = demag_hints {
        if let Some(cells) = policy.common_cells {
            cells
        } else if let Some(cells_xy) = policy.common_cells_xy {
            [cells_xy[0], cells_xy[1], max_native_z_cells.max(1)]
        } else {
            [
                (reference_xy[0] / base_cell[0]).round().max(1.0) as u32,
                (reference_xy[1] / base_cell[1]).round().max(1.0) as u32,
                (max_native_z_size / base_cell[2]).round().max(1.0) as u32,
            ]
        }
    } else {
        [
            (reference_xy[0] / base_cell[0]).round().max(1.0) as u32,
            (reference_xy[1] / base_cell[1]).round().max(1.0) as u32,
            (max_native_z_size / base_cell[2]).round().max(1.0) as u32,
        ]
    };
    let convolution_cell_size = [
        reference_xy[0] / common_cells[0] as f64,
        reference_xy[1] / common_cells[1] as f64,
        max_native_z_size / common_cells[2] as f64,
    ];

    let mut unique_shifts = BTreeSet::new();
    for dst in &lowered_bodies {
        for src in &lowered_bodies {
            unique_shifts.insert(
                ((dst.native_origin[2] - src.native_origin[2]) / convolution_cell_size[2]).round()
                    as i64,
            );
        }
    }

    let estimated_unique_kernels = unique_shifts.len() as u32;
    let estimated_pair_kernels = (lowered_bodies.len() * lowered_bodies.len()) as u32;
    let padded_len =
        (common_cells[0] * 2) as u64 * (common_cells[1] * 2) as u64 * (common_cells[2] * 2) as u64;
    let estimated_kernel_bytes = padded_len * 6 * 16 * estimated_unique_kernels as u64;

    let (
        integrator,
        fixed_timestep,
        gyromagnetic_ratio,
        relaxation,
        adaptive_timestep,
        field_refresh,
    ) = planned_study_controls(problem, resolved_backend, &mut errors);
    if adaptive_timestep.is_some() {
        errors.push(
            "the public multilayer FDM runner does not yet support adaptive_timestep".to_string(),
        );
    }
    if relaxation
        .as_ref()
        .is_some_and(|control| control.algorithm != RelaxationAlgorithmIR::LlgOverdamped)
    {
        errors.push(
            "the public multilayer FDM runner currently supports only 'llg_overdamped' relaxation"
                .to_string(),
        );
    }

    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    let layers = lowered_bodies
        .into_iter()
        .map(|body| FdmLayerPlanIR {
            magnet_name: body.magnet_name,
            native_grid: body.native_grid,
            native_cell_size: body.native_cell_size,
            native_origin: body.native_origin,
            native_active_mask: body.native_active_mask,
            initial_magnetization: body.initial_magnetization,
            material: body.material,
            convolution_grid: common_cells,
            convolution_cell_size,
            convolution_origin: body.native_origin,
            transfer_kind: if body.native_grid == common_cells
                && body.native_cell_size == convolution_cell_size
            {
                "identity".to_string()
            } else {
                "push_pull".to_string()
            },
        })
        .collect::<Vec<_>>();
    if runtime_requests_cuda(problem)
        && !matches!(
            integrator,
            IntegratorChoice::Heun | IntegratorChoice::Rk4 | IntegratorChoice::Rk23
        )
        && !fdm_multilayer_cuda_native_single_grid_eligible(&layers)
    {
        errors.push(
            "the public staged v2 CUDA multilayer FDM runner currently supports only 'heun', 'rk4', and fixed-step 'rk23' integrators; RK45/ABM3 are executable only for native single-grid-compatible multilayer stacks"
                .to_string(),
        );
    }
    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    let plan = FdmMultilayerPlanIR {
        mode: selected_mode.clone(),
        common_cells,
        layers,
        enable_exchange,
        enable_demag,
        external_field,
        interfacial_dmi,
        bulk_dmi,
        gyromagnetic_ratio,
        precision: problem.backend_policy.execution_precision,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        periodicity: problem.pbc.clone(),
        integrator,
        fixed_timestep,
        field_refresh,
        relaxation,
        planner_summary: FdmMultilayerSummaryIR {
            requested_strategy: requested_strategy.to_string(),
            selected_strategy: "multilayer_convolution".to_string(),
            eligibility: "eligible".to_string(),
            estimated_pair_kernels,
            estimated_unique_kernels,
            estimated_kernel_bytes,
            warnings: Vec::new(),
        },
    };

    let study_note = if let Some(control) = plan.relaxation.as_ref() {
        format!(
            "study: relaxation algorithm={} torque_tolerance={} energy_tolerance={} max_steps={}",
            control.algorithm.as_str(),
            control
                .stop
                .torque_tolerance_apm
                .map(|value| format!("{value:.6e}"))
                .unwrap_or_else(|| "none".to_string()),
            control
                .stop
                .energy_tolerance_j
                .map(|value| format!("{value:.6e}"))
                .unwrap_or_else(|| "none".to_string()),
            control
                .stop
                .max_steps
                .map(|value| value.to_string())
                .unwrap_or_else(|| "none".to_string())
        )
    } else {
        "study: time_evolution".to_string()
    };

    Ok(ExecutionPlanIR {
        common: CommonPlanMeta {
            ir_version: IR_VERSION.to_string(),
            requested_backend: problem.backend_policy.requested_backend,
            resolved_backend,
            execution_mode: problem.validation_profile.execution_mode,
            material_field_plans: Vec::new(),
        },
        backend_plan: BackendPlanIR::FdmMultilayer(plan),
        output_plan: OutputPlanIR {
            outputs: problem.study.sampling().outputs.clone(),
        },
        provenance: ProvenancePlanIR {
            notes: vec![
                "Phase 2 public multilayer FDM planner".to_string(),
                format!(
                    "multibody demag strategy: requested={}, selected=multilayer_convolution",
                    requested_strategy
                ),
                format!(
                    "multilayer common grid: {}x{}x{}",
                    common_cells[0], common_cells[1], common_cells[2]
                ),
                format!(
                    "active terms: exchange={}, demag={}, zeeman={}",
                    enable_exchange,
                    enable_demag,
                    external_field.is_some()
                ),
                study_note,
            ],
        },
    })
}
