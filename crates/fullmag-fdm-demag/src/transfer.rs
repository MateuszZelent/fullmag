//! Transfer operators between native and convolution grids.
//!
//! - `push_m`: native → convolution (volume-weighted cell average for coarsening,
//!   piecewise-constant for refinement)
//! - `pull_h`: convolution → native (trilinear interpolation)
//!
//! V1 design: simple axis-aligned box grids only.

/// Resolved boundary policy consumed by native/convolution-grid transfer.
///
/// This is deliberately backend-neutral: the planner/runner converts the
/// canonical FDM periodicity axes into this compact policy before invoking
/// either transfer direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransferBoundaryPolicy {
    pub periodic_axes: [bool; 3],
}

impl TransferBoundaryPolicy {
    pub const OPEN: Self = Self {
        periodic_axes: [false; 3],
    };

    pub const fn from_periodic_axes(periodic_axes: [bool; 3]) -> Self {
        Self { periodic_axes }
    }

    pub const fn is_periodic(self, axis: usize) -> bool {
        self.periodic_axes[axis]
    }
}

impl Default for TransferBoundaryPolicy {
    fn default() -> Self {
        Self::OPEN
    }
}

/// Push magnetization from native grid to convolution grid.
///
/// For coarsening (convolution cells larger than native cells):
///   each convolution cell averages all native cells that overlap it.
///
/// For refinement (convolution cells smaller than native cells):
///   each convolution cell copies from its containing native cell.
///
/// For identity (same grid): simple copy.
pub fn push_m(
    native_m: &[[f64; 3]],
    native_cells: [usize; 3],
    native_cell_size: [f64; 3],
    conv_cells: [usize; 3],
    conv_cell_size: [f64; 3],
) -> Vec<[f64; 3]> {
    push_m_with_boundary_policy(
        native_m,
        native_cells,
        native_cell_size,
        conv_cells,
        conv_cell_size,
        TransferBoundaryPolicy::OPEN,
    )
}

