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
fn fdm_cpu_demagnetizing_field_has_one_realization_owner() {
    let root = crate_root();
    let owner = fs::read_to_string(root.join("src/fdm/cpu/fields/demag.rs"))
        .expect("read FDM CPU demagnetizing-field owner");
    let fields = fs::read_to_string(root.join("src/fdm/cpu/fields.rs"))
        .expect("read FDM CPU field orchestration");
    assert!(fields.contains("fields/demag.rs") && fields.contains("mod demag;"));
    for name in [
        "demag_field_from_vectors",
        "observable_demag_field_from_vectors",
        "demag_field_from_vectors_ws",
        "observable_demag_field_from_vectors_ws",
        "demag_field_from_vectors_ws_with_output_mask",
        "demag_field_add_into",
        "demag_field_add_into_soa_fft_backend",
    ] {
        let declaration = format!("fn {name}(");
        assert_eq!(
            owner.matches(&declaration).count(),
            1,
            "missing or duplicate {name}"
        );
        assert!(
            !fields.contains(&declaration),
            "field orchestration still owns {name}"
        );
    }
}

#[test]
fn fdm_cpu_direct_torques_keep_their_realization_and_fem_adapter_boundary() {
    let root = crate_root();
    let owner = fs::read_to_string(root.join("src/fdm/cpu/fields/direct_torques.rs"))
        .expect("read direct torque owner");
    let fields =
        fs::read_to_string(root.join("src/fdm/cpu/fields.rs")).expect("read field orchestration");
    assert!(fields.contains("fields/direct_torques.rs") && fields.contains("mod direct_torques;"));
    for name in [
        "slonczewski_prefactor",
        "gilbert_slonczewski_scales",
        "gilbert_zhang_li_scales",
        "slonczewski_torque_from_config",
        "prescribed_sot_scales",
        "prescribed_sot_torque_from_config",
        "direct_torques_add_into",
        "direct_torques_add_into_soa",
        "zhang_li_mumax3_torque_at_with<F>",
        "zhang_li_mumax3_torque_at",
        "zhang_li_mumax3_torque_at_soa",
        "zhang_li_stt_torque",
        "slonczewski_stt_torque",
        "sot_torque",
        "zhang_li_stt_torque_add_into",
        "zhang_li_stt_torque_add_into_soa",
        "slonczewski_stt_torque_add_into",
        "slonczewski_stt_torque_add_into_soa",
        "sot_torque_add_into",
        "sot_torque_add_into_soa",
    ] {
        let declaration = format!("fn {name}(");
        assert_eq!(
            owner.matches(&declaration).count(),
            1,
            "missing or duplicate {name}"
        );
        assert!(
            !fields.contains(&declaration),
            "orchestration still owns {name}"
        );
    }
    assert!(fields.contains("pub(crate) use direct_torques::{"));
    let fem = fs::read_to_string(root.join("src/fem.rs")).expect("read FEM reference adapter");
    for name in [
        "slonczewski_torque_from_config",
        "prescribed_sot_torque_from_config",
    ] {
        assert!(fields.contains(name), "missing FEM helper reexport {name}");
        assert!(fem.contains(&format!("crate::fdm::cpu::fields::{name}(")));
    }
}

#[test]
fn fdm_cpu_exchange_field_has_one_realization_owner() {
    let root = crate_root();
    let owner = fs::read_to_string(root.join("src/fdm/cpu/fields/exchange.rs"))
        .expect("read FDM CPU exchange-field owner");
    let fields = fs::read_to_string(root.join("src/fdm/cpu/fields.rs"))
        .expect("read FDM CPU field orchestration");
    assert!(fields.contains("fields/exchange.rs") && fields.contains("mod exchange;"));

    for name in [
        "cell_exchange_field",
        "exchange_field_from_vectors",
        "exchange_field_add_into",
        "exchange_field_add_into_soa",
    ] {
        let declaration = format!("fn {name}(");
        assert_eq!(
            owner.matches(&declaration).count(),
            1,
            "missing or duplicate {name}"
        );
        assert!(
            !fields.contains(&declaration),
            "field orchestration still owns {name}"
        );
    }

    for (path, symbol) in [
        (
            "src/fdm/cpu/fields/energy.rs",
            "exchange_field_add_into_soa",
        ),
        (
            "src/fdm/cpu/fields/observables.rs",
            "exchange_field_from_vectors",
        ),
        ("src/fdm/cpu/integrators.rs", "exchange_field_add_into_soa"),
        ("src/fdm/shared/problem.rs", "exchange_field_from_vectors"),
    ] {
        let source = fs::read_to_string(root.join(path)).expect("read exchange consumer");
        assert!(
            source.contains(symbol),
            "exchange consumer {path} no longer calls {symbol}"
        );
    }
}

