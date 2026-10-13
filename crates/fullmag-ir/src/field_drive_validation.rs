//! Validation metadata for time-dependent magnetic and antenna drives.
//!
//! The quasistatic antenna basis is frequency independent only over a declared
//! waveform band.  This module makes the band classification explicit without
//! inventing a bandwidth for discontinuous or sampled waveforms.

use crate::model::TimeDependenceIR;
use crate::DriveActivationIR;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub(crate) fn validate_drive_activation(
    label: &str,
    activation: &DriveActivationIR,
    declared_stage_ids: Option<&BTreeSet<String>>,
    errors: &mut Vec<String>,
) {
    let DriveActivationIR::StageIds { stage_ids } = activation else {
        return;
    };
    if stage_ids.is_empty() {
        errors.push(format!("{label}.activation.stage_ids must not be empty"));
    }
    let mut local_ids = BTreeSet::new();
    for stage_id in stage_ids {
        if stage_id.trim().is_empty() || !local_ids.insert(stage_id.as_str()) {
            errors.push(format!(
                "{label}.activation stage ids must be non-empty and unique"
            ));
        }
        if declared_stage_ids.is_some_and(|ids| !ids.contains(stage_id)) {
            errors.push(format!(
                "{label}.activation stage id '{stage_id}' does not exist"
            ));
        }
    }
}

pub(crate) fn validate_time_dependence(
    label: &str,
    value: &TimeDependenceIR,
    errors: &mut Vec<String>,
) {
    match value {
        TimeDependenceIR::Constant => {}
        TimeDependenceIR::Sinusoidal {
            frequency_hz,
            phase_rad,
            offset,
        } => {
            if !frequency_hz.is_finite() || *frequency_hz <= 0.0 {
                errors.push(format!("{label} frequency_hz must be finite and > 0"));
            }
            if !phase_rad.is_finite() || !offset.is_finite() {
                errors.push(format!("{label} phase_rad and offset must be finite"));
            }
        }
        TimeDependenceIR::Pulse { t_on, t_off } => {
            if !t_on.is_finite() || !t_off.is_finite() || t_off <= t_on {
                errors.push(format!("{label} pulse requires finite t_off > t_on"));
            }
        }
        TimeDependenceIR::PiecewiseLinear { points } => {
            if points.len() < 2 {
                errors.push(format!(
                    "{label} piecewise_linear requires at least 2 points"
                ));
            }
            for point in points {
                if !point[0].is_finite() || !point[1].is_finite() {
                    errors.push(format!("{label} piecewise_linear points must be finite"));
                }
            }
            for window in points.windows(2) {
                if window[1][0] <= window[0][0] {
                    errors.push(format!(
                        "{label} piecewise_linear times must be strictly increasing"
                    ));
                }
            }
        }
        TimeDependenceIR::SincPulse {
            cutoff_hz,
            t0,
            amplitude,
        } => {
            if !cutoff_hz.is_finite() || *cutoff_hz <= 0.0 {
                errors.push(format!(
                    "{label} sinc_pulse cutoff_hz must be finite and > 0"
                ));
            }
            if !t0.is_finite() || *t0 < 0.0 || !amplitude.is_finite() {
                errors.push(format!(
                    "{label} sinc_pulse t0 must be finite and >= 0; amplitude must be finite"
                ));
            }
        }
    }
}

/// Schema for the bandwidth classification carried in plan provenance.
pub const ANTENNA_WAVEFORM_BANDWIDTH_SCHEMA_VERSION: &str = "antenna_waveform_bandwidth.v1";

/// Schema for an authored finite band attached to a non-bandlimited waveform.
///
/// The value is an explicit physical assumption.  It must not be inferred
/// from the sample period, knot spacing, pulse duration, or Nyquist frequency.
pub const ANTENNA_WAVEFORM_BANDWIDTH_DECLARATION_SCHEMA_VERSION: &str =
    "antenna_waveform_bandwidth_declaration.v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AntennaWaveformBandwidthDeclarationIR {
    /// Declared upper frequency of the physical waveform content [Hz].
    pub f_max_hz: f64,
}

impl AntennaWaveformBandwidthDeclarationIR {
    pub fn is_valid(&self) -> bool {
        self.f_max_hz.is_finite() && self.f_max_hz >= 0.0
    }
}

/// Diagnostic reason used when a waveform does not provide a finite band.
pub const ANTENNA_VALIDITY_BANDWIDTH_UNKNOWN: &str = "validity_bandwidth_unknown";

/// Source used to derive the maximum frequency of a supported waveform.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AntennaWaveformBandwidthSourceIR {
    Constant,
    Sinusoidal,
    SincCutoff,
    Declared,
}

