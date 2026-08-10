//! Newell–Williams–Dunlop (1993) demagnetization tensor computation.
//!
//! Implements the Boris-style precomputed grid + 27-point stencil approach:
//! 1. Evaluate `f` and `g` base functions on a signed integer grid
//! 2. Apply the 27-point `Ldia`/`Lodia` stencil to get tensor values
//! 3. Place into padded grid with octant symmetry
//!
//! Reference: Newell, Williams & Dunlop, *J. Geophys. Res.* **98** (B6), 1993.
//! Implementation follows Boris Computational Spintronics (DemagTFunc).

use std::f64::consts::PI;

use crate::types::{CellPairTensor, KernelBuildError};

// ---------------------------------------------------------------------------
// Base functions (Boris formulation with log1p for numerical stability)
// ---------------------------------------------------------------------------

/// Diagonal base function `f(x, y, z)`.
///
/// Uses `log1p` variant from Boris for numerical stability with signed
/// arguments. Applicable for any sign of x, y, z.
pub fn newell_f(x: f64, y: f64, z: f64) -> f64 {
    let x2 = x * x;
    let y2 = y * y;
    let z2 = z * z;
    let r2 = x2 + y2 + z2;

    if r2 < 1e-300 {
        return 0.0;
    }

    let r = r2.sqrt();
    let mut result = (2.0 * x2 - y2 - z2) * r / 6.0;

    // Term 2: y(z² - x²)/4 · ln(1 + 2y(y+R)/(x²+z²))
    let rxz2 = x2 + z2;
    if rxz2 > 1e-300 {
        let arg = 2.0 * y * (y + r) / rxz2;
        if arg > -1.0 {
            result += y * (z2 - x2) / 4.0 * arg.ln_1p();
        }
    }

    // Term 3: z(y² - x²)/4 · ln(1 + 2z(z+R)/(x²+y²))
    let rxy2 = x2 + y2;
    if rxy2 > 1e-300 {
        let arg = 2.0 * z * (z + r) / rxy2;
        if arg > -1.0 {
            result += z * (y2 - x2) / 4.0 * arg.ln_1p();
        }
    }

    // Term 4: -xyz · arctan(yz / (x·R))
    if x.abs() > 1e-300 {
        result -= x * y * z * (y * z / (x * r)).atan();
    }

    result
}

/// Off-diagonal base function `g(x, y, z)`.
///
/// Uses `log1p` variant from Boris for numerical stability.
pub fn newell_g(x: f64, y: f64, z: f64) -> f64 {
    let x2 = x * x;
    let y2 = y * y;
    let z2 = z * z;
    let r2 = x2 + y2 + z2;

    if r2 < 1e-300 {
        return 0.0;
    }

    let r = r2.sqrt();

    // Term 1: -x·y·R / 3
    let mut result = -x * y * r / 3.0;

    // Term 2: x·y·z · ln(1 + 2z(z+R)/(x²+y²)) / 2
    let rxy2 = x2 + y2;
    if rxy2 > 1e-300 {
        let arg = 2.0 * z * (z + r) / rxy2;
        if arg > -1.0 {
            result += x * y * z * arg.ln_1p() / 2.0;
        }
    }

    // Term 3: y(3z² - y²) · ln(1 + 2x(x+R)/(y²+z²)) / 12
    let ryz2 = y2 + z2;
    if ryz2 > 1e-300 {
        let arg = 2.0 * x * (x + r) / ryz2;
        if arg > -1.0 {
            result += y * (3.0 * z2 - y2) * arg.ln_1p() / 12.0;
        }
    }

    // Term 4: x(3z² - x²) · ln(1 + 2y(y+R)/(x²+z²)) / 12
    let rxz2 = x2 + z2;
    if rxz2 > 1e-300 {
        let arg = 2.0 * y * (y + r) / rxz2;
        if arg > -1.0 {
            result += x * (3.0 * z2 - x2) * arg.ln_1p() / 12.0;
        }
    }

    // Term 5: -z³/6 · arctan(xy / (z·R))
    if z.abs() > 1e-300 {
        result -= z2 * z / 6.0 * (x * y / (z * r)).atan();
    }

    // Term 6: -y²·z/2 · arctan(xz / (y·R))
    if y.abs() > 1e-300 {
        result -= y2 * z / 2.0 * (x * z / (y * r)).atan();
    }

    // Term 7: -x²·z/2 · arctan(yz / (x·R))
    if x.abs() > 1e-300 {
        result -= x2 * z / 2.0 * (y * z / (x * r)).atan();
    }

    result
}

// ---------------------------------------------------------------------------
// 27-point stencil (Ldia / Lodia)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Kahan-Neumaier compensated summation (matches Boris sum_KahanNeumaier)
// ---------------------------------------------------------------------------

/// Kahan-Neumaier compensated summation for improved numerical accuracy.
/// Essential for the 27-point stencil where large cancellations occur.
fn kahan_sum(terms: &[f64]) -> f64 {
    let mut sum = 0.0_f64;
    let mut comp = 0.0_f64; // compensation
    for &val in terms {
        let t = sum + val;
        if sum.abs() >= val.abs() {
            comp += (sum - t) + val;
        } else {
            comp += (val - t) + sum;
        }
        sum = t;
    }
    sum + comp
}

/// Compute the diagonal demag tensor component at displacement (i, j, k)
/// using the 27-point stencil on precomputed `f_vals` with Kahan summation.
fn ldia(
    i: usize,
    j: usize,
    k: usize,
    f_vals: &[f64],
    sx: usize,
    sy: usize,
    hx: f64,
    hy: f64,
    hz: f64,
) -> f64 {
    // Shift indices: f_vals is stored with +1 offset
    ldia_at(i + 1, j + 1, k + 1, f_vals, sx, sy, hx, hy, hz)
}

/// Apply the 27-point stencil at explicit precomputed-grid coordinates.
///
/// Unlike [`ldia`], this accepts a caller-provided Z center so shifted kernels
/// can evaluate positive and negative lags independently on one signed grid.
fn ldia_at(
    i: usize,
    j: usize,
    k: usize,
    f_vals: &[f64],
    sx: usize,
    sy: usize,
    hx: f64,
    hy: f64,
    hz: f64,
) -> f64 {
    let idx = |a: usize, b: usize, c: usize| c * sy * sx + b * sx + a;

    let terms: [f64; 27] = [
        // Center: +8
        8.0 * f_vals[idx(i, j, k)],
        // 6 face neighbors: -4
        -4.0 * f_vals[idx(i + 1, j, k)],
        -4.0 * f_vals[idx(i - 1, j, k)],
        -4.0 * f_vals[idx(i, j + 1, k)],
        -4.0 * f_vals[idx(i, j - 1, k)],
        -4.0 * f_vals[idx(i, j, k + 1)],
        -4.0 * f_vals[idx(i, j, k - 1)],
        // 12 edge neighbors: +2
        2.0 * f_vals[idx(i - 1, j - 1, k)],
        2.0 * f_vals[idx(i - 1, j + 1, k)],
        2.0 * f_vals[idx(i + 1, j - 1, k)],
        2.0 * f_vals[idx(i + 1, j + 1, k)],
        2.0 * f_vals[idx(i - 1, j, k - 1)],
        2.0 * f_vals[idx(i - 1, j, k + 1)],
        2.0 * f_vals[idx(i + 1, j, k - 1)],
        2.0 * f_vals[idx(i + 1, j, k + 1)],
        2.0 * f_vals[idx(i, j - 1, k - 1)],
        2.0 * f_vals[idx(i, j - 1, k + 1)],
        2.0 * f_vals[idx(i, j + 1, k - 1)],
        2.0 * f_vals[idx(i, j + 1, k + 1)],
        // 8 corner neighbors: -1
        -f_vals[idx(i - 1, j - 1, k - 1)],
        -f_vals[idx(i - 1, j - 1, k + 1)],
        -f_vals[idx(i - 1, j + 1, k - 1)],
        -f_vals[idx(i + 1, j - 1, k - 1)],
        -f_vals[idx(i - 1, j + 1, k + 1)],
        -f_vals[idx(i + 1, j - 1, k + 1)],
        -f_vals[idx(i + 1, j + 1, k - 1)],
        -f_vals[idx(i + 1, j + 1, k + 1)],
    ];

    kahan_sum(&terms) / (4.0 * PI * hx * hy * hz)
}

