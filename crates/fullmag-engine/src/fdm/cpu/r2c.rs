use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::{mem::size_of, sync::Arc};

pub(crate) struct R2c3dPlan {
    px: usize,
    py: usize,
    pz: usize,
    sx: usize,
    r2c_x: Arc<dyn RealToComplex<f64>>,
    c2r_x: Arc<dyn ComplexToReal<f64>>,
    fwd_y: Arc<dyn Fft<f64>>,
    fwd_z: Arc<dyn Fft<f64>>,
    inv_y: Arc<dyn Fft<f64>>,
    inv_z: Arc<dyn Fft<f64>>,
    #[cfg(feature = "parallel")]
    scratch_len: usize,
    #[cfg(not(feature = "parallel"))]
    line_y: Vec<Complex<f64>>,
    #[cfg(not(feature = "parallel"))]
    line_z: Vec<Complex<f64>>,
    #[cfg(not(feature = "parallel"))]
    scratch: Vec<Complex<f64>>,
}

impl R2c3dPlan {
    pub(crate) fn new(px: usize, py: usize, pz: usize) -> Self {
        let mut real_planner = RealFftPlanner::<f64>::new();
        let r2c_x = real_planner.plan_fft_forward(px);
        let c2r_x = real_planner.plan_fft_inverse(px);
        let sx = r2c_x.complex_len();
        let mut planner = FftPlanner::<f64>::new();
        let fwd_y = planner.plan_fft_forward(py);
        let fwd_z = planner.plan_fft_forward(pz);
        let inv_y = planner.plan_fft_inverse(py);
        let inv_z = planner.plan_fft_inverse(pz);
        let scratch_len = [
            r2c_x.get_scratch_len(),
            c2r_x.get_scratch_len(),
            fwd_y.get_inplace_scratch_len(),
            fwd_z.get_inplace_scratch_len(),
            inv_y.get_inplace_scratch_len(),
            inv_z.get_inplace_scratch_len(),
        ]
        .into_iter()
        .max()
        .unwrap_or(0);
        Self {
            px,
            py,
            pz,
            sx,
            r2c_x,
            c2r_x,
            fwd_y,
            fwd_z,
            inv_y,
            inv_z,
            #[cfg(feature = "parallel")]
            scratch_len,
            #[cfg(not(feature = "parallel"))]
            line_y: vec![Complex::new(0.0, 0.0); py],
            #[cfg(not(feature = "parallel"))]
            line_z: vec![Complex::new(0.0, 0.0); pz],
            #[cfg(not(feature = "parallel"))]
            scratch: vec![Complex::new(0.0, 0.0); scratch_len],
        }
    }

    pub(crate) fn spectral_x_len(&self) -> usize {
        self.sx
    }

    pub(crate) fn spectral_len(&self) -> usize {
        self.sx * self.py * self.pz
    }

    pub(crate) fn owned_buffer_bytes(&self) -> u64 {
        #[cfg(feature = "parallel")]
        let complex_values = 0_usize;
        #[cfg(not(feature = "parallel"))]
        let complex_values = self
            .line_y
            .capacity()
            .saturating_add(self.line_z.capacity())
            .saturating_add(self.scratch.capacity());
        u64::try_from(complex_values.saturating_mul(size_of::<Complex<f64>>())).unwrap_or(u64::MAX)
    }

    pub(crate) fn forward(&mut self, real: &mut [f64], spectrum: &mut [Complex<f64>]) {
        assert_eq!(real.len(), self.px * self.py * self.pz);
        assert_eq!(spectrum.len(), self.spectral_len());

        #[cfg(feature = "parallel")]
        self.forward_parallel(real, spectrum);
        #[cfg(not(feature = "parallel"))]
        self.forward_sequential(real, spectrum);
    }

