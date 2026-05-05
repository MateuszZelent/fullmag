use crate::fem::{FemLlgProblem, MeshTopology};
use crate::{
    norm, normalized, sub, CellSize, EffectiveFieldTerms, EngineError, ExchangeLlgProblem,
    GridShape, LlgConfig, MaterialParameters, TimeIntegrator, Vector3, DEFAULT_GYROMAGNETIC_RATIO,
};
use fullmag_ir::{MeshIR, MeshPeriodicBoundaryPairIR, MeshPeriodicNodePairIR};
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct ExchangeDensityPair {
    pub level_label: String,
    pub fdm_cells_per_axis: usize,
    pub fem_divisions_per_axis: usize,
    pub fdm_total_cells: usize,
    pub fem_nodes: usize,
    pub fem_elements: usize,
    pub fdm_h_m: f64,
    pub fem_h_m: f64,
    pub fdm_exchange_energy_density_j_per_m3: f64,
    pub fem_exchange_energy_density_j_per_m3: f64,
    pub fdm_center_exchange_field: Vector3,
    pub fem_center_exchange_field: Vector3,
    pub fdm_center_exchange_field_norm: f64,
    pub fem_center_exchange_field_norm: f64,
    pub relative_energy_gap: f64,
    pub center_field_gap_norm: f64,
    pub relative_center_field_gap: f64,
}

#[derive(Debug, Clone)]
pub struct ExchangeDensityStudy {
    pub box_size_m: [f64; 3],
    pub pairs: Vec<ExchangeDensityPair>,
}

pub fn default_exchange_density_levels() -> Vec<(usize, usize)> {
    vec![(5, 2), (9, 4), (13, 6), (17, 8)]
}

pub fn run_default_exchange_density_study() -> std::result::Result<ExchangeDensityStudy, EngineError>
{
    run_exchange_density_study([40e-9, 40e-9, 40e-9], &default_exchange_density_levels())
}