/// Apply the 27-point stencil directly at physical coordinates.
///
/// This is the correctness fallback for a large integer lag whose physical
/// displacement becomes near-field after applying an offset. Such a lag can
/// be outside the bounded precomputed window and must not use point-dipole
/// asymptotics.
fn ldia_direct<F>(x: f64, y: f64, z: f64, hx: f64, hy: f64, hz: f64, base: F) -> f64
where
    F: Fn(f64, f64, f64) -> f64,
{
    const WEIGHTS: [f64; 3] = [-1.0, 2.0, -1.0];
    let mut terms = [0.0_f64; 27];
    let mut index = 0;
    for (k, wz) in WEIGHTS.into_iter().enumerate() {
        for (j, wy) in WEIGHTS.into_iter().enumerate() {
            for (i, wx) in WEIGHTS.into_iter().enumerate() {
                terms[index] = wx
                    * wy
                    * wz
                    * base(
                        x + (i as f64 - 1.0) * hx,
                        y + (j as f64 - 1.0) * hy,
                        z + (k as f64 - 1.0) * hz,
                    );
                index += 1;
            }
        }
    }

    kahan_sum(&terms) / (4.0 * PI * hx * hy * hz)
}

/// Evaluate a double-volume Newell integral directly from its 64 corners.
///
/// The finite-difference stencil is efficient near the origin but loses
/// significant bits at large in-plane lags.  The 2-D multilayer lane uses
/// this formulation for its complete padded kernel, so the CPU reference can
/// be checked against an independent exact cell-pair oracle.
fn corner_sum_exact<F>(
    x: f64,
    y: f64,
    z: f64,
    source_cell: [f64; 3],
    destination_cell: [f64; 3],
    base: F,
) -> f64
where
    F: Fn(f64, f64, f64) -> f64,
{
    let mut terms = [0.0_f64; 64];
    let mut index = 0;
    for destination_x in [-1.0, 1.0] {
        for destination_y in [-1.0, 1.0] {
            for destination_z in [-1.0, 1.0] {
                for source_x in [-1.0, 1.0] {
                    for source_y in [-1.0, 1.0] {
                        for source_z in [-1.0, 1.0] {
                            let coordinates = [
                                x + destination_x * destination_cell[0] / 2.0
                                    - source_x * source_cell[0] / 2.0,
                                y + destination_y * destination_cell[1] / 2.0
                                    - source_y * source_cell[1] / 2.0,
                                z + destination_z * destination_cell[2] / 2.0
                                    - source_z * source_cell[2] / 2.0,
                            ];
                            terms[index] = destination_x
                                * destination_y
                                * destination_z
                                * source_x
                                * source_y
                                * source_z
                                * base(coordinates[0], coordinates[1], coordinates[2]);
                            index += 1;
                        }
                    }
                }
            }
        }
    }
    kahan_sum(&terms) / (4.0 * PI * destination_cell.into_iter().product::<f64>())
}

/// Evaluate one oriented source/destination cell pair with the exact
/// double-volume Newell corner sum.
///
/// `destination_cell` is deliberately the first argument because this is the
/// orientation used by the pair descriptor and by the Appendix-A equations.
/// The displacement is `destination_center - source_center`.  Unlike the
/// translational FFT kernel builder, this direct helper supports independent
/// cell sizes on all three axes and is therefore the correctness oracle for
/// unequal 3-D pairs as well as the unequal-thickness 2-D lane.
pub fn cell_pair_tensor(
    destination_cell: [f64; 3],
    source_cell: [f64; 3],
    displacement: [f64; 3],
) -> Result<CellPairTensor, KernelBuildError> {
    for (role, cell) in [("source", source_cell), ("destination", destination_cell)] {
        for (axis, value) in cell.into_iter().enumerate() {
            if !value.is_finite() || value <= 0.0 {
                return Err(KernelBuildError::InvalidCellSize { role, axis, value });
            }
        }
    }
    for (axis, value) in displacement.into_iter().enumerate() {
        if !value.is_finite() {
            return Err(KernelBuildError::InvalidOffset { axis, value });
        }
    }

    let tensor = cell_pair_tensor_exact(source_cell, destination_cell, displacement);
    if tensor
        .components()
        .into_iter()
        .any(|(_, value)| !value.is_finite())
    {
        return Err(KernelBuildError::UnsupportedGeometry {
            reason: "cell-pair Newell evaluation overflowed to a non-finite tensor".to_string(),
        });
    }
    Ok(tensor)
}

/// Compatibility spelling for callers that prefer an explicit `compute_`
/// prefix.  The checked result is intentional: malformed geometry must not be
/// silently converted to a different kernel family.
pub fn compute_cell_pair_tensor(
    destination_cell: [f64; 3],
    source_cell: [f64; 3],
    displacement: [f64; 3],
) -> Result<CellPairTensor, KernelBuildError> {
    cell_pair_tensor(destination_cell, source_cell, displacement)
}

fn permute_cell(cell: [f64; 3], permutation: [usize; 3]) -> [f64; 3] {
    [
        cell[permutation[0]],
        cell[permutation[1]],
        cell[permutation[2]],
    ]
}

/// Exact six-component pair tensor.  Axis permutations are applied to both
/// coordinates and cell extents; omitting the latter would be wrong for
/// unequal source/destination dimensions.
fn cell_pair_tensor_exact(
    source_cell: [f64; 3],
    destination_cell: [f64; 3],
    displacement: [f64; 3],
) -> CellPairTensor {
    let n_xx = corner_sum_exact(
        displacement[0],
        displacement[1],
        displacement[2],
        source_cell,
        destination_cell,
        newell_f,
    );
    let n_yy = corner_sum_exact(
        displacement[1],
        displacement[0],
        displacement[2],
        permute_cell(source_cell, [1, 0, 2]),
        permute_cell(destination_cell, [1, 0, 2]),
        newell_f,
    );
    let n_zz = corner_sum_exact(
        displacement[2],
        displacement[1],
        displacement[0],
        permute_cell(source_cell, [2, 1, 0]),
        permute_cell(destination_cell, [2, 1, 0]),
        newell_f,
    );
    let n_xy = corner_sum_exact(
        displacement[0],
        displacement[1],
        displacement[2],
        source_cell,
        destination_cell,
        newell_g,
    );
    let n_xz = corner_sum_exact(
        displacement[0],
        displacement[2],
        displacement[1],
        permute_cell(source_cell, [0, 2, 1]),
        permute_cell(destination_cell, [0, 2, 1]),
        newell_g,
    );
    let n_yz = corner_sum_exact(
        displacement[1],
        displacement[2],
        displacement[0],
        permute_cell(source_cell, [1, 2, 0]),
        permute_cell(destination_cell, [1, 2, 0]),
        newell_g,
    );
    CellPairTensor::new(n_xx, n_yy, n_zz, n_xy, n_xz, n_yz)
}

fn point_dipole_pair_tensor(source_volume: f64, displacement: [f64; 3]) -> CellPairTensor {
    let r2 = displacement[0] * displacement[0]
        + displacement[1] * displacement[1]
        + displacement[2] * displacement[2];
    let r = r2.sqrt();
    let inv_r3 = 1.0 / (r2 * r);
    let inv_r5 = inv_r3 / r2;
    let scale = source_volume / (4.0 * PI);
    CellPairTensor::new(
        scale * (inv_r3 - 3.0 * displacement[0] * displacement[0] * inv_r5),
        scale * (inv_r3 - 3.0 * displacement[1] * displacement[1] * inv_r5),
        scale * (inv_r3 - 3.0 * displacement[2] * displacement[2] * inv_r5),
        scale * (-3.0 * displacement[0] * displacement[1] * inv_r5),
        scale * (-3.0 * displacement[0] * displacement[2] * inv_r5),
        scale * (-3.0 * displacement[1] * displacement[2] * inv_r5),
    )
}

