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

pub(crate) const MAGNETIZATION_ASSIGNMENTS_KEY: &str = "magnetization_assignments";
pub(crate) const STAGE_MAGNETIZATION_ASSIGNMENTS_KEY: &str = "stage_magnetization_assignments";
const MAGNETIZATION_ASSIGNMENTS_SCHEMA: &str = "fullmag.magnetization-assignments.v1";
const MAX_MAGNETIZATION_ASSIGNMENTS: usize = 4096;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ScriptMagnetizationAssignment {
    pub object_id: String,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    pub region_id: Option<String>,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    pub initializer: Option<fullmag_ir::InitialMagnetizationIR>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScriptMagnetizationAssignments {
    schema_version: String,
    assignments: Vec<ScriptMagnetizationAssignment>,
}

pub(crate) struct StageMagnetizationAssignments {
    pub(crate) ordered: Vec<ScriptMagnetizationAssignment>,
    independent_count: usize,
}

impl StageMagnetizationAssignments {
    pub(crate) fn new(
        mut independent: Vec<ScriptMagnetizationAssignment>,
        local: Vec<ScriptMagnetizationAssignment>,
    ) -> Self {
        let independent_count = independent.len();
        independent.extend(local);
        Self { ordered: independent, independent_count }
    }

    pub(crate) fn independent(&self) -> &[ScriptMagnetizationAssignment] {
        &self.ordered[..self.independent_count]
    }

    pub(crate) fn local(&self) -> &[ScriptMagnetizationAssignment] {
        &self.ordered[self.independent_count..]
    }
}

pub(crate) fn parse_magnetization_assignment_batch(
    value: &Value,
    count: &mut usize,
) -> anyhow::Result<Vec<ScriptMagnetizationAssignment>> {
    let batch: ScriptMagnetizationAssignments = serde_json::from_value(value.clone())?;
    if batch.schema_version != MAGNETIZATION_ASSIGNMENTS_SCHEMA || batch.assignments.is_empty() {
        anyhow::bail!("invalid script magnetization assignment batch");
    }
    *count = count.saturating_add(batch.assignments.len());
    if *count > MAX_MAGNETIZATION_ASSIGNMENTS {
        anyhow::bail!("script magnetization assignment limit exceeded");
    }
    if batch.assignments.iter().any(|assignment| {
        assignment.object_id.trim().is_empty()
            || assignment.region_id.as_deref().is_some_and(|id| id.trim().is_empty())
    }) {
        anyhow::bail!("magnetization assignment requires an object and nonempty optional region ID");
    }
    Ok(batch.assignments)
}

impl StudyPipelineDocument {
    /// Lower independent declarations to the next enabled physical stage. A
    /// disabled stage does not consume an independent authored assignment.
    /// An assignment owned by a stage applies only while that stage is enabled.
    pub(crate) fn magnetization_assignments_by_stage(
        &self,
    ) -> anyhow::Result<BTreeMap<String, StageMagnetizationAssignments>> {
        let versioned = match self.version.as_str() {
            "study_pipeline.v1" => false,
            "study_pipeline.v2" => true,
            version => anyhow::bail!("unsupported study pipeline version '{version}'"),
        };
        fn visit(
            nodes: &[StudyPipelineNode],
            groups_enabled: bool,
            versioned: bool,
            pending: &mut Vec<ScriptMagnetizationAssignment>,
            assignments_by_stage: &mut BTreeMap<String, StageMagnetizationAssignments>,
            count: &mut usize,
        ) -> anyhow::Result<()> {
            for node in nodes {
                match node {
                    StudyPipelineNode::Group { enabled, children, .. } => visit(
                        children,
                        groups_enabled && *enabled,
                        versioned,
                        pending,
                        assignments_by_stage,
                        count,
                    )?,
                    StudyPipelineNode::Primitive { id, enabled, stage_kind, payload, .. } => {
                        let physical = matches!(stage_kind.as_str(), "relax" | "run");
                        let independent = payload.get(MAGNETIZATION_ASSIGNMENTS_KEY);
                        let local = payload.get(STAGE_MAGNETIZATION_ASSIGNMENTS_KEY);
                        if (independent.is_some() || local.is_some()) && (!versioned || !physical) {
                            anyhow::bail!("magnetization assignments require a v2 Run or Relax node");
                        }
                        if let Some(value) = independent {
                            let assignments = parse_magnetization_assignment_batch(value, count)?;
                            if groups_enabled {
                                pending.extend(assignments);
                            }
                        }
                        let local = local.map(|value| parse_magnetization_assignment_batch(value, count))
                            .transpose()?.unwrap_or_default();
                        if groups_enabled && *enabled && physical && (!pending.is_empty() || !local.is_empty()) {
                            let assignments = StageMagnetizationAssignments::new(std::mem::take(pending), local);
                            if assignments_by_stage.insert(id.clone(), assignments).is_some() {
                                anyhow::bail!("duplicate physical stage with magnetization assignments");
                            }
                        }
                    }
                    StudyPipelineNode::Macro { config, .. } => {
                        if config.contains_key(MAGNETIZATION_ASSIGNMENTS_KEY)
                            || config.contains_key(STAGE_MAGNETIZATION_ASSIGNMENTS_KEY)
                        {
                            anyhow::bail!("magnetization assignments cannot be attached to a macro");
                        }
                    }
                }
            }
            Ok(())
        }
        let mut by_stage = BTreeMap::new();
        let mut pending = Vec::new();
        let mut count = 0;
        visit(&self.nodes, true, versioned, &mut pending, &mut by_stage, &mut count)?;
        Ok(by_stage)
    }
}

impl ScriptMagnetizationAssignment {
    fn magnet_index(&self, problem: &ProblemIR) -> anyhow::Result<usize> {
        problem
            .magnets
            .iter()
            .position(|magnet| magnet.object_id.as_deref().unwrap_or(&magnet.name) == self.object_id)
            .ok_or_else(|| anyhow::anyhow!("magnetization assignment targets unknown object '{}'", self.object_id))
    }

    fn region_index(&self, problem: &ProblemIR, region_id: &str) -> anyhow::Result<usize> {
        problem
            .object_regions
            .iter()
            .position(|region| region.owner_object == self.object_id && region.region_id == region_id)
            .ok_or_else(|| anyhow::anyhow!("magnetization assignment targets unknown region '{region_id}' on '{}'", self.object_id))
    }

    fn object_initializer(&self) -> fullmag_ir::InitialMagnetizationIR {
        self.initializer.clone().unwrap_or(fullmag_ir::InitialMagnetizationIR::Uniform {
            value: [1.0, 0.0, 0.0],
        })
    }

    pub(crate) fn apply(&self, problem: &mut ProblemIR) -> anyhow::Result<()> {
        let magnet = self.magnet_index(problem)?;
        if let Some(region_id) = &self.region_id {
            let region = self.region_index(problem, region_id)?;
            problem.object_regions[region].texture_override = self.initializer.clone().map(
                |initial_magnetization| fullmag_ir::RegionTextureOverrideIR { initial_magnetization },
            );
        } else {
            problem.magnets[magnet].initial_magnetization = Some(self.object_initializer());
        }
        Ok(())
    }

    /// Qualify the declared operations against the capture. The last write to
    /// each scope determines the value pinned in this stage's ProblemIR.
    pub(crate) fn captures_full_reset(
        assignments: &[Self],
        problem: &ProblemIR,
    ) -> anyhow::Result<bool> {
        let mut last_by_scope = BTreeMap::new();
        for assignment in assignments {
            let magnet = assignment.magnet_index(problem)?;
            let region = assignment.region_id.as_deref()
                .map(|region_id| assignment.region_index(problem, region_id)).transpose()?;
            last_by_scope.insert((magnet, region), assignment);
        }
        for ((magnet, region), assignment) in &last_by_scope {
            let matches = if let Some(region) = region {
                problem.object_regions[*region].texture_override.as_ref()
                    .map(|texture| &texture.initial_magnetization) == assignment.initializer.as_ref()
            } else {
                problem.magnets[*magnet].initial_magnetization.as_ref()
                    == Some(&assignment.object_initializer())
            };
            if !matches {
                anyhow::bail!("magnetization assignment differs from the captured initializer");
            }
        }
        Ok(!problem.magnets.is_empty()
            && (0..problem.magnets.len()).all(|magnet| last_by_scope.contains_key(&(magnet, None))))
    }
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

#[derive(Debug, Clone, Deserialize, PartialEq)]
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
    AntennaClosedLoopInspection {
        input: fullmag_ir::ResolvedAntennaClosedLoopCurrentInputIR,
        requested_execution: fullmag_ir::RequestedTransportExecutionIR,
        output_id: String,
    },
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
    AntennaClosedLoopInspection,
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
    AntennaClosedLoopInspection,
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
            StageTransitionKind::AntennaClosedLoopInspection => "closed-loop inspection computed",
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

/// Authored identity of one actual execution, separate from its physical IR.
/// A macro may own several executions; its node ID alone is not unique.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptStageProvenance {
    pub authored_step_id: String,
    pub expansion_index: usize,
    pub ancestor_group_ids: Vec<String>,
    pub label: String,
    pub notes: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedScriptStage {
    pub ir: ProblemIR,
    pub until_seconds: f64,
    pub entrypoint_kind: String,
    pub action: Option<ResolvedScriptStageAction>,
    pub incoming_transition: Option<StageTransitionMetadata>,
    pub provenance: Option<ScriptStageProvenance>,
}

impl ResolvedScriptStage {
    pub fn solver(ir: ProblemIR, until_seconds: f64, entrypoint_kind: impl Into<String>) -> Self {
        Self {
            ir,
            until_seconds,
            entrypoint_kind: entrypoint_kind.into(),
            action: None,
            incoming_transition: None,
            provenance: None,
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
            provenance: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_stage_constructors_have_no_authored_provenance() {
        let ir = ProblemIR::bootstrap_example();
        assert!(ResolvedScriptStage::solver(ir.clone(), 1e-12, "direct").provenance.is_none());
        assert!(ResolvedScriptStage::synthetic(
            ir, "save", ResolvedScriptStageAction::SaveState {
                artifact_name: "snapshot".into(), format: None, dataset: None,
            },
        ).provenance.is_none());
    }

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
