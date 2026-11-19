use std::f64::consts::{PI, TAU};

use fullmag_fdm_demag::{
    cell_pair_tensor, try_compute_periodic_xy_kernel, KernelBuildError, TensorDemagKernel,
};
use rustfft::num_complex::Complex;

fn spectra(kernel: &TensorDemagKernel) -> [&[Complex<f64>]; 6] {
    [
        &kernel.k_xx,
        &kernel.k_yy,
        &kernel.k_zz,
        &kernel.k_xy,
        &kernel.k_xz,
        &kernel.k_yz,
    ]
}

fn inverse_at(kernel: &TensorDemagKernel, lag: [usize; 3]) -> [f64; 6] {
    let [nx, ny, nz] = kernel.fft_shape;
    spectra(kernel).map(|spectrum| {
        let mut sum = Complex::new(0.0, 0.0);
        for kz in 0..nz {
            for ky in 0..ny {
                for kx in 0..nx {
                    let phase = TAU
                        * ((kx * lag[0]) as f64 / nx as f64
                            + (ky * lag[1]) as f64 / ny as f64
                            + (kz * lag[2]) as f64 / nz as f64);
                    sum += spectrum[kx + nx * (ky + ny * kz)] * Complex::from_polar(1.0, phase);
                }
            }
        }
        assert!(sum.im.abs() < 1e-11);
        sum.re / kernel.len() as f64
    })
}

fn centered_lag_representatives(index: usize, n: usize) -> Vec<isize> {
    let positive = index as isize;
    let negative = positive - n as isize;
    match index.cmp(&(n - index)) {
        std::cmp::Ordering::Less => vec![positive],
        std::cmp::Ordering::Greater => vec![negative],
        std::cmp::Ordering::Equal => vec![positive, negative],
    }
}

// The oracle enumerates both representatives of a Nyquist lag and uses
// the exact double-volume corner integral for each signed image pair.
fn direct_image_sum(
    index: [usize; 3],
    cells: [usize; 3],
    cell_size: [f64; 3],
    z_shift: f64,
    images: [u32; 2],
) -> [f64; 6] {
    let [nx, ny, nz] = cells.map(|n| n as isize);
    let [x, y, z] = index.map(|n| n as isize);
    let mut sum = [0.0; 6];
    if z == nz {
        return sum;
    }
    let z_lag = if z < nz { z } else { z - 2 * nz };
    let xs = centered_lag_representatives(x as usize, nx as usize);
    let ys = centered_lag_representatives(y as usize, ny as usize);
    let [images_x, images_y] = images.map(|n| n as isize);
    let weight = 1.0 / (xs.len() * ys.len()) as f64;
    for x_lag in xs {
        for &y_lag in &ys {
            for iy in -images_y..=images_y {
                for ix in -images_x..=images_x {
                    let displacement = [
                        (x_lag + ix * nx) as f64 * cell_size[0],
                        (y_lag + iy * ny) as f64 * cell_size[1],
                        z_lag as f64 * cell_size[2] + z_shift,
                    ];
                    // Reflect each pair before evaluating its 64 corners. The
                    // signed logarithms can lose precision at negative lags.
                    let pair =
                        cell_pair_tensor(cell_size, cell_size, displacement.map(f64::abs)).unwrap();
                    let [sx, sy, sz] = displacement.map(|coordinate| {
                        if coordinate == 0.0 {
                            0.0
                        } else {
                            coordinate.signum()
                        }
                    });
                    let parity = [1.0, 1.0, 1.0, sx * sy, sx * sz, sy * sz];
                    for ((total, (_, value)), sign) in
                        sum.iter_mut().zip(pair.components()).zip(parity)
                    {
                        *total += weight * sign * value;
                    }
                }
            }
        }
    }
    sum
}

