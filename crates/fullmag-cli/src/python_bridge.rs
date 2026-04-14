use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Command as ProcessCommand, Stdio};

use anyhow::{anyhow, bail, Context, Result};
use std::collections::HashMap;

use crate::args::ScriptCli;
use crate::control_room::repo_root;
use crate::types::{
    LoadedMagnetizationState, PythonProgressCallback, PythonProgressEvent, ScriptExecutionConfig,
};

#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct RemeshPerDomainQuality {
    pub n_elements: u32,
    pub sicn_min: f64,
    pub sicn_max: f64,
    pub sicn_mean: f64,
    pub sicn_p5: f64,
    #[serde(default)]
    pub sicn_histogram: Vec<u32>,
    pub gamma_min: f64,
    pub gamma_mean: f64,
    #[serde(default)]
    pub gamma_histogram: Vec<u32>,
    pub volume_min: f64,
    pub volume_max: f64,
    pub volume_mean: f64,
    pub volume_std: f64,
    pub avg_quality: f64,
}

impl From<RemeshPerDomainQuality> for fullmag_ir::MeshQualityIR {
    fn from(q: RemeshPerDomainQuality) -> Self {
        Self {
            n_elements: q.n_elements,
            sicn_min: q.sicn_min,
            sicn_max: q.sicn_max,
            sicn_mean: q.sicn_mean,
            sicn_p5: q.sicn_p5,
            sicn_histogram: q.sicn_histogram,
            gamma_min: q.gamma_min,
            gamma_mean: q.gamma_mean,
            gamma_histogram: q.gamma_histogram,
            volume_min: q.volume_min,
            volume_max: q.volume_max,
            volume_mean: q.volume_mean,
            volume_std: q.volume_std,
            avg_quality: q.avg_quality,
        }
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct RemeshQualitySummary {
    #[serde(rename = "nElements")]
    pub n_elements: usize,
    #[serde(rename = "sicnMin")]
    pub sicn_min: f64,
    #[serde(rename = "sicnMax")]
    pub sicn_max: f64,
    #[serde(rename = "sicnMean")]
    pub sicn_mean: f64,
    #[serde(rename = "sicnP5")]
    pub sicn_p5: f64,
    #[serde(rename = "gammaMin")]
    pub gamma_min: f64,
    #[serde(rename = "gammaMean")]
    pub gamma_mean: f64,
    #[serde(rename = "avgQuality")]
    pub avg_quality: f64,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct RemeshCliResponse {
    pub mesh_name: String,
    pub nodes: Vec<[f64; 3]>,
    pub elements: Vec<[u32; 4]>,
    pub element_markers: Vec<u32>,
    pub boundary_faces: Vec<[u32; 3]>,
    pub boundary_markers: Vec<u32>,
    #[serde(default)]
    pub periodic_boundary_pairs: Vec<fullmag_ir::MeshPeriodicBoundaryPairIR>,
    #[serde(default)]
    pub periodic_node_pairs: Vec<fullmag_ir::MeshPeriodicNodePairIR>,
    pub quality: Option<RemeshQualitySummary>,
    #[serde(default)]
    pub generation_mode: Option<String>,
    #[serde(default)]
    pub mesh_provenance: Option<serde_json::Value>,
    #[serde(default)]
    pub size_field_stats: Option<serde_json::Value>,
    #[serde(default)]
    pub region_markers: Vec<fullmag_ir::FemDomainRegionMarkerIR>,
    /// Per-domain element quality, keyed by domain marker string (from Python).
    #[serde(default)]
    pub per_domain_quality: HashMap<String, RemeshPerDomainQuality>,
}

impl RemeshCliResponse {
    pub(crate) fn into_mesh_ir(self) -> fullmag_ir::MeshIR {
        let per_domain_quality = self
            .per_domain_quality
            .into_iter()
            .filter_map(|(k, v)| k.parse::<u32>().ok().map(|marker| (marker, v.into())))
            .collect();
        fullmag_ir::MeshIR {
            mesh_name: self.mesh_name,
            nodes: self.nodes,
            elements: self.elements,
            element_markers: self.element_markers,
            boundary_faces: self.boundary_faces,
            boundary_markers: self.boundary_markers,
            periodic_boundary_pairs: self.periodic_boundary_pairs,
            periodic_node_pairs: self.periodic_node_pairs,
            per_domain_quality,
        }
    }
}

pub(crate) const PYTHON_PROGRESS_PREFIX: &str = "[fullmag-progress] ";
const PYTHON_PROGRESS_JSON_PREFIX: &str = "json:";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RemeshTerminalProgress {
    pub percent: u8,
    pub label: &'static str,
}

pub(crate) fn parse_python_progress_event(message: &str) -> PythonProgressEvent {
    let trimmed = message.trim();
    let Some(payload) = trimmed.strip_prefix(PYTHON_PROGRESS_JSON_PREFIX) else {
        return PythonProgressEvent::Message(trimmed.to_string());
    };

    let Ok(envelope) = serde_json::from_str::<serde_json::Value>(payload) else {
        return PythonProgressEvent::Message(trimmed.to_string());
    };
    let Some(envelope_obj) = envelope.as_object() else {
        return PythonProgressEvent::Message(trimmed.to_string());
    };
    let Some(kind) = envelope_obj.get("kind").and_then(serde_json::Value::as_str) else {
        return PythonProgressEvent::Message(trimmed.to_string());
    };
    let geometry_name = envelope_obj
        .get("geometry_name")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let message = envelope_obj
        .get("message")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);

    match kind {
        "fem_surface_preview" => {
            let fem_mesh = envelope_obj
                .get("fem_mesh")
                .and_then(|value| parse_fem_surface_preview_mesh(value, geometry_name.as_deref()));
            match (geometry_name, fem_mesh) {
                (Some(geometry_name), Some(fem_mesh)) => PythonProgressEvent::FemSurfacePreview {
                    geometry_name,
                    fem_mesh,
                    message,
                },
                _ => PythonProgressEvent::Message(trimmed.to_string()),
            }
        }
        _ => {
            let mut payload = serde_json::Map::new();
            payload.insert(
                "kind".to_string(),
                serde_json::Value::String(kind.to_string()),
            );
            if let Some(geometry_name) = geometry_name {
                payload.insert(
                    "geometry_name".to_string(),
                    serde_json::Value::String(geometry_name),
                );
            }
            if let Some(message) = message {
                payload.insert("message".to_string(), serde_json::Value::String(message));
            }
            if let Some(fem_mesh) = envelope_obj.get("fem_mesh") {
                payload.insert("fem_mesh".to_string(), fem_mesh.clone());
            }
            for (key, value) in envelope_obj {
                if key == "kind" || key == "geometry_name" || key == "message" || key == "fem_mesh"
                {
                    continue;
                }
                payload.insert(key.clone(), value.clone());
            }
            PythonProgressEvent::Structured {
                kind: kind.to_string(),
                payload: serde_json::Value::Object(payload),
            }
        }
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
struct FemSurfacePreviewPayload {
    nodes: Vec<[f64; 3]>,
    #[serde(default)]
    elements: Vec<[u32; 4]>,
    #[serde(default)]
    element_markers: Vec<u32>,
    boundary_faces: Vec<[u32; 3]>,
    #[serde(default)]
    boundary_markers: Vec<u32>,
    #[serde(default)]
    mesh_name: Option<String>,
    #[serde(default)]
    mesh_id: Option<String>,
}

fn parse_fem_surface_preview_mesh(
    value: &serde_json::Value,
    geometry_name: Option<&str>,
) -> Option<fullmag_runner::FemMeshPayload> {
    if let Ok(mesh) = serde_json::from_value::<fullmag_runner::FemMeshPayload>(value.clone()) {
        return Some(mesh);
    }
    let Ok(preview) = serde_json::from_value::<FemSurfacePreviewPayload>(value.clone()) else {
        return None;
    };
    let mesh_name = preview.mesh_name.unwrap_or_else(|| {
        geometry_name
            .map(|name| format!("{name}_surface_preview"))
            .unwrap_or_else(|| "surface_preview".to_string())
    });
    let mesh_id = preview
        .mesh_id
        .unwrap_or_else(|| format!("{mesh_name}:surface_preview"));
    let boundary_markers = if preview.boundary_markers.is_empty() {
        vec![1; preview.boundary_faces.len()]
    } else {
        preview.boundary_markers
    };
    let element_markers = if preview.elements.is_empty() {
        Vec::new()
    } else if preview.element_markers.is_empty() {
        vec![1; preview.elements.len()]
    } else {
        preview.element_markers
    };
    Some(fullmag_runner::FemMeshPayload {
        mesh_name,
        mesh_id,
        nodes: preview.nodes,
        elements: preview.elements,
        element_markers,
        boundary_faces: preview.boundary_faces,
        boundary_markers,
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: None,
        domain_frame: None,
        generation_id: None,
        per_domain_quality: HashMap::new(),
    })
}

pub(crate) fn map_remesh_progress_message(message: &str) -> Option<RemeshTerminalProgress> {
    let lower = message.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return None;
    }

    if let Some(progress) = parse_gmsh_inline_progress(message) {
        return Some(progress);
    }

    if lower.contains("remesh: accepted") || lower.contains("request queued") {
        return Some(RemeshTerminalProgress {
            percent: 5,
            label: "accepted",
        });
    }
    if lower.contains("importing stl surface") {
        return Some(RemeshTerminalProgress {
            percent: 15,
            label: "importing STL surface",
        });
    }
    if lower.contains("importing cad shapes") || lower.contains("importing cad geometry") {
        return Some(RemeshTerminalProgress {
            percent: 15,
            label: "importing CAD geometry",
        });
    }
    if lower.contains("building occ")
        || lower.contains("creating geometry from classified surfaces")
        || lower.contains("classifying stl surfaces")
        || lower.contains("adding airbox domain")
        || lower.contains("generating box geometry")
        || lower.contains("generating cylinder geometry")
    {
        return Some(RemeshTerminalProgress {
            percent: 15,
            label: "building geometry",
        });
    }
    if lower.contains("applying adaptive size field")
        || lower.contains("applying mesh options")
        || lower.contains("configuring mesh size fields")
    {
        return Some(RemeshTerminalProgress {
            percent: 30,
            label: "configuring mesh fields",
        });
    }
    if lower.contains("generating adaptive 3d mesh")
        || lower.contains("generating air-box 3d mesh")
        || lower.contains("generating 3d tetrahedral mesh")
    {
        return Some(RemeshTerminalProgress {
            percent: 75,
            label: "generating 3D mesh",
        });
    }
    if lower.contains("optimizing mesh") {
        return Some(RemeshTerminalProgress {
            percent: 85,
            label: "optimizing mesh",
        });
    }
    if lower.contains("extracting quality metrics") {
        return Some(RemeshTerminalProgress {
            percent: 92,
            label: "extracting quality metrics",
        });
    }
    if lower.contains("extracting mesh data") {
        return Some(RemeshTerminalProgress {
            percent: 97,
            label: "extracting mesh data",
        });
    }
    if lower.contains("mesh ready") {
        return Some(RemeshTerminalProgress {
            percent: 100,
            label: "mesh ready",
        });
    }

    None
}

fn parse_gmsh_inline_progress(message: &str) -> Option<RemeshTerminalProgress> {
    let trimmed = message.trim();
    let start = trimmed.find('[')?;
    let end = trimmed[start..].find("%]")?;
    let raw_percent = trimmed[start + 1..start + end].trim().parse::<u8>().ok()?;
    let lower = trimmed.to_ascii_lowercase();

    let (base, span, label) = if lower.contains("meshing curve") || lower.contains("meshing 1d") {
        (10u8, 12u8, "meshing curves")
    } else if lower.contains("meshing surface") || lower.contains("meshing 2d") {
        (22u8, 18u8, "meshing surfaces")
    } else if lower.contains("meshing volume") || lower.contains("meshing 3d") {
        (55u8, 25u8, "meshing 3D volume")
    } else {
        return None;
    };

    let scaled = base.saturating_add(((u16::from(raw_percent) * u16::from(span)) / 100) as u8);
    Some(RemeshTerminalProgress {
        percent: scaled.min(99),
        label,
    })
}

fn filter_non_progress_stderr(stderr_text: &str) -> String {
    stderr_text
        .lines()
        .filter(|line| {
            !line
                .trim_start()
                .starts_with(PYTHON_PROGRESS_PREFIX.trim_end())
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

pub(crate) fn run_python_helper(args: &[String]) -> Result<std::process::Output> {
    run_python_helper_with_progress(args, None)
}

pub(crate) fn run_python_helper_with_progress(
    args: &[String],
    progress_callback: Option<PythonProgressCallback>,
) -> Result<std::process::Output> {
    let local_python = repo_root()
        .join(".fullmag")
        .join("local")
        .join("python")
        .join("bin")
        .join("python");
    let repo_python = repo_root().join(".venv").join("bin").join("python");
    let mut candidates = Vec::new();

    if let Ok(preferred) = std::env::var("FULLMAG_PYTHON") {
        candidates.push(preferred);
    } else {
        for candidate in [local_python, repo_python] {
            if candidate.is_file() {
                candidates.push(candidate.display().to_string());
            }
        }
    }

    for fallback in ["python3", "python"] {
        if !candidates.iter().any(|candidate| candidate == fallback) {
            candidates.push(fallback.to_string());
        }
    }

    let pythonpath = repo_root().join("packages").join("fullmag-py").join("src");
    let fem_mesh_cache_dir = repo_root()
        .join(".fullmag")
        .join("local")
        .join("cache")
        .join("fem_mesh_assets");
    let inherited_pythonpath = std::env::var("PYTHONPATH").ok();

    let mut last_error = None;
    for candidate in candidates {
        let mut command = ProcessCommand::new(&candidate);
        command.args(args);
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command.env("PYTHONUNBUFFERED", "1");
        if progress_callback.is_some() {
            command.env("FULLMAG_PROGRESS", "1");
        }
        command.env("FULLMAG_FEM_MESH_CACHE_DIR", &fem_mesh_cache_dir);
        if pythonpath.exists() {
            let mut merged = pythonpath.display().to_string();
            if let Some(existing) = &inherited_pythonpath {
                if !existing.is_empty() {
                    merged.push(':');
                    merged.push_str(existing);
                }
            }
            command.env("PYTHONPATH", merged);
        }

        match command.spawn() {
            Ok(mut child) => {
                let stdout = child
                    .stdout
                    .take()
                    .ok_or_else(|| anyhow!("python helper stdout was not piped"))?;
                let stderr = child
                    .stderr
                    .take()
                    .ok_or_else(|| anyhow!("python helper stderr was not piped"))?;
                let stdout_thread = std::thread::spawn(move || -> Result<Vec<u8>> {
                    let mut stdout = stdout;
                    let mut bytes = Vec::new();
                    stdout.read_to_end(&mut bytes)?;
                    Ok(bytes)
                });
                let stderr_progress = progress_callback.clone();
                let stderr_thread = std::thread::spawn(move || -> Result<Vec<u8>> {
                    let mut reader = BufReader::new(stderr);
                    let mut collected = Vec::new();
                    loop {
                        let mut line = String::new();
                        let read = reader.read_line(&mut line)?;
                        if read == 0 {
                            break;
                        }
                        collected.extend_from_slice(line.as_bytes());
                        if let Some(callback) = stderr_progress.as_ref() {
                            if let Some(message) =
                                line.trim_end().strip_prefix(PYTHON_PROGRESS_PREFIX)
                            {
                                callback(parse_python_progress_event(message));
                            }
                        }
                    }
                    Ok(collected)
                });
                let status = child.wait()?;
                let stdout = stdout_thread
                    .join()
                    .map_err(|_| anyhow!("python helper stdout reader panicked"))??;
                let stderr = stderr_thread
                    .join()
                    .map_err(|_| anyhow!("python helper stderr reader panicked"))??;
                return Ok(std::process::Output {
                    status,
                    stdout,
                    stderr,
                });
            }
            Err(error) => last_error = Some(format!("{}: {}", candidate, error)),
        }
    }

    Err(anyhow!(
        "failed to spawn python helper ({})",
        last_error.unwrap_or_else(|| "unknown error".to_string())
    ))
}

pub(crate) fn check_script_syntax_via_python(script_path: &Path) -> Result<()> {
    let helper_args = vec![
        "-m".to_string(),
        "fullmag.runtime.helper".to_string(),
        "check-syntax".to_string(),
        "--script".to_string(),
        script_path.display().to_string(),
    ];

    let output = run_python_helper(&helper_args)
        .with_context(|| format!("failed to syntax-check {}", script_path.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("python syntax check failed: {}", stderr.trim());
    }
    Ok(())
}

pub(crate) fn export_script_execution_config_via_python(
    script_path: &Path,
    args: &ScriptCli,
    progress_callback: Option<PythonProgressCallback>,
) -> Result<ScriptExecutionConfig> {
    export_script_execution_config_via_python_with_options(
        script_path,
        args,
        false,
        progress_callback,
    )
}

pub(crate) fn export_script_execution_config_via_python_with_options(
    script_path: &Path,
    args: &ScriptCli,
    skip_geometry_assets: bool,
    progress_callback: Option<PythonProgressCallback>,
) -> Result<ScriptExecutionConfig> {
    use clap::ValueEnum;
    let mut helper_args = vec![
        "-m".to_string(),
        "fullmag.runtime.helper".to_string(),
        "export-run-config".to_string(),
        "--script".to_string(),
        script_path.display().to_string(),
    ];
    if let Some(backend) = args.backend {
        helper_args.push("--backend".to_string());
        helper_args.push(backend.to_possible_value().unwrap().get_name().to_string());
    }
    if let Some(mode) = args.mode {
        helper_args.push("--mode".to_string());
        helper_args.push(mode.to_possible_value().unwrap().get_name().to_string());
    }
    if let Some(precision) = args.precision {
        helper_args.push("--precision".to_string());
        helper_args.push(
            precision
                .to_possible_value()
                .unwrap()
                .get_name()
                .to_string(),
        );
    }
    if skip_geometry_assets {
        helper_args.push("--skip-geometry-assets".to_string());
    }

    let output = run_python_helper_with_progress(&helper_args, progress_callback)
        .with_context(|| format!("failed to export ProblemIR from {}", script_path.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("python helper failed: {}", stderr.trim());
    }

    let stdout = String::from_utf8(output.stdout)
        .context("python helper did not return valid UTF-8 JSON")?;
    serde_json::from_str(&stdout)
        .context("failed to deserialize script execution config from python helper")
}

pub(crate) fn read_magnetization_state(
    path: &Path,
    format: Option<&str>,
    dataset: Option<&str>,
    sample_index: Option<i64>,
) -> Result<LoadedMagnetizationState> {
    let mut helper_args = vec![
        "-m".to_string(),
        "fullmag.runtime.helper".to_string(),
        "read-magnetization-state".to_string(),
        "--path".to_string(),
        path.display().to_string(),
    ];
    if let Some(format) = format {
        helper_args.push("--format".to_string());
        helper_args.push(format.to_string());
    }
    if let Some(dataset) = dataset {
        helper_args.push("--dataset".to_string());
        helper_args.push(dataset.to_string());
    }
    if let Some(sample_index) = sample_index {
        helper_args.push("--sample".to_string());
        helper_args.push(sample_index.to_string());
    }

    let output = run_python_helper(&helper_args)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("failed to load magnetization state: {}", stderr.trim());
    }
    serde_json::from_slice::<LoadedMagnetizationState>(&output.stdout)
        .context("failed to parse magnetization state payload")
}

pub(crate) fn convert_magnetization_state(
    input_path: &Path,
    output_path: &Path,
    input_format: Option<&str>,
    output_format: Option<&str>,
    input_dataset: Option<&str>,
    output_dataset: Option<&str>,
    sample_index: Option<i64>,
) -> Result<()> {
    let mut helper_args = vec![
        "-m".to_string(),
        "fullmag.runtime.helper".to_string(),
        "convert-magnetization-state".to_string(),
        "--input-path".to_string(),
        input_path.display().to_string(),
        "--output-path".to_string(),
        output_path.display().to_string(),
    ];
    if let Some(input_format) = input_format {
        helper_args.push("--input-format".to_string());
        helper_args.push(input_format.to_string());
    }
    if let Some(output_format) = output_format {
        helper_args.push("--output-format".to_string());
        helper_args.push(output_format.to_string());
    }
    if let Some(input_dataset) = input_dataset {
        helper_args.push("--input-dataset".to_string());
        helper_args.push(input_dataset.to_string());
    }
    if let Some(output_dataset) = output_dataset {
        helper_args.push("--output-dataset".to_string());
        helper_args.push(output_dataset.to_string());
    }
    if let Some(sample_index) = sample_index {
        helper_args.push("--sample".to_string());
        helper_args.push(sample_index.to_string());
    }

    let output = run_python_helper(&helper_args)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("failed to convert magnetization state: {}", stderr.trim());
    }
    Ok(())
}

pub(crate) fn invoke_remesh_full(
    geometry_entry: &fullmag_ir::GeometryEntryIR,
    hmax: f64,
    fe_order: u32,
    mesh_options: &serde_json::Value,
    progress_callback: Option<PythonProgressCallback>,
) -> Result<RemeshCliResponse> {
    let payload = serde_json::json!({
        "mode": "manual_remesh",
        "geometry": geometry_entry,
        "hmax": hmax,
        "order": fe_order,
        "mesh_options": mesh_options,
    });
    let payload_str = serde_json::to_string(&payload)?;

    let script = format!(
        "import sys; sys.stdin = __import__('io').StringIO({payload_json}); \
         from fullmag.meshing.remesh_cli import main; main()",
        payload_json = serde_json::to_string(&payload_str)?,
    );
    let output = run_python_helper_with_progress(&["-c".to_string(), script], progress_callback)?;
    let stderr_text = String::from_utf8_lossy(&output.stderr);
    let non_progress_stderr = filter_non_progress_stderr(&stderr_text);
    if output.status.success() && !non_progress_stderr.is_empty() {
        eprintln!("[fullmag] remesh stderr:\n{}", non_progress_stderr);
    }
    if !output.status.success() {
        bail!(
            "remesh_cli.py failed (exit {}):\n{}",
            output.status.code().unwrap_or(-1),
            stderr_text.trim()
        );
    }
    let stdout_text = String::from_utf8_lossy(&output.stdout);
    let mesh: RemeshCliResponse = serde_json::from_slice(&output.stdout).with_context(|| {
        format!(
            "failed to parse remesh output ({} bytes):\n{}",
            output.stdout.len(),
            &stdout_text[..stdout_text.len().min(2000)]
        )
    })?;
    Ok(mesh)
}

pub(crate) fn invoke_shared_domain_remesh_full(
    geometry_entries: &[fullmag_ir::GeometryEntryIR],
    declared_universe: &serde_json::Value,
    hmax: f64,
    fe_order: u32,
    mesh_options: &serde_json::Value,
    progress_callback: Option<PythonProgressCallback>,
) -> Result<RemeshCliResponse> {
    let payload = serde_json::json!({
        "mode": "shared_domain_manual_remesh",
        "geometries": geometry_entries,
        "declared_universe": declared_universe,
        "hmax": hmax,
        "order": fe_order,
        "mesh_name": "study_domain",
        "mesh_options": mesh_options,
    });
    let payload_str = serde_json::to_string(&payload)?;

    let script = format!(
        "import sys; sys.stdin = __import__('io').StringIO({payload_json}); \
         from fullmag.meshing.remesh_cli import main; main()",
        payload_json = serde_json::to_string(&payload_str)?,
    );
    let output = run_python_helper_with_progress(&["-c".to_string(), script], progress_callback)?;
    let stderr_text = String::from_utf8_lossy(&output.stderr);
    let non_progress_stderr = filter_non_progress_stderr(&stderr_text);
    if output.status.success() && !non_progress_stderr.is_empty() {
        eprintln!(
            "[fullmag] shared-domain remesh stderr:\n{}",
            non_progress_stderr
        );
    }
    if !output.status.success() {
        bail!(
            "shared-domain remesh_cli.py failed (exit {}):\n{}",
            output.status.code().unwrap_or(-1),
            stderr_text.trim()
        );
    }
    let stdout_text = String::from_utf8_lossy(&output.stdout);
    let mesh: RemeshCliResponse = serde_json::from_slice(&output.stdout).with_context(|| {
        format!(
            "failed to parse shared-domain remesh output ({} bytes):\n{}",
            output.stdout.len(),
            &stdout_text[..stdout_text.len().min(2000)]
        )
    })?;
    Ok(mesh)
}

pub(crate) fn invoke_adaptive_remesh_full(
    geometry_entry: &fullmag_ir::GeometryEntryIR,
    hmax: f64,
    fe_order: u32,
    mesh_options: &serde_json::Value,
    size_field: &serde_json::Value,
    progress_callback: Option<PythonProgressCallback>,
) -> Result<RemeshCliResponse> {
    let payload = serde_json::json!({
        "mode": "adaptive_size_field",
        "geometry": geometry_entry,
        "hmax": hmax,
        "order": fe_order,
        "mesh_options": mesh_options,
        "size_field": size_field,
    });
    let payload_str = serde_json::to_string(&payload)?;

    let script = format!(
        "import sys; sys.stdin = __import__('io').StringIO({payload_json}); \
         from fullmag.meshing.remesh_cli import main; main()",
        payload_json = serde_json::to_string(&payload_str)?,
    );
    let output = run_python_helper_with_progress(&["-c".to_string(), script], progress_callback)?;
    let stderr_text = String::from_utf8_lossy(&output.stderr);
    let non_progress_stderr = filter_non_progress_stderr(&stderr_text);
    if output.status.success() && !non_progress_stderr.is_empty() {
        eprintln!("[fullmag] adaptive remesh stderr:\n{}", non_progress_stderr);
    }
    if !output.status.success() {
        bail!(
            "adaptive remesh_cli.py failed (exit {}):\n{}",
            output.status.code().unwrap_or(-1),
            stderr_text.trim()
        );
    }
    let stdout_text = String::from_utf8_lossy(&output.stdout);
    serde_json::from_slice(&output.stdout).with_context(|| {
        format!(
            "failed to parse adaptive remesh output ({} bytes):\n{}",
            output.stdout.len(),
            &stdout_text[..stdout_text.len().min(2000)]
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_python_progress_event_extracts_fem_surface_preview() {
        let event = parse_python_progress_event(
            r#"json:{"kind":"fem_surface_preview","geometry_name":"nanoflower","fem_mesh":{"nodes":[[0.0,0.0,0.0],[1.0,0.0,0.0],[0.0,1.0,0.0]],"elements":[],"boundary_faces":[[0,1,2]]},"message":"Surface preview ready"}"#,
        );

        match event {
            PythonProgressEvent::FemSurfacePreview {
                geometry_name,
                fem_mesh,
                message,
            } => {
                assert_eq!(geometry_name, "nanoflower");
                assert_eq!(fem_mesh.nodes.len(), 3);
                assert_eq!(fem_mesh.boundary_faces.len(), 1);
                assert!(fem_mesh.elements.is_empty());
                assert_eq!(message.as_deref(), Some("Surface preview ready"));
            }
            other => panic!("expected fem surface preview event, got {:?}", other),
        }
    }

    #[test]
    fn map_remesh_progress_message_maps_known_phases() {
        assert_eq!(
            map_remesh_progress_message(
                "Remesh: accepted - mode=manual_remesh, hmax=2.0e-08, order=P1"
            ),
            Some(RemeshTerminalProgress {
                percent: 5,
                label: "accepted",
            })
        );
        assert_eq!(
            map_remesh_progress_message("Gmsh: importing STL surface"),
            Some(RemeshTerminalProgress {
                percent: 15,
                label: "importing STL surface",
            })
        );
        assert_eq!(
            map_remesh_progress_message("Gmsh: applying mesh options"),
            Some(RemeshTerminalProgress {
                percent: 30,
                label: "configuring mesh fields",
            })
        );
        assert_eq!(
            map_remesh_progress_message("Gmsh: generating 3D tetrahedral mesh"),
            Some(RemeshTerminalProgress {
                percent: 75,
                label: "generating 3D mesh",
            })
        );
        assert_eq!(
            map_remesh_progress_message("Gmsh: extracting quality metrics"),
            Some(RemeshTerminalProgress {
                percent: 92,
                label: "extracting quality metrics",
            })
        );
        assert_eq!(
            map_remesh_progress_message("Gmsh: mesh ready - 100 nodes, 200 elements"),
            Some(RemeshTerminalProgress {
                percent: 100,
                label: "mesh ready",
            })
        );
        assert_eq!(
            map_remesh_progress_message("Gmsh: [ 40%] Meshing surface 3 (Plane, Frontal-Delaunay)"),
            Some(RemeshTerminalProgress {
                percent: 29,
                label: "meshing surfaces",
            })
        );
        assert_eq!(
            map_remesh_progress_message("Gmsh: [ 70%] Meshing curve 9 (Line)"),
            Some(RemeshTerminalProgress {
                percent: 18,
                label: "meshing curves",
            })
        );
    }

    #[test]
    fn map_remesh_progress_message_returns_none_for_unknown_messages() {
        assert_eq!(
            map_remesh_progress_message("some unrelated python log"),
            None
        );
    }

    #[test]
    fn filter_non_progress_stderr_strips_progress_lines() {
        let stderr = "[fullmag-progress] Remesh: accepted\nplain error\n[fullmag-progress] Gmsh: mesh ready\n";
        assert_eq!(filter_non_progress_stderr(stderr), "plain error");
    }
}
