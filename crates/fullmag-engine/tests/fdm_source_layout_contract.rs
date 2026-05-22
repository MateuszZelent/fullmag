use std::fs;
use std::path::{Path, PathBuf};

fn crate_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn assert_exists(path: &Path) {
    assert!(
        path.exists(),
        "missing expected FDM owner path: {}",
        path.display()
    );
}

#[test]
fn fdm_engine_shared_vector_field_has_fdm_owner() {
    let root = crate_root();
    for path in [
        "src/fdm/shared/vector_field.rs",
        "src/fdm/shared/problem.rs",
        "src/fdm/shared/observables.rs",
        "src/fdm/shared/terms.rs",
        "src/fdm/shared/types.rs",
    ] {
        assert_exists(&root.join(path));
    }

    let lib_rs = fs::read_to_string(root.join("src/lib.rs")).expect("read lib.rs");
    assert!(
        !lib_rs.contains("pub struct VectorFieldSoA"),
        "VectorFieldSoA must be owned by src/fdm/shared/vector_field.rs, not crate root"
    );

    for path in ["src/fdm/problem.rs", "src/fdm/types.rs"] {
        assert!(
            !root.join(path).exists(),
            "legacy flat shared FDM file must move under src/fdm/shared: {path}"
        );
    }
}

#[test]
fn fdm_engine_observables_have_shared_owner() {
    let root = crate_root();
    let observables_owner = root.join("src/fdm/shared/observables.rs");
    assert_exists(&observables_owner);

    let state_rs =
        fs::read_to_string(root.join("src/fdm/cpu/state.rs")).expect("read src/fdm/cpu/state.rs");
    for symbol in [
        "pub struct StepReport",
        "pub struct EffectiveFieldObservables",
        "pub struct RhsEvaluation",
    ] {
        assert!(
            !state_rs.contains(symbol),
            "{symbol} must be owned by src/fdm/shared/observables.rs"
        );
    }
}

#[test]
fn fdm_engine_term_definitions_have_terms_owner() {
    let root = crate_root();
    let terms_owner = root.join("src/fdm/shared/terms.rs");
    assert_exists(&terms_owner);

    let types_rs = fs::read_to_string(root.join("src/fdm/shared/types.rs"))
        .expect("read src/fdm/shared/types.rs");
    for symbol in [
        "pub struct EffectiveFieldTerms",
        "pub struct UniaxialAnisotropyConfig",
        "pub struct CubicAnisotropyConfig",
        "pub struct ZhangLiSttConfig",
        "pub struct SlonczewskiSttConfig",
        "pub struct SotConfig",
        "pub struct OerstedCylinderConfig",
        "pub struct MagnetoelasticTermConfig",
    ] {
        assert!(
            !types_rs.contains(symbol),
            "{symbol} must be owned by src/fdm/shared/terms.rs"
        );
    }
}

#[test]
fn fdm_engine_cpu_execution_files_have_cpu_owner() {
    let root = crate_root();

    for path in [
        "src/fdm/cpu/mod.rs",
        "src/fdm/cpu/fft.rs",
        "src/fdm/cpu/fft_backend.rs",
        "src/fdm/cpu/fields.rs",
        "src/fdm/cpu/integrators.rs",
        "src/fdm/cpu/state.rs",
    ] {
        assert_exists(&root.join(path));
    }

    for path in [
        "src/fdm/fft.rs",
        "src/fdm/fft_backend.rs",
        "src/fdm/fields.rs",
        "src/fdm/integrators.rs",
        "src/fdm/state.rs",
    ] {
        assert!(
            !root.join(path).exists(),
            "legacy flat CPU FDM file must move under src/fdm/cpu: {path}"
        );
    }
}
