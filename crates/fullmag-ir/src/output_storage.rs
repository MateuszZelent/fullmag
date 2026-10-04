use serde::{Deserialize, Serialize};

/// Backend-neutral storage policy for one simulation output.
///
/// Paths are validated lexically here. Runtime owners are responsible for
/// resolving and reserving directories under their storage lease.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OutputStorageIR {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temp_dir: Option<String>,
    #[serde(default)]
    pub data_format: OutputDataFormatIR,
    #[serde(default)]
    pub cleanup: TempCleanupIR,
    #[serde(default)]
    pub existing_output: ExistingOutputIR,
}

impl Default for OutputStorageIR {
    fn default() -> Self {
        Self {
            output_dir: None,
            temp_dir: None,
            data_format: OutputDataFormatIR::default(),
            cleanup: TempCleanupIR::default(),
            existing_output: ExistingOutputIR::default(),
        }
    }
}

impl OutputStorageIR {
    /// Validate nonempty, NUL-free paths without touching the filesystem.
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();
        validate_path("output_dir", self.output_dir.as_deref(), &mut errors);
        validate_path("temp_dir", self.temp_dir.as_deref(), &mut errors);
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

fn validate_path(field: &str, value: Option<&str>, errors: &mut Vec<String>) {
    let Some(path) = value else {
        return;
    };
    if path.trim().is_empty() {
        errors.push(format!("output_storage.{field} must not be empty"));
        return;
    }
    if path.contains('\0') {
        errors.push(format!("output_storage.{field} must not contain NUL"));
    }
    if path
        .split(|character| character == '/' || character == '\\')
        .any(|component| component == "..")
    {
        errors.push(format!(
            "output_storage.{field} must not contain parent traversal"
        ));
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum OutputDataFormatIR {
    #[default]
    Zarr,
    #[serde(alias = "h5")]
    Hdf5,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum TempCleanupIR {
    #[default]
    OnSuccess,
    Always,
    Never,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ExistingOutputIR {
    #[default]
    Timestamp,
    Error,
}
