use std::collections::BTreeSet;
use std::f64::consts::PI;

use fullmag_ir::{
    EnergyTermIR, FemMeshPartIR, FemMeshPartSelector, FemObjectSegmentIR, GeometryEntryIR, MeshIR,
    OerstedFieldModelIR, ProblemIR, TimeDependenceIR,
};

use crate::current_transport::ResolvedCurrentTransport;
use crate::error::PlanError;
use crate::geometry::{checked_fdm_grid_cost, FDM_GRID_ESTIMATED_BYTES_PER_CELL};

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ResolvedOerstedCylinder {
    pub current: f64,
    pub radius: f64,
    pub center: [f64; 3],
    pub axis: [f64; 3],
    pub time_dependence: Option<TimeDependenceIR>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ResolvedOerstedField {
    pub field_xyz: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ResolvedOerstedTerm {
    Cylinder(ResolvedOerstedCylinder),
    Field(ResolvedOerstedField),
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn resolve_oersted_term(
    problem: &ProblemIR,
    term_index: usize,
    term: &EnergyTermIR,
    current_transports: &[ResolvedCurrentTransport],
) -> Result<Option<ResolvedOerstedCylinder>, PlanError> {
    match term {
        EnergyTermIR::OerstedCylinder {
            current,
            radius,
            center,
            axis,
            time_dependence,
        } => Ok(Some(ResolvedOerstedCylinder {
            current: *current,
            radius: *radius,
            center: *center,
            axis: *axis,
            time_dependence: time_dependence.clone(),
        })),
        EnergyTermIR::OerstedField {
            model: OerstedFieldModelIR::FromCurrentSolution,
            source,
        } => resolve_oersted_from_current_solution_cylinder(
            problem,
            term_index,
            source,
            current_transports,
        )
        .map(Some),
        _ => Ok(None),
    }
}

pub(crate) fn resolve_fem_oersted_term(
    problem: &ProblemIR,
    term_index: usize,
    term: &EnergyTermIR,
    current_transports: &[ResolvedCurrentTransport],
    mesh: &MeshIR,
    object_segments: &[FemObjectSegmentIR],
    mesh_parts: &[FemMeshPartIR],
) -> Result<Option<ResolvedOerstedTerm>, PlanError> {
    match term {
        EnergyTermIR::OerstedCylinder {
            current,
            radius,
            center,
            axis,
            time_dependence,
        } => Ok(Some(ResolvedOerstedTerm::Cylinder(
            ResolvedOerstedCylinder {
                current: *current,
                radius: *radius,
                center: *center,
                axis: *axis,
                time_dependence: time_dependence.clone(),
            },
        ))),
        EnergyTermIR::OerstedField {
            model: OerstedFieldModelIR::FromCurrentSolution,
            source,
        } => resolve_fem_oersted_from_current_solution(
            problem,
            term_index,
            source,
            current_transports,
            mesh,
            object_segments,
            mesh_parts,
        )
        .map(Some),
        _ => Ok(None),
    }
}

pub(crate) fn resolve_fdm_oersted_term(
    problem: &ProblemIR,
    term_index: usize,
    term: &EnergyTermIR,
    current_transports: &[ResolvedCurrentTransport],
    grid_cells: [u32; 3],
    cell_size: [f64; 3],
    active_mask: Option<&[bool]>,
) -> Result<Option<ResolvedOerstedTerm>, PlanError> {
    match term {
        EnergyTermIR::OerstedCylinder {
            current,
            radius,
            center,
            axis,
            time_dependence,
        } => Ok(Some(ResolvedOerstedTerm::Cylinder(
            ResolvedOerstedCylinder {
                current: *current,
                radius: *radius,
                center: *center,
                axis: *axis,
                time_dependence: time_dependence.clone(),
            },
        ))),
        EnergyTermIR::OerstedField {
            model: OerstedFieldModelIR::FromCurrentSolution,
            source,
        } => resolve_fdm_oersted_from_current_solution(
            problem,
            term_index,
            source,
            current_transports,
            grid_cells,
            cell_size,
            active_mask,
        )
        .map(Some),
        _ => Ok(None),
    }
}

#[cfg_attr(not(test), allow(dead_code))]
fn resolve_oersted_from_current_solution_cylinder(
    problem: &ProblemIR,
    term_index: usize,
    source: &str,
    current_transports: &[ResolvedCurrentTransport],
) -> Result<ResolvedOerstedCylinder, PlanError> {
    let resolved =
        resolve_current_solution_geometry(problem, term_index, source, current_transports)?;
    let (radius, center, axis) = cylindrical_geometry_parameters(resolved.geometry).ok_or_else(|| {
        PlanError {
            reasons: vec![format!(
                "energy_terms[{term_index}] oersted_field source '{}' requires a cylindrical solve_region; '{}' is not a supported cylinder geometry",
                source, resolved.geometry_name
            )],
        }
    })?;

    let axial_current_density = project_axis_aligned_current_density(
        term_index,
        source,
        resolved.transport.current_density,
        axis,
    )?;
    let current = axial_current_density * PI * radius * radius;

    Ok(ResolvedOerstedCylinder {
        current,
        radius,
        center,
        axis,
        time_dependence: None,
    })
}

fn resolve_fem_oersted_from_current_solution(
    problem: &ProblemIR,
    term_index: usize,
    source: &str,
    current_transports: &[ResolvedCurrentTransport],
    mesh: &MeshIR,
    object_segments: &[FemObjectSegmentIR],
    mesh_parts: &[FemMeshPartIR],
) -> Result<ResolvedOerstedTerm, PlanError> {
    let resolved =
        resolve_current_solution_geometry(problem, term_index, source, current_transports)?;

    if let Some((radius, center, axis)) = cylindrical_geometry_parameters(resolved.geometry) {
        let axial_current_density = project_axis_aligned_current_density(
            term_index,
            source,
            resolved.transport.current_density,
            axis,
        )?;
        let current = axial_current_density * PI * radius * radius;
        return Ok(ResolvedOerstedTerm::Cylinder(ResolvedOerstedCylinder {
            current,
            radius,
            center,
            axis,
            time_dependence: None,
        }));
    }

    let source_elements =
        source_element_indices(resolved.geometry_name, mesh, object_segments, mesh_parts)?;
    if source_elements.is_empty() {
        return Err(PlanError {
            reasons: vec![format!(
                "energy_terms[{term_index}] oersted_field source '{}' solve_region '{}' resolves to geometry '{}' but no FEM source elements were found for midpoint Biot-Savart lowering",
                source,
                resolved.solve_region,
                resolved.geometry_name,
            )],
        });
    }

    Ok(ResolvedOerstedTerm::Field(ResolvedOerstedField {
        field_xyz: midpoint_biot_savart_field(
            mesh,
            &source_elements,
            resolved.transport.current_density,
        )?,
    }))
}

fn resolve_fdm_oersted_from_current_solution(
    problem: &ProblemIR,
    term_index: usize,
    source: &str,
    current_transports: &[ResolvedCurrentTransport],
    grid_cells: [u32; 3],
    cell_size: [f64; 3],
    active_mask: Option<&[bool]>,
) -> Result<ResolvedOerstedTerm, PlanError> {
    let resolved =
        resolve_current_solution_geometry(problem, term_index, source, current_transports)?;

    if let Some((radius, center, axis)) = cylindrical_geometry_parameters(resolved.geometry) {
        let axial_current_density = project_axis_aligned_current_density(
            term_index,
            source,
            resolved.transport.current_density,
            axis,
        )?;
        let current = axial_current_density * PI * radius * radius;
        return Ok(ResolvedOerstedTerm::Cylinder(ResolvedOerstedCylinder {
            current,
            radius,
            center,
            axis,
            time_dependence: None,
        }));
    }

    let realized_geometry_name = problem
        .geometry
        .entries
        .first()
        .map(|entry| entry.name())
        .ok_or_else(|| PlanError {
            reasons: vec![format!(
                "energy_terms[{term_index}] oersted_field source '{}' requires a realized FDM geometry, but ProblemIR.geometry.entries is empty",
                source
            )],
        })?;
    if resolved.geometry_name != realized_geometry_name {
        return Err(PlanError {
            reasons: vec![format!(
                "energy_terms[{term_index}] oersted_field source '{}' resolves to geometry '{}' but the current executable FDM lane realizes only the single active geometry '{}'",
                source, resolved.geometry_name, realized_geometry_name
            )],
        });
    }

    Ok(ResolvedOerstedTerm::Field(ResolvedOerstedField {
        field_xyz: midpoint_biot_savart_grid_field(
            term_index,
            source,
            grid_cells,
            cell_size,
            active_mask,
            resolved.transport.current_density,
        )?
        .into_iter()
        .flat_map(|value| value.into_iter())
        .collect(),
    }))
}

struct ResolvedCurrentSolutionGeometry<'a> {
    transport: &'a ResolvedCurrentTransport,
    solve_region: &'a str,
    geometry_name: &'a str,
    geometry: &'a GeometryEntryIR,
}

fn resolve_current_solution_geometry<'a>(
    problem: &'a ProblemIR,
    term_index: usize,
    source: &'a str,
    current_transports: &'a [ResolvedCurrentTransport],
) -> Result<ResolvedCurrentSolutionGeometry<'a>, PlanError> {
    let transport = current_transports
        .iter()
        .find(|candidate| candidate.name == source)
        .ok_or_else(|| PlanError {
            reasons: vec![format!(
                "energy_terms[{term_index}] oersted_field source '{}' is not executable on this lane",
                source
            )],
        })?;

    let solve_region = transport.solve_region.as_deref().ok_or_else(|| PlanError {
        reasons: vec![format!(
            "energy_terms[{term_index}] oersted_field source '{}' requires CurrentTransport.solve_region for from_current_solution",
            source
        )],
    })?;

    let geometry_name = resolve_solve_region_geometry(problem, solve_region).ok_or_else(|| PlanError {
        reasons: vec![format!(
            "energy_terms[{term_index}] oersted_field source '{}' solve_region '{}' does not resolve to any known region or geometry",
            source, solve_region
        )],
    })?;

    let geometry = problem
        .geometry
        .entries
        .iter()
        .find(|entry| entry.name() == geometry_name)
        .ok_or_else(|| PlanError {
            reasons: vec![format!(
                "energy_terms[{term_index}] oersted_field source '{}' geometry '{}' is missing from ProblemIR.geometry.entries",
                source, geometry_name
            )],
        })?;

    Ok(ResolvedCurrentSolutionGeometry {
        transport,
        solve_region,
        geometry_name,
        geometry,
    })
}

