#![cfg(not(feature = "parallel"))]

use std::{
    alloc::{GlobalAlloc, Layout, System},
    hint::black_box,
    mem::size_of,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::{Duration, Instant},
};

use fullmag_engine::{
    fdm::cpu::fft_backend::FdmFftBackend, AxisBoundary, FdmBoundaryPolicy, FftWorkspace,
    VectorFieldSoA,
};
use fullmag_fdm_demag::newell::{compute_newell_kernels, NewellKernels};
use serde_json::json;

struct ProcessAllocationCounter;

static COUNT_ALLOCATIONS: AtomicBool = AtomicBool::new(false);
static ALLOCATION_COUNT: AtomicUsize = AtomicUsize::new(0);

#[global_allocator]
static ALLOCATOR: ProcessAllocationCounter = ProcessAllocationCounter;

fn record_allocation() {
    if COUNT_ALLOCATIONS.load(Ordering::SeqCst) {
        ALLOCATION_COUNT.fetch_add(1, Ordering::SeqCst);
    }
}

unsafe impl GlobalAlloc for ProcessAllocationCounter {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record_allocation();
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record_allocation();
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        record_allocation();
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

fn measured_allocations<T>(operation: impl FnOnce() -> T) -> (T, usize) {
    ALLOCATION_COUNT.store(0, Ordering::SeqCst);
    COUNT_ALLOCATIONS.store(true, Ordering::SeqCst);
    let result = operation();
    COUNT_ALLOCATIONS.store(false, Ordering::SeqCst);
    (result, ALLOCATION_COUNT.load(Ordering::SeqCst))
}

fn physical_index(shape: [usize; 3], x: usize, y: usize, z: usize) -> usize {
    x + shape[0] * (y + shape[1] * z)
}

fn direct_demag(
    shape: [usize; 3],
    kernels: &NewellKernels,
    magnetization: &VectorFieldSoA,
    saturation_magnetisation: f64,
    output: &mut VectorFieldSoA,
) {
    output.x.fill(0.0);
    output.y.fill(0.0);
    output.z.fill(0.0);
    for destination_z in 0..shape[2] {
        for destination_y in 0..shape[1] {
            for destination_x in 0..shape[0] {
                let destination =
                    physical_index(shape, destination_x, destination_y, destination_z);
                for source_z in 0..shape[2] {
                    for source_y in 0..shape[1] {
                        for source_x in 0..shape[0] {
                            let source = physical_index(shape, source_x, source_y, source_z);
                            let displacement_x =
                                (destination_x + kernels.px - source_x) % kernels.px;
                            let displacement_y =
                                (destination_y + kernels.py - source_y) % kernels.py;
                            let displacement_z =
                                (destination_z + kernels.pz - source_z) % kernels.pz;
                            let kernel = displacement_x
                                + kernels.px * (displacement_y + kernels.py * displacement_z);
                            let mx = magnetization.x[source] * saturation_magnetisation;
                            let my = magnetization.y[source] * saturation_magnetisation;
                            let mz = magnetization.z[source] * saturation_magnetisation;
                            output.x[destination] -= kernels.n_xx[kernel] * mx
                                + kernels.n_xy[kernel] * my
                                + kernels.n_xz[kernel] * mz;
                            output.y[destination] -= kernels.n_xy[kernel] * mx
                                + kernels.n_yy[kernel] * my
                                + kernels.n_yz[kernel] * mz;
                            output.z[destination] -= kernels.n_xz[kernel] * mx
                                + kernels.n_yz[kernel] * my
                                + kernels.n_zz[kernel] * mz;
                        }
                    }
                }
            }
        }
    }
}

fn assert_field_close(actual: &VectorFieldSoA, expected: &VectorFieldSoA, tolerance: f64) {
    for (component, (actual_values, expected_values)) in [
        ("x", (&actual.x, &expected.x)),
        ("y", (&actual.y, &expected.y)),
        ("z", (&actual.z, &expected.z)),
    ] {
        for (index, (actual_value, expected_value)) in
            actual_values.iter().zip(expected_values).enumerate()
        {
            let error = (actual_value - expected_value).abs();
            let scale = expected_value.abs().max(1.0);
            assert!(
                error <= tolerance * scale,
                "component={component} index={index} actual={actual_value} expected={expected_value} error={error}"
            );
        }
    }
}

fn benchmark_operation(repeats: usize, mut operation: impl FnMut()) -> Duration {
    operation();
    let started = Instant::now();
    for _ in 0..repeats {
        black_box(operation());
    }
    started.elapsed()
}

#[test]
fn rustfft_r2c_demag_reuses_preallocated_workspace_after_warmup() {
    let shape = [4, 3, 2];
    let cell_count = shape.iter().product();
    let mut workspace = FftWorkspace::new(shape[0], shape[1], shape[2], 1.0, 1.0, 1.0);
    let baseline_key = workspace.telemetry().lifecycle_key_sha256;
    let identical_key = FftWorkspace::new(4, 3, 2, 1.0, 1.0, 1.0)
        .telemetry()
        .lifecycle_key_sha256;
    let resized_key = FftWorkspace::new(5, 3, 2, 1.0, 1.0, 1.0)
        .telemetry()
        .lifecycle_key_sha256;
    let periodic_key = FftWorkspace::new_with_boundary(
        4,
        3,
        2,
        1.0,
        1.0,
        1.0,
        &FdmBoundaryPolicy {
            x: AxisBoundary::Periodic,
            y: AxisBoundary::Open,
            z: AxisBoundary::Open,
        },
        [0, 0, 0],
    )
    .telemetry()
    .lifecycle_key_sha256;
    assert_eq!(baseline_key, identical_key);
    assert_ne!(baseline_key, resized_key);
    assert_ne!(baseline_key, periodic_key);

    let mut magnetization = VectorFieldSoA::zeros(cell_count);
    magnetization.x.fill(1.0);
    let mut warm_output = VectorFieldSoA::zeros(cell_count);

    workspace.convolve_demag(&magnetization, 1.0, None, &mut warm_output);

    let mut measured_output = VectorFieldSoA::zeros(cell_count);
    let ((), allocations) = measured_allocations(|| {
        workspace.convolve_demag(&magnetization, 1.0, None, &mut measured_output);
    });

    assert_eq!(allocations, 0, "steady-state RustFFT demag allocated");
    assert_eq!(measured_output, warm_output);

    let kernels = compute_newell_kernels(shape[0], shape[1], shape[2], 1.0, 1.0, 1.0);
    let mut direct_output = VectorFieldSoA::zeros(cell_count);
    direct_demag(shape, &kernels, &magnetization, 1.0, &mut direct_output);
    assert_field_close(&measured_output, &direct_output, 2e-12);

    let telemetry = workspace.telemetry();
    assert_eq!(telemetry.lifecycle_revision, 1);
    assert_eq!(telemetry.lifecycle_key_sha256.len(), "sha256:".len() + 64);
    assert_eq!(telemetry.execution_thread_count, 1);
    assert!(telemetry.plan_creation_time_ns > 0);
    assert!(telemetry.workspace_bytes > 0);
    let padded_cells = (shape[0] * 2) * (shape[1] * 2) * (shape[2] * 2);
    let full_complex_bytes = padded_cells * 12 * size_of::<rustfft::num_complex::Complex<f64>>();
    assert!(
        telemetry.workspace_bytes < full_complex_bytes as u64,
        "half-spectrum workspace did not reduce owned bytes: {} >= {full_complex_bytes}",
        telemetry.workspace_bytes
    );
    assert_eq!(telemetry.forward_fft_count, 6);
    assert_eq!(telemetry.inverse_fft_count, 6);
    assert!(telemetry.fft_elapsed_time_ns > 0);
}

#[test]
#[ignore = "release-only break-even benchmark; run explicitly with --ignored --exact"]
fn rustfft_r2c_demag_reports_direct_convolution_break_even() {
    let commit = std::env::var("FULLMAG_BENCH_COMMIT").unwrap_or_else(|_| "unrecorded".into());
    let build_identity =
        std::env::var("FULLMAG_BENCH_BUILD_ID").unwrap_or_else(|_| "unrecorded".into());
    let cases = [
        ([2, 2, 1], 2_000),
        ([4, 4, 1], 500),
        ([8, 8, 1], 100),
        ([16, 16, 1], 10),
        ([32, 32, 1], 2),
    ];
    let mut break_even_cells = None;

    for (shape, repeats) in cases {
        let cell_count = shape.iter().product();
        let mut magnetization = VectorFieldSoA::zeros(cell_count);
        for index in 0..cell_count {
            let value = index as f64;
            magnetization.x[index] = (0.17 * value).sin();
            magnetization.y[index] = (0.11 * value).cos();
            magnetization.z[index] = (0.07 * value).sin();
        }
        let kernels = compute_newell_kernels(shape[0], shape[1], shape[2], 1.0, 1.0, 1.0);
        let mut workspace = FftWorkspace::new(shape[0], shape[1], shape[2], 1.0, 1.0, 1.0);
        let mut fft_output = VectorFieldSoA::zeros(cell_count);
        let mut direct_output = VectorFieldSoA::zeros(cell_count);

        workspace.convolve_demag(&magnetization, 1.0, None, &mut fft_output);
        direct_demag(shape, &kernels, &magnetization, 1.0, &mut direct_output);
        assert_field_close(&fft_output, &direct_output, 2e-11);

        let fft_elapsed = benchmark_operation(repeats, || {
            fft_output.x.fill(0.0);
            fft_output.y.fill(0.0);
            fft_output.z.fill(0.0);
            workspace.convolve_demag(&magnetization, 1.0, None, &mut fft_output);
        });
        let direct_elapsed = benchmark_operation(repeats, || {
            direct_demag(shape, &kernels, &magnetization, 1.0, &mut direct_output);
        });
        let fft_ns = fft_elapsed.as_nanos() / repeats as u128;
        let direct_ns = direct_elapsed.as_nanos() / repeats as u128;
        if break_even_cells.is_none() && fft_ns < direct_ns {
            break_even_cells = Some(cell_count);
        }
        println!(
            "{}",
            json!({
                "schema": "fullmag.fdm.cpu_fft_break_even.v2",
                "commit": commit,
                "build_identity": build_identity,
                "requested_backend": "rustfft",
                "resolved_backend": "rustfft",
                "executed_backend": "rustfft",
                "plan_mode": "realfft_r2c_planner_cached",
                "workspace_layout": "half_spectrum_r2c",
                "precision": "double",
                "device": "cpu",
                "interaction_realization": "newell_demag",
                "grid": shape,
                "cells": cell_count,
                "repeats": repeats,
                "fft_operator_evaluations": repeats,
                "direct_operator_evaluations": repeats,
                "fft_mean_ns": fft_ns,
                "direct_mean_ns": direct_ns,
                "relative_tolerance": 2e-11,
                "accepted_attempts": null,
                "rejected_attempts": null,
                "stop_reason": "benchmark_completed"
            })
        );
    }

    println!(
        "{}",
        json!({
            "schema": "fullmag.fdm.cpu_fft_break_even.v2",
            "commit": commit,
            "build_identity": build_identity,
            "break_even_cells": break_even_cells,
            "stop_reason": "benchmark_completed"
        })
    );
}
