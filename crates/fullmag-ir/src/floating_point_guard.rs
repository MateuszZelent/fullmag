//! Shared IEEE gradual-underflow check without changing the floating-point mode.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct GradualUnderflowError {
    pub(crate) doubled_min_subnormal_bits: u64,
    pub(crate) halved_min_positive_bits: u64,
}

pub(crate) fn require_ieee_gradual_underflow() -> Result<(), GradualUnderflowError> {
    let min_subnormal = f64::from_bits(1);
    let two = std::hint::black_box(2.0_f64);
    let doubled_min_subnormal = std::hint::black_box(min_subnormal) * two;
    let min_positive = std::hint::black_box(f64::MIN_POSITIVE);
    let halved_min_positive = min_positive / two;
    let doubled_min_subnormal_bits = doubled_min_subnormal.to_bits();
    let halved_min_positive_bits = halved_min_positive.to_bits();

    if doubled_min_subnormal_bits == 0x0000_0000_0000_0002
        && halved_min_positive_bits == 0x0008_0000_0000_0000
    {
        Ok(())
    } else {
        Err(GradualUnderflowError {
            doubled_min_subnormal_bits,
            halved_min_positive_bits,
        })
    }
}
