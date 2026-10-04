//! Public value types of the workspace database.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

macro_rules! text_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name {
            $(
                #[serde(rename = $text)]
                $variant,
            )+
        }

        impl $name {
            /// The value stored in the database.
            pub fn as_str(self) -> &'static str {
                match self {
                    $($name::$variant => $text,)+
                }
            }

            /// Inverse of [`Self::as_str`].
            pub fn parse(text: &str) -> Option<Self> {
                match text {
                    $($text => Some($name::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

text_enum! {
    /// What an item is.
    ItemKind { Project => "project", Script => "script" }
}

text_enum! {
    /// What happened to an item.
    EventKind {
        Open => "open",
        Save => "save",
        Run => "run",
        Create => "create",
        Import => "import",
        Pin => "pin",
        Unpin => "unpin",
        Forget => "forget",
    }
}

text_enum! {
    /// Which Fullmag front end wrote an event.
    Actor { Desktop => "desktop", Cli => "cli", Python => "python", Web => "web" }
}

text_enum! {
    /// Last known state of the file behind an item.
    ItemStatus {
        Ready => "ready",
        Missing => "missing",
        Failed => "failed",
        Migrate => "migrate",
        Readonly => "readonly",
    }
}

text_enum! {
    /// Ordering of [`crate::Query`]; pinned items always come first.
    Sort {
        LastUsed => "last_used",
        Name => "name",
        Modified => "modified",
        UseCount => "use_count",
    }
}

impl EventKind {
    /// Events that count as use: they bump `use_count` and `last_used_at`
    /// (and bring a forgotten item back).
    pub fn counts_as_use(self) -> bool {
        matches!(
            self,
            EventKind::Open
                | EventKind::Run
                | EventKind::Save
                | EventKind::Create
                | EventKind::Import
        )
    }
}

/// One row of `items`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Item {
    pub id: i64,
    pub kind: ItemKind,
    pub path: String,
    pub name: String,
    pub project_id: Option<String>,
    pub first_seen_at: String,
    pub last_used_at: String,
    pub use_count: i64,
    pub pinned: bool,
    pub forgotten: bool,
    pub size_bytes: Option<i64>,
    pub modified_at: Option<String>,
    pub status: ItemStatus,
    /// Per-kind facts (spec 3.2); fields unknown to this build are preserved.
    pub meta: Value,
}

/// One row of `events`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub id: i64,
    pub item_id: i64,
    pub at: String,
    pub kind: EventKind,
    pub actor: Actor,
    pub detail: Value,
}

/// A usage event to record.
#[derive(Debug, Clone)]
pub struct RecordEvent {
    pub kind: ItemKind,
    pub path: PathBuf,
    pub event: EventKind,
    pub actor: Actor,
    /// Free-form facts about this event (revision, status, duration, device).
    /// Never put file contents or environment values here.
    pub detail: Value,
    /// JSON merge patch (RFC 7396) applied to the item's `meta`: objects are
    /// merged recursively, `null` removes a key, everything else replaces.
    pub meta_patch: Option<Value>,
    /// Stable project id of a `.fms`; lets a moved project keep its row.
    pub project_id: Option<String>,
    /// Display name; defaults to the file stem.
    pub name: Option<String>,
}

impl RecordEvent {
    pub fn new(kind: ItemKind, path: impl Into<PathBuf>, event: EventKind, actor: Actor) -> Self {
        Self {
            kind,
            path: path.into(),
            event,
            actor,
            detail: Value::Null,
            meta_patch: None,
            project_id: None,
            name: None,
        }
    }

    pub fn with_detail(mut self, detail: Value) -> Self {
        self.detail = detail;
        self
    }

    pub fn with_meta_patch(mut self, patch: Value) -> Self {
        self.meta_patch = Some(patch);
        self
    }

    pub fn with_project_id(mut self, project_id: impl Into<String>) -> Self {
        self.project_id = Some(project_id.into());
        self
    }

    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }
}

/// What [`crate::Workspace::record`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecordReceipt {
    pub item_id: i64,
    /// A new item row was created.
    pub created: bool,
    /// An existing project row was re-pointed to a new path (moved `.fms`).
    pub repointed: bool,
}

/// The list query of spec section 5.
#[derive(Debug, Clone)]
pub struct Query {
    pub kind: Option<ItemKind>,
    pub sort: Sort,
    /// Case-insensitive substring over name, path and `meta.authors`.
    pub search: Option<String>,
    pub limit: usize,
    /// Keep items whose file is missing (flagged by `status`). Default true.
    pub include_missing: bool,
}

impl Default for Query {
    fn default() -> Self {
        Self {
            kind: None,
            sort: Sort::LastUsed,
            search: None,
            limit: 200,
            include_missing: true,
        }
    }
}

/// Reference to an item by row id or by path.
#[derive(Debug, Clone, Copy)]
pub enum ItemRef<'a> {
    Id(i64),
    Path(&'a std::path::Path),
}

impl From<i64> for ItemRef<'_> {
    fn from(id: i64) -> Self {
        ItemRef::Id(id)
    }
}

impl<'a> From<&'a std::path::Path> for ItemRef<'a> {
    fn from(path: &'a std::path::Path) -> Self {
        ItemRef::Path(path)
    }
}

impl<'a> From<&'a PathBuf> for ItemRef<'a> {
    fn from(path: &'a PathBuf) -> Self {
        ItemRef::Path(path.as_path())
    }
}

/// How [`crate::Workspace::open`] obtained the database.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenOutcome {
    /// No usable file existed; a version-1 database was created.
    Created,
    /// An existing database of the current version.
    Ready,
    /// An older database was migrated in place.
    Migrated { from: u32, to: u32 },
    /// The previous file was damaged; it was renamed to `backup` and a fresh
    /// database created. `reason` is the failure that triggered it.
    Quarantined { backup: PathBuf, reason: String },
    /// The file comes from a newer Fullmag: opened read-only, writes are refused.
    ReadOnlyNewerSchema { found: u32, supported: u32 },
}

/// Result of [`crate::Workspace::import_legacy_recent_index`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct LegacyImportReport {
    /// The marker was already set; nothing was read.
    pub already_imported: bool,
    /// The legacy file does not exist; nothing was done and no marker was set.
    pub file_missing: bool,
    pub imported: usize,
    pub skipped: usize,
}
