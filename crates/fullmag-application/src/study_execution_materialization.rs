//! Materialize all enabled Study steps through one immutable profile provider.

use std::collections::BTreeMap;

use fullmag_authoring::{StudyExecutionProfileReference, StudyPlan};
use fullmag_ir::{
    ExecutionProfileIR, ExecutionRequestLayerIR, MaterializedExecutionRequestIR, ProblemIR,
};
use fullmag_plan::{
    capture_study_input_references, CapturedStudyInputReferences, StudyProblemCatalog,
    StudyProblemCatalogEntry,
};

/// Authored inputs and explicit layers, before profile preferences are bound.
/// No layer is inferred from host environment or an existing runtime.
pub struct StudyStepExecutionInput {
    pub step_id: String,
    pub problem: ProblemIR,
    pub layers: Vec<ExecutionRequestLayerIR>,
}

/// One bound immutable input and its content-owned references. A compiler must
/// still supply typed step/action/state semantics before creating a StudyPlan.
pub struct CapturedStudyExecutionInput {
    pub problem: ProblemIR,
    pub execution: MaterializedExecutionRequestIR,
    pub references: CapturedStudyInputReferences,
}

/// Bind a published profile once, then identify the complete resulting input.
/// No model/preset/recipe is looked up from mutable current state. The caller
/// owns the stable source ID and preserves authored layers in its layer list.
pub fn materialize_captured_study_input(
    source_id: &str,
    problem: ProblemIR,
    profile: &StudyExecutionProfileReference,
    layers: Vec<ExecutionRequestLayerIR>,
    lookup: impl FnMut(&str, &str) -> Result<ExecutionProfileIR, String>,
) -> Result<CapturedStudyExecutionInput, String> {
    let (problem, execution) = materialize_input(problem, profile, layers, lookup)?;
    let references =
        capture_study_input_references(source_id, &problem).map_err(|error| error.to_string())?;
    Ok(CapturedStudyExecutionInput {
        problem,
        execution,
        references,
    })
}

pub fn materialize_study_execution(
    study: &StudyPlan,
    inputs: Vec<StudyStepExecutionInput>,
    mut lookup: impl FnMut(&str, &str) -> Result<ExecutionProfileIR, String>,
) -> Result<StudyProblemCatalog, String> {
    study
        .validate_for_execution()
        .map_err(|error| error.to_string())?;
    let enabled: BTreeMap<_, _> = study
        .steps
        .iter()
        .filter(|step| step.enabled)
        .map(|step| (step.step_id.as_str(), step))
        .collect();
    let mut authored = BTreeMap::new();
    for input in inputs {
        if !enabled.contains_key(input.step_id.as_str()) {
            return Err(format!(
                "study execution input `{}` is unknown or disabled",
                input.step_id
            ));
        }
        let step_id = input.step_id.clone();
        if authored.insert(step_id.clone(), input).is_some() {
            return Err(format!("duplicate study execution input `{step_id}`"));
        }
    }
    for step in enabled.values() {
        if !authored.contains_key(&step.step_id) {
            return Err(format!("missing study execution input `{}`", step.step_id));
        }
    }
    let mut profiles: BTreeMap<(String, String), ExecutionProfileIR> = BTreeMap::new();
    let mut entries = Vec::with_capacity(authored.len());
    // Stable Study order, independent of transport/input map ordering.
    for step in study.steps.iter().filter(|step| step.enabled) {
        let input = authored
            .remove(&step.step_id)
            .expect("enabled input checked above");
        let reference = &step.execution_profile;
        let key = (reference.profile_id.clone(), reference.version.clone());
        let (bound, snapshot) =
            materialize_input(input.problem, reference, input.layers, |id, version| {
                if let Some(profile) = profiles.get(&key) {
                    return Ok(profile.clone());
                }
                let profile = lookup(id, version)?;
                profiles.insert(key.clone(), profile.clone());
                Ok(profile)
            })
            .map_err(|error| format!("study step `{}`: {error}", step.step_id))?;
        entries.push(StudyProblemCatalogEntry::from_materialized_step(
            step, bound, snapshot,
        ));
    }
    StudyProblemCatalog::from_entries(study, entries).map_err(|error| error.to_string())
}

fn materialize_input(
    problem: ProblemIR,
    reference: &StudyExecutionProfileReference,
    layers: Vec<ExecutionRequestLayerIR>,
    lookup: impl FnMut(&str, &str) -> Result<ExecutionProfileIR, String>,
) -> Result<(ProblemIR, MaterializedExecutionRequestIR), String> {
    problem.validate().map_err(|errors| errors.join("; "))?;
    let snapshot = crate::materialize_referenced_execution(
        &reference.profile_id,
        &reference.version,
        layers,
        lookup,
    )?;
    validate_carried_execution(&problem, &snapshot)?;
    let bound = crate::bind_materialized_execution(&problem, &snapshot)?;
    Ok((bound, snapshot))
}

/// Portable script/scene declarations must not disappear when a caller supplies
/// a StudyPlan and a separate layer list. New layers may extend that intent,
/// but replacing it requires a new authored input rather than a hidden rebind.
fn validate_carried_execution(
    problem: &ProblemIR,
    requested: &fullmag_ir::MaterializedExecutionRequestIR,
) -> Result<(), String> {
    let metadata = &problem.problem_meta.runtime_metadata;
    let carried = if let Some(value) = metadata.get("execution_profile") {
        if metadata.contains_key("execution_materialization") {
            return Err(
                "execution_intent_conflict: ambiguous authored execution declaration".into(),
            );
        }
        let profile: ExecutionProfileIR = serde_json::from_value(value.clone())
            .map_err(|error| format!("invalid authored execution profile: {error}"))?;
        profile.validate()?;
        let layers: Vec<ExecutionRequestLayerIR> = metadata
            .get("execution_layers")
            .map(|value| serde_json::from_value(value.clone()))
            .transpose()
            .map_err(|error| format!("invalid authored execution layers: {error}"))?
            .unwrap_or_default();
        Some((Some(profile), layers))
    } else if let Some(value) = metadata.get("execution_materialization") {
        let snapshot: fullmag_ir::MaterializedExecutionRequestIR =
            serde_json::from_value(value.clone())
                .map_err(|error| format!("invalid carried execution materialization: {error}"))?;
        crate::validate_execution_materialization(&snapshot)?;
        Some((snapshot.profile, snapshot.layers))
    } else {
        if metadata.contains_key("execution_layers") {
            return Err("execution layers require an authored profile".into());
        }
        None
    };
    if let Some((profile, layers)) = carried {
        if profile != requested.profile || !requested.layers.starts_with(&layers) {
            return Err("execution_intent_conflict: Study input must preserve its authored profile and layers before adding explicit overrides".into());
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "study_execution_materialization_tests.rs"]
mod tests;
