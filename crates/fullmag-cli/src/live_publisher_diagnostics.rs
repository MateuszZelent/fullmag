pub(crate) fn record_worker_build(
    diagnostics: &mut fullmag_runner::LivePublisherDiagnostics,
    state_lock_wall_time_ns: u64,
    delta_build_wall_time_ns: u64,
    replace_wall_time_ns: u64,
    payload_estimated_bytes: u64,
) {
    diagnostics.replace_count = diagnostics.replace_count.saturating_add(1);
    diagnostics.state_lock_wall_time_ns = state_lock_wall_time_ns;
    diagnostics.delta_build_wall_time_ns = delta_build_wall_time_ns;
    diagnostics.replace_wall_time_ns = replace_wall_time_ns;
    diagnostics.last_payload_estimated_bytes = payload_estimated_bytes;
    diagnostics.max_payload_estimated_bytes = diagnostics
        .max_payload_estimated_bytes
        .max(payload_estimated_bytes);
    diagnostics.last_replace_wall_time_ns = replace_wall_time_ns;
    diagnostics.max_replace_wall_time_ns = diagnostics
        .max_replace_wall_time_ns
        .max(replace_wall_time_ns);
    diagnostics.total_replace_wall_time_ns = diagnostics
        .total_replace_wall_time_ns
        .saturating_add(replace_wall_time_ns);
}
