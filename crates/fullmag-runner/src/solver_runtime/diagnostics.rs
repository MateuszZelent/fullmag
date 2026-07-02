//! Runtime selection diagnostics shared by FDM and FEM lanes.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use crate::types::ResolvedFallback;

pub(crate) fn runtime_fallback(
    original_engine: &str,
    fallback_engine: &str,
    reason: &str,
    message: String,
) -> ResolvedFallback {
    ResolvedFallback {
        occurred: true,
        original_engine: original_engine.to_string(),
        fallback_engine: fallback_engine.to_string(),
        reason: reason.to_string(),
        message,
    }
}

pub(crate) fn runtime_log_once(level: &str, message: &str) {
    static EMITTED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let key = format!("{level}:{message}");
    let emitted = EMITTED.get_or_init(|| Mutex::new(HashSet::new()));
    match emitted.lock() {
        Ok(mut guard) => {
            if guard.insert(key) {
                eprintln!("{level}: {message}");
            }
        }
        // If the lock is poisoned, keep logging instead of muting diagnostics.
        Err(_) => eprintln!("{level}: {message}"),
    }
}

pub(crate) fn runtime_warn_once(message: &str) {
    runtime_log_once("warning", message);
}

pub(crate) fn runtime_info_once(message: &str) {
    runtime_log_once("info", message);
}
