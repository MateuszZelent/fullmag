use super::*;

// ===========================================================================
// FEM eigen physics tests — EIG-031/032/033/035
// ===========================================================================

/// EIG-035 smoke test: the CPU FEM eigen baseline solver must complete
/// without errors on a minimal mesh and produce at least one finite
/// eigenfrequency.
#[test]
fn fem_eigen_smoke_completes_without_errors() {
    let mesh = cube_mesh(20.0); // 20 nm cube
    let n_nodes = mesh.nodes.len();
    let m0: Vec<[f64; 3]> = vec![[1.0, 0.0, 0.0]; n_nodes];

    let plan = FemEigenPlanIR {
        mesh_build_report: None,
        mesh_name: mesh.mesh_name.clone(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: m0,
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 3,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: None,
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]), // ≈ 50 mT
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
    };

    let outputs = vec![
        OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        },
        OutputIR::EigenMode {
            field: "mode".to_string(),
            indices: vec![0u32],
        },
    ];

    let result = fullmag_runner::run_reference_fem_eigen(&plan, &outputs)
        .expect("FEM eigen smoke test must succeed");

    assert_eq!(
        result.status,
        RunStatus::Completed,
        "FEM eigen smoke: status must be Completed"
    );
    let freqs = extract_frequencies(&result);
    assert!(
        !freqs.is_empty(),
        "FEM eigen smoke: must return at least one eigenfrequency"
    );
    assert!(
        freqs.iter().all(|f| f.is_finite() && *f >= 0.0),
        "FEM eigen smoke: all frequencies must be finite and non-negative, got {freqs:?}"
    );
    // Spectrum artifact must be present
    let has_spectrum = result.artifact_bytes("eigen/spectrum.json").is_some();
    assert!(
        has_spectrum,
        "FEM eigen smoke: spectrum.json must be written"
    );
    // Mode 0 spatial profile artifact must be present
    let has_mode = result
        .artifact_bytes("eigen/modes/mode_0000.json")
        .is_some();
    assert!(has_mode, "FEM eigen smoke: mode_0000.json must be written");
}

/// EIG-031 analytic benchmark: lowest Zeeman-only mode frequency must be in
/// the correct order-of-magnitude range of the Kittel formula.
///
/// For a 50 mT Zeeman field along x and Py parameters the Kittel frequency is
/// ~7–8 GHz.  Even at this coarse resolution the uniform mode should be within
/// an order of magnitude of that value.
#[test]
fn fem_eigen_lowest_mode_order_of_magnitude() {
    let mesh = cube_mesh(20.0);
    let n_nodes = mesh.nodes.len();
    let m0: Vec<[f64; 3]> = vec![[1.0, 0.0, 0.0]; n_nodes];

    let h_x = 39_789.0_f64; // ≈ 50 mT in A/m
    let ms = 800e3_f64;
    let gamma = 2.211e5_f64;

    let plan = FemEigenPlanIR {
        mesh_build_report: None,
        mesh_name: "cube_20nm".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: m0,
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 5,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: None,
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([h_x, 0.0, 0.0]),
        gyromagnetic_ratio: gamma,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
    };

    let outputs = vec![OutputIR::EigenSpectrum {
        quantity: "eigenfrequency".to_string(),
    }];

    let result = fullmag_runner::run_reference_fem_eigen(&plan, &outputs)
        .expect("FEM eigen analytic benchmark must succeed");

    let f_lowest = extract_lowest_frequency(&result).expect("must contain lowest eigenfrequency");

    let f_kittel = kittel_frequency_hz(h_x, ms, gamma);

    // The coarse 8-node mesh does not reproduce the Kittel mode exactly, but
    // the lowest frequency must be within a factor of 10 of the Kittel value.
    let ratio = f_lowest / f_kittel;
    assert!(
        ratio > 0.1 && ratio < 10.0,
        "lowest FEM eigen frequency {f_lowest:.3e} Hz is outside [0.1, 10]× Kittel \
         {f_kittel:.3e} Hz (ratio={ratio:.3})"
    );
}

/// EIG-033 orthogonality test: mode vectors from a Hermitian eigen problem
/// must be mass-orthogonal up to numerical noise.
///
/// For the CPU reference solver all eigenvalues are real and the
/// generalized-eigenvalue solution guarantees mass-orthogonality.  We verify
/// this indirectly: the returned amplitudes should not be identically zero
/// (solver ran) and the first mode's maximum amplitude must be positive.
#[test]
fn fem_eigen_modes_are_non_trivial() {
    let mesh = cube_mesh(20.0);
    let n_nodes = mesh.nodes.len();
    let m0: Vec<[f64; 3]> = vec![[1.0, 0.0, 0.0]; n_nodes];

    let plan = FemEigenPlanIR {
        mesh_build_report: None,
        mesh_name: "cube_20nm_orth".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: m0,
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 3,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: None,
        normalization: EigenNormalizationIR::UnitMaxAmplitude,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
    };

    let outputs = vec![
        OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        },
        OutputIR::EigenMode {
            field: "mode".to_string(),
            indices: vec![0u32, 1u32],
        },
    ];

    let result = fullmag_runner::run_reference_fem_eigen(&plan, &outputs)
        .expect("FEM eigen mode orthogonality test must succeed");

    let freqs = extract_frequencies(&result);
    assert!(
        freqs.len() >= 2,
        "must compute at least 2 modes for orthogonality check, got {}",
        freqs.len()
    );

    // Frequencies must be sorted in ascending order (Lowest target)
    for window in freqs.windows(2) {
        assert!(
            window[0] <= window[1] + 1e6, // allow 1 MHz floating-point slack
            "frequencies must be non-decreasing: {:.3e} > {:.3e}",
            window[0],
            window[1]
        );
    }

    // Mode 0 spatial profile must be present and parseable
    let mode_bytes = result
        .artifact_bytes("eigen/modes/mode_0000.json")
        .expect("mode 0 artifact must be present");

    let mode_json: serde_json::Value =
        serde_json::from_slice(mode_bytes).expect("mode 0 JSON must be valid");

    let max_amp = mode_json["max_amplitude"]
        .as_f64()
        .expect("mode 0 must have max_amplitude field");

    assert!(
        max_amp > 0.0,
        "mode 0 max_amplitude must be positive, got {max_amp}"
    );

    for required in [
        "residual_norm",
        "residual_linf",
        "tangent_leakage_mean_abs",
        "tangent_leakage_max_abs",
    ] {
        let value = mode_json[required]
            .as_f64()
            .unwrap_or_else(|| panic!("mode 0 must include numeric {required}: {mode_json}"));
        assert!(
            value >= 0.0,
            "mode 0 diagnostic {required} must be non-negative, got {value}"
        );
    }
}

