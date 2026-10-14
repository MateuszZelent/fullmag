//! Validates the proposed waveguide frame and signed global-k contract.
//!
//! `WaveguideFrameIR` is the raw requested value and is the only type here that
//! can be deserialized. `ValidatedWaveguideFrameIR` is created only after the
//! geometry checks below; it has private fields and no `Deserialize` impl.
//! `WaveguideSignedKIR` is likewise produced only by the checked projection.
//!
//! These helpers validate geometric input only. They do not perform capability
//! admission, choose or activate a provider, create a frame hash, or certify an
//! FEM result. Calling `validate_waveguide_frame` therefore does not make a
//! waveguide execution route available. Both public validation entry points
//! check at call time for IEEE gradual underflow; the check is repeated for each
//! projection because a validated frame may cross threads or floating-point
//! modes. The helpers never change the process floating-point environment.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Shared dimensionless tolerance for frame and signed-k geometry checks.
pub const WAVEGUIDE_GEOMETRY_TOLERANCE: f64 = 1.0e-12;
const F64_ABS_MASK: u64 = 0x7fff_ffff_ffff_ffff;

/// Three-component vector in global Cartesian coordinates.
pub type Vector3 = [f64; 3];

/// User-requested frame in global coordinates. This is input data, not a
/// validated or provider-enabled representation.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WaveguideFrameIR {
    pub origin_m: Vector3,
    pub e_u: Vector3,
    pub e_v: Vector3,
    pub axis_unit: Vector3,
}

/// Names an axis in a requested frame for validation diagnostics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameAxis {
    Eu,
    Ev,
    Axis,
}

/// Frame validation failures. Values are included where they aid diagnostics.
#[derive(Debug, Clone, PartialEq)]
pub enum WaveguideFrameValidationError {
    NonFiniteOrigin {
        component: usize,
    },
    NonFiniteAxisComponent {
        axis: FrameAxis,
        component: usize,
    },
    AxisLengthNotFiniteOrPositive {
        axis: FrameAxis,
        length: f64,
    },
    AxisNormOutsideTolerance {
        axis: FrameAxis,
        norm: f64,
    },
    NonFiniteNormalizedAxis {
        axis: FrameAxis,
    },
    AxesNotOrthogonal {
        first: FrameAxis,
        second: FrameAxis,
        dot: f64,
    },
    FrameNotRightHanded {
        determinant: f64,
    },
    NonFiniteWaveVectorComponent {
        component: usize,
    },
    UnsupportedFloatEnvironment {
        doubled_min_subnormal_bits: u64,
        halved_min_positive_bits: u64,
    },
    WaveVectorScaleNotRepresentable,
    ScaledWaveVectorNotRepresentable,
    SignedKNotRepresentable,
    ReconstructedKNotRepresentable {
        component: usize,
    },
    CollinearityErrorNotRepresentable,
    WaveVectorNotCollinear {
        relative_error: f64,
    },
}

impl fmt::Display for WaveguideFrameValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for WaveguideFrameValidationError {}

/// Canonicalized frame retained alongside the original request.
///
/// Its fields are private so downstream code can only obtain this value from
/// `validate_waveguide_frame`; the canonical axes are normalized by positive
/// lengths only and are never sign-canonicalized or Gram-Schmidt corrected.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct CanonicalWaveguideFrameIR {
    origin_m: Vector3,
    e_u: Vector3,
    e_v: Vector3,
    axis_unit: Vector3,
}

impl CanonicalWaveguideFrameIR {
    pub fn origin_m(&self) -> Vector3 {
        self.origin_m
    }

    pub fn e_u(&self) -> Vector3 {
        self.e_u
    }

    pub fn e_v(&self) -> Vector3 {
        self.e_v
    }

    pub fn axis_unit(&self) -> Vector3 {
        self.axis_unit
    }
}

/// Validated geometry. Private fields and the lack of `Deserialize` prevent
/// callers from bypassing frame validation when constructing this type.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct ValidatedWaveguideFrameIR {
    requested: WaveguideFrameIR,
    canonical: CanonicalWaveguideFrameIR,
    /// Positive dimensionless lengths (unit 1) used to normalize requested axes.
    normalization_lengths: Vector3,
    /// Absolute unit-norm deviations for requested `[e_u, e_v, axis]` (unit 1).
    requested_axis_norm_errors: Vector3,
    /// Signed canonical dots in order `(e_u,e_v)`, `(e_u,axis)`, `(e_v,axis)`.
    canonical_orthogonality_dots: Vector3,
    /// Signed determinant of the canonical `[e_u, e_v, axis]` frame.
    canonical_determinant: f64,
    geometry_tolerance: f64,
}