pub fn run_exchange_density_study(
    box_size_m: [f64; 3],
    levels: &[(usize, usize)],
) -> std::result::Result<ExchangeDensityStudy, EngineError> {
    let material = MaterialParameters::new(800e3, 13e-12, 0.1)?;
    let dynamics = LlgConfig::new(DEFAULT_GYROMAGNETIC_RATIO, TimeIntegrator::Heun)?;
    let volume = box_size_m[0] * box_size_m[1] * box_size_m[2];

    let mut pairs = Vec::with_capacity(levels.len());

    for (fdm_cells_per_axis, fem_divisions_per_axis) in levels.iter().copied() {
        let fdm_grid = GridShape::new(fdm_cells_per_axis, fdm_cells_per_axis, fdm_cells_per_axis)?;
        let fdm_cell_size = CellSize::new(
            box_size_m[0] / fdm_cells_per_axis as f64,
            box_size_m[1] / fdm_cells_per_axis as f64,
            box_size_m[2] / fdm_cells_per_axis as f64,
        )?;
        let fdm_problem = ExchangeLlgProblem::with_terms(
            fdm_grid,
            fdm_cell_size,
            material,
            dynamics,
            EffectiveFieldTerms {
                exchange: true,
                demag: false,
                external_field: None,
                per_node_field: None,
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let fdm_state = fdm_problem.new_state(sample_fdm_magnetization(
            fdm_grid,
            fdm_cell_size,
            box_size_m,
        )?)?;
        let fdm_field = fdm_problem.exchange_field(&fdm_state)?;
        let fdm_observables = fdm_problem.observe(&fdm_state)?;
        let fdm_center_index = fdm_grid.index(
            fdm_cells_per_axis / 2,
            fdm_cells_per_axis / 2,
            fdm_cells_per_axis / 2,
        );
        let fdm_center_field = fdm_field[fdm_center_index];

        let fem_mesh = build_structured_box_tet_mesh(box_size_m, fem_divisions_per_axis);
        let fem_nodes = fem_mesh.nodes.len();
        let fem_elements = fem_mesh.elements.len();
        let fem_center_index = structured_node_index(
            fem_divisions_per_axis / 2,
            fem_divisions_per_axis / 2,
            fem_divisions_per_axis / 2,
            fem_divisions_per_axis,
        );
        let fem_problem = FemLlgProblem::with_terms(
            MeshTopology::from_ir(&fem_mesh)?,
            material,
            dynamics,
            EffectiveFieldTerms {
                exchange: true,
                demag: false,
                external_field: None,
                per_node_field: None,
                magnetoelastic: None,
                ..Default::default()
            },
        );
        let fem_state = fem_problem.new_state(sample_fem_magnetization(&fem_mesh, box_size_m)?)?;
        let fem_field = fem_problem.exchange_field(&fem_state)?;
        let fem_observables = fem_problem.observe(&fem_state)?;
        let fem_center_field = fem_field[fem_center_index];

        let fdm_energy_density = fdm_observables.exchange_energy_joules / volume;
        let fem_energy_density = fem_observables.exchange_energy_joules / volume;
        let relative_energy_gap = relative_gap(fdm_energy_density, fem_energy_density);
        let center_field_gap_norm = norm(sub(fdm_center_field, fem_center_field));
        let relative_center_field_gap = center_field_gap_norm
            / fdm_center_field_norm_max(norm(fdm_center_field), norm(fem_center_field));

        pairs.push(ExchangeDensityPair {
            level_label: format!("{}c/{}d", fdm_cells_per_axis, fem_divisions_per_axis),
            fdm_cells_per_axis,
            fem_divisions_per_axis,
            fdm_total_cells: fdm_grid.cell_count(),
            fem_nodes,
            fem_elements,
            fdm_h_m: box_size_m[0] / fdm_cells_per_axis as f64,
            fem_h_m: box_size_m[0] / fem_divisions_per_axis as f64,
            fdm_exchange_energy_density_j_per_m3: fdm_energy_density,
            fem_exchange_energy_density_j_per_m3: fem_energy_density,
            fdm_center_exchange_field: fdm_center_field,
            fem_center_exchange_field: fem_center_field,
            fdm_center_exchange_field_norm: norm(fdm_center_field),
            fem_center_exchange_field_norm: norm(fem_center_field),
            relative_energy_gap,
            center_field_gap_norm,
            relative_center_field_gap,
        });
    }

    Ok(ExchangeDensityStudy { box_size_m, pairs })
}

pub fn write_exchange_density_csv(
    study: &ExchangeDensityStudy,
    path: impl AsRef<Path>,
) -> std::io::Result<()> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut csv = String::from(
        "level,fdm_cells_per_axis,fem_divisions_per_axis,fdm_total_cells,fem_nodes,fem_elements,fdm_h_m,fem_h_m,fdm_energy_density_j_per_m3,fem_energy_density_j_per_m3,relative_energy_gap,fdm_center_hx,fdm_center_hy,fdm_center_hz,fem_center_hx,fem_center_hy,fem_center_hz,fdm_center_field_norm,fem_center_field_norm,center_field_gap_norm,relative_center_field_gap\n",
    );
    for pair in &study.pairs {
        let _ = writeln!(
            csv,
            "{},{},{},{},{},{},{:.16e},{:.16e},{:.16e},{:.16e},{:.16e},{:.16e},{:.16e},{:.16e},{:.16e},{:.16e},{:.16e},{:.16e},{:.16e},{:.16e},{:.16e}",
            pair.level_label,
            pair.fdm_cells_per_axis,
            pair.fem_divisions_per_axis,
            pair.fdm_total_cells,
            pair.fem_nodes,
            pair.fem_elements,
            pair.fdm_h_m,
            pair.fem_h_m,
            pair.fdm_exchange_energy_density_j_per_m3,
            pair.fem_exchange_energy_density_j_per_m3,
            pair.relative_energy_gap,
            pair.fdm_center_exchange_field[0],
            pair.fdm_center_exchange_field[1],
            pair.fdm_center_exchange_field[2],
            pair.fem_center_exchange_field[0],
            pair.fem_center_exchange_field[1],
            pair.fem_center_exchange_field[2],
            pair.fdm_center_exchange_field_norm,
            pair.fem_center_exchange_field_norm,
            pair.center_field_gap_norm,
            pair.relative_center_field_gap,
        );
    }
    fs::write(path, csv)
}

pub fn write_exchange_density_svg(
    study: &ExchangeDensityStudy,
    path: impl AsRef<Path>,
) -> std::io::Result<()> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let width = 1040.0;
    let height = 820.0;
    let left = 90.0;
    let right = 40.0;
    let top = 80.0;
    let chart_width = width - left - right;
    let chart_height = 240.0;
    let panel_gap = 120.0;
    let top_panel_y = top + chart_height;
    let bottom_panel_y = top + chart_height + panel_gap + chart_height;

    let levels = study.pairs.len().max(1);
    let x_at = |index: usize| {
        if levels == 1 {
            left + chart_width / 2.0
        } else {
            left + chart_width * index as f64 / (levels as f64 - 1.0)
        }
    };

    let mut energy_min = f64::INFINITY;
    let mut energy_max = f64::NEG_INFINITY;
    let gap_min = 0.0;
    let mut gap_max = f64::NEG_INFINITY;
    for pair in &study.pairs {
        energy_min = energy_min
            .min(pair.fdm_exchange_energy_density_j_per_m3)
            .min(pair.fem_exchange_energy_density_j_per_m3);
        energy_max = energy_max
            .max(pair.fdm_exchange_energy_density_j_per_m3)
            .max(pair.fem_exchange_energy_density_j_per_m3);
        gap_max = gap_max
            .max(pair.relative_energy_gap)
            .max(pair.relative_center_field_gap);
    }
    if !energy_min.is_finite() || !energy_max.is_finite() || (energy_max - energy_min).abs() < 1e-30
    {
        energy_min = 0.0;
        energy_max = 1.0;
    }
    if !gap_max.is_finite() || gap_max <= gap_min {
        gap_max = 1.0;
    }

    let energy_pad = 0.08 * (energy_max - energy_min).max(1e-30);
    energy_min -= energy_pad;
    energy_max += energy_pad;
    let gap_pad = 0.1 * gap_max.max(1e-30);
    gap_max += gap_pad;

    let map_y = |value: f64, min: f64, max: f64, bottom: f64| {
        bottom - ((value - min) / (max - min).max(1e-30)) * chart_height
    };

    let mut svg = String::new();
    let _ = writeln!(
        svg,
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">"#
    );
    svg.push_str("<rect width=\"100%\" height=\"100%\" fill=\"#07101c\"/>\n");
    svg.push_str("<style>text{font-family:IBM Plex Sans,Segoe UI,sans-serif;fill:#d9e6ff} .muted{fill:#8ea3c5} .axis{stroke:#50627f;stroke-width:1} .grid{stroke:#203047;stroke-width:1;stroke-dasharray:4 6} .fdm{stroke:#57c8b6;fill:none;stroke-width:3} .fem{stroke:#6ba7ff;fill:none;stroke-width:3} .gap{stroke:#ffb86c;fill:none;stroke-width:3} .fieldgap{stroke:#ff6f91;fill:none;stroke-width:3}</style>\n");
    svg.push_str("<text x=\"90\" y=\"36\" font-size=\"26\" font-weight=\"700\">FDM vs FEM exchange consistency study</text>\n");
    svg.push_str("<text x=\"90\" y=\"60\" class=\"muted\" font-size=\"14\">Smooth analytic magnetization on a 40 nm cube. Lines compare exchange energy density and backend gaps as mesh density increases.</text>\n");

    // axes and labels
    draw_panel(
        &mut svg,
        left,
        top,
        chart_width,
        chart_height,
        "Exchange energy density [J/m^3]",
    );
    draw_panel(
        &mut svg,
        left,
        top + chart_height + panel_gap,
        chart_width,
        chart_height,
        "Relative backend gap [-]",
    );

    // grid + x labels
    for (index, pair) in study.pairs.iter().enumerate() {
        let x = x_at(index);
        let _ = writeln!(svg, "<line x1=\"{x:.2}\" y1=\"{top:.2}\" x2=\"{x:.2}\" y2=\"{bottom_panel_y:.2}\" class=\"grid\" opacity=\"0.45\"/>");
        let _ = writeln!(svg, "<text x=\"{x:.2}\" y=\"{:.2}\" text-anchor=\"middle\" class=\"muted\" font-size=\"12\">{}</text>", top_panel_y + 24.0, pair.level_label);
        let _ = writeln!(svg, "<text x=\"{x:.2}\" y=\"{:.2}\" text-anchor=\"middle\" class=\"muted\" font-size=\"11\">h_FDM={:.2} nm · h_FEM={:.2} nm</text>", bottom_panel_y + 32.0, pair.fdm_h_m * 1e9, pair.fem_h_m * 1e9);
    }

    draw_y_ticks(
        &mut svg,
        left,
        top_panel_y,
        energy_min,
        energy_max,
        chart_height,
        5,
        false,
    );
    draw_y_ticks(
        &mut svg,
        left,
        bottom_panel_y,
        gap_min,
        gap_max,
        chart_height,
        5,
        true,
    );

    let fdm_energy_path = path_from_values(
        &study.pairs,
        |pair| pair.fdm_exchange_energy_density_j_per_m3,
        |value| map_y(value, energy_min, energy_max, top_panel_y),
        &x_at,
    );
    let fem_energy_path = path_from_values(
        &study.pairs,
        |pair| pair.fem_exchange_energy_density_j_per_m3,
        |value| map_y(value, energy_min, energy_max, top_panel_y),
        &x_at,
    );
    let energy_gap_path = path_from_values(
        &study.pairs,
        |pair| pair.relative_energy_gap,
        |value| map_y(value, gap_min, gap_max, bottom_panel_y),
        &x_at,
    );
    let field_gap_path = path_from_values(
        &study.pairs,
        |pair| pair.relative_center_field_gap,
        |value| map_y(value, gap_min, gap_max, bottom_panel_y),
        &x_at,
    );

    let _ = writeln!(svg, "<path d=\"{}\" class=\"fdm\"/>", fdm_energy_path);
    let _ = writeln!(svg, "<path d=\"{}\" class=\"fem\"/>", fem_energy_path);
    let _ = writeln!(svg, "<path d=\"{}\" class=\"gap\"/>", energy_gap_path);
    let _ = writeln!(svg, "<path d=\"{}\" class=\"fieldgap\"/>", field_gap_path);

    let legend_y = height - 64.0;
    legend_entry(
        &mut svg,
        90.0,
        legend_y,
        "fdm",
        "FDM exchange energy density",
    );
    legend_entry(
        &mut svg,
        360.0,
        legend_y,
        "fem",
        "FEM exchange energy density",
    );
    legend_entry(&mut svg, 640.0, legend_y, "gap", "Relative energy gap");
    legend_entry(
        &mut svg,
        840.0,
        legend_y,
        "fieldgap",
        "Relative center-field gap",
    );

    svg.push_str("</svg>\n");
    fs::write(path, svg)
}

