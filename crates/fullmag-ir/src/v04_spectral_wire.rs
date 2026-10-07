use crate::eigen_contract::KPointIR;
use crate::study::{EquilibriumSourceIR, KSamplingIR};
use serde::de::{DeserializeSeed, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use std::fmt;

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
