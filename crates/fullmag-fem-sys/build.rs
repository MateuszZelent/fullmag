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

fn main() {
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
    let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
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
