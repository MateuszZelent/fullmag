use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, Stdio};

use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;
use std::collections::HashMap;

use crate::args::ScriptCli;
use crate::control_room::repo_root;
use crate::simulation_preparation::PreparationStageId;
use crate::types::{
    LoadedMagnetizationState, PythonProgressCallback, PythonProgressEvent, ScriptExecutionConfig,
};

const MAX_PREPARATION_PROGRESS_LABEL_CHARS: usize = 120;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PythonMeshPreparationUpdate {
    StageProgress {
        stage_id: PreparationStageId,
        detail: String,
        progress_percent: Option<u8>,
        progress_label: Option<String>,
    },
    Completed {
        detail: String,
    },
    Failed {
        stage_id: PreparationStageId,
        summary: String,
    },
}

impl PythonMeshPreparationUpdate {
    #[cfg(test)]
    pub(crate) fn stage_id(&self) -> PreparationStageId {
        match self {
            Self::StageProgress { stage_id, .. } | Self::Failed { stage_id, .. } => *stage_id,
            Self::Completed { .. } => PreparationStageId::MeshPostprocessing,
        }
    }
}

pub(crate) fn python_mesh_preparation_update(
    kind: &str,
    payload: &serde_json::Value,
) -> Option<PythonMeshPreparationUpdate> {
    let progress_percent = payload
        .get("progress_percent")
        .or_else(|| payload.get("percent"))
        .and_then(serde_json::Value::as_u64)
        .filter(|value| *value <= 100)
        .and_then(|value| u8::try_from(value).ok());
    let progress_label = payload
        .get("progress_label")
        .or_else(|| payload.get("label"))
        .and_then(serde_json::Value::as_str)
        .and_then(sanitize_preparation_progress_label);

    let stage_progress = |stage_id, fallback_detail: &str| {
        Some(PythonMeshPreparationUpdate::StageProgress {
            stage_id,
            detail: fallback_detail.to_string(),
            progress_percent,
            progress_label: progress_label.clone(),
        })
    };

    match kind {
        "mesh_build_started" => stage_progress(
            PreparationStageId::DomainPreparation,
            "Preparing shared-domain inputs",
        ),
        "mesh_build_phase" => match payload
            .get("phase")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("queued")
        {
            "queued" | "materializing" | "preparing_domain" => stage_progress(
                PreparationStageId::DomainPreparation,
                "Preparing the shared domain",
            ),
            "meshing" => stage_progress(PreparationStageId::Meshing, "Meshing the shared domain"),
            "postprocessing" => stage_progress(
                PreparationStageId::MeshPostprocessing,
                "Postprocessing the shared-domain mesh",
            ),
            _ => None,
        },
        "mesh_build_summary" => Some(PythonMeshPreparationUpdate::Completed {
            detail: "Shared-domain mesh preparation complete".to_string(),
        }),
        "mesh_build_failed" => {
            let stage_id = match payload.get("phase").and_then(serde_json::Value::as_str) {
                Some("meshing") => PreparationStageId::Meshing,
                Some("postprocessing") => PreparationStageId::MeshPostprocessing,
                _ => PreparationStageId::DomainPreparation,
            };
            Some(PythonMeshPreparationUpdate::Failed {
                stage_id,
                summary: "Shared-domain mesh build failed".to_string(),
            })
        }
        _ => None,
    }
}

fn sanitize_preparation_progress_label(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || preparation_text_looks_path_like(trimmed) {
        return None;
    }

    let mut sanitized = String::new();
    let mut previous_was_space = false;
    let mut character_count = 0;
    for character in trimmed.chars() {
        if character_count >= MAX_PREPARATION_PROGRESS_LABEL_CHARS {
            break;
        }
        if character.is_control() || character.is_whitespace() {
            if !previous_was_space && !sanitized.is_empty() {
                sanitized.push(' ');
                character_count += 1;
                previous_was_space = true;
            }
        } else {
            sanitized.push(character);
            character_count += 1;
            previous_was_space = false;
        }
    }
    let bounded = sanitized.trim().to_string();
    (!bounded.is_empty()).then_some(bounded)
}