fn draw_panel(svg: &mut String, left: f64, top: f64, width: f64, height: f64, title: &str) {
    let _ = writeln!(svg, "<rect x=\"{left:.2}\" y=\"{top:.2}\" width=\"{width:.2}\" height=\"{height:.2}\" rx=\"18\" fill=\"rgba(8,16,29,0.72)\" stroke=\"#203047\"/>");
    let _ = writeln!(
        svg,
        "<text x=\"{:.2}\" y=\"{:.2}\" font-size=\"16\" font-weight=\"600\">{}</text>",
        left,
        top - 16.0,
        title
    );
    let _ = writeln!(
        svg,
        "<line x1=\"{left:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" class=\"axis\"/>",
        top + height,
        left + width,
        top + height
    );
    let _ = writeln!(
        svg,
        "<line x1=\"{left:.2}\" y1=\"{top:.2}\" x2=\"{left:.2}\" y2=\"{:.2}\" class=\"axis\"/>",
        top + height
    );
}

fn draw_y_ticks(
    svg: &mut String,
    left: f64,
    bottom: f64,
    min: f64,
    max: f64,
    height: f64,
    count: usize,
    percent: bool,
) {
    for tick in 0..=count {
        let t = tick as f64 / count as f64;
        let y = bottom - t * height;
        let value = min + t * (max - min);
        let label = if percent {
            format!("{:.2}", value)
        } else {
            format!("{:.3e}", value)
        };
        let _ = writeln!(svg, "<line x1=\"{left:.2}\" y1=\"{y:.2}\" x2=\"{:.2}\" y2=\"{y:.2}\" class=\"grid\" opacity=\"0.55\"/>", left + 910.0);
        let _ = writeln!(svg, "<text x=\"{:.2}\" y=\"{:.2}\" text-anchor=\"end\" class=\"muted\" font-size=\"11\">{}</text>", left - 10.0, y + 4.0, label);
    }
}