#[test]
fn fdm_cpu_anisotropy_has_one_realization_owner() {
    let root = crate_root();
    let owner = fs::read_to_string(root.join("src/fdm/cpu/fields/anisotropy.rs"))
        .expect("read FDM CPU anisotropy owner");
    let fields = fs::read_to_string(root.join("src/fdm/cpu/fields.rs"))
        .expect("read FDM CPU field orchestration");
    assert!(
        fields.contains("fields/anisotropy.rs") && fields.contains("mod anisotropy;"),
        "FDM fields owner must include its dedicated anisotropy module"
    );

    for name in [
        "anisotropy_field_components",
        "anisotropy_field",
        "anisotropy_energy",
        "anisotropy_energy_from_soa",
        "anisotropy_field_add_into_soa",
        "anisotropy_field_add_into",
    ] {
        let declaration = format!("fn {name}(");
        assert_eq!(
            owner.matches(&declaration).count(),
            1,
            "missing or duplicate {name}"
        );
        assert!(
            !fields.contains(&declaration),
            "field orchestration still owns {name}"
        );
    }

    assert!(
        fields.contains("fn anisotropy_energy_density_for_magnetization(")
            && !owner.contains("fn anisotropy_energy_density_for_magnetization("),
        "the private shared energy helper must keep its existing fields.rs owner"
    );
    assert!(
        fields.contains("fused_local_terms_add_into")
            && !owner.contains("fused_local_terms_add_into"),
        "the fused local-term loop must remain outside the anisotropy owner"
    );

    for (path, symbol) in [
        ("src/fdm/cpu/fields/energy.rs", "anisotropy_energy_from_soa"),
        ("src/fdm/cpu/fields/energy.rs", "anisotropy_energy"),
        ("src/fdm/cpu/fields/observables.rs", "anisotropy_field"),
        ("src/fdm/cpu/fields/observables.rs", "anisotropy_energy"),
        (
            "src/fdm/cpu/integrators.rs",
            "anisotropy_field_add_into_soa",
        ),
        ("src/fdm/cpu/integrators.rs", "anisotropy_energy_from_soa"),
        ("src/lib.rs", "anisotropy_field"),
        ("src/lib.rs", "anisotropy_energy"),
    ] {
        let source = fs::read_to_string(root.join(path)).expect("read anisotropy consumer");
        assert!(
            source.contains(symbol),
            "anisotropy consumer {path} no longer calls {symbol}"
        );
    }
}

