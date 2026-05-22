use crate::Vector3;

/// Structure-of-Arrays layout for 3D vector fields.
///
/// Stores `x`, `y`, `z` components in separate contiguous arrays -- optimal for
/// SIMD, FFT gather/scatter, and GPU upload.
#[derive(Debug, Clone, PartialEq)]
pub struct VectorFieldSoA {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub z: Vec<f64>,
}

impl VectorFieldSoA {
    /// Allocate zeroed buffers for `n` vectors.
    pub fn zeros(n: usize) -> Self {
        Self {
            x: vec![0.0; n],
            y: vec![0.0; n],
            z: vec![0.0; n],
        }
    }

    pub fn len(&self) -> usize {
        self.x.len()
    }

    pub fn is_empty(&self) -> bool {
        self.x.is_empty()
    }

    pub fn fill_zero(&mut self) {
        self.x.fill(0.0);
        self.y.fill(0.0);
        self.z.fill(0.0);
    }

    /// Copy from another SoA field with the same logical length.
    pub fn copy_from(&mut self, other: &Self) {
        let n = other.len();
        debug_assert!(self.len() >= n);
        self.x[..n].copy_from_slice(&other.x[..n]);
        self.y[..n].copy_from_slice(&other.y[..n]);
        self.z[..n].copy_from_slice(&other.z[..n]);
    }

    /// Convert from AoS `&[Vector3]` without allocation (writes into self).
    pub fn scatter_from_aos(&mut self, aos: &[Vector3]) {
        let n = aos.len();
        debug_assert!(self.x.len() >= n);
        for i in 0..n {
            self.x[i] = aos[i][0];
            self.y[i] = aos[i][1];
            self.z[i] = aos[i][2];
        }
    }

    /// Convert to AoS `Vec<Vector3>`.
    pub fn gather_to_aos(&self) -> Vec<Vector3> {
        let n = self.x.len();
        let mut aos = Vec::with_capacity(n);
        for i in 0..n {
            aos.push([self.x[i], self.y[i], self.z[i]]);
        }
        aos
    }

    /// Convert to AoS into existing buffer (no allocation).
    pub fn gather_into_aos(&self, aos: &mut [Vector3]) {
        let n = self.x.len().min(aos.len());
        for i in 0..n {
            aos[i] = [self.x[i], self.y[i], self.z[i]];
        }
    }

    /// Create from AoS `&[Vector3]` (allocating).
    pub fn from_aos(aos: &[Vector3]) -> Self {
        let n = aos.len();
        let mut soa = Self::zeros(n);
        soa.scatter_from_aos(aos);
        soa
    }
}