fn path_from_values<F, Y>(
    pairs: &[ExchangeDensityPair],
    value: F,
    y_map: Y,
    x_at: &dyn Fn(usize) -> f64,
) -> String
where
    F: Fn(&ExchangeDensityPair) -> f64,
    Y: Fn(f64) -> f64,
{
    let mut path = String::new();
    for (index, pair) in pairs.iter().enumerate() {
        let x = x_at(index);
        let y = y_map(value(pair));
        if index == 0 {
            let _ = write!(path, "M {:.3} {:.3}", x, y);
        } else {
            let _ = write!(path, " L {:.3} {:.3}", x, y);
        }
    }
    path
}

fn legend_entry(svg: &mut String, x: f64, y: f64, class_name: &str, label: &str) {
    let _ = writeln!(
        svg,
        "<line x1=\"{:.2}\" y1=\"{:.2}\" x2=\"{:.2}\" y2=\"{:.2}\" class=\"{}\"/>",
        x,
        y,
        x + 32.0,
        y,
        class_name
    );
    let _ = writeln!(
        svg,
        "<text x=\"{:.2}\" y=\"{:.2}\" font-size=\"12\">{}</text>",
        x + 42.0,
        y + 4.0,
        label
    );
}

fn fdm_center_field_norm_max(lhs: f64, rhs: f64) -> f64 {
    lhs.max(rhs).max(1e-30)
}