fn resolve_solve_region_geometry<'a>(
    problem: &'a ProblemIR,
    solve_region: &str,
) -> Option<&'a str> {
    problem
        .regions
        .iter()
        .find(|region| region.name == solve_region)
        .map(|region| region.geometry.as_str())
        .or_else(|| {
            problem
                .geometry
                .entries
                .iter()
                .find(|entry| entry.name() == solve_region)
                .map(|entry| entry.name())
        })
}

fn cylindrical_geometry_parameters(
    geometry: &GeometryEntryIR,
) -> Option<(f64, [f64; 3], [f64; 3])> {
    fn recurse(geometry: &GeometryEntryIR, offset: [f64; 3]) -> Option<(f64, [f64; 3], [f64; 3])> {
        match geometry {
            GeometryEntryIR::Cylinder { radius, axis, .. } => Some((*radius, offset, *axis)),
            GeometryEntryIR::Translate { base, by, .. } => recurse(
                base,
                [offset[0] + by[0], offset[1] + by[1], offset[2] + by[2]],
            ),
            _ => None,
        }
    }

    recurse(geometry, [0.0, 0.0, 0.0])
}

fn project_axis_aligned_current_density(
    term_index: usize,
    source: &str,
    current_density: [f64; 3],
    axis: [f64; 3],
) -> Result<f64, PlanError> {
    let axial =
        current_density[0] * axis[0] + current_density[1] * axis[1] + current_density[2] * axis[2];
    let parallel = [axis[0] * axial, axis[1] * axial, axis[2] * axial];
    let transverse = [
        current_density[0] - parallel[0],
        current_density[1] - parallel[1],
        current_density[2] - parallel[2],
    ];
    let transverse_norm = (transverse[0] * transverse[0]
        + transverse[1] * transverse[1]
        + transverse[2] * transverse[2])
        .sqrt();
    let scale = current_density[0]
        .abs()
        .max(current_density[1].abs())
        .max(current_density[2].abs())
        .max(1.0);

    if transverse_norm > scale * 1e-9 {
        return Err(PlanError {
            reasons: vec![format!(
                "energy_terms[{term_index}] oersted_field source '{}' requires current_density to be parallel to the cylindrical axis",
                source
            )],
        });
    }

    Ok(axial)
}

