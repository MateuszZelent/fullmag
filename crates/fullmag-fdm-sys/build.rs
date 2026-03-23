//! Build script for fullmag-fdm-sys.
//!
//! Phase 2 integration:
//! - When CUDA is available, this will invoke cmake to build native/backends/fdm
//!   and link libfullmag_fdm.so.
//! - When CUDA is unavailable, the crate still compiles but the `is_available`
//!   function returns false at runtime.
//!
//! For now: emit cargo directives so downstream crates know the expected link name.

fn main() {
    // Check if a prebuilt library path is provided via environment
    if let Ok(lib_dir) = std::env::var("FULLMAG_FDM_LIB_DIR") {
        println!("cargo:rustc-link-search=native={}", lib_dir);
        println!("cargo:rustc-link-lib=dylib=fullmag_fdm");
    }

    // Always re-run if the header changes
    println!("cargo:rerun-if-changed=../../native/include/fullmag_fdm.h");
    println!("cargo:rerun-if-env-changed=FULLMAG_FDM_LIB_DIR");
}
