//! Error type of the workspace database.

use std::fmt;

/// Everything that can go wrong. Callers that only want to log use
/// [`crate::record_best_effort`], which swallows these.
#[derive(Debug)]
pub enum WorkspaceError {
    Sqlite(rusqlite::Error),
    Io(std::io::Error),
    Json(serde_json::Error),
    /// The file was written by a newer Fullmag; this build only reads it.
    ReadOnly {
        found: u32,
        supported: u32,
    },
    /// The file opened but its content is damaged.
    Corrupt(String),
    NotFound(String),
    /// No per-user state directory could be derived from the environment.
    NoStateDir,
    /// Rejected input (for example an unreadable legacy index).
    Invalid(String),
}

impl WorkspaceError {
    /// True for lock contention that outlasted `busy_timeout`.
    pub fn is_locked(&self) -> bool {
        matches!(
            self,
            WorkspaceError::Sqlite(rusqlite::Error::SqliteFailure(error, _))
                if matches!(
                    error.code,
                    rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                )
        )
    }

    /// True when the database file itself is unusable and should be quarantined.
    pub(crate) fn is_damage(&self) -> bool {
        match self {
            WorkspaceError::Corrupt(_) => true,
            WorkspaceError::Sqlite(rusqlite::Error::SqliteFailure(error, _)) => matches!(
                error.code,
                rusqlite::ErrorCode::NotADatabase
                    | rusqlite::ErrorCode::DatabaseCorrupt
                    | rusqlite::ErrorCode::CannotOpen
            ),
            _ => false,
        }
    }
}

impl fmt::Display for WorkspaceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WorkspaceError::Sqlite(e) => write!(f, "workspace database error: {e}"),
            WorkspaceError::Io(e) => write!(f, "workspace i/o error: {e}"),
            WorkspaceError::Json(e) => write!(f, "workspace JSON error: {e}"),
            WorkspaceError::ReadOnly { found, supported } => write!(
                f,
                "workspace database has schema version {found}, newer than the supported \
                 version {supported}; it is read-only in this build"
            ),
            WorkspaceError::Corrupt(why) => write!(f, "workspace database is damaged: {why}"),
            WorkspaceError::NotFound(what) => write!(f, "workspace item not found: {what}"),
            WorkspaceError::NoStateDir => write!(
                f,
                "cannot determine the Fullmag state directory; set FULLMAG_STATE_DIR"
            ),
            WorkspaceError::Invalid(why) => write!(f, "{why}"),
        }
    }
}

impl std::error::Error for WorkspaceError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            WorkspaceError::Sqlite(e) => Some(e),
            WorkspaceError::Io(e) => Some(e),
            WorkspaceError::Json(e) => Some(e),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for WorkspaceError {
    fn from(error: rusqlite::Error) -> Self {
        WorkspaceError::Sqlite(error)
    }
}

impl From<std::io::Error> for WorkspaceError {
    fn from(error: std::io::Error) -> Self {
        WorkspaceError::Io(error)
    }
}

impl From<serde_json::Error> for WorkspaceError {
    fn from(error: serde_json::Error) -> Self {
        WorkspaceError::Json(error)
    }
}

pub type Result<T> = std::result::Result<T, WorkspaceError>;
