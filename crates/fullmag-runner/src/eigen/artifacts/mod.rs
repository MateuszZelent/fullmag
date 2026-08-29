mod common;
mod field_sweep;
mod fmr;
mod kittel;
mod modal_manifest;
mod mode_bundle;

pub use super::response_block_real::{
    solve_and_write_field_driven_response_sweep_bundle,
    solve_and_write_field_driven_response_sweep_bundle_with_interrupt,
};
pub use common::{
    ServerArtifactExecution, ServerArtifactReference, ServerArtifactSource, ServerArtifactStatus,
    ServerArtifactTopology, ServerArtifactUnits,
};
pub use field_sweep::{
    build_frequency_domain_field_sweep_artifact, write_frequency_domain_field_sweep_artifact,
    FieldSweepAxisArtifact, FieldSweepDisplayConversion, FrequencyDomainFieldSweepArtifact,
    FrequencyDomainFieldSweepModeArtifact, FrequencyDomainFieldSweepSampleArtifact,
};
pub use fmr::{
    build_fmr_peaks_artifact, build_fmr_peaks_artifact_with_progress,
    build_resonance_fits_artifact, write_fmr_analysis_artifacts, write_response_sweep_artifact,
    write_response_sweep_bundle, write_response_sweep_bundle_with_progress, FmrPeakArtifact,
    FmrPeakSource, FmrPeakSourceKind, FmrPeakUncertainty, FmrPeaksArtifact, ResonanceFitArtifact,
    ResonanceFitsArtifact,
};
pub(crate) use kittel::k0_kittel_validation_auxiliary_artifacts;
pub use kittel::{
    build_kittel_fit_artifact, write_kittel_fit_artifact, KittelFitArtifact,
    KittelFitParameterArtifact, KittelFitPointArtifact,
};
pub use modal_manifest::{
    write_branch_bundle, write_frequency_domain_eigen_manifest, write_path_bundle,
};
pub use mode_bundle::write_mode_bundle;

#[cfg(test)]
mod tests;
