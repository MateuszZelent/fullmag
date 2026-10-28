//! CLI adapter for the shared immutable source-capture contract.
use crate::args::ScriptCli;
use crate::types::ScriptExecutionConfig;
use anyhow::{Context, Result};
use clap::ValueEnum;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
pub(crate) struct CapturedScriptSource {
    pub config: ScriptExecutionConfig,
    pub manifest: Value,
    pub files: BTreeMap<String, Vec<u8>>,
}
pub(crate) fn capture_authored_script(script: &Path, args: &ScriptCli) -> Result<CapturedScriptSource> {
    let root=crate::control_room::repo_root();
    let authored=root.join("packages/fullmag-py/src/fullmag");
    let fullmag=if authored.is_dir() {authored} else {root.join("python/site-packages/fullmag")};
    let backend=args.backend.map(|value|value.to_possible_value().unwrap().get_name().to_owned());
    let mode=args.mode.map(|value|value.to_possible_value().unwrap().get_name().to_owned());
    let precision=args.precision.map(|value|value.to_possible_value().unwrap().get_name().to_owned());
    let capture=fullmag_application::script_source_capture::capture_authored_script(script,&fullmag,
        &fullmag_application::script_source_capture::CaptureOptions {backend:backend.as_deref(),mode:mode.as_deref(),precision:precision.as_deref(),scene_only:false},
        crate::python_bridge::run_python_capture_helper)?;
    Ok(CapturedScriptSource {config:capture.config.context("capture returned no raw authored config")?,manifest:capture.manifest,files:capture.files})
}
