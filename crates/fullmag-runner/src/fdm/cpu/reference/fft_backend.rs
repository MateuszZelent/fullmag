use crate::types::{FdmFftExecutionProvenance, RunError};
use fullmag_ir::FdmFftPlanIR;

const RUSTFFT_CRATE_VERSION: &str = "6.4.1";
const RUSTFFT_PLAN_MODE: &str = "rustfft_planner_cached";
const RUSTFFT_WORKSPACE_LAYOUT: &str = "full_complex";

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
                "fdm.demag.fft_backend='{other}' is not available for CPU FDM demag in this build; supported CPU FDM FFT backends: auto, rustfft"
            ),
        }),
    }
}

pub(crate) fn resolve_cpu_fft_execution_for_demag(
    demag_enabled: bool,
    fft: Option<&FdmFftPlanIR>,
) -> Result<Option<FdmFftExecutionProvenance>, RunError> {
    if !demag_enabled && fft.is_some() {
        return Err(RunError {
            message: "FDM plan carries an FFT request while demag is disabled".to_string(),
        });
    }
    let requested = fft
        .map(|fft| fft.requested_backend.as_str())
        .unwrap_or("auto");
    let resolved = resolve_cpu_fft_backend_for_demag(demag_enabled, Some(requested))?;
    Ok(resolved.map(|backend| FdmFftExecutionProvenance {
        requested_backend: requested.to_string(),
        resolved_backend: backend.as_str().to_string(),
        executed_backend: backend.as_str().to_string(),
        backend_version: Some(RUSTFFT_CRATE_VERSION.to_string()),
        plan_mode: RUSTFFT_PLAN_MODE.to_string(),
        thread_count: None,
        workspace_layout: RUSTFFT_WORKSPACE_LAYOUT.to_string(),
        runtime_telemetry: None,
    }))
}

pub(crate) fn resolve_cpu_fft_backend_name_for_demag(
    demag_enabled: bool,
    fft: Option<&FdmFftPlanIR>,
) -> Result<Option<String>, RunError> {
    resolve_cpu_fft_execution_for_demag(demag_enabled, fft)
        .map(|execution| execution.map(|execution| execution.executed_backend))
}