impl AntennaWaveformBandwidthSourceIR {
    /// Stable source identifier for provenance and UI labels.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Constant => "constant",
            Self::Sinusoidal => "sinusoidal",
            Self::SincCutoff => "sinc_cutoff",
            Self::Declared => "declared",
        }
    }
}

/// Versioned classification of the frequency band available for separability
/// diagnostics. Unknown is intentional: a pulse or arbitrary sampled drive
/// must not be assigned `1 / duration` as if it were a physical cutoff.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AntennaWaveformBandwidthIR {
    Known {
        schema_version: String,
        f_max_hz: f64,
        source: AntennaWaveformBandwidthSourceIR,
    },
    Unknown {
        schema_version: String,
        reason: String,
    },
}

impl AntennaWaveformBandwidthIR {
    /// Return the finite maximum frequency when classification succeeded.
    pub fn f_max_hz(&self) -> Option<f64> {
        match self {
            Self::Known { f_max_hz, .. } => Some(*f_max_hz),
            Self::Unknown { .. } => None,
        }
    }

    /// Return the stable schema discriminator.
    pub fn schema_version(&self) -> &str {
        match self {
            Self::Known { schema_version, .. } | Self::Unknown { schema_version, .. } => {
                schema_version
            }
        }
    }
}

fn known(f_max_hz: f64, source: AntennaWaveformBandwidthSourceIR) -> AntennaWaveformBandwidthIR {
    AntennaWaveformBandwidthIR::Known {
        schema_version: ANTENNA_WAVEFORM_BANDWIDTH_SCHEMA_VERSION.to_string(),
        f_max_hz,
        source,
    }
}

fn unknown(reason: &str) -> AntennaWaveformBandwidthIR {
    AntennaWaveformBandwidthIR::Unknown {
        schema_version: ANTENNA_WAVEFORM_BANDWIDTH_SCHEMA_VERSION.to_string(),
        reason: reason.to_string(),
    }
}

/// Classify the maximum frequency available for the antenna separability
/// diagnostic.
///
/// `Constant` is a DC drive (`f_max = 0`).  A sinusoid and a normalized sinc
/// have an authored finite frequency parameter.  Rectangular pulses and
/// piecewise-linear waveforms do not: their ideal spectra are not bounded by
/// duration or knot spacing, so the result remains unknown unless the author
/// supplies an explicit physical band declaration.
pub fn classify_antenna_waveform_bandwidth(
    waveform: &TimeDependenceIR,
) -> AntennaWaveformBandwidthIR {
    classify_antenna_waveform_bandwidth_with_declaration(waveform, None)
}