#[test]
fn fdm_cpu_dmi_has_one_realization_owner() {
    let root = crate_root();
    let owner =
        fs::read_to_string(root.join("src/fdm/cpu/fields/dmi.rs")).expect("read FDM CPU DMI owner");
    let fields = fs::read_to_string(root.join("src/fdm/cpu/fields.rs"))
        .expect("read FDM CPU field orchestration");
    assert!(
        fields.contains("fields/dmi.rs") && fields.contains("mod dmi;"),
        "FDM fields owner must include its dedicated DMI module"
    );

    for declaration in [
        "fn dmi_energy_from_vectors(",
        "fn rotated_interfacial_dmi_energy_from_vectors(",
        "fn dmi_energy_density_from_vectors(",
        "fn rotated_interfacial_dmi_energy_density_from_vectors(",
        "fn dmi_energy_density_with_coefficients(",
        "fn dmi_energy_from_soa(",
        "fn dmi_energy_with<F>(",
        "fn dmi_energy_with_coefficients<F>(",
        "fn dmi_cell_face_energy_with_coefficients<F>(",
        "fn dmi_face_energy_with_coefficients(",
        "fn dmi_boundary_faces(",
        "fn interfacial_dmi_boundary_correction(",
        "fn rotated_interfacial_dmi_boundary_correction(",
        "fn bulk_dmi_boundary_correction(",
        "fn interfacial_dmi_field(",
        "fn rotated_interfacial_dmi_field(",
        "fn bulk_dmi_field(",
        "fn interfacial_dmi_field_add_into_soa(",
        "fn bulk_dmi_field_add_into_soa(",
        "fn rotated_interfacial_dmi_field_add_into_soa(",
        "fn interfacial_dmi_field_add_into(",
        "fn bulk_dmi_field_add_into(",
        "fn rotated_interfacial_dmi_field_add_into(",
    ] {
        assert_eq!(
            owner.matches(declaration).count(),
            1,
            "missing or duplicate {declaration}"
        );
        assert!(
            !fields.contains(declaration),
            "field orchestration still owns {declaration}"
        );
    }

    let zeeman_owner = fs::read_to_string(root.join("src/fdm/cpu/fields/zeeman.rs"))
        .expect("read FDM CPU Zeeman owner");
    for declaration in [
        "fn external_field_add_into(",
        "fn regional_field_drives_add_into_at_time(",
    ] {
        assert!(
            zeeman_owner.contains(declaration) && !owner.contains(declaration),
            "Zeeman method must have a dedicated owner and stay out of the DMI owner: {declaration}"
        );
    }
    for declaration in [
        "fn soa_fast_path_supported(",
        "fn soa_fast_path_rejection_reason(",
    ] {
        assert!(
            fields.contains(declaration) && !owner.contains(declaration),
            "SoA capability method must remain in field orchestration: {declaration}"
        );
    }

    assert!(
        fields.contains("fused_local_terms_add_into")
            && !owner.contains("fused_local_terms_add_into"),
        "the fused local-term loop must remain outside the DMI owner"
    );

    for (path, symbol) in [
        ("src/fdm/cpu/fields/energy.rs", "dmi_energy_from_soa"),
        ("src/fdm/cpu/fields/energy.rs", "dmi_energy_from_vectors"),
        ("src/fdm/cpu/fields/observables.rs", "interfacial_dmi_field"),
        (
            "src/fdm/cpu/fields/observables.rs",
            "dmi_energy_from_vectors",
        ),
        (
            "src/fdm/cpu/integrators.rs",
            "interfacial_dmi_field_add_into_soa",
        ),
        ("src/fdm/cpu/integrators.rs", "dmi_energy_from_soa"),
        ("src/lib.rs", "rotated_interfacial_dmi_field"),
        ("src/lib.rs", "dmi_energy_from_vectors"),
    ] {
        let source = fs::read_to_string(root.join(path)).expect("read DMI consumer");
        assert!(
            source.contains(symbol),
            "DMI consumer {path} no longer calls {symbol}"
        );
    }
}