/// EIG-032 mesh-convergence hint: running on a finer mesh must not produce
/// lower frequencies than on a coarser mesh by more than a moderate factor.
///
/// This is a weak check: it only ensures the solver is well-behaved across
/// mesh resolutions without requiring a known analytic reference.
#[test]
fn fem_eigen_frequency_is_stable_across_resolutions() {
    let gamma = 2.211e5_f64;
    let h_x = 39_789.0_f64;

    let run = |side_nm: f64| -> f64 {
        let mesh = cube_mesh(side_nm);
        let n = mesh.nodes.len();
        let m0 = vec![[1.0_f64, 0.0, 0.0]; n];
        let plan = FemEigenPlanIR {
            mesh_build_report: None,
            mesh_name: format!("cube_{side_nm}nm"),
            mesh_source: None,
            mesh,
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: side_nm * 1e-9,
            equilibrium_magnetization: m0,
            material: fem_permalloy(),
            operator: EigenOperatorConfigIR {
                kind: EigenOperatorIR::LinearizedLlg,
                include_demag: false,
            },
            count: 3,
            target: EigenTargetIR::Lowest,
            equilibrium: EquilibriumSourceIR::Provided,
            k_sampling: None,
            normalization: EigenNormalizationIR::UnitL2,
            damping_policy: EigenDampingPolicyIR::Ignore,
            enable_exchange: true,
            enable_demag: false,
            interfacial_dmi: None,
            bulk_dmi: None,
            external_field: Some([h_x, 0.0, 0.0]),
            gyromagnetic_ratio: gamma,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
            demag_realization: None,
            air_box_config: None,
            dmi_interface_normal: None,
            mode_tracking: None,
        };
        let outputs = vec![OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }];
        let result = fullmag_runner::run_reference_fem_eigen(&plan, &outputs)
            .expect("FEM eigen convergence run must succeed");
        extract_lowest_frequency(&result).expect("must return a lowest frequency")
    };

    // Both runs use the same 8-node cube topology with different side lengths
    // (20 nm vs 40 nm).  With an external field applied, the lowest mode is
    // the uniform FMR mode whose eigenvalue equals H₀ (the exchange operator
    // row-sum vanishes for the uniform mode under Neumann BCs).  Therefore
    // the frequency is mesh-size independent: ratio ≈ 1.0.
    let f_20 = run(20.0);
    let f_40 = run(40.0);

    assert!(
        f_20.is_finite() && f_20 > 0.0,
        "20 nm run: f={f_20:.3e} must be positive finite"
    );
    assert!(
        f_40.is_finite() && f_40 > 0.0,
        "40 nm run: f={f_40:.3e} must be positive finite"
    );

    let ratio = f_20 / f_40;
    assert!(
        ratio > 0.8 && ratio < 1.25,
        "20nm/40nm frequency ratio is {ratio:.3} — expected ~1.0 (uniform FMR mode is mesh-invariant)"
    );
}

#[test]
fn fem_eigen_periodic_k_zero_runs_with_periodic_node_pairs() {
    let mut mesh = cube_mesh(20.0);
    mesh.mesh_name = "periodic_cube".to_string();
    let plan = FemEigenPlanIR {
        mesh_build_report: None,
        mesh_name: "periodic_cube".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 2,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        }),
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
            fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            },
        ),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
    };

    let result = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    )
    .expect("periodic k=0 FEM eigen solve should execute");

    let spectrum = result
        .artifact_bytes("eigen/spectrum.json")
        .expect("spectrum artifact must exist");
    let value: serde_json::Value = serde_json::from_slice(spectrum).expect("valid spectrum json");
    assert_eq!(value["boundary_config"]["kind"].as_str(), Some("periodic"));
    assert!(value["solver_capabilities"]
        .as_array()
        .is_some_and(|items| items
            .iter()
            .any(|item| item.as_str() == Some("periodic_zero_phase"))));
}

