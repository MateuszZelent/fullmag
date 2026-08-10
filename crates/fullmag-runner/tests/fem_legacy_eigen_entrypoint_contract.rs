use std::fs;
use std::path::PathBuf;

fn runner_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn source(relative_path: &str) -> String {
    let path = runner_root().join(relative_path);
    fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("failed to read {}: {err}", path.display()))
}

#[test]
fn legacy_fem_eigen_entrypoint_rejects_bias_sweeps_before_baseline_or_path_routing() {
    let execution = source("src/fem/execution.rs");
    let guard = "reject_legacy_bias_field_sweep(plan)?;";
    let path_route = "if matches!(plan.k_sampling, Some(fullmag_ir::KSamplingIR::Path { .. }))";
    let baseline_route = "fem_eigen::execute_baseline_fem_eigen(plan, outputs)";

    let guard_offset = execution
        .find(guard)
        .expect("legacy FEM eigen entrypoint must have a sweep guard");
    let path_offset = execution
        .find(path_route)
        .expect("legacy FEM eigen entrypoint must retain path routing");
    let baseline_offset = execution
        .find(baseline_route)
        .expect("legacy FEM eigen entrypoint must retain its baseline compatibility route");

    assert!(
        guard_offset < path_offset && guard_offset < baseline_offset,
        "BiasFieldSweepIR must be rejected before legacy path or baseline routing"
    );
    assert!(
        execution.contains("if !plan.bias_field_samples.is_empty()"),
        "the guard must be owned by the canonical physical sweep field"
    );
    assert!(
        execution
            .contains("legacy_fem_eigen_entrypoint_requires_canonical_bias_field_sweep_dispatch"),
        "the legacy boundary must expose a stable fail-closed reason"
    );
}

#[test]
fn legacy_fem_eigen_entrypoint_is_not_compiled_into_runner() {
    let fem_module = source("src/fem/mod.rs");
    let runner = source("src/lib.rs");
    let dispatch = source("src/dispatch.rs");

    assert!(
        !fem_module.contains("mod execution;")
            && !fem_module.contains("pub mod execution;")
            && !runner.contains("#[path = \"fem/execution.rs\"]"),
        "the legacy FEM execution facade must remain unreachable until explicitly replaced by the canonical dispatch owner"
    );
    assert!(
        dispatch.contains("fem_eigen::execute_cpu_fem_eigen(plan, outputs)")
            && !dispatch.contains("fem_eigen::execute_baseline_fem_eigen(plan, outputs)"),
        "the compiled dispatch owner must use the canonical CPU eigensolver, never the retired baseline entrypoint"
    );
}