fn source_element_indices(
    geometry_name: &str,
    mesh: &MeshIR,
    object_segments: &[FemObjectSegmentIR],
    mesh_parts: &[FemMeshPartIR],
) -> Result<Vec<usize>, PlanError> {
    let mut selected = BTreeSet::new();

    for part in mesh_parts {
        let geometry_match = part.geometry_id.as_deref() == Some(geometry_name)
            || part.object_id.as_deref() == Some(geometry_name);
        if !geometry_match {
            continue;
        }
        collect_elements_from_selector(
            &part.element_selector,
            &mesh.element_markers,
            &mut selected,
        )?;
    }

    if selected.is_empty() {
        for segment in object_segments {
            let geometry_match = segment.geometry_id.as_deref() == Some(geometry_name)
                || segment.object_id == geometry_name;
            if !geometry_match {
                continue;
            }
            let start = segment.element_start as usize;
            let end = start
                .saturating_add(segment.element_count as usize)
                .min(mesh.cell_count());
            for element_index in start..end {
                selected.insert(element_index);
            }
        }
    }

    Ok(selected.into_iter().collect())
}

fn collect_elements_from_selector(
    selector: &FemMeshPartSelector,
    mesh_element_markers: &[u32],
    selected: &mut BTreeSet<usize>,
) -> Result<(), PlanError> {
    match selector {
        FemMeshPartSelector::ElementMarkerSet { markers } => {
            let markers = markers.iter().copied().collect::<BTreeSet<_>>();
            for (index, marker) in mesh_element_markers.iter().copied().enumerate() {
                if markers.contains(&marker) {
                    selected.insert(index);
                }
            }
            Ok(())
        }
        FemMeshPartSelector::ElementRange { start, count } => {
            let start = *start as usize;
            let end = start
                .saturating_add(*count as usize)
                .min(mesh_element_markers.len());
            for element_index in start..end {
                selected.insert(element_index);
            }
            Ok(())
        }
        other => Err(PlanError {
            reasons: vec![format!(
                "unsupported FEM mesh-part selector {:?} for midpoint Biot-Savart Oersted lowering; expected element selector",
                other
            )],
        }),
    }
}

