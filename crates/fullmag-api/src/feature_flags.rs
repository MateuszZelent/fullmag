//! Runtime feature flags for isolating performance bottlenecks.
//!
//! Flags allow temporarily disabling heavy subsystems to measure their
//! impact on solver throughput and memory usage.  They are resolved once at
//! startup from two sources (file wins over env):
//!
//!   1. Config file:   `~/.fullmag/feature_flags.json`
//!   2. Environment:   `FULLMAG_DISABLE_CHARTS=1`, etc.
//!
//! The file is plain JSON and can be edited by the user between runs:
//!
//! ```json
//! {
//!   "disable_charts": true,
//!   "disable_preview_2d": false,
//!   "disable_preview_3d": true,
//!   "disable_session_state_broadcast": false
//! }
//! ```
//!
//! Flags are resolved locally at startup and gate internal preview/chart
//! behaviors. The public browser contract must use canonical capability and
//! resource endpoints instead of a dedicated legacy flags route.

use serde::{Deserialize, Serialize};

/// Runtime feature flags, resolved once at startup.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FeatureFlags {
    /// When true, skip scalar-row delta broadcast and chart_state WS messages.
    #[serde(default)]
    pub disable_charts: bool,
    /// When true, skip 2D spatial preview generation.
    #[serde(default)]
    pub disable_preview_2d: bool,
    /// When true, skip 3D vector preview binary payload and preview build.
    #[serde(default)]
    pub disable_preview_3d: bool,
    /// When true, skip the heavy `session_state` WS text message entirely.
    /// The frontend will only receive `chart_state` and binary payloads.
    #[serde(default)]
    pub disable_session_state_broadcast: bool,
}

impl FeatureFlags {
    /// Resolve flags: config file (`~/.fullmag/feature_flags.json`) wins,
    /// then environment variables, then defaults (all false).
    pub fn resolve() -> Self {
        if let Some(flags) = Self::from_file() {
            return flags;
        }
        Self::from_env()
    }

    /// Read flags from the canonical config file.
    fn from_file() -> Option<Self> {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .ok()?;
        let path = std::path::PathBuf::from(home)
            .join(".fullmag")
            .join("feature_flags.json");
        let content = std::fs::read_to_string(&path).ok()?;
        match serde_json::from_str::<Self>(&content) {
            Ok(flags) => {
                eprintln!("[fullmag-api] feature flags loaded from {}", path.display());
                Some(flags)
            }
            Err(e) => {
                eprintln!(
                    "[fullmag-api] WARNING: could not parse {}: {}",
                    path.display(),
                    e,
                );
                None
            }
        }
    }

    /// Read flags from environment variables.  Any truthy value (`1`, `true`,
    /// `yes`) enables the flag.
    fn from_env() -> Self {
        Self {
            disable_charts: env_flag("FULLMAG_DISABLE_CHARTS"),
            disable_preview_2d: env_flag("FULLMAG_DISABLE_PREVIEW_2D"),
            disable_preview_3d: env_flag("FULLMAG_DISABLE_PREVIEW_3D"),
            disable_session_state_broadcast: env_flag("FULLMAG_DISABLE_SESSION_STATE_BROADCAST"),
        }
    }

    /// True when any flag is active — used to log a summary at startup.
    pub fn any_active(&self) -> bool {
        self.disable_charts
            || self.disable_preview_2d
            || self.disable_preview_3d
            || self.disable_session_state_broadcast
    }

    /// Human-readable summary of active flags for startup log.
    pub fn summary(&self) -> String {
        let mut active = Vec::new();
        if self.disable_charts {
            active.push("charts");
        }
        if self.disable_preview_2d {
            active.push("preview_2d");
        }
        if self.disable_preview_3d {
            active.push("preview_3d");
        }
        if self.disable_session_state_broadcast {
            active.push("session_state_broadcast");
        }
        if active.is_empty() {
            "none".to_string()
        } else {
            active.join(", ")
        }
    }
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|v| matches!(v.as_str(), "1" | "true" | "yes" | "TRUE" | "YES"))
        .unwrap_or(false)
}
