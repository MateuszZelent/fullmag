use fullmag_ir::{
    BackendPlanIR, BackendTarget, PhysicsGraphModuleProvenanceIR, PhysicsGraphModuleRealizationIR,
    PhysicsGraphRealizationProvenanceIR, PhysicsGraphRealizationStateIR,
    PhysicsGraphRuntimeProvenanceIR, ProblemIR, PHYSICS_GRAPH_REALIZATION_SCHEMA,
    PHYSICS_GRAPH_RUNTIME_PROVENANCE_SCHEMA,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// Backend-neutral result of resolving one authored graph module for a lane.
///
/// The resolver carries semantic scope separately from the family payload.
/// `fem_marker_ids` and `fdm_cell_mask_id` are stable semantic identities; a
/// backend may replace them with realized topology identities only after it
/// validates the corresponding mesh/grid certificate.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ResolvedPhysicsModule {
    pub module_id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
    pub requested_lane: String,
    pub resolved_lane: String,
    pub status: String,
    pub scope_key: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fem_marker_ids: Vec<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fdm_cell_mask_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub source_path: String,
}

/// Validate the optional authored graph before backend-specific lowering.
///
/// An absent graph is accepted for legacy ProblemIR.  A present graph is
/// treated as a source-of-truth contract: malformed identity or an active
/// module with a missing/inactive dependency fails closed.
pub fn resolve_physics_graph(problem: &ProblemIR) -> Result<Option<Value>, Vec<String>> {
    let Some(graph) = problem.physics_graph.as_ref() else {
        return Ok(None);
    };
    let object = graph
        .as_object()
        .ok_or_else(|| vec!["physics_graph must be an object".to_string()])?;
    if object.get("schema_version").and_then(Value::as_str) != Some("physics_graph.v1") {
        return Err(vec![
            "physics_graph.schema_version must be 'physics_graph.v1'".to_string(),
        ]);
    }
    let modules = object
        .get("modules")
        .and_then(Value::as_array)
        .ok_or_else(|| vec!["physics_graph.modules must be an array".to_string()])?;
    let mut statuses = BTreeMap::new();
    let mut errors = Vec::new();
    for (index, module) in modules.iter().enumerate() {
        let Some(module_object) = module.as_object() else {
            errors.push(format!("physics_graph.modules[{index}] must be an object"));
            continue;
        };
        let Some(id) = module_object.get("id").and_then(Value::as_str) else {
            errors.push(format!(
                "physics_graph.modules[{index}].id must be a string"
            ));
            continue;
        };
        if id.trim().is_empty() {
            errors.push(format!(
                "physics_graph.modules[{index}].id must not be empty"
            ));
            continue;
        }
        if statuses.contains_key(id) {
            errors.push(format!("physics_graph contains duplicate module id '{id}'"));
        }
        let activation = module_object
            .get("activation")
            .and_then(Value::as_str)
            .unwrap_or("unsupported");
        statuses.insert(id.to_string(), activation.to_string());
        for field in ["applies_to", "solve_domain", "depends_on"] {
            if !module_object.get(field).is_some_and(Value::is_array) {
                errors.push(format!(
                    "physics_graph.modules[{index}].{field} must be an array"
                ));
            }
        }
        if let Some(dependencies) = module_object.get("depends_on").and_then(Value::as_array) {
            for dependency in dependencies {
                if !dependency.is_string() {
                    errors.push(format!(
                        "physics_graph.modules[{index}].depends_on entries must be strings"
                    ));
                }
            }
        }
    }
    for (index, module) in modules.iter().enumerate() {
        let Some(module_object) = module.as_object() else {
            continue;
        };
        if module_object.get("activation").and_then(Value::as_str) != Some("active") {
            continue;
        }
        let Some(dependencies) = module_object.get("depends_on").and_then(Value::as_array) else {
            continue;
        };
        for dependency in dependencies.iter().filter_map(Value::as_str) {
            match statuses.get(dependency) {
                None => errors.push(format!(
                    "physics_graph.modules[{index}] is active but dependency '{dependency}' is absent"
                )),
                Some(status) if status != "active" && status != "configured" => errors.push(
                    format!(
                        "physics_graph.modules[{index}] is active but dependency '{dependency}' is {status}"
                    ),
                ),
                _ => {}
            }
        }
    }
    let edges = object
        .get("edges")
        .and_then(Value::as_array)
        .ok_or_else(|| vec!["physics_graph.edges must be an array".to_string()])?;
    let module_ids: BTreeSet<&str> = statuses.keys().map(String::as_str).collect();
    for (index, edge) in edges.iter().enumerate() {
        let Some(edge_object) = edge.as_object() else {
            errors.push(format!("physics_graph.edges[{index}] must be an object"));
            continue;
        };
        let source = edge_object.get("source_id").and_then(Value::as_str);
        let target = edge_object.get("target_id").and_then(Value::as_str);
        let status = edge_object.get("status").and_then(Value::as_str);
        if target.is_none_or(|id| !module_ids.contains(id)) {
            errors.push(format!(
                "physics_graph.edges[{index}] target_id is not a module"
            ));
        }
        if status == Some("active") && source.is_none_or(|id| !module_ids.contains(id)) {
            errors.push(format!(
                "physics_graph.edges[{index}] is active but source_id is not a module"
            ));
        }
    }
    if errors.is_empty() {
        Ok(Some(graph.clone()))
    } else {
        Err(errors)
    }
}

