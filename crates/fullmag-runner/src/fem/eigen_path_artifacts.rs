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
            assert_eq!(manifest["requested_execution"]["outputs"], serde_json::json!([]));
            assert!(manifest["artifacts"]["eigen_diagnostics_v2_path"].is_null());
            assert!(manifest["resources"]["eigen_diagnostics_resource_key"].is_null());
            let diagnostic_manifest = build_eigen_path_frequency_domain_manifest(
                FemEngine::CpuNative, &result, &artifacts,
                &residual_transport_test_plan(),
                &[OutputIR::EigenDiagnostics {
                    include_tracking: true,
                    include_residuals: true,
                    include_overlaps: true,
                    include_tangent_leakage: true,
                    include_orthogonality: true,
                }],
            );
            assert_eq!(diagnostic_manifest["requested_execution"]["outputs"],
                       serde_json::json!(["diagnostics"]));
            assert_eq!(
                diagnostic_manifest["artifacts"]["eigen_diagnostics_v2_path"],
                "eigen/diagnostics.v2.json"
            );
            assert_eq!(
                diagnostic_manifest["resources"]["eigen_diagnostics_resource_key"],
                "/v2/sessions/current/analysis/frequency-domain/eigen/diagnostics.v2"
            );
            assert!(diagnostic_manifest["artifacts"]["spectrum_v2_path"].is_null());
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
    fn actual_path_manifest_distinguishes_numeric_solve_from_comparison() {
        let mut result = crate::eigen::PathSolveResult {
            gamma0_rad_s_per_a_m: 2.211e5,
            samples: [0, 2, 7]
                .into_iter()
                .map(|sample_index| crate::eigen::SingleKSolveResult {
                    sample: KSampleDescriptor {
                        sample_index,
                        label: None,
                        segment_index: None,
                        path_s: sample_index as f64,
                        t_in_segment: 0.0,
                        k_vector: [sample_index as f64, 0.0, 0.0],
                    },
                    modes: Vec::new(),
                    relaxation_steps: 0,
                    solver_model: crate::eigen::EigenSolverModel::ReferenceScalarTangent,
                    solver_notes: Vec::new(),
                    solver_diagnostics: None,
                })
                .collect(),
            branches: Vec::new(),
            solver_model: crate::eigen::EigenSolverModel::ReferenceScalarTangent,
            notes: Vec::new(),
            include_demag: true,
            dispersion_validation: None,
            k0_kittel_validation: None,
            solver_policy: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };
        let outputs = [OutputIR::DispersionCurve {
            name: "bands".into(),
            include_branch_table: false,
        }];
        let plan = residual_transport_test_plan();
        let build = |result: &crate::eigen::PathSolveResult| {
            build_eigen_path_frequency_domain_manifest(
                FemEngine::CpuNative,
                result,
                &[],
                &plan,
                &outputs,
            )
        };

        let reference_manifest = build(&result);
        assert!(reference_manifest["validation"]["dispersion_frequency_source"].is_null());
        assert!(reference_manifest["validation"]["dispersion_reference_model"].is_null());

        result.solver_model = crate::eigen::EigenSolverModel::ProductionCpuShiftInvert;
        for sample in &mut result.samples {
            sample.solver_model = result.solver_model;
        }
        let native_manifest = build(&result);
        assert_eq!(
            native_manifest["validation"]["dispersion_frequency_source"],
            "numeric_modal_solver"
        );
        assert!(native_manifest["validation"]["dispersion_reference_model"].is_null());

        result.dispersion_validation = Some(fullmag_ir::FemEigenDispersionValidationIR {
            kind: "thin_film_de_bv_low_k".into(),
            analytic_model: "kalinikos_slab_n0".into(),
            film_thickness_m: 20e-9,
            equilibrium_magnetization: [1.0, 0.0, 0.0],
            film_normal: [0.0, 0.0, 1.0],
            frequency_window_hz: fullmag_ir::FemEigenDispersionValidationWindowIR {
                min: 0.0,
                max: 5.0e9,
            },
            max_k_rad_per_m: 3.0e6,
            max_relative_error: 0.1,
            scenarios: Vec::new(),
        });
        let comparison_manifest = build(&result);
        assert_eq!(
            comparison_manifest["validation"]["dispersion_frequency_source"],
            "numeric_modal_solver_with_analytic_comparison"
        );
        assert_eq!(
            comparison_manifest["validation"]["dispersion_reference_model"],
            "kalinikos_slab_n0"
        );
    }

    #[test]
    fn path_manifest_records_mixed_homogeneous_partial_and_missing_execution_provenance() {
        let plan = residual_transport_test_plan();
        let model = crate::eigen::EigenSolverModel::ProductionCpuShiftInvert;
        let reference_model = crate::eigen::EigenSolverModel::ReferenceScalarTangent;
        let diagnostic = |engine: &str, algorithm: &str, phasor: &str, signature: &str| {
            let floquet = engine.contains("floquet");
            serde_json::json!({
                "solver_adapter": algorithm,
                "basis_transport_policy": if floquet { "tangent_frame_transport" } else { "tangent_frame_identity" },
                "floquet_tangent_frame_max_mismatch": if floquet { 0.125 } else { 0.0 },
                "floquet_tangent_transport_max_nonunitarity": if floquet { 0.25 } else { 0.0 },
                "demag_kind": if floquet { "floquet_airbox" } else { "periodic_airbox_k0" },
                "solver_family": if floquet { "floquet_modal_solver" } else { "k0_modal_solver" },
                "resolved_solver_family": algorithm,
                "spectral_transform": "shift_invert",
                "production_solver_available": floquet,
                "production_cpu_rejection_reason": null,
                "production_cpu_rejection_scope": null,
                "execution_lane": if floquet { "production_cpu" } else { "reference_cpu" },
                "requested_execution": {
                    "solver_method": "targeted_spectrum",
                    "preconditioner": "jacobi",
                    "magnetostatic_bc": "floquet_airbox",
                },
                "resolved_execution": {
                    "device": "cpu",
                    "precision": "double",
                    "engine": engine,
                    "native_backend": "native_cpu",
                    "reference_or_production": if floquet { "production" } else { "reference" },
                    "demag_realization": "floquet_airbox",
                    "solver_library": "slepc",
                    "solver_algorithm": algorithm,
                    "implementation_id": algorithm,
                    "status": "ready",
                    "device_residency": "host",
                    "operator_residency": "host",
                    "vector_residency": "host",
                    "krylov_residency": "host",
                    "preconditioner_residency": "host",
                    "fallback_used": false,
                    "fallback_reason": null,
                    "fallback_from_engine": null,
                    "fallback_to_engine": null,
                },
                "phasor_convention": phasor,
                "phase_convention": "ExpMinusIKDotDeltaR",
                "physics_contract_version": "fixture-v1",
                "operator_dictionary_version": "fixture-v1",
                "implementation_state": "source_visible",
                "validation_state": "unvalidated",
                "validated_scope": "must-not-be-promoted",
                "assembly_kind": "mfem_weak_form_shared_domain",
                "operator_input_signature_sha256": signature,
                "boundary_gauge": {"gauge_policy": "none", "magnetostatic_bc": "floquet_airbox"},
                "spectral": {"spectral_transform": "shift_invert", "target_representation": "fixture"},
                "phase_constraint_sha256": format!("phase-{signature}"),
                "equilibrium_artifact_sha256": format!("equilibrium-{signature}"),
                "linearization_state_sha256": format!("linearization-{signature}"),
                "periodic_mesh_certificate_sha256": "mesh-certificate-common",
                "large_native_debug_blob": {"payload": "must-not-be-copied"},
            })
        };
        let sample = |sample_index: usize,
                      k_vector: [f64; 3],
                      solver_model: crate::eigen::EigenSolverModel,
                      solver_diagnostics: Option<serde_json::Value>| {
            crate::eigen::SingleKSolveResult {
                sample: KSampleDescriptor {
                    sample_index,
                    label: Some(format!("sample-{sample_index}")),
                    segment_index: Some(0),
                    path_s: sample_index as f64,
                    t_in_segment: 0.0,
                    k_vector,
                },
                modes: Vec::new(),
                relaxation_steps: 0,
                solver_model,
                solver_notes: Vec::new(),
                solver_diagnostics,
            }
        };
        let path_result = |samples: Vec<crate::eigen::SingleKSolveResult>,
                           solver_model: crate::eigen::EigenSolverModel| {
            crate::eigen::PathSolveResult {
                gamma0_rad_s_per_a_m: 2.211e5,
                samples,
                branches: Vec::new(),
                solver_model,
                notes: Vec::new(),
                include_demag: true,
                dispersion_validation: None,
                k0_kittel_validation: None,
                solver_policy: None,
                dispersion_analytic_reference: None,
                k0_kittel_periodic_airbox_demag: None,
            }
        };
        let manifest = |result: &crate::eigen::PathSolveResult| {
            build_eigen_path_frequency_domain_manifest(
                FemEngine::CpuNative,
                result,
                &[],
                &plan,
                &[],
            )
        };

        let mixed_result = path_result(
            vec![
                sample(
                    7,
                    [0.0, 0.0, 0.0],
                    model,
                    Some(diagnostic(
                        "k0_poisson_adapter",
                        "k0_poisson_solver",
                        "exp_plus_i_omega_t",
                        "signature-k0",
                    )),
                ),
                sample(
                    0,
                    [1.0e6, 0.0, 0.0],
                    model,
                    Some(diagnostic(
                        "floquet_modal_adapter",
                        "floquet_solver",
                        "exp_i_omega_t",
                        "signature-k1",
                    )),
                ),
                sample(
                    5,
                    [2.0e6, 0.0, 0.0],
                    model,
                    Some(diagnostic(
                        "floquet_modal_adapter",
                        "floquet_solver",
                        "exp_i_omega_t",
                        "signature-k2",
                    )),
                ),
            ],
            model,
        );
        let mixed = manifest(&mixed_result);
        let serialized = serde_json::to_vec_pretty(&mixed).unwrap();
        let mixed: serde_json::Value = serde_json::from_slice(&serialized).unwrap();
        let mixed_transport =
            crate::fem::eigen_diagnostics_transport_metadata(&mixed_result, None);
        assert_eq!(mixed_transport["solver_model_scope"], "path_orchestrator");
        assert!(mixed_transport["basis_transport_policy"].is_null());
        assert!(mixed_transport["floquet_tangent_frame_max_mismatch"].is_null());
        assert!(mixed_transport["solver_family"].is_null());
        assert!(mixed_transport["production_solver_available"].is_null());
        assert_eq!(
            mixed_transport["sample_execution_provenance"]["samples"][0]["basis_transport_policy"],
            "tangent_frame_identity"
        );
        assert_eq!(
            mixed_transport["sample_execution_provenance"]["samples"][0]["production_solver_available"],
            false,
            "an explicit false remains false in a per-sample record"
        );
        let mut geometry_diagnostics = diagnostic(
            "single_path_adapter",
            "same_solver",
            "exp_i_omega_t",
            "geometry-derived",
        );
        for key in [
            "basis_transport_policy",
            "floquet_tangent_frame_max_mismatch",
            "floquet_tangent_transport_max_nonunitarity",
        ] {
            geometry_diagnostics
                .as_object_mut()
                .unwrap()
                .remove(key);
        }
        let mut geometry_result = path_result(
            vec![sample(
                9,
                [0.0, 0.0, 0.0],
                model,
                Some(geometry_diagnostics),
            )],
            model,
        );
        let geometry_transport = crate::fem::eigen_diagnostics_transport_metadata(
            &geometry_result,
            Some(&plan),
        );
        assert_eq!(geometry_transport["basis_transport_policy"], "not_applicable");
        assert_eq!(geometry_transport["floquet_tangent_frame_max_mismatch"], 0.0);
        assert_eq!(
            geometry_transport["sample_execution_provenance"]["samples"][0]
                ["floquet_tangent_transport_max_nonunitarity"],
            0.0
        );
        assert!(geometry_result.samples[0].solver_diagnostics.as_ref().unwrap()
            .get("basis_transport_policy")
            .is_none(), "projection must not mutate raw sample diagnostics");
        assert_eq!(
            mixed["sample_execution_provenance"]["status"],
            "mixed"
        );
        assert_eq!(
            mixed["sample_execution_provenance"]["diagnostics_available_count"],
            3
        );
        assert_eq!(
            mixed["sample_execution_provenance"]["samples"]
                .as_array()
                .unwrap()
                .iter()
                .map(|sample| sample["sample_index"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![7, 0, 5],
            "provenance records follow solved-sample order, not sorted sample IDs"
        );
        assert_eq!(
            mixed["sample_execution_provenance"]["samples"][0]["resolved_execution"]["engine"],
            "k0_poisson_adapter"
        );
        assert_eq!(
            mixed["sample_execution_provenance"]["samples"][1]["resolved_execution"]["engine"],
            "floquet_modal_adapter"
        );
        assert!(mixed["resolved_execution"]["engine"].is_null());
        assert!(mixed["resolved_execution"]["solver_algorithm"].is_null());
        assert!(mixed["physics"]["phase_convention"].is_null());
        assert!(mixed["operator_input_signature_sha256"].is_null());
        assert_eq!(mixed["validation_state"], "unvalidated");
        assert!(mixed["validated_scope"].is_null());
        assert!(!String::from_utf8(serialized)
            .unwrap()
            .contains("large_native_debug_blob"));

        let reversed_result = path_result(
            vec![
                sample(
                    5,
                    [2.0e6, 0.0, 0.0],
                    model,
                    Some(diagnostic(
                        "floquet_modal_adapter",
                        "floquet_solver",
                        "exp_i_omega_t",
                        "signature-k2",
                    )),
                ),
                sample(
                    0,
                    [1.0e6, 0.0, 0.0],
                    model,
                    Some(diagnostic(
                        "floquet_modal_adapter",
                        "floquet_solver",
                        "exp_i_omega_t",
                        "signature-k1",
                    )),
                ),
                sample(
                    7,
                    [0.0, 0.0, 0.0],
                    model,
                    Some(diagnostic(
                        "k0_poisson_adapter",
                        "k0_poisson_solver",
                        "exp_plus_i_omega_t",
                        "signature-k0",
                    )),
                ),
            ],
            model,
        );
        let reversed = manifest(&reversed_result);
        assert_eq!(
            reversed["sample_execution_provenance"]["samples"]
                .as_array()
                .unwrap()
                .iter()
                .map(|sample| sample["sample_index"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![5, 0, 7]
        );
        assert!(reversed["resolved_execution"]["engine"].is_null());
        assert!(reversed["physics"]["phase_convention"].is_null());

        let nested_diagnostics =
            diagnostic("nested_engine", "nested_algorithm", "exp_i_omega_t", "nested-signature");
        let one_sample_envelope = serde_json::json!({
            "solver_adapter": "root_first_sample_adapter",
            "resolved_execution": {
                "engine": "root_first_sample_engine",
                "solver_algorithm": "root_first_sample_algorithm",
            },
            "relax_to_eigen_handoff_sha256": "root-handoff-binding",
            "relax_to_eigen_source_mesh_topology_sha256": "root-source-binding",
            "source_mesh_topology_sha256": "root-modal-mesh-binding",
            "sample_solver_diagnostics": [{
                "sample_index": 11,
                "diagnostics": nested_diagnostics,
            }],
        });
        let envelope_result = path_result(
            vec![sample(
                11,
                [1.0e6, 0.0, 0.0],
                model,
                Some(one_sample_envelope),
            )],
            model,
        );
        let envelope_manifest = manifest(&envelope_result);
        assert_eq!(
            envelope_manifest["resolved_execution"]["engine"],
            "nested_engine"
        );
        assert_eq!(
            envelope_manifest["resolved_execution"]["solver_algorithm"],
            "nested_algorithm"
        );
        assert_eq!(
            envelope_manifest["sample_execution_provenance"]["samples"][0]["solver_adapter"],
            "nested_algorithm"
        );
        assert_eq!(
            envelope_manifest["sample_execution_provenance"]["samples"][0]["sample_binding"]
                ["relax_to_eigen_handoff_sha256"],
            "root-handoff-binding"
        );
        assert_eq!(
            envelope_manifest["sample_execution_provenance"]["samples"][0]["sample_binding"]
                ["source_mesh_topology_sha256"],
            "root-modal-mesh-binding"
        );

        let wrong_index_envelope = serde_json::json!({
            "solver_adapter": "root_wrong_index_adapter",
            "resolved_execution": {"engine": "root_wrong_index_engine"},
            "sample_solver_diagnostics": [{
                "sample_index": 10,
                "diagnostics": diagnostic(
                    "unmatched_nested_engine",
                    "unmatched_nested_algorithm",
                    "exp_i_omega_t",
                    "wrong-index",
                ),
            }],
        });
        let wrong_index_result = path_result(
            vec![sample(
                11,
                [1.0e6, 0.0, 0.0],
                model,
                Some(wrong_index_envelope),
            )],
            model,
        );
        let wrong_index_manifest = manifest(&wrong_index_result);
        assert_eq!(
            wrong_index_manifest["sample_execution_provenance"]["status"],
            "missing"
        );
        assert_eq!(
            wrong_index_manifest["sample_execution_provenance"]["diagnostics_available_count"],
            0
        );
        assert!(wrong_index_manifest["resolved_execution"]["engine"].is_null());

        let duplicate_index_envelope = serde_json::json!({
            "solver_adapter": "root_duplicate_index_adapter",
            "resolved_execution": {"engine": "root_duplicate_index_engine"},
            "sample_solver_diagnostics": [
                {
                    "sample_index": 13,
                    "diagnostics": diagnostic(
                        "duplicate_nested_engine_a",
                        "duplicate_nested_algorithm_a",
                        "exp_i_omega_t",
                        "duplicate-a",
                    ),
                },
                {
                    "sample_index": 13,
                    "diagnostics": diagnostic(
                        "duplicate_nested_engine_b",
                        "duplicate_nested_algorithm_b",
                        "exp_i_omega_t",
                        "duplicate-b",
                    ),
                },
            ],
        });
        let duplicate_index_result = path_result(
            vec![sample(
                13,
                [1.0e6, 0.0, 0.0],
                model,
                Some(duplicate_index_envelope),
            )],
            model,
        );
        let duplicate_index_manifest = manifest(&duplicate_index_result);
        assert_eq!(
            duplicate_index_manifest["sample_execution_provenance"]["status"],
            "missing"
        );
        assert_eq!(
            duplicate_index_manifest["sample_execution_provenance"]["diagnostics_available_count"],
            0
        );
        assert!(duplicate_index_manifest["resolved_execution"]["engine"].is_null());

        let mut algorithm_a =
            diagnostic("shared_engine", "shared_implementation", "exp_i_omega_t", "alg-a");
        algorithm_a["solver_adapter"] = serde_json::json!("shared_adapter");
        algorithm_a["resolved_execution"]["implementation_id"] =
            serde_json::json!("shared_implementation");
        algorithm_a["resolved_execution"]["solver_algorithm"] =
            serde_json::json!("algorithm_a");
        let mut algorithm_b =
            diagnostic("shared_engine", "shared_implementation", "exp_i_omega_t", "alg-b");
        algorithm_b["solver_adapter"] = serde_json::json!("shared_adapter");
        algorithm_b["resolved_execution"]["implementation_id"] =
            serde_json::json!("shared_implementation");
        algorithm_b["resolved_execution"]["solver_algorithm"] =
            serde_json::json!("algorithm_b");
        let algorithm_result = path_result(
            vec![
                sample(
                    2,
                    [0.0, 0.0, 0.0],
                    model,
                    Some(algorithm_a),
                ),
                sample(
                    9,
                    [1.0e6, 0.0, 0.0],
                    model,
                    Some(algorithm_b),
                ),
            ],
            model,
        );
        let algorithm_manifest = manifest(&algorithm_result);
        assert_eq!(
            algorithm_manifest["sample_execution_provenance"]["status"],
            "mixed"
        );
        assert_eq!(
            algorithm_manifest["resolved_execution"]["engine"],
            "shared_engine"
        );
        assert_eq!(
            algorithm_manifest["resolved_execution"]["implementation_id"],
            "shared_implementation"
        );
        assert!(algorithm_manifest["resolved_execution"]["solver_algorithm"].is_null());
        assert_eq!(
            algorithm_manifest["sample_execution_provenance"]["samples"][0]
                ["resolved_execution"]["solver_algorithm"],
            "algorithm_a"
        );
        assert_eq!(
            algorithm_manifest["sample_execution_provenance"]["samples"][1]
                ["resolved_execution"]["solver_algorithm"],
            "algorithm_b"
        );

        let mut implementation_a =
            diagnostic("same_engine", "same_algorithm", "exp_i_omega_t", "implementation-a");
        implementation_a["solver_adapter"] = serde_json::json!("same_adapter");
        implementation_a["resolved_execution"]["solver_algorithm"] =
            serde_json::json!("same_algorithm");
        implementation_a["resolved_execution"]["implementation_id"] =
            serde_json::json!("implementation_a");
        let mut implementation_b =
            diagnostic("same_engine", "same_algorithm", "exp_i_omega_t", "implementation-b");
        implementation_b["solver_adapter"] = serde_json::json!("same_adapter");
        implementation_b["resolved_execution"]["solver_algorithm"] =
            serde_json::json!("same_algorithm");
        implementation_b["resolved_execution"]["implementation_id"] =
            serde_json::json!("implementation_b");
        let implementation_result = path_result(
            vec![
                sample(2, [0.0, 0.0, 0.0], model, Some(implementation_a)),
                sample(9, [1.0e6, 0.0, 0.0], model, Some(implementation_b)),
            ],
            model,
        );
        let implementation_manifest = manifest(&implementation_result);
        assert_eq!(
            implementation_manifest["sample_execution_provenance"]["status"],
            "mixed"
        );
        assert_eq!(
            implementation_manifest["resolved_execution"]["engine"],
            "same_engine"
        );
        assert_eq!(
            implementation_manifest["resolved_execution"]["solver_algorithm"],
            "same_algorithm"
        );
        assert!(implementation_manifest["resolved_execution"]["implementation_id"].is_null());

        let homogeneous_result = path_result(
            vec![
                sample(
                    7,
                    [0.0, 0.0, 0.0],
                    model,
                    Some(diagnostic(
                        "single_path_adapter",
                        "same_solver",
                        "exp_i_omega_t",
                        "signature-k0",
                    )),
                ),
                sample(
                    0,
                    [1.0e6, 0.0, 0.0],
                    model,
                    Some(diagnostic(
                        "single_path_adapter",
                        "same_solver",
                        "exp_i_omega_t",
                        "signature-k1",
                    )),
                ),
            ],
            model,
        );
        let homogeneous = manifest(&homogeneous_result);
        assert_eq!(
            homogeneous["sample_execution_provenance"]["status"],
            "homogeneous"
        );
        assert_eq!(homogeneous["resolved_execution"]["engine"], "single_path_adapter");
        assert_eq!(homogeneous["resolved_execution"]["solver_algorithm"], "same_solver");
        assert_eq!(homogeneous["physics"]["phase_convention"], "exp_i_omega_t");
        assert!(homogeneous["operator_input_signature_sha256"].is_null());
        let homogeneous_transport =
            crate::fem::eigen_diagnostics_transport_metadata(&homogeneous_result, None);
        assert_eq!(homogeneous_transport["basis_transport_policy"], "tangent_frame_identity");
        assert_eq!(homogeneous_transport["floquet_tangent_frame_max_mismatch"], 0.0);
        assert_eq!(homogeneous_transport["demag_kind"], "periodic_airbox_k0");
        assert_eq!(homogeneous_transport["production_solver_available"], false);
        assert_eq!(homogeneous_transport["sample_execution_provenance_status"], "homogeneous");

        let partial_result = path_result(
            vec![
                sample(
                    2,
                    [0.0, 0.0, 0.0],
                    model,
                    Some(diagnostic(
                        "single_path_adapter",
                        "same_solver",
                        "exp_i_omega_t",
                        "signature-partial",
                    )),
                ),
                sample(8, [1.0e6, 0.0, 0.0], model, None),
            ],
            model,
        );
        let partial = manifest(&partial_result);
        assert_eq!(
            partial["sample_execution_provenance"]["status"],
            "partial"
        );
        assert_eq!(
            partial["sample_execution_provenance"]["diagnostics_missing_count"],
            1
        );
        assert!(partial["resolved_execution"]["engine"].is_null());
        assert!(partial["physics"]["phase_convention"].is_null());

        let missing_result = path_result(
            vec![
                sample(3, [0.0, 0.0, 0.0], model, None),
                sample(6, [1.0e6, 0.0, 0.0], model, None),
            ],
            model,
        );
        let missing = manifest(&missing_result);
        assert_eq!(
            missing["sample_execution_provenance"]["status"],
            "missing"
        );
        let missing_transport =
            crate::fem::eigen_diagnostics_transport_metadata(&missing_result, Some(&plan));
        assert!(missing_transport["basis_transport_policy"].is_null());
        assert!(missing_transport["production_solver_available"].is_null());
        assert_eq!(missing_transport["sample_execution_provenance_status"], "missing");
        assert!(missing["resolved_execution"]["engine"].is_null());
        assert!(missing["resolved_execution"]["solver_algorithm"].is_null());
        assert!(missing["physics"]["phase_convention"].is_null());

        let legacy_reference_result = path_result(
            vec![
                sample(1, [0.0, 0.0, 0.0], reference_model, None),
                sample(4, [1.0e6, 0.0, 0.0], reference_model, None),
            ],
            reference_model,
        );
        let legacy_reference = manifest(&legacy_reference_result);
        assert_eq!(
            legacy_reference["sample_execution_provenance"]["status"],
            "orchestrator_only_reference"
        );
        assert_eq!(
            legacy_reference["resolved_execution"]["reference_or_production"],
            "reference"
        );
        assert_eq!(
            legacy_reference["resolved_execution"]["solver_algorithm"],
            "reference_scalar_tangent"
        );
        assert!(legacy_reference["physics"]["phase_convention"].is_null());
    }

    #[test]
    fn native_modal_producer_summary_keeps_outer_sample_index_in_path_provenance() {
        let plan = residual_transport_test_plan();
        let solver_model = crate::eigen::EigenSolverModel::ProductionCpuShiftInvert;
        let reduction = ReductionMap {
            active_nodes: Vec::new(),
            node_map: Vec::new(),
            node_phases: Vec::new(),
            complex_reduction: false,
        };
        let producer_sample = |sample_index: usize,
                               engine: &str,
                               algorithm: &str,
                               adapter: &str| {
            let producer_diagnostics = serde_json::json!({
                "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
                "solver_adapter": adapter,
                "execution_lane": "production_cpu",
                "requested_execution": {
                    "solver_method": "targeted_spectrum",
                    "preconditioner": "jacobi",
                    "magnetostatic_bc": "not_applicable",
                },
                "resolved_execution": {
                    "device": "cpu",
                    "precision": "double",
                    "engine": engine,
                    "native_backend": "native_cpu",
                    "reference_or_production": "production",
                    "demag_realization": "none",
                    "solver_library": "slepc",
                    "solver_algorithm": algorithm,
                    "implementation_id": format!("{algorithm}_implementation"),
                    "status": "ready",
                    "device_residency": "host",
                    "operator_residency": "host",
                    "vector_residency": "host",
                    "krylov_residency": "host",
                    "preconditioner_residency": "host",
                    "fallback_used": false,
                },
                "phasor_convention": "exp_i_omega_t",
                "validation_state": "unvalidated",
            });
            let artifacts = crate::fem::eigen_native_artifacts::native_modal_artifacts(
                &plan,
                &[OutputIR::EigenSpectrum {
                    quantity: "eigenfrequency".to_string(),
                }],
                &plan.equilibrium_magnetization,
                &reduction,
                &[],
                &[],
                None,
                producer_diagnostics,
                0,
                None,
                None,
                None,
                None,
                sample_index,
                None,
            )
            .expect("native producer should publish its summary diagnostics");
            let summary_artifact = artifacts
                .iter()
                .find(|artifact| artifact.relative_path == "eigen/metadata/eigen_summary.json")
                .expect("native producer should publish an eigen summary");
            let summary: serde_json::Value = serde_json::from_slice(&summary_artifact.bytes)
                .expect("producer summary should be JSON");
            assert_eq!(summary["sample_index"], sample_index);
            assert_eq!(
                summary["solver_diagnostics"]["sample_solver_diagnostics"][0]["sample_index"],
                sample_index
            );

            let sample = SingleKSolveResult {
                sample: KSampleDescriptor {
                    sample_index,
                    label: Some(format!("producer-sample-{sample_index}")),
                    segment_index: Some(0),
                    path_s: sample_index as f64,
                    t_in_segment: 0.0,
                    k_vector: if sample_index == 0 {
                        [0.0, 0.0, 0.0]
                    } else {
                        [sample_index as f64, 0.0, 0.0]
                    },
                },
                modes: Vec::new(),
                relaxation_steps: 0,
                solver_model,
                solver_notes: Vec::new(),
                solver_diagnostics: Some(summary["solver_diagnostics"].clone()),
            };
            (sample, artifacts)
        };
        let (k0_sample, artifacts) = producer_sample(
            0,
            "native_k0_engine",
            "native_k0_algorithm",
            "native_k0_adapter",
        );
        let (later_sample, _later_artifacts) = producer_sample(
            7,
            "native_floquet_engine",
            "native_floquet_algorithm",
            "native_floquet_adapter",
        );
        let result = crate::eigen::PathSolveResult {
            gamma0_rad_s_per_a_m: plan.gyromagnetic_ratio,
            samples: vec![k0_sample, later_sample],
            branches: Vec::new(),
            solver_model,
            notes: Vec::new(),
            include_demag: plan.operator.include_demag,
            dispersion_validation: plan.dispersion_validation.clone(),
            k0_kittel_validation: plan.k0_kittel_validation.clone(),
            solver_policy: plan.solver_policy.clone(),
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };
        let path_diagnostics = eigen_path_solver_diagnostics(
            FemEngine::CpuNative,
            &plan,
            &result,
            &BTreeSet::new(),
        );
        assert_eq!(
            path_diagnostics["sample_solver_diagnostics"][0]["sample_index"],
            0
        );
        assert_eq!(
            path_diagnostics["sample_solver_diagnostics"][1]["sample_index"],
            7
        );
        assert_eq!(
            path_diagnostics["sample_solver_diagnostics"][1]["diagnostics"]
                ["sample_solver_diagnostics"][0]["sample_index"],
            7
        );
        assert_ne!(
            path_diagnostics["solver_adapter"],
            path_diagnostics["sample_solver_diagnostics"][0]["diagnostics"]
                ["sample_solver_diagnostics"][0]["diagnostics"]["solver_adapter"]
        );
        assert_ne!(
            path_diagnostics["solver_adapter"],
            path_diagnostics["sample_solver_diagnostics"][1]["diagnostics"]
                ["sample_solver_diagnostics"][0]["diagnostics"]["solver_adapter"]
        );

        let manifest = build_eigen_path_frequency_domain_manifest(
            FemEngine::CpuNative,
            &result,
            &artifacts,
            &plan,
            &[],
        );
        assert_eq!(
            manifest["sample_execution_provenance"]["status"],
            "mixed"
        );
        assert_eq!(
            manifest["sample_execution_provenance"]["samples"][0]["sample_index"],
            0
        );
        assert_eq!(
            manifest["sample_execution_provenance"]["samples"][0]["resolved_execution"]["engine"],
            "native_k0_engine"
        );
        assert_eq!(
            manifest["sample_execution_provenance"]["samples"][1]["sample_index"],
            7
        );
        assert_eq!(
            manifest["sample_execution_provenance"]["samples"][1]["resolved_execution"]["engine"],
            "native_floquet_engine"
        );
        assert!(manifest["resolved_execution"]["engine"].is_null());
        assert!(manifest["resolved_execution"]["solver_algorithm"].is_null());
        assert!(manifest["resolved_execution"]["implementation_id"].is_null());
        assert_eq!(manifest["physics"]["phase_convention"], "exp_i_omega_t");
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
            OutputIR::EigenDiagnostics {
                include_tracking: false,
                include_residuals: true,
                include_overlaps: true,
                include_tangent_leakage: false,
                include_orthogonality: false,
            },
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
        assert!(!internal
            .iter()
            .any(|output| matches!(output, OutputIR::EigenDiagnostics { .. })));
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
            && spectral_transform == Some("shift_invert")
        {
            let floquet_request = matches!(
                plan.spin_wave_bc.kind(),
                fullmag_ir::SpinWaveBoundaryKindIR::Floquet
            );
            let floquet_coupled_dynamic_demag_request =
                floquet_request && plan.operator.include_demag && plan.enable_demag;
            if floquet_coupled_dynamic_demag_request
                && eigen_path_single_k_has_floquet_shared_domain_production_cpu_contract(
                    diagnostics,
                )
            {
                return crate::eigen::EigenSolverModel::ProductionCpuShiftInvert;
            }
            if solver_model == Some("slepc_multi_shift_invert_production_cpu_dense")
                || solver_model == Some("slepc_multi_shift_invert_production_cpu_sparse_csr")
                || solver_adapter == Some("k0_poisson_airbox_cpu_full_coupled_slepc")
                || solver_adapter == Some("k0_poisson_airbox_cpu_schur_slepc")
            {
                if floquet_request && !eigen_path_single_k_has_bloch_floquet_contract(diagnostics)
                {
                    return crate::eigen::EigenSolverModel::ReferenceFull2x2Tangent;
                }
                return crate::eigen::EigenSolverModel::ProductionCpuShiftInvert;
            }
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

fn eigen_path_single_k_has_floquet_shared_domain_production_cpu_contract(
    diagnostics: Option<&serde_json::Value>,
) -> bool {
    let Some(diagnostics) = diagnostics else {
        return false;
    };
    let string = |key| diagnostics.get(key).and_then(serde_json::Value::as_str);
    let boolean = |key| diagnostics.get(key).and_then(serde_json::Value::as_bool);

    // The native runner rewrites solver_model to the adapter ID when it
    // merges result diagnostics. solver_family retains the C++ solver model.
    string("solver_model") == Some("floquet_airbox_cpu_schur_slepc")
        && string("solver_family") == Some("floquet_multi_shift_invert_slepc_sparse")
        && string("solver_adapter") == Some("floquet_airbox_cpu_schur_slepc")
        && string("mfem_operator_payload") == Some("floquet_shared_domain_sparse_matshell")
        && string("demag_kind") == Some("floquet_airbox")
        && string("algebraic_form") == Some("schur_reduced_descriptor")
        && string("execution_lane") == Some("production_cpu")
        && string("spectral_transform") == Some("shift_invert")
        && boolean("production_solver_available") == Some(true)
        && boolean("production_native_solver_available") == Some(true)
        && boolean("modal_periodic_pair_contract_available") == Some(true)
        && boolean("tiny_validation_solver") == Some(false)
        && boolean("validation_only") != Some(true)
        && diagnostics
            .get("floquet_periodic_pair_count")
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|count| count > 0)
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

pub(in crate::fem) fn eigen_path_tracking_outputs(outputs: &[OutputIR], mode_count: u32) -> Vec<OutputIR> {
    // A single-k solver must not see path-level branch/sample selectors. Its
    // candidate vectors are needed at every sample to track before exporting.
    let mut tracking_outputs = outputs
        .iter()
        .filter(|output| {
            !matches!(
                output,
                OutputIR::EigenMode { .. }
                    | OutputIR::DispersionCurve { .. }
                    | OutputIR::EigenDiagnostics { .. }
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
    eigen_path_candidate_mode_indices_for_sample(
        outputs,
        sample.sample_index,
        sample.label.as_deref(),
        available_mode_indices,
    )
}

pub(in crate::fem) fn eigen_path_candidate_mode_indices_for_sample(
    outputs: &[OutputIR],
    sample_index: usize,
    sample_label: Option<&str>,
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
                    .any(|index| *index as usize == sample_index)
                || sample_label.is_some_and(|label| {
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

/// Materialize shared-domain physical-potential sidecars only after path
/// assignment has resolved branch selectors to exact sample/raw-mode IDs.
/// The raw mode JSON and Floquet certificate payload remain in `artifacts`.
pub(super) fn materialize_selected_path_physical_potential_artifacts(
    plan: &FemEigenPlanIR,
    samples: &[crate::eigen::KSampleDescriptor],
    actual_mode_ids: &BTreeSet<SampleModeId>,
    selected_mode_ids: &BTreeSet<SampleModeId>,
    artifacts: &mut Vec<crate::types::AuxiliaryArtifact>,
) -> Result<(), RunError> {
    use num_complex::Complex64;

    if selected_mode_ids.is_empty() {
        return Ok(());
    }
    let mut topology = None;
    let mut scalar_classes = None;
    let mut scalar_class_count = None;
    let mut expected_source_mesh = None;

    for selected in selected_mode_ids {
        let sample = samples
            .iter()
            .find(|sample| sample.sample_index == selected.sample_index)
            .ok_or_else(|| RunError {
                message: format!(
                    "deferred physical-potential selector references missing sample {}",
                    selected.sample_index
                ),
            })?;
        if !actual_mode_ids.contains(selected) {
            return Err(RunError {
                message: format!(
                    "deferred physical-potential selector references missing raw mode sample={} raw_mode={}",
                    selected.sample_index, selected.raw_mode_index
                ),
            });
        }
        let raw_mode_index = u32::try_from(selected.raw_mode_index).map_err(|_| RunError {
            message: "deferred physical-potential raw mode index exceeds selector range".into(),
        })?;
        let base = format!(
            "eigen/mode_fields/sample_{:04}/mode_{raw_mode_index:04}",
            selected.sample_index
        );
        let manifest_path = format!("{base}/physical_potential.v1.json");
        let potential_path = format!("{base}/potential_full.bin");
        let demag_path = format!("{base}/demag_element_full.bin");
        let mode_path = format!(
            "eigen/modes/sample_{:04}/mode_{raw_mode_index:04}.json",
            selected.sample_index
        );
        let mut matching_mode = artifacts
            .iter()
            .filter(|artifact| artifact.relative_path == mode_path);
        let mode_artifact = matching_mode.next().ok_or_else(|| RunError {
            message: format!(
                "deferred physical-potential mode certificate is missing: {mode_path}"
            ),
        })?;
        if matching_mode.next().is_some() {
            return Err(RunError {
                message: format!(
                    "deferred physical-potential mode certificate has duplicate owners: {mode_path}"
                ),
            });
        }
        let mode: Value = serde_json::from_slice(&mode_artifact.bytes).map_err(|error| RunError {
            message: format!("deferred physical-potential mode certificate is invalid: {error}"),
        })?;
        let sample_index_u64 = u64::try_from(selected.sample_index).map_err(|_| RunError {
            message: "deferred physical-potential sample index exceeds u64".into(),
        })?;
        let expected_raw_mode_index = u64::from(raw_mode_index);
        let mut has_raw_mode_identity = false;
        let raw_mode_identity_matches = ["index", "raw_mode_index"].into_iter().all(|key| {
            let Some(value) = mode.get(key) else {
                return true;
            };
            has_raw_mode_identity = true;
            value.as_u64() == Some(expected_raw_mode_index)
        });
        if mode.get("sample_index").and_then(Value::as_u64) != Some(sample_index_u64)
            || !has_raw_mode_identity
            || !raw_mode_identity_matches
        {
            return Err(RunError {
                message: format!(
                    "deferred physical-potential mode certificate identity disagrees with {mode_path}"
                ),
            });
        }
        let shared_domain_mode = mode.get("assembly_kind").and_then(Value::as_str)
            == Some("mfem_weak_form_shared_domain");
        let existing_manifest = artifacts
            .iter()
            .filter(|artifact| artifact.relative_path == manifest_path)
            .collect::<Vec<_>>();
        if existing_manifest.is_empty() && !shared_domain_mode {
            continue;
        }
        if expected_source_mesh.is_none() {
            expected_source_mesh = Some(
                plan.mesh
                    .mixed_topology_fingerprint_v3()
                    .map_err(|error| RunError {
                        message: format!(
                            "deferred physical-potential mesh identity is invalid: {error}"
                        ),
                    })?,
            );
        }
        let expected_source_mesh_value = expected_source_mesh
            .as_deref()
            .ok_or_else(|| RunError {
                message: "deferred physical-potential mesh identity is missing".into(),
            })?;
        if !existing_manifest.is_empty() {
            if existing_manifest.len() != 1 {
                return Err(RunError {
                    message: format!(
                        "deferred physical-potential manifest has duplicate owners: {manifest_path}"
                    ),
                });
            }
            let manifest: Value = serde_json::from_slice(&existing_manifest[0].bytes).map_err(
                |error| RunError {
                    message: format!(
                        "deferred physical-potential manifest is invalid at {manifest_path}: {error}"
                    ),
                },
            )?;
            let source_mesh = require_path_source_digest(&mode, "source_mesh_topology_sha256")?;
            let operator_signature =
                require_path_source_digest(&mode, "operator_input_signature_sha256")?;
            let phase_constraint = require_path_source_digest(&mode, "phase_constraint_sha256")?;
            let potential_sidecars = artifacts
                .iter()
                .filter(|artifact| artifact.relative_path == potential_path)
                .count();
            let demag_sidecars = artifacts
                .iter()
                .filter(|artifact| artifact.relative_path == demag_path)
                .count();
            if manifest.get("sample_index").and_then(Value::as_u64) != Some(sample_index_u64)
                || manifest.get("mode_index").and_then(Value::as_u64)
                    != Some(u64::from(raw_mode_index))
                || manifest
                    .get("potential")
                    .and_then(|value| value.get("path"))
                    .and_then(Value::as_str)
                    != Some(potential_path.as_str())
                || manifest
                    .get("demag_field")
                    .and_then(|value| value.get("path"))
                    .and_then(Value::as_str)
                    != Some(demag_path.as_str())
                || manifest
                    .get("source_mesh_topology_sha256")
                    .and_then(Value::as_str)
                    != Some(source_mesh)
                || manifest
                    .get("operator_input_signature_sha256")
                    .and_then(Value::as_str)
                    != Some(operator_signature)
                || manifest
                    .get("phase_constraint_sha256")
                    .and_then(Value::as_str)
                    != Some(phase_constraint)
                || source_mesh != expected_source_mesh_value
                || !shared_domain_mode
                || potential_sidecars != 1
                || demag_sidecars != 1
            {
                return Err(RunError {
                    message: format!(
                        "deferred physical-potential artifact ownership is inconsistent at {manifest_path}"
                    ),
                });
            }
            continue;
        }
        if !shared_domain_mode {
            continue;
        }

        if topology.is_none() {
            topology = Some(
                fullmag_engine::fem::MeshTopology::from_ir(&plan.mesh).map_err(|error| {
                    RunError {
                        message: format!(
                            "deferred physical-potential mesh topology is invalid: {error}"
                        ),
                    }
                })?,
            );
        }
        if scalar_classes.is_none() {
            let topology_ref = topology.as_ref().ok_or_else(|| RunError {
                message: "deferred physical-potential topology was not constructed".into(),
            })?;
            let (classes, class_count_u64, _, _) =
                super::super::eigen_shared_domain_geometry::modal_shared_domain_equivalence_classes(
                    topology_ref,
                )?;
            scalar_classes = Some(classes);
            scalar_class_count = Some(usize::try_from(class_count_u64).map_err(|_| RunError {
                message: "deferred physical-potential scalar class count exceeds host dimensions"
                    .into(),
            })?);
        }

        let source_mesh = require_path_source_digest(&mode, "source_mesh_topology_sha256")?;
        let operator_signature =
            require_path_source_digest(&mode, "operator_input_signature_sha256")?;
        let phase_constraint = require_path_source_digest(&mode, "phase_constraint_sha256")?;
        if source_mesh != expected_source_mesh_value {
            return Err(RunError {
                message: format!(
                    "deferred physical-potential source mesh identity disagrees with {mode_path}"
                ),
            });
        }
        let provenance = serde_json::json!({
            "source_mesh_topology_sha256": source_mesh,
            "operator_input_signature_sha256": operator_signature,
            "phase_constraint_sha256": phase_constraint,
        });

        let phi_real = mode.get("phi_real").and_then(Value::as_array);
        let phi_imag = mode.get("phi_imag").and_then(Value::as_array);
        let reduced = match (phi_real, phi_imag) {
            (Some(real), Some(imag)) if !real.is_empty() || !imag.is_empty() => {
                if real.len() != imag.len() {
                    return Err(RunError {
                        message: format!(
                            "deferred physical-potential phi real/imag lengths differ in {mode_path}"
                        ),
                    });
                }
                real.iter()
                    .zip(imag)
                    .map(|(real, imag)| {
                        let real = real.as_f64().filter(|value| value.is_finite()).ok_or_else(
                            || RunError {
                                message: format!(
                                    "deferred physical-potential phi real coefficient is invalid in {mode_path}"
                                ),
                            },
                        )?;
                        let imag = imag.as_f64().filter(|value| value.is_finite()).ok_or_else(
                            || RunError {
                                message: format!(
                                    "deferred physical-potential phi imaginary coefficient is invalid in {mode_path}"
                                ),
                            },
                        )?;
                        Ok(Complex64::new(real, imag))
                    })
                    .collect::<Result<Vec<_>, RunError>>()?
            }
            (None, None) => read_deferred_floquet_potential(artifacts, selected, raw_mode_index)?,
            (Some(real), Some(imag)) if real.is_empty() && imag.is_empty() => {
                read_deferred_floquet_potential(artifacts, selected, raw_mode_index)?
            }
            _ => {
                return Err(RunError {
                    message: format!(
                        "deferred physical-potential mode certificate has incomplete phi fields: {mode_path}"
                    ),
                });
            }
        };
        let split_representation = mode
            .get("potential_representation")
            .and_then(Value::as_str)
            == Some("doubled_real_split_complex_coefficients");
        let reduced = if split_representation {
            super::super::eigen_physical_potential::doubled_real_split_to_complex(
                &reduced,
                scalar_class_count.ok_or_else(|| RunError {
                    message: "deferred physical-potential scalar class count is missing".into(),
                })?,
            )?
        } else {
            let expected_count = scalar_class_count.ok_or_else(|| RunError {
                message: "deferred physical-potential scalar class count is missing".into(),
            })?;
            if reduced.len() != expected_count {
                return Err(RunError {
                    message: format!(
                        "deferred physical-potential phi has {} coefficients; expected {expected_count} in {mode_path}",
                        reduced.len(),
                    ),
                });
            }
            reduced
        };
        let topology_ref = topology.as_ref().ok_or_else(|| RunError {
            message: "deferred physical-potential topology is missing".into(),
        })?;
        let scalar_classes_ref = scalar_classes.as_ref().ok_or_else(|| RunError {
            message: "deferred physical-potential scalar classes are missing".into(),
        })?;
        let scalar_class_count = scalar_class_count.ok_or_else(|| RunError {
            message: "deferred physical-potential scalar class count is missing".into(),
        })?;
        let point_plan = super::eigen_path_single_k_point_plan(plan, sample, false, None)?;
        let phases = super::super::eigen_mass_metric::canonical_shared_domain_phases(
            topology_ref,
            &point_plan,
        )?;
        let generated = super::super::eigen_physical_potential::physical_potential_artifacts(
            topology_ref,
            &reduced,
            scalar_class_count,
            scalar_classes_ref,
            &phases,
            selected.sample_index,
            selected.raw_mode_index,
            &provenance,
        )?;
        for generated_artifact in generated {
            if let Some(existing) = artifacts
                .iter()
                .find(|artifact| artifact.relative_path == generated_artifact.relative_path)
            {
                if existing.bytes != generated_artifact.bytes {
                    return Err(RunError {
                        message: format!(
                            "deferred physical-potential sidecar conflicts with an existing owner: {}",
                            generated_artifact.relative_path
                        ),
                    });
                }
            } else {
                artifacts.push(generated_artifact);
            }
        }
    }
    Ok(())
}

fn read_deferred_floquet_potential(
    artifacts: &[crate::types::AuxiliaryArtifact],
    selected: &SampleModeId,
    raw_mode_index: u32,
) -> Result<Vec<num_complex::Complex64>, RunError> {
    let split_path = super::super::eigen_output::floquet_potential_payload_path(
        selected.sample_index,
        u64::from(raw_mode_index),
    );
    let mut matching_split = artifacts
        .iter()
        .filter(|artifact| artifact.relative_path == split_path);
    let split = matching_split.next().ok_or_else(|| RunError {
        message: format!(
            "deferred physical-potential raw phi certificate is missing: {split_path}"
        ),
    })?;
    if matching_split.next().is_some() || split.bytes.is_empty() || split.bytes.len() % 16 != 0 {
        return Err(RunError {
            message: format!(
                "deferred physical-potential raw phi certificate is malformed: {split_path}"
            ),
        });
    }
    split
        .bytes
        .chunks_exact(16)
        .map(|chunk| {
            let real = f64::from_le_bytes(chunk[0..8].try_into().map_err(|_| RunError {
                message: format!("invalid real coefficient in {split_path}"),
            })?);
            let imag = f64::from_le_bytes(chunk[8..16].try_into().map_err(|_| RunError {
                message: format!("invalid imaginary coefficient in {split_path}"),
            })?);
            if !real.is_finite() || !imag.is_finite() {
                return Err(RunError {
                    message: format!(
                        "deferred physical-potential raw phi certificate is non-finite: {split_path}"
                    ),
                });
            }
            Ok(num_complex::Complex64::new(real, imag))
        })
        .collect()
}

fn require_path_source_digest<'a>(
    mode: &'a Value,
    key: &str,
) -> Result<&'a str, RunError> {
    let value = mode.get(key).and_then(Value::as_str).ok_or_else(|| RunError {
        message: format!("deferred physical-potential mode certificate is missing {key}"),
    })?;
    let digest = value.strip_prefix("sha256:").unwrap_or_default();
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(RunError {
            message: format!("deferred physical-potential {key} is not a SHA-256 identity"),
        });
    }
    Ok(value)
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

#[cfg(test)]
mod deferred_physical_potential_tests {
    use super::*;
    use crate::types::AuxiliaryArtifact;
    use fullmag_engine::fem::MeshTopology;
    use num_complex::Complex64;
    use sha2::{Digest, Sha256};
    use std::collections::BTreeMap;

    fn shared_periodic_plan() -> FemEigenPlanIR {
        let mut plan = crate::fem::eigen_tests::minimal_native_modal_plan();
        plan.mesh.periodic_node_pairs = vec![fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "x_faces".into(),
            node_a: 0,
            node_b: 1,
        }];
        plan.spin_wave_bc = fullmag_ir::SpinWaveBoundaryConditionIR::Config(
            fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
                boundary_pair_id: None,
                pair_ids: vec!["x_faces".into()],
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            },
        );
        plan.enable_demag = true;
        plan.operator.include_demag = true;
        plan
    }

    fn shared_floquet_plan() -> FemEigenPlanIR {
        let mut plan = shared_periodic_plan();
        plan.spin_wave_bc = fullmag_ir::SpinWaveBoundaryConditionIR::Config(
            fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".into()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            },
        );
        plan.k_sampling = Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [1.0e6, 0.0, 0.0],
        });
        plan
    }

    fn native_shared_domain_mode(
        raw_mode_index: usize,
        scalar_class_count: usize,
    ) -> crate::fem::eigen_native_result::NativeModalEigenpair {
        let mut vector = vec![Complex64::new(0.0, 0.0); 8];
        for node in 0..4 {
            vector[2 * node] = Complex64::new(
                if node == raw_mode_index { 1.0 } else { 0.1 },
                0.025 * (raw_mode_index + 1) as f64,
            );
            vector[2 * node + 1] = Complex64::new(
                0.05 * (node + 1) as f64,
                if node == raw_mode_index { 0.75 } else { 0.02 },
            );
        }
        let mode_offset = (raw_mode_index + 1) as f64;
        let floquet_potential_real_split = (0..2 * scalar_class_count)
            .map(|index| {
                Complex64::new(
                    mode_offset + index as f64,
                    0.125 * mode_offset + 0.01 * index as f64,
                )
            })
            .collect();
        let frequency_hz = 1.0e9 + raw_mode_index as f64 * 1.0e8;
        let omega_rad_s = std::f64::consts::TAU * frequency_hz;
        crate::fem::eigen_native_result::NativeModalEigenpair {
            cluster_id: raw_mode_index as u64,
            frequency_hz,
            omega_rad_s,
            eigenvalue_real: 0.0,
            eigenvalue_imag: omega_rad_s,
            residual_absolute_l2: Some(1.0e-10),
            residual_relative_l2: 1.0e-10,
            residual_linf: Some(1.0e-10),
            mass_norm: 1.0,
            block_residual_q: 1.0e-10,
            block_residual_phi: 1.0e-10,
            block_residual_gauge: None,
            backend_reported_residual: Some(1.0e-10),
            q_vector: vector.clone(),
            vector,
            phi_vector: Vec::new(),
            floquet_descriptor_certified: true,
            floquet_full_descriptor_certified: false,
            floquet_seam_frame_certified: false,
            floquet_gauge_policy_satisfied: false,
            floquet_geometric_bc_certified: false,
            floquet_poisson_boundary_kind: Some("poisson_dirichlet".into()),
            floquet_poisson_gauge_policy: Some("none".into()),
            floquet_potential_representation: Some(
                "doubled_real_split_complex_coefficients".into(),
            ),
            floquet_magnetic_relative_residual: Some(1.0e-10),
            floquet_potential_relative_residual: Some(1.0e-10),
            floquet_full_magnetic_relative_residual: None,
            floquet_full_potential_relative_residual: None,
            floquet_scalar_phase_seam_relative_residual: None,
            floquet_tangent_frame_seam_relative_residual: None,
            floquet_cartesian_magnetic_seam_relative_residual: None,
            floquet_equilibrium_pair_relative_residual: None,
            floquet_potential_real_split,
        }
    }

    fn native_candidate_artifacts(
        plan: &FemEigenPlanIR,
        modes: &[crate::fem::eigen_native_result::NativeModalEigenpair],
    ) -> Vec<AuxiliaryArtifact> {
        let equilibrium = plan.equilibrium_magnetization.clone();
        let active_nodes = (0..equilibrium.len()).collect::<Vec<_>>();
        let reduction = ReductionMap {
            active_nodes: active_nodes.clone(),
            node_map: active_nodes.iter().copied().map(Some).collect(),
            node_phases: vec![Complex64::new(1.0, 0.0); equilibrium.len()],
            complex_reduction: true,
        };
        let bases = crate::fem::eigen_projection::tangent_bases(&equilibrium);
        let mass_weights = vec![1.0; equilibrium.len()];
        let outputs = [OutputIR::EigenMode {
            field: "mode".into(),
            all_modes: true,
            indices: Vec::new(),
            branches: Vec::new(),
            sample_selector: None,
        }];
        crate::fem::eigen_native_artifacts::native_modal_artifacts(
            plan,
            &outputs,
            &equilibrium,
            &reduction,
            &bases,
            modes,
            Some(&mass_weights),
            serde_json::json!({
                "solver_model": "native_shared_domain_fixture",
                "solver_adapter": "floquet_dynamic_demag_shared_domain",
                "solver_kind": "native_shared_domain_fixture",
                "execution_lane": "production_cpu",
                "assembly_kind": "mfem_weak_form_shared_domain",
                "operator_input_signature_sha256": format!("sha256:{}", "a".repeat(64)),
                "phase_constraint_sha256": format!("sha256:{}", "b".repeat(64)),
            }),
            0,
            None,
            None,
            None,
            None,
            0,
            None,
        )
        .expect("native modal producer emits candidate and raw Floquet artifacts")
    }

    fn path_sample_from_native_tracking_vectors(
        sample_index: usize,
        vectors: &[Vec<Complex64>],
    ) -> crate::eigen::SingleKSolveResult {
        let solver_model = crate::eigen::EigenSolverModel::ProductionCpuShiftInvert;
        crate::eigen::SingleKSolveResult {
            sample: crate::eigen::KSampleDescriptor {
                sample_index,
                label: Some(if sample_index == 5 { "X" } else { "Y" }.into()),
                segment_index: Some(0),
                path_s: (sample_index - 5) as f64,
                t_in_segment: 0.5,
                k_vector: [1.0e6, 0.0, 0.0],
            },
            modes: vectors
                .iter()
                .enumerate()
                .map(|(raw_mode_index, vector)| {
                    let frequency_real_hz = 1.0e9 + raw_mode_index as f64 * 1.0e8;
                    crate::eigen::SingleKModeResult {
                        raw_mode_index,
                        branch_id: None,
                        frequency_real_hz,
                        frequency_imag_hz: 0.0,
                        angular_frequency_rad_per_s:
                            std::f64::consts::TAU * frequency_real_hz,
                        eigenvalue_real: 0.0,
                        eigenvalue_imag: std::f64::consts::TAU * frequency_real_hz,
                        norm: 1.0,
                        mass_norm: Some(1.0),
                        max_amplitude: 1.0,
                        residual_relative_l2: Some(1.0e-10),
                        residual_norm: Some(1.0e-10),
                        residual_linf: Some(1.0e-10),
                        tangent_leakage_mean_abs: Some(0.0),
                        tangent_leakage_max_abs: Some(0.0),
                        tangent_leakage_weighted_relative_l2: Some(0.0),
                        dominant_polarization: "linear".into(),
                        reduced_vector: Some(vector.clone()),
                        lifted_real: None,
                        lifted_imag: None,
                        amplitude: None,
                        phase: None,
                        node_mass_weights: Some(vec![1.0; 4]),
                        consistent_p1_metric: None,
                        component_participation:
                            crate::eigen::ModalParticipationObservable::unavailable_without_context(
                                "cpu",
                            ),
                    }
                })
                .collect(),
            relaxation_steps: 0,
            solver_model,
            solver_notes: Vec::new(),
            solver_diagnostics: None,
        }
    }

    fn decode_complex_payload(artifact: &AuxiliaryArtifact) -> Vec<Complex64> {
        assert_eq!(artifact.bytes.len() % 16, 0);
        artifact
            .bytes
            .chunks_exact(16)
            .map(|pair| {
                Complex64::new(
                    f64::from_le_bytes(pair[0..8].try_into().unwrap()),
                    f64::from_le_bytes(pair[8..16].try_into().unwrap()),
                )
            })
            .collect()
    }

    fn reference_mode_bundle_result() -> crate::eigen::PathSolveResult {
        let solver_model = crate::eigen::EigenSolverModel::ReferenceScalarTangent;
        let mut sample = path_sample_from_native_tracking_vectors(
            6,
            &[vec![Complex64::new(1.0, 0.0)]],
        );
        sample.solver_model = solver_model;
        sample.solver_diagnostics = Some(serde_json::json!({
            "mesh_id": "mesh:reference-mode-bundle-fixture",
            "topology_fingerprint": format!("sha256:{}", "c".repeat(64)),
        }));
        let mode = &mut sample.modes[0];
        mode.raw_mode_index = 3;
        mode.reduced_vector = Some(vec![Complex64::new(1.0, 0.0)]);
        mode.lifted_real = Some(vec![[1.0, 0.0, 0.0]]);
        mode.lifted_imag = Some(vec![[0.0, 1.0, 0.0]]);
        mode.amplitude = Some(vec![1.0]);
        mode.phase = Some(vec![0.0]);
        mode.node_mass_weights = None;
        crate::eigen::PathSolveResult {
            gamma0_rad_s_per_a_m: 2.211e5,
            samples: vec![sample],
            branches: Vec::new(),
            solver_model,
            notes: Vec::new(),
            include_demag: false,
            dispersion_validation: None,
            k0_kittel_validation: None,
            solver_policy: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        }
    }

    #[test]
    fn reference_mode_bundle_raw_identity_without_index_is_accepted_and_dual_identity_must_agree() {
        let plan = crate::fem::eigen_tests::minimal_native_modal_plan();
        let path_result = reference_mode_bundle_result();
        let samples = path_result
            .samples
            .iter()
            .map(|sample| sample.sample.clone())
            .collect::<Vec<_>>();
        let actual_mode_ids = path_result
            .samples
            .iter()
            .flat_map(|sample| {
                sample.modes.iter().map(|mode| {
                    SampleModeId::new(sample.sample.sample_index, mode.raw_mode_index)
                })
            })
            .collect::<BTreeSet<_>>();
        let selected_mode_ids = actual_mode_ids.clone();
        let mut artifacts = eigen_path_mode_artifacts_from_result(&path_result).unwrap();
        let mode_path = "eigen/modes/sample_0006/mode_0003.json";
        let mode_position = artifacts
            .iter()
            .position(|artifact| artifact.relative_path == mode_path)
            .expect("actual reference mode-bundle writer emits its sample-scoped mode JSON");
        let producer_mode: Value = serde_json::from_slice(&artifacts[mode_position].bytes).unwrap();
        assert_eq!(producer_mode["sample_index"], 6);
        assert_eq!(producer_mode["raw_mode_index"], 3);
        assert!(producer_mode.get("index").is_none());
        assert!(producer_mode["assembly_kind"].as_str().is_none());

        materialize_selected_path_physical_potential_artifacts(
            &plan,
            &samples,
            &actual_mode_ids,
            &selected_mode_ids,
            &mut artifacts,
        )
        .expect("reference mode producer's sample/raw identity does not require shared phi data");
        assert!(!artifacts.iter().any(|artifact| artifact
            .relative_path
            .ends_with("physical_potential.v1.json")));

        let mut matching_dual_identity = producer_mode.clone();
        matching_dual_identity["index"] = serde_json::json!(3);
        artifacts[mode_position].bytes = serde_json::to_vec(&matching_dual_identity).unwrap();
        materialize_selected_path_physical_potential_artifacts(
            &plan,
            &samples,
            &actual_mode_ids,
            &selected_mode_ids,
            &mut artifacts,
        )
        .expect("matching legacy and producer raw-mode identities are accepted");

        for (field, wrong_value) in [("index", 4), ("sample_index", 5)] {
            let mut mismatched = producer_mode.clone();
            mismatched[field] = serde_json::json!(wrong_value);
            artifacts[mode_position].bytes = serde_json::to_vec(&mismatched).unwrap();
            assert!(materialize_selected_path_physical_potential_artifacts(
                &plan,
                &samples,
                &actual_mode_ids,
                &selected_mode_ids,
                &mut artifacts,
            )
            .is_err());
        }
    }

    #[test]
    fn native_floquet_candidates_flow_through_tracking_selection_and_deferred_sidecars() {
        let plan = shared_floquet_plan();
        let topology = MeshTopology::from_ir(&plan.mesh).unwrap();
        let (scalar_classes, scalar_class_count_u64, _, _) =
            crate::fem::eigen_shared_domain_geometry::
                modal_shared_domain_equivalence_classes(&topology)
                .unwrap();
        let scalar_class_count = scalar_class_count_u64 as usize;
        let native_modes = (0..3)
            .map(|raw_mode_index| native_shared_domain_mode(raw_mode_index, scalar_class_count))
            .collect::<Vec<_>>();
        let producer_artifacts = native_candidate_artifacts(&plan, &native_modes);
        let source_mesh = plan.mesh.mixed_topology_fingerprint_v3().unwrap();
        let active_nodes = (0..topology.n_nodes).collect::<Vec<_>>();
        let candidate_vectors = (0..native_modes.len())
            .map(|raw_mode_index| {
                eigen_path_mode_tracking_vector(
                    &producer_artifacts,
                    raw_mode_index,
                    Some(&active_nodes),
                    &topology.coords,
                    [1.0e6, 0.0, 0.0],
                    true,
                    &source_mesh,
                )
                .expect("producer mode fields satisfy the path tracking reader")
                .expect("every retained candidate has a tracking field")
            })
            .collect::<Vec<_>>();

        let all_raw_mode_indices = BTreeSet::from([0_u32, 1, 2]);
        let source_artifacts = producer_artifacts
            .iter()
            .filter(|artifact| {
                (0..native_modes.len()).any(|raw_mode_index| {
                    artifact.relative_path
                        == format!("eigen/modes/sample_0000/mode_{raw_mode_index:04}.json")
                        || artifact.relative_path
                            == crate::fem::eigen_output::floquet_potential_payload_path(
                                0,
                                raw_mode_index as u64,
                            )
                })
            })
            .cloned()
            .collect::<Vec<_>>();
        let mut artifacts = Vec::new();
        for sample_index in [5, 6] {
            let remapped = remap_single_k_mode_artifacts(
                &source_artifacts,
                sample_index,
                &all_raw_mode_indices,
            )
            .expect("native mode and raw phi artifacts remap to their path sample");
            artifacts.extend(remapped);
        }

        let mut path_result = crate::eigen::PathSolveResult {
            gamma0_rad_s_per_a_m: plan.gyromagnetic_ratio,
            samples: vec![
                path_sample_from_native_tracking_vectors(5, &candidate_vectors),
                path_sample_from_native_tracking_vectors(6, &candidate_vectors),
            ],
            branches: Vec::new(),
            solver_model: crate::eigen::EigenSolverModel::ProductionCpuShiftInvert,
            notes: Vec::new(),
            include_demag: true,
            dispersion_validation: None,
            k0_kittel_validation: None,
            solver_policy: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };
        let tracking = fullmag_ir::ModeTrackingIR {
            method: fullmag_ir::ModeTrackingMethodIR::OverlapHungarian,
            frequency_window_hz: None,
            overlap_floor: 0.5,
            max_branch_gap: 0,
        };
        crate::eigen::tracking::track_branches(&mut path_result, Some(&tracking));
        let outputs = [OutputIR::EigenMode {
            field: "mode".into(),
            all_modes: false,
            indices: vec![0],
            branches: vec![0, 1],
            sample_selector: Some(fullmag_ir::SampleSelectorIR {
                sample_indices: vec![5],
                sample_labels: Vec::new(),
            }),
        }];
        let selection = crate::eigen::output_selection::select_eigen_outputs(
            &path_result,
            &outputs,
        )
        .expect("mixed explicit and tracked-branch selection resolves");
        let selected_mode_ids = selection.field_mode_ids().clone();
        assert_eq!(
            selected_mode_ids,
            BTreeSet::from([SampleModeId::new(5, 0), SampleModeId::new(5, 1)])
        );
        let samples = path_result
            .samples
            .iter()
            .map(|sample| sample.sample.clone())
            .collect::<Vec<_>>();
        let actual_mode_ids = path_result
            .samples
            .iter()
            .flat_map(|sample| {
                sample.modes.iter().map(|mode| {
                    SampleModeId::new(sample.sample.sample_index, mode.raw_mode_index)
                })
            })
            .collect::<BTreeSet<_>>();
        let original_certificates = artifacts
            .iter()
            .filter(|artifact| artifact.relative_path.starts_with("eigen/modes/sample_"))
            .map(|artifact| (artifact.relative_path.clone(), artifact.bytes.clone()))
            .collect::<BTreeMap<_, _>>();
        let original_phi_payloads = artifacts
            .iter()
            .filter(|artifact| artifact.relative_path.ends_with("potential_real_split.bin"))
            .map(|artifact| (artifact.relative_path.clone(), artifact.bytes.clone()))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(original_certificates.len(), 6);
        assert_eq!(original_phi_payloads.len(), 6);
        for (path, bytes) in &original_phi_payloads {
            assert!(!bytes.is_empty());
            let mode_path = path
                .replace("eigen/mode_fields/", "eigen/modes/")
                .replace("/potential_real_split.bin", ".json");
            let mode_artifact = artifacts
                .iter()
                .find(|artifact| artifact.relative_path == mode_path)
                .expect("native mode certificate is emitted with its phi payload");
            let mode: Value = serde_json::from_slice(&mode_artifact.bytes).unwrap();
            assert_eq!(
                mode["potential_representation"],
                "doubled_real_split_complex_coefficients"
            );
            assert_eq!(mode["potential_payload_path"], path.as_str());
            assert_eq!(
                mode["potential_payload_sha256"],
                format!("sha256:{:x}", Sha256::digest(bytes))
            );
        }

        materialize_selected_path_physical_potential_artifacts(
            &plan,
            &samples,
            &actual_mode_ids,
            &selected_mode_ids,
            &mut artifacts,
        )
        .unwrap();

        let physical_artifacts = artifacts
            .iter()
            .filter(|artifact| artifact.relative_path.contains("physical_potential.v1.json"))
            .collect::<Vec<_>>();
        assert_eq!(physical_artifacts.len(), 2);
        assert!(physical_artifacts.iter().all(|artifact| artifact
            .relative_path
            .contains("sample_0005/")));
        assert!(physical_artifacts.iter().any(|artifact| artifact
            .relative_path
            .contains("sample_0005/mode_0000/")));
        assert!(physical_artifacts.iter().any(|artifact| artifact
            .relative_path
            .contains("sample_0005/mode_0001/")));
        assert!(!artifacts.iter().any(|artifact| artifact.relative_path.contains("mode_0002/")
            && artifact.relative_path.ends_with("physical_potential.v1.json")));
        assert!(!artifacts.iter().any(|artifact| artifact.relative_path.contains("sample_0006/")
            && artifact.relative_path.ends_with("physical_potential.v1.json")));

        let phases = crate::fem::eigen_mass_metric::canonical_shared_domain_phases(
            &topology,
            &crate::fem::eigen_path::eigen_path_single_k_point_plan(
                &plan,
                &samples[0],
                false,
                None,
            )
            .unwrap(),
        )
        .unwrap();
        for selected in &selected_mode_ids {
            let raw_mode = &native_modes[selected.raw_mode_index];
            let reduced = crate::fem::eigen_physical_potential::
                doubled_real_split_to_complex(
                    &raw_mode.floquet_potential_real_split,
                    scalar_class_count,
                )
                .unwrap();
            let mode_path = format!(
                "eigen/modes/sample_{:04}/mode_{:04}.json",
                selected.sample_index, selected.raw_mode_index
            );
            let mode_artifact = artifacts
                .iter()
                .find(|artifact| artifact.relative_path == mode_path)
                .unwrap();
            let mode: Value = serde_json::from_slice(&mode_artifact.bytes).unwrap();
            let expected = crate::fem::eigen_physical_potential::physical_potential_artifacts(
                &topology,
                &reduced,
                scalar_class_count,
                &scalar_classes,
                &phases,
                selected.sample_index,
                selected.raw_mode_index,
                &serde_json::json!({
                    "source_mesh_topology_sha256": mode["source_mesh_topology_sha256"],
                    "operator_input_signature_sha256": mode["operator_input_signature_sha256"],
                    "phase_constraint_sha256": mode["phase_constraint_sha256"],
                }),
            )
            .unwrap();
            for expected_artifact in expected {
                let actual = artifacts
                    .iter()
                    .find(|artifact| artifact.relative_path == expected_artifact.relative_path)
                    .unwrap_or_else(|| panic!("deferred artifact missing: {}", expected_artifact.relative_path));
                if expected_artifact.relative_path.ends_with(".bin") {
                    assert_eq!(
                        decode_complex_payload(actual),
                        decode_complex_payload(&expected_artifact),
                        "numerical full-phi/H payload differs at {}",
                        expected_artifact.relative_path
                    );
                } else {
                    assert_eq!(actual.bytes, expected_artifact.bytes);
                }
            }
        }

        for (path, bytes) in original_certificates {
            let retained = artifacts
                .iter()
                .find(|artifact| artifact.relative_path == path)
                .expect("candidate mode certificate remains available after sidecar emission");
            assert_eq!(retained.bytes, bytes);
        }
        for (path, bytes) in original_phi_payloads {
            let retained = artifacts
                .iter()
                .find(|artifact| artifact.relative_path == path)
                .expect("raw Floquet phi certificate remains available after sidecar emission");
            assert_eq!(retained.bytes, bytes);
        }
    }

    #[test]
    fn branch_selected_potential_sidecars_are_materialized_after_assignment_only_for_selected_raw_ids() {
        let plan = shared_periodic_plan();
        let source_mesh = plan.mesh.mixed_topology_fingerprint_v3().unwrap();
        let operator_signature = format!("sha256:{}", "a".repeat(64));
        let phase_constraint = format!("sha256:{}", "b".repeat(64));
        let mut artifacts = (0..3)
            .map(|index| {
                let mode = serde_json::json!({
                    "sample_index": 5,
                    "index": index,
                    "assembly_kind": "mfem_weak_form_shared_domain",
                    "source_mesh_topology_sha256": source_mesh.clone(),
                    "operator_input_signature_sha256": operator_signature.clone(),
                    "phase_constraint_sha256": phase_constraint.clone(),
                    "phi_real": [1.0 + index as f64, 2.0, 3.0],
                    "phi_imag": [0.5, 0.25, 0.125],
                });
                AuxiliaryArtifact {
                    relative_path: format!("eigen/modes/sample_0005/mode_{index:04}.json"),
                    bytes: serde_json::to_vec(&mode).unwrap(),
                }
            })
            .collect::<Vec<_>>();
        let original_mode_bytes = artifacts
            .iter()
            .map(|artifact| artifact.bytes.clone())
            .collect::<Vec<_>>();

        let topology = MeshTopology::from_ir(&plan.mesh).unwrap();
        let (scalar_classes, scalar_class_count_u64, _, _) =
            super::super::super::eigen_shared_domain_geometry::
                modal_shared_domain_equivalence_classes(&topology)
                .unwrap();
        let scalar_class_count = scalar_class_count_u64 as usize;
        let phases = super::super::super::eigen_mass_metric::canonical_shared_domain_phases(
            &topology,
            &plan,
        )
        .unwrap();
        let early_phi = [
            Complex64::new(1.0, 0.5),
            Complex64::new(2.0, 0.25),
            Complex64::new(3.0, 0.125),
        ];
        let early = super::super::super::eigen_physical_potential::physical_potential_artifacts(
            &topology,
            &early_phi,
            scalar_class_count,
            &scalar_classes,
            &phases,
            5,
            0,
            &serde_json::json!({
                "source_mesh_topology_sha256": source_mesh.clone(),
                "operator_input_signature_sha256": operator_signature.clone(),
                "phase_constraint_sha256": phase_constraint.clone(),
            }),
        )
        .unwrap();
        artifacts.extend(early);

        let sample = crate::eigen::KSampleDescriptor {
            sample_index: 5,
            label: Some("X".into()),
            segment_index: Some(0),
            path_s: 1.0,
            t_in_segment: 0.5,
            k_vector: [0.0; 3],
        };
        let selected = BTreeSet::from([
            SampleModeId::new(5, 0),
            SampleModeId::new(5, 1),
        ]);
        let actual_modes = BTreeSet::from([
            SampleModeId::new(5, 0),
            SampleModeId::new(5, 1),
            SampleModeId::new(5, 2),
        ]);
        materialize_selected_path_physical_potential_artifacts(
            &plan,
            &[sample.clone()],
            &actual_modes,
            &selected,
            &mut artifacts,
        )
        .unwrap();

        let physical_manifests = artifacts
            .iter()
            .filter(|artifact| artifact.relative_path.ends_with("physical_potential.v1.json"))
            .collect::<Vec<_>>();
        assert_eq!(physical_manifests.len(), 2);
        assert!(physical_manifests.iter().any(|artifact| artifact
            .relative_path
            .contains("sample_0005/mode_0000/")));
        assert!(physical_manifests.iter().any(|artifact| artifact
            .relative_path
            .contains("sample_0005/mode_0001/")));
        assert!(!artifacts.iter().any(|artifact| artifact.relative_path.contains("mode_0002/")
            && artifact.relative_path.ends_with("physical_potential.v1.json")));
        for (index, original) in original_mode_bytes.iter().enumerate() {
            let path = format!("eigen/modes/sample_0005/mode_{index:04}.json");
            let retained = artifacts
                .iter()
                .find(|artifact| artifact.relative_path == path)
                .expect("all candidate phi certificate JSON remains available");
            assert_eq!(&retained.bytes, original);
            let mode: Value = serde_json::from_slice(&retained.bytes).unwrap();
            assert_eq!(mode["phi_real"].as_array().unwrap().len(), 3);
        }

        let before_empty_selection = artifacts.len();
        materialize_selected_path_physical_potential_artifacts(
            &plan,
            &[sample],
            &actual_modes,
            &BTreeSet::new(),
            &mut artifacts,
        )
        .unwrap();
        assert_eq!(artifacts.len(), before_empty_selection);
        assert!(materialize_selected_path_physical_potential_artifacts(
            &plan,
            &[],
            &actual_modes,
            &BTreeSet::from([SampleModeId::new(6, 1)]),
            &mut artifacts,
        )
        .is_err());
    }
}