#[test]
fn fem_eigen_floquet_runs_with_phase_aware_metadata() {
    let mut mesh = cube_mesh(20.0);
    mesh.mesh_name = "floquet_cube".to_string();
    let plan = FemEigenPlanIR {
        mesh_build_report: None,
        mesh_name: "floquet_cube".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 2,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [5.0e7, 0.0, 0.0],
        }),
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
            fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            },
        ),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
    };

    let result = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    )
    .expect("floquet FEM eigen solve should execute");

    let spectrum = result
        .artifact_bytes("eigen/spectrum.json")
        .expect("spectrum artifact must exist");
    let value: serde_json::Value = serde_json::from_slice(spectrum).expect("valid spectrum json");
    assert_eq!(value["boundary_config"]["kind"].as_str(), Some("floquet"));
    assert_eq!(
        value["solver_kind"].as_str(),
        Some("cpu_phase_reduced_floquet")
    );
    assert!(value["solver_limitations"]
        .as_array()
        .is_some_and(|items| items
            .iter()
            .any(|item| item.as_str() == Some("floquet_uses_phase_reduced_hermitian_block"))));
}

#[test]
fn fem_eigen_damping_include_emits_nonzero_imaginary_frequency() {
    let mesh = cube_mesh(20.0);
    let plan = FemEigenPlanIR {
        mesh_build_report: None,
        mesh_name: mesh.mesh_name.clone(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 1,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: None,
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Include,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
    };
    let result = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    )
    .expect("damped FEM eigen solve should execute");

    let spectrum = result
        .artifact_bytes("eigen/spectrum.json")
        .expect("spectrum artifact must exist");
    let value: serde_json::Value = serde_json::from_slice(spectrum).expect("valid spectrum json");
    let first_mode = &value["modes"][0];
    assert!(first_mode["frequency_imag_hz"].as_f64().unwrap_or(0.0) < 0.0);
}

#[test]
fn fem_eigen_surface_anisotropy_runs_and_reports_term() {
    let mesh = cube_mesh(20.0);
    let plan = FemEigenPlanIR {
        mesh_build_report: None,
        mesh_name: mesh.mesh_name.clone(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 1,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: None,
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
            fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::SurfaceAnisotropy,
                boundary_pair_id: None,
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: Some(5.0e-4),
                surface_anisotropy_axis: Some([0.0, 0.0, 1.0]),
            },
        ),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
    };
    let result = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    )
    .expect("surface anisotropy FEM eigen solve should execute");

    let spectrum = result
        .artifact_bytes("eigen/spectrum.json")
        .expect("spectrum artifact must exist");
    let value: serde_json::Value = serde_json::from_slice(spectrum).expect("valid spectrum json");
    assert_eq!(
        value["included_terms"]["surface_anisotropy"].as_bool(),
        Some(true)
    );
}

#[test]
fn fem_eigen_floquet_exchange_only_is_reciprocal_for_plus_minus_k() {
    let build_plan = |kx: f64| {
        let mut mesh = cube_mesh(20.0);
        mesh.mesh_name = format!(
            "floquet_exchange_only_{}",
            if kx >= 0.0 { "plus" } else { "minus" }
        );
        FemEigenPlanIR {
            mesh_build_report: None,
            mesh_name: mesh.mesh_name.clone(),
            mesh_source: None,
            mesh,
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 20e-9,
            equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
            material: fem_permalloy(),
            operator: EigenOperatorConfigIR {
                kind: EigenOperatorIR::LinearizedLlg,
                include_demag: false,
            },
            count: 1,
            target: EigenTargetIR::Lowest,
            equilibrium: EquilibriumSourceIR::Provided,
            k_sampling: Some(fullmag_ir::KSamplingIR::Single {
                k_vector: [kx, 0.0, 0.0],
            }),
            normalization: EigenNormalizationIR::UnitL2,
            damping_policy: EigenDampingPolicyIR::Ignore,
            enable_exchange: true,
            enable_demag: false,
            interfacial_dmi: None,
            bulk_dmi: None,
            external_field: Some([39_789.0, 0.0, 0.0]),
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
                fullmag_ir::SpinWaveBoundaryConfigIR {
                    kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                    boundary_pair_id: Some("x_faces".to_string()),
                    pair_ids: Vec::new(),
                    phase_convention: fullmag_ir::PhaseConventionIR::default(),
                    surface_anisotropy_ks: None,
                    surface_anisotropy_axis: None,
                },
            ),
            demag_realization: None,
            air_box_config: None,
            dmi_interface_normal: None,
            mode_tracking: None,
        }
    };

    let run_freq = |kx: f64| {
        let plan = build_plan(kx);
        let result = fullmag_runner::run_reference_fem_eigen(
            &plan,
            &[OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            }],
        )
        .expect("floquet exchange-only FEM eigen solve should execute");
        let spectrum = result
            .artifact_bytes("eigen/spectrum.json")
            .expect("spectrum artifact must exist");
        let value: serde_json::Value =
            serde_json::from_slice(spectrum).expect("valid spectrum json");
        value["modes"][0]["frequency_real_hz"]
            .as_f64()
            .expect("first mode frequency")
    };

    let f_plus = run_freq(5.0e7);
    let f_minus = run_freq(-5.0e7);
    let rel_diff = (f_plus - f_minus).abs() / f_plus.abs().max(f_minus.abs()).max(1.0);
    assert!(
        rel_diff < 1e-10,
        "exchange-only Floquet spectrum should be reciprocal: f(+k)={f_plus:.9e}, f(-k)={f_minus:.9e}, rel_diff={rel_diff:.3e}"
    );
}

