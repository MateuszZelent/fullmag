//! Public and internal types for the runner.

use fullmag_ir::{FemMeshPartRole, FemMeshPartSelector, MeshQualityIR, StageCompletionIR};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::AtomicBool;
use uuid::Uuid;

// ----- public types -----

/// Public result type returned by [`crate::run_reference_fem_eigen`].
///
/// Contains the solver status and all artifact files (spectrum, modes) written
/// during the eigenmode solve.  Artifact bytes are the raw JSON content.
#[derive(Debug, Clone)]
pub struct FemEigenRunResult {
    /// Whether the solve completed successfully.
    pub status: RunStatus,
    /// Artifact files produced by the solver.
    /// Each entry is `(relative_path, bytes)`, e.g.
    /// `("eigen/spectrum.json", ...)` or `("eigen/modes/mode_0000.json", ...)`.
    pub artifacts: Vec<(String, Vec<u8>)>,
}

impl FemEigenRunResult {
    /// Return the bytes of the artifact at `relative_path`, if present.
    pub fn artifact_bytes(&self, relative_path: &str) -> Option<&[u8]> {
        self.artifacts
            .iter()
            .find(|(p, _)| p == relative_path)
            .map(|(_, b)| b.as_slice())
    }

    /// Parse the spectrum artifact as JSON and return all mode frequencies in Hz.
    pub fn spectrum_frequencies_hz(&self) -> Vec<f64> {
        let bytes = match self.artifact_bytes("eigen/spectrum.json") {
            Some(b) => b,
            None => return vec![],
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
            return vec![];
        };
        value["modes"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m.get("frequency_hz").and_then(|f| f.as_f64()))
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunResult {
    pub status: RunStatus,
    pub steps: Vec<StepStats>,
    pub final_magnetization: Vec<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion: Option<StageCompletionIR>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Completed,
    Failed,
    Cancelled,
    /// The solver paused cleanly (user-requested). The runtime state is
    /// preserved and can be resumed.
    Paused,
}

/// Returned by the `on_step` callback to signal whether the runner should continue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepAction {
    /// Continue the simulation.
    Continue,
    /// Stop the simulation as soon as possible (user-requested cancellation).
    Stop,
    /// Pause the simulation cleanly — preserve runtime state for resume.
    Pause,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(non_snake_case)]
pub struct StepStats {
    pub step: u64,
    pub time: f64,
    pub dt: f64,
    pub mx: f64,
    pub my: f64,
    pub mz: f64,
    pub e_ex: f64,
    pub e_demag: f64,
    pub e_ext: f64,
    pub e_ani: f64,
    pub e_dmi: f64,
    pub e_total: f64,
    pub max_dm_dt: f64,
    pub max_h_eff: f64,
    pub max_h_demag: f64,
    /// Native max |m × H_eff| torque metric in A/m.
    #[serde(default)]
    pub max_torque_Apm: f64,
    /// max |m × B_eff| = μ₀ · max_torque_Apm, in Tesla.
    /// Comparable to mumax MaxTorque.
    #[serde(default)]
    pub max_torque_T: f64,
    pub wall_time_ns: u64,
    #[serde(default)]
    pub exchange_wall_time_ns: u64,
    #[serde(default)]
    pub demag_wall_time_ns: u64,
    #[serde(default)]
    pub rhs_wall_time_ns: u64,
    #[serde(default)]
    pub extra_energy_wall_time_ns: u64,
    #[serde(default)]
    pub snapshot_wall_time_ns: u64,
    /// Wall-clock time spent on active preview field extraction (ns).
    #[serde(default)]
    pub preview_wall_time_ns: u64,
    /// Wall-clock time spent on cached (non-active) preview field copies (ns).
    #[serde(default)]
    pub cached_preview_wall_time_ns: u64,
    // --- adaptive time-stepping diagnostics (PR1) ---
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_estimate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dt_suggested: Option<f64>,
    #[serde(default)]
    pub rejected_attempts: u32,
    #[serde(default)]
    pub rhs_evals: u32,
    #[serde(default)]
    pub demag_solves: u32,
    #[serde(default)]
    pub fsal_reused: bool,
    /// Number of PCG iterations in the last Poisson demag solve.
    #[serde(default)]
    pub poisson_iterations: u32,
    /// Final residual norm of the last Poisson demag solve.
    #[serde(default)]
    pub poisson_final_residual: f64,
    /// Whether demag was refreshed (true) or used frozen field (false) this step.
    #[serde(default)]
    pub demag_refreshed: bool,
    /// FEM requested OMP thread count (from C++ context, constant per run).
    #[serde(default)]
    pub requested_fem_omp_threads: i32,
    /// FEM effective OMP thread count (after auto-capping, constant per run).
    #[serde(default)]
    pub effective_fem_omp_threads: i32,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub per_object_scalars: HashMap<String, HashMap<String, f64>>,
}

impl Default for StepStats {
    fn default() -> Self {
        Self {
            step: 0,
            time: 0.0,
            dt: 0.0,
            mx: 0.0,
            my: 0.0,
            mz: 0.0,
            e_ex: 0.0,
            e_demag: 0.0,
            e_ext: 0.0,
            e_ani: 0.0,
            e_dmi: 0.0,
            e_total: 0.0,
            max_dm_dt: 0.0,
            max_h_eff: 0.0,
            max_h_demag: 0.0,
            max_torque_Apm: 0.0,
            max_torque_T: 0.0,
            wall_time_ns: 0,
            exchange_wall_time_ns: 0,
            demag_wall_time_ns: 0,
            rhs_wall_time_ns: 0,
            extra_energy_wall_time_ns: 0,
            snapshot_wall_time_ns: 0,
            preview_wall_time_ns: 0,
            cached_preview_wall_time_ns: 0,
            error_estimate: None,
            dt_suggested: None,
            rejected_attempts: 0,
            rhs_evals: 0,
            demag_solves: 0,
            fsal_reused: false,
            poisson_iterations: 0,
            poisson_final_residual: 0.0,
            demag_refreshed: false,
            requested_fem_omp_threads: 0,
            effective_fem_omp_threads: 0,
            per_object_scalars: HashMap::new(),
        }
    }
}

impl StepStats {
    /// Extract solver diagnostics (non-physics telemetry).
    pub fn to_diagnostics(&self) -> fullmag_quantities::StepDiagnostics {
        fullmag_quantities::StepDiagnostics {
            step: self.step,
            time: self.time,
            dt: self.dt,
            wall_time_ns: self.wall_time_ns,
            exchange_wall_time_ns: self.exchange_wall_time_ns,
            demag_wall_time_ns: self.demag_wall_time_ns,
            rhs_wall_time_ns: self.rhs_wall_time_ns,
            extra_energy_wall_time_ns: self.extra_energy_wall_time_ns,
            snapshot_wall_time_ns: self.snapshot_wall_time_ns,
            error_estimate: self.error_estimate,
            dt_suggested: self.dt_suggested,
            rejected_attempts: self.rejected_attempts,
            rhs_evals: self.rhs_evals,
            demag_solves: self.demag_solves,
            fsal_reused: self.fsal_reused,
            poisson_iterations: self.poisson_iterations,
            poisson_final_residual: self.poisson_final_residual,
            demag_refreshed: self.demag_refreshed,
        }
    }

