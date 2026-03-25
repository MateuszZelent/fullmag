//! Transfer operators between native and convolution grids.
//!
//! - `push_m`: native → convolution (volume-weighted cell average for coarsening,
//!   piecewise-constant for refinement)
//! - `pull_h`: convolution → native (trilinear interpolation)
//!
//! V1 design: simple axis-aligned box grids only.

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

                for nz in nz_lo..nz_hi {
                    for ny in ny_lo..ny_hi {
                        for nx in nx_lo..nx_hi {
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

                            let overlap_vol = (c_hi[0].min(n_hi[0]) - c_lo[0].max(n_lo[0])).max(0.0)
                                * (c_hi[1].min(n_hi[1]) - c_lo[1].max(n_lo[1])).max(0.0)
                                * (c_hi[2].min(n_hi[2]) - c_lo[2].max(n_lo[2])).max(0.0);

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
                    conv_m[conv_idx] = [
                        acc[0] / total_vol,
                        acc[1] / total_vol,
                        acc[2] / total_vol,
                    ];
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
    let native_total = native_cells[0] * native_cells[1] * native_cells[2];

    // Identity fast path
    if native_cells == conv_cells {
        return conv_h.to_vec();
    }

    let mut native_h = vec![[0.0, 0.0, 0.0]; native_total];

    for nz in 0..native_cells[2] {
        for ny in 0..native_cells[1] {
            for nx in 0..native_cells[0] {
                let n_idx =
                    nz * native_cells[1] * native_cells[0] + ny * native_cells[0] + nx;

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

                native_h[n_idx] = trilinear_sample(conv_h, conv_cells, fx, fy, fz);
            }
        }
    }

    native_h
}

/// Trilinear interpolation on a 3D grid.
fn trilinear_sample(
    data: &[[f64; 3]],
    cells: [usize; 3],
    fx: f64,
    fy: f64,
    fz: f64,
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
                let ix =
                    (x0 + dx as isize).clamp(0, cells[0] as isize - 1) as usize;
                let iy =
                    (y0 + dy as isize).clamp(0, cells[1] as isize - 1) as usize;
                let iz =
                    (z0 + dz as isize).clamp(0, cells[2] as isize - 1) as usize;

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
}
