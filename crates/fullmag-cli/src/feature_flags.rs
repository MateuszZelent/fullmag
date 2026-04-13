//! Runtime feature flags for isolating performance bottlenecks in the CLI.
//!
//! These flags mirror fullmag-api's feature_flags but live in the orchestrator
//! to skip expensive data computation BEFORE it would be sent to the API.
//!
//! Flags allow temporarily disabling heavy subsystems to measure their
//! impact on solver throughput and memory usage.  They are resolved once at
//! startup from two sources (file wins over env):
//!
//!   1. Config file:   `~/.fullmag/feature_flags.json`
//!   2. Environment:   `FULLMAG_DISABLE_CHARTS=1`, etc.
//!
//! When a flag is set, the CLI orchestrator will skip:
//!   - `disable_charts`: Skip accumulating scalar rows for chart broadcast
//!   - `disable_preview_3d`: Skip computing preview field vectors entirely
//!   - `disable_preview_2d`: Skip 2D spatial preview generation
//!   - `disable_session_state_broadcast`: Skip heavy session_state WS messages

use serde::{Deserialize, Serialize};

/// Runtime feature flags, resolved once at startup.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FeatureFlags {
    /// When true, skip scalar-row accumulation and chart data.
    #[serde(default)]
    pub disable_charts: bool,
    /// When true, skip 2D spatial preview generation.
    #[serde(default)]
    pub disable_preview_2d: bool,
    /// When true, skip 3D vector preview computation entirely.
    #[serde(default)]
    pub disable_preview_3d: bool,
    /// When true, skip the heavy `session_state` WS text message entirely.
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
                eprintln!("[fullmag-cli] feature flags loaded from {}", path.display());
                Some(flags)
            }
            Err(e) => {
                eprintln!(
                    "[fullmag-cli] WARNING: could not parse {}: {}",
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
            active.push("disable_charts");
        }
        if self.disable_preview_2d {
            active.push("disable_preview_2d");
        }
        if self.disable_preview_3d {
            active.push("disable_preview_3d");
        }
        if self.disable_session_state_broadcast {
            active.push("disable_session_state_broadcast");
        }
        active.join(", ")
    }
}

fn env_flag(key: &str) -> bool {
    std::env::var(key)
        .map(|v| matches!(v.to_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false)
}
