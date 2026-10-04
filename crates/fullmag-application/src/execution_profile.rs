//! Replay immutable execution-profile intent into a pinned request snapshot.

use fullmag_ir::{
    BackendTarget, ComputeResourcePatchIR, ComputeResourcesIR, EXECUTION_REQUEST_SCHEMA,
    ExecutionDevice, ExecutionFieldOriginIR, ExecutionOriginKindIR, ExecutionProfileIR,
    ExecutionRequestIR, ExecutionRequestLayerIR, ExecutionRequestPatchIR, FieldPatch,
    MaterializedExecutionRequestIR,
};
use std::collections::BTreeMap;

const ORIGIN_PATHS: [&str; 16] = [
    "backend",
    "device",
    "precision",
    "mode",
    "resources.target",
    "resources.cpu.threads",
    "resources.cpu.core_policy",
    "resources.cpu.affinity",
    "resources.cpu.numa_node",
    "resources.cpu.native_threads",
    "resources.cpu.blas_threads",
    "resources.gpu",
    "resources.ram.reservation_bytes",
    "resources.scratch.reservation_bytes",
    "resources.parallelism",
    "resources.placement",
];

/// Apply a pinned profile and ordered request layers to product defaults.
pub fn materialize_execution_request(
    profile: Option<ExecutionProfileIR>,
    layers: Vec<ExecutionRequestLayerIR>,
) -> Result<MaterializedExecutionRequestIR, String> {
    validate_layer_order(&layers)?;

    let mut requested = ExecutionRequestIR::default();
    let mut origins = product_default_origins();

    if let Some(profile) = profile.as_ref() {
        profile.validate()?;
        let origin = ExecutionFieldOriginIR {
            kind: ExecutionOriginKindIR::Profile,
            location: format!("profile:{}@{}", profile.profile_id, profile.version),
        };
        apply_request_patch(
            &mut requested,
            &mut origins,
            &profile.defaults,
            &origin,
            false,
        )?;
        requested.validate()?;
    }

    for layer in layers
        .iter()
        .filter(|layer| !matches!(layer.origin.kind, ExecutionOriginKindIR::LegacyEnv))
    {
        validate_layer_origin(&layer.origin)?;
        apply_request_patch(
            &mut requested,
            &mut origins,
            &layer.request,
            &layer.origin,
            layer.origin.kind == ExecutionOriginKindIR::Submit
                || layer.origin.kind == ExecutionOriginKindIR::Cli,
        )?;
    }

    for layer in layers
        .iter()
        .filter(|layer| layer.origin.kind == ExecutionOriginKindIR::LegacyEnv)
    {
        validate_layer_origin(&layer.origin)?;
        apply_legacy_environment(&mut requested, &mut origins, &layer.request, &layer.origin)?;
    }

    requested.validate()?;
    let profile_sha256 = profile
        .as_ref()
        .map(ExecutionProfileIR::canonical_sha256)
        .transpose()?;
    let materialized = MaterializedExecutionRequestIR {
        schema_version: EXECUTION_REQUEST_SCHEMA.to_string(),
        profile,
        profile_sha256,
        layers,
        requested,
        origins,
    };
    materialized.validate_shape()?;
    Ok(materialized)
}

/// Recompute and compare the complete pinned request to detect mutation.
pub fn validate_execution_materialization(
    snapshot: &MaterializedExecutionRequestIR,
) -> Result<(), String> {
    snapshot.validate_shape()?;
    let replayed =
        materialize_execution_request(snapshot.profile.clone(), snapshot.layers.clone())?;
    if &replayed != snapshot {
        return Err("execution_materialization_mismatch: pinned request, digest, or origins do not match replay".into());
    }
    Ok(())
}

fn product_default_origins() -> BTreeMap<String, ExecutionFieldOriginIR> {
    ORIGIN_PATHS
        .into_iter()
        .map(|path| (path.to_string(), ExecutionFieldOriginIR::default()))
        .collect()
}

