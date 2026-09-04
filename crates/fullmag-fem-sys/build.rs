fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "on" | "true" | "yes"
            )
        })
        .unwrap_or(false)
}

fn rerun_if_changed_tree(path: impl AsRef<std::path::Path>) {
    let path = path.as_ref();
    println!("cargo:rerun-if-changed={}", path.display());
    let Ok(entries) = std::fs::read_dir(path) else {
        return;
    };
    let mut entries = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    entries.sort();
    for entry in entries {
        if entry.is_dir() {
            rerun_if_changed_tree(&entry);
        } else {
            println!("cargo:rerun-if-changed={}", entry.display());
        }
    }
}

fn generate_gpu_execution_receipt_abi_assertions(out_dir: &std::path::Path) {
    const FIELDS: &[(&str, usize)] = &[
        ("abi_version", 0),
        ("struct_size", 4),
        ("execution_class", 8),
        ("precision", 12),
        ("integrator", 16),
        ("device_ordinal", 20),
        ("required_operator_mask", 24),
        ("resolved_device_operator_mask", 32),
        ("resolved_host_operator_mask", 40),
        ("resolved_unknown_operator_mask", 48),
        ("executed_device_operator_mask", 56),
        ("executed_host_operator_mask", 64),
        ("executed_unknown_operator_mask", 72),
        ("fallback_count", 80),
        ("accepted_step_count", 88),
        ("rejected_attempt_count", 96),
        ("failed_attempt_count", 104),
        ("hot_loop_compute_h2d_bytes", 112),
        ("hot_loop_compute_d2h_bytes", 120),
        ("hot_loop_compute_host_sync_count", 128),
    ];
    let mut generated = String::from(
        "const _: () = {\n    assert!(std::mem::size_of::<fullmag_fem_gpu_execution_receipt_v1>() == 136);\n    assert!(std::mem::align_of::<fullmag_fem_gpu_execution_receipt_v1>() == 8);\n",
    );
    for (field, offset) in FIELDS {
        generated.push_str(&format!(
            "    assert!(std::mem::offset_of!(fullmag_fem_gpu_execution_receipt_v1, {field}) == {offset});\n"
        ));
    }
    generated.push_str("};\n\n");
    const PERFORMANCE_V2_FIELDS: &[(&str, usize)] = &[
        ("abi_version", 0),
        ("struct_size", 4),
        ("setup_count", 8),
        ("apply_count", 16),
        ("kernel_launch_count", 24),
        ("compute_fence_count", 32),
        ("snapshot_fence_count", 40),
        ("export_fence_count", 48),
        ("selected_sparse_kernel_id", 56),
        ("setup_wall_time_ns", 64),
        ("apply_wall_time_ns", 72),
        ("accepted_finalization_wall_time_ns", 80),
    ];
    generated.push_str(
        "const _: () = {\n    assert!(std::mem::size_of::<fullmag_fem_gpu_performance_snapshot_v2>() == 88);\n    assert!(std::mem::align_of::<fullmag_fem_gpu_performance_snapshot_v2>() == 8);\n",
    );
    for (field, offset) in PERFORMANCE_V2_FIELDS {
        generated.push_str(&format!(
            "    assert!(std::mem::offset_of!(fullmag_fem_gpu_performance_snapshot_v2, {field}) == {offset});\n"
        ));
    }
    generated.push_str("};\n\n");

    const RECEIPT_V2_FIELDS: &[(&str, usize)] = &[
        ("abi_version", 0),
        ("struct_size", 4),
        ("execution_class", 8),
        ("precision", 12),
        ("integrator", 16),
        ("device_ordinal", 20),
        ("required_operator_mask", 24),
        ("resolved_device_operator_mask", 32),
        ("resolved_host_operator_mask", 40),
        ("resolved_unknown_operator_mask", 48),
        ("executed_device_operator_mask", 56),
        ("executed_host_operator_mask", 64),
        ("executed_unknown_operator_mask", 72),
        ("fallback_count", 80),
        ("accepted_step_count", 88),
        ("rejected_attempt_count", 96),
        ("failed_attempt_count", 104),
        ("hot_loop_compute_h2d_bytes", 112),
        ("hot_loop_compute_d2h_bytes", 120),
        ("hot_loop_compute_host_sync_count", 128),
        ("execution_kind", 136),
        ("relaxation_algorithm", 140),
        ("attempt_model", 144),
        ("control_policy", 148),
        ("execution_generation_id", 152),
        ("terminal_outcome", 160),
        ("compute_closed", 164),
        ("observation_closed", 168),
        ("reserved_terminal", 172),
        ("outer_attempt_count", 176),
        ("rejected_candidate_count", 184),
        ("failed_candidate_count", 192),
        ("stationary_observation_count", 200),
        ("cancelled_outer_attempt_count", 208),
        ("paused_outer_attempt_count", 216),
        ("refinement_evaluation_count", 224),
        ("allowed_transfer_mask", 232),
        ("observed_transfer_mask", 240),
        ("transfer_violation_mask", 248),
        ("setup_h2d_bytes", 256),
        ("setup_d2h_bytes", 264),
        ("setup_host_sync_count", 272),
        ("compute_h2d_bytes", 280),
        ("compute_d2h_bytes", 288),
        ("compute_host_sync_count", 296),
        ("control_h2d_bytes", 304),
        ("control_d2h_bytes", 312),
        ("control_host_sync_count", 320),
        ("exchange_h2d_bytes", 328),
        ("exchange_d2h_bytes", 336),
        ("exchange_host_sync_count", 344),
        ("snapshot_h2d_bytes", 352),
        ("snapshot_d2h_bytes", 360),
        ("snapshot_host_sync_count", 368),
        ("export_h2d_bytes", 376),
        ("export_d2h_bytes", 384),
        ("export_host_sync_count", 392),
        ("initial_residency", 400),
        ("final_residency", 404),
        ("residency_transition_count", 408),
        ("residency_violation_count", 416),
        ("kernel_launch_coverage_mask", 424),
        ("required_coverage_mask", 432),
        ("unclassified_event_count", 440),
        ("accounting_valid", 448),
        ("lifecycle_valid", 452),
        ("identity_valid", 456),
        ("reserved_valid", 460),
    ];
    generated.push_str(
        "const _: () = {\n    assert!(std::mem::size_of::<fullmag_fem_gpu_execution_receipt_v2>() == 464);\n    assert!(std::mem::align_of::<fullmag_fem_gpu_execution_receipt_v2>() == 8);\n",
    );
    for (field, offset) in RECEIPT_V2_FIELDS {
        generated.push_str(&format!(
            "    assert!(std::mem::offset_of!(fullmag_fem_gpu_execution_receipt_v2, {field}) == {offset});\n"
        ));
    }
    generated.push_str("};\n\n");

    const PERFORMANCE_V3_FIELDS: &[(&str, usize)] = &[
        ("abi_version", 0),
        ("struct_size", 4),
        ("setup_count", 8),
        ("apply_count", 16),
        ("kernel_launch_count", 24),
        ("compute_fence_count", 32),
        ("snapshot_fence_count", 40),
        ("export_fence_count", 48),
        ("selected_sparse_kernel_id", 56),
        ("setup_wall_time_ns", 64),
        ("apply_wall_time_ns", 72),
        ("accepted_finalization_wall_time_ns", 80),
        ("execution_kind", 88),
        ("relaxation_algorithm", 92),
        ("attempt_model", 96),
        ("control_policy", 100),
        ("terminal_outcome", 104),
        ("execution_class", 108),
        ("precision", 112),
        ("device_ordinal", 116),
        ("execution_generation_id", 120),
        ("available", 128),
        ("compute_closed", 132),
        ("observation_closed", 136),
        ("frozen", 140),
        ("accepted_step_count", 144),
        ("physical_outer_attempt_count", 152),
        ("rejected_candidate_count", 160),
        ("failed_candidate_count", 168),
        ("cancelled_outer_attempt_count", 176),
        ("paused_outer_attempt_count", 184),
        ("failed_outer_attempt_count", 192),
        ("stationary_observation_count", 200),
        ("refinement_evaluation_count", 208),
        ("physical_effective_field_applies", 216),
        ("physical_energy_evaluations", 224),
        ("physical_armijo_candidates", 232),
        ("physical_rhs_evaluations", 240),
        ("physical_exchange_applies", 248),
        ("physical_exchange_launches", 256),
        ("physical_exchange_nnz_visited", 264),
        ("physical_demag_solves", 272),
        ("physical_demag_iterations", 280),
        ("physical_normalization_launches", 288),
        ("physical_normalization_readbacks", 296),
        ("physical_adaptive_readbacks", 304),
        ("physical_control_fences", 312),
        ("physical_endpoint_cache_hits", 320),
        ("physical_endpoint_cache_misses", 328),
        ("physical_endpoint_cache_invalidations", 336),
        ("accepted_effective_field_applies", 344),
        ("accepted_energy_evaluations", 352),
        ("accepted_armijo_candidates", 360),
        ("accepted_rhs_evaluations", 368),
        ("accepted_exchange_applies", 376),
        ("accepted_exchange_launches", 384),
        ("accepted_exchange_nnz_visited", 392),
        ("accepted_demag_solves", 400),
        ("accepted_demag_iterations", 408),
        ("accepted_normalization_launches", 416),
        ("accepted_normalization_readbacks", 424),
        ("accepted_adaptive_readbacks", 432),
        ("accepted_control_fences", 440),
        ("accepted_endpoint_cache_hits", 448),
        ("accepted_endpoint_cache_misses", 456),
        ("accepted_endpoint_cache_invalidations", 464),
        ("physical_device_to_device_bytes", 472),
        ("accepted_device_to_device_bytes", 480),
        ("setup_h2d_bytes", 488),
        ("setup_d2h_bytes", 496),
        ("compute_h2d_bytes", 504),
        ("compute_d2h_bytes", 512),
        ("control_h2d_bytes", 520),
        ("control_d2h_bytes", 528),
        ("exchange_h2d_bytes", 536),
        ("exchange_d2h_bytes", 544),
        ("snapshot_h2d_bytes", 552),
        ("snapshot_d2h_bytes", 560),
        ("export_h2d_bytes", 568),
        ("export_d2h_bytes", 576),
        ("compute_host_sync_count", 584),
        ("control_host_sync_count", 592),
        ("exchange_host_sync_count", 600),
        ("snapshot_host_sync_count", 608),
        ("export_host_sync_count", 616),
        ("kernel_launch_coverage_mask", 624),
        ("required_coverage_mask", 632),
        ("unclassified_event_count", 640),
        ("initial_residency", 648),
        ("final_residency", 652),
        ("residency_transition_count", 656),
        ("residency_violation_count", 664),
        ("physical_exchange_elapsed_ns", 672),
        ("physical_demag_assemble_elapsed_ns", 680),
        ("physical_demag_recover_elapsed_ns", 688),
        ("physical_demag_energy_elapsed_ns", 696),
        ("physical_rhs_elapsed_ns", 704),
        ("accepted_exchange_elapsed_ns", 712),
        ("accepted_demag_assemble_elapsed_ns", 720),
        ("accepted_demag_recover_elapsed_ns", 728),
        ("accepted_demag_energy_elapsed_ns", 736),
        ("accepted_rhs_elapsed_ns", 744),
        ("gradient_wall_time_ns", 752),
        ("retraction_wall_time_ns", 760),
        ("line_search_wall_time_ns", 768),
        ("direction_update_wall_time_ns", 776),
        ("refinement_wall_time_ns", 784),
    ];
    generated.push_str(
        "const _: () = {\n    assert!(std::mem::size_of::<fullmag_fem_gpu_performance_snapshot_v3>() == 792);\n    assert!(std::mem::align_of::<fullmag_fem_gpu_performance_snapshot_v3>() == 8);\n",
    );
    for (field, offset) in PERFORMANCE_V3_FIELDS {
        generated.push_str(&format!(
            "    assert!(std::mem::offset_of!(fullmag_fem_gpu_performance_snapshot_v3, {field}) == {offset});\n"
        ));
    }
    generated.push_str("};\n");
    std::fs::write(
        out_dir.join("gpu_execution_receipt_abi_assertions.rs"),
        generated,
    )
    .expect("writing GPU execution receipt ABI assertions should succeed");
}

