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

#[test]
fn fdm_engine_energy_calculations_have_a_dedicated_owner() {
    let root = crate_root();
    let energy_path = root.join("src/fdm/cpu/fields/energy.rs");
    assert_exists(&energy_path);

    let energy_rs = fs::read_to_string(energy_path).expect("read FDM energy owner");
    let energy_methods = [
        "pub fn total_energy_from_soa_ws(",
        "pub fn total_energy_from_vectors_ws(",
        "pub(crate) fn half_field_energy_from_soa(",
        "pub(crate) fn full_field_energy_from_soa(",
        "pub(crate) fn field_energy_from_soa(",
        "pub fn exchange_energy_from_vectors(",
        "pub(crate) fn exchange_energy_from_field(",
        "pub fn exchange_energy_density_from_field(",
        "pub(crate) fn demag_energy_from_fields(",
        "pub fn demag_energy_density_from_fields(",
        "pub(crate) fn external_energy_from_fields(",
        "pub fn external_energy_density_from_fields(",
        "pub fn anisotropy_energy_density_from_vectors(",
        "fn field_dot_energy_density(",
    ];
    for symbol in energy_methods {
        assert!(
            energy_rs.contains(symbol),
            "energy calculation owner is missing {symbol}"
        );
    }

    let fields_rs =
        fs::read_to_string(root.join("src/fdm/cpu/fields.rs")).expect("read FDM fields owner");
    assert!(
        fields_rs.contains("fields/energy.rs") && fields_rs.contains("mod energy;"),
        "FDM fields owner must include its dedicated energy module"
    );
    for symbol in energy_methods {
        assert!(
            !fields_rs.contains(symbol),
            "energy calculation {symbol} must be owned by fields/energy.rs"
        );
    }
}

#[test]
fn fdm_engine_field_observables_have_a_dedicated_owner() {
    let root = crate_root();
    let observables_path = root.join("src/fdm/cpu/fields/observables.rs");
    assert_exists(&observables_path);

    let observables_rs = fs::read_to_string(observables_path).expect("read FDM observables owner");
    let fields_rs =
        fs::read_to_string(root.join("src/fdm/cpu/fields.rs")).expect("read FDM fields owner");
    for symbol in [
        "pub(crate) fn observe_vectors_ws_at_time(",
        "pub(crate) fn observable_effective_field_from_vectors_ws_at_time(",
    ] {
        assert!(
            observables_rs.contains(symbol),
            "FDM observables owner is missing {symbol}"
        );
        assert!(
            !fields_rs.contains(symbol),
            "FDM observable {symbol} must be owned by fields/observables.rs"
        );
    }
    assert!(
        fields_rs.contains("fields/observables.rs") && fields_rs.contains("mod observables;"),
        "FDM fields owner must include its dedicated observables module"
    );
}

#[test]
fn fdm_engine_root_does_not_keep_compatibility_shim_modules() {
    let root = crate_root();
    let lib_rs = fs::read_to_string(root.join("src/lib.rs")).expect("read src/lib.rs");

    for needle in [
        "mod fdm_fft {",
        "pub mod fdm_fft_backend {",
        "mod fdm_types {",
        "crate::fdm_fft::",
        "crate::fdm_fft_backend::",
        "crate::fdm_types::",
    ] {
        assert!(
            !lib_rs.contains(needle),
            "FDM engine root must not keep compatibility shim module/import: {needle}"
        );
    }
}

#[test]
fn fdm_module_reexports_use_cpu_and_shared_owner_modules_directly() {
    let root = crate_root();
    let fdm_mod = fs::read_to_string(root.join("src/fdm/mod.rs")).expect("read src/fdm/mod.rs");

    for needle in [
        "pub(crate) mod fft {",
        "pub mod fft_backend {",
        "pub(crate) mod state {",
        "pub(crate) mod problem {",
        "pub(crate) mod types {",
    ] {
        assert!(
            !fdm_mod.contains(needle),
            "src/fdm/mod.rs must re-export from owner modules directly, not via shim: {needle}"
        );
    }

    for path in [
        "src/fdm/shared/problem.rs",
        "src/fdm/cpu/fft.rs",
        "src/fdm/cpu/fields.rs",
    ] {
        let source = fs::read_to_string(root.join(path)).expect("read FDM owner source");
        for needle in [
            "crate::fdm_fft",
            "crate::fdm_fft_backend",
            "crate::fdm_types",
        ] {
            assert!(
                !source.contains(needle),
                "{path} must import directly from src/fdm/cpu or src/fdm/shared owners, not {needle}"
            );
        }
    }
}
