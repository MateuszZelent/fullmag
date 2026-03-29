//! SDF-based sub-cell geometry computation for FDM boundary correction.
//!
//! Computes volume fractions (φ), face-link fractions (f), and intersection
//! distances (δ) from an implicit SDF representation of the geometry.
//!
//! The SDF is defined via a closure `sdf(x, y, z) -> f64` where negative = inside,
//! positive = outside, and zero = on the boundary.

use fullmag_ir::BoundaryGeometryIR;

/// Sub-sampling resolution for volume fraction and face-link computation.
/// Each cell is sub-divided into `R x R x R` sub-cells for volume fraction,
/// and each face into `R x R` sub-samples for face-link fraction.
const SUB_SAMPLE_R: usize = 4;

/// Compute sub-cell boundary geometry from an SDF function.
///
/// # Arguments
/// * `sdf` — Signed distance function: `sdf(x, y, z) -> f64`. Negative = inside material.
/// * `nx, ny, nz` — Grid dimensions.
/// * `dx, dy, dz` — Cell sizes in metres.
/// * `compute_delta` — If true, compute intersection distances (T1 mode).
pub fn compute_boundary_geometry(
    sdf: &dyn Fn(f64, f64, f64) -> f64,
    nx: u32,
    ny: u32,
    nz: u32,
    dx: f64,
    dy: f64,
    dz: f64,
    compute_delta: bool,
) -> BoundaryGeometryIR {
    let n = (nx as usize) * (ny as usize) * (nz as usize);

    let mut volume_fraction = vec![0.0f64; n];
    let mut face_link_xp = vec![0.0f64; n];
    let mut face_link_xm = vec![0.0f64; n];
    let mut face_link_yp = vec![0.0f64; n];
    let mut face_link_ym = vec![0.0f64; n];
    let mut face_link_zp = vec![0.0f64; n];
    let mut face_link_zm = vec![0.0f64; n];
    let mut delta_xp = vec![dx; n];
    let mut delta_xm = vec![dx; n];
    let mut delta_yp = vec![dy; n];
    let mut delta_ym = vec![dy; n];
    let mut delta_zp = vec![dz; n];
    let mut delta_zm = vec![dz; n];

    let r = SUB_SAMPLE_R;

    for iz in 0..nz as usize {
        for iy in 0..ny as usize {
            for ix in 0..nx as usize {
                let idx = ix + nx as usize * (iy + ny as usize * iz);
                let cx = (ix as f64 + 0.5) * dx;
                let cy = (iy as f64 + 0.5) * dy;
                let cz = (iz as f64 + 0.5) * dz;

                // ── Volume fraction: R³ sub-sampling ──
                let mut inside_count = 0usize;
                for sz in 0..r {
                    for sy in 0..r {
                        for sx in 0..r {
                            let px = ix as f64 * dx + (sx as f64 + 0.5) / r as f64 * dx;
                            let py = iy as f64 * dy + (sy as f64 + 0.5) / r as f64 * dy;
                            let pz = iz as f64 * dz + (sz as f64 + 0.5) / r as f64 * dz;
                            if sdf(px, py, pz) <= 0.0 {
                                inside_count += 1;
                            }
                        }
                    }
                }
                volume_fraction[idx] = inside_count as f64 / (r * r * r) as f64;

                // ── Face-link fractions: R² sub-sampling on each face ──
                // +x face: x = (ix+1)*dx, y ∈ [iy*dy, (iy+1)*dy], z ∈ [iz*dz, (iz+1)*dz]
                face_link_xp[idx] = face_fraction(
                    sdf,
                    (ix + 1) as f64 * dx,
                    iy as f64 * dy,
                    iz as f64 * dz,
                    0.0,
                    dy,
                    dz,
                    r,
                );
                face_link_xm[idx] = face_fraction(
                    sdf,
                    ix as f64 * dx,
                    iy as f64 * dy,
                    iz as f64 * dz,
                    0.0,
                    dy,
                    dz,
                    r,
                );
                face_link_yp[idx] = face_fraction(
                    sdf,
                    ix as f64 * dx,
                    (iy + 1) as f64 * dy,
                    iz as f64 * dz,
                    dx,
                    0.0,
                    dz,
                    r,
                );
                face_link_ym[idx] = face_fraction(
                    sdf,
                    ix as f64 * dx,
                    iy as f64 * dy,
                    iz as f64 * dz,
                    dx,
                    0.0,
                    dz,
                    r,
                );
                face_link_zp[idx] = face_fraction(
                    sdf,
                    ix as f64 * dx,
                    iy as f64 * dy,
                    (iz + 1) as f64 * dz,
                    dx,
                    dy,
                    0.0,
                    r,
                );
                face_link_zm[idx] = face_fraction(
                    sdf,
                    ix as f64 * dx,
                    iy as f64 * dy,
                    iz as f64 * dz,
                    dx,
                    dy,
                    0.0,
                    r,
                );

                // ── Intersection distances (T1 mode) ──
                if compute_delta {
                    // +x: find root along (cx, cy, cz) → (cx + dx, cy, cz)
                    delta_xp[idx] = find_boundary_distance(sdf, cx, cy, cz, dx, 0.0, 0.0);
                    delta_xm[idx] = find_boundary_distance(sdf, cx, cy, cz, -dx, 0.0, 0.0);
                    delta_yp[idx] = find_boundary_distance(sdf, cx, cy, cz, 0.0, dy, 0.0);
                    delta_ym[idx] = find_boundary_distance(sdf, cx, cy, cz, 0.0, -dy, 0.0);
                    delta_zp[idx] = find_boundary_distance(sdf, cx, cy, cz, 0.0, 0.0, dz);
                    delta_zm[idx] = find_boundary_distance(sdf, cx, cy, cz, 0.0, 0.0, -dz);
                }
            }
        }
    }

    // ── Sparse demag correction (ΔN precomputation) ──
    let (demag_corr_target_idx, demag_corr_source_idx, demag_corr_tensor, demag_corr_stencil_size) =
        compute_sparse_demag_correction(
            &volume_fraction,
            nx as usize,
            ny as usize,
            nz as usize,
            dx,
            dy,
            dz,
        );

    BoundaryGeometryIR {
        volume_fraction,
        face_link_xp,
        face_link_xm,
        face_link_yp,
        face_link_ym,
        face_link_zp,
        face_link_zm,
        delta_xp,
        delta_xm,
        delta_yp,
        delta_ym,
        delta_zp,
        delta_zm,
        demag_corr_target_idx,
        demag_corr_source_idx,
        demag_corr_tensor,
        demag_corr_stencil_size,
    }
}

