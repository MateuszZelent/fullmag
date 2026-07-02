use crate::types::RunError;

use std::env;

pub(crate) const CPU_FFT_BACKEND_ENV: &str = "FULLMAG_CPU_FFT_BACKEND";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CpuFftBackend {
    RustFft,
}

impl CpuFftBackend {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            CpuFftBackend::RustFft => "rustfft",
        }
    }
}

pub(crate) fn requested_cpu_fft_backend_from_env() -> Option<String> {
    env::var(CPU_FFT_BACKEND_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn resolve_cpu_fft_backend_for_demag(
    demag_enabled: bool,
    requested: Option<&str>,
) -> Result<Option<CpuFftBackend>, RunError> {
    if !demag_enabled {
        return Ok(None);
    }

    let normalized = requested
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("auto")
        .to_ascii_lowercase();

    match normalized.as_str() {
        "auto" | "rustfft" => Ok(Some(CpuFftBackend::RustFft)),
        other => Err(RunError {
            message: format!(
                "{CPU_FFT_BACKEND_ENV}='{other}' is not available for CPU FDM demag in this build; supported CPU FDM FFT backends: rustfft"
            ),
        }),
    }
}

pub(crate) fn resolve_cpu_fft_backend_name_for_demag(
    demag_enabled: bool,
) -> Result<Option<String>, RunError> {
    let requested = requested_cpu_fft_backend_from_env();
    resolve_cpu_fft_backend_for_demag(demag_enabled, requested.as_deref())
        .map(|backend| backend.map(|backend| backend.as_str().to_string()))
}