fn preparation_text_looks_path_like(value: &str) -> bool {
    value.starts_with(['/', '~'])
        || value.contains('\\')
        || value.contains("../")
        || value.contains(":/")
        || value
            .split_whitespace()
            .any(|token| token != "/" && (token.starts_with('/') || token.contains('/')))
}

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

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub(crate) struct RemeshQualityDataArtifactRef {
    pub kind: String,
    pub schema_version: u32,
    pub path: PathBuf,
    pub byte_size: u64,
    pub element_count: u32,
    #[serde(default)]
    pub metrics: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct RemeshCliResponse {
    pub mesh_name: String,
    pub nodes: Vec<[f64; 3]>,
    pub cells: fullmag_ir::FemConnectivityIR,
    pub element_markers: Vec<u32>,
    pub facets: fullmag_ir::FemFacetConnectivityIR,
    pub boundary_markers: Vec<u32>,
    pub periodic_boundary_pairs: Vec<fullmag_ir::MeshPeriodicBoundaryPairIR>,
    pub periodic_node_pairs: Vec<fullmag_ir::MeshPeriodicNodePairIR>,
    pub periodic_mesh_certificate: Option<serde_json::Value>,
    pub mixed_layer_topology_certificate: Option<fullmag_ir::MixedLayerTopologyCertificateV1IR>,
    pub shared_domain_build_report: Option<fullmag_ir::FemSharedDomainBuildReportIR>,
    pub quality: Option<RemeshQualitySummary>,
    pub generation_mode: Option<String>,
    pub mesh_provenance: Option<serde_json::Value>,
    pub mesh_statistics: Option<serde_json::Value>,
    pub size_field_stats: Option<serde_json::Value>,
    pub region_markers: Vec<fullmag_ir::FemDomainRegionMarkerIR>,
    pub object_region_markers: Vec<fullmag_ir::FemDomainRegionMarkerIR>,
    /// Per-domain element quality, keyed by domain marker string (from Python).
    pub per_domain_quality: HashMap<String, RemeshPerDomainQuality>,
    pub quality_data_artifact: Option<RemeshQualityDataArtifactRef>,
    topology_artifact: Option<RemeshTopologyArtifactRef>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct RemeshTopologyWire {
    #[serde(default)]
    cell_types: Option<Vec<fullmag_ir::FemCellTypeIR>>,
    #[serde(default)]
    cell_offsets: Option<Vec<u32>>,
    #[serde(default)]
    cell_nodes: Option<Vec<u32>>,
    #[serde(default)]
    cell_global_ordinals: Option<Vec<u64>>,
    #[serde(default)]
    cell_mesh_parts: Option<Vec<fullmag_ir::FemCellMeshPartIR>>,
    #[serde(default)]
    facet_types: Option<Vec<fullmag_ir::FemFacetTypeIR>>,
    #[serde(default)]
    facet_roles: Option<Vec<fullmag_ir::FemFacetRoleIR>>,
    #[serde(default)]
    facet_offsets: Option<Vec<u32>>,
    #[serde(default)]
    facet_nodes: Option<Vec<u32>>,
    #[serde(default)]
    facet_global_ordinals: Option<Vec<u64>>,
    #[serde(default)]
    elements: Option<Vec<[u32; 4]>>,
    #[serde(default)]
    boundary_faces: Option<Vec<[u32; 3]>>,
}

impl RemeshTopologyWire {
    fn normalize(
        self,
    ) -> std::result::Result<
        (
            fullmag_ir::FemConnectivityIR,
            fullmag_ir::FemFacetConnectivityIR,
        ),
        String,
    > {
        let has_v2 = self.cell_types.is_some()
            || self.cell_offsets.is_some()
            || self.cell_nodes.is_some()
            || self.cell_global_ordinals.is_some()
            || self.cell_mesh_parts.is_some()
            || self.facet_types.is_some()
            || self.facet_roles.is_some()
            || self.facet_offsets.is_some()
            || self.facet_nodes.is_some()
            || self.facet_global_ordinals.is_some();
        let has_legacy = self.elements.is_some() || self.boundary_faces.is_some();
        if has_v2 && has_legacy {
            return Err("remesh payload contains both legacy and v2 topology".to_string());
        }
        if has_v2 {
            let cell_types = self
                .cell_types
                .ok_or_else(|| "v2 remesh topology requires cell_types".to_string())?;
            let facet_types = self
                .facet_types
                .ok_or_else(|| "v2 remesh topology requires facet_types".to_string())?;
            return Ok((
                fullmag_ir::FemConnectivityIR {
                    global_ordinals: self
                        .cell_global_ordinals
                        .unwrap_or_else(|| (0..cell_types.len() as u64).collect()),
                    types: cell_types,
                    offsets: self
                        .cell_offsets
                        .ok_or_else(|| "v2 remesh topology requires cell_offsets".to_string())?,
                    nodes: self
                        .cell_nodes
                        .ok_or_else(|| "v2 remesh topology requires cell_nodes".to_string())?,
                    mesh_parts: self.cell_mesh_parts.unwrap_or_default(),
                },
                fullmag_ir::FemFacetConnectivityIR {
                    global_ordinals: self
                        .facet_global_ordinals
                        .unwrap_or_else(|| (0..facet_types.len() as u64).collect()),
                    types: facet_types,
                    roles: self
                        .facet_roles
                        .ok_or_else(|| "v2 remesh topology requires facet_roles".to_string())?,
                    offsets: self
                        .facet_offsets
                        .ok_or_else(|| "v2 remesh topology requires facet_offsets".to_string())?,
                    nodes: self
                        .facet_nodes
                        .ok_or_else(|| "v2 remesh topology requires facet_nodes".to_string())?,
                },
            ));
        }
        if has_legacy {
            return Ok((
                fullmag_ir::FemConnectivityIR::from_tet4(
                    self.elements
                        .ok_or_else(|| "legacy remesh topology requires elements".to_string())?,
                ),
                fullmag_ir::FemFacetConnectivityIR::from_tri3(
                    self.boundary_faces.ok_or_else(|| {
                        "legacy remesh topology requires boundary_faces".to_string()
                    })?,
                ),
            ));
        }
        Err("remesh payload must provide either v2 or legacy topology".to_string())
    }
}

#[derive(Debug, serde::Deserialize)]
struct RemeshCliResponseWire {
    mesh_name: String,
    nodes: Vec<[f64; 3]>,
    #[serde(flatten)]
    topology: RemeshTopologyWire,
    element_markers: Vec<u32>,
    boundary_markers: Vec<u32>,
    #[serde(default)]
    periodic_boundary_pairs: Vec<fullmag_ir::MeshPeriodicBoundaryPairIR>,
    #[serde(default)]
    periodic_node_pairs: Vec<fullmag_ir::MeshPeriodicNodePairIR>,
    #[serde(default)]
    periodic_mesh_certificate: Option<serde_json::Value>,
    #[serde(default)]
    mixed_layer_topology_certificate: Option<fullmag_ir::MixedLayerTopologyCertificateV1IR>,
    quality: Option<RemeshQualitySummary>,
    #[serde(default)]
    generation_mode: Option<String>,
    #[serde(default)]
    mesh_provenance: Option<serde_json::Value>,
    #[serde(default)]
    mesh_statistics: Option<serde_json::Value>,
    #[serde(default)]
    size_field_stats: Option<serde_json::Value>,
    #[serde(default)]
    region_markers: Vec<fullmag_ir::FemDomainRegionMarkerIR>,
    #[serde(default)]
    object_region_markers: Vec<fullmag_ir::FemDomainRegionMarkerIR>,
    #[serde(default)]
    per_domain_quality: HashMap<String, RemeshPerDomainQuality>,
    #[serde(default)]
    quality_data_artifact: Option<RemeshQualityDataArtifactRef>,
    #[serde(default)]
    topology_artifact: Option<RemeshTopologyArtifactRef>,
}

impl<'de> serde::Deserialize<'de> for RemeshCliResponse {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = RemeshCliResponseWire::deserialize(deserializer)?;
        let (cells, facets) = wire
            .topology
            .normalize()
            .map_err(serde::de::Error::custom)?;
        let shared_domain_build_report = wire
            .mesh_provenance
            .as_ref()
            .and_then(|value| value.get("shared_domain_build_report"))
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(serde::de::Error::custom)?;
        Ok(Self {
            mesh_name: wire.mesh_name,
            nodes: wire.nodes,
            cells,
            element_markers: wire.element_markers,
            facets,
            boundary_markers: wire.boundary_markers,
            periodic_boundary_pairs: wire.periodic_boundary_pairs,
            periodic_node_pairs: wire.periodic_node_pairs,
            periodic_mesh_certificate: wire.periodic_mesh_certificate,
            mixed_layer_topology_certificate: wire.mixed_layer_topology_certificate,
            shared_domain_build_report,
            quality: wire.quality,
            generation_mode: wire.generation_mode,
            mesh_provenance: wire.mesh_provenance,
            mesh_statistics: wire.mesh_statistics,
            size_field_stats: wire.size_field_stats,
            region_markers: wire.region_markers,
            object_region_markers: wire.object_region_markers,
            per_domain_quality: wire.per_domain_quality,
            quality_data_artifact: wire.quality_data_artifact,
            topology_artifact: wire.topology_artifact,
        })
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
struct RemeshTopologyArtifactRef {
    path: PathBuf,
}

#[derive(Debug, Clone, serde::Deserialize)]
struct RemeshTopologyArtifactPayload {
    nodes: Vec<[f64; 3]>,
    #[serde(flatten)]
    topology: RemeshTopologyWire,
    element_markers: Vec<u32>,
    boundary_markers: Vec<u32>,
    #[serde(default)]
    periodic_boundary_pairs: Vec<fullmag_ir::MeshPeriodicBoundaryPairIR>,
    #[serde(default)]
    periodic_node_pairs: Vec<fullmag_ir::MeshPeriodicNodePairIR>,
    #[serde(default)]
    periodic_mesh_certificate: Option<serde_json::Value>,
    #[serde(default)]
    mixed_layer_topology_certificate: Option<fullmag_ir::MixedLayerTopologyCertificateV1IR>,
}

impl RemeshCliResponse {
    fn hydrate_topology_artifact(mut self) -> Result<Self> {
        let Some(artifact) = self.topology_artifact.as_ref() else {
            return Ok(self);
        };
        let text = std::fs::read_to_string(&artifact.path).with_context(|| {
            format!(
                "failed to read remesh topology artifact {}",
                artifact.path.display()
            )
        })?;
        let topology: RemeshTopologyArtifactPayload =
            serde_json::from_str(&text).with_context(|| {
                format!(
                    "failed to parse remesh topology artifact {}",
                    artifact.path.display()
                )
            })?;
        let report_certificate = self
            .shared_domain_build_report
            .as_ref()
            .and_then(|report| report.mixed_layer_topology_certificate.as_ref());
        if let (Some(inline), Some(in_report)) = (
            self.mixed_layer_topology_certificate.as_ref(),
            report_certificate,
        ) {
            anyhow::ensure!(
                inline == in_report,
                "mixed layer topology certificate differs between inline topology and build report"
            );
        }
        anyhow::ensure!(
            topology.mixed_layer_topology_certificate.is_some()
                || (self.mixed_layer_topology_certificate.is_none()
                    && report_certificate.is_none()),
            "topology artifact is missing a mixed layer topology certificate carried by inline topology or the shared-domain build report"
        );
        if let Some(in_artifact) = topology.mixed_layer_topology_certificate.as_ref() {
            if let Some(inline) = self.mixed_layer_topology_certificate.as_ref() {
                anyhow::ensure!(
                    inline == in_artifact,
                    "mixed layer topology certificate differs between inline topology and artifact"
                );
            }
            if let Some(in_report) = report_certificate {
                anyhow::ensure!(
                    in_report == in_artifact,
                    "mixed layer topology certificate differs between build report and artifact"
                );
            }
        }
        let (cells, facets) = topology.topology.normalize().map_err(anyhow::Error::msg)?;
        self.nodes = topology.nodes;
        self.cells = cells;
        self.element_markers = topology.element_markers;
        self.facets = facets;
        self.boundary_markers = topology.boundary_markers;
        self.periodic_boundary_pairs = topology.periodic_boundary_pairs;
        self.periodic_node_pairs = topology.periodic_node_pairs;
        self.periodic_mesh_certificate = topology.periodic_mesh_certificate;
        self.mixed_layer_topology_certificate = topology.mixed_layer_topology_certificate;
        Ok(self)
    }

    fn retain_periodic_certificate_in_provenance(&mut self) {
        let Some(certificate) = self.periodic_mesh_certificate.clone() else {
            return;
        };
        let provenance = self
            .mesh_provenance
            .get_or_insert_with(|| serde_json::json!({}));
        if let Some(object) = provenance.as_object_mut() {
            object.insert("periodic_mesh_certificate".to_string(), certificate);
        }
    }

    fn retain_mixed_certificate_in_provenance(&mut self) -> Result<()> {
        let Some(certificate) = self.mixed_layer_topology_certificate.clone() else {
            return Ok(());
        };
        let typed_report = self.shared_domain_build_report.as_mut().ok_or_else(|| {
            anyhow::anyhow!(
                "mixed layer topology certificate requires a shared-domain build report"
            )
        })?;
        match typed_report.mixed_layer_topology_certificate.as_ref() {
            Some(in_report) => anyhow::ensure!(
                in_report == &certificate,
                "mixed layer topology certificate differs between topology and build report"
            ),
            None => typed_report.mixed_layer_topology_certificate = Some(certificate.clone()),
        }
        let report = self
            .mesh_provenance
            .as_mut()
            .and_then(|value| value.get_mut("shared_domain_build_report"))
            .and_then(serde_json::Value::as_object_mut)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "mixed layer topology certificate requires a shared-domain build report in provenance"
                )
            })?;
        report.insert(
            "mixed_layer_topology_certificate".to_string(),
            serde_json::to_value(certificate).expect("typed certificate must serialize"),
        );
        Ok(())
    }

    fn validate_mixed_certificate_binding(&self) -> Result<()> {
        let report_certificate = self
            .shared_domain_build_report
            .as_ref()
            .and_then(|report| report.mixed_layer_topology_certificate.as_ref());
        if let (Some(top_level), Some(in_report)) = (
            self.mixed_layer_topology_certificate.as_ref(),
            report_certificate,
        ) {
            anyhow::ensure!(
                top_level == in_report,
                "mixed layer topology certificate differs between topology and build report"
            );
        }
        if self
            .mixed_layer_topology_certificate
            .as_ref()
            .or(report_certificate)
            .is_none()
        {
            return Ok(());
        }
        let asset = fullmag_ir::FemDomainMeshAssetIR {
            mesh_source: None,
            mesh: Some(self.clone().into_mesh_ir()),
            region_markers: self.region_markers.clone(),
            object_region_markers: self.object_region_markers.clone(),
            build_report: self.shared_domain_build_report.clone(),
        };
        asset
            .validate()
            .map_err(|errors| anyhow::anyhow!(errors.join("; ")))?;
        Ok(())
    }

    pub(crate) fn into_mesh_ir(self) -> fullmag_ir::MeshIR {
        let per_domain_quality = self
            .per_domain_quality
            .into_iter()
            .filter_map(|(k, v)| k.parse::<u32>().ok().map(|marker| (marker, v.into())))
            .collect();
        fullmag_ir::MeshIR {
            mesh_name: self.mesh_name,
            nodes: self.nodes,
            cells: self.cells,
            element_markers: self.element_markers,
            facets: self.facets,
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
    pub percent: Option<u8>,
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
        cells: fullmag_ir::FemConnectivityIR::from_tet4(preview.elements),
        element_markers,
        facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(preview.boundary_faces),
        boundary_markers,
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        object_segments: Vec::new(),
        mesh_parts: Vec::new(),
        domain_mesh_mode: None,
        domain_frame: None,
        generation_id: None,
        build_report: None,
        per_domain_quality: HashMap::new(),
    })
}

