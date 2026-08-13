//! Transfer operators between native and convolution grids.
//!
//! - `VolumeWeightedTransfer::push_m`: native → scratch moment density
//! - `VolumeWeightedTransfer::pull_h_adjoint`: scratch → native volume adjoint
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

/// Geometry-only overlap stencil for a native-to-scratch transfer.
///
/// The stencil is independent of field values and can be built once per
/// layer. `push_m` divides the represented active moment by the full scratch
/// volume; `pull_h_adjoint` is its exact transpose in the volume-weighted
/// inner product.
#[derive(Debug, Clone)]
pub struct VolumeWeightedTransfer {
    native_cells: [usize; 3],
    scratch_cells: [usize; 3],
    native_cell_size: [f64; 3],
    scratch_cell_size: [f64; 3],
    native_origin: [f64; 3],
    scratch_origin: [f64; 3],
    /// For every scratch cell, `(native_linear_index, overlap_volume)` pairs.
    overlaps: Vec<Vec<(usize, f64)>>,
    scratch_volume: f64,
    native_volume: f64,
    boundary_policy: TransferBoundaryPolicy,
}

impl VolumeWeightedTransfer {
    /// Build an open-boundary overlap stencil. Periodic transfers are
    /// rejected explicitly because wrapping changes the overlap topology and
    /// needs a separate descriptor instead of an open-boundary transpose.
    pub fn new(
        native_cells: [usize; 3],
        native_cell_size: [f64; 3],
        native_origin: [f64; 3],
        scratch_cells: [usize; 3],
        scratch_cell_size: [f64; 3],
        scratch_origin: [f64; 3],
        boundary_policy: TransferBoundaryPolicy,
    ) -> Result<Self, String> {
        if boundary_policy
            .periodic_axes
            .iter()
            .any(|periodic| *periodic)
        {
            return Err(
                "volume-weighted transfer requires open boundaries; periodic overlap is unsupported"
                    .to_string(),
            );
        }
        if native_cells.contains(&0) || scratch_cells.contains(&0) {
            return Err("native and scratch transfer grids must be non-empty".to_string());
        }
        if native_cell_size
            .iter()
            .chain(scratch_cell_size.iter())
            .any(|value| !value.is_finite() || *value <= 0.0)
            || native_origin
                .iter()
                .chain(scratch_origin.iter())
                .any(|value| !value.is_finite())
        {
            return Err("transfer origins must be finite and cell sizes positive".to_string());
        }

        let native_volume = native_cell_size[0] * native_cell_size[1] * native_cell_size[2];
        let scratch_volume = scratch_cell_size[0] * scratch_cell_size[1] * scratch_cell_size[2];
        let scratch_count = scratch_cells[0] * scratch_cells[1] * scratch_cells[2];
        let mut overlaps = vec![Vec::new(); scratch_count];

        for sz in 0..scratch_cells[2] {
            for sy in 0..scratch_cells[1] {
                for sx in 0..scratch_cells[0] {
                    let scratch_index =
                        sz * scratch_cells[1] * scratch_cells[0] + sy * scratch_cells[0] + sx;
                    let scratch_lo = [
                        scratch_origin[0] + sx as f64 * scratch_cell_size[0],
                        scratch_origin[1] + sy as f64 * scratch_cell_size[1],
                        scratch_origin[2] + sz as f64 * scratch_cell_size[2],
                    ];
                    let scratch_hi = [
                        scratch_lo[0] + scratch_cell_size[0],
                        scratch_lo[1] + scratch_cell_size[1],
                        scratch_lo[2] + scratch_cell_size[2],
                    ];

                    for nz in 0..native_cells[2] {
                        for ny in 0..native_cells[1] {
                            for nx in 0..native_cells[0] {
                                let native_lo = [
                                    native_origin[0] + nx as f64 * native_cell_size[0],
                                    native_origin[1] + ny as f64 * native_cell_size[1],
                                    native_origin[2] + nz as f64 * native_cell_size[2],
                                ];
                                let native_hi = [
                                    native_lo[0] + native_cell_size[0],
                                    native_lo[1] + native_cell_size[1],
                                    native_lo[2] + native_cell_size[2],
                                ];
                                let overlap = overlap_length_open(
                                    scratch_lo[0],
                                    scratch_hi[0],
                                    native_lo[0],
                                    native_hi[0],
                                ) * overlap_length_open(
                                    scratch_lo[1],
                                    scratch_hi[1],
                                    native_lo[1],
                                    native_hi[1],
                                ) * overlap_length_open(
                                    scratch_lo[2],
                                    scratch_hi[2],
                                    native_lo[2],
                                    native_hi[2],
                                );
                                if overlap > 0.0 {
                                    let native_index = nz * native_cells[1] * native_cells[0]
                                        + ny * native_cells[0]
                                        + nx;
                                    overlaps[scratch_index].push((native_index, overlap));
                                }
                            }
                        }
                    }
                }
            }
        }

        Ok(Self {
            native_cells,
            scratch_cells,
            native_cell_size,
            scratch_cell_size,
            native_origin,
            scratch_origin,
            overlaps,
            scratch_volume,
            native_volume,
            boundary_policy,
        })
    }

