//! Private FEM eigen-path artifacts helpers.

use super::*;
use std::collections::HashSet;

pub(super) fn eigen_path_publication_gamma0(
    plan: &FemEigenPlanIR,
    result: &crate::eigen::PathSolveResult,
) -> Result<f64, RunError> {
    let validate = |value| crate::eigen::artifacts::validated_modal_gamma0(value)
        .map_err(|error| RunError { message: error.to_string() });
    let gamma0 = validate(result.gamma0_rad_s_per_a_m)?;
    let plan_gamma0 = validate(plan.gyromagnetic_ratio)?;
    if gamma0 != plan_gamma0 {
        return Err(RunError {
            message: "FEM eigen publication gamma0 differs from the executed plan".into(),
        });
    }
    Ok(gamma0)
}

pub(super) fn eigen_path_mode_publication_json(
    mut value: Value,
    sample_index: usize,
    raw_mode_index: usize,
    selected_fields: &BTreeSet<SampleModeId>,
) -> Value {
    let available = selected_fields.contains(&SampleModeId::new(sample_index, raw_mode_index));
    value["mode_field_available"] = serde_json::json!(available);
    if let Some(object) = value.as_object_mut() {
        object.remove("mode_field_resource_key");
    }
    value
}

fn eigen_path_artifact_sample_index(path: &str) -> Option<usize> {
    let component = path.split('/').find(|part| part.starts_with("sample_"))?;
    let suffix = component.strip_prefix("sample_")?;
    let end = suffix
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(suffix.len());
    if end == 0
        || !matches!(&suffix[end..], "" | ".json" | ".zattrs" | ".zgroup")
            && !suffix[end..].starts_with("_mode_")
    {
        return None;
    }
    suffix[..end].parse().ok()
}

fn eigen_path_artifact_mode_id(path: &str) -> Option<SampleModeId> {
    let sample_index = eigen_path_artifact_sample_index(path)?;
    let raw_mode_index = single_k_mode_artifact_raw_mode_index(path).or_else(|| {
        let (_, suffix) = path.rsplit_once("_mode_")?;
        suffix.strip_suffix(".json")?.parse().ok()
    })?;
    Some(SampleModeId::new(sample_index, raw_mode_index))
}

pub(super) fn retain_selected_eigen_path_mode_artifacts(
    artifacts: &mut Vec<AuxiliaryArtifact>,
    selected: &BTreeSet<SampleModeId>,
) {
    let samples = selected
        .iter()
        .map(|id| id.sample_index)
        .collect::<BTreeSet<_>>();
    artifacts.retain(|artifact| {
        // Equilibrium/identity evidence belongs to the solved sample, not
        // the optional selection of mode field payloads.
        if eigen_path_signed_state_artifact(&artifact.relative_path) {
            return true;
        }
        if let Some(id) = eigen_path_artifact_mode_id(&artifact.relative_path) {
            return selected.contains(&id);
        }
        if let Some(sample_index) = eigen_path_artifact_sample_index(&artifact.relative_path) {
            return samples.contains(&sample_index);
        }
        !selected.is_empty()
            && matches!(
                artifact.relative_path.as_str(),
                "eigen/mode_fields.zarr/.zgroup" | "eigen/mode_fields.zarr/.zattrs"
            )
    });
}

