use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct WorkspaceSelectionResource {
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_object_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_entity_id: Option<String>,
}

impl Default for WorkspaceSelectionResource {
    fn default() -> Self {
        Self {
            revision: 0,
            selected_node_id: None,
            selected_object_id: None,
            selected_entity_id: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct WorkspaceSelectionReplaceRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_object_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_entity_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct WorkspaceActiveNodeResource {
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct WorkspaceActiveNodeReplaceRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct WorkspaceRibbonResource {
    pub revision: u64,
    pub workspace_mode: String,
    pub active_core_tab: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_contextual_tab: Option<String>,
}

impl Default for WorkspaceRibbonResource {
    fn default() -> Self {
        Self {
            revision: 0,
            workspace_mode: "study".to_string(),
            active_core_tab: "Home".to_string(),
            active_contextual_tab: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct WorkspaceRibbonReplaceRequest {
    pub workspace_mode: String,
    pub active_core_tab: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_contextual_tab: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct WorkspaceStageLayout {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left_dock: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub center_dock: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right_dock: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bottom_dock: Option<String>,
}

impl WorkspaceStageLayout {
    pub fn build_default() -> Self {
        Self {
            left_dock: Some("model".to_string()),
            center_dock: Some("settings".to_string()),
            right_dock: Some("properties".to_string()),
            bottom_dock: Some("messages".to_string()),
        }
    }

    pub fn study_default() -> Self {
        Self {
            left_dock: Some("study-tree".to_string()),
            center_dock: Some("viewport-controls".to_string()),
            right_dock: Some("solver".to_string()),
            bottom_dock: Some("jobs".to_string()),
        }
    }

    pub fn analyze_default() -> Self {
        Self {
            left_dock: Some("results-tree".to_string()),
            center_dock: Some("plots".to_string()),
            right_dock: Some("display".to_string()),
            bottom_dock: Some("charts".to_string()),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct WorkspaceLayoutResource {
    pub revision: u64,
    pub current_stage: String,
    pub stage_layouts: BTreeMap<String, WorkspaceStageLayout>,
    pub active_workspace_tab_by_stage: BTreeMap<String, Option<String>>,
}

impl Default for WorkspaceLayoutResource {
    fn default() -> Self {
        let mut stage_layouts = BTreeMap::new();
        stage_layouts.insert("build".to_string(), WorkspaceStageLayout::build_default());
        stage_layouts.insert("study".to_string(), WorkspaceStageLayout::study_default());
        stage_layouts.insert(
            "analyze".to_string(),
            WorkspaceStageLayout::analyze_default(),
        );

        let mut active_workspace_tab_by_stage = BTreeMap::new();
        active_workspace_tab_by_stage.insert("build".to_string(), Some("core:3d".to_string()));
        active_workspace_tab_by_stage.insert("study".to_string(), Some("core:3d".to_string()));
        active_workspace_tab_by_stage
            .insert("analyze".to_string(), Some("core:analyze".to_string()));

        Self {
            revision: 0,
            current_stage: "study".to_string(),
            stage_layouts,
            active_workspace_tab_by_stage,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq, ToSchema)]
pub struct WorkspaceLayoutReplaceRequest {
    pub current_stage: String,
    pub stage_layouts: BTreeMap<String, WorkspaceStageLayout>,
    pub active_workspace_tab_by_stage: BTreeMap<String, Option<String>>,
}