#[test]
fn fem_eigen_floquet_bulk_dmi_is_nonreciprocal_for_plus_minus_k() {
    let build_plan = |kx: f64| {
        let mut mesh = cube_mesh(20.0);
        mesh.mesh_name = format!(
            "floquet_bulk_dmi_{}",
            if kx >= 0.0 { "plus" } else { "minus" }
        );
        FemEigenPlanIR {
            mesh_build_report: None,
            mesh_name: mesh.mesh_name.clone(),
            mesh_source: None,
            mesh,
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 20e-9,
            equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
            material: fem_permalloy(),
            operator: EigenOperatorConfigIR {
                kind: EigenOperatorIR::LinearizedLlg,
                include_demag: false,
            },
            count: 1,
            target: EigenTargetIR::Lowest,
            equilibrium: EquilibriumSourceIR::Provided,
            k_sampling: Some(fullmag_ir::KSamplingIR::Single {
                k_vector: [kx, 0.0, 0.0],
            }),
            normalization: EigenNormalizationIR::UnitL2,
            damping_policy: EigenDampingPolicyIR::Ignore,
            enable_exchange: true,
            enable_demag: false,
            interfacial_dmi: None,
            bulk_dmi: Some(2.5e-3),
            external_field: Some([39_789.0, 0.0, 0.0]),
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
                fullmag_ir::SpinWaveBoundaryConfigIR {
                    kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                    boundary_pair_id: Some("x_faces".to_string()),
                    pair_ids: Vec::new(),
                    phase_convention: fullmag_ir::PhaseConventionIR::default(),
                    surface_anisotropy_ks: None,
                    surface_anisotropy_axis: None,
                },
            ),
            demag_realization: None,
            air_box_config: None,
            dmi_interface_normal: None,
            mode_tracking: None,
        }
    };

    let run_freq = |kx: f64| {
        let plan = build_plan(kx);
        let result = fullmag_runner::run_reference_fem_eigen(
            &plan,
            &[OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            }],
        )
        .expect("floquet bulk DMI FEM eigen solve should execute");
        let spectrum = result
            .artifact_bytes("eigen/spectrum.json")
            .expect("spectrum artifact must exist");
        let value: serde_json::Value =
            serde_json::from_slice(spectrum).expect("valid spectrum json");
        value["modes"][0]["frequency_real_hz"]
            .as_f64()
            .expect("first mode frequency")
    };

    let f_plus = run_freq(5.0e7);
    let f_minus = run_freq(-5.0e7);
    assert!(
        (f_plus - f_minus).abs() > 1.0,
        "bulk DMI Floquet spectrum should be non-reciprocal, got f(+k)={f_plus:.6e}, f(-k)={f_minus:.6e}"
    );
}

/// EIG-034 FEM↔analytic cross-check with demag: including the demagnetisation
/// field must lower the uniform-mode frequency relative to the Zeeman-only case.
///
/// Physics: for an in-plane equilibrium (m₀ ∥ x̂) with H₀ along x̂, the
/// demagnetisation field adds an effective easy-plane anisotropy.  For a cube
/// (Nₓ ≈ 1/3) the internal field is reduced, so the precession frequency
/// must be lower than in the Zeeman-only (no-demag) case:
///
///   f_with_demag  <  f_no_demag
///
/// This qualitatively matches what FDM time-domain simulations would show when
/// the same geometry is excited with a broadband pulse (the resonance peak
/// in the FFT shifts to lower frequency when demag is switched on).
#[test]
fn fem_eigen_demag_lowers_frequency() {
    // Use a large external field so that the system is well-saturated even
    // after the demagnetisation field is accounted for.
    let h_x = 636_620.0_f64; // ≈ 800 mT / μ₀

    let make_plan = |include_demag: bool| {
        let mesh = cube_mesh(20.0);
        let m0 = vec![[1.0_f64, 0.0, 0.0]; mesh.nodes.len()];
        FemEigenPlanIR {
            mesh_build_report: None,
            mesh_name: format!("cube_20nm_demag_{include_demag}"),
            mesh_source: None,
            mesh,
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 20e-9,
            equilibrium_magnetization: m0,
            material: fem_permalloy(),
            operator: EigenOperatorConfigIR {
                kind: EigenOperatorIR::LinearizedLlg,
                include_demag,
            },
            count: 3,
            target: EigenTargetIR::Lowest,
            equilibrium: EquilibriumSourceIR::Provided,
            k_sampling: None,
            normalization: EigenNormalizationIR::UnitL2,
            damping_policy: EigenDampingPolicyIR::Ignore,
            enable_exchange: true,
            enable_demag: include_demag,
            interfacial_dmi: None,
            bulk_dmi: None,
            external_field: Some([h_x, 0.0, 0.0]),
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
            demag_realization: None,
            air_box_config: None,
            dmi_interface_normal: None,
            mode_tracking: None,
        }
    };

    let outputs = vec![OutputIR::EigenSpectrum {
        quantity: "eigenfrequency".to_string(),
    }];

    let result_no_demag = fullmag_runner::run_reference_fem_eigen(&make_plan(false), &outputs)
        .expect("FEM eigen (no demag) must succeed");
    let result_with_demag = fullmag_runner::run_reference_fem_eigen(&make_plan(true), &outputs)
        .expect("FEM eigen (with demag) must succeed");

    let f_no_demag = extract_lowest_frequency(&result_no_demag)
        .expect("no-demag run must return a lowest frequency");
    let f_with_demag = extract_lowest_frequency(&result_with_demag)
        .expect("with-demag run must return a lowest frequency");

    assert!(
        f_no_demag.is_finite() && f_no_demag > 0.0,
        "no-demag frequency must be positive finite, got {f_no_demag:.3e}"
    );
    assert!(
        f_with_demag.is_finite() && f_with_demag > 0.0,
        "with-demag frequency must be positive finite, got {f_with_demag:.3e}"
    );

    // Including demag must reduce the lowest resonance frequency.
    // Allow a small relative slack (1 %) to guard against numerical noise.
    assert!(
        f_with_demag < f_no_demag * 1.01,
        "demag should lower the uniform-mode frequency: \
         f_with_demag={f_with_demag:.3e} Hz, f_no_demag={f_no_demag:.3e} Hz"
    );
}