pub(super) fn bind_eigen_path_tracked_mode_metadata(
    artifacts: &mut [AuxiliaryArtifact],
    result: &crate::eigen::PathSolveResult,
) -> Result<(), RunError> {
    let branches = result
        .samples
        .iter()
        .flat_map(|sample| {
            sample.modes.iter().map(|mode| {
                (
                    SampleModeId::new(sample.sample.sample_index, mode.raw_mode_index),
                    mode.branch_id,
                )
            })
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    for artifact in artifacts {
        let Some(id) = eigen_path_artifact_mode_id(&artifact.relative_path) else {
            continue;
        };
        if !artifact.relative_path.ends_with(".json")
            && !artifact.relative_path.ends_with(".zattrs")
        {
            continue;
        }
        let mut value: Value =
            serde_json::from_slice(&artifact.bytes).map_err(|error| RunError {
                message: format!(
                    "invalid selected eigen metadata {}: {error}",
                    artifact.relative_path
                ),
            })?;
        if let Some(object) = value.as_object_mut() {
            if object.contains_key("raw_mode_index")
                || object.contains_key("mode_field_id")
                || object.contains_key("branch_id")
            {
                object.insert(
                    "branch_id".into(),
                    serde_json::json!(branches.get(&id).copied().flatten()),
                );
                object.insert("sample_index".into(), serde_json::json!(id.sample_index));
                object.insert(
                    "raw_mode_index".into(),
                    serde_json::json!(id.raw_mode_index),
                );
                artifact.bytes = serde_json::to_vec_pretty(&value).map_err(|error| RunError {
                    message: format!("failed to serialize tracked mode metadata: {error}"),
                })?;
            }
        }
    }
    Ok(())
}

pub(super) fn validate_eigen_path_selected_mode_artifacts(
    artifacts: &[AuxiliaryArtifact],
    selected: &BTreeSet<SampleModeId>,
) -> Result<(), RunError> {
    let indexed = artifacts
        .iter()
        .map(|artifact| (artifact.relative_path.as_str(), artifact))
        .collect::<std::collections::BTreeMap<_, _>>();
    for id in selected {
        let metadata = format!(
            "eigen/modes/sample_{:04}/mode_{:04}.json",
            id.sample_index, id.raw_mode_index
        );
        let payload = format!(
            "eigen/mode_fields/sample_{:04}/mode_{:04}/vector.bin",
            id.sample_index, id.raw_mode_index
        );
        let metadata_exists = indexed
            .get(metadata.as_str())
            .is_some_and(|artifact| !artifact.bytes.is_empty());
        let payload_exists = indexed.get(payload.as_str()).is_some_and(|artifact| {
            !artifact.bytes.is_empty()
                && artifact.bytes.len() % (3 * 2 * std::mem::size_of::<f64>()) == 0
        });
        if !metadata_exists || !payload_exists {
            return Err(RunError { message: format!(
                "selected eigen mode sample={} raw_mode={} has no complete metadata/complex field payload",
                id.sample_index, id.raw_mode_index,
            ) });
        }
    }
    Ok(())
}

#[cfg(test)]
mod output_publication_tests {
    use super::*;

    #[test]
    fn publication_gamma_rejects_overflow_and_plan_result_mismatch() {
        let mut plan = residual_transport_test_plan();
        let mut result = crate::eigen::PathSolveResult {
            gamma0_rad_s_per_a_m: 1.7e5,
            samples: Vec::new(), branches: Vec::new(), notes: Vec::new(),
            solver_model: crate::eigen::EigenSolverModel::ReferenceScalarTangent,
            include_demag: false, dispersion_validation: None, k0_kittel_validation: None,
            solver_policy: None, dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };
        plan.gyromagnetic_ratio = result.gamma0_rad_s_per_a_m;
        assert_eq!(eigen_path_publication_gamma0(&plan, &result).unwrap(), 1.7e5);
        result.gamma0_rad_s_per_a_m = 2.211e5;
        assert!(eigen_path_publication_gamma0(&plan, &result).is_err());
        for invalid in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::MAX] {
            plan.gyromagnetic_ratio = invalid;
            result.gamma0_rad_s_per_a_m = invalid;
            assert!(eigen_path_publication_gamma0(&plan, &result).is_err());
        }
    }

    fn residual_transport_test_plan() -> FemEigenPlanIR {
        let mesh = fullmag_ir::MeshIR {
            mesh_name: "residual-transport-test".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
            element_markers: vec![1],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(Vec::new()),
            boundary_markers: Vec::new(),
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
        };
        FemEigenPlanIR {
            mesh_name: mesh.mesh_name.clone(),
            mesh_source: None,
            mesh,
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            mesh_build_report: None,
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 1.0,
            equilibrium_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            material: fullmag_ir::MaterialIR {
                name: "Permalloy".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.01,
                uniaxial_anisotropy: None,
                uniaxial_anisotropy_k2: None,
                anisotropy_axis: None,
                cubic_anisotropy_kc1: None,
                cubic_anisotropy_kc2: None,
                cubic_anisotropy_kc3: None,
                cubic_anisotropy_axis1: None,
                cubic_anisotropy_axis2: None,
                ms_field: None,
                a_field: None,
                alpha_field: None,
                ku_field: None,
                ku2_field: None,
                kc1_field: None,
                kc2_field: None,
                kc3_field: None,
                dind_field: None,
                dbulk_field: None,
                interfacial_dmi: None,
                bulk_dmi: None,
            },
            operator: fullmag_ir::EigenOperatorConfigIR {
                kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
                include_demag: false,
            },
            count: 1,
            target: fullmag_ir::EigenTargetIR::Lowest,
            equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
            k_sampling: None,
            bias_field_samples: Vec::new(),
            normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
            damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
            enable_exchange: true,
            enable_demag: false,
            interfacial_dmi: None,
            dmi_interface_normal: None,
            bulk_dmi: None,
            external_field: None,
            gyromagnetic_ratio: 2.211e5,
            precision: fullmag_ir::ExecutionPrecision::Double,
            exchange_bc: fullmag_ir::ExchangeBoundaryCondition::Neumann,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
            demag_realization: None,
            air_box_config: None,
            mode_tracking: None,
            dispersion_validation: None,
            k0_kittel_validation: None,
            solver_policy: None,
        }
    }

    fn residual_transport_test_mode(
        residual_relative_l2: Option<f64>,
    ) -> crate::eigen::SingleKModeResult {
        crate::eigen::SingleKModeResult {
            raw_mode_index: 0,
            branch_id: Some(0),
            frequency_real_hz: 1.0e9,
            frequency_imag_hz: 0.0,
            angular_frequency_rad_per_s: std::f64::consts::TAU * 1.0e9,
            eigenvalue_real: 0.0,
            eigenvalue_imag: std::f64::consts::TAU * 1.0e9,
            norm: 1.0,
            mass_norm: Some(1.0),
            max_amplitude: 1.0,
            residual_relative_l2,
            residual_norm: Some(1.0e-9),
            residual_linf: Some(1.0e-10),
            tangent_leakage_mean_abs: Some(0.0),
            tangent_leakage_max_abs: Some(0.0),
            tangent_leakage_weighted_relative_l2: Some(0.0),
            dominant_polarization: "linear".to_string(),
            reduced_vector: None,
            lifted_real: None,
            lifted_imag: None,
            amplitude: None,
            phase: None,
            node_mass_weights: None,
            consistent_p1_metric: None,
            component_participation:
                crate::eigen::ModalParticipationObservable::unavailable_without_context("cpu"),
        }
    }

    #[test]
    fn eigen_path_v2_and_v3_keep_relative_residual_separate_and_nullable() {
        let plan = residual_transport_test_plan();
        let sample = KSampleDescriptor {
            sample_index: 0,
            label: Some("G".to_string()),
            segment_index: Some(0),
            path_s: 0.0,
            t_in_segment: 0.0,
            k_vector: [0.0, 0.0, 0.0],
        };
        let mode = residual_transport_test_mode(Some(2.5e-10));
        let v2 = eigen_path_mode_json(
            &plan,
            &sample,
            &mode,
            crate::eigen::EigenSolverModel::ReferenceScalarTangent,
            None,
        );
        let v3 = eigen_path_mode_v3_json(
            &plan,
            &sample,
            &mode,
            crate::eigen::EigenSolverModel::ReferenceScalarTangent,
            None,
        );
        for value in [&v2, &v3] {
            assert_eq!(value["residual_absolute_l2"], 1.0e-9);
            assert_eq!(value["residual_relative_l2"], 2.5e-10);
        }

        let missing = residual_transport_test_mode(None);
        let missing_v2 = eigen_path_mode_json(
            &plan,
            &sample,
            &missing,
            crate::eigen::EigenSolverModel::ReferenceScalarTangent,
            None,
        );
        let missing_v3 = eigen_path_mode_v3_json(
            &plan,
            &sample,
            &missing,
            crate::eigen::EigenSolverModel::ReferenceScalarTangent,
            None,
        );
        assert!(missing_v2["residual_relative_l2"].is_null());
        assert!(missing_v3["residual_relative_l2"].is_null());

        let mut unavailable_absolute = residual_transport_test_mode(Some(2.5e-10));
        unavailable_absolute.residual_norm = None;
        unavailable_absolute.residual_linf = None;
        let unavailable_v2 = eigen_path_mode_json(
            &plan,
            &sample,
            &unavailable_absolute,
            crate::eigen::EigenSolverModel::ReferenceScalarTangent,
            None,
        );
        assert!(unavailable_v2["residual_norm"].is_null());
        assert!(unavailable_v2["residual_absolute_l2"].is_null());
        assert!(unavailable_v2["residual_linf"].is_null());
        assert_eq!(unavailable_v2["residual_relative_l2"], 2.5e-10);
    }

    #[test]
    fn eigen_path_transports_only_the_matching_native_block_certificate() {
        let plan = residual_transport_test_plan();
        let sample = KSampleDescriptor {
            sample_index: 2,
            label: None,
            segment_index: None,
            path_s: 0.0,
            t_in_segment: 0.0,
            k_vector: [0.0, 1.0e7, 0.0],
        };
        let mode = residual_transport_test_mode(Some(2.5e-10));
        let blocks = serde_json::json!({
            "eps_q": 2.0e-10, "eps_phi": 1.0e-14, "eps_full": 2.5e-10,
            "scope": "full_projected_weak_form_and_periodic_seams",
            "certification_tolerance": 1.0e-8,
            "floquet_seam_frame_certified": true, "certified": true,
        });
        let record = serde_json::json!({
            "sample_index": 2, "raw_mode_index": 0, "frequency_hz": 1.0e9,
            "block_residuals": blocks,
        });
        let mut diagnostics = serde_json::json!({
            "block_residuals": {"certified": false},
            "native_mode_block_residuals": [record.clone()],
        });
        let publish = |diagnostics: &serde_json::Value| {
            eigen_path_mode_v3_json(
                &plan,
                &sample,
                &mode,
                crate::eigen::EigenSolverModel::ProductionCpuShiftInvert,
                Some(diagnostics),
            )
        };
        assert_eq!(publish(&diagnostics)["block_residuals"], blocks);
        diagnostics["native_mode_block_residuals"][0]["frequency_hz"] = serde_json::json!(2.0e9);
        assert!(publish(&diagnostics).get("block_residuals").is_none());
        diagnostics["native_mode_block_residuals"] =
            serde_json::json!([record.clone(), record.clone()]);
        assert!(publish(&diagnostics).get("block_residuals").is_none());
        diagnostics["native_mode_block_residuals"] = serde_json::json!([record]);
        diagnostics["native_mode_block_residuals"][0]["sample_index"] = serde_json::json!(1);
        assert!(publish(&diagnostics).get("block_residuals").is_none());
    }

    #[test]
    fn eigen_path_retains_only_sample_candidates_before_tracking() {
        let mut sample = KSampleDescriptor {
            sample_index: 10,
            label: None,
            segment_index: Some(0),
            path_s: 1.0,
            t_in_segment: 0.5,
            k_vector: [1.0, 0.0, 0.0],
        };
        let output = OutputIR::EigenMode {
            field: "mode".into(),
            all_modes: false,
            indices: vec![0, 1],
            branches: vec![],
            sample_selector: Some(fullmag_ir::SampleSelectorIR {
                sample_indices: vec![10],
                sample_labels: vec!["Gamma".into()],
            }),
        };
        assert_eq!(
            eigen_path_candidate_mode_indices(&[output.clone()], &sample, &(0..24).collect()),
            BTreeSet::from([0, 1])
        );
        sample.sample_index = 11;
        assert!(eigen_path_candidate_mode_indices(&[output.clone()], &sample, &(0..24).collect()).is_empty());
        sample.label = Some("Gamma".into());
        assert_eq!(
            eigen_path_candidate_mode_indices(&[output.clone()], &sample, &(0..24).collect()),
            BTreeSet::from([0, 1])
        );
        let mut branch_output = output;
        if let OutputIR::EigenMode { branches, .. } = &mut branch_output {
            branches.push(3);
        }
        assert_eq!(
            eigen_path_candidate_mode_indices(&[branch_output], &sample, &(0..24).collect()).len(),
            24
        );
        let all_output = OutputIR::EigenMode {
            field: "mode".into(), all_modes: true, indices: vec![], branches: vec![], sample_selector: None,
        };
        assert_eq!(eigen_path_candidate_mode_indices(&[all_output], &sample, &BTreeSet::from([64, 91])),
                   BTreeSet::from([64, 91]));
    }

    #[test]
    fn requested_field_requires_real_metadata_and_complex_payload() {
        let selected = BTreeSet::from([SampleModeId::new(2, 7)]);
        let mut artifacts = vec![AuxiliaryArtifact {
            relative_path: "eigen/modes/sample_0002/mode_0007.json".into(),
            bytes: b"{}".to_vec(),
        }];
        assert!(validate_eigen_path_selected_mode_artifacts(&artifacts, &selected).is_err());
        artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/mode_fields/sample_0002/mode_0007/vector.bin".into(),
            bytes: vec![0; 48],
        });
        assert!(validate_eigen_path_selected_mode_artifacts(&artifacts, &selected).is_ok());
        artifacts[1].bytes.pop();
        assert!(validate_eigen_path_selected_mode_artifacts(&artifacts, &selected).is_err());
    }

    #[test]
    fn omitted_mode_field_keeps_its_identity_without_a_resource_link() {
        let metadata = serde_json::json!({"mode_field_id": "stable-id", "mode_field_resource_key": "field-resource"});
        let value = eigen_path_mode_publication_json(metadata.clone(), 2, 7, &BTreeSet::new());
        assert_eq!(value["mode_field_id"], "stable-id");
        assert_eq!(value["mode_field_available"], false);
        assert!(value.get("mode_field_resource_key").is_none());
        let value = eigen_path_mode_publication_json(
            metadata,
            2,
            7,
            &BTreeSet::from([SampleModeId::new(2, 7)]),
        );
        assert_eq!(value["mode_field_available"], true);
        assert!(value.get("mode_field_resource_key").is_none());
    }

    #[test]
    fn remapping_keeps_the_selected_zarr_sample_group() {
        assert_eq!(
            remap_single_k_mode_artifact_path(
                "eigen/mode_fields.zarr/sample_0000/.zgroup",
                3,
                &BTreeSet::from([7])
            ),
            Some("eigen/mode_fields.zarr/sample_0003/.zgroup".into())
        );
        assert!(remap_single_k_mode_artifact_path(
            "eigen/mode_fields.zarr/sample_0000/.zgroup",
            3,
            &BTreeSet::new()
        )
        .is_none());
    }

    #[test]
    fn remaps_current_sample_mode_artifacts_and_rejects_other_indices() {
        let published_modes = BTreeSet::from([3_u32]);

        for sample_index in [1_usize, 7, 10_000] {
            let selected = BTreeSet::from([SampleModeId::new(sample_index, 3)]);
            for source_sample_index in [0, sample_index] {
                let metadata = AuxiliaryArtifact {
                    relative_path: format!(
                        "eigen/modes/sample_{source_sample_index:04}/mode_0003.json"
                    ),
                    bytes: serde_json::json!({
                        "sample_index": source_sample_index,
                        "preimage_path": format!("eigen/modes/sample_{source_sample_index:04}/mode_0003.json"),
                    })
                    .to_string()
                    .into_bytes(),
                };
                let field = AuxiliaryArtifact {
                    relative_path: format!(
                        "eigen/mode_fields/sample_{source_sample_index:04}/mode_0003/vector.bin"
                    ),
                    bytes: vec![0; 3 * 2 * std::mem::size_of::<f64>()],
                };

                let remapped = remap_single_k_mode_artifacts(
                    &[metadata, field],
                    sample_index,
                    &published_modes,
                )
                .expect("valid zero-based or already-indexed artifacts should remap");
                assert_eq!(remapped.len(), 2);
                assert_eq!(
                    remapped[0].relative_path,
                    format!("eigen/modes/sample_{sample_index:04}/mode_0003.json")
                );
                assert_eq!(
                    remapped[1].relative_path,
                    format!("eigen/mode_fields/sample_{sample_index:04}/mode_0003/vector.bin")
                );
                let metadata: Value =
                    serde_json::from_slice(&remapped[0].bytes).expect("metadata remains JSON");
                assert_eq!(metadata["sample_index"], sample_index);
                assert_eq!(
                    metadata["preimage_path"],
                    format!("eigen/modes/sample_{sample_index:04}/mode_0003.json")
                );
                validate_eigen_path_selected_mode_artifacts(&remapped, &selected)
                    .expect("matching sample metadata and field payload satisfy selection");
            }

            let foreign_sample_index = sample_index + 1;
            let foreign_artifacts = [
                AuxiliaryArtifact {
                    relative_path: format!(
                        "eigen/modes/sample_{foreign_sample_index:04}/mode_0003.json"
                    ),
                    bytes: serde_json::json!({
                        "sample_index": foreign_sample_index,
                    })
                    .to_string()
                    .into_bytes(),
                },
                AuxiliaryArtifact {
                    relative_path: format!(
                        "eigen/mode_fields/sample_{foreign_sample_index:04}/mode_0003/vector.bin"
                    ),
                    bytes: vec![0; 3 * 2 * std::mem::size_of::<f64>()],
                },
            ];
            let remapped =
                remap_single_k_mode_artifacts(&foreign_artifacts, sample_index, &published_modes)
                    .expect("foreign mode artifacts are excluded");
            assert!(remapped.is_empty());
            assert!(validate_eigen_path_selected_mode_artifacts(&remapped, &selected).is_err());
        }
    }

    #[test]
    fn remaps_full_potential_sidecars_to_sample_seven_and_filters_modes() {
        let manifest = serde_json::json!({
            "schema_version": "fem_modal_physical_potential.v1",
            "sample_index": 0,
            "mode_index": 3,
            "potential": {
                "path": "eigen/mode_fields/sample_0000/mode_0003/potential_full.bin"
            },
            "demag_field": {
                "path": "eigen/mode_fields/sample_0000/mode_0003/demag_element_full.bin"
            }
        });
        let artifacts = vec![
            AuxiliaryArtifact {
                relative_path: "eigen/mode_fields/sample_0000/mode_0003/potential_full.bin".into(),
                bytes: vec![1, 2, 3, 4],
            },
            AuxiliaryArtifact {
                relative_path: "eigen/mode_fields/sample_0000/mode_0003/demag_element_full.bin"
                    .into(),
                bytes: vec![5, 6, 7, 8],
            },
            AuxiliaryArtifact {
                relative_path: "eigen/mode_fields/sample_0000/mode_0003/physical_potential.v1.json"
                    .into(),
                bytes: serde_json::to_vec(&manifest).unwrap(),
            },
            AuxiliaryArtifact {
                relative_path: "eigen/mode_fields/sample_0000/mode_0004/potential_full.bin".into(),
                bytes: vec![9],
            },
        ];
        let selected = BTreeSet::from([3_u32]);
        let remapped = remap_single_k_mode_artifacts(&artifacts, 7, &selected).unwrap();
        assert_eq!(remapped.len(), 3);
        assert!(remapped
            .iter()
            .all(|artifact| { artifact.relative_path.contains("sample_0007/mode_0003") }));
        assert_eq!(remapped[0].bytes, vec![1, 2, 3, 4]);
        assert_eq!(remapped[1].bytes, vec![5, 6, 7, 8]);
        let remapped_manifest: serde_json::Value =
            serde_json::from_slice(&remapped[2].bytes).unwrap();
        assert_eq!(remapped_manifest["sample_index"], 7);
        assert_eq!(
            remapped_manifest["potential"]["path"],
            "eigen/mode_fields/sample_0007/mode_0003/potential_full.bin"
        );
        assert_eq!(
            remapped_manifest["demag_field"]["path"],
            "eigen/mode_fields/sample_0007/mode_0003/demag_element_full.bin"
        );
    }

    #[test]
    fn selection_preserves_original_sample_ids_and_removes_unrequested_payloads() {
        let paths = [
            "eigen/mode_fields.zarr/.zgroup",
            "eigen/mode_fields.zarr/.zattrs",
            "eigen/mode_fields.zarr/sample_0002/.zgroup",
            "eigen/mode_fields.zarr/sample_0002/mode_0007/real/0.0",
            "eigen/mode_fields.zarr/sample_0003/mode_0007/real/0.0",
            "eigen/mode_fields/sample_0002/mode_0007/vector.bin",
            "eigen/mode_fields/sample_0002/mode_0008/vector.bin",
            "eigen/modes/sample_0002/mode_0007.json",
            "eigen/metadata/sample_0002_mode_0007.json",
            "eigen/metadata/sample_0002/equilibrium_artifact.v7.json",
            "eigen/metadata/sample_0003/equilibrium_artifact.v7.json",
        ];
        let mut artifacts = paths
            .iter()
            .map(|path| AuxiliaryArtifact {
                relative_path: (*path).into(),
                bytes: vec![17],
            })
            .collect();
        let selected = BTreeSet::from([SampleModeId::new(2, 7)]);
        retain_selected_eigen_path_mode_artifacts(&mut artifacts, &selected);
        let kept = artifacts
            .iter()
            .map(|artifact| artifact.relative_path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            kept,
            vec![paths[0], paths[1], paths[2], paths[3], paths[5], paths[7], paths[8], paths[9], paths[10]]
        );
        assert!(artifacts.iter().all(|artifact| artifact.bytes == [17]));
        retain_selected_eigen_path_mode_artifacts(&mut artifacts, &BTreeSet::new());
        assert_eq!(artifacts.len(), 2);
        assert!(artifacts.iter().all(|artifact| eigen_path_signed_state_artifact(&artifact.relative_path)));
    }

    #[test]
    fn versioned_state_sidecars_remap_and_retain_sample_identity() {
        for filename in [
            "equilibrium_artifact.v7.json",
            "linearization_state.v6.json",
            "equilibrium_artifact.v8.json",
            "linearization_state.v7.json",
            "consumer_plan_snapshot.v1.json",
            "nonshared_floquet_operator_identity.v1.json",
            "nonshared_floquet_operator_identity_preimage.v1.json",
            "nonshared_floquet_source_state.v1.json",
        ] {
            let source = format!("eigen/metadata/{filename}");
            let target = format!("eigen/metadata/sample_0007/{filename}");
            assert_eq!(
                remap_single_k_mode_artifact_path(&source, 7, &BTreeSet::from([3_u32])),
                Some(target.clone())
            );
            let mut artifacts = vec![
                AuxiliaryArtifact {
                    relative_path: target.clone(),
                    bytes: vec![17],
                },
                AuxiliaryArtifact {
                    relative_path: format!("eigen/metadata/sample_0008/{filename}"),
                    bytes: vec![18],
                },
            ];
            retain_selected_eigen_path_mode_artifacts(
                &mut artifacts,
                &BTreeSet::from([SampleModeId::new(7, 3)]),
            );
            assert_eq!(artifacts.len(), 2);
            assert_eq!(artifacts[0].relative_path, target);
            assert_eq!(artifacts[0].bytes, vec![17]);
            assert_eq!(artifacts[1].bytes, vec![18]);
        }
    }

    #[test]
    fn already_scoped_signed_sidecars_are_preserved_without_reserialization() {
        let filename = "linearization_state.v7.json";
        let path = format!("eigen/metadata/sample_0007/{filename}");
        let payload = br#"{ "sample_index": 0, "preimage": "sample_0000" }"#;
        let artifacts = vec![AuxiliaryArtifact {
            relative_path: path.clone(),
            bytes: payload.to_vec(),
        }];

        let remapped = remap_single_k_mode_artifacts(
            &artifacts,
            7,
            &BTreeSet::new(),
        )
        .expect("matching scoped state must remain publishable");
        assert_eq!(remapped.len(), 1);
        assert_eq!(remapped[0].relative_path, path);
        assert_eq!(remapped[0].bytes, payload);

        let error = remap_single_k_mode_artifacts(&artifacts, 8, &BTreeSet::new())
            .expect_err("a signed state from another sample must fail closed");
        assert!(error
            .message
            .contains("eigen_path_signed_state_sample_index_mismatch"));
    }

    #[test]
    fn nonshared_exact_sidecars_are_preserved_without_reserialization() {
        for filename in [
            "native_input_operator_diagnostics.v1.json",
            "native_input_operator_diagnostics_preimage.v1.json",
            "nonshared_floquet_source_state_preimage.v1.json",
            "nonshared_floquet_operator_input_preimage.v1.json",
            "equilibrium_material_preimage.v1.json",
        ] {
            let path = format!(
                "eigen/metadata/sample_0007/nonshared_source/{filename}"
            );
            let payload = br#"{ "sample_index": 0, "preimage": "sample_0000" }"#;
            let remapped = remap_single_k_mode_artifacts(
                &[AuxiliaryArtifact {
                    relative_path: path.clone(),
                    bytes: payload.to_vec(),
                }],
                7,
                &BTreeSet::new(),
            )
            .expect("non-shared exact preimage must remain publishable");
            assert_eq!(remapped.len(), 1);
            assert_eq!(remapped[0].relative_path, path);
            assert_eq!(remapped[0].bytes, payload);

            let error = remap_single_k_mode_artifacts(
                &[AuxiliaryArtifact {
                    relative_path: path,
                    bytes: payload.to_vec(),
                }],
                8,
                &BTreeSet::new(),
            )
            .expect_err("an exact preimage from another sample must fail closed");
            assert!(error
                .message
                .contains("eigen_path_nonshared_provenance_sample_index_mismatch"));
        }
    }

    #[test]
    fn nonshared_provenance_paths_reject_traversal_empty_dot_and_backslash() {
        let payload = br#"{ "sample_index": 0, "preimage": "sample_0000" }"#;
        for suffix in [
            "nonshared_source/../foreign.json",
            "nonshared_source//foreign.json",
            "nonshared_source/./foreign.json",
            r"nonshared_source\foreign.json",
        ] {
            let path = format!("eigen/metadata/sample_0007/{suffix}");
            let error = remap_single_k_mode_artifacts(
                &[AuxiliaryArtifact {
                    relative_path: path,
                    bytes: payload.to_vec(),
                }],
                7,
                &BTreeSet::new(),
            )
            .expect_err("noncanonical non-shared provenance path must fail closed");
            assert!(error
                .message
                .contains("eigen_path_nonshared_provenance_sample_path_noncanonical"));
        }
    }

    #[test]
    fn canonical_sample_path_uses_minimum_width_for_large_indices() {
        let filename = "linearization_state.v7.json";
        let canonical = format!("eigen/metadata/sample_{:04}/{filename}", 10_000);
        let artifact = AuxiliaryArtifact {
            relative_path: canonical.clone(),
            bytes: b"signed".to_vec(),
        };
        let remapped = remap_single_k_mode_artifacts(
            &[artifact],
            10_000,
            &BTreeSet::new(),
        )
        .expect("sample_10000 is canonical Rust minimum-width formatting");
        assert_eq!(remapped[0].relative_path, canonical);

        for malformed in [
            "eigen/metadata/sample_00000/linearization_state.v7.json",
            "eigen/metadata/sample_00001/linearization_state.v7.json",
        ] {
            let error = remap_single_k_mode_artifacts(
                &[AuxiliaryArtifact {
                    relative_path: malformed.to_string(),
                    bytes: b"signed".to_vec(),
                }],
                0,
                &BTreeSet::new(),
            )
            .expect_err("arbitrary five-digit zero padding must fail closed");
            assert!(error
                .message
                .contains("eigen_path_signed_state_sample_path_noncanonical"));
        }
    }

    #[test]
    fn producer_provenance_sidecars_are_preserved_without_remap() {
        let sample_path =
            "eigen/metadata/sample_0007/producer_provenance.v1.json".to_string();
        let root_path = "equilibrium/producer_provenance.v1.json".to_string();
        let artifacts = vec![
            AuxiliaryArtifact {
                relative_path: sample_path.clone(),
                bytes: b"sample-provenance".to_vec(),
            },
            AuxiliaryArtifact {
                relative_path: root_path.clone(),
                bytes: b"root-provenance".to_vec(),
            },
        ];
        let remapped = remap_single_k_mode_artifacts(&artifacts, 7, &BTreeSet::new())
            .expect("producer provenance paths must remain immutable");
        assert_eq!(remapped.len(), 2);
        assert_eq!(remapped[0].relative_path, sample_path);
        assert_eq!(remapped[0].bytes, b"sample-provenance");
        assert_eq!(remapped[1].relative_path, root_path);
        assert_eq!(remapped[1].bytes, b"root-provenance");

        let error = remap_single_k_mode_artifacts(
            &[AuxiliaryArtifact {
                relative_path: "eigen/metadata/sample_00000/producer_provenance.v1.json"
                    .to_string(),
                bytes: b"invalid".to_vec(),
            }],
            0,
            &BTreeSet::new(),
        )
        .expect_err("noncanonical producer provenance path must fail closed");
        assert!(error
            .message
            .contains("eigen_path_producer_provenance_sample_path_noncanonical"));
    }

    #[test]
    fn signed_sidecars_preserve_exact_bytes_across_samples() {
        let filenames = [
            ("equilibrium", "accepted_fem_equilibrium_fields.v1.json"),
            ("equilibrium", "accepted_fem_equilibrium_fields.v2.json"),
            ("equilibrium", "certified_fem_equilibrium_fields.v1.json"),
            ("equilibrium", "certified_fem_equilibrium_fields.v2.json"),
            ("equilibrium", "recomputed_fem_linearization_certificate.v1.json"),
            ("equilibrium", "recomputed_fem_linearization_certificate.v2.json"),
            ("eigen/metadata", "certified_fem_equilibrium_fields.v1.json"),
            ("eigen/metadata", "certified_fem_equilibrium_fields.v2.json"),
            ("eigen/metadata", "recomputed_fem_linearization_certificate.v1.json"),
            ("eigen/metadata", "recomputed_fem_linearization_certificate.v2.json"),
            ("eigen/metadata", "linearization_identity.v2.json"),
            ("eigen/metadata", "linearization_identity_preimage.v1.json"),
            ("eigen/metadata", "equilibrium_artifact.v7.json"),
            ("eigen/metadata", "equilibrium_artifact.v8.json"),
            ("eigen/metadata", "linearization_state.v6.json"),
            ("eigen/metadata", "linearization_state.v7.json"),
            ("eigen/metadata", "accepted_fem_equilibrium_fields.v1.json"),
            ("eigen/metadata", "accepted_fem_equilibrium_fields.v2.json"),
        ];
        // Deliberate whitespace and sample-looking preimage strings prove
        // that neither JSON reserialization nor recursive rewriting is allowed.
        let payload = br#"{ "sample_index": 0, "preimage": "sample_0000", "path": "sample-0000" }"#;
        for sample_index in [0, 2, 7] {
            for (prefix, filename) in filenames {
                let artifacts = vec![AuxiliaryArtifact {
                    relative_path: format!("{prefix}/{filename}"),
                    bytes: payload.to_vec(),
                }];
                let remapped = remap_single_k_mode_artifacts(
                    &artifacts, sample_index, &BTreeSet::from([3_u32])).unwrap();
                assert_eq!(remapped.len(), 1);
                assert_eq!(remapped[0].relative_path,
                    format!("eigen/metadata/sample_{sample_index:04}/{filename}"));
                assert_eq!(remapped[0].bytes, payload.to_vec());
                let mut spectrum_only = remap_single_k_mode_artifacts(
                    &artifacts, sample_index, &BTreeSet::new()).unwrap();
                retain_selected_eigen_path_mode_artifacts(&mut spectrum_only, &BTreeSet::new());
                assert_eq!(spectrum_only.len(), 1);
                assert_eq!(spectrum_only[0].bytes, payload.to_vec());
                assert_eq!(eigen_path_state_metadata_paths(&spectrum_only, filename),
                    vec![spectrum_only[0].relative_path.clone()]);
            }
        }
    }

    #[test]
    fn actual_path_manifest_publishes_both_field_replay_families() {
        let model = crate::eigen::EigenSolverModel::ReferenceScalarTangent;
        let result = crate::eigen::PathSolveResult {
            gamma0_rad_s_per_a_m: 2.211e5, // Explicit fixture parameter.
            samples: [0, 2, 7].into_iter().map(|sample_index| crate::eigen::SingleKSolveResult {
                sample: KSampleDescriptor {
                    sample_index, label: None, segment_index: None,
                    path_s: sample_index as f64, t_in_segment: 0.0,
                    k_vector: [0.0, sample_index as f64, 0.0],
                },
                modes: Vec::new(), relaxation_steps: 0, solver_model: model,
                solver_notes: Vec::new(), solver_diagnostics: None,
            }).collect(),
            branches: Vec::new(), solver_model: model, notes: Vec::new(),
            include_demag: false, dispersion_validation: None,
            k0_kittel_validation: None, solver_policy: None,
            dispersion_analytic_reference: None, k0_kittel_periodic_airbox_demag: None,
        };
        for version in ["v1", "v2"] {
            let mut artifacts = Vec::new();
            for sample_index in [0, 2, 7] {
                for stem in ["accepted_fem_equilibrium_fields", "certified_fem_equilibrium_fields",
                             "recomputed_fem_linearization_certificate"] {
                    artifacts.push(AuxiliaryArtifact {
                        relative_path: format!("eigen/metadata/sample_{sample_index:04}/{stem}.{version}.json"),
                        bytes: b"signed".to_vec(),
                    });
                }
                artifacts.push(AuxiliaryArtifact {
                    relative_path: format!(
                        "eigen/metadata/sample_{sample_index:04}/producer_provenance.v1.json"
                    ),
                    bytes: b"producer-provenance".to_vec(),
                });
                artifacts.push(AuxiliaryArtifact {
                    relative_path: format!(
                        "eigen/metadata/sample_{sample_index:04}/linearization_identity.v2.json"
                    ),
                    bytes: b"identity".to_vec(),
                });
                artifacts.push(AuxiliaryArtifact {
                    relative_path: format!(
                        "eigen/metadata/sample_{sample_index:04}/linearization_identity_preimage.v1.json"
                    ),
                    bytes: b"preimage".to_vec(),
                });
            }
            let manifest = build_eigen_path_frequency_domain_manifest(
                FemEngine::CpuNative, &result, &artifacts,
                &residual_transport_test_plan(), &[]);
            for stem in ["accepted_fem_equilibrium_fields", "certified_fem_equilibrium_fields",
                         "recomputed_fem_linearization_certificate"] {
                let key = format!("{stem}_{version}_paths");
                let expected = [0, 2, 7].map(|sample_index| {
                    format!("eigen/metadata/sample_{sample_index:04}/{stem}.{version}.json")
                });
                assert_eq!(manifest["artifacts"][&key], serde_json::json!(expected));
                let other_version = if version == "v1" { "v2" } else { "v1" };
                let other_key = format!("{stem}_{other_version}_paths");
                assert_eq!(manifest["artifacts"][&other_key], serde_json::json!([]));
            }
            for (stem, expected) in [
                (
                    "linearization_identity_v2_paths",
                    [0, 2, 7].map(|sample_index| format!(
                        "eigen/metadata/sample_{sample_index:04}/linearization_identity.v2.json"
                    )),
                ),
                (
                    "linearization_identity_preimage_v1_paths",
                    [0, 2, 7].map(|sample_index| format!(
                        "eigen/metadata/sample_{sample_index:04}/linearization_identity_preimage.v1.json"
                    )),
                ),
            ] {
                assert_eq!(manifest["artifacts"][stem], serde_json::json!(expected));
            }
            assert_eq!(
                manifest["artifacts"]["producer_provenance_v1_paths"],
                serde_json::json!([
                    "eigen/metadata/sample_0000/producer_provenance.v1.json",
                    "eigen/metadata/sample_0002/producer_provenance.v1.json",
                    "eigen/metadata/sample_0007/producer_provenance.v1.json",
                ])
            );
            assert!(manifest["artifacts"]["producer_provenance_v1_path"].is_null());
            assert_eq!(manifest["artifacts"]["mode_field_storage_format"], "none");
        }
    }

    #[test]
    fn conflicting_signed_sample_sidecars_fail_before_deduplication() {
        let path = "eigen/metadata/sample_0007/certified_fem_equilibrium_fields.v2.json";
        let artifact = |bytes: &[u8]| AuxiliaryArtifact {
            relative_path: path.into(), bytes: bytes.to_vec(),
        };
        let mut identical = vec![artifact(b"signed"), artifact(b"signed")];
        deduplicate_auxiliary_artifacts_by_path(&mut identical).unwrap();
        assert_eq!(identical.len(), 1);
        let mut conflicting = vec![artifact(b"signed"), artifact(b"modified")];
        let error = deduplicate_auxiliary_artifacts_by_path(&mut conflicting).unwrap_err();
        assert!(error.message.contains("conflicting_signed_eigen_path_artifacts"));
        assert_eq!(conflicting.len(), 2, "failed validation must not discard evidence");
    }

    #[test]
    fn conflicting_identity_preimage_sidecars_fail_before_deduplication() {
        let path = "eigen/metadata/sample_0007/linearization_identity_preimage.v1.json";
        let artifact = |bytes: &[u8]| AuxiliaryArtifact {
            relative_path: path.into(),
            bytes: bytes.to_vec(),
        };
        let mut conflicting = vec![artifact(b"signed"), artifact(b"modified")];
        let error = deduplicate_auxiliary_artifacts_by_path(&mut conflicting).unwrap_err();
        assert!(error.message.contains("conflicting_signed_eigen_path_artifacts"));
        assert_eq!(conflicting.len(), 2, "failed validation must not discard evidence");
    }

    #[test]
    fn state_evidence_does_not_claim_mode_field_storage() {
        let mut artifacts = vec![AuxiliaryArtifact {
            relative_path: "eigen/metadata/sample_0007/accepted_fem_equilibrium_fields.v2.json".into(),
            bytes: b"{}".to_vec(),
        }];
        assert_eq!(eigen_path_mode_field_storage_format(&artifacts), "none");
        artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/modes/sample_0007/mode_0003.json".into(),
            bytes: b"{}".to_vec(),
        });
        assert_eq!(eigen_path_mode_field_storage_format(&artifacts), "none");
        artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/mode_fields/sample_0007/mode_0003/vector.bin".into(),
            bytes: vec![],
        });
        assert_eq!(eigen_path_mode_field_storage_format(&artifacts), "none");
        artifacts.last_mut().unwrap().bytes = vec![1; 48];
        assert_eq!(eigen_path_mode_field_storage_format(&artifacts), "binary_compatibility_exports");
        artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/mode_fields.zarr/.zgroup".into(), bytes: b"{}".to_vec(),
        });
        assert_eq!(eigen_path_mode_field_storage_format(&artifacts), "zarr");
    }

    #[test]
    fn internal_tracking_requests_all_modes_without_public_path_selectors() {
        let outputs = vec![
            OutputIR::EigenMode {
                field: "selected".into(),
                all_modes: false,
                indices: vec![1],
                branches: vec![4],
                sample_selector: Some(fullmag_ir::SampleSelectorIR {
                    sample_indices: vec![2],
                    sample_labels: vec![],
                }),
            },
            OutputIR::DispersionCurve {
                name: "bands".into(),
                include_branch_table: false,
            },
        ];
        let internal = eigen_path_tracking_outputs(&outputs, 3);
        assert!(internal
            .iter()
            .any(|output| matches!(output, OutputIR::EigenSpectrum { .. })));
        let modes = internal
            .iter()
            .filter_map(|output| match output {
                OutputIR::EigenMode {
                    all_modes,
                    indices,
                    branches,
                    sample_selector,
                    ..
                } => Some((all_modes, indices, branches, sample_selector)),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(modes.len(), 1);
        assert!(*modes[0].0);
        assert!(modes[0].1.is_empty());
        assert!(modes[0].2.is_empty());
        assert!(modes[0].3.is_none());

        // Candidate IDs come from the solved spectrum, not 0..requested_count.
        let model = crate::eigen::EigenSolverModel::ReferenceScalarTangent;
        let result = crate::eigen::PathSolveResult {
            gamma0_rad_s_per_a_m: 2.211e5,
            samples: [7, 20]
                .into_iter()
                .map(|sample_index| crate::eigen::SingleKSolveResult {
                    sample: KSampleDescriptor {
                        sample_index,
                        label: None,
                        segment_index: None,
                        path_s: sample_index as f64,
                        t_in_segment: 0.0,
                        k_vector: [0.0, sample_index as f64, 0.0],
                    },
                    modes: [4, 9, 11]
                        .into_iter()
                        .map(|raw_mode_index| {
                            let mut mode = residual_transport_test_mode(Some(1.0e-9));
                            mode.raw_mode_index = raw_mode_index;
                            mode.branch_id = None;
                            mode
                        })
                        .collect(),
                    relaxation_steps: 0,
                    solver_model: model,
                    solver_notes: Vec::new(),
                    solver_diagnostics: None,
                })
                .collect(),
            branches: Vec::new(),
            solver_model: model,
            notes: Vec::new(),
            include_demag: false,
            dispersion_validation: None,
            k0_kittel_validation: None,
            solver_policy: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };
        let selection = crate::eigen::output_selection::select_eigen_outputs(&result, &internal)
            .expect("internal tracking selects every returned candidate at every sample");
        for sample_index in [7, 20] {
            assert_eq!(
                selection.field_modes_for_sample(sample_index).collect::<Vec<_>>(),
                vec![4, 9, 11],
            );
        }
        assert!(!internal
            .iter()
            .any(|output| matches!(output, OutputIR::DispersionCurve { .. })));
    }
}

pub(super) fn eigen_path_mode_artifacts_from_result(
    path_result: &crate::eigen::PathSolveResult,
) -> Result<Vec<AuxiliaryArtifact>, RunError> {
    let temp_dir = std::env::temp_dir().join(format!(
        "fullmag-eigen-path-mode-artifacts-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&temp_dir).map_err(|error| RunError {
        message: format!("failed to create temporary eigen mode artifact directory: {error}"),
    })?;
    let write_result = crate::eigen::artifacts::write_mode_bundle(&temp_dir, path_result);
    let collect_result = write_result
        .map_err(|error| RunError {
            message: format!("failed to write analytic eigen mode bundle: {error}"),
        })
        .and_then(|_| collect_auxiliary_artifacts_from_dir(&temp_dir, &temp_dir));
    let _ = std::fs::remove_dir_all(&temp_dir);
    collect_result
}

fn collect_auxiliary_artifacts_from_dir(
    root: &std::path::Path,
    dir: &std::path::Path,
) -> Result<Vec<AuxiliaryArtifact>, RunError> {
    let mut artifacts = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|error| RunError {
        message: format!("failed to read temporary eigen mode artifact directory: {error}"),
    })? {
        let entry = entry.map_err(|error| RunError {
            message: format!("failed to read temporary eigen mode artifact entry: {error}"),
        })?;
        let path = entry.path();
        if path.is_dir() {
            artifacts.extend(collect_auxiliary_artifacts_from_dir(root, &path)?);
            continue;
        }
        let relative_path = path
            .strip_prefix(root)
            .map_err(|error| RunError {
                message: format!("failed to relativize temporary eigen mode artifact: {error}"),
            })?
            .to_string_lossy()
            .replace('\\', "/");
        let bytes = std::fs::read(&path).map_err(|error| RunError {
            message: format!(
                "failed to read temporary eigen mode artifact {relative_path}: {error}"
            ),
        })?;
        artifacts.push(AuxiliaryArtifact {
            relative_path,
            bytes,
        });
    }
    Ok(artifacts)
}

