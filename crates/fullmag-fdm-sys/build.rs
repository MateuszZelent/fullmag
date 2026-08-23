fn main() {
    generate_plan_desc_layout_assertions();
    generate_execution_receipt_layout_assertions();

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
    println!("cargo:rerun-if-changed=../../backends/fdm/CMakeLists.txt");
    println!("cargo:rerun-if-changed=../../backends/fdm/api");
    println!("cargo:rerun-if-changed=../../backends/fdm/core");
    println!("cargo:rerun-if-changed=../../backends/fdm/cpu");
    println!("cargo:rerun-if-changed=../../backends/fdm/gpu/cuda");
    println!("cargo:rerun-if-changed=../../backends/fdm/include");
    println!("cargo:rerun-if-env-changed=FULLMAG_FDM_LIB_DIR");

    let build_native_cuda = std::env::var_os("CARGO_FEATURE_BUILD_NATIVE").is_some();
    let build_native_cpu = std::env::var_os("CARGO_FEATURE_BUILD_NATIVE_CPU").is_some();
    if !build_native_cuda && !build_native_cpu {
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
    if build_native_cuda {
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

fn generate_execution_receipt_layout_assertions() {
    let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let layout_manifest =
        manifest_dir.join("../../native/include/fullmag_fdm_execution_receipt_v1_layout.def");
    println!("cargo:rerun-if-changed={}", layout_manifest.display());
    let source = std::fs::read_to_string(&layout_manifest)
        .expect("reading execution receipt layout manifest should succeed");
    let mut assertions = String::new();
    let mut field_count = 0usize;
    let mut size_count = 0usize;
    for line in source.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let (macro_name, arguments) = line
            .split_once('(')
            .expect("receipt layout line must be a macro invocation");
        let arguments = arguments
            .strip_suffix(')')
            .expect("receipt layout invocation must end with ')'");
        match macro_name {
            "FULLMAG_FDM_EXECUTION_RECEIPT_FIELD" => {
                let parts = arguments.split(',').map(str::trim).collect::<Vec<_>>();
                assert_eq!(parts.len(), 3, "receipt field requires type, name, offset");
                field_count += 1;
                assertions.push_str(&format!(
                    "assert_eq!(std::mem::offset_of!(fullmag_fdm_execution_receipt_v1, {}), {}, \"unexpected receipt offset for {}\");\n",
                    parts[1], parts[2], parts[1]
                ));
            }
            "FULLMAG_FDM_EXECUTION_RECEIPT_SIZE" => {
                size_count += 1;
                assertions.push_str(&format!(
                    "assert_eq!(std::mem::size_of::<fullmag_fdm_execution_receipt_v1>(), {}, \"unexpected receipt size\");\n",
                    arguments.trim()
                ));
            }
            other => panic!("unknown receipt layout macro: {other}"),
        }
    }
    assert_eq!(field_count, 32, "receipt layout field count drift");
    assert_eq!(size_count, 1, "receipt layout size declaration drift");
    let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    std::fs::write(
        out_dir.join("execution_receipt_v1_layout_assertions.rs"),
        format!("{{\n{assertions}}}\n"),
    )
    .expect("writing generated execution receipt layout assertions should succeed");
}

fn generate_plan_desc_layout_assertions() {
    let manifest_dir = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let layout_manifest =
        manifest_dir.join("../../native/include/fullmag_fdm_plan_desc_v2_layout.def");
    println!("cargo:rerun-if-changed={}", layout_manifest.display());
    let source = std::fs::read_to_string(&layout_manifest)
        .expect("reading fullmag_fdm_plan_desc_v2 layout manifest should succeed");

    let mut assertions = String::new();
    let mut header_fields = 0usize;
    let mut aggregate_fields = 0usize;
    let mut base_fields = 0usize;
    let mut grid_fields = 0usize;
    let mut material_fields = 0usize;
    let mut time_fields = 0usize;
    for line in source.lines().map(str::trim) {
        if line.is_empty() || line.starts_with("/*") {
            continue;
        }
        let (macro_name, arguments) = line
            .split_once('(')
            .expect("layout manifest line must be a macro invocation");
        let arguments = arguments
            .strip_suffix(')')
            .expect("layout manifest macro invocation must end with ')'");
        let (field, expected) = arguments
            .split_once(',')
            .expect("layout manifest macro must contain field and offset");
        let field = field.trim();
        let expected = expected.trim();
        let (label, offset_expression) = match macro_name {
            "FULLMAG_FDM_PLAN_V2_HEADER_FIELD" => {
                header_fields += 1;
                (
                    field.to_string(),
                    format!("std::mem::offset_of!(fullmag_fdm_plan_desc_v2, {field})"),
                )
            }
            "FULLMAG_FDM_PLAN_V2_AGGREGATE_FIELD" => {
                aggregate_fields += 1;
                (
                    field.to_string(),
                    format!("std::mem::offset_of!(fullmag_fdm_plan_desc_v2, {field})"),
                )
            }
            "FULLMAG_FDM_PLAN_V2_BASE_FIELD" => {
                base_fields += 1;
                (
                    format!("base.{field}"),
                    format!(
                    "std::mem::offset_of!(fullmag_fdm_plan_desc_v2, base) + std::mem::offset_of!(fullmag_fdm_plan_desc, {field})"
                    ),
                )
            }
            "FULLMAG_FDM_PLAN_V2_GRID_FIELD" => {
                grid_fields += 1;
                (
                    format!("base.grid.{field}"),
                    format!(
                    "std::mem::offset_of!(fullmag_fdm_plan_desc_v2, base) + std::mem::offset_of!(fullmag_fdm_plan_desc, grid) + std::mem::offset_of!(fullmag_fdm_grid_desc, {field})"
                    ),
                )
            }
            "FULLMAG_FDM_PLAN_V2_MATERIAL_FIELD" => {
                material_fields += 1;
                (
                    format!("base.material.{field}"),
                    format!(
                    "std::mem::offset_of!(fullmag_fdm_plan_desc_v2, base) + std::mem::offset_of!(fullmag_fdm_plan_desc, material) + std::mem::offset_of!(fullmag_fdm_material_desc, {field})"
                    ),
                )
            }
            "FULLMAG_FDM_PLAN_V2_TIME_FIELD" => {
                time_fields += 1;
                (
                    format!("time_policy.{field}"),
                    format!(
                    "std::mem::offset_of!(fullmag_fdm_plan_desc_v2, time_policy) + std::mem::offset_of!(fullmag_fdm_time_policy_desc_v2, {field})"
                    ),
                )
            }
            other => panic!("unknown layout manifest macro: {other}"),
        };
        assertions.push_str(&format!(
            "assert_eq!({offset_expression}, {expected}, \"unexpected offset for {label}\");\n"
        ));
    }
    assert_eq!(header_fields, 2, "v2 layout manifest header field count drift");
    assert_eq!(aggregate_fields, 2, "v2 layout manifest aggregate field count drift");
    assert_eq!(base_fields, 140, "base plan descriptor field count drift");
    assert_eq!(grid_fields, 6, "grid descriptor field count drift");
    assert_eq!(material_fields, 4, "material descriptor field count drift");
    assert_eq!(time_fields, 13, "time policy descriptor field count drift");

    let generated = format!("{{\n{assertions}}}\n");
    let out_dir = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    std::fs::write(out_dir.join("plan_desc_v2_layout_assertions.rs"), generated)
        .expect("writing generated plan descriptor layout assertions should succeed");
}