/// Push magnetization with an explicit resolved boundary policy.
pub fn push_m_with_boundary_policy(
    native_m: &[[f64; 3]],
    native_cells: [usize; 3],
    native_cell_size: [f64; 3],
    conv_cells: [usize; 3],
    conv_cell_size: [f64; 3],
    boundary_policy: TransferBoundaryPolicy,
) -> Vec<[f64; 3]> {
    let conv_total = conv_cells[0] * conv_cells[1] * conv_cells[2];

    // Identity fast path
    if native_cells == conv_cells {
        return native_m.to_vec();
    }

    let mut conv_m = vec![[0.0, 0.0, 0.0]; conv_total];

    // For each convolution cell, find overlapping native cells
    for cz in 0..conv_cells[2] {
        for cy in 0..conv_cells[1] {
            for cx in 0..conv_cells[0] {
                let conv_idx = cz * conv_cells[1] * conv_cells[0] + cy * conv_cells[0] + cx;

                // Physical extent of this convolution cell
                let c_lo = [
                    cx as f64 * conv_cell_size[0],
                    cy as f64 * conv_cell_size[1],
                    cz as f64 * conv_cell_size[2],
                ];
                let c_hi = [
                    c_lo[0] + conv_cell_size[0],
                    c_lo[1] + conv_cell_size[1],
                    c_lo[2] + conv_cell_size[2],
                ];

                // Find native cells that overlap
                let mut total_vol = 0.0;
                let mut acc = [0.0, 0.0, 0.0];

                let nx_lo = (c_lo[0] / native_cell_size[0]).floor() as isize;
                let nx_hi = (c_hi[0] / native_cell_size[0]).ceil() as isize;
                let ny_lo = (c_lo[1] / native_cell_size[1]).floor() as isize;
                let ny_hi = (c_hi[1] / native_cell_size[1]).ceil() as isize;
                let nz_lo = (c_lo[2] / native_cell_size[2]).floor() as isize;
                let nz_hi = (c_hi[2] / native_cell_size[2]).ceil() as isize;
                let nx_range = if boundary_policy.is_periodic(0) {
                    0..native_cells[0] as isize
                } else {
                    nx_lo.max(0)..nx_hi.min(native_cells[0] as isize)
                };
                let ny_range = if boundary_policy.is_periodic(1) {
                    0..native_cells[1] as isize
                } else {
                    ny_lo.max(0)..ny_hi.min(native_cells[1] as isize)
                };
                let nz_range = if boundary_policy.is_periodic(2) {
                    0..native_cells[2] as isize
                } else {
                    nz_lo.max(0)..nz_hi.min(native_cells[2] as isize)
                };

                for nz in nz_range {
                    for ny in ny_range.clone() {
                        for nx in nx_range.clone() {
                            if nx < 0
                                || ny < 0
                                || nz < 0
                                || nx as usize >= native_cells[0]
                                || ny as usize >= native_cells[1]
                                || nz as usize >= native_cells[2]
                            {
                                continue;
                            }
                            let nx = nx as usize;
                            let ny = ny as usize;
                            let nz = nz as usize;

                            // Overlap volume
                            let n_lo = [
                                nx as f64 * native_cell_size[0],
                                ny as f64 * native_cell_size[1],
                                nz as f64 * native_cell_size[2],
                            ];
                            let n_hi = [
                                n_lo[0] + native_cell_size[0],
                                n_lo[1] + native_cell_size[1],
                                n_lo[2] + native_cell_size[2],
                            ];

                            let overlap_vol = overlap_length(
                                c_lo[0],
                                c_hi[0],
                                n_lo[0],
                                n_hi[0],
                                native_cells[0] as f64 * native_cell_size[0],
                                boundary_policy.is_periodic(0),
                            ) * overlap_length(
                                c_lo[1],
                                c_hi[1],
                                n_lo[1],
                                n_hi[1],
                                native_cells[1] as f64 * native_cell_size[1],
                                boundary_policy.is_periodic(1),
                            ) * overlap_length(
                                c_lo[2],
                                c_hi[2],
                                n_lo[2],
                                n_hi[2],
                                native_cells[2] as f64 * native_cell_size[2],
                                boundary_policy.is_periodic(2),
                            );

                            if overlap_vol > 0.0 {
                                let n_idx = nz * native_cells[1] * native_cells[0]
                                    + ny * native_cells[0]
                                    + nx;
                                let m = native_m[n_idx];
                                acc[0] += m[0] * overlap_vol;
                                acc[1] += m[1] * overlap_vol;
                                acc[2] += m[2] * overlap_vol;
                                total_vol += overlap_vol;
                            }
                        }
                    }
                }

                if total_vol > 0.0 {
                    conv_m[conv_idx] = [acc[0] / total_vol, acc[1] / total_vol, acc[2] / total_vol];
                }
            }
        }
    }

    conv_m
}

/// Pull demagnetization field from convolution grid back to native grid.
///
/// Uses trilinear interpolation at native cell centers.
/// For identity grids: simple copy.
pub fn pull_h(
    conv_h: &[[f64; 3]],
    conv_cells: [usize; 3],
    conv_cell_size: [f64; 3],
    native_cells: [usize; 3],
    native_cell_size: [f64; 3],
) -> Vec<[f64; 3]> {
    pull_h_with_boundary_policy(
        conv_h,
        conv_cells,
        conv_cell_size,
        native_cells,
        native_cell_size,
        TransferBoundaryPolicy::OPEN,
    )
}

/// Pull demagnetization field with an explicit resolved boundary policy.
pub fn pull_h_with_boundary_policy(
    conv_h: &[[f64; 3]],
    conv_cells: [usize; 3],
    conv_cell_size: [f64; 3],
    native_cells: [usize; 3],
    native_cell_size: [f64; 3],
    boundary_policy: TransferBoundaryPolicy,
) -> Vec<[f64; 3]> {
    let native_total = native_cells[0] * native_cells[1] * native_cells[2];

    // Identity fast path
    if native_cells == conv_cells {
        return conv_h.to_vec();
    }

    let mut native_h = vec![[0.0, 0.0, 0.0]; native_total];

    for nz in 0..native_cells[2] {
        for ny in 0..native_cells[1] {
            for nx in 0..native_cells[0] {
                let n_idx = nz * native_cells[1] * native_cells[0] + ny * native_cells[0] + nx;

                // Native cell center in physical coordinates
                let center = [
                    (nx as f64 + 0.5) * native_cell_size[0],
                    (ny as f64 + 0.5) * native_cell_size[1],
                    (nz as f64 + 0.5) * native_cell_size[2],
                ];

                // Find position in convolution grid (fractional indices)
                let fx = center[0] / conv_cell_size[0] - 0.5;
                let fy = center[1] / conv_cell_size[1] - 0.5;
                let fz = center[2] / conv_cell_size[2] - 0.5;

                native_h[n_idx] = trilinear_sample_with_boundary_policy(
                    conv_h,
                    conv_cells,
                    fx,
                    fy,
                    fz,
                    boundary_policy,
                );
            }
        }
    }

    native_h
}

