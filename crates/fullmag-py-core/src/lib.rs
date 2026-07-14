use fullmag_engine::fem::MeshTopology;
use fullmag_engine::fem_solution_transfer::{normalize_unit_vectors, transfer_fem_field_to_grid};
use fullmag_ir::{validate_mesh_for_execution, BackendPlanIR, MeshIR, ProblemIR};
use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use std::path::PathBuf;

#[pyfunction]
fn validate_ir_json(ir_json: &str) -> PyResult<bool> {
    let ir: ProblemIR =
        serde_json::from_str(ir_json).map_err(|err| PyValueError::new_err(err.to_string()))?;
    ir.validate()
        .map_err(|errors| PyValueError::new_err(errors.join("; ")))?;
    Ok(true)
}

#[pyfunction]
fn validate_mesh_ir_json(mesh_ir_json: &str) -> PyResult<bool> {
    let mesh: MeshIR =
        serde_json::from_str(mesh_ir_json).map_err(|err| PyValueError::new_err(err.to_string()))?;
    validate_mesh_for_execution(&mesh)
        .map_err(|errors| PyValueError::new_err(errors.join("; ")))?;
    Ok(true)
}

/// Run a ProblemIR JSON through the reference FDM runner.
///
/// Returns:
///   - JSON string with RunResult (status, steps, final_magnetization)
///   - Writes artifacts to `output_dir` if provided
#[pyfunction]
#[pyo3(signature = (ir_json, until_seconds, output_dir = None))]
fn run_problem_json(
    ir_json: &str,
    until_seconds: f64,
    output_dir: Option<String>,
) -> PyResult<String> {
    let ir: ProblemIR =
        serde_json::from_str(ir_json).map_err(|err| PyValueError::new_err(err.to_string()))?;

    let out_path = output_dir
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("run_output"));

    let result = fullmag_runner::run_problem(&ir, until_seconds, &out_path)
        .map_err(|err| PyValueError::new_err(err.to_string()))?;

    serde_json::to_string(&result).map_err(|err| PyValueError::new_err(err.to_string()))
}

/// Resample FEM node-based magnetization to FDM grid cell centers.
///
/// Takes:
///   - `fem_mesh_ir_json`: JSON string of the FEM `MeshIR`
///   - `magnetization`: flat list of [mx, my, mz] triples (one per FEM node)
///   - `next_stage_ir_json`: JSON string of the next stage's `ProblemIR`
///
/// Returns:
///   - JSON string: `{ "values": [[mx,my,mz],...], "n_located": N, "n_outside": M, "n_total": T }`
///   - `null` if the next stage is not FDM (no resampling needed)
#[pyfunction]
fn resample_fem_to_fdm_grid_json(
    fem_mesh_ir_json: &str,
    magnetization: Vec<[f64; 3]>,
    next_stage_ir_json: &str,
) -> PyResult<Option<String>> {
    let fem_mesh_ir: MeshIR = serde_json::from_str(fem_mesh_ir_json)
        .map_err(|e| PyValueError::new_err(format!("invalid FEM mesh IR JSON: {}", e)))?;

    let next_ir: ProblemIR = serde_json::from_str(next_stage_ir_json)
        .map_err(|e| PyValueError::new_err(format!("invalid next-stage IR JSON: {}", e)))?;

    // Plan the next stage to discover backend type and grid parameters.
    let next_plan = fullmag_plan::plan(&next_ir)
        .map_err(|e| PyValueError::new_err(format!("next-stage planning failed: {}", e)))?;

    let fdm_plan = match &next_plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => fdm,
        _ => return Ok(None), // Not FDM — no resampling needed.
    };

    let grid_cells = fdm_plan.grid.cells;
    let cell_size = fdm_plan.cell_size;
    let grid_dims = [
        grid_cells[0] as usize,
        grid_cells[1] as usize,
        grid_cells[2] as usize,
    ];
    let grid_origin = [
        -(grid_cells[0] as f64 * cell_size[0]) * 0.5,
        -(grid_cells[1] as f64 * cell_size[1]) * 0.5,
        -(grid_cells[2] as f64 * cell_size[2]) * 0.5,
    ];

    let topo = MeshTopology::from_ir(&fem_mesh_ir)
        .map_err(|e| PyValueError::new_err(format!("mesh topology build failed: {}", e)))?;

    let result =
        transfer_fem_field_to_grid(&topo, &magnetization, grid_origin, cell_size, grid_dims);
    let mut values = result.values;
    normalize_unit_vectors(&mut values, 1e-12);

    let output = serde_json::json!({
        "values": values,
        "n_located": result.n_located,
        "n_outside": result.n_outside,
        "n_total": result.n_total,
    });

    serde_json::to_string(&output)
        .map_err(|e| PyValueError::new_err(e.to_string()))
        .map(Some)
}

/// Extract the FEM mesh IR from a problem's execution plan.
///
/// Returns the mesh IR as a JSON string if the backend resolves to FEM,
/// or `None` if the backend is not FEM.
#[pyfunction]
fn extract_fem_mesh_ir_json(ir_json: &str) -> PyResult<Option<String>> {
    let ir: ProblemIR =
        serde_json::from_str(ir_json).map_err(|e| PyValueError::new_err(e.to_string()))?;

    let plan = fullmag_plan::plan(&ir)
        .map_err(|e| PyValueError::new_err(format!("planning failed: {}", e)))?;

    match &plan.backend_plan {
        BackendPlanIR::Fem(fem_plan) => {
            let mesh_json = serde_json::to_string(&fem_plan.mesh)
                .map_err(|e| PyValueError::new_err(e.to_string()))?;
            Ok(Some(mesh_json))
        }
        _ => Ok(None),
    }
}

#[pymodule(name = "_fullmag_core")]
fn fullmag_py_core(_py: Python<'_>, module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_function(wrap_pyfunction!(validate_ir_json, module)?)?;
    module.add_function(wrap_pyfunction!(validate_mesh_ir_json, module)?)?;
    module.add_function(wrap_pyfunction!(run_problem_json, module)?)?;
    module.add_function(wrap_pyfunction!(resample_fem_to_fdm_grid_json, module)?)?;
    module.add_function(wrap_pyfunction!(extract_fem_mesh_ir_json, module)?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mesh_json(element: [u32; 4], fourth_node: [f64; 3]) -> String {
        serde_json::to_string(&MeshIR {
            mesh_name: "fixture".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                fourth_node,
            ],
            elements: vec![element],
            element_markers: vec![1],
            boundary_faces: Vec::new(),
            boundary_markers: Vec::new(),
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
        })
        .expect("mesh fixture should serialize")
    }

    #[test]
    fn validate_mesh_json_rejects_corrupt_tetrahedra() {
        pyo3::prepare_freethreaded_python();
        let cases = [
            (
                mesh_json([0, 1, 3, 2], [0.0, 0.0, 1.0]),
                "negative tetra orientation",
            ),
            (
                mesh_json([0, 1, 2, 3], [2.0, 2.0, 0.0]),
                "degenerate tetra volume",
            ),
        ];

        for (payload, expected) in cases {
            let error = validate_mesh_ir_json(&payload).expect_err("corrupt mesh must fail");
            assert!(error.to_string().contains(expected), "{error}");
        }
    }
}