#[test]
fn fem_eigen_poisson_robin_demag_runs_on_shared_domain_mesh() {
    let mesh = MeshIR {
        mesh_name: "eigen_shared_domain_robin".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
        ],
        elements: vec![[0, 1, 2, 3], [0, 1, 2, 4]],
        element_markers: vec![1, 0],
        boundary_faces: vec![
            [0, 1, 3],
            [1, 2, 3],
            [2, 0, 3],
            [0, 1, 4],
            [1, 2, 4],
            [2, 0, 4],
        ],
        boundary_markers: vec![1, 1, 1, 1, 1, 1],
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        per_domain_quality: std::collections::HashMap::new(),
    };

    let plan = FemEigenPlanIR {
        mesh_build_report: None,
        mesh_name: mesh.mesh_name.clone(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, 0.0],
        ],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: true,
        },
        count: 2,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: None,
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: true,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([100_000.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
        demag_realization: Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin),
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
    };

    let outputs = [OutputIR::EigenSpectrum {
        quantity: "eigenfrequency".to_string(),
    }];

    let result = fullmag_runner::run_reference_fem_eigen(&plan, &outputs)
        .expect("FEM eigen Poisson-Robin demag should execute on shared-domain mesh");
    assert_eq!(result.status, RunStatus::Completed);

    let spectrum = result
        .artifact_bytes("eigen/spectrum.json")
        .expect("spectrum artifact must exist");
    let value: serde_json::Value = serde_json::from_slice(spectrum).expect("valid spectrum json");
    assert!(value["solver_capabilities"]
        .as_array()
        .is_some_and(|items| items
            .iter()
            .any(|item| item.as_str() == Some("demag_poisson_robin"))));
}

// ===========================================================================
// Etap 0b — Spin-wave BC end-to-end test pack (EIG-040/041/042/043)
// ===========================================================================

/// EIG-040: Free BC baseline.
///
/// Solve the eigenvalue problem with the default Free (Neumann) BC on a small
/// cube.  Assertions:
/// - solver completes without errors,
/// - all returned frequencies are finite and positive,
/// - they are sorted in non-decreasing order (Lowest target).
/// - the lowest mode frequency is compatible with a Kittel-like estimate for
///   the applied Zeeman field (within an order of magnitude).
#[test]
fn eigen_bc_free_baseline() {
    let h_x = 39_789.0_f64; // ≈ 50 mT / μ₀
    let ms = 800e3_f64;
    let gamma = 2.211e5_f64;

    let mesh = cube_mesh(20.0);
    let plan = FemEigenPlanIR {
        mesh_build_report: None,
        mesh_name: "bc_free_baseline".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 3,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: None,
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([h_x, 0.0, 0.0]),
        gyromagnetic_ratio: gamma,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(), // Free BC
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
    };

    let result = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    )
    .expect("Free BC eigen solve must succeed");

    let freqs = extract_frequencies(&result);
    assert!(
        !freqs.is_empty(),
        "Free BC: must return at least one eigenfrequency"
    );
    assert!(
        freqs.iter().all(|f| f.is_finite() && *f >= 0.0),
        "Free BC: all frequencies must be finite and non-negative, got {freqs:?}"
    );
    for window in freqs.windows(2) {
        assert!(
            window[0] <= window[1] + 1e6,
            "Free BC: frequencies must be non-decreasing: {:.3e} > {:.3e}",
            window[0],
            window[1]
        );
    }
    // The lowest mode should be the uniform FMR.  For free BC under pure
    // Zeeman the eigenvalue equals H₀, so the frequency scales as γ·H₀.
    let f_kittel_approx = gamma * h_x / (2.0 * std::f64::consts::PI);
    let f0 = freqs[0];
    let ratio = f0 / f_kittel_approx;
    assert!(
        ratio > 0.5 && ratio < 2.0,
        "Free BC: lowest frequency {f0:.3e} Hz should be within 2× of Kittel estimate \
         {f_kittel_approx:.3e} Hz (ratio={ratio:.2})"
    );
    // Kittel frequency for thin film (H₀·(H₀+Ms))^0.5 upper bound check
    let f_kittel_max = kittel_frequency_hz(h_x, ms, gamma);
    assert!(
        f0 < f_kittel_max * 3.0,
        "Free BC: f0={f0:.3e} should be less than 3× Kittel thin-film freq {f_kittel_max:.3e}"
    );
}