    /// Extract per-step physical scalar observations.
    pub fn to_quantity_row(&self) -> fullmag_quantities::GlobalQuantityRow {
        fullmag_quantities::GlobalQuantityRow {
            step: self.step,
            time: self.time,
            mx: self.mx,
            my: self.my,
            mz: self.mz,
            e_ex: self.e_ex,
            e_demag: self.e_demag,
            e_ext: self.e_ext,
            e_ani: self.e_ani,
            e_dmi: self.e_dmi,
            e_total: self.e_total,
            max_dm_dt: self.max_dm_dt,
            max_h_eff: self.max_h_eff,
            max_h_demag: self.max_h_demag,
            max_torque_Apm: self.max_torque_Apm,
            max_torque_T: self.max_torque_T,
            per_object_scalars: self.per_object_scalars.clone(),
        }
    }
}

/// Lightweight update emitted by the runner for live WebSocket streaming.
/// Contains step stats plus optional field snapshot for 3D preview.
///
/// **Migration note (Q16/Q17):** The canonical wire format for external
/// consumers is [`fullmag_quantities::StepUpdateV2`].  Use [`Self::to_v2()`]
/// to convert.  The legacy fields `magnetization`, `preview_field`, and
/// `cached_preview_fields` are retained for the internal runner→CLI callback
/// contract but should not be serialized to new external consumers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepUpdate {
    pub stats: StepStats,
    /// Grid dimensions [nx, ny, nz] for client-side reconstruction.
    pub grid: [u32; 3],
    /// Optional FEM mesh payload for mesh-native preview in the control room.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_mesh: Option<FemMeshPayload>,
    /// **Deprecated (Q16):** Use [`fullmag_quantities::LiveQuantityFrame`]
    /// with `quantity_id = "m"` via [`Self::to_v2()`] instead.
    ///
    /// Magnetization snapshot as flat \[mx,my,mz, mx,my,mz, ...\].
    /// Sent periodically (not every step) to limit bandwidth.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub magnetization: Option<Vec<f64>>,
    /// **Deprecated (Q17):** Use [`fullmag_quantities::LiveQuantityFrame`]
    /// via [`Self::to_v2()`] instead.
    ///
    /// Optional active preview field driven by the current UI preview request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_field: Option<LivePreviewField>,
    /// **Deprecated (Q17):** Use [`fullmag_quantities::LiveQuantityFrame`]
    /// via [`Self::to_v2()`] instead.
    ///
    /// Optional cached preview fields warmed in the background for instant
    /// quantity switching without waiting for a fresh live preview snapshot.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_preview_fields: Option<Vec<LivePreviewField>>,
    /// True when this update also represents a due scalar-row sample.
    #[serde(default)]
    pub scalar_row_due: bool,
    /// true when simulation has completed.
    #[serde(default)]
    pub finished: bool,
}