fn relative_gap(lhs: f64, rhs: f64) -> f64 {
    (lhs - rhs).abs() / lhs.abs().max(rhs.abs()).max(1e-30)
}

fn sample_fdm_magnetization(
    grid: GridShape,
    cell_size: CellSize,
    box_size_m: [f64; 3],
) -> std::result::Result<Vec<Vector3>, EngineError> {
    let mut magnetization = Vec::with_capacity(grid.cell_count());
    for z in 0..grid.nz {
        for y in 0..grid.ny {
            for x in 0..grid.nx {
                let position = [
                    -0.5 * box_size_m[0] + (x as f64 + 0.5) * cell_size.dx,
                    -0.5 * box_size_m[1] + (y as f64 + 0.5) * cell_size.dy,
                    -0.5 * box_size_m[2] + (z as f64 + 0.5) * cell_size.dz,
                ];
                magnetization.push(analytic_magnetization(position, box_size_m)?);
            }
        }
    }
    Ok(magnetization)
}

fn sample_fem_magnetization(
    mesh: &MeshIR,
    box_size_m: [f64; 3],
) -> std::result::Result<Vec<Vector3>, EngineError> {
    mesh.nodes
        .iter()
        .copied()
        .map(|position| analytic_magnetization(position, box_size_m))
        .collect()
}

fn analytic_magnetization(
    position: [f64; 3],
    box_size_m: [f64; 3],
) -> std::result::Result<Vector3, EngineError> {
    let sx = std::f64::consts::PI * position[0] / box_size_m[0];
    let sy = std::f64::consts::PI * position[1] / box_size_m[1];
    let sz = std::f64::consts::PI * position[2] / box_size_m[2];
    normalized([
        0.55 * sx.sin() + 0.20 * sy.cos(),
        0.45 * sy.sin() - 0.15 * sz.cos(),
        0.35 + 0.20 * sx.cos() * sy.cos() + 0.10 * sz.sin(),
    ])
}

pub(crate) fn build_structured_box_tet_mesh(box_size_m: [f64; 3], divisions: usize) -> MeshIR {
    let nx = divisions;
    let ny = divisions;
    let nz = divisions;
    let dx = box_size_m[0] / nx as f64;
    let dy = box_size_m[1] / ny as f64;
    let dz = box_size_m[2] / nz as f64;

    let mut nodes = Vec::with_capacity((nx + 1) * (ny + 1) * (nz + 1));
    for k in 0..=nz {
        let z = -0.5 * box_size_m[2] + k as f64 * dz;
        for j in 0..=ny {
            let y = -0.5 * box_size_m[1] + j as f64 * dy;
            for i in 0..=nx {
                let x = -0.5 * box_size_m[0] + i as f64 * dx;
                nodes.push([x, y, z]);
            }
        }
    }

    let mut elements = Vec::with_capacity(nx * ny * nz * 6);
    for k in 0..nz {
        for j in 0..ny {
            for i in 0..nx {
                let n0 = structured_node_index(i, j, k, divisions) as u32;
                let n1 = structured_node_index(i + 1, j, k, divisions) as u32;
                let n2 = structured_node_index(i + 1, j + 1, k, divisions) as u32;
                let n3 = structured_node_index(i, j + 1, k, divisions) as u32;
                let n4 = structured_node_index(i, j, k + 1, divisions) as u32;
                let n5 = structured_node_index(i + 1, j, k + 1, divisions) as u32;
                let n6 = structured_node_index(i + 1, j + 1, k + 1, divisions) as u32;
                let n7 = structured_node_index(i, j + 1, k + 1, divisions) as u32;
                elements.extend_from_slice(&[
                    [n0, n1, n2, n6],
                    [n0, n2, n3, n6],
                    [n0, n3, n7, n6],
                    [n0, n7, n4, n6],
                    [n0, n4, n5, n6],
                    [n0, n5, n1, n6],
                ]);
            }
        }
    }

    let boundary_faces = collect_boundary_faces(&elements);
    let element_count = elements.len();
    let boundary_face_count = boundary_faces.len();
    let (periodic_boundary_pairs, periodic_node_pairs) = structured_periodic_pairs(divisions);
    MeshIR {
        mesh_name: format!("structured_box_{}", divisions),
        nodes,
        elements,
        element_markers: vec![1; element_count],
        boundary_faces,
        boundary_markers: vec![1; boundary_face_count],
        periodic_boundary_pairs,
        periodic_node_pairs,
        per_domain_quality: Default::default(),
    }
}

