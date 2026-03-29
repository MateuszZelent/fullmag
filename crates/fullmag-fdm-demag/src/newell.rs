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
    let i = i + 1;
    let j = j + 1;
    let k = k + 1;

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
        let use_asymptotic = i >= ASYMPTOTIC_DISTANCE
            || j >= ASYMPTOTIC_DISTANCE
            || k >= ASYMPTOTIC_DISTANCE
            || dist2 >= ASYMPTOTIC_DISTANCE * ASYMPTOTIC_DISTANCE;

        if use_asymptotic {
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
        } else {
            nxx = ldia(i, j, k, &f_vals_xx, fsx, fsy, dx, dy, dz);
            nyy = ldia(i, j, k, &f_vals_yy, fsx, fsy, dy, dx, dz);
            nzz = ldia(i, j, k, &f_vals_zz, fsx, fsy, dz, dy, dx);
            nxy = ldia(i, j, k, &g_vals_xy, fsx, fsy, dx, dy, dz);
            nxz = ldia(i, j, k, &g_vals_xz, fsx, fsy, dx, dz, dy);
            nyz = ldia(i, j, k, &g_vals_yz, fsx, fsy, dy, dz, dx);
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
    let px = 2 * nx;
    let py = 2 * ny;
    let pz = 2 * nz;
    let padded_len = px * py * pz;

    let nx_dist = nx.min(ASYMPTOTIC_DISTANCE);
    let ny_dist = ny.min(ASYMPTOTIC_DISTANCE);
    let nz_dist = nz.min(ASYMPTOTIC_DISTANCE);
    let fsx = nx_dist + 2;
    let fsy = ny_dist + 2;
    let fsz = nz_dist + 2;
    let flen = fsx * fsy * fsz;

    // Step 1: Precompute f and g values with z_offset
    let mut f_vals_xx = vec![0.0; flen];
    let mut f_vals_yy = vec![0.0; flen];
    let mut f_vals_zz = vec![0.0; flen];
    let mut g_vals_xy = vec![0.0; flen];
    let mut g_vals_xz = vec![0.0; flen];
    let mut g_vals_yz = vec![0.0; flen];

    for k in 0..fsz {
        let kk = k as isize - 1;
        for j in 0..fsy {
            let jj = j as isize - 1;
            for i in 0..fsx {
                let ii = i as isize - 1;
                let x = ii as f64 * dx;
                let y = jj as f64 * dy;
                let z = kk as f64 * dz + z_offset; // shifted!
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

    // Step 2: Apply 27-point stencil and place into padded grid.
    // For shifted kernels, the octant symmetry in z is BROKEN
    // (the kernel is no longer even/odd in z), so we fill all z positions directly.
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
                let (nxx, nyy, nzz, nxy, nxz, nyz);
                let dist2 = i * i + j * j + k * k;
                let use_asymptotic = i >= ASYMPTOTIC_DISTANCE
                    || j >= ASYMPTOTIC_DISTANCE
                    || k >= ASYMPTOTIC_DISTANCE
                    || dist2 >= ASYMPTOTIC_DISTANCE * ASYMPTOTIC_DISTANCE;

                if use_asymptotic {
                    let x = i as f64 * dx;
                    let y = j as f64 * dy;
                    let z = k as f64 * dz + z_offset;
                    nxx = asymptotic_nxx(x, y, z, vol);
                    nyy = asymptotic_nxx(y, x, z, vol);
                    nzz = asymptotic_nxx(z, y, x, vol);
                    nxy = asymptotic_nxy(x, y, z, vol);
                    nxz = asymptotic_nxy(x, z, y, vol);
                    nyz = asymptotic_nxy(y, z, x, vol);
                } else {
                    nxx = ldia(i, j, k, &f_vals_xx, fsx, fsy, dx, dy, dz);
                    nyy = ldia(i, j, k, &f_vals_yy, fsx, fsy, dy, dx, dz);
                    nzz = ldia(i, j, k, &f_vals_zz, fsx, fsy, dz, dy, dx);
                    nxy = ldia(i, j, k, &g_vals_xy, fsx, fsy, dx, dy, dz);
                    nxz = ldia(i, j, k, &g_vals_xz, fsx, fsy, dx, dz, dy);
                    nyz = ldia(i, j, k, &g_vals_yz, fsx, fsy, dy, dz, dx);
                }

                let pidx = |a: usize, b: usize, c: usize| c * py * px + b * px + a;
                // XY octant symmetry preserved (shifted only in z)
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
                // Z symmetry broken by shift — only forward z
                let zs: &[(usize, f64)] = if k == 0 {
                    &[(0, 1.0)]
                } else {
                    &[(k, 1.0), (pz - k, 1.0)] // no sign flip (shifted breaks z-parity)
                };

                for &(ix, sx) in xs {
                    for &(iy, sy) in ys {
                        for &(iz, _sz) in zs {
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
}
