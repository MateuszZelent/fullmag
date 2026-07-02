use std::path::{Path, PathBuf};

fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn repo_root() -> PathBuf {
    crate_root()
        .parent()
        .and_then(Path::parent)
        .expect("runner crate should live under <repo>/crates/fullmag-runner")
        .to_path_buf()
}

fn source(path: &Path) -> String {
    std::fs::read_to_string(path)
        .unwrap_or_else(|err| panic!("read backend source layout input {}: {err}", path.display()))
}

fn production_source(path: &Path) -> String {
    source(path)
        .split("#[cfg(test)]")
        .next()
        .expect("source should have a production section")
        .to_string()
}

fn production_source_before_cfg(path: &Path, cfg_marker: &str) -> String {
    source(path)
        .split(cfg_marker)
        .next()
        .expect("source should have a production section")
        .to_string()
}

#[test]
fn fem_eigen_path_workflow_has_fem_owner() {
    let root = crate_root();
    let dispatch = production_source(&root.join("src/dispatch.rs"));
    let owner_path = root.join("src/fem/eigen_path.rs");
    let owner = source(&owner_path);

    assert!(
        owner_path.exists(),
        "missing FEM eigen path owner: {}",
        owner_path.display()
    );
    for needle in ["fn execute_fem_eigen_path(", "struct KSolverAdapter"] {
        assert!(
            !dispatch.contains(needle),
            "dispatch.rs must not own FEM eigen path workflow detail: {needle}"
        );
        assert!(
            owner.contains(needle),
            "{} must own FEM eigen path workflow detail: {needle}",
            owner_path.display()
        );
    }
}

#[test]
fn cuda_fdm_execution_loop_has_cuda_owner() {
    let root = crate_root();
    let dispatch = production_source(&root.join("src/dispatch.rs"));
    let owner_path = root.join("src/fdm/gpu/cuda/execute.rs");
    let owner = source(&owner_path);

    assert!(
        owner_path.exists(),
        "missing CUDA FDM execution owner: {}",
        owner_path.display()
    );
    for needle in ["fn execute_cuda_fdm(", "fn ensure_single_object_scalars("] {
        assert!(
            !dispatch.contains(needle),
            "dispatch.rs must not own CUDA FDM execution detail: {needle}"
        );
        assert!(
            owner.contains(needle),
            "{} must own CUDA FDM execution detail: {needle}",
            owner_path.display()
        );
    }
}

#[test]
fn fdm_execution_routing_has_fdm_owner() {
    let root = crate_root();
    let dispatch = production_source(&root.join("src/dispatch.rs"));
    let compatibility_path = root.join("src/fdm/execution.rs");
    let compatibility = production_source(&compatibility_path);
    let owner_path = root.join("src/solvers/fdm/execute.rs");
    let owner = source(&owner_path);

    assert!(
        owner_path.exists(),
        "missing FDM execution routing owner: {}",
        owner_path.display()
    );
    for needle in [
        "pub(crate) fn execute_fdm<",
        "pub(crate) fn execute_fdm_multilayer<",
    ] {
        assert!(
            !dispatch.contains(needle),
            "dispatch.rs must not own FDM execution routing detail: {needle}"
        );
        assert!(
            !compatibility.contains(needle),
            "{} must be a compatibility facade, not own FDM execution routing detail: {needle}",
            compatibility_path.display()
        );
        assert!(
            owner.contains(needle),
            "{} must own FDM execution routing detail: {needle}",
            owner_path.display()
        );
    }
}

#[test]
fn fdm_cpu_reference_capability_rejection_has_interaction_owner() {
    let root = crate_root();
    let routing_path = root.join("src/solvers/fdm/execute.rs");
    let routing = production_source(&routing_path);
    let owner_path = root.join("src/solvers/fdm/interactions/capabilities.rs");

    assert!(
        owner_path.exists(),
        "missing FDM interaction capability owner: {}",
        owner_path.display()
    );

    let owner = production_source(&owner_path);
    assert!(
        !routing.contains("fn unsupported_cpu_fdm_terms("),
        "{} must not own CPU FDM interaction capability rejection",
        routing_path.display()
    );

    for needle in [
        "pub(crate) fn unsupported_cpu_fdm_terms(",
        "\"oersted\"",
        "\"boundary_correction\"",
        "\"unsupported_outputs\"",
    ] {
        assert!(
            owner.contains(needle),
            "{} must own CPU FDM interaction capability rejection detail: {needle}",
            owner_path.display()
        );
    }
}

#[test]
fn fdm_preview_routing_has_solver_owner() {
    let root = crate_root();
    let dispatch = production_source(&root.join("src/dispatch.rs"));
    let compatibility_path = root.join("src/fdm/preview.rs");
    let compatibility = production_source(&compatibility_path);
    let owner_path = root.join("src/solvers/fdm/preview.rs");
    let owner = source(&owner_path);

    assert!(
        owner_path.exists(),
        "missing FDM preview routing owner: {}",
        owner_path.display()
    );
    for needle in [
        "pub(crate) fn snapshot_fdm_preview(",
        "pub(crate) fn snapshot_fdm_vector_fields(",
        "fn snapshot_native_fdm_preview(",
        "fn snapshot_native_fdm_vector_fields(",
    ] {
        assert!(
            !dispatch.contains(needle),
            "dispatch.rs must not own FDM preview routing detail: {needle}"
        );
        assert!(
            !compatibility.contains(needle),
            "{} must be a compatibility facade, not own FDM preview routing detail: {needle}",
            compatibility_path.display()
        );
        assert!(
            owner.contains(needle),
            "{} must own FDM preview routing detail: {needle}",
            owner_path.display()
        );
    }
}