fn midpoint_biot_savart_field(
    mesh: &MeshIR,
    source_elements: &[usize],
    current_density: [f64; 3],
) -> Result<Vec<f64>, PlanError> {
    if mesh.nodes.is_empty() {
        return Ok(Vec::new());
    }

    let prefactor = 1.0 / (4.0 * PI);
    let mut field_xyz = vec![0.0; mesh.nodes.len() * 3];

    for &element_index in source_elements {
        let cell_type = mesh
            .cells
            .types
            .get(element_index)
            .copied()
            .ok_or_else(|| PlanError {
                reasons: vec![format!(
                    "midpoint Biot-Savart lowering referenced missing FEM element index {}",
                    element_index
                )],
            })?;
        if cell_type != fullmag_ir::FemCellTypeIR::Tet4 {
            return Err(PlanError {
                reasons: vec![format!(
                    "midpoint Biot-Savart Oersted lowering is tet4-only; FEM cell {} is {:?}",
                    element_index, cell_type
                )],
            });
        }
        let element = mesh
            .cells
            .item_nodes(element_index)
            .ok_or_else(|| PlanError {
                reasons: vec![format!(
                    "midpoint Biot-Savart lowering referenced invalid FEM cell CSR index {}",
                    element_index
                )],
            })?;

        let p0 = node(mesh, element[0])?;
        let p1 = node(mesh, element[1])?;
        let p2 = node(mesh, element[2])?;
        let p3 = node(mesh, element[3])?;
        let volume = tetrahedron_volume(p0, p1, p2, p3);
        if !(volume.is_finite()) || volume <= 0.0 {
            continue;
        }
        let centroid = [
            (p0[0] + p1[0] + p2[0] + p3[0]) * 0.25,
            (p0[1] + p1[1] + p2[1] + p3[1]) * 0.25,
            (p0[2] + p1[2] + p2[2] + p3[2]) * 0.25,
        ];
        let regularization_radius = ((3.0 * volume) / (4.0 * PI)).cbrt();
        let regularization_sq = regularization_radius * regularization_radius;

        for (node_index, point) in mesh.nodes.iter().enumerate() {
            let rx = point[0] - centroid[0];
            let ry = point[1] - centroid[1];
            let rz = point[2] - centroid[2];
            let r_sq = rx * rx + ry * ry + rz * rz;
            let denom = (r_sq + regularization_sq).powf(1.5).max(1e-30);
            let coeff = prefactor * volume / denom;
            let hx = coeff * (current_density[1] * rz - current_density[2] * ry);
            let hy = coeff * (current_density[2] * rx - current_density[0] * rz);
            let hz = coeff * (current_density[0] * ry - current_density[1] * rx);
            let base = node_index * 3;
            field_xyz[base] += hx;
            field_xyz[base + 1] += hy;
            field_xyz[base + 2] += hz;
        }
    }

    Ok(field_xyz)
}

