//! Immutable profiling admission and child environment shared by lightweight
//! supervisors and API workers. No API/worker receipt or runtime dispatch owner.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

pub(crate) const PARAMETER: &str = "solver_profile";
pub(crate) const SCHEMA: &str = "accepted_solver_profile.v1";

#[path = "accepted_cuda_trace_admission.rs"]
pub(crate) mod cuda_trace;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    schema_version: String,
    config: fullmag_runner::SolverProfileConfig,
}

pub(crate) fn config(
    parameters: &serde_json::Value,
) -> Result<Option<fullmag_runner::SolverProfileConfig>> {
    let Some(value) = parameters.get(PARAMETER) else {
        return Ok(None);
    };
    let object = value
        .get("config")
        .and_then(serde_json::Value::as_object)
        .context("accepted solver profile requires a config object")?;
    const KEYS: &[&str] = &[
        "enabled",
        "sample_every",
        "sample_interval_wall_ms",
        "max_samples",
        "emit_engine_log",
        "persist_artifact",
    ];
    if object.keys().any(|key| !KEYS.contains(&key.as_str())) {
        bail!("accepted solver profile contains an unknown config key");
    }
    let request: Request = serde_json::from_value(value.clone())?;
    if request.schema_version != SCHEMA {
        bail!("unsupported accepted solver profile schema");
    }
    let config = request.config.normalized();
    if config.enabled && config.emit_engine_log {
        bail!("accepted solver profiling does not yet support emit_engine_log=true");
    }
    if config.enabled && !config.persist_artifact {
        bail!("accepted solver profiling requires explicit persist_artifact=true");
    }
    Ok(config.enabled.then_some(config))
}

pub(crate) fn parameter(
    configuration: fullmag_runner::SolverProfileConfig,
) -> Result<serde_json::Value> {
    let value = serde_json::to_value(Request {
        schema_version: SCHEMA.into(),
        config: configuration,
    })?;
    let mut parameters = serde_json::Map::new();
    parameters.insert(PARAMETER.into(), value.clone());
    config(&serde_json::Value::Object(parameters))?;
    Ok(value)
}

/// Validate before RunIntent acceptance, for live and headless admission alike.
pub(crate) fn validate_study_profile(
    parameters: &serde_json::Value,
    study: &fullmag_authoring::StudyPlan,
    catalog: &fullmag_plan::StudyProblemCatalog,
) -> Result<Option<fullmag_runner::SolverProfileConfig>> {
    let trace = cuda_trace::config(parameters)?;
    if parameters.get(PARAMETER).is_none() && trace.is_none() {
        return Ok(None);
    }
    let configuration = config(parameters)?;
    use fullmag_authoring::{StudyPrimitiveStageKind, StudyStepKind};
    // This is authoring/preparation admission. The canonical planner requires
    // a materialized MeshIR, which the existing preparation path supplies
    // later. Validate the exact catalog now without fabricating a mesh/plan.
    catalog.validate_for(study)?;
    let mut count = 0;
    let mut operation_only = None;
    for step in study.steps.iter().filter(|step| step.enabled) {
        count += 1;
        let operation = matches!(&step.kind, StudyStepKind::ClosedLoopInspection { .. });
        if operation_only.is_some_and(|previous| previous != operation) {
            bail!("solver_profile cannot mix operation inspection with FEM step profiling");
        }
        operation_only = Some(operation);
        match &step.kind {
            StudyStepKind::ClosedLoopInspection { .. } if trace.is_none() => {}
            StudyStepKind::Primitive { stage_kind: StudyPrimitiveStageKind::Run | StudyPrimitiveStageKind::Relax } => {
                let problem = catalog.entries().iter().find(|entry| entry.step_id() == step.step_id)
                    .context("profiled FEM step has no exact catalog entry")?.problem();
                validate_fem_profile_problem(problem)?;
                if trace.is_some() { cuda_trace::validate_problem(problem)?; }
            }
            _ => bail!("solver_profile supports only closed-loop inspection and strict native FEM Run/Relax"),
        }
    }
    if count == 0 {
        bail!("solver_profile requires an enabled supported study step");
    }

    Ok(configuration)
}

fn validate_fem_profile_problem(problem: &fullmag_ir::ProblemIR) -> Result<()> {
    use fullmag_ir::{BackendTarget, ExecutionMode, ExecutionPrecision, StudyIR};
    if problem.backend_policy.requested_backend != BackendTarget::Fem
        || problem.backend_policy.execution_precision != ExecutionPrecision::Double
        || problem.validation_profile.execution_mode != ExecutionMode::Strict
        || !matches!(
            &problem.study,
            StudyIR::TimeEvolution { .. } | StudyIR::Relaxation { .. }
        )
    {
        bail!("solver_profile Run/Relax requires the strict double native FEM lane");
    }
    let hints = problem
        .backend_policy
        .discretization_hints
        .as_ref()
        .and_then(|hints| hints.fem.as_ref())
        .context("profiled FEM requires its authored discretization hints")?;
    // This is the magnetization space order, not the demag-potential order.
    if hints.order != 1 {
        bail!("profiled FEM requires H1/P1 magnetization");
    }
    Ok(())
}

pub(crate) fn validate_fem_profile_plan(
    problem: &fullmag_ir::ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
) -> Result<()> {
    use fullmag_ir::{BackendPlanIR, BackendTarget, ExecutionMode};
    validate_fem_profile_problem(problem)?;
    if plan.common.requested_backend != BackendTarget::Fem
        || plan.common.resolved_backend != BackendTarget::Fem
        || plan.common.execution_mode != ExecutionMode::Strict
        || !matches!(&plan.backend_plan, BackendPlanIR::Fem(fem) if fem.fe_order == 1)
    {
        bail!("profiled FEM execution requires the exact resolved native H1/P1 plan");
    }
    Ok(())
}