pub(super) fn eigen_path_mode_for_branch_point<'a>(
    path_result: &'a crate::eigen::PathSolveResult,
    point: &crate::eigen::TrackedBranchPoint,
) -> Option<&'a crate::eigen::SingleKModeResult> {
    path_result
        .samples
        .iter()
        .find(|sample| sample.sample.sample_index == point.sample_index)
        .and_then(|sample| {
            sample
                .modes
                .iter()
                .find(|mode| mode.raw_mode_index == point.raw_mode_index)
        })
}

pub(super) fn median_f64(values: &[f64]) -> Option<f64> {
    let mut finite = values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    if finite.is_empty() {
        return None;
    }
    finite.sort_by(|lhs, rhs| lhs.total_cmp(rhs));
    let mid = finite.len() / 2;
    if finite.len() % 2 == 0 {
        Some((finite[mid - 1] + finite[mid]) / 2.0)
    } else {
        Some(finite[mid])
    }
}

pub(super) fn eigen_path_requested_mode_indices(outputs: &[OutputIR]) -> BTreeSet<u32> {
    outputs
        .iter()
        .filter_map(|output| match output {
            OutputIR::EigenMode { indices, .. } => Some(indices),
            _ => None,
        })
        .flat_map(|indices| indices.iter().copied())
        .collect()
}