impl ValidatedWaveguideFrameIR {
    pub fn requested(&self) -> &WaveguideFrameIR {
        &self.requested
    }

    pub fn canonical(&self) -> &CanonicalWaveguideFrameIR {
        &self.canonical
    }

    pub fn normalization_lengths(&self) -> Vector3 {
        self.normalization_lengths
    }

    pub fn requested_axis_norm_errors(&self) -> Vector3 {
        self.requested_axis_norm_errors
    }

    pub fn canonical_orthogonality_dots(&self) -> Vector3 {
        self.canonical_orthogonality_dots
    }

    pub fn canonical_determinant(&self) -> f64 {
        self.canonical_determinant
    }

    pub fn geometry_tolerance(&self) -> f64 {
        self.geometry_tolerance
    }

    /// Projects the preserved global vector onto the validated signed axis.
    /// The scalar is rejected when it is not representable as finite `f64`.
    pub fn project_global_k(
        &self,
        requested_global_k_rad_per_m: Vector3,
    ) -> Result<WaveguideSignedKIR, WaveguideFrameValidationError> {
        require_gradual_underflow()?;

        for (component, value) in requested_global_k_rad_per_m.iter().copied().enumerate() {
            if !value.is_finite() {
                return Err(
                    WaveguideFrameValidationError::NonFiniteWaveVectorComponent { component },
                );
            }
        }

        // Use IEEE bits for the exact Gamma case. A numeric comparison can
        // treat subnormals as zero on DAZ-enabled hardware.
        if requested_global_k_rad_per_m
            .iter()
            .all(|value| value.to_bits() & F64_ABS_MASK == 0)
        {
            return Ok(WaveguideSignedKIR {
                requested_global_k_rad_per_m,
                signed_k_rad_per_m: 0.0,
                reconstructed_global_k_rad_per_m: [0.0; 3],
                collinearity_error: 0.0,
            });
        }

        let scale = requested_global_k_rad_per_m
            .iter()
            .map(|value| value.abs())
            .fold(0.0_f64, f64::max);
        if !scale.is_finite() || scale <= 0.0 {
            return Err(WaveguideFrameValidationError::WaveVectorScaleNotRepresentable);
        }

        // Scale first so products and sums stay bounded, including for large
        // inputs whose individual components are finite. Scaling also retains
        // exact subnormal collinear inputs such as [0, 0, f64::from_bits(1)]
        // when the execution environment preserves subnormal arithmetic.
        let scaled_k = requested_global_k_rad_per_m.map(|value| value / scale);
        if scaled_k.iter().any(|value| !value.is_finite())
            || scaled_k
                .iter()
                .all(|value| value.to_bits() & F64_ABS_MASK == 0)
        {
            return Err(WaveguideFrameValidationError::ScaledWaveVectorNotRepresentable);
        }
        let scaled_projection = dot3(scaled_k, self.canonical.axis_unit);
        if !scaled_projection.is_finite() {
            return Err(WaveguideFrameValidationError::SignedKNotRepresentable);
        }
        let signed_k_rad_per_m = scale * scaled_projection;
        if !signed_k_rad_per_m.is_finite() {
            return Err(WaveguideFrameValidationError::SignedKNotRepresentable);
        }

        let reconstructed_global_k_rad_per_m = self
            .canonical
            .axis_unit
            .map(|component| signed_k_rad_per_m * component);
        for (component, value) in reconstructed_global_k_rad_per_m.iter().copied().enumerate() {
            if !value.is_finite() {
                return Err(
                    WaveguideFrameValidationError::ReconstructedKNotRepresentable { component },
                );
            }
        }

        // Compare in scaled coordinates. This avoids forming an overflowing
        // norm(k), and uses the actual rounded reconstruction returned above.
        let reconstructed_scaled = reconstructed_global_k_rad_per_m.map(|value| value / scale);
        if reconstructed_scaled.iter().any(|value| !value.is_finite()) {
            return Err(WaveguideFrameValidationError::CollinearityErrorNotRepresentable);
        }
        let residual = [
            scaled_k[0] - reconstructed_scaled[0],
            scaled_k[1] - reconstructed_scaled[1],
            scaled_k[2] - reconstructed_scaled[2],
        ];
        if residual.iter().any(|value| !value.is_finite()) {
            return Err(WaveguideFrameValidationError::CollinearityErrorNotRepresentable);
        }
        let scaled_k_norm = stable_norm3(scaled_k);
        let residual_norm = stable_norm3(residual);
        if !scaled_k_norm.is_finite() || scaled_k_norm <= 0.0 || !residual_norm.is_finite() {
            return Err(WaveguideFrameValidationError::CollinearityErrorNotRepresentable);
        }
        let relative_error = residual_norm / scaled_k_norm;
        if !relative_error.is_finite() {
            return Err(WaveguideFrameValidationError::CollinearityErrorNotRepresentable);
        }
        if relative_error > self.geometry_tolerance {
            return Err(WaveguideFrameValidationError::WaveVectorNotCollinear { relative_error });
        }

        Ok(WaveguideSignedKIR {
            requested_global_k_rad_per_m,
            signed_k_rad_per_m,
            reconstructed_global_k_rad_per_m,
            collinearity_error: relative_error,
        })
    }
}