/// Classify a waveform while honoring an explicit authored band for a
/// piecewise/sampled signal.  The declaration is intentionally ignored for
/// analytic waveforms with a canonical band, and invalid declarations remain
/// unknown instead of being silently accepted.
pub fn classify_antenna_waveform_bandwidth_with_declaration(
    waveform: &TimeDependenceIR,
    declaration: Option<&AntennaWaveformBandwidthDeclarationIR>,
) -> AntennaWaveformBandwidthIR {
    match waveform {
        TimeDependenceIR::Constant => known(0.0, AntennaWaveformBandwidthSourceIR::Constant),
        TimeDependenceIR::Sinusoidal { frequency_hz, .. } => {
            if frequency_hz.is_finite() && *frequency_hz > 0.0 {
                known(*frequency_hz, AntennaWaveformBandwidthSourceIR::Sinusoidal)
            } else {
                unknown("invalid_frequency_hz")
            }
        }
        TimeDependenceIR::SincPulse { cutoff_hz, .. } => {
            if cutoff_hz.is_finite() && *cutoff_hz > 0.0 {
                known(*cutoff_hz, AntennaWaveformBandwidthSourceIR::SincCutoff)
            } else {
                unknown("invalid_cutoff_hz")
            }
        }
        TimeDependenceIR::Pulse { .. } | TimeDependenceIR::PiecewiseLinear { .. } => declaration
            .map(|declaration| {
                if declaration.is_valid() {
                    known(
                        declaration.f_max_hz,
                        AntennaWaveformBandwidthSourceIR::Declared,
                    )
                } else {
                    unknown("invalid_declared_bandwidth_hz")
                }
            })
            .unwrap_or_else(|| unknown(ANTENNA_VALIDITY_BANDWIDTH_UNKNOWN)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activation_checks_structure_without_claiming_unknown_pipeline_is_empty() {
        let activation = DriveActivationIR::StageIds {
            stage_ids: vec!["run".to_string(), "run".to_string(), "missing".to_string()],
        };
        let mut errors = Vec::new();
        validate_drive_activation("drive", &activation, None, &mut errors);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("non-empty and unique"));

        errors.clear();
        validate_drive_activation(
            "drive",
            &activation,
            Some(&BTreeSet::from(["run".to_string()])),
            &mut errors,
        );
        assert!(errors.iter().any(|error| error.contains("'missing' does not exist")));
    }

    fn assert_known(
        waveform: TimeDependenceIR,
        expected_hz: f64,
        expected_source: AntennaWaveformBandwidthSourceIR,
    ) {
        let result = classify_antenna_waveform_bandwidth(&waveform);
        assert_eq!(result.f_max_hz(), Some(expected_hz));
        assert_eq!(
            result.schema_version(),
            ANTENNA_WAVEFORM_BANDWIDTH_SCHEMA_VERSION
        );
        assert!(matches!(
            result,
            AntennaWaveformBandwidthIR::Known { source, .. } if source == expected_source
        ));
    }

    #[test]
    fn constant_waveform_is_known_dc() {
        assert_known(
            TimeDependenceIR::Constant,
            0.0,
            AntennaWaveformBandwidthSourceIR::Constant,
        );
    }

    #[test]
    fn sinusoidal_waveform_uses_authored_frequency() {
        assert_known(
            TimeDependenceIR::Sinusoidal {
                frequency_hz: 4.5e9,
                phase_rad: 0.0,
                offset: 0.0,
            },
            4.5e9,
            AntennaWaveformBandwidthSourceIR::Sinusoidal,
        );
    }

    #[test]
    fn sinc_waveform_uses_authored_cutoff() {
        assert_known(
            TimeDependenceIR::SincPulse {
                cutoff_hz: 8.0e9,
                t0: 0.0,
                amplitude: 1.0,
            },
            8.0e9,
            AntennaWaveformBandwidthSourceIR::SincCutoff,
        );
    }

    #[test]
    fn discontinuous_and_sampled_waveforms_remain_unknown() {
        for waveform in [
            TimeDependenceIR::Pulse {
                t_on: 0.0,
                t_off: 1.0e-9,
            },
            TimeDependenceIR::PiecewiseLinear {
                points: vec![[0.0, 0.0], [1.0e-9, 1.0]],
            },
        ] {
            let result = classify_antenna_waveform_bandwidth(&waveform);
            assert_eq!(result.f_max_hz(), None);
            assert!(matches!(
                result,
                AntennaWaveformBandwidthIR::Unknown { reason, .. }
                    if reason == ANTENNA_VALIDITY_BANDWIDTH_UNKNOWN
            ));
        }
    }

    #[test]
    fn piecewise_waveform_uses_only_explicit_declared_band() {
        let waveform = TimeDependenceIR::PiecewiseLinear {
            points: vec![[0.0, 0.0], [1.0e-9, 1.0]],
        };
        let declaration = AntennaWaveformBandwidthDeclarationIR { f_max_hz: 6.0e9 };
        assert!(matches!(
            classify_antenna_waveform_bandwidth_with_declaration(&waveform, Some(&declaration)),
            AntennaWaveformBandwidthIR::Known {
                f_max_hz,
                source: AntennaWaveformBandwidthSourceIR::Declared,
                ..
            } if (f_max_hz - 6.0e9).abs() < f64::EPSILON
        ));
    }

    #[test]
    fn invalid_declared_band_does_not_fall_back_to_sample_period() {
        let waveform = TimeDependenceIR::PiecewiseLinear {
            points: vec![[0.0, 0.0], [1.0e-9, 1.0]],
        };
        let declaration = AntennaWaveformBandwidthDeclarationIR { f_max_hz: f64::NAN };
        assert!(matches!(
            classify_antenna_waveform_bandwidth_with_declaration(&waveform, Some(&declaration)),
            AntennaWaveformBandwidthIR::Unknown { reason, .. }
                if reason == "invalid_declared_bandwidth_hz"
        ));
    }

    #[test]
    fn invalid_authored_frequency_is_unknown() {
        for waveform in [
            TimeDependenceIR::Sinusoidal {
                frequency_hz: 0.0,
                phase_rad: 0.0,
                offset: 0.0,
            },
            TimeDependenceIR::SincPulse {
                cutoff_hz: f64::NAN,
                t0: 0.0,
                amplitude: 1.0,
            },
        ] {
            let result = classify_antenna_waveform_bandwidth(&waveform);
            assert!(result.f_max_hz().is_none());
            assert!(matches!(result, AntennaWaveformBandwidthIR::Unknown { .. }));
        }
    }
}
