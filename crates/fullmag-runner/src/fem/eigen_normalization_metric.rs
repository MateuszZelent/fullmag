//! Outward enclosure of the modal mass quadratic for finite stored binary64 inputs.
//! This checks one normalization, not global Hermitian/positive-definite assembly.
use crate::types::RunError;
use num_complex::Complex64;

#[derive(Debug, Clone, Copy)]
pub(super) struct Interval {
    pub lower: f64,
    pub upper: f64,
}
impl Interval {
    fn point(value: f64) -> Self {
        Self {
            lower: value,
            upper: value,
        }
    }
    fn zero(self) -> bool {
        self.lower == 0.0 && self.upper == 0.0
    }
    pub(super) fn contains_zero(self) -> bool {
        self.lower <= 0.0 && self.upper >= 0.0
    }
    fn checked(lower: f64, upper: f64) -> Result<Self, RunError> {
        if !lower.is_finite() || !upper.is_finite() || lower > upper {
            return Err(error("modal norm interval overflow or invalid bounds"));
        }
        Ok(Self { lower, upper })
    }
    fn neg(self) -> Self {
        Self {
            lower: -self.upper,
            upper: -self.lower,
        }
    }
    fn add(self, other: Self) -> Result<Self, RunError> {
        if self.zero() {
            return Ok(other);
        }
        if other.zero() {
            return Ok(self);
        }
        Self::checked(
            (self.lower + other.lower).next_down(),
            (self.upper + other.upper).next_up(),
        )
    }
    fn sub(self, other: Self) -> Result<Self, RunError> {
        if other.zero() {
            return Ok(self);
        }
        if self.zero() {
            return Ok(other.neg());
        }
        Self::checked(
            (self.lower - other.upper).next_down(),
            (self.upper - other.lower).next_up(),
        )
    }
    fn mul(self, other: Self) -> Result<Self, RunError> {
        if self.zero() || other.zero() {
            return Ok(Self::point(0.0));
        }
        let products = [
            self.lower * other.lower,
            self.lower * other.upper,
            self.upper * other.lower,
            self.upper * other.upper,
        ];
        if products.iter().any(|value| !value.is_finite()) {
            return Err(error("modal norm interval product overflow"));
        }
        let lower = products
            .iter()
            .copied()
            .fold(f64::INFINITY, f64::min)
            .next_down();
        let upper = products
            .iter()
            .copied()
            .fold(f64::NEG_INFINITY, f64::max)
            .next_up();
        Self::checked(lower, upper)
    }
}

#[derive(Clone, Copy)]
struct ComplexInterval {
    real: Interval,
    imaginary: Interval,
}
impl ComplexInterval {
    fn point(value: Complex64) -> Self {
        Self {
            real: Interval::point(value.re),
            imaginary: Interval::point(value.im),
        }
    }
    fn conj(self) -> Self {
        Self {
            real: self.real,
            imaginary: self.imaginary.neg(),
        }
    }
    fn mul(self, other: Self) -> Result<Self, RunError> {
        Ok(Self {
            real: self
                .real
                .mul(other.real)?
                .sub(self.imaginary.mul(other.imaginary)?)?,
            imaginary: self
                .real
                .mul(other.imaginary)?
                .add(self.imaginary.mul(other.real)?)?,
        })
    }
    fn add(self, other: Self) -> Result<Self, RunError> {
        Ok(Self {
            real: self.real.add(other.real)?,
            imaginary: self.imaginary.add(other.imaginary)?,
        })
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) struct MassQuadraticEvaluation {
    /// Direct term accumulation; the legacy row-grouped observation is separate.
    pub value: Complex64,
    pub real: Interval,
    pub imaginary: Interval,
    pub terms: usize,
}
fn error(message: &str) -> RunError {
    RunError {
        message: message.into(),
    }
}
fn finite(value: Complex64) -> bool {
    value.re.is_finite() && value.im.is_finite()
}

fn gradual_underflow_available() -> bool {
    // Both operations execute at runtime. Bit tests avoid DAZ affecting comparisons.
    let normal = std::hint::black_box(f64::MIN_POSITIVE);
    let half = std::hint::black_box(0.5_f64);
    let subnormal = std::hint::black_box(normal * half);
    subnormal.to_bits() == 0x0008_0000_0000_0000
        && (subnormal * std::hint::black_box(2.0_f64)).to_bits() == f64::MIN_POSITIVE.to_bits()
}

/// Stream (q_i, M_ij, q_j), retaining duplicate sparse contributions.
/// Basic binary64 operations must not be reassociated/fast-math or use FTZ/DAZ.
pub(super) fn checked_mass_quadratic(
    contributions: impl IntoIterator<Item = (Complex64, Complex64, Complex64)>,
) -> Result<MassQuadraticEvaluation, RunError> {
    if !gradual_underflow_available() {
        return Err(error(
            "modal norm enclosure requires binary64 gradual underflow; FTZ/DAZ is unsupported",
        ));
    }
    let mut bounds = ComplexInterval::point(Complex64::new(0.0, 0.0));
    let mut value = Complex64::new(0.0, 0.0);
    let mut terms = 0usize;
    for (left, weight, right) in contributions {
        // Validate before skipping zeros: zero times a nonfinite entry is invalid.
        if !finite(left) || !finite(weight) || !finite(right) {
            return Err(error(
                "modal norm requires finite coefficients and mass entries",
            ));
        }
        if left == Complex64::new(0.0, 0.0)
            || weight == Complex64::new(0.0, 0.0)
            || right == Complex64::new(0.0, 0.0)
        {
            continue;
        }
        let partial_re = left.re * weight.re + left.im * weight.im;
        let partial_im = left.re * weight.im - left.im * weight.re;
        let term_re = partial_re * right.re - partial_im * right.im;
        let term_im = partial_re * right.im + partial_im * right.re;
        if !partial_re.is_finite()
            || !partial_im.is_finite()
            || !term_re.is_finite()
            || !term_im.is_finite()
        {
            return Err(error("modal norm complex product overflow"));
        }
        value.re += term_re;
        value.im += term_im;
        if !finite(value) {
            return Err(error("modal norm accumulation overflow"));
        }
        bounds = bounds.add(
            ComplexInterval::point(left)
                .conj()
                .mul(ComplexInterval::point(weight))?
                .mul(ComplexInterval::point(right))?,
        )?;
        terms = terms.saturating_add(1);
    }
    Ok(MassQuadraticEvaluation {
        value,
        real: bounds.real,
        imaginary: bounds.imaginary,
        terms,
    })
}