fn main() {
    let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    generate_gpu_execution_receipt_abi_assertions(&out_dir);
    println!("cargo:rerun-if-env-changed=FULLMAG_CUDA_ARCHITECTURES");
    if let Ok(lib_dir) = std::env::var("FULLMAG_FEM_LIB_DIR") {
        println!("cargo:rustc-link-search=native={}", lib_dir);
        println!("cargo:rustc-link-lib=dylib=fullmag_fem");
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib_dir);
        println!("cargo:rerun-if-env-changed=FULLMAG_FEM_LIB_DIR");
        return;
    }

    println!("cargo:rerun-if-changed=../../native/include/fullmag_fem.h");
    println!("cargo:rerun-if-changed=../../native/CMakeLists.txt");
    println!("cargo:rerun-if-changed=../../backends/fem/CMakeLists.txt");
    rerun_if_changed_tree("../../backends/fem/core");
    rerun_if_changed_tree("../../backends/fem/cpu");
    println!("cargo:rerun-if-changed=../../backends/fem/gpu");
    rerun_if_changed_tree("../../backends/fem/gpu");
    rerun_if_changed_tree("../../backends/fem/src");
    rerun_if_changed_tree("../../backends/fem/include");
    println!("cargo:rerun-if-env-changed=FULLMAG_FEM_LIB_DIR");
    println!("cargo:rerun-if-env-changed=FULLMAG_USE_MFEM_STACK");
    println!("cargo:rerun-if-env-changed=FULLMAG_FEM_REQUIRE_GPU");
    println!("cargo:rerun-if-env-changed=FULLMAG_FEM_WITH_SLEPC");
    println!("cargo:rerun-if-env-changed=FULLMAG_ENABLE_NVTX");

    if std::env::var_os("CARGO_FEATURE_BUILD_NATIVE").is_none() {
        return;
    }

    let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let native_root = manifest_dir.join("../../native");
    let build_dir = out_dir.join("native-build");

    std::fs::create_dir_all(&build_dir).expect("creating native build dir should succeed");

    let cmake = std::env::var("FULLMAG_CMAKE").unwrap_or_else(|_| "cmake".to_string());
    let cargo_profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());
    let cmake_build_type = if cargo_profile == "release" {
        "Release"
    } else {
        "Debug"
    };
    let use_mfem_stack = env_flag("FULLMAG_USE_MFEM_STACK");
    let require_gpu = env_flag("FULLMAG_FEM_REQUIRE_GPU");
    let enable_nvtx = env_flag("FULLMAG_ENABLE_NVTX");
    let with_slepc = std::env::var("FULLMAG_FEM_WITH_SLEPC").unwrap_or_else(|_| {
        if use_mfem_stack {
            "ON".to_string()
        } else {
            "OFF".to_string()
        }
    });
    if require_gpu && !use_mfem_stack {
        panic!(
            "FULLMAG_FEM_REQUIRE_GPU=1 but FULLMAG_USE_MFEM_STACK is OFF; set FULLMAG_USE_MFEM_STACK=ON or provide a prebuilt FEM GPU runtime via FULLMAG_FEM_LIB_DIR"
        );
    }
    let mut configure = std::process::Command::new(&cmake);
    configure
        .arg("-S")
        .arg(&native_root)
        .arg("-B")
        .arg(&build_dir)
        .arg(format!("-DCMAKE_BUILD_TYPE={}", cmake_build_type))
        .arg(format!(
            "-DFULLMAG_ENABLE_CUDA={}",
            if use_mfem_stack { "ON" } else { "OFF" }
        ))
        .arg("-DFULLMAG_ENABLE_FEM_GPU=ON")
        .arg(format!(
            "-DFULLMAG_USE_MFEM_STACK={}",
            if use_mfem_stack { "ON" } else { "OFF" }
        ))
        .arg(format!(
            "-DFULLMAG_ENABLE_NVTX={}",
            if enable_nvtx { "ON" } else { "OFF" }
        ))
        .arg(format!("-DFULLMAG_FEM_WITH_SLEPC={}", with_slepc));
    if let Ok(value) = std::env::var("FULLMAG_CUDA_ARCHITECTURES") {
        let value = value.trim();
        if !value.is_empty() {
            configure.arg(format!("-DCMAKE_CUDA_ARCHITECTURES={value}"));
        }
    }

    let configure_status = configure
        .status()
        .expect(
            "cmake not found; install cmake, set FULLMAG_CMAKE, or set FULLMAG_FEM_LIB_DIR to a prebuilt native backend",
        );
    if !configure_status.success() {
        panic!(
            "cmake configure for fullmag_fem failed{}",
            if use_mfem_stack {
                " (FULLMAG_USE_MFEM_STACK=ON; verify MFEM is installed and visible via CMAKE_PREFIX_PATH)"
            } else {
                ""
            }
        );
    }

    let mut build = std::process::Command::new(&cmake);
    build
        .arg("--build")
        .arg(&build_dir)
        .arg("--target")
        .arg("fullmag_fem");
    if let Ok(jobs) = std::env::var("NUM_JOBS") {
        if jobs.parse::<usize>().is_ok_and(|value| value > 0) {
            build.arg("--parallel").arg(jobs);
        }
    }
    let build_status = build
        .status()
        .expect("cmake build invocation failed; verify the native toolchain and FEM backend setup");
    if !build_status.success() {
        panic!("cmake build for fullmag_fem failed");
    }

    println!(
        "cargo:rustc-link-search=native={}",
        build_dir.join("backends/fem").display()
    );
    println!("cargo:rustc-link-lib=dylib=fullmag_fem");
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib");
    println!(
        "cargo:rustc-link-arg=-Wl,-rpath,{}",
        build_dir.join("backends/fem").display()
    );
}
