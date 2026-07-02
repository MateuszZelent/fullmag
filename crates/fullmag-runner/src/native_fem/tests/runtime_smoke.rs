use super::*;

#[test]
fn native_fem_scaffold_exposes_initial_state_fields() {
    let plan = make_test_plan();
    let backend = match NativeFemBackend::create(&plan) {
        Ok(backend) => backend,
        Err(err) => {
            if !is_gpu_available() {
                assert!(
                    err.message.contains("MFEM") || err.message.contains("scaffold"),
                    "unexpected unavailable create message: {}",
                    err.message
                );
                return;
            }
            if is_gpu_available() && err.message.contains("FDM backend") {
                eprintln!("skipping native FEM demag bootstrap test: {}", err.message);
                return;
            }
            panic!("native fem scaffold create: {}", err.message);
        }
    };

    let m = backend.copy_m(plan.mesh.nodes.len()).expect("copy m");
    let h_ex = backend.copy_h_ex(plan.mesh.nodes.len()).expect("copy H_ex");
    let h_demag = backend
        .copy_h_demag(plan.mesh.nodes.len())
        .expect("copy H_demag");
    let h_ext = backend
        .copy_h_ext(plan.mesh.nodes.len())
        .expect("copy H_ext");
    let h_eff = backend
        .copy_h_eff(plan.mesh.nodes.len())
        .expect("copy H_eff");
    let info = backend.device_info().expect("device info");

    assert_eq!(m, plan.initial_magnetization);
    assert!(h_ext.iter().all(|v| *v == [1.0, 2.0, 3.0]));
    if !is_gpu_available() {
        assert!(h_ex.iter().all(|v| *v == [0.0, 0.0, 0.0]));
        assert!(h_demag.iter().all(|v| *v == [0.0, 0.0, 0.0]));
        assert_eq!(h_eff, h_ext);
        assert!(
            info.name == "native_fem_scaffold" || info.name.starts_with("mfem_"),
            "unexpected device info name: {}",
            info.name
        );
    } else {
        for index in 0..h_eff.len() {
            for component in 0..3 {
                assert_scalar_close(
                    &format!("H_eff init relation [{}][{}]", index, component),
                    h_eff[index][component],
                    h_ex[index][component] + h_demag[index][component] + h_ext[index][component],
                    5e-8,
                    1e-9,
                );
            }
        }
        assert!(
            info.name.starts_with("mfem_")
                || info.name.contains("NVIDIA")
                || info.name.contains("GeForce")
                || info.name.contains("RTX"),
            "unexpected native FEM device info name: {}",
            info.name
        );
    }
}

#[test]
fn native_fem_scaffold_step_is_honestly_unavailable() {
    let plan = make_test_plan();
    let availability = native_availability();
    let mut backend = match NativeFemBackend::create(&plan) {
        Ok(backend) => backend,
        Err(err) => {
            if !availability.native_fem_cpu_available && !availability.native_fem_gpu_available {
                assert!(
                    err.message.contains("MFEM") || err.message.contains("scaffold"),
                    "unexpected unavailable create message: {}",
                    err.message
                );
                return;
            }
            if is_gpu_available() && err.message.contains("FDM backend") {
                eprintln!(
                    "skipping native FEM demag bootstrap step test: {}",
                    err.message
                );
                return;
            }
            panic!("native fem scaffold create: {}", err.message);
        }
    };
    if !availability.native_fem_cpu_available && !availability.native_fem_gpu_available {
        let err = backend.step(1e-13).expect_err("step should be unavailable");
        assert!(
            err.message.contains("MFEM")
                || err.message.contains("scaffold")
                || err.message.contains("demag"),
            "unexpected unavailable message: {}",
            err.message
        );
    } else {
        backend.step(1e-13).expect("native fem step");
    }
}

#[test]
fn native_fem_single_precision_rejection_is_cpu_specific() {
    let mut plan = make_exchange_only_plan();
    plan.precision = ExecutionPrecision::Single;
    plan.mfem_device_string = Some("cpu".to_string());

    let err = match NativeFemBackend::create(&plan) {
        Ok(_) => panic!("CPU single precision should fail"),
        Err(err) => err,
    };
    assert!(err.message.contains("CPU FEM backend"));
    assert!(err.message.contains("double precision"));
}

#[test]
fn native_fem_single_precision_rejection_treats_cpu_mfem_variants_as_cpu() {
    let mut plan = make_exchange_only_plan();
    plan.precision = ExecutionPrecision::Single;
    plan.mfem_device_string = Some("ceed-cpu".to_string());

    let err = match NativeFemBackend::create(&plan) {
        Ok(_) => panic!("CPU libCEED single precision should fail"),
        Err(err) => err,
    };
    assert!(err.message.contains("CPU FEM backend"));
    assert!(err.message.contains("double precision"));
}

#[test]
fn native_fem_single_precision_rejection_is_gpu_specific() {
    let mut plan = make_exchange_only_plan();
    plan.precision = ExecutionPrecision::Single;
    plan.mfem_device_string = Some("cuda".to_string());

    let err = match NativeFemBackend::create(&plan) {
        Ok(_) => panic!("GPU single precision should fail"),
        Err(err) => err,
    };
    assert!(err.message.contains("GPU backend"));
    assert!(err.message.contains("single-precision CUDA kernels"));
}

#[test]
fn native_fem_mfem_cpu_device_strings_do_not_request_gpu_demag() {
    let mut plan = make_test_plan();
    plan.enable_demag = true;

    for device in [
        "cpu", "omp", "ceed-cpu", "ceed/cpu", "ceed-omp", "ceed/omp", "raja-omp",
    ] {
        plan.mfem_device_string = Some(device.to_string());
        assert_eq!(
            native_fem_gpu_demag_mode(&plan),
            ffi::fullmag_fem_gpu_demag_mode::FULLMAG_FEM_GPU_DEMAG_UNSPECIFIED as i32,
            "MFEM device string {device:?} must not request strict GPU demag"
        );
    }
}
