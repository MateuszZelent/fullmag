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
    // Only compute up to ASYMPTOTIC_DISTANCE (matching Boris's fill_f_vals
    // which limits nx_dist = minimum(n.x, asymptotic_distance)).
    let nx_dist = nx.min(ASYMPTOTIC_DISTANCE);
    let ny_dist = ny.min(ASYMPTOTIC_DISTANCE);
    let nz_dist = nz.min(ASYMPTOTIC_DISTANCE);
    let fsx = nx_dist + 2;
    let fsy = ny_dist + 2;
    let fsz = nz_dist + 2;
    let flen = fsx * fsy * fsz;

    let mut f_vals_xx = vec![0.0; flen];
    let mut f_vals_yy = vec![0.0; flen];
    let mut f_vals_zz = vec![0.0; flen];
    let mut g_vals_xy = vec![0.0; flen];
    let mut g_vals_xz = vec![0.0; flen];
    let mut g_vals_yz = vec![0.0; flen];

    let fidx = |a: usize, b: usize, c: usize| c * fsy * fsx + b * fsx + a;

    for k in 0..fsz {
        let kk = k as isize - 1; // signed k: -1..nz
        for j in 0..fsy {
            let jj = j as isize - 1; // signed j: -1..ny
            for i in 0..fsx {
                let ii = i as isize - 1; // signed i: -1..nx
                let x = ii as f64 * dx;
                let y = jj as f64 * dy;
                let z = kk as f64 * dz;
                let idx = fidx(i, j, k);

                // N_xx: f(x, y, z)
                f_vals_xx[idx] = newell_f(x, y, z);
                // N_yy: f(y, x, z) — permuted
                f_vals_yy[idx] = newell_f(y, x, z);
                // N_zz: f(z, y, x) — permuted
                f_vals_zz[idx] = newell_f(z, y, x);
                // N_xy: g(x, y, z)
                g_vals_xy[idx] = newell_g(x, y, z);
                // N_xz: g(x, z, y) — swap y,z
                g_vals_xz[idx] = newell_g(x, z, y);
                // N_yz: g(y, z, x) — cyclic
                g_vals_yz[idx] = newell_g(y, z, x);
            }
        }
    }

    // Step 2: Apply 27-point stencil and place into padded grid.
    let mut n_xx = vec![0.0; padded_len];
    let mut n_yy = vec![0.0; padded_len];
    let mut n_zz = vec![0.0; padded_len];
    let mut n_xy = vec![0.0; padded_len];
    let mut n_xz = vec![0.0; padded_len];
    let mut n_yz = vec![0.0; padded_len];

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
                    // Far-field: use point-dipole asymptotic formula
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
                    // Near-field: exact 27-point stencil
                    nxx = ldia(i, j, k, &f_vals_xx, fsx, fsy, dx, dy, dz);
                    nyy = ldia(i, j, k, &f_vals_yy, fsx, fsy, dy, dx, dz);
                    nzz = ldia(i, j, k, &f_vals_zz, fsx, fsy, dz, dy, dx);
                    nxy = ldia(i, j, k, &g_vals_xy, fsx, fsy, dx, dy, dz);
                    nxz = ldia(i, j, k, &g_vals_xz, fsx, fsy, dx, dz, dy);
                    nyz = ldia(i, j, k, &g_vals_yz, fsx, fsy, dy, dz, dx);
                }

                // Place into all 8 octants with correct parity.
                let pidx = |a: usize, b: usize, c: usize| c * py * px + b * px + a;

                // Generate reflected indices
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
                            // Diagonal: even in all indices
                            n_xx[p] = nxx;
                            n_yy[p] = nyy;
                            n_zz[p] = nzz;
                            // Off-diagonal: odd in two active indices
                            n_xy[p] = nxy * sx * sy;
                            n_xz[p] = nxz * sx * sz;
                            n_yz[p] = nyz * sy * sz;
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
}