    pub(crate) fn inverse(&mut self, spectrum: &mut [Complex<f64>], real: &mut [f64]) {
        assert_eq!(spectrum.len(), self.spectral_len());
        assert_eq!(real.len(), self.px * self.py * self.pz);

        #[cfg(feature = "parallel")]
        self.inverse_parallel(spectrum, real);
        #[cfg(not(feature = "parallel"))]
        self.inverse_sequential(spectrum, real);
    }

    #[cfg(not(feature = "parallel"))]
    fn forward_sequential(&mut self, real: &mut [f64], spectrum: &mut [Complex<f64>]) {
        for row in 0..self.py * self.pz {
            self.r2c_x
                .process_with_scratch(
                    &mut real[row * self.px..(row + 1) * self.px],
                    &mut spectrum[row * self.sx..(row + 1) * self.sx],
                    &mut self.scratch,
                )
                .expect("validated R2C workspace dimensions");
        }
        transform_y_sequential(
            spectrum,
            self.sx,
            self.py,
            self.pz,
            &*self.fwd_y,
            &mut self.line_y,
            &mut self.scratch,
        );
        transform_z_sequential(
            spectrum,
            self.sx,
            self.py,
            self.pz,
            &*self.fwd_z,
            &mut self.line_z,
            &mut self.scratch,
        );
    }

    #[cfg(not(feature = "parallel"))]
    fn inverse_sequential(&mut self, spectrum: &mut [Complex<f64>], real: &mut [f64]) {
        transform_z_sequential(
            spectrum,
            self.sx,
            self.py,
            self.pz,
            &*self.inv_z,
            &mut self.line_z,
            &mut self.scratch,
        );
        transform_y_sequential(
            spectrum,
            self.sx,
            self.py,
            self.pz,
            &*self.inv_y,
            &mut self.line_y,
            &mut self.scratch,
        );
        for row in 0..self.py * self.pz {
            let spectrum_row = &mut spectrum[row * self.sx..(row + 1) * self.sx];
            enforce_real_endpoints(spectrum_row, self.px);
            self.c2r_x
                .process_with_scratch(
                    spectrum_row,
                    &mut real[row * self.px..(row + 1) * self.px],
                    &mut self.scratch,
                )
                .expect("validated C2R workspace dimensions and Hermitian endpoints");
        }
    }

    #[cfg(feature = "parallel")]
    fn forward_parallel(&self, real: &mut [f64], spectrum: &mut [Complex<f64>]) {
        use rayon::prelude::*;
        use std::cell::RefCell;

        thread_local! {
            static FFT_SCRATCH: RefCell<Vec<Complex<f64>>> = const { RefCell::new(Vec::new()) };
        }
        let r2c_x = &self.r2c_x;
        let scratch_len = self.scratch_len;
        real.par_chunks_mut(self.px)
            .zip(spectrum.par_chunks_mut(self.sx))
            .for_each(|(input, output)| {
                FFT_SCRATCH.with(|cell| {
                    let mut scratch = cell.borrow_mut();
                    resize_complex(&mut scratch, scratch_len);
                    r2c_x
                        .process_with_scratch(input, output, &mut scratch)
                        .expect("validated parallel R2C workspace dimensions");
                });
            });
        transform_y_parallel(
            spectrum,
            self.sx,
            self.py,
            self.pz,
            &*self.fwd_y,
            scratch_len,
        );
        transform_z_parallel(
            spectrum,
            self.sx,
            self.py,
            self.pz,
            &*self.fwd_z,
            scratch_len,
        );
    }