#[test]
fn fdm_cpu_reference_fft_backend_has_owner() {
    let root = crate_root();
    let reference_path = root.join("src/fdm/cpu/reference.rs");
    let owner_path = root.join("src/fdm/cpu/reference/fft_backend.rs");
    let reference = production_source_before_cfg(
        &reference_path,
        "#[cfg(test)]\n#[path = \"reference/tests.rs\"]",
    );

    assert!(
        owner_path.exists(),
        "missing FDM CPU reference FFT backend owner: {}",
        owner_path.display()
    );
    let owner = source(&owner_path);

    for needle in [
        "pub(crate) const CPU_FFT_BACKEND_ENV",
        "pub(crate) enum CpuFftBackend",
        "pub(crate) fn requested_cpu_fft_backend_from_env(",
        "pub(crate) fn resolve_cpu_fft_backend_for_demag(",
        "pub(crate) fn resolve_cpu_fft_backend_name_for_demag(",
    ] {
        assert!(
            !reference.contains(needle),
            "reference.rs must not own FDM CPU reference FFT backend detail: {needle}"
        );
        assert!(
            owner.contains(needle),
            "{} must own FDM CPU reference FFT backend detail: {needle}",
            owner_path.display()
        );
    }
}

#[test]
fn fdm_cpu_reference_direct_snapshot_has_owner() {
    let root = crate_root();
    let reference_path = root.join("src/fdm/cpu/reference.rs");
    let owner_path = root.join("src/fdm/cpu/reference/direct_snapshot.rs");
    let reference = production_source_before_cfg(
        &reference_path,
        "#[cfg(test)]\n#[path = \"reference/tests.rs\"]",
    );

    assert!(
        owner_path.exists(),
        "missing FDM CPU reference direct snapshot owner: {}",
        owner_path.display()
    );
    let owner = source(&owner_path);

    for needle in [
        "fn build_direct_preview_field_if_available(",
        "enum DirectPreviewValues",
        "fn select_direct_preview_values(",
        "fn direct_field_values_available(",
        "fn direct_scalar_values_available(",
        "struct DirectFieldSnapshotCache",
        "fn project_component(",
    ] {
        assert!(
            !reference.contains(needle),
            "reference.rs must not own FDM CPU reference direct snapshot detail: {needle}"
        );
        assert!(
            owner.contains(needle),
            "{} must own FDM CPU reference direct snapshot detail: {needle}",
            owner_path.display()
        );
    }

    for needle in [
        "pub(crate) fn snapshot_preview(",
        "pub(crate) fn snapshot_preview_from_state(",
        "pub(crate) fn snapshot_vector_fields(",
        "pub(crate) fn snapshot_vector_fields_from_state(",
        "pub(crate) fn build_snapshot_problem_and_state(",
        "pub(crate) fn execute_reference_fdm(",
    ] {
        assert!(
            reference.contains(needle),
            "reference.rs must keep FDM CPU reference public lane entrypoint: {needle}"
        );
    }
    assert!(
        reference.contains("pub(crate) use self::outputs::observe_state;"),
        "reference.rs must keep the FDM CPU reference observe_state public lane entrypoint via its output owner"
    );
}

#[test]
fn fdm_cuda_native_snapshots_have_snapshot_owner() {
    let root = crate_root();
    let native_path = root.join("src/fdm/gpu/cuda/native.rs");
    let snapshots_path = root.join("src/fdm/gpu/cuda/native/snapshots.rs");
    let native = production_source(&native_path);

    assert!(
        snapshots_path.exists(),
        "missing CUDA FDM native snapshot owner: {}",
        snapshots_path.display()
    );
    let snapshots = source(&snapshots_path);

    for needle in [
        "pub(crate) struct NativeFdmFieldSnapshot",
        "pub(crate) struct NativeFdmPreviewSnapshot",
        "pub(crate) enum NativeFieldSnapshotScalarType",
        "pub(crate) struct NativeFieldSnapshotInfo",
        "fn ensure_ready(&mut self)",
        "pub(crate) fn write_payload_to(",
        "pub fn into_live_preview_field(",
        "impl Drop for NativeFdmFieldSnapshot",
        "impl Drop for NativeFdmPreviewSnapshot",
    ] {
        assert!(
            !native.contains(needle),
            "native.rs must not own CUDA FDM native snapshot definition/detail: {needle}"
        );
        assert!(
            snapshots.contains(needle),
            "{} must own CUDA FDM native snapshot definition/detail: {needle}",
            snapshots_path.display()
        );
    }
}

#[test]
fn fdm_cuda_native_math_helpers_have_owner() {
    let root = crate_root();
    let native_path = root.join("src/fdm/gpu/cuda/native.rs");
    let owner_path = root.join("src/fdm/gpu/cuda/native/math.rs");
    let native =
        production_source_before_cfg(&native_path, "#[cfg(all(test, feature = \"cuda\"))]");

    assert!(
        owner_path.exists(),
        "missing CUDA FDM native math helper owner: {}",
        owner_path.display()
    );
    let owner = source(&owner_path);

    for needle in [
        "fn unpack_flat_f64(",
        "fn unpack_flat_f32(",
        "fn flatten_vectors_f64(",
        "fn flatten_vectors_f32(",
        "fn max_rhs_norm_from_field(",
        "fn llg_rhs_from_field(",
        "fn add(",
        "fn scale(",
        "fn cross(",
        "fn norm(",
    ] {
        assert!(
            !native.contains(needle),
            "native.rs must not own CUDA FDM native math helper detail: {needle}"
        );
        assert!(
            owner.contains(needle),
            "{} must own CUDA FDM native math helper detail: {needle}",
            owner_path.display()
        );
    }
}

#[test]
fn fdm_runtime_selection_has_solver_runtime_owner() {
    let root = crate_root();
    let dispatch = production_source(&root.join("src/dispatch.rs"));
    let owner_path = root.join("src/solver_runtime/selection.rs");
    let owner = source(&owner_path);

    assert!(
        owner_path.exists(),
        "missing FDM runtime selection owner: {}",
        owner_path.display()
    );
    for needle in [
        "pub(crate) fn resolve_fdm_engine_with_trail(",
        "pub(crate) fn resolve_fdm_engine(",
    ] {
        assert!(
            !dispatch.contains(needle),
            "dispatch.rs must not own FDM runtime selection function definition: {needle}"
        );
        assert!(
            owner.contains(needle),
            "{} must own FDM runtime selection function definition: {needle}",
            owner_path.display()
        );
    }
}