fn signed_lag_positions(cells: usize, padded: usize) -> Vec<(isize, usize)> {
    let mut positions = Vec::with_capacity(cells.saturating_mul(2).saturating_sub(1));
    positions.push((0, 0));
    for lag in 1..cells {
        positions.push((lag as isize, lag));
        positions.push((-(lag as isize), padded - lag));
    }
    positions
}

fn validate_shifted_pair_inputs(
    nx: usize,
    ny: usize,
    nz: usize,
    source_cell: [f64; 3],
    destination_cell: [f64; 3],
    offset: [f64; 3],
) -> Result<(), KernelBuildError> {
    if nx == 0 || ny == 0 || nz == 0 {
        return Err(KernelBuildError::EmptyGrid);
    }
    for (role, cell) in [("source", source_cell), ("destination", destination_cell)] {
        for (axis, value) in cell.into_iter().enumerate() {
            if !value.is_finite() || value <= 0.0 {
                return Err(KernelBuildError::InvalidCellSize { role, axis, value });
            }
        }
    }
    for (axis, value) in offset.into_iter().enumerate() {
        if !value.is_finite() {
            return Err(KernelBuildError::InvalidOffset { axis, value });
        }
    }

    // A single Toeplitz kernel needs one centre-to-centre pitch on each
    // translational axis.  Appendix A permits independent source/destination
    // thickness while retaining common in-plane pitches.  For a true 3-D
    // convolution, unequal source/destination spacing on any axis would make
    // the displacement depend on both cell indices; use `cell_pair_tensor`
    // directly for that irregular case instead of silently choosing a pitch.
    if source_cell[0] != destination_cell[0] || source_cell[1] != destination_cell[1] {
        return Err(KernelBuildError::UnsupportedGeometry {
            reason: "shifted FFT kernel requires common source/destination x/y cell pitches"
                .to_string(),
        });
    }
    if nz > 1 && source_cell[2] != destination_cell[2] {
        return Err(KernelBuildError::UnsupportedGeometry {
            reason: "3-D shifted FFT kernel requires equal source/destination z pitch; use cell_pair_tensor for an irregular pair".to_string(),
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Far-field asymptotic approximation (point-dipole limit)
// ---------------------------------------------------------------------------

/// Asymptotic diagonal demag tensor component.
/// For large displacements, the cell-averaged integral converges to the
/// continuum point-dipole formula: N_xx ≈ (1 - 3x²/r²) / (4π r³)
fn asymptotic_nxx(x: f64, y: f64, z: f64, vol: f64) -> f64 {
    let r2 = x * x + y * y + z * z;
    let r = r2.sqrt();
    let r3 = r2 * r;
    (1.0 / r3 - 3.0 * x * x / (r3 * r2)) / (4.0 * PI) * vol
}

/// Asymptotic off-diagonal demag tensor component.
/// N_xy ≈ -3xy / (4π r⁵)
fn asymptotic_nxy(x: f64, y: f64, z: f64, vol: f64) -> f64 {
    let r2 = x * x + y * y + z * z;
    let r = r2.sqrt();
    let r5 = r2 * r2 * r;
    -3.0 * x * y / (4.0 * PI * r5) * vol
}

/// Default asymptotic distance threshold in cell radii (matching Boris default).
const ASYMPTOTIC_DISTANCE: usize = 40;

// ---------------------------------------------------------------------------
// Kernel builder
// ---------------------------------------------------------------------------

/// Precomputed Newell demagnetization kernel on a zero-padded grid.
pub struct NewellKernels {
    pub n_xx: Vec<f64>,
    pub n_yy: Vec<f64>,
    pub n_zz: Vec<f64>,
    pub n_xy: Vec<f64>,
    pub n_xz: Vec<f64>,
    pub n_yz: Vec<f64>,
    pub px: usize,
    pub py: usize,
    pub pz: usize,
}

/// Compute the six Newell demagnetization tensor components on the zero-padded
/// `(2nx, 2ny, 2nz)` grid, following the Boris algorithm:
///
/// 1. Precompute `f`/`g` values on signed grid `[-1..nx] × [-1..ny] × [-1..nz]`
/// 2. Apply 27-point `Ldia`/`Lodia` stencil for each first-octant displacement
/// 3. Reflect into all 8 octants with correct parity
pub fn compute_newell_kernels(
    nx: usize,
    ny: usize,
    nz: usize,
    dx: f64,
    dy: f64,
    dz: f64,
) -> NewellKernels {
    let px = 2 * nx;
    let py = 2 * ny;
    let pz = 2 * nz;
    let padded_len = px * py * pz;

    // Step 1: Precompute f and g values on the extended grid.
    // Only compute up to ASYMPTOTIC_DISTANCE (matching Boris's fill_f_vals).
    let nx_dist = nx.min(ASYMPTOTIC_DISTANCE);
    let ny_dist = ny.min(ASYMPTOTIC_DISTANCE);
    let nz_dist = nz.min(ASYMPTOTIC_DISTANCE);
    let fsx = nx_dist + 2;
    let fsy = ny_dist + 2;
    let fsz = nz_dist + 2;
    let flen = fsx * fsy * fsz;

    // Parallelized over z-slabs (each slab is independent).
    let slab_len = fsx * fsy; // one z-slab
    let mut f_all = vec![0.0_f64; flen * 6]; // interleave: xx, yy, zz, xy, xz, yz

    {
        #[cfg(feature = "parallel")]
        {
            use rayon::prelude::*;
            f_all
                .par_chunks_mut(slab_len * 6)
                .enumerate()
                .for_each(|(k, slab)| {
                    let kk = k as isize - 1;
                    for j in 0..fsy {
                        let jj = j as isize - 1;
                        for i in 0..fsx {
                            let ii = i as isize - 1;
                            let x = ii as f64 * dx;
                            let y = jj as f64 * dy;
                            let z = kk as f64 * dz;
                            let base = (j * fsx + i) * 6;
                            slab[base] = newell_f(x, y, z);
                            slab[base + 1] = newell_f(y, x, z);
                            slab[base + 2] = newell_f(z, y, x);
                            slab[base + 3] = newell_g(x, y, z);
                            slab[base + 4] = newell_g(x, z, y);
                            slab[base + 5] = newell_g(y, z, x);
                        }
                    }
                });
        }
        #[cfg(not(feature = "parallel"))]
        {
            for k in 0..fsz {
                let kk = k as isize - 1;
                for j in 0..fsy {
                    let jj = j as isize - 1;
                    for i in 0..fsx {
                        let ii = i as isize - 1;
                        let x = ii as f64 * dx;
                        let y = jj as f64 * dy;
                        let z = kk as f64 * dz;
                        let base = (k * slab_len + j * fsx + i) * 6;
                        f_all[base] = newell_f(x, y, z);
                        f_all[base + 1] = newell_f(y, x, z);
                        f_all[base + 2] = newell_f(z, y, x);
                        f_all[base + 3] = newell_g(x, y, z);
                        f_all[base + 4] = newell_g(x, z, y);
                        f_all[base + 5] = newell_g(y, z, x);
                    }
                }
            }
        }
    }

    // De-interleave into separate arrays for the stencil function
    let mut f_vals_xx = vec![0.0; flen];
    let mut f_vals_yy = vec![0.0; flen];
    let mut f_vals_zz = vec![0.0; flen];
    let mut g_vals_xy = vec![0.0; flen];
    let mut g_vals_xz = vec![0.0; flen];
    let mut g_vals_yz = vec![0.0; flen];
    for idx in 0..flen {
        let base = idx * 6;
        f_vals_xx[idx] = f_all[base];
        f_vals_yy[idx] = f_all[base + 1];
        f_vals_zz[idx] = f_all[base + 2];
        g_vals_xy[idx] = f_all[base + 3];
        g_vals_xz[idx] = f_all[base + 4];
        g_vals_yz[idx] = f_all[base + 5];
    }
    drop(f_all);

    // Step 2: Apply 27-point stencil and place into padded grid.
    // Parallelized over z-slabs. Each (i,j,k) writes to unique octant positions,
    // and each k-slab group writes to non-overlapping positions, so this is safe.
    let mut n_xx = vec![0.0; padded_len];
    let mut n_yy = vec![0.0; padded_len];
    let mut n_zz = vec![0.0; padded_len];
    let mut n_xy = vec![0.0; padded_len];
    let mut n_xz = vec![0.0; padded_len];
    let mut n_yz = vec![0.0; padded_len];

    // Inner function for one (i,j,k) → writes into the 6 output arrays
    let compute_and_place = |i: usize,
                             j: usize,
                             k: usize,
                             n_xx: &mut [f64],
                             n_yy: &mut [f64],
                             n_zz: &mut [f64],
                             n_xy: &mut [f64],
                             n_xz: &mut [f64],
                             n_yz: &mut [f64]| {
        let (nxx, nyy, nzz, nxy, nxz, nyz);
        let dist2 = i * i + j * j + k * k;
        // The 2D multilayer lane is small enough to retain the exact
        // double-volume Newell integral for every in-plane lag.  This keeps
        // the published CPU reference compatible with an independent exact
        // oracle even when a padded FFT grid extends beyond 40 cells.  The
        // point-dipole shortcut remains available for genuinely 3D grids,
        // where the full tensor volume can be materially larger.
        let use_asymptotic = nz > 1
            && (i >= ASYMPTOTIC_DISTANCE
                || j >= ASYMPTOTIC_DISTANCE
                || k >= ASYMPTOTIC_DISTANCE
                || dist2 >= ASYMPTOTIC_DISTANCE * ASYMPTOTIC_DISTANCE);

        if nz == 1 {
            let x = i as f64 * dx;
            let y = j as f64 * dy;
            let z = k as f64 * dz;
            let cell = [dx, dy, dz];
            nxx = corner_sum_exact(x, y, z, cell, cell, newell_f);
            nyy = corner_sum_exact(x, y, z, cell, cell, |x, y, z| newell_f(y, x, z));
            nzz = corner_sum_exact(x, y, z, cell, cell, |x, y, z| newell_f(z, y, x));
            nxy = corner_sum_exact(x, y, z, cell, cell, newell_g);
            nxz = corner_sum_exact(x, y, z, cell, cell, |x, y, z| newell_g(x, z, y));
            nyz = corner_sum_exact(x, y, z, cell, cell, |x, y, z| newell_g(y, z, x));
        } else if use_asymptotic {
            let x = i as f64 * dx;
            let y = j as f64 * dy;
            let z = k as f64 * dz;
            let vol = dx * dy * dz;
            nxx = asymptotic_nxx(x, y, z, vol);
            nyy = asymptotic_nxx(y, x, z, vol);
            nzz = asymptotic_nxx(z, y, x, vol);
            nxy = asymptotic_nxy(x, y, z, vol);
            nxz = asymptotic_nxy(x, z, y, vol);
            nyz = asymptotic_nxy(y, z, x, vol);
        } else if i < nx_dist && j < ny_dist && k < nz_dist {
            nxx = ldia(i, j, k, &f_vals_xx, fsx, fsy, dx, dy, dz);
            nyy = ldia(i, j, k, &f_vals_yy, fsx, fsy, dy, dx, dz);
            nzz = ldia(i, j, k, &f_vals_zz, fsx, fsy, dz, dy, dx);
            nxy = ldia(i, j, k, &g_vals_xy, fsx, fsy, dx, dy, dz);
            nxz = ldia(i, j, k, &g_vals_xz, fsx, fsy, dx, dz, dy);
            nyz = ldia(i, j, k, &g_vals_yz, fsx, fsy, dy, dz, dx);
        } else {
            let x = i as f64 * dx;
            let y = j as f64 * dy;
            let z = k as f64 * dz;
            nxx = ldia_direct(x, y, z, dx, dy, dz, newell_f);
            nyy = ldia_direct(x, y, z, dy, dx, dz, |x, y, z| newell_f(y, x, z));
            nzz = ldia_direct(x, y, z, dz, dy, dx, |x, y, z| newell_f(z, y, x));
            nxy = ldia_direct(x, y, z, dx, dy, dz, newell_g);
            nxz = ldia_direct(x, y, z, dx, dz, dy, |x, y, z| newell_g(x, z, y));
            nyz = ldia_direct(x, y, z, dy, dz, dx, |x, y, z| newell_g(y, z, x));
        }

        let pidx = |a: usize, b: usize, c: usize| c * py * px + b * px + a;
        let xs: &[(usize, f64)] = if i == 0 {
            &[(0, 1.0)]
        } else {
            &[(i, 1.0), (px - i, -1.0)]
        };
        let ys: &[(usize, f64)] = if j == 0 {
            &[(0, 1.0)]
        } else {
            &[(j, 1.0), (py - j, -1.0)]
        };
        let zs: &[(usize, f64)] = if k == 0 {
            &[(0, 1.0)]
        } else {
            &[(k, 1.0), (pz - k, -1.0)]
        };

        for &(ix, sx) in xs {
            for &(iy, sy) in ys {
                for &(iz, sz) in zs {
                    let p = pidx(ix, iy, iz);
                    n_xx[p] = nxx;
                    n_yy[p] = nyy;
                    n_zz[p] = nzz;
                    n_xy[p] = nxy * sx * sy;
                    n_xz[p] = nxz * sx * sz;
                    n_yz[p] = nyz * sy * sz;
                }
            }
        }
    };

    // The octant placement for different k values writes to non-overlapping
    // z-positions (k and pz-k never overlap between different k values),
    // so we can safely run different k values in parallel.
    #[cfg(feature = "parallel")]
    {
        use rayon::prelude::*;

        // Safety wrapper for parallel disjoint writes.
        // Each (i,j,k) writes to unique octant positions in the output arrays.
        struct UnsafeSyncSlice {
            ptr: *mut f64,
            len: usize,
        }
        unsafe impl Send for UnsafeSyncSlice {}
        unsafe impl Sync for UnsafeSyncSlice {}
        impl UnsafeSyncSlice {
            unsafe fn as_mut_slice(&self) -> &mut [f64] {
                std::slice::from_raw_parts_mut(self.ptr, self.len)
            }
        }

        let s_xx = UnsafeSyncSlice {
            ptr: n_xx.as_mut_ptr(),
            len: padded_len,
        };
        let s_yy = UnsafeSyncSlice {
            ptr: n_yy.as_mut_ptr(),
            len: padded_len,
        };
        let s_zz = UnsafeSyncSlice {
            ptr: n_zz.as_mut_ptr(),
            len: padded_len,
        };
        let s_xy = UnsafeSyncSlice {
            ptr: n_xy.as_mut_ptr(),
            len: padded_len,
        };
        let s_xz = UnsafeSyncSlice {
            ptr: n_xz.as_mut_ptr(),
            len: padded_len,
        };
        let s_yz = UnsafeSyncSlice {
            ptr: n_yz.as_mut_ptr(),
            len: padded_len,
        };

        (0..nz).into_par_iter().for_each(|k| {
            for j in 0..ny {
                for i in 0..nx {
                    unsafe {
                        compute_and_place(
                            i,
                            j,
                            k,
                            s_xx.as_mut_slice(),
                            s_yy.as_mut_slice(),
                            s_zz.as_mut_slice(),
                            s_xy.as_mut_slice(),
                            s_xz.as_mut_slice(),
                            s_yz.as_mut_slice(),
                        );
                    }
                }
            }
        });
    }
    #[cfg(not(feature = "parallel"))]
    {
        for k in 0..nz {
            for j in 0..ny {
                for i in 0..nx {
                    compute_and_place(
                        i, j, k, &mut n_xx, &mut n_yy, &mut n_zz, &mut n_xy, &mut n_xz, &mut n_yz,
                    );
                }
            }
        }
    }

    NewellKernels {
        n_xx,
        n_yy,
        n_zz,
        n_xy,
        n_xz,
        n_yz,
        px,
        py,
        pz,
    }
}

/// Compute shifted Newell kernels for cross-layer interaction.
///
/// Same as `compute_newell_kernels` but with a constant z-offset applied
/// to all evaluation coordinates. This shifts the demagnetization tensor
/// to represent the coupling between two layers separated by `z_offset` meters.
///
/// When `z_offset == 0.0`, this is equivalent to `compute_newell_kernels`.
pub fn compute_newell_kernels_shifted(
    nx: usize,
    ny: usize,
    nz: usize,
    dx: f64,
    dy: f64,
    dz: f64,
    z_offset: f64,
) -> NewellKernels {
    if z_offset == 0.0 {
        return compute_newell_kernels(nx, ny, nz, dx, dy, dz);
    }

    let px = 2 * nx;
    let py = 2 * ny;
    let pz = 2 * nz;
    let padded_len = px * py * pz;

    let nx_dist = nx.min(ASYMPTOTIC_DISTANCE);
    let ny_dist = ny.min(ASYMPTOTIC_DISTANCE);
    let nz_dist = nz.min(ASYMPTOTIC_DISTANCE);
    let fsx = nx_dist + 2;
    let fsy = ny_dist + 2;
    // Shifted kernels are not symmetric in Z. Store both signed lag ranges,
    // including one halo point on either side for the 27-point stencil.
    let fsz = 2 * nz_dist + 1;
    let flen = fsx * fsy * fsz;

    // Step 1: Precompute f and g values with z_offset for signed Z lags.
    let mut f_vals_xx = vec![0.0; flen];
    let mut f_vals_yy = vec![0.0; flen];
    let mut f_vals_zz = vec![0.0; flen];
    let mut g_vals_xy = vec![0.0; flen];
    let mut g_vals_xz = vec![0.0; flen];
    let mut g_vals_yz = vec![0.0; flen];

    for k in 0..fsz {
        let kk = k as isize - nz_dist as isize;
        for j in 0..fsy {
            let jj = j as isize - 1;
            for i in 0..fsx {
                let ii = i as isize - 1;
                let x = ii as f64 * dx;
                let y = jj as f64 * dy;
                let z = kk as f64 * dz + z_offset;
                let idx = k * fsy * fsx + j * fsx + i;
                f_vals_xx[idx] = newell_f(x, y, z);
                f_vals_yy[idx] = newell_f(y, x, z);
                f_vals_zz[idx] = newell_f(z, y, x);
                g_vals_xy[idx] = newell_g(x, y, z);
                g_vals_xz[idx] = newell_g(x, z, y);
                g_vals_yz[idx] = newell_g(y, z, x);
            }
        }
    }

    // Step 2: Apply the stencil and place each signed Z lag independently.
    // XY parity remains valid because the offset is purely along Z.
    let mut n_xx = vec![0.0; padded_len];
    let mut n_yy = vec![0.0; padded_len];
    let mut n_zz = vec![0.0; padded_len];
    let mut n_xy = vec![0.0; padded_len];
    let mut n_xz = vec![0.0; padded_len];
    let mut n_yz = vec![0.0; padded_len];

    let vol = dx * dy * dz;

    for k in 0..nz {
        for j in 0..ny {
            for i in 0..nx {
                let pidx = |a: usize, b: usize, c: usize| c * py * px + b * px + a;
                let xs: &[(usize, f64)] = if i == 0 {
                    &[(0, 1.0)]
                } else {
                    &[(i, 1.0), (px - i, -1.0)]
                };
                let ys: &[(usize, f64)] = if j == 0 {
                    &[(0, 1.0)]
                } else {
                    &[(j, 1.0), (py - j, -1.0)]
                };
                let signed_z_lags: &[(isize, usize)] = if k == 0 {
                    &[(0, 0)]
                } else {
                    &[(k as isize, k), (-(k as isize), pz - k)]
                };

                for &(z_lag, iz) in signed_z_lags {
                    let abs_z_lag = z_lag.unsigned_abs();
                    let x = i as f64 * dx;
                    let y = j as f64 * dy;
                    let z = z_lag as f64 * dz + z_offset;
                    let max_cell_size = dx.max(dy).max(dz);
                    let far_field_radius = ASYMPTOTIC_DISTANCE as f64 * max_cell_size;
                    let use_asymptotic =
                        nz > 1 && x * x + y * y + z * z >= far_field_radius * far_field_radius;

                    let cell = [dx, dy, dz];
                    let (nxx, nyy, nzz, nxy, nxz, nyz) = if nz == 1 {
                        (
                            corner_sum_exact(x, y, z, cell, cell, newell_f),
                            corner_sum_exact(x, y, z, cell, cell, |x, y, z| newell_f(y, x, z)),
                            corner_sum_exact(x, y, z, cell, cell, |x, y, z| newell_f(z, y, x)),
                            corner_sum_exact(x, y, z, cell, cell, newell_g),
                            corner_sum_exact(x, y, z, cell, cell, |x, y, z| newell_g(x, z, y)),
                            corner_sum_exact(x, y, z, cell, cell, |x, y, z| newell_g(y, z, x)),
                        )
                    } else if use_asymptotic {
                        (
                            asymptotic_nxx(x, y, z, vol),
                            asymptotic_nxx(y, x, z, vol),
                            asymptotic_nxx(z, y, x, vol),
                            asymptotic_nxy(x, y, z, vol),
                            asymptotic_nxy(x, z, y, vol),
                            asymptotic_nxy(y, z, x, vol),
                        )
                    } else if i < nx_dist && j < ny_dist && abs_z_lag < nz_dist {
                        let stencil_z = (z_lag + nz_dist as isize) as usize;
                        (
                            ldia_at(i + 1, j + 1, stencil_z, &f_vals_xx, fsx, fsy, dx, dy, dz),
                            ldia_at(i + 1, j + 1, stencil_z, &f_vals_yy, fsx, fsy, dy, dx, dz),
                            ldia_at(i + 1, j + 1, stencil_z, &f_vals_zz, fsx, fsy, dz, dy, dx),
                            ldia_at(i + 1, j + 1, stencil_z, &g_vals_xy, fsx, fsy, dx, dy, dz),
                            ldia_at(i + 1, j + 1, stencil_z, &g_vals_xz, fsx, fsy, dx, dz, dy),
                            ldia_at(i + 1, j + 1, stencil_z, &g_vals_yz, fsx, fsy, dy, dz, dx),
                        )
                    } else {
                        (
                            ldia_direct(x, y, z, dx, dy, dz, newell_f),
                            ldia_direct(x, y, z, dx, dy, dz, |x, y, z| newell_f(y, x, z)),
                            ldia_direct(x, y, z, dx, dy, dz, |x, y, z| newell_f(z, y, x)),
                            ldia_direct(x, y, z, dx, dy, dz, newell_g),
                            ldia_direct(x, y, z, dx, dy, dz, |x, y, z| newell_g(x, z, y)),
                            ldia_direct(x, y, z, dx, dy, dz, |x, y, z| newell_g(y, z, x)),
                        )
                    };

                    for &(ix, sx) in xs {
                        for &(iy, sy) in ys {
                            let p = pidx(ix, iy, iz);
                            n_xx[p] = nxx;
                            n_yy[p] = nyy;
                            n_zz[p] = nzz;
                            n_xy[p] = nxy * sx * sy;
                            n_xz[p] = nxz * sx;
                            n_yz[p] = nyz * sy;
                        }
                    }
                }
            }
        }
    }

    NewellKernels {
        n_xx,
        n_yy,
        n_zz,
        n_xy,
        n_xz,
        n_yz,
        px,
        py,
        pz,
    }
}

/// Build a real-space shifted kernel for an oriented source/destination pair.
///
/// The returned arrays use the same x-fastest, tail-wrapped layout as the
/// historic Newell builders.  `offset` is the physical destination-minus-
/// source displacement added to every signed lag.  In the 2-D stack (`nz=1`)
/// source and destination thicknesses may differ, exactly as in Appendix A;
/// the in-plane pitches remain common.  A 3-D translational kernel requires
/// equal pitches on all axes.  For a single irregular 3-D pair use
/// [`cell_pair_tensor`] instead.
pub fn try_compute_newell_kernels_shifted_pair(
    nx: usize,
    ny: usize,
    nz: usize,
    source_cell: [f64; 3],
    destination_cell: [f64; 3],
    offset: [f64; 3],
) -> Result<NewellKernels, KernelBuildError> {
    validate_shifted_pair_inputs(nx, ny, nz, source_cell, destination_cell, offset)?;

    if offset == [0.0; 3] && source_cell == destination_cell {
        let kernels =
            compute_newell_kernels(nx, ny, nz, source_cell[0], source_cell[1], source_cell[2]);
        ensure_newell_kernels_finite(&kernels)?;
        return Ok(kernels);
    }

    let px = nx
        .checked_mul(2)
        .ok_or_else(|| KernelBuildError::UnsupportedGeometry {
            reason: "x kernel extent overflows usize".to_string(),
        })?;
    let py = ny
        .checked_mul(2)
        .ok_or_else(|| KernelBuildError::UnsupportedGeometry {
            reason: "y kernel extent overflows usize".to_string(),
        })?;
    let pz = nz
        .checked_mul(2)
        .ok_or_else(|| KernelBuildError::UnsupportedGeometry {
            reason: "z kernel extent overflows usize".to_string(),
        })?;
    let padded_len = px
        .checked_mul(py)
        .and_then(|value| value.checked_mul(pz))
        .ok_or_else(|| KernelBuildError::UnsupportedGeometry {
            reason: "shifted kernel storage size overflows usize".to_string(),
        })?;
    let mut n_xx = vec![0.0; padded_len];
    let mut n_yy = vec![0.0; padded_len];
    let mut n_zz = vec![0.0; padded_len];
    let mut n_xy = vec![0.0; padded_len];
    let mut n_xz = vec![0.0; padded_len];
    let mut n_yz = vec![0.0; padded_len];

    let x_lags = signed_lag_positions(nx, px);
    let y_lags = signed_lag_positions(ny, py);
    // In 2-D, the second z half of the padded transform remains zero just as
    // in `compute_newell_kernels` and `compute_newell_kernels_shifted`.
    let z_lags = if nz == 1 {
        vec![(0, 0)]
    } else {
        signed_lag_positions(nz, pz)
    };
    let source_volume = source_cell.into_iter().product::<f64>();
    let max_cell = source_cell
        .into_iter()
        .chain(destination_cell)
        .fold(0.0_f64, f64::max);
    let far_field_radius = ASYMPTOTIC_DISTANCE as f64 * max_cell;
    let pidx = |x: usize, y: usize, z: usize| z * py * px + y * px + x;

    for &(x_lag, ix) in &x_lags {
        for &(y_lag, iy) in &y_lags {
            for &(z_lag, iz) in &z_lags {
                // For 2-D each layer is represented by one scratch z cell;
                // source/destination thickness enters the exact pair integral,
                // not the lag pitch.
                let displacement = [
                    x_lag as f64 * source_cell[0] + offset[0],
                    y_lag as f64 * source_cell[1] + offset[1],
                    if nz == 1 {
                        offset[2]
                    } else {
                        z_lag as f64 * source_cell[2] + offset[2]
                    },
                ];
                let radius = displacement
                    .iter()
                    .map(|value| value * value)
                    .sum::<f64>()
                    .sqrt();
                let tensor = if nz > 1 && radius >= far_field_radius {
                    point_dipole_pair_tensor(source_volume, displacement)
                } else {
                    cell_pair_tensor_exact(source_cell, destination_cell, displacement)
                };
                if tensor
                    .components()
                    .into_iter()
                    .any(|(_, value)| !value.is_finite())
                {
                    return Err(KernelBuildError::UnsupportedGeometry {
                        reason: "shifted Newell evaluation overflowed to a non-finite tensor"
                            .to_string(),
                    });
                }
                let p = pidx(ix, iy, iz);
                n_xx[p] = tensor.xx;
                n_yy[p] = tensor.yy;
                n_zz[p] = tensor.zz;
                n_xy[p] = tensor.xy;
                n_xz[p] = tensor.xz;
                n_yz[p] = tensor.yz;
            }
        }
    }

    let kernels = NewellKernels {
        n_xx,
        n_yy,
        n_zz,
        n_xy,
        n_xz,
        n_yz,
        px,
        py,
        pz,
    };
    ensure_newell_kernels_finite(&kernels)?;
    Ok(kernels)
}

fn ensure_newell_kernels_finite(kernels: &NewellKernels) -> Result<(), KernelBuildError> {
    let all_finite = kernels
        .n_xx
        .iter()
        .chain(kernels.n_yy.iter())
        .chain(kernels.n_zz.iter())
        .chain(kernels.n_xy.iter())
        .chain(kernels.n_xz.iter())
        .chain(kernels.n_yz.iter())
        .all(|value| value.is_finite());
    if all_finite {
        Ok(())
    } else {
        Err(KernelBuildError::UnsupportedGeometry {
            reason: "shifted Newell kernel contains a non-finite value".to_string(),
        })
    }
}

/// Descriptive alias for [`try_compute_newell_kernels_shifted_pair`].
pub fn compute_newell_kernels_shifted_pair(
    nx: usize,
    ny: usize,
    nz: usize,
    source_cell: [f64; 3],
    destination_cell: [f64; 3],
    offset: [f64; 3],
) -> Result<NewellKernels, KernelBuildError> {
    try_compute_newell_kernels_shifted_pair(nx, ny, nz, source_cell, destination_cell, offset)
}

/// Alias naming the Appendix-A irregular source/destination construction.
pub fn compute_newell_kernels_shifted_irregular(
    nx: usize,
    ny: usize,
    nz: usize,
    source_cell: [f64; 3],
    destination_cell: [f64; 3],
    offset: [f64; 3],
) -> Result<NewellKernels, KernelBuildError> {
    compute_newell_kernels_shifted_pair(nx, ny, nz, source_cell, destination_cell, offset)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn f_at_origin_is_zero() {
        assert_eq!(newell_f(0.0, 0.0, 0.0), 0.0);
    }

    #[test]
    fn g_at_origin_is_zero() {
        assert_eq!(newell_g(0.0, 0.0, 0.0), 0.0);
    }

    #[test]
    fn self_term_trace_equals_one_for_cubic_cell() {
        let kernels = compute_newell_kernels(1, 1, 1, 1.0, 1.0, 1.0);
        let trace = kernels.n_xx[0] + kernels.n_yy[0] + kernels.n_zz[0];
        assert!(
            (trace - 1.0).abs() < 1e-10,
            "Self-term trace should be 1.0, got {} (xx={}, yy={}, zz={})",
            trace,
            kernels.n_xx[0],
            kernels.n_yy[0],
            kernels.n_zz[0],
        );
    }

    #[test]
    fn cubic_self_term_is_one_third() {
        let kernels = compute_newell_kernels(1, 1, 1, 1.0, 1.0, 1.0);
        assert!(
            (kernels.n_xx[0] - 1.0 / 3.0).abs() < 1e-6,
            "N_xx for cubic cell should be ~1/3, got {}",
            kernels.n_xx[0],
        );
    }

    #[test]
    fn self_term_trace_equals_one_for_noncubic_cell() {
        let kernels = compute_newell_kernels(1, 1, 1, 5e-9, 5e-9, 2e-9);
        let trace = kernels.n_xx[0] + kernels.n_yy[0] + kernels.n_zz[0];
        assert!(
            (trace - 1.0).abs() < 1e-10,
            "Self-term trace for non-cubic should be 1.0, got {}",
            trace,
        );
    }

    #[test]
    fn noncubic_cell_has_different_diagonal_components() {
        let kernels = compute_newell_kernels(1, 1, 1, 5e-9, 5e-9, 2e-9);
        // For flat cell (dx=dy > dz), N_zz should be largest
        assert!(
            kernels.n_zz[0] > kernels.n_xx[0],
            "N_zz ({}) should be > N_xx ({}) for flat cell",
            kernels.n_zz[0],
            kernels.n_xx[0],
        );
        // N_xx == N_yy by symmetry (dx == dy)
        assert!(
            (kernels.n_xx[0] - kernels.n_yy[0]).abs() < 1e-12,
            "N_xx ({}) should equal N_yy ({})",
            kernels.n_xx[0],
            kernels.n_yy[0],
        );
    }

    #[test]
    fn off_diagonal_self_term_is_zero() {
        let kernels = compute_newell_kernels(1, 1, 1, 3e-9, 4e-9, 5e-9);
        assert!(
            kernels.n_xy[0].abs() < 1e-12,
            "N_xy self=0, got {}",
            kernels.n_xy[0]
        );
        assert!(
            kernels.n_xz[0].abs() < 1e-12,
            "N_xz self=0, got {}",
            kernels.n_xz[0]
        );
        assert!(
            kernels.n_yz[0].abs() < 1e-12,
            "N_yz self=0, got {}",
            kernels.n_yz[0]
        );
    }

    #[test]
    fn kernel_symmetries_hold() {
        let kernels = compute_newell_kernels(4, 4, 4, 1.0, 1.0, 1.0);
        let px = kernels.px;
        let py = kernels.py;
        let idx = |x: usize, y: usize, z: usize| z * py * px + y * px + x;

        // N_xx even in x
        let i_pos = idx(1, 2, 3);
        let i_neg = idx(px - 1, 2, 3);
        assert!(
            (kernels.n_xx[i_pos] - kernels.n_xx[i_neg]).abs() < 1e-15,
            "N_xx should be even in x",
        );

        // N_xy odd in x
        assert!(
            (kernels.n_xy[i_pos] + kernels.n_xy[i_neg]).abs() < 1e-15,
            "N_xy should be odd in x",
        );
    }

    /// Validate absolute N_xy values against Python reference implementation.
    ///
    /// Reference values computed independently using the Boris Lodia stencil
    /// applied to newell_g(). For cubic cells (dx=dy=dz=1):
    ///   N_xy(1,1,0) ≈ -0.04556  (negative, near-field ~8% above asymptotic)
    ///   N_xy(2,2,0) ≈ -0.00529  (negative, ~0.27% above asymptotic)
    ///   N_xy(5,5,0) ≈ -0.000338 (negative, <0.01% above asymptotic)
    ///
    /// Python validation script (test_newell2.py) confirmed convergence to
    /// the -3xy/(4πr⁵) asymptotic at large distances.
    #[test]
    fn nxy_absolute_values_match_reference() {
        // Use nx=10, ny=10, nz=1 grid with unit cell size
        let kernels = compute_newell_kernels(10, 10, 1, 1.0, 1.0, 1.0);
        let px = kernels.px;
        let py = kernels.py;
        let idx = |x: usize, y: usize, z: usize| z * py * px + y * px + x;

        // N_xy(1,1,0): near-field value, ~8% above asymptotic
        // Reference: -4.55648226e-02
        let nxy_11 = kernels.n_xy[idx(1, 1, 0)];
        assert!(
            (nxy_11 - (-4.5565e-2)).abs() < 1e-5,
            "N_xy(1,1,0) should be ~-0.04556, got {}",
            nxy_11
        );

        // N_xy(2,2,0): further distance, ~0.27% above asymptotic
        // Reference: -5.28968456e-03
        let nxy_22 = kernels.n_xy[idx(2, 2, 0)];
        assert!(
            (nxy_22 - (-5.2897e-3)).abs() < 1e-6,
            "N_xy(2,2,0) should be ~-0.005290, got {}",
            nxy_22
        );

        // N_xy(5,5,0): far-field, matches asymptotic closely
        // Reference: -3.37642932e-04
        let nxy_55 = kernels.n_xy[idx(5, 5, 0)];
        assert!(
            (nxy_55 - (-3.3764e-4)).abs() < 5e-8,
            "N_xy(5,5,0) should be ~-3.376e-4, got {}",
            nxy_55
        );

        // N_xy along x-axis should be exactly zero (y=0 symmetry)
        let nxy_10 = kernels.n_xy[idx(1, 0, 0)];
        assert!(
            nxy_10.abs() < 1e-15,
            "N_xy(1,0,0) should be 0, got {}",
            nxy_10
        );

        // Signs: N_xy must be negative for positive (x,y) displacement
        for i in 1..5 {
            for j in 1..5 {
                let v = kernels.n_xy[idx(i, j, 0)];
                assert!(
                    v < 0.0,
                    "N_xy({},{},0) should be negative (physics: coupling pulls back), got {}",
                    i,
                    j,
                    v
                );
            }
        }
    }

    /// Verify N_xy far-field convergence to the point-dipole asymptotic.
    ///
    /// At large distances (r >> cell size), N_xy(r) → -3xy/(4πr⁵)·V.
    /// This confirms the stencil operator is correctly computing the
    /// double-volume integral of the Newell g potential.
    #[test]
    fn nxy_converges_to_asymptotic_at_large_distance() {
        // Need large enough grid to have displacements of 8+ cells
        let kernels = compute_newell_kernels(12, 12, 1, 1.0, 1.0, 1.0);
        let px = kernels.px;
        let py = kernels.py;
        let idx = |x: usize, y: usize, z: usize| z * py * px + y * px + x;

        // At r=8 cells, should match asymptotic to <0.01%
        let x = 8.0_f64;
        let y = 8.0_f64;
        let r5 = (x * x + y * y).powf(2.5);
        let n_asym = -3.0 * x * y / (4.0 * PI * r5);
        let n_stencil = kernels.n_xy[idx(8, 8, 0)];
        let rel_err = (n_stencil - n_asym).abs() / n_asym.abs();
        assert!(
            rel_err < 1e-3,
            "N_xy(8,8,0) relative error vs asymptotic: {:.4}%, expected <0.1%",
            rel_err * 100.0
        );
    }

    #[test]
    fn two_d_far_field_uses_exact_newell_instead_of_point_dipole() {
        let dx = 1.0;
        let dy = 1.0;
        let dz = 1.0;
        let kernels = compute_newell_kernels(65, 1, 1, dx, dy, dz);
        let index = 64;
        let x = 64.0;
        let y = 0.0;
        let z = 0.0;
        let expected = [
            ldia_direct(x, y, z, dx, dy, dz, newell_f),
            ldia_direct(x, y, z, dy, dx, dz, |x, y, z| newell_f(y, x, z)),
            ldia_direct(x, y, z, dz, dy, dx, |x, y, z| newell_f(z, y, x)),
            ldia_direct(x, y, z, dx, dy, dz, newell_g),
            ldia_direct(x, y, z, dx, dz, dy, |x, y, z| newell_g(x, z, y)),
            ldia_direct(x, y, z, dy, dz, dx, |x, y, z| newell_g(y, z, x)),
        ];
        let actual = [
            kernels.n_xx[index],
            kernels.n_yy[index],
            kernels.n_zz[index],
            kernels.n_xy[index],
            kernels.n_xz[index],
            kernels.n_yz[index],
        ];
        for (component, (actual, expected)) in actual.into_iter().zip(expected).enumerate() {
            assert!(
                (actual - expected).abs() <= 1e-14,
                "component {component}: {actual} != {expected}"
            );
            assert!(actual.is_finite(), "component {component} is not finite");
        }
    }

    #[test]
    fn two_d_shifted_far_field_uses_exact_newell_instead_of_point_dipole() {
        let dx = 1.0;
        let dy = 1.0;
        let dz = 1.0;
        let z_offset = 3.5;
        let kernels = compute_newell_kernels_shifted(65, 1, 1, dx, dy, dz, z_offset);
        let index = 64;
        let x = 64.0;
        let y = 0.0;
        let z = z_offset;
        let expected = [
            ldia_direct(x, y, z, dx, dy, dz, newell_f),
            ldia_direct(x, y, z, dy, dx, dz, |x, y, z| newell_f(y, x, z)),
            ldia_direct(x, y, z, dz, dy, dx, |x, y, z| newell_f(z, y, x)),
            ldia_direct(x, y, z, dx, dy, dz, newell_g),
            ldia_direct(x, y, z, dx, dz, dy, |x, y, z| newell_g(x, z, y)),
            ldia_direct(x, y, z, dy, dz, dx, |x, y, z| newell_g(y, z, x)),
        ];
        let actual = [
            kernels.n_xx[index],
            kernels.n_yy[index],
            kernels.n_zz[index],
            kernels.n_xy[index],
            kernels.n_xz[index],
            kernels.n_yz[index],
        ];
        for (component, (actual, expected)) in actual.into_iter().zip(expected).enumerate() {
            assert!(
                (actual - expected).abs() <= 1e-14,
                "component {component}: {actual} != {expected}"
            );
            assert!(actual.is_finite(), "component {component} is not finite");
        }
    }

    #[test]
    fn two_d_corner_kernel_matches_independent_reference_at_near_and_far_lags() {
        let kernels = compute_newell_kernels(65, 65, 1, 1.0, 1.0, 1.0);
        let index = |x: usize, y: usize| y * kernels.px + x;
        let expected = [
            (
                1,
                0,
                [
                    -1.350171805444950746e-1,
                    6.750859027224741238e-2,
                    6.750859027224750952e-2,
                    -2.650462234552930558e-17,
                    8.834874115176435705e-18,
                    8.834874115176435705e-18,
                ],
            ),
            (
                1,
                1,
                [
                    -1.378576204834822821e-2,
                    -1.378576204834817617e-2,
                    2.757152409669629683e-2,
                    -4.556482263891421802e-2,
                    -8.834874115176435705e-18,
                    -8.834874115176435705e-18,
                ],
            ),
            (
                5,
                5,
                [
                    -1.125344640979490126e-4,
                    -1.125344640982317318e-4,
                    2.250689282083375375e-4,
                    -3.376429321227027852e-4,
                    0.0,
                    0.0,
                ],
            ),
            (
                64,
                0,
                [
                    -6.071325582418357671e-7,
                    3.035639631116778290e-7,
                    3.035639631116778290e-7,
                    7.237528875152536130e-14,
                    7.237528875152536130e-14,
                    0.0,
                ],
            ),
        ];
        for (x, y, expected) in expected {
            let actual = [
                kernels.n_xx[index(x, y)],
                kernels.n_yy[index(x, y)],
                kernels.n_zz[index(x, y)],
                kernels.n_xy[index(x, y)],
                kernels.n_xz[index(x, y)],
                kernels.n_yz[index(x, y)],
            ];
            for (component, (actual, expected)) in actual.into_iter().zip(expected).enumerate() {
                assert!(
                    (actual - expected).abs() <= 1e-14,
                    "lag ({x},{y},0) component {component}: {actual} != {expected}"
                );
            }
        }
    }

    /// Validate thin-film demagnetization factor ordering.
    ///
    /// For a thin cell (dz < dx), the out-of-plane demagnetization factor N_zz
    /// must be greater than N_xx = N_yy (shape anisotropy prefers in-plane).
    /// For a 5:5:1 cell: N_zz ≈ 0.694, N_xx = N_yy ≈ 0.153.
    /// For extremely thin (50:50:1) cells: N_zz → 1.
    #[test]
    fn thin_film_self_term_nzz_dominates() {
        // 1×1×1 cell, very thin: dx=dy=5nm, dz=1nm (aspect ratio 5)
        let kernels = compute_newell_kernels(1, 1, 1, 5e-9, 5e-9, 1e-9);
        // N_zz must be the largest component (thin-film easy-plane enforced by shape)
        assert!(
            kernels.n_zz[0] > kernels.n_xx[0],
            "Thin film N_zz ({}) should be > N_xx ({})",
            kernels.n_zz[0],
            kernels.n_xx[0]
        );
        // N_xx + N_yy + N_zz = 1 always
        let trace = kernels.n_xx[0] + kernels.n_yy[0] + kernels.n_zz[0];
        assert!(
            (trace - 1.0).abs() < 1e-10,
            "Trace must be 1.0, got {}",
            trace
        );
        // For 5:1 aspect ratio, N_zz should be well above 1/3
        assert!(
            kernels.n_zz[0] > 0.5,
            "N_zz ({}) should be > 0.5 for 5:1 aspect ratio cell",
            kernels.n_zz[0]
        );
    }

    #[test]
    fn shared_positive_lags_are_independent_of_target_z_extent() {
        let narrow = compute_newell_kernels(160, 40, 18, 3.125e-9, 3.125e-9, 3.0e-9);
        let wide = compute_newell_kernels(160, 40, 24, 3.125e-9, 3.125e-9, 3.0e-9);
        for k in 0..18 {
            for j in 0..40 {
                for i in 0..160 {
                    let narrow_index = k * narrow.py * narrow.px + j * narrow.px + i;
                    let wide_index = k * wide.py * wide.px + j * wide.px + i;
                    for (name, left, right) in [
                        ("xx", narrow.n_xx[narrow_index], wide.n_xx[wide_index]),
                        ("yy", narrow.n_yy[narrow_index], wide.n_yy[wide_index]),
                        ("zz", narrow.n_zz[narrow_index], wide.n_zz[wide_index]),
                        ("xy", narrow.n_xy[narrow_index], wide.n_xy[wide_index]),
                        ("xz", narrow.n_xz[narrow_index], wide.n_xz[wide_index]),
                        ("yz", narrow.n_yz[narrow_index], wide.n_yz[wide_index]),
                    ] {
                        assert_eq!(left, right, "{name} mismatch at ({i},{j},{k})");
                    }
                    if k > 0 {
                        let narrow_negative =
                            (narrow.pz - k) * narrow.py * narrow.px + j * narrow.px + i;
                        let wide_negative = (wide.pz - k) * wide.py * wide.px + j * wide.px + i;
                        for (name, left, right) in [
                            (
                                "xx-",
                                narrow.n_xx[narrow_negative],
                                wide.n_xx[wide_negative],
                            ),
                            (
                                "yy-",
                                narrow.n_yy[narrow_negative],
                                wide.n_yy[wide_negative],
                            ),
                            (
                                "zz-",
                                narrow.n_zz[narrow_negative],
                                wide.n_zz[wide_negative],
                            ),
                            (
                                "xy-",
                                narrow.n_xy[narrow_negative],
                                wide.n_xy[wide_negative],
                            ),
                            (
                                "xz-",
                                narrow.n_xz[narrow_negative],
                                wide.n_xz[wide_negative],
                            ),
                            (
                                "yz-",
                                narrow.n_yz[narrow_negative],
                                wide.n_yz[wide_negative],
                            ),
                        ] {
                            assert_eq!(left, right, "{name} mismatch at ({i},{j},-{k})");
                        }
                    }
                }
            }
        }
    }
}
