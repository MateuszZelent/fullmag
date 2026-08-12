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
///   - JSON string with values, transfer counts, and canonical `target_grid` identity
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

    let grid_certificate = fdm_plan.grid_certificate.as_ref().ok_or_else(|| {
        PyValueError::new_err(
            "resolved FDM target is missing its canonical grid certificate; refusing state transfer",
        )
    })?;
    grid_certificate
        .validate_against_masks(fdm_plan.active_mask.as_deref(), &fdm_plan.region_mask)
        .map_err(|e| PyValueError::new_err(format!("invalid FDM target grid certificate: {e}")))?;
    if grid_certificate.origin_m != fdm_plan.origin_m
        || grid_certificate.counts != fdm_plan.grid.cells
        || grid_certificate.cell_m != fdm_plan.cell_size
    {
        return Err(PyValueError::new_err(
            "resolved FDM target grid certificate does not match the planned grid",
        ));
    }

    let grid_cells = grid_certificate.counts;
    let cell_size = grid_certificate.cell_m;
    let grid_dims = [
        grid_cells[0] as usize,
        grid_cells[1] as usize,
        grid_cells[2] as usize,
    ];
    let grid_origin = grid_certificate.origin_m;

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
        "target_grid": {
            "origin_m": grid_certificate.origin_m,
            "counts": grid_certificate.counts,
            "cell_m": grid_certificate.cell_m,
            "grid_fingerprint": grid_certificate.grid_fingerprint,
        },
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
        serde_json::to_string(&MeshIR::from_legacy_tet4(
            "fixture".to_string(),
            vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                fourth_node,
            ],
            vec![element],
            vec![1],
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            std::collections::HashMap::new(),
        ))
        .expect("mesh fixture should serialize")
    }

    #[test]
    fn fem_to_fdm_resampling_uses_planned_non_centered_grid_origin() {
        pyo3::prepare_freethreaded_python();
        let origin = [28e-9, -12e-9, 3e-9];
        let size = [4e-9, 4e-9, 2e-9];
        let nodes = vec![
            origin,
            [origin[0] + size[0], origin[1], origin[2]],
            [origin[0] + size[0], origin[1] + size[1], origin[2]],
            [origin[0], origin[1] + size[1], origin[2]],
            [origin[0], origin[1], origin[2] + size[2]],
            [origin[0] + size[0], origin[1], origin[2] + size[2]],
            [
                origin[0] + size[0],
                origin[1] + size[1],
                origin[2] + size[2],
            ],
            [origin[0], origin[1] + size[1], origin[2] + size[2]],
        ];
        let mesh = MeshIR::from_legacy_tet4(
            "shifted_box".to_string(),
            nodes,
            vec![
                [0, 1, 3, 4],
                [1, 2, 3, 6],
                [1, 4, 5, 6],
                [3, 4, 6, 7],
                [1, 3, 4, 6],
            ],
            vec![1; 5],
            Vec::new(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            std::collections::HashMap::new(),
        );
        let mut target = ProblemIR::bootstrap_example();
        target.geometry.entries = vec![fullmag_ir::GeometryEntryIR::Translate {
            name: "shifted_box".to_string(),
            base: Box::new(fullmag_ir::GeometryEntryIR::Box {
                name: "box".to_string(),
                size,
            }),
            by: [30e-9, -10e-9, 4e-9],
        }];
        target.regions[0].geometry = "shifted_box".to_string();
        target.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
            fdm_grid_assets: vec![fullmag_ir::FdmGridAssetIR {
                geometry_name: "shifted_box".to_string(),
                cells: [2, 2, 1],
                cell_size: [2e-9, 2e-9, 2e-9],
                origin,
                active_mask: vec![true; 4],
            }],
            fem_mesh_assets: Vec::new(),
            fem_domain_mesh_asset: None,
        });

        let result_json = resample_fem_to_fdm_grid_json(
            &serde_json::to_string(&mesh).expect("mesh should serialize"),
            vec![[1.0, 0.0, 0.0]; 8],
            &serde_json::to_string(&target).expect("target should serialize"),
        )
        .expect("resampling should succeed")
        .expect("FDM target should require resampling");
        let result: serde_json::Value =
            serde_json::from_str(&result_json).expect("result should be JSON");

        assert_eq!(result["n_total"], 4);
        assert_eq!(result["n_located"], 4);
        assert_eq!(result["n_outside"], 0);
        assert_eq!(result["target_grid"]["origin_m"], serde_json::json!(origin));
        assert_eq!(
            result["target_grid"]["counts"],
            serde_json::json!([2, 2, 1])
        );
        assert_eq!(
            result["target_grid"]["cell_m"],
            serde_json::json!([2e-9, 2e-9, 2e-9])
        );
        assert!(
            result["target_grid"]["grid_fingerprint"]
                .as_str()
                .is_some_and(|fingerprint| fingerprint.len() == 64),
            "target grid identity must cross the JSON API boundary"
        );
        assert_eq!(
            result["values"],
            serde_json::json!([
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.0, 0.0, 0.0]
            ])
        );
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
