fn main() {
    if let Ok(lib_dir) = std::env::var("FULLMAG_FDM_LIB_DIR") {
        println!("cargo:rustc-link-search=native={}", lib_dir);
        println!("cargo:rustc-link-lib=dylib=fullmag_fdm");
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib_dir);
        println!("cargo:metadata=lib_dir={}", lib_dir);
        println!("cargo:rerun-if-env-changed=FULLMAG_FDM_LIB_DIR");
        return;
    }

    println!("cargo:rerun-if-changed=../../native/include/fullmag_fdm.h");
    println!("cargo:rerun-if-changed=../../native/CMakeLists.txt");
    println!("cargo:rerun-if-changed=../../native/backends/fdm/CMakeLists.txt");
    println!("cargo:rerun-if-changed=../../native/backends/fdm/src");
    println!("cargo:rerun-if-changed=../../native/backends/fdm/include");
    println!("cargo:rerun-if-env-changed=FULLMAG_FDM_LIB_DIR");

    if std::env::var_os("CARGO_FEATURE_BUILD_NATIVE").is_none() {
        return;
    }

    let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let native_root = manifest_dir.join("../../native");
    let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let build_dir = out_dir.join("native-build");

    std::fs::create_dir_all(&build_dir).expect("creating native build dir should succeed");

    let cmake = std::env::var("FULLMAG_CMAKE").unwrap_or_else(|_| "cmake".to_string());
    let mut configure = std::process::Command::new(&cmake);
    let mut enable_cuda = false;
    if let Ok(cudacxx) = std::env::var("CUDACXX") {
        if !cudacxx.trim().is_empty() {
            configure.env("CUDACXX", &cudacxx);
            enable_cuda = true;
        }
    } else if std::path::Path::new("/usr/local/cuda/bin/nvcc").exists() {
        configure.env("CUDACXX", "/usr/local/cuda/bin/nvcc");
        configure.env("CUDAToolkit_ROOT", "/usr/local/cuda");
        enable_cuda = true;
    }

    let configure_status = configure
        .arg("-S")
        .arg(&native_root)
        .arg("-B")
        .arg(&build_dir)
        .arg(format!(
            "-DFULLMAG_ENABLE_CUDA={}",
            if enable_cuda { "ON" } else { "OFF" }
        ))
        .status()
        .expect("cmake not found; install cmake, set FULLMAG_CMAKE, or set FULLMAG_FDM_LIB_DIR to a prebuilt native backend");
    if !configure_status.success() {
        panic!("cmake configure for fullmag_fdm failed");
    }

    let build_status = std::process::Command::new(&cmake)
        .arg("--build")
        .arg(&build_dir)
        .arg("--target")
        .arg("fullmag_fdm")
        .status()
        .expect("cmake build invocation failed; verify the native toolchain and CUDA setup");
    if !build_status.success() {
        panic!("cmake build for fullmag_fdm failed");
    }

    println!(
        "cargo:rustc-link-search=native={}",
        build_dir.join("backends/fdm").display()
    );
    println!("cargo:rustc-link-lib=dylib=fullmag_fdm");
    println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN/../lib");
    println!(
        "cargo:metadata=lib_dir={}",
        build_dir.join("backends/fdm").display()
    );
}