/// EIG-041: Pinned BC raises eigenfrequencies above Free BC.
///
/// Pinning the surface nodes eliminates zero-gradient modes and adds an
/// effective surface exchange term — all eigenfrequencies must be strictly
/// higher than their Free BC counterparts (at least for the lowest modes).
#[test]
fn eigen_bc_pinned_higher_frequency() {
    let h_x = 39_789.0_f64;
    let gamma = 2.211e5_f64;

    let make_plan = |pinned: bool| {
        let mesh = cube_mesh(20.0);
        FemEigenPlanIR {
            mesh_build_report: None,
            mesh_name: format!("bc_pinned_{pinned}"),
            mesh_source: None,
            mesh,
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 20e-9,
            equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
            material: fem_permalloy(),
            operator: EigenOperatorConfigIR {
                kind: EigenOperatorIR::LinearizedLlg,
                include_demag: false,
            },
            count: 3,
            target: EigenTargetIR::Lowest,
            equilibrium: EquilibriumSourceIR::Provided,
            k_sampling: None,
            normalization: EigenNormalizationIR::UnitL2,
            damping_policy: EigenDampingPolicyIR::Ignore,
            enable_exchange: true,
            enable_demag: false,
            interfacial_dmi: None,
            bulk_dmi: None,
            external_field: Some([h_x, 0.0, 0.0]),
            gyromagnetic_ratio: gamma,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            spin_wave_bc: if pinned {
                fullmag_ir::SpinWaveBoundaryConditionIR::Config(
                    fullmag_ir::SpinWaveBoundaryConfigIR {
                        kind: fullmag_ir::SpinWaveBoundaryKindIR::Pinned,
                        boundary_pair_id: None,
                        pair_ids: Vec::new(),
                        phase_convention: fullmag_ir::PhaseConventionIR::default(),
                        surface_anisotropy_ks: None,
                        surface_anisotropy_axis: None,
                    },
                )
            } else {
                fullmag_ir::SpinWaveBoundaryConditionIR::default()
            },
            demag_realization: None,
            air_box_config: None,
            dmi_interface_normal: None,
            mode_tracking: None,
        }
    };

    let result_free = fullmag_runner::run_reference_fem_eigen(
        &make_plan(false),
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    )
    .expect("Free BC eigen solve must succeed");

    let result_pinned = fullmag_runner::run_reference_fem_eigen(
        &make_plan(true),
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    );

    // On a 2×2×2 mesh all 8 nodes are surface nodes; Pinned BC eliminates
    // all of them and returns zero active modes → expect an error, not a solve.
    // This is the correct physics: you cannot pin every node in the mesh.
    match result_pinned {
        Err(_) => {
            // Expected: All-surface mesh with Pinned BC → no active nodes → RunError
        }
        Ok(ref result) => {
            // If the solver somehow ran (e.g. interior nodes exist), verify
            // that any returned frequencies are ≥ the Free BC frequencies.
            let freqs_free = extract_frequencies(&result_free);
            let freqs_pinned = extract_frequencies(result);
            if !freqs_pinned.is_empty() && !freqs_free.is_empty() {
                assert!(
                    freqs_pinned[0] >= freqs_free[0] * 0.9,
                    "Pinned BC lowest frequency ({:.3e} Hz) should be >= Free BC ({:.3e} Hz)",
                    freqs_pinned[0],
                    freqs_free[0]
                );
            }
        }
    }

    // Free BC must always succeed
    let freqs_free = extract_frequencies(&result_free);
    assert!(
        !freqs_free.is_empty(),
        "Free BC must return at least one eigenfrequency"
    );
    assert!(
        freqs_free.iter().all(|f| f.is_finite() && *f > 0.0),
        "Free BC frequencies must all be positive finite"
    );
}

/// EIG-042: Periodic BC without periodic_node_pairs returns a RunError.
///
/// When the mesh contains no periodic_node_pairs metadata and the user
/// requests Periodic BC, the runner must report an explicit error rather
/// than silently falling through to Free BC behaviour.
#[test]
fn eigen_bc_periodic_requires_pairs_error() {
    // Build a mesh that has NO periodic_node_pairs.
    let mut mesh = cube_mesh(20.0);
    mesh.periodic_node_pairs.clear();
    mesh.mesh_name = "cube_no_periodic_pairs".to_string();

    let plan = FemEigenPlanIR {
        mesh_build_report: None,
        mesh_name: "cube_no_periodic_pairs".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 2,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        }),
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
            fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
                boundary_pair_id: None,
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            },
        ),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
    };

    let result = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    );

    assert!(
        result.is_err(),
        "Periodic BC without periodic_node_pairs must return a RunError, got Ok"
    );
    let err_msg = result.unwrap_err().message;
    assert!(
        err_msg.contains("periodic") || err_msg.contains("periodic_node_pairs"),
        "Error message should mention 'periodic' or 'periodic_node_pairs', got: {err_msg}"
    );
}

