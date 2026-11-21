//! Optional process-local CUPTI diagnostics ABI; no solver or Context state.

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct fullmag_fem_cuda_trace_stats_v1 {
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

const _: () = assert!(std::mem::size_of::<fullmag_fem_cuda_trace_stats_v1>() == 112);

unsafe extern "C" {
    pub fn fullmag_fem_cuda_trace_available_v1() -> i32;
    pub fn fullmag_fem_cuda_trace_start_v1(
        output_fd: i32, max_bytes: u64, max_duration_ms: u32, token: *mut u64,
    ) -> i32;
    pub fn fullmag_fem_cuda_trace_stop_v1(
        token: u64, stats: *mut fullmag_fem_cuda_trace_stats_v1,
    ) -> i32;
}
