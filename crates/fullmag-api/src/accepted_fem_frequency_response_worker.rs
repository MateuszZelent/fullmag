//! Accepted FEM driven response. Harmonic outputs are analysis artifacts,
//! never a new accepted magnetization state.

use anyhow::{bail, Result};
use fullmag_authoring::{StudyOutputPort, StudyPortDataKind};

pub(crate) fn validate_declared_outputs(
    outputs: &[StudyOutputPort],
    frequency_count: usize,
) -> Result<()> {
    if frequency_count == 0 || frequency_count.checked_add(1) != Some(outputs.len()) {
        bail!("driven response requires one index and one artifact per frequency");
    }
    let mut seen = std::collections::BTreeSet::new();
    for output in outputs {
        if output.data_kind != StudyPortDataKind::Artifact || !seen.insert(output.port_id.as_str())
        {
            bail!("driven-response ports must be unique analysis artifacts");
        }
        if output.port_id == "response" {
            continue;
        }
        let index = output
            .port_id
            .strip_prefix("response-frequency-")
            .and_then(|suffix| suffix.parse::<usize>().ok());
        if !index.is_some_and(|index| {
            index < frequency_count && output.port_id == format!("response-frequency-{index:06}")
        }) {
            bail!("driven-response output does not name a declared frequency");
        }
    }
    if !seen.contains("response") {
        bail!("driven response requires its index artifact");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ports(n: usize) -> Vec<StudyOutputPort> {
        std::iter::once("response".to_owned())
            .chain((0..n).map(|i| format!("response-frequency-{i:06}")))
            .map(|port_id| StudyOutputPort {
                port_id,
                data_kind: StudyPortDataKind::Artifact,
            })
            .collect()
    }

    #[test]
    fn exact_declared_frequency_ports_accept_only_complete_unique_analysis_outputs() {
        let valid = ports(2);
        validate_declared_outputs(&valid, 2).unwrap();
        let mut reordered = valid.clone();
        reordered.reverse();
        validate_declared_outputs(&reordered, 2).unwrap();
        for invalid in [
            valid[..2].to_vec(),
            ports(3),
            vec![valid[0].clone(), valid[1].clone(), valid[1].clone()],
            vec![
                valid[0].clone(),
                valid[1].clone(),
                StudyOutputPort {
                    port_id: "response-frequency-000001".into(),
                    data_kind: StudyPortDataKind::State,
                },
            ],
            vec![
                valid[0].clone(),
                valid[1].clone(),
                StudyOutputPort {
                    port_id: "final_state".into(),
                    data_kind: StudyPortDataKind::State,
                },
            ],
            vec![
                valid[0].clone(),
                valid[1].clone(),
                StudyOutputPort {
                    port_id: "response-frequency-1".into(),
                    data_kind: StudyPortDataKind::Artifact,
                },
            ],
            vec![
                valid[1].clone(),
                valid[2].clone(),
                StudyOutputPort {
                    port_id: "response-frequency-000002".into(),
                    data_kind: StudyPortDataKind::Artifact,
                },
            ],
        ] {
            assert!(validate_declared_outputs(&invalid, 2).is_err());
        }
        assert!(validate_declared_outputs(&ports(0), 0).is_err());
        assert!(validate_declared_outputs(&[], usize::MAX).is_err());
    }
}