#[test]
fn fem_runtime_selection_has_solver_runtime_owner() {
    let root = crate_root();
    let dispatch = production_source(&root.join("src/dispatch.rs"));
    let owner_path = root.join("src/solver_runtime/fem_selection.rs");
    let owner = source(&owner_path);

    assert!(
        owner_path.exists(),
        "missing FEM runtime selection owner: {}",
        owner_path.display()
    );
    for needle in [
        "pub(crate) fn resolve_fem_engine_with_trail(",
        "pub(crate) fn resolve_fem_engine_with_availability(",
        "pub(crate) fn resolve_fem_engine(",
        "pub(crate) fn resolve_fem_engine_for_plan_with_trail(",
    ] {
        assert!(
            !dispatch.contains(needle),
            "dispatch.rs must not own FEM runtime selection function definition: {needle}"
        );
        assert!(
            owner.contains(needle),
            "{} must own FEM runtime selection function definition: {needle}",
            owner_path.display()
        );
    }
}

#[test]
fn fem_execution_routing_has_fem_owner() {
    let root = crate_root();
    let dispatch = production_source(&root.join("src/dispatch.rs"));
    let owner_path = root.join("src/fem/execution.rs");
    let owner = source(&owner_path);

    assert!(
        owner_path.exists(),
        "missing FEM execution routing owner: {}",
        owner_path.display()
    );
    for needle in ["pub(crate) fn execute_fem<", "fn execute_native_fem("] {
        assert!(
            !dispatch.contains(needle),
            "dispatch.rs must not own FEM execution routing detail: {needle}"
        );
        assert!(
            owner.contains(needle),
            "{} must own FEM execution routing detail: {needle}",
            owner_path.display()
        );
    }
}

#[test]
fn fem_plan_normalization_has_solver_owner() {
    let root = crate_root();
    let facade_path = root.join("src/fem/plan.rs");
    let facade = production_source(&facade_path);
    let facade_source = source(&facade_path);
    let owner_path = root.join("src/solvers/fem/plan.rs");
    let solvers_mod_path = root.join("src/solvers/mod.rs");
    let solvers_fem_mod_path = root.join("src/solvers/fem/mod.rs");

    assert!(
        owner_path.exists(),
        "missing FEM plan normalization solver owner: {}",
        owner_path.display()
    );
    let owner = source(&owner_path);

    for path in [&facade_path, &owner_path] {
        let line_count = source(path).lines().count();
        assert!(
            line_count < 2_000,
            "{} must stay below the 2000-line monolith threshold; got {line_count}",
            path.display()
        );
    }

    for needle in [
        "fn magnetic_markers_from_object_segments(",
        "fn markers_from_element_selector(",
        "fn magnetic_markers_from_mesh_parts(",
        "pub(crate) fn normalized_runtime_element_markers(",
        "pub(crate) fn normalized_fem_plan_for_runtime(",
    ] {
        assert!(
            !facade.contains(needle),
            "fem/plan.rs must remain a compatibility facade, not own FEM plan normalization detail: {needle}"
        );
        assert!(
            owner.contains(needle),
            "{} must own FEM plan normalization detail: {needle}",
            owner_path.display()
        );
    }

    assert!(
        facade
            .contains("pub(crate) use crate::solvers::fem::plan::normalized_fem_plan_for_runtime;"),
        "fem/plan.rs must re-export the FEM plan normalization solver owner"
    );
    assert!(
        facade_source.contains(
            "pub(crate) use crate::solvers::fem::plan::normalized_runtime_element_markers;"
        ),
        "fem/plan.rs must keep the test-facing normalized runtime marker helper re-export"
    );
    assert!(
        source(&solvers_mod_path).contains("pub(crate) mod fem;"),
        "{} must register the FEM solver owner root",
        solvers_mod_path.display()
    );
    assert!(
        source(&solvers_fem_mod_path).contains("pub(crate) mod plan;"),
        "{} must register the FEM plan normalization solver owner",
        solvers_fem_mod_path.display()
    );
}

#[test]
fn fem_pbc_preprocessing_has_solver_owner() {
    let root = crate_root();
    let facade_path = root.join("src/fem/pbc.rs");
    let facade = production_source(&facade_path);
    let owner_path = root.join("src/solvers/fem/pbc.rs");
    let solvers_fem_mod_path = root.join("src/solvers/fem/mod.rs");

    assert!(
        owner_path.exists(),
        "missing FEM PBC preprocessing solver owner: {}",
        owner_path.display()
    );
    let owner = source(&owner_path);

    for path in [&facade_path, &owner_path] {
        let line_count = source(path).lines().count();
        assert!(
            line_count < 2_000,
            "{} must stay below the 2000-line monolith threshold; got {line_count}",
            path.display()
        );
    }

    for needle in [
        "pub(crate) enum FemStaticPbcLane",
        "pub(crate) struct FemStaticPbcDecision",
        "pub(crate) fn fem_static_periodic_decision(",
        "pub(crate) fn fem_static_periodic_native_exchange_supported(",
    ] {
        assert!(
            !facade.contains(needle),
            "fem/pbc.rs must remain a compatibility facade, not own FEM PBC preprocessing detail: {needle}"
        );
        assert!(
            owner.contains(needle),
            "{} must own FEM PBC preprocessing detail: {needle}",
            owner_path.display()
        );
    }

    for needle in [
        "pub(crate) use crate::solvers::fem::pbc::fem_static_periodic_native_exchange_supported;",
        "pub(crate) use crate::solvers::fem::pbc::{fem_static_periodic_decision, FemStaticPbcLane};",
    ] {
        assert!(
            source(&facade_path).contains(needle),
            "fem/pbc.rs must re-export the FEM PBC preprocessing solver owner: {needle}"
        );
    }
    assert!(
        source(&solvers_fem_mod_path).contains("pub(crate) mod pbc;"),
        "{} must register the FEM PBC preprocessing solver owner",
        solvers_fem_mod_path.display()
    );
}

