use fullmag_ir::ProblemIR;
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

#[pymodule(name = "_fullmag_core")]
fn fullmag_py_core(_py: Python<'_>, module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_function(wrap_pyfunction!(validate_ir_json, module)?)?;
    module.add_function(wrap_pyfunction!(run_problem_json, module)?)?;
    Ok(())
}