pub(super) fn eigen_path_wants_dispersion(outputs: &[OutputIR]) -> bool {
    outputs
        .iter()
        .any(|output| matches!(output, OutputIR::DispersionCurve { .. }))
}

pub(super) fn eigen_path_public_mode_indices(
    outputs: &[OutputIR],
    mode_count: u32,
) -> BTreeSet<u32> {
    let requested_modes = eigen_path_requested_mode_indices(outputs);
    let wants_spectrum = outputs
        .iter()
        .any(|output| matches!(output, OutputIR::EigenSpectrum { .. }));
    if wants_spectrum || eigen_path_wants_dispersion(outputs) {
        return (0..mode_count).collect();
    }
    requested_modes
}

pub(super) fn eigen_path_mode_artifact_indices(outputs: &[OutputIR]) -> BTreeSet<u32> {
    eigen_path_requested_mode_indices(outputs)
}

pub(super) fn eigen_path_single_k_solver_model(
    plan: &FemEigenPlanIR,
    artifacts: &[crate::types::AuxiliaryArtifact],
) -> crate::eigen::EigenSolverModel {
    for artifact in artifacts {
        if artifact.relative_path != "eigen/metadata/eigen_summary.json" {
            continue;
        }
        let Ok(summary) = serde_json::from_slice::<serde_json::Value>(&artifact.bytes) else {
            continue;
        };
        let diagnostics = summary.get("solver_diagnostics");
        let production_solver_available = diagnostics
            .and_then(|value| value.get("production_solver_available"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let execution_lane = diagnostics
            .and_then(|value| value.get("execution_lane"))
            .and_then(|value| value.as_str());
        let solver_model = diagnostics
            .and_then(|value| value.get("solver_model"))
            .or_else(|| summary.get("solver_kind"))
            .and_then(|value| value.as_str());
        let solver_adapter = diagnostics
            .and_then(|value| value.get("solver_adapter"))
            .and_then(|value| value.as_str());
        let spectral_transform = diagnostics
            .and_then(|value| value.get("spectral_transform"))
            .and_then(|value| value.as_str());
        if production_solver_available
            && execution_lane == Some("production_cpu")
            && (solver_model == Some("slepc_multi_shift_invert_production_cpu_dense")
                || solver_model == Some("slepc_multi_shift_invert_production_cpu_sparse_csr")
                || solver_adapter == Some("k0_poisson_airbox_cpu_full_coupled_slepc")
                || solver_adapter == Some("k0_poisson_airbox_cpu_schur_slepc"))
            && spectral_transform == Some("shift_invert")
        {
            if matches!(
                plan.spin_wave_bc.kind(),
                fullmag_ir::SpinWaveBoundaryKindIR::Floquet
            ) && !eigen_path_single_k_has_bloch_floquet_contract(diagnostics)
            {
                return crate::eigen::EigenSolverModel::ReferenceFull2x2Tangent;
            }
            return crate::eigen::EigenSolverModel::ProductionCpuShiftInvert;
        }
        if production_solver_available
            && execution_lane == Some("production_gpu")
            && solver_model == Some("gpu_dense_k0_macrospin_modal_eigen")
        {
            return crate::eigen::EigenSolverModel::ProductionGpuDenseK0Macrospin;
        }
        if production_solver_available
            && execution_lane == Some("production_gpu")
            && (solver_model == Some("k0_poisson_airbox_gpu_petsc_slepc")
                || solver_model == Some("k0_poisson_airbox_gpu_modal_device_krylov")
                || solver_adapter == Some("k0_poisson_airbox_gpu_petsc_slepc")
                || solver_adapter == Some("k0_poisson_airbox_gpu_modal_device_krylov"))
            && diagnostics.is_some_and(eigen_path_gpu_modal_device_contract)
        {
            return crate::eigen::EigenSolverModel::ProductionGpuModalDeviceKrylov;
        }
    }

    if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        crate::eigen::EigenSolverModel::ReferenceFull2x2Tangent
    } else {
        crate::eigen::EigenSolverModel::ReferenceScalarTangent
    }
}

pub(super) fn eigen_path_gpu_modal_device_contract(diagnostics: &serde_json::Value) -> bool {
    let has_contract = |sample: &serde_json::Value| {
        sample.get("gpu_device_resident_modal_eigensolver") == Some(&serde_json::json!(true))
            && sample.get("persistent_solver_context") == Some(&serde_json::json!(true))
            && sample.get("scalable_selected_spectrum") == Some(&serde_json::json!(true))
            // A bounded validation adapter may still use CUDA vectors and a
            // matrix-free action, but it is not a production capability.
            // Keep the explicit provenance flags fail-closed at this final
            // promotion boundary.
            && sample.get("validation_only") != Some(&serde_json::json!(true))
            && sample.get("production_implication") != Some(&serde_json::json!(false))
            // A host-projected Hessenberg/Ritz state is a valid bounded
            // diagnostic lane, but it is not the production device-resident
            // modal contract.  Reject it even when the older three boolean
            // markers are present for compatibility.
            && sample
                .get("host_ritz_extraction")
                .and_then(serde_json::Value::as_bool)
                != Some(true)
    };
    if has_contract(diagnostics) {
        return true;
    }
    diagnostics
        .get("sample_solver_diagnostics")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|samples| {
            !samples.is_empty()
                && samples
                    .iter()
                    .all(|sample| sample.get("diagnostics").is_some_and(has_contract))
        })
}

pub(super) fn eigen_path_single_k_has_bloch_floquet_contract(
    diagnostics: Option<&serde_json::Value>,
) -> bool {
    diagnostics
        .and_then(|value| value.get("operator_diagnostics"))
        .and_then(|value| value.get("payload_kind"))
        .and_then(|value| value.as_str())
        == Some("bloch_floquet_tangent_operator")
        && diagnostics
            .and_then(|value| value.get("modal_periodic_pair_contract_available"))
            .and_then(|value| value.as_bool())
            == Some(true)
        && diagnostics
            .and_then(|value| value.get("floquet_periodic_pair_count"))
            .and_then(|value| value.as_u64())
            .is_some_and(|count| count > 0)
        && diagnostics
            .and_then(|value| value.get("operator_diagnostics"))
            .and_then(|value| value.get("demag_payload_kind"))
            .is_none()
        && !eigen_path_operator_diagnostics_has_gated_terms(diagnostics)
}

pub(super) fn eigen_path_operator_diagnostics_has_gated_terms(
    diagnostics: Option<&serde_json::Value>,
) -> bool {
    diagnostics
        .and_then(|value| value.get("operator_diagnostics"))
        .and_then(|value| value.get("operator_terms_included"))
        .and_then(|value| value.as_array())
        .is_some_and(|terms| {
            terms.iter().any(|term| {
                matches!(
                    term.as_str(),
                    Some(
                        "demag"
                            | "dynamic_demag"
                            | "periodic_poisson"
                            | "floquet_airbox"
                            | "dmi"
                            | "interfacial_dmi"
                            | "bulk_dmi"
                            | "magnetoelastic"
                    )
                )
            })
        })
}

