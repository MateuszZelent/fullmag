//! Compatibility wire types for historical Python-helper stage capture and
//! CLI stage records. They do not define a second canonical StudyPlan or
//! ProblemIR contract and have no runtime, solver, or operating-system layer.

use fullmag_ir::{GeometryAssetsIR, OutputIR, ProblemIR, RegionalFieldDriveIR, TableAutosaveIR};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
fn default_study_pipeline_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StudyPipelineDocument {
    pub version: String,
    #[serde(default)]
    pub nodes: Vec<StudyPipelineNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
#[serde(tag = "node_kind", rename_all = "snake_case")]
pub enum StudyPipelineNode {
    Primitive {
        id: String,
        label: String,
        #[serde(default = "default_study_pipeline_enabled")]
        enabled: bool,
        #[serde(default)]
        notes: Option<String>,
        #[serde(default)]
        source: Option<String>,
        stage_kind: String,
        #[serde(default)]
        payload: BTreeMap<String, Value>,
    },
    Macro {
        id: String,
        label: String,
        #[serde(default = "default_study_pipeline_enabled")]
        enabled: bool,
        #[serde(default)]
        notes: Option<String>,
        #[serde(default)]
        source: Option<String>,
        macro_kind: String,
        #[serde(default)]
        config: BTreeMap<String, Value>,
    },
    Group {
        id: String,
        label: String,
        #[serde(default = "default_study_pipeline_enabled")]
        enabled: bool,
        #[serde(default)]
        notes: Option<String>,
        #[serde(default)]
        source: Option<String>,
        #[serde(default)]
        collapsed: bool,
        #[serde(default)]
        children: Vec<StudyPipelineNode>,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct ScriptExecutionConfig {
    pub ir: ProblemIR,
    #[serde(default, deserialize_with = "deserialize_antenna_inventory")]
    pub antenna_inventory: ScriptAntennaAuthoringInventory,
    #[serde(default)]
    pub shared_geometry_assets: Option<GeometryAssetsIR>,
    pub default_until_seconds: Option<f64>,
    #[serde(default)]
    pub study_pipeline: Option<StudyPipelineDocument>,
    #[serde(default)]
    pub stages: Vec<ScriptExecutionStage>,
}

/// Authored definitions are not executable until selected by a stage action.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ScriptAntennaAuthoringInventory {
    #[serde(default)]
    pub antenna_field_solve_stages: Vec<fullmag_ir::AntennaFieldSolveStageIR>,
    #[serde(default)]
    pub antenna_target_projections: Vec<fullmag_ir::AntennaTargetProjectionRefIR>,
    #[serde(default)]
    pub solved_antenna_drives: Vec<fullmag_ir::SolvedAntennaDriveIR>,
    #[serde(default)]
    pub antenna_spectrum_requests: Vec<fullmag_ir::AntennaSpectrumRequestIR>,
}

impl ScriptAntennaAuthoringInventory {
    pub fn validate(&self) -> Result<(), String> {
        for (collection, ids) in [
            ("antenna_field_solve_stages", self.antenna_field_solve_stages.iter().map(|item| item.id.as_str()).collect::<Vec<_>>()),
            ("antenna_target_projections", self.antenna_target_projections.iter().map(|item| item.id.as_str()).collect()),
            ("solved_antenna_drives", self.solved_antenna_drives.iter().map(|item| item.id.as_str()).collect()),
            ("antenna_spectrum_requests", self.antenna_spectrum_requests.iter().map(|item| item.id.as_str()).collect()),
        ] {
            let mut seen = std::collections::BTreeSet::new();
            for id in ids {
                if !seen.insert(id) {
                    return Err(format!("duplicate {collection} declaration id '{id}'"));
                }
            }
        }
        Ok(())
    }
}

fn deserialize_antenna_inventory<'de, D>(deserializer: D) -> Result<ScriptAntennaAuthoringInventory, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let inventory = ScriptAntennaAuthoringInventory::deserialize(deserializer)?;
    inventory.validate().map_err(serde::de::Error::custom)?;
    Ok(inventory)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ScriptExecutionStageAction {
    AntennaFieldSolve {
        stage_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        port_mode_id: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        port_mode_ids: Vec<String>,
    },
    AntennaSourceSpectrum {
        request: fullmag_ir::AntennaSpectrumRequestIR,
    },
    AddSolvedAntennaDrive {
        projection: fullmag_ir::AntennaTargetProjectionRefIR,
        drive: fullmag_ir::SolvedAntennaDriveIR,
    },
    SaveState {
        #[serde(default = "default_stage_action_artifact_name")]
        artifact_name: String,
        #[serde(default)]
        format: Option<String>,
        #[serde(default)]
        dataset: Option<String>,
    },
    LoadState {
        #[serde(default)]
        artifact_name: Option<String>,
        #[serde(default)]
        state_path: Option<String>,
        #[serde(default)]
        format: Option<String>,
        #[serde(default)]
        dataset: Option<String>,
        #[serde(default)]
        sample_index: Option<i64>,
    },
    Export {
        #[serde(default)]
        artifact_name: Option<String>,
        quantity: String,
        format: String,
        #[serde(default)]
        dataset: Option<String>,
    },
    ChangeDevice {
        device: String,
    },
    AddFieldDrive {
        drive: RegionalFieldDriveIR,
    },
    RemoveFieldDrive {
        drive_id: String,
    },
    TableAutosave {
        #[serde(default = "default_true")]
        enabled: bool,
        #[serde(default)]
        table_autosave: Option<TableAutosaveIR>,
    },
    Autosave {
        #[serde(default = "default_true")]
        enabled: bool,
        #[serde(default)]
        quantity: Option<String>,
        #[serde(default)]
        output: Option<OutputIR>,
    },
    FftResponse {
        #[serde(default = "default_true")]
        enabled: bool,
        #[serde(default)]
        request: Option<Value>,
    },
    SetTransportCurrent {
        module_id: String,
        #[serde(rename = "terminal_outward_current_density_Apm2")]
        terminal_outward_current_density_apm2: BTreeMap<String, f64>,
    },
    SetSpinTorqueEnabled {
        module_id: String,
        enabled: bool,
    },
}

fn default_stage_action_artifact_name() -> String {
    "state_snapshot".to_string()
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
pub struct ScriptExecutionStage {
    pub ir: ProblemIR,
    pub default_until_seconds: Option<f64>,
    pub entrypoint_kind: String,
    #[serde(default)]
    pub action: Option<ScriptExecutionStageAction>,
}

#[derive(Debug, Clone)]
pub enum ResolvedScriptStageAction {
    AntennaExternalLeadInspection {
        input: fullmag_ir::ResolvedAntennaExternalLeadCurrentInputIR,
        requested_execution: fullmag_ir::RequestedTransportExecutionIR,
        output_id: String,
    },
    AntennaFieldSolve {
        stage_id: String,
        port_mode_id: String,
        plan: fullmag_ir::AntennaFieldSolvePlanIR,
    },
    AntennaSourceSpectrum {
        request_id: String,
    },
    AddSolvedAntennaDrive {
        projection_id: String,
        drive_id: String,
    },
    SaveState {
        artifact_name: String,
        format: Option<String>,
        dataset: Option<String>,
    },
    LoadState {
        artifact_name: Option<String>,
        state_path: Option<String>,
        format: Option<String>,
        dataset: Option<String>,
        sample_index: Option<i64>,
    },
    Export {
        artifact_name: Option<String>,
        quantity: String,
        format: String,
        dataset: Option<String>,
    },
    ChangeDevice {
        device: String,
    },
    AddFieldDrive {
        drive: RegionalFieldDriveIR,
    },
    RemoveFieldDrive {
        drive_id: String,
    },
    TableAutosave {
        enabled: bool,
        table_autosave: Option<TableAutosaveIR>,
    },
    Autosave {
        enabled: bool,
        quantity: Option<String>,
        output: Option<OutputIR>,
    },
    FftResponse {
        enabled: bool,
        request: Option<Value>,
    },
    SetTransportCurrent {
        module_id: String,
        terminal_outward_current_density_apm2: BTreeMap<String, f64>,
    },
    SetSpinTorqueEnabled {
        module_id: String,
        enabled: bool,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StageTransitionKind {
    ContinueInPlace,
    AntennaExternalLeadInspection,
    AntennaFieldSolve,
    AntennaSourceSpectrum,
    TransferState,
    RemeshTransfer,
    BackendTransfer,
    LoadState,
    SaveCheckpoint,
    ExportOnly,
    Unsupported,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StageTransitionReason {
    SameRuntimeContext,
    AntennaExternalLeadInspection,
    AntennaFieldSolve,
    AntennaSourceSpectrum,
    ExplicitRemesh,
    BackendChange,
    MeshGenerationChanged,
    ObjectTopologyChanged,
    MaterialTopologyChanged,
    DeviceChange,
    CheckpointLoad,
    UserExport,
    IncompatibleImplicitState,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StateTransferOperatorKind {
    IdentityCopy,
    FemToFdmGridResample,
    FdmToFemMeshResample,
    MeshToMeshInterpolation,
    CheckpointLoad,
    SampledFieldImport,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StageTransitionUiPresentation {
    SmoothArrow,
    BoundaryBar,
    ErrorBoundary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StageTransitionMetadata {
    pub kind: StageTransitionKind,
    pub reason: StageTransitionReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transfer_operator: Option<StateTransferOperatorKind>,
    pub ui_presentation: StageTransitionUiPresentation,
}

impl StageTransitionMetadata {
    pub fn continue_in_place() -> Self {
        Self {
            kind: StageTransitionKind::ContinueInPlace,
            reason: StageTransitionReason::SameRuntimeContext,
            transfer_operator: None,
            ui_presentation: StageTransitionUiPresentation::SmoothArrow,
        }
    }

    pub fn boundary(
        kind: StageTransitionKind,
        reason: StageTransitionReason,
        transfer_operator: Option<StateTransferOperatorKind>,
    ) -> Self {
        Self {
            kind,
            reason,
            transfer_operator,
            ui_presentation: StageTransitionUiPresentation::BoundaryBar,
        }
    }

    pub fn unsupported(reason: StageTransitionReason) -> Self {
        Self {
            kind: StageTransitionKind::Unsupported,
            reason,
            transfer_operator: None,
            ui_presentation: StageTransitionUiPresentation::ErrorBoundary,
        }
    }

    pub fn legacy_state_transition_label(&self) -> &'static str {
        if self.reason == StageTransitionReason::DeviceChange {
            return "Change device";
        }
        match self.kind {
            StageTransitionKind::ContinueInPlace => "continues",
            StageTransitionKind::AntennaExternalLeadInspection => "antenna inspection computed",
            StageTransitionKind::AntennaFieldSolve => "field basis solved",
            StageTransitionKind::AntennaSourceSpectrum => "source spectrum computed",
            StageTransitionKind::SaveCheckpoint => "preserved",
            StageTransitionKind::LoadState => "restored",
            StageTransitionKind::ExportOnly => "exported",
            StageTransitionKind::TransferState
            | StageTransitionKind::RemeshTransfer
            | StageTransitionKind::BackendTransfer => "transferred",
            StageTransitionKind::Unsupported => "unsupported",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedScriptStage {
    pub ir: ProblemIR,
    pub until_seconds: f64,
    pub entrypoint_kind: String,
    pub action: Option<ResolvedScriptStageAction>,
    pub incoming_transition: Option<StageTransitionMetadata>,
}

impl ResolvedScriptStage {
    pub fn solver(ir: ProblemIR, until_seconds: f64, entrypoint_kind: impl Into<String>) -> Self {
        Self {
            ir,
            until_seconds,
            entrypoint_kind: entrypoint_kind.into(),
            action: None,
            incoming_transition: None,
        }
    }

    pub fn synthetic(
        ir: ProblemIR,
        entrypoint_kind: impl Into<String>,
        action: ResolvedScriptStageAction,
    ) -> Self {
        Self {
            ir,
            until_seconds: 0.0,
            entrypoint_kind: entrypoint_kind.into(),
            action: Some(action),
            incoming_transition: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execution_config_defaults_inventory_without_activating_definitions() {
        let config: ScriptExecutionConfig = serde_json::from_value(serde_json::json!({
            "ir": ProblemIR::bootstrap_example()
        })).unwrap();
        assert_eq!(config.antenna_inventory, ScriptAntennaAuthoringInventory::default());
    }

    #[test]
    fn execution_config_rejects_unknown_inventory_fields_and_duplicate_ids() {
        let mut wire = serde_json::json!({
            "ir": ProblemIR::bootstrap_example(),
            "antenna_inventory": {"unexpected": []}
        });
        assert!(serde_json::from_value::<ScriptExecutionConfig>(wire.clone()).unwrap_err().to_string().contains("unknown field"));
        let projection = serde_json::json!({
            "id": "projection",
            "solution": {"kind": "stage_output", "stage_id": "solve", "output_id": "basis"},
            "target": {"kind": "global"},
            "output_id": "projected"
        });
        wire["antenna_inventory"] = serde_json::json!({"antenna_target_projections": [projection.clone(), projection]});
        assert!(serde_json::from_value::<ScriptExecutionConfig>(wire).unwrap_err().to_string().contains("duplicate antenna_target_projections declaration id"));
    }

    #[test]
    fn action_wire_field_and_legacy_defaults_are_preserved() {
        let action: ScriptExecutionStageAction = serde_json::from_value(serde_json::json!({
            "kind": "set_transport_current",
            "module_id": "transport-a",
            "terminal_outward_current_density_Apm2": {"lead_a": 2.5}
        }))
        .expect("canonical current action should deserialize");
        match action {
            ScriptExecutionStageAction::SetTransportCurrent {
                module_id,
                terminal_outward_current_density_apm2,
            } => {
                assert_eq!(module_id, "transport-a");
                assert_eq!(
                    terminal_outward_current_density_apm2.get("lead_a"),
                    Some(&2.5)
                );
            }
            _ => panic!("expected set_transport_current action"),
        }

        let save: ScriptExecutionStageAction =
            serde_json::from_value(serde_json::json!({"kind": "save_state"}))
                .expect("save_state should retain its default artifact name");
        assert!(matches!(
            save,
            ScriptExecutionStageAction::SaveState { artifact_name, .. }
                if artifact_name == "state_snapshot"
        ));

        let table: ScriptExecutionStageAction =
            serde_json::from_value(serde_json::json!({"kind": "table_autosave"}))
                .expect("table_autosave should default enabled");
        assert!(matches!(
            table,
            ScriptExecutionStageAction::TableAutosave { enabled: true, .. }
        ));

        let autosave: ScriptExecutionStageAction =
            serde_json::from_value(serde_json::json!({"kind": "autosave"}))
                .expect("autosave should default enabled");
        assert!(matches!(
            autosave,
            ScriptExecutionStageAction::Autosave { enabled: true, .. }
        ));

        let fft: ScriptExecutionStageAction =
            serde_json::from_value(serde_json::json!({"kind": "fft_response"}))
                .expect("fft_response should default enabled");
        assert!(matches!(
            fft,
            ScriptExecutionStageAction::FftResponse { enabled: true, .. }
        ));
    }

    #[test]
    fn compatibility_pipeline_retains_unknown_kind_and_source_strings() {
        let document: StudyPipelineDocument = serde_json::from_value(serde_json::json!({
            "version": "legacy-pipeline-v9",
            "nodes": [{
                "node_kind": "primitive",
                "id": "stage-a",
                "label": "Stage A",
                "source": "future_source",
                "stage_kind": "future_stage"
            }]
        }))
        .expect("legacy wire fields remain untyped strings");

        match &document.nodes[0] {
            StudyPipelineNode::Primitive {
                enabled,
                source,
                stage_kind,
                ..
            } => {
                assert!(*enabled, "omitted pipeline enabled defaults to true");
                assert_eq!(source.as_deref(), Some("future_source"));
                assert_eq!(stage_kind, "future_stage");
            }
            _ => panic!("expected primitive compatibility node"),
        }
        let serialized = serde_json::to_value(document).expect("pipeline should serialize");
        assert_eq!(serialized["version"], "legacy-pipeline-v9");
        assert_eq!(serialized["nodes"][0]["source"], "future_source");
        assert_eq!(serialized["nodes"][0]["stage_kind"], "future_stage");
    }

    #[test]
    fn stage_transition_wire_serialization_is_unchanged() {
        let serialized = serde_json::to_value(StageTransitionMetadata::continue_in_place())
            .expect("transition should serialize");

        assert_eq!(
            serialized,
            serde_json::json!({
                "kind": "continue_in_place",
                "reason": "same_runtime_context",
                "ui_presentation": "smooth_arrow"
            })
        );
    }
}