fn validate_layer_origin(origin: &ExecutionFieldOriginIR) -> Result<(), String> {
    origin.validate()?;
    match origin.kind {
        ExecutionOriginKindIR::Script
        | ExecutionOriginKindIR::Study
        | ExecutionOriginKindIR::Step
        | ExecutionOriginKindIR::Submit
        | ExecutionOriginKindIR::Cli
        | ExecutionOriginKindIR::LegacyEnv => Ok(()),
        ExecutionOriginKindIR::ProductDefault | ExecutionOriginKindIR::Profile => Err(
            "execution_request_layer origin must be script, study, step, submit, cli, or legacy_env".into(),
        ),
    }
}

fn validate_layer_order(layers: &[ExecutionRequestLayerIR]) -> Result<(), String> {
    let mut previous_rank = 0;
    let mut has_non_legacy_layer = false;
    let mut submit_or_cli = None;
    for layer in layers {
        validate_layer_origin(&layer.origin)?;
        let rank = match layer.origin.kind {
            ExecutionOriginKindIR::Script => 0,
            ExecutionOriginKindIR::Study => 1,
            ExecutionOriginKindIR::Step => 2,
            ExecutionOriginKindIR::Submit => 3,
            ExecutionOriginKindIR::Cli => 3,
            ExecutionOriginKindIR::LegacyEnv => {
                continue;
            }
            ExecutionOriginKindIR::ProductDefault | ExecutionOriginKindIR::Profile => {
                unreachable!()
            }
        };
        if has_non_legacy_layer && rank < previous_rank {
            return Err(
                "execution_request_layers must be ordered script, study, step, then submit or cli"
                    .into(),
            );
        }
        if matches!(
            layer.origin.kind,
            ExecutionOriginKindIR::Submit | ExecutionOriginKindIR::Cli
        ) {
            if submit_or_cli.is_some() {
                return Err(
                    "execution_request_layers may contain only one submit or cli layer".into(),
                );
            }
            submit_or_cli = Some(layer.origin.kind);
        }
        previous_rank = rank;
        has_non_legacy_layer = true;
    }
    Ok(())
}

fn apply_request_patch(
    request: &mut ExecutionRequestIR,
    origins: &mut BTreeMap<String, ExecutionFieldOriginIR>,
    patch: &ExecutionRequestPatchIR,
    origin: &ExecutionFieldOriginIR,
    protect_intent: bool,
) -> Result<(), String> {
    apply_intent_patch(request, origins, patch, origin, protect_intent)?;
    if let FieldPatch::Value(resources) = &patch.resources {
        apply_resources_patch(request, origins, resources, origin);
    }
    Ok(())
}

fn apply_intent_patch(
    request: &mut ExecutionRequestIR,
    origins: &mut BTreeMap<String, ExecutionFieldOriginIR>,
    patch: &ExecutionRequestPatchIR,
    origin: &ExecutionFieldOriginIR,
    protect_intent: bool,
) -> Result<(), String> {
    if let FieldPatch::Value(value) = patch.backend {
        check_submit_backend(
            request.backend,
            &origins["backend"],
            value,
            origin,
            protect_intent,
        )?;
        request.backend = value;
        origins.insert("backend".into(), origin.clone());
    }
    if let FieldPatch::Value(value) = patch.device {
        check_submit_device(
            request.device,
            &origins["device"],
            value,
            origin,
            protect_intent,
        )?;
        request.device = value;
        origins.insert("device".into(), origin.clone());
    }
    if let FieldPatch::Value(value) = patch.precision {
        check_submit_exact(
            "precision",
            request.precision,
            &origins["precision"],
            value,
            origin,
            protect_intent,
        )?;
        request.precision = value;
        origins.insert("precision".into(), origin.clone());
    }
    if let FieldPatch::Value(value) = patch.mode {
        check_submit_exact(
            "mode",
            request.mode,
            &origins["mode"],
            value,
            origin,
            protect_intent,
        )?;
        request.mode = value;
        origins.insert("mode".into(), origin.clone());
    }
    Ok(())
}

