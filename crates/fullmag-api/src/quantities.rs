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
                QuantityShape::VectorField | QuantityShape::SpatialScalar => {
                    dynamic_available(spec.id.as_str())
                        || latest_fields.get(spec.id.as_str()).is_some()
                        || preview_cache.get(spec.id.as_str()).is_some()
                        || live_state
                            .and_then(|state| state.latest_step.preview_field.as_ref())
                            .is_some_and(|field| field.quantity == spec.id.as_str())
                }
                QuantityShape::GlobalScalar => spec.scalar_metric_key.is_some_and(|metric_key| {
                    scalar_metric_is_active(execution_plan.as_ref(), metric_key)
                        && scalar_available(run_manifest_scalar_value(run, metric_key))
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
        return true;
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
            "e_dmi" => plan.interfacial_dmi.is_some() || plan.bulk_dmi.is_some(),
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
            "e_dmi" => plan.interfacial_dmi.is_some() || plan.bulk_dmi.is_some(),
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
            "e_total" => true,
            _ => false,
        },
        BackendPlanIR::FdmMultilayer(_) => true,
    }
}

pub(crate) fn run_manifest_scalar_value(
    run: Option<&RunManifest>,
    metric_key: &str,
) -> Option<f64> {
    match metric_key {
        "e_ex" => run.and_then(|manifest| manifest.final_e_ex),
        "e_demag" => run.and_then(|manifest| manifest.final_e_demag),
        "e_ext" => run.and_then(|manifest| manifest.final_e_ext),
        "e_ani" => run.and_then(|manifest| manifest.final_e_ani),
        "e_dmi" => run.and_then(|manifest| manifest.final_e_dmi),
        "e_total" => run.and_then(|manifest| manifest.final_e_total),
        _ => None,
    }
}

pub(crate) fn extract_fem_mesh_from_metadata(metadata: &Value) -> Option<FemMeshPayload> {
    let execution_plan =
        serde_json::from_value::<ExecutionPlanIR>(metadata.get("execution_plan")?.clone()).ok()?;
    match execution_plan.backend_plan {
        BackendPlanIR::Fem(fem) => Some(FemMeshPayload::from(&fem)),
        BackendPlanIR::FemEigen(fem) => Some(FemMeshPayload::from(&fem)),
        BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{build_quantities, scalar_metric_is_active};
    use crate::types::{CachedPreviewFields, LatestFields, LiveState, StepUpdateView};
    use fullmag_ir::{
        BackendPlanIR, BackendTarget, CommonPlanMeta, ExecutionMode, ExecutionPlanIR, FdmPlanIR,
        OutputPlanIR, ProvenancePlanIR,
    };

    #[test]
    fn magnetization_is_not_marked_available_from_legacy_inline_field() {
        let live_state = LiveState {
            status: "running".to_string(),
            updated_at_unix_ms: 1,
            latest_step: StepUpdateView {
                step: 1,
                time: 0.0,
                dt: 1.0e-12,
                e_ex: 0.0,
                e_demag: 0.0,
                e_ext: 0.0,
                e_ani: 0.0,
                e_dmi: 0.0,
                e_total: 0.0,
                max_dm_dt: 0.0,
                max_h_eff: 0.0,
                max_h_demag: 0.0,
                max_torque_Apm: 0.0,
                max_torque_T: 0.0,
                wall_time_ns: 0,
                grid: [2, 1, 1],
                fem_mesh: None,
                magnetization: Some(vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0]),
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

        assert!(!magnetization.available);
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
            },
            backend_plan: BackendPlanIR::Fdm(fdm.clone()),
            output_plan: OutputPlanIR {
                outputs: Vec::new(),
            },
            provenance: ProvenancePlanIR { notes: Vec::new() },
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
    }
}