/// Execution/readback admission consumes an already canonically lowered,
/// accepted snapshot. Missing preparation never grants an execution plan.
pub(crate) fn validate_resolved_study_profile(
    parameters: &serde_json::Value,
    study: &fullmag_authoring::StudyPlan,
    catalog: &fullmag_plan::StudyProblemCatalog,
    lowered: &fullmag_plan::StudyExecutionPlan,
) -> Result<Option<fullmag_runner::SolverProfileConfig>> {
    let trace = cuda_trace::config(parameters)?;
    if parameters.get(PARAMETER).is_none() && trace.is_none() {
        return Ok(None);
    }
    let config = config(parameters)?;
    // load_accepted_study_snapshot owns canonical CAS/catalog validation and
    // lowering. Do not repeat its mesh validation, clone MeshIR, or replan on
    // every diagnostics read. This guard checks the linked immutable tuple.
    lowered.validate()?;
    let study_digest = study.canonical_sha256()?;
    if lowered.study_id != study.study_id
        || lowered.study_revision != study.revision
        || lowered.study_plan_sha256 != study_digest
        || catalog.study_id != study.study_id
        || catalog.study_revision != study.revision
        || catalog.study_plan_sha256 != study_digest
    {
        bail!("profiled resolved plan differs from the exact authored Study");
    }
    let mut count = 0;
    let mut operation_only = None;
    for step in study.steps.iter().filter(|step| step.enabled) {
        count += 1;
        let operation = matches!(
            &step.kind,
            fullmag_authoring::StudyStepKind::ClosedLoopInspection { .. }
        );
        if operation_only.is_some_and(|previous| previous != operation) {
            bail!("solver_profile cannot mix operation inspection with FEM step profiling");
        }
        operation_only = Some(operation);
        let resolved = lowered
            .steps
            .iter()
            .find(|entry| entry.step_id == step.step_id)
            .context("profiled step has no resolved execution entry")?;
        if !resolved.enabled
            || resolved.kind != step.kind
            || resolved.model != step.model
            || resolved.solver_config != step.solver_config
            || resolved.discretization != step.discretization
            || resolved.execution_profile != step.execution_profile
        {
            bail!("profiled resolved step differs from its authored catalog references");
        }
        let plan = resolved
            .execution_plan
            .as_ref()
            .context("profiled step has no resolved native plan")?;
        let problem = catalog
            .entries()
            .iter()
            .find(|entry| entry.step_id() == step.step_id)
            .context("profiled resolved step has no canonical catalog entry")?
            .problem();
        match &step.kind {
            fullmag_authoring::StudyStepKind::ClosedLoopInspection {
                stage_id,
                port_mode_id,
                ..
            } if trace.is_none() => {
                if !matches!(&plan.backend_plan, fullmag_ir::BackendPlanIR::AntennaFieldOnly(carrier)
                    if &carrier.stage_id == stage_id && &carrier.port_mode_id == port_mode_id)
                {
                    bail!("profiled operation has no exact resolved field-only carrier");
                }
            }
            fullmag_authoring::StudyStepKind::Primitive {
                stage_kind: fullmag_authoring::StudyPrimitiveStageKind::Run | fullmag_authoring::StudyPrimitiveStageKind::Relax,
            } => {
                validate_fem_profile_plan(problem, plan)?;
                if trace.is_some() { cuda_trace::validate_plan(problem, plan)?; }
            }
            _ => bail!("solver_profile supports only closed-loop inspection and strict native FEM Run/Relax"),
        }
    }
    if count == 0 {
        bail!("solver_profile requires an enabled supported study step");
    }
    Ok(config)
}

pub(crate) fn request_digest(value: &serde_json::Value) -> Result<String> {
    config(&serde_json::json!({"solver_profile": value}))?;
    Ok(fullmag_session::canonical_json_sha256(value))
}

/// Resolve native instrumentation only from the immutable accepted run. The
/// child command explicitly removes an inherited timer flag when this is off.
pub(crate) fn fem_child_enabled(
    store: &fullmag_session::SessionStore,
    run_id: &str,
    task_id: &str,
) -> Result<bool> {
    let intent = store
        .read_run_intent(run_id)?
        .context("profile child has no accepted RunIntent")?;
    let specification: fullmag_application::RunSpecification =
        serde_json::from_value(intent.specification)?;
    if specification.parameters.get(PARAMETER).is_none() {
        return Ok(false);
    }
    let accepted = fullmag_runtime_control::load_accepted_study_snapshot(
        store,
        &specification.run_id,
        &specification.snapshot.project_id,
    )?;
    let enabled = validate_resolved_study_profile(
        &specification.parameters,
        &accepted.study,
        &accepted.catalog,
        &accepted.lowered,
    )?
    .is_some();
    for step in &accepted.lowered.steps {
        if fullmag_session::task_id_for_study_step(run_id, &step.step_id)? == task_id {
            return Ok(enabled
                && matches!(
                    step.execution_plan.as_ref().map(|plan| &plan.backend_plan),
                    Some(fullmag_ir::BackendPlanIR::Fem(_))
                ));
        }
    }
    bail!("profile child task has no exact accepted step")
}

pub(crate) fn configure_child(command: &mut std::process::Command, enabled: bool) {
    if enabled {
        command.env("FULLMAG_FEM_STEP_PROFILE", "1");
    } else {
        command.env_remove("FULLMAG_FEM_STEP_PROFILE");
    }
}