/// Compute the fraction of a face that lies inside the material.
///
/// The face is a 2D rectangle starting at `(x0, y0, z0)` with extent
/// `(span_x, span_y, span_z)`. Exactly two of the span components
/// should be non-zero (the face lies in a plane).
fn face_fraction(
    sdf: &dyn Fn(f64, f64, f64) -> f64,
    x0: f64,
    y0: f64,
    z0: f64,
    span_x: f64,
    span_y: f64,
    span_z: f64,
    r: usize,
) -> f64 {
    // Determine which two axes are non-zero
    let (s1, s2) = if span_x == 0.0 {
        (span_y, span_z)
    } else if span_y == 0.0 {
        (span_x, span_z)
    } else {
        (span_x, span_y)
    };

    let mut inside = 0usize;
    for a in 0..r {
        for b in 0..r {
            let t1 = (a as f64 + 0.5) / r as f64;
            let t2 = (b as f64 + 0.5) / r as f64;
            let (px, py, pz) = if span_x == 0.0 {
                (x0, y0 + t1 * s1, z0 + t2 * s2)
            } else if span_y == 0.0 {
                (x0 + t1 * s1, y0, z0 + t2 * s2)
            } else {
                (x0 + t1 * s1, y0 + t2 * s2, z0)
            };
            if sdf(px, py, pz) <= 0.0 {
                inside += 1;
            }
        }
    }
    inside as f64 / (r * r) as f64
}