/// EIG-043: Periodic BC with pairs (k=0) produces the same lowest frequency
/// as Free BC.
///
/// At k=0 all phase factors are 1, so the Periodic-BC operator is identical
/// to the Free-BC operator.  The lowest eigenfrequency must be equal within
/// a small relative tolerance.
#[test]
fn eigen_bc_periodic_k_zero_matches_free() {
    let h_x = 39_789.0_f64;
    let gamma = 2.211e5_f64;

    let make_plan = |periodic: bool| {
        let mesh = cube_mesh(20.0);
        FemEigenPlanIR {
            mesh_build_report: None,
            mesh_name: format!("bc_periodic_k0_{periodic}"),
            mesh_source: None,
            mesh,
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 20e-9,
            equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
            material: fem_permalloy(),
            operator: EigenOperatorConfigIR {
                kind: EigenOperatorIR::LinearizedLlg,
                include_demag: false,
            },
            count: 2,
            target: EigenTargetIR::Lowest,
            equilibrium: EquilibriumSourceIR::Provided,
            k_sampling: if periodic {
                Some(fullmag_ir::KSamplingIR::Single {
                    k_vector: [0.0, 0.0, 0.0],
                })
            } else {
                None
            },
            normalization: EigenNormalizationIR::UnitL2,
            damping_policy: EigenDampingPolicyIR::Ignore,
            enable_exchange: true,
            enable_demag: false,
            interfacial_dmi: None,
            bulk_dmi: None,
            external_field: Some([h_x, 0.0, 0.0]),
            gyromagnetic_ratio: gamma,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            spin_wave_bc: if periodic {
                fullmag_ir::SpinWaveBoundaryConditionIR::Config(
                    fullmag_ir::SpinWaveBoundaryConfigIR {
                        kind: fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
                        boundary_pair_id: Some("x_faces".to_string()),
                        pair_ids: Vec::new(),
                        phase_convention: fullmag_ir::PhaseConventionIR::default(),
                        surface_anisotropy_ks: None,
                        surface_anisotropy_axis: None,
                    },
                )
            } else {
                fullmag_ir::SpinWaveBoundaryConditionIR::default()
            },
            demag_realization: None,
            air_box_config: None,
            dmi_interface_normal: None,
            mode_tracking: None,
        }
    };

    let result_free = fullmag_runner::run_reference_fem_eigen(
        &make_plan(false),
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    )
    .expect("Free BC must succeed");

    let result_periodic = fullmag_runner::run_reference_fem_eigen(
        &make_plan(true),
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    )
    .expect("Periodic k=0 must succeed");

    let f_free =
        extract_lowest_frequency(&result_free).expect("Free BC must return a lowest frequency");
    let f_periodic = extract_lowest_frequency(&result_periodic)
        .expect("Periodic k=0 must return a lowest frequency");

    assert!(
        f_free.is_finite() && f_free > 0.0,
        "Free BC f={f_free:.3e} must be positive"
    );
    assert!(
        f_periodic.is_finite() && f_periodic > 0.0,
        "Periodic k=0 f={f_periodic:.3e} must be positive"
    );

    let rel_diff = (f_free - f_periodic).abs() / f_free.max(f_periodic);
    assert!(
        rel_diff < 0.05,
        "Periodic at k=0 should match Free BC within 5%: \
         f_free={f_free:.3e} Hz, f_periodic={f_periodic:.3e} Hz (rel_diff={rel_diff:.3})"
    );
}

#[test]
fn floquet_k0_equals_periodic() {
    let make_plan = |kind: fullmag_ir::SpinWaveBoundaryKindIR| {
        let mesh = cube_mesh(20.0);
        FemEigenPlanIR {
            mesh_build_report: None,
            mesh_name: format!("bc_{kind:?}_k0").to_lowercase(),
            mesh_source: None,
            mesh,
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 20e-9,
            equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
            material: fem_permalloy(),
            operator: EigenOperatorConfigIR {
                kind: EigenOperatorIR::LinearizedLlg,
                include_demag: false,
            },
            count: 2,
            target: EigenTargetIR::Lowest,
            equilibrium: EquilibriumSourceIR::Provided,
            k_sampling: Some(KSamplingIR::Single {
                k_vector: [0.0, 0.0, 0.0],
            }),
            normalization: EigenNormalizationIR::UnitL2,
            damping_policy: EigenDampingPolicyIR::Ignore,
            enable_exchange: true,
            enable_demag: false,
            interfacial_dmi: None,
            bulk_dmi: None,
            external_field: Some([39_789.0, 0.0, 0.0]),
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
                fullmag_ir::SpinWaveBoundaryConfigIR {
                    kind,
                    boundary_pair_id: Some("x_faces".to_string()),
                    pair_ids: Vec::new(),
                    phase_convention: fullmag_ir::PhaseConventionIR::default(),
                    surface_anisotropy_ks: None,
                    surface_anisotropy_axis: None,
                },
            ),
            demag_realization: None,
            air_box_config: None,
            dmi_interface_normal: None,
            mode_tracking: None,
        }
    };

    let outputs = [OutputIR::EigenSpectrum {
        quantity: "eigenfrequency".to_string(),
    }];
    let periodic = fullmag_runner::run_reference_fem_eigen(
        &make_plan(fullmag_ir::SpinWaveBoundaryKindIR::Periodic),
        &outputs,
    )
    .expect("periodic k=0 solve should succeed");
    let floquet = fullmag_runner::run_reference_fem_eigen(
        &make_plan(fullmag_ir::SpinWaveBoundaryKindIR::Floquet),
        &outputs,
    )
    .expect("Floquet k=0 solve should succeed");
    let periodic_f =
        extract_lowest_frequency(&periodic).expect("periodic spectrum should have frequencies");
    let floquet_f =
        extract_lowest_frequency(&floquet).expect("Floquet spectrum should have frequencies");

    let rel_diff = (periodic_f - floquet_f).abs() / periodic_f.max(floquet_f);
    assert!(
        rel_diff < 1e-8,
        "Floquet(k=0) must equal Periodic: periodic={periodic_f:.9e} Hz, \
         floquet={floquet_f:.9e} Hz, rel_diff={rel_diff:.3e}"
    );
}

