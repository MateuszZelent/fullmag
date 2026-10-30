//! Bounded, credential-redacted child-process diagnostics shared by supervisors.

pub(super) const PROCESS_DIAGNOSTIC_TAIL_LIMIT: usize = 64 * 1024;

pub(super) fn process_output_diagnostic(bytes: &[u8], lease_token: &str) -> serde_json::Value {
    let mut tail_start = bytes.len().saturating_sub(PROCESS_DIAGNOSTIC_TAIL_LIMIT);
    let mut truncated = tail_start > 0;

    // If the byte cap cuts through the lease token, omit its remaining suffix
    // before decoding so a partial credential cannot escape at the tail edge.
    let token = lease_token.as_bytes();
    if !token.is_empty() {
        loop {
            let previous_start = tail_start;
            let first_candidate = tail_start.saturating_sub(token.len().saturating_sub(1));
            for candidate_start in first_candidate..tail_start {
                let token_end = candidate_start.saturating_add(token.len());
                if token_end > tail_start
                    && token_end <= bytes.len()
                    && bytes.get(candidate_start..token_end) == Some(token)
                {
                    tail_start = token_end;
                    truncated = true;
                    break;
                }
            }
            if tail_start == previous_start {
                break;
            }
        }
    }

    // Decode and redact only the bounded slice; never copy the full child output
    // into the persistent diagnostic event.
    let decoded = String::from_utf8_lossy(&bytes[tail_start..]);
    let redacted = if lease_token.is_empty() {
        decoded.into_owned()
    } else {
        decoded.replace(lease_token, "[redacted lease token]")
    };
    let mut output_start = redacted
        .len()
        .saturating_sub(PROCESS_DIAGNOSTIC_TAIL_LIMIT);
    while !redacted.is_char_boundary(output_start) {
        output_start += 1;
    }
    truncated |= output_start > 0;

    serde_json::json!({
        "tail": &redacted[output_start..],
        "total_bytes": bytes.len(),
        "truncated": truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_output_diagnostic_bounds_utf8_tail_and_reports_original_size() {
        let lease_token = "prep-lease-secret";
        let mut output = vec![b'x'; PROCESS_DIAGNOSTIC_TAIL_LIMIT + 128];
        output.extend_from_slice(" μ".as_bytes());
        output.extend_from_slice(lease_token.as_bytes());

        let diagnostic = process_output_diagnostic(&output, lease_token);
        let tail = diagnostic["tail"].as_str().unwrap();
        assert!(tail.len() <= PROCESS_DIAGNOSTIC_TAIL_LIMIT);
        assert!(std::str::from_utf8(tail.as_bytes()).is_ok());
        assert!(!tail.contains(lease_token));
        assert_eq!(
            diagnostic["total_bytes"].as_u64(),
            Some(output.len() as u64)
        );
        assert_eq!(diagnostic["truncated"].as_bool(), Some(true));
    }

    #[test]
    fn process_output_diagnostic_does_not_leak_token_cut_by_tail_boundary() {
        let lease_token = "lease-secret";
        let mut output = vec![b'x'; PROCESS_DIAGNOSTIC_TAIL_LIMIT + 32];
        let tail_start = output.len() - PROCESS_DIAGNOSTIC_TAIL_LIMIT;
        let token_start = tail_start - 4;
        output[token_start..token_start + lease_token.len()]
            .copy_from_slice(lease_token.as_bytes());

        let diagnostic = process_output_diagnostic(&output, lease_token);
        let tail = diagnostic["tail"].as_str().unwrap();
        assert!(!tail.contains(lease_token));
        assert!(!tail.starts_with(&lease_token[4..]));
        assert_eq!(diagnostic["truncated"].as_bool(), Some(true));
    }
    #[test]
    fn process_output_diagnostic_keeps_native_report_beyond_short_failure_reason() {
        let report = format!(
            "accepted worker failed: diagnostics={{\"padding\":\"{}\",\"eps_reason\":-1}}",
            "x".repeat(4096),
        );
        let diagnostic = process_output_diagnostic(report.as_bytes(), "lease-secret");
        assert_eq!(diagnostic["tail"].as_str(), Some(report.as_str()));
        assert_eq!(diagnostic["truncated"].as_bool(), Some(false));
    }
}
