//! Shifted (cross-layer) kernel builder.
//!
//! For multilayer demag, each source→destination layer pair needs a kernel
//! computed with a z-shift equal to the vertical distance between their origins.
//! The kernel is evaluated on the common convolution grid.

use crate::newell;
use crate::self_kernel::fft_newell_to_kernel;
use crate::types::TensorDemagKernel;

/// Compute a shifted cross-layer demag kernel in FFT domain.
///
/// The kernel represents the demag coupling between a source layer and a
/// destination layer separated by `z_shift` meters. Both layers are
/// projected onto the common convolution grid.
///
/// For V1, source and destination cells must be axis-aligned rectangular
/// prisms on the same common convolution grid.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_shift_equals_self_kernel() {
        let cells = [4, 4, 1];
        let cs = [2e-9, 2e-9, 1e-9];
        let self_k = crate::compute_exact_self_kernel(cells[0], cells[1], cells[2], cs[0], cs[1], cs[2]);
        let shifted_k = compute_shifted_kernel(cells, cs, 0.0);

        // At zero shift, the shifted kernel must equal the self kernel
        assert_eq!(self_k.fft_shape, shifted_k.fft_shape);
        for i in 0..self_k.len() {
            assert!(
                (self_k.k_xx[i] - shifted_k.k_xx[i]).norm() < 1e-10,
                "k_xx mismatch at {i}: self={:?} shifted={:?}",
                self_k.k_xx[i],
                shifted_k.k_xx[i]
            );
        }
    }
}