    #[cfg(feature = "parallel")]
    fn inverse_parallel(&self, spectrum: &mut [Complex<f64>], real: &mut [f64]) {
        use rayon::prelude::*;
        use std::cell::RefCell;

        transform_z_parallel(
            spectrum,
            self.sx,
            self.py,
            self.pz,
            &*self.inv_z,
            self.scratch_len,
        );
        transform_y_parallel(
            spectrum,
            self.sx,
            self.py,
            self.pz,
            &*self.inv_y,
            self.scratch_len,
        );
        thread_local! {
            static FFT_SCRATCH: RefCell<Vec<Complex<f64>>> = const { RefCell::new(Vec::new()) };
        }
        let c2r_x = &self.c2r_x;
        let px = self.px;
        let scratch_len = self.scratch_len;
        spectrum
            .par_chunks_mut(self.sx)
            .zip(real.par_chunks_mut(px))
            .for_each(|(input, output)| {
                enforce_real_endpoints(input, px);
                FFT_SCRATCH.with(|cell| {
                    let mut scratch = cell.borrow_mut();
                    resize_complex(&mut scratch, scratch_len);
                    c2r_x
                        .process_with_scratch(input, output, &mut scratch)
                        .expect("validated parallel C2R workspace dimensions and endpoints");
                });
            });
    }
}

fn enforce_real_endpoints(spectrum: &mut [Complex<f64>], real_len: usize) {
    spectrum[0].im = 0.0;
    if real_len % 2 == 0 {
        spectrum.last_mut().expect("non-empty R2C spectrum").im = 0.0;
    }
}

fn spectral_index(sx: usize, py: usize, x: usize, y: usize, z: usize) -> usize {
    x + sx * (y + py * z)
}

#[cfg(not(feature = "parallel"))]
fn transform_y_sequential(
    data: &mut [Complex<f64>],
    sx: usize,
    py: usize,
    pz: usize,
    fft: &dyn Fft<f64>,
    line: &mut [Complex<f64>],
    scratch: &mut [Complex<f64>],
) {
    for z in 0..pz {
        for x in 0..sx {
            for y in 0..py {
                line[y] = data[spectral_index(sx, py, x, y, z)];
            }
            fft.process_with_scratch(&mut line[..py], scratch);
            for y in 0..py {
                data[spectral_index(sx, py, x, y, z)] = line[y];
            }
        }
    }
}

#[cfg(not(feature = "parallel"))]
fn transform_z_sequential(
    data: &mut [Complex<f64>],
    sx: usize,
    py: usize,
    pz: usize,
    fft: &dyn Fft<f64>,
    line: &mut [Complex<f64>],
    scratch: &mut [Complex<f64>],
) {
    for y in 0..py {
        for x in 0..sx {
            for z in 0..pz {
                line[z] = data[spectral_index(sx, py, x, y, z)];
            }
            fft.process_with_scratch(&mut line[..pz], scratch);
            for z in 0..pz {
                data[spectral_index(sx, py, x, y, z)] = line[z];
            }
        }
    }
}

#[cfg(feature = "parallel")]
fn resize_complex(values: &mut Vec<Complex<f64>>, len: usize) {
    if values.len() < len {
        values.resize(len, Complex::new(0.0, 0.0));
    }
}

#[cfg(feature = "parallel")]
fn transform_y_parallel(
    data: &mut [Complex<f64>],
    sx: usize,
    py: usize,
    pz: usize,
    fft: &dyn Fft<f64>,
    scratch_len: usize,
) {
    use rayon::prelude::*;
    use std::cell::RefCell;

    thread_local! {
        static LINE: RefCell<Vec<Complex<f64>>> = const { RefCell::new(Vec::new()) };
        static SCRATCH: RefCell<Vec<Complex<f64>>> = const { RefCell::new(Vec::new()) };
    }
    data.par_chunks_mut(sx * py).take(pz).for_each(|slab| {
        LINE.with(|line_cell| {
            SCRATCH.with(|scratch_cell| {
                let mut line = line_cell.borrow_mut();
                let mut scratch = scratch_cell.borrow_mut();
                resize_complex(&mut line, py);
                resize_complex(&mut scratch, scratch_len);
                for x in 0..sx {
                    for y in 0..py {
                        line[y] = slab[x + sx * y];
                    }
                    fft.process_with_scratch(&mut line[..py], &mut scratch);
                    for y in 0..py {
                        slab[x + sx * y] = line[y];
                    }
                }
            });
        });
    });
}