fn trilinear_sample_with_boundary_policy(
    data: &[[f64; 3]],
    cells: [usize; 3],
    fx: f64,
    fy: f64,
    fz: f64,
    boundary_policy: TransferBoundaryPolicy,
) -> [f64; 3] {
    let x0 = fx.floor() as isize;
    let y0 = fy.floor() as isize;
    let z0 = fz.floor() as isize;

    let wx = fx - fx.floor();
    let wy = fy - fy.floor();
    let wz = fz - fz.floor();

    let mut result = [0.0, 0.0, 0.0];

    for dz in 0..2 {
        for dy in 0..2 {
            for dx in 0..2 {
                let ix = transfer_index(x0 + dx as isize, cells[0], boundary_policy.is_periodic(0));
                let iy = transfer_index(y0 + dy as isize, cells[1], boundary_policy.is_periodic(1));
                let iz = transfer_index(z0 + dz as isize, cells[2], boundary_policy.is_periodic(2));

                let w = if dx == 0 { 1.0 - wx } else { wx }
                    * if dy == 0 { 1.0 - wy } else { wy }
                    * if dz == 0 { 1.0 - wz } else { wz };

                let idx = iz * cells[1] * cells[0] + iy * cells[0] + ix;
                let val = data[idx];
                result[0] += val[0] * w;
                result[1] += val[1] * w;
                result[2] += val[2] * w;
            }
        }
    }

    result
}

fn transfer_index(i: isize, n: usize, periodic: bool) -> usize {
    if n == 0 {
        return 0;
    }
    if periodic {
        i.rem_euclid(n as isize) as usize
    } else {
        i.clamp(0, n as isize - 1) as usize
    }
}

fn overlap_length(c_lo: f64, c_hi: f64, n_lo: f64, n_hi: f64, period: f64, periodic: bool) -> f64 {
    if !periodic {
        return (c_hi.min(n_hi) - c_lo.max(n_lo)).max(0.0);
    }
    let first = (c_lo / period).floor() as isize - 1;
    let last = (c_hi / period).ceil() as isize + 1;
    (first..=last)
        .map(|image| {
            let shift = image as f64 * period;
            (c_hi.min(n_hi + shift) - c_lo.max(n_lo + shift)).max(0.0)
        })
        .sum()
}

/// `f32` variant of [`push_m`].
pub fn push_m_f32(
    native_m: &[[f32; 3]],
    native_cells: [usize; 3],
    native_cell_size: [f64; 3],
    conv_cells: [usize; 3],
    conv_cell_size: [f64; 3],
) -> Vec<[f32; 3]> {
    push_m_f32_with_boundary_policy(
        native_m,
        native_cells,
        native_cell_size,
        conv_cells,
        conv_cell_size,
        TransferBoundaryPolicy::OPEN,
    )
}

