//! The detail documents of the inspector: one typed shape per item kind.
//!
//! Every reader reports its own failure as `read_error` inside the detail and
//! fills what it could read; a damaged file never becomes an error of the
//! caller. Fields the file does not state are `null`, never guessed.

use serde::{Deserialize, Serialize};

use crate::manifest::{RunOutput, RunSource, StageSummary};

macro_rules! schema_type {
    ($(#[$meta:meta])* $vis:vis struct $name:ident { $($body:tt)* }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        #[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
        $vis struct $name { $($body)* }
    };
}

/// Inspector document of one workspace item.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "utoipa", derive(utoipa::ToSchema))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ItemDetail {
    Project(ProjectDetail),
    Script(ScriptDetail),
    Result(ResultDetail),
}

impl ItemDetail {
    /// The reader's own failure, if any.
    pub fn read_error(&self) -> Option<&str> {
        match self {
            ItemDetail::Project(detail) => detail.read_error.as_deref(),
            ItemDetail::Script(detail) => detail.read_error.as_deref(),
            ItemDetail::Result(detail) => detail.read_error.as_deref(),
        }
    }
}

// ── project ────────────────────────────────────────────────────────────────

schema_type! {
    /// Facts of a `.fms` project read from its archive.
    pub struct ProjectDetail {
        /// Why the archive could not be read; every other field is then empty.
        pub read_error: Option<String>,
        pub name: Option<String>,
        pub project_id: Option<String>,
        /// Schema of the stored archive as `major.minor`.
        pub schema_version: Option<String>,
        pub revision: Option<u64>,
        /// `fdm` or `fem`.
        pub solver: Option<String>,
        /// The archive was written by an older schema and is migrated in memory.
        pub migrated: Option<bool>,
        pub can_write: Option<bool>,
        /// `read_write` or `read_only`.
        pub mode: Option<String>,
        pub mode_reason: Option<String>,
        pub warnings: Vec<String>,
        pub summary: Option<ProjectSummary>,
        pub authors: Vec<Author>,
        pub citation: Option<Citation>,
        pub history: Vec<HistoryEntry>,
        pub runs: Vec<ProjectRun>,
        /// The provenance document exists; false for a project that predates tracking.
        pub provenance_recorded: bool,
        pub preview: Option<PreviewInfo>,
    }
}

schema_type! {
    pub struct ProjectSummary {
        pub model: ModelSummary,
        pub execution: ExecutionSummary,
        pub outputs: OutputsSummary,
    }
}

schema_type! {
    pub struct ModelSummary {
        /// Cell counts `nx x ny x nz` (FDM).
        pub discretisation: Option<String>,
        /// Cell size in nm (FDM).
        pub cell_size: Option<String>,
        /// The scene has no periodicity field yet, so this is always `null`.
        pub periodicity: Option<String>,
        pub materials: Option<Vec<String>>,
        pub ms: Option<String>,
        pub aex: Option<String>,
        pub alpha: Option<String>,
        pub interactions: Option<Vec<String>>,
    }
}

schema_type! {
    pub struct ExecutionSummary {
        pub integrator: Option<String>,
        pub tolerance: Option<String>,
        /// External field and enabled field drives, in words.
        pub excitation: Option<String>,
    }
}

schema_type! {
    /// Outputs of the latest recorded run.
    pub struct OutputsSummary {
        pub frames: Option<u64>,
        pub size_bytes: Option<u64>,
    }
}

schema_type! {
    pub struct Author {
        pub name: String,
        pub role: String,
        #[serde(default)]
        pub email: Option<String>,
        #[serde(default)]
        pub affiliation: Option<String>,
        #[serde(default)]
        pub orcid: Option<String>,
    }
}

schema_type! {
    pub struct Citation {
        pub doi: Option<String>,
        pub url: Option<String>,
        pub preferred_bibtex: Option<String>,
        pub license: Option<String>,
    }
}

schema_type! {
    pub struct HistoryEntry {
        pub revision: u64,
        pub at: String,
        pub kind: String,
        pub summary: String,
        #[serde(default)]
        pub by: Option<String>,
        #[serde(default)]
        pub run_id: Option<String>,
        #[serde(default)]
        pub changes: Vec<String>,
        #[serde(default)]
        pub restorable: Option<bool>,
    }
}