pub(super) fn eigen_path_tracking_outputs(outputs: &[OutputIR], mode_count: u32) -> Vec<OutputIR> {
    // A single-k solver must not see path-level branch/sample selectors. Its
    // candidate vectors are needed at every sample to track before exporting.
    let mut tracking_outputs = outputs
        .iter()
        .filter(|output| {
            !matches!(
                output,
                OutputIR::EigenMode { .. } | OutputIR::DispersionCurve { .. }
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    if !tracking_outputs
        .iter()
        .any(|output| matches!(output, OutputIR::EigenSpectrum { .. }))
    {
        tracking_outputs.push(OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        });
    }

    if mode_count > 0 {
        tracking_outputs.push(OutputIR::EigenMode {
            field: "mode".to_string(),
            all_modes: true,
            indices: vec![],
            branches: vec![],
            sample_selector: None,
        });
    }
    tracking_outputs
}

pub(super) fn eigen_path_mode_tracking_vector(
    artifacts: &[crate::types::AuxiliaryArtifact],
    raw_mode_index: usize,
    active_nodes: Option<&[usize]>,
    coordinates_m: &[[f64; 3]],
    k_vector_rad_per_m: [f64; 3],
    remove_bloch_phase: bool,
    expected_mesh_identity: &str,
) -> Result<Option<Vec<num_complex::Complex64>>, RunError> {
    let invalid = |detail: &str| RunError {
        message: format!("eigen path tracking mode {raw_mode_index}: {detail}"),
    };
    let legacy_path = format!("eigen/modes/mode_{raw_mode_index:04}.json");
    let mut matching = artifacts
        .iter()
        .filter(|artifact| artifact.relative_path == legacy_path);
    let Some(artifact) = matching.next() else {
        return Ok(None);
    };
    if matching.next().is_some() {
        return Err(invalid("duplicate mode payload artifacts"));
    }
    let mode: serde_json::Value = serde_json::from_slice(&artifact.bytes)
        .map_err(|_| invalid("invalid mode payload JSON"))?;
    if !mode.is_object() {
        return Err(invalid("mode payload must be an object"));
    }
    if mode.get("real").is_none() && mode.get("imag").is_none() {
        return Ok(None);
    }
    if expected_mesh_identity.is_empty()
        || mode
            .get("source_mesh_topology_sha256")
            .and_then(Value::as_str)
            != Some(expected_mesh_identity)
    {
        return Err(invalid(
            "mode payload topology identity disagrees with the full tracking mesh",
        ));
    }
    let expected_index = u64::try_from(raw_mode_index)
        .map_err(|_| invalid("raw mode index cannot be represented as u64"))?;
    if mode.get("index").and_then(Value::as_u64) != Some(expected_index) {
        return Err(invalid("mode payload has a mismatched raw mode index"));
    }
    if coordinates_m.is_empty()
        || coordinates_m
            .iter()
            .flatten()
            .any(|value| !value.is_finite())
        || k_vector_rad_per_m.iter().any(|value| !value.is_finite())
    {
        return Err(invalid(
            "tracking coordinates and wavevector must be finite and nonempty",
        ));
    }
    let declared_k = mode
        .get("k_vector")
        .and_then(Value::as_array)
        .filter(|values| values.len() == 3)
        .ok_or_else(|| invalid("mode payload is missing its wavevector"))?;
    for (value, expected) in declared_k.iter().zip(k_vector_rad_per_m) {
        let declared = value
            .as_f64()
            .filter(|number| number.is_finite())
            .ok_or_else(|| invalid("mode payload wavevector must be finite"))?;
        if declared != expected {
            return Err(invalid(
                "mode payload wavevector disagrees with its path sample",
            ));
        }
    }
    // Share strict Cartesian parsing with field publication. Never drop rows
    // or synthesize missing components, which would corrupt node indexing.
    let real = crate::fem::eigen_output::mode_vector_entries(&mode, "real")?;
    let imag = crate::fem::eigen_output::mode_vector_entries(&mode, "imag")?;
    if real.len() != coordinates_m.len() || imag.len() != coordinates_m.len() {
        return Err(invalid(
            "real/imag payload lengths disagree with the full tracking mesh",
        ));
    }
    let indices = active_nodes.map_or_else(
        || (0..coordinates_m.len()).collect::<Vec<_>>(),
        <[usize]>::to_vec,
    );
    if indices.is_empty() {
        return Err(invalid("tracking active-node selection is empty"));
    }
    let mut seen = BTreeSet::new();
    let capacity = indices
        .len()
        .checked_mul(3)
        .ok_or_else(|| invalid("tracking vector length overflows usize"))?;
    let mut vector = Vec::with_capacity(capacity);
    for index in indices {
        if index >= coordinates_m.len() || !seen.insert(index) {
            return Err(invalid(
                "tracking active-node selection is duplicated or out of range",
            ));
        }
        let phase_angle = if remove_bloch_phase {
            coordinates_m[index]
                .iter()
                .zip(k_vector_rad_per_m)
                .map(|(coordinate, wavevector)| coordinate * wavevector)
                .sum::<f64>()
        } else {
            0.0
        };
        if !phase_angle.is_finite() {
            return Err(invalid("Bloch envelope phase is not finite"));
        }
        // Spatial convention exp(-i k.r): the periodic envelope is obtained
        // with exp(+i k.r). This is independent of the temporal phasor sign.
        let unwind = num_complex::Complex64::new(phase_angle.cos(), phase_angle.sin());
        for component in 0..3 {
            let value = num_complex::Complex64::new(real[index][component], imag[index][component])
                * unwind;
            if !value.re.is_finite() || !value.im.is_finite() {
                return Err(invalid("Bloch envelope contains a non-finite component"));
            }
            vector.push(value);
        }
    }
    Ok(Some(vector))
}

pub(super) fn eigen_path_branch_point_for_mode<'a>(
    path_result: &'a crate::eigen::PathSolveResult,
    sample_index: usize,
    raw_mode_index: usize,
) -> Option<(
    &'a crate::eigen::TrackedBranch,
    usize,
    &'a crate::eigen::TrackedBranchPoint,
)> {
    path_result.branches.iter().find_map(|branch| {
        branch
            .points
            .iter()
            .enumerate()
            .find(|(_, point)| {
                point.sample_index == sample_index && point.raw_mode_index == raw_mode_index
            })
            .map(|(point_index, point)| (branch, point_index, point))
    })
}

pub(super) fn eigen_path_branch_point_modal_overlap_available(
    path_result: &crate::eigen::PathSolveResult,
    branch: &crate::eigen::TrackedBranch,
    point_index: usize,
) -> bool {
    matches!(
        eigen_path_branch_point_tracking_score_source(path_result, branch, point_index),
        "modal_overlap_weighted_score"
            | "modal_overlap_unweighted_score"
            | "modal_subspace_transport_score"
    )
}

pub(super) fn eigen_path_branch_point_tracking_score_source(
    path_result: &crate::eigen::PathSolveResult,
    branch: &crate::eigen::TrackedBranch,
    point_index: usize,
) -> &'static str {
    let Some(point) = branch.points.get(point_index) else {
        return "unknown";
    };
    if let Some(edge) = &point.tracking_edge {
        return edge.score_source.as_str();
    }
    if point_index == 0 {
        return "seed";
    }
    let previous_mode = branch
        .points
        .get(point_index - 1)
        .and_then(|previous| eigen_path_mode_for_branch_point(path_result, previous));
    let current_mode = eigen_path_mode_for_branch_point(path_result, point);
    crate::eigen::tracking::tracking_score_source_for_modes(
        previous_mode,
        current_mode,
        point.overlap_prev,
    )
}

pub(super) fn eigen_path_tracking_score_summary(
    path_result: &crate::eigen::PathSolveResult,
) -> (&'static str, bool) {
    let sources = path_result
        .branches
        .iter()
        .flat_map(|branch| {
            (0..branch.points.len()).map(|point_index| {
                eigen_path_branch_point_tracking_score_source(path_result, branch, point_index)
            })
        })
        .collect::<Vec<_>>();
    crate::eigen::tracking::tracking_score_source_summary(&sources)
}

pub(super) fn eigen_path_mode_field_id(sample_index: usize, raw_mode_index: usize) -> String {
    format!("analysis:eigen:sample-{sample_index:04}:mode-{raw_mode_index:04}")
}

pub(super) fn eigen_path_line_width_hz(frequency_imag_hz: f64) -> Option<String> {
    if !frequency_imag_hz.is_finite() || frequency_imag_hz <= 0.0 {
        return None;
    }
    Some(format!("{:.16e}", 2.0 * frequency_imag_hz))
}

pub(super) struct EigenPathDeBvAnalyticCsvColumns {
    pub(super) analytic_frequency_hz: String,
    pub(super) relative_error: String,
    pub(super) geometry: String,
}

pub(super) fn eigen_path_de_bv_analytic_csv_columns(
    plan: &FemEigenPlanIR,
    sample: &crate::eigen::KSampleDescriptor,
    mode: &crate::eigen::SingleKModeResult,
) -> EigenPathDeBvAnalyticCsvColumns {
    let Some(validation) = plan.dispersion_validation.as_ref() else {
        return EigenPathDeBvAnalyticCsvColumns {
            analytic_frequency_hz: String::new(),
            relative_error: String::new(),
            geometry: String::new(),
        };
    };
    if validation.kind != "thin_film_de_bv_low_k"
        || validation.analytic_model != "kalinikos_slab_n0"
    {
        return EigenPathDeBvAnalyticCsvColumns {
            analytic_frequency_hz: String::new(),
            relative_error: String::new(),
            geometry: String::new(),
        };
    }

    let sin_squared_phi = de_bv_sin_squared_phi_for_k(sample.k_vector, validation).ok();
    let geometry = sin_squared_phi.map(|value| {
        if value <= 1.0e-12 {
            "backward_volume"
        } else if (value - 1.0).abs() <= 1.0e-12 {
            "damon_eshbach"
        } else {
            "oblique"
        }
    });
    let analytic_frequency_hz = sin_squared_phi.and_then(|sin_squared_phi| {
        kalinikos_slab_n0_frequency_hz_for_angle(
            vector_norm(sample.k_vector),
            sin_squared_phi,
            vector_norm(plan.external_field.unwrap_or([0.0, 0.0, 0.0])),
            validation.film_thickness_m,
            plan.material.exchange_stiffness,
            plan.material.saturation_magnetisation,
            plan.gyromagnetic_ratio,
        )
        .ok()
    });
    let relative_error = analytic_frequency_hz
        .map(|analytic| (mode.frequency_real_hz - analytic).abs() / analytic.abs().max(1.0));
    EigenPathDeBvAnalyticCsvColumns {
        analytic_frequency_hz: analytic_frequency_hz
            .map(|value| format!("{value:.16e}"))
            .unwrap_or_default(),
        relative_error: relative_error
            .map(|value| format!("{value:.16e}"))
            .unwrap_or_default(),
        geometry: geometry.unwrap_or_default().to_string(),
    }
}

pub(super) fn de_bv_validation_geometry_for_sample(
    validation: &fullmag_ir::FemEigenDispersionValidationIR,
    sample_index: usize,
) -> Option<&str> {
    let sample_index = u32::try_from(sample_index).ok()?;
    validation.scenarios.iter().find_map(|scenario| {
        if !scenario.sample_indices.contains(&sample_index) {
            return None;
        }
        match scenario.geometry.as_str() {
            "de" | "damon_eshbach" | "damon-eshbach" => Some("damon_eshbach"),
            "bv" | "backward_volume" | "backward-volume" => Some("backward_volume"),
            _ => None,
        }
    })
}

pub(super) fn eigen_path_mode_json(
    plan: &FemEigenPlanIR,
    sample: &crate::eigen::KSampleDescriptor,
    mode: &crate::eigen::SingleKModeResult,
    solver_model: crate::eigen::EigenSolverModel,
    solver_diagnostics: Option<&serde_json::Value>,
) -> serde_json::Value {
    let residual_absolute_l2 = mode
        .residual_norm
        .filter(|value| value.is_finite() && *value >= 0.0);
    let residual_relative_l2 = mode
        .residual_relative_l2
        .filter(|value| value.is_finite() && *value >= 0.0);
    let residual_linf = mode
        .residual_linf
        .filter(|value| value.is_finite() && *value >= 0.0);
    let tangent_leakage_mean_abs = finite_or_default(mode.tangent_leakage_mean_abs, 0.0);
    let tangent_leakage_max_abs =
        finite_or_default(mode.tangent_leakage_max_abs, tangent_leakage_mean_abs)
            .max(tangent_leakage_mean_abs);
    let tangent_leakage_weighted_relative_l2 =
        finite_or_default(mode.tangent_leakage_weighted_relative_l2, 0.0);
    let gamma0_rad_s_per_a_m = plan.gyromagnetic_ratio;
    let gamma_rad_s_t = gamma0_rad_s_per_a_m / crate::MU0;
    let mass_norm = finite_or_default(
        mode.mass_norm,
        if mode.norm.is_finite() && mode.norm > 0.0 {
            mode.norm
        } else {
            1.0
        },
    );
    let production_shift_invert =
        solver_model == crate::eigen::EigenSolverModel::ProductionCpuShiftInvert;
    let production_periodic_airbox_k0 = periodic_airbox_k0_runtime_supported(plan);
    let production_gyrotropic = production_shift_invert
        || production_periodic_airbox_k0
        || solver_model == crate::eigen::EigenSolverModel::ProductionGpuDenseK0Macrospin;
    let provenance_value = |key: &str| {
        solver_diagnostics
            .and_then(|diagnostics| diagnostics.get(key))
            .cloned()
            .unwrap_or(serde_json::Value::Null)
    };

    let mut value = serde_json::json!({
        "index": mode.raw_mode_index,
        "raw_mode_index": mode.raw_mode_index,
        "branch_id": mode.branch_id,
        "frequency_hz": mode.frequency_real_hz,
        "frequency_real_hz": mode.frequency_real_hz,
        "frequency_imag_hz": mode.frequency_imag_hz,
        "angular_frequency_rad_per_s": mode.angular_frequency_rad_per_s,
        "omega_rad_s": mode.angular_frequency_rad_per_s,
        "eigenvalue_real": mode.eigenvalue_real,
        "eigenvalue_imag": mode.eigenvalue_imag,
        "phasor_convention": if production_periodic_airbox_k0 { "exp_plus_i_omega_t" } else if production_gyrotropic { "exp_i_omega_t" } else { "not_applicable_real_reference" },
        "eigenvalue_mapping": if production_periodic_airbox_k0 { "lambda_imag_positive_frequency" } else if production_gyrotropic { "lambda_eq_i_omega" } else { "omega_rad_s_eq_gamma0_rad_s_per_A_m_times_effective_field_lambda_A_per_m" },
        "norm": mode.norm,
        "max_amplitude": mode.max_amplitude,
        "residual_norm": residual_absolute_l2,
        "residual_absolute_l2": residual_absolute_l2,
        "residual_relative_l2": residual_relative_l2,
        "residual_linf": residual_linf,
        "mass_norm": mass_norm,
        "tangent_leakage_mean_abs": tangent_leakage_mean_abs,
        "tangent_leakage_max_abs": tangent_leakage_max_abs,
        "tangent_leakage_weighted_relative_l2": tangent_leakage_weighted_relative_l2,
        "gamma_rad_s_T": gamma_rad_s_t,
        "gamma0_rad_s_per_A_m": gamma0_rad_s_per_a_m,
        "mu0_T_m_per_A": crate::MU0,
        "dominant_polarization": mode.dominant_polarization,
        "k_vector": sample.k_vector,
        "external_field_a_per_m": eigen_path_external_field(plan, sample.sample_index),
        "assembly_kind": provenance_value("assembly_kind"),
        "operator_input_signature_sha256": provenance_value("operator_input_signature_sha256"),
        "phase_constraint_sha256": provenance_value("phase_constraint_sha256"),
        "equilibrium_artifact_sha256": provenance_value("equilibrium_artifact_sha256"),
        "linearization_state_sha256": provenance_value("linearization_state_sha256"),
        "periodic_mesh_certificate_sha256": provenance_value("periodic_mesh_certificate_sha256"),
        "mode_field_id": eigen_path_mode_field_id(
            sample.sample_index,
            mode.raw_mode_index,
        ),
    });
    // A solver-level aggregate is not a per-mode residual certificate.
    // Bind the unchanged native certificate to the sample and raw mode,
    // rejecting ambiguity and a changed frequency instead of inventing proof.
    if let Some(records) = solver_diagnostics
        .and_then(|diagnostics| diagnostics.get("native_mode_block_residuals"))
        .and_then(serde_json::Value::as_array)
    {
        let mut matching = records.iter().filter(|record| {
            record["sample_index"].as_u64() == Some(sample.sample_index as u64)
                && record["raw_mode_index"].as_u64() == Some(mode.raw_mode_index as u64)
        });
        if let Some(record) = matching.next() {
            if matching.next().is_none() {
                if let (Some(frequency), Some(blocks)) = (
                    record["frequency_hz"].as_f64(),
                    record
                        .get("block_residuals")
                        .filter(|blocks| blocks.is_object()),
                ) {
                    if frequency.is_finite()
                        && mode.frequency_real_hz.is_finite()
                        && (frequency - mode.frequency_real_hz).abs()
                            <= 1.0e-12 * frequency.abs().max(1.0)
                    {
                        value["block_residuals"] = blocks.clone();
                    }
                }
            }
        }
    }
    if let Some(weights) = mode.node_mass_weights.as_ref() {
        value["node_mass_weights"] = serde_json::json!(weights);
    }
    if let Some(metric) = mode.consistent_p1_metric.as_ref() {
        value["tracking_consistent_p1_metric"] = metric.artifact_json();
    }
    if let Ok(modal_source_mesh_topology) = plan.mesh.mixed_topology_fingerprint_v3() {
        value["source_mesh_topology_sha256"] = serde_json::json!(modal_source_mesh_topology);
    }
    for key in [
        "relax_to_eigen_handoff_sha256",
        "relax_to_eigen_source_mesh_topology_sha256",
    ] {
        if let Some(value_from_diagnostics) =
            solver_diagnostics.and_then(|diagnostics| diagnostics.get(key))
        {
            value[key] = value_from_diagnostics.clone();
        }
    }
    value
}