pub(crate) fn physics_module_execution_enabled(
    problem: &ProblemIR,
    kind: &str,
    module_id: &str,
) -> Result<Option<bool>, Vec<String>> {
    let Some(graph) = resolve_physics_graph(problem)? else {
        return Ok(None);
    };
    let modules = graph
        .get("modules")
        .and_then(Value::as_array)
        .expect("validated physics graph modules");
    let module = modules.iter().find(|module| {
        module.get("kind").and_then(Value::as_str) == Some(kind)
            && module.get("id").and_then(Value::as_str) == Some(module_id)
    });
    let Some(module) = module else {
        return Err(vec![format!(
            "physics_graph is authoritative but has no {kind} module '{module_id}'"
        )]);
    };
    Ok(Some(matches!(
        module.get("activation").and_then(Value::as_str),
        Some("active" | "configured")
    )))
}

pub(crate) fn physics_module_execution_enabled_at_sources(
    problem: &ProblemIR,
    kind: &str,
    source_paths: &[String],
) -> Result<Option<bool>, Vec<String>> {
    let Some(graph) = resolve_physics_graph(problem)? else {
        return Ok(None);
    };
    let modules = graph
        .get("modules")
        .and_then(Value::as_array)
        .expect("validated physics graph modules");
    let matches = modules
        .iter()
        .filter(|module| {
            module.get("kind").and_then(Value::as_str) == Some(kind)
                && module
                    .get("source_path")
                    .and_then(Value::as_str)
                    .is_some_and(|path| source_paths.iter().any(|candidate| candidate == path))
        })
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(vec![format!(
            "physics_graph is authoritative but {kind} source paths [{}] matched {} modules",
            source_paths.join(", "),
            matches.len()
        )]);
    }
    Ok(Some(matches!(
        matches[0].get("activation").and_then(Value::as_str),
        Some("active" | "configured")
    )))
}

/// Resolve the validated graph into lane-neutral semantic markers.
///
/// This function never infers scope from list position. It is usable before a
/// concrete mesh/grid exists, so the runner can carry module identity and
/// activation state into later topology realization.
pub fn resolve_physics_modules(
    problem: &ProblemIR,
    resolved_lane: BackendTarget,
) -> Result<Vec<ResolvedPhysicsModule>, Vec<String>> {
    let Some(graph) = resolve_physics_graph(problem)? else {
        return Ok(Vec::new());
    };
    let scene_revision = graph
        .get("scene_revision")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let modules = graph
        .get("modules")
        .and_then(Value::as_array)
        .expect("validated physics graph modules");
    let mut resolved = Vec::with_capacity(modules.len());
    for module in modules {
        let module_object = module.as_object().expect("validated physics graph module");
        let module_id = module_object
            .get("id")
            .and_then(Value::as_str)
            .expect("validated physics graph module id")
            .to_string();
        let kind = module_object
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("unsupported")
            .to_string();
        let authored_status = module_object
            .get("activation")
            .and_then(Value::as_str)
            .unwrap_or("unsupported")
            .to_string();
        let depends_on = module_object
            .get("depends_on")
            .and_then(Value::as_array)
            .expect("validated physics graph dependencies")
            .iter()
            .map(|dependency| {
                dependency
                    .as_str()
                    .expect("validated physics graph dependency")
                    .to_string()
            })
            .collect();
        let scope_key = module_scope_key(module_object);
        let requested_lane = requested_lane(module_object, problem);
        let mut status = authored_status.clone();
        let mut reason = None;
        if requested_lane != "auto"
            && requested_lane != resolved_lane.as_str()
            && status == "active"
        {
            status = "unsupported".to_string();
            reason = Some(format!(
                "module requests lane '{requested_lane}' but resolved lane is '{}'",
                resolved_lane.as_str()
            ));
        } else if matches!(
            status.as_str(),
            "blocked" | "inactive" | "unsupported" | "unresolved"
        ) {
            reason = module_object
                .get("family_payload")
                .and_then(Value::as_object)
                .and_then(|payload| payload.get("reason"))
                .and_then(Value::as_str)
                .map(str::to_string);
            if reason.is_none() {
                reason = Some(format!(
                    "activation status '{status}' retained from authored graph"
                ));
            }
        }
        let active = matches!(status.as_str(), "active" | "configured");
        let marker =
            active.then(|| stable_marker_id(&format!("{scene_revision}:{module_id}:{scope_key}")));
        let fdm_cell_mask_id = (active && resolved_lane == BackendTarget::Fdm).then(|| {
            format!(
                "physics-mask.v1:{module_id}:{}",
                scope_key.replace(':', "/")
            )
        });
        resolved.push(ResolvedPhysicsModule {
            module_id,
            kind,
            depends_on,
            requested_lane,
            resolved_lane: resolved_lane.as_str().to_string(),
            status,
            scope_key,
            fem_marker_ids: marker.into_iter().collect(),
            fdm_cell_mask_id,
            reason,
            source_path: module_object
                .get("source_path")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        });
    }
    Ok(resolved)
}

/// Build the typed runtime provenance carried by an execution plan.  The
/// graph is normalized once, while the mesh revision is derived from the
/// resolved backend plan so FEM and FDM cannot accidentally report a shared
/// topology identity.
pub fn physics_graph_runtime_provenance(
    problem: &ProblemIR,
    backend_plan: &BackendPlanIR,
) -> Result<Option<PhysicsGraphRuntimeProvenanceIR>, Vec<String>> {
    let Some(graph) = resolve_physics_graph(problem)? else {
        return Ok(None);
    };
    let resolved_lane = backend_lane(backend_plan);
    let modules = resolve_physics_modules(problem, resolved_lane)?;
    let mesh_revision = mesh_revision(backend_plan)?;
    let graph_sha256 = canonical_graph_sha256(&graph)
        .map_err(|reason| vec![format!("physics_graph runtime provenance: {reason}")])?;
    let typed_modules = modules
        .into_iter()
        .map(|module| {
            Ok(PhysicsGraphModuleProvenanceIR {
                module_id: module.module_id,
                kind: module.kind,
                scope: module.scope_key,
                status: module.status,
                depends_on: module.depends_on,
                requested_lane: parse_backend_lane(&module.requested_lane)?,
                resolved_lane,
                fem_marker_ids: module.fem_marker_ids,
                fdm_cell_mask_id: module.fdm_cell_mask_id,
                reason: module.reason,
                source_path: module.source_path,
            })
        })
        .collect::<Result<Vec<_>, String>>()
        .map_err(|reason| vec![format!("physics_graph runtime provenance: {reason}")])?;
    let scene_revision = graph
        .get("scene_revision")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let realization = physics_graph_realization_provenance(problem, backend_plan, &[])?;
    Ok(Some(PhysicsGraphRuntimeProvenanceIR {
        schema_version: PHYSICS_GRAPH_RUNTIME_PROVENANCE_SCHEMA.to_string(),
        graph_sha256,
        scene_revision,
        mesh_revision,
        requested_lane: problem.backend_policy.requested_backend,
        resolved_lane,
        modules: typed_modules,
        realization,
    }))
}

