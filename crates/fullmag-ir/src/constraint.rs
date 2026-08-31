use crate::{SelectionDefinitionIR, SelectionExprIR, SelectionScalarExprIR};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const FROZEN_SPINS_SCHEMA_VERSION: &str = "frozen_spins.v1";
pub const FROZEN_SPINS_RUNTIME_PLAN_BINDING_SCHEMA_VERSION: &str =
    "frozen_spins.runtime_plan_binding.v1";
pub const FROZEN_SPINS_SOURCE_STATE_REVISION_METADATA_KEY: &str =
    "frozen_spins_source_state_revision";

/// Command-bound authoring projection consumed when the next solver plan is
/// materialized. The payload deliberately carries canonical IR constraints,
/// not a UI mask or a backend-specific resolved plan: selection resolution and
/// topology certification remain owned by `fullmag-plan`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FrozenSpinsRuntimePlanBindingIR {
    pub schema_version: String,
    pub launch_command_id: String,
    pub source_scene_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_state_revision: Option<u64>,
    pub selection_definitions: Vec<SelectionDefinitionIR>,
    pub magnetization_constraints: Vec<MagnetizationConstraintIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MagnetizationConstraintIR {
    FrozenSpins(FrozenSpinsIR),
}

impl MagnetizationConstraintIR {
    pub fn frozen_spins(&self) -> &FrozenSpinsIR {
        match self {
            Self::FrozenSpins(value) => value,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FrozenSpinsIR {
    pub schema_version: String,
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub selector: SelectionExprIR,
    pub reference: FrozenReferencePolicyIR,
    pub membership: SelectionMembershipPolicyIR,
    pub activation: ConstraintActivationIR,
    pub empty_selection: EmptySelectionPolicyIR,
    pub inactive_selection: InactiveSelectionPolicyIR,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FrozenSpinsIRWire {
    schema_version: String,
    id: String,
    name: String,
    #[serde(default = "default_enabled")]
    enabled: bool,
    selector: SelectionExprIR,
    #[serde(default)]
    reference: FrozenReferencePolicyIR,
    #[serde(default)]
    membership: Option<SelectionMembershipPolicyIR>,
    #[serde(default)]
    activation: ConstraintActivationIR,
    #[serde(default)]
    empty_selection: EmptySelectionPolicyIR,
    #[serde(default)]
    inactive_selection: InactiveSelectionPolicyIR,
}

impl<'de> Deserialize<'de> for FrozenSpinsIR {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = FrozenSpinsIRWire::deserialize(deserializer)?;
        let membership = wire.membership.unwrap_or_else(|| {
            if selection_is_state_dependent(&wire.selector, &[])
                || selection_contains_reference(&wire.selector)
            {
                SelectionMembershipPolicyIR::SnapshotAtActivation {}
            } else {
                SelectionMembershipPolicyIR::Static {}
            }
        });
        Ok(Self {
            schema_version: wire.schema_version,
            id: wire.id,
            name: wire.name,
            enabled: wire.enabled,
            selector: wire.selector,
            reference: wire.reference,
            membership,
            activation: wire.activation,
            empty_selection: wire.empty_selection,
            inactive_selection: wire.inactive_selection,
        })
    }
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FrozenReferencePolicyIR {
    CaptureCurrentAtActivation {},
    InitialState {},
    ExplicitFieldAsset { asset_id: String },
}

impl Default for FrozenReferencePolicyIR {
    fn default() -> Self {
        Self::CaptureCurrentAtActivation {}
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SelectionMembershipPolicyIR {
    Static {},
    SnapshotAtActivation {},
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ConstraintActivationIR {
    AllStages {},
    StageIds { stage_ids: Vec<String> },
}

impl Default for ConstraintActivationIR {
    fn default() -> Self {
        Self::AllStages {}
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum EmptySelectionPolicyIR {
    #[default]
    Error,
    AllowNoop,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum InactiveSelectionPolicyIR {
    #[default]
    WarnAndIntersect,
    Error,
}

pub fn selection_is_state_dependent(
    expression: &SelectionExprIR,
    definitions: &[SelectionDefinitionIR],
) -> bool {
    let by_id: BTreeMap<&str, &SelectionExprIR> = definitions
        .iter()
        .map(|definition| (definition.id.as_str(), &definition.expression))
        .collect();
    selection_is_state_dependent_inner(expression, &by_id, &mut BTreeSet::new())
}

fn selection_is_state_dependent_inner<'a>(
    expression: &'a SelectionExprIR,
    definitions: &BTreeMap<&'a str, &'a SelectionExprIR>,
    visiting: &mut BTreeSet<&'a str>,
) -> bool {
    match expression {
        SelectionExprIR::Compare { lhs, rhs, .. } => {
            scalar_is_state_dependent(lhs) || scalar_is_state_dependent(rhs)
        }
        SelectionExprIR::Approx { value, target, .. } => {
            scalar_is_state_dependent(value) || scalar_is_state_dependent(target)
        }
        SelectionExprIR::Between { value, .. } => scalar_is_state_dependent(value),
        SelectionExprIR::And { expressions }
        | SelectionExprIR::Or { expressions }
        | SelectionExprIR::Xor { expressions } => expressions
            .iter()
            .any(|child| selection_is_state_dependent_inner(child, definitions, visiting)),
        SelectionExprIR::Not { expression } => {
            selection_is_state_dependent_inner(expression, definitions, visiting)
        }
        SelectionExprIR::Ref { selection_id } => {
            if !visiting.insert(selection_id.as_str()) {
                return false;
            }
            let dependent = definitions
                .get(selection_id.as_str())
                .is_some_and(|resolved| {
                    selection_is_state_dependent_inner(resolved, definitions, visiting)
                });
            visiting.remove(selection_id.as_str());
            dependent
        }
        SelectionExprIR::AllMagnetic {}
        | SelectionExprIR::InObject { .. }
        | SelectionExprIR::InRegion { .. }
        | SelectionExprIR::InsideGeometry { .. } => false,
    }
}

fn selection_contains_reference(expression: &SelectionExprIR) -> bool {
    match expression {
        SelectionExprIR::Ref { .. } => true,
        SelectionExprIR::And { expressions }
        | SelectionExprIR::Or { expressions }
        | SelectionExprIR::Xor { expressions } => {
            expressions.iter().any(selection_contains_reference)
        }
        SelectionExprIR::Not { expression } => selection_contains_reference(expression),
        SelectionExprIR::AllMagnetic {}
        | SelectionExprIR::InObject { .. }
        | SelectionExprIR::InRegion { .. }
        | SelectionExprIR::InsideGeometry { .. }
        | SelectionExprIR::Compare { .. }
        | SelectionExprIR::Approx { .. }
        | SelectionExprIR::Between { .. } => false,
    }
}

fn scalar_is_state_dependent(expression: &SelectionScalarExprIR) -> bool {
    match expression {
        SelectionScalarExprIR::MagnetizationComponent { .. }
        | SelectionScalarExprIR::MagnetizationNorm {}
        | SelectionScalarExprIR::MagnetizationDot { .. } => true,
        SelectionScalarExprIR::Abs { value } => scalar_is_state_dependent(value),
        SelectionScalarExprIR::Constant { .. } | SelectionScalarExprIR::Coordinate { .. } => false,
    }
}

pub(crate) fn normalize_frozen_membership_defaults_in_problem_value(
    value: &mut Value,
) -> Result<(), String> {
    let Some(root) = value.as_object_mut() else {
        return Ok(());
    };
    let definitions: Vec<SelectionDefinitionIR> = root
        .get("selections")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| format!("selections: {error}"))?
        .unwrap_or_default();
    let Some(constraints) = root
        .get_mut("magnetization_constraints")
        .and_then(Value::as_array_mut)
    else {
        return Ok(());
    };
    for (index, constraint) in constraints.iter_mut().enumerate() {
        let object = constraint
            .as_object_mut()
            .ok_or_else(|| format!("magnetization_constraints[{index}] must be an object"))?;
        if object.get("kind").and_then(Value::as_str) != Some("frozen_spins")
            || object.contains_key("membership")
        {
            continue;
        }
        let selector: SelectionExprIR =
            serde_json::from_value(object.get("selector").cloned().ok_or_else(|| {
                format!("magnetization_constraints[{index}].selector is required")
            })?)
            .map_err(|error| format!("magnetization_constraints[{index}].selector: {error}"))?;
        let kind = if selection_is_state_dependent(&selector, &definitions) {
            "snapshot_at_activation"
        } else {
            "static"
        };
        object.insert("membership".to_string(), serde_json::json!({"kind": kind}));
    }
    Ok(())
}