/// Find the distance from `(x0, y0, z0)` to the SDF zero-crossing along
/// direction `(dir_x, dir_y, dir_z)`, using bisection.
///
/// Returns the Euclidean distance to the intersection point if found,
/// or the full step length `|dir|` if no sign change is detected.
fn find_boundary_distance(
    sdf: &dyn Fn(f64, f64, f64) -> f64,
    x0: f64,
    y0: f64,
    z0: f64,
    dir_x: f64,
    dir_y: f64,
    dir_z: f64,
) -> f64 {
    let step_len = (dir_x * dir_x + dir_y * dir_y + dir_z * dir_z).sqrt();
    if step_len == 0.0 {
        return 0.0;
    }

    let f0 = sdf(x0, y0, z0);
    let f1 = sdf(x0 + dir_x, y0 + dir_y, z0 + dir_z);

    // No sign change → no boundary crossing along this segment
    if f0 * f1 > 0.0 {
        return step_len;
    }

    // Bisection: find t ∈ [0, 1] where SDF changes sign
    let mut lo = 0.0f64;
    let mut hi = 1.0f64;
    for _ in 0..20 {
        let mid = 0.5 * (lo + hi);
        let f_mid = sdf(x0 + mid * dir_x, y0 + mid * dir_y, z0 + mid * dir_z);
        if f0 * f_mid <= 0.0 {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    0.5 * (lo + hi) * step_len
}

/// Build SDF for a cylinder geometry centered in the XY plane.
///
/// Returns a closure `sdf(x, y, z) -> f64` for a cylinder of given radius
/// centered at `(cx, cy)` spanning all z. Negative = inside.
pub fn cylinder_sdf(radius: f64, cx: f64, cy: f64) -> impl Fn(f64, f64, f64) -> f64 {
    move |x, y, _z| {
        let dx = x - cx;
        let dy = y - cy;
        (dx * dx + dy * dy).sqrt() - radius
    }
}

/// Build SDF for a Cylinder-minus-Cylinder (hole) CSG difference.
///
/// `base_radius` is the outer cylinder, `hole_radius` is the subtracted cylinder.
/// Both centered at `(cx, cy)`. Returns `max(sdf_outer, -sdf_inner)`.
pub fn cylinder_hole_sdf(
    base_radius: f64,
    hole_radius: f64,
    cx: f64,
    cy: f64,
) -> impl Fn(f64, f64, f64) -> f64 {
    move |x, y, z| {
        let sdf_outer = cylinder_sdf(base_radius, cx, cy)(x, y, z);
        let sdf_inner = cylinder_sdf(hole_radius, cx, cy)(x, y, z);
        // CSG difference: inside outer AND outside inner
        sdf_outer.max(-sdf_inner)
    }
}

/// Stencil radius for sparse demag correction (cells).
/// Each boundary target cell considers sources within ±CORR_RADIUS in each axis.
const CORR_RADIUS: i32 = 3;

/// Compute sparse demag correction tensors ΔN for boundary cells.
///
/// The FFT demag path already applies φ-weighted packing (M_eff = φ·Ms·m),
/// but this introduces an error because the Newell convolution kernel N(r)
/// was precomputed assuming unit occupancy. The correction is:
///
///   ΔH_i(t) = -Ms ∑_s ΔN_ij(t,s) · m_j(s)
///
/// where `ΔN_ij(t,s) = (φ_t · φ_s - 1) · N_ij(r_{ts})` for cell pairs
/// involving at least one boundary cell.
///
/// Returns `(target_idx, source_idx, tensor, stencil_size)` in the format
/// expected by the CUDA `demag_boundary_correction_fp64_kernel`:
/// - `target_idx[target_count]` — flat cell indices of boundary targets
/// - `source_idx[target_count × stencil_size]` — flat cell indices of sources per target
///   (-1 for unused slots)
/// - `tensor[target_count × stencil_size × 6]` — ΔN components (xx,yy,zz,xy,xz,yz)
/// - `stencil_size` — max sources per target
fn compute_sparse_demag_correction(
    volume_fraction: &[f64],
    nx: usize,
    ny: usize,
    nz: usize,
    dx: f64,
    dy: f64,
    dz: f64,
) -> (Vec<i32>, Vec<i32>, Vec<f64>, u32) {
    let phi_thr_lo = 0.001; // cells with φ < this are empty
    let phi_thr_hi = 0.999; // cells with φ > this are fully interior

    // Identify boundary cells: 0 < φ < 1 (not empty, not fully interior)
    let boundary_cells: Vec<usize> = (0..volume_fraction.len())
        .filter(|&i| volume_fraction[i] > phi_thr_lo && volume_fraction[i] < phi_thr_hi)
        .collect();

    if boundary_cells.is_empty() {
        return (vec![], vec![], vec![], 0);
    }

    // Compute the Newell kernel on the padded grid.
    // We only need values up to CORR_RADIUS displacement, so use a small grid.
    let kr = CORR_RADIUS as usize + 1; // need indices 0..CORR_RADIUS in positive octant
    let nk = fullmag_fdm_demag::newell::compute_newell_kernels(kr, kr, kr, dx, dy, dz);
    let kpx = nk.px;
    let kpy = nk.py;
    let kidx = |x: usize, y: usize, z: usize| -> usize { z * kpy * kpx + y * kpx + x };

    // Look up N_ij at displacement (di, dj, dk) using octant symmetry encoded in the padded grid.
    // The padded grid has size (2*nx_kern, 2*ny_kern, 2*nz_kern) with octant-reflected values.
    let n_lookup = |di: i32, dj: i32, dk: i32| -> [f64; 6] {
        let ax = di.unsigned_abs() as usize;
        let ay = dj.unsigned_abs() as usize;
        let az = dk.unsigned_abs() as usize;
        if ax >= kpx / 2 || ay >= kpy / 2 || az >= nk.pz / 2 {
            return [0.0; 6]; // outside kernel grid → negligible
        }
        // Map signed displacement to padded index:
        // positive → index is the displacement itself
        // negative → index is padded_size - |displacement|
        let ix = if di >= 0 { ax } else { kpx - ax };
        let iy = if dj >= 0 { ay } else { kpy - ay };
        let iz = if dk >= 0 { az } else { nk.pz - az };
        let p = kidx(ix, iy, iz);
        [
            nk.n_xx[p], nk.n_yy[p], nk.n_zz[p], nk.n_xy[p], nk.n_xz[p], nk.n_yz[p],
        ]
    };

    // Build the stencil: for each boundary target, collect all sources within ±CORR_RADIUS
    // that are active (φ > 0) and where the correction is non-negligible.
    let stencil_diam = (2 * CORR_RADIUS + 1) as usize;
    let max_stencil_size = stencil_diam * stencil_diam * stencil_diam;

    // First pass: compute actual stencil entries per target to determine stencil_size
    struct CorrEntry {
        target: i32,
        sources: Vec<i32>,
        tensors: Vec<[f64; 6]>,
    }

    let cell_idx = |x: usize, y: usize, z: usize| -> usize { x + nx * (y + ny * z) };

    let mut entries: Vec<CorrEntry> = Vec::with_capacity(boundary_cells.len());
    let mut actual_max_stencil = 0usize;

    for &t_flat in &boundary_cells {
        let tz = t_flat / (nx * ny);
        let ty = (t_flat % (nx * ny)) / nx;
        let tx = t_flat % nx;
        let phi_t = volume_fraction[t_flat];

        let mut sources = Vec::with_capacity(max_stencil_size);
        let mut tensors = Vec::with_capacity(max_stencil_size);

        for dk in -CORR_RADIUS..=CORR_RADIUS {
            let sz = tz as i32 + dk;
            if sz < 0 || sz >= nz as i32 {
                continue;
            }
            for dj in -CORR_RADIUS..=CORR_RADIUS {
                let sy = ty as i32 + dj;
                if sy < 0 || sy >= ny as i32 {
                    continue;
                }
                for di in -CORR_RADIUS..=CORR_RADIUS {
                    let sx = tx as i32 + di;
                    if sx < 0 || sx >= nx as i32 {
                        continue;
                    }
                    if di == 0 && dj == 0 && dk == 0 {
                        continue;
                    } // self-term handled by FFT

                    let s_flat = cell_idx(sx as usize, sy as usize, sz as usize);
                    let phi_s = volume_fraction[s_flat];
                    if phi_s < phi_thr_lo {
                        continue;
                    } // empty cell

                    let correction_factor = phi_t * phi_s - 1.0;
                    if correction_factor.abs() < 1e-12 {
                        continue;
                    } // no correction needed

                    let n_raw = n_lookup(di, dj, dk);
                    let dn = [
                        correction_factor * n_raw[0],
                        correction_factor * n_raw[1],
                        correction_factor * n_raw[2],
                        correction_factor * n_raw[3],
                        correction_factor * n_raw[4],
                        correction_factor * n_raw[5],
                    ];

                    sources.push(s_flat as i32);
                    tensors.push(dn);
                }
            }
        }

        if !sources.is_empty() {
            actual_max_stencil = actual_max_stencil.max(sources.len());
            entries.push(CorrEntry {
                target: t_flat as i32,
                sources,
                tensors,
            });
        }
    }

    if entries.is_empty() {
        return (vec![], vec![], vec![], 0);
    }

    let stencil_size = actual_max_stencil as u32;
    let target_count = entries.len();

    // Flatten into the CSR-like format expected by the CUDA kernel
    let mut target_idx = Vec::with_capacity(target_count);
    let mut source_idx = vec![-1i32; target_count * stencil_size as usize];
    let mut tensor = vec![0.0f64; target_count * stencil_size as usize * 6];

    for (row, entry) in entries.iter().enumerate() {
        target_idx.push(entry.target);
        for (col, (&src, dn)) in entry.sources.iter().zip(entry.tensors.iter()).enumerate() {
            source_idx[row * stencil_size as usize + col] = src;
            let base = (row * stencil_size as usize + col) * 6;
            tensor[base..base + 6].copy_from_slice(dn);
        }
    }

    (target_idx, source_idx, tensor, stencil_size)
}
