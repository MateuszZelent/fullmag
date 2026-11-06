//! Thin ownership wrapper for the optional native CUDA activity collector.
use serde::{Deserialize, Serialize};
use std::fs::File;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FemCudaTraceStats {
    pub schema_version: u64,
    pub cupti_version: u64,
    pub start_timestamp_ns: u64,
    pub end_timestamp_ns: u64,
    pub records_written: u64,
    pub bytes_written: u64,
    pub dropped_records: u64,
    pub buffer_starvations: u64,
    pub unknown_records: u64,
    pub truncated_names: u64,
    pub incomplete_records: u64,
    pub api_errors: u64,
    pub io_errors: u64,
    pub limit_flags: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FemCudaTraceEnd {
    pub status_code: i32,
    pub stats: FemCudaTraceStats,
}

pub fn fem_cuda_trace_available() -> bool {
    #[cfg(all(unix, any(feature = "fem-native", feature = "fem-gpu")))]
    { unsafe { fullmag_fem_sys::cuda_trace::fullmag_fem_cuda_trace_available_v1() == 1 } }
    #[cfg(not(all(unix, any(feature = "fem-native", feature = "fem-gpu"))))]
    { false }
}

/// The native collector duplicates the caller's exclusive regular-file fd.
/// Dropping this guard closes capture even if runner orchestration unwinds.
pub struct FemCudaTrace {
    token: Option<u64>,
}

impl FemCudaTrace {
    pub fn start(file: &File, max_bytes: u64, max_duration_ms: u32) -> Result<Self, String> {
        if !(4096..=268435456).contains(&max_bytes) || !(1..=120000).contains(&max_duration_ms) {
            return Err("CUDA trace byte/time budget is invalid".into());
        }
        #[cfg(all(unix, any(feature = "fem-native", feature = "fem-gpu")))]
        {
            use std::os::fd::AsRawFd;
            let mut token = 0;
            let status = unsafe { fullmag_fem_sys::cuda_trace::fullmag_fem_cuda_trace_start_v1(
                file.as_raw_fd(), max_bytes, max_duration_ms, &mut token) };
            if status != fullmag_fem_sys::FULLMAG_FEM_OK || token == 0 {
                return Err(format!("native CUDA trace startup failed: status={status}, token={token}"));
            }
            Ok(Self { token: Some(token) })
        }
        #[cfg(not(all(unix, any(feature = "fem-native", feature = "fem-gpu"))))]
        {
            let _ = file;
            Err("CUDA activity tracing is unavailable in this runtime".into())
        }
    }

    pub fn finish(&mut self) -> Result<FemCudaTraceEnd, String> {
        let token = self.token.take().ok_or("CUDA trace is already stopped")?;
        #[cfg(all(unix, any(feature = "fem-native", feature = "fem-gpu")))]
        {
            let mut native = fullmag_fem_sys::cuda_trace::fullmag_fem_cuda_trace_stats_v1::default();
            let status_code = unsafe { fullmag_fem_sys::cuda_trace::fullmag_fem_cuda_trace_stop_v1(token, &mut native) };
            Ok(FemCudaTraceEnd { status_code, stats: FemCudaTraceStats {
                schema_version: native.schema_version, cupti_version: native.cupti_version,
                start_timestamp_ns: native.start_timestamp_ns, end_timestamp_ns: native.end_timestamp_ns,
                records_written: native.records_written, bytes_written: native.bytes_written,
                dropped_records: native.dropped_records, buffer_starvations: native.buffer_starvations,
                unknown_records: native.unknown_records, truncated_names: native.truncated_names,
                incomplete_records: native.incomplete_records, api_errors: native.api_errors,
                io_errors: native.io_errors, limit_flags: native.limit_flags,
            } })
        }
        #[cfg(not(all(unix, any(feature = "fem-native", feature = "fem-gpu"))))]
        { let _ = token; Err("CUDA activity tracing is unavailable in this runtime".into()) }
    }
}

impl Drop for FemCudaTrace {
    fn drop(&mut self) {
        if self.token.is_some() { let _ = self.finish(); }
    }
}