/// Resolve graph scopes against the concrete FEM mesh or FDM grid carried by a
/// backend plan.  The function is intentionally independent of solver
/// execution: `executed_module_ids` must come from an observed runtime record,
/// while an empty slice is the planner's honest "resolved, not executed"
/// state.
pub fn physics_graph_realization_provenance(
    problem: &ProblemIR,
    backend_plan: &BackendPlanIR,
    executed_module_ids: &[String],
) -> Result<Option<PhysicsGraphRealizationProvenanceIR>, Vec<String>> {
    let Some(_graph) = resolve_physics_graph(problem)? else {
        return Ok(None);
    };
    let resolved_lane = backend_lane(backend_plan);
    let modules = resolve_physics_modules(problem, resolved_lane)?;
    let known_module_ids = modules
        .iter()
        .map(|module| module.module_id.as_str())
        .collect::<BTreeSet<_>>();
    let unknown_executed = executed_module_ids
        .iter()
        .filter(|module_id| !known_module_ids.contains(module_id.as_str()))
        .map(|module_id| module_id.as_str())
        .collect::<Vec<_>>();
    if !unknown_executed.is_empty() {
        return Err(vec![format!(
            "physics_graph realization contains execution observations for unknown module IDs: {}",
            unknown_executed.join(", ")
        )]);
    }
    let executed = executed_module_ids.iter().collect::<BTreeSet<_>>();
    let (topology_fingerprint, realizations) = match backend_plan {
        BackendPlanIR::Fem(plan) => (
            plan.mesh.topology_fingerprint_v6(),
            realize_fem_modules(plan, &modules, &executed),
        ),
        BackendPlanIR::FemEigen(plan) => (
            plan.mesh.topology_fingerprint_v6(),
            realize_fem_modules_for_eigen(plan, &modules, &executed),
        ),
        BackendPlanIR::FemFrequencyResponse(plan) => (
            plan.mesh.topology_fingerprint_v6(),
            realize_fem_modules_for_frequency(plan, &modules, &executed),
        ),
        BackendPlanIR::Fdm(plan) => (
            plan.grid_certificate
                .as_ref()
                .map(|certificate| certificate.grid_fingerprint.clone())
                .unwrap_or_else(|| "unavailable".to_string()),
            realize_fdm_modules(plan, &modules, &executed),
        ),
        BackendPlanIR::FdmMultilayer(plan) => (
            plan.grid_certificate
                .as_ref()
                .map(|certificate| certificate.grid_fingerprint.clone())
                .unwrap_or_else(|| "unavailable".to_string()),
            realize_fdm_multilayer_modules(plan, &modules, &executed),
        ),
    };
    let realizations = realizations.map_err(|reasons| {
        reasons
            .into_iter()
            .map(|reason| format!("physics_graph realization: {reason}"))
            .collect::<Vec<_>>()
    })?;
    let resolved_module_ids = realizations
        .iter()
        .filter(|module| module.state != PhysicsGraphRealizationStateIR::SemanticOnly)
        .map(|module| module.module_id.clone())
        .collect::<Vec<_>>();
    let executed_module_ids = realizations
        .iter()
        .filter(|module| module.state == PhysicsGraphRealizationStateIR::Executed)
        .map(|module| module.module_id.clone())
        .collect::<Vec<_>>();
    Ok(Some(PhysicsGraphRealizationProvenanceIR {
        schema_version: PHYSICS_GRAPH_REALIZATION_SCHEMA.to_string(),
        topology_fingerprint,
        resolved_module_ids,
        executed_module_ids,
        modules: realizations,
    }))
}

fn realization_state(
    module: &ResolvedPhysicsModule,
    executed: &BTreeSet<&String>,
    resolved: bool,
) -> PhysicsGraphRealizationStateIR {
    if !resolved {
        PhysicsGraphRealizationStateIR::SemanticOnly
    } else if executed.contains(&module.module_id) {
        PhysicsGraphRealizationStateIR::Executed
    } else {
        PhysicsGraphRealizationStateIR::Resolved
    }
}

fn semantic_only_realization(
    module: &ResolvedPhysicsModule,
    topology_fingerprint: &str,
    reason: impl Into<String>,
) -> PhysicsGraphModuleRealizationIR {
    PhysicsGraphModuleRealizationIR {
        module_id: module.module_id.clone(),
        state: PhysicsGraphRealizationStateIR::SemanticOnly,
        topology_fingerprint: topology_fingerprint.to_string(),
        realized_fem_marker_ids: Vec::new(),
        realized_fdm_mask_digest: None,
        realized_cell_count: 0,
        realized_fdm_region_ids: Vec::new(),
        reason: Some(reason.into()),
    }
}