fn check_submit_backend(
    current: BackendTarget,
    current_origin: &ExecutionFieldOriginIR,
    next: BackendTarget,
    next_origin: &ExecutionFieldOriginIR,
    protected: bool,
) -> Result<(), String> {
    if protected
        && current_origin.kind != ExecutionOriginKindIR::ProductDefault
        && current != BackendTarget::Auto
        && current != next
    {
        return Err(intent_conflict("backend", current_origin, next_origin));
    }
    Ok(())
}

fn check_submit_device(
    current: ExecutionDevice,
    current_origin: &ExecutionFieldOriginIR,
    next: ExecutionDevice,
    next_origin: &ExecutionFieldOriginIR,
    protected: bool,
) -> Result<(), String> {
    if protected
        && current_origin.kind != ExecutionOriginKindIR::ProductDefault
        && current != ExecutionDevice::Auto
        && current != next
    {
        return Err(intent_conflict("device", current_origin, next_origin));
    }
    Ok(())
}

fn check_submit_exact<T: Copy + PartialEq>(
    path: &str,
    current: T,
    current_origin: &ExecutionFieldOriginIR,
    next: T,
    next_origin: &ExecutionFieldOriginIR,
    protected: bool,
) -> Result<(), String> {
    if protected && current_origin.kind != ExecutionOriginKindIR::ProductDefault && current != next
    {
        return Err(intent_conflict(path, current_origin, next_origin));
    }
    Ok(())
}

fn intent_conflict(
    path: &str,
    existing: &ExecutionFieldOriginIR,
    incoming: &ExecutionFieldOriginIR,
) -> String {
    format!(
        "execution_intent_conflict: {path} from {} conflicts with {}",
        existing.location, incoming.location
    )
}

fn apply_resources_patch(
    request: &mut ExecutionRequestIR,
    origins: &mut BTreeMap<String, ExecutionFieldOriginIR>,
    patch: &ComputeResourcePatchIR,
    origin: &ExecutionFieldOriginIR,
) {
    if let FieldPatch::Value(value) = &patch.target {
        request.resources.target = value.clone();
        origins.insert("resources.target".into(), origin.clone());
    }
    if let FieldPatch::Value(cpu) = &patch.cpu {
        apply_cpu_patch(&mut request.resources, origins, cpu, origin);
    }
    if let FieldPatch::Value(value) = &patch.gpu {
        request.resources.gpu = value.clone();
        origins.insert("resources.gpu".into(), origin.clone());
    }
    if let FieldPatch::Value(ram) = &patch.ram {
        if let FieldPatch::Value(value) = ram.reservation_bytes {
            request.resources.ram.reservation_bytes = value;
            origins.insert("resources.ram.reservation_bytes".into(), origin.clone());
        }
    }
    if let FieldPatch::Value(scratch) = &patch.scratch {
        if let FieldPatch::Value(value) = scratch.reservation_bytes {
            request.resources.scratch.reservation_bytes = value;
            origins.insert("resources.scratch.reservation_bytes".into(), origin.clone());
        }
    }
    if let FieldPatch::Value(value) = &patch.parallelism {
        request.resources.parallelism = value.clone();
        origins.insert("resources.parallelism".into(), origin.clone());
    }
    if let FieldPatch::Value(value) = patch.placement {
        request.resources.placement = value;
        origins.insert("resources.placement".into(), origin.clone());
    }
}

