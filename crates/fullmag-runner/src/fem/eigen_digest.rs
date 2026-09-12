use crate::types::RunError;
use sha2::{Digest, Sha256};

pub(super) fn is_sha256_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn sha256_text(value: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(value.as_bytes()))
}

pub(super) fn shared_domain_content_digest<T: serde::Serialize + ?Sized>(
    label: &str,
    value: &T,
) -> Result<String, RunError> {
    let encoded = serde_json::to_vec(value).map_err(|error| RunError {
        message: format!("failed to serialize shared-domain {label} digest input: {error}"),
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(encoded)))
}
