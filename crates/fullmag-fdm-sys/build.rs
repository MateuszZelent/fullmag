fn main() {
    if let Ok(lib_dir) = std::env::var("FULLMAG_FDM_LIB_DIR") {
        println!("cargo:rustc-link-search=native={}", lib_dir);
        println!("cargo:rustc-link-lib=dylib=fullmag_fdm");
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

    let configure_status = std::process::Command::new("cmake")
        .arg("-S")
        .arg(&native_root)
        .arg("-B")
        .arg(&build_dir)
        .arg("-DFULLMAG_ENABLE_CUDA=ON")
        .status()
        .expect("cmake not found; install cmake or set FULLMAG_FDM_LIB_DIR to a prebuilt native backend");
    if !configure_status.success() {
        panic!("cmake configure for fullmag_fdm failed");
    }

    let build_status = std::process::Command::new("cmake")
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
}