/// `f32` variant of [`push_m_with_boundary_policy`].
pub fn push_m_f32_with_boundary_policy(
    native_m: &[[f32; 3]],
    native_cells: [usize; 3],
    native_cell_size: [f64; 3],
    conv_cells: [usize; 3],
    conv_cell_size: [f64; 3],
    boundary_policy: TransferBoundaryPolicy,
) -> Vec<[f32; 3]> {
    let conv_total = conv_cells[0] * conv_cells[1] * conv_cells[2];

    if native_cells == conv_cells {
        return native_m.to_vec();
    }

    let mut conv_m = vec![[0.0f32, 0.0f32, 0.0f32]; conv_total];

    for cz in 0..conv_cells[2] {
        for cy in 0..conv_cells[1] {
            for cx in 0..conv_cells[0] {
                let conv_idx = cz * conv_cells[1] * conv_cells[0] + cy * conv_cells[0] + cx;
                let c_lo = [
                    cx as f64 * conv_cell_size[0],
                    cy as f64 * conv_cell_size[1],
                    cz as f64 * conv_cell_size[2],
                ];
                let c_hi = [
                    c_lo[0] + conv_cell_size[0],
                    c_lo[1] + conv_cell_size[1],
                    c_lo[2] + conv_cell_size[2],
                ];

                let mut total_vol = 0.0f64;
                let mut acc = [0.0f64, 0.0f64, 0.0f64];

                let nx_lo = (c_lo[0] / native_cell_size[0]).floor() as isize;
                let nx_hi = (c_hi[0] / native_cell_size[0]).ceil() as isize;
                let ny_lo = (c_lo[1] / native_cell_size[1]).floor() as isize;
                let ny_hi = (c_hi[1] / native_cell_size[1]).ceil() as isize;
                let nz_lo = (c_lo[2] / native_cell_size[2]).floor() as isize;
                let nz_hi = (c_hi[2] / native_cell_size[2]).ceil() as isize;
                let nx_range = if boundary_policy.is_periodic(0) {
                    0..native_cells[0] as isize
                } else {
                    nx_lo.max(0)..nx_hi.min(native_cells[0] as isize)
                };
                let ny_range = if boundary_policy.is_periodic(1) {
                    0..native_cells[1] as isize
                } else {
                    ny_lo.max(0)..ny_hi.min(native_cells[1] as isize)
                };
                let nz_range = if boundary_policy.is_periodic(2) {
                    0..native_cells[2] as isize
                } else {
                    nz_lo.max(0)..nz_hi.min(native_cells[2] as isize)
                };

                for nz in nz_range {
                    for ny in ny_range.clone() {
                        for nx in nx_range.clone() {
                            if nx < 0
                                || ny < 0
                                || nz < 0
                                || nx as usize >= native_cells[0]
                                || ny as usize >= native_cells[1]
                                || nz as usize >= native_cells[2]
                            {
                                continue;
                            }
                            let nx = nx as usize;
                            let ny = ny as usize;
                            let nz = nz as usize;

                            let n_lo = [
                                nx as f64 * native_cell_size[0],
                                ny as f64 * native_cell_size[1],
                                nz as f64 * native_cell_size[2],
                            ];
                            let n_hi = [
                                n_lo[0] + native_cell_size[0],
                                n_lo[1] + native_cell_size[1],
                                n_lo[2] + native_cell_size[2],
                            ];

                            let overlap_vol = overlap_length(
                                c_lo[0],
                                c_hi[0],
                                n_lo[0],
                                n_hi[0],
                                native_cells[0] as f64 * native_cell_size[0],
                                boundary_policy.is_periodic(0),
                            ) * overlap_length(
                                c_lo[1],
                                c_hi[1],
                                n_lo[1],
                                n_hi[1],
                                native_cells[1] as f64 * native_cell_size[1],
                                boundary_policy.is_periodic(1),
                            ) * overlap_length(
                                c_lo[2],
                                c_hi[2],
                                n_lo[2],
                                n_hi[2],
                                native_cells[2] as f64 * native_cell_size[2],
                                boundary_policy.is_periodic(2),
                            );

                            if overlap_vol > 0.0 {
                                let n_idx = nz * native_cells[1] * native_cells[0]
                                    + ny * native_cells[0]
                                    + nx;
                                let m = native_m[n_idx];
                                acc[0] += m[0] as f64 * overlap_vol;
                                acc[1] += m[1] as f64 * overlap_vol;
                                acc[2] += m[2] as f64 * overlap_vol;
                                total_vol += overlap_vol;
                            }
                        }
                    }
                }

                if total_vol > 0.0 {
                    conv_m[conv_idx] = [
                        (acc[0] / total_vol) as f32,
                        (acc[1] / total_vol) as f32,
                        (acc[2] / total_vol) as f32,
                    ];
                }
            }
        }
    }

    conv_m
}

