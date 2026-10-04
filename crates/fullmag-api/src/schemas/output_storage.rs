use fullmag_ir::{ExistingOutputIR, OutputDataFormatIR, OutputStorageIR, TempCleanupIR};
use serde::{Deserialize, Serialize};
use std::path::Path;
use utoipa::ToSchema;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema, Default)]
#[serde(rename_all = "snake_case")]
pub enum OutputDataFormatSchema {
    #[default]
    Zarr,
    #[serde(alias = "h5")]
    Hdf5,
}

impl From<OutputDataFormatSchema> for OutputDataFormatIR {
    fn from(value: OutputDataFormatSchema) -> Self {
        match value {
            OutputDataFormatSchema::Zarr => Self::Zarr,
            OutputDataFormatSchema::Hdf5 => Self::Hdf5,
        }
    }
}

impl From<OutputDataFormatIR> for OutputDataFormatSchema {
    fn from(value: OutputDataFormatIR) -> Self {
        match value {
            OutputDataFormatIR::Zarr => Self::Zarr,
            OutputDataFormatIR::Hdf5 => Self::Hdf5,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema, Default)]
#[serde(rename_all = "snake_case")]
pub enum TempCleanupSchema {
    #[default]
    OnSuccess,
    Always,
    Never,
}

impl From<TempCleanupSchema> for TempCleanupIR {
    fn from(value: TempCleanupSchema) -> Self {
        match value {
            TempCleanupSchema::OnSuccess => Self::OnSuccess,
            TempCleanupSchema::Always => Self::Always,
            TempCleanupSchema::Never => Self::Never,
        }
    }
}

impl From<TempCleanupIR> for TempCleanupSchema {
    fn from(value: TempCleanupIR) -> Self {
        match value {
            TempCleanupIR::OnSuccess => Self::OnSuccess,
            TempCleanupIR::Always => Self::Always,
            TempCleanupIR::Never => Self::Never,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema, Default)]
#[serde(rename_all = "snake_case")]
pub enum ExistingOutputSchema {
    #[default]
    Timestamp,
    Error,
}

impl From<ExistingOutputSchema> for ExistingOutputIR {
    fn from(value: ExistingOutputSchema) -> Self {
        match value {
            ExistingOutputSchema::Timestamp => Self::Timestamp,
            ExistingOutputSchema::Error => Self::Error,
        }
    }
}

impl From<ExistingOutputIR> for ExistingOutputSchema {
    fn from(value: ExistingOutputIR) -> Self {
        match value {
            ExistingOutputIR::Timestamp => Self::Timestamp,
            ExistingOutputIR::Error => Self::Error,
        }
    }
}

/// Per-session output storage overrides. Omitted fields retain safe defaults.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ToSchema, Default)]
#[serde(default, deny_unknown_fields)]
pub struct OutputStorageSettingsSchema {
    #[schema(nullable)]
    pub output_dir: Option<String>,
    #[schema(nullable)]
    pub temp_dir: Option<String>,
    pub data_format: OutputDataFormatSchema,
    pub cleanup: TempCleanupSchema,
    pub existing_output: ExistingOutputSchema,
}

impl OutputStorageSettingsSchema {
    pub fn to_ir(&self) -> OutputStorageIR {
        OutputStorageIR {
            output_dir: self.output_dir.clone(),
            temp_dir: self.temp_dir.clone(),
            data_format: self.data_format.into(),
            cleanup: self.cleanup.into(),
            existing_output: self.existing_output.into(),
        }
    }

    pub fn validated_ir(&self) -> Result<OutputStorageIR, String> {
        let ir = self.to_ir();
        ir.validate().map_err(|errors| errors.join("; "))?;
        validate_absolute_path("output_dir", ir.output_dir.as_deref())?;
        validate_absolute_path("temp_dir", ir.temp_dir.as_deref())?;
        validate_supported_format(ir.data_format)?;
        Ok(ir)
    }
}

/// Validates an optional selected path without requiring it to exist.
pub fn validate_absolute_path(field: &str, value: Option<&str>) -> Result<(), String> {
    let Some(value) = value else {
        return Ok(());
    };
    if !Path::new(value).is_absolute() {
        return Err(format!("output_storage.{field} must be an absolute path"));
    }
    Ok(())
}

fn validate_supported_format(format: OutputDataFormatIR) -> Result<(), String> {
    if fullmag_runner::project_storage::supported_data_formats().contains(&format) {
        Ok(())
    } else {
        Err(
            "HDF5 output is unavailable in this runtime (stage-autosave-hdf5 is not enabled)"
                .into(),
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct OutputStorageDefaultsRequest {
    pub output_parent: String,
    #[schema(nullable)]
    pub temp_parent: Option<String>,
    #[serde(default)]
    pub data_format: OutputDataFormatSchema,
    #[serde(default)]
    pub cleanup: TempCleanupSchema,
    #[serde(default)]
    pub existing_output: ExistingOutputSchema,
}

impl OutputStorageDefaultsRequest {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_paths()?;
        validate_supported_format(self.data_format.into())
    }

    pub fn validate_paths(&self) -> Result<(), String> {
        let ir = OutputStorageIR {
            output_dir: Some(self.output_parent.clone()),
            temp_dir: self.temp_parent.clone(),
            data_format: self.data_format.into(),
            cleanup: self.cleanup.into(),
            existing_output: self.existing_output.into(),
        };
        ir.validate().map_err(|errors| errors.join("; "))?;
        if !Path::new(&self.output_parent).is_absolute() {
            return Err("output_parent must be an absolute path".into());
        }
        validate_absolute_path("temp_parent", self.temp_parent.as_deref())
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct OutputStorageDefaultsResource {
    pub output_parent: String,
    #[schema(required, nullable)]
    pub temp_parent: Option<String>,
    pub data_format: OutputDataFormatSchema,
    pub cleanup: TempCleanupSchema,
    pub existing_output: ExistingOutputSchema,
    pub supported_formats: Vec<OutputDataFormatSchema>,
    #[schema(required, nullable)]
    pub hdf5_unavailable_reason: Option<String>,
}

pub fn supported_output_formats() -> Vec<OutputDataFormatSchema> {
    fullmag_runner::project_storage::supported_data_formats()
        .into_iter()
        .map(OutputDataFormatSchema::from)
        .collect()
}

pub fn hdf5_unavailable_reason() -> Option<String> {
    if supported_output_formats().contains(&OutputDataFormatSchema::Hdf5) {
        None
    } else {
        Some("This runtime was built without the stage-autosave-hdf5 feature.".to_string())
    }
}
