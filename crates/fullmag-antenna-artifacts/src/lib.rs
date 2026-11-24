//! Backend-neutral, retained antenna artifact validation. No solver execution.

pub mod artifact_json;
pub mod bundle;
pub mod charge;
pub mod current_display;
pub mod package;
pub mod retained_current;
pub mod sample_carrier;
pub mod source_preparation;
pub mod solution;

pub use sample_carrier::AntennaSampleCarrier;

#[derive(Debug)]
pub struct ArtifactError {
    pub message: String,
}

impl std::fmt::Display for ArtifactError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ArtifactError {}