fn realize_fem_modules(
    plan: &fullmag_ir::FemPlanIR,
    modules: &[ResolvedPhysicsModule],
    executed: &BTreeSet<&String>,
) -> Result<Vec<PhysicsGraphModuleRealizationIR>, Vec<String>> {
    realize_fem_modules_from_parts(
        &plan.mesh,
        &plan.object_segments,
        &plan.mesh_parts,
        modules,
        executed,
    )
}

fn realize_fem_modules_for_eigen(
    plan: &fullmag_ir::FemEigenPlanIR,
    modules: &[ResolvedPhysicsModule],
    executed: &BTreeSet<&String>,
) -> Result<Vec<PhysicsGraphModuleRealizationIR>, Vec<String>> {
    realize_fem_modules_from_parts(
        &plan.mesh,
        &plan.object_segments,
        &plan.mesh_parts,
        modules,
        executed,
    )
}

fn realize_fem_modules_for_frequency(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
    modules: &[ResolvedPhysicsModule],
    executed: &BTreeSet<&String>,
) -> Result<Vec<PhysicsGraphModuleRealizationIR>, Vec<String>> {
    realize_fem_modules_from_parts(
        &plan.mesh,
        &plan.object_segments,
        &plan.mesh_parts,
        modules,
        executed,
    )
}

fn realize_fem_modules_from_parts(
    mesh: &fullmag_ir::MeshIR,
    object_segments: &[fullmag_ir::FemObjectSegmentIR],
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
    modules: &[ResolvedPhysicsModule],
    executed: &BTreeSet<&String>,
) -> Result<Vec<PhysicsGraphModuleRealizationIR>, Vec<String>> {
    let topology_fingerprint = mesh.topology_fingerprint_v6();
    let mut realized = Vec::with_capacity(modules.len());
    for module in modules {
        if !matches!(module.status.as_str(), "active" | "configured") {
            realized.push(semantic_only_realization(
                module,
                &topology_fingerprint,
                format!("module status '{}' is not executable", module.status),
            ));
            continue;
        }
        match fem_scope_markers(mesh, object_segments, mesh_parts, &module.scope_key) {
            Ok((markers, cell_count)) if cell_count > 0 => {
                realized.push(PhysicsGraphModuleRealizationIR {
                    module_id: module.module_id.clone(),
                    state: realization_state(module, executed, true),
                    topology_fingerprint: topology_fingerprint.clone(),
                    realized_fem_marker_ids: markers,
                    realized_fdm_mask_digest: None,
                    realized_cell_count: cell_count,
                    realized_fdm_region_ids: Vec::new(),
                    reason: None,
                });
            }
            Ok((_markers, _cell_count)) => realized.push(semantic_only_realization(
                module,
                &topology_fingerprint,
                "module scope resolves to zero FEM elements",
            )),
            Err(reason) => realized.push(semantic_only_realization(
                module,
                &topology_fingerprint,
                reason,
            )),
        }
    }
    Ok(realized)
}

fn fem_scope_markers(
    mesh: &fullmag_ir::MeshIR,
    object_segments: &[fullmag_ir::FemObjectSegmentIR],
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
    scope: &str,
) -> Result<(Vec<u32>, u64), String> {
    if mesh.element_markers.len() != mesh.cell_count() {
        return Err("FEM element marker count differs from cell count".to_string());
    }
    let mut selected_elements = BTreeSet::new();
    match parse_scope(scope)? {
        ParsedScope::Global => {
            selected_elements.extend(0..mesh.cell_count());
        }
        ParsedScope::Objects(objects) => {
            for object in objects {
                let before = selected_elements.len();
                for segment in object_segments
                    .iter()
                    .filter(|segment| segment.object_id == object)
                {
                    add_element_range(
                        &mut selected_elements,
                        segment.element_start,
                        segment.element_count,
                        mesh.cell_count(),
                    )?;
                }
                if selected_elements.len() == before {
                    for part in mesh_parts
                        .iter()
                        .filter(|part| part.object_id.as_deref() == Some(object.as_str()))
                    {
                        add_selector_elements(
                            &mut selected_elements,
                            &part.element_selector,
                            mesh,
                        )?;
                    }
                }
                if selected_elements.len() == before {
                    return Err(format!(
                        "FEM object scope '{}' has no realized mesh elements",
                        object
                    ));
                }
            }
        }
        ParsedScope::Region { object, region } => {
            let mut matched = false;
            for segment in object_segments.iter().filter(|segment| {
                segment.object_id == object
                    && segment.geometry_id.as_deref() == Some(region.as_str())
            }) {
                matched = true;
                add_element_range(
                    &mut selected_elements,
                    segment.element_start,
                    segment.element_count,
                    mesh.cell_count(),
                )?;
            }
            for part in mesh_parts.iter().filter(|part| {
                part.object_id.as_deref() == Some(object.as_str())
                    && part.geometry_id.as_deref() == Some(region.as_str())
            }) {
                matched = true;
                add_selector_elements(&mut selected_elements, &part.element_selector, mesh)?;
            }
            if !matched {
                return Err(format!(
                    "FEM region scope '{}:{}' has no concrete geometry/mesh-part identity",
                    object, region
                ));
            }
        }
        ParsedScope::Unresolved => return Err("graph scope is unresolved".to_string()),
    }
    let markers = selected_elements
        .iter()
        .map(|index| mesh.element_markers[*index])
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    Ok((markers, selected_elements.len() as u64))
}

fn add_element_range(
    selected: &mut BTreeSet<usize>,
    start: u32,
    count: u32,
    element_count: usize,
) -> Result<(), String> {
    let start = usize::try_from(start).map_err(|_| "FEM element range start overflows usize")?;
    let count = usize::try_from(count).map_err(|_| "FEM element range count overflows usize")?;
    let end = start
        .checked_add(count)
        .ok_or_else(|| "FEM element range overflows usize".to_string())?;
    if end > element_count {
        return Err(format!(
            "FEM element range [{start}, {end}) exceeds element count {element_count}"
        ));
    }
    selected.extend(start..end);
    Ok(())
}

