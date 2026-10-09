use crate::eigen_contract::{KPointIR, SampleSelectorIR};
use crate::study::{
    AutosaveFormatIR, AutosaveLayoutIR, EquilibriumSourceIR, FieldAutosaveIR, KSamplingIR,
    OutputIR, SamplingIR, SamplingPeriodPolicyIR, StageAutosaveIR, TableAutosaveIR,
};
use crate::FrequencyResponseOutputIR;
use serde::de::{DeserializeSeed, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use std::fmt;

fn default_v04_nyquist_guard_factor() -> f64 {
    crate::study::AUTO_SINC_NYQUIST_GUARD_FACTOR
}

fn default_v04_table_autosave_kind() -> String {
    "table_autosave".to_string()
}

fn default_v04_table_id() -> String {
    "default".to_string()
}

fn default_v04_field_autosave_kind() -> String {
    "field_autosave".to_string()
}

fn default_v04_stage_autosave_kind() -> String {
    "stage_autosave".to_string()
}

fn default_v04_include_branch_table() -> bool {
    true
}

fn default_v04_eigen_diagnostic_flag() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum SamplingPeriodPolicyV04Wire {
    AutoSincCutoff {
        #[serde(default = "default_v04_nyquist_guard_factor")]
        nyquist_guard_factor: f64,
    },
}

impl From<SamplingPeriodPolicyV04Wire> for SamplingPeriodPolicyIR {
    fn from(policy: SamplingPeriodPolicyV04Wire) -> Self {
        match policy {
            SamplingPeriodPolicyV04Wire::AutoSincCutoff {
                nyquist_guard_factor,
            } => Self::AutoSincCutoff {
                nyquist_guard_factor,
            },
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SampleSelectorV04Wire {
    #[serde(default)]
    sample_indices: Vec<u32>,
    #[serde(default)]
    sample_labels: Vec<String>,
}

impl From<SampleSelectorV04Wire> for SampleSelectorIR {
    fn from(selector: SampleSelectorV04Wire) -> Self {
        Self {
            sample_indices: selector.sample_indices,
            sample_labels: selector.sample_labels,
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum OutputV04Wire {
    Field {
        name: String,
        every_seconds: f64,
    },
    FieldAuto {
        name: String,
        sample_period_policy: SamplingPeriodPolicyV04Wire,
    },
    FieldResolvedAuto {
        name: String,
        every_seconds: f64,
        requested_policy: SamplingPeriodPolicyV04Wire,
    },
    Scalar {
        name: String,
        every_seconds: f64,
    },
    ScalarAuto {
        name: String,
        sample_period_policy: SamplingPeriodPolicyV04Wire,
    },
    ScalarResolvedAuto {
        name: String,
        every_seconds: f64,
        requested_policy: SamplingPeriodPolicyV04Wire,
    },
    Snapshot {
        field: String,
        component: String,
        every_seconds: f64,
        #[serde(default)]
        layer: Option<String>,
    },
    EigenSpectrum {
        quantity: String,
    },
    EigenMode {
        field: String,
        #[serde(default)]
        all_modes: bool,
        #[serde(default)]
        indices: Vec<u32>,
        #[serde(default)]
        branches: Vec<u32>,
        #[serde(default)]
        sample_selector: Option<SampleSelectorV04Wire>,
    },
    DispersionCurve {
        name: String,
        #[serde(default = "default_v04_include_branch_table")]
        include_branch_table: bool,
    },
    FrequencyResponseOutput {
        observable: FrequencyResponseOutputIR,
    },
    EigenDiagnostics {
        #[serde(default = "default_v04_eigen_diagnostic_flag")]
        include_tracking: bool,
        #[serde(default = "default_v04_eigen_diagnostic_flag")]
        include_residuals: bool,
        #[serde(default = "default_v04_eigen_diagnostic_flag")]
        include_overlaps: bool,
        #[serde(default = "default_v04_eigen_diagnostic_flag")]
        include_tangent_leakage: bool,
        #[serde(default = "default_v04_eigen_diagnostic_flag")]
        include_orthogonality: bool,
    },
    SaveQuantity {
        quantity_id: String,
        every_seconds: f64,
        #[serde(default)]
        reduction: Option<String>,
        #[serde(default)]
        component: Option<String>,
    },
}

impl From<OutputV04Wire> for OutputIR {
    fn from(output: OutputV04Wire) -> Self {
        match output {
            OutputV04Wire::Field { name, every_seconds } => Self::Field { name, every_seconds },
            OutputV04Wire::FieldAuto {
                name,
                sample_period_policy,
            } => Self::FieldAuto {
                name,
                sample_period_policy: sample_period_policy.into(),
            },
            OutputV04Wire::FieldResolvedAuto {
                name,
                every_seconds,
                requested_policy,
            } => Self::FieldResolvedAuto {
                name,
                every_seconds,
                requested_policy: requested_policy.into(),
            },
            OutputV04Wire::Scalar { name, every_seconds } => Self::Scalar { name, every_seconds },
            OutputV04Wire::ScalarAuto {
                name,
                sample_period_policy,
            } => Self::ScalarAuto {
                name,
                sample_period_policy: sample_period_policy.into(),
            },
            OutputV04Wire::ScalarResolvedAuto {
                name,
                every_seconds,
                requested_policy,
            } => Self::ScalarResolvedAuto {
                name,
                every_seconds,
                requested_policy: requested_policy.into(),
            },
            OutputV04Wire::Snapshot {
                field,
                component,
                every_seconds,
                layer,
            } => Self::Snapshot {
                field,
                component,
                every_seconds,
                layer,
            },
            OutputV04Wire::EigenSpectrum { quantity } => Self::EigenSpectrum { quantity },
            OutputV04Wire::EigenMode {
                field,
                all_modes,
                indices,
                branches,
                sample_selector,
            } => Self::EigenMode {
                field,
                all_modes,
                indices,
                branches,
                sample_selector: sample_selector.map(Into::into),
            },
            OutputV04Wire::DispersionCurve {
                name,
                include_branch_table,
            } => Self::DispersionCurve {
                name,
                include_branch_table,
            },
            OutputV04Wire::FrequencyResponseOutput { observable } => {
                Self::FrequencyResponseOutput { observable }
            }
            OutputV04Wire::EigenDiagnostics {
                include_tracking,
                include_residuals,
                include_overlaps,
                include_tangent_leakage,
                include_orthogonality,
            } => Self::EigenDiagnostics {
                include_tracking,
                include_residuals,
                include_overlaps,
                include_tangent_leakage,
                include_orthogonality,
            },
            OutputV04Wire::SaveQuantity {
                quantity_id,
                every_seconds,
                reduction,
                component,
            } => Self::SaveQuantity {
                quantity_id,
                every_seconds,
                reduction,
                component,
            },
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TableAutosaveV04Wire {
    #[serde(default = "default_v04_table_autosave_kind")]
    kind: String,
    #[serde(default = "default_v04_table_id")]
    table_id: String,
    #[serde(default)]
    sample_period_s: Option<f64>,
    #[serde(default)]
    sample_period_policy: Option<SamplingPeriodPolicyV04Wire>,
    #[serde(default)]
    resolved_sample_period_s: Option<f64>,
    #[serde(default)]
    every_steps: Option<u64>,
    quantities: Vec<String>,
    #[serde(default)]
    expressions: Vec<String>,
}

impl From<TableAutosaveV04Wire> for TableAutosaveIR {
    fn from(table: TableAutosaveV04Wire) -> Self {
        Self {
            kind: table.kind,
            table_id: table.table_id,
            sample_period_s: table.sample_period_s,
            sample_period_policy: table.sample_period_policy.map(Into::into),
            resolved_sample_period_s: table.resolved_sample_period_s,
            every_steps: table.every_steps,
            quantities: table.quantities,
            expressions: table.expressions,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FieldAutosaveV04Wire {
    #[serde(default = "default_v04_field_autosave_kind")]
    kind: String,
    quantity: String,
    #[serde(default)]
    every_seconds: Option<f64>,
    #[serde(default)]
    sample_period_policy: Option<SamplingPeriodPolicyV04Wire>,
    #[serde(default)]
    every_steps: Option<u64>,
}

impl From<FieldAutosaveV04Wire> for FieldAutosaveIR {
    fn from(field: FieldAutosaveV04Wire) -> Self {
        Self {
            kind: field.kind,
            quantity: field.quantity,
            every_seconds: field.every_seconds,
            sample_period_policy: field.sample_period_policy.map(Into::into),
            every_steps: field.every_steps,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StageAutosaveV04Wire {
    #[serde(default = "default_v04_stage_autosave_kind")]
    kind: String,
    target: String,
    layout: AutosaveLayoutIR,
    format: AutosaveFormatIR,
    #[serde(default)]
    table: Option<TableAutosaveV04Wire>,
    #[serde(default)]
    fields: Vec<FieldAutosaveV04Wire>,
}

impl From<StageAutosaveV04Wire> for StageAutosaveIR {
    fn from(stage: StageAutosaveV04Wire) -> Self {
        Self {
            kind: stage.kind,
            target: stage.target,
            layout: stage.layout,
            format: stage.format,
            table: stage.table.map(Into::into),
            fields: stage.fields.into_iter().map(Into::into).collect(),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SamplingV04Wire {
    outputs: Vec<OutputV04Wire>,
    #[serde(default)]
    table_autosave: Option<TableAutosaveV04Wire>,
    #[serde(default)]
    stage_autosave: Option<StageAutosaveV04Wire>,
}

impl From<SamplingV04Wire> for SamplingIR {
    fn from(sampling: SamplingV04Wire) -> Self {
        Self {
            outputs: sampling.outputs.into_iter().map(Into::into).collect(),
            table_autosave: sampling.table_autosave.map(Into::into),
            stage_autosave: sampling.stage_autosave.map(Into::into),
        }
    }
}

fn sampling_error_pointer(path: &serde_path_to_error::Path) -> String {
    use serde_path_to_error::Segment;

    let mut pointer = "/study/sampling".to_string();
    for segment in path {
        match segment {
            Segment::Seq { index } => pointer.push_str(&format!("/{index}")),
            Segment::Map { key } => {
                pointer.push('/');
                pointer.push_str(&key.replace('~', "~0").replace('/', "~1"));
            }
            Segment::Enum { .. } | Segment::Unknown => {}
        }
    }
    pointer
}

pub(crate) fn deserialize_sampling<'de, D>(deserializer: D) -> Result<SamplingIR, D::Error>
where
    D: Deserializer<'de>,
{
    serde_path_to_error::deserialize::<_, SamplingV04Wire>(deserializer)
        .map(Into::into)
        .map_err(|error| {
            <D::Error as serde::de::Error>::custom(format!(
                "{}: {error}",
                sampling_error_pointer(error.path())
            ))
        })
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum EquilibriumSourceV04Wire {
    Provided {},
    RelaxedInitialState {},
    Artifact { path: String },
}

impl From<EquilibriumSourceV04Wire> for EquilibriumSourceIR {
    fn from(source: EquilibriumSourceV04Wire) -> Self {
        match source {
            EquilibriumSourceV04Wire::Provided {} => Self::Provided,
            EquilibriumSourceV04Wire::RelaxedInitialState {} => Self::RelaxedInitialState,
            EquilibriumSourceV04Wire::Artifact { path } => Self::Artifact { path },
        }
    }
}

pub(crate) fn deserialize_equilibrium<'de, D>(
    deserializer: D,
) -> Result<EquilibriumSourceIR, D::Error>
where
    D: Deserializer<'de>,
{
    EquilibriumSourceV04Wire::deserialize(deserializer)
        .map(Into::into)
        .map_err(|error| {
            <D::Error as serde::de::Error>::custom(format!("/study/equilibrium: {error}"))
        })
}

#[derive(Deserialize)]
#[serde(remote = "KPointIR", deny_unknown_fields)]
struct KPointIRV04Def {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    k_vector: [f64; 3],
}

struct KPointV04Seed {
    index: usize,
}

impl<'de> DeserializeSeed<'de> for KPointV04Seed {
    type Value = KPointIR;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: Deserializer<'de>,
    {
        KPointIRV04Def::deserialize(deserializer).map_err(|error| {
            <D::Error as serde::de::Error>::custom(format!(
                "/study/k_sampling/points/{}: {error}",
                self.index
            ))
        })
    }
}

struct KPointsV04Visitor;

impl<'de> Visitor<'de> for KPointsV04Visitor {
    type Value = Vec<KPointIR>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a sequence of k-points")
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        // A deserializer size hint is not a trusted allocation budget.
        let mut points = Vec::new();
        while let Some(point) = seq.next_element_seed(KPointV04Seed {
            index: points.len(),
        })? {
            points.push(point);
        }
        Ok(points)
    }
}

fn deserialize_k_points<'de, D>(deserializer: D) -> Result<Vec<KPointIR>, D::Error>
where
    D: Deserializer<'de>,
{
    deserializer.deserialize_seq(KPointsV04Visitor)
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum KSamplingV04Wire {
    Single {
        k_vector: [f64; 3],
    },
    Path {
        #[serde(deserialize_with = "deserialize_k_points")]
        points: Vec<KPointIR>,
        samples_per_segment: Vec<u32>,
        #[serde(default)]
        closed: bool,
    },
}

impl From<KSamplingV04Wire> for KSamplingIR {
    fn from(sampling: KSamplingV04Wire) -> Self {
        match sampling {
            KSamplingV04Wire::Single { k_vector } => Self::Single { k_vector },
            KSamplingV04Wire::Path {
                points,
                samples_per_segment,
                closed,
            } => Self::Path {
                points,
                samples_per_segment,
                closed,
            },
        }
    }
}

pub(crate) fn deserialize_optional_k_sampling<'de, D>(
    deserializer: D,
) -> Result<Option<KSamplingIR>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<KSamplingV04Wire>::deserialize(deserializer)
        .map(|sampling| sampling.map(Into::into))
        .map_err(|error| {
            <D::Error as serde::de::Error>::custom(format!("/study/k_sampling: {error}"))
        })
}