schema_type! {
    /// A run recorded in the project's provenance.
    pub struct ProjectRun {
        pub run_id: String,
        pub started_at: String,
        pub status: String,
        #[serde(default)]
        pub finished_at: Option<String>,
        #[serde(default)]
        pub device: Option<String>,
        #[serde(default)]
        pub backend: Option<String>,
        #[serde(default)]
        pub error: Option<String>,
        #[serde(default)]
        pub revision: Option<u64>,
        #[serde(default)]
        pub output_bytes: Option<u64>,
        #[serde(default)]
        pub frames: Option<u64>,
        #[serde(default)]
        pub duration_seconds: Option<f64>,
    }
}

schema_type! {
    /// How the stored preview image was coloured.
    pub struct PreviewInfo {
        pub colouring: String,
        #[serde(default)]
        pub run_id: Option<String>,
        #[serde(default)]
        pub at: Option<String>,
    }
}

// ── script ─────────────────────────────────────────────────────────────────

schema_type! {
    /// Static facts of a Python script. Nothing is executed: the file is read
    /// (at most 16 MiB), hashed and scanned line by line.
    pub struct ScriptDetail {
        pub read_error: Option<String>,
        pub sha256: Option<String>,
        pub bytes: Option<u64>,
        pub lines: Option<u64>,
        /// `utf-8`, `utf-8-bom` or `other`.
        pub encoding: Option<String>,
        /// Only the first 1 MiB was scanned for the facts below.
        pub truncated: bool,
        /// First line of the module docstring.
        pub summary: Option<String>,
        pub uses_fullmag: Option<bool>,
        /// Top-level module names imported at any indentation.
        pub imports: Option<Vec<String>>,
        /// Names read through a literal `os.environ[...]`, `os.environ.get(...)`
        /// or `os.getenv(...)`; never values.
        pub env_reads: Option<Vec<String>>,
        /// Result of `ast.parse` in the chosen interpreter; `null` when no
        /// interpreter checked the file.
        #[serde(default)]
        pub syntax: Option<ScriptSyntax>,
        /// Top-level imports that `importlib.util.find_spec` did not find in
        /// the chosen interpreter (nor next to the script); `null` when not
        /// checked. This says nothing about the interpreter a run would use.
        #[serde(default)]
        pub unresolved_imports: Option<Vec<String>>,
        /// Python's parser checked the syntax (`ast`, never executed).
        pub syntax_checked: bool,
        /// The facts come from a static line scan, not from Python's parser.
        pub degraded: bool,
        pub degraded_reason: Option<String>,
    }
}

schema_type! {
    /// Outcome of parsing a script with Python's `ast` (never executed).
    pub struct ScriptSyntax {
        pub ok: bool,
        /// 1-based line of the first syntax error.
        #[serde(default)]
        pub line: Option<u64>,
        #[serde(default)]
        pub column: Option<u64>,
        #[serde(default)]
        pub message: Option<String>,
    }
}

// ── result folder ──────────────────────────────────────────────────────────

schema_type! {
    /// Facts of a Fullmag results folder, read from metadata files only.
    pub struct ResultDetail {
        pub read_error: Option<String>,
        /// `zarr`, `hdf5` or `unknown`.
        pub format: Option<String>,
        /// The folder carries a `fullmag-run.json`.
        pub has_manifest: bool,
        pub run_id: Option<String>,
        /// Status from the manifest, or from `metadata.json` of the final stage.
        pub status: Option<String>,
        pub source: Option<RunSource>,
        pub started_at: Option<String>,
        pub finished_at: Option<String>,
        pub stages: Vec<StageSummary>,
        pub quantities: Vec<String>,
        pub grid: Option<ResultGrid>,
        pub frames: Option<u64>,
        pub total_bytes: Option<u64>,
        /// The walk stopped at a limit: `total_bytes` is a lower bound.
        pub total_bytes_truncated: bool,
        pub modified_at: Option<String>,
        pub outputs: Vec<RunOutput>,
    }
}

schema_type! {
    /// Mesh or grid of the run, from `metadata.json` `artifact_layout`.
    pub struct ResultGrid {
        pub backend: Option<String>,
        /// Cell counts of an FDM grid.
        pub cells: Option<Vec<u64>>,
        pub n_nodes: Option<u64>,
        pub n_elements: Option<u64>,
        pub hmax: Option<f64>,
    }
}
