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

fn main() {
    if let Ok(lib_dir) = std::env::var("FULLMAG_FEM_LIB_DIR") {
        println!("cargo:rustc-link-search=native={}", lib_dir);
        println!("cargo:rustc-link-lib=dylib=fullmag_fem");
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib_dir);
        println!("cargo:rerun-if-env-changed=FULLMAG_FEM_LIB_DIR");
        return;
    }

    println!("cargo:rerun-if-changed=../../native/include/fullmag_fem.h");
    println!("cargo:rerun-if-changed=../../native/CMakeLists.txt");
    println!("cargo:rerun-if-changed=../../native/backends/fem/CMakeLists.txt");
    println!("cargo:rerun-if-changed=../../native/backends/fem/src");
    println!("cargo:rerun-if-changed=../../native/backends/fem/include");
    println!("cargo:rerun-if-env-changed=FULLMAG_FEM_LIB_DIR");
    println!("cargo:rerun-if-env-changed=FULLMAG_USE_MFEM_STACK");

    if std::env::var_os("CARGO_FEATURE_BUILD_NATIVE").is_none() {
        return;
    }

    let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let native_root = manifest_dir.join("../../native");
    let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let build_dir = out_dir.join("native-build");

    std::fs::create_dir_all(&build_dir).expect("creating native build dir should succeed");

    let cmake = std::env::var("FULLMAG_CMAKE").unwrap_or_else(|_| "cmake".to_string());
    let use_mfem_stack = env_flag("FULLMAG_USE_MFEM_STACK");
    let external_fdm_lib_dir = std::env::var("DEP_FULLMAG_FDM_LIB_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::env::var("FULLMAG_FDM_LIB_DIR").ok())
        .filter(|value| !value.trim().is_empty());

    let mut configure = std::process::Command::new(&cmake);
    configure
        .arg("-S")
        .arg(&native_root)
        .arg("-B")
        .arg(&build_dir)
        .arg(format!(
            "-DFULLMAG_ENABLE_CUDA={}",
            if use_mfem_stack { "ON" } else { "OFF" }
        ))
        .arg("-DFULLMAG_ENABLE_FEM_GPU=ON")
        .arg(format!(
            "-DFULLMAG_USE_MFEM_STACK={}",
            if use_mfem_stack { "ON" } else { "OFF" }
        ));
    if let Some(ref lib_dir) = external_fdm_lib_dir {
        configure.arg(format!("-DFULLMAG_EXTERNAL_FDM_LIB_DIR={}", lib_dir));
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

    let build_status = std::process::Command::new(&cmake)
        .arg("--build")
        .arg(&build_dir)
        .arg("--target")
        .arg("fullmag_fem")
        .status()
        .expect("cmake build invocation failed; verify the native toolchain and FEM backend setup");
    if !build_status.success() {
        panic!("cmake build for fullmag_fem failed");
    }

    println!(
        "cargo:rustc-link-search=native={}",
        build_dir.join("backends/fem").display()
    );
    if let Some(ref lib_dir) = external_fdm_lib_dir {
        println!("cargo:rustc-link-search=native={}", lib_dir);
    } else {
        println!(
            "cargo:rustc-link-search=native={}",
            build_dir.join("backends/fdm").display()
        );
    }
    println!("cargo:rustc-link-lib=dylib=fullmag_fem");
    if use_mfem_stack {
        println!("cargo:rustc-link-lib=dylib=fullmag_fdm");
    }
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib");
    println!(
        "cargo:rustc-link-arg=-Wl,-rpath,{}",
        build_dir.join("backends/fem").display()
    );
    if let Some(ref lib_dir) = external_fdm_lib_dir {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib_dir);
    } else {
        println!(
            "cargo:rustc-link-arg=-Wl,-rpath,{}",
            build_dir.join("backends/fdm").display()
        );
    }
}
