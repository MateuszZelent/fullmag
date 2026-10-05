//! Per-user Fullmag workspace database.
//!
//! One SQLite file (`workspace.db` in [`state_dir`]) records what a person has
//! opened, saved and run with Fullmag: projects (`.fms`), Python scripts and
//! result folders found by a scan.
//! The desktop application, the CLI and Python share it. The contract is
//! `docs/design/start-screen/docs/07-workspace-database.md`.
//!
//! The database is derived and personal state: it holds paths and usage
//! metadata, never project content, results, file text or environment values,
//! and recording never fails the action it describes
//! ([`record_best_effort`]).
//!
//! ```no_run
//! use fullmag_workspace::{Actor, EventKind, ItemKind, Query, RecordEvent, Workspace};
//!
//! let (workspace, _outcome) = Workspace::open_default()?;
//! workspace.record(&RecordEvent::new(
//!     ItemKind::Script,
//!     "C:/sim/wall.py",
//!     EventKind::Open,
//!     Actor::Desktop,
//! ))?;
//! let recent = workspace.list(&Query::default())?;
//! # Ok::<(), fullmag_workspace::WorkspaceError>(())
//! ```

mod error;
mod legacy;
mod paths;
mod script_meta;
mod seen;
mod store;
mod thumbnail;
mod timefmt;
mod types;

pub use error::{Result, WorkspaceError};
pub use legacy::LEGACY_IMPORT_MARKER;
pub use paths::{
    default_database_path, identity, state_dir, state_dir_from, Identity, CASE_INSENSITIVE_PATHS,
    DATABASE_FILE_NAME,
};
pub use script_meta::{script_meta, script_meta_from_text, MAX_SCRIPT_BYTES};
pub use store::{
    hash_file, log_outcome, merge_patch, record_best_effort, Workspace, MAX_EVENTS_PER_ITEM,
    MAX_HASHED_BYTES, SCHEMA_V1_SQL, SCHEMA_V2_SQL, SCHEMA_V3_SQL, SCHEMA_VERSION,
    WORKSPACE_ROOTS_KEY,
};
pub use thumbnail::{Thumbnail, MAX_THUMBNAIL_BYTES, PNG_SIGNATURE};
pub use timefmt::{now_rfc3339, parse_rfc3339, rfc3339_millis};
pub use types::{
    Actor, Event, EventKind, FileObservation, Item, ItemKind, ItemRef, ItemStatus,
    LegacyImportReport, OpenOutcome, Query, RecordEvent, RecordReceipt, SeenItem, Sort,
    WorkspaceRoot,
};

/// Redact command-line arguments before they are stored as `meta.args`
/// (spec section 11.1): the value of an option whose name looks like a secret
/// (`--token`, `--password`, `--api-key`, ...), given as `--name value` or
/// `--name=value`, becomes `***`. Environment values are never stored at all.
pub fn redact_args<S: AsRef<str>>(args: &[S]) -> Vec<String> {
    const SECRET_HINTS: [&str; 7] = [
        "token",
        "secret",
        "password",
        "passwd",
        "key",
        "credential",
        "auth",
    ];
    let looks_secret = |name: &str| {
        let lower = name.trim_start_matches('-').to_lowercase();
        SECRET_HINTS.iter().any(|hint| lower.contains(hint))
    };
    let mut out = Vec::with_capacity(args.len());
    let mut redact_next = false;
    for arg in args {
        let arg = arg.as_ref();
        if redact_next {
            redact_next = false;
            if !arg.starts_with('-') {
                out.push("***".to_string());
                continue;
            }
        }
        if arg.starts_with('-') {
            match arg.split_once('=') {
                Some((name, _)) if looks_secret(name) => {
                    out.push(format!("{name}=***"));
                    continue;
                }
                None if looks_secret(arg) => redact_next = true,
                _ => {}
            }
        }
        out.push(arg.to_string());
    }
    out
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_v2;
#[cfg(test)]
mod tests_v3;
