use std::{env, process::Command};

fn main() {
    println!("cargo:rerun-if-env-changed=RUSTC");

    let rustc = env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let output = Command::new(&rustc)
        .arg("--version")
        .output()
        .expect("fullmag-bench must be able to execute RUSTC --version");
    assert!(
        output.status.success(),
        "RUSTC --version failed with {}",
        output.status
    );
    let version = String::from_utf8(output.stdout)
        .expect("RUSTC --version must emit UTF-8")
        .trim()
        .to_string();
    assert!(
        !version.is_empty(),
        "RUSTC --version returned an empty value"
    );
    println!("cargo:rustc-env=FULLMAG_BENCH_RUSTC_VERSION={version}");

    let target = env::var("TARGET").expect("Cargo must provide TARGET to fullmag-bench/build.rs");
    println!("cargo:rustc-env=FULLMAG_BENCH_TARGET={target}");
}