    pub fn native_cells(&self) -> [usize; 3] {
        self.native_cells
    }

    pub fn scratch_cells(&self) -> [usize; 3] {
        self.scratch_cells
    }

    pub fn native_cell_size(&self) -> [f64; 3] {
        self.native_cell_size
    }

    pub fn scratch_cell_size(&self) -> [f64; 3] {
        self.scratch_cell_size
    }

    pub fn native_origin(&self) -> [f64; 3] {
        self.native_origin
    }

    pub fn scratch_origin(&self) -> [f64; 3] {
        self.scratch_origin
    }

    pub fn boundary_policy(&self) -> TransferBoundaryPolicy {
        self.boundary_policy
    }

    /// Push native magnetization as moment density over each full scratch cell.
    pub fn push_m(
        &self,
        native_m: &[[f64; 3]],
        active_mask: Option<&[bool]>,
    ) -> Result<Vec<[f64; 3]>, String> {
        let mut scratch_m = vec![[0.0; 3]; self.overlaps.len()];
        self.push_m_into(native_m, active_mask, &mut scratch_m)?;
        Ok(scratch_m)
    }

    /// Fill a caller-owned scratch buffer without allocating field storage.
    pub fn push_m_into(
        &self,
        native_m: &[[f64; 3]],
        active_mask: Option<&[bool]>,
        scratch_m: &mut [[f64; 3]],
    ) -> Result<(), String> {
        self.validate_native_inputs(native_m.len(), active_mask)?;
        if scratch_m.len() != self.scratch_len() {
            return Err(format!(
                "scratch transfer output length {} does not match {}",
                scratch_m.len(),
                self.scratch_len()
            ));
        }
        scratch_m.fill([0.0; 3]);
        for (scratch_index, overlaps) in self.overlaps.iter().enumerate() {
            let mut moment = [0.0; 3];
            for &(native_index, overlap) in overlaps {
                if active_mask.map(|mask| mask[native_index]).unwrap_or(true) {
                    let m = native_m[native_index];
                    for component in 0..3 {
                        moment[component] += overlap * m[component];
                    }
                }
            }
            for component in 0..3 {
                scratch_m[scratch_index][component] = moment[component] / self.scratch_volume;
            }
        }
        Ok(())
    }

    /// Pull scratch field through the exact volume-weighted transpose of
    /// [`Self::push_m`]. Inactive native cells are always returned as zero.
    pub fn pull_h_adjoint(
        &self,
        scratch_h: &[[f64; 3]],
        active_mask: Option<&[bool]>,
    ) -> Result<Vec<[f64; 3]>, String> {
        let mut native_h = vec![[0.0; 3]; self.native_len()];
        self.pull_h_adjoint_into(scratch_h, active_mask, &mut native_h)?;
        Ok(native_h)
    }

    /// Fill a caller-owned native buffer with the volume-weighted adjoint.
    pub fn pull_h_adjoint_into(
        &self,
        scratch_h: &[[f64; 3]],
        active_mask: Option<&[bool]>,
        native_h: &mut [[f64; 3]],
    ) -> Result<(), String> {
        self.validate_scratch_inputs(scratch_h.len(), active_mask)?;
        if native_h.len() != self.native_len() {
            return Err(format!(
                "native transfer output length {} does not match {}",
                native_h.len(),
                self.native_len()
            ));
        }
        native_h.fill([0.0; 3]);
        for (scratch_index, overlaps) in self.overlaps.iter().enumerate() {
            let h = scratch_h[scratch_index];
            for &(native_index, overlap) in overlaps {
                if active_mask.map(|mask| mask[native_index]).unwrap_or(true) {
                    let coefficient = overlap / self.native_volume;
                    for component in 0..3 {
                        native_h[native_index][component] += coefficient * h[component];
                    }
                }
            }
        }
        Ok(())
    }

    fn native_len(&self) -> usize {
        self.native_cells[0] * self.native_cells[1] * self.native_cells[2]
    }

    fn scratch_len(&self) -> usize {
        self.scratch_cells[0] * self.scratch_cells[1] * self.scratch_cells[2]
    }

    fn validate_native_inputs(
        &self,
        values_len: usize,
        active_mask: Option<&[bool]>,
    ) -> Result<(), String> {
        if values_len != self.native_len() {
            return Err(format!(
                "native transfer field length {values_len} does not match {}",
                self.native_len()
            ));
        }
        self.validate_mask(active_mask)
    }

    fn validate_scratch_inputs(
        &self,
        values_len: usize,
        active_mask: Option<&[bool]>,
    ) -> Result<(), String> {
        if values_len != self.scratch_len() {
            return Err(format!(
                "scratch transfer field length {values_len} does not match {}",
                self.scratch_len()
            ));
        }
        self.validate_mask(active_mask)
    }

    fn validate_mask(&self, active_mask: Option<&[bool]>) -> Result<(), String> {
        if let Some(mask) = active_mask {
            if mask.len() != self.native_len() {
                return Err(format!(
                    "active mask length {} does not match native cell count {}",
                    mask.len(),
                    self.native_len()
                ));
            }
        }
        Ok(())
    }
}