/// `f32` variant of [`pull_h`].
pub fn pull_h_f32(
    conv_h: &[[f32; 3]],
    conv_cells: [usize; 3],
    conv_cell_size: [f64; 3],
    native_cells: [usize; 3],
    native_cell_size: [f64; 3],
) -> Vec<[f32; 3]> {
    pull_h_f32_with_boundary_policy(
        conv_h,
        conv_cells,
        conv_cell_size,
        native_cells,
        native_cell_size,
        TransferBoundaryPolicy::OPEN,
    )
}

/// `f32` variant of [`pull_h_with_boundary_policy`].
pub fn pull_h_f32_with_boundary_policy(
    conv_h: &[[f32; 3]],
    conv_cells: [usize; 3],
    conv_cell_size: [f64; 3],
    native_cells: [usize; 3],
    native_cell_size: [f64; 3],
    boundary_policy: TransferBoundaryPolicy,
) -> Vec<[f32; 3]> {
    let native_total = native_cells[0] * native_cells[1] * native_cells[2];

    if native_cells == conv_cells {
        return conv_h.to_vec();
    }

    let mut native_h = vec![[0.0f32, 0.0f32, 0.0f32]; native_total];

    for nz in 0..native_cells[2] {
        for ny in 0..native_cells[1] {
            for nx in 0..native_cells[0] {
                let n_idx = nz * native_cells[1] * native_cells[0] + ny * native_cells[0] + nx;
                let center = [
                    (nx as f64 + 0.5) * native_cell_size[0],
                    (ny as f64 + 0.5) * native_cell_size[1],
                    (nz as f64 + 0.5) * native_cell_size[2],
                ];
                let fx = center[0] / conv_cell_size[0] - 0.5;
                let fy = center[1] / conv_cell_size[1] - 0.5;
                let fz = center[2] / conv_cell_size[2] - 0.5;

                native_h[n_idx] = trilinear_sample_f32_with_boundary_policy(
                    conv_h,
                    conv_cells,
                    fx,
                    fy,
                    fz,
                    boundary_policy,
                );
            }
        }
    }

    native_h
}