fn add_selector_elements(
    selected: &mut BTreeSet<usize>,
    selector: &fullmag_ir::FemMeshPartSelector,
    mesh: &fullmag_ir::MeshIR,
) -> Result<(), String> {
    match selector {
        fullmag_ir::FemMeshPartSelector::ElementMarkerSet { markers } => {
            let marker_set = markers.iter().copied().collect::<BTreeSet<_>>();
            for (index, marker) in mesh.element_markers.iter().copied().enumerate() {
                if marker_set.contains(&marker) {
                    selected.insert(index);
                }
            }
            Ok(())
        }
        fullmag_ir::FemMeshPartSelector::ElementRange { start, count } => {
            add_element_range(selected, *start, *count, mesh.cell_count())
        }
        other => Err(format!(
            "FEM mesh part selector {other:?} is not an element selector"
        )),
    }
}

fn realize_fdm_modules(
    plan: &fullmag_ir::FdmPlanIR,
    modules: &[ResolvedPhysicsModule],
    executed: &BTreeSet<&String>,
) -> Result<Vec<PhysicsGraphModuleRealizationIR>, Vec<String>> {
    let Some(certificate) = plan.grid_certificate.as_ref() else {
        return Ok(modules
            .iter()
            .map(|module| {
                semantic_only_realization(
                    module,
                    "unavailable",
                    "FDM plan has no resolved grid certificate",
                )
            })
            .collect());
    };
    let total_cells = plan
        .grid
        .cells
        .iter()
        .try_fold(1usize, |product, count| {
            product.checked_mul(usize::try_from(*count).ok()?)
        })
        .ok_or_else(|| vec!["FDM grid cell count overflows usize".to_string()])?;
    if plan.region_mask.len() != total_cells
        || plan
            .active_mask
            .as_ref()
            .is_some_and(|mask| mask.len() != total_cells)
    {
        return Err(vec![
            "FDM graph realization requires region_mask/active_mask lengths to match the grid"
                .to_string(),
        ]);
    }
    certificate
        .validate_against_masks(plan.active_mask.as_deref(), &plan.region_mask)
        .map_err(|reason| vec![format!("invalid FDM grid certificate: {reason}")])?;
    let mut realized = Vec::with_capacity(modules.len());
    for module in modules {
        if !matches!(module.status.as_str(), "active" | "configured") {
            realized.push(semantic_only_realization(
                module,
                &certificate.grid_fingerprint,
                format!("module status '{}' is not executable", module.status),
            ));
            continue;
        }
        match fdm_scope_mask(plan, certificate, &module.scope_key) {
            Ok((mask, region_ids)) => {
                let cell_count = mask.iter().filter(|selected| **selected).count() as u64;
                if cell_count == 0 {
                    realized.push(semantic_only_realization(
                        module,
                        &certificate.grid_fingerprint,
                        "module scope resolves to zero active FDM cells",
                    ));
                    continue;
                }
                let digest = fdm_mask_digest(certificate, &mask, &region_ids);
                realized.push(PhysicsGraphModuleRealizationIR {
                    module_id: module.module_id.clone(),
                    state: realization_state(module, executed, true),
                    topology_fingerprint: certificate.grid_fingerprint.clone(),
                    realized_fem_marker_ids: Vec::new(),
                    realized_fdm_mask_digest: Some(digest),
                    realized_cell_count: cell_count,
                    realized_fdm_region_ids: region_ids,
                    reason: None,
                });
            }
            Err(reason) => realized.push(semantic_only_realization(
                module,
                &certificate.grid_fingerprint,
                reason,
            )),
        }
    }
    Ok(realized)
}

fn realize_fdm_multilayer_modules(
    plan: &fullmag_ir::FdmMultilayerPlanIR,
    modules: &[ResolvedPhysicsModule],
    executed: &BTreeSet<&String>,
) -> Result<Vec<PhysicsGraphModuleRealizationIR>, Vec<String>> {
    let Some(certificate) = plan.grid_certificate.as_ref() else {
        return Ok(modules
            .iter()
            .map(|module| {
                semantic_only_realization(
                    module,
                    "unavailable",
                    "FDM multilayer plan has no resolved grid certificate",
                )
            })
            .collect());
    };
    let topology = certificate.grid_fingerprint.clone();
    let mut realized = Vec::with_capacity(modules.len());
    for module in modules {
        if !matches!(module.status.as_str(), "active" | "configured") {
            realized.push(semantic_only_realization(
                module,
                &topology,
                format!("module status '{}' is not executable", module.status),
            ));
            continue;
        }
        if module.scope_key != "global" {
            realized.push(semantic_only_realization(
                module,
                &topology,
                "FDM multilayer topology has no unambiguous object/region mask identity",
            ));
            continue;
        }
        let Ok(mask) = multilayer_global_mask(plan) else {
            realized.push(semantic_only_realization(
                module,
                &topology,
                "FDM multilayer global scope has no unambiguous common-grid cell mask",
            ));
            continue;
        };
        let cell_count = mask.iter().filter(|selected| **selected).count() as u64;
        if cell_count == 0 {
            realized.push(semantic_only_realization(
                module,
                &topology,
                "multilayer common-grid mask has no active cells",
            ));
            continue;
        }
        let digest = fdm_mask_digest(certificate, &mask, &[]);
        realized.push(PhysicsGraphModuleRealizationIR {
            module_id: module.module_id.clone(),
            state: realization_state(module, executed, true),
            topology_fingerprint: topology.clone(),
            realized_fem_marker_ids: Vec::new(),
            realized_fdm_mask_digest: Some(digest),
            realized_cell_count: cell_count,
            realized_fdm_region_ids: Vec::new(),
            reason: None,
        });
    }
    Ok(realized)
}

