//! Shifted (cross-layer) kernel builder.
//!
//! For multilayer demag, each source→destination layer pair needs a kernel
//! computed with a z-shift equal to the vertical distance between their origins.
//! The kernel is evaluated on the common convolution grid.

use crate::newell;
use crate::self_kernel::fft_newell_to_kernel;
use crate::types::{KernelBuildError, TensorDemagKernel, TensorDemagKernelF32};

/// Compute a shifted cross-layer demag kernel in FFT domain.
///
/// The kernel represents the demag coupling between a source layer and a
/// destination layer separated by `z_shift` meters. Both layers are
/// projected onto the common convolution grid.
///
/// For V1, source and destination cells must be axis-aligned rectangular
/// prisms on the same common convolution grid.
///
/// # Current limitation
///
/// This builder accepts one `conv_cell_size` for both source and destination.
/// Unequal source/destination cell sizes need a future oriented pair descriptor;
/// independent cubature reciprocity tests do not qualify that production path.
/// Far-field selection uses the physical separation after applying `z_shift`.
/// A finite offset that cancels a large integer lag falls back to the exact
/// stencil, including when that lag is outside the bounded precomputed window.
///
/// # Arguments
/// * `conv_cells` — common convolution grid dimensions
/// * `conv_cell_size` — common convolution cell sizes in meters
/// * `z_shift` — vertical displacement from source to destination (meters)
pub fn compute_shifted_kernel(
    conv_cells: [usize; 3],
    conv_cell_size: [f64; 3],
    z_shift: f64,
) -> TensorDemagKernel {
    let nx = conv_cells[0];
    let ny = conv_cells[1];
    let nz = conv_cells[2];
    let dx = conv_cell_size[0];
    let dy = conv_cell_size[1];
    let dz = conv_cell_size[2];

    // Compute the Newell tensor on the padded grid with the z-offset
    // applied to the evaluation coordinates.
    let nk = newell::compute_newell_kernels_shifted(nx, ny, nz, dx, dy, dz, z_shift);
    let px = nk.px;
    let py = nk.py;
    let pz = nk.pz;

    fft_newell_to_kernel(nk, px, py, pz)
}

/// `f32` variant of [`compute_shifted_kernel`].
pub fn compute_shifted_kernel_f32(
    conv_cells: [usize; 3],
    conv_cell_size: [f64; 3],
    z_shift: f64,
) -> TensorDemagKernelF32 {
    TensorDemagKernelF32::from(&compute_shifted_kernel(conv_cells, conv_cell_size, z_shift))
}

/// Checked source/destination pair builder for independent cell sizes and a
/// full XYZ offset.
///
/// The pair is represented by one translational FFT kernel.  Therefore the
/// source and destination pitches must agree on the axes that are sampled by
/// the convolution grid; in `two_d_stack` (`conv_cells[2] == 1`) their z
/// thicknesses may differ and are integrated independently according to
/// Appendix A.  For an irregular 3-D *single pair* use
/// [`crate::cell_pair_tensor`] rather than silently selecting a z pitch.
pub fn try_compute_shifted_kernel_pair(
    conv_cells: [usize; 3],
    source_cell_size: [f64; 3],
    destination_cell_size: [f64; 3],
    offset: [f64; 3],
) -> Result<TensorDemagKernel, KernelBuildError> {
    let nk = newell::try_compute_newell_kernels_shifted_pair(
        conv_cells[0],
        conv_cells[1],
        conv_cells[2],
        source_cell_size,
        destination_cell_size,
        offset,
    )?;
    let px = nk.px;
    let py = nk.py;
    let pz = nk.pz;
    Ok(fft_newell_to_kernel(nk, px, py, pz))
}

/// Descriptive checked alias for [`try_compute_shifted_kernel_pair`].
pub fn compute_shifted_kernel_pair(
    conv_cells: [usize; 3],
    source_cell_size: [f64; 3],
    destination_cell_size: [f64; 3],
    offset: [f64; 3],
) -> Result<TensorDemagKernel, KernelBuildError> {
    try_compute_shifted_kernel_pair(conv_cells, source_cell_size, destination_cell_size, offset)
}

/// Alias matching the publication's "irregular shifted" terminology.
pub fn compute_shifted_kernel_irregular(
    conv_cells: [usize; 3],
    source_cell_size: [f64; 3],
    destination_cell_size: [f64; 3],
    offset: [f64; 3],
) -> Result<TensorDemagKernel, KernelBuildError> {
    compute_shifted_kernel_pair(conv_cells, source_cell_size, destination_cell_size, offset)
}

/// `f32` conversion for the checked pair builder.  Geometry is still
/// validated and generated in FP64 before storage conversion.
pub fn compute_shifted_kernel_pair_f32(
    conv_cells: [usize; 3],
    source_cell_size: [f64; 3],
    destination_cell_size: [f64; 3],
    offset: [f64; 3],
) -> Result<TensorDemagKernelF32, KernelBuildError> {
    Ok(TensorDemagKernelF32::from(&compute_shifted_kernel_pair(
        conv_cells,
        source_cell_size,
        destination_cell_size,
        offset,
    )?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_shift_equals_self_kernel() {
        let cells = [4, 4, 1];
        let cs = [2e-9, 2e-9, 1e-9];
        let self_k =
            crate::compute_exact_self_kernel(cells[0], cells[1], cells[2], cs[0], cs[1], cs[2]);
        let shifted_k = compute_shifted_kernel(cells, cs, 0.0);

        // At zero shift, the shifted kernel must equal the self kernel
        assert_eq!(self_k.fft_shape, shifted_k.fft_shape);
        let components = [
            ("xx", &self_k.k_xx, &shifted_k.k_xx),
            ("yy", &self_k.k_yy, &shifted_k.k_yy),
            ("zz", &self_k.k_zz, &shifted_k.k_zz),
            ("xy", &self_k.k_xy, &shifted_k.k_xy),
            ("xz", &self_k.k_xz, &shifted_k.k_xz),
            ("yz", &self_k.k_yz, &shifted_k.k_yz),
        ];
        for (name, self_component, shifted_component) in components {
            for i in 0..self_k.len() {
                assert_eq!(
                    self_component[i], shifted_component[i],
                    "k_{name} mismatch at {i}"
                );
            }
        }
    }
}
