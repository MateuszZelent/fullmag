use super::{equal_cell_near_tensor, point_dipole_pair_tensor, NewellKernels, ASYMPTOTIC_DISTANCE};
use crate::CellPairTensor;

/// Fold single-layer images into one periodic and one open lateral axis.
pub fn compute_single_layer_mixed_newell_kernels(
    nx: usize,
    ny: usize,
    cell_size: [f64; 3],
    periodic_x: bool,
    images: u32,
) -> NewellKernels {
    let (px, py, x_lags, y_lags) = if periodic_x {
        (nx, 2 * ny, nx / 2 + 1, ny)
    } else {
        (2 * nx, ny, nx, ny / 2 + 1)
    };
    let pz = 2;
    let len = px * py * pz;
    let mut kernels = NewellKernels {
        px,
        py,
        pz,
        n_xx: vec![0.0; len],
        n_yy: vec![0.0; len],
        n_zz: vec![0.0; len],
        n_xy: vec![0.0; len],
        n_xz: vec![0.0; len],
        n_yz: vec![0.0; len],
    };

    let scale = cell_size.into_iter().fold(0.0_f64, f64::max);
    let cell = cell_size.map(|pitch| pitch / scale);
    let [dx, dy, _] = cell;
    let volume = cell.into_iter().product::<f64>();
    let (period_x, period_y) = if periodic_x {
        (nx as f64 * dx, 0.0)
    } else {
        (0.0, ny as f64 * dy)
    };
    let far_radius_squared = (ASYMPTOTIC_DISTANCE * ASYMPTOTIC_DISTANCE) as f64;
    let images = i64::from(images);
    for j in 0..y_lags {
        for i in 0..x_lags {
            let mut sum = CellPairTensor::default();
            for image in -images..=images {
                let x = i as f64 * dx + image as f64 * period_x;
                let y = j as f64 * dy + image as f64 * period_y;
                // The exact finite difference loses its r^-3 residue at distant images.
                let tensor = if x * x + y * y >= far_radius_squared {
                    point_dipole_pair_tensor(volume, [x, y, 0.0])
                } else {
                    equal_cell_near_tensor(cell, [x, y, 0.0])
                };
                sum.xx += tensor.xx;
                sum.yy += tensor.yy;
                sum.zz += tensor.zz;
                sum.xy += tensor.xy;
            }
            for (y, sy) in mirrored_lag(j, py) {
                for (x, sx) in mirrored_lag(i, px) {
                    let index = y * px + x;
                    kernels.n_xx[index] = sum.xx;
                    kernels.n_yy[index] = sum.yy;
                    kernels.n_zz[index] = sum.zz;
                    kernels.n_xy[index] = sx * sy * sum.xy;
                }
            }
        }
    }
    kernels
}

fn mirrored_lag(lag: usize, padded_count: usize) -> [(usize, f64); 2] {
    let mirror = (padded_count - lag) % padded_count;
    if lag == mirror {
        // Odd tensor components vanish at a self-reflecting lag.
        [(lag, 0.0), (lag, 0.0)]
    } else {
        [(lag, 1.0), (mirror, -1.0)]
    }
}