/// Return a concrete mask for the common convolution grid only when every
/// layer is already aligned with that grid.  A push/pull transfer, a shifted
/// origin, or a malformed layer mask would require a separate mapping
/// certificate; silently treating the whole common grid as active would make
/// graph provenance claim a topology that the runtime has not materialized.
fn multilayer_global_mask(plan: &fullmag_ir::FdmMultilayerPlanIR) -> Result<Vec<bool>, String> {
    let total_cells = plan
        .common_cells
        .iter()
        .try_fold(1usize, |product, count| {
            product
                .checked_mul(*count as usize)
                .ok_or_else(|| "common-grid cell count overflows usize".to_string())
        })?;
    let first_origin = plan
        .layers
        .first()
        .map(|layer| layer.native_origin)
        .ok_or_else(|| "multilayer plan has no layers".to_string())?;
    let mut mask = vec![false; total_cells];
    for layer in &plan.layers {
        if layer.transfer_kind != "identity"
            || layer.native_grid != plan.common_cells
            || layer.native_origin != first_origin
            || layer.convolution_origin != first_origin
        {
            return Err("layer is not aligned with the common identity grid".to_string());
        }
        let layer_mask = match layer.native_active_mask.as_deref() {
            Some(layer_mask) if layer_mask.len() == total_cells => layer_mask,
            Some(_) => return Err("layer active mask length differs from common grid".to_string()),
            None => {
                for selected in &mut mask {
                    *selected = true;
                }
                continue;
            }
        };
        for (selected, layer_selected) in mask.iter_mut().zip(layer_mask) {
            *selected |= *layer_selected;
        }
    }
    Ok(mask)
}

fn fdm_scope_mask(
    plan: &fullmag_ir::FdmPlanIR,
    certificate: &fullmag_ir::FdmGridCertificateIR,
    scope: &str,
) -> Result<(Vec<bool>, Vec<u32>), String> {
    let total_cells = plan.region_mask.len();
    let region_ids = plan.region_mask.iter().copied().collect::<BTreeSet<_>>();
    let selected_region_ids = match parse_scope(scope)? {
        ParsedScope::Global => region_ids,
        ParsedScope::Objects(objects) => {
            let mut selected = BTreeSet::new();
            for object in objects {
                let matches = certificate
                    .region_legend
                    .iter()
                    .filter(|entry| entry.object_id == object)
                    .map(|entry| entry.numeric_id)
                    .collect::<BTreeSet<_>>();
                if matches.is_empty()
                    && certificate.region_legend.is_empty()
                    && certificate
                        .object_ids
                        .iter()
                        .any(|candidate| candidate == &object)
                {
                    selected.extend(region_ids.iter().copied());
                } else if matches.is_empty() {
                    return Err(format!(
                        "FDM object scope '{}' has no region-legend identity",
                        object
                    ));
                } else {
                    selected.extend(matches);
                }
            }
            selected
        }
        ParsedScope::Region { object, region } => {
            let matches = certificate
                .region_legend
                .iter()
                .filter(|entry| entry.object_id == object && entry.region_id == region)
                .map(|entry| entry.numeric_id)
                .collect::<BTreeSet<_>>();
            if matches.is_empty() {
                return Err(format!(
                    "FDM region scope '{}:{}' has no region-legend identity",
                    object, region
                ));
            }
            matches
        }
        ParsedScope::Unresolved => return Err("graph scope is unresolved".to_string()),
    };
    let active = plan
        .active_mask
        .as_deref()
        .map_or_else(|| vec![true; total_cells], ToOwned::to_owned);
    let mask = plan
        .region_mask
        .iter()
        .copied()
        .zip(active)
        .map(|(region, active)| active && selected_region_ids.contains(&region))
        .collect::<Vec<_>>();
    Ok((mask, selected_region_ids.into_iter().collect::<Vec<_>>()))
}