pub(crate) fn map_remesh_progress_message(message: &str) -> Option<RemeshTerminalProgress> {
    let lower = message.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return None;
    }

    if let Some(progress) = parse_gmsh_heartbeat_progress(message) {
        return Some(progress);
    }

    if let Some(progress) = parse_gmsh_inline_progress(message) {
        return Some(progress);
    }

    if lower.contains("remesh: accepted") || lower.contains("request queued") {
        return Some(RemeshTerminalProgress {
            percent: None,
            label: "accepted",
        });
    }
    if lower.contains("importing stl surface") {
        return Some(RemeshTerminalProgress {
            percent: None,
            label: "importing STL surface",
        });
    }
    if lower.contains("importing cad shapes") || lower.contains("importing cad geometry") {
        return Some(RemeshTerminalProgress {
            percent: None,
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
            percent: None,
            label: "building geometry",
        });
    }
    if lower.contains("applying adaptive size field")
        || lower.contains("applying mesh options")
        || lower.contains("configuring mesh size fields")
    {
        return Some(RemeshTerminalProgress {
            percent: None,
            label: "configuring mesh fields",
        });
    }
    if lower.contains("generating adaptive 3d mesh")
        || lower.contains("generating air-box 3d mesh")
        || lower.contains("generating 3d tetrahedral mesh")
    {
        return Some(RemeshTerminalProgress {
            percent: None,
            label: "generating 3D mesh",
        });
    }
    if lower.contains("optimizing mesh") {
        return Some(RemeshTerminalProgress {
            percent: None,
            label: "optimizing mesh",
        });
    }
    if lower.contains("extracting quality metrics") {
        return Some(RemeshTerminalProgress {
            percent: None,
            label: "extracting quality metrics",
        });
    }
    if lower.contains("extracting mesh data") {
        return Some(RemeshTerminalProgress {
            percent: None,
            label: "extracting mesh data",
        });
    }
    if lower.contains("mesh ready") {
        return Some(RemeshTerminalProgress {
            percent: Some(100),
            label: "mesh ready",
        });
    }

    None
}