#[test]
fn fdm_cpu_zeeman_has_one_realization_owner() {
    let root = crate_root();
    let owner = fs::read_to_string(root.join("src/fdm/cpu/fields/zeeman.rs"))
        .expect("read FDM CPU Zeeman owner");
    let fields = fs::read_to_string(root.join("src/fdm/cpu/fields.rs"))
        .expect("read FDM CPU field orchestration");
    assert!(
        fields.contains("fields/zeeman.rs") && fields.contains("mod zeeman;"),
        "FDM fields owner must include its dedicated Zeeman module"
    );

    for declaration in [
        "fn external_field_vectors(",
        "fn has_external_zeeman_source(",
        "fn external_zeeman_field_vectors(",
        "fn external_zeeman_field_vectors_at_time(",
        "fn external_field_add_into(",
        "fn regional_field_drives_add_into_at_time(",
        "fn external_field_add_into_soa(",
        "fn regional_field_drives_add_into_soa_at_time(",
    ] {
        assert_eq!(
            owner.matches(declaration).count(),
            1,
            "missing or duplicate {declaration}"
        );
        assert!(
            !fields.contains(declaration),
            "field orchestration still owns {declaration}"
        );
    }

    for declaration in [
        "fn oersted_field_add_into(",
        "fn oersted_field_at_time(",
        "fn oersted_field_add_into_at_time(",
        "fn oersted_field_add_into_soa(",
        "fn oersted_field_add_into_soa_at_time(",
        "fn soa_fast_path_supported(",
        "fn soa_fast_path_rejection_reason(",
    ] {
        assert!(
            fields.contains(declaration) && !owner.contains(declaration),
            "non-Zeeman method must remain in field orchestration: {declaration}"
        );
    }
    assert!(
        fields.contains("fused_local_terms_add_into")
            && !owner.contains("fused_local_terms_add_into"),
        "the fused local-term loop must remain outside the Zeeman owner"
    );

    for (path, symbol) in [
        (
            "src/fdm/cpu/fields/energy.rs",
            "external_zeeman_field_vectors",
        ),
        (
            "src/fdm/cpu/fields/energy.rs",
            "external_field_add_into_soa",
        ),
        (
            "src/fdm/cpu/fields/observables.rs",
            "external_field_vectors",
        ),
        (
            "src/fdm/cpu/fields/observables.rs",
            "regional_field_drives_add_into_at_time",
        ),
        ("src/fdm/cpu/integrators.rs", "external_field_add_into_soa"),
        (
            "src/fdm/cpu/integrators.rs",
            "regional_field_drives_add_into_soa_at_time",
        ),
        ("src/fdm/shared/problem.rs", "external_field_vectors"),
        (
            "src/fdm/shared/problem.rs",
            "external_zeeman_field_vectors_at_time",
        ),
        ("src/fdm/cpu/fields.rs", "external_field_add_into"),
        (
            "src/fdm/cpu/fields.rs",
            "regional_field_drives_add_into_at_time",
        ),
    ] {
        let source = fs::read_to_string(root.join(path)).expect("read Zeeman consumer");
        assert!(
            source.contains(symbol),
            "Zeeman consumer {path} no longer calls {symbol}"
        );
    }
}

#[test]
fn fdm_cpu_magnetoelastic_has_one_realization_owner() {
    let root = crate_root();
    let owner = fs::read_to_string(root.join("src/fdm/cpu/fields/magnetoelastic.rs"))
        .expect("read FDM CPU magnetoelastic owner");
    let fields = fs::read_to_string(root.join("src/fdm/cpu/fields.rs"))
        .expect("read FDM CPU field orchestration");
    assert!(
        fields.contains("fields/magnetoelastic.rs") && fields.contains("mod magnetoelastic_terms;"),
        "FDM fields owner must include its dedicated magnetoelastic module"
    );
    assert!(
        fields.contains("use crate::magnetoelastic;"),
        "the parent magnetoelastic namespace import must remain available"
    );

    for declaration in [
        "fn magnetoelastic_field(",
        "fn magnetoelastic_energy(",
        "fn magnetoelastic_energy_soa(",
        "fn magnetoelastic_field_add_into_soa(",
        "fn magnetoelastic_field_add_into(",
    ] {
        assert_eq!(
            owner.matches(declaration).count(),
            1,
            "missing or duplicate {declaration}"
        );
        assert!(
            !fields.contains(declaration),
            "field orchestration still owns {declaration}"
        );
    }

    assert!(
        fields.contains("fused_local_terms_add_into")
            && !owner.contains("fused_local_terms_add_into"),
        "the fused local-term loop must remain outside the magnetoelastic owner"
    );

    for (path, symbol) in [
        ("src/fdm/cpu/fields/energy.rs", "magnetoelastic_energy_soa"),
        ("src/fdm/cpu/fields/energy.rs", "magnetoelastic_energy"),
        ("src/fdm/cpu/fields/observables.rs", "magnetoelastic_field"),
        ("src/fdm/cpu/fields/observables.rs", "magnetoelastic_energy"),
        (
            "src/fdm/cpu/integrators.rs",
            "magnetoelastic_field_add_into_soa",
        ),
        ("src/fdm/cpu/fields.rs", "magnetoelastic_field_add_into"),
    ] {
        let source = fs::read_to_string(root.join(path)).expect("read magnetoelastic consumer");
        assert!(
            source.contains(symbol),
            "magnetoelastic consumer {path} no longer calls {symbol}"
        );
    }
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