#[test]
fn fem_preview_routing_has_solver_owner() {
    let root = crate_root();
    let dispatch = production_source(&root.join("src/dispatch.rs"));
    let facade_path = root.join("src/fem/preview.rs");
    let facade = production_source(&facade_path);
    let facade_source = source(&facade_path);
    let owner_path = root.join("src/solvers/fem/preview.rs");
    let solvers_fem_mod_path = root.join("src/solvers/fem/mod.rs");

    assert!(
        owner_path.exists(),
        "missing FEM preview routing solver owner: {}",
        owner_path.display()
    );
    let owner = source(&owner_path);

    for path in [&facade_path, &owner_path] {
        let line_count = source(path).lines().count();
        assert!(
            line_count < 2_000,
            "{} must stay below the 2000-line monolith threshold; got {line_count}",
            path.display()
        );
    }

    for needle in [
        "pub(crate) fn snapshot_fem_preview(",
        "pub(crate) fn snapshot_fem_vector_fields(",
        "pub(crate) fn fem_plan_for_cpu_native(",
        "pub(crate) fn fem_plan_for_native_gpu(",
        "fn snapshot_native_fem_preview(",
        "fn snapshot_native_fem_vector_fields(",
    ] {
        assert!(
            !dispatch.contains(needle),
            "dispatch.rs must not own FEM preview routing detail: {needle}"
        );
        assert!(
            !facade.contains(needle),
            "fem/preview.rs must remain a compatibility facade, not own FEM preview routing detail: {needle}"
        );
        assert!(
            owner.contains(needle),
            "{} must own FEM preview routing detail: {needle}",
            owner_path.display()
        );
    }

    for needle in [
        "pub(crate) use crate::solvers::fem::preview::{",
        "fem_plan_for_cpu_native",
        "fem_plan_for_native_gpu",
        "snapshot_fem_preview",
        "snapshot_fem_vector_fields",
    ] {
        assert!(
            facade_source.contains(needle),
            "fem/preview.rs must re-export the FEM preview solver owner: {needle}"
        );
    }
    assert!(
        source(&solvers_fem_mod_path).contains("pub(crate) mod preview;"),
        "{} must register the FEM preview solver owner",
        solvers_fem_mod_path.display()
    );
}

#[test]
fn runtime_registry_resolution_has_solver_runtime_owner() {
    let root = crate_root();
    let dispatch = production_source(&root.join("src/dispatch.rs"));
    let owner_path = root.join("src/solver_runtime/registry.rs");
    let owner = source(&owner_path);

    assert!(
        owner_path.exists(),
        "missing runtime registry resolution owner: {}",
        owner_path.display()
    );
    for needle in [
        "pub(crate) fn resolve_fdm_engine_with_registry(",
        "pub(crate) fn resolve_fem_engine_with_registry(",
        "pub(crate) fn resolve_with_registry(",
    ] {
        assert!(
            !dispatch.contains(needle),
            "dispatch.rs must not own runtime registry resolution function definition: {needle}"
        );
        assert!(
            owner.contains(needle),
            "{} must own runtime registry resolution function definition: {needle}",
            owner_path.display()
        );
    }
}

#[test]
fn fem_eigen_output_and_reduction_helpers_have_owners() {
    let root = crate_root();
    let monolith_path = root.join("src/fem_eigen.rs");
    let monolith = production_source(&monolith_path);
    let output_path = root.join("src/fem/eigen_output.rs");
    let reduction_path = root.join("src/fem/eigen_reduction.rs");
    let output = source(&output_path);
    let reduction = source(&reduction_path);

    let line_count = source(&monolith_path).lines().count();
    assert!(
        line_count < 2_000,
        "fem_eigen.rs must stay below the 2000-line monolith threshold; got {line_count}"
    );

    for needle in [
        "fn json_artifact(",
        "fn solver_kind_label(",
        "fn execution_provenance(",
        "fn dispersion_v2_csv(",
        "fn classify_polarization(",
    ] {
        assert!(
            !monolith.contains(needle),
            "fem_eigen.rs must not own FEM eigen output helper: {needle}"
        );
        assert!(
            output.contains(needle),
            "{} must own FEM eigen output helper: {needle}",
            output_path.display()
        );
    }

    for needle in [
        "struct ReductionMap",
        "struct PhaseGroups",
        "fn build_reduction_map(",
        "fn phase_reduction(",
        "fn magnetic_boundary_nodes(",
    ] {
        assert!(
            !monolith.contains(needle),
            "fem_eigen.rs must not own FEM eigen reduction helper: {needle}"
        );
        assert!(
            reduction.contains(needle),
            "{} must own FEM eigen reduction helper: {needle}",
            reduction_path.display()
        );
    }
}

#[test]
fn fem_eigen_equilibrium_helpers_have_owner() {
    let root = crate_root();
    let monolith_path = root.join("src/fem_eigen.rs");
    let monolith = production_source(&monolith_path);
    let owner_path = root.join("src/fem/eigen_equilibrium.rs");
    let fem_mod_path = root.join("src/fem/mod.rs");
    let fem_mod = source(&fem_mod_path);

    assert!(
        owner_path.exists(),
        "missing FEM eigen equilibrium owner: {}",
        owner_path.display()
    );
    let owner = source(&owner_path);

    let line_count = source(&monolith_path).lines().count();
    assert!(
        line_count < 2_000,
        "fem_eigen.rs must stay below the 2000-line monolith threshold; got {line_count}"
    );

    for needle in [
        "pub(crate) fn materialize_equilibrium(",
        "fn load_equilibrium_artifact(",
        "const RELAX_DT: f64",
        "const RELAX_MAX_STEPS: u64",
    ] {
        assert!(
            !monolith.contains(needle),
            "fem_eigen.rs must not own FEM eigen equilibrium detail: {needle}"
        );
        assert!(
            owner.contains(needle),
            "{} must own FEM eigen equilibrium detail: {needle}",
            owner_path.display()
        );
    }
    assert!(
        fem_mod.contains("pub(crate) mod eigen_equilibrium;"),
        "{} must register the FEM eigen equilibrium owner",
        fem_mod_path.display()
    );
}

#[test]
fn fem_eigen_volume_anisotropy_helpers_have_owner() {
    let root = crate_root();
    let monolith_path = root.join("src/fem_eigen.rs");
    let monolith = production_source(&monolith_path);
    let owner_path = root.join("src/fem/eigen_anisotropy.rs");
    let fem_mod_path = root.join("src/fem/mod.rs");
    let fem_mod = source(&fem_mod_path);

    assert!(
        owner_path.exists(),
        "missing FEM eigen anisotropy owner: {}",
        owner_path.display()
    );
    let owner = source(&owner_path);

    let line_count = source(&monolith_path).lines().count();
    assert!(
        line_count < 2_000,
        "fem_eigen.rs must stay below the 2000-line monolith threshold; got {line_count}"
    );

    for needle in [
        "pub(crate) fn volume_anisotropy_field(",
        "fn uniaxial_anisotropy_field(",
        "fn cubic_anisotropy_field(",
    ] {
        assert!(
            !monolith.contains(needle),
            "fem_eigen.rs must not own FEM eigen volume anisotropy helper: {needle}"
        );
        assert!(
            owner.contains(needle),
            "{} must own FEM eigen volume anisotropy helper: {needle}",
            owner_path.display()
        );
    }
    assert!(
        fem_mod.contains("pub(crate) mod eigen_anisotropy;"),
        "{} must register the FEM eigen anisotropy owner",
        fem_mod_path.display()
    );
}

