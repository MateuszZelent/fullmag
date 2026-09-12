//! Quantity descriptor building and run manifest scalar extraction.

use crate::types::*;
use fullmag_ir::{BackendPlanIR, ExecutionPlanIR};
use fullmag_quantities::{quantity_specs, QuantityShape};
use fullmag_runner::{BackendCapabilities, FemMeshPayload};
use serde_json::Value;

pub(crate) fn build_quantities(
    latest_fields: &LatestFields,
    preview_cache: &CachedPreviewFields,
    live_state: Option<&LiveState>,
    run: Option<&RunManifest>,
    metadata: Option<&Value>,
    scalar_rows: &[ScalarRow],
    _field_location: &str,
) -> Vec<QuantityDescriptor> {
    let dynamic_supported = metadata
        .and_then(|value| value.get("capabilities"))
        .and_then(|value| serde_json::from_value::<BackendCapabilities>(value.clone()).ok())
        .map(|caps| caps.preview_quantities)
        .or_else(|| {
            metadata
                .and_then(|value| value.get("live_preview"))
                .and_then(|value| value.get("supported_quantities"))
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                })
        })
        .unwrap_or_default();
    let execution_plan = metadata
        .and_then(|value| value.get("execution_plan"))
        .and_then(|value| serde_json::from_value::<ExecutionPlanIR>(value.clone()).ok());
    let dynamic_available =
        |quantity_id: &str| dynamic_supported.iter().any(|id| id == quantity_id);
    let scalar_available = |run_value: Option<f64>| {
        !scalar_rows.is_empty() || live_state.is_some() || run_value.is_some()
    };

    quantity_specs()
        .iter()
        .filter(|spec| spec.ui_exposed)
        .map(|spec| {
            let interactive_preview = spec.interactive_preview
                && (dynamic_supported.is_empty() || dynamic_available(spec.id.as_str()));
            let available = match spec.shape {
                QuantityShape::VectorField
                | QuantityShape::TensorField
                | QuantityShape::SpatialScalar => {
                    dynamic_available(spec.id.as_str())
                        || latest_fields.get(spec.id.as_str()).is_some()
                        || preview_cache.get(spec.id.as_str()).is_some()
                        || live_state
                            .and_then(|state| state.latest_step.preview_field.as_ref())
                            .is_some_and(|field| field.quantity == spec.id.as_str())
                        || (spec.id.as_str() == "m"
                            && live_state
                                .and_then(|state| state.latest_step.magnetization.as_ref())
                                .is_some_and(|mag| !mag.is_empty()))
                }
                QuantityShape::GlobalScalar => spec.scalar_metric_key.is_some_and(|metric_key| {
                    scalar_metric_is_active(execution_plan.as_ref(), metric_key)
                        && scalar_available(run_manifest_scalar_value(
                            run,
                            metric_key,
                            execution_plan.as_ref(),
                        ))
                }),
            };

            QuantityDescriptor {
                id: spec.id.as_str().to_string(),
                label: spec.label.to_string(),
                kind: spec.shape.as_api_kind().to_string(),
                unit: spec.unit.to_string(),
                location: spec.location.as_str().to_string(),
                available,
                interactive_preview,
                quick_access_label: spec.quick_access_label.map(str::to_string),
                scalar_metric_key: spec.scalar_metric_key.map(str::to_string),
                n_comp: spec.n_comp,
                domain: spec.domain.as_str().to_string(),
                normalization_hint: spec.normalization_hint.as_str().to_string(),
                supports_preview_2d: spec.supports_preview_2d,
                supports_preview_3d: spec.supports_preview_3d,
                supports_history: spec.supports_history,
                supports_export: spec.supports_export,
            }
        })
        .collect()
}