pub(super) fn eigen_path_mode_v3_json(
    plan: &FemEigenPlanIR,
    sample: &crate::eigen::KSampleDescriptor,
    mode: &crate::eigen::SingleKModeResult,
    solver_model: crate::eigen::EigenSolverModel,
    solver_diagnostics: Option<&serde_json::Value>,
) -> serde_json::Value {
    let mut value = eigen_path_mode_json(plan, sample, mode, solver_model, solver_diagnostics);
    value["mode_id"] = serde_json::json!(format!(
        "sample-{:04}/mode-{:04}",
        sample.sample_index, mode.raw_mode_index
    ));
    value["component_participation"] = serde_json::to_value(&mode.component_participation)
        .expect("validated modal participation observable must serialize");
    value
}

pub(super) fn eigen_path_external_field(
    plan: &FemEigenPlanIR,
    sample_index: usize,
) -> Option<[f64; 3]> {
    if bias_field_sweep_requested(plan) {
        return plan
            .bias_field_samples
            .iter()
            .find(|sample| sample.sample_index as usize == sample_index)
            .map(|sample| sample.field_a_per_m);
    }
    plan.external_field
}

pub(super) fn eigen_path_node_mass_weights_from_json(
    value: &serde_json::Value,
) -> Option<Vec<f64>> {
    let array = value.as_array()?;
    if array.is_empty() {
        return None;
    }
    let mut weights = Vec::with_capacity(array.len());
    for item in array {
        let weight = item.as_f64()?;
        if !(weight.is_finite() && weight > 0.0) {
            return None;
        }
        weights.push(weight);
    }
    Some(weights)
}

pub(super) fn eigen_path_component_participation_from_json(
    value: Option<&serde_json::Value>,
    solver_device: &str,
) -> Result<crate::eigen::ModalParticipationObservable, crate::types::RunError> {
    let Some(value) = value else {
        return Ok(
            crate::eigen::ModalParticipationObservable::unavailable_without_context(solver_device),
        );
    };
    let observable =
        serde_json::from_value::<crate::eigen::ModalParticipationObservable>(value.clone())
            .map_err(|error| crate::types::RunError {
                message: format!("invalid managed component participation payload: {error}"),
            })?;
    let valid_status_payload = match observable.status {
        crate::eigen::ModalParticipationAvailability::Ready => {
            observable.global.is_some()
                && !observable.objects.is_empty()
                && observable.unavailable.is_none()
        }
        crate::eigen::ModalParticipationAvailability::Unavailable => {
            observable.global.is_none()
                && observable.objects.is_empty()
                && observable.unavailable.is_some()
        }
    };
    if observable.schema_version != "modal_component_participation.v1"
        || observable.definition_id != crate::eigen::MODAL_PARTICIPATION_DEFINITION_ID
        || !valid_status_payload
    {
        return Err(crate::types::RunError {
            message: "invalid managed component participation contract".to_string(),
        });
    }
    Ok(observable)
}

pub(super) fn eigen_path_public_mode_count(
    result: &crate::eigen::PathSolveResult,
    published_mode_ids: &BTreeSet<SampleModeId>,
) -> usize {
    result
        .samples
        .iter()
        .map(|sample| {
            sample
                .modes
                .iter()
                .filter(|mode| {
                    published_mode_ids.contains(&SampleModeId::new(
                        sample.sample.sample_index,
                        mode.raw_mode_index,
                    ))
                })
                .count()
        })
        .max()
        .unwrap_or(0)
}

pub(super) fn eigen_path_floquet_periodic_pair_count(plan: &FemEigenPlanIR) -> u64 {
    if !matches!(
        plan.spin_wave_bc.kind(),
        fullmag_ir::SpinWaveBoundaryKindIR::Floquet
    ) {
        return 0;
    }
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    if requested_pair_ids.is_empty() {
        return 0;
    }
    plan.mesh
        .periodic_boundary_pairs
        .iter()
        .filter(|boundary_pair| {
            requested_pair_ids
                .iter()
                .any(|requested| *requested == boundary_pair.pair_id)
                && boundary_pair.translation.is_some()
                && plan
                    .mesh
                    .periodic_node_pairs
                    .iter()
                    .any(|node_pair| node_pair.pair_id == boundary_pair.pair_id)
        })
        .count() as u64
}

pub(super) fn eigen_path_floquet_periodic_mesh_certificate(
    plan: &FemEigenPlanIR,
) -> Option<serde_json::Value> {
    if !matches!(
        plan.spin_wave_bc.kind(),
        fullmag_ir::SpinWaveBoundaryKindIR::Floquet
    ) {
        return None;
    }
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    if requested_pair_ids.is_empty() {
        return None;
    }
    let mut node_pairs: Vec<_> = plan
        .mesh
        .periodic_node_pairs
        .iter()
        .filter(|node_pair| {
            requested_pair_ids
                .iter()
                .any(|requested| *requested == node_pair.pair_id)
        })
        .collect();
    if node_pairs.is_empty() {
        return None;
    }
    node_pairs.sort_by(|left, right| {
        left.pair_id
            .cmp(&right.pair_id)
            .then(left.node_a.cmp(&right.node_a))
            .then(left.node_b.cmp(&right.node_b))
    });

    let mut canonical_payload =
        String::from("periodic_mesh_certificate_pair_map.v1\nschema=periodic_mesh_certificate.v5\nrole=magnetic\n");
    for node_pair in &node_pairs {
        canonical_payload.push_str(&format!(
            "pair_id_len={};pair_id={};node_a={};node_b={}\n",
            node_pair.pair_id.len(),
            node_pair.pair_id,
            node_pair.node_a,
            node_pair.node_b
        ));
    }
    let digest = Sha256::digest(canonical_payload.as_bytes());
    Some(serde_json::json!({
        "schema_version": "periodic_mesh_certificate.v5",
        "certificate_status": "accepted",
        "magnetic_pair_count": node_pairs.len(),
        "magnetic_pair_map_sha256": format!("sha256:{digest:x}"),
        "pair_map_hash_canonicalization": "periodic_mesh_certificate_pair_map.v1_schema_role_pair_id_len_sorted_nodes",
    }))
}

pub(super) fn eigen_path_solver_diagnostics(
    engine: FemEngine,
    plan: &FemEigenPlanIR,
    result: &crate::eigen::PathSolveResult,
    published_mode_ids: &BTreeSet<SampleModeId>,
) -> serde_json::Value {
    let gamma0_rad_s_per_a_m = result.gamma0_rad_s_per_a_m;
    let public_mode_count = eigen_path_public_mode_count(result, published_mode_ids);
    let requested_production_shift_invert =
        result.solver_model == crate::eigen::EigenSolverModel::ProductionCpuShiftInvert;
    let native_cpu_modal_window_rejection_reason =
        fem_eigen::native_cpu_modal_window_rejection_reason(plan);
    let production_shift_invert =
        requested_production_shift_invert && native_cpu_modal_window_rejection_reason.is_none();
    let production_gpu_k0_kittel =
        result.solver_model == crate::eigen::EigenSolverModel::ProductionGpuDenseK0Macrospin;
    let production_periodic_airbox_k0 = periodic_airbox_k0_runtime_supported(plan);
    let production_periodic_airbox_gpu =
        production_periodic_airbox_k0 && engine == FemEngine::NativeGpu;
    let production_modal_solver =
        production_shift_invert || production_gpu_k0_kittel || production_periodic_airbox_k0;
    let mut diagnostics = serde_json::json!({
        "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
        "study_product": "modal_eigen",
        "status": "ready",
        "complete": true,
        "solver_model": if production_periodic_airbox_gpu { "k0_poisson_airbox_gpu_petsc_slepc" } else if production_periodic_airbox_k0 { "k0_poisson_airbox_cpu_schur_slepc" } else { result.solver_model.as_str() },
        "solver_family": if production_periodic_airbox_gpu { "gpu_petsc_slepc_cuda" } else if production_periodic_airbox_k0 { "k0_poisson_airbox_schur" } else { result.solver_model.as_str() },
        "resolved_solver_family": if production_periodic_airbox_gpu { "device_resident_arnoldi_shift_invert" } else if production_periodic_airbox_k0 { "k0_poisson_airbox_schur" } else if production_shift_invert { "shift_invert" } else if production_gpu_k0_kittel { "gpu_dense_k0_macrospin" } else { result.solver_model.as_str() },
        "spectral_transform": if production_periodic_airbox_gpu { "shift_invert" } else if production_periodic_airbox_k0 { "shift_invert" } else if production_shift_invert { "shift_invert" } else if production_gpu_k0_kittel { "dense_generalized" } else { "none" },
        "solver_adapter": if production_periodic_airbox_gpu { "k0_poisson_airbox_gpu_petsc_slepc" } else if production_periodic_airbox_k0 { "k0_poisson_airbox_cpu_schur_slepc" } else if production_shift_invert { "slepc_modal_eigen" } else if production_gpu_k0_kittel { "cusolverdn_dense_k0_macrospin_modal" } else { "multi_k_reference_modal_path" },
        "solver_notes": result.notes,
        "execution_lane": if production_periodic_airbox_gpu { "production_gpu" } else if production_periodic_airbox_k0 { "production_cpu" } else if production_shift_invert { "production_cpu" } else if production_gpu_k0_kittel { "production_gpu" } else { "reference_cpu" },
        "algebraic_form": if production_periodic_airbox_gpu { "schur_reduced_descriptor" } else if production_periodic_airbox_k0 { "schur_reduced_descriptor" } else if production_shift_invert { "gyrotropic_generalized" } else if production_gpu_k0_kittel { "k0_macrospin_field_generalized_to_gyrotropic_modal" } else { "reference_effective_field_generalized" },
        "matrix_equation": if production_periodic_airbox_gpu { "L_eff q = lambda B_qq q; phi(q) = -P^-1 A_phiq q" } else if production_periodic_airbox_k0 { "L_eff q = lambda B_qq q; phi(q) = -P^-1 A_phiq q" } else if production_shift_invert { "A q = lambda B q" } else if production_gpu_k0_kittel { "K u = lambda_field M u; lambda_modal = i gamma0 lambda_field" } else { "K u = lambda M u" },
        "phasor_convention": if production_periodic_airbox_k0 { "exp_plus_i_omega_t" } else if production_shift_invert || production_gpu_k0_kittel { "exp_i_omega_t" } else { "not_applicable_real_reference" },
        "eigenvalue_mapping": if production_periodic_airbox_k0 { "lambda_imag_positive_frequency" } else if production_shift_invert || production_gpu_k0_kittel { "lambda_eq_i_omega" } else { "omega_rad_s_eq_gamma0_rad_s_per_A_m_times_effective_field_lambda_A_per_m" },
        "frequency_mapping": if production_modal_solver { "frequency_hz = imag(lambda)/(2*pi)" } else { "frequency_hz = omega_rad_s / (2*pi)" },
        "production_gyrotropic_mapping": production_modal_solver,
        "production_solver_available": production_modal_solver,
        "dense_reference_oracle": false,
        "sample_count": result.samples.len(),
        "mode_count": public_mode_count,
        "requested_mode_count": plan.count,
        "normalization": format!("{:?}", plan.normalization).to_lowercase(),
        "residual_definition": "residual_absolute_l2 is the solver-reported modal residual norm; residual_relative_l2 is the solver-reported relative L2 residual and is null when unavailable",
        "tangent_leakage_definition": "abs(m0 dot delta_m) over reconstructed real and imaginary mode vectors",
        "constants": {
            "gamma_rad_s_T": gamma0_rad_s_per_a_m / crate::MU0,
            "gamma0_rad_s_per_A_m": gamma0_rad_s_per_a_m,
            "mu0_T_m_per_A": crate::MU0,
        },
    });
    let transport_diagnostics = fem_eigen::modal_tangent_transport_diagnostics(plan);
    if let (Some(object), Some(transport)) = (
        diagnostics.as_object_mut(),
        transport_diagnostics.as_object(),
    ) {
        for (key, value) in transport {
            object.insert(key.clone(), value.clone());
        }
    }
    if let Some(object) = diagnostics.as_object_mut() {
        if let Ok(modal_source_mesh_topology) = plan.mesh.mixed_topology_fingerprint_v3() {
            object.insert(
                "source_mesh_topology_sha256".to_string(),
                serde_json::json!(modal_source_mesh_topology),
            );
        }
        if !production_modal_solver {
            if let Some(reason) = native_cpu_modal_window_rejection_reason {
                object.insert(
                    "production_cpu_rejection_reason".to_string(),
                    serde_json::json!(reason),
                );
                object.insert(
                    "production_cpu_rejection_scope".to_string(),
                    serde_json::json!(fem_eigen::native_cpu_modal_window_rejection_scope(reason)),
                );
                fem_eigen::insert_native_cpu_modal_window_rejection_contract(object, reason);
            }
        }
        let floquet_pair_count = eigen_path_floquet_periodic_pair_count(plan);
        if floquet_pair_count > 0
            && matches!(
                plan.spin_wave_bc.kind(),
                fullmag_ir::SpinWaveBoundaryKindIR::Floquet
            )
            && !plan.operator.include_demag
        {
            object.insert(
                "modal_periodic_pair_contract_available".to_string(),
                serde_json::json!(true),
            );
            object.insert(
                "floquet_periodic_pair_count".to_string(),
                serde_json::json!(floquet_pair_count),
            );
            if let Some(certificate) = eigen_path_floquet_periodic_mesh_certificate(plan) {
                object.insert("periodic_mesh_certificate".to_string(), certificate);
            }
            object.insert(
                "operator_diagnostics".to_string(),
                serde_json::json!({
                    "schema_version": "frequency_domain_operator_diagnostics.v1",
                    "payload_kind": "bloch_floquet_tangent_operator",
                }),
            );
        }
        if production_periodic_airbox_k0 {
            object.insert(
                "demag_kind".to_string(),
                serde_json::json!("periodic_airbox_k0"),
            );
            object.insert(
                "production_periodic_airbox_claim".to_string(),
                serde_json::json!(true),
            );
        }
    }
    if let (Some(object), Some(metrics)) = (
        diagnostics.as_object_mut(),
        result.k0_kittel_periodic_airbox_demag.as_ref(),
    ) {
        let gauge_policy = if metrics.augmented_phi_dof_count > metrics.phi_dof_count {
            "mean_zero_augmented"
        } else {
            "none"
        };
        object.insert("gauge_policy".to_string(), serde_json::json!(gauge_policy));
        object.insert(
            "phi_dof_count".to_string(),
            serde_json::json!(metrics.phi_dof_count),
        );
        object.insert(
            "augmented_phi_dof_count".to_string(),
            serde_json::json!(metrics.augmented_phi_dof_count),
        );
        object.insert(
            "poisson_constraint_relative_residual".to_string(),
            serde_json::json!(metrics.poisson_constraint_relative_residual),
        );
        object.insert(
            "relative_reference_frequency_error".to_string(),
            serde_json::json!(metrics.relative_kittel_frequency_error),
        );
        object.insert(
            "magnetic_pair_count".to_string(),
            serde_json::json!(metrics.magnetic_pair_count),
        );
        object.insert(
            "airbox_pair_count".to_string(),
            serde_json::json!(metrics.airbox_pair_count),
        );
    }
    let sample_solver_diagnostics = result
        .samples
        .iter()
        .filter_map(|sample| {
            sample
                .solver_diagnostics
                .as_ref()
                .map(|sample_diagnostics| {
                    serde_json::json!({
                        "sample_index": sample.sample.sample_index,
                        "label": sample.sample.label,
                        "k_vector": sample.sample.k_vector,
                        "diagnostics": sample_diagnostics,
                    })
                })
        })
        .collect::<Vec<_>>();
    let exact_sample_diagnostics_available = !sample_solver_diagnostics.is_empty();
    if exact_sample_diagnostics_available {
        let converged_eigenpair_count_total = sample_solver_diagnostics
            .iter()
            .filter_map(|sample| sample.get("diagnostics"))
            .map(|sample| eigen_path_solver_counter(sample, "converged_eigenpair_count"))
            .sum::<u64>();
        let accepted_mode_count_total = sample_solver_diagnostics
            .iter()
            .filter_map(|sample| sample.get("diagnostics"))
            .map(|sample| eigen_path_solver_counter(sample, "accepted_mode_count"))
            .sum::<u64>();
        if let Some(object) = diagnostics.as_object_mut() {
            object.insert(
                "sample_solver_diagnostics".to_string(),
                serde_json::json!(sample_solver_diagnostics),
            );
            object.insert(
                "converged_eigenpair_count_total".to_string(),
                serde_json::json!(converged_eigenpair_count_total),
            );
            object.insert(
                "accepted_mode_count_total".to_string(),
                serde_json::json!(accepted_mode_count_total),
            );
        }
    }
    if let fullmag_ir::EigenTargetIR::FrequencyWindow {
        frequency_min_hz,
        frequency_max_hz,
    } = plan.target
    {
        let window_width = frequency_max_hz - frequency_min_hz;
        let relative_width = if frequency_min_hz > 0.0 {
            window_width / frequency_min_hz
        } else {
            0.0
        };
        let subwindow_count = (relative_width / 0.35).ceil().max(1.0).min(16.0) as usize;
        let guard_fraction = 0.25;
        let mut resolved_min_hz = frequency_min_hz;
        let mut resolved_max_hz = frequency_max_hz;
        let subwindows = if exact_sample_diagnostics_available {
            Vec::new()
        } else {
            (0..subwindow_count)
                .map(|index| {
                    let sub_min =
                        frequency_min_hz + index as f64 * window_width / subwindow_count as f64;
                    let sub_max = frequency_min_hz
                        + (index + 1) as f64 * window_width / subwindow_count as f64;
                    let sub_width = sub_max - sub_min;
                    let search_min = (sub_min - guard_fraction * sub_width).max(0.0);
                    let search_max = sub_max + guard_fraction * sub_width;
                    let shift_frequency_hz = 0.5 * (sub_min + sub_max);
                    resolved_min_hz = resolved_min_hz.min(search_min);
                    resolved_max_hz = resolved_max_hz.max(search_max);
                    serde_json::json!({
                        "index": index,
                        "requested_hz": [sub_min, sub_max],
                        "search_hz": [search_min, search_max],
                        "shift_hz": shift_frequency_hz,
                        "shift_frequency_hz": shift_frequency_hz,
                        "shift_omega_rad_s": std::f64::consts::TAU * shift_frequency_hz,
                        "outer_iterations": 0,
                        "linear_iterations_total": 0,
                        "candidate_modes": public_mode_count,
                        "accepted_modes": public_mode_count,
                        "residual_max": 0.0,
                        "stop_reason": "window_exhausted",
                        "provenance": "planned_reference_window_not_executed",
                    })
                })
                .collect::<Vec<_>>()
        };
        if let Some(object) = diagnostics.as_object_mut() {
            object.insert(
                "requested_window_hz".to_string(),
                serde_json::json!([frequency_min_hz, frequency_max_hz]),
            );
            object.insert(
                "resolved_search_window_hz".to_string(),
                serde_json::json!([resolved_min_hz, resolved_max_hz]),
            );
            object.insert(
                "window_completeness".to_string(),
                serde_json::json!({
                    "policy": "best_effort",
                    "status": "not_certified",
                    "certification_method": "none",
                    "estimated_modes_in_window": public_mode_count,
                    "certified_modes_in_window": 0,
                    "additional_modes_may_exist": true,
                }),
            );
            if !subwindows.is_empty() {
                object.insert("subwindows".to_string(), serde_json::json!(subwindows));
            }
            if !production_shift_invert {
                object.insert(
                    "frequency_window_solver_policy".to_string(),
                    serde_json::json!("reference_k_path_window_filter_not_shift_invert_or_feast"),
                );
            }
        }
    }
    diagnostics
}