#[test]
fn fem_eigen_operator_assembly_has_owner() {
    let root = crate_root();
    let monolith_path = root.join("src/fem_eigen.rs");
    let monolith = production_source(&monolith_path);
    let owner_path = root.join("src/fem/eigen_operator.rs");
    let fem_mod_path = root.join("src/fem/mod.rs");
    let fem_mod = source(&fem_mod_path);

    assert!(
        owner_path.exists(),
        "missing FEM eigen operator assembly owner: {}",
        owner_path.display()
    );
    let owner = source(&owner_path);

    let line_count = source(&monolith_path).lines().count();
    assert!(
        line_count < 2_000,
        "fem_eigen.rs must stay below the 2000-line monolith threshold; got {line_count}"
    );

    for needle in [
        "pub(crate) fn assemble_projected_scalar_operator_real(",
        "pub(crate) fn assemble_full_2x2_operator_real(",
        "pub(crate) fn assemble_projected_scalar_operator_complex(",
        "fn add_surface_anisotropy_real(",
        "fn add_surface_anisotropy_complex(",
        "fn add_dmi_real(",
        "fn add_dmi_complex(",
        "fn add_surface_anisotropy_2x2(",
        "fn add_dmi_2x2(",
        "fn surface_anisotropy_config(",
        "fn triangle_surface_matrix(",
        "pub(crate) fn tangent_bases(",
    ] {
        assert!(
            !monolith.contains(needle),
            "fem_eigen.rs must not own FEM eigen operator assembly detail: {needle}"
        );
        assert!(
            owner.contains(needle),
            "{} must own FEM eigen operator assembly detail: {needle}",
            owner_path.display()
        );
    }
    assert!(
        fem_mod.contains("pub(crate) mod eigen_operator;"),
        "{} must register the FEM eigen operator assembly owner",
        fem_mod_path.display()
    );
}

#[test]
fn fem_eigen_solver_backend_details_have_fem_owner() {
    let root = crate_root();
    let monolith_path = root.join("src/fem_eigen.rs");
    let monolith = production_source(&monolith_path);
    let owner_path = root.join("src/fem/eigen_solve.rs");

    assert!(
        owner_path.exists(),
        "missing FEM eigen solver backend owner: {}",
        owner_path.display()
    );
    let owner = source(&owner_path);

    for needle in [
        "const SPARSE_EIGEN_THRESHOLD",
        "struct RealEigenpair",
        "struct ComplexEigenpair",
        "fn gpu_solve_real_symmetric_eigenpairs(",
        "fn solve_real_symmetric_eigenpairs(",
        "fn solve_real_symmetric_eigenpairs_sparse(",
        "fn solve_complex_hermitian_eigenpairs(",
        "fn regularize_periodic_mass_if_needed(",
    ] {
        assert!(
            !monolith.contains(needle),
            "fem_eigen.rs must not own FEM eigen solver backend detail: {needle}"
        );
        assert!(
            owner.contains(needle),
            "{} must own FEM eigen solver backend detail: {needle}",
            owner_path.display()
        );
    }
}

#[test]
fn native_fem_masterplan_uses_existing_backend_layout() {
    let repo = repo_root();
    let docs = [
        repo.join("docs/architecture/backend-golden-masterplan.md"),
        repo.join("AGENTS.md"),
        repo.join(".agents/README.md"),
        repo.join(".agents/skills/backend-golden-masterplan/SKILL.md"),
        repo.join(".agents/skills/fem-native-backend-architecture/SKILL.md"),
    ];
    let combined = docs
        .iter()
        .map(|path| source(path))
        .collect::<Vec<_>>()
        .join("\n");

    for forbidden in [
        "native/backends/fem/common",
        "native/backends/fem/cpu/demag",
        "native/backends/fem/gpu/demag",
        "core/common/cpu/gpu",
    ] {
        assert!(
            !combined.contains(forbidden),
            "backend docs/skills must not advertise invented native FEM target path: {forbidden}"
        );
    }

    for required in [
        "native/backends/fem/core",
        "native/backends/fem/cpu/mfem",
        "native/backends/fem/gpu/cuda",
        "native/backends/fem/cpu/mfem/interactions/demag_poisson",
        "native/backends/fem/cpu/mfem/interactions/demag_fem_bem",
        "native/backends/fem/gpu/cuda/demag_poisson",
    ] {
        assert!(
            combined.contains(required),
            "backend docs/skills must name current native FEM owner: {required}"
        );
    }
}

#[test]
fn native_fem_compiled_implementation_owners_exist() {
    let native_fem = repo_root().join("native/backends/fem");
    for relative in [
        "core/fem_context_builder.cpp",
        "core/fem_mesh.cpp",
        "cpu/mfem/runtime/backend_step.cpp",
        "cpu/mfem/integrators/llg_rhs.cpp",
        "cpu/mfem/interactions/demag_poisson_solve.cpp",
        "cpu/mfem/interactions/demag_fem_bem_solve.cpp",
        "gpu/cuda/demag_poisson/poisson.cpp",
        "gpu/cuda/integrators/rk/rk_step.cu",
        "gpu/cuda/interactions/dmi/dmi_kernels.cu",
        "src/api.cpp",
        "tests/source_facade_contract.cpp",
    ] {
        let path = native_fem.join(relative);
        assert!(
            path.exists(),
            "masterplan depends on existing native FEM implementation owner: {}",
            path.display()
        );
    }
}