fn scalar_metric_is_active(plan: Option<&ExecutionPlanIR>, metric_key: &str) -> bool {
    let Some(plan) = plan else {
        // Legacy aggregate columns do not establish a rotated component.
        return metric_key != "e_rotated_dmi";
    };
    match &plan.backend_plan {
        BackendPlanIR::Fdm(plan) => match metric_key {
            "e_ex" => plan.enable_exchange,
            "e_demag" => plan.enable_demag,
            "e_ext" => plan.external_field.is_some(),
            "e_ani" => {
                plan.material.uniaxial_anisotropy_ku1.is_some()
                    || plan.material.uniaxial_anisotropy_ku2.is_some()
                    || plan.material.cubic_anisotropy_kc1.is_some()
                    || plan.material.cubic_anisotropy_kc2.is_some()
                    || plan.material.cubic_anisotropy_kc3.is_some()
            }
            "e_dmi" => {
                plan.interfacial_dmi.is_some()
                    || plan.bulk_dmi.is_some()
                    || plan.rotated_interfacial_dmi.is_some()
            }
            "e_rotated_dmi" => plan.rotated_interfacial_dmi.is_some(),
            "e_total" => true,
            _ => false,
        },
        BackendPlanIR::Fem(plan) => match metric_key {
            "e_ex" => plan.enable_exchange,
            "e_demag" => plan.enable_demag,
            "e_ext" => plan.external_field.is_some(),
            "e_ani" => {
                plan.material.uniaxial_anisotropy.is_some()
                    || plan.material.uniaxial_anisotropy_k2.is_some()
                    || plan.material.cubic_anisotropy_kc1.is_some()
                    || plan.material.cubic_anisotropy_kc2.is_some()
                    || plan.material.cubic_anisotropy_kc3.is_some()
            }
            "e_dmi" => {
                plan.interfacial_dmi.is_some()
                    || plan.bulk_dmi.is_some()
                    || plan.rotated_interfacial_dmi.is_some()
            }
            "e_rotated_dmi" => plan.rotated_interfacial_dmi.is_some(),
            "e_total" => true,
            _ => false,
        },
        BackendPlanIR::FemEigen(plan) => match metric_key {
            "e_ex" => plan.enable_exchange,
            "e_demag" => plan.enable_demag,
            "e_ext" => plan.external_field.is_some(),
            "e_ani" => {
                plan.material.uniaxial_anisotropy.is_some()
                    || plan.material.uniaxial_anisotropy_k2.is_some()
                    || plan.material.cubic_anisotropy_kc1.is_some()
                    || plan.material.cubic_anisotropy_kc2.is_some()
                    || plan.material.cubic_anisotropy_kc3.is_some()
            }
            "e_dmi" => plan.interfacial_dmi.is_some() || plan.bulk_dmi.is_some(),
            "e_rotated_dmi" => false,
            "e_total" => true,
            _ => false,
        },
        BackendPlanIR::FemFrequencyResponse(plan) => match metric_key {
            "e_ex" => plan.enable_exchange,
            "e_demag" => plan.enable_demag,
            "e_ext" => plan.external_field.is_some(),
            "e_ani" => {
                plan.material.uniaxial_anisotropy.is_some()
                    || plan.material.uniaxial_anisotropy_k2.is_some()
                    || plan.material.cubic_anisotropy_kc1.is_some()
                    || plan.material.cubic_anisotropy_kc2.is_some()
                    || plan.material.cubic_anisotropy_kc3.is_some()
            }
            "e_dmi" => plan.interfacial_dmi.is_some() || plan.bulk_dmi.is_some(),
            "e_rotated_dmi" => false,
            "e_total" => true,
            _ => false,
        },
        BackendPlanIR::FdmMultilayer(plan) => match metric_key {
            "e_rotated_dmi" => plan.rotated_interfacial_dmi.is_some(),
            _ => true,
        },
    }
}

pub(crate) fn run_manifest_scalar_value(
    run: Option<&RunManifest>,
    metric_key: &str,
    plan: Option<&ExecutionPlanIR>,
) -> Option<f64> {
    match metric_key {
        "e_ex" => run.and_then(|manifest| manifest.final_e_ex),
        "e_demag" => run.and_then(|manifest| manifest.final_e_demag),
        "e_ext" => run.and_then(|manifest| manifest.final_e_ext),
        "e_ani" => run.and_then(|manifest| manifest.final_e_ani),
        "e_dmi" => run.and_then(|manifest| manifest.final_e_dmi),
        // Completed-run manifests expose the aggregate DMI value only. It is
        // also the exact rotated component for a rotated-only plan; mixed DMI
        // plans remain unavailable until manifests persist component splits.
        "e_rotated_dmi" => plan
            .is_some_and(plan_is_rotated_dmi_only)
            .then(|| run.and_then(|manifest| manifest.final_e_dmi))
            .flatten(),
        "e_total" => run.and_then(|manifest| manifest.final_e_total),
        _ => None,
    }
}

fn plan_is_rotated_dmi_only(plan: &ExecutionPlanIR) -> bool {
    match &plan.backend_plan {
        BackendPlanIR::Fdm(plan) => {
            plan.rotated_interfacial_dmi.is_some()
                && plan.interfacial_dmi.is_none()
                && plan.bulk_dmi.is_none()
                && plan.dind_field.is_none()
                && plan.dbulk_field.is_none()
        }
        BackendPlanIR::Fem(plan) => {
            plan.rotated_interfacial_dmi.is_some()
                && plan.interfacial_dmi.is_none()
                && plan.bulk_dmi.is_none()
                && plan.dind_field.is_none()
                && plan.dbulk_field.is_none()
        }
        BackendPlanIR::FdmMultilayer(plan) => {
            plan.rotated_interfacial_dmi.is_some()
                && plan.interfacial_dmi.is_none()
                && plan.bulk_dmi.is_none()
        }
        BackendPlanIR::FemEigen(_) | BackendPlanIR::FemFrequencyResponse(_) => false,
    }
}