fn structured_node_index(i: usize, j: usize, k: usize, divisions: usize) -> usize {
    let stride = divisions + 1;
    i + stride * (j + stride * k)
}

fn collect_boundary_faces(elements: &[[u32; 4]]) -> Vec<[u32; 3]> {
    let mut faces: BTreeMap<[u32; 3], ([u32; 3], usize)> = BTreeMap::new();
    for element in elements {
        let local_faces = [
            [element[0], element[1], element[2]],
            [element[0], element[1], element[3]],
            [element[0], element[2], element[3]],
            [element[1], element[2], element[3]],
        ];
        for face in local_faces {
            let mut sorted = face;
            sorted.sort_unstable();
            faces
                .entry(sorted)
                .and_modify(|entry| entry.1 += 1)
                .or_insert((face, 1));
        }
    }
    faces
        .into_iter()
        .filter_map(|(_, (face, count))| (count == 1).then_some(face))
        .collect()
}

fn structured_periodic_pairs(
    divisions: usize,
) -> (Vec<MeshPeriodicBoundaryPairIR>, Vec<MeshPeriodicNodePairIR>) {
    let mut boundary_pairs = Vec::with_capacity(3);
    let mut node_pairs = Vec::new();
    let pair_specs = [
        ("x_faces", 0usize),
        ("y_faces", 1usize),
        ("z_faces", 2usize),
    ];

    for (pair_id, axis) in pair_specs {
        boundary_pairs.push(MeshPeriodicBoundaryPairIR {
            pair_id: pair_id.to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 1,
            marker_b: 1,
            translation: None,
            tolerance: None,
            axis_hint: None,
            orientation: None,
            pairing_policy: None,
        });
        for k in 0..=divisions {
            for j in 0..=divisions {
                match axis {
                    0 => node_pairs.push(MeshPeriodicNodePairIR {
                        pair_id: pair_id.to_string(),
                        node_a: structured_node_index(0, j, k, divisions) as u32,
                        node_b: structured_node_index(divisions, j, k, divisions) as u32,
                    }),
                    1 => node_pairs.push(MeshPeriodicNodePairIR {
                        pair_id: pair_id.to_string(),
                        node_a: structured_node_index(j, 0, k, divisions) as u32,
                        node_b: structured_node_index(j, divisions, k, divisions) as u32,
                    }),
                    _ => node_pairs.push(MeshPeriodicNodePairIR {
                        pair_id: pair_id.to_string(),
                        node_a: structured_node_index(j, k, 0, divisions) as u32,
                        node_b: structured_node_index(j, k, divisions, divisions) as u32,
                    }),
                }
            }
        }
    }

    (boundary_pairs, node_pairs)
}

#[cfg(test)]
mod tests {
    use super::build_structured_box_tet_mesh;

    #[test]
    fn structured_box_mesh_exports_periodic_pairs_for_all_axes() {
        let mesh = build_structured_box_tet_mesh([6.0, 8.0, 10.0], 2);
        let mut pair_ids = mesh
            .periodic_boundary_pairs
            .iter()
            .map(|pair| pair.pair_id.as_str())
            .collect::<Vec<_>>();
        pair_ids.sort_unstable();
        assert_eq!(pair_ids, vec!["x_faces", "y_faces", "z_faces"]);
        assert_eq!(mesh.periodic_node_pairs.len(), 27);
        assert!(mesh.validate().is_ok());
    }
}
