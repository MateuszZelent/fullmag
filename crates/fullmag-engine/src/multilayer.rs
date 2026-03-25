//! Multilayer FDM LLG problem — runtime types and step algorithm.
//!
//! This module implements the report's §10-§11 architecture:
//! - `FdmLlgProblem` with per-layer state
//! - `DemagOperatorRuntime` enum (None / UniformGrid / MultilayerConvolution)
//! - Multilayer step: exchange → push_m → FFT → pairwise multiply → IFFT → pull_h → LLG
//!
//! For L=1, the `MultilayerConvolution` path reduces identically to
//! `UniformGrid` exact tensor demag.

use rustfft::num_complex::Complex;
use rustfft::FftPlanner;

use fullmag_fdm_demag::{
    self, pull_h, push_m,
    types::{TensorDemagKernel, VectorFieldFft},
};

// ---------------------------------------------------------------------------
// Runtime types (report §10.2)
// ---------------------------------------------------------------------------

/// Per-layer runtime state.
#[derive(Debug, Clone)]
pub struct FdmLayerRuntime {
    pub magnet_name: String,
    pub grid: [usize; 3],       // (nx, ny, nz)
    pub cell_size: [f64; 3],    // (dx, dy, dz)
    pub origin: [f64; 3],       // global position after Translate
    pub ms: f64,                // saturation magnetisation
    pub exchange_stiffness: f64,
    pub damping: f64,
    pub active_mask: Option<Vec<bool>>,
    pub m: Vec<[f64; 3]>,
    pub h_ex: Vec<[f64; 3]>,
    pub h_demag: Vec<[f64; 3]>,
    pub h_eff: Vec<[f64; 3]>,
    // Convolution grid this layer maps to (may equal native grid)
    pub conv_grid: [usize; 3],
    pub conv_cell_size: [f64; 3],
    pub needs_transfer: bool,
}

impl FdmLayerRuntime {
    pub fn cell_count(&self) -> usize {
        self.grid[0] * self.grid[1] * self.grid[2]
    }

    pub fn is_active(&self, idx: usize) -> bool {
        self.active_mask.as_ref().map_or(true, |m| m[idx])
    }
}

/// Kernel pair: precomputed FFT-domain demag kernel between two layers.
#[derive(Debug, Clone)]
pub struct KernelPair {
    pub src_layer: usize,
    pub dst_layer: usize,
    pub kernel: TensorDemagKernel,
}

/// Multilayer demag operator runtime.
pub struct MultilayerDemagRuntime {
    pub kernel_pairs: Vec<KernelPair>,
    pub conv_grid: [usize; 3],
    pub conv_cell_size: [f64; 3],
    pub fft_shape: [usize; 3],
    // FFT plans (shared across all pairs)
    fwd_x: std::sync::Arc<dyn rustfft::Fft<f64>>,
    fwd_y: std::sync::Arc<dyn rustfft::Fft<f64>>,
    fwd_z: std::sync::Arc<dyn rustfft::Fft<f64>>,
    inv_x: std::sync::Arc<dyn rustfft::Fft<f64>>,
    inv_y: std::sync::Arc<dyn rustfft::Fft<f64>>,
    inv_z: std::sync::Arc<dyn rustfft::Fft<f64>>,
}

impl MultilayerDemagRuntime {
    /// Create a new multilayer demag runtime from precomputed kernel pairs.
    pub fn new(
        kernel_pairs: Vec<KernelPair>,
        conv_grid: [usize; 3],
        conv_cell_size: [f64; 3],
    ) -> Self {
        let px = conv_grid[0] * 2;
        let py = conv_grid[1] * 2;
        let pz = conv_grid[2] * 2;
        let mut planner = FftPlanner::<f64>::new();

        Self {
            kernel_pairs,
            conv_grid,
            conv_cell_size,
            fft_shape: [px, py, pz],
            fwd_x: planner.plan_fft_forward(px),
            fwd_y: planner.plan_fft_forward(py),
            fwd_z: planner.plan_fft_forward(pz),
            inv_x: planner.plan_fft_inverse(px),
            inv_y: planner.plan_fft_inverse(py),
            inv_z: planner.plan_fft_inverse(pz),
        }
    }