#[test]
fn periodic_self_and_shifted_tensors_match_direct_image_sums() {
    let cell_size = [2.0e-9, 3.0e-9, 1.5e-9];
    for (cells, z_shift, images) in [
        ([4, 3, 2], 0.0, [1, 2]),
        ([3, 4, 2], 4.25e-9, [2, 1]),
        ([4, 4, 1], -2.7e-9, [0, 1]),
    ] {
        let [nx, ny, nz] = cells;
        let kernel = try_compute_periodic_xy_kernel(cells, cell_size, z_shift, images).unwrap();
        assert_eq!(kernel.fft_shape, [nx, ny, 2 * nz]);
        for z in 0..2 * nz {
            for y in 0..ny {
                for x in 0..nx {
                    let index = [x, y, z];
                    let expected = direct_image_sum(index, cells, cell_size, z_shift, images);
                    let actual = inverse_at(&kernel, index);
                    for (component, (got, want)) in actual.into_iter().zip(expected).enumerate() {
                        assert!(
                            (got - want).abs() < 5e-12,
                            "cells {cells:?}, shift {z_shift}, lag {index:?}, component {component}: {got} vs {want}"
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn opposite_shifts_are_conjugate_in_fft_space() {
    let cells = [6, 5, 3];
    let cell_size = [0.8e-9, 1.2e-9, 1.0e-9];
    let images = [3, 2];
    let forward = try_compute_periodic_xy_kernel(cells, cell_size, 2.5e-9, images).unwrap();
    let reverse = try_compute_periodic_xy_kernel(cells, cell_size, -2.5e-9, images).unwrap();
    let self_kernel = try_compute_periodic_xy_kernel(cells, cell_size, 0.0, images).unwrap();

    for (forward_component, reverse_component) in
        spectra(&forward).into_iter().zip(spectra(&reverse))
    {
        for (&a, &b) in forward_component.iter().zip(reverse_component) {
            assert!((a - b.conj()).norm() < 1e-13, "{a} vs conj({b})");
        }
    }
    for component in spectra(&self_kernel) {
        assert!(component.iter().all(|value| value.im.abs() < 1e-13));
    }
}

#[test]
fn periodic_far_field_uses_the_point_dipole_tensor() {
    let z_shift: f64 = 64.0;
    let kernel = try_compute_periodic_xy_kernel([1; 3], [1.0; 3], z_shift, [0; 2]).unwrap();
    let perpendicular = 1.0 / (4.0 * PI * z_shift.powi(3));
    let expected = [
        perpendicular,
        perpendicular,
        -2.0 * perpendicular,
        0.0,
        0.0,
        0.0,
    ];

    for (actual, expected) in inverse_at(&kernel, [0; 3]).into_iter().zip(expected) {
        assert!((actual - expected).abs() < 1e-20);
    }
}

#[test]
fn invalid_periodic_kernel_inputs_are_rejected() {
    assert!(matches!(
        try_compute_periodic_xy_kernel([2, 0, 1], [1.0; 3], 0.0, [0; 2]),
        Err(KernelBuildError::EmptyGrid)
    ));
    assert!(matches!(
        try_compute_periodic_xy_kernel([1; 3], [1.0, 0.0, 1.0], 0.0, [0; 2]),
        Err(KernelBuildError::InvalidCellSize { axis: 1, .. })
    ));
    assert!(matches!(
        try_compute_periodic_xy_kernel([1; 3], [1.0; 3], f64::NAN, [0; 2]),
        Err(KernelBuildError::InvalidOffset { axis: 2, .. })
    ));
    for (cells, images) in [
        ([1, 1, usize::MAX], [0; 2]),
        ([usize::MAX / 32, 1, 1], [0; 2]),
        ([1; 3], [500, 500]),
        ([1; 3], [u32::MAX; 2]),
    ] {
        assert!(matches!(
            try_compute_periodic_xy_kernel(cells, [1.0; 3], 0.0, images),
            Err(KernelBuildError::UnsupportedGeometry { .. })
        ));
    }
}
