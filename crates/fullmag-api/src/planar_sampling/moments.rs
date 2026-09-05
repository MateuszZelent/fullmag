#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ScalarMoments {
    pub measure: f64,
    pub first: f64,
    pub second: f64,
    pub min: f64,
    pub max: f64,
}

impl ScalarMoments {
    pub fn zero() -> Self {
        Self {
            measure: 0.0,
            first: 0.0,
            second: 0.0,
            min: f64::INFINITY,
            max: f64::NEG_INFINITY,
        }
    }

    pub fn from_constant(value: f64, measure: f64) -> Self {
        if measure <= 0.0 || !measure.is_finite() {
            return Self::zero();
        }
        Self {
            measure,
            first: value * measure,
            second: value * value * measure,
            min: value,
            max: value,
        }
    }

    pub fn from_affine_triangle(vertices: [f64; 3], area: f64) -> Self {
        if area <= 0.0 || !area.is_finite() {
            return Self::zero();
        }
        let sum = vertices[0] + vertices[1] + vertices[2];
        let sum_sq = vertices[0] * vertices[0] + vertices[1] * vertices[1] + vertices[2] * vertices[2];
        let first = area * sum / 3.0;
        let second = area * (sum * sum + sum_sq) / 12.0;
        let min = vertices[0].min(vertices[1]).min(vertices[2]);
        let max = vertices[0].max(vertices[1]).max(vertices[2]);
        Self {
            measure: area,
            first,
            second,
            min,
            max,
        }
    }

    pub fn from_affine_tetrahedron(vertices: [f64; 4], volume: f64) -> Self {
        if volume <= 0.0 || !volume.is_finite() {
            return Self::zero();
        }
        let sum = vertices[0] + vertices[1] + vertices[2] + vertices[3];
        let sum_sq = vertices.iter().map(|v| v * v).sum::<f64>();
        let first = volume * sum / 4.0;
        let second = volume * (sum * sum + sum_sq) / 20.0;
        let min = vertices.iter().copied().fold(f64::INFINITY, f64::min);
        let max = vertices.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        Self {
            measure: volume,
            first,
            second,
            min,
            max,
        }
    }

    pub fn merge(&mut self, other: &Self) {
        if other.measure <= 0.0 || !other.measure.is_finite() {
            return;
        }
        self.measure += other.measure;
        self.first += other.first;
        self.second += other.second;
        self.min = self.min.min(other.min);
        self.max = self.max.max(other.max);
    }
}