fn overlap_length_open(a_lo: f64, a_hi: f64, b_lo: f64, b_hi: f64) -> f64 {
    let raw = (a_hi.min(b_hi) - a_lo.max(b_lo)).max(0.0);
    // Grid origins are represented in SI floating point, so two geometrically
    // coincident faces can leave a sub-ulp positive sliver (for example when
    // an Airbox is extended by one cell). Treat that sliver as no overlap so
    // it cannot create a spurious source plane at the boundary.
    let scale = (a_hi - a_lo).abs().max((b_hi - b_lo).abs());
    if raw <= 1.0e-12 * scale {
        0.0
    } else {
        raw
    }
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

    #[test]
    fn volume_weighted_transfer_preserves_2d_moment_through_z_average() {
        let transfer = VolumeWeightedTransfer::new(
            [1, 1, 2],
            [1.0, 1.0, 0.5],
            [0.0, 0.0, 0.0],
            [1, 1, 1],
            [1.0, 1.0, 1.0],
            [0.0, 0.0, 0.0],
            TransferBoundaryPolicy::OPEN,
        )
        .expect("valid 2-D moment-preserving transfer");
        let native = vec![[1.0, 0.0, 0.0], [3.0, 0.0, 0.0]];
        let scratch = transfer.push_m(&native, None).expect("push succeeds");
        assert!((scratch[0][0] - 2.0).abs() < 1e-14);

        let native_moment = native.iter().map(|m| m[0] * 0.5).sum::<f64>();
        let scratch_moment = scratch[0][0];
        assert!((native_moment - scratch_moment).abs() < 1e-14);
    }

    #[test]
    fn volume_weighted_transfer_is_adjoint_with_active_mask() {
        let transfer = VolumeWeightedTransfer::new(
            [2, 1, 2],
            [0.5, 1.0, 0.5],
            [0.0, 0.0, 0.0],
            [1, 1, 1],
            [1.0, 1.0, 1.0],
            [0.0, 0.0, 0.0],
            TransferBoundaryPolicy::OPEN,
        )
        .expect("valid transfer");
        let native = vec![
            [1.0, 0.0, 0.0],
            [2.0, 0.0, 0.0],
            [3.0, 0.0, 0.0],
            [4.0, 0.0, 0.0],
        ];
        let scratch_test = vec![[0.75, 0.0, 0.0]];
        let mask = [true, false, true, true];
        let pushed = transfer
            .push_m(&native, Some(&mask))
            .expect("push succeeds");
        let pulled = transfer
            .pull_h_adjoint(&scratch_test, Some(&mask))
            .expect("adjoint pull succeeds");
        let native_volume = 0.5 * 1.0 * 0.5;
        let lhs = pushed[0][0] * scratch_test[0][0];
        let rhs = native
            .iter()
            .zip(pulled.iter())
            .zip(mask.iter())
            .filter(|(_, active)| **active)
            .map(|((m, h), _)| native_volume * m[0] * h[0])
            .sum::<f64>();
        assert!((lhs - rhs).abs() < 1e-14, "lhs={lhs} rhs={rhs}");
        assert_eq!(pulled[1], [0.0, 0.0, 0.0]);
    }

    #[test]
    fn volume_weighted_transfer_fills_reused_output_buffers() {
        let transfer = VolumeWeightedTransfer::new(
            [2, 1, 1],
            [0.5, 1.0, 1.0],
            [0.0; 3],
            [1, 1, 1],
            [1.0; 3],
            [0.0; 3],
            TransferBoundaryPolicy::OPEN,
        )
        .expect("valid transfer");
        let native = [[1.0, 0.0, 0.0], [3.0, 0.0, 0.0]];
        let mut scratch = vec![[99.0; 3]; 1];
        let scratch_capacity = scratch.capacity();
        transfer
            .push_m_into(&native, None, &mut scratch)
            .expect("push into reused buffer");
        assert_eq!(scratch, [[2.0, 0.0, 0.0]]);
        assert_eq!(scratch.capacity(), scratch_capacity);

        let mut pulled = vec![[99.0; 3]; 2];
        let pulled_capacity = pulled.capacity();
        transfer
            .pull_h_adjoint_into(&scratch, None, &mut pulled)
            .expect("pull into reused buffer");
        assert_eq!(pulled, [[2.0, 0.0, 0.0], [2.0, 0.0, 0.0]]);
        assert_eq!(pulled.capacity(), pulled_capacity);
    }

    #[test]
    fn volume_weighted_transfer_rejects_periodic_boundary_until_descriptor_exists() {
        let error = VolumeWeightedTransfer::new(
            [1, 1, 1],
            [1.0; 3],
            [0.0; 3],
            [1, 1, 1],
            [1.0; 3],
            [0.0; 3],
            TransferBoundaryPolicy::from_periodic_axes([true, false, false]),
        )
        .expect_err("periodic transfer must fail closed");
        assert!(error.contains("periodic"));
    }
}
