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
                        // Legacy compat: magnetization payload in StepUpdate implies "m".
                        // Also counts as available when a preview_field carries any
                        // matching quantity (not just "m").
                        || live_state
                            .and_then(|s| s.latest_step.magnetization.as_ref())
                            .filter(|_| spec.id == fullmag_quantities::QuantityId::M)
                            .is_some()
                        || live_state
                            .and_then(|state| state.latest_step.preview_field.as_ref())
                            .is_some_and(|field| field.quantity == spec.id.as_str())
                }
                QuantityShape::GlobalScalar => scalar_available(
                    spec.scalar_metric_key
                        .and_then(|metric_key| run_manifest_scalar_value(run, metric_key)),
                ),
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
