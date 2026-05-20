use crate::study::KSamplingIR;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FrequencyExcitationIR {
    pub field_au_per_m: [f64; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FrequencySweepIR {
    pub values_hz: Vec<f64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResponseObservableIR {
    MComplex,
    UComplex,
    StrainComplex,
    StressComplex,
    SusceptibilityTensor,
    AbsorbedPowerDensity,
    ResponseAmplitude,
    ResponsePhase,
    ModeHybridizationIndex,
}

pub type FrequencyResponseOutputIR = ResponseObservableIR;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FrequencyResponseStudyFieldsIR {
    pub k_sampling: Option<KSamplingIR>,
    pub excitation: FrequencyExcitationIR,
    pub frequencies_hz: FrequencySweepIR,
}