fn apply_cpu_patch(
    resources: &mut ComputeResourcesIR,
    origins: &mut BTreeMap<String, ExecutionFieldOriginIR>,
    patch: &fullmag_ir::CpuResourcePatchIR,
    origin: &ExecutionFieldOriginIR,
) {
    if let FieldPatch::Value(value) = patch.threads {
        resources.cpu.threads = value;
        origins.insert("resources.cpu.threads".into(), origin.clone());
    }
    if let FieldPatch::Value(value) = patch.core_policy {
        resources.cpu.core_policy = value;
        origins.insert("resources.cpu.core_policy".into(), origin.clone());
    }
    if let FieldPatch::Value(value) = patch.affinity {
        resources.cpu.affinity = value;
        origins.insert("resources.cpu.affinity".into(), origin.clone());
    }
    if let FieldPatch::Value(value) = patch.numa_node {
        resources.cpu.numa_node = value;
        origins.insert("resources.cpu.numa_node".into(), origin.clone());
    }
    if let FieldPatch::Value(value) = patch.native_threads {
        resources.cpu.native_threads = value;
        origins.insert("resources.cpu.native_threads".into(), origin.clone());
    }
    if let FieldPatch::Value(value) = patch.blas_threads {
        resources.cpu.blas_threads = value;
        origins.insert("resources.cpu.blas_threads".into(), origin.clone());
    }
}

fn apply_legacy_environment(
    request: &mut ExecutionRequestIR,
    origins: &mut BTreeMap<String, ExecutionFieldOriginIR>,
    patch: &ExecutionRequestPatchIR,
    origin: &ExecutionFieldOriginIR,
) -> Result<(), String> {
    let mut candidate = request.clone();
    let mut candidate_origins = origins.clone();
    apply_request_patch(&mut candidate, &mut candidate_origins, patch, origin, false)?;
    for path in ORIGIN_PATHS {
        let old_value = field_value(request, path)?;
        let new_value = field_value(&candidate, path)?;
        if origins[path].kind != ExecutionOriginKindIR::ProductDefault && old_value != new_value {
            return Err(intent_conflict(path, &origins[path], origin));
        }
        if origins[path].kind == ExecutionOriginKindIR::ProductDefault && old_value != new_value {
            set_origin_path(origins, path, origin);
        }
    }
    *request = candidate;
    for path in ORIGIN_PATHS {
        if origins[path].kind == ExecutionOriginKindIR::ProductDefault
            && candidate_origins[path].kind == ExecutionOriginKindIR::LegacyEnv
        {
            origins.insert(path.to_string(), origin.clone());
        }
    }
    Ok(())
}

fn set_origin_path(
    origins: &mut BTreeMap<String, ExecutionFieldOriginIR>,
    path: &str,
    origin: &ExecutionFieldOriginIR,
) {
    origins.insert(path.to_string(), origin.clone());
}

fn field_value(request: &ExecutionRequestIR, path: &str) -> Result<serde_json::Value, String> {
    let value = match path {
        "backend" => serde_json::to_value(request.backend),
        "device" => serde_json::to_value(request.device),
        "precision" => serde_json::to_value(request.precision),
        "mode" => serde_json::to_value(request.mode),
        "resources.target" => serde_json::to_value(&request.resources.target),
        "resources.cpu.threads" => serde_json::to_value(request.resources.cpu.threads),
        "resources.cpu.core_policy" => serde_json::to_value(request.resources.cpu.core_policy),
        "resources.cpu.affinity" => serde_json::to_value(request.resources.cpu.affinity),
        "resources.cpu.numa_node" => serde_json::to_value(request.resources.cpu.numa_node),
        "resources.cpu.native_threads" => {
            serde_json::to_value(request.resources.cpu.native_threads)
        }
        "resources.cpu.blas_threads" => serde_json::to_value(request.resources.cpu.blas_threads),
        "resources.gpu" => serde_json::to_value(&request.resources.gpu),
        "resources.ram.reservation_bytes" => {
            serde_json::to_value(request.resources.ram.reservation_bytes)
        }
        "resources.scratch.reservation_bytes" => {
            serde_json::to_value(request.resources.scratch.reservation_bytes)
        }
        "resources.parallelism" => serde_json::to_value(&request.resources.parallelism),
        "resources.placement" => serde_json::to_value(request.resources.placement),
        _ => return Err(format!("unsupported execution origin path {path}")),
    };
    value.map_err(|error| format!("cannot compare execution field {path}: {error}"))
}
