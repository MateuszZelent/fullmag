//! Read-only inspectors and a scanner for the per-user Fullmag workspace.
//!
//! The desktop host and the local runtime API both show the same projects,
//! scripts and results folders, so the code that reads them lives here once:
//!
//! * [`project`] and [`provenance`]: what a `.fms` archive says about itself,
//! * [`inspect_script`]: static facts of a `.py`, never executed,
//! * [`inspect_result`]: a results folder, from metadata files only,
//! * [`manifest`]: `fullmag-run.json`, written by every run and read here,
//! * [`scanner`] and [`link`]: finding items and tying results to their source.
//!
//! No Tauri, no HTTP, no solver. Nothing in this crate executes a script or
//! reads an array chunk.

pub mod detail;
pub mod link;
pub mod manifest;
pub mod project;
mod project_detail;
pub mod provenance;
mod result_detail;
pub mod scanner;
mod script_detail;

pub use detail::{
    Author, Citation, ExecutionSummary, HistoryEntry, ItemDetail, ModelSummary, OutputsSummary,
    PreviewInfo, ProjectDetail, ProjectRun, ProjectSummary, ResultDetail, ResultGrid, ScriptDetail,
};
pub use project_detail::inspect_project;
pub use result_detail::{display_path, inspect_result, is_result_dir, read_layout, Layout};
pub use script_detail::inspect_script;

use fullmag_workspace::{Item, ItemKind};

/// The inspector document of a stored item, read from its path now.
pub fn inspect_item(item: &Item) -> ItemDetail {
    let path = std::path::Path::new(&item.path);
    match item.kind {
        ItemKind::Project => ItemDetail::Project(inspect_project(path)),
        ItemKind::Script => ItemDetail::Script(inspect_script(path)),
        ItemKind::Result => ItemDetail::Result(inspect_result(path)),
    }
}

#[cfg(test)]
mod tests;