#[test]
fn native_fem_runner_abi_facade_is_not_a_test_monolith() {
    let root = crate_root();
    let facade_path = root.join("src/native_fem.rs");
    let tests_path = root.join("src/native_fem/tests.rs");
    let source_contract_tests_path = root.join("src/native_fem/tests/native_source_contracts.rs");
    let facade = source(&facade_path);
    let production =
        production_source_before_cfg(&facade_path, "#[cfg(all(test, feature = \"fem-gpu\"))]");
    let tests = source(&tests_path);
    let source_contract_tests = source(&source_contract_tests_path);

    let facade_line_count = facade.lines().count();
    assert!(
        facade_line_count < 2_000,
        "native_fem.rs must stay below the 2000-line monolith threshold; got {facade_line_count}"
    );

    assert!(
        tests_path.exists(),
        "native FEM runner ABI tests must live outside the production facade: {}",
        tests_path.display()
    );
    assert!(
        tests.contains("mod native_source_contracts;"),
        "{} must route native FEM source-layout contracts to a split owner",
        tests_path.display()
    );
    assert!(
        production.contains("struct NativeFemBackend"),
        "native_fem.rs must still own the runner ABI backend facade"
    );
    for needle in [
        "fn native_fem_poisson_rhs_hot_path_reuses_workspace(",
        "fn native_fem_hypre_solve_reuses_transfer_vectors(",
    ] {
        assert!(
            !production.contains(needle),
            "native_fem.rs production facade must not own native FEM test detail: {needle}"
        );
        assert!(
            source_contract_tests.contains(needle),
            "{} must own native FEM runner ABI test detail: {needle}",
            source_contract_tests_path.display()
        );
    }
}

#[test]
fn native_fem_availability_has_probe_owner() {
    let root = crate_root();
    let facade = production_source_before_cfg(
        &root.join("src/native_fem.rs"),
        "#[cfg(all(test, feature = \"fem-gpu\"))]",
    );
    let owner_path = root.join("src/native_fem/availability.rs");

    assert!(
        owner_path.exists(),
        "missing native FEM availability owner: {}",
        owner_path.display()
    );
    let owner = source(&owner_path);

    for needle in [
        "pub(crate) struct GpuAvailability",
        "pub(crate) fn native_availability()",
        "pub(crate) fn is_gpu_available()",
        "pub(crate) fn is_cpu_available()",
        "pub(crate) enum NativeFemDataResidency",
        "pub(crate) struct NativeFemGpuStateInfo",
        "pub(crate) struct NativeFemGpuRkPlanInfo",
        "pub(crate) struct DeviceInfo",
    ] {
        assert!(
            owner.contains(needle),
            "{} must own native FEM availability/runtime-info detail: {needle}",
            owner_path.display()
        );
        assert!(
            !facade.contains(needle),
            "native_fem.rs must not own native FEM availability/runtime-info detail: {needle}"
        );
    }
}

#[test]
fn native_fem_dense_eigen_has_abi_owner() {
    let root = crate_root();
    let facade = production_source_before_cfg(
        &root.join("src/native_fem.rs"),
        "#[cfg(all(test, feature = \"fem-gpu\"))]",
    );
    let owner_path = root.join("src/native_fem/eigen.rs");

    assert!(
        owner_path.exists(),
        "missing native FEM dense eigen ABI owner: {}",
        owner_path.display()
    );
    let owner = source(&owner_path);

    for needle in [
        "pub(crate) struct GpuEigenResult",
        "pub(crate) fn gpu_eigen_dense_solve(",
        "fullmag_fem_eigen_dense(",
    ] {
        assert!(
            owner.contains(needle),
            "{} must own native FEM dense eigen ABI detail: {needle}",
            owner_path.display()
        );
        assert!(
            !facade.contains(needle),
            "native_fem.rs must not own native FEM dense eigen ABI detail: {needle}"
        );
    }
}

#[test]
fn native_fem_plan_lowering_has_plan_owner() {
    let root = crate_root();
    let facade = production_source_before_cfg(
        &root.join("src/native_fem.rs"),
        "#[cfg(all(test, feature = \"fem-gpu\"))]",
    );
    let owner_path = root.join("src/native_fem/plan.rs");

    assert!(
        owner_path.exists(),
        "missing native FEM plan-lowering owner: {}",
        owner_path.display()
    );
    let owner = source(&owner_path);

    for needle in [
        "fn has_slonczewski_stt(",
        "fn has_zhang_li_stt(",
        "pub(crate) fn native_fem_precession_enabled(",
        "fn single_precision_rejection(",
        "fn native_fem_gpu_demag_mode(",
        "pub(crate) fn native_fem_plan_requests_gpu_mfem_device(",
        "pub(crate) fn native_fem_mfem_device_string_requests_gpu(",
        "fn native_fem_segment_weight(",
        "fn native_fem_object_ids_match(",
    ] {
        assert!(
            owner.contains(needle),
            "{} must own native FEM plan-lowering detail: {needle}",
            owner_path.display()
        );
        assert!(
            !facade.contains(needle),
            "native_fem.rs must not own native FEM plan-lowering detail: {needle}"
        );
    }
}

#[test]
fn fem_reference_runner_is_not_a_test_monolith() {
    let root = crate_root();
    let reference_path = root.join("src/fem_reference.rs");
    let tests_path = root.join("src/fem_reference/tests.rs");
    let reference = source(&reference_path);
    let production = production_source(&reference_path);
    let tests = source(&tests_path);

    let reference_line_count = reference.lines().count();
    assert!(
        reference_line_count < 2_000,
        "fem_reference.rs must stay below the 2000-line monolith threshold; got {reference_line_count}"
    );

    assert!(
        tests_path.exists(),
        "FEM reference runner tests must live outside the reference helper: {}",
        tests_path.display()
    );
    assert!(
        production.contains("pub(crate) fn execute_reference_fem("),
        "fem_reference.rs must still own the reference/debug runner entrypoint"
    );
    assert!(
        production.contains("Internal FEM baseline engine"),
        "fem_reference.rs must continue to identify this lane as the internal baseline/reference engine"
    );
    for needle in [
        "fn reference_runner_rejects_periodic_demag_mesh_pairs(",
        "fn llg_overdamped_relaxation_stops_before_time_limit_on_uniform_fem_state(",
    ] {
        assert!(
            !production.contains(needle),
            "fem_reference.rs production helper must not own FEM reference test detail: {needle}"
        );
        assert!(
            tests.contains(needle),
            "{} must own FEM reference test detail: {needle}",
            tests_path.display()
        );
    }
}