fn midpoint_biot_savart_grid_field(
    term_index: usize,
    source: &str,
    grid_cells: [u32; 3],
    cell_size: [f64; 3],
    active_mask: Option<&[bool]>,
    current_density: [f64; 3],
) -> Result<Vec<[f64; 3]>, PlanError> {
    const MAX_GENERAL_FDM_SOURCE_CELLS: usize = 4096;

    let nx = grid_cells[0] as usize;
    let ny = grid_cells[1] as usize;
    let nz = grid_cells[2] as usize;
    let cell_cost = checked_fdm_grid_cost(grid_cells, FDM_GRID_ESTIMATED_BYTES_PER_CELL)?;
    let cell_count = usize::try_from(cell_cost.cells).map_err(|_| PlanError {
        reasons: vec![format!(
            "energy_terms[{term_index}] oersted_field source '{}' FDM cell count {} is not addressable",
            source, cell_cost.cells
        )],
    })?;
    if let Some(mask) = active_mask {
        if mask.len() != cell_count {
            return Err(PlanError {
                reasons: vec![format!(
                    "energy_terms[{term_index}] oersted_field source '{}' saw active_mask length {} that does not match realized FDM cell count {}",
                    source,
                    mask.len(),
                    cell_count
                )],
            });
        }
    }

    let cell_volume = cell_size[0] * cell_size[1] * cell_size[2];
    let regularization_radius = ((3.0 * cell_volume) / (4.0 * PI)).cbrt();
    let regularization_sq = regularization_radius * regularization_radius;
    let prefactor = cell_volume / (4.0 * PI);

    let active_source_count = active_mask
        .map(|mask| mask.iter().filter(|active| **active).count())
        .unwrap_or(cell_count);
    if active_source_count > MAX_GENERAL_FDM_SOURCE_CELLS {
        return Err(PlanError {
            reasons: vec![format!(
                "energy_terms[{term_index}] oersted_field source '{}' requires midpoint Biot-Savart on {} active FDM cells, which exceeds the current public planner limit of {}; refine the source analytically (cylindrical path) or use the native FEM midpoint path instead",
                source,
                active_source_count,
                MAX_GENERAL_FDM_SOURCE_CELLS
            )],
        });
    }

    let mut source_points = Vec::with_capacity(active_source_count);
    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                let index = x + nx * (y + ny * z);
                if active_mask.is_some_and(|mask| !mask[index]) {
                    continue;
                }
                source_points.push([
                    (x as f64 + 0.5) * cell_size[0],
                    (y as f64 + 0.5) * cell_size[1],
                    (z as f64 + 0.5) * cell_size[2],
                ]);
            }
        }
    }

    let mut field_xyz = vec![[0.0, 0.0, 0.0]; cell_count];
    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                let target_index = x + nx * (y + ny * z);
                if active_mask.is_some_and(|mask| !mask[target_index]) {
                    continue;
                }
                let target = [
                    (x as f64 + 0.5) * cell_size[0],
                    (y as f64 + 0.5) * cell_size[1],
                    (z as f64 + 0.5) * cell_size[2],
                ];
                let mut accum = [0.0, 0.0, 0.0];
                for source_point in &source_points {
                    let rx = target[0] - source_point[0];
                    let ry = target[1] - source_point[1];
                    let rz = target[2] - source_point[2];
                    let denom = (rx * rx + ry * ry + rz * rz + regularization_sq)
                        .powf(1.5)
                        .max(1e-30);
                    let coeff = prefactor / denom;
                    accum[0] += coeff * (current_density[1] * rz - current_density[2] * ry);
                    accum[1] += coeff * (current_density[2] * rx - current_density[0] * rz);
                    accum[2] += coeff * (current_density[0] * ry - current_density[1] * rx);
                }
                field_xyz[target_index] = accum;
            }
        }
    }

    Ok(field_xyz)
}