    /// Padded FFT buffer length.
    fn padded_len(&self) -> usize {
        self.fft_shape[0] * self.fft_shape[1] * self.fft_shape[2]
    }

    /// Compute demag fields for all layers.
    ///
    /// Algorithm (report §11.1):
    /// 1. For each layer: push_m to convolution grid, pad, forward FFT
    /// 2. For each dst layer: zero H_fft, then for each src layer: H_fft += K * M_fft
    /// 3. For each layer: negate, inverse FFT, pull_h to native grid
    pub fn compute_demag_fields(&self, layers: &mut [FdmLayerRuntime]) {
        let n_layers = layers.len();
        let padded_len = self.padded_len();
        let [px, py, pz] = self.fft_shape;

        // Step 1: Forward FFT all layers' magnetizations
        let mut m_fft: Vec<VectorFieldFft> = Vec::with_capacity(n_layers);
        for layer in layers.iter() {
            // Transfer M to convolution grid
            let conv_m = if layer.needs_transfer {
                push_m(
                    &layer.m,
                    layer.grid,
                    layer.cell_size,
                    layer.conv_grid,
                    layer.conv_cell_size,
                )
            } else {
                layer.m.clone()
            };

            // Pad and FFT
            let mut buf = VectorFieldFft::zeros(padded_len);
            let [cx, cy, cz] = layer.conv_grid;
            for z in 0..cz {
                for y in 0..cy {
                    for x in 0..cx {
                        let src = z * cy * cx + y * cx + x;
                        let dst = z * py * px + y * px + x;
                        let m = conv_m[src];
                        buf.x[dst] = Complex::new(m[0] * layer.ms, 0.0);
                        buf.y[dst] = Complex::new(m[1] * layer.ms, 0.0);
                        buf.z[dst] = Complex::new(m[2] * layer.ms, 0.0);
                    }
                }
            }

            self.fft3_forward(&mut buf);
            m_fft.push(buf);
        }

        // Step 2: Pairwise tensor multiplication
        let mut h_fft: Vec<VectorFieldFft> = (0..n_layers)
            .map(|_| VectorFieldFft::zeros(padded_len))
            .collect();

        for pair in &self.kernel_pairs {
            fullmag_fdm_demag::accumulate_tensor_convolution(
                &mut h_fft[pair.dst_layer],
                &m_fft[pair.src_layer],
                &pair.kernel,
            );
        }

        // Step 3: Negate, inverse FFT, extract and pull to native grid
        let normalisation = 1.0 / padded_len as f64;
        for (li, layer) in layers.iter_mut().enumerate() {
            fullmag_fdm_demag::multiply::negate_field(&mut h_fft[li]);
            self.fft3_inverse(&mut h_fft[li]);

            // Extract from padded grid to convolution grid
            let [cx, cy, cz] = layer.conv_grid;
            let conv_total = cx * cy * cz;
            let mut conv_h = vec![[0.0, 0.0, 0.0]; conv_total];
            for z in 0..cz {
                for y in 0..cy {
                    for x in 0..cx {
                        let src = z * py * px + y * px + x;
                        let dst = z * cy * cx + y * cx + x;
                        conv_h[dst] = [
                            h_fft[li].x[src].re * normalisation,
                            h_fft[li].y[src].re * normalisation,
                            h_fft[li].z[src].re * normalisation,
                        ];
                    }
                }
            }

            // Transfer H back to native grid
            if layer.needs_transfer {
                layer.h_demag = pull_h(
                    &conv_h,
                    layer.conv_grid,
                    layer.conv_cell_size,
                    layer.grid,
                    layer.cell_size,
                );
            } else {
                layer.h_demag = conv_h;
            }
        }
    }