fn parse_gmsh_heartbeat_progress(message: &str) -> Option<RemeshTerminalProgress> {
    let trimmed = message.trim();
    let lower = trimmed.to_ascii_lowercase();
    let label = if lower.contains("(meshing curves;") {
        "meshing curves"
    } else if lower.contains("(meshing surfaces;") {
        "meshing surfaces"
    } else if lower.contains("(meshing 3d volume;") {
        "meshing 3D volume"
    } else if lower.contains("(optimizing mesh;") {
        "optimizing mesh"
    } else {
        "generating 3D mesh"
    };

    if lower.contains("gmsh: meshing active (") || lower.contains("meshing in progress ~") {
        return Some(RemeshTerminalProgress {
            percent: None,
            label,
        });
    }
    None
}

fn parse_gmsh_inline_progress(message: &str) -> Option<RemeshTerminalProgress> {
    let trimmed = message.trim();
    let start = trimmed.find('[')?;
    let end = trimmed[start..].find("%]")?;
    let _raw_percent = trimmed[start + 1..start + end].trim().parse::<u8>().ok()?;
    let lower = trimmed.to_ascii_lowercase();

    let label = if lower.contains("meshing curve") || lower.contains("meshing 1d") {
        "meshing curves"
    } else if lower.contains("meshing surface") || lower.contains("meshing 2d") {
        "meshing surfaces"
    } else if lower.contains("meshing volume") || lower.contains("meshing 3d") {
        "meshing 3D volume"
    } else {
        return None;
    };

    Some(RemeshTerminalProgress {
        percent: None,
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

fn parse_remesh_cli_response(stdout: &[u8], output_label: &str) -> Result<RemeshCliResponse> {
    let stdout_text = String::from_utf8_lossy(stdout);
    let mesh: RemeshCliResponse = serde_json::from_slice(stdout).with_context(|| {
        format!(
            "failed to parse {output_label} ({} bytes):\n{}",
            stdout.len(),
            &stdout_text[..stdout_text.len().min(2000)]
        )
    })?;
    let mut mesh = mesh.hydrate_topology_artifact()?;
    mesh.retain_periodic_certificate_in_provenance();
    mesh.retain_mixed_certificate_in_provenance()?;
    mesh.validate_mixed_certificate_binding()?;
    Ok(mesh)
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
    let helper_args = syntax_check_python_args(script_path);

    let output = run_python_helper(&helper_args)
        .with_context(|| format!("failed to syntax-check {}", script_path.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("python syntax check failed: {}", stderr.trim());
    }
    Ok(())
}

fn syntax_check_python_args(script_path: &Path) -> Vec<String> {
    vec![
        "-c".to_string(),
        "import json, pathlib, sys; \
         path = pathlib.Path(sys.argv[1]); \
         source = path.read_text(encoding='utf-8'); \
         compile(source, str(path), 'exec'); \
         print(json.dumps({'status': 'ok', 'script': str(path.resolve())}))"
            .to_string(),
        script_path.display().to_string(),
    ]
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

pub(crate) fn extract_json_from_stdout(stdout: &str) -> Result<&str> {
    stdout
        .lines()
        .rev()
        .find(|line| {
            let trimmed = line.trim();
            trimmed.starts_with('{') && trimmed.ends_with('}')
        })
        .ok_or_else(|| anyhow!("could not find valid JSON object in python helper stdout"))
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
    if let Some(device) =
        managed_fem_execution_device(std::env::var("FULLMAG_FEM_EXECUTION").ok().as_deref())
    {
        helper_args.push("--runtime-device".to_string());
        helper_args.push(device.to_string());
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
    let json_str = extract_json_from_stdout(&stdout)?;
    serde_json::from_str(json_str)
        .context("failed to deserialize script execution config from python helper")
}

pub(crate) fn managed_fem_execution_device(value: Option<&str>) -> Option<&'static str> {
    match value.map(str::trim) {
        Some("cpu") => Some("cpu"),
        Some("gpu" | "cuda" | "all_in_gpu") => Some("gpu"),
        _ => None,
    }
}

pub(crate) fn read_magnetization_state(
    path: &Path,
    format: Option<&str>,
    dataset: Option<&str>,
    sample_index: Option<i64>,
) -> Result<LoadedMagnetizationState> {
    if should_read_magnetization_state_json_in_rust(path, format) {
        return read_json_magnetization_state(path, sample_index);
    }

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

fn should_read_magnetization_state_json_in_rust(path: &Path, format: Option<&str>) -> bool {
    match format.map(|value| value.trim().to_ascii_lowercase()) {
        Some(format) if format == "json" => true,
        Some(format) if format == "auto" => path_looks_like_json_state(path),
        None => path_looks_like_json_state(path),
        _ => false,
    }
}

fn path_looks_like_json_state(path: &Path) -> bool {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    !(lower.ends_with(".h5")
        || lower.ends_with(".hdf5")
        || lower.ends_with(".zarr")
        || lower.ends_with(".zarr.zip"))
}

fn read_json_magnetization_state(
    path: &Path,
    sample_index: Option<i64>,
) -> Result<LoadedMagnetizationState> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read magnetization state {}", path.display()))?;
    let payload: Value = serde_json::from_str(&text).with_context(|| {
        format!(
            "failed to parse magnetization state JSON {}",
            path.display()
        )
    })?;
    let values = json_magnetization_values(&payload)
        .with_context(|| format!("{} does not contain magnetization values", path.display()))?;
    let rows = select_json_magnetization_rows(values, sample_index.unwrap_or(-1))?;
    Ok(LoadedMagnetizationState {
        vector_count: rows.len(),
        values: rows,
    })
}

fn json_magnetization_values(payload: &Value) -> Option<&Value> {
    if let Value::Object(map) = payload {
        if let Some(observable) = map.get("observable").and_then(Value::as_str) {
            if observable != "m" {
                return None;
            }
        }
        map.get("values").or_else(|| map.get("magnetization"))
    } else {
        Some(payload)
    }
}

fn select_json_magnetization_rows(value: &Value, sample_index: i64) -> Result<Vec<[f64; 3]>> {
    let array = value
        .as_array()
        .ok_or_else(|| anyhow!("magnetization state must be an array"))?;
    if array.is_empty() {
        bail!("magnetization state must contain at least one vector");
    }
    if array[0].is_number() {
        if array.len() % 3 != 0 {
            bail!(
                "expected a flat magnetization buffer divisible by 3, got length {}",
                array.len()
            );
        }
        return array
            .chunks_exact(3)
            .map(json_vector_from_slice)
            .collect::<Result<Vec<_>>>();
    }

    let first_array = array[0]
        .as_array()
        .ok_or_else(|| anyhow!("expected magnetization rows or samples"))?;
    if first_array.len() == 3 && first_array.iter().all(Value::is_number) {
        return array
            .iter()
            .map(|row| {
                let row = row
                    .as_array()
                    .ok_or_else(|| anyhow!("expected magnetization vector row"))?;
                json_vector_from_slice(row)
            })
            .collect::<Result<Vec<_>>>();
    }

    let index = if sample_index >= 0 {
        sample_index as usize
    } else {
        array.len() - 1
    };
    let sample = array.get(index).ok_or_else(|| {
        anyhow!(
            "sample index {} is out of range for {} samples",
            sample_index,
            array.len()
        )
    })?;
    select_json_magnetization_rows(sample, -1)
}

fn json_vector_from_slice(values: &[Value]) -> Result<[f64; 3]> {
    if values.len() != 3 {
        bail!("expected magnetization vector with three components");
    }
    Ok([
        values[0]
            .as_f64()
            .ok_or_else(|| anyhow!("magnetization component must be numeric"))?,
        values[1]
            .as_f64()
            .ok_or_else(|| anyhow!("magnetization component must be numeric"))?,
        values[2]
            .as_f64()
            .ok_or_else(|| anyhow!("magnetization component must be numeric"))?,
    ])
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
    parse_remesh_cli_response(&output.stdout, "remesh output")
}

pub(crate) fn invoke_shared_domain_remesh_full(
    geometry_entries: &[fullmag_ir::GeometryEntryIR],
    object_regions: &[serde_json::Value],
    declared_universe: &serde_json::Value,
    hmax: f64,
    fe_order: u32,
    mesh_options: &serde_json::Value,
    progress_callback: Option<PythonProgressCallback>,
) -> Result<RemeshCliResponse> {
    let payload = serde_json::json!({
        "mode": "shared_domain_manual_remesh",
        "geometries": geometry_entries,
        "object_regions": object_regions,
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
    parse_remesh_cli_response(&output.stdout, "shared-domain remesh output")
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
    parse_remesh_cli_response(&output.stdout, "adaptive remesh output")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::simulation_preparation::PreparationStageId;

    #[test]
    fn managed_fem_execution_device_maps_only_explicit_cpu_or_gpu_modes() {
        assert_eq!(managed_fem_execution_device(Some("cpu")), Some("cpu"));
        assert_eq!(managed_fem_execution_device(Some("gpu")), Some("gpu"));
        assert_eq!(managed_fem_execution_device(Some("cuda")), Some("gpu"));
        assert_eq!(
            managed_fem_execution_device(Some("all_in_gpu")),
            Some("gpu")
        );
        assert_eq!(managed_fem_execution_device(Some("auto")), None);
        assert_eq!(managed_fem_execution_device(None), None);
    }

    fn valid_mixed_remesh_payload() -> serde_json::Value {
        let mut payload: serde_json::Value = serde_json::from_str(r#"{
            "mesh_name": "qualified_mixed",
            "nodes": [
                [-1.0,-1.0,-1.0],[1.0,-1.0,-1.0],[1.0,1.0,-1.0],[-1.0,1.0,-1.0],
                [-1.0,-1.0,1.0],[1.0,-1.0,1.0],[1.0,1.0,1.0],[-1.0,1.0,1.0],
                [2.0,0.0,0.0],[-2.0,0.0,0.0],[0.0,2.0,0.0],[0.0,-2.0,0.0],
                [0.0,0.0,2.0],[0.0,0.0,-2.0],[2.0,0.0,-2.0],
                [-2.0,-2.0,-2.0],[2.0,2.0,-2.0],[2.0,-2.0,2.0],[-2.0,1.0,1.0],
                [-2.0,-2.0,-2.0],[2.0,2.0,-2.0],[2.0,-2.0,2.0],[-2.0,1.0,1.0],
                [-2.0,-2.0,-2.0],[2.0,2.0,-2.0],[2.0,-2.0,2.0],[-2.0,0.875,0.875]
            ],
            "cell_types": ["prism6","prism6","pyramid5","pyramid5","pyramid5","pyramid5","tet4","tet4","tet4","tet4","tet4","tet4","tet4","tet4"],
            "cell_offsets": [0,6,12,17,22,27,32,36,40,44,48,52,56,60,64],
            "cell_nodes": [0,1,2,4,5,6,0,2,3,4,6,7,1,2,6,5,8,0,4,7,3,9,2,3,7,6,10,0,1,5,4,11,4,5,6,12,4,6,7,12,0,2,1,13,0,3,2,13,1,2,8,14,15,17,16,18,19,21,20,22,23,25,24,26],
            "cell_global_ordinals": [0,1,2,3,4,5,6,7,8,9,10,11,12,13],
            "cell_mesh_parts": ["magnetic","magnetic","transition_air","transition_air","transition_air","transition_air","transition_air","transition_air","transition_air","transition_air","far_air","far_air","far_air","far_air"],
            "element_markers": [1,1,0,0,0,0,0,0,0,0,0,0,0,0],
            "facet_types": ["tri3","quad4","tri3","tri3","tri3","quad4","tri3","tri3","tri3","tri3","quad4","tri3","tri3","tri3","tri3","tri3","quad4","tri3","tri3","tri3","tri3","tri3","tri3","tri3","tri3","tri3","tri3","tri3","tri3","tri3","tri3","tri3","tri3","tri3","tri3","tri3","tri3","tri3","tri3","tri3","tri3","tri3","tri3","tri3","tri3","tri3"],
            "facet_roles": ["material_interface","material_interface","exterior","exterior","material_interface","material_interface","exterior","exterior","exterior","exterior","material_interface","exterior","exterior","exterior","exterior","exterior","material_interface","exterior","exterior","exterior","exterior","exterior","exterior","exterior","material_interface","exterior","exterior","material_interface","exterior","exterior","exterior","exterior","exterior","exterior","exterior","exterior","exterior","exterior","exterior","exterior","exterior","exterior","exterior","exterior","exterior","exterior"],
            "facet_offsets": [0,3,7,10,13,16,20,23,26,29,32,36,39,42,45,48,51,55,58,61,64,67,70,73,76,79,82,85,88,91,94,97,100,103,106,109,112,115,118,121,124,127,130,133,136,139,142],
            "facet_nodes": [0,1,2,0,1,4,5,0,1,11,0,1,13,0,2,3,0,3,4,7,0,3,9,0,3,13,0,4,9,0,4,11,1,2,5,6,1,2,13,1,2,14,1,5,8,1,5,11,1,8,14,2,3,6,7,2,3,10,2,3,13,2,6,8,2,6,10,2,8,14,3,7,9,3,7,10,4,5,6,4,5,11,4,5,12,4,6,7,4,7,9,4,7,12,5,6,8,5,6,12,6,7,10,6,7,12,15,16,17,15,16,18,15,17,18,16,17,18,19,20,21,19,20,22,19,21,22,20,21,22,23,24,25,23,24,26,23,25,26,24,25,26],
            "facet_global_ordinals": [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45],
            "boundary_markers": [2,2,3,3,2,2,3,3,3,3,2,3,3,3,3,3,2,3,3,3,3,3,3,3,2,3,3,2,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3],
            "periodic_boundary_pairs": [],
            "periodic_node_pairs": [],
            "periodic_mesh_certificate": null,
            "quality": null
        }"#).unwrap();
        let mesh: fullmag_ir::MeshIR = serde_json::from_value(serde_json::json!({
            "mesh_name": payload["mesh_name"].clone(),
            "nodes": payload["nodes"].clone(),
            "cells": {
                "types": payload["cell_types"].clone(), "offsets": payload["cell_offsets"].clone(),
                "nodes": payload["cell_nodes"].clone(), "global_ordinals": payload["cell_global_ordinals"].clone(),
                "mesh_parts": payload["cell_mesh_parts"].clone()
            },
            "element_markers": payload["element_markers"].clone(),
            "facets": {
                "types": payload["facet_types"].clone(), "roles": payload["facet_roles"].clone(),
                "offsets": payload["facet_offsets"].clone(), "nodes": payload["facet_nodes"].clone(),
                "global_ordinals": payload["facet_global_ordinals"].clone()
            },
            "boundary_markers": payload["boundary_markers"].clone(),
            "periodic_boundary_pairs": [], "periodic_node_pairs": [], "per_domain_quality": {}
        }))
        .unwrap();
        let mut certificate: serde_json::Value = serde_json::from_str(r#"{
            "schema_version":"mixed_layer_topology_certificate.v1","certificate_status":"accepted",
            "requested_sweep_direction":"z","resolved_sweep_direction":"z",
            "requested_layer_count":1,"realized_layer_count":1,
            "magnetic_plane_coordinates_m":[-1.0,1.0],"plane_tolerance_m":2e-8,
            "transition_shell_thickness_m":1.0,"transition_shell_interface_tri3_count":1,
            "interface_marker":2,"outer_boundary_marker":3,
            "magnetic_bounds_min_m":[-1.0,-1.0,-1.0],"magnetic_bounds_max_m":[1.0,1.0,1.0],
            "airbox_bounds_min_m":[-2.0,-2.0,-2.0],"airbox_bounds_max_m":[2.0,2.0,2.0],
            "magnetic_bounds_relative_error":0.0,"airbox_bounds_relative_error":0.0,
            "cell_family_counts_by_marker":{"0":{"pyramid5":4,"tet4":8},"1":{"prism6":2}},
            "cell_family_counts_by_part":{"far_air":{"tet4":4},"magnetic":{"prism6":2},"transition_air":{"pyramid5":4,"tet4":4}},
            "facet_family_counts_by_role_marker":{"exterior:3":{"tri3":38},"material_interface:2":{"quad4":4,"tri3":4}},
            "jacobian_minima_m3_by_family":{"prism6":3.999999999999999,"pyramid5":0.20779754131836622,"tet4":4.0},
            "quality_metric":"tetra_decomposition_scaled_jacobian.v1",
            "scaled_jacobian_minima_by_family":{"prism6":0.4082482904638629,"pyramid5":0.40824829046386296,"tet4":0.40824829046386296},
            "scaled_jacobian_p05_by_family":{"prism6":0.4311862178478971,"pyramid5":0.40824829046386296,"tet4":0.40824829046386296},
            "magnetic_volume_m3":8.0,"expected_magnetic_volume_m3":8.0,"magnetic_relative_volume_error":0.0,
            "air_volume_m3":56.0,"shared_domain_volume_m3":64.0,"expected_shared_domain_volume_m3":64.0,
            "shared_domain_relative_volume_error":0.0,"marker_coverage_complete":true,
            "nonconforming_face_count":0,"orphan_face_count":0,"nonmanifold_face_count":0,"coincident_interface_face_count":0,
            "topology_fingerprint_version":"v2","topology_fingerprint":"placeholder","gmsh_version":"4.15.2",
            "strategy":"shared_geo_extrusion_partitioned_pyramid_tet.v2","effective_gmsh_thread_count":1,
            "deterministic_inputs":{"algorithm_2d":6,"algorithm_3d":1,"element_order":1,"gmsh_version":"4.15.2",
              "random_factor":0.0,"thread_count":1,"transition_partition":"cartesian_3x3x3_minus_magnetic_center",
              "transition_volume_count":26,"pyramid_apex_optimizer":"bounded_per_apex_outward_scale_line_search",
              "pyramid_apex_scale_step":0.001,"pyramid_apex_scale_max":1.25,"scaled_jacobian_p05_min":0.1},
            "fallbacks_triggered":[]
        }"#).unwrap();
        certificate["topology_fingerprint"] = serde_json::json!(mesh.topology_fingerprint_v6());
        payload["mixed_layer_topology_certificate"] = certificate.clone();
        payload["mesh_provenance"] = serde_json::json!({
            "shared_domain_build_report": {
                "build_mode": "shared_domain",
                "mixed_layer_topology_certificate": certificate
            }
        });
        payload
    }

    #[test]
    fn syntax_check_python_args_do_not_import_fullmag_runtime_helper() {
        let args = syntax_check_python_args(Path::new("example.py"));

        assert_eq!(args.first().map(String::as_str), Some("-c"));
        assert!(args.iter().any(|arg| arg == "example.py"));
        assert!(!args
            .iter()
            .any(|arg| arg.contains("fullmag.runtime.helper")));
    }

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
                assert_eq!(fem_mesh.facet_count(), 1);
                assert!(fem_mesh.cells.is_empty());
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
                percent: None,
                label: "accepted",
            })
        );
        assert_eq!(
            map_remesh_progress_message("Gmsh: importing STL surface"),
            Some(RemeshTerminalProgress {
                percent: None,
                label: "importing STL surface",
            })
        );
        assert_eq!(
            map_remesh_progress_message("Gmsh: applying mesh options"),
            Some(RemeshTerminalProgress {
                percent: None,
                label: "configuring mesh fields",
            })
        );
        assert_eq!(
            map_remesh_progress_message("Gmsh: generating 3D tetrahedral mesh"),
            Some(RemeshTerminalProgress {
                percent: None,
                label: "generating 3D mesh",
            })
        );
        assert_eq!(
            map_remesh_progress_message("Gmsh: extracting quality metrics"),
            Some(RemeshTerminalProgress {
                percent: None,
                label: "extracting quality metrics",
            })
        );
        assert_eq!(
            map_remesh_progress_message("Gmsh: mesh ready - 100 nodes, 200 elements"),
            Some(RemeshTerminalProgress {
                percent: Some(100),
                label: "mesh ready",
            })
        );
        assert_eq!(
            map_remesh_progress_message("Gmsh: [ 40%] Meshing surface 3 (Plane, Frontal-Delaunay)"),
            Some(RemeshTerminalProgress {
                percent: None,
                label: "meshing surfaces",
            })
        );
        assert_eq!(
            map_remesh_progress_message("Gmsh: [ 70%] Meshing curve 9 (Line)"),
            Some(RemeshTerminalProgress {
                percent: None,
                label: "meshing curves",
            })
        );
        assert_eq!(
            map_remesh_progress_message(
                "Gmsh: meshing in progress ~75% (generating 3D mesh; 85.7s elapsed; last: Tetrahedrizing 737 nodes...)"
            ),
            Some(RemeshTerminalProgress {
                percent: None,
                label: "generating 3D mesh",
            })
        );
        assert_eq!(
            map_remesh_progress_message(
                "Gmsh: meshing active (generating 3D mesh; 85.7s elapsed; no detailed backend update for 12.3s)"
            ),
            Some(RemeshTerminalProgress {
                percent: None,
                label: "generating 3D mesh",
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
    fn structured_mesh_phases_map_to_canonical_preparation_updates() {
        assert_eq!(
            python_mesh_preparation_update(
                "mesh_build_phase",
                &serde_json::json!({
                    "phase": "preparing_domain",
                    "message": "Preparing shared-domain inputs",
                }),
            )
            .map(|update| update.stage_id()),
            Some(PreparationStageId::DomainPreparation)
        );
        assert_eq!(
            python_mesh_preparation_update(
                "mesh_build_phase",
                &serde_json::json!({
                    "phase": "meshing",
                    "progress_percent": 63,
                    "progress_label": "142580 / 226318 elements",
                }),
            ),
            Some(PythonMeshPreparationUpdate::StageProgress {
                stage_id: PreparationStageId::Meshing,
                detail: "Meshing the shared domain".to_string(),
                progress_percent: Some(63),
                progress_label: Some("142580 / 226318 elements".to_string()),
            })
        );
        assert_eq!(
            python_mesh_preparation_update(
                "mesh_build_phase",
                &serde_json::json!({"phase": "postprocessing"}),
            )
            .map(|update| update.stage_id()),
            Some(PreparationStageId::MeshPostprocessing)
        );
        assert_eq!(
            python_mesh_preparation_update(
                "mesh_build_summary",
                &serde_json::json!({"message": "Shared-domain mesh build finished"}),
            ),
            Some(PythonMeshPreparationUpdate::Completed {
                detail: "Shared-domain mesh preparation complete".to_string(),
            })
        );
    }

    #[test]
    fn structured_mesh_failure_does_not_project_raw_error_text() {
        assert_eq!(
            python_mesh_preparation_update(
                "mesh_build_failed",
                &serde_json::json!({
                    "phase": "meshing",
                    "message": "Shared-domain mesh build failed",
                    "error": "raw mesher stderr with /private/model/path",
                }),
            ),
            Some(PythonMeshPreparationUpdate::Failed {
                stage_id: PreparationStageId::Meshing,
                summary: "Shared-domain mesh build failed".to_string(),
            })
        );
    }

    #[test]
    fn structured_mesh_preparation_drops_out_of_range_percentages() {
        for invalid_percent in [101, 500] {
            let update = python_mesh_preparation_update(
                "mesh_build_phase",
                &serde_json::json!({
                    "phase": "meshing",
                    "progress_percent": invalid_percent,
                }),
            )
            .expect("known mesh phase");
            let PythonMeshPreparationUpdate::StageProgress {
                progress_percent, ..
            } = update
            else {
                panic!("meshing phase should map to progress")
            };
            assert_eq!(progress_percent, None);
        }
    }

    #[test]
    fn structured_mesh_preparation_sanitizes_and_bounds_payload_text() {
        let path_like = python_mesh_preparation_update(
            "mesh_build_phase",
            &serde_json::json!({
                "phase": "meshing",
                "message": "reading /private/model/mesh.msh",
                "progress_percent": 7,
                "progress_label": "/private/model/mesh.msh",
            }),
        )
        .expect("known mesh phase");
        assert_eq!(
            path_like,
            PythonMeshPreparationUpdate::StageProgress {
                stage_id: PreparationStageId::Meshing,
                detail: "Meshing the shared domain".to_string(),
                progress_percent: Some(7),
                progress_label: None,
            }
        );

        let oversized_label = "element".repeat(100);
        let bounded = python_mesh_preparation_update(
            "mesh_build_phase",
            &serde_json::json!({
                "phase": "meshing",
                "progress_label": oversized_label,
            }),
        )
        .expect("known mesh phase");
        let PythonMeshPreparationUpdate::StageProgress {
            progress_label: Some(progress_label),
            ..
        } = bounded
        else {
            panic!("safe oversized labels should be bounded")
        };
        assert!(progress_label.chars().count() <= MAX_PREPARATION_PROGRESS_LABEL_CHARS);

        assert_eq!(
            python_mesh_preparation_update(
                "mesh_build_summary",
                &serde_json::json!({
                    "message": "mesh written to /private/model/mesh.msh",
                }),
            ),
            Some(PythonMeshPreparationUpdate::Completed {
                detail: "Shared-domain mesh preparation complete".to_string(),
            })
        );
    }

    #[test]
    fn filter_non_progress_stderr_strips_progress_lines() {
        let stderr = "[fullmag-progress] Remesh: accepted\nplain error\n[fullmag-progress] Gmsh: mesh ready\n";
        assert_eq!(filter_non_progress_stderr(stderr), "plain error");
    }

    #[test]
    fn parse_remesh_cli_response_loads_topology_artifact() {
        let artifact_path = std::env::temp_dir().join(format!(
            "fullmag-remesh-topology-artifact-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(
            &artifact_path,
            serde_json::json!({
                "mesh_name": "large_mesh",
                "nodes": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
                "cell_types": ["tet4"],
                "cell_offsets": [0, 4],
                "cell_nodes": [0, 1, 2, 3],
                "cell_global_ordinals": [0],
                "cell_mesh_parts": ["magnetic"],
                "element_markers": [7],
                "facet_types": ["tri3"],
                "facet_roles": ["exterior"],
                "facet_offsets": [0, 3],
                "facet_nodes": [0, 1, 2],
                "facet_global_ordinals": [0],
                "boundary_markers": [11],
                "periodic_boundary_pairs": [],
                "periodic_node_pairs": [],
                "periodic_mesh_certificate": {
                    "schema_version": "periodic_mesh_certificate.v6",
                    "certificate_status": "accepted",
                    "topology_fingerprint": "sha256:test"
                }
            })
            .to_string(),
        )
        .unwrap();
        let stdout = serde_json::json!({
            "mesh_name": "large_mesh",
            "nodes": [],
            "elements": [],
            "element_markers": [],
            "boundary_faces": [],
            "boundary_markers": [],
            "topology_artifact": {
                "path": artifact_path
            },
            "quality": null
        })
        .to_string();

        let parsed = parse_remesh_cli_response(stdout.as_bytes(), "test remesh output").unwrap();

        assert_eq!(parsed.nodes.len(), 4);
        assert_eq!(parsed.cells.require_tet4().unwrap(), vec![[0, 1, 2, 3]]);
        assert_eq!(
            parsed.cells.mesh_parts,
            vec![fullmag_ir::FemCellMeshPartIR::Magnetic]
        );
        assert_eq!(parsed.element_markers, vec![7]);
        assert_eq!(parsed.facets.require_tri3().unwrap(), vec![[0, 1, 2]]);
        assert_eq!(parsed.boundary_markers, vec![11]);
        assert_eq!(
            parsed
                .periodic_mesh_certificate
                .as_ref()
                .and_then(|value| value.get("topology_fingerprint")),
            Some(&serde_json::json!("sha256:test"))
        );
        let _ = std::fs::remove_file(artifact_path);
    }

    #[test]
    fn parse_remesh_cli_response_accepts_v2_mixed_topology_and_rejects_dual_encoding() {
        let mut payload = serde_json::json!({
            "mesh_name": "mixed_mesh",
            "nodes": [
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [1.0, 1.0, 0.0],
                [1.0, 0.0, 1.0],
                [0.0, 1.0, 1.0],
                [1.0, 1.0, 1.0]
            ],
            "cell_types": ["tet4", "prism6"],
            "cell_offsets": [0, 4, 10],
            "cell_nodes": [0, 1, 2, 3, 0, 1, 2, 4, 5, 6],
            "cell_mesh_parts": ["magnetic", "transition_air"],
            "element_markers": [1, 2],
            "facet_types": ["tri3", "quad4"],
            "facet_roles": ["exterior", "material_interface"],
            "facet_offsets": [0, 3, 7],
            "facet_nodes": [0, 1, 2, 0, 1, 5, 4],
            "boundary_markers": [7, 8],
            "quality": null
        });
        let parsed =
            parse_remesh_cli_response(payload.to_string().as_bytes(), "mixed remesh output")
                .unwrap();
        assert_eq!(
            parsed.cells.types,
            vec![
                fullmag_ir::FemCellTypeIR::Tet4,
                fullmag_ir::FemCellTypeIR::Prism6
            ]
        );
        assert_eq!(
            parsed.facets.types,
            vec![
                fullmag_ir::FemFacetTypeIR::Tri3,
                fullmag_ir::FemFacetTypeIR::Quad4
            ]
        );
        assert_eq!(
            serde_json::to_value(&parsed.cells).unwrap()["mesh_parts"],
            serde_json::json!(["magnetic", "transition_air"])
        );
        assert_eq!(
            serde_json::to_value(&parsed.clone().into_mesh_ir()).unwrap()["cells"]["mesh_parts"],
            serde_json::json!(["magnetic", "transition_air"])
        );

        payload
            .as_object_mut()
            .unwrap()
            .insert("elements".to_string(), serde_json::json!([[0, 1, 2, 3]]));
        let error = parse_remesh_cli_response(payload.to_string().as_bytes(), "dual remesh output")
            .unwrap_err();
        assert!(format!("{error:#}").contains("both legacy and v2 topology"));
    }

    #[test]
    fn mixed_wire_preserves_typed_report_and_rejects_top_level_only() {
        let payload = valid_mixed_remesh_payload();
        let parsed = parse_remesh_cli_response(
            payload.to_string().as_bytes(),
            "qualified mixed remesh output",
        )
        .unwrap();
        assert!(parsed
            .shared_domain_build_report
            .as_ref()
            .and_then(|report| report.mixed_layer_topology_certificate.as_ref())
            .is_some());
        assert!(parsed
            .mesh_provenance
            .as_ref()
            .and_then(|value| value.get("shared_domain_build_report"))
            .and_then(|value| value.get("mixed_layer_topology_certificate"))
            .is_some());
        assert_eq!(parsed.clone().into_mesh_ir().cells.mesh_parts.len(), 14);

        let mut top_level_only = payload;
        top_level_only
            .as_object_mut()
            .unwrap()
            .remove("mesh_provenance");
        let error = parse_remesh_cli_response(
            top_level_only.to_string().as_bytes(),
            "top-level-only mixed remesh output",
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("shared-domain build report"));
    }

    #[test]
    fn mixed_wire_hydrates_artifact_certificate_into_typed_report() {
        let payload = valid_mixed_remesh_payload();
        let artifact_path = std::env::temp_dir().join(format!(
            "fullmag-mixed-topology-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut artifact = payload.clone();
        artifact.as_object_mut().unwrap().remove("mesh_provenance");
        artifact.as_object_mut().unwrap().remove("quality");
        std::fs::write(&artifact_path, artifact.to_string()).unwrap();
        let stdout = serde_json::json!({
            "mesh_name": "qualified_mixed",
            "nodes": [], "elements": [], "element_markers": [],
            "boundary_faces": [], "boundary_markers": [], "quality": null,
            "mesh_provenance": {"shared_domain_build_report": {"build_mode": "shared_domain"}},
            "topology_artifact": {"path": artifact_path}
        });

        let parsed = parse_remesh_cli_response(
            stdout.to_string().as_bytes(),
            "artifact mixed remesh output",
        )
        .unwrap();
        assert_eq!(parsed.cells.mesh_parts.len(), 14);
        assert!(parsed
            .shared_domain_build_report
            .as_ref()
            .and_then(|report| report.mixed_layer_topology_certificate.as_ref())
            .is_some());
        assert!(parsed
            .mesh_provenance
            .as_ref()
            .and_then(|value| value.get("shared_domain_build_report"))
            .and_then(|value| value.get("mixed_layer_topology_certificate"))
            .is_some());
        let _ = std::fs::remove_file(artifact_path);
    }

    #[test]
    fn mixed_wire_rejects_conflicting_inline_and_artifact_certificates() {
        let payload = valid_mixed_remesh_payload();
        let artifact_path = std::env::temp_dir().join(format!(
            "fullmag-conflicting-mixed-topology-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut artifact = payload.clone();
        artifact.as_object_mut().unwrap().remove("mesh_provenance");
        artifact.as_object_mut().unwrap().remove("quality");
        artifact["mixed_layer_topology_certificate"]["plane_tolerance_m"] =
            serde_json::json!(2.0e-12);
        std::fs::write(&artifact_path, artifact.to_string()).unwrap();
        let stdout = serde_json::json!({
            "mesh_name": "qualified_mixed",
            "nodes": [], "elements": [], "element_markers": [],
            "boundary_faces": [], "boundary_markers": [], "quality": null,
            "mixed_layer_topology_certificate": payload["mixed_layer_topology_certificate"].clone(),
            "mesh_provenance": {"shared_domain_build_report": {"build_mode": "shared_domain"}},
            "topology_artifact": {"path": artifact_path}
        });

        let result = parse_remesh_cli_response(
            stdout.to_string().as_bytes(),
            "conflicting artifact mixed remesh output",
        );
        let _ = std::fs::remove_file(artifact_path);
        let error = result.expect_err("conflicting inline and artifact certificates must fail");

        assert!(format!("{error:#}").contains("differs"));
    }

    #[test]
    fn mixed_wire_rejects_artifact_missing_inline_and_report_certificate() {
        let payload = valid_mixed_remesh_payload();
        let artifact_path = std::env::temp_dir().join(format!(
            "fullmag-missing-mixed-certificate-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut artifact = payload.clone();
        artifact.as_object_mut().unwrap().remove("mesh_provenance");
        artifact.as_object_mut().unwrap().remove("quality");
        artifact
            .as_object_mut()
            .unwrap()
            .remove("mixed_layer_topology_certificate");
        std::fs::write(&artifact_path, artifact.to_string()).unwrap();
        let stdout = serde_json::json!({
            "mesh_name": "qualified_mixed",
            "nodes": [], "elements": [], "element_markers": [],
            "boundary_faces": [], "boundary_markers": [], "quality": null,
            "mixed_layer_topology_certificate": payload["mixed_layer_topology_certificate"].clone(),
            "mesh_provenance": payload["mesh_provenance"].clone(),
            "topology_artifact": {"path": artifact_path}
        });

        let result = parse_remesh_cli_response(
            stdout.to_string().as_bytes(),
            "missing artifact mixed certificate output",
        );
        let _ = std::fs::remove_file(artifact_path);
        let error = result.expect_err(
            "artifact must not omit a certificate carried by inline topology and build report",
        );

        assert!(format!("{error:#}")
            .contains("topology artifact is missing a mixed layer topology certificate"));
    }

    #[test]
    fn mixed_wire_rejects_mismatched_topology_and_report_certificates() {
        let mut payload = valid_mixed_remesh_payload();
        payload["mixed_layer_topology_certificate"]["topology_fingerprint"] =
            serde_json::json!(format!("sha256:{}", "0".repeat(64)));
        let error = parse_remesh_cli_response(
            payload.to_string().as_bytes(),
            "mismatched mixed remesh output",
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("differs"));
    }

    #[test]
    fn parse_remesh_cli_response_preserves_quality_data_artifact() {
        let stdout = serde_json::json!({
            "mesh_name": "quality_mesh",
            "nodes": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            "elements": [[0, 1, 2, 3]],
            "element_markers": [1],
            "boundary_faces": [[0, 1, 2]],
            "boundary_markers": [7],
            "quality": null,
            "quality_data_artifact": {
                "kind": "fmmq.v1",
                "schema_version": 1,
                "path": "/tmp/fullmag-quality.fmmq",
                "byte_size": 56,
                "element_count": 1,
                "metrics": ["sicn", "gamma", "volume"]
            }
        })
        .to_string();

        let parsed = parse_remesh_cli_response(stdout.as_bytes(), "test remesh output").unwrap();
        let artifact = parsed
            .quality_data_artifact
            .expect("quality data artifact metadata should survive parsing");

        assert_eq!(artifact.kind, "fmmq.v1");
        assert_eq!(artifact.element_count, 1);
        assert_eq!(artifact.metrics, vec!["sicn", "gamma", "volume"]);
    }

    #[test]
    fn parse_remesh_cli_response_preserves_fresh_object_region_markers() {
        let stdout = serde_json::json!({
            "mesh_name": "shared_mesh",
            "nodes": [],
            "elements": [],
            "element_markers": [],
            "boundary_faces": [],
            "boundary_markers": [],
            "quality": null,
            "object_region_markers": [{"geometry_name": "film:core", "marker": 2}]
        })
        .to_string();

        let parsed = parse_remesh_cli_response(stdout.as_bytes(), "test remesh output").unwrap();
        assert_eq!(
            parsed.object_region_markers,
            vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "film:core".to_string(),
                marker: 2,
            }]
        );
    }
}