pub(super) fn eigen_path_solver_counter(diagnostics: &serde_json::Value, key: &str) -> u64 {
    diagnostics
        .get(key)
        .or_else(|| diagnostics.get("slepc").and_then(|slepc| slepc.get(key)))
        .and_then(|value| value.as_u64())
        .unwrap_or(0)
}

pub(super) fn eigen_path_equilibrium_source_json(
    plan: &FemEigenPlanIR,
    _relaxation_steps: u64,
) -> serde_json::Value {
    match &plan.equilibrium {
        fullmag_ir::EquilibriumSourceIR::RelaxedInitialState => {
            serde_json::json!({ "kind": "relaxed_initial_state" })
        }
        fullmag_ir::EquilibriumSourceIR::Provided => serde_json::json!("provided"),
        fullmag_ir::EquilibriumSourceIR::Artifact { path } => {
            serde_json::json!({ "kind": "artifact", "path": path })
        }
    }
}

fn finite_or_default(value: Option<f64>, default: f64) -> f64 {
    value.filter(|value| value.is_finite()).unwrap_or(default)
}

/// Retain only possible publication candidates while traversing k. Tracking
/// still consumes every magnetic vector from the current single-k result.
/// Branch selectors need all raw candidates until assignment; explicit raw
/// selectors and sample selectors can bound retained heavy potential fields.
pub(super) fn eigen_path_candidate_mode_indices(
    outputs: &[OutputIR],
    sample: &crate::eigen::KSampleDescriptor,
    available_mode_indices: &BTreeSet<u32>,
) -> BTreeSet<u32> {
    let mut result = BTreeSet::new();
    for output in outputs {
        let OutputIR::EigenMode {
            all_modes,
            indices,
            branches,
            sample_selector,
            ..
        } = output
        else {
            continue;
        };
        let selected_sample = sample_selector.as_ref().map_or(true, |selector| {
            (selector.sample_indices.is_empty() && selector.sample_labels.is_empty())
                || selector
                    .sample_indices
                    .iter()
                    .any(|index| *index as usize == sample.sample_index)
                || sample.label.as_ref().is_some_and(|label| {
                    selector
                        .sample_labels
                        .iter()
                        .any(|selected| selected.trim() == label.trim())
                })
        });
        if !selected_sample {
            continue;
        }
        if *all_modes || !branches.is_empty() {
            result.extend(available_mode_indices.iter().copied());
        } else {
            result.extend(indices.iter().copied().filter(|index| available_mode_indices.contains(index)));
        }
    }
    result
}

pub(super) fn remap_single_k_mode_artifacts(
    artifacts: &[crate::types::AuxiliaryArtifact],
    sample_index: usize,
    published_mode_indices: &BTreeSet<u32>,
) -> Result<Vec<crate::types::AuxiliaryArtifact>, RunError> {
    let mut remapped = Vec::new();
    for artifact in artifacts {
        if is_sample_scoped_producer_provenance_candidate(&artifact.relative_path)
            && sample_scoped_producer_provenance_artifact_index(&artifact.relative_path).is_none()
        {
            return Err(RunError {
                message: format!(
                    "eigen_path_producer_provenance_sample_path_noncanonical: {}",
                    artifact.relative_path
                ),
            });
        }
        if is_sample_scoped_signed_state_candidate(&artifact.relative_path)
            && sample_scoped_signed_state_artifact_index(&artifact.relative_path).is_none()
        {
            return Err(RunError {
                message: format!(
                    "eigen_path_signed_state_sample_path_noncanonical: {}",
                    artifact.relative_path
                ),
            });
        }
        if is_sample_scoped_nonshared_provenance_candidate(&artifact.relative_path)
            && sample_scoped_nonshared_provenance_artifact_index(&artifact.relative_path).is_none()
        {
            return Err(RunError {
                message: format!(
                    "eigen_path_nonshared_provenance_sample_path_noncanonical: {}",
                    artifact.relative_path
                ),
            });
        }
        if let Some(source_sample_index) = sample_scoped_signed_state_artifact_index(
            &artifact.relative_path,
        ) {
            if source_sample_index != sample_index {
                return Err(RunError {
                    message: format!(
                        "eigen_path_signed_state_sample_index_mismatch: source={}, target={}",
                        source_sample_index, sample_index
                    ),
                });
            }
        }
        if let Some(source_sample_index) =
            sample_scoped_nonshared_provenance_artifact_index(&artifact.relative_path)
        {
            if source_sample_index != sample_index {
                return Err(RunError {
                    message: format!(
                        "eigen_path_nonshared_provenance_sample_index_mismatch: source={}, target={}",
                        source_sample_index, sample_index
                    ),
                });
            }
        }
        if let Some(source_sample_index) =
            sample_scoped_producer_provenance_artifact_index(&artifact.relative_path)
        {
            if source_sample_index != sample_index {
                return Err(RunError {
                    message: format!(
                        "eigen_path_producer_provenance_sample_index_mismatch: source={}, target={}",
                        source_sample_index, sample_index
                    ),
                });
            }
        }
        let Some(relative_path) = remap_single_k_mode_artifact_path(
            &artifact.relative_path,
            sample_index,
            published_mode_indices,
        ) else {
            continue;
        };
        // Signed state sidecars are relocated without altering their payload:
        // a source name or preimage may legitimately contain "sample_0000".
        let bytes = if is_signed_state_artifact_path(&artifact.relative_path) {
            artifact.bytes.clone()
        } else if single_k_mode_artifact_is_json(&relative_path) {
            remap_single_k_mode_json_bytes(&artifact.bytes, sample_index)?
        } else {
            artifact.bytes.clone()
        };
        remapped.push(crate::types::AuxiliaryArtifact {
            relative_path,
            bytes,
        });
    }
    Ok(remapped)
}

fn sample_scoped_signed_state_artifact_index(relative_path: &str) -> Option<usize> {
    let rest = relative_path.strip_prefix("eigen/metadata/")?;
    let (_sample, filename) = rest.split_once('/')?;
    if !single_k_signed_state_artifact(&format!("eigen/metadata/{filename}")) {
        return None;
    }
    crate::fem::eigen_output::canonical_sample_scoped_index(
        relative_path,
        filename,
    )
}

fn is_sample_scoped_signed_state_candidate(relative_path: &str) -> bool {
    let Some(rest) = relative_path.strip_prefix("eigen/metadata/") else {
        return false;
    };
    let Some((sample, filename)) = rest.split_once('/') else {
        return false;
    };
    sample.starts_with("sample_")
        && single_k_signed_state_artifact(&format!("eigen/metadata/{filename}"))
}

fn sample_scoped_nonshared_provenance_artifact_index(relative_path: &str) -> Option<usize> {
    let rest = relative_path.strip_prefix("eigen/metadata/sample_")?;
    let (sample, suffix) = rest.split_once('/')?;
    if suffix.contains('\\') {
        return None;
    }
    let mut components = suffix.split('/');
    if components.next() != Some("nonshared_source") {
        return None;
    }
    let payload_components = components.collect::<Vec<_>>();
    if payload_components.is_empty()
        || payload_components.iter().any(|component| {
        component.is_empty() || *component == "." || *component == ".."
    })
    {
        return None;
    }
    let sample_index = sample.parse::<usize>().ok()?;
    (sample == format!("{sample_index:04}")).then_some(sample_index)
}

fn is_sample_scoped_nonshared_provenance_candidate(relative_path: &str) -> bool {
    let Some(rest) = relative_path.strip_prefix("eigen/metadata/sample_") else {
        return false;
    };
    let Some((_sample, suffix)) = rest.split_once('/') else {
        return false;
    };
    suffix == "nonshared_source"
        || suffix.starts_with("nonshared_source/")
        || suffix.starts_with("nonshared_source\\")
}

fn sample_scoped_producer_provenance_artifact_index(relative_path: &str) -> Option<usize> {
    crate::fem::eigen_output::canonical_sample_scoped_index(
        relative_path,
        "producer_provenance.v1.json",
    )
}

fn is_sample_scoped_producer_provenance_candidate(relative_path: &str) -> bool {
    relative_path.starts_with("eigen/metadata/sample_")
        && relative_path.ends_with("/producer_provenance.v1.json")
}

fn is_root_producer_provenance_artifact(relative_path: &str) -> bool {
    relative_path == "equilibrium/producer_provenance.v1.json"
        || relative_path == "eigen/metadata/producer_provenance.v1.json"
}

fn is_signed_state_artifact_path(relative_path: &str) -> bool {
    is_root_producer_provenance_artifact(relative_path)
        || is_sample_scoped_producer_provenance_candidate(relative_path)
        || single_k_signed_state_artifact(relative_path)
        || sample_scoped_signed_state_artifact_index(relative_path).is_some()
        || sample_scoped_nonshared_provenance_artifact_index(relative_path).is_some()
}