#[test]
fn fem_reference_outputs_have_owner() {
    let root = crate_root();
    let reference_path = root.join("src/fem_reference.rs");
    let reference = production_source(&reference_path);
    let owner_path = root.join("src/fem_reference/outputs.rs");
    assert!(
        owner_path.exists(),
        "missing FEM reference output owner: {}",
        owner_path.display()
    );
    let owner = source(&owner_path);

    for needle in [
        "pub(super) fn record_due_outputs(",
        "pub(super) fn record_scalar_snapshot(",
        "pub(super) fn record_final_outputs(",
        "fn enrich_step_stats_from_magnetization(",
        "pub(crate) fn observe_state(",
        "fn make_step_stats(",
        "fn fem_per_object_scalars(",
        "fn select_field_values(",
        "fn select_base_field(",
    ] {
        assert!(
            !reference.contains(needle),
            "fem_reference.rs must not own CPU FEM reference output/observable detail: {needle}"
        );
        assert!(
            owner.contains(needle),
            "{} must own CPU FEM reference output/observable detail: {needle}",
            owner_path.display()
        );
    }

    assert!(
        reference.contains("mod outputs;"),
        "fem_reference.rs must wire the CPU FEM reference output owner"
    );
}

#[test]
fn artifact_writer_is_not_a_test_monolith() {
    let root = crate_root();
    let artifacts_path = root.join("src/artifacts.rs");
    let tests_path = root.join("src/artifacts/tests.rs");
    let artifacts = source(&artifacts_path);
    let production = production_source(&artifacts_path);
    let tests = source(&tests_path);

    for (label, text) in [("artifacts.rs", &artifacts), ("artifacts/tests.rs", &tests)] {
        let line_count = text.lines().count();
        assert!(
            line_count < 2_000,
            "{label} must stay below the 2000-line monolith threshold; got {line_count}"
        );
    }

    assert!(
        production.contains("pub(crate) fn write_artifacts("),
        "artifacts.rs must still own the top-level artifact writer"
    );
    for needle in [
        "fn dmi_field_artifact_units_include_bulk_quantity(",
        "fn fdm_multilayer_field_snapshots_are_written_per_layer(",
    ] {
        assert!(
            !production.contains(needle),
            "artifacts.rs production writer must not own artifact test detail: {needle}"
        );
        assert!(
            tests.contains(needle),
            "{} must own artifact test detail: {needle}",
            tests_path.display()
        );
    }
}

#[test]
fn interactive_runtime_facade_is_split_by_backend_and_concern() {
    let root = crate_root();
    let facade_path = root.join("src/interactive_runtime.rs");
    let facade = source(&facade_path);

    for relative in [
        "src/interactive_runtime/display_preview.rs",
        "src/interactive_runtime/fdm/cpu.rs",
        "src/interactive_runtime/fdm/cuda.rs",
        "src/interactive_runtime/fem/mod.rs",
        "src/interactive_runtime/fem/cpu.rs",
        "src/interactive_runtime/fem/gpu.rs",
        "src/interactive_runtime/artifacts/observed.rs",
        "src/interactive_runtime/artifacts/fdm_cuda.rs",
        "src/interactive_runtime/artifacts/fem_native.rs",
        "src/interactive_runtime/provenance.rs",
        "src/interactive_runtime/signature.rs",
        "src/interactive_runtime/stats.rs",
        "src/interactive_runtime/tests.rs",
    ] {
        let path = root.join(relative);
        assert!(
            path.exists(),
            "missing interactive runtime split owner: {}",
            path.display()
        );
        let line_count = source(&path).lines().count();
        assert!(
            line_count < 2_000,
            "{} must stay below the 2000-line monolith threshold; got {line_count}",
            path.display()
        );
    }

    let facade_line_count = facade.lines().count();
    assert!(
        facade_line_count < 2_000,
        "interactive_runtime.rs must stay below the 2000-line monolith threshold; got {facade_line_count}"
    );
    assert!(
        facade.contains("pub struct InteractiveFdmPreviewRuntime"),
        "interactive_runtime.rs must keep the public FDM runtime facade"
    );
    assert!(
        facade.contains("pub struct InteractiveFemPreviewRuntime"),
        "interactive_runtime.rs must keep the public FEM runtime facade"
    );
    for needle in [
        "impl CpuInteractiveFdmPreviewRuntime",
        "impl CudaInteractiveFdmPreviewRuntime",
        "impl CpuInteractiveFemPreviewRuntime",
        "impl GpuInteractiveFemPreviewRuntime",
    ] {
        assert!(
            !facade.contains(needle),
            "interactive_runtime.rs facade must not own backend-specific impl body: {needle}"
        );
    }
    assert!(
        source(&root.join("src/interactive_runtime/fdm/cpu.rs"))
            .contains("impl CpuInteractiveFdmPreviewRuntime"),
        "FDM CPU interactive implementation must live in src/interactive_runtime/fdm/cpu.rs"
    );
    assert!(
        source(&root.join("src/interactive_runtime/fdm/cuda.rs"))
            .contains("impl CudaInteractiveFdmPreviewRuntime"),
        "FDM CUDA interactive implementation must live in src/interactive_runtime/fdm/cuda.rs"
    );
    assert!(
        source(&root.join("src/interactive_runtime/fem/mod.rs"))
            .contains("impl InteractiveFemPreviewRuntime"),
        "FEM interactive facade methods must live in src/interactive_runtime/fem/mod.rs"
    );
    assert!(
        source(&root.join("src/interactive_runtime/fem/cpu.rs"))
            .contains("impl CpuInteractiveFemPreviewRuntime"),
        "FEM CPU interactive implementation must live in src/interactive_runtime/fem/cpu.rs"
    );
    assert!(
        source(&root.join("src/interactive_runtime/fem/gpu.rs"))
            .contains("impl GpuInteractiveFemPreviewRuntime"),
        "FEM GPU interactive implementation must live in src/interactive_runtime/fem/gpu.rs"
    );
}