#[cfg(feature = "parallel")]
fn transform_z_parallel(
    data: &mut [Complex<f64>],
    sx: usize,
    py: usize,
    pz: usize,
    fft: &dyn Fft<f64>,
    scratch_len: usize,
) {
    use rayon::prelude::*;
    use std::cell::RefCell;

    thread_local! {
        static LINE: RefCell<Vec<Complex<f64>>> = const { RefCell::new(Vec::new()) };
        static SCRATCH: RefCell<Vec<Complex<f64>>> = const { RefCell::new(Vec::new()) };
    }
    let data_base = data.as_mut_ptr() as usize;
    let data_len = data.len();
    (0..sx * py).into_par_iter().for_each(|column| {
        let y = column / sx;
        let x = column % sx;
        LINE.with(|line_cell| {
            SCRATCH.with(|scratch_cell| {
                let mut line = line_cell.borrow_mut();
                let mut scratch = scratch_cell.borrow_mut();
                resize_complex(&mut line, pz);
                resize_complex(&mut scratch, scratch_len);
                let pointer = data_base as *mut Complex<f64>;
                for z in 0..pz {
                    let index = spectral_index(sx, py, x, y, z);
                    debug_assert!(index < data_len);
                    line[z] = unsafe { *pointer.add(index) };
                }
                fft.process_with_scratch(&mut line[..pz], &mut scratch);
                for z in 0..pz {
                    let index = spectral_index(sx, py, x, y, z);
                    unsafe { *pointer.add(index) = line[z] };
                }
            });
        });
    });
}

#[cfg(test)]
mod tests {
    use super::{spectral_index, R2c3dPlan};
    use rustfft::num_complex::Complex;
    use std::f64::consts::TAU;

    fn direct_real_dft(
        input: &[f64],
        px: usize,
        py: usize,
        pz: usize,
        sx: usize,
    ) -> Vec<Complex<f64>> {
        let mut output = vec![Complex::new(0.0, 0.0); sx * py * pz];
        for kz in 0..pz {
            for ky in 0..py {
                for kx in 0..sx {
                    let mut sum = Complex::new(0.0, 0.0);
                    for z in 0..pz {
                        for y in 0..py {
                            for x in 0..px {
                                let phase = -TAU
                                    * ((kx * x) as f64 / px as f64
                                        + (ky * y) as f64 / py as f64
                                        + (kz * z) as f64 / pz as f64);
                                let value = input[x + px * (y + py * z)];
                                sum += Complex::new(value * phase.cos(), value * phase.sin());
                            }
                        }
                    }
                    output[spectral_index(sx, py, kx, ky, kz)] = sum;
                }
            }
        }
        output
    }

    fn assert_close(actual: Complex<f64>, expected: Complex<f64>) {
        let error = (actual - expected).norm();
        let scale = expected.norm().max(1.0);
        assert!(
            error <= 3e-12 * scale,
            "actual={actual:?} expected={expected:?} error={error}"
        );
    }

    #[test]
    fn half_spectrum_3d_matches_direct_dft_and_normalized_round_trip() {
        for [px, py, pz] in [[6, 3, 2], [5, 4, 3]] {
            let mut plan = R2c3dPlan::new(px, py, pz);
            let original: Vec<_> = (0..px * py * pz)
                .map(|index| {
                    let value = index as f64;
                    (0.19 * value).sin() + 0.03 * value
                })
                .collect();
            let mut real = original.clone();
            let mut spectrum = vec![Complex::new(0.0, 0.0); plan.spectral_len()];
            let expected = direct_real_dft(&original, px, py, pz, plan.spectral_x_len());

            plan.forward(&mut real, &mut spectrum);
            for (actual, expected) in spectrum.iter().zip(expected) {
                assert_close(*actual, expected);
            }

            plan.inverse(&mut spectrum, &mut real);
            let normalization = (px * py * pz) as f64;
            for (actual, expected) in real.iter().zip(original) {
                assert_close(
                    Complex::new(*actual / normalization, 0.0),
                    Complex::new(expected, 0.0),
                );
            }
        }
    }
}