fn eigen_path_signed_state_artifact(relative_path: &str) -> bool {
    is_root_producer_provenance_artifact(relative_path)
        || is_sample_scoped_producer_provenance_candidate(relative_path)
        || is_sample_scoped_signed_state_candidate(relative_path)
        || is_sample_scoped_nonshared_provenance_candidate(relative_path)
}

fn single_k_signed_state_artifact(relative_path: &str) -> bool {
    matches!(relative_path,
        "eigen/metadata/equilibrium_artifact.v7.json"
        | "eigen/metadata/linearization_state.v6.json"
        | "eigen/metadata/equilibrium_artifact.v8.json"
        | "eigen/metadata/linearization_state.v7.json"
        | "eigen/metadata/linearization_identity.v2.json"
        | "eigen/metadata/linearization_identity_preimage.v1.json"
        | "eigen/metadata/consumer_plan_snapshot.v1.json"
        | "eigen/metadata/nonshared_floquet_operator_identity.v1.json"
        | "eigen/metadata/nonshared_floquet_operator_identity_preimage.v1.json"
        | "eigen/metadata/nonshared_floquet_source_state.v1.json"
        | "eigen/metadata/accepted_fem_equilibrium_fields.v1.json"
        | "eigen/metadata/accepted_fem_equilibrium_fields.v2.json"
        | "equilibrium/accepted_fem_equilibrium_fields.v1.json"
        | "equilibrium/accepted_fem_equilibrium_fields.v2.json"
        | "equilibrium/certified_fem_equilibrium_fields.v1.json"
        | "equilibrium/certified_fem_equilibrium_fields.v2.json"
        | "equilibrium/recomputed_fem_linearization_certificate.v1.json"
        | "equilibrium/recomputed_fem_linearization_certificate.v2.json"
        | "eigen/metadata/certified_fem_equilibrium_fields.v1.json"
        | "eigen/metadata/certified_fem_equilibrium_fields.v2.json"
        | "eigen/metadata/recomputed_fem_linearization_certificate.v1.json"
        | "eigen/metadata/recomputed_fem_linearization_certificate.v2.json")
}

pub(super) fn remap_single_k_mode_artifact_path(
    relative_path: &str,
    sample_index: usize,
    published_mode_indices: &BTreeSet<u32>,
) -> Option<String> {
    let sample_path = format!("sample_{sample_index:04}");
    if is_root_producer_provenance_artifact(relative_path) {
        return Some(relative_path.to_string());
    }
    if let Some(source_sample_index) =
        sample_scoped_producer_provenance_artifact_index(relative_path)
    {
        return (source_sample_index == sample_index).then(|| relative_path.to_string());
    }
    if let Some(source_sample_index) = sample_scoped_signed_state_artifact_index(relative_path) {
        return (source_sample_index == sample_index).then(|| relative_path.to_string());
    }
    if let Some(source_sample_index) =
        sample_scoped_nonshared_provenance_artifact_index(relative_path)
    {
        return (source_sample_index == sample_index).then(|| relative_path.to_string());
    }
    if single_k_signed_state_artifact(relative_path) {
        let filename = relative_path.rsplit('/').next()?;
        return Some(format!("eigen/metadata/{sample_path}/{filename}"));
    }
    if published_mode_indices.is_empty() {
        return None;
    }
    if relative_path == "eigen/mode_fields.zarr/.zgroup"
        || relative_path == "eigen/mode_fields.zarr/.zattrs"
    {
        return Some(relative_path.to_string());
    }

    for root in ["eigen/modes", "eigen/mode_fields", "eigen/mode_fields.zarr"] {
        let Some(rest) = relative_path
            .strip_prefix(root)
            .and_then(|suffix| suffix.strip_prefix('/'))
        else {
            continue;
        };
        let Some((source_sample_path, suffix)) = rest.split_once('/') else {
            continue;
        };
        let Some(source_sample_index) = source_sample_path
            .strip_prefix("sample_")
            .and_then(|index| index.parse::<usize>().ok())
        else {
            return None;
        };
        if source_sample_path != format!("sample_{source_sample_index:04}")
            || (source_sample_index != 0 && source_sample_index != sample_index)
        {
            return None;
        }

        let target_path = format!("{root}/{sample_path}/{suffix}");
        if root == "eigen/mode_fields.zarr" && matches!(suffix, ".zgroup" | ".zattrs") {
            return Some(target_path);
        }

        let raw_mode_index =
            u32::try_from(single_k_mode_artifact_raw_mode_index(relative_path)?).ok()?;
        if !published_mode_indices.contains(&raw_mode_index) {
            return None;
        }
        return Some(target_path);
    }
    None
}

pub(super) fn single_k_mode_artifact_raw_mode_index(relative_path: &str) -> Option<usize> {
    let mode_marker = "/mode_";
    let start = relative_path.rfind(mode_marker)? + mode_marker.len();
    let suffix = &relative_path[start..];
    let digits = suffix
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

pub(super) fn single_k_mode_artifact_is_json(relative_path: &str) -> bool {
    relative_path.ends_with(".json")
        || relative_path.ends_with(".zgroup")
        || relative_path.ends_with(".zattrs")
        || relative_path.ends_with(".zarray")
}

pub(super) fn remap_single_k_mode_json_bytes(
    bytes: &[u8],
    sample_index: usize,
) -> Result<Vec<u8>, RunError> {
    let mut value: serde_json::Value = serde_json::from_slice(bytes).map_err(|error| RunError {
        message: format!("failed to parse single-k mode artifact for k-path remap: {error}"),
    })?;
    remap_single_k_mode_json_value(&mut value, sample_index);
    serde_json::to_vec_pretty(&value).map_err(|error| RunError {
        message: format!("failed to serialize k-path mode artifact: {error}"),
    })
}

pub(super) fn remap_single_k_mode_json_value(value: &mut serde_json::Value, sample_index: usize) {
    match value {
        serde_json::Value::Object(object) => {
            for (key, child) in object.iter_mut() {
                if key == "sample_index" && child.as_u64() == Some(0) {
                    *child = serde_json::json!(sample_index);
                } else {
                    remap_single_k_mode_json_value(child, sample_index);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                remap_single_k_mode_json_value(item, sample_index);
            }
        }
        serde_json::Value::String(text) => {
            let sample_path = format!("sample_{sample_index:04}");
            let sample_id = format!("sample-{sample_index:04}");
            let sample_meta = format!("/eigen/mode-field/{sample_index}/");
            *text = text
                .replace("sample_0000", &sample_path)
                .replace("sample-0000", &sample_id)
                .replace("/eigen/mode-field/0/", &sample_meta);
        }
        _ => {}
    }
}

pub(super) fn deduplicate_auxiliary_artifacts_by_path(
    artifacts: &mut Vec<crate::types::AuxiliaryArtifact>,
) -> Result<(), RunError> {
    // Two source prefixes can relocate to one signed sample path.  Never
    // silently choose one equilibrium certificate when their bytes disagree.
    let mut signed_payloads = std::collections::HashMap::<&str, &[u8]>::new();
    for artifact in artifacts.iter() {
        if !eigen_path_signed_state_artifact(&artifact.relative_path) {
            continue;
        }
        if let Some(previous) = signed_payloads.insert(
            artifact.relative_path.as_str(), artifact.bytes.as_slice())
        {
            if previous != artifact.bytes.as_slice() {
                return Err(RunError {
                    message: format!(
                        "conflicting_signed_eigen_path_artifacts: {}",
                        artifact.relative_path),
                });
            }
        }
    }
    drop(signed_payloads);
    let mut seen = HashSet::new();
    artifacts.retain(|artifact| seen.insert(artifact.relative_path.clone()));
    Ok(())
}

#[cfg(test)]
mod tracking_payload_tests {
    use super::eigen_path_mode_tracking_vector;
    use crate::types::AuxiliaryArtifact;
    use num_complex::Complex64;
    use serde_json::{json, Value};

    fn artifact(mode: Value) -> AuxiliaryArtifact {
        AuxiliaryArtifact {
            relative_path: "eigen/modes/mode_0000.json".into(),
            bytes: serde_json::to_vec(&mode).unwrap(),
        }
    }

    fn mode() -> Value {
        json!({"index": 0, "source_mesh_topology_sha256": "sha256:test", "k_vector": [0.0, 2.0, 0.0],
               "real": [[0.0, 1.0, 0.3], [0.0, 1.0, 0.3]],
               "imag": [[0.0, 0.0, 0.4], [0.0, 0.0, 0.4]]})
    }

    #[test]
    fn tracking_unwinds_spatial_bloch_phase_in_selected_node_order() {
        let coords = [[0.0, 0.3, 0.0], [0.0, 0.8, 0.0]];
        let envelope = [
            Complex64::new(0.0, 0.0),
            Complex64::new(1.0, 0.0),
            Complex64::new(0.3, 0.4),
        ];
        let mut physical = mode();
        for (node, coordinate) in coords.iter().enumerate() {
            let angle: f64 = -2.0 * coordinate[1];
            let phase = Complex64::new(angle.cos(), angle.sin());
            for component in 0..3 {
                let value = envelope[component] * phase;
                physical["real"][node][component] = json!(value.re);
                physical["imag"][node][component] = json!(value.im);
            }
        }
        let vector = eigen_path_mode_tracking_vector(
            &[artifact(physical)],
            0,
            Some(&[1, 0]),
            &coords,
            [0.0, 2.0, 0.0],
            true,
            "sha256:test",
        )
        .unwrap()
        .unwrap();
        assert_eq!(vector.len(), 6);
        for (value, expected) in vector.iter().zip(envelope.iter().cycle()) {
            assert!((*value - *expected).norm() < 1e-12);
        }
    }

    #[test]
    fn tracking_preserves_gamma_cartesian_field() {
        let mut gamma = mode();
        gamma["k_vector"] = json!([0.0, 0.0, 0.0]);
        let vector = eigen_path_mode_tracking_vector(
            &[artifact(gamma)],
            0,
            None,
            &[[0.0; 3]; 2],
            [0.0; 3],
            false,
            "sha256:test",
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            vector,
            vec![
                Complex64::new(0.0, 0.0),
                Complex64::new(1.0, 0.0),
                Complex64::new(0.3, 0.4),
                Complex64::new(0.0, 0.0),
                Complex64::new(1.0, 0.0),
                Complex64::new(0.3, 0.4)
            ]
        );
    }

    #[test]
    fn tracking_rejects_malformed_xyz_without_dropping_rows_or_zero_padding() {
        for row in [
            Value::Null,
            json!([0.0, 1.0]),
            json!([0.0, 1.0, 0.3, 9.0]),
            json!([0.0, "not-a-number", 0.3]),
        ] {
            for field in ["real", "imag"] {
                let mut malformed = mode();
                malformed[field][0] = row.clone();
                assert!(eigen_path_mode_tracking_vector(
                    &[artifact(malformed)],
                    0,
                    None,
                    &[[0.0; 3]; 2],
                    [0.0, 2.0, 0.0],
                    true,
                    "sha256:test",
                )
                .is_err());
            }
        }
    }

    #[test]
    fn tracking_rejects_partial_complex_or_wrong_mesh_length_payload() {
        for field in ["real", "imag"] {
            for replacement in [json!([]), json!([[0.0, 0.0, 0.0]]), Value::Null] {
                let mut malformed = mode();
                malformed[field] = replacement;
                assert!(eigen_path_mode_tracking_vector(
                    &[artifact(malformed)],
                    0,
                    None,
                    &[[0.0; 3]; 2],
                    [0.0, 2.0, 0.0],
                    true,
                    "sha256:test",
                )
                .is_err());
            }
            let mut missing = mode();
            missing.as_object_mut().unwrap().remove(field);
            assert!(eigen_path_mode_tracking_vector(
                &[artifact(missing)],
                0,
                None,
                &[[0.0; 3]; 2],
                [0.0, 2.0, 0.0],
                true,
                "sha256:test",
            )
            .is_err());
        }
    }

    #[test]
    fn tracking_rejects_stale_mode_identity_or_wavevector() {
        for (field, value) in [
            ("index", json!(1)),
            ("index", json!(-1)),
            ("k_vector", json!([0.0, 3.0, 0.0])),
            ("k_vector", json!([0.0, 2.0])),
        ] {
            let mut wrong = mode();
            wrong[field] = value;
            assert!(eigen_path_mode_tracking_vector(
                &[artifact(wrong)],
                0,
                None,
                &[[0.0; 3]; 2],
                [0.0, 2.0, 0.0],
                true,
                "sha256:test",
            )
            .is_err());
        }
    }

    #[test]
    fn tracking_rejects_duplicate_empty_or_invalid_active_nodes() {
        for selected in [vec![0, 0], vec![0, 2], vec![]] {
            assert!(eigen_path_mode_tracking_vector(
                &[artifact(mode())],
                0,
                Some(&selected),
                &[[0.0; 3]; 2],
                [0.0, 2.0, 0.0],
                true,
                "sha256:test",
            )
            .is_err());
        }
    }

    #[test]
    fn tracking_rejects_nonfinite_coordinates_or_phase() {
        let cases = [
            ([[0.0, f64::NAN, 0.0]; 2], [0.0, 2.0, 0.0]),
            ([[0.0; 3]; 2], [0.0, f64::INFINITY, 0.0]),
            ([[0.0, 1e308, 0.0]; 2], [0.0, 1e308, 0.0]),
        ];
        for (coords, k) in cases {
            let mut matching = mode();
            matching["k_vector"] = json!(k);
            assert!(eigen_path_mode_tracking_vector(
                &[artifact(matching)],
                0,
                None,
                &coords,
                k,
                true,
                "sha256:test",
            )
            .is_err());
        }
    }

    #[test]
    fn only_absent_fields_can_leave_modal_tracking_unavailable() {
        let coords = [[0.0; 3]; 2];
        let k = [0.0, 2.0, 0.0];
        assert!(
            eigen_path_mode_tracking_vector(&[], 0, None, &coords, k, true, "sha256:test",)
                .unwrap()
                .is_none()
        );
        assert!(eigen_path_mode_tracking_vector(
            &[artifact(json!({"index": 0}))],
            0,
            None,
            &coords,
            k,
            true,
            "sha256:test",
        )
        .unwrap()
        .is_none());
        let good = artifact(mode());
        assert!(eigen_path_mode_tracking_vector(
            &[good.clone(), good],
            0,
            None,
            &coords,
            k,
            true,
            "sha256:test",
        )
        .is_err());
        let malformed = AuxiliaryArtifact {
            relative_path: "eigen/modes/mode_0000.json".into(),
            bytes: b"{invalid".to_vec(),
        };
        assert!(eigen_path_mode_tracking_vector(
            &[malformed],
            0,
            None,
            &coords,
            k,
            true,
            "sha256:test",
        )
        .is_err());
    }
}