#[test]
fn interactive_fdm_preview_runtime_facade_methods_have_fdm_owner() {
    let root = crate_root();
    let facade = production_source(&root.join("src/interactive_runtime.rs"));
    let owner_path = root.join("src/interactive_runtime/fdm/mod.rs");

    assert!(
        owner_path.exists(),
        "missing interactive FDM facade owner: {}",
        owner_path.display()
    );
    let owner = source(&owner_path);

    for needle in [
        "impl InteractiveFdmPreviewRuntime",
        "interactive FDM preview runtime is supported only for single-layer FDM plans",
        "pub(super) fn from_fdm_plan(plan: &FdmPlanIR, engine: FdmEngine)",
        "pub fn matches_plan(&self, plan: &FdmPlanIR)",
        "plan: &FdmPlanIR,\n        until_seconds: f64,\n        outputs: &[OutputIR],\n        grid: [u32; 3],",
    ] {
        assert!(
            owner.contains(needle),
            "{} must own interactive FDM facade method definition: {needle}",
            owner_path.display()
        );
        assert!(
            !facade.contains(needle),
            "interactive_runtime.rs must not own interactive FDM facade method definition: {needle}"
        );
    }
}

#[test]
fn interactive_fem_preview_runtime_facade_methods_have_fem_owner() {
    let root = crate_root();
    let facade = production_source(&root.join("src/interactive_runtime.rs"));
    let owner_path = root.join("src/interactive_runtime/fem/mod.rs");

    assert!(
        owner_path.exists(),
        "missing interactive FEM facade owner: {}",
        owner_path.display()
    );
    let owner = source(&owner_path);

    for needle in [
        "impl InteractiveFemPreviewRuntime",
        "interactive FEM preview runtime is supported only for FEM execution plans",
        "fn from_fem_plan(plan: &FemPlanIR, engine: FemEngine)",
        "pub fn matches_plan(&self, plan: &FemPlanIR)",
        "plan: &FemPlanIR,\n        until_seconds: f64,\n        outputs: &[OutputIR],\n        field_every_n: u64,",
    ] {
        assert!(
            owner.contains(needle),
            "{} must own interactive FEM facade method definition: {needle}",
            owner_path.display()
        );
        assert!(
            !facade.contains(needle),
            "interactive_runtime.rs must not own interactive FEM facade method definition: {needle}"
        );
    }
}

#[test]
fn physics_validation_tests_are_split_by_validation_family() {
    let root = crate_root();
    for relative in [
        "tests/physics_validation.rs",
        "tests/physics_validation/frequency_domain.rs",
        "tests/physics_validation/fdm_relaxation.rs",
        "tests/physics_validation/fem_eigen.rs",
    ] {
        let path = root.join(relative);
        assert!(
            path.exists(),
            "missing physics validation split owner: {}",
            path.display()
        );
        let line_count = source(&path).lines().count();
        assert!(
            line_count < 2_000,
            "{} must stay below the 2000-line monolith threshold; got {line_count}",
            path.display()
        );
    }

    let root_source = source(&root.join("tests/physics_validation.rs"));
    assert!(
        root_source.contains("#[path = \"physics_validation/fdm_relaxation.rs\"]"),
        "physics_validation.rs must route FDM relaxation validation to its module"
    );
    assert!(
        source(&root.join("tests/physics_validation/fem_eigen.rs"))
            .contains("fn fem_eigen_smoke_completes_without_errors("),
        "FEM eigen validation tests must live under tests/physics_validation/fem_eigen.rs"
    );
}

#[test]
fn crate_public_api_facade_is_not_a_test_monolith() {
    let root = crate_root();
    let lib_path = root.join("src/lib.rs");
    let tests_path = root.join("src/lib/tests.rs");
    let lib = source(&lib_path);
    let production = lib
        .split("#[cfg(test)]\n#[path = \"lib/tests.rs\"]")
        .next()
        .expect("source should have a production section");
    let tests = source(&tests_path);

    for (label, text) in [("lib.rs", &lib), ("lib/tests.rs", &tests)] {
        let line_count = text.lines().count();
        assert!(
            line_count < 2_000,
            "{label} must stay below the 2000-line monolith threshold; got {line_count}"
        );
    }

    assert!(
        production.contains("pub fn run_problem("),
        "lib.rs must still own the public run_problem entrypoint"
    );
    assert!(
        production.contains("pub fn resolve_session_runtime("),
        "lib.rs must still own the public session runtime resolver"
    );
    for needle in [
        "fn fem_relaxation_entrypoints_route_through_fem_relax_module(",
        "fn run_problem_streams_artifacts_and_preserves_layout(",
    ] {
        assert!(
            !production.contains(needle),
            "lib.rs public API facade must not own lib test detail: {needle}"
        );
        assert!(
            tests.contains(needle),
            "{} must own lib test detail: {needle}",
            tests_path.display()
        );
    }
}

#[test]
fn runner_facades_do_not_embed_native_solver_implementation() {
    let root = crate_root();
    let facade_files = [
        "src/fdm/gpu/cuda/execute.rs",
        "src/fdm/gpu/cuda/artifacts.rs",
        "src/fem/eigen_path.rs",
        "src/fem/pbc.rs",
        "src/fem/plan.rs",
        "src/solvers/fem/plan.rs",
        "src/fem/runtime_contract.rs",
        "src/interactive_runtime.rs",
        "src/interactive_runtime/display_preview.rs",
        "src/interactive_runtime/fdm/cpu.rs",
        "src/interactive_runtime/fdm/cuda.rs",
        "src/interactive_runtime/artifacts/observed.rs",
        "src/interactive_runtime/artifacts/fdm_cuda.rs",
        "src/interactive_runtime/artifacts/fem_native.rs",
        "src/interactive_runtime/provenance.rs",
        "src/interactive_runtime/signature.rs",
        "src/interactive_runtime/stats.rs",
    ];

    for relative in facade_files {
        let path = root.join(relative);
        let text = production_source(&path);
        for forbidden in [
            "__global__",
            "cudaMalloc(",
            "cudaMemcpy(",
            "cufftPlan",
            "cufftExec",
            "mfem::",
            "HyprePar",
        ] {
            assert!(
                !text.contains(forbidden),
                "{} must remain a runner facade and not embed native solver implementation token {forbidden}",
                path.display()
            );
        }
    }
}
