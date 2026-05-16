use crate::fem::{FemLlgProblem, MeshTopology};
use crate::studies::build_structured_box_tet_mesh;
use crate::{
    normalized, EffectiveFieldTerms, EngineError, LlgConfig, MaterialParameters, Result,
    TimeIntegrator, Vector3, DEFAULT_GYROMAGNETIC_RATIO,
};
use fullmag_ir::MeshIR;
use std::collections::BTreeMap;
use std::time::Instant;

const BENCHMARK_PAIR_ID: &str = "x_faces";
const PRIMITIVE_BOX_SIZE_M: [f64; 3] = [40e-9, 20e-9, 10e-9];
const GOLDEN_SUPERCELL_REPEAT_X: usize = 15;

#[derive(Debug, Clone)]
pub struct ReferencePbcDemagBenchmarkFixture {
    pub problem: FemLlgProblem,
    pub magnetization: Vec<Vector3>,
    pub open_axis_count: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReferencePbcDemagBenchmarkMetrics {
    pub nodes: usize,
    pub elements: usize,
    pub periodic_node_pairs: usize,
    pub warmup_repeats: usize,
    pub measured_repeats: usize,
    pub elapsed_ns: u128,
    pub demag_energy_joules: f64,
    pub max_demag_field_amplitude: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReferencePbcDemagGoldenSupercellMetrics {
    pub primitive_nodes: usize,
    pub repeated_nodes: usize,
    pub repeated_cells_x: usize,
    pub mapped_nodes: usize,
    pub relative_l2_error: f64,
    pub max_relative_error: f64,
    pub primitive_demag_energy_joules: f64,
    pub repeated_demag_energy_joules: f64,
}

pub fn build_reference_pbc_demag_benchmark_problem(
    divisions: usize,
) -> Result<ReferencePbcDemagBenchmarkFixture> {
    if divisions == 0 {
        return Err(EngineError::new(
            "FEM PBC demag benchmark divisions must be positive",
        ));
    }

    let mut mesh = build_structured_box_tet_mesh(PRIMITIVE_BOX_SIZE_M, divisions);
    mesh.mesh_name = format!("reference_pbc_demag_x_periodic_{divisions}");
    mesh.periodic_boundary_pairs
        .retain(|pair| pair.pair_id == BENCHMARK_PAIR_ID);
    mesh.periodic_node_pairs
        .retain(|pair| pair.pair_id == BENCHMARK_PAIR_ID);

    let topology = MeshTopology::from_ir(&mesh)?;
    let magnetization = topology
        .coords
        .iter()
        .map(|coord| reference_pbc_demag_magnetization(*coord))
        .collect::<Result<Vec<_>>>()?;

    let problem = FemLlgProblem::with_terms(
        topology,
        MaterialParameters::new(800e3, 13e-12, 0.5)?,
        LlgConfig::new(DEFAULT_GYROMAGNETIC_RATIO, TimeIntegrator::Heun)?,
        EffectiveFieldTerms {
            exchange: false,
            demag: true,
            external_field: None,
            per_node_field: None,
            magnetoelastic: None,
            ..Default::default()
        },
    );

    Ok(ReferencePbcDemagBenchmarkFixture {
        problem,
        magnetization,
        open_axis_count: 2,
    })
}

pub fn run_reference_pbc_demag_golden_supercell(
    divisions: usize,
) -> Result<ReferencePbcDemagGoldenSupercellMetrics> {
    if divisions == 0 {
        return Err(EngineError::new(
            "FEM PBC demag golden supercell divisions must be positive",
        ));
    }

    let primitive = build_reference_pbc_demag_benchmark_problem(divisions)?;
    let primitive_state = primitive
        .problem
        .new_state(primitive.magnetization.clone())?;
    let primitive_observables = primitive.problem.observe(&primitive_state)?;

    let repeated_mesh = build_nonperiodic_structured_box_tet_mesh(
        [
            GOLDEN_SUPERCELL_REPEAT_X as f64 * PRIMITIVE_BOX_SIZE_M[0],
            PRIMITIVE_BOX_SIZE_M[1],
            PRIMITIVE_BOX_SIZE_M[2],
        ],
        [GOLDEN_SUPERCELL_REPEAT_X * divisions, divisions, divisions],
    );
    let repeated_topology = MeshTopology::from_ir(&repeated_mesh)?;
    let repeated_magnetization = repeated_topology
        .coords
        .iter()
        .map(|coord| reference_pbc_demag_magnetization(fold_to_primitive_cell(*coord)))
        .collect::<Result<Vec<_>>>()?;
    // The Robin beta approximation depends on the computational volume. Keep
    // it fixed to the primitive-cell value so the supercell comparison changes
    // only x-periodicity, not the open-boundary model.
    let repeated_robin_beta_factor = if repeated_topology.robin_beta > 0.0 {
        Some(primitive.problem.topology.robin_beta / repeated_topology.robin_beta)
    } else {
        None
    };
    let repeated_problem = FemLlgProblem::with_terms_and_demag_airbox(
        repeated_topology,
        MaterialParameters::new(800e3, 13e-12, 0.5)?,
        LlgConfig::new(DEFAULT_GYROMAGNETIC_RATIO, TimeIntegrator::Heun)?,
        EffectiveFieldTerms {
            exchange: false,
            demag: true,
            external_field: None,
            per_node_field: None,
            magnetoelastic: None,
            ..Default::default()
        },
        false,
        repeated_robin_beta_factor,
    );
    let repeated_state = repeated_problem.new_state(repeated_magnetization)?;
    let repeated_observables = repeated_problem.observe(&repeated_state)?;
    let central_map = map_primitive_nodes_to_repeated_central_cell(
        &primitive.problem.topology.coords,
        &repeated_problem.topology.coords,
        divisions,
    )?;

    let mut diff_l2 = 0.0;
    let mut reference_l2 = 0.0;
    let mut max_relative_error = 0.0;
    for (primitive_node, repeated_node) in central_map.iter().copied().enumerate() {
        let primitive_h = primitive_observables.demag_field[primitive_node];
        let repeated_h = repeated_observables.demag_field[repeated_node];
        let diff = [
            primitive_h[0] - repeated_h[0],
            primitive_h[1] - repeated_h[1],
            primitive_h[2] - repeated_h[2],
        ];
        let diff_norm_sq = dot(diff, diff);
        let reference_norm_sq = dot(repeated_h, repeated_h);
        diff_l2 += diff_norm_sq;
        reference_l2 += reference_norm_sq;
        let denom = reference_norm_sq.sqrt().max(1.0);
        let rel = diff_norm_sq.sqrt() / denom;
        if rel > max_relative_error {
            max_relative_error = rel;
        }
    }

    Ok(ReferencePbcDemagGoldenSupercellMetrics {
        primitive_nodes: primitive.problem.topology.n_nodes,
        repeated_nodes: repeated_problem.topology.n_nodes,
        repeated_cells_x: GOLDEN_SUPERCELL_REPEAT_X,
        mapped_nodes: central_map.len(),
        relative_l2_error: diff_l2.sqrt() / reference_l2.sqrt().max(1.0),
        max_relative_error,
        primitive_demag_energy_joules: primitive_observables.demag_energy_joules,
        repeated_demag_energy_joules: repeated_observables.demag_energy_joules,
    })
}

pub fn run_reference_pbc_demag_benchmark(
    divisions: usize,
    warmup_repeats: usize,
    measured_repeats: usize,
) -> Result<ReferencePbcDemagBenchmarkMetrics> {
    if measured_repeats == 0 {
        return Err(EngineError::new(
            "FEM PBC demag benchmark measured_repeats must be positive",
        ));
    }

    let fixture = build_reference_pbc_demag_benchmark_problem(divisions)?;
    let state = fixture.problem.new_state(fixture.magnetization.clone())?;

    for _ in 0..warmup_repeats {
        fixture.problem.observe(&state)?;
    }

    let start = Instant::now();
    let mut final_observables = fixture.problem.observe(&state)?;
    for _ in 1..measured_repeats {
        final_observables = fixture.problem.observe(&state)?;
    }
    let elapsed_ns = start.elapsed().as_nanos();

    Ok(ReferencePbcDemagBenchmarkMetrics {
        nodes: fixture.problem.topology.n_nodes,
        elements: fixture.problem.topology.elements.len(),
        periodic_node_pairs: fixture.problem.topology.periodic_node_pairs.len(),
        warmup_repeats,
        measured_repeats,
        elapsed_ns,
        demag_energy_joules: final_observables.demag_energy_joules,
        max_demag_field_amplitude: final_observables.max_demag_field_amplitude,
    })
}

fn reference_pbc_demag_magnetization(coord: Vector3) -> Result<Vector3> {
    let sx = 2.0 * std::f64::consts::PI * coord[0] / PRIMITIVE_BOX_SIZE_M[0];
    normalized([
        0.15 * sx.cos(),
        0.25 * (coord[1] / PRIMITIVE_BOX_SIZE_M[1]).cos(),
        0.80 + 0.10 * (coord[2] / PRIMITIVE_BOX_SIZE_M[2]).sin(),
    ])
}

fn fold_to_primitive_cell(mut coord: Vector3) -> Vector3 {
    let period = PRIMITIVE_BOX_SIZE_M[0];
    let half = 0.5 * period;
    while coord[0] < -half {
        coord[0] += period;
    }
    while coord[0] > half {
        coord[0] -= period;
    }
    coord
}

fn build_nonperiodic_structured_box_tet_mesh(box_size_m: [f64; 3], cells: [usize; 3]) -> MeshIR {
    let [nx, ny, nz] = cells;
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
                let n0 = structured_node_index(i, j, k, nx, ny) as u32;
                let n1 = structured_node_index(i + 1, j, k, nx, ny) as u32;
                let n2 = structured_node_index(i + 1, j + 1, k, nx, ny) as u32;
                let n3 = structured_node_index(i, j + 1, k, nx, ny) as u32;
                let n4 = structured_node_index(i, j, k + 1, nx, ny) as u32;
                let n5 = structured_node_index(i + 1, j, k + 1, nx, ny) as u32;
                let n6 = structured_node_index(i + 1, j + 1, k + 1, nx, ny) as u32;
                let n7 = structured_node_index(i, j + 1, k + 1, nx, ny) as u32;
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
    MeshIR {
        mesh_name: format!("nonperiodic_structured_box_{}_{}_{}", nx, ny, nz),
        nodes,
        elements,
        element_markers: vec![1; element_count],
        boundary_faces,
        boundary_markers: vec![1; boundary_face_count],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: Default::default(),
    }
}

fn structured_node_index(i: usize, j: usize, k: usize, nx: usize, ny: usize) -> usize {
    let x_stride = nx + 1;
    let y_stride = ny + 1;
    i + x_stride * (j + y_stride * k)
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

fn map_primitive_nodes_to_repeated_central_cell(
    primitive_coords: &[Vector3],
    repeated_coords: &[Vector3],
    divisions: usize,
) -> Result<Vec<usize>> {
    let tolerance = 1.0e-18;
    primitive_coords
        .iter()
        .map(|primitive_coord| {
            let target = *primitive_coord;
            repeated_coords
                .iter()
                .enumerate()
                .filter(|(_, coord)| coord[0] >= -0.5 * PRIMITIVE_BOX_SIZE_M[0] - tolerance)
                .filter(|(_, coord)| coord[0] <= 0.5 * PRIMITIVE_BOX_SIZE_M[0] + tolerance)
                .map(|(idx, coord)| (idx, distance_squared(*coord, target)))
                .min_by(|(_, a), (_, b)| a.total_cmp(b))
                .and_then(|(idx, dist_sq)| (dist_sq.sqrt() <= tolerance).then_some(idx))
                .ok_or_else(|| {
                    EngineError::new(format!(
                        "failed to map primitive node {:?} into central repeated cell for divisions={}",
                        primitive_coord, divisions
                    ))
                })
        })
        .collect()
}

fn distance_squared(a: Vector3, b: Vector3) -> f64 {
    dot(
        [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
        [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    )
}

fn dot(a: Vector3, b: Vector3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