pub(crate) fn extract_fem_mesh_from_metadata(metadata: &Value) -> Option<FemMeshPayload> {
    let execution_plan =
        serde_json::from_value::<ExecutionPlanIR>(metadata.get("execution_plan")?.clone()).ok()?;
    match execution_plan.backend_plan {
        BackendPlanIR::Fem(fem) => Some(FemMeshPayload::from(&fem)),
        BackendPlanIR::FemEigen(fem) => Some(FemMeshPayload::from(&fem)),
        BackendPlanIR::FemFrequencyResponse(fem) => Some(FemMeshPayload::from(&fem)),
        BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{build_quantities, run_manifest_scalar_value, scalar_metric_is_active};
    use crate::types::{CachedPreviewFields, LatestFields, LiveState, RunManifest, StepUpdateView};
    use fullmag_ir::{
        BackendPlanIR, BackendTarget, CommonPlanMeta, ExchangeBoundaryCondition, ExecutionMode,
        ExecutionPlanIR, ExecutionPrecision, FdmLayerPlanIR, FdmMaterialIR, FdmMultilayerPlanIR,
        FdmMultilayerSummaryIR, FdmPlanIR, FdmPrecisionPolicyIR, FemPlanIR, IntegratorChoice,
        OutputPlanIR, ProvenancePlanIR,
    };

    #[test]
    fn magnetization_is_marked_available_from_live_step_magnetization() {
        let live_state = LiveState {
            status: "running".to_string(),
            updated_at_unix_ms: 1,
            latest_step: StepUpdateView {
                step: 1,
                time: 0.0,
                dt: 1.0e-12,
                pseudo_time_s: None,
                e_ex: 0.0,
                e_demag: 0.0,
                e_ext: 0.0,
                e_ani: 0.0,
                e_dmi: 0.0,
                e_rotated_dmi: 0.0,
                e_total: 0.0,
                max_dm_dt: 0.0,
                max_h_eff: 0.0,
                max_h_demag: 0.0,
                max_torque_Apm: 0.0,
                max_torque_T: 0.0,
                max_torque_all_Apm: 0.0,
                frozen_reference_max_drift: 0.0,
                active_dof_count: 0,
                frozen_dof_count: 0,
                free_dof_count: 0,
                wall_time_ns: 0,
                grid: [2, 1, 1],
                fem_mesh_generation_id: None,
                fem_mesh: None,
                magnetization: Some(vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0]),
                per_object_scalars: Default::default(),
                field_materialization_states: Vec::new(),
                preview_field: None,
                finished: false,
            },
        };

        let quantities = build_quantities(
            &LatestFields::default(),
            &CachedPreviewFields::default(),
            Some(&live_state),
            None,
            None,
            &[],
            "node",
        );

        let magnetization = quantities
            .iter()
            .find(|quantity| quantity.id == "m")
            .expect("missing magnetization descriptor");

        assert!(magnetization.available);
        assert!(!quantities
            .iter()
            .any(|quantity| { quantity.id == "E_rotated_dmi" && quantity.available }));
    }

    #[test]
    fn canonical_quantity_catalog_has_no_empty_units() {
        for spec in fullmag_quantities::quantity_specs() {
            assert!(
                !spec.unit.trim().is_empty(),
                "quantity {} unexpectedly has empty unit",
                spec.id.as_str()
            );
        }
    }

    #[test]
    fn scalar_energy_availability_follows_active_fdm_terms() {
        let mut fdm = FdmPlanIR {
            enable_exchange: true,
            enable_demag: false,
            ..FdmPlanIR::default()
        };
        let mut plan = ExecutionPlanIR {
            common: CommonPlanMeta {
                ir_version: "test".to_string(),
                requested_backend: BackendTarget::Fdm,
                resolved_backend: BackendTarget::Fdm,
                execution_mode: ExecutionMode::Strict,
                material_field_plans: Vec::new(),
            },
            backend_plan: BackendPlanIR::Fdm(fdm.clone()),
            output_plan: OutputPlanIR {
                outputs: Vec::new(),
            },
            provenance: ProvenancePlanIR {
                notes: Vec::new(),
                integrator_resolution: None,
                fem_eigen_execution_resolution: None,
                physics_graph: None,
            },
        };

        assert!(scalar_metric_is_active(Some(&plan), "e_ex"));
        assert!(!scalar_metric_is_active(Some(&plan), "e_demag"));
        assert!(!scalar_metric_is_active(Some(&plan), "e_ani"));
        assert!(scalar_metric_is_active(Some(&plan), "e_total"));

        fdm.enable_demag = true;
        fdm.material.uniaxial_anisotropy_ku1 = Some(1.0e5);
        plan.backend_plan = BackendPlanIR::Fdm(fdm);

        assert!(scalar_metric_is_active(Some(&plan), "e_demag"));
        assert!(scalar_metric_is_active(Some(&plan), "e_ani"));

        let mut fem = FemPlanIR::default();
        fem.rotated_interfacial_dmi = Some(3.0e-3);
        plan.backend_plan = BackendPlanIR::Fem(fem);
        assert!(scalar_metric_is_active(Some(&plan), "e_dmi"));
    }

    fn completed_run_plan(backend_plan: BackendPlanIR) -> ExecutionPlanIR {
        let backend = match &backend_plan {
            BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) => BackendTarget::Fdm,
            _ => BackendTarget::Fem,
        };
        ExecutionPlanIR {
            common: CommonPlanMeta {
                ir_version: "test".to_string(),
                requested_backend: backend,
                resolved_backend: backend,
                execution_mode: ExecutionMode::Strict,
                material_field_plans: Vec::new(),
            },
            backend_plan,
            output_plan: OutputPlanIR {
                outputs: Vec::new(),
            },
            provenance: ProvenancePlanIR {
                notes: Vec::new(),
                integrator_resolution: None,
                fem_eigen_execution_resolution: None,
                physics_graph: None,
            },
        }
    }

    fn completed_run_manifest() -> RunManifest {
        serde_json::from_value(serde_json::json!({
            "run_id": "completed-rdmi", "session_id": "test", "status": "completed",
            "total_steps": 10, "final_e_dmi": -2.5e-18, "artifact_dir": "."
        }))
        .unwrap()
    }

    fn completed_multilayer_backend_plan(
        interfacial_dmi: Option<f64>,
        rotated_interfacial_dmi: Option<f64>,
        bulk_dmi: Option<f64>,
    ) -> BackendPlanIR {
        BackendPlanIR::FdmMultilayer(FdmMultilayerPlanIR {
            mode: "three_d".to_string(),
            common_cells: [1, 1, 1],
            requested_common_cell_size: None,
            grid_certificate: None,
            layers: vec![FdmLayerPlanIR {
                magnet_name: "free".to_string(),
                layer_id: "layer:free".to_string(),
                object_id: "free".to_string(),
                native_grid: [1, 1, 1],
                native_cell_size: [1.0; 3],
                native_origin: [0.0; 3],
                native_active_mask: None,
                native_region_mask: None,
                native_region_legend: None,
                initial_magnetization: vec![[1.0, 0.0, 0.0]],
                material: FdmMaterialIR::default(),
                convolution_grid: [1, 1, 1],
                convolution_cell_size: [1.0; 3],
                convolution_origin: [0.0; 3],
                transfer_kind: "identity".to_string(),
            }],
            frozen_spins: None,
            enable_exchange: true,
            enable_demag: false,
            fft: None,
            external_field: None,
            interfacial_dmi,
            rotated_interfacial_dmi,
            bulk_dmi,
            gyromagnetic_ratio: 1.0,
            precision: ExecutionPrecision::Double,
            precision_policy: FdmPrecisionPolicyIR::default(),
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            periodicity: None,
            resolved_periodic_images: None,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(1.0e-13),
            field_refresh: None,
            relaxation: None,
            planner_summary: FdmMultilayerSummaryIR {
                requested_strategy: "multilayer_convolution".to_string(),
                selected_strategy: "multilayer_convolution".to_string(),
                requested_mode: "auto".to_string(),
                resolved_mode: "three_d".to_string(),
                eligibility: "eligible".to_string(),
                estimated_pair_kernels: 1,
                estimated_unique_kernels: 1,
                estimated_kernel_bytes: 0,
                warnings: Vec::new(),
            },
        })
    }

    #[test]
    fn rotated_dmi_completed_run_keeps_scalar_value_and_availability_without_live_rows() {
        let run = completed_run_manifest();
        for backend in [
            BackendPlanIR::Fdm(FdmPlanIR {
                rotated_interfacial_dmi: Some(3.0e-3),
                ..FdmPlanIR::default()
            }),
            BackendPlanIR::Fem(FemPlanIR {
                rotated_interfacial_dmi: Some(3.0e-3),
                ..FemPlanIR::default()
            }),
        ] {
            let plan = completed_run_plan(backend);
            assert_eq!(
                run_manifest_scalar_value(Some(&run), "e_rotated_dmi", Some(&plan)),
                run.final_e_dmi
            );
            let metadata = serde_json::json!({ "execution_plan": plan });
            let quantities = build_quantities(
                &LatestFields::default(),
                &CachedPreviewFields::default(),
                None,
                Some(&run),
                Some(&metadata),
                &[],
                "cell",
            );
            assert!(quantities
                .iter()
                .any(|q| q.id == "E_rotated_dmi" && q.available));
        }
    }

    #[test]
    fn rotated_dmi_multilayer_manifest_value_and_metadata_availability_are_provenance_gated() {
        let run = completed_run_manifest();
        let rotated_plan =
            completed_run_plan(completed_multilayer_backend_plan(None, Some(3.0e-3), None));

        assert!(scalar_metric_is_active(
            Some(&rotated_plan),
            "e_rotated_dmi"
        ));
        assert_eq!(
            run_manifest_scalar_value(Some(&run), "e_rotated_dmi", Some(&rotated_plan)),
            run.final_e_dmi
        );

        let metadata = serde_json::json!({ "execution_plan": rotated_plan });
        let decoded_plan = serde_json::from_value::<ExecutionPlanIR>(
            metadata
                .get("execution_plan")
                .expect("execution plan metadata")
                .clone(),
        )
        .expect("FdmMultilayer execution plan metadata should decode");
        assert_eq!(
            decoded_plan,
            serde_json::from_value(metadata["execution_plan"].clone())
                .expect("serialized FdmMultilayer plan should remain canonical")
        );
        assert!(matches!(
            &decoded_plan.backend_plan,
            BackendPlanIR::FdmMultilayer(plan)
                if plan.rotated_interfacial_dmi == Some(3.0e-3)
                    && plan.interfacial_dmi.is_none()
                    && plan.bulk_dmi.is_none()
        ));

        let quantities = build_quantities(
            &LatestFields::default(),
            &CachedPreviewFields::default(),
            None,
            Some(&run),
            Some(&metadata),
            &[],
            "cell",
        );
        assert!(quantities
            .iter()
            .any(|quantity| quantity.id == "E_rotated_dmi" && quantity.available));

        let conventional_plan =
            completed_run_plan(completed_multilayer_backend_plan(Some(3.0e-3), None, None));
        assert!(!scalar_metric_is_active(
            Some(&conventional_plan),
            "e_rotated_dmi"
        ));
        assert_eq!(
            run_manifest_scalar_value(Some(&run), "e_rotated_dmi", Some(&conventional_plan)),
            None
        );
        let conventional_metadata = serde_json::json!({ "execution_plan": conventional_plan });
        let conventional_quantities = build_quantities(
            &LatestFields::default(),
            &CachedPreviewFields::default(),
            None,
            Some(&run),
            Some(&conventional_metadata),
            &[],
            "cell",
        );
        assert!(!conventional_quantities
            .iter()
            .any(|quantity| quantity.id == "E_rotated_dmi" && quantity.available));
    }

    #[test]
    fn rotated_dmi_manifest_fallback_requires_unambiguous_plan_provenance() {
        let run = completed_run_manifest();
        assert!(!scalar_metric_is_active(None, "e_rotated_dmi"));
        assert!(scalar_metric_is_active(None, "e_dmi"));
        assert_eq!(
            run_manifest_scalar_value(Some(&run), "e_rotated_dmi", None),
            None
        );
        assert_eq!(
            run_manifest_scalar_value(Some(&run), "e_dmi", None),
            run.final_e_dmi
        );
        for fdm in [
            FdmPlanIR::default(),
            FdmPlanIR {
                interfacial_dmi: Some(3.0e-3),
                ..FdmPlanIR::default()
            },
            FdmPlanIR {
                rotated_interfacial_dmi: Some(3.0e-3),
                bulk_dmi: Some(1.0e-3),
                ..FdmPlanIR::default()
            },
            FdmPlanIR {
                rotated_interfacial_dmi: Some(3.0e-3),
                dind_field: Some(vec![1.0e-3]),
                ..FdmPlanIR::default()
            },
        ] {
            let plan = completed_run_plan(BackendPlanIR::Fdm(fdm));
            assert_eq!(
                run_manifest_scalar_value(Some(&run), "e_rotated_dmi", Some(&plan)),
                None
            );
        }
    }
}
