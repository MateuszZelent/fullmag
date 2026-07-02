use crate::eigen::types::KSampleDescriptor;
use fullmag_ir::KSamplingIR;

fn lerp_vec3(a: [f64; 3], b: [f64; 3], t: f64) -> [f64; 3] {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

fn vec3_distance(a: [f64; 3], b: [f64; 3]) -> f64 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    let dz = a[2] - b[2];
    (dx * dx + dy * dy + dz * dz).sqrt()
}

pub fn expand_k_sampling(
    k_sampling: Option<&KSamplingIR>,
) -> Result<Vec<KSampleDescriptor>, String> {
    match k_sampling {
        None => Ok(vec![KSampleDescriptor {
            sample_index: 0,
            label: Some("Γ".to_string()),
            segment_index: None,
            path_s: 0.0,
            t_in_segment: 0.0,
            k_vector: [0.0, 0.0, 0.0],
        }]),
        Some(KSamplingIR::Single { k_vector }) => Ok(vec![KSampleDescriptor {
            sample_index: 0,
            label: if *k_vector == [0.0, 0.0, 0.0] {
                Some("Γ".to_string())
            } else {
                None
            },
            segment_index: None,
            path_s: 0.0,
            t_in_segment: 0.0,
            k_vector: *k_vector,
        }]),
        Some(KSamplingIR::Path {
            points,
            samples_per_segment,
            closed,
        }) => {
            if points.len() < 2 {
                return Err("k_sampling.path requires at least two control points".to_string());
            }
            let expected_segments = if *closed {
                points.len()
            } else {
                points.len() - 1
            };
            if samples_per_segment.len() != expected_segments {
                return Err(format!(
                    "k_sampling.path expected {} samples_per_segment entries, got {}",
                    expected_segments,
                    samples_per_segment.len()
                ));
            }

            let mut samples = Vec::new();
            let mut running_s = 0.0;
            let mut sample_index = 0usize;

            for segment_index in 0..expected_segments {
                let a = &points[segment_index];
                let b = if segment_index + 1 < points.len() {
                    &points[segment_index + 1]
                } else {
                    &points[0]
                };
                let n = samples_per_segment[segment_index] as usize;
                if n == 0 {
                    return Err("samples_per_segment entries must be > 0".to_string());
                }
                let segment_len = vec3_distance(a.k_vector, b.k_vector);

                for local_i in 0..=n {
                    if segment_index > 0 && local_i == 0 {
                        continue;
                    }
                    let t = local_i as f64 / n as f64;
                    let label = if local_i == 0 {
                        a.label.clone()
                    } else if local_i == n {
                        b.label.clone()
                    } else {
                        None
                    };
                    let path_s = running_s + segment_len * t;
                    samples.push(KSampleDescriptor {
                        sample_index,
                        label,
                        segment_index: Some(segment_index),
                        path_s,
                        t_in_segment: t,
                        k_vector: lerp_vec3(a.k_vector, b.k_vector, t),
                    });
                    sample_index += 1;
                }
                running_s += segment_len;
            }

            Ok(samples)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::KPointIR;

    #[test]
    fn path_expansion_generates_monotonic_samples() {
        let sampling = KSamplingIR::Path {
            points: vec![
                KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                KPointIR {
                    label: Some("X".to_string()),
                    k_vector: [4.0, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![4],
            closed: false,
        };

        let samples = expand_k_sampling(Some(&sampling)).expect("path should expand");

        assert_eq!(samples.len(), 5);
        assert_eq!(samples[0].label.as_deref(), Some("G"));
        assert_eq!(samples[4].label.as_deref(), Some("X"));
        assert!(samples
            .windows(2)
            .all(|pair| pair[0].path_s < pair[1].path_s));
        assert_eq!(samples[4].path_s, 4.0);
    }

    #[test]
    fn closed_path_expansion_includes_return_segment_to_first_point() {
        let sampling = KSamplingIR::Path {
            points: vec![
                KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                KPointIR {
                    label: Some("X".to_string()),
                    k_vector: [2.0, 0.0, 0.0],
                },
                KPointIR {
                    label: Some("M".to_string()),
                    k_vector: [2.0, 2.0, 0.0],
                },
            ],
            samples_per_segment: vec![2, 2, 2],
            closed: true,
        };

        let samples = expand_k_sampling(Some(&sampling)).expect("closed path should expand");

        assert_eq!(samples.len(), 7);
        assert_eq!(samples[0].label.as_deref(), Some("G"));
        assert_eq!(samples[2].label.as_deref(), Some("X"));
        assert_eq!(samples[4].label.as_deref(), Some("M"));
        assert_eq!(
            samples.last().map(|sample| sample.k_vector),
            Some([0.0, 0.0, 0.0])
        );
        assert_eq!(
            samples.last().and_then(|sample| sample.segment_index),
            Some(2)
        );
        assert!(samples
            .windows(2)
            .all(|pair| pair[0].path_s < pair[1].path_s));
    }
}