impl StepUpdate {
    /// Convert to the canonical V2 transport format.
    ///
    /// Extracts diagnostics and scalar row from `StepStats`, and wraps
    /// the optional magnetization + preview fields as `LiveQuantityFrame`s.
    pub fn to_v2(&self) -> fullmag_quantities::StepUpdateV2 {
        let mut frames = Vec::new();

        // Magnetization → LiveQuantityFrame
        if let Some(ref mag) = self.magnetization {
            frames.push(fullmag_quantities::LiveQuantityFrame {
                quantity_id: "m".to_string(),
                unit: fullmag_quantities::quantity_unit("m").to_string(),
                grid: self.grid,
                n_comp: fullmag_quantities::quantity_spec("m")
                    .map(|spec| spec.n_comp)
                    .unwrap_or(3),
                values: mag.clone(),
                active_mask: None,
            });
        }

        // Active preview field → LiveQuantityFrame
        if let Some(ref pf) = self.preview_field {
            frames.push(fullmag_quantities::LiveQuantityFrame {
                quantity_id: pf.quantity.clone(),
                unit: fullmag_quantities::quantity_unit(&pf.quantity).to_string(),
                grid: pf.preview_grid,
                n_comp: fullmag_quantities::quantity_spec(&pf.quantity)
                    .map(|spec| spec.n_comp)
                    .unwrap_or(3),
                values: pf.vector_field_values.clone(),
                active_mask: pf.active_mask.clone(),
            });
        }

        // Cached preview fields → LiveQuantityFrame each
        if let Some(ref cached) = self.cached_preview_fields {
            for cf in cached {
                frames.push(fullmag_quantities::LiveQuantityFrame {
                    quantity_id: cf.quantity.clone(),
                    unit: fullmag_quantities::quantity_unit(&cf.quantity).to_string(),
                    grid: cf.preview_grid,
                    n_comp: fullmag_quantities::quantity_spec(&cf.quantity)
                        .map(|spec| spec.n_comp)
                        .unwrap_or(3),
                    values: cf.vector_field_values.clone(),
                    active_mask: cf.active_mask.clone(),
                });
            }
        }

        fullmag_quantities::StepUpdateV2 {
            diagnostics: self.stats.to_diagnostics(),
            scalars: self.stats.to_quantity_row(),
            frames,
            finished: self.finished,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LivePreviewRequest {
    #[serde(default)]
    pub revision: u64,
    pub quantity: String,
    pub component: String,
    pub layer: u32,
    pub all_layers: bool,
    #[serde(default = "default_preview_every_n")]
    pub every_n: u32,
    pub x_chosen_size: u32,
    pub y_chosen_size: u32,
    pub auto_scale_enabled: bool,
    pub max_points: u32,
}

const fn default_preview_every_n() -> u32 {
    50
}

impl Default for LivePreviewRequest {
    fn default() -> Self {
        Self {
            revision: 0,
            quantity: "m".to_string(),
            component: "3D".to_string(),
            layer: 0,
            all_layers: false,
            every_n: default_preview_every_n(),
            x_chosen_size: 0,
            y_chosen_size: 0,
            auto_scale_enabled: true,
            max_points: 16_384,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LivePreviewField {
    pub config_revision: u64,
    pub quantity: String,
    pub unit: String,
    pub spatial_kind: String,
    pub quantity_domain: String,
    pub preview_grid: [u32; 3],
    pub original_grid: [u32; 3],
    pub vector_field_values: Vec<f64>,
    pub x_chosen_size: u32,
    pub y_chosen_size: u32,
    pub applied_x_chosen_size: u32,
    pub applied_y_chosen_size: u32,
    pub applied_layer_stride: u32,
    pub auto_downscaled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_downscale_message: Option<String>,
    /// Per-preview-cell boolean mask: `true` = geometry-active, `false` = empty.
    /// Resampled to match `preview_grid` dimensions (a preview cell is active if
    /// ANY original cell in its block is active).  `None` means all cells active.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_mask: Option<Vec<bool>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveVectorFieldSnapshot {
    pub quantity: String,
    pub grid: [u32; 3],
    pub values: Vec<[f64; 3]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FemMeshObjectSegment {
    pub object_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geometry_id: Option<String>,
    pub node_start: u32,
    pub node_count: u32,
    pub element_start: u32,
    pub element_count: u32,
    pub boundary_face_start: u32,
    pub boundary_face_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FemMeshPartPayload {
    pub id: String,
    pub label: String,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geometry_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub material_id: Option<String>,
    pub element_start: u32,
    pub element_count: u32,
    pub boundary_face_start: u32,
    pub boundary_face_count: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub boundary_face_indices: Vec<u32>,
    pub node_start: u32,
    pub node_count: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub node_indices: Vec<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub surface_faces: Vec<[u32; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds_min: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds_max: Option<[f64; 3]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshQualityPayload {
    pub n_elements: u32,
    pub sicn_min: f64,
    pub sicn_max: f64,
    pub sicn_mean: f64,
    pub sicn_p5: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sicn_histogram: Vec<u32>,
    pub gamma_min: f64,
    pub gamma_mean: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gamma_histogram: Vec<u32>,
    pub volume_min: f64,
    pub volume_max: f64,
    pub volume_mean: f64,
    pub volume_std: f64,
    pub avg_quality: f64,
}

impl From<&MeshQualityIR> for MeshQualityPayload {
    fn from(q: &MeshQualityIR) -> Self {
        Self {
            n_elements: q.n_elements,
            sicn_min: q.sicn_min,
            sicn_max: q.sicn_max,
            sicn_mean: q.sicn_mean,
            sicn_p5: q.sicn_p5,
            sicn_histogram: q.sicn_histogram.clone(),
            gamma_min: q.gamma_min,
            gamma_mean: q.gamma_mean,
            gamma_histogram: q.gamma_histogram.clone(),
            volume_min: q.volume_min,
            volume_max: q.volume_max,
            volume_mean: q.volume_mean,
            volume_std: q.volume_std,
            avg_quality: q.avg_quality,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FemMeshPayload {
    pub mesh_name: String,
    pub mesh_id: String,
    pub nodes: Vec<[f64; 3]>,
    pub elements: Vec<[u32; 4]>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub element_markers: Vec<u32>,
    pub boundary_faces: Vec<[u32; 3]>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub boundary_markers: Vec<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub periodic_boundary_pairs: Vec<fullmag_ir::MeshPeriodicBoundaryPairIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub periodic_node_pairs: Vec<fullmag_ir::MeshPeriodicNodePairIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub object_segments: Vec<FemMeshObjectSegment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mesh_parts: Vec<FemMeshPartPayload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain_mesh_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain_frame: Option<fullmag_ir::DomainFrameIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation_id: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub per_domain_quality: HashMap<u32, MeshQualityPayload>,
}

fn normalized_payload_element_markers(
    element_markers: &[u32],
    magnetic_markers: Option<&BTreeSet<u32>>,
) -> Vec<u32> {
    if element_markers.is_empty() {
        return Vec::new();
    }

    if let Some(magnetic_markers) = magnetic_markers {
        return element_markers
            .iter()
            .map(|marker| u32::from(magnetic_markers.contains(marker)))
            .collect();
    }

    let has_air = element_markers.contains(&0);
    let has_magnetic = element_markers.iter().any(|marker| *marker != 0);
    if has_air && has_magnetic {
        element_markers
            .iter()
            .map(|marker| u32::from(*marker != 0))
            .collect()
    } else if element_markers
        .first()
        .is_some_and(|first| element_markers.iter().all(|marker| marker == first))
    {
        vec![1; element_markers.len()]
    } else {
        element_markers.to_vec()
    }
}

impl From<&fullmag_ir::FemPlanIR> for FemMeshPayload {
    fn from(plan: &fullmag_ir::FemPlanIR) -> Self {
        let generation_id = Uuid::new_v4().to_string();
        let magnetic_markers = (!plan.region_materials.is_empty()).then(|| {
            plan.region_materials
                .iter()
                .map(|region| region.element_marker)
                .collect::<BTreeSet<_>>()
        });
        Self {
            mesh_name: plan.mesh.mesh_name.clone(),
            mesh_id: format!("{}:{}", plan.mesh.mesh_name, generation_id),
            nodes: plan.mesh.nodes.clone(),
            elements: plan.mesh.elements.clone(),
            element_markers: normalized_payload_element_markers(
                &plan.mesh.element_markers,
                magnetic_markers.as_ref(),
            ),
            boundary_faces: plan.mesh.boundary_faces.clone(),
            boundary_markers: plan.mesh.boundary_markers.clone(),
            periodic_boundary_pairs: plan.mesh.periodic_boundary_pairs.clone(),
            periodic_node_pairs: plan.mesh.periodic_node_pairs.clone(),
            object_segments: plan
                .object_segments
                .iter()
                .map(|segment| FemMeshObjectSegment {
                    object_id: segment.object_id.clone(),
                    geometry_id: segment.geometry_id.clone(),
                    node_start: segment.node_start,
                    node_count: segment.node_count,
                    element_start: segment.element_start,
                    element_count: segment.element_count,
                    boundary_face_start: segment.boundary_face_start,
                    boundary_face_count: segment.boundary_face_count,
                })
                .collect(),
            mesh_parts: plan
                .mesh_parts
                .iter()
                .map(FemMeshPartPayload::from)
                .collect(),
            domain_mesh_mode: Some(domain_mesh_mode_name(plan.domain_mesh_mode).to_string()),
            domain_frame: plan.domain_frame.clone(),
            generation_id: Some(generation_id),
            per_domain_quality: plan
                .mesh
                .per_domain_quality
                .iter()
                .map(|(k, v)| (*k, MeshQualityPayload::from(v)))
                .collect(),
        }
    }
}

impl From<&fullmag_ir::FemEigenPlanIR> for FemMeshPayload {
    fn from(plan: &fullmag_ir::FemEigenPlanIR) -> Self {
        let generation_id = Uuid::new_v4().to_string();
        Self {
            mesh_name: plan.mesh.mesh_name.clone(),
            mesh_id: format!("{}:{}", plan.mesh.mesh_name, generation_id),
            nodes: plan.mesh.nodes.clone(),
            elements: plan.mesh.elements.clone(),
            element_markers: normalized_payload_element_markers(&plan.mesh.element_markers, None),
            boundary_faces: plan.mesh.boundary_faces.clone(),
            boundary_markers: plan.mesh.boundary_markers.clone(),
            periodic_boundary_pairs: plan.mesh.periodic_boundary_pairs.clone(),
            periodic_node_pairs: plan.mesh.periodic_node_pairs.clone(),
            object_segments: plan
                .object_segments
                .iter()
                .map(|segment| FemMeshObjectSegment {
                    object_id: segment.object_id.clone(),
                    geometry_id: segment.geometry_id.clone(),
                    node_start: segment.node_start,
                    node_count: segment.node_count,
                    element_start: segment.element_start,
                    element_count: segment.element_count,
                    boundary_face_start: segment.boundary_face_start,
                    boundary_face_count: segment.boundary_face_count,
                })
                .collect(),
            mesh_parts: plan
                .mesh_parts
                .iter()
                .map(FemMeshPartPayload::from)
                .collect(),
            domain_mesh_mode: Some(domain_mesh_mode_name(plan.domain_mesh_mode).to_string()),
            domain_frame: plan.domain_frame.clone(),
            generation_id: Some(generation_id),
            per_domain_quality: plan
                .mesh
                .per_domain_quality
                .iter()
                .map(|(k, v)| (*k, MeshQualityPayload::from(v)))
                .collect(),
        }
    }
}

impl From<&fullmag_ir::FemMeshPartIR> for FemMeshPartPayload {
    fn from(part: &fullmag_ir::FemMeshPartIR) -> Self {
        Self {
            id: part.id.clone(),
            label: part.label.clone(),
            role: mesh_part_role_name(&part.role).to_string(),
            object_id: part.object_id.clone(),
            geometry_id: part.geometry_id.clone(),
            material_id: part.material_id.clone(),
            element_start: selector_start(&part.element_selector),
            element_count: selector_count(&part.element_selector),
            boundary_face_start: selector_start(&part.boundary_face_selector),
            boundary_face_count: selector_count(&part.boundary_face_selector),
            boundary_face_indices: part.boundary_face_indices.clone(),
            node_start: selector_start(&part.node_selector),
            node_count: selector_count(&part.node_selector),
            node_indices: part.node_indices.clone(),
            surface_faces: part.surface_faces.clone(),
            bounds_min: part.bounds_min,
            bounds_max: part.bounds_max,
        }
    }
}

fn selector_start(selector: &FemMeshPartSelector) -> u32 {
    match selector {
        FemMeshPartSelector::ElementRange { start, .. }
        | FemMeshPartSelector::BoundaryFaceRange { start, .. }
        | FemMeshPartSelector::NodeRange { start, .. } => *start,
        FemMeshPartSelector::ElementMarkerSet { .. } => 0,
    }
}

fn selector_count(selector: &FemMeshPartSelector) -> u32 {
    match selector {
        FemMeshPartSelector::ElementRange { count, .. }
        | FemMeshPartSelector::BoundaryFaceRange { count, .. }
        | FemMeshPartSelector::NodeRange { count, .. } => *count,
        FemMeshPartSelector::ElementMarkerSet { markers } => markers.len() as u32,
    }
}

fn mesh_part_role_name(role: &FemMeshPartRole) -> &'static str {
    match role {
        FemMeshPartRole::Air => "air",
        FemMeshPartRole::MagneticObject => "magnetic_object",
        FemMeshPartRole::Interface => "interface",
        FemMeshPartRole::OuterBoundary => "outer_boundary",
    }
}

fn domain_mesh_mode_name(mode: fullmag_ir::FemDomainMeshModeIR) -> &'static str {
    match mode {
        fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh => "merged_magnetic_mesh",
        fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir => "shared_domain_mesh_with_air",
    }
}

#[derive(Debug)]
pub struct RunError {
    pub message: String,
}

impl fmt::Display for RunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "RunError: {}", self.message)
    }
}

impl std::error::Error for RunError {}

impl From<fullmag_plan::PlanError> for RunError {
    fn from(e: fullmag_plan::PlanError) -> Self {
        RunError {
            message: format!("Planning failed:\n{}", e),
        }
    }
}

// ----- execution provenance -----

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolvedFallback {
    pub occurred: bool,
    pub original_engine: String,
    pub fallback_engine: String,
    pub reason: String,
    pub message: String,
}

/// Records which engine and device produced a run.
/// Included in artifact metadata for reproducibility.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExecutionProvenance {
    /// Engine that executed the run: e.g. "cpu_reference", "cuda_fdm",
    /// "fem_cpu_baseline_internal", "fem_cpu_native", "fem_native_gpu",
    /// "fem_eigen_cpu_baseline", or "fem_eigen_native_gpu".
    pub execution_engine: String,
    /// Numeric precision used: "double" or "single".
    pub precision: String,
    /// Demag operator kind: e.g. "tensor_fft_newell".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub demag_operator_kind: Option<String>,
    /// FFT backend used: "rustfft" (CPU) or "cuFFT" (CUDA).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fft_backend: Option<String>,
    /// GPU device name, if applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    /// GPU compute capability, if applicable (e.g. "8.6").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compute_capability: Option<String>,
    /// CUDA driver version, if applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cuda_driver_version: Option<i32>,
    /// CUDA runtime version, if applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cuda_runtime_version: Option<i32>,
    /// Whether a lossy fallback was used during this run (e.g. single-precision
    /// requested but unavailable, or an approximate demag operator substituted).
    #[serde(default)]
    pub lossy_fallback_used: bool,
    /// Physics terms that were present in the plan but silently ignored by the
    /// engine (e.g. H_ani on a CPU reference engine that folds it into H_eff).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ignored_terms: Vec<String>,
    /// RNG seed used for stochastic initialisations, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub random_seed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_fallback: Option<ResolvedFallback>,
    /// Integrator that was requested by the user/plan.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_integrator: Option<String>,
    /// Integrator actually used for execution.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_integrator: Option<String>,
    /// Demag realization requested by the user/plan.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_demag_realization: Option<String>,
    /// Demag realization actually used for execution.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_demag_realization: Option<String>,
    /// Timestep policy: "user", "adaptive", or "fallback".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dt_policy: Option<String>,
    /// FEM-030: MFEM device string used for this run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mfem_device: Option<String>,
    /// Canonical demag refresh cadence in seconds, if explicitly configured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub demag_refresh_interval_s: Option<f64>,
    /// Requested CPU thread count from authoring/runtime selection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_cpu_threads: Option<u32>,
    /// Resolved Rayon/control-plane CPU thread count used for execution.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_cpu_threads: Option<u32>,
    /// Requested FEM OpenMP thread count when the native runtime reports it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_fem_omp_threads: Option<u32>,
    /// Effective FEM OpenMP thread count when the native runtime reports it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_fem_omp_threads: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeEngineInfo {
    /// Canonical backend family such as "fdm", "fem", or "fem_eigen".
    pub backend_family: String,
    /// Canonical resolved engine id such as "fem_cpu_native" or
    /// "fem_eigen_cpu_baseline".
    pub engine_id: String,
    pub engine_label: String,
    pub accelerator: String,
}

// ----- internal execution types -----

#[derive(Debug, Clone)]
pub(crate) struct ExecutedRun {
    pub result: RunResult,
    pub initial_magnetization: Vec<[f64; 3]>,
    pub field_snapshots: Vec<FieldSnapshot>,
    pub field_snapshot_count: usize,
    pub auxiliary_artifacts: Vec<AuxiliaryArtifact>,
    pub provenance: ExecutionProvenance,
}

#[derive(Debug, Clone)]
pub(crate) struct FieldSnapshot {
    pub name: String,
    pub step: u64,
    pub time: f64,
    pub solver_dt: f64,
    pub values: Vec<[f64; 3]>,
}

#[derive(Debug, Clone)]
pub(crate) struct AuxiliaryArtifact {
    pub relative_path: String,
    pub bytes: Vec<u8>,
}

pub(crate) struct LiveStepConsumer<'a> {
    pub grid: [u32; 3],
    /// Cadence for heavier live payloads such as full magnetization snapshots.
    pub field_every_n: u64,
    pub display_selection: Option<&'a (dyn Fn() -> crate::DisplaySelectionState + Send + Sync)>,
    #[cfg_attr(not(any(feature = "cuda", feature = "fem-gpu")), allow(dead_code))]
    pub interrupt_requested: Option<&'a AtomicBool>,
    pub on_step: &'a mut dyn FnMut(StepUpdate) -> StepAction,
}

#[derive(Debug, Clone)]
#[allow(non_snake_case)]
pub(crate) struct StateObservables {
    pub magnetization: Vec<[f64; 3]>,
    pub exchange_field: Vec<[f64; 3]>,
    pub demag_field: Vec<[f64; 3]>,
    pub external_field: Vec<[f64; 3]>,
    pub antenna_field: Vec<[f64; 3]>,
    pub effective_field: Vec<[f64; 3]>,
    // PH-02: extended vector observables
    pub anisotropy_field: Vec<[f64; 3]>,
    pub dmi_field: Vec<[f64; 3]>,
    pub magnetoelastic_field: Vec<[f64; 3]>,
    pub cubic_anisotropy_field: Vec<[f64; 3]>,
    pub bulk_dmi_field: Vec<[f64; 3]>,
    pub oersted_field: Vec<[f64; 3]>,
    pub thermal_field: Vec<[f64; 3]>,
    pub exchange_energy: f64,
    pub demag_energy: f64,
    pub external_energy: f64,
    pub anisotropy_energy: f64,
    pub dmi_energy: f64,
    pub total_energy: f64,
    pub max_dm_dt: f64,
    pub max_h_eff: f64,
    pub max_h_demag: f64,
    #[allow(dead_code)]
    pub max_torque_Apm: f64,
    pub per_object_scalars: HashMap<String, HashMap<String, f64>>,
}

#[cfg(test)]
mod tests {
    use super::{normalized_payload_element_markers, LivePreviewField, StepStats, StepUpdate};
    use std::collections::BTreeSet;

    #[test]
    fn normalized_payload_markers_use_region_material_contract_when_available() {
        let magnetic_markers = [7u32].into_iter().collect::<BTreeSet<_>>();
        assert_eq!(
            normalized_payload_element_markers(&[7, 99, 0], Some(&magnetic_markers)),
            vec![1, 0, 0]
        );
    }

    #[test]
    fn normalized_payload_markers_preserve_simple_air_split_without_region_materials() {
        assert_eq!(
            normalized_payload_element_markers(&[2, 0], None),
            vec![1, 0]
        );
    }

    #[test]
    fn normalized_payload_markers_treat_uniform_marker_mesh_as_fully_magnetic() {
        assert_eq!(
            normalized_payload_element_markers(&[5, 5], None),
            vec![1, 1]
        );
    }

    #[test]
    fn to_v2_uses_registry_metadata_for_magnetization() {
        let update = StepUpdate {
            stats: StepStats::default(),
            grid: [4, 1, 1],
            fem_mesh: None,
            magnetization: Some(vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0]),
            preview_field: None,
            cached_preview_fields: None,
            scalar_row_due: false,
            finished: false,
        };

        let v2 = update.to_v2();
        let frame = v2
            .frames
            .iter()
            .find(|entry| entry.quantity_id == "m")
            .expect("missing magnetization frame");
        let spec = fullmag_quantities::quantity_spec("m").expect("missing quantity spec");

        assert_eq!(frame.unit, spec.unit);
        assert_eq!(frame.n_comp, spec.n_comp);
        assert!(!frame.unit.is_empty());
    }

    #[test]
    fn to_v2_uses_registry_metadata_for_preview_fields() {
        let update = StepUpdate {
            stats: StepStats::default(),
            grid: [4, 1, 1],
            fem_mesh: None,
            magnetization: None,
            preview_field: Some(LivePreviewField {
                config_revision: 1,
                quantity: "eden_total".to_string(),
                unit: "wrong".to_string(),
                spatial_kind: "grid".to_string(),
                quantity_domain: "magnetic_only".to_string(),
                preview_grid: [4, 1, 1],
                original_grid: [4, 1, 1],
                vector_field_values: vec![1.0, 2.0, 3.0, 4.0],
                x_chosen_size: 4,
                y_chosen_size: 1,
                applied_x_chosen_size: 4,
                applied_y_chosen_size: 1,
                applied_layer_stride: 1,
                auto_downscaled: false,
                auto_downscale_message: None,
                active_mask: None,
            }),
            cached_preview_fields: None,
            scalar_row_due: false,
            finished: false,
        };

        let v2 = update.to_v2();
        let frame = v2
            .frames
            .iter()
            .find(|entry| entry.quantity_id == "eden_total")
            .expect("missing preview frame");
        let spec = fullmag_quantities::quantity_spec("eden_total").expect("missing quantity spec");

        assert_eq!(frame.unit, spec.unit);
        assert_eq!(frame.n_comp, spec.n_comp);
        assert!(!frame.unit.is_empty());
    }
}