fn trilinear_sample_f32_with_boundary_policy(
    data: &[[f32; 3]],
    cells: [usize; 3],
    fx: f64,
    fy: f64,
    fz: f64,
    boundary_policy: TransferBoundaryPolicy,
) -> [f32; 3] {
    let x0 = fx.floor() as isize;
    let y0 = fy.floor() as isize;
    let z0 = fz.floor() as isize;

    let wx = fx - fx.floor();
    let wy = fy - fy.floor();
    let wz = fz - fz.floor();

    let mut result = [0.0f64, 0.0f64, 0.0f64];

    for dz in 0..2 {
        for dy in 0..2 {
            for dx in 0..2 {
                let ix = transfer_index(x0 + dx as isize, cells[0], boundary_policy.is_periodic(0));
                let iy = transfer_index(y0 + dy as isize, cells[1], boundary_policy.is_periodic(1));
                let iz = transfer_index(z0 + dz as isize, cells[2], boundary_policy.is_periodic(2));

                let w = if dx == 0 { 1.0 - wx } else { wx }
                    * if dy == 0 { 1.0 - wy } else { wy }
                    * if dz == 0 { 1.0 - wz } else { wz };

                let idx = iz * cells[1] * cells[0] + iy * cells[0] + ix;
                let val = data[idx];
                result[0] += val[0] as f64 * w;
                result[1] += val[1] as f64 * w;
                result[2] += val[2] as f64 * w;
            }
        }
    }

    [result[0] as f32, result[1] as f32, result[2] as f32]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_transfer_is_noop() {
        let m = vec![[1.0, 0.0, 0.0]; 8];
        let cells = [2, 2, 2];
        let cs = [1e-9, 1e-9, 1e-9];

        let pushed = push_m(&m, cells, cs, cells, cs);
        assert_eq!(pushed.len(), 8);
        for v in &pushed {
            assert!((v[0] - 1.0).abs() < 1e-15);
        }

        let pulled = pull_h(&m, cells, cs, cells, cs);
        for v in &pulled {
            assert!((v[0] - 1.0).abs() < 1e-15);
        }
    }

    #[test]
    fn push_m_coarsening_averages() {
        // 4×4×1 native → 2×2×1 convolution
        let native_cells = [4, 4, 1];
        let conv_cells = [2, 2, 1];
        let native_cs = [1e-9, 1e-9, 1e-9];
        let conv_cs = [2e-9, 2e-9, 1e-9];

        let mut m = vec![[1.0, 0.0, 0.0]; 16];
        // Set bottom-left quadrant to [2, 0, 0]
        m[0] = [2.0, 0.0, 0.0];
        m[1] = [2.0, 0.0, 0.0];
        m[4] = [2.0, 0.0, 0.0];
        m[5] = [2.0, 0.0, 0.0];

        let pushed = push_m(&m, native_cells, native_cs, conv_cells, conv_cs);
        assert_eq!(pushed.len(), 4);
        // Bottom-left conv cell should average to [2, 0, 0]
        assert!((pushed[0][0] - 2.0).abs() < 1e-12);
        // Top-right conv cell should stay [1, 0, 0]
        assert!((pushed[3][0] - 1.0).abs() < 1e-12);
    }

    #[test]
    fn pull_h_mixed_boundary_policy_wraps_only_periodic_axis() {
        let conv_cells = [2, 2, 1];
        let native_cells = [1, 1, 1];
        let conv_size = [1.0, 1.0, 1.0];
        let native_size = [0.5, 0.5, 0.5];
        let conv_h = vec![
            [10.0, 0.0, 0.0],
            [20.0, 0.0, 0.0],
            [100.0, 0.0, 0.0],
            [100.0, 0.0, 0.0],
        ];

        let periodic_x = pull_h_with_boundary_policy(
            &conv_h,
            conv_cells,
            conv_size,
            native_cells,
            native_size,
            TransferBoundaryPolicy::from_periodic_axes([true, false, false]),
        );
        assert!((periodic_x[0][0] - 12.5).abs() < 1e-12);

        let periodic_y = pull_h_with_boundary_policy(
            &conv_h,
            conv_cells,
            conv_size,
            native_cells,
            native_size,
            TransferBoundaryPolicy::from_periodic_axes([false, true, false]),
        );
        assert!((periodic_y[0][0] - 32.5).abs() < 1e-12);
    }

    #[test]
    fn pull_h_f32_mixed_boundary_policy_wraps_periodic_axis() {
        let conv_h = vec![
            [10.0f32, 0.0, 0.0],
            [20.0f32, 0.0, 0.0],
            [100.0f32, 0.0, 0.0],
            [100.0f32, 0.0, 0.0],
        ];
        let result = pull_h_f32_with_boundary_policy(
            &conv_h,
            [2, 2, 1],
            [1.0, 1.0, 1.0],
            [1, 1, 1],
            [0.5, 0.5, 0.5],
            TransferBoundaryPolicy::from_periodic_axes([true, false, false]),
        );
        assert!((result[0][0] - 12.5).abs() < 1e-5);
    }

    #[test]
    fn push_m_wraps_periodic_source_into_extended_target() {
        let native_m = vec![[7.0, 0.0, 0.0]];
        let open = push_m_with_boundary_policy(
            &native_m,
            [1, 1, 1],
            [1.0, 1.0, 1.0],
            [3, 1, 1],
            [0.5, 1.0, 1.0],
            TransferBoundaryPolicy::OPEN,
        );
        assert_eq!(open[2][0], 0.0);

        let periodic = push_m_with_boundary_policy(
            &native_m,
            [1, 1, 1],
            [1.0, 1.0, 1.0],
            [3, 1, 1],
            [0.5, 1.0, 1.0],
            TransferBoundaryPolicy::from_periodic_axes([true, false, false]),
        );
        assert!((periodic[2][0] - 7.0).abs() < 1e-12);
    }

    #[test]
    fn push_m_f32_wraps_periodic_source_into_extended_target() {
        let native_m = vec![[7.0f32, 0.0, 0.0]];
        let periodic = push_m_f32_with_boundary_policy(
            &native_m,
            [1, 1, 1],
            [1.0, 1.0, 1.0],
            [3, 1, 1],
            [0.5, 1.0, 1.0],
            TransferBoundaryPolicy::from_periodic_axes([true, false, false]),
        );
        assert!((periodic[2][0] - 7.0).abs() < 1e-5);
    }
}