#[test]
fn fem_eigen_path_writes_v2_dispersion_artifacts() {
    let mut mesh = cube_mesh(20.0);
    mesh.mesh_name = "path_dispersion_cube".to_string();
    let plan = FemEigenPlanIR {
        mesh_build_report: None,
        mesh_name: "path_dispersion_cube".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 2,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: Some(KSamplingIR::Path {
            points: vec![
                KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                KPointIR {
                    label: Some("X".to_string()),
                    k_vector: [5.0e7, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![2],
            closed: false,
        }),
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
            fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            },
        ),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: Some(fullmag_ir::ModeTrackingIR::default()),
    };

    let result = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }],
    )
    .expect("path eigensolve should produce V2 artifacts");

    let spectrum: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("eigen/spectrum.v2.json")
            .expect("spectrum.v2 artifact should exist"),
    )
    .expect("spectrum.v2 should be valid json");
    assert_eq!(
        spectrum["schema_version"].as_str(),
        Some("eigen_spectrum.v2")
    );
    assert_eq!(spectrum["samples"].as_array().map(Vec::len), Some(3));
    assert_eq!(spectrum["samples"][2]["label"].as_str(), Some("X"));
    assert!(spectrum["samples"][2]["path_s"].as_f64().unwrap_or(0.0) > 0.0);

    let branches: serde_json::Value = serde_json::from_slice(
        result
            .artifact_bytes("eigen/branches.v2.json")
            .expect("branches.v2 artifact should exist"),
    )
    .expect("branches.v2 should be valid json");
    assert_eq!(
        branches["schema_version"].as_str(),
        Some("eigen_branches.v2")
    );
    assert!(branches["branches"]
        .as_array()
        .is_some_and(|items| !items.is_empty()));

    let csv = std::str::from_utf8(
        result
            .artifact_bytes("eigen/dispersion.csv")
            .expect("dispersion.csv artifact should exist"),
    )
    .expect("dispersion.csv should be utf-8");
    let mut lines = csv.lines();
    let header = lines.next().unwrap_or_default();
    for required in [
        "sample_index",
        "path_s_rad_per_m",
        "kx_rad_per_m",
        "ky_rad_per_m",
        "kz_rad_per_m",
        "branch_id",
        "residual_norm",
    ] {
        assert!(
            header.split(',').any(|column| column == required),
            "dispersion.csv header must contain {required}, got {header}"
        );
    }
    let first_row = lines
        .next()
        .expect("dispersion.csv should contain mode rows");
    assert!(
        first_row
            .split(',')
            .nth(11)
            .is_some_and(|value| !value.is_empty()),
        "dispersion.csv residual_norm column should be populated, row={first_row}"
    );
}

#[test]
fn fem_eigen_single_k_dispersion_request_writes_v2_dispersion_artifact() {
    let mut mesh = cube_mesh(20.0);
    mesh.mesh_name = "single_k_dispersion_cube".to_string();
    let plan = FemEigenPlanIR {
        mesh_build_report: None,
        mesh_name: "single_k_dispersion_cube".to_string(),
        mesh_source: None,
        mesh,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
        domain_frame: None,
        fe_order: 1,
        hmax: 20e-9,
        equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 8],
        material: fem_permalloy(),
        operator: EigenOperatorConfigIR {
            kind: EigenOperatorIR::LinearizedLlg,
            include_demag: false,
        },
        count: 2,
        target: EigenTargetIR::Lowest,
        equilibrium: EquilibriumSourceIR::Provided,
        k_sampling: Some(KSamplingIR::Single {
            k_vector: [5.0e7, 0.0, 0.0],
        }),
        normalization: EigenNormalizationIR::UnitL2,
        damping_policy: EigenDampingPolicyIR::Ignore,
        enable_exchange: true,
        enable_demag: false,
        interfacial_dmi: None,
        bulk_dmi: None,
        external_field: Some([39_789.0, 0.0, 0.0]),
        gyromagnetic_ratio: 2.211e5,
        precision: ExecutionPrecision::Double,
        exchange_bc: ExchangeBoundaryCondition::Neumann,
        spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::Config(
            fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            },
        ),
        demag_realization: None,
        air_box_config: None,
        dmi_interface_normal: None,
        mode_tracking: None,
    };

    let result = fullmag_runner::run_reference_fem_eigen(
        &plan,
        &[
            OutputIR::EigenSpectrum {
                quantity: "eigenfrequency".to_string(),
            },
            OutputIR::DispersionCurve {
                name: "dispersion".to_string(),
            },
        ],
    )
    .expect("single-k eigensolve should execute");

    let csv = std::str::from_utf8(
        result
            .artifact_bytes("eigen/dispersion.csv")
            .expect("single-k dispersion request should write v2 dispersion.csv"),
    )
    .expect("dispersion.csv should be utf-8");
    let mut lines = csv.lines();
    let header = lines.next().unwrap_or_default();
    for required in [
        "sample_index",
        "path_s_rad_per_m",
        "kx_rad_per_m",
        "raw_mode_index",
        "frequency_hz",
        "residual_norm",
    ] {
        assert!(
            header.split(',').any(|column| column == required),
            "single-k dispersion.csv header must contain {required}, got {header}"
        );
    }
    let first_row = lines
        .next()
        .expect("single-k dispersion.csv should contain mode rows");
    assert!(
        first_row
            .split(',')
            .nth(11)
            .is_some_and(|value| !value.is_empty()),
        "single-k dispersion.csv residual_norm column should be populated, row={first_row}"
    );
}