fn fdm_mask_digest(
    certificate: &fullmag_ir::FdmGridCertificateIR,
    selected_cells: &[bool],
    region_ids: &[u32],
) -> String {
    let payload = serde_json::json!({
        "schema_version": PHYSICS_GRAPH_REALIZATION_SCHEMA,
        "grid_fingerprint": certificate.grid_fingerprint,
        "region_legend_fingerprint": certificate.region_legend_fingerprint,
        "selected_cells": selected_cells,
        "region_ids": region_ids,
    });
    let bytes = serde_json::to_vec(&payload).expect("FDM graph mask digest payload serializes");
    format!("sha256:{:x}", Sha256::digest(bytes))
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ParsedScope {
    Global,
    Objects(Vec<String>),
    Region { object: String, region: String },
    Unresolved,
}

fn parse_scope(scope: &str) -> Result<ParsedScope, String> {
    if scope == "global" {
        return Ok(ParsedScope::Global);
    }
    if let Some(object) = scope.strip_prefix("object:") {
        if object.is_empty() || object == "unresolved" {
            return Ok(ParsedScope::Unresolved);
        }
        return Ok(ParsedScope::Objects(vec![object.to_string()]));
    }
    if let Some(objects) = scope.strip_prefix("cross_object:") {
        if objects.is_empty() || objects == "unresolved" {
            return Ok(ParsedScope::Unresolved);
        }
        return Ok(ParsedScope::Objects(
            objects.split(',').map(str::to_string).collect(),
        ));
    }
    if let Some(region) = scope.strip_prefix("region:") {
        let mut parts = region.splitn(2, ':');
        let object = parts.next().unwrap_or_default();
        let region = parts.next().unwrap_or_default();
        if object.is_empty()
            || region.is_empty()
            || object == "unresolved"
            || region == "unresolved"
        {
            return Ok(ParsedScope::Unresolved);
        }
        return Ok(ParsedScope::Region {
            object: object.to_string(),
            region: region.to_string(),
        });
    }
    Ok(ParsedScope::Unresolved)
}

/// Return the digest used to bind a runtime plan to the exact normalized graph
/// that produced it.  `serde_json` uses the workspace's deterministic object
/// ordering and compact encoding, matching the Python qualification verifier.
pub fn physics_graph_sha256(problem: &ProblemIR) -> Result<Option<String>, Vec<String>> {
    let Some(graph) = resolve_physics_graph(problem)? else {
        return Ok(None);
    };
    canonical_graph_sha256(&graph)
        .map(Some)
        .map_err(|reason| vec![format!("physics_graph digest: {reason}")])
}

fn canonical_graph_sha256(graph: &Value) -> Result<String, String> {
    let bytes = serde_json::to_vec(graph)
        .map_err(|error| format!("cannot serialize normalized graph: {error}"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn backend_lane(backend_plan: &BackendPlanIR) -> BackendTarget {
    match backend_plan {
        BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) => BackendTarget::Fdm,
        BackendPlanIR::Fem(_)
        | BackendPlanIR::FemEigen(_)
        | BackendPlanIR::FemFrequencyResponse(_) => BackendTarget::Fem,
    }
}

fn parse_backend_lane(value: &str) -> Result<BackendTarget, String> {
    match value {
        "auto" => Ok(BackendTarget::Auto),
        "fdm" => Ok(BackendTarget::Fdm),
        "fem" => Ok(BackendTarget::Fem),
        "hybrid" => Ok(BackendTarget::Hybrid),
        other => Err(format!("unknown execution lane '{other}'")),
    }
}

fn mesh_revision(backend_plan: &BackendPlanIR) -> Result<u64, Vec<String>> {
    let value = match backend_plan {
        BackendPlanIR::Fdm(plan) => serde_json::json!({
            "backend": "fdm",
            "origin_m": plan.origin_m,
            "grid": plan.grid,
            "cell_size": plan.cell_size,
            "region_mask": plan.region_mask,
            "active_mask": plan.active_mask,
            "grid_fingerprint": plan.grid_certificate.as_ref().map(|certificate| &certificate.grid_fingerprint),
        }),
        BackendPlanIR::FdmMultilayer(plan) => serde_json::json!({
            "backend": "fdm_multilayer",
            "common_cells": plan.common_cells,
            "grid_fingerprint": plan.grid_certificate.as_ref().map(|certificate| &certificate.grid_fingerprint),
            "topology_tokens": fullmag_ir::fdm_multilayer_topology_tokens(&plan.mode, &plan.layers),
        }),
        BackendPlanIR::Fem(plan) => serde_json::json!({
            "backend": "fem",
            "mesh": plan.mesh,
        }),
        BackendPlanIR::FemEigen(plan) => serde_json::json!({
            "backend": "fem_eigen",
            "mesh": plan.mesh,
        }),
        BackendPlanIR::FemFrequencyResponse(plan) => serde_json::json!({
            "backend": "fem_frequency_response",
            "mesh": plan.mesh,
        }),
    };
    let bytes = serde_json::to_vec(&value)
        .map_err(|error| vec![format!("cannot serialize mesh revision payload: {error}")])?;
    let digest = Sha256::digest(bytes);
    Ok(u64::from_be_bytes([
        digest[0], digest[1], digest[2], digest[3], digest[4], digest[5], digest[6], digest[7],
    ]))
}

/// Convert the resolved graph into compact, stable plan provenance notes.
///
/// `ProvenancePlanIR` predates the graph contract and remains source-compatible;
/// notes provide a backwards-compatible bridge until the next typed
/// provenance schema revision.
pub fn physics_graph_provenance_notes(
    problem: &ProblemIR,
    resolved_lane: BackendTarget,
) -> Result<Vec<String>, Vec<String>> {
    let Some(graph) = resolve_physics_graph(problem)? else {
        return Ok(Vec::new());
    };
    let scene_revision = graph
        .get("scene_revision")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let modules = resolve_physics_modules(problem, resolved_lane)?;
    Ok(modules
        .into_iter()
        .map(|module| {
            format!(
                "physics_graph.v1 scene_revision={scene_revision} module_id={} kind={} activation={} scope={} requested_lane={} resolved_lane={}{}",
                module.module_id,
                module.kind,
                module.status,
                module.scope_key,
                module.requested_lane,
                module.resolved_lane,
                module
                    .reason
                    .as_deref()
                    .map(|reason| format!(" reason={reason}"))
                    .unwrap_or_default(),
            )
        })
        .collect())
}

fn requested_lane(module: &serde_json::Map<String, Value>, problem: &ProblemIR) -> String {
    module
        .get("family_payload")
        .and_then(Value::as_object)
        .and_then(|payload| payload.get("requested_execution"))
        .and_then(Value::as_object)
        .and_then(|execution| execution.get("discretization"))
        .and_then(Value::as_str)
        .unwrap_or_else(|| problem.backend_policy.requested_backend.as_str())
        .to_string()
}

fn module_scope_key(module: &serde_json::Map<String, Value>) -> String {
    let Some(scopes) = module.get("applies_to").and_then(Value::as_array) else {
        return "unresolved".to_string();
    };
    if scopes.is_empty() {
        return "global".to_string();
    }
    let mut keys = scopes.iter().map(scope_key).collect::<Vec<_>>();
    keys.sort();
    keys.dedup();
    keys.join("+")
}

fn scope_key(scope: &Value) -> String {
    let Some(scope) = scope.as_object() else {
        return "unresolved".to_string();
    };
    match scope.get("kind").and_then(Value::as_str) {
        Some("global") => "global".to_string(),
        Some("object") => format!(
            "object:{}",
            scope
                .get("object_id")
                .and_then(Value::as_str)
                .unwrap_or("unresolved")
        ),
        Some("region") => format!(
            "region:{}:{}",
            scope
                .get("object_id")
                .and_then(Value::as_str)
                .unwrap_or("unresolved"),
            scope
                .get("region_id")
                .and_then(Value::as_str)
                .unwrap_or("unresolved")
        ),
        Some("cross_object") => {
            let mut ids = scope
                .get("object_ids")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>();
            ids.sort_unstable();
            format!("cross_object:{}", ids.join(","))
        }
        Some(kind) => format!(
            "{kind}:{}",
            serde_json::to_string(scope).unwrap_or_default()
        ),
        None => "unresolved".to_string(),
    }
}

fn stable_marker_id(value: &str) -> u32 {
    let digest = Sha256::digest(value.as_bytes());
    u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layer(
        transfer_kind: &str,
        origin: [f64; 3],
        active_mask: Option<Vec<bool>>,
    ) -> fullmag_ir::FdmLayerPlanIR {
        fullmag_ir::FdmLayerPlanIR {
            magnet_name: "layer".to_string(),
            layer_id: "layer:layer".to_string(),
            object_id: "layer".to_string(),
            native_grid: [2, 1, 1],
            native_cell_size: [1.0, 1.0, 1.0],
            native_origin: origin,
            native_active_mask: active_mask,
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 2],
            material: fullmag_ir::FdmMaterialIR::default(),
            convolution_grid: [2, 1, 1],
            convolution_cell_size: [1.0, 1.0, 1.0],
            convolution_origin: origin,
            transfer_kind: transfer_kind.to_string(),
        }
    }

    fn multilayer_plan(layers: Vec<fullmag_ir::FdmLayerPlanIR>) -> fullmag_ir::FdmMultilayerPlanIR {
        let topology_tokens = fullmag_ir::fdm_multilayer_topology_tokens("two_d_stack", &layers);
        let certificate = fullmag_ir::FdmGridCertificateIR::new_with_topology_tokens(
            [0.0; 3],
            [2, 1, 1],
            [1.0; 3],
            2,
            1,
            None,
            &topology_tokens,
        )
        .expect("test certificate");
        fullmag_ir::FdmMultilayerPlanIR {
            mode: "two_d_stack".to_string(),
            common_cells: [2, 1, 1],
            requested_common_cell_size: None,
            grid_certificate: Some(certificate),
            layers,
            enable_exchange: false,
            enable_demag: false,
            external_field: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            gyromagnetic_ratio: 1.0,
            precision: fullmag_ir::ExecutionPrecision::Double,
            exchange_bc: fullmag_ir::ExchangeBoundaryCondition::Neumann,
            periodicity: None,
            resolved_periodic_images: None,
            integrator: fullmag_ir::IntegratorChoice::Heun,
            fixed_timestep: Some(1.0e-13),
            field_refresh: None,
            relaxation: None,
            planner_summary: fullmag_ir::FdmMultilayerSummaryIR {
                requested_strategy: "multilayer_convolution".to_string(),
                selected_strategy: "multilayer_convolution".to_string(),
                requested_mode: "two_d_stack".to_string(),
                resolved_mode: "two_d_stack".to_string(),
                eligibility: "test".to_string(),
                estimated_pair_kernels: 1,
                estimated_unique_kernels: 1,
                estimated_kernel_bytes: 0,
                warnings: Vec::new(),
            },
        }
    }

    fn active_global_module() -> ResolvedPhysicsModule {
        ResolvedPhysicsModule {
            module_id: "current:global".to_string(),
            kind: "current_transport".to_string(),
            depends_on: Vec::new(),
            requested_lane: "fdm".to_string(),
            resolved_lane: "fdm".to_string(),
            status: "active".to_string(),
            scope_key: "global".to_string(),
            fem_marker_ids: Vec::new(),
            fdm_cell_mask_id: Some("physics-mask.v1:current:global:global".to_string()),
            reason: None,
            source_path: "/current_modules/0".to_string(),
        }
    }

    #[test]
    fn multilayer_graph_realization_requires_a_common_identity_mask() {
        let module = active_global_module();
        let no_execution = BTreeSet::new();
        let shifted = multilayer_plan(vec![
            layer("identity", [0.0, 0.0, 0.0], Some(vec![true, false])),
            layer("identity", [0.0, 0.0, 1.0], Some(vec![true, true])),
        ]);
        let shifted_realization =
            realize_fdm_multilayer_modules(&shifted, std::slice::from_ref(&module), &no_execution)
                .expect("shifted multilayer realization");
        assert_eq!(
            shifted_realization[0].state,
            PhysicsGraphRealizationStateIR::SemanticOnly
        );
        assert!(shifted_realization[0]
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("common-grid cell mask")));

        let aligned = multilayer_plan(vec![
            layer("identity", [0.0, 0.0, 0.0], Some(vec![true, false])),
            layer("identity", [0.0, 0.0, 0.0], Some(vec![false, true])),
        ]);
        let aligned_realization =
            realize_fdm_multilayer_modules(&aligned, std::slice::from_ref(&module), &no_execution)
                .expect("aligned multilayer realization");
        assert_eq!(
            aligned_realization[0].state,
            PhysicsGraphRealizationStateIR::Resolved
        );
        assert_eq!(aligned_realization[0].realized_cell_count, 2);
        assert!(aligned_realization[0]
            .realized_fdm_mask_digest
            .as_deref()
            .is_some_and(|digest| digest.starts_with("sha256:")));
    }
}
