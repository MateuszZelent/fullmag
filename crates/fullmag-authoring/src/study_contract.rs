//! Typed study-plan contract and migration boundary.
//!
//! A study is an authoring document.  It names immutable model, solver,
//! discretization and execution-profile references, but it does not resolve a
//! backend or start a run.  The application layer consumes this contract when
//! it creates a complete `RunSpecification`.

use crate::builder::{
    MacroStageNode, PrimitiveStageNode, StageGroupNode, StudyMacroStageKind, StudyPipelineDocument,
    StudyPipelineNode, StudyPipelineNodeSource, StudyPrimitiveStageKind,
};
use serde::de::Error as DeError;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

pub const STUDY_PLAN_SCHEMA_VERSION_V1: &str = "study_plan.v1";
pub const STUDY_PLAN_SCHEMA_VERSION: &str = "study_plan.v2";

/// An immutable reference to the model definition captured by a study step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StudyModelReference {
    pub model_id: String,
    pub version: String,
}

/// A solver preset is configuration data, separate from the requested
/// execution profile and from the physical model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StudySolverConfigReference {
    pub preset_id: String,
    pub version: String,
}

/// A discretization recipe is named independently of the solver preset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StudyDiscretizationReference {
    pub recipe_id: String,
    pub version: String,
}

/// An execution profile contains operational intent (device, precision and
/// mode).  Runtime capability resolution still belongs to the planner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StudyExecutionProfileReference {
    pub profile_id: String,
    pub version: String,
}

/// The data kind carried by a typed study port.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StudyPortDataKind {
    InitialState,
    State,
    Field,
    Scalar,
    Table,
    Mesh,
    Operator,
    Artifact,
    RunRecord,
}

/// A typed source for an input port.  There is no `latest` or implicit current
/// session source: each accepted run resolves one of these variants.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum StudyInputSource {
    AuthoredInitialState {
        reference: String,
    },
    PinnedArtifact {
        artifact_id: String,
        content_sha256: String,
    },
    StepOutput {
        step_id: String,
        port: String,
        case_id: String,
    },
    ExplicitContinuation {
        run_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StudyInputPort {
    pub port_id: String,
    pub data_kind: StudyPortDataKind,
    #[serde(default = "default_true")]
    pub required: bool,
    pub source: StudyInputSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StudyOutputPort {
    pub port_id: String,
    pub data_kind: StudyPortDataKind,
}

/// A typed scientific acceptance policy, kept separate from task lifecycle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum StudyAcceptancePolicy {
    Any,
    Converged,
    Tolerance { metric: String, threshold: f64 },
    StepLimit { max_steps: u64 },
}

/// Acquisition policy is a planning hint and never a permission to evict a
/// live runtime lease implicitly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StudyAcquisitionPolicy {
    Exclusive,
    Shared,
    PreferResident,
    Fresh,
}

/// Typed primitive, macro and group steps.  Unknown top-level kinds are read
/// into `Unsupported` so the source payload survives and can be blocked by the
/// planner instead of being silently discarded.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StudyStepKind {
    Primitive {
        stage_kind: StudyPrimitiveStageKind,
    },
    Macro {
        macro_kind: StudyMacroStageKind,
    },
    Group {
        child_step_ids: Vec<String>,
    },
    Unsupported {
        #[serde(rename = "original_kind")]
        unsupported_kind: String,
        payload: Value,
    },
}