/// Resolved projection sample. It preserves the requested global vector and
/// exposes both the signed scalar and the actual rounded reconstruction.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct WaveguideSignedKIR {
    requested_global_k_rad_per_m: Vector3,
    signed_k_rad_per_m: f64,
    reconstructed_global_k_rad_per_m: Vector3,
    collinearity_error: f64,
}

impl WaveguideSignedKIR {
    pub fn requested_global_k_rad_per_m(&self) -> Vector3 {
        self.requested_global_k_rad_per_m
    }

    pub fn signed_k_rad_per_m(&self) -> f64 {
        self.signed_k_rad_per_m
    }

    pub fn reconstructed_global_k_rad_per_m(&self) -> Vector3 {
        self.reconstructed_global_k_rad_per_m
    }

    pub fn collinearity_error(&self) -> f64 {
        self.collinearity_error
    }
}

/// Validates finite coordinates, unit norms, orthogonality, and right-handedness.
/// Each requested axis is normalized only by its own positive stable norm.
pub fn validate_waveguide_frame(
    requested: WaveguideFrameIR,
) -> Result<ValidatedWaveguideFrameIR, WaveguideFrameValidationError> {
    require_gradual_underflow()?;

    for (component, value) in requested.origin_m.iter().copied().enumerate() {
        if !value.is_finite() {
            return Err(WaveguideFrameValidationError::NonFiniteOrigin { component });
        }
    }

    let requested_axes = [
        (FrameAxis::Eu, requested.e_u),
        (FrameAxis::Ev, requested.e_v),
        (FrameAxis::Axis, requested.axis_unit),
    ];
    let mut canonical_axes = [[0.0; 3]; 3];
    let mut normalization_lengths = [0.0; 3];
    let mut requested_axis_norm_errors = [0.0; 3];

    for (axis_index, (axis, vector)) in requested_axes.into_iter().enumerate() {
        for (component, value) in vector.iter().copied().enumerate() {
            if !value.is_finite() {
                return Err(WaveguideFrameValidationError::NonFiniteAxisComponent {
                    axis,
                    component,
                });
            }
        }

        let length = stable_norm3(vector);
        if !length.is_finite() || length <= 0.0 {
            return Err(
                WaveguideFrameValidationError::AxisLengthNotFiniteOrPositive { axis, length },
            );
        }
        let norm_error = (length - 1.0).abs();
        if norm_error > WAVEGUIDE_GEOMETRY_TOLERANCE {
            return Err(WaveguideFrameValidationError::AxisNormOutsideTolerance {
                axis,
                norm: length,
            });
        }

        let normalized = vector.map(|component| component / length);
        if normalized.iter().any(|component| !component.is_finite()) {
            return Err(WaveguideFrameValidationError::NonFiniteNormalizedAxis { axis });
        }
        canonical_axes[axis_index] = normalized;
        normalization_lengths[axis_index] = length;
        requested_axis_norm_errors[axis_index] = norm_error;
    }

    let axis_names = [FrameAxis::Eu, FrameAxis::Ev, FrameAxis::Axis];
    let orthogonality_pairs = [(0, 1), (0, 2), (1, 2)];
    let mut canonical_orthogonality_dots = [0.0; 3];
    for (metric_index, (first_index, second_index)) in orthogonality_pairs.into_iter().enumerate() {
        let dot = dot3(canonical_axes[first_index], canonical_axes[second_index]);
        if !dot.is_finite() || dot.abs() > WAVEGUIDE_GEOMETRY_TOLERANCE {
            return Err(WaveguideFrameValidationError::AxesNotOrthogonal {
                first: axis_names[first_index],
                second: axis_names[second_index],
                dot,
            });
        }
        canonical_orthogonality_dots[metric_index] = dot;
    }

    let determinant = dot3(
        canonical_axes[0],
        cross3(canonical_axes[1], canonical_axes[2]),
    );
    if !determinant.is_finite()
        || determinant <= 0.0
        || (determinant - 1.0).abs() > WAVEGUIDE_GEOMETRY_TOLERANCE
    {
        return Err(WaveguideFrameValidationError::FrameNotRightHanded { determinant });
    }

    Ok(ValidatedWaveguideFrameIR {
        requested,
        canonical: CanonicalWaveguideFrameIR {
            origin_m: requested.origin_m,
            e_u: canonical_axes[0],
            e_v: canonical_axes[1],
            axis_unit: canonical_axes[2],
        },
        normalization_lengths,
        requested_axis_norm_errors,
        canonical_orthogonality_dots,
        canonical_determinant: determinant,
        geometry_tolerance: WAVEGUIDE_GEOMETRY_TOLERANCE,
    })
}