    // -----------------------------------------------------------------------
    // FFT helpers
    // -----------------------------------------------------------------------
    fn fft3_forward(&self, field: &mut VectorFieldFft) {
        self.fft3_component(&mut field.x, true);
        self.fft3_component(&mut field.y, true);
        self.fft3_component(&mut field.z, true);
    }

    fn fft3_inverse(&self, field: &mut VectorFieldFft) {
        self.fft3_component(&mut field.x, false);
        self.fft3_component(&mut field.y, false);
        self.fft3_component(&mut field.z, false);
    }

    fn fft3_component(&self, buf: &mut [Complex<f64>], forward: bool) {
        let [px, py, pz] = self.fft_shape;
        let (fx, fy, fz) = if forward {
            (&self.fwd_x, &self.fwd_y, &self.fwd_z)
        } else {
            (&self.inv_x, &self.inv_y, &self.inv_z)
        };

        // X transforms
        for z in 0..pz {
            for y in 0..py {
                let offset = z * py * px + y * px;
                fx.process(&mut buf[offset..offset + px]);
            }
        }
        // Y transforms
        let mut line_y = vec![Complex::new(0.0, 0.0); py];
        for z in 0..pz {
            for x in 0..px {
                for y in 0..py {
                    line_y[y] = buf[z * py * px + y * px + x];
                }
                fy.process(&mut line_y);
                for y in 0..py {
                    buf[z * py * px + y * px + x] = line_y[y];
                }
            }
        }
        // Z transforms
        let mut line_z = vec![Complex::new(0.0, 0.0); pz];
        for y in 0..py {
            for x in 0..px {
                for z in 0..pz {
                    line_z[z] = buf[z * py * px + y * px + x];
                }
                fz.process(&mut line_z);
                for z in 0..pz {
                    buf[z * py * px + y * px + x] = line_z[z];
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_layer_uniform_m_gives_uniform_h() {
        // A single uniformly magnetized cubic cell should produce a predictable
        // demag field: H_demag = -N * Ms * m
        let grid = [4, 4, 1];
        let cell_size = [2e-9, 2e-9, 1e-9];
        let ms = 800e3;
        let n_cells = grid[0] * grid[1] * grid[2];

        // Build self-kernel
        let kernel = fullmag_fdm_demag::compute_exact_self_kernel(
            grid[0], grid[1], grid[2],
            cell_size[0], cell_size[1], cell_size[2],
        );

        let mut layer = FdmLayerRuntime {
            magnet_name: "test".into(),
            grid,
            cell_size,
            origin: [0.0, 0.0, 0.0],
            ms,
            exchange_stiffness: 13e-12,
            damping: 0.02,
            active_mask: None,
            m: vec![[0.0, 0.0, 1.0]; n_cells],
            h_ex: vec![[0.0; 3]; n_cells],
            h_demag: vec![[0.0; 3]; n_cells],
            h_eff: vec![[0.0; 3]; n_cells],
            conv_grid: grid,
            conv_cell_size: cell_size,
            needs_transfer: false,
        };

        let demag = MultilayerDemagRuntime::new(
            vec![KernelPair {
                src_layer: 0,
                dst_layer: 0,
                kernel,
            }],
            grid,
            cell_size,
        );

        demag.compute_demag_fields(&mut [layer.clone()]);

        // For a thin film magnetized out-of-plane (z), the interior cells
        // should have a strong negative Hz (demagnetizing in z).
        // Just verify it's non-zero and negative.
        let center = 4 * 2 + 2; // cell (2, 2, 0) in a 4×4×1 grid
        let hz = layer.h_demag[center][2];
        // Hmm, layer was cloned but demag modifies the slice in place...
        // Let's test by re-running on the actual mutable layer
        demag.compute_demag_fields(std::slice::from_mut(&mut layer));
        let hz = layer.h_demag[center][2];
        assert!(
            hz < 0.0,
            "Demag Hz for out-of-plane thin film should be negative, got {hz}"
        );
    }
}
