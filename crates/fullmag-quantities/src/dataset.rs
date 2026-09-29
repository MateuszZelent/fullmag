//! Backend-neutral contracts for durable analysis datasets.
//!
//! A dataset definition is an editable recipe. A materialized dataset is an
//! immutable result with its own identity and revision. Presentation recipes
//! refer to either of those identities but never own numerical data.

use crate::QuantityId;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

pub const DATASET_CONTRACT_SCHEMA_VERSION: &str = "1.0.0";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DatasetSource {
    PinnedSolution {
        solution_id: String,
        solution_revision: u64,
    },
    ExplicitResolvedLiveSource {
        session_id: String,
        source_id: String,
        source_revision: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelectionReference {
    pub selection_id: String,
    pub selection_revision: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetAxisKind {
    Time,
    Frequency,
    WaveVector,
    Mode,
    Parameter,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetAxisSelection {
    pub axis_id: String,
    pub kind: DatasetAxisKind,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub coordinate_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DatasetTransform {
    Projection {
        target_space_id: String,
        method: ProjectionMethod,
    },
    Cut {
        selection: SelectionReference,
    },
    Composition {
        component: String,
    },
    Difference {
        rhs_dataset_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        projection: Option<FieldProjection>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvaluationPrecision {
    F32,
    F64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApproximationPolicy {
    ExactOnly,
    AllowDeclaredApproximation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnavailableDataPolicy {
    Fail,
    PreserveUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetEvaluationPolicy {
    pub precision: EvaluationPrecision,
    pub approximation: ApproximationPolicy,
    pub unavailable_data: UnavailableDataPolicy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetDefinition {
    pub schema_version: String,
    pub definition_id: String,
    pub revision: u64,
    pub source: DatasetSource,
    pub domain_selection: SelectionReference,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub axes: Vec<DatasetAxisSelection>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transforms: Vec<DatasetTransform>,
    pub evaluation_policy: DatasetEvaluationPolicy,
}

impl DatasetDefinition {
    pub fn validate(&self) -> Result<(), DatasetContractError> {
        require_schema(&self.schema_version)?;
        require_id("definition_id", &self.definition_id)?;
        validate_source(&self.source)?;
        validate_selection(&self.domain_selection)?;

        let mut axis_ids = BTreeSet::new();
        for axis in &self.axes {
            require_id("axis_id", &axis.axis_id)?;
            if !axis_ids.insert(axis.axis_id.as_str()) {
                return Err(DatasetContractError::DuplicateId {
                    field: "axis_id",
                    value: axis.axis_id.clone(),
                });
            }
            require_unique_ids("coordinate_id", &axis.coordinate_ids)?;
        }

        for transform in &self.transforms {
            match transform {
                DatasetTransform::Projection {
                    target_space_id, ..
                } => require_id("target_space_id", target_space_id)?,
                DatasetTransform::Cut { selection } => validate_selection(selection)?,
                DatasetTransform::Composition { component } => require_id("component", component)?,
                DatasetTransform::Difference {
                    rhs_dataset_id,
                    projection,
                } => {
                    require_id("rhs_dataset_id", rhs_dataset_id)?;
                    if let Some(projection) = projection {
                        validate_projection(projection)?;
                    }
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatasetAvailability {
    Ready,
    NotRecorded,
    NotApplicable,
    NotYetComputed,
    Unsupported,
    Missing,
    Corrupt,
}

impl DatasetAvailability {
    pub const fn has_numeric_payload(self) -> bool {
        matches!(self, Self::Ready)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnavailableAction {
    SelectAvailableQuantity,
    RecomputeFromRecordedState,
    CreateNewRun,
    RepairOrRestoreArtifact,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetStatus {
    pub availability: DatasetAvailability,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<UnavailableAction>,
}

impl DatasetStatus {
    pub fn validate(&self) -> Result<(), DatasetContractError> {
        if self.availability == DatasetAvailability::Ready {
            if self.reason.is_some() || !self.actions.is_empty() {
                return Err(DatasetContractError::ReadyStatusHasUnavailableDetails);
            }
        } else if self
            .reason
            .as_deref()
            .is_none_or(|reason| reason.trim().is_empty())
        {
            return Err(DatasetContractError::UnavailableStatusMissingReason);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetAxisCoordinate {
    pub coordinate_id: String,
    pub value_si: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetAxis {
    pub axis_id: String,
    pub kind: DatasetAxisKind,
    pub unit: String,
    pub coordinates: Vec<DatasetAxisCoordinate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterializedDatasetRef {
    pub dataset_id: String,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetDefinitionRef {
    pub definition_id: String,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetItem {
    pub item_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<DatasetFieldRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetSample {
    pub sample_id: String,
    pub coordinates: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<DatasetItem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldResolution {
    Quantitative,
    PreviewOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComplexEncoding {
    Real,
    RealImagPair,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetFieldDescriptor {
    pub quantity_id: QuantityId,
    pub unit: String,
    pub tensor_rank: u8,
    pub function_space_id: String,
    pub topology_id: String,
    pub layout_digest: String,
    pub complex_encoding: ComplexEncoding,
    pub resolution: FieldResolution,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetFieldRef {
    pub field_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_key: Option<String>,
    pub status: DatasetStatus,
    pub descriptor: DatasetFieldDescriptor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetItemRef {
    pub sample_id: String,
    pub item_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatasetBranch {
    pub branch_id: String,
    pub members: Vec<DatasetItemRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterializedDataset {
    pub schema_version: String,
    pub dataset_id: String,
    pub revision: u64,
    pub definition: DatasetDefinitionRef,
    pub source: DatasetSource,
    pub status: DatasetStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub axes: Vec<DatasetAxis>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub samples: Vec<DatasetSample>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub branches: Vec<DatasetBranch>,
}

impl MaterializedDataset {
    pub fn validate(&self) -> Result<(), DatasetContractError> {
        require_schema(&self.schema_version)?;
        require_id("dataset_id", &self.dataset_id)?;
        require_id("definition_id", &self.definition.definition_id)?;
        validate_source(&self.source)?;
        self.status.validate()?;

        let mut axes = BTreeMap::new();
        for axis in &self.axes {
            require_id("axis_id", &axis.axis_id)?;
            require_id("axis unit", &axis.unit)?;
            if axes.insert(axis.axis_id.as_str(), axis).is_some() {
                return Err(DatasetContractError::DuplicateId {
                    field: "axis_id",
                    value: axis.axis_id.clone(),
                });
            }
            let coordinate_ids = axis
                .coordinates
                .iter()
                .map(|coordinate| coordinate.coordinate_id.clone())
                .collect::<Vec<_>>();
            require_unique_ids("coordinate_id", &coordinate_ids)?;
            if axis
                .coordinates
                .iter()
                .any(|coordinate| !coordinate.value_si.is_finite())
            {
                return Err(DatasetContractError::NonFiniteCoordinate);
            }
        }

        let mut sample_ids = BTreeSet::new();
        let mut item_refs = BTreeSet::new();
        for sample in &self.samples {
            require_id("sample_id", &sample.sample_id)?;
            if !sample_ids.insert(sample.sample_id.as_str()) {
                return Err(DatasetContractError::DuplicateId {
                    field: "sample_id",
                    value: sample.sample_id.clone(),
                });
            }
            for (axis_id, coordinate_id) in &sample.coordinates {
                let axis = axes
                    .get(axis_id.as_str())
                    .ok_or_else(|| DatasetContractError::UnknownAxis(axis_id.clone()))?;
                if !axis
                    .coordinates
                    .iter()
                    .any(|coordinate| coordinate.coordinate_id == *coordinate_id)
                {
                    return Err(DatasetContractError::UnknownCoordinate {
                        axis_id: axis_id.clone(),
                        coordinate_id: coordinate_id.clone(),
                    });
                }
            }
            validate_items(&sample.items)?;
            for item in &sample.items {
                item_refs.insert((sample.sample_id.as_str(), item.item_id.as_str()));
            }
        }

        let mut branch_ids = BTreeSet::new();
        for branch in &self.branches {
            require_id("branch_id", &branch.branch_id)?;
            if !branch_ids.insert(branch.branch_id.as_str()) {
                return Err(DatasetContractError::DuplicateId {
                    field: "branch_id",
                    value: branch.branch_id.clone(),
                });
            }
            if branch.members.is_empty() {
                return Err(DatasetContractError::EmptyBranch(branch.branch_id.clone()));
            }
            let mut members = BTreeSet::new();
            for member in &branch.members {
                require_id("sample_id", &member.sample_id)?;
                require_id("item_id", &member.item_id)?;
                let key = (member.sample_id.as_str(), member.item_id.as_str());
                if !item_refs.contains(&key) {
                    return Err(DatasetContractError::UnknownBranchMember {
                        branch_id: branch.branch_id.clone(),
                        sample_id: member.sample_id.clone(),
                        item_id: member.item_id.clone(),
                    });
                }
                if !members.insert(key) {
                    return Err(DatasetContractError::DuplicateBranchMember {
                        branch_id: branch.branch_id.clone(),
                        sample_id: member.sample_id.clone(),
                        item_id: member.item_id.clone(),
                    });
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DerivedValuePurpose {
    Quantitative,
    Preview,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DerivedOperator {
    Reduction {
        reduction: crate::QuantityReduction,
    },
    Expression {
        expression: String,
    },
    Difference {
        rhs_dataset: MaterializedDatasetRef,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        projection: Option<FieldProjection>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntegrationMeasure {
    pub measure_id: String,
    pub unit: String,
    pub support_selection: SelectionReference,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DerivedValueDefinition {
    pub schema_version: String,
    pub definition_id: String,
    pub revision: u64,
    pub dataset: MaterializedDatasetRef,
    pub operator: DerivedOperator,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integration: Option<IntegrationMeasure>,
    pub required_quantities: Vec<QuantityId>,
    pub required_resolution: FieldResolution,
    pub purpose: DerivedValuePurpose,
    pub producer_version: String,
    pub unavailable_data: UnavailableDataPolicy,
}

impl DerivedValueDefinition {
    pub fn validate(&self) -> Result<(), DatasetContractError> {
        require_schema(&self.schema_version)?;
        require_id("definition_id", &self.definition_id)?;
        require_id("dataset_id", &self.dataset.dataset_id)?;
        require_id("producer_version", &self.producer_version)?;
        if self.required_quantities.is_empty() {
            return Err(DatasetContractError::MissingRequiredQuantities);
        }
        if self.purpose == DerivedValuePurpose::Quantitative
            && self.required_resolution == FieldResolution::PreviewOnly
        {
            return Err(DatasetContractError::PreviewOnlyQuantitativeInput);
        }
        if let DerivedOperator::Expression { expression } = &self.operator {
            require_id("expression", expression)?;
        }
        if let DerivedOperator::Difference {
            rhs_dataset,
            projection,
        } = &self.operator
        {
            require_id("rhs dataset_id", &rhs_dataset.dataset_id)?;
            if let Some(projection) = projection {
                validate_projection(projection)?;
            }
        }
        if let Some(integration) = &self.integration {
            require_id("measure_id", &integration.measure_id)?;
            require_id("measure unit", &integration.unit)?;
            validate_selection(&integration.support_selection)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectionMethod {
    Nearest,
    Linear,
    Conservative,
    L2,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldProjection {
    pub method: ProjectionMethod,
    pub target_space_id: String,
    pub producer_version: String,
}

pub fn validate_field_compatibility(
    left: &DatasetFieldDescriptor,
    right: &DatasetFieldDescriptor,
    projection: Option<&FieldProjection>,
) -> Result<(), DatasetContractError> {
    if left.quantity_id != right.quantity_id
        || left.unit != right.unit
        || left.tensor_rank != right.tensor_rank
        || left.complex_encoding != right.complex_encoding
    {
        return Err(DatasetContractError::IncompatibleFieldSemantics);
    }

    let same_layout = left.function_space_id == right.function_space_id
        && left.topology_id == right.topology_id
        && left.layout_digest == right.layout_digest;
    if !same_layout {
        let projection = projection.ok_or(DatasetContractError::ProjectionRequired)?;
        validate_projection(projection)?;
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PlotSource {
    Dataset {
        dataset: MaterializedDatasetRef,
    },
    DerivedValue {
        definition_id: String,
        revision: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlotKind {
    Line,
    Scatter,
    Heatmap,
    FieldMap,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlotDefinition {
    pub schema_version: String,
    pub definition_id: String,
    pub revision: u64,
    pub source: PlotSource,
    pub plot_kind: PlotKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<[f64; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub palette: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub annotations: Vec<String>,
}

impl PlotDefinition {
    pub fn validate(&self) -> Result<(), DatasetContractError> {
        require_schema(&self.schema_version)?;
        require_id("definition_id", &self.definition_id)?;
        match &self.source {
            PlotSource::Dataset { dataset } => require_id("dataset_id", &dataset.dataset_id)?,
            PlotSource::DerivedValue { definition_id, .. } => {
                require_id("derived definition_id", definition_id)?
            }
        }
        if let Some(range) = self.range {
            if !range[0].is_finite() || !range[1].is_finite() || range[0] >= range[1] {
                return Err(DatasetContractError::InvalidPlotRange);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DatasetContractError {
    UnsupportedSchema(String),
    EmptyId(&'static str),
    DuplicateId {
        field: &'static str,
        value: String,
    },
    UnknownAxis(String),
    UnknownCoordinate {
        axis_id: String,
        coordinate_id: String,
    },
    EmptyBranch(String),
    UnknownBranchMember {
        branch_id: String,
        sample_id: String,
        item_id: String,
    },
    DuplicateBranchMember {
        branch_id: String,
        sample_id: String,
        item_id: String,
    },
    NonFiniteCoordinate,
    ReadyStatusHasUnavailableDetails,
    UnavailableStatusMissingReason,
    MissingRequiredQuantities,
    PreviewOnlyQuantitativeInput,
    IncompatibleFieldSemantics,
    ProjectionRequired,
    ReadyFieldMissingResource,
    InvalidPlotRange,
}

impl fmt::Display for DatasetContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedSchema(schema) => {
                write!(formatter, "unsupported dataset schema '{schema}'")
            }
            Self::EmptyId(field) => write!(formatter, "dataset {field} must not be empty"),
            Self::DuplicateId { field, value } => {
                write!(formatter, "dataset {field} '{value}' must be unique")
            }
            Self::UnknownAxis(axis_id) => write!(formatter, "unknown dataset axis '{axis_id}'"),
            Self::UnknownCoordinate {
                axis_id,
                coordinate_id,
            } => write!(
                formatter,
                "unknown coordinate '{coordinate_id}' for dataset axis '{axis_id}'"
            ),
            Self::EmptyBranch(branch_id) => {
                write!(formatter, "dataset branch '{branch_id}' must have members")
            }
            Self::UnknownBranchMember {
                branch_id,
                sample_id,
                item_id,
            } => write!(
                formatter,
                "dataset branch '{branch_id}' refers to unknown item '{sample_id}/{item_id}'"
            ),
            Self::DuplicateBranchMember {
                branch_id,
                sample_id,
                item_id,
            } => write!(
                formatter,
                "dataset branch '{branch_id}' repeats item '{sample_id}/{item_id}'"
            ),
            Self::NonFiniteCoordinate => formatter.write_str("dataset coordinates must be finite"),
            Self::ReadyStatusHasUnavailableDetails => formatter.write_str(
                "ready dataset status cannot carry unavailable reason or recovery actions",
            ),
            Self::UnavailableStatusMissingReason => {
                formatter.write_str("unavailable dataset status requires a reason")
            }
            Self::MissingRequiredQuantities => {
                formatter.write_str("derived value requires at least one quantity")
            }
            Self::PreviewOnlyQuantitativeInput => formatter
                .write_str("preview-only data cannot be used for a quantitative derived value"),
            Self::IncompatibleFieldSemantics => formatter
                .write_str("field quantity, unit, rank, or complex encoding is incompatible"),
            Self::ProjectionRequired => formatter.write_str(
                "field comparison across different function spaces requires an explicit projection",
            ),
            Self::ReadyFieldMissingResource => {
                formatter.write_str("ready dataset field requires a resource key")
            }
            Self::InvalidPlotRange => {
                formatter.write_str("plot range must be finite and strictly increasing")
            }
        }
    }
}

impl std::error::Error for DatasetContractError {}

fn require_schema(schema: &str) -> Result<(), DatasetContractError> {
    if schema == DATASET_CONTRACT_SCHEMA_VERSION {
        Ok(())
    } else {
        Err(DatasetContractError::UnsupportedSchema(schema.to_string()))
    }
}

fn require_id(field: &'static str, value: &str) -> Result<(), DatasetContractError> {
    if value.trim().is_empty() {
        Err(DatasetContractError::EmptyId(field))
    } else {
        Ok(())
    }
}

fn require_unique_ids(field: &'static str, values: &[String]) -> Result<(), DatasetContractError> {
    let mut unique = BTreeSet::new();
    for value in values {
        require_id(field, value)?;
        if !unique.insert(value.as_str()) {
            return Err(DatasetContractError::DuplicateId {
                field,
                value: value.clone(),
            });
        }
    }
    Ok(())
}

fn validate_source(source: &DatasetSource) -> Result<(), DatasetContractError> {
    match source {
        DatasetSource::PinnedSolution { solution_id, .. } => require_id("solution_id", solution_id),
        DatasetSource::ExplicitResolvedLiveSource {
            session_id,
            source_id,
            ..
        } => {
            require_id("session_id", session_id)?;
            require_id("source_id", source_id)
        }
    }
}

fn validate_selection(selection: &SelectionReference) -> Result<(), DatasetContractError> {
    require_id("selection_id", &selection.selection_id)
}

fn validate_items(items: &[DatasetItem]) -> Result<(), DatasetContractError> {
    let mut item_ids = BTreeSet::new();
    for item in items {
        require_id("item_id", &item.item_id)?;
        if !item_ids.insert(item.item_id.as_str()) {
            return Err(DatasetContractError::DuplicateId {
                field: "item_id",
                value: item.item_id.clone(),
            });
        }
        let mut field_ids = BTreeSet::new();
        for field in &item.fields {
            require_id("field_id", &field.field_id)?;
            if let Some(resource_key) = &field.resource_key {
                require_id("field resource_key", resource_key)?;
            } else if field.status.availability == DatasetAvailability::Ready {
                return Err(DatasetContractError::ReadyFieldMissingResource);
            }
            require_id("field unit", &field.descriptor.unit)?;
            require_id("function_space_id", &field.descriptor.function_space_id)?;
            require_id("topology_id", &field.descriptor.topology_id)?;
            require_id("layout_digest", &field.descriptor.layout_digest)?;
            field.status.validate()?;
            if !field_ids.insert(field.field_id.as_str()) {
                return Err(DatasetContractError::DuplicateId {
                    field: "field_id",
                    value: field.field_id.clone(),
                });
            }
        }
    }
    Ok(())
}

fn validate_projection(projection: &FieldProjection) -> Result<(), DatasetContractError> {
    require_id("projection target_space_id", &projection.target_space_id)?;
    require_id("projection producer_version", &projection.producer_version)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(space: &str, topology: &str, layout: &str) -> DatasetFieldDescriptor {
        DatasetFieldDescriptor {
            quantity_id: QuantityId::M,
            unit: "1".to_string(),
            tensor_rank: 1,
            function_space_id: space.to_string(),
            topology_id: topology.to_string(),
            layout_digest: layout.to_string(),
            complex_encoding: ComplexEncoding::Real,
            resolution: FieldResolution::Quantitative,
        }
    }

    #[test]
    fn unavailable_is_never_numeric_zero() {
        for state in [
            DatasetAvailability::NotRecorded,
            DatasetAvailability::NotApplicable,
            DatasetAvailability::NotYetComputed,
            DatasetAvailability::Unsupported,
            DatasetAvailability::Missing,
            DatasetAvailability::Corrupt,
        ] {
            assert!(!state.has_numeric_payload());
        }
        assert!(DatasetAvailability::Ready.has_numeric_payload());
    }

    #[test]
    fn quantitative_derived_value_rejects_preview_only_input() {
        let definition = DerivedValueDefinition {
            schema_version: DATASET_CONTRACT_SCHEMA_VERSION.to_string(),
            definition_id: "derived:average-m".to_string(),
            revision: 1,
            dataset: MaterializedDatasetRef {
                dataset_id: "dataset:run-1".to_string(),
                revision: 2,
            },
            operator: DerivedOperator::Reduction {
                reduction: crate::QuantityReduction::Average,
            },
            integration: None,
            required_quantities: vec![QuantityId::M],
            required_resolution: FieldResolution::PreviewOnly,
            purpose: DerivedValuePurpose::Quantitative,
            producer_version: "fullmag-quantities/1".to_string(),
            unavailable_data: UnavailableDataPolicy::Fail,
        };

        assert_eq!(
            definition.validate(),
            Err(DatasetContractError::PreviewOnlyQuantitativeInput)
        );
    }

    #[test]
    fn different_function_spaces_require_explicit_projection() {
        let left = field("fdm-cell", "grid:a", "layout:a");
        let right = field("fem-h1", "mesh:b", "layout:b");
        assert_eq!(
            validate_field_compatibility(&left, &right, None),
            Err(DatasetContractError::ProjectionRequired)
        );

        let projection = FieldProjection {
            method: ProjectionMethod::L2,
            target_space_id: "comparison-space".to_string(),
            producer_version: "projector/1".to_string(),
        };
        assert!(validate_field_compatibility(&left, &right, Some(&projection)).is_ok());
    }

    #[test]
    fn materialized_dataset_identity_is_distinct_from_recipe_identity() {
        let serialized = serde_json::to_value(MaterializedDataset {
            schema_version: DATASET_CONTRACT_SCHEMA_VERSION.to_string(),
            dataset_id: "dataset:immutable-result".to_string(),
            revision: 7,
            definition: DatasetDefinitionRef {
                definition_id: "dataset-definition:editable-recipe".to_string(),
                revision: 3,
            },
            source: DatasetSource::PinnedSolution {
                solution_id: "solution:run-1".to_string(),
                solution_revision: 11,
            },
            status: DatasetStatus {
                availability: DatasetAvailability::Ready,
                reason: None,
                actions: Vec::new(),
            },
            axes: Vec::new(),
            samples: Vec::new(),
            branches: Vec::new(),
        })
        .expect("serialize dataset");

        assert_eq!(serialized["dataset_id"], "dataset:immutable-result");
        assert_eq!(
            serialized["definition"]["definition_id"],
            "dataset-definition:editable-recipe"
        );
    }
}