fn require_gradual_underflow() -> Result<(), WaveguideFrameValidationError> {
    crate::floating_point_guard::require_ieee_gradual_underflow().map_err(|error| {
        WaveguideFrameValidationError::UnsupportedFloatEnvironment {
            doubled_min_subnormal_bits: error.doubled_min_subnormal_bits,
            halved_min_positive_bits: error.halved_min_positive_bits,
        }
    })
}

fn stable_norm3(vector: Vector3) -> f64 {
    vector[0].hypot(vector[1]).hypot(vector[2])
}

fn dot3(left: Vector3, right: Vector3) -> f64 {
    // The operands used here are normalized axes or max-scaled k components,
    // so each product is bounded and the sum cannot overflow.
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}

fn cross3(left: Vector3, right: Vector3) -> Vector3 {
    [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct FrameFixtureCorpus {
        schema: String,
        geometry_tolerance: f64,
        oracle: String,
        cases: Vec<FrameFixtureCase>,
    }

    #[derive(Debug, serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct FrameFixtureCase {
        name: String,
        frame: WaveguideFrameIR,
        k_vector: Vector3,
        frame_valid: bool,
        k_valid: bool,
        expected_signed_k_rad_per_m: Option<f64>,
    }

    fn unit_frame() -> WaveguideFrameIR {
        WaveguideFrameIR {
            origin_m: [0.0, 0.0, 0.0],
            e_u: [1.0, 0.0, 0.0],
            e_v: [0.0, 1.0, 0.0],
            axis_unit: [0.0, 0.0, 1.0],
        }
    }

    #[test]
    fn gradual_underflow_guard_accepts_ieee_default_environment() {
        assert!(require_gradual_underflow().is_ok());
    }

    fn diagonal_frame() -> WaveguideFrameIR {
        let inverse_sqrt_two = 1.0 / 2.0_f64.sqrt();
        let inverse_sqrt_six = 1.0 / 6.0_f64.sqrt();
        let inverse_sqrt_three = 1.0 / 3.0_f64.sqrt();
        WaveguideFrameIR {
            origin_m: [0.0, 0.0, 0.0],
            e_u: [inverse_sqrt_two, -inverse_sqrt_two, 0.0],
            e_v: [inverse_sqrt_six, inverse_sqrt_six, -2.0 * inverse_sqrt_six],
            axis_unit: [inverse_sqrt_three; 3],
        }
    }

    fn assert_scalar_matches_fixture(actual: f64, expected: f64, case_name: &str) {
        if expected == 0.0 {
            assert_eq!(actual, 0.0, "{case_name}: exact zero scalar");
        } else if expected.abs() < f64::MIN_POSITIVE {
            assert_eq!(
                actual.to_bits(),
                expected.to_bits(),
                "{case_name}: subnormal scalar must be correctly rounded"
            );
        } else {
            let relative_error = (actual / expected - 1.0).abs();
            assert!(
                relative_error.is_finite() && relative_error <= 1.0e-12,
                "{case_name}: scalar {actual:e} differs from {expected:e} by {relative_error:e}"
            );
        }
    }

    #[test]
    fn shared_high_precision_cases_cover_frame_and_signed_k_contract() {
        let corpus: FrameFixtureCorpus = serde_json::from_str(include_str!(
            "../tests/fixtures/waveguide_frame_cases.v1.json"
        ))
        .expect("shared frame fixture must be valid JSON");
        assert_eq!(corpus.schema, "fullmag.waveguide-frame-cases.v1");
        assert_eq!(corpus.geometry_tolerance, WAVEGUIDE_GEOMETRY_TOLERANCE);
        assert_eq!(corpus.oracle, "independent_decimal_100_digits");
        assert_eq!(corpus.cases.len(), 18);

        for case in corpus.cases {
            let resolved = validate_waveguide_frame(case.frame);
            assert_eq!(
                resolved.is_ok(),
                case.frame_valid,
                "{}: frame validity",
                case.name
            );
            match resolved {
                Ok(frame) => {
                    let projected = frame.project_global_k(case.k_vector);
                    assert_eq!(
                        projected.is_ok(),
                        case.k_valid,
                        "{}: signed-k validity",
                        case.name
                    );
                    match projected {
                        Ok(sample) => {
                            assert_eq!(
                                sample.requested_global_k_rad_per_m(),
                                case.k_vector,
                                "{}: requested global k must be preserved",
                                case.name
                            );
                            assert!(sample.signed_k_rad_per_m().is_finite());
                            assert!(sample
                                .reconstructed_global_k_rad_per_m()
                                .iter()
                                .all(|value| value.is_finite()));
                            assert!(sample.collinearity_error().is_finite());
                            assert!(sample.collinearity_error() <= WAVEGUIDE_GEOMETRY_TOLERANCE);
                            assert_scalar_matches_fixture(
                                sample.signed_k_rad_per_m(),
                                case.expected_signed_k_rad_per_m
                                    .expect("valid k fixture includes expected scalar"),
                                &case.name,
                            );
                        }
                        Err(_) => assert!(
                            case.expected_signed_k_rad_per_m.is_none(),
                            "{}: invalid k must not publish an expected scalar",
                            case.name
                        ),
                    }
                }
                Err(_) => {
                    assert!(
                        !case.k_valid,
                        "{}: invalid frame cannot have valid k",
                        case.name
                    );
                    assert!(case.expected_signed_k_rad_per_m.is_none());
                }
            }
        }
    }

    #[test]
    fn resolved_types_retain_request_lengths_and_fixed_tolerance() {
        let requested = WaveguideFrameIR {
            e_u: [1.0 + 5.0e-13, 0.0, 0.0],
            e_v: [0.0, 1.0 - 2.5e-13, 0.0],
            axis_unit: [0.0, 0.0, 1.0 + 7.5e-13],
            ..unit_frame()
        };
        let resolved = validate_waveguide_frame(requested).expect("near-unit axes are allowed");
        assert_eq!(*resolved.requested(), requested);
        let normalization_lengths = resolved.normalization_lengths();
        assert!(normalization_lengths.iter().all(|length| *length > 0.0));
        let norm_errors = resolved.requested_axis_norm_errors();
        assert_eq!(
            norm_errors,
            normalization_lengths.map(|length| (length - 1.0).abs())
        );
        assert!(norm_errors.iter().any(|error| *error > 0.0));
        assert_eq!(resolved.canonical_orthogonality_dots(), [0.0; 3]);
        assert_eq!(resolved.canonical_determinant(), 1.0);
        assert_eq!(resolved.geometry_tolerance(), 1.0e-12);
        assert_eq!(resolved.canonical().e_u(), [1.0, 0.0, 0.0]);
        assert_eq!(resolved.canonical().e_v(), [0.0, 1.0, 0.0]);
        assert_eq!(resolved.canonical().axis_unit(), [0.0, 0.0, 1.0]);
    }

    #[test]
    fn axis_reversal_is_preserved_and_flips_the_signed_scalar() {
        let forward = validate_waveguide_frame(unit_frame()).unwrap();
        let reversed = validate_waveguide_frame(WaveguideFrameIR {
            e_v: [0.0, -1.0, 0.0],
            axis_unit: [0.0, 0.0, -1.0],
            ..unit_frame()
        })
        .unwrap();
        let global_k = [0.0, 0.0, 2.0];
        let forward_sample = forward.project_global_k(global_k).unwrap();
        let reversed_sample = reversed.project_global_k(global_k).unwrap();
        assert_eq!(forward_sample.signed_k_rad_per_m(), 2.0);
        assert_eq!(reversed_sample.signed_k_rad_per_m(), -2.0);
        assert_eq!(forward_sample.reconstructed_global_k_rad_per_m(), global_k);
        assert_eq!(reversed_sample.reconstructed_global_k_rad_per_m(), global_k);
    }

    #[test]
    fn zero_and_subnormal_collinear_k_are_not_discarded_by_a_floor() {
        let frame = validate_waveguide_frame(unit_frame()).unwrap();
        let zero = frame.project_global_k([-0.0, 0.0, -0.0]).unwrap();
        assert_eq!(zero.signed_k_rad_per_m(), 0.0);
        assert_eq!(zero.reconstructed_global_k_rad_per_m(), [0.0; 3]);
        assert_eq!(zero.collinearity_error(), 0.0);

        let smallest = f64::from_bits(1);
        let tiny = frame.project_global_k([0.0, 0.0, smallest]).unwrap();
        assert_eq!(tiny.signed_k_rad_per_m().to_bits(), smallest.to_bits());
        assert_eq!(
            tiny.reconstructed_global_k_rad_per_m(),
            [0.0, 0.0, smallest]
        );
        assert_eq!(tiny.collinearity_error(), 0.0);
    }

    #[test]
    fn tiny_transverse_k_is_rejected_by_relative_error() {
        let frame = validate_waveguide_frame(unit_frame()).unwrap();
        let error = frame.project_global_k([0.0, 1.0e-300, 0.0]).unwrap_err();
        assert!(matches!(
            error,
            WaveguideFrameValidationError::WaveVectorNotCollinear { .. }
        ));
    }

    #[test]
    fn scaled_projection_accepts_representable_huge_diagonal_k_and_rejects_overflow() {
        let frame = validate_waveguide_frame(diagonal_frame()).unwrap();
        let maximum = f64::MAX;
        let legal_component = 0.5 * maximum;
        let legal = frame
            .project_global_k([legal_component; 3])
            .expect("diagonal projection remains representable");
        assert!(legal.signed_k_rad_per_m().is_finite());
        assert!(legal.signed_k_rad_per_m() > 0.0);
        assert!(legal.collinearity_error() <= WAVEGUIDE_GEOMETRY_TOLERANCE);
        for component in legal.reconstructed_global_k_rad_per_m() {
            assert!(component.is_finite());
        }

        let overflowing_component = 0.6 * maximum;
        assert!(matches!(
            frame.project_global_k([overflowing_component; 3]),
            Err(WaveguideFrameValidationError::SignedKNotRepresentable)
        ));
    }

    #[test]
    fn non_finite_origin_axes_and_k_are_rejected() {
        let mut request = unit_frame();
        request.origin_m[1] = f64::INFINITY;
        assert!(matches!(
            validate_waveguide_frame(request),
            Err(WaveguideFrameValidationError::NonFiniteOrigin { component: 1 })
        ));

        let mut request = unit_frame();
        request.e_v[2] = f64::NAN;
        assert!(matches!(
            validate_waveguide_frame(request),
            Err(WaveguideFrameValidationError::NonFiniteAxisComponent {
                axis: FrameAxis::Ev,
                component: 2
            })
        ));

        let frame = validate_waveguide_frame(unit_frame()).unwrap();
        assert!(matches!(
            frame.project_global_k([0.0, f64::NEG_INFINITY, 0.0]),
            Err(WaveguideFrameValidationError::NonFiniteWaveVectorComponent { component: 1 })
        ));
    }

    #[test]
    fn left_handed_frame_and_zero_axis_are_rejected() {
        let left_handed = WaveguideFrameIR {
            e_v: [0.0, -1.0, 0.0],
            ..unit_frame()
        };
        assert!(matches!(
            validate_waveguide_frame(left_handed),
            Err(WaveguideFrameValidationError::FrameNotRightHanded { .. })
        ));

        let zero_axis = WaveguideFrameIR {
            axis_unit: [0.0; 3],
            ..unit_frame()
        };
        assert!(matches!(
            validate_waveguide_frame(zero_axis),
            Err(
                WaveguideFrameValidationError::AxisLengthNotFiniteOrPositive {
                    axis: FrameAxis::Axis,
                    ..
                }
            )
        ));
    }

    #[test]
    fn raw_request_rejects_unknown_fields() {
        let json = serde_json::json!({
            "origin_m": [0.0, 0.0, 0.0],
            "e_u": [1.0, 0.0, 0.0],
            "e_v": [0.0, 1.0, 0.0],
            "axis_unit": [0.0, 0.0, 1.0],
            "unrecognized": true
        });
        assert!(serde_json::from_value::<WaveguideFrameIR>(json).is_err());
    }
}