fn node(mesh: &MeshIR, node_index: u32) -> Result<[f64; 3], PlanError> {
    mesh.nodes
        .get(node_index as usize)
        .copied()
        .ok_or_else(|| PlanError {
            reasons: vec![format!(
                "midpoint Biot-Savart lowering referenced missing FEM node index {}",
                node_index
            )],
        })
}

fn tetrahedron_volume(p0: [f64; 3], p1: [f64; 3], p2: [f64; 3], p3: [f64; 3]) -> f64 {
    let d1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    let d2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    let d3 = [p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]];
    let cross = [
        d2[1] * d3[2] - d2[2] * d3[1],
        d2[2] * d3[0] - d2[0] * d3[2],
        d2[0] * d3[1] - d2[1] * d3[0],
    ];
    ((d1[0] * cross[0] + d1[1] * cross[1] + d1[2] * cross[2]).abs()) / 6.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{FemMeshPartRole, RegionIR};

    #[test]
    fn lowers_cylindrical_current_transport_to_oersted_cylinder() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.geometry.entries[0] = GeometryEntryIR::Translate {
            name: "pillar".to_string(),
            base: Box::new(GeometryEntryIR::Cylinder {
                name: "pillar_base".to_string(),
                radius: 25e-9,
                height: 10e-9,
                axis: [0.0, 0.0, 1.0],
            }),
            by: [1e-9, -2e-9, 0.0],
        };
        problem.regions = vec![RegionIR {
            name: "pillar_region".to_string(),
            geometry: "pillar".to_string(),
        }];
        problem.energy_terms = vec![EnergyTermIR::OerstedField {
            model: OerstedFieldModelIR::FromCurrentSolution,
            source: "drive".to_string(),
        }];

        let resolved = resolve_oersted_term(
            &problem,
            0,
            &problem.energy_terms[0],
            &[ResolvedCurrentTransport {
                name: "drive".to_string(),
                current_density: [0.0, 0.0, 5e10],
                solve_region: Some("pillar_region".to_string()),
            }],
        )
        .unwrap()
        .unwrap();

        assert_eq!(resolved.radius, 25e-9);
        assert_eq!(resolved.center, [1e-9, -2e-9, 0.0]);
        assert_eq!(resolved.axis, [0.0, 0.0, 1.0]);
        let expected_current = 5e10 * PI * (25e-9_f64 * 25e-9_f64);
        assert!((resolved.current - expected_current).abs() < expected_current * 1e-12);
    }

    #[test]
    fn rejects_off_axis_current_density() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.geometry.entries[0] = GeometryEntryIR::Cylinder {
            name: "pillar".to_string(),
            radius: 25e-9,
            height: 10e-9,
            axis: [0.0, 0.0, 1.0],
        };
        problem.energy_terms = vec![EnergyTermIR::OerstedField {
            model: OerstedFieldModelIR::FromCurrentSolution,
            source: "drive".to_string(),
        }];

        let err = resolve_oersted_term(
            &problem,
            0,
            &problem.energy_terms[0],
            &[ResolvedCurrentTransport {
                name: "drive".to_string(),
                current_density: [1e10, 0.0, 5e10],
                solve_region: Some("pillar".to_string()),
            }],
        )
        .unwrap_err();

        assert!(err
            .reasons
            .iter()
            .any(|reason| reason.contains("parallel to the cylindrical axis")));
    }

    #[test]
    fn fem_non_cylindrical_source_lowers_to_midpoint_field() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.geometry.entries[0] = GeometryEntryIR::Box {
            name: "wire".to_string(),
            size: [2.0, 1.0, 1.0],
        };
        problem.energy_terms = vec![EnergyTermIR::OerstedField {
            model: OerstedFieldModelIR::FromCurrentSolution,
            source: "drive".to_string(),
        }];

        let mesh = MeshIR {
            mesh_name: "wire_mesh".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [2.0, 0.0, 0.0],
            ],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
            element_markers: vec![7],
            facets: fullmag_ir::FemFacetConnectivityIR::empty(),
            boundary_markers: vec![],
            periodic_boundary_pairs: vec![],
            periodic_node_pairs: vec![],
            per_domain_quality: Default::default(),
        };
        let mesh_parts = vec![FemMeshPartIR {
            id: "wire_part".to_string(),
            label: "wire".to_string(),
            role: FemMeshPartRole::MagneticObject,
            object_id: None,
            geometry_id: Some("wire".to_string()),
            material_id: None,
            element_selector: FemMeshPartSelector::ElementMarkerSet { markers: vec![7] },
            boundary_face_selector: FemMeshPartSelector::BoundaryFaceRange { start: 0, count: 0 },
            node_selector: FemMeshPartSelector::NodeRange { start: 0, count: 0 },
            boundary_face_indices: vec![],
            node_indices: vec![],
            facet_global_ordinals: vec![],
            bounds_min: None,
            bounds_max: None,
            parent_id: None,
        }];

        let resolved = resolve_fem_oersted_term(
            &problem,
            0,
            &problem.energy_terms[0],
            &[ResolvedCurrentTransport {
                name: "drive".to_string(),
                current_density: [1.0, 0.0, 0.0],
                solve_region: Some("wire".to_string()),
            }],
            &mesh,
            &[],
            &mesh_parts,
        )
        .unwrap()
        .unwrap();

        match resolved {
            ResolvedOerstedTerm::Field(field) => {
                assert_eq!(field.field_xyz.len(), mesh.nodes.len() * 3);
                assert!(field.field_xyz.iter().any(|value| value.abs() > 0.0));
            }
            other => panic!("expected midpoint field lowering, got {:?}", other),
        }
    }

    #[test]
    fn fdm_non_cylindrical_source_lowers_to_midpoint_field() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.geometry.entries[0] = GeometryEntryIR::Box {
            name: "wire".to_string(),
            size: [2.0, 1.0, 1.0],
        };
        problem.regions = vec![RegionIR {
            name: "wire_region".to_string(),
            geometry: "wire".to_string(),
        }];
        problem.energy_terms = vec![EnergyTermIR::OerstedField {
            model: OerstedFieldModelIR::FromCurrentSolution,
            source: "drive".to_string(),
        }];

        let resolved = resolve_fdm_oersted_term(
            &problem,
            0,
            &problem.energy_terms[0],
            &[ResolvedCurrentTransport {
                name: "drive".to_string(),
                current_density: [1.0, 0.0, 0.0],
                solve_region: Some("wire_region".to_string()),
            }],
            [2, 2, 1],
            [1.0, 1.0, 1.0],
            None,
        )
        .unwrap()
        .unwrap();

        match resolved {
            ResolvedOerstedTerm::Field(field) => {
                assert_eq!(field.field_xyz.len(), 2 * 2 * 1 * 3);
                assert!(field.field_xyz.iter().any(|value| value.abs() > 0.0));
            }
            other => panic!("expected midpoint field lowering, got {:?}", other),
        }
    }
}