impl<'de> Deserialize<'de> for StudyStepKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = Value::deserialize(deserializer)?;
        let kind = raw
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| D::Error::custom("study step kind requires a string kind"))?;

        match kind {
            "primitive" | "macro" | "group" | "unsupported" => {
                match serde_json::from_value::<KnownStudyStepKind>(raw.clone()) {
                    Ok(known) => Ok(known.into()),
                    Err(_) => Ok(Self::Unsupported {
                        unsupported_kind: kind.to_string(),
                        payload: raw,
                    }),
                }
            }
            _ => Ok(Self::Unsupported {
                unsupported_kind: kind.to_string(),
                payload: raw,
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum KnownStudyStepKind {
    Primitive {
        stage_kind: StudyPrimitiveStageKind,
    },
    Macro {
        macro_kind: StudyMacroStageKind,
    },
    Group {
        child_step_ids: Vec<String>,
    },
    Unsupported {
        #[serde(rename = "original_kind")]
        unsupported_kind: String,
        payload: Value,
    },
}

impl From<KnownStudyStepKind> for StudyStepKind {
    fn from(value: KnownStudyStepKind) -> Self {
        match value {
            KnownStudyStepKind::Primitive { stage_kind } => Self::Primitive { stage_kind },
            KnownStudyStepKind::Macro { macro_kind } => Self::Macro { macro_kind },
            KnownStudyStepKind::Group { child_step_ids } => Self::Group { child_step_ids },
            KnownStudyStepKind::Unsupported {
                unsupported_kind,
                payload,
            } => Self::Unsupported {
                unsupported_kind,
                payload,
            },
        }
    }
}

impl StudyStepKind {
    pub fn kind_name(&self) -> &str {
        match self {
            Self::Primitive { .. } => "primitive",
            Self::Macro { .. } => "macro",
            Self::Group { .. } => "group",
            Self::Unsupported {
                unsupported_kind, ..
            } => unsupported_kind,
        }
    }

    fn unsupported_reason(&self) -> Option<String> {
        match self {
            Self::Unsupported {
                unsupported_kind, ..
            } => Some(format!(
                "unsupported study step kind `{unsupported_kind}` is preserved but requires an explicit lowering"
            )),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StudyStep {
    pub step_id: String,
    pub label: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<StudyPipelineNodeSource>,
    pub kind: StudyStepKind,
    pub model: StudyModelReference,
    pub solver_config: StudySolverConfigReference,
    pub discretization: StudyDiscretizationReference,
    pub execution_profile: StudyExecutionProfileReference,
    /// Required duration for time-evolution tasks. The value is captured at
    /// Submit and passed to the runner; it is not inferred from sampling or
    /// legacy payloads after acceptance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until_seconds: Option<f64>,
    #[serde(default)]
    pub inputs: Vec<StudyInputPort>,
    #[serde(default)]
    pub outputs: Vec<StudyOutputPort>,
    pub acceptance: StudyAcceptancePolicy,
    pub acquisition: StudyAcquisitionPolicy,
    /// Legacy payload is retained during migration for audit and explicit
    /// lowering.  It is never interpreted as solver configuration here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_payload: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StudyPlan {
    pub schema_version: String,
    pub study_id: String,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_pipeline_version: Option<String>,
    #[serde(default)]
    pub steps: Vec<StudyStep>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StudyContractError {
    Invalid(String),
    DuplicateId(String),
    UnknownReference { from: String, to: String },
    PortMismatch { step: String, port: String },
    Cycle(Vec<String>),
    Unsupported(String),
}

impl std::fmt::Display for StudyContractError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(message) => formatter.write_str(message),
            Self::DuplicateId(id) => write!(formatter, "duplicate study identifier `{id}`"),
            Self::UnknownReference { from, to } => {
                write!(
                    formatter,
                    "study reference from `{from}` targets unknown `{to}`"
                )
            }
            Self::PortMismatch { step, port } => {
                write!(
                    formatter,
                    "study step `{step}` has incompatible or unknown port `{port}`"
                )
            }
            Self::Cycle(steps) => {
                write!(formatter, "study dependency cycle: {}", steps.join(" -> "))
            }
            Self::Unsupported(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for StudyContractError {}

impl StudyPlan {
    pub fn validate(&self) -> Result<(), StudyContractError> {
        let is_legacy_v1 = self.schema_version == STUDY_PLAN_SCHEMA_VERSION_V1;
        if !is_legacy_v1 && self.schema_version != STUDY_PLAN_SCHEMA_VERSION {
            return Err(StudyContractError::Invalid(format!(
                "schema_version must be {STUDY_PLAN_SCHEMA_VERSION_V1} or {STUDY_PLAN_SCHEMA_VERSION}, got {}",
                self.schema_version
            )));
        }
        require_identifier(&self.study_id, "study_id")?;

        let mut step_ids = BTreeSet::new();
        for step in &self.steps {
            validate_step_references(step)?;
            if let Some(until_seconds) = step.until_seconds {
                if !until_seconds.is_finite() || until_seconds <= 0.0 {
                    return Err(StudyContractError::Invalid(format!(
                        "study step `{}` until_seconds must be finite and greater than zero",
                        step.step_id
                    )));
                }
                if is_legacy_v1 {
                    return Err(StudyContractError::Invalid(
                        "until_seconds requires study_plan.v2; legacy study_plan.v1 is read-only"
                            .into(),
                    ));
                }
            }
            if !step_ids.insert(step.step_id.as_str()) {
                return Err(StudyContractError::DuplicateId(step.step_id.clone()));
            }
        }

        let outputs = self
            .steps
            .iter()
            .map(|step| {
                (
                    step.step_id.as_str(),
                    step.outputs
                        .iter()
                        .map(|port| (port.port_id.as_str(), port.data_kind))
                        .collect::<BTreeMap<_, _>>(),
                )
            })
            .collect::<BTreeMap<_, _>>();

        let mut dependencies = BTreeMap::<String, BTreeSet<String>>::new();
        for step in &self.steps {
            dependencies.entry(step.step_id.clone()).or_default();
            if let StudyStepKind::Group { child_step_ids } = &step.kind {
                for child in child_step_ids {
                    if !step_ids.contains(child.as_str()) {
                        return Err(StudyContractError::UnknownReference {
                            from: step.step_id.clone(),
                            to: child.clone(),
                        });
                    }
                    dependencies
                        .entry(step.step_id.clone())
                        .or_default()
                        .insert(child.clone());
                }
            }
            for input in &step.inputs {
                let StudyInputSource::StepOutput { step_id, port, .. } = &input.source else {
                    continue;
                };
                if !step_ids.contains(step_id.as_str()) {
                    return Err(StudyContractError::UnknownReference {
                        from: step.step_id.clone(),
                        to: step_id.clone(),
                    });
                }
                let Some(source_kind) = outputs
                    .get(step_id.as_str())
                    .and_then(|ports| ports.get(port.as_str()))
                else {
                    return Err(StudyContractError::PortMismatch {
                        step: step_id.clone(),
                        port: port.clone(),
                    });
                };
                if *source_kind != input.data_kind {
                    return Err(StudyContractError::PortMismatch {
                        step: step.step_id.clone(),
                        port: input.port_id.clone(),
                    });
                }
                dependencies
                    .entry(step.step_id.clone())
                    .or_default()
                    .insert(step_id.clone());
            }
        }

        let _ = topological_order(&dependencies)?;
        Ok(())
    }

    /// Structural validation plus the explicit unsupported-kind blocker.
    pub fn validate_for_execution(&self) -> Result<(), StudyContractError> {
        self.validate()?;
        let blockers = self.unsupported_diagnostics();
        if blockers.is_empty() {
            Ok(())
        } else {
            Err(StudyContractError::Unsupported(blockers.join("; ")))
        }
    }

    pub fn unsupported_diagnostics(&self) -> Vec<String> {
        self.steps
            .iter()
            .filter_map(|step| {
                step.kind
                    .unsupported_reason()
                    .map(|reason| format!("step `{}`: {reason}", step.step_id))
            })
            .collect()
    }

    pub fn is_executable(&self) -> bool {
        self.validate_for_execution().is_ok()
    }

    pub fn topological_order(&self) -> Result<Vec<String>, StudyContractError> {
        self.validate()?;
        let mut dependencies = BTreeMap::<String, BTreeSet<String>>::new();
        for step in &self.steps {
            dependencies.entry(step.step_id.clone()).or_default();
            if let StudyStepKind::Group { child_step_ids } = &step.kind {
                dependencies
                    .entry(step.step_id.clone())
                    .or_default()
                    .extend(child_step_ids.iter().cloned());
            }
            for input in &step.inputs {
                if let StudyInputSource::StepOutput { step_id, .. } = &input.source {
                    dependencies
                        .entry(step.step_id.clone())
                        .or_default()
                        .insert(step_id.clone());
                }
            }
        }
        topological_order(&dependencies)
    }

    pub fn canonical_json_bytes(&self) -> Result<Vec<u8>, serde_json::Error> {
        canonical_json_bytes(&serde_json::to_value(self)?)
    }

    pub fn canonical_sha256(&self) -> Result<String, serde_json::Error> {
        Ok(format!(
            "{:x}",
            Sha256::digest(self.canonical_json_bytes()?)
        ))
    }

    /// Convert the current authoring pipeline into the typed contract. The
    /// legacy payload is kept on each migrated step. Only the documented
    /// `Run.until_seconds` field is projected into typed run control; payload
    /// data is never guessed or reinterpreted as a solver preset.
    pub fn from_pipeline(
        study_id: impl Into<String>,
        revision: u64,
        document: &StudyPipelineDocument,
        defaults: &StudyPlanMigrationDefaults,
    ) -> Result<Self, StudyContractError> {
        let mut steps = Vec::new();
        for node in &document.nodes {
            migrate_node(node, defaults, &mut steps)?;
        }
        let plan = Self {
            schema_version: STUDY_PLAN_SCHEMA_VERSION.to_string(),
            study_id: study_id.into(),
            revision,
            source_pipeline_version: Some(document.version.clone()),
            steps,
        };
        plan.validate()?;
        Ok(plan)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StudyPlanMigrationDefaults {
    pub model: StudyModelReference,
    pub solver_config: StudySolverConfigReference,
    pub discretization: StudyDiscretizationReference,
    pub execution_profile: StudyExecutionProfileReference,
}

fn migrate_node(
    node: &StudyPipelineNode,
    defaults: &StudyPlanMigrationDefaults,
    steps: &mut Vec<StudyStep>,
) -> Result<(), StudyContractError> {
    let (step_id, label, enabled, notes, source, kind, legacy_payload) = match node {
        StudyPipelineNode::Primitive(PrimitiveStageNode {
            id,
            label,
            enabled,
            notes,
            source,
            stage_kind,
            payload,
        }) => (
            id,
            label,
            *enabled,
            notes.clone(),
            *source,
            StudyStepKind::Primitive {
                stage_kind: *stage_kind,
            },
            Some(Value::Object(
                payload
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect(),
            )),
        ),
        StudyPipelineNode::Macro(MacroStageNode {
            id,
            label,
            enabled,
            notes,
            source,
            macro_kind,
            config,
        }) => (
            id,
            label,
            *enabled,
            notes.clone(),
            *source,
            StudyStepKind::Macro {
                macro_kind: *macro_kind,
            },
            Some(Value::Object(
                config
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect(),
            )),
        ),
        StudyPipelineNode::Group(StageGroupNode {
            id,
            label,
            enabled,
            notes,
            source,
            collapsed,
            children,
        }) => {
            for child in children {
                migrate_node(child, defaults, steps)?;
            }
            let child_step_ids = children.iter().map(node_id).collect::<Vec<_>>();
            (
                id,
                label,
                *enabled,
                notes.clone(),
                *source,
                StudyStepKind::Group { child_step_ids },
                Some(serde_json::json!({ "collapsed": collapsed })),
            )
        }
    };
    let until_seconds = match &kind {
        StudyStepKind::Primitive {
            stage_kind: StudyPrimitiveStageKind::Run,
        } => migrate_run_duration(legacy_payload.as_ref())?,
        _ => None,
    };

    steps.push(StudyStep {
        step_id: step_id.clone(),
        label: label.clone(),
        enabled,
        notes,
        source,
        kind,
        model: defaults.model.clone(),
        solver_config: defaults.solver_config.clone(),
        discretization: defaults.discretization.clone(),
        execution_profile: defaults.execution_profile.clone(),
        until_seconds,
        inputs: Vec::new(),
        outputs: Vec::new(),
        acceptance: StudyAcceptancePolicy::Any,
        acquisition: StudyAcquisitionPolicy::Exclusive,
        legacy_payload,
    });
    Ok(())
}

fn migrate_run_duration(payload: Option<&Value>) -> Result<Option<f64>, StudyContractError> {
    let Some(value) = payload
        .and_then(Value::as_object)
        .and_then(|payload| payload.get("until_seconds"))
    else {
        return Ok(None);
    };
    let duration = match value {
        Value::Null => return Ok(None),
        Value::Number(number) => number.as_f64(),
        Value::String(text) if text.trim().is_empty() => return Ok(None),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
    .ok_or_else(|| {
        StudyContractError::Invalid(
            "legacy Run step until_seconds must be a finite positive number".into(),
        )
    })?;
    if !duration.is_finite() || duration <= 0.0 {
        return Err(StudyContractError::Invalid(
            "legacy Run step until_seconds must be a finite positive number".into(),
        ));
    }
    Ok(Some(duration))
}

fn node_id(node: &StudyPipelineNode) -> String {
    match node {
        StudyPipelineNode::Primitive(node) => node.id.clone(),
        StudyPipelineNode::Macro(node) => node.id.clone(),
        StudyPipelineNode::Group(node) => node.id.clone(),
    }
}

fn validate_step_references(step: &StudyStep) -> Result<(), StudyContractError> {
    require_identifier(&step.step_id, "step_id")?;
    if step.label.trim().is_empty() {
        return Err(StudyContractError::Invalid(format!(
            "study step `{}` label must not be empty",
            step.step_id
        )));
    }
    validate_reference(&step.model.model_id, "model_id")?;
    validate_reference(&step.model.version, "model.version")?;
    validate_reference(&step.solver_config.preset_id, "solver_config.preset_id")?;
    validate_reference(&step.solver_config.version, "solver_config.version")?;
    validate_reference(&step.discretization.recipe_id, "discretization.recipe_id")?;
    validate_reference(&step.discretization.version, "discretization.version")?;
    validate_reference(
        &step.execution_profile.profile_id,
        "execution_profile.profile_id",
    )?;
    validate_reference(&step.execution_profile.version, "execution_profile.version")?;

    let mut input_ids = BTreeSet::new();
    for input in &step.inputs {
        if !input_ids.insert(input.port_id.as_str()) {
            return Err(StudyContractError::DuplicateId(format!(
                "{}::{}",
                step.step_id, input.port_id
            )));
        }
        validate_reference(&input.port_id, "input.port_id")?;
        validate_input_source(&input.source)?;
    }
    let mut output_ids = BTreeSet::new();
    for output in &step.outputs {
        if !output_ids.insert(output.port_id.as_str()) {
            return Err(StudyContractError::DuplicateId(format!(
                "{}::{}",
                step.step_id, output.port_id
            )));
        }
        validate_reference(&output.port_id, "output.port_id")?;
    }
    match &step.acceptance {
        StudyAcceptancePolicy::Any | StudyAcceptancePolicy::Converged => {}
        StudyAcceptancePolicy::Tolerance { metric, threshold } => {
            validate_reference(metric, "acceptance.metric")?;
            if !threshold.is_finite() || *threshold <= 0.0 {
                return Err(StudyContractError::Invalid(
                    "acceptance.threshold must be finite and greater than zero".to_string(),
                ));
            }
        }
        StudyAcceptancePolicy::StepLimit { max_steps } if *max_steps == 0 => {
            return Err(StudyContractError::Invalid(
                "acceptance.max_steps must be greater than zero".to_string(),
            ));
        }
        StudyAcceptancePolicy::StepLimit { .. } => {}
    }
    Ok(())
}

fn validate_input_source(source: &StudyInputSource) -> Result<(), StudyContractError> {
    match source {
        StudyInputSource::AuthoredInitialState { reference } => {
            validate_reference(reference, "input.source.reference")
        }
        StudyInputSource::PinnedArtifact {
            artifact_id,
            content_sha256,
        } => {
            validate_reference(artifact_id, "input.source.artifact_id")?;
            validate_sha256(content_sha256, "input.source.content_sha256")
        }
        StudyInputSource::StepOutput {
            step_id,
            port,
            case_id,
        } => {
            validate_reference(step_id, "input.source.step_id")?;
            validate_reference(port, "input.source.port")?;
            validate_reference(case_id, "input.source.case_id")
        }
        StudyInputSource::ExplicitContinuation { run_id } => {
            validate_reference(run_id, "input.source.run_id")
        }
    }
}

fn validate_reference(value: &str, field: &str) -> Result<(), StudyContractError> {
    require_identifier(value, field)
}

fn require_identifier(value: &str, field: &str) -> Result<(), StudyContractError> {
    if value.trim().is_empty()
        || value.len() > 256
        || value.chars().any(|character| {
            character.is_control() || matches!(character, '/' | '\\' | '\n' | '\r' | '\t')
        })
    {
        return Err(StudyContractError::Invalid(format!(
            "{field} must be a non-empty portable identifier"
        )));
    }
    Ok(())
}

fn validate_sha256(value: &str, field: &str) -> Result<(), StudyContractError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(StudyContractError::Invalid(format!(
            "{field} must be a lowercase or uppercase 64-character SHA-256 digest"
        )));
    }
    Ok(())
}

fn default_true() -> bool {
    true
}

fn topological_order(
    dependencies: &BTreeMap<String, BTreeSet<String>>,
) -> Result<Vec<String>, StudyContractError> {
    let mut remaining = dependencies.clone();
    let mut ready = dependencies
        .iter()
        .filter_map(|(step, deps)| deps.is_empty().then_some(step.clone()))
        .collect::<VecDeque<_>>();
    let mut order = Vec::with_capacity(dependencies.len());

    while let Some(step) = ready.pop_front() {
        order.push(step.clone());
        for deps in remaining.values_mut() {
            deps.remove(&step);
        }
        let newly_ready = remaining
            .iter()
            .filter_map(|(candidate, deps)| {
                (!order.iter().any(|item| item == candidate) && deps.is_empty())
                    .then_some(candidate.clone())
            })
            .collect::<Vec<_>>();
        for candidate in newly_ready {
            if !ready.contains(&candidate) {
                ready.push_back(candidate);
            }
        }
    }

    if order.len() != dependencies.len() {
        let cycle = remaining
            .iter()
            .filter_map(|(step, deps)| (!deps.is_empty()).then_some(step.clone()))
            .collect();
        return Err(StudyContractError::Cycle(cycle));
    }
    Ok(order)
}

fn canonical_json_bytes(value: &Value) -> Result<Vec<u8>, serde_json::Error> {
    let mut output = Vec::new();
    write_canonical_json(value, &mut output)?;
    Ok(output)
}

fn write_canonical_json(value: &Value, output: &mut Vec<u8>) -> Result<(), serde_json::Error> {
    match value {
        Value::Null => output.extend_from_slice(b"null"),
        Value::Bool(value) => output.extend_from_slice(if *value { b"true" } else { b"false" }),
        Value::Number(value) => output.extend_from_slice(value.to_string().as_bytes()),
        Value::String(value) => write_ascii_json_string(value, output),
        Value::Array(values) => {
            output.push(b'[');
            for (index, item) in values.iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                write_canonical_json(item, output)?;
            }
            output.push(b']');
        }
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            output.push(b'{');
            for (index, key) in keys.into_iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                write_ascii_json_string(key, output);
                output.push(b':');
                write_canonical_json(&values[key], output)?;
            }
            output.push(b'}');
        }
    }
    Ok(())
}

fn write_ascii_json_string(value: &str, output: &mut Vec<u8>) {
    output.push(b'"');
    for character in value.chars() {
        match character {
            '"' => output.extend_from_slice(b"\\\""),
            '\\' => output.extend_from_slice(b"\\\\"),
            '\u{08}' => output.extend_from_slice(b"\\b"),
            '\u{09}' => output.extend_from_slice(b"\\t"),
            '\u{0a}' => output.extend_from_slice(b"\\n"),
            '\u{0c}' => output.extend_from_slice(b"\\f"),
            '\u{0d}' => output.extend_from_slice(b"\\r"),
            character if character <= '\u{1f}' => write_unicode_escape(character as u32, output),
            character if character.is_ascii() => output.push(character as u8),
            character => {
                let codepoint = character as u32;
                if codepoint <= 0xffff {
                    write_unicode_escape(codepoint, output);
                } else {
                    let shifted = codepoint - 0x1_0000;
                    write_unicode_escape(0xd800 + (shifted >> 10), output);
                    write_unicode_escape(0xdc00 + (shifted & 0x3ff), output);
                }
            }
        }
    }
    output.push(b'"');
}

fn write_unicode_escape(codepoint: u32, output: &mut Vec<u8>) {
    output.extend_from_slice(format!("\\u{codepoint:04x}").as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn defaults() -> StudyPlanMigrationDefaults {
        StudyPlanMigrationDefaults {
            model: StudyModelReference {
                model_id: "model:one".to_string(),
                version: "v1".to_string(),
            },
            solver_config: StudySolverConfigReference {
                preset_id: "solver:default".to_string(),
                version: "v1".to_string(),
            },
            discretization: StudyDiscretizationReference {
                recipe_id: "mesh:default".to_string(),
                version: "v1".to_string(),
            },
            execution_profile: StudyExecutionProfileReference {
                profile_id: "exec:auto".to_string(),
                version: "v1".to_string(),
            },
        }
    }

    #[test]
    fn unknown_kind_is_preserved_and_blocks_execution() {
        let value = json!({
            "schema_version": STUDY_PLAN_SCHEMA_VERSION,
            "study_id": "study:one",
            "revision": 1,
            "steps": [{
                "step_id": "step:one",
                "label": "future",
                "kind": {
                    "kind": "future_solver",
                    "future_payload": {"alpha": 3}
                },
                "model": {"model_id": "m", "version": "v1"},
                "solver_config": {"preset_id": "s", "version": "v1"},
                "discretization": {"recipe_id": "d", "version": "v1"},
                "execution_profile": {"profile_id": "e", "version": "v1"},
                "acceptance": {"kind": "any"},
                "acquisition": "exclusive"
            }]
        });
        let plan: StudyPlan = serde_json::from_value(value).expect("typed plan");
        assert!(plan.validate().is_ok());
        assert!(!plan.is_executable());
        assert_eq!(plan.steps[0].kind.kind_name(), "future_solver");
        assert!(plan.validate_for_execution().is_err());
        let StudyStepKind::Unsupported { payload, .. } = &plan.steps[0].kind else {
            panic!("unknown step must retain its source payload");
        };
        assert_eq!(
            payload,
            &json!({
                "kind": "future_solver", "future_payload": {"alpha": 3}
            })
        );
        let encoded = serde_json::to_value(&plan).expect("serialize preserved plan");
        let restored: StudyPlan = serde_json::from_value(encoded).expect("reload preserved plan");
        assert_eq!(restored, plan);
        assert!(restored.validate_for_execution().is_err());
        assert!(plan.canonical_sha256().is_ok());
    }

    #[test]
    fn legacy_pipeline_migrates_without_dropping_payload() {
        let document = StudyPipelineDocument {
            version: "study_pipeline.v2".to_string(),
            nodes: vec![StudyPipelineNode::Primitive(PrimitiveStageNode {
                id: "step:relax".to_string(),
                label: "Relax".to_string(),
                enabled: true,
                notes: None,
                source: Some(StudyPipelineNodeSource::UiAuthored),
                stage_kind: StudyPrimitiveStageKind::Relax,
                payload: [("steps".to_string(), json!(12))].into_iter().collect(),
            })],
        };
        let plan = StudyPlan::from_pipeline("study:one", 1, &document, &defaults()).unwrap();
        assert_eq!(plan.steps.len(), 1);
        assert_eq!(
            plan.steps[0]
                .legacy_payload
                .as_ref()
                .and_then(Value::as_object)
                .and_then(|payload| payload.get("steps")),
            Some(&json!(12))
        );
    }

    #[test]
    fn run_duration_is_migrated_to_the_versioned_typed_contract() {
        let document = StudyPipelineDocument {
            version: "study_pipeline.v2".to_string(),
            nodes: vec![StudyPipelineNode::Primitive(PrimitiveStageNode {
                id: "step:run".to_string(),
                label: "Run".to_string(),
                enabled: true,
                notes: None,
                source: Some(StudyPipelineNodeSource::UiAuthored),
                stage_kind: StudyPrimitiveStageKind::Run,
                payload: [("until_seconds".to_string(), json!("2.5e-9"))]
                    .into_iter()
                    .collect(),
            })],
        };
        let plan = StudyPlan::from_pipeline("study:run", 1, &document, &defaults()).unwrap();
        assert_eq!(plan.schema_version, STUDY_PLAN_SCHEMA_VERSION);
        assert_eq!(plan.steps[0].until_seconds, Some(2.5e-9));
        assert_eq!(
            plan.steps[0]
                .legacy_payload
                .as_ref()
                .and_then(Value::as_object)
                .and_then(|payload| payload.get("until_seconds")),
            Some(&json!("2.5e-9"))
        );
        let mut changed_horizon = plan.clone();
        changed_horizon.steps[0].until_seconds = Some(3.0e-9);
        assert_ne!(
            plan.canonical_sha256().unwrap(),
            changed_horizon.canonical_sha256().unwrap()
        );
        assert!(plan.validate().is_ok());
    }

    #[test]
    fn legacy_v1_study_plan_remains_readable_but_cannot_claim_v2_duration() {
        let legacy: StudyPlan = serde_json::from_value(json!({
            "schema_version": STUDY_PLAN_SCHEMA_VERSION_V1,
            "study_id": "study:legacy",
            "revision": 1,
            "steps": [{
                "step_id": "step:run",
                "label": "Run",
                "kind": {"kind": "primitive", "stage_kind": "run"},
                "model": {"model_id": "model:one", "version": "v1"},
                "solver_config": {"preset_id": "solver:default", "version": "v1"},
                "discretization": {"recipe_id": "mesh:default", "version": "v1"},
                "execution_profile": {"profile_id": "exec:auto", "version": "v1"},
                "acceptance": {"kind": "any"},
                "acquisition": "exclusive"
            }]
        }))
        .unwrap();
        assert!(legacy.validate().is_ok());
        assert_eq!(legacy.canonical_sha256().unwrap().len(), 64);

        let mut mislabeled = legacy;
        mislabeled.steps[0].until_seconds = Some(1e-9);
        assert!(mislabeled.validate().is_err());
    }

    #[test]
    fn run_duration_migration_rejects_nonpositive_and_nonfinite_values() {
        for duration in [json!(0), json!(-1), json!("NaN"), json!("inf")] {
            let document = StudyPipelineDocument {
                version: "study_pipeline.v2".to_string(),
                nodes: vec![StudyPipelineNode::Primitive(PrimitiveStageNode {
                    id: "step:run".to_string(),
                    label: "Run".to_string(),
                    enabled: true,
                    notes: None,
                    source: None,
                    stage_kind: StudyPrimitiveStageKind::Run,
                    payload: [("until_seconds".to_string(), duration)]
                        .into_iter()
                        .collect(),
                })],
            };
            assert!(
                StudyPlan::from_pipeline("study:invalid-run", 1, &document, &defaults()).is_err()
            );
        }
    }
}
